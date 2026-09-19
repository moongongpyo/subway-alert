import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {records,putRecord} from '../src/evaluation-data.js';
import { Orchestrator } from '../src/orchestrator.js';
import { apiAccessOffer } from '../src/api-access.js';

test('API connection is owner-scoped, requires consent, and never returns or persists the plaintext key in job data',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-connect-http-')),store=new Store(dir),orchestrator=new Orchestrator(store,{},{}),{app}=createApp({store,models:{},sandboxes:{},orchestrator}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0],j=store.create('local','https://example.com','connect-http');
  const plan={kind:'api',endpoint:{url:'https://api.example.com/test',method:'GET'},auth:{kind:'header',name:'apiKey'},database:{kind:'none'}},offer=apiAccessOffer(plan,{});store.update(j.id,x=>{x.plan=plan;x.apiOffer=offer;});
  const running=orchestrator.waitForKey(j.id,'connect','connection');
  const headers={cookie,'Content-Type':'application/json','X-Playground-Request':'1'},body={value:'private-fixture-secret',scope:offer.scope,callLimit:10,acknowledged:true};
  const send=(data=body,h=headers)=>fetch(base+`/api/jobs/${j.id}/connection`,{method:'POST',headers:h,body:JSON.stringify(data)});
  assert.equal((await send(body,{...headers,'X-Playground-Request':''})).status,403);
  store.update(j.id,x=>{x.owner='another';});assert.equal((await send()).status,404);store.update(j.id,x=>{x.owner='local';});
  assert.equal((await send({...body,acknowledged:false})).status,400);assert.equal(store.secret(j.id),null);
  const response=await send();assert.equal(response.status,200);assert.ok(!(await response.text()).includes(body.value));await running;
  assert.equal(store.secret(j.id),body.value);assert.ok(!JSON.stringify(store.get(j.id)).includes(body.value));assert.ok(!(await(await fetch(base+`/api/jobs/${j.id}`,{headers})).text()).includes(body.value));
  assert.equal((await send()).status,409);
});

test('project name edits validate input and ownership without changing execution or billing',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-name-http-')),store=new Store(dir),{app}=createApp({store,models:{},sandboxes:{},orchestrator:{}}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0],j=store.create('local','https://pokeapi.co/api/v2/pokemon/pikachu','http-naming');
  const headers={cookie,'Content-Type':'application/json','X-Playground-Request':'1'};
  const rename=(name,extra={})=>fetch(base+`/api/jobs/${j.id}/name`,{method:'PATCH',headers:{...headers,...extra},body:JSON.stringify({name})});
  assert.equal((await rename('test',{'X-Playground-Request':''})).status,403);
  for(const name of ['', ' ', 'x'.repeat(81),'two\nlines',null])assert.equal((await rename(name)).status,400);
  const updated=await(await rename('  피카츄 비교  ')).json();assert.equal(updated.projectName,'피카츄 비교');assert.equal(updated.url,j.url);assert.equal(updated.state,j.state);assert.equal(updated.planVersion,0);assert.equal(updated.usage.calls,0);
  assert.equal((await(await fetch(base+'/api/jobs',{headers:{cookie}})).json())[0].projectName,'피카츄 비교');
  store.update(j.id,x=>{x.state='EXPIRED';});assert.equal((await rename('지난 실험')).status,200);
  store.update(j.id,x=>{x.owner='another';});assert.equal((await rename('not mine')).status,404);
});
test('HTTP app serves product, requires same-origin writes and hides provider secrets',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'playground-http-'));const store=new Store(dir);
  const {app}=createApp({store,models:{},sandboxes:{},orchestrator:{}});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const index=await fetch(base);assert.equal(index.status,200);assert.match(await index.text(),/링크 하나로/);const cookie=index.headers.get('set-cookie').split(';')[0];
  const bad=await fetch(base+'/api/jobs',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(bad.status,403);
  const cross=await fetch(base+'/api/jobs',{method:'POST',headers:{cookie,Origin:'https://evil.example','X-Playground-Request':'1','Content-Type':'application/json'},body:'{}'});assert.equal(cross.status,403);
  const job=store.create('local','https://example.com','test-request');store.update(job.id,j=>{j.controlToken='internal-secret';j.previewToken='preview-secret';j.source={text:'private source'};});
  const response=await fetch(base+`/api/jobs/${job.id}`,{headers:{cookie}});const body=await response.text();assert.ok(!body.includes('internal-secret'));assert.ok(!body.includes('preview-secret'));assert.ok(!body.includes('private source'));
  store.update(job.id,j=>{j.state='READY';j.preview='https://8088-preview-secret.example.com';j.message='error preview-secret';});
  const ready=await(await fetch(base+`/api/jobs/${job.id}`,{headers:{cookie}})).json();assert.equal(ready.preview,'https://8088-preview-secret.example.com');assert.ok(!ready.message.includes('preview-secret'));
});

