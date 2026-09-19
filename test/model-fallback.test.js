import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {Store} from '../src/store.js';
import {Models} from '../src/model.js';
import {NosanaClient,NOSANA_MODEL,modelConfiguration,ollamaSchema} from '../src/nosana.js';
import {Classification,ImageDocumentation} from '../src/contracts.js';

function fixture(t,fetcher){
  const dir=mkdtempSync(join(tmpdir(),'pg-fallback-')),store=new Store(dir),models=new Models(store,'fixture-key');
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const seen={nosana:0,counted:[],openai:[]};models.provider='nosana';
  models.client=new NosanaClient({baseURL:'https://model.example.test',expiresAt:new Date(Date.now()+3600000).toISOString(),fetcher:async(...args)=>{seen.nosana++;return fetcher(...args);}});
  models.fallbackClient={responses:{inputTokens:{count:async body=>{seen.counted.push(body);return {input_tokens:100};}},create:async body=>{seen.openai.push(body);return {status:'completed',output_text:JSON.stringify({kind:'api',reason:'',summary:'복구'}),usage:{input_tokens:100,output_tokens:50}};}}};
  const job=store.create('local','https://example.com','fallback-fixture');return {store,models,job,seen};
}
const ok=()=>Response.json({model:NOSANA_MODEL,done:true,done_reason:'stop',message:{content:JSON.stringify({kind:'api',reason:'',summary:'정상'})},prompt_eval_count:200,eval_count:50});

