// Shared, fixed chart code. Model output never supplies SVG or executable code.
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function chartSVG(series,{start=0,end=series.x.length-1,hidden=[]}={}) {
  start=Math.max(0,Math.min(series.x.length-1,Math.floor(Number(start)||0)));
  end=Math.max(start,Math.min(series.x.length-1,Math.floor(Number(end)||0)));
  const visible=series.lines.filter((_,i)=>!hidden.includes(i)),valid=[];
  for(const line of visible)for(let i=start;i<=end;i++)if(Number.isFinite(line.values[i]))valid.push(line.values[i]);
  const min=valid.length?Math.min(...valid):0,max=valid.length?Math.max(...valid):1,span=max-min||1;
  const left=64,top=24,width=600,height=216,lo=series.positions[start],hi=series.positions[end];
  const x=i=>left+(hi===lo ? .5 : (series.positions[i]-lo)/(hi-lo))*width,y=v=>top+height-(v-min)/span*height;
  const fmt=v=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}).format(v);
  const colors=['#3f725a','#b26c3e','#527fb0','#995c89','#9a882f','#567d87'];
  let content=`<line x1="${left}" y1="${top}" x2="${left}" y2="${top+height}" stroke="#ccd4ce"/><line x1="${left}" y1="${top+height}" x2="${left+width}" y2="${top+height}" stroke="#ccd4ce"/>`;
  for(const [v,yp] of [[max,top],[min,top+height]])content+=`<text x="${left-8}" y="${yp+4}" text-anchor="end">${escapeHTML(fmt(v))}</text>`;
  for(const [i,xp,anchor] of [[start,left,'start'],[end,left+width,'end']])content+=`<text x="${xp}" y="${top+height+28}" text-anchor="${anchor}">${escapeHTML(String(series.x[i]).slice(0,28))}</text>`;
  series.lines.forEach((line,n)=>{if(hidden.includes(n))return;let path='',open=false;
    for(let i=start;i<=end;i++){const v=line.values[i];if(!Number.isFinite(v)){open=false;continue;}path+=(open?' L':' M')+x(i).toFixed(2)+' '+y(v).toFixed(2);open=true;}
    content+=`<path d="${path}" fill="none" stroke="${colors[n%colors.length]}" stroke-width="2.5"><title>${escapeHTML(line.label)}</title></path>`;
    if(start===end&&Number.isFinite(line.values[start]))content+=`<circle cx="${x(start)}" cy="${y(line.values[start])}" r="4" fill="${colors[n%colors.length]}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 290" role="img" aria-label="${escapeHTML(series.label)}"><title>${escapeHTML(series.label)} · ${escapeHTML(series.unit||'단위 미제공')}</title><g font-family="system-ui,sans-serif" font-size="12" fill="#65756b">${content}</g></svg>`;
}
