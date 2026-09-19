import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {request} from 'node:http';
import {hostingConfig,hostingGate} from '../src/hosting.js';

function fetch(url,{method='GET',headers={}}={}){
  return new Promise((resolve,reject)=>{const req=request(url,{method,headers},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>res.headers[name]},json:async()=>JSON.parse(body)}));
  });req.on('error',reject);req.end();});
}

test('remote hosting fails closed without strong credentials and HTTPS origin',()=>{
  assert.equal(hostingConfig({}).remote,false);
  assert.throws(()=>hostingConfig({HOST:'0.0.0.0'}));
  assert.throws(()=>hostingConfig({HOST:'0.0.0.0',PUBLIC_ORIGIN:'https://demo.example',ACCESS_PASSWORD:'short'}));
  assert.throws(()=>hostingConfig({HOST:'0.0.0.0',PUBLIC_ORIGIN:'http://demo.example',ACCESS_PASSWORD:'x'.repeat(32)}));
});

test('remote gate protects pages and APIs, validates origin, and exposes only health unauthenticated',async t=>{
  const password='fixture-password-that-is-long-enough';
  const config=hostingConfig({HOST:'0.0.0.0',PUBLIC_ORIGIN:'https://demo.example',ACCESS_PASSWORD:password});
  const app=express();app.use(hostingGate(config));app.use((_req,res)=>res.json({private:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={host:'demo.example','x-forwarded-proto':'https'};
  const auth='Basic '+Buffer.from('admin:'+password).toString('base64');
  assert.deepEqual(await(await fetch(base+'/healthz')).json(),{ok:true});
  for(const path of ['/','/api/jobs','/api/evaluations/example']){
    const r=await fetch(base+path,{headers});assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/^Basic /);
  }
  assert.equal((await fetch(base,{headers:{...headers,authorization:'Basic '+Buffer.from('admin:wrong').toString('base64')}})).status,401);
  assert.equal((await fetch(base,{headers:{...headers,authorization:auth,host:'evil.example'}})).status,403);
  assert.equal((await fetch(base,{headers:{...headers,authorization:auth,'x-forwarded-proto':'http'}})).status,400);
  assert.equal((await fetch(base,{method:'POST',headers:{...headers,authorization:auth,origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base,{method:'POST',headers:{...headers,authorization:auth,origin:'https://demo.example'}})).status,200);
});
