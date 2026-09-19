import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Store, redact } from './store.js';
import { Models } from './model.js';
import { modelConfiguration } from './nosana.js';
import { ExecutionEnvironments } from './execution-environments.js';
import { Orchestrator } from './orchestrator.js';
import { validateURL } from './network.js';
import { validateInput } from './contracts.js';
import { fail, PREPARING, POLICY } from './config.js';
import { Evaluations } from './evaluations.js';
import { hostingConfig, hostingGate } from './hosting.js';

export function createApp({store=new Store(),models,sandboxes,orchestrator,hosting=hostingConfig(),evaluationOptions={}}={}) {
  models??=new Models(store);sandboxes??=new ExecutionEnvironments(store);orchestrator??=new Orchestrator(store,models,sandboxes);
  const evaluations=new Evaluations(store,models,sandboxes,orchestrator,evaluationOptions);orchestrator.evaluations=evaluations;
  const app=express();app.disable('x-powered-by');
  app.use(hostingGate(hosting));
  const sessions=new Set();const expectedHost=process.env.HOST||'127.0.0.1';
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    if(!['127.0.0.1','localhost','::1',expectedHost,hosting.hostname].includes(req.hostname))return res.status(403).json({error:'허용되지 않은 호스트입니다.'});
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)return res.status(403).json({error:'다른 출처의 요청은 허용하지 않습니다.'});
      if(req.headers['x-playground-request']!=='1')return res.status(403).json({error:'요청 검증 헤더가 필요합니다.'});
    }
    const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('pg_session='))?.slice(11);
    if(cookie&&sessions.has(cookie))req.owner=hosting.remote&&hosting.publicDemo?'guest:'+cookie:'local';
    else if(req.method==='GET'&&!req.path.startsWith('/api/jobs/')){const token=randomBytes(24).toString('hex');sessions.add(token);res.cookie('pg_session',token,{httpOnly:true,sameSite:'strict',secure:hosting.remote,maxAge:86400_000});req.owner=hosting.remote&&hosting.publicDemo?'guest:'+token:'local';}
    else return res.status(401).json({error:'페이지를 새로고침해주세요.'});
    next();
  });
  app.use(express.json({limit:'1500kb'}));
  const config=()=>({openai:Boolean(process.env.OPENAI_API_KEY),model:modelConfiguration(),daytona:Boolean(process.env.DAYTONA_API_KEY),snapshot:Boolean(process.env.DAYTONA_SNAPSHOT)});
  const numericSetting=(name,fallback,{integer=true,positive=true}={})=>{const value=Number(process.env[name]??fallback);if(!Number.isFinite(value)||integer&&!Number.isInteger(value)||value<(positive?1:0))fail('INVALID_CONFIG',`${name} 설정이 유효하지 않습니다.`,503);return value;};
  const publicJob=j=>{
    const copy={...j,usage:store.usage(j.id)};
    const rootFailure=[...(j.failures||[])].reverse().find(f=>!['BUDGET_EXCEEDED','NO_PROGRESS'].includes(f.code));
    const oldFailure=[...(j.journal||[])].reverse().find(f=>f.exitCode&&f.error);
    if(rootFailure)copy.primaryFailure=rootFailure.message;else if(oldFailure){try{copy.primaryFailure=JSON.parse(oldFailure.error.trim().split('\n').at(-1)).error;}catch{copy.primaryFailure=oldFailure.error.slice(-1000);}}
    for(const key of ['owner','controlToken','previewToken','databaseUrl','source','sessions','root','sandboxName','lastFailure','journal','recipeFiles','apiInvocation'])delete copy[key];
    if(copy.plan){copy.plan={...copy.plan};for(const key of ['files','install','start','adapter'])delete copy.plan[key];copy.plan.database={kind:copy.plan.database.kind};}
    if(copy.state!=='READY')delete copy.preview;
    const safe=redact(copy,[store.secret(j.id),j.controlToken,j.previewToken,j.databaseUrl,process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY]);
    if(j.state==='READY'&&j.preview)safe.preview=j.preview; // Only the intended port-scoped preview link may contain its credential.
    return safe;
  };
  const owned=(req)=>{const j=store.get(req.params.id);if(!j||j.purged||j.owner!==req.owner)fail('NOT_FOUND','작업을 찾을 수 없습니다.',404);return j;};
  const jobPolicy=()=>({userRequests:numericSetting('EXTERNAL_USER_REQUESTS',50),externalMicros:Math.floor(numericSetting('EXTERNAL_JOB_BUDGET_USD',0,{integer:false,positive:false})*1e6),sandboxDailyMinutes:numericSetting('DAYTONA_DAILY_MINUTES',POLICY.sandboxDailyMinutes),maxSandboxes:numericSetting('DAYTONA_MAX_SANDBOXES',POLICY.maxSandboxes)});
  app.get('/api/config',(_req,res)=>res.json({configured:config(),limits:{jobUSD:POLICY.jobMicros/1e6,userDayUSD:POLICY.userDayMicros/1e6,serviceDayUSD:POLICY.serviceDayMicros/1e6,minutes:POLICY.activeMs/60_000,repairs:POLICY.repairs,ttlMinutes:POLICY.readyMs/60_000,calls:POLICY.calls},infrastructure:store.infrastructureStatus(jobPolicy()),mode:hosting.remote?(hosting.publicDemo?'public-demo':'private-hosted'):'local'}));
  app.get('/api/jobs',(req,res)=>res.json(store.list(req.owner,{dismissed:req.query.dismissed==='1'}).map(publicJob)));
  app.post('/api/jobs',(req,res)=>{
    if(!config().model.ready)fail('CONFIG_REQUIRED','선택한 모델 제공사의 연결 설정을 확인해주세요.',503);
    const url=validateURL(String(req.body.url||'')).href;
    if(/[?&](key|api_key|token|access_token|secret|password)=/i.test(url))fail('INVALID_URL','URL에 키를 넣지 마세요. 인증 입력 화면에서 연결할 수 있습니다.');
    const dedup=req.headers['idempotency-key'];if(typeof dedup!=='string'||!/^[\w-]{8,100}$/.test(dedup))fail('INVALID_REQUEST','중복 방지 요청 ID가 필요합니다.');
    const job=store.create(req.owner,url,dedup,jobPolicy());
    if(job.state==='ANALYZING')orchestrator.start(job.id);
    res.status(202).json(publicJob(job));
  });
  app.get('/api/jobs/:id',(req,res)=>res.json(publicJob(owned(req))));
  app.patch('/api/jobs/:id/name',(req,res)=>res.json(publicJob(store.renameProject(owned(req).id,req.owner,req.body.name))));
  app.delete('/api/jobs/:id',(req,res)=>{store.dismiss(owned(req).id,req.owner);res.json({ok:true});});
  app.post('/api/jobs/:id/restore',(req,res)=>res.json(publicJob(store.dismiss(owned(req).id,req.owner,false))));
  app.get('/api/jobs/:id/events',(req,res)=>{
    owned(req);res.set({'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    let seq=-1,timer;
    const send=()=>{const j=store.get(req.params.id);if(!j||j.purged){clearInterval(timer);res.write('event: deleted\ndata: {}\n\n');res.end();return;}if(j.seq>seq){seq=j.seq;res.write(`id: ${seq}\ndata: ${JSON.stringify(publicJob(j))}\n\n`);}else res.write(': heartbeat\n\n');};
    send();if(!res.writableEnded)timer=setInterval(send,2000);req.on('close',()=>clearInterval(timer));
  });
  app.post('/api/jobs/:id/credentials',(req,res)=>{const j=owned(req);const value=req.body.value;if(typeof value!=='string'||value.length<3||value.length>4096||/[\r\n]/.test(value))fail('INVALID_KEY','키 형식을 확인해주세요.');orchestrator.credentials(j.id,value);res.json({ok:true});});
  app.post('/api/jobs/:id/connection',(req,res)=>{orchestrator.connection(owned(req).id,req.body);res.json({ok:true});});
  app.post('/api/jobs/:id/sample',(req,res)=>{const j=owned(req);if(j.waitKind!=='sample')fail('INVALID_STATE','테스트 입력을 기다리는 작업이 아닙니다.');orchestrator.sample(j.id,validateInput(j.plan.fields,req.body));res.json({ok:true});});
  app.post('/api/jobs/:id/source',(req,res)=>{const j=owned(req);orchestrator.selectSource(j.id,req.body.choiceId);res.json({ok:true});});
  app.post('/api/jobs/:id/cancel',async(req,res)=>{await orchestrator.cancel(owned(req).id);res.json(publicJob(store.get(req.params.id)));});
  app.post('/api/jobs/:id/invoke',async(req,res)=>{const j=owned(req);const run=await evaluations.invoke(j.evaluationId,req.owner,j.id,req.body,req.headers['idempotency-key']);res.json({state:run.state,status:run.status,data:run.output,error:run.error,runId:run.id});});
  app.get('/api/evaluations',(req,res)=>res.json(store.db.prepare('SELECT doc FROM evaluations WHERE owner=? ORDER BY rowid DESC').all(req.owner).map(r=>JSON.parse(r.doc)).filter(e=>e.expiresAt>Date.now()).map(e=>({id:e.id,title:e.goals.at(-1)?.purpose||'기본 기능 체험',expiresAt:e.expiresAt}))));
  app.get('/api/evaluations/:eid',(req,res)=>res.json(evaluations.snapshot(req.params.eid,req.owner)));
  app.post('/api/evaluations/:eid/goals',(req,res)=>res.json(evaluations.goal(req.params.eid,req.owner,req.body)));
  app.post('/api/evaluations/:eid/experiments',(req,res)=>res.json(evaluations.draft(req.params.eid,req.owner,req.body)));
  app.post('/api/evaluations/:eid/prefetch',(req,res)=>res.status(202).json(evaluations.prefetch.prepare(req.params.eid,req.owner,req.body)||{state:'SKIPPED'}));
  app.post('/api/evaluations/:eid/experiments/:experimentId/runs',async(req,res)=>res.json(await evaluations.run(req.params.eid,req.owner,req.params.experimentId,req.headers['idempotency-key'],req.body)));
  app.post('/api/evaluations/:eid/runs/:runId/feedback',(req,res)=>res.json(evaluations.feedback(req.params.eid,req.owner,req.params.runId,req.body)));
  app.post('/api/evaluations/:eid/analyses',(req,res)=>res.status(202).json(evaluations.analyze(req.params.eid,req.owner,req.body)));
  app.post('/api/evaluations/:eid/runs/:runId/experience',(req,res)=>res.status(202).json(evaluations.scheduleExperience(req.params.eid,req.owner,req.params.runId)||{state:'QUEUED'}));
  app.post('/api/evaluations/:eid/suggestions/:cardId/prepare',(req,res)=>res.status(202).json(evaluations.prepareCard(req.params.eid,req.owner,req.params.cardId,{retry:req.body?.retry===true})));
  app.get('/api/evaluations/:eid/analyses/:taskId/presentation',(req,res)=>{
    evaluations.get(req.params.eid,req.owner);const a=evaluations.record(req.params.eid,req.params.taskId,'analysis');if(!a.presentation)fail('NOT_READY','결과 화면을 준비 중입니다.',409);
    res.set({'X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox"}).type('html').send(a.presentation);
  });
  app.post('/api/evaluations/:eid/tasks/:taskId/cancel',async(req,res)=>{await evaluations.cancelTask(req.params.eid,req.owner,req.params.taskId);res.json({ok:true});});
  app.post('/api/evaluations/:eid/transitions',(_req,_res)=>fail('FEATURE_REMOVED','대안 서비스 재체험은 현재 지원하지 않습니다.',410));
  app.get('/api/evaluations/:eid/jobs/:jobId/mapping',(req,res)=>res.json(evaluations.mapping(req.params.eid,req.owner,req.params.jobId)));
  app.get('/api/evaluations/:eid/jobs/:jobId/recipe',(req,res)=>{const r=evaluations.recipe(req.params.eid,req.owner,req.params.jobId);if(!r.available)fail('NOT_READY',r.reason,409);res.set('Content-Disposition',`attachment; filename="recipe-${req.params.jobId}.md"`).type('text/markdown').send(r.markdown);});
  app.post('/api/evaluations/:eid/reports',(req,res)=>{const r=evaluations.report(req.params.eid,req.owner,req.body);const {markdown,...meta}=r;res.status(r.state==='COMPLETED'?201:202).json(meta);});
  app.get('/api/evaluations/:eid/reports/:reportId/download',(req,res)=>{evaluations.get(req.params.eid,req.owner);const r=evaluations.record(req.params.eid,req.params.reportId,'report');if(r.expiresAt<=Date.now())fail('EXPIRED','리포트 파일이 만료됐습니다.',410);if(!r.markdown)fail('NOT_READY',r.error||'리포트를 준비 중입니다.',409);res.set('Content-Disposition',`attachment; filename="run-report-${r.id}.md"`).type('text/markdown').send(r.markdown);});
  app.get('/api/evaluations/:eid/files/:fileId',(req,res)=>{evaluations.get(req.params.eid,req.owner);const f=evaluations.files.get(req.params.eid,req.params.fileId);res.set('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`).type('application/octet-stream').send(f.bytes);});
  app.get('/api/evaluations/:eid/files/:fileId/preview',(req,res)=>{
    evaluations.get(req.params.eid,req.owner);const f=evaluations.files.get(req.params.eid,req.params.fileId),b=f.bytes;
    const mime=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':/^GIF8[79]a$/.test(b.subarray(0,6).toString())?'image/gif':b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'?'image/webp':null;
    if(!mime)fail('UNSUPPORTED_FORMAT','미리보기는 확인된 PNG·JPEG·GIF·WebP 파일만 지원합니다.');res.type(mime).send(b);
  });
  app.post('/api/evaluations/:eid/files/:fileId/extend',(req,res)=>{evaluations.get(req.params.eid,req.owner);res.json(evaluations.files.extend(req.params.eid,req.params.fileId));});
  app.delete('/api/evaluations/:eid',async(req,res)=>{await evaluations.remove(req.params.eid,req.owner);res.json({ok:true});});
  app.get('/api/jobs/:id/evidence',(req,res)=>{const j=owned(req);if(!j.evidence.some(e=>e.role==='E'))fail('NOT_FOUND','브라우저 검증 이미지가 없습니다.',404);res.sendFile(resolve('data/evidence',j.id+'.png'));});
  app.use(express.static(resolve('public')));
  app.use((err,_req,res,_next)=>res.status(err.status||400).json({code:err.code||'REQUEST_FAILED',error:redact(err.message,[process.env.OPENAI_API_KEY,process.env.DAYTONA_API_KEY]).slice(0,1800)}));
  return {app,store,orchestrator,evaluations};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve('src/server.js')) {
  const {app,orchestrator,evaluations}=createApp();
  const host=process.env.HOST||'127.0.0.1';
  await orchestrator.recover();
  evaluations.recover();await evaluations.sweep();
  const server=app.listen(Number(process.env.PORT||3000),host,()=>console.log(`URL to Playground → http://${host}:${process.env.PORT||3000}`));
  let sweeping=false;const timer=setInterval(async()=>{if(sweeping)return;sweeping=true;try{await orchestrator.sweep();await evaluations.sweep();}catch{console.error('자원 정리 재시도 예정');}finally{sweeping=false;}},10_000);timer.unref();
  const stop=()=>{clearInterval(timer);server.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
