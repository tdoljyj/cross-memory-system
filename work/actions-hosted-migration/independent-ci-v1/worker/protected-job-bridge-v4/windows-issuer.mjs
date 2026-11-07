// Scanner-issuer entry of Source v2 (stages 2, 4, 6; DESIGN S6, S7, S11, S12). Run only by the generic
// helper as clued-control:  node windows-issuer.mjs --run --stage <nonce> --config-sha256 <sha>
// Only this protected Windows side opens App/Native credentials. No Checks, merge, deployment or
// credential forwarding to a Linux mailbox. Port of protected-job-bridge-v3/windows-issuer.mjs:
//   - inputs come from the sealed stage directory and the held claim-free record (runEntry);
//   - every admission (issue and each callback) is evaluated under the BATCH claim generation that
//     stage 1 recorded (A-strict, batch-claim-v2.mjs); a moved claim fails closed;
//   - a transient admission refusal (stale, or unavailable: the admission threw) is evaluated again within
//     its window; in a callback round one that outlasts it answers nothing (late) instead of failing itself;
//     a transient remote refs failure likewise (collectRefs);
//   - the stage ends with an outcome record (S11): ISSUED_RESULT_RECEIVED, a clean BLOCKED with zero side
//     effects (nothing issued, or the Linux worker's clean 'blocked' record), or UNCERTAIN after an issue
//     without a verified result (the Linux side may still run: UNKNOWN for the resident).
// The issue window is the stage's own: min(stage cap, claim lease, acceptance validUntil, held lease).
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,digest as proofDigest} from '../../src/proof.mjs';
import {fullAdmissionFailureV2} from '../../src/full-admission-v2.mjs';
import {DIAGNOSTIC_PHASES} from '../../src/admission-facts-v2.mjs';
import {readBatchClaim} from '../../src/batch-claim-v2.mjs';
import {collectCompleteRemoteRefs,refsTransient} from '../protected-controller-ports-v2/refs.mjs';
import {STATE_V2,stageByNumber} from '../../src/resident-v2/layout.mjs';
import {runEntry,controllerPrincipal,controllerPorts,observationLog} from '../../src/resident-v2/entry-runtime.mjs';
import {createWindowsContext,takeAcceptedBridgeContext,assertWindowsContextLive,closeWindowsContext} from './boundary.mjs';
import {openAcceptedMailbox,takeActualMailbox} from './mailbox.mjs';
import {CALLBACK_WINDOW_MS,makeIssue,makeResponse,validateChallenge,validateBlocked,admissionValid,issueGeneration,encode,decode,digest} from './protocol.mjs';
import {validateScanStartGrant,NATIVE_SCAN_START_REQUIRED} from '../../src/scan-start-v1/grant.mjs';
import {verifySignedBridgeResult} from './signed-result.mjs';
export const ISSUER_SUCCESS='ISSUED_RESULT_RECEIVED';
const STALE_ADMISSION='full_admission_observation_expired',UNAVAILABLE_ADMISSION='full_admission_unavailable';
// Transient admission refusals, where no gate said no: entry n is the wait after the n-th evaluation of one admission
// before the next, complete one (one counter for both reasons; no entry left = give up). Stale (a slow host outran the
// 30 s freshness bound): again at once, three evaluations at most. Unavailable (full-admission-v2.mjs caught an
// exception, mostly a failed GitHub or KooYomi call): after 1, 2 and 4 s, four at most (PR #894 stage 6, 2026-10-21:
// one failed call in a callback round ended UNCERTAIN and HALTed the resident).
const RETRY_WAITS_MS=new Map([[STALE_ADMISSION,[0,0]],[UNAVAILABLE_ADMISSION,[1000,2000,4000]]]);
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
// Linux clean-blocked codes that keep their meaning (transient, see stage-fact.mjs); any other clean
// refusal before preparation is final for this attempt.
const PASS_THROUGH=new Set(['REMOTE_REFS_CHANGED_SINCE_BUNDLE','BRIDGE_CALLBACK_DEADLINE']);
export const blockedReason=reason=>PASS_THROUGH.has(reason)?reason:'LINUX_PREPARATION_REFUSED';
// Remote refs observation failures (protected-controller-ports-v2/refs.mjs) -> stable reasons. Only a failure that may
// pass on its own (refsTransient: GitHub 5xx or 429, no complete answer, the observation window outrun) is
// REMOTE_REFS_UNAVAILABLE, a clean transient before the issue; any other code is a refusal, REMOTE_REFS_REFUSED, final
// for the attempt (stage-fact.mjs: STAGE_CHILD_REFUSED), never collected again (Task 576231fa).
export function refsFailureReason(code){
  if(['REFS_SNAPSHOT_CHANGED','REFS_TOTAL_CHANGED'].includes(code))return 'REMOTE_REFS_CHANGED_SINCE_BUNDLE';
  if(['REFS_PR_SUBJECT_CHANGED','REFS_MAIN_BASE_CHANGED','REMOTE_MAIN_BASE_CHANGED'].includes(code))return 'full_admission_subject_changed';
  return refsTransient(code)?REFS_UNAVAILABLE:'REMOTE_REFS_REFUSED';
}
const REFS_UNAVAILABLE='REMOTE_REFS_UNAVAILABLE';
// One complete refs collection (gitleaks: the issue and each remote-refs callback). A transient failure is collected
// again, in full, after 1 and then 2 s: three collections at most, and a next one only while its wait plus a whole
// collection (REFS_COLLECTION_MS, the port's own 30 s observation window) ends before `until` (the round's deadline, or
// before the issue one callback window short of the stage's). Worst case 3 x 30 s + 3 s = 93 s, inside one 120 s
// round. Only a complete collection is ever used, never part of a failed one; it is fresh at its own end, and the
// caller writes it at once (protocol.mjs measures its 30 s at that issuance). Given up: REMOTE_REFS_UNAVAILABLE.
export const REFS_RETRY_WAITS_MS=Object.freeze([1000,2000]),REFS_COLLECTION_MS=30000,ISSUE_FRESH_MARGIN_MS=10000;
export async function collectRefs({context,collect,until,clock=Date.now,sleep}){
  for(let attempt=1;;attempt++){
    assertWindowsContextLive(context);let code;
    try{const refs=await collect();assertWindowsContextLive(context);return refs;}catch(e){code=e?.code;}
    assertWindowsContextLive(context);
    const reason=refsFailureReason(code),wait=REFS_RETRY_WAITS_MS[attempt-1];
    if(reason!==REFS_UNAVAILABLE||wait===undefined||clock()+wait+REFS_COLLECTION_MS>=until)fail(reason);
    await sleep(wait);
  }
}
// The issuer's evaluate(): the changed-paths read, then the complete admission. The read sits outside
// full-admission-v2.mjs's catch-all, so its failures are mapped here (Task 576231fa):
//   - a PR that is no longer open on the job's head and base (pr_subject_changed) is the subject change evaluatePr
//     reports itself;
//   - the port's own refusal of the read (PATHS_REFUSALS: a file list that is invalid, changed, incomplete or past the
//     page limit; an unexpected App identity or token scope) is full_admission_paths_refused;
//   - GitHub's 403 (permission, secondary rate limit, a refused App: ambiguous, never transient) is
//     full_admission_github_forbidden.
// These three are refusals, final at once (not in RETRY_WAITS_MS; stage-fact.mjs: PR_NOT_OPEN_OR_CHANGED, or
// STAGE_CHILD_REFUSED). Any other exception (GitHub 5xx or 429, no answer, after the port's own retries) is
// unavailable, which runIssuer retries.
export const PATHS_REFUSED='full_admission_paths_refused',GITHUB_FORBIDDEN='full_admission_github_forbidden';
export const PATHS_REFUSALS=Object.freeze(['invalid_pr_subject','pr_files_changed','incomplete_pr_files','invalid_pr_files','pr_files_page_limit',
  'unexpected_app_identity','unexpected_installation_token_scope','unexpected_repository_scope','invalid_github_route']);
