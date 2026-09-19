import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
const short=z.string().max(1200);
export const GoalInput=z.object({purpose:z.string().trim().min(3).max(2000),constraints:z.string().max(2000).default(''),conditions:z.array(z.object({label:z.string().min(1).max(300),required:z.boolean().default(true),kind:z.enum(['subjective','exists','equals','contains']).default('subjective'),pointer:z.string().max(250).default(''),expectedJson:z.string().max(1000).default('null')})).max(12),version:z.number().int().min(0)});
export const FeedbackInput=z.object({satisfaction:z.enum(['satisfied','partial','unsatisfied','unsure']),note:z.string().max(2000),conditions:z.array(z.object({id:z.string(),status:z.enum(['met','partial','unmet','unknown']),note:z.string().max(500)})).max(12),version:z.number().int().min(0)});
export const ExperimentAnalysis=z.object({summary:short,questions:z.array(short).max(3),assessments:z.array(z.object({conditionId:z.string(),runId:z.string(),interpretation:short})).max(12),cards:z.array(z.object({kind:z.enum(['improve','coverage']),title:z.string().max(100),reason:short,check:short,changes:z.array(z.object({field:z.string(),valueJson:z.string().max(3000),evidence:short})).max(8),requiresInput:z.array(z.string()).max(8)})).max(3)});
const source=z.enum(['current','input','previous','previousInput']);
const path=z.string().max(300);
export const ViewDesign=z.object({
  question:z.string().min(3).max(400),rationale:z.string().min(3).max(600),
  focus:z.enum(['trend','candidates','media','comparison','overview']),
  evidence:z.array(z.object({label:z.string().min(1).max(120),source,path,stat:z.enum(['value','count','sum','mean','min','max']),field:path,unitPath:path})).min(1).max(6),
  blocks:z.array(z.object({type:z.enum(['series','table','media','comparison']),title:z.string().min(1).max(120),reason:z.string().min(3).max(300),source,path,x:path,columns:z.array(z.object({path,label:z.string().min(1).max(100),unitPath:path})).max(6),comparePath:path})).max(4),
  unknowns:z.array(z.string().min(3).max(500)).min(1).max(5)
});
export const ExperienceAnalysis=ExperimentAnalysis.extend({view:ViewDesign,html:z.string().max(40_000),css:z.string().max(16_000),cards:z.array(ExperimentAnalysis.shape.cards.element.extend({asset:z.object({field:z.string(),prompt:z.string().min(20).max(1200),description:z.string().max(300)}).nullable()})).min(1).max(3)});
export const NextExperiments=ExperienceAnalysis.pick({summary:true,cards:true});
export const PrefetchedExperiments=ExperienceAnalysis.pick({summary:true,questions:true,cards:true});
export function pointer(value,path){if(path==='')return value;if(!path.startsWith('/'))return undefined;return path.split('/').slice(1).reduce((v,k)=>v!=null&&Object.hasOwn(v,k.replace(/~1/g,'/').replace(/~0/g,'~'))?v[k.replace(/~1/g,'/').replace(/~0/g,'~')]:undefined,value);}
export function assess(goal,run,feedback) {
  const conditions=(goal?.conditions||[]).map(c=>{
    if(c.kind==='subjective'){const f=feedback?.conditions.find(x=>x.id===c.id);return {id:c.id,label:c.label,required:c.required,status:f?.status||'unknown',source:f?'user':'unassessed',reason:f?.note||'사용자 판단이 필요합니다.'};}
    if(run.state!=='succeeded')return {id:c.id,label:c.label,required:c.required,status:'unknown',source:'unassessed',reason:'성공한 실행 결과가 없습니다.'};
    const measured=run.deterministicChecks?.find(x=>x.id===c.id);if(measured)return measured;
    const value=pointer(run.output,c.pointer);let met=false;
    if(c.kind==='exists')met=value!==undefined;
    if(c.kind==='equals')met=isDeepStrictEqual(value,JSON.parse(c.expectedJson));
    if(c.kind==='contains')met=typeof value==='string'&&value.includes(JSON.parse(c.expectedJson));
    return {id:c.id,label:c.label,required:c.required,status:met?'met':'unmet',source:run.provenance==='manual'?'user-output-check':'deterministic',reason:`${c.kind} · ${c.pointer||'(root)'}`};
  });
  const required=conditions.filter(c=>c.required),status=!required.length||required.some(c=>c.status==='unknown')?'unknown':required.every(c=>c.status==='met')?'met':required.some(c=>c.status==='met'||c.status==='partial')?'partial':'unmet';
  return {status,conditions};
}
