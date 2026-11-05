// Fixed Linux side (Source v2 port of protected-job-bridge-v3/linux-worker.mjs; DESIGN S6, S7, S10).
// No GitHub/Native credential, API client or Check writer. Started only by systemd
// (clued-ci-worker@<jobId>.service, ExecStart = the pinned toolchain node, S10).
// Changes against v3: no currentClaim (the claim generation travels inside the issue's admission facts and
// every callback must keep it, protocol.mjs), v4/v2 adapters, role policy v3, and the clean-blocked path:
// an adapter that ended BLOCKED before any scanner touched the PR (before preparing it, or trivy's clean cache
// refusal) releases the serial role slot and publishes a
// 'blocked' record, so the Windows issuer ends the stage cleanly instead of waiting out its deadline.
import {loadLinuxContext,takeAcceptedBridgeContext} from './boundary.mjs';
import {openAcceptedMailbox,takeActualMailbox} from './mailbox.mjs';
import {validateIssue,makeChallenge,validateResponse,makeBlocked,decode,encode,digest} from './protocol.mjs';
import {signActualBridgeResult} from './signed-result.mjs';
import {createFormalGitleaksAdapter} from '../formal-gitleaks-v4/adapter.mjs';
import {createFormalTrivyAdapter} from '../formal-trivy-v4/adapter.mjs';
import {createFormalContractPlacementAdapter} from '../formal-contract-placement-v2/adapter.mjs';
import {openFixedRoleSession,takeActualRoleSession} from '../formal-fixed-role-policy-v3/policy.mjs';
import {readFixedIssueJob} from './issue-job.mjs';
import {canonical} from '../../src/proof.mjs';
import {noteBridgeResponseTimes,noteBridgeRefsTimes} from '../../src/admission-facts-v2.mjs';
import {validateScanStartGrant,noteScanStartResponseWindow} from '../../src/scan-start-v1/grant.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??e?.message??'')?(e.code??e.message):'FORMAL_BRIDGE_UNCONFIRMED';
// The code a clean adapter refusal is published under. Pure.
export function cleanBlockedReason(reason){
  if(reason==='REMOTE_REFS_CHANGED_SINCE_BUNDLE')return reason;
  if(['FORMAL_MAILBOX_WAIT_UNCONFIRMED','BRIDGE_RESPONSE_EXPIRED','BRIDGE_CHALLENGE_EXPIRED'].includes(reason))return 'BRIDGE_CALLBACK_DEADLINE';
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(reason??'')?reason:'LINUX_PREPARATION_REFUSED';
}
export const isCleanBlocked=r=>r?.status==='BLOCKED'&&r.sideEffectsMayHaveStarted===false&&r.snapshotRetained!==true&&!r.observation;
// What a validated callback response gives the adapter. An admission keeps its response's issuance and expiry, so the
// adapter's own re-check measures freshness from the issuance while that response is valid (Owner Decision 6f1fb753);
// a refs snapshot keeps them too (remoteRefsReferenceTime, Task 576231fa).
export const callbackValue=(action,response)=>action==='scan-start'
  ?noteScanStartResponseWindow(response.scanStart,response)
  :action==='admission'?noteBridgeResponseTimes(response.admission,response):noteBridgeRefsTimes(response.remoteRefs,response);
export async function executeProtectedIssuedJob(options={}){
  let locked=false,executionMayHaveStarted=false;
  try{
    check(options&&Object.keys(options).every(k=>k==='signal'),'CALLER_LINUX_BRIDGE_CAPABILITY_REFUSED');const{signal}=options;
    const selectedJob=await readFixedIssueJob();const context=await loadLinuxContext(selectedJob);takeAcceptedBridgeContext(context);const box=takeActualMailbox(await openAcceptedMailbox(context));await box.lock();locked=true;
    const issue=validateIssue(decode(await box.read('issue'))),job=issue.job;
    check(job.role===context.role&&job.sourceManifestSha256===context.config.sourceManifestSha256&&issue.sourceAcceptanceRef===context.sourceAcceptanceRef&&issue.hostQualificationRef===context.hostQualificationRef,'FORMAL_ISSUE_QUALIFICATION_CHANGED');
    let sequence=0,scanStartRequested=false;
    const callback=async(action,subject)=>{check(canonical(subject)===canonical(job),'FORMAL_CALLBACK_SUBJECT_CHANGED');
      if(action==='scan-start'){check(!scanStartRequested,'SCAN_START_ONCE_REQUIRED');scanStartRequested=true;}
      const fresh=await loadLinuxContext(job);check(fresh.sourceAcceptanceRef===context.sourceAcceptanceRef&&fresh.hostQualificationRef===context.hostQualificationRef&&fresh.config.sourceManifestSha256===job.sourceManifestSha256,'FORMAL_CALLBACK_AUTHORITY_CHANGED');
      const request=makeChallenge(issue,action,++sequence),suffix=String(sequence).padStart(2,'0');await box.write('challenge-'+suffix,encode(request));
      const response=validateResponse(issue,request,decode(await box.wait('response-'+suffix,{deadline:Date.parse(request.deadline),signal})));
      return callbackValue(action,response);
    };
    // Adapters cannot prepare until their first callback gets a fresh actual
    // production response through the accepted Root-protected relay.
    const ports=Object.freeze({admissionPort:subject=>callback('admission',subject),remoteRefsPort:subject=>callback('remote-refs',subject),
      scanStartPort:async subject=>{const grant=await callback('scan-start',subject);validateScanStartGrant(grant,{job,executionId:issue.issueId});return grant;}});
    const session=takeActualRoleSession(await openFixedRoleSession(job));
    const adapter=job.role==='gitleaks'?createFormalGitleaksAdapter(ports):job.role==='trivy'?createFormalTrivyAdapter(ports):createFormalContractPlacementAdapter(ports);executionMayHaveStarted=true;
    const result=await adapter.execute(job,{signal});
    if(isCleanBlocked(result)){
      await session.releaseClean(result);const reason=cleanBlockedReason(result.reason);
      await box.write('blocked',encode(makeBlocked(issue,reason)));
      return{status:'CLEAN_BLOCKED_PUBLISHED',reason,issueSha256:digest(issue),preparationStarted:false,automaticRetryAllowed:false,bridgeLockRetained:true,checksWritten:false,qualificationIssued:false};
    }
    check(result?.observation,'ACTUAL_SCANNER_OBSERVATION_MISSING');
    await callback('admission',job);await session.finish(result.observation);const signed=await signActualBridgeResult(context,issue,result.observation);
    const bytes=Buffer.from(canonical(signed));await box.write('result',bytes);
    return{status:'ACTUAL_SIGNED_ROLE_RESULT_EMITTED',issueSha256:digest(issue),resultSha256:digest(signed),cleanupConfirmed:true,checksWritten:false,qualificationIssued:false,automaticRetryAllowed:false};
  }catch(e){return{status:locked?'UNCERTAIN':'BLOCKED',reason:safe(e),executionMayHaveStarted,automaticRetryAllowed:false,checksWritten:false,qualificationIssued:false};}
}
export async function main(argv=process.argv.slice(2),output=process.stdout){
  if(argv.length!==1||argv[0]!=='--run'){output.write(JSON.stringify({status:'BLOCKED',reason:'FIXED_LINUX_BRIDGE_RUN_REQUIRED'})+'\n');return 2;}
  const r=await executeProtectedIssuedJob();output.write(JSON.stringify(r)+'\n');return ['ACTUAL_SIGNED_ROLE_RESULT_EMITTED','CLEAN_BLOCKED_PUBLISHED'].includes(r.status)?0:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
