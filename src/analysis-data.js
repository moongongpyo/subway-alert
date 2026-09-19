import { isDeepStrictEqual } from 'node:util';
import { pointer } from './evaluation-contracts.js';

export const escapePath = key => String(key).replace(/~/g,'~0').replace(/\//g,'~1');
export const numeric = value => typeof value==='number' && Number.isFinite(value);
export const scalar = value => value!==undefined && (value===null || typeof value!=='object');
export const readField=(value,path)=>pointer(value,!path?'':path.startsWith('/')?path:path.startsWith('./')?path.slice(1):'/'+escapePath(path));

// Every value in a selected column is inspected. Limit the number of profiled
// columns, not their rows; report omissions instead of calling a sample complete.
export function columnProfile(values) {
  const numbers=values.filter(numeric),sorted=[...numbers].sort((a,b)=>a-b);
  const missing=values.filter(v=>v===null||v===undefined).length;
  const result={count:values.length,missing,numeric:numbers.length,nonnumeric:values.length-missing-numbers.length};
  if(numbers.length){
    const sum=numbers.reduce((a,b)=>a+b,0),quantile=p=>sorted[Math.floor((sorted.length-1)*p)];
    Object.assign(result,{min:sorted[0],max:sorted.at(-1),mean:sum/numbers.length,sum,p10:quantile(.1),median:quantile(.5),p90:quantile(.9),first:numbers[0],last:numbers.at(-1),change:numbers.at(-1)-numbers[0]});
  }
  if(!numbers.length){
    const counts=new Map();let truncated=false;
    for(const v of values){if(typeof v!=='string'&&typeof v!=='boolean')continue;const k=String(v);if(counts.has(k)||counts.size<2000)counts.set(k,(counts.get(k)||0)+1);else truncated=true;}
    if(counts.size)Object.assign(result,{categories:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([value,count])=>({value:value.slice(0,160),count,labelTruncated:value.length>160})),categoriesTruncated:truncated});
  }
  return result;
}

export function profileResponse(value) {
  const arrays=[],scalars=[],media=[];let omitted=false,visited=0;
  const visit=(v,path='',depth=0)=>{
    if(++visited>2000||depth>6){omitted=true;return;}
    if(v&&typeof v==='object'&&v.artifactId){if(media.length<8)media.push({path,name:v.name,mime:v.mime,expiresAt:v.expiresAt});return;}
    if(Array.isArray(v)){
      if(arrays.length>=16){omitted=true;return;}
      const row={path,count:v.length};
      if(v.every(x=>scalar(x)))Object.assign(row,columnProfile(v));
      else{
        const keys=new Set();for(const item of v)if(item&&typeof item==='object'&&!Array.isArray(item))for(const key of Object.keys(item)){if(keys.size<12)keys.add(key);else if(!keys.has(key))omitted=true;}
        row.fields=[...keys].filter(key=>v.some(x=>scalar(x?.[key])&&x?.[key]!==undefined)).map(key=>({path:'/'+escapePath(key),...columnProfile(v.map(x=>x?.[key]))}));
      }
      arrays.push(row);return;
    }
    if(v&&typeof v==='object'){for(const [key,child] of Object.entries(v))visit(child,path+'/'+escapePath(key),depth+1);}
    else if(scalars.length<24)scalars.push({path,value:typeof v==='string'?v.slice(0,160):v});else omitted=true;
  };
  visit(value);return {scope:'Statistics scan ALL rows of each selected column in the stored response. Not the remote dataset. Missing and nonnumeric values are not zero.',arrays,scalars,media,omittedStructure:omitted};
}

export function analysisContext({run,previous=null,goal,capability,assessment,feedback}) {
  const before=previous?.input||{},after=run.input||{};
  const changes=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>!isDeepStrictEqual(before[k],after[k])).slice(0,30).map(field=>({field,before:before[field],after:after[field]}));
  const differences=[];
  if(previous){
    if(previous.jobId!==run.jobId)differences.push('서로 다른 도구');
    if(previous.version!==run.version)differences.push('실행 버전 변경');
    if(previous.goalVersion!==run.goalVersion)differences.push('목적·기대 조건 변경');
    if(!isDeepStrictEqual(previous.environment,run.environment))differences.push('실행 환경 변경');
    if(changes.length)differences.push('입력·옵션 변경');
    if(previous.state!=='succeeded'||run.state!=='succeeded')differences.push('성공이 확인되지 않은 실행 포함');
  }
  const purpose=goal?.purpose||'',check=run.check==='사용자 기대 조건 확인'?'':run.check;
  const question=check||purpose||`${capability||'이 기능'}의 실제 응답에서 무엇을 확인할 수 있나요?`;
  return {
    question,purpose:purpose||null,questionBasis:check?'선택한 실험':purpose?'사용자 목적':'기능과 실제 입력',
    expectations:goal?.conditions||[],assessment:assessment||{status:'unknown',conditions:[]},feedback:feedback||null,
    current:{id:run.id,state:run.state,status:run.status,error:run.error,durationMs:run.durationMs,profile:profileResponse(run.output)},
    previous:previous?{id:previous.id,state:previous.state,profile:profileResponse(previous.output)}:null,
    comparison:{available:!!previous,differences,changes,arithmeticAllowed:!!previous&&previous.jobId===run.jobId&&previous.version===run.version&&previous.state==='succeeded'&&run.state==='succeeded',note:previous?'차이는 관측값이며 조건 변경의 인과 효과나 품질 우열을 증명하지 않습니다.':'이전 실행이 없어 변화량을 판단할 수 없습니다.'}
  };
}

export function sourceValue(sources,source,path) {return Object.hasOwn(sources,source)&&typeof path==='string'?pointer(sources[source],path):undefined;}
export function measure(evidence,sources) {
  const value=sourceValue(sources,evidence.source,evidence.path);
  if(evidence.stat==='value')return scalar(value)?value:undefined;
  if(!Array.isArray(value))return undefined;
  if(evidence.stat==='count')return value.length;
  const numbers=value.map(v=>evidence.field?readField(v,evidence.field):v).filter(numeric);
  if(!numbers.length)return undefined;
  if(evidence.stat==='sum')return numbers.reduce((a,b)=>a+b,0);
  if(evidence.stat==='mean')return numbers.reduce((a,b)=>a+b,0)/numbers.length;
  if(evidence.stat==='min')return numbers.reduce((a,b)=>Math.min(a,b));
  if(evidence.stat==='max')return numbers.reduce((a,b)=>Math.max(a,b));
  return undefined;
}
