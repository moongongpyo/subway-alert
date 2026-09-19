const line=value=>String(value??'미확인').replace(/[\r\n]+/g,' ').replace(/[|<>]/g,c=>({'|':'\\|','<':'&lt;','>':'&gt;'}[c]));
const block=value=>{const text=typeof value==='string'?value:JSON.stringify(value,null,2),n=Math.max(3,...[...text.matchAll(/`+/g)].map(m=>m[0].length+1));return '`'.repeat(n)+'\n'+text+'\n'+'`'.repeat(n);};
const states={met:'충족',partial:'부분 충족',unmet:'미충족',unknown:'미확인',succeeded:'실행 성공',failed:'실행 실패',running:'실행 중',satisfied:'만족',unsatisfied:'불만족',unsure:'판단 보류'};
export function makeRecipe(j){
  const verified=j.verifiedVersion&&j.verifiedVersion===j.version&&j.evidence?.some(e=>e.role==='E');
  if(!verified)return {available:false,reason:'기능·브라우저 검증을 통과한 실행 레시피가 없습니다.'};
  const journal=j.journal||[],commands=journal.filter(x=>x.exitCode===0&&!x.redacted),failures=journal.filter(x=>Number.isInteger(x.exitCode)&&x.exitCode!==0),files=j.recipeFiles||[];
  const parts=[`# ${line(j.plan.title)} — 확인된 실행 레시피`,`- 대상: ${line(j.url)}\n- 커밋: ${line(j.source?.commit)}\n- 검증 버전: ${line(j.verifiedVersion)}\n- 런타임: ${line(j.plan.runtime)}\n- DB: ${line(j.plan.database.kind)}`,
    '이 레시피는 원래 Daytona 환경의 성공 기록입니다. 깨끗한 환경에서의 재현은 별도로 검증하지 않았습니다. 다운로드는 명령을 실행하지 않습니다.'];
  if(!journal.length)parts.push('명령 원장 도입 전 작업입니다. 추측한 설치·실행 명령을 제공하지 않습니다.');
  if(j.plan.kind==='api')parts.push('## API 호출 계약',block({method:j.plan.endpoint.method,url:j.plan.endpoint.url,fields:j.plan.fields,authentication:{kind:j.plan.auth.kind,name:j.plan.auth.name,issueUrl:j.plan.auth.issueUrl,instructions:j.plan.auth.instructions}}));
  parts.push('## 실행된 명령');
  for(const c of commands)parts.push(`### ${line(c.kind||'command')} · ${new Date(c.at).toISOString()}\n작업 디렉터리: ${line(c.cwd)}\n환경변수 이름: ${line((c.envNames||[]).join(', ')||'없음')}`,block(c.command),c.observation?`관측한 버전/의존성:\n${block(c.observation)}`:'');
  const starts=journal.filter(c=>c.kind==='start'&&c.version===j.verifiedVersion&&!c.redacted);
  if(starts.length)parts.push('## 검증한 서버 시작 명령',...starts.map(c=>block(c.command)));
  parts.push('## 실제 업로드한 파일과 적용 순서');for(const f of files)parts.push(`### ${line(f.path)} · 계획 ${f.planVersion}`,block(f.content));
  parts.push('## 환경변수 설정',j.plan.auth.kind==='none'?'외부 인증 키 불필요.':`이름: ${line(j.plan.auth.name)}\n${line(j.plan.auth.instructions)}\n공식 발급 경로: ${line(j.plan.auth.issueUrl)}`);
  if(j.plan.database.kind!=='none')parts.push('DATABASE_URL: 새 테스트 DB의 연결 정보를 환경변수로 설정하세요. 원래 비밀번호는 내보내지 않습니다. DB 초기화·시드 명령은 테스트 DB에서만 실행하세요.');
  if(journal.some(c=>c.redacted))parts.push('비밀정보가 포함된 명령은 제외했습니다. 위 환경변수 설정을 완료해야 하며 그대로 실행 가능한 완전한 스크립트라고 보장하지 않습니다.');
  parts.push('## 문제와 해결 이력',...failures.map(f=>`- 계획 ${f.planVersion}의 실제 실패: ${line(f.error||'명령 실패')}`),failures.length?'위 성공 명령·파일은 실패 이후 실제로 적용된 내역입니다. 관측하지 않은 인과관계는 단정하지 않습니다.':'기록된 실패 없음.');
  parts.push('## 검증한 기능',line(j.plan.capability),block(j.evidence.map(e=>({role:e.role,version:e.version,at:e.at,description:e.description||e.scenario}))), '## 검증 입력',block(j.sample||{}),'## 보관 범위','입력 파일은 별도 보관 기간을 따릅니다. 패키지 캐시·임시 DB·비밀정보는 포함하지 않습니다.');
  return {available:true,version:j.verifiedVersion,markdown:parts.filter(Boolean).join('\n\n'),files,verifiedAt:j.evidence.at(-1)?.at};
}

export function comparisonReport(snapshot,recipes=[],notes=[]) {
  const s=snapshot,goal=s.goals.at(-1),parts=[`# ${line(goal?.purpose||'기본 기능 체험')} — 비교 리포트`,
    `작성 시각: ${new Date(s.capturedAt).toISOString()}\n기록 버전: ${s.revision}\n형식: Markdown\n선택 기록: ${s.runs.length}개\n최종 선택: ${line(s.selection?.title||'미정')}`,
    '## 최초 목적과 기대 조건',block(s.goals[0]||{purpose:'기본 기능 확인; 목적 미설정'}),'## 목적 변경 과정',...s.goals.map(g=>`- v${g.version}: ${line(g.purpose)} · 제약: ${line(g.constraints||'미설정')}`),
    '## 서비스별 실제 결과','| 도구 / 실행 | 실행 상태 | 목적 충족 | 사용자 만족 | 관측 시간 | 외부 API 비용 |\n| --- | --- | --- | --- | --- | --- |',
    ...s.runs.map(r=>`| ${line(s.jobs.find(j=>j.id===r.jobId)?.title)} / ${r.id.slice(0,8)} | ${states[r.state]||r.state} | ${states[r.assessment.status]} | ${states[r.feedback?.satisfaction]||'미응답'} | ${r.durationMs==null?'미측정':r.durationMs+' ms / 1회 왕복'} | ${r.cost?.externalMicros==null?'확인 불가':r.cost.kind==='user_declared_free'?'사용자 확인 무료 한도 (제공사 미검증)':('$'+(r.cost.externalMicros/1e6).toFixed(4)+' 예약 상한')} |`),
    '시간은 제어 서버에서 관측한 1회 실행 왕복입니다. 제공사 서버 처리 시간이나 반복 성능 벤치마크가 아닙니다. 원래 UI에서 등록한 결과는 사용자 등록이며 실행 시간은 측정하지 않았습니다.',
    '## 실험의 발전과 조건 차이'];
  for(const r of s.runs){const prior=s.runs.find(p=>p.id===r.parentRunId);const same=prior&&JSON.stringify(prior.input)===JSON.stringify(r.input)&&prior.goalVersion===r.goalVersion&&prior.version===r.version;
    parts.push(`### ${line(r.title)} · ${r.id}`,`- 목적 버전: ${r.goalVersion}\n- 제안 이유: ${line(r.reason)}\n- 확인할 조건: ${line(r.check)}\n- 이전 실험: ${r.parentRunId||'없음'}\n- 비교 가능성: ${same?'같은 명시 입력·목적·버전; DB 상태·캐시는 별도 확인 필요':'일부 조건 차이 또는 직접 비교 어려움; 입력·버전·환경을 확인하세요.'}\n- 결과 출처: ${line(r.provenance)}\n- 사용 조건: ${line(r.manualConditions||r.measurement)}\n- 관측 환경: ${line(JSON.stringify(r.environment))}`,
      '입력·파일 참조:',block(r.input),'이전 대비 변경:',block(r.changes),'실제 출력 또는 오류:',block(r.output??{error:r.error||r.state}),'조건별 평가:',block(r.assessment),r.feedback?'사용자 피드백:\n'+block(r.feedback):'사용자 피드백 없음.');
  }
  parts.push('## 설치·인증·검증 과정',...s.jobs.map(j=>`- ${line(j.title)}: ${line(j.state)}, 버전 ${line(j.version)}, 준비 작업 ${j.id}. 세부 명령·인증 방식은 아래 레시피 참조.`),
    '## 대안 선택의 근거',...s.transitions.map(t=>`- ${line(t.reason)}\n  출처: ${line(t.url)}\n  미검증: ${line(t.unknowns||'새 입력에서의 실제 품질·시간·비용')}`),
    '## 사용량과 비용',`프로젝트 누적 모델 비용의 요율 기반 기록: $${(s.usage.micros/1e6).toFixed(4)}. 이 중 예약·미확정: $${(s.usage.reserved/1e6).toFixed(4)}. 청구 확정액이 아닙니다.\n모델 요청 ${s.usage.calls}회. 준비·추가 분석·리포트의 공통 예산이며 도구별 호출 단가와 다릅니다.\nNosana 직접 배포 GPU 임대료: 토큰 요금에 포함되지 않으며 제공사 배포 내역에서 별도 확인.\nDaytona 청구액: 확인 불가. 외부 API 청구액: 제공사 청구 자료 미연결. 미확정 비용을 0으로 합산하지 않습니다.`,
    '## 최종 선택과 미확인 사항',s.selection?`사용자 선택: ${line(s.selection.title)}\n선택 이유: ${line(s.selection.reason)}`:'최종 선택 미정. 충족·미확인 조건과 사용자 피드백을 바탕으로 선택할 수 있습니다.',
    '서로 다른 조건의 실험에 임의의 점수·순위를 붙이지 않았습니다. 단일 입력의 결과를 모든 입력에 일반화할 수 없습니다. 보관 만료된 파일은 다시 확보해야 재현할 수 있습니다.');
  if(notes.length)parts.push('## 모델의 참고 해석',...notes.map(n=>`- 실행 ${n.runId}: ${line(n.interpretation)}\n  위 해석은 추가 검증 결과가 아니며 실제 출력·사용자 피드백을 우선합니다.`));
  parts.push('## 재현용 실행 레시피',...recipes.map(r=>r.available?r.markdown:r.reason));
  return parts.join('\n\n');
}
