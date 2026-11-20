// Actual immutable production GitHub port and recovery publisher; all HTTP is in RAM.
// Result signatures and effect journal are real; this test never reads a Host secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createGitHubChecksPort } from '../src/github.mjs';
import { bindStagedScanJournal, createRecoverableCheckPublisherV2 } from '../runtime/one-shot-v2.mjs';
import { EffectJournal, rolePublicationKey } from '../src/effect-journal.mjs';
import { createStagedCheckPublisherV2 } from '../src/staged-check-publisher-v2.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2 } from '../src/job-v2.mjs';
import { canonical, digest } from '../src/proof.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { outcomeFailureCode } from '../src/resident-v2/stage-fact.mjs';
import { retainServerAnswerForFacts } from '../src/clock-skew.mjs';
import { HEAD, BASE, fixtureRecord, tempDir, signResult, admittedFacts } from './resident-v2-fixtures.mjs';
const iso=x=>new Date(x).toISOString(),REPO='tdoljyj/cross-memory-system';
const REFS=['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef'];
// Ephemeral test RSA key, only consumed by the real port's local JWT signer.
const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
async function world(t,options={}){
 const t0=Date.now(),time={now:t0},calls={key:0,http:0,create:0,revoke:0,verify:0,evaluate:0};
 const {docs,signer}=fixtureRecord(),record=validateRecordV2(docs,{now:t0});
 const job=batchJobsV2({repo:REPO,pr:888,headSha:HEAD,baseSha:BASE,testSha:HEAD,sourceManifestSha256:'d'.repeat(64),createdAt:iso(t0-60000),attempt:1})[options.role??'gitleaks'];
 const claim={claimId:randomUUID(),fence:3,epoch:1,expiresAt:iso(t0+3600000)};
 const state={exhaust:options.exhaust??0,deny:options.deny??false,admissionDeny:options.admissionDeny??false,live:true,generation:claimGeneration(claim),onExhaust:null};
 const checks=[],events=[],audit=[],trace=[];let id=200;
 const dir=await tempDir(t),journal=await EffectJournal.open(path.join(dir,'effects'));
 const {stagedScanJournal,publisherJournal}=bindStagedScanJournal(()=>journal);
 const reply=body=>({ok:true,status:200,json:async()=>structuredClone(body)});
 const http=async(url,opts)=>{
  calls.http++;const u=new URL(url),method=opts.method;
  if(u.hostname!=='api.github.com')throw Error('unregistered HTTP destination');
  if(u.pathname==='/app')return reply({id:5368905});
  if(u.pathname==='/app/installations/172706661/access_tokens')return reply({token:'offline-fixture-only',expires_at:iso(time.now+3600000),permissions:{checks:'write',contents:'read',pull_requests:'read',actions_variables:'read',environments:'read'}});
  if(u.pathname==='/installation/repositories')return reply({total_count:1,repositories:[{id:1334673495,full_name:REPO}]});
  if(u.pathname===`/repos/${REPO}/pulls/888`){state.onReadPr?.();return reply({number:888,state:'open',changed_files:1,head:{sha:HEAD,repo:{full_name:REPO}},base:{sha:BASE,ref:'main',repo:{full_name:REPO}}});}
  if(u.pathname===`/repos/${REPO}/pulls/888/files`)return reply([{filename:'a.txt',status:'modified'}]);
  if(u.pathname===`/repos/${REPO}/commits/${HEAD}/check-runs`){trace.push('inventory');return reply({total_count:checks.length,check_runs:checks});}
  if(u.pathname===`/repos/${REPO}/check-runs`&&method==='POST'){
   calls.create++;const body=JSON.parse(opts.body);trace.push(['create',body.status,body.conclusion??null]);
   if(state.lostCreate==='absent')throw Error('offline create reply lost');
   const c={id:id++,app:{id:5368905},conclusion:null,...body};checks.push(c);state.onCreate?.(c);
   if(state.lostCreate)throw Error('offline create reply lost');
   return reply(c);
  }
  if(u.pathname.startsWith(`/repos/${REPO}/check-runs/`)&&method==='GET'){
   const id=Number(u.pathname.split('/').at(-1));trace.push(['read',id]);
   if(state.lostSuccess==='unreadable'&&checks.find(c=>c.id===id)?.conclusion==='success')throw Error('offline readback unavailable');
   return reply(checks.find(c=>c.id===id));
  }
  if(u.pathname.startsWith(`/repos/${REPO}/check-runs/`)&&method==='PATCH'){
   const id=Number(u.pathname.split('/').at(-1)),body=JSON.parse(opts.body);
   trace.push(['patch',id,body.conclusion]);
   if(body.conclusion==='failure'){calls.revoke++;if(state.failCleanup)throw Error('offline cleanup unavailable');}
   if(body.conclusion==='success'&&state.lostSuccess==='pending')throw Error('offline success reply lost');
   const c=checks.find(c=>c.id===id);Object.assign(c,body);
   if(body.conclusion==='success'&&state.lostSuccess)throw Error('offline success reply lost');
   return reply(c);
  }
  throw Error('unregistered HTTP route');
 };
 const github=createGitHubChecksPort({repository:REPO,repositoryId:1334673495,appId:5368905,installationId:172706661,includeModeRead:true,clock:()=>time.now,
  privateKeyProvider:async()=>{calls.key++;return rsa;},fetchImpl:http,sleep:async ms=>{time.now+=ms;},stagedScanJournal});
 const descriptor=Object.getOwnPropertyDescriptor(github,'readPullRequest');assert.equal(Object.isFrozen(github),true);assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);
 const originalRead=github.readPullRequest;
 const context={nonce:randomUUID().replaceAll('-',''),stage:{gitleaks:3,trivy:5,'contract-placement':7}[job.role],entryRole:'check-publisher',batchKey:digest('offline-batch'),configSha256:digest('offline-config'),sourceManifestSha256:job.sourceManifestSha256,acceptanceSha256:record.hashes.acceptanceSha256,entrySha256:digest('offline-entry')};
 const nativeFetch=async(_url,opts)=>{
  calls.verify++;
  trace.push('observe');
  if(state.exhaust>0){state.exhaust--;time.now+=opts.signal.testTimeout;if(state.exhaust===0)await state.onExhaust?.();throw new DOMException('timeout','TimeoutError');}
  const epoch=state.observedEpoch??claim.epoch;
  return {status:200,json:async()=>({status:'ok',verdict:state.deny?'REFUSED':'ADMITTED',execution_policy:options.observedPolicy??'staged',current_fence:claim.fence,execution_epoch:epoch,paths_outside_write_set:[],verified_at:iso(time.now),
   claim:{claim_id:claim.claimId,context_key:record.config.scope,fence:claim.fence,execution_epoch:epoch,status:'ACTIVE',lease_key_required:false,execution_handover_pending:false,expires_at:claim.expiresAt}})};
 };
 const publisherOptions={domain:'production',requireVerifyFirst:true,github,journal:publisherJournal,signers:record.signers,configuredChecks:record.config.checks,readChangedPaths:j=>github.readChangedPaths(j),batchClaim:claimGeneration(claim),
  nativeAdmission:{async evaluatePr(j,packet,opts){
   calls.evaluate++;trace.push('evaluate');
   if(state.admissionDeny)return {contract:'clued.independent-ci.full-admission/2',status:'BLOCKED',admitted:false,reason:'full_admission_rejected'};
   const facts=admittedFacts(j,claim,packet,{batchClaim:opts.batchClaim,observedAt:time.now,slotUntil:t0+3600000});
   if(options.evaluatedPolicy==='active'){
    Object.assign(facts,{contract:'clued.independent-ci.full-admission/3',executionPolicy:'active',publicationRequired:true,headAuthorizationId:null});
    const {observationSha256,...fields}=facts;facts.observationSha256=digest(fields);
   }
   retainServerAnswerForFacts(facts,{verifiedAt:iso(time.now),expiresAt:claim.expiresAt,sentMono:time.now-t0},()=>time.now-t0);
   return state.onEvaluate?.() ?? facts;
  }},
  protectedDeployment:{enabled:true,domain:'production',repository:REPO,ciPrincipalBindingId:record.config.ciPrincipalBindingId,...Object.fromEntries(REFS.map(k=>[k,record.accepted[k]]))}};
 const publisher=createRecoverableCheckPublisherV2({recoveryContext:context,
  // Pure RAM descriptor only. Unchanged production writer fsync/readback is covered
  // by the retained publication-recovery suite; this does not claim Host persistence.
  auditWriter:r=>{audit.push(structuredClone(r));const bytes=Buffer.from(canonical(r)+'\n');return {fileName:`publication-recovery-${r.context.nonce}-${r.job.id}-${r.kind}.json`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};},
  authorityOptions:{config:record.config,accepted:record.accepted,nativeToken:'offline-fixture-only',fetchImpl:nativeFetch,sleep:async ms=>{time.now+=ms;},timeoutSignal:ms=>({testTimeout:ms})},
  readCurrentBatchClaim:async()=>state.generation,live:()=>{if(!state.live)throw Error('offline-live-ended');},log:(kind,data)=>events.push({kind,data}),clock:()=>time.now,monotonic:()=>time.now-t0,
  publisherOptions});
 assert.deepEqual(calls,{key:0,http:0,create:0,revoke:0,verify:0,evaluate:0});
 const input={job,envelope:signResult(job,signer,{domain:'production',startedAt:t0-5000,finishedAt:t0-1000})};
 return {publisher,publisherOptions,input,job,journal,publisherJournal,github,originalRead,descriptor,calls,state,checks,events,audit,time,t0,trace,key:scanEffectKeyV2(job,record.config.checks[job.role])};
}

