const line=value=>String(value??'미확인').replace(/[\r\n]+/g,' ').replace(/[|<>]/g,c=>({'|':'\\|','<':'&lt;','>':'&gt;'}[c]));
const block=value=>{const text=typeof value==='string'?value:JSON.stringify(value,null,2),n=Math.max(3,...[...text.matchAll(/`+/g)].map(m=>m[0].length+1));return '`'.repeat(n)+'\n'+text+'\n'+'`'.repeat(n);};
const states={met:'충족',partial:'부분 충족',unmet:'미충족',unknown:'미확인',succeeded:'실행 성공',failed:'실행 실패',running:'실행 중',satisfied:'만족',unsatisfied:'불만족',unsure:'판단 보류'};
export function makeRecipe(j){
  const verified=j.verifiedVersion&&j.verifiedVersion===j.version&&j.evidence?.some(e=>e.role==='E');
  if(!verified)return {available:false,reason:'기능·브라우저 검증을 통과한 실행 레시피가 없습니다.'};
  const journal=j.journal||[],commands=journal.filter(x=>x.exitCode===0&&!x.redacted),failures=journal.filter(x=>Number.isInteger(x.exitCode)&&x.exitCode!==0),files=j.recipeFiles||[];
  const parts=[`# ${line(j.plan.title)} — 확인된 실행 레시피`,`- 대상: ${line(j.url)}\n- 커밋: ${line(j.source?.commit)}\n- 검증 버전: ${line(j.verifiedVersion)}\n- 런타임: ${line(j.executionMode==='node-api'?'Node.js '+j.nodeVersion:j.plan.runtime)}\n- DB: ${line(j.plan.database.kind)}`,
    j.executionMode==='node-api'?'앱 Node.js 서버에서 직접 HTTP 호출한 검증 기록입니다. 별도 설치·샌드박스는 사용하지 않았습니다. 인증키는 포함하지 않습니다.':'이 레시피는 원래 Daytona 환경의 성공 기록입니다. 깨끗한 환경에서의 재현은 별도로 검증하지 않았습니다. 다운로드는 명령을 실행하지 않습니다.'];
  if(!journal.length&&j.executionMode!=='node-api')parts.push('명령 원장 도입 전 작업입니다. 추측한 설치·실행 명령을 제공하지 않습니다.');
  if(j.plan.kind==='api')parts.push('## API 호출 계약',block({method:j.plan.endpoint.method,url:j.plan.endpoint.url,fields:j.plan.fields,authentication:{kind:j.plan.auth.kind,name:j.plan.auth.name,issueUrl:j.plan.auth.issueUrl,instructions:j.plan.auth.instructions}}));
  if(j.executionMode==='node-api')parts.push('## 실제 HTTP 호출 기록',block((j.apiRequestHistory||[]).filter(r=>r.version===j.verifiedVersion)));
  else parts.push('## 실행된 명령');
  for(const c of commands)parts.push(`### ${line(c.kind||'command')} · ${new Date(c.at).toISOString()}\n작업 디렉터리: ${line(c.cwd)}\n환경변수 이름: ${line((c.envNames||[]).join(', ')||'없음')}`,block(c.command),c.observation?`관측한 버전/의존성:\n${block(c.observation)}`:'');
  const starts=journal.filter(c=>c.kind==='start'&&c.version===j.verifiedVersion&&!c.redacted);
  if(starts.length)parts.push('## 검증한 서버 시작 명령',...starts.map(c=>block(c.command)));
  if(j.executionMode!=='node-api')parts.push('## 실제 업로드한 파일과 적용 순서');for(const f of files)parts.push(`### ${line(f.path)} · 계획 ${f.planVersion}`,block(f.content));
  parts.push('## 환경변수 설정',j.plan.auth.kind==='none'?'외부 인증 키 불필요.':`이름: ${line(j.plan.auth.name)}\n${line(j.plan.auth.instructions)}\n공식 발급 경로: ${line(j.plan.auth.issueUrl)}`);
  if(j.plan.database.kind!=='none')parts.push('DATABASE_URL: 새 테스트 DB의 연결 정보를 환경변수로 설정하세요. 원래 비밀번호는 내보내지 않습니다. DB 초기화·시드 명령은 테스트 DB에서만 실행하세요.');
  if(journal.some(c=>c.redacted))parts.push('비밀정보가 포함된 명령은 제외했습니다. 위 환경변수 설정을 완료해야 하며 그대로 실행 가능한 완전한 스크립트라고 보장하지 않습니다.');
  parts.push('## 문제와 해결 이력',...failures.map(f=>`- 계획 ${f.planVersion}의 실제 실패: ${line(f.error||'명령 실패')}`),failures.length?'위 성공 명령·파일은 실패 이후 실제로 적용된 내역입니다. 관측하지 않은 인과관계는 단정하지 않습니다.':'기록된 실패 없음.');
  parts.push('## 검증한 기능',line(j.plan.capability),block(j.evidence.map(e=>({role:e.role,version:e.version,at:e.at,description:e.description||e.scenario}))), '## 검증 입력',block(j.sample||{}),'## 보관 범위','입력 파일은 별도 보관 기간을 따릅니다. 패키지 캐시·임시 DB·비밀정보는 포함하지 않습니다.');
  return {available:true,version:j.verifiedVersion,markdown:parts.filter(Boolean).join('\n\n'),files,verifiedAt:j.evidence.at(-1)?.at};
}

export function singleRunReport({run:r,job,goal,createdAt},recipe) {
  const parts=[`# ${line(job?.title||r.title)} — 단건 실행 리포트`,
    `작성 시각: ${new Date(createdAt).toISOString()}\n실행 ID: ${r.id}\n대상: ${line(job?.url)}\n버전: ${line(r.version)}`,
    '## 이번 실험의 목적',line(goal?.purpose||r.check||'입력한 조건에서 기본 기능 확인'),
    `실험: ${line(r.title)}\n확인할 조건: ${line(r.check||'별도 기대 조건 미설정')}\n실험 이유: ${line(r.reason)}`,
    '## 실행과 목적 충족',`- 실행 상태: ${states[r.state]||r.state}\n- HTTP 상태: ${line(r.status)}\n- 목적 충족: ${states[r.assessment.status]}\n- 사용자 만족: ${states[r.feedback?.satisfaction]||'미응답'}`,
    '실행 성공은 목적 충족을 뜻하지 않습니다. 주관적인 품질과 확인하지 않은 조건은 미확인으로 남깁니다.',
    '## 실제 입력',block(r.input),'## 실제 출력 또는 오류',block(r.output??{error:r.error||r.state}),
    '## 기대 조건과 검증 근거',block(r.assessment),
    '## 사용자 피드백',r.feedback?block(r.feedback):'등록된 피드백 없음.',
    '## 실행 환경과 관측 시간',block(r.environment||{}),
    `출처: ${line(r.provenance)}\n관측 시간: ${r.durationMs==null?'미측정':r.durationMs+' ms'}\n측정 범위: ${line(r.measurement||r.manualConditions)}`,
    '시간은 해당 실행 1회의 왕복 관측값입니다. 반복 성능 측정이나 제공사 서버 처리 시간이 아닙니다.',
    '## 비용',r.cost?.externalMicros==null?'외부 API 청구액: 확인 불가.':r.cost.kind==='user_declared_free'?'외부 API: 사용자가 확인한 무료 한도. 제공사 청구 자료 미연결.':`외부 API 예약 상한: $${(r.cost.externalMicros/1e6).toFixed(4)}. 실제 청구 확정액이 아닙니다.`,
    '모델·GPU 임대·환경 준비 비용: 실행 한 건에 정확히 배분할 수 없어 확인 불가. 확인하지 않은 비용은 0으로 표기하지 않습니다.',
    '## 미확인 사항','이 문서는 선택한 실행 한 건의 고정된 기록입니다. 하나의 결과를 다른 입력 전체에 일반화할 수 없습니다. 보관이 만료된 파일은 다시 확보해야 재현할 수 있습니다.',
    '## 검증된 실행 레시피',recipe?.available&&recipe.version===r.version?recipe.markdown:'이 실행 버전에 대응하는 검증된 레시피가 없습니다.'];
  return parts.join('\n\n');
}