export const changedPathsFailure=code=>code==='pr_subject_changed'?'full_admission_subject_changed':PATHS_REFUSALS.includes(code)?PATHS_REFUSED
  :code==='github_http_403'?GITHUB_FORBIDDEN:UNAVAILABLE_ADMISSION;
// bf57ff10 P2 E1 (2026-11-07): the changed-paths read and the admission run side by side (they were one after the
// other, about 3 GitHub round trips apart). The admission gets the read as a deferred packet (full-admission-v2.mjs): it
// sends no Native RPC before the packet is complete and valid, and assembles its facts only after it. This function
// answers only when both are complete; a failed read is still answered with its own mapped reason, whatever the
// admission did, so every outcome is the old one.
export const issuerEvaluate=({github,admission,job,batchClaim})=>async()=>{
  const paths=Promise.resolve().then(()=>github.readChangedPaths(job)),read=paths.then(packet=>({packet}),error=>({error}));
  const facts=Promise.resolve().then(()=>admission.evaluatePr(job,()=>paths,{batchClaim})),settled=facts.then(value=>({value}),error=>({error}));
  const r=await read,f=await settled;
  if(Object.hasOwn(r,'error'))return{status:'BLOCKED',reason:changedPathsFailure(r.error?.code),diagnostic:{phase:'changed_paths'}};
  if(Object.hasOwn(f,'error'))throw f.error;
  return f.value;
};

