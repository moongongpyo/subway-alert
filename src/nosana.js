import { fail } from './config.js';

export const NOSANA_MODEL = 'qwen3.6:35b-a3b-q8_0';

export function modelConfiguration(env=process.env) {
  const provider=env.MODEL_PROVIDER||'openai';
  if(!['openai','nosana'].includes(provider))fail('INVALID_CONFIG','MODEL_PROVIDER는 openai 또는 nosana여야 합니다.',503);
  if(provider==='openai')return {provider,ready:!!env.OPENAI_API_KEY,label:'OpenAI API'};
  const expiresAt=Date.parse(env.NOSANA_EXPIRES_AT||'');
  const hourlyUSD=Number(env.NOSANA_HOURLY_USD||0),maximumUSD=Number(env.NOSANA_MAX_USD||0);
  return {provider,ready:!!env.NOSANA_BASE_URL&&Number.isFinite(expiresAt)&&expiresAt>Date.now(),
    label:'Nosana · Qwen 3.6 35B-A3B',model:NOSANA_MODEL,expiresAt:Number.isFinite(expiresAt)?expiresAt:null,
    billing:'gpu-hour',hourlyUSD,maximumUSD};
}

// Compatibility adapter: agents keep their Responses-shaped prompts and schemas.
// No OpenAI request, credential, fallback, deployment creation, or renewal here.
export class NosanaClient {
  constructor({baseURL=process.env.NOSANA_BASE_URL,token=process.env.NOSANA_INFERENCE_TOKEN,
    expiresAt=process.env.NOSANA_EXPIRES_AT,fetcher=fetch}={}) {
    let url;try{url=new URL(baseURL);}catch{fail('CONFIG_REQUIRED','Nosana 배포 주소를 설정해주세요.',503);}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail('INVALID_CONFIG','Nosana 연결에는 인증 정보가 없는 HTTPS 주소가 필요합니다.',503);
    this.baseURL=url.href.replace(/\/$/,'');this.token=token;this.expiresAt=Date.parse(expiresAt||'');this.fetcher=fetcher;
    this.responses={create:(body,options)=>this.create(body,options)};
  }
  assertAvailable(){
    if(!Number.isFinite(this.expiresAt))fail('CONFIG_REQUIRED','Nosana 배포 종료 시간을 설정해주세요.',503);
    if(Date.now()>=this.expiresAt)fail('NOSANA_EXPIRED','Nosana 배포 시간이 끝났습니다. 배포를 다시 시작하거나 OpenAI 복구 설정으로 전환해주세요.',503);
  }
  async request(path,body,{signal,timeout=90_000,binary=false,maxBytes=4_000_000}={}){
    this.assertAvailable();
    const deadline=AbortSignal.timeout(Math.max(1,Math.min(timeout,this.expiresAt-Date.now())));
    const response=await this.fetcher(this.baseURL+path,{method:body?'POST':'GET',redirect:'error',
      headers:{'Content-Type':'application/json',...(this.token?{Authorization:'Bearer '+this.token}:{})},
      body:body?JSON.stringify(body):undefined,signal:signal?AbortSignal.any([signal,deadline]):deadline});
    if(!response.ok){await response.body?.cancel();fail('NOSANA_CONNECTION',`Nosana 모델 서버가 HTTP ${response.status}를 반환했습니다. 배포 상태를 확인해주세요.`,response.status);}
    const reader=response.body.getReader();let bytes=0;const parts=[];
    try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>maxBytes)fail('MODEL_INCOMPLETE','모델 응답 크기 제한을 초과했습니다.');parts.push(Buffer.from(value));}}
    finally{await reader.cancel();}
    if(binary)return Buffer.concat(parts);
    try{return JSON.parse(Buffer.concat(parts).toString());}catch{fail('MODEL_INCOMPLETE','Nosana에서 유효한 JSON 응답을 받지 못했습니다.');}
  }
  async models(){return this.request('/api/tags',null,{timeout:15_000});}
  async create(body,options={}) {
    const input=typeof body.input==='string'?{content:body.input}:body.input[0];
    const content=typeof input.content==='string'?input.content:input.content.find(c=>c.type==='input_text')?.text;
    const images=Array.isArray(input.content)?input.content.filter(c=>c.type==='input_image').map(c=>c.image_url.split(',')[1]):[];
    if(!content||Buffer.byteLength(content)>120_000)fail('BUDGET_EXCEEDED','한 번에 분석할 문서 크기를 초과했습니다.');
    // Ollama's grammar enforces shape but does not inject schema descriptions.
    // Carry over the Responses format as protocol instructions; tasks stay intact.
    const messages=[{role:'system',content:body.instructions+'\n\nReturn JSON matching this schema:\n'+JSON.stringify(body.text.format.schema)},{role:'user',content,...(images.length?{images}:{})}];
    const r=await this.request('/api/chat',{model:NOSANA_MODEL,messages,stream:false,
      format:body.text.format.schema,think:false,keep_alive:'30m',
      options:{num_ctx:32768,num_predict:body.max_output_tokens,temperature:0.2}},options);
    const usage={input_tokens:r.prompt_eval_count,output_tokens:r.eval_count};
    if(r.model!==NOSANA_MODEL||!Number.isInteger(usage.input_tokens)||usage.input_tokens<1||!Number.isInteger(usage.output_tokens)||usage.output_tokens<0)fail('UNKNOWN_TOKENS','Nosana 모델 또는 실제 토큰 사용량을 확인하지 못했습니다.');
    return {status:r.done&&r.done_reason==='stop'?'completed':'incomplete',output_text:r.message?.content,usage};
  }
}
