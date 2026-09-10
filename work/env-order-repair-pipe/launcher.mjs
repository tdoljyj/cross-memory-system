import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import readline from 'node:readline';import {archiveAndSend} from './deliver.mjs';import {openStderrArchive} from './stderr-archive.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),work=path.resolve(dir,'..'),[ga,op,prewarmSHA,prewarmBytes]=process.argv.slice(2);
if(process.argv.length!==6||!/^ga_[a-f0-9]{32}$/.test(ga)||!['CREATE','START','GRR'].includes(op))throw Error('FIXED_GA_OPERATION_ONLY');
if(process.execPath.replaceAll('\\','/').toLowerCase()!=='c:/program files/nodejs/node.exe')throw Error('FIXED_NODE');
const prefix=path.join(work,'qualification-live',ga+'.'+op+'.env-order-repair-pipe600');fs.mkdirSync(prefix);
if(!/^[a-f0-9]{64}$/.test(prewarmSHA)||!/^[1-9][0-9]*$/.test(prewarmBytes)||Number(prewarmBytes)>4194304)throw Error('EXACT_PREWARM_NOTICE');
const staged=prefix+'.prewarm.staging.json',st=fs.lstatSync(staged);if(!st.isFile()||st.isSymbolicLink()||st.size!==Number(prewarmBytes))throw Error('EXACT_PREWARM_FILE');const prewarm=fs.readFileSync(staged);if(crypto.createHash('sha256').update(prewarm).digest('hex')!==prewarmSHA)throw Error('EXACT_PREWARM_HASH');
const archive=fs.openSync(path.join(prefix,'prewarm.json'),'wx');try{fs.writeFileSync(archive,prewarm);fs.fsyncSync(archive);}finally{fs.closeSync(archive);}
const fd=fs.openSync(prefix+'.stdout.raw','wx');
const stderrArchive=openStderrArchive(prefix+'.stderr.raw',{onReady:()=>process.stderr.write('NORMAL600_CONTEXT_READY\n'),onFailure:code=>fail(Error(code))});
const child=spawn(process.execPath,[path.join(dir,'ready-loader.mjs'),ga,op,prewarmSHA,prewarmBytes],{cwd:path.join(work,'kernel-phase2-repo'),stdio:['pipe',fd,'pipe'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''},windowsHide:true});
// Console carries only short fixed notices. Full actual messages never traverse it.
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});let sequence=1,failed=false,finished=false;
function fail(e){if(failed)return;failed=true;process.stderr.write('PIPE600_UNKNOWN '+String(e.message)+'\n');lines.close();child.stdin.destroy();child.kill();process.exitCode=1;}
child.stderr.on('data',b=>stderrArchive.consume(b));
child.stderr.once('error',()=>stderrArchive.abortRead());
lines.on('line',line=>{try{
 if(failed||finished||line.length>160)throw Error('NO_ADDITIONAL_INPUT');
 const notice=JSON.parse(line),delivered=sequence;
 archiveAndSend(prefix,notice,sequence,child.stdin,error=>{if(error)return fail(error);process.stderr.write(JSON.stringify({state:'PIPE600_BYTES_WRITTEN',sequence:delivered,bytes:notice.bytes,sha256:notice.sha256})+'\n');});sequence++;
 }catch(e){fail(e);}});
child.once('error',fail);child.once('close',(code,signal)=>{finished=true;try{stderrArchive.finish(code,signal);fs.fsyncSync(fd);}catch{fail(Error('STDERR_ARCHIVE_FINALIZATION_FAILED'));}finally{fs.closeSync(fd);lines.close();process.stdin.pause();}process.exitCode=!failed&&code===0&&signal===null?0:1;});
