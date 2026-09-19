import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { POLICY, PRICES, PREPARING, TERMINAL, day, fail } from './config.js';
import { initializeEvaluations, createEvaluation, evaluation, evaluationBudget } from './evaluation-data.js';
import { serviceIdentity } from './project-names.js';

export class Store {
  constructor(dir = 'data') {
    mkdirSync(dir, { recursive: true });
    const keyFile = join(dir, 'secrets.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyFile);
    this.db = new DatabaseSync(join(dir, 'playground.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, dedup TEXT NOT NULL, state TEXT NOT NULL, doc TEXT NOT NULL, UNIQUE(owner,dedup));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, job TEXT, owner TEXT, day TEXT, role TEXT, model TEXT, round INTEGER, input INTEGER, output INTEGER, micros INTEGER, status TEXT);
      CREATE TABLE IF NOT EXISTS secrets (job TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS infrastructure (job TEXT PRIMARY KEY, day TEXT, minutes INTEGER);
      CREATE TABLE IF NOT EXISTS events (job TEXT, seq INTEGER, data TEXT, PRIMARY KEY(job,seq));`);
    initializeEvaluations(this.db);
    this.tx(()=>{for(const j of this.all())if(!j.evaluationId&&!j.purged){j.evaluationId=createEvaluation(this.db,j.owner).id;this.save(j);this.db.prepare('UPDATE requests SET evaluation=? WHERE job=?').run(j.evaluationId,j.id);}});
    this.tx(()=>{for(const row of this.db.prepare('SELECT doc FROM jobs ORDER BY rowid').all()){const j=JSON.parse(row.doc);if(!j.taskType&&!j.purged&&!j.projectName)this.save(j);}});
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(id) { const row = this.db.prepare('SELECT doc FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.doc) : null; }
  list(owner, {dismissed=false}={}) { return this.db.prepare(`SELECT doc FROM jobs WHERE owner=? AND json_extract(doc,'$.taskType') IS NULL AND json_extract(doc,'$.purged') IS NULL AND json_extract(doc,'$.dismissedAt') IS ${dismissed?'NOT ':''}NULL ORDER BY rowid DESC LIMIT 30`).all(owner).map(r => JSON.parse(r.doc)); }
  dismiss(id, owner, dismissed=true) {
    return this.update(id,j=>{
      if(j.owner!==owner||j.purged||j.taskType)fail('NOT_FOUND','작업을 찾을 수 없습니다.',404);
      if(!TERMINAL.has(j.state))fail('INVALID_STATE','진행 중인 체험은 먼저 종료해주세요.',409);
      // Removing a history entry must not interrupt cleanup or erase comparison/billing records.
      if(dismissed)j.dismissedAt??=Date.now();else delete j.dismissedAt;
    });
  }
  all() { return this.db.prepare('SELECT doc FROM jobs').all().map(r => JSON.parse(r.doc)); }
  nameProject(j){
    if(j.taskType||j.purged)return;
    const {key,name}=serviceIdentity(j);
    if(j.serviceKey!==key||!Number.isInteger(j.serviceNumber)){
      const previous=this.db.prepare("SELECT MAX(json_extract(doc,'$.serviceNumber')) n FROM jobs WHERE owner=? AND id!=? AND json_extract(doc,'$.serviceKey')=?").get(j.owner,j.id,key);
      j.serviceKey=key;j.serviceNumber=(previous.n||0)+1;
    }
    j.serviceName=name;j.autoProjectName=name+(j.serviceNumber>1?` (${j.serviceNumber})`:'');
    j.projectName=j.customProjectName||j.autoProjectName;
  }
  renameProject(id,owner,name){
    if(typeof name!=='string'||!name.trim()||name.trim().length>80||/[\u0000-\u001f\u007f]/.test(name))fail('INVALID_NAME','프로젝트 이름은 1~80자의 한 줄로 입력해주세요.');
    return this.update(id,j=>{if(j.owner!==owner||j.purged||j.taskType)fail('NOT_FOUND','체험을 찾을 수 없습니다.',404);j.customProjectName=name.trim();});
  }
  save(j) {
    this.nameProject(j);
    j.updatedAt = Date.now(); j.seq = (j.seq || 0) + 1;
    this.db.prepare('UPDATE jobs SET state=?,doc=? WHERE id=?').run(j.state, JSON.stringify(j), j.id);
    this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(j.id, j.seq, JSON.stringify({ state: j.state, updatedAt: j.updatedAt, planVersion: j.planVersion }));
    return j;
  }
  update(id, fn) { return this.tx(() => { const j = this.get(id); if (!j) fail('NOT_FOUND', '작업을 찾을 수 없습니다.', 404); fn(j); return this.save(j); }); }
  create(owner, url, dedup, extra = {}, metadata = {}) {
    return this.tx(() => {
      const same = this.db.prepare('SELECT doc FROM jobs WHERE owner=? AND dedup=?').get(owner, dedup);
      if (same) {const previous=JSON.parse(same.doc);if(previous.url!==url||previous.taskType!==metadata.taskType||metadata.evaluationId&&previous.evaluationId!==metadata.evaluationId)fail('CONFLICT','같은 요청 ID의 내용이 변경됐습니다.',409);return previous;}
      // The URL may describe an API: reserve Daytona only after classification,
      // at Sandboxes.create(), never for direct API calls or model-only tasks.
      const all=this.all(),e=metadata.evaluationId?evaluation(this.db,metadata.evaluationId,owner):createEvaluation(this.db,owner);
      if(metadata.taskType){
        const tasks=all.filter(j=>j.evaluationId===e.id&&j.taskType);
        if(tasks.some(j=>PREPARING.has(j.state)&&(metadata.taskType==='prefetch'?j.taskType==='prefetch':j.taskType!=='prefetch')))fail('ACTIVE_JOB','이 프로젝트의 분석이 진행 중입니다.',409);
        if(metadata.taskType==='prefetch'&&tasks.filter(j=>j.taskType==='prefetch').length>=40)fail('BUDGET_EXCEEDED','다음 실험 사전 준비 40회 한도에 도달했습니다.');
        if(metadata.taskType==='analysis'&&tasks.filter(j=>j.taskType==='analysis').length>=e.policy.analyses)fail('BUDGET_EXCEEDED','추가 분석 6회를 모두 사용했습니다.');
        if(metadata.taskType==='report'&&tasks.filter(j=>j.taskType==='report').length>=4)fail('BUDGET_EXCEEDED','리포트 생성 횟수 상한에 도달했습니다.');
        if(metadata.taskType==='experience'&&tasks.filter(j=>j.taskType==='experience').length>=60)fail('BUDGET_EXCEEDED','결과 화면·자동 실험 제안 60회 한도에 도달했습니다.');
        if(metadata.taskType==='asset'&&tasks.filter(j=>j.taskType==='asset').length>=6)fail('BUDGET_EXCEEDED','프로젝트의 이미지 생성 6회 한도에 도달했습니다. 직접 파일을 선택할 수 있습니다.');
      }else{
        if(all.some(j=>j.owner===owner&&!j.taskType&&PREPARING.has(j.state)))fail('ACTIVE_JOB','이미 준비 중인 작업이 있습니다.',409);
        if(all.filter(j=>j.evaluationId===e.id&&!j.taskType).length>=e.policy.preparations)fail('BUDGET_EXCEEDED','평가 프로젝트의 준비 작업 3회를 모두 사용했습니다.');
      }
      const j = { id: randomUUID(), owner, url, state: 'ANALYZING', createdAt: Date.now(), updatedAt: Date.now(), seq: 0,
        policy: { ...POLICY, ...extra }, planVersion: 0, steps: [], message: 'URL과 실행 방법을 분석하고 있어요',
        activeSince: Date.now(), activeSpent: 0, round: 0, counters: {}, logs: [], evidence: [], cleanupPending: false, ...metadata, evaluationId:e.id };
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(j.id, owner, dedup, j.state, JSON.stringify(j));
      return this.save(j);
    });
  }
  remaining(j) { return j.policy.activeMs - j.activeSpent - (j.activeSince ? Date.now() - j.activeSince : 0); }
  assertActive(j) {
    if(!j)fail('NOT_FOUND','작업을 찾을 수 없습니다.',404);
    if(j.evaluationId)evaluation(this.db,j.evaluationId,j.owner);
    if (!PREPARING.has(j.state) || j.state === 'WAITING_FOR_USER') fail('STOPPED', '작업이 진행 중이 아닙니다.');
    if (this.remaining(j) <= 0) fail('TIME_LIMIT_EXCEEDED', `자동 준비 시간 ${j.policy.activeMs/60_000}분을 모두 사용했습니다.`);
  }
  count(id, type, amount = 1, ready = false) {
    return this.update(id, j => {
      if (!ready) this.assertActive(j);
      else if (!['READY', ...PREPARING].includes(j.state)) fail('STOPPED', '종료된 체험입니다.');
      const limit = type === 'userRequests' ? j.policy.userRequests : j.policy[type];
      if (!Number.isFinite(limit) || (j.counters[type] || 0) + amount > limit) fail('BUDGET_EXCEEDED', `${type} 실행 한도에 도달했습니다.`);
      j.counters[type] = (j.counters[type] || 0) + amount;
    });
  }
  reserve(jobId, role, model, input, output) {
    return this.tx(() => {
      const j = this.get(jobId); this.assertActive(j); const p = j.policy;
      const rate = PRICES[model]; if (!rate) fail('UNKNOWN_PRICE', '요율이 확인되지 않은 모델입니다.');
      if (input > p.inputPerCall || output > p.outputPerCall || input < 1 || output < 1) fail('BUDGET_EXCEEDED', '요청당 토큰 상한을 초과했습니다.');
      const rows = this.db.prepare('SELECT * FROM requests WHERE job=?').all(jobId);
      if (rows.length >= p.calls || rows.filter(r => r.role === role).length >= p.roleCalls) fail('BUDGET_EXCEEDED', '모델 호출 횟수를 모두 사용했습니다.');
      if (rows.filter(r => ['pending','unknown'].includes(r.status)).length >= p.concurrency) fail('CONCURRENCY_LIMIT', '진행 중이거나 사용량이 미확정인 모델 요청은 최대 2개입니다.');
      if (model === 'gpt-5.6-sol') {
        const sol = rows.filter(r => r.model === model);
        if (!j.round || sol.length >= 2 || sol.some(r => r.round !== j.round)) fail('BUDGET_EXCEEDED', '상위 모델 수정 한도를 사용했습니다.');
      }
      if (rows.reduce((s,r) => s+r.input,0)+input > p.inputTotal || rows.reduce((s,r)=>s+r.output,0)+output > p.outputTotal) fail('BUDGET_EXCEEDED', '작업 전체 토큰 한도에 도달했습니다.');
      const micros = Math.ceil(input * rate.input + output * rate.output);
      evaluationBudget(this.db,j,micros);
      const daily = this.db.prepare('SELECT owner,micros FROM requests WHERE day=?').all(day());
      if (rows.reduce((s,r)=>s+r.micros,0)+micros > p.jobMicros || daily.filter(r=>r.owner===j.owner).reduce((s,r)=>s+r.micros,0)+micros > p.userDayMicros || daily.reduce((s,r)=>s+r.micros,0)+micros > p.serviceDayMicros) fail('BUDGET_EXCEEDED', '작업 또는 일일 비용 상한에 도달했습니다.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO requests(id,job,owner,day,role,model,round,input,output,micros,status,evaluation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, jobId, j.owner, day(), role, model, j.round, input, output, micros, 'pending',j.evaluationId||null);
      return { id, micros };
    });
  }
  settle(id, usage) {
    return this.tx(() => {
      const r = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
      if (!r || r.status === 'settled') return;
      if (!usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) {
        this.db.prepare("UPDATE requests SET status='unknown' WHERE id=?").run(id); return;
      }
      const rate = PRICES[r.model];
      // Keep conservative cache-write input rate in the ledger; never overstate precision.
      const micros = Math.ceil(usage.input_tokens * rate.input + usage.output_tokens * rate.output);
      this.db.prepare("UPDATE requests SET input=?,output=?,micros=?,status='settled' WHERE id=?").run(usage.input_tokens, usage.output_tokens, micros, id);
      if (micros > r.micros || usage.input_tokens > r.input || usage.output_tokens > r.output) {
        const j = this.get(r.job); j.state = 'FAILED'; j.reason = 'METERING_MISMATCH'; j.message = '제공사 사용량이 예약 상한과 달라 자동 실행을 중단했습니다.'; this.save(j);
      }
    });
  }
  usage(id) {
    const rows = this.db.prepare('SELECT * FROM requests WHERE job=?').all(id);
    return { calls: rows.length, rentalCalls:rows.filter(r=>PRICES[r.model]?.billing==='gpu-hour').length, openaiCalls:rows.filter(r=>PRICES[r.model]?.billing!=='gpu-hour').length, input: rows.reduce((s,r)=>s+r.input,0), output: rows.reduce((s,r)=>s+r.output,0),
      micros: rows.reduce((s,r)=>s+r.micros,0), reserved: rows.filter(r=>r.status!=='settled').reduce((s,r)=>s+r.micros,0),
      roles: Object.fromEntries('ABCDEF'.split('').map(role=>[role,rows.filter(r=>r.role===role).length])) };
  }
  abandonNosana(id){
    // Release only the slot of an ended Nosana attempt. Keep its uncertain
    // tokens/costs and request count; never settle an unknown response as zero.
    this.tx(()=>{const r=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(r?.status==='unknown'&&PRICES[r.model]?.billing==='gpu-hour')this.db.prepare("UPDATE requests SET status='abandoned' WHERE id=?").run(id);});
  }
  reserveInfrastructure(id) {
    this.tx(() => {
      if (this.db.prepare('SELECT job FROM infrastructure WHERE job=?').get(id)) return;
      const j=this.get(id); this.assertActive(j);
      this.assertInfrastructure(j.policy);
      this.db.prepare('INSERT INTO infrastructure VALUES(?,?,?)').run(id,day(),j.policy.sandboxMinutes);
    });
  }
  infrastructureStatus(policy={}){
    const used=this.db.prepare('SELECT COALESCE(SUM(minutes),0) AS n FROM infrastructure WHERE day=?').get(day()).n;
    const limit=policy.sandboxDailyMinutes??POLICY.sandboxDailyMinutes,reservation=policy.sandboxMinutes??POLICY.sandboxMinutes;
    const active=this.all().filter(j=>(j.sandboxId||j.sandboxName)&&!j.cleanedAt).length,max=policy.maxSandboxes??POLICY.maxSandboxes;
    return {used,limit,reservation,active,max,available:used+reservation<=limit&&active<max,resetsAt:new Date(new Date().setUTCHours(24,0,0,0)).toISOString()};
  }
  assertInfrastructure(policy){const s=this.infrastructureStatus(policy);if(!s.available)fail('INFRA_BUDGET',s.used+s.reservation>s.limit?`오늘 Daytona 예약 한도 ${s.limit}분 중 ${s.used}분을 사용했습니다. 한도 초기화: ${s.resetsAt}. API 직접 호출은 계속 이용할 수 있습니다.`:'동시 샌드박스 한도에 도달했습니다. 기존 환경 정리 후 다시 시도해주세요. API 직접 호출은 계속 이용할 수 있습니다.');}
  secret(id, value) {
    if (value === undefined) {
      const row=this.db.prepare('SELECT value FROM secrets WHERE job=?').get(id); if(!row) return null;
      const [iv,tag,content]=row.value.split('.').map(v=>Buffer.from(v,'base64'));
      const d=createDecipheriv('aes-256-gcm',this.key,iv); d.setAuthTag(tag); return Buffer.concat([d.update(content),d.final()]).toString();
    }
    if (value === null) { this.db.prepare('DELETE FROM secrets WHERE job=?').run(id); return; }
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv),data=Buffer.concat([c.update(value),c.final()]);
    this.db.prepare('INSERT OR REPLACE INTO secrets VALUES(?,?)').run(id,[iv,c.getAuthTag(),data].map(b=>b.toString('base64')).join('.'));
  }
  repair(id, fingerprint) {
    return this.update(id,j=>{
      this.assertActive(j);
      if(j.lastFailure===fingerprint) fail('NO_PROGRESS','같은 코드와 입력에서 같은 실패가 반복되어 중단했습니다.');
      if(j.round>=j.policy.repairs) fail('BUDGET_EXCEEDED',`전체 자동 수정 ${j.policy.repairs}회를 사용했습니다.`);
      j.lastFailure=fingerprint; j.round++;
    });
  }
  close() { this.db.close(); }
}
export const hash = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function redact(value, secrets = []) {
  secrets=[...secrets,process.env.NOSANA_INFERENCE_TOKEN,process.env.NOSANA_IMAGE_TOKEN,process.env.NOSANA_API_KEY];
  const walk = (x) => {
    if (typeof x === 'string') { let s=x; for(const v of secrets.filter(Boolean)) s=s.split(v).join('[숨김]'); return s.replace(/(Bearer\s+)[\w.\-]+/gi,'$1[숨김]').replace(/sk-[\w-]{16,}/g,'[숨김]'); }
    if(Array.isArray(x)) return x.map(walk);
    if(x&&typeof x==='object') return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,/^(authorization|password|secret|token|access_token|api[_-]?key|cookie|set-cookie)$/i.test(k)?'[숨김]':walk(v)]));
    return x;
  }; return walk(value);
}
