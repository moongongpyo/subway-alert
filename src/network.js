import dns from 'node:dns/promises';
import net, { isIP } from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

// Reject non-global destinations, including IPv4-mapped IPv6 and metadata ranges.
export function publicIP(ip) {
  if (isIP(ip)===4) {
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
  }
  if(isIP(ip)===6) {
    // Some local networks synthesize NAT64 answers alongside the public A record.
    // Only the well-known /96 prefix is accepted, and its embedded IPv4 must be public.
    const translated=/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
    if(translated){const high=parseInt(translated[1],16),low=parseInt(translated[2],16);return publicIP([high>>8,high&255,low>>8,low&255].join('.'));}
    return /^2[0-9a-f]{3}:/i.test(ip) && !/^2001:(db8|0|2):/i.test(ip) && !/^2002:/i.test(ip);
  }
  return false;
}
export function validateURL(input) {
  let u; try {u=new URL(input);} catch {throw new Error('유효한 URL을 입력해주세요.');}
  if (!['http:','https:'].includes(u.protocol)) throw new Error('HTTP 또는 HTTPS URL을 입력해주세요.');
  if(u.username||u.password)throw new Error('URL의 사용자명·비밀번호는 지원하지 않습니다. API 키는 연결 화면에서 입력해주세요.');
  if(u.port==='0')throw new Error('포트는 1~65535 범위여야 합니다.');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||isIP(host)&&!publicIP(host)) throw new Error('내부망 주소는 사용할 수 없습니다.');
  u.hash=''; return u;
}
export function isNetworkError(error){
  return ['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ABORT_ERR','EPIPE'].includes(error?.code)||error?.name==='TimeoutError';
}
export function connectionFailure(origin,organization=false){
  return `Daytona 실행 환경에서 ${new URL(origin).origin}에 연결하지 못했습니다. `+(organization?'이 작업에는 Daytona 계정의 강제 네트워크 제한이 적용돼 있습니다. Daytona Limits에서 Internet Access 권한과 대상 허용 여부를 확인해주세요. ':'대상 API의 응답 상태와 Daytona의 외부 연결 허용 설정을 확인해주세요. ')+ '인증키의 유효성은 아직 확인하지 못했습니다. URL이나 코드를 바꾸는 모델 재시도는 하지 않습니다.';
}
async function publicRecords(host){
  const records=isIP(host)?[{address:host,family:isIP(host)}]:await dns.lookup(host,{all:true});
  if(!records.length||records.some(r=>!publicIP(r.address))) throw new Error('내부망으로 연결되는 URL은 차단합니다.');
  return records.sort((a,b)=>a.family-b.family);
}
// No HTTP request, key, or billable API invocation. HTTPS also needs a TLS
// handshake: a firewall may accept TCP and reject the requested TLS hostname.
export async function probeConnection(input,{timeout=8000,signal}={}){
  const u=validateURL(input),host=u.hostname.replace(/^\[|\]$/g,''),started=Date.now();
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
  const records=await publicRecords(host);signal.throwIfAborted();
  const secure=u.protocol==='https:';
  await new Promise((resolve,reject)=>{
    const options={host:records[0].address,port:Number(u.port||(secure?443:80)),family:records[0].family,signal};
    const socket=secure?tls.connect({...options,servername:isIP(host)?undefined:host,rejectUnauthorized:true}):net.createConnection(options);
    socket.once(secure?'secureConnect':'connect',()=>{socket.destroy();resolve();});socket.once('error',reject);
  });
  return {origin:u.origin,durationMs:Date.now()-started,stage:secure?'tls':'tcp',reachable:true};
}
export async function safeRequest(input,{ method='GET', headers={}, body, maxBytes=2_000_000, timeout=20_000, signal, redirects=3, allowedOrigin }={}) {
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
  const u=validateURL(input); if(allowedOrigin&&u.origin!==allowedOrigin) throw new Error('허용되지 않은 API 대상입니다.');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  const records=await publicRecords(host);
  const target=records[0];
  return await new Promise((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).request(u,{method,headers:{'User-Agent':'URL-to-Playground/0.1',...headers},signal,autoSelectFamily:false,lookup:(_h,_o,cb)=>cb(null,target.address,target.family)},res=>{
      if(res.statusCode>=300&&res.statusCode<400&&res.headers.location) {
        res.resume();
        if(!redirects||!['GET','HEAD'].includes(method)) return reject(new Error('이 요청의 리다이렉트는 허용하지 않습니다.'));
        const next=new URL(res.headers.location,u); const clean={...headers};
        if(next.origin!==u.origin) { if(Object.keys(headers).some(k=>/authorization|key|token|cookie/i.test(k))) return reject(new Error('인증 요청의 외부 리다이렉트를 차단했습니다.')); delete clean.Authorization; }
        safeRequest(next.href,{method,headers:clean,maxBytes,timeout,signal,redirects:redirects-1,allowedOrigin}).then(resolve,reject); return;
      }
      const chunks=[]; let size=0;
      res.on('data',c=>{size+=c.length;if(size>maxBytes){res.destroy(new Error('응답 크기 제한(2MB)을 초과했습니다.'));}else chunks.push(c);});
      res.on('error',reject); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks),url:u.href}));
    });
    req.setTimeout(timeout,()=>req.destroy(Object.assign(new Error('HTTP 응답 시간이 초과됐습니다.'),{code:'ETIMEDOUT'}))); req.on('error',reject); if(body) req.write(body); req.end();
  });
}
