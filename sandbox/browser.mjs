import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
let browser,actions=0,stage='launch';
try {
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1280,height:850},ignoreHTTPSErrors:false,extraHTTPHeaders:{'X-Daytona-Skip-Preview-Warning':'true'}});
  // Test the service inside its own sandbox; public ingress is checked independently.
  await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(config.url).origin?route.continue():route.abort('blockedbyclient'));
  const page=await context.newPage();page.setDefaultTimeout(15_000);
  const failures=[];page.on('pageerror',e=>failures.push(e.message));
  stage='navigation';
  const response=await page.goto(config.url,{waitUntil:'domcontentloaded',timeout:30_000});actions++;
  stage='test';
  if(!response||response.status()>=400)throw new Error(`Preview HTTP ${response?.status()}`);
  if(config.generic&&response.headers()['x-playground-version']!==config.version)throw new Error('화면의 실행 버전이 검증 대상과 다릅니다.');
  if(config.inspect){
    const dom=await page.locator('body').evaluate(el=>{
      const text=el.innerText.slice(0,6000);
      const controls=[...el.querySelectorAll('input,button,select,textarea,[role="button"]')].slice(0,50).map(e=>({tag:e.tagName,id:e.id,name:e.getAttribute('name'),type:e.getAttribute('type'),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,120)}));
      return {text,controls};
    });actions++;console.log(JSON.stringify({dom,actions}));
  } else {
    if(config.generic){
      // Optional parameters are collapsed in the shared form; exercise the same
      // disclosure control a user opens before entering those values.
      if(Object.keys(config.sample).length)await page.locator('#request-fields [name]').first().waitFor({state:'attached'});
      const optional=page.locator('#request-fields details.optional-fields:not([open]) > summary');
      if(await optional.count()){await optional.click();actions++;}
      for(const [name,value] of Object.entries(config.sample)){
        const el=page.locator(`[name="${name}"]`);
        const type=await el.getAttribute('type');actions++;
        if(type==='file'){if(value?.base64){await el.setInputFiles({name:value.name,mimeType:'application/octet-stream',buffer:Buffer.from(value.base64,'base64')});actions++;}}
        else if(await el.evaluate(e=>e.tagName==='SELECT')){await el.selectOption(String(value));actions+=2;}
        else {await el.fill(typeof value==='object'?JSON.stringify(value):String(value));actions++;}
      }
      await page.getByRole('button',{name:'실행하기',exact:true}).click();actions++;
      await page.locator('#result[data-state="success"],#result[data-state="error"]').waitFor({timeout:25_000});actions++;
      if(await page.locator('#result').getAttribute('data-state')==='error')throw Object.assign(new Error(await page.locator('#result').innerText()),{code:await page.locator('#result').getAttribute('data-error-code')});
      const raw=await page.locator('#raw-json').textContent();actions++;
      if(!raw)throw new Error('원본 결과가 비어 있습니다.');JSON.parse(raw);
      const mismatch=await page.locator('#result').evaluate((root,raw)=>{
        const data=JSON.parse(raw);const read=path=>path.split('/').slice(1).reduce((v,k)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],data);
        return [...root.querySelectorAll('.value-card[data-source]')].some(card=>{
          const value=read(card.dataset.source);const exact=value===null?'null':value===undefined?'필드 없음':value===''?'빈 문자열':String(value);
          const shown=card.querySelector('strong').textContent;return shown!==exact&&!shown.startsWith(exact+' ');
        });
      },raw);actions++;
      if(mismatch)throw new Error('표시한 주요 값과 원본 응답이 다릅니다.');
      await page.getByRole('button',{name:'원본 JSON',exact:true}).click();actions++;
      await page.locator('#raw-json').waitFor({state:'visible'});actions++;
      await page.getByRole('button',{name:'보기',exact:true}).click();actions++;
      const files=await page.locator('a[download]').count();actions++;
      if(files){const dl=page.waitForEvent('download');await page.locator('a[download]').first().click();await dl;actions+=2;}
    }else{
      if(!config.actions.some(a=>['click','fill','select','check'].includes(a.type))||!config.actions.some(a=>a.type.startsWith('expect')))throw new Error('조작과 결과 확인을 포함한 시나리오가 필요합니다.');
      for(const a of config.actions){
        const el=page.locator(a.selector);
        if(a.type==='fill')await el.fill(a.value);
        else if(a.type==='click')await el.click();
        else if(a.type==='select')await el.selectOption(a.value);
        else if(a.type==='check')await el.check();
        else if(a.type==='expectVisible')await el.waitFor({state:'visible'});
        else if(a.type==='expectValue'){
          await el.waitFor({state:'visible'});actions++;
          await page.waitForFunction(({selector,value})=>document.querySelector(selector)?.value===value,{selector:a.selector,value:a.value});
        }
        else if(a.type==='expectText'){
          actions++;
          if(await el.evaluate(e=>['INPUT','TEXTAREA','SELECT'].includes(e.tagName)))throw Object.assign(new Error('입력 요소는 expectText 대신 expectValue로 검증해야 합니다: '+a.selector),{code:'BROWSER_TEST_INVALID'});
          await el.filter({hasText:a.value}).waitFor({state:'visible'});
        }
        actions++;
        if(new URL(page.url()).origin!==new URL(config.url).origin)throw new Error('테스트가 체험 주소 밖으로 이동했습니다.');
      }
    }
    if(failures.length)throw new Error(failures.slice(0,3).join('; '));
    await page.screenshot({path:config.screenshot,fullPage:false});actions++;
    console.log(JSON.stringify({passed:true,actions,url:config.url,version:config.version,scope:'sandbox-local',scenario:config.scenario||'입력 → 실행 → 결과 → 원본 보기',screenshot:config.screenshot}));
  }
}catch(e){console.log(JSON.stringify({passed:false,actions,error:e.message,code:['BROWSER_TEST_INVALID','EXTERNAL_UNREACHABLE','EXTERNAL_CALL_LIMIT','EXTERNAL_BUDGET_REQUIRED','HTTP_AUTH_CONFIRMATION_REQUIRED'].includes(e.code)?e.code:stage==='launch'?'BROWSER_RUNNER_FAILED':stage==='navigation'?'BROWSER_UNREACHABLE':'BROWSER_FAILED'}));process.exitCode=1;}finally{await browser?.close();}
