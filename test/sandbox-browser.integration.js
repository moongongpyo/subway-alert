import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

test('sandbox browser opens optional fields and submits the actual shared request form',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-browser-optional-')),app=express();let received;
  app.use(express.json());app.use((_req,res,next)=>{res.set('x-playground-version','regression-v1');next();});
  app.get('/contract',async(_req,res)=>{await delay(100);res.json({title:'QR options regression',capability:'QR options',viewer:{fields:[]},fields:[
    {name:'data',label:'내용',type:'text',required:true,description:'Text'},
    {name:'version',label:'버전',type:'number',required:false,description:'Size'},
    {name:'error_correction',label:'오류 보정',type:'text',required:false,description:'Level'},
  ]});});
  app.post('/invoke',(req,res)=>{received=req.body;res.json({status:200,data:{text:req.body.data,version:req.body.version,error_correction:req.body.error_correction}});});
  app.get('/',(_req,res)=>res.sendFile(resolve('public/playground.html')));
  app.use(express.static(resolve('public')));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});});
  const config=join(dir,'config.json');writeFileSync(config,JSON.stringify({generic:true,url:`http://127.0.0.1:${server.address().port}`,version:'regression-v1',sample:{data:'https://example.com',version:'1',error_correction:'M'},screenshot:join(dir,'evidence.png')}));
  const {stdout}=await promisify(execFile)(process.execPath,[resolve('sandbox/browser.mjs'),config],{timeout:45000,windowsHide:true});
  const result=JSON.parse(stdout.trim().split('\n').at(-1));assert.equal(result.passed,true);
  assert.deepEqual(received,{data:'https://example.com',version:1,error_correction:'M'});
});
