import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DirectApi } from '../src/direct-api.js';
import { ExecutionEnvironments } from '../src/execution-environments.js';
import { Sandboxes } from '../src/daytona.js';
import { makeRecipe } from '../src/reports.js';
import { validatePlan } from '../src/contracts.js';

const response=data=>({status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(data))});
async function fixture(t,request=async()=>response({ok:true})){
  const dir=mkdtempSync(join(tmpdir(),'pg-direct-test-')),store=new Store(dir),api=new DirectApi(store,{request});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const j=store.create('local','https://api.open-meteo.com/v1/forecast','direct-test',{userRequests:10,externalMicros:100,sandboxDailyMinutes:0,maxSandboxes:0});
  store.update(j.id,x=>{x.plan={kind:'api',title:'Weather',runtime:'none',hasUI:false,database:{kind:'none'},files:[],install:[],start:'',adapter:'',auth:{kind:'none'},fields:[{name:'latitude',label:'Latitude',type:'number',required:true,location:'query'}],endpoint:{url:j.url,method:'GET',readOnly:true}};x.state='PREPARING';x.version='v1';x.requestMicros=0;});
  await api.create(j.id);await api.boot(j.id);return {store,api,j,dir};
}
test('API runs with no Daytona key or available infrastructure; GitHub still requires Daytona',async t=>{
  let count=0;const {store,api,j}=await fixture(t,async(url,options)=>{count++;assert.equal(new URL(url).searchParams.get('latitude'),'37.5');assert.equal(options.method,'GET');assert.equal(options.redirects,0);assert.equal(options.allowedOrigin,'https://api.open-meteo.com');return response({latitude:37.5});});
  const runtime=new ExecutionEnvironments(store,{api,sandbox:new Sandboxes(store,{key:null})});
  await runtime.create(j.id);await runtime.boot(j.id);assert.equal((await runtime.invoke(j.id,{latitude:'37.5'})).data.latitude,37.5);
  assert.equal(count,1);assert.equal(store.get(j.id).executionMode,'node-api');assert.equal(store.get(j.id).sandboxId,undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM infrastructure').get().n,0);
  store.update(j.id,x=>{delete x.executionMode;x.plan.kind='github';});await assert.rejects(runtime.create(j.id),{code:'CONFIG_REQUIRED'});
});
test('existing sandbox API sessions keep their original usage ledger and cleanup path',async t=>{
  const {store,j}=await fixture(t);let calls=0;store.update(j.id,x=>{delete x.executionMode;x.sandboxId='existing';});
  const runtime=new ExecutionEnvironments(store,{api:{invoke:()=>assert.fail('must not reset existing budgets')},sandbox:{invoke:async()=>++calls,cleanup:async()=>++calls}});
  await runtime.invoke(j.id,{});await runtime.cleanup(j.id);assert.equal(calls,2);
});
test('concurrent requests, restart, preparation and ready calls share durable limits',async t=>{
  let finish,calls=0;const {store,api,j}=await fixture(t,async()=>{calls++;return new Promise(r=>finish=()=>r(response({ok:true})));});
  store.update(j.id,x=>{x.apiAccess={callLimit:2};x.requestMicros=30;});
  const first=api.invoke(j.id,{latitude:1});await assert.rejects(api.invoke(j.id,{latitude:2}),{code:'BUSY'});finish();await first;
  store.update(j.id,x=>{x.state='READY';x.expiresAt=Date.now()+60_000;x.verifiedVersion=x.version;});
  const restarted=new DirectApi(store,{request:async()=>{calls++;return response({ok:true});}});
  await restarted.invoke(j.id,{latitude:2});await assert.rejects(restarted.invoke(j.id,{latitude:3}),{code:'EXTERNAL_CALL_LIMIT'});
  assert.equal(calls,2);assert.deepEqual(store.get(j.id).apiUsage,{external:1,userRequests:1,micros:60,costUnknown:false});
});
test('transport failure remains charged and a repair does not reset the money budget',async t=>{
  const {store,api,j}=await fixture(t,async()=>{throw Object.assign(new Error('timed out'),{code:'ETIMEDOUT'});});
  store.update(j.id,x=>{x.requestMicros=60;});await assert.rejects(api.invoke(j.id,{latitude:1}),e=>e.code==='EXTERNAL_UNREACHABLE'&&e.message.includes('Node.js'));
  store.update(j.id,x=>{x.version='v2';});await api.boot(j.id);await assert.rejects(api.invoke(j.id,{latitude:1}),{code:'EXTERNAL_BUDGET_REQUIRED'});
  assert.equal(store.get(j.id).apiUsage.micros,60);assert.equal(store.get(j.id).apiInvocation,undefined);
});
test('HTTP path keys require user consent, are encoded at sending and removed from output/history',async t=>{
  const key='a/b c?key';let calls=0;const {store,api,j}=await fixture(t,async(url,options)=>{calls++;assert.equal(url,'http://example.com:8088/a%2Fb%20c%3Fkey/data?latitude=1');assert.equal(options.redirects,0);return response({echo:key,encoded:encodeURIComponent(key)});});
  store.secret(j.id,key);store.update(j.id,x=>{x.plan.auth={kind:'path',name:'key'};x.plan.endpoint.url='http://example.com:8088/{key}/data';});
  await assert.rejects(api.invoke(j.id,{latitude:1}),{code:'HTTP_AUTH_CONFIRMATION_REQUIRED'});assert.equal(calls,0);
  store.update(j.id,x=>{x.apiAccess={allowHttpAuth:true};});const result=await api.invoke(j.id,{latitude:1});
  assert.ok(!JSON.stringify(result).includes(key));assert.ok(!JSON.stringify(result).includes(encodeURIComponent(key)));assert.ok(!JSON.stringify(store.get(j.id)).includes(key));
});
test('POST JSON fields and bearer authentication use the same trusted request contract',async t=>{
  const {store,api,j}=await fixture(t,async(_url,options)=>{assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer private-key');assert.deepEqual(JSON.parse(options.body),{latitude:0});return {status:200,headers:{'content-type':'image/png'},body:Buffer.from('binary')};});
  store.secret(j.id,'private-key');store.update(j.id,x=>{x.plan.auth={kind:'bearer'};x.plan.endpoint.method='POST';x.plan.fields[0].location='body';});
  const result=await api.invoke(j.id,{latitude:0});assert.equal(result.data.file.mime,'image/png');assert.equal(Buffer.from(result.data.file.base64,'base64').toString(),'binary');
});
test('cancelled or expired jobs cannot accept a late response and cleanup never needs Daytona',async t=>{
  let finish;const {store,api,j}=await fixture(t,()=>new Promise(r=>finish=()=>r(response({late:true}))));
  store.secret(j.id,'private-key');const pending=api.invoke(j.id,{latitude:1});store.update(j.id,x=>{x.state='CANCELLED';});await api.cleanup(j.id);finish();await assert.rejects(pending,{code:'STOPPED'});
  assert.equal(store.secret(j.id),null);assert.equal(store.get(j.id).cleanupPending,false);assert.equal(store.get(j.id).apiRequestHistory,undefined);
  store.update(j.id,x=>{x.state='READY';x.expiresAt=Date.now()-1;x.verifiedVersion=x.version;});await assert.rejects(api.invoke(j.id,{latitude:1}),{code:'STOPPED'});
});
test('untrusted generated commands are rejected and private API targets never reach the network',async t=>{
  const {store,api,j}=await fixture(t,()=>assert.fail('no network'));
  store.update(j.id,x=>{x.plan.install=['npm install malicious'];});await assert.rejects(api.boot(j.id),{code:'INVALID_PLAN'});
  store.update(j.id,x=>{x.plan.install=[];x.plan.endpoint.url='http://127.0.0.1:3005/admin';});await assert.rejects(api.invoke(j.id,{latitude:1}));assert.equal(store.get(j.id).apiUsage,undefined);
});
test('API recipes identify Node.js and contain only the real HTTP observations',async t=>{
  const {store,api,j}=await fixture(t);await api.invoke(j.id,{latitude:37});store.update(j.id,x=>{x.verifiedVersion=x.version;x.evidence=[{role:'E',version:x.version}];});
  const recipe=makeRecipe(store.get(j.id));assert.equal(recipe.available,true);assert.match(recipe.markdown,/Node.js/);assert.match(recipe.markdown,/실제 HTTP 호출 기록/);assert.ok(!recipe.markdown.includes('원래 Daytona 환경'));
});

test('direct GET analysis preserves observed queries despite model reformatting or defaults',async t=>{
  const {store,j}=await fixture(t),plan={...store.get(j.id).plan,supported:true};
  const source={kind:'api',direct:true,url:'https://api.open-meteo.com/v1/forecast?latitude=37.5&current=temperature_2m,weather_code&timezone=Asia%2FSeoul'};
  for(const url of ['https://api.open-meteo.com/v1/forecast','https://api.open-meteo.com/v1/forecast?latitude={latitude}&timezone=Asia/Seoul','https://api.open-meteo.com/v1/forecast?latitude=0']){
    const result=validatePlan({...structuredClone(plan),endpoint:{...plan.endpoint,url}},source);
    assert.equal(result.endpoint.url,source.url);assert.equal(result.fields.find(f=>f.name==='latitude').example,'37.5');assert.equal(result.fields.find(f=>f.name==='current').example,'temperature_2m,weather_code');
  }
  for(const endpoint of [{url:'https://other.example.com/v1/forecast',method:'GET'},{url:'http://api.open-meteo.com/v1/forecast',method:'GET'},{url:'https://api.open-meteo.com/v1/delete',method:'GET'},{url:source.url,method:'POST'}])assert.throws(()=>validatePlan({...structuredClone(plan),endpoint:{...plan.endpoint,...endpoint}},source),{code:'INVALID_PLAN'});
});
