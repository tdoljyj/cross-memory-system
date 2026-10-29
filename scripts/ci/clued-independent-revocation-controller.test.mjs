import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeJobV2} from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import {canonical,digest} from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import {makeIndependentPublicationIdentity} from './clued-independent-publication-identity.mjs';
import {readIndependentRevocationBatch,runIndependentRevocationWithPorts,runIndependentRevocationMaintenance} from './clued-independent-revocation-controller.mjs';
const scope='project:0597aa60-9b98-4da6-a4ab-63d7705b632f',repository='tdoljyj/cross-memory-system',head='a'.repeat(40);
const record={config:{scope,repository,sourceManifestSha256:'d'.repeat(64)}};
const page=(revocations=[],publications=[])=>({status:'ok',revocations,publications,next_outbox_cursor:null,next_publication_cursor:null});
function physicalFixture(item){
 const job=makeJobV2({repo:repository,pr:937,headSha:head,baseSha:'b'.repeat(40),sourceManifestSha256:record.config.sourceManifestSha256,
  role:'gitleaks',attempt:1,createdAt:new Date().toISOString()});
 const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:item.claim_id,fence:1,execution_epoch:3},controller_id:randomUUID()});
 const nonce='a'.repeat(32),sid='S-1-5-21-1-2-3-1015',requestId=randomUUID(),bytes=v=>Buffer.from(canonical(v));
 const plan={contract:'clued.independent-ci.fixed-formal-windows-entry/3',enabled:true,stage:3,entryRole:'check-publisher',batchKey:'b'.repeat(64),
  batchId:'b'.repeat(16)+'-'+'c'.repeat(12),ownerPackageAcceptanceRef:randomUUID(),nodeSha256:'1'.repeat(64),nodeProfileSha256:'2'.repeat(64),
  entrySha256:'3'.repeat(64),acceptanceSha256:'4'.repeat(64),sourceManifestSha256:job.sourceManifestSha256,
  installationSha256:'5'.repeat(64),runtimeConfigPinSha256:'6'.repeat(64),jobSha256:digest([job])};
 const configSha256=digest(plan),outcome={contract:'clued.independent-ci.entry-outcome/2',nonce,stage:3,entryRole:plan.entryRole,
  status:'BLOCKED',reason:'authorization_changed',sideEffects:0,mayHavePublished:false,jobIds:[job.id]};
 const bundle={requestId,planBytes:bytes(plan),jobsBytes:bytes([job]),outcomeBytes:bytes(outcome),
  requestBytes:bytes({contract:'clued.independent-ci.swap-broker-request/2',stage:3,nonce,configSha256,deadline:new Date().toISOString()}),
  responseBytes:bytes({contract:'clued.independent-ci.swap-broker-response/2',requestId,ok:true,code:null,started:true,startCallIssued:true,
   helperPid:12345,stoppedInTime:true,restored:true,accountUnchanged:true,stableBefore:true,stableAfter:true,configurationConflict:false}),
  receiptBytes:bytes({contract:'clued.independent-ci.windows-formal-entry-receipt/2',nonce,state:'FIXED_CHILD_REFUSED',failure_code:'FIXED_NODE_EXIT_NONZERO',
   actual_sid:sid,service_pid:12345,session_id:0,node_pid:12346,node_exit_code:2,timed_out:false,stop_requested:false,tree_cleanup_confirmed:true,
   tree_cleanup_failure_code:null,tree_active_processes:0,root_exit_confirmed:true,entry_role:plan.entryRole,stage:3,entry_sha256:plan.entrySha256,
   config_sha256:configSha256,acceptance_sha256:plan.acceptanceSha256,source_manifest_sha256:plan.sourceManifestSha256,outcome_sha256:digest(outcome),
   stdout_captured:false,private_bytes_read_by_helper:false,host_qualification:false,ci_principal_qualification:false})};
 return {identity,witness:{contract:'clued.independent-ci.controller-supervision/1',identity,nonce,configSha256,plan,controllerSid:sid},bundle};
}
function fixture({outbox=false,keepPending=true,loseFinish=false,failWindow=false}={}){
 const calls=[],githubWrites=[],item={outbox_id:randomUUID(),claim_id:randomUUID(),execution_epoch:4,repository,head_sha:head,pr_ref:null};let finished=false;
 const native={async command(input){calls.push(input);
  if(input.action==='revocations_list')return page(outbox&&(!finished||keepPending)?[item]:[]);
  if(input.action==='independent_revocation_heads')return {status:'ok',complete:true,repository,claimId:item.claim_id,executionEpoch:4,heads:[head]};
  if(input.action==='independent_legacy_drain_finish'){finished=true;if(loseFinish)throw Error('lost committed drain reply');return {status:'committed',receipt_id:randomUUID(),replayed:false};}
  throw Error('unexpected mutation');
 }};
 const github={async readChecks(){return {complete:true,checks:[]};},async revokeCheck(...args){githubWrites.push(args);throw Error('no checks exist');}};
 const supervisor={async readProtectedStopBundle(){throw Error('no tracked publishers');},async withLegacyDrainWindow(subject,callback){
  return callback({async assertCurrent(){return !failWindow;},async readControllerStopBundles(){return {complete:true,executions:[physicalFixture(item)]};}});
 }};
 return {calls,githubWrites,item,native,github,supervisor,run:()=>runIndependentRevocationWithPorts({record,native,github,supervisor,
  journalFor:async()=>{throw Error('no tracked publishers');}})};
}
test('empty maintenance finishes with zero writes and never exposes a create/begin/ACK route',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.status,'REVOCATION_MAINTENANCE');assert.equal(r.sideEffects,0);assert.equal(r.revocation.complete,true);
 assert.deepEqual(f.calls.map(c=>c.action),['revocations_list','revocations_list']);assert.equal(f.githubWrites.length,0);
});
test('independent completion remains PENDING until the original revoker finishes its own outbox',async()=>{
 const f=fixture({outbox:true}),r=await f.run();assert.equal(r.status,'PENDING');assert.equal(r.revocation.pending,1);assert.equal(r.sideEffects,1);
 assert.equal(f.calls.filter(c=>c.action==='independent_legacy_drain_finish').length,1);
 assert.equal(f.calls.some(c=>['revocation_ack','publication_begin_independent','publication_begin'].includes(c.action)),false);
});
test('a lost idempotent completion reply retains possible side effects and permits only a pending negative-effect recovery',async()=>{
 const f=fixture({outbox:true,loseFinish:true}),r=await f.run();assert.equal(r.status,'PENDING');assert.equal(r.sideEffects,1);assert.equal(r.revocation.complete,false);
 assert.equal(f.githubWrites.length,0);assert.equal(f.calls.at(-1).action,'independent_legacy_drain_finish');
});
test('a missing qualified launch window blocks completion before any mutation',async()=>{
 const f=fixture({outbox:true,failWindow:true}),r=await f.run();assert.equal(r.status,'PENDING');assert.equal(r.sideEffects,0);
 assert.equal(f.calls.some(c=>c.action==='independent_legacy_drain_finish'),false);
});
test('after both independent and original revokers drain, the full maintenance view is complete',async()=>{
 const f=fixture({outbox:true,keepPending:false}),r=await f.run();assert.equal(r.status,'REVOCATION_MAINTENANCE');assert.equal(r.revocation.pending,0);
 assert.equal(r.revocation.acknowledged,0,'this controller never performs the other revoker ACK');
});
test('pagination rejects missing, nonadvancing or malformed cursors instead of declaring the queue empty',async()=>{
 for(const result of [{status:'ok',revocations:[],publications:[]},{...page(),next_outbox_cursor:'invalid'}]){
  await assert.rejects(()=>readIndependentRevocationBatch({command:async()=>result},scope));
 }
 const cursor=randomUUID();let calls=0;
 await assert.rejects(()=>readIndependentRevocationBatch({async command(){calls++;return {...page(),next_outbox_cursor:cursor};}},scope),/cursor_unconfirmed/);
 assert.equal(calls,2);
});
test('foreign Actions publications remain pending for their original revoker, never treated as independent completion',async()=>{
 const publication={publication_id:randomUUID(),repository,independent_identity:null};
 const f=fixture();f.native.command=async()=>page([],[publication]);
 const r=await f.run();assert.equal(r.status,'PENDING');assert.equal(r.revocation.pending,1);assert.equal(r.sideEffects,0);
});
test('an ordinary record cannot turn on production maintenance or read a protected supervisor',async()=>{
 const r=await runIndependentRevocationMaintenance({record,ports:{},live(){throw Error('must not start');}});
 assert.equal(r.status,'BLOCKED');assert.equal(r.sideEffects,0);assert.equal(r.reason,'REVOCATION_QUALIFICATION_REQUIRED');
});
