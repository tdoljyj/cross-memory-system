// Scanner-issuer entry of Source v2 (stages 2, 4, 6; DESIGN S6, S7, S11, S12). Run only by the generic
// helper as clued-control:  node windows-issuer.mjs --run --stage <nonce> --config-sha256 <sha>
// Only this protected Windows side opens App/Native credentials. No Checks, merge, deployment or
// credential forwarding to a Linux mailbox. Port of protected-job-bridge-v3/windows-issuer.mjs:
//   - inputs come from the sealed stage directory and the held claim-free record (runEntry);
//   - every admission (issue and each callback) is evaluated under the BATCH claim generation that
//     stage 1 recorded (A-strict, batch-claim-v2.mjs); a moved claim fails closed;
//   - a transient admission refusal (stale, or unavailable: the admission threw) is evaluated again within
//     its window; in a callback round one that outlasts it answers nothing (late) instead of failing itself;
//   - the stage ends with an outcome record (S11): ISSUED_RESULT_RECEIVED, a clean BLOCKED with zero side
//     effects (nothing issued, or the Linux worker's clean 'blocked' record), or UNCERTAIN after an issue
//     without a verified result (the Linux side may still run: UNKNOWN for the resident).
// The issue window is the stage's own: min(stage cap, claim lease, acceptance validUntil, held lease).
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,digest as proofDigest} from '../../src/proof.mjs';
import {readBatchClaim} from '../../src/batch-claim-v2.mjs';
import {collectCompleteRemoteRefs} from '../protected-controller-ports-v2/refs.mjs';
import {STATE_V2,stageByNumber} from '../../src/resident-v2/layout.mjs';
import {runEntry,controllerPrincipal,controllerPorts,observationLog} from '../../src/resident-v2/entry-runtime.mjs';
import {createWindowsContext,takeAcceptedBridgeContext,assertWindowsContextLive,closeWindowsContext} from './boundary.mjs';
import {openAcceptedMailbox,takeActualMailbox} from './mailbox.mjs';
import {CALLBACK_WINDOW_MS,makeIssue,makeResponse,validateChallenge,validateBlocked,encode,decode,digest} from './protocol.mjs';
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
// Remote refs observation failures (protected-controller-ports-v2/refs.mjs) -> stable reasons.
export function refsFailureReason(code){
  if(['REFS_SNAPSHOT_CHANGED','REFS_TOTAL_CHANGED'].includes(code))return 'REMOTE_REFS_CHANGED_SINCE_BUNDLE';
  if(['REFS_PR_SUBJECT_CHANGED','REFS_MAIN_BASE_CHANGED','REMOTE_MAIN_BASE_CHANGED'].includes(code))return 'full_admission_subject_changed';
  return 'REMOTE_REFS_UNAVAILABLE';
}
const refsStep=async collect=>{try{return await collect();}catch(e){fail(refsFailureReason(e?.code));}};
// The issuer's evaluate(): the changed-paths read, then the complete admission. The read sits outside
// full-admission-v2.mjs's catch-all, so its failures are mapped the same way: a PR that is no longer open on the job's
// head and base (pr_subject_changed) is the subject change evaluatePr reports itself; any other exception (mostly
// GitHub after the port's own retries) is unavailable, which runIssuer retries (Task 576231fa).
export const issuerEvaluate=({github,admission,job,batchClaim})=>async()=>{
  let packet;
  try{packet=await github.readChangedPaths(job);}
  catch(e){return{status:'BLOCKED',reason:e?.code==='pr_subject_changed'?'full_admission_subject_changed':UNAVAILABLE_ADMISSION,diagnostic:{phase:'changed_paths'}};}
  return admission.evaluatePr(job,packet,{batchClaim});
};

