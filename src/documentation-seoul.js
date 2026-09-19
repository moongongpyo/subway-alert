import {load} from 'cheerio';

// Seoul's dataset tabs are loaded by a JS form handler. Read only the observed
// public documentation route, without executing JS or submitting the form.
export function seoulDocumentation(raw,url){
  const u=new URL(url);
  if(u.origin!=='https://data.seoul.go.kr')return null;
  const $=load(raw),links=[],scripts=$('script').map((_i,e)=>$(e).text()).get().join('\n');
  const dataset=u.pathname.match(/^\/dataList\/(OA-\d+)\/A\/\d+\/datasetView\.do$/);
  if(dataset&&$('#infId').val()===dataset[1]){
    const tab=$('button[onclick]').toArray().find(e=>new RegExp(`^\\s*dataSetView\\(\\s*['"]${dataset[1]}['"]\\s*,\\s*['"]A['"]\\s*,\\s*\\d+\\s*\\)\\s*;?\\s*$`).test($(e).attr('onclick')));
    const route=scripts.match(/["'](\/dataList\/openApiView\.do\?infId=)["']\s*\+\s*infId\b/);
    if(tab&&route&&/["']&srvType=["']\s*\+\s*srvType\b/.test(scripts)){
      links.push({url:new URL(route[1]+dataset[1]+'&srvType=A',u).href,title:$(tab).text().trim()+' · 현재 데이터셋 호출 명세',embedded:true,from:url});
    }
  }
  if(u.pathname==='/dataList/openApiView.do'&&/^OA-\d+$/.test(u.searchParams.get('infId')||'')){
    // Keep issuing links as manual navigation evidence; never crawl account pages.
    for(const e of $('button[onclick]').toArray()){
      const label=$(e).text().trim();if(!/인증키 신청|Open API 이용안내/.test(label))continue;
      const name=$(e).attr('onclick').match(/^\s*([A-Za-z_$][\w$]*)\(\s*\)\s*;?\s*$/)?.[1];if(!name)continue;
      const body=scripts.match(new RegExp('function\\s+'+name.replace(/\$/g,'\\$')+'\\s*\\([^)]*\\)\\s*\\{([^{}]*)\\}'))?.[1];
      const target=body?.match(/document\.frm\.action\s*=\s*["']([^"']+)["']/)?.[1];if(!target)continue;
      const address=new URL(target,u);
      if(address.origin===u.origin&&/^\/together\/(?:guide|mypage)\/[\w]+\.do$/.test(address.pathname))links.push({url:address.href,title:label,from:url,manual:/mypage/.test(address.pathname)});
    }
  }
  return {title:dataset?$('.main-content-tit').first().text().trim():null,links};
}
