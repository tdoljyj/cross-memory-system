// Only this protected Windows side opens App/Native credentials. No Checks,
// merge, deployment or credential forwarding to a Linux mailbox.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createPublicKey,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createGitHubChecksPort} from '../../src/github.mjs';
import {createFullAdmissionPort} from '../../src/full-admission.mjs';
import {canonical,digest as proofDigest} from '../../src/proof.mjs';
import {APP_KEY_FILE,INSTALL_ROOT,readProtected,assertProtectedPaths} from '../../runtime/protected-files.mjs';
import {collectCompleteRemoteRefs} from '../protected-controller-ports-v1/refs.mjs';
import {loadWindowsContext,takeAcceptedBridgeContext,assertWindowsContextLive,closeWindowsContext} from './boundary.mjs';
import {openAcceptedMailbox,takeActualMailbox} from './mailbox.mjs';
import {makeIssue,makeResponse,validateChallenge,encode,decode,digest} from './protocol.mjs';
import {verifySignedBridgeResult} from './signed-result.mjs';
import {validateAdmission as validateGitleaksAdmission} from '../formal-gitleaks-v3/adapter.mjs';
import {validateAdmission as validateTrivyAdmission} from '../formal-trivy-v3/adapter.mjs';
import {validateAdmission as validatePlacementAdmission} from '../formal-contract-placement-v1/adapter.mjs';
const actual=new WeakSet(),fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??e?.message??'')?(e.code??e.message):'FORMAL_BRIDGE_UNCONFIRMED';
const bindingPin=v=>proofDigest('clued.independent-ci.ci-binding-pin/1\0'+v);
const fingerprint=v=>createHash('sha256').update(createPublicKey(v).export({format:'der',type:'spki'})).digest('base64');
const refsData=value=>Object.fromEntries(['contract','repository','complete','observedAt','refs'].map(k=>[k,value[k]]));
const PROTOCOL_ADMISSION_FIELDS=Object.freeze(['contract','status','admitted','completeAdmission','evaluator','domain','repository','scope','prRef','headSha','baseSha','claimId','fence','epoch','sourceManifestSha256','executionPolicy','guarded','mode','mergeSlot','ownerReview','workflowGateFindings','observedAt','claimExpiresAt','modeProofRef','observationRef','packetSha256','evaluationSha256','observationSha256']);
// Pure protocol view, not a Native door or an authority brand. Verify the full
// actual observation (including its original digest and handover gate) before
// deriving the older protocol's closed data shape. The protocol then applies all
// of its existing subject/mode/Owner/merge-slot/freshness validations unchanged.
export function protocolAdmissionView(job,facts,now=Date.now()){
 const fields=[...PROTOCOL_ADMISSION_FIELDS,'executionHandoverPending','mergeQueueHead'];
 check(facts&&Object.getPrototypeOf(facts)===Object.prototype&&Object.keys(facts).sort().join('|')===fields.sort().join('|')
  &&facts.executionHandoverPending===false&&typeof facts.mergeQueueHead==='boolean','COMPLETE_NATIVE_ADMISSION_VIEW_REQUIRED');
 const validate=job.role==='gitleaks'?validateGitleaksAdmission:job.role==='trivy'?validateTrivyAdmission:job.role==='contract-placement'?validatePlacementAdmission:null;
 check(validate!==null,'FIXED_ISSUER_ROLE_REQUIRED');validate(job,facts,now);
 const view=Object.fromEntries(PROTOCOL_ADMISSION_FIELDS.filter(k=>k!=='observationSha256').map(k=>[k,structuredClone(facts[k])]));
 // This is a digest of a verified derived data view, not a new Native verdict,
 // signature, Receipt or qualification. No authority or subject field changes.
 view.observationSha256=proofDigest(view);return Object.freeze(view);
}

