import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { testAccountJobs } from "./resource-center-account-jobs-db.fixture.mjs";
import { testCloudBridge } from "./resource-center-cloud-bridge-db.fixture.mjs";
const hash = s => createHash("sha256").update(s).digest("hex");

export async function testStorageAccount(t, admin, server, user, decision) {
  await admin.query("create table if not exists auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz)");
  const session = randomUUID();
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const native = server.getPgClient(); await native.connect();
  await native.query("set role authenticated");
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify({ sub: user, session_id: session })]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const pid = (await native.query("select pg_backend_pid() pid")).rows[0].pid;
  const waitForLock = async () => {
    for (let i=0;i<200;i++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting", [pid])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("native request did not reach its intended lock wait");
  };
  const input = (action, rest = {}) => ({ action, idempotency_key: randomUUID(), ...rest });
  const profileResult = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user, JSON.stringify({ action: "profile_register", project_id: project,
    profile_version: "account/1", managed_root: "/account/Clued_资料中心", root_folder_id: "account-root", root_parent_id: "account-parent", root_folder_version: "1", source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  const profile = profileResult.target_refs.find(r => r.role === "primary").id;
  let connection, version;
  const created = input("register", { profile_id: profile, source_decision_id: decision });
  try {
    await t.test("account register is native-session only, idempotent and awaiting provider", async () => {
      const result = await account(created); connection = result.target_refs[0].id; version = result.committed_versions[connection];
      assert.deepEqual(await account(created), result);
      const listed = (await account({ action: "list" })).connections.find(c => c.id === connection);
      assert.equal(listed.state, "awaiting_provider");
      assert.equal("credential_envelope" in listed, false);
      await assert.rejects(account(input("register", { profile_id: profile, source_decision_id: decision, owner_id: randomUUID() })), /storage_input_invalid/);
      await native.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, session_id: randomUUID() })]);
      await assert.rejects(account({ action: "list" }), /storage_native_session_required/);
      await native.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, session_id: session, client_id: "delegated" })]);
      await assert.rejects(account({ action: "list" }), /direct_human_session_required/);
      await native.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, session_id: session })]);
    });
    const bindings = [];
    for (let i = 0; i < 2; i++) {
      const issuer = hash("account-issuer-" + i), token = hash("account-binding-" + i);
      await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,'https://test.invalid/mcp','test')", [issuer]);
      const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [issuer, JSON.stringify({ request_digest: hash(randomUUID()),
        client_id: "storage-client-"+i, client_name: "test", redirect_uri: "https://test.invalid/cb", resource: "https://test.invalid/mcp", requested_scopes: ["context:write"] })])).rows[0].value;
      const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [issuer, prepared.request_id, prepared.version,
        JSON.stringify([{ resource_kind: "scope", resource_id: "project:"+project, environment: "canonical", actions: ["write", "close"] }]), token, new Date(Date.now()+3600000).toISOString()])).rows[0].value;
      const binding = approved.binding_id;
      assert.equal((await admin.query("select to_jsonb(b)->>'expires_at' legacy_expiry from public.clued_agent_bindings b where id=$1", [binding])).rows[0].legacy_expiry, null);
      bindings.push({ binding, token });
    }
    const check = async (index, action = "create_file") => (await admin.query("select (clued_private.storage_binding_v1($1,$2,$3)).id id", [bindings[index].token, connection, action])).rows[0].id;
    const grant = async (i, actions) => {
      const r = await account(input("grant_client", { connection_id: connection, base_version: version, binding_id: bindings[i].binding,
        authorization_version: 1, actions, expires_at: new Date(Date.now() + 1800000).toISOString() }));
      version = r.committed_versions[connection]; return r;
    };
    await t.test("empty native grant readback works without a mandatory legacy Binding expiry",async()=>{
      const view=await account({action:"client_grants",connection_id:connection});
      assert.deepEqual(view.grants,[]);assert.equal(view.connection_id,connection);
    });
    await t.test("context write and account ownership do not grant storage; provider must be qualified", async () => {
      await assert.rejects(check(0), /storage_binding_denied/);
      await assert.rejects(grant(0, ["create_file"]), /storage_connection_unavailable/);
      // Isolated fixture only: production activation must be a verified OAuth path.
      await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='fixture-subject',oauth_client_id='fixture-client',credential_version=1,credential_envelope='{}' where id=$1", [connection]);
      await assert.rejects(check(0), /storage_binding_denied/);
      await assert.rejects(grant(0, ["delete"]), /storage_binding_denied/);
      await grant(0, ["inspect", "create_file"]); await grant(1, ["inspect"]);
      assert.equal(await check(0), bindings[0].binding);
      await assert.rejects(check(1), /storage_binding_denied/);
      assert.equal(await check(1, "inspect"), bindings[1].binding);
    });
    await t.test("v12 expiry is mandatory and an optional earlier legacy fence never extends it",async()=>{
      const id=bindings[0].binding;
      const original=(await admin.query("select expires_at from clued_private.authorizations_v12 where binding_id=$1",[id])).rows[0].expires_at;
      const hasLegacy=(await admin.query("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='clued_agent_bindings' and column_name='expires_at') present")).rows[0].present;
      const tooLong=()=>account(input("grant_client",{connection_id:connection,base_version:version,binding_id:id,
        authorization_version:1,actions:["inspect"],expires_at:new Date(Date.now()+7200000).toISOString()}));
      await assert.rejects(tooLong(),/storage_binding_denied/);
      try {
        await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1",[id]);
        await assert.rejects(check(0),/storage_binding_denied/);
        await assert.rejects(grant(0,["inspect"]),/storage_binding_denied/);
        assert.equal((await account({action:"client_grants",connection_id:connection})).grants.find(g=>g.binding_id===id).binding_current,false);
      } finally {await admin.query("update clued_private.authorizations_v12 set expires_at=$2 where binding_id=$1",[id,original]);}
      if(hasLegacy) {
        try {
          await admin.query("update public.clued_agent_bindings set expires_at=clock_timestamp()+interval '5 minutes' where id=$1",[id]);
          assert.equal(await check(0),id);
          await assert.rejects(grant(0,["inspect"]),/storage_binding_denied/);
          await admin.query("update public.clued_agent_bindings set expires_at=clock_timestamp()-interval '1 second' where id=$1",[id]);
          await assert.rejects(check(0),/storage_binding_denied/);
          await assert.rejects(grant(0,["inspect"]),/storage_binding_denied/);
          assert.equal((await account({action:"client_grants",connection_id:connection})).grants.find(g=>g.binding_id===id).binding_current,false);
        } finally {await admin.query("update public.clued_agent_bindings set expires_at=null where id=$1",[id]);}
      }
      assert.equal(await check(0),id);
    });
    await t.test("v12 expiry during an actual connection lock wait rejects grant and rolls back receipts",async()=>{
      const id=bindings[0].binding;
      const original=(await admin.query("select expires_at from clued_private.authorizations_v12 where binding_id=$1",[id])).rows[0].expires_at;
      const before=(await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n;
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '1 second' where binding_id=$1",[id]);
      await admin.query("begin");let pending;
      try {
        await admin.query("select id from clued_private.storage_connections_v1 where id=$1 for update",[connection]);
        pending=grant(0,["inspect"]).then(value=>({value}),error=>({error}));
        await waitForLock();
        await admin.query("select pg_sleep(greatest(0,extract(epoch from (expires_at-clock_timestamp())))+0.02) from clued_private.authorizations_v12 where binding_id=$1",[id]);
        await admin.query("commit");
        assert.match((await pending).error?.message??"",/storage_binding_denied/);
        assert.equal((await admin.query("select version from clued_private.storage_connections_v1 where id=$1",[connection])).rows[0].version,String(version));
        assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n,before);
      } finally {
        await admin.query("rollback");if(pending)await pending;
        await admin.query("update clued_private.authorizations_v12 set expires_at=$2 where binding_id=$1",[id,original]);
      }
    });
    await t.test("native client-grant readback is exact, owner-scoped, metadata-only and has no write effects", async () => {
      const read = {action:"client_grants",connection_id:connection};
      const before = (await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n;
      const view = await account(read);
      assert.deepEqual(Object.keys(view).sort(),["connection_id","connection_state","connection_version","grants"]);
      assert.equal(view.connection_id,connection);assert.equal(view.connection_version,version);assert.equal(view.connection_state,"active");
      assert.equal(view.grants.length,2);
      for(const g of view.grants) {
        assert.deepEqual(Object.keys(g).sort(),["actions","authorization_version","binding_current","binding_id","expires_at","receipt_id","revoked_at"]);
        assert.equal(g.binding_current,true);assert.equal(g.revoked_at,null);assert.equal(g.authorization_version,1);
      }
      await assert.rejects(account({...read,owner_id:user}),/storage_input_invalid/);
      await assert.rejects(account({...read,managed_root:"/caller"}),/storage_input_invalid/);
      await assert.rejects(account({action:"client_grants"}),/storage_input_invalid/);
      const other = randomUUID(), otherSession=randomUUID();
      await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'other-storage@example.invalid',now())",[other]);
      await admin.query("insert into auth.sessions(id,user_id) values($1,$2)",[otherSession,other]);
      try {
        await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[other,JSON.stringify({sub:other,session_id:otherSession})]);
        await assert.rejects(account(read),/storage_connection_unavailable/);
        await assert.rejects(account({...read,connection_id:randomUUID()}),/storage_connection_unavailable/);
      } finally {
        await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify({sub:user,session_id:session})]);
      }
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n,before);
      assert.equal((await account(read)).connection_version,version);
      await assert.rejects(native.query("select clued_private.storage_client_grants_read_v1($1::jsonb)",[JSON.stringify(read)]),/permission denied/);
    });
    await t.test("readback rechecks native session expiry after a connection lock wait",async()=>{
      await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[session]);
      await admin.query("begin");let pending;
      try {
        await admin.query("select id from clued_private.storage_connections_v1 where id=$1 for update",[connection]);
        pending=account({action:"client_grants",connection_id:connection}).then(value=>({value}),error=>({error}));
        await waitForLock();
        await admin.query("select pg_sleep(greatest(0,extract(epoch from (not_after-clock_timestamp())))+0.02) from auth.sessions where id=$1",[session]);
        await admin.query("commit");assert.match((await pending).error?.message??"",/storage_native_session_required/);
      } finally {
        await admin.query("rollback");if(pending)await pending;
        await admin.query("update auth.sessions set not_after=null where id=$1",[session]);
      }
    });
    await testAccountJobs(t, admin, server, { user, decision, profile, connection, bindings, grant,
      revoke: async i => {
        const r=await account(input("revoke_client", {connection_id:connection,base_version:version,binding_id:bindings[i].binding}));
        version=r.committed_versions[connection];return r;
      },
    });
    await testCloudBridge(t,admin,server,{user,profile,decision,connection,bindings,native,
      revoke:async()=>{
        version=Number((await admin.query('select version from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0].version);
        const r=await account(input('revoke_client',{connection_id:connection,base_version:version,binding_id:bindings[0].binding}));
        version=r.committed_versions[connection];
      }});
    version=Number((await admin.query('select version from clued_private.storage_connections_v1 where id=$1',[connection])).rows[0].version);
    await t.test("session expiry during a real connection lock wait rolls back grant and receipt", async () => {
      await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '3 seconds' where id=$1", [session]);
      await admin.query("begin");
      let pending;
      try {
        await admin.query("select id from clued_private.storage_connections_v1 where id=$1 for update", [connection]);
        pending = grant(1, ["inspect", "create_file"]).then(value => ({ value }), error => ({ error }));
        await waitForLock();
        await admin.query("select pg_sleep(greatest(0,extract(epoch from (not_after-clock_timestamp())))+0.02) from auth.sessions where id=$1", [session]);
        await admin.query("commit");
        assert.match((await pending).error?.message ?? "", /storage_native_session_required/);
        assert.equal((await admin.query("select version from clued_private.storage_connections_v1 where id=$1", [connection])).rows[0].version, String(version));
        await assert.rejects(check(1), /storage_binding_denied/);
      } finally {
        await admin.query("rollback"); if (pending) await pending;
        await admin.query("update auth.sessions set not_after=null where id=$1", [session]);
      }
    });
    await t.test("Decision revocation winning the lock prevents new registration", async () => {
      const request = input("register", { profile_id: profile, source_decision_id: decision });
      await admin.query("begin"); let pending;
      try {
        await admin.query("select id from public.clued_memories where id=$1 for update", [decision]);
        pending = account(request).then(value => ({ value }), error => ({ error }));
        await waitForLock();
        await admin.query("update public.clued_memories set lifecycle_status='revoked' where id=$1", [decision]);
        await admin.query("commit");
        assert.match((await pending).error?.message ?? "", /storage_registration_denied/);
      } finally {
        await admin.query("rollback"); if (pending) await pending;
        await admin.query("update public.clued_memories set lifecycle_status='active' where id=$1", [decision]);
      }
    });
    await t.test("OAuth reduce/revoke, connection revoke, expiry and policy drift fail closed", async () => {
      await native.query("select public.clued_authorization_manage_v12($1::jsonb)", [JSON.stringify({ op: "reduce", binding_id: bindings[0].binding, base_version: 1,
        selected: [{ resource_kind: "scope", resource_id: "project:"+project, environment: "canonical", actions: ["write"] }] })]);
      await assert.rejects(check(0), /storage_binding_denied/);
      assert.equal(await check(1, "inspect"), bindings[1].binding);
      assert.equal((await account({action:"client_grants",connection_id:connection})).grants.find(g=>g.binding_id===bindings[0].binding).binding_current,false);
      await native.query("select public.clued_authorization_manage_v12($1::jsonb)", [JSON.stringify({ op: "revoke", binding_id: bindings[0].binding, base_version: 2 })]);
      await assert.rejects(check(0), /storage_binding_denied/);
      await admin.query("begin");
      try {
        await admin.query("update clued_private.resource_center_profiles_v1 set version=version+1 where id=$1", [profile]);
        await assert.rejects(check(1, "inspect"), /storage_connection_unavailable/);
      } finally { await admin.query("rollback"); }
      const revoke = input("revoke_connection", { connection_id: connection, base_version: version });
      const stopped = await account(revoke);
      assert.deepEqual(await account(revoke), stopped);
      await assert.rejects(check(1, "inspect"), /storage_connection_unavailable/);
      const stored = (await admin.query("select * from clued_private.storage_connections_v1 where id=$1", [connection])).rows[0];
      assert.equal(stored.state, "revoked"); assert.ok(stored.credential_envelope);
      const readback=await account({action:"client_grants",connection_id:connection});
      assert.equal(readback.connection_state,"revoked");assert.equal(readback.grants.length,2);
    });
    await t.test("logged-out native JWT cannot manage storage while independent grants are not session clones", async () => {
      await admin.query("delete from auth.sessions where id=$1", [session]);
      await assert.rejects(account({ action: "list" }), /storage_native_session_required/);
      await assert.rejects(account({ action: "client_grants", connection_id:connection }), /storage_native_session_required/);
      assert.equal((await admin.query("select revoked_at from clued_private.authorizations_v12 where binding_id=$1", [bindings[1].binding])).rows[0].revoked_at, null);
    });
    await t.test("private storage rows and internal authorization are unavailable to public clients", async () => {
      await assert.rejects(native.query("select * from clued_private.storage_connections_v1"), /permission denied/);
      await assert.rejects(native.query("select * from clued_private.storage_client_grants_v1"), /permission denied/);
      await assert.rejects(native.query("select clued_private.storage_binding_v1($1,$2,'inspect')", [bindings[1].token,connection]), /permission denied/);
      const caller = server.getPgClient(); await caller.connect();
      try { await caller.query("set role anon");await assert.rejects(caller.query("select public.clued_storage_account_v1('{}')"), /permission denied/); }
      finally { await caller.end(); }
    });
  } finally { await native.end(); }
}
