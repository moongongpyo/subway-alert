import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { Evaluations } from '../src/evaluations.js';
import { records, putEvaluation } from '../src/evaluation-data.js';
import { createApp } from '../src/server.js';

function fixture(t,{invoke=async()=>({status:200,data:{text:'hello',zero:0,flag:false}}),ask,request}={}){
  const dir=mkdtempSync(join(tmpdir(),'pg-extension-')),s=new Store(dir);let invokes=0,models=0;
  const model={ask:async(id,role,task,ctx,schema)=>{models++;s.count(id,'tools');const r=s.reserve(id,role,'gpt-5.6-luna',100,200);s.settle(r.id,{input_tokens:100,output_tokens:100});return schema.parse(ask?await ask({id,role,task,ctx}):{summary:'관련 조건 확인',questions:[],assessments:[],cards:[{kind:'coverage',title:'대문자 확인',reason:'대소문자 처리가 미확인입니다.',check:'대문자 입력 처리',changes:[{field:'text',valueJson:'"HELLO"',evidence:'Text to transform'}],requiresInput:[]}]});}};
  const sb={invoke:async(...args)=>{invokes++;return invoke(...args);},cleanup:async id=>s.update(id,j=>{j.cleanedAt=Date.now();j.cleanupPending=false;})};
  const o={dir,start:()=>{},cancel:async id=>s.update(id,j=>{j.state='CANCELLED';j.cleanupPending=false;})};
  const e=new Evaluations(s,model,sb,o,{request,autoExperience:false});const j=s.create('local','https://example.com/docs','fixture-job');
  s.update(j.id,j=>{j.state='READY';j.activeSince=null;j.version='v1';j.verifiedVersion='v1';j.expiresAt=Date.now()+3600_000;j.source={text:'Text to transform',commit:null};j.plan={title:'Case tool',capability:'Transform text',kind:'api',runtime:'none',hasUI:false,fields:[{name:'text',label:'입력 문장',type:'text',required:true,location:'query',example:'hello',description:'Text to transform'}],endpoint:{method:'GET',url:'https://example.com/api'},auth:{kind:'none',name:'',instructions:'',issueUrl:''},database:{kind:'none'},install:['invented-do-not-copy']};j.evidence=[{role:'B',version:'v1',description:'shape verified'},{role:'E',version:'v1',description:'browser verified'}];j.sample={text:'hello'};});
  t.after(async()=>{for(const v of e.running.values())if(v?.abort)v.abort();await Promise.allSettled([...e.running.values()].map(v=>v?.promise).filter(Boolean));s.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+ '\\')||resolve(dir).startsWith(resolve(tmpdir())+'/'));rmSync(dir,{recursive:true,force:true});});
  return {s,e,j:s.get(j.id),eid:j.evaluationId,model,sb,o,counts:()=>({invokes,models})};
}
const goal=(e,eid,version=0)=>e.goal(eid,'local',{purpose:'문자열과 0 값을 보존하는지 확인',version,conditions:[{label:'0 유지',kind:'equals',pointer:'/zero',expectedJson:'0',required:true},{label:'읽기 쉬움',kind:'subjective',required:true}]});
const draft=f=>f.e.draft(f.eid,'local',{jobId:f.j.id,input:{text:'hello'}});
const finish=async(e,task)=>{await e.running.get(task.id)?.promise;};

test('actual run snapshots survive later edits; duplicates never invoke twice and no model runs',async t=>{
  const f=fixture(t);goal(f.e,f.eid);const ex=draft(f),run=await f.e.run(f.eid,'local',ex.id,'execute-key');const again=await f.e.run(f.eid,'local',ex.id,'execute-key');
  assert.equal(again.id,run.id);assert.equal(f.counts().invokes,1);assert.equal(f.counts().models,0);assert.equal(run.output.zero,0);assert.equal(run.output.flag,false);
  const input={text:'different'};f.e.draft(f.eid,'local',{jobId:f.j.id,input});input.text='mutated';assert.equal(f.e.record(f.eid,run.id,'run').input.text,'hello');
  assert.throws(()=>f.e.draft(f.eid,'other',{jobId:f.j.id,input}),{code:'NOT_FOUND'});
});

