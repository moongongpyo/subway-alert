import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Store } from '../src/store.js';
import { Sandboxes } from '../src/daytona.js';
import { Orchestrator } from '../src/orchestrator.js';

function fixture(t,kind='api'){
  const dir=mkdtempSync(join(tmpdir(),'pg-daytona-boundaries-')),store=new Store(dir),job=store.create('local','https://api.github.com/test','boundary-test',{sandboxDailyMinutes:300,maxSandboxes:3,sandboxMinutes:100});
  store.update(job.id,j=>{j.plan={kind,endpoint:{url:j.url},install:[],files:[],start:'',adapter:''};});
  const boxes=new Sandboxes(store,{key:null});boxes.command=async()=>{};boxes.checkConnectivity=async()=>{};
  t.after(()=>{store.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir()))&&dir.includes('pg-daytona-boundaries-'));rmSync(dir,{recursive:true,force:true});});return {store,job,boxes};
}
for(const kind of ['api','github'])test(`${kind} creation uses tier defaults without any job firewall requirement`,async t=>{
  const {store,job,boxes}=fixture(t,kind);let n=0;
  if(kind==='github')store.update(job.id,j=>{j.plan.install=['npm ci'];j.plan.start='npm start';});
  boxes.client={create:async params=>{n++;for(const key of ['domainAllowList','networkAllowList','networkBlockAll','outboundProxyUrl'])assert.ok(!Object.hasOwn(params,key));assert.equal(params.public,false);return {id:'sandbox',cpu:2,memory:4,disk:20,getWorkDir:async()=>'/home/daytona'};}};
  await boxes.create(job.id);assert.equal(n,1);assert.equal(store.get(job.id).networkMode,'provider-default');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM infrastructure').get().n,1);
});

for(const kind of ['api','github'])test(`${kind} boot and repair do not restore allowlists or block outbound traffic after installation`,async t=>{
  const {store,job,boxes}=fixture(t,kind);let previews=0;
  store.update(job.id,j=>{j.root='/home/daytona/playground';j.cloned=true;j.round=1;j.networkMode='provider-default';j.plan.database={kind:'none'};});
  boxes.cache.set(job.id,{updateNetworkSettings:()=>assert.fail('MVP must not apply a job firewall'),getSignedPreviewUrl:async()=>{previews++;return {url:'https://preview.example.com',token:'test-preview'};}});
  boxes.upload=async()=>{};boxes.start=async()=>{};boxes.health=async()=>{};
  await boxes.boot(job.id,{});assert.equal(previews,1);assert.equal(store.get(job.id).preview,'https://preview.example.com');
});

test('API connectivity is checked without a key or HTTP invocation before runtime installation',async t=>{
  const {store,job,boxes}=fixture(t);const uploads=[],commands=[];store.update(job.id,j=>{j.root='/home/daytona/playground';j.networkMode='organization';j.plan.endpoint.url='http://openapi.seoul.go.kr:8088/{apiKey}/json/Example/1/5';});
  boxes.upload=async(_id,path,bytes)=>uploads.push({path,bytes:String(bytes)});
  boxes.command=async(_id,command)=>{commands.push(command);return JSON.stringify({reachable:false,code:'EXTERNAL_UNREACHABLE',error:'timeout'});};
  await assert.rejects(Sandboxes.prototype.checkConnectivity.call(boxes,job.id),e=>e.code==='EXTERNAL_UNREACHABLE'&&/계정의 강제 네트워크 제한/.test(e.message));
  assert.equal(commands.length,1);assert.ok(commands[0].includes('http://openapi.seoul.go.kr:8088'));assert.ok(!commands[0].includes('apiKey'));assert.ok(!commands[0].includes('json/Example'));
  assert.equal(store.get(job.id).networkCheck.reachable,false);assert.equal(store.get(job.id).counters.external,undefined);assert.ok(!uploads.some(u=>u.path.includes('credential')));
  boxes.command=async()=>JSON.stringify({reachable:true,durationMs:50});await Sandboxes.prototype.checkConnectivity.call(boxes,job.id);assert.equal(store.get(job.id).networkCheck.reachable,true);
});
test('ambiguous creation errors never create duplicate environments',async t=>{
  const {job,boxes}=fixture(t);let n=0;boxes.client={create:async()=>{n++;throw new Error('connection timed out');}};await assert.rejects(boxes.create(job.id),/timed out/);assert.equal(n,1);
});
test('SDK statusCode 404 confirms sandbox cleanup and removes preview credentials',async t=>{
  const {store,job,boxes}=fixture(t);store.update(job.id,j=>{j.sandboxName='pg-'+j.id;j.cleanupPending=true;j.controlToken='internal-token';j.preview='https://example.com/private';});
  boxes.client={get:async()=>{const e=new Error('Resource does not exist');e.statusCode=404;throw e;}};await boxes.cleanup(job.id);const j=store.get(job.id);assert.equal(j.cleanupPending,false);assert.equal(j.controlToken,undefined);assert.equal(j.preview,undefined);
});

