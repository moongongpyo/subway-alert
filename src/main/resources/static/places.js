 'use strict';
window.PlacePicker=class {
 constructor(root,label){this.root=root;this.value=null;this.version=0;root.classList.add('place-picker');const id=root.id+'-input';const lab=document.createElement('label');lab.htmlFor=id;lab.textContent=label;this.input=document.createElement('input');this.input.id=id;this.input.placeholder='역, 건물, 장소 이름';this.input.autocomplete='off';this.input.maxLength=80;this.input.setAttribute('aria-label',label+' 장소 이름');const row=document.createElement('div');row.className='place-input';this.button=document.createElement('button');this.button.type='button';this.button.textContent='검색';this.button.setAttribute('aria-label',label+' 장소 검색');row.append(this.input,this.button);this.results=document.createElement('div');this.results.className='place-options';this.results.setAttribute('aria-live','polite');this.caption=document.createElement('small');root.append(lab,row,this.caption,this.results);this.input.addEventListener('input',()=>{this.value=null;this.version++;this.caption.textContent='검색 후 장소를 선택해 주세요.';this.results.replaceChildren();});this.input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();this.search();}});this.button.onclick=()=>this.search();}
 set(value){this.value=value;this.input.value=value?.name||'';this.caption.textContent=value?.address||'';this.results.replaceChildren();this.version++;}
 async search(){const q=this.input.value.trim();if(q.length<2){this.caption.textContent='두 글자 이상 입력해 주세요.';return;}const version=++this.version;this.button.disabled=true;this.caption.textContent='장소 검색 중…';try{const res=await fetch('/api/places?q='+encodeURIComponent(q));const data=await res.json();if(!res.ok)throw Error(data.message||data.detail||'장소 검색에 실패했습니다.');if(version!==this.version)return;this.results.replaceChildren();this.caption.textContent=data.length?'검색 결과에서 장소를 선택하세요.':'검색 결과가 없습니다. 지역명을 함께 입력해 보세요.';for(const p of data){const b=document.createElement('button');b.type='button';const name=document.createElement('strong'),address=document.createElement('small');name.textContent=p.name;address.textContent=p.address;b.append(name,address);b.onclick=()=>this.set(p);this.results.append(b);}}catch(e){if(version===this.version)this.caption.textContent=e.message;}finally{this.button.disabled=false;}}
 get(){if(!this.value)throw Error('출발지와 도착지를 검색한 뒤 결과에서 선택해 주세요.');return{name:this.value.name,lon:this.value.lon,lat:this.value.lat};}
};

window.DeparturePicker=class {
 constructor(root){
  const label=document.createElement('label');label.textContent='출발 시간 (한국 시간)';
  this.input=document.createElement('input');this.input.type='datetime-local';this.input.min='1900-01-01T00:00';this.input.max='9999-12-31T23:59';this.input.setAttribute('aria-label','출발 시간 (한국 시간)');
  const button=document.createElement('button');button.type='button';button.textContent='지금 출발';button.onclick=()=>{this.input.value='';};
  label.append(this.input);root.className='departure-picker';root.append(label,button);
  const hint=document.createElement('small');hint.textContent='비워두면 현재 시각으로 검색합니다. 시연하려면 낮 시간을 선택하세요.';root.append(hint);
 }
 get(){const v=this.input.value;return v?v.replace(/[-:T]/g,''):null;}
};
