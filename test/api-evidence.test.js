import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiEvidence,observedApiOrigin} from '../src/api-evidence.js';
import {collectDocumentation,extractDocument} from '../src/documentation.js';
import {analyze} from '../src/analyze.js';
import {validatePlan} from '../src/contracts.js';

const docs='https://weather.example.com/en/docs';
const endpoint='https://api.weather.example.com/v1/forecast?latitude=52.52&longitude=13.41';
const plan=()=>({kind:'api',supported:true,endpoint:{url:endpoint,method:'GET',readOnly:true},runtime:'none',hasUI:false,files:[],install:[],start:'',adapter:'',database:{kind:'none'},auth:{kind:'none',name:''},fields:[]});

test('relative endpoint text plus an official example href passes analysis and host verification',async()=>{
  const html=`<nav><a href="/en/docs/other-api">Other Forecast API</a></nav><main><h1>Weather API</h1><p>${'Weather forecast documentation. '.repeat(8)}</p><h2>API URL</h2><p>/v1/forecast</p><p>latitude and longitude are required.</p><a href="${endpoint.replaceAll('&','&amp;')}">Open in new tab</a></main><img src="/chart.png">`;
  const calls=[];const source=await collectDocumentation(docs,()=>{},{request:async url=>{calls.push(url);assert.equal(url,docs);return {url,headers:{'content-type':'text/html'},status:200,body:Buffer.from(html)};},render:null});
  assert.ok(!source.text.includes('api.weather.example.com'));
  assert.ok(source.apiEvidence.some(e=>e.url===endpoint&&e.from===docs&&e.method==='GET'&&e.kind==='request-example'));
  assert.ok(!source.text.includes('GET'));
  assert.deepEqual(calls,[docs]);assert.equal(source.images.length,0);
  let requests=0;
  const result=await analyze('job',source,{ask:async(_id,_role,_prompt,context)=>{
    assert.ok(context.apiEvidence.some(e=>e.url===endpoint&&e.from===docs&&e.method==='GET'));
    return requests++===0?{kind:'api',reason:'Documented GET example',choiceIds:[]}:plan();
  }});
  assert.equal(requests,2);assert.equal(result.endpoint.url,endpoint);
  assert.deepEqual(result.fields.map(f=>f.name),['latitude','longitude']);
});

test('navigation, ordinary documentation and scripted links are not promoted into GET API examples',()=>{
  const doc=extractDocument(`<nav><a href="${endpoint}">Open in new tab</a></nav><main>${'Introduction '.repeat(20)}<a href="/reference">Reference</a><a href="${endpoint}&script=1" onclick="send()">Open in new tab</a><a href="${endpoint}&script=2" data-method="post">Open in new tab</a></main>`,docs);
  assert.ok(apiEvidence(doc).every(e=>!e.method));
});

test('host evidence matches origins exactly and rejects unrelated navigation or invented provenance',()=>{
  const source={kind:'api',url:docs,text:'GET /v1/forecast',pages:[{url:docs}],links:[{url:endpoint,from:docs,navigation:false}]};
  assert.equal(validatePlan(plan(),source).endpoint.url,endpoint);
  for(const url of ['https://api.weather.example.com.attacker.com/v1/forecast','https://api.weather.example.com:8443/v1/forecast','http://api.weather.example.com/v1/forecast'])assert.equal(observedApiOrigin(url,source),false);
  for(const links of [[{url:endpoint,from:docs,navigation:true}],[{url:endpoint,from:'https://unknown.example.com/docs'}]])assert.throws(()=>validatePlan(plan(),{...source,links}),{code:'INVALID_PLAN'});
  for(const text of ['https://attacker.com/api.weather.example.com','https://api.weather.example.com.attacker.com','support@api.weather.example.com','not-api.weather.example.com'])assert.equal(observedApiOrigin(endpoint,{url:docs,text}),false);
  assert.equal(observedApiOrigin(endpoint,{url:docs,text:'Base host: api.weather.example.com'}),true);
});

test('full specification addresses survive text truncation and retain their source page',async()=>{
  const specURL='https://docs.example.com/openapi.json';
  const spec={openapi:'3.1.0',info:{title:'Weather',description:'Long intro '.repeat(3000)},servers:[{url:'https://api.weather.example.com'}],paths:{'/v1/forecast':{get:{}}}};
  const source=await collectDocumentation(specURL,()=>{},{request:async url=>({url,headers:{'content-type':'application/json'},status:200,body:Buffer.from(JSON.stringify(spec))}),limits:{text:1000},render:null});
  assert.ok(!source.text.includes('api.weather.example.com'));
  assert.ok(source.apiEvidence.some(e=>e.url==='https://api.weather.example.com/'&&e.from===specURL));
  assert.equal(observedApiOrigin(endpoint,source),true);
  assert.equal(apiEvidence({url:docs,text:'',links:[{url:'http://127.0.0.1:8000/a',from:docs},{url:'https://api.example.com/?api_key=secret',from:docs}]}).length,0);
});
