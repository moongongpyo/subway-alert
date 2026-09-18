const assert=require('node:assert/strict');
const vm=require('node:vm');const fs=require('node:fs');
async function scenario(status,changed=false){
 const nodes=new Map();const node=()=>({value:'',textContent:'',disabled:false,hidden:false,style:{},children:[],append(...x){this.children.push(...x);if(this.value===''&&x[0]?.value!==undefined)this.value=String(x[0].value);},replaceChildren(){this.children=[];this.value='';}});
 const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
 const leg={id:'old-leg',mode:'BUS',route:'10',routeId:'bus-10',start:'A',end:'C',stops:[{id:'1',name:'A'},{id:'2',name:'B'},{id:'3',name:'C'}]};
 const fresh={...leg,id:'new-leg',route:changed?'20':'10'};let routeCalls=0,saveCalls=0,saved;
 const context={console,Date,Intl,JSON,Number,Error,Set,setInterval(){},sessionStorage:{setItem(){}},location:{},document:{querySelector:get,createElement:node},PlacePicker:class{get(){return {name:'test',lon:127,lat:37};}},fetch:async(path,opts)=>{
  let body={};let code=200;
  if(path==='/api/routes'){routeCalls++;body={id:routeCalls===1?'old-session':'new-session',plan:{journeys:[{legs:[routeCalls===1?leg:fresh]}]}};}
  else if(path==='/api/mock-disruptions'&&opts.method==='POST'){saveCalls++;if(saveCalls===1){code=status;body={message:'old search missing'};}else{saved=JSON.parse(opts.body);body={id:'event'};}}
  else if(path==='/api/mock-disruptions')body=[];
  else body={configured:true,items:[],total:0};
  return {ok:code===200,status:code,json:async()=>body};
 }};
 vm.createContext(context);vm.runInContext(fs.readFileSync('src/main/resources/static/mock.js','utf8'),context);
 get('#mock-minutes').value='30';await get('#mock-search').onsubmit({preventDefault(){}});
 get('#mock-leg').value='0';get('#mock-start-stop').value='1';get('#mock-end-stop').value='2';
 // Stale displayed time must not invalidate the default immediate-start action.
 get('#mock-start').value='2020-01-01T12:00';
 await get('#event-form').onsubmit({preventDefault(){}});
 assert.equal(get('#mock-save').disabled,false);
 if(changed){assert.equal(saveCalls,1);assert.match(get('#event-status').textContent,/같은 구간/);}
 else if([404,410].includes(status)){assert.equal(routeCalls,2);assert.equal(saveCalls,2);assert.equal(saved.sessionId,'new-session');assert.equal(saved.legId,'new-leg');assert.equal(saved.startIndex,1);assert.equal(saved.endIndex,2);assert.ok(Math.abs(Date.parse(saved.startsAt)-Date.now())<5000);assert.match(get('#event-status').textContent,/등록했습니다/);}
 else{assert.equal(saveCalls,1);assert.equal(routeCalls,1);assert.match(get('#event-status').textContent,/old search missing/);}
}
(async()=>{await scenario(404);await scenario(410);await scenario(404,true);await scenario(500);console.log('PASS mock reservation: restart/expiry recovery, exact-segment guard, immediate start, no unsafe retries');})().catch(e=>{console.error(e);process.exitCode=1;});
