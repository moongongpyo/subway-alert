import { chartSVG } from './analysis-chart.js';

// Runs in the trusted parent app. The result iframe still has script-src 'none'
// and no allow-scripts; only server-rendered controls are wired here.
export function connectResultInteractions(document) {
  if(!document?.body||document.body.dataset.connected)return;
  document.body.dataset.connected='true';
  for(const table of document.querySelectorAll('[data-result-table]')){
    const rows=[...table.querySelectorAll('tbody tr')],count=table.querySelector('[data-table-count]'),initial=count.textContent;
    table.querySelector('input[type=search]').addEventListener('input',event=>{
      const query=event.target.value.trim().toLocaleLowerCase();let matches=0;
      for(const row of rows){row.hidden=!row.textContent.toLocaleLowerCase().includes(query);if(!row.hidden)matches++;}
      count.textContent=query?`표시된 ${rows.length}개 중 ${matches}개 일치`:initial;
    });
  }
  for(const block of document.querySelectorAll('[data-result-series]')){
    let series;try{series=JSON.parse(block.dataset.resultSeries);}catch{continue;}
    const start=block.querySelector('[data-range=start]'),end=block.querySelector('[data-range=end]');
    const update=()=>{if(+start.value>+end.value)end.value=start.value;const hidden=[...block.querySelectorAll('[data-line]')].filter(c=>!c.checked).map(c=>+c.dataset.line);block.querySelector('.chart').innerHTML=chartSVG(series,{start:+start.value,end:+end.value,hidden});block.querySelector('[data-chart-range]').textContent=`${series.x[+start.value]} → ${series.x[+end.value]} · 아래 통계는 전체 구간 기준`;};
    for(const control of block.querySelectorAll('input'))control.addEventListener('input',update);
  }
  for(const block of document.querySelectorAll('[data-result-media]')){
    const images=[...block.querySelectorAll('img')];
    for(const img of images){const label=img.closest('figure').querySelector('[data-image-state]'),show=()=>{label.textContent=img.naturalWidth?`${img.naturalWidth} × ${img.naturalHeight}px · 같은 배율로 세부 확인`:'이미지를 불러오지 못했습니다. 보관 기간을 확인해주세요.';};img.addEventListener('load',show);img.addEventListener('error',()=>{img.hidden=true;show();});if(img.complete)show();}
    block.querySelector('[data-image-zoom]').addEventListener('input',event=>{for(const img of images)img.style.width=`${100*Number(event.target.value)}%`;});
  }
}
