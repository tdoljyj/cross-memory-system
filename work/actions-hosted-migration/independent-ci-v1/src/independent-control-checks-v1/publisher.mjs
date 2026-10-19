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
import {INSTALL_ROOT,APP_KEY_FILE,assertProtectedPaths,readProtected} from '../../runtime/protected-files.mjs';
import {BRIDGE_SOURCE} from './closure.mjs';

export const APP_ID=5368905,REPO='tdoljyj/cross-memory-system';
export const CONTROL_CHECKS=Object.freeze({
 'control-admission':Object.freeze({name:'kooyumi-admission-verified',appId:APP_ID}),
 'control-merge-slot':Object.freeze({name:'kooyumi-merge-slot',appId:APP_ID})
});
const actualConsumptions=new WeakMap();
const definitionFor=job=>CONTROL_CHECKS[job.role];
const PREFIX='work/actions-hosted-migration/independent-ci-v1/';
export const REQUIRED_SOURCE_PATHS=Object.freeze([...BRIDGE_SOURCE,PREFIX+'src/effect-journal.mjs',PREFIX+'src/independent-control-checks-v1/publisher.mjs',PREFIX+'src/independent-control-checks-v1/consumer.mjs',PREFIX+'src/independent-control-checks-v1/startup.mjs',PREFIX+'src/independent-control-checks-v1/closure.mjs',PREFIX+'src/independent-control-checks-v1/queue-facts.mjs',PREFIX+'runtime/one-shot.mjs',PREFIX+'src/staged-check-publisher.mjs',PREFIX+'src/formal-work-admission-check-v1/publisher.mjs',PREFIX+'src/formal-work-admission-check-v1/startup.mjs']);
const SOURCE_ROOT=fileURLToPath(new URL('../../../../../',import.meta.url));
const HASH=/^[a-f0-9]{64}$/,fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(ok,code)=>{if(!ok)fail(code);};
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const safe=e=>/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code??'')?e.code:'NATIVE_CHECK_UNCONFIRMED';
const fresh=(f,now)=>Number.isSafeInteger(now)&&Number.isFinite(Date.parse(f?.observedAt))&&Date.parse(f.observedAt)<=now&&now-Date.parse(f.observedAt)<=30000&&Date.parse(f.claimExpiresAt)>now;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const fixedJob=job=>{validateJob(job);check(job.repo===REPO&&Object.hasOwn(CONTROL_CHECKS,job.role)&&job.attempt===1,'FIXED_INDEPENDENT_CONTROL_JOB_REQUIRED');return freeze(structuredClone(job));};
function identity(c,job,externalId){return Number.isSafeInteger(c?.id)&&c.id>0&&c.app?.id===APP_ID&&c.name===definitionFor(job).name&&c.head_sha===job.headSha&&c.external_id===externalId;}
function factsValid(job,packet,facts,domain,now){
 check(packet?.complete===true&&packet.pr===job.pr&&packet.headSha===job.headSha&&packet.baseSha===job.baseSha&&Array.isArray(packet.paths)&&packet.paths.length>0&&packet.paths.length<=3000&&new Set(packet.paths).size===packet.paths.length,'COMPLETE_CURRENT_PATHS_REQUIRED');
 check(facts?.contract==='clued.independent-ci.full-admission/1'&&facts.status==='ADMITTED'&&facts.admitted===true&&facts.completeAdmission===true&&facts.domain===domain&&facts.evaluator==='scripts/ci/clued-work-admission.mjs#evaluate'&&facts.observationOnly!==true&&facts.publicationAuthorized!==false,'ACTUAL_COMPLETE_NATIVE_ADMISSION_REQUIRED');
 check(facts.repository===job.repo&&facts.prRef===`${job.repo}#${job.pr}`&&['headSha','baseSha','claimId','fence','epoch','sourceManifestSha256'].every(k=>facts[k]===job[k])&&facts.packetSha256===digest(packet),'NATIVE_CHECK_SUBJECT_CHANGED');
 check(facts.executionPolicy==='staged'&&facts.guarded===false&&facts.executionHandoverPending===false&&plain(facts.mode)&&['normal','efficiency','frozen'].includes(facts.mode.state)&&['docs','code','protected'].includes(facts.mode.layer)&&plain(facts.mergeSlot)&&(facts.ownerReview===null||plain(facts.ownerReview))&&Array.isArray(facts.workflowGateFindings)&&facts.workflowGateFindings.length===0,'COMPLETE_NATIVE_GATES_REQUIRED');
 check(typeof facts.modeProofRef==='string'&&facts.modeProofRef.length>0&&typeof facts.observationRef==='string'&&facts.observationRef.length>0&&HASH.test(facts.evaluationSha256??'')&&HASH.test(facts.observationSha256??'')&&fresh(facts,now),'FRESH_NATIVE_OBSERVATION_REQUIRED');
 const {observationSha256,...body}=facts;check(digest(body)===observationSha256,'NATIVE_OBSERVATION_DIGEST_CHANGED');
 if(job.role==='control-merge-slot'){
  check(facts.mergeSlot.state==='held'&&facts.mergeSlot.ref===`merge:${job.repo}:main`&&facts.mergeSlot.tip===job.baseSha&&Date.parse(facts.mergeSlot.until)>now,'LIVE_ACTUAL_MERGE_SLOT_REQUIRED');
  check(facts.mergeQueueHead===true,'ACTUAL_MERGE_QUEUE_HEAD_REQUIRED');
 }
 return facts;
}
function binding(job,packet,facts,authority){return digest({subject:subjectOf(job),pathsSha256:digest(packet.paths),scope:facts.scope,executionPolicy:facts.executionPolicy,mode:facts.mode,mergeSlot:facts.mergeSlot,mergeQueueHead:facts.mergeQueueHead,executionHandoverPending:facts.executionHandoverPending,ownerReview:facts.ownerReview,workflowGateFindings:facts.workflowGateFindings,claimExpiresAt:facts.claimExpiresAt,authority,definition:definitionFor(job)});}
// The durable producer identity excludes renewable lease/slot timestamps.
// Live before/after binding above still includes every one of those facts.
function sourceBinding(job,packet,facts,authority){return digest({subject:subjectOf(job),pathsSha256:digest(packet.paths),scope:facts.scope,executionPolicy:facts.executionPolicy,guarded:facts.guarded,mode:facts.mode,ownerReview:facts.ownerReview,workflowGateFindings:facts.workflowGateFindings,authority,definition:definitionFor(job),slot:job.role==='control-merge-slot'?{state:facts.mergeSlot.state,ref:facts.mergeSlot.ref,tip:facts.mergeSlot.tip,queueHead:facts.mergeQueueHead}:null});}