const writes = w => w.trace.filter(x=>Array.isArray(x)&&x[0]!=='read');
const stageCode = result => outcomeFailureCode({...result,mayHavePublished:result.sideEffects>0},3);

test('production scanner refuses active execution before any journal or GitHub write',async t=>{
 for(const options of [{observedPolicy:'active',evaluatedPolicy:'active'},{evaluatedPolicy:'active'}]){
  const w=await world(t,options);const r=await w.publisher.publish(w.input);
  assert.deepEqual(writes(w),[]);
  assert.deepEqual(await fs.readdir(w.journal.directory),[]);
  assert.equal(w.calls.evaluate,options.observedPolicy==='active'?0:1);
  assert.equal(r.status,'BLOCKED');assert.equal(r.sideEffects,0);
  assert.equal(r.reason,'staged_scan_execution_policy_required');
 }
});

test('production publisher requires all three completion authority methods',async t=>{
 const w=await world(t);
 const authority={observe(){assert.fail('incomplete completion authority must be refused before observation');},
  monotonicMs(){return 0;},recheckBatchClaim(){},assertCompletionWindow(){}};
 for(const method of ['monotonicMs','recheckBatchClaim','assertCompletionWindow']){
  const publisher=createStagedCheckPublisherV2({...w.publisherOptions,authority:{...authority,[method]:undefined}});
  assert.deepEqual(await publisher.publish(w.input),{status:'BLOCKED',reason:'staged_publisher_not_configured',sideEffects:0,productionAuthorized:false});
 }
});

