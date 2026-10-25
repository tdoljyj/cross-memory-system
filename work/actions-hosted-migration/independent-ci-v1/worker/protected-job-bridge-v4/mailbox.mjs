// Source v2 port of protected-job-bridge-v3/mailbox.mjs: relay descriptor /2, a fixed 'blocked' record name,
// the v4 ACL helper and the v2 protectedPath. Everything else unchanged.
// Fixed public OS mailboxes. A ready hash proves complete bytes, not their
// authority. Production also requires the accepted protected relay descriptor.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {canonical} from '../../src/proof.mjs';
import {hash as profileHash,validateNodeProfile} from '../../src/resident-v2/prepare-record.mjs';
import {protectedPath} from '../qualification-v2.mjs';
import {takeAcceptedBridgeContext} from './boundary.mjs';
export const WINDOWS_ROOT='C:\\ProgramData\\CluedIndependentCI\\formal-spool';
export const LINUX_ROOT='/var/lib/clued-independent-ci/formal-spool';
const MAX=1048576,actual=new WeakSet(),fixture=new WeakSet(),fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,c)=>{if(!v)fail(c);};
const hash=b=>createHash('sha256').update(b).digest('hex');
const names=n=>n==='issue'||n==='result'||n==='blocked'||/^(challenge|response)-(0[1-9]|[12][0-9]|3[0-2])$/.test(n);
export function validateRelayDescriptor(d,context){
  // Relay /2 (resident-v2/prepare-record.mjs): the companion moves the records; the Windows writer is the
  // controller account exactly as before, enforced by formal-spool-acl.ps1 rather than named here.
  const keys=['contract','mode','windowsRoot','linuxRoot','linuxWriterUid','ownerBoundary','sourceAcceptanceRef','hostQualificationRef'];
  check(d&&Object.keys(d).sort().join('|')===keys.sort().join('|')&&d.contract==='clued.independent-ci.protected-os-relay/2'&&d.mode==='resident-companion-file-transfer'&&
    d.windowsRoot===WINDOWS_ROOT&&d.linuxRoot===LINUX_ROOT&&d.linuxWriterUid===0&&
    d.ownerBoundary==='owner-wsl-administrator'&&d.sourceAcceptanceRef===context?.sourceAcceptanceRef&&d.hostQualificationRef===context?.hostQualificationRef,
    'ACCEPTED_FORMAL_RELAY_MISSING');return d;
}
async function safeFile(file,root,{windows=false,fixtureOnly=false,nodeProfileSha256=null}={}){
  // Absence is a normal bounded wait. Do not turn a not-yet-created ready
  // marker into a generic PowerShell ACL refusal before observing ENOENT.
  await fsp.lstat(file);
  if(!fixtureOnly){if(windows){await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./formal-spool-acl.ps1',import.meta.url)),'-LiteralTarget',file,'-ProtectedRoot',root,'-AllowControllerWrite','-ExpectedNodeProfileSha256',nodeProfileSha256],{windowsHide:true,timeout:10000,maxBuffer:4096});}
    else await protectedPath(file);}
  const h=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{const before=await h.stat();check(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=MAX,'FORMAL_MAILBOX_FILE_BOUNDARY');
    const raw=await h.readFile(),after=await h.stat(),named=await fsp.lstat(file);
    check([after,named].every(s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs)&&raw.length===before.size,'FORMAL_MAILBOX_CHANGED');return raw;
  }finally{await h.close();}
}
async function exclusive(file,bytes){const h=await fsp.open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
async function openFixed({side,root,fixtureOnly=false,nodeProfileSha256=null}){
  const windows=side==='windows';check(['windows','linux'].includes(side),'FORMAL_MAILBOX_SIDE_REQUIRED');
  if(windows&&!fixtureOnly)check(/^[a-f0-9]{64}$/.test(nodeProfileSha256??''),'FORMAL_MAILBOX_NODE_PROFILE_REQUIRED');
  if(!fixtureOnly){check(windows?process.platform==='win32':process.platform==='linux'&&process.getuid?.()===0,'FORMAL_MAILBOX_PRINCIPAL_REQUIRED');
    if(windows){await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./formal-spool-acl.ps1',import.meta.url)),'-LiteralTarget',root,'-ProtectedRoot',root,'-AllowControllerWrite','-ExpectedNodeProfileSha256',nodeProfileSha256],{windowsHide:true,timeout:10000,maxBuffer:4096});}
    else for(const dir of [root,path.join(root,'incoming'),path.join(root,'outgoing')])await protectedPath(dir,{directory:true});}
  const box=Object.freeze({side,fixture:fixtureOnly,
    async lock(){await exclusive(path.join(root,'outgoing','active.lock'),Buffer.from(canonical({contract:'clued.independent-ci.formal-bridge-lock/2',pid:process.pid,automaticRetryAllowed:false})));},
    async write(name,bytes){check(names(name)&&Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX,'FORMAL_MAILBOX_FIXED_WRITE_REQUIRED');
      const file=path.join(root,'outgoing',name+'.json'),ready=path.join(root,'outgoing',name+'.ready.json');
      await exclusive(file,bytes);await exclusive(ready,Buffer.from(canonical({contract:'clued.independent-ci.complete-public-file/1',bytes:bytes.length,sha256:hash(bytes)})));
      if(process.platform==='linux'){const h=await fsp.open(path.dirname(file),'r');try{await h.sync();}finally{await h.close();}}
      return{bytes:bytes.length,sha256:hash(bytes)};
    },
    async read(name){check(names(name),'FORMAL_MAILBOX_FIXED_READ_REQUIRED');const ready=await safeFile(path.join(root,'incoming',name+'.ready.json'),root,{windows,fixtureOnly,nodeProfileSha256}),r=JSON.parse(ready.toString('utf8'));
      check(canonical(r)===ready.toString('utf8')&&Object.keys(r).sort().join('|')==='bytes|contract|sha256'&&r.contract==='clued.independent-ci.complete-public-file/1'&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=MAX&&/^[a-f0-9]{64}$/.test(r.sha256??''),'FORMAL_MAILBOX_READY_REQUIRED');
      const bytes=await safeFile(path.join(root,'incoming',name+'.json'),root,{windows,fixtureOnly,nodeProfileSha256});check(bytes.length===r.bytes&&hash(bytes)===r.sha256,'FORMAL_MAILBOX_PACKET_CHANGED');return bytes;
    },
    async wait(name,{deadline,signal}={}){check(Number.isFinite(deadline),'FORMAL_MAILBOX_DEADLINE_REQUIRED');while(true){check(!signal?.aborted&&Date.now()<deadline,'FORMAL_MAILBOX_WAIT_UNCONFIRMED');try{return await box.read(name);}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(resolve=>setTimeout(resolve,100));}}
  });(fixtureOnly?fixture:actual).add(box);return box;
}
export async function openAcceptedMailbox(context){takeAcceptedBridgeContext(context);validateRelayDescriptor(context.descriptor,context);const nodeProfileSha256=context.side==='windows'?profileHash(validateNodeProfile(context.accepted.node)):null;return openFixed({side:context.side,root:context.side==='windows'?WINDOWS_ROOT:LINUX_ROOT,nodeProfileSha256});}
export function takeActualMailbox(box){check(actual.has(box)&&!fixture.has(box),'ACTUAL_ACCEPTED_FORMAL_MAILBOX_REQUIRED');return box;}
// Actual disk tests use disposable work directories and cannot get the actual
// mailbox brand or enter a production Linux adapter.
export function createFixtureMailbox(directory,side='linux'){return openFixed({side,root:directory,fixtureOnly:true});}
