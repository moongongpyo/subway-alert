import {randomInt,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {NosanaClient} from './nosana.js';
import {fail} from './config.js';

export const NOSANA_IMAGE_MODEL='nosana-sdxl';
export class NosanaImages extends NosanaClient {
  constructor(options={}){super({baseURL:process.env.NOSANA_IMAGE_BASE_URL,token:process.env.NOSANA_IMAGE_TOKEN,expiresAt:process.env.NOSANA_IMAGE_EXPIRES_AT,...options});}
  async generate(prompt,{signal,timeout=120_000}={}){
    const deadline=AbortSignal.timeout(timeout);signal=signal?AbortSignal.any([signal,deadline]):deadline;
    const options={signal,timeout:30_000};
    const info=await this.request('/object_info/CheckpointLoaderSimple',null,options);
    const checkpoints=info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]||[];
    const checkpoint=checkpoints.find(name=>/sd_xl_base_1\.0|sdxl/i.test(name));
    if(!checkpoint)fail('IMAGE_PROVIDER_REQUIRED','Nosana에서 SDXL 모델 파일을 아직 준비 중입니다.');
    const id=randomUUID(),workflow={
      '3':{class_type:'KSampler',inputs:{seed:randomInt(2147483647),steps:20,cfg:7,sampler_name:'euler',scheduler:'normal',denoise:1,model:['4',0],positive:['6',0],negative:['7',0],latent_image:['5',0]}},
      '4':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:checkpoint}},
      '5':{class_type:'EmptyLatentImage',inputs:{width:768,height:768,batch_size:1}},
      '6':{class_type:'CLIPTextEncode',inputs:{text:prompt,clip:['4',1]}},
      '7':{class_type:'CLIPTextEncode',inputs:{text:'watermark, text, blurry, low quality',clip:['4',1]}},
      '8':{class_type:'VAEDecode',inputs:{samples:['3',0],vae:['4',2]}},
      '9':{class_type:'SaveImage',inputs:{filename_prefix:'experiment-'+id,images:['8',0]}},
    };
    // One submission only: a timeout never submits a duplicate image job.
    const queued=await this.request('/prompt',{prompt:workflow,client_id:id},options);
    if(!queued.prompt_id||Object.keys(queued.node_errors||{}).length)fail('IMAGE_GENERATION_FAILED','Nosana 이미지 요청을 실행하지 못했습니다.');
    for(let poll=0;poll<60;poll++){
      signal.throwIfAborted();
      const history=await this.request('/history/'+encodeURIComponent(queued.prompt_id),null,options),result=history[queued.prompt_id];
      if(result?.status?.status_str==='error')fail('IMAGE_GENERATION_FAILED','Nosana 이미지 생성이 실패했습니다.');
      const file=result?.outputs?.['9']?.images?.[0];
      if(file){
        const query=new URLSearchParams({filename:file.filename,subfolder:file.subfolder||'',type:'output'});
        const bytes=await this.request('/view?'+query,null,{...options,binary:true,maxBytes:8_000_000});
        const jpeg=await sharp(bytes,{limitInputPixels:4_194_304}).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();
        if(jpeg.length>1_000_000)fail('INVALID_GENERATED_IMAGE','생성 이미지 크기가 1MB를 초과했습니다.');
        // Delete only this request's history entry. Never clear shared queues.
        await this.request('/history',{delete:[queued.prompt_id]},options).catch(()=>{});
        return {name:'generated-experiment.jpg',mime:'image/jpeg',base64:jpeg.toString('base64')};
      }
      await delay(2000,null,{signal});
    }
    fail('IMAGE_GENERATION_FAILED','이미지 생성 제한 시간에 도달했습니다.');
  }
}
