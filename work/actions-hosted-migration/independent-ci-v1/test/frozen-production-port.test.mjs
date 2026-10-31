// Actual immutable production GitHub port and recovery publisher; all HTTP is in RAM.
// Result signatures and effect journal are real; this test never reads a Host secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createGitHubChecksPort } from '../src/github.mjs';
import { createRecoverableCheckPublisherV2 } from '../runtime/one-shot-v2.mjs';
import { EffectJournal } from '../src/effect-journal.mjs';
import { batchJobsV2, claimGeneration, scanEffectKeyV2 } from '../src/job-v2.mjs';
import { canonical, digest } from '../src/proof.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { HEAD, BASE, fixtureRecord, tempDir, signResult, admittedFacts } from './resident-v2-fixtures.mjs';
const iso=x=>new Date(x).toISOString(),REPO='tdoljyj/cross-memory-system';
const REFS=['sourceAcceptanceRef','hostQualificationRef','ownerAuthorizationRef','publisherQualificationRef','ciPrincipalQualificationRef'];
// Ephemeral test RSA key, only consumed by the real port's local JWT signer.
const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
async function world(t,options={}){
 const t0=Date.now(),time={now:t0},calls={key:0,http:0,create:0,revoke:0,verify:0,evaluate:0};
 const {docs,signer}=fixtureRecord(),record=validateRecordV2(docs,{now:t0});
 const job=batchJobsV2({repo:REPO,pr:888,headSha:HEAD,baseSha:BASE,testSha:HEAD,sourceManifestSha256:'d'.repeat(64),createdAt:iso(t0-60000),attempt:1}).gitleaks;
 const claim={claimId:randomUUID(),fence:3,epoch:1,expiresAt:iso(t0+3600000)};
 const state={exhaust:options.exhaust??0,deny:options.deny??false,admissionDeny:options.admissionDeny??false,live:true,generation:claimGeneration(claim),onExhaust:null};
 const checks=[],events=[],audit=[];let id=200;
 const reply=body=>({ok:true,status:200,json:async()=>structuredClone(body)});
 const http=async(url,opts)=>{
  calls.http++;const u=new URL(url),method=opts.method;
  if(u.hostname!=='api.github.com')throw Error('unregistered HTTP destination');
  if(u.pathname==='/app')return reply({id:5368905});
  if(u.pathname==='/app/installations/172706661/access_tokens')return reply({token:'offline-fixture-only',expires_at:iso(time.now+3600000),permissions:{checks:'write',contents:'read',pull_requests:'read',actions_variables:'read',environments:'read'}});
  if(u.pathname==='/installation/repositories')return reply({total_count:1,repositories:[{id:1334673495,full_name:REPO}]});
  if(u.pathname===`/repos/${REPO}/pulls/888`)return reply({number:888,state:'open',changed_files:1,head:{sha:HEAD,repo:{full_name:REPO}},base:{sha:BASE,ref:'main',repo:{full_name:REPO}}});
  if(u.pathname===`/repos/${REPO}/pulls/888/files`)return reply([{filename:'a.txt',status:'modified'}]);
  if(u.pathname===`/repos/${REPO}/commits/${HEAD}/check-runs`)return reply({total_count:checks.length,check_runs:checks});
  if(u.pathname===`/repos/${REPO}/check-runs`&&method==='POST'){
   calls.create++;const c={id:id++,app:{id:5368905},...JSON.parse(opts.body)};checks.push(c);return reply(c);
  }
  if(u.pathname.startsWith(`/repos/${REPO}/check-runs/`)&&method==='PATCH'){
   calls.revoke++;const c=checks.find(c=>c.id===Number(u.pathname.split('/').at(-1)));Object.assign(c,JSON.parse(opts.body));return reply(c);
  }
  throw Error('unregistered HTTP route');
 };
 const github=createGitHubChecksPort({repository:REPO,repositoryId:1334673495,appId:5368905,installationId:172706661,includeModeRead:true,clock:()=>time.now,
  privateKeyProvider:async()=>{calls.key++;return rsa;},fetchImpl:http,sleep:async ms=>{time.now+=ms;}});
 const descriptor=Object.getOwnPropertyDescriptor(github,'readPullRequest');assert.equal(Object.isFrozen(github),true);assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);
 const originalRead=github.readPullRequest;
 const dir=await tempDir(t),journal=await EffectJournal.open(path.join(dir,'effects'));
 const context={nonce:randomUUID().replaceAll('-',''),stage:3,entryRole:'check-publisher',batchKey:digest('offline-batch'),configSha256:digest('offline-config'),sourceManifestSha256:job.sourceManifestSha256,acceptanceSha256:record.hashes.acceptanceSha256,entrySha256:digest('offline-entry')};
 const nativeFetch=async(_url,opts)=>{
  calls.verify++;
  if(state.exhaust>0){state.exhaust--;time.now+=opts.signal.testTimeout;if(state.exhaust===0)await state.onExhaust?.();throw new DOMException('timeout','TimeoutError');}
  return {status:200,json:async()=>({status:'ok',verdict:state.deny?'REFUSED':'ADMITTED',execution_policy:'staged',current_fence:claim.fence,execution_epoch:claim.epoch,paths_outside_write_set:[],verified_at:iso(time.now),
   claim:{claim_id:claim.claimId,context_key:record.config.scope,fence:claim.fence,execution_epoch:claim.epoch,status:'ACTIVE',lease_key_required:false,execution_handover_pending:false,expires_at:claim.expiresAt}})};
 };
 const publisherOptions={domain:'production',github,journal,signers:record.signers,configuredChecks:record.config.checks,readChangedPaths:j=>github.readChangedPaths(j),batchClaim:claimGeneration(claim),
  nativeAdmission:{async evaluatePr(j,packet,opts){calls.evaluate++;if(state.admissionDeny)return {contract:'clued.independent-ci.full-admission/2',status:'BLOCKED',admitted:false,reason:'full_admission_rejected'};return admittedFacts(j,claim,packet,{batchClaim:opts.batchClaim,observedAt:time.now,slotUntil:t0+3600000});}},
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
 return {publisher,publisherOptions,input,job,journal,github,originalRead,descriptor,calls,state,checks,events,audit,time,t0,key:scanEffectKeyV2(job,record.config.checks.gitleaks)};
}
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
