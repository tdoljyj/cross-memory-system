// Fixed create-only Linux configuration glue. No qualification issuer, private
// key read, container start, service change, network request or Check publisher.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createPublicKey,verify} from 'node:crypto';
import {protectedPath,validatePolicyShape} from '../qualification.mjs';
import {FIXED_ROLE_POLICIES,validateSelectedFacts,loadFixedRolePolicy,boundedGitObservation,validateTreePins,SERIAL_LOCK} from '../formal-fixed-role-policy-v2/policy.mjs';
import {linuxReadiness} from '../linux-launcher.mjs';
import {inspectChecksBundle,validateChecksBundle,inspectDatabase,databaseDecision} from '../required-trivy-v2/plans.mjs';
import {atomicNew,readBounded,decode,sha,canonical,syncDir} from '../../host/linux-verify-config-v2/public-files.mjs';

export const ROLES=Object.freeze(['gitleaks','trivy','contract-placement']);
export const INPUT='/etc/clued-independent-ci/formal-install-input-v1';
export const MANIFEST='/etc/clued-independent-ci/formal-source-manifest-v1.json';
export const LOCK='/etc/clued-independent-ci/linux-formal-install-v1.lock';
export const RECEIPT='/etc/clued-independent-ci/linux-formal-install-v1.receipt.json';
export const NODE='/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node';
export const PUBLIC='/etc/clued-independent-ci/verify-result-public.pem';
export const KEY='/etc/clued-independent-ci/verify-result-key.pem';
export const PUBLIC_SHA='a8bc91a25b167b2d722184b518d4771a30e28bd47dcc9efaa9e1806a5bc615c1';
const PREFIX='work/actions-hosted-migration/independent-ci-v1/';
export const INSTALLER_SOURCES=Object.freeze([PREFIX+'worker/linux-formal-install-v1/install.mjs',PREFIX+'host/linux-verify-config-v2/public-files.mjs']);
const RUNTIME=Object.freeze({[NODE]:'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12','/usr/bin/git':'2a8c18fbf43da9f692d75474c72bea9dfd796c260b0f3dfe456376abc3bbd668','/usr/bin/docker':'7ed12b00293d64742419a6601ae97960a367a0ce97c88b06e3278cc0a409557b'});
const HASH=/^[a-f0-9]{64}$/,safe=p=>typeof p==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(p)&&path.posix.normalize(p)===p&&p!=='/';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(ok,code)=>{if(!ok)fail(code);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const qualificationPath=role=>'/etc/clued-independent-ci/roles/'+role+'.qualification.json';
const targets=()=>[MANIFEST,...ROLES.map(qualificationPath),...ROLES.map(r=>FIXED_ROLE_POLICIES[r]),RECEIPT];
const finiteTime=t=>typeof t==='string'&&Number.isFinite(Date.parse(t));

export function validatePlan(p,now=Date.now()){
  check(exact(p,['contract','enabled','accepted','exclusiveHostWriter','ownerAcceptanceRef','acceptedAt','expiresAt','sourceRoot','sourceCommit','sourceManifestSha256','installerSourceFiles','roles','cache']),'EXACT_INSTALL_PLAN_REQUIRED');
  check(p.contract==='clued.independent-ci.linux-formal-install/1'&&p.enabled===true&&p.accepted===true&&p.exclusiveHostWriter===true,'FORMAL_INSTALL_DISABLED');
  check(typeof p.ownerAcceptanceRef==='string'&&p.ownerAcceptanceRef.length>10&&p.ownerAcceptanceRef.length<=1000&&!/[\x00-\x1f]/.test(p.ownerAcceptanceRef),'REAL_OWNER_ACCEPTANCE_REQUIRED');
  check(finiteTime(p.acceptedAt)&&finiteTime(p.expiresAt)&&Date.parse(p.acceptedAt)<=now&&Date.parse(p.expiresAt)>now,'INSTALL_ACCEPTANCE_EXPIRED');
  check(safe(p.sourceRoot)&&p.sourceRoot!=='/etc'&&!p.sourceRoot.startsWith('/etc/')&&/^[a-f0-9]{40}$/.test(p.sourceCommit??'')&&HASH.test(p.sourceManifestSha256??''),'EXACT_COMMITTED_SOURCE_REQUIRED');
  check(Array.isArray(p.installerSourceFiles)&&p.installerSourceFiles.length===INSTALLER_SOURCES.length&&INSTALLER_SOURCES.every(f=>p.installerSourceFiles.filter(x=>exact(x,['path','sha256'])&&x.path===f&&HASH.test(x.sha256??'')).length===1),'INSTALLER_SOURCE_PINS_REQUIRED');
  check(exact(p.roles,ROLES)&&ROLES.every(r=>exact(p.roles[r],['policySha256','qualificationSha256','jobSha256'])&&Object.values(p.roles[r]).every(h=>HASH.test(h??''))),'THREE_EXACT_ROLE_INPUT_PINS_REQUIRED');
  check(exact(p.cache,['root','dbPointerSha256','checksPointerSha256'])&&safe(p.cache.root)&&HASH.test(p.cache.dbPointerSha256??'')&&HASH.test(p.cache.checksPointerSha256??''),'INSTALLED_CACHE_PINS_REQUIRED');
  return p;
}

// Pre-write signature/binding check mirrors the existing loader. After install,
// the unmodified loadFixedRolePolicy remains the authoritative runtime check.
export function validateSignedQualification(envelope,config,publicBytes,now=Date.now()){
  check(exact(envelope,['payload','signature'])&&typeof envelope.signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)&&Buffer.from(envelope.signature,'base64').length===64,'QUALIFICATION_ENVELOPE_REQUIRED');
  const key=createPublicKey(publicBytes);
  check(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(envelope.payload)),key,Buffer.from(envelope.signature,'base64')),'EXTERNAL_QUALIFICATION_SIGNATURE_REFUSED');
  const q=envelope.payload;
  check(q?.schema==='independent-ci.runtime-qualification.v1'&&q.fixture===false&&q.role===config.role,'EXACT_ROLE_QUALIFICATION_REQUIRED');
  for(const name of ['runtimeIdentity','sourceManifestSha256','image','entrySha256','launcherSha256','qualificationSha256','executionMode','workerSha256','proofSha256','queueSha256','keyId','hostAcceptanceRef','sourceAcceptanceRef'])check(q[name]===config[name],'QUALIFICATION_BINDING_REFUSED');
  check(q.resultPublicKeySha256===sha(publicBytes)&&q.isolation==='root-managed-single-job-container'&&['prCannotReadSignerKey','noControllerMounts','noCredentials','networkDisabled','cleanupQualified'].every(k=>q[k]===true),'ISOLATION_QUALIFICATION_REQUIRED');
  if(config.executionMode==='node-entry')check(q.containerNodeExecutable===config.containerNodeExecutable&&q.containerNodeSha256===config.containerNodeSha256,'QUALIFIED_CONTAINER_NODE_REQUIRED');
  check(['hostAcceptanceRef','sourceAcceptanceRef'].every(k=>typeof q[k]==='string'&&q[k].length>10)&&finiteTime(q.qualifiedAt)&&finiteTime(q.expiresAt)&&Date.parse(q.qualifiedAt)<=now&&Date.parse(q.expiresAt)>now,'REAL_CURRENT_ACCEPTANCE_REQUIRED');
  return q;
}

