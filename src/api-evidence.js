import { validateURL } from './network.js';

// Evidence is collected from documents, never from a proposed plan. Preserve
// hrefs separately: their host often is not present in the visible link label.
function publicURL(value, base) {
  try {
    const u=validateURL(new URL(value,base).href);
    if([...u.searchParams.keys()].some(k=>/^(api[_-]?key|access_token|token|password|secret|signature)$/i.test(k)))return null;
    return u;
  } catch { return null; }
}
export function apiEvidence(source) {
  const pages=new Set([source.url,...(source.pages||[]).map(p=>p.url)]),found=new Map();
  const add=(value,from,kind,method,methodEvidence)=>{
    if(!pages.has(from))return;
    const u=publicURL(value,from);if(!u)return;
    const key=u.href+'\n'+from;
    if(!found.has(key)||method&&!found.get(key).method)found.set(key,{url:u.href,from,kind,...(method?{method,methodEvidence}: {})});
  };
  for(const item of source.apiEvidence||[])add(item.url,item.from,item.kind,item.method,item.methodEvidence);
  for(const link of source.links||[]){
    if(!link.navigation&&!link.manual&&!link.embedded)add(link.url,link.from||source.url,link.requestMethod?'request-example':'document-link',link.requestMethod,link.methodEvidence);
  }
  for(const match of (source.text||'').matchAll(/https?:\/\/[^\s<>"'`\\)\]}]+/gi))add(match[0].replace(/[.,;]+$/,''),source.url,'document-text');
  return [...found.values()];
}
export function observedApiOrigin(value, source) {
  const target=publicURL(value);if(!target)return false;
  if(apiEvidence(source).some(item=>new URL(item.url).origin===target.origin))return true;
  // Some references specify a bare host instead of an absolute URL. Match a
  // whole token, not a hostname hidden in a longer domain, email, or URL path.
  const plain=(source.text||'').replace(/https?:\/\/[^\s<>"'`]+/gi,'');
  return plain.split(/[\s<>"'`()\[\]{},;|]+/).some(token=>{
    if(token!==target.host&&token!==target.host+'/')return false;
    return true;
  });
}
