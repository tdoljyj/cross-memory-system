import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {build, stop} from "esbuild";
import {fileURLToPath,pathToFileURL} from "node:url";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const output=path.join(await mkdtemp(path.join(os.tmpdir(),"registration-helper-")),"recovery.mjs");
await build({entryPoints:[fileURLToPath(new URL("../worker/registration-recovery.ts",import.meta.url))],
  bundle:true,platform:"node",format:"esm",outfile:output});
stop();
const {createRegistrationRecoveryRpc} = await import(pathToFileURL(output).href);
const contract="clued.storage-registration-recovery/1";
function fixture(options={}) {
  const calls=[], reads=[], job={status:"queued",job_id:randomUUID(),connection_id:randomUUID(),owner_id:randomUUID(),
    credential_version:7,request_digest:"a".repeat(64),root_folder_id:"root",root_parent_id:"drive",
    profile:{profile_id:randomUUID()},mutation:{operation:"replace",target_kind:"file",destination_path:"/root/track/file.json",destination_file_version:"45",content:"next"}};
  const request={profile_id:job.profile.profile_id,mutation:{...job.mutation,artifact_role:"clued_resource"},
    provider_identity:{destination_file_id:"file",destination_file_version:"45",destination_parent_id:"parent"}};
  const input={action:"authority",connection_id:job.connection_id,job_id:job.job_id,credential_version:7,request};
  if(options.resume)job.registration_recovery=true;
  const registration={artifact_id:randomUUID(),artifact_version:3,artifact_receipt_id:randomUUID(),source_decision_id:randomUUID(),
    source_decision_version:2,profile_id:job.profile.profile_id,profile_version:2,request_digest:job.request_digest,credential_version:7,
    expected_version:"45",registered_version:"43",path:job.mutation.destination_path,root_folder_id:"root",root_parent_id:"drive",
    provider_file_id:"file",parent_provider_id:"parent",registration_digest:"c".repeat(64)};
  const metadata={id:"file",version:"45",name:"file.json",parents:["parent"],mimeType:"application/json",trashed:false,size:"10",sha256Checksum:"d".repeat(64)};
  let committed=false, authorityCalls=0;const lease=randomUUID();
  const committedResult={contract,status:"committed",connection_id:job.connection_id,job_id:job.job_id,
    artifact_id:registration.artifact_id,provider_file_version:"45",receipt_id:randomUUID(),registration_receipt_id:randomUUID(),execution_permitted:false};
  const denied={status:"denied",reason:options.deniedReason??"destination_version_mismatch",request};
  const rpc=async value=>{
    calls.push(structuredClone(value));
    if(value.action==="authority"){
      authorityCalls++;
      return committed || (options.alreadyCurrent&&authorityCalls>1) ? {status:"resolved",request:value.request,authority:{workspace_version:"fresh"}} : denied;
    }
    if(value.action==="registration_load"){
      if(options.loadError)throw new Error("private token secret");
      return {contract,status:options.alreadyCurrent?"already_current":"refreshable",connection_id:job.connection_id,job_id:job.job_id,
        registration:{...registration,...options.registration},lease_id:lease,execution_permitted:false};
    }
    if(value.action==="registration_commit"){
      if(options.rejectCommit)return {...committedResult,status:"rejected"};
      committed=true;
      if(options.lostCommit)throw new Error("lost response");
      return committedResult;
    }
    if(value.action==="registration_defer")return {contract,status:value.reason_code==="REGISTRATION_METADATA_UNAVAILABLE"?"retry_wait":value.reason_code==="REGISTRATION_COMMIT_UNKNOWN"?"commit_unknown":"failed",reason_code:value.reason_code,connection_id:job.connection_id,job_id:job.job_id,execution_permitted:false};
    assert.equal(value.action,"registration_inspect");
    assert.deepEqual(value.registration,registration,"inspection keeps the original server CAS descriptor and recovery key");
    if(options.lostInspect)throw new Error("not reached");
    return committedResult;
  };
  const recover=createRegistrationRecoveryRpc({rpc,descriptor:()=>job,clock:()=>Date.parse("2026-10-16T14:00:00Z"),retry_delay:async()=>{},
    get_file:async id=>{reads.push(id);if(options.readFailure&&reads.length<=options.readFailure)throw new Error("secret provider body");
      return {...metadata,...(options.changed&&reads.length===2?{sha256Checksum:"e".repeat(64)}:{}),...options.metadata};}});
  return {recover,input,job,request,registration,calls,reads,denied};
}