test('preview connection failures are infrastructure errors, never repairable browser assertions',async t=>{
  const {store,job,boxes}=fixture(t);store.update(job.id,j=>{j.root='/home/daytona/playground';j.preview='https://example.com';j.version='v1';});
  boxes.upload=async()=>{};boxes.command=async()=>JSON.stringify({passed:false,actions:0,code:'BROWSER_UNREACHABLE',error:'net::ERR_CONNECTION_RESET'});
  await assert.rejects(boxes.browser(job.id,{generic:true,sample:{}}),{code:'BROWSER_UNREACHABLE'});
  boxes.command=async()=> 'unexpected runner crash';
  await assert.rejects(boxes.browser(job.id,{generic:true,sample:{}}),{code:'BROWSER_RUNNER_FAILED'});
  boxes.command=async()=>JSON.stringify({passed:false,code:'EXTERNAL_UNREACHABLE',error:'API network timeout'});
  await assert.rejects(boxes.browser(job.id,{generic:true,sample:{}}),{code:'EXTERNAL_UNREACHABLE'});
});

test('failure evidence retains original cause while removing private preview credentials',t=>{
  const {store,job,boxes}=fixture(t);store.update(job.id,j=>{j.previewToken='private-preview-token';});
  const o=new Orchestrator(store,null,boxes);o.failure(job.id,Object.assign(new Error('connection private-preview-token reset'),{code:'BROWSER_UNREACHABLE'}));
  o.failure(job.id,Object.assign(new Error('repair budget reached'),{code:'BUDGET_EXCEEDED'}));
  assert.equal(store.get(job.id).failures[0].code,'BROWSER_UNREACHABLE');assert.ok(!JSON.stringify(store.get(job.id).failures).includes('private-preview-token'));
});

test('public preview requires matching version and the actual deployed HTML and assets',async t=>{
  const {store,job,boxes}=fixture(t);store.update(job.id,j=>{j.version='v1';j.preview='https://preview.example.com';});
  const realFetch=globalThis.fetch;t.after(()=>globalThis.fetch=realFetch);let corrupt=false;
  globalThis.fetch=async url=>{const name=new URL(url).pathname.slice(1)||'playground.html';return new Response(corrupt?'wrong bytes':readFileSync(resolve('public',name)),{headers:{'Content-Type':name.endsWith('.html')?'text/html':'text/javascript','X-Playground-Version':'v1'}});};
  assert.equal((await boxes.verifyPreview(job.id)).role,'P');corrupt=true;await assert.rejects(boxes.verifyPreview(job.id),{code:'PREVIEW_FAILED'});
});

test('exhausted infrastructure blocks preparation before model work or a new project is created',t=>{
  const {store,job}=fixture(t);store.reserveInfrastructure(job.id);store.update(job.id,j=>j.state='FAILED');
  const before=store.db.prepare('SELECT COUNT(*) n FROM evaluations').get().n;
  assert.throws(()=>store.create('local','https://example.org','budget-preflight',{sandboxDailyMinutes:100}),{code:'INFRA_BUDGET'});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM evaluations').get().n,before);assert.equal(store.usage(job.id).calls,0);
});

test('demo infrastructure defaults admit new work without erasing earlier reservations',t=>{
  const {store,job}=fixture(t);store.reserveInfrastructure(job.id);store.update(job.id,j=>j.state='FAILED');
  for(let i=0;i<2;i++){const next=store.create('local','https://example.org','previous-budget-'+i,{sandboxDailyMinutes:300,maxSandboxes:3,sandboxMinutes:100});store.reserveInfrastructure(next.id);store.update(next.id,j=>j.state='FAILED');}
  assert.equal(store.infrastructureStatus({sandboxDailyMinutes:300}).available,false);
  assert.deepEqual(Object.fromEntries(['used','limit','max','available'].map(k=>[k,store.infrastructureStatus()[k]])),{used:300,limit:10000,max:10,available:true});
  const next=store.create('local','https://example.org','demo-new-budget');store.reserveInfrastructure(next.id);
  assert.equal(store.infrastructureStatus().used,420);assert.equal(store.get(job.id).policy.sandboxDailyMinutes,300);assert.equal(next.policy.sandboxDailyMinutes,10000);
});

test('demo concurrent sandbox allowance remains bounded at ten environments',t=>{
  const {store,job}=fixture(t);store.update(job.id,j=>{j.state='READY';j.sandboxId='fixture-0';});
  for(let i=1;i<10;i++){const next=store.create('local','https://example.org','concurrent-demo-'+i);store.update(next.id,j=>{j.state='READY';j.sandboxId='fixture-'+i;});}
  assert.equal(store.infrastructureStatus().active,10);assert.equal(store.infrastructureStatus().available,false);
  assert.throws(()=>store.create('local','https://example.org','eleventh-environment'),{code:'INFRA_BUDGET'});
});

test('a sandbox returned after cancellation is retained for cleanup and never booted',async t=>{
  const {store,job,boxes}=fixture(t);let deleted=0,commands=0;
  boxes.command=async()=>commands++;
  boxes.client={create:async()=>{store.update(job.id,j=>{j.state='CANCELLED';j.cleanedAt=Date.now();j.cleanupPending=false;});return {id:'late-sandbox',cpu:2,memory:4,disk:20,getWorkDir:async()=>'/home/daytona'};},delete:async()=>deleted++};
  await assert.rejects(boxes.create(job.id),{code:'STOPPED'});assert.equal(commands,0);assert.equal(store.get(job.id).cleanupPending,true);
  await boxes.cleanup(job.id);assert.equal(deleted,1);assert.equal(store.get(job.id).cleanupPending,false);
});
