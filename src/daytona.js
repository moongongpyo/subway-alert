import { Daytona } from '@daytona/sdk';
import { readFile } from 'node:fs/promises';
import { randomBytes,createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fail } from './config.js';
import { redact } from './store.js';
import { connectionFailure } from './network.js';

export const quote = s => "'"+String(s).replaceAll("'","'\\''")+"'";
export class Sandboxes {
  constructor(store,{key=process.env.DAYTONA_API_KEY,snapshot=process.env.DAYTONA_SNAPSHOT}={}) {
    this.store=store;this.snapshot=snapshot;this.client=key?new Daytona({apiKey:key,requestTimeoutMs:25_000}):null;this.cache=new Map();
  }
  async sandbox(id) {
    if(this.cache.has(id))return this.cache.get(id);
    const j=this.store.get(id);const sb=await this.client.get(j.sandboxId||j.sandboxName);this.cache.set(id,sb);return sb;
  }
  async create(id) {
    if(!this.client)fail('CONFIG_REQUIRED','DAYTONA_API_KEY 설정이 필요합니다.',503);
    this.store.reserveInfrastructure(id);this.store.count(id,'tools');
    const j=this.store.get(id);const name=`pg-${id}`;
    this.store.update(id,x=>{x.sandboxName=name;x.cleanupPending=true;x.networkMode='provider-default';x.networkNote='작업별 네트워크 제한 없이 Daytona 계정의 기본 접속 정책을 사용합니다.';});
    // MVP uses Daytona's tier defaults throughout installation, execution and
    // repairs. Omit all sandbox firewall overrides for API and repository jobs.
    const params={name,language:'javascript',...(this.snapshot?{snapshot:this.snapshot}:{}),public:false,ephemeral:true,autoStopInterval:65,ttlMinutes:j.policy.sandboxMinutes,labels:{app:'url-to-playground',job:id}};
    const sb=await this.client.create(params,{timeout:Math.min(90,Math.floor(this.store.remaining(j)/1000))});
    this.cache.set(id,sb);const base=await sb.getWorkDir();
    if(!base||!base.startsWith('/')||![sb.cpu,sb.memory,sb.disk].every(Number.isFinite)||sb.cpu>2||sb.memory>4||sb.disk>20){await this.client.delete(sb);fail('UNSUPPORTED','샌드박스 경로 또는 자원 크기가 지원 범위를 벗어납니다. (최대 2 CPU / 4GB / 20GB)');}
    this.store.update(id,x=>{x.sandboxId=sb.id;x.root=`${base}/playground`;x.controlToken=randomBytes(24).toString('hex');x.cleanupPending=true;delete x.cleanedAt;});
    this.store.assertActive(this.store.get(id));
    await this.command(id,`mkdir -p ${quote(base+'/playground/system')} ${quote(base+'/playground/project')}`,{cwd:base});
    if(j.plan.kind==='api')await this.checkConnectivity(id);
    return sb;
  }
  async checkConnectivity(id){
    const j=this.store.get(id),origin=new URL(j.plan.endpoint.url).origin;
    for(const [local,remote]of [['src/network.js','network.js'],['sandbox/connectivity.mjs','connectivity.mjs']])await this.upload(id,j.root+'/system/'+remote,await readFile(resolve(local)));
    await this.upload(id,j.root+'/system/package.json',JSON.stringify({type:'module'}));
    this.store.update(id,x=>{x.message='API 서버로 연결할 수 있는지 먼저 확인하고 있어요';});
    const output=await this.command(id,`node ${quote(j.root+'/system/connectivity.mjs')} ${quote(origin)}`,{raw:true,allowNonzero:true,limit:15});
    let result;try{result=JSON.parse(output.trim().split('\n').at(-1));}catch{fail('NETWORK_CHECK_FAILED','Daytona에서 API 연결 진단을 완료하지 못했습니다.');}
    this.store.update(id,x=>{x.networkCheck={origin,reachable:result.reachable===true,stage:result.stage||(origin.startsWith('https:')?'tls':'tcp'),durationMs:result.durationMs??null,at:Date.now(),code:result.code};});
    if(result.reachable!==true)fail(result.code==='EXTERNAL_UNREACHABLE'?'EXTERNAL_UNREACHABLE':'NETWORK_CHECK_FAILED',connectionFailure(origin,j.networkMode==='organization'));
  }
  async command(id,command,{cwd,env={},limit=120,raw=false,allowNonzero=false,maxFileKiB=65536}={}) {
    this.store.count(id,'tools');const j=this.store.get(id);this.store.assertActive(j);const secret=this.store.secret(id);
    const logPath=`/tmp/pg-command-${randomBytes(8).toString('hex')}.log`;
    // Keep arbitrary install stdout off the control connection and bound on-disk output.
    if(!Number.isInteger(maxFileKiB)||maxFileKiB<1||maxFileKiB>524288)fail('INVALID_LIMIT','명령 파일 크기 상한이 유효하지 않습니다.');
    const bounded=`ulimit -f ${maxFileKiB}; bash -lc ${quote(command)} > ${quote(logPath)} 2>&1; pg_code=$?; tail -c ${raw?16000:7000} ${quote(logPath)}; exit "$pg_code"`;
    const result=await (await this.sandbox(id)).process.executeCommand(`bash -lc ${quote(bounded)}`,cwd||j.root,env,Math.max(1,Math.min(limit,Math.floor(this.store.remaining(j)/1000))));
    this.store.assertActive(this.store.get(id));
    const output=redact(result.result||'', [secret,j.controlToken,j.previewToken,j.databaseUrl]).slice(-7000);
    this.journal(id,{kind:'command',command,cwd:cwd||j.root,envNames:Object.keys(env),exitCode:result.exitCode,error:result.exitCode?output:undefined,observation:/--version|npm ls|pip list/.test(command)?output:undefined});
    if(!raw)this.store.update(id,x=>{x.logs.push({at:Date.now(),text:output||`명령 종료 (${result.exitCode})`});x.logs=x.logs.slice(-30);});
    if(result.exitCode!==0&&!allowNonzero)fail('EXECUTION_FAILED',output||`명령이 종료 코드 ${result.exitCode}로 실패했습니다.`);
    return raw?result.result:output;
  }
  journal(id,entry){
    const j=this.store.get(id);if(!j||j.purged)return;
    const secrets=[this.store.secret(id),j.controlToken,j.previewToken,j.databaseUrl,process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY,'local-playground-only'];
    const cleaned=redact(entry,secrets);const redacted=cleaned.command!==entry.command;
    this.store.update(id,x=>{x.journal??=[];x.journal.push({...cleaned,redacted,at:Date.now(),version:x.version,planVersion:x.planVersion});x.journal=x.journal.slice(-150);});
  }
  async upload(id,name,content) {
    this.store.count(id,'tools');const j=this.store.get(id);
    if(!name.startsWith(j.root+'/')||name.includes('/../'))fail('INVALID_PATH','샌드박스 경로를 벗어날 수 없습니다.');
    await (await this.sandbox(id)).fs.uploadFile(Buffer.from(content),name,30);
    this.store.assertActive(this.store.get(id));
  }
  async boot(id,viewer) {
    let j=this.store.get(id);const root=j.root,p=j.plan;
    if(p.kind==='github'&&!j.cloned){
      await this.command(id,`git init project && cd project && git remote add origin ${quote('https://github.com/'+j.source.repo+'.git')} && git fetch --depth 1 origin ${quote(j.source.commit)} && git checkout --detach FETCH_HEAD`);
      this.store.update(id,x=>{x.cloned=true;});
    }
    const project=root+'/project';
    for(const file of p.files){const parent=file.path.split('/').slice(0,-1).join('/');if(parent)await this.command(id,`mkdir -p ${quote(project+'/'+parent)}`);await this.upload(id,project+'/'+file.path,file.content);this.store.update(id,x=>{x.recipeFiles??=[];x.recipeFiles.push({...redact(file,[this.store.secret(id),j.controlToken,process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY]),planVersion:x.planVersion});});}
    for(const command of p.install)await this.command(id,command,{cwd:project});
    if(p.kind==='github')await this.command(id,p.runtime==='node'?'npm ls --depth=0 --json':'python3 -m pip list --format=json',{cwd:project,allowNonzero:true});
    await this.command(id,`node --version && python3 --version && (test -d system/node_modules/playwright || (cd system && npm install --save-exact --ignore-scripts playwright@1.58.2))`);
    // Avoid redownloading an installed browser. This command has the same 120s hard timeout.
    try{await this.command(id,`cd system && node -e "const fs=require('fs'); const p=require('playwright'); process.exit(fs.existsSync(p.chromium.executablePath())?0:1)" || (cd ${quote(root+'/system')} && npx --no-install playwright install chromium --with-deps)`,{maxFileKiB:524288});}
    catch(error){fail('BROWSER_INSTALL_FAILED','브라우저 실행기 설치 실패. 모델 재수정으로 반복하지 않습니다. '+String(error.message).slice(-1300));}
    for(const [local,remote] of [['sandbox/runtime.mjs','runtime.mjs'],['sandbox/usage.mjs','usage.mjs'],['src/api-request.js','api-request.mjs'],['sandbox/browser.mjs','browser.mjs'],['src/network.js','network.js'],['public/playground.html','playground.html'],['public/style.css','style.css'],['public/viewer.js','viewer.js'],['public/playground.js','playground.js']])await this.upload(id,root+'/system/'+remote,await readFile(resolve(local)));
    await this.upload(id,root+'/system/package.json',JSON.stringify({type:'module'}));
    if(p.database.kind!=='none')await this.database(id);
    j=this.store.get(id);
    const runtimeConfig={plan:p,viewer,controlToken:j.controlToken,project,version:j.version,databaseUrl:j.databaseUrl,networkMode:j.networkMode,external:j.policy.external,userRequests:j.policy.userRequests,callLimit:j.apiAccess?.callLimit,allowHttpAuth:j.apiAccess?.allowHttpAuth===true,requestMicros:j.requestMicros===null?null:j.requestMicros||0,externalMicros:j.policy.externalMicros,expiresAt:j.createdAt+j.policy.sandboxMinutes*60_000};
    await this.upload(id,root+'/system/config.json',JSON.stringify(runtimeConfig));
    await this.start(id,'gateway',`cd ${quote(root+'/system')} && exec node runtime.mjs`);
    if(p.hasUI)await this.start(id,'application',`cd ${quote(project)} && ${p.start}`,j.databaseUrl?{DATABASE_URL:j.databaseUrl}:{});
    this.store.count(id,'tools');
    const sb=await this.sandbox(id);
    if(j.previewToken){try{await sb.expireSignedPreviewUrl(p.hasUI?p.port:8088,j.previewToken);}catch{}}
    const preview=await sb.getSignedPreviewUrl(p.hasUI?p.port:8088,j.policy.sandboxMinutes*60);
    // The browser runs against the same service over loopback. It does not need
    // outbound access to its own public proxy. Public ingress is verified by the controller.
    this.store.assertActive(this.store.get(id));this.store.update(id,x=>{x.preview=preview.url;x.previewToken=preview.token;});
    await this.health(id);
  }
  async start(id,name,command,env={}) {
    this.store.count(id,'tools');const sb=await this.sandbox(id);const session=`${name}-${id}`;
    const previous=this.store.get(id).sessions||[];
    if(previous.includes(session)){try{await sb.process.deleteSession(session);}catch{}}
    await sb.process.createSession(session);
    this.store.update(id,j=>{j.sessions=[...new Set([...(j.sessions||[]),session])];});
    const exports=Object.entries(env).map(([k,v])=>`${k}=${quote(v)}`).join(' ');
    await sb.process.executeSessionCommand(session,{command:`${exports?`export ${exports}; `:''}exec timeout ${this.store.get(id).policy.sandboxMinutes*60}s bash -lc ${quote(command)}`,runAsync:true},15);
    this.journal(id,{kind:'start',command,cwd:this.store.get(id).root,envNames:Object.keys(env),exitCode:null});
  }
  async database(id) {
    const j=this.store.get(id),db=j.plan.database,project=j.root+'/project';
    if(db.kind==='postgres'){
      await this.command(id,"command -v psql >/dev/null || (sudo -n apt-get update -qq && sudo -n apt-get install -y postgresql postgresql-client)");
      await this.command(id,"sudo -n service postgresql start && (sudo -n -u postgres psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='playground'\" | grep -q 1 || sudo -n -u postgres psql -c \"CREATE ROLE playground LOGIN PASSWORD 'local-playground-only'\") && (sudo -n -u postgres psql -tAc \"SELECT 1 FROM pg_database WHERE datname='playground'\" | grep -q 1 || sudo -n -u postgres createdb -O playground playground)");
      this.store.update(id,x=>{x.databaseUrl='postgresql://playground:local-playground-only@127.0.0.1:5432/playground';});
    }else this.store.update(id,x=>{x.databaseUrl='file:'+project+'/playground.sqlite';});
    const env={DATABASE_URL:this.store.get(id).databaseUrl};
    for(const command of [...db.migrate,...db.seed])await this.command(id,command,{cwd:project,env});
    if(!db.check)fail('DB_CHECK_REQUIRED','DB 스키마·데이터 검증 명령이 필요합니다.');
    await this.command(id,db.check,{cwd:project,env});
  }
  async internal(id,path,{method='GET',body}={}) {
    const j=this.store.get(id);const link=await (await this.sandbox(id)).getPreviewLink(8088);
    const response=await fetch(new URL(path,link.url),{method,headers:{'x-daytona-preview-token':link.token,'X-Daytona-Skip-Preview-Warning':'true','x-control-token':j.controlToken,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30_000),redirect:'error'});
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>3_000_000){await response.body.cancel().catch(()=>{});fail('RESPONSE_TOO_LARGE','샌드박스 응답이 3MB를 초과했습니다.');}chunks.push(Buffer.from(chunk));}
    const data=JSON.parse(Buffer.concat(chunks).toString());if(!response.ok)fail(['EXTERNAL_UNREACHABLE','EXTERNAL_CALL_LIMIT','EXTERNAL_BUDGET_REQUIRED','HTTP_AUTH_CONFIRMATION_REQUIRED'].includes(data.code)?data.code:'EXECUTION_FAILED',data.error||`Gateway HTTP ${response.status}`);return data;
  }
  async health(id) {
    let last;
    for(let n=0;n<4;n++){
      this.store.count(id,'tools');
      try {const health=await this.internal(id,'/__health');if(health.version!==this.store.get(id).version)fail('VERSION_MISMATCH','실행 버전이 일치하지 않습니다.');return health;}catch(e){last=e;if(n<3)await new Promise(r=>setTimeout(r,1000));}
    }throw last;
  }
  async credentials(id,value) {await this.upload(id,this.store.get(id).root+'/system/credential',value);await this.command(id,`chmod 600 ${quote(this.store.get(id).root+'/system/credential')}`,{raw:true});}
  async invoke(id,input) {
    const j=this.store.get(id);if(j.state==='READY')this.store.count(id,'userRequests',1,true);else{this.store.count(id,'tools');this.store.count(id,'external');}
    return this.internal(id,'/invoke',{method:'POST',body:input});
  }
  async browser(id,params) {
    const j=this.store.get(id),root=j.root;
    if(!params.inspect)this.store.count(id,'browserPasses');
    // Reserve worst-case count for known fixed runner; no arbitrary browser scripts.
    const count=params.inspect?2:params.generic?12+Object.keys(params.sample).length*4:params.actions.reduce((sum,a)=>sum+(['expectValue','expectText'].includes(a.type)?2:1),0)+2;
    this.store.count(id,'browserActions',count);
    const config={...params,url:`http://127.0.0.1:${j.plan.hasUI?j.plan.port:8088}/`,version:j.version,screenshot:root+'/system/evidence.png'};
    await this.upload(id,root+'/system/browser-config.json',JSON.stringify(config));
    const out=await this.command(id,`node ${quote(root+'/system/browser.mjs')} ${quote(root+'/system/browser-config.json')}`,{raw:true,limit:90,allowNonzero:true});
    let result;
    try{result=JSON.parse(out.trim().split('\n').at(-1));}catch{fail('BROWSER_RUNNER_FAILED','브라우저 실행기가 검증 결과를 반환하지 못했습니다. '+String(out).slice(-1200));}
    if(result.passed===false){const code=['BROWSER_TEST_INVALID','BROWSER_UNREACHABLE','BROWSER_RUNNER_FAILED','EXTERNAL_UNREACHABLE','EXTERNAL_CALL_LIMIT','EXTERNAL_BUDGET_REQUIRED','HTTP_AUTH_CONFIRMATION_REQUIRED'].includes(result.code)?result.code:'BROWSER_FAILED';fail(code,code==='BROWSER_UNREACHABLE'?'샌드박스에서 프리뷰 주소에 연결하지 못했습니다. Daytona 네트워크 정책과 프리뷰 연결을 확인해야 합니다. '+result.error:result.error);}
    if(!params.inspect){this.store.count(id,'tools');const image=await (await this.sandbox(id)).fs.downloadFile(root+'/system/evidence.png');return {...result,image};}
    return result;
  }
  async verifyPreview(id){
    const j=this.store.get(id);this.store.assertActive(j);
    const request=async path=>{
      this.store.count(id,'tools');
      let response;try{response=await fetch(new URL(path,j.preview),{headers:{'X-Daytona-Skip-Preview-Warning':'true'},redirect:'error',signal:AbortSignal.timeout(20_000)});}catch{fail('PREVIEW_FAILED','외부 프리뷰에 연결하지 못했습니다. 모델 수정 없이 중단합니다.');}
      if(!response.ok){await response.body?.cancel();fail('PREVIEW_FAILED',`외부 프리뷰가 HTTP ${response.status}를 반환했습니다.`);}
      let size=0;const chunks=[];for await(const b of response.body){size+=b.length;if(size>2_000_000)fail('PREVIEW_FAILED','프리뷰 확인 응답이 크기 한도를 넘었습니다.');chunks.push(b);}
      return {body:Buffer.concat(chunks),version:response.headers.get('x-playground-version'),mime:response.headers.get('content-type'),status:response.status};
    };
    const page=await request('/');if(!page.mime?.includes('text/html'))fail('PREVIEW_FAILED','외부 프리뷰가 HTML 화면을 반환하지 않았습니다.');
    if(!j.plan.hasUI){
      if(page.version!==j.version)fail('VERSION_MISMATCH','외부 프리뷰의 실행 버전이 다릅니다.');
      // Compare published HTML and JS/CSS bytes to the exact files that were uploaded.
      for(const path of ['playground.html','playground.js','viewer.js','style.css']){
        const remote=path==='playground.html'?page:await request('/'+path),local=await readFile(resolve('public',path));
        const hash=b=>createHash('sha256').update(b).digest('hex');
        if(hash(remote.body)!==hash(local))fail('PREVIEW_FAILED',`외부 프리뷰 ${path}가 배포한 파일과 일치하지 않습니다.`);
      }
    }
    return {role:'P',version:j.version,at:Date.now(),status:page.status,description:j.plan.hasUI?'공개 서명 프리뷰 HTML 응답 확인':'공개 서명 프리뷰 버전·HTML·JS·CSS 일치 확인'};
  }
  async ready(id) {await this.internal(id,'/__phase',{method:'POST',body:{phase:'ready'}});await (await this.sandbox(id)).setTtl(60);}
  async cleanup(id) {
    const j=this.store.get(id);this.store.secret(id,null);
    const strip=v=>Array.isArray(v)?v.map(strip):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='base64'?'[작업 종료: 파일 내용 폐기]':strip(x)])):v;
    this.store.update(id,x=>{if(x.sample)x.sample=strip(x.sample);if(x.result)x.result=strip(x.result);});
    if(!j.sandboxName&&!j.sandboxId)return;
    try {const sb=await this.sandbox(id);await this.client.delete(sb,30,true);this.cache.delete(id);this.store.update(id,x=>{x.cleanedAt=Date.now();x.cleanupPending=false;delete x.cleanupError;delete x.preview;delete x.previewToken;delete x.controlToken;});}
    catch(e){if(e.status===404||e.statusCode===404||String(e.message).toLowerCase().includes('not found')){this.cache.delete(id);this.store.update(id,x=>{x.cleanedAt=Date.now();x.cleanupPending=false;delete x.cleanupError;delete x.preview;delete x.previewToken;delete x.controlToken;});}else this.store.update(id,x=>{x.cleanupPending=true;x.cleanupError='Daytona 환경 정리 재시도: '+redact(String(e.message),[process.env.DAYTONA_API_KEY,j.controlToken]).slice(0,400);});}
  }
}
