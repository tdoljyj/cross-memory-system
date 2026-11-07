// Fixed Linux side (Source v2 port of protected-job-bridge-v3/linux-worker.mjs; DESIGN S6, S7, S10).
// No GitHub/Native credential, API client or Check writer. Started only by systemd
// (clued-ci-worker@<jobId>.service, ExecStart = the pinned toolchain node, S10).
// Changes against v3: no currentClaim (the claim generation travels inside the issue's admission facts and
// every callback must keep it, protocol.mjs), v4/v2 adapters, role policy v3, and the clean-blocked path:
// an adapter that ended BLOCKED before any scanner touched the PR (before preparing it, or trivy's clean cache
// refusal) releases the serial role slot and publishes a
// 'blocked' record, so the Windows issuer ends the stage cleanly instead of waiting out its deadline.
// CI Source round-trip trim: before signing, the adapter's own post admission (the observation's postAdmissionSha256, the
// admission callback answered just before) is used when it is still fresh (adapterFinalAdmission); only otherwise is one more
// admission challenge written. The Windows issuer still makes its complete admission after the signed result arrives.
// bf57ff10 P2 D (2026-11-07): each callback checks policy, manifest, qualification and refs before its challenge; only the
// Git/Source re-hash overlaps the wait for Windows (it must pass before the response is used); the start and the end no
// longer load the same role policy twice in a row.
import {loadLinuxContext,loadLinuxRelayContext,takeAcceptedBridgeContext} from './boundary.mjs';
import {openAcceptedMailbox,takeActualMailbox} from './mailbox.mjs';
import {validateIssue,makeChallenge,validateResponse,makeBlocked,decode,encode,digest,issueGeneration} from './protocol.mjs';
import {signActualBridgeResult} from './signed-result.mjs';
import {createFormalGitleaksAdapter} from '../formal-gitleaks-v4/adapter.mjs';
import {createFormalTrivyAdapter} from '../formal-trivy-v4/adapter.mjs';
import {createFormalContractPlacementAdapter} from '../formal-contract-placement-v2/adapter.mjs';
import {openFixedRoleSession,takeActualRoleSession} from '../formal-fixed-role-policy-v3/policy.mjs';
import {readFixedIssueJob} from './issue-job.mjs';
import {canonical} from '../../src/proof.mjs';
import {noteBridgeResponseTimes,noteBridgeRefsTimes,validateFormalAdmissionV2} from '../../src/admission-facts-v2.mjs';
import {validateScanStartGrant,noteScanStartResponseWindow,NATIVE_SCAN_START_REQUIRED,localScanStart} from '../../src/scan-start-v1/grant.mjs';
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
// The freshness window of the adapter's final admission at signing: clock-skew.mjs FRESH_MS, on this host's monotonic clock
// from the moment its challenge was written (no later than the Windows issuance), like formal-trivy-v4 carriedAdmission.
export const FINAL_ADMISSION_REUSE_MAX_MS=30_000;
// Pure: the last admission callback answer may stand in for a new challenge before signing when it is exactly the
// admission the observation names as its post admission, inside the window, and still accepted by the full v2 check under
// the issue's claim generation. null means write one more admission challenge.
export function adapterFinalAdmission(job,generation,held,observation,{now=Date.now(),nowMono}={}){
  if(!held||!/^[a-f0-9]{64}$/.test(observation?.postAdmissionSha256??'')||held.facts?.observationSha256!==observation.postAdmissionSha256)return null;
  const age=nowMono-held.sentMono;if(!(Number.isFinite(age)&&age>=0&&age<=FINAL_ADMISSION_REUSE_MAX_MS))return null;
  try{validateFormalAdmissionV2(job,held.facts,now,{batchClaim:generation});return held;}catch{return null;}
}
export async function executeProtectedIssuedJob(options={}){
  let locked=false,executionMayHaveStarted=false;
  try{
    check(options&&Object.keys(options).every(k=>k==='signal'),'CALLER_LINUX_BRIDGE_CAPABILITY_REFUSED');const{signal}=options;
    const selectedJob=await readFixedIssueJob();const context=await loadLinuxContext(selectedJob);takeAcceptedBridgeContext(context);const box=takeActualMailbox(await openAcceptedMailbox(context));await box.lock();locked=true;
    const issue=validateIssue(decode(await box.read('issue'))),job=issue.job;
    check(job.role===context.role&&job.sourceManifestSha256===context.config.sourceManifestSha256&&issue.sourceAcceptanceRef===context.sourceAcceptanceRef&&issue.hostQualificationRef===context.hostQualificationRef,'FORMAL_ISSUE_QUALIFICATION_CHANGED');
    let sequence=0,scanStartRequested=false,lastAdmission=null;const monotonic=()=>performance.now();
    const callback=async(action,subject)=>{check(canonical(subject)===canonical(job),'FORMAL_CALLBACK_SUBJECT_CHANGED');
      if(action==='scan-start'){check(!scanStartRequested,'SCAN_START_ONCE_REQUIRED');scanStartRequested=true;}
      const matches=fresh=>check(fresh.sourceAcceptanceRef===context.sourceAcceptanceRef&&fresh.hostQualificationRef===context.hostQualificationRef&&fresh.config.sourceManifestSha256===job.sourceManifestSha256,'FORMAL_CALLBACK_AUTHORITY_CHANGED');
      // bf57ff10 P2 D (2026-11-07, review MAJOR-1): every challenge makes Windows run a complete admission whose Native verify
      // carries pr_ref (a write, entry-runtime.mjs#nativeReadPost), so the authority reload is split in two:
      //   1. before the challenge is written, completely: the role policy, the Source manifest and the qualification at the
      //      current clock (boundary.mjs#loadLinuxRelayContext) and the acceptance refs and manifest of this job; a refusal
      //      writes no challenge, exactly as before;
      //   2. the expensive rest of loadLinuxContext (Git and the re-hash of every pinned Source file, about 1 s) runs WHILE
      //      Windows answers. No response is validated, handed to the adapter or followed by signing until it has passed;
      //      its refusal wins over anything the write or the wait reports (as when it ran first) and cuts the wait short.
      // So a challenge goes out only for an accepted policy, manifest and qualification; a Source checkout that drifted
      // since the last callback may still get one Windows answer (one more admission, Native verify included), never used.
      // A scan-start asks Windows for a Native effect: there the whole reload still completes before the challenge.
      let refused=null,authorityDone=null;
      if(action==='scan-start')matches(await loadLinuxContext(job));
      else{matches(await loadLinuxRelayContext(job));authorityDone=loadLinuxContext(job).then(matches).then(()=>{},e=>{refused=e;});}
      if(refused!==null)throw refused;
      const request=makeChallenge(issue,action,++sequence),suffix=String(sequence).padStart(2,'0'),sentMono=monotonic();
      try{await box.write('challenge-'+suffix,encode(request));}catch(e){if(authorityDone){await authorityDone;if(refused)throw refused;}throw e;}
      const stop=authorityDone?{get aborted(){return refused!==null||signal?.aborted===true;}}:signal;
      const waited=await box.wait('response-'+suffix,{deadline:Date.parse(request.deadline),signal:stop}).then(raw=>({raw}),error=>({error}));
      if(authorityDone){await authorityDone;if(refused)throw refused;}
      if(waited.error)throw waited.error;
      const response=validateResponse(issue,request,decode(waited.raw));
      const value=callbackValue(action,response);if(action==='admission')lastAdmission={facts:value,sentMono};return value;
    };
    // Adapters cannot prepare until their first callback gets a fresh actual
    // production response through the accepted Root-protected relay.
    const ports=Object.freeze({admissionPort:subject=>callback('admission',subject),remoteRefsPort:subject=>callback('remote-refs',subject),
      // While the Source does not require Native, no scan-start challenge is ever written: the
      // issue id is this job's execution id, once (grant.mjs NATIVE_SCAN_START_REQUIRED).
      scanStartPort:async subject=>{if(!NATIVE_SCAN_START_REQUIRED){check(canonical(subject)===canonical(job),'FORMAL_CALLBACK_SUBJECT_CHANGED');
        check(!scanStartRequested,'SCAN_START_ONCE_REQUIRED');scanStartRequested=true;return localScanStart(job,issue.issueId);}
        const grant=await callback('scan-start',subject);validateScanStartGrant(grant,{job,executionId:issue.issueId});return grant;}});
    // bf57ff10 P2 D: the session reuses the actual role policy the context above was just built from (same job, re-checked
    // at the current clock; anything else loads anew, policy.mjs#reusableRolePolicy); no adapter has run in between.
    const session=takeActualRoleSession(await openFixedRoleSession(job,{preloaded:context.policy}));
    const adapter=job.role==='gitleaks'?createFormalGitleaksAdapter(ports):job.role==='trivy'?createFormalTrivyAdapter(ports):createFormalContractPlacementAdapter(ports);executionMayHaveStarted=true;
    const result=await adapter.execute(job,{signal});
    if(isCleanBlocked(result)){
      await session.releaseClean(result);const reason=cleanBlockedReason(result.reason);
      await box.write('blocked',encode(makeBlocked(issue,reason)));
      return{status:'CLEAN_BLOCKED_PUBLISHED',reason,issueSha256:digest(issue),preparationStarted:false,automaticRetryAllowed:false,bridgeLockRetained:true,checksWritten:false,qualificationIssued:false};
    }
    check(result?.observation,'ACTUAL_SCANNER_OBSERVATION_MISSING');
    if(!adapterFinalAdmission(job,issueGeneration(issue),lastAdmission,result.observation,{now:Date.now(),nowMono:monotonic()}))await callback('admission',job);
    // The signer reuses the role policy session.finish has just loaded AFTER the execution (bf57ff10 P2 D; it loaded it once
    // more itself); every signing check, and the clock check right before signing, are unchanged.
    await session.finish(result.observation);const signed=await signActualBridgeResult(context,issue,result.observation,{session});
    const bytes=Buffer.from(canonical(signed));await box.write('result',bytes);
    // M4 (DESIGN 68.2): a real successful trivy run is stored only now, with the envelope just signed; best effort, the
    // result already written is final whatever the store does.
    if(typeof result.storeSignedResult==='function')try{await result.storeSignedResult(signed);}catch{}
    return{status:'ACTUAL_SIGNED_ROLE_RESULT_EMITTED',issueSha256:digest(issue),resultSha256:digest(signed),cleanupConfirmed:true,checksWritten:false,qualificationIssued:false,automaticRetryAllowed:false};
  }catch(e){return{status:locked?'UNCERTAIN':'BLOCKED',reason:safe(e),executionMayHaveStarted,automaticRetryAllowed:false,checksWritten:false,qualificationIssued:false};}
}
export async function main(argv=process.argv.slice(2),output=process.stdout){
  if(argv.length!==1||argv[0]!=='--run'){output.write(JSON.stringify({status:'BLOCKED',reason:'FIXED_LINUX_BRIDGE_RUN_REQUIRED'})+'\n');return 2;}
  const r=await executeProtectedIssuedJob();output.write(JSON.stringify(r)+'\n');return ['ACTUAL_SIGNED_ROLE_RESULT_EMITTED','CLEAN_BLOCKED_PUBLISHED'].includes(r.status)?0:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
