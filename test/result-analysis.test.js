import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {profileResponse,analysisContext} from '../src/analysis-data.js';
import {renderAnalysisView} from '../src/result-components.js';

const run={id:'now',jobId:'tool',version:'v1',goalVersion:0,state:'succeeded',input:{latitude:37},output:{},environment:{runtime:'node'}};
const context=output=>analysisContext({run:{...run,output},capability:'시간별 기온 확인'});
const view={question:'기온의 변화와 결측 구간을 확인할 수 있나요?',rationale:'실제 시간축과 기온 분포를 함께 봅니다.',focus:'trend',evidence:[{label:'평균 기온',source:'current',path:'/hourly/temp',stat:'mean',field:'',unitPath:'/units/temp'}],blocks:[{type:'series',title:'기온 변화',reason:'시간별 변화를 확인합니다.',source:'current',path:'/hourly',x:'/time',columns:[{path:'/temp',label:'기온',unitPath:'/units/temp'}],comparePath:''}],unknowns:['예보 정확도는 실제 관측과 대조하지 않았습니다.']};
const weather={hourly:{time:['2026-09-19T01:00','2026-09-19T02:00','2026-09-19T04:00','2026-09-19T08:00'],temp:[0,null,30,10]},units:{temp:'°C'}};

test('profiles inspect every row, retain tail outliers, missing values and numeric zeros',()=>{
  const values=Array.from({length:600},(_,i)=>({n:i<599?0:1200}));values[100].n=null;values[300]={};
  const profile=profileResponse({values}),stats=profile.arrays[0].fields[0];
  assert.equal(stats.count,600);assert.equal(stats.missing,2);assert.equal(stats.numeric,598);assert.equal(stats.max,1200);assert.equal(stats.min,0);assert.equal(stats.sum,1200);assert.equal(stats.mean,1200/598);
  assert.equal(profile.omittedStructure,false);
  assert.equal(profileResponse(Object.fromEntries(Array.from({length:30},(_,i)=>['a'+i,[i]]))).omittedStructure,true);
});

test('trusted time series includes full statistics, numeric scale and disconnected missing values',()=>{
  const result=renderAnalysisView(view,{current:weather,input:run.input},context(weather)),dom=load(result.html);
  assert.equal(result.quality.status,'grounded');assert.equal(dom('[data-result-series]').length,1);
  const series=JSON.parse(dom('[data-result-series]').attr('data-result-series'));assert.deepEqual(series.lines[0].values,[0,null,30,10]);
  assert.equal(dom('svg path').attr('d').match(/ M/g).length,2);assert.equal(dom('input[type=range]').length,2);
  assert.match(dom('.metric').text(),/13\.33/);assert.match(dom('body').text(),/목적 충족 · 미확인/);assert.equal(dom('script,iframe,style[onload]').length,0);
});

test('unresolved bindings and conflicting units cannot pass view quality checks',()=>{
  const invalid={...view,evidence:[{...view.evidence[0],path:'/invented'}],blocks:[{...view.blocks[0],columns:[...view.blocks[0].columns,{path:'/wind',label:'풍속',unitPath:'/units/wind'}]}]};
  const output={...weather,hourly:{...weather.hourly,wind:[1,2,3,4]},units:{temp:'°C',wind:'m/s'}};
  const result=renderAnalysisView(invalid,{current:output},context(output));assert.equal(result.quality.status,'limited');assert.equal(result.quality.checks.evidenceResolved,0);assert.equal(result.quality.checks.componentsRendered,0);assert.match(result.html,/단위가 다른/);assert.ok(!result.html.includes('<svg'));
});

