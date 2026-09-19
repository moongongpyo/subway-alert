import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Orchestrator} from '../src/orchestrator.js';
import {AppError} from '../src/config.js';
import {DocumentationAssessment} from '../src/contracts.js';

function setup(t,publicFailure=false){
  const dir=mkdtempSync(join(tmpdir(),'pg-pipeline-')),store=new Store(dir),url='https://api.github.com/repos/daytonaio/daytona';
  const plan={kind:'api',supported:true,reason:'',title:'테스트 계약',description:'계약 검증',capability:'저장소 조회',evidence:'documented',runtime:'none',hasUI:false,port:3001,install:[],start:'',files:[],database:{kind:'none',migrate:[],seed:[],check:''},auth:{kind:'none',name:'',label:'',issueUrl:'',docsUrl:'',instructions:''},fields:[],endpoint:{url,method:'GET',readOnly:true,cost:'free',costEvidence:'test'},adapter:'',healthPath:'/',expected:'이름 반환'};
  const calls=[];const models={ask:async(_id,role)=>{calls.push(role);if(role==='A')return plan;if(role==='D')return {fields:[],description:''};return {paths:['/name'],allowEmpty:false,description:'name 확인'};}};
  const boxes={create:async()=>calls.push('create'),boot:async()=>calls.push('boot'),invoke:async()=>({status:200,data:{name:'daytona'}}),browser:async id=>({passed:true,version:store.get(id).version,image:Buffer.from('test-image')}),verifyPreview:async id=>{calls.push('public');if(publicFailure)throw new AppError('PREVIEW_FAILED','public ingress blocked');return {role:'P',version:store.get(id).version,description:'test public ingress'};},ready:async()=>calls.push('ready'),cleanup:async()=>calls.push('cleanup')};
  const orchestrator=new Orchestrator(store,models,boxes,dir,{collectSource:async()=>({kind:'api',url,text:'documented',direct:true})});
  const j=store.create('local',url,'pipeline-request');
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,j,orchestrator,calls,plan};
}

test('product selection pauses before model and sandbox use, then resumes the chosen observed source',async t=>{
  const f=setup(t),collect=f.orchestrator.collectSource,addresses=[],choice={id:'observed',url:'https://docs.example.com/product',title:'Product',from:f.j.url};
  f.orchestrator.collectSource=async url=>{addresses.push(url);return addresses.length===1?{kind:'api',url,text:'Directory',choices:[choice]}:collect(url);};
  const running=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.store.get(f.j.id).waitKind,'source');assert.deepEqual(f.calls,[]);assert.equal(f.store.get(f.j.id).activeSince,null);
  assert.throws(()=>f.orchestrator.selectSource(f.j.id,'unobserved'),{code:'INVALID_INPUT'});
  f.orchestrator.selectSource(f.j.id,'observed');await running;
  assert.deepEqual(addresses,[f.j.url,choice.url]);assert.equal(f.store.get(f.j.id).state,'READY');assert.equal(f.store.get(f.j.id).counters.sourceSelections,1);assert.equal(f.store.get(f.j.id).selectedSources[0].url,choice.url);
});

test('cancelling a source selection cannot revive the analysis with late input',async t=>{
  const f=setup(t);f.orchestrator.collectSource=async()=>({kind:'api',url:f.j.url,text:'Directory',choices:[{id:'observed',url:'https://docs.example.com/api',title:'API'}]});
  const running=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(resolve=>setImmediate(resolve));
  await f.orchestrator.cancel(f.j.id);await running;
  assert.throws(()=>f.orchestrator.selectSource(f.j.id,'observed'),{code:'INVALID_STATE'});assert.equal(f.store.get(f.j.id).state,'CANCELLED');assert.ok(!f.calls.includes('create'));assert.ok(!f.calls.includes('A'));
});
test('READY requires both browser assertions and external public preview evidence',async t=>{
  const f=setup(t);await f.orchestrator.run(f.j.id,new AbortController().signal);const j=f.store.get(f.j.id);
  assert.equal(j.state,'READY');assert.equal(j.verifiedVersion,j.version);assert.ok(j.evidence.some(e=>e.role==='E'));assert.ok(j.evidence.some(e=>e.role==='P'));assert.ok(f.calls.indexOf('public')<f.calls.indexOf('ready'));
});

