import { randomUUID, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fail } from './config.js';

export const EVALUATION_POLICY = Object.freeze({version:2, micros:12_000_000, analysisMicros:1_000_000, reportMicros:500_000, analyses:6, preparations:3, runs:30, days:30, fileDays:1, fileBytes:1_000_000, files:20, totalBytes:20_000_000});
export const digest = value => createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export function initializeEvaluations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evaluation_records(id TEXT PRIMARY KEY,evaluation TEXT NOT NULL,type TEXT NOT NULL,parent TEXT,doc TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_by_evaluation ON evaluation_records(evaluation,type);
    CREATE TABLE IF NOT EXISTS evaluation_files(id TEXT PRIMARY KEY,evaluation TEXT NOT NULL,doc TEXT NOT NULL,content BLOB);
    CREATE TABLE IF NOT EXISTS evaluation_keys(owner TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner,key));`);
  if(!db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='evaluation'))db.exec('ALTER TABLE requests ADD COLUMN evaluation TEXT');
}
export function evaluation(db,id,owner) {
  const row=db.prepare('SELECT doc FROM evaluations WHERE id=?').get(id),e=row&&JSON.parse(row.doc);
  if(!e||owner!==undefined&&e.owner!==owner)fail('NOT_FOUND','평가 프로젝트를 찾을 수 없습니다.',404);
  if(e.expiresAt<=Date.now()||e.deletedAt)fail('EXPIRED','평가 기록의 보관 기간이 끝났습니다.',410);
  return e;
}
export function createEvaluation(db,owner) {
  const e={id:randomUUID(),owner,createdAt:Date.now(),expiresAt:Date.now()+30*86400_000,revision:0,goals:[],policy:{...EVALUATION_POLICY}};
  db.prepare('INSERT INTO evaluations VALUES(?,?,?)').run(e.id,owner,JSON.stringify(e));return e;
}
export function putEvaluation(db,e) {e.revision++;db.prepare('UPDATE evaluations SET doc=? WHERE id=?').run(JSON.stringify(e),e.id);return e;}
export function records(db,id,type) {return db.prepare('SELECT doc FROM evaluation_records WHERE evaluation=? ORDER BY rowid').all(id).map(x=>JSON.parse(x.doc)).filter(x=>!type||x.type===type);}
export function putRecord(db,eid,type,value) {
  const doc={...value,id:value.id||randomUUID(),evaluationId:eid,type};
  db.prepare('INSERT INTO evaluation_records VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc').run(doc.id,eid,type,doc.parent||null,JSON.stringify(doc));
  putEvaluation(db,evaluation(db,eid));return doc;
}
export function getRecord(db,eid,id,type) {const r=records(db,eid,type).find(x=>x.id===id);if(!r)fail('NOT_FOUND','기록을 찾을 수 없습니다.',404);return r;}
export function idempotent(db,owner,key,fingerprint,make) {
  if(typeof key!=='string'||!/^[\w-]{8,100}$/.test(key))fail('INVALID_REQUEST','중복 방지 요청 ID가 필요합니다.');
  const prev=db.prepare('SELECT * FROM evaluation_keys WHERE owner=? AND key=?').get(owner,key);
  if(prev){if(prev.fingerprint!==fingerprint)fail('CONFLICT','같은 요청 ID의 내용이 변경됐습니다.',409);return JSON.parse(prev.record);}
  const result=make();db.prepare('INSERT INTO evaluation_keys VALUES(?,?,?,?)').run(owner,key,fingerprint,JSON.stringify(result));return result;
}
export function evaluationBudget(db,j,micros) {
  if(!j.evaluationId)return;
  const e=evaluation(db,j.evaluationId,j.owner),rows=db.prepare('SELECT r.micros,j.doc FROM requests r LEFT JOIN jobs j ON j.id=r.job WHERE r.evaluation=?').all(e.id);
  if(rows.reduce((s,r)=>s+r.micros,0)+micros>e.policy.micros)fail('BUDGET_EXCEEDED','평가 프로젝트 전체 비용 상한에 도달했습니다.');
  if(j.taskType){const cap=j.taskType==='report'?e.policy.reportMicros:j.taskType==='experience'?3_000_000:j.taskType==='prefetch'?600_000:j.taskType==='asset'?300_000:e.policy.analysisMicros;
    if(rows.filter(r=>r.doc&&JSON.parse(r.doc).taskType===j.taskType).reduce((s,r)=>s+r.micros,0)+micros>cap)fail('BUDGET_EXCEEDED','추가 분석 또는 리포트 비용 상한에 도달했습니다.');}
  if(db.prepare("SELECT COUNT(*) n FROM requests WHERE status!='settled'").get().n>=2)fail('CONCURRENCY_LIMIT','서비스 전체 모델 동시 요청 한도에 도달했습니다.');
}

// File bytes are encrypted separately from immutable experiment metadata. Never place them in model context.
export class EvaluationFiles {
  constructor(store){this.store=store;this.db=store.db;}
  save(eid,file) {
    const e=evaluation(this.db,eid),bytes=Buffer.from(file.base64,'base64');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)||!bytes.length||bytes.length>e.policy.fileBytes)fail('INVALID_FILE','실험 파일은 1MB 이하의 유효한 파일이어야 합니다.');
    const hash=digest(bytes),all=this.db.prepare('SELECT doc FROM evaluation_files WHERE evaluation=?').all(eid).map(r=>JSON.parse(r.doc));
    const name=String(file.name||'result').replace(/[^\w.가-힣-]/g,'_').slice(0,150),mime=String(file.mime||'application/octet-stream').slice(0,100);
    const same=all.find(f=>f.hash===hash&&f.name===name&&f.mime===mime&&f.expiresAt>Date.now());if(same)return {artifactId:same.id,name:same.name,mime:same.mime,hash:same.hash,size:same.size,expiresAt:same.expiresAt};
    const live=all.filter(f=>f.expiresAt>Date.now());if(live.length>=e.policy.files||live.reduce((n,f)=>n+f.size,0)+bytes.length>e.policy.totalBytes)fail('FILE_LIMIT','평가 프로젝트 파일 보관 한도에 도달했습니다.');
    const f={id:randomUUID(),name:String(file.name||'result').replace(/[^\w.가-힣-]/g,'_').slice(0,150),mime:String(file.mime||'application/octet-stream').slice(0,100),hash,size:bytes.length,createdAt:Date.now(),expiresAt:Math.min(e.expiresAt,Date.now()+86400_000)};
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.store.key,iv),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
    this.db.prepare('INSERT INTO evaluation_files VALUES(?,?,?,?)').run(f.id,eid,JSON.stringify(f),Buffer.concat([iv,cipher.getAuthTag(),encrypted]));
    return {artifactId:f.id,name:f.name,mime:f.mime,hash:f.hash,size:f.size,expiresAt:f.expiresAt};
  }
  get(eid,id) {
    evaluation(this.db,eid);const row=this.db.prepare('SELECT * FROM evaluation_files WHERE id=? AND evaluation=?').get(id,eid);
    if(!row)fail('NOT_FOUND','파일을 찾을 수 없습니다.',404);const f=JSON.parse(row.doc);
    if(f.expiresAt<=Date.now()||!row.content)fail('FILE_EXPIRED','파일이 만료됐습니다. 같은 조건으로 실행하려면 다시 업로드해주세요.',410);
    const b=Buffer.from(row.content),dec=createDecipheriv('aes-256-gcm',this.store.key,b.subarray(0,12));dec.setAuthTag(b.subarray(12,28));
    return {...f,bytes:Buffer.concat([dec.update(b.subarray(28)),dec.final()])};
  }
  snapshot(eid,value,depth=0) {
    if(depth>24)fail('INVALID_INPUT','입력의 중첩 깊이가 너무 큽니다.');
    if(value&&typeof value==='object'){
      if(typeof value.base64==='string')return this.save(eid,value);
      if(value.artifactId&&typeof value.hash==='string'&&typeof value.size==='number'){const f=this.get(eid,value.artifactId);return {artifactId:f.id,name:f.name,mime:f.mime,hash:f.hash,size:f.size,expiresAt:f.expiresAt};}
      if(Array.isArray(value))return value.map(v=>this.snapshot(eid,v,depth+1));
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.snapshot(eid,v,depth+1)]));
    }return value;
  }
  hydrate(eid,value,depth=0){
    if(depth>24)fail('INVALID_INPUT','입력의 중첩 깊이가 너무 큽니다.');
    if(value&&typeof value==='object'){
      if(value.artifactId&&typeof value.hash==='string'&&typeof value.size==='number'){const f=this.get(eid,value.artifactId);return {name:f.name,mime:f.mime,base64:f.bytes.toString('base64')};}
      if(Array.isArray(value))return value.map(v=>this.hydrate(eid,v,depth+1));
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.hydrate(eid,v,depth+1)]));
    }return value;
  }
  extend(eid,id){this.get(eid,id);const row=this.db.prepare('SELECT doc FROM evaluation_files WHERE id=?').get(id),f=JSON.parse(row.doc);f.expiresAt=Math.min(evaluation(this.db,eid).expiresAt,f.createdAt+7*86400_000);this.db.prepare('UPDATE evaluation_files SET doc=? WHERE id=?').run(JSON.stringify(f),id);return f;}
  expire(){for(const row of this.db.prepare('SELECT id,doc FROM evaluation_files WHERE content IS NOT NULL').all())if(JSON.parse(row.doc).expiresAt<=Date.now())this.db.prepare('UPDATE evaluation_files SET content=NULL WHERE id=?').run(row.id);}
}
