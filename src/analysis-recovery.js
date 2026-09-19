import {analyze} from './analyze.js';
import {recoverDocumentation} from './documentation.js';
import {hash} from './store.js';
import {apiEvidence} from './api-evidence.js';

// Two distinct recovery actions, sharing the job's repair, model and tool
// budgets. No target API invocation is used as a documentation shortcut.
export async function analyzeWithRecovery(id,source,{store,models,signal,onSource=()=>{},onFailure=()=>{},recoverSource=recoverDocumentation}){
  const feedback=[];
  const active=()=>{signal?.throwIfAborted();store.assertActive(store.get(id));};
  const finish=status=>{if(store.get(id).analysisRecovery?.at(-1)?.status==='running')store.update(id,j=>{const item=j.analysisRecovery.at(-1);item.status=status;item.finishedAt=Date.now();});};
  for(let attempt=0;;attempt++){
    active();
    try{
      const plan=await analyze(id,source,models,signal,{feedback});active();onSource();finish('recovered');return plan;
    }catch(error){
      try{active();}catch(e){finish('stopped');throw e;}onSource();
      if(error.code!=='DOCUMENTATION_INCOMPLETE'){finish('stopped');throw error;}
      finish('insufficient');onFailure(error);
      if(attempt>=2){error.message=`분석 근거 재검토와 추가 문서 확인 후에도 준비하지 못했습니다. ${error.message}`;throw error;}
      store.count(id,'analysisRecoveries');
      const action=attempt===0?'review':'collect';
      store.repair(id,hash({phase:'analysis',action,reason:error.message}));
      feedback.push({attempt:attempt+1,action,reason:error.message});
      store.update(id,j=>{j.state='ANALYZING';j.message=action==='review'?'분석 복구 1/2 · 누락된 호출 근거를 다시 확인하고 있어요':'분석 복구 2/2 · 필요한 연결 문서와 동적 본문을 보완하고 있어요';j.analysisRecovery??=[];j.analysisRecovery.push({...feedback.at(-1),status:'running',at:Date.now()});});
      if(action==='collect'){
        try{
          const extra=await recoverSource(source,error.message,()=>{active();store.count(id,'documentRequests');store.count(id,'tools');},{signal,
            onPage:()=>{active();store.count(id,'documentPages');},
            onProgress:progress=>{active();store.update(id,j=>{j.message='분석 복구 2/2 · '+progress.message;});}
          });
          active();
          const signature=s=>hash({text:s.text,evidence:apiEvidence(s),images:(s.images||[]).map(i=>i.url)});
          if(signature(extra)===signature(source)){finish('no-new-evidence');error.message=`추가로 확인할 새로운 근거가 없습니다. ${error.message}`;throw error;}
          Object.assign(source,extra);onSource();
          store.update(id,j=>{j.documentation={...j.documentation,...source.stats,pages:source.pages,warnings:source.warnings};j.message='분석 복구 2/2 · 보완한 근거로 실행 가능성을 다시 판단하고 있어요';});
        }catch(e){finish('stopped');throw e;}
      }
    }
  }
}
