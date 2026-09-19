import { hash } from './store.js';
import { fail } from './config.js';

// Pricing hints are optional. Unknown hosts continue through user connection,
// never through a claim by the model that an API is free.
export function apiAccessOffer(plan, env=process.env) {
  const endpoint=new URL(plan.endpoint.url),host=endpoint.hostname;
  const free=new Set(['api.github.com','jsonplaceholder.typicode.com','pokeapi.co','api.open-meteo.com','dog.ceo','catfact.ninja',...(env.FREE_API_HOSTS||'').split(',').map(s=>s.trim()).filter(Boolean)]);
  let rates={};try{rates=JSON.parse(env.PAID_API_RATES||'{}');}catch{}
  const rate=rates?.[host];
  const requestMicros=free.has(host)?0:typeof rate==='number'&&Number.isFinite(rate)&&rate>=0?Math.ceil(rate*1e6):null;
  return {scope:hash({url:plan.endpoint.url,method:plan.endpoint.method,auth:{kind:plan.auth.kind,name:plan.auth.name}}),host,origin:endpoint.origin,requiresHttpConsent:endpoint.protocol==='http:'&&plan.auth.kind!=='none',requestMicros,defaultLimit:20,maxLimit:50};
}

export function approveApiAccess(offer, input={}) {
  if(input.scope!==offer.scope)fail('STALE_CONNECTION','연결 대상이 변경됐습니다. 새 안내를 확인해주세요.',409);
  const callLimit=Number(input.callLimit);
  if(!Number.isInteger(callLimit)||callLimit<3||callLimit>offer.maxLimit)fail('INVALID_ACCESS',`호출 한도는 3~${offer.maxLimit}회로 입력해주세요.`);
  if(input.acknowledged!==true)fail('ACCESS_CONFIRMATION_REQUIRED','호출 조건을 확인한 뒤 연결해주세요.');
  if(offer.requiresHttpConsent&&input.httpAcknowledged!==true)fail('HTTP_AUTH_CONFIRMATION_REQUIRED','이 API는 HTTP로 키를 전송합니다. 연결 화면에서 평문 전송 여부를 확인해주세요.');
  let requestMicros=offer.requestMicros,externalMicros=requestMicros===null?null:requestMicros*callLimit;
  const mode=input.mode||'requests';
  if(mode==='free'){requestMicros=0;externalMicros=0;}
  else if(mode==='metered'){
    const rate=Number(input.rateUSD),budget=Number(input.budgetUSD);
    if(!Number.isFinite(rate)||rate<=0||!Number.isFinite(budget)||budget<=0||rate>1000||budget>1000)fail('INVALID_ACCESS','호출당 최대 비용과 체험 예산을 USD로 입력해주세요. (0 초과, 1,000 이하)');
    requestMicros=Math.ceil(rate*1e6);externalMicros=Math.floor(budget*1e6);
    if(requestMicros*2>externalMicros)fail('INVALID_ACCESS','기능·브라우저 검증에 필요한 최소 2회 호출 예산이 필요합니다.');
  }else if(mode!=='requests')fail('INVALID_ACCESS','호출 조건을 다시 선택해주세요.');
  return {scope:offer.scope,host:offer.host,mode,callLimit,requestMicros,externalMicros,allowHttpAuth:offer.requiresHttpConsent&&input.httpAcknowledged===true,pricingSource:mode==='free'?'user_free_allowance':mode==='metered'?'user_ceiling':requestMicros===null?'unknown':'configured',confirmedAt:Date.now()};
}

// Only observed links can replace the issuing link. Model-generated navigation
// URLs on the same host are not enough evidence.
export function observedAuthURL(value, source, fallback) {
  let u;try{u=new URL(value);if(u.protocol!=='https:'&&u.protocol!=='http:')return fallback;}catch{return fallback;}
  const urls=[source.url,...(source.links||[]).map(l=>l.url),...(source.pages||[]).map(p=>p.url),...(source.text?.match(/https?:\/\/[^\s<>"'\)]+/g)||[])];
  return urls.some(url=>{try{return new URL(url).href===u.href;}catch{return false;}})?u.href:fallback;
}