export function validateRoleInputs(plan,manifestBytes,role,policyBytes,qualificationBytes,jobBytes,publicBytes,now=Date.now()){
  check(ROLES.includes(role),'FIXED_ROLE_REQUIRED');
  const pins=plan.roles[role];
  check(sha(policyBytes)===pins.policySha256&&sha(qualificationBytes)===pins.qualificationSha256&&sha(jobBytes)===pins.jobSha256&&sha(manifestBytes)===plan.sourceManifestSha256,'ACCEPTED_INPUT_BYTES_CHANGED');
  const config=decode(policyBytes),qualification=decode(qualificationBytes),job=decode(jobBytes),manifest=decode(manifestBytes);
  validatePolicyShape(config);
  check(config.role===role&&config.trustedSourceDirectory===plan.sourceRoot&&config.sourceManifestFile===MANIFEST&&config.sourceManifestSha256===plan.sourceManifestSha256&&manifest.sourceSha===plan.sourceCommit,'ONE_SOURCE_MANIFEST_REQUIRED');
  check(config.nodeExecutable===NODE&&config.gitExecutable==='/usr/bin/git'&&config.dockerExecutable==='/usr/bin/docker'&&config.nodeExecutableSha256===RUNTIME[NODE]&&config.gitExecutableSha256===RUNTIME['/usr/bin/git']&&config.dockerExecutableSha256===RUNTIME['/usr/bin/docker'],'FIXED_OBSERVED_EXECUTABLES_REQUIRED');
  check(config.entryFile===plan.sourceRoot+'/'+PREFIX+'worker/protected-job-bridge-v3/linux-worker.mjs'&&config.qualificationFile===qualificationPath(role)&&config.publicKeyFile===PUBLIC&&config.signingKeyFile===KEY&&sha(publicBytes)===PUBLIC_SHA,'FIXED_FORMAL_PATHS_REQUIRED');
  check(job.role===role&&Date.parse(job.createdAt)<=now,'ACTUAL_ROLE_JOB_REQUIRED');
  validateSignedQualification(qualification,config,publicBytes,now);
  const facts=validateSelectedFacts(job,{config,sourceManifestBytes:manifestBytes,qualification},now);
  if(role==='trivy')check(facts.role.formalTrivy.cacheRoot===plan.cache.root,'ACTUAL_CACHE_ROOT_CHANGED');
  return{role,config,qualification,job,manifest,facts,policyBytes,qualificationBytes,jobBytes};
}

