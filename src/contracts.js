import { z } from 'zod';
import { validateURL } from './network.js';
import { fail } from './config.js';
import { observedAuthURL } from './api-access.js';
import { observedApiOrigin } from './api-evidence.js';
export const Field = z.object({ name:z.string(), label:z.string(), type:z.enum(['text','number','boolean','json','file']), required:z.boolean(), location:z.enum(['query','path','body','argument']), example:z.string(), description:z.string() });
export const Auth = z.object({ kind:z.enum(['none','bearer','header','query','path','env']), name:z.string(), label:z.string(), issueUrl:z.string(), docsUrl:z.string(), instructions:z.string() });
export const Plan = z.object({
  kind:z.enum(['api','github']), supported:z.boolean(), reason:z.string(), title:z.string(), description:z.string(), capability:z.string(),
  evidence:z.string(), runtime:z.enum(['node','python','none']), hasUI:z.boolean(), port:z.number().int(),
  install:z.array(z.string()).max(6), start:z.string(), files:z.array(z.object({path:z.string(),content:z.string()})).max(6),
  database:z.object({kind:z.enum(['none','sqlite','postgres']), migrate:z.array(z.string()).max(4), seed:z.array(z.string()).max(3), check:z.string()}),
  auth:Auth, fields:z.array(Field).max(16),
  endpoint:z.object({url:z.string(),method:z.enum(['GET','POST']),readOnly:z.boolean(),cost:z.enum(['free','paid','unknown']),costEvidence:z.string()}),
  adapter:z.string(), healthPath:z.string(), expected:z.string(),
});
export const Viewer = z.object({ fields:z.array(z.object({path:z.string(),label:z.string(),unit:z.string(),evidence:z.string()})).max(20), description:z.string() });
export const Checks = z.object({ paths:z.array(z.string()).max(12), allowEmpty:z.boolean(), description:z.string() });
export const BrowserActions = z.object({ actions:z.array(z.object({type:z.enum(['fill','click','select','check','expectText','expectVisible']),selector:z.string(),value:z.string()})).max(15), scenario:z.string() });
export const Classification = z.object({kind:z.enum(['api','github','unsupported']),reason:z.string(),summary:z.string()});
export const DocumentationAssessment = z.object({kind:z.enum(['api','selection','insufficient','unsupported']),reason:z.string(),choiceIds:z.array(z.string()).max(24)});
export const ImageDocumentation = z.object({text:z.string(),uncertainties:z.array(z.string()).max(6)});
function planURL(value,label){try{return validateURL(value);}catch(e){fail('INVALID_PLAN',`${label}이 비어 있거나 올바르지 않습니다. 확인한 문서의 실제 URL을 사용해주세요. ${e.message}`);}}
export function validatePlan(p, source) {
  if(!p.supported) fail('UNSUPPORTED',p.reason||'이 프로젝트는 현재 지원하지 않습니다.');
  if(p.kind!==source.kind) fail('INVALID_PLAN','분석 결과의 입력 유형이 원본과 다릅니다.');
  if(p.kind==='api') {
    let u=planURL(p.endpoint.url,'API 호출 URL');
    if(!p.endpoint.readOnly) fail('UNSUPPORTED','상태를 변경하는 API는 자동 검증 대상에서 제외합니다.');
    if(p.hasUI||p.database.kind!=='none'||p.auth.kind==='env') fail('INVALID_PLAN','API 실행 계약이 맞지 않습니다.');
    if(p.files.length||p.install.length||p.start||p.adapter||p.runtime!=='none')fail('INVALID_PLAN','API 체험은 검증된 공통 실행기만 사용하며 임의 코드를 설치하거나 실행하지 않습니다.');
    if(source.direct){
      const observed=planURL(source.url,'직접 입력한 API URL');
      if(u.origin!==observed.origin||u.pathname!==observed.pathname||p.endpoint.method!=='GET')fail('INVALID_PLAN','직접 확인한 GET API 대상과 분석 주소·메서드가 다릅니다.');
      // The collector already observed this exact GET URL. Preserve its actual
      // query, rather than asking a model to reproduce encoding/order/defaults.
      p.endpoint.url=observed.href;u=observed;
    }
    if(!source.direct && !observedApiOrigin(u.href,source)) fail('INVALID_PLAN',`수집된 문서 본문·호출 링크·API 명세에서 ${u.origin}의 근거를 찾지 못했습니다. 실제로 확인된 호출 주소를 사용해주세요.`);
    // Observed query values are editable examples, not invisible locked inputs.
    for(const [name,value] of u.searchParams){
      if(name===p.auth.name||/key|token|secret|password|signature|credential/i.test(name)||u.searchParams.getAll(name).length!==1||!/^[a-zA-Z_][\w.-]{0,63}$/.test(name)||['__proto__','constructor','prototype'].includes(name))continue;
      const field=p.fields.find(f=>f.name===name);
      if(field){if(source.direct){field.location='query';field.example=value;}continue;}
      if(p.fields.length>=16)break;
      p.fields.push({name,label:name,type:'text',required:false,location:'query',example:value,description:`요청 URL의 ${name} 쿼리 매개변수. 원래 입력: ${value.slice(0,120)}`});
    }
  } else {
    if(p.runtime==='none'||!p.install.length && !p.start && !p.adapter) fail('UNSUPPORTED','체험할 실행 절차를 확인하지 못했습니다.');
    if(p.port<1024||p.port>65535||[22222,2280,33333,8088].includes(p.port)) fail('INVALID_PLAN','지원하지 않는 앱 포트입니다.');
    if(p.auth.kind!=='none'&&p.auth.kind!=='env') fail('UNSUPPORTED','이 저장소는 환경변수 인증만 지원합니다.');
    if(p.auth.kind==='env'&&!/^[A-Z][A-Z0-9_]{1,79}$/.test(p.auth.name)) fail('INVALID_PLAN','환경변수 이름이 올바르지 않습니다.');
    if(!p.hasUI&&!p.adapter) fail('INVALID_PLAN','UI 없는 프로젝트에는 JSON 어댑터가 필요합니다.');
  }
  const names=new Set();
  for(const f of p.fields) {
    if(!/^[a-zA-Z_][\w.-]{0,63}$/.test(f.name)||['__proto__','constructor','prototype'].includes(f.name)||names.has(f.name)) fail('INVALID_PLAN','입력 필드 이름이 올바르지 않습니다.'); names.add(f.name);
  }
  for(const f of p.files) if(!/^[\w./-]+$/.test(f.path)||f.path.startsWith('/')||f.path.split('/').includes('..')||f.path.startsWith('.git/')) fail('INVALID_PLAN','생성 파일 경로가 작업 디렉터리 밖입니다.');
  if(p.auth.kind!=='none') {
    if(p.auth.kind==='path'){
      const placeholder=`{${p.auth.name}}`,u=new URL(p.endpoint.url);
      if(!/^[a-zA-Z_][\w.-]{0,63}$/.test(p.auth.name)||p.fields.some(f=>f.name===p.auth.name)||u.pathname.split('/').filter(s=>s===encodeURIComponent(placeholder)).length!==1||(p.endpoint.url.split(placeholder).length-1)!==1)fail('INVALID_PLAN','경로 인증키는 일반 입력과 분리한 하나의 {키이름} 경로 구간이어야 합니다.');
    }
    if(['host','cookie','connection','content-length','x-control-token'].includes(p.auth.name.toLowerCase()))fail('INVALID_PLAN','허용되지 않은 인증 헤더입니다.');
    planURL(p.auth.issueUrl,'공식 키 발급 안내 URL');planURL(p.auth.docsUrl,'인증 문서 URL');
    if(!observedAuthURL(p.auth.issueUrl,source,null)||!observedAuthURL(p.auth.docsUrl,source,null))fail('INVALID_PLAN','공식 키 발급·인증 안내의 정확한 URL 근거를 확인하지 못했습니다. 수집된 실제 링크 또는 문서 URL을 사용해주세요.');
  }
  if(p.hasUI&&(!p.healthPath.startsWith('/')||p.healthPath.startsWith('//')||p.healthPath.includes('\\')))fail('INVALID_PLAN','앱 상태 경로는 같은 서버의 상대 경로여야 합니다.');
  return p;
}
export function stepsFor(p) {
  const steps=[['analysis','URL 분석','A'],['environment',p.kind==='api'?'API 호출 준비':'환경 준비','F']];
  if(p.auth.kind!=='none') steps.push(['credentials','인증 연결','C']);
  if(p.database.kind!=='none') steps.push(['database','DB 준비','F']);
  if(!p.hasUI) steps.push(['interface','화면 구성','D']);
  steps.push(['execution','실행','A'],['function','기능 확인','B'],['browser','화면 확인','E'],['ready','체험 준비 완료','']);
  return steps.map(([id,label,role])=>({id,label,role,status:id==='analysis'?'completed':'pending',evidence:id==='analysis'?'실행 계획 검증 완료':null}));
}
export function validateInput(fields, input) {
  const out={};
  for(const f of fields) {
    const val=input[f.name];
    if(val===undefined||val==='') { if(f.required) throw new Error(`${f.label} 값을 입력해주세요.`); if(val!==undefined) out[f.name]=val; continue; }
    if(f.type==='number') {const n=Number(val);if(!Number.isFinite(n))throw new Error(`${f.label}: 숫자가 필요합니다.`);out[f.name]=n;}
    else if(f.type==='boolean') {if(![true,false,'true','false'].includes(val))throw new Error(`${f.label}: true/false가 필요합니다.`);out[f.name]=val===true||val==='true';}
    else if(f.type==='json') out[f.name]=typeof val==='string'?JSON.parse(val):val;
    else if(f.type==='file') {if(!val||typeof val.base64!=='string'||val.base64.length>1_400_000)throw new Error('파일은 1MB 이하로 업로드해주세요.');out[f.name]={name:String(val.name).replace(/[^\w.가-힣-]/g,'_'),base64:val.base64,...(val.mime?{mime:String(val.mime).slice(0,100)}:{})};}
    else out[f.name]=String(val).slice(0,20_000);
  }
  return out;
}
