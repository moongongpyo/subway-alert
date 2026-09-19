import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'cheerio';
import { Store } from '../src/store.js';
import { Evaluations } from '../src/evaluations.js';
import { Models } from '../src/model.js';
import { records,putRecord } from '../src/evaluation-data.js';
import { renderPresentation,presentationSample } from '../src/result-presentation.js';
import { validatePlan } from '../src/contracts.js';
import { buildApiRequest } from '../src/api-request.js';
import { createApp } from '../src/server.js';

const field={name:'q',label:'검색어',type:'text',required:true,location:'query',example:'ocr',description:'Search query'};
const result={view:{"question":"입력한 검색어와 관련된 후보가 반환됐나요?","rationale":"이름과 별 수를 함께 보고 후보의 관련성을 직접 확인합니다.","focus":"candidates","evidence":[{"label":"반환된 후보","source":"current","path":"/items","stat":"count","field":"","unitPath":""}],"blocks":[{"type":"table","title":"후보별 확인","reason":"실제 이름과 별 수를 비교해 관련성을 확인합니다.","source":"current","path":"/items","x":"","columns":[{"path":"/name","label":"이름","unitPath":""},{"path":"/stars","label":"별 수","unitPath":""}],"comparePath":""}],"unknowns":["별 수만으로 검색 목적에 맞는지 확정할 수 없습니다."]},summary:'다음 조건 확인',questions:[],assessments:[],html:'<main><h2>검색 결과</h2><strong data-stat="count" data-source="/items"></strong><article data-each="/items"><h3 data-value="./name"></h3><span data-value="./stars" data-format="number"></span></article></main>',css:'article{padding:16px}',cards:['문서 OCR','표 추출','한글 인식'].map((title,i)=>({title,kind:'coverage',reason:'검색 범위를 비교',check:'관련 저장소가 반환되는지',changes:[{field:'q',valueJson:JSON.stringify(['document ocr','table extraction','korean ocr'][i]),evidence:'Search query'}],requiresInput:[],asset:null}))};
function fixture(t,{ask,generateImage,autoPrefetch=false,invoke}={}){
  const dir=mkdtempSync(join(tmpdir(),'pg-experience-')),s=new Store(dir);let calls=0,invokes=0,images=0;
  const model={ask:async(id,role,task,ctx,schema)=>{calls++;return schema.parse(await (ask?ask(ctx):result));},generateImage:async(...args)=>{images++;return generateImage?generateImage(...args):{name:'generated.jpg',mime:'image/jpeg',base64:Buffer.from([255,216,255,217]).toString('base64')};}};
  const sb={invoke:async(_id,input)=>{invokes++;return invoke?invoke(input):{status:200,data:{items:[{name:input.q,stars:0},{name:'second',stars:42}],flag:false}};}};
  const o={start(){},cancel:async id=>s.update(id,j=>j.state='CANCELLED')};
  const e=new Evaluations(s,model,sb,o,{autoPrefetch}),j=s.create('local','https://example.com/search?q=ocr','experience-fixture');
  s.update(j.id,j=>{j.state='READY';j.activeSince=null;j.version='v1';j.verifiedVersion='v1';j.expiresAt=Date.now()+3600_000;j.source={text:'Search query'};j.sample={q:'ocr'};j.plan={kind:'api',title:'검색',capability:'Search',hasUI:false,runtime:'none',fields:[field],endpoint:{url:j.url,method:'GET'},auth:{kind:'none'},database:{kind:'none'}};});
  t.after(async()=>{for(const c of e.running.values())c?.abort?.();await Promise.allSettled([...e.running.values()].map(c=>c?.promise).filter(Boolean));s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,e,j:s.get(j.id),eid:j.evaluationId,model,sb,o,counts:()=>({calls,invokes,images})};
}
async function finish(f){await Promise.all([...f.e.running.values()].map(c=>c?.promise).filter(Boolean));}
async function run(f){const ex=f.e.draft(f.eid,'local',{jobId:f.j.id,input:{q:'edited'}});return f.e.run(f.eid,'local',ex.id,'actual-request-key');}

test('manual execution uses edited values, then automatically creates one cached result view and three cards',async t=>{
  const f=fixture(t),r=await run(f);await finish(f);
  assert.equal(r.input.q,'edited');assert.equal(f.counts().invokes,1);assert.equal(f.counts().calls,1);
  const analysis=records(f.s.db,f.eid,'analysis')[0];assert.equal(analysis.state,'COMPLETED');assert.equal(analysis.suggestionIds.length,3);assert.match(analysis.presentation,/edited/);
  const cached=f.e.scheduleExperience(f.eid,'local',r.id);assert.equal(cached.id,analysis.id);assert.equal(f.counts().calls,1);
  const selected=f.e.prepareCard(f.eid,'local',analysis.suggestionIds[0]);assert.equal(selected.input.q,'document ocr');assert.equal(f.counts().invokes,1);
  const snap=f.e.snapshot(f.eid,'local');assert.equal(snap.analyses[0].hasPresentation,true);assert.equal(snap.analyses[0].presentation,undefined);
  assert.throws(()=>f.e.scheduleExperience(f.eid,'stranger',r.id),{code:'NOT_FOUND'});
});
test('feedback creates a new bounded context without rerunning the API; an older card becomes stale',async t=>{
  const f=fixture(t),r=await run(f);await finish(f);const old=records(f.s.db,f.eid,'suggestion')[0];
  f.e.feedback(f.eid,'local',r.id,{version:0,satisfaction:'partial',note:'한글 지원 확인',conditions:[]});f.e.scheduleExperience(f.eid,'local',r.id);await finish(f);
  assert.equal(f.counts().calls,2);assert.equal(f.counts().invokes,1);assert.throws(()=>f.e.prepareCard(f.eid,'local',old.id),{code:'STALE_SUGGESTION'});
});
test('choosing an image card generates and stores a real file once, never invokes the target API',async t=>{
  const f=fixture(t);f.s.update(f.j.id,j=>j.plan.fields.push({...field,name:'image',type:'file',location:'body',required:false}));
  const card=putRecord(f.s.db,f.eid,'suggestion',{kind:'coverage',title:'머리카락 경계',input:{q:'ocr'},basedOn:f.e.basedOn(f.eid,f.j.id),asset:{field:'image',prompt:'Synthetic portrait with flyaway hair against a similar background.',description:'머리카락 경계를 시험할 이미지'},changes:[],requiresInput:[]});
  const task=f.e.prepareCard(f.eid,'local',card.id);await finish(f);const completed=f.e.record(f.eid,task.id,'analysis');assert.equal(completed.state,'COMPLETED');assert.ok(completed.input.image.artifactId);
  assert.equal(f.e.files.get(f.eid,completed.input.image.artifactId).mime,'image/jpeg');assert.equal(f.e.prepareCard(f.eid,'local',card.id).id,task.id);assert.deepEqual(f.counts(),{calls:0,invokes:0,images:1});
  const ex=f.e.draft(f.eid,'local',{jobId:f.j.id,suggestionId:card.id,input:completed.input});assert.ok(ex.input.image.artifactId);
});
test('failed automatic analysis preserves the successful response and does not retry on reload',async t=>{
  const f=fixture(t,{ask:()=>{throw new Error('temporary provider failure');}}),r=await run(f);await finish(f);const a=records(f.s.db,f.eid,'analysis')[0];
  assert.equal(a.state,'FAILED');assert.equal(f.e.record(f.eid,r.id,'run').state,'succeeded');assert.equal(f.e.scheduleExperience(f.eid,'local',r.id).id,a.id);assert.equal(f.counts().calls,1);
});
test('a paraphrased evidence quote cannot discard a valid editable-field experiment',async t=>{
  const f=fixture(t,{ask:()=>({...result,cards:result.cards.map(c=>({...c,changes:c.changes.map(d=>({...d,evidence:'The field is documented as a search query.'}))}))})});await run(f);await finish(f);
  assert.equal(records(f.s.db,f.eid,'suggestion').length,3);assert.equal(records(f.s.db,f.eid,'suggestion')[0].changes[0].evidence,'Search query');assert.equal(f.counts().calls,1);
});
test('invalid card fields receive one bounded repair without repeating the target request',async t=>{
  let attempts=0;const f=fixture(t,{ask:()=>attempts++?result:{...result,cards:result.cards.map(c=>({...c,changes:c.changes.map(d=>({...d,field:'invented'}))}))}});await run(f);await finish(f);
  assert.equal(records(f.s.db,f.eid,'suggestion').length,3);assert.equal(f.counts().calls,2);assert.equal(f.counts().invokes,1);
});
test('HTML is sanitized, bindings escape response text, and aggregates use every returned row',()=>{
  const output={items:Array.from({length:10},(_,i)=>({name:i===0?'<img src=x onerror=alert(1)>':String(i),stars:i,link:'javascript:alert(1)'})),flag:false,zero:0};
  const html=renderPresentation({html:'<script>alert(1)</script><iframe src="https://evil.test"></iframe><form><input></form><article data-each="/items"><b onclick="alert(1)" data-value="./name"></b><a data-href="./link">link</a></article><strong data-stat="sum" data-source="/items" data-field="/stars"></strong><i data-value="/zero"></i><em data-value="/flag"></em>',css:'@import "https://evil.test"; body{background:url(https://evil.test/x)}'},output);
  const $=load(html);assert.equal($('article').length,10);assert.equal($('strong').text(),'45');assert.equal($('i').text(),'0');assert.equal($('em').text(),'false');assert.equal($('script,iframe,form,input,img,[onclick],[href]').length,0);assert.equal($('b').first().text(),output.items[0].name);assert.ok(!html.includes('evil.test'));assert.ok(presentationSample({items:output.items}).items.length<output.items.length);
});
test('statistic fields accept both relative paths and plain names without treating missing data as zero',()=>{
  const html=renderPresentation({html:'<b data-stat="sum" data-source="/items" data-field="./stars"></b><i data-stat="mean" data-source="/items" data-field="stars"></i><em data-stat="sum" data-source="/items" data-field="missing"></em>',css:''},{items:[{stars:2},{stars:4}]});const $=load(html);assert.equal($('b').text(),'6');assert.equal($('i').text(),'3');assert.equal($('em').text(),'—');
});
test('observed URL query fields remain editable while the request origin and credential scope stay fixed',()=>{
  const source={kind:'api',direct:true,url:'https://example.com/search?q=ocr&sort=stars&per_page=5'},plan={kind:'api',supported:true,endpoint:{url:source.url,method:'GET',readOnly:true},hasUI:false,runtime:'none',files:[],install:[],start:'',adapter:'',database:{kind:'none'},auth:{kind:'none',name:''},fields:[]};
  validatePlan(plan,source);assert.deepEqual(plan.fields.map(f=>f.name),['q','sort','per_page']);const request=buildApiRequest(plan,{q:'table extraction',sort:'updated',per_page:3});assert.equal(new URL(request.url).searchParams.get('q'),'table extraction');assert.equal(new URL(request.url).origin,'https://example.com');
});
test('generated presentation is served only with script-free isolated iframe policy',async t=>{
  const f=fixture(t),r=await run(f);await finish(f);const a=records(f.s.db,f.eid,'analysis')[0];const {app}=createApp({store:f.s,models:f.model,sandboxes:f.sb,orchestrator:f.o});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/evaluations/'+f.eid+'/analyses/'+a.id+'/presentation');assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/script-src 'none'/);assert.match(response.headers.get('content-security-policy'),/sandbox allow-same-origin/);assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');assert.match(await response.text(),/edited/);
});
test('image generation uses a single metered provider call; uncertain failures retain their reservation',async t=>{
  const f=fixture(t),model=new Models(f.s,'test-key'),task=f.s.create('local',f.j.url,'image-metering', {outputPerCall:2048,outputTotal:2048,calls:1},{evaluationId:f.eid,taskType:'asset'});let requests=0;
  model.client={images:{generate:async(body)=>{requests++;assert.equal(body.n,1);assert.equal(body.quality,'medium');throw new Error('connection lost');}}};
  await assert.rejects(model.generateImage(task.id,'A synthetic flyaway hair test portrait against a busy background.'));assert.equal(requests,1);assert.ok(f.s.usage(task.id).reserved>0);
});
test('a confirmed image permission rejection is actionable and releases the unused cost reservation',async t=>{
  const f=fixture(t),model=new Models(f.s,'test-key'),task=f.s.create('local',f.j.url,'image-denied',{}, {evaluationId:f.eid,taskType:'asset'});
  model.client={images:{generate:async()=>{throw Object.assign(new Error('Missing scopes: api.model.images.request'),{status:401});}}};
  await assert.rejects(model.generateImage(task.id,'Synthetic image for an input experiment, no private information.'),{code:'IMAGE_PERMISSION_REQUIRED'});assert.equal(f.s.usage(task.id).reserved,0);assert.equal(f.s.usage(task.id).micros,0);assert.equal(f.s.usage(task.id).calls,1);
});

