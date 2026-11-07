// Source v2 port of protected-job-bridge-v3/relay-record.mjs: protocol v4 (no currentClaim binding: the claim
// generation is inside the issue's admission facts), one more export (--export-blocked), qualification v2.
// bf57ff10 P2 C (2026-11-07): the CONTEXT stage loads the relay context (boundary.mjs#loadLinuxRelayContext: every role
// policy, Source manifest and qualification check of loadLinuxContext, without re-hashing the pinned Source files or
// asking Git, about 1 s per call). This relay only moves public bytes; the Linux worker re-verifies the Source in full
// when it starts and in every callback before it adopts a response or signs.
// Fixed Linux half of the accepted Owner-operated public relay. Does not run a
// job, read a private key, contact an API or treat a packet digest as authority.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical} from '../../src/proof.mjs';
import {protectedPath} from '../qualification-v2.mjs';
import {loadLinuxRelayContext} from './boundary.mjs';
import {readFixedIssueJob} from './issue-job.mjs';
import {LINUX_ROOT} from './mailbox.mjs';
import {MAX_BYTES,validateIssue,validateResponse,decode,digest} from './protocol.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);},hash=b=>createHash('sha256').update(b).digest('hex');
export function operation(argv){check(argv.length>=1&&argv.length<=2&&['--import-issue','--import-response','--export-challenge','--export-result','--export-blocked'].includes(argv[0]),'FIXED_FORMAL_RELAY_OPERATION_REQUIRED');
  const seq=argv.length===2?Number(argv[1]):0,sequenced=['--import-response','--export-challenge'].includes(argv[0]);check(sequenced?argv.length===2&&/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(argv[1]):argv.length===1,'FIXED_FORMAL_RELAY_SEQUENCE_REQUIRED');
  return{importing:argv[0].startsWith('--import'),kind:argv[0],sequence:seq};}
export function encodeTransport(raw){check(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=MAX_BYTES,'FORMAL_RELAY_BYTES_BOUND');return{bytes:raw.length,sha256:hash(raw),base64:raw.toString('base64')};}
export function decodeTransport(raw){check(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=1399000,'FORMAL_RELAY_TRANSPORT_BOUND');let v;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);check(!text.startsWith('\ufeff')&&!raw.subarray(0,3).equals(Buffer.from([239,187,191])),'FORMAL_RELAY_TRANSPORT_JSON');v=JSON.parse(text);check(JSON.stringify(v)===text,'FORMAL_RELAY_TRANSPORT_JSON');}catch{fail('FORMAL_RELAY_TRANSPORT_JSON');}
  check(v&&Object.keys(v).sort().join('|')==='base64|bytes|sha256'&&Number.isSafeInteger(v.bytes)&&v.bytes>0&&v.bytes<=MAX_BYTES&&/^[a-f0-9]{64}$/.test(v.sha256??'')&&typeof v.base64==='string'&&v.base64.length<=Math.ceil(MAX_BYTES/3)*4,'FORMAL_RELAY_TRANSPORT_BOUND');const bytes=Buffer.from(v.base64,'base64');check(bytes.toString('base64')===v.base64&&bytes.length===v.bytes&&hash(bytes)===v.sha256,'FORMAL_RELAY_TRANSPORT_CHANGED');return bytes;}
async function readRecord(folder,name){const file=path.join(LINUX_ROOT,folder,name+'.json'),ready=path.join(LINUX_ROOT,folder,name+'.ready.json');for(const f of [file,ready])await protectedPath(f);
  const read=async f=>{const h=await fsp.open(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=await h.stat();check(a.isFile()&&a.uid===0&&a.nlink===1&&a.size>0&&a.size<=MAX_BYTES,'FORMAL_RELAY_FILE_BOUND');const b=await h.readFile(),z=await h.stat(),named=await fsp.lstat(f);check(b.length===a.size&&[z,named].every(s=>s.dev===a.dev&&s.ino===a.ino&&s.size===a.size&&s.mtimeMs===a.mtimeMs&&s.nlink===1&&!s.isSymbolicLink()),'FORMAL_RELAY_FILE_CHANGED');return b;}finally{await h.close();}};
  const marker=await read(ready),r=JSON.parse(marker.toString('utf8')),bytes=await read(file);check(canonical(r)===marker.toString('utf8')&&Object.keys(r).sort().join('|')==='bytes|contract|sha256'&&r.contract==='clued.independent-ci.complete-public-file/1'&&r.bytes===bytes.length&&r.sha256===hash(bytes),'FORMAL_RELAY_READY_CHANGED');return bytes;}
