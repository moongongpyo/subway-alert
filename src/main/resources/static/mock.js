 'use strict';
const $=s=>document.querySelector(s),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const from=new PlacePicker($('#mock-from'),'출발'),to=new PlacePicker($('#mock-to'),'도착');let route,legs=[],loading=false,savedPlaces,savedProvider,immediateStart=true;
async function api(path,method='GET',body){const r=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'SubwayAlert'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok){const error=Error(d.message||d.detail||'요청을 완료하지 못했습니다.');error.status=r.status;throw error;}return d;}
function now(){const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());$('#mock-start').value=parts.replace(' ','T');}now();$('#mock-now').onclick=()=>{immediateStart=true;now();};$('#mock-start').oninput=()=>{immediateStart=false;};
$('#mock-search').onsubmit=async e=>{e.preventDefault();if(loading)return;loading=true;$('#mock-find').disabled=true;$('#event-form').hidden=true;try{const example=$('#mock-example').checked;const a=example?{name:'강남',lon:127.027619,lat:37.497952}:from.get(),b=example?{name:'선릉',lon:127.048203,lat:37.504286}:to.get();route=await api('/routes','POST',{from:a,to:b,provider:example?'DEMO':'TMAP'});savedPlaces={from:a,to:b};savedProvider=example?'DEMO':'TMAP';$('#event-status').textContent='';legs=[];const seen=new Set();for(const j of route.plan.journeys)for(const l of j.legs){const identity=l.mode+l.route+l.start+l.end;if(['BUS','SUBWAY'].includes(l.mode)&&l.stops.length>=2&&!seen.has(identity)){legs.push(l);seen.add(identity);}}$('#mock-leg').replaceChildren();for(const [i,l] of legs.entries()){const o=el('option',l.route+' · '+l.start+' → '+l.end);o.value=i;$('#mock-leg').append(o);}$('#event-form').hidden=!legs.length;$('#mock-status').textContent=legs.length?'장애를 적용할 승차 구간과 정류장을 선택하세요.':'정류장 정보가 있는 경로가 없습니다.';selectLeg();}catch(err){$('#mock-status').textContent=err.message;}finally{loading=false;$('#mock-find').disabled=false;}};
function selectLeg(){const leg=legs[Number($('#mock-leg').value)];for(const id of ['mock-start-stop','mock-end-stop'])$('#'+id).replaceChildren();if(!leg)return;leg.stops.forEach((s,i)=>{for(const id of ['mock-start-stop','mock-end-stop']){const o=el('option',s.name);o.value=i;$('#'+id).append(o);}});$('#mock-end-stop').value=leg.stops.length-1;}
$('#mock-leg').onchange=selectLeg;
function eventStatus(message,error=false){
 const target=$('#event-status');target.textContent=message;target.style.color=error?'#b42318':'';
}
function legIdentity(leg){
 return JSON.stringify([leg.mode,leg.route,leg.routeId,leg.start,leg.end,leg.stops.map(s=>[s.id,s.name])]);
}
async function refreshSelection(selected){
 eventStatus('검색 정보가 만료되어 같은 구간을 다시 확인하고 있습니다…');
 const fresh=await api('/routes','POST',{...savedPlaces,provider:savedProvider});
 const match=fresh.plan.journeys.flatMap(j=>j.legs).find(l=>legIdentity(l)===legIdentity(selected));
 if(!match)throw Error('새 경로에서 같은 구간을 찾지 못했습니다. 위의 구간 불러오기를 눌러 다시 선택해 주세요.');
 route=fresh;legs=legs.map(l=>fresh.plan.journeys.flatMap(j=>j.legs).find(candidate=>legIdentity(candidate)===legIdentity(l))||{...l,id:''});
 return match;
}
$('#event-form').onsubmit=async e=>{
 e.preventDefault();const button=$('#mock-save');if(button.disabled)return;
 button.disabled=true;button.textContent='예약 중…';eventStatus('장애를 등록하고 있습니다…');
 try{
  let selected=legs[Number($('#mock-leg').value)];
  if(!route||!selected)throw Error('먼저 구간 불러오기를 눌러 장애 구간을 선택해 주세요.');
  const startIndex=Number($('#mock-start-stop').value),endIndex=Number($('#mock-end-stop').value);
  if(startIndex>=endIndex)throw Error('종료 정류장은 시작 정류장보다 뒤에 있어야 합니다.');
  const minutes=Number($('#mock-minutes').value);
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('지속 시간은 1~1440분으로 입력해 주세요.');
  const requestedStart=immediateStart?null:new Date($('#mock-start').value+':00+09:00');
  if(requestedStart&&(!Number.isFinite(requestedStart.getTime())||requestedStart.getTime()<Date.now()-120000))throw Error('시작 시간이 지났습니다. 지금 시작을 누르거나 미래 시간을 선택해 주세요.');
  const save=()=>{
   const startsAt=requestedStart||new Date(),endsAt=new Date(startsAt.getTime()+minutes*60000);
   return api('/mock-disruptions','POST',{sessionId:route.id,legId:selected.id,startIndex,endIndex,startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString()});
  };
  if(!selected.id)selected=await refreshSelection(selected);
  try{await save();}catch(err){
   if(![404,410].includes(err.status))throw err;
   selected=await refreshSelection(selected);await save();
  }
  eventStatus('장애를 등록했습니다. 아래 목업 장애 목록에서 확인하세요.');
  $('#mock-status').textContent='';await events();
 }catch(err){eventStatus(err.message,true);}
 finally{button.disabled=false;button.textContent='장애 예약';}
};
const stamp=s=>new Date(s).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
async function events(){try{const values=await api('/mock-disruptions'),list=$('#event-list');list.replaceChildren();if(!values.length)list.append(el('p','등록한 시연 장애가 없습니다.'));for(const v of values){const row=el('article');row.className='mock-event';const state=Date.now()<Date.parse(v.startsAt)?'예약':Date.now()>=Date.parse(v.endsAt)?'종료':'진행 중';row.append(el('strong','[목업 · '+state+'] '+v.title),el('p',stamp(v.startsAt)+' ~ '+stamp(v.endsAt)));const stop=el('button',state==='종료'?'삭제':'취소·즉시 해제');stop.onclick=async()=>{stop.disabled=true;try{await api('/mock-disruptions/'+v.id,'DELETE');await events();}catch(e){$('#mock-status').textContent=e.message;stop.disabled=false;}};row.append(stop);list.append(row);}}catch(e){$('#mock-status').textContent=e.message;}}
async function notices(refresh=false){const button=$('#refresh-notices');button.disabled=true;try{const feed=await api('/metro-notices'+(refresh?'/refresh':''),refresh?'POST':'GET');$('#official-status').textContent=!feed.configured?'서울시 공지 키 미연결':feed.error||(feed.stale?'이전 수집 자료':'수집 완료')+' · '+(feed.fetchedAt?stamp(feed.fetchedAt):'수집 대기')+' · 전체 '+feed.total+'건 중 최대 100건 표시';const list=$('#official-list');list.replaceChildren();for(const {notice:n,timing} of feed.items){const d=el('details');d.append(el('summary',(timing==='ENDED'?'[종료] ':timing==='SCHEDULED'?'[예정] ':'[상태 확인] ')+n.title),el('p',n.lines+' · '+(n.publishedAt?stamp(n.publishedAt):'발표 시각 미제공')),el('p',n.content),el('p','시작 '+(n.startsAt?stamp(n.startsAt):'미제공')+' / 종료 '+(n.endsAt?stamp(n.endsAt):'미제공')));list.append(d);}if(!feed.items.length)list.append(el('p','수집된 공지가 없습니다.'));if(refresh)$('#official-status').textContent+=' (연속 요청은 15초 간격으로 제한)';}catch(e){$('#official-status').textContent=e.message;}finally{button.disabled=false;}}
$('#refresh-notices').onclick=()=>notices(true);events();notices();setInterval(events,5000);