test('staged: creates pending, evaluates again, then sends one success PATCH',async t=>{
 for(const role of ['gitleaks','trivy','contract-placement']){
  const w=await world(t,{role});const r=await w.publisher.publish(w.input);
  assert.deepEqual(writes(w),[['create','in_progress',null],['patch',200,'success']]);
  assert.ok(w.trace.lastIndexOf('evaluate')>w.trace.findIndex(x=>x[0]==='create'));
  assert.ok(w.trace.lastIndexOf('evaluate')<w.trace.findIndex(x=>x[0]==='patch'));
  assert.equal(r.status,'SETTLED');assert.equal(r.checkRunId,200);
 }
});

test('staged: failed verification attempts cleanup without halting even if cleanup fails',async t=>{
 for(const failCleanup of [false,true]){
  const w=await world(t);w.state.onCreate=()=>{w.state.admissionDeny=true;};w.state.failCleanup=failCleanup;
  const r=await w.publisher.publish(w.input);
  assert.deepEqual(writes(w),[['create','in_progress',null],['patch',200,'failure']]);
  assert.equal(w.checks[0].conclusion,failCleanup?null:'failure');
  assert.equal(stageCode(r),'PUBLICATION_REVOKED');
 }
});

test('staged: lost success reply reads only that ID and never resends',async t=>{
 for(const lostSuccess of ['applied','pending','unreadable']){
  const w=await world(t);w.state.lostSuccess=lostSuccess;const r=await w.publisher.publish(w.input);
  assert.deepEqual(writes(w).slice(0,2),[['create','in_progress',null],['patch',200,'success']]);
  const after=w.trace.slice(w.trace.findIndex(x=>x[0]==='patch')+1);
  assert.deepEqual(after,lostSuccess==='applied'?[['read',200]]
   :lostSuccess==='pending'?[['read',200],['read',200],['patch',200,'failure']]:[['read',200],['read',200]]);
  if(lostSuccess==='unreadable')assert.equal(w.checks[0].conclusion,'success');
  assert.equal(r.status,lostSuccess==='applied'?'SETTLED':'STAGED_SCAN_FAILED');
 }
});

