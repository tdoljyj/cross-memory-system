// Reuse the existing qualified Linux Ed25519 result identity/envelope. No key
// generation and no fixture or deserialized observation can reach the signer.
import fs from 'node:fs/promises';
import {createPublicKey,sign} from 'node:crypto';
import {canonical,subjectOf,verifyResult} from '../../src/proof.mjs';
import {loadQualifiedPolicy,protectedPath} from '../qualification.mjs';
import {takeActualObservation as takeGitleaks} from '../formal-gitleaks-v3/adapter.mjs';
import {takeActualObservation as takeTrivy} from '../formal-trivy-v3/adapter.mjs';
import {takeActualObservation as takePlacement,WORKFLOW_SHA256 as PLACEMENT_WORKFLOW_SHA256} from '../formal-contract-placement-v1/adapter.mjs';
import {loadFixedRolePolicy} from '../formal-fixed-role-policy-v2/policy.mjs';
import {takeAcceptedBridgeContext} from './boundary.mjs';
import {validateIssue,digest} from './protocol.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
// Pure time boundary; this never creates an actual context or signing right.
export function validateSigningTimes(issue,config,qualification,now=Date.now()){
  const q=qualification?.payload;
  check(Number.isSafeInteger(now)&&q?.schema==='independent-ci.runtime-qualification.v1'&&q.fixture===false&&Date.parse(q.qualifiedAt)<=now&&Date.parse(q.expiresAt)>now&&Date.parse(config?.currentClaim?.expiresAt)>now&&Date.parse(issue?.expiresAt)>now,'ACTUAL_SIGNING_AUTHORITY_EXPIRED');
  validateIssue(issue,now);
}
function observationFacts(issue,o){
  const gl=issue.job.role==='gitleaks',placement=issue.job.role==='contract-placement';
  check(o?.contract===(placement?'clued.independent-ci.formal-check-observation/1':'clued.independent-ci.formal-scanner-observation/1')&&o.domain==='production-observation'&&o.fixture===false&&o.formalEligible===false&&o.qualificationIssued===false&&o.checksWritten===false&&
    canonical(o.subject)===canonical(subjectOf(issue.job))&&o.sourceManifestSha256===issue.job.sourceManifestSha256&&
    o.profile===(gl?'required-gitleaks-history/1':placement?'required-contract-placement/1':'required-trivy-three-scanners/1')&&/^[a-f0-9]{40}$/.test(o.sourceSha??''),'ACTUAL_FORMAL_PROFILE_REQUIRED');
  if(placement){const keys=['contract','domain','fixture','profile','subject','sourceSha','sourceTreeSha','candidateTreeSha','sourceManifestSha256','workflowSha256','image','imageId','runtimeIdentity','hostAcceptanceRef','sourceAcceptanceRef','nonce','requestSha256','headBasePackSha256','commandSequenceSha256','toolPinsSha256','preAdmissionSha256','postAdmissionSha256','conclusion','exitCode','startedAt','finishedAt','logs','cleanup','evidenceClass','formalEligible','checksWritten','qualificationIssued'];
    check(Object.keys(o).sort().join('|')===keys.sort().join('|')&&o.workflowSha256===PLACEMENT_WORKFLOW_SHA256&&['sourceTreeSha','candidateTreeSha'].every(k=>/^[a-f0-9]{40}$/.test(o[k]??''))&&['nonce','requestSha256','headBasePackSha256','commandSequenceSha256','toolPinsSha256','preAdmissionSha256','postAdmissionSha256'].every(k=>/^[a-f0-9]{64}$/.test(o[k]??''))&&/^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(o.image??'')&&/^sha256:[a-f0-9]{64}$/.test(o.imageId??'')&&o.evidenceClass==='unsigned-observation-requires-protected-result-issuer','ACTUAL_PLACEMENT_EVIDENCE_REQUIRED');
    check(o.logs&&Object.keys(o.logs).sort().join('|')==='stderr|stdout'&&['stdout','stderr'].every(k=>Object.keys(o.logs[k]??{}).sort().join('|')==='bytes|sha256|truncated'&&/^[a-f0-9]{64}$/.test(o.logs[k].sha256??'')&&Number.isSafeInteger(o.logs[k].bytes)&&o.logs[k].bytes>=0&&o.logs[k].bytes<=16777216&&o.logs[k].truncated===false)&&Object.keys(o.cleanup??{}).sort().join('|')==='complete|containerRemoved|observedAt|wholeContainerTreeStopped'&&Date.parse(o.finishedAt)>=Date.parse(o.startedAt)&&Date.parse(o.cleanup.observedAt)>=Date.parse(o.finishedAt),'ACTUAL_PLACEMENT_TERMINAL_EVIDENCE_REQUIRED');
  }
  let start,end,exit,stdout,stderr;
  if(gl||placement){check((!gl||o.requiredHistoricalExceptions===726)&&o.cleanup?.complete===true&&o.cleanup.wholeContainerTreeStopped===true&&o.cleanup.containerRemoved===true,'ACTUAL_HISTORY_CLEANUP_REQUIRED');
    start=o.startedAt;end=o.cleanup.observedAt;exit=o.exitCode;stdout=o.logs?.stdout?.sha256;stderr=o.logs?.stderr?.sha256;
  }else{check(o.scans?.length===3&&o.scans.every(s=>s.complete===true&&s.cleanupConfirmed===true&&Number.isInteger(s.exitCode))&&o.cleanup?.containersRemoved===true&&o.cleanup.wholeContainerTreesStopped===true&&o.cleanup.snapshotRemoved===true,'ACTUAL_THREE_SCANNERS_CLEANUP_REQUIRED');
    start=new Date(Math.min(...o.scans.map(s=>Date.parse(s.startedAt)))).toISOString();end=o.cleanup.observedAt;exit=o.scans.find(s=>s.exitCode!==0)?.exitCode??0;
    stdout=digest(o.scans.map(s=>s.logs.stdout));stderr=digest(o.scans.map(s=>s.logs.stderr));}
  check(Number.isInteger(exit)&&exit>=0&&exit<=255&&(o.conclusion==='success')===(exit===0)&&Date.parse(start)>=Date.parse(issue.job.createdAt)&&Date.parse(end)>=Date.parse(start)&&Date.parse(end)<=Date.now()&&Date.parse(end)<=Date.parse(issue.expiresAt)&&
    /^[a-f0-9]{64}$/.test(stdout??'')&&/^[a-f0-9]{64}$/.test(stderr??''),'ACTUAL_EXECUTION_TERMINAL_REQUIRED');return{startedAt:start,finishedAt:end,exitCode:exit,stdoutSha256:stdout,stderrSha256:stderr};
}
export async function signActualBridgeResult(context,issue,observation){
  takeAcceptedBridgeContext(context);check(context.side==='linux','ACTUAL_LINUX_SIGNER_CONTEXT_REQUIRED');validateIssue(issue);
  (issue.job.role==='gitleaks'?takeGitleaks:issue.job.role==='trivy'?takeTrivy:takePlacement)(observation,issue.job);
  const facts=observationFacts(issue,observation),{config,publicKey,qualification}=await loadFixedRolePolicy(issue.job);
  check(config.sourceManifestSha256===issue.job.sourceManifestSha256&&config.sourceAcceptanceRef===issue.sourceAcceptanceRef&&config.hostAcceptanceRef===issue.hostQualificationRef&&observation.image===config.image&&observation.runtimeIdentity===config.runtimeIdentity&&observation.hostAcceptanceRef===config.hostAcceptanceRef&&observation.sourceAcceptanceRef===config.sourceAcceptanceRef&&
    ['claimId','fence','epoch'].every(k=>config.currentClaim[k]===issue.job[k]),'ACTUAL_RESULT_AUTHORITY_CHANGED');
  await protectedPath(config.signingKeyFile,{privateFile:true});const key=await fs.readFile(config.signingKeyFile),pub=createPublicKey(key);
  check(pub.asymmetricKeyType==='ed25519'&&pub.export({type:'spki',format:'der'}).equals(createPublicKey(publicKey).export({type:'spki',format:'der'})),'EXISTING_RESULT_KEY_CHANGED');
  const payload={contract:'independent-ci.execution-result.v1',domain:'production',runtimeId:config.runtimeIdentity,subject:subjectOf(issue.job),...facts,
    conclusion:observation.conclusion,artifactsSha256:digest([]),requestDigest:digest(issue),sourceSha:observation.sourceSha,
    executionObservationSha256:digest(observation),profile:observation.profile,cleanupSha256:digest(observation.cleanup),logDigestMode:issue.job.role==='trivy'?'canonical-scan-log-digests':'actual-stream-sha256'};
  check(Buffer.byteLength(canonical(payload))<=262144,'EXISTING_RESULT_ENVELOPE_BOUND');
  const signingBytes=Buffer.from(canonical(payload));
  // The protected key read/match can cross expiry too. Check the actual clock
  // immediately before the synchronous signing effect, with no intervening await.
  validateSigningTimes(issue,config,qualification,Date.now());
  const envelope={contract:'independent-ci.signed-result.v1',keyId:config.keyId,payload,signature:sign(null,signingBytes,key).toString('base64url')};
  return{contract:'clued.independent-ci.protected-job-result/1',domain:'production',issueSha256:digest(issue),envelope,observation};
}
export function verifySignedBridgeResult({issue,wrapper,signers,now=Date.now()}){
  validateIssue(issue,now);check(wrapper&&Object.keys(wrapper).sort().join('|')==='contract|domain|envelope|issueSha256|observation'&&wrapper.contract==='clued.independent-ci.protected-job-result/1'&&wrapper.domain==='production'&&wrapper.issueSha256===digest(issue),'SIGNED_BRIDGE_RESULT_BINDING_REQUIRED');
  const facts=observationFacts(issue,wrapper.observation),verified=verifyResult({job:issue.job,envelope:wrapper.envelope,signers,domain:'production',now});
  const p=verified.payload;check(p.requestDigest===digest(issue)&&p.profile===wrapper.observation.profile&&p.sourceSha===wrapper.observation.sourceSha&&p.executionObservationSha256===digest(wrapper.observation)&&p.cleanupSha256===digest(wrapper.observation.cleanup)&&
    Object.entries(facts).every(([k,v])=>p[k]===v)&&p.conclusion===wrapper.observation.conclusion&&verified.signer.sourceAcceptanceRef===issue.sourceAcceptanceRef&&verified.signer.qualificationRef===issue.hostQualificationRef,'SIGNED_FORMAL_OBSERVATION_CHANGED');
  return verified;
}
