import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderDocumentation} from '../src/docs-browser.js';

test('real Chromium reads JS, frames and tabs while blocking writes and private destinations',async()=>{
  const calls=[],url='https://docs.example.com/';
  const request=async(address,options)=>{
    calls.push({address,options});assert.equal(options.method,'GET');assert.ok(!address.includes('127.0.0.1'));
    const html=address===url?`<main id="content">Loading</main><button role="tab" onclick="document.querySelector('#content').textContent='GET https://api.example.com/items'">Request</button>
      <iframe src="/frame"></iframe><script>document.querySelector('#content').textContent='Client rendered documentation';fetch('/write',{method:'POST'}).catch(()=>{});fetch('http://127.0.0.1/private').catch(()=>{});</script>`:'<p>Header: appKey required</p>';
    return {url:address,status:200,headers:{'content-type':'text/html'},body:Buffer.from(html)};
  };
  const result=await renderDocumentation(url,{request});
  const text=result.documents.map(d=>d.html).join('\n');assert.match(text,/Client rendered documentation/);assert.match(text,/Header: appKey/);assert.match(text,/GET https:\/\/api.example.com\/items/);
  assert.ok(result.documents.some(d=>d.label==='탭: Request'));assert.ok(result.warnings.some(w=>w.includes('쓰기 요청')));assert.ok(calls.every(c=>!c.address.includes('/write')));assert.equal(result.requests,calls.length);
});
