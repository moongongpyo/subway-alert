// Isolated browser test fixture, never mounted in the product server.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const contract={title:'개발용 뷰어 검증 · 샘플 데이터',capability:'실제 외부 API 결과가 아닌 UI 테스트 fixture입니다.',fields:[{name:'query',label:'검색어',type:'text',required:true,example:'Seoul',description:'이 입력을 결과에 그대로 반영합니다.'},{name:'count',label:'개수',type:'number',required:true,example:'0',description:'0을 그대로 유지해야 합니다.'},{name:'enabled',label:'활성',type:'boolean',required:true,example:'false',description:'false를 빈 값으로 바꾸지 않습니다.'}],viewer:{fields:[]}};
let calls=0;
http.createServer(async(req,res)=>{
  const json=v=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(v));};
  if(req.url==='/contract')return json(contract);
  if(req.url==='/invoke'){let body='';for await(const b of req)body+=b;const v=JSON.parse(body);calls++;if(v.query==='error'){res.statusCode=400;return json({error:'테스트용 API 실패'});}return json({status:200,mime:'application/json',data:{query:v.query,count:v.count,enabled:v.enabled,empty:'',nullable:null,items:[{name:'Seoul',temperature:0,active:false},{name:'Busan',temperature:12,active:true}],nested:{message:'<script>window.bad=true</script>',unicode:'한글',missingValue:null}}});}
  if(req.url==='/calls')return json({calls});
  const paths={'/':'playground.html','/playground.js':'playground.js','/viewer.js':'viewer.js','/style.css':'style.css'};
  if(!paths[req.url]){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':req.url.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(readFileSync(resolve('public',paths[req.url])));
}).listen(3002,'127.0.0.1',()=>console.log('Isolated UI fixture: http://127.0.0.1:3002'));
