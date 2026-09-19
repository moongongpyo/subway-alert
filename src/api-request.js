import { validateURL } from './network.js';

const segment=value=>encodeURIComponent(String(value)).replace(/\./g,'%2E');
// Secrets are injected only at the last request boundary, never into the plan,
// source document, input examples or generated files.
export function buildApiRequest(plan,input,key='',{allowHttpAuth=false}={}) {
  const target=validateURL(plan.endpoint.url),auth=plan.auth;
  if(auth.kind!=='none'&&!key)throw new Error('API 키 연결이 필요합니다.');
  if(auth.kind!=='none'&&target.protocol==='http:'&&!allowHttpAuth)throw Object.assign(new Error('HTTP 인증키 전송 확인이 필요합니다.'),{code:'HTTP_AUTH_CONFIRMATION_REQUIRED'});
  let address=plan.endpoint.url;const payload={},headers={Accept:'application/json, text/plain, image/*'};
  for(const f of plan.fields){
    const value=input[f.name];if(value===undefined){if(f.required)throw new Error(`${f.label} 입력이 필요합니다.`);continue;}
    if(f.location==='path')address=address.replaceAll(`{${f.name}}`,segment(value));
    else if(f.location==='body')payload[f.name]=value;
  }
  if(auth.kind==='path'){
    const placeholder=`{${auth.name}}`;
    if(address.split(placeholder).length!==2)throw new Error('경로 인증키의 위치를 확인할 수 없습니다.');
    // Dot-only values are normalized by URL parsers even when percent encoded.
    if(key==='.'||key==='..')throw new Error('경로 인증키 형식이 올바르지 않습니다.');
    address=address.replace(placeholder,()=>segment(key));
  }
  const url=validateURL(address);
  if(url.origin!==target.origin)throw new Error('허용되지 않은 API 대상입니다.');
  for(const f of plan.fields)if(f.location==='query'&&input[f.name]!==undefined)url.searchParams.set(f.name,String(input[f.name]));
  if(auth.kind==='query')url.searchParams.set(auth.name,key);
  else if(auth.kind!=='none'&&auth.kind!=='path')headers[auth.kind==='bearer'?'Authorization':auth.name]=auth.kind==='bearer'?`Bearer ${key}`:key;
  let body;if(plan.endpoint.method==='POST'){headers['Content-Type']='application/json';body=JSON.stringify(payload);}
  return {url:url.href,method:plan.endpoint.method,headers,body,allowedOrigin:target.origin,redirects:0};
}

export function redactApiSecrets(value,key){
  const variants=key?[...new Set([key,encodeURIComponent(key),segment(key),new URLSearchParams({k:key}).toString().slice(2)])]:[];
  const hide=text=>variants.reduce((s,k)=>s.split(k).join('[숨김]'),text);
  const walk=v=>typeof v==='string'?hide(v):Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,a])=>[hide(k),/^(authorization|password|secret|token|api[_-]?key|access_token)$/i.test(k)?'[숨김]':walk(a)])):v;
  return walk(value);
}
