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
const POWERSHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
// bf57ff10 P2 B (2026-11-07): the arguments of one formal-spool-acl.ps1 call for 1..8 spool paths, joined by '|' (no
// Windows path contains it). The helper checks each path exactly as a lone target and exits non-zero when any one is
// refused, so one call passes exactly when every per-path call would have passed.
export function spoolAclArgs(targets,root,nodeProfileSha256){
  check(Array.isArray(targets)&&targets.length>=1&&targets.length<=8&&targets.every(t=>typeof t==='string'&&t.length>0&&!t.includes('|')),'FORMAL_MAILBOX_ACL_TARGETS_REQUIRED');
  return['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./formal-spool-acl.ps1',import.meta.url)),'-LiteralTarget',targets.join('|'),'-ProtectedRoot',root,'-AllowControllerWrite','-ExpectedNodeProfileSha256',nodeProfileSha256];
}
const runAcl=args=>promisify(execFile)(POWERSHELL,args,{windowsHide:true,timeout:10000,maxBuffer:4096});
// The per-file guard of a read: the Windows ACL helper (one call for all of `files`), or on Linux protectedPath per file.
async function guard(files,root,{windows=false,fixtureOnly=false,nodeProfileSha256=null,acl=null}={}){
  if(acl){await acl(spoolAclArgs(files,root,nodeProfileSha256));return;}
  if(!fixtureOnly){if(windows)await runAcl(spoolAclArgs(files,root,nodeProfileSha256));
    else for(const file of files)await protectedPath(file);}
}
async function safeFile(file,root,options={}){
  // Absence is a normal bounded wait. Do not turn a not-yet-created ready
  // marker into a generic PowerShell ACL refusal before observing ENOENT.
  await fsp.lstat(file);
  await guard([file],root,options);
  return stableRead(file,{pendingReady:options.pendingReady===true});
}
// The bytes of one guarded file, read through one handle that must stay the same file throughout.
async function stableRead(file,{pendingReady=false}={}){
  const h=await fsp.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{const before=await h.stat();check(before.isFile()&&before.nlink===1&&(before.size>0||(pendingReady&&before.size===0))&&before.size<=MAX,'FORMAL_MAILBOX_FILE_BOUNDARY');
    // exclusive() creates the ready inode before writing its bytes. While it is empty nothing is committed: wait for
    // this same create-only marker, never read the data or reissue a packet. Keep ACL, regular-file, link and named-inode
    // checks even for that wait. Data files and every nonempty marker retain the original strict byte/change checks.
    if(pendingReady&&before.size===0){const named=await fsp.lstat(file);check(named.isFile()&&!named.isSymbolicLink()&&named.nlink===1&&named.dev===before.dev&&named.ino===before.ino,'FORMAL_MAILBOX_CHANGED');fail('ENOENT');}
    const raw=await h.readFile(),after=await h.stat(),named=await fsp.lstat(file);
    check([after,named].every(s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs)&&raw.length===before.size,'FORMAL_MAILBOX_CHANGED');return raw;
  }finally{await h.close();}
}
async function exclusive(file,bytes){const h=await fsp.open(file,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}}
async function openFixed({side,root,fixtureOnly=false,nodeProfileSha256=null,acl=null}){
  const windows=side==='windows';check(['windows','linux'].includes(side),'FORMAL_MAILBOX_SIDE_REQUIRED');
  check(acl===null||(fixtureOnly&&windows&&typeof acl==='function'),'FORMAL_MAILBOX_ACL_PROBE_FIXTURE_ONLY');
  if(windows&&!fixtureOnly)check(/^[a-f0-9]{64}$/.test(nodeProfileSha256??''),'FORMAL_MAILBOX_NODE_PROFILE_REQUIRED');
  if(!fixtureOnly){check(windows?process.platform==='win32':process.platform==='linux'&&process.getuid?.()===0,'FORMAL_MAILBOX_PRINCIPAL_REQUIRED');
    if(windows)await runAcl(spoolAclArgs([root],root,nodeProfileSha256));
    else for(const dir of [root,path.join(root,'incoming'),path.join(root,'outgoing')])await protectedPath(dir,{directory:true});}
  if(acl)await acl(spoolAclArgs([root],root,nodeProfileSha256));
  const box=Object.freeze({side,fixture:fixtureOnly,
    async lock(){await exclusive(path.join(root,'outgoing','active.lock'),Buffer.from(canonical({contract:'clued.independent-ci.formal-bridge-lock/2',pid:process.pid,automaticRetryAllowed:false})));},
    async write(name,bytes){check(names(name)&&Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX,'FORMAL_MAILBOX_FIXED_WRITE_REQUIRED');
      const file=path.join(root,'outgoing',name+'.json'),ready=path.join(root,'outgoing',name+'.ready.json');
      await exclusive(file,bytes);await exclusive(ready,Buffer.from(canonical({contract:'clued.independent-ci.complete-public-file/1',bytes:bytes.length,sha256:hash(bytes)})));
      if(process.platform==='linux'){const h=await fsp.open(path.dirname(file),'r');try{await h.sync();}finally{await h.close();}}
      return{bytes:bytes.length,sha256:hash(bytes)};
    },
    async read(name){check(names(name),'FORMAL_MAILBOX_FIXED_READ_REQUIRED');
      const readyFile=path.join(root,'incoming',name+'.ready.json'),dataFile=path.join(root,'incoming',name+'.json'),o={windows,fixtureOnly,nodeProfileSha256,acl};
      // bf57ff10 P2 B (2026-11-07): on Windows the ready marker and its data file are checked by ONE helper call when both
      // exist (it was one call each: 0.86 s per record read). That call passes exactly when both per-file calls would; in
      // every other case (a file absent, or the joint call refused) the old per-file order below runs unchanged, so each
      // absence (ENOENT, a normal wait), refusal and its precedence is the old one. A refused joint call never passes:
      // the per-file checks only decide which refusal is reported, and when each of them passes the read still fails
      // with FORMAL_MAILBOX_ACL_JOINT_REFUSED (review MINOR 1). Linux and fixtures are unchanged.
      let checked=false,jointRefused=false;
      if(windows&&(acl||!fixtureOnly)){await fsp.lstat(readyFile);let both=false;try{await fsp.lstat(dataFile);both=true;}catch{/* the old order reports it */}
        if(both){try{await guard([readyFile,dataFile],root,o);checked=true;}catch{jointRefused=true;/* the old order decides which refusal */}}}
      const pendingReady=!jointRefused;
      const ready=checked?await stableRead(readyFile,{pendingReady}):await safeFile(readyFile,root,{...o,pendingReady}),r=JSON.parse(ready.toString('utf8'));
      check(canonical(r)===ready.toString('utf8')&&Object.keys(r).sort().join('|')==='bytes|contract|sha256'&&r.contract==='clued.independent-ci.complete-public-file/1'&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=MAX&&/^[a-f0-9]{64}$/.test(r.sha256??''),'FORMAL_MAILBOX_READY_REQUIRED');
      const bytes=checked?await stableRead(dataFile):await safeFile(dataFile,root,o);check(bytes.length===r.bytes&&hash(bytes)===r.sha256,'FORMAL_MAILBOX_PACKET_CHANGED');check(!jointRefused,'FORMAL_MAILBOX_ACL_JOINT_REFUSED');return bytes;
    },
    async wait(name,{deadline,signal}={}){check(Number.isFinite(deadline),'FORMAL_MAILBOX_DEADLINE_REQUIRED');while(true){check(!signal?.aborted&&Date.now()<deadline,'FORMAL_MAILBOX_WAIT_UNCONFIRMED');try{return await box.read(name);}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(resolve=>setTimeout(resolve,100));}}
  });(fixtureOnly?fixture:actual).add(box);return box;
}
export async function openAcceptedMailbox(context){takeAcceptedBridgeContext(context);validateRelayDescriptor(context.descriptor,context);const nodeProfileSha256=context.side==='windows'?profileHash(validateNodeProfile(context.accepted.node)):null;return openFixed({side:context.side,root:context.side==='windows'?WINDOWS_ROOT:LINUX_ROOT,nodeProfileSha256});}
export function takeActualMailbox(box){check(actual.has(box)&&!fixture.has(box),'ACTUAL_ACCEPTED_FORMAL_MAILBOX_REQUIRED');return box;}
// Actual disk tests use disposable work directories and cannot get the actual
// mailbox brand or enter a production Linux adapter.
export function createFixtureMailbox(directory,side='linux'){return openFixed({side,root:directory,fixtureOnly:true});}
// A Windows fixture mailbox whose ACL helper calls go to `acl(args)` instead of PowerShell (tests count and refuse them).
// Fixture brand: it can never become the actual mailbox.
export function createAclProbeMailbox(directory,acl,nodeProfileSha256='0'.repeat(64)){return openFixed({side:'windows',root:directory,fixtureOnly:true,nodeProfileSha256,acl});}
