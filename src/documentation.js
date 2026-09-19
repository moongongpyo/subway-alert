import {load} from 'cheerio';
import YAML from 'yaml';
import {createHash} from 'node:crypto';
import {safeRequest,validateURL} from './network.js';
import {renderDocumentation} from './docs-browser.js';
import {fail} from './config.js';
import {seoulDocumentation} from './documentation-seoul.js';
import {apiEvidence} from './api-evidence.js';

export const DOCUMENT_LIMITS=Object.freeze({pages:8,depth:3,requests:40,renderedPages:2,images:2,bytes:12_000_000,text:24_000,milliseconds:120_000});
const ignored=/logout|signout|delete|checkout|purchase|payment|cart|privacy|terms|stplat|login|signup|문의|로그인|회원가입|이용약관|개인정보/i;
const relevant=/api|docs?|guide|reference|developer|quick.?start|getting.?started|auth|token|swagger|openapi|spec|endpoint|request|response|example|tutorial|manual|가이드|문서|인증|명세|요청|응답|예제|사용법|개발|시작/i;
const contract=/\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/|\/)|curl\s|(?:base|request|API)\s*url|endpoint|엔드포인트|(?:요청|샘플)\s*(?:URL|주소)|openapi["':\s]+3|swagger["':\s]+2/i;
const fatal=e=>['BUDGET_EXCEEDED','STOPPED','TIME_LIMIT_EXCEEDED'].includes(e.code)||e.name==='AbortError';
const identity=url=>createHash('sha256').update(url).digest('hex').slice(0,16);
const compact=text=>text.replace(/[\t ]+/g,' ').replace(/\n\s*\n/g,'\n\n').trim();
const authentication=/auth|credential|api.?key|appkey|procedure|인증|키 발급|이용절차/i;
export function documentationURL(value,base){
  if(typeof value!=='string'||!value.trim())return null;
  try{const u=validateURL(new URL(value,base).href);if([...u.searchParams.keys()].some(k=>/^(api[_-]?key|access_token|token|password|secret|signature)$/i.test(k)))return null;return u.href;}catch{return null;}
}
function uniqueLinks(links){return [...new Map(links.filter(l=>l.url&&l.title).map(l=>[l.url,l])).values()];}
function linkScore(link,address,depth){
  if(!link.url||link.manual||link.example||link.requestMethod||/\bvideo\b|동영상/i.test(link.title)||ignored.test(link.title+' '+new URL(link.url).pathname)||/\.(png|jpg|jpeg|gif|webp|svg|zip|exe)(?:\?|$)/i.test(link.url))return 0;
  const target=new URL(link.url),hint=link.title+' '+target.pathname+target.search;
  if(link.navigation&&!/\bapi\b|openapi|docs?|guide|reference|developer|quick.?start|auth|swagger|spec|가이드|문서|인증|명세|이용안내|이용절차/i.test(link.title))return 0;
  return (link.embedded?100:0)+(/openapi|swagger|\.ya?ml|\.json/i.test(hint)?75:0)+(relevant.test(hint)?35:0)+(authentication.test(hint)?40:0)+(/reference|endpoint|\/docs\/|요청|응답|명세|API 목록|공식.*문서/i.test(hint)?25:0)+(target.origin===new URL(address).origin?12:0)-(/pricing|\/calc|요금|가격/i.test(hint)?60:0)-depth*5;
}
function meaningful(text,limit){
  if(text.length<=limit)return text;
  const lines=text.split('\n'),indexes=new Set();
  lines.forEach((line,i)=>{if(contract.test(line)||/header|parameter|appkey|authorization|bearer|필수|파라미터/i.test(line))for(let n=Math.max(0,i-1);n<=Math.min(lines.length-1,i+5);n++)indexes.add(n);});
  const key=[...indexes].sort((a,b)=>a-b).map(i=>lines[i].slice(0,600));
  return (text.slice(0,Math.floor(limit*.55))+'\n[주요 호출·인증 근거]\n'+key.join('\n').slice(0,Math.floor(limit*.44))).slice(0,limit);
}
export function extractDocument(raw,url,{markdown=false,title='',via='HTML'}={}){
  const $=load(raw);const links=[];
  const hidden=e=>$(e).parents().addBack().toArray().some(parent=>$(parent).attr('hidden')!==undefined||$(parent).attr('aria-hidden')==='true'||/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test($(parent).attr('style')||''));
  // Hidden error/closed-service shells are not the current document. Keep hidden
  // ordinary tab panels, which often contain the actual API reference.
  const candidates='main,article,[role="main"],#markdownViewer,.markdown-body,.theme-doc-markdown,.main-content';
  const primary=$(candidates).filter((_i,e)=>!hidden(e)&&compact($(e).text()).length>100).first();
  // Discover navigation before stripping chrome; hidden tab panels remain readable.
  $('a[href],iframe[src],link[rel="alternate"]').each((_i,e)=>{const node=$(e),href=node.attr('href')||node.attr('src');if(!href||href.startsWith('#'))return;
    const line=markdown?raw.split('\n').find(line=>line.includes('"'+href+'"')||line.includes("'"+href+"'"))||'':'';
    const label=compact(node.text()||node.attr('title')||node.attr('aria-label')||href),description=compact(node.closest('tr,li').text()||line.replace(/<[^>]+>/g,' ').replace(/\|/g,' '));
    const address=documentationURL(href,url),navigation=!!primary.length&&!node.closest(primary).length||!!node.closest('nav,header,footer,[role="navigation"],.sitemap-wrap,.type-sitemap').length;
    // A documented request's plain anchor opens via GET, even if the prose
    // never spells out the method. Do not treat navigation or scripted buttons
    // as API calls, and never execute these example links while collecting docs.
    const example=/^https?:\/\//.test(label)&&/sample|example|샘플|예제/i.test(description+' '+href);
    const requestLink=address&&e.tagName==='a'&&!navigation&&!node.attr('onclick')&&!node.attr('data-method')&&!node.attr('data-turbo-method')&&(example||/open in (?:a )?new tab|open api (?:url|request)|sample (?:url|request)|example (?:url|request)|샘플\s*URL|호출\s*예제|요청\s*예제/i.test(label+' '+description))&&new URL(address).pathname!=='/';
    links.push({url:address,title:label.slice(0,140),description:description.slice(0,220),embedded:e.tagName==='iframe',navigation,example,from:url,...(requestLink?{requestMethod:'GET',methodEvidence:'문서의 호출 예제 링크를 브라우저에서 여는 동작은 GET 요청입니다. 실제 API 응답 검증은 별도입니다.'}:{})});});
  const assets=[];$('img').each((_i,e)=>{const node=$(e);assets.push({url:documentationURL(node.attr('src')||node.attr('data-src'),url),alt:node.attr('alt')||'',from:url});});
  if(markdown){for(const match of raw.matchAll(/(!?)\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)){
    const address=documentationURL(match[3],url);if(match[1])assets.push({url:address,alt:match[2],from:url});else links.push({url:address,title:match[2].replaceAll('**','').slice(0,140),description:raw.slice(raw.lastIndexOf('\n',match.index)+1,raw.indexOf('\n',match.index)>0?raw.indexOf('\n',match.index):match.index+250).replace(/<[^>]+>/g,' ').slice(0,260),from:url});
  }}
  // OpenAPI links embedded in Swagger/Redoc configuration are documentation, not executed code.
  $('redoc[spec-url],rapi-doc[spec-url]').each((_i,e)=>links.push({url:documentationURL($(e).attr('spec-url'),url),title:'OpenAPI specification',from:url,embedded:true}));
  $('script').each((_i,e)=>{const script=$(e).text();for(const m of script.matchAll(/(?:url|specUrl|spec-url)\s*[:=]\s*["']([^"']+(?:\.json|\.ya?ml)(?:\?[^"']*)?)["']/gi))links.push({url:documentationURL(m[1],url),title:'OpenAPI specification',from:url,embedded:true});});
  const scripts=$('script').length,blankFrame=$('iframe:not([src])').length>0;
  $('script,style,noscript,header,footer,[role="banner"],[role="contentinfo"]').remove();
  if(!primary.length)$(candidates).filter((_i,e)=>hidden(e)&&!$(e).closest('[role="tabpanel"]').length).remove();
  const root=primary.length?primary:$('body');root.find('nav,[role="navigation"],.sitemap-wrap,.type-sitemap').remove();
  root.find('tr').each((_i,e)=>$(e).append('\n'));root.find('td,th').each((_i,e)=>$(e).append(' | '));
  root.find('h1,h2,h3,h4,p,pre,li,section,div').each((_i,e)=>$(e).append('\n'));
  const text=compact(markdown?raw.replace(/<[^>]+>/g,' '):root.text());
  const seoul=seoulDocumentation(raw,url);
  return {url,title:title||seoul?.title||$('title').text().trim()||$('h1').first().text().trim()||new URL(url).hostname,text,links:uniqueLinks([...links,...(seoul?.links||[])]),images:assets.filter(i=>i.url),via,needsBrowser:!markdown&&(blankFrame||scripts>0&&!contract.test(text))};
}
function catalogChoices(doc){
  if(contract.test(doc.text)||!/(상품 둘러보기|분야별 상품|상품 및 서비스 목록|API (?:directory|catalog|marketplace)|browse (?:our )?(?:products|apis))/i.test(doc.text))return [];
  const candidates=doc.links.filter(l=>!ignored.test(l.title+' '+l.url)&&!/^\[?상품 사용하기/.test(l.title)&&l.description&&l.description!==l.title);
  return candidates.length>=4?candidates.slice(0,24).map(l=>({id:identity(l.url),url:l.url,title:l.title,description:l.description,from:l.from})):[];
}
function hasEndpoint(doc){
  return contract.test(doc.text)&&apiEvidence({...doc,pages:[doc]}).some(e=>{
    const u=new URL(e.url);return u.pathname!=='/'&&(/\/(?:v\d+|api)\//i.test(u.pathname)||u.search);
  });
}
function imageMime(bytes){if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(bytes[0]===255&&bytes[1]===216)return 'image/jpeg';if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return 'image/gif';if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';return null;}

export async function collectDocumentation(url,tool=()=>{},{signal,onProgress=()=>{},onPage=()=>{},request=safeRequest,render=renderDocumentation,limits={},additionalURLs=[],forceRender=false}={}){
  const cap={...DOCUMENT_LIMITS,...limits},inputURL=validateURL(url).href;
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(cap.milliseconds)]):AbortSignal.timeout(cap.milliseconds);
  const pages=[],warnings=[],links=new Map(),visited=new Set(),queue=[{url:inputURL,depth:0,score:100,title:'입력한 문서'}],images=[];
  for(const link of additionalURLs.slice(0,3)){const address=documentationURL(link.url,inputURL);if(address&&address!==inputURL)queue.push({url:address,title:link.title||'보완 문서',depth:1,score:90});}
  let requests=0,bytes=0,rendered=0,choices=[],rootDirect=false,rootSpec=false;
  const notify=message=>onProgress({message,pages:pages.map(({url,title,via})=>({url,title,via})),requests,rendered,images:images.length,warnings:[...new Set(warnings)].slice(-8)});
  const read=async(address,options={})=>{
    bounded.throwIfAborted();if(requests>=cap.requests||bytes>=cap.bytes)fail('DOCUMENT_LIMIT','문서 탐색 요청·용량 상한에 도달했습니다.');requests++;tool();
    const r=await request(address,{signal:bounded,timeout:15_000,...options,maxBytes:Math.min(options.maxBytes||2_000_000,cap.bytes-bytes)});bytes+=r.body.length;
    if(r.status>=400)fail('SOURCE_UNAVAILABLE',`HTTP ${r.status}: ${new URL(address).hostname}`);return r;
  };
  const add=(doc,depth)=>{
    const key=doc.url+'\n'+doc.text.slice(0,200);if(pages.some(p=>p.key===key))return;
    pages.push({...doc,key,depth});onPage();
    for(const link of doc.links){if(link.url&&!links.has(link.url))links.set(link.url,{...link,id:identity(link.url)});}
    notify(`문서 ${pages.length}개 확인 · ${doc.title.slice(0,75)}`);
  };
  while(queue.length&&pages.length<cap.pages){
    bounded.throwIfAborted();queue.sort((a,b)=>b.score-a.score);const next=queue.shift();if(visited.has(next.url))continue;visited.add(next.url);
    notify(`연결 문서를 읽고 있어요 · ${next.title.slice(0,70)}`);
    try{
      const response=await read(next.url),address=response.url||next.url,raw=response.body.toString();visited.add(address);
      let spec;try{if(/json|ya?ml/.test(response.headers['content-type']||'')||/^\s*[\[{]|^openapi:|^swagger:/.test(raw)){const parsed=YAML.parse(raw,{maxAliasCount:20});if(parsed?.openapi||parsed?.swagger)spec=parsed;}}catch{}
      if(spec){add({url:address,title:spec.info?.title||'OpenAPI specification',text:JSON.stringify(spec,null,2),links:[],images:[],via:'OpenAPI'},next.depth);if(next.depth===0)rootSpec=true;continue;}
      if(next.depth===0&&(response.headers['content-type']||'').includes('json')){rootDirect=true;add({url:address,title:'직접 API 응답',text:`Direct GET endpoint ${address}\nObserved HTTP ${response.status}\nResponse: ${raw.slice(0,12000)}`,links:[],images:[],via:'JSON'},0);break;}
      if(/application\/pdf/.test(response.headers['content-type']||'')){warnings.push('PDF 본문은 아직 자동 해석하지 못했습니다: '+address);continue;}
      let doc=extractDocument(raw,address,{markdown:/\.(md|mdx|rst|txt)(?:\?|$)/i.test(address)||/text\/plain|markdown/.test(response.headers['content-type']||'')});
      // SK's public CMS serves its documentation using a POST read, not an HTML iframe src.
      // This narrow adapter permits only that observed, read-only endpoint and numeric menu id.
      if(new URL(address).hostname==='openapi.sk.com'&&new URL(address).pathname==='/products/detail'){
        const $=load(raw),seq=$('#menuSeq').val(),svc=$('#svcSeq').val();
        if(/^\d+$/.test(seq||'')){
          const r=await read('https://openapi.sk.com/products/api/getContents',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest'},body:`seq=${seq}`,allowedOrigin:'https://openapi.sk.com'});
          const data=JSON.parse(r.body.toString()).response;
          if(data?.contents){doc=extractDocument(data.contents,address,{markdown:data.contentsType===0,title:doc.title,via:'동적 문서 본문'});doc.needsBrowser=false;}
          if(data?.contentsUrl)doc.links.unshift({url:documentationURL(data.contentsUrl,address),title:'공식 상세 문서',from:address,embedded:true});
          if(data?.homepageUrl)doc.links.push({url:documentationURL(data.homepageUrl,address),title:data.homepageNm||'공식 개발자 문서',from:address});
          const menus=[...raw.matchAll(/(?:["']?)(\d+)(?:["']?)\s*:\s*\{\s*linkType:\s*\d+,\s*menuName:\s*"([^"]+)"/g)];
          for(const m of menus)if(relevant.test(m[2])&&!ignored.test(m[2])&&/^\d+$/.test(svc||''))doc.links.push({url:`https://openapi.sk.com/products/detail?svcSeq=${svc}&menuSeq=${m[1]}`,title:m[2],from:address});
        }
      }
      const rootChoices=catalogChoices(doc);
      if(rootChoices.length){add(doc,next.depth);choices=rootChoices;break;}
      // Prefer already exposed references before spending requests on browser assets.
      const linkedReference=next.depth<cap.depth&&doc.links.some(l=>!visited.has(l.url)&&(l.embedded||doc.text.length>=300)&&linkScore(l,address,next.depth)>=30);
      if((forceRender&&next.depth===0||doc.needsBrowser&&!linkedReference)&&render&&rendered<cap.renderedPages&&cap.requests-requests>4){
        rendered++;notify('브라우저로 동적 본문과 문서 탭을 읽고 있어요');
        try{const result=await render(address,{signal:bounded,request:read,maxRequests:Math.min(20,cap.requests-requests-4),maxBytes:cap.bytes-bytes});warnings.push(...result.warnings);
          for(const renderedDoc of result.documents){
            const expanded=extractDocument(renderedDoc.html,renderedDoc.url,{via:renderedDoc.label});
            if(expanded.text.length>doc.text.length+100||contract.test(expanded.text)||renderedDoc.label.startsWith('탭:')){
              if(expanded.url===doc.url&&renderedDoc.label==='렌더링 본문')doc={...expanded,links:uniqueLinks([...doc.links,...expanded.links])};else if(pages.length<cap.pages-1)add(expanded,next.depth);
            }
            doc.links=uniqueLinks([...doc.links,...expanded.links]);
            doc.images=uniqueLinks([...doc.images,...expanded.images].map(i=>({...i,title:i.alt||i.url})));
            const candidates=catalogChoices(expanded);if(candidates.length)choices=candidates;
          }
        }catch(e){if(fatal(e)||bounded.aborted)throw e;warnings.push('동적 문서 읽기 실패: '+String(e.message).slice(0,200));}
      }
      add(doc,next.depth);if(choices.length)break;
      const concreteReference=hasEndpoint(doc);
      if(next.depth<cap.depth){for(const link of doc.links){
        if(!link.url||visited.has(link.url))continue;
        // Once the primary reference exposes its call address, site-wide menus
        // for other products/models should not displace its parameter tables.
        if(concreteReference&&link.navigation&&!authentication.test(link.title+' '+link.url)&&!link.embedded)continue;
        const score=linkScore(link,address,next.depth);
        if(score>=30)queue.push({...link,depth:next.depth+1,score});
      }}
    }catch(e){if(fatal(e)||bounded.aborted)throw e;if(!pages.length&&next.depth===0)throw e;warnings.push(`문서 확인 실패: ${next.url} · ${e.message}`);if(e.code==='DOCUMENT_LIMIT')break;}
  }
  if(queue.length&&pages.length>=cap.pages)warnings.push(`문서 ${cap.pages}개 탐색 상한에 도달했습니다. 확인한 근거만 사용합니다.`);
  // Images are a fallback for text-poor documentation, never a default for logos/screenshots in a rich guide.
  if(!choices.length&&!pages.some(p=>hasEndpoint(p)||contract.test(p.text)&&/https?:\/\/|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|"paths"\s*:/i.test(p.text))){
    const candidates=uniqueLinks(pages.flatMap(p=>p.images.filter(i=>!ignored.test(i.url)&&!/(logo|icon|banner|avatar)/i.test(i.url+' '+i.alt)).map(i=>({...i,title:i.alt||'문서 이미지'}))));
    for(const image of candidates.slice(0,cap.images)){
      try{const r=await read(image.url,{maxBytes:1_000_000});const mime=imageMime(r.body);if(!mime)continue;images.push({...image,dataURL:`data:${mime};base64,${r.body.toString('base64')}`});}catch(e){if(fatal(e)||bounded.aborted)throw e;warnings.push('이미지 확인 실패: '+image.url);}
    }
  }
  const rank=p=>p.via==='OpenAPI'?100:p.depth===0?90:authentication.test(p.url+' '+p.title)?80:contract.test(p.text)?50:0;
  const ordered=[...pages].sort((a,b)=>rank(b)-rank(a));
  // Capture untruncated source evidence, including hrefs and OpenAPI servers,
  // independently of the text budget used by the model.
  const endpointEvidence=[...new Map(ordered.flatMap(p=>apiEvidence({...p,pages:[p]})).map(e=>[e.url+'\n'+e.from,e])).values()].slice(0,100);
  let remaining=cap.text;const sections=[];
  for(const page of ordered){const quota=Math.min(remaining,Math.max(2500,Math.floor(cap.text/Math.min(ordered.length,4)),page.depth===0?Math.floor(cap.text*.55):0));if(quota<=0)break;const part=`SOURCE ${page.url}\nTITLE ${page.title}\nVIA ${page.via}\n${meaningful(page.text,quota-300)}`;sections.push(part);remaining-=part.length;}
  // Signup/login links are evidence for manual authentication, never crawled or clicked.
  const allLinks=[...links.values()].filter(l=>(!ignored.test(l.title+' '+new URL(l.url).pathname)||/login|signup|로그인|회원가입/.test(l.url+' '+l.title))&&(!l.navigation||linkScore(l,l.from||inputURL,0)>0||authentication.test(l.title+' '+l.url)||/login|signup|로그인|회원가입/.test(l.url+' '+l.title)))
    .sort((a,b)=>(b.manual?200:b.embedded?150:authentication.test(b.title+' '+b.url)?100:0)-(a.manual?200:a.embedded?150:authentication.test(a.title+' '+a.url)?100:0)).slice(0,80);
  notify(choices.length?'여러 API 상품을 찾았습니다. 체험할 대상을 선택해주세요.':`문서 탐색 완료 · ${pages.length}개 본문 확인`);
  return {kind:'api',url:rootDirect?pages[0].url:inputURL,text:sections.join('\n\n').slice(0,cap.text),direct:rootDirect,spec:rootSpec,apiEvidence:endpointEvidence,pages:pages.map(({url,title,via,text})=>({url,title,via,characters:text.length})),links:allLinks,choices,images,warnings:[...new Set(warnings)].slice(-8),stats:{pages:pages.length,requests,rendered,images:images.length,bytes}};
}

export async function recoverDocumentation(source,reason,tool,options={}){
  const visited=new Set((source.pages||[]).map(p=>p.url));visited.add(source.url);
  const authMissing=/auth|credential|key|인증|키/.test(reason.toLowerCase());
  const links=(source.links||[]).filter(l=>!visited.has(l.url)&&linkScore(l,source.url,0)>0&&(l.embedded||/reference|guide|quick.?start|swagger|openapi|\.ya?ml|\.json|method|request|parameter|authentication|인증|가이드|명세|요청|매개변수/i.test(l.title+' '+new URL(l.url).pathname)))
    .sort((a,b)=>(linkScore(b,source.url,0)+(authMissing&&authentication.test(b.title+' '+b.url)?100:0))-(linkScore(a,source.url,0)+(authMissing&&authentication.test(a.title+' '+a.url)?100:0))).slice(0,3);
  const extra=await collectDocumentation(source.url,tool,{...options,additionalURLs:links,forceRender:true,limits:{pages:4,depth:0,requests:24,renderedPages:1,images:1,bytes:4_000_000,text:16_000,milliseconds:60_000}});
  const unique=(items,key)=>[...new Map(items.map(item=>[key(item),item])).values()];
  return {...source,text:`${source.text.slice(0,8000)}\n\n[실패 원인에 따른 문서 보완]\n${extra.text}`.slice(0,24_000),
    pages:unique([...(source.pages||[]),...extra.pages],p=>p.url+'\n'+p.via),
    links:unique([...(source.links||[]),...extra.links],l=>l.url).slice(-120),
    apiEvidence:unique([...(source.apiEvidence||[]),...extra.apiEvidence],e=>e.url+'\n'+e.from).slice(-120),
    images:unique([...(source.images||[]),...extra.images],i=>i.url),
    choices:extra.choices,warnings:[...new Set([...(source.warnings||[]),...extra.warnings])].slice(-8),
    stats:Object.fromEntries(['pages','requests','rendered','images','bytes'].map(k=>[k,(source.stats?.[k]||0)+(extra.stats?.[k]||0)]))};
}
