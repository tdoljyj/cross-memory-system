import { allowTestIssuerCredentials, issuerBusinessDefinition } from './issuer-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";
import { bodyBytes, bytesContentSource, parseMultipart, pngBytes, pdfBytes } from "./resource-center-storage-binary.fixture.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const STAGING = "public.clued_storage_staging_v1";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly";
const TRACK = "20_P_产品与体验";
const MiB = 1024 * 1024;

// StorageNormalUse.v0.1 N3: binary create through the staging row, the binary gate, the upload
// budget, submit / execution admission, the real cloud executor (verified-result mode) with an
// in-memory Drive, create-verified/3 settlement and GET-only recovery, against disposable
// PostgreSQL. Never Google, never R2 (the staged bytes are handed to the executor directly).
export async function testStorageBinaryUpload(t, admin, server, user, decision) {
  await allowTestIssuerCredentials(admin);
  const clients = [], session = randomUUID(), issuer = sha(randomUUID() + randomUUID()), clientIssuer = sha(randomUUID());
  const oauthClient = `binary-exec-${randomUUID()}`, resource = "https://binary-exec.invalid/mcp";
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
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'binary-exec-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://binary-exec.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/binary-exec-${suffix}/Clued_资料中心`, rootId = `bx-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `binary-exec/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `bx-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/" + TRACK, provider_file_id: `bx-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: [TRACK], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='binary-exec-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `bx-parent-${suffix}`, trackId: `bx-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `bx-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Binary upload fixture", redirect_uri: "https://binary-exec.invalid/client-callback",
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
    return { token, id: approved.binding_id };
  };
  const activate = async target => {
    const policy = randomUUID(); await admin.query("begin");
    try {
      await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
        scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
        select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
          c.source_decision_id,c.decision_version,'reviewed_transition','binary-exec-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  // "Normal use": read access {read, read_content} + normal/1 on a connection Google granted the normal set.
  const normalUse = async (target, { profile = "normal", content = "normal/1", classes = "{read,read_content}" } = {}) => {
    await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile=$2 where id=$1", [target.connection, profile]);
    const next = (await admin.query("select coalesce(max(read_generation),0)+1 n from clued_private.storage_read_access_v1 where connection_id=$1", [target.connection])).rows[0].n;
    await admin.query("update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1 and state='active'", [target.connection, target.receipt]);
    await admin.query(`insert into clued_private.storage_read_access_v1(owner_id,connection_id,account_policy_id,classes,read_generation,disclosure_version,consent_receipt_id,content_profile)
      values($1,$2,$3,$4,$5,'clued.storage-normal-use-disclosure/1',$6,$7)`, [user, target.connection, target.policy, classes, next, target.receipt, content]);
  };
  const gateOff = async target => admin.query("update clued_private.storage_read_access_v1 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1 and state='active'", [target.connection, target.receipt]);
  const setup = async ({ normal = true } = {}) => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial);
    if (normal) await normalUse(target);
    return { target, client, storage: provider(target) };
  };
  const staging = async (input, tokenHash = null, database = caller) =>
    (await database.query(`select ${STAGING}($1,$2,$3::jsonb) value`, [issuer, tokenHash, JSON.stringify(input)])).rows[0].value;
  const pathFor = (target, name) => `${target.root}/${TRACK}/${name}`;
  const beginInput = (target, bytes, name = "photo.png", mime = "image/png") => ({ action: "begin", connection_id: target.connection,
    destination_path: pathFor(target, name), mime_type: mime, size: bytes.length, content_sha256: sha(bytes), transport: "url" });
  const claimsOf = issued => ({ action: "receive", staging_id: issued.staging_id, owner_id: issued.owner_id, connection_id: issued.connection_id,
    binding_id: issued.binding_id, sha256: issued.sha256, size: issued.size, mime_type: issued.mime_type, exp: issued.expires_at, key_id: "k1" });
  const stage = async (target, client, bytes, name = "photo.png", mime = "image/png") => {
    const issued = await staging(beginInput(target, bytes, name, mime), client.token);
    assert.equal(issued.state, "issued");
    assert.equal((await staging(claimsOf(issued))).state, "receiving");
    assert.equal((await staging({ action: "received", staging_id: issued.staging_id, outcome: "validating" })).state, "validating");
    assert.equal((await staging({ action: "validated", staging_id: issued.staging_id, outcome: "ready" })).state, "ready");
    return issued.staging_id;
  };
  const binaryMutation = (target, id, bytes, name = "photo.png", mime = "image/png") => ({ operation: "create", target_kind: "file",
    destination_path: pathFor(target, name), mime_type: mime, content_sha256: sha(bytes), staging_id: id });
  const submitRaw = async (client, target, mutation, job = randomUUID()) =>
    (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "submit", connection_id: target.connection, job_id: job, mutation })])).rows[0].value;
  const row = async id => (await admin.query("select * from clued_private.storage_staging_v1 where id=$1", [id])).rows[0];
  const jobRow = async job => (await admin.query("select * from clued_private.storage_jobs_v1 where owner_id=$1 and job_id=$2", [user, job])).rows[0];
  const journal = async job => (await admin.query("select m.* from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.owner_id=$1 and j.job_id=$2", [user, job])).rows[0];
  const timeTravel = async (sql, params) => {
    await admin.query("begin"); await admin.query("set local session_replication_role = replica");
    try { await admin.query(sql, params); await admin.query("commit"); } catch (error) { await admin.query("rollback"); throw error; }
  };
  const cloud = async input => (await caller.query(`select ${CLOUD}($1,$2::jsonb) value`, [issuer, JSON.stringify(input)])).rows[0].value;

  // In-memory Drive: multipart and single-PUT resumable binary uploads, sha256Checksum from the bytes.
  function provider(target) {
    const directory = (id, name, parent) => ({ id, name, parents: parent ? [parent] : [], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, TRACK, target.rootId)]]);
    const state = { writes: 0, sessions: 0, files, bytes: new Map(), loseUpload: false, wrongChecksum: false };
    const createFile = (metadata, mime, bytes) => {
      const file = { ...metadata, mimeType: mime, version: "1", trashed: false, size: String(bytes.length),
        sha256Checksum: state.wrongChecksum ? "0".repeat(64) : sha(bytes) };
      files.set(metadata.id, file); state.bytes.set(metadata.id, Buffer.from(bytes));
      return file;
    };
    let pendingSession = null;
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-binary-exec-access");
      assert.equal(u.hostname, "www.googleapis.com");
      const method = init.method ?? "GET";
      if (method === "POST" || method === "PUT") {
        const recorded = (await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'contract'='clued.resource-center-provider-attempt/1' and provider_attempt->>'provider_file_id'=$1",
          [method === "PUT" ? pendingSession?.metadata.id : "any"])).rows[0].n;
        if (method === "PUT") assert.equal(recorded, 1, "the exact attempt is durable before the upload");
      }
      if (method === "POST" && u.searchParams.get("uploadType") === "multipart") {
        if (state.onUpload) await state.onUpload();
        state.writes++;
        const part = parseMultipart(await bodyBytes(init.body), new Headers(init.headers).get("content-type"));
        const file = createFile(part.metadata, part.mediaType, part.bytes);
        if (state.loseUpload) throw new Error("synthetic lost provider response");
        return Response.json(file);
      }
      if (method === "POST" && u.searchParams.get("uploadType") === "resumable") {
        state.sessions++;
        pendingSession = { metadata: JSON.parse(init.body), mime: new Headers(init.headers).get("x-upload-content-type") };
        return new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=FIXTURE" } });
      }
      if (method === "PUT") {
        if (state.onUpload) await state.onUpload();
        state.writes++;
        assert.equal(u.searchParams.get("upload_id"), "FIXTURE");
        const file = createFile(pendingSession.metadata, new Headers(init.headers).get("content-type"), await bodyBytes(init.body));
        if (state.loseUpload) throw new Error("synthetic lost provider response");
        return Response.json(file);
      }
      assert.equal(method, "GET");
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
  }
  const executor = (storage, staged) => {
    let loaded;
    return createResourceCenterCloudExecutor({ verified_result_mode: true,
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref });
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      load_staged_content: async ({ content_ref, staging: descriptor }) => {
        assert.equal(descriptor.key_id, "k1");
        assert.equal(descriptor.key_salt, (await row(content_ref.staging_id)).key_salt, "the descriptor carries the row's key_salt");
        // The executor contract: a content source it verifies before any reservation.
        return bytesContentSource(staged(content_ref), content_ref);
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-binary-exec-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
      drive_fetch: storage.fetch,
      rpc: async input => {
        const { connection_id, job_id, action, ...body } = input;
        return cloud({ connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
          ...(action === "finalize" ? { finish: { action, ...body } } : body) });
      },
    });
  };
  const run = async (target, client, storage, bytes, name, mime, staged = () => bytes) => {
    const id = await stage(target, client, bytes, name, mime);
    const job = randomUUID();
    const submitted = await submitRaw(client, target, binaryMutation(target, id, bytes, name, mime), job);
    assert.equal(submitted.status, "queued", JSON.stringify(submitted));
    return { id, job, result: await executor(storage, staged).run({ connection_id: target.connection, job_id: job }) };
  };
  const artifact = async (target, path) => (await admin.query("select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2 and state='active'", [target.profile, path])).rows[0];

  try {
    await t.test("binary gate at begin: create_file + read access normal/1 + provider_scope_profile normal; types bound to extension", async () => {
      const { target, client } = await setup({ normal: false });
      const bytes = pngBytes();
      await assert.rejects(staging(beginInput(target, bytes), client.token), /storage_binary_upload_disabled/, "no normal read access");
      await normalUse(target, { profile: "legacy" });
      await assert.rejects(staging(beginInput(target, bytes), client.token), /storage_binary_upload_disabled/, "legacy scope profile");
      await normalUse(target, { content: "text/1" });
      await assert.rejects(staging(beginInput(target, bytes), client.token), /storage_binary_upload_disabled/, "text/1 read access");
      await normalUse(target, { classes: "{read}" });
      await assert.rejects(staging(beginInput(target, bytes), client.token), /storage_binary_upload_disabled/, "read without read_content");
      await normalUse(target);
      const issued = await staging(beginInput(target, bytes), client.token);
      assert.equal(issued.state, "issued"); assert.equal(issued.binding_id, client.id);
      for (const [name, mime] of [["photo.jpg", "image/png"], ["page.html", "text/html"], ["logo.svg", "image/svg+xml"],
        ["m.docm", "application/vnd.ms-word.document.macroEnabled.12"], ["noext", "image/png"],
        ["old.doc", "application/msword"], ["old.xls", "application/vnd.ms-excel"], ["old.ppt", "application/vnd.ms-powerpoint"]]) {
        await assert.rejects(staging(beginInput(target, bytes, name, mime), client.token), /content_type_mismatch/, name);
      }
      await assert.rejects(staging({ ...beginInput(target, bytes), size: 20 * MiB + 1 }, client.token), /storage_staging_input_invalid/);
      await assert.rejects(staging(beginInput(target, bytes), sha(randomUUID())), /storage_policy_denied|storage_read_denied|denied/);
      // Server-only actions never take a Binding token, and begin always needs one.
      await assert.rejects(staging(beginInput(target, bytes)), /storage_staging_input_invalid/);
      await assert.rejects(staging({ action: "sweep" }, client.token), /storage_staging_input_invalid/);
    });

    await t.test("signed-URL claim: exact claims, single use, expiry and the gate re-evaluated for the row's Binding", async () => {
      const { target, client } = await setup();
      const bytes = pngBytes();
      const issued = await staging(beginInput(target, bytes), client.token);
      for (const forged of [{ size: bytes.length + 1 }, { sha256: "0".repeat(64) }, { binding_id: randomUUID() }, { exp: issued.expires_at + 60 }, { mime_type: "image/gif" }]) {
        await assert.rejects(staging({ ...claimsOf(issued), ...forged }), /upload_url_invalid/, JSON.stringify(forged));
      }
      assert.equal((await staging(claimsOf(issued))).state, "receiving");
      await assert.rejects(staging(claimsOf(issued)), /upload_url_used/);
      const late = await staging(beginInput(target, bytes), client.token);
      await timeTravel("update clued_private.storage_staging_v1 set expires_at=expires_at-interval '11 minutes' where id=$1", [late.staging_id]);
      await assert.rejects(staging({ ...claimsOf(late), exp: late.expires_at - 660 }), /staging_expired/);
      const gated = await staging(beginInput(target, bytes), client.token);
      await gateOff(target);
      await assert.rejects(staging(claimsOf(gated)), /storage_binary_upload_disabled/);
      assert.equal((await row(gated.staging_id)).state, "issued", "a refused claim does not use the URL");
    });

    await t.test("upload budget is reserved at URL issue per Binding; unused URLs release it, received bytes do not", async () => {
      const { target, client } = await setup();
      const input = { ...beginInput(target, pngBytes()), size: 20 * MiB };
      const issued = [];
      for (let i = 0; i < 12; i++) issued.push(await staging(input, client.token));
      await assert.rejects(staging(input, client.token), /storage_upload_budget_exhausted/, "12 x 20 MiB + 20 MiB > 256 MiB");
      assert.equal((await staging(claimsOf(issued[0]))).state, "receiving", "one URL received bytes");
      await timeTravel("update clued_private.storage_staging_v1 set expires_at=clock_timestamp()-interval '1 second' where id = any($1::uuid[])",
        [issued.map(x => x.staging_id)]);
      const swept = await staging({ action: "sweep" });
      assert.ok(swept.expired >= 11, "the 11 unused URLs (sweep is issuer-wide)");
      assert.equal((await row(issued[1].staging_id)).state, "expired"); assert.ok((await row(issued[1].staging_id)).released_at);
      assert.equal((await row(issued[0].staging_id)).released_at, null, "bytes arrived: not released");
      for (let i = 0; i < 11; i++) await staging(input, client.token);
      await assert.rejects(staging(input, client.token), /storage_upload_budget_exhausted/);
      // A reservation outside the rolling hour no longer counts.
      await timeTravel("update clued_private.storage_staging_v1 set created_at=created_at-interval '2 hours' where binding_id=$1", [client.id]);
      assert.equal((await staging(input, client.token)).state, "issued");
    });

    await t.test("submit consumes one ready row of the same Binding; stored job carries content_ref; replay and reuse", async () => {
      const { target, client } = await setup();
      const other = await bind(target);
      const bytes = pngBytes(3000);
      const issued = await staging(beginInput(target, bytes, "a.png"), client.token);
      await assert.rejects(submitRaw(client, target, binaryMutation(target, issued.staging_id, bytes, "a.png")), /staging_expired/, "not ready yet");
      const id = await stage(target, client, bytes, "b.png");
      await assert.rejects(submitRaw(client, target, binaryMutation(target, id, bytes, "c.png")), /storage_job_input_invalid/, "path differs");
      await assert.rejects(submitRaw(client, target, { ...binaryMutation(target, id, bytes, "b.png"), content_sha256: "0".repeat(64) }), /storage_job_input_invalid/);
      await assert.rejects(submitRaw(client, target, { ...binaryMutation(target, id, bytes, "b.png"), mime_type: "image/jpeg" }), /storage_job_input_invalid/);
      await assert.rejects(submitRaw(other, target, binaryMutation(target, id, bytes, "b.png")), /storage_job_input_invalid/, "another Binding");
      await assert.rejects(submitRaw(client, target, { operation: "create", target_kind: "file", destination_path: pathFor(target, "t.txt"), content: "x", mime_type: "text/plain" }), /storage_job_input_invalid/);
      await assert.rejects(submitRaw(client, target, { ...binaryMutation(target, id, bytes, "b.png"), content: "x" }), /storage_job_input_invalid/);
      const job = randomUUID();
      const mutation = binaryMutation(target, id, bytes, "b.png");
      const submitted = await submitRaw(client, target, mutation, job);
      assert.equal(submitted.status, "queued"); assert.equal(submitted.replayed, false);
      assert.deepEqual((await jobRow(job)).mutation, { operation: "create", target_kind: "file", destination_path: pathFor(target, "b.png"),
        content_ref: { staging_id: id, sha256: sha(bytes), size: 3000, mime_type: "image/png" } });
      const consumed = await row(id); assert.equal(consumed.state, "consumed"); assert.equal(consumed.job_id, job);
      assert.equal((await submitRaw(client, target, mutation, job)).replayed, true);
      await assert.rejects(submitRaw(client, target, mutation), /staging_expired/, "single use");
      const event = (await admin.query("select change_summary from public.clued_context_events where canonical_event_type='extension:storage:job_submitted' and change_summary->>'job_id'=$1", [job])).rows[0];
      assert.equal(event.change_summary.upload_bytes, 3000, "upload bytes are accounted in the submit event");
      // m2: a text create's submit event carries no upload_bytes key at all.
      const textJob = randomUUID();
      assert.equal((await submitRaw(client, target, { operation: "create", target_kind: "file", destination_path: pathFor(target, "t.txt"), content: "x" }, textJob)).status, "queued");
      const textEvent = (await admin.query("select change_summary from public.clued_context_events where canonical_event_type='extension:storage:job_submitted' and change_summary->>'job_id'=$1", [textJob])).rows[0];
      assert.equal(Object.hasOwn(textEvent.change_summary, "upload_bytes"), false);
      // The legacy v1 job path never accepts a staging reference.
      await assert.rejects(caller.query("select public.clued_storage_jobs_v1($1,$2::jsonb)", [client.token, JSON.stringify({ action: "submit",
        connection_id: target.connection, job_id: randomUUID(), mutation })]), /storage_job_input_invalid|denied|mode/);
      // Ready rows expire after one hour unsubmitted.
      const stale = await stage(target, client, bytes, "d.png");
      await timeTravel("update clued_private.storage_staging_v1 set ready_expires_at=clock_timestamp()-interval '1 second' where id=$1", [stale]);
      await assert.rejects(submitRaw(client, target, binaryMutation(target, stale, bytes, "d.png")), /staging_expired/);
      // The gate is rechecked at submit: a ready row cannot be submitted once normal use is off.
      const ready = await stage(target, client, bytes, "e.png");
      await gateOff(target);
      await assert.rejects(submitRaw(client, target, binaryMutation(target, ready, bytes, "e.png")), /storage_binary_upload_disabled/);
      assert.equal((await row(ready)).state, "ready");
    });

    await t.test("root-relative paths: canonicalized before the digest, relative == full, bad paths refused before any row", async () => {
      // Pure canonicalization on a Windows-style managed root with CJK names.
      const win = "G:/我的云端硬盘/Clued_资料中心";
      const canonical = async (root, path) => (await admin.query("select clued_private.storage_path_canonical_v1($1,$2) value", [root, path])).rows[0].value;
      assert.equal(await canonical(win, "90_待归类/x.md"), win + "/90_待归类/x.md");
      assert.equal(await canonical(win, win + "/90_待归类/x.md"), win + "/90_待归类/x.md", "the full path passes unchanged");
      assert.equal(await canonical(win, "笔记.md"), win + "/笔记.md");
      for (const bad of ["90_待归类/../x.md", "../x.md", "./x.md", "90_待归类/./x.md", "90_待归类//x.md", "90_待归类/", "90\\x.md", "a\tb.md", win, win + "/", win + "/../x.md", win + "//x.md"]) {
        await assert.rejects(canonical(win, bad), /storage_path_invalid/, bad);
      }
      for (const outside of ["G:/我的云端硬盘/Other/x.md", "g:/我的云端硬盘/Clued_资料中心/x.md", "G:/我的云端硬盘/Clued_资料中心_2/x.md", "/x.md", "\\x.md", "C:x.md", "https://drive.google.com/x"]) {
        await assert.rejects(canonical(win, outside), /storage_path_outside_root/, outside);
      }
      assert.equal((await admin.query("select clued_private.storage_mutation_paths_v1($1,$2,$3::jsonb) value", [sha("nobody"), randomUUID(),
        JSON.stringify({ destination_path: "a/b.md" })])).rows[0].value.destination_path, "a/b.md", "no root for an unknown connection: left for the policy to deny");

      const { target, client, storage } = await setup();
      const relative = `${TRACK}/相对路径.txt`, full = `${target.root}/${relative}`;
      // The root is resolved only for a live storage client Binding: a revoked token gets its
      // path back unchanged (the policy denies it), so path refusals cannot confirm a guessed root.
      const clientHash = (await admin.query("select token_hash from public.clued_agent_bindings where id=$1", [client.id])).rows[0].token_hash;
      // The column holds the verifier; an internal proof stands in for the client's token here.
      const pathsFor = async () => (await admin.query("select clued_private.storage_mutation_paths_v1(clued_private.credential_internal_proof_v1($1),$2,$3::jsonb) value",
        [clientHash, target.connection, JSON.stringify({ destination_path: relative })])).rows[0].value.destination_path;
      assert.equal(await pathsFor(), full, "a live storage client Binding resolves the root");
      await admin.query("update public.clued_agent_bindings set revoked_at=now() where id=$1", [client.id]);
      assert.equal(await pathsFor(), relative, "a revoked Binding resolves no root");
      await admin.query("update public.clued_agent_bindings set revoked_at=null where id=$1", [client.id]);
      // Drive alignment item 3 (Owner Decision f382c494): a new file the layout does not
      // allow where it was written is placed in 90_待归类 when that track is allowed.
      const placed = async m => (await admin.query("select clued_private.storage_mutation_paths_v1(clued_private.credential_internal_proof_v1($1),$2,$3::jsonb) value",
        [clientHash, target.connection, JSON.stringify(m)])).rows[0].value.destination_path;
      const file = destination_path => ({ operation: "create", target_kind: "file", destination_path });
      assert.equal(await placed(file("stray.md")), `${target.root}/stray.md`, "a profile without 90_待归类 places nothing");
      const profileOf = (await admin.query("select profile_id from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0].profile_id;
      const runtime = (await admin.query("select cloud_runtime from clued_private.resource_center_profiles_v1 where id=$1", [profileOf])).rows[0].cloud_runtime;
      await admin.query("update clued_private.resource_center_profiles_v1 set cloud_runtime=$2::jsonb where id=$1",
        [profileOf, JSON.stringify({ ...runtime, allowed_root_children: [...runtime.allowed_root_children, "90_待归类"] })]);
      try {
        for (const stray of ["stray.md", "Other/x/stray.md", `${target.root}/stray.md`])
          assert.equal(await placed(file(stray)), `${target.root}/90_待归类/stray.md`, stray);
        assert.equal(await placed({ ...file("stray.md"), operation: "write" }), `${target.root}/90_待归类/stray.md`);
        // Allowed places, directories, other operations and the navigation entry are unchanged.
        assert.equal(await placed(file(relative)), full);
        assert.equal(await placed({ operation: "create", target_kind: "directory", destination_path: "NewTop" }), `${target.root}/NewTop`);
        assert.equal(await placed({ operation: "rename", target_kind: "file", source_path: relative, destination_path: "stray.md" }), `${target.root}/stray.md`);
        assert.equal(await placed(file("00_从这里开始/x.md")), `${target.root}/00_从这里开始/x.md`);
        await assert.rejects(placed(file("/elsewhere/x.md")), /storage_path_outside_root/, "a path outside the root is still refused");
      } finally {
        await admin.query("update clued_private.resource_center_profiles_v1 set cloud_runtime=$2::jsonb where id=$1", [profileOf, JSON.stringify(runtime)]);
      }
      const text = path => ({ operation: "create", target_kind: "file", destination_path: path, content: "相对" });
      const job = randomUUID();
      const first = await submitRaw(client, target, text(relative), job);
      assert.equal(first.status, "queued", JSON.stringify(first)); assert.equal(first.replayed, false);
      assert.equal((await jobRow(job)).mutation.destination_path, full, "the stored job binds the full path");
      const again = await submitRaw(client, target, text(full), job);
      assert.equal(again.replayed, true, "the full path replays the relative submit");
      assert.equal(again.request_digest, first.request_digest, "relative and full give one digest");
      assert.equal((await submitRaw(client, target, text(relative), job)).replayed, true);
      await assert.rejects(submitRaw(client, target, text(`${TRACK}/other.txt`), job), /storage_job_identity_conflict/);

      const jobs = async () => (await admin.query("select count(*)::int n from clued_private.storage_jobs_v1 where owner_id=$1", [user])).rows[0].n;
      const receipts = async () => (await admin.query("select count(*)::int n from public.clued_audit_receipts where operation='storage_job_submit'")).rows[0].n;
      const before = [await jobs(), await receipts()];
      for (const [bad, code] of [[`${TRACK}/../x.txt`, /storage_path_invalid/], [`${TRACK}//x.txt`, /storage_path_invalid/], [`${TRACK}/x/`, /storage_path_invalid/],
        [target.root, /storage_path_invalid/], ["/elsewhere/Clued_资料中心/x.txt", /storage_path_outside_root/], ["G:/我的云端硬盘/x.txt", /storage_path_outside_root/]]) {
        const refusedJob = randomUUID();
        await assert.rejects(submitRaw(client, target, text(bad), refusedJob), code, bad);
        assert.equal(await jobRow(refusedJob), undefined, bad);
      }
      await assert.rejects(submitRaw(client, target, { operation: "rename", target_kind: "file", source_path: `${TRACK}/../a.txt`,
        destination_path: `${TRACK}/b.txt`, source_file_version: "1" }), /storage_path_invalid/, "source_path is canonicalized too");
      assert.deepEqual([await jobs(), await receipts()], before, "no job or receipt for a refused path");

      // Binary: upload_begin with a relative path stores and returns the full path; a relative
      // submit matches it; the real executor commits at the full path (the production failure).
      const bytes = pngBytes(2048);
      const stagingRows = async () => (await admin.query("select count(*)::int n from clued_private.storage_staging_v1 where connection_id=$1", [target.connection])).rows[0].n;
      const rowsBefore = await stagingRows();
      await assert.rejects(staging({ ...beginInput(target, bytes), destination_path: `${TRACK}/../photo.png` }, client.token), /storage_path_invalid/);
      await assert.rejects(staging({ ...beginInput(target, bytes), destination_path: "/elsewhere/photo.png" }, client.token), /storage_path_outside_root/);
      assert.equal(await stagingRows(), rowsBefore, "no staging row or reservation for a refused path");
      const issued = await staging({ ...beginInput(target, bytes), destination_path: `${TRACK}/图片.png` }, client.token);
      assert.equal(issued.destination_path, pathFor(target, "图片.png"));
      assert.equal((await staging(claimsOf(issued))).state, "receiving");
      assert.equal((await staging({ action: "received", staging_id: issued.staging_id, outcome: "validating" })).state, "validating");
      assert.equal((await staging({ action: "validated", staging_id: issued.staging_id, outcome: "ready" })).state, "ready");
      const binaryJob = randomUUID();
      const submitted = await submitRaw(client, target, { ...binaryMutation(target, issued.staging_id, bytes, "图片.png"), destination_path: `${TRACK}/图片.png` }, binaryJob);
      assert.equal(submitted.status, "queued", JSON.stringify(submitted));
      assert.equal((await jobRow(binaryJob)).mutation.destination_path, pathFor(target, "图片.png"));
      assert.equal((await submitRaw(client, target, binaryMutation(target, issued.staging_id, bytes, "图片.png"), binaryJob)).replayed, true);
      const result = await executor(storage, () => bytes).run({ connection_id: target.connection, job_id: binaryJob });
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.ok(await artifact(target, pathFor(target, "图片.png")));
    });

    await t.test("multipart binary create commits with a create-verified/3 proof and a deletable staging object", async () => {
      const { target, client, storage } = await setup();
      const bytes = pngBytes(64 * 1024 + 3);
      // BUG-20261008-002: the staging sweep runs while the effect uploads the staged object.
      let duringUpload = null;
      storage.onUpload = async () => { duringUpload = await staging({ action: "sweep" }); };
      const { id, job, result } = await run(target, client, storage, bytes, "photo.png", "image/png");
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.ok(duringUpload, "the sweep ran during the upload");
      assert.equal(duringUpload.delete.includes(id), false, "a started job's staged object is never deletable while it uploads");
      const created = await artifact(target, pathFor(target, "photo.png"));
      assert.ok(created);
      assert.equal(Buffer.compare(storage.bytes.get(created.provider_file_id), Buffer.from(bytes)), 0);
      assert.equal(storage.files.get(created.provider_file_id).mimeType, "image/png");
      assert.equal(storage.sessions, 0, "multipart, no resumable session");
      const proof = (await journal(job)).verified_result_v2.proof;
      assert.equal(proof.contract, "clued.storage-create-verified/3"); assert.equal(proof.mime_type, "image/png");
      assert.equal(proof.sha256, sha(bytes)); assert.equal(proof.size, String(bytes.length));
      assert.equal((await journal(job)).provider_attempt.size, String(bytes.length));
      const swept = await staging({ action: "sweep" });
      assert.ok(swept.delete.includes(id), "consumed and committed: the object may be deleted");
      assert.equal((await staging({ action: "object_deleted", staging_ids: [id] })).marked, 1);
      assert.ok((await row(id)).object_deleted_at);
      assert.equal((await staging({ action: "sweep" })).delete.includes(id), false);
    });

    await t.test("N4: an Owner upload budget change applies to the next upload_begin; policy, read access and a queued job are untouched", async () => {
      const { target, client, storage } = await setup();
      const bytes = pngBytes(2048);
      const queuedStaging = await stage(target, client, bytes, "queued.png");
      const job = randomUUID();
      assert.equal((await submitRaw(client, target, binaryMutation(target, queuedStaging, bytes, "queued.png"), job)).status, "queued");
      const governed = async () => (await admin.query(`select
          (select to_jsonb(c) from clued_private.storage_connections_v1 c where c.id=$1) connection,
          (select jsonb_agg(to_jsonb(p) order by p.id) from clued_private.storage_account_policies_v2 p where p.connection_id=$1) policies,
          (select jsonb_agg(to_jsonb(a) order by a.id) from clued_private.storage_read_access_v1 a where a.connection_id=$1) read_access,
          (select to_jsonb(j) from clued_private.storage_jobs_v1 j where j.owner_id=$2 and j.job_id=$3) job`, [target.connection, user, job])).rows[0];
      const before = await governed();
      const budget = async input => (await native.query("select public.clued_storage_budget_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
      const set = (base, upload) => budget({ action: "set", scope: "connection", connection_id: target.connection, base_generation: base,
        read_bytes_per_hour: 256 * MiB, upload_bytes_per_hour: upload, idempotency_key: randomUUID() });
      assert.equal((await set(0, 32 * MiB)).status, "committed");
      const input = { ...beginInput(target, pngBytes(), "big.png"), size: 20 * MiB };
      assert.equal((await staging(input, client.token)).state, "issued");
      await assert.rejects(staging(input, client.token), /storage_upload_budget_exhausted/, "2 KiB + 20 MiB + 20 MiB > 32 MiB");
      assert.equal((await set(1, 64 * MiB)).status, "committed");
      assert.equal((await staging(input, client.token)).state, "issued", "the raised budget applies to the very next begin");
      assert.deepEqual(await governed(), before, "connection, policy, read access and the queued job are unchanged");
      const result = await executor(storage, () => bytes).run({ connection_id: target.connection, job_id: job });
      assert.equal(result.status, "committed", "the queued job still executes");
      // Keep the owner's rolling-hour row and byte counts for later tests unchanged.
      await timeTravel("update clued_private.storage_staging_v1 set created_at=created_at-interval '2 hours' where binding_id=$1", [client.id]);
    });

    await t.test("above 5 MiB: one resumable session and one PUT, verified /3", async () => {
      const { target, client, storage } = await setup();
      const bytes = pdfBytes(5 * MiB + 7);
      const { result } = await run(target, client, storage, bytes, "report.pdf", "application/pdf");
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.equal(storage.sessions, 1); assert.equal(storage.writes, 1);
    });

    await t.test("refusals with zero provider writes: staged bytes mismatch, gate off after submit, 12 h cancel", async () => {
      const { target, client, storage } = await setup();
      const bytes = pngBytes(2048), tampered = Buffer.from(bytes); tampered[10] ^= 1;
      const mismatch = await run(target, client, storage, bytes, "m.png", "image/png", () => new Uint8Array(tampered));
      assert.equal(mismatch.result.status, "deny"); assert.equal(mismatch.result.error_code, "STORAGE_CONTENT_STAGING_MISMATCH");
      assert.equal((await jobRow(mismatch.job)).intent_id, null, "no reservation");
      const id = await stage(target, client, bytes, "g.png");
      const job = randomUUID();
      assert.equal((await submitRaw(client, target, binaryMutation(target, id, bytes, "g.png"), job)).status, "queued");
      await gateOff(target);
      const refused = await executor(storage, () => bytes).run({ connection_id: target.connection, job_id: job });
      assert.notEqual(refused.status, "committed");
      assert.equal((await jobRow(job)).intent_id, null);
      assert.equal(storage.writes, 0); assert.equal(storage.sessions, 0);
      await timeTravel("update clued_private.storage_jobs_v1 set created_at=created_at-interval '13 hours' where owner_id=$1 and job_id=$2", [user, job]);
      const swept = await staging({ action: "sweep" });
      assert.ok(swept.cancelled_jobs >= 1);
      assert.deepEqual((await jobRow(job)).dispatch_outcome, { status: "denied" });
      assert.ok(swept.delete.includes(id) || (await staging({ action: "sweep" })).delete.includes(id), "cancelled job's object is deletable");
    });

    await t.test("Drive checksum differing from the declared sha256 is never settled", async () => {
      const { target, client, storage } = await setup();
      storage.wrongChecksum = true;
      const { job, result } = await run(target, client, storage, pngBytes(4096), "bad.png", "image/png");
      assert.notEqual(result.status, "committed");
      const m = await journal(job);
      assert.ok(["started", "uncertain"].includes(m.state), m.state);
      assert.equal(m.verified_result_v2, null);
      assert.equal(await artifact(target, pathFor(target, "bad.png")), undefined);
    });

    await t.test("a lost resumable reply stays fenced; recovery settles it by reads only and never re-uploads", async () => {
      const { target, client, storage } = await setup();
      storage.loseUpload = true;
      const bytes = pngBytes(6 * MiB);
      const { id, job, result } = await run(target, client, storage, bytes, "lost.png", "image/png");
      assert.equal(result.status, "unreconciled", JSON.stringify(result));
      const m = await journal(job);
      assert.equal(m.state, "started");
      assert.equal((await staging({ action: "sweep" })).delete.includes(id), false, "an unsettled job keeps its staged object");
      const writes = storage.writes;
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
        JSON.stringify({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "B".repeat(24) })]);
      await admin.query("update clued_private.resource_center_mutations_v1 set created_at=clock_timestamp()-interval '20 minutes' where id=$1", [m.id]);
      await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1", [m.provider_attempt_receipt_id]);
      const reference = { connection_id: target.connection, job_id: job };
      const descriptor = (await caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "load", ...reference })])).rows[0].value;
      assert.equal(descriptor.status, "recovery_only", JSON.stringify(descriptor));
      assert.ok(descriptor.mutation.content_ref);
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-binary-exec-access", scope: SCOPES }),
        fetch: async (url, init = {}) => { assert.equal(init.method ?? "GET", "GET"); return storage.fetch(url, init); } });
      const verify = createGoogleDriveCreatePostconditionVerifier({ managed_root: descriptor.profile.managed_root, root_folder_id: descriptor.root_folder_id,
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren,
        require_effect_provider_id: true, include_verified_proof: true });
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "create", destination_path: descriptor.mutation.destination_path,
          provider_file_id: descriptor.attempt.provider_file_id } });
      assert.equal(proof.contract, "clued.storage-create-verified/3");
      const finish = { action: "finalize", intent_id: descriptor.intent_id, base_version: descriptor.version, request_sha256: descriptor.request_sha256,
        idempotency_key: `account-job:${job}:finalize`, postcondition };
      const recorded = await cloud({ action: "verified_record", ...reference, credential_version: descriptor.credential_version, finish, proof });
      assert.equal(recorded.status, "verified", JSON.stringify(recorded));
      const settled = await cloud({ action: "settle_verified", ...reference, intent_id: descriptor.intent_id, base_version: descriptor.version,
        request_sha256: descriptor.request_sha256, verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
      assert.equal(settled.state, "committed", JSON.stringify(settled));
      assert.equal(storage.writes, writes, "recovery never writes");
      assert.ok((await staging({ action: "sweep" })).delete.includes(id), "once settled, the staged object may be deleted");
    });

    await t.test("a create-verified/2 proof cannot settle a binary job", async () => {
      const { target, client, storage } = await setup();
      storage.loseUpload = true;
      const { job } = await run(target, client, storage, pngBytes(1000), "v2.png", "image/png");
      const m = await journal(job);
      const created = [...storage.files.values()].find(f => f.name === "v2.png");
      const post = { path: pathFor(target, "v2.png"), parent_id: target.trackId, provider_file_id: created.id, provider_file_version: created.version };
      const proof = { contract: "clued.storage-create-verified/2", ...post, target_kind: "file", size: "1000", sha256: m.provider_attempt.sha256,
        provider_before: m.authority_request.provider_identity, checks: { identity: true, content: true, ancestors: true, unique_name: true, stable_version: true } };
      await assert.rejects(cloud({ action: "verified_record", connection_id: target.connection, job_id: job, credential_version: 1,
        finish: { action: "finalize", intent_id: m.id, base_version: m.version, request_sha256: m.request_sha256, idempotency_key: `account-job:${job}:finalize`, postcondition: post },
        proof }), /storage_verified_mismatch/);
    });

    await t.test("staging rows are immutable except their lifecycle; stalled uploads are rejected by the sweep", async () => {
      const { target, client } = await setup();
      const bytes = pngBytes();
      const issued = await staging(beginInput(target, bytes), client.token);
      await assert.rejects(admin.query("update clued_private.storage_staging_v1 set size=size+1 where id=$1", [issued.staging_id]), /storage_staging_immutable/);
      await assert.rejects(admin.query("update clued_private.storage_staging_v1 set state='ready' where id=$1", [issued.staging_id]), /storage_staging_immutable|check/);
      await assert.rejects(admin.query("delete from clued_private.storage_staging_v1 where id=$1", [issued.staging_id]), /storage_staging_immutable/);
      await staging(claimsOf(issued));
      // m5: 31 minutes is a slow upload, not a stalled one; the window is 2 hours.
      await timeTravel("update clued_private.storage_staging_v1 set received_at=clock_timestamp()-interval '31 minutes' where id=$1", [issued.staging_id]);
      await staging({ action: "sweep" });
      assert.equal((await row(issued.staging_id)).state, "receiving");
      await timeTravel("update clued_private.storage_staging_v1 set received_at=clock_timestamp()-interval '121 minutes' where id=$1", [issued.staging_id]);
      const swept = await staging({ action: "sweep" });
      assert.ok(swept.stalled >= 1);
      const stalled = await row(issued.staging_id);
      assert.equal(stalled.state, "rejected"); assert.equal(stalled.reject_reason, "stalled"); assert.equal(stalled.released_at, null);
      assert.ok(swept.delete.includes(issued.staging_id));
      await assert.rejects(staging({ action: "received", staging_id: issued.staging_id, outcome: "validating" }), /storage_staging_state_conflict/);
    });

    await t.test("inline begin is retry-safe: the job_id derives one row per Binding, replay never re-reserves", async () => {
      const { target, client } = await setup();
      const bytes = pngBytes(1500), job = randomUUID();
      const inline = { ...beginInput(target, bytes, "i.png"), transport: "inline", job_id: job };
      const first = await staging(inline, client.token);
      assert.equal(first.state, "issued");
      const again = await staging(inline, client.token);
      assert.equal(again.staging_id, first.staging_id); assert.equal(again.state, "issued");
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_staging_v1 where binding_id=$1", [client.id])).rows[0].n, 1);
      assert.equal((await staging(claimsOf(first))).state, "receiving");
      await staging({ action: "received", staging_id: first.staging_id, outcome: "validating" });
      await staging({ action: "validated", staging_id: first.staging_id, outcome: "ready" });
      assert.equal((await staging(inline, client.token)).state, "ready");
      const mutation = binaryMutation(target, first.staging_id, bytes, "i.png");
      assert.equal((await submitRaw(client, target, mutation, job)).status, "queued");
      assert.equal((await staging(inline, client.token)).state, "consumed", "a retry after the submit sees the consumed row");
      assert.equal((await submitRaw(client, target, mutation, job)).replayed, true, "and the submit replays the same job");
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_staging_v1 where binding_id=$1", [client.id])).rows[0].n, 1, "no orphan rows");
      // Other content under the same job_id is refused; once the job exists another Binding cannot
      // stage under its job_id either, while for a job not yet submitted each Binding gets its own row.
      const other = pngBytes(1501);
      await assert.rejects(staging({ ...inline, size: other.length, content_sha256: sha(other) }, client.token), /storage_job_input_invalid/);
      const second = await bind(target);
      await assert.rejects(staging(inline, second.token), /storage_job_input_invalid/);
      const fresh = { ...inline, job_id: randomUUID() };
      assert.notEqual((await staging(fresh, second.token)).staging_id, (await staging(fresh, client.token)).staging_id);
      // Shape: inline requires job_id, URL begin refuses it.
      await assert.rejects(staging({ ...beginInput(target, bytes), job_id: job }, client.token), /storage_staging_input_invalid/);
      await assert.rejects(staging({ ...beginInput(target, bytes), transport: "inline" }, client.token), /storage_staging_input_invalid/);
    });

    await t.test("inline staging_id is never staged twice: after the row is purged a retry of the job is refused; key_salt is per row", async () => {
      const { target, client } = await setup();
      const bytes = pngBytes(1600), job = randomUUID();
      const inline = { ...beginInput(target, bytes, "k.png"), transport: "inline", job_id: job };
      const first = await staging(inline, client.token);
      const received = await staging(claimsOf(first));
      const stored = await row(first.staging_id);
      assert.match(stored.key_salt, /^[0-9a-f]{32}$/);
      assert.equal(received.key_salt, stored.key_salt, "receive hands the Worker the row's key_salt");
      await assert.rejects(admin.query("update clued_private.storage_staging_v1 set key_salt=$2 where id=$1", [first.staging_id, "0".repeat(32)]),
        /storage_staging_immutable/);
      const otherRow = await staging(beginInput(target, bytes, "k2.png"), client.token);
      assert.notEqual((await row(otherRow.staging_id)).key_salt, stored.key_salt);
      await staging({ action: "received", staging_id: first.staging_id, outcome: "validating" });
      await staging({ action: "validated", staging_id: first.staging_id, outcome: "ready" });
      assert.equal((await submitRaw(client, target, binaryMutation(target, first.staging_id, bytes, "k.png"), job)).status, "queued");
      // Simulate the 7-day retention purge of the row (its object gone), then retry the same job.
      await timeTravel("delete from clued_private.storage_staging_v1 where id=$1", [first.staging_id]);
      assert.equal(await row(first.staging_id), undefined);
      const before = (await admin.query("select count(*)::int n from clued_private.storage_staging_v1 where binding_id=$1", [client.id])).rows[0].n;
      await assert.rejects(staging(inline, client.token), /storage_job_input_invalid/, "a purged inline staging_id is never re-staged");
      assert.equal(await row(first.staging_id), undefined, "no row, no reservation for the refused retry");
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_staging_v1 where binding_id=$1", [client.id])).rows[0].n, before);
    });

    await t.test("staging rows per rolling hour are capped per Binding, released rows included", async () => {
      const { target, client } = await setup();
      const input = beginInput(target, pngBytes(10), "c.png");
      for (let i = 0; i < 60; i++) await staging(input, client.token);
      await assert.rejects(staging(input, client.token), /storage_upload_budget_exhausted/);
      await timeTravel("update clued_private.storage_staging_v1 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [client.id]);
      await staging({ action: "sweep" });
      assert.ok((await admin.query("select bool_and(released_at is not null) v from clued_private.storage_staging_v1 where binding_id=$1", [client.id])).rows[0].v);
      await assert.rejects(staging(input, client.token), /storage_upload_budget_exhausted/, "released rows still count toward the row cap");
      await timeTravel("update clued_private.storage_staging_v1 set created_at=created_at-interval '2 hours' where binding_id=$1", [client.id]);
      assert.equal((await staging(input, client.token)).state, "issued");
    });

    await t.test("retention: terminal rows whose object is gone are purged after 7 days; nothing else can be deleted", async () => {
      const { target, client } = await setup();
      const bytes = pngBytes();
      const unused = await staging(beginInput(target, bytes, "p1.png"), client.token);
      const rejected = await staging(beginInput(target, bytes, "p2.png"), client.token);
      await staging(claimsOf(rejected));
      await staging({ action: "received", staging_id: rejected.staging_id, outcome: "rejected", reason: "digest_mismatch" });
      await timeTravel("update clued_private.storage_staging_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [unused.staging_id]);
      await staging({ action: "sweep" });
      assert.equal((await row(unused.staging_id)).state, "expired");
      await assert.rejects(admin.query("delete from clued_private.storage_staging_v1 where id=$1", [unused.staging_id]), /storage_staging_immutable/, "too young");
      await timeTravel("update clued_private.storage_staging_v1 set created_at=created_at-interval '8 days' where id = any($1::uuid[])",
        [[unused.staging_id, rejected.staging_id]]);
      let swept = await staging({ action: "sweep" });
      assert.equal(await row(unused.staging_id), undefined, "expired without bytes: purged");
      assert.ok(await row(rejected.staging_id), "rejected with its object still in R2: kept");
      assert.ok(swept.delete.includes(rejected.staging_id));
      await assert.rejects(admin.query("delete from clued_private.storage_staging_v1 where id=$1", [rejected.staging_id]), /storage_staging_immutable/);
      await staging({ action: "object_deleted", staging_ids: [rejected.staging_id] });
      swept = await staging({ action: "sweep" });
      assert.ok(swept.purged >= 1);
      assert.equal(await row(rejected.staging_id), undefined);
      // A live row is never purgeable, however old.
      const live = await staging(beginInput(target, bytes, "p3.png"), client.token);
      await staging(claimsOf(live));
      await timeTravel("update clued_private.storage_staging_v1 set created_at=created_at-interval '8 days' where id=$1", [live.staging_id]);
      await staging({ action: "sweep" });
      assert.equal((await row(live.staging_id)).state, "receiving");
      await assert.rejects(admin.query("delete from clued_private.storage_staging_v1 where id=$1", [live.staging_id]), /storage_staging_immutable/);
    });

    await t.test("the sweep skips staging rows a concurrent transaction holds instead of waiting on them", async () => {
      const { target, client } = await setup();
      const issued = await staging(beginInput(target, pngBytes(), "lock.png"), client.token);
      await timeTravel("update clued_private.storage_staging_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [issued.staging_id]);
      const holder = await connect(null);
      await holder.query("begin");
      try {
        await holder.query("select 1 from clued_private.storage_staging_v1 where id=$1 for update", [issued.staging_id]);
        await caller.query("set statement_timeout='3s'");
        const swept = await staging({ action: "sweep" });
        assert.equal(swept.status, "ok");
        assert.equal((await row(issued.staging_id)).state, "issued", "locked row left for the next sweep");
      } finally { await holder.query("rollback"); await caller.query("set statement_timeout='10s'"); }
      await staging({ action: "sweep" });
      assert.equal((await row(issued.staging_id)).state, "expired");
    });

    await t.test("no live size / sha256 derivation reads mutation.content without a content_ref guard", async () => {
      // Follow the exact private semantic wrapper to the existing two business
      // implementations. Every live layer remains subject to the content guard.
      let dispatcher = await issuerBusinessDefinition(admin,"clued_private.storage_verified_result_v2(text,jsonb)");
      const semanticPrevious = "clued_private.storage_semantic_verified_previous_v1(text,jsonb)";
      if ((await admin.query("select to_regprocedure($1) oid", [semanticPrevious])).rows[0].oid) {
        assert.match(dispatcher, /clued_private\.storage_semantic_verified_previous_v1\(p_issuer_identity,p_input-'semantic_observation'\)/);
        assert.doesNotMatch(dispatcher, /j\.mutation->>'content'/, "the semantic wrapper derives no inline-content digest or size");
        for (const role of ["anon", "authenticated", "service_role", "clued_worker_gateway"]) {
          assert.equal((await admin.query("select has_function_privilege($1,$2,'execute') permitted", [role, semanticPrevious])).rows[0].permitted, false);
        }
        dispatcher = (await admin.query("select pg_get_functiondef($1::regprocedure) body", [semanticPrevious])).rows[0].body;
      }
      assert.match(dispatcher, /return clued_private\.storage_conflict_verified_v1\(p_issuer_identity,p_input\);/);
      assert.match(dispatcher, /return clued_private\.storage_verified_before_conflict_v1\(p_issuer_identity,p_input\);/);
      assert.doesNotMatch(dispatcher, /j\.mutation->>'content'/, "the router derives no inline-content digest or size");
      const implementations = [
        ["clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)",
          await issuerBusinessDefinition(admin,"clued_private.storage_job_provider_attempt_v2(uuid,uuid,text,jsonb)")],
      ];
      for (const signature of ["clued_private.storage_verified_before_conflict_v1(text,jsonb)", "clued_private.storage_conflict_verified_v1(text,jsonb)"]) {
        implementations.push([signature,(await admin.query("select pg_get_functiondef($1::regprocedure) body",[signature])).rows[0].body]);
      }
      for (const [signature,body] of implementations) {
        const uses = [...body.matchAll(/(octet_length\(j\.mutation->>'content'\)|convert_to\(j\.mutation->>'content')/g)];
        assert.ok(uses.length >= 2, signature);
        for (const use of uses) {
          const caseStart = body.lastIndexOf("case when", use.index);
          assert.match(body.slice(caseStart, use.index), /j\.mutation \? 'content_ref' then/, `${signature} at ${use.index}`);
        }
      }
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
