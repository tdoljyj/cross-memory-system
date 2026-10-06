import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const LIST = "public.clued_storage_connections_v1";
const READ_DISCLOSURE = "clued.storage-read-disclosure/1";

// Storage connection discovery (Owner Decision 1721045d). Synthetic, disposable
// PostgreSQL only; setup follows the storage read fixture. Other fixtures may
// leave active connections of the same Owner, so assertions look at this
// fixture's own connections, never at the length of the whole list.
export async function testStorageConnections(t, admin, server, user, decision) {
  const clients = [], session = randomUUID(), clientIssuer = sha(randomUUID());
  const resource = "https://storage-connections.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon");
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'storage-connections-fixture')", [clientIssuer, resource]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/storage-connections-${suffix}/Clued_资料中心`, rootId = `connections-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `storage-connections/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `connections-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `connections-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='storage-connections-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{\"sealed\":true}' where id=$1",
      [connection, `storage-connections-${randomUUID()}`]);
    return { root, rootId, profile, connection, receipt: connected.receipt_id };
  };
  const activate = async target => {
    const policy = randomUUID(); await admin.query("begin");
    try {
      await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
        scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
        select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
          c.source_decision_id,c.decision_version,'reviewed_transition','storage-connections-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  // storage: false makes an ordinary Binding with no storage client registration.
  const bind = async (target, { storage = true } = {}) => {
    const token = sha(randomUUID()), clientId = `connections-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Storage connections fixture", redirect_uri: "https://storage-connections.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    if (!storage) return { token, id: approved.binding_id };
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, target.receipt]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, target.receipt]);
    await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)", [lineage, target.receipt]);
    return { token, id: approved.binding_id, lineage };
  };
  const list = async (client, database = caller) => (await database.query(`select ${LIST}($1) value`, [client.token])).rows[0].value;
  const entry = (result, target) => result.connections.find(item => item.connection_id === target.connection);
  const counts = async () => (await admin.query(`select (select count(*)::int from public.clued_audit_receipts) audit,
    (select count(*)::int from clued_private.storage_read_receipts_v1) reads,
    (select count(*)::int from clued_private.storage_jobs_v1) jobs`)).rows[0];

  try {
    const target = await activate(await createRoot()), pending = await createRoot();
    const client = await bind(target), plain = await bind(target, { storage: false });

    await t.test("connections surface ACL: Worker RPC is anon-only", async () => {
      const acl = (await admin.query(`select
        has_function_privilege('anon','${LIST}(text)','EXECUTE') anon,
        has_function_privilege('authenticated','${LIST}(text)','EXECUTE') auth,
        has_function_privilege('service_role','${LIST}(text)','EXECUTE') service`)).rows[0];
      assert.deepEqual(acl, { anon: true, auth: false, service: false });
    });

    await t.test("a malformed hash is refused, an unknown or revoked Binding is denied", async () => {
      await assert.rejects(caller.query(`select ${LIST}('not-a-hash')`), /storage_connections_input_invalid/);
      await assert.rejects(list({ token: sha(randomUUID()) }), /storage_connections_denied/);
      const revoked = await bind(target);
      await admin.query("update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1", [revoked.id]);
      await assert.rejects(list(revoked), /storage_connections_denied/);
    });

    await t.test("a Binding that is no storage client lists nothing", async () => {
      assert.deepEqual(await list(plain), { contract: "clued.storage-connections/1", connections: [], complete: true });
    });

    await t.test("an active connection is listed with its root, project, tracks and write levels, and nothing is written", async () => {
      const before = await counts();
      const result = await list(client);
      assert.equal(result.contract, "clued.storage-connections/1");
      assert.equal(result.complete, true);
      assert.deepEqual(entry(result, target), {
        connection_id: target.connection, name: "Clued_资料中心", managed_root: target.root, project_id: project,
        tracks: ["20_P_产品与体验"], inspect: true, write_levels: ["create_file", "create_topic"], read: [], normal_use: false });
      assert.equal(entry(result, pending), undefined, "a connection without an active policy is not listed");
      for (const item of result.connections) {
        assert.deepEqual(Object.keys(item).sort(), ["connection_id", "inspect", "managed_root", "name", "normal_use", "project_id", "read", "tracks", "write_levels"]);
      }
      assert.doesNotMatch(JSON.stringify(result), /storage-connections-subject|connections-root-|sealed/,
        "no provider subject, Drive ID or credential is returned");
      assert.deepEqual(await counts(), before, "listing writes no receipt, read receipt or job");
    });

    await t.test("read classes follow the Owner's read access", async () => {
      const enabled = (await native.query("select public.clued_storage_read_access_v1($1::jsonb) value", [JSON.stringify({
        action: "set_classes", connection_id: target.connection, classes: ["read"], base_generation: 0,
        disclosure_version: READ_DISCLOSURE, idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(enabled.status, "committed", JSON.stringify(enabled));
      const item = entry(await list(client), target);
      assert.deepEqual(item.read, ["read"]);
      assert.equal(item.normal_use, false);
      assert.deepEqual(item.write_levels, ["create_file", "create_topic"]);
    });

    await t.test("write levels follow the Owner's write access; normal use needs read_content, normal/1 and a normal grant", async () => {
      const write = async input => (await native.query("select public.clued_storage_write_access_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
      const status = await write({ action: "status", connection_id: target.connection });
      const modify = await write({ action: "set_classes", connection_id: target.connection, classes: ["modify"], base_generation: status.policy_generation,
        disclosure_version: "clued.storage-modify-disclosure/1", idempotency_key: randomUUID() });
      assert.equal(modify.status, "committed", JSON.stringify(modify));
      let item = entry(await list(client), target);
      assert.deepEqual(item.write_levels, ["create_file", "create_topic", "modify"]);
      assert.deepEqual(item.read, ["read"], "read access moves with the policy");
      // No API grants read_content and normal/1 in one step here; set them with triggers bypassed.
      const bypass = async (sql, values) => {
        await admin.query("set session_replication_role=replica");
        try { await admin.query(sql, values); } finally { await admin.query("set session_replication_role=origin"); }
      };
      await bypass("update clued_private.storage_read_access_v1 set classes='{read,read_content}',content_profile='normal/1' where connection_id=$1 and state='active'", [target.connection]);
      item = entry(await list(client), target);
      assert.deepEqual(item.read, ["read", "read_content"]);
      assert.equal(item.normal_use, false, "a legacy grant is not normal use");
      await bypass("update clued_private.storage_connections_v1 set provider_scope_profile='normal' where id=$1", [target.connection]);
      assert.equal(entry(await list(client), target).normal_use, true);
    });

    await t.test("a denied client and a disconnected connection are not listed", async () => {
      const denied = await bind(target);
      assert.ok(entry(await list(denied), target));
      await admin.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)", [user, denied.lineage, target.receipt]);
      assert.equal(entry(await list(denied), target), undefined);
      assert.ok(entry(await list(client), target), "a deny of one client leaves the others");
      const version = (await admin.query("select version from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0].version;
      const disconnected = (await native.query("select public.clued_storage_owner_manage_v2($1::jsonb) value", [JSON.stringify({
        action: "disconnect", connection_id: target.connection, base_version: Number(version), idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(disconnected.status, "committed", JSON.stringify(disconnected));
      assert.equal(entry(await list(client), target), undefined);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
