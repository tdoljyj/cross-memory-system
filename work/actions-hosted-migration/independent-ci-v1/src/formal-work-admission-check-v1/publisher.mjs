// A Native admission control check, not a scanner execution result, ticket,
// Receipt or qualification. Production has no caller-injected dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,createPublicKey,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical,digest,subjectOf} from '../proof.mjs';
import {validateJob} from '../queue.mjs';
import {EffectJournal} from '../effect-journal.mjs';
import {createGitHubChecksPort} from '../github.mjs';
import {createFullAdmissionPort,fullAdmissionFailure} from '../full-admission.mjs';
import {INSTALL_ROOT,APP_KEY_FILE,assertProtectedPaths,readProtected} from '../../runtime/protected-files.mjs';
import {openHeldSource,takeHeldSource} from '../../worker/protected-job-bridge-v2/held-source.mjs';
import {validateFormalAcceptance,validateSourcePins,REQUIRED_SOURCE_PATHS as BRIDGE_SOURCE} from '../../worker/protected-job-bridge-v2/boundary.mjs';
import {WINDOWS_ROOT,validateRelayDescriptor} from '../../worker/protected-job-bridge-v2/mailbox.mjs';

export const ROLE='work-admission',CHECK_NAME='kooyumi-work-admission',APP_ID=5368905,REPO='tdoljyj/cross-memory-system';
const PREFIX='work/actions-hosted-migration/independent-ci-v1/';
export const REQUIRED_SOURCE_PATHS=Object.freeze([...BRIDGE_SOURCE,PREFIX+'src/effect-journal.mjs',PREFIX+'src/formal-work-admission-check-v1/publisher.mjs',PREFIX+'src/formal-work-admission-check-v1/startup.mjs']);
const SOURCE_ROOT=fileURLToPath(new URL('../../../../../',import.meta.url));
const DEFINITION=Object.freeze({name:CHECK_NAME,appId:APP_ID});
const HASH=/^[a-f0-9]{64}$/,fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(ok,code)=>{if(!ok)fail(code);};
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??'')?e.code:'NATIVE_CHECK_UNCONFIRMED';
const diagnosticOf=e=>fullAdmissionFailure({contract:'clued.independent-ci.full-admission/1',status:'BLOCKED',admitted:false,reason:e?.code,diagnostic:e?.admissionDiagnostic})?.admissionDiagnostic;
const fresh=(f,now)=>Number.isSafeInteger(now)&&Number.isFinite(Date.parse(f?.observedAt))&&Date.parse(f.observedAt)<=now&&now-Date.parse(f.observedAt)<=30000&&Date.parse(f.claimExpiresAt)>now;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const fixedJob=job=>{validateJob(job);check(job.repo===REPO&&job.role===ROLE&&job.attempt===1,'FIXED_WORK_ADMISSION_JOB_REQUIRED');return freeze(structuredClone(job));};
function identity(c,job,externalId){return Number.isSafeInteger(c?.id)&&c.id>0&&c.app?.id===APP_ID&&c.name===CHECK_NAME&&c.head_sha===job.headSha&&c.external_id===externalId;}
function factsValid(job,packet,facts,domain,now){
 check(packet?.complete===true&&packet.pr===job.pr&&packet.headSha===job.headSha&&packet.baseSha===job.baseSha&&Array.isArray(packet.paths)&&packet.paths.length>0&&packet.paths.length<=3000&&new Set(packet.paths).size===packet.paths.length,'COMPLETE_CURRENT_PATHS_REQUIRED');
 const rejection=fullAdmissionFailure(facts);if(rejection)throw Object.assign(new Error(rejection.reason),{code:rejection.reason,...(rejection.admissionDiagnostic?{admissionDiagnostic:rejection.admissionDiagnostic}:{})});
 check(facts?.contract==='clued.independent-ci.full-admission/1'&&facts.status==='ADMITTED'&&facts.admitted===true&&facts.completeAdmission===true&&facts.domain===domain&&facts.evaluator==='scripts/ci/clued-work-admission.mjs#evaluate'&&facts.observationOnly!==true&&facts.publicationAuthorized!==false,'ACTUAL_COMPLETE_NATIVE_ADMISSION_REQUIRED');
 check(facts.repository===job.repo&&facts.prRef===`${job.repo}#${job.pr}`&&['headSha','baseSha','claimId','fence','epoch','sourceManifestSha256'].every(k=>facts[k]===job[k])&&facts.packetSha256===digest(packet),'NATIVE_CHECK_SUBJECT_CHANGED');
 check(facts.executionPolicy==='staged'&&facts.guarded===false&&plain(facts.mode)&&['normal','efficiency','frozen'].includes(facts.mode.state)&&['docs','code','protected'].includes(facts.mode.layer)&&plain(facts.mergeSlot)&&(facts.ownerReview===null||plain(facts.ownerReview))&&Array.isArray(facts.workflowGateFindings)&&facts.workflowGateFindings.length===0,'COMPLETE_NATIVE_GATES_REQUIRED');
 check(typeof facts.modeProofRef==='string'&&facts.modeProofRef.length>0&&typeof facts.observationRef==='string'&&facts.observationRef.length>0&&HASH.test(facts.evaluationSha256??'')&&HASH.test(facts.observationSha256??'')&&fresh(facts,now),'FRESH_NATIVE_OBSERVATION_REQUIRED');
 const {observationSha256,...body}=facts;check(digest(body)===observationSha256,'NATIVE_OBSERVATION_DIGEST_CHANGED');
 return facts;
}
function binding(job,packet,facts,authority){return digest({subject:subjectOf(job),pathsSha256:digest(packet.paths),scope:facts.scope,executionPolicy:facts.executionPolicy,mode:facts.mode,mergeSlot:facts.mergeSlot,ownerReview:facts.ownerReview,workflowGateFindings:facts.workflowGateFindings,claimExpiresAt:facts.claimExpiresAt,authority,definition:DEFINITION});}