const FAILURE_REASONS=new Set([
 'github_transport_unconfirmed','github_response_invalid','github_credential_unavailable',
 'github_http_400','github_http_401','github_http_403','github_http_404','github_http_408','github_http_409','github_http_412','github_http_422','github_http_429','github_http_500','github_http_502','github_http_503','github_http_504',
 'invalid_pr_subject','pr_subject_changed','invalid_pr_files','pr_files_changed','incomplete_pr_files','pr_files_page_limit',
 'EACCES','EPERM','ENOENT','EINVAL','EBUSY','EIO','ENOSPC',
 'BRIDGE_CHALLENGE_EXPIRED','BRIDGE_CHALLENGE_SUBJECT_CHANGED','BRIDGE_CHALLENGE_ACTION_REQUIRED','BRIDGE_CHALLENGE_REQUIRED',
 'BRIDGE_PACKET_SHAPE_REQUIRED','BRIDGE_CANONICAL_BYTES_REQUIRED','BRIDGE_JSON_REQUIRED','BRIDGE_UTF8_REQUIRED','BRIDGE_BYTE_BOUND',
 'BRIDGE_FORMAL_ADMISSION_SHAPE_REQUIRED','BRIDGE_RESPONSE_EXPIRED','BRIDGE_ISSUE_EXPIRED','BRIDGE_TIME_INVALID',
 'FORMAL_MAILBOX_READY_REQUIRED','FORMAL_MAILBOX_PACKET_CHANGED','FORMAL_MAILBOX_CHANGED','FORMAL_MAILBOX_FILE_BOUNDARY',
 'FORMAL_CALLBACK_SEQUENCE_CHANGED','FORMAL_CALLBACK_LIMIT','FORMAL_ISSUER_WINDOW_UNCONFIRMED',
 'ACTUAL_NATIVE_ADMISSION_REQUIRED','COMPLETE_NATIVE_ADMISSION_VIEW_REQUIRED','ISSUER_ACCEPTANCE_EXPIRED',
 'full_admission_claim_changed','full_admission_clock_invalid','full_admission_incomplete','full_admission_mode_unknown',
 'full_admission_native_changed','full_admission_native_unsupported','full_admission_not_configured','full_admission_observation_expired',
 'full_admission_observer_unknown','full_admission_principal_unknown','full_admission_rejected','full_admission_source_changed',
 'full_admission_subject_changed','full_admission_subject_invalid','full_admission_unavailable'
]);
const FAILURE_STAGES=new Set(['ISSUER_MAIN','CHALLENGE_READ','VALIDATE','EVALUATE','RESPONSE_WRITE']);
export function publicIssuerFailure(jobId,error,now=Date.now()){
 if(typeof jobId!=='string'||!/[a-f0-9]{64}/.test(jobId)||jobId.length!==64||!Number.isSafeInteger(now)||now<0||now>8640000000000000)return null;
 let reason='FORMAL_BRIDGE_UNCONFIRMED';
 if(error?.killed===true||error?.code==='ETIMEDOUT')reason='FIXED_ACL_PROBE_TIMEOUT';
 else if(error?.code===2)reason='FIXED_ACL_PROBE_REFUSED';
 else if(FAILURE_REASONS.has(error?.code))reason=error.code;
 else if(FAILURE_REASONS.has(error?.message))reason=error.message;
 const stage=FAILURE_STAGES.has(error?.issuerFailureStage)?error.issuerFailureStage:'ISSUER_MAIN';
 return{contract:'clued.independent-ci.issuer-failure/1',kind:'issuer_failure',jobId,stage,reason,observedAt:new Date(now).toISOString(),automaticRetryAllowed:false};
}
function persistIssuerFailure(record){
 if(!record)return false;let fd;
 try{
  const file=path.join(INSTALL_ROOT,'formal-spool','outgoing','observations.jsonl'),before=fs.lstatSync(file);
  check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<67108864,'ISSUER_AUDIT_BOUND');
  fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW??0));const held=fs.fstatSync(fd);
  check(held.isFile()&&held.nlink===1&&held.dev===before.dev&&held.ino===before.ino&&held.size===before.size,'ISSUER_AUDIT_UNCONFIRMED');
  const bytes=Buffer.from(canonical(record)+'\n');check(fs.writeSync(fd,bytes)===bytes.length,'ISSUER_AUDIT_UNCONFIRMED');fs.fsyncSync(fd);
  const after=fs.lstatSync(file);check(after.isFile()&&!after.isSymbolicLink()&&after.nlink===1&&after.dev===held.dev&&after.ino===held.ino,'ISSUER_AUDIT_UNCONFIRMED');return true;
 }catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}
}

