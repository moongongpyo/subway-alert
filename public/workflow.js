export const workflowSteps=['링크 선택','체험 준비','입력·실행','실행 결과','다음 실험','비교 리포트'];

// Navigation never executes work. A new draft deliberately starts a new input step.
export class Workflow {
  constructor(){this.reset();}
  reset(){this.jobId=null;this.active=1;this.view=1;this.runId=null;this.loaded=false;}
  sync(job,runs){
    if(this.jobId!==job.id){this.reset();this.jobId=job.id;}
    const reviewing=this.reviewing;
    if(job.state==='READY'&&this.active===1){this.active=2;if(!reviewing)this.view=2;}
    if(runs){
      const run=runs.filter(r=>r.jobId===job.id).at(-1);
      if(run&&run.id!==this.runId){this.runId=run.id;this.active=3;if(!reviewing)this.view=3;}
      this.loaded=true;
    }
  }
  get reviewing(){return this.view<this.active;}
  visit(step){if(Number.isInteger(step)&&step>=0&&step<=this.active)this.view=step;}
  advance(step){if(step===this.active+1&&step<=5){this.active=step;this.view=step;}}
  resume(){this.view=this.active;}
  draft(){this.active=2;this.view=2;}
}
