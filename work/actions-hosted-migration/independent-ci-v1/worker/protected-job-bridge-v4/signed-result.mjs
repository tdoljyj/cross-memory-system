// Source v2 port of protected-job-bridge-v3/signed-result.mjs (DESIGN S6). Reuses the existing qualified
// Linux Ed25519 result identity; no key generation and no fixture or deserialized observation can reach
// the signer. Changes: v2 subjects and result/envelope contracts (proof-v2.mjs), wrapper contract /2 (read
// by resident-v2/invoke-stage.mjs#readSpoolResult), observation contracts /2, qualification v2 deadline,
// and no currentClaim: the claim is bound through the issue's admission facts, not the role policy.
// trivy's observation is contract /3 (DESIGN 64.3): per-scanner pre and post admission hashes are required; /2 is refused.
// A scan result cache hit (DESIGN 65, trivy only) is the same contract with cacheHit instead of scans: the original
// observation and its signed envelope travel inside cacheHit. Its execution window is this run's (start cacheHit.servedAt);
// exit code and log digests come from the original scanners, all recorded no later than cacheHit.storedAt. The signer and
// the Windows issuer verify the original envelope with the qualified result key, and the signed payload marks the hit.
import fs from 'node:fs/promises';
import {createPublicKey,sign} from 'node:crypto';
import {canonical} from '../../src/proof.mjs';
import {subjectOfV2} from '../../src/job-v2.mjs';
import {verifyResultV2,RESULT_CONTRACT_V2,ENVELOPE_CONTRACT_V2} from '../../src/proof-v2.mjs';
import {protectedPath,qualificationDeadline,QUALIFICATION_SCHEMA_V2} from '../qualification-v2.mjs';
import {takeActualObservation as takeGitleaks} from '../formal-gitleaks-v4/adapter.mjs';
import {REVIEWED_COMMITS,matchesReviewedHistoryProof} from '../formal-gitleaks-v4/required-history/prepare.mjs';
import {takeActualObservation as takeTrivy,TRIVY_OBSERVATION_CONTRACT} from '../formal-trivy-v4/adapter.mjs';
import {takeActualObservation as takePlacement,WORKFLOW_SHA256S as PLACEMENT_WORKFLOW_SHA256S} from '../formal-contract-placement-v2/adapter.mjs';
import {loadFixedRolePolicy} from '../formal-fixed-role-policy-v3/policy.mjs';
import {validateCacheHitEvidence,verifyOriginalEnvelope,cacheHitMarker} from '../scan-result-cache-v1/cache.mjs';
import {takeAcceptedBridgeContext} from './boundary.mjs';
import {validateIssue,digest} from './protocol.mjs';
export const RESULT_WRAPPER_CONTRACT_V2='clued.independent-ci.protected-job-result/2';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
// Pure time boundary; this never creates an actual context or signing right.
export function validateSigningTimes(issue,qualification,now=Date.now()){
  const q=qualification?.payload;
  check(Number.isSafeInteger(now)&&q?.schema===QUALIFICATION_SCHEMA_V2&&q.fixture===false&&Date.parse(q.qualifiedAt)<=now&&qualificationDeadline(q)>now&&Date.parse(issue?.expiresAt)>now,'ACTUAL_SIGNING_AUTHORITY_EXPIRED');
  validateIssue(issue,now);
}
export function observationFacts(issue,o,now=Date.now()){
  const gl=issue.job.role==='gitleaks',placement=issue.job.role==='contract-placement',sha=v=>/^[a-f0-9]{64}$/.test(v??'');
  check(o?.contract===(placement?'clued.independent-ci.formal-check-observation/2':gl?'clued.independent-ci.formal-scanner-observation/2':TRIVY_OBSERVATION_CONTRACT)&&o.domain==='production-observation'&&o.fixture===false&&o.formalEligible===false&&o.qualificationIssued===false&&o.checksWritten===false&&
    canonical(o.subject)===canonical(subjectOfV2(issue.job))&&o.sourceManifestSha256===issue.job.sourceManifestSha256&&
    o.profile===(gl?'required-gitleaks-history/1':placement?'required-contract-placement/1':'required-trivy-three-scanners/1')&&/^[a-f0-9]{40}$/.test(o.sourceSha??''),'ACTUAL_FORMAL_PROFILE_REQUIRED');
  const hit=Object.hasOwn(o,'cacheHit');if(hit)validateCacheHitEvidence(o.cacheHit,issue.job.role,o);
  if(placement){const keys=['contract','domain','fixture','profile','subject','sourceSha','sourceTreeSha','candidateTreeSha','sourceManifestSha256','workflowSha256','image','imageId','runtimeIdentity','hostAcceptanceRef','sourceAcceptanceRef','nonce','requestSha256','headBasePackSha256','commandSequenceSha256','toolPinsSha256','preAdmissionSha256','postAdmissionSha256','conclusion','exitCode','startedAt','finishedAt','logs','cleanup','evidenceClass','formalEligible','checksWritten','qualificationIssued'];
    check(Object.keys(o).sort().join('|')===keys.sort().join('|')&&PLACEMENT_WORKFLOW_SHA256S.includes(o.workflowSha256)&&['sourceTreeSha','candidateTreeSha'].every(k=>/^[a-f0-9]{40}$/.test(o[k]??''))&&['nonce','requestSha256','headBasePackSha256','commandSequenceSha256','toolPinsSha256','preAdmissionSha256','postAdmissionSha256'].every(k=>/^[a-f0-9]{64}$/.test(o[k]??''))&&/^(?:sha256:[a-f0-9]{64}|[^\s,@]+@sha256:[a-f0-9]{64})$/.test(o.image??'')&&/^sha256:[a-f0-9]{64}$/.test(o.imageId??'')&&o.evidenceClass==='unsigned-observation-requires-protected-result-issuer','ACTUAL_PLACEMENT_EVIDENCE_REQUIRED');
    check(o.logs&&Object.keys(o.logs).sort().join('|')==='stderr|stdout'&&['stdout','stderr'].every(k=>Object.keys(o.logs[k]??{}).sort().join('|')==='bytes|sha256|truncated'&&/^[a-f0-9]{64}$/.test(o.logs[k].sha256??'')&&Number.isSafeInteger(o.logs[k].bytes)&&o.logs[k].bytes>=0&&o.logs[k].bytes<=16777216&&o.logs[k].truncated===false)&&Object.keys(o.cleanup??{}).sort().join('|')==='complete|containerRemoved|observedAt|wholeContainerTreeStopped'&&Date.parse(o.finishedAt)>=Date.parse(o.startedAt)&&Date.parse(o.cleanup.observedAt)>=Date.parse(o.finishedAt),'ACTUAL_PLACEMENT_TERMINAL_EVIDENCE_REQUIRED');
  }
  let start,end,exit,stdout,stderr;
  if(gl||placement){check((!gl||o.requiredHistoricalExceptions===REVIEWED_COMMITS.findings&&matchesReviewedHistoryProof(o.reviewedHistoryProof))&&o.cleanup?.complete===true&&o.cleanup.wholeContainerTreeStopped===true&&o.cleanup.containerRemoved===true,'ACTUAL_HISTORY_CLEANUP_REQUIRED');
    start=o.startedAt;end=o.cleanup.observedAt;exit=o.exitCode;stdout=o.logs?.stdout?.sha256;stderr=o.logs?.stderr?.sha256;
  }else{const scans=hit?o.cacheHit.originalObservation.scans:o.scans;
    check(!hit||!Object.hasOwn(o,'scans')&&o.conclusion===o.cacheHit.originalObservation.conclusion,'SCAN_RESULT_CACHE_HIT_EVIDENCE_REQUIRED');
    check(scans?.length===3&&scans.every(s=>s.complete===true&&s.cleanupConfirmed===true&&Number.isInteger(s.exitCode))&&o.cleanup?.containersRemoved===true&&o.cleanup.wholeContainerTreesStopped===true&&o.cleanup.snapshotRemoved===true,'ACTUAL_THREE_SCANNERS_CLEANUP_REQUIRED');
    check(sha(o.preAdmissionSha256)&&sha(o.postAdmissionSha256)&&scans.every(s=>sha(s.preAdmissionSha256)&&sha(s.postAdmissionSha256)),'ACTUAL_TRIVY_SCAN_ADMISSIONS_REQUIRED');
    start=hit?o.cacheHit.servedAt:new Date(Math.min(...scans.map(s=>Date.parse(s.startedAt)))).toISOString();end=o.cleanup.observedAt;exit=scans.find(s=>s.exitCode!==0)?.exitCode??0;
    stdout=digest(scans.map(s=>s.logs.stdout));stderr=digest(scans.map(s=>s.logs.stderr));}
  check(Number.isInteger(exit)&&exit>=0&&exit<=255&&(o.conclusion==='success')===(exit===0)&&Date.parse(start)>=Date.parse(issue.job.createdAt)&&Date.parse(end)>=Date.parse(start)&&Date.parse(end)<=now&&Date.parse(end)<=Date.parse(issue.expiresAt)&&
    /^[a-f0-9]{64}$/.test(stdout??'')&&/^[a-f0-9]{64}$/.test(stderr??''),'ACTUAL_EXECUTION_TERMINAL_REQUIRED');return{startedAt:start,finishedAt:end,exitCode:exit,stdoutSha256:stdout,stderrSha256:stderr};
}
// Pure payload assembly (shared by the signer and the offline tests).
export function resultPayload(issue,observation,facts,runtimeIdentity){
  return{contract:RESULT_CONTRACT_V2,domain:'production',runtimeId:runtimeIdentity,subject:subjectOfV2(issue.job),...facts,
    conclusion:observation.conclusion,artifactsSha256:digest([]),requestDigest:digest(issue),sourceSha:observation.sourceSha,
    executionObservationSha256:digest(observation),profile:observation.profile,cleanupSha256:digest(observation.cleanup),logDigestMode:issue.job.role==='trivy'?'canonical-scan-log-digests':'actual-stream-sha256',
    cacheHit:cacheHitMarker(observation)};
}
export async function signActualBridgeResult(context,issue,observation){
  takeAcceptedBridgeContext(context);check(context.side==='linux','ACTUAL_LINUX_SIGNER_CONTEXT_REQUIRED');validateIssue(issue);
  (issue.job.role==='gitleaks'?takeGitleaks:issue.job.role==='trivy'?takeTrivy:takePlacement)(observation,issue.job);
  const facts=observationFacts(issue,observation),{config,publicKey,qualification}=await loadFixedRolePolicy(issue.job);
  check(config.sourceManifestSha256===issue.job.sourceManifestSha256&&config.sourceAcceptanceRef===issue.sourceAcceptanceRef&&config.hostAcceptanceRef===issue.hostQualificationRef&&observation.image===config.image&&observation.runtimeIdentity===config.runtimeIdentity&&observation.hostAcceptanceRef===config.hostAcceptanceRef&&observation.sourceAcceptanceRef===config.sourceAcceptanceRef,'ACTUAL_RESULT_AUTHORITY_CHANGED');
  // A hit: the original result must have been signed by this same qualified key (DESIGN 65.2).
  if(observation.cacheHit)verifyOriginalEnvelope(observation.cacheHit.originalEnvelope,{publicKeyPem:publicKey,keyId:config.keyId,runtimeId:config.runtimeIdentity},observation.cacheHit.originalObservation);
  await protectedPath(config.signingKeyFile,{privateFile:true});const key=await fs.readFile(config.signingKeyFile),pub=createPublicKey(key);
  check(pub.asymmetricKeyType==='ed25519'&&pub.export({type:'spki',format:'der'}).equals(createPublicKey(publicKey).export({type:'spki',format:'der'})),'EXISTING_RESULT_KEY_CHANGED');
  const payload=resultPayload(issue,observation,facts,config.runtimeIdentity);
  check(Buffer.byteLength(canonical(payload))<=262144,'EXISTING_RESULT_ENVELOPE_BOUND');
  const signingBytes=Buffer.from(canonical(payload));
  // The protected key read/match can cross expiry too. Check the actual clock
  // immediately before the synchronous signing effect, with no intervening await.
  validateSigningTimes(issue,qualification,Date.now());
  const envelope={contract:ENVELOPE_CONTRACT_V2,keyId:config.keyId,payload,signature:sign(null,signingBytes,key).toString('base64url')};
  return{contract:RESULT_WRAPPER_CONTRACT_V2,domain:'production',issueSha256:digest(issue),envelope,observation};
}
export function verifySignedBridgeResult({issue,wrapper,signers,now=Date.now()}){
  validateIssue(issue,now);check(wrapper&&Object.keys(wrapper).sort().join('|')==='contract|domain|envelope|issueSha256|observation'&&wrapper.contract===RESULT_WRAPPER_CONTRACT_V2&&wrapper.domain==='production'&&wrapper.issueSha256===digest(issue),'SIGNED_BRIDGE_RESULT_BINDING_REQUIRED');
  const facts=observationFacts(issue,wrapper.observation,now),verified=verifyResultV2({job:issue.job,envelope:wrapper.envelope,signers,domain:'production',now});
  const p=verified.payload;check(p.requestDigest===digest(issue)&&p.profile===wrapper.observation.profile&&p.sourceSha===wrapper.observation.sourceSha&&p.executionObservationSha256===digest(wrapper.observation)&&p.cleanupSha256===digest(wrapper.observation.cleanup)&&
    Object.entries(facts).every(([k,v])=>p[k]===v)&&p.conclusion===wrapper.observation.conclusion&&verified.signer.sourceAcceptanceRef===issue.sourceAcceptanceRef&&verified.signer.qualificationRef===issue.hostQualificationRef
    &&canonical(p.cacheHit??null)===canonical(cacheHitMarker(wrapper.observation)),'SIGNED_FORMAL_OBSERVATION_CHANGED');
  // A hit: the issuer itself checks that the original observation was signed by a production signer of this same Source
  // and qualification (its own signer table, not the Linux side's word).
  const hit=wrapper.observation.cacheHit;
  if(hit){const original=hit.originalEnvelope,signer=signers?.get(original?.keyId);
    check(signer&&signer.domain==='production'&&signer.sourceAcceptanceRef===issue.sourceAcceptanceRef&&signer.qualificationRef===issue.hostQualificationRef,'SCAN_RESULT_CACHE_ENVELOPE_REFUSED');
    verifyOriginalEnvelope(original,{publicKeyPem:signer.publicKeyPem,keyId:original.keyId,runtimeId:signer.runtimeId},hit.originalObservation);}
  return verified;
}