test('documentation rejection recovers in the real preparation flow before environment creation',async t=>{
  const f=setup(t),ask=f.orchestrator.models.ask;let assessments=0;
  f.orchestrator.collectSource=async()=>({kind:'api',url:'https://docs.example.com/',text:'API URL '+f.plan.endpoint.url,pages:[],links:[]});
  f.orchestrator.models.ask=async(id,role,task,context,schema,options)=>{
    if(schema===DocumentationAssessment){assert.ok(!f.calls.includes('create'));return {kind:++assessments===1?'insufficient':'api',reason:'method evidence requires review',choiceIds:[]};}
    return ask(id,role,task,context,schema,options);
  };
  await f.orchestrator.run(f.j.id,new AbortController().signal);
  const job=f.store.get(f.j.id);assert.equal(job.state,'READY');assert.equal(assessments,2);assert.equal(job.round,1);assert.equal(job.analysisRecovery[0].status,'recovered');assert.ok(job.failures.some(f=>f.code==='DOCUMENTATION_INCOMPLETE'));assert.equal(f.calls.filter(c=>c==='create').length,1);
});
test('successful internal browser test cannot hide a broken public preview or trigger model repairs',async t=>{
  const f=setup(t,true);await f.orchestrator.run(f.j.id,new AbortController().signal);const j=f.store.get(f.j.id);
  assert.equal(j.state,'FAILED');assert.equal(j.reason,'PREVIEW_FAILED');assert.equal(j.verifiedVersion,undefined);assert.equal(j.round,0);assert.equal(f.calls.filter(c=>c==='A').length,1);assert.ok(!f.calls.includes('ready'));assert.ok(f.calls.includes('cleanup'));
});

test('API network failures stop as connection failures without plan repairs or unsupported claims',async t=>{
  for(const stage of ['create','invoke','browser']){
    const f=setup(t);f.orchestrator.sandboxes[stage]=async()=>{throw new AppError('EXTERNAL_UNREACHABLE','Daytona 외부 API 연결 실패');};
    await f.orchestrator.run(f.j.id,new AbortController().signal);const j=f.store.get(f.j.id);
    assert.equal(j.state,'FAILED');assert.equal(j.reason,'EXTERNAL_UNREACHABLE');assert.equal(j.round,0);assert.equal(f.calls.filter(c=>c==='A').length,1);assert.ok(!f.calls.includes('ready'));assert.ok(f.calls.includes('cleanup'));
    if(stage==='create')assert.ok(!f.calls.includes('D'));
  }
});

test('unknown API pricing pauses for user connection before any sandbox and resumes without extra analysis',async t=>{
  const f=setup(t),url='https://unpriced.example.com/records';f.plan.endpoint.url=url;
  f.orchestrator.collectSource=async()=>({kind:'api',url,text:'GET '+url,direct:true});
  const running=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(r=>setImmediate(r));
  let j=f.store.get(f.j.id);assert.equal(j.state,'WAITING_FOR_USER');assert.equal(j.waitKind,'connection');assert.ok(j.analysis.completedAt);assert.equal(j.steps[0].status,'completed');assert.ok(j.plan);assert.equal(j.activeSince,null);assert.deepEqual(f.calls,['A']);
  assert.throws(()=>f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,callLimit:10}),{code:'ACCESS_CONFIRMATION_REQUIRED'});
  f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,callLimit:10,acknowledged:true});await running;j=f.store.get(j.id);
  assert.equal(j.state,'READY');assert.equal(j.requestMicros,null);assert.equal(j.apiAccess.callLimit,10);assert.equal(j.round,0);assert.equal(f.calls.filter(c=>c==='A').length,1);
});

test('users supply their own price and budget without changing operator settings',async t=>{
  const f=setup(t),url='https://priced.example.com/records';f.plan.endpoint.url=url;
  f.orchestrator.collectSource=async()=>({kind:'api',url,text:'GET '+url,direct:true});
  const running=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(r=>setImmediate(r));const j=f.store.get(f.j.id);
  f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,callLimit:20,mode:'metered',rateUSD:0.02,budgetUSD:0.2,acknowledged:true});await running;
  assert.equal(f.store.get(j.id).state,'READY');assert.equal(f.store.get(j.id).requestMicros,20000);assert.equal(f.store.get(j.id).policy.externalMicros,200000);
});