// This engine is private. The only exported injectable path below is permanently
// fixture-only. The production factory constructs every actual provider itself.
function engine({github,journal,admission,assertLive,record,authority,clock=Date.now},production){
 const domain=production?'production':'fixture';
 async function boundary(job){
  assertLive();const packet=await github.readChangedPaths(job),facts=await admission.evaluatePr(job,packet);assertLive();factsValid(job,packet,facts,domain,clock());
  record('native_check_boundary',{jobId:job.id,nativeObservationSha256:facts.observationSha256,packetSha256:digest(packet)});
  return {facts,bindingSha256:binding(job,packet,facts,authority),sourceBindingSha256:sourceBinding(job,packet,facts,authority)};
 }
 async function inventory(job,externalId){
  const list=await github.readChecks(job.headSha);check(list?.complete===true&&Array.isArray(list.checks)&&list.checks.length<=10000&&new Set(list.checks.map(c=>c?.id)).size===list.checks.length&&list.checks.every(c=>Number.isSafeInteger(c?.id)&&c.id>0&&c.head_sha===job.headSha),'COMPLETE_CHECK_INVENTORY_REQUIRED');
  const matches=list.checks.filter(c=>identity(c,job,externalId));
  if(matches.length===1)check(!list.checks.some(c=>c.app?.id===APP_ID&&c.name===definitionFor(job).name&&c.id>matches[0].id),'NEWER_CONTROL_JUDGEMENT_PRESENT');return matches;
 }
 async function readback(job,externalId,id,conclusion){const matches=await inventory(job,externalId);check(matches.length===1&&matches[0].id===id&&matches[0].status==='completed'&&matches[0].conclusion===conclusion,'NATIVE_CHECK_READBACK_UNCONFIRMED');return matches[0];}
 async function transition(key,phase,next,details){try{return await journal.transition(key,phase,next,details);}catch{return null;}}
 async function revoke({job,key,externalId,known,phase,cause,sideEffects}){
  const revKey=digest({action:'independent-control-revoke',effectKey:key,checkRunId:known.id});let revPhase='intent',logged=false;
  try{const matches=await inventory(job,externalId);check(matches.length===1&&matches[0].id===known.id,'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED');}catch{return {status:'UNCERTAIN',reason:'NEGATIVE_COMPENSATION_IDENTITY_UNCONFIRMED',effectKey:key,sideEffects,productionAuthorized:false,automaticRetryAllowed:false};}
  try{
   const intent=await journal.begin(revKey,{checkRunId:known.id,appId:APP_ID,name:definitionFor(job).name,headSha:job.headSha,externalId});
   if(intent.existing)return {status:'UNCERTAIN',reason:'NEGATIVE_COMPENSATION_RECONCILIATION_REQUIRED',effectKey:key,sideEffects,productionAuthorized:false};
   await journal.transition(revKey,'intent','authorized');revPhase='authorized';await journal.transition(revKey,'authorized','sent');revPhase='sent';logged=true;
  }catch{if(phase!=='sent')return {status:'UNCERTAIN',reason:'NEGATIVE_COMPENSATION_JOURNAL_UNCONFIRMED',effectKey:key,sideEffects,productionAuthorized:false};}
  try{
   // A previously authorized bounded negative compensation may run even when
   // fresh Native denies. Source/Host/principal/Owner acceptance still must live.
   assertLive();sideEffects++;const patched=await github.revokeCheck(known.id,{status:'completed',conclusion:'failure',output:{title:'Independent control authorization changed',summary:`Reconcile Native admission check ${key}; ${cause}. No Native ticket or Receipt is asserted.`}});
   check(identity(patched,job,externalId)&&patched.status==='completed'&&patched.conclusion==='failure','NEGATIVE_COMPENSATION_UNCONFIRMED');await readback(job,externalId,known.id,'failure');
   if(logged)await journal.transition(revKey,'sent','settled',{checkRunId:known.id,conclusion:'failure'});
   const current=await journal.read(key);check(['sent','uncertain','settled'].includes(current?.state),'NEGATIVE_COMPENSATION_STATE_UNCONFIRMED');await journal.transition(key,current.state,'revoked',{checkRunId:known.id,externalId,reason:cause});
   record('native_check_revoked',{jobId:job.id,effectKey:key,checkRunId:known.id,cause});return {status:'REVOKED',effectKey:key,checkRunId:known.id,sideEffects,productionAuthorized:false,automaticRetryAllowed:false};
  }catch{
   if(revPhase==='sent')await transition(revKey,'sent','uncertain',{checkRunId:known.id,reason:'NEGATIVE_COMPENSATION_UNCONFIRMED'});
   if(phase==='sent')await transition(key,'sent','uncertain',{checkRunId:known.id,externalId,reason:'NEGATIVE_COMPENSATION_UNCONFIRMED'});
   return {status:'UNCERTAIN',effectKey:key,checkRunId:known.id,sideEffects,productionAuthorized:false,automaticRetryAllowed:false,reason:'NEGATIVE_COMPENSATION_UNCONFIRMED'};
  }
 }
 return Object.freeze({fixture:!production,async consume(input,selector){
  const job=fixedJob(input);check(exact(selector,['repository','pr','headSha','baseSha','name'])&&selector.repository===job.repo&&selector.pr===job.pr&&selector.headSha===job.headSha&&selector.baseSha===job.baseSha&&selector.name===definitionFor(job).name,'CONTROL_CONSUMER_SUBJECT_REQUIRED');
  const key=digest({action:'independent-control-check',subject:subjectOf(job),definition:definitionFor(job)}),externalId=`independent-ci:control:${job.role}:${job.id}:f${job.fence}:e${job.epoch}:a${job.attempt}`;
  const stored=await journal.read(key);let journalIdentity=false;try{check(stored?.state==='settled'&&stored.subject?.subject&&canonical(stored.subject.subject)===canonical(subjectOf(job))&&canonical(stored.subject.definition)===canonical(definitionFor(job))&&stored.subject.externalId===externalId,'TRUSTED_SETTLED_CONTROL_JOURNAL_REQUIRED');journalIdentity=true;
  const before=await boundary(job);check(stored.details?.sourceBindingSha256===before.sourceBindingSha256,'CONTROL_JOURNAL_AUTHORITY_CHANGED');
  const observed=await readback(job,externalId,stored.details.checkRunId,'success');
  const after=await boundary(job);check(after.bindingSha256===before.bindingSha256,'CONTROL_CONSUMER_AUTHORITY_CHANGED');assertLive();check(fresh(after.facts,clock()),'CONTROL_CONSUMPTION_EXPIRED');
  const proof=freeze({contract:'clued.independent-ci.control-consumption/1',domain,producer:'independent-control-checks-v1',subject:subjectOf(job),definition:definitionFor(job),check:structuredClone(observed),effectKey:key,journalRevision:stored.revision,bindingSha256:after.bindingSha256,sourceBindingSha256:after.sourceBindingSha256,nativeObservationBeforeSha256:before.facts.observationSha256,nativeObservationAfterSha256:after.facts.observationSha256,observedAt:after.facts.observedAt,claimExpiresAt:after.facts.claimExpiresAt,mergeSlot:structuredClone(after.facts.mergeSlot),mergeQueueHead:after.facts.mergeQueueHead,productionAuthorized:production,qualificationIssued:false,nativeTicketIssued:false});
  if(production)actualConsumptions.set(proof,{selector:structuredClone(selector),expiresAt:Math.min(Date.parse(proof.observedAt)+30000,Date.parse(proof.claimExpiresAt),job.role==='control-merge-slot'?Date.parse(proof.mergeSlot.until):Infinity,Date.parse(authority.acceptanceExpiresAt))});
  return proof;
  }catch(error){
   if(journalIdentity&&Number.isSafeInteger(stored.details?.checkRunId)&&stored.details.checkRunId>0)return revoke({job,key,externalId,known:{id:stored.details.checkRunId},phase:'settled',cause:safe(error),sideEffects:0});
   throw error;
  }
 },async publish(input){
  let job,key,externalId,previous,before;
  try{
   job=fixedJob(input);key=digest({action:'independent-control-check',subject:subjectOf(job),definition:definitionFor(job)});externalId=`independent-ci:control:${job.role}:${job.id}:f${job.fence}:e${job.epoch}:a${job.attempt}`;
   previous=await journal.read(key);
   if(previous&&previous.state!=='settled')return {status:previous.state==='revoked'?'REVOKED':'RECONCILIATION_REQUIRED',effectKey:key,sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};
   before=await boundary(job);
   if(previous){check(previous.details?.sourceBindingSha256===before.sourceBindingSha256,'NATIVE_JOURNAL_AUTHORITY_CHANGED');await readback(job,externalId,previous.details.checkRunId,'success');return {status:'SETTLED',effectKey:key,checkRunId:previous.details.checkRunId,sideEffects:0,productionAuthorized:production,automaticRetryAllowed:false};}
  }catch(e){
   if(previous?.state==='settled'&&Number.isSafeInteger(previous.details?.checkRunId)&&previous.details.checkRunId>0)return revoke({job,key,externalId,known:{id:previous.details.checkRunId},phase:'settled',cause:safe(e),sideEffects:0});
   return {status:'BLOCKED',reason:safe(e),sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};
  }
  let phase='intent',sent=false,known=null,sideEffects=0;
  try{
   const intent=await journal.begin(key,{subject:subjectOf(job),definition:definitionFor(job),externalId,observationKind:'actual-native-admission-control',nativeObservationSha256:before.facts.observationSha256,bindingSha256:before.bindingSha256,sourceBindingSha256:before.sourceBindingSha256,compensation:'known-success-one-bounded-negative-patch'});
   if(intent.existing)return {status:'RECONCILIATION_REQUIRED',effectKey:key,sideEffects,productionAuthorized:false,automaticRetryAllowed:false};
   await journal.transition(key,'intent','authorized',{nativeObservationSha256:before.facts.observationSha256});phase='authorized';
   assertLive();check(fresh(before.facts,clock()),'NATIVE_OBSERVATION_EXPIRED_BEFORE_WRITE');
   await journal.transition(key,'authorized','sent',{externalId,nativeObservationSha256:before.facts.observationSha256});phase='sent';sent=true;sideEffects++;
   const posted=await github.createCheck({name:definitionFor(job).name,head_sha:job.headSha,status:'completed',conclusion:'success',external_id:externalId,output:{title:'Complete Native control and exact subject verified',summary:`Independent Native control check for ${REPO}#${job.pr}; observation sha256 ${before.facts.observationSha256}. This is not a scanner execution, Native publication ticket, Receipt or qualification.`}});
   check(identity(posted,job,externalId)&&posted.status==='completed'&&posted.conclusion==='success','NATIVE_CHECK_IDENTITY_UNCONFIRMED');known=posted;
   const after=await boundary(job);check(after.bindingSha256===before.bindingSha256,'NATIVE_AUTHORIZATION_BINDING_CHANGED');await readback(job,externalId,known.id,'success');assertLive();check(fresh(after.facts,clock()),'NATIVE_OBSERVATION_EXPIRED_AFTER_WRITE');
   await journal.transition(key,'sent','settled',{checkRunId:known.id,externalId,conclusion:'success',nativeObservationBeforeSha256:before.facts.observationSha256,nativeObservationAfterSha256:after.facts.observationSha256,bindingSha256:after.bindingSha256,sourceBindingSha256:after.sourceBindingSha256});
   record('native_check_settled',{jobId:job.id,effectKey:key,checkRunId:known.id,beforeSha256:before.facts.observationSha256,afterSha256:after.facts.observationSha256});
   return {status:'SETTLED',effectKey:key,checkRunId:known.id,nativeObservationBeforeSha256:before.facts.observationSha256,nativeObservationAfterSha256:after.facts.observationSha256,sideEffects,productionAuthorized:production,automaticRetryAllowed:false};
  }catch(e){
   if(sent&&!known){try{const matches=await inventory(job,externalId);if(matches.length===1)known=matches[0];}catch{/* Read-only discovery cannot prove a missing POST did not succeed. */}}
   if(sent&&known)return revoke({job,key,externalId,known,phase,cause:safe(e),sideEffects});
   await transition(key,phase,sent?'uncertain':'not_sent',{reason:safe(e),externalId});
   return {status:sent?'UNCERTAIN':'BLOCKED',effectKey:key,reason:safe(e),sideEffects,productionAuthorized:false,automaticRetryAllowed:false};
  }
 }});
}
export function createFixtureControlPublisher(dependencies){return engine(dependencies,false);}

