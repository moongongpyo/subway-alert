import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'pg-names-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir};}
const finish=(s,j)=>s.update(j.id,x=>{x.state='FAILED';x.activeSince=null;});

test('service names and repeat numbers survive custom names, dismissal and restart without model use',t=>{
  const {store:s,dir}=fixture(t),first=s.create('local','https://pokeapi.co/api/v2/pokemon/pikachu','name-first');finish(s,first);
  const second=s.create('local','https://pokeapi.co/api/v2/pokemon/eevee','name-second');finish(s,second);
  assert.equal(s.get(first.id).projectName,'PokéAPI');assert.equal(s.get(second.id).projectName,'PokéAPI (2)');
  const before=s.get(second.id);s.renameProject(second.id,'local','포켓몬 비교');s.update(second.id,j=>{j.source={pages:[{title:'Other analysis title'}]};});
  const renamed=s.get(second.id);assert.equal(renamed.projectName,'포켓몬 비교');assert.equal(renamed.autoProjectName,'PokéAPI (2)');assert.equal(renamed.url,before.url);assert.deepEqual(renamed.steps,before.steps);assert.equal(renamed.state,before.state);assert.equal(s.usage(second.id).calls,0);
  s.dismiss(second.id,'local');s.dismiss(second.id,'local',false);assert.equal(s.get(second.id).projectName,'포켓몬 비교');
  const reopened=new Store(dir);try{assert.equal(reopened.get(second.id).projectName,'포켓몬 비교');const third=reopened.create('local',first.url,'name-third');assert.equal(third.projectName,'PokéAPI (3)');assert.equal(reopened.create('local',first.url,'name-third').projectName,'PokéAPI (3)');}finally{reopened.close();}
});

test('repositories and selected products are identified independently of their shared host',t=>{
  const {store:s}=fixture(t);const first=s.create('local','https://github.com/pallets/flask','repo-flask');finish(s,first);
  const second=s.create('local','https://github.com/sindresorhus/slugify','repo-slugify');finish(s,second);
  assert.equal(first.projectName,'Flask');assert.equal(second.projectName,'slugify');
  const tmap=s.create('local','https://transit.tmapmobility.com/guide','tmap-direct');finish(s,tmap);
  const catalog=s.create('local','https://openapi.sk.com/products/detail?svcSeq=60&menuSeq=125','tmap-catalog');
  s.renameProject(catalog.id,'local','내 출퇴근 비교');
  s.update(catalog.id,j=>{j.selectedSourceURL='https://openapi.sk.com/products/detail?linkMenuSeq=394';j.selectedSources=[{title:'TMAP 대중교통'}];});
  assert.equal(s.get(catalog.id).autoProjectName,'TMAP 대중교통 (2)');assert.equal(s.get(catalog.id).projectName,'내 출퇴근 비교');
});

test('legacy histories receive chronological names without modifying execution records',t=>{
  const {store:s,dir}=fixture(t),jobs=[];
  for(let n=0;n<2;n++){const j=s.create('local','https://example.com','legacy-'+n);finish(s,j);jobs.push(s.get(j.id));}
  for(const j of jobs){for(const key of ['projectName','autoProjectName','serviceKey','serviceName','serviceNumber'])delete j[key];s.db.prepare('UPDATE jobs SET doc=? WHERE id=?').run(JSON.stringify(j),j.id);}
  const reopened=new Store(dir);try{assert.equal(reopened.get(jobs[0].id).projectName,'Example');assert.equal(reopened.get(jobs[1].id).projectName,'Example (2)');assert.equal(reopened.get(jobs[1].id).createdAt,jobs[1].createdAt);assert.equal(reopened.get(jobs[1].id).state,'FAILED');}finally{reopened.close();}
});