// This engine is private. The only exported injectable path below is permanently
// fixture-only. The production factory constructs every actual provider itself.
function engine({github,journal,admission,assertLive,record,authority,clock=Date.now},production){
 const domain=production?'production':'fixture';
 async function boundary(job){
  assertLive();const packet=await github.readChangedPaths(job),facts=await admission.evaluatePr(job,packet);assertLive();factsValid(job,packet,facts,domain,clock());
  record('native_check_boundary',{jobId:job.id,nativeObservationSha256:facts.observationSha256,packetSha256:digest(packet)});
  return {facts,bindingSha256:binding(job,packet,facts,authority)};
 }
 async function inventory(job,externalId){
  const list=await github.readChecks(job.headSha);check(list?.complete===true&&Array.isArray(list.checks)&&list.checks.length<=10000&&new Set(list.checks.map(c=>c?.id)).size===list.checks.length&&list.checks.every(c=>Number.isSafeInteger(c?.id)&&c.id>0&&c.head_sha===job.headSha),'COMPLETE_CHECK_INVENTORY_REQUIRED');
  return list.checks.filter(c=>identity(c,job,externalId));
 }
 async function readback(job,externalId,id,conclusion){const matches=await inventory(job,externalId);check(matches.length===1&&matches[0].id===id&&matches[0].status==='completed'&&matches[0].conclusion===conclusion,'NATIVE_CHECK_READBACK_UNCONFIRMED');return matches[0];}
 async function transition(key,phase,next,details){try{return await journal.transition(key,phase,next,details);}catch{return null;}}
 async function revoke({job,key,externalId,known,phase,cause,sideEffects,admissionDiagnostic}){
  const revKey=digest({action:'native-work-admission-revoke',effectKey:key,checkRunId:known.id});let revPhase='intent',logged=false;
  try{const matches=await inventory(job,externalId);check(matches.length===1&&matches[0].id===known.id,'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED');}catch{return {status:'UNCERTAIN',reason:'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED',effectKey:key,sideEffects,productionAuthorized:false,automaticRetryAllowed:false};}
  try{
   const intent=await journal.begin(revKey,{checkRunId:known.id,appId:APP_ID,name:CHECK_NAME,headSha:job.headSha,externalId});
   if(intent.existing)return {status:'UNCERTAIN',reason:'NEGATIVE_COMPENSATION_RECONCILIATION_REQUIRED',effectKey:key,sideEffects,productionAuthorized:false};
   await journal.transition(revKey,'intent','authorized');revPhase='authorized';await journal.transition(revKey,'authorized','sent');revPhase='sent';logged=true;
  }catch{if(phase!=='sent')return {status:'UNCERTAIN',reason:'NEGATIVE_COMPENSATION_JOURNAL_UNCONFIRMED',effectKey:key,sideEffects,productionAuthorized:false};}
  try{
   // A previously authorized bounded negative compensation may run even when
   // fresh Native denies. Source/Host/principal/Owner acceptance still must live.
   assertLive();sideEffects++;const patched=await github.revokeCheck(known.id,{status:'completed',conclusion:'failure',output:{title:'Work admission authorization changed',summary:`Reconcile Native admission check ${key}; ${cause}. No Native ticket or Receipt is asserted.`}});
   check(identity(patched,job,externalId)&&patched.status==='completed'&&patched.conclusion==='failure','NEGATIVE_COMPENSATION_UNCONFIRMED');await readback(job,externalId,known.id,'failure');
   if(logged)await journal.transition(revKey,'sent','settled',{checkRunId:known.id,conclusion:'failure'});
   const current=await journal.read(key);check(['sent','uncertain','settled'].includes(current?.state),'NEGATIVE_COMPENSATION_STATE_UNCONFIRMED');await journal.transition(key,current.state,'revoked',{checkRunId:known.id,externalId,reason:cause,...(admissionDiagnostic?{admissionDiagnostic}:{})});
   record('native_check_revoked',{effectKey:key,checkRunId:known.id,cause});return {status:'REVOKED',reason:cause,...(admissionDiagnostic?{admissionDiagnostic}:{}),effectKey:key,checkRunId:known.id,sideEffects,productionAuthorized:false,automaticRetryAllowed:false};
  }catch{
   if(revPhase==='sent')await transition(revKey,'sent','uncertain',{checkRunId:known.id,reason:'NEGATIVE_COMPENSATION_UNCONFIRMED'});
   if(phase==='sent')await transition(key,'sent','uncertain',{checkRunId:known.id,externalId,reason:'NEGATIVE_COMPENSATION_UNCONFIRMED'});
   return {status:'UNCERTAIN',effectKey:key,checkRunId:known.id,sideEffects,productionAuthorized:false,automaticRetryAllowed:false,reason:'NEGATIVE_COMPENSATION_UNCONFIRMED'};
  }
 }
 return Object.freeze({fixture:!production,async publish(input){
  let job,key,externalId,previous,before,journalReadConfirmed=false;
  try{
   job=fixedJob(input);key=digest({action:'native-work-admission-check',subject:subjectOf(job),definition:DEFINITION});externalId=`independent-ci:native-work-admission:${job.id}:f${job.fence}:e${job.epoch}:a${job.attempt}`;
   previous=await journal.read(key);journalReadConfirmed=true;
   if(previous&&previous.state!=='settled')return {status:previous.state==='revoked'?'REVOKED':'RECONCILIATION_REQUIRED',effectKey:key,sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};
   before=await boundary(job);
   if(previous){await readback(job,externalId,previous.details.checkRunId,'success');return {status:'SETTLED',effectKey:key,checkRunId:previous.details.checkRunId,sideEffects:0,productionAuthorized:production,automaticRetryAllowed:false};}
  }catch(e){
   if(previous?.state==='settled'&&Number.isSafeInteger(previous.details?.checkRunId)&&previous.details.checkRunId>0)return revoke({job,key,externalId,known:{id:previous.details.checkRunId},phase:'settled',cause:safe(e),sideEffects:0,admissionDiagnostic:diagnosticOf(e)});
   // A validated subject that was confirmed absent gets a durable negative
   // record even when the first Native boundary refuses. Never POST or replay.
   if(journalReadConfirmed&&!previous&&job&&key){
    try{
     const intent=await journal.begin(key,{subject:subjectOf(job),definition:DEFINITION,externalId,observationKind:'blocked-native-admission-control',diagnosticOnly:true});
     if(intent.existing)return {status:'RECONCILIATION_REQUIRED',effectKey:key,sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};
     await journal.transition(key,'intent','not_sent',{reason:safe(e),externalId,...(diagnosticOf(e)?{admissionDiagnostic:diagnosticOf(e)}:{})});
    }catch{return {status:'UNCERTAIN',reason:'BLOCKED_DIAGNOSTIC_UNCONFIRMED',effectKey:key,sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};}
   }
   return {status:'BLOCKED',reason:safe(e),...(diagnosticOf(e)?{admissionDiagnostic:diagnosticOf(e)}:{}),sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};
  }
  let phase='intent',sent=false,known=null,sideEffects=0;
  try{
   const intent=await journal.begin(key,{subject:subjectOf(job),definition:DEFINITION,externalId,observationKind:'actual-native-admission-control',nativeObservationSha256:before.facts.observationSha256,bindingSha256:before.bindingSha256,compensation:'known-success-one-bounded-negative-patch'});
   if(intent.existing)return {status:'RECONCILIATION_REQUIRED',effectKey:key,sideEffects,productionAuthorized:false,automaticRetryAllowed:false};
   await journal.transition(key,'intent','authorized',{nativeObservationSha256:before.facts.observationSha256});phase='authorized';
   assertLive();check(fresh(before.facts,clock()),'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
   await journal.transition(key,'authorized','sent',{externalId,nativeObservationSha256:before.facts.observationSha256});phase='sent';sent=true;sideEffects++;
   const posted=await github.createCheck({name:CHECK_NAME,head_sha:job.headSha,status:'completed',conclusion:'success',external_id:externalId,output:{title:'Work claim and complete Native admission verified',summary:`Independent Native control check for ${REPO}#${job.pr}; observation sha256 ${before.facts.observationSha256}. This is not a scanner execution, Native publication ticket, Receipt or qualification.`}});
   check(identity(posted,job,externalId)&&posted.status==='completed'&&posted.conclusion==='success','NATIVE_CHECK_IDENTITY_UNCONFIRMED');known=posted;
   const after=await boundary(job);check(after.bindingSha256===before.bindingSha256,'NATIVE_AUTHORIZATION_BINDING_CHANGED');await readback(job,externalId,known.id,'success');assertLive();check(fresh(after.facts,clock()),'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE');
   await journal.transition(key,'sent','settled',{checkRunId:known.id,externalId,conclusion:'success',nativeObservationBeforeSha256:before.facts.observationSha256,nativeObservationAfterSha256:after.facts.observationSha256,bindingSha256:after.bindingSha256});
   record('native_check_settled',{effectKey:key,checkRunId:known.id,beforeSha256:before.facts.observationSha256,afterSha256:after.facts.observationSha256});
   return {status:'SETTLED',effectKey:key,checkRunId:known.id,nativeObservationBeforeSha256:before.facts.observationSha256,nativeObservationAfterSha256:after.facts.observationSha256,sideEffects,productionAuthorized:production,automaticRetryAllowed:false};
  }catch(e){
   if(sent&&!known){try{const matches=await inventory(job,externalId);if(matches.length===1)known=matches[0];}catch{/* Read-only discovery cannot prove a missing POST did not succeed. */}}
   if(sent&&known)return revoke({job,key,externalId,known,phase,cause:safe(e),sideEffects,admissionDiagnostic:diagnosticOf(e)});
   await transition(key,phase,sent?'uncertain':'not_sent',{reason:safe(e),externalId,...(diagnosticOf(e)?{admissionDiagnostic:diagnosticOf(e)}:{})});
   return {status:sent?'UNCERTAIN':'BLOCKED',effectKey:key,reason:safe(e),...(diagnosticOf(e)?{admissionDiagnostic:diagnosticOf(e)}:{}),sideEffects,productionAuthorized:false,automaticRetryAllowed:false};
  }
 }});
}
export function createFixtureWorkAdmissionPublisher(dependencies){return engine(dependencies,false);}

export async function publishInstalledWorkAdmission(options={}){
 let lease=null;
 try{
  check(exact(options,Object.hasOwn(options??{},'signal')?['signal']:[]),'CALLER_NATIVE_CHECK_CAPABILITY_REFUSED');check(process.platform==='win32','FIXED_WINDOWS_NATIVE_CHECK_REQUIRED');
  const {signal}=options;lease=takeHeldSource(await openHeldSource());const held=lease.data;
  const text=name=>new TextDecoder('utf-8',{fatal:true}).decode(held.documents[name]),config=JSON.parse(text('installation.json')),accepted=JSON.parse(text('acceptance.json'));
  const live=()=>{takeHeldSource(lease);check(!signal?.aborted,'NATIVE_CHECK_ABORTED');validateFormalAcceptance(config,accepted,{platform:process.platform,arch:process.arch,hostname:os.hostname(),account:os.userInfo().username});};
  live();check(digest(text('acceptance.json'))===config.acceptanceSha256&&held.expiresAt===accepted.expiresAt,'FORMAL_NATIVE_CHECK_ACCEPTANCE_CHANGED');
  const pins=validateSourcePins(accepted.sourceFiles,REQUIRED_SOURCE_PATHS);check(pins.size===held.sourceHashes.size&&[...pins].every(([p,s])=>held.sourceHashes.get(p)===s),'FORMAL_NATIVE_CHECK_SOURCE_CHANGED');
  check(pins.get('scripts/ci/clued-work-admission.mjs')===config.evaluatorSha256&&pins.get('config/merge-admission-policy.json')===config.policySha256,'FORMAL_NATIVE_EVALUATOR_CHANGED');
  const manifest=JSON.parse(text('source-manifest.json'));check(digest(text('source-manifest.json'))===config.sourceManifestSha256&&manifest.repo===REPO&&manifest.roles?.[ROLE],'FORMAL_NATIVE_CHECK_ROLE_NOT_ACCEPTED');
  const rolePins=validateSourcePins(manifest.roles[ROLE].sourceFiles,REQUIRED_SOURCE_PATHS);check(rolePins.size===pins.size&&[...pins].every(([p,s])=>rolePins.get(p)===s),'FORMAL_NATIVE_CHECK_ROLE_SOURCE_CHANGED');
  check(plain(config.checks)&&Object.keys(config.checks).length===6&&new Set(Object.values(config.checks).map(v=>v?.name)).size===6&&Object.values(config.checks).every(v=>exact(v,['name','appId'])&&v.appId===APP_ID&&typeof v.name==='string'&&v.name.length>0)&&canonical(config.checks[ROLE])===canonical(DEFINITION),'FORMAL_NATIVE_CHECK_MAPPING_NOT_ACCEPTED');
  validateRelayDescriptor(manifest.roles[ROLE].controllerRelay,accepted);
  const jobFile=path.join(INSTALL_ROOT,'work-admission-job.json');await assertProtectedPaths(INSTALL_ROOT,[jobFile]);const job=fixedJob(JSON.parse(await readProtected(jobFile)));check(job.sourceManifestSha256===config.sourceManifestSha256,'FORMAL_NATIVE_CHECK_JOB_CHANGED');
  const acl=fileURLToPath(new URL('../../worker/protected-job-bridge-v2/formal-spool-acl.ps1',import.meta.url));
  for(const target of [WINDOWS_ROOT,path.join(WINDOWS_ROOT,'outgoing')])await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',acl,'-LiteralTarget',target,'-ProtectedRoot',WINDOWS_ROOT,'-AllowControllerWrite'],{windowsHide:true,timeout:10000,maxBuffer:4096});
  live();const keyFile=APP_KEY_FILE,nativeFile=path.join(INSTALL_ROOT,'secrets/ci-admission.token');await assertProtectedPaths(INSTALL_ROOT,[keyFile,nativeFile]);
  const appKey=await readProtected(keyFile,{secret:true,secretRoot:path.dirname(keyFile)}),nativeToken=(await readProtected(nativeFile,{secret:true,secretRoot:path.join(INSTALL_ROOT,'secrets')})).trim();
  check(/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(nativeToken)&&digest('clued.independent-ci.ci-binding-pin/1\0'+nativeToken)===accepted.ciTokenPinSha256&&createHash('sha256').update(createPublicKey(appKey).export({type:'spki',format:'der'})).digest('base64')===accepted.appPublicKeySha256Base64,'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED');
  const fetchImpl=(url,opts={})=>{live();return globalThis.fetch(url,{...opts,signal:signal?AbortSignal.any([signal,opts.signal??AbortSignal.timeout(30000)]):(opts.signal??AbortSignal.timeout(30000))});};
  const github=createGitHubChecksPort({repository:REPO,repositoryId:1334673495,appId:APP_ID,installationId:172706661,includeModeRead:true,privateKeyProvider:async()=>appKey,fetchImpl});
  const directory=path.join(WINDOWS_ROOT,'outgoing'),journal=await EffectJournal.open(directory),log=path.join(directory,'observations.jsonl');
  const record=(kind,data)=>{check(/^[a-z][a-z0-9_]{0,79}$/.test(kind),'NATIVE_CHECK_LOG_KIND_REFUSED');const fd=fs.openSync(log,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT,0o600);try{const s=fs.fstatSync(fd);check(s.isFile()&&s.nlink===1&&s.size<67108864,'NATIVE_CHECK_LOG_BOUNDARY');const b=Buffer.from(canonical({contract:'clued.independent-ci.source-observation/1',id:randomUUID(),kind,jobId:job.id,observedAt:new Date().toISOString(),dataSha256:digest(data)})+'\n');check(fs.writeSync(fd,b)===b.length,'NATIVE_CHECK_LOG_UNCONFIRMED');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const admission=createFullAdmissionPort({protectedConfig:{...config,domain:'production',workspace:SOURCE_ROOT,policyText:held.policyText},fetchImpl,modeProvider:()=>github.readAdmissionMode(),tokenProvider:async()=>({githubToken:await github.getInstallationToken(),ciAdmissionToken:nativeToken,ciPrincipalBindingId:config.ciPrincipalBindingId,ciPrincipalQualificationRef:config.ciPrincipalQualificationRef}),recorderProvider:async()=>({domain:'production',kind:'independent-controller',observedAt:new Date().toISOString(),observationRef:randomUUID(),recorder:{newId:randomUUID,record}})});
  const authority=Object.fromEntries(['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef','ownerPackageAcceptanceRef','installationReceiptRef'].map(k=>[k,accepted[k]]));
  return await engine({github,journal,admission,assertLive:live,record,authority},true).publish(job);
 }catch(e){return {status:'BLOCKED',reason:safe(e),sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};}
 finally{if(lease)await lease.close();}
}

