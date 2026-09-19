import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildApiRequest, redactApiSecrets } from './api-request.js';
import { reserveInvocation } from '../sandbox/usage.mjs';
import { safeRequest, isNetworkError } from './network.js';
import { validateInput } from './contracts.js';
import { fail } from './config.js';

const execute=promisify(execFile);
const assets={'/':['playground.html','text/html'],'/playground.js':['playground.js','text/javascript'],'/viewer.js':['viewer.js','text/javascript'],'/style.css':['style.css','text/css']};

// Only the trusted declarative HTTP client runs here. No generated files,
// shell commands, package installs or repository code execute on the app host.
export class DirectApi {
  constructor(store,{request=safeRequest}={}){this.store=store;this.request=request;this.controllers=new Map();this.verifications=new Map();}
  usable(id,version){
    const j=this.store.get(id);if(!j)fail('NOT_FOUND','체험을 찾을 수 없습니다.',404);
    if(j.state==='READY'){
      if(j.expiresAt<=Date.now())fail('STOPPED','체험이 만료됐습니다.',409);
      if(j.verifiedVersion!==j.version)fail('VERSION_MISMATCH','검증 버전이 변경됐습니다.',409);
    }else this.store.assertActive(j);
    if(version&&j.version!==version)fail('VERSION_MISMATCH','실행 계획이 변경됐습니다.',409);
    return j;
  }
  async create(id){
    this.store.assertActive(this.store.get(id));
    this.store.update(id,j=>{j.executionMode='node-api';j.networkMode='app-server';j.networkNote='앱 Node.js 서버에서 외부 API를 직접 호출합니다.';j.cleanupPending=false;delete j.cleanedAt;});
  }
  async boot(id){
    const j=this.usable(id),p=j.plan;
    if(p.kind!=='api'||p.hasUI||p.runtime!=='none'||p.database.kind!=='none'||p.files.length||p.install.length||p.start||p.adapter||!p.endpoint.readOnly)fail('INVALID_PLAN','직접 API 실행기는 읽기 전용 HTTP 호출 계약만 지원합니다.');
    this.store.update(id,x=>{x.runtimeVersion=x.version;x.nodeVersion=process.version;});
  }
  async credentials(id){this.usable(id);if(!this.store.secret(id))fail('INVALID_KEY','API 키를 연결해주세요.');}
  async invoke(id,input){
    const j=this.usable(id),version=j.version;
    if(j.runtimeVersion!==version)fail('VERSION_MISMATCH','현재 실행 계획을 준비해야 합니다.');
    const key=this.store.secret(id)||'',normalized=validateInput(j.plan.fields,input);
    const {url,...request}=buildApiRequest(j.plan,normalized,key,{allowHttpAuth:j.apiAccess?.allowHttpAuth===true});
    const token=randomUUID(),controller=new AbortController(),started=Date.now();
    // Reserve counts and money atomically before sending, including failed and
    // uncertain requests. The lease survives restarts and competing workers.
    this.store.update(id,x=>{
      this.usable(id,version);
      if(x.apiInvocation?.until>Date.now())fail('BUSY','이전 API 요청이 실행 중입니다.',409);
      const ready=x.state==='READY',field=ready?'userRequests':'external';
      const cfg={external:x.policy.external,userRequests:x.policy.userRequests,callLimit:x.apiAccess?.callLimit,requestMicros:x.requestMicros??null,externalMicros:x.policy.externalMicros};
      x.apiUsage=reserveInvocation(cfg,x.apiUsage||{external:0,userRequests:0,micros:0},ready?'ready':'verify');
      if(!Number.isFinite(x.policy[field])||(x.counters[field]||0)>=x.policy[field]||!ready&&(!Number.isFinite(x.policy.tools)||(x.counters.tools||0)>=x.policy.tools))fail('BUDGET_EXCEEDED','API 실행 한도에 도달했습니다.');
      x.counters[field]=(x.counters[field]||0)+1;if(!ready)x.counters.tools=(x.counters.tools||0)+1;
      x.apiInvocation={token,until:Date.now()+30_000};
    });
    this.controllers.set(id,controller);
    try{
      const remaining=j.state==='READY'?j.expiresAt-Date.now():this.store.remaining(j);
      const response=await this.request(url,{...request,timeout:Math.max(1,Math.min(20_000,remaining)),signal:controller.signal});
      this.usable(id,version);controller.signal.throwIfAborted();
      const mime=String(response.headers['content-type']||'application/octet-stream').split(';')[0];let data;
      if(mime.includes('json')){try{data=JSON.parse(response.body);}catch{fail('EXECUTION_FAILED','API가 잘못된 JSON을 반환했습니다.');}}
      else if(mime.startsWith('text/'))data=response.body.toString();
      else data={file:{name:`response.${mime.split('/')[1]?.replace(/[^a-z0-9]/g,'')||'bin'}`,mime,base64:response.body.toString('base64')}};
      this.store.update(id,x=>{x.apiRequestHistory=[...(x.apiRequestHistory||[]),{version,at:started,method:j.plan.endpoint.method,url:j.plan.endpoint.url,status:response.status,durationMs:Date.now()-started}].slice(-60);});
      return redactApiSecrets({status:response.status,mime,data},key);
    }catch(error){
      if(controller.signal.aborted)fail('STOPPED','API 요청이 중단됐습니다.');
      if(isNetworkError(error))fail('EXTERNAL_UNREACHABLE',`앱 Node.js 서버에서 ${new URL(j.plan.endpoint.url).origin}에 연결하지 못했습니다. 대상 API의 응답 상태를 확인해주세요. Daytona는 이 요청에 사용되지 않았습니다.`,502);
      error.message=redactApiSecrets(String(error.message),key);throw error;
    }finally{
      this.controllers.delete(id);
      this.store.update(id,x=>{if(x.apiInvocation?.token===token)delete x.apiInvocation;});
    }
  }
  async browser(id,params){
    const j=this.usable(id),version=j.version;
    if(!params.generic||params.inspect)fail('INVALID_PLAN','API 화면은 공통 입력 폼으로 검증합니다.');
    this.store.count(id,'browserPasses');this.store.count(id,'browserActions',12+Object.keys(params.sample).length*4);
    const token=randomBytes(24).toString('hex'),dir=await mkdtemp(join(tmpdir(),'pg-direct-api-'));
    const server=http.createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Playground-Version',version);
      const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
      try{
        if(req.headers['x-control-token']!==token)return send(403,{error:'Forbidden'});
        this.usable(id,version);
        if(req.url==='/contract'&&req.method==='GET')return send(200,{title:j.plan.title,capability:j.plan.capability,fields:j.plan.fields,viewer:j.viewer,version});
        if(req.url==='/invoke'&&req.method==='POST'){
          const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>1_500_000)fail('INVALID_INPUT','입력 크기 제한을 초과했습니다.');chunks.push(b);}
          return send(200,await this.invoke(id,JSON.parse(Buffer.concat(chunks).toString())));
        }
        if(req.method==='GET'&&Object.hasOwn(assets,req.url)){const [file,mime]=assets[req.url];const body=await readFile(resolve('public',file));res.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});res.end(body);return;}
        send(404,{error:'Not found'});
      }catch(e){send(400,{error:redactApiSecrets(e.message,this.store.secret(id)||''),code:e.code||'EXECUTION_FAILED'});}
    });
    try{
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const url=`http://127.0.0.1:${server.address().port}/`,config=join(dir,'config.json'),screenshot=join(dir,'evidence.png');
      await writeFile(config,JSON.stringify({...params,url,version,screenshot,scope:'app-server',controlToken:token}));
      let stdout;try{({stdout}=await execute(process.execPath,[resolve('sandbox/browser.mjs'),config],{timeout:90_000,maxBuffer:200_000,windowsHide:true}));}catch(e){if(!e.stdout)fail('BROWSER_RUNNER_FAILED','앱 서버의 Chromium 검증 실행기를 시작하지 못했습니다.');stdout=e.stdout;}
      let result;try{result=JSON.parse(stdout.trim().split('\n').at(-1));}catch{fail('BROWSER_RUNNER_FAILED','브라우저 검증 결과를 읽지 못했습니다.');}
      if(result.passed!==true)fail(result.code||'BROWSER_FAILED',result.error||'API 입력 화면 검증 실패');
      this.usable(id,version);
      // Check the exact shared UI assets served by this trusted local gateway.
      for(const [path,[file]]of Object.entries(assets)){
        const response=await fetch(new URL(path,url),{headers:{'X-Control-Token':token},redirect:'error',signal:AbortSignal.timeout(5000)});
        if(!response.ok||response.headers.get('x-playground-version')!==version||!Buffer.from(await response.arrayBuffer()).equals(await readFile(resolve('public',file))))fail('PREVIEW_FAILED','API 공통 화면의 실행 버전·파일이 일치하지 않습니다.');
      }
      this.verifications.set(id,{role:'P',version,at:Date.now(),status:200,description:'앱 서버 공통 입력 화면의 HTTP 응답·버전·HTML·JS·CSS 일치 확인'});
      return {...result,image:await readFile(screenshot)};
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
  }
  async verifyPreview(id){const j=this.usable(id),e=this.verifications.get(id);if(e?.version!==j.version)fail('PREVIEW_FAILED','API 화면 검증 기록이 없습니다.');return e;}
  async ready(id){this.usable(id);this.verifications.delete(id);}
  async cleanup(id){
    this.controllers.get(id)?.abort();this.verifications.delete(id);this.store.secret(id,null);
    const strip=v=>Array.isArray(v)?v.map(strip):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='base64'?'[작업 종료: 파일 내용 폐기]':strip(x)])):v;
    this.store.update(id,j=>{j.sample=strip(j.sample);j.result=strip(j.result);j.cleanedAt=Date.now();j.cleanupPending=false;delete j.apiInvocation;delete j.cleanupError;});
  }
}