async function absent(filename){try{await fs.lstat(filename);fail('EXISTING_TARGET_PRESERVED_NO_RETRY');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function pinnedInput(name,pin,max=1048576){const filename=INPUT+'/'+name;await protectedPath(filename,{privateFile:true});const b=await readBounded(filename,max);check(sha(b)===pin,'ACCEPTED_INPUT_BYTES_CHANGED');return b;}
async function git(sourceRoot,args){
  const child=spawn('/usr/bin/git',['--no-optional-locks','--git-dir='+sourceRoot+'/.git','--work-tree='+sourceRoot,'-c','core.fsmonitor=false','-c','core.hooksPath=/nonexistent-independent-ci-hooks',...args],{cwd:sourceRoot,shell:false,env:{LANG:'C',LC_ALL:'C',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:''},stdio:['ignore','pipe','pipe']});
  return boundedGitObservation(child);
}
async function cleanSource(plan,rows){
  check(fileURLToPath(import.meta.url)===plan.sourceRoot+'/'+INSTALLER_SOURCES[0],'INSTALLER_OUTSIDE_ACCEPTED_CHECKOUT');
  await protectedPath(plan.sourceRoot,{directory:true});await protectedPath(plan.sourceRoot+'/.git',{directory:true});
  await protectedPath(plan.sourceRoot+'/.git/config');const cfg=await readBounded(plan.sourceRoot+'/.git/config');
  check(!/^\s*\[(include|includeIf|filter|extensions)\b/im.test(cfg.toString('utf8')),'UNSAFE_SOURCE_GIT_CONFIG');
  for(const n of ['shallow','commondir','objects/info/alternates','objects/info/http-alternates','info/grafts'])await absent(plan.sourceRoot+'/.git/'+n);
  check((await git(plan.sourceRoot,['rev-parse','--verify','HEAD^{commit}'])).trim()===plan.sourceCommit,'ACTUAL_SOURCE_COMMIT_CHANGED');
  const pins=new Map();for(const pin of [...plan.installerSourceFiles,...rows.flatMap(r=>r.facts.role.sourceFiles)]){if(pins.has(pin.path))check(pins.get(pin.path).sha256===pin.sha256,'SOURCE_PIN_CONFLICT');pins.set(pin.path,pin);}
  const tree=validateTreePins(await git(plan.sourceRoot,['ls-tree','-r','-z','--full-tree',plan.sourceCommit]),[...pins.values()]);
  for(const pin of pins.values()){const filename=plan.sourceRoot+'/'+pin.path;await protectedPath(filename);check(sha(await readBounded(filename))===pin.sha256&&(await git(plan.sourceRoot,['hash-object','--no-filters','--',pin.path])).trim()===tree.get(pin.path),'ACTUAL_TRACKED_SOURCE_CHANGED');}
  check((await git(plan.sourceRoot,['status','--porcelain=v1','--untracked-files=all'])).trim()==='','DIRTY_SOURCE_NOT_ACCEPTED');
}
async function immutableTree(directory){await protectedPath(directory,{directory:true});const root=await fs.lstat(directory);check(!(root.mode&0o222),'CACHE_GENERATION_NOT_SEALED');for(const e of await fs.readdir(directory,{withFileTypes:true})){const f=directory+'/'+e.name;if(e.isDirectory())await immutableTree(f);else{const s=await protectedPath(f);check(!(s.mode&0o222),'CACHE_GENERATION_NOT_SEALED');}}}
async function cacheReadback(plan,trivy){
  const root=plan.cache.root;await protectedPath(root,{directory:true});await absent(root+'/prepare.lock');
  const rows=[];
  for(const [kind,name,pin] of [['db','current.json',plan.cache.dbPointerSha256],['checks','checks-current.json',plan.cache.checksPointerSha256]]){
    const filename=root+'/'+name;await protectedPath(filename,{privateFile:true});const b=await readBounded(filename,65536);check(sha(b)===pin,'CACHE_POINTER_BYTES_CHANGED');const p=decode(b);
    check(p.contract===(kind==='db'?'clued.independent-ci.trivy-cache-generation/1':'clued.independent-ci.trivy-checks-generation/1')&&safe(p.directory)&&path.posix.dirname(p.directory)===root+'/generations'&&new RegExp('^gen-'+kind+'-[a-f0-9]{64}$').test(path.posix.basename(p.directory)),'FIXED_GENERATION_REQUIRED');
    await immutableTree(p.directory);
    const facts=kind==='db'?await inspectDatabase(p.directory):await inspectChecksBundle(p.directory);
    if(kind==='db'){check(facts.sha256===p.dbSha256&&facts.metadataSha256===p.dbMetadataSha256&&databaseDecision({current:facts}).status==='READY','CURRENT_DATABASE_REQUIRED');}
    else{validateChecksBundle(facts,trivy.facts.role.formalTrivy.checksPin);check(facts.metadataSha256===p.metadataSha256&&facts.contentSha256===p.contentSha256&&facts.metadata.Digest===p.digest,'CURRENT_CHECKS_REQUIRED');}
    check(sha(await readBounded(filename,65536))===pin,'CACHE_POINTER_CHANGED_DURING_READ');rows.push({kind,pointerSha256:pin,directory:p.directory});
  }
  return rows;
}

export async function install(planSha256){
  check(HASH.test(planSha256??''),'ACCEPTED_PLAN_SHA256_REQUIRED');
  check(process.platform==='linux'&&process.getuid?.()===0&&process.execPath===NODE&&process.execArgv.length===0&&!process.env.NODE_OPTIONS&&!process.env.NODE_PATH,'FIXED_ROOT_NODE_REQUIRED');
  await protectedPath(INPUT,{directory:true});const planBytes=await pinnedInput('install-plan.json',planSha256,65536),plan=validatePlan(decode(planBytes));
  for(const [filename,pin] of Object.entries(RUNTIME)){await protectedPath(filename);check(sha(await readBounded(filename,268435456))===pin,'OBSERVED_RUNTIME_DRIFT');}
  await protectedPath(KEY,{privateFile:true});await protectedPath(PUBLIC);const publicBytes=await readBounded(PUBLIC,16384);check(sha(publicBytes)===PUBLIC_SHA,'RESULT_PUBLIC_KEY_CHANGED');
  const manifestBytes=await pinnedInput('source-manifest.json',plan.sourceManifestSha256),rows=[];
  for(const role of ROLES){const p=plan.roles[role];rows.push(validateRoleInputs(plan,manifestBytes,role,await pinnedInput(role+'.policy.json',p.policySha256),await pinnedInput(role+'.qualification.json',p.qualificationSha256),await pinnedInput(role+'.job.json',p.jobSha256),publicBytes));}
  const context=rows[0].job;check(rows.every(r=>['repo','pr','headSha','baseSha','claimId','fence','epoch','sourceManifestSha256'].every(k=>r.job[k]===context[k])),'ONE_ACTUAL_PR_CONTEXT_REQUIRED');
  await cleanSource(plan,rows);const cache=await cacheReadback(plan,rows.find(r=>r.role==='trivy'));
  for(const r of rows){for(const k of ['workspaceRoot','runsRoot'])await protectedPath(r.config[k],{directory:true});validateSelectedFacts(r.job,{config:r.config,sourceManifestBytes:manifestBytes,qualification:r.qualification});}
  await protectedPath('/etc/clued-independent-ci',{directory:true});await absent(SERIAL_LOCK);await absent(LOCK);for(const t of targets())await absent(t);
  const roleDir='/etc/clued-independent-ci/roles';try{await protectedPath(roleDir,{directory:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  validatePlan(plan);check(sha(await pinnedInput('install-plan.json',planSha256,65536))===planSha256,'INSTALL_PLAN_CHANGED');
  const created=[];let locked=false,lockAttempted=false;
  try{
    lockAttempted=true;await atomicNew(LOCK,Buffer.from(canonical({contract:'clued.independent-ci.linux-formal-install-intent/1',planSha256,ownerAcceptanceRef:plan.ownerAcceptanceRef,sourceCommit:plan.sourceCommit,targets:targets(),automaticRetryAllowed:false})+'\n'));locked=true;
    try{await fs.lstat(roleDir);}catch(e){if(e.code!=='ENOENT')throw e;await fs.mkdir(roleDir,{mode:0o700});created.push(roleDir);await syncDir('/etc/clued-independent-ci');}await protectedPath(roleDir,{directory:true});
    async function put(target,b,mode=0o600){await atomicNew(target,b,mode);created.push(target);await protectedPath(target,{privateFile:mode===0o600});check((await readBounded(target)).equals(b),'INSTALLED_BYTES_UNCONFIRMED');}
    // Source and qualifications first; formal policy names are published last.
    await put(MANIFEST,manifestBytes,0o644);for(const r of rows)await put(qualificationPath(r.role),r.qualificationBytes);
    for(const r of rows){validatePlan(plan);validateSelectedFacts(r.job,{config:r.config,sourceManifestBytes:manifestBytes,qualification:r.qualification});await absent(SERIAL_LOCK);await put(FIXED_ROLE_POLICIES[r.role],r.policyBytes);}
    const readiness=[];for(const r of rows){const ready=await linuxReadiness(FIXED_ROLE_POLICIES[r.role]);check(ready.status==='READY'&&ready.actualContainerExecuted===false,'ROLE_READINESS_UNCONFIRMED');await loadFixedRolePolicy(r.job);readiness.push({role:r.role,...ready});}
    for(const r of rows)validateSelectedFacts(r.job,{config:r.config,sourceManifestBytes:manifestBytes,qualification:r.qualification});validatePlan(plan);await absent(SERIAL_LOCK);
    const receipt={contract:'clued.independent-ci.linux-formal-config-install/1',status:'INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED',planSha256,sourceCommit:plan.sourceCommit,sourceManifestSha256:plan.sourceManifestSha256,ownerAcceptanceRef:plan.ownerAcceptanceRef,created:[...created],readiness,cache,observedAt:new Date().toISOString(),privateKeyRead:false,qualificationIssued:false,containerExecuted:false,serviceStarted:false,checksWritten:false,automaticRetryAllowed:false};
    await put(RECEIPT,Buffer.from(canonical(receipt)+'\n'));return receipt;
  }catch(e){throw Object.assign(e,{status:lockAttempted?'PARTIAL_OR_UNKNOWN_INSTALL_PRESERVED_NO_RETRY':'BLOCKED_BEFORE_INSTALL',created,lockRetained:locked?true:lockAttempted?'UNKNOWN':false});}
}
export async function main(argv=process.argv.slice(2)){
  try{check(argv.length===2&&argv[0]==='--install','DEFAULT_DISABLED_EXPLICIT_INSTALL_REQUIRED');const result=await install(argv[1]);process.stdout.write(JSON.stringify(result)+'\n');return 0;}
  catch(e){process.stdout.write(JSON.stringify({status:e.status??'BLOCKED',reason:/^[A-Z_]+$/.test(e.code??'')?e.code:/^[A-Z_]+$/.test(e.message??'')?e.message:'INSTALLATION_UNCONFIRMED',created:e.created??[],lockRetained:e.lockRetained??false,automaticRetryAllowed:false,qualificationIssued:false,checksWritten:false})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().then(code=>{process.exitCode=code;});
