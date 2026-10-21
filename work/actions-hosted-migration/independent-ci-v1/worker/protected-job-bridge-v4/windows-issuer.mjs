// Scanner-issuer entry of Source v2 (stages 2, 4, 6; DESIGN S6, S7, S11, S12). Run only by the generic
// helper as clued-control:  node windows-issuer.mjs --run --stage <nonce> --config-sha256 <sha>
// Only this protected Windows side opens App/Native credentials. No Checks, merge, deployment or
// credential forwarding to a Linux mailbox. Port of protected-job-bridge-v3/windows-issuer.mjs:
//   - inputs come from the sealed stage directory and the held claim-free record (runEntry);
//   - every admission (issue and each callback) is evaluated under the BATCH claim generation that
//     stage 1 recorded (A-strict, batch-claim-v2.mjs); a moved claim fails closed;
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
import {makeIssue,makeResponse,validateChallenge,validateBlocked,encode,decode,digest} from './protocol.mjs';
import {verifySignedBridgeResult} from './signed-result.mjs';
export const ISSUER_SUCCESS='ISSUED_RESULT_RECEIVED';
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

// The issuer engine. Ports are injected so the offline tests drive the real protocol; production wires
// them in main(). sideEffects counts "the Linux side may run": 0 until the issue is written.
export async function runIssuer({context,evaluate,collect,box,clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),stageDeadline,signal}){
  takeAcceptedBridgeContext(context);const job=context.job;let sideEffects=0;
  try{
    check(Number.isSafeInteger(stageDeadline)&&stageDeadline>clock(),'FORMAL_ISSUER_WINDOW_UNCONFIRMED');
    await box.lock();
    const admitted=async()=>{assertWindowsContextLive(context);const facts=await evaluate();assertWindowsContextLive(context);
      check(facts?.status==='ADMITTED',/^full_admission_[a-z_]+$/.test(facts?.reason??'')?facts.reason:'ACTUAL_NATIVE_ADMISSION_REQUIRED');return facts;};
    const first=await admitted(),refs=job.role==='gitleaks'?await refsStep(collect):null;
    const until=Math.min(stageDeadline,context.accepted.validUntil===null?Infinity:Date.parse(context.accepted.validUntil));
    const issue=makeIssue(job,first,refs,{sourceAcceptanceRef:context.sourceAcceptanceRef,hostQualificationRef:context.hostQualificationRef,expiresAt:new Date(until).toISOString(),now:clock()});
    assertWindowsContextLive(context);sideEffects=1;await box.write('issue',encode(issue));
    let next=1,late=false;
    const serveNext=async()=>{
      check(next<=32,'FORMAL_CALLBACK_LIMIT');const seq=next,name='challenge-'+String(seq).padStart(2,'0');
      const challenge=validateChallenge(issue,decode(await box.read(name)),clock());check(challenge.sequence===seq,'FORMAL_CALLBACK_SEQUENCE_CHANGED');
      const current=await admitted(),fresh=challenge.action==='admission'?null:await refsStep(collect);
      // Past the round's deadline the Linux worker no longer accepts a response: it ends with its clean
      // 'blocked' record (BRIDGE_CALLBACK_DEADLINE). Answer nothing more and wait for that record, instead
      // of failing UNCERTAIN on an expired challenge (PR #889 stage 2 attempt 2, 2026-10-21).
      const now=clock();if(now>=Date.parse(challenge.deadline)){late=true;return false;}
      const response=challenge.action==='admission'?makeResponse(issue,challenge,current,null,{now}):makeResponse(issue,challenge,null,fresh,{now});
      assertWindowsContextLive(context);await box.write('response-'+String(seq).padStart(2,'0'),encode(response));next++;return true;
    };
    while(clock()<Date.parse(issue.expiresAt)&&!signal?.aborted){
      assertWindowsContextLive(context);
      let raw=null;try{raw=await box.read('result');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(raw){let wrapper;try{wrapper=JSON.parse(raw.toString('utf8'));}catch{fail('SIGNED_BRIDGE_RESULT_JSON_REQUIRED');}
        check(Buffer.from(canonical(wrapper)).equals(raw),'SIGNED_BRIDGE_RESULT_CANONICAL_REQUIRED');
        verifySignedBridgeResult({issue,wrapper,signers:context.signers,now:clock()});await admitted();
        return{status:ISSUER_SUCCESS,reason:null,sideEffects,issueSha256:digest(issue),resultSha256:proofDigest(wrapper)};}
      let blocked=null;try{blocked=await box.read('blocked');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(blocked){const b=validateBlocked(issue,decode(blocked),clock());
        // The Linux side ended before preparing anything: nothing ran, nothing was published.
        return{status:'BLOCKED',reason:blockedReason(b.reason),sideEffects:0,issueSha256:digest(issue)};}
      if(!late){try{await serveNext();}catch(e){if(e.code!=='ENOENT')throw e;}}
      await sleep(100);
    }
    fail('BRIDGE_RESULT_DEADLINE');
  }catch(e){
    const reason=/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??'')?e.code:'FORMAL_BRIDGE_UNCONFIRMED';
    return{status:sideEffects?'UNCERTAIN':'BLOCKED',reason,sideEffects};
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
      evaluate:async()=>admission.evaluatePr(job,await github.readChangedPaths(job),{batchClaim}),
      collect:async()=>{const v=await collectCompleteRemoteRefs({job,token:await github.getInstallationToken(),readPullRequest:n=>github.readPullRequest(n),fetchImpl});
        return Object.fromEntries(['contract','repository','complete','observedAt','refs'].map(k=>[k,v[k]]));}});
  }});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