test('staged: ambiguous create ends cleanly with no possible success',async t=>{
 for(const lostCreate of ['absent','pending']){
  const w=await world(t);w.state.lostCreate=lostCreate;const r=await w.publisher.publish(w.input);
  assert.equal(stageCode(r),'PUBLICATION_REVOKED');
  assert.equal(writes(w)[0][1],'in_progress');
  assert.equal(w.checks.some(c=>c.conclusion==='success'),false);
 }
});

test('staged: stale evidence is fully re-evaluated once and still too little time fails cleanly',async t=>{
 const w=await world(t);
 w.state.onEvaluate=()=>{if(w.calls.evaluate>1)w.time.now+=28_001;};
 const r=await w.publisher.publish(w.input);
 assert.equal(w.calls.evaluate,3);
 assert.equal(w.calls.verify,5);
 assert.deepEqual(writes(w),[['create','in_progress',null],['patch',200,'failure']]);
 assert.equal(r.reason,'staged_scan_verification_aged');
 assert.equal(stageCode(r),'PUBLICATION_REVOKED');
});

test('staged: a 25-second evaluation completes with freshly reobserved protected facts',async t=>{
 const w=await world(t);
 // Charge four seconds only once, to the PR read after the first completion observation.
 w.state.onCreate=()=>{w.state.onReadPr=()=>{
  if(w.calls.verify!==2)return;
  w.time.now+=4_000;
  w.state.onReadPr=null;
 };};
 w.state.onEvaluate=()=>{if(w.calls.evaluate>1)w.time.now+=25_000;};
 const r=await w.publisher.publish(w.input);
 assert.equal(r.status,'SETTLED',r.reason);
 assert.equal(w.calls.evaluate,2);
 assert.deepEqual(w.trace.slice(w.trace.lastIndexOf('evaluate')),['evaluate','observe',['read',200],['patch',200,'success'],['read',200]]);
});

test('staged: a different claim generation on reobservation refuses success',async t=>{
 const w=await world(t);
 w.state.onEvaluate=()=>{if(w.calls.evaluate>1)w.state.observedEpoch=2;};
 const r=await w.publisher.publish(w.input);
 assert.equal(r.status,'STAGED_SCAN_FAILED');
 assert.deepEqual(writes(w),[['create','in_progress',null],['patch',200,'failure']]);
});

