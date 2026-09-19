import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readInputs} from '../public/viewer.js';
import {assess} from '../src/evaluation-contracts.js';

test('empty numeric and optional boolean controls remain absent instead of becoming zero or false',async()=>{
  const fields=[{name:'empty',type:'number',required:true},{name:'optional',type:'boolean',required:false},{name:'zero',type:'number'},{name:'flag',type:'boolean'}];
  const values={empty:'',optional:'',zero:'0',flag:'false'};
  const input=await readInputs({elements:{namedItem:name=>({value:values[name]})}},fields);
  assert.deepEqual(input,{zero:0,flag:false});
});
test('JSON object equality is independent of key ordering while preserving array ordering',()=>{
  const goal={conditions:[{id:'one',kind:'equals',pointer:'',expectedJson:'{"b":2,"a":1}',required:true}]};
  assert.equal(assess(goal,{state:'succeeded',output:{a:1,b:2}}).status,'met');
  goal.conditions[0].expectedJson='[1,2]';assert.equal(assess(goal,{state:'succeeded',output:[2,1]}).status,'unmet');
});
