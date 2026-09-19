import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collect, PLAN_TASK, responseSample } from './analyze.js';
import { analyzeWithRecovery } from './analysis-recovery.js';
import { Auth, Plan, Viewer, Checks, BrowserActions, validatePlan, stepsFor, validateInput } from './contracts.js';
import { hash, redact } from './store.js';
import { PREPARING, TERMINAL, fail } from './config.js';
import { apiAccessOffer, approveApiAccess, observedAuthURL } from './api-access.js';
import { apiEvidence } from './api-evidence.js';

const noRepair=new Set(['BUDGET_EXCEEDED','TIME_LIMIT_EXCEEDED','NO_PROGRESS','CONFIG_REQUIRED','UNSUPPORTED','STOPPED','UNKNOWN_PRICE','UNKNOWN_TOKENS','PRICE_REVIEW_REQUIRED','METERING_MISMATCH','INFRA_BUDGET','BROWSER_INSTALL_FAILED','BROWSER_UNREACHABLE','BROWSER_RUNNER_FAILED','PREVIEW_FAILED','EXTERNAL_UNREACHABLE','NETWORK_POLICY_REQUIRED','EXTERNAL_PRICING_REQUIRED','EXTERNAL_BUDGET_REQUIRED','EXTERNAL_CALL_LIMIT','HTTP_AUTH_CONFIRMATION_REQUIRED']);
const invalidProposal=e=>['INVALID_PLAN','MODEL_INCOMPLETE'].includes(e.code)||e.name==='ZodError'||e instanceof SyntaxError;
// The client has already exhausted its bounded transport retry; changing project code cannot fix it.
for(const code of ['NOSANA_CONNECTION','NOSANA_TIMEOUT','NOSANA_EXPIRED'])noRepair.add(code);
export class Orchestrator {
  constructor(store,models,sandboxes,dir='data',{collectSource=collect}={}) {this.store=store;this.models=models;this.sandboxes=sandboxes;this.dir=dir;this.collectSource=collectSource;this.running=new Map();this.waiters=new Map();}
  log(id,text){this.store.update(id,j=>{j.message=text;});}
  failure(id,error){this.store.update(id,j=>{const record={at:Date.now(),version:j.version,code:error.code||'EXECUTION_FAILED',message:redact(String(error.message),[this.store.secret(id),process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY,j.controlToken,j.previewToken,j.databaseUrl]).slice(0,1800)};j.failures=[...(j.failures||[]),record].slice(-10);});}
  step(id,step,status,evidence=null){this.store.update(id,j=>{const s=j.steps.find(s=>s.id===step);if(s){s.status=status;s.evidence=evidence;}});}
  start(id){if(this.running.has(id))return;const c=new AbortController();this.running.set(id,c);this.run(id,c.signal).finally(()=>this.running.delete(id));}
  async run(id,signal) {
    try {
      let source,plan,sourceURL=this.store.get(id).url;
      for(;;){
        this.store.assertActive(this.store.get(id));
        this.store.update(id,j=>{j.state='ANALYZING';j.message='본문과 연결된 문서에서 실행 근거를 찾고 있어요';});
        source=await this.collectSource(sourceURL,()=>{this.store.count(id,'documentRequests');this.store.count(id,'tools');},{signal,
          onPage:()=>this.store.count(id,'documentPages'),
          onProgress:progress=>{this.store.assertActive(this.store.get(id));this.store.update(id,j=>{j.documentation=progress;j.message=progress.message;});}
        });
        const retain=()=>{this.store.assertActive(this.store.get(id));this.store.update(id,j=>{j.source={...source,images:source.images?.map(({dataURL,...meta})=>meta)};});};
        retain();
        try{plan=await analyzeWithRecovery(id,source,{store:this.store,models:this.models,signal,onSource:retain,onFailure:e=>this.failure(id,e)});retain();break;}
        catch(e){
          retain();
          if(e.code==='SOURCE_CHOICE'){
            this.store.count(id,'sourceSelections');
            this.store.update(id,j=>{j.sourceChoices=e.choices;j.sourceChoiceReason=e.message;});
            await this.waitForKey(id,e.message,'source');sourceURL=this.store.get(id).selectedSourceURL;continue;
          }
          if(!invalidProposal(e))throw e;this.failure(id,e);await this.repairPlan(id,e,source,signal);break;
        }
      }
      if(plan)await this.acceptPlan(id,plan,source);
      await this.sandboxes.create(id);
      for(;;){
        try {await this.prepare(id,signal);break;}
        catch(e){
          this.failure(id,e);
          await this.repairPlan(id,e,source,signal);
        }
      }
      this.store.assertActive(this.store.get(id));
      await this.sandboxes.ready(id);
      this.evaluations?.archivePreparation(id);
      this.store.update(id,j=>{j.state='READY';j.expiresAt=Date.now()+j.policy.readyMs;j.activeSpent+=Date.now()-j.activeSince;j.activeSince=null;j.message='실제 기능과 브라우저 검증을 통과했어요';j.steps.forEach(s=>{if(s.id==='ready'){s.status='completed';s.evidence='검증한 버전·주소 공개';}});});
    }catch(e){
      const j=this.store.get(id);
      if(j.failures?.at(-1)?.code!==e.code)this.failure(id,e);
      if(!TERMINAL.has(j.state))this.store.update(id,x=>{x.state=e.code==='UNSUPPORTED'?'UNSUPPORTED':signal.aborted?'CANCELLED':'FAILED';x.reason=e.code||'EXECUTION_FAILED';x.message=redact(e.message,[this.store.secret(id),process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY,x.controlToken,x.previewToken,x.databaseUrl]).slice(0,1800);for(const s of x.steps){if(['running','repairing','waiting_input'].includes(s.status))s.status='failed';else if(s.status==='pending')s.status='cancelled';}if(x.activeSince){x.activeSpent+=Date.now()-x.activeSince;x.activeSince=null;}});
      await this.sandboxes.cleanup(id);
    }
  }
  async repairPlan(id,error,source,signal){
    let failedCandidate=error.rejectedPlan||null;
    for(;;){
      const j=this.store.get(id);
      if(noRepair.has(error.code)||signal.aborted||!PREPARING.has(j.state))throw error;
      const fingerprint=hash({error:error.message,plan:failedCandidate||j.plan});
      this.store.repair(id,fingerprint);
      this.store.update(id,x=>{x.state='PREPARING';for(const s of x.steps)if(!['analysis','environment','credentials'].includes(s.id))s.status=s.status==='failed'||s.status==='running'?'repairing':'pending';x.message=`실패 피드백을 반영하고 있어요 · 수정 ${x.round}/${x.policy.repairs}회`;});
      const current=this.store.get(id),secrets=[this.store.secret(id),j.controlToken,j.previewToken,j.databaseUrl,process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY];
      const feedback=redact({round:current.round,maxRounds:current.policy.repairs,error:String(error.message).slice(0,3000),failedCandidate,history:(current.failures||[]).slice(-6).map(f=>({version:f.version,code:f.code,message:f.message.slice(0,700)})),commands:(current.journal||[]).filter(c=>c.exitCode).slice(-3).map(c=>({version:c.version,command:c.command?.slice(0,1000),error:c.error?.slice(0,1200)})),verified:(current.evidence||[]).slice(-4).map(e=>({role:e.role,version:e.version,description:e.description}))},secrets);
      try{
        const candidate=await this.models.ask(id,error.code==='BROWSER_FAILED'?'D':'A',PLAN_TASK+' Repair the evidenced failure using the feedback history. apiEvidence preserves observed request hrefs and specification addresses even when text is truncated; use them with documented relative paths. Identify why earlier attempts failed, change the relevant executable code or configuration, and preserve the documented capability. Never repeat an unchanged failing approach or claim an unverified fix succeeded.',{source:{...source,apiEvidence:apiEvidence(source),images:source.images?.map(({dataURL,...meta})=>meta),text:source.text.slice(0,12000)},feedback,plan:j.plan},Plan,{escalate:current.round===Math.min(4,current.policy.repairs),signal});
        failedCandidate=candidate;
        const repaired=validatePlan(candidate,source);
        await this.acceptPlan(id,repaired,source,true);return;
      }catch(e){
        // A rejected repair proposal gets feedback too; no unvalidated code is run.
        if(!invalidProposal(e))throw e;
        this.failure(id,e);error=e;
      }
    }
  }
  async acceptPlan(id,plan,source,repair=false){
    this.store.assertActive(this.store.get(id));
    // Keep the validated plan so users can connect before any environment is created.
    this.store.update(id,j=>{j.analysis={completedAt:Date.now(),title:plan.title,capability:plan.capability};if(!j.plan)j.steps=stepsFor(plan);});
    if(plan.kind!=='api'&&plan.auth.kind!=='none')fail('UNSUPPORTED','외부 키가 필요한 저장소는 아직 지원하지 않습니다. 원본 코드의 외부 호출 비용을 집행할 수 있는 프록시 연결이 필요합니다. API 문서 URL로 체험할 수 있습니다.');
    this.store.update(id,j=>{
      const prev=j.steps;j.plan=plan;j.planVersion++;j.version=hash({commit:source.commit,plan,template:2}).slice(0,16);j.steps=stepsFor(plan);
      if(repair)for(const s of j.steps){const before=prev.find(a=>a.id===s.id);if(['environment','credentials'].includes(s.id)&&before?.status==='completed'){s.status='completed';s.evidence=before.evidence;}}
      j.state='PREPARING';j.message=repair?'실행 계획을 수정했어요. 영향을 받은 단계를 다시 확인합니다.':`${plan.capability} 체험을 준비하고 있어요`;j.sample=Object.fromEntries(plan.fields.filter(f=>f.example!=='').flatMap(f=>{try{return [[f.name,f.type==='file'?JSON.parse(f.example):f.example]];}catch{return [];}}));
    });
    if(plan.kind==='api')await this.connectApi(id,source);
    else this.store.update(id,j=>{j.requestMicros=0;});
  }
  async connectApi(id,source){
    let j=this.store.get(id);const offer=apiAccessOffer(j.plan);
    if(j.apiAccess?.scope===offer.scope)return;
    if(j.apiOffer&&j.apiOffer.scope!==offer.scope)this.store.secret(id,null);
    this.store.update(id,x=>{x.apiOffer=offer;delete x.apiAccess;x.requestMicros=offer.requestMicros;});
    const needsKey=j.plan.auth.kind!=='none';
    if(!needsKey&&offer.requestMicros===0)return;
    if(needsKey){
      this.step(id,'credentials','running');
      const auth=await this.models.ask(id,'C','Explain how the user obtains their own API key in Korean, using 2–4 short numbered steps grounded in the official documentation. Preserve kind and name. Prefer a directly observed key console/issuing URL over a general guide; never invent URLs, menu names, signup approvals or free quotas. docsUrl is the observed setup guide. A guide is a valid issueUrl if no direct console was observed. Never request or include the key value.',{auth:j.plan.auth,source:source.text.slice(0,14000),links:source.links},Auth,{small:true,signal:this.running.get(id)?.signal});
      this.store.assertActive(this.store.get(id));
      if(auth.kind===j.plan.auth.kind&&auth.name===j.plan.auth.name)this.store.update(id,x=>{x.plan.auth={...x.plan.auth,instructions:auth.instructions,issueUrl:observedAuthURL(auth.issueUrl,source,x.plan.auth.issueUrl),docsUrl:observedAuthURL(auth.docsUrl,source,x.plan.auth.docsUrl)};});
    }
    await this.waitForKey(id,needsKey?'발급 안내를 확인하고 API 키를 연결해주세요.':'이 API의 호출 조건을 확인해주세요.','connection');
  }
  async prepare(id,signal){
    let j=this.store.get(id),p=j.plan;
    this.step(id,'environment','running');
    if(!p.hasUI){
      this.step(id,'interface','running');this.log(id,'입력 항목과 결과 표시 방식을 구성하고 있어요');
      const viewer=await this.models.ask(id,'D','Configure the reusable response viewer. JSON Pointer paths only; labels and units require supplied documentation evidence. Empty fields is valid when output unknown. Do not infer units or change values.',{capability:p.capability,source:j.source.text.slice(0,12000)},Viewer,{signal});
      viewer.fields=viewer.fields.filter(f=>f.path.startsWith('/')&&(!f.unit||f.evidence&&j.source.text.includes(f.evidence)));
      this.store.update(id,x=>{x.viewer=viewer;});
    }
    if(p.database.kind!=='none')this.step(id,'database','running');
    this.step(id,'execution','running');this.log(id,p.kind==='api'?'앱 서버의 API 호출과 입력 화면을 연결하고 있어요':'필요한 패키지를 설치하고 실행 환경을 준비하고 있어요');
    await this.sandboxes.boot(id,this.store.get(id).viewer);
    const direct=this.store.get(id).executionMode==='node-api';
    this.step(id,'environment','completed',direct?'Node.js 직접 API 호출 준비 · 샌드박스 사용 없음':'Daytona 샌드박스 생성 및 런타임 설치');
    this.step(id,'execution','completed',direct?'HTTP 호출 계약과 실행 버전 연결':'실행 버전 health 확인');
    this.step(id,'database','completed','마이그레이션·시드·DB 쿼리 통과');
    this.step(id,'interface','completed','공통 UI와 입력 계약 연결');
    if(!p.hasUI){try{validateInput(p.fields,this.store.get(id).sample);}catch{await this.waitForKey(id,'검증에 사용할 필수 입력을 채워주세요.','sample');}}
    if(p.auth.kind!=='none'){
      if(!this.store.secret(id)){
        await this.waitForKey(id);
      }
      await this.sandboxes.credentials(id,this.store.secret(id));
    }
    this.store.update(id,x=>{x.state='VERIFYING';x.message='실제 입력으로 기능을 확인하고 있어요';});
    this.step(id,'function','running');
    j=this.store.get(id);
    if(!p.hasUI){
      const sample=validateInput(p.fields,j.sample);
      let result=await this.sandboxes.invoke(id,sample);
      while([401,403].includes(result.status)&&p.auth.kind!=='none'){
        this.store.secret(id,null);await this.waitForKey(id,'API 키가 거부됐어요. 키와 권한을 확인한 뒤 다시 연결해주세요.');
        await this.sandboxes.credentials(id,this.store.secret(id));
        this.store.update(id,x=>{x.state='VERIFYING';});result=await this.sandboxes.invoke(id,sample);
      }
      if(result.status>=400)fail('FUNCTION_FAILED',`기능 호출이 HTTP ${result.status}로 실패했습니다. ${JSON.stringify(result.data).slice(0,600)}`);
      const checks=await this.models.ask(id,'B','Select required JSON Pointer paths in the observed response, backed by the capability and docs. Root primitive uses empty paths. Assert response shape only, do not fabricate exact data. This response is a deterministic bounded sample: arrays have at most 2 original entries, deep objects are elided; do not infer empty-result semantics from sampling. Allow empty only if valid per docs.',{expected:p.expected,capability:p.capability,response:redact(responseSample(result.data)),source:j.source.text.slice(0,5000)},Checks,{signal});
      if(!checks.allowEmpty&&(result.data===null||Array.isArray(result.data)&&!result.data.length))fail('FUNCTION_FAILED','대표 입력의 결과가 비어 있습니다.');
      for(const path of checks.paths){let value=result.data;for(const part of path.split('/').slice(1)){const key=part.replace(/~1/g,'/').replace(/~0/g,'~');if(value==null||!Object.hasOwn(value,key))fail('FUNCTION_FAILED',`기대 결과 필드 ${path}를 찾지 못했습니다.`);value=value[key];}}
      this.store.update(id,x=>{x.result=redact(result,[this.store.secret(id)]);x.sample=sample;x.evidence.push({role:'B',version:x.version,at:Date.now(),description:checks.description,status:result.status});});
    }else{
      this.store.count(id,'tools');
      const response=await fetch(new URL(p.healthPath||'/',j.preview),{headers:{'X-Daytona-Skip-Preview-Warning':'true'},signal:AbortSignal.timeout(20_000),redirect:'error'});
      if(response.status>=400)fail('FUNCTION_FAILED',`원본 앱이 HTTP ${response.status}를 반환했습니다.`);
      await response.body?.cancel();
      this.store.update(id,x=>{x.evidence.push({role:'B',version:x.version,at:Date.now(),description:'원본 앱 HTTP 응답 및 DB 확인. 실제 기능은 브라우저 시나리오로 검증.'});});
    }
    this.step(id,'credentials','completed','실제 인증 호출 통과');this.step(id,'function','completed','대표 입력의 실제 응답 확인');
    this.evaluations?.prefetch?.warmJob(id);
    this.step(id,'browser','running');this.log(id,'브라우저에서 입력과 버튼, 결과 화면을 확인하고 있어요');
    let params={generic:true,sample:this.store.get(id).sample};
    if(p.hasUI){
      const observation=await this.sandboxes.browser(id,{inspect:true});
      const actions=await this.models.ask(id,'E','Create a short browser test grounded ONLY in observed controls. Must perform a meaningful action then assert its result using CSS selectors (use unique IDs/name when present). No account signup, payments, external navigation, uploads of private data, or destructive actions. Only local seeded test data. At least one click/fill and one result assertion. If no meaningful test is possible, return empty actions.',{capability:p.capability,expected:p.expected,dom:observation.dom},BrowserActions,{signal});
      if(!actions.actions.length)fail('UNSUPPORTED','원본 UI에서 자동 검증할 대표 동작을 확인하지 못했습니다.');
      params={...actions,generic:false};
    }
    const evidence=await this.sandboxes.browser(id,params);
    if(evidence.passed!==true||evidence.version!==this.store.get(id).version)fail('BROWSER_FAILED','브라우저 검증의 성공 여부 또는 버전이 맞지 않습니다.');
    const publicEvidence=await this.sandboxes.verifyPreview(id);
    const directory=join(this.dir,'evidence');await mkdir(directory,{recursive:true});await writeFile(join(directory,id+'.png'),evidence.image);
    const {image,...details}=evidence;
    this.store.update(id,x=>{x.evidence.push({role:'E',at:Date.now(),...details,url:undefined,screenshot:undefined},publicEvidence);x.verifiedVersion=x.version;});
    this.step(id,'browser','completed',direct?'앱 서버 Chromium 입력·실제 API 응답·공통 화면 검증':'샌드박스 Chromium 조작·결과 및 외부 프리뷰 접속 검증');
  }
  async waitForKey(id,message='API 키 입력이 필요해요',kind='credentials'){
    this.store.update(id,j=>{j.state='WAITING_FOR_USER';j.waitKind=kind;j.waitSequence=(j.waitSequence||0)+1;j.waitUntil=Math.min(Date.now()+j.policy.waitingMs,j.createdAt+j.policy.waitingMs+j.policy.activeMs);j.activeSpent+=j.activeSince?Date.now()-j.activeSince:0;j.activeSince=null;j.message=message;const s=j.steps.find(s=>s.id===(kind==='sample'?'function':'credentials'));if(s)s.status='waiting_input';});
    await new Promise((resolve,reject)=>this.waiters.set(id,{resolve,reject}));
    this.store.update(id,j=>{if(TERMINAL.has(j.state))fail('STOPPED','중단된 작업입니다.');j.state='PREPARING';j.activeSince=Date.now();j.waitUntil=null;j.waitKind=null;});
  }
  credentials(id,value){
    const j=this.store.get(id);if(j.state!=='WAITING_FOR_USER'||j.waitKind!=='credentials')fail('INVALID_STATE','현재 인증 입력을 기다리는 작업이 아닙니다.',409);
    const waiter=this.waiters.get(id);if(!waiter)fail('INTERRUPTED','작업이 중단되었습니다. 새 작업을 시작해주세요.',409);this.store.secret(id,value);
    this.waiters.delete(id);waiter.resolve();
  }
  connection(id,input){
    const j=this.store.get(id),waiter=this.waiters.get(id);
    if(j.state!=='WAITING_FOR_USER'||j.waitKind!=='connection')fail('INVALID_STATE','현재 API 연결을 기다리는 작업이 아닙니다.',409);
    if(!waiter)fail('INTERRUPTED','작업이 중단됐습니다. 새 체험을 시작해주세요.',409);
    const access=approveApiAccess(j.apiOffer,input);
    if(j.plan.auth.kind!=='none'&&(typeof input.value!=='string'||input.value.trim().length<3||input.value.length>4096||/[\r\n]/.test(input.value)))fail('INVALID_KEY','발급받은 API 키를 입력해주세요.');
    // The raw key is written only to encrypted storage, never the job or model context.
    if(j.plan.auth.kind!=='none')this.store.secret(id,input.value.trim());
    this.store.update(id,x=>{x.apiAccess=access;x.requestMicros=access.requestMicros;x.policy.externalMicros=access.externalMicros;});
    this.waiters.delete(id);waiter.resolve();
  }
  sample(id,input){const waiter=this.waiters.get(id);if(!waiter)fail('INTERRUPTED','중단된 작업입니다.',409);this.store.update(id,j=>{j.sample=input;});this.waiters.delete(id);waiter.resolve();}
  selectSource(id,choiceId){
    const j=this.store.get(id);if(j.state!=='WAITING_FOR_USER'||j.waitKind!=='source')fail('INVALID_STATE','문서 대상을 선택하는 단계가 아닙니다.',409);
    const choice=j.sourceChoices?.find(c=>c.id===choiceId);if(!choice)fail('INVALID_INPUT','확인된 문서 목록에서 대상을 선택해주세요.');
    const waiter=this.waiters.get(id);if(!waiter)fail('INTERRUPTED','중단된 작업입니다. 새 체험을 시작해주세요.',409);
    this.store.update(id,x=>{x.selectedSourceURL=choice.url;x.selectedSources=[...(x.selectedSources||[]),{title:choice.title,url:choice.url,from:choice.from,at:Date.now()}];delete x.sourceChoices;});
    this.waiters.delete(id);waiter.resolve();
  }
  async cancel(id,state='CANCELLED',reason='USER_CANCELLED'){
    const j=this.store.get(id);if(TERMINAL.has(j.state))return;
    this.store.update(id,x=>{x.state=state;x.reason=reason;x.message=state==='EXPIRED'?'체험이 만료됐습니다.':'작업을 종료했습니다.';for(const s of x.steps)if(['running','pending','repairing','waiting_input'].includes(s.status))s.status='cancelled';});
    this.running.get(id)?.abort();this.waiters.get(id)?.reject(new Error('작업 종료'));this.waiters.delete(id);await this.sandboxes.cleanup(id);
  }
  async sweep(){
    for(const j of this.store.all()){
      if(j.taskType||j.purged)continue;
      if(j.state==='READY'&&j.expiresAt<=Date.now()||j.state==='WAITING_FOR_USER'&&j.waitUntil<=Date.now())await this.cancel(j.id,'EXPIRED','TTL_EXCEEDED');
      else if(PREPARING.has(j.state)&&j.activeSince&&this.store.remaining(j)<=0){await this.cancel(j.id,'FAILED','TIME_LIMIT_EXCEEDED');this.store.update(j.id,x=>{x.message=`자동 준비 시간 ${x.policy.activeMs/60_000}분을 모두 사용했습니다.`;});}
      else if(TERMINAL.has(j.state)&&j.cleanupPending)await this.sandboxes.cleanup(j.id);
    }
  }
  async recover(){
    // Never replay uncertain provider calls or installation commands after a restart.
    this.store.db.prepare("UPDATE requests SET status='unknown' WHERE status='pending'").run();
    for(const j of this.store.all())if(PREPARING.has(j.state)){
      this.store.update(j.id,x=>{x.state='FAILED';x.reason='SERVER_RESTARTED';x.message='서버가 재시작되어 작업을 중단했습니다. 사용량은 보존됐습니다.';});await this.sandboxes.cleanup(j.id);
    }
    await this.sweep();
  }
}
