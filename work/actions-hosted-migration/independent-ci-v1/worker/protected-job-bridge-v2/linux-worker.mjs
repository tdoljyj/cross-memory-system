// Fixed Linux side: no GitHub/Native credential, API client or Check writer.
import {loadLinuxContext,takeAcceptedBridgeContext} from './boundary.mjs';
import {openAcceptedMailbox,takeActualMailbox} from './mailbox.mjs';
import {validateIssue,makeChallenge,validateResponse,decode,encode,digest} from './protocol.mjs';
import {signActualBridgeResult} from './signed-result.mjs';
import {createFormalGitleaksAdapter} from '../formal-gitleaks-v2/adapter.mjs';
import {createFormalTrivyAdapter} from '../formal-trivy-v2/adapter.mjs';
import {canonical} from '../../src/proof.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??e?.message??'')?(e.code??e.message):'FORMAL_BRIDGE_UNCONFIRMED';
export async function executeProtectedIssuedJob(options={}){
  let locked=false,executionMayHaveStarted=false;
  try{
    check(options&&Object.keys(options).every(k=>k==='signal'),'CALLER_LINUX_BRIDGE_CAPABILITY_REFUSED');const{signal}=options;
    const context=await loadLinuxContext();takeAcceptedBridgeContext(context);const box=takeActualMailbox(await openAcceptedMailbox(context));await box.lock();locked=true;
    const issue=validateIssue(decode(await box.read('issue'))),job=issue.job;
    check(job.role===context.role&&job.sourceManifestSha256===context.config.sourceManifestSha256&&issue.sourceAcceptanceRef===context.sourceAcceptanceRef&&issue.hostQualificationRef===context.hostQualificationRef&&
      ['claimId','fence','epoch'].every(k=>job[k]===context.config.currentClaim[k])&&Date.parse(issue.expiresAt)<=Date.parse(context.config.currentClaim.expiresAt),'FORMAL_ISSUE_QUALIFICATION_CHANGED');
    let sequence=0;
    const callback=async(action,subject)=>{check(canonical(subject)===canonical(job),'FORMAL_CALLBACK_SUBJECT_CHANGED');
      const fresh=await loadLinuxContext();check(fresh.sourceAcceptanceRef===context.sourceAcceptanceRef&&fresh.hostQualificationRef===context.hostQualificationRef&&fresh.config.sourceManifestSha256===job.sourceManifestSha256,'FORMAL_CALLBACK_AUTHORITY_CHANGED');
      const request=makeChallenge(issue,action,++sequence),suffix=String(sequence).padStart(2,'0');await box.write('challenge-'+suffix,encode(request));
      const response=validateResponse(issue,request,decode(await box.wait('response-'+suffix,{deadline:Date.parse(request.deadline),signal})));
      return action==='admission'?response.admission:response.remoteRefs;
    };
    // Adapters cannot prepare until their first callback gets a fresh actual
    // production response through the accepted Root-protected relay.
    const ports=Object.freeze({admissionPort:subject=>callback('admission',subject),remoteRefsPort:subject=>callback('remote-refs',subject)});
    const adapter=job.role==='gitleaks'?createFormalGitleaksAdapter(ports):createFormalTrivyAdapter(ports);executionMayHaveStarted=true;
    const result=await adapter.execute(job,{signal});
    if(result?.status==='BLOCKED'&&result.sideEffectsMayHaveStarted===false&&result.snapshotRetained!==true)return{...result,preparationStarted:false,automaticRetryAllowed:false,bridgeLockRetained:true};
    check(result?.observation,'ACTUAL_SCANNER_OBSERVATION_MISSING');
    await callback('admission',job);const signed=await signActualBridgeResult(context,issue,result.observation);
    const bytes=Buffer.from(canonical(signed));await box.write('result',bytes);
    return{status:'ACTUAL_SIGNED_SCANNER_RESULT_EMITTED',issueSha256:digest(issue),resultSha256:digest(signed),cleanupConfirmed:true,checksWritten:false,qualificationIssued:false,automaticRetryAllowed:false};
  }catch(e){return{status:locked?'UNCERTAIN':'BLOCKED',reason:safe(e),executionMayHaveStarted,automaticRetryAllowed:false,checksWritten:false,qualificationIssued:false};}
}
export async function main(argv=process.argv.slice(2),output=process.stdout){
  if(argv.length!==1||argv[0]!=='--run'){output.write(JSON.stringify({status:'BLOCKED',reason:'FIXED_LINUX_BRIDGE_RUN_REQUIRED'})+'\n');return 2;}
  const r=await executeProtectedIssuedJob();output.write(JSON.stringify(r)+'\n');return r.status==='ACTUAL_SIGNED_SCANNER_RESULT_EMITTED'?0:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
