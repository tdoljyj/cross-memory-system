// Finite observation CLI, not a qualification issuer or production worker.
// Docker create/inspect/exit/remove logic follows the reviewed linux-launcher
// (befed130b3e027219991b8ece8a8630c03ffe18996ba57bec4c7d0863ebaaf5e).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createHash,createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const ENTRY='/opt/clued-independent-ci/verify-worker.mjs';
export const CONFIG='/etc/clued-independent-ci/verify-once.json';
export const KEY='/etc/clued-independent-ci/verify-result-key.pem';
export const PUBLIC_KEY='/etc/clued-independent-ci/verify-result-public.pem';
const SELF=fileURLToPath(import.meta.url),REPO='tdoljyj/cross-memory-system',SHA=/^[a-f0-9]{64}$/,SHA40=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const IMAGE=/^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/:\-]*@sha256:[a-f0-9]{64})$/;
const SCANNERS={gitleaks:'/usr/bin/gitleaks',trivy:'/usr/local/bin/trivy'};
const FORBIDDEN=['github-checks','merge','deploy','host-qualification','credential-export'];
const SUBJECT=['id','repo','pr','headSha','baseSha','claimId','fence','epoch','role','sourceManifestSha256','attempt'];
const REQUEST=['contract','domain','observationOnly','phase','executionId','nonce','repository','ownerDecisionRef','configSha256','sourceCommit','sourceBundleSha256','sourceManifestSha256','resultKeyId','resultKeyBoundary','imageDigest','createdAt','deadline','job','admissionObservationSha256','isolationProbe','forbiddenEffects'];
const actualObservations=new WeakSet();
const deny=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const positive=v=>Number.isSafeInteger(v)&&v>0;
const safePath=v=>typeof v==='string'&&/^\/[A-Za-z0-9_./:-]+$/.test(v)&&path.posix.normalize(v)===v;
const boundedText=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\x00-\x20\x7f]/.test(v);
export function canonical(v){
  if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
  if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&Object.getPrototypeOf(v)===Object.prototype)return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  deny('UNSUPPORTED_OBSERVATION_VALUE');
}
export const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const subject=job=>job?Object.fromEntries(SUBJECT.map(k=>[k,job[k]])):null;

