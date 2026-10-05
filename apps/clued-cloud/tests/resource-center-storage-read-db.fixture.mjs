import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const READ = "public.clued_storage_read_v1";
const ACCESS = "public.clued_storage_read_access_v1";
const DISCLOSURE = "clued.storage-read-disclosure/1";

// StorageFullCapability.v0.1 P1 read level. Synthetic, disposable PostgreSQL
// only; setup facts model the already-tested registration/transition contracts.
export async function testStorageRead(t, admin, server, user, decision) {
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `storage-read-${randomUUID()}`, resource = "https://storage-read.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    database.fixturePid = (await database.query("select pg_backend_pid() pid")).rows[0].pid;
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon"), operator = await connect();
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'storage-read-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,$2,'https://storage-read.invalid/storage/google/callback')", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/storage-read-${suffix}/Clued_资料中心`, rootId = `read-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `storage-read/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `read-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `read-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='storage-read-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{\"sealed\":true}' where id=$1", [connection, oauthClient]);
    return { root, rootId, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `read-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Storage read fixture", redirect_uri: "https://storage-read.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, target.receipt]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, target.receipt]);
    await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)", [lineage, target.receipt]);
    return { token, id: approved.binding_id, lineage };
  };
  const activate = async target => {
    const policy = randomUUID(); await admin.query("begin");
    try {
      await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
        scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
        select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
          c.source_decision_id,c.decision_version,'reviewed_transition','storage-read-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  const read = async (client, input, database = caller) =>
    (await database.query(`select ${READ}($1,$2,$3::jsonb) value`, [issuer, client.token, JSON.stringify(input)])).rows[0].value;
  const access = async input => (await native.query(`select ${ACCESS}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const setClasses = async (target, classes, base) => access({ action: "set_classes", connection_id: target.connection, classes,
    base_generation: base, disclosure_version: DISCLOSURE, idempotency_key: randomUUID() });
  const admit = (target, client, extra = {}, database) => read(client, { action: "admit", connection_id: target.connection, operation: "list", object_id: target.rootId, ...extra }, database);
  const receipts = async () => (await admin.query("select count(*)::int n from clued_private.storage_read_receipts_v1")).rows[0].n;
  const connectionState = async target => (await admin.query("select auth_generation,account_policy_id,version from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0];
  const denied = async (promise, code = /storage_read_denied/) => assert.rejects(promise, code);
  const waitForLock = async database => {
    for (let i = 0; i < 200; i++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting", [database.fixturePid])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("storage read request did not reach its intended lock wait");
  };

  try {
    const target = await activate(await createRoot()), client = await bind(target), other = await bind(target);

    await t.test("read surface ACL: Worker RPC is anon-only, Owner control is native-only, tables are private", async () => {
      const acl = (await admin.query(`select
        has_function_privilege('anon','${READ}(text,text,jsonb)','EXECUTE') read_anon,
        has_function_privilege('authenticated','${READ}(text,text,jsonb)','EXECUTE') read_auth,
        has_function_privilege('service_role','${READ}(text,text,jsonb)','EXECUTE') read_service,
        has_function_privilege('anon','${ACCESS}(jsonb)','EXECUTE') access_anon,
        has_function_privilege('authenticated','${ACCESS}(jsonb)','EXECUTE') access_auth,
        has_function_privilege('anon','clued_private.storage_read_evaluate_v1(text,uuid,text)','EXECUTE') evaluate_anon,
        has_table_privilege('anon','clued_private.storage_read_receipts_v1','SELECT') receipts_anon,
        has_table_privilege('authenticated','clued_private.storage_read_access_v1','SELECT') access_table_auth`)).rows[0];
      assert.deepEqual(acl, { read_anon: true, read_auth: false, read_service: false, access_anon: false, access_auth: true,
        evaluate_anon: false, receipts_anon: false, access_table_auth: false });
      await assert.rejects(caller.query(`select ${ACCESS}('{"action":"status"}'::jsonb)`), /permission denied/);
    });

    await t.test("closed by default: no read switch, then no read access, means no receipt and no descriptor", async () => {
      const before = await receipts();
      await denied(admit(target, client));
      await admin.query("update clued_private.storage_oauth_apps_v1 set read_enabled=true where issuer_hash=$1", [issuer]);
      await denied(admit(target, client));
      assert.equal(await receipts(), before);
      const status = await access({ action: "status", connection_id: target.connection });
      assert.equal(status.active, false); assert.equal(status.read_generation, 0); assert.equal(status.disclosure_version, DISCLOSURE);
    });

    await t.test("Owner enables read without touching the write policy; read_content stays unavailable in P1", async () => {
      const before = await connectionState(target);
      await assert.rejects(access({ action: "set_classes", connection_id: target.connection, classes: ["read"], base_generation: 0,
        disclosure_version: "stale", idempotency_key: randomUUID() }), /storage_read_disclosure_changed/);
      // P2: read_content has its own disclosure; the read-only text is not consent to bodies.
      await assert.rejects(setClasses(target, ["read", "read_content"], 0), /storage_read_disclosure_changed/);
      await assert.rejects(setClasses(target, ["read", "read"], 0), /storage_owner_input_invalid/);
      const enabled = await setClasses(target, ["read"], 0);
      assert.equal(enabled.status, "committed", JSON.stringify(enabled));
      await assert.rejects(setClasses(target, ["read"], 0), /storage_owner_version_conflict/);
      assert.deepEqual(await connectionState(target), before, "read toggles never change auth_generation, policy or connection version");
      const status = await access({ action: "status", connection_id: target.connection });
      assert.equal(status.active, true); assert.deepEqual(status.classes, ["read"]); assert.equal(status.read_generation, 1);
      assert.equal(status.bound_to_active_policy, true);
    });

    await t.test("admit commits an intent receipt before returning the sealed descriptor; finalize is exact and idempotent", async () => {
      const hmac = sha("condition");
      const admitted = await admit(target, client, { operation: "search", object_id: target.rootId, condition_hmac: hmac, key_id: "k1" });
      assert.equal(admitted.contract, "clued.storage-read-admission/1");
      assert.equal(admitted.class, "read"); assert.equal(admitted.root_folder_id, target.rootId);
      assert.deepEqual(admitted.credential_envelope, { sealed: true }); assert.equal(admitted.credential_version, 1);
      assert.equal(admitted.oauth_client_id, oauthClient); assert.equal(admitted.provider_subject, "storage-read-subject");
      assert.equal(admitted.binding_id, client.id, "cursors are bound to the admitted Binding");
      // StorageNormalUse N0a: the Worker cross-checks the sealed set against these.
      assert.equal(admitted.provider_scope_profile, "legacy"); assert.equal(admitted.content_profile, "text/1");
      const access = (await admin.query("select id,content_profile from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [target.connection])).rows[0];
      assert.equal(access.content_profile, "text/1");
      await assert.rejects(admin.query("update clued_private.storage_read_access_v1 set content_profile='normal/1' where id=$1", [access.id]), /storage_read_access_immutable/);
      const row = (await admin.query("select * from clued_private.storage_read_receipts_v1 where id=$1", [admitted.receipt_id])).rows[0];
      assert.equal(row.state, "intent"); assert.equal(row.lineage_id, client.lineage); assert.equal(row.condition_hmac, hmac);
      assert.equal(row.operation, "search"); assert.equal(row.item_count, null);
      const finish = { action: "finalize", connection_id: target.connection, receipt_id: admitted.receipt_id, item_count: 3, byte_count: 0, complete: false };
      await denied(read(other, finish), /storage_read_denied/);
      assert.deepEqual(await read(client, finish), { receipt_id: admitted.receipt_id, state: "finalized", replayed: false });
      assert.deepEqual(await read(client, finish), { receipt_id: admitted.receipt_id, state: "finalized", replayed: true });
      await assert.rejects(read(client, { ...finish, item_count: 4 }), /storage_read_receipt_conflict/);
      await assert.rejects(admin.query("delete from clued_private.storage_read_receipts_v1 where id=$1", [admitted.receipt_id]), /storage_read_history_immutable/);
      await assert.rejects(admin.query("update clued_private.storage_read_receipts_v1 set item_count=9 where id=$1", [admitted.receipt_id]), /storage_read_receipt_immutable/);
    });

    await t.test("input is closed: unknown keys, caller class, bad IDs and half HMAC pairs fail before any lock", async () => {
      const before = await receipts();
      for (const extra of [{ class: "read" }, { owner_id: user }, { root_folder_id: target.rootId }, { object_id: "../x" },
        { condition_hmac: sha("x") }, { key_id: "k1" }, { operation: "delete" }]) {
        await assert.rejects(admit(target, client, extra), /storage_read_input_invalid/);
      }
      await assert.rejects(read(client, { action: "admit", connection_id: "not-a-uuid", operation: "list" }), /storage_read_input_invalid/);
      await assert.rejects(caller.query(`select ${READ}($1,$2,$3::jsonb)`, [sha("wrong issuer"), client.token,
        JSON.stringify({ action: "admit", connection_id: target.connection, operation: "list" })]), /storage_read_denied/);
      assert.equal(await receipts(), before);
    });

    await t.test("content read is a separate class and is denied while only read is granted", async () => {
      const before = await receipts();
      await denied(admit(target, client, { operation: "read" }));
      assert.equal(await receipts(), before);
    });

    await t.test("per-class deny removes read for one client only, and whole-storage revoke also stops reads", async () => {
      const deny = await access({ action: "deny_class", binding_id: client.id, class: "read", denied: true, base_generation: 0, idempotency_key: randomUUID() });
      assert.equal(deny.status, "committed", JSON.stringify(deny));
      await denied(admit(target, client));
      assert.ok((await admit(target, other)).receipt_id, "another client keeps read");
      const status = await access({ action: "status", connection_id: target.connection });
      assert.deepEqual(status.class_denies, [{ binding_id: client.id, class: "read", denied: true, generation: 1 }]);
      await assert.rejects(access({ action: "deny_class", binding_id: client.id, class: "read", denied: true, base_generation: 1, idempotency_key: randomUUID() }),
        /storage_owner_version_conflict/);
      const undo = await access({ action: "deny_class", binding_id: client.id, class: "read", denied: false, base_generation: 1, idempotency_key: randomUUID() });
      assert.equal(undo.status, "committed");
      assert.ok((await admit(target, client)).receipt_id);
      const revoked = (await native.query("select public.clued_storage_owner_manage_v2($1::jsonb) value", [JSON.stringify({
        action: "revoke_client", binding_id: other.id, base_generation: 0, idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(revoked.status, "committed");
      await denied(admit(target, other));
      assert.ok((await admit(target, client)).receipt_id);
    });

    await t.test("revocation serializes with admission at the admit commit (linearization point)", async () => {
      const root = `${user}:${target.rootId}`;
      // A revoke holding the root advisory exclusively makes admission wait, then deny.
      await operator.query("begin");
      await operator.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [root]);
      const current = (await operator.query("select id from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [target.connection])).rows[0].id;
      await operator.query("update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1", [current, target.receipt]);
      const waiting = admit(target, client);
      await waitForLock(caller);
      await operator.query("commit");
      await denied(waiting);
      // Re-enable, then an admission that committed first wins; the later revoke waits for it.
      const reenabled = await setClasses(target, ["read"], 0);
      assert.equal(reenabled.status, "committed", JSON.stringify(reenabled));
      await caller.query("begin");
      const inflight = await admit(target, client);
      const revoke = setClasses(target, [], 2);
      await waitForLock(native);
      await caller.query("commit");
      assert.equal((await revoke).status, "committed");
      const off = await access({ action: "status", connection_id: target.connection });
      assert.equal(off.active, false); assert.equal(off.read_generation, 0, "inactive CAS base is 0"); assert.equal(off.last_generation, 2);
      assert.equal((await admin.query("select state from clued_private.storage_read_receipts_v1 where id=$1", [inflight.receipt_id])).rows[0].state, "intent");
      await denied(admit(target, client));
      // The in-flight read may still be finalized for audit after the revoke.
      assert.equal((await read(client, { action: "finalize", connection_id: target.connection, receipt_id: inflight.receipt_id,
        item_count: 1, byte_count: 0, complete: true })).state, "finalized");
    });

    await t.test("a revoked v12 Binding stops admission even with read access active", async () => {
      const third = await bind(target);
      const again = await setClasses(target, ["read"], 0);
      assert.equal(again.status, "committed", JSON.stringify(again));
      assert.ok((await admit(target, third)).receipt_id);
      await admin.query("update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1", [third.id]);
      await denied(admit(target, third));
      assert.ok((await admit(target, client)).receipt_id, "other clients are unaffected");
      const current = (await access({ action: "status", connection_id: target.connection })).read_generation;
      assert.equal((await setClasses(target, [], current)).status, "committed");
    });

    await t.test("read switch and disconnect each stop admission; read access never revives on its own", async () => {
      const again = await setClasses(target, ["read"], 0);
      assert.equal(again.status, "committed");
      assert.ok((await admit(target, client)).receipt_id);
      await admin.query("update clued_private.storage_oauth_apps_v1 set read_enabled=false where issuer_hash=$1", [issuer]);
      await denied(admit(target, client));
      await admin.query("update clued_private.storage_oauth_apps_v1 set read_enabled=true where issuer_hash=$1", [issuer]);
      assert.ok((await admit(target, client)).receipt_id);
      const version = (await connectionState(target)).version;
      const disconnected = (await native.query("select public.clued_storage_owner_manage_v2($1::jsonb) value", [JSON.stringify({
        action: "disconnect", connection_id: target.connection, base_version: Number(version), idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(disconnected.status, "committed", JSON.stringify(disconnected));
      await denied(admit(target, client));
      await assert.rejects(setClasses(target, ["read"], 3), /storage_owner_version_conflict/);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