test('first cards and follow-up questions are cached before execution while result design runs independently',async t=>{
  let finishDesign;const f=fixture(t,{autoPrefetch:true,ask:ctx=>ctx.pendingResult?{...result,questions:['한글 검색 결과도 관련성이 있나요?']}:new Promise(r=>finishDesign=r)});
  const warm=f.e.prefetch.prepare(f.eid,'local',{jobId:f.j.id,input:{q:'edited'}});await finish(f);
  assert.equal(f.counts().calls,1);assert.equal(f.counts().invokes,0);assert.equal(records(f.s.db,f.eid,'suggestion').length,0);
  assert.equal(f.e.prefetch.prepare(f.eid,'local',{jobId:f.j.id,input:{q:'edited'}}).id,warm.id);
  const r=await run(f),early=records(f.s.db,f.eid,'analysis').find(a=>a.mode==='prefetched');
  assert.equal(r.prefetchTaskId,warm.id);assert.equal(early.suggestionIds.length,3);assert.equal(early.questions.length,1);
  assert.equal(records(f.s.db,f.eid,'analysis').find(a=>a.mode==='experience').state,'ANALYZING');
  assert.equal(f.e.prepareCard(f.eid,'local',early.suggestionIds[0]).input.q,'document ocr');
  finishDesign(result);await finish(f);
  assert.equal(f.counts().calls,2);assert.equal(f.counts().invokes,1);
  const actual=records(f.s.db,f.eid,'analysis').find(a=>a.mode==='experience');
  assert.equal(actual.suggestionIds.length,3);assert.equal(actual.state,'COMPLETED');assert.equal(records(f.s.db,f.eid,'suggestion').length,3);
});