export function validateConfig(c,now=Date.now()){
  const fields=['contract','enabled','observationOnly','ownerDecisionRef','ownerReceiptRef','acceptedAt','expiresAt','controllerConfigSha256','sourceCommit','sourceBundleSha256',
    'sourceManifestSha256','sourceManifestFile','sourceDirectory','workspaceRoot','stateRoot','spoolRoot','keyId','resultPublicKeySha256','imageDigest','isolationScanner','dockerRootDirectory',
    'node','docker','git','workerModule','entrySha256','roles','jobSha256','currentClaim','limits'];
  if(!exact(c,fields)||c.contract!=='clued.independent-ci.linux-verify-once/1'||c.enabled!==true||c.observationOnly!==true||
    !boundedText(c.ownerDecisionRef)||!boundedText(c.ownerReceiptRef)||!(Date.parse(c.acceptedAt)<=now)||!(Date.parse(c.expiresAt)>now)||
    Date.parse(c.expiresAt)-Date.parse(c.acceptedAt)>86400000||!SHA40.test(c.sourceCommit)||
    !['controllerConfigSha256','sourceBundleSha256','sourceManifestSha256','resultPublicKeySha256','entrySha256'].every(k=>SHA.test(c[k]))||
    !IMAGE.test(c.imageDigest)||!Object.hasOwn(SCANNERS,c.isolationScanner)||!boundedText(c.keyId))deny('FINITE_SOURCE_CONFIG_INVALID');
  for(const k of ['sourceManifestFile','sourceDirectory','workspaceRoot','stateRoot','spoolRoot','dockerRootDirectory'])if(!safePath(c[k]))deny('FIXED_CONFIG_PATH_REQUIRED');
  for(const k of ['node','docker','git','workerModule'])if(!exact(c[k],['path','sha256'])||!safePath(c[k].path)||!SHA.test(c[k].sha256))deny('RUNTIME_PIN_REQUIRED');
  if(c.docker.path!=='/usr/bin/docker'||c.workerModule.sha256!=='67803ba150f0b22af5459af4b83f7910835221caea845a54a46a70d39ec7608c')deny('FIXED_RUNTIME_SOURCE_REQUIRED');
  if(!Array.isArray(c.roles)||!c.roles.length||c.roles.length>4||new Set(c.roles).size!==c.roles.length||!c.roles.every(v=>/^[a-z][a-z0-9_.-]{0,79}$/.test(v))||
    !(c.jobSha256===null||SHA.test(c.jobSha256)))deny('FINITE_ROLE_SCOPE_REQUIRED');
  if(!exact(c.currentClaim,['claimId','fence','epoch','expiresAt'])||!UUID.test(c.currentClaim.claimId)||!positive(c.currentClaim.fence)||!positive(c.currentClaim.epoch)||
    !(Date.parse(c.currentClaim.expiresAt)>now))deny('FINITE_CLAIM_REQUIRED');
  const l=c.limits;
  if(!exact(l,['timeoutMs','maxOutputBytes','memoryBytes','cpus','pids','maxSnapshotBytes'])||!positive(l.timeoutMs)||l.timeoutMs<1000||l.timeoutMs>900000||
    !positive(l.maxOutputBytes)||l.maxOutputBytes>16*1024*1024||!positive(l.memoryBytes)||l.memoryBytes<134217728||l.memoryBytes>4294967296||
    !Number.isFinite(l.cpus)||l.cpus<=0||l.cpus>2||!positive(l.pids)||l.pids<16||l.pids>128||!positive(l.maxSnapshotBytes)||l.maxSnapshotBytes>1024*1024*1024)deny('FINITE_LIMITS_REQUIRED');
  const roots=[c.sourceDirectory,c.workspaceRoot,c.stateRoot,c.spoolRoot];
  if(new Set(roots).size!==4||roots.some((r,i)=>roots.some((other,j)=>i!==j&&(r.startsWith(other+'/')||other.startsWith(r+'/'))))||
    roots.some(r=>[CONFIG,KEY,PUBLIC_KEY,ENTRY].some(f=>f===r||f.startsWith(r+'/'))))deny('CONTROL_MOUNT_OVERLAP');
  return c;
}
export function validateRequest(r,c,phase,now=Date.now()){
  if(!exact(r,REQUEST)||r.contract!=='clued.independent-ci.verify-spool-request/1'||r.domain!=='first-run-observation'||r.observationOnly!==true||r.phase!==phase||
    !['isolation','admitted-pr'].includes(phase)||!UUID.test(r.executionId)||!SHA.test(r.nonce)||r.repository!==REPO||r.ownerDecisionRef!==c.ownerDecisionRef||
    r.configSha256!==c.controllerConfigSha256||r.sourceCommit!==c.sourceCommit||r.sourceBundleSha256!==c.sourceBundleSha256||
    r.sourceManifestSha256!==c.sourceManifestSha256||r.resultKeyId!==c.keyId||r.resultKeyBoundary!=='owner-wsl-administrator'||r.imageDigest!==c.imageDigest||
    canonical(r.forbiddenEffects)!==canonical(FORBIDDEN)||!(Date.parse(r.createdAt)<=now)||!(Date.parse(r.deadline)>now)||
    Date.parse(r.deadline)-Date.parse(r.createdAt)>c.limits.timeoutMs||Date.parse(r.deadline)>Date.parse(c.expiresAt))deny('SPOOL_REQUEST_BINDING_REFUSED');
  if(phase==='isolation'){
    if(r.job!==null||r.admissionObservationSha256!==null||r.isolationProbe!=='fixed-container-boundary-and-whole-tree-cleanup')deny('FIXED_ISOLATION_REQUEST_REQUIRED');
  }else{
    const j=r.job,fields=['contract',...SUBJECT,'createdAt'];
    if(!exact(j,fields)||j.contract!=='clued.independent-ci.job/1'||!SHA.test(j.id)||j.repo!==REPO||!positive(j.pr)||!SHA40.test(j.headSha)||!SHA40.test(j.baseSha)||
      !UUID.test(j.claimId)||!positive(j.fence)||!positive(j.epoch)||!c.roles.includes(j.role)||j.sourceManifestSha256!==c.sourceManifestSha256||j.attempt!==1||
      !(Date.parse(j.createdAt)<=now)||digest(j)!==c.jobSha256||!SHA.test(r.admissionObservationSha256)||r.isolationProbe!==null||
      ['claimId','fence','epoch'].some(k=>j[k]!==c.currentClaim[k])||Date.parse(r.deadline)>Date.parse(c.currentClaim.expiresAt))deny('FINITE_ADMITTED_JOB_REFUSED');
    const identity=['repo','pr','headSha','baseSha','claimId','fence','epoch','sourceManifestSha256','role'].map(k=>j[k]);
    if(digest(JSON.stringify(identity))!==j.id)deny('JOB_ID_MISMATCH');
  }
  return r;
}
function environment(){return {PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:'/nonexistent',DOCKER_CONFIG:'/nonexistent'};}
async function invoke(c,args,{timeoutMs=10000,maxOutputBytes=65536,digestOnly=false,signal}={}){
  return await new Promise(resolve=>{
    const p=childProcess.spawn(c.docker.path,['--host','unix:///run/docker.sock',...args],{shell:false,env:environment(),stdio:['ignore','pipe','pipe']});
    let ended=false,bytes=0,parts=[],timedOut=false,overflow=false,error=false,timer;
    const streams=Object.fromEntries(['stdout','stderr'].map(k=>[k,{hash:createHash('sha256'),bytes:0,truncated:false}]));
    const finish=code=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      resolve({code,timedOut,overflow,error,stdout:digestOnly?'':Buffer.concat(parts).toString('utf8'),logs:Object.fromEntries(Object.entries(streams).map(([k,v])=>[k,{sha256:v.hash.digest('hex'),bytes:v.bytes,truncated:v.truncated}]))});};
    const abort=()=>{timedOut=true;p.kill('SIGKILL');setTimeout(()=>finish(null),250).unref();};
    timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    for(const key of ['stdout','stderr'])p[key].on('data',chunk=>{if(ended)return;streams[key].hash.update(chunk);streams[key].bytes+=chunk.length;bytes+=chunk.length;
      if(bytes>maxOutputBytes){overflow=true;streams[key].truncated=true;p.kill('SIGKILL');}else if(!digestOnly&&key==='stdout')parts.push(chunk);});
    p.once('error',()=>{error=true;finish(null);});p.once('close',finish);
  });
}
function parse(result){if(result.code!==0||result.timedOut||result.overflow||result.error)deny('DOCKER_READ_UNKNOWN');try{return JSON.parse(result.stdout);}catch{deny('DOCKER_JSON_UNKNOWN');}}
// Exact opt-in environment literals. trivy (fs scans) needs a writable os.TempDir(); with a read-only
// rootfs that is the /scratch tmpfs. No other value can be requested; absent c.env keeps the fixed argv.
const EXTRA_ENV=Object.freeze(['TMPDIR=/scratch']);
function extraEnv(c){const e=c.env??[];if(!Array.isArray(e)||new Set(e).size!==e.length||e.some(v=>!EXTRA_ENV.includes(v)))deny('EXTRA_ENV_REFUSED');return e;}
export function createArguments(c,r,plan,name){
  const mounts=plan.mounts??[];
  return ['create','--name',name,'--pull=never','--network=none','--ipc=private','--cgroupns=private','--user=65532:65532','--read-only','--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',`--pids-limit=${c.limits.pids}`,`--cpus=${c.limits.cpus}`,`--memory=${c.limits.memoryBytes}`,`--memory-swap=${c.limits.memoryBytes}`,
    '--restart=no','--log-driver=none','--ulimit=nofile=1024:1024','--env=NODE_OPTIONS=','--env=NODE_PATH=','--env=HOME=/scratch',...extraEnv(c).map(v=>`--env=${v}`),
    '--tmpfs=/scratch:rw,nosuid,nodev,noexec,size=536870912,mode=0700,uid=65532,gid=65532',
    ...mounts.flatMap(([src,dst])=>['--mount',`type=bind,src=${src},dst=${dst},readonly,bind-propagation=rprivate`]),
    `--workdir=${plan.cwd}`,'--entrypoint',plan.executable,'--label',`clued.verify.nonce=${r.nonce}`,'--label',`clued.verify.execution=${r.executionId}`,c.imageDigest,...plan.args];
}
export function inspectContainer(o,c,r,plan,name,imageId){
  const h=o?.HostConfig,expected=new Map((plan.mounts??[]).map(([src,dst])=>[dst,src]));
  if(o?.Name!==`/${name}`||o.Image!==imageId||o.Config?.Image!==c.imageDigest||o.Config.User!=='65532:65532'||
    h?.NetworkMode!=='none'||h.IpcMode!=='private'||!['','private'].includes(h.PidMode)||h.CgroupnsMode!=='private'||h.UTSMode||h.Privileged!==false||
    h.ReadonlyRootfs!==true||canonical(h.CapDrop)!==canonical(['ALL'])||h.CapAdd?.length||h.Devices?.length||!h.SecurityOpt?.includes('no-new-privileges:true')||
    h.SecurityOpt.some(v=>v!=='no-new-privileges:true')||h.PidsLimit!==c.limits.pids||h.Memory!==c.limits.memoryBytes||h.MemorySwap!==c.limits.memoryBytes||
    h.NanoCpus!==Math.round(c.limits.cpus*1e9)||h.LogConfig?.Type!=='none')deny('CONTAINER_ISOLATION_DRIFT');
  const binds=(o.Mounts??[]).filter(m=>m.Type==='bind'),scratch=(o.Mounts??[]).filter(m=>m.Type==='tmpfs');
  if(binds.length!==expected.size||new Set(binds.map(m=>m.Destination)).size!==expected.size||binds.some(m=>m.RW!==false||expected.get(m.Destination)!==m.Source)||
    scratch.length>1||scratch.some(m=>m.Destination!=='/scratch'||m.Source)||o.Mounts.length!==binds.length+scratch.length||
    !h.Tmpfs||Object.keys(h.Tmpfs).length!==1||!h.Tmpfs['/scratch']?.includes('noexec')||!h.Tmpfs['/scratch'].includes('uid=65532'))deny('CONTAINER_MOUNT_DRIFT');
  if(canonical(o.Config.Entrypoint)!==canonical([plan.executable])||canonical(o.Config.Cmd)!==canonical(plan.args)||o.Config.WorkingDir!==plan.cwd||
    o.Config.Labels?.['clued.verify.nonce']!==r.nonce||o.Config.Labels?.['clued.verify.execution']!==r.executionId||
    !(o.Config.Env??[]).every(v=>/^(PATH|NODE_VERSION|YARN_VERSION|LANG|LC_ALL|TZ|NODE_OPTIONS|NODE_PATH|HOME)=/.test(v)||extraEnv(c).includes(v))||
    ['NODE_OPTIONS=','NODE_PATH=','HOME=/scratch',...extraEnv(c)].some(expected=>(o.Config.Env??[]).filter(v=>v.split('=')[0]===expected.split('=')[0]).join('')!==expected))deny('CONTAINER_COMMAND_ENV_DRIFT');
  return {nonRoot:true,privileged:false,capDropAll:true,noNewPrivileges:true,rootfsReadOnly:true,network:'none',dockerSocketMounted:false,controlPathsMounted:false,credentialsMounted:false};
}

