const terminal=new Set(['FAILED','CANCELLED','EXPIRED','UNSUPPORTED']);
const active=new Set(['ANALYZING','PREPARING','VERIFYING']);
const labels={ANALYZING:'분석 중',PREPARING:'환경 준비 중',VERIFYING:'실행 확인 중',WAITING_FOR_USER:'입력 필요',READY:'체험 준비 완료',FAILED:'준비 중단',CANCELLED:'종료됨',EXPIRED:'만료됨',UNSUPPORTED:'지원 범위 밖'};

export function costBlock(job){
  // Old saved jobs used UNSUPPORTED for an application configuration error.
  if(job.reason==='EXTERNAL_PRICING_REQUIRED'||job.reason==='UNSUPPORTED'&&/호출 요금 상한이 설정되지 않았습니다/.test(job.message||''))return 'pricing';
  if(job.reason==='EXTERNAL_BUDGET_REQUIRED'||job.reason==='UNSUPPORTED'&&/API의 호출 비용이 외부 API 예산을 초과/.test(job.message||''))return 'budget';
  return null;
}
export function networkBlock(job){
  return ['EXTERNAL_UNREACHABLE','NETWORK_CHECK_FAILED','NETWORK_POLICY_REQUIRED'].includes(job.reason)||job.state==='UNSUPPORTED'&&job.networkMode==='organization'&&(job.failures||[]).filter(f=>f.code==='EXECUTION_FAILED'&&/HTTP 응답 시간.*초과/.test(f.message)).length>=2;
}
export function jobStateLabel(job){return networkBlock(job)?'외부 API 연결 실패':costBlock(job)==='pricing'?'API 연결 필요':costBlock(job)==='budget'?'호출 예산 확인 필요':labels[job.state]||job.state;}
export function preparationProgress(job,connected=true){
  const steps=job.steps||[],total=steps.length,done=steps.filter(s=>s.status==='completed').length;
  const stopped=terminal.has(job.state),waiting=job.state==='WAITING_FOR_USER';
  const animated=!total&&active.has(job.state)&&connected;
  const stage=stopped||job.state==='READY'?jobStateLabel(job):waiting?job.waitKind==='source'?'대상 선택 대기':job.waitKind==='sample'?'테스트 입력 대기':job.waitKind==='connection'?'API 연결 대기':'API 키 입력 대기':!connected?'연결 확인 중':labels[job.state]||'준비 상태 확인';
  return {stopped,done,total,animated,label:stage+(total?` · ${total}단계 중 ${done}단계 완료`:''),barClass:animated?'indeterminate':'progress-fill',width:total?done/total*100:0};
}
export function preparationNotice(job){
  if(networkBlock(job))return {title:'실행 환경에서 외부 API에 연결하지 못했어요.',message:job.networkMode==='organization'?'Daytona 계정의 강제 네트워크 제한이 적용된 상태에서 외부 연결에 실패했습니다. Daytona Limits에서 Internet Access 권한과 API 대상 허용 여부를 확인해주세요. API 기능이나 인증키가 잘못됐다고 확인된 것은 아닙니다. 연결 조건을 해결한 후 새 체험을 시작해주세요.':job.message};
  const block=costBlock(job);
  if(block==='pricing')return {title:'새 API 연결 흐름을 이용해주세요.',message:'문서 분석은 완료됐지만 이전 요금 설정 방식에서 중단된 기록입니다. 새 체험에서는 사이트 안에서 키 발급 안내와 API 키 입력, 호출 조건 확인을 진행할 수 있습니다. 운영자 설정은 필요하지 않습니다.'};
  if(block==='budget')return {title:'외부 API 호출 예산을 확인해주세요.',message:'이 체험의 호출 예산에 도달했거나 필요한 예산이 부족합니다. 새 체험의 API 연결 화면에서 호출 조건을 설정할 수 있습니다.'};
  return {title:job.state==='UNSUPPORTED'?'이 도구는 아직 준비하기 어려워요.':job.state==='EXPIRED'?'체험 시간이 끝났어요.':job.state==='CANCELLED'?'체험을 종료했어요.':'여기서 자동 실행을 멈췄어요.',message:job.message};
}