test('stopped history can be removed and restored without deleting evidence, billing, or pending cleanup',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'playground-history-')),store=new Store(dir);
  const {app}=createApp({store,models:{},sandboxes:{},orchestrator:{}}),server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,index=await fetch(base),cookie=index.headers.get('set-cookie').split(';')[0];
  const headers={cookie,'X-Playground-Request':'1','Content-Type':'application/json'};
  const request=(path,method='GET')=>fetch(base+path,{method,headers});
  const j=store.create('local','https://example.com/failed','history-failed');
  store.reserveInfrastructure(j.id);const charge=store.reserve(j.id,'A','gpt-5.6-luna',100,100);store.settle(charge.id,{input_tokens:50,output_tokens:50});
  putRecord(store.db,j.evaluationId,'run',{jobId:j.id,state:'succeeded',output:{value:0}});
  const usage=store.usage(j.id),infra=store.infrastructureStatus().used;
  assert.equal((await request(`/api/jobs/${j.id}`,'DELETE')).status,409);
  store.update(j.id,x=>{x.state='FAILED';x.cleanupPending=true;x.sandboxId='cleanup-still-needed';x.evidence=[{description:'retained'}];});
  assert.equal((await fetch(base+`/api/jobs/${j.id}`,{method:'DELETE',headers:{cookie}})).status,403);
  assert.equal((await request(`/api/jobs/${j.id}`,'DELETE')).status,200);
  assert.equal((await request(`/api/jobs/${j.id}`,'DELETE')).status,200);
  assert.deepEqual(await(await request('/api/jobs')).json(),[]);
  assert.equal((await(await request('/api/jobs?dismissed=1')).json())[0].id,j.id);
  assert.equal(store.get(j.id).cleanupPending,true);assert.equal(store.get(j.id).sandboxId,'cleanup-still-needed');
  assert.equal(store.get(j.id).evidence.length,1);assert.equal(records(store.db,j.evaluationId,'run')[0].output.value,0);
  assert.deepEqual(store.usage(j.id),usage);assert.equal(store.infrastructureStatus().used,infra);
  const second=new Store(dir);assert.equal(second.list('local').length,0);assert.equal(second.list('local',{dismissed:true}).length,1);second.close();
  assert.equal((await request(`/api/jobs/${j.id}/restore`,'POST')).status,200);
  assert.equal((await(await request('/api/jobs')).json())[0].id,j.id);assert.equal(store.get(j.id).dismissedAt,undefined);
  for(const state of ['CANCELLED','EXPIRED','UNSUPPORTED']){
    store.update(j.id,x=>{x.state=state;});assert.equal((await request(`/api/jobs/${j.id}`,'DELETE')).status,200);
    assert.equal((await request(`/api/jobs/${j.id}/restore`,'POST')).status,200);
  }
  store.update(j.id,x=>{x.state='READY';});assert.equal((await request(`/api/jobs/${j.id}`,'DELETE')).status,409);
  store.update(j.id,x=>{x.owner='another-owner';x.state='FAILED';});assert.equal((await request(`/api/jobs/${j.id}`,'DELETE')).status,404);
});
