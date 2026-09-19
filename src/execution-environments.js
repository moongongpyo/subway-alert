import { Sandboxes } from './daytona.js';
import { DirectApi } from './direct-api.js';

// Keep existing sandbox sessions on their original runtime and budget ledger.
// New API jobs never allocate a Daytona environment.
export class ExecutionEnvironments {
  constructor(store,{sandbox=new Sandboxes(store),api=new DirectApi(store)}={}){this.store=store;this.sandbox=sandbox;this.api=api;}
  forJob(id){const j=this.store.get(id);return j.executionMode==='node-api'||!j.sandboxId&&!j.sandboxName&&j.plan?.kind!=='github'?this.api:this.sandbox;}
}
for(const method of ['create','boot','credentials','invoke','browser','verifyPreview','ready','cleanup']){
  ExecutionEnvironments.prototype[method]=function(id,...args){return this.forJob(id)[method](id,...args);};
}
