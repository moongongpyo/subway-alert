import { validateInput } from './contracts.js';
import { PREPARING, fail } from './config.js';
import { digest, records, putRecord } from './evaluation-data.js';
import { PrefetchedExperiments } from './evaluation-contracts.js';
import { presentationSample } from './result-presentation.js';

// Speculate only about test conditions, never about a response that has not arrived.
// One selected path ahead, with a persistent cache and no recursive expansion.
export class ExperimentPrefetch {
  constructor(evaluations){this.e=evaluations;}
  prepare(eid,owner,{jobId,input,parentRunId=null}){
    const e=this.e;e.get(eid,owner);const j=e.store.get(jobId);
    if(!j||j.owner!==owner||j.evaluationId!==eid||!j.plan)fail('NOT_FOUND','준비된 체험을 찾을 수 없습니다.',404);
    if(!e.autoPrefetch||!(['READY',...PREPARING].includes(j.state))||j.state==='WAITING_FOR_USER'||j.state==='READY'&&j.expiresAt<=Date.now())return null;
    if(j.state!=='READY'&&!j.evidence?.some(v=>v.role==='B'&&v.version===j.version))return null;
    if(parentRunId&&e.record(eid,parentRunId,'run').jobId!==jobId)fail('INVALID_REQUEST','이 도구의 이전 실행을 선택해주세요.');
    const basis=e.basedOn(eid,jobId,parentRunId);
    const values=input??j.sample??{};
    if(Object.keys(values).some(k=>!j.plan.fields.some(f=>f.name===k)))fail('INVALID_INPUT','현재 기능에 없는 입력입니다.');
    const normalized=validateInput(j.plan.fields.map(f=>({...f,required:false})),e.files.hydrate(eid,values));
    if(JSON.stringify(normalized)!==JSON.stringify(e.clean(normalized,eid)))fail('SECRET_INPUT','인증 정보는 별도 화면에서 연결해주세요.');
    const prepared=e.store.tx(()=>e.files.snapshot(eid,normalized));
    const fingerprint=digest({prefetch:1,basis,input:prepared});
    const previous=records(e.db,eid,'analysis').filter(a=>a.mode==='prefetch');
    const cached=previous.find(a=>a.fingerprint===fingerprint);if(cached)return cached;
    // At most two edited/selected paths per context. Typing and reloading cannot
    // build an unbounded speculative tree or retry a failed paid request.
    if(previous.filter(a=>digest(a.basedOn)===digest(basis)).length>=2)return null;
    if(e.store.all().some(t=>t.taskType==='prefetch'&&PREPARING.has(t.state)))return null;
    if(e.db.prepare("SELECT COUNT(*) n FROM requests r JOIN jobs j ON j.id=r.job WHERE r.status IN ('pending','unknown') AND j.state IN ('ANALYZING','PREPARING','VERIFYING','WAITING_FOR_USER')").get().n>=2)return null;
    const context=e.context(eid,basis);
    const task=e.task(eid,owner,'prefetch',fingerprint,{mode:'prefetch',basedOn:basis},async(id,signal)=>{
      const result=await e.models.ask(id,'G',
        'Prepare exactly 3 distinct next experiment cards and up to 3 useful follow-up questions for ONE next step. The user is still editing or executing preparedInput; its result is NOT known. Use documented capability, actual prior runs/feedback, and this intended input. Phrase reasons as untested conditions, never as observed failures or successes of the pending run. Do not assess or predict its output. Do not repeat previously tested conditions. Use only existing input fields and valid JSON values; quote field descriptions as evidence. Image file tests may include a synthetic asset prompt, but do not generate files or execute anything. Never suggest testing the playground UI. Keep all user-facing text concise Korean.',
        {...context,preparedInput:presentationSample(prepared,2500),pendingResult:'unknown; no response exists for this input yet'},PrefetchedExperiments,{small:true,signal});
      e.store.assertActive(e.store.get(id));e.assertBasis(eid,basis);
      const current=e.store.get(jobId);if(!current||!['READY',...PREPARING].includes(current.state))fail('STOPPED','종료된 체험의 사전 준비를 중단했습니다.');
      return {...result,input:prepared};
    });
    // If execution finishes before the draft, publish it as soon as it completes.
    e.running.get(task.id)?.promise.then(()=>{
      for(const r of records(e.db,eid,'run').filter(r=>r.prefetchTaskId===task.id))this.activate(eid,r);
    }).catch(()=>{});
    return task;
  }
  bestEffort(eid,owner,body){try{return this.prepare(eid,owner,body);}catch{return null;}}
  warmJob(id){const e=this.e,j=e.store.get(id);return this.bestEffort(j.evaluationId,j.owner,{jobId:id,input:j.sample||{}});}
  activate(eid,run){
    const e=this.e;if(run.state!=='succeeded'||!run.prefetchTaskId)return null;
    const draft=e.record(eid,run.prefetchTaskId,'analysis');if(draft.state!=='COMPLETED')return null;
    try{e.assertBasis(eid,draft.basedOn);}catch{return null;}
    if(draft.basedOn.jobId!==run.jobId||draft.basedOn.version!==run.version||digest(draft.input)!==digest(run.input))return null;
    const basis=e.basedOn(eid,run.jobId,run.id);
    if(basis.goalVersion!==draft.basedOn.goalVersion||basis.feedbackVersion!==0)return null;
    const existing=records(e.db,eid,'analysis').find(a=>a.mode==='prefetched'&&a.basedOn?.runId===run.id);if(existing)return existing;
    const saved=e.saveCards(eid,basis,draft.cards,run.input);
    if(!saved.length)return null;
    return putRecord(e.db,eid,'analysis',{mode:'prefetched',state:'COMPLETED',basedOn:basis,prefetchTaskId:draft.id,summary:draft.summary,questions:draft.questions,suggestionIds:saved.map(c=>c.id),createdAt:Date.now(),finishedAt:Date.now()});
  }
}
