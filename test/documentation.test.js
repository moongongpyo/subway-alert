import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectDocumentation,documentationURL,extractDocument,recoverDocumentation} from '../src/documentation.js';
import {analyze} from '../src/analyze.js';

function source(pages){
  const calls=[];
  return {calls,request:async(url,options={})=>{
    calls.push({url,options});const page=pages[url];if(!page)throw new Error('Missing fixture '+url);
    const [body,type='text/html',status=200]=Array.isArray(page)?page:[page];
    return {url,status,headers:{'content-type':type},body:Buffer.from(body)};
  }};
}
const home='https://docs.example.com/';
test('recovery reads observed references and dynamic tabs without executing request examples or widening crawling',async()=>{
  const reference=home+'reference',endpoint='https://api.example.com/v1/weather?latitude=1';
  const before={kind:'api',url:home,text:'Product introduction',pages:[{url:home,via:'HTML'}],links:[{url:reference,title:'HTTP request reference',from:home},{url:endpoint,title:'Open in new tab',from:home,requestMethod:'GET'},{url:home+'unrelated',title:'Other product',from:home}],images:[]};
  const f=source({[home]:'<main>Weather API description</main>',[reference]:`<main>GET ${endpoint}<a href="/unbounded/reference">Next reference</a></main>`});
  let renders=0;const recovered=await recoverDocumentation(before,'HTTP 메서드가 없음',()=>{},{request:f.request,render:async()=>{renders++;return {warnings:[],documents:[{url:home,html:`<main>${'Weather reference '.repeat(10)}<div>GET ${endpoint}</div></main>`,label:'탭: 호출 방법'}]};}});
  assert.deepEqual(f.calls.map(c=>c.url),[home,reference]);assert.equal(renders,1);assert.match(recovered.text,/GET https/);assert.equal(recovered.url,home);assert.ok(recovered.pages.some(p=>p.url===reference));
});
test('follows navigation and linked specification, preserving endpoint and authentication evidence',async()=>{
  const f=source({[home]:'<nav><a href="/guide">개발 가이드</a></nav><main>제품 소개</main>',
    [home+'guide']:'<main>빠른 시작 <a href="/reference">API 명세</a></main>',
    [home+'reference']:'<redoc spec-url="/openapi.json"></redoc>',
    [home+'openapi.json']:[JSON.stringify({openapi:'3.1.0',info:{title:'Example'},servers:[{url:'https://api.example.com'}],paths:{'/items':{get:{parameters:[{name:'query',in:'query',required:true}]}}},components:{securitySchemes:{key:{type:'apiKey',in:'header',name:'appKey'}}}}),'application/json']});
  let tools=0,pages=0;const doc=await collectDocumentation(home,()=>tools++,{request:f.request,render:null,onPage:()=>pages++});
  assert.equal(pages,4);assert.equal(tools,4);assert.match(doc.text,/appKey/);assert.match(doc.text,/\/items/);assert.ok(doc.text.startsWith('SOURCE '+home+'openapi.json'));assert.equal(doc.images.length,0);
});

test('API URL headings preserve following addresses and required parameters in long documents',async()=>{
  const raw='<main><p>'+('Introduction '.repeat(1500))+'</p><h2>API URL</h2><p>https://api.example.com/search</p><p>Post Method</p><h3>Header</h3><p>appKey 필수</p><p>startX 필수</p></main><img src="/example.png">';
  const f=source({[home]:raw});const doc=await collectDocumentation(home,()=>{},{request:f.request,render:null,limits:{text:5000}});
  assert.match(doc.text,/https:\/\/api.example.com\/search/);assert.match(doc.text,/startX/);assert.equal(doc.images.length,0);assert.equal(f.calls.length,1);
});

test('hidden panels, iframe and Swagger links remain discoverable',()=>{
  const doc=extractDocument('<nav><a href="/docs">Docs</a></nav><main><div hidden>GET https://api.example.com/a</div><iframe src="/reference"></iframe></main><script>SwaggerUIBundle({url:"/schema.yaml"})</script>',home);
  assert.match(doc.text,/GET https/);assert.equal(doc.links.length,3);assert.ok(doc.links.some(l=>l.url===home+'schema.yaml'));
});

test('hidden error main elements cannot replace the visible dataset or poison fallback text',()=>{
  const errors='<div style="display: none;"><main><h1>URL 오류 안내</h1><p>'+('해당 URL은 잘못된 URL입니다. '.repeat(8))+'</p></main></div>';
  const body='<h1>알림 API</h1><p>'+('현재 서비스의 실제 설명입니다. '.repeat(8))+'</p><div role="tabpanel" hidden>GET https://api.example.com/notices</div>';
  for(const html of [errors+'<section class="main-content">'+body+'</section>',body+errors]){
    const doc=extractDocument(html,home);assert.match(doc.text,/현재 서비스의 실제 설명/);assert.match(doc.text,/GET https/);assert.doesNotMatch(doc.text,/URL 오류|잘못된 URL/);
  }
});

