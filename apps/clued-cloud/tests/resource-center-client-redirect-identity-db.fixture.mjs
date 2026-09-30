import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const READ = "public.clued_storage_read_v1";
const ACCESS = "public.clued_storage_read_access_v1";
const OWNER = "public.clued_storage_owner_manage_v2";
const DISCLOSURE = "clued.storage-read-disclosure/1";
const SCOPES = ["audit:read", "context:read", "context:write"];

// AccountStorageInheritance.v0.1 §4.2 (rev. 2026-09-30): an approved request
// without a reviewed link inherits the one active qualified lineage with the
// same redirect identity. Synthetic, disposable PostgreSQL only.
export async function testStorageClientRedirectIdentity(t, admin, server, user, decision) {
  const clients = [], session = randomUUID(), issuer = sha(randomUUID()), clientIssuer = sha(randomUUID());
  const oauthClient = `redirect-identity-${randomUUID()}`, resource = "https://redirect-identity.invalid/mcp";
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
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'redirect-identity-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled) values($1,$2,'https://redirect-identity.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const suffix = randomUUID(), rootId = `redirect-root-${suffix}`, root = `/redirect-identity-${suffix}/Clued_资料中心`;
  const profile = (await register({ action: "profile_register", project_id: project, profile_version: `redirect-identity/${suffix}`,
    managed_root: root, root_folder_id: rootId, root_parent_id: `redirect-parent-${suffix}`, root_folder_version: "1" }))
    .target_refs.find(ref => ref.role === "primary").id;
  await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `redirect-track-${suffix}`,
    provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
  assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
    profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
  const connected = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
    action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  assert.equal(connected.status, "committed");
  const connection = connected.target_refs.find(ref => ref.role === "primary").id, receipt = connected.receipt_id;
  await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='redirect-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{\"sealed\":true}' where id=$1", [connection, oauthClient]);
  const policy = randomUUID();
  await admin.query("begin");
  try {
    await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
        c.source_decision_id,c.decision_version,'reviewed_transition','redirect-identity-fixture/1',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, connection]);
    await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, receipt]);
    await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
    await admin.query("commit");
  } catch (error) { await admin.query("rollback"); throw error; }
  const enabled = (await native.query(`select ${ACCESS}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: connection,
    classes: ["read"], base_generation: 0, disclosure_version: DISCLOSURE, idempotency_key: randomUUID() })])).rows[0].value;
  assert.equal(enabled.status, "committed", JSON.stringify(enabled));

  // An approved v12 request and Binding. No registration, link or capability.
  const bind = async ({ redirect = "https://client.example.com/oauth/callback", scopes = SCOPES } = {}) => {
    const token = sha(randomUUID()), clientId = `redirect-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Redirect identity fixture", redirect_uri: redirect,
      resource, requested_scopes: scopes })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    return { token, id: approved.binding_id, request: prepared.request_id, clientId };
  };
  // A reviewed anchor: registration from the request itself, its reviewed link and an active capability.
  const qualify = async client => {
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [client.request])).rows[0].value;
    await admin.query(`insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,
      review_receipt_id,source_request_id) values($1,1,$2,$3,$4,$5,$6,$7)`, [lineage, clientIssuer, resource, client.clientId, digest, receipt, client.request]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [client.request, lineage, digest, receipt]);
    const cap = (await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2) returning id", [lineage, receipt])).rows[0].id;
    return { ...client, lineage, cap };
  };
  const revokeCapability = async anchor => {
    const other = (await admin.query("select id from public.clued_audit_receipts where status='committed' and id<>$1 limit 1", [receipt])).rows[0].id;
    await admin.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1", [anchor.cap, other]);
  };
  const admit = client => caller.query(`select ${READ}($1,$2,$3::jsonb) value`, [issuer, client.token,
    JSON.stringify({ action: "admit", connection_id: connection, operation: "list", object_id: rootId })]).then(result => result.rows[0].value);
  const receipts = async () => (await admin.query("select count(*)::int n from clued_private.storage_read_receipts_v1 where connection_id=$1", [connection])).rows[0].n;
  const denied = async client => {
    const before = await receipts();
    await assert.rejects(admit(client), /storage_read_denied/);
    assert.equal(await receipts(), before, "a denied admission leaves no receipt");
  };
  const owner = async input => (await native.query(`select ${OWNER}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const access = async input => (await native.query(`select ${ACCESS}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;

  try {
    await t.test("redirect eligibility: only https on a public DNS host", async () => {
      const eligible = async uri => (await admin.query("select clued_private.storage_client_redirect_eligible_v3($1) value", [uri])).rows[0].value;
      for (const uri of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect", "https://a.example.com:443/cb"]) {
        assert.equal(await eligible(uri), true, uri);
      }
      for (const uri of ["http://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:50350/callback", "https://127.0.0.1/cb", "https://localhost/cb",
        "https://app.localhost/cb", "https://printer.local/cb", "https://[::1]/cb", "https://claude.ai:8443/cb", "https://claude.ai/cb?x=1",
        "https://claude.ai/cb#x", "https://Claude.ai/cb", "https://user@claude.ai/cb", "https://claude/cb", "https://claude.ai",
        "https://1.2.3.4/cb", "https://0x7f.1/cb", "https://10.0.0.1:443/cb", "https://-bad.example.com/cb", null]) {
        assert.equal(await eligible(uri), false, String(uri));
      }
      const acl = (await admin.query(`select
        has_function_privilege('anon','clued_private.storage_client_request_link_v3(uuid)','EXECUTE') link_anon,
        has_function_privilege('authenticated','clued_private.storage_client_request_matches_v3(uuid,uuid,bigint,text)','EXECUTE') matches_auth,
        has_function_privilege('service_role','clued_private.storage_client_redirect_identity_v3(uuid)','EXECUTE') identity_service`)).rows[0];
      assert.deepEqual(acl, { link_anon: false, matches_auth: false, identity_service: false });
    });

    const anchor = await qualify(await bind());

    await t.test("a reconnect with a fresh DCR client ID inherits the reviewed lineage", async () => {
      assert.ok((await admit(anchor)).receipt_id, "the reviewed anchor still reads");
      const reconnect = await bind();
      assert.notEqual(reconnect.clientId, anchor.clientId);
      const admitted = await admit(reconnect);
      assert.equal(admitted.binding_id, reconnect.id);
      const row = (await admin.query("select lineage_id,binding_id,state from clued_private.storage_read_receipts_v1 where id=$1", [admitted.receipt_id])).rows[0];
      assert.deepEqual(row, { lineage_id: anchor.lineage, binding_id: reconnect.id, state: "intent" });
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_request_links_v2 where request_id=$1", [reconnect.request])).rows[0].n, 0,
        "inheritance is derived, never written");
      // A root-relative write path resolves for the inherited client too (production clients are
      // linked this way, with no reviewed link row), so it is canonicalized before the digest.
      const hashOf = async id => (await admin.query("select token_hash from public.clued_agent_bindings where id=$1", [id])).rows[0].token_hash;
      const paths = async id => (await admin.query("select clued_private.storage_mutation_paths_v1($1,$2,$3::jsonb) value",
        [await hashOf(id), connection, JSON.stringify({ destination_path: "90_x/a.md" })])).rows[0].value.destination_path;
      assert.equal(await paths(reconnect.id), `${root}/90_x/a.md`, "an inherited client resolves the managed root");
      assert.equal(await paths(anchor.id), `${root}/90_x/a.md`, "the reviewed anchor resolves the managed root");
    });

    await t.test("a different redirect URI or scope set does not inherit", async () => {
      await denied(await bind({ redirect: "https://client.example.com/oauth/other" }));
      await denied(await bind({ redirect: "https://evil.example.net/oauth/callback" }));
      await denied(await bind({ scopes: ["context:read", "context:write"] }));
    });

    await t.test("loopback clients never inherit, even from a reviewed loopback lineage", async () => {
      const loopback = await qualify(await bind({ redirect: "http://127.0.0.1:8765/callback" }));
      assert.ok((await admit(loopback)).receipt_id, "the reviewed loopback client itself keeps its exact contract");
      await denied(await bind({ redirect: "http://127.0.0.1:8765/callback" }));
    });

    await t.test("a reviewed link keeps its exact client-ID contract and is never replaced by inheritance", async () => {
      const mislinked = await bind();
      await admin.query(`insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id)
        values($1,$2,1,$3,$4)`, [mislinked.request, anchor.lineage, sha("not this request"), receipt]);
      await denied(mislinked);
    });

    await t.test("lineage deny, read-class deny and the Owner client list apply to inherited clients", async () => {
      const reconnect = await bind();
      const listed = await owner({ action: "clients" });
      assert.ok(listed.clients.some(entry => entry.binding_id === reconnect.id && entry.denied === false), "inherited clients are listed");
      const classDeny = await access({ action: "deny_class", binding_id: reconnect.id, class: "read", denied: true, base_generation: 0, idempotency_key: randomUUID() });
      assert.equal(classDeny.status, "committed", JSON.stringify(classDeny));
      await denied(reconnect);
      await denied(anchor);
      assert.equal((await access({ action: "deny_class", binding_id: reconnect.id, class: "read", denied: false, base_generation: 1, idempotency_key: randomUUID() })).status, "committed");
      assert.ok((await admit(reconnect)).receipt_id);
      const revoked = await owner({ action: "revoke_client", binding_id: reconnect.id, base_generation: 0, idempotency_key: randomUUID() });
      assert.equal(revoked.status, "committed", JSON.stringify(revoked));
      await denied(reconnect);
      await denied(anchor);
      await denied(await bind());
    });

    await t.test("capability revocation and ambiguous anchors inherit nothing", async () => {
      const first = await qualify(await bind({ redirect: "https://second.example.com/cb" }));
      const reconnect = await bind({ redirect: "https://second.example.com/cb" });
      assert.ok((await admit(reconnect)).receipt_id);
      const twin = await qualify(await bind({ redirect: "https://second.example.com/cb" }));
      await denied(reconnect);
      assert.ok((await admit(twin)).receipt_id, "reviewed clients are unaffected by ambiguity");
      await revokeCapability(twin);
      assert.ok((await admit(reconnect)).receipt_id, "one active anchor remains");
      await revokeCapability(first);
      await denied(reconnect);
      await denied(first);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
