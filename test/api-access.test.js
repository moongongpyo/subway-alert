import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiAccessOffer, approveApiAccess, observedAuthURL } from '../src/api-access.js';
import { reserveInvocation } from '../sandbox/usage.mjs';
const plan={endpoint:{url:'https://api.example.com/search',method:'GET'},auth:{kind:'header',name:'appKey'}};

test('model free claims cannot bypass user confirmation and configured rates are optional hints',()=>{
  const offer=apiAccessOffer({...plan,endpoint:{...plan.endpoint,cost:'free'}},{});assert.equal(offer.requestMicros,null);
  assert.equal(apiAccessOffer(plan,{PAID_API_RATES:'broken'}).requestMicros,null);
  assert.equal(apiAccessOffer(plan,{PAID_API_RATES:'{"api.example.com":0.03}'}).requestMicros,30000);
  assert.equal(apiAccessOffer(plan,{FREE_API_HOSTS:' api.example.com '}).requestMicros,0);
  assert.throws(()=>approveApiAccess(offer,{scope:offer.scope,callLimit:10}),{code:'ACCESS_CONFIRMATION_REQUIRED'});
  assert.throws(()=>approveApiAccess(offer,{scope:'stale',callLimit:10,acknowledged:true}),{code:'STALE_CONNECTION'});
  for(const callLimit of [0,1,2,51,4.5,NaN])assert.throws(()=>approveApiAccess(offer,{scope:offer.scope,callLimit,acknowledged:true}),{code:'INVALID_ACCESS'});
  const access=approveApiAccess(offer,{scope:offer.scope,callLimit:10,acknowledged:true});assert.equal(access.requestMicros,null);assert.equal(access.externalMicros,null);assert.equal(access.pricingSource,'unknown');
  assert.notEqual(apiAccessOffer({...plan,auth:{kind:'header',name:'different'}},{}).scope,offer.scope);
});
test('free allowance and metered ceilings require explicit choices with valid bounded values',()=>{
  const offer=apiAccessOffer(plan,{}),input={scope:offer.scope,callLimit:10,acknowledged:true};
  const free=approveApiAccess(offer,{...input,mode:'free'});assert.equal(free.requestMicros,0);assert.equal(free.pricingSource,'user_free_allowance');
  for(const [rateUSD,budgetUSD] of [[0,1],[-1,1],[0.1,0.1],['bad',1],[1,1001]])assert.throws(()=>approveApiAccess(offer,{...input,mode:'metered',rateUSD,budgetUSD}),{code:'INVALID_ACCESS'});
  const paid=approveApiAccess(offer,{...input,mode:'metered',rateUSD:0.01,budgetUSD:0.05});assert.equal(paid.requestMicros,10000);assert.equal(paid.externalMicros,50000);
});
test('shared runtime call cap survives verification, user execution, failed attempts and restart',()=>{
  const cfg={external:40,userRequests:50,callLimit:3,requestMicros:null,externalMicros:null};
  let usage={external:0,userRequests:0,micros:0};usage=reserveInvocation(cfg,usage,'verify');usage=reserveInvocation(cfg,usage,'verify');
  usage=JSON.parse(JSON.stringify(usage));usage=reserveInvocation(cfg,usage,'ready');assert.equal(usage.costUnknown,true);
  for(const phase of ['verify','ready'])assert.throws(()=>reserveInvocation(cfg,usage,phase),{code:'EXTERNAL_CALL_LIMIT'});
  assert.deepEqual([usage.external,usage.userRequests],[2,1]);
});
test('known money ceiling stops before an invocation independently from the call cap',()=>{
  const cfg={external:40,userRequests:50,callLimit:10,requestMicros:20000,externalMicros:40000};let usage={external:0,userRequests:0,micros:0};
  usage=reserveInvocation(cfg,usage,'verify');usage=reserveInvocation(cfg,usage,'verify');assert.throws(()=>reserveInvocation(cfg,usage,'ready'),{code:'EXTERNAL_BUDGET_REQUIRED'});assert.equal(usage.micros,40000);
});
test('guide links can become direct issuing links only when actually observed',()=>{
  const fallback='https://docs.example.com/guide',source={url:fallback,text:'docs',links:[{url:'https://console.example.com/keys'}]};
  assert.equal(observedAuthURL('https://console.example.com/keys',source,fallback),'https://console.example.com/keys');
  assert.equal(observedAuthURL('https://console.example.com/invented',source,fallback),fallback);assert.equal(observedAuthURL('javascript:alert(1)',source,fallback),fallback);
});
