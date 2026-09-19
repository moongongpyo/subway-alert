// Isolated connection UI fixture: no provider clients, external calls or real keys.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { createApp } from '../src/server.js';
import { apiAccessOffer } from '../src/api-access.js';
import { stepsFor } from '../src/contracts.js';
const dir=mkdtempSync(join(tmpdir(),'pg-connection-ui-')),store=new Store(dir);
const plan={title:'API 연결 화면 테스트',capability:'발급 안내와 키 연결 UI를 검증하는 테스트입니다. 실제 API를 호출하지 않습니다.',kind:'api',runtime:'none',hasUI:false,fields:[],database:{kind:'none'},endpoint:{url:'https://api.example.com/search',method:'GET'},auth:{kind:'header',name:'appKey',label:'테스트 키',issueUrl:'/fixture-keys',docsUrl:'/fixture-guide',instructions:'1. 테스트 발급 페이지를 여세요.\n2. 화면의 테스트 키를 복사하세요.\n3. 이 화면으로 돌아와 아래에 붙여넣으세요.'}};
if(process.env.CONNECTION_HTTP==='1'){plan.title='HTTP 경로 인증 연결 테스트';plan.endpoint.url='http://openapi.seoul.go.kr:8088/{apiKey}/json/Test/1/5';plan.auth.kind='path';plan.auth.name='apiKey';}
const sandbox={cleanup:async id=>store.secret(id,null)},o=new Orchestrator(store,{},sandbox,dir);
const {app}=createApp({store,models:{},sandboxes:sandbox,orchestrator:o});
const job=store.create('local','https://example.com/connection-fixture','connection-ui');
store.update(job.id,j=>{j.plan=plan;j.steps=stepsFor(plan);j.apiOffer=apiAccessOffer(plan,{});});
const run=o.waitForKey(job.id,'API 키를 연결해주세요.','connection');
run.then(async()=>{
  store.secret(job.id,null);
  await o.waitForKey(job.id,'테스트: 첫 번째 키가 거부됐습니다. 다시 입력해주세요.');
  store.secret(job.id,null);
  store.update(job.id,j=>{j.state='CANCELLED';j.reason='FIXTURE_DONE';j.message='키 연결 → 인증 오류 → 재입력 검증을 완료했습니다. 실제 API 호출은 없었습니다.';j.activeSince=null;});
}).catch(()=>{});
app.get('/fixture-keys',(_req,res)=>res.type('html').send('<html lang="ko"><title>테스트 키 발급 페이지</title><h1>테스트 전용 발급 페이지</h1><p>외부 서비스가 아닌 UI 테스트입니다.</p><code>fixture-example-key</code></html>'));
app.get('/fixture-guide',(_req,res)=>res.type('html').send('<html lang="ko"><title>테스트 인증 안내</title><h1>테스트 키를 복사해 연결 화면에 붙여넣으세요.</h1></html>'));
app.listen(3006,'127.0.0.1',()=>console.log('Connection UI fixture: http://127.0.0.1:3006/#'+job.id));