test("same-file registration drift performs two metadata reads and resolves a fresh authority",async()=>{
  const f=fixture(), immutable=structuredClone({job:f.job,request:f.request});
  const result=await f.recover(f.input);
  assert.equal(result.status,"resolved");
  assert.deepEqual(f.reads,["file","file"]);
  assert.deepEqual(f.calls.map(x=>x.action),["authority","registration_load","registration_commit","authority"]);
  assert.deepEqual({job:f.job,request:f.request},immutable,"expected version and immutable job/snapshot are never patched");
  assert.equal(f.calls[2].observations.length,2);
  assert.equal(f.calls[2].observations[0].sha256,"d".repeat(64));
  assert.equal(f.calls.some(x=>["begin","provider_attempt","finalize"].includes(x.action)),false,"metadata recovery issues no effect permit or provider write");
});
test("old expected version cannot be filled in by recovery",async()=>{
  const f=fixture();f.job.mutation.destination_file_version="44";
  assert.deepEqual(await f.recover(f.input),f.denied);assert.equal(f.calls.length,1);assert.equal(f.reads.length,0);
});
test("a persisted check cannot relabel another original authority refusal as version drift",async()=>{
  const f=fixture({resume:true,deniedReason:"destination_parent_mismatch"}),result=await f.recover(f.input);
  assert.equal(result.reason,"destination_parent_mismatch");assert.equal(result.registration_recovery,undefined);
  assert.deepEqual(f.calls.map(x=>x.action),["authority"]);assert.equal(f.reads.length,0);
});
test("a concurrent exact refresh is followed by normal authority only",async()=>{
  const f=fixture({alreadyCurrent:true});assert.equal((await f.recover(f.input)).status,"resolved");
  assert.deepEqual(f.calls.map(x=>x.action),["authority","registration_load","authority"]);assert.equal(f.reads.length,0);
});
test("lost commit response inspects the original key once and never resends commit",async()=>{
  const f=fixture({lostCommit:true});assert.equal((await f.recover(f.input)).status,"resolved");
  assert.deepEqual(f.calls.map(x=>x.action),["authority","registration_load","registration_commit","registration_inspect","authority"]);
  assert.equal(f.calls.filter(x=>x.action==="registration_commit").length,1);
});
test("an uninspectable commit cannot be represented as success",async()=>{
  const f=fixture({lostCommit:true,lostInspect:true}),result=await f.recover(f.input);
  assert.equal(result.status,"denied");assert.equal(result.registration_recovery.reason_code,"REGISTRATION_COMMIT_UNKNOWN");
  assert.equal(f.calls.filter(x=>x.action==="registration_commit").length,1);assert.equal(f.calls.filter(x=>x.action==="authority").length,1);
});
test("file content changing between the two reads never updates registration",async()=>{
  const f=fixture({changed:true}),result=await f.recover(f.input);
  assert.equal(result.registration_recovery.reason_code,"REGISTRATION_METADATA_CHANGED");assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).action,"registration_defer");
});
test("identity, parent, version, deletion, MIME and bounded hash evidence fail closed",async t=>{
  for(const metadata of [{id:"other"},{parents:["other"]},{parents:["parent","other"]},{version:"46"},{name:"renamed.json"},{trashed:true},
    {mimeType:"application/vnd.google-apps.document"},{size:"5242881"},{sha256Checksum:"not-a-hash"}])await t.test(JSON.stringify(metadata),async()=>{
      const f=fixture({metadata}),result=await f.recover(f.input);assert.equal(result.status,"denied");assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).action,"registration_defer");
    });
});
test("only a failed metadata GET is retried, with a fixed small bound",async()=>{
  const recovered=fixture({readFailure:1});assert.equal((await recovered.recover(recovered.input)).status,"resolved");assert.equal(recovered.reads.length,3);
  const unavailable=fixture({readFailure:10}),result=await unavailable.recover(unavailable.input);assert.equal(unavailable.reads.length,2);
  assert.equal(result.registration_recovery.reason_code,"REGISTRATION_METADATA_UNAVAILABLE");assert.doesNotMatch(JSON.stringify(result),/secret provider body/);
});
test("untrusted load shape and denied commit never manufacture a fresh admission",async t=>{
  for(const options of [{registration:{provider_file_id:"other"}},{registration:{request_digest:"e".repeat(64)}},{registration:{registered_version:"46"}},{loadError:true},{rejectCommit:true}])await t.test(JSON.stringify(options),async()=>{
    const f=fixture(options),result=await f.recover(f.input);assert.equal(result.status,"denied");assert.equal(f.calls.filter(x=>x.action==="authority").length,1);
    assert.doesNotMatch(JSON.stringify(result),/private token secret/);
  });
});
