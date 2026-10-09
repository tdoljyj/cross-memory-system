import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export async function testDirectoryProbe(t, admin, server, user, decision) {
  await allowTestIssuerCredentials(admin);
  const session = randomUUID(), issuer = createHash("sha256").update(randomUUID()).digest("hex");
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const native = server.getPgClient(); await native.connect();
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session,user]);
  await native.query("set role authenticated");
  const login = async sid => native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user,JSON.stringify({sub:user,session_id:sid})]);
  await login(session);
  const register = async input => {
    const result=(await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) v",[user,JSON.stringify({source_decision_id:decision,idempotency_key:randomUUID(),...input})])).rows[0].v;
    assert.equal(result.status,"committed",JSON.stringify(result)); return result;
  };
  const profile = (await register({action:"profile_register",project_id:project,profile_version:"directory-probe/1",managed_root:"/probe/Clued_资料中心",
    root_folder_id:"probe-root",root_parent_id:"probe-parent",root_folder_version:"1"})).target_refs.find(r=>r.role==="primary").id;
  for (const [path,id] of [["20_P_产品与体验","probe-track"],["20_P_产品与体验/主题","probe-topic"],["00_从这里开始","probe-start"]]) {
    await register({action:"artifact_register",profile_id:profile,path:"/probe/Clued_资料中心/"+path,provider_file_id:id,
      provider_file_version:"1",target_kind:"directory",governance_class:"ordinary",delete_authority:false});
  }
  const connection = (await native.query("select public.clued_storage_account_v1($1::jsonb) v",[JSON.stringify({action:"register",profile_id:profile,source_decision_id:decision,idempotency_key:randomUUID()})])).rows[0].v.target_refs[0].id;
  const envelope = {contract:"clued.storage-credential/1",key_id:"fixture",nonce:"x".repeat(16),ciphertext:"y".repeat(24)};
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,'probe-client','https://probe.invalid/storage/google/callback')",[issuer]);
  // Synthetic database only. Production never activates by an UPDATE shortcut.
  await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='probe-subject',oauth_client_id='probe-client',credential_version=1,credential_envelope=$2 where id=$1",[connection,envelope]);
  const call = async (input, hash=issuer) => (await native.query("select public.clued_storage_directory_probe_v1($1,$2::jsonb) v",[hash,JSON.stringify(input)])).rows[0].v;
  const prepare = () => call({action:"prepare",connection_id:connection});
  const observation = p => ({contract:"clued.storage-directory-observation/1",status:"metadata_observed",execution_permitted:false,observed_at_ms:Date.now(),
    directories:p.descriptor.layout.directories.map(e=>({...e,provider_file_version:"2",parent_id:e.path===p.descriptor.layout.managed_root ? p.descriptor.layout.root_parent_id :
      p.descriptor.layout.directories.find(parent=>parent.path===e.path.slice(0,e.path.lastIndexOf("/"))).provider_file_id}))});
  const finish = (p,o=observation(p)) => call({action:"complete",attempt_id:p.attempt_id,observation:o});
  const state = async () => (await admin.query(`select
    (select to_jsonb(c) from clued_private.storage_connections_v1 c where id=$1) connection,
    (select to_jsonb(p) from clued_private.resource_center_profiles_v1 p where id=$2) profile,
    (select count(*)::int from clued_private.storage_client_grants_v1) grants,
    (select count(*)::int from clued_private.storage_jobs_v1) jobs,
    (select count(*)::int from clued_private.resource_center_mutations_v1) intents,
    (select execution_enabled from clued_private.storage_oauth_apps_v1 where issuer_hash=$3) execution`,[connection,profile,issuer])).rows[0];
  try {
    await t.test("directory probe requires native Owner plus issuer; no caller layout or raw table access",async()=>{
      await assert.rejects(call({action:"prepare",connection_id:connection},"f".repeat(64)),/probe_denied/);
      await login(randomUUID()); await assert.rejects(prepare(),/storage_native_session_required/); await login(session);
      for(const extra of [{owner_id:user},{profile_id:profile},{managed_root:"/caller"},{observation:{}},{credential_envelope:envelope}])
        await assert.rejects(call({action:"prepare",connection_id:connection,...extra}),/probe_denied/);
      await assert.rejects(call({action:"prepare",connection_id:randomUUID()}),/probe_denied/);
      await assert.rejects(native.query("select * from clued_private.storage_directory_probes_v1"),/permission denied/);
      await assert.rejects(native.query("select clued_private.storage_directory_descriptor_v1($1,$2)",[user,connection]),/permission denied/);
      const p=await prepare(); assert.equal(p.descriptor.layout.directories.length,3);
      assert.deepEqual(p.descriptor.layout.allowed_root_children,["20_P_产品与体验"]);
      assert.equal(JSON.stringify(p.descriptor).includes("ciphertext"),false);
    });
    await t.test("directory observation is exact, single-commit and cannot activate or alter storage",async()=>{
      const before=await state(), p=await prepare(), o=observation(p), r=await finish(p,o);
      assert.equal(r.status,"metadata_observed"); assert.equal(r.execution_permitted,false);
      assert.deepEqual(Object.keys(r).sort(),["attempt_id","execution_permitted","receipt_id","status"]);
      assert.deepEqual(await finish(p,o),r);
      assert.deepEqual(await state(),before);
      const saved=(await admin.query("select * from clued_private.storage_directory_probes_v1 where id=$1",[p.attempt_id])).rows[0];
      assert.deepEqual(saved.observation,o); assert.equal(saved.receipt_id,r.receipt_id);
      const receipt=(await admin.query("select * from public.clued_audit_receipts where id=$1",[r.receipt_id])).rows[0];
      assert.equal(receipt.status,"committed"); assert.equal(JSON.stringify(receipt).includes(envelope.ciphertext),false);
      await assert.rejects(finish(p,{...o,observed_at_ms:o.observed_at_ms+1}),/probe_conflict/);
    });
    await t.test("directory observation may carry each directory's sharing digest",async()=>{
      const p=await prepare(), o=observation(p);
      const withDigest={...o,directories:o.directories.map((e,i)=>({...e,provider_sharing_digest:i?null:"a".repeat(64)}))};
      assert.equal((await finish(p,withDigest)).status,"metadata_observed");
      const q=await prepare(), base=observation(q);
      for(const digest of ["not-hex",{},"A".repeat(64)])
        await assert.rejects(finish(q,{...base,directories:base.directories.map((e,i)=>i?e:{...e,provider_sharing_digest:digest})}),/probe_invalid/);
    });
    await t.test("storage step 2: directory observation may carry each directory's access digest",async()=>{
      const p=await prepare(), o=observation(p);
      const withDigest={...o,directories:o.directories.map((e,i)=>({...e,provider_access_digest:i?null:"b".repeat(64)}))};
      assert.equal((await finish(p,withDigest)).status,"metadata_observed");
      const q=await prepare(), base=observation(q);
      for(const digest of ["not-hex",{},"B".repeat(64),1])
        await assert.rejects(finish(q,{...base,directories:base.directories.map((e,i)=>i?e:{...e,provider_access_digest:digest})}),/probe_invalid/);
    });
    await t.test("browser-editable or incomplete observations cannot become evidence",async()=>{
      const p=await prepare(), o=observation(p);
      for(const bad of [{...o,execution_permitted:true},{...o,credential_envelope:envelope},
        {...o,directories:o.directories.slice(1)},{...o,observed_at_ms:1},
        {...o,directories:[o.directories[0],o.directories[0],o.directories[2]]},
        {...o,directories:o.directories.map((e,i)=>i?e:{...e,parent_id:"elsewhere"})},
        {...o,directories:o.directories.map((e,i)=>i?e:{...e,provider_file_id:"elsewhere"})}])
        await assert.rejects(finish(p,bad),/probe_invalid/);
      assert.equal((await admin.query("select receipt_id from clued_private.storage_directory_probes_v1 where id=$1",[p.attempt_id])).rows[0].receipt_id,null);
    });
    await t.test("credential/connection/Decision drift, new directory and revoked issuer invalidate a probe",async()=>{
      let p=await prepare();
      await admin.query("update clued_private.storage_connections_v1 set credential_version=credential_version+1 where id=$1",[connection]);
      await assert.rejects(finish(p),/probe_stale/);
      p=await prepare(); await admin.query("update clued_private.storage_connections_v1 set version=version+1 where id=$1",[connection]);
      await assert.rejects(finish(p),/probe_stale/);
      p=await prepare(); await admin.query("update clued_private.storage_connections_v1 set credential_envelope=jsonb_set(credential_envelope,'{ciphertext}',to_jsonb(repeat('z',24))) where id=$1",[connection]);
      await assert.rejects(finish(p),/probe_stale/);
      p=await prepare(); await register({action:"artifact_register",profile_id:profile,path:"/probe/Clued_资料中心/20_P_产品与体验/第二主题",provider_file_id:"probe-topic-2",provider_file_version:"1",target_kind:"directory",governance_class:"ordinary",delete_authority:false});
      await assert.rejects(finish(p),/probe_stale/);
      p=await prepare(); await admin.query("update public.clued_memories set version=version+1 where id=$1",[decision]);
      try {await assert.rejects(finish(p),/storage_connection_unavailable/);} finally {await admin.query("update public.clued_memories set version=version-1 where id=$1",[decision]);}
      p=await prepare(); await admin.query("update clued_private.storage_oauth_apps_v1 set revoked_at=clock_timestamp() where issuer_hash=$1",[issuer]);
      try {await assert.rejects(finish(p),/probe_denied/);} finally {await admin.query("update clued_private.storage_oauth_apps_v1 set revoked_at=null where issuer_hash=$1",[issuer]);}
    });
    await t.test("attempt expiry and native session expiry after actual lock waits roll back evidence",async()=>{
      const pid=(await native.query("select pg_backend_pid() pid")).rows[0].pid;
      const waitForLock=async()=>{
        for(let i=0;i<200;i++) {
          if((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting)return;
          await new Promise(r=>setTimeout(r,10));
        }
        assert.fail("probe did not reach lock wait");
      };
      for(const expireSession of [false,true]) {
        const p=await prepare(), o=observation(p); let pending;
        if(expireSession)await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[session]);
        else await admin.query("update clued_private.storage_directory_probes_v1 set expires_at=clock_timestamp()+interval '1 second' where id=$1",[p.attempt_id]);
        await admin.query("begin");
        try {
          await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[user+":probe-root"]);
          pending=finish(p,o).then(value=>({value}),error=>({error}));
          await waitForLock(); await admin.query("select pg_sleep(1.05)"); await admin.query("commit");
          assert.match((await pending).error?.message??"",expireSession?/storage_native_session_required/:/probe_stale/);
          assert.equal((await admin.query("select receipt_id from clued_private.storage_directory_probes_v1 where id=$1",[p.attempt_id])).rows[0].receipt_id,null);
        } finally {
          await admin.query("rollback"); if(pending)await pending;
          await admin.query("update auth.sessions set not_after=null where id=$1",[session]);
        }
      }
    });
    await t.test("probe is bound to exact native session and expires without writes",async()=>{
      const p=await prepare(), other=randomUUID(); await admin.query("insert into auth.sessions(id,user_id) values($1,$2)",[other,user]);
      await login(other); await assert.rejects(finish(p),/probe_denied/); await login(session);
      await admin.query("update clued_private.storage_directory_probes_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1",[p.attempt_id]);
      await assert.rejects(finish(p),/probe_stale/);
      await admin.query("update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",[session]);
      await assert.rejects(prepare(),/storage_native_session_required/);
    });
  } finally {await native.end();}
}