test('key issuing instructions precede sandbox creation; denied keys re-prompt without model calls or resetting consent',async t=>{
  const f=setup(t),url=f.plan.endpoint.url;f.plan.auth={kind:'header',name:'appKey',label:'App Key',issueUrl:'https://docs.example.com/keys',docsUrl:'https://docs.example.com/guide',instructions:'공식 페이지에서 키를 발급받으세요.'};
  f.orchestrator.collectSource=async()=>({kind:'api',url,text:'GET '+url+' https://docs.example.com/keys https://docs.example.com/guide',direct:true});
  const ask=f.orchestrator.models.ask;f.orchestrator.models.ask=async(id,role,task,ctx)=>{assert.ok(!JSON.stringify(ctx).includes('private-user-fixture'));if(role==='C'){f.calls.push('C');return {...f.plan.auth,instructions:'1. 공식 페이지에서 로그인하세요.\n2. 키를 복사해 붙여넣으세요.'};}return ask(id,role);};
  f.orchestrator.sandboxes.credentials=async()=>{};let invokes=0;f.orchestrator.sandboxes.invoke=async()=>++invokes<=2?{status:401,data:{error:'denied'}}:{status:200,data:{name:'daytona'}};
  const running=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(r=>setImmediate(r));let j=f.store.get(f.j.id);
  assert.equal(j.waitKind,'connection');assert.deepEqual(f.calls,['A','C']);assert.match(j.plan.auth.instructions,/1\./);
  assert.throws(()=>f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,callLimit:10,acknowledged:true}),{code:'INVALID_KEY'});
  f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,value:'private-user-fixture',callLimit:10,acknowledged:true});await new Promise(r=>setImmediate(r));j=f.store.get(j.id);
  assert.equal(j.waitKind,'credentials');assert.equal(f.store.secret(j.id),null);const access=j.apiAccess;
  const sequence=j.waitSequence;f.orchestrator.credentials(j.id,'private-user-fixture-fixed');await new Promise(r=>setImmediate(r));
  assert.equal(f.store.get(j.id).waitKind,'credentials');assert.ok(f.store.get(j.id).waitSequence>sequence);
  f.orchestrator.credentials(j.id,'private-user-fixture-fixed-again');await running;
  assert.equal(f.store.get(j.id).state,'READY');assert.deepEqual(f.store.get(j.id).apiAccess,access);assert.equal(f.calls.filter(c=>c==='C').length,1);assert.equal(f.store.get(j.id).round,0);assert.ok(!JSON.stringify(f.store.get(j.id)).includes('private-user-fixture'));
});

test('changed API destination invalidates prior consent and never forwards the old key',async t=>{
  const f=setup(t),source={kind:'api',url:f.j.url,text:'https://api.example.com https://docs.example.com/keys https://docs.example.com/guide'};
  f.plan.auth={kind:'header',name:'appKey',label:'App Key',issueUrl:'https://docs.example.com/keys',docsUrl:'https://docs.example.com/guide',instructions:'발급 안내'};
  f.store.update(f.j.id,j=>{j.plan=f.plan;});f.orchestrator.models.ask=async()=>f.plan.auth;
  let wait=f.orchestrator.acceptPlan(f.j.id,f.plan,source);await new Promise(r=>setImmediate(r));let j=f.store.get(f.j.id);
  f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,callLimit:10,value:'old-private-key',acknowledged:true});await wait;
  const oldScope=j.apiOffer.scope,next={...f.plan,endpoint:{...f.plan.endpoint,url:'https://api.example.com/other'}};
  wait=f.orchestrator.acceptPlan(j.id,next,source,true);await new Promise(r=>setImmediate(r));j=f.store.get(j.id);
  assert.equal(j.waitKind,'connection');assert.equal(f.store.secret(j.id),null);assert.notEqual(j.apiOffer.scope,oldScope);assert.equal(j.apiAccess,undefined);
  assert.throws(()=>f.orchestrator.connection(j.id,{scope:oldScope,callLimit:10,value:'old-private-key',acknowledged:true}),{code:'STALE_CONNECTION'});
  f.orchestrator.connection(j.id,{scope:j.apiOffer.scope,callLimit:10,value:'new-private-key',acknowledged:true});await wait;assert.equal(f.store.secret(j.id),'new-private-key');
});