export async function openWindowsJobIssuer(job,options={}){
  let locked=false,context=null;
  try{
    check(options&&Object.keys(options).every(k=>k==='signal'),'CALLER_ISSUER_CAPABILITY_REFUSED');const{signal}=options;
    context=await loadWindowsContext(job);takeAcceptedBridgeContext(context);const box=takeActualMailbox(await openAcceptedMailbox(context));
    await box.lock();locked=true;
    const{config,accepted}=context,nativeFile=path.join(INSTALL_ROOT,'secrets/ci-admission.token');
    await assertProtectedPaths(INSTALL_ROOT,[APP_KEY_FILE,nativeFile]);
    const key=await readProtected(APP_KEY_FILE,{secret:true,secretRoot:path.dirname(APP_KEY_FILE)}),token=(await readProtected(nativeFile,{secret:true,secretRoot:path.join(INSTALL_ROOT,'secrets')})).trim();
    check(/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(token)&&bindingPin(token)===accepted.ciTokenPinSha256&&fingerprint(key)===accepted.appPublicKeySha256Base64,'ACTUAL_ISSUER_PRINCIPAL_CHANGED');
    const fetchImpl=(url,opts={})=>{assertWindowsContextLive(context);check(!signal?.aborted&&Date.now()<Date.parse(accepted.expiresAt),'ISSUER_ACCEPTANCE_EXPIRED');return globalThis.fetch(url,{...opts,signal:signal?AbortSignal.any([signal,opts.signal??AbortSignal.timeout(30000)]):(opts.signal??AbortSignal.timeout(30000))});};
    const github=createGitHubChecksPort({repository:job.repo,repositoryId:config.repositoryId,appId:config.appId,installationId:config.installationId,includeModeRead:true,privateKeyProvider:async()=>key,fetchImpl});
    const log=path.join(context.descriptor.windowsRoot,'outgoing','observations.jsonl');
    const record=(kind,data)=>{check(/^[a-z][a-z0-9_]{0,79}$/.test(kind),'ISSUER_AUDIT_KIND_REFUSED');const fd=fs.openSync(log,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT,0o600);
      try{const st=fs.fstatSync(fd);check(st.isFile()&&st.nlink===1&&st.size<67108864,'ISSUER_AUDIT_BOUND');const b=Buffer.from(canonical({contract:'clued.independent-ci.source-observation/1',id:randomUUID(),kind,jobId:job.id,observedAt:new Date().toISOString(),dataSha256:proofDigest(data)})+'\n');check(fs.writeSync(fd,b)===b.length,'ISSUER_AUDIT_UNCONFIRMED');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
    const full=createFullAdmissionPort({protectedConfig:{...config,domain:'production',workspace:context.sourceRoot,policyText:context.policyText},fetchImpl,
      tokenProvider:async()=>({githubToken:await github.getInstallationToken(),ciAdmissionToken:token,ciPrincipalBindingId:config.ciPrincipalBindingId,ciPrincipalQualificationRef:config.ciPrincipalQualificationRef}),
      modeProvider:()=>github.readAdmissionMode(),recorderProvider:async()=>({domain:'production',kind:'independent-controller',observedAt:new Date().toISOString(),observationRef:randomUUID(),recorder:{newId:randomUUID,record}})});
    const evaluate=async()=>{assertWindowsContextLive(context);
      const facts=await full.evaluatePr(job,await github.readChangedPaths(job));assertWindowsContextLive(context);check(facts.status==='ADMITTED',/^full_admission_[a-z_]+$/.test(facts.reason??'')?facts.reason:'ACTUAL_NATIVE_ADMISSION_REQUIRED');return protocolAdmissionView(job,facts);};
    const collect=async()=>{assertWindowsContextLive(context);const refs=refsData(await collectCompleteRemoteRefs({job,token:await github.getInstallationToken(),readPullRequest:n=>github.readPullRequest(n),fetchImpl,signal}));assertWindowsContextLive(context);return refs;};
    const first=await evaluate(),refs=job.role==='gitleaks'?await collect():null;
    const issue=makeIssue(job,first,refs,{sourceAcceptanceRef:accepted.sourceAcceptanceRef,hostQualificationRef:accepted.hostQualificationRef,expiresAt:accepted.expiresAt});
    assertWindowsContextLive(context);await box.write('issue',encode(issue));let next=1;
    const issuer=Object.freeze({issue,async close(){await closeWindowsContext(context);},async serveNext(){
      assertWindowsContextLive(context);
      check(next<=32,'FORMAL_CALLBACK_LIMIT');const seq=next,name='challenge-'+String(seq).padStart(2,'0');
      let failureStage='CHALLENGE_READ';try{
       const bytes=await box.read(name);failureStage='VALIDATE';const challenge=validateChallenge(issue,decode(bytes));
       check(challenge.sequence===seq,'FORMAL_CALLBACK_SEQUENCE_CHANGED');failureStage='EVALUATE';const current=await evaluate();
       const refs=challenge.action==='admission'?null:await collect();failureStage='VALIDATE';
       const response=challenge.action==='admission'?makeResponse(issue,challenge,current,null):makeResponse(issue,challenge,null,refs);
       failureStage='RESPONSE_WRITE';assertWindowsContextLive(context);await box.write('response-'+String(seq).padStart(2,'0'),encode(response));next++;return{status:'FRESH_FORMAL_CALLBACK_RETURNED',sequence:seq,action:challenge.action,automaticRetryAllowed:false};
      }catch(error){if(error&&typeof error==='object'){try{error.issuerFailureStage=failureStage;}catch{}}throw error;}
    },async consumeResult(){assertWindowsContextLive(context);const raw=await box.read('result');let wrapper;try{wrapper=JSON.parse(raw.toString('utf8'));}catch{fail('SIGNED_BRIDGE_RESULT_JSON_REQUIRED');}
      check(Buffer.from(canonical(wrapper)).equals(raw),'SIGNED_BRIDGE_RESULT_CANONICAL_REQUIRED');const result=verifySignedBridgeResult({issue,wrapper,signers:context.signers});await evaluate();
      return{status:'ACTUAL_SIGNED_EXECUTION_OBSERVED',job:issue.job,envelope:wrapper.envelope,verified:result,checksWritten:false,qualificationIssued:false,automaticRetryAllowed:false};
    },async runUntilResult(){try{while(Date.now()<Date.parse(issue.expiresAt)&&!signal?.aborted){assertWindowsContextLive(context);try{return await issuer.consumeResult();}catch(e){if(e.code!=='ENOENT')throw e;}
      try{await issuer.serveNext();}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(resolve=>setTimeout(resolve,100));}fail('FORMAL_ISSUER_WINDOW_UNCONFIRMED');}finally{await closeWindowsContext(context);}}
    });actual.add(issuer);return{status:'FORMAL_JOB_ISSUED',issuer,issueSha256:digest(issue),checksWritten:false,qualificationIssued:false};
  }catch(e){if(context)await closeWindowsContext(context);return{status:locked?'UNCERTAIN':'BLOCKED',reason:safe(e),jobIssued:false,preparationStarted:false,automaticRetryAllowed:false,checksWritten:false,qualificationIssued:false};}
}
export function takeActualWindowsIssuer(value){check(actual.has(value),'ACTUAL_WINDOWS_ISSUER_REQUIRED');return value;}
export async function main(argv=process.argv.slice(2),output=process.stdout){
  if(argv.length!==1||argv[0]!=='--run'){output.write(JSON.stringify({status:'BLOCKED',reason:'FIXED_WINDOWS_BRIDGE_RUN_REQUIRED'})+'\n');return 2;}
  let job=null;
  try{const file=path.join(INSTALL_ROOT,'formal-job.json');await assertProtectedPaths(INSTALL_ROOT,[file]);job=JSON.parse(await readProtected(file));const opened=await openWindowsJobIssuer(job);
    if(opened.status!=='FORMAL_JOB_ISSUED'){const diagnostic=publicIssuerFailure(job?.id,{code:opened.reason});const persisted=persistIssuerFailure(diagnostic);output.write(JSON.stringify({...opened,reason:diagnostic?.reason??'FORMAL_BRIDGE_UNCONFIRMED',failureDiagnosticPersisted:persisted})+'\n');return 2;}
    const result=await takeActualWindowsIssuer(opened.issuer).runUntilResult();output.write(JSON.stringify(result)+'\n');return 0;
  }catch(e){const diagnostic=publicIssuerFailure(job?.id,e),persisted=persistIssuerFailure(diagnostic);output.write(JSON.stringify({status:'UNCERTAIN',reason:diagnostic?.reason??'FORMAL_BRIDGE_UNCONFIRMED',failureDiagnosticPersisted:persisted,automaticRetryAllowed:false,checksWritten:false})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
