import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {registerIndependentController,observeIndependentControllerStop,revokeIndependentPublications} from './clued-independent-revoker.mjs';
import {makeIndependentPublicationIdentity} from './clued-independent-publication-identity.mjs';
import {independentControllerId} from './clued-independent-publication-port.mjs';
import {createIndependentPublicationRuntime} from './clued-independent-publication-runtime.mjs';
import {makeJobV2} from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import {EffectJournal} from '../../work/actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import {canonical,digest} from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import {validateRecordV2} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/record.mjs';
import {ENTRY_V2,OUTCOME_CONTRACT} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/layout.mjs';
import {PLAN_CONTRACT_V2} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-package.mjs';
import {NATIVE_RECEIPT_CONTRACT_V2} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import {BROKER_RESPONSE_CONTRACT,BROKER_REQUEST_CONTRACT} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/broker-protocol.mjs';
import {fixtureRecord,tempDir,subject} from '../../work/actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';
const bytes=value=>Buffer.from(canonical(value));
async function fixture(t){
 const {docs}=fixtureRecord(),record=validateRecordV2(docs,{now:Date.now()}),nonce='a'.repeat(32);
 const job=makeJobV2({...subject(),sourceManifestSha256:record.config.sourceManifestSha256,role:'gitleaks'});
 const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:randomUUID(),fence:4,execution_epoch:3},
  controller_id:independentControllerId({invocationNonce:nonce,jobId:job.id,nodeId:record.accepted.node.hostname})});
 const jobs=[job],plan={contract:PLAN_CONTRACT_V2,enabled:true,stage:3,entryRole:'check-publisher',batchKey:'b'.repeat(64),batchId:'b'.repeat(16)+'-'+'c'.repeat(12),
  ownerPackageAcceptanceRef:record.accepted.ownerPackageAcceptanceRef,nodeSha256:record.config.controllerNodeSha256,nodeProfileSha256:digest(record.accepted.node),
  entrySha256:record.pins.get(ENTRY_V2['check-publisher']),acceptanceSha256:record.hashes.acceptanceSha256,sourceManifestSha256:job.sourceManifestSha256,
  installationSha256:record.hashes.installationSha256,runtimeConfigPinSha256:record.hashes.runtimeConfigPinSha256,jobSha256:digest(jobs)};
 const args={nonce,configSha256:digest(plan)},journal=await EffectJournal.open(path.join(await tempDir(t),'effects'));
 const witness=await registerIndependentController({identity,journal,args,plan,record});
 const outcome={contract:OUTCOME_CONTRACT,nonce,stage:3,entryRole:'check-publisher',status:'BLOCKED',reason:'authorization_changed',sideEffects:0,mayHavePublished:false,jobIds:[job.id]};
 const requestId=randomUUID(),bundle={requestId,planBytes:bytes(plan),jobsBytes:bytes(jobs),
  requestBytes:bytes({contract:BROKER_REQUEST_CONTRACT,stage:3,nonce,configSha256:args.configSha256,deadline:new Date().toISOString()}),
  responseBytes:bytes({contract:BROKER_RESPONSE_CONTRACT,requestId,ok:true,code:null,started:true,startCallIssued:true,helperPid:31337,
   stoppedInTime:true,restored:true,accountUnchanged:true,stableBefore:true,stableAfter:true,configurationConflict:false}),
  outcomeBytes:bytes(outcome),receiptBytes:bytes({contract:NATIVE_RECEIPT_CONTRACT_V2,nonce,state:'FIXED_CHILD_REFUSED',failure_code:'FIXED_NODE_EXIT_NONZERO',
   actual_sid:record.accepted.node.controllerSid,service_pid:31337,session_id:0,node_pid:31338,node_exit_code:2,timed_out:false,stop_requested:false,
   tree_cleanup_confirmed:true,tree_cleanup_failure_code:null,tree_active_processes:0,root_exit_confirmed:true,entry_role:plan.entryRole,stage:3,
   entry_sha256:plan.entrySha256,config_sha256:args.configSha256,acceptance_sha256:plan.acceptanceSha256,source_manifest_sha256:plan.sourceManifestSha256,
   outcome_sha256:digest(outcome),stdout_captured:false,private_bytes_read_by_helper:false,host_qualification:false,ci_principal_qualification:false})};
 const pub=randomUUID(),receipt=randomUUID(),calls=[],checks=[];let posts=0,patches=0,hide=false,losePost=false,loseBegin=false;
 const native={async command(input){calls.push(input);
  if(input.action==='publication_begin_independent'){
   if(loseBegin)throw Error('lost begin response');
   return {status:'ok',verdict:'ADMITTED',execution_policy:'active',execution_authorized:true,publication_required:true,publication_id:pub,receipt_id:receipt,independent_identity:identity};
  }if(input.action==='publication_abort_independent')return {status:'committed',publication_id:pub,receipt_id:receipt};
  return {status:'committed',receipt_id:receipt,must_revoke:input.action==='publication_reconcile'};
 }};
 const github={async createCheck(payload){posts++;const check={...structuredClone(payload),id:101,app:{id:5368905}};checks.push(check);if(losePost)throw Error('lost POST response');return structuredClone(check);},
  async readCheck(id){return structuredClone(checks.find(c=>c.id===id));},
  async readChecks(){return {complete:true,checks:hide?[]:structuredClone(checks)};},
  async revokeCheck(id,body){patches++;const check=checks.find(c=>c.id===id);Object.assign(check,structuredClone(body));return structuredClone(check);}};
 const runtime=createIndependentPublicationRuntime({native,journal,assertCurrent:async()=>true,github:{...github,readChecks:async()=> (await github.readChecks()).checks}});
 const input={identity,scope:record.config.scope,paths:['scripts/ci/test.mjs'],payload:{name:'gitleaks',head_sha:job.headSha,status:'completed',conclusion:'success',
  external_id:`independent-ci:staged:v2:${job.id}:a1`,output:{title:'success',summary:'proof'}}};
 const publication={publication_id:pub,started_receipt_id:receipt,run_id:null,repository:job.repo,head_sha:job.headSha,pr_ref:`${job.repo}#${job.pr}`,
  claim_id:identity.claim.claim_id,execution_epoch:identity.claim.execution_epoch,independent_identity:identity};
 const revoke=(stopBundle=bundle,rows=[publication])=>revokeIndependentPublications({scope:record.config.scope,publications:rows,native,github,
  journalFor:async()=>journal,supervisor:{async readProtectedStopBundle(){return stopBundle;}}});
 return {identity,journal,witness,bundle,runtime,input,calls,publication,revoke,setHide:v=>hide=v,setLosePost:v=>losePost=v,setLoseBegin:v=>loseBegin=v,
  get posts(){return posts;},get patches(){return patches;}};
}
test('physical stop is bound to the exact broker/helper, accepted Source, jobs and outcome bytes',async t=>{
 const f=await fixture(t),stopped=observeIndependentControllerStop(f.identity,f.witness,f.bundle);
 assert.equal(stopped.stopped,true);assert.equal(stopped.controller_id,f.identity.controller_id);assert.match(stopped.proofRef,/^sha256:[a-f0-9]{64}$/);
});
test('stale process, running descendants, replaced input or incomplete outcome cannot prove stop',async t=>{
 const f=await fixture(t);
 for(const [file,edit] of [['receiptBytes',v=>v.tree_active_processes=1],['receiptBytes',v=>v.root_exit_confirmed=false],
  ['receiptBytes',v=>v.service_pid++],['receiptBytes',v=>v.actual_sid='other'],['responseBytes',v=>v.stoppedInTime=false],
  ['requestBytes',v=>v.nonce='b'.repeat(32)],['jobsBytes',v=>v[0].headSha='f'.repeat(40)],['outcomeBytes',v=>v.jobIds=[]]]){
  const bundle={...f.bundle},value=JSON.parse(bundle[file]);edit(value);bundle[file]=bytes(value);
  assert.throws(()=>observeIndependentControllerStop(f.identity,f.witness,bundle),undefined,file);
 }
});
test('a proven stopped never-sent publisher aborts its original ticket without a GitHub write or outbox ACK',async t=>{
 const f=await fixture(t);await f.runtime.prepare(f.input);const result=await f.revoke();
 assert.deepEqual(result,{reconciled:0,notSent:1,pending:[]});assert.equal(f.posts,0);assert.equal(f.patches,0);
 assert.equal(f.calls.at(-1).action,'publication_abort_independent');assert.equal(f.calls.some(c=>c.action==='revocations_ack'),false);
});
test('a cancellation request without a bound physical cleanup observation leaves the original ticket pending',async t=>{
 const f=await fixture(t);await f.runtime.prepare(f.input);const result=await f.revoke({...f.bundle,receiptBytes:new Uint8Array()});
 assert.equal(result.pending.length,1);assert.equal(f.calls.length,1);assert.equal(f.posts,0);
});
test('an invisible uncertain POST stays open; discovery revokes the same check once without rePOST',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(f.input);f.setLosePost(true);await assert.rejects(()=>f.runtime.createCheck(handle));f.setHide(true);
 assert.equal((await f.revoke()).pending.length,1);assert.equal(f.calls.some(c=>['publication_reconcile','publication_abort_independent'].includes(c.action)),false);
 f.setHide(false);assert.deepEqual(await f.revoke(),{reconciled:1,notSent:0,pending:[]});assert.equal(f.posts,1);assert.equal(f.patches,1);
 assert.equal(f.calls.at(-1).action,'publication_reconcile');
});
test('a lost begin response adopts the real server ticket before a stopped no-POST abort',async t=>{
 const f=await fixture(t);f.setLoseBegin(true);await assert.rejects(()=>f.runtime.prepare(f.input));
 assert.deepEqual(await f.revoke(),{reconciled:0,notSent:1,pending:[]});assert.equal(f.posts,0);
 assert.equal(f.calls.filter(c=>c.action==='publication_begin_independent').length,1);
});
test('another publication, claim generation or Actions provider cannot reconcile the independent journal',async t=>{
 const f=await fixture(t);await f.runtime.prepare(f.input);
 for(const change of [p=>p.publication_id=randomUUID(),p=>p.execution_epoch++,p=>p.run_id='123']){
  const publication=structuredClone(f.publication);change(publication);assert.equal((await f.revoke(f.bundle,[publication])).pending.length,1);
 }
 assert.equal(f.calls.length,1);assert.equal(f.posts,0);
});