// The issuer engine. Ports are injected so the offline tests drive the real protocol; production wires
// them in main(). sideEffects counts "the Linux side may run": 0 until the issue is written.
export async function runIssuer({context,evaluate,collect,scanStart,box,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),stageDeadline,signal,nativeScanStartRequired=NATIVE_SCAN_START_REQUIRED}){
  takeAcceptedBridgeContext(context);const job=context.job;let sideEffects=0,admissionDiagnostic=null;
  // Preserve only the shared sanitizer's refusal facts, plus bounded retry context when an admission round gave up.
  // A late round may end with a bridge reason instead, so this is context, not necessarily the final failure's cause.
  // The issuer's classification still depends only on status/reason/sideEffects, never this diagnostic.
  const diagnosed=outcome=>admissionDiagnostic?{...outcome,admissionDiagnostic}:outcome;
  try{
    check(typeof nativeScanStartRequired==='boolean','SCAN_START_MODE_INVALID');
    check(Number.isSafeInteger(stageDeadline)&&stageDeadline>clock(),'FORMAL_ISSUER_WINDOW_UNCONFIRMED');
    await box.lock();
    // One complete admission. A transient refusal (RETRY_WAITS_MS) is evaluated again, in full, after its wait and
    // only while that wait ends before `until`; any other refusal fails at once. Only a fresh complete ADMITTED is
    // ever used.
    const admitted=async until=>{
      for(let attempt=1;;attempt++){
        assertWindowsContextLive(context);const facts=await evaluate();assertWindowsContextLive(context);
        if(facts?.status==='ADMITTED')return facts;
        const reason=/^full_admission_[a-z_]+$/.test(facts?.reason??'')?facts.reason:'ACTUAL_NATIVE_ADMISSION_REQUIRED';
        const wait=RETRY_WAITS_MS.get(reason)?.[attempt-1];
        if(wait===undefined||clock()+wait>=until){
          const failure=fullAdmissionFailureV2(facts);
          if(failure?.admissionDiagnostic)admissionDiagnostic=failure.admissionDiagnostic;
          const phase=facts?.diagnostic?.phase;
          if(RETRY_WAITS_MS.has(reason))admissionDiagnostic={...(failure?.admissionDiagnostic??{}),transientAdmission:reason,evaluations:attempt,
            ...(DIAGNOSTIC_PHASES.includes(phase)?{phase}:{})};
          fail(reason);
        }
        if(wait)await sleep(wait);
      }
    };
    // The first admission retries too (nothing is issued yet), but only while its wait leaves the Linux side at least
    // one callback window of the stage.
    // gitleaks: the refs first, then the admission, so a slow refs collection (up to three, Task 576231fa) never leaves the
    // admission older than makeIssue's 30 s (review M2 of 576231fa). Whichever of the two aged past ISSUE_FRESH_MARGIN_MS
    // while the other was taken is taken once more (one extra round at most); both are then fresh at the issue.
    const before=stageDeadline-CALLBACK_WINDOW_MS;
    const takeRefs=async()=>({refs:await collectRefs({context,collect,until:before,clock,sleep}),at:clock()});
    let r=job.role==='gitleaks'?await takeRefs():null;
    let first=await admitted(before),firstAt=clock();
    // The extra round only while it still ends before `before` (round-2 review m2); and after it, refs that aged again are
    // given up as unavailable rather than issued stale (round-2 review m1): either way a clean BLOCKED before any issue.
    if(r&&clock()-r.at>ISSUE_FRESH_MARGIN_MS){
      if(clock()>=before)fail(REFS_UNAVAILABLE);
      r=await takeRefs();
      if(clock()-firstAt>ISSUE_FRESH_MARGIN_MS){if(clock()>=before)fail(REFS_UNAVAILABLE);first=await admitted(before);firstAt=clock();}
      if(clock()-r.at>REFS_COLLECTION_MS-ISSUE_FRESH_MARGIN_MS)fail(REFS_UNAVAILABLE);
    }
    const refs=r?r.refs:null;
    const until=Math.min(stageDeadline,context.accepted.validUntil===null?Infinity:Date.parse(context.accepted.validUntil));
    const issue=makeIssue(job,first,refs,{sourceAcceptanceRef:context.sourceAcceptanceRef,hostQualificationRef:context.hostQualificationRef,expiresAt:new Date(until).toISOString(),now:clock()});
    assertWindowsContextLive(context);sideEffects=1;await box.write('issue',encode(issue));
    // late: the deadline of the round this issuer did not answer (null = still answering): out of time, or a
    // transient admission refusal or refs failure outlasted its retries. Past it the Linux worker accepts no response; in a round
    // before it prepared anything it ends with its clean 'blocked' record (BRIDGE_CALLBACK_DEADLINE). So answer
    // nothing more and wait for that record instead of failing UNCERTAIN on an expired challenge (PR #889 stage 2
    // attempt 2, 2026-10-21): two more windows at most, since the companion waits one window for a response from its
    // own ReceiveChallenge before it hands the record over. A worker that ends without it (a later round, after it
    // prepared: PR #894 stage 6 challenge-02) stays UNCERTAIN, so there only the retries above help.
    let next=1,late=null,scanStartAttempted=false,scanStartGranted=false;
    const goLate=challenge=>{late=Date.parse(challenge.deadline);return false;};
    const serveNext=async()=>{
      check(next<=32,'FORMAL_CALLBACK_LIMIT');const seq=next,name='challenge-'+String(seq).padStart(2,'0');
      const raw=decode(await box.read(name));let challenge;
      try{challenge=validateChallenge(issue,raw,clock());}
      catch(e){
        // Relayed only after its deadline: late, when it was a valid challenge until then; anything else fails.
        if(e?.code!=='BRIDGE_CHALLENGE_EXPIRED'||!(Date.parse(raw?.deadline)<=clock()))throw e;
        challenge=validateChallenge(issue,raw,Date.parse(raw.deadline)-1);check(challenge.sequence===seq,'FORMAL_CALLBACK_SEQUENCE_CHANGED');
        return goLate(challenge);
      }
      check(challenge.sequence===seq,'FORMAL_CALLBACK_SEQUENCE_CHANGED');
      // A transient refusal that outlasts this round's retries answers nothing: late, as above.
      // bf57ff10 P2 E2 (2026-11-07): in a remote-refs round the admission and the refs collection run side by side (they
      // were one after the other); both are judged only when both are complete, the admission's outcome first, exactly
      // as before: its transient refusal is late, its other refusal fails, then the refs' unavailability is late and
      // their other refusal fails. Each is still taken in full, and the response is made only from two complete answers.
      // Freshness (review MINOR 6): side by side, the refs are taken while the admission runs, not after it. When they are
      // older than ISSUE_FRESH_MARGIN_MS once the admission is complete (a slow or retried admission), they are collected
      // once more, after it, exactly as before this change, so the answer is never staler than the sequential one.
      const refsRound=challenge.action==='remote-refs';
      const deadline=Date.parse(challenge.deadline);
      const refsNow=()=>collectRefs({context,collect,until:deadline,clock,sleep}).then(refs=>({refs,at:clock()}));
      const [admissionRead,refsRead]=await Promise.allSettled([admitted(deadline),refsRound?refsNow():null]);
      if(admissionRead.status==='rejected'){const e=admissionRead.reason;if(RETRY_WAITS_MS.has(e?.code))return goLate(challenge);throw e;}
      const current=admissionRead.value;
      // Remote refs still unavailable after collectRefs' retries: late as well (the worker has prepared nothing before
      // its refs callback, so it ends with its clean blocked record). A refusal still fails.
      let fresh=null;
      if(refsRound){
        let taken=refsRead;
        if(taken.status==='fulfilled'&&clock()-taken.value.at>ISSUE_FRESH_MARGIN_MS)[taken]=await Promise.allSettled([refsNow()]);
        if(taken.status==='rejected'){const e=taken.reason;if(e?.code===REFS_UNAVAILABLE)return goLate(challenge);throw e;}
        fresh=taken.value.refs;
      }
      let grant=null;
      if(challenge.action==='scan-start'){
        // A Source that does not require Native never asks; a challenge anyway is refused, not served.
        check(nativeScanStartRequired===true,'SCAN_START_NOT_REQUIRED_BY_SOURCE');
        check(!scanStartAttempted&&typeof scanStart==='function','SCAN_START_PORT_OR_ONCE_REQUIRED');
        admissionValid(job,current,clock(),issueGeneration(issue));
        if(clock()>=Date.parse(challenge.deadline))return goLate(challenge);
        // Durable issue.issueId is the execution identity. Set once BEFORE the
        // effect: a lost reply/response can never reinvoke Native with a new id.
        scanStartAttempted=true;
        let nativeGrant;try{nativeGrant=await scanStart({job,facts:current,executionId:issue.issueId});}catch{fail('SCAN_START_NATIVE_UNCONFIRMED');}
        grant=validateScanStartGrant(nativeGrant,{job,executionId:issue.issueId});
        assertWindowsContextLive(context);check(clock()<Date.parse(challenge.deadline),'SCAN_START_DEADLINE');
        scanStartGranted=true;
      }
      const now=clock();if(now>=Date.parse(challenge.deadline))return goLate(challenge);
      const response=challenge.action==='remote-refs'?makeResponse(issue,challenge,null,fresh,{now})
        :makeResponse(issue,challenge,current,null,{now,scanStart:grant});
      assertWindowsContextLive(context);await box.write('response-'+String(seq).padStart(2,'0'),encode(response));next++;return true;
    };
    while(clock()<Date.parse(issue.expiresAt)&&!signal?.aborted){
      assertWindowsContextLive(context);
      let raw=null;try{raw=await box.read('result');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(raw){let wrapper;try{wrapper=JSON.parse(raw.toString('utf8'));}catch{fail('SIGNED_BRIDGE_RESULT_JSON_REQUIRED');}
        check(Buffer.from(canonical(wrapper)).equals(raw),'SIGNED_BRIDGE_RESULT_CANONICAL_REQUIRED');
        // Native mode: the result needs the one granted start. Local mode: no start was ever asked for.
        check(nativeScanStartRequired?scanStartGranted:!scanStartAttempted,'SCAN_START_GRANT_NOT_OBSERVED');
        verifySignedBridgeResult({issue,wrapper,signers:context.signers,now:clock()});await admitted(Date.parse(issue.expiresAt));
        // Retries keep only their waits inside the window; a last evaluation may still end past it.
        check(clock()<Date.parse(issue.expiresAt),'BRIDGE_RESULT_DEADLINE');
        return{status:ISSUER_SUCCESS,reason:null,sideEffects,issueSha256:digest(issue),resultSha256:proofDigest(wrapper)};}
      let blocked=null;try{blocked=await box.read('blocked');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(blocked){const b=validateBlocked(issue,decode(blocked),clock());
        check(!scanStartAttempted,'SCAN_START_TERMINAL_UNCONFIRMED');
        // The Linux side ended cleanly before any scanner touched the PR (trivy may have run cache-only
        // containers): nothing was published. A clean refusal is final, never retried automatically.
        return diagnosed({status:'BLOCKED',reason:blockedReason(b.reason),sideEffects:0,issueSha256:digest(issue)});}
      if(late===null){try{await serveNext();}catch(e){if(e.code!=='ENOENT')throw e;}}
      else check(clock()<late+2*CALLBACK_WINDOW_MS,'BRIDGE_LATE_BLOCKED_UNCONFIRMED');
      await sleep(100);
    }
    fail('BRIDGE_RESULT_DEADLINE');
  }catch(e){
    const reason=/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??'')?e.code:'FORMAL_BRIDGE_UNCONFIRMED';
    return diagnosed({status:sideEffects?'UNCERTAIN':'BLOCKED',reason,sideEffects});
  }finally{closeWindowsContext(context);}
}

export async function main(argv=process.argv.slice(2),output=process.stdout){
  return runEntry({argv,entryRole:'scanner-issuer',moduleUrl:import.meta.url,output,successStatuses:[ISSUER_SUCCESS],body:async({inputs,held,live,sourceRoot})=>{
    const context=createWindowsContext({inputs,policyText:held.policyText,sourceRoot,live}),job=context.job;
    const batchClaim=await readBatchClaim(STATE_V2.batchClaims,job);
    const {appKey,nativeToken}=await controllerPrincipal(inputs.record);
    const log=observationLog(STATE_V2.effectsScan,job.id);
    const {github,admission,fetchImpl,scanStart}=controllerPorts({record:inputs.record,appKey,nativeToken,policyText:held.policyText,sourceRoot,live,log});
    const box=takeActualMailbox(await openAcceptedMailbox(context));
    const row=stageByNumber(inputs.plan.stage);
    // The helper's own child deadline is the stage cap; keep the stage margin for the outcome and exit.
    const stageDeadline=Math.min(Date.now()+row.runMilliseconds-120_000,Date.parse(held.expiresAt));
    return runIssuer({context,box,stageDeadline,scanStart,
      evaluate:issuerEvaluate({github,admission,job,batchClaim}),
      collect:async()=>{const v=await collectCompleteRemoteRefs({job,token:await github.getInstallationToken(),readPullRequest:n=>github.readPullRequest(n),fetchImpl});
        return Object.fromEntries(['contract','repository','complete','observedAt','refs'].map(k=>[k,v[k]]));}});
  }});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
