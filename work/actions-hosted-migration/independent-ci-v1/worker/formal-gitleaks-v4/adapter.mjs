// Source v2 copy of formal-gitleaks-v3/adapter.mjs (DESIGN S6, S10, lesson b28): job contract v2, role policy
// roles-v3 (no currentClaim), the shared v2 admission check with a sticky claim generation per run,
// qualification v2 deadline, refsInStore() before the run directory, observation/intent contracts /2.
// Fixed required-history execution Source. No Checks, qualification issuer,
// signing key, credential mount, user argv/env, fixture-success promotion or CLI.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {validateJobV2 as validateJob,subjectOfV2 as subjectOf} from '../../src/job-v2.mjs';
import {canonical,digest} from '../../src/proof.mjs';
import {validateFormalAdmissionV2,remoteRefsReferenceTime} from '../../src/admission-facts-v2.mjs';
import {loadQualifiedPolicyV2 as loadQualifiedPolicy,protectedPath,qualificationDeadline} from '../qualification-v2.mjs';
import {IMAGE,SCAN_ARGS,SOURCE_PINS,WORKFLOW_PATH,REVIEWED_COMMITS,REVIEWED_HISTORY_PROOF,acceptedWorkflowSha256,prepareRequiredHistory,refsInStore,reviewedSelfTestPlan,runReviewedSelfTest,requiredScannerPlan,validateRemoteSnapshot} from './required-history/prepare.mjs';
import {observeUnsignedContainer} from '../verify-once/verify-worker.mjs';
import {dockerInvoke} from '../formal-gitleaks-v3/docker-transport.mjs';

const PREFIX='work/actions-hosted-migration/independent-ci-v1/';
const SOURCE_FILES=[['worker/formal-gitleaks-v4/adapter.mjs',import.meta.url],
  ['worker/formal-gitleaks-v3/docker-transport.mjs',new URL('../formal-gitleaks-v3/docker-transport.mjs',import.meta.url)],
  ['worker/formal-gitleaks-v4/required-history/prepare.mjs',new URL('./required-history/prepare.mjs',import.meta.url)],
  ['worker/formal-gitleaks-v4/required-history/selftest-shim.mjs',new URL('./required-history/selftest-shim.mjs',import.meta.url)],
  ['worker/verify-once/verify-worker.mjs',new URL('../verify-once/verify-worker.mjs',import.meta.url)],
  ['worker/trusted-workflows.mjs',new URL('../trusted-workflows.mjs',import.meta.url)]];
const HASH=/^[a-f0-9]{64}$/;
// Source pins an OCI repository manifest, not a Docker config-image ID. Docker
// canonical RepoDigests omit the optional human-readable tag only.
export const MANIFEST_DIGEST=IMAGE.slice(IMAGE.lastIndexOf('@')+1);
export const NATIVE_IMAGE=IMAGE.slice(0,IMAGE.lastIndexOf(':',IMAGE.indexOf('@')))+'@'+MANIFEST_DIGEST;
const actualObservations=new WeakSet();
const deepFreeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(deepFreeze);Object.freeze(v);}return v;};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,c)=>{if(!v)fail(c);};
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??e?.message??'')?(e.code??e.message):'FORMAL_GITLEAKS_UNCONFIRMED';
const without=(v,key)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!==key));
async function fileHash(file){const h=createHash('sha256');for await(const b of fs.createReadStream(file))h.update(b);return h.digest('hex');}
async function durableNew(file,value){const h=await fsp.open(file,'wx',0o600);try{await h.writeFile(canonical(value));await h.sync();}finally{await h.close();}
  const d=await fsp.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}

