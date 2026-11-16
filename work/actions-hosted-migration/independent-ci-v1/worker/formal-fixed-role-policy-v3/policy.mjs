// Source v2 port of formal-fixed-role-policy-v2 (DESIGN S6, S10): three fixed role-v3 policies and one
// serial execution lease. Changes: job contract v2 (claim-free, attempt 1..2), policy schema v3 with no
// currentClaim (FIXED_ROLE_CLAIM_CHANGED is gone: the claim is checked per admission by the adapters and
// the bridge), Source manifest schema v2, qualification v2 (expiresAt may be null), v4/v2 adapters, no
// successor byte pins (the Owner-accepted Source manifest pins every file), and releaseClean() of the
// serial slot after an adapter's clean BLOCKED that started nothing (so the next role is not wedged).
// No dynamic registry, caller policy/loader, credential copy, image pull or qualification issuer.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {validateJobV2 as validateJob,subjectOfV2 as subjectOf,SCANNER_ROLES_V2} from '../../src/job-v2.mjs';
import {canonical,digest} from '../../src/proof.mjs';
import {loadQualifiedPolicyV2 as loadQualifiedPolicy,protectedPath,LINUX_NODE_V2,POLICY_SCHEMA_V3} from '../qualification-v2.mjs';
import {IMAGE as GITLEAKS_IMAGE,SCAN_ARGS,REVIEWED_COMMITS,matchesReviewedHistoryProof} from '../formal-gitleaks-v4/required-history/prepare.mjs';
import {IMAGE as TRIVY_IMAGE} from '../required-trivy-v3/plans.mjs';
import {TRUSTED_WORKFLOW_PATHS,trustedWorkflowSha256s} from '../trusted-workflows.mjs';
const P='work/actions-hosted-migration/independent-ci-v1/worker/formal-fixed-role-policy-v3/policy.mjs';
const PREFIX='work/actions-hosted-migration/independent-ci-v1/';
const COMMON_SOURCE=Object.freeze(['worker/trusted-workflows.mjs','src/proof.mjs','src/job-v2.mjs','src/worker-v2.mjs','src/admission-facts-v2.mjs','worker/qualification-v2.mjs','worker/formal-fixed-role-policy-v3/policy.mjs','worker/formal-gitleaks-v4/required-history/prepare.mjs','worker/required-gitleaks/prepare.mjs','worker/required-trivy-v3/plans.mjs','worker/verify-once/verify-worker.mjs'].map(p=>PREFIX+p));
const ROLE_SOURCE=Object.freeze({gitleaks:Object.freeze(['worker/formal-gitleaks-v4/adapter.mjs','worker/formal-gitleaks-v3/docker-transport.mjs','worker/formal-gitleaks-v4/required-history/selftest-shim.mjs'].map(p=>PREFIX+p).concat(['.gitleaks.toml','scripts/ci/reviewed_gitleaks.py','.github/workflows/gitleaks.yml'])),trivy:Object.freeze(['worker/formal-trivy-v4/adapter.mjs','worker/formal-trivy-v3/cache.mjs','worker/formal-trivy-v3/docker.mjs','worker/required-trivy-v2/plans.mjs','worker/qualification.mjs','src/worker.mjs','worker/scan-result-cache-v1/cache.mjs'].map(p=>PREFIX+p).concat(['.github/workflows/trivy.yml'])),'contract-placement':Object.freeze(['worker/formal-contract-placement-v2/adapter.mjs','worker/formal-contract-placement-v2/container-entry.mjs','worker/formal-gitleaks-v2/docker-transport.mjs','worker/scan-result-cache-v1/cache.mjs'].map(p=>PREFIX+p).concat(['.github/workflows/contract-placement.yml']))});
// The same exact accepted set as formal-contract-placement-v2/adapter.mjs, from the one table (pure data;
// the policy never imports a role adapter).
export const PLACEMENT_WORKFLOW_SHA256S=trustedWorkflowSha256s(TRUSTED_WORKFLOW_PATHS['contract-placement']);
export const FIXED_ROLE_POLICIES=Object.freeze({gitleaks:'/etc/clued-independent-ci/roles-v3/gitleaks.json',trivy:'/etc/clued-independent-ci/roles-v3/trivy.json','contract-placement':'/etc/clued-independent-ci/roles-v3/contract-placement.json'});
export const SERIAL_LOCK='/var/lib/clued-independent-ci/formal-role.lock';
const actual=new WeakSet(),sessions=new WeakSet(),HASH=/^[a-f0-9]{64}$/,fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const freeze=v=>{if(v&&typeof v==='object'&&!Buffer.isBuffer(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const hash=b=>createHash('sha256').update(b).digest('hex');
const safePath=p=>typeof p==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(p)&&path.posix.normalize(p)===p&&p!=='/';
export function fixedPolicyPath(role){check(typeof role==='string'&&Object.hasOwn(FIXED_ROLE_POLICIES,role),'EXACT_FIXED_ROLE_REQUIRED');return FIXED_ROLE_POLICIES[role];}
export function requiredSourcePaths(role){fixedPolicyPath(role);return Object.freeze([...new Set([...COMMON_SOURCE,...ROLE_SOURCE[role]])]);}
const ADAPTERS=Object.freeze({gitleaks:PREFIX+'worker/formal-gitleaks-v4/adapter.mjs',trivy:PREFIX+'worker/formal-trivy-v4/adapter.mjs','contract-placement':PREFIX+'worker/formal-contract-placement-v2/adapter.mjs'});
export function fixedAdapterDescriptor(role){fixedPolicyPath(role);return Object.freeze({
  modulePath:ADAPTERS[role],
  factoryName:role==='gitleaks'?'createFormalGitleaksAdapter':role==='trivy'?'createFormalTrivyAdapter':'createFormalContractPlacementAdapter',
  policyFile:fixedPolicyPath(role)
});}
export function validateSelectedFacts(job,loaded,now=Date.now()){
  validateJob(job);fixedPolicyPath(job.role);const{config,sourceManifestBytes,qualification}=loaded??{};let manifest;try{manifest=JSON.parse(sourceManifestBytes);}catch{fail('ACTUAL_ROLE_SOURCE_MANIFEST_REQUIRED');}
  check(SCANNER_ROLES_V2.includes(job.role)&&config?.role===job.role&&config.schema===POLICY_SCHEMA_V3&&config.formalEnabled===true&&manifest.schema==='independent-ci.sources.v2'&&manifest.repo===job.repo&&job.repo==='tdoljyj/cross-memory-system'&&/^[a-f0-9]{40}$/.test(manifest.sourceSha??'')&&hash(sourceManifestBytes)===job.sourceManifestSha256&&config.sourceManifestSha256===job.sourceManifestSha256,'FIXED_ROLE_SOURCE_CONTEXT_REQUIRED');
  check(!Object.hasOwn(config,'currentClaim')&&config.nodeExecutable===LINUX_NODE_V2,'FIXED_ROLE_POLICY_V3_REQUIRED');
  const q=qualification?.payload;check(q?.schema==='independent-ci.runtime-qualification.v2'&&q.fixture===false&&q.image===config.image&&q.sourceManifestSha256===job.sourceManifestSha256&&q.runtimeIdentity===config.runtimeIdentity&&q.sourceAcceptanceRef===config.sourceAcceptanceRef&&q.hostAcceptanceRef===config.hostAcceptanceRef&&Date.parse(q.qualifiedAt)<=now&&(q.expiresAt===null||Date.parse(q.expiresAt)>now)&&(!Object.hasOwn(q,'role')||q.role===job.role),'ACTUAL_ROLE_QUALIFICATION_REQUIRED');
  const role=manifest.roles?.[job.role];check(role&&Array.isArray(role.sourceFiles)&&role.sourceFiles.length>0,'FIXED_SOURCE_ROLE_REQUIRED');
  const seen=new Set();for(const p of role.sourceFiles){check(p&&Object.keys(p).sort().join('|')==='path|sha256'&&typeof p.path==='string'&&!/[\\:\x00-\x1f]/.test(p.path)&&!p.path.startsWith('/')&&p.path.split('/').every(s=>s&&s!=='.'&&s!=='..')&&HASH.test(p.sha256??'')&&!seen.has(p.path),'EXACT_ROLE_SOURCE_PINS_REQUIRED');seen.add(p.path);}
  check(requiredSourcePaths(job.role).every(p=>seen.has(p)),'FIXED_SELECTOR_SOURCE_NOT_ACCEPTED');
  const descriptor=fixedAdapterDescriptor(job.role);check(role.sourceFiles.some(p=>p.path===descriptor.modulePath),'FIXED_ADAPTER_SOURCE_REQUIRED');
  check(config.dockerRootDirectory==='/var/lib/docker'&&config.containerUser==='65532:65532','FIXED_ROLE_DOCKER_CONTEXT_REQUIRED');
  if(job.role!=='contract-placement')check(config.memoryBytes===2147483648&&config.cpus===2&&config.pids===128,'FIXED_SCANNER_RESOURCES_REQUIRED');
  if(job.role==='gitleaks')check(config.executionMode==='scanner'&&config.image===GITLEAKS_IMAGE&&role.containerCommand?.image===GITLEAKS_IMAGE&&role.containerCommand.scanner==='gitleaks'&&canonical(role.containerCommand.args)===canonical(SCAN_ARGS)&&role.hostTools?.python&&safePath(role.hostTools.python.path)&&HASH.test(role.hostTools.python.sha256??''),'FIXED_GITLEAKS_POLICY_REQUIRED');
  if(job.role==='trivy'){const accepted=role.formalTrivy,pin=accepted?.checksPin;check(config.executionMode==='scanner'&&config.image===TRIVY_IMAGE&&role.containerCommand?.image===TRIVY_IMAGE&&role.containerCommand.scanner==='trivy'&&accepted?.profile==='required-trivy-three-scanners/1'&&safePath(accepted.cacheRoot)&&pin?.repository==='ghcr.io/aquasecurity/trivy-checks:2'&&/^sha256:[a-f0-9]{64}$/.test(pin.digest??'')&&pin.majorVersion===2&&HASH.test(pin.contentSha256??''),'FIXED_TRIVY_POLICY_AND_CACHE_REQUIRED');}
  if(job.role==='contract-placement'){
    const profile=role.formalContractPlacement,tools=profile?.tools;
    check(config.executionMode==='node-entry'&&/^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(config.image??'')&&![GITLEAKS_IMAGE,TRIVY_IMAGE].some(i=>config.image.slice(-71)===i.slice(-71))&&profile?.profile==='required-contract-placement/1'&&PLACEMENT_WORKFLOW_SHA256S.includes(profile.workflowSha256)&&profile.esbuildVersion==='0.28.1'&&tools&&Object.keys(tools).sort().join('|')==='esbuildBinary|esbuildJs|git|node|python'&&Object.values(tools).every(t=>t&&Object.keys(t).sort().join('|')==='path|sha256'&&safePath(t.path)&&HASH.test(t.sha256??''))&&tools.node.path===config.containerNodeExecutable&&tools.node.sha256===config.containerNodeSha256,'FIXED_CONTRACT_TOOLS_IMAGE_REQUIRED');
  }
  return{role,manifest,config,qualification}; // Pure data, never actual brand.
}
// Fixed Git reader's transport observer. A fixture child can test termination
// semantics, but its plain output cannot produce a qualified policy/context.
export function boundedGitObservation(child,{timeoutMs=30000,maxBytes=16777216,settleMs=250}={}){
  check(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=30000&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=16777216&&Number.isSafeInteger(settleMs)&&settleMs>0&&settleMs<=250,'GIT_OBSERVATION_BOUND');
  return new Promise((resolve,reject)=>{let done=false,failed=false,stdout=0,stderr=0;const parts=[];let settle=null;
    const finish=(code,text)=>{if(done)return;done=true;clearTimeout(timer);if(settle)clearTimeout(settle);code?reject(Object.assign(new Error(code),{code})):resolve(text);};
    const stop=()=>{if(done||failed)return;failed=true;try{child.kill('SIGKILL');}catch{}settle=setTimeout(()=>finish('ROLE_SOURCE_GIT_UNCONFIRMED'),settleMs);};
    const timer=setTimeout(stop,timeoutMs);child.stdout.on('data',b=>{stdout+=b.length;if(stdout>maxBytes)stop();else if(!failed)parts.push(b);});child.stderr.on('data',b=>{stderr+=b.length;if(stderr>maxBytes)stop();});child.once('error',stop);child.once('close',code=>{if(failed||code!==0)finish('ROLE_SOURCE_GIT_UNCONFIRMED');else finish(null,Buffer.concat(parts).toString('utf8'));});
  });
}
async function git(config,args){
  const child=spawn(config.gitExecutable,['--no-optional-locks',`--git-dir=${path.join(config.trustedSourceDirectory,'.git')}`,`--work-tree=${config.trustedSourceDirectory}`,'-c','core.fsmonitor=false','-c','core.hooksPath=/nonexistent-independent-ci-hooks',...args],{cwd:config.trustedSourceDirectory,shell:false,env:{LANG:'C',LC_ALL:'C',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:''},stdio:['ignore','pipe','pipe']});
  return boundedGitObservation(child);
}
export function validateTreePins(tree,pins){
  check(typeof tree==='string'&&tree.length<=16777216&&Array.isArray(pins),'BOUNDED_SOURCE_TREE_REQUIRED');const entries=new Map();for(const row of tree.split('\0').filter(Boolean)){const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);check(m&&!entries.has(m[3]),'REGULAR_SOURCE_TREE_REQUIRED');entries.set(m[3],m[2]);}
  check(pins.every(p=>entries.has(p.path)),'SOURCE_NOT_IN_TREE');return entries;
}
// The registered workflow catalogue has its own 2 MiB codec bound. Only that
// fixed file may exceed the ordinary source-file limit; byte and Git pins still
// have to agree. This check issues no actual-policy brand or qualification.
export async function validateTrackedSourceBytes(pin,bytes,readGitObject,expectedObject){
  const maxBytes=pin.path==='scripts/ci/clued-gated-proof-profiles.json'?2097152:1048576;
  check(Buffer.isBuffer(bytes)&&bytes.length<=maxBytes&&hash(bytes)===pin.sha256,'ACTUAL_TRACKED_SOURCE_BYTES_CHANGED');
  check((await readGitObject()).trim()===expectedObject,'ACTUAL_TRACKED_SOURCE_BYTES_CHANGED');
}
async function trackedSource(config,manifest,role){
  check(fileURLToPath(import.meta.url)===path.join(config.trustedSourceDirectory,P),'SELECTOR_OUTSIDE_ACCEPTED_SOURCE');
  await protectedPath(path.join(config.trustedSourceDirectory,'.git'),{directory:true});
  const gitConfig=path.join(config.trustedSourceDirectory,'.git/config');await protectedPath(gitConfig);const gitConfigBytes=await fsp.readFile(gitConfig);check(gitConfigBytes.length<=1048576&&!/^\s*\[(include|includeIf|filter|extensions)\b/im.test(gitConfigBytes.toString('utf8')),'UNSAFE_SOURCE_GIT_CONFIG');
  for(const name of ['shallow','commondir','objects/info/alternates','objects/info/http-alternates','info/grafts']){try{await fsp.lstat(path.join(config.trustedSourceDirectory,'.git',name));fail('SOURCE_SHARED_OR_SHALLOW');}catch(e){if(e.code!=='ENOENT')throw e;}}
  check((await git(config,['rev-parse','--verify','HEAD^{commit}'])).trim()===manifest.sourceSha,'ACTUAL_SOURCE_COMMIT_CHANGED');
  const entries=validateTreePins(await git(config,['ls-tree','-r','-z','--full-tree',manifest.sourceSha]),role.sourceFiles);
  for(const pin of role.sourceFiles){const file=path.join(config.trustedSourceDirectory,pin.path);await protectedPath(file);const b=await fsp.readFile(file);await validateTrackedSourceBytes(pin,b,()=>git(config,['hash-object','--no-filters','--',pin.path]),entries.get(pin.path));}
  check((await git(config,['status','--porcelain=v1','--untracked-files=all'])).trim()==='','DIRTY_SOURCE_NOT_QUALIFIED');
}
export async function loadFixedRolePolicy(job){
  validateJob(job);const policyFile=fixedPolicyPath(job.role);check(process.platform==='linux'&&process.getuid?.()===0,'FIXED_ROOT_ROLE_POLICY_REQUIRED');
  const loaded=await loadQualifiedPolicy(policyFile),facts=validateSelectedFacts(job,loaded);
  await trackedSource(loaded.config,facts.manifest,facts.role);
  if(job.role==='trivy')await protectedPath(facts.role.formalTrivy.cacheRoot,{directory:true});
  if(job.role==='gitleaks'){const p=facts.role.hostTools.python;await protectedPath(p.path);check(hash(await fsp.readFile(p.path))===p.sha256,'ACTUAL_PYTHON_PIN_CHANGED');}
  const{sourceManifestBytes,publicKey,...rest}=loaded;
  const value=freeze({job:structuredClone(job),role:job.role,policyFile,...rest,manifest:facts.manifest,get sourceManifestBytes(){return Buffer.from(sourceManifestBytes);},get publicKey(){return Buffer.from(publicKey);}});
  // Source/Git/cache/tool reads above can cross the qualification/claim expiry.
  // No asynchronous operation may separate this actual clock recheck and brand.
  validateSelectedFacts(job,loaded,Date.now());actual.add(value);return value;
}
export function takeActualRolePolicy(value){check(actual.has(value),'ACTUAL_FIXED_ROLE_POLICY_REQUIRED');return value;}
// bf57ff10 P2 D (2026-11-07): an actual role policy loaded moments ago for the same job (the bridge context's, built
// just before the session opens, with no adapter run in between) stands in for loading it all again. Only the actual
// brand, the same canonical job and validateSelectedFacts at the current clock (qualification window included) make it
// reusable; any doubt returns null and the caller loads anew, so every refusal stays the fresh load's own.
// sameRolePolicyFacts: the pure part (no brand), for the offline tests; it grants nothing.
export function sameRolePolicyFacts(job,candidate,now=Date.now()){
  try{
    if(!candidate||canonical(candidate.job)!==canonical(job))return false;
    validateSelectedFacts(job,{config:candidate.config,sourceManifestBytes:candidate.sourceManifestBytes,qualification:candidate.qualification},now);
    return true;
  }catch{return false;}
}
export function reusableRolePolicy(job,candidate){return candidate&&actual.has(candidate)&&sameRolePolicyFacts(job,candidate,Date.now())?candidate:null;}
// The role policy session.finish loaded after the execution, once, for the signer of the same job (bf57ff10 P2 D).
const finishedPolicies=new WeakMap();
export function takeFinishedRolePolicy(session,job){
  const value=sessions.has(session)?finishedPolicies.get(session):undefined;if(sessions.has(session))finishedPolicies.delete(session);
  if(!value||!actual.has(value))return null;
  try{return canonical(value.job)===canonical(job)?value:null;}catch{return null;}
}
export function validateCleanupObservation(job,o){
  fixedPolicyPath(job.role);check(o?.domain==='production-observation'&&o.fixture===false&&canonical(o.subject)===canonical(subjectOf(job))&&o.sourceManifestSha256===job.sourceManifestSha256&&o.formalEligible===false&&o.qualificationIssued===false&&o.checksWritten===false,'ACTUAL_ROLE_OBSERVATION_REQUIRED');
  // trivy: observation contract /3 only (DESIGN 64.3; formal-trivy-v4 TRIVY_OBSERVATION_CONTRACT, literal here: the policy imports no adapter).
  // A scan result cache hit (DESIGN 68.5) carries no scans of its own: the original ones are inside cacheHit, checked in full by the signer.
  if(job.role==='trivy'){const scans=o.cacheHit?(Object.hasOwn(o,'scans')?null:o.cacheHit.originalObservation?.scans):o.scans;check(o.contract==='clued.independent-ci.formal-scanner-observation/3'&&o.profile==='required-trivy-three-scanners/1'&&scans?.length===3&&scans.every(s=>s.cleanupConfirmed===true&&s.complete===true)&&o.cleanup?.containersRemoved===true&&o.cleanup.wholeContainerTreesStopped===true&&o.cleanup.snapshotRemoved===true,'ACTUAL_ROLE_CLEANUP_UNCONFIRMED');}
  else check(o.profile===(job.role==='gitleaks'?'required-gitleaks-history/1':'required-contract-placement/1')&&(job.role!=='gitleaks'||o.requiredHistoricalExceptions===REVIEWED_COMMITS.findings&&matchesReviewedHistoryProof(o.reviewedHistoryProof))&&o.cleanup?.complete===true&&o.cleanup.wholeContainerTreeStopped===true&&o.cleanup.containerRemoved===true,'ACTUAL_ROLE_CLEANUP_UNCONFIRMED');return o;
}
export async function openFixedRoleSession(job,{preloaded=null}={}){
  const context=reusableRolePolicy(job,preloaded)??takeActualRolePolicy(await loadFixedRolePolicy(job));await protectedPath(path.dirname(SERIAL_LOCK),{directory:true});
  const token=randomUUID(),intent=Buffer.from(canonical({contract:'clued.independent-ci.fixed-role-serial-intent/2',token,subject:subjectOf(job),role:job.role,policyFile:context.policyFile,automaticRetryAllowed:false}));
  const h=await fsp.open(SERIAL_LOCK,'wx',0o600);try{await h.writeFile(intent);await h.sync();}finally{await h.close();}const parent=await fsp.open(path.dirname(SERIAL_LOCK),'r');try{await parent.sync();}finally{await parent.close();}
  let finished=false;const unlock=async()=>{await protectedPath(SERIAL_LOCK,{privateFile:true});check((await fsp.readFile(SERIAL_LOCK)).equals(intent),'SERIAL_ROLE_LOCK_CHANGED');await fsp.unlink(SERIAL_LOCK);const dir=await fsp.open(path.dirname(SERIAL_LOCK),'r');try{await dir.sync();}finally{await dir.close();}};
  const session=Object.freeze({context,async finish(observation){check(sessions.has(session)&&!finished,'ACTUAL_SERIAL_ROLE_SESSION_REQUIRED');
    const validator=job.role==='gitleaks'?await import('../formal-gitleaks-v4/adapter.mjs'):job.role==='trivy'?await import('../formal-trivy-v4/adapter.mjs'):await import('../formal-contract-placement-v2/adapter.mjs');
    validator.takeActualObservation(observation,job);validateCleanupObservation(job,observation);check(observation.runtimeIdentity===context.config.runtimeIdentity&&observation.hostAcceptanceRef===context.config.hostAcceptanceRef&&observation.sourceAcceptanceRef===context.config.sourceAcceptanceRef&&observation.image===context.config.image,'ACTUAL_ROLE_RUNTIME_CHANGED');
    const fresh=await loadFixedRolePolicy(job);check(fresh.policyFile===context.policyFile&&canonical(fresh.config)===canonical(context.config),'ROLE_AUTHORITY_CHANGED_AFTER_EXECUTION');
    await unlock();finishedPolicies.set(session,fresh);finished=true;return{status:'ACTUAL_ROLE_SERIAL_SLOT_RELEASED',role:job.role,observationSha256:digest(observation),qualificationIssued:false,checksWritten:false};
  },
  // Only after the adapter's own clean BLOCKED with sideEffectsMayHaveStarted===false (no scanner touched the
  // PR and no snapshot is retained; trivy's cache refusal may have run cache-only containers and keeps its run
  // directory, formal-trivy-v4 cacheRefusal): the slot is released; the bridge mailbox lock stays for the archive.
  async releaseClean(result){check(sessions.has(session)&&!finished,'ACTUAL_SERIAL_ROLE_SESSION_REQUIRED');
    check(result&&result.status==='BLOCKED'&&result.sideEffectsMayHaveStarted===false&&result.snapshotRetained!==true&&!result.observation,'CLEAN_BLOCKED_RESULT_REQUIRED');
    await unlock();finished=true;return{status:'ACTUAL_ROLE_SERIAL_SLOT_RELEASED_CLEAN',role:job.role,reason:result.reason,qualificationIssued:false,checksWritten:false};
  }});sessions.add(session);return session;
}
export function takeActualRoleSession(value){check(sessions.has(value),'ACTUAL_SERIAL_ROLE_SESSION_REQUIRED');return value;}