test('cancelled connection rejects late consent and does not store a key or create a sandbox',async t=>{
  const f=setup(t);f.plan.endpoint.url='https://unpriced.example.com/records';f.orchestrator.collectSource=async()=>({kind:'api',url:f.plan.endpoint.url,text:'docs',direct:true});
  const running=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(r=>setImmediate(r));const offer=f.store.get(f.j.id).apiOffer;
  await f.orchestrator.cancel(f.j.id);await running;
  assert.throws(()=>f.orchestrator.connection(f.j.id,{scope:offer.scope,callLimit:10,value:'late-key',acknowledged:true}),{code:'INVALID_STATE'});assert.equal(f.store.secret(f.j.id),null);assert.ok(!f.calls.includes('create'));
});

test('HTTP port 8088 with a path key reaches user connection and invokes only after transport confirmation',async t=>{
  const f=setup(t),url='http://openapi.seoul.go.kr:8088/{apiKey}/json/Example/1/5';
  f.plan.endpoint.url=url;f.plan.auth={kind:'path',name:'apiKey',label:'인증키',issueUrl:'https://data.seoul.go.kr/guide',docsUrl:'https://data.seoul.go.kr/guide',instructions:'공식 인증키 안내'};
  f.orchestrator.collectSource=async()=>({kind:'api',url:'https://data.seoul.go.kr/guide',text:url+' https://data.seoul.go.kr/guide',spec:{}});
  const ask=f.orchestrator.models.ask;f.orchestrator.models.ask=async(id,role)=>role==='C'?f.plan.auth:ask(id,role);let invoked=0;
  f.orchestrator.sandboxes.credentials=async()=>{};f.orchestrator.sandboxes.invoke=async id=>{assert.equal(f.store.get(id).apiAccess.allowHttpAuth,true);invoked++;return {status:200,data:{name:'sample'}};};
  const run=f.orchestrator.run(f.j.id,new AbortController().signal);await new Promise(r=>setImmediate(r));const j=f.store.get(f.j.id);
  assert.equal(j.waitKind,'connection');assert.equal(j.apiOffer.origin,'http://openapi.seoul.go.kr:8088');
  const input={value:'private-path-test-key',scope:j.apiOffer.scope,callLimit:20,acknowledged:true};
  assert.throws(()=>f.orchestrator.connection(j.id,input),{code:'HTTP_AUTH_CONFIRMATION_REQUIRED'});assert.equal(invoked,0);assert.equal(f.store.secret(j.id),null);assert.ok(!f.calls.includes('create'));
  f.orchestrator.connection(j.id,{...input,httpAcknowledged:true});await run;
  assert.equal(f.store.get(j.id).state,'READY');assert.equal(invoked,1);assert.ok(!JSON.stringify(f.store.get(j.id)).includes(input.value));
});

test('six feedback repairs can recover on the seventh browser check within shared budgets',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask,feedback=[];let attempts=0;
  f.orchestrator.models.ask=async(id,role,task,context,schema,options)=>{
    const j=f.store.get(id),r=f.store.reserve(id,role,options?.escalate?'gpt-5.6-sol':'gpt-5.6-terra',2000,4000);f.store.settle(r.id,{input_tokens:2000,output_tokens:500});
    if(context.feedback){feedback.push({context,options});return {...context.plan,fields:[{name:'attempt',label:'입력',type:'number',required:false,location:'query',example:String(j.round),description:'changed input'}]};}
    return originalAsk(id,role);
  };
  f.orchestrator.sandboxes.browser=async id=>{f.store.count(id,'browserPasses');f.store.count(id,'browserActions',16);if(++attempts<=6)throw new AppError('BROWSER_FAILED','result missing');return {passed:true,version:f.store.get(id).version,image:Buffer.from('verified')};};
  await f.orchestrator.run(f.j.id,new AbortController().signal);const job=f.store.get(f.j.id);
  assert.equal(job.state,'READY');assert.equal(job.round,6);assert.equal(attempts,7);assert.equal(job.counters.browserPasses,7);assert.equal(feedback.length,6);
  assert.equal(feedback[5].context.feedback.history.length,6);assert.equal(feedback[5].context.feedback.round,6);assert.deepEqual(feedback.map(f=>f.options.escalate),[false,false,false,true,false,false]);assert.equal(f.store.usage(job.id).calls,21);assert.equal(f.store.usage(job.id).roles.D,13);assert.ok(f.store.usage(job.id).micros<job.policy.jobMicros);
});

