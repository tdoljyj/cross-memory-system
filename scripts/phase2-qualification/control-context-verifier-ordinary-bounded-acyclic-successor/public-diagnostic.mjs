// Public fixed labels only. Raw stderr, stdout and error messages are never emitted.
import crypto from 'node:crypto';
import fs from 'node:fs';
const reasons=new Set(['IMMUTABLE_BLOB_BATCH_TIMEOUT','IMMUTABLE_BLOB_READ_TIMEOUT','IMMUTABLE_BLOB_RESPONSE_LIMIT','IMMUTABLE_BLOB_STDERR_LIMIT','IMMUTABLE_BLOB_READ_FAILED','GITHUB_CLI_BYTES_DRIFT','BATCH_ALREADY_FAILED','COMPLETE_ORDERED_BLOB_BATCH','GITHUB_BLOB_RESPONSE_AND_TREE_SIZE','GITHUB_BLOB_RAW_SHA','GITHUB_BLOB_ID','EXPANDED_IMMUTABLE_BLOB_RESPONSE_LIMIT','BOUNDED_BATCH_OUTPUT','FIXED_WORKER_INVOCATION','BOUNDED_BATCH_REQUEST','EXACT_BATCH_INPUT','BOUNDED_EXACT_REFS_AND_TREE_SIZES','EXACT_IMMUTABLE_REF_AND_SIZE','CONTRADICTORY_SAME_URI_HASH_OR_SIZE']);
const signals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGBREAK']),codes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','ENOMEM','EINVAL','EPIPE']);
const integer=x=>Number.isSafeInteger(x)&&x>=-2147483648&&x<=4294967295?x:null,label=(x,set)=>x==null?null:set.has(x)?x:'OTHER',buffer=x=>Buffer.isBuffer(x)?x:Buffer.from(typeof x==='string'?x:'','utf8');
export function publicBatchDiagnostic(result){
 const stderr=buffer(result.stderr),stdout=buffer(result.stdout),sample=stderr.subarray(0,65536).toString('utf8');
 let worker=null;for(const line of sample.split(/\r?\n/).slice(0,128)){
  if(Buffer.byteLength(line)>4096)continue;let x;try{x=JSON.parse(line);}catch{continue;}
  if(!x||x.state!=='BLOCKED_IMMUTABLE_BLOB_BATCH')continue;
  worker={reason:reasons.has(x.reason)?x.reason:'OTHER',exit_code:integer(x.exit_code),signal:label(x.signal,signals),read_diagnostic:publicFirstReadDiagnostic(x.read_diagnostic)};break;
 }
 const markers=['FIXED_JOB_LAUNCHER_NO_ARGUMENTS','FIXED_JOB_WORKER_SOURCE_DRIFT','JOB_SUBTREE_TERMINATION_NOT_CONFIRMED','System.ComponentModel.Win32Exception','System.InvalidOperationException','CommandNotFoundException','UnauthorizedAccessException'].filter(x=>sample.includes(x));
 return {kind:'PUBLIC_IMMUTABLE_SOURCE_BATCH_FAILURE_DIAGNOSTIC_V1',status:integer(result.status),signal:label(result.signal,signals),spawn_error_present:Boolean(result.error),spawn_error_code:label(result.error?.code,codes),stdout_bytes:stdout.length,stderr_bytes:stderr.length,stderr_sha256:crypto.createHash('sha256').update(stderr).digest('hex'),stderr_scan_bytes:Math.min(stderr.length,65536),stderr_scan_truncated:stderr.length>65536,worker,public_launcher_markers:markers,raw_output_disclosed:false,authority_effect:'NONE',automatic_retry:false};
}
export function reportBatchFailure(result){
 // Diagnostics must not replace the original failure even if the destination stderr is closed.
 try{fs.writeSync(2,JSON.stringify(publicBatchDiagnostic(result))+'\n');}catch{}
}

// Reconstruct only the reviewed public first-failure schema; never forward caller objects.
const readMarkers=new Set(['API_RATE_LIMIT','AUTHENTICATION','TLS_CERTIFICATE','NETWORK_TIMEOUT','NETWORK_CONNECTION']);
export function publicFirstReadDiagnostic(x){
 if(!x||x.kind!=='PUBLIC_FIRST_IMMUTABLE_READ_FAILURE_V1'||x.raw_output_disclosed!==false)return null;
 if(!(x.unique_ref_index===null||(Number.isSafeInteger(x.unique_ref_index)&&x.unique_ref_index>=0&&x.unique_ref_index<128))||!(x.exit_code===null||integer(x.exit_code)===x.exit_code)||!(x.signal===null||signals.has(x.signal)||x.signal==='OTHER'))return null;
 if(!Number.isSafeInteger(x.stderr_bytes)||x.stderr_bytes<0||x.stderr_bytes>65536||typeof x.stderr_sha256!=='string'||!/^[a-f0-9]{64}$/.test(x.stderr_sha256))return null;
 if(!(x.reported_http_status===null||(Number.isSafeInteger(x.reported_http_status)&&x.reported_http_status>=100&&x.reported_http_status<=599)))return null;
 if(!Array.isArray(x.public_markers)||x.public_markers.length>5||new Set(x.public_markers).size!==x.public_markers.length||!x.public_markers.every(m=>readMarkers.has(m)))return null;
 return {kind:x.kind,unique_ref_index:x.unique_ref_index,exit_code:x.exit_code,signal:x.signal,stderr_bytes:x.stderr_bytes,stderr_sha256:x.stderr_sha256,reported_http_status:x.reported_http_status,public_markers:[...x.public_markers],raw_output_disclosed:false};
}
