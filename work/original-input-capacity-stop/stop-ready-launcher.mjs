// External fixed STOP scheduling candidate. Never makes or refreshes a SQL observation.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../kernel-phase2-repo'),gaId=process.argv[2],folder=path.join(here,gaId+'.STOP.original-input-capacity-pipe600','stop-evidence');
const coordinator=path.join(here,'coordinate-stop.mjs'),coordinatorSHA='c03b1c38f95c34476fb66b358dfab74378b3b09e90d522559fa39c4a7347d1cb';
const inputFile=path.join(folder,'stop-input.json'),sha=b=>crypto.createHash('sha256').update(b).digest('hex'),need=(v,m)=>{if(!v)throw Error(m);};
export function validateStopNotice(line){
 need(typeof line==='string'&&Buffer.byteLength(line)>0&&Buffer.byteLength(line)<=4096&&!/[\r\n]/.test(line),'BOUNDED_SINGLE_NOTICE');
 const n=JSON.parse(line);need(n&&Object.keys(n).sort().join(',')==='bytes,input_file,sha256'&&n.input_file===inputFile&&Number.isSafeInteger(n.bytes)&&n.bytes>0&&n.bytes<=16777216&&/^[a-f0-9]{64}$/.test(n.sha256),'FIXED_STOP_INPUT_NOTICE');return n;
}
export const noticePath=inputFile;
function pinned(p,h,bytes){const b=fs.readFileSync(p);need(sha(b)===h&&(bytes===undefined||b.length===bytes),'EXACT_STOP_SOURCE_DRIFT:'+p);return b;}
function waitNotice(){return new Promise((resolve,reject)=>{let all=Buffer.alloc(0),done=false;const finish=(error,line)=>{if(done)return;done=true;clearTimeout(timer);process.stdin.pause();process.stdin.off('data',onData);process.stdin.off('end',onEnd);error?reject(error):resolve(line);};const onEnd=()=>finish(Error('MISSING_STOP_NOTICE'));
 const onData=chunk=>{try{need(all.length+chunk.length<=4097,'BOUNDED_NOTICE_BYTES');all=Buffer.concat([all,chunk]);const at=all.indexOf(10);if(at<0)return;need(at===all.length-1,'ONLY_ONE_STOP_NOTICE');finish(null,new TextDecoder('utf-8',{fatal:true}).decode(all.subarray(0,at)));}catch(e){finish(e);}};
 const remaining=Date.parse('2026-09-10T10:13:16Z')-Date.now();need(remaining>0,'ORIGINAL_OWNER_WINDOW');const timer=setTimeout(()=>finish(Error('OWNER_WINDOW_ENDED_WITHOUT_STOP_NOTICE')),remaining);process.stdin.on('data',onData);process.stdin.once('end',onEnd);
});}
async function main(){
 need(process.argv.length===3&&/^ga_[a-f0-9]{32}$/.test(gaId),'FIXED_LAUNCHER_ACTUAL_GA_ONLY');
 pinned(process.execPath,'3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237');pinned(coordinator,coordinatorSHA);
 const m=JSON.parse(pinned(path.join(repo,'scripts/phase2-qualification/control-context-verifier-original-input-capacity-successor/ControllerSourceManifest.candidate.json'),'07e0be02895363bac5ced923924f27b8de1f7951d8eea2c829831afef9bb27aa'));
 need(m.files.length===314,'EXACT_314_SOURCES');for(const f of m.files)pinned(path.isAbsolute(f.path)?f.path:path.join(repo,f.path),f.sha256,f.bytes);
 need(!fs.existsSync(path.join(folder,'stop-dispatch-once.json'))&&!fs.existsSync(path.join(folder,'stop-result.json')),'NO_PREVIOUS_STOP_DISPATCH');
 need(Date.now()>=Date.parse('2026-09-09T10:13:16Z')&&Date.now()<Date.parse('2026-09-10T10:13:16Z'),'APPROVED_FIXED_OWNER_WINDOW_BEFORE_READY');
 process.stdout.write(JSON.stringify({state:'FIXED_STOP_READY_AWAITING_EXACT_ACTUAL_STOP_SENT_INPUT',input_file:inputFile,coordinator_sha256:coordinatorSHA,sql_called:false,host_dispatched:false})+'\n');
 const notice=validateStopNotice(await waitNotice());
 for(let p=inputFile;;p=path.dirname(p)){need(!fs.lstatSync(p).isSymbolicLink(),'NO_LINKED_STOP_INPUT');if(p===here)break;}
 need(fs.statSync(inputFile).isFile(),'REGULAR_STOP_INPUT');pinned(inputFile,notice.sha256,notice.bytes);
 // The original coordinator re-reads this exact input and enforces the genuine
 // STOP_SENT event/current_context, 30s observation age, deadline and once ticket.
 // No new subprocess or tool approval is inserted between notice and STOP import.
 pinned(coordinator,coordinatorSHA);process.argv=[process.execPath,coordinator,'stop',gaId];await import(pathToFileURL(coordinator));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify({state:'STOP_READY_PATH_FAILED_PRESERVE_ORIGINAL_EVIDENCE',reason:e.message,automatic_retry:false}));process.exitCode=2;});
