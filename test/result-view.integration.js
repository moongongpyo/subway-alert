import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {analysisContext} from '../src/analysis-data.js';
import {renderAnalysisView} from '../src/result-components.js';

test('script-free result iframe supports chart exploration, candidate search and image zoom without model calls',async t=>{
  const output={hourly:{time:[1,2,3,4],temp:[0,null,30,10]},unit:'°C',items:[{name:'alpha',stars:0},{name:'beta',stars:5}],image:{artifactId:'image'}};
  const run={id:'run',jobId:'job',state:'succeeded',input:{image:{artifactId:'input'}},output};
  const view={question:'변화와 후보를 확인할 수 있나요?',rationale:'실제 값으로 동작하는 검증 화면입니다.',focus:'trend',evidence:[{label:'평균',source:'current',path:'/hourly/temp',stat:'mean',field:'',unitPath:'/unit'}],blocks:[
    {type:'series',title:'시간별 변화',reason:'수치 변화 확인',source:'current',path:'/hourly',x:'/time',columns:[{path:'/temp',label:'기온',unitPath:'/unit'}],comparePath:''},
    {type:'table',title:'후보 목록',reason:'이름으로 후보 확인',source:'current',path:'/items',x:'',columns:[{path:'/name',label:'이름',unitPath:''},{path:'/stars',label:'별 수',unitPath:''}],comparePath:''},
    {type:'media',title:'이미지 확대',reason:'경계 영역을 직접 확인',source:'current',path:'/image',x:'',columns:[],comparePath:'/image'}
  ],unknowns:['실제 처리 정확도는 미확인입니다.']};
  const {html}=renderAnalysisView(view,{current:output,input:run.input},analysisContext({run,capability:'표현 컴포넌트 테스트'}),{mediaURL:()=>'/pixel.png'});
  let calls=0;
  const server=createServer((req,res)=>{
    calls++;
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<iframe id="result" src="/result" sandbox="allow-same-origin" style="width:100%;height:1800px;border:0"></iframe><script type="module" src="/connect.js"></script>');}
    if(req.url==='/connect.js'){res.setHeader('Content-Type','text/javascript');return res.end("import {connectResultInteractions} from '/result-interactions.js';const f=document.querySelector('iframe');f.addEventListener('load',()=>connectResultInteractions(f.contentDocument));if(f.contentDocument?.querySelector('[data-result-series]'))connectResultInteractions(f.contentDocument);");}
    if(req.url==='/result'){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'none'; sandbox allow-same-origin");return res.end(html);}
    if(req.url==='/pixel.png'){res.setHeader('Content-Type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sZkAAAAASUVORK5CYII=','base64'));}
    if(['/result-interactions.js','/analysis-chart.js'].includes(req.url)){res.setHeader('Content-Type','text/javascript');return res.end(readFileSync('public'+req.url));}
    res.writeHead(404).end();
  }).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage({viewport:{width:1080,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);const frame=page.frameLocator('#result');await frame.locator('body[data-connected=true]').waitFor();
  await frame.getByRole('searchbox').fill('beta');assert.equal(await frame.locator('[data-result-table] tbody tr:visible').count(),1);
  const range=frame.locator('[data-range=start]');await range.fill('2');await range.dispatchEvent('input');assert.match(await frame.locator('[data-chart-range]').textContent(),/3 → 4/);
  await frame.locator('[data-line="0"]').uncheck();assert.equal(await frame.locator('svg path').count(),0);
  await frame.locator('[data-image-zoom]').fill('3');await frame.locator('[data-image-zoom]').dispatchEvent('input');assert.equal(await frame.locator('img').first().evaluate(n=>n.style.width),'300%');
  const before=calls;await frame.getByRole('searchbox').fill('alpha');await frame.locator('[data-line="0"]').check();await page.waitForTimeout(50);assert.equal(calls,before);
  await page.setViewportSize({width:390,height:844});assert.equal(await frame.locator('body').evaluate(n=>n.scrollWidth<=n.ownerDocument.documentElement.clientWidth),true);
  assert.deepEqual(errors,[]);
});