test('Seoul dataset reads its observed API tab before global navigation and retains manual key issuing evidence',async()=>{
  const url='https://data.seoul.go.kr/dataList/OA-22718/A/1/datasetView.do',tab='https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-22718&srvType=A',guide='https://data.seoul.go.kr/together/guide/useGuide.do',issue='https://data.seoul.go.kr/together/mypage/actkeyReq_ss.do';
  const html=`<title>서울 열린데이터광장</title><nav><a href="/dataVisual/seoul/guide.do">서울 실시간 도시데이터</a><a href="${guide}">Open API 소개</a></nav>
    <section class="main-content"><h1 class="main-content-tit">서울시 교통공사 지하철 알림정보 현황</h1><p>${'지하철 알림정보를 제공합니다. '.repeat(12)}</p><input id="infId" value="OA-22718"><button onclick="dataSetView('OA-22718','A', 1)">Open API</button></section>
    <script>function dataSetView(infId,srvType){var srvName="/dataList/openApiView.do?infId="+infId;srvName+="&srvType="+srvType;}</script>
    <div style="display:none"><main>${'URL 오류 안내 '.repeat(30)}</main></div>`;
  const f=source({[url]:html,[tab]:`<script>function createActKey(){document.frm.action="${issue}";document.frm.method="get";document.frm.submit();}</script>
    <button onclick="createActKey();">인증키 신청</button><h2>샘플 URL</h2><table><tr><td>샘플 URL</td><td><a href="http://openapi.seoul.go.kr:8088/sample/xml/getNtceList/1/5/">http://openapi.seoul.go.kr:8088/(인증키)/xml/getNtceList/1/5/</a></td></tr></table><p>KEY 필수 TYPE json 지원 SERVICE getNtceList</p>`,
    [guide]:'<p>GET API 요청 방법: 발급한 인증키로 조회합니다.</p><a href="https://tv.seoul.go.kr/video">API 동영상 가이드</a>'});
  const doc=await collectDocumentation(url,()=>{},{request:f.request,render:()=>assert.fail('Observed tab needs no browser')});
  assert.deepEqual(f.calls.map(c=>c.url),[url,tab,guide]);assert.equal(doc.pages[0].title,'서울시 교통공사 지하철 알림정보 현황');
  assert.match(doc.text,/getNtceList/);assert.doesNotMatch(doc.text,/URL 오류 안내|도시데이터/);assert.equal(doc.stats.rendered,0);
  assert.ok(doc.links.some(l=>l.url===issue&&l.manual));assert.ok(f.calls.every(c=>!c.options.method||c.options.method==='GET'));assert.equal(doc.warnings.length,0);
  assert.ok(!extractDocument(html.replaceAll("dataSetView('OA-22718'","dataSetView('OA-99999'"),url).links.some(l=>l.url===tab));
  assert.ok(!extractDocument(html.replace('/dataList/openApiView.do?infId=','/delete?infId='),url).links.some(l=>l.url===tab));
});

test('manual authentication evidence survives navigation-heavy pages without being crawled',async()=>{
  const tab='https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-22718&srvType=A',issue='https://data.seoul.go.kr/together/mypage/actkeyReq_ss.do';
  const f=source({[tab]:'<nav>'+Array.from({length:100},(_,i)=>`<a href="/news/${i}">News ${i}</a>`).join('')+'</nav>'+`<script>function createActKey(){document.frm.action="${issue}";document.frm.method="get";}</script><button onclick="createActKey();">인증키 신청</button><main>GET https://api.example.com/notices ${'API 설명 '.repeat(40)}</main>`});
  const doc=await collectDocumentation(tab,()=>{},{request:f.request,render:null});assert.equal(f.calls.length,1);assert.ok(doc.links.some(l=>l.url===issue));
});

test('SK public CMS directory pauses with observed choices instead of executing a random product',async()=>{
  const url='https://openapi.sk.com/products/detail?svcSeq=60&menuSeq=125',cms='https://openapi.sk.com/products/api/getContents';
  const contents='## 상품 둘러보기\n'+[1,127,2,3].map(n=>`| <a href="/products/detail?linkMenuSeq=${n}">Product ${n}</a> | Description ${n} |`).join('\n');
  const f=source({[url]:'<input id="menuSeq" value="125"><input id="svcSeq" value="60"><iframe></iframe>',[cms]:[JSON.stringify({response:{contentsType:0,contents}}),'application/json']});
  const doc=await collectDocumentation(url,()=>{},{request:f.request,render:()=>assert.fail('Catalog needs no browser')});
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.method,'POST');assert.equal(f.calls[1].options.body,'seq=125');assert.equal(doc.choices.length,4);
  assert.match(doc.choices[0].description,/Description 1$/);assert.doesNotMatch(doc.choices[0].description,/Description 127/);
  await assert.rejects(analyze('job',doc,{ask:()=>assert.fail('Choice needs no model')}),{code:'SOURCE_CHOICE'});
});

