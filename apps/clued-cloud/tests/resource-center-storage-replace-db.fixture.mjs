import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveReplacePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-replace-postcondition.mjs";
import { bytesContentSource } from "./resource-center-storage-binary.fixture.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const md5 = value => createHash("md5").update(value).digest("hex");
const ACTIONS = ["inspect", "create_file", "create_topic"];
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const WRITE = "public.clued_storage_write_access_v1";
const STAGING = "public.clued_storage_staging_v1";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const TRACK = "20_P_产品与体验";

// StorageFullCapability.v0.1 P4: replace, revision protection and revert
// through the real cloud executor (verified-result mode) against disposable
// PostgreSQL and an in-memory Drive with revisions. Never Google, never a disk.
export async function testStorageReplace(t, admin, server, user, decision, options = {}) {
  await allowTestIssuerCredentials(admin);
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `replace-exec-${randomUUID()}`, resource = "https://replace-exec.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    database.fixturePid = (await database.query("select pg_backend_pid() pid")).rows[0].pid;
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon"), competing = await connect("anon"), operator = await connect();
  if (options.gateway) { await setWorkerGatewayCaller(caller);await setWorkerGatewayCaller(competing); }
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'replace-exec-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://replace-exec.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/replace-exec-${suffix}/Clued_资料中心`, rootId = `rx-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `replace-exec/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `rx-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `rx-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='replace-exec-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `rx-parent-${suffix}`, trackId: `rx-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `rx-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Modify execution fixture", redirect_uri: "https://replace-exec.invalid/client-callback",
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
          c.source_decision_id,c.decision_version,'reviewed_transition','replace-exec-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  const cloud = async (input, database = caller) => {
    try { return (await database.query(`select ${CLOUD}($1,$2::jsonb) value`, [issuer, JSON.stringify(input)])).rows[0].value; }
    catch (error) { options.on_cloud_error?.(error, input);throw error; }
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
    await database.query("insert into clued_private.storage_root_denies_v2(owner_id,provider,provider_subject,root_folder_id,receipt_id) values($1,'google-drive','replace-exec-subject',$2,$3)", [user, target.rootId, target.receipt]);
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
    const revisions = new Map(); // file id -> Map(revision id -> {id, keepForever, bytes})
    const state = { posts: 0, writes: 0, losePost: false, loseUpload: false, loseRelease: false, keptExtra: 0, files, revisions };
    const newRevision = (file, bytes) => {
      const id = "rev-" + randomUUID();
      const revs = revisions.get(file.id) ?? new Map(); revisions.set(file.id, revs);
      revs.set(id, { id, keepForever: false, bytes: Buffer.from(bytes) });
      Object.assign(file, { headRevisionId: id, size: String(bytes.length), md5Checksum: md5(bytes), sha256Checksum: sha(bytes) });
    };
    state.content = id => revisions.get(id).get(files.get(id).headRevisionId).bytes.toString("utf8");
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-replace-exec-access");
      assert.equal(u.hostname, "www.googleapis.com");
      const parts = u.pathname.split("/");
      const revisionIndex = parts.indexOf("revisions");
      if (init.method === "PATCH") {
        state.writes++;
        const id = revisionIndex > 0 ? parts[revisionIndex - 1] : parts.at(-1);
        const recorded = (await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1 and provider_attempt->>'contract'='clued.storage-replace-attempt/1'", [id])).rows[0].n;
        assert.equal(recorded, 1, "the exact attempt is durable before every provider write");
        if (revisionIndex > 0) {
          const revision = revisions.get(id).get(parts[revisionIndex + 1]);
          if (state.loseRelease && JSON.parse(init.body).keepForever === false) throw new Error("synthetic lost release");
          revision.keepForever = JSON.parse(init.body).keepForever;
          return Response.json({ id: revision.id, keepForever: revision.keepForever });
        }
        assert.equal(u.pathname.startsWith("/upload/drive/v3/files/"), true);
        const file = files.get(id);
        let bytes = Buffer.from(init.body);
        if (u.searchParams.get("uploadType") === "multipart") {
          const boundary = /boundary=(.+)$/.exec(new Headers(init.headers).get("content-type"))?.[1];assert.ok(boundary);
          const metadataStart = bytes.indexOf("\r\n\r\n") + 4, metadataEnd = bytes.indexOf(`\r\n--${boundary}`, metadataStart);
          assert.ok(metadataStart >= 4 && metadataEnd > metadataStart);
          const metadata = JSON.parse(bytes.subarray(metadataStart, metadataEnd).toString("utf8"));
          const mediaStart = bytes.indexOf("\r\n\r\n", metadataEnd + 4) + 4, mediaEnd = bytes.lastIndexOf(`\r\n--${boundary}--`);
          assert.ok(mediaStart > metadataEnd && mediaEnd >= mediaStart);
          if (metadata.mimeType) file.mimeType = metadata.mimeType;
          if (metadata.appProperties) file.appProperties = { ...file.appProperties, ...metadata.appProperties };
          bytes = bytes.subarray(mediaStart, mediaEnd);
        } else assert.equal(u.searchParams.get("uploadType"), "media");
        newRevision(file, bytes);
        file.version = String(Number(file.version) + 2); // Drive may jump by more than one.
        if (state.loseUpload) throw new Error("synthetic lost provider response");
        return Response.json(file);
      }
      if (init.method === "POST") {
        state.posts++;
        const raw = init.body, match = /\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw), metadata = JSON.parse(match?.[0] ?? raw);
        const boundary = /boundary=(.+)$/.exec(new Headers(init.headers).get("content-type"))[1];
        const media = raw.split(`--${boundary}`)[2], text = media.slice(media.indexOf("\r\n\r\n") + 4, media.lastIndexOf("\r\n"));
        const created = { ...metadata, version: "1", trashed: false, explicitlyTrashed: false };
        newRevision(created, Buffer.from(text, "utf8"));
        files.set(metadata.id, created);
        return Response.json(created);
      }
      assert.equal(init.method ?? "GET", "GET");
      if (u.pathname.endsWith("/generateIds")) return Response.json({ ids: ["cloud-object-" + randomUUID()] });
      if (revisionIndex > 0) {
        const revs = revisions.get(parts[revisionIndex - 1]) ?? new Map();
        if (revisionIndex === parts.length - 1) {
          const listed = [...revs.values()].map(r => ({ id: r.id, keepForever: r.keepForever }));
          for (let i = 0; i < state.keptExtra; i++) listed.push({ id: "owner-kept-" + i, keepForever: true });
          return Response.json({ revisions: listed });
        }
        const revision = revs.get(parts[revisionIndex + 1]);
        if (!revision) return new Response("", { status: 404 });
        if (u.searchParams.get("alt") === "media") return new Response(revision.bytes);
        return Response.json({ id: revision.id, keepForever: revision.keepForever, size: String(revision.bytes.length), md5Checksum: md5(revision.bytes) });
      }
      const query = u.searchParams.get("q");
      if (query) {
        const parent = /'([^']+)' in parents/.exec(query)?.[1], name = /name = '([^']+)'/.exec(query)?.[1];
        return Response.json({ files: [...files.values()].filter(file => file.parents.includes(parent) && (!name || name === file.name)), incompleteSearch: false });
      }
      const found = files.get(parts.at(-1));
      return found ? Response.json(found) : new Response("", { status: 404 });
    };
    return state;
  };
  const executor = (target, storage, database = caller, observe = async () => {}, staged = null, { semantic = false } = {}) => {
    let loaded;
    return createResourceCenterCloudExecutor({ verified_result_mode: true,
      ...(semantic ? { semantic_recovery_client_id: oauthClient } : {}),
      // Binary replace (Decision 06aba6c5): the staged bytes are handed to the executor directly (never R2).
      ...(staged ? { load_staged_content: async ({ content_ref }) => bytesContentSource(staged(content_ref), content_ref) } : {}),
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref }, database);
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-replace-exec-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
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
  const enableWrite = async (target, level) => {
    const status = (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "status", connection_id: target.connection })])).rows[0].value;
    const done = (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: target.connection,
      classes: [...status.classes, level].sort(), base_generation: status.policy_generation,
      disclosure_version: level === "overwrite" ? status.overwrite_disclosure_version : status.disclosure_version, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(done.status, "committed", JSON.stringify(done));
  };
  const submitJob = async (target, client, mutation) => {
    const reference = { connection_id: target.connection, job_id: randomUUID() };
    const result = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "submit", ...reference, mutation })])).rows[0].value;
    assert.equal(result.status, "queued", JSON.stringify(result));
    return { reference, mutation, result };
  };
  const artifact = async (target, path) => (await admin.query("select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2 and state='active'", [target.profile, path])).rows[0];
  const pins = async artifactId => (await admin.query("select revision_id,state,job_id from clued_private.storage_revision_pins_v1 where artifact_id=$1 order by created_at,id", [artifactId])).rows;
  const createFile = async (target, client, storage, name, content = "original text\n") => {
    const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/${name}`, content });
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifact(target, job.mutation.destination_path);
  };
  const setup = async (levels = ["overwrite"]) => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), storage = provider(target);
    for (const level of levels) await enableWrite(target, level);
    return { target, client, storage };
  };
  const replace = (path, version, extra) => ({ operation: "replace", target_kind: "file", destination_path: path, destination_file_version: version, ...extra });
  const run = async (target, client, storage, mutation, staged = null) => {
    const job = await submitJob(target, client, mutation);
    return { job, result: await executor(target, storage, caller, async () => {}, staged).run(job.reference) };
  };
  // Binary replace: "normal use" on the connection, then one staged object through the staging RPC.
  const normalUse = async target => {
    await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile='normal' where id=$1", [target.connection]);
    const next = (await admin.query("select coalesce(max(read_generation),0)+1 n from clued_private.storage_read_access_v1 where connection_id=$1", [target.connection])).rows[0].n;
    await admin.query("update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1 and state='active'", [target.connection, target.receipt]);
    await admin.query(`insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id,content_profile)
      select $1,c.id,c.account_policy_id,'{read,read_content}',$3,'clued.storage-normal-use-disclosure/1',$4,'normal/1'
      from clued_private.storage_connections_v1 c where c.id=$2`, [user, target.connection, next, target.receipt]);
  };
  const staging = async (input, tokenHash = null) =>
    (await caller.query(`select ${STAGING}($1,$2,$3::jsonb) value`, [issuer, tokenHash, JSON.stringify(input)])).rows[0].value;
  const stage = async (client, target, path, bytes, mime = XLSX) => {
    const issued = await staging({ action: "begin", connection_id: target.connection, destination_path: path, mime_type: mime,
      size: bytes.length, content_sha256: sha(bytes), transport: "url" }, client.token);
    assert.equal(issued.state, "issued", JSON.stringify(issued));
    assert.equal((await staging({ action: "receive", staging_id: issued.staging_id, owner_id: issued.owner_id, connection_id: issued.connection_id,
      binding_id: issued.binding_id, sha256: issued.sha256, size: issued.size, mime_type: issued.mime_type, exp: issued.expires_at, key_id: "k1" })).state, "receiving");
    assert.equal((await staging({ action: "received", staging_id: issued.staging_id, outcome: "validating" })).state, "validating");
    assert.equal((await staging({ action: "validated", staging_id: issued.staging_id, outcome: "ready" })).state, "ready");
    return issued.staging_id;
  };
  const binaryReplace = (path, version, id, bytes, mime = XLSX) => replace(path, version, { mime_type: mime, content_sha256: sha(bytes), staging_id: id });
  // A registered .xlsx: created by Clued, then held in Drive as a spreadsheet with its own bytes.
  const createSheet = async (target, client, storage, name, bytes) => {
    const created = await createFile(target, client, storage, name, "placeholder\n");
    const file = storage.files.get(created.provider_file_id);
    const revision = storage.revisions.get(file.id).get(file.headRevisionId);
    revision.bytes = Buffer.from(bytes);
    Object.assign(file, { mimeType: XLSX, size: String(bytes.length), md5Checksum: md5(bytes), sha256Checksum: sha(bytes) });
    return created;
  };
  const sheet = text => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text)]);

  try {
    if (options.extra_cases) await options.extra_cases({ setup, createFile, cloud, submitJob, replace, executor, journal, artifact, pins,
      oauth_client_id: oauthClient, provider_subject: "replace-exec-subject", access_token: "fixture-replace-exec-access" });
    if (options.only_extra) return;
    await t.test("replace keeps the previous revision forever, uploads the new text and settles the same Artifact", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "notes.txt");
      const before = storage.files.get(created.provider_file_id), previous = before.headRevisionId;
      const { job, result } = await run(target, client, storage, replace(created.path, before.version, { content: "second version\n" }));
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.equal(storage.content(created.provider_file_id), "second version\n");
      assert.equal(storage.revisions.get(created.provider_file_id).get(previous).keepForever, true, "the previous content is kept");
      const after = await artifact(target, created.path);
      assert.equal(after.id, created.id); assert.equal(after.provider_file_version, storage.files.get(created.provider_file_id).version);
      assert.deepEqual(await pins(created.id), [{ revision_id: previous, state: "pinned", job_id: job.reference.job_id }]);
      assert.equal((await journal(job)).verified_result_v2.proof.contract, "clued.storage-replace-verified/1");
      assert.equal((await journal(job)).provider_attempt.contract, "clued.storage-replace-attempt/1");
    });

    await t.test("revert restores the kept content through a checked download, and keeps the replaced content too", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "revert.txt", "first draft\n");
      const first = await run(target, client, storage, replace(created.path, storage.files.get(created.provider_file_id).version, { content: "bad edit\n" }));
      assert.equal(first.result.status, "committed");
      const reverted = await run(target, client, storage, replace(created.path, storage.files.get(created.provider_file_id).version,
        { restore_job_id: first.job.reference.job_id }));
      assert.equal(reverted.result.status, "committed", JSON.stringify(reverted.result));
      assert.equal(storage.content(created.provider_file_id), "first draft\n");
      assert.equal((await pins(created.id)).length, 2, "the replaced content is kept as well, so the revert can be undone");
    });

    await t.test("at most 10 Clued pins stay; the oldest is released on Drive and in the registry", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "many.txt");
      for (let i = 0; i < 11; i++) {
        const { result } = await run(target, client, storage, replace(created.path, storage.files.get(created.provider_file_id).version, { content: `edit ${i}\n` }));
        assert.equal(result.status, "committed", `edit ${i}: ${JSON.stringify(result)}`);
      }
      const rows = await pins(created.id);
      assert.equal(rows.filter(r => r.state === "pinned").length, 10);
      assert.equal(rows[0].state, "released");
      assert.equal(storage.revisions.get(created.provider_file_id).get(rows[0].revision_id).keepForever, false);
      assert.equal(storage.revisions.get(created.provider_file_id).get(rows[1].revision_id).keepForever, true);
    });

    await t.test("a failed release does not fence the replace; the pin stays and is released by the next replace", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "release.txt");
      const version = () => storage.files.get(created.provider_file_id).version;
      for (let i = 0; i < 10; i++) assert.equal((await run(target, client, storage, replace(created.path, version(), { content: `edit ${i}\n` }))).result.status, "committed");
      storage.loseRelease = true;
      const lost = await run(target, client, storage, replace(created.path, version(), { content: "edit 10\n" }));
      assert.equal(lost.result.status, "committed", JSON.stringify(lost.result));
      let rows = await pins(created.id);
      assert.equal(rows.filter(r => r.state === "pinned").length, 11, "the unreleased pin stays pinned");
      assert.deepEqual((await journal(lost.job)).verified_result_v2.proof.released_revision_ids, []);
      storage.loseRelease = false;
      assert.equal((await run(target, client, storage, replace(created.path, version(), { content: "edit 11\n" }))).result.status, "committed");
      rows = await pins(created.id);
      assert.equal(rows.filter(r => r.state === "pinned").length, 10);
      assert.deepEqual(rows.slice(0, 2).map(r => r.state), ["released", "released"]);
      assert.equal(storage.revisions.get(created.provider_file_id).get(rows[0].revision_id).keepForever, false);
    });

    await t.test("a head the Owner already kept is recorded owner_kept, never released, and still restorable", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "owner-kept.txt", "owner kept this\n");
      const file = storage.files.get(created.provider_file_id), ownerKept = file.headRevisionId;
      storage.revisions.get(file.id).get(ownerKept).keepForever = true;
      const writes = storage.writes;
      const first = await run(target, client, storage, replace(created.path, file.version, { content: "agent edit\n" }));
      assert.equal(first.result.status, "committed", JSON.stringify(first.result));
      assert.equal(storage.writes - writes, 1, "only the upload: the kept head is not written again");
      assert.deepEqual((await pins(created.id)).map(r => [r.revision_id, r.state]), [[ownerKept, "owner_kept"]]);
      for (let i = 0; i < 10; i++) assert.equal((await run(target, client, storage, replace(created.path, storage.files.get(file.id).version, { content: `more ${i}\n` }))).result.status, "committed");
      const rows = await pins(created.id);
      assert.equal(rows[0].state, "owner_kept"); assert.equal(rows.filter(r => r.state === "pinned").length, 10);
      assert.equal(storage.revisions.get(file.id).get(ownerKept).keepForever, true, "Clued never releases the Owner's revision");
      const reverted = await run(target, client, storage, replace(created.path, storage.files.get(file.id).version, { restore_job_id: first.job.reference.job_id }));
      assert.equal(reverted.result.status, "committed", JSON.stringify(reverted.result));
      assert.equal(storage.content(file.id), "owner kept this\n");
    });

    await t.test("refusals with zero provider writes: stale version, keep limit, unknown restore, no overwrite level, bad shapes", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "guarded.txt");
      const version = storage.files.get(created.provider_file_id).version;
      const before = await counters();
      for (const [mutation, expected] of [
        [replace(created.path, String(Number(version) + 1), { content: "x" }), "deny"],
        [replace(created.path, version, { restore_job_id: randomUUID() }), "unavailable"],
      ]) {
        const { result } = await run(target, client, storage, mutation);
        assert.equal(result.status, expected, JSON.stringify(result));
      }
      storage.keptExtra = 200;
      assert.equal((await run(target, client, storage, replace(created.path, version, { content: "x" }))).result.status, "deny", "Drive's 200 kept revisions");
      storage.keptExtra = 0;
      const stored = storage.files.get(created.provider_file_id);
      stored.mimeType = "application/zip";
      assert.equal((await run(target, client, storage, replace(created.path, version, { content: "x" }))).result.status, "deny", "not a text file");
      stored.mimeType = "text/plain";
      assert.equal(storage.writes, 0, "no provider write happened");
      assert.equal((await counters()).intents, before.intents, "no durable reservation was made");
      const modifyOnly = await setup(["modify"]);
      await assert.rejects(caller.query(`select ${JOBS}($1,$2::jsonb)`, [modifyOnly.client.token, JSON.stringify({ action: "submit",
        connection_id: modifyOnly.target.connection, job_id: randomUUID(), mutation: replace(`${modifyOnly.target.root}/${TRACK}/a.txt`, "3", { content: "x" }) })]),
        /storage_policy_denied/, "modify does not include overwrite");
      for (const bad of [replace(created.path, version, { content: "x", restore_job_id: randomUUID() }), replace(created.path, version, {}),
        replace(created.path, "0", { content: "x" }), replace(created.path, version, { content: "x".repeat(1048577) }),
        { ...replace(created.path, version, { content: "x" }), source_path: created.path }, replace(created.path, version, { restore_job_id: "nope" })]) {
        await assert.rejects(caller.query(`select ${JOBS}($1,$2::jsonb)`, [client.token, JSON.stringify({ action: "submit",
          connection_id: target.connection, job_id: randomUUID(), mutation: bad })]), /storage_job_input_invalid/);
      }
    });

    await t.test("a binary replace uploads the staged bytes in place under the same Drive ID and Artifact, and revert restores them", async () => {
      const { target, client, storage } = await setup();
      await normalUse(target);
      const original = sheet("asset table, 3 rows"), updated = sheet("asset table, 19 rows");
      const created = await createSheet(target, client, storage, "assets.xlsx", original);
      const file = storage.files.get(created.provider_file_id), previous = file.headRevisionId;
      const id = await stage(client, target, created.path, updated);
      const { job, result } = await run(target, client, storage, binaryReplace(created.path, file.version, id, updated), () => updated);
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.deepEqual(storage.revisions.get(file.id).get(file.headRevisionId).bytes, updated);
      assert.equal(file.mimeType, XLSX, "the file keeps its type"); assert.equal(file.id, created.provider_file_id);
      assert.equal(storage.revisions.get(file.id).get(previous).keepForever, true, "the previous content is kept");
      const after = await artifact(target, created.path);
      assert.equal(after.id, created.id); assert.equal(after.provider_file_version, file.version);
      assert.deepEqual(await pins(created.id), [{ revision_id: previous, state: "pinned", job_id: job.reference.job_id }]);
      const row = await journal(job);
      assert.equal(row.verified_result_v2.proof.contract, "clued.storage-replace-verified/1");
      assert.deepEqual(row.provider_attempt.content_after, { size: String(updated.length), sha256: sha(updated) });
      assert.equal((await admin.query("select job_id from clued_private.storage_staging_v1 where id=$1", [id])).rows[0].job_id, job.reference.job_id);
      const reverted = await run(target, client, storage, replace(created.path, file.version, { restore_job_id: job.reference.job_id }));
      assert.equal(reverted.result.status, "committed", JSON.stringify(reverted.result));
      assert.deepEqual(storage.revisions.get(file.id).get(file.headRevisionId).bytes, original);
    });

    await t.test("binary replace refusals: no normal use, no overwrite level, another type, too large, bad shapes", async () => {
      const { target, client, storage } = await setup();
      const original = sheet("before"), updated = sheet("after");
      const created = await createSheet(target, client, storage, "guarded.xlsx", original);
      const file = storage.files.get(created.provider_file_id);
      const submitRaw = (c, tgt, mutation) => caller.query(`select ${JOBS}($1,$2::jsonb)`, [c.token, JSON.stringify({ action: "submit",
        connection_id: tgt.connection, job_id: randomUUID(), mutation })]);
      // Without normal use nothing can be staged.
      await assert.rejects(stage(client, target, created.path, updated), /storage_binary_upload_disabled/);
      await normalUse(target);
      const id = await stage(client, target, created.path, updated);
      for (const bad of [{ ...binaryReplace(created.path, file.version, id, updated), content: "x" },
        { ...binaryReplace(created.path, file.version, id, updated), restore_job_id: randomUUID() },
        binaryReplace(created.path, file.version, id, sheet("other bytes")),
        binaryReplace(created.path, file.version, id, updated, "application/pdf"),
        binaryReplace(created.path, "0", id, updated),
        binaryReplace(`${target.root}/${TRACK}/elsewhere.xlsx`, file.version, id, updated)]) {
        await assert.rejects(submitRaw(client, target, bad), /storage_job_input_invalid/, JSON.stringify(bad));
      }
      // Above 5 MiB the staged object is refused at submit.
      const large = Buffer.concat([sheet("large"), Buffer.alloc(5 * 1024 * 1024)]);
      const largeId = await stage(client, target, created.path, large);
      await assert.rejects(submitRaw(client, target, binaryReplace(created.path, file.version, largeId, large)), /storage_job_input_invalid/);
      // A Drive file of another type is never replaced by a staged spreadsheet: refused before any write.
      const writes = storage.writes;
      file.mimeType = "application/pdf";
      const other = await run(target, client, storage, binaryReplace(created.path, file.version, id, updated), () => updated);
      assert.equal(other.result.status, "deny", JSON.stringify(other.result));
      assert.equal(storage.writes, writes, "no provider write happened");
      file.mimeType = XLSX;
      // Staged bytes that differ from the reference are refused with no effect.
      const id2 = await stage(client, target, created.path, updated);
      const mismatch = await run(target, client, storage, binaryReplace(created.path, file.version, id2, updated), () => sheet("tampered"));
      assert.equal(mismatch.result.status, "deny", JSON.stringify(mismatch.result));
      assert.equal(mismatch.result.error_code, "STORAGE_CONTENT_STAGING_MISMATCH");
      assert.equal(storage.writes, writes, "no provider write happened");
      // Without the overwrite level a binary replace is refused at submit.
      const createOnly = await setup([]);
      await normalUse(createOnly.target);
      const sheet2 = await createSheet(createOnly.target, createOnly.client, createOnly.storage, "c.xlsx", original);
      const id3 = await stage(createOnly.client, createOnly.target, sheet2.path, updated);
      await assert.rejects(submitRaw(createOnly.client, createOnly.target,
        binaryReplace(sheet2.path, createOnly.storage.files.get(sheet2.provider_file_id).version, id3, updated)), /storage_policy_denied/);
    });

    await t.test("a lost upload reply stays fenced, then recovery settles it by reads only", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "lost.txt");
      storage.loseUpload = true;
      const { job, result } = await run(target, client, storage, replace(created.path, storage.files.get(created.provider_file_id).version, { content: "uploaded\n" }));
      assert.equal(result.status, "unreconciled");
      const row = await journal(job);
      assert.equal(row.state, "started");
      assert.equal((await artifact(target, created.path)).version, created.version, "no settlement without a verified proof");
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
        JSON.stringify({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "B".repeat(24) })]);
      await admin.query("update clued_private.resource_center_mutations_v1 set created_at=clock_timestamp()-interval '20 minutes' where id=$1", [row.id]);
      await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1", [row.provider_attempt_receipt_id]);
      const descriptor = (await caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "load", ...job.reference })])).rows[0].value;
      assert.equal(descriptor.attempt.contract, "clued.storage-replace-attempt/1");
      const writes = storage.writes;
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-replace-exec-access", scope: SCOPES }),
        fetch: async (url, init = {}) => { assert.equal(init.method ?? "GET", "GET"); return storage.fetch(url, init); } });
      const verify = createGoogleDriveReplacePostconditionVerifier({ managed_root: descriptor.profile.managed_root, root_folder_id: descriptor.root_folder_id,
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren, get_revision: metadata.getRevision,
        include_verified_proof: true });
      const a = descriptor.attempt;
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "replace", destination_path: a.destination_path,
          provider_file_id: a.provider_file_id, content_before: a.content_before, content_after: a.content_after,
          pinned_revision_id: a.pinned_revision_id, previously_kept: a.previously_kept, release_revision_ids: a.release_revision_ids,
          restore_job_id: a.restore_job_id } });
      const finish = { action: "finalize", intent_id: descriptor.intent_id, base_version: descriptor.version, request_sha256: descriptor.request_sha256,
        idempotency_key: `account-job:${job.reference.job_id}:finalize`, postcondition };
      const recorded = await cloud({ action: "verified_record", ...job.reference, credential_version: descriptor.credential_version, finish, proof });
      assert.equal(recorded.status, "verified", JSON.stringify(recorded));
      const settled = await cloud({ action: "settle_verified", ...job.reference, intent_id: descriptor.intent_id, base_version: descriptor.version,
        request_sha256: descriptor.request_sha256, verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
      assert.equal(settled.state, "committed", JSON.stringify(settled));
      assert.equal(storage.writes, writes, "recovery never writes");
      assert.equal((await pins(created.id)).length, 1);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
