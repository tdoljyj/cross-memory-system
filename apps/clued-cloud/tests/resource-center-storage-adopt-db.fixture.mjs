import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { googleDriveSharingDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const WRITE = "public.clued_storage_write_access_v1";
const DISCLOSURE = "clued.storage-modify-disclosure/1";
const FULL_SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly";
const NORMAL_SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly";
const TRACK = "20_P_产品与体验";
const FOLDER = "application/vnd.google-apps.folder";
const PRIVATE = { shared: false, permissionIds: ["owner-permission"] };
const SHARED = { shared: true, permissionIds: ["anyone-with-link", "owner-permission"] };
const OWNER_ONLY = [{ id: "owner-permission", type: "user", role: "owner" }];

// StorageFullCapability.v0.1 P7 (Decisions 746fd078, 6dc1cf20): adopt through
// the real cloud executor (verified-result mode) against disposable PostgreSQL
// and an in-memory Drive, then ordinary writes on the adopted items. Never
// Google, never a disk.
export async function testStorageAdopt(t, admin, server, user, decision) {
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `adopt-${randomUUID()}`, resource = "https://adopt.invalid/mcp";
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
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'adopt-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://adopt.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const adminCall = async input => (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
    JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
  const register = async input => {
    const result = await adminCall(input);
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/adopt-${suffix}/Clued_资料中心`, rootId = `ad-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `adopt/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `ad-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/" + TRACK, provider_file_id: `ad-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: [TRACK], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='adopt-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}',provider_scope_profile='full' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `ad-parent-${suffix}`, trackId: `ad-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `ad-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Adopt fixture", redirect_uri: "https://adopt.invalid/client-callback",
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
          c.source_decision_id,c.decision_version,'reviewed_transition','adopt-fixture/2',c.receipt_id
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, target.connection]);
      await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, target.receipt]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [target.connection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    return { ...target, policy };
  };
  const cloud = async (input, database = caller) => (await database.query(`select ${CLOUD}($1,$2::jsonb) value`, [issuer, JSON.stringify(input)])).rows[0].value;
  const counters = async () => (await admin.query(`select
    (select count(*)::int from clued_private.storage_jobs_v1) jobs,
    (select count(*)::int from clued_private.resource_center_mutations_v1) intents`)).rows[0];
  const journal = async job => (await admin.query("select m.* from clued_private.storage_jobs_v1 j join clued_private.resource_center_mutations_v1 m on m.id=j.intent_id where j.owner_id=$1 and j.job_id=$2", [user, job.reference.job_id])).rows[0];
  const provider = target => {
    const directory = (id, name, parent) => ({ id, name, parents: parent ? [parent] : [], version: "1", trashed: false, mimeType: FOLDER,
      ...structuredClone(PRIVATE), permissions: structuredClone(OWNER_ONLY), ownedByMe: true, isAppAuthorized: true,
      capabilities: { canTrash: true, canUntrash: true } });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, TRACK, target.rootId)]]);
    // A new folder inherits its parent's sharing, as in Drive (P6.2); newFolderSharing overrides it.
    const state = { patches: 0, losePatch: false, files, directory, newFolderSharing: null };
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-adopt-access");
      assert.equal(u.hostname, "www.googleapis.com");
      assert.notEqual(init.method, "DELETE");
      if (init.method === "PATCH") {
        state.patches++;
        const id = u.pathname.split("/").at(-1), file = files.get(id);
        const recorded = (await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1", [id])).rows[0].n;
        assert.equal(recorded, 1, "the exact attempt is durable before the update");
        const body = JSON.parse(init.body || "{}");
        if ("trashed" in body) {
          file.trashed = body.trashed; file.version = String(Number(file.version) + 1);
          return Response.json(file);
        }
        if (body.name) {
          file.name = body.name; file.version = String(Number(file.version) + 1);
          return Response.json(file);
        }
        assert.equal(init.body, "{}");
        assert.deepEqual(file.parents, [u.searchParams.get("removeParents")]);
        file.parents = [u.searchParams.get("addParents")];
        file.version = String(Number(file.version) + 3); // Drive may jump by more than one.
        // As Drive (P6 acceptance, Note 23d63403): moving a folder advances
        // the version of every item under it; their content stays the same.
        const under = item => { for (let p = item.parents[0]; p; p = files.get(p)?.parents[0]) if (p === id) return true; return false; };
        for (const item of files.values()) if (item.id !== id && item.parents.length && under(item)) item.version = String(Number(item.version) + 1);
        if (state.losePatch) throw new Error("synthetic lost provider response");
        return Response.json(file);
      }
      if (init.method === "POST") {
        const raw = init.body, match = /\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw), metadata = JSON.parse(match?.[0] ?? raw);
        const attempt = (await admin.query("select provider_attempt from clued_private.resource_center_mutations_v1 where id=$1", [metadata.appProperties.clued_intent_id])).rows[0].provider_attempt;
        const parent = files.get(metadata.parents?.[0]);
        const inherited = metadata.mimeType === FOLDER ? { ...structuredClone(state.newFolderSharing ?? { shared: parent.shared, permissionIds: parent.permissionIds }),
          permissions: structuredClone(parent.permissions) } : {};
        const created = { ...metadata, version: "1", trashed: false, size: attempt.size, sha256Checksum: attempt.sha256,
          md5Checksum: "f".repeat(32), headRevisionId: "rev-" + randomUUID(), ownedByMe: true, isAppAuthorized: true,
          capabilities: { canTrash: true, canUntrash: true },
          ...inherited };
        files.set(metadata.id, created);
        return Response.json(created);
      }
      assert.equal(init.method ?? "GET", "GET");
      if (u.pathname.endsWith("/generateIds")) return Response.json({ ids: ["cloud-object-" + randomUUID()] });
      const query = u.searchParams.get("q");
      if (query) {
        const all = !/trashed = false/.test(query);
        const parent = /'([^']+)' in parents/.exec(query)?.[1], name = /name = '([^']+)'/.exec(query)?.[1];
        return Response.json({ files: [...files.values()].filter(file => file.parents.includes(parent) && (all || !file.trashed) && (!name || name === file.name)), incompleteSearch: false });
      }
      const found = files.get(u.pathname.split("/").at(-1));
      return found ? Response.json(found) : new Response("", { status: 404 });
    };
    return state;
  };
  const executor = (target, storage, afterLoad = async () => {}, afterRpc = async () => {}) => {
    let loaded;
    return createResourceCenterCloudExecutor({ verified_result_mode: true,
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref });
        await afterLoad(loaded);
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-adopt-access", scope: storage.scope ?? FULL_SCOPES, expires_at_ms: Date.now() + 3600000 }),
      drive_fetch: storage.fetch,
      rpc: async input => {
        const { connection_id, job_id, action, ...body } = input;
        const result = await cloud({ connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
          ...(action === "finalize" ? { finish: { action, ...body } } : body) });
        await afterRpc(action, result);
        return result;
      },
    });
  };
  // As the Worker does after a refusal: store the fixed outcome in the Owner's job row.
  const report = async (job, result) => cloud({ action: "report", ...job.reference, credential_version: 1,
    outcome: { status: result.status === "deny" ? "denied" : "attention_required", ...(result.error_code ? { reason: { code: result.error_code } } : {}) } });
  const writeStatus = async target => (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "status", connection_id: target.connection })])).rows[0].value;
  const setLevel = async (target, classes, disclosure = DISCLOSURE) => {
    const status = await writeStatus(target);
    return (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: target.connection,
      classes, base_generation: status.policy_generation, disclosure_version: disclosure, idempotency_key: randomUUID() })])).rows[0].value;
  };
  const policyOf = async target => (await admin.query("select p.actions,p.disclosure_version from clued_private.storage_connections_v1 c join clued_private.storage_account_policies_v2 p on p.id=c.account_policy_id where c.id=$1", [target.connection])).rows[0];
  const submitRaw = (target, client, mutation, jobId = randomUUID()) => caller.query(`select ${JOBS}($1,$2::jsonb) value`,
    [client.token, JSON.stringify({ action: "submit", connection_id: target.connection, job_id: jobId, mutation })]);
  const submitJob = async (target, client, mutation, jobId = randomUUID()) => {
    const result = (await submitRaw(target, client, mutation, jobId)).rows[0].value;
    assert.equal(result.status, "queued", JSON.stringify(result));
    return { reference: { connection_id: target.connection, job_id: jobId }, mutation, result };
  };
  const artifact = async (target, path, state = "active") => (await admin.query(
    "select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2 and state=$3", [target.profile, path, state])).rows[0];
  const artifactById = async id => (await admin.query("select * from clued_private.resource_center_artifacts_v1 where id=$1", [id])).rows[0];
  const createFile = async (target, client, storage, path) => {
    const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: path, content: "adopt fixture" });
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifact(target, path);
  };
  const directoryIn = async (target, storage, name, parentPath = `${target.root}/${TRACK}`, parentId = target.trackId) => {
    const id = `ad-dir-${randomUUID()}`, path = `${parentPath}/${name}`;
    storage.files.set(id, storage.directory(id, name, parentId));
    await register({ action: "artifact_register", profile_id: target.profile, path, provider_file_id: id, provider_file_version: "1",
      target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    return artifact(target, path);
  };
  // Record a registered directory's sharing digest, as the directory probe does.
  const recordSharing = async (target, row) => register({ action: "artifact_update", profile_id: target.profile, artifact_id: row.id,
    base_version: Number(row.version), path: row.path, provider_file_id: row.provider_file_id, provider_file_version: row.provider_file_version,
    governance_class: row.governance_class, delete_authority: row.delete_authority, provider_sharing_digest: googleDriveSharingDigest(PRIVATE) });
  const setup = async (levels = ["modify", "destructive"]) => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), storage = provider(target);
    for (const level of levels) {
      const enabled = await setLevel(target, [...(await writeStatus(target)).classes, level],
        `clued.storage-${level}-disclosure/1`);
      assert.equal(enabled.status, "committed", JSON.stringify(enabled));
    }
    return { target, client, storage };
  };
  // An item the Owner put into Drive by hand: owned, not created by Clued.
  const manual = (storage, parentId, name, extra = {}) => {
    const id = `ad-manual-${randomUUID()}`;
    storage.files.set(id, { id, name, parents: [parentId], version: "7", trashed: false, mimeType: "text/plain", size: "5",
      sha256Checksum: "a".repeat(64), md5Checksum: "b".repeat(32), headRevisionId: "rev-manual", ownedByMe: true, isAppAuthorized: false,
      capabilities: { canTrash: true, canUntrash: true }, ...extra });
    return id;
  };
  const adopt = (path, id, kind = "file", extra = {}) => ({ operation: "adopt", target_kind: kind, source_path: path, source_file_id: id, ...extra });
  const inspect = async (target, client, job) => (await caller.query(`select ${JOBS}($1,$2::jsonb) value`,
    [client.token, JSON.stringify({ action: "inspect", ...job.reference })])).rows[0].value;
  const release = async () => (await caller.query("select public.clued_storage_release_unattempted_v1($1,$2::jsonb) value",
    [issuer, JSON.stringify({ action: "release" })])).rows[0].value;

  try {
    await t.test("adopt registers a file the Owner uploaded by hand, writes nothing, and the file can then be renamed and trashed", async () => {
      const { target, client, storage } = await setup();
      const folder = await directoryIn(target, storage, "uploads");
      const id = manual(storage, folder.provider_file_id, "manual.txt");
      const job = await submitJob(target, client, adopt(`${folder.path}/manual.txt`, id));
      const patches = storage.patches;
      const result = await executor(target, storage).run(job.reference);
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.equal(storage.patches, patches, "adopt writes nothing to Drive");
      const row = await artifact(target, `${folder.path}/manual.txt`);
      assert.equal(row.provider_file_id, id); assert.equal(row.provider_file_version, "7"); assert.equal(row.target_kind, "file");
      assert.equal(row.governance_class, "ordinary"); assert.equal(row.delete_authority, false); assert.equal(row.provider_sharing_digest, null);
      const m = await journal(job);
      assert.equal(m.state, "committed");
      assert.equal(m.provider_attempt.contract, "clued.storage-adopt-attempt/1");
      assert.equal(m.verified_result_v2.proof.contract, "clued.storage-adopt-verified/1");
      // §6.3: the settle Receipt names the observation the registration came from.
      const event = (await admin.query("select change_summary from public.clued_context_events where receipt_id=$1", [m.receipt_id])).rows[0].change_summary;
      assert.deepEqual(event.adopted, { observed_by: "clued.storage-adopt-verified/1", provider_file_id: id, provider_file_version: "7",
        path: row.path, provider_change: false });
      assert.equal((await inspect(target, client, job)).status, "committed");
      // Now an ordinary registered file: rename, then trash.
      const renamed = await submitJob(target, client, { operation: "rename", target_kind: "file", source_path: row.path,
        destination_path: `${folder.path}/renamed.txt`, source_file_version: "7" });
      assert.equal((await executor(target, storage).run(renamed.reference)).status, "committed");
      const moved = await artifact(target, `${folder.path}/renamed.txt`);
      assert.equal(moved.id, row.id); assert.equal(storage.files.get(id).name, "renamed.txt");
      const trash = await submitJob(target, client, { operation: "delete", target_kind: "file", source_path: moved.path,
        source_file_version: moved.provider_file_version, source_file_id: id });
      assert.equal((await executor(target, storage).run(trash.reference)).status, "committed");
      assert.equal((await artifact(target, moved.path, "trashed")).id, row.id); assert.equal(storage.files.get(id).trashed, true);
    });

    await t.test("a directory is adopted with its sharing digest only when shared like its folder, and Clued then writes into it", async () => {
      const { target, client, storage } = await setup();
      const folder = await directoryIn(target, storage, "uploads");
      await recordSharing(target, folder);
      const dirId = `ad-dir-${randomUUID()}`;
      storage.files.set(dirId, { ...storage.directory(dirId, "handmade", folder.provider_file_id), version: "3", isAppAuthorized: false });
      const job = await submitJob(target, client, adopt(`${folder.path}/handmade`, dirId, "directory"));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      const row = await artifact(target, `${folder.path}/handmade`);
      assert.equal(row.target_kind, "directory"); assert.equal(row.provider_sharing_digest, googleDriveSharingDigest(PRIVATE));
      // Its Drive version advances as children arrive; it is matched by sharing.
      await createFile(target, client, storage, `${row.path}/note.md`);
      storage.files.get(dirId).version = "9";
      await createFile(target, client, storage, `${row.path}/second.md`);
      // A folder shared differently from its folder is refused before any reservation.
      const sharedId = `ad-dir-${randomUUID()}`;
      storage.files.set(sharedId, { ...storage.directory(sharedId, "shared", folder.provider_file_id), ...structuredClone(SHARED), isAppAuthorized: false });
      const before = await counters();
      const differs = await submitJob(target, client, adopt(`${folder.path}/shared`, sharedId, "directory"));
      const refused = await executor(target, storage).run(differs.reference);
      assert.equal(refused.status, "deny"); assert.equal(refused.error_code, "DIRECTORY_SHARING_DIFFERS");
      assert.equal((await counters()).intents, before.intents);
      assert.equal(await artifact(target, `${folder.path}/shared`), undefined);
    });

    await t.test("submit refuses before any job: a registered path or Drive ID, a track, a non-full credential, no modify level, a bad shape", async () => {
      const { target, client, storage } = await setup();
      const folder = await directoryIn(target, storage, "uploads");
      const id = manual(storage, folder.provider_file_id, "manual.txt");
      const before = await counters();
      await assert.rejects(submitRaw(target, client, adopt(folder.path, folder.provider_file_id, "directory")), /adopt_already_registered/);
      await assert.rejects(submitRaw(target, client, adopt(`${folder.path}/other.txt`, folder.provider_file_id)), /adopt_already_registered/);
      await assert.rejects(submitRaw(target, client, adopt(`${target.root}/loose.txt`, id)), /storage_job_input_invalid/, "the root's own children are tracks");
      for (const bad of [{ ...adopt(`${folder.path}/manual.txt`, id), destination_path: `${folder.path}/x.txt` },
        { ...adopt(`${folder.path}/manual.txt`, id), source_file_version: "7" }, adopt(`${folder.path}/manual.txt`, "bad id"),
        adopt(`${folder.path}/manual.txt`, id, "link")]) {
        await assert.rejects(submitRaw(target, client, bad), /storage_job_input_invalid/, JSON.stringify(bad));
      }
      await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile='normal' where id=$1", [target.connection]);
      try { await assert.rejects(submitRaw(target, client, adopt(`${folder.path}/manual.txt`, id)), /adopt_scope_upgrade_required/); }
      finally { await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile='full' where id=$1", [target.connection]); }
      assert.deepEqual(await counters(), before);
      const noModify = await setup(["destructive"]);
      const other = await directoryIn(noModify.target, noModify.storage, "uploads");
      const otherId = manual(noModify.storage, other.provider_file_id, "manual.txt");
      await assert.rejects(submitRaw(noModify.target, noModify.client, adopt(`${other.path}/manual.txt`, otherId)), /storage_policy_denied/);
    });

    await t.test("execution refuses with no reservation: another owner, a shortcut, an unregistered folder, a non-full credential or a downgrade", async () => {
      const { target, client, storage } = await setup();
      const folder = await directoryIn(target, storage, "uploads");
      const run = async (mutation, change = () => {}) => {
        const before = await counters();
        const job = await submitJob(target, client, mutation);
        await change();
        const result = await executor(target, storage).run(job.reference);
        try { assert.equal((await counters()).intents, before.intents, "no reservation"); }
        finally { storage.scope = undefined; }
        return result;
      };
      const foreign = manual(storage, folder.provider_file_id, "foreign.txt", { ownedByMe: false });
      assert.equal((await run(adopt(`${folder.path}/foreign.txt`, foreign))).error_code, "PROVIDER_OWNER_REQUIRED");
      const shortcut = manual(storage, folder.provider_file_id, "link", { mimeType: "application/vnd.google-apps.shortcut" });
      assert.equal((await run(adopt(`${folder.path}/link`, shortcut))).error_code, "ADOPT_TARGET_UNSUPPORTED");
      const plain = manual(storage, folder.provider_file_id, "plain.txt");
      assert.equal((await run(adopt(`${folder.path}/plain.txt`, plain), () => { storage.scope = NORMAL_SCOPES; })).error_code,
        "ADOPT_SCOPE_UPGRADE_REQUIRED");
      // An unregistered folder: adopt it first (top-down).
      const handmade = `ad-dir-${randomUUID()}`;
      storage.files.set(handmade, { ...storage.directory(handmade, "handmade", folder.provider_file_id), isAppAuthorized: false });
      const inner = manual(storage, handmade, "inner.txt");
      const unregistered = await run(adopt(`${folder.path}/handmade/inner.txt`, inner));
      assert.notEqual(unregistered.status, "committed"); assert.equal(await artifact(target, `${folder.path}/handmade/inner.txt`), undefined);
      // The credential was downgraded after submit: the job no longer executes.
      const downgraded = await run(adopt(`${folder.path}/plain.txt`, plain), () => admin.query(
        "update clued_private.storage_connections_v1 set provider_scope_profile='normal' where id=$1", [target.connection]));
      await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile='full' where id=$1", [target.connection]);
      assert.equal(downgraded.status, "unavailable");
      assert.equal(await artifact(target, `${folder.path}/plain.txt`), undefined);
    });

    await t.test("without the full credential, changing an item Clued did not create is refused before it could fence the root", async () => {
      const { target, client, storage } = await setup();
      const folder = await directoryIn(target, storage, "uploads");
      const id = manual(storage, folder.provider_file_id, "legacy.txt");
      await register({ action: "artifact_register", profile_id: target.profile, path: `${folder.path}/legacy.txt`, provider_file_id: id,
        provider_file_version: "7", target_kind: "file", governance_class: "ordinary", delete_authority: false });
      const rename = { operation: "rename", target_kind: "file", source_path: `${folder.path}/legacy.txt`,
        destination_path: `${folder.path}/renamed.txt`, source_file_version: "7" };
      const before = await counters(), patches = storage.patches;
      storage.scope = NORMAL_SCOPES;
      let refused;
      try { refused = await executor(target, storage).run((await submitJob(target, client, rename)).reference); }
      finally { storage.scope = undefined; }
      assert.equal(refused.status, "deny"); assert.equal(refused.error_code, "SCOPE_UPGRADE_REQUIRED");
      assert.equal((await counters()).intents, before.intents); assert.equal(storage.patches, patches);
      // A file Clued created is still changed with the normal credential.
      const created = await createFile(target, client, storage, `${folder.path}/own.md`);
      storage.scope = NORMAL_SCOPES;
      try {
        const own = await submitJob(target, client, { operation: "rename", target_kind: "file", source_path: created.path,
          destination_path: `${folder.path}/own2.md`, source_file_version: created.provider_file_version });
        assert.equal((await executor(target, storage).run(own.reference)).status, "committed");
      } finally { storage.scope = undefined; }
      // With the full credential the hand-made file is changed too.
      assert.equal((await executor(target, storage).run((await submitJob(target, client, rename)).reference)).status, "committed");
    });

    await t.test("an adopt that never settles is released after its admission expired: nothing registered, the root writable again", async () => {
      const { target, client, storage } = await setup();
      const folder = await directoryIn(target, storage, "uploads");
      const id = manual(storage, folder.provider_file_id, "manual.txt");
      const job = await submitJob(target, client, adopt(`${folder.path}/manual.txt`, id));
      // The item changes between the recorded attempt and the verifier.
      const result = await executor(target, storage, async () => {}, async action => {
        if (action === "provider_attempt") storage.files.get(id).version = "8";
      }).run(job.reference);
      assert.equal(result.status, "unreconciled", JSON.stringify(result));
      const fenced = await journal(job);
      assert.equal(fenced.state, "started"); assert.ok(fenced.provider_attempt); assert.equal(fenced.verified_result_v2, null);
      const scheduled = (await caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "due" })])).rows[0].value;
      assert.equal(scheduled.jobs.some(entry => entry.job_id === job.reference.job_id), false, "scheduled recovery never loads an adopt");
      assert.equal((await release()).released, 0, "not before the admission expired");
      await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '2 minutes' where id=$1", [fenced.id]);
      assert.equal((await release()).released, 1);
      const released = await journal(job);
      assert.equal(released.state, "cancelled");
      assert.deepEqual(released.final_result, { outcome: "released_no_effect", reason_code: "ADOPT_NOT_SETTLED" });
      assert.equal((await inspect(target, client, job)).reason_code, "ADOPT_NOT_SETTLED");
      assert.equal(await artifact(target, `${folder.path}/manual.txt`), undefined);
      // The root is writable again: the same item is adopted by a new job.
      const again = await submitJob(target, client, adopt(`${folder.path}/manual.txt`, id));
      assert.equal((await executor(target, storage).run(again.reference)).status, "committed");
      assert.equal((await artifact(target, `${folder.path}/manual.txt`)).provider_file_version, "8");
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
