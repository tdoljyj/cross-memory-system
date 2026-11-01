import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveModifyPostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-modify-postcondition.mjs";
import { googleDriveAccessDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";
import { EMPTY_PROVIDER_VERSION } from "../../../kernel/host/resource-center-google-drive-identity.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const ACTIONS = ["inspect", "create_file", "create_topic"];
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const WRITE = "public.clued_storage_write_access_v1";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const TRACK = "20_P_产品与体验";

// StorageFullCapability.v0.1 P3 part B: rename and file move through the real
// cloud executor (verified-result mode) against disposable PostgreSQL and an
// in-memory Drive. Never Google, never a disk.
export async function testStorageModifyExecution(t, admin, server, user, decision, options = {}) {
  await allowTestIssuerCredentials(admin);
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `modify-exec-${randomUUID()}`, resource = "https://modify-exec.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    database.fixturePid = (await database.query("select pg_backend_pid() pid")).rows[0].pid;
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon"), competing = await connect("anon"), operator = await connect();
  if (options.gateway) {
    await setWorkerGatewayCaller(caller);
    await setWorkerGatewayCaller(competing);
  }
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'modify-exec-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://modify-exec.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/modify-exec-${suffix}/Clued_资料中心`, rootId = `mx-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `modify-exec/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `mx-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `mx-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='modify-exec-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `mx-parent-${suffix}`, trackId: `mx-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `mx-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Modify execution fixture", redirect_uri: "https://modify-exec.invalid/client-callback",
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
          c.source_decision_id,c.decision_version,'reviewed_transition','modify-exec-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  const cloud = async (input, database = caller) => {
    try { return (await database.query(`select ${CLOUD}($1,$2::jsonb) value`, [issuer, JSON.stringify(input)])).rows[0].value; }
    catch (error) { options.on_cloud_error?.(error, input); throw error; }
  };
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
    await database.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,receipt_id) values($1,'google-drive','modify-exec-subject',$2,$3)", [user, target.rootId, target.receipt]);
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
    const directory = (id, name, parent) => ({ id, name, parents: parent ? [parent] : [], version: "1", trashed: false, explicitlyTrashed: false, permissions: [{ id: "fixture-owner", type: "user", role: "owner" }], mimeType: "application/vnd.google-apps.folder" });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, "20_P_产品与体验", target.rootId)],
      // The Owner's own Clued-named doc beside the root (StorageNormalUse §3.1): listed, not app-authorized.
      ["owner-clued-doc", { id: "owner-clued-doc", name: "Clued_单一数据源方案", parents: [target.parentId], version: "1", trashed: false,
        mimeType: "application/vnd.google-apps.document", isAppAuthorized: false }]]);
    const state = { posts: 0, patches: 0, losePost: false, losePatch: false, files };
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-modify-exec-access");
      assert.equal(u.hostname, "www.googleapis.com");
      if (init.method === "PATCH") {
        state.patches++;
        const id = u.pathname.split("/").at(-1), file = files.get(id), body = JSON.parse(init.body || "{}");
        const recorded = (await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1 and provider_attempt->>'contract'='clued.storage-modify-attempt/1'", [id])).rows[0].n;
        assert.equal(recorded, 1, "the exact attempt is durable before the update");
        if (body.name) file.name = body.name;
        if (body.appProperties) file.appProperties = { ...file.appProperties, ...body.appProperties };
        const add = u.searchParams.get("addParents"), remove = u.searchParams.get("removeParents");
        if (add) { assert.deepEqual(file.parents, [remove]); file.parents = [add]; }
        file.version = String(Number(file.version) + 3); // Drive may jump by more than one.
        if (state.losePatch) throw new Error("synthetic lost provider response");
        return Response.json(file);
      }
      if (init.method === "POST") {
        state.posts++;
        const raw = init.body, match = /\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw), metadata = JSON.parse(match?.[0] ?? raw);
        const attempt = (await admin.query("select provider_attempt from clued_private.resource_center_mutations_v1 where id=$1", [metadata.appProperties.clued_intent_id])).rows[0].provider_attempt;
        assert.equal(attempt.provider_file_id, metadata.id);
        const created = { ...metadata, version: "1", trashed: false, explicitlyTrashed: false,
          ...(metadata.mimeType === "application/vnd.google-apps.folder" ? { permissions: [{ id: "fixture-owner", type: "user", role: "owner" }] } : { size: attempt.size, sha256Checksum: attempt.sha256,
            md5Checksum: "f".repeat(32), headRevisionId: "rev-" + randomUUID() }) };
        files.set(metadata.id, created);
        if (state.losePost) throw new Error("synthetic lost provider response");
        return Response.json(created);
      }
      assert.equal(init.method ?? "GET", "GET");
      if (u.pathname.endsWith("/generateIds")) return Response.json({ ids: ["cloud-object-" + randomUUID()] });
      const query = u.searchParams.get("q");
      if (query) {
        const parent = /'([^']+)' in parents/.exec(query)?.[1], name = /name = '([^']+)'/.exec(query)?.[1];
        return Response.json({ files: [...files.values()].filter(file => file.parents.includes(parent) && !file.trashed && (!name || name === file.name)), incompleteSearch: false });
      }
      const found = files.get(u.pathname.split("/").at(-1));
      return found ? Response.json(found) : new Response("", { status: 404 });
    };
    return state;
  };
  // legacy: a Worker from before storage step 3 ignores load's ancestor_match.
  const executor = (target, storage, database = caller, observe = async () => {}, { legacy = false, semantic = false } = {}) => {
    let loaded;
    return createResourceCenterCloudExecutor({ verified_result_mode: true,
      ...(semantic ? { semantic_recovery_client_id: oauthClient } : {}),
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref }, database);
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        if (legacy) delete descriptor.ancestor_match;
        return descriptor;
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-modify-exec-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
      drive_fetch: storage.fetch,
      rpc: async input => {
        const { connection_id, job_id, action, ...body } = input;
        // As the Worker bridge: settle_verified carries no credential version.
        const request = { connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
          ...(action === "finalize" ? { finish: { action, ...body } } : body) };
        await observe(request);
        return cloud(request, database);
      },
    });
  };
  const enableModify = async target => {
    const status = (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "status", connection_id: target.connection })])).rows[0].value;
    const done = (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: target.connection,
      classes: ["modify"], base_generation: status.policy_generation, disclosure_version: status.disclosure_version, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(done.status, "committed", JSON.stringify(done));
  };
  const submitJob = async (target, client, mutation) => {
    const reference = { connection_id: target.connection, job_id: randomUUID() };
    const result = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "submit", ...reference, mutation })])).rows[0].value;
    assert.equal(result.status, "queued", JSON.stringify(result));
    return { reference, mutation, result };
  };
  const directoryIn = async (target, storage, name) => {
    const id = `mx-dir-${randomUUID()}`, path = `${target.root}/${TRACK}/${name}`;
    storage.files.set(id, { id, name, parents: [target.trackId], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    await register({ action: "artifact_register", profile_id: target.profile, path, provider_file_id: id, provider_file_version: "1",
      target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    return { id, path };
  };
  const artifact = async (target, path) => (await admin.query("select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2 and state='active'", [target.profile, path])).rows[0];
  const createFile = async (target, client, storage, name) => {
    const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/${name}`, content: "modify execution fixture" });
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifact(target, job.mutation.destination_path);
  };
  const setup = async () => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), storage = provider(target);
    await enableModify(target);
    return { target, client, storage };
  };
  const modify = (operation, source, destination, version) => ({ operation, target_kind: "file", source_path: source, destination_path: destination, source_file_version: version });

  try {
    if (options.extra_cases) await options.extra_cases({
      setup, createFile, directoryIn, cloud, submitJob, modify, executor, journal, artifact, account,
      oauth_client_id: oauthClient, owner_id: user, provider_subject: "modify-exec-subject", access_token: "fixture-modify-exec-access",
    });
    if (options.only_extra) return;
    await t.test("rename then move a Clued-created file; the registry follows by CAS and keeps the Artifact", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "draft.txt");
      const topic = await directoryIn(target, storage, "topic-b");
      const renamedPath = `${target.root}/${TRACK}/final.txt`;
      const rename = await submitJob(target, client, modify("rename", created.path, renamedPath, storage.files.get(created.provider_file_id).version));
      const renamed = await executor(target, storage).run(rename.reference);
      assert.equal(renamed.status, "committed", JSON.stringify(renamed));
      assert.equal(storage.patches, 1);
      const file = storage.files.get(created.provider_file_id);
      assert.equal(file.name, "final.txt"); assert.deepEqual(file.parents, [target.trackId]);
      const afterRename = await artifact(target, renamedPath);
      assert.equal(afterRename.id, created.id, "the same Artifact moved; nothing new was registered");
      assert.equal(afterRename.provider_file_version, file.version, "a version jump of more than one is recorded, not misjudged");
      assert.equal(Number(afterRename.version), Number(created.version) + 1);
      assert.equal(await artifact(target, created.path), undefined);
      const intent = await journal(rename);
      assert.equal(intent.state, "committed");
      assert.equal(intent.verified_result_v2.proof.contract, "clued.storage-rename-verified/1");
      assert.equal(intent.provider_attempt.contract, "clued.storage-modify-attempt/1");

      const movedPath = `${topic.path}/final.txt`;
      const move = await submitJob(target, client, modify("move", renamedPath, movedPath, file.version));
      const moved = await executor(target, storage).run(move.reference);
      assert.equal(moved.status, "committed", JSON.stringify(moved));
      assert.equal(storage.patches, 2); assert.deepEqual(file.parents, [topic.id]); assert.equal(file.name, "final.txt");
      const afterMove = await artifact(target, movedPath);
      assert.equal(afterMove.id, created.id); assert.equal(afterMove.provider_file_version, file.version);
      assert.equal((await journal(move)).verified_result_v2.proof.contract, "clued.storage-move-verified/1");
    });

    await t.test("storage step 3: a sibling change during a create no longer fails it; a changed role on the track does", async () => {
      const OWNER = [{ id: "owner", type: "user", role: "owner" }];
      const prepared = async ({ digests }) => {
        const { target, client, storage } = await setup();
        for (const id of [target.rootId, target.trackId]) storage.files.get(id).permissions = structuredClone(OWNER);
        if (digests) await admin.query(`update clued_private.resource_center_artifacts_v1 set provider_access_digest=$2
          where profile_id=$1 and path in ($3,$4) and state='active'`,
          [target.profile, googleDriveAccessDigest({ permissions: OWNER }), target.root, `${target.root}/${TRACK}`]);
        return { target, client, storage };
      };
      const createWith = async ({ target, client, storage }, name, during) => {
        const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/${name}`, content: "step 3 fixture" });
        const result = await executor(target, storage, caller, async request => { if (request.action === "provider_attempt") during(storage.files, target); }).run(job.reference);
        return { job, result };
      };
      const sibling = (files, target) => {
        for (const id of [target.rootId, target.trackId]) files.get(id).version = String(Number(files.get(id).version) + 5);
        const id = `sibling-${randomUUID()}`;
        files.set(id, { id, name: "other.txt", parents: [target.trackId], version: "1", trashed: false, mimeType: "text/plain" });
      };
      // Digest-matched ancestors: the job completes and settles.
      const matched = await prepared({ digests: true });
      const done = await createWith(matched, "with-sibling.txt", sibling);
      assert.equal(done.result.status, "committed", JSON.stringify(done.result));
      const identity = (await journal(done.job)).authority_request.provider_identity;
      assert.deepEqual(identity.ancestors.map(entry => [entry.path, entry.match]),
        [[matched.target.root, "access"], [`${matched.target.root}/${TRACK}`, "access"]]);
      assert.equal(identity.provider_version, EMPTY_PROVIDER_VERSION);
      assert.equal(identity.root_folder_version, null);
      assert.ok(await artifact(matched.target, `${matched.target.root}/${TRACK}/with-sibling.txt`));
      // Version-matched ancestors (no digest): the same change still stops the job before any write.
      const legacy = await prepared({ digests: false });
      const posts = legacy.storage.posts;
      const stopped = await createWith(legacy, "stopped.txt", sibling);
      assert.notEqual(stopped.result.status, "committed");
      assert.equal(legacy.storage.posts, posts);
      assert.equal((await journal(stopped.job)).authority_request.provider_identity.ancestors[1].match, "version");
      // A changed role on the track stops the job before any write.
      const role = await prepared({ digests: true });
      const before = role.storage.posts;
      const refused = await createWith(role, "role.txt", (files, target) => {
        files.get(target.trackId).permissions = [...OWNER, { id: "anyone", type: "anyone", role: "reader" }];
      });
      assert.notEqual(refused.result.status, "committed");
      assert.equal(role.storage.posts, before);

      // A digest changed between the verified record and the settlement is a registry change: nothing is registered.
      const raced = await prepared({ digests: true });
      const racedJob = await submitJob(raced.target, raced.client, { operation: "create", target_kind: "file",
        destination_path: `${raced.target.root}/${TRACK}/raced.txt`, content: "step 3 fixture" });
      const racedResult = await executor(raced.target, raced.storage, caller, async request => {
        if (request.action === "settle_verified") await admin.query(`update clued_private.resource_center_artifacts_v1 set provider_access_digest=$2
          where profile_id=$1 and path=$3 and state='active'`, [raced.target.profile, "e".repeat(64), `${raced.target.root}/${TRACK}`]);
      }).run(racedJob.reference);
      assert.notEqual(racedResult.status, "committed");
      const racedIntent = await journal(racedJob);
      assert.ok(racedIntent.verified_result_v2, "the verification was recorded");
      assert.notEqual(racedIntent.state, "committed");
      assert.equal(await artifact(raced.target, `${raced.target.root}/${TRACK}/raced.txt`), undefined);
    });

    await t.test("storage step 3: a Worker from before step 3 keeps working against the new database", async () => {
      const { target, client, storage } = await setup();
      await admin.query(`update clued_private.resource_center_artifacts_v1 set provider_access_digest=$2 where profile_id=$1 and path=$3 and state='active'`,
        [target.profile, "a".repeat(64), target.root]);
      const old = { legacy: true };
      const create = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/old.txt`, content: "legacy Worker" });
      assert.equal((await executor(target, storage, caller, undefined, old).run(create.reference)).status, "committed");
      const created = await artifact(target, create.mutation.destination_path);
      const topic = await directoryIn(target, storage, "legacy-topic");
      const renamedPath = `${target.root}/${TRACK}/old-renamed.txt`;
      const rename = await submitJob(target, client, modify("rename", created.path, renamedPath, storage.files.get(created.provider_file_id).version));
      assert.equal((await executor(target, storage, caller, undefined, old).run(rename.reference)).status, "committed");
      const move = await submitJob(target, client, modify("move", renamedPath, `${topic.path}/old-renamed.txt`, storage.files.get(created.provider_file_id).version));
      assert.equal((await executor(target, storage, caller, undefined, old).run(move.reference)).status, "committed");
      for (const job of [create, rename, move]) {
        const intent = await journal(job);
        assert.equal(intent.state, "committed");
        assert.ok(intent.verified_result_v2);
        assert.equal("ancestors" in intent.authority_request.provider_identity, false);
        assert.match(intent.authority_request.provider_identity.root_folder_version, /^\d+$/);
      }
    });

    await t.test("a content edit racing the update is never settled into the registry", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "raced.txt");
      const fetch = storage.fetch;
      storage.fetch = async (url, init = {}) => {
        const reply = await fetch(url, init);
        // Someone edits the file in Drive right after Clued's update.
        if (init.method === "PATCH") storage.files.get(created.provider_file_id).headRevisionId = "rev-concurrent";
        return reply;
      };
      const job = await submitJob(target, client, modify("rename", created.path, `${target.root}/${TRACK}/raced-renamed.txt`, storage.files.get(created.provider_file_id).version));
      const result = await executor(target, storage).run(job.reference);
      assert.equal(result.status, "unreconciled", JSON.stringify(result));
      assert.equal((await journal(job)).state, "started", "left fenced for inspection");
      assert.equal((await artifact(target, created.path)).provider_file_version, created.provider_file_version, "the registry keeps the version Clued saw");
    });

    await t.test("a stale source version or a name conflict is refused with zero provider updates; a status folder that exists takes a file", async () => {
      const { target, client, storage } = await setup();
      const first = await createFile(target, client, storage, "one.txt"), second = await createFile(target, client, storage, "two.txt");
      const status = await directoryIn(target, storage, "当前");
      const version = storage.files.get(first.provider_file_id).version;
      const cases = [
        modify("rename", first.path, `${target.root}/${TRACK}/renamed.txt`, String(Number(version) + 1)),
        modify("rename", first.path, second.path, version),
      ];
      for (const mutation of cases) {
        const before = await counters(), job = await submitJob(target, client, mutation);
        const result = await executor(target, storage).run(job.reference);
        assert.equal(result.status, "deny", JSON.stringify({ mutation, result }));
        assert.equal(storage.patches, 0, "no provider update was attempted");
        assert.equal((await counters()).intents, before.intents, "no durable reservation was made");
      }
      assert.equal((await artifact(target, first.path)).id, first.id);
      // Owner Decision f382c494: the layout rules stay, but a file moved into a
      // status-named folder that already exists is not refused.
      const moved = await submitJob(target, client, modify("move", second.path, `${status.path}/two.txt`,
        storage.files.get(second.provider_file_id).version));
      assert.equal((await executor(target, storage).run(moved.reference)).status, "committed");
    });

    await t.test("without the modify level, or in another shape, submit is refused", async () => {
      const initial = await createRoot(), client = await bind(initial), target = await activate(initial);
      const source = `${target.root}/${TRACK}/a.txt`;
      await assert.rejects(caller.query(`select ${JOBS}($1,$2::jsonb)`, [client.token, JSON.stringify({ action: "submit", connection_id: target.connection,
        job_id: randomUUID(), mutation: modify("rename", source, `${target.root}/${TRACK}/b.txt`, "3") })]), /storage_policy_denied/);
      const enabled = await setup();
      const bad = [
        modify("rename", source, `${target.root}/${TRACK}/other/b.txt`, "3"), modify("rename", source, source, "3"),
        modify("move", source, `${target.root}/${TRACK}/other/b.txt`, "3"), modify("move", source, source, "3"),
        { ...modify("rename", source, `${target.root}/${TRACK}/b.txt`, "3"), content: "x" },
        { ...modify("rename", source, `${target.root}/${TRACK}/b.txt`, "3"), target_kind: "directory" },
        modify("rename", source, `${target.root}/${TRACK}/../b.txt`, "3"), modify("rename", source, `${target.root}/${TRACK}/b.txt`, "03"),
        { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/c.txt`, content: "x", source_path: source },
        { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/c.txt`, content: "x", source_file_version: "3" },
      ];
      for (const mutation of bad) {
        await assert.rejects(caller.query(`select ${JOBS}($1,$2::jsonb)`, [enabled.client.token, JSON.stringify({ action: "submit",
          connection_id: enabled.target.connection, job_id: randomUUID(),
          mutation: JSON.parse(JSON.stringify(mutation).replaceAll(target.root, enabled.target.root)) })]),
          // A ".." segment is refused by path canonicalization (20260930233000) with its own fixed code.
          JSON.stringify(mutation).includes("/../") ? /storage_path_invalid/ : /storage_job_input_invalid/, JSON.stringify(mutation));
      }
    });

    await t.test("a lost update reply leaves the intent fenced and the registry unchanged", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "lost.txt");
      storage.losePatch = true;
      const job = await submitJob(target, client, modify("rename", created.path, `${target.root}/${TRACK}/kept.txt`, storage.files.get(created.provider_file_id).version));
      const result = await executor(target, storage).run(job.reference);
      assert.equal(result.status, "unreconciled");
      assert.equal(storage.patches, 1);
      const row = await journal(job);
      assert.equal(row.state, "started", "the uncertain effect stays fenced");
      assert.equal((await artifact(target, created.path)).id, created.id, "no settlement without a verified proof");
      // Scheduled recovery: load the descriptor, re-verify by GET only, then
      // settle through the same verified record (as storage-cloud-recovery.ts).
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
        JSON.stringify({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "B".repeat(24) })]);
      await admin.query("update clued_private.resource_center_mutations_v1 set created_at=clock_timestamp()-interval '20 minutes' where id=$1", [row.id]);
      await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1", [row.provider_attempt_receipt_id]);
      const descriptor = (await caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "load", ...job.reference })])).rows[0].value;
      assert.equal(descriptor.status, "recovery_only"); assert.equal(descriptor.attempt.contract, "clued.storage-modify-attempt/1");
      const patches = storage.patches;
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-modify-exec-access", scope: SCOPES }),
        fetch: async (url, init = {}) => { assert.equal(init.method ?? "GET", "GET"); return storage.fetch(url, init); } });
      const verify = createGoogleDriveModifyPostconditionVerifier({ managed_root: descriptor.profile.managed_root, root_folder_id: descriptor.root_folder_id,
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren, include_verified_proof: true });
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "rename", source_path: descriptor.mutation.source_path,
          destination_path: descriptor.mutation.destination_path, provider_file_id: descriptor.attempt.provider_file_id, content: descriptor.attempt.content } });
      const finish = { action: "finalize", intent_id: descriptor.intent_id, base_version: descriptor.version, request_sha256: descriptor.request_sha256,
        idempotency_key: `account-job:${job.reference.job_id}:finalize`, postcondition };
      const recorded = await cloud({ action: "verified_record", ...job.reference, credential_version: descriptor.credential_version, finish, proof });
      assert.equal(recorded.status, "verified", JSON.stringify(recorded));
      const settled = await cloud({ action: "settle_verified", ...job.reference, intent_id: descriptor.intent_id, base_version: descriptor.version,
        request_sha256: descriptor.request_sha256, verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
      assert.equal(settled.state, "committed", JSON.stringify(settled));
      assert.equal(storage.patches, patches, "recovery never repeats the update");
      assert.equal((await artifact(target, `${target.root}/${TRACK}/kept.txt`)).id, created.id);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
