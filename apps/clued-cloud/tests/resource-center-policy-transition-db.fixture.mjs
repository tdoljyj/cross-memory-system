import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const ACTIONS = ["inspect", "create_file", "create_topic"];
const ADMIN = "clued_private.storage_policy_transition_admin_v2";
const NATIVE = "public.clued_storage_policy_transition_v2";

// Disposable PostgreSQL fixture only. This does not publish manifests, migrate
// real connections or issue a provider request. Reviewed client identity seeds
// reuse the foundation schema; qualification is tested in its separate fixture.
export async function testStoragePolicyTransition(t, admin, server, user, decision) {
  const clients = [], sessionId = randomUUID(), issuer = hash(randomUUID()), oauthClient = `transition-${randomUUID()}`;
  const clientIssuer = hash(randomUUID()), resource = "https://policy-transition.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const platform = (await admin.query("select subject_id,version from clued_private.platform_admin_v13 where singleton")).rows[0];
  assert.ok(platform, "reviewed platform designation must be supplied by the earlier isolated fixture");
  const connect = async role => {
    const client = server.getPgClient(); clients.push(client); await client.connect();
    await client.query("set statement_timeout='10s'");
    if (role) await client.query(`set role ${role}`);
    client.fixturePid = (await client.query("select pg_backend_pid() pid")).rows[0].pid;
    return client;
  };
  const native = await connect("authenticated"), operator = await connect(), contender = await connect("authenticated");
  const login = (client, owner = user, sid = sessionId) => client.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [owner, JSON.stringify({ sub: owner, role: "authenticated", session_id: sid, aal: "aal1",
      amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] })]);
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [sessionId, user]);
  await login(native); await login(contender);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'transition-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,$2,'https://policy-transition.invalid/storage/google/callback')", [issuer, oauthClient]);
  const account = async (input, client = native) => (await client.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const root = async ({ rootId = `transition-root-${randomUUID()}`, managedRoot = `/transition-${randomUUID()}/Clued_资料中心` } = {}) => {
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `transition/${randomUUID()}`,
      managed_root: managedRoot, root_folder_id: rootId, root_parent_id: "transition-parent", root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: managedRoot + "/20_P_产品与体验", provider_file_id: `transition-track-${randomUUID()}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const runtime = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(runtime.status, "committed", JSON.stringify(runtime));
    const registeredConnection = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(registeredConnection.status, "committed", JSON.stringify(registeredConnection));
    const connection = registeredConnection.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='synthetic-transition-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { rootId, managedRoot, profile, connection, receipt: registeredConnection.receipt_id, history: [] };
  };
  const binding = async target => {
    const token = hash(randomUUID()), clientId = `transition-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: hash(randomUUID()), client_id: clientId, client_name: "Reviewed transition fixture", redirect_uri: "https://policy-transition.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, target.receipt]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, target.receipt]);
    const capability = (await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2) returning id", [lineage, target.receipt])).rows[0].id;
    return { token, id: approved.binding_id, request: prepared.request_id, lineage, capability };
  };
  const grant = async (target, client, actions = ACTIONS, revoke = false) => {
    const current = (await admin.query("select version from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0];
    const authorization = (await admin.query("select version from clued_private.authorizations_v12 where binding_id=$1", [client.id])).rows[0];
    const payload = { action: revoke ? "revoke_client" : "grant_client", idempotency_key: randomUUID(), connection_id: target.connection,
      base_version: Number(current.version), binding_id: client.id, authorization_version: Number(authorization.version),
      ...(!revoke ? { actions, expires_at: new Date(Date.now() + 3600000).toISOString() } : {}) };
    const result = await account(payload); assert.equal(result.status, "committed", JSON.stringify(result));
    target.history.push({ receipt_id: result.receipt_id, payload }); return result;
  };
  const inventory = async (target, history = target.history) => (await admin.query(
    "select clued_private.storage_policy_transition_inventory_v2($1,$2,$3::jsonb) value", [user, target.connection, JSON.stringify(history)])).rows[0].value;
  const digest = async value => (await admin.query("select clued_private.m1_sha256($1::jsonb) value", [JSON.stringify(value)])).rows[0].value;
  const evidence = async text => {
    const input = { idempotency_key: randomUUID(), evidence_schema_version: 1, evidence_type: "test_output", storage_ref: `isolated-transition:${randomUUID()}`,
      content_hash: hash(text), size_bytes: Buffer.byteLength(text, "utf8"), mime_type: "application/json" };
    const result = (await admin.query("select clued_private.evidence_ingest_core($1,null,$2::jsonb,clued_private.m1_sha256($2::jsonb)) value", [platform.subject_id, JSON.stringify(input)])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return { id: result.evidence_ids[0], digest: input.content_hash };
  };
  const adminCall = async (input, client = admin) => (await client.query(`select ${ADMIN}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const rpc = async (input, client = native, secret = issuer) => (await client.query(`select ${NATIVE}($1,$2::jsonb) value`, [secret, JSON.stringify(input)])).rows[0].value;
  const manifestInput = async (target, overrides = {}, history = target.history) => {
    const version = (await admin.query("select version from public.clued_memories where id=$1", [decision])).rows[0].version;
    const document = { contract: "clued.storage-policy-transition/2", owner_id: user, connection_id: target.connection, source_decision_id: decision,
      decision_version: Number(version), disclosure_version: "clued.storage-account-consent/2", expires_at: new Date(Date.now() + 3600000).toISOString(),
      expected_inventory_digest: await digest(await inventory(target, history)), history_preimages: history, ...overrides };
    const text = JSON.stringify(document, null, 2) + "\n", proof = await evidence(text);
    return { action: "register", platform_admin_version: Number(platform.version), idempotency_key: randomUUID(), evidence_id: proof.id,
      evidence_sha256: proof.digest, manifest_json: text };
  };
  const manifest = async (target, overrides = {}) => {
    const input = await manifestInput(target, overrides), result = await adminCall(input);
    assert.equal(result.status, "committed", JSON.stringify(result));
    const id = result.target_refs.find(ref => ref.role === "primary").id;
    const description = await rpc({ action: "describe", manifest_id: id });
    return { id, input, result, description, target };
  };
  const transition = item => ({ action: "transition", manifest_id: item.id, manifest_sha256: item.description.manifest_sha256,
    expected_inventory_digest: item.description.expected_inventory_digest, idempotency_key: randomUUID() });
  const effects = async () => (await admin.query(`select jsonb_build_object(
    'connections',(select jsonb_agg(to_jsonb(c) order by id) from clued_private.storage_connections_v1 c),
    'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from clued_private.storage_account_policies_v2 p),
    'denies',(select coalesce(jsonb_agg(to_jsonb(d) order by owner_id,lineage_id),'[]') from clued_private.storage_client_denies_v2 d),
    'root_denies',(select coalesce(jsonb_agg(to_jsonb(d) order by id),'[]') from clued_private.storage_root_denies_v2 d),
    'grants',(select coalesce(jsonb_agg(to_jsonb(g) order by connection_id,binding_id),'[]') from clued_private.storage_client_grants_v1 g),
    'jobs',(select coalesce(jsonb_agg(to_jsonb(j) order by owner_id,job_id),'[]') from clued_private.storage_jobs_v1 j),
    'intents',(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from clued_private.resource_center_mutations_v1 m)) value`)).rows[0].value;
  const rejected = async (operation, pattern = /storage_transition_/) => {
    const before = await effects();
    await assert.rejects(operation, pattern); assert.deepEqual(await effects(), before);
  };
  const queued = async (target, client) => {
    const job = randomUUID(), mutation = { operation: "create", target_kind: "file", destination_path: target.managedRoot + "/20_P_产品与体验/transition-fixture.txt", content: "synthetic transition test" };
    const result = (await admin.query("select public.clued_storage_jobs_v1($1,$2::jsonb) value", [client.token, JSON.stringify({
      action: "submit", connection_id: target.connection, job_id: job, mutation })])).rows[0].value;
    assert.equal(result.status, "queued", JSON.stringify(result));
    return (await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, job])).rows[0];
  };
  const cancel = (item, job) => ({ ...transition(item), action: "cancel_queued", job_id: job.job_id,
    request_digest: job.request_digest, submit_receipt_id: job.receipt_id });
  const evaluate = async (target, client) => (await admin.query("select clued_private.storage_policy_evaluate_v2($1,$2,'inspect',$3) value",
    [client.token, target.connection, randomUUID()])).rows[0].value;
  const historicalReplay = async (input, committed) => {
    const before = await effects();
    const counts = async () => (await admin.query("select (select count(*)::int from public.clued_audit_receipts) receipts,(select count(*)::int from public.clued_context_events) events")).rows[0];
    const auditBefore = await counts(), otherIssuers = [hash(randomUUID()), hash(randomUUID())];
    const original = (await admin.query("select execution_enabled,revoked_at from clued_private.storage_oauth_apps_v1 where issuer_hash=$1", [issuer])).rows[0];
    try {
      for (const [index, other] of otherIssuers.entries()) await admin.query(
        "insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,$2,'https://policy-transition.invalid/storage/google/callback')",
        [other, index === 0 ? oauthClient : `unrelated-replay-${randomUUID()}`]);
      for (const revoked of [false, true]) {
        await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=true,revoked_at=case when $2 then clock_timestamp() else null end where issuer_hash=$1", [issuer, revoked]);
        assert.deepEqual(await rpc(input), committed);
        assert.deepEqual(await effects(), before); assert.deepEqual(await counts(), auditBefore);
        for (const other of otherIssuers) await rejected(() => rpc(input, native, other), /storage_transition_denied|storage_transition_conflict/);
        assert.deepEqual(await counts(), auditBefore);
      }
    } finally {
      await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=$2,revoked_at=$3 where issuer_hash=$1", [issuer, original.execution_enabled, original.revoked_at]);
      await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=false,revoked_at=clock_timestamp() where issuer_hash=any($1::text[])", [otherIssuers]);
    }
  };
  const waitForLock = async client => {
    for (let i = 0; i < 200; i++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting", [client.fixturePid])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("transition operation did not reach its intended lock wait");
  };
  try {
    await t.test("transition manifests are offline-operator only and native cutover requires both the live Owner and fixed issuer", async () => {
      for (const name of ["storage_policy_transition_manifests_v2", "storage_policy_transition_results_v2", "storage_policy_transition_cancellations_v2"]) {
        const acl = (await admin.query(`select c.relrowsecurity,
          has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') anon,
          has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') authenticated,
          has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') service
          from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='clued_private' and c.relname=$1`, [name])).rows[0];
        assert.deepEqual(acl, { relrowsecurity: true, anon: false, authenticated: false, service: false }, name);
      }
      for (const signature of [`${ADMIN}(jsonb)`, "clued_private.storage_policy_transition_inventory_v2(uuid,uuid,jsonb)"]) {
        const acl = (await admin.query(`select has_function_privilege('anon',p.oid,'EXECUTE') anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service,
          exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public
          from pg_proc p where p.oid=$1::regprocedure`, [signature])).rows[0];
        assert.deepEqual(acl, { anon: false, authenticated: false, service: false, public: false }, signature);
      }
      const target = await root(), client = await binding(target); await grant(target, client);
      const input = await manifestInput(target), before = await effects();
      for (const role of ["anon", "authenticated", "service_role"]) {
        const caller = await connect(role); await login(caller);
        await rejected(() => adminCall(input, caller), /permission denied|offline_database_operator_required/);
      }
      const item = await manifest(target); assert.deepEqual(await effects(), before);
      assert.equal((await adminCall(item.input)).receipt_id, item.result.receipt_id);
      await assert.rejects(admin.query("update clued_private.storage_policy_transition_manifests_v2 set expires_at=expires_at+interval '1 hour' where id=$1", [item.id]), /storage_transition_history_immutable/);
      const request = transition(item);
      await rejected(() => rpc(request, native, hash("unknown issuer")), /storage_transition_denied/);
      const anon = await connect("anon");
      await rejected(() => rpc(request, anon), /permission denied|native|denied/);
      const naked = await connect("service_role");
      await rejected(() => rpc(request, naked), /permission denied|native|denied/);
      const wrongOwner = randomUUID(), wrongSession = randomUUID();
      await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'other-transition@example.invalid',now())", [wrongOwner]);
      await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [wrongSession, wrongOwner]);
      await login(contender, wrongOwner, wrongSession);
      await rejected(() => rpc(request, contender), /storage_transition_denied/);
      await login(contender);
      for (const action of ["describe", "inspect"]) {
        const value = await rpc({ action, manifest_id: item.id });
        assert.ok(!JSON.stringify(value).includes("credential_envelope"));
        assert.ok(!JSON.stringify(value).includes(issuer));
      }
      assert.deepEqual(await effects(), before);
    });
    await t.test("reviewed transition commits one sustained policy and reads back two exact receipts without new Google consent", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      const item = await manifest(target), request = transition(item), before = await effects();
      const result = await rpc(request); assert.equal(result.status, "committed", JSON.stringify(result));
      const inspected = await rpc({ action: "inspect", manifest_id: item.id });
      assert.ok(inspected.transition_receipt_id); assert.ok(inspected.policy_receipt_id);
      assert.notEqual(inspected.transition_receipt_id, inspected.policy_receipt_id);
      for (const id of [inspected.transition_receipt_id, inspected.policy_receipt_id]) {
        const receipt = (await admin.query("select user_id,status,binding_id from public.clued_audit_receipts where id=$1", [id])).rows[0];
        assert.deepEqual(receipt, { user_id: user, status: "committed", binding_id: null });
      }
      const stored = (await admin.query("select * from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0];
      assert.equal(stored.auth_mode, "account_policy"); assert.equal(Number(stored.auth_generation), 1);
      const policy = (await admin.query("select * from clued_private.storage_account_policies_v2 where id=$1", [stored.account_policy_id])).rows[0];
      assert.equal(policy.state, "active"); assert.equal(policy.expires_at, null); assert.deepEqual(policy.actions, ACTIONS);
      assert.equal(policy.activation_receipt_id, inspected.policy_receipt_id);
      const after = await effects();
      const original = before.connections.find(connection => connection.id === target.connection);
      for (const key of ["credential_envelope", "provider_subject", "oauth_client_id"]) assert.deepEqual(stored[key], original[key], key);
      assert.equal(Number(stored.credential_version), Number(original.credential_version));
      assert.deepEqual(after.jobs, before.jobs); assert.deepEqual(after.intents, before.intents);
      assert.equal((await evaluate(target, client)).policy_id, policy.id);
      const replay = await rpc(request); assert.equal(replay.receipt_id, result.receipt_id); assert.deepEqual(await effects(), after);
      await historicalReplay(request, result);
      await rejected(() => rpc({ ...request, manifest_sha256: hash("substitution") }), /conflict|IDEMPOTENCY|denied/);
      await rejected(() => account({ action: "grant_client", connection_id: target.connection, binding_id: client.id,
        base_version: Number(stored.version), authorization_version: 1, actions: ACTIONS, expires_at: new Date(Date.now() + 3600000).toISOString(), idempotency_key: randomUUID() }), /storage_legacy_mode_denied/);
    });
    await t.test("account-policy jobs need no legacy client grant and pin one immutable authority snapshot with exact job replay", async () => {
      const target = await root(), client = await binding(target), item = await manifest(target);
      assert.equal((await rpc(transition(item))).status, "committed");
      const caller = await connect("anon"), jobId = randomUUID();
      const input = { action: "submit", connection_id: target.connection, job_id: jobId, mutation: { operation: "create", target_kind: "file",
        destination_path: target.managedRoot + "/20_P_产品与体验/queued-policy-fixture.txt", content: "queued only; no provider effect" } };
      const submit = async (request, database = caller) => (await database.query("select public.clued_storage_jobs_v2($1,$2::jsonb) value", [client.token, JSON.stringify(request)])).rows[0].value;
      const before = await effects(), result = await submit(input);
      assert.equal(result.status, "queued"); assert.equal(result.execution_permitted, false); assert.equal(result.intent_id, null);
      assert.equal(result.replayed, false); assert.equal(result.authority_snapshot_v2, undefined);
      const saved = (await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, jobId])).rows[0];
      assert.equal(saved.binding_id, client.id); assert.equal(saved.intent_id, null); assert.equal(saved.cloud_writer_binding_id, null);
      const policy = (await admin.query("select * from clued_private.storage_account_policies_v2 where id=$1", [saved.authority_snapshot_v2.policy_id])).rows[0];
      assert.deepEqual(saved.authority_snapshot_v2, { ...await evaluate(target, client), consent_receipt_id: policy.consent_receipt_id });
      assert.equal(saved.grant_receipt_id, policy.activation_receipt_id);
      assert.equal(saved.authority_snapshot_v2.consent_receipt_id, policy.consent_receipt_id);
      assert.equal(saved.authority_snapshot_v2.policy_receipt_id, policy.activation_receipt_id);
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where id=any($1::uuid[]) and status='committed'",
        [[policy.consent_receipt_id, policy.activation_receipt_id]])).rows[0].n, 2);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_grants_v1 where connection_id=$1", [target.connection])).rows[0].n, 0);
      const after = await effects(); assert.equal(after.jobs.length, before.jobs.length + 1); assert.deepEqual(after.intents, before.intents);
      const replay = await submit(input); assert.equal(replay.receipt_id, result.receipt_id); assert.equal(replay.replayed, true);
      assert.deepEqual(await effects(), after);
      await rejected(() => submit({ ...input, mutation: { ...input.mutation, content: "different payload" } }), /storage_job_identity_conflict/);
      await assert.rejects(admin.query("update clued_private.storage_jobs_v1 set authority_snapshot_v2=authority_snapshot_v2||'{\"policy_generation\":999}'::jsonb where owner_id=$1 and job_id=$2", [user, jobId]), /storage_job_authority_immutable/);
      assert.deepEqual((await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, jobId])).rows[0], saved);
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where user_id=$1 and idempotency_key=$2 and status='committed'", [user, "storage-job:" + jobId])).rows[0].n, 1);

      const auditCounts = async () => (await admin.query("select (select count(*)::int from public.clued_audit_receipts) receipts,(select count(*)::int from public.clued_context_events) events")).rows[0];
      const inspectInput = { action: "inspect", connection_id: target.connection, job_id: jobId };
      const { replayed: ignoredReplayFlag, ...originalStatus } = result;
      const readOriginalHistory = async () => {
        const currentEffects = await effects(), currentAudit = await auditCounts();
        assert.deepEqual(await submit(input), { ...result, replayed: true });
        assert.deepEqual(await submit(inspectInput), originalStatus);
        await rejected(() => submit({ ...input, mutation: { ...input.mutation, content: "different historical payload" } }), /storage_job_identity_conflict/);
        assert.deepEqual(await effects(), currentEffects); assert.deepEqual(await auditCounts(), currentAudit);
        assert.deepEqual((await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, jobId])).rows[0], saved);
      };
      // Synthetic lifecycle changes in this disposable fixture must not turn
      // exact history readback into a new admission, job or provider effect.
      await admin.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1",
        [client.capability, policy.consent_receipt_id]);
      await readOriginalHistory();
      const successorCapability = (await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,version,receipt_id) values($1,1,3,$2) returning id",
        [client.lineage, policy.activation_receipt_id])).rows[0].id;
      assert.notEqual(successorCapability, saved.authority_snapshot_v2.capability_id);
      await readOriginalHistory();
      await admin.query("begin");
      try {
        await admin.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1",
          [policy.id, policy.consent_receipt_id]);
        await admin.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',auth_generation=auth_generation+1,version=version+1,credential_envelope=null where id=$1",
          [target.connection]);
        await admin.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,receipt_id) values($1,'google-drive','synthetic-transition-subject',$2,$3)",
          [user, target.rootId, policy.consent_receipt_id]);
        await admin.query("commit");
      } catch (error) { await admin.query("rollback"); throw error; }
      await readOriginalHistory();
      // A root-wide disconnect is not a client-read revocation. Either exact
      // lineage deny must still block history, independently of that tombstone.
      for (const scope of ["global", "root-lineage"]) {
        await admin.query("begin");
        try {
          await admin.query("select clued_private.storage_client_guard_v2($1,$2,$3)", [user, client.lineage, scope === "global"]);
          if (scope === "root-lineage") {
            await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`storage-job:${user}:${jobId}`]);
            await admin.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${user}:${target.rootId}`]);
          }
          if (scope === "global") await admin.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)",
            [user, client.lineage, policy.consent_receipt_id]);
          else await admin.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','synthetic-transition-subject',$2,$3,$4)",
            [user, target.rootId, client.lineage, policy.consent_receipt_id]);
          const deniedEffects = await effects(), deniedAudit = await auditCounts();
          for (const request of [input, inspectInput]) {
            await admin.query("savepoint history_denied");
            await assert.rejects(submit(request, admin), /storage_policy_denied/);
            await admin.query("rollback to savepoint history_denied");
          }
          assert.deepEqual(await effects(), deniedEffects); assert.deepEqual(await auditCounts(), deniedAudit);
        } finally { await admin.query("rollback"); }
        await readOriginalHistory();
      }
      // Historical readback still belongs to the original live authorization;
      // disconnecting storage does not turn its receipts into public records.
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [client.id]);
      const auditAfterExpiry = await auditCounts();
      await rejected(() => submit(input), /storage_policy_denied/);
      await rejected(() => submit(inspectInput), /storage_policy_denied/);
      assert.deepEqual(await auditCounts(), auditAfterExpiry);
    });
    await t.test("manifest proofs require every exact historical payload and reject substitutions without changing account authority", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      const input = await manifestInput(target), document = JSON.parse(input.manifest_json);
      for (const history of [[], [{ ...target.history[0], payload: { ...target.history[0].payload, actions: ["inspect"] } }],
        [{ ...target.history[0], receipt_id: randomUUID() }]]) {
        const text = JSON.stringify({ ...document, history_preimages: history }) + "\n", proof = await evidence(text);
        await rejected(() => adminCall({ ...input, idempotency_key: randomUUID(), manifest_json: text, evidence_id: proof.id, evidence_sha256: proof.digest }), /storage_transition_history_unproven/);
      }
      await rejected(() => adminCall({ ...input, evidence_sha256: hash("different bytes") }), /storage_transition_review_required/);
      await rejected(() => adminCall({ ...input, platform_admin_version: Number(platform.version) + 1 }), /platform_admin|required|conflict/);
      const tooLong = await manifestInput(target, { expires_at: new Date(Date.now() + 25 * 3600000).toISOString() });
      await rejected(() => adminCall(tooLong), /storage_transition_input_invalid/);
    });
    await t.test("transition CAS covers inventories and rejects caller-supplied Owner, paths, actions or policy authority", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      const item = await manifest(target), request = transition(item);
      for (const extra of [{ owner_id: user }, { connection_id: target.connection }, { managed_root: target.managedRoot },
        { actions: ACTIONS }, { profile_id: target.profile }, { policy_id: randomUUID() }]) {
        await rejected(() => rpc({ ...request, ...extra }), /storage_transition_input_invalid/);
      }
      await rejected(() => rpc({ ...request, expected_inventory_digest: hash("stale inventory") }), /storage_transition_conflict/);
      await grant(target, client);
      await rejected(() => rpc(request), /storage_transition_conflict|storage_transition_history_unproven/);
    });
    await t.test("the active-root uniqueness constraint and revoked-profile fences prevent a second live legacy route without blocking quiet historical cutover", async () => {
      const old = await root(), client = await binding(old); await grant(old, client);
      await assert.rejects(admin.query(`insert into clued_private.resource_center_profiles_v1
        select (jsonb_populate_record(null::clued_private.resource_center_profiles_v1,to_jsonb(p)||$2::jsonb)).*
        from clued_private.resource_center_profiles_v1 p where p.id=$1`, [old.profile, JSON.stringify({
          id: randomUUID(), managed_root: `/forbidden-second-active-${randomUUID()}/Clued_资料中心`, profile_version: `duplicate/${randomUUID()}` })]),
        error => error.code === "23505" && error.constraint === "resource_center_profiles_v1_provider_root_active_uidx");
      await register({ action: "profile_revoke", profile_id: old.profile, base_version: 1 });
      const target = await root({ rootId: old.rootId }); target.history.push(...old.history);
      const item = await manifest(target), view = await inventory(target);
      const historical = view.root_connections.find(connection => connection.id === old.connection);
      assert.equal(historical.state, "active"); assert.equal(historical.profile_state, "revoked");
      assert.equal(Number(historical.profile_version), 2);
      const connection = (await admin.query("select version from clued_private.storage_connections_v1 where id=$1", [old.connection])).rows[0];
      await rejected(() => account({ action: "grant_client", connection_id: old.connection, binding_id: client.id,
        base_version: Number(connection.version), authorization_version: 1, actions: ACTIONS,
        expires_at: new Date(Date.now() + 3600000).toISOString(), idempotency_key: randomUUID() }), /storage_connection_unavailable/);
      await rejected(() => admin.query("select public.clued_storage_jobs_v1($1,$2::jsonb)", [client.token, JSON.stringify({
        action: "submit", connection_id: old.connection, job_id: randomUUID(), mutation: { operation: "create", target_kind: "file",
          destination_path: old.managedRoot + "/20_P_产品与体验/forbidden-old-route.txt", content: "must never create" } })]), /storage_connection_unavailable|storage_binding_denied/);
      assert.equal((await rpc(transition(item))).status, "committed");
      assert.ok((await evaluate(target, client)).policy_id);
      await assert.rejects(evaluate(old, client), /storage_policy_denied/);
    });
    await t.test("another live issuer for the same Google client prevents cutover even while the selected executor is disabled", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      const item = await manifest(target), secondIssuer = hash(randomUUID());
      assert.equal((await admin.query("select execution_enabled from clued_private.storage_oauth_apps_v1 where issuer_hash=$1", [issuer])).rows[0].execution_enabled, false);
      await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://policy-transition.invalid/storage/google/callback',true)", [secondIssuer, oauthClient]);
      try {
        await rejected(() => rpc(transition(item)), /storage_transition_denied/);
        assert.equal((await rpc({ action: "inspect", manifest_id: item.id })).execution_permitted, false);
        const stored = (await admin.query("select auth_mode,account_policy_id from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0];
        assert.deepEqual(stored, { auth_mode: "legacy", account_policy_id: null });
      } finally {
        await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=false,revoked_at=clock_timestamp() where issuer_hash=$1", [secondIssuer]);
      }
      const later = await root(), laterClient = await binding(later); await grant(later, laterClient);
      const laterManifest = await manifest(later), inserting = await connect(), lateIssuer = hash(randomUUID());
      await operator.query("begin"); await operator.query("set local role authenticated"); await login(operator); let pending;
      try {
        assert.equal((await rpc(transition(laterManifest), operator)).status, "committed");
        pending = inserting.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://policy-transition.invalid/storage/google/callback',true)",
          [lateIssuer, oauthClient]).then(value => ({ value }), error => ({ error }));
        await waitForLock(inserting); await operator.query("commit");
        assert.equal((await pending).error, undefined);
        assert.equal((await admin.query("select auth_mode from clued_private.storage_connections_v1 where id=$1", [later.connection])).rows[0].auth_mode, "account_policy");
      } finally {
        await operator.query("rollback"); if (pending) await pending;
        await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=false,revoked_at=clock_timestamp() where issuer_hash=$1", [lateIssuer]);
      }
    });
    await t.test("partial grants and even rowless legacy revokes retain a root-lineage deny instead of inheriting broader actions", async () => {
      for (const mode of ["partial", "rowless-revoke"]) {
        const target = await root(), client = await binding(target);
        await grant(target, client, mode === "partial" ? ["inspect"] : ACTIONS, mode === "rowless-revoke");
        const item = await manifest(target), result = await rpc(transition(item)); assert.equal(result.status, "committed", JSON.stringify(result));
        const deny = (await admin.query("select denied from clued_private.storage_root_denies_v2 where owner_id=$1 and root_folder_id=$2 and lineage_id=$3", [user, target.rootId, client.lineage])).rows[0];
        assert.equal(deny?.denied, true, mode); await assert.rejects(evaluate(target, client), /storage_policy_denied/);
      }
    });
    await t.test("natural grant expiry does not create a permanent deny or shorten policy lifetime, but expired Binding still denies", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      await admin.query("update clued_private.storage_client_grants_v1 set expires_at=clock_timestamp()-interval '1 second' where connection_id=$1", [target.connection]);
      const item = await manifest(target), result = await rpc(transition(item)); assert.equal(result.status, "committed", JSON.stringify(result));
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_root_denies_v2 where owner_id=$1 and root_folder_id=$2", [user, target.rootId])).rows[0].n, 0);
      assert.ok((await evaluate(target, client)).policy_id);
      await admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [client.id]);
      await assert.rejects(evaluate(target, client), /storage_policy_denied/);
    });
    await t.test("preexisting account-wide and root-lineage denies remain byte-for-byte after transition", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      await admin.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)", [user, client.lineage, target.receipt]);
      await admin.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,lineage_id,receipt_id) values($1,'google-drive','synthetic-transition-subject',$2,$3,$4)", [user, target.rootId, client.lineage, target.receipt]);
      const item = await manifest(target), before = await effects(), result = await rpc(transition(item)); assert.equal(result.status, "committed", JSON.stringify(result));
      assert.deepEqual((await effects()).denies, before.denies); assert.deepEqual((await effects()).root_denies, before.root_denies);
      await assert.rejects(evaluate(target, client), /storage_policy_denied/);
    });
    await t.test("an exact queued job requires explicit receipt-backed cancellation and its old identity cannot be revived", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      const job = await queued(target, client), item = await manifest(target);
      await rejected(() => rpc(transition(item)), /storage_transition_not_quiet/);
      const request = cancel(item, job);
      for (const extra of [{ job_id: randomUUID() }, { request_digest: hash("wrong original request") }, { submit_receipt_id: randomUUID() }]) {
        await rejected(() => rpc({ ...request, ...extra }), /storage_transition_conflict|storage_transition_denied/);
      }
      const result = await rpc(request); assert.equal(result.status, "committed", JSON.stringify(result));
      const saved = (await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, job.job_id])).rows[0];
      assert.equal(saved.intent_id, null); assert.deepEqual(saved.dispatch_outcome, { status: "denied" });
      for (const key of ["request_digest", "receipt_id", "grant_receipt_id", "authorization_version", "mutation"]) assert.deepEqual(saved[key], job[key], key);
      assert.equal((await rpc(request)).receipt_id, result.receipt_id);
      assert.equal((await rpc(transition(item))).status, "committed");
      const final = (await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, job.job_id])).rows[0];
      assert.deepEqual(final, saved);
      await historicalReplay(request, result);
    });
    await t.test("quiet includes queued jobs and prepared, started or uncertain intents on historical profiles for the same provider root", async () => {
      for (const state of ["queued", "prepared", "started", "uncertain"]) {
        const old = await root(), client = await binding(old); await grant(old, client);
        const job = await queued(old, client);
        await register({ action: "profile_revoke", profile_id: old.profile, base_version: 1 });
        // Qualification itself correctly refuses an unresolved journal, so
        // establish the successor first and then model the historical intent.
        const target = await root({ rootId: old.rootId }); target.history.push(...old.history);
        if (state !== "queued") {
          // Seed only the historical journal shape being inspected. No trusted
          // writer API/provider effect is invoked or granted by this fixture.
          const intent = (await admin.query(`insert into clued_private.resource_center_mutations_v1(user_id,profile_id,request_key,request_sha256,
            exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
            values($1,$2,$3,$4,'{}','{}','{}',$4,1,$5,$6,clock_timestamp()+interval '1 hour',$7) returning id`,
            [user, old.profile, `transition-${randomUUID()}`, hash(randomUUID()), decision, state, old.receipt])).rows[0].id;
          await admin.query("update clued_private.storage_jobs_v1 set intent_id=$3 where owner_id=$1 and job_id=$2", [user, job.job_id, intent]);
        }
        const item = await manifest(target);
        await rejected(() => rpc(transition(item)), state === "queued" ? /storage_transition_not_quiet/ : /storage_root_has_unresolved_mutation/);
        if (state === "queued") {
          const result = await rpc(cancel(item, job)); assert.equal(result.status, "committed", JSON.stringify(result));
          assert.equal((await rpc(transition(item))).status, "committed");
        } else await rejected(() => rpc(cancel(item, job)), /storage_transition_not_quiet|storage_transition_conflict/);
      }
    });
    await t.test("queued cancellation takes job then root and rolls back if a concurrent start has already attached its original intent", async () => {
      const target = await root(), client = await binding(target); await grant(target, client);
      const job = await queued(target, client), item = await manifest(target), input = cancel(item, job);
      await operator.query("begin"); let pending;
      try {
        await operator.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`storage-job:${user}:${job.job_id}`]);
        await operator.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${user}:${target.rootId}`]);
        const intent = (await operator.query(`insert into clued_private.resource_center_mutations_v1(user_id,profile_id,request_key,request_sha256,
          exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
          values($1,$2,$3,$4,'{}','{}','{}',$4,1,$5,'started',clock_timestamp()+interval '1 hour',$6) returning id`,
          [user, target.profile, `transition-${randomUUID()}`, hash(randomUUID()), decision, target.receipt])).rows[0].id;
        await operator.query("update clued_private.storage_jobs_v1 set intent_id=$3 where owner_id=$1 and job_id=$2", [user, job.job_id, intent]);
        pending = rpc(input, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const result = await pending; assert.ok(result.error); assert.match(result.error.message, /storage_transition_conflict|storage_transition_not_quiet/);
        const stored = (await admin.query("select intent_id,dispatch_outcome from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, job.job_id])).rows[0];
        assert.equal(stored.intent_id, intent); assert.equal(stored.dispatch_outcome, null);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("connection revocation winning the root lock blocks waiting cutover, while cutover winning closes the old revoke path", async () => {
      for (const transitionWins of [false, true]) {
        const target = await root(), client = await binding(target); await grant(target, client);
        const item = await manifest(target), input = transition(item);
        const connection = (await admin.query("select version from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0];
        const revoke = { action: "revoke_connection", connection_id: target.connection, base_version: Number(connection.version), idempotency_key: randomUUID() };
        await operator.query("begin"); await operator.query("set local role authenticated"); await login(operator); let pending;
        try {
          const first = transitionWins ? await rpc(input, operator) : await account(revoke, operator);
          assert.equal(first.status, "committed", JSON.stringify(first));
          pending = (transitionWins ? account(revoke, contender) : rpc(input, contender)).then(value => ({ value }), error => ({ error }));
          await waitForLock(contender); await operator.query("commit");
          const second = await pending; assert.ok(second.error);
          assert.match(second.error.message, transitionWins ? /storage_legacy_mode_denied/ : /storage_transition_conflict|storage_transition_denied/);
          const stored = (await admin.query("select state,auth_mode,account_policy_id from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0];
          if (transitionWins) { assert.equal(stored.auth_mode, "account_policy"); assert.ok(stored.account_policy_id); }
          else { assert.equal(stored.state, "revoked"); assert.equal(stored.account_policy_id, null); }
        } finally { await operator.query("rollback"); if (pending) await pending; }
      }
    });
    await t.test("global deny insertion serializes with cutover's lineage guard and cannot be lost on either side", async () => {
      for (const transitionWins of [false, true]) {
        const target = await root(), client = await binding(target); await grant(target, client);
        const item = await manifest(target), input = transition(item);
        const deny = async database => {
          await database.query("select clued_private.storage_client_guard_v2($1,$2,true)", [user, client.lineage]);
          await database.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)", [user, client.lineage, target.receipt]);
        };
        await operator.query("begin"); let pending;
        try {
          if (transitionWins) {
            await operator.query("set local role authenticated"); await login(operator);
            assert.equal((await rpc(input, operator)).status, "committed");
            const stop = await connect();
            pending = (async () => { await stop.query("begin"); try { await deny(stop); await stop.query("commit"); return { value: true }; }
              catch (error) { await stop.query("rollback"); return { error }; } })();
            await waitForLock(stop);
          } else {
            await deny(operator);
            pending = rpc(input, contender).then(value => ({ value }), error => ({ error }));
            await waitForLock(contender);
          }
          await operator.query("commit"); const second = await pending;
          if (transitionWins) assert.equal(second.error, undefined);
          else { assert.ok(second.error); assert.match(second.error.message, /storage_transition_conflict/); }
          assert.equal((await admin.query("select denied from clued_private.storage_client_denies_v2 where owner_id=$1 and lineage_id=$2", [user, client.lineage])).rows[0].denied, true);
          await assert.rejects(evaluate(target, client), /storage_policy_denied/);
        } finally { await operator.query("rollback"); if (pending) await pending; }
      }
    });
    await t.test("native-session and manifest expiry while waiting at the root roll back cutover and both receipts", async () => {
      for (const boundary of ["native-session", "manifest"]) {
        const target = await root(), client = await binding(target); await grant(target, client);
        const item = await manifest(target, boundary === "manifest" ? { expires_at: new Date(Date.now() + 1200).toISOString() } : {});
        if (boundary === "native-session") await admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1", [sessionId]);
        const before = await effects(), input = transition(item);
        await operator.query("begin"); let pending;
        try {
          await operator.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${user}:${target.rootId}`]);
          pending = rpc(input, contender).then(value => ({ value }), error => ({ error }));
          await waitForLock(contender); await new Promise(resolve => setTimeout(resolve, 1300)); await operator.query("commit");
          const outcome = await pending; assert.ok(outcome.error);
          assert.match(outcome.error.message, /storage_native_session_required|storage_transition_conflict|storage_transition_denied/);
          assert.deepEqual(await effects(), before);
          assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where user_id=$1 and idempotency_key=$2 and status='committed'", [user, input.idempotency_key])).rows[0].n, 0);
        } finally {
          await operator.query("rollback"); if (pending) await pending;
          await admin.query("update auth.sessions set not_after=null where id=$1", [sessionId]);
        }
      }
    });
    await t.test("failure finishing either policy or transition receipt rolls back all mode, deny and policy effects", async () => {
      for (const failAt of [1, 2]) {
        const target = await root(), client = await binding(target); await grant(target, client, ["inspect"]);
        const item = await manifest(target), input = transition(item), before = await effects();
        await admin.query("begin");
        try {
          await admin.query("create temporary table transition_fixture_counter(n integer)");
          await admin.query("insert into transition_fixture_counter values(0)");
          await admin.query(`create function pg_temp.transition_fixture_fail() returns trigger language plpgsql security definer set search_path='' as $$ begin
            if new.status='committed' then update pg_temp.transition_fixture_counter set n=n+1;
              if (select n from pg_temp.transition_fixture_counter)>=${failAt} then raise exception 'transition_fixture_failure'; end if;
            end if; return new; end $$`);
          await admin.query("create trigger transition_fixture_fail before update on public.clued_audit_receipts for each row execute function pg_temp.transition_fixture_fail()");
          await admin.query("set local role authenticated"); await login(admin);
          await assert.rejects(rpc(input, admin), /storage_transition_denied|transition_fixture_failure/);
        } finally { await admin.query("rollback"); }
        assert.deepEqual(await effects(), before);
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_policy_transition_results_v2 where manifest_id=$1", [item.id])).rows[0].n, 0);
      }
    });
  } finally {
    await admin.query("rollback");
    for (const client of clients) { await client.query("rollback").catch(() => {}); await client.end(); }
  }
}
