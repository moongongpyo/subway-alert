import {probeConnection,isNetworkError} from './network.js';
try{
  console.log(JSON.stringify(await probeConnection(process.argv[2])));
}catch(error){
  console.log(JSON.stringify({reachable:false,code:isNetworkError(error)?'EXTERNAL_UNREACHABLE':'NETWORK_CHECK_FAILED',error:error.message}));
  process.exitCode=1;
}
