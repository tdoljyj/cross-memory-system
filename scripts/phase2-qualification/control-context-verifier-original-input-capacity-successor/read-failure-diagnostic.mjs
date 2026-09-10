// Public diagnostics only. No raw stderr, URLs, credentials, paths or request bytes.
import crypto from 'node:crypto';
export function describeReadFailure({code,signal,stderr,index}){
 const bytes=Buffer.concat(stderr).subarray(0,65536),text=bytes.toString('utf8');
 const statusMatches=[...text.matchAll(/\(HTTP ([1-5][0-9]{2})\)/g)].map(x=>Number(x[1]));
 const httpStatus=statusMatches.length===1?statusMatches[0]:null;
 const markers=[
  ['API_RATE_LIMIT',/api rate limit exceeded|secondary rate limit/i],
  ['AUTHENTICATION',/bad credentials|authentication required|not logged into/i],
  ['TLS_CERTIFICATE',/certificate|x509|TLS handshake/i],
  ['NETWORK_TIMEOUT',/timed out|timeout|deadline exceeded/i],
  ['NETWORK_CONNECTION',/connection refused|connection reset|no such host|could not resolve/i]
 ].filter(([,pattern])=>pattern.test(text)).map(([label])=>label);
 return Object.freeze({kind:'PUBLIC_FIRST_IMMUTABLE_READ_FAILURE_V1',unique_ref_index:Number.isSafeInteger(index)&&index>=0&&index<128?index:null,exit_code:Number.isSafeInteger(code)?code:null,signal:['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGBREAK'].includes(signal)?signal:signal==null?null:'OTHER',stderr_bytes:bytes.length,stderr_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),reported_http_status:httpStatus,public_markers:markers,raw_output_disclosed:false});
}
export function captureFirstReadFailure(error,input){
 // The failed Error is shared with cancelled siblings: never overwrite its first source.
 if(!Object.hasOwn(error,'read_diagnostic')){
  const detail=describeReadFailure(input);
  Object.defineProperty(error,'read_diagnostic',{value:detail,enumerable:true});
  error.read_exit_code=detail.exit_code;error.read_signal=detail.signal;
 }
 return error;
}