test('rendered frames and document tabs contribute evidence and outgoing document links',async()=>{
  const f=source({[home]:'<main>Loading...</main><script src="app.js"></script>',[home+'request']:'<main>API URL https://api.example.com/routes POST method; Header appKey required</main>'});
  const doc=await collectDocumentation(home,()=>{},{request:f.request,render:async()=>({warnings:[],documents:[{url:home,html:'<main>Rendered guide <a href="/request">요청 명세</a></main>',label:'탭: 요청'}]})});
  assert.match(doc.text,/api.example.com\/routes/);assert.ok(doc.pages.some(p=>p.via==='탭: 요청'));assert.equal(doc.stats.rendered,1);
});

test('cycles, failed child pages and request limits do not turn into unbounded crawling',async()=>{
  const f=source({[home]:'<a href="/docs/missing">API 명세</a><a href="/docs/good">API 명세</a>',[home+'docs/good']:'<a href="/">API docs</a><p>GET https://api.example.com/value</p>'});
  const doc=await collectDocumentation(home,()=>{},{request:f.request,render:null});assert.equal(f.calls.length,3);assert.match(doc.text,/api.example.com\/value/);assert.match(doc.warnings.join(' '),/Missing fixture/);
  const capped=await collectDocumentation(home,()=>{},{request:f.request,render:null,limits:{requests:1}});assert.equal(capped.stats.requests,1);assert.match(capped.warnings.join(' '),/상한/);
  const controller=new AbortController();controller.abort();await assert.rejects(collectDocumentation(home,()=>{},{request:f.request,signal:controller.signal}),{name:'AbortError'});
});

test('private and credential-bearing document links are excluded',()=>{
  for(const url of ['http://127.0.0.1/','http://169.254.169.254/','file:///etc/passwd','https://name:secret@example.com/','https://docs.example.com/?api_key=secret'])assert.equal(documentationURL(url,home),null);
  assert.equal(documentationURL('/docs',home),home+'docs');
});

test('sparse image documentation is read with bounded images and retains uncertainty as evidence',async()=>{
  const png=Buffer.from([137,80,78,71,13,10,26,10]);const f=source({[home]:'<main>API 사용 문서</main><img src="/logo.png"><img src="/table.png" alt="요청 표">',[home+'table.png']:[png,'image/png']});
  const doc=await collectDocumentation(home,()=>{},{request:f.request,render:null});assert.equal(doc.images.length,1);assert.equal(f.calls.length,2);
  let calls=0;await assert.rejects(analyze('job',doc,{ask:async(_id,_role,_task,context,_schema,options)=>{
    if(!calls++){assert.equal(options.images.length,1);assert.match(options.images[0],/^data:image\/png;base64,/);return {text:'POST https://api.example.com/routes',uncertainties:['인증 이름은 읽을 수 없음']};}
    assert.match(context.text,/POST https/);assert.ok(!JSON.stringify(context).includes('base64,'));return {kind:'insufficient',reason:'인증 근거 없음',choiceIds:[]};
  }}),{code:'DOCUMENTATION_INCOMPLETE'});assert.equal(calls,2);assert.equal(doc.imageRead,true);assert.match(doc.warnings.join(' '),/인증 이름/);
});

test('a generic introduction is incomplete, not a claim of unsupported API',async()=>{
  const doc=await collectDocumentation(home,()=>{},{request:source({[home]:'<main>Welcome to our API product</main>'}).request,render:null});
  await assert.rejects(analyze('job',doc,{ask:async()=>({kind:'insufficient',reason:'호출 명세 없음',choiceIds:[]})}),{code:'DOCUMENTATION_INCOMPLETE'});
  await assert.rejects(analyze('job',doc,{ask:async()=>({kind:'selection',reason:'선택 필요',choiceIds:['invented']})}),{code:'DOCUMENTATION_INCOMPLETE'});
});

test('authentication setup stays in the context when many API references compete for the budget',async()=>{
  const f=source({[home]:'<main>API 안내 '+('제품 소개 '.repeat(70))+'</main><a href="/guide/procedure">API 이용절차</a>'+Array.from({length:8},(_,i)=>`<a href="/docs/${i}">API reference ${i}</a>`).join(''),
    [home+'guide/procedure']:'<main>Sign up to obtain an appKey. <a href="https://accounts.example.com/signup">회원가입</a></main>',
    ...Object.fromEntries(Array.from({length:8},(_,i)=>[home+'docs/'+i,'<main>GET https://api.example.com/value '+('parameter required '.repeat(1000))+'</main>']))});
  const doc=await collectDocumentation(home,()=>{},{request:f.request,render:null});
  assert.equal(f.calls[1].url,home+'guide/procedure');assert.match(doc.text,/Sign up to obtain an appKey/);assert.ok(doc.links.some(l=>l.url==='https://accounts.example.com/signup'));assert.ok(!f.calls.some(c=>c.url.includes('/signup')));
});
