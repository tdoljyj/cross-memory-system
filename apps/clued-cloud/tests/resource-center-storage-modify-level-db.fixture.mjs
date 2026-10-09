import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const READ = "public.clued_storage_read_v1";
const ACCESS = "public.clued_storage_read_access_v1";
const DISCLOSURE = "clued.storage-read-disclosure/1";
const CONTENT_DISCLOSURE = "clued.storage-modify-level-disclosure/1";
const WRITE = "public.clued_storage_write_access_v1", MODIFY_DISCLOSURE = "clued.storage-modify-disclosure/1";

// StorageFullCapability.v0.1 P3 part A at the database layer: the modify write
// level, the policy replacement it performs, and the read access migration.
// Synthetic, disposable PostgreSQL only.
export async function testStorageModifyLevel(t, admin, server, user, decision) {
  await allowTestIssuerCredentials(admin);
  const clients = [], session = randomUUID(), issuer = sha(randomUUID()), clientIssuer = sha(randomUUID());
  const oauthClient = `modify-level-${randomUUID()}`, resource = "https://modify-level.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    database.fixturePid = (await database.query("select pg_backend_pid() pid")).rows[0].pid;
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon"), racer = await connect("anon");
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'modify-level-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled) values($1,$2,'https://modify-level.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const suffix = randomUUID(), rootId = `modify-root-${suffix}`, root = `/modify-level-${suffix}/Clued_资料中心`;
  const profile = (await register({ action: "profile_register", project_id: project, profile_version: `modify-level/${suffix}`,
    managed_root: root, root_folder_id: rootId, root_parent_id: `modify-parent-${suffix}`, root_folder_version: "1" }))
    .target_refs.find(ref => ref.role === "primary").id;
  await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `modify-track-${suffix}`,
    provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
  assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
    profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
  const connected = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
    action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  assert.equal(connected.status, "committed");
  const connection = connected.target_refs.find(ref => ref.role === "primary").id, receipt = connected.receipt_id;
  await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='modify-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{\"sealed\":true}' where id=$1", [connection, oauthClient]);
  const policy = randomUUID();
  await admin.query("begin");
  try {
    await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
        c.source_decision_id,c.decision_version,'reviewed_transition','modify-level-fixture/1',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, connection]);
    await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, receipt]);
    await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
    await admin.query("commit");
  } catch (error) { await admin.query("rollback"); throw error; }
  // A reviewed, qualified client (the P1 fixture shape).
  const bind = async () => {
    const token = sha(randomUUID()), clientId = `modify-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Read content fixture", redirect_uri: "https://modify-level.invalid/client-callback",
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
  const access = async input => (await native.query(`select ${ACCESS}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const status = () => access({ action: "status", connection_id: connection });
  const setClasses = async (classes, disclosure) => access({ action: "set_classes", connection_id: connection, classes,
    base_generation: (await status()).read_generation, disclosure_version: disclosure, idempotency_key: randomUUID() });
  const call = async (client, input, database = caller) => (await database.query(`select ${READ}($1,$2,$3::jsonb) value`, [issuer, client.token, JSON.stringify(input)])).rows[0].value;
  const admit = (client, extra = {}, database) => call(client, { action: "admit", connection_id: connection, operation: "read", object_id: "contentFile00001", ...extra }, database);
  const waitForLock = async database => {
    for (let i = 0; i < 200; i++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting", [database.fixturePid])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("the second admission did not wait for the first");
  };
  const finalize = (client, admitted, bytes) => call(client, { action: "finalize", connection_id: connection, receipt_id: admitted.receipt_id,
    item_count: 1, byte_count: bytes, complete: true });
  const receipts = async () => (await admin.query("select count(*)::int n from clued_private.storage_read_receipts_v1 where connection_id=$1", [connection])).rows[0].n;

  const wstatus = async () => (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "status", connection_id: connection })])).rows[0].value;
  const wset = async (classes, extra = {}) => (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: connection,
    classes, base_generation: (await wstatus()).policy_generation, disclosure_version: MODIFY_DISCLOSURE, idempotency_key: randomUUID(), ...extra })])).rows[0].value;
  const active = async () => (await admin.query(`select p.id,p.actions,p.scope_contract,p.policy_generation::int,p.scope_digest,p.consent_source,c.auth_generation::int,c.account_policy_id
    from clued_private.storage_account_policies_v2 p join clued_private.storage_connections_v1 c on c.id=p.connection_id
    where p.connection_id=$1 and p.state='active'`, [connection])).rows[0];
  const evaluate = async (client, action) => (await admin.query("select clued_private.storage_policy_evaluate_v2($1,$2,$3,$4) value", [client.token, connection, action, randomUUID()])).rows[0].value;
  const submitJob = (client, input) => caller.query("select public.clued_storage_jobs_router_v2($1,$2::jsonb) value", [client.token, JSON.stringify(input)]);

  try {
    const client = await bind();
    assert.equal((await setClasses(["read"], DISCLOSURE)).status, "committed");

    await t.test("existing policies keep the /2 contract and cannot evaluate modify", async () => {
      const before = await active();
      assert.equal(before.scope_contract, "clued.storage-account-scope/2");
      assert.deepEqual(before.actions, ["inspect", "create_file", "create_topic"]);
      assert.equal((await evaluate(client, "create_file")).scope_digest, before.scope_digest);
      await assert.rejects(evaluate(client, "modify"), /storage_policy_denied/, "the action is not in the policy's action set");
      const s = await wstatus();
      assert.deepEqual(s.classes, []); assert.equal(s.active, true); assert.equal(s.disclosure_version, MODIFY_DISCLOSURE);
    });

    await t.test("enabling modify replaces the policy, bumps auth_generation and moves read access untouched", async () => {
      const before = await active(), readBefore = await status();
      assert.equal(readBefore.active, true);
      await assert.rejects(wset(["modify"], { disclosure_version: DISCLOSURE }), /storage_write_disclosure_changed/);
      await assert.rejects(wset(["replace"]), /storage_owner_input_invalid/);
      await assert.rejects(wset(["modify"], { base_generation: 99 }), /storage_owner_version_conflict/);
      // StorageNormalUse N0a: moving read access copies content_profile. No API
      // writes normal/1 yet, so the fixture sets it with triggers bypassed.
      const setContentProfile = async value => {
        await admin.query("set session_replication_role=replica");
        try { await admin.query("update clued_private.storage_read_access_v1 set content_profile=$2 where connection_id=$1 and state='active'", [connection, value]); }
        finally { await admin.query("set session_replication_role=origin"); }
      };
      await setContentProfile("normal/1");
      const done = await wset(["modify"]);
      assert.equal(done.status, "committed", JSON.stringify(done));
      const after = await active();
      assert.notEqual(after.id, before.id);
      assert.equal(after.scope_contract, "clued.storage-account-scope/3");
      assert.deepEqual(after.actions, ["inspect", "create_file", "create_topic", "modify"]);
      assert.equal(after.policy_generation, before.policy_generation + 1);
      assert.equal(after.auth_generation, before.auth_generation + 1);
      assert.equal(after.account_policy_id, after.id);
      assert.equal(after.consent_source, "native_level_change");
      assert.notEqual(after.scope_digest, before.scope_digest, "the action set is part of the /3 digest");
      assert.equal((await admin.query("select state from clued_private.storage_account_policies_v2 where id=$1", [before.id])).rows[0].state, "revoked");
      const readAfter = await status();
      assert.equal(readAfter.active, true); assert.deepEqual(readAfter.classes, readBefore.classes);
      assert.equal(readAfter.bound_to_active_policy, true, "reads follow the new policy");
      assert.equal(readAfter.read_generation, readBefore.read_generation + 1);
      assert.equal((await admin.query("select disclosure_version,consent_receipt_id from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [connection])).rows[0].disclosure_version, DISCLOSURE);
      assert.equal((await admin.query("select content_profile from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [connection])).rows[0].content_profile,
        "normal/1", "the moved read access keeps its content profile");
      assert.equal((await call(client, { action: "admit", connection_id: connection, operation: "list" })).content_profile, "normal/1");
      await setContentProfile("text/1");
      const snapshot = await evaluate(client, "modify");
      assert.equal(snapshot.scope_digest, after.scope_digest); assert.equal(snapshot.policy_id, after.id);
      assert.ok(snapshot.actions.includes("modify"));
      assert.equal((await evaluate(client, "create_file")).policy_id, after.id, "create still works under the new policy");
      assert.equal((await call(client, { action: "admit", connection_id: connection, operation: "list" })).class, "read", "browse is not interrupted");
    });

    await t.test("submit still accepts only create: modify grants nothing executable yet", async () => {
      const jobs = (await admin.query("select count(*)::int n from clued_private.storage_jobs_v1")).rows[0].n;
      for (const operation of ["rename", "move"]) {
        await assert.rejects(submitJob(client, { action: "submit", connection_id: connection, job_id: randomUUID(),
          mutation: { operation, source_path: "a", destination_path: "b", target_kind: "file" } }), /storage_job_input_invalid/);
      }
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_jobs_v1")).rows[0].n, jobs);
    });

    await t.test("disabling modify replaces the policy again and is idempotent per key", async () => {
      const before = await active(), key = randomUUID();
      const off = await wset([], { idempotency_key: key });
      assert.equal(off.status, "committed");
      const after = await active();
      assert.deepEqual(after.actions, ["inspect", "create_file", "create_topic"]);
      assert.equal(after.scope_contract, "clued.storage-account-scope/3", "a /3 policy without modify is still /3");
      assert.equal(after.policy_generation, before.policy_generation + 1);
      assert.equal((await evaluate(client, "create_topic")).policy_id, after.id);
      await assert.rejects(evaluate(client, "modify"), /storage_policy_denied/);
      const replay = await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: connection, classes: [],
        base_generation: before.policy_generation, disclosure_version: MODIFY_DISCLOSURE, idempotency_key: key })]);
      assert.equal(replay.rows[0].value.receipt_id, off.receipt_id, "the same request replays its receipt");
      assert.equal((await active()).id, after.id);
      await assert.rejects(wset([]), /storage_owner_version_conflict/, "nothing to change");
    });

    await t.test("the switch cancels queued jobs of this connection; they keep their original policy", async () => {
      const job = randomUUID();
      const snapshot = await evaluate(client, "create_file");
      const policy = await active();
      await admin.query(`insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,authorization_version,
        request_digest,mutation,receipt_id,authority_snapshot_v2)
        select $1,$2,$3,$4,$5,$6,$7,'{"operation":"create","target_kind":"file","destination_path":"x","content":"y"}'::jsonb,$5,$8::jsonb`,
      [user, job, connection, snapshot.binding_id, receipt, snapshot.authorization_version, sha(job), JSON.stringify(snapshot)]);
      const done = await wset(["modify"]);
      assert.equal(done.status, "committed", JSON.stringify(done));
      const row = (await admin.query("select dispatch_outcome,dispatch_outcome_receipt_id,intent_id,authority_snapshot_v2->>'policy_id' policy from clued_private.storage_jobs_v1 where job_id=$1", [job])).rows[0];
      assert.deepEqual(row.dispatch_outcome, { status: "denied" }); assert.equal(row.intent_id, null);
      assert.equal(row.policy, policy.id, "the cancelled job keeps its original policy");
      const outcome = (await admin.query("select operation,status,idempotency_key from public.clued_audit_receipts where id=$1", [row.dispatch_outcome_receipt_id])).rows[0];
      assert.deepEqual(outcome, { operation: "storage_dispatch_outcome", status: "committed", idempotency_key: "cloud-dispatch-outcome:" + job },
        "the same receipt key as the Worker's report, so a late report is refused");
      assert.notEqual((await active()).id, policy.id);
    });

    await t.test("an unresolved intent blocks the switch and keeps the policy", async () => {
      const policy = await active();
      const intent = (await admin.query(`insert into clued_private.resource_center_mutations_v1(user_id,profile_id,request_key,request_sha256,exact_request,
        authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
        select $1,p.id,'modify-level-intent',$2,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$2,p.version,$3,'started',clock_timestamp()+interval '1 minute',$4
        from clued_private.resource_center_profiles_v1 p where p.id=$5 returning id`, [user, sha(randomUUID()), decision, receipt, profile])).rows[0].id;
      try {
        await assert.rejects(wset([]), /storage_root_has_unresolved_mutation/);
        assert.equal((await active()).id, policy.id);
      } finally {
        await admin.query("update clued_private.resource_center_mutations_v1 set state='cancelled' where id=$1", [intent]);
      }
    });

    await t.test("a switch serializes with a concurrent read admission on the root lock", async () => {
      const before = await active();
      await native.query("begin");
      let pending;
      try {
        assert.equal((await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: connection,
          classes: [], base_generation: before.policy_generation, disclosure_version: MODIFY_DISCLOSURE, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
        pending = call(client, { action: "admit", connection_id: connection, operation: "list" }, racer);
        await waitForLock(racer);
        await native.query("commit");
      } catch (error) { await native.query("rollback").catch(() => {}); throw error; }
      const admitted = await pending;
      assert.equal(admitted.class, "read");
      assert.equal((await admin.query("select account_policy_id from clued_private.storage_read_receipts_v1 where id=$1", [admitted.receipt_id])).rows[0].account_policy_id,
        (await active()).id, "the waiting read is admitted under the new policy");
    });

    await t.test("scope drift, a revoked connection or a missing native session refuses the switch", async () => {
      await assert.rejects(caller.query(`select ${WRITE}($1::jsonb)`, [JSON.stringify({ action: "status", connection_id: connection })]), /permission denied|storage_native_session_required/);
      await admin.query("update clued_private.storage_connections_v1 set state='reauthorization_required' where id=$1", [connection]);
      await assert.rejects(wset(["modify"]), /storage_owner_version_conflict/);
      await admin.query("update clued_private.storage_connections_v1 set state='active' where id=$1", [connection]);
      // Last: revoke the registered track, so the current policy's scope no longer evaluates.
      const track = (await admin.query("select id,version from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path like '%/20_P_产品与体验'", [profile])).rows[0];
      await register({ action: "artifact_revoke", profile_id: profile, artifact_id: track.id, base_version: Number(track.version) });
      await assert.rejects(wset(["modify"]), /storage_owner_scope_changed/);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
