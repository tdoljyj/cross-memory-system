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
test('preflight denial logs only a bounded diagnostic code',async()=>{
  const f=fixture();const load=f.config.load_job;f.config.load_job=async ref=>{
    const d=await load(ref);d.mutation={operation:'create',target_kind:'directory',destination_path:root+'/track/00_现行基线',directory_semantics:'topic'};return d;
  };
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.equal(result.status,'deny');assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
  assert.equal(logs.length,1);
  const diagnostic=JSON.parse(logs[0]);
  assert.deepEqual(Object.keys(diagnostic).sort(),['error_code','event']);
  assert.equal(diagnostic.event,'storage_cloud_denied');
  assert.match(diagnostic.error_code,/^[A-Z][A-Z0-9_]{0,63}$/);
  assert.equal(logs[0].includes(root),false);
  assert.equal(logs[0].includes(ids.job),false);
});
test('early boundary scan denial logs a code without scan findings',async()=>{
  const island=fixture({island:true});
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await island.run().run(island.reference); }
  finally { console.warn=original; }
  assert.equal(result.status,'deny');
  assert.equal(result.error_code,'UNAUTHORIZED_WORKSPACE_MUTATION');
  assert.equal(island.info().starts,0);assert.equal(island.info().posts,0);
  assert.deepEqual(logs.map(message=>JSON.parse(message)),[{event:'storage_cloud_denied',error_code:'UNAUTHORIZED_WORKSPACE_MUTATION'}]);
});
test('authority failures identify the failed stage using fixed labels without exposing inputs',async()=>{
  for(const scenario of ['provider','provider_unknown','rpc','denied','mismatch']){
    const f=fixture();
    if(scenario==='provider' || scenario==='provider_unknown'){
      const fetch=f.config.drive_fetch;
      f.config.drive_fetch=async(url,init)=>{
        const response=await fetch(url,init);
        if(new URL(url).searchParams.get('q')?.includes("name = 'track'")){
          if(scenario==='provider_unknown') throw new Error('private provider detail '+root);
          const body=await response.json();
          return Response.json({...body,files:body.files.map(file=>({...file,version:null}))});
        }
        return response;
      };
    }else {
      const rpc=f.config.rpc;
      f.config.rpc=async input=>{
        if(input.action!=='authority') return rpc(input);
        if(scenario==='rpc') throw new Error('private database detail '+ids.job);
        if(scenario==='denied') return {status:'denied',private_path:root};
        return {status:'resolved',request:{private_path:root},authority:{workspace_version:'workspace/1'}};
      };
    }
    const logs=[],original=console.warn;
    console.warn=message=>logs.push(message);
    let result;
    try { result=await f.run().run(f.reference); }
    finally { console.warn=original; }
    assert.equal(result.status,'deny');
    assert.equal(result.error_code,'ARTIFACT_AUTHORITY_RESOLUTION_FAILED');
    assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
    const expected={provider:['provider_identity','PROVIDER_METADATA_MISMATCH'],
      provider_unknown:['provider_identity','PROVIDER_IDENTITY_UNAVAILABLE'],
      rpc:['canonical_rpc','AUTHORITY_RPC_UNAVAILABLE'],denied:['canonical_result','AUTHORITY_RPC_DENIED'],
      mismatch:['canonical_result','AUTHORITY_RESPONSE_MISMATCH']}[scenario];
    assert.deepEqual(logs.map(message=>JSON.parse(message)),[
      {event:'storage_cloud_authority_failed',phase:'initial',stage:expected[0],error_code:expected[1]},
      {event:'storage_cloud_denied',error_code:'ARTIFACT_AUTHORITY_RESOLUTION_FAILED'},
    ]);
    assert.equal(logs.join('').includes(root),false);
    assert.equal(logs.join('').includes(ids.job),false);
  }
});
test('authority diagnostics distinguish revalidation after initial resolution',async()=>{
  const f=fixture(),rpc=f.config.rpc;let lookups=0;
  f.config.rpc=async input=>{
    if(input.action==='authority' && ++lookups===2) return {status:'denied'};
    return rpc(input);
  };
  const logs=[],original=console.warn;
  console.warn=message=>logs.push(message);
  let result;
  try { result=await f.run().run(f.reference); }
  finally { console.warn=original; }
  assert.equal(result.error_code,'ARTIFACT_AUTHORITY_REVALIDATION_FAILED');
  assert.equal(lookups,2);
  assert.equal(f.info().starts,0);assert.equal(f.info().posts,0);
  assert.deepEqual(logs.map(message=>JSON.parse(message)),[
    {event:'storage_cloud_authority_failed',phase:'revalidation',stage:'canonical_result',error_code:'AUTHORITY_RPC_DENIED'},
    {event:'storage_cloud_denied',error_code:'ARTIFACT_AUTHORITY_REVALIDATION_FAILED'},
  ]);
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