// Unsigned algorithm entry for offline mock tests. It cannot access a result key
// and is never the production signing entry. A mock observation is not enrolled
// in actualObservations and cannot be signed by this module.
export async function observeUnsignedContainer(c,r,plan,docker,{signal}={}){
  const name=`clued-verify-${r.nonce}`,startedAt=new Date().toISOString();
  let touched=false,containerId=null,imageId=null,state=null,attached=null,isolation=null,cleanup=false,finishedAt=null,reason=null;
  try{
    if(signal?.aborted||Date.parse(r.deadline)<=Date.now())deny('REQUEST_EXPIRED_OR_CANCELLED');
    const info=parse(await docker(['info','--format','{{json .}}']));
    if(info.OSType!=='linux'||info.DockerRootDir!==c.dockerRootDirectory||/desktop/i.test(info.OperatingSystem??'')||!info.SecurityOptions?.some(v=>v.includes('seccomp')))deny('NATIVE_ENGINE_UNKNOWN');
    const images=parse(await docker(['image','inspect',c.imageDigest]));
    if(images.length!==1||!(images[0].Id===c.imageDigest||images[0].RepoDigests?.includes(c.imageDigest))||!/^sha256:[a-f0-9]{64}$/.test(images[0].Id)||images[0].Os!=='linux'||
      Object.keys(images[0].Config?.Volumes??{}).length||!(images[0].Config?.Env??[]).every(v=>/^(PATH|NODE_VERSION|YARN_VERSION|LANG|LC_ALL|TZ)=/.test(v)))deny('LOCAL_IMAGE_PIN_UNKNOWN');
    if(signal?.aborted||Date.now()>=Date.parse(r.deadline))deny('REQUEST_EXPIRED_OR_CANCELLED');
    imageId=images[0].Id;touched=true;
    const creation=await docker(createArguments(c,r,plan,name));
    if(creation.code!==0||creation.timedOut||creation.overflow||creation.error||!/^[a-f0-9]{64}\s*$/.test(creation.stdout))deny('CREATE_UNCONFIRMED');containerId=creation.stdout.trim();
    let a=parse(await docker(['inspect',containerId]));if(a.length!==1||a[0].Id!==containerId)deny('CONTAINER_ID_UNKNOWN');isolation=inspectContainer(a[0],c,r,plan,name,imageId);
    if(signal?.aborted||Date.now()>=Date.parse(r.deadline))deny('REQUEST_EXPIRED_OR_CANCELLED');
    attached=await docker(['start','--attach',containerId],{timeoutMs:Math.max(1,Math.min(c.limits.timeoutMs,Date.parse(r.deadline)-Date.now())),maxOutputBytes:c.limits.maxOutputBytes,digestOnly:true,signal});
    a=parse(await docker(['inspect',containerId]));if(a.length!==1||a[0].Id!==containerId)deny('CONTAINER_ID_UNKNOWN');inspectContainer(a[0],c,r,plan,name,imageId);state=a[0].State;finishedAt=new Date().toISOString();
    if(state?.Running!==false||state.Status!=='exited'||!Number.isInteger(state.ExitCode)||state.ExitCode<0||state.ExitCode>255||state.Error||state.OOMKilled||
      attached.code!==state.ExitCode||attached.timedOut||attached.overflow||attached.error)deny('ACTUAL_EXIT_UNCONFIRMED');
  }catch(e){reason=/^[A-Z_]+$/.test(e.code??'')?e.code:'EXECUTION_UNCONFIRMED';}
  finally{
    if(touched)try{
      const removed=await docker(['rm','--force',containerId??name]);
      const ids=await docker(['container','ls','--all','--no-trunc','--filter',`label=clued.verify.nonce=${r.nonce}`,'--format','{{.ID}}']);
      const named=await docker(['container','ls','--all','--no-trunc','--filter',`name=^/${name}$`,'--format','{{.ID}}']);
      cleanup=[removed,ids,named].every(v=>v.code===0&&!v.timedOut&&!v.overflow&&!v.error)&&ids.stdout.trim()===''&&named.stdout.trim()==='';
    }catch{cleanup=false;}
  }
  return {evidenceClass:'unsigned-container-observation',startedAt,finishedAt,containerId,imageId,state,attached,isolation,cleanupConfirmed:cleanup,
    cleanupObservedAt:new Date().toISOString(),reason,touched,complete:!reason&&cleanup&&Boolean(containerId&&finishedAt&&attached&&isolation)};
}

