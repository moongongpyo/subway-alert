import {el,renderFields,readInputs} from './viewer.js';
import {EvaluationPanel} from './evaluation.js';
import {Workflow,workflowSteps} from './workflow.js';
import {jobStateLabel,preparationProgress,preparationNotice,costBlock,networkBlock} from './preparation-status.js';
import {apiConnectionCard} from './api-connection.js';
const $=s=>document.querySelector(s);let current=null,stream=null,connected=true,config=null;
const terminal=new Set(['FAILED','CANCELLED','EXPIRED','UNSUPPORTED']);
const stepNames={pending:'대기',running:'진행 중',waiting_input:'입력 필요',repairing:'수정 중',completed:'완료',failed:'실패',cancelled:'취소'};
async function api(path,options={}){const r=await fetch(path,{...options,headers:{'Content-Type':'application/json','X-Playground-Request':'1',...options.headers}});const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error||'요청에 실패했습니다.'),{code:data.code});return data;}
const workflow=new Workflow();
const workflowHeader=el('section',{id:'workflow-header',hidden:''}),linkReview=el('section',{id:'link-review',hidden:''}),workflowFooter=el('nav',{id:'workflow-footer','aria-label':'단계 이동',hidden:''});
$('#job-section').before(workflowHeader,linkReview);$('#evaluation-section').after(workflowFooter);
const historyNotice=el('div',{class:'history-notice',role:'status',hidden:''});
const dismissedHistory=el('details',{class:'dismissed-history',hidden:''});
$('#recent-jobs').before(historyNotice);$('#recent-jobs').after(dismissedHistory);
const projectNameDialog=el('dialog',{id:'project-name-dialog','aria-labelledby':'project-name-title'});document.body.append(projectNameDialog);
const projectTitle=job=>job.projectName||job.plan?.title||'새로운 도구 체험';
function editProjectName(job){
  const input=el('input',{id:'project-name',name:'projectName',type:'text',value:projectTitle(job),required:'',maxlength:'80',autocomplete:'off'});
  const message=el('p',{class:'error-text',role:'alert'}),save=el('button',{class:'primary',type:'submit',text:'저장'});
  const form=el('form',{},el('div',{class:'form-field'},el('label',{for:'project-name',text:'프로젝트 이름'}),input),message,el('div',{class:'project-name-actions'},el('button',{class:'secondary',type:'button',text:'취소',onclick:()=>projectNameDialog.close()}),save));
  form.onsubmit=async event=>{
    event.preventDefault();if(!input.value.trim()){message.textContent='프로젝트 이름을 입력해주세요.';return;}save.disabled=true;
    try{const updated=await api(`/api/jobs/${job.id}/name`,{method:'PATCH',body:JSON.stringify({name:input.value.trim()})});
      if(current?.id===job.id){evaluationPanel.capture();if(updated.seq>=current.seq)current=updated;renderJob(current);await evaluationPanel.load();}
      await loadRecent();projectNameDialog.close();
    }catch(e){message.textContent=e.message;}finally{save.disabled=false;}
  };
  projectNameDialog.replaceChildren(el('div',{class:'dialog-top'},el('h2',{id:'project-name-title',text:'이름 변경'})),el('p',{class:'data-note',text:'목록과 상세 화면에 표시할 이름을 바꿉니다.'}),form);
  projectNameDialog.showModal();input.focus();input.select();
}
const evaluationPanel=new EvaluationPanel(document.querySelector('#evaluation-section'),api,openJob,{
  changed:data=>{if(current){workflow.sync(current,data.runs);renderWorkflow();}},
  move:step=>moveStep(step),draft:()=>{workflow.draft();renderWorkflow();}
});
function moveStep(step){evaluationPanel.capture();if(step<=workflow.active)workflow.visit(step);else workflow.advance(step);renderWorkflow();evaluationPanel.render();workflowHeader.scrollIntoView({block:'start'});}
function startNew(url=''){stream?.close();current=null;workflow.reset();evaluationPanel.close();localStorage.removeItem('currentJob');history.replaceState(null,'','/');for(const selector of ['#hero','.launch-panel','#discover','.how-section'])$(selector).hidden=false;for(const node of [workflowHeader,linkReview,workflowFooter,$('#job-section'),$('#evaluation-section')])node.hidden=true;$('#url').value=url;$('#start-button').disabled=false;sessionStorage.removeItem('submission');clearError();loadRecent();$('#url').focus();}
function renderWorkflow(){
  if(!current)return;const review=workflow.reviewing,step=workflow.view;
  for(const selector of ['#hero','.launch-panel','#discover','.how-section','#recent-section'])$(selector).hidden=true;
  workflowHeader.hidden=false;workflowFooter.hidden=false;linkReview.hidden=step!==0;$('#job-section').hidden=step!==1;$('#evaluation-section').hidden=step<2;
  evaluationPanel.stage=step;evaluationPanel.readOnly=review;
  workflowHeader.replaceChildren(el('div',{class:'workflow-title'},el('div',{},el('span',{class:'eyebrow muted',text:'YOUR PLAYGROUND'}),el('div',{class:'project-heading'},el('h1',{text:projectTitle(current)}),el('button',{class:'text-button project-name-edit',text:'이름 변경','aria-label':'프로젝트 이름 변경',onclick:()=>editProjectName(current)}))),el('button',{class:'secondary',text:'다른 URL로 시작',onclick:()=>startNew()})),el('ol',{class:'workflow-steps'},...workflowSteps.map((title,i)=>el('li',{},el('button',{class:i===step?'workflow-step selected':i<workflow.active?'workflow-step complete':'workflow-step',...(i>workflow.active?{disabled:''}:{}),...(i===step?{'aria-current':'step'}:{}),onclick:()=>moveStep(i)},el('span',{class:'workflow-number',text:i<workflow.active?'✓':i+1}),el('span',{text:title}))))),el('div',{class:'workflow-context'},el('strong',{text:`${step+1}. ${workflowSteps[step]}`}),el('span',{text:review?'이전 단계 · 읽기 전용':step===1?terminal.has(current.state)?'종료된 준비 기록입니다. 완료한 단계와 중단 이유를 확인하세요.':'준비 상태를 실시간으로 확인합니다.':step===2?'요청 매개변수와 파일을 확인하거나 바꾼 뒤 직접 실행하세요.':step===3?'실제 응답을 확인하세요. 이어서 해볼 실험은 자동으로 준비됩니다.':step===4?'선택한 실험만 준비합니다. 실행은 다음 버튼 선택으로 시작합니다.':'필요한 기록을 골라 문서로 가져가세요.'})),review?el('p',{class:'review-banner',text:'이전 단계의 기록을 보고 있습니다. 확정된 URL·실행 조건·결과는 수정할 수 없습니다.'}):document.createTextNode(''));
  if(!review&&current.state==='READY')workflowHeader.querySelector('.workflow-title').append(el('button',{class:'text-button',text:'체험 종료',onclick:async()=>{try{openJob(await api(`/api/jobs/${current.id}/cancel`,{method:'POST'}));}catch(e){error(e.message);}}}));
  if(terminal.has(current.state))workflowHeader.querySelector('.workflow-title').append(historyButton(current));
  if(step>=2&&terminal.has(current.state))workflowHeader.append(el('p',{class:'review-banner',text:`${jobStateLabel(current)} · 보관된 결과를 확인하고 단건 리포트를 만들 수 있습니다.`}));
  linkReview.replaceChildren(el('div',{class:'evaluation-card'},el('h3',{text:'이 체험에 사용한 링크'}),el('p',{class:'confirmed-url',text:current.url}),el('span',{class:'pill',text:'확정됨 · 읽기 전용'}),el('p',{class:'data-note',text:'다른 링크를 사용하려면 새로운 체험으로 시작해주세요.'})));
  // Completed preparation is a record. It must not expose cancel/auth/sample mutations.
  $('#job-section').querySelectorAll('button,input,textarea,select').forEach(n=>{n.disabled=review;});
  const previous=el('button',{class:'secondary',...(step===0?{disabled:''}:{}),text:'← 이전',onclick:()=>moveStep(step-1)});
  const next=review?el('button',{class:'primary',text:step+1===workflow.active?'현재 단계로 돌아가기 →':'다음 기록 →',onclick:()=>moveStep(step+1)}):step===3?el('button',{class:'primary',...(evaluationPanel.latest()?.state==='running'?{disabled:''}:{}),text:'단건 리포트로 →',onclick:()=>moveStep(5)}):step===4?el('button',{class:'primary',...(!evaluationPanel.data?.runs.length?{disabled:''}:{}),text:'단건 리포트로 →',onclick:()=>moveStep(5)}):null;
  workflowFooter.replaceChildren(el('div',{class:'workflow-nav-row'},previous,el('span',{class:'workflow-position',text:`${step+1} / ${workflowSteps.length} · ${review?'기록 보기':'현재 단계'}`}),review&&step+1<workflow.active?el('button',{class:'text-button',text:'현재 단계로 돌아가기',onclick:()=>moveStep(workflow.active)}):null,next),el('p',{class:'data-note',text:'이전 단계는 읽기 전용으로 확인할 수 있습니다. 단계 이동만으로 실행하거나 모델을 호출하지 않습니다.'}));
}
const money=m=>'$'+(m/1e6).toFixed(3);
function error(message){if(current){let node=$('#workflow-error');if(!node){node=el('p',{id:'workflow-error',class:'error-banner',role:'alert'});workflowHeader.append(node);}node.textContent=message;}else{$('#form-error').textContent=message;$('#form-error').hidden=false;}}
function clearError(){$('#form-error').hidden=true;}
$('#settings-button').onclick=()=>$('#settings').showModal();$('#close-settings').onclick=()=>$('#settings').close();
document.querySelectorAll('a.brand').forEach(a=>a.onclick=e=>{e.preventDefault();startNew();});
document.querySelectorAll('[data-url]').forEach(button=>button.onclick=()=>{$('#url').value=button.dataset.url;$('#url').focus();$('#launch-form').scrollIntoView({behavior:'smooth',block:'center'});});
const preparingStates=new Set(['ANALYZING','PREPARING','VERIFYING','WAITING_FOR_USER']);
const activeJobDialog=el('dialog',{class:'active-job-dialog','aria-labelledby':'active-job-title'});document.body.append(activeJobDialog);
async function submitLaunch(request){
  const job=await api('/api/jobs',{method:'POST',headers:{'Idempotency-Key':request.id},body:JSON.stringify({url:request.url})});
  sessionStorage.removeItem('submission');openJob(job);
}
async function resolveActiveJob(request){
  const jobs=await api('/api/jobs');
  const active=jobs.find(j=>!j.taskType&&preparingStates.has(j.state));
  if(!active){await submitLaunch(request);return;}
  const message=el('p',{class:'error-text',role:'alert'});
  const keep=el('button',{class:'secondary',text:'계속 준비하기',onclick:()=>activeJobDialog.close()});
  const stop=el('button',{class:'primary',text:'중지하고 새 체험 시작'});
  const view=el('button',{class:'text-button',text:'진행 중인 작업 보기',onclick:async()=>{try{openJob(await api(`/api/jobs/${active.id}`));activeJobDialog.close();}catch(e){message.textContent=e.message;}}});
  stop.onclick=async()=>{
    stop.disabled=keep.disabled=view.disabled=true;stop.textContent='기존 작업 중지 중…';
    const prevent=e=>e.preventDefault();activeJobDialog.addEventListener('cancel',prevent);
    try{
      const latest=await api(`/api/jobs/${active.id}`);
      if(preparingStates.has(latest.state))await api(`/api/jobs/${active.id}/cancel`,{method:'POST'});
      stop.textContent='새 체험 시작 중…';await submitLaunch(request);activeJobDialog.close();
    }catch(e){message.textContent=e.message;}
    finally{stop.disabled=keep.disabled=view.disabled=false;stop.textContent='중지하고 새 체험 시작';activeJobDialog.removeEventListener('cancel',prevent);}
  };
  activeJobDialog.replaceChildren(el('h2',{id:'active-job-title',text:'준비 중인 작업을 중지하시겠습니까?'}),el('p',{text:projectTitle(active)}),el('p',{class:'data-note',text:active.url}),el('p',{text:'기존 작업을 중지한 뒤 아래 URL로 새 체험을 시작합니다. 기존 실행 기록은 유지됩니다.'}),el('p',{class:'data-note',text:request.url}),message,el('div',{class:'active-job-actions'},keep,stop),view);
  activeJobDialog.showModal();keep.focus();
}
$('#launch-form').onsubmit=async event=>{
  event.preventDefault();clearError();$('#start-button').disabled=true;
  const url=$('#url').value.trim(),pending=JSON.parse(sessionStorage.getItem('submission')||'null');
  const request=pending?.url===url?pending:{url,id:crypto.randomUUID()};sessionStorage.setItem('submission',JSON.stringify(request));
  try{await submitLaunch(request);}
  catch(e){try{if(e.code==='ACTIVE_JOB')await resolveActiveJob(request);else error(e.message);}catch(problem){error(problem.message);}}
  finally{if(!current)$('#start-button').disabled=false;}
};
function openJob(job){
  stream?.close();current=job;workflow.sync(job);localStorage.setItem('currentJob',job.id);history.replaceState(null,'','#'+job.id);renderJob(job);
  if(!terminal.has(job.state)){
    stream=new EventSource(`/api/jobs/${job.id}/events`);
    stream.onopen=()=>{connected=true;const indicator=$('#connection');if(indicator&&!terminal.has(current.state)&&current.state!=='READY')indicator.textContent='● 실시간 연결됨';refreshProgressConnection();};
    stream.onmessage=event=>{const j=JSON.parse(event.data);if(current?.id===j.id&&j.seq>current.seq){current=j;renderJob(j);}if(terminal.has(j.state)){stream.close();loadRecent();}else if(j.state==='READY')loadRecent();};
    stream.addEventListener('deleted',()=>{stream.close();localStorage.removeItem('currentJob');location.href='/';});
    stream.onerror=()=>{connected=false;const indicator=$('#connection');if(indicator&&!terminal.has(current.state)&&current.state!=='READY')indicator.textContent='연결 끊김 · 재연결 중';refreshProgressConnection();};
  }
}
function refreshProgressConnection(){
  if(!current)return;const state=preparationProgress(current,connected),fill=$('#job-section .progress-track>div'),label=$('#job-section .progress-summary>span');
  if(fill){fill.className=state.barClass;fill.style.width=state.animated?'':`${state.width}%`;const track=fill.parentElement;track.setAttribute('aria-valuetext',state.label);for(const name of ['aria-valuenow','aria-valuemax','aria-valuemin'])track.removeAttribute(name);if(!state.animated){track.setAttribute('aria-valuenow',String(state.done));track.setAttribute('aria-valuemax',String(Math.max(1,state.total)));track.setAttribute('aria-valuemin','0');}}
  if(label)label.textContent=state.label;
}
function renderJob(job){
  const section=$('#job-section');const detailsOpen=!!section.querySelector('.job-details[open]'),sourcesOpen=!!section.querySelector('.source-evidence[open]');section.hidden=false;$('#hero').classList.add('compact');$('#discover').hidden=true;
  $('#start-button').disabled=!terminal.has(job.state)&&job.state!=='READY';
  const ready=job.state==='READY',state=preparationProgress(job,connected),{stopped,done,total}=state,notice=preparationNotice(job),blocked=costBlock(job);
  const top=el('div',{class:'job-heading'},el('div',{},el('span',{class:'eyebrow muted',text:job.plan?'YOUR PLAYGROUND':'READING YOUR LINK'}),el('h2',{text:projectTitle(job)}),el('p',{class:'subtle',text:job.plan?.capability||job.url})),el('span',{class:'status-pill '+(ready?'success':stopped?'stopped':''),text:jobStateLabel(job)}));
  const networkBlocked=networkBlock(job);
  const summary=el('div',{class:'progress-summary'},el('strong',{text:blocked||networkBlocked?notice.title:job.message}),el('span',{text:state.label}));
  const bar=el('div',{class:'progress-track'+(stopped?' stopped':''),role:'progressbar','aria-label':'준비 진행 상태','aria-valuetext':state.label,...(!state.animated?{'aria-valuenow':done,'aria-valuemax':Math.max(1,total),'aria-valuemin':0}:{})},el('div',{class:state.barClass,style:state.animated?'':`width:${state.width}%`}));
  const steps=el('div',{class:'steps'},...job.steps.map((s,i)=>el('div',{class:`step ${s.status}`,title:s.evidence||s.label},el('span',{class:'step-icon',text:s.status==='completed'?'✓':s.status==='failed'?'!':s.status==='waiting_input'?'↗':String(i+1)}),el('span',{class:'step-label',text:s.label}),el('small',{text:stepNames[s.status]+(s.status==='repairing'?` ${job.round}/${job.policy.repairs}`:'')}))));
  const controls=el('div',{class:'job-controls'},el('span',{id:'connection',class:'subtle',text:ready?`체험 만료 ${new Date(job.expiresAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}`:stopped?'자동 실행이 종료됐어요':connected?'● 실시간 연결됨':'연결 끊김 · 재연결 중'}),el('span',{class:'subtle',text:`마지막 갱신 ${new Date(job.updatedAt).toLocaleTimeString('ko-KR')}`}));
  if(!stopped)controls.append(el('button',{class:'text-button',text:ready?'체험 종료':'작업 취소',onclick:async()=>{try{openJob(await api(`/api/jobs/${job.id}/cancel`,{method:'POST'}));}catch(e){error(e.message);}}}));
  const detail=el('details',{class:'job-details'},el('summary',{text:'실행 내역과 사용량'}),el('div',{class:'usage-grid'},el('div',{},el('small',{text:job.usage.rentalCalls?'토큰 과금 · GPU 임대료 별도':'모델 비용 · 보수적 상한'}),el('strong',{text:`${money(job.usage.micros)} / ${money(job.policy.jobMicros)}`})),el('div',{},el('small',{text:'모델 요청'}),el('strong',{text:`${job.usage.calls} / ${job.policy.calls}`})),el('div',{},el('small',{text:'전체 수정'}),el('strong',{text:`${job.round} / ${job.policy.repairs}`})),el('div',{},el('small',{text:'샌드박스'}),el('strong',{text:job.sandboxId?job.sandboxId.slice(0,8):'준비 전'}))),el('p',{class:'data-note',text:`입력 ${job.usage.input.toLocaleString()} · 출력 ${job.usage.output.toLocaleString()} 토큰 · 예약/미확정 ${money(job.usage.reserved)}. ${job.usage.rentalCalls?'Nosana GPU 시간 요금은 별도이며 0달러가 아닙니다. ':''}Daytona와 외부 API 비용 별도.`}),el('div',{class:'evidence-list'},...job.evidence.map(e=>el('p',{text:`${e.role} · ${e.description||e.scenario||'검증 완료'} · ${e.version||''}`}))),el('pre',{class:'log-output',text:[...(job.failures||[]).map(f=>({at:f.at,text:f.code+' · '+f.message})),...job.logs].map(l=>`[${new Date(l.at).toLocaleTimeString('ko-KR')}] ${l.text}`).join('\n')||'아직 실행 로그가 없습니다.'}));
  const docs=job.documentation;
  for(const recovery of job.analysisRecovery||[])detail.append(el('p',{class:'data-note',text:`분석 복구 ${recovery.attempt}/2 · ${recovery.action==='review'?'수집 근거 재검토':'연결 문서·동적 본문 보완'} · ${{running:'진행 중',recovered:'복구 성공',insufficient:'근거 보완 필요','no-new-evidence':'새 근거 없음',stopped:'중단'}[recovery.status]||recovery.status} — ${recovery.reason}`}));
  const documentation=docs?.pages?.length?el('details',{class:'source-evidence'},el('summary',{text:`확인한 문서 ${docs.pages.length}개${docs.rendered?' · 동적 본문 확인':''}${docs.images?' · 이미지 '+docs.images+'개':''}`}),...docs.pages.map(page=>el('p',{},el('a',{href:page.url,target:'_blank',rel:'noopener noreferrer',text:page.title+' ↗'}),el('small',{text:page.via}))),...(docs.warnings||[]).map(text=>el('p',{class:'data-note',text}))):null;
  const progress=el('div',{class:'progress-card'},summary,bar,steps,controls,documentation,detail);
  let waiting=null;
  if(job.state==='WAITING_FOR_USER'){
    if(job.waitKind==='source')waiting=sourceCard(job);
    else if(job.waitKind==='sample')waiting=sampleCard(job);
    else {
      const previous=section.querySelector('.api-connection-card');
      // Keep typed secrets only in the live form, across SSE and step navigation.
      waiting=previous?.dataset.connectionJob===job.id&&previous.dataset.connectionKind===job.waitKind&&previous.dataset.connectionWait===String(job.waitSequence||0)?previous:apiConnectionCard(job,api);
    }
  }
  const parts=waiting?[top,waiting,progress]:[top,progress];
  if(stopped){parts.push(el('div',{class:'stop-card'},el('span',{class:'stop-icon',text:job.state==='EXPIRED'?'◷':'!'}),el('div',{},el('h3',{text:notice.title}),el('p',{text:notice.message}),!blocked&&!networkBlocked&&job.primaryFailure&&job.primaryFailure!==job.message?el('details',{},el('summary',{text:'원인이 된 오류 확인'}),el('pre',{class:'log-output',text:job.primaryFailure})):null,el('small',{text:`마지막 완료: ${job.steps.filter(s=>s.status==='completed').at(-1)?.label||(job.analysis||blocked?'문서 분석':'없음')}${blocked?'':` · ${networkBlocked?'API 연결 실패':job.reason||job.state}`}`}),job.cleanupPending?el('p',{text:'Daytona 환경 정리 재시도 중'}):null),el('button',{class:'secondary',text:blocked?'새 연결 흐름으로 시작':'새 체험 준비',onclick:()=>startNew(job.url)})));}
  section.replaceChildren(...parts);
  if(detailsOpen)section.querySelector('.job-details').open=true;
  if(sourcesOpen&&documentation)documentation.open=true;
  workflow.sync(job);renderWorkflow();
  void evaluationPanel.show(job);
}
function sourceCard(job){
  const message=el('p',{class:'error-text',role:'alert'});
  const choices=el('div',{class:'source-choices'},...(job.sourceChoices||[]).map(choice=>el('button',{class:'source-choice',type:'button',onclick:async event=>{
    choices.querySelectorAll('button').forEach(b=>{b.disabled=true;});message.textContent='';
    try{await api(`/api/jobs/${job.id}/source`,{method:'POST',body:JSON.stringify({choiceId:choice.id})});}
    catch(e){message.textContent=e.message;choices.querySelectorAll('button').forEach(b=>{b.disabled=false;});}
  }},el('strong',{text:choice.title+' →'}),el('span',{text:choice.description||choice.url}))));
  return el('section',{class:'evaluation-card source-selection'},el('h3',{text:'어떤 API를 체험할까요?'}),el('p',{class:'data-note',text:job.sourceChoiceReason||'여러 API 상품이 있는 문서입니다. 대상을 선택하면 상세 문서 분석을 이어갑니다.'}),choices,message);
}
function sampleCard(job){const fields=el('div');renderFields(fields,job.plan.fields,job.sample);const form=el('form',{},fields,el('button',{class:'primary',type:'submit',text:'이 입력으로 검증하기 →'}));const message=el('p',{class:'error-text'});form.onsubmit=async event=>{event.preventDefault();try{await api(`/api/jobs/${job.id}/sample`,{method:'POST',body:JSON.stringify(await readInputs(form,job.plan.fields))});}catch(e){message.textContent=e.message;}};return el('section',{class:'auth-card'},el('div',{},el('h3',{text:'검증에 사용할 입력이 필요해요.'}),el('p',{text:'문서에 예제가 없는 필수 항목을 채워주세요.'}),form,message));}
function historyButton(job){
  return el('button',{class:'text-button history-action'+(job.dismissedAt?'':' danger-text'),type:'button',text:job.dismissedAt?'복원':'목록에서 삭제','aria-label':`${projectTitle(job)} ${job.dismissedAt?'복원':'목록에서 삭제'}`,onclick:async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{
      const restoring=!!job.dismissedAt;
      await api(`/api/jobs/${job.id}${restoring?'/restore':''}`,{method:restoring?'POST':'DELETE'});
      if(current?.id===job.id)startNew();
      historyNotice.hidden=false;
      historyNotice.replaceChildren(el('span',{text:restoring?'체험을 최근 목록으로 복원했습니다.':'최근 목록에서 삭제했습니다. 실험·비교 기록은 보관됩니다.'}),...(!restoring?[historyButton({...job,dismissedAt:Date.now()})]:[]));
      await loadRecent();
    }catch(e){error(e.message);button.disabled=false;}
  }});
}
async function loadRecent(){try{
  const [jobs,dismissed]=await Promise.all([api('/api/jobs'),api('/api/jobs?dismissed=1')]);
  $('#recent-section').hidden=!!current||(!jobs.length&&!dismissed.length&&historyNotice.hidden);
  $('#recent-jobs').hidden=!jobs.length;
  $('#recent-jobs').replaceChildren(...jobs.slice(0,6).map(j=>el('div',{class:'recent-job-row'},el('button',{class:'recent-job',onclick:async()=>{try{openJob(await api(`/api/jobs/${j.id}`));}catch(e){error(e.message);}}},el('span',{class:'recent-icon',text:j.plan?.kind==='github'?'⌘':'↗'}),el('div',{},el('strong',{text:projectTitle(j)}),el('small',{text:j.url})),el('span',{class:'pill',text:jobStateLabel(j)})),terminal.has(j.state)?historyButton(j):null)));
  dismissedHistory.hidden=!dismissed.length;
  dismissedHistory.replaceChildren(el('summary',{text:`삭제한 체험 (${dismissed.length})`}),el('p',{class:'data-note',text:'목록에서 삭제한 체험입니다. 복원해 다시 확인할 수 있습니다.'}),...dismissed.map(j=>el('div',{class:'dismissed-job'},el('span',{},el('strong',{text:projectTitle(j)}),el('small',{text:j.url})),historyButton(j))));
  return jobs;
}catch{return [];}}
try{
  config=await api('/api/config');const c=config.configured;
  $('#provider-brand').textContent='DAYTONA × '+(c.model?.provider==='nosana'?'NOSANA':'OPENAI');
  $('.budget-note').textContent=`최대 ${config.limits.minutes}분 준비 · 완료 후 ${config.limits.ttlMinutes}분 체험`;
  $('.settings-note').textContent=['로컬 단일 사용자 모드 · 자동 수정 최대 '+config.limits.repairs+'회',c.model?.billing==='gpu-hour'?`Nosana GPU: 시간당 $${c.model.hourlyUSD} · 배포 상한 $${c.model.maximumUSD} · 종료 ${new Date(c.model.expiresAt).toLocaleString('ko-KR')}`:'모델 비용: 작업당 $'+config.limits.jobUSD+(config.limits.userDayUSD==null?'':' · 하루 $'+config.limits.userDayUSD),'외부 API 및 Daytona 비용은 별도 한도로 관리합니다.'].join('\n');
  if(config.infrastructure&&!config.infrastructure.available){error(`Daytona 예약 ${config.infrastructure.used}/${config.infrastructure.limit}분 · 현재 새 환경을 만들 수 없습니다. 초기화: ${new Date(config.infrastructure.resetsAt).toLocaleString()}`);}
  $('#connection-status').replaceChildren(...[[c.model?.label||'OpenAI API',c.model?.ready??c.openai],['Daytona',c.daytona],['실행 스냅샷',c.snapshot]].map(([name,value])=>el('div',{class:'connection-row'},el('strong',{text:name}),el('span',{class:'pill '+(value?'green':''),text:value?'설정됨':name==='실행 스냅샷'?'기본 이미지 사용':'설정 필요'}))));
  if(!(c.model?.ready??c.openai)||!c.daytona){$('#config-notice').hidden=false;$('#config-notice').append(el('span',{text:`연결 준비 · ${[!(c.model?.ready??c.openai)?(c.model?.label||'모델 연결'):'',!c.daytona?'Daytona':''].filter(Boolean).join(', ')} 키를 설정하면 실제 체험을 시작할 수 있어요.`}),el('button',{class:'text-button',text:'설정 보기 ↗',onclick:()=>$('#settings').showModal()}));}
  const jobs=await loadRecent();const selected=location.hash.slice(1)||localStorage.getItem('currentJob');const job=jobs.find(j=>j.id===selected)||jobs.find(j=>!terminal.has(j.state)&&j.state!=='READY');if(job)openJob(job);
}catch(e){error('서버에 연결하지 못했습니다. '+e.message);}