test('an always-changing failure stops after six repairs and never publishes a preview',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask;let attempts=0;
  f.orchestrator.models.ask=async(id,role,task,context)=>context.feedback?{...context.plan,expected:'revision '+f.store.get(id).round}:originalAsk(id,role);
  f.orchestrator.sandboxes.boot=async()=>{throw new AppError('EXECUTION_FAILED','error '+(++attempts));};
  await f.orchestrator.run(f.j.id,new AbortController().signal);const job=f.store.get(f.j.id);
  assert.equal(job.state,'FAILED');assert.equal(job.round,6);assert.equal(job.reason,'BUDGET_EXCEEDED');assert.equal(attempts,7);assert.ok(!f.calls.includes('ready'));assert.ok(f.calls.includes('cleanup'));
});

test('an unchanged failed repair stops early and failure context hides credentials',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask;let attempts=0,repairContext;
  f.store.secret(f.j.id,'private-test-credential');
  f.orchestrator.models.ask=async(id,role,task,context)=>{if(context.feedback){repairContext=context;return context.plan;}return originalAsk(id,role);};
  f.orchestrator.sandboxes.boot=async()=>{attempts++;f.store.update(f.j.id,j=>{j.journal=[{command:'run private-test-credential',error:'failure private-test-credential',exitCode:1}];});throw new AppError('EXECUTION_FAILED','same failure private-test-credential');};
  await f.orchestrator.run(f.j.id,new AbortController().signal);
  assert.equal(f.store.get(f.j.id).reason,'NO_PROGRESS');assert.equal(attempts,2);assert.equal(f.store.get(f.j.id).round,1);assert.ok(!JSON.stringify(repairContext).includes('private-test-credential'));assert.ok(repairContext.feedback.commands.length);
});

test('a rejected repair proposal is fed back without executing it',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask;let boots=0,repairs=0,rejection;
  f.orchestrator.sandboxes.boot=async()=>{if(++boots===1)throw new AppError('EXECUTION_FAILED','adapter error');};
  f.orchestrator.models.ask=async(id,role,task,context)=>{if(!context.feedback)return originalAsk(id,role);if(++repairs===1)return {...context.plan,kind:'github'};rejection=context.feedback;return context.plan;};
  await f.orchestrator.run(f.j.id,new AbortController().signal);
  assert.equal(f.store.get(f.j.id).state,'READY');assert.equal(f.store.get(f.j.id).round,2);assert.equal(boots,2);assert.equal(rejection.failedCandidate.kind,'github');assert.match(rejection.error,/입력 유형/);assert.ok(rejection.history.some(f=>f.code==='INVALID_PLAN'));
});

test('invalid initial plans also receive feedback before a sandbox is created',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask;let rejected;
  f.orchestrator.models.ask=async(id,role,task,context)=>{const valid=await originalAsk(id,role);if(role!=='A')return valid;if(context.feedback){rejected=context.feedback;return valid;}return {...valid,runtime:'python'};};
  await f.orchestrator.run(f.j.id,new AbortController().signal);
  assert.equal(f.store.get(f.j.id).state,'READY');assert.equal(f.store.get(f.j.id).round,1);assert.equal(rejected.failedCandidate.runtime,'python');assert.equal(f.calls.filter(c=>c==='create').length,1);
});

test('a missing authentication URL gets actionable plan feedback and a bounded repair',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask;let feedback;
  f.orchestrator.models.ask=async(id,role,task,context)=>{const valid=await originalAsk(id,role);if(role!=='A')return valid;if(context.feedback){feedback=context.feedback;return valid;}return {...valid,auth:{kind:'header',name:'appKey',issueUrl:'',docsUrl:'',label:'키',instructions:''}};};
  await f.orchestrator.run(f.j.id,new AbortController().signal);
  assert.equal(f.store.get(f.j.id).state,'READY');assert.equal(f.store.get(f.j.id).round,1);assert.match(feedback.error,/공식 키 발급 안내 URL/);assert.equal(f.calls.filter(c=>c==='create').length,1);
});

test('a late repair response cannot revive a cancelled job',async t=>{
  const f=setup(t),originalAsk=f.orchestrator.models.ask;let boots=0;
  f.orchestrator.sandboxes.boot=async()=>{boots++;throw new AppError('EXECUTION_FAILED','needs repair');};
  f.orchestrator.models.ask=async(id,role,task,context)=>{if(!context.feedback)return originalAsk(id,role);await f.orchestrator.cancel(id);return context.plan;};
  await f.orchestrator.run(f.j.id,new AbortController().signal);
  assert.equal(f.store.get(f.j.id).state,'CANCELLED');assert.equal(boots,1);assert.ok(!f.calls.includes('ready'));
});