export function validateRequiredJob(job){validateJob(job);check(job.repo==='tdoljyj/cross-memory-system'&&job.role==='gitleaks','FIXED_GITLEAKS_JOB_REQUIRED');return job;}
export const snapshotJob=job=>deepFreeze(structuredClone(validateRequiredJob(job)));
export function validateAdmission(job,a,now=Date.now(),options={}){validateRequiredJob(job);return validateFormalAdmissionV2(job,a,now,options);}
export function validateHistoryPlan(plan){
  check(plan?.profile==='required-gitleaks-history/1'&&plan.image===IMAGE&&plan.executable==='/usr/bin/gitleaks'&&plan.cwd==='/repo'&&
    canonical(plan.args)===canonical(SCAN_ARGS)&&plan.mounts?.length===3&&
    canonical(plan.mounts.map(v=>v[1]))===canonical(['/repo','/reviewed.ignore','/etc/gitconfig'])&&
    plan.user==='65532:65532'&&plan.network==='none'&&plan.rootfsReadOnly===true&&canonical(plan.capDrop)===canonical(['ALL'])&&
    plan.noNewPrivileges===true&&plan.ipc==='private'&&plan.formalEligible===false&&plan.scanResultNotYetObserved===true,'FIXED_HISTORY_PLAN_REQUIRED');
  check(plan.limits?.timeoutMs===1200000&&plan.limits.maxOutputBytes===16777216&&plan.limits.memoryBytes===2147483648&&plan.limits.cpus===2&&plan.limits.pids===128,'FIXED_HISTORY_LIMITS_REQUIRED');return plan;
}
async function sourceBoundary(config,manifest){
  const role=manifest.roles?.gitleaks;check(role&&Array.isArray(role.sourceFiles),'GITLEAKS_SOURCE_ROLE_REQUIRED');
  for(const [relative,url]of SOURCE_FILES){const file=fileURLToPath(url),pin=role.sourceFiles.filter(p=>p.path===PREFIX+relative);
    check(pin.length===1&&HASH.test(pin[0].sha256),'FORMAL_ADAPTER_SOURCE_NOT_ACCEPTED');await protectedPath(file);
    check(await fileHash(file)===pin[0].sha256&&file===path.join(config.trustedSourceDirectory,PREFIX,relative),'FORMAL_ADAPTER_SOURCE_DRIFT');}
  for(const [relative,pin]of Object.entries(SOURCE_PINS)){const file=path.join(config.trustedSourceDirectory,relative);await protectedPath(file);
    check(await fileHash(file)===pin,'TRUSTED_REVIEW_SOURCE_DRIFT');}
  const workflowPin=acceptedWorkflowSha256(role),workflowFile=path.join(config.trustedSourceDirectory,WORKFLOW_PATH);await protectedPath(workflowFile);
  check(await fileHash(workflowFile)===workflowPin,'TRUSTED_REVIEW_SOURCE_DRIFT');
  const python=role.hostTools?.python;
  check(python&&Object.keys(python).sort().join('|')==='path|sha256'&&path.isAbsolute(python.path)&&HASH.test(python.sha256),'ACCEPTED_PYTHON_PIN_REQUIRED');
  await protectedPath(python.path);check(await fileHash(python.path)===python.sha256,'PYTHON_PIN_CHANGED');return python;
}
async function protectedObjectTree(directory){
  await protectedPath(directory,{directory:true});
  for(const item of await fsp.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,item.name),stat=await fsp.lstat(file);
    check(!stat.isSymbolicLink()&&stat.uid===0&&!(stat.mode&0o022)&&(stat.isDirectory()||stat.isFile()&&stat.nlink===1),'PROTECTED_OBJECT_STORE_REQUIRED');
    if(stat.isDirectory())await protectedObjectTree(file);
  }
}
export function executionSummary(job,prepared,selfTest,plan,o,request,context){
  validateHistoryPlan(plan);
  check(o?.complete===true&&o.cleanupConfirmed===true&&o.reason===null&&/^sha256:[a-f0-9]{64}$/.test(o.imageId??'')&&HASH.test(o.containerId??'')&&o.state?.Running===false&&
    o.state.Status==='exited'&&[0,1].includes(o.state.ExitCode)&&o.attached?.code===o.state.ExitCode&&o.attached.error===false&&
    o.attached.timedOut===false&&o.attached.overflow===false&&o.isolation?.network==='none'&&o.isolation.nonRoot===true&&
    o.isolation.credentialsMounted===false&&o.isolation.controlPathsMounted===false&&o.isolation.dockerSocketMounted===false&&
    Date.parse(o.cleanupObservedAt)>=Date.parse(o.finishedAt)&&Date.parse(o.cleanupObservedAt)<=Date.parse(request.deadline),'ACTUAL_HISTORY_EXIT_AND_WHOLE_CONTAINER_CLEANUP_REQUIRED');
  for(const k of ['stdout','stderr'])check(HASH.test(o.attached.logs?.[k]?.sha256??'')&&Number.isSafeInteger(o.attached.logs[k].bytes)&&
    o.attached.logs[k].bytes>=0&&o.attached.logs[k].truncated===false,'BOUNDED_HISTORY_LOG_DIGEST_REQUIRED');
  return deepFreeze({contract:'clued.independent-ci.formal-scanner-observation/2',domain:'production-observation',fixture:false,profile:'required-gitleaks-history/1',
    subject:subjectOf(job),sourceManifestSha256:job.sourceManifestSha256,sourceSha:prepared.sourceSha,nonce:request.nonce,
    requestSha256:digest(request),historyPackSha256:prepared.packedHistorySha256,remoteRefsSha256:prepared.remoteSnapshotSha256,
    selfTestReportSha256:digest(selfTest),reviewedIgnoreSha256:selfTest.ignore_sha256,requiredHistoricalExceptions:REVIEWED_COMMITS.findings,
    reviewedHistoryProof:REVIEWED_HISTORY_PROOF,
    image:IMAGE,nativeImageDigest:MANIFEST_DIGEST,nativeImageRepositoryDigest:NATIVE_IMAGE,nativeImageId:o.imageId,runtimeIdentity:context.runtimeIdentity,hostAcceptanceRef:context.hostAcceptanceRef,sourceAcceptanceRef:context.sourceAcceptanceRef,
    startedAt:o.startedAt,finishedAt:o.finishedAt,conclusion:o.state.ExitCode===0?'success':'failure',exitCode:o.state.ExitCode,
    logs:o.attached.logs,containerId:o.containerId,cleanup:{complete:true,wholeContainerTreeStopped:true,containerRemoved:true,observedAt:o.cleanupObservedAt},
    evidenceClass:'unsigned-observation-requires-protected-result-issuer',formalEligible:false,checksWritten:false,qualificationIssued:false});
}
// Pure summaries/JSON cannot enter this consumer. Only this module's successful
// actual protected path adds its returned object to the private brand.
export function takeActualObservation(observation,job){
  validateRequiredJob(job);check(actualObservations.has(observation)&&canonical(observation.subject)===canonical(subjectOf(job)),
    'ACTUAL_PROTECTED_HISTORY_OBSERVATION_REQUIRED');return observation;
}