async function writeRecord(name,raw){const dir=path.join(LINUX_ROOT,'incoming');await protectedPath(dir,{directory:true});for(const[file,b]of [[name+'.json',raw],[name+'.ready.json',Buffer.from(canonical({contract:'clued.independent-ci.complete-public-file/1',bytes:raw.length,sha256:hash(raw)}))]]){const h=await fsp.open(path.join(dir,file),'wx',0o600);try{await h.writeFile(b);await h.sync();}finally{await h.close();}}const h=await fsp.open(dir,'r');try{await h.sync();}finally{await h.close();}}
async function stdin(){const parts=[];let size=0;const timer=setTimeout(()=>process.stdin.destroy(Object.assign(new Error('FORMAL_RELAY_STDIN_TIMEOUT'),{code:'FORMAL_RELAY_STDIN_TIMEOUT'})),5000);try{for await(const b of process.stdin){size+=b.length;check(size<=1399000,'FORMAL_RELAY_TRANSPORT_BOUND');parts.push(b);}return Buffer.concat(parts);}finally{clearTimeout(timer);}}
// The issue a relay imports must name the role, Source manifest and acceptance refs of the relay context. Pure.
export function issueBinding(packet,context){validateIssue(packet);check(packet.job.role===context.role&&packet.job.sourceManifestSha256===context.config.sourceManifestSha256&&packet.sourceAcceptanceRef===context.sourceAcceptanceRef&&packet.hostQualificationRef===context.hostQualificationRef,'FORMAL_RELAY_ISSUER_CONTEXT_CHANGED');return packet;}
let stage='OPERATION';
export async function relayRecord(argv){stage='OPERATION';const op=operation(argv);
  if(op.importing){stage='STDIN';const input=await stdin();stage='TRANSPORT';const raw=decodeTransport(input);stage='PACKET';const packet=decode(raw);stage='CONTEXT';const context=await loadLinuxRelayContext(op.kind==='--import-issue'?validateIssue(packet).job:await readFixedIssueJob());stage='BINDING';
    if(op.kind==='--import-issue'){issueBinding(packet,context);await writeRecord('issue',raw);}
    else{const issue=validateIssue(decode(await readRecord('incoming','issue'))),challenge=decode(await readRecord('outgoing','challenge-'+String(op.sequence).padStart(2,'0')));validateResponse(issue,challenge,packet);check(packet.sequence===op.sequence,'FORMAL_RELAY_SEQUENCE_CHANGED');await writeRecord('response-'+String(op.sequence).padStart(2,'0'),raw);}
    stage='COMPLETE';return{status:'FORMAL_PUBLIC_RECORD_IMPORTED',bytes:raw.length,sha256:hash(raw),taskStarted:false,qualificationIssued:false};}
  stage='CONTEXT';await loadLinuxRelayContext(await readFixedIssueJob());stage='RECORD';const name=op.kind==='--export-result'?'result':op.kind==='--export-blocked'?'blocked':'challenge-'+String(op.sequence).padStart(2,'0');const result=encodeTransport(await readRecord('outgoing',name));stage='COMPLETE';return result;
}
export async function main(argv=process.argv.slice(2)){
  try{console.log(JSON.stringify(await relayRecord(argv)));return 0;}catch(e){console.error(JSON.stringify({status:'BLOCKED',reason:/^[A-Z_]+$/.test(e.code??'')?e.code:'FORMAL_RELAY_UNCONFIRMED',stage,taskStarted:false,qualificationIssued:false}));return 2;}}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
