import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,redact} from '../src/store.js';
const fixture=t=>{const path=mkdtempSync(join(tmpdir(),'playground-test-'));const s=new Store(path);t.after(()=>{s.close();rmSync(path,{recursive:true,force:true});});const job=s.create('local','https://example.com','same-request');return{s,job,path};};
test('duplicate submission returns one job; another active submission is blocked',t=>{const{s,job}=fixture(t);assert.equal(s.create('local',job.url,'same-request').id,job.id);assert.throws(()=>s.create('local',job.url,'different'),{code:'ACTIVE_JOB'});});
test('two connections cannot spend the same remaining cost reservation',t=>{const{s,job,path}=fixture(t);s.update(job.id,j=>j.policy.jobMicros=70_000);const second=new Store(path);try{s.reserve(job.id,'A','gpt-5.6-terra',4000,4000);assert.throws(()=>second.reserve(job.id,'D','gpt-5.6-terra',4000,4000),{code:'BUDGET_EXCEEDED'});assert.equal(s.usage(job.id).calls,1);}finally{second.close();}});
test('unknown usage stays reserved and settlement is idempotent',t=>{const{s,job}=fixture(t);const r=s.reserve(job.id,'A','gpt-5.6-terra',4000,4000);s.settle(r.id,null);assert.equal(s.usage(job.id).reserved,r.micros);s.settle(r.id,{input_tokens:200,output_tokens:300});const amount=s.usage(job.id).micros;s.settle(r.id,{input_tokens:1,output_tokens:1});assert.equal(s.usage(job.id).micros,amount);assert.equal(s.usage(job.id).reserved,0);});
test('unknown provider calls also occupy concurrency slots',t=>{const{s,job}=fixture(t);for(let n=0;n<2;n++){const r=s.reserve(job.id,'A','gpt-5.6-luna',100,100);s.settle(r.id,null);}assert.throws(()=>s.reserve(job.id,'D','gpt-5.6-luna',100,100),{code:'CONCURRENCY_LIMIT'});});
test('terminated jobs retain unknown costs without permanently consuming live concurrency',t=>{
  const {s,job}=fixture(t);
  for(let i=0;i<2;i++){const r=s.reserve(job.id,'A','gpt-5.6-luna',100,100);s.settle(r.id,null);}
  const reserved=s.usage(job.id).reserved;assert.ok(reserved>0);
  s.update(job.id,j=>{j.state='FAILED';});
  const next=s.create('local','https://example.com','after-disconnect');
  s.reserve(next.id,'A','gpt-5.6-luna',100,100);s.reserve(next.id,'B','gpt-5.6-luna',100,100);
  assert.equal(s.usage(job.id).reserved,reserved);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM requests WHERE job=? AND status='unknown'").get(job.id).n,2);
  assert.throws(()=>s.reserve(next.id,'D','gpt-5.6-luna',100,100),{code:'CONCURRENCY_LIMIT'});
});
test('role and global request caps include unsuccessful attempts',t=>{const{s,job}=fixture(t);for(let n=0;n<job.policy.roleCalls;n++){const r=s.reserve(job.id,'A','gpt-5.6-luna',10,10);s.settle(r.id,{input_tokens:10,output_tokens:10});}assert.throws(()=>s.reserve(job.id,'A','gpt-5.6-luna',10,10),{code:'BUDGET_EXCEEDED'});});
test('daily ledger spans different jobs and owners',t=>{const{s,job}=fixture(t);s.update(job.id,j=>j.policy.userDayMicros=1000);const r=s.reserve(job.id,'A','gpt-5.6-luna',1000,100);s.settle(r.id,null);s.update(job.id,j=>j.state='FAILED');const next=s.create('local','https://example.com','new-request',{userDayMicros:400});assert.throws(()=>s.reserve(next.id,'A','gpt-5.6-luna',1000,100),{code:'BUDGET_EXCEEDED'});});
test('repair count persists, repeated unchanged failure stops and Sol cannot escape its round',t=>{const{s,job,path}=fixture(t);s.update(job.id,j=>j.policy.repairs=2);s.repair(job.id,'error-1');assert.throws(()=>s.repair(job.id,'error-1'),{code:'NO_PROGRESS'});const r=s.reserve(job.id,'A','gpt-5.6-sol',100,100);s.settle(r.id,{input_tokens:100,output_tokens:100});s.repair(job.id,'changed-code');assert.throws(()=>s.reserve(job.id,'D','gpt-5.6-sol',100,100),{code:'BUDGET_EXCEEDED'});assert.throws(()=>s.repair(job.id,'third-error'),{code:'BUDGET_EXCEEDED'});const second=new Store(path);assert.equal(second.get(job.id).round,2);assert.equal(second.usage(job.id).calls,1);second.close();});
test('cancelled jobs reject late work; input waiting excludes only paused time',t=>{const{s,job}=fixture(t);s.update(job.id,j=>{j.activeSince=Date.now()-j.policy.activeMs-1000;});assert.throws(()=>s.count(job.id,'tools'),{code:'TIME_LIMIT_EXCEEDED'});s.update(job.id,j=>{j.state='WAITING_FOR_USER';j.activeSince=null;j.activeSpent=15000;});assert.equal(s.remaining(s.get(job.id)),job.policy.activeMs-15000);s.update(job.id,j=>j.state='CANCELLED');assert.throws(()=>s.reserve(job.id,'A','gpt-5.6-luna',10,10),{code:'STOPPED'});});
test('secrets encrypted on disk and omitted from nested logs; zero false null survive',t=>{const{s,job}=fixture(t);s.secret(job.id,'sensitive-value-abc');const row=s.db.prepare('SELECT value FROM secrets WHERE job=?').get(job.id);assert.ok(!row.value.includes('sensitive'));assert.equal(s.secret(job.id),'sensitive-value-abc');assert.deepEqual(redact({n:0,b:false,x:null,api_key:'secret',log:'key sensitive-value-abc'},['sensitive-value-abc']),{n:0,b:false,x:null,api_key:'[숨김]',log:'key [숨김]'});s.secret(job.id,null);assert.equal(s.secret(job.id),null);});
test('all automatic tool families share persistent bounded counters',t=>{const{s,job}=fixture(t);s.count(job.id,'browserActions',job.policy.browserActions);assert.throws(()=>s.count(job.id,'browserActions'),{code:'BUDGET_EXCEEDED'});s.count(job.id,'external',job.policy.external);assert.throws(()=>s.count(job.id,'external'),{code:'BUDGET_EXCEEDED'});});
