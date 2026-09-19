import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateURL,safeRequest} from '../src/network.js';
import {validatePlan} from '../src/contracts.js';
import {apiAccessOffer,approveApiAccess} from '../src/api-access.js';
import {buildApiRequest,redactApiSecrets} from '../src/api-request.js';

const plan=()=>({kind:'api',supported:true,title:'공개 데이터',runtime:'none',hasUI:false,files:[],install:[],start:'',adapter:'',database:{kind:'none'},endpoint:{url:'http://openapi.seoul.go.kr:8088/{apiKey}/json/CardSubwayStatsNew/1/5/{date}',method:'GET',readOnly:true},auth:{kind:'path',name:'apiKey',issueUrl:'https://data.seoul.go.kr/guide',docsUrl:'https://data.seoul.go.kr/guide'},fields:[{name:'date',label:'날짜',type:'text',required:true,location:'path'}]});
const source={kind:'api',text:'http://openapi.seoul.go.kr:8088 https://data.seoul.go.kr/guide'};

test('public HTTP and HTTPS URLs retain explicit ports while private and credential-bearing authorities stay blocked',async()=>{
  for(const url of ['http://openapi.seoul.go.kr:8088/sample/json/test','https://api.example.com:8443/data','http://api.example.com:3001'])assert.equal(validateURL(url).origin,new URL(url).origin);
  for(const url of ['http://localhost:8088','http://10.0.0.1:8088','http://169.254.169.254:8088','http://user:password@api.example.com:8088','ftp://example.com:8088','http://example.com:0'])assert.throws(()=>validateURL(url));
  await assert.rejects(safeRequest('http://openapi.seoul.go.kr:8089/sample',{allowedOrigin:'http://openapi.seoul.go.kr:8088'}),/허용되지/);
});

test('HTTP path authentication is an executable plan with a separate credential, never an ordinary field',()=>{
  assert.equal(validatePlan(plan(),source).auth.kind,'path');
  for(const url of ['http://openapi.seoul.go.kr:8088/apiKey/json/test','http://openapi.seoul.go.kr:8088/{apiKey}/json/{apiKey}','http://openapi.seoul.go.kr:8088/prefix-{apiKey}/json','http://openapi.seoul.go.kr:8088/data?key={apiKey}'])assert.throws(()=>validatePlan({...plan(),endpoint:{...plan().endpoint,url}},source),{code:'INVALID_PLAN'});
  assert.throws(()=>validatePlan({...plan(),fields:[...plan().fields,{name:'apiKey'}]},source),{code:'INVALID_PLAN'});
});

test('HTTP credential transmission requires its own explicit confirmation, bound to endpoint and port',()=>{
  const offer=apiAccessOffer(plan(),{}),input={scope:offer.scope,callLimit:20,acknowledged:true};
  assert.equal(offer.requiresHttpConsent,true);assert.equal(offer.origin,'http://openapi.seoul.go.kr:8088');
  assert.throws(()=>approveApiAccess(offer,input),{code:'HTTP_AUTH_CONFIRMATION_REQUIRED'});
  const consent=approveApiAccess(offer,{...input,httpAcknowledged:true});assert.equal(consent.allowHttpAuth,true);
  const https=apiAccessOffer({...plan(),endpoint:{...plan().endpoint,url:plan().endpoint.url.replace('http:','https:')}},{});assert.equal(https.requiresHttpConsent,false);assert.notEqual(https.scope,offer.scope);
  assert.throws(()=>buildApiRequest(plan(),{date:'20220301'},'sample'),{code:'HTTP_AUTH_CONFIRMATION_REQUIRED'});
});

test('path keys are encoded once at invocation, do not change origin and are absent from the stored plan',()=>{
  const p=plan(),before=JSON.stringify(p),key='private/key +?#%한글';
  const req=buildApiRequest(p,{date:'20220301'},key,{allowHttpAuth:true});
  assert.equal(new URL(req.url).origin,'http://openapi.seoul.go.kr:8088');assert.equal(new URL(req.url).pathname.split('/')[1],encodeURIComponent(key));assert.equal(new URL(req.url).search,'');assert.equal(req.redirects,0);assert.equal(req.headers.appKey,undefined);assert.equal(JSON.stringify(p),before);
  assert.throws(()=>buildApiRequest(p,{date:'20220301'},'..',{allowHttpAuth:true}),/형식/);
  const echoed=redactApiSecrets({url:req.url,error:'echo '+key,nested:{[key]:encodeURIComponent(key)}},key);assert.ok(!JSON.stringify(echoed).includes(key));assert.ok(!JSON.stringify(echoed).includes(encodeURIComponent(key)));
});

test('existing bearer, header and query authentication remains compatible with port-specific HTTPS endpoints',()=>{
  for(const kind of ['header','query','bearer']){
    const p={...plan(),endpoint:{...plan().endpoint,url:'https://api.example.com:8443/search'},fields:[],auth:{kind,name:'appKey'}};
    const req=buildApiRequest(p,{},'private-key');assert.equal(req.allowedOrigin,'https://api.example.com:8443');
    assert.equal(kind==='query'?new URL(req.url).searchParams.get('appKey'):req.headers[kind==='bearer'?'Authorization':'appKey'],kind==='bearer'?'Bearer private-key':'private-key');
  }
});
