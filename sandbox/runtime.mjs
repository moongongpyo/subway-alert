// Trusted gateway. Executes third-party adapters only inside the job's Daytona sandbox.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { safeRequest, isNetworkError, connectionFailure } from './network.js';
import { reserveInvocation } from './usage.mjs';
import { buildApiRequest, redactApiSecrets } from './api-request.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const cfg=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));
const plan=cfg.plan;
let phase='verify',busy=false;
const statePath=join(root,'usage.json');
let usage=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{external:0,userRequests:0,micros:0};
const persist=()=>writeFileSync(statePath,JSON.stringify(usage));
const safe=(x)=>{
  const key=existsSync(join(root,'credential'))?readFileSync(join(root,'credential'),'utf8'):'';
  return redactApiSecrets(x,key);
};
async function invoke(input) {
  if(Date.now()>cfg.expiresAt)throw new Error('체험이 만료됐습니다.');
  if(busy)throw new Error('이전 요청이 실행 중입니다.');
  usage=reserveInvocation(cfg,usage,phase);persist();busy=true;
  try {
    if(plan.kind==='github') return await new Promise((resolve,reject)=>{
      const child=execFile('/bin/bash',['-lc',`exec ${plan.adapter}`],{cwd:cfg.project,timeout:20_000,maxBuffer:2_000_000,env:{PATH:process.env.PATH,HOME:process.env.HOME,DATABASE_URL:cfg.databaseUrl||''}},(err,stdout)=>{
        if(err)return reject(new Error(`실행 어댑터 실패 (${err.code||'timeout'}): ${String(err.message).slice(0,1200)}`));
        try {resolve({status:200,mime:'application/json',data:JSON.parse(stdout)});}catch{reject(new Error('어댑터가 유효한 JSON을 반환하지 않았습니다.'));}
      });child.stdin.end(JSON.stringify(input));
    });
    const key=existsSync(join(root,'credential'))?readFileSync(join(root,'credential'),'utf8'):'';
    const {url,...request}=buildApiRequest(plan,input,key,{allowHttpAuth:cfg.allowHttpAuth===true});
    const response=await safeRequest(url,request);
    const mime=(response.headers['content-type']||'application/octet-stream').split(';')[0];
    let data;
    if(mime.includes('json')){try{data=JSON.parse(response.body);}catch{throw new Error('API가 잘못된 JSON을 반환했습니다.');}}
    else if(mime.startsWith('text/'))data=response.body.toString();
    else data={file:{name:`response.${mime.split('/')[1]?.replace(/[^a-z0-9]/g,'')||'bin'}`,mime,base64:response.body.toString('base64')}};
    return safe({status:response.status,mime,data});
  } finally {busy=false;}
}
async function readBody(req) {
  let size=0;const parts=[];
  for await(const b of req){size+=b.length;if(size>1_500_000)throw new Error('입력 크기 제한을 초과했습니다.');parts.push(b);}
  return JSON.parse(Buffer.concat(parts).toString()||'{}');
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Playground-Version',cfg.version);
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  try{
    if(req.url?.startsWith('/__')) {
      if(req.headers['x-control-token']!==cfg.controlToken)return send(403,{error:'Forbidden'});
      if(req.url==='/__phase'&&req.method==='POST'){const b=await readBody(req);if(!['verify','ready'].includes(b.phase))throw new Error('Invalid phase');phase=b.phase;return send(200,{phase});}
      if(req.url==='/__stats')return send(200,usage);
      if(req.url==='/__health')return send(200,{version:cfg.version,status:'ok'});
    }
    if(req.url==='/contract')return send(200,{...plan,version:cfg.version,install:[],start:'',files:[],adapter:'',database:{kind:plan.database.kind},auth:{kind:plan.auth.kind},viewer:cfg.viewer});
    if(req.url==='/invoke'&&req.method==='POST'){
      if(phase==='ready'&&req.headers['x-control-token']!==cfg.controlToken)return send(403,{error:'실험 기록과 공통 한도를 적용하려면 메인 체험 화면에서 실행해주세요.'});
      return send(200,await invoke(await readBody(req)));
    }
    const files={'/':['playground.html','text/html'],'/style.css':['style.css','text/css'],'/viewer.js':['viewer.js','text/javascript'],'/playground.js':['playground.js','text/javascript']};
    if(files[req.url]){const [file,type]=files[req.url];res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(readFileSync(join(root,file)));return;}
    send(404,{error:'Not found'});
  }catch(e){const network=plan.kind==='api'&&isNetworkError(e);send(400,{error:network?connectionFailure(plan.endpoint.url,cfg.networkMode==='organization'):safe(e.message),code:network?'EXTERNAL_UNREACHABLE':['EXTERNAL_CALL_LIMIT','EXTERNAL_BUDGET_REQUIRED','HTTP_AUTH_CONFIRMATION_REQUIRED'].includes(e.code)?e.code:'EXECUTION_FAILED'});}
});
server.listen(8088,'0.0.0.0');
