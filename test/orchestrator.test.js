import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Orchestrator} from '../src/orchestrator.js';
import {stepsFor} from '../src/contracts.js';
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'pg-lifecycle-'));const s=new Store(dir);const j=s.create('local','https://example.com','lifecycle');const o=new Orchestrator(s,{}, {cleanup:async id=>s.update(id,x=>{x.cleanedAt=Date.now();x.cleanupPending=false;})},dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {s,j,o};};
test('exhausted model transport retries do not become source-code repair attempts',async t=>{
  const {s,j,o}=fixture(t);let calls=0;o.models={ask:async()=>{calls++;}};
  for(const code of ['NOSANA_CONNECTION','NOSANA_TIMEOUT','NOSANA_EXPIRED']){
    const error=Object.assign(new Error('model unavailable'),{code});
    await assert.rejects(o.repairPlan(j.id,error,{},new AbortController().signal),e=>e===error);
  }
  assert.equal(calls,0);assert.equal(s.get(j.id).round,0);
});
test('waiting for input pauses active clock; supplying secret resumes without another model request',async t=>{const{s,j,o}=fixture(t);s.update(j.id,x=>{x.steps=stepsFor({auth:{kind:'bearer'},database:{kind:'none'},hasUI:false});});const promise=o.waitForKey(j.id);const waiting=s.get(j.id);assert.equal(waiting.state,'WAITING_FOR_USER');assert.equal(waiting.activeSince,null);o.credentials(j.id,'test-user-api-key');await promise;assert.equal(s.get(j.id).state,'PREPARING');assert.equal(s.secret(j.id),'test-user-api-key');assert.equal(s.usage(j.id).calls,0);});
test('cancelling input wait cannot revive the job when the waiter returns',async t=>{const{s,j,o}=fixture(t);const promise=o.waitForKey(j.id);await o.cancel(j.id);await assert.rejects(promise);assert.equal(s.get(j.id).state,'CANCELLED');assert.equal(s.secret(j.id),null);assert.throws(()=>o.credentials(j.id,'late-key'),{code:'INVALID_STATE'});});
test('server restart preserves reservations, terminates incomplete jobs and cleans resources',async t=>{const{s,j,o}=fixture(t);s.reserve(j.id,'A','gpt-5.6-terra',100,100);s.update(j.id,x=>x.cleanupPending=true);await o.recover();assert.equal(s.get(j.id).state,'FAILED');assert.equal(s.get(j.id).reason,'SERVER_RESTARTED');assert.equal(s.usage(j.id).calls,1);assert.ok(s.usage(j.id).reserved>0);assert.ok(s.get(j.id).cleanedAt);});
test('expired ready job and input wait are both cleaned without model calls',async t=>{const{s,j,o}=fixture(t);s.update(j.id,x=>{x.state='READY';x.expiresAt=Date.now()-1;});await o.sweep();assert.equal(s.get(j.id).state,'EXPIRED');assert.ok(s.get(j.id).cleanedAt);assert.equal(s.usage(j.id).calls,0);});
test('published preview is never ready without browser verification in a failed preparation',async t=>{const{s,j,o}=fixture(t);s.update(j.id,x=>{x.state='VERIFYING';x.steps=stepsFor({auth:{kind:'none'},database:{kind:'none'},hasUI:false});});await o.cancel(j.id,'FAILED','BROWSER_FAILED');assert.notEqual(s.get(j.id).state,'READY');assert.notEqual(s.get(j.id).steps.at(-1).status,'completed');});

test('browser repair preserves app version and retries only the scenario using shared repair budget',async t=>{
  const {s,j,o}=fixture(t);s.update(j.id,x=>{x.state='VERIFYING';x.version='unchanged';x.plan={hasUI:true,capability:'QR generation',expected:'QR image'};x.steps=[{id:'browser',status:'running'}];});
  let inspections=0,executions=0,models=0;
  o.sandboxes.browser=async(id,params)=>{if(params.inspect){inspections++;return {dom:{controls:[{tag:'INPUT',id:'data'}]}};}executions++;if(executions===1)throw Object.assign(new Error('Use expectValue'),{code:'BROWSER_TEST_INVALID'});return {passed:true,version:'unchanged'};};
  o.sandboxes.boot=async()=>assert.fail('must not reinstall');
  o.models.ask=async(id,role,prompt,context)=>{assert.equal(role,'E');models++;if(models===2)assert.match(context.feedback.error,/expectValue/);return {scenario:'QR',actions:[{type:'fill',selector:'#data',value:'test'},{type:'expectVisible',selector:'canvas',value:''}]};};
  const result=await o.verifyBrowser(j.id,new AbortController().signal);
  assert.equal(result.passed,true);assert.equal(inspections,2);assert.equal(executions,2);assert.equal(s.get(j.id).round,1);assert.equal(s.get(j.id).version,'unchanged');
});

test('persistent browser failure stops after one scenario repair and cannot trigger application repair',async t=>{
  const {s,j,o}=fixture(t);s.update(j.id,x=>{x.state='VERIFYING';x.plan={hasUI:true};x.steps=[];});
  let calls=0;o.models.ask=async()=>({scenario:'output',actions:[{type:'expectVisible',selector:'canvas',value:''}]});
  o.sandboxes.browser=async(id,p)=>{if(p.inspect)return {dom:{}};calls++;throw Object.assign(new Error('missing output'),{code:'BROWSER_FAILED'});};
  let error;try{await o.verifyBrowser(j.id,new AbortController().signal);}catch(e){error=e;}
  assert.equal(error.code,'BROWSER_TEST_FAILED');assert.equal(calls,2);
  await assert.rejects(o.repairPlan(j.id,error,{},new AbortController().signal),{code:'BROWSER_TEST_FAILED'});
});

test('browser infrastructure failures do not regenerate tests',async t=>{
  const {s,j,o}=fixture(t);s.update(j.id,x=>{x.state='VERIFYING';x.plan={hasUI:true};});
  o.sandboxes.browser=async()=>{throw Object.assign(new Error('browser unavailable'),{code:'BROWSER_UNREACHABLE'});};
  o.models.ask=async()=>assert.fail('must not call model');
  await assert.rejects(o.verifyBrowser(j.id,new AbortController().signal),{code:'BROWSER_UNREACHABLE'});assert.equal(s.get(j.id).round,0);
});
