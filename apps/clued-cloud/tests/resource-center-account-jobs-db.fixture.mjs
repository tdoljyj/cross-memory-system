import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { bindResourceCenterMutation } from "../../../kernel/policy/resource-center-mutation-policy.mjs";
const hash = s => createHash("sha256").update(s).digest("hex");

export async function testAccountJobs(t, admin, server, { user, decision, profile, connection, bindings, grant, revoke }) {
  const caller = server.getPgClient(); const competitor = server.getPgClient();
  await caller.connect(); await competitor.connect(); await caller.query("set role anon");
  const submit = async (job, mutation, index=0, client=caller, conn=connection) => (await client.query(
    "select public.clued_storage_jobs_v1($1,$2::jsonb) value", [bindings[index].token, JSON.stringify({ action:"submit", connection_id:conn, job_id:job, mutation })])).rows[0].value;
  const inspect = async job => (await caller.query("select public.clued_storage_jobs_v1($1,$2::jsonb) value", [bindings[1].token,
    JSON.stringify({ action:"inspect", connection_id:connection, job_id:job })])).rows[0].value;
  const mutation = { operation:"create", destination_path:"/account/Clued_资料中心/20_P_产品与体验/example.txt", target_kind:"file", content:"one exact payload" };
  const job = randomUUID(); let queued;
  const pendingJob = randomUUID();
  try {
    await t.test("one account job has a durable receipt and concurrent cross-client submits cannot duplicate it", async () => {
      await admin.query("update clued_private.storage_client_grants_v1 set actions=array['inspect','create_file'] where connection_id=$1 and binding_id=$2", [connection,bindings[1].binding]);
      try {
        const results = await Promise.all([submit(job,mutation),submit(job,mutation,1,competitor)]);
        assert.equal(results.filter(r=>!r.replayed).length,1);
        assert.equal(new Set(results.map(r=>r.receipt_id)).size,1);
        queued=results[0]; assert.equal(queued.status,"queued"); assert.equal(queued.execution_permitted,false);
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2",[user,job])).rows[0].n,1);
        assert.equal((await admin.query("select status from public.clued_audit_receipts where id=$1",[queued.receipt_id])).rows[0].status,"committed");
        // Pin original submitter for following revocation checks; production
        // never rewrites this identity. This fixture is an isolated database.
        await admin.query("update clued_private.storage_jobs_v1 set binding_id=$1,grant_receipt_id=(select receipt_id from clued_private.storage_client_grants_v1 where connection_id=$4 and binding_id=$1) where owner_id=$2 and job_id=$3",[bindings[0].binding,user,job,connection]);
      } finally {
        await admin.query("update clued_private.storage_client_grants_v1 set actions=array['inspect'] where connection_id=$1 and binding_id=$2", [connection,bindings[1].binding]);
      }
      assert.equal((await inspect(job)).request_digest,queued.request_digest);
      await assert.rejects(submit(job,{...mutation,content:"different"}),/storage_job_identity_conflict/);
      await assert.rejects(submit(job,{...mutation,destination_path:mutation.destination_path+"2"}),/storage_job_identity_conflict/);
      await assert.rejects(submit(randomUUID(),mutation,1),/storage_binding_denied/);
      await assert.rejects(submit(randomUUID(),mutation,0,caller,randomUUID()),/storage_binding_denied/);
      await submit(pendingJob,mutation);
    });
    await t.test("jobs reject caller authority, non-create operations and unbounded payloads", async () => {
      for(const extra of [{operation:"delete"},{managed_root:"/other"},{profile_id:profile},{artifact_role:"ordinary"},{content:null},{content:"x".repeat(1048577)}]) {
        await assert.rejects(submit(randomUUID(),{...mutation,...extra}),/storage_job_input_invalid/);
      }
      await assert.rejects(caller.query("select * from clued_private.storage_jobs_v1"),/permission denied/);
      await assert.rejects(caller.query("select clued_private.storage_job_begin_v1($1,$2,$3,'{}')",[user,job,hash("writer")]),/permission denied/);
      assert.equal((await admin.query("select has_function_privilege('service_role','clued_private.storage_job_begin_v1(uuid,uuid,text,jsonb)','EXECUTE') yes")).rows[0].yes,false);
    });
    const adminCall = async input => (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value",[user,JSON.stringify({idempotency_key:randomUUID(),source_decision_id:decision,...input})])).rows[0].value;
    assert.equal((await adminCall({action:"artifact_register",profile_id:profile,path:"/account/Clued_资料中心/20_P_产品与体验",
      provider_file_id:"account-track",provider_file_version:"2",target_kind:"directory",governance_class:"ordinary",delete_authority:false})).status,"committed");
    const authorityHash=hash("account-job-authority"), writerHash=hash("account-job-writer");
    const authority=await adminCall({action:"binding_issue",profile_id:profile,token_hash:authorityHash,expires_at:new Date(Date.now()+600000).toISOString()});
    const issued=(await admin.query("select public.clued_resource_center_writer_admin_v1($1,$2::jsonb) value",[user,JSON.stringify({action:"issue",authority_binding_id:authority.target_refs[0].id,
      source_decision_id:decision,token_hash:writerHash,idempotency_key:randomUUID(),expires_at:new Date(Date.now()+300000).toISOString()})])).rows[0].value;
    assert.equal(issued.status,"committed");
    const fullMutation={...mutation,artifact_role:"clued_resource"};
    const bound=bindResourceCenterMutation(fullMutation);
    const authorityRequest={profile_id:profile,profile_version:"account/1",policy_version:"clued.resource-center-mutation-policy/1",mutation:bound,
      provider_identity:{root_folder_id:"account-root",root_parent_id:"account-parent",root_folder_version:"1",source_file_id:null,source_file_version:null,
        destination_parent_id:"account-track",destination_parent_version:"2",destination_file_id:null,destination_file_version:null,provider_version:"a".repeat(64)}};
    const resolved=(await caller.query("select public.clued_resource_center_authority_v1($1,$2::jsonb) value",[authorityHash,JSON.stringify(authorityRequest)])).rows[0].value;
    assert.equal(resolved.status,"resolved");
    const prepare=id=>({action:"prepare",request_key:"account-job:"+id,idempotency_key:"account-job:"+id+":prepare",request_sha256:hash(JSON.stringify(fullMutation)),
      exact_request:{mutation:fullMutation,binding:{...bound,profile_id:profile,profile_version:"account/1",policy_version:"clued.resource-center-mutation-policy/1",
        request_sha256:hash(JSON.stringify(fullMutation)),artifact_authority_version:resolved.authority.authority_version,currentness_identity:resolved.authority.currentness_identity,governance_class:resolved.authority.governance_class}},authority_request:authorityRequest});
    const begin=async(id,client=admin,request=prepare(id))=>(await client.query("select clued_private.storage_job_begin_v1($1,$2,$3,$4::jsonb) value",[user,id,writerHash,JSON.stringify(request)])).rows[0].value;
    await t.test("account begin binds complete content and atomically consumes exactly one original journal start",async()=>{
      const changed=prepare(job);changed.exact_request.mutation={...fullMutation,content:"substituted"};
      await assert.rejects(begin(job,admin,changed),/storage_job_attempt_mismatch/);
      for(const change of [{destination_path:mutation.destination_path+"-other"},{target_kind:"directory",directory_semantics:"topic"},{artifact_role:"ordinary"},{source_path:"/other"}]){
        const mismatch=structuredClone(prepare(job));
        Object.assign(mismatch.authority_request.mutation,change);
        Object.assign(mismatch.exact_request.binding,change);
        await assert.rejects(begin(job,admin,mismatch),/storage_job_attempt_mismatch/);
      }
      const results=await Promise.all([begin(job),begin(job,competitor)]);
      assert.equal(results.filter(r=>r.execution_permitted===true).length,1);
      assert.equal(results.filter(r=>r.replayed===true).length,1);
      const status=await inspect(job);assert.equal(status.status,"started");assert.equal(status.execution_permitted,false);
      assert.equal((await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where id=$1",[status.intent_id])).rows[0].n,1);
      await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '1 hour' where id=$1",[status.intent_id]);
      assert.equal((await begin(job)).execution_permitted,false);
      await assert.rejects(begin(pendingJob),/storage_job_prepare_denied/);
      assert.equal((await inspect(pendingJob)).status,"queued");
      await assert.rejects(admin.query("select clued_private.storage_root_quiet_v1($1,'account-root')",[user]),/storage_root_has_unresolved_mutation/);
    });
    await t.test("provider attempt is exact, receipt-backed and single-recorded across database clients",async()=>{
      const status=await inspect(job);
      const attempt={contract:"clued.resource-center-provider-attempt/1",intent_id:status.intent_id,
        request_sha256:prepare(job).request_sha256,profile_id:profile,provider_file_id:"job-fixture-created",
        destination_path:mutation.destination_path,parent_id:"account-track",target_kind:"file",binding:prepare(job).exact_request.binding,
        size:String(Buffer.byteLength(mutation.content)),sha256:hash(mutation.content)};
      const record=async(value,client=admin,owner=user,id=job)=>(await client.query(
        "select clued_private.storage_job_provider_attempt_v1($1,$2,$3,$4::jsonb) value",[owner,id,writerHash,JSON.stringify(value)])).rows[0].value;
      for(const change of [{intent_id:randomUUID()},{profile_id:randomUUID()},{request_sha256:hash("wrong")},
        {parent_id:"other"},{destination_path:mutation.destination_path+"2"},{size:"0"},{sha256:hash("other")},{binding:{}},{unexpected:true}]){
        await assert.rejects(record({...attempt,...change}),/storage_attempt_mismatch/);
      }
      await assert.rejects(record(attempt,admin,randomUUID()),/storage_attempt_unavailable/);
      await assert.rejects(record(attempt,admin,user,pendingJob),/storage_attempt_unavailable/);
      await assert.rejects(record(attempt,caller),/permission denied/);
      for(const fn of ['storage_job_provider_attempt_v1','storage_job_finalize_v1']){
        for(const role of ['anon','authenticated','service_role']){
          assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') yes",[role,`clued_private.${fn}(uuid,uuid,text,jsonb)`])).rows[0].yes,false);
        }
      }
      const results=await Promise.all([record(attempt),record(attempt,competitor)]);
      assert.equal(results.filter(r=>r.attempt_recorded===true).length,1);
      assert.equal(results.filter(r=>r.status==='replayed'&&r.execution_permitted===false).length,1);
      assert.equal(new Set(results.map(r=>r.receipt_id)).size,1);
      const saved=(await admin.query("select provider_attempt,provider_attempt_receipt_id,version,state from clued_private.resource_center_mutations_v1 where id=$1",[status.intent_id])).rows[0];
      assert.deepEqual(saved.provider_attempt,attempt);assert.equal(saved.version,'2');assert.equal(saved.state,'started');
      assert.equal((await admin.query("select status from public.clued_audit_receipts where id=$1",[saved.provider_attempt_receipt_id])).rows[0].status,'committed');
      await assert.rejects(record({...attempt,provider_file_id:'second-id'}),/storage_attempt_conflict/);
      assert.equal((await begin(job)).execution_permitted,false);
      await assert.rejects(begin(pendingJob),/storage_job_prepare_denied/);
    });
    await t.test("revocation wins a genuinely waiting begin and preserves original pending fences",async()=>{
      const pid=(await competitor.query("select pg_backend_pid() pid")).rows[0].pid;
      let pending;
      await admin.query("begin");
      try {
        await admin.query("update clued_private.storage_client_grants_v1 set revoked_at=clock_timestamp() where connection_id=$1 and binding_id=$2",[connection,bindings[0].binding]);
        pending=begin(pendingJob,competitor).then(value=>({value}),error=>({error}));
        let waiting=false;
        for(let i=0;i<200;i++){
          waiting=(await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting;
          if(waiting)break;await new Promise(r=>setTimeout(r,10));
        }
        assert.equal(waiting,true);await admin.query("commit");
        assert.match((await pending).error?.message??"",/storage_binding_denied/);
        assert.equal((await inspect(job)).status,"started");
        assert.equal((await inspect(pendingJob)).status,"queued");
      }finally{
        await admin.query("rollback");if(pending)await pending;
        await admin.query("update clued_private.storage_client_grants_v1 set revoked_at=null where connection_id=$1 and binding_id=$2",[connection,bindings[0].binding]);
      }
    });
    await t.test("expiry while waiting for provider-root lock rolls back without a new intent",async()=>{
      const saved=(await admin.query("select expires_at from clued_private.storage_client_grants_v1 where connection_id=$1 and binding_id=$2",[connection,bindings[0].binding])).rows[0].expires_at;
      const pid=(await competitor.query("select pg_backend_pid() pid")).rows[0].pid;
      await admin.query("update clued_private.storage_client_grants_v1 set expires_at=clock_timestamp()+interval '1 second' where connection_id=$1 and binding_id=$2",[connection,bindings[0].binding]);
      await admin.query("begin");let pending;
      try{
        await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[user+":account-root"]);
        pending=begin(pendingJob,competitor).then(value=>({value}),error=>({error}));
        let waiting=false;
        for(let i=0;i<200;i++){
          waiting=(await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting;
          if(waiting)break;await new Promise(r=>setTimeout(r,10));
        }
        assert.equal(waiting,true);
        await admin.query("select pg_sleep(greatest(0,extract(epoch from(expires_at-clock_timestamp())))+0.02) from clued_private.storage_client_grants_v1 where connection_id=$1 and binding_id=$2",[connection,bindings[0].binding]);
        await admin.query("commit");assert.match((await pending).error?.message??"",/storage_binding_denied/);
        assert.equal((await inspect(pendingJob)).status,"queued");
      }finally{
        await admin.query("rollback");if(pending)await pending;
        await admin.query("update clued_private.storage_client_grants_v1 set expires_at=$3 where connection_id=$1 and binding_id=$2",[connection,bindings[0].binding,saved]);
      }
    });
    await t.test("status follows original Canonical finalization, never fabricates completion from a cached job",async()=>{
      const status=await inspect(job);
      // This entire test uses a temporary database and synthetic provider; no
      // Drive call or real file exists. Complete its original journal so the
      // later OAuth fixture can test the same account root independently.
      const finish={action:"finalize",intent_id:status.intent_id,
        base_version:2,request_sha256:prepare(job).request_sha256,idempotency_key:randomUUID(),
        postcondition:{path:mutation.destination_path,parent_id:"account-track",provider_file_id:"job-fixture-created",provider_file_version:"1"}};
      const finalize=async input=>(await admin.query("select clued_private.storage_job_finalize_v1($1,$2,$3,$4::jsonb) value",[user,job,writerHash,JSON.stringify(input)])).rows[0].value;
      await assert.rejects(finalize({...finish,postcondition:{...finish.postcondition,provider_file_id:'wrong-id'}}),/storage_attempt_postcondition_mismatch/);
      const result=await finalize(finish);
      assert.equal(result.state,"committed");
      assert.equal((await inspect(job)).status,"committed");assert.equal((await inspect(job)).execution_permitted,false);
      assert.equal((await begin(job)).execution_permitted,false);
    });
    await t.test("formal revoke and regrant cannot revive a queued job from the previous grant generation",async()=>{
      await revoke(0);
      await assert.rejects(begin(pendingJob),/storage_binding_denied/);
      await grant(0,["inspect","create_file"]);
      await assert.rejects(begin(pendingJob),/storage_job_grant_changed/);
      assert.equal((await submit(pendingJob,mutation)).replayed,true);
      await assert.rejects(begin(pendingJob),/storage_job_grant_changed/);
      assert.equal((await inspect(pendingJob)).status,"queued");
      // A new explicitly submitted job gets the new grant receipt. The old
      // job stays immutable; inspecting/replaying it never re-admits it.
      const fresh=randomUUID();await submit(fresh,mutation);
      const rows=(await admin.query("select job_id,grant_receipt_id from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=any($2::uuid[])",[user,[pendingJob,fresh]])).rows;
      assert.equal(new Set(rows.map(r=>r.grant_receipt_id)).size,2);
    });
    await t.test("connection replacement cannot evade account-wide job identity",async()=>{
      const project=(await admin.query("select project_id from clued_private.resource_center_profiles_v1 where id=$1",[profile])).rows[0].project_id;
      const registered=await adminCall({action:"profile_register",project_id:project,profile_version:"account-replacement/1",managed_root:"/account-replacement/Clued_资料中心",
        root_folder_id:"job-replacement-root",root_parent_id:"account-parent",root_folder_version:"1"});
      assert.equal(registered.status,"committed");
      const replacement=randomUUID();
      await admin.query("insert into clued_private.storage_connections_v1(id,owner_id,profile_id,profile_version,source_decision_id,decision_version,provider,provider_subject,oauth_client_id,state,credential_version,credential_envelope,receipt_id) select $2,owner_id,$3,1,source_decision_id,decision_version,provider,provider_subject,oauth_client_id,state,credential_version,credential_envelope,receipt_id from clued_private.storage_connections_v1 where id=$1",[connection,replacement,registered.target_refs[0].id]);
      await admin.query("insert into clued_private.storage_client_grants_v1(connection_id,binding_id,authorization_version,actions,expires_at,receipt_id) select $2,binding_id,authorization_version,actions,expires_at,receipt_id from clued_private.storage_client_grants_v1 where connection_id=$1 and binding_id=$3",[connection,replacement,bindings[0].binding]);
      await assert.rejects(submit(job,mutation,0,caller,replacement),/storage_job_identity_conflict/);
    });
  }finally{await caller.end();await competitor.end();}
}
