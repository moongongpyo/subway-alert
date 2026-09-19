// Presentation metadata only: never part of an executable plan or its version.
const knownServices={
  'pokeapi.co':'PokéAPI','api.github.com':'GitHub API','jsonplaceholder.typicode.com':'JSONPlaceholder',
  'api.open-meteo.com':'Open-Meteo','open-meteo.com':'Open-Meteo','api.frankfurter.dev':'Frankfurter','frankfurter.dev':'Frankfurter','dog.ceo':'Dog API','catfact.ninja':'Cat Facts',
  'transit.tmapmobility.com':'TMAP 대중교통','openapi.sk.com':'SK open API',
};
const tidy=value=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,70):'';
const generic=/^(?:home|welcome|guide|docs?|documentation|reference|api|api reference|api documentation|overview|swagger ui|redoc|가이드|문서|개발자 문서|시작하기|직접 API 응답)$/i;
function documentName(title){
  const parts=tidy(title).split(/\s*[|｜]\s*|\s+[—–]\s+/).filter(p=>p&&!generic.test(p));
  return parts.find(p=>!/^https?:|\.(?:com|org|net|io)(?:\/|$)/i.test(p))||'';
}
export function serviceIdentity(job){
  const url=new URL(job.selectedSourceURL||job.url),selected=tidy(job.selectedSources?.at(-1)?.title);
  if(url.hostname==='github.com'){
    const [owner,repo]=url.pathname.split('/').filter(Boolean);if(owner&&repo){const name=repo.replace(/\.git$/i,'');return {key:`github:${owner.toLowerCase()}/${name.toLowerCase()}`,name:name==='flask'?'Flask':name};}
  }
  const observed=tidy(job.source?.serviceName)||documentName(job.source?.pages?.[0]?.title);
  const name=selected||knownServices[url.hostname]||observed;
  if(name)return {key:'api:'+name.normalize('NFKC').toLowerCase().replace(/\s+api$/i,'').replace(/\s+/g,''),name};
  const host=url.hostname.replace(/^(?:www|api|docs|developer)\./,'').split('.')[0];
  return {key:'site:'+url.hostname,name:tidy(job.plan?.title)||host.charAt(0).toUpperCase()+host.slice(1)};
}