test('a pending prefetch cannot serialize result generation and is attached when it arrives later',async t=>{
  let complete;const f=fixture(t,{autoPrefetch:true,ask:ctx=>ctx.pendingResult?new Promise(r=>complete=r):result});
  const r=await run(f);assert.equal(f.counts().calls,2,JSON.stringify({run:f.e.record(f.eid,r.id,'run'),analyses:records(f.s.db,f.eid,'analysis')}));assert.equal(f.counts().invokes,1);
  complete(result);await finish(f);await Promise.resolve();
  assert.equal(records(f.s.db,f.eid,'analysis').find(a=>a.mode==='experience').state,'COMPLETED');
  assert.equal(records(f.s.db,f.eid,'analysis').find(a=>a.mode==='prefetched').basedOn.runId,r.id);
});

test('lookahead follows only the selected branch and is reused for its next run',async t=>{
  const f=fixture(t,{autoPrefetch:true});await run(f);await finish(f);await Promise.resolve();
  const card=records(f.s.db,f.eid,'suggestion')[0],input=f.e.prepareCard(f.eid,'local',card.id).input;
  const warm=f.e.prefetch.prepare(f.eid,'local',{jobId:f.j.id,input,parentRunId:card.basedOn.runId});await finish(f);
  assert.equal(f.counts().calls,3);assert.equal(f.counts().invokes,1);
  const ex=f.e.draft(f.eid,'local',{jobId:f.j.id,suggestionId:card.id,input});
  const next=await f.e.run(f.eid,'local',ex.id,'next-selected-run');await finish(f);
  assert.equal(next.prefetchTaskId,warm.id);assert.equal(f.counts().calls,4);assert.equal(f.counts().invokes,2);
  assert.equal(records(f.s.db,f.eid,'analysis').filter(a=>a.mode==='prefetch').length,2);
});

