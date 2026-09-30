import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const ACTIONS = ["inspect", "create_file", "create_topic"];
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";

// Synthetic, disposable PostgreSQL only. These trusted setup facts model the
// already-tested registration/transition contracts, not a production backfill.
// All provider operations below use an in-memory fake, never Google or a disk.
export async function testAccountCloud(t, admin, server, user, decision) {
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `account-cloud-${randomUUID()}`, resource = "https://account-cloud.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    database.fixturePid = (await database.query("select pg_backend_pid() pid")).rows[0].pid;
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon"), competing = await connect("anon"), operator = await connect();
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'account-cloud-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://account-cloud.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/account-cloud-${suffix}/Clued_资料中心`, rootId = `cloud-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `account-cloud/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `cloud-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `cloud-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='account-cloud-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `cloud-parent-${suffix}`, trackId: `cloud-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `cloud-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Account cloud fixture", redirect_uri: "https://account-cloud.invalid/client-callback",
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
    return { token, id: approved.binding_id, lineage, capability };
  };
  const activate = async target => {
    const policy = randomUUID(); await admin.query("begin");
    try {
      await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
        scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
        select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
          c.source_decision_id,c.decision_version,'reviewed_transition','account-cloud-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  const cloud = async (input, database = caller) => (await database.query(`select ${CLOUD}($1,$2::jsonb) value`, [issuer, JSON.stringify(input)])).rows[0].value;
  const submit = async (target, client, suffix = randomUUID()) => {
    const reference = { connection_id: target.connection, job_id: randomUUID() };
    const mutation = { operation: "create", target_kind: "file", destination_path: target.root + `/20_P_产品与体验/${suffix}.txt`, content: "isolated account cloud UTF-8 fixture" };
    const result = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "submit", ...reference, mutation })])).rows[0].value;
    assert.equal(result.status, "queued", JSON.stringify(result)); return { reference, mutation, result };
  };
  const legacyGrant = async (target, client) => {
    const result = await account({ action: "grant_client", connection_id: target.connection, binding_id: client.id,
      base_version: 1, authorization_version: 1, actions: ACTIONS, expires_at: new Date(Date.now() + 3600000).toISOString(), idempotency_key: randomUUID() });
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const revoke = async (target, database = operator) => {
    await database.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${user}:${target.rootId}`]);
    await database.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),auth_mode='revoked',auth_generation=auth_generation+1,version=version+1 where id=$1", [target.connection]);
    await database.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where id=$1", [target.policy, target.receipt]);
    await database.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,receipt_id) values($1,'google-drive','account-cloud-subject',$2,$3)", [user, target.rootId, target.receipt]);
  };
  const waitForLock = async database => {
    for (let i = 0; i < 200; i++) {
      if ((await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting", [database.fixturePid])).rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("account cloud request did not reach its intended lock wait");
  };
  const counters = async () => (await admin.query(`select
    (select count(*)::int from clued_private.storage_jobs_v1) jobs,
    (select count(*)::int from clued_private.resource_center_mutations_v1) intents,
    (select count(*)::int from clued_private.resource_center_writer_bindings_v1) writers,
    (select count(*)::int from public.clued_audit_receipts) receipts,
    (select count(*)::int from public.clued_context_events) events`)).rows[0];
  const jobRow = async job => (await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, job.reference.job_id])).rows[0];
  const journal = async job => (await admin.query("select m.* from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.owner_id=$1 and j.job_id=$2", [user, job.reference.job_id])).rows[0];
  const provider = target => {
    const directory = (id, name, parent) => ({ id, name, parents: parent ? [parent] : [], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, "20_P_产品与体验", target.rootId)]]);
    const state = { posts: 0, losePost: false, files };
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-account-cloud-access");
      assert.equal(u.hostname, "www.googleapis.com");
      if (init.method === "POST") {
        state.posts++;
        const raw = init.body, match = /\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw), metadata = JSON.parse(match?.[0] ?? raw);
        const attempt = (await admin.query("select provider_attempt from clued_private.resource_center_mutations_v1 where id=$1", [metadata.appProperties.clued_intent_id])).rows[0].provider_attempt;
        assert.equal(attempt.provider_file_id, metadata.id);
        const created = { ...metadata, version: "1", trashed: false, size: attempt.size, sha256Checksum: attempt.sha256 };
        files.set(metadata.id, created);
        if (state.losePost) throw new Error("synthetic lost provider response");
        return Response.json(created);
      }
      assert.equal(init.method ?? "GET", "GET");
      if (u.pathname.endsWith("/generateIds")) return Response.json({ ids: ["cloud-object-" + randomUUID()] });
      const query = u.searchParams.get("q");
      if (query) {
        const parent = /'([^']+)' in parents/.exec(query)?.[1], name = /name = '([^']+)'/.exec(query)?.[1];
        return Response.json({ files: [...files.values()].filter(file => file.parents.includes(parent) && (!name || name === file.name)), incompleteSearch: false });
      }
      const found = files.get(u.pathname.split("/").at(-1));
      return found ? Response.json(found) : new Response("", { status: 404 });
    };
    return state;
  };
  const executor = (target, storage, database = caller, observe = async () => {}) => {
    let loaded;
    return createResourceCenterCloudExecutor({
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref }, database);
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-account-cloud-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
      drive_fetch: storage.fetch,
      rpc: async input => {
        const { connection_id, job_id, action, ...body } = input;
        const request = { connection_id, job_id, action, credential_version: loaded.credential_version,
          ...(action === "finalize" ? { finish: { action, ...body } } : body) };
        await observe(request);
        return cloud(request, database);
      },
    });
  };
  const captureBegin = async (target, job, storage) => {
    let request;
    await executor(target, storage, caller, async input => {
      if (input.action === "begin") { request = structuredClone(input); throw new Error("fixture stops before start"); }
    }).run(job.reference);
    assert.ok(request?.prepare, "real Host must derive the exact prepare before race setup");
    assert.equal(storage.posts, 0); assert.equal((await jobRow(job)).intent_id, null);
    return request;
  };
  const captureVerified = async () => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), job = await submit(target, client), storage = provider(target);
    const fetch = storage.fetch; storage.io = 0;
    storage.fetch = async (...args) => { storage.io++; return fetch(...args); };
    let captured;
    await executor(target, storage, caller, async request => {
      if (["finalize", "verified_record"].includes(request.action)) { captured = structuredClone(request); throw new Error("fixture stops before verified-result storage"); }
    }).run(job.reference);
    assert.ok(captured?.finish?.postcondition, "real executor must finish provider verification first");
    assert.equal(storage.posts, 1);
    const original = await journal(job); assert.equal(original.state, "started"); assert.ok(original.provider_attempt);
    const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-account-cloud-access", scope: SCOPES }), fetch: storage.fetch });
    const verify = createGoogleDriveCreatePostconditionVerifier({ managed_root: target.root, root_folder_id: target.rootId, root_parent_id: target.parentId,
      get_file: metadata.getFile, list_children: metadata.listChildren, require_effect_provider_id: true, include_verified_proof: true });
    const verification = await verify({ profile: { managed_root: target.root }, mutation: job.mutation,
      provider_before: original.authority_request.provider_identity,
      effect_result: { operation: "create", destination_path: job.mutation.destination_path, provider_file_id: original.provider_attempt.provider_file_id } });
    const { verified_proof: proof, ...postcondition } = verification;
    assert.equal(proof?.contract, "clued.storage-create-verified/2", "complete proof must come from the real verifier, never fixture-created flags");
    const record = { action: "verified_record", ...job.reference, credential_version: 1,
      finish: { ...captured.finish, postcondition }, proof };
    return { target, client, job, storage, original, record };
  };
  const settleInput = (sample, recorded) => ({ action: "settle_verified", ...sample.job.reference,
    intent_id: sample.original.id, base_version: Number(sample.original.version), request_sha256: sample.original.request_sha256,
    verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
  try {
    await t.test("cloud and job routers have exact mode/snapshot quadrants and no API access to private cores", async () => {
      for (const signature of ["storage_cloud_worker_v2(text,jsonb)", "storage_jobs_policy_core_v2(text,jsonb)",
        "storage_cloud_job_current_v2(uuid,uuid)", "storage_job_begin_v2(uuid,uuid,text,jsonb)",
        "storage_verified_result_v2(text,jsonb)", "storage_cloud_execution_router_v2(text,jsonb)"]) {
        const permissions = (await admin.query(`select has_function_privilege('anon',p.oid,'EXECUTE') anon,
          has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service,
          exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public
          from pg_proc p where p.oid=$1::regprocedure`, ["clued_private." + signature])).rows[0];
        assert.deepEqual(permissions, { anon: false, authenticated: false, service: false, public: false }, signature);
      }
      const legacy = await createRoot(), legacyClient = await bind(legacy); await legacyGrant(legacy, legacyClient);
      const legacyJob = await submit(legacy, legacyClient);
      const initialPolicy = await createRoot(), policyClient = await bind(initialPolicy); await legacyGrant(initialPolicy, policyClient);
      const policy = await activate(initialPolicy), policyJob = await submit(policy, policyClient);
      assert.equal((await jobRow(legacyJob)).authority_snapshot_v2, null);
      assert.ok((await jobRow(policyJob)).authority_snapshot_v2);
      for (const job of [legacyJob, policyJob]) assert.equal((await cloud({ action: "load", ...job.reference })).status, "queued");
      for (const [target, client, original, snapshot] of [[legacy, legacyClient, legacyJob, {}], [policy, policyClient, policyJob, null]]) {
        const wrong = randomUUID();
        await admin.query(`insert into clued_private.storage_jobs_v1(owner_id,job_id,connection_id,binding_id,grant_receipt_id,
          authorization_version,request_digest,mutation,receipt_id,authority_snapshot_v2)
          select owner_id,$3,connection_id,binding_id,grant_receipt_id,authorization_version,request_digest,mutation,receipt_id,$4::jsonb
          from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2`, [user, original.reference.job_id, wrong, snapshot === null ? null : JSON.stringify(snapshot)]);
        const before = await counters(), request = { connection_id: target.connection, job_id: wrong };
        await assert.rejects(cloud({ action: "load", ...request }), /storage_cloud_mode_denied/);
        await assert.rejects(caller.query(`select ${JOBS}($1,$2::jsonb)`, [client.token, { action: "inspect", ...request }]), /storage_job_mode_denied/);
        assert.deepEqual(await counters(), before);
      }
      for (const action of ["recovery_load", "recovery_finalize"]) {
        const before = await counters();
        await assert.rejects(cloud({ action, ...policyJob.reference }), /storage_cloud_recovery_unavailable/);
        assert.deepEqual(await counters(), before);
      }
      // A trap core proves a V2 rejection is not retried through the legacy
      // implementation, even with a previously valid legacy grant present.
      await admin.query("begin");
      try {
        await admin.query("create or replace function public.clued_storage_cloud_worker_v1(p_issuer_hash text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ begin raise exception 'fixture_forbidden_legacy_fallback'; end $$");
        await admin.query("create or replace function public.clued_storage_jobs_v1(p_token_hash text,p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ begin raise exception 'fixture_forbidden_legacy_fallback'; end $$");
        await admin.query("update clued_private.storage_client_capabilities_v2 set state='revoked',revoked_at=clock_timestamp(),version=version+1,receipt_id=$2 where id=$1", [policyClient.capability, legacy.receipt]);
        const before = await counters();
        for (const invoke of [() => cloud({ action: "load", ...policyJob.reference }, admin),
          () => admin.query(`select ${JOBS}($1,$2::jsonb)`, [policyClient.token, { action: "submit", connection_id: policy.connection, job_id: randomUUID(), mutation: policyJob.mutation }])]) {
          await admin.query("savepoint no_fallback");
          await assert.rejects(invoke(), /storage_policy_denied/);
          await admin.query("rollback to savepoint no_fallback");
        }
        assert.deepEqual(await counters(), before);
      } finally { await admin.query("rollback"); }
    });
    await t.test("dispatch report stores a strict optional reason in the Owner's job, receipt and event; inspect sees its code only", async () => {
      const initial = await createRoot(), client = await bind(initial), target = await activate(initial);
      const [job, plainJob, codeJob] = [await submit(target, client), await submit(target, client), await submit(target, client)];
      const report = (reference, outcome) => cloud({ action: "report", ...reference, credential_version: 1, outcome });
      const island = { path: target.root.replace(/\/[^/]+$/, "/Clued_岛.md"), reason: "resource_center_parent_or_sibling_island" };
      const finding = (overrides = {}) => ({ ...island, ...overrides });
      const code = "UNAUTHORIZED_WORKSPACE_MUTATION";
      const before = await counters();
      for (const outcome of [
        { status: "denied", extra: true }, { status: "denied", reason: code }, { status: "denied", reason: null },
        { status: "denied", reason: {} }, { status: "denied", reason: { code: "lower_case" } }, { status: "denied", reason: { code: "AB" } },
        { status: "denied", reason: { code: "X".repeat(65) } }, { status: "denied", reason: { code, extra: 1 } },
        { status: "attention_required", reason: { code, findings: [finding()] } },
        { status: "denied", reason: { code, findings: [] } }, { status: "denied", reason: { code, findings: finding() } },
        { status: "denied", reason: { code, findings: Array.from({ length: 11 }, () => finding()) } },
        { status: "denied", reason: { code, findings: [finding({ path: "x".repeat(1001) })] } },
        { status: "denied", reason: { code, findings: [finding({ path: "" })] } },
        { status: "denied", reason: { code, findings: [finding({ managed_root: target.root })] } },
        { status: "denied", reason: { code, findings: [finding({ reason: "Not_A_Label" })] } },
        { status: "denied", reason: { code, findings: [finding({ path: 7 })] } }, { status: "committed", reason: { code } },
      ]) await assert.rejects(report(job.reference, outcome), /storage_cloud_denied/, JSON.stringify(outcome).slice(0, 120));
      assert.deepEqual(await counters(), before); assert.equal((await jobRow(job)).dispatch_outcome, null);
      const outcome = { status: "denied", reason: { code, findings: [finding(), finding({ path: "路".repeat(1000) })] } };
      const reported = await report(job.reference, outcome);
      assert.equal(reported.status, "denied"); assert.equal(reported.reason_code, code); assert.equal(reported.findings, undefined);
      const row = await jobRow(job); assert.deepEqual(row.dispatch_outcome, outcome); assert.equal(row.intent_id, null);
      const receipt = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [row.dispatch_outcome_receipt_id])).rows[0];
      assert.deepEqual(receipt, { operation: "storage_dispatch_outcome", status: "committed" });
      const event = (await admin.query("select canonical_event_type,change_summary from public.clued_context_events where receipt_id=$1", [row.dispatch_outcome_receipt_id])).rows[0];
      assert.equal(event.canonical_event_type, "extension:storage:dispatch_outcome"); assert.deepEqual(event.change_summary.outcome, outcome);
      // The first journal wins; a later report never rewrites the stored reason.
      const again = await report(job.reference, { status: "attention_required" });
      assert.equal(again.status, "denied"); assert.deepEqual((await jobRow(job)).dispatch_outcome, outcome);
      const inspected = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "inspect", ...job.reference })])).rows[0].value;
      assert.equal(inspected.status, "denied"); assert.equal(inspected.reason_code, code);
      assert.equal(JSON.stringify(inspected).includes("Clued_岛"), false);
      // Backward compatible: an outcome without a reason is stored and inspected exactly as before.
      const plain = await report(plainJob.reference, { status: "attention_required" });
      assert.equal(plain.status, "attention_required"); assert.equal("reason_code" in plain, false);
      assert.deepEqual((await jobRow(plainJob)).dispatch_outcome, { status: "attention_required" });
      const codeOnly = await report(codeJob.reference, { status: "attention_required", reason: { code: "DRIVE_BOUNDARY_CHANGED" } });
      assert.equal(codeOnly.status, "attention_required"); assert.equal(codeOnly.reason_code, "DRIVE_BOUNDARY_CHANGED");
      assert.deepEqual((await jobRow(codeJob)).dispatch_outcome, { status: "attention_required", reason: { code: "DRIVE_BOUNDARY_CHANGED" } });
    });
    await t.test("root revoke and cloud load serialize in both winning orders without issuing post-revoke writers", async () => {
      for (const loadWins of [false, true]) {
        const initial = await createRoot(), client = await bind(initial), target = await activate(initial), job = await submit(target, client);
        let pending; await operator.query("begin");
        try {
          if (loadWins) {
            await caller.query("begin");
            assert.equal((await cloud({ action: "load", ...job.reference })).status, "queued");
            pending = revoke(target).then(value => ({ value }), error => ({ error }));
            await waitForLock(operator); await caller.query("commit");
            assert.equal((await pending).error, undefined); await operator.query("commit");
          } else {
            await revoke(target);
            pending = cloud({ action: "load", ...job.reference }).then(value => ({ value }), error => ({ error }));
            await waitForLock(caller); await operator.query("commit");
            assert.match((await pending).error?.message ?? "", /storage_policy_denied|storage_cloud_mode_denied/);
            assert.equal((await jobRow(job)).cloud_writer_binding_id, null);
          }
          const before = await counters();
          await assert.rejects(cloud({ action: "load", ...job.reference }), /storage_cloud_mode_denied/);
          assert.deepEqual(await counters(), before); assert.equal((await jobRow(job)).intent_id, null);
        } finally { await caller.query("rollback"); await operator.query("rollback"); if (pending) await pending; }
      }
    });
    await t.test("exact begin and root revoke serialize in both orders and never grant a second start", async () => {
      for (const startWins of [false, true]) {
        const initial = await createRoot(), client = await bind(initial), target = await activate(initial), job = await submit(target, client), storage = provider(target);
        const request = await captureBegin(target, job, storage); let pending, started;
        await operator.query("begin");
        try {
          if (startWins) {
            await caller.query("begin"); started = await cloud(request);
            assert.equal(started.state, "started"); assert.equal(started.execution_permitted, true);
            pending = revoke(target).then(value => ({ value }), error => ({ error }));
            await waitForLock(operator); await caller.query("commit");
            assert.equal((await pending).error, undefined); await operator.query("commit");
            const row = await journal(job); assert.equal(row.id, started.intent_id); assert.equal(row.state, "started");
          } else {
            await revoke(target);
            pending = cloud(request).then(value => ({ value }), error => ({ error }));
            await waitForLock(caller); await operator.query("commit");
            assert.match((await pending).error?.message ?? "", /storage_policy_denied|storage_cloud_mode_denied/);
            assert.equal((await jobRow(job)).intent_id, null);
          }
          const before = await counters();
          await assert.rejects(cloud(request), /storage_cloud_mode_denied/);
          assert.deepEqual(await counters(), before); assert.equal(storage.posts, 0);
        } finally { await caller.query("rollback"); await operator.query("rollback"); if (pending) await pending; }
      }
    });
    await t.test("two independent V2 executors share one exact start, provider attempt and file effect", async () => {
      const initial = await createRoot(), client = await bind(initial), target = await activate(initial), job = await submit(target, client), storage = provider(target);
      const requests = [];
      const observe = async request => { requests.push(structuredClone(request)); };
      const results = await Promise.all([executor(target, storage, caller, observe).run(job.reference), executor(target, storage, competing, observe).run(job.reference)]);
      assert.equal(results.filter(value => value.status === "committed").length, 1, JSON.stringify(results)); assert.equal(storage.posts, 1);
      const row = await journal(job); assert.equal(row.state, "committed"); assert.ok(row.provider_attempt);
      const before = await counters(), originalJob = await jobRow(job);
      const repeated = await cloud(requests.find(request => request.action === "begin"));
      assert.equal(repeated.execution_permitted, false); assert.equal(repeated.replayed, true); assert.equal(repeated.intent_id, row.id);
      assert.equal((await executor(target, storage).run(job.reference)).status, "inspection_required");
      assert.equal(storage.posts, 1); assert.deepEqual(await counters(), before); assert.deepEqual(await jobRow(job), originalJob);
      const loaded = await cloud({ action: "load", ...job.reference });
      assert.equal(loaded.credential_envelope, undefined); assert.equal(loaded.mutation, undefined);
      assert.equal(loaded.execution_permitted, false); assert.equal(loaded.intent_id, row.id);
    });
    await t.test("lost V2 provider reply retains original attempt and root fence across replay, conflicts and restart", async () => {
      const initial = await createRoot(), client = await bind(initial), target = await activate(initial), job = await submit(target, client), storage = provider(target);
      storage.losePost = true; const requests = [];
      const result = await executor(target, storage, caller, async request => { requests.push(structuredClone(request)); }).run(job.reference);
      assert.equal(result.status, "unreconciled", JSON.stringify(result)); assert.equal(storage.posts, 1);
      const row = await journal(job), originalJob = await jobRow(job); assert.equal(row.state, "started"); assert.ok(row.provider_attempt);
      const routerAcl = (await admin.query(`select has_function_privilege('anon',$1,'EXECUTE') anon,
        has_function_privilege('authenticated',$1,'EXECUTE') authenticated`,
        ['public.clued_storage_cloud_worker_router_v2(text,jsonb)'])).rows[0];
      assert.deepEqual(routerAcl,{anon:true,authenticated:false});
      const verifiedStatus = await cloud({action:"verified_inspect",...job.reference});
      assert.equal(verifiedStatus.status,"inspection_required");
      assert.equal(verifiedStatus.job_id,job.reference.job_id);
      // In the isolated database, load only the exact original attempt under a
      // native Owner session and fixed issuer. The temporary envelope is not a
      // usable token and the surrounding transaction rolls back all fixture IO.
      await admin.query("begin");
      try {
        await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
          JSON.stringify({contract:"clued.storage-credential/1",key_id:"fixture",nonce:"A".repeat(16),ciphertext:"B".repeat(24)})]);
        await admin.query("set local role authenticated");
        await admin.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
          [user,JSON.stringify({sub:user,session_id:session})]);
        const original = {action:"recovery_load",...job.reference};
        const loaded = (await admin.query("select public.clued_storage_native_recovery_load_v2($1,$2::jsonb) value",
          [issuerSecret,JSON.stringify(original)])).rows[0].value;
        assert.equal(loaded.status,"recovery_only"); assert.equal(loaded.intent_id,row.id);
        assert.equal(loaded.attempt.provider_file_id,row.provider_attempt.provider_file_id);
        assert.equal(loaded.job_id,job.reference.job_id);
        await admin.query("reset role");
        await admin.query("update clued_private.resource_center_mutations_v1 set created_at=clock_timestamp()-interval '20 minutes' where id=$1", [row.id]);
        await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1", [row.provider_attempt_receipt_id]);
        await admin.query("set local role anon");
        const scheduled = async input => (await admin.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
          [issuer,JSON.stringify(input)])).rows[0].value;
        const due = await scheduled({action:"due"});
        assert.equal(due.status,"ok");
        assert.deepEqual(due.jobs.filter(item => item.job_id===job.reference.job_id),[job.reference]);
        const scheduledDescriptor = await scheduled({action:"load",...job.reference});
        assert.equal(scheduledDescriptor.status,"recovery_only");
        assert.equal(scheduledDescriptor.intent_id,row.id);
        assert.deepEqual(scheduledDescriptor.attempt,loaded.attempt);
        await admin.query("savepoint expired_scheduled_attempt");
        await admin.query("reset role");
        await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '20 minutes' where id=$1", [row.provider_attempt_receipt_id]);
        await admin.query("set local role anon");
        await assert.rejects(scheduled({action:"load",...job.reference}),/storage_scheduled_recovery_denied/);
        await admin.query("rollback to savepoint expired_scheduled_attempt");
        await admin.query("savepoint bad_scheduled_recovery");
        await assert.rejects(scheduled({action:"load",...job.reference,mutation:{operation:"create"}}),/storage_scheduled_recovery_denied/);
        await admin.query("rollback to savepoint bad_scheduled_recovery");
        await admin.query("savepoint malformed_scheduled_reference");
        await assert.rejects(scheduled({action:"load",connection_id:"not-a-uuid",job_id:job.reference.job_id}),
          /storage_scheduled_recovery_denied/);
        await admin.query("rollback to savepoint malformed_scheduled_reference");
        await admin.query("savepoint wrong_scheduled_issuer");
        await assert.rejects(admin.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb)",
          [sha("wrong-issuer"),JSON.stringify({action:"load",...job.reference})]),/storage_scheduled_recovery_denied/);
        await admin.query("rollback to savepoint wrong_scheduled_issuer");
        await admin.query("set local role authenticated");
        const oauth = async (name, input) => (await admin.query(`select public.${name}($1,$2::jsonb) value`,
          [issuerSecret, JSON.stringify(input)])).rows[0].value;
        const description = await oauth("clued_storage_recovery_oauth_start_v2",
          {action:"describe",...job.reference});
        assert.equal(description.connection_id,target.connection);
        assert.equal(description.provider_subject,"account-cloud-subject");
        assert.match(description.recovery_binding,/^[0-9a-f]{64}$/);
        assert.equal(description.credential_envelope,undefined);
        const stateHash = sha(randomUUID()), oauthAttempt = randomUUID();
        const verifierEnvelope = {contract:"clued.storage-credential/1",key_id:"fixture",
          nonce:"A".repeat(16),ciphertext:"B".repeat(24)};
        const prepared = await oauth("clued_storage_recovery_oauth_start_v2",{
          action:"prepare",...job.reference,connection_version:description.connection_version,
          attempt_id:oauthAttempt,state_hash:stateHash,verifier_envelope:verifierEnvelope,
          recovery_binding:description.recovery_binding});
        assert.equal(prepared.status,"prepared");
        const claimed = await oauth("clued_storage_oauth_callback_v2",{action:"claim",state_hash:stateHash});
        assert.equal(claimed.status,"claimed");assert.equal(claimed.purpose,"credential_recovery");
        assert.equal(claimed.attempt_id,oauthAttempt);assert.equal(claimed.credential_envelope,undefined);
        const completed = await oauth("clued_storage_oauth_callback_v2",{action:"complete",
          state_hash:stateHash,provider_subject:"account-cloud-subject",credential_envelope:verifierEnvelope});
        assert.equal(completed.status,"completed");assert.equal(completed.purpose,"credential_recovery");
        const replay = await oauth("clued_storage_oauth_callback_v2",{action:"claim",state_hash:stateHash});
        assert.equal(replay.receipt_id,completed.receipt_id);
        await admin.query("reset role");
        const freshConnection = (await admin.query("select credential_version from clued_private.storage_connections_v1 where id=$1",
          [target.connection])).rows[0];
        assert.equal(Number(freshConnection.credential_version),2);
        assert.equal((await journal(job)).state,"started","consent never settles or repeats the provider effect");
        assert.equal(storage.posts,1);
        await admin.query("set local role authenticated");
        await admin.query("savepoint wrong_recovery_issuer");
        await assert.rejects(admin.query("select public.clued_storage_recovery_oauth_start_v2($1,$2::jsonb)",
          ["wrong-secret".repeat(4),JSON.stringify({action:"describe",...job.reference})]),/storage_credential_recovery_denied/);
        await admin.query("rollback to savepoint wrong_recovery_issuer");
        await assert.rejects(admin.query("select public.clued_storage_native_recovery_load_v2($1,$2::jsonb)",
          ["wrong-secret".repeat(4),JSON.stringify(original)]),/storage_recovery_denied/);
      } finally { await admin.query("rollback"); }
      const request = requests.find(item => item.action === "provider_attempt"); assert.ok(request);
      const before = await counters(), replay = await cloud(request);
      assert.equal(replay.status, "replayed"); assert.equal(replay.attempt_recorded, false); assert.equal(replay.execution_permitted, false);
      assert.equal(replay.receipt_id, row.provider_attempt_receipt_id);
      await assert.rejects(cloud({ ...request, attempt: { ...request.attempt, provider_file_id: "conflicting-object" } }), /storage_attempt_conflict/);
      await assert.rejects(cloud({ ...request, attempt: { ...request.attempt, destination_path: target.root + "/outside.txt" } }), /storage_attempt_mismatch/);
      assert.equal((await executor(target, storage, competing).run(job.reference)).status, "inspection_required");
      assert.deepEqual(await counters(), before); assert.deepEqual(await journal(job), row); assert.deepEqual(await jobRow(job), originalJob); assert.equal(storage.posts, 1);
      const next = await submit(target, client), nextBefore = await counters();
      await assert.rejects(cloud({ action: "load", ...next.reference }), /storage_root_has_unresolved_mutation/);
      assert.deepEqual(await counters(), nextBefore); assert.equal((await jobRow(next)).cloud_writer_binding_id, null);
      await operator.query("begin"); try { await revoke(target); await operator.query("commit"); } catch (error) { await operator.query("rollback"); throw error; }
      const revokedBefore = await counters();
      await assert.rejects(cloud(request), /storage_cloud_mode_denied/);
      assert.deepEqual(await counters(), revokedBefore); assert.deepEqual(await journal(job), row); assert.deepEqual(await jobRow(job), originalJob);
      await assert.rejects(cloud({ action: "finalize", ...job.reference, credential_version: 1, finish: {} }), /storage_cloud_mode_denied/);
      assert.deepEqual(await counters(), revokedBefore); assert.deepEqual(await journal(job), row); assert.equal(storage.posts, 1);
    });
    await t.test("a complete persisted verification settles after root revocation with one original result and no provider I/O", async () => {
      const sample = await captureVerified(), { target, job, storage, original, record } = sample;
      const startReceipt = (await admin.query("select * from public.clued_audit_receipts where id=$1", [original.receipt_id])).rows[0];
      assert.equal(startReceipt.status, "committed"); assert.equal(startReceipt.operation, "resource_center_journal");
      assert.equal(startReceipt.idempotency_key, `account-job:${job.reference.job_id}:start`);
      const recorded = await cloud(record); assert.equal(recorded.status, "verified"); assert.equal(recorded.execution_permitted, false);
      assert.equal(recorded.intent_id, original.id); assert.equal(recorded.version, Number(original.version));
      const verified = await journal(job); assert.equal(verified.state, "started"); assert.equal(verified.version, original.version);
      assert.equal(verified.verified_receipt_id_v2, recorded.verified_receipt_id); assert.equal(verified.verified_digest_v2, recorded.verified_digest);
      assert.equal(verified.verified_result_v2.start_receipt_id, startReceipt.id, "persisted verification retains the original durable start evidence");
      assert.deepEqual(verified.provider_attempt, original.provider_attempt); assert.equal(verified.writer_binding_id, original.writer_binding_id);
      const beforeRecordReplay = await counters(); assert.deepEqual(await cloud(record), recorded); assert.deepEqual(await counters(), beforeRecordReplay);
      await operator.query("begin");
      try { await revoke(target); await operator.query("commit"); } catch (error) { await operator.query("rollback"); throw error; }
      // Pure Canonical settlement does not revalidate by fetching the provider
      // or issue a replacement writer after its former one was revoked.
      await admin.query("update clued_private.resource_center_writer_bindings_v1 set revoked_at=clock_timestamp() where id=$1", [original.writer_binding_id]);
      const before = await counters(), beforeIo = storage.io, request = settleInput(sample, recorded), originalJob = await jobRow(job);
      storage.fetch = async () => { storage.io++; throw new Error("provider I/O forbidden after disconnect"); };
      const settled = await cloud(request);
      assert.equal(settled.status, "committed"); assert.equal(settled.state, "committed"); assert.equal(settled.intent_id, original.id); assert.equal(settled.execution_permitted, false);
      assert.equal(storage.io, beforeIo); assert.equal(storage.posts, 1);
      const after = await counters();
      assert.equal(after.jobs, before.jobs); assert.equal(after.intents, before.intents); assert.equal(after.writers, before.writers);
      assert.equal(after.receipts, before.receipts + 2, "one Artifact receipt and one settlement receipt commit atomically");
      const final = await journal(job); assert.equal(final.state, "committed"); assert.equal(final.receipt_id, settled.receipt_id);
      assert.deepEqual(final.provider_attempt, original.provider_attempt); assert.deepEqual(final.verified_result_v2, verified.verified_result_v2);
      assert.equal(final.verified_result_v2.start_receipt_id, startReceipt.id);
      assert.deepEqual((await admin.query("select * from public.clued_audit_receipts where id=$1", [startReceipt.id])).rows[0], startReceipt);
      assert.deepEqual((await jobRow(job)).authority_snapshot_v2, originalJob.authority_snapshot_v2);
      const replay = await cloud(request);
      assert.equal(replay.receipt_id, settled.receipt_id, "a lost settlement reply reads the exact original receipt");
      assert.equal(replay.intent_id, settled.intent_id); assert.equal(replay.state, "committed"); assert.equal(replay.execution_permitted, false);
      assert.deepEqual(replay.final_result, settled.final_result);
      assert.deepEqual(await counters(), after); assert.equal(storage.io, beforeIo); assert.equal(storage.posts, 1);
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where id=$1 and status='committed'", [settled.receipt_id])).rows[0].n, 1);
    });
    await t.test("root revocation winning before verification storage rejects recording and retains the exact unknown-effect fence", async () => {
      const sample = await captureVerified(), { target, job, storage, original, record } = sample;
      const before = await counters(), beforeIo = storage.io; let pending;
      await operator.query("begin");
      try {
        await revoke(target);
        pending = cloud(record).then(value => ({ value }), error => ({ error }));
        await waitForLock(caller); await operator.query("commit");
        const outcome = await pending; assert.ok(outcome.error); assert.equal(outcome.error.message, "storage_verified_denied");
        assert.deepEqual(await journal(job), original); assert.deepEqual(await counters(), before); assert.equal(storage.io, beforeIo); assert.equal(storage.posts, 1);
        await assert.rejects(cloud(settleInput(sample, { verified_receipt_id: randomUUID(), verified_digest: sha("not recorded") })), { message: "storage_verified_mismatch" });
        assert.deepEqual(await journal(job), original); assert.deepEqual(await counters(), before);
        await assert.rejects(admin.query("select clued_private.storage_root_quiet_v1($1,$2)", [user, target.rootId]), /storage_root_has_unresolved_mutation/);
      } finally { await operator.query("rollback"); if (pending) await pending; }
    });
    await t.test("POST identity alone, incomplete proof and exact content, parent, version, attempt, writer or start-receipt mismatches never become settled evidence", async () => {
      const sample = await captureVerified(), { job, storage, original, record } = sample;
      const before = await counters(), beforeIo = storage.io;
      const invalid = [
        { ...record, proof: undefined },
        { ...record, proof: { path: record.proof.path, provider_file_id: record.proof.provider_file_id } },
        { ...record, proof: { ...record.proof, checks: { ...record.proof.checks, content: false } } },
        { ...record, proof: { ...record.proof, sha256: sha("wrong content") } },
        { ...record, proof: { ...record.proof, parent_id: "wrong-parent" } },
        { ...record, proof: { ...record.proof, provider_file_version: "2" } },
        { ...record, proof: { ...record.proof, provider_file_id: "wrong-attempt-object" }, finish: { ...record.finish,
          postcondition: { ...record.finish.postcondition, provider_file_id: "wrong-attempt-object" } } },
        { ...record, finish: { ...record.finish, base_version: Number(original.version) + 1 } },
      ];
      for (const request of invalid) {
        await assert.rejects(cloud(request), { message: "storage_verified_mismatch" });
        assert.deepEqual(await journal(job), original); assert.deepEqual(await counters(), before);
      }
      // Rollback-only corruption probes in the disposable database. A wrong
      // current receipt cannot stand in for the start; a missing exact start
      // key cannot be inferred from a provider POST or the journal state.
      for (const change of [
        ["update clued_private.resource_center_mutations_v1 set receipt_id=$2 where id=$1", [original.id, sample.target.receipt]],
        ["update public.clued_audit_receipts set idempotency_key=$2 where id=$1", [original.receipt_id, `missing-start:${randomUUID()}`]],
      ]) {
        await admin.query("begin");
        try {
          await admin.query(...change);
          const corrupted = await journal(job), unchanged = await counters();
          for (const request of [record, { action: "settle_verified", ...job.reference }]) {
            await admin.query("savepoint invalid_start_evidence");
            await assert.rejects(cloud(request, admin), { message: "storage_verified_mismatch" });
            await admin.query("rollback to savepoint invalid_start_evidence");
            assert.deepEqual(await journal(job), corrupted); assert.deepEqual(await counters(), unchanged);
            assert.equal(corrupted.verified_result_v2, null); assert.equal(corrupted.verified_receipt_id_v2, null);
          }
        } finally { await admin.query("rollback"); }
        assert.deepEqual(await journal(job), original); assert.deepEqual(await counters(), before);
      }
      await admin.query("begin");
      try {
        const otherWriter = (await admin.query(`insert into clued_private.resource_center_writer_bindings_v1(authority_binding_id,token_hash,source_decision_id,expires_at,receipt_id)
          select authority_binding_id,$2,source_decision_id,expires_at,receipt_id from clued_private.resource_center_writer_bindings_v1 where id=$1 returning id`,
          [original.writer_binding_id, sha(randomUUID())])).rows[0].id;
        await admin.query("update clued_private.storage_jobs_v1 set cloud_writer_binding_id=$3 where owner_id=$1 and job_id=$2", [user, job.reference.job_id, otherWriter]);
        const changed = await counters(); await admin.query("savepoint bad_writer");
        await assert.rejects(cloud(record, admin), { message: "storage_verified_mismatch" });
        await admin.query("rollback to savepoint bad_writer");
        assert.deepEqual(await counters(), changed); assert.deepEqual(await journal(job), original);
      } finally { await admin.query("rollback"); }
      await assert.rejects(cloud(settleInput(sample, { verified_receipt_id: randomUUID(), verified_digest: sha("post-only") })), { message: "storage_verified_mismatch" });
      assert.deepEqual(await journal(job), original); assert.deepEqual(await counters(), before); assert.equal(storage.io, beforeIo); assert.equal(storage.posts, 1);
      await assert.rejects(admin.query("select clued_private.storage_root_quiet_v1($1,$2)", [user, sample.target.rootId]), /storage_root_has_unresolved_mutation/);
    });
  } finally {
    await admin.query("rollback");
    for (const database of clients) { await database.query("rollback").catch(() => {}); await database.end(); }
  }
}
