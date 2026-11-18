// Candidate only. This observes execution/cleanup; it grants no Source, Host or
// production authority. Installation must supply the protected config and cgroup.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const CONFIG_PATH='/etc/clued/currentness-manager.json',UNIT_TEMPLATE='/etc/systemd/system/clued-currentness@.service';
const SELF=fileURLToPath(import.meta.url),HEX=/^[a-f0-9]{64}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const reference=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\s\x00-\x1f\x7f]/.test(v);
const exactKeys=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const absolute=v=>typeof v==='string'&&v.startsWith('/')&&path.posix.normalize(v)===v&&!v.includes('\0');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Read the same immutable original bytes as the external verifier; do not
// execute/import another mutable module before validating the protected config.
const ORIGINAL_VERIFIER='apps/clued-cloud/scripts/verify-currentness-transport.mjs';
function originalTests(root){
  const bytes=fs.readFileSync(path.join(root,ORIGINAL_VERIFIER));
  if(bytes.length>65536||hash(bytes)!=='4784d3c0f3c2099571a18f7c14a8b53a3f85bbed1f2de732a4849bf34ec7c31c')fail('MANAGER_ORIGINAL_SOURCE_PIN');
  const matches=[...bytes.toString('utf8').matchAll(/^const TEST_FILES = Object\.freeze\(\[([\s\S]*?)^\]\);/gm)];
  if(matches.length!==1)fail('MANAGER_ORIGINAL_TEST_DECLARATION');
  const pattern=/'(tests\/[a-z0-9-]+\.test\.mjs)'/g,files=[...matches[0][1].matchAll(pattern)].map(m=>m[1]);
  if(files.length!==19||new Set(files).size!==19||matches[0][1].replace(pattern,'').replace(/[\s,]/g,''))fail('MANAGER_NINETEEN_TESTS_REQUIRED');return files;
}

export function validateManagerConfig(c){
  if(!exactKeys(c,['schema','manager_ref','qualification_ref','uid','job_uid','job_gid','source_root','source_commit','node','git','manager','systemctl','unit_template','state_dir','output_dir','environment'])||
    c.schema!=='clued.currentness-linux-process-manager/2'||!reference(c.manager_ref)||!reference(c.qualification_ref)||
    !Number.isSafeInteger(c.uid)||c.uid<1||!Number.isSafeInteger(c.job_uid)||c.job_uid<1||c.job_uid===c.uid||!Number.isSafeInteger(c.job_gid)||c.job_gid<1||!/^[a-f0-9]{40}$/.test(c.source_commit)||
    !['source_root','state_dir','output_dir'].every(k=>absolute(c[k])))fail('MANAGER_CONFIG_INVALID');
  for(const key of ['node','git','manager','systemctl','unit_template'])if(!exactKeys(c[key],['path','sha256'])||!absolute(c[key].path)||!HEX.test(c[key].sha256))fail('MANAGER_EXECUTABLE_PIN_INVALID');
  if(!exactKeys(c.environment,['PATH','HOME','TMPDIR','LANG','LC_ALL'])||!absolute(c.environment.HOME)||!absolute(c.environment.TMPDIR)||
    !c.environment.PATH.split(':').every(absolute)||!['LANG','LC_ALL'].every(k=>/^[A-Za-z0-9_.@-]{1,64}$/.test(c.environment[k])))fail('MANAGER_ENVIRONMENT_INVALID');
  if(c.unit_template.path!==UNIT_TEMPLATE||[c.source_root,c.output_dir,c.manager.path,c.node.path,c.environment.HOME,c.environment.TMPDIR,...c.environment.PATH.split(':')].some(v=>!/^\/[A-Za-z0-9_./+-]+$/.test(v)))fail('MANAGER_FIXED_UNIT_REQUIRED');
  return c;
}

