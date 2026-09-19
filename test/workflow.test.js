import test from 'node:test';
import assert from 'node:assert/strict';
import {Workflow} from '../public/workflow.js';
const job={id:'one',state:'READY'},run={id:'run-one',jobId:'one'};
test('execution locks earlier input and navigation cannot unlock it',()=>{const flow=new Workflow();flow.sync(job,[]);assert.equal(flow.view,2);flow.sync(job,[run]);assert.equal(flow.view,3);flow.visit(2);assert.equal(flow.reviewing,true);flow.visit(5);assert.equal(flow.view,2);flow.resume();assert.equal(flow.view,3);flow.draft();flow.sync(job,[run]);assert.equal(flow.view,2);assert.equal(flow.reviewing,false);});
test('background completion never pulls the user out of a previous record',()=>{const flow=new Workflow();flow.sync({...job,state:'PREPARING'},[]);flow.visit(0);flow.sync(job,[]);assert.equal(flow.view,0);assert.equal(flow.active,2);flow.sync(job,[run]);assert.equal(flow.view,0);assert.equal(flow.active,3);flow.resume();assert.equal(flow.view,3);});
test('job switches reset navigation; expiry keeps recorded results available',()=>{const flow=new Workflow();flow.sync(job,[run]);flow.advance(4);flow.advance(5);flow.sync({...job,state:'EXPIRED'},[run]);assert.equal(flow.view,5);flow.sync({id:'two',state:'PREPARING'},[]);assert.equal(flow.view,1);assert.equal(flow.runId,null);flow.visit(3);assert.equal(flow.view,1);});
