import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const READ = "public.clued_storage_read_v1";
const ACCESS = "public.clued_storage_read_access_v1";
const DISCLOSURE = "clued.storage-read-disclosure/1";
const CONTENT_DISCLOSURE = "clued.storage-read-content-disclosure/1";
const CHUNK = 262144, BUDGET = 8 * 1024 * 1024;

// StorageFullCapability.v0.1 P2 read_content at the database layer: its own
// disclosure, one object per read, the per-class deny and the hourly budget.
// Synthetic, disposable PostgreSQL only.
export async function testStorageReadContent(t, admin, server, user, decision) {
  const clients = [], session = randomUUID(), issuer = sha(randomUUID()), clientIssuer = sha(randomUUID());
  const oauthClient = `read-content-${randomUUID()}`, resource = "https://read-content.invalid/mcp";
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
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'read-content-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled) values($1,$2,'https://read-content.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const suffix = randomUUID(), rootId = `content-root-${suffix}`, root = `/read-content-${suffix}/Clued_资料中心`;
  const profile = (await register({ action: "profile_register", project_id: project, profile_version: `read-content/${suffix}`,
    managed_root: root, root_folder_id: rootId, root_parent_id: `content-parent-${suffix}`, root_folder_version: "1" }))
    .target_refs.find(ref => ref.role === "primary").id;
  await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `content-track-${suffix}`,
    provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
  assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
    profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
  const connected = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
    action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  assert.equal(connected.status, "committed");
  const connection = connected.target_refs.find(ref => ref.role === "primary").id, receipt = connected.receipt_id;
  await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='content-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{\"sealed\":true}' where id=$1", [connection, oauthClient]);
  const policy = randomUUID();
  await admin.query("begin");
  try {
    await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
        c.source_decision_id,c.decision_version,'reviewed_transition','read-content-fixture/1',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, connection]);
    await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, receipt]);
    await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
    await admin.query("commit");
  } catch (error) { await admin.query("rollback"); throw error; }
  // A reviewed, qualified client (the P1 fixture shape).
  const bind = async () => {
    const token = sha(randomUUID()), clientId = `content-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Read content fixture", redirect_uri: "https://read-content.invalid/client-callback",
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

  try {
    const client = await bind(), other = await bind();

    await t.test("read_content has its own disclosure; the Owner can now enable it", async () => {
      assert.equal((await setClasses(["read"], DISCLOSURE)).status, "committed");
      const before = await status();
      assert.equal(before.content_disclosure_version, CONTENT_DISCLOSURE); assert.equal(before.disclosure_version, DISCLOSURE);
      await assert.rejects(admit(client), /storage_read_denied/, "read alone does not grant bodies");
      await assert.rejects(setClasses(["read", "read_content"], DISCLOSURE), /storage_read_disclosure_changed/);
      await assert.rejects(setClasses(["read_content"], CONTENT_DISCLOSURE), /storage_owner_input_invalid/, "bodies always come with the read level");
      const enabled = await setClasses(["read", "read_content"], CONTENT_DISCLOSURE);
      assert.equal(enabled.status, "committed", JSON.stringify(enabled));
      const after = await status();
      assert.deepEqual(after.classes, ["read", "read_content"]); assert.equal(after.read_generation, before.read_generation + 1);
      assert.equal((await admin.query("select disclosure_version from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [connection])).rows[0].disclosure_version,
        CONTENT_DISCLOSURE, "the stored disclosure names the text that was shown");
    });

    await t.test("a content read names exactly one object and records the read_content class", async () => {
      const before = await receipts();
      await assert.rejects(call(client, { action: "admit", connection_id: connection, operation: "read" }), /storage_read_input_invalid/);
      assert.equal(await receipts(), before);
      const admitted = await admit(client);
      assert.equal(admitted.class, "read_content");
      const row = (await admin.query("select class,operation,object_id,state from clued_private.storage_read_receipts_v1 where id=$1", [admitted.receipt_id])).rows[0];
      assert.deepEqual(row, { class: "read_content", operation: "read", object_id: "contentFile00001", state: "intent" });
      assert.equal((await finalize(client, admitted, 1234)).state, "finalized");
      assert.equal((await call(client, { action: "admit", connection_id: connection, operation: "list" })).class, "read", "browse keeps the read class");
    });

    await t.test("the per-class deny removes bodies for one client and keeps its read level", async () => {
      const deny = await access({ action: "deny_class", binding_id: other.id, class: "read_content", denied: true, base_generation: 0, idempotency_key: randomUUID() });
      assert.equal(deny.status, "committed", JSON.stringify(deny));
      await assert.rejects(admit(other), /storage_read_denied/);
      assert.equal((await call(other, { action: "admit", connection_id: connection, operation: "list" })).class, "read");
      assert.equal((await admit(client)).class, "read_content", "another client is unaffected");
      // A content response names the file, which the read level covers: a read deny stops content too.
      const third = await bind();
      assert.equal((await access({ action: "deny_class", binding_id: third.id, class: "read", denied: true, base_generation: 0, idempotency_key: randomUUID() })).status, "committed");
      await assert.rejects(admit(third), /storage_read_denied/);
    });

    await t.test("each Binding has an 8 MiB hourly content budget; unfinalized reads count as a full chunk", async () => {
      const fresh = await bind();
      for (let used = 0; used + CHUNK <= BUDGET; used += CHUNK) {
        const admitted = await admit(fresh);
        assert.equal((await finalize(fresh, admitted, CHUNK)).state, "finalized");
      }
      await assert.rejects(admit(fresh), /storage_read_budget_exhausted/);
      assert.equal((await admit(client)).class, "read_content", "the budget is per Binding");
      const pending = await bind();
      for (let i = 0; i < BUDGET / CHUNK; i++) await admit(pending);
      await assert.rejects(admit(pending), /storage_read_budget_exhausted/, "in-flight reads cannot overrun the budget");
      // Two concurrent admissions with one chunk of budget left: the second waits, then sees the first.
      const racing = await bind();
      for (let used = 0; used + 2 * CHUNK <= BUDGET; used += CHUNK) await finalize(racing, await admit(racing), CHUNK);
      await caller.query("begin");
      try {
        assert.equal((await admit(racing)).class, "read_content", "the last chunk is admitted");
        const second = admit(racing, {}, racer);
        await waitForLock(racer);
        await caller.query("commit");
        await assert.rejects(second, /storage_read_budget_exhausted/, "a concurrent call cannot pass the budget check with a stale sum");
      } catch (error) { await caller.query("rollback").catch(() => {}); throw error; }
      assert.equal((await call(fresh, { action: "admit", connection_id: connection, operation: "list" })).class, "read", "browse has no content budget");
    });

    await t.test("turning read_content off stops bodies but not the read level", async () => {
      assert.equal((await setClasses(["read"], DISCLOSURE)).status, "committed");
      await assert.rejects(admit(client), /storage_read_denied/);
      assert.equal((await call(client, { action: "admit", connection_id: connection, operation: "list" })).class, "read");
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
