'use strict';
let routeSession, routeWorking=false, routePoll=false, routeExpired=false;
const places={강남:{name:'강남',lon:127.027619,lat:37.497952},역삼:{name:'역삼',lon:127.036456,lat:37.500622},선릉:{name:'선릉',lon:127.048203,lat:37.504286}};
const minutes=seconds=>Math.ceil(seconds/60)+'분';
const modes={WALK:'도보',SUBWAY:'지하철',BUS:'버스',TRAIN:'철도',EXPRESSBUS:'고속버스',OTHER:'기타'};
function renderPlannerSettings(){
  const real=$('#route-provider').value==='TMAP';
  $('#route-key-status').textContent=real ? (data?.settings.tmapConfigured ? `TMAP 경로 · 오늘 ${data.settings.tmapCallsToday}/${data.settings.tmapDailyBudget}회 · 동일 검색 5분 캐시 · 구간 회피에는 추가 조회 없음` : 'TMAP_APP_KEY 설정이 필요합니다. 합성 경로 시연은 지금 사용할 수 있습니다.') : '시연 경로는 실제 노선·운행 정보가 아닙니다. 키 없이 회피 과정을 확인할 수 있습니다.';
  $('#route-search').disabled=routeWorking || (real && !data?.settings.tmapConfigured);
}
function placeFor(side){
  const selected=$('#route-'+side).value;
  if(selected!=='custom') return places[selected];
  const name=$('#'+side+'-name').value.trim(),lonText=$('#'+side+'-lon').value,latText=$('#'+side+'-lat').value;
  if(!name || !lonText || !latText) throw new Error('직접 입력할 때는 이름·경도·위도를 모두 넣어 주세요.');
  return {name,lon:Number(lonText),lat:Number(latText)};
}
for(const side of ['from','to']) $('#route-'+side).addEventListener('change',()=>{ const custom=$('#route-'+side).value==='custom'; $('#'+side+'-coordinates').hidden=!custom; });
$('#route-provider').addEventListener('change',renderPlannerSettings);
$('#route-form').addEventListener('submit',async event=>{
  event.preventDefault(); if(routeWorking) return;
  routeWorking=true; routeSession=undefined; $('#route-results').replaceChildren(); empty($('#route-blocks'),'새 검색의 회피 조건이 여기에 표시됩니다.'); $('#route-traces').replaceChildren(); renderPlannerSettings(); $('#route-result-status').textContent='경로 후보를 불러오고 있습니다…';
  try { routeSession=await api('/routes','POST',{from:placeFor('from'),to:placeFor('to'),provider:$('#route-provider').value}); routeExpired=false; renderJourneys(); await refresh(); }
  catch(e){ $('#route-result-status').textContent=e.message; }
  finally {routeWorking=false; renderJourneys(); renderPlannerSettings();}
});
async function updateAvoid(path,method,body){
  if(!routeSession || routeWorking || routeSession.busy || routeExpired) return;
  routeWorking=true; renderJourneys();
  try { routeSession=await api('/routes/'+routeSession.id+path,method,body); renderJourneys(); }
  catch(e){toast(e.message);}
  finally {routeWorking=false; renderJourneys(); renderPlannerSettings();}
}
function renderJourneys(){
  if(!routeSession) return;
  const {plan,assessments,blocks}=routeSession, disabled=routeWorking||routeSession.busy||routeExpired;
  const banner=$('#route-result-status');
  banner.textContent=(plan.provider==='DEMO'?'[합성 경로 시연] ':'[TMAP 경로] ')+(routeExpired?'경로 정보가 만료됐습니다. 다시 검색하세요.':routeSession.message)+` · 조회 ${time(plan.fetchedAt)}${plan.cached?' · 캐시':''}`;
  banner.classList.toggle('route-unavailable',routeExpired||['NO_ALTERNATIVE','VERIFY_PENDING'].includes(routeSession.state));
  const list=$('#route-results'); list.replaceChildren();
  const journeys=[...plan.journeys].sort((a,b)=>Number(b.id===routeSession.recommendedId)-Number(a.id===routeSession.recommendedId)||a.totalSeconds-b.totalSeconds);
  if(!journeys.length) empty(list,'경로 제공자가 후보를 반환하지 않았습니다. 출발·도착 지점을 바꿔 검색해 주세요.');
  for(const journey of journeys){
    const check=assessments.find(a=>a.routeId===journey.id), selected=journey.id===routeSession.recommendedId&&!routeExpired;
    const card=el('article','journey-card'+(selected?' recommended':'')+(!check.eligible?' excluded':'')); card.dataset.routeId=journey.id;
    const header=el('div','journey-heading'), title=el('div'), duration=el('div','journey-duration');
    title.append(el('span','badge',selected?(blocks.length?'대안 추천':'추천 경로'):!check.eligible?'회피 조건으로 제외':'경로 후보'),el('h2','',journey.legs.filter(l=>l.mode!=='WALK').map(l=>l.route||modes[l.mode]||l.mode).join(' → ')||'도보'));
    duration.append(el('strong','',minutes(journey.totalSeconds)),el('small','',check.extraSeconds>0?'기본 최단 대비 +'+minutes(check.extraSeconds):'기본 최단 예상'));
    header.append(title,duration); card.append(header);
    card.append(el('p','journey-meta',`환승 ${journey.transfers}회 · 도보 ${minutes(journey.walkSeconds)} · ${journey.totalFare===null?'요금 미제공':journey.totalFare.toLocaleString('ko-KR')+'원'} · ${plan.provider==='DEMO'?'합성 예상치':'TMAP 예상치'}`));
    if(!check.eligible) card.append(el('p','journey-conflict',check.reasons.join(' / ')));
    const legs=el('div','journey-legs');
    for(const leg of journey.legs){
      const row=el('div','journey-leg '+leg.mode.toLowerCase()), details=el('div','leg-details');
      details.append(el('strong','',`${leg.route||modes[leg.mode]||leg.mode} · ${minutes(leg.durationSeconds)}`),el('p','',leg.start+' → '+leg.end));
      if(leg.stops.length>2){ const stops=el('details','stops-detail'); stops.append(el('summary','',`통과 정류장 ${leg.stops.length}곳`),el('p','',leg.stops.map(s=>s.name).join(' → '))); details.append(stops); }
      row.append(el('span','leg-mode',modes[leg.mode]||leg.mode),details);
      if(['BUS','SUBWAY'].includes(leg.mode)){
        const avoid=el('button','avoid-button','이 구간 피하기'); avoid.type='button'; avoid.disabled=disabled; avoid.dataset.legId=leg.id;
        avoid.setAttribute('aria-label',`${leg.route} ${leg.start}에서 ${leg.end} 구간 피하기`);
        avoid.addEventListener('click',()=>updateAvoid('/avoid','POST',{legId:leg.id,scope:$('#avoid-scope').value,reason:$('#avoid-reason').value})); row.append(avoid);
      }
      legs.append(row);
    }
    card.append(legs); list.append(card);
  }
  const blockList=$('#route-blocks'); blockList.replaceChildren();
  if(!blocks.length) empty(blockList,'아직 회피 조건이 없어요.');
  for(const b of blocks){
    const item=el('div','blocked-item'),remove=el('button','text-link','해제'); remove.type='button'; remove.disabled=disabled;
    remove.setAttribute('aria-label',b.leg.route+' 회피 조건 해제'); remove.addEventListener('click',()=>updateAvoid('/avoid/'+b.id,'DELETE'));
    item.append(el('strong','',b.leg.route),el('p','',b.leg.start+' → '+b.leg.end),el('small','',`${b.scope==='LINE'?'노선 전체':'승차 구간'} · ${b.reason} · ${b.source==='DEMO'?'시연 입력':'내 회피 조건'}`),remove); blockList.append(item);
  }
  const traces=$('#route-traces'); traces.replaceChildren();
  if(!routeSession.traces.length) traces.append(el('p','footnote',routeSession.busy?'샌드박스에서 경로를 검토하는 중입니다…':'AI 연결 전 · 서버 규칙으로 구간을 검사했습니다.'));
  for(const t of routeSession.traces){ const item=el('div','route-trace'); item.append(el('strong','',`${t.role==='planner'?'A 계획':'B 검증'} · ${t.verdict}`),el('p','',t.reason),el('small','',t.engine==='openai'?'OpenAI 도구 호출':'규칙 기반 시연')); for(const tool of t.tools)item.append(el('small','',tool.tool+' · '+tool.detail)); traces.append(item); }
}
async function pollRoute(){
  if(!routeSession||routePoll||routeWorking||routeExpired) return;
  if(Date.now()>=Date.parse(routeSession.expiresAt)){routeExpired=true;renderJourneys();return;}
  if(!routeSession.busy)return;
  routePoll=true;
  const requestedId=routeSession.id;
  try{const result=await api('/routes/'+requestedId);if(routeSession?.id===requestedId){routeSession=result;renderJourneys();}}
  catch(e){$('#route-result-status').textContent='검증 상태 확인 실패 · '+e.message;}
  finally{routePoll=false;}
}
setInterval(pollRoute,2500);
renderPlannerSettings();