test('changed inputs, feedback and versions cannot reuse stale speculative conditions',async t=>{
  const f=fixture(t,{autoPrefetch:true});
  const first=f.e.prefetch.prepare(f.eid,'local',{jobId:f.j.id,input:{q:'original'}});await finish(f);
  const r=await run(f);await finish(f);await Promise.resolve();assert.notEqual(r.prefetchTaskId,first.id);
  f.e.feedback(f.eid,'local',r.id,{version:0,satisfaction:'partial',note:'검색 범위가 다름',conditions:[]});
  assert.equal(f.e.prefetch.activate(f.eid,r),null);
  assert.throws(()=>f.e.prepareCard(f.eid,'local',records(f.s.db,f.eid,'suggestion')[0].id),{code:'STALE_SUGGESTION'});
  f.s.update(f.j.id,j=>{j.version='v2';});assert.equal(f.e.prefetch.activate(f.eid,r),null);
});

test('failed actual runs never publish success-path prefetched cards',async t=>{
  const f=fixture(t,{autoPrefetch:true,invoke:async()=>({status:500,data:{error:'real failure'}})});
  f.e.prefetch.prepare(f.eid,'local',{jobId:f.j.id,input:{q:'edited'}});await finish(f);
  await run(f);await finish(f);assert.equal(records(f.s.db,f.eid,'analysis').filter(a=>a.mode==='prefetched').length,0);
});

