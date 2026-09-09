// Candidate: bounded immutable blob reads only. No shared or persistent cache.
import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import path from 'node:path';
import {planRefs,validateBlob,checkExpandedBlobBytes} from './ref-plan.mjs';
import {captureFirstReadFailure} from './read-failure-diagnostic.mjs';
const gh='C:/Program Files/GitHub CLI/gh.exe',ghSHA='e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3';
const prefix='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/',hash=x=>crypto.createHash('sha256').update(x).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
export const limits=Object.freeze({concurrency:4,refs:128,request_bytes:65536,blob_response_bytes:32*1024*1024,aggregate_response_bytes:32*1024*1024,per_read_ms:10000,batch_ms:120000});
export async function fetchAll(refs,sizes){
 const plan=planRefs(refs,sizes),results=new Array(plan.unique.length),children=new Set();let next=0,failed=null,aggregate=0;
 const fail=error=>{if(!failed){failed=error;for(const child of children)child.kill();}};
 const totalTimer=setTimeout(()=>fail(Error('IMMUTABLE_BLOB_BATCH_TIMEOUT')),limits.batch_ms);
 async function fetchOne(ref,size,index){
  need(!failed,'BATCH_ALREADY_FAILED');need(hash(fs.readFileSync(gh))===ghSHA,'GITHUB_CLI_BYTES_DRIFT');
  return await new Promise((resolve,reject)=>{
   const child=spawn(gh,['api','--hostname','github.com','repos/tdoljyj/cross-memory-system/git/blobs/'+ref.uri.slice(prefix.length)],{stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});children.add(child);
   let stdout=[],stderr=[],outBytes=0,errBytes=0,localError=null;
   const abort=e=>{localError??=e;fail(e);child.kill();};
   const timer=setTimeout(()=>abort(Error('IMMUTABLE_BLOB_READ_TIMEOUT')),limits.per_read_ms);
   child.stdout.on('data',b=>{outBytes+=b.length;aggregate+=b.length;if(outBytes>limits.blob_response_bytes||aggregate>limits.aggregate_response_bytes)return abort(Error('IMMUTABLE_BLOB_RESPONSE_LIMIT'));stdout.push(b);});
   child.stderr.on('data',b=>{errBytes+=b.length;if(errBytes>65536)return abort(Error('IMMUTABLE_BLOB_STDERR_LIMIT'));stderr.push(b);});
   child.once('error',abort);
   child.once('close',(code,signal)=>{clearTimeout(timer);children.delete(child);if(localError||failed||code!==0||signal!==null){const error=localError||failed||Error('IMMUTABLE_BLOB_READ_FAILED');if(localError||!failed)captureFirstReadFailure(error,{code,signal,stderr,index});return reject(error);}try{const blob=JSON.parse(Buffer.concat(stdout).toString('utf8'));validateBlob(ref,blob,size);resolve(blob);}catch(e){fail(e);reject(e);}});
  });
 }
 async function run(){while(!failed){const index=next++;if(index>=plan.unique.length)return;try{const item=plan.unique[index];results[index]=await fetchOne(item.ref,item.size,index);}catch(e){fail(e);return;}}}
 try{await Promise.all(Array.from({length:Math.min(limits.concurrency,plan.unique.length)},run));if(failed)throw failed;need(results.every(Boolean),'COMPLETE_ORDERED_BLOB_BATCH');const ordered=plan.indices.map(i=>results[i]);checkExpandedBlobBytes(ordered);for(let i=0;i<refs.length;i++)validateBlob(refs[i],ordered[i],sizes[i]);return ordered;}finally{clearTimeout(totalTimer);for(const child of children)child.kill();}
}
async function main(){
 need(process.execPath.replaceAll('\\','/').toLowerCase()==='c:/program files/nodejs/node.exe'&&process.argv.length===2,'FIXED_WORKER_INVOCATION');
 const chunks=[];let length=0;for await(const b of process.stdin){length+=b.length;need(length<=limits.request_bytes,'BOUNDED_BATCH_REQUEST');chunks.push(b);}const input=Buffer.concat(chunks).toString('utf8'),request=JSON.parse(input);need(Object.keys(request).sort().join(',')==='expected_sizes,refs'&&JSON.stringify(request)+'\n'===input,'EXACT_BATCH_INPUT');const refs=request.refs,sizes=request.expected_sizes,blobs=await fetchAll(refs,sizes);
 const output=JSON.stringify({state:'EXACT_IMMUTABLE_BLOB_BATCH_READ',refs,expected_sizes:sizes,blobs})+'\n';need(Buffer.byteLength(output)<=limits.aggregate_response_bytes+limits.request_bytes,'BOUNDED_BATCH_OUTPUT');process.stdout.write(output);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(JSON.stringify({state:'BLOCKED_IMMUTABLE_BLOB_BATCH',reason:error.message,exit_code:error.read_exit_code??null,signal:error.read_signal??null,read_diagnostic:error.read_diagnostic??null,authority_effect:'NONE',automatic_retry:false})+'\n');process.exitCode=1;});
