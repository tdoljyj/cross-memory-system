import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EffectJournal } from '../../work/actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import { makeJobV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';
import { makeIndependentPublicationIdentity } from './clued-independent-publication-identity.mjs';
import { createIndependentPublicationRuntime, nativeNoPostProof, nativePublicationJournalKey } from './clued-independent-publication-runtime.mjs';
const scope='project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const job=makeJobV2({repo:'tdoljyj/cross-memory-system',pr:937,headSha:'a'.repeat(40),baseSha:'b'.repeat(40),testSha:'c'.repeat(40),
  role:'gitleaks',sourceManifestSha256:'d'.repeat(64),createdAt:'2026-10-29T04:00:00Z',attempt:1});
const identity=makeIndependentPublicationIdentity({job,claim:{claim_id:'11111111-2222-4333-8444-555555555555',fence:4,execution_epoch:3},controller_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'});
const input={identity,scope,paths:['scripts/ci/test.mjs'],payload:{name:'gitleaks',head_sha:job.headSha,status:'completed',conclusion:'success',
  external_id:`independent-ci:staged:v2:${job.id}:a1`,output:{title:'gitleaks success',summary:'Signed scanner proof.'}}};
const pub='11111111-aaaa-4bbb-8ccc-222222222222',receipt='33333333-aaaa-4bbb-8ccc-444444444444';
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'native-pub-unit-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const journal=await EffectJournal.open(directory),checks=[],calls=[];let current=true,finishRevoke=false,losePost=false,hideChecks=false,denyBegin=false,loseBegin=false,loseAbort=false,aborted=false;
 const native={async command(body){calls.push(body);switch(body.action){
  case 'publication_begin_independent':if(denyBegin||aborted)return {status:'rejected',error_code:'not_qualified_or_closed'};if(loseBegin)throw Error('lost begin reply');return {status:'ok',verdict:'ADMITTED',execution_policy:'active',execution_authorized:true,publication_required:true,publication_id:pub,receipt_id:receipt,independent_identity:identity};
  case 'publication_finish':return {status:'committed',receipt_id:receipt,must_revoke:finishRevoke};
  case 'publication_abort_independent':{const replayed=aborted;aborted=true;if(loseAbort){loseAbort=false;throw Error('lost committed abort reply');}return {status:'committed',receipt_id:receipt,publication_id:pub,replayed};}
  case 'publication_reconcile':return {status:'committed',receipt_id:receipt,must_revoke:true};
  default:throw Error('unexpected command');
 }}};
 let posts=0,patches=0;
 const github={async createCheck(body){posts++;const check={...structuredClone(body),id:101,app:{id:5368905}};checks.push(check);if(losePost)throw Error('lost response');return structuredClone(check);},
 async readCheck(id){return structuredClone(checks.find(c=>c.id===id));},async readChecks(){return hideChecks?[]:structuredClone(checks);},
 async revokeCheck(id,body){patches++;Object.assign(checks.find(c=>c.id===id),structuredClone(body));return structuredClone(checks.find(c=>c.id===id));}};
 const runtime=createIndependentPublicationRuntime({native,github,journal,assertCurrent:async()=>current,
  observeStopped:async()=>({stopped:true,controller_id:identity.controller_id,job_id:job.id,source:'qualified-controller-supervisor',proofRef:'receipt:'+receipt})});
 return {runtime,journal,calls,checks,setCurrent:v=>current=v,setFinishRevoke:v=>finishRevoke=v,setLosePost:v=>losePost=v,
  setHideChecks:v=>hideChecks=v,setDenyBegin:v=>denyBegin=v,setLoseBegin:v=>loseBegin=v,setLoseAbort:v=>loseAbort=v,get posts(){return posts;},get patches(){return patches;}};
}
test('Native begin precedes the only POST; finish and readback settle the original ticket',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);assert.equal(f.posts,0);
 const result=await f.runtime.createCheck(handle);assert.equal(result.status,'SETTLED');assert.equal(f.posts,1);
 assert.deepEqual(f.calls.map(c=>c.action),['publication_begin_independent','publication_begin_independent','publication_finish']);
 assert.match(result.check.output.summary,new RegExp(pub));assert.equal((await f.journal.read(handle.key)).state,'settled');
});
test('a rejected Native consumer never reaches GitHub and produces an in-process no-POST proof',async t=>{
 const f=await fixture(t);f.setDenyBegin(true);
 let error;try{await f.runtime.prepare(input);}catch(e){error=e;}
 assert.equal(nativeNoPostProof(error)?.notSent,true);assert.equal(f.posts,0);
 assert.equal(nativeNoPostProof({...error}),null);
});
test('revoked CI role or closed ticket after preparation blocks the final POST',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);f.setDenyBegin(true);
 let error;try{await f.runtime.createCheck(handle);}catch(e){error=e;}
 assert.equal(nativeNoPostProof(error)?.publicationId,pub);assert.equal(f.posts,0);
 assert.equal((await f.journal.read(handle.key)).state,'authorized');
});
test('changed subject, role or path is refused before Native or GitHub',async t=>{
 const f=await fixture(t);
 for(const edit of [v=>v.payload.head_sha='f'.repeat(40),v=>v.payload.name='trivy',v=>v.paths=['../secret']]){
  const value=structuredClone(input);edit(value);await assert.rejects(()=>f.runtime.prepare(value));
 }
 assert.equal(f.calls.length,0);assert.equal(f.posts,0);
});
test('a handover after prepare is still proven not sent and cannot start a check',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);f.setCurrent(false);
 let error;try{await f.runtime.createCheck(handle);}catch(e){error=e;}
 assert.equal(nativeNoPostProof(error)?.publicationId,pub);assert.equal(f.posts,0);
 assert.equal((await f.runtime.reconcileStopped(handle.key)).status,'NOT_SENT');
 assert.equal(f.calls.at(-1).action,'publication_abort_independent');
});
test('a lost POST reply is recovered by identity without a second POST',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);f.setLosePost(true);
 let error;try{await f.runtime.createCheck(handle);}catch(e){error=e;}
 assert.equal(nativeNoPostProof(error),null);assert.equal((await f.journal.read(handle.key)).state,'uncertain');
 const recovered=await f.runtime.recover(handle.key);assert.equal(recovered.status,'SETTLED');assert.equal(f.posts,1);
});
test('an uncertain invisible POST stays unresolved even after the publisher stopped',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);f.setLosePost(true);await assert.rejects(()=>f.runtime.createCheck(handle));f.setHideChecks(true);
 await assert.rejects(()=>f.runtime.reconcileStopped(handle.key),/unknown_post_not_found/);
 assert.equal(f.posts,1);assert.equal(f.calls.some(c=>['publication_abort_independent','publication_reconcile'].includes(c.action)),false);
 assert.equal((await f.journal.read(handle.key)).state,'uncertain');
});
test('late finish revokes the check but leaves Native open until actual supervisor stop observation',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);f.setFinishRevoke(true);
 const result=await f.runtime.createCheck(handle);assert.equal(result.status,'REVOKED_PENDING_DRAIN');
 assert.equal(f.patches,1);assert.equal(f.calls.some(c=>c.action==='publication_reconcile'),false);
 assert.equal((await f.runtime.reconcileStopped(handle.key)).status,'RECONCILED');assert.equal(f.patches,1);
 assert.equal(f.calls.at(-1).publisher_stopped,true);assert.equal(f.posts,1);
});
test('a prepared capability is single-use; repeated preparation only requests recovery after sent',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);await f.runtime.createCheck(handle);
 await assert.rejects(()=>f.runtime.createCheck(handle),/prepared_handle_required/);
 assert.deepEqual(await f.runtime.prepare(input),{recoveryRequired:true,key:nativePublicationJournalKey(identity)});assert.equal(f.posts,1);
});
test('a lost begin reply is recovered from the original Native row and aborted only after stop observation',async t=>{
 const f=await fixture(t);f.setLoseBegin(true);await assert.rejects(()=>f.runtime.prepare(input));
 const key=nativePublicationJournalKey(identity);assert.equal((await f.journal.read(key)).state,'intent');
 const row={publication_id:pub,started_receipt_id:receipt,run_id:null,claim_id:identity.claim.claim_id,
  execution_epoch:identity.claim.execution_epoch,repository:job.repo,head_sha:job.headSha,pr_ref:`${job.repo}#${job.pr}`,independent_identity:identity};
 await assert.rejects(()=>f.runtime.adoptOpenTicket(key,{...row,execution_epoch:99}));
 assert.equal((await f.runtime.adoptOpenTicket(key,row)).status,'REGISTRATION_RECOVERED');
 assert.equal((await f.runtime.reconcileStopped(key)).status,'NOT_SENT');assert.equal(f.posts,0);
 assert.equal(f.calls.filter(c=>c.action==='publication_begin_independent').length,1);
});
test('a committed abort with a lost reply cannot reopen a POST and recovers the original receipt',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input);f.setLoseAbort(true);
 await assert.rejects(()=>f.runtime.reconcileStopped(handle.key),/lost committed abort reply/);
 assert.equal((await f.journal.read(handle.key)).details.abortingNotSent,true);
 assert.equal((await f.runtime.prepare(input)).recoveryRequired,true);assert.equal(f.posts,0);
 assert.equal((await f.runtime.recover(handle.key)).status,'NOT_SENT');
 assert.equal((await f.journal.read(handle.key)).details.abortReceiptId,receipt);assert.equal(f.posts,0);
});
test('a failed local final write after committed abort is replayed without a POST',async t=>{
 const f=await fixture(t),handle=await f.runtime.prepare(input),transition=f.journal.transition.bind(f.journal);let injected=false;
 f.journal.transition=async(...args)=>{if(!injected&&args[2]==='revoked'&&args[3]?.notSentConfirmed){injected=true;throw Error('final journal write failed');}return transition(...args);};
 await assert.rejects(()=>f.runtime.reconcileStopped(handle.key),/final journal write failed/);
 assert.equal((await f.runtime.prepare(input)).recoveryRequired,true);
 assert.equal((await f.runtime.recover(handle.key)).status,'NOT_SENT');assert.equal(f.posts,0);
 assert.equal(f.calls.filter(c=>c.action==='publication_abort_independent').length,2);
});
