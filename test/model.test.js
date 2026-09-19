import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {Models} from '../src/model.js';
import {Classification} from '../src/contracts.js';
import {responseSample} from '../src/analyze.js';
import {ImageDocumentation} from '../src/contracts.js';

test('image requests use the same metered payload for counting and generation',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-image-')),s=new Store(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  const j=s.create('local','https://example.com','image-request'),model=new Models(s,'test-key');let counted,generated;
  model.client={responses:{inputTokens:{count:async body=>{counted=body;return {input_tokens:1500};}},create:async body=>{generated=body;return {status:'completed',output_text:JSON.stringify({text:'visible evidence',uncertainties:[]}),usage:{input_tokens:1500,output_tokens:20}};}}};
  await model.ask(j.id,'A','Read image',{},ImageDocumentation,{images:['data:image/png;base64,aGVsbG8=']});
  assert.deepEqual(counted.input,generated.input);assert.equal(counted.input[0].content[1].type,'input_image');assert.equal(s.usage(j.id).input,1500);assert.equal(s.usage(j.id).calls,1);
  await assert.rejects(model.ask(j.id,'A','Read image',{},ImageDocumentation,{images:['file:///private/image.png']}),{code:'INVALID_IMAGE'});assert.equal(s.usage(j.id).calls,1);
});
test('provider transport retry consumes a new reservation and keeps ambiguous spend',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pg-model-')),s=new Store(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});const j=s.create('local','https://example.com','model-request');const model=new Models(s,'test-key');let calls=0;
  model.client={responses:{inputTokens:{count:async()=>({input_tokens:100})},create:async()=>{if(!calls++){const e=new Error('temporary');e.status=503;throw e;}return {status:'completed',output_text:JSON.stringify({kind:'api',reason:'',summary:'확인'}),usage:{input_tokens:100,output_tokens:100}};}}};
  const result=await model.ask(j.id,'A','Classify',{},Classification,{small:true});assert.equal(result.kind,'api');assert.equal(s.usage(j.id).calls,2);assert.ok(s.usage(j.id).reserved>0);
});
test('large actual response is sampled deterministically without losing false or zero',()=>{const source={zero:0,flag:false,nullable:null,list:Array.from({length:10000},(_,n)=>({name:'n'+n,n,details:{more:'x'.repeat(5000)}}))};const result=responseSample(source);assert.equal(result.zero,0);assert.equal(result.flag,false);assert.equal(result.nullable,null);assert.equal(result.list.length,2);assert.ok(JSON.stringify(result).length<8500);});
