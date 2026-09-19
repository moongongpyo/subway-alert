import {createHash, timingSafeEqual} from 'node:crypto';

export function hostingConfig(env=process.env) {
  const host=env.HOST||'127.0.0.1', remote=!['127.0.0.1','localhost','::1'].includes(host);
  let origin;
  if(remote){
    origin=new URL(env.PUBLIC_ORIGIN||'https://'+(env.RAILWAY_PUBLIC_DOMAIN||''));
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('공개 배포에는 HTTPS PUBLIC_ORIGIN이 필요합니다.');
    if(!env.ACCESS_PASSWORD||env.ACCESS_PASSWORD.length<24)throw new Error('공개 배포에는 24자 이상의 ACCESS_PASSWORD가 필요합니다.');
  }
  return {host,remote,origin:origin?.origin,hostname:origin?.hostname,password:env.ACCESS_PASSWORD,username:env.ACCESS_USERNAME||'admin'};
}

export function hostingGate(config) {
  const hash=value=>createHash('sha256').update(value).digest();
  return (req,res,next)=>{
    if(req.method==='GET'&&req.path==='/healthz')return res.status(200).json({ok:true});
    if(!config.remote)return next();
    if(req.hostname!==config.hostname)return res.status(403).json({error:'허용되지 않은 호스트입니다.'});
    if(req.headers['x-forwarded-proto']!=='https')return res.status(400).json({error:'HTTPS 연결이 필요합니다.'});
    res.set('Strict-Transport-Security','max-age=31536000');
    const auth=req.headers.authorization||'';
    const supplied=auth.startsWith('Basic ')?Buffer.from(auth.slice(6),'base64').toString('utf8'):'';
    if(!timingSafeEqual(hash(supplied),hash(`${config.username}:${config.password}`)))return res.status(401).set('WWW-Authenticate','Basic realm="URL to Playground", charset="UTF-8"').send('로그인이 필요합니다.');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin&&req.headers.origin!==config.origin)return res.status(403).json({error:'다른 출처의 요청은 허용하지 않습니다.'});
    next();
  };
}