// Both ports must come from the installed accepted controller Source. A PR/job
// may supply neither. No JSON "protected:true" flag is accepted as a port.
export function createFormalGitleaksAdapter({admissionPort,remoteRefsPort}={}){
  return Object.freeze({async execute(job,{signal}={}){
    let run=null,runCreated=false,mayHaveStarted=false;
    try{
      job=snapshotJob(job);
      check(typeof admissionPort==='function'&&typeof remoteRefsPort==='function','PROTECTED_CONTROLLER_PORTS_MISSING');
      check(process.platform==='linux'&&process.getuid?.()===0,'FIXED_PROTECTED_LINUX_ROOT_REQUIRED');
      const {config,sourceManifestBytes,qualification}=await loadQualifiedPolicy('/etc/clued-independent-ci/roles-v3/gitleaks.json');
      check(config.executionMode==='scanner'&&config.image===IMAGE&&config.sourceManifestSha256===job.sourceManifestSha256,'QUALIFIED_JOB_CONTEXT_MISMATCH');
      check(config.memoryBytes===2147483648&&config.cpus===2&&config.pids===128&&config.dockerRootDirectory==='/var/lib/docker',
        'QUALIFIED_FIXED_HISTORY_RESOURCES_REQUIRED');
      const manifest=JSON.parse(sourceManifestBytes),python=await sourceBoundary(config,manifest);
      const before=deepFreeze(structuredClone(validateAdmission(job,await admissionPort(job))));
      // A-strict: every later admission of this run must name the same claim generation (renewal = same).
      const generation=before.batchClaimBound,again=async()=>validateAdmission(job,await admissionPort(job),Date.now(),{batchClaim:generation});
      // The refs snapshot is fresh at the issuance of the bridge response that carried it, while that response is valid
      // (protocol.mjs validateResponse, Task 576231fa), else at this moment. One reference time for all three checks of the
      // same snapshot: the two before the run directory and prepareRequiredHistory's after it, so one that passes here can
      // never fail there (UNCERTAIN) only because time went by.
      const given=await remoteRefsPort(job),refsAt=remoteRefsReferenceTime(given,Date.now());
      const remote=deepFreeze(structuredClone(given));validateRemoteSnapshot(remote,job,refsAt);
      const deadline=Math.min(Date.parse(before.claimExpiresAt),qualificationDeadline(qualification.payload));
      check(deadline>Date.now()&&!signal?.aborted,'CURRENT_AUTHORITY_EXPIRED');
      const cache=path.join(config.workspaceRoot,job.id,'.git');await protectedObjectTree(cache);
      // Clean, before the run directory: a push since the bundle is REMOTE_REFS_CHANGED_SINCE_BUNDLE.
      await refsInStore({job,remoteSnapshot:remote,gitDirectory:cache,gitExecutable:config.gitExecutable,expectedGitSha256:config.gitExecutableSha256,now:refsAt});
      run=path.join(config.runsRoot,'gitleaks-'+job.id);await fsp.mkdir(run,{mode:0o700});runCreated=true;mayHaveStarted=true;
      const nonce=randomBytes(32).toString('hex');
      await durableNew(path.join(run,'intent.json'),{contract:'clued.independent-ci.formal-gitleaks-intent/2',subject:subjectOf(job),nonce,admissionSha256:before.observationSha256,automaticRetryAllowed:false});
      const prepared=await prepareRequiredHistory({job,sourceManifestBytes,expectedSourceManifestSha256:config.sourceManifestSha256,
        trustedSourceDirectory:config.trustedSourceDirectory,gitDirectory:cache,remoteSnapshot:remote,outputDirectory:path.join(run,'history'),
        gitExecutable:config.gitExecutable,expectedGitSha256:config.gitExecutableSha256,now:refsAt});
      // The inherited fixed self-test has a 20 minute hard ceiling. Do not start
      // it under authority that cannot cover that existing worst-case bound.
      check(deadline-Date.now()>1200000&&!signal?.aborted,'AUTHORITY_WINDOW_TOO_SHORT_FOR_FIXED_SELF_TEST');
      const selfTest=await runReviewedSelfTest(reviewedSelfTestPlan(prepared,{node:{path:config.nodeExecutable,sha256:config.nodeExecutableSha256},python,
        git:{path:config.gitExecutable,sha256:config.gitExecutableSha256},docker:{path:config.dockerExecutable,sha256:config.dockerExecutableSha256},dockerRootDirectory:config.dockerRootDirectory}));
      const plan=validateHistoryPlan(await requiredScannerPlan(prepared,selfTest));
      await again();check(deadline>Date.now()&&!signal?.aborted,'AUTHORITY_EXPIRED_BEFORE_HISTORY');
      const request={nonce,executionId:randomUUID(),deadline:new Date(Math.min(deadline,Date.now()+plan.limits.timeoutMs)).toISOString()};
      const c={imageDigest:NATIVE_IMAGE,dockerRootDirectory:config.dockerRootDirectory,limits:plan.limits};
      // /repo retains the independently packed full history. This never calls
      // generic Linux launcher's tree-only /input copy or fixture executor.
      const actual=await observeUnsignedContainer(c,request,plan,dockerInvoke,{signal});
      const after=await again();check(deadline>Date.now(),'AUTHORITY_EXPIRED_AFTER_HISTORY');
      const summary=executionSummary(job,prepared,selfTest,plan,actual,request,config);
      const observation=deepFreeze({...summary,preAdmissionSha256:before.observationSha256,postAdmissionSha256:after.observationSha256});
      await durableNew(path.join(run,'observation.json'),observation);actualObservations.add(observation);
      return {status:'ACTUAL_HISTORY_OBSERVED_UNSIGNED',observation,formalEligible:false,checksWritten:false,qualificationIssued:false};
    }catch(e){const outcome={status:mayHaveStarted?'UNCERTAIN':'BLOCKED',reason:safe(e),sideEffectsMayHaveStarted:mayHaveStarted,formalEligible:false,checksWritten:false,qualificationIssued:false,automaticRetryAllowed:false};
      if(runCreated){try{await durableNew(path.join(run,'uncertain.json'),outcome);}catch{outcome.receiptPersistenceConfirmed=false;}}
      return outcome;
    }
  }});
}