test('comparisons disclose changed inputs and suppress arithmetic for different units or tools',()=>{
  const current={...run,output:{value:20,unit:'°C'}},previous={...run,id:'before',input:{latitude:30},output:{value:10,unit:'°F'}};
  const design={...view,focus:'comparison',evidence:[{...view.evidence[0],path:'/value',stat:'value'}],blocks:[{type:'comparison',title:'이전과 이번',reason:'변경한 입력에서 반환된 수치를 확인합니다.',source:'current',path:'',x:'',columns:[{path:'/value',label:'기온',unitPath:'/unit'}],comparePath:''}]};
  const ctx=analysisContext({run:current,previous,capability:'날씨'}),sources={current:current.output,previous:previous.output};
  const result=renderAnalysisView(design,sources,ctx);assert.match(result.html,/입력·옵션 변경/);assert.match(result.html,/직접 비교 보류/);assert.match(result.html,/latitude/);assert.match(result.html,/°F/);
  assert.equal(analysisContext({run:current,previous:{...previous,jobId:'other'}}).comparison.arithmeticAllowed,false);
});

test('media binds only verified local artifacts and escapes every model and data label',()=>{
  const data={image:{artifactId:'result',mime:'image/png'}},input={image:{artifactId:'original'}};
  const design={...view,focus:'media',question:'<script>bad()</script>',evidence:[{...view.evidence[0],source:'input',path:'/image/artifactId',stat:'value'}],blocks:[{type:'media',title:'이미지 경계',reason:'원본과 결과를 같은 배율로 확인합니다.',source:'current',path:'/image',x:'',columns:[],comparePath:'/image'}]};
  const result=renderAnalysisView(design,{current:data,input},context(data),{mediaURL:f=>'/api/evaluations/e/files/'+f.artifactId+'/preview'}),dom=load(result.html);
  assert.equal(dom('img').length,2);assert.equal(dom('script').length,0);assert.equal(dom('[data-image-zoom]').length,1);assert.match(dom('header').text(),/<script>bad/);
  const expired=renderAnalysisView(design,{current:data,input},context(data),{mediaURL:()=>null});assert.equal(load(expired.html)('img').length,0);assert.match(expired.html,/만료/);
});

test('candidate tables show meaningful scalar columns and search scope without nested object dumps',()=>{
  const output={items:Array.from({length:550},(_,i)=>({name:i===2?'<img src=x onerror=alert(1)>':'repo-'+i,stars:i,owner:{url:'private-metadata'},url:'javascript:alert(1)'}))};
  const design={...view,focus:'candidates',evidence:[{...view.evidence[0],path:'/items',stat:'count'}],blocks:[{type:'table',title:'저장소 후보',reason:'검색한 후보의 이름과 별 수를 확인합니다.',source:'current',path:'/items',x:'',comparePath:'',columns:[{path:'/name',label:'이름',unitPath:''},{path:'/stars',label:'별 수',unitPath:''},{path:'/owner',label:'삭제되어야 하는 객체',unitPath:''}]}]};
  const result=renderAnalysisView(design,{current:output},context(output)),dom=load(result.html);
  assert.equal(dom('tbody tr').length,500);assert.equal(dom('th').length,2);assert.equal(dom('img,script').length,0);assert.match(dom('tbody').text(),/<img src=x/);assert.match(result.html,/검색은 표시된 500개/);assert.ok(!result.html.includes('private-metadata'));
});

test('a tiny overview over a substantial list is marked limited rather than passing quality',()=>{
  const design={...view,focus:'overview',blocks:[],evidence:[{...view.evidence[0],path:'/items',stat:'count'}]},output={items:[1,2,3]};
  assert.equal(renderAnalysisView(design,{current:output},context(output)).quality.status,'limited');
});

test('an actual scalar weather object supports a details table and exact shorthand fields',()=>{
  const output={current:{temperature:24.1,code:2},units:{temp:'°C'}},design={...view,focus:'overview',evidence:[{...view.evidence[0],path:'/current/temperature',stat:'value'}],blocks:[{type:'table',title:'현재 날씨',reason:'기온과 상태 확인',source:'current',path:'/current',x:'',comparePath:'',columns:[{path:'temperature',label:'기온',unitPath:'/units/temp'},{path:'./code',label:'날씨 코드',unitPath:''}]}]};
  const result=renderAnalysisView(design,{current:output},context(output));assert.equal(result.quality.status,'grounded');const dom=load(result.html);assert.equal(dom('tbody tr').length,2);assert.match(dom('table').text(),/24\.1 °C/);assert.equal(dom('input[type=search]').length,0);
});
