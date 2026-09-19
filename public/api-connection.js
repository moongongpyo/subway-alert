import { el } from './viewer.js';

export function apiConnectionCard(job, api){
  const auth=job.plan.auth,needsKey=auth.kind!=='none',offer=job.apiOffer,initial=job.waitKind==='connection';
  const message=el('p',{class:'error-text',role:'alert'});
  const key=needsKey?el('input',{id:'service-api-key',type:'password',name:'credential',autocomplete:'off',spellcheck:'false',placeholder:auth.label||'발급받은 API 키를 붙여넣으세요',required:'',minlength:3,maxlength:4096}):null;
  const guide=el('div',{class:'key-guide'});
  if(needsKey){
    const instructions=(auth.instructions||'공식 안내에 따라 키를 발급받은 뒤 아래에 붙여넣으세요.').split(/\n+/).map(s=>s.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
    const details=el('details',{class:'key-instructions',open:''},el('summary',{text:'키 발급 방법'}),el('ol',{},...instructions.map(text=>el('li',{text}))));
    guide.append(el('div',{class:'connection-links'},el('a',{href:auth.issueUrl,target:'_blank',rel:'noopener noreferrer',class:'primary',text:'키 발급 페이지 열기 ↗'}),el('button',{type:'button',class:'text-button',text:'이미 키가 있어요 ↓',onclick:()=>{details.open=false;key.focus();}})),el('small',{text:'공식 사이트가 새 탭으로 열립니다. 발급 후 이 화면에 돌아와 붙여넣으세요.'}),details);
    if(auth.docsUrl&&auth.docsUrl!==auth.issueUrl)guide.append(el('a',{href:auth.docsUrl,target:'_blank',rel:'noopener noreferrer',class:'text-button',text:'공식 인증 가이드 ↗'}));
  }
  const form=el('form',{class:'api-connection-form'});
  if(needsKey){
    const reveal=el('button',{type:'button',class:'secondary',text:'보기','aria-label':'API 키 표시','aria-pressed':'false',onclick:()=>{const show=key.type==='password';key.type=show?'text':'password';reveal.textContent=show?'숨기기':'보기';reveal.setAttribute('aria-pressed',String(show));reveal.setAttribute('aria-label',show?'API 키 숨기기':'API 키 표시');}});
    form.append(el('label',{for:'service-api-key',class:'connection-label',text:'발급받은 API 키'}),el('div',{class:'key-input-row'},key,reveal));
  }
  let limit,mode,rate,budget,ack,httpAck;
  if(offer?.requiresHttpConsent){
    const transport=el('div',{class:'connection-transport'},el('strong',{text:'이 API는 HTTP로 연결됩니다.'}),el('p',{text:`${offer.origin}까지 키와 요청 내용이 암호화되지 않은 평문으로 전송됩니다. 중간 네트워크에서 보일 수 있습니다.`}));
    if(initial){httpAck=el('input',{type:'checkbox',required:'',name:'http-acknowledged'});transport.append(el('label',{class:'connection-consent'},httpAck,el('span',{text:'이 API에 인증키를 HTTP로 전송하는 것을 확인했습니다.'})));}
    else transport.append(el('small',{text:'이 체험에서 확인한 HTTP 전송 조건이 유지됩니다.'}));
    form.append(transport);
  }
  if(initial){
    limit=el('input',{id:'api-call-limit',type:'number',min:3,max:offer.maxLimit,value:offer.defaultLimit,required:'',step:1});
    mode=el('select',{'aria-label':'API 비용 관리 방식'},el('option',{value:'requests',text:'호출 횟수로 제한'}),el('option',{value:'free',text:'내 무료 한도 안에서 사용'}),el('option',{value:'metered',text:'단가와 금액 상한 직접 설정'}));
    rate=el('input',{type:'number',min:0.000001,max:1000,step:'any','aria-label':'호출당 최대 비용 USD',placeholder:'호출당 최대 USD',...(offer.requestMicros>0?{value:offer.requestMicros/1e6}:{})});
    budget=el('input',{type:'number',min:0.000001,max:1000,step:'any','aria-label':'이번 체험 예산 USD',placeholder:'이번 체험 예산 USD'});
    const metered=el('div',{class:'metered-inputs',hidden:''},el('label',{},el('span',{text:'호출당 최대 비용 (USD)'}),rate),el('label',{},el('span',{text:'이번 체험 예산 (USD)'}),budget));
    const costNote=el('p',{class:'connection-cost-note'}),ackText=el('span');
    const syncCost=()=>{
      metered.hidden=mode.value!=='metered';rate.required=budget.required=mode.value==='metered';
      costNote.textContent=mode.value==='free'?'현재 계정의 무료 잔여량은 제공사에서 확인해주세요. 다른 앱에서 사용한 호출은 이 화면에서 집계하지 않습니다.':mode.value==='metered'?'입력한 호출당 최대 비용으로 계산하며, 횟수와 금액 중 먼저 도달한 한도에서 멈춥니다.':offer.requestMicros===null?'이 API의 실제 요금은 아직 확인되지 않았습니다. 호출 횟수만 제한하며, 금액 상한은 보장하지 않습니다.':offer.requestMicros===0?'등록된 무료 API입니다. 계정별 이용 조건은 공식 사이트에서 확인해주세요.':`등록된 호출당 최대 비용은 $${offer.requestMicros/1e6}입니다. 선택한 횟수로 비용 상한도 계산합니다.`;
      ackText.textContent=mode.value==='free'?'선택한 횟수가 내 무료 잔여 한도 안에 있음을 확인했습니다.':mode.value==='metered'?'입력한 비용과 예산으로 검증·체험 호출을 시작합니다.':offer.requestMicros===0?'선택한 횟수 안에서 검증·체험 호출을 시작합니다.':'제공사에서 요금이 발생할 수 있음을 확인했고, 선택한 횟수까지 호출합니다.';
    };
    mode.onchange=()=>{ack.checked=false;syncCost();};
    ack=el('input',{type:'checkbox',required:'',name:'access-acknowledged'});syncCost();
    for(const field of [limit,rate,budget])field.addEventListener('input',()=>{ack.checked=false;});
    form.append(el('div',{class:'connection-limits'},el('div',{class:'call-limit-row'},el('label',{for:'api-call-limit',text:'이번 체험은 최대'}),limit,el('span',{text:'회 호출'})),el('small',{text:'자동 기능·화면 검증과 재시도, 이후 직접 실행을 모두 합친 횟수입니다.'}),el('details',{class:'connection-cost-options'},el('summary',{text:'무료 한도·금액 상한 설정 (선택)'}),mode,metered),costNote,el('label',{class:'connection-consent'},ack,ackText)));
  }else if(job.apiAccess){form.append(el('p',{class:'data-note',text:`기존 호출 한도 ${job.apiAccess.callLimit}회가 유지됩니다. 키를 바꿔도 사용 횟수는 초기화되지 않습니다.`}));}
  const submit=el('button',{class:'primary',type:'submit',text:needsKey?'키 연결하고 체험 준비 →':'이 조건으로 체험 준비 →'});
  form.append(message,submit);
  form.onsubmit=async event=>{
    event.preventDefault();if(submit.disabled)return;submit.disabled=true;message.textContent='';
    try{
      const body=initial?{value:key?.value,scope:offer.scope,mode:mode.value,callLimit:Number(limit.value),rateUSD:rate.value,budgetUSD:budget.value,acknowledged:ack.checked,httpAcknowledged:httpAck?.checked===true}:{value:key.value};
      await api(`/api/jobs/${job.id}/${initial?'connection':'credentials'}`,{method:'POST',body:JSON.stringify(body)});
      if(key)key.value='';message.textContent='연결 정보를 받았습니다. 준비를 이어가고 있어요.';
    }catch(e){message.textContent=e.message;submit.disabled=false;}
  };
  return el('section',{class:'auth-card api-connection-card','data-connection-job':job.id,'data-connection-kind':job.waitKind,'data-connection-wait':job.waitSequence||0},el('div',{},el('span',{class:'eyebrow muted',text:'CONNECT YOUR API'}),el('h3',{text:needsKey?'내 API 키로 연결하기':'API 호출 조건 확인'}),el('p',{text:needsKey?'키를 연결하면 설치와 실제 검증을 이어갑니다.':job.plan.capability}),el('span',{class:'connection-host',text:offer?.host||new URL(job.plan.endpoint.url).hostname}),!initial?el('p',{class:'error-banner',role:'alert',text:job.message}):null,el('div',{class:needsKey?'connection-body':'connection-body keyless'},needsKey?guide:null,form),needsKey?el('small',{text:'키는 암호화해 보관하고 이 체험의 API 호출에만 사용합니다. 모델에 보내지 않으며 종료 시 삭제합니다.'}):null));
}
