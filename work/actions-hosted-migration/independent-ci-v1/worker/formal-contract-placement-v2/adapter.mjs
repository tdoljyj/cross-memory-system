// Source v2 copy of formal-contract-placement-v1/adapter.mjs (DESIGN S6, S10): job contract v2, roles-v3 policy
// (no currentClaim; the placement command's node must be the pinned toolchain node, see qualification-v2), the
// shared v2 admission check with one claim generation per run, qualification v2, contracts /2.
// Fixed contract-placement adapter. No signer, secret reader, Checks writer,
// caller Docker/qualification injection, image pull or Host candidate execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateJobV2 as validateJob,subjectOfV2 as subjectOf} from '../../src/job-v2.mjs';
import {canonical,digest} from '../../src/proof.mjs';
import {validateFormalAdmissionV2} from '../../src/admission-facts-v2.mjs';
import {prepareWorkerJob} from '../../src/worker-v2.mjs';
import {loadQualifiedPolicyV2 as loadQualifiedPolicy,protectedPath,qualificationDeadline} from '../qualification-v2.mjs';
import {observeUnsignedContainer} from '../verify-once/verify-worker.mjs';
import {dockerInvoke} from '../formal-gitleaks-v2/docker-transport.mjs';
import {PROFILE,LIMITS,validateTools,fixedCommands} from './container-entry.mjs';
import {TRUSTED_WORKFLOW_PATHS,trustedWorkflowSha256s} from '../trusted-workflows.mjs';

