import assert from "node:assert/strict";
import test from "node:test";
import {build,stop} from "esbuild";
import {fileURLToPath,pathToFileURL} from "node:url";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {withRegistrationDatabase,id,sha} from "./registration-recovery-db.fixture.mjs";
import {assertGatewayCloseoutBoundary,setWorkerGatewayCaller} from "./worker-gateway-caller-fixture.mjs";
const output=path.join(await mkdtemp(path.join(os.tmpdir(),"registration-helper-")),"recovery.mjs");
await build({entryPoints:[fileURLToPath(new URL("../worker/registration-recovery.ts",import.meta.url))],bundle:true,platform:"node",format:"esm",outfile:output});stop();
const {createRegistrationRecoveryRpc}=await import(pathToFileURL(output).href);

test("registration recovery: real PostgreSQL boundary, CAS, receipts and unchanged authority",{timeout:240000},async t=>withRegistrationDatabase(async f=>{
 const {db,cloud}=f;
 const artifact=async provider=>(await db.query("select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id=$2",[f.profile,provider])).rows[0];
 const job=async ref=>(await db.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2",[f.owner,ref.job_id])).rows[0];
 const observations=registration=>{const item=f.files.get(registration.provider_file_id),observation={id:item.id,parent_id:item.parents[0],name:item.name,mime_type:item.mimeType,version:item.version,trashed:false,size:item.size,sha256:item.sha256Checksum,observed_at:new Date().toISOString()};return [observation,{...observation}];};
 const prepare=async options=>{const target=await f.addFile(options);const denied=await cloud(target.input);assert.equal(denied.reason,"destination_version_mismatch",JSON.stringify(denied));
  const loaded=await cloud({...target.input,action:"registration_load"});assert.equal(loaded.status,"refreshable",JSON.stringify(loaded));return {...target,registration:loaded.registration,lease:loaded.lease_id};};
 const commitInput=target=>({...target.input,action:"registration_commit",registration:target.registration,lease_id:target.lease,observations:observations(target.registration)});
 const fault=async(target,inject,expected)=>{await db.query("begin");try{await inject();await setWorkerGatewayCaller(db);
  await assert.rejects(f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),db),expected);
 }finally{await db.query("rollback");}};
 const check=async ref=>(await db.query("select * from clued_private.storage_registration_checks_v1 where job_id=$1",[ref.job_id])).rows[0];
 const due=async ref=>{
  await db.query("update clued_private.storage_registration_checks_v1 set next_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second',version=version+1 where job_id=$1",[ref.job_id]);
  await db.query("update clued_private.storage_jobs_v1 set created_at=clock_timestamp()-interval '100 seconds',redispatch_at=null where job_id=$1",[ref.job_id]);
 };
 const sweep=()=>f.rpc("clued_storage_queued_sweep_v1",f.issuer,{action:"due",dispatch:true});
 const waitLocked=async client=>{
  const pid=(await client.query("select pg_backend_pid() pid")).rows[0].pid;return async()=>{
   const until=Date.now()+3000;while(Date.now()<until){if((await db.query("select wait_event_type from pg_stat_activity where pid=$1",[pid])).rows[0]?.wait_event_type==="Lock")return;
    await new Promise(r=>setTimeout(r,10));}assert.fail("second independent PostgreSQL transaction must actually wait for the first lock");
  };
 };

 await t.test("new helpers stay private and the existing issuer/Worker boundary is preserved",async()=>{
  await assertGatewayCloseoutBoundary(db);
  for(const name of ["storage_registration_recovery_v1","storage_cloud_before_registration_v1"]){
   const row=(await db.query("select prosecdef,proconfig,pg_get_userbyid(proowner) owner from pg_proc where oid=$1::regprocedure",["clued_private."+name+"(text,jsonb)"])).rows[0];
   assert.equal(row.prosecdef,true);assert.deepEqual(row.proconfig,['search_path=""']);assert.equal(row.owner,"postgres");
   for(const role of ["anon","authenticated","service_role","clued_worker_gateway"])
    assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,"clued_private."+name+"(text,jsonb)"])).rows[0].ok,false);
  }
  for(const entry of (await db.query("select oid::regprocedure::text signature,prosecdef,proconfig,pg_get_userbyid(proowner) owner from pg_proc where pronamespace='clued_private'::regnamespace and (proname like 'storage_registration_%' or proname in ('storage_delivery_issuer_compatible_v1','storage_job_status_before_registration_v1','storage_queue_before_registration_v1'))")).rows){
   assert.equal(entry.prosecdef,true);assert.deepEqual(entry.proconfig,['search_path=""']);assert.equal(entry.owner,"postgres");
   for(const role of ["anon","authenticated","service_role","clued_worker_gateway"])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') ok",[role,entry.signature])).rows[0].ok,false,entry.signature+" "+role);
  }
  for(const role of ["anon","authenticated","service_role","clued_worker_gateway"])assert.equal((await db.query("select has_table_privilege($1,'clued_private.storage_registration_checks_v1','SELECT,INSERT,UPDATE,DELETE') ok",[role])).rows[0].ok,false);
  const before=(await db.query("select pg_get_functiondef('clued_private.storage_cloud_before_registration_v1(text,jsonb)'::regprocedure) body")).rows[0].body;
  assert.match(before,/storage_cloud_job_current_v2/);assert.match(before,/cloud_runtime/);assert.match(before,/storage_cloud_credential_changed/);
  assert.match(before,/resource_center_decision_current_v1/);assert.match(before,/storage_cloud_job_mutation_v2/);
 });
 await t.test("actual Worker helper performs only reads and atomic metadata recovery before fresh authority",async()=>{
  const target=await f.addFile(),before=await artifact(target.provider),original=await job(target.ref),loaded=await cloud({action:"load",...target.ref}),calls=[],reads=[];
  const recover=createRegistrationRecoveryRpc({rpc:async input=>{calls.push(structuredClone(input));return cloud(input);},descriptor:()=>loaded,
   get_file:async provider=>{reads.push(provider);return f.metadata.getFile(provider);}});
  const writes=f.getWrites(),result=await recover(target.input);assert.equal(result.status,"resolved",JSON.stringify(result));
  assert.deepEqual(reads,[target.provider,target.provider]);assert.equal(f.getWrites(),writes);
  const after=await artifact(target.provider),afterJob=await job(target.ref);
  assert.equal(after.provider_file_version,"45");assert.equal(Number(after.version),Number(before.version)+1);assert.notEqual(after.receipt_id,before.receipt_id);
  const preserve=a=>Object.fromEntries(Object.entries(a).filter(([key])=>!["provider_file_version","version","updated_at","receipt_id"].includes(key)));
  assert.deepEqual(preserve(after),preserve(before));assert.deepEqual(afterJob,original,"job expected version, request digest, snapshot, intent and dispatch state are unchanged");
  assert.equal(result.authority.artifact_id,after.id);assert.ok(result.authority.authority_version.includes(":"+after.version+":"));
  const receipt=(await db.query("select * from public.clued_audit_receipts where user_id=$1 and operation='storage_registration_recovery' and target_refs @> $2::jsonb",[f.owner,JSON.stringify([{kind:"system",role:"primary",id:after.id}])])).rows;
  assert.equal(receipt.length,1);assert.equal(receipt[0].status,"committed");assert.equal(receipt[0].event_ids.length,1);
  assert.ok(receipt[0].target_refs.some(ref=>ref.id===after.receipt_id&&ref.role==="source"));
  assert.equal(calls.filter(x=>x.action==="registration_commit").length,1);
  assert.equal((await db.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where user_id=$1",[f.owner])).rows[0].n,0);
  assert.deepEqual((await db.query("select clued_private.storage_cloud_job_current_v2($1,$2) v",[f.owner,target.ref.job_id])).rows[0].v,
   Object.fromEntries(Object.entries(original.authority_snapshot_v2).filter(([key])=>key!=="consent_receipt_id")));
 });
 await t.test("exact replay and lost-response inspection recover one original Receipt",async()=>{
  const target=await prepare(),input=commitInput(target),first=await cloud(input),again=await cloud(input);
  assert.equal(first.status,"committed");assert.equal(again.receipt_id,first.receipt_id);assert.equal(again.registration_receipt_id,first.registration_receipt_id);
  const inspected=await cloud({...target.input,action:"registration_inspect",registration:target.registration,lease_id:target.lease});assert.deepEqual(inspected,first);
  const changed=structuredClone(input);changed.observations[1].observed_at=new Date(Date.now()+1).toISOString();
  await assert.rejects(cloud(changed),/storage_registration_replay_conflict/);
  assert.equal((await db.query("select count(*)::int n from public.clued_audit_receipts where user_id=$1 and operation='storage_registration_recovery' and target_refs @> $2::jsonb",[f.owner,JSON.stringify([{kind:"system",role:"primary",id:target.registration.artifact_id}])])).rows[0].n,1);
 });
 await t.test("actual Worker lost-commit recovery inspects the same PostgreSQL Receipt without another commit",async()=>{
  const target=await f.addFile(),loaded=await cloud({action:"load",...target.ref}),calls=[];
  const recover=createRegistrationRecoveryRpc({descriptor:()=>loaded,get_file:provider=>f.metadata.getFile(provider),rpc:async input=>{
   calls.push(structuredClone(input));const result=await cloud(input);if(input.action==="registration_commit")throw new Error("synthetic response lost after real commit");return result;
  }});
  assert.equal((await recover(target.input)).status,"resolved");assert.equal(calls.filter(x=>x.action==="registration_commit").length,1);
  assert.equal(calls.filter(x=>x.action==="registration_inspect").length,1);
  const commit=calls.find(x=>x.action==="registration_commit"),inspect=calls.find(x=>x.action==="registration_inspect");
  assert.deepEqual(inspect.registration,commit.registration);assert.equal((await job(target.ref)).intent_id,null);
 });
 await t.test("two qualified jobs for one object give one checker then both resolve current authority",async()=>{
  const target=await prepare(),otherRef=await f.submit({...((await job(target.ref)).mutation)}),otherInput=await f.requestFor(otherRef),otherLoad=await cloud({...otherInput,action:"registration_load"});
  assert.equal(otherLoad.status,"busy");
  const first=await cloud(commitInput(target));assert.equal(first.status,"committed");
  const second=await cloud({...otherInput,action:"registration_load"});
  assert.equal(second.status,"already_current");assert.equal(second.receipt_id,undefined);assert.equal((await cloud(otherInput)).status,"resolved");
  assert.equal(Number((await artifact(target.provider)).version),Number(target.registration.artifact_version)+1);
 });
 await t.test("old expected version and another Google ID cannot be silently retargeted",async()=>{
  const old=await f.addFile({expectedVersion:"44"});await assert.rejects(cloud({...old.input,action:"registration_load"}),/storage_registration_denied/);
  const ahead=await f.addFile({registeredVersion:"46"});await assert.rejects(cloud({...ahead.input,action:"registration_load"}),/storage_registration_denied/);
  const valid=await prepare(),other=structuredClone(valid.input);other.request.provider_identity.destination_file_id="other-"+id();
  await assert.rejects(cloud({...other,action:"registration_load"}),/storage_registration_denied/);
  assert.equal((await artifact(old.provider)).provider_file_version,"43");assert.equal((await artifact(valid.provider)).provider_file_version,"43");
 });
 await t.test("payload extras, self-reported Owner/client/origin and CAS alterations fail closed",async()=>{
  const target=await prepare();
  for(const field of ["owner_id","artifact_id","source_decision_id","client_id","origin","resource","alias"])
   await assert.rejects(cloud({...target.input,action:"registration_load",[field]:"caller-selected"}),/storage_registration_invalid/);
  const input=commitInput(target);input.registration.artifact_version++;
  await assert.rejects(cloud(input),/storage_registration_cas_changed/);
  assert.equal((await artifact(target.provider)).provider_file_version,"43");
 });
 await t.test("metadata shape, changed bytes and stale observations never alter registration",async()=>{
  const target=await prepare();
  for(const mutate of [v=>v.observations[0].parent_id="other",v=>v.observations[0].version="46",v=>v.observations[0].sha256="e".repeat(64),
   v=>v.observations[0].trashed=true,v=>v.observations[0].unexpected="data",v=>v.observations.forEach(o=>o.size=10),v=>v.observations.forEach(o=>o.version=45),v=>v.observations.forEach(o=>o.observed_at=new Date(Date.now()-60000).toISOString())]){
   const input=commitInput(target);mutate(input);await assert.rejects(cloud(input),/storage_registration_observation_changed|storage_registration_observation_expired/);
  }
  assert.equal((await artifact(target.provider)).provider_file_version,"43");
 });
 await t.test("credential changes and revoked policies retain their original refusal",async()=>{
  const target=await prepare();
  await fault(target,()=>db.query("update clued_private.storage_connections_v1 set credential_version=credential_version+1 where id=$1",[f.connection]),/storage_cloud_credential_changed/);
  await fault(target,()=>db.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=consent_receipt_id where connection_id=$1 and state='active'",[f.connection]),/storage_policy_denied/);
  assert.equal((await artifact(target.provider)).provider_file_version,"43");
 });
 await t.test("changed registration CAS and Profile never patch a job snapshot",async()=>{
  const target=await prepare(),before=await job(target.ref);
  await fault(target,()=>db.query("update clued_private.resource_center_artifacts_v1 set provider_file_version='44',version=version+1 where id=$1",[target.registration.artifact_id]),/storage_registration_cas_changed/);
  await fault(target,()=>db.query("update clued_private.resource_center_profiles_v1 set version=version+1 where id=$1",[f.profile]),/storage_policy_denied|storage_cloud_unqualified/);
  await fault(target,()=>db.query("update public.clued_memories set version=version+1 where id=$1",[f.decision]),/storage_policy_denied|storage_cloud_unqualified/);
  assert.deepEqual(await job(target.ref),before);assert.equal((await artifact(target.provider)).provider_file_version,"43");
 });
 await t.test("inflight unknown effects keep their original fence and are never cleared by metadata recovery",async()=>{
  const target=await prepare(),before=await artifact(target.provider),intent=id();
  await fault(target,()=>db.query(`insert into clued_private.resource_center_mutations_v1(id,user_id,profile_id,request_key,request_sha256,exact_request,authority_request,
   authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
   values($1,$2,$3,$4,$5,$6,$7,'{}',$5,$8,$9,'uncertain',clock_timestamp()+interval '1 hour',$10)`,
   [intent,f.owner,f.profile,id(),sha(id()),{mutation:(target.input.request.mutation)},target.input.request,target.registration.profile_version,f.decision,before.receipt_id]),/storage_root_has_unresolved_mutation/);
  assert.deepEqual(await artifact(target.provider),before);assert.equal((await job(target.ref)).intent_id,null);
 });
 await t.test("a terminal denied job remains terminal and cannot refresh or acquire an intent",async()=>{
  const target=await prepare();const denied=await cloud({...target.input,action:"report",request:undefined,outcome:{status:"denied",reason:{code:"ARTIFACT_VERSION_MISMATCH"}}});
  assert.equal(denied.status,"denied");await assert.rejects(cloud(commitInput(target)),/storage_cloud_denied/);
  assert.equal((await job(target.ref)).intent_id,null);assert.equal((await artifact(target.provider)).provider_file_version,"43");
 });
 await t.test("an isolated file stays fenced while another file can recover its registration",async()=>{
  const target=await prepare(),sibling=await prepare(),before=await artifact(target.provider),intent=id();
  await db.query("begin");try{
   await db.query(`insert into clued_private.resource_center_mutations_v1(id,user_id,profile_id,request_key,request_sha256,exact_request,authority_request,
    authority_result,authority_token_hash,profile_version,source_decision_id,state,version,expires_at,receipt_id)
    values($1,$2,$3,$4,$5,$6,$7,'{}',$5,$8,$9,'conflict',3,clock_timestamp()-interval '3 hours',$10)`,
    [intent,f.owner,f.profile,id(),sha(id()),{mutation:target.input.request.mutation},target.input.request,target.registration.profile_version,f.decision,before.receipt_id]);
   await db.query(`insert into clued_private.storage_conflict_isolations_v1(intent_id,user_id,profile_id,connection_id,job_id,root_folder_id,
    provider,provider_subject,oauth_client_id,paths,subtree_paths,object_ids,ancestor_ids,slots,scope_complete,original_state,original_version,
    original_receipt_id,close_receipt_id,closed_version)
    values($1,$2,$3,$4,$5,$6,'google-drive','registration-fixture-subject',$7,$8,'{}',$9,$10,'[]',true,'uncertain',2,$11,$11,3)`,
    [intent,f.owner,f.profile,f.connection,target.ref.job_id,f.rootId,f.client,[target.filePath],[target.provider],[f.rootId,f.trackId],before.receipt_id]);
   await setWorkerGatewayCaller(db);await db.query("savepoint isolated_target");
   await assert.rejects(f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),db),/storage_object_under_review/);
   await db.query("rollback to savepoint isolated_target");
   const other=await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(sibling),db);assert.equal(other.status,"committed");
   await db.query("reset role");assert.equal((await db.query("select state from clued_private.storage_conflict_isolations_v1 where intent_id=$1",[intent])).rows[0].state,"active");
   assert.equal((await db.query("select provider_file_version from clued_private.resource_center_artifacts_v1 where id=$1",[before.id])).rows[0].provider_file_version,"43");
  }finally{await db.query("rollback");}
  assert.deepEqual(await artifact(target.provider),before);
 });
 await t.test("registration refresh invalidates an old actual delivery hash instead of relabeling it current",async()=>{
  const original=await f.createOriginal(),delivery=async()=>(await db.query("select clued_private.task_goal_delivery_file_v1($1,$2,null,$3,$4,$5,false) v",[f.owner,"project:"+f.project,{job_id:original.ref.job_id,goal_version:"fixture-goal"},{id:"original-delivery"},"fixture-goal"])).rows[0].v,before=await delivery();
  assert.equal(before.status,"verified",JSON.stringify(before));
  const item=f.files.get(original.artifact.provider_file_id);item.version="45";item.sha256Checksum=sha("external changed head");item.size=String(Buffer.byteLength("external changed head"));
  const ref=await f.submit({operation:"replace",target_kind:"file",destination_path:original.artifact.path,destination_file_version:"45",content:"next"}),input=await f.requestFor(ref),loaded=await cloud({...input,action:"registration_load"});
  const target={input,registration:loaded.registration,lease:loaded.lease_id};assert.equal((await cloud(commitInput(target))).status,"committed");
  const after=await delivery();
  assert.equal(after.status,"stale");assert.equal(after.reason,"delivery_registry_changed");
  const persisted=(await db.query("select m.verified_result_v2 from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.owner_id=$1 and j.job_id=$2",[f.owner,original.ref.job_id])).rows[0].verified_result_v2;
  assert.equal(persisted.proof.provider_file_version,"1");assert.notEqual(persisted.proof.sha256,item.sha256Checksum);
 });
 await t.test("actual production Worker normal entry refreshes registration then completes one original replace",async()=>{
  const target=await f.addFile(),before=await job(target.ref),calls=[],writes=f.getWrites(),result=await f.executeWorker(target.ref,input=>calls.push(structuredClone(input)));
  assert.equal(result.status,"committed",JSON.stringify(result));
  const actions=calls.map(x=>x.action),commit=actions.indexOf("registration_commit"),begin=actions.indexOf("begin"),attempt=actions.indexOf("provider_attempt");
  assert.ok(commit>=0&&begin>commit&&attempt>begin,"fresh full authority follows metadata recovery before the normal durable intent/attempt");
  assert.equal(actions.filter(x=>x==="registration_commit").length,1);assert.equal(actions.filter(x=>x==="begin").length,1);assert.equal(actions.filter(x=>x==="provider_attempt").length,1);
  const after=await job(target.ref),registered=await artifact(target.provider),journal=(await db.query("select * from clued_private.resource_center_mutations_v1 where id=$1",[after.intent_id])).rows[0];
  assert.deepEqual(after.mutation,before.mutation);assert.deepEqual(after.authority_snapshot_v2,before.authority_snapshot_v2);assert.equal(after.request_digest,before.request_digest);
  assert.equal(journal.state,"committed");assert.ok(journal.provider_attempt_receipt_id);assert.ok(journal.verified_receipt_id_v2);
  assert.equal(registered.provider_file_version,"47");assert.equal(registered.source_decision_id,f.decision);assert.equal(f.files.get(target.provider).sha256Checksum,sha("replacement"));
  assert.equal(f.getWrites()-writes,2,"one revision pin and one replacement media write, with no replay");
 });
 await t.test("metadata outage persists a fixed cause and scheduled fresh Worker automatically finishes",async()=>{
  const target=await f.addFile(),before=await job(target.ref),calls=[];let recoveryReads=false,failures=0;
  const first=await f.executeWorker(target.ref,input=>{calls.push(input);if(input.action==="registration_load")recoveryReads=true;},
   {fetch:async(url,init,normal)=>{if(recoveryReads&&new URL(url).pathname.endsWith("/"+target.provider)&&init.method==="GET"&&failures++<2)throw new Error("synthetic temporary provider outage");return normal(url,init);}});
  assert.equal(first.status,"registration_recovery",JSON.stringify(first));assert.equal((await check(target.ref)).state,"retry_wait");
  assert.equal((await check(target.ref)).reason_code,"REGISTRATION_METADATA_UNAVAILABLE");assert.equal((await job(target.ref)).dispatch_outcome,null);assert.equal((await job(target.ref)).intent_id,null);
  const status=(await db.query("select clued_private.storage_job_status_v1(j) v from clued_private.storage_jobs_v1 j where job_id=$1",[target.ref.job_id])).rows[0].v;
  assert.equal(status.reason_code,"REGISTRATION_METADATA_UNAVAILABLE");assert.equal(calls.some(x=>x.action==="report"||x.action==="begin"),false);
  const sibling=await f.addFile();assert.equal((await f.executeWorker(sibling.ref)).status,"committed","one pending file cannot fence another object on the same root");
  await due(target.ref);const scheduled=await sweep();assert.ok(scheduled.jobs.some(j=>j.job_id===target.ref.job_id));
  const after=await f.executeWorker(target.ref);assert.equal(after.status,"committed",JSON.stringify(after));assert.equal((await check(target.ref)).state,"resolved");
  assert.deepEqual((await job(target.ref)).mutation,before.mutation);assert.deepEqual((await job(target.ref)).authority_snapshot_v2,before.authority_snapshot_v2);
 });
 await t.test("committed metadata with lost reply and inspect outage is fail closed until a new Worker inspects only the original key",async()=>{
  const target=await f.addFile(),writes=f.getWrites(),calls=[];
  const first=await f.executeWorker(target.ref,input=>calls.push(structuredClone(input)),{rpc:async(input,normal)=>{
   if(input.action==="registration_commit"){await normal(input);throw new Error("synthetic lost metadata reply");}
   if(input.action==="registration_inspect")throw new Error("synthetic temporary inspect outage");return normal(input);
  }});
  assert.equal(first.status,"registration_recovery");assert.equal((await check(target.ref)).state,"confirming");
  assert.equal((await job(target.ref)).intent_id,null);assert.equal(f.getWrites(),writes);assert.equal(calls.some(x=>x.action==="begin"),false);
  // The normal authority is now resolved, but an inspection failure must still
  // produce an explicit refusal to the kernel, never a nested warning on it.
  await due(target.ref);const secondCalls=[],second=await f.executeWorker(target.ref,input=>secondCalls.push(input),{rpc:async(input,normal)=>{
   if(input.action==="registration_inspect")throw new Error("still temporarily unavailable");return normal(input);
  }});
  assert.equal(second.status,"registration_recovery");assert.equal((await job(target.ref)).intent_id,null);assert.equal(f.getWrites(),writes);
  assert.equal(secondCalls.some(x=>x.action==="begin"||x.action==="registration_commit"),false);
  await due(target.ref);const thirdCalls=[],third=await f.executeWorker(target.ref,input=>thirdCalls.push(structuredClone(input)));
  assert.equal(third.status,"committed",JSON.stringify(third));assert.equal(thirdCalls.filter(x=>x.action==="registration_inspect").length,1);
  assert.equal(thirdCalls.some(x=>x.action==="registration_commit"),false);assert.deepEqual(thirdCalls.find(x=>x.action==="registration_inspect").registration,calls.find(x=>x.action==="registration_commit").registration);
 });
 await t.test("two independent transactions: committed metadata holds inspect until its exact Receipt is visible",async()=>{
  const target=await prepare(),a=await f.connect(),b=await f.connect();await setWorkerGatewayCaller(a);await setWorkerGatewayCaller(b);const locked=await waitLocked(b);
  await a.query("begin");const committed=await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),a);
  const pending=f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,{...target.input,action:"registration_inspect",registration:target.registration,lease_id:target.lease},b);
  try{await locked();}finally{await a.query("commit");}assert.equal((await pending).receipt_id,committed.receipt_id);
  assert.equal(Number((await artifact(target.provider)).version),Number(target.registration.artifact_version)+1);
 });
 await t.test("two independent qualified jobs wait on the same head and register exactly once",async()=>{
  const target=await prepare(),otherRef=await f.submit((await job(target.ref)).mutation),otherInput=await f.requestFor(otherRef),
   a=await f.connect(),b=await f.connect();await setWorkerGatewayCaller(a);await setWorkerGatewayCaller(b);const locked=await waitLocked(b);
  await a.query("begin");const first=await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),a);
  const pending=f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,{...otherInput,action:"registration_load"},b);
  try{await locked();}finally{await a.query("commit");}assert.equal(first.status,"committed");assert.equal((await pending).status,"already_current");
  assert.equal((await cloud(otherInput)).status,"resolved");assert.equal(Number((await artifact(target.provider)).version),Number(target.registration.artifact_version)+1);
  assert.equal((await db.query("select count(*)::int n from public.clued_audit_receipts where operation='storage_registration_recovery' and target_refs @> $1",[JSON.stringify([{kind:"system",role:"primary",id:target.registration.artifact_id}])])).rows[0].n,1);
 });
 await t.test("a current head refreshed elsewhere releases this check without fabricating a recovery Receipt",async()=>{
  const target=await prepare();await f.register({action:"artifact_update",profile_id:f.profile,artifact_id:target.registration.artifact_id,
   base_version:target.registration.artifact_version,path:target.filePath,provider_file_id:target.provider,provider_file_version:"45",governance_class:"ordinary",delete_authority:false});
  const result=await cloud(commitInput(target));assert.equal(result.status,"already_current");assert.equal(result.receipt_id,undefined);
  assert.equal((await check(target.ref)).state,"superseded");assert.equal((await check(target.ref)).receipt_id,null);
  assert.equal((await f.executeWorker(target.ref)).status,"committed");
  f.changeHead(target.provider,"external fresh head","49");
  const third=await f.submit({operation:"replace",target_kind:"file",destination_path:target.filePath,destination_file_version:"49",content:"replacement"});
  assert.equal((await f.executeWorker(third)).status,"committed","a closed technical check cannot fence a future job on the same file");
 });
 await t.test("two independent transactions: proven absence rotates lease and a late original metadata commit cannot happen",async()=>{
  const target=await prepare(),a=await f.connect(),b=await f.connect();await setWorkerGatewayCaller(a);await setWorkerGatewayCaller(b);const locked=await waitLocked(b);
  await a.query("begin");const inspected=await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,{...target.input,action:"registration_inspect",registration:target.registration,lease_id:target.lease},a);
  assert.equal(inspected.status,"retry_wait");const pending=f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),b).then(value=>({value}),error=>({error}));
  try{await locked();}finally{await a.query("commit");}assert.match((await pending).error?.message??"",/storage_registration_lease_changed/);
  assert.equal((await artifact(target.provider)).provider_file_version,"43");
  await due(target.ref);const retry=await cloud({...target.input,action:"registration_load"});assert.equal(retry.status,"refreshable");
  assert.equal((await cloud(commitInput({...target,lease:retry.lease_id}))).status,"committed");
 });
 await t.test("an unknown check is leased once across independent clients and busy does not consume attempts",async()=>{
  const target=await prepare();await cloud({...target.input,action:"registration_defer",registration:target.registration,lease_id:target.lease,reason_code:"REGISTRATION_COMMIT_UNKNOWN"});await due(target.ref);
  const a=await f.connect(),b=await f.connect();await setWorkerGatewayCaller(a);await setWorkerGatewayCaller(b);const locked=await waitLocked(b);
  await a.query("begin");const first=await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,{...target.input,action:"registration_load"},a);assert.equal(first.status,"inspect_required");
  const pending=f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,{...target.input,action:"registration_load"},b);
  try{await locked();}finally{await a.query("commit");}assert.equal((await pending).status,"busy");assert.equal((await check(target.ref)).attempts,2);
  const inspected=await cloud({...target.input,action:"registration_inspect",registration:first.registration,lease_id:first.lease_id});assert.equal(inspected.status,"retry_wait");
 });
 await t.test("bounded attempts and the original deadline terminate precisely through the existing scheduled sweep",async()=>{
  for(const expired of [false,true]){
   const target=await prepare();await db.query("update clued_private.storage_registration_checks_v1 set attempts=$2,lease_until=clock_timestamp()-interval '1 second',expires_at=case when $3 then clock_timestamp()-interval '1 second' else expires_at end,version=version+1 where job_id=$1",[target.ref.job_id,expired?1:6,expired]);
   if(expired)await db.query("update clued_private.storage_jobs_v1 set created_at=clock_timestamp()-interval '3 hours' where job_id=$1",[target.ref.job_id]);
   await sweep();const after=await check(target.ref),status=(await cloud({action:"load",...target.ref}));
   assert.equal(after.state,"failed");assert.equal(after.reason_code,"REGISTRATION_RETRY_EXHAUSTED");assert.equal(status.reason_code,"REGISTRATION_RETRY_EXHAUSTED");
   assert.equal((await job(target.ref)).intent_id,null);assert.equal((await artifact(target.provider)).provider_file_version,"43");
  }
 });
 await t.test("queue expiry waits for an in-progress metadata commit then rechecks its resolved state",async()=>{
  const target=await prepare();await db.query("update clued_private.storage_registration_checks_v1 set attempts=6,lease_until=clock_timestamp()+interval '1 second',version=version+1 where job_id=$1",[target.ref.job_id]);
  const a=await f.connect(),b=await f.connect();await setWorkerGatewayCaller(a);await setWorkerGatewayCaller(b);const locked=await waitLocked(b);
  await a.query("begin");const result=await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),a);assert.equal(result.status,"committed");
  await new Promise(r=>setTimeout(r,1100));const pending=f.rpc("clued_storage_queued_sweep_v1",f.issuer,{action:"due",dispatch:true},b).then(value=>({value}),error=>({error}));
  try{await locked();}finally{await a.query("commit");}const response=await pending;assert.equal(response.error,undefined,response.error?.message);
  assert.equal((await check(target.ref)).state,"resolved");assert.equal((await job(target.ref)).dispatch_outcome,null);
 });
 await t.test("an abnormal existing Receipt is not treated as absent or silently retried",async()=>{
  const target=await prepare(),state=await check(target.ref),req={idempotency_key:state.recovery_key,fixture:"abnormal pending metadata receipt"};
  await db.query("select clued_private.m1_begin_receipt($1,null,'storage_registration_recovery',$2,clued_private.m1_sha256($2))",[f.owner,req]);
  const inspected=await cloud({...target.input,action:"registration_inspect",registration:target.registration,lease_id:target.lease});
  assert.equal(inspected.status,"invalid");assert.equal(inspected.reason_code,"REGISTRATION_RECEIPT_INVALID");assert.equal((await check(target.ref)).state,"checking");assert.equal((await artifact(target.provider)).provider_file_version,"43");
 });
 await t.test("lock-proven absent commit with changed CAS ends that job immediately and a fresh same-file job can proceed",async()=>{
  const target=await f.addFile(),original=await job(target.ref),writes=f.getWrites(),calls=[];
  const result=await f.executeWorker(target.ref,input=>calls.push(structuredClone(input)),{rpc:async(input,normal)=>{
   if(input.action==="registration_commit")await f.register({action:"artifact_update",profile_id:f.profile,artifact_id:input.registration.artifact_id,
    base_version:input.registration.artifact_version,path:target.filePath,provider_file_id:target.provider,provider_file_version:"44",governance_class:"ordinary",delete_authority:false});
   return normal(input);
  }});
  assert.equal(result.status,"registration_recovery");assert.equal(result.registration_recovery.status,"failed");assert.equal(result.registration_recovery.reason_code,"REGISTRATION_CAS_CHANGED");
  assert.equal(calls.filter(x=>x.action==="registration_inspect").length,1);assert.equal(calls.some(x=>x.action==="begin"||x.action==="provider_attempt"),false);
  assert.equal((await check(target.ref)).state,"failed");assert.equal((await check(target.ref)).attempts,1);assert.equal((await job(target.ref)).intent_id,null);assert.equal(f.getWrites(),writes);
  assert.equal((await job(target.ref)).dispatch_outcome.status,"attention_required");assert.equal((await artifact(target.provider)).provider_file_version,"44");
  const fresh=await f.submit(original.mutation);assert.equal((await f.executeWorker(fresh)).status,"committed");
  await assert.rejects(cloud({...target.input,action:"registration_load"}),/storage_cloud_denied/);
  assert.equal((await job(target.ref)).intent_id,null);assert.deepEqual((await job(target.ref)).mutation,original.mutation);
 });
 await t.test("a real native permission-level cancellation closes its check and a new authorized job on the same file succeeds",async()=>{
  const target=await prepare(),original=await job(target.ref),access=async input=>(await f.native.query("select public.clued_storage_write_access_v1($1) v",[{connection_id:f.connection,...input}])).rows[0].v;
  const before=await access({action:"status"});assert.ok(before.classes.includes("overwrite"));
  assert.equal((await access({action:"set_classes",classes:[],base_generation:before.policy_generation,disclosure_version:before.overwrite_disclosure_version,idempotency_key:id()})).status,"committed");
  assert.equal((await job(target.ref)).dispatch_outcome.status,"denied");assert.equal((await check(target.ref)).state,"failed");
  assert.equal((await check(target.ref)).reason_code,"REGISTRATION_JOB_CLOSED");assert.equal((await job(target.ref)).intent_id,null);
  const closedStatus=(await db.query("select clued_private.storage_job_status_v1(j) v from clued_private.storage_jobs_v1 j where job_id=$1",[target.ref.job_id])).rows[0].v;
  assert.equal(closedStatus.status,"denied");assert.notEqual(closedStatus.reason_code,"REGISTRATION_JOB_CLOSED");assert.equal(closedStatus.registration_recovery.reason_code,"REGISTRATION_JOB_CLOSED");
  const disabled=await access({action:"status"});assert.equal((await access({action:"set_classes",classes:before.classes,base_generation:disabled.policy_generation,disclosure_version:disabled.overwrite_disclosure_version,idempotency_key:id()})).status,"committed");
  const fresh=await f.submit(original.mutation);assert.equal((await f.executeWorker(fresh)).status,"committed");
  assert.equal((await job(target.ref)).dispatch_outcome.status,"denied","the original cancelled job is never revived");
 });
 await t.test("two clients: native cancellation waits for metadata commit, then closes the original queued job",async()=>{
  const target=await prepare(),original=await job(target.ref),access=async input=>(await f.native.query("select public.clued_storage_write_access_v1($1) v",[{connection_id:f.connection,...input}])).rows[0].v,
   before=await access({action:"status"}),a=await f.connect();await setWorkerGatewayCaller(a);const locked=await waitLocked(f.native);
  await a.query("begin");assert.equal((await f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),a)).status,"committed");
  const pending=access({action:"set_classes",classes:[],base_generation:before.policy_generation,disclosure_version:before.overwrite_disclosure_version,idempotency_key:id()}).then(value=>({value}),error=>({error}));
  try{await locked();}finally{await a.query("commit");}const response=await pending;assert.equal(response.error,undefined,response.error?.message);assert.equal(response.value.status,"committed");
  assert.equal((await job(target.ref)).dispatch_outcome.status,"denied");assert.equal((await job(target.ref)).intent_id,null);assert.equal((await check(target.ref)).state,"resolved");
  await assert.rejects(cloud(commitInput(target)),/storage_policy_denied|storage_cloud_denied/);
  const disabled=await access({action:"status"});await access({action:"set_classes",classes:before.classes,base_generation:disabled.policy_generation,disclosure_version:disabled.overwrite_disclosure_version,idempotency_key:id()});
  const fresh=await f.submit(original.mutation);assert.equal((await f.executeWorker(fresh)).status,"committed");
 });
 await t.test("two clients: native cancellation commits first and a waiting old lease cannot refresh or execute",async()=>{
  const target=await prepare(),original=await job(target.ref),access=async input=>(await f.native.query("select public.clued_storage_write_access_v1($1) v",[{connection_id:f.connection,...input}])).rows[0].v,
   before=await access({action:"status"}),b=await f.connect();await setWorkerGatewayCaller(b);const locked=await waitLocked(b);
  await f.native.query("begin");assert.equal((await access({action:"set_classes",classes:[],base_generation:before.policy_generation,disclosure_version:before.overwrite_disclosure_version,idempotency_key:id()})).status,"committed");
  const pending=f.rpc("clued_storage_cloud_worker_router_v2",f.issuer,commitInput(target),b).then(value=>({value}),error=>({error}));
  try{await locked();}finally{await f.native.query("commit");}assert.match((await pending).error?.message??"",/storage_policy_denied|storage_cloud_denied/);
  assert.equal((await check(target.ref)).state,"failed");assert.equal((await artifact(target.provider)).provider_file_version,"43");assert.equal((await job(target.ref)).intent_id,null);
  const disabled=await access({action:"status"});await access({action:"set_classes",classes:before.classes,base_generation:disabled.policy_generation,disclosure_version:disabled.overwrite_disclosure_version,idempotency_key:id()});
  const fresh=await f.submit(original.mutation);assert.equal((await f.executeWorker(fresh)).status,"committed");
 });
 await t.test("persisted /3 identity accepts genuine historical credentials and rejects malformed or foreign identity",async()=>{
  const original=await f.createOriginal(),saved=(await db.query("select m.verified_result_v2 from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.job_id=$1",[original.ref.job_id])).rows[0].verified_result_v2;
  const compatible=async proof=>(await db.query("select clued_private.storage_delivery_issuer_compatible_v1(c,$2) ok from clued_private.storage_connections_v1 c where c.id=$1",[f.connection,proof])).rows[0].ok;
  assert.equal(await compatible(saved),true);assert.ok(saved.proof,"the original byte proof remains part of its Receipt-bound contract");
  assert.equal(await compatible({...saved,contract:"clued.storage-persisted-verification/2"}),true);
  for(const generation of [null,undefined,"1",0,-1,1.5,9223372036854776000])assert.equal(await compatible({...saved,credential_generation:generation}),false);
  for(const time of [null,undefined,123,"infinity","not-a-time","2026-99-99T25:00:00Z"])assert.equal(await compatible({...saved,recorded_at:time}),false);
  for(const key of ["issuer_hash","issuer_proof","issuer_verifier","credential_proof","verifier","issuer_secret","access_token","refresh_token"])assert.equal(await compatible({...saved,[key]:"not permitted"}),false);
  assert.equal(await compatible({...saved,issuer_id:id()}),false);assert.equal(await compatible({...saved,issuer_kind:"authorization"}),false);assert.equal(await compatible(null),false);
  const foreign=(await db.query("select id from clued_private.issuer_identities_v1 where kind='authorization' limit 1")).rows[0].id;
  assert.equal(await compatible({...saved,issuer_id:foreign}),false);
  const credential=(await db.query("select * from clued_private.issuer_credentials_v1 where issuer_id=$1 and generation=$2",[saved.issuer_id,saved.credential_generation])).rows[0];
  assert.equal(await compatible({...saved,recorded_at:new Date(credential.created_at.getTime()-1000).toISOString()}),false);
  let generation=100;
  for(const [created,activated,validUntil,retired] of [[-2,1,null,2],[-2,-1,0,2],[-2,-1,null,0],[-2,null,null,2]]){
   const copy={...saved,credential_generation:generation++},at=Date.parse(saved.recorded_at),time=offset=>offset===null?null:new Date(at+offset*1000).toISOString();
   await db.query("insert into clued_private.issuer_credentials_v1(issuer_id,generation,verifier,state,created_at,activated_at,valid_until,retired_at) values($1,$2,$3,'retired',$4,$5,$6,$7)",[saved.issuer_id,copy.credential_generation,"cv1:"+sha(id()),time(created),time(activated),time(validUntil),time(retired)]);
   assert.equal(await compatible(copy),false,JSON.stringify({created,activated,validUntil,retired}));
  }
  assert.equal(await compatible({...saved,credential_generation:generation+10000}),false);
  await db.query("begin");try{await db.query("update clued_private.issuer_credentials_v1 set state='retired',retired_at=$3::timestamptz+interval '1 second' where issuer_id=$1 and generation=$2",[saved.issuer_id,saved.credential_generation,saved.recorded_at]);assert.equal(await compatible(saved),true,"legitimately retired history remains readable");}finally{await db.query("rollback");}
 });
 await t.test('historical nonjob fault fixtures close with the actual entry upgrade and a genuine current cloud create',async()=>{
  const before=(await db.query('select clued_private.m1_sha256(jsonb_agg(to_jsonb(m) order by id)) digest from clued_private.resource_center_mutations_v1 m')).rows[0].digest;
  await f.installDurableEntry();
  assert.equal((await db.query('select clued_private.m1_sha256(jsonb_agg(to_jsonb(m) order by id)) digest from clued_private.resource_center_mutations_v1 m')).rows[0].digest,before);
  assert.equal((await db.query('select count(*)::int n from clued_private.storage_execution_entry_permits_v1')).rows[0].n,0);
  await f.createOriginal();assert.equal((await db.query('select count(*)::int n from clued_private.storage_execution_entry_permits_v1')).rows[0].n,0);
 });
 await t.test('the upgraded real Worker still refreshes and replaces one original file through the durable job',async()=>{
  const target=await f.addFile(),before=await job(target.ref),writes=f.getWrites(),calls=[];
  const result=await f.executeWorker(target.ref,input=>calls.push(structuredClone(input)));
  assert.equal(result.status,'committed',JSON.stringify(result));
  const after=await job(target.ref),registered=await artifact(target.provider),journal=(await db.query(
   'select * from clued_private.resource_center_mutations_v1 where id=$1',[after.intent_id])).rows[0];
  assert.deepEqual(after.mutation,before.mutation);assert.deepEqual(after.authority_snapshot_v2,before.authority_snapshot_v2);
  assert.equal(after.request_digest,before.request_digest);assert.equal(journal.state,'committed');
  assert.ok(journal.provider_attempt_receipt_id);assert.ok(journal.verified_receipt_id_v2);
  assert.equal(registered.provider_file_version,'47');assert.equal(f.files.get(target.provider).sha256Checksum,sha('replacement'));
  assert.equal(f.getWrites()-writes,2,'one revision pin and one multipart replacement, after installing the new gate');
  assert.equal(calls.filter(input=>input.action==='begin').length,1);assert.equal(calls.filter(input=>input.action==='provider_attempt').length,1);
  assert.equal((await db.query('select count(*)::int n from clued_private.storage_execution_entry_permits_v1')).rows[0].n,0);
 });
},{historicalNonjobFixtures:true}));