async function withInstalledControl(options,operation){
 let lease=null;
 try{
  check(exact(options,Object.hasOwn(options??{},'signal')?['signal']:[]),'CALLER_NATIVE_CHECK_CAPABILITY_REFUSED');check(process.platform==='win32','FIXED_WINDOWS_NATIVE_CHECK_REQUIRED');
  const [{createFullAdmissionPort},{openHeldSource,takeHeldSource},{validateFormalAcceptance,validateSourcePins},{WINDOWS_ROOT,validateRelayDescriptor}]=await Promise.all([
   import('../full-admission.mjs'),import('../../worker/protected-job-bridge-v2/held-source.mjs'),import('../../worker/protected-job-bridge-v2/boundary.mjs'),import('../../worker/protected-job-bridge-v2/mailbox.mjs')]);
  const {signal}=options;lease=takeHeldSource(await openHeldSource());const held=lease.data;
  const text=name=>new TextDecoder('utf-8',{fatal:true}).decode(held.documents[name]),config=JSON.parse(text('installation.json')),accepted=JSON.parse(text('acceptance.json'));
  const live=()=>{takeHeldSource(lease);check(!signal?.aborted,'NATIVE_CHECK_ABORTED');validateFormalAcceptance(config,accepted,{platform:process.platform,arch:process.arch,hostname:os.hostname(),account:os.userInfo().username});};
  live();check(digest(text('acceptance.json'))===config.acceptanceSha256&&held.expiresAt===accepted.expiresAt,'FORMAL_NATIVE_CHECK_ACCEPTANCE_CHANGED');
  const pins=validateSourcePins(accepted.sourceFiles,REQUIRED_SOURCE_PATHS);check(pins.size===held.sourceHashes.size&&[...pins].every(([p,s])=>held.sourceHashes.get(p)===s),'FORMAL_NATIVE_CHECK_SOURCE_CHANGED');
  check(pins.get('scripts/ci/clued-work-admission.mjs')===config.evaluatorSha256&&pins.get('config/merge-admission-policy.json')===config.policySha256,'FORMAL_NATIVE_EVALUATOR_CHANGED');
  const manifest=JSON.parse(text('source-manifest.json'));check(digest(text('source-manifest.json'))===config.sourceManifestSha256&&manifest.repo===REPO&&Object.keys(CONTROL_CHECKS).every(role=>manifest.roles?.[role]),'FORMAL_NATIVE_CHECK_ROLE_NOT_ACCEPTED');
  for(const role of Object.keys(CONTROL_CHECKS)){const rolePins=validateSourcePins(manifest.roles[role].sourceFiles,REQUIRED_SOURCE_PATHS);check(rolePins.size===pins.size&&[...pins].every(([p,s])=>rolePins.get(p)===s),'FORMAL_NATIVE_CHECK_ROLE_SOURCE_CHANGED');}
  const six={'gitleaks':'gitleaks','trivy':'trivy','work-admission':'kooyumi-work-admission','contract-placement':'contract-placement','control-admission':'kooyumi-admission-verified','control-merge-slot':'kooyumi-merge-slot'};
  check(plain(config.checks)&&Object.keys(config.checks).sort().join('|')===Object.keys(six).sort().join('|')&&Object.entries(six).every(([role,name])=>exact(config.checks[role],['name','appId'])&&config.checks[role].name===name&&config.checks[role].appId===APP_ID),'FORMAL_SIX_CHECK_MAPPING_NOT_ACCEPTED');
  for(const role of Object.keys(CONTROL_CHECKS))validateRelayDescriptor(manifest.roles[role].controllerRelay,accepted);
  const jobFile=path.join(INSTALL_ROOT,'control-check-jobs.json');await assertProtectedPaths(INSTALL_ROOT,[jobFile]);const jobs=JSON.parse(await readProtected(jobFile));
  check(Array.isArray(jobs)&&jobs.length===2&&jobs.every(j=>Object.hasOwn(CONTROL_CHECKS,j?.role))&&new Set(jobs.map(j=>j.role)).size===2,'TWO_FIXED_CONTROL_JOBS_REQUIRED');jobs.forEach(fixedJob);
  check(jobs.every(job=>job.sourceManifestSha256===config.sourceManifestSha256&&['repo','pr','headSha','baseSha','claimId','fence','epoch'].every(k=>job[k]===jobs[0][k])),'FORMAL_CONTROL_JOB_PAIR_CHANGED');const job=jobs[0];
  const acl=fileURLToPath(new URL('../../worker/protected-job-bridge-v2/formal-spool-acl.ps1',import.meta.url));
  for(const target of [WINDOWS_ROOT,path.join(WINDOWS_ROOT,'outgoing')])await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',acl,'-LiteralTarget',target,'-ProtectedRoot',WINDOWS_ROOT,'-AllowControllerWrite'],{windowsHide:true,timeout:10000,maxBuffer:4096});
  live();const keyFile=APP_KEY_FILE,nativeFile=path.join(INSTALL_ROOT,'secrets/ci-admission.token');await assertProtectedPaths(INSTALL_ROOT,[keyFile,nativeFile]);
  const appKey=await readProtected(keyFile,{secret:true,secretRoot:path.dirname(keyFile)}),nativeToken=(await readProtected(nativeFile,{secret:true,secretRoot:path.join(INSTALL_ROOT,'secrets')})).trim();
  check(/^clued_bnd_[A-Za-z0-9_-]{8,480}$/.test(nativeToken)&&digest('clued.independent-ci.ci-binding-pin/1\0'+nativeToken)===accepted.ciTokenPinSha256&&createHash('sha256').update(createPublicKey(appKey).export({type:'spki',format:'der'})).digest('base64')===accepted.appPublicKeySha256Base64,'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED');
  const fetchImpl=(url,opts={})=>{live();return globalThis.fetch(url,{...opts,signal:signal?AbortSignal.any([signal,opts.signal??AbortSignal.timeout(30000)]):(opts.signal??AbortSignal.timeout(30000))});};
  const github=createGitHubChecksPort({repository:REPO,repositoryId:1334673495,appId:APP_ID,installationId:172706661,includeModeRead:true,privateKeyProvider:async()=>appKey,fetchImpl});
  const directory=path.join(WINDOWS_ROOT,'outgoing'),journal=await EffectJournal.open(directory),log=path.join(directory,'observations.jsonl');
  const record=(kind,data)=>{check(/^[a-z][a-z0-9_]{0,79}$/.test(kind),'NATIVE_CHECK_LOG_KIND_REFUSED');const fd=fs.openSync(log,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT,0o600);try{const s=fs.fstatSync(fd);check(s.isFile()&&s.nlink===1&&s.size<67108864,'NATIVE_CHECK_LOG_BOUNDARY');const b=Buffer.from(canonical({contract:'clued.independent-ci.source-observation/1',id:randomUUID(),kind,jobId:data.jobId??job.id,observedAt:new Date().toISOString(),dataSha256:digest(data)})+'\n');check(fs.writeSync(fd,b)===b.length,'NATIVE_CHECK_LOG_UNCONFIRMED');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
  const admission=createFullAdmissionPort({protectedConfig:{...config,domain:'production',workspace:SOURCE_ROOT,policyText:held.policyText},fetchImpl,modeProvider:()=>github.readAdmissionMode(),tokenProvider:async()=>({githubToken:await github.getInstallationToken(),ciAdmissionToken:nativeToken,ciPrincipalBindingId:config.ciPrincipalBindingId,ciPrincipalQualificationRef:config.ciPrincipalQualificationRef}),recorderProvider:async()=>({domain:'production',kind:'independent-controller',observedAt:new Date().toISOString(),observationRef:randomUUID(),recorder:{newId:randomUUID,record}})});
  const authority={acceptanceExpiresAt:accepted.expiresAt,...Object.fromEntries(['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef','ownerPackageAcceptanceRef','installationReceiptRef'].map(k=>[k,accepted[k]]))};
  return await operation(engine({github,journal,admission,assertLive:live,record,authority},true),jobs);
 }catch(e){return {status:'BLOCKED',reason:safe(e),sideEffects:0,productionAuthorized:false,automaticRetryAllowed:false};}
 finally{if(lease)await lease.close();}
}

export async function publishInstalledControlChecks(options={}){
 return withInstalledControl(options,async(publisher,jobs)=>{
  const results=[];for(const role of Object.keys(CONTROL_CHECKS)){const job=jobs.find(j=>j.role===role),result=await publisher.publish(job);results.push({role,...result});if(result.status!=='SETTLED'||result.productionAuthorized!==true)return {status:'BLOCKED_OR_UNCONFIRMED',results,productionAuthorized:false,automaticRetryAllowed:false};}
  return {status:'SETTLED',results,productionAuthorized:true,automaticRetryAllowed:false,qualificationIssued:false,nativeTicketIssued:false};
 });
}
export async function consumeInstalledControlCheck(selector){
 check(exact(selector,['repository','pr','headSha','baseSha','name'])&&selector.repository===REPO&&Number.isSafeInteger(selector.pr)&&selector.pr>0&&/^[a-f0-9]{40}$/.test(selector.headSha??'')&&/^[a-f0-9]{40}$/.test(selector.baseSha??'')&&Object.values(CONTROL_CHECKS).some(d=>d.name===selector.name),'CONTROL_CONSUMER_SUBJECT_REQUIRED');
 return withInstalledControl({},async(publisher,jobs)=>{
  check(exact(selector,['repository','pr','headSha','baseSha','name']),'CONTROL_CONSUMER_SUBJECT_REQUIRED');const job=jobs.find(j=>definitionFor(j).name===selector.name);check(job,'FIXED_CONTROL_CHECK_NAME_REQUIRED');return publisher.consume(job,selector);
 });
}
export function takeActualControlConsumption(value,selector){
 const actual=actualConsumptions.get(value);check(actual&&canonical(actual.selector)===canonical(selector)&&Date.now()<actual.expiresAt&&value.productionAuthorized===true&&value.domain==='production','ACTUAL_CURRENT_CONTROL_CONSUMPTION_REQUIRED');return value;
}

export async function consumeInstalledControlHead(selector){
 check(exact(selector,['repository','headSha','name'])&&selector.repository===REPO&&/^[a-f0-9]{40}$/.test(selector.headSha??'')&&Object.values(CONTROL_CHECKS).some(d=>d.name===selector.name),'CONTROL_HEAD_SELECTOR_REQUIRED');
 return withInstalledControl({},async(publisher,jobs)=>{
  check(exact(selector,['repository','headSha','name']),'CONTROL_HEAD_SELECTOR_REQUIRED');const job=jobs.find(j=>definitionFor(j).name===selector.name);check(job&&job.repo===selector.repository&&job.headSha===selector.headSha,'CONTROL_HEAD_NOT_CURRENT');
  return publisher.consume(job,{repository:job.repo,pr:job.pr,headSha:job.headSha,baseSha:job.baseSha,name:selector.name});
 });
}