function protectedAncestors(file){
  for(let p=path.dirname(file);;p=path.dirname(p)){
    const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('MANAGER_UNPROTECTED_PARENT');
    if(p==='/')break;
  }
}
function readPinned(file,digest,maximum=65536){
  if(!absolute(file)||!HEX.test(digest))fail('MANAGER_EXACT_PIN_REQUIRED');protectedAncestors(file);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o022)||s.nlink!==1||s.size>maximum)fail('MANAGER_UNPROTECTED_FILE');
    const b=fs.readFileSync(fd);if(b.length>maximum||hash(b)!==digest)fail('MANAGER_SOURCE_PIN_MISMATCH');return b;
  }finally{fs.closeSync(fd);}
}
function executable(p){
  const s=fs.statSync(p.path);if(!(s.mode&0o111))fail('MANAGER_EXECUTABLE_NOT_EXECUTABLE');
  readPinned(p.path,p.sha256,128*1024*1024);
}
function privateDirectory(dir,uid){
  protectedAncestors(dir);const s=fs.lstatSync(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o077))fail('MANAGER_STATE_NOT_PRIVATE');
}
function trustedSearchDirectories(c){
  for(const dir of c.environment.PATH.split(':')){protectedAncestors(dir);const real=fs.realpathSync(dir);protectedAncestors(real);
    const s=fs.lstatSync(real);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('MANAGER_UNPROTECTED_SEARCH_PATH');}
}
function privilegeBoundary(){
  const status=fs.readFileSync('/proc/self/status','utf8'),groups=process.getgroups();
  if(!/^CapEff:\s+0+$/m.test(status)||!/^NoNewPrivs:\s+1$/m.test(status)||groups.includes(0))fail('MANAGER_PRIVILEGE_BOUNDARY_REQUIRED');
  const docker=fs.readFileSync('/etc/group','utf8').split('\n').find(line=>line.startsWith('docker:'));
  if(docker&&groups.includes(Number(docker.split(':')[2])))fail('MANAGER_DOCKER_GROUP_FORBIDDEN');
}
// WSL interop starts a Windows process for anyone who can reach a
// /run/WSL/*_interop socket, and PrivateDevices=yes still binds the Host's
// /dev/shm. The fixed unit makes both inaccessible ('-': no /run/WSL, no interop).
const INACCESSIBLE=Object.freeze(['-/run/WSL','/dev/shm']);
export function interopBoundary(access=(dir,mode)=>fs.accessSync(dir,mode)){
  for(const dir of INACCESSIBLE.map(p=>p.replace(/^-/,'')))for(const mode of [fs.constants.R_OK,fs.constants.X_OK]){
    try{access(dir,mode);}catch(e){if(e.code==='EACCES'||e.code==='ENOENT')continue;throw e;}
    fail('MANAGER_WSL_INTEROP_OR_SHM_REACHABLE');
  }
}
function outputDirectory(c){
  protectedAncestors(c.output_dir);const s=fs.lstatSync(c.output_dir);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o027)||s.gid!==c.job_gid)fail('MANAGER_OUTPUT_DIRECTORY_UNPROTECTED');
}
function readConfig(configPath,expectedDigest,asJob=false){
  if(process.platform!=='linux'||!Number.isSafeInteger(process.getuid?.())||process.getuid()<1)fail('MANAGER_LINUX_NONROOT_REQUIRED');
  if(configPath!==CONFIG_PATH)fail('MANAGER_FIXED_CONFIG_REQUIRED');
  // Child trusts only the root-protected fixed config, then records its actual
  // digest. The outer manager compares that digest to its accepted exact pin.
  let digest=expectedDigest;
  if(asJob){protectedAncestors(configPath);const fd=fs.openSync(configPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const st=fs.fstatSync(fd);if(!st.isFile()||st.uid!==0||(st.mode&0o022)||st.nlink!==1||st.size>65536)fail('MANAGER_UNPROTECTED_FILE');
      digest=hash(fs.readFileSync(fd));}finally{fs.closeSync(fd);}}
  const bytes=readPinned(configPath,digest),c=validateManagerConfig(JSON.parse(bytes.toString('utf8')));
  if((asJob?c.job_uid:c.uid)!==process.getuid()||c.node.path!==process.execPath||c.manager.path!==SELF)fail('MANAGER_ACTUAL_PRINCIPAL_OR_RUNTIME_MISMATCH');
  executable(c.node);executable(c.git);executable(c.systemctl);readPinned(c.manager.path,c.manager.sha256);
  const unit=readPinned(c.unit_template.path,c.unit_template.sha256);
  if(unit.toString('utf8')!==renderFixedSystemdUnit(c))fail('MANAGER_UNIT_BYTES_MISMATCH');
  privilegeBoundary();interopBoundary();trustedSearchDirectories(c);outputDirectory(c);privateDirectory(c.environment.HOME,c.job_uid);privateDirectory(c.environment.TMPDIR,c.job_uid);
  if(asJob){if(process.getgid()!==c.job_gid)fail('MANAGER_JOB_GROUP_MISMATCH');}
  else{privateDirectory(c.state_dir,c.uid);if(!process.getgroups().includes(c.job_gid))fail('MANAGER_OUTPUT_READER_GROUP_REQUIRED');}
  return {c,digest};
}
export function selectOperation(c,{file,args,cwd,domain,timeoutMs,maxBytes,env}){
  if(domain!=='production'||!Array.isArray(args)||!args.every(s=>typeof s==='string')||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<3000||timeoutMs>2700000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)
    fail('MANAGER_REQUEST_BOUNDS');
  const allowed=new Set(['PATH','HOME','USERPROFILE','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot','ComSpec','NODE_OPTIONS','NODE_PATH']);
  if(!env||Object.keys(env).some(k=>!allowed.has(k))||env.NODE_OPTIONS||env.NODE_PATH)fail('MANAGER_ENVIRONMENT_NOT_ALLOWED');
  if(file===c.git.path&&cwd===c.source_root){
    const git=[['rev-parse','HEAD'],['branch','--show-current'],['status','--porcelain','--untracked-files=all']];
    const index=git.findIndex(a=>JSON.stringify(a)===JSON.stringify(args));if(index>=0)return ['head','branch','status'][index];
  }
  if(file===c.node.path&&cwd===path.join(c.source_root,'apps/clued-cloud')){
    const tests=originalTests(c.source_root);
    if(JSON.stringify(args)===JSON.stringify(['--test','--test-force-exit','--test-reporter=tap',...tests]))return 'tests';
  }
  fail('MANAGER_FIXED_COMMAND_REQUIRED');
}
function command(c,op){
  if(op==='tests')return {file:c.node.path,args:['--test','--test-force-exit','--test-reporter=tap',...originalTests(c.source_root)],cwd:path.join(c.source_root,'apps/clued-cloud')};
  const args={head:['rev-parse','HEAD'],branch:['branch','--show-current'],status:['status','--porcelain','--untracked-files=all']}[op];
  if(!args)fail('MANAGER_FIXED_COMMAND_REQUIRED');return {file:c.git.path,args,cwd:c.source_root};
}
function syncDirectory(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeExclusive(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(file));}
// This small disk primitive has no authority or execution capability. A stale
// intent is deliberately not reclaimed based on elapsed time or a missing PID.
export class ProcessIntentJournal{
  constructor(directory){this.directory=directory;this.lock=path.join(directory,'active.json');}
  begin(value){try{writeExclusive(this.lock,value);}catch(e){if(e.code==='EEXIST')fail('MANAGER_PRIOR_EXECUTION_UNRECONCILED');throw e;}}
  observe(value){const fd=fs.openSync(this.lock,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW);
    try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>16384)fail('MANAGER_INTENT_INVALID');
      fs.writeFileSync(fd,'\n'+JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
  settle(receipt){
    if(!/^[a-f0-9-]{36}$/.test(receipt?.id??''))fail('MANAGER_RECEIPT_ID_INVALID');
    writeExclusive(path.join(this.directory,`${receipt.id}.receipt.json`),receipt);
    if(receipt.status==='SETTLED'&&receipt.cleanup_observed===true&&receipt.unit_stopped===true&&receipt.main_pid_zero===true&&receipt.cgroup_empty===true){
      fs.unlinkSync(this.lock);syncDirectory(this.directory);
    }
  }
}
const UNIT_PROPERTIES=['Id','LoadState','ActiveState','SubState','Result','MainPID','ExecMainCode','ExecMainStatus','InvocationID','ControlGroup','User','Group','KillMode','NoNewPrivileges','ProtectControlGroups','FragmentPath','Delegate','Slice','RemainAfterExit','Type',
  'ExecStart','WorkingDirectory','DropInPaths','NeedDaemonReload','ExecStartPre','ExecStartPost','ExecCondition','ExecStop','ExecStopPost','ExecReload',
  'Environment','EnvironmentFiles','PassEnvironment','UnsetEnvironment','CapabilityBoundingSet','AmbientCapabilities','SupplementaryGroups',
  'ProtectSystem','ProtectHome','PrivateDevices','PrivateTmp','ProtectProc','RestrictSUIDSGID','LockPersonality','UMask','ReadWritePaths','InaccessiblePaths',
  'RootDirectory','RootImage','BindPaths','BindReadOnlyPaths','TemporaryFileSystem'];
const OMITTED_WHEN_EMPTY=Object.freeze(['ExecStartPre','ExecStartPost','ExecCondition','ExecStop','ExecStopPost','ExecReload','EnvironmentFiles']);
export function fixedUnitName(op){if(!['head','branch','status','tests'].includes(op))fail('MANAGER_FIXED_OPERATION_REQUIRED');return `clued-currentness@${op}.service`;}
export function renderFixedSystemdUnit(c){
  return `[Unit]\nDescription=Clued fixed currentness check (%i)\n[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=${c.job_uid}\nGroup=${c.job_gid}\nSlice=system.slice\nExecStart=${c.node.path} ${c.manager.path} --systemd-job ${CONFIG_PATH} %i\nWorkingDirectory=${c.source_root}\nUnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS NODE_PATH\nCapabilityBoundingSet=\nAmbientCapabilities=\nNoNewPrivileges=yes\nProtectControlGroups=yes\nDelegate=no\nKillMode=control-group\nSendSIGKILL=yes\nTimeoutStartSec=2700s\nTimeoutStopSec=1s\nProtectSystem=strict\nProtectHome=yes\nPrivateDevices=yes\nPrivateTmp=yes\nProtectProc=invisible\nRestrictSUIDSGID=yes\nLockPersonality=yes\nUMask=0027\nReadWritePaths=${c.output_dir} ${c.environment.HOME} ${c.environment.TMPDIR}\nInaccessiblePaths=${INACCESSIBLE.join(' ')}\nStandardOutput=null\nStandardError=null\n`;
}
function fixedWords(actual,expected){return typeof actual==='string'&&actual.trim().split(/\s+/).sort().join('|')===[...expected].sort().join('|');}
export function requireLoadedExecStart(value,c,op){
  // The paths/operation are restricted to unescaped ASCII words. Metadata is
  // systemd's observation, not extra commands or additional argv.
  if(typeof value!=='string'||!/^\{[\s\S]*\}$/.test(value)||value.includes('\n'))fail('MANAGER_LOADED_EXECSTART_UNPROVEN');
  const parts=value.slice(1,-1).split(';').map(s=>s.trim()),fields={};
  for(const part of parts){const at=part.indexOf('=');if(at<1)fail('MANAGER_LOADED_EXECSTART_UNPROVEN');const key=part.slice(0,at);
    if(!['path','argv[]','ignore_errors','start_time','stop_time','pid','code','status'].includes(key)||Object.hasOwn(fields,key))fail('MANAGER_LOADED_EXECSTART_UNPROVEN');fields[key]=part.slice(at+1).trim();}
  const argv=`${c.node.path} ${c.manager.path} --systemd-job ${CONFIG_PATH} ${op}`;
  if(fields.path!==c.node.path||fields['argv[]']!==argv||fields.ignore_errors!=='no'||Object.keys(fields).length!==8||
    !/^[0-9]+$/.test(fields.pid)||/[{}]/.test(Object.values(fields).join('')))fail('MANAGER_LOADED_EXECSTART_UNPROVEN');
}
export function parseSystemdShow(text,c,op){
  if(typeof text!=='string'||Buffer.byteLength(text)>65536)fail('MANAGER_SYSTEMD_REPLY_BOUND');
  const values={};for(const line of text.trimEnd().split('\n')){const at=line.indexOf('=');if(at<1)fail('MANAGER_SYSTEMD_REPLY_INVALID');
    const key=line.slice(0,at);if(!UNIT_PROPERTIES.includes(key)||Object.hasOwn(values,key))fail('MANAGER_SYSTEMD_REPLY_INVALID');values[key]=line.slice(at+1);}
  // systemd 255 omits an empty exec-command list and an empty EnvironmentFiles
  // from `systemctl show`, even with --all. Only for these list properties does
  // absence mean empty; every other property must still be present.
  for(const key of OMITTED_WHEN_EMPTY)if(!Object.hasOwn(values,key))values[key]='';
  if(UNIT_PROPERTIES.some(k=>!Object.hasOwn(values,k))||values.Id!==fixedUnitName(op)||values.LoadState!=='loaded'||values.User!==String(c.job_uid)||values.Group!==String(c.job_gid)||
    values.KillMode!=='control-group'||values.NoNewPrivileges!=='yes'||values.ProtectControlGroups!=='yes'||values.FragmentPath!==UNIT_TEMPLATE||
    values.Delegate!=='no'||values.Slice!=='system.slice'||values.RemainAfterExit!=='yes'||values.Type!=='oneshot'||!/^[0-9]+$/.test(values.MainPID)||
    !/^(?:[a-f0-9]{32})?$/.test(values.InvocationID)||values.ControlGroup&&values.ControlGroup!==`/system.slice/${fixedUnitName(op)}`)fail('MANAGER_SYSTEMD_BOUNDARY_UNPROVEN');
  requireLoadedExecStart(values.ExecStart,c,op);
  const empty=['DropInPaths','ExecStartPre','ExecStartPost','ExecCondition','ExecStop','ExecStopPost','ExecReload','Environment','EnvironmentFiles','PassEnvironment',
    'CapabilityBoundingSet','AmbientCapabilities','SupplementaryGroups','RootDirectory','RootImage','BindPaths','BindReadOnlyPaths','TemporaryFileSystem'];
  if(empty.some(k=>values[k]!=='')||values.WorkingDirectory!==c.source_root||values.NeedDaemonReload!=='no'||
    !fixedWords(values.UnsetEnvironment,['LD_PRELOAD','LD_LIBRARY_PATH','NODE_OPTIONS','NODE_PATH'])||values.ProtectSystem!=='strict'||values.ProtectHome!=='yes'||
    values.PrivateDevices!=='yes'||values.PrivateTmp!=='yes'||values.ProtectProc!=='invisible'||values.RestrictSUIDSGID!=='yes'||values.LockPersonality!=='yes'||values.UMask!=='0027'||
    !fixedWords(values.ReadWritePaths,[c.output_dir,c.environment.HOME,c.environment.TMPDIR])||!fixedWords(values.InaccessiblePaths,INACCESSIBLE))fail('MANAGER_LOADED_UNIT_MISMATCH');
  return values;
}
export function requireStoppedSystemdTree(actual,tree){
  if(actual?.ActiveState!=='inactive'||actual.SubState!=='dead'||actual.MainPID!=='0'||tree?.empty!==true)fail('MANAGER_CLEANUP_UNPROVEN');
  return {actual,tree};
}
async function control(c,verb,op,timeoutMs=1500){
  const args=['--no-ask-password','--no-pager'];
  if(verb==='show')args.push('show',fixedUnitName(op),`--property=${UNIT_PROPERTIES.join(',')}`);
  else if(verb==='start')args.push('start','--no-block',fixedUnitName(op));
  else if(verb==='stop')args.push('stop',fixedUnitName(op));
  else fail('MANAGER_FIXED_SYSTEMD_ACTION_REQUIRED');
  return await new Promise((resolve,reject)=>{
    let timer,parts=[],size=0,problem=null;
    const p=childProcess.spawn(c.systemctl.path,args,{shell:false,env:{...c.environment,NODE_OPTIONS:'',NODE_PATH:''},stdio:['ignore','pipe','pipe']});
    const collect=chunk=>{size+=chunk.length;if(size>65536){problem='MANAGER_SYSTEMD_OUTPUT_BOUND';p.kill('SIGKILL');}else parts.push(chunk);};
    p.stdout.on('data',collect);p.stderr.on('data',collect);
    p.once('error',()=>{clearTimeout(timer);reject(Object.assign(Error('MANAGER_SYSTEMD_CONTROL_UNAVAILABLE'),{code:'MANAGER_SYSTEMD_CONTROL_UNAVAILABLE'}));});
    p.once('close',(code,signal)=>{clearTimeout(timer);if(problem||signal||code!==0)return reject(Object.assign(Error(problem??'MANAGER_SYSTEMD_CONTROL_NOT_AUTHORIZED'),{code:problem??'MANAGER_SYSTEMD_CONTROL_NOT_AUTHORIZED'}));resolve(Buffer.concat(parts).toString('utf8'));});
    timer=setTimeout(()=>{problem='MANAGER_SYSTEMD_CONTROL_UNCERTAIN';p.kill('SIGKILL');reject(Object.assign(Error(problem),{code:problem}));},timeoutMs);
  });
}
function unitTreeEmpty(op){
  const dir=`/sys/fs/cgroup/system.slice/${fixedUnitName(op)}`;
  try{const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022)||Number(fs.statfsSync(dir).type)!==0x63677270)fail('MANAGER_CGROUP_BOUNDARY_UNPROVEN');}
  catch(e){if(e.code==='ENOENT'){const p=fs.lstatSync('/sys/fs/cgroup/system.slice');if(p.uid!==0||(p.mode&0o022))fail('MANAGER_CGROUP_PARENT_UNPROTECTED');return {empty:true,removed:true};}throw e;}
  for(const name of ['cgroup.procs','cgroup.threads']){const s=fs.lstatSync(path.join(dir,name));if(s.uid!==0||(s.mode&0o022))fail('MANAGER_CGROUP_DELEGATION_FORBIDDEN');}
  const empty=fs.readFileSync(path.join(dir,'cgroup.procs'),'utf8').trim()===''&&/^populated 0$/m.test(fs.readFileSync(path.join(dir,'cgroup.events'),'utf8'));
  return {empty,removed:false};
}
function readJobFile(c,op,suffix,cap){
  const file=path.join(c.output_dir,`${op}.${suffix}`),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==c.job_uid||s.gid!==c.job_gid||(s.mode&0o027)||s.nlink!==1||s.size>cap)fail('MANAGER_JOB_OUTPUT_UNPROTECTED');
    const b=fs.readFileSync(fd);if(b.length>cap)fail('MANAGER_JOB_OUTPUT_BOUND');return b;}finally{fs.closeSync(fd);}
}
export function createLinuxProcessManager({configPath=CONFIG_PATH,configSha256}={}){
  let cached;const get=()=>cached??=readConfig(configPath,configSha256).c;
  async function show(c,op){return parseSystemdShow(await control(c,'show',op),c,op);}
  async function observeStopped(c,op){
    const actual=await show(c,op),tree=unitTreeEmpty(op);
    return requireStoppedSystemdTree(actual,tree);
  }
  async function stopAndObserve(c,op){await control(c,'stop',op);return await observeStopped(c,op);}
  async function runManaged(request,{signal}={}){
    const {c}=readConfig(configPath,configSha256),op=selectOperation(c,request),id=randomUUID(),journal=new ProcessIntentJournal(c.state_dir),tree=`linux-systemd:${id}`;
    if(signal?.aborted)fail('MANAGER_ABORTED_BEFORE_START');
    const before=await show(c,op);
    if(before.ActiveState!=='inactive'||before.SubState!=='dead'||before.MainPID!=='0'||!unitTreeEmpty(op).empty)fail('MANAGER_PRIOR_UNIT_UNRECONCILED');
    journal.begin({schema:'clued.currentness-process-intent/2',id,manager_ref:c.manager_ref,tree,operation:op,source_commit:c.source_commit,config_sha256:configSha256,phase:'intent'});
    let reason=null,started=false,final=null,cleaned=null,stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),job=null;
    const abort=()=>{reason??='aborted';};signal?.addEventListener('abort',abort,{once:true});
    const deadline=Date.now()+request.timeoutMs-2500;
    try{
      started=true;await control(c,'start',op);journal.observe({id,phase:'start-sent',unit:fixedUnitName(op)});
      while(!reason&&Date.now()<deadline){
        final=await show(c,op);
        if(final.InvocationID&&final.InvocationID!==before.InvocationID&&(final.ActiveState==='failed'||final.ActiveState==='active'&&final.SubState==='exited'))break;
        await sleep(100);
      }
      if(!final||!final.InvocationID||final.InvocationID===before.InvocationID||!(final.ActiveState==='failed'||final.ActiveState==='active'&&final.SubState==='exited'))reason??='timeout-or-unobserved-exit';
      // Root-observed terminal identity/result must survive stop's property
      // changes. No job-owned output is evidence until the whole tree is empty.
      const completed=final?Object.freeze({...final}):null;
      journal.observe({id,phase:'terminal-observed',invocation_id:completed?.InvocationID??null,result:completed?.Result??null});
      cleaned=await stopAndObserve(c,op);
      if(cleaned.actual.InvocationID&&cleaned.actual.InvocationID!==completed?.InvocationID)reason??='unit-invocation-changed';
      if(!reason){
        job=JSON.parse(readJobFile(c,op,'result.json',16384));stdout=readJobFile(c,op,'stdout',request.maxBytes);stderr=readJobFile(c,op,'stderr',request.maxBytes);
        if(job.schema!=='clued.currentness-systemd-job/1'||job.operation!==op||job.config_sha256!==configSha256||job.invocation_id!==completed.InvocationID||job.source_commit!==c.source_commit||
          job.complete!==true||!Number.isInteger(job.exitCode)||job.exitCode<0||job.exitCode>255||job.exitSignal!==null||stdout.length+stderr.length>request.maxBytes||
          job.stdout_sha256!==hash(stdout)||job.stderr_sha256!==hash(stderr)||job.stdout_bytes!==stdout.length||job.stderr_bytes!==stderr.length||
          (completed.Result==='success')!==(job.exitCode===0))reason='job-result-unproven';
      }
      const receipt={schema:'clued.currentness-process-cleanup/2',domain:'production',manager_ref:c.manager_ref,qualification_ref:c.qualification_ref,
        process_tree_ref:tree,id,unit:fixedUnitName(op),invocation_id:completed?.InvocationID??null,unit_stopped:cleaned.actual.ActiveState==='inactive'&&cleaned.actual.SubState==='dead',
        main_pid_zero:cleaned.actual.MainPID==='0',cgroup_empty:cleaned.tree.empty,
        cleanup_observed:true,status:!reason?'SETTLED':'UNCERTAIN',reason,completed_systemd:completed,systemd:cleaned.actual,cgroup:cleaned.tree,observed_at:new Date().toISOString()};
      const digest=hash(Buffer.from(JSON.stringify(receipt)));journal.settle(receipt);
      return {domain:'production',manager_ref:c.manager_ref,process_tree_ref:tree,cleanupConfirmed:receipt.status==='SETTLED',
        cleanup_receipt_ref:`linux-process-receipt:${id}:${digest}`,exitCode:job?.exitCode??null,exitSignal:job?.exitSignal??null,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8')};
    }catch(e){if(started)try{await stopAndObserve(c,op);}catch{}throw e;}
    finally{signal?.removeEventListener('abort',abort);}
  }
  async function verifyCleanup({receipt_ref,process_tree_ref,domain}){
    const {c}=readConfig(configPath,configSha256),m=/^linux-process-receipt:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(receipt_ref??'');
    if(domain!=='production'||!m)fail('MANAGER_RECEIPT_ID_INVALID');const file=path.join(c.state_dir,`${m[1]}.receipt.json`),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let b;
    try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==c.uid||(s.mode&0o077)||s.nlink!==1||s.size>16384)fail('MANAGER_RECEIPT_INVALID');b=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
    if(hash(b)!==m[2])fail('MANAGER_RECEIPT_HASH_MISMATCH');const r=JSON.parse(b),op=['head','branch','status','tests'].find(op=>fixedUnitName(op)===r.unit);
    if(!op||r.status!=='SETTLED'||r.domain!==domain||r.manager_ref!==c.manager_ref||r.qualification_ref!==c.qualification_ref||r.id!==m[1]||r.process_tree_ref!==process_tree_ref||r.cleanup_observed!==true)fail('MANAGER_CLEANUP_UNPROVEN');
    const live=await observeStopped(c,op);
    if(live.actual.InvocationID&&live.actual.InvocationID!==r.invocation_id)fail('MANAGER_RECEIPT_INVOCATION_CHANGED');
    return {status:'VERIFIED',domain,manager_ref:c.manager_ref,process_tree_ref,receipt_ref};
  }
  return Object.freeze({get ref(){return get().manager_ref;},get qualificationRef(){return get().qualification_ref;},runManaged,verifyCleanup});
}
function writeJobFile(c,op,suffix,bytes){
  const file=path.join(c.output_dir,`${op}.${suffix}`),fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==c.job_uid||s.gid!==c.job_gid||(s.mode&0o027)||s.nlink!==1)fail('MANAGER_JOB_OUTPUT_UNPROTECTED');
    fs.ftruncateSync(fd,0);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
