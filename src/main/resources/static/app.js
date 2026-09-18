'use strict';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let data, station = '강남', direction = '내선', polling = false, initial = true, watchedRun;
let toastTimer;
const seenNotices = new Set();
const stateNames = {NORMAL:'지연 징후가 관측되지 않았어요', OBSERVING:'관측을 모으고 있어요', DELAY_SUSPECTED:'지연이 의심돼요', DATA_UNAVAILABLE:'데이터를 확인할 수 없어요', VERIFY_PENDING:'추가 확인을 기다리고 있어요', RECOVERED:'관측이 회복됐어요', REJECTED:'지연 후보 조건을 충족하지 않았어요'};
const names = {detector:'탐지 A', verifier:'검증 B', server:'서버', collector:'수집기', tool:'도구'};
const scenarioNames = {DELAY:'지연 징후', STALE:'오래된 데이터', FAILURE:'수집 실패', RECOVERY:'관측 회복', TIMEOUT:'타임아웃', INVALID_RESPONSE:'잘못된 응답', LIVE_POLL:'실시간 수집'};
const time = value => value ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)) : '—';
function el(tag, className, text) { const node = document.createElement(tag); if(className) node.className = className; if(text !== undefined) node.textContent = text; return node; }
function empty(container, text) { container.replaceChildren(el('div','empty',text)); }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
async function api(path, method = 'GET', body) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {'X-Requested-With':'SubwayAlert'};
    if(body !== undefined) headers['Content-Type'] = 'application/json';
    if(path.startsWith('/admin/')) headers['X-Admin-Token'] = $('#admin-token').value;
    const response = await fetch('/api' + path, {method, headers, credentials:'same-origin', body:body === undefined ? undefined : JSON.stringify(body), signal:controller.signal});
    let result = {}; try { result = await response.json(); } catch { /* unexpected response handled below */ }
    if(!response.ok) throw new Error(result.message || (response.status === 401 ? '관리자 토큰을 확인하세요.' : `요청을 처리하지 못했어요 (${response.status}).`));
    return result;
  } finally { clearTimeout(timer); }
}
function navigate() {
  const titles = {overview:'운행 대시보드',agents:'에이전트 활동',alerts:'내 알림',settings:'연결 및 시연'};
  const page = Object.hasOwn(titles, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  $$('.page').forEach(p => p.hidden = p.id !== 'page-' + page);
  $$('.nav-link').forEach(link => { const selected = link.dataset.page === page; link.classList.toggle('active',selected); if(selected) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
  $('#page-title').textContent = titles[page];
}
function renderRoute() {
  if(!data) return;
  $$('.station').forEach(button => { button.classList.toggle('active',button.dataset.station === station); button.setAttribute('aria-pressed',String(button.dataset.station === station)); });
  $$('[data-direction]').forEach(button => { button.classList.toggle('selected',button.dataset.direction === direction); button.setAttribute('aria-pressed',String(button.dataset.direction === direction)); });
  $('#selected-station').textContent = station + '역';
  const route = data.routes.find(r => r.station === station && r.direction === direction);
  const observation = route.observations[0];
  const stale = !observation || (Date.now() - Date.parse(observation.generatedAt)) / 1000 > data.settings.freshSeconds;
  const state = stale ? 'DATA_UNAVAILABLE' : route.incident?.state || 'OBSERVING';
  const status = $('#route-status'); status.className = 'route-status' + (state === 'DELAY_SUSPECTED' ? ' warning' : ['DATA_UNAVAILABLE','VERIFY_PENDING','OBSERVING'].includes(state) ? ' unknown' : '');
  status.querySelector('.status-symbol').textContent = state === 'DELAY_SUSPECTED' ? '!' : ['DATA_UNAVAILABLE','VERIFY_PENDING','OBSERVING'].includes(state) ? '⋯' : '↗';
  status.querySelector('h3').textContent = stateNames[state] || state;
  status.querySelector('p').textContent = stale ? '최신 데이터가 없습니다. 시연 실행 또는 다음 실시간 수집을 기다려 주세요.' : route.incident?.summary || '관측을 모으는 중입니다. 지연 여부를 판단하려면 연속 데이터가 필요합니다.';
  const list = $('#observations'); list.replaceChildren();
  if(!route.observations.length) return empty(list,'아직 수집된 관측이 없어요.');
  route.observations.slice(0,3).forEach(o => {
    const row = el('div','observation'), info = el('div'), eta = el('div','eta');
    info.append(el('strong','',o.position + ' 부근'),el('p','',`${data.mode === 'DEMO' ? '시연 열차' : o.trainId.split(':').at(-1) + '번 열차'} · ${o.source}`));
    eta.append(el('b','',`${Math.floor(o.etaSeconds/60)}분 ${o.etaSeconds%60 ? o.etaSeconds%60 + '초' : ''}`),el('span','',time(o.generatedAt) + ' 생성'));
    row.append(el('span','train-symbol','▣'),info,eta); row.title = `생성: ${time(o.generatedAt)} / 수집: ${time(o.collectedAt)}`; list.append(row);
  });
}
function renderSubscriptions() {
  const list = $('#subscriptions'); list.replaceChildren();
  $('#sub-total').textContent = `${data.subscriptions.length} / 6`;
  $('#subscription-count').textContent = data.subscriptions.length ? `${data.subscriptions.length}개 관심 구간 구독 중` : '관심 구간을 등록해 주세요';
  if(!data.subscriptions.length) return empty(list,'관심 구간을 등록하고\n내 출근길 알림을 받아보세요.');
  data.subscriptions.forEach(sub => {
    const row = el('div','subscription-item'), remove = el('button','', '×'); remove.type = 'button'; remove.setAttribute('aria-label',`${sub.station} ${sub.direction} 구독 해제`);
    remove.addEventListener('click',async() => { try { await api(`/subscriptions/${encodeURIComponent(sub.id)}`,'DELETE'); await refresh(); toast('관심 구간을 해제했어요.'); } catch(e) { toast(e.message); } });
    row.append(el('i','line-chip','2'),el('strong','',sub.station),el('small','',sub.direction+' 순환'),remove); list.append(row);
  });
}
function renderAlerts(target, items, readButton) {
  target.replaceChildren();
  if(!items.length) return empty(target,'아직 알림이 없어요. 관심 구간에서 검증된 지연 징후가 생기면 알려드릴게요.');
  items.forEach(n => {
    const row = el('article','alert-item'), info = el('div'), title = el('h3','',n.title), when = el('time','',time(n.createdAt)); when.dateTime = n.createdAt;
    if(!n.read) title.append(el('span','unread-dot'));
    info.append(title,el('p','',n.body)); row.append(el('span','alert-icon' + (n.phase === 'RECOVERED' ? ' recovered' : ''),n.phase === 'RECOVERED' ? '↗' : '!'),info,when);
    if(readButton && !n.read) { const button = el('button','read-button','읽음'); button.addEventListener('click',async() => { try { await api(`/notifications/${encodeURIComponent(n.id)}/read`,'PATCH'); await refresh(); } catch(e) { toast(e.message); } }); row.append(button); }
    target.append(row);
  });
}
function renderActivity() {
  $('#activity-badge').textContent = data.busy ? '검증 진행 중' : '대기 중';
  for(const role of ['detector','verifier']) { const job = data.jobs.find(j => j.role === role); $('#' + role + '-state').textContent = job?.state === 'RUNNING' ? '분석 중' : job?.state === 'SUCCEEDED' ? '완료' : job ? '보류' : '대기'; }
  const timeline = $('#timeline'); timeline.replaceChildren();
  if(!data.messages.length) empty(timeline,'시연 또는 실시간 수집을 실행하면 협업 기록이 여기에 나타납니다.');
  data.messages.slice().reverse().forEach(m => {
    const row = el('div','timeline-row'), info = el('div'), heading = el('h3','',`${names[m.sender] || m.sender} → ${names[m.recipient] || m.recipient}`);
    heading.append(el('span','',m.type + (m.attempt ? ` · 재조회 ${m.attempt}` : '')));
    info.append(heading,el('p','',m.detail)); row.append(el('time','',time(m.createdAt)),el('span','timeline-avatar',m.sender === 'detector' ? 'A' : m.sender === 'verifier' ? 'B' : '↻'),info); timeline.append(row);
  });
  const runs = $('#runs'); runs.replaceChildren();
  if(!data.runs.length) empty(runs,'아직 실행 기록이 없습니다.');
  data.runs.slice(0,8).forEach(run => { const row = el('div','run-row'); row.append(el('strong','',scenarioNames[run.scenario] || run.scenario),el('span','subtle-tag',run.state),el('p','',run.detail),el('time','',time(run.startedAt))); runs.append(row); });
  if(watchedRun) { const run = data.runs.find(r => r.id === watchedRun); if(run) $('#scenario-result').textContent = `${scenarioNames[run.scenario] || run.scenario} · ${run.state} · ${run.detail}`; if(run?.finishedAt) { watchedRun = null; toast('시연 처리가 끝났어요. 구간 상태와 협업 기록을 확인하세요.'); } }
}
function render() {
  const demo = data.mode === 'DEMO';
  $('#mode-badge').textContent = demo ? 'SIMULATION' : 'LIVE DATA'; $('#mode-badge').classList.toggle('live',!demo);
  $('#mode-description').textContent = demo ? '시연 모드 · 합성 데이터입니다. 실제 운행 상황과 관계없습니다.' : '실시간 모드 · 서울시 위치·도착 정보 기반의 지연 의심을 확인합니다.';
  const delays = data.routes.filter(r => r.incident?.state === 'DELAY_SUSPECTED').length;
  $('#delay-count').textContent = delays; $('#delay-description').textContent = delays ? '마지막 판정 기준 · 구간 최신성 확인' : '최신 관측 여부를 구간에서 확인하세요';
  $('#engine-status').textContent = !data.settings.agentsConfigured ? '로컬 규칙 기반 시뮬레이션' : data.jobs[0]?.engine === 'openai' ? 'OpenAI 도구 호출 연결' : '샌드박스 연결 · 실행 기록 확인';
  const unread = data.notifications.filter(n => !n.read).length; $('#unread-count').textContent = unread; $('#nav-count').textContent = unread;
  const status = $('#settings-status'); status.replaceChildren();
  for(const [title,ready,description] of [['서울시 위치·도착 API',data.settings.seoulConfigured,'서버 키 설정'],['Daytona 에이전트 A · B',data.settings.agentsConfigured,'연결 주소 설정'],['현재 모드',true,demo ? 'DEMO · 합성 데이터' : 'LIVE · 실제 데이터']]) { const row = el('div','setting-row'); row.append(el('strong','',title),el('span',ready?'ready':'',ready?description:'설정 필요')); status.append(row); }
  $('#quota-text').textContent = `${data.settings.callsToday} / ${data.settings.dailyBudget}`; $('#quota-progress').max = data.settings.dailyBudget; $('#quota-progress').value = data.settings.callsToday;
  $$('[data-scenario]').forEach(button => button.disabled = data.busy || !demo);
  $('#set-demo').disabled = data.busy || demo; $('#set-live').disabled = data.busy || !demo || !data.settings.seoulConfigured || !data.settings.agentsConfigured; $('#collect-now').disabled = data.busy || demo;
  $('#last-updated').textContent = `마지막 화면 갱신 ${time(data.serverTime)} KST`;
  renderRoute(); renderSubscriptions(); renderActivity(); renderAlerts($('#recent-alerts'),data.notifications.slice(0,3),false); renderAlerts($('#all-alerts'),data.notifications,true);
  for(const n of data.notifications) { if(!initial && !seenNotices.has(n.id) && 'Notification' in window && Notification.permission === 'granted') new Notification(n.title,{body:n.body,tag:n.id,icon:'/favicon.svg'}); seenNotices.add(n.id); }
  initial = false;
}
async function refresh() {
  if(polling) return;
  polling = true;
  try { data = await api('/dashboard'); render(); $('#error-banner').hidden = true; $('#connection').textContent = '서버 연결됨'; $('#connection-dot').classList.remove('offline'); }
  catch(e) { $('#error-banner').textContent = '서버 연결을 확인해 주세요. 표시된 정보는 마지막 수신 결과입니다. 자동으로 다시 시도합니다.'; $('#error-banner').hidden = false; $('#connection').textContent = '연결 끊김'; $('#connection-dot').classList.add('offline'); }
  finally { polling = false; }
}
window.addEventListener('hashchange',navigate); navigate();
$$('[data-station]').forEach(b => b.addEventListener('click',() => { station = b.dataset.station; renderRoute(); }));
$$('[data-direction]').forEach(b => b.addEventListener('click',() => { direction = b.dataset.direction; renderRoute(); }));
$('#add-subscription').addEventListener('click',() => $('#subscription-dialog').showModal());
$('#close-dialog').addEventListener('click',() => $('#subscription-dialog').close());
$('#subscription-form').addEventListener('submit',async e => { e.preventDefault(); const button = e.currentTarget.querySelector('[type=submit]'); button.disabled = true; try { const form = new FormData(e.currentTarget); await api('/subscriptions','POST',{station:form.get('station'),direction:form.get('direction')}); $('#subscription-dialog').close(); await refresh(); toast('관심 구간을 등록했어요.'); } catch(error) { toast(error.message); } finally { button.disabled = false; } });
for(const [id,mode] of [['set-demo','DEMO'],['set-live','LIVE']]) $('#' + id).addEventListener('click',async() => { try { await api('/admin/mode','POST',{mode}); await refresh(); toast(mode === 'DEMO' ? '시연 모드로 전환했어요.' : '실시간 모드로 전환했어요.'); } catch(e) { toast(e.message); } });
$('#collect-now').addEventListener('click',async() => { try { const run = await api('/admin/collect','POST',{}); watchedRun = run.id; await refresh(); toast('서울시 데이터 수집을 시작했어요.'); } catch(e) { toast(e.message); } });
$$('[data-scenario]').forEach(button => button.addEventListener('click',async() => { button.disabled = true; try { station = $('#demo-station').value; direction = $('#demo-direction').value; const run = await api('/admin/scenarios','POST',{scenario:button.dataset.scenario,station,direction,requestId:crypto.randomUUID()}); watchedRun = run.id; $('#scenario-result').textContent = '시연 진행 중 · 탐지와 검증 기록을 저장하고 있습니다.'; await refresh(); } catch(e) { toast(e.message); } finally { if(data) button.disabled = data.busy || data.mode !== 'DEMO'; } }));
$('#enable-notifications').addEventListener('click',async() => { if(!('Notification' in window)) return toast('이 브라우저는 알림을 지원하지 않습니다. 웹 알림 목록을 이용해 주세요.'); const permission = await Notification.requestPermission(); toast(permission === 'granted' ? '페이지가 열려 있는 동안 새 알림을 받을 수 있어요.' : '브라우저 알림이 허용되지 않았어요. 웹 알림은 계속 표시됩니다.'); });
async function loop() { await refresh(); setTimeout(loop,5000); } loop();