test('staged: Native observation expiry triggers a full re-evaluation before success',async t=>{
 const w=await world(t);
 w.state.onEvaluate=()=>w.calls.evaluate===2?{contract:'clued.independent-ci.full-admission/2',status:'BLOCKED',
  admitted:false,reason:'full_admission_observation_expired'}:undefined;
 const r=await w.publisher.publish(w.input);
 assert.equal(w.calls.evaluate,3);
 assert.equal(r.status,'SETTLED');
 assert.deepEqual(writes(w),[['create','in_progress',null],['patch',200,'success']]);
});

test('staged: written intent without a sent record fails cleanly, while a mismatched journal stops',async t=>{
 for(const mismatch of [false,true]){
  const w=await world(t),transition=w.journal.transition.bind(w.journal);
  w.journal.transition=async (key,phase,next,details)=>{
   if(key!==w.key||next!=='sent')return transition(key,phase,next,details);
   if(mismatch)await transition(key,phase,next,{externalId:'independent-ci:foreign'});
   throw Error('offline transition reply lost');
  };
  const r=await w.publisher.publish(w.input);
  assert.equal(stageCode(r),mismatch?'PUBLICATION_UNCERTAIN':'PUBLICATION_BLOCKED');
  assert.deepEqual(writes(w),[]);
 }
 assert.equal(outcomeFailureCode(null,3),'STAGE_OUTCOME_MISSING');
});

test('staged: a read I/O error blocks cleanly, while a corrupt effect or role lock halts',async t=>{
 for(const roleLock of [false,true]){
  for(const corrupt of [false,true]){
   const w=await world(t);
   const key=roleLock?rolePublicationKey({repo:REPO,headSha:HEAD,role:w.job.role,checkName:'gitleaks',appId:5368905}):w.key;
   if(corrupt)await fs.writeFile(w.journal.file(key),'{');
   else{
    const read=w.journal.read.bind(w.journal);
    w.journal.read=async k=>{if(k===key)throw Object.assign(Error('offline read failure'),{code:'EIO'});return read(k);};
   }
   const r=await w.publisher.publish(w.input);
   assert.equal(stageCode(r),corrupt?'PUBLICATION_UNCERTAIN':'PUBLICATION_BLOCKED');
   assert.equal(r.sideEffects,0);
   assert.deepEqual(writes(w),[]);
  }
 }
});