export const POLICY_FILE='/etc/clued-independent-ci/roles-v3/contract-placement.json';
// .github/workflows/contract-placement.yml is pinned as an exact accepted set, never a pattern, taken from the one
// table (worker/trusted-workflows.mjs). The role profile and the Source manifest must name the same one; the
// observation records it.
export const WORKFLOW_SHA256S=trustedWorkflowSha256s(TRUSTED_WORKFLOW_PATHS['contract-placement']);
const P='work/actions-hosted-migration/independent-ci-v1/';
const DIR=P+'worker/formal-contract-placement-v2/';
const CLOSURE=[DIR+'adapter.mjs',DIR+'container-entry.mjs',P+'src/job-v2.mjs',P+'src/admission-facts-v2.mjs',P+'src/proof.mjs',P+'src/worker-v2.mjs',P+'worker/qualification-v2.mjs',P+'worker/verify-once/verify-worker.mjs',P+'worker/trusted-workflows.mjs',P+'worker/formal-gitleaks-v2/docker-transport.mjs'];
const HASH=/^[a-f0-9]{64}$/;const actual=new WeakSet();
const check=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const safe=e=>/^[A-Z_]{1,90}$/.test(e?.code??e?.message??'')?(e.code??e.message):'CONTRACT_PLACEMENT_UNCONFIRMED';
const hash=b=>createHash('sha256').update(b).digest('hex');
export function validateRequiredJob(job){validateJob(job);check(job.repo==='tdoljyj/cross-memory-system'&&job.role==='contract-placement','FIXED_PLACEMENT_JOB_REQUIRED');return job;}
export function validateAdmission(job,a,now=Date.now(),options={}){validateRequiredJob(job);return validateFormalAdmissionV2(job,a,now,options);}
export function validateRole(config,role){
  const a=role?.formalContractPlacement;
  check(a&&Object.keys(a).sort().join('|')==='esbuildVersion|profile|tools|workflowSha256'&&a.profile===PROFILE&&WORKFLOW_SHA256S.includes(a.workflowSha256)&&a.esbuildVersion==='0.28.1','ORIGINAL_PLACEMENT_PROFILE_REQUIRED');validateTools(a.tools);
  check(config.executionMode==='node-entry'&&/^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(config.image??'')&&config.containerNodeExecutable===a.tools.node.path&&config.containerNodeSha256===a.tools.node.sha256&&config.containerUser==='65532:65532'&&
    config.memoryBytes===LIMITS.memoryBytes&&config.cpus===LIMITS.cpus&&config.pids===LIMITS.pids&&config.dockerRootDirectory==='/var/lib/docker','QUALIFIED_TOOL_IMAGE_REQUIRED');
  check(role.timeoutMs===LIMITS.timeoutMs&&role.maxOutputBytes===LIMITS.maxOutputBytes&&role.command?.executable===config.nodeExecutable&&role.command.executableSha256===config.nodeExecutableSha256&&canonical(role.command.args)===canonical(['/control/contract-placement-entry.mjs'])&&role.command.cwd==='.'&&!role.containerCommand,'FIXED_PLACEMENT_COMMAND_REQUIRED');return a;
}
async function sourceBoundary(config,manifest){
  const role=manifest.roles?.['contract-placement'],accepted=validateRole(config,role);check(Array.isArray(role.sourceFiles),'PLACEMENT_SOURCE_CLOSURE_REQUIRED');
  for(const relative of CLOSURE){const pins=role.sourceFiles.filter(p=>p.path===relative);check(pins.length===1&&HASH.test(pins[0].sha256),'PLACEMENT_SOURCE_NOT_ACCEPTED');const file=path.join(config.trustedSourceDirectory,relative);await protectedPath(file);check(hash(await fs.readFile(file))===pins[0].sha256,'PLACEMENT_SOURCE_DRIFT');}
  const self=fileURLToPath(import.meta.url);check(self===path.join(config.trustedSourceDirectory,DIR+'adapter.mjs'),'PLACEMENT_ADAPTER_NOT_INSTALLED');
  const workflow=role.sourceFiles.filter(p=>p.path==='.github/workflows/contract-placement.yml');check(workflow.length===1&&workflow[0].sha256===accepted.workflowSha256,'ORIGINAL_WORKFLOW_REQUIRED');return accepted;
}
async function durableNew(file,value){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(canonical(value));await h.sync();}finally{await h.close();}const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
export function gitArguments(directory,args){check(path.isAbsolute(directory)&&Array.isArray(args),'FIXED_GIT_DIRECTORY_REQUIRED');return['--no-optional-locks',`--git-dir=${path.join(directory,'.git')}`,'-c','core.fsmonitor=false','-c','core.hooksPath=/nonexistent-clued-hooks','-c','protocol.allow=never',...args];}
async function git(config,directory,args,{stdin=null,maxBytes=65536}={}){
  return new Promise((resolve,reject)=>{let parts=[],bytes=0,unknown=false,ended=false;const child=spawn(config.gitExecutable,gitArguments(directory,args),{shell:false,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:[stdin?'pipe':'ignore','pipe','pipe']});
    const finish=code=>{if(ended)return;ended=true;clearTimeout(timer);clearTimeout(settle);if(unknown||code!==0)return reject(Object.assign(new Error('FIXED_GIT_OPERATION_UNCONFIRMED'),{code:'FIXED_GIT_OPERATION_UNCONFIRMED'}));resolve(Buffer.concat(parts));};let settle;
    const stop=()=>{unknown=true;try{child.kill('SIGKILL');}catch{}if(!settle)settle=setTimeout(()=>finish(null),250);};const timer=setTimeout(stop,60000);
    child.stdout.on('data',b=>{if(ended)return;bytes+=b.length;if(bytes>maxBytes)stop();else parts.push(b);});child.stderr.on('data',()=>{});child.once('error',()=>{unknown=true;finish(null);});child.once('close',finish);if(stdin){child.stdin.on('error',()=>{unknown=true;});child.stdin.end(stdin);}
  });
}
// Only Git object processing runs on the protected Host. Git hooks, include/
// filter/extension config are already refused by prepareWorkerJob; no candidate
// script, npm, Python, Node test or compiler is launched here.
async function sealedCandidate(config,job,candidate,destination){
  let bytes=0;await fs.mkdir(destination,{mode:0o755});
  async function copy(source,target,root=false){await protectedPath(source,{directory:true});for(const item of await fs.readdir(source,{withFileTypes:true})){if(root&&item.name==='.git')continue;const from=path.join(source,item.name),to=path.join(target,item.name),s=await fs.lstat(from);
      check(!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022),'ROOT_SEALED_CANDIDATE_REQUIRED');
      if(s.isDirectory()){await fs.mkdir(to,{mode:0o755});await copy(from,to);}
      else{check(s.isFile()&&s.nlink===1&&s.size<=64*1024*1024,'CANDIDATE_REGULAR_FILE_REQUIRED');const raw=await fs.readFile(from);bytes+=raw.length;check(raw.length===s.size&&bytes<=256*1024*1024,'CANDIDATE_SNAPSHOT_BOUND');await fs.writeFile(to,raw,{flag:'wx',mode:s.mode&0o111?0o555:0o444});}}
  }
  await copy(candidate,destination,true);
  const meta=path.join(destination,'.git');await fs.mkdir(path.join(meta,'objects','pack'),{recursive:true,mode:0o755});await fs.mkdir(path.join(meta,'refs'),{mode:0o755});
  // Job contract /3: the sealed candidate's HEAD is the tested commit S; its store also holds H and T (S = H outside the train).
  await fs.writeFile(path.join(meta,'HEAD'),job.testSha+'\n',{flag:'wx',mode:0o444});await fs.writeFile(path.join(meta,'config'),'[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\nlogallrefupdates = false\n',{flag:'wx',mode:0o444});
  const pack=await git(config,candidate,['pack-objects','--stdout','--revs'],{stdin:[...new Set([job.testSha,job.headSha,job.baseSha])].join('\n')+'\n',maxBytes:256*1024*1024});check(pack.length>=32,'PACK_BYTES_REQUIRED');const packfile=path.join(meta,'objects','pack','pack-'+pack.subarray(-20).toString('hex')+'.pack');await fs.writeFile(packfile,pack,{flag:'wx',mode:0o444});
  await git(config,destination,['index-pack','--strict',packfile]);await readableSeal(destination);return{bytes,packSha256:hash(pack)};
}
// The fixed container user (65532) must read the sealed snapshot. Like trivy-v3's snapshotTree and
// gitleaks prepare, set explicit read-only modes so a umask077 worker cannot make /input root-only.
async function readableSeal(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,item.name),s=await fs.lstat(p);check(!s.isSymbolicLink()&&(s.isDirectory()||s.isFile()&&s.nlink===1),'ROOT_SEALED_CANDIDATE_REQUIRED');if(s.isDirectory())await readableSeal(p);else await fs.chmod(p,s.mode&0o111?0o555:0o444);}await fs.chmod(dir,0o555);}
export function placementPlan(config,accepted,snapshot,requestFile,entryFile){
  validateTools(accepted.tools);return freeze({profile:PROFILE,image:config.image,executable:config.containerNodeExecutable,cwd:'/scratch',args:['/control/contract-placement-entry.mjs'],mounts:[[snapshot,'/input'],[requestFile,'/request/job.json'],[entryFile,'/control/contract-placement-entry.mjs']],limits:LIMITS,network:'none',user:'65532:65532',rootfsReadOnly:true,credentialsMounted:false});
}
export function takeActualObservation(observation,job){validateRequiredJob(job);check(actual.has(observation)&&canonical(observation.subject)===canonical(subjectOf(job)),'ACTUAL_PROTECTED_PLACEMENT_OBSERVATION_REQUIRED');return observation;}
export function createFormalContractPlacementAdapter({admissionPort}={}){
  return Object.freeze({async execute(job,{signal}={}){let run=null,created=false,touched=false;
    try{
      job=freeze(structuredClone(validateRequiredJob(job)));check(typeof admissionPort==='function','PROTECTED_ADMISSION_PORT_REQUIRED');check(process.platform==='linux'&&process.getuid?.()===0,'FIXED_PROTECTED_LINUX_ROOT_REQUIRED');
      const{config,sourceManifestBytes,qualification}=await loadQualifiedPolicy(POLICY_FILE),manifest=JSON.parse(sourceManifestBytes);check(config.sourceManifestSha256===job.sourceManifestSha256,'QUALIFIED_JOB_CONTEXT_MISMATCH');
      const accepted=await sourceBoundary(config,manifest),candidate=path.join(config.workspaceRoot,job.id,'candidate');
      const before=freeze(structuredClone(validateAdmission(job,await admissionPort(job)))),generation=before.batchClaimBound,again=async()=>validateAdmission(job,await admissionPort(job),Date.now(),{batchClaim:generation});const expires=Math.min(Date.parse(before.claimExpiresAt),qualificationDeadline(qualification.payload),Date.now()+LIMITS.timeoutMs);check(expires>Date.now()&&!signal?.aborted,'CURRENT_AUTHORITY_EXPIRED');
      const prepared=await prepareWorkerJob({job,workspace:candidate,trustedSourceDirectory:config.trustedSourceDirectory,sourceManifestBytes,expectedSourceManifestSha256:job.sourceManifestSha256,gitExecutable:config.gitExecutable});
      run=path.join(config.runsRoot,'placement-'+job.id);await fs.mkdir(run,{mode:0o700});created=true;await durableNew(path.join(run,'intent.json'),{contract:'clued.independent-ci.formal-placement-intent/2',subject:subjectOf(job),automaticRetryAllowed:false});
      const snapshot=path.join(run,'candidate'),sealed=await sealedCandidate(config,job,candidate,snapshot);
      const sealedPrepared=await prepareWorkerJob({job,workspace:snapshot,trustedSourceDirectory:config.trustedSourceDirectory,sourceManifestBytes,expectedSourceManifestSha256:job.sourceManifestSha256,gitExecutable:config.gitExecutable});check(sealedPrepared.candidateTreeSha===prepared.candidateTreeSha,'SEALED_HEAD_TREE_CHANGED');
      const requestFile=path.join(run,'job.json'),entryFile=path.join(config.trustedSourceDirectory,DIR+'container-entry.mjs');await durableNew(requestFile,{contract:'clued.independent-ci.contract-placement-container/2',job,tools:accepted.tools});await fs.chmod(requestFile,0o444);
      const plan=placementPlan(config,accepted,snapshot,requestFile,entryFile);await again();check(expires>Date.now()&&!signal?.aborted,'AUTHORITY_EXPIRED_BEFORE_PLACEMENT');
      const request={nonce:randomBytes(32).toString('hex'),executionId:randomUUID(),deadline:new Date(expires).toISOString()};touched=true;
      const o=await observeUnsignedContainer({imageDigest:config.image,dockerRootDirectory:config.dockerRootDirectory,limits:LIMITS},request,plan,dockerInvoke,{signal});const after=await again();
      check(o.complete===true&&o.cleanupConfirmed===true&&o.reason===null&&o.state?.Running===false&&o.state.Status==='exited'&&Number.isInteger(o.state.ExitCode)&&o.attached?.code===o.state.ExitCode&&!o.attached.timedOut&&!o.attached.overflow&&!o.attached.error&&expires>Date.now(),'ACTUAL_PLACEMENT_EXIT_AND_CLEANUP_REQUIRED');
      check(o.isolation?.nonRoot===true&&o.isolation.network==='none'&&o.isolation.credentialsMounted===false&&o.isolation.controlPathsMounted===false,'ACTUAL_PLACEMENT_ISOLATION_REQUIRED');
      const observation=freeze({contract:'clued.independent-ci.formal-check-observation/2',domain:'production-observation',fixture:false,profile:PROFILE,subject:subjectOf(job),sourceSha:prepared.sourceSha,sourceTreeSha:prepared.sourceTreeSha,candidateTreeSha:prepared.candidateTreeSha,sourceManifestSha256:job.sourceManifestSha256,workflowSha256:accepted.workflowSha256,image:config.image,imageId:o.imageId,runtimeIdentity:config.runtimeIdentity,hostAcceptanceRef:config.hostAcceptanceRef,sourceAcceptanceRef:config.sourceAcceptanceRef,nonce:request.nonce,requestSha256:digest(request),headBasePackSha256:sealed.packSha256,commandSequenceSha256:digest(fixedCommands(job,accepted.tools)),toolPinsSha256:digest(accepted.tools),preAdmissionSha256:before.observationSha256,postAdmissionSha256:after.observationSha256,conclusion:o.state.ExitCode===0?'success':'failure',exitCode:o.state.ExitCode,startedAt:o.startedAt,finishedAt:o.finishedAt,logs:o.attached.logs,cleanup:{complete:true,wholeContainerTreeStopped:true,containerRemoved:true,observedAt:o.cleanupObservedAt},evidenceClass:'unsigned-observation-requires-protected-result-issuer',formalEligible:false,checksWritten:false,qualificationIssued:false});
      await durableNew(path.join(run,'observation.json'),observation);actual.add(observation);return{status:'ACTUAL_PLACEMENT_OBSERVED_UNSIGNED',observation,formalEligible:false,checksWritten:false,qualificationIssued:false};
    }catch(e){const outcome={status:created?'UNCERTAIN':'BLOCKED',reason:safe(e),sideEffectsMayHaveStarted:created||touched,automaticRetryAllowed:false,formalEligible:false,checksWritten:false,qualificationIssued:false};if(created)try{await durableNew(path.join(run,'uncertain.json'),outcome);}catch{outcome.receiptPersistenceConfirmed=false;}return outcome;}
  }});
}
