import { chromium } from 'playwright';
import { safeRequest, validateURL } from './network.js';

// A fresh, credential-free browser is used only to read public documentation.
// All HTTP traffic goes through the same DNS/IP checks as the server fetcher.
export async function renderDocumentation(url,{request=safeRequest,signal,onRequest=()=>{},maxRequests=55,maxBytes=12_000_000,timeout=30_000}={}) {
  const controller=new AbortController(),bounded=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),timeout);timer.unref();
  let browser,requests=0,bytes=0,fatal,queue=Promise.resolve();
  const warnings=[],documents=[],seen=new Set();
  const stop=()=>{void browser?.close().catch(()=>{});};bounded.addEventListener('abort',stop,{once:true});
  try{
    bounded.throwIfAborted();
    browser=await chromium.launch({headless:true,chromiumSandbox:true,timeout:15_000,args:['--disable-background-networking','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
    bounded.throwIfAborted();
    const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport:{width:1200,height:850}});
    await context.routeWebSocket('**/*',socket=>socket.close());
    const handle=async route=>{
      const req=route.request();
      try{
        if(!['GET','HEAD'].includes(req.method())){warnings.push('문서 브라우저의 쓰기 요청을 차단했습니다.');return await route.abort();}
        if(['media','font','image'].includes(req.resourceType()))return await route.abort();
        validateURL(req.url());
        if(requests>=maxRequests||bytes>=maxBytes){warnings.push('브라우저 문서 요청 한도에 도달했습니다.');return await route.abort();}
        requests++;onRequest();bounded.throwIfAborted();
        const r=await request(req.url(),{signal:bounded,timeout:10_000,maxBytes:Math.min(2_000_000,maxBytes-bytes),method:req.method(),headers:{Accept:req.headers().accept||'*/*'}});
        bytes+=r.body.length;
        // Return redirects to Chromium so relative paths keep the final document base.
        if(r.url&&r.url!==req.url())return await route.fulfill({status:302,headers:{location:r.url},body:''});
        const headers={...r.headers};for(const name of ['content-encoding','transfer-encoding','content-length','set-cookie'])delete headers[name];
        await route.fulfill({status:r.status,headers,body:r.body});
      }catch(e){if(['BUDGET_EXCEEDED','STOPPED','TIME_LIMIT_EXCEEDED'].includes(e.code))fatal=e;else warnings.push('문서 리소스 확인 실패: '+String(e.message).slice(0,160));await route.abort().catch(()=>{});}
    };
    // Serial reads keep concurrent scripts/assets inside the shared byte budget.
    await context.route('**/*',route=>{const pending=queue.then(()=>handle(route));queue=pending.catch(()=>{});return pending;});
    const page=await context.newPage();page.on('dialog',dialog=>dialog.dismiss());page.on('popup',popup=>popup.close());
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:20_000});
    await page.waitForLoadState('networkidle',{timeout:4000}).catch(()=>{});
    const capture=async label=>{
      for(const frame of page.frames().slice(0,5)){
        try{
          const html=await frame.content();const base=/^https?:/.test(frame.url())?frame.url():page.url();
          if(html.length>500_000||seen.has(html))continue;seen.add(html);
          documents.push({url:base,html,label});
        }catch{}
      }
    };
    await capture('렌더링 본문');
    // Only semantic documentation tabs; never submit forms or press API test buttons.
    const tabs=page.locator('[role="tab"],button.tablinks,div.tablinks');
    for(let i=0;i<Math.min(await tabs.count(),5);i++){
      bounded.throwIfAborted();const tab=tabs.nth(i);
      const info=await tab.evaluate(e=>({text:e.textContent?.trim()||'',type:e.getAttribute('type'),tag:e.tagName,form:!!e.closest('form'),href:e.getAttribute('href')}));
      if(info.form||info.type==='submit'||info.href&&!info.href.startsWith('#')||/execute|try it|send|delete|buy|sign|login|결제|구매|실행|전송|삭제|로그인/i.test(info.text))continue;
      if(!await tab.isVisible())continue;
      await tab.click({timeout:1500}).catch(()=>{});await page.waitForLoadState('networkidle',{timeout:1500}).catch(()=>{});await capture('탭: '+info.text.slice(0,80));
    }
    if(fatal)throw fatal;
    return {documents,warnings:[...new Set(warnings)],requests,bytes};
  }finally{clearTimeout(timer);bounded.removeEventListener('abort',stop);await browser?.close().catch(()=>{});}
}
