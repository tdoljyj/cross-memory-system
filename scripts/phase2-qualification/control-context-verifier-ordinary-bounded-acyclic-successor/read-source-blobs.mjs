// Synchronous caller interface; only this invocation's immutable read batch crosses the pipe.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {isDeepStrictEqual as same} from 'node:util';
import {planRefs,validateBlob} from './ref-plan.mjs';
import {reportBatchFailure} from './public-diagnostic.mjs';
const node='C:/Program Files/nodejs/node.exe',nodeSHA='3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237';
const worker=path.join(fileURLToPath(new URL('./',import.meta.url)),'blob-worker.mjs'),workerSHA='4e0bd0cabb86374c523826925c424a7279c9aab09dd419426153afeb9442c148';
const planPath=path.join(fileURLToPath(new URL('./',import.meta.url)),'ref-plan.mjs'),planSHA='8f1d4f0f3033632d5a93e449495ebcda2774125ec2440abb1dd148da5d58ad63';
const powershell='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',powershellSHA='8bb6fa8c283b4d92120b1ef249a9b311b0f804d4cabbe9981159976c8be76a5e',launcher=path.join(fileURLToPath(new URL('./',import.meta.url)),'job-launcher.ps1'),launcherSHA='3f2333ac40db015cfffc83b1664048e63508a19ad4b9f70560d2db7434365639',jobSource=fileURLToPath(new URL('../control-context-verifier-parallel-source-successor/FixedJobLauncher.cs',import.meta.url)),jobSourceSHA='feef01a62576d2159e697c290be1a9b1e45f1432a65a1e17b8142afc80a1031c';
const prefix='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/',sha=x=>crypto.createHash('sha256').update(x).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
export function readSourceBlobRefsBounded(refs,sizes){
 planRefs(refs,sizes);
 need(sha(fs.readFileSync(node))===nodeSHA&&sha(fs.readFileSync(worker))===workerSHA&&sha(fs.readFileSync(planPath))===planSHA&&sha(fs.readFileSync(powershell))===powershellSHA&&sha(fs.readFileSync(launcher))===launcherSHA&&sha(fs.readFileSync(jobSource))===jobSourceSHA,'FIXED_BATCH_EXECUTOR_BYTES');
 const input=JSON.stringify({refs,expected_sizes:sizes})+'\n';need(Buffer.byteLength(input)<=65536,'BOUNDED_BATCH_REQUEST');
 const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',launcher],{input,encoding:'utf8',windowsHide:true,shell:false,timeout:135000,maxBuffer:33*1024*1024,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}});
 if(!(result.status===0&&result.signal===null&&!result.error))reportBatchFailure(result);
 need(result.status===0&&result.signal===null&&!result.error,'IMMUTABLE_BLOB_BATCH_FAILED');
 return validateBatchResponse(refs,sizes,JSON.parse(result.stdout));
}
export function validateBatchResponse(refs,sizes,value){
 planRefs(refs,sizes);need(value.state==='EXACT_IMMUTABLE_BLOB_BATCH_READ'&&same(value.refs,refs)&&same(value.expected_sizes,sizes)&&Array.isArray(value.blobs)&&value.blobs.length===refs.length,'EXACT_COMPLETE_ORDERED_BATCH');
 // Independently validate every returned original blob, rather than trusting worker success.
 for(let i=0;i<refs.length;i++)validateBlob(refs[i],value.blobs[i],sizes[i]);
 return {state:'ALL_FIXED_SOURCE_BLOBS_VERIFIED',count:refs.length,concurrency:4,cross_process_cache:false,authority_effect:'NONE'};
}
