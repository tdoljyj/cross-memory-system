import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const BUDGET = "public.clued_storage_budget_v1";
const READ = "public.clued_storage_read_v1";
const ACCESS = "public.clued_storage_read_access_v1";
const CONTENT_DISCLOSURE = "clued.storage-read-content-disclosure/1";
const MIB = 1024 * 1024, GIB = 1024 * MIB, IMAGE = 5 * MIB;

// StorageNormalUse.v0.1 N4 (§7.3, 20261001020000): Owner-adjustable hourly
// budgets at the database layer. A separate owner keeps the account totals
// independent of the receipts other fixtures leave in the rolling hour.
// Synthetic, disposable PostgreSQL only.
export async function testStorageBudget(t, admin, server, mainUser) {
  const clients = [], user = randomUUID(), project = randomUUID(), decision = randomUUID();
  const session = randomUUID(), issuer = sha(randomUUID()), clientIssuer = sha(randomUUID());
  const oauthClient = `budget-${randomUUID()}`, resource = "https://budget.invalid/mcp";
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    return database;
  };
  await admin.query("insert into auth.users(id,email) values($1,'budget-owner@example.invalid')", [user]);
  await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)" +
    " values($1,$2,'Budget fixture','budget fixture',$3,'confirmed',now())", [project, user, "project:" + project]);
  await admin.query("insert into public.clued_memories(" +
    "id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status," +
    "canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)" +
    " values($1,$2,'Owner approval','Temporary test objects only','project',$3,'decision','active',1,'active'," +
    "$4,'{\"rationale\":\"Test registration\"}','{}','{}','user_explicit','Owner confirmed')",
  [decision, user, project, "project:" + project]);
  const native = await connect("authenticated"), caller = await connect("anon");
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'budget-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled) values($1,$2,'https://budget.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const suffix = randomUUID(), rootId = `budget-root-${suffix}`, root = `/budget-${suffix}/Clued_资料中心`;
  const profile = (await register({ action: "profile_register", project_id: project, profile_version: `budget/${suffix}`,
    managed_root: root, root_folder_id: rootId, root_parent_id: `budget-parent-${suffix}`, root_folder_version: "1" }))
    .target_refs.find(ref => ref.role === "primary").id;
  await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `budget-track-${suffix}`,
    provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
  assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
    profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
  const connected = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
    action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  assert.equal(connected.status, "committed");
  const connection = connected.target_refs.find(ref => ref.role === "primary").id, receipt = connected.receipt_id;
  await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='budget-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{\"sealed\":true}' where id=$1", [connection, oauthClient]);
  const policy = randomUUID();
  await admin.query("begin");
  try {
    await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
        c.source_decision_id,c.decision_version,'reviewed_transition','budget-fixture/1',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, connection]);
    await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, receipt]);
    await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
    await admin.query("commit");
  } catch (error) { await admin.query("rollback"); throw error; }
  const bind = async () => {
    const token = sha(randomUUID()), clientId = `budget-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Budget fixture", redirect_uri: "https://budget.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, receipt]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, receipt]);
    await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)", [lineage, receipt]);
    return { token, id: approved.binding_id, lineage };
  };
  const budget = async (input, database = native) => (await database.query(`select ${BUDGET}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const status = () => budget({ action: "status", connection_id: connection });
  const set = (scope, base, read, upload, extra = {}) => budget({ action: "set", scope, ...(scope === "connection" ? { connection_id: connection } : {}),
    base_generation: base, read_bytes_per_hour: read, upload_bytes_per_hour: upload, idempotency_key: randomUUID(), ...extra });
  const call = async (client, input) => (await caller.query(`select ${READ}($1,$2,$3::jsonb) value`, [issuer, client.token, JSON.stringify(input)])).rows[0].value;
  const admit = client => call(client, { action: "admit", connection_id: connection, operation: "read", object_id: "budgetFile000001" });
  const reserve = (client, admitted, bytes) => call(client, { action: "reserve", connection_id: connection, receipt_id: admitted.receipt_id, max_bytes: bytes });
  const ownerUsed = async () => Number((await admin.query(`select coalesce(sum(case when state='finalized' then byte_count else coalesce(reserved_bytes,262144) end),0)::bigint n
    from clued_private.storage_read_receipts_v1 where owner_id=$1 and class='read_content'`, [user])).rows[0].n);
  const usedBy = async binding => Number((await admin.query(`select coalesce(sum(case when state='finalized' then byte_count else coalesce(reserved_bytes,262144) end),0)::bigint n
    from clued_private.storage_read_receipts_v1 where binding_id=$1 and class='read_content'`, [binding.id])).rows[0].n);
  // Everything a budget change must leave alone (§7.3): connection, policy, read access, grants, denies, jobs.
  const governed = async () => (await admin.query(`select
      (select to_jsonb(c) from clued_private.storage_connections_v1 c where c.id=$1) connection,
      (select jsonb_agg(to_jsonb(p) order by p.id) from clued_private.storage_account_policies_v2 p where p.connection_id=$1) policies,
      (select jsonb_agg(to_jsonb(a) order by a.id) from clued_private.storage_read_access_v1 a where a.connection_id=$1) read_access,
      (select jsonb_agg(to_jsonb(d)) from clued_private.storage_read_client_denies_v1 d where d.owner_id=$2) denies,
      (select jsonb_agg(to_jsonb(x) order by x.lineage_id) from clued_private.storage_client_capabilities_v2 x
        where x.receipt_id=$3) capabilities,
      (select jsonb_agg(to_jsonb(j) order by j.job_id) from clued_private.storage_jobs_v1 j where j.owner_id=$2) jobs,
      (select jsonb_agg(to_jsonb(s) order by s.id) from clued_private.storage_staging_v1 s where s.owner_id=$2) staging`,
  [connection, user, receipt])).rows[0];

  try {
    const first = await bind(), second = await bind();
    const enabled = await native.query(`select ${ACCESS}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: connection,
      classes: ["read", "read_content"], base_generation: 0, disclosure_version: CONTENT_DISCLOSURE, idempotency_key: randomUUID() })]);
    assert.equal(enabled.rows[0].value.status, "committed", JSON.stringify(enabled.rows[0].value));

    await t.test("status reports the §7.1 defaults, bounds and generation 0 before any change", async () => {
      const value = await status();
      assert.equal(value.contract, "clued.storage-budget/1"); assert.equal(value.connection_id, connection);
      assert.deepEqual(value.connection, { budget_generation: 0, configured: false, read_bytes_per_hour: 256 * MIB, upload_bytes_per_hour: 256 * MIB });
      assert.deepEqual(value.account, { budget_generation: 0, configured: false, read_bytes_per_hour: GIB, upload_bytes_per_hour: GIB });
      assert.deepEqual(value.bounds, { step_bytes: MIB, connection: { min_bytes: 32 * MIB, max_bytes: 2 * GIB }, account: { min_bytes: 32 * MIB, max_bytes: 8 * GIB } });
      assert.deepEqual(value.defaults, { connection: { read_bytes_per_hour: 256 * MIB, upload_bytes_per_hour: 256 * MIB },
        account: { read_bytes_per_hour: GIB, upload_bytes_per_hour: GIB } });
    });

    await t.test("only the owner's native session can read or change a budget", async () => {
      const before = await governed();
      // Another owner with a live session sees nothing of this connection.
      const otherSession = randomUUID(), other = await connect("authenticated");
      await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [otherSession, mainUser]);
      await other.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [mainUser, JSON.stringify({ sub: mainUser, session_id: otherSession })]);
      await assert.rejects(budget({ action: "status", connection_id: connection }, other), /storage_owner_denied/);
      await assert.rejects(budget({ action: "set", scope: "connection", connection_id: connection, base_generation: 0,
        read_bytes_per_hour: 64 * MIB, upload_bytes_per_hour: 64 * MIB, idempotency_key: randomUUID() }, other), /storage_owner_denied/);
      // The owner's JWT without a live auth session is refused.
      const stale = await connect("authenticated");
      await stale.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [user, JSON.stringify({ sub: user, session_id: randomUUID() })]);
      await assert.rejects(budget({ action: "status", connection_id: connection }, stale), /storage_native_session_required/);
      // A Binding caller (anon) and the service role cannot execute it at all.
      await assert.rejects(budget({ action: "status", connection_id: connection }, caller), /permission denied/);
      const service = await connect("service_role");
      await assert.rejects(budget({ action: "status", connection_id: connection }, service), /permission denied/);
      assert.deepEqual(await governed(), before);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_budgets_v1 where owner_id=$1", [user])).rows[0].n, 0);
    });

    await t.test("hard upper and lower bounds and exact input shapes are refused before any receipt", async () => {
      const receipts = async () => (await admin.query("select count(*)::int n from public.clued_audit_receipts where user_id=$1 and operation_family='storage_budget_v1'", [user])).rows[0].n;
      const before = await receipts();
      for (const [scope, read, upload] of [["connection", 32 * MIB - MIB, 64 * MIB], ["connection", 64 * MIB, 2 * GIB + MIB],
        ["connection", 4 * GIB, 64 * MIB], ["account", 8 * GIB + MIB, 64 * MIB], ["account", 64 * MIB, 16 * MIB], ["connection", 64 * MIB + 1, 64 * MIB]]) {
        await assert.rejects(set(scope, 0, read, upload), /storage_budget_out_of_bounds/, `${scope} ${read} ${upload}`);
      }
      await assert.rejects(set("connection", 0, String(64 * MIB), 64 * MIB), /storage_owner_input_invalid/);
      await assert.rejects(set("connection", 0, 64 * MIB, 64 * MIB, { image_transforms_per_month: 1000 }), /storage_owner_input_invalid/, "not configurable yet");
      await assert.rejects(set("account", 0, 64 * MIB, 64 * MIB, { connection_id: connection }), /storage_owner_input_invalid/);
      await assert.rejects(budget({ action: "set", scope: "connection", base_generation: 0, read_bytes_per_hour: 64 * MIB,
        upload_bytes_per_hour: 64 * MIB, idempotency_key: randomUUID() }), /storage_owner_input_invalid/, "connection scope needs its connection");
      await assert.rejects(set("binding", 0, 64 * MIB, 64 * MIB), /storage_owner_input_invalid/);
      await assert.rejects(set("connection", -1, 64 * MIB, 64 * MIB), /storage_owner_input_invalid/);
      assert.equal(await receipts(), before);
      // The table enforces the same bounds without the RPC.
      await assert.rejects(admin.query(`insert into clued_private.storage_budgets_v1(owner_id,connection_id,read_bytes_per_hour,upload_bytes_per_hour,budget_generation,receipt_id)
        values($1,$2,$3,$4,1,$5)`, [user, connection, 2 * GIB + MIB, 64 * MIB, receipt]), /storage_budgets_bounds_v1/);
      await assert.rejects(admin.query(`insert into clued_private.storage_budgets_v1(owner_id,connection_id,read_bytes_per_hour,upload_bytes_per_hour,budget_generation,receipt_id)
        values($1,null,$2,$3,1,$4)`, [user, 8 * GIB + MIB, 64 * MIB, receipt]), /storage_budgets_bounds_v1/);
      // Exactly the bounds are accepted.
      assert.equal((await set("account", 0, 8 * GIB, 32 * MIB)).status, "committed");
      assert.equal((await set("account", 1, GIB, GIB)).status, "committed");
    });

    await t.test("set is CAS on budget_generation; each change revokes and inserts under one Receipt and one Event", async () => {
      const before = await governed();
      const key = randomUUID();
      const input = { action: "set", scope: "connection", connection_id: connection, base_generation: 0,
        read_bytes_per_hour: 64 * MIB, upload_bytes_per_hour: 128 * MIB, idempotency_key: key };
      const committed = await budget(input);
      assert.equal(committed.status, "committed", JSON.stringify(committed));
      assert.equal((await budget(input)).receipt_id, committed.receipt_id, "an idempotent replay returns the same receipt");
      await assert.rejects(set("connection", 0, 64 * MIB, 64 * MIB), /storage_owner_version_conflict/, "a stale base");
      await assert.rejects(budget({ ...input, read_bytes_per_hour: 96 * MIB }), /storage_owner_version_conflict/, "same key, different request");
      let value = await status();
      assert.deepEqual(value.connection, { budget_generation: 1, configured: true, read_bytes_per_hour: 64 * MIB, upload_bytes_per_hour: 128 * MIB });
      const second = await set("connection", 1, 96 * MIB, 128 * MIB);
      assert.equal(second.status, "committed");
      value = await status();
      assert.deepEqual([value.connection.budget_generation, value.connection.read_bytes_per_hour], [2, 96 * MIB]);
      const rows = (await admin.query("select * from clued_private.storage_budgets_v1 where owner_id=$1 and connection_id=$2 order by budget_generation", [user, connection])).rows;
      assert.deepEqual(rows.map(row => [row.state, Number(row.budget_generation)]), [["revoked", 1], ["active", 2]]);
      assert.equal(rows[0].receipt_id, committed.receipt_id); assert.equal(rows[0].revocation_receipt_id, second.receipt_id);
      assert.equal(rows[1].receipt_id, second.receipt_id);
      const events = (await admin.query("select change_summary,event_scope from public.clued_context_events where receipt_id=any($1::uuid[]) and canonical_event_type='extension:storage:budget_v1' order by id",
        [[committed.receipt_id, second.receipt_id]])).rows;
      assert.equal(events.length, 2);
      assert.equal(events[1].event_scope, "project:" + project);
      assert.equal(events[1].change_summary.previous_read_bytes_per_hour, 64 * MIB); assert.equal(events[1].change_summary.read_bytes_per_hour, 96 * MIB);
      const stored = (await admin.query("select status,base_versions,committed_versions from public.clued_audit_receipts where id=$1", [second.receipt_id])).rows[0];
      assert.equal(stored.status, "committed");
      assert.deepEqual([stored.base_versions, stored.committed_versions], [{ ["storage_budget:" + connection]: 1 }, { ["storage_budget:" + connection]: 2 }]);
      const account = (await admin.query("select event_scope from public.clued_context_events where canonical_event_type='extension:storage:budget_v1' and actor_user_id=$1 and change_summary->>'scope'='account' limit 1", [user])).rows[0];
      assert.equal(account.event_scope, "profile", "account totals belong to no project");
      // Rows are immutable apart from revocation.
      await assert.rejects(admin.query("update clued_private.storage_budgets_v1 set read_bytes_per_hour=$2 where id=$1", [rows[1].id, 128 * MIB]), /storage_budget_immutable/);
      await assert.rejects(admin.query("delete from clued_private.storage_budgets_v1 where id=$1", [rows[0].id]), /storage_budget_immutable/);
      await assert.rejects(admin.query("update clued_private.storage_budgets_v1 set state='active',revoked_at=null,revocation_receipt_id=null where id=$1", [rows[0].id]), /storage_budget_immutable/);
      assert.deepEqual(await governed(), before, "connection, policy, read access, grants, denies, jobs and staging are unchanged");
    });

    await t.test("a read budget change applies to the next admission and reservation, and never rewrites receipts", async () => {
      assert.equal((await set("connection", 2, 32 * MIB, 128 * MIB)).status, "committed");
      for (let i = 0; i < 6; i++) { const admitted = await admit(first); assert.equal((await reserve(first, admitted, IMAGE)).extended, true); }
      const last = await admit(first);
      await assert.rejects(reserve(first, last, IMAGE), /storage_read_budget_exhausted/, "30 MiB + 5 MiB > 32 MiB");
      assert.equal((await reserve(first, last, 2 * MIB)).reserved_bytes, 2 * MIB, "exactly 32 MiB");
      await assert.rejects(admit(first), /storage_read_budget_exhausted/);
      const snapshot = (await admin.query("select id,reserved_bytes,state from clued_private.storage_read_receipts_v1 where binding_id=$1 order by id", [first.id])).rows;
      assert.equal((await set("connection", 3, 64 * MIB, 128 * MIB)).status, "committed");
      const raised = await admit(first);
      assert.equal(raised.class, "read_content", "raised: the very next admission passes");
      assert.equal((await reserve(first, raised, IMAGE)).extended, true);
      assert.equal((await set("connection", 4, 32 * MIB, 128 * MIB)).status, "committed");
      await assert.rejects(admit(first), /storage_read_budget_exhausted/, "lowered below use: refused at once");
      const after = (await admin.query("select id,reserved_bytes,state from clued_private.storage_read_receipts_v1 where binding_id=$1 and id=any($2::uuid[]) order by id",
        [first.id, snapshot.map(row => row.id)])).rows;
      assert.deepEqual(after, snapshot, "existing reservations are never rewritten");
      assert.equal(await usedBy(first), 37 * MIB, "32 MiB + one 5 MiB image");
    });

    await t.test("the account read total covers every Binding of the owner and is adjustable", async () => {
      assert.equal((await set("connection", 5, 2 * GIB, 128 * MIB)).status, "committed");
      assert.equal(await ownerUsed(), 37 * MIB);
      assert.equal((await set("account", 2, 64 * MIB, GIB)).status, "committed");
      // second Binding: 37 MiB already used by the owner, so 27 MiB remain.
      for (let i = 0; i < 5; i++) { const admitted = await admit(second); assert.equal((await reserve(second, admitted, IMAGE)).extended, true); }
      const next = await admit(second);
      await assert.rejects(reserve(second, next, IMAGE), /storage_read_budget_exhausted/, "62 MiB + 5 MiB > 64 MiB account total");
      assert.ok(await usedBy(second) < 2 * GIB, "the Binding budget was not the limit");
      assert.equal((await set("account", 3, GIB, GIB)).status, "committed");
      assert.equal((await reserve(second, next, IMAGE)).extended, true, "raised account total applies at once");
      // Without any row the default is 1 GiB per owner (verified by status at the start).
    });

    await t.test("upload reservations use the configured per-Binding and account upload budgets at once", async () => {
      const definition = (await admin.query("select pg_get_functiondef('public.clued_storage_staging_v1(text,text,jsonb)'::regprocedure) body")).rows[0].body;
      assert.match(definition, /storage_upload_budget_v2\(c\.owner_id,\(snapshot->>'binding_id'\)::uuid,c\.id,/);
      assert.equal((await admin.query("select to_regprocedure('clued_private.storage_upload_budget_v1(uuid,uuid,bigint)') fn")).rows[0].fn, null,
        "the fixed-limit function is gone");
      const stage = async (binding, size) => admin.query(`insert into clued_private.storage_staging_v1(id,owner_id,connection_id,binding_id,destination_path,mime_type,size,sha256,
        transport,reserved_bytes,expires_at) values($1,$2,$3,$4,$5,'image/png',$6,$7,'url',$6,clock_timestamp()+interval '10 minutes')`,
      [randomUUID(), user, connection, binding.id, `${root}/20_P_产品与体验/u-${randomUUID()}.png`, size, sha(randomUUID())]);
      const check = async (binding, size) => {
        await admin.query("begin");
        try { await admin.query("select clued_private.storage_upload_budget_v2($1,$2,$3,$4)", [user, binding.id, connection, size]); }
        finally { await admin.query("rollback"); }
      };
      await stage(first, 20 * MIB); await stage(first, 20 * MIB);
      assert.equal((await set("connection", 6, 2 * GIB, 64 * MIB)).status, "committed");
      await check(first, 20 * MIB);
      await assert.rejects(check(first, 20 * MIB + 5 * MIB), /storage_upload_budget_exhausted/, "40 + 25 > 64 MiB per Binding");
      assert.equal((await set("connection", 7, 2 * GIB, 128 * MIB)).status, "committed");
      await check(first, 25 * MIB);
      assert.equal((await set("account", 4, GIB, 64 * MIB)).status, "committed");
      await assert.rejects(check(second, 25 * MIB), /storage_upload_budget_exhausted/, "40 + 25 > 64 MiB account total");
      await check(second, 24 * MIB);
      assert.equal((await set("account", 5, GIB, GIB)).status, "committed");
      await check(second, 20 * MIB);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
