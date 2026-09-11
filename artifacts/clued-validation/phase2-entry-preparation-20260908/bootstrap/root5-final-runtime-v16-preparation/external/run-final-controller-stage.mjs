import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';

if (process.stdin.isTTY) process.stdin.setRawMode(true);

const operation=process.argv[2];
if(!['CREATE','START','GRR'].includes(operation))throw Error('operation required');
const runDir=process.argv[3];
if(!runDir||!path.isAbsolute(runDir)||!runDir.replaceAll('\\','/').endsWith('/final-run-root5-v16-20260911'))throw Error('exact new run directory required');
const basePath=path.join(runDir,'Material.CREATE.json');
const cli='C:/Users/Windows/Documents/Codex/2026-09-10/kernel-phase2-final-admin/scripts/phase2-qualification/control-context-verifier-root5-window5-forward11-successor/cli.mjs';
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
const iterator=input[Symbol.asyncIterator]();
const next=async()=>{const item=await iterator.next();if(item.done)throw Error('stage input ended');if(Buffer.byteLength(item.value)>4096)throw Error('bounded input notice required');const notice=JSON.parse(item.value);if(Object.keys(notice).join(',')!=='input_file'||typeof notice.input_file!=='string')throw Error('bounded file notice required');const file=path.resolve(notice.input_file);if(path.dirname(file)!==path.resolve(runDir))throw Error('exact run input file required');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8388608)throw Error('bounded regular input file required');return JSON.parse(fs.readFileSync(file,'utf8'));};
process.stdout.write(JSON.stringify({state:'READY_FOR_FIXED_INPUT_FILE_NOTICE',operation})+'\n');
const first=await next();
if(first.kind!=='PREFLIGHT'||!first.observation)throw Error('fresh preflight required');
const repo=path.resolve(path.dirname(cli),'../../..'),manifestFile=path.join(path.dirname(cli),'ControllerSourceManifest.candidate.json');
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex'),manifestRaw=fs.readFileSync(manifestFile);
if(hash(manifestRaw)!==first.observation.row?.execution?.binding?.controller_sha256)throw Error('ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT');
for(const entry of JSON.parse(manifestRaw).files){const bytes=fs.readFileSync(path.isAbsolute(entry.path)?entry.path:path.join(repo,entry.path));if(bytes.length!==entry.bytes||hash(bytes)!==entry.sha256)throw Error('EXACT_CONTROLLER_SOURCE_BYTES_DRIFT');}
const material=JSON.parse(fs.readFileSync(basePath,'utf8'));
material.operation=operation;
material.observation=first.observation;
if(operation==='GRR'){
  if(typeof first.grr_raw!=='string'||!first.result_materials)throw Error('terminal materials required');
  material.grr_raw=first.grr_raw;
  Object.assign(material,first.result_materials);
}
fs.writeFileSync(path.join(runDir,`Material.${operation}.actual.json`),JSON.stringify(material)+'\n');
const child=spawn(process.execPath,[cli],{stdio:['pipe','pipe','inherit'],env:process.env});
const childExit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
const childLines=readline.createInterface({input:child.stdout,crlfDelay:Infinity,terminal:false});
const childIterator=childLines[Symbol.asyncIterator]();
child.stdin.write(JSON.stringify(material)+'\n');
const initial=await childIterator.next();
if(initial.done)throw Error('controller exited before challenge');
process.stdout.write(initial.value+'\n');
const initialMessage=JSON.parse(initial.value),expectedChallenge=operation==='GRR'?'NEED_FRESH_RESULT_CONTEXT':'NEED_COMMITTED_DISPATCH';
if(initialMessage.state!==expectedChallenge){
 fs.writeFileSync(path.join(runDir,`${operation}.ControllerResult.json`),initial.value+'\n',{flag:'wx'});
 child.stdin.end();input.close();process.stdin.pause();
 const failedExit=await childExit;
 process.exit(failedExit||1);
}
const second=await next();
fs.writeFileSync(path.join(runDir,`${operation}.Fresh.json`),JSON.stringify(second)+'\n');
child.stdin.write(JSON.stringify(second)+'\n');
child.stdin.end();
const terminal=await childIterator.next();
if(terminal.done)throw Error('controller exited before result');
fs.writeFileSync(path.join(runDir,`${operation}.ControllerResult.json`),terminal.value+'\n');
process.stdout.write(terminal.value+'\n');
const exitCode=await childExit;
process.exitCode=exitCode??1;
