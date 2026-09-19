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

export function singleRunReport(s,recipes=[],notes=[]) {
 const r=s.runs[0],job=s.jobs.find(j=>j.id===r.jobId),goal=s.goals.find(g=>g.version===r.goalVersion);
 const parts=[`# ${line(job?.title||r.title)} — 단건 실행 리포트`, `대상: ${line(job?.url)}\n실행 ID: ${r.id}\n실행 버전: ${line(r.version)}\n작성 시각: ${new Date(s.capturedAt).toISOString()}`,
 '## 실행 상태',states[r.state]||line(r.state),'## 목적과 조건',block(goal||{}),'## 입력',block(r.input||{}),'## 실제 결과 또는 오류',block(r.output??{error:r.error||r.state}),'## 조건별 검증',block(r.assessment||{}),'## 사용자 피드백',block(r.feedback||{}),'## 실행 환경',block(r.environment||{}),
 '## 측정 범위',`결과 출처: ${line(r.provenance)}\n소요 시간: ${r.durationMs==null?'미측정':r.durationMs+' ms (1회 왕복)'}\n외부 API 비용: ${r.cost?.externalMicros==null?'미확인':r.cost.kind==='user_declared_free'?'사용자 확인 무료 한도 (제공사 미검증)':'$'+(r.cost.externalMicros/1e6).toFixed(4)+' 예약 상한'}\nDaytona 청구액과 실행별 모델 비용은 미확인입니다. Nosana 직접 배포 GPU 임대료는 토큰 요금에 포함되지 않으며 제공사 배포 내역에서 별도로 확인해야 합니다.`,
 '단일 실행 기록이며 모든 입력의 성공을 보장하지 않습니다. 사용자 등록 결과는 자동 검증과 구분됩니다.'];
 if(notes.length)parts.push('## 참고 해석',...notes.map(n=>line(n.interpretation)));
 parts.push('## 확인된 실행 방법',...recipes.map(r=>r.available?r.markdown:r.reason));return parts.join('\n\n');
}