async function protectedPath(filename,{directory=false,privateFile=false}={}){
  if(process.platform!=='linux'||process.getuid?.()!==0||!safePath(filename))deny('ROOT_LINUX_FIXED_ENTRY_REQUIRED');
  let p='/';for(const bit of filename.split('/').filter(Boolean)){p=path.join(p,bit);const s=await fsp.lstat(p);
    if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))deny('UNPROTECTED_SOURCE_PATH');}
  const s=await fsp.lstat(filename);if(directory?!s.isDirectory():!s.isFile()||s.nlink!==1)deny('UNSAFE_SOURCE_FILE');
  if(privateFile&&(s.mode&0o077))deny('PRIVATE_SOURCE_FILE_REQUIRED');return s;
}
async function readProtected(filename,cap=65536,options={}){
  await protectedPath(filename,options);const h=await fsp.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=await h.stat();if(s.size>cap||s.uid!==0||!s.isFile()||s.nlink!==1||(s.mode&0o022))deny('PROTECTED_INPUT_BOUND');
    const b=await h.readFile();if(b.length>cap)deny('PROTECTED_INPUT_BOUND');return b;}finally{await h.close();}
}
async function load(){
  if(process.platform!=='linux'||process.getuid?.()!==0||SELF!==ENTRY)deny('ROOT_LINUX_FIXED_ENTRY_REQUIRED');
  const bytes=await readProtected(CONFIG,65536,{privateFile:true}),c=validateConfig(JSON.parse(bytes));
  if(process.execPath!==c.node.path)deny('EXACT_NODE_REQUIRED');
  for(const [file,pin,cap]of [[ENTRY,c.entrySha256,65536],[c.node.path,c.node.sha256,128*1024*1024],
    [c.docker.path,c.docker.sha256,128*1024*1024],[c.git.path,c.git.sha256,128*1024*1024],[c.workerModule.path,c.workerModule.sha256,65536]]){
    if(digest(await readProtected(file,cap))!==pin)deny('RUNTIME_SOURCE_DRIFT');
  }
  await protectedPath('/run',{directory:true});const sock=await fsp.lstat('/run/docker.sock');
  if(!sock.isSocket()||sock.isSymbolicLink()||sock.uid!==0||(sock.mode&0o007))deny('NATIVE_DOCKER_SOCKET_REQUIRED');
  for(const dir of [c.sourceDirectory,c.workspaceRoot,c.stateRoot,c.spoolRoot,path.join(c.spoolRoot,'results')])await protectedPath(dir,{directory:true});
  const manifest=await readProtected(c.sourceManifestFile,1024*1024);
  if(digest(manifest)!==c.sourceManifestSha256)deny('SOURCE_MANIFEST_DRIFT');
  const publicKey=await readProtected(PUBLIC_KEY,16384);
  if(digest(publicKey)!==c.resultPublicKeySha256||createPublicKey(publicKey).asymmetricKeyType!=='ed25519')deny('RESULT_PUBLIC_KEY_DRIFT');
  return {c,manifest,publicKey};
}
async function durableExclusive(filename,value){
  const h=await fsp.open(filename,'wx',0o600);try{await h.writeFile(canonical(value));await h.sync();}finally{await h.close();}
  const d=await fsp.open(path.dirname(filename),'r');try{await d.sync();}finally{await d.close();}
}
async function removeWorkspace(dir,stateRoot){
  if(path.dirname(dir)!==stateRoot||!/^workspace-[a-f0-9]{64}$/.test(path.basename(dir)))deny('TEMPORARY_WORKSPACE_SCOPE');
  await fsp.rm(dir,{recursive:true,force:false});
  try{await fsp.lstat(dir);deny('TEMPORARY_WORKSPACE_REMAINS');}catch(e){if(e.code!=='ENOENT')throw e;}
}
async function sealCopy(root,destination,c,{sourceFiles=null}={}){
  await protectedPath(root,{directory:true});let bytes=0,files=0;
  async function walk(dir,depth=0){if(depth>64)deny('SNAPSHOT_DEPTH_BOUND');
    for(const entry of await fsp.readdir(dir,{withFileTypes:true})){if(entry.name==='.git')continue;const file=path.join(dir,entry.name),s=await fsp.lstat(file);
      if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||!(s.isDirectory()||s.isFile()&&s.nlink===1))deny('UNSEALED_INPUT');
      if(s.isDirectory())await walk(file,depth+1);else{bytes+=s.size;files++;if(bytes>c.limits.maxSnapshotBytes||files>50000)deny('SNAPSHOT_SIZE_BOUND');}}
  }
  await walk(root);await fsp.mkdir(destination,{mode:0o755});
  if(sourceFiles){for(const item of sourceFiles){const target=path.join(destination,item.path);await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o755});await fsp.cp(path.join(root,item.path),target,{dereference:false});}}
  else await fsp.cp(root,destination,{recursive:true,dereference:false,filter:src=>path.basename(src)!=='.git'});
  async function readonly(dir){for(const e of await fsp.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await readonly(p);else await fsp.chmod(p,(await fsp.lstat(p)).mode&0o111?0o555:0o444);}await fsp.chmod(dir,0o555);}
  await readonly(destination);
}
export function unsignedSpoolPayload(c,r,o,cleanup){
  if(o.complete!==true||o.cleanupConfirmed!==true||!cleanup.temporaryWorkspaceRemoved||!SHA.test(o.containerId??'')||
    !o.finishedAt||o.attached?.timedOut||o.attached?.overflow||o.attached?.error||!o.state||!o.isolation||
    Date.parse(cleanup.observedAt)>Date.parse(r.deadline))deny('COMPLETE_ACTUAL_OBSERVATION_REQUIRED');
  return {contract:'clued.independent-ci.verify-spool-result/1',domain:'first-run-observation',observationOnly:true,
    executionId:r.executionId,nonce:r.nonce,requestSha256:digest(r),phase:r.phase,sourceBundleSha256:r.sourceBundleSha256,sourceManifestSha256:r.sourceManifestSha256,
    subject:subject(r.job),resultKeyBoundary:'owner-wsl-administrator',qualificationIssued:false,startedAt:o.startedAt,finishedAt:o.finishedAt,
    runtime:{platform:'linux',engine:'native-linux-docker',imageDigest:r.imageDigest,containerId:o.containerId},
    process:{exitCode:o.state.ExitCode,signal:null,timedOut:false},stdout:{sha256:o.attached.logs.stdout.sha256,bytes:o.attached.logs.stdout.bytes},
    stderr:{sha256:o.attached.logs.stderr.sha256,bytes:o.attached.logs.stderr.bytes},isolation:o.isolation,
    cleanup:{complete:true,containerRemoved:true,wholeProcessTreeStopped:true,temporaryWorkspaceRemoved:true,remainingContainers:[],observedAt:cleanup.observedAt}};
}
// Explicit guard remains before any key read. Fixture observations are never
// enrolled, even if their JSON and mock Docker answers look identical.
export async function signActualObservation(c,r,o,cleanup,publicKey){
  if(!actualObservations.has(o))deny('FIXTURE_OR_CALLER_OBSERVATION_NOT_SIGNABLE');
  if(Date.now()>Date.parse(r.deadline))deny('REQUEST_EXPIRED_BEFORE_SIGNATURE');
  const payload=unsignedSpoolPayload(c,r,o,cleanup),bytes=await readProtected(KEY,16384,{privateFile:true});
  let key;try{key=createPrivateKey(bytes);}finally{bytes.fill(0);}
  if(key.asymmetricKeyType!=='ed25519'||!createPublicKey(key).export({format:'der',type:'spki'}).equals(createPublicKey(publicKey).export({format:'der',type:'spki'})))deny('RESULT_SIGNER_MISMATCH');
  return {contract:'clued.independent-ci.verify-spool-envelope/1',keyId:c.keyId,payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64url')};
}
async function requirePreviousIsolation(c,publicKey){
  const request=JSON.parse(await readProtected(path.join(c.spoolRoot,'isolation-request.json')));
  // The earlier request may now be completed, so its original time/TTL is
  // checked using its signed execution time below, not extended or refreshed.
  const e=JSON.parse(await readProtected(path.join(c.spoolRoot,'results/isolation-result.json'))),p=e.payload;
  if(e.contract!=='clued.independent-ci.verify-spool-envelope/1'||e.keyId!==c.keyId||p?.contract!=='clued.independent-ci.verify-spool-result/1'||p.domain!=='first-run-observation'||
    p.phase!=='isolation'||p.nonce!==request.nonce||p.executionId!==request.executionId||p.requestSha256!==digest(request)||p.subject!==null||p.qualificationIssued!==false||
    p.sourceBundleSha256!==c.sourceBundleSha256||p.sourceManifestSha256!==c.sourceManifestSha256||p.runtime?.imageDigest!==c.imageDigest||p.process?.exitCode!==0||
    p.process.timedOut!==false||p.process.signal!==null||p.cleanup?.complete!==true||p.cleanup.wholeProcessTreeStopped!==true||p.cleanup.temporaryWorkspaceRemoved!==true||
    p.cleanup.containerRemoved!==true||p.cleanup.remainingContainers?.length!==0||Date.parse(p.cleanup.observedAt)>Date.parse(request.deadline)||
    !verify(null,Buffer.from(canonical(p)),publicKey,Buffer.from(e.signature??'','base64url')))deny('ACTUAL_PRIOR_ISOLATION_REQUIRED');
  const done=JSON.parse(await readProtected(path.join(c.stateRoot,'isolation.done.json')));
  if(done.requestSha256!==digest(request)||done.resultSha256!==digest(e)||done.configSha256!==digest(await readProtected(CONFIG,65536,{privateFile:true})))deny('LOCAL_ISOLATION_INTENT_NOT_COMPLETED');
}
export async function executePhase(phase){
  if(!['isolation','admitted-pr'].includes(phase))deny('FIXED_PHASE_REQUIRED');
  const {c,manifest,publicKey}=await load(),base=phase==='isolation'?'isolation':'admitted';
  const r=validateRequest(JSON.parse(await readProtected(path.join(c.spoolRoot,`${base}-request.json`))),c,phase);
  if(phase==='admitted-pr')await requirePreviousIsolation(c,publicKey);
  const lock=path.join(c.stateRoot,`${base}.intent.json`);
  await durableExclusive(lock,{contract:'clued.independent-ci.verify-intent/1',phase,nonce:r.nonce,executionId:r.executionId,requestSha256:digest(r),sourceBundleSha256:c.sourceBundleSha256});
  const workspace=path.join(c.stateRoot,`workspace-${r.nonce}`);await fsp.mkdir(workspace,{mode:0o755});
  let observation=null,workspaceRemoved=false,plan;
  const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
    if(phase==='isolation')plan={executable:SCANNERS[c.isolationScanner],args:[c.isolationScanner==='gitleaks'?'version':'--version'],cwd:'/scratch',mounts:[]};
    else{
      // Only this pinned, builtin-only existing module is imported. It verifies
      // actual Git head/base/source trees and selects the registered image role.
      const worker=await import(pathToFileURL(c.workerModule.path).href),candidate=path.join(c.workspaceRoot,r.job.id,'candidate');
      const prepared=await worker.prepareContainerWorkerJob({job:r.job,workspace:candidate,trustedSourceDirectory:c.sourceDirectory,sourceManifestBytes:manifest,
        expectedSourceManifestSha256:c.sourceManifestSha256,gitExecutable:c.git.path});
      if(prepared.containerCommand.image!==c.imageDigest||!Object.hasOwn(SCANNERS,prepared.containerCommand.scanner)||Date.now()>=Date.parse(r.deadline))deny('ADMITTED_SCANNER_SOURCE_CHANGED');
      const role=JSON.parse(manifest).roles[r.job.role],snapCandidate=path.join(workspace,'candidate'),snapSource=path.join(workspace,'source');
      await sealCopy(candidate,snapCandidate,c);await sealCopy(c.sourceDirectory,snapSource,c,{sourceFiles:role.sourceFiles});
      plan={executable:prepared.containerCommand.executable,args:prepared.containerCommand.args,cwd:'/input',mounts:[[snapCandidate,'/input'],[snapSource,'/source']]};
    }
    observation=await observeUnsignedContainer(c,r,plan,(args,options)=>invoke(c,args,options),{signal:controller.signal});
    if(observation.touched&&!observation.cleanupConfirmed)deny('CONTAINER_CLEANUP_UNCONFIRMED');
    await removeWorkspace(workspace,c.stateRoot);workspaceRemoved=true;
    if(!observation.complete||controller.signal.aborted||Date.now()>Date.parse(r.deadline))deny('ACTUAL_EXECUTION_OR_CLEANUP_UNCERTAIN');
    actualObservations.add(observation);
    const envelope=await signActualObservation(c,r,observation,{temporaryWorkspaceRemoved:true,observedAt:new Date().toISOString()},publicKey);
    const output=path.join(c.spoolRoot,'results',`${base}-result.json`);await durableExclusive(output,envelope);
    await durableExclusive(path.join(c.stateRoot,`${base}.done.json`),{requestSha256:digest(r),resultSha256:digest(envelope),configSha256:digest(await readProtected(CONFIG,65536,{privateFile:true}))});
    return {status:'OBSERVED',phase,requestSha256:digest(r),resultSha256:digest(envelope),output,exitCode:observation.state.ExitCode,qualificationIssued:false,formalChecksWritten:false};
  }finally{
    process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
    // Never remove host inputs while a container's cleanup is unconfirmed.
    if(!workspaceRemoved&&(!observation||observation.cleanupConfirmed))try{await removeWorkspace(workspace,c.stateRoot);}catch{}
    // Intent is single-use and deliberately retained on both success/unknown.
  }
}
export async function main(argv=process.argv.slice(2),output=process.stdout){
  if(argv.length!==1||!['--isolation','--admitted','--run'].includes(argv[0])){output.write('{"status":"BLOCKED","reason":"FIXED_MODE_REQUIRED","qualificationIssued":false}\n');return 2;}
  try{
    if(argv[0]!=='--run'){output.write(canonical(await executePhase(argv[0]==='--isolation'?'isolation':'admitted-pr'))+'\n');return 0;}
    const {c}=await load(),deadline=Math.min(Date.parse(c.expiresAt),Date.now()+c.limits.timeoutMs);
    for(const phase of ['isolation','admitted-pr']){
      const name=phase==='isolation'?'isolation':'admitted';
      while(true){try{await protectedPath(path.join(c.spoolRoot,`${name}-request.json`));break;}catch(e){if(e.code!=='ENOENT')throw e;if(Date.now()>=deadline)deny('FINITE_SPOOL_WAIT_EXPIRED');await new Promise(resolve=>setTimeout(resolve,500));}}
      if(Date.now()>=deadline)deny('FINITE_SPOOL_WAIT_EXPIRED');const result=await executePhase(phase);output.write(canonical(result)+'\n');
      if(result.exitCode!==0)return 2;
    }return 0;
  }catch(e){output.write(canonical({status:/UNCERTAIN|UNCONFIRMED/.test(e.code??'')?'UNCERTAIN':'BLOCKED',reason:/^[A-Z_]+$/.test(e.code??'')?e.code:'FIRST_RUN_REFUSED',qualificationIssued:false,formalChecksWritten:false,automaticRetryAllowed:false})+'\n');return 2;}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().then(code=>{process.exitCode=code;}).catch(()=>{process.exitCode=2;});
