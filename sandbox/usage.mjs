export function reserveInvocation(cfg, usage, phase) {
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
  const field=phase==='ready'?'userRequests':'external',total=usage.external+usage.userRequests;
  if(Number.isInteger(cfg.callLimit)&&total>=cfg.callLimit)fail('EXTERNAL_CALL_LIMIT','동의한 API 호출 횟수를 모두 사용했습니다. 새 체험에서 호출 조건을 다시 확인해주세요.');
  if(usage[field]>=(phase==='ready'?cfg.userRequests:cfg.external))fail('EXTERNAL_CALL_LIMIT','API 요청 횟수 한도에 도달했습니다.');
  const micros=cfg.requestMicros;
  if(micros!==null&&usage.micros+micros>(cfg.externalMicros??0))fail('EXTERNAL_BUDGET_REQUIRED','설정한 외부 API 호출 예산에 도달했습니다.');
  return {...usage,[field]:usage[field]+1,micros:usage.micros+(micros??0),costUnknown:usage.costUnknown||micros===null};
}