test('prefetch is capped, single-call, owner-scoped, and never retries on refresh or generates assets',async t=>{
  const f=fixture(t,{autoPrefetch:true,ask:()=>{throw new Error('temporary failure');}});
  const body={jobId:f.j.id,input:{q:'first'}},a=f.e.prefetch.prepare(f.eid,'local',body);await finish(f);
  assert.equal(f.e.prefetch.prepare(f.eid,'local',body).id,a.id);
  f.e.prefetch.prepare(f.eid,'local',{...body,input:{q:'second'}});await finish(f);
  assert.equal(f.e.prefetch.prepare(f.eid,'local',{...body,input:{q:'third'}}),null);
  assert.deepEqual(f.counts(),{calls:2,invokes:0,images:0});assert.equal(f.s.get(a.id).policy.calls,1);
  assert.throws(()=>f.e.prefetch.prepare(f.eid,'stranger',body),{code:'NOT_FOUND'});
});

test('feedback arriving during prefetch invalidates the completion without more calls',async t=>{
  const f=fixture(t);const r=await run(f);await finish(f);f.e.autoPrefetch=true;
  let complete;f.e.models.ask=async()=>new Promise(resolve=>complete=resolve);
  const a=f.e.prefetch.prepare(f.eid,'local',{jobId:f.j.id,input:{q:'followup'},parentRunId:r.id});
  f.e.feedback(f.eid,'local',r.id,{version:0,satisfaction:'unsatisfied',note:'다른 조건 필요',conditions:[]});
  complete(result);await finish(f);assert.equal(f.e.record(f.eid,a.id,'analysis').state,'FAILED');
});