test('legacy invoke retry reuses the original experiment and run',async t=>{
  const f=fixture(t),first=await f.e.invoke(f.eid,'local',f.j.id,{text:'hello'},'legacy-retry-key');
  const next=await f.e.invoke(f.eid,'local',f.j.id,{text:'hello'},'legacy-retry-key');
  assert.equal(next.id,first.id);assert.equal(f.counts().invokes,1);assert.equal(records(f.s.db,f.eid,'experiment').length,1);
  await assert.rejects(f.e.invoke(f.eid,'local',f.j.id,{text:'changed'},'legacy-retry-key'),{code:'CONFLICT'});
});

test('pending duplicate runs do not repeat external requests and unknown requests do not replay',async t=>{
  let release;const f=fixture(t,{invoke:()=>new Promise(resolve=>release=resolve)}),ex=draft(f);
  const first=f.e.run(f.eid,'local',ex.id,'pending-run-key');
  const duplicate=await f.e.run(f.eid,'local',ex.id,'pending-run-key');assert.equal(duplicate.state,'running');assert.equal(f.counts().invokes,1);
  release({status:200,data:{text:'finished'}});const completed=await first;assert.equal(completed.id,duplicate.id);assert.equal(completed.state,'succeeded');
});

test('analysis uses edited inputs, and feedback changes allow refreshed cards for the new context',async t=>{
  const f=fixture(t,{ask:({ctx})=>({summary:'입력 보존',questions:[],assessments:[],cards:[{kind:'coverage',title:'현재 조건',reason:'현재 입력을 확인',check:'현재 조건 확인',changes:[],requiresInput:[]}]})});goal(f.e,f.eid);
  const run=await f.e.run(f.eid,'local',draft(f).id,'context-run-key');
  const first=f.e.analyze(f.eid,'local',{jobId:f.j.id,runId:run.id,input:{text:'edited'}});await finish(f.e,first);
  const card=records(f.s.db,f.eid,'suggestion')[0];assert.equal(card.input.text,'edited');
  f.e.feedback(f.eid,'local',run.id,{version:0,satisfaction:'partial',note:'추가 확인',conditions:[]});
  const next=f.e.analyze(f.eid,'local',{jobId:f.j.id,runId:run.id,input:{text:'edited'}});await finish(f.e,next);
  assert.equal(records(f.s.db,f.eid,'suggestion').length,2);assert.equal(f.counts().invokes,1);
});
test('execution success and subjective purpose fulfillment stay separate; old goal drafts are stale',async t=>{
  const f=fixture(t),g=goal(f.e,f.eid),ex=draft(f),r=await f.e.run(f.eid,'local',ex.id,'execution-1');
  let snap=f.e.snapshot(f.eid,'local');assert.equal(snap.runs[0].state,'succeeded');assert.equal(snap.runs[0].assessment.status,'unknown');
  f.e.feedback(f.eid,'local',r.id,{satisfaction:'unsatisfied',note:'읽기 어려움',version:0,conditions:[{id:g.conditions[1].id,status:'unmet',note:'표가 아님'}]});
  snap=f.e.snapshot(f.eid,'local');assert.equal(snap.runs[0].assessment.status,'partial');assert.equal(snap.runs[0].assessment.conditions[0].status,'met');
  goal(f.e,f.eid,1);await assert.rejects(f.e.run(f.eid,'local',ex.id,'execution-2'),{code:'STALE_SUGGESTION'});assert.equal(snap.runs[0].goalVersion,1);
});
test('file bytes are encrypted, scoped, expire independently, and never go to analysis context',async t=>{
  const f=fixture(t);const file=f.e.files.save(f.eid,{name:'sample.txt',base64:Buffer.from('private-document-content').toString('base64')});
  const row=f.s.db.prepare('SELECT content FROM evaluation_files WHERE id=?').get(file.artifactId);assert.ok(!Buffer.from(row.content).includes(Buffer.from('private-document-content')));
  assert.equal(f.e.files.hydrate(f.eid,{document:file}).document.base64,Buffer.from('private-document-content').toString('base64'));
  const other=f.s.create('different','https://example.org','other-request');assert.throws(()=>f.e.files.get(other.evaluationId,file.artifactId),{code:'NOT_FOUND'});
  const meta=JSON.parse(f.s.db.prepare('SELECT doc FROM evaluation_files WHERE id=?').get(file.artifactId).doc);meta.expiresAt=Date.now()-1;f.s.db.prepare('UPDATE evaluation_files SET doc=? WHERE id=?').run(JSON.stringify(meta),meta.id);f.e.files.expire();assert.throws(()=>f.e.files.get(f.eid,meta.id),{code:'FILE_EXPIRED'});assert.equal(f.s.db.prepare('SELECT content FROM evaluation_files WHERE id=?').get(meta.id).content,null);
});

