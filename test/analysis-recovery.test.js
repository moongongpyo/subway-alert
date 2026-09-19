import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {analyzeWithRecovery} from '../src/analysis-recovery.js';
import {DocumentationAssessment,ImageDocumentation} from '../src/contracts.js';

function setup(t,assessments){
  const dir=mkdtempSync(join(tmpdir(),'pg-analysis-recovery-')),store=new Store(dir),url='https://docs.example.com/';
  const job=store.create('local',url,'analysis-recovery-fixture');
  const source={kind:'api',url,text:'API URL /weather; latitude longitude required',pages:[{url,title:'Weather',via:'HTML'}],links:[],apiEvidence:[{url:'https://api.example.com/weather?latitude=1&longitude=2',from:url,kind:'request-example',method:'GET'}]};
  const plan={kind:'api',supported:true,endpoint:{url:'https://api.example.com/weather',method:'GET',readOnly:true},runtime:'none',hasUI:false,files:[],install:[],start:'',adapter:'',database:{kind:'none'},auth:{kind:'none',name:''},fields:[]};
  const calls=[];let index=0;
  const models={ask:async(id,role,task,context,schema,options)=>{
    calls.push({schema,context,options});const reservation=store.reserve(id,role,options?.small?'gpt-5.6-luna':'gpt-5.6-terra',100,100);store.settle(reservation.id,{input_tokens:100,output_tokens:20});
    if(schema===ImageDocumentation)return {text:'API documentation image',uncertainties:[]};
    return schema===DocumentationAssessment?{kind:assessments[Math.min(index++,assessments.length-1)],reason:'HTTP 메서드 근거 확인 필요',choiceIds:[]}:structuredClone(plan);
  }};
  const options={store,models,signal:new AbortController().signal,recoverSource:()=>assert.fail('No extra collection expected')};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,job,source,calls,options};
}

test('initial analysis rejection receives targeted feedback and recovers before creating an environment',async t=>{
  const f=setup(t,['insufficient','api']);let retained=0;
  const plan=await analyzeWithRecovery(f.job.id,f.source,{...f.options,onSource:()=>retained++});
  assert.equal(plan.endpoint.method,'GET');assert.equal(f.calls.length,3);assert.equal(f.calls[1].context.analysisFeedback[0].action,'review');assert.equal(f.calls[1].options.small,false);
  const job=f.store.get(f.job.id);assert.equal(job.round,1);assert.equal(job.counters.analysisRecoveries,1);assert.equal(job.analysisRecovery[0].status,'recovered');assert.equal(job.sandboxId,undefined);assert.ok(retained>0);assert.equal(f.store.usage(job.id).calls,3);
});

test('second recovery adds targeted documentation and charges shared request and repair budgets',async t=>{
  const f=setup(t,['insufficient','insufficient','api']);let fetches=0;
  const recoverSource=async(source,reason,tool,options)=>{fetches++;assert.match(reason,/메서드/);tool();options.onPage();return {...source,text:source.text+'\nGET https://api.example.com/weather',pages:[...source.pages,{url:'https://docs.example.com/reference',via:'HTML'}],stats:{pages:2,requests:1,rendered:0}};};
  await analyzeWithRecovery(f.job.id,f.source,{...f.options,recoverSource});
  const job=f.store.get(f.job.id);assert.equal(fetches,1);assert.equal(f.calls.length,4);assert.match(f.calls[2].context.text,/GET https/);assert.equal(job.round,2);assert.equal(job.counters.documentRequests,1);assert.equal(job.counters.documentPages,1);assert.ok(Array.isArray(job.documentation.pages));assert.equal(job.analysisRecovery[1].status,'recovered');assert.equal(f.store.usage(job.id).calls,4);
});

test('genuinely incomplete documentation stops after two recoveries without fabricating a plan',async t=>{
  const f=setup(t,['insufficient']);let fetches=0;
  await assert.rejects(analyzeWithRecovery(f.job.id,f.source,{...f.options,recoverSource:async source=>{fetches++;return {...source,text:source.text+' More product introduction'};}}),e=>e.code==='DOCUMENTATION_INCOMPLETE'&&/추가 문서 확인 후에도/.test(e.message));
  assert.equal(fetches,1);assert.equal(f.calls.length,3);assert.equal(f.store.get(f.job.id).counters.analysisRecoveries,2);assert.equal(f.store.get(f.job.id).analysisRecovery[1].status,'insufficient');assert.equal(f.store.get(f.job.id).plan,undefined);
});

test('unchanged collected evidence stops before another model call',async t=>{
  const f=setup(t,['insufficient']);
  await assert.rejects(analyzeWithRecovery(f.job.id,f.source,{...f.options,recoverSource:async source=>({...source})}),e=>e.code==='DOCUMENTATION_INCOMPLETE'&&/새로운 근거/.test(e.message));
  assert.equal(f.calls.length,2);assert.equal(f.store.get(f.job.id).analysisRecovery[1].status,'no-new-evidence');
});

test('unsupported protocols and exhausted shared budgets cannot be bypassed by analysis recovery',async t=>{
  const unsupported=setup(t,['unsupported']);await assert.rejects(analyzeWithRecovery(unsupported.job.id,unsupported.source,unsupported.options),{code:'UNSUPPORTED'});assert.equal(unsupported.calls.length,1);assert.equal(unsupported.store.get(unsupported.job.id).round,0);
  const budget=setup(t,['insufficient']);budget.store.update(budget.job.id,j=>j.policy.repairs=0);
  await assert.rejects(analyzeWithRecovery(budget.job.id,budget.source,budget.options),{code:'BUDGET_EXCEEDED'});assert.equal(budget.calls.length,1);
});

test('cancellation during document recovery cannot dispatch a late analysis call',async t=>{
  const f=setup(t,['insufficient']),controller=new AbortController();
  await assert.rejects(analyzeWithRecovery(f.job.id,f.source,{...f.options,signal:controller.signal,recoverSource:async source=>{controller.abort();return {...source,text:'new evidence'};}}),{name:'AbortError'});
  assert.equal(f.calls.length,2);assert.equal(f.store.get(f.job.id).analysisRecovery[1].status,'stopped');assert.notEqual(f.source.text,'new evidence');
});

test('recovery reuses an image transcription without paying to read the same image again',async t=>{
  const f=setup(t,['insufficient','api']);f.source.images=[{url:'https://docs.example.com/table.png',dataURL:'data:image/png;base64,AA=='}];
  await analyzeWithRecovery(f.job.id,f.source,f.options);
  assert.equal(f.calls.filter(c=>c.schema===ImageDocumentation).length,1);assert.equal(f.calls.length,4);
});