test('HTTP 400 falls back once with unchanged prompt/schema, real OpenAI billing and preserved uncertain Nosana usage',async t=>{
  let sent;const f=fixture(t,async(_url,options)=>{sent=JSON.parse(options.body);return new Response('',{status:400});});
  const result=await f.models.ask(f.job.id,'G','Build result',{actual:0},Classification);
  assert.equal(result.summary,'복구');assert.equal(f.seen.nosana,1);assert.equal(f.seen.openai.length,1);
  assert.equal(f.seen.openai[0].input,sent.messages[1].content);assert.deepEqual(f.seen.counted[0].text,f.seen.openai[0].text);
  assert.equal(f.seen.openai[0].model,'gpt-5.6-terra');assert.equal(f.store.usage(f.job.id).calls,2);assert.ok(f.store.usage(f.job.id).micros>0);
  const rows=f.store.db.prepare('SELECT model,status,input FROM requests ORDER BY rowid').all();assert.equal(rows[0].status,'abandoned');assert.equal(rows[0].input,20000);assert.equal(rows[1].status,'settled');
  assert.equal(f.store.get(f.job.id).modelFallbacks[0].to,'openai');
});
test('two temporary Nosana failures then one OpenAI request fit persistent concurrency without clearing usage',async t=>{
  const f=fixture(t,async()=>{throw new TypeError('fetch failed');});await f.models.ask(f.job.id,'A','Analyze',{},Classification,{small:true});
  assert.equal(f.seen.nosana,2);assert.equal(f.seen.openai.length,1);assert.equal(f.seen.openai[0].model,'gpt-5.6-luna');
  assert.equal(f.store.usage(f.job.id).calls,3);assert.equal(f.store.usage(f.job.id).input,40100);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM requests WHERE status='abandoned'").get().n,2);
});
test('cooldown skips a broken provider and resumes Nosana after expiry',async t=>{
  let broken=true;const f=fixture(t,async()=>broken?new Response('',{status:400}):ok());
  await f.models.ask(f.job.id,'D','Build',{},Classification);broken=false;
  await f.models.ask(f.job.id,'B','Check',{},Classification);assert.equal(f.seen.nosana,1);assert.equal(f.seen.openai.length,2);
  f.models.cooldowns.set('text',Date.now()-1);const result=await f.models.ask(f.job.id,'B','Check',{},Classification);
  assert.equal(result.summary,'정상');assert.equal(f.seen.nosana,2);assert.equal(f.seen.openai.length,2);
});
test('a failed OpenAI fallback is never retried or sent back to Nosana',async t=>{
  const f=fixture(t,async()=>new Response('',{status:400}));let calls=0;f.models.fallbackClient.responses.create=async()=>{calls++;throw Object.assign(new Error('provider details'),{status:503});};
  await assert.rejects(f.models.ask(f.job.id,'A','Analyze',{},Classification),{code:'OPENAI_FALLBACK_FAILED'});assert.equal(calls,1);assert.equal(f.seen.nosana,1);
});
test('cancellation and budget exhaustion cannot invoke OpenAI fallback',async t=>{
  const control=new AbortController();const f=fixture(t,async()=>{control.abort();throw control.signal.reason;});
  await assert.rejects(f.models.ask(f.job.id,'A','Analyze',{},Classification,{signal:control.signal}));assert.equal(f.seen.openai.length,0);assert.equal(f.seen.counted.length,0);
  const f2=fixture(t,async()=>new Response('',{status:400}));f2.store.update(f2.job.id,j=>{j.policy.jobMicros=1;});
  await assert.rejects(f2.models.ask(f2.job.id,'A','Analyze',{},Classification),{code:'BUDGET_EXCEEDED'});assert.equal(f2.seen.openai.length,0);
});
test('expired Nosana can use a configured fallback; disabling or missing the key keeps it unavailable',async t=>{
  const f=fixture(t,async()=>assert.fail('expired provider must not run'));f.models.client.expiresAt=Date.now()-1;
  await f.models.ask(f.job.id,'A','Analyze',{},Classification);assert.equal(f.seen.nosana,0);assert.equal(f.seen.openai.length,1);
  const env={MODEL_PROVIDER:'nosana',NOSANA_BASE_URL:'https://model.example.test',NOSANA_EXPIRES_AT:'2020-01-01',OPENAI_API_KEY:'fixture'};
  assert.equal(modelConfiguration(env).ready,true);assert.equal(modelConfiguration({...env,NOSANA_OPENAI_FALLBACK:'false'}).ready,false);assert.equal(modelConfiguration({...env,OPENAI_API_KEY:''}).ready,false);
});
test('document images and the original strict schema reach OpenAI unchanged',async t=>{
  const f=fixture(t,async()=>new Response('',{status:400}));let body;
  f.models.fallbackClient.responses.create=async b=>{body=b;return {status:'completed',output_text:'{"text":"visible","uncertainties":[]}',usage:{input_tokens:100,output_tokens:50}};};
  await f.models.ask(f.job.id,'A','Read image',{},ImageDocumentation,{images:['data:image/png;base64,aGVsbG8=']});
  assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,aGVsbG8=');assert.deepEqual(body.input,f.seen.counted[0].input);
});
test('simplified Ollama decoding preserves named properties and post-generation length validation',async t=>{
  const schema={type:'object',properties:{maxLength:{type:'string',minLength:1,maxLength:40000},cards:{type:'array',minItems:1,maxItems:3,items:{type:'string',maxLength:100}}},required:['maxLength','cards'],additionalProperties:false};
  const simple=ollamaSchema(schema);assert.deepEqual(simple.properties.maxLength,{type:'string'});assert.equal(simple.properties.cards.maxItems,undefined);assert.equal(schema.properties.maxLength.maxLength,40000);
  const f=fixture(t,async()=>Response.json({model:NOSANA_MODEL,done:true,done_reason:'stop',message:{content:'{"name":"too long"}'},prompt_eval_count:100,eval_count:50}));
  f.models.fallbackClient=null;await assert.rejects(f.models.ask(f.job.id,'D','Build',{},z.object({name:z.string().max(2)})),e=>e.name==='ZodError');
});
test('short-lived task recovery has a finite three-call allowance while dollar and time ceilings stay unchanged',async t=>{
  const f=fixture(t,async()=>{throw new TypeError('fetch failed');});
  const original={calls:1,roleCalls:1,inputPerCall:8000,inputTotal:8000,outputPerCall:3000,outputTotal:3000,jobMicros:30000,activeMs:90000,tools:2};
  const policy=f.models.recoveryPolicy(original);assert.equal(policy.calls,3);assert.equal(policy.jobMicros,original.jobMicros);assert.equal(policy.activeMs,original.activeMs);
  f.store.update(f.job.id,j=>{j.policy={...j.policy,...policy};});await f.models.ask(f.job.id,'G','Cards',{},Classification,{small:true});
  assert.equal(f.store.usage(f.job.id).calls,3);await assert.rejects(f.models.ask(f.job.id,'G','Again',{},Classification,{small:true}),{code:'BUDGET_EXCEEDED'});
});
test('SDXL failure uses one OpenAI image request and maintains separate text availability',async t=>{
  const f=fixture(t,async()=>ok());let submissions=0,images=0;
  f.models.imageClient={assertAvailable(){},generate:async()=>{submissions++;throw Object.assign(new Error('failed'),{code:'IMAGE_GENERATION_FAILED'});}};
  f.models.fallbackClient.images={generate:async()=>{images++;return {data:[{b64_json:Buffer.from([255,216,255,217]).toString('base64')}],usage:{input_tokens:50,output_tokens:100}};}};
  const result=await f.models.generateImage(f.job.id,'A synthetic photograph of a tree for testing.');assert.equal(result.mime,'image/jpeg');assert.equal(submissions,1);assert.equal(images,1);
  await f.models.ask(f.job.id,'A','Analyze',{},Classification);assert.equal(f.seen.nosana,1);assert.equal(f.seen.openai.length,0);assert.equal(f.store.usage(f.job.id).calls,3);
});
