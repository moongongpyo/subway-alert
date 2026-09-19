export const el=(tag,attrs={},...children)=>{const n=document.createElement(tag);for(const [k,v]of Object.entries(attrs)){if(k==='class')n.className=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else if(k==='text')n.textContent=v;else if(v!==undefined&&v!==null)n.setAttribute(k,String(v));}n.append(...children.flat().filter(v=>v!==undefined&&v!==null));return n;};
export const format=v=>v===null?'null':v===undefined?'필드 없음':v===''?'빈 문자열':typeof v==='object'?JSON.stringify(v):String(v);
export function pointer(value,path){if(path==='')return value;return path.split('/').slice(1).reduce((v,k)=>v!=null&&Object.hasOwn(v,k.replace(/~1/g,'/').replace(/~0/g,'~'))?v[k.replace(/~1/g,'/').replace(/~0/g,'~')]:undefined,value);}
const part=k=>String(k).replace(/~/g,'~0').replace(/\//g,'~1');
const activeURLs=new Set();
export function clearResources(){for(const u of activeURLs)URL.revokeObjectURL(u);activeURLs.clear();}
function scalar(key,value,path,mapping=[]){const m=mapping.find(f=>f.path===path);return el('div',{class:'value-card','data-source':path},el('span',{class:'value-label',text:m?.label||key||'결과',title:path}),el('strong',{class:value===null?'null-value':'',text:format(value)+(m?.unit?' '+m.unit:'')}));}
function fileView(file){
  if(typeof file.base64!=='string'||file.base64.length>3_000_000)return el('p',{text:'파일 크기가 표시 한도를 초과했습니다.'});
  try{const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));const mime=/^(image\/(png|jpeg|gif|webp)|audio\/[\w.+-]+|video\/mp4|application\/pdf|text\/plain)$/.test(file.mime)?file.mime:'application/octet-stream';const u=URL.createObjectURL(new Blob([bytes],{type:mime}));activeURLs.add(u);
    const node=el('div',{class:'file-result'});if(mime.startsWith('image/'))node.append(el('img',{src:u,alt:file.name||'반환된 이미지'}));
    else if(mime.startsWith('audio/')||mime.startsWith('video/'))node.append(el(mime.startsWith('audio/')?'audio':'video',{src:u,controls:''}));
    node.append(el('div',{class:'file-details'},el('span',{text:`${file.name||'result'} · ${(bytes.length/1024).toFixed(1)} KB`}),el('a',{href:u,download:file.name||'result',class:'secondary',text:'파일 다운로드 ↓'})));return node;
  }catch{return el('p',{text:'파일 데이터를 읽을 수 없습니다.'});}
}
function table(rows,path,mapping){
  const keys=[...new Set(rows.slice(0,100).flatMap(r=>Object.keys(r)))].slice(0,12);let sortKey=null,ascending=true;
  const body=el('tbody'),search=el('input',{type:'search',placeholder:'현재 받은 데이터에서 검색',class:'table-search','aria-label':'결과 검색'});
  const render=()=>{const q=search.value.toLowerCase();let data=rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q));if(sortKey)data=[...data].sort((a,b)=>{const va=a[sortKey],vb=b[sortKey];return(ascending?1:-1)*(typeof va==='number'&&typeof vb==='number'?va-vb:format(va).localeCompare(format(vb)));});body.replaceChildren(...data.slice(0,100).map(row=>el('tr',{},...keys.map(key=>el('td',{'data-source':path+'/'+rows.indexOf(row)+'/'+part(key)},typeof row[key]==='object'&&row[key]!==null?el('details',{},el('summary',{text:Array.isArray(row[key])?`${row[key].length}개 항목`:'상세 보기'}),renderValue(row[key],path+'/'+rows.indexOf(row)+'/'+part(key),mapping,2)):format(row[key]))))));};
  search.addEventListener('input',render);const head=el('thead',{},el('tr',{},...keys.map(key=>el('th',{},el('button',{type:'button',text:key+' ↕',onclick:()=>{ascending=sortKey===key?!ascending:true;sortKey=key;render();}})))));render();
  return el('div',{class:'table-result'},el('div',{class:'table-toolbar'},el('span',{text:`받은 ${rows.length}개 항목 · 최대 100행 / 12열 표시`}),search),el('div',{class:'table-scroll'},el('table',{},head,body)),el('p',{class:'data-note',text:'검색·정렬은 현재 받은 데이터에만 적용됩니다. 생략된 값은 원본에서 확인할 수 있어요.'}));
}
export function renderValue(value,path='',mapping=[],depth=0){
  if(depth>8)return el('p',{class:'data-note',text:'더 깊은 데이터는 원본 JSON에서 확인해주세요.'});
  if(value===null||typeof value!=='object')return typeof value==='string'&&value.length>180?el('pre',{class:'text-result',text:value,'data-source':path}):scalar('결과',value,path,mapping);
  if(value.file?.base64)return fileView(value.file);
  if(Array.isArray(value)){
    if(!value.length)return el('div',{class:'empty-inline',text:'빈 배열 · 받은 항목이 없습니다.'});
    if(value.every(v=>v&&typeof v==='object'&&!Array.isArray(v)))return table(value,path,mapping);
    return el('div',{class:'array-values'},...value.slice(0,100).map((v,i)=>renderValue(v,path+'/'+i,mapping,depth+1)),value.length>100?el('p',{text:'100개 이후 항목은 원본에서 확인해주세요.'}):null);
  }
  const entries=Object.entries(value);if(!entries.length)return el('div',{class:'empty-inline',text:'빈 객체 · 반환된 필드가 없습니다.'});
  const primary=[],nested=[];
  for(const [key,v]of entries){const p=path+'/'+part(key);if(v===null||typeof v!=='object'){if(typeof v==='string'&&v.length>250)nested.push(el('details',{class:'nested-block'},el('summary',{text:key}),renderValue(v,p,mapping,depth+1)));else primary.push(scalar(key,v,p,mapping));}else nested.push(el('details',{class:'nested-block',...(depth===0&&Array.isArray(v)?{open:''}:{})},el('summary',{},el('span',{text:key}),el('span',{class:'nested-count',text:Array.isArray(v)?`${v.length} items`:`${Object.keys(v).length} fields`})),renderValue(v,p,mapping,depth+1)));}
  return el('div',{class:'object-result'},el('div',{class:'values-grid'},...primary),...nested);
}
export function renderFields(container,fields,defaults={}, {expandOptional=false}={}){
  container.replaceChildren();
  const required=el('div'),optional=el('details',{class:'optional-fields',...(expandOptional?{open:''}:{})},el('summary',{text:'요청 매개변수 · 선택 옵션'}));
  for(const f of fields){const id='field-'+f.name;const wrap=el('div',{class:'form-field'},el('label',{for:id,text:f.label+(f.required?' *':'')}));
    let input;if(f.type==='boolean')input=el('select',{id,name:f.name},el('option',{value:'',text:f.required?'선택해주세요':'전달하지 않음'}),...['true','false'].map(v=>el('option',{value:v,text:v})));
    else if(f.type==='json')input=el('textarea',{id,name:f.name,rows:4});
    else input=el('input',{id,name:f.name,type:f.type==='number'?'number':f.type==='file'?'file':'text',...(f.type==='number'?{step:'any'}:{})});
    if(f.required)input.required=true;if(f.type!=='file')input.value=defaults[f.name]!==undefined?typeof defaults[f.name]==='object'?JSON.stringify(defaults[f.name]):String(defaults[f.name]):f.example;
    wrap.append(input);if(f.description)wrap.append(el('small',{text:f.description}));(f.required?required:optional).append(wrap);
  }
  container.append(required);if(optional.children.length>1)container.append(optional);if(!fields.length)container.append(el('p',{class:'data-note',text:'추가 입력 없이 실행할 수 있는 기능입니다.'}));
}
export async function readInputs(form,fields,files={}){const out={};for(const f of fields){const node=form.elements.namedItem(f.name);if(f.type==='file'){const file=node.files[0]||files?.[f.name];if(!file)continue;if(file.size>1_000_000)throw new Error('파일은 1MB 이하로 업로드해주세요.');out[f.name]={name:file.name,mime:file.type||'application/octet-stream',base64:await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.onerror=reject;r.readAsDataURL(file);})};}else{const v=node.value;if(v==='')continue;out[f.name]=f.type==='number'?Number(v):f.type==='boolean'?v==='true':f.type==='json'?JSON.parse(v):v;}}return out;}
