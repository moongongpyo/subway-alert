import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NosanaClient,NOSANA_MODEL,modelConfiguration} from '../src/nosana.js';
import {Models} from '../src/model.js';
import {Store,redact} from '../src/store.js';
import {Classification,ImageDocumentation} from '../src/contracts.js';
import {NosanaImages} from '../src/nosana-images.js';
import sharp from 'sharp';

function fixture(t,fetcher){
  const dir=mkdtempSync(join(tmpdir(),'nosana-test-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const models=new Models(store,'fallback-test-key');models.provider='nosana';
  models.client=new NosanaClient({baseURL:'https://model.example.test',token:'private-inference-key',expiresAt:new Date(Date.now()+3600000).toISOString(),fetcher});
  const job=store.create('local','https://example.com','nosana-fixture');return {models,store,job};
}
const success=(data={kind:'api',reason:'',summary:'확인'},extra={})=>Response.json({model:NOSANA_MODEL,done:true,done_reason:'stop',message:{content:JSON.stringify(data)},prompt_eval_count:850,eval_count:48,...extra});
test('Nosana preserves role/task/context and schema, maps images and records real usage',async t=>{
  let request;const {models,store,job}=fixture(t,async(url,options)=>{request={url,...options,body:JSON.parse(options.body)};return success({text:'visible evidence',uncertainties:[]});});
  const context={document:'untrusted text',token:'secret'};
  const result=await models.ask(job.id,'A','Read image',context,ImageDocumentation,{images:['data:image/png;base64,aGVsbG8='],escalate:true});
  assert.equal(result.text,'visible evidence');assert.equal(request.url,'https://model.example.test/api/chat');
  assert.equal(request.headers.Authorization,'Bearer private-inference-key');assert.equal(request.body.model,NOSANA_MODEL);
  assert.deepEqual(JSON.parse(request.body.messages[1].content),{role:'A',task:'Read image',context:{document:'untrusted text',token:'[숨김]'}});
  assert.deepEqual(request.body.messages[1].images,['aGVsbG8=']);assert.ok(request.body.format.properties.text);
  assert.equal(request.body.stream,false);assert.equal(request.body.options.num_predict,4000);
  assert.equal(store.usage(job.id).input,850);assert.equal(store.usage(job.id).rentalCalls,1);assert.equal(store.usage(job.id).micros,0);
});
test('all small/standard/escalated roles route to the deployed model',async t=>{
  const requested=[];const {models,job}=fixture(t,async(_u,o)=>{requested.push(JSON.parse(o.body).model);return success();});
  for(const options of [{small:true},{},{escalate:true}])await models.ask(job.id,'D','Build',{},Classification,options);
  assert.deepEqual(requested,[NOSANA_MODEL,NOSANA_MODEL,NOSANA_MODEL]);
});

test('native fetch failure during a repair retries the same prompt once and retains unknown usage',async t=>{
  const bodies=[];const {models,store,job}=fixture(t,async(_u,o)=>{
    bodies.push(o.body);
    if(bodies.length===1)throw new TypeError('fetch failed',{cause:Object.assign(new Error('private endpoint details'),{code:'ECONNRESET'})});
    return success();
  });
  store.update(job.id,j=>{j.round=1;});
  await models.ask(job.id,'A','Repair the failed adapter',{error:"invalid literal for int(): M"},Classification);
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);
  assert.deepEqual(store.db.prepare('SELECT status,round FROM requests WHERE job=? ORDER BY rowid').all(job.id).map(r=>({...r})),[{status:'unknown',round:1},{status:'settled',round:1}]);
  assert.match(store.get(job.id).logs.at(-1).text,/1회 재시도/);assert.equal(store.get(job.id).round,1);
});

test('connection failure while reading the response also recovers; persistent failures stop after two calls',async t=>{
  let calls=0;const {models,store,job}=fixture(t,async()=>{
    if(++calls===1)return new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated',{cause:{code:'UND_ERR_SOCKET'}}));}}));
    return success();
  });
  await models.ask(job.id,'B','Verify',{},Classification);assert.equal(calls,2);
  store.update(job.id,j=>{j.state='CANCELLED';});
  const next=store.create('local','https://example.com','persistent-failure');calls=0;
  models.client.fetcher=async()=>{calls++;throw new TypeError('fetch failed',{cause:{code:'ETIMEDOUT',message:'secret-host/token'}});};
  await assert.rejects(models.ask(next.id,'A','Repair',{},Classification),e=>e.code==='NOSANA_CONNECTION'&&e.status===503&&e.message.includes('ETIMEDOUT')&&!e.message.includes('secret-host'));
  assert.equal(calls,2);assert.equal(store.usage(next.id).calls,2);
});

test('Nosana distinguishes caller cancellation from its deadline and never retries cancellation',async t=>{
  const control=new AbortController(),reason=new Error('user cancelled');let calls=0;
  const {models,job}=fixture(t,async()=>{calls++;control.abort(reason);throw reason;});
  await assert.rejects(models.ask(job.id,'A','Analyze',{},Classification,{signal:control.signal}),e=>e===reason);
  assert.equal(calls,1);
  models.client.fetcher=async(_u,o)=>{await new Promise(resolve=>{o.signal.addEventListener('abort',resolve,{once:true});setTimeout(resolve,20);});o.signal.throwIfAborted();};
  await assert.rejects(models.client.request('/api/tags',null,{timeout:1}),{code:'NOSANA_TIMEOUT',status:408});
});
test('Nosana retains retry and token limits without silently calling OpenAI',async t=>{
  let calls=0;const {models,store,job}=fixture(t,async()=>++calls===1?new Response('',{status:503}):success());
  await models.ask(job.id,'B','Verify',{},Classification);assert.equal(calls,2);assert.equal(store.usage(job.id).calls,2);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM requests WHERE status='unknown'").get().n,1);
  store.update(job.id,j=>{j.state='CANCELLED';});
  const another=store.create('local','https://example.com','other-test-id');models.client.fetcher=async()=>success({}, {prompt_eval_count:20001});
  await assert.rejects(models.ask(another.id,'A','Analyze',{},Classification));assert.equal(store.get(another.id).reason,'METERING_MISMATCH');
});
test('expiry, cancellation and output truncation never pass as successful plans',async t=>{
  let calls=0;const {models,job}=fixture(t,async()=>{calls++;return success({}, {done_reason:'length'});});
  await assert.rejects(models.ask(job.id,'D','Build',{},Classification),{code:'MODEL_INCOMPLETE'});
  models.client.expiresAt=Date.now()-1;
  await assert.rejects(models.ask(job.id,'D','Build',{},Classification),{code:'NOSANA_EXPIRED'});assert.equal(calls,1);
  assert.equal(modelConfiguration({MODEL_PROVIDER:'nosana',NOSANA_BASE_URL:'https://example.test',NOSANA_EXPIRES_AT:'2020-01-01'}).ready,false);
  assert.throws(()=>new NosanaClient({baseURL:'http://example.test'}),{code:'INVALID_CONFIG'});
});
test('Nosana rejects unmetered output and carries cancellation signal to transport',async t=>{
  const control=new AbortController();let seen;const {models,job}=fixture(t,async(_url,o)=>{seen=o.signal;return success({}, {prompt_eval_count:undefined});});
  await assert.rejects(models.ask(job.id,'A','Analyze',{},Classification,{signal:control.signal}),{code:'UNKNOWN_TOKENS'});
  control.abort();assert.equal(seen.aborted,true);
});
test('SDXL submits one bounded image workflow and returns an actual JPEG without OpenAI',async t=>{
  const png=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
  const paths=[];let workflow;const {models,store,job}=fixture(t,async()=>{throw Error('LLM should not run');});
  models.imageClient=new NosanaImages({baseURL:'https://images.example.test',expiresAt:new Date(Date.now()+3600000).toISOString(),fetcher:async(url,options)=>{
    const path=new URL(url).pathname;paths.push(path);
    if(path.startsWith('/object_info'))return Response.json({CheckpointLoaderSimple:{input:{required:{ckpt_name:[['sd_xl_base_1.0.safetensors']]}}}});
    if(path==='/prompt'){workflow=JSON.parse(options.body).prompt;return Response.json({prompt_id:'one-image'});}
    if(path==='/history/one-image')return Response.json({'one-image':{outputs:{'9':{images:[{filename:'generated.png',subfolder:''}]}}}});
    if(path==='/view')return new Response(png);
    if(path==='/history')return Response.json({});
    throw Error('Unexpected endpoint');
  }});
  const result=await models.generateImage(job.id,'A synthetic photograph of fine hair against a white background.');
  const bytes=Buffer.from(result.base64,'base64');assert.equal(bytes[0],255);assert.equal(bytes[1],216);
  assert.equal(result.mime,'image/jpeg');assert.equal(paths.filter(p=>p==='/prompt').length,1);
  assert.equal(workflow['5'].inputs.batch_size,1);assert.equal(workflow['3'].inputs.steps,20);
  assert.equal(store.usage(job.id).calls,1);assert.equal(store.usage(job.id).rentalCalls,1);
  await assert.rejects(models.generateImage(job.id,'short'),{code:'INVALID_IMAGE_PROMPT'});assert.equal(store.usage(job.id).calls,1);
});
