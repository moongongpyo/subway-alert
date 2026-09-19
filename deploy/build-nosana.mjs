// Builds local definitions only. It never creates or extends paid deployments.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const token=process.env.NOSANA_INFERENCE_TOKEN;
if(!token||token.length<32)throw Error('Set NOSANA_INFERENCE_TOKEN (at least 32 characters).');
const hash=createHash('sha256').update(token).digest('hex');
const gateway=readFileSync(new URL('./nosana-gateway.py',import.meta.url),'utf8');
const proxy=`cat > /tmp/gateway.py <<'PY'\n${gateway}\nPY\n`;
const expose=[{port:8000,health_checks:[{type:'http',path:'/health',method:'GET',expected_status:200,continuous:false}]}];
const make=(id,args,vram)=>({version:'0.1',type:'container',ops:[{type:'container/run',id,args:{...args,gpu:true,entrypoint:['/bin/bash','-c'],expose}}],meta:{trigger:'dashboard',system_requirements:{vram_total_mb:vram}}});
const qwen=make('server',{
  image:'docker.io/ollama/ollama:0.32.6',
  cmd:[`set -e\napt-get update -qq && apt-get install -y -qq --no-install-recommends python3\n${proxy}ollama serve &\npython3 /tmp/gateway.py &\nwait -n`],
  env:{OLLAMA_MODELS:'/models',OLLAMA_HOST:'127.0.0.1:11434',OLLAMA_CONTEXT_LENGTH:'32768',OLLAMA_NUM_PARALLEL:'1',OLLAMA_FLASH_ATTENTION:'1',OLLAMA_NO_CLOUD:'1',INFERENCE_MODE:'llm',UPSTREAM_PORT:'11434',INFERENCE_MODEL:'qwen3.6:35b-a3b-q8_0',INFERENCE_TOKEN_SHA256:hash},
  resources:[{type:'Ollama',model:'qwen3.6:35b-a3b-q8_0',target:'/models'}],
},46080);
const sdxl=make('SDXL-comfy',{
  image:'docker.io/nosana/comfyui:2.0.11',work_dir:'/comfyui',
  cmd:[`set -e\n${proxy}python main.py --listen 127.0.0.1 --port 8188 &\npython /tmp/gateway.py &\nwait -n`],
  env:{INFERENCE_MODE:'image',UPSTREAM_PORT:'8188',INFERENCE_TOKEN_SHA256:hash},
  resources:[{type:'HF',repo:'stabilityai/stable-diffusion-xl-base-1.0',files:['sd_xl_base_1.0.safetensors'],target:'/comfyui/models/checkpoints'}],
},24576);
mkdirSync('.deploy',{recursive:true});
for(const [name,definition] of Object.entries({qwen,sdxl}))writeFileSync(`.deploy/nosana-${name}.json`,JSON.stringify(definition,null,2)+'\n');
console.log('Wrote .deploy/nosana-qwen.json and .deploy/nosana-sdxl.json (no paid action).');
