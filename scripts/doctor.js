import OpenAI from 'openai';
import {Daytona} from '@daytona/sdk';
import {safeRequest} from '../src/network.js';
const clean=value=>String(value||'').replaceAll(process.env.OPENAI_API_KEY||'__unset__','[redacted]').replaceAll(process.env.DAYTONA_API_KEY||'__unset__','[redacted]').slice(0,500);
const check=async(label,fn)=>{try{console.log(label+': '+await fn());}catch(e){console.log(label+': unavailable ('+(e.status||e.code||e.name)+') '+clean(e.message));}};
await check('OpenAI token counting',async()=>{
  if(!process.env.OPENAI_API_KEY)return 'OPENAI_API_KEY missing';
  const client=new OpenAI({maxRetries:0,timeout:15_000});
  const r=await client.responses.inputTokens.count({model:'gpt-5.6-terra',input:'Connection check.'});
  return 'Terra token count available: '+r.input_tokens+' (no generation performed)';
});
await check('Daytona',async()=>{
  if(!process.env.DAYTONA_API_KEY)return 'DAYTONA_API_KEY missing';
  const client=new Daytona({apiKey:process.env.DAYTONA_API_KEY,requestTimeoutMs:15_000});
  for await(const _sandbox of client.list({limit:1})){break;}
  return 'API reachable (no sandbox created)';
});
await check('Public API transport',async()=>{const r=await safeRequest('https://pokeapi.co/api/v2/pokemon/pikachu');if(r.status!==200)throw new Error('HTTP '+r.status);return 'HTTP 200, '+r.body.length+' bytes, validated DNS/HTTPS';});