test('file output assertions are preserved after bytes are extracted and later expire',async t=>{
  const base64=Buffer.from('verified result').toString('base64'),f=fixture(t,{invoke:async()=>({status:200,data:{file:{name:'result.txt',mime:'text/plain',base64}}})});
  f.e.goal(f.eid,'local',{purpose:'파일 결과 확인',version:0,conditions:[{label:'파일 내용 존재',kind:'exists',pointer:'/file/base64'}]});
  const run=await f.e.run(f.eid,'local',draft(f).id,'file-output-run');assert.ok(run.output.file.artifactId);assert.equal(run.output.file.base64,undefined);
  assert.equal(f.e.snapshot(f.eid,'local').runs[0].assessment.status,'met');
  f.s.db.prepare('UPDATE evaluation_files SET content=NULL').run();assert.equal(f.e.snapshot(f.eid,'local').runs[0].assessment.status,'met');
  const context=f.e.context(f.eid,f.e.basedOn(f.eid,f.j.id,run.id));assert.ok(!JSON.stringify(context).includes(base64));
});
test('analysis cards use existing documented fields; choosing prepares input without execution',async t=>{
  const f=fixture(t);goal(f.e,f.eid);const task=f.e.analyze(f.eid,'local',{jobId:f.j.id});await finish(f.e,task);
  const card=records(f.s.db,f.eid,'suggestion')[0];assert.equal(card.changes[0].after,'HELLO');const ex=f.e.draft(f.eid,'local',{jobId:f.j.id,suggestionId:card.id});assert.equal(ex.input.text,'HELLO');assert.equal(f.counts().invokes,0);
  const duplicate=f.e.analyze(f.eid,'local',{jobId:f.j.id});assert.equal(duplicate.id,task.id);assert.equal(f.counts().models,1);
  goal(f.e,f.eid,1);assert.throws(()=>f.e.draft(f.eid,'local',{jobId:f.j.id,suggestionId:card.id}),{code:'STALE_SUGGESTION'});
});
test('invalid proposed controls are discarded without executing generated code',async t=>{
  const f=fixture(t,{ask:()=>({summary:'제안',questions:[],assessments:[],cards:[{kind:'improve',title:'fake option',reason:'test',check:'test',changes:[{field:'shell',valueJson:'"rm -rf /"',evidence:'invented'}],requiresInput:[]}]})});const task=f.e.analyze(f.eid,'local',{jobId:f.j.id});await finish(f.e,task);assert.equal(records(f.s.db,f.eid,'suggestion').length,0);assert.equal(f.counts().invokes,0);
});
test('model budgets aggregate preparation and extra analysis atomically',t=>{
  const f=fixture(t),e=f.e.get(f.eid);e.policy.micros=200;putEvaluation(f.s.db,e);
  f.s.update(f.j.id,j=>{j.state='ANALYZING';j.activeSince=Date.now();});const reservation=f.s.reserve(f.j.id,'A','gpt-5.6-luna',100,100);f.s.settle(reservation.id,{input_tokens:100,output_tokens:100});f.s.update(f.j.id,j=>j.state='READY');
  const task=f.s.create('local',f.j.url,'budget-analysis',{}, {evaluationId:f.eid,taskType:'analysis'});assert.throws(()=>f.s.reserve(task.id,'G','gpt-5.6-luna',100,100),{code:'BUDGET_EXCEEDED'});
});
test('recommendations require exact source evidence and transitions start an isolated job without invoking user input',async t=>{
  const source='This tool preserves merged cells in table extraction.';
  const f=fixture(t,{request:async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from('<html><body>'+source+'</body></html>')}),ask:()=>({summary:'문서 확인',candidates:[{sourceId:'source-1',reason:'병합 셀 확인에 관련됨',limitation:'기존 결과 일부 누락',quote:source,unknowns:'사용자의 파일에서 실제 결과 미확인'}]})});goal(f.e,f.eid);
  const task=f.e.analyze(f.eid,'local',{jobId:f.j.id,mode:'alternatives',url:'https://example.org/docs'});await finish(f.e,task);const card=records(f.s.db,f.eid,'suggestion')[0];assert.equal(card.source.quote,source);
  const next=f.e.transition(f.eid,'local',{suggestionId:card.id},'transition-key',{});assert.notEqual(next.id,f.j.id);assert.equal(next.evaluationId,f.eid);assert.equal(next.state,'ANALYZING');assert.equal(f.s.secret(next.id),null);assert.equal(f.counts().invokes,0);assert.equal(f.e.transition(f.eid,'local',{suggestionId:card.id},'transition-key',{}).id,next.id);
});
test('single-run report freezes results, never invents scores or costs and excludes secrets',async t=>{
  const f=fixture(t);goal(f.e,f.eid);f.s.secret(f.j.id,'sensitive-key-value');const run=await f.e.run(f.eid,'local',draft(f).id,'report-run');
  const r=f.e.report(f.eid,'local',{format:'md',runIds:[run.id]});assert.equal(r.state,'COMPLETED');assert.match(r.markdown,/미확인/);assert.match(r.markdown,/단건 실행 리포트/);assert.ok(!r.markdown.includes("최종 선택"));assert.ok(!r.markdown.includes('sensitive-key-value'));assert.ok(!r.markdown.includes('invented-do-not-copy'));assert.equal(f.counts().models,0);
  f.e.feedback(f.eid,'local',run.id,{version:0,satisfaction:'satisfied',note:'NEW-FEEDBACK',conditions:[]});assert.ok(!f.e.record(f.eid,r.id,'report').markdown.includes('NEW-FEEDBACK'));assert.throws(()=>f.e.report(f.eid,'local',{format:'pdf'}),{code:'UNSUPPORTED_FORMAT'});
});
test('manual original UI results are labelled and never fabricate measured duration',async t=>{
  const f=fixture(t);f.s.update(f.j.id,j=>{j.plan.hasUI=true;j.plan.fields=[];});const ex=f.e.draft(f.eid,'local',{jobId:f.j.id});const run=await f.e.run(f.eid,'local',ex.id,'manual-result',{manualOutput:{value:42},manualConditions:'원래 UI의 seed 데이터 조회',manualState:'succeeded'});assert.equal(run.durationMs,null);assert.equal(run.provenance,'manual');assert.equal(run.cost.externalMicros,null);assert.equal(f.counts().invokes,0);
});
test('new tool execution requires input transfer review and exposes unmatched options',async t=>{
  const f=fixture(t);const run=await f.e.run(f.eid,'local',draft(f).id,'mapping-run');const job=f.e.transition(f.eid,'local',{jobId:f.j.id,runId:run.id,url:'https://example.org/tool'},'mapping-transition',{});
  f.s.update(job.id,j=>{j.plan={...f.j.plan,fields:[{...f.j.plan.fields[0],name:'newText'}]};j.state='READY';j.version='v2';j.verifiedVersion='v2';j.expiresAt=Date.now()+10000;});
  const mapping=f.e.mapping(f.eid,'local',job.id);assert.ok(mapping.rows.some(r=>r.field==='text'&&r.status==='대응하는 옵션 없음'));assert.deepEqual(mapping.input,{});
  const ex=f.e.draft(f.eid,'local',{jobId:job.id,input:{newText:'hello'}});await assert.rejects(f.e.run(f.eid,'local',ex.id,'mapping-execution'),{code:'TRANSFER_REQUIRED'});assert.equal(f.counts().invokes,1);
});
test('known credentials in experiment fields are rejected, never changed silently',t=>{
  const f=fixture(t);f.s.secret(f.j.id,'test-private-secret');assert.throws(()=>f.e.draft(f.eid,'local',{jobId:f.j.id,input:{text:'test-private-secret'}}),{code:'SECRET_INPUT'});assert.equal(records(f.s.db,f.eid,'experiment').length,0);
});
test('restart marks pending executions unknown without replay; deletion removes derivatives but preserves ledger',async t=>{
  const f=fixture(t);const r=await f.e.run(f.eid,'local',draft(f).id,'delete-run');f.e.report(f.eid,'local',{format:'md'});
  f.s.db.prepare('UPDATE evaluation_records SET doc=json_set(doc,\'$.state\',\'running\') WHERE id=?').run(r.id);f.e.recover();assert.equal(f.e.record(f.eid,r.id,'run').state,'unknown');assert.equal(f.counts().invokes,1);
  await f.e.remove(f.eid,'local');assert.equal(records(f.s.db,f.eid).length,0);assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM evaluation_keys').get().n,0);assert.equal(f.s.list('local').length,0);assert.throws(()=>f.e.snapshot(f.eid,'local'),{code:'NOT_FOUND'});
});
test('HTTP extension persists goals, runs and downloadable Markdown with no model request',async t=>{
  const f=fixture(t),{app}=createApp({store:f.s,models:f.model,sandboxes:f.sb,orchestrator:f.o,evaluationOptions:{autoExperience:false}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
  const index=await fetch(base),cookie=index.headers.get('set-cookie').split(';')[0];const request=async(path,body,key)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Playground-Request':'1',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,await r.clone().text());return r;};
  const prefix=`/api/evaluations/${f.eid}`;await request(prefix+'/goals',{purpose:'내용 보존',version:0,conditions:[]});const ex=await(await request(prefix+'/experiments',{jobId:f.j.id,input:{text:'hello'}})).json();const run=await(await request(prefix+`/experiments/${ex.id}/runs`,{},'http-extension-run')).json();assert.equal(run.state,'succeeded');const report=await(await request(prefix+'/reports',{format:'md'})).json();const file=await request(prefix+`/reports/${report.id}/download`);assert.match(file.headers.get('content-type'),/text\/markdown/);assert.match(await file.text(),/단건 실행 리포트/);assert.equal(f.counts().models,0);
});

 test('single-run report defaults to latest completed run and rejects multiple results',async t=>{
 const f=fixture(t);const a=await f.e.run(f.eid,'local',draft(f).id,'single-first');const b=await f.e.run(f.eid,'local',draft(f).id,'single-second');
 const report=f.e.report(f.eid,'local',{format:'md',jobId:f.j.id});assert.deepEqual(report.runIds,[b.id]);assert.ok(!report.markdown.includes(a.id));
 assert.throws(()=>f.e.report(f.eid,'local',{format:'md',runIds:[a.id,b.id]}),{code:'INVALID_INPUT'});
 });
