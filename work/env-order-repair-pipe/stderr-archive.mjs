// Private local byte custody. Only fixed public labels leave this module; no authority decisions.
import fs from 'node:fs';import crypto from 'node:crypto';
export const STDERR_LIMIT=2097152;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),signals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGBREAK']),codes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','ENOMEM','EINVAL','EPIPE']);
const reasons=new Set(['IMMUTABLE_BLOB_BATCH_TIMEOUT','IMMUTABLE_BLOB_READ_TIMEOUT','IMMUTABLE_BLOB_RESPONSE_LIMIT','IMMUTABLE_BLOB_STDERR_LIMIT','IMMUTABLE_BLOB_READ_FAILED','GITHUB_CLI_BYTES_DRIFT','BATCH_ALREADY_FAILED','COMPLETE_ORDERED_BLOB_BATCH','GITHUB_BLOB_RESPONSE_AND_TREE_SIZE','GITHUB_BLOB_RAW_SHA','GITHUB_BLOB_ID','EXPANDED_IMMUTABLE_BLOB_RESPONSE_LIMIT','BOUNDED_BATCH_OUTPUT','FIXED_WORKER_INVOCATION','BOUNDED_BATCH_REQUEST','EXACT_BATCH_INPUT','BOUNDED_EXACT_REFS_AND_TREE_SIZES','EXACT_IMMUTABLE_REF_AND_SIZE','CONTRADICTORY_SAME_URI_HASH_OR_SIZE']);
const markers=new Set(['API_RATE_LIMIT','AUTHENTICATION','TLS_CERTIFICATE','NETWORK_TIMEOUT','NETWORK_CONNECTION']),number=x=>Number.isSafeInteger(x)&&x>=-2147483648&&x<=4294967295?x:null,label=(x,set)=>x==null?null:set.has(x)?x:'OTHER';
export function publicStderrSummary(bytes){
 const sample=bytes.subarray(0,65536);let failure=null;
 for(const line of sample.toString('utf8').split(/\r?\n/).slice(0,128)){
  if(Buffer.byteLength(line)>4096)continue;let x;try{x=JSON.parse(line);}catch{continue;}
  if(x?.kind!=='PUBLIC_IMMUTABLE_SOURCE_BATCH_FAILURE_DIAGNOSTIC_V1'||x.raw_output_disclosed!==false||x.authority_effect!=='NONE'||x.automatic_retry!==false)continue;
  const w=x.worker,d=w?.read_diagnostic;
  failure={kind:x.kind,status:number(x.status),signal:label(x.signal,signals),spawn_error_present:x.spawn_error_present===true,spawn_error_code:label(x.spawn_error_code,codes),worker:w?{reason:reasons.has(w.reason)?w.reason:'OTHER',exit_code:number(w.exit_code),signal:label(w.signal,signals),reported_http_status:Number.isSafeInteger(d?.reported_http_status)&&d.reported_http_status>=100&&d.reported_http_status<=599?d.reported_http_status:null,public_markers:Array.isArray(d?.public_markers)?[...new Set(d.public_markers.filter(x=>markers.has(x)))].slice(0,5):[]}:null};break;
 }
 return {public_batch_failure:failure,scan_bytes:sample.length,scan_truncated:bytes.length>sample.length,raw_output_disclosed:false};
}
export function openStderrArchive(file,{onReady,onFailure}){
 const fd=fs.openSync(file,'wx'),digest=crypto.createHash('sha256');let captured=0,observed=0,closed=false,failed=null,ready=false,line=Buffer.alloc(0),discardLine=false;
 const fail=code=>{if(!failed){failed=code;onFailure(code);}};
 function write(b){let off=0;while(off<b.length){const n=fs.writeSync(fd,b,off,b.length-off);if(n<=0)throw Error('ARCHIVE_ZERO_WRITE');digest.update(b.subarray(off,off+n));captured+=n;off+=n;}}
 return {
  abortRead(){fail('STDERR_PIPE_READ_FAILED');},
  consume(chunk){if(closed)throw Error('STDERR_ARCHIVE_CLOSED');const b=Buffer.from(chunk);observed+=b.length;if(failed)return;
   try{const room=STDERR_LIMIT-captured;write(b.subarray(0,room));if(b.length>room){fail('STDERR_ARCHIVE_LIMIT');return;}
    if(ready)return;
    // Bounded line recognition forwards only the exact readiness literal, never raw child text.
    for(const byte of b){if(byte===10){if(!discardLine&&line.equals(Buffer.from('NORMAL600_CONTEXT_READY'))&&!ready){fs.fsyncSync(fd);ready=true;onReady();}line=Buffer.alloc(0);discardLine=false;}else if(!discardLine){if(line.length>=4096){line=Buffer.alloc(0);discardLine=true;}else line=Buffer.concat([line,Buffer.from([byte])]);}}
   }catch{fail('STDERR_ARCHIVE_WRITE_FAILED');}
  },
  finish(code,signal){if(closed)throw Error('STDERR_ARCHIVE_ALREADY_CLOSED');closed=true;try{fs.fsyncSync(fd);}catch{fail('STDERR_ARCHIVE_SYNC_FAILED');}finally{try{fs.closeSync(fd);}catch{fail('STDERR_ARCHIVE_CLOSE_FAILED');}}
   const status={kind:'ACTUAL_LOCAL_CHILD_STDERR_ARCHIVE',path:file,captured_bytes:captured,observed_bytes:observed,sha256:digest.digest('hex'),stream_closed:true,capture_complete:failed===null,archive_failure:failed,child_exit_code:number(code),child_signal:label(signal,signals),raw_output_disclosed:false};
   try{const sf=fs.openSync(file+'.status.json','wx');try{fs.writeFileSync(sf,JSON.stringify(status)+'\n');fs.fsyncSync(sf);}finally{fs.closeSync(sf);}}catch{fail('STDERR_ARCHIVE_STATUS_FAILED');throw Error('STDERR_ARCHIVE_STATUS_FAILED');}return status;
  }
 };
}
export function describeStderrArchive(file){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>STDERR_LIMIT)throw Error('BOUNDED_STDERR_ARCHIVE_REQUIRED');
 const fd=fs.openSync(file,'r');let b;try{const s=fs.fstatSync(fd);if(s.size>STDERR_LIMIT)throw Error('BOUNDED_STDERR_ARCHIVE_REQUIRED');b=Buffer.alloc(s.size);let off=0;while(off<b.length){const n=fs.readSync(fd,b,off,b.length-off,off);if(n===0)throw Error('STDERR_ARCHIVE_TRUNCATED');off+=n;}}finally{fs.closeSync(fd);}
 const h=sha(b);let complete=false,status=null;if(fs.existsSync(file+'.status.json')){const sf=fs.openSync(file+'.status.json','r');let sb;try{const n=fs.fstatSync(sf).size;if(n>4096)throw Error('BOUNDED_STDERR_ARCHIVE_STATUS');sb=Buffer.alloc(n);if(fs.readSync(sf,sb,0,n,0)!==n)throw Error('STDERR_ARCHIVE_STATUS_TRUNCATED');}finally{fs.closeSync(sf);}const s=JSON.parse(sb);if(s.kind!=='ACTUAL_LOCAL_CHILD_STDERR_ARCHIVE'||s.path!==file||s.sha256!==h||s.captured_bytes!==b.length)throw Error('STDERR_ARCHIVE_STATUS_MISMATCH');complete=s.capture_complete===true&&s.stream_closed===true;status={stream_closed:s.stream_closed===true,capture_complete:complete,archive_failure:['STDERR_PIPE_READ_FAILED','STDERR_ARCHIVE_LIMIT','STDERR_ARCHIVE_WRITE_FAILED','STDERR_ARCHIVE_SYNC_FAILED','STDERR_ARCHIVE_CLOSE_FAILED','STDERR_ARCHIVE_STATUS_FAILED'].includes(s.archive_failure)?s.archive_failure:s.archive_failure==null?null:'OTHER',child_exit_code:number(s.child_exit_code),child_signal:label(s.child_signal,signals),observed_bytes:Number.isSafeInteger(s.observed_bytes)?s.observed_bytes:null};}
 return {kind:'LOCAL_STDERR_ARCHIVE_REFERENCE',path:file,bytes:b.length,sha256:h,capture_complete:complete,status,...publicStderrSummary(b)};
}