test('staged: the real completion port rejects other IDs, completed runs and a second success',async t=>{
 for(const actualStatus of ['in_progress','completed']){
  const w=await world(t),id=211,externalId=`independent-ci:staged:v2:${w.job.id}:a1`;
  const output={title:'gitleaks: in progress',summary:'fixture evidence'};
  const details={checkRunId:id,conclusion:'success',output};
  await w.journal.begin(w.key,{stagedScan:true,subject:{repo:REPO,headSha:HEAD,role:'gitleaks'},definition:{appId:5368905,name:'gitleaks'},externalId});
  await w.journal.transition(w.key,'intent','authorized');
  await w.journal.transition(w.key,'authorized','sent');
  await w.publisherJournal.transition(w.key,'sent','created',details);
  const otherKey=digest('other invocation');
  await w.journal.begin(otherKey,(await w.journal.read(w.key)).subject);
  await w.journal.transition(otherKey,'intent','authorized');
  await w.journal.transition(otherKey,'authorized','sent');
  await w.journal.transition(otherKey,'sent','created',{...details,checkRunId:id+1});
  w.checks.push({id,app:{id:5368905},head_sha:HEAD,name:'gitleaks',external_id:externalId,status:actualStatus,
   conclusion:actualStatus==='completed'?'success':null,output:actualStatus==='completed'?{...output,title:'gitleaks: success'}:output});
  const verify=async()=>()=>{};
  await assert.rejects(w.github.completeStagedScan(otherKey,id+1,verify),{code:'staged_scan_journal_conflict'});
  await assert.rejects(w.github.completeStagedScan(w.key,id+1,verify),{code:'staged_scan_journal_conflict'});
  assert.deepEqual(w.trace,[]);
  if(actualStatus==='completed'){
   await assert.rejects(w.github.completeStagedScan(w.key,id,verify),{code:'staged_scan_completion_refused'});
   assert.deepEqual(writes(w),[]);
  }else{
   await w.github.completeStagedScan(w.key,id,verify);
   await assert.rejects(w.github.completeStagedScan(w.key,id,verify),{code:'staged_scan_completion_refused'});
   assert.deepEqual(writes(w),[['patch',id,'success']]);
  }
 }
});
test('real frozen production port constructs and normal signed publication settles once',async t=>{
 const w=await world(t);const r=await w.publisher.publish(w.input);assert.equal(r.status,'SETTLED');assert.equal(w.calls.create,1);assert.equal(w.checks.length,1);assert.equal((await w.journal.read(w.key)).state,'settled');
 assert.equal(Object.isFrozen(w.github),true);assert.equal(w.github.readPullRequest,w.originalRead);assert.deepEqual(Object.getOwnPropertyDescriptor(w.github,'readPullRequest'),w.descriptor);
 const before={...w.calls};const repeat=await w.publisher.publish(w.input);assert.equal(repeat.status,'UNCERTAIN');assert.equal(repeat.reason,'publication_recovery_reentry_refused');assert.deepEqual(w.calls,before);
});
test('real frozen production port first observation exhausts then recovers inside one role and posts once',async t=>{
 const w=await world(t,{exhaust:3});const r=await w.publisher.publish(w.input);assert.equal(r.status,'SETTLED');assert.equal(w.calls.create,1);assert.equal(w.checks.length,1);assert.equal(w.audit.length,2);assert.equal(w.audit[0].kind,'intent');assert.equal(w.audit[1].kind,'result');assert.equal(w.audit[1].counters.publisherAttempts,2);
 assert.equal(w.audit[0].clock.monotonicAnchorMs,w.audit[1].clock.monotonicAnchorMs);assert.equal(w.audit[0].clock.deadlineMonotonicMs,w.audit[1].clock.deadlineMonotonicMs);assert.ok(w.time.now-w.t0<=60000);assert.equal((await w.journal.read(w.key)).state,'settled');
});
test('real frozen production port verified Native denial never recovers or writes a check',async t=>{
 const w=await world(t,{deny:true});const r=await w.publisher.publish(w.input);assert.equal(r.status,'BLOCKED');assert.equal(r.reason,'native_claim_observation_refused');assert.equal(w.calls.verify,1);assert.equal(w.calls.evaluate,0);assert.equal(w.calls.create,0);assert.equal(w.audit.length,0);assert.equal(await w.journal.read(w.key),null);
});
test('real frozen production port drift after exhaustion refuses recovery with no Check',async t=>{
 const w=await world(t,{exhaust:3});w.state.onExhaust=()=>{w.state.generation={...w.state.generation,epoch:2};};const r=await w.publisher.publish(w.input);assert.equal(r.status,'UNCERTAIN');assert.equal(r.reason,'publication_recovery_unconfirmed');assert.equal(w.calls.verify,3);assert.equal(w.calls.create,0);assert.equal(w.audit.length,0);assert.equal(await w.journal.read(w.key),null);
});
test('real frozen production port full evaluator denial is sticky and cannot recover into publication',async t=>{
 const w=await world(t,{admissionDeny:true});const r=await w.publisher.publish(w.input);assert.equal(r.status,'BLOCKED');assert.equal(w.calls.evaluate,1);assert.equal(w.calls.create,0);assert.equal(w.audit.length,0);
});
test('adapter retains the original frozen port even if its caller later replaces the options property',async t=>{
 const w=await world(t);w.publisherOptions.github={readPullRequest:()=>{throw Error('replacement must not be used');}};const r=await w.publisher.publish(w.input);assert.equal(r.status,'SETTLED');assert.equal(w.calls.create,1);assert.equal(Object.isFrozen(w.github),true);assert.equal(w.github.readPullRequest,w.originalRead);
});
