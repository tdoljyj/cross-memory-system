import assert from "node:assert/strict";
import test from "node:test";
import { fixture, ids, root } from "./resource-center-cloud-executor.fixture.mjs";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
test('cloud composition runs scan, admission, one durable start, one POST and verified receipt without a mounted disk',async()=>{
  const f=fixture(),executor=f.run();const result=await executor.run(f.reference);
  assert.deepEqual(result,{status:'committed',job_id:ids.job,receipt_id:ids.receipt,execution_permitted:false});
  assert.equal(f.info().starts,1);assert.equal(f.info().posts,1);
  assert.ok(f.info().trace.indexOf('provider_attempt')<f.info().trace.indexOf('provider-post'));
  assert.equal((await executor.run(f.reference)).status,'inspection_required');
  assert.equal((await f.run().run(f.reference)).status,'inspection_required');
  assert.equal(f.info().posts,1);assert.equal(JSON.stringify(result).includes('admission'),false);
});
test('v2 records real provider proof before pure settlement',async()=>{
  const f=fixture(),base=f.config.rpc;let finish,recorded=false;
  f.config.verified_result_mode=true;
  f.config.rpc=async input=>{
    if(input.action==='verified_record'){
      assert.equal(f.info().posts,1);
      assert.equal(input.proof.contract,'clued.storage-create-verified/2');
      assert.equal(input.proof.provider_file_id,'new-id');
      assert.equal(input.proof.checks.content,true);
      finish=input.finish;recorded=true;
      return {status:'verified',intent_id:ids.intent,verified_receipt_id:ids.receipt,
        verified_digest:'a'.repeat(64),version:3,execution_permitted:false};
    }
    if(input.action==='settle_verified'){
      assert.equal(recorded,true);
      assert.equal(input.verified_receipt_id,ids.receipt);
      return base({...input,...finish,action:'finalize'});
    }
    return base(input);
  };
  const result=await createResourceCenterCloudExecutor(f.config).run(f.reference);
  assert.equal(result.status,'committed');assert.equal(f.info().posts,1);
});
test('caller profile/payload injection and cross-account credential never reach a write',async()=>{
  const f=fixture();assert.equal((await f.run().run({...f.reference,managed_root:'/other'})).status,'unavailable');assert.equal(f.info().loads,0);
  const other=fixture({credential:{owner_id:ids.connection}});
  assert.equal((await other.run().run(other.reference)).status,'unavailable');assert.equal(other.info().starts,0);assert.equal(other.info().posts,0);
});
test('sibling/root drops and status directory fail before durable start and provider write',async()=>{
  const island=fixture({island:true});assert.equal((await island.run().run(island.reference)).error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');assert.equal(island.info().starts,0);
  const f=fixture();const load=f.config.load_job;f.config.load_job=async ref=>{
    const d=await load(ref);d.mutation={operation:'create',target_kind:'directory',destination_path:root+'/track/00_现行基线',directory_semantics:'topic'};return d;
  };
  assert.equal((await f.run().run(f.reference)).status,'deny');assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
});
for(const [name,options] of Object.entries({revoked:{revoke:true},lostBegin:{lostBegin:true},missingAttemptReceipt:{failAttempt:true},replayedAttempt:{replayedAttempt:true},expiredAdmission:{expireAdmission:true}})){
  test('cloud '+name+' prevents provider mutation and never retries start',async()=>{
    const f=fixture(options),executor=f.run();assert.notEqual((await executor.run(f.reference)).status,'committed');
    assert.equal(f.info().posts,0);await executor.run(f.reference);assert.ok(f.info().starts<=1);assert.equal(f.info().posts,0);
  });
}
for(const [name,options] of Object.entries({lostPost:{lostPost:true},lostFinalize:{lostFinalize:true}})){
  test('cloud '+name+' preserves unknown effect across new executors without redispatch',async()=>{
    const f=fixture(options);assert.equal((await f.run().run(f.reference)).status,'unreconciled');
    assert.equal(f.info().posts,1);assert.equal((await f.run().run(f.reference)).status,'inspection_required');assert.equal(f.info().posts,1);
  });
}
