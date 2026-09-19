import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {safeRequest,isNetworkError,probeConnection} from '../src/network.js';

test('HTTP socket timeout retains a network code instead of triggering code repair',async t=>{
  t.mock.method(dns,'lookup',async()=>[{address:'115.84.165.45',family:4}]);
  t.mock.method(http,'request',()=>{
    const req=new EventEmitter();let onTimeout;
    req.setTimeout=(_ms,fn)=>{onTimeout=fn;};req.end=()=>queueMicrotask(onTimeout);req.destroy=e=>req.emit('error',e);return req;
  });
  await assert.rejects(safeRequest('http://openapi.seoul.go.kr:8088/sample/json/Example/1/5'),e=>e.code==='ETIMEDOUT'&&isNetworkError(e));
  assert.equal(isNetworkError(new Error('invalid JSON')),false);assert.equal(isNetworkError({code:'EAI_AGAIN'}),true);
});

test('connection probe pins public DNS and checks only the origin port without sending credentials',async t=>{
  const targets=[];t.mock.method(dns,'lookup',async()=>[{address:'115.84.165.45',family:4}]);
  t.mock.method(net,'createConnection',options=>{targets.push(options);const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit('connect'));return socket;});
  const result=await probeConnection('http://openapi.seoul.go.kr:8088/private-path?key=never-sent');
  assert.equal(result.reachable,true);assert.equal(result.origin,'http://openapi.seoul.go.kr:8088');assert.equal(targets[0].host,'115.84.165.45');assert.equal(targets[0].port,8088);assert.ok(!JSON.stringify(targets).includes('never-sent'));
  t.mock.method(dns,'lookup',async()=>[{address:'127.0.0.1',family:4}]);
  await assert.rejects(probeConnection('https://api.example.com'),/내부망/);assert.equal(targets.length,1);
});

test('HTTPS preflight verifies TLS hostname before packages or API requests, not just TCP',async t=>{
  t.mock.method(dns,'lookup',async()=>[{address:'1.1.1.1',family:4}]);
  t.mock.method(net,'createConnection',()=>assert.fail('HTTPS needs TLS verification'));
  const targets=[];
  t.mock.method(tls,'connect',options=>{targets.push(options);const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>socket.emit('secureConnect'));return socket;});
  const result=await probeConnection('https://api.example.com/private?api_key=never-sent');
  assert.equal(result.stage,'tls');assert.equal(targets[0].host,'1.1.1.1');assert.equal(targets[0].servername,'api.example.com');assert.equal(targets[0].rejectUnauthorized,true);assert.ok(!JSON.stringify(targets).includes('never-sent'));
  t.mock.method(tls,'connect',()=>{const socket=new EventEmitter();socket.destroy=()=>{};queueMicrotask(()=>{socket.emit('connect');socket.emit('error',Object.assign(new Error('blocked TLS'),{code:'ECONNRESET'}));});return socket;});
  await assert.rejects(probeConnection('https://api.example.com'),{code:'ECONNRESET'});
});
