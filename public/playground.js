import {renderFields,readInputs,renderValue,clearResources,el} from './viewer.js';
const q=s=>document.querySelector(s);let contract;
try{
  const r=await fetch('/contract');if(!r.ok)throw new Error('체험 계약을 불러오지 못했습니다.');contract=await r.json();
  q('#title').textContent=contract.title;q('#description').textContent=contract.capability;renderFields(q('#request-fields'),contract.fields);
}catch(e){q('#title').textContent=e.message;}
function tab(raw){q('#raw-json').hidden=!raw;q('#result').hidden=raw;q('#view-tab').classList.toggle('selected',!raw);q('#raw-tab').classList.toggle('selected',raw);}
q('#view-tab').onclick=()=>tab(false);q('#raw-tab').onclick=()=>tab(true);
q('#request-form').onsubmit=async e=>{e.preventDefault();if(!contract)return;const button=e.submitter;button.disabled=true;q('#result').dataset.state='loading';q('#result').replaceChildren(el('div',{class:'empty-result'},el('span',{class:'spinner'}),el('p',{text:'실제 결과를 가져오고 있어요'})));tab(false);const started=performance.now();
  try{const input=await readInputs(e.currentTarget,contract.fields);const response=await fetch('/invoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok||result.error||result.status>=400)throw Object.assign(new Error(result.error||`HTTP ${result.status}: ${JSON.stringify(result.data)}`),{code:result.code});clearResources();q('#raw-json').textContent=JSON.stringify(result.data,null,2);q('#result').replaceChildren(renderValue(result.data,'',contract.viewer?.fields||[]));q('#result').dataset.state='success';delete q('#result').dataset.errorCode;q('#result-meta').textContent=`HTTP ${result.status} · ${(performance.now()-started).toFixed(0)} ms · 현재 응답 기준`;
  }catch(e){q('#result').dataset.state='error';q('#result').dataset.errorCode=e.code||'EXECUTION_FAILED';q('#result').replaceChildren(el('div',{class:'error-banner',text:e.message}));q('#raw-json').textContent=JSON.stringify({error:e.message},null,2);q('#result-meta').textContent='실행 실패 · 입력과 인증 상태를 확인해주세요.';}finally{button.disabled=false;}};
