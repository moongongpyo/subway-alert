import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preparationProgress,preparationNotice,jobStateLabel} from '../public/preparation-status.js';

test('progress never animates or claims analysis is running after completion or termination',()=>{
  for(const state of ['FAILED','UNSUPPORTED','CANCELLED','EXPIRED','READY'])for(const connected of [true,false]){
    const view=preparationProgress({state,steps:[]},connected);
    assert.equal(view.animated,false,state);assert.equal(view.barClass,'progress-fill');assert.doesNotMatch(view.label,/분석 중|준비 중$|연결 확인 중/);
  }
  const failed=preparationProgress({state:'FAILED',steps:[{status:'completed'},{status:'failed'},{status:'cancelled'}]});
  assert.equal(failed.animated,false);assert.ok(Math.abs(failed.width-100/3)<0.00001);assert.match(failed.label,/준비 중단/);assert.equal(failed.done,1);
});

test('indeterminate progress belongs only to connected active work, never to input waits',()=>{
  for(const state of ['ANALYZING','PREPARING','VERIFYING']){
    assert.equal(preparationProgress({state,steps:[]}).animated,true);
    assert.equal(preparationProgress({state,steps:[]},false).animated,false);
    assert.equal(preparationProgress({state,steps:[{status:'pending'}]}).animated,false);
  }
  for(const waitKind of ['source','sample','credentials','connection']){
    const view=preparationProgress({state:'WAITING_FOR_USER',waitKind,steps:[]});assert.equal(view.animated,false);assert.match(view.label,/대기$/);
  }
});

test('cost configuration blocks are distinguished from unsupported tools, including saved old jobs',()=>{
  const old={state:'UNSUPPORTED',reason:'UNSUPPORTED',steps:[],message:'apis.openapi.sk.com의 호출 요금 상한이 설정되지 않았습니다. 운영자가 FREE_API_HOSTS 또는 PAID_API_RATES에 확인된 요금을 등록해야 합니다.'};
  const fresh={state:'FAILED',reason:'EXTERNAL_PRICING_REQUIRED',steps:[]};
  for(const job of [old,fresh]){assert.equal(jobStateLabel(job),'API 연결 필요');assert.equal(preparationProgress(job).animated,false);assert.match(preparationNotice(job).message,/문서 분석은 완료/);assert.doesNotMatch(preparationNotice(job).title,/어려워/);}
  assert.equal(jobStateLabel({state:'FAILED',reason:'EXTERNAL_BUDGET_REQUIRED'}),'호출 예산 확인 필요');
  assert.equal(jobStateLabel({state:'UNSUPPORTED',message:'GPU 필수',reason:'UNSUPPORTED'}),'지원 범위 밖');
});

test('network timeouts remain connection failures, including older model misclassifications',()=>{
  const old={state:'UNSUPPORTED',reason:'UNSUPPORTED',networkMode:'organization',message:'HTTP만 제공하므로 지원 불가',failures:Array.from({length:3},()=>({code:'EXECUTION_FAILED',message:'HTTP 응답 시간이 초과됐습니다.'}))};
  for(const j of [old,{state:'FAILED',reason:'EXTERNAL_UNREACHABLE',networkMode:'organization'}]){
    assert.equal(jobStateLabel(j),'외부 API 연결 실패');assert.equal(preparationProgress(j).animated,false);assert.match(preparationNotice(j).message,/Internet Access/);assert.doesNotMatch(preparationNotice(j).title,/지원|어려워/);
  }
  assert.equal(jobStateLabel({state:'UNSUPPORTED',reason:'UNSUPPORTED',message:'GPU 필수'}),'지원 범위 밖');
});