// The issuer engine. Ports are injected so the offline tests drive the real protocol; production wires
// them in main(). sideEffects counts "the Linux side may run": 0 until the issue is written.
export async function runIssuer({context,evaluate,collect,box,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),stageDeadline,signal}){
  takeAcceptedBridgeContext(context);const job=context.job;let sideEffects=0,gaveUp=null;
  // A transient admission refusal given up on in this run, for the outcome record: a round that went late reports only
  // the bridge reason otherwise. It is context, not necessarily the cause of the final reason. For the issuer's stages
  // (2, 4, 6) the resident classifies by status and reason alone, so it changes no outcome.
  const diagnosed=outcome=>gaveUp?{...outcome,admissionDiagnostic:gaveUp}:outcome;
  try{
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
          const phase=facts?.diagnostic?.phase;
          if(RETRY_WAITS_MS.has(reason))gaveUp={transientAdmission:reason,evaluations:attempt,
            ...(typeof phase==='string'&&/^[a-z_]{1,32}$/.test(phase)?{phase}:{})};
          fail(reason);
        }
        if(wait)await sleep(wait);
      }
    };
    // The first admission retries too (nothing is issued yet), but only while its wait leaves the Linux side at least
    // one callback window of the stage.
    const first=await admitted(stageDeadline-CALLBACK_WINDOW_MS),refs=job.role==='gitleaks'?await refsStep(collect):null;
    const until=Math.min(stageDeadline,context.accepted.validUntil===null?Infinity:Date.parse(context.accepted.validUntil));
    const issue=makeIssue(job,first,refs,{sourceAcceptanceRef:context.sourceAcceptanceRef,hostQualificationRef:context.hostQualificationRef,expiresAt:new Date(until).toISOString(),now:clock()});
    assertWindowsContextLive(context);sideEffects=1;await box.write('issue',encode(issue));
    // late: the deadline of the round this issuer did not answer (null = still answering): out of time, or a
    // transient admission refusal outlasted its retries. Past it the Linux worker accepts no response; in a round
    // before it prepared anything it ends with its clean 'blocked' record (BRIDGE_CALLBACK_DEADLINE). So answer
    // nothing more and wait for that record instead of failing UNCERTAIN on an expired challenge (PR #889 stage 2
    // attempt 2, 2026-10-21): two more windows at most, since the companion waits one window for a response from its
    // own ReceiveChallenge before it hands the record over. A worker that ends without it (a later round, after it
    // prepared: PR #894 stage 6 challenge-02) stays UNCERTAIN, so there only the retries above help.
    let next=1,late=null;
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
      let current;
      try{current=await admitted(Date.parse(challenge.deadline));}catch(e){if(RETRY_WAITS_MS.has(e?.code))return goLate(challenge);throw e;}
      const fresh=challenge.action==='admission'?null:await refsStep(collect);
      const now=clock();if(now>=Date.parse(challenge.deadline))return goLate(challenge);
      const response=challenge.action==='admission'?makeResponse(issue,challenge,current,null,{now}):makeResponse(issue,challenge,null,fresh,{now});
      assertWindowsContextLive(context);await box.write('response-'+String(seq).padStart(2,'0'),encode(response));next++;return true;
    };
    while(clock()<Date.parse(issue.expiresAt)&&!signal?.aborted){
      assertWindowsContextLive(context);
      let raw=null;try{raw=await box.read('result');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(raw){let wrapper;try{wrapper=JSON.parse(raw.toString('utf8'));}catch{fail('SIGNED_BRIDGE_RESULT_JSON_REQUIRED');}
        check(Buffer.from(canonical(wrapper)).equals(raw),'SIGNED_BRIDGE_RESULT_CANONICAL_REQUIRED');
        verifySignedBridgeResult({issue,wrapper,signers:context.signers,now:clock()});await admitted(Date.parse(issue.expiresAt));
        // Retries keep only their waits inside the window; a last evaluation may still end past it.
        check(clock()<Date.parse(issue.expiresAt),'BRIDGE_RESULT_DEADLINE');
        return{status:ISSUER_SUCCESS,reason:null,sideEffects,issueSha256:digest(issue),resultSha256:proofDigest(wrapper)};}
      let blocked=null;try{blocked=await box.read('blocked');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(blocked){const b=validateBlocked(issue,decode(blocked),clock());
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
    const {github,admission,fetchImpl}=controllerPorts({record:inputs.record,appKey,nativeToken,policyText:held.policyText,sourceRoot,live,log});
    const box=takeActualMailbox(await openAcceptedMailbox(context));
    const row=stageByNumber(inputs.plan.stage);
    // The helper's own child deadline is the stage cap; keep the stage margin for the outcome and exit.
    const stageDeadline=Math.min(Date.now()+row.runMilliseconds-120_000,Date.parse(held.expiresAt));
    return runIssuer({context,box,stageDeadline,
      evaluate:issuerEvaluate({github,admission,job,batchClaim}),
      collect:async()=>{const v=await collectCompleteRemoteRefs({job,token:await github.getInstallationToken(),readPullRequest:n=>github.readPullRequest(n),fetchImpl});
        return Object.fromEntries(['contract','repository','complete','observedAt','refs'].map(k=>[k,v[k]]));}});
  }});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
