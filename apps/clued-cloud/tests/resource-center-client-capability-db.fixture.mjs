import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const API = "clued_private.storage_client_capability_admin_v2";

// Run only in resource-center-authority-db.test.mjs's disposable PostgreSQL.
// The platform administrator and all source/evidence objects are synthetic;
// this fixture is not a deployment, bootstrap or production-registration path.
export async function testStorageClientCapability(t, admin, server, user, decision) {
  const actor = randomUUID(), actorSession = randomUUID(), ownerSession = randomUUID();
  const issuer = hash(randomUUID()), resource = "https://capability-fixture.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const clients = [];
  const connect = async role => {
    const client = server.getPgClient(); clients.push(client); await client.connect();
    await client.query("set statement_timeout='10s'");
    if (role) await client.query(`set role ${role}`);
    return client;
  };
  const native = await connect("authenticated"), operator = await connect();
  const session = async (client, subject, id) => client.query(
    "select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [subject, JSON.stringify({ sub: subject, role: "authenticated", session_id: id, aal: "aal1",
      amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }] })]);
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'capability-platform@example.invalid',now())", [actor]);
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2),($3,$4)", [actorSession, actor, ownerSession, user]);
  await session(native, user, ownerSession);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'client-capability-fixture')", [issuer, resource]);
  const call = async (input, client = admin) => (await client.query(`select ${API}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const common = proof => ({ idempotency_key: randomUUID(), platform_admin_version: 1,
    evidence_id: proof.id, evidence_sha256: proof.digest });
  const evidence = async (text, { owner = actor, mime = "application/json", type = "test_output" } = {}) => {
    const input = { idempotency_key: randomUUID(), evidence_schema_version: 1, evidence_type: type,
      storage_ref: `isolated-capability:${randomUUID()}`, content_hash: hash(text), mime_type: mime,
      size_bytes: Buffer.byteLength(text, "utf8") };
    const result = (await admin.query("select clued_private.evidence_ingest_core($1,null,$2::jsonb,clued_private.m1_sha256($2::jsonb)) value",
      [owner, JSON.stringify(input)])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result));
    return { id: result.evidence_ids[0], digest: input.content_hash, receipt: result.receipt_id, text };
  };
  const binding = async (clientId = `fixture-client-${randomUUID()}`, overrides = {}, requestIssuer = issuer) => {
    const token = hash(randomUUID());
    const request = { request_digest: hash(randomUUID()), client_id: clientId, client_name: "隔离测试应用",
      redirect_uri: "https://capability-fixture.invalid/callback", resource, requested_scopes: ["context:write"], ...overrides };
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value",
      [requestIssuer, JSON.stringify(request)])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value",
      [requestIssuer, prepared.request_id, prepared.version,
        JSON.stringify([{ resource_kind: "scope", resource_id: `project:${project}`, environment: "canonical",
          actions: request.requested_scopes.includes("context:write") ? ["write", "close"] : ["read"] }]),
        token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    const metadataDigest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    return { request: prepared.request_id, binding: approved.binding_id, clientId, token,
      digest: request.request_digest, metadataDigest, fields: request };
  };
  const source = (b, client = {}) => ({ contract: "clued.storage-client-source-snapshot/1", source: "cloudflare-oauth-provider",
    request_id: b.request, request_digest: b.digest, resource: b.fields.resource,
    observed_at: new Date().toISOString(), release_sha: "a".repeat(40), client: {
      clientId: b.clientId, clientName: b.fields.client_name, redirectUris: [b.fields.redirect_uri],
      grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"], tokenEndpointAuthMethod: "none",
      registrationDate: 1790568000, ...client } });
  const registrationInput = async (b, { document = source(b), proof, previous = null, text } = {}) => {
    const raw = text ?? JSON.stringify(document, null, 2) + "\n";
    const captured = proof ?? await evidence(raw);
    return { action: "register_snapshot", ...common(captured), request_id: b.request, expected_request_digest: b.digest,
      source_snapshot_json: raw, expected_lineage_id: previous?.lineage_id ?? null,
      expected_registration_generation: Number(previous?.generation ?? 0) };
  };
  const row = async (lineage, generation) => (await admin.query(
    "select * from clued_private.storage_client_registrations_v2 where lineage_id=$1 and generation=$2", [lineage, generation])).rows[0];
  const registered = async (b, options = {}) => {
    const input = await registrationInput(b, options), result = await call(input);
    assert.equal(result.status, "committed", JSON.stringify(result));
    const lineage = result.target_refs.find(ref => ref.role === "primary").id;
    return { input, result, binding: b, ...(await row(lineage, result.committed_versions[lineage])) };
  };
  const qualificationInput = async (registration, version = 0) => ({ action: "qualify", ...common(await evidence(JSON.stringify({
    contract: "isolated-client-qualification/1", lineage_id: registration.lineage_id, protocol: "clued.storage-agent/1", result: "PASS" }))),
    lineage_id: registration.lineage_id, registration_generation: Number(registration.generation),
    expected_metadata_digest: registration.metadata_digest, expected_source_digest: registration.source_metadata_digest,
    expected_capability_version: version });
  const qualified = async (registration, version = 0) => {
    const input = await qualificationInput(registration, version), result = await call(input);
    assert.equal(result.status, "committed", JSON.stringify(result));
    const id = result.target_refs.find(ref => ref.role === "primary").id;
    const capability = (await admin.query("select * from clued_private.storage_client_capabilities_v2 where id=$1", [id])).rows[0];
    return { ...registration, capability, qualifyInput: input, qualifyResult: result };
  };
  const linkInput = async (registration, b, { document = source(b), text } = {}) => {
    const raw = text ?? JSON.stringify(document, null, 2) + "\n";
    return { action: "link_request", ...common(await evidence(raw)), request_id: b.request, expected_request_digest: b.digest,
      lineage_id: registration.lineage_id, registration_generation: Number(registration.generation),
      capability_id: registration.capability.id, capability_version: Number(registration.capability.version), source_snapshot_json: raw };
  };
  const revokeInput = async capability => ({ action: "revoke", ...common(await evidence(JSON.stringify({
    contract: "isolated-client-revocation/1", capability_id: capability.id, reason: "fixture stop" }))),
    capability_id: capability.id, base_version: Number(capability.version) });
  const issueWithdrawal = async (id, client = native) => {
    await session(client, actor, actorSession);
    const issued = (await client.query("select public.clued_evidence_withdrawal_confirmation_issue_v1($1::jsonb) value",
      [JSON.stringify({ evidence_id: id, base_version: 0, reason: "Isolated qualification source withdrawal" })])).rows[0].value;
    assert.equal(issued.status, "issued", JSON.stringify(issued));
    if (client === native) await session(native, user, ownerSession);
    return issued;
  };
  const completeWithdrawal = async (id, issued, client = native) => {
    await session(client, actor, actorSession);
    const input = { idempotency_key: randomUUID(), evidence_id: id, base_version: 0,
      confirmation_token: issued.confirmation_token, view_digest: issued.view_digest };
    const result = (await client.query("select public.clued_evidence_withdraw_v1($1::jsonb,$2) value",
      [JSON.stringify(input), hash(JSON.stringify(input))])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result));
    if (client === native) await session(native, user, ownerSession);
    return result;
  };
  const withdraw = async (id, client = native) => completeWithdrawal(id, await issueWithdrawal(id, client), client);
  const business = async () => (await admin.query(`select jsonb_build_object(
    'registrations',(select coalesce(jsonb_agg(to_jsonb(x) order by lineage_id,generation),'[]') from clued_private.storage_client_registrations_v2 x),
    'capabilities',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from clued_private.storage_client_capabilities_v2 x),
    'links',(select coalesce(jsonb_agg(to_jsonb(x) order by request_id),'[]') from clued_private.storage_client_request_links_v2 x),
    'policies',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from clued_private.storage_account_policies_v2 x),
    'denies',(select coalesce(jsonb_agg(to_jsonb(x) order by owner_id,lineage_id),'[]') from clued_private.storage_client_denies_v2 x),
    'root_denies',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from clued_private.storage_root_denies_v2 x),
    'jobs',(select count(*) from clued_private.storage_jobs_v1),
    'intents',(select count(*) from clued_private.resource_center_mutations_v1),
    'grants',(select count(*) from clued_private.storage_client_grants_v1)) value`)).rows[0].value;
  const reject = async (input, expression = /./, client = admin) => {
    const before = await business();
    let result;
    try { result = await call(input, client); } catch (error) {
      assert.match(error.message, expression); assert.deepEqual(await business(), before); return;
    }
    assert.ok(["rejected", "failed"].includes(result?.status), JSON.stringify(result));
    assert.match(result.error_code ?? "", expression); assert.deepEqual(await business(), before);
    assert.deepEqual(result.event_ids ?? [], []); return result;
  };
  const receiptCount = async key => (await admin.query(
    "select count(*)::int n from public.clued_audit_receipts where user_id=$1 and idempotency_key=$2 and status='committed'", [actor, key])).rows[0].n;
  const verifyReceipt = async (result, evidenceId) => {
    assert.equal(result.status, "committed"); assert.equal(result.event_ids.length, 1);
    const receipt = (await admin.query("select * from public.clued_audit_receipts where id=$1", [result.receipt_id])).rows[0];
    assert.equal(receipt.user_id, actor); assert.equal(receipt.binding_id, null); assert.equal(receipt.status, "committed");
    assert.ok(receipt.evidence_ids.includes(evidenceId));
    const event = (await admin.query("select * from public.clued_context_events where receipt_id=$1", [result.receipt_id])).rows;
    assert.equal(event.length, 1); assert.equal(event[0].user_id, actor);
    assert.ok(!JSON.stringify(result).includes("source_snapshot_json"));
  };
  const waitForLock = async client => {
    const pid = client._capabilityFixturePid ?? (await client.query("select pg_backend_pid() pid")).rows[0].pid;
    for (let n = 0; n < 200; n++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting", [pid])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("capability fixture did not reach its expected lock wait");
  };
  const contender = await connect();
  contender._capabilityFixturePid = (await contender.query("select pg_backend_pid() pid")).rows[0].pid;
  try {
    await t.test("capability administration is invoker-only, private and denied to native, Agent, service-role and Google issuer callers", async () => {
      const acl = (await admin.query(`select p.prosecdef,p.proconfig,
        has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') service,
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public
        from pg_proc p where p.oid=$1::regprocedure`, [`${API}(jsonb)`])).rows[0];
      assert.equal(acl.prosecdef, false); assert.equal(acl.anon, false); assert.equal(acl.authenticated, false);
      assert.equal(acl.service, false); assert.equal(acl.public, false);
      assert.ok(acl.proconfig?.some(value => /^search_path=(""|)$/.test(value)));
      assert.equal((await admin.query("select to_regprocedure('public.storage_client_capability_admin_v2(jsonb)') value")).rows[0].value, null);
      for (const role of ["anon", "authenticated", "service_role"]) {
        const client = await connect(role); await session(client, actor, actorSession);
        await reject({ action: "qualify", actor_id: actor, issuer_hash: issuer, platform_admin_version: 1 }, /permission denied/, client);
      }
      // Isolated misconfiguration regression: even an accidental EXECUTE grant
      // must not let a service-role connection impersonate the SQL owner.
      await admin.query("begin");
      try {
        await admin.query(`grant usage on schema clued_private to service_role; grant execute on function ${API}(jsonb) to service_role; set local role service_role`);
        await assert.rejects(call({ action: "qualify" }), /offline_database_operator_required/);
      } finally { await admin.query("rollback"); }
    });
    const original = await binding(), firstInput = await registrationInput(original);
    await t.test("missing platform designation fails closed without bootstrapping it", async () => {
      assert.equal((await admin.query("select count(*)::int n from clued_private.platform_admin_v13")).rows[0].n, 0);
      await reject(firstInput, /platform_admin/);
      assert.equal((await admin.query("select count(*)::int n from clued_private.platform_admin_v13")).rows[0].n, 0);
    });
    await admin.query("insert into clued_private.platform_admin_v13(subject_id,version) values($1,1)", [actor]);
    let registration, capability;
    await t.test("reviewed raw UTF-8 source registers exact server request identity with one qualification receipt", async () => {
      const result = await call(firstInput); assert.equal(result.status, "committed", JSON.stringify(result));
      const lineage = result.target_refs.find(ref => ref.role === "primary").id;
      registration = { binding: original, input: firstInput, result, ...(await row(lineage, 1)) };
      assert.equal(registration.client_id, original.clientId); assert.equal(registration.issuer_hash, issuer);
      assert.equal(registration.resource, resource); assert.equal(registration.metadata_digest, original.metadataDigest);
      assert.equal(registration.source_request_id, original.request);
      assert.equal(registration.source_snapshot_sha256, hash(firstInput.source_snapshot_json));
      assert.equal(registration.source_evidence_id, firstInput.evidence_id);
      const digest = (await admin.query("select clued_private.m1_sha256($1::jsonb) value", [JSON.stringify(JSON.parse(firstInput.source_snapshot_json).client)])).rows[0].value;
      assert.equal(registration.source_metadata_digest, digest);
      await verifyReceipt(result, firstInput.evidence_id);
    });
    await t.test("registration replay is exact, changed payload conflicts, and admin CAS is checked before replay", async () => {
      const before = await business(), replay = await call(firstInput);
      assert.equal(replay.receipt_id, registration.result.receipt_id);
      assert.deepEqual(await business(), before); assert.equal(await receiptCount(firstInput.idempotency_key), 1);
      await reject({ ...firstInput, expected_registration_generation: 1 }, /IDEMPOTENCY|idempotency/);
      await admin.query("begin");
      try {
        await admin.query("update clued_private.platform_admin_v13 set version=2 where singleton");
        await assert.rejects(call(firstInput), /platform_admin/);
      } finally { await admin.query("rollback"); }
    });
    await t.test("malformed or stale source and nonmatching Evidence cannot create registration authority", async () => {
      for (const change of [
        d => ({ ...d, client: { ...d.client, clientSecret: "synthetic-do-not-persist" } }),
        d => ({ ...d, client: { ...d.client, clientId: "another-client" } }),
        d => ({ ...d, client: { ...d.client, redirectUris: ["https://foreign.invalid/callback"] } }),
        d => ({ ...d, request_id: randomUUID() }), d => ({ ...d, request_digest: hash("wrong-request") }),
        d => ({ ...d, resource: "https://foreign.invalid/mcp" }),
        d => ({ ...d, observed_at: new Date(Date.now() - 31 * 60000).toISOString() }),
        d => ({ ...d, observed_at: new Date(Date.now() + 120000).toISOString() }),
        d => ({ ...d, caller_manifest: { qualified: true } }),
      ]) {
        const b = await binding(); await reject(await registrationInput(b, { document: change(source(b)) }));
      }
      const b = await binding(), valid = await registrationInput(b);
      await reject({ ...valid, evidence_sha256: hash("wrong-evidence") });
      await reject({ ...valid, source_snapshot_json: valid.source_snapshot_json.trimEnd() });
      for (const options of [{ owner: user }, { mime: "text/plain" }, { type: "web_ref" }]) {
        const proof = await evidence(valid.source_snapshot_json, options);
        await reject({ ...valid, ...common(proof) });
      }
      for (const extra of [{ owner_id: user }, { actions: ["delete"] }, { issuer_hash: issuer }, { client_name: "trusted" }]) {
        await reject({ ...valid, idempotency_key: randomUUID(), ...extra });
      }
      for (const change of [{ platform_admin_version: "1" }, { expected_registration_generation: "0" },
        { request_id: 123 }, { expected_request_digest: null }, { expected_lineage_id: 1 }]) {
        await reject({ ...valid, idempotency_key: randomUUID(), ...change });
      }
      const duplicate = valid.source_snapshot_json.replace('"source": "cloudflare-oauth-provider",',
        '"source": "cloudflare-oauth-provider", "source": "cloudflare-oauth-provider",');
      await reject(await registrationInput(b, { text: duplicate }));
    });
    const legacyProfile = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user, JSON.stringify({
      action: "profile_register", project_id: project, source_decision_id: decision, idempotency_key: randomUUID(),
      profile_version: `capability-fixture/${randomUUID()}`, managed_root: `/capability-${randomUUID()}/Clued_资料中心`,
      root_folder_id: `capability-root-${randomUUID()}`, root_parent_id: "capability-parent", root_folder_version: "1" })])).rows[0].value;
    assert.equal(legacyProfile.status, "committed", JSON.stringify(legacyProfile));
    const legacy = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
      action: "register", profile_id: legacyProfile.target_refs.find(ref => ref.role === "primary").id,
      source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(legacy.status, "committed", JSON.stringify(legacy));
    const legacyConnection = legacy.target_refs.find(ref => ref.role === "primary").id;
    // Structural activation only inside the disposable DB. No provider token
    // exists, and this synthetic envelope can never be sent to a provider.
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='synthetic-capability-subject'," +
      "oauth_client_id='synthetic-capability-oauth',credential_version=1,credential_envelope='{}' where id=$1", [legacyConnection]);
    await t.test("qualification has one receipt but creates no account policy, grant, job or file admission", async () => {
      const before = await business(); capability = await qualified(registration);
      const after = await business();
      for (const key of ["policies", "denies", "root_denies", "jobs", "intents", "grants"]) assert.deepEqual(after[key], before[key], key);
      assert.equal(after.capabilities.length, before.capabilities.length + 1);
      await verifyReceipt(capability.qualifyResult, capability.qualifyInput.evidence_id);
      const linked = await call(await linkInput(capability, original)); assert.equal(linked.status, "committed");
      await assert.rejects(admin.query("select clued_private.storage_policy_evaluate_v2($1,$2,'create_file',$3)",
        [original.token, legacyConnection, randomUUID()]), /storage_policy_denied/);
      const connection = (await admin.query("select auth_mode,account_policy_id from clued_private.storage_connections_v1 where id=$1", [legacyConnection])).rows[0];
      assert.deepEqual(connection, { auth_mode: "legacy", account_policy_id: null });
      assert.equal((await call(capability.qualifyInput)).receipt_id, capability.qualifyResult.receipt_id);
      assert.equal(await receiptCount(capability.qualifyInput.idempotency_key), 1);
    });
    await t.test("withdrawn review Evidence and withdrawn original source cannot grant qualification", async () => {
      const input = await registrationInput(await binding()); await withdraw(input.evidence_id);
      await reject(input, /review_required/);
      const sourceRegistration = await registered(await binding()); await withdraw(sourceRegistration.source_evidence_id);
      await reject(await qualificationInput(sourceRegistration), /qualification_conflict/);
      const sourceQualified = await qualified(await registered(await binding()));
      await withdraw(sourceQualified.source_evidence_id);
      await reject(await linkInput(sourceQualified, await binding(sourceQualified.binding.clientId)), /qualification_conflict|source_mismatch/);
      const current = await registered(await binding()), proof = await qualificationInput(current);
      await withdraw(proof.evidence_id); await reject(proof, /review_required/);
    });
    await t.test("source withdrawal blocks future qualification use while explicit capability revoke ends existing account-policy access", async () => {
      const profileId = legacyProfile.target_refs.find(ref => ref.role === "primary").id;
      const profile = (await admin.query("select managed_root,version from clued_private.resource_center_profiles_v1 where id=$1", [profileId])).rows[0];
      const artifact = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user, JSON.stringify({
        action: "artifact_register", profile_id: profileId, path: profile.managed_root + "/20_P_产品与体验",
        provider_file_id: `capability-track-${randomUUID()}`, provider_file_version: "1", target_kind: "directory",
        governance_class: "ordinary", delete_authority: false, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(artifact.status, "committed", JSON.stringify(artifact));
      const runtime = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
        profile_id: profileId, base_version: Number(profile.version), allowed_root_children: ["20_P_产品与体验"],
        source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(runtime.status, "committed", JSON.stringify(runtime));
      const policy = randomUUID();
      // No activation API exists in this layer. This reviewed-policy seed is
      // confined to the disposable DB and reuses the existing synthetic root.
      await admin.query("begin");
      try {
        await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
          scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
          select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
            c.source_decision_id,c.decision_version,'reviewed_transition','capability-fixture/1',c.receipt_id
          from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, legacyConnection]);
        await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, legacy.receipt_id]);
        await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [legacyConnection, policy]);
        await admin.query("commit");
      } catch (error) { await admin.query("rollback"); throw error; }
      const existing = await qualified(await registered(await binding()));
      assert.equal((await call(await linkInput(existing, existing.binding))).status, "committed");
      const evaluate = async () => (await admin.query("select clued_private.storage_policy_evaluate_v2($1,$2,'inspect',$3) value",
        [existing.binding.token, legacyConnection, randomUUID()])).rows[0].value;
      const before = await evaluate();
      await withdraw(existing.source_evidence_id);
      assert.deepEqual(await evaluate(), before);
      await reject(await linkInput(existing, await binding(existing.binding.clientId)), /^storage_client_source_mismatch$/);
      assert.equal((await call(await revokeInput(existing.capability))).status, "committed");
      await assert.rejects(evaluate(), /storage_policy_denied/);
    });
    await t.test("only an exact reviewed request link qualifies new Bindings; client ID reuse is not inheritance", async () => {
      const next = await binding(original.clientId);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_request_links_v2 where request_id=$1", [next.request])).rows[0].n, 0);
      const document = source(next);
      // Same semantic source with a different object order and raw bytes. The
      // raw Evidence hash changes; the approved client metadata digest does not.
      const raw = JSON.stringify(Object.fromEntries(Object.entries(document).reverse())) + "\n";
      const input = await linkInput(capability, next, { text: raw }), result = await call(input);
      assert.equal(result.status, "committed", JSON.stringify(result)); await verifyReceipt(result, input.evidence_id);
      const stored = (await admin.query("select * from clued_private.storage_client_request_links_v2 where request_id=$1", [next.request])).rows[0];
      assert.equal(stored.lineage_id, registration.lineage_id); assert.equal(stored.source_snapshot_sha256, hash(raw));
      assert.equal(stored.source_metadata_digest, registration.source_metadata_digest);
      const before = await business(); assert.equal((await call(input)).receipt_id, result.receipt_id); assert.deepEqual(await business(), before);
      const replaced = await binding(original.clientId);
      await reject(await linkInput(capability, replaced, { document: source(replaced, { registrationDate: 1790568001 }) }));
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_request_links_v2 where request_id=$1", [replaced.request])).rows[0].n, 0);
    });
    await t.test("request-link rejects each request metadata, lineage, generation and capability mismatch", async () => {
      const next = await binding(original.clientId), valid = await linkInput(capability, next);
      for (const change of [{ request_id: randomUUID() }, { expected_request_digest: hash("wrong") }, { lineage_id: randomUUID() },
        { registration_generation: 2 }, { capability_id: randomUUID() }, { capability_version: 9 }]) {
        await reject({ ...valid, ...change, idempotency_key: randomUUID() });
      }
      for (const override of [{ client_name: "renamed client" }, { redirect_uri: "https://capability-fixture.invalid/other" },
        { requested_scopes: ["context:read"] }]) {
        const changed = await binding(original.clientId, override); await reject(await linkInput(capability, changed));
      }
      const other = await binding(); await reject(await linkInput(capability, other));
      for (const otherResource of [resource, "https://different-resource.invalid/mcp"]) {
        const otherIssuer = hash(randomUUID());
        await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'other-capability-issuer')", [otherIssuer, otherResource]);
        const mismatch = await binding(original.clientId, { resource: otherResource }, otherIssuer);
        await reject(await linkInput(capability, mismatch));
      }
      await reject({ ...valid, idempotency_key: randomUUID(), source_snapshot_json: JSON.stringify(source(next, { tokenEndpointAuthMethod: "client_secret_post" })) });
    });
    await t.test("stale capability CAS rejects and two concurrent qualifications cannot both win", async () => {
      await reject(await qualificationInput(registration, 0), /version|conflict|active/);
      const fresh = await registered(await binding()), first = await qualificationInput(fresh), second = await qualificationInput(fresh);
      await operator.query("begin");
      let pending;
      try {
        const committed = await call(first, operator); assert.equal(committed.status, "committed");
        pending = call(second, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const outcome = await pending;
        if (outcome.error) assert.match(outcome.error.message, /version|conflict|active/);
        else assert.ok(["rejected", "failed"].includes(outcome.value.status), JSON.stringify(outcome.value));
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_capabilities_v2 where lineage_id=$1 and state='active'", [fresh.lineage_id])).rows[0].n, 1);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("simultaneous same-key registration replays one committed receipt", async () => {
      const input = await registrationInput(await binding()); await operator.query("begin");
      let pending;
      try {
        const first = await call(input, operator); assert.equal(first.status, "committed");
        pending = call(input, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const second = await pending; assert.equal(second.error, undefined); assert.equal(second.value.receipt_id, first.receipt_id);
        assert.equal(await receiptCount(input.idempotency_key), 1);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("different idempotency keys cannot concurrently register two lineages for the same exact source request", async () => {
      const input = await registrationInput(await binding()), other = { ...input, idempotency_key: randomUUID() };
      await operator.query("begin"); let pending;
      try {
        const first = await call(input, operator); assert.equal(first.status, "committed");
        pending = call(other, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const second = await pending;
        if (second.error) assert.match(second.error.message, /^storage_client_qualification_conflict$/);
        else assert.ok(["rejected", "failed"].includes(second.value.status), JSON.stringify(second.value));
        const rows = (await admin.query("select lineage_id,generation from clued_private.storage_client_registrations_v2 where source_request_id=$1", [input.request_id])).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].lineage_id, first.target_refs.find(ref => ref.role === "primary").id);
        assert.equal(await receiptCount(input.idempotency_key) + await receiptCount(other.idempotency_key), 1);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("new requests for the same client identity cannot race into separate lineages or bypass an existing deny", async () => {
      const firstBinding = await binding(), secondBinding = await binding(firstBinding.clientId);
      const firstInput = await registrationInput(firstBinding), secondInput = await registrationInput(secondBinding);
      await operator.query("begin"); let pending, first;
      try {
        first = await call(firstInput, operator); assert.equal(first.status, "committed");
        pending = call(secondInput, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const second = await pending;
        if (second.error) assert.match(second.error.message, /^storage_client_qualification_conflict$/);
        else assert.ok(["rejected", "failed"].includes(second.value.status), JSON.stringify(second.value));
        const rows = (await admin.query("select distinct lineage_id from clued_private.storage_client_registrations_v2 where issuer_hash=$1 and resource=$2 and client_id=$3",
          [issuer, resource, firstBinding.clientId])).rows;
        assert.equal(rows.length, 1); assert.equal(rows[0].lineage_id, first.target_refs.find(ref => ref.role === "primary").id);
        assert.equal(await receiptCount(firstInput.idempotency_key) + await receiptCount(secondInput.idempotency_key), 1);
      } finally { await operator.query("rollback"); if (pending) await pending; }
      const lineage = first.target_refs.find(ref => ref.role === "primary").id;
      await admin.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)", [user, lineage, first.receipt_id]);
      const input = await registrationInput(await binding(firstBinding.clientId));
      await reject(input, /^storage_client_qualification_conflict$/);
      const rows = (await admin.query("select distinct lineage_id from clued_private.storage_client_registrations_v2 where issuer_hash=$1 and resource=$2 and client_id=$3",
        [issuer, resource, firstBinding.clientId])).rows;
      assert.deepEqual(rows, [{ lineage_id: lineage }]);
      assert.equal((await admin.query("select denied from clued_private.storage_client_denies_v2 where owner_id=$1 and lineage_id=$2", [user, lineage])).rows[0].denied, true);
      assert.equal(await receiptCount(input.idempotency_key), 0);
    });
    await t.test("registration successors cannot change issuer, resource or client identity or recycle an exact source request", async () => {
      const existing = await registered(await binding());
      await reject(await registrationInput(existing.binding, { previous: existing }), /^storage_client_qualification_conflict$/);
      await reject(await registrationInput(await binding(), { previous: existing }), /^storage_client_qualification_conflict$/);
      for (const otherResource of [resource, "https://registration-resource.invalid/mcp"]) {
        const otherIssuer = hash(randomUUID());
        await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'successor-mismatch-fixture')", [otherIssuer, otherResource]);
        const other = await binding(existing.binding.clientId, { resource: otherResource }, otherIssuer);
        await reject(await registrationInput(other, { previous: existing }), /^storage_client_qualification_conflict$/);
      }
    });
    await t.test("revocation is immutable and replay cannot reactivate old capabilities or erase storage denies", async () => {
      const stopped = await qualified(await registered(await binding()));
      const input = await revokeInput(stopped.capability), result = await call(input);
      assert.equal(result.status, "committed", JSON.stringify(result)); await verifyReceipt(result, input.evidence_id);
      assert.equal((await call(input)).receipt_id, result.receipt_id);
      const revoked = (await admin.query("select * from clued_private.storage_client_capabilities_v2 where id=$1", [stopped.capability.id])).rows[0];
      assert.equal(revoked.state, "revoked"); assert.equal(Number(revoked.version), 2);
      const before = await business(); assert.equal((await call(stopped.qualifyInput)).receipt_id, stopped.qualifyResult.receipt_id);
      assert.deepEqual(await business(), before);
      await assert.rejects(admin.query("update clued_private.storage_client_capabilities_v2 set state='active',revoked_at=null,version=version+1,receipt_id=$2 where id=$1",
        [revoked.id, result.receipt_id]), /storage_capability_revoked_immutable/);
      await admin.query("insert into clued_private.storage_client_denies_v2(owner_id,lineage_id,receipt_id) values($1,$2,$3)", [user, stopped.lineage_id, result.receipt_id]);
      const afterStop = await business(), successor = await qualified(stopped, 2);
      assert.notEqual(successor.capability.id, stopped.capability.id); assert.equal(Number(successor.capability.version), 3);
      assert.deepEqual((await business()).denies, afterStop.denies);
      await reject(await linkInput(stopped, await binding(stopped.binding.clientId)), /^storage_client_qualification_conflict$/);
    });
    await t.test("capability revoke wins against a waiting link without reviving or partially linking a request", async () => {
      const stopped = await qualified(await registered(await binding())), next = await binding(stopped.binding.clientId);
      const input = await linkInput(stopped, next), revoke = await revokeInput(stopped.capability);
      await operator.query("begin"); let pending;
      try {
        assert.equal((await call(revoke, operator)).status, "committed");
        pending = call(input, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const outcome = await pending;
        if (outcome.error) assert.match(outcome.error.message, /qualification_conflict/);
        else assert.ok(["rejected", "failed"].includes(outcome.value.status), JSON.stringify(outcome.value));
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_request_links_v2 where request_id=$1", [next.request])).rows[0].n, 0);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("a link that commits first remains immutable history but does not prevent subsequent capability revoke", async () => {
      const current = await qualified(await registered(await binding())), next = await binding(current.binding.clientId);
      const input = await linkInput(current, next), revoke = await revokeInput(current.capability);
      await operator.query("begin"); let pending;
      try {
        assert.equal((await call(input, operator)).status, "committed");
        pending = call(revoke, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const outcome = await pending; assert.equal(outcome.error, undefined); assert.equal(outcome.value.status, "committed");
        assert.equal((await admin.query("select state from clued_private.storage_client_capabilities_v2 where id=$1", [current.capability.id])).rows[0].state, "revoked");
        assert.equal((await call(input)).receipt_id, (await admin.query("select review_receipt_id from clued_private.storage_client_request_links_v2 where request_id=$1", [next.request])).rows[0].review_receipt_id);
        assert.equal((await admin.query("select state from clued_private.storage_client_capabilities_v2 where id=$1", [current.capability.id])).rows[0].state, "revoked");
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("registration generations do not silently reuse old qualification or overwrite immutable snapshots", async () => {
      const old = await qualified(await registered(await binding()));
      const nextBinding = await binding(old.binding.clientId);
      const input = await registrationInput(nextBinding, { previous: old, document: source(nextBinding, { registrationDate: 1790568002 }) });
      const originalRow = await row(old.lineage_id, 1);
      await reject(input, /qualification_conflict/);
      const revoked = await call(await revokeInput(old.capability)); assert.equal(revoked.status, "committed");
      const before = await business(), result = await call(input);
      assert.equal(result.status, "committed", JSON.stringify(result));
      const next = await row(old.lineage_id, 2); assert.ok(next); assert.notEqual(next.source_metadata_digest, old.source_metadata_digest);
      assert.deepEqual(await row(old.lineage_id, 1), originalRow);
      assert.deepEqual((await business()).policies, before.policies);
      await reject(await qualificationInput(old, Number(old.capability.version)), /registration|generation|version|conflict/);
      await reject(await linkInput(old, await binding(old.binding.clientId)), /registration|generation|capability|version|conflict/);
    });
    await t.test("issuer revoked while a request waits is rechecked before qualification effects", async () => {
      const input = await registrationInput(await binding());
      await operator.query("begin"); let pending;
      try {
        await operator.query("update clued_private.authorization_issuers_v12 set revoked_at=clock_timestamp() where token_hash=$1", [issuer]);
        pending = call(input, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const outcome = await pending;
        if (outcome.error) assert.match(outcome.error.message, /^storage_client_source_mismatch$/);
        else assert.ok(["rejected", "failed"].includes(outcome.value.status), JSON.stringify(outcome.value));
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_registrations_v2 where source_request_id=$1", [input.request_id])).rows[0].n, 0);
      } finally {
        await operator.query("rollback"); if (pending) await pending;
        await admin.query("update clued_private.authorization_issuers_v12 set revoked_at=null where token_hash=$1", [issuer]);
      }
    });
    await t.test("the real Evidence-withdrawal exclusive guard wins against a waiting source registration", async () => {
      const input = await registrationInput(await binding());
      const issued = await issueWithdrawal(input.evidence_id);
      await operator.query("begin"); let pending;
      try {
        await operator.query("set local role authenticated");
        await completeWithdrawal(input.evidence_id, issued, operator);
        pending = call(input, contender).then(value => ({ value }), error => ({ error }));
        await waitForLock(contender); await operator.query("commit");
        const outcome = await pending;
        if (outcome.error) assert.match(outcome.error.message, /review_required/);
        else assert.ok(["rejected", "failed"].includes(outcome.value.status), JSON.stringify(outcome.value));
        assert.equal((await admin.query("select count(*)::int n from clued_private.storage_client_registrations_v2 where source_request_id=$1", [input.request_id])).rows[0].n, 0);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("Event and final Receipt failures roll back registration effects rather than leaving partial authority", async () => {
      for (const target of ["event", "receipt"]) {
        const input = await registrationInput(await binding()), before = await business();
        await admin.query("begin");
        try {
          await admin.query(`create function pg_temp.capability_fixture_fail() returns trigger language plpgsql as $$ begin
            if ${target === "event" ? "true" : "new.status='committed'"} then raise exception 'capability_fixture_failure'; end if; return new; end $$`);
          await admin.query(target === "event"
            ? "create trigger capability_fixture_fail before insert on public.clued_context_events for each row execute function pg_temp.capability_fixture_fail()"
            : "create trigger capability_fixture_fail before update on public.clued_audit_receipts for each row execute function pg_temp.capability_fixture_fail()");
          await assert.rejects(call(input), /storage_client_admin_failed/);
        } finally { await admin.query("rollback"); }
        assert.deepEqual(await business(), before); assert.equal(await receiptCount(input.idempotency_key), 0);
      }
    });
  } finally {
    await admin.query("rollback");
    for (const client of clients) { await client.query("rollback").catch(() => {}); await client.end(); }
  }
}