async function systemdJob(configPath,op){
  const {c,digest}=readConfig(configPath,null,true),unit=fixedUnitName(op),invocation=process.env.INVOCATION_ID;
  if(!/^[a-f0-9]{32}$/.test(invocation??'')||!fs.readFileSync('/proc/self/cgroup','utf8').split('\n').includes(`0::/system.slice/${unit}`))fail('MANAGER_HOST_PLACEMENT_UNPROVEN');
  for(const name of ['cgroup.procs','cgroup.threads']){const s=fs.lstatSync(`/sys/fs/cgroup/system.slice/${unit}/${name}`);if(s.uid!==0||(s.mode&0o022))fail('MANAGER_CGROUP_DELEGATION_FORBIDDEN');}
  for(const suffix of ['stdout','stderr','result.json'])writeJobFile(c,op,suffix,Buffer.alloc(0));
  const cmd=command(c,op),out=[],err=[];let size=0,overflow=false;
  const p=childProcess.spawn(cmd.file,cmd.args,{cwd:cmd.cwd,env:{...c.environment,NODE_OPTIONS:'',NODE_PATH:''},shell:false,stdio:['ignore','pipe','pipe']});
  const collect=target=>chunk=>{size+=chunk.length;if(size>64*1024*1024){overflow=true;p.kill('SIGKILL');}else target.push(chunk);};
  p.stdout.on('data',collect(out));p.stderr.on('data',collect(err));
  const result=await new Promise(resolve=>{p.once('error',()=>resolve({exitCode:1,exitSignal:null}));p.once('exit',(code,signal)=>resolve({exitCode:code,exitSignal:signal}));});
  // Close means all captured output is drained; a pipe-holding descendant must
  // be stopped by PID1/outer timeout instead of fabricating a complete record.
  if(p.stdout.readableEnded===false||p.stderr.readableEnded===false)await new Promise(resolve=>p.once('close',resolve));
  if(overflow||!Number.isInteger(result.exitCode)||result.exitSignal)fail('MANAGER_JOB_INCOMPLETE');
  const stdout=Buffer.concat(out),stderr=Buffer.concat(err);
  writeJobFile(c,op,'stdout',stdout);writeJobFile(c,op,'stderr',stderr);
  writeJobFile(c,op,'result.json',Buffer.from(JSON.stringify({schema:'clued.currentness-systemd-job/1',operation:op,source_commit:c.source_commit,config_sha256:digest,
    invocation_id:invocation,complete:true,...result,stdout_sha256:hash(stdout),stderr_sha256:hash(stderr),stdout_bytes:stdout.length,stderr_bytes:stderr.length})));
  process.exitCode=result.exitCode;
}
if(process.argv[1]&&path.resolve(process.argv[1])===SELF){
  if(process.argv.length===5&&process.argv[2]==='--systemd-job')systemdJob(...process.argv.slice(3)).catch(()=>{process.exitCode=1;});
  else{process.stdout.write('{"status":"BLOCKED","code":"PROTECTED_SYSTEMD_CONFIG_AND_PUBLISHER_REQUIRED"}\n');process.exitCode=1;}
}
