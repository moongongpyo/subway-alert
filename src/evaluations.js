import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, PREPARING, TERMINAL, PRICES } from './config.js';
import { redact } from './store.js';
import { validateInput } from './contracts.js';
import { validateURL, safeRequest } from './network.js';
import { responseSample } from './analyze.js';
import { evaluation, putEvaluation, records, putRecord, getRecord, idempotent, digest, EvaluationFiles } from './evaluation-data.js';
import { GoalInput, FeedbackInput, ExperimentAnalysis, ExperienceAnalysis, NextExperiments, SearchQuery, AlternativeAnalysis, ReportNotes, assess } from './evaluation-contracts.js';
import { makeRecipe, singleRunReport } from './reports.js';
import { PRESENTATION_TASK, presentationSample, renderPresentation } from './result-presentation.js';
import { ExperimentPrefetch } from './experiment-prefetch.js';

const latestFeedback=(db,eid,id)=>records(db,eid,'feedback').filter(f=>f.runId===id).at(-1);
const noAuthURL=value=>{const url=validateURL(String(value));if(/[?&](key|api_key|token|access_token|secret|password)=/i.test(url.href))fail('INVALID_URL','인증정보가 포함된 URL은 사용할 수 없습니다.');return url.href;};
export class Evaluations {
  constructor(store,models,sandboxes,orchestrator,{request=safeRequest,autoExperience=true,autoPrefetch=autoExperience}={}){this.store=store;this.db=store.db;this.models=models;this.sandboxes=sandboxes;this.orchestrator=orchestrator;this.files=new EvaluationFiles(store);this.running=new Map();this.request=request;this.autoExperience=autoExperience;this.autoPrefetch=autoPrefetch;this.prefetch=new ExperimentPrefetch(this);}
  get(id,owner){return evaluation(this.db,id,owner);}
  archivePreparation(id){const j=this.store.get(id);try{this.store.tx(()=>{const sample=this.files.snapshot(j.evaluationId,this.clean(j.sample||{},j.evaluationId)),result=this.files.snapshot(j.evaluationId,this.clean(j.result||null,j.evaluationId));const current=this.store.get(id);current.sample=sample;current.result=result;this.store.save(current);});}catch{const strip=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(strip):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='base64'?'[파일 보관 실패]':strip(x)])):v;this.store.update(id,x=>{x.sample=strip(x.sample);x.result=strip(x.result);x.archiveWarning='검증 입력·출력 파일을 별도 보관하지 못했습니다.';});}}
  jobs(id){return this.store.all().filter(j=>j.evaluationId===id&&!j.taskType&&!j.purged);}
  clean(value,eid){return redact(value,[process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY,...this.jobs(eid).flatMap(j=>[this.store.secret(j.id),j.controlToken,j.previewToken,j.databaseUrl])]);}
  record(eid,id,type){return getRecord(this.db,eid,id,type);}
  snapshot(id,owner){
    const e=this.get(id,owner),all=records(this.db,id),jobs=this.jobs(id),usage=this.db.prepare('SELECT * FROM requests WHERE evaluation=?').all(id);
    const runs=all.filter(r=>r.type==='run').map(r=>{const feedback=latestFeedback(this.db,id,r.id),goal=e.goals.find(g=>g.version===r.goalVersion);return {...r,feedback,assessment:assess(goal,r,feedback)};});
    return this.clean({...e,owner:undefined,runs,experiments:all.filter(r=>r.type==='experiment'),suggestions:all.filter(r=>r.type==='suggestion'),transitions:all.filter(r=>r.type==='transition'),analyses:all.filter(r=>r.type==='analysis').map(({presentation,design,...r})=>({...r,hasPresentation:!!presentation})),reports:all.filter(r=>r.type==='report').map(({markdown,...r})=>r),jobs:jobs.map(j=>({id:j.id,title:j.projectName||j.plan?.title||j.url,url:j.url,state:j.state,version:j.version,hasUI:j.plan?.hasUI,capability:j.plan?.capability,expiresAt:j.expiresAt,createdAt:j.createdAt,usage:this.store.usage(j.id),transitionId:j.transitionId})),usage:{rentalCalls:usage.filter(r=>PRICES[r.model]?.billing==='gpu-hour').length,micros:usage.reduce((s,r)=>s+r.micros,0),reserved:usage.filter(r=>r.status!=='settled').reduce((s,r)=>s+r.micros,0),calls:usage.length},formats:['md']},id);
  }
  goal(eid,owner,body){return this.store.tx(()=>{const e=this.get(eid,owner),g=GoalInput.parse(body);if(g.version!==e.goals.length)fail('CONFLICT','목적이 변경됐습니다. 새로고침해주세요.',409);
    const conditions=g.conditions.map(c=>{if(c.kind!=='subjective'&&c.pointer!==''&&!c.pointer.startsWith('/'))fail('INVALID_CONDITION','JSON Pointer는 /로 시작해야 합니다.');let expected;try{expected=JSON.parse(c.expectedJson);}catch{fail('INVALID_CONDITION','기대 값은 JSON 형식이어야 합니다.');}if(c.kind==='contains'&&typeof expected!=='string')fail('INVALID_CONDITION','포함 검사는 문자열 기대 값이 필요합니다.');return {...c,id:randomUUID(),expectedJson:JSON.stringify(expected)};});
    if(e.goals.length>=20)fail('LIMIT','목적 변경 한도에 도달했습니다.');const result=this.clean({...g,conditions,version:e.goals.length+1,at:Date.now()},eid);e.goals.push(result);putEvaluation(this.db,e);return result;});}
  feedback(eid,owner,runId,body){return this.store.tx(()=>{this.get(eid,owner);const run=this.record(eid,runId,'run'),f=FeedbackInput.parse(body),previous=latestFeedback(this.db,eid,runId);
    if(f.version!==(previous?.version||0))fail('CONFLICT','피드백이 변경됐습니다.',409);const goal=this.get(eid,owner).goals.find(g=>g.version===run.goalVersion);
    if(f.conditions.some(c=>!goal?.conditions.some(g=>g.id===c.id)))fail('INVALID_CONDITION','실행 당시의 기대 조건을 선택해주세요.');
    if(records(this.db,eid,'feedback').filter(x=>x.runId===runId).length>=20)fail('LIMIT','피드백 변경 한도에 도달했습니다.');
    return putRecord(this.db,eid,'feedback',this.clean({...f,version:f.version+1,runId,at:Date.now()},eid));});}
  basedOn(eid,jobId,runId){const e=this.get(eid),j=this.store.get(jobId);if(!j||j.evaluationId!==eid||j.taskType)fail('NOT_FOUND','대상 체험을 찾을 수 없습니다.',404);const r=runId?this.record(eid,runId,'run'):null;return {jobId,version:j.version||null,goalVersion:e.goals.length,runId:r?.id||null,feedbackVersion:r?latestFeedback(this.db,eid,r.id)?.version||0:0};}
  assertBasis(eid,basis){if(digest(this.basedOn(eid,basis.jobId,basis.runId))!==digest(basis))fail('STALE_SUGGESTION','목적·피드백·실행 버전이 바뀐 제안입니다. 새 조건으로 준비해주세요.',409);}
  draft(eid,owner,body,inTransaction=false){const create=()=>{
    const e=this.get(eid,owner),j=this.store.get(body.jobId);if(!j||j.owner!==owner||j.evaluationId!==eid||!j.plan)fail('NOT_FOUND','준비된 체험을 선택해주세요.',404);
    if(records(this.db,eid,'experiment').length>=100)fail('LIMIT','실험 계획 한도에 도달했습니다.');
    let input=body.input||{},basis=this.basedOn(eid,j.id,body.parentRunId),title='직접 설정한 실험',reason='사용자가 입력과 옵션을 지정했습니다.',changes=[];
    if(body.suggestionId){const card=this.record(eid,body.suggestionId,'suggestion');if(card.kind==='alternative')fail('INVALID_REQUEST','대안은 새 준비 작업을 시작해야 합니다.');this.assertBasis(eid,card.basedOn);if(card.basedOn.jobId!==j.id)fail('INVALID_REQUEST','카드의 대상 도구가 다릅니다.');input={...card.input,...input};basis=card.basedOn;title=card.title;reason=card.reason;changes=card.changes;}
    const names=new Set(j.plan.fields.map(f=>f.name));if(Object.keys(input).some(k=>!names.has(k)))fail('INVALID_INPUT','현재 기능에 없는 입력입니다.');
    const normalized=validateInput(j.plan.fields.map(f=>({...f,required:false})),this.files.hydrate(eid,input));
    if(JSON.stringify(normalized)!==JSON.stringify(this.clean(normalized,eid)))fail('SECRET_INPUT','비밀정보는 실험 입력 대신 별도 인증 화면에서 연결해주세요.');
    const snapshot=this.files.snapshot(eid,this.clean(normalized,eid));
    const previous=basis.runId?this.record(eid,basis.runId,'run').input:{};
    changes=[...new Set([...Object.keys(previous),...Object.keys(snapshot)])].filter(field=>JSON.stringify(previous[field])!==JSON.stringify(snapshot[field])).map(field=>({field,before:Object.hasOwn(previous,field)?previous[field]:{missing:true},after:Object.hasOwn(snapshot,field)?snapshot[field]:{missing:true}}));
    return putRecord(this.db,eid,'experiment',{jobId:j.id,basedOn:basis,goalVersion:e.goals.length,version:j.version,input:snapshot,title,reason,changes,check:body.suggestionId?this.record(eid,body.suggestionId,'suggestion').check:'사용자 기대 조건 확인',suggestionId:body.suggestionId||null,createdAt:Date.now(),transferConfirmed:body.transferConfirmed===true});
  };return inTransaction?create():this.store.tx(create);}
  async invoke(eid,owner,jobId,input,key){
    if(typeof key!=='string'||!/^[\w-]{8,100}$/.test(key))fail('INVALID_REQUEST','중복 방지 요청 ID가 필요합니다.');
    this.get(eid,owner);
    const ex=this.store.tx(()=>idempotent(this.db,owner,'legacy-'+digest(key),digest({eid,jobId,input}),()=>({id:this.draft(eid,owner,{jobId,input},true).id,evaluationId:eid})));
    return this.run(eid,owner,ex.id,key);
  }
  async run(eid,owner,experimentId,key,{manualOutput,manualConditions,manualState}={}){
    const prepared=this.store.tx(()=>{
      const e=this.get(eid,owner),ex=this.record(eid,experimentId,'experiment');
      return idempotent(this.db,owner,key,digest({eid,experimentId,manualOutput,manualConditions,manualState}),()=>{
        this.assertBasis(eid,ex.basedOn);const j=this.store.get(ex.jobId);
        if(j.state!=='READY'||j.expiresAt<=Date.now()||j.verifiedVersion!==ex.version)fail('NOT_READY','유효한 검증 버전의 체험이 필요합니다.',409);
        if(j.transitionId&&!ex.transferConfirmed)fail('TRANSFER_REQUIRED','새 도구의 입력·파일 전송 대상과 달라진 조건을 확인해주세요.');
        const runs=records(this.db,eid,'run');if(runs.length>=e.policy.runs)fail('BUDGET_EXCEEDED','프로젝트의 본 실험 30회를 모두 사용했습니다.');
        if(runs.some(r=>r.state==='running'&&r.jobId===j.id))fail('BUSY','이 도구의 이전 실행이 진행 중입니다.',409);
        if(j.plan.hasUI){if(manualOutput===undefined||!String(manualConditions||'').trim())fail('MANUAL_REQUIRED','원래 UI에서 실행한 결과와 실제 사용 조건을 등록해주세요.');if(!['succeeded','failed','unknown'].includes(manualState))fail('INVALID_STATE','직접 확인한 실행 상태가 필요합니다.');}
        else validateInput(j.plan.fields,this.files.hydrate(eid,ex.input));
        const run=putRecord(this.db,eid,'run',{experimentId,jobId:j.id,goalVersion:ex.goalVersion,version:ex.version,fields:j.plan.fields,viewer:j.viewer,input:ex.input,title:ex.title,reason:ex.reason,changes:ex.changes,check:ex.check,parentRunId:ex.basedOn.runId,createdAt:Date.now(),state:'running',provenance:j.plan.hasUI?'manual':'gateway',manualConditions:String(manualConditions||'').slice(0,3000),environment:{runtime:j.plan.runtime,database:j.plan.database.kind,commit:j.source?.commit||null,resources:'Daytona 정책 한도: 2 CPU / 4 GiB / 20 GiB',databaseState:'초기화되지 않은 동일 환경; 이전 실행 상태가 남을 수 있음'},cost:{externalMicros:j.plan.hasUI||j.requestMicros===null?null:j.requestMicros||0,kind:j.plan.hasUI||j.requestMicros===null?'unknown':j.apiAccess?.pricingSource==='user_free_allowance'?'user_declared_free':'reserved_ceiling',daytona:'unknown'}});
        return {id:run.id,evaluationId:eid,created:true};
      });
    });
    let run=this.record(eid,prepared.id,'run');if(run.state!=='running'||this.running.has(run.id))return run;
    // A duplicate pending record after a process restart is never replayed.
    if(run.executionStarted)return run;
    run.executionStarted=true;putRecord(this.db,eid,'run',run);this.running.set(run.id,true);
    const started=performance.now(),j=this.store.get(run.jobId);
    const prefetched=this.prefetch.bestEffort(eid,owner,{jobId:j.id,input:run.input,parentRunId:run.parentRunId});
    if(prefetched){run.prefetchTaskId=prefetched.id;putRecord(this.db,eid,'run',run);}
    try{
      const result=j.plan.hasUI?{status:null,data:manualOutput}:await this.sandboxes.invoke(j.id,validateInput(j.plan.fields,this.files.hydrate(eid,run.input)));
      this.get(eid,owner);run=this.record(eid,run.id,'run');if(run.state!=='running')return run;
      let output,storageError;try{output=this.store.tx(()=>this.files.snapshot(eid,this.clean(result.data,eid)));}catch(e){storageError=e.message;output={storageError:'산출물 저장 실패',preview:responseSample(this.clean(result.data,eid),2000)};}
      const state=j.plan.hasUI?manualState:result.status>=400?'failed':'succeeded';
      const deterministicChecks=assess(this.get(eid,owner).goals.find(g=>g.version===run.goalVersion),{...run,state,output:this.clean(result.data,eid)}).conditions.filter(c=>['deterministic','user-output-check'].includes(c.source));
      run={...run,state,status:result.status,output,storageError,deterministicChecks,durationMs:j.plan.hasUI?null:Math.round(performance.now()-started),measurement:j.plan.hasUI?'사용자 등록; 실행 시간 미측정':'제어 서버→샌드박스 왕복 1회; 준비 시간 제외',finishedAt:Date.now()};
    }catch(e){if(!this.db.prepare('SELECT id FROM evaluations WHERE id=?').get(eid))return {state:'cancelled'};run={...run,state:/timeout|abort|fetch|network/i.test(e.name+' '+e.message)?'unknown':'failed',error:this.clean(e.message,eid).slice(0,1500),durationMs:Math.round(performance.now()-started),finishedAt:Date.now()};}
    finally{this.running.delete(run.id);}
    if(this.store.get(j.id)?.state!=='READY')run={...run,state:'unknown',error:'작업이 종료되어 늦게 도착한 결과는 확정하지 않았습니다.'};
    const saved=this.store.tx(()=>putRecord(this.db,eid,'run',{...run,experiencePending:this.autoExperience}));
    this.prefetch.activate(eid,saved);
    if(this.autoExperience)this.scheduleExperience(eid,owner,saved.id);
    return saved;
  }
  scheduleExperience(eid,owner,runId){
    this.get(eid,owner);
    try{const task=this.experience(eid,owner,runId);const run=this.record(eid,runId,'run');putRecord(this.db,eid,'run',{...run,experiencePending:false,experienceTaskId:task.id,experienceError:null});return task;}
    catch(error){const run=this.record(eid,runId,'run');putRecord(this.db,eid,'run',{...run,experiencePending:error.code==='ACTIVE_JOB',experienceError:error.code==='ACTIVE_JOB'?null:this.clean(error.message,eid)});return null;}
  }
  experience(eid,owner,runId,{retry=false}={}){
    this.get(eid,owner);const run=this.record(eid,runId,'run');if(run.state==='running')fail('NOT_READY','실행 결과를 기다리고 있습니다.',409);
    const j=this.store.get(run.jobId),basis=this.basedOn(eid,j.id,run.id),context=this.context(eid,basis);
    const fingerprint=digest({experience:3,basis,retry:retry?records(this.db,eid,'analysis').length:0});
    return this.task(eid,owner,'experience',fingerprint,{mode:'experience',basedOn:basis},async(id,signal)=>{
      const result=await this.models.ask(id,'G',PRESENTATION_TASK+' After designing the result, ALWAYS propose 3 concrete, distinct next experiment cards grounded in this tool and the current inputs/results (fewer only if the API genuinely has no independent conditions). No purpose question is required before execution. Evaluate the UNDERLYING tool capability, search relevance, output quality or edge-case handling; NEVER suggest testing this playground UI, card layout, rendering or visual density. Improve a weakness or explore a relevant edge case; do not repeat vague testing advice. A change must use an existing field, JSON value and an exact quote from its description/source as evidence. Do not invent supported options. For an image FILE field, asset may contain a detailed synthetic test image prompt and its field name; we will actually generate that image on card selection. Example background removal: flyaway hair against a similarly colored background, transparent objects, fine fur. Generated samples are not ground truth. For all other cards asset=null. requiresInput lists only fields requiring the user to upload/type their own input. Never invent an image URL. File bytes are unavailable; do not claim visual quality from metadata. Existing UI without a schema needs manual experiment instructions. Summary and checks are concise Korean.',{...context,fields:j.plan.fields,preparedInput:presentationSample(run.input,3000),response:presentationSample(run.output??null),execution:{state:run.state,status:run.status,error:run.error},sampling:'Up to 5 array items and truncated long strings for design only; renderer binds the full stored response.'},ExperienceAnalysis,{signal});
      this.store.assertActive(this.store.get(id));
      const presentation=renderPresentation(result,run.output??null);let saved=this.saveCards(eid,basis,result.cards,run.input),suggestionsError=null;
      if(!saved.length&&j.plan.fields.length){try{
        const repaired=await this.models.ask(id,'G','The prior cards could not be connected to this verified input form. Return 3 concrete experiments using ONLY the exact field names and types below. Each valueJson must parse as JSON. Do not add options or new fields. When testing new content, change the existing text input. For an existing image file field use asset to generate a synthetic test image. Never execute. The supplied descriptions are the evidence; no purpose question required.',{fields:j.plan.fields,input:run.input,context:context.goal,previousCards:result.cards,summary:result.summary},NextExperiments,{signal});
        this.store.assertActive(this.store.get(id));saved=this.saveCards(eid,basis,repaired.cards,run.input);
      }catch(error){suggestionsError=this.clean(error.message,eid);}}
      if(!saved.length)suggestionsError??='이 실행 계약에 연결할 수 있는 실험 카드를 구성하지 못했습니다. 직접 입력을 바꾸거나 목적을 지정할 수 있어요.';
      return {summary:result.summary,questions:result.questions,assessments:result.assessments,suggestionIds:saved.map(c=>c.id),presentation,design:{html:result.html,css:result.css},designVersion:3,suggestionsError,cardValidation:{proposed:result.cards.map(c=>({title:c.title,fields:c.changes.map(d=>d.field),requiresInput:c.requiresInput})),accepted:saved.length}};
    });
  }
  saveCards(eid,basis,cards,input){
    const j=this.store.get(basis.jobId),saved=[];
    this.store.tx(()=>{for(const c of cards){const prepared={...input},changes=[];let valid=true;
      for(const change of c.changes){const f=j.plan.fields.find(f=>f.name===change.field);if(!f||f.type==='file'){valid=false;break;}
        // The field already belongs to the verified executable contract. Attach that
        // authoritative description instead of discarding useful inputs for paraphrased quotes.
        try{const value=JSON.parse(change.valueJson);validateInput([{...f,required:false}],{[f.name]:value});changes.push({field:f.name,before:prepared[f.name]??null,after:value,evidence:f.description||f.name});prepared[f.name]=value;}catch{valid=false;break;}}
      if(!valid||c.requiresInput.some(k=>!j.plan.fields.some(f=>f.name===k)))continue;
      if(c.asset&&!j.plan.fields.some(f=>f.name===c.asset.field&&f.type==='file'))continue;
      for(const name of c.requiresInput)delete prepared[name];if(c.asset)delete prepared[c.asset.field];
      const signature=digest({basis,title:c.title,input:prepared,asset:c.asset}),existing=records(this.db,eid,'suggestion').find(s=>s.signature===signature);if(existing){saved.push(existing);continue;}
      saved.push(putRecord(this.db,eid,'suggestion',this.clean({kind:c.kind,title:c.title,reason:c.reason,check:c.check,requiresInput:c.requiresInput,asset:c.asset,changes,input:prepared,basedOn:basis,signature,createdAt:Date.now()},eid)));
    }});return saved;
  }
  prepareCard(eid,owner,cardId,{retry=false}={}){
    this.get(eid,owner);const card=this.record(eid,cardId,'suggestion');this.assertBasis(eid,card.basedOn);
    const j=this.store.get(card.basedOn.jobId);if(j.state!=='READY'||j.expiresAt<=Date.now())fail('NOT_READY','환경이 만료됐습니다. 새 체험을 준비해주세요.',409);
    if(card.kind==='alternative')fail('INVALID_REQUEST','대안은 새 준비 작업으로 연결해주세요.');
    if(!card.asset)return {state:'COMPLETED',input:card.input};
    const previous=records(this.db,eid,'analysis').filter(a=>a.mode==='asset'&&a.cardId===cardId),last=previous.at(-1);
    if(last&&(!retry||!['FAILED','CANCELLED'].includes(last.state)))return last;
    if(previous.length>=2)fail('BUDGET_EXCEEDED','이 카드의 이미지 생성은 2회까지 가능합니다. 직접 파일을 선택해주세요.');
    return this.task(eid,owner,'asset',digest({cardId,asset:card.asset,attempt:previous.length}),{mode:'asset',basedOn:card.basedOn,cardId},async(id,signal)=>{
      const file=await this.models.generateImage(id,card.asset.prompt,{signal});this.store.assertActive(this.store.get(id));
      const reference=this.files.save(eid,file);return {input:{...card.input,[card.asset.field]:reference},assetFile:reference,description:card.asset.description,synthetic:true};
    });
  }
  mapping(eid,owner,jobId){this.get(eid,owner);const j=this.store.get(jobId);if(!j||j.evaluationId!==eid)fail('NOT_FOUND','체험을 찾을 수 없습니다.',404);if(!j.transitionId)return null;
    const t=this.record(eid,j.transitionId,'transition'),run=t.runId?this.record(eid,t.runId,'run'):null;
    const previous=run?.fields||[],next=j.plan?.fields||[],input={},rows=[];
    for(const f of next){const old=previous.find(o=>o.name===f.name);const exact=old&&old.type===f.type&&old.location===f.location&&old.description&&old.description===f.description;
      if(exact&&Object.hasOwn(run.input,f.name))input[f.name]=run.input[f.name];rows.push({field:f.name,status:exact?'동일한 스키마·설명: 확인 후 재사용':old?'의미·타입 차이 확인 필요':'새 입력',before:old?run.input[f.name]:null});}
    for(const f of previous)if(!next.some(n=>n.name===f.name))rows.push({field:f.name,status:'대응하는 옵션 없음',before:run.input[f.name]});
    return {input,rows,reason:t.reason,previousJob:t.fromJobId,destination:j.plan?.kind==='api'?j.plan.endpoint.url:j.url};
  }
  context(eid,basis){
    const e=this.get(eid),j=this.store.get(basis.jobId),all=records(this.db,eid,'run'),selected=[...(basis.runId?[this.record(eid,basis.runId,'run')]:[]),...all.filter(r=>r.id!==basis.runId&&r.state!=='running'&&r.goalVersion===e.goals.length).slice(-2)];
    const bounded=value=>responseSample(this.clean(value??null,eid),1200),goal=e.goals.at(-1)||{purpose:'기본 기능 확인',conditions:[]};
    return {goal:{...goal,purpose:goal.purpose.slice(0,600),constraints:goal.constraints?.slice(0,600),conditions:goal.conditions.map(c=>({...c,label:c.label.slice(0,150)}))},capability:j.plan?.capability,fields:(j.plan?.fields||[]).map(f=>({...f,example:f.type==='file'?'':f.example.slice(0,200),description:f.description.slice(0,300)})),version:j.version,source:(j.source?.text||'').slice(0,2500),runs:selected.map(r=>({id:r.id,state:r.state,input:bounded(r.input),output:bounded(r.output),error:r.error,assessment:assess(e.goals.find(g=>g.version===r.goalVersion),r,latestFeedback(this.db,eid,r.id)),feedback:latestFeedback(this.db,eid,r.id)})),previousCards:records(this.db,eid,'suggestion').slice(-3).map(c=>({title:c.title,check:c.check,changes:c.changes})),limitations:'File bytes omitted; only bounded output samples are supplied. Empty/deep data may be omitted. Never infer accuracy or completeness from sampling.'};
  }
  task(eid,owner,type,fingerprint,payload,perform){
    this.get(eid,owner);const existing=records(this.db,eid,type==='report'?'report':'analysis').find(r=>r.fingerprint===fingerprint);if(existing)return {...existing,state:this.store.get(existing.id)?.state||existing.state};
    const report=type==='report',experience=type==='experience',asset=type==='asset',prefetch=type==='prefetch',policy=prefetch?{calls:1,roleCalls:1,jobMicros:30_000,inputPerCall:8000,inputTotal:8000,outputPerCall:3000,outputTotal:3000,activeMs:90_000,tools:2,repairs:0}:{calls:asset?1:report||experience?2:3,roleCalls:asset?1:3,jobMicros:report||experience?250_000:asset?30_000:200_000,inputPerCall:experience||report?20_000:8000,inputTotal:experience||report?40_000:24_000,outputPerCall:experience?7000:report?4000:asset?2048:2000,outputTotal:experience?14_000:8000,activeMs:report||experience||asset?180_000:120_000,tools:8,repairs:0};
    const job=this.store.create(owner,this.store.get(payload.basedOn?.jobId)?.url||'https://example.com',`${type}-${eid}-${fingerprint.slice(0,25)}`,policy,{evaluationId:eid,taskType:type});
    const record=putRecord(this.db,eid,report?'report':'analysis',{id:job.id,...payload,fingerprint,state:'ANALYZING',createdAt:Date.now()});
    const controller=new AbortController();this.running.set(job.id,controller);const timer=setTimeout(()=>controller.abort(),policy.activeMs);timer.unref();
    const promise=(async()=>{try{
      const result=await perform(job.id,controller.signal);this.store.assertActive(this.store.get(job.id));
      this.store.tx(()=>{putRecord(this.db,eid,report?'report':'analysis',{...record,...result,state:'COMPLETED',finishedAt:Date.now()});const j=this.store.get(job.id);j.state='COMPLETED';j.activeSpent=Date.now()-j.activeSince;j.activeSince=null;this.store.save(j);});
    }catch(error){const j=this.store.get(job.id);if(j&&!j.purged){if(PREPARING.has(j.state))this.store.update(job.id,x=>{x.state=controller.signal.aborted?'CANCELLED':'FAILED';x.message=this.clean(error.message,eid).slice(0,1200);x.activeSince=null;});
      try{putRecord(this.db,eid,report?'report':'analysis',{...record,state:this.store.get(job.id).state,error:this.clean(error.message,eid).slice(0,1200),finishedAt:Date.now()});}catch{}}
    }finally{clearTimeout(timer);this.running.delete(job.id);}})();controller.promise=promise;
    return record;
  }
  analyze(eid,owner,body){
    if(this.autoExperience&&body.mode!=='alternatives'&&body.runId)return this.experience(eid,owner,body.runId,{retry:body.retry===true});
    this.get(eid,owner);const basis=this.basedOn(eid,body.jobId,body.runId),j=this.store.get(body.jobId);
    if(!j.plan||!j.verifiedVersion)fail('NOT_READY','먼저 준비와 검증을 완료해주세요.',409);
    const mode=body.mode==='alternatives'?'alternatives':'experiments',candidateURL=body.url?noAuthURL(body.url):null,context=this.context(eid,basis);
    let input=body.input??(basis.runId?this.record(eid,basis.runId,'run').input:j.sample||{});
    if(body.input!==undefined){
      if(Object.keys(input).some(k=>!j.plan.fields.some(f=>f.name===k)))fail('INVALID_INPUT','현재 기능에 없는 입력입니다.');
      input=validateInput(j.plan.fields.map(f=>({...f,required:false})),this.files.hydrate(eid,input));
      if(JSON.stringify(input)!==JSON.stringify(this.clean(input,eid)))fail('SECRET_INPUT','비밀정보는 별도 인증 화면에 입력해주세요.');
      input=this.store.tx(()=>this.files.snapshot(eid,input));
    }
    context.preparedInput=responseSample(input,1500);
    const fingerprint=digest({basis,mode,candidateURL,input,retry:body.retry===true?records(this.db,eid,'analysis').length:0});
    return this.task(eid,owner,'analysis',fingerprint,{basedOn:basis,mode,candidateURL},async(id,signal)=>{
      if(mode==='alternatives')return this.findAlternatives(id,eid,basis,context,candidateURL,signal);
      const result=await this.models.ask(id,'G','Evaluate only supplied evidence. Separate execution success from goal fulfillment; subjective quality remains user judgment. Propose up to 3 relevant experiments to improve a documented limitation or explore an untested condition. Every change must use an existing field and quote its documented description/source in evidence. Never invent files, options or measured scores. Prefer one variable at a time. Ask for missing expectations instead of random suggestions. Existing UI without input schema: request manual input; never invent controls. Assessments are interpretations only.',context,ExperimentAnalysis,{signal});
      const cards=[];for(const c of result.cards){
        const prepared={...input},changes=[];
        let valid=true;for(const change of c.changes){const f=j.plan.fields.find(f=>f.name===change.field);if(!f||f.type==='file'||!change.evidence||!((f.description||'').includes(change.evidence)||(j.source?.text||'').includes(change.evidence))){valid=false;break;}
          try{const value=JSON.parse(change.valueJson);validateInput([{...f,required:false}],{[f.name]:value});changes.push({field:f.name,before:prepared[f.name]??null,after:value,evidence:change.evidence});prepared[f.name]=value;}catch{valid=false;break;}}
        if(!valid||c.requiresInput.some(k=>!j.plan.fields.some(f=>f.name===k)))continue;
        const signature=digest({basis,input:prepared,requiresInput:c.requiresInput,kind:c.kind});if(records(this.db,eid,'suggestion').some(s=>s.signature===signature))continue;
        for(const field of c.requiresInput)delete prepared[field];
        cards.push({kind:c.kind,title:c.title,reason:c.reason,check:c.check,requiresInput:c.requiresInput,changes,input:prepared,basedOn:basis,signature,createdAt:Date.now()});
      }
      this.store.assertActive(this.store.get(id));const saved=this.store.tx(()=>cards.map(c=>putRecord(this.db,eid,'suggestion',this.clean(c,eid))));
      return {summary:result.summary,questions:result.questions,assessments:result.assessments.filter(a=>context.runs.some(r=>r.id===a.runId)&&context.goal.conditions.some(c=>c.id===a.conditionId)),suggestionIds:saved.map(c=>c.id)};
    });
  }
  async findAlternatives(id,eid,basis,context,candidateURL,signal){
    const sources=[],read=async url=>{this.store.count(id,'tools');const r=await this.request(url,{signal,maxBytes:500_000,timeout:15_000});if(r.status>=400)fail('SOURCE_UNAVAILABLE',`대안 문서 HTTP ${r.status}`);return r;};
    if(candidateURL){const response=await read(candidateURL);let text=response.body.toString();if(!response.headers['content-type']?.includes('json')){const {load}=await import('cheerio');const $=load(text);$('script,style,nav').remove();text=$('body').text().replace(/\s+/g,' ');}
      sources.push({id:'source-1',url:candidateURL,title:new URL(candidateURL).hostname,text:text.slice(0,4000),checkedAt:Date.now()});
    }else{
      const query=await this.models.ask(id,'H','Create a concise English GitHub repository search query for tools supporting the stated purpose and evidenced limitation. No personal data, filenames, document text, or secrets. Output keywords only. Do not search for an unrelated example app.',{goal:context.goal,capability:context.capability,feedback:context.runs.map(r=>({state:r.state,assessment:r.assessment,feedback:r.feedback?.satisfaction}))},SearchQuery,{small:true,signal});
      const response=await read(`https://api.github.com/search/repositories?q=${encodeURIComponent(query.query)}&per_page=3`),items=JSON.parse(response.body.toString()).items||[];
      for(const repo of items){if(!/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)||this.jobs(eid).some(j=>j.url.replace(/\/$/,'')===`https://github.com/${repo.full_name}`))continue;
        try{const r=await read(`https://api.github.com/repos/${repo.full_name}/readme`),body=JSON.parse(r.body.toString());if(body.encoding!=='base64')continue;const text=Buffer.from(body.content,'base64').toString('utf8').slice(0,3000);sources.push({id:'source-'+(sources.length+1),url:`https://github.com/${repo.full_name}`,title:repo.full_name,text,checkedAt:Date.now()});}catch(e){if(signal.aborted||e.code==='BUDGET_EXCEEDED')throw e;}}
    }
    if(!sources.length)return {summary:'근거를 확인한 대안이 없습니다. 다른 공식 문서 URL을 직접 입력할 수 있습니다.',suggestionIds:[]};
    const result=await this.models.ask(id,'H','Select only candidates supported by supplied official repository or user-provided documentation. Link the current limitation to a concrete documented feature. Include an exact quote from that source. Never claim untested candidates are faster, cheaper, or more accurate. State uncertainties. Return empty candidates if unrelated or evidence insufficient. Unsupported GPU/OAuth/remote DB requirements must not be offered as executable.',{...context,source:undefined,sources},AlternativeAnalysis,{signal});
    this.store.assertActive(this.store.get(id));const saved=[];
    this.store.tx(()=>{for(const c of result.candidates){const source=sources.find(s=>s.id===c.sourceId);if(!source||!source.text.includes(c.quote))continue;const signature=digest({basis,url:source.url});if(records(this.db,eid,'suggestion').some(s=>s.signature===signature))continue;
      saved.push(putRecord(this.db,eid,'suggestion',this.clean({kind:'alternative',title:source.title,url:source.url,reason:c.reason,limitation:c.limitation,unknowns:c.unknowns,source:{url:source.url,quote:c.quote,checkedAt:source.checkedAt},evidenceLevel:'문서에서 확인 · 직접 실행 미검증',basedOn:basis,signature,createdAt:Date.now()},eid)));}});
    return {summary:result.summary,suggestionIds:saved.map(c=>c.id),searchScope:candidateURL?'직접 입력한 문서':'공개 GitHub 저장소·README (최대 3개)'};
  }
  transition(eid,owner,body,key,policy){
    this.get(eid,owner);const card=body.suggestionId?this.record(eid,body.suggestionId,'suggestion'):null;if(card&&card.kind!=='alternative')fail('INVALID_REQUEST','대안 카드를 선택해주세요.');
    const url=noAuthURL(card?.url||body.url),basis=card?.basedOn||this.basedOn(eid,body.jobId,body.runId);
    if(typeof key!=='string'||!/^[\w-]{8,100}$/.test(key))fail('INVALID_REQUEST','중복 방지 요청 ID가 필요합니다.');
    const previous=this.db.prepare('SELECT doc FROM jobs WHERE owner=? AND dedup=?').get(owner,key);
    if(previous){const j=JSON.parse(previous.doc);if(j.url!==url||j.evaluationId!==eid)fail('CONFLICT','같은 요청의 대상이 변경됐습니다.',409);return j;}
    this.assertBasis(eid,basis);
    const transition={id:randomUUID(),fromJobId:basis.jobId,runId:basis.runId,url,reason:card?.reason||String(body.reason||'사용자가 선택한 대안').slice(0,1500),unknowns:card?.unknowns||'새 도구에서의 기능·실행 조건 미검증',source:card?.source||null,goalVersion:basis.goalVersion,createdAt:Date.now()};
    const job=this.store.create(owner,url,key,policy,{evaluationId:eid,transitionId:transition.id});putRecord(this.db,eid,'transition',{...transition,toJobId:job.id});this.orchestrator.start(job.id);return job;
  }
  recipe(eid,owner,jobId){this.get(eid,owner);const j=this.store.get(jobId);if(!j||j.evaluationId!==eid)fail('NOT_FOUND','체험을 찾을 수 없습니다.',404);return makeRecipe(this.clean(j,eid));}
  report(eid,owner,body){
    if(body.format!=='md')fail('UNSUPPORTED_FORMAT','현재는 Markdown 형식만 지원합니다.');
    const s=this.snapshot(eid,owner);
    if(body.runIds&&(!Array.isArray(body.runIds)||body.runIds.length!==1))fail('INVALID_INPUT','실행 한 건만 선택해주세요.');
    const runId=body.runId||body.runIds?.[0],candidates=s.runs.filter(r=>(!body.jobId||r.jobId===body.jobId)&&r.state!=='running');
    const run=runId?candidates.find(r=>r.id===runId):candidates.at(-1);
    if(!run)fail('NO_RESULTS','완료된 실행 결과 한 건이 필요합니다.');
    s.runs=[run];s.jobs=s.jobs.filter(j=>j.id===run.jobId);s.transitions=[];s.selection=null;
    let fingerprint=digest({kind:'single-run',goals:s.goals,runs:s.runs,format:body.format,ai:body.ai===true});
    const existing=records(this.db,eid,'report').find(r=>r.fingerprint===fingerprint);if(existing&&existing.expiresAt>Date.now()&&!(body.retry===true&&['FAILED','CANCELLED'].includes(existing.state)))return existing;if(existing)fingerprint=digest({fingerprint,regeneration:records(this.db,eid,'report').length});
    if(records(this.db,eid,'report').length>=10)fail('LIMIT','보관 가능한 리포트 10개 한도입니다.');
    s.capturedAt=Date.now();const recipes=[...new Set(s.runs.map(r=>r.jobId))].map(id=>this.recipe(eid,owner,id)),expiresAt=Math.min(s.expiresAt,Date.now()+7*86400_000);
    const render=notes=>{const markdown=singleRunReport(s,recipes,notes);if(Buffer.byteLength(markdown)>5_000_000)fail('REPORT_TOO_LARGE','리포트가 5MB를 초과합니다. 포함할 실험 수를 줄여주세요.');return {markdown,snapshotRevision:s.revision,runIds:s.runs.map(r=>r.id),expiresAt,format:'md'};};
    if(!body.ai)return this.store.tx(()=>putRecord(this.db,eid,'report',{...render([]),fingerprint,state:'COMPLETED',createdAt:Date.now()}));
    return this.task(eid,owner,'report',fingerprint,{expiresAt,format:'md',runIds:s.runs.map(r=>r.id)},async(id,signal)=>{
      const result=await this.models.ask(id,'R','Write a brief single-run interpretation anchored to the supplied run IDs, expectations and feedback. Do not invent metrics, costs, rankings, final choices or test results. Distinguish conditions and unknowns. These are supplementary notes; deterministic report contains actual facts.',{goals:s.goals,runs:s.runs.map(r=>({id:r.id,title:r.title,assessment:r.assessment,feedback:r.feedback,changes:r.changes,output:responseSample(r.output,1500)}))},ReportNotes,{signal});return render(result.notes.filter(n=>s.runs.some(r=>r.id===n.runId)));});
  }
  select(eid,owner,body){return this.store.tx(()=>{const e=this.get(eid,owner),j=this.jobs(eid).find(j=>j.id===body.jobId);if(!j)fail('NOT_FOUND','선택할 도구를 찾을 수 없습니다.',404);e.selection={jobId:j.id,title:j.plan?.title||j.url,reason:String(body.reason||'').slice(0,2000),at:Date.now()};return putEvaluation(this.db,e);});}
  async cancelTask(eid,owner,id){this.get(eid,owner);const j=this.store.get(id);if(!j||j.evaluationId!==eid||!j.taskType)fail('NOT_FOUND','분석 작업을 찾을 수 없습니다.',404);this.running.get(id)?.abort();if(PREPARING.has(j.state))this.store.update(id,x=>{x.state='CANCELLED';x.activeSince=null;});}
  async remove(eid,owner){
    const raw=this.db.prepare('SELECT doc FROM evaluations WHERE id=? AND owner=?').get(eid,owner);if(!raw)fail('NOT_FOUND','평가 프로젝트를 찾을 수 없습니다.',404);
    for(const j of this.store.all().filter(j=>j.evaluationId===eid))if(j.taskType)this.running.get(j.id)?.abort();else if(!TERMINAL.has(j.state))await this.orchestrator.cancel(j.id);
    const cleanups=this.jobs(eid);if(cleanups.some(j=>j.cleanupPending||this.orchestrator.running?.has(j.id)))fail('CLEANUP_PENDING','실행 작업과 환경 정리가 끝난 뒤 삭제를 다시 시도해주세요.',409);
    for(const j of cleanups)if(/^[a-f0-9-]{36}$/.test(j.id))await unlink(join(this.orchestrator.dir||'data','evidence',j.id+'.png')).catch(e=>{if(e.code!=='ENOENT')throw e;});
    this.store.tx(()=>{for(const j of this.store.all().filter(j=>j.evaluationId===eid)){this.store.secret(j.id,null);this.db.prepare('DELETE FROM events WHERE job=?').run(j.id);this.db.prepare('UPDATE jobs SET doc=?,state=? WHERE id=?').run(JSON.stringify({id:j.id,owner:j.owner,evaluationId:eid,state:'EXPIRED',purged:true,taskType:j.taskType,createdAt:j.createdAt,policy:j.policy}), 'EXPIRED',j.id);}
      this.db.prepare('DELETE FROM evaluation_files WHERE evaluation=?').run(eid);this.db.prepare("DELETE FROM evaluation_keys WHERE json_extract(record,'$.id') IN (SELECT id FROM evaluation_records WHERE evaluation=?)").run(eid);this.db.prepare('DELETE FROM evaluation_records WHERE evaluation=?').run(eid);this.db.prepare('DELETE FROM evaluations WHERE id=?').run(eid);});
  }
  async sweep(){this.files.expire();if(this.autoExperience)for(const row of this.db.prepare("SELECT doc FROM evaluation_records WHERE type='run' AND json_extract(doc,'$.experiencePending')=1").all()){const r=JSON.parse(row.doc);try{this.scheduleExperience(r.evaluationId,this.get(r.evaluationId).owner,r.id);}catch{}}for(const row of this.db.prepare('SELECT doc FROM evaluations').all()){const e=JSON.parse(row.doc);if(e.expiresAt<=Date.now())await this.remove(e.id,e.owner).catch(()=>{});}
    for(const r of this.db.prepare("SELECT id,doc FROM evaluation_records WHERE type='report'").all()){const d=JSON.parse(r.doc);if(d.expiresAt<=Date.now()&&d.markdown){delete d.markdown;d.state='EXPIRED';this.db.prepare('UPDATE evaluation_records SET doc=? WHERE id=?').run(JSON.stringify(d),r.id);}}
    this.db.prepare('DELETE FROM requests WHERE day<? AND status=?').run(new Date(Date.now()-90*86400_000).toISOString().slice(0,10),'settled');
  }
  recover(){for(const row of this.db.prepare('SELECT * FROM evaluation_records').all()){const r=JSON.parse(row.doc);if(r.type==='run'&&r.state==='running'){r.state='unknown';r.error='서버 재시작으로 처리 여부를 확인할 수 없습니다. 자동 재전송하지 않았습니다.';this.db.prepare('UPDATE evaluation_records SET doc=? WHERE id=?').run(JSON.stringify(r),r.id);}else if(['analysis','report'].includes(r.type)&&r.state==='ANALYZING'){r.state='FAILED';r.error='서버 재시작으로 중단됐습니다.';this.db.prepare('UPDATE evaluation_records SET doc=? WHERE id=?').run(JSON.stringify(r),r.id);}}}
}
