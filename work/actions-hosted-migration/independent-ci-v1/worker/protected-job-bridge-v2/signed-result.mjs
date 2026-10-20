// Reuse the existing qualified Linux Ed25519 result identity/envelope. No key
// generation and no fixture or deserialized observation can reach the signer.
import fs from 'node:fs/promises';
import {createPublicKey,sign} from 'node:crypto';
import {canonical,subjectOf,verifyResult} from '../../src/proof.mjs';
import {loadQualifiedPolicy,protectedPath} from '../qualification.mjs';
import {takeActualObservation as takeGitleaks} from '../formal-gitleaks-v2/adapter.mjs';
import {takeActualObservation as takeTrivy} from '../formal-trivy-v2/adapter.mjs';
import {takeAcceptedBridgeContext} from './boundary.mjs';
import {validateIssue,digest} from './protocol.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
function observationFacts(issue,o){
  const gl=issue.job.role==='gitleaks';
  check(o?.contract==='clued.independent-ci.formal-scanner-observation/1'&&o.domain==='production-observation'&&o.fixture===false&&o.formalEligible===false&&o.qualificationIssued===false&&o.checksWritten===false&&
    canonical(o.subject)===canonical(subjectOf(issue.job))&&o.sourceManifestSha256===issue.job.sourceManifestSha256&&
    o.profile===(gl?'required-gitleaks-history/1':'required-trivy-three-scanners/1')&&/^[a-f0-9]{40}$/.test(o.sourceSha??''),'ACTUAL_FORMAL_PROFILE_REQUIRED');
  let start,end,exit,stdout,stderr;
  if(gl){check(o.requiredHistoricalExceptions===533&&o.cleanup?.complete===true&&o.cleanup.wholeContainerTreeStopped===true&&o.cleanup.containerRemoved===true,'ACTUAL_HISTORY_CLEANUP_REQUIRED');
    start=o.startedAt;end=o.cleanup.observedAt;exit=o.exitCode;stdout=o.logs?.stdout?.sha256;stderr=o.logs?.stderr?.sha256;
  }else{check(o.scans?.length===3&&o.scans.every(s=>s.complete===true&&s.cleanupConfirmed===true&&Number.isInteger(s.exitCode))&&o.cleanup?.containersRemoved===true&&o.cleanup.wholeContainerTreesStopped===true&&o.cleanup.snapshotRemoved===true,'ACTUAL_THREE_SCANNERS_CLEANUP_REQUIRED');
    start=new Date(Math.min(...o.scans.map(s=>Date.parse(s.startedAt)))).toISOString();end=o.cleanup.observedAt;exit=o.scans.find(s=>s.exitCode!==0)?.exitCode??0;
    stdout=digest(o.scans.map(s=>s.logs.stdout));stderr=digest(o.scans.map(s=>s.logs.stderr));}
  check(Number.isInteger(exit)&&exit>=0&&exit<=255&&(o.conclusion==='success')===(exit===0)&&Date.parse(start)>=Date.parse(issue.job.createdAt)&&Date.parse(end)>=Date.parse(start)&&Date.parse(end)<=Date.now()&&Date.parse(end)<=Date.parse(issue.expiresAt)&&
    /^[a-f0-9]{64}$/.test(stdout??'')&&/^[a-f0-9]{64}$/.test(stderr??''),'ACTUAL_EXECUTION_TERMINAL_REQUIRED');return{startedAt:start,finishedAt:end,exitCode:exit,stdoutSha256:stdout,stderrSha256:stderr};
}
export async function signActualBridgeResult(context,issue,observation){
  takeAcceptedBridgeContext(context);check(context.side==='linux','ACTUAL_LINUX_SIGNER_CONTEXT_REQUIRED');validateIssue(issue);
  (issue.job.role==='gitleaks'?takeGitleaks:takeTrivy)(observation,issue.job);
  const facts=observationFacts(issue,observation),{config,publicKey}=await loadQualifiedPolicy();
  check(config.sourceManifestSha256===issue.job.sourceManifestSha256&&config.sourceAcceptanceRef===issue.sourceAcceptanceRef&&config.hostAcceptanceRef===issue.hostQualificationRef&&observation.runtimeIdentity===config.runtimeIdentity&&observation.hostAcceptanceRef===config.hostAcceptanceRef&&observation.sourceAcceptanceRef===config.sourceAcceptanceRef&&
    ['claimId','fence','epoch'].every(k=>config.currentClaim[k]===issue.job[k]),'ACTUAL_RESULT_AUTHORITY_CHANGED');
  await protectedPath(config.signingKeyFile,{privateFile:true});const key=await fs.readFile(config.signingKeyFile),pub=createPublicKey(key);
  check(pub.asymmetricKeyType==='ed25519'&&pub.export({type:'spki',format:'der'}).equals(createPublicKey(publicKey).export({type:'spki',format:'der'})),'EXISTING_RESULT_KEY_CHANGED');
  const payload={contract:'independent-ci.execution-result.v1',domain:'production',runtimeId:config.runtimeIdentity,subject:subjectOf(issue.job),...facts,
    conclusion:observation.conclusion,artifactsSha256:digest([]),requestDigest:digest(issue),sourceSha:observation.sourceSha,
    executionObservationSha256:digest(observation),profile:observation.profile,cleanupSha256:digest(observation.cleanup),logDigestMode:issue.job.role==='gitleaks'?'actual-stream-sha256':'canonical-scan-log-digests'};
  check(Buffer.byteLength(canonical(payload))<=262144,'EXISTING_RESULT_ENVELOPE_BOUND');
  const envelope={contract:'independent-ci.signed-result.v1',keyId:config.keyId,payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64url')};
  return{contract:'clued.independent-ci.protected-job-result/1',domain:'production',issueSha256:digest(issue),envelope,observation};
}
export function verifySignedBridgeResult({issue,wrapper,signers,now=Date.now()}){
  validateIssue(issue,now);check(wrapper&&Object.keys(wrapper).sort().join('|')==='contract|domain|envelope|issueSha256|observation'&&wrapper.contract==='clued.independent-ci.protected-job-result/1'&&wrapper.domain==='production'&&wrapper.issueSha256===digest(issue),'SIGNED_BRIDGE_RESULT_BINDING_REQUIRED');
  const facts=observationFacts(issue,wrapper.observation),verified=verifyResult({job:issue.job,envelope:wrapper.envelope,signers,domain:'production',now});
  const p=verified.payload;check(p.requestDigest===digest(issue)&&p.profile===wrapper.observation.profile&&p.sourceSha===wrapper.observation.sourceSha&&p.executionObservationSha256===digest(wrapper.observation)&&p.cleanupSha256===digest(wrapper.observation.cleanup)&&
    Object.entries(facts).every(([k,v])=>p[k]===v)&&p.conclusion===wrapper.observation.conclusion&&verified.signer.sourceAcceptanceRef===issue.sourceAcceptanceRef&&verified.signer.qualificationRef===issue.hostQualificationRef,'SIGNED_FORMAL_OBSERVATION_CHANGED');
  return verified;
}
