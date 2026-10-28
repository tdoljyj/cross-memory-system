// Fixed existing-release installation/runtime files. Import performs no I/O.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
export const BASE='/opt/clued-production-release-v3',PACKAGE='/root/clued-existing-release-v3-install';
export const CONTEXT='/etc/clued-production-release/existing-release.json',ROOT='/var/lib/clued-production-release',RUN=ROOT+'/run';
export const SOURCE='/srv/clued-production-release/source',APP=SOURCE+'/apps/clued-cloud',SECRETS='/etc/clued-production-release/secrets';
export const INPUT='apps/clued-cloud/.sites-runtime/release-inputs/build-files.json';
export const CONNECT='apps/clued-cloud/.sites-runtime/release-inputs/connect/worker.mjs';
export const WRANGLER='apps/clued-cloud/node_modules/wrangler/bin/wrangler.js';
export const PAYLOAD=Object.freeze([
 'release/verify-currentness-external.mjs','release/linux-process-manager.mjs',
 'release/existing-release-entry-v1/fixed-currentness-ports.mjs',
 'release/existing-release-entry-v1/v3/existing-stages.mjs',
 'release/existing-release-entry-v1/v3-host/host-files.mjs',
 'release/existing-release-entry-v1/v3-host/release-once.mjs',
]);
export const HASH=/^[a-f0-9]{64}$/;
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const fail=code=>{throw Object.assign(new Error(code),{code});};
export const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export function parents(file){for(let p=path.dirname(file);;p=path.dirname(p)){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('ROOT_PROTECTED_PARENT_REQUIRED');if(p==='/')break;}}
export function protectedBytes(file,max=128*1024*1024){
 parents(file);const a=fs.lstatSync(file);
 if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1||a.uid!==0||(a.mode&0o022)||a.size>max)fail('PROTECTED_FILE_REQUIRED');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const held=fs.fstatSync(fd),b=fs.readFileSync(fd);if(!same(a,held)||b.length!==a.size||!same(held,fs.lstatSync(file)))fail('PROTECTED_FILE_CHANGED');return b;}finally{fs.closeSync(fd);}
}
export function utf8(b){const s=b.toString('utf8');if(!Buffer.from(s).equals(b))fail('STRICT_UTF8_REQUIRED');return s;}
export function contextStructure(c){
 const keys=['contract','repository','sourceCommit','sourceRoot','publisherUid','publisherGid','acceptedAt','expiresAt','node','git','managerConfigSha256','sourcePins'];
 if(!c||Object.keys(c).sort().join('|')!==keys.sort().join('|')||c.contract!=='clued.existing-release-context/2'||c.repository!=='tdoljyj/cross-memory-system'||!/^[a-f0-9]{40}$/.test(c.sourceCommit??'')||c.sourceRoot!==SOURCE||!Number.isSafeInteger(c.publisherUid)||c.publisherUid<1||!Number.isSafeInteger(c.publisherGid)||c.publisherGid<1||!HASH.test(c.managerConfigSha256??''))fail('ACTUAL_PUBLIC_CONTEXT_REQUIRED');
 for(const k of ['node','git'])if(!c[k]||Object.keys(c[k]).sort().join('|')!=='path|sha256'||!/^\/[A-Za-z0-9_./+-]+$/.test(c[k].path)||!HASH.test(c[k].sha256))fail('ACTUAL_RUNTIME_PIN_REQUIRED');
 if(!c.sourcePins||typeof c.sourcePins!=='object'||Array.isArray(c.sourcePins))fail('SOURCE_PINS_REQUIRED');return c;
}
export function readContext(expected,{install=false}={}){
 if(process.platform!=='linux'||!HASH.test(expected??''))fail('LINUX_REVIEWED_CONTEXT_REQUIRED');
 const b=protectedBytes(install?PACKAGE+'/existing-release.json':CONTEXT,1024*1024);if(hash(b)!==expected)fail('REVIEWED_CONTEXT_CHANGED');
 const c=contextStructure(JSON.parse(utf8(b))),a=Date.parse(c.acceptedAt),e=Date.parse(c.expiresAt);
 if(!Number.isFinite(a)||!Number.isFinite(e)||a>Date.now()||e<=Date.now()||e-a>7200000)fail('REVIEWED_WINDOW_EXPIRED');
 if(c.node.path!==process.execPath||hash(protectedBytes(c.node.path))!==c.node.sha256||hash(protectedBytes(c.git.path))!==c.git.sha256)fail('REVIEWED_RUNTIME_CHANGED');
 if(install?process.getuid()!==0||process.getgid()!==0:process.getuid()!==c.publisherUid||process.getgid()!==c.publisherGid)fail('ACTUAL_PRINCIPAL_REQUIRED');
 for(const [p,h] of Object.entries(c.sourcePins)){
  if(!/^[A-Za-z0-9_./-]+$/.test(p)||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..')||!HASH.test(h)||hash(protectedBytes(path.join(SOURCE,p)))!==h)fail('REVIEWED_SOURCE_CHANGED');
 }
 for(const p of [INPUT,WRANGLER,'apps/clued-cloud/wrangler.production.jsonc','apps/clued-cloud/wrangler.pdf-extractor.jsonc','apps/kooyumi-connect/wrangler.production.jsonc','apps/clued-cloud/scripts/verify-served-agent-contract.mjs','apps/clued-cloud/scripts/verify-pdf-extractor.mjs','apps/kooyumi-connect/verify-production.mjs'])if(!HASH.test(c.sourcePins[p]??''))fail('EXISTING_RELEASE_SOURCE_PIN_REQUIRED');
 return c;
}
export function verifyPackage(expected,{install=false}={}){
 const root=install?PACKAGE:BASE,b=protectedBytes(root+'/package-manifest.json',1024*1024);
 if(!HASH.test(expected??'')||hash(b)!==expected)fail('REVIEWED_PACKAGE_CHANGED');
 const m=JSON.parse(utf8(b)),names=['install-once.mjs',...PAYLOAD.map(p=>'payload/'+p)];
 if(m.contract!=='clued.existing-release-v3-host-package/1'||!m.files||Object.keys(m.files).sort().join('|')!==names.sort().join('|'))fail('FIXED_PACKAGE_CLOSURE_REQUIRED');
 for(const name of names){const f=install?root+'/'+name:root+'/'+name.replace(/^payload\//,'');const a=protectedBytes(f),p=m.files[name];if(p?.bytes!==a.length||p.sha256!==hash(a))fail('PACKAGE_SOURCE_CHANGED');}
 return m;
}
export function safeEnv(c){return {PATH:path.dirname(c.node.path)+':'+path.dirname(c.git.path)+':/usr/bin:/bin',HOME:ROOT+'/publisher-home',TMPDIR:ROOT+'/publisher-tmp',LANG:'C',LC_ALL:'C',NODE_OPTIONS:'',NODE_PATH:'',XDG_CONFIG_HOME:ROOT+'/publisher-home',WRANGLER_LOG_PATH:ROOT+'/run/wrangler.log'};}
export function exactMain(c){for(const [args,want] of [[['rev-parse','HEAD'],c.sourceCommit],[['branch','--show-current'],'main'],[['status','--porcelain','--untracked-files=all'],'']]){const r=spawnSync(c.git.path,args,{cwd:SOURCE,env:safeEnv(c),encoding:'utf8',maxBuffer:65536,timeout:30000});if(r.error||r.status!==0||r.stdout.trim()!==want)fail('REAL_CLEAN_EXACT_MAIN_REQUIRED');}}
export function privateDirectory(dir,uid){parents(dir);const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o777)!==0o700)fail('PRIVATE_RUNTIME_DIRECTORY_REQUIRED');return s;}
export function writeOnce(leaf,value){
 if(!/^[a-z0-9-]+\.(json|stdout|stderr)$/.test(leaf))fail('FIXED_PRIVATE_RECEIPT_NAME_REQUIRED');
 const before=privateDirectory(RUN,process.getuid()),d=fs.openSync(RUN,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let fd;
 try{if(!same(before,fs.fstatSync(d)))fail('RUN_DIRECTORY_CHANGED');fd=fs.openSync(path.join(RUN,leaf),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value)+'\n');fs.fsyncSync(fd);if(!same(before,privateDirectory(RUN,process.getuid())))fail('RUN_DIRECTORY_CHANGED');fs.fsyncSync(d);}finally{if(fd!==undefined)fs.closeSync(fd);fs.closeSync(d);}
}
export function readSecret(leaf){
 if(!['cloudflare-deploy-token','cloudflare-account-id','attestation-database-url'].includes(leaf))fail('FIXED_CREDENTIAL_REQUIRED');
 const p=SECRETS+'/'+leaf,b=protectedBytes(p,8192),s=fs.lstatSync(p),v=utf8(b);
 if(s.gid!==process.getgid()||(s.mode&0o777)!==0o440||!v||v!==v.trim()||/[\r\n\x00]/.test(v))fail('FIXED_CREDENTIAL_BOUNDARY_REQUIRED');return v;
}
export function verifyBuildFiles(c){
 const m=JSON.parse(utf8(protectedBytes(SOURCE+'/'+INPUT,16*1024*1024)));
 if(m.contract!=='clued.existing-release-build-files/1'||m.sourceCommit!==c.sourceCommit||!m.files||typeof m.files!=='object'||Array.isArray(m.files))fail('ACTUAL_SAME_COMMIT_BUILD_FILES_REQUIRED');
 const roots=['apps/clued-cloud/dist/server','apps/clued-cloud/dist/client','apps/clued-cloud/dist/pdf-extractor'],seen=new Set();
 function walk(rel){const p=SOURCE+'/'+rel,s=fs.lstatSync(p);if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('ROOT_PROTECTED_BUILD_REQUIRED');if(s.isDirectory()){for(const name of fs.readdirSync(p)){if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\'))fail('BUILD_PATH_INVALID');walk(rel+'/'+name);}}else{const b=protectedBytes(p);if(m.files[rel]!==hash(b))fail('BUILD_FILE_CHANGED');seen.add(rel);}}
 for(const p of roots)walk(p);const connect=protectedBytes(SOURCE+'/'+CONNECT);if(m.files[CONNECT]!==hash(connect)||!utf8(connect).startsWith('const KOOYUMI_RELEASE_COMMIT='+JSON.stringify(c.sourceCommit)+';\n'))fail('SAME_COMMIT_CONNECT_BUILD_REQUIRED');seen.add(CONNECT);
 if(seen.size<4||seen.size>100000||Object.keys(m.files).some(p=>!seen.has(p)))fail('EXACT_BUILD_FILE_CLOSURE_REQUIRED');
 if(!seen.has('apps/clued-cloud/dist/server/index.js')||!seen.has('apps/clued-cloud/dist/pdf-extractor/index.js'))fail('REQUIRED_WORKER_ARTIFACT_MISSING');return {sourceCommit:c.sourceCommit,fileCount:seen.size,manifestSha256:c.sourcePins[INPUT]};
}
// WSL interop starts a Windows process for anyone who can reach a
// /run/WSL/*_interop socket, and PrivateDevices=yes still binds the Host's
// /dev/shm. The release unit makes both inaccessible ('-': no /run/WSL, no interop).
export const INACCESSIBLE=Object.freeze(['-/run/WSL','/dev/shm']);
export function interopBoundary(access=(dir,mode)=>fs.accessSync(dir,mode)){
 for(const dir of INACCESSIBLE.map(p=>p.replace(/^-/,'')))for(const mode of [fs.constants.R_OK,fs.constants.X_OK]){
  try{access(dir,mode);}catch(e){if(e.code==='EACCES'||e.code==='ENOENT')continue;throw e;}
  fail('WSL_INTEROP_OR_SHM_REACHABLE');
 }
}
export function renderPublisherUnit(c,manager,contextSha,packageSha){
 return ['[Unit]','Description=Clued existing exact-main release once','[Service]','Type=exec','User='+c.publisherUid,'Group='+c.publisherGid,'SupplementaryGroups='+manager.job_gid,
 'ExecStart='+c.node.path+' '+BASE+'/release/existing-release-entry-v1/v3-host/release-once.mjs --execute-once --fixed-scope existing-production-release-v3-host --reviewed-context-sha256 '+contextSha+' --reviewed-package-sha256 '+packageSha,
 'WorkingDirectory='+ROOT,'UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH NODE_OPTIONS NODE_PATH GITHUB_ACTIONS GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_JOB',
 'Environment=PATH='+safeEnv(c).PATH,'Environment=HOME='+ROOT+'/publisher-home','Environment=TMPDIR='+ROOT+'/publisher-tmp',
 'NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','ProtectControlGroups=yes','Delegate=no','KillMode=control-group','SendSIGKILL=yes','TimeoutStopSec=30s','RuntimeMaxSec=7200s','Restart=no',
 'ProtectSystem=strict','ProtectHome=yes','PrivateDevices=yes','PrivateTmp=yes','ProtectProc=invisible','RestrictSUIDSGID=yes','LockPersonality=yes','UMask=0077',
 'ReadWritePaths='+[RUN,ROOT+'/currentness-evidence',ROOT+'/publisher-home',ROOT+'/publisher-tmp',manager.state_dir,APP+'/.wrangler'].join(' '),
 'InaccessiblePaths='+INACCESSIBLE.join(' '),
 'StandardOutput=journal','StandardError=journal',''].join('\n');
}
