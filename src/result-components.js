import { ViewDesign, pointer } from './evaluation-contracts.js';
import { measure, sourceValue, scalar, numeric, columnProfile, readField } from './analysis-data.js';
import { chartSVG, escapeHTML as esc } from '../public/analysis-chart.js';

const display=value=>value===undefined||value===null?'—':numeric(value)?new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}).format(value):typeof value==='object'?'원본에서 구조 확인':String(value);
const text=value=>esc(display(value));
const unit=(sources,source,path)=>{const v=path?sourceValue(sources,source,path):undefined;return typeof v==='string'&&v.length<80?v:'';};
const read=(sources,block)=>sourceValue(sources,block.source,block.path);
const safeLink=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[?&](key|api_key|token|access_token|secret|password)=/i.test(u.href)?u.href:null;}catch{return null;}};

function tableBlock(block,sources) {
  const data=read(sources,block),single=!!data&&typeof data==='object'&&!Array.isArray(data),rows=single?[data]:data;
  if(!Array.isArray(rows))throw new Error('확인할 목록·객체 경로가 없습니다.');
  const columns=block.columns.filter(c=>rows.some(r=>scalar(readField(r,c.path))&&readField(r,c.path)!==undefined));
  if(!columns.length&&rows.length)throw new Error('목록의 실제 값에 연결된 비교 기준이 없습니다.');
  if(!rows.length)return '<p>이번 조건에서 반환된 후보가 없습니다.</p>';
  const cell=value=>{const href=typeof value==='string'&&safeLink(value);return href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text(value)}</a>`:text(value);};
  if(single)return `<table><thead><tr><th>확인 항목</th><th>이번 응답</th></tr></thead><tbody>${columns.map(c=>`<tr><th>${esc(c.label)}</th><td>${cell(readField(data,c.path))} ${esc(unit(sources,block.source,c.unitPath))}</td></tr>`).join('')}</tbody></table>`;
  return `<div data-result-table><label class="control">반환된 후보에서 검색 <input type="search" placeholder="이름·설명·값 검색" aria-label="표에서 검색"></label><p class="scope" data-table-count>표시 ${Math.min(rows.length,500)} / 반환 ${rows.length}개 · 순서는 원본 기준</p><div class="table-scroll"><table><thead><tr>${columns.map(c=>`<th>${esc(c.label)}${unit(sources,block.source,c.unitPath)?' ('+esc(unit(sources,block.source,c.unitPath))+')':''}</th>`).join('')}</tr></thead><tbody>${rows.slice(0,500).map(row=>`<tr>${columns.map(c=>`<td>${cell(readField(row,c.path))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length>500?'<p class="scope">화면 검색은 표시된 500개에 적용됩니다. 전체 값은 원본에서 확인하세요.</p>':''}</div>`;
}

function seriesBlock(block,sources) {
  const data=read(sources,block),rowWise=Array.isArray(data),xs=rowWise?data.map(r=>readField(r,block.x)):readField(data,block.x);
  if(!Array.isArray(xs)||!xs.length)throw new Error('시간·수치 축 데이터가 없습니다.');
  const position=v=>numeric(v)?v:typeof v==='string'&&/^\d{4}-\d\d-\d\d(?:T|$)/.test(v)?Date.parse(v):NaN;
  const positions=xs.map(position);
  if(!positions.every(Number.isFinite)||positions.some((v,i)=>i&&v<positions[i-1]))throw new Error('시계열 축이 유효하지 않거나 순서가 다릅니다.');
  const lines=block.columns.map(c=>({label:c.label,unit:unit(sources,block.source,c.unitPath),values:rowWise?data.map(r=>readField(r,c.path)):readField(data,c.path)}));
  if(!lines.length||lines.some(l=>!Array.isArray(l.values)||l.values.length!==xs.length||!l.values.some(numeric)))throw new Error('축과 같은 길이의 수치 계열이 필요합니다.');
  if(new Set(lines.map(l=>l.unit)).size>1)throw new Error('단위가 다른 계열은 별도의 차트로 나눠야 합니다.');
  // Each display bucket retains extrema and a missing marker. Statistics and the
  // model profile still inspect the full stored series, not these display points.
  const indices=new Set([0,xs.length-1]);const bucket=Math.max(1,Math.ceil(xs.length/180));
  for(let start=0;start<xs.length;start+=bucket){indices.add(start);indices.add(Math.min(xs.length-1,start+bucket-1));for(const line of lines){let low=-1,high=-1,missing=-1;for(let i=start;i<Math.min(xs.length,start+bucket);i++){if(!numeric(line.values[i])){missing=i;continue;}if(low<0||line.values[i]<line.values[low])low=i;if(high<0||line.values[i]>line.values[high])high=i;}for(const i of [low,high,missing])if(i>=0)indices.add(i);}}
  const selected=[...indices].sort((a,b)=>a-b),series={label:block.title,unit:lines[0].unit,x:selected.map(i=>xs[i]),positions:selected.map(i=>positions[i]),lines:lines.map(l=>({label:l.label,values:selected.map(i=>numeric(l.values[i])?l.values[i]:null)}))};
  const summaries=lines.map(l=>{const p=columnProfile(l.values);return `<tr><th>${esc(l.label)}</th><td>${text(p.min)}</td><td>${text(p.max)}</td><td>${text(p.mean)}</td><td>${p.missing+p.nonnumeric}</td></tr>`;}).join('');
  return `<div data-result-series="${esc(JSON.stringify(series))}"><p class="scope">${esc(series.unit||'단위가 응답에 제공되지 않았습니다.')} · 반환 ${xs.length}개 중 ${selected.length}개 지점 표시${selected.length<xs.length?' (구간별 극값·결측을 보존한 축약)':''} · 통계는 전체 반환 구간 기준</p><div class="chart">${chartSVG(series)}</div><div class="controls">${lines.map((l,i)=>`<label><input type="checkbox" data-line="${i}" checked> ${esc(l.label)}</label>`).join('')}</div><div class="controls"><label>시작 <input type="range" data-range="start" min="0" max="${selected.length-1}" value="0"></label><label>끝 <input type="range" data-range="end" min="0" max="${selected.length-1}" value="${selected.length-1}"></label></div><p class="scope" data-chart-range>전체 구간</p><details><summary>전체 구간 통계와 결측</summary><table><thead><tr><th>항목</th><th>최소</th><th>최대</th><th>평균</th><th>결측·비수치</th></tr></thead><tbody>${summaries}</tbody></table></details></div>`;
}

function mediaBlock(block,sources,options) {
  const output=read(sources,block),input=block.comparePath?pointer(sources.input,block.comparePath):null;
  const image=(file,label)=>{
    const url=file&&options.mediaURL?.(file);
    if(url)return `<figure><figcaption>${esc(label)}</figcaption><div class="image-window"><img src="${esc(url)}" alt="${esc(label)}" loading="lazy"></div><p class="scope" data-image-state>보관된 이미지 · 크기 확인 중</p></figure>`;
    const href=typeof file==='string'&&safeLink(file);
    return `<figure><figcaption>${esc(label)}</figcaption><p>${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">원본 이미지 링크 열기</a> · 외부 이미지는 이 화면으로 가져오지 않았습니다.`:'미리보기 가능한 보관 이미지가 없습니다. 파일이 만료됐거나 지원하지 않는 형식일 수 있습니다.'}</p></figure>`;
  };
  if(!output)throw new Error('결과 이미지 경로를 찾지 못했습니다.');
  return `<div data-result-media><div class="image-pair">${input?image(input,'원본 입력'):''}${image(output,'처리 결과')}</div><label class="control">같은 배율로 확대 <input type="range" min="1" max="4" step="0.25" value="1" data-image-zoom></label><p class="scope">경계·세부 영역은 직접 확인해주세요. 이미지의 크기나 파일 정보만으로 처리 품질을 판정하지 않습니다.</p></div>`;
}

function comparisonBlock(block,sources,context) {
  if(block.source!=='current')throw new Error('이전 결과는 현재 실행과 연결해서만 비교할 수 있습니다.');
  if(!context.comparison.available)throw new Error('연결된 이전 실행이 없습니다.');
  const current=read(sources,block),previous=pointer(sources.previous,block.comparePath||block.path);
  const columns=block.columns.filter(c=>scalar(readField(current,c.path))&&readField(current,c.path)!==undefined);
  if(!columns.length)throw new Error('비교에 연결된 현재 수치가 없습니다.');
  return `<p class="scope">${esc(context.comparison.differences.join(' · ')||'기록된 입력과 환경 동일')} · ${esc(context.comparison.note)}</p><div class="table-scroll"><table><thead><tr><th>확인 항목</th><th>이전</th><th>이번</th><th>관측 차이</th></tr></thead><tbody>${columns.map(c=>{const a=readField(previous,c.path),b=readField(current,c.path),au=unit(sources,'previous',c.unitPath),bu=unit(sources,block.source,c.unitPath),delta=context.comparison.arithmeticAllowed&&au===bu&&numeric(a)&&numeric(b)?b-a:undefined;return `<tr><th>${esc(c.label)}</th><td>${text(a)} ${esc(au)}</td><td>${text(b)} ${esc(bu)}</td><td>${delta===undefined?'직접 비교 보류':text(delta)+' '+esc(bu)}</td></tr>`;}).join('')}</tbody></table></div>`;
}

const css=`*{box-sizing:border-box}body{margin:0;padding:24px;background:#fff;color:#263a30;font:15px/1.65 system-ui,-apple-system,sans-serif}h1{font-size:25px;line-height:1.4;letter-spacing:-.6px;max-width:850px;margin:8px 0 12px}h2{font-size:19px;margin:0 0 8px}p{margin:8px 0 14px}header{padding-bottom:24px;border-bottom:1px solid #e3e9e3}.eyebrow,.scope{font-size:12px;color:#64766a}.eyebrow{letter-spacing:1px}.evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:24px 0}.metric{border-left:3px solid #b9cbbf;padding:2px 16px}.metric b{font-size:23px;display:block;overflow-wrap:anywhere}.metric small{color:#64766a}.block{margin:28px 0;padding-bottom:24px;border-bottom:1px solid #e3e9e3}.table-scroll{overflow:auto;max-height:520px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #e3e9e3;min-width:110px;max-width:350px;overflow-wrap:anywhere}thead{background:#f4f7f3;position:sticky;top:0}td{white-space:pre-wrap}a{color:#386349;overflow-wrap:anywhere}input[type=search]{padding:10px 12px;border:1px solid #cfdad1;border-radius:8px;max-width:100%;font:inherit}input[type=range]{accent-color:#3f725a;max-width:180px}.control,.controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0}.chart svg{display:block;width:100%;max-height:360px}.image-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;min-width:0}figcaption{font-weight:600;margin-bottom:8px}.image-window{height:360px;overflow:auto;background:repeating-conic-gradient(#edf0eb 0% 25%,white 0% 50%) 50% / 20px 20px;display:block}.image-window img{width:100%;display:block;transform-origin:top left}.status{display:inline-block;padding:3px 10px;border-radius:5px;background:#eff4ee;font-size:12px}.limits{background:#f6f7f3;padding:18px;border-radius:10px}.limits ul{padding-left:20px;margin-bottom:0}details{margin:16px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:600px){body{padding:14px}h1{font-size:21px}.image-pair{grid-template-columns:1fr}.image-window{height:280px}}`;

// Quality here is structural grounding, not a model self-score or a claim that
// the user's purpose has been met. Rejected evidence/components stay visible.
export function renderAnalysisView(design,sources,context,options={}) {
  const view=ViewDesign.parse(design),issues=[],metrics=[];
  for(const e of view.evidence){const value=measure(e,sources);if(value===undefined){issues.push(`${e.label}: 실제 응답에서 이 근거를 찾지 못했습니다.`);continue;}if(e.unitPath&&!unit(sources,e.source,e.unitPath))issues.push(`${e.label}: 응답에서 단위를 확인하지 못했습니다.`);metrics.push({e,value});}
  const blocks=[];
  for(const block of view.blocks){try{
    const body=block.type==='series'?seriesBlock(block,sources):block.type==='table'?tableBlock(block,sources):block.type==='media'?mediaBlock(block,sources,options):comparisonBlock(block,sources,context);
    blocks.push(`<section class="block" data-view-block="${esc(block.type)}"><h2>${esc(block.title)}</h2><p class="scope">${esc(block.reason)}</p>${body}</section>`);
  }catch(error){issues.push(`${block.title}: ${error.message}`);}}
  if(!metrics.length)issues.push('판단에 사용할 근거가 연결되지 않았습니다. 원본과 기대 조건을 확인해주세요.');
  if(!metrics.some(({e})=>e.source==='current')&&context.current.state==='succeeded')issues.push('이번 응답을 직접 확인하는 근거가 없습니다.');
  if(view.focus==='overview'&&context.current.profile?.arrays.some(a=>a.count>1))issues.push('목록·계열 데이터가 있지만 탐색할 전문 뷰가 구성되지 않았습니다.');
  const required={trend:'series',candidates:'table',media:'media',comparison:'comparison'}[view.focus];
  if(required&&!blocks.some(b=>b.includes(`data-view-block="${required}"`)))issues.push(`${({trend:'시간별 변화',candidates:'후보 목록',media:'이미지',comparison:'이전 측정값'})[view.focus]} 화면을 완성하지 못했습니다.`);
  if(!blocks.length&&view.focus!=='overview')issues.push('이 결과의 전문 뷰를 구성하지 못해 연결된 근거만 표시합니다.');
  const status={met:'충족',partial:'부분 충족',unmet:'미충족',unknown:'미확인'},assessment=context.assessment;
  const heading=context.questionBasis==='기능과 실제 입력'?view.question:context.question;
  const conditions=assessment.conditions.length?`<ul>${assessment.conditions.map(c=>`<li>${esc(c.label)} · ${esc(status[c.status]||'미확인')} <span class="scope">${esc(c.reason||'')}</span></li>`).join('')}</ul>`:'<p class="scope">기대 조건이 아직 지정되지 않았습니다. 응답을 받은 사실만으로 목적 충족을 판정하지 않습니다.</p>';
  const differences=context.comparison.available?`<details><summary>이전 실행과 달라진 조건</summary><p>${esc(context.comparison.differences.join(' · ')||'기록된 조건 동일')}</p><ul>${context.comparison.changes.map(c=>`<li>${esc(c.field)}: ${text(c.before)} → ${text(c.after)}</li>`).join('')}</ul><p class="scope">${esc(context.comparison.note)}</p></details>`:'';
  const quality={status:issues.length?'limited':'grounded',checks:{questionFromContext:!!context.question,evidenceResolved:metrics.length,evidenceRequested:view.evidence.length,componentsRendered:blocks.length,componentsRequested:view.blocks.length,expectationsVisible:assessment.conditions.length},issues};
  const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><header><div class="eyebrow">${esc(context.questionBasis)} · ${context.current.state==='succeeded'?'실행 성공':context.current.state==='failed'?'실행 실패':'실행 상태 미확인'}${context.current.status?' · HTTP '+esc(context.current.status):''}</div><h1>${esc(heading)}</h1>${heading===view.question?'':`<p>${esc(view.question)}</p>`}<p class="scope">${esc(view.rationale)}</p><span class="status">목적 충족 · ${esc(status[assessment.status]||'미확인')}</span>${conditions}${context.feedback?`<p class="scope">사용자 피드백: ${esc(context.feedback.note||context.feedback.satisfaction)}</p>`:''}${context.current.error?`<p>${esc(context.current.error)}</p>`:''}</header><section class="evidence">${metrics.map(({e,value})=>`<div class="metric"><span>${esc(e.label)}</span><b>${text(value)} <small>${esc(unit(sources,e.source,e.unitPath))}</small></b><small>${esc(({current:'이번 응답',previous:'이전 응답',input:'이번 입력',previousInput:'이전 입력'})[e.source])}${e.stat!=='value'?' · 전체 반환 값 기준':''}</small></div>`).join('')}</section>${differences}${blocks.join('')}<aside class="limits"><strong>아직 판단할 수 없는 부분</strong><ul>${[...new Set([...view.unknowns,...issues])].map(s=>`<li>${esc(s)}</li>`).join('')}</ul></aside><p class="scope">저장된 실제 값으로 구성 · 통계는 반환된 데이터 기준 · 검색·구간 탐색·확대는 모델 호출 없이 동작합니다. 전체 원본은 아래에서 확인할 수 있어요.</p></body></html>`;
  return {html,quality};
}
