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
const actual=new WeakSet(),fail=code=>{throw Object.assign(new Error(code),{code});},check=(v,c)=>{if(!v)fail(c);};
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??e?.message??'')?(e.code??e.message):'FORMAL_BRIDGE_UNCONFIRMED';
const bindingPin=v=>proofDigest('clued.independent-ci.ci-binding-pin/1\0'+v);
const fingerprint=v=>createHash('sha256').update(createPublicKey(v).export({format:'der',type:'spki'})).digest('base64');
const refsData=value=>Object.fromEntries(['contract','repository','complete','observedAt','refs'].map(k=>[k,value[k]]));
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
      const facts=await full.evaluatePr(job,await github.readChangedPaths(job));assertWindowsContextLive(context);check(facts.status==='ADMITTED',/^full_admission_[a-z_]+$/.test(facts.reason??'')?facts.reason:'ACTUAL_NATIVE_ADMISSION_REQUIRED');return facts;};
    const collect=async()=>{assertWindowsContextLive(context);const refs=refsData(await collectCompleteRemoteRefs({job,token:await github.getInstallationToken(),readPullRequest:n=>github.readPullRequest(n),fetchImpl,signal}));assertWindowsContextLive(context);return refs;};
    const first=await evaluate(),refs=job.role==='gitleaks'?await collect():null;
    const issue=makeIssue(job,first,refs,{sourceAcceptanceRef:accepted.sourceAcceptanceRef,hostQualificationRef:accepted.hostQualificationRef,expiresAt:accepted.expiresAt});
    assertWindowsContextLive(context);await box.write('issue',encode(issue));let next=1;
    const issuer=Object.freeze({issue,async close(){await closeWindowsContext(context);},async serveNext(){
      assertWindowsContextLive(context);
      check(next<=32,'FORMAL_CALLBACK_LIMIT');const seq=next,name='challenge-'+String(seq).padStart(2,'0');
      const challenge=validateChallenge(issue,decode(await box.read(name)));
      check(challenge.sequence===seq,'FORMAL_CALLBACK_SEQUENCE_CHANGED');const current=await evaluate();
      const response=challenge.action==='admission'?makeResponse(issue,challenge,current,null):makeResponse(issue,challenge,null,await collect());
      assertWindowsContextLive(context);await box.write('response-'+String(seq).padStart(2,'0'),encode(response));next++;return{status:'FRESH_FORMAL_CALLBACK_RETURNED',sequence:seq,action:challenge.action,automaticRetryAllowed:false};
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
  try{const file=path.join(INSTALL_ROOT,'formal-job.json');await assertProtectedPaths(INSTALL_ROOT,[file]);const opened=await openWindowsJobIssuer(JSON.parse(await readProtected(file)));
    if(opened.status!=='FORMAL_JOB_ISSUED'){output.write(JSON.stringify(opened)+'\n');return 2;}
    const result=await takeActualWindowsIssuer(opened.issuer).runUntilResult();output.write(JSON.stringify(result)+'\n');return 0;
  }catch(e){output.write(JSON.stringify({status:'UNCERTAIN',reason:safe(e),automaticRetryAllowed:false,checksWritten:false})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
