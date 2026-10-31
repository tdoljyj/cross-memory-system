import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveDirectoryMovePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-directory-move-postcondition.mjs";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const WRITE = "public.clued_storage_write_access_v1";
const DISCLOSURE = "clued.storage-subtree-disclosure/1";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const TRACK = "20_P_产品与体验";
const FOLDER = "application/vnd.google-apps.folder";
const PRIVATE = { shared: false, permissionIds: ["owner-permission"] };
const SHARED = { shared: true, permissionIds: ["anyone-with-link", "owner-permission"] };
const OWNER_ONLY = [{ id: "owner-permission", type: "user", role: "owner" }];

// StorageFullCapability.v0.1 P6: a directory move through the real cloud
// executor (verified-result mode) against disposable PostgreSQL and an
// in-memory Drive. Never Google, never a disk.
export async function testStorageDirectoryMove(t, admin, server, user, decision) {
  await allowTestIssuerCredentials(admin);
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `subtree-${randomUUID()}`, resource = "https://subtree.invalid/mcp";
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
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'subtree-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://subtree.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const adminCall = async input => (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
    JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
  const register = async input => {
    const result = await adminCall(input);
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/subtree-${suffix}/Clued_资料中心`, rootId = `st-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `subtree/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `st-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/" + TRACK, provider_file_id: `st-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: [TRACK], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='subtree-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `st-parent-${suffix}`, trackId: `st-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `st-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Subtree fixture", redirect_uri: "https://subtree.invalid/client-callback",
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
          c.source_decision_id,c.decision_version,'reviewed_transition','subtree-fixture/2',c.receipt_id
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
      ...structuredClone(PRIVATE), permissions: structuredClone(OWNER_ONLY), ownedByMe: true, capabilities: { canTrash: true, canUntrash: true } });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, TRACK, target.rootId)]]);
    // A new folder inherits its parent's sharing, as in Drive (P6.2); newFolderSharing overrides it.
    const state = { patches: 0, losePatch: false, files, directory, newFolderSharing: null };
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-subtree-access");
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
          md5Checksum: "f".repeat(32), headRevisionId: "rev-" + randomUUID(), ownedByMe: true, capabilities: { canTrash: true, canUntrash: true },
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
  const executor = (target, storage, afterLoad = async () => {}) => {
    let loaded;
    return createResourceCenterCloudExecutor({ verified_result_mode: true,
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref });
        await afterLoad(loaded);
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-subtree-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
      drive_fetch: storage.fetch,
      rpc: async input => {
        const { connection_id, job_id, action, ...body } = input;
        return cloud({ connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
          ...(action === "finalize" ? { finish: { action, ...body } } : body) });
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
    const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: path, content: "subtree fixture" });
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifact(target, path);
  };
  const directoryIn = async (target, storage, name, parentPath = `${target.root}/${TRACK}`, parentId = target.trackId) => {
    const id = `st-dir-${randomUUID()}`, path = `${parentPath}/${name}`;
    storage.files.set(id, storage.directory(id, name, parentId));
    await register({ action: "artifact_register", profile_id: target.profile, path, provider_file_id: id, provider_file_version: "1",
      target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    return artifact(target, path);
  };
  // Record a registered directory's sharing digest, as the directory probe does.
  const recordSharing = async (target, row) => register({ action: "artifact_update", profile_id: target.profile, artifact_id: row.id,
    base_version: Number(row.version), path: row.path, provider_file_id: row.provider_file_id, provider_file_version: row.provider_file_version,
    governance_class: row.governance_class, delete_authority: row.delete_authority, provider_sharing_digest: googleDriveSharingDigest(PRIVATE) });
  const setup = async (levels = ["modify_subtree", "destructive"]) => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), storage = provider(target);
    for (const level of levels) {
      const enabled = await setLevel(target, [...(await writeStatus(target)).classes, level],
        level === "modify_subtree" ? DISCLOSURE : `clued.storage-${level}-disclosure/1`);
      assert.equal(enabled.status, "committed", JSON.stringify(enabled));
    }
    return { target, client, storage };
  };
  // A registered directory "folder" with a file, a nested directory and a
  // nested file, all created through Clued; and a registered destination.
  const tree = async () => {
    const { target, client, storage } = await setup();
    const trackPath = `${target.root}/${TRACK}`;
    const topic = await directoryIn(target, storage, "topic");
    const folder = await directoryIn(target, storage, "folder");
    const inner = await directoryIn(target, storage, "inner", folder.path, folder.provider_file_id);
    const note = await createFile(target, client, storage, `${folder.path}/note.md`);
    const deep = await createFile(target, client, storage, `${inner.path}/deep.md`);
    // Children changed the folder's Drive version; its sharing is registered.
    storage.files.get(folder.provider_file_id).version = "5";
    await recordSharing(target, folder);
    return { target, client, storage, trackPath, topic, folder: await artifactById(folder.id), inner, note, deep };
  };
  const move = (row, destination, version = "5", extra = {}) => ({ operation: "move", target_kind: "directory", source_path: row.path,
    destination_path: destination, source_file_version: version, source_file_id: row.provider_file_id, ...extra });

  try {
    await t.test("the modify_subtree level has its own disclosure, a canonical action order and replaces the policy", async () => {
      const initial = await createRoot(), target = await activate(initial);
      const status = await writeStatus(target);
      assert.equal(status.subtree_disclosure_version, DISCLOSURE); assert.deepEqual(status.classes, []);
      await assert.rejects(setLevel(target, ["modify_subtree"], "clued.storage-modify-disclosure/1"), /storage_write_disclosure_changed/);
      assert.equal((await setLevel(target, ["modify_subtree"])).status, "committed");
      assert.deepEqual((await policyOf(target)).actions, ["inspect", "create_file", "create_topic", "modify_subtree"]);
      assert.equal((await policyOf(target)).disclosure_version, DISCLOSURE);
      for (const [level, disclosure] of [["destructive", "clued.storage-destructive-disclosure/1"], ["modify", "clued.storage-modify-disclosure/1"],
        ["overwrite", "clued.storage-overwrite-disclosure/1"]]) {
        assert.equal((await setLevel(target, [...(await writeStatus(target)).classes, level], disclosure)).status, "committed");
      }
      assert.deepEqual((await policyOf(target)).actions, ["inspect", "create_file", "create_topic", "modify", "overwrite", "destructive", "modify_subtree"]);
      assert.deepEqual((await writeStatus(target)).classes, ["destructive", "modify", "modify_subtree", "overwrite"]);
      assert.equal((await setLevel(target, ["destructive", "modify", "overwrite"])).status, "committed");
      const stopped = await policyOf(target);
      assert.deepEqual(stopped.actions, ["inspect", "create_file", "create_topic", "modify", "overwrite", "destructive"]);
      assert.equal(stopped.disclosure_version, "clued.storage-modify_subtree-disabled/1");
      const valid = async actions => (await admin.query("select clued_private.storage_write_actions_v1($1::text[]) value", [actions])).rows[0].value;
      assert.equal(await valid(["inspect", "create_file", "create_topic", "modify_subtree"]), true);
      for (const bad of [["inspect", "create_file", "create_topic", "modify_subtree", "modify"], ["inspect", "create_file", "create_topic", "modify", "modify"],
        ["inspect", "create_file", "create_topic", "admin"], ["create_file", "inspect", "create_topic"]]) assert.equal(await valid(bad), false, bad.join());
    });

    await t.test("a directory move needs the modify_subtree level; modify alone is not enough", async () => {
      const { target, client, storage } = await setup(["modify"]);
      const folder = await directoryIn(target, storage, "folder"), topic = await directoryIn(target, storage, "topic");
      const before = await counters();
      await assert.rejects(submitRaw(target, client, move(folder, `${topic.path}/folder`, "1")), /storage_policy_denied/);
      assert.deepEqual(await counters(), before);
    });

    await t.test("a directory moves with its whole subtree: one PATCH, the registry rewritten in the settlement", async () => {
      const { target, client, storage, topic, folder, inner, note, deep } = await tree();
      const revoked = await createFile(target, client, storage, `${folder.path}/old.md`);
      await register({ action: "artifact_revoke", profile_id: target.profile, artifact_id: revoked.id, base_version: Number(revoked.version) });
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      const descriptor = await cloud({ action: "load", ...job.reference });
      assert.deepEqual(descriptor.subtree_sample, [
        { provider_file_id: inner.provider_file_id, relative_path: "inner", target_kind: "directory" },
        { provider_file_id: note.provider_file_id, relative_path: "note.md", target_kind: "file" },
        { provider_file_id: deep.provider_file_id, relative_path: "inner/deep.md", target_kind: "file" }]);
      const patches = storage.patches;
      const done = await executor(target, storage).run(job.reference);
      assert.equal(done.status, "committed", JSON.stringify(done));
      assert.equal(storage.patches, patches + 1);
      const drive = storage.files.get(folder.provider_file_id);
      assert.deepEqual(drive.parents, [topic.provider_file_id]);
      const moved = await artifactById(folder.id);
      assert.equal(moved.path, `${topic.path}/folder`); assert.equal(moved.provider_file_version, drive.version);
      assert.equal(Number(moved.version), Number(folder.version) + 1);
      assert.equal(moved.provider_sharing_digest, folder.provider_sharing_digest, "the sharing is unchanged");
      for (const [row, relative] of [[inner, "inner"], [note, "note.md"], [deep, "inner/deep.md"]]) {
        const after = await artifactById(row.id);
        assert.equal(after.path, `${topic.path}/folder/${relative}`); assert.equal(after.state, "active");
        assert.equal(Number(after.version), Number(row.version) + 1);
        // P6.1: the registered Drive version follows Drive's advance.
        assert.equal(after.provider_file_version, storage.files.get(row.provider_file_id).version, relative);
        assert.notEqual(after.provider_file_version, row.provider_file_version, relative);
      }
      assert.equal((await artifactById(revoked.id)).path, revoked.path, "revoked history keeps its old path");
      assert.equal(await artifact(target, folder.path), undefined);
      const intent = await journal(job);
      assert.equal(intent.state, "committed"); assert.equal(intent.provider_attempt.contract, "clued.storage-subtree-move-attempt/1");
      assert.deepEqual(intent.provider_attempt.subtree_sample, descriptor.subtree_sample);
      assert.equal(intent.verified_result_v2.proof.contract, "clued.storage-directory-move-verified/1");
      assert.equal(intent.verified_result_v2.proof.checks.subtree, true);
      assert.equal(intent.provider_attempt.descendants.length, 3, "every active registered descendant matched the registry");
      assert.equal(intent.verified_result_v2.proof.descendant_versions.length, 3);
      assert.equal(intent.final_result.status, "committed");
      // Files under the moved directory keep working at their new paths.
      const again = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${topic.path}/folder/inner/after.md`, content: "x" });
      assert.equal((await executor(target, storage).run(again.reference)).status, "committed");
      const replay = (await submitRaw(target, client, job.mutation, job.reference.job_id)).rows[0].value;
      assert.equal(replay.replayed, true); assert.equal(replay.status, "committed");
      // And it moves back the same way.
      const back = await submitJob(target, client, move(await artifactById(folder.id), folder.path, drive.version));
      assert.equal((await executor(target, storage).run(back.reference)).status, "committed");
      assert.equal((await artifactById(deep.id)).path, deep.path);
    });

    await t.test("P6.1: an item changed outside Clued before the move keeps its registered version; the rest follow Drive", async () => {
      const { target, client, storage, topic, folder, note, deep } = await tree();
      storage.files.get(deep.provider_file_id).version = String(Number(storage.files.get(deep.provider_file_id).version) + 2);
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      const intent = await journal(job);
      assert.equal(intent.provider_attempt.descendants.some(item => item.provider_file_id === deep.provider_file_id), false);
      assert.equal((await artifactById(deep.id)).provider_file_version, deep.provider_file_version, "stale before, stale after");
      assert.equal((await artifactById(deep.id)).path, `${topic.path}/folder/inner/deep.md`);
      assert.equal((await artifactById(note.id)).provider_file_version, storage.files.get(note.provider_file_id).version);
      // The administrative path rewrite cannot add a refresh the proof did not name.
      const forged = await adminCall({ action: "artifact_subtree_move", profile_id: target.profile, artifact_id: folder.id,
        base_version: Number((await artifactById(folder.id)).version), path: folder.path, provider_file_id: folder.provider_file_id,
        provider_file_version: "99", idempotency_key: "resource-center-finalize:" + intent.id,
        descendant_versions: [{ provider_file_id: deep.provider_file_id, base_version: deep.provider_file_version, provider_file_version: "99" }] });
      assert.notEqual(forged.status, "committed");
    });

    await t.test("P6.2: a directory Clued creates is registered with its sharing digest when it equals its folder's", async () => {
      const { target, client, storage } = await setup();
      const trackPath = `${target.root}/${TRACK}`;
      const created = await submitJob(target, client, { operation: "create", target_kind: "directory", destination_path: `${trackPath}/made`,
        directory_semantics: "topic" });
      assert.equal((await executor(target, storage).run(created.reference)).status, "committed");
      const made = await artifact(target, `${trackPath}/made`);
      assert.equal(made.provider_sharing_digest, googleDriveSharingDigest(PRIVATE));
      assert.equal((await journal(created)).verified_result_v2.proof.provider_sharing_digest, googleDriveSharingDigest(PRIVATE));
      // Storage step 2: and with its observed access digest.
      assert.equal(made.provider_access_digest, googleDriveAccessDigest({ permissions: OWNER_ONLY }));
      assert.equal((await journal(created)).verified_result_v2.proof.provider_access_digest, googleDriveAccessDigest({ permissions: OWNER_ONLY }));
      // The committed replay check rebuilds the registration with the digest (a mismatch raises).
      const inspected = await cloud({ action: "verified_inspect", ...created.reference });
      assert.equal(inspected.status, "committed");
      // Its Drive version moving on no longer stops a write into it.
      storage.files.get(made.provider_file_id).version = "9";
      const inside = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${trackPath}/made/x.md`, content: "x" });
      assert.equal((await executor(target, storage).run(inside.reference)).status, "committed");
      // A folder whose sharing differs from its parent's keeps version matching.
      storage.newFolderSharing = SHARED;
      const odd = await submitJob(target, client, { operation: "create", target_kind: "directory", destination_path: `${trackPath}/odd`,
        directory_semantics: "topic" });
      assert.equal((await executor(target, storage).run(odd.reference)).status, "committed");
      assert.equal((await artifact(target, `${trackPath}/odd`)).provider_sharing_digest, null);
      assert.equal((await artifact(target, `${trackPath}/odd`)).provider_access_digest, null);
      assert.equal("provider_sharing_digest" in (await journal(odd)).verified_result_v2.proof, false);
    });

    await t.test("P6.2: a directory move gives both folders without a digest the one the authority recorded", async () => {
      const { target, client, storage, trackPath, topic, folder } = await tree();
      const track = await artifact(target, trackPath);
      assert.equal(topic.provider_sharing_digest, null); assert.equal(track.provider_sharing_digest, null);
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      const digest = googleDriveSharingDigest(PRIVATE);
      const topicAfter = await artifactById(topic.id), trackAfter = await artifactById(track.id);
      assert.equal(topicAfter.provider_sharing_digest, digest); assert.equal(trackAfter.provider_sharing_digest, digest);
      assert.equal(Number(topicAfter.version), Number(topic.version) + 1);
      // Storage step 2: the same update records their access digest, and the
      // moved directory gets its own.
      const access = googleDriveAccessDigest({ permissions: OWNER_ONLY });
      assert.equal(topicAfter.provider_access_digest, access); assert.equal(trackAfter.provider_access_digest, access);
      assert.equal((await artifactById(folder.id)).provider_access_digest, access);
      assert.equal(topicAfter.provider_file_version, topic.provider_file_version, "the version itself is left as registered");
      // Drive advanced the destination folder's version: writes into it still work.
      storage.files.get(topic.provider_file_id).version = String(Number(storage.files.get(topic.provider_file_id).version) + 4);
      const inside = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${topic.path}/after.md`, content: "x" });
      assert.equal((await executor(target, storage).run(inside.reference)).status, "committed");
      // A folder that already has a digest keeps it: moving back changes nothing on either side.
      const back = await submitJob(target, client, move(await artifactById(folder.id), folder.path, storage.files.get(folder.provider_file_id).version));
      assert.equal((await executor(target, storage).run(back.reference)).status, "committed");
      assert.equal(Number((await artifactById(topic.id)).version), Number(topicAfter.version));
      assert.equal(Number((await artifactById(track.id)).version), Number(trackAfter.version));
    });

    await t.test("storage step 2: a folder that already has a sharing digest gets only its access digest from a move, once", async () => {
      const { target, client, storage, topic, folder } = await tree();
      await recordSharing(target, topic);
      const shared = await artifactById(topic.id);
      assert.equal(shared.provider_sharing_digest, googleDriveSharingDigest(PRIVATE)); assert.equal(shared.provider_access_digest, null);
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      const after = await artifactById(topic.id);
      assert.equal(after.provider_sharing_digest, shared.provider_sharing_digest);
      assert.equal(after.provider_access_digest, googleDriveAccessDigest({ permissions: OWNER_ONLY }));
      assert.equal(Number(after.version), Number(shared.version) + 1);
    });

    await t.test("P6.2: a folder whose Drive version moved on since it was registered gets no digest from a move", async () => {
      const { target, client, storage, trackPath, topic, folder } = await tree();
      const track = await artifact(target, trackPath);
      // The source folder changed in Drive outside Clued; the authority matches it by ID only.
      storage.files.get(target.trackId).version = "3";
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      assert.equal((await journal(job)).authority_request.provider_identity.source_parent_version, "3");
      const trackAfter = await artifactById(track.id);
      assert.equal(trackAfter.provider_sharing_digest, null);
      assert.equal(trackAfter.provider_access_digest, null);
      assert.equal(Number(trackAfter.version), Number(track.version), "the stale source folder is left as registered");
      assert.equal((await artifactById(topic.id)).provider_sharing_digest, googleDriveSharingDigest(PRIVATE));
    });

    await t.test("P6.2: the verified record refuses a sharing digest on a file or one that is not the folder's", async () => {
      // Each case on its own root: a refused record leaves its intent fenced.
      // A file; another folder's digest; a non-digest value; a folder whose
      // destination had no digest in the identity (Drive omitted its sharing).
      for (const [kind, forged, unshared] of [["file", googleDriveSharingDigest(PRIVATE)], ["directory", googleDriveSharingDigest(SHARED)],
        ["directory", "invalid"], ["file", "invalid"], ["directory", googleDriveSharingDigest(PRIVATE), true]]) {
        const { target, client, storage } = await setup();
        const trackPath = `${target.root}/${TRACK}`;
        if (unshared) { delete storage.files.get(target.trackId).shared; delete storage.files.get(target.trackId).permissionIds; }
        const mutation = kind === "file" ? { operation: "create", target_kind: "file", destination_path: `${trackPath}/f.md`, content: "x" }
          : { operation: "create", target_kind: "directory", destination_path: `${trackPath}/d`, directory_semantics: "topic" };
        const job = await submitJob(target, client, mutation);
        let refused = false, loaded;
        const forging = createResourceCenterCloudExecutor({ verified_result_mode: true,
          load_job: async ref => { const d = await cloud({ action: "load", ...ref }); loaded = d; const c = { ...d }; delete c.credential_envelope; delete c.oauth_client_id; return c; },
          get_credential: async expected => ({ ...expected, access_token: "fixture-subtree-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
          drive_fetch: storage.fetch,
          rpc: async input => {
            const { connection_id, job_id, action, ...body } = input;
            if (action === "verified_record") body.proof = { ...body.proof, provider_sharing_digest: forged };
            try {
              return await cloud({ connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
                ...(action === "finalize" ? { finish: { action, ...body } } : body) });
            } catch (error) { if (action === "verified_record") refused = /storage_verified_mismatch/.test(String(error.message)); throw error; }
          },
        });
        const result = await forging.run(job.reference);
        assert.notEqual(result.status, "committed", JSON.stringify(result));
        assert.equal(refused, true, `${kind} ${forged}`);
        if (unshared) assert.equal((await journal(job)).authority_request.provider_identity.destination_parent_sharing_digest, null);
        assert.equal(await artifact(target, mutation.destination_path), undefined);
      }
    });

    await t.test("storage step 2: the verified record refuses an access digest on a file, without a sharing digest, or malformed", async () => {
      // Each case on its own root: a refused record leaves its intent fenced.
      const good = googleDriveAccessDigest({ permissions: OWNER_ONLY });
      for (const [kind, forged, unshared] of [["file", good], ["directory", "invalid"], ["directory", "A".repeat(64)],
        ["directory", good, true]]) {
        const { target, client, storage } = await setup();
        const trackPath = `${target.root}/${TRACK}`;
        if (unshared) { delete storage.files.get(target.trackId).shared; delete storage.files.get(target.trackId).permissionIds; }
        const mutation = kind === "file" ? { operation: "create", target_kind: "file", destination_path: `${trackPath}/f.md`, content: "x" }
          : { operation: "create", target_kind: "directory", destination_path: `${trackPath}/d`, directory_semantics: "topic" };
        const job = await submitJob(target, client, mutation);
        let refused = false, loaded;
        const forging = createResourceCenterCloudExecutor({ verified_result_mode: true,
          load_job: async ref => { const d = await cloud({ action: "load", ...ref }); loaded = d; const c = { ...d }; delete c.credential_envelope; delete c.oauth_client_id; return c; },
          get_credential: async expected => ({ ...expected, access_token: "fixture-subtree-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
          drive_fetch: storage.fetch,
          rpc: async input => {
            const { connection_id, job_id, action, ...body } = input;
            if (action === "verified_record") body.proof = { ...body.proof, provider_access_digest: forged };
            try {
              return await cloud({ connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
                ...(action === "finalize" ? { finish: { action, ...body } } : body) });
            } catch (error) { if (action === "verified_record") refused = /storage_verified_mismatch/.test(String(error.message)); throw error; }
          },
        });
        const result = await forging.run(job.reference);
        assert.notEqual(result.status, "committed", JSON.stringify(result));
        assert.equal(refused, true, `${kind} ${forged}`);
        assert.equal(await artifact(target, mutation.destination_path), undefined);
      }
    });

    await t.test("storage step 2: the backfill records an access digest only at the registered version, once", async () => {
      const { target } = await setup([]);
      const envelope = { contract: "clued.storage-credential/1", key_id: "fixture", nonce: "x".repeat(16), ciphertext: "y".repeat(24) };
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1", [target.connection, envelope]);
      const backfill = async (input, hash = issuer) => (await caller.query("select public.clued_storage_access_digest_backfill_v1($1,$2::jsonb) value",
        [hash, JSON.stringify(input)])).rows[0].value;
      const root = await artifact(target, target.root), track = await artifact(target, `${target.root}/${TRACK}`);
      const mine = async () => (await backfill({ action: "due" })).directories.filter(d => d.connection_id === target.connection)
        .map(d => d.artifact_id).sort();
      assert.deepEqual(await mine(), [root.id, track.id].sort());
      await assert.rejects(backfill({ action: "due" }, "f".repeat(64)), /backfill_denied/);
      await assert.rejects(backfill({ action: "due", extra: true }), /backfill_denied/);
      // Load names the credential and the row; it is read only.
      const loaded = await backfill({ action: "load", connection_id: target.connection, artifact_id: root.id });
      assert.equal(loaded.status, "read_only"); assert.equal(loaded.execution_permitted, false);
      assert.equal(loaded.provider_file_id, target.rootId); assert.equal(loaded.registered_version, root.provider_file_version);
      assert.equal(loaded.row_version, Number(root.version)); assert.deepEqual(loaded.credential_envelope, envelope);
      // Loading puts it behind the others without changing the row's version.
      const attempted = await artifactById(root.id);
      assert.notEqual(attempted.access_digest_attempted_at, null); assert.equal(Number(attempted.version), Number(root.version));
      assert.deepEqual(await mine(), [track.id]);
      const access = googleDriveAccessDigest({ permissions: OWNER_ONLY });
      const commit = (row, observed, digest, version = Number(row.version), found = observed !== null) => backfill({ action: "commit",
        connection_id: target.connection, artifact_id: row.id, row_version: version, registered_version: row.provider_file_version,
        found, observed_version: observed, access_digest: digest });
      // found is required and must agree with the observation.
      await assert.rejects(backfill({ action: "commit", connection_id: target.connection, artifact_id: root.id, row_version: Number(root.version),
        registered_version: root.provider_file_version, observed_version: root.provider_file_version, access_digest: null }), /backfill_denied/);
      await assert.rejects(commit(root, root.provider_file_version, null, Number(root.version), false), /backfill_denied/);
      // A stale row version or a malformed outcome changes nothing.
      await assert.rejects(commit(root, root.provider_file_version, access, Number(root.version) - 1), /backfill_conflict/);
      await assert.rejects(commit(root, root.provider_file_version, "not-hex"), /backfill_denied/);
      // Same version: recorded, with its Receipt.
      const recorded = await commit(root, root.provider_file_version, access);
      assert.equal(recorded.outcome, "recorded");
      const rootAfter = await artifactById(root.id);
      assert.equal(rootAfter.provider_access_digest, access); assert.equal(rootAfter.access_digest_missing_at, null);
      assert.equal(Number(rootAfter.version), Number(root.version) + 1);
      assert.equal(rootAfter.provider_file_version, root.provider_file_version);
      const receipt = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [recorded.receipt_id])).rows[0];
      assert.deepEqual(receipt, { operation: "storage_access_digest_backfill", status: "committed" });
      // Another version (or a failed read): marked missing, no digest.
      const missing = await commit(track, String(Number(track.provider_file_version) + 1), access);
      assert.equal(missing.outcome, "missing:version_changed");
      const trackAfter = await artifactById(track.id);
      assert.equal(trackAfter.provider_access_digest, null); assert.notEqual(trackAfter.access_digest_missing_at, null);
      // A folder Drive no longer shows (404) is marked missing too.
      const gone = await artifactById((await register({ action: "artifact_register", profile_id: target.profile,
        path: `${target.root}/${TRACK}/gone`, provider_file_id: `st-gone-${randomUUID()}`, provider_file_version: "1",
        target_kind: "directory", governance_class: "ordinary", delete_authority: false })).target_refs.find(ref => ref.role === "primary").id);
      assert.equal((await commit(gone, null, null)).outcome, "missing:not_found");
      assert.notEqual((await artifactById(gone.id)).access_digest_missing_at, null);
      // None is listed again before its backoff (bug 38bb5ddf: a missing mark is retried, not final).
      assert.deepEqual(await mine(), []);
      assert.equal((await backfill({ action: "load", connection_id: target.connection, artifact_id: track.id })).status, "read_only");
      // An Owner approved update writes a digest and clears the missing mark.
      await register({ action: "artifact_update", profile_id: target.profile, artifact_id: track.id, base_version: Number(trackAfter.version),
        path: trackAfter.path, provider_file_id: trackAfter.provider_file_id, provider_file_version: trackAfter.provider_file_version,
        governance_class: trackAfter.governance_class, delete_authority: trackAfter.delete_authority, provider_access_digest: access });
      const updated = await artifactById(track.id);
      assert.equal(updated.provider_access_digest, access); assert.equal(updated.access_digest_missing_at, null);
      const refused = await adminCall({ action: "artifact_update", profile_id: target.profile, artifact_id: track.id,
        base_version: Number(updated.version), path: updated.path, provider_file_id: updated.provider_file_id,
        provider_file_version: updated.provider_file_version, governance_class: updated.governance_class,
        delete_authority: updated.delete_authority, provider_access_digest: "not-hex" });
      assert.notEqual(refused.status, "committed", JSON.stringify(refused));
      assert.equal((await artifactById(track.id)).provider_access_digest, access);
      // A directory with a sharing digest is never backfilled.
      const shared = await artifactById((await register({ action: "artifact_register", profile_id: target.profile,
        path: `${target.root}/${TRACK}/shared`, provider_file_id: `st-shared-${randomUUID()}`, provider_file_version: "1",
        target_kind: "directory", governance_class: "ordinary", delete_authority: false,
        provider_sharing_digest: googleDriveSharingDigest(PRIVATE) })).target_refs.find(ref => ref.role === "primary").id);
      assert.equal(shared.provider_sharing_digest, googleDriveSharingDigest(PRIVATE));
      assert.deepEqual(await mine(), []);
      await assert.rejects(backfill({ action: "load", connection_id: target.connection, artifact_id: shared.id }), /backfill_denied/);
    });

    // Bug 38bb5ddf (Decision 24422a98): the program, not the Owner, recovers a
    // missing access digest. As in Drive, a folder that grants exactly what its
    // unchanged registered parent grants is recorded; a real difference is not.
    await t.test("bug 38bb5ddf: a missing directory is retried and recorded when it grants exactly its unchanged parent's access", async () => {
      const { target } = await setup([]);
      const envelope = { contract: "clued.storage-credential/1", key_id: "fixture", nonce: "x".repeat(16), ciphertext: "y".repeat(24) };
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1", [target.connection, envelope]);
      const backfill = async input => (await caller.query("select public.clued_storage_access_digest_backfill_v1($1,$2::jsonb) value",
        [issuer, JSON.stringify(input)])).rows[0].value;
      const load = id => backfill({ action: "load", connection_id: target.connection, artifact_id: id });
      const commit = (row, extra) => backfill({ action: "commit", connection_id: target.connection, artifact_id: row.id,
        row_version: Number(row.version), registered_version: row.provider_file_version, found: true, ...extra });
      const access = googleDriveAccessDigest({ permissions: OWNER_ONLY });
      const wider = googleDriveAccessDigest({ permissions: [...OWNER_ONLY, { id: "anyone", type: "anyone", role: "reader" }] });
      const side = async id => (await admin.query("select reason,attempts from clued_private.storage_access_digest_recovery_v1 where artifact_id=$1", [id])).rows[0];
      const due = async () => (await backfill({ action: "due" })).directories.filter(d => d.connection_id === target.connection).map(d => d.artifact_id);
      const later = id => admin.query("update clued_private.resource_center_artifacts_v1 set access_digest_attempted_at=now()-interval '20 hours' where id=$1", [id]);
      // The track gets its baseline the ordinary way.
      let track = await artifact(target, `${target.root}/${TRACK}`);
      await load(track.id);
      assert.equal((await commit(track, { observed_version: track.provider_file_version, access_digest: access })).outcome, "recorded");
      track = await artifactById(track.id);
      const child = async name => artifactById((await register({ action: "artifact_register", profile_id: target.profile,
        path: `${target.root}/${TRACK}/${name}`, provider_file_id: `st-${name}-${randomUUID()}`, provider_file_version: "1",
        target_kind: "directory", governance_class: "ordinary", delete_authority: false })).target_refs.find(ref => ref.role === "primary").id);
      // The 2026-10-08 case: a folder whose version moved (children were added).
      let drift = await child("drift");
      let loaded = await load(drift.id);
      assert.deepEqual(loaded.parent, { artifact_id: track.id, provider_file_id: track.provider_file_id, row_version: Number(track.version), mode: "access" });
      assert.equal((await commit(drift, { observed_version: "3", access_digest: access })).outcome, "missing:version_changed");
      assert.deepEqual(await side(drift.id), { reason: "version_changed", attempts: 1 });
      drift = await artifactById(drift.id); assert.notEqual(drift.access_digest_missing_at, null);
      // Backoff, then it comes back by itself.
      assert.equal((await due()).includes(drift.id), false);
      await later(drift.id); assert.equal((await due()).includes(drift.id), true);
      loaded = await load(drift.id);
      const parent = { artifact_id: track.id, row_version: Number(track.version), observed_digest: access, observed_access: access };
      // Malformed parent observations are refused.
      for (const bad of [{ ...parent, extra: 1 }, { ...parent, observed_access: "x" }, { ...parent, row_version: "1" }])
        await assert.rejects(commit(drift, { observed_version: "3", access_digest: access, parent: bad }), /backfill_denied/);
      // A parent that changed since its baseline, or since load, is no baseline.
      assert.equal((await commit(drift, { observed_version: "3", access_digest: access,
        parent: { ...parent, observed_digest: wider, observed_access: wider } })).outcome, "missing:version_changed");
      drift = await artifactById(drift.id);
      assert.equal((await commit(drift, { observed_version: "3", access_digest: access,
        parent: { ...parent, row_version: Number(track.version) + 1 } })).outcome, "missing:version_changed");
      drift = await artifactById(drift.id);
      assert.deepEqual(await side(drift.id), { reason: "version_changed", attempts: 3 });
      // Same access as the unchanged parent: recorded, the mark and the attempts cleared.
      const ok = await commit(drift, { observed_version: "3", access_digest: access, parent });
      assert.equal(ok.outcome, "recorded_inherited");
      drift = await artifactById(drift.id);
      assert.equal(drift.provider_access_digest, access); assert.equal(drift.access_digest_missing_at, null);
      assert.equal(drift.provider_file_version, "1"); assert.equal(await side(drift.id), undefined);
      const receipt = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [ok.receipt_id])).rows[0];
      assert.deepEqual(receipt, { operation: "storage_access_digest_backfill", status: "committed" });
      await assert.rejects(load(drift.id), /backfill_denied/);
      // A real sharing difference is still blocked: never recorded, kept for the Owner.
      let shared = await child("shared-out");
      await load(shared.id);
      assert.equal((await commit(shared, { observed_version: "2", access_digest: wider, parent })).outcome, "missing:access_differs");
      shared = await artifactById(shared.id);
      assert.equal(shared.provider_access_digest, null); assert.notEqual(shared.access_digest_missing_at, null);
      assert.deepEqual(await side(shared.id), { reason: "access_differs", attempts: 1 });
      // The signed-in Owner sees it, in business terms; the recovered folder is not listed.
      const attention = async (input = { action: "list" }, db = native) =>
        (await db.query("select public.clued_storage_access_digest_attention_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
      const seen = (await attention()).connections.find(c => c.connection_id === target.connection);
      assert.deepEqual(seen, { connection_id: target.connection, count: 1, directories: [{ artifact_id: shared.id, path: `${TRACK}/shared-out`,
        reason: "access_differs", observed_access: wider }] });
      await assert.rejects(attention({ action: "list", extra: 1 }), /attention_denied/);
      await assert.rejects(attention(undefined, caller), /permission denied/);
      // Never given up (review M1): after many attempts it is still tried, at
      // most every 16 hours, so restoring the sharing recovers it by itself.
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set attempts=40 where artifact_id=$1", [shared.id]);
      await admin.query("update clued_private.resource_center_artifacts_v1 set access_digest_attempted_at=now()-interval '15 hours' where id=$1", [shared.id]);
      assert.equal((await due()).includes(shared.id), false);
      await later(shared.id); assert.equal((await due()).includes(shared.id), true);
      shared = await artifactById(shared.id); await load(shared.id);
      assert.equal((await commit(shared, { observed_version: "2", access_digest: access, parent })).outcome, "recorded_inherited");
      assert.equal(await side(shared.id), undefined);
      assert.equal((await attention()).connections.some(c => c.connection_id === target.connection), false);
      // Gone, unreadable or without a baseline is shown after 3 attempts for the same reason (review r2).
      let gone = await child("gone-later"), stuck = await child("no-baseline");
      for (const row of [gone, stuck]) await load(row.id);
      await commit(gone, { found: false, observed_version: null, access_digest: null });
      await commit(stuck, { observed_version: "2", access_digest: wider });
      assert.equal((await attention()).connections.some(c => c.connection_id === target.connection), false);
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set attempts=2 where artifact_id=any($1)", [[gone.id, stuck.id]]);
      // A different reason starts a new count.
      stuck = await artifactById(stuck.id); await load(stuck.id);
      await commit(stuck, { found: false, observed_version: null, access_digest: null });
      assert.deepEqual(await side(stuck.id), { reason: "not_found", attempts: 1 });
      stuck = await artifactById(stuck.id); await load(stuck.id);
      await commit(stuck, { observed_version: "2", access_digest: wider });
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set attempts=3 where artifact_id=any($1)", [[gone.id, stuck.id]]);
      assert.deepEqual((await attention()).connections.find(c => c.connection_id === target.connection).directories, [
        { artifact_id: gone.id, path: `${TRACK}/gone-later`, reason: "not_found", observed_access: null },
        { artifact_id: stuck.id, path: `${TRACK}/no-baseline`, reason: "no_baseline", observed_access: wider }]);
      // Where the program cannot decide, the Owner confirms exactly the observed sharing.
      const accept = async (input, db = native) =>
        (await db.query("select public.clued_storage_access_digest_accept_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
      const confirm = (row, observed) => accept({ action: "accept", artifact_id: row.id, observed_access: observed });
      await assert.rejects(confirm(stuck, access), /accept_denied/);
      await assert.rejects(confirm(gone, wider), /accept_denied/);
      await assert.rejects(accept({ action: "accept", artifact_id: stuck.id, observed_access: wider, extra: 1 }), /accept_denied/);
      await assert.rejects(accept({ action: "accept", artifact_id: stuck.id, observed_access: wider }, caller), /permission denied/);
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set updated_at=now()-interval '25 hours' where artifact_id=$1", [stuck.id]);
      await assert.rejects(confirm(stuck, wider), /accept_denied/);
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set updated_at=now() where artifact_id=$1", [stuck.id]);
      // An observation another path has since superseded is not confirmable (review r3).
      const saved = (await admin.query("select last_receipt_id from clued_private.storage_access_digest_recovery_v1 where artifact_id=$1", [stuck.id])).rows[0].last_receipt_id;
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set last_receipt_id=$2 where artifact_id=$1", [stuck.id, ok.receipt_id]);
      await assert.rejects(confirm(stuck, wider), /accept_denied/);
      await admin.query("update clued_private.storage_access_digest_recovery_v1 set last_receipt_id=$2 where artifact_id=$1", [stuck.id, saved]);
      // A directory below with no baseline is checked again at once after the confirmation.
      const below = await artifactById((await register({ action: "artifact_register", profile_id: target.profile,
        path: `${target.root}/${TRACK}/no-baseline/below`, provider_file_id: `st-below-${randomUUID()}`, provider_file_version: "1",
        target_kind: "directory", governance_class: "ordinary", delete_authority: false })).target_refs.find(ref => ref.role === "primary").id);
      await load(below.id);
      await commit(below, { observed_version: "2", access_digest: wider });
      assert.equal((await due()).includes(below.id), false);
      const confirmed = await confirm(stuck, wider);
      assert.equal((await due()).includes(below.id), true);
      assert.equal(confirmed.status, "committed");
      stuck = await artifactById(stuck.id);
      assert.equal(stuck.provider_access_digest, wider); assert.equal(stuck.access_digest_missing_at, null);
      assert.equal(await side(stuck.id), undefined);
      const accepted = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [confirmed.receipt_id])).rows[0];
      assert.deepEqual(accepted, { operation: "storage_access_digest_owner_accept", status: "committed" });
      await assert.rejects(confirm(stuck, wider), /accept_denied/);
      // Review M2: a folder only its owner can reach needs no parent, so the
      // root (which has none) recovers too; owner_only needs a digest.
      let root = await artifact(target, target.root);
      await admin.query("update clued_private.resource_center_artifacts_v1 set access_digest_missing_at=now() where id=$1", [root.id]);
      root = await artifactById(root.id);
      assert.equal((await load(root.id)).parent, null);
      await assert.rejects(commit(root, { observed_version: "99", access_digest: null, owner_only: true }), /backfill_denied/);
      await assert.rejects(commit(root, { observed_version: "99", access_digest: access, owner_only: false }), /backfill_denied/);
      assert.equal((await commit(root, { observed_version: "99", access_digest: access, owner_only: true })).outcome, "recorded_private");
      root = await artifactById(root.id);
      assert.equal(root.provider_access_digest, access); assert.equal(root.access_digest_missing_at, null);
      // A mark from before this fix (no attempts yet) is retried at once.
      const legacy = await child("legacy");
      await admin.query("update clued_private.resource_center_artifacts_v1 set access_digest_missing_at=now() where id=$1", [legacy.id]);
      assert.equal((await due()).includes(legacy.id), true);
    });

    await t.test("fix d9d6db4c: a started move that never recorded its attempt is released once its admission expired", async () => {
      const { target, client, storage, topic, folder } = await tree();
      const release = async (hash = issuer, input = { action: "release" }) => (await caller.query(
        "select public.clued_storage_release_unattempted_v1($1,$2::jsonb) value", [hash, JSON.stringify(input)])).rows[0].value;
      // The executor stops before the attempt record (as a failed pre-effect read does in production).
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      const patches = storage.patches;
      let loaded;
      const stopping = createResourceCenterCloudExecutor({ verified_result_mode: true,
        load_job: async ref => { loaded = await cloud({ action: "load", ...ref }); const d = { ...loaded }; delete d.credential_envelope; delete d.oauth_client_id; return d; },
        get_credential: async expected => ({ ...expected, access_token: "fixture-subtree-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
        drive_fetch: storage.fetch,
        rpc: async input => {
          const { connection_id, job_id, action, ...body } = input;
          if (action === "provider_attempt") throw new Error("synthetic failure before the attempt");
          return cloud({ connection_id, job_id, action, ...(action === "settle_verified" ? {} : { credential_version: loaded.credential_version }),
            ...(action === "finalize" ? { finish: { action, ...body } } : body) });
        },
      });
      assert.equal((await stopping.run(job.reference)).status, "unreconciled");
      assert.equal(storage.patches, patches, "Drive was never changed");
      let intent = await journal(job);
      assert.equal(intent.state, "started"); assert.equal(intent.provider_attempt, null);
      // While it is unresolved the Owner's level switch is refused.
      await assert.rejects(setLevel(target, ["destructive"]), /storage_root_has_unresolved_mutation/);
      // Not before its admission has expired; never for another issuer or input.
      assert.deepEqual(await release(), { status: "ok", released: 0 });
      await assert.rejects(release(sha(randomUUID())), /storage_release_denied/);
      await assert.rejects(release(issuer, { action: "release", limit: 9 }), /storage_release_denied/);
      await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=now()-interval '61 seconds' where id=$1", [intent.id]);
      assert.equal((await release()).released, 1);
      intent = await journal(job);
      assert.equal(intent.state, "cancelled");
      assert.deepEqual(intent.final_result, { outcome: "released_unattempted", reason_code: "NO_PROVIDER_ATTEMPT" });
      const receipt = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [intent.receipt_id])).rows[0];
      assert.deepEqual(receipt, { operation: "storage_unattempted_release", status: "committed" });
      const inspected = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "inspect", ...job.reference })])).rows[0].value;
      assert.equal(inspected.status, "cancelled"); assert.equal(inspected.reason_code, "NO_PROVIDER_ATTEMPT");
      // A late attempt record is refused, so no Drive write can follow; a second release finds nothing.
      await assert.rejects(cloud({ action: "provider_attempt", ...job.reference, credential_version: 1,
        attempt: { provider_file_id: folder.provider_file_id } }));
      assert.equal((await journal(job)).provider_attempt, null);
      assert.deepEqual(await release(), { status: "ok", released: 0 });
      // The root is free: the same move runs, and the level switch is accepted.
      const again = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(again.reference)).status, "committed");
      assert.equal((await setLevel(target, ["destructive"])).status, "committed");
    });

    await t.test("fix d9d6db4c: a started job that recorded its attempt is never released, however old", async () => {
      const { target, client, storage, topic, folder } = await tree();
      storage.losePatch = true;
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "unreconciled");
      storage.losePatch = false;
      const intent = await journal(job);
      assert.equal(intent.state, "started"); assert.notEqual(intent.provider_attempt, null);
      await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=now()-interval '1 hour' where id=$1", [intent.id]);
      const released = (await caller.query("select public.clued_storage_release_unattempted_v1($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "release" })])).rows[0].value;
      assert.equal(released.status, "ok");
      assert.equal((await journal(job)).state, "started");
    });

    await t.test("submit refuses a track, a rename, a move into itself and any other shape before a job exists", async () => {
      const { target, client, trackPath, topic, folder } = await tree();
      const track = await artifact(target, trackPath);
      const before = await counters();
      for (const mutation of [move(track, `${topic.path}/${TRACK}`, "1"), move(folder, `${topic.path}/renamed`),
        move(folder, `${folder.path}/inner/folder`), move(folder, folder.path), { ...move(folder, `${topic.path}/folder`), operation: "rename" },
        { ...move(folder, `${topic.path}/folder`), source_file_id: undefined }, move(folder, `${topic.path}/folder`, "0"),
        { ...move(folder, `${topic.path}/folder`), directory_semantics: "topic" }, { ...move(folder, `${topic.path}/folder`), content: "x" }]) {
        await assert.rejects(submitRaw(target, client, JSON.parse(JSON.stringify(mutation))), /storage_job_input_invalid/, JSON.stringify(mutation));
      }
      assert.deepEqual(await counters(), before);
    });

    await t.test("different sharing, a stale version or a registered destination is refused with no provider effect", async () => {
      const { target, client, storage, topic, folder } = await tree();
      const runRefused = async (mutation, prepare = () => {}) => {
        const job = await submitJob(target, client, mutation);
        await prepare();
        const before = { patches: storage.patches, intents: (await counters()).intents };
        const result = await executor(target, storage).run(job.reference);
        assert.equal(storage.patches, before.patches, JSON.stringify(result));
        assert.equal((await counters()).intents, before.intents, "no reservation");
        return { job, result };
      };
      // The destination folder is shared differently: its own fixed reason.
      Object.assign(storage.files.get(topic.provider_file_id), structuredClone(SHARED));
      const differs = await runRefused(move(folder, `${topic.path}/folder`));
      assert.equal(differs.result.status, "deny"); assert.equal(differs.result.error_code, "DIRECTORY_SHARING_DIFFERS");
      assert.equal((await report(differs.job, differs.result)).status, "denied");
      const inspected = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "inspect", ...differs.job.reference })])).rows[0].value;
      assert.equal(inspected.reason_code, "DIRECTORY_SHARING_DIFFERS");
      Object.assign(storage.files.get(topic.provider_file_id), structuredClone(PRIVATE));
      // The same grantees with another role: only the access digest tells them apart.
      storage.files.get(target.trackId).permissions = [...OWNER_ONLY, { id: "u", type: "user", role: "reader" }];
      storage.files.get(topic.provider_file_id).permissions = [...OWNER_ONLY, { id: "u", type: "user", role: "writer" }];
      const roles = await runRefused(move(folder, `${topic.path}/folder`));
      assert.equal(roles.result.error_code, "DIRECTORY_SHARING_DIFFERS");
      storage.files.get(topic.provider_file_id).permissions = [...OWNER_ONLY, { id: "u", type: "user", role: "reader" }];
      // Drive did not report the destination's permissions: equal access cannot be proven.
      delete storage.files.get(topic.provider_file_id).permissions;
      const unknown = await runRefused(move(folder, `${topic.path}/folder`));
      assert.equal(unknown.result.error_code, "DIRECTORY_ACCESS_UNAVAILABLE");
      storage.files.get(topic.provider_file_id).permissions = [...OWNER_ONLY, { id: "u", type: "user", role: "reader" }];
      // A registered file inside was renamed in Drive outside Clued.
      const note = (await admin.query("select provider_file_id from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2",
        [target.profile, `${folder.path}/note.md`])).rows[0].provider_file_id;
      storage.files.get(note).name = "renamed.md";
      const drift = await runRefused(move(folder, `${topic.path}/folder`));
      assert.equal(drift.result.status, "deny"); assert.equal(drift.result.error_code, "SUBTREE_DRIFT");
      storage.files.get(note).name = "note.md";
      // The directory changed in Drive after the Agent looked at it.
      const stale = await runRefused(move(folder, `${topic.path}/folder`, "4"));
      assert.equal(stale.result.status, "deny"); assert.equal(stale.result.error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
      // Something is already registered at the destination (not in Drive).
      await register({ action: "artifact_register", profile_id: target.profile, path: `${topic.path}/folder`, provider_file_id: `st-ghost-${randomUUID()}`,
        provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
      const taken = await runRefused(move(folder, `${topic.path}/folder`));
      assert.equal(taken.result.status, "deny"); assert.equal(taken.result.error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
      assert.deepEqual(storage.files.get(folder.provider_file_id).parents, [target.trackId]);
    });

    await t.test("more than 500 registered items under the directory is refused by the authority", async () => {
      const { target, client, storage, topic, folder } = await tree();
      await admin.query(`insert into clued_private.resource_center_artifacts_v1(user_id,profile_id,path,provider_file_id,provider_file_version,
          target_kind,governance_class,delete_authority,source_decision_id,receipt_id)
        select a.user_id,a.profile_id,a.path||'/bulk-'||n||'.md','st-bulk-'||n||'-'||md5(a.id::text),'1','file','ordinary',false,a.source_decision_id,a.receipt_id
        from clued_private.resource_center_artifacts_v1 a, generate_series(1,500) n where a.id=$1`, [folder.id]);
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      const patches = storage.patches;
      const result = await executor(target, storage).run(job.reference);
      assert.equal(result.status, "deny"); assert.equal(storage.patches, patches);
      assert.equal((await artifactById(folder.id)).path, folder.path);
    });

    await t.test("a registry change between the descriptor and the durable start uses the start's sample", async () => {
      const { target, storage, topic, folder, client } = await tree();
      let added;
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      const done = await executor(target, storage, async () => {
        added = await directoryIn(target, storage, "aaa", folder.path, folder.provider_file_id);
      }).run(job.reference);
      assert.equal(done.status, "committed", JSON.stringify(done));
      const attempt = (await journal(job)).provider_attempt;
      assert.equal(attempt.subtree_sample[0].provider_file_id, added.provider_file_id, "the sample taken at the start");
      assert.equal((await artifactById(added.id)).path, `${topic.path}/folder/aaa`);
    });

    await t.test("a trashed item under the directory moves with it and is untrashed at its new path", async () => {
      const { target, client, storage, topic, folder, note } = await tree();
      const trash = await submitJob(target, client, { operation: "delete", target_kind: "file", source_path: note.path,
        source_file_version: storage.files.get(note.provider_file_id).version, source_file_id: note.provider_file_id });
      assert.equal((await executor(target, storage).run(trash.reference)).status, "committed");
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      const trashed = await artifactById(note.id);
      assert.equal(trashed.state, "trashed"); assert.equal(trashed.path, `${topic.path}/folder/note.md`);
      assert.equal(trashed.provider_file_version, storage.files.get(note.provider_file_id).version, "the trashed item's version followed Drive");
      const restore = await submitJob(target, client, { operation: "restore", target_kind: "file", source_path: trashed.path,
        source_file_version: trashed.provider_file_version, source_file_id: note.provider_file_id });
      const restored = await executor(target, storage).run(restore.reference);
      assert.equal(restored.status, "committed", JSON.stringify(restored));
      assert.equal((await artifactById(note.id)).state, "active");
    });

    await t.test("the registry path rewrite is refused outside the verified settlement of a directory move", async () => {
      const { target, topic, folder } = await tree();
      for (const key of [randomUUID(), "resource-center-finalize:" + randomUUID()]) {
        const result = await adminCall({ action: "artifact_subtree_move", profile_id: target.profile, artifact_id: folder.id,
          base_version: Number(folder.version), path: `${topic.path}/folder`, provider_file_id: folder.provider_file_id,
          provider_file_version: "9", idempotency_key: key });
        assert.notEqual(result.status, "committed", JSON.stringify(result));
      }
      assert.equal((await artifactById(folder.id)).path, folder.path);
    });

    await t.test("a lost reply stays fenced; scheduled recovery never settles it, the Owner's native recovery does, once", async () => {
      const { target, client, storage, topic, folder, deep } = await tree();
      storage.losePatch = true;
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      const result = await executor(target, storage).run(job.reference);
      assert.equal(result.status, "unreconciled");
      assert.equal(storage.patches > 0, true);
      const row = await journal(job);
      assert.equal(row.state, "started", "the uncertain effect stays fenced");
      assert.equal((await artifactById(folder.id)).path, folder.path, "no rewrite without a verified proof");
      assert.equal((await artifactById(deep.id)).path, deep.path);
      // The single writer: no other write on this root starts while the move is unresolved.
      const other = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${topic.path}/other.md`, content: "x" });
      const intents = (await counters()).intents;
      const blocked = await executor(target, storage).run(other.reference);
      assert.notEqual(blocked.status, "committed", JSON.stringify(blocked));
      assert.equal((await counters()).intents, intents, "no second intent");
      assert.equal(await artifact(target, `${topic.path}/other.md`), undefined);
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
        JSON.stringify({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "B".repeat(24) })]);
      await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1", [row.provider_attempt_receipt_id]);
      const due = (await caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value", [issuer, JSON.stringify({ action: "due" })])).rows[0].value;
      assert.equal(due.jobs.some(entry => entry.job_id === job.reference.job_id), false, "scheduled recovery does not list a directory move");
      await assert.rejects(caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "load", ...job.reference })]), /storage_scheduled_recovery_denied/);
      const descriptor = (await native.query("select public.clued_storage_native_recovery_load_v2($1,$2::jsonb) value",
        [issuerSecret, JSON.stringify({ action: "recovery_load", ...job.reference })])).rows[0].value;
      assert.equal(descriptor.status, "recovery_only"); assert.equal(descriptor.attempt.contract, "clued.storage-subtree-move-attempt/1");
      const patches = storage.patches;
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-subtree-access", scope: SCOPES }),
        fetch: async (url, init = {}) => { assert.equal(init.method ?? "GET", "GET"); return storage.fetch(url, init); } });
      const verify = createGoogleDriveDirectoryMovePostconditionVerifier({ managed_root: descriptor.profile.managed_root, root_folder_id: descriptor.root_folder_id,
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren,
        get_sharing: metadata.getSharing, get_access: metadata.getAccess, include_verified_proof: true });
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "move", target_kind: "directory",
          source_path: descriptor.mutation.source_path, destination_path: descriptor.mutation.destination_path,
          provider_file_id: descriptor.attempt.provider_file_id, subtree_sample: descriptor.attempt.subtree_sample,
          descendants: descriptor.attempt.descendants } });
      const finish = { action: "finalize", intent_id: descriptor.intent_id, base_version: descriptor.version, request_sha256: descriptor.request_sha256,
        idempotency_key: `account-job:${job.reference.job_id}:finalize`, postcondition };
      const recorded = await cloud({ action: "verified_record", ...job.reference, credential_version: descriptor.credential_version, finish, proof });
      assert.equal(recorded.status, "verified", JSON.stringify(recorded));
      const settled = await cloud({ action: "settle_verified", ...job.reference, intent_id: descriptor.intent_id, base_version: descriptor.version,
        request_sha256: descriptor.request_sha256, verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
      assert.equal(settled.state, "committed", JSON.stringify(settled));
      assert.equal(storage.patches, patches, "recovery never repeats the update");
      assert.equal((await artifactById(folder.id)).path, `${topic.path}/folder`);
      assert.equal((await artifactById(deep.id)).path, `${topic.path}/folder/inner/deep.md`);
    });

    // A lost reply, re-verified as the Owner's native recovery does; optionally
    // with the attempt as stored before P6.1 (no descendants).
    const lostMove = async ({ legacy = false } = {}) => {
      const fixture = await tree();
      const { target, client, storage, topic, folder } = fixture;
      storage.losePatch = true;
      const job = await submitJob(target, client, move(folder, `${topic.path}/folder`));
      assert.equal((await executor(target, storage).run(job.reference)).status, "unreconciled");
      storage.losePatch = false;
      // As stored before P6.1: the attempt without descendants, and its
      // receipt sealed over that attempt.
      if (legacy) {
        const id = (await journal(job)).id;
        await admin.query("update clued_private.resource_center_mutations_v1 set provider_attempt=provider_attempt-'descendants' where id=$1", [id]);
        await admin.query(`with m as (select id,provider_attempt_receipt_id r,jsonb_build_object('idempotency_key','storage-provider-attempt:'||id::text,
            'intent_id',id,'attempt_digest',clued_private.m1_sha256(provider_attempt)) q from clued_private.resource_center_mutations_v1 where id=$1)
          update public.clued_audit_receipts x set received_payload_hash=clued_private.m1_sha256(m.q),
            request_sha256=clued_private.m1_sha256(jsonb_build_object('operation','storage_provider_attempt','payload',m.q-'idempotency_key'))
          from m where x.id=m.r`, [id]);
      }
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
        JSON.stringify({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "B".repeat(24) })]);
      const descriptor = (await native.query("select public.clued_storage_native_recovery_load_v2($1,$2::jsonb) value",
        [issuerSecret, JSON.stringify({ action: "recovery_load", ...job.reference })])).rows[0].value;
      assert.equal(descriptor.status, "recovery_only", JSON.stringify(descriptor));
      assert.equal("descendants" in descriptor.attempt, !legacy);
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-subtree-access", scope: SCOPES }),
        fetch: async (url, init = {}) => storage.fetch(url, init) });
      const verify = createGoogleDriveDirectoryMovePostconditionVerifier({ managed_root: descriptor.profile.managed_root, root_folder_id: descriptor.root_folder_id,
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren,
        get_sharing: metadata.getSharing, get_access: metadata.getAccess, include_verified_proof: true });
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "move", target_kind: "directory",
          source_path: descriptor.mutation.source_path, destination_path: descriptor.mutation.destination_path,
          provider_file_id: descriptor.attempt.provider_file_id, subtree_sample: descriptor.attempt.subtree_sample,
          descendants: descriptor.attempt.descendants } });
      const finish = { action: "finalize", intent_id: descriptor.intent_id, base_version: descriptor.version, request_sha256: descriptor.request_sha256,
        idempotency_key: `account-job:${job.reference.job_id}:finalize`, postcondition };
      const recorded = await cloud({ action: "verified_record", ...job.reference, credential_version: descriptor.credential_version, finish, proof });
      assert.equal(recorded.status, "verified", JSON.stringify(recorded));
      const settle = () => cloud({ action: "settle_verified", ...job.reference, intent_id: descriptor.intent_id, base_version: descriptor.version,
        request_sha256: descriptor.request_sha256, verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
      return { ...fixture, job, proof, settle };
    };

    await t.test("P6.1: a verified refresh list cannot be swapped for another", async () => {
      const { target, folder, deep, job, proof } = await lostMove();
      assert.ok(proof.descendant_versions.some(item => item.provider_file_id === deep.provider_file_id));
      const intent = await journal(job);
      const input = (await admin.query("select clued_private.storage_settle_input_v1($1,m,$2::jsonb) value from clued_private.resource_center_mutations_v1 m where m.id=$3",
        [target.profile, JSON.stringify(proof), intent.id])).rows[0].value;
      assert.equal(input.action, "artifact_subtree_move");
      // The exact settlement input with one refreshed version raised.
      const forged = structuredClone(input);
      forged.descendant_versions = forged.descendant_versions.map(item => item.provider_file_id === deep.provider_file_id
        ? { ...item, provider_file_version: String(Number(item.provider_file_version) + 7) } : item);
      const refused = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user, JSON.stringify(forged)])).rows[0].value;
      // Path, Drive ID and version equal the proof: only the refresh list differs.
      assert.equal(refused.error_code, "resource_center_directory_move_requires_subtree_contract", JSON.stringify(refused));
      assert.equal((await artifactById(folder.id)).path, folder.path);
      assert.equal((await artifactById(deep.id)).provider_file_version, deep.provider_file_version);
    });

    await t.test("P6.1: an attempt stored before P6.1 settles and reads back exactly as before, with no refresh", async () => {
      const { topic, folder, deep, job, proof, settle } = await lostMove({ legacy: true });
      assert.equal("descendant_versions" in proof, false);
      const settled = await settle();
      assert.equal(settled.state, "committed", JSON.stringify(settled));
      assert.equal("descendant_versions" in (await journal(job)).verified_result_v2.proof, false);
      const after = await artifactById(deep.id);
      assert.equal(after.path, `${topic.path}/folder/inner/deep.md`);
      assert.equal(after.provider_file_version, deep.provider_file_version, "no refresh without recorded descendants");
      assert.equal((await artifactById(folder.id)).path, `${topic.path}/folder`);
      const inspected = await cloud({ action: "verified_inspect", ...job.reference });
      assert.equal(inspected.status, "committed", JSON.stringify(inspected));
    });

    await t.test("P6.1: the refresh functions refuse a lower, unknown, repeated or mistyped version", async () => {
      const descendants = [{ provider_file_id: "a", provider_file_version: "5" }, { provider_file_id: "b", provider_file_version: "2" }];
      const refresh = async versions => (await admin.query("select clued_private.storage_subtree_refresh_v1($1::jsonb,$2::jsonb) value",
        [JSON.stringify(descendants), JSON.stringify(versions)])).rows[0].value;
      assert.deepEqual(await refresh([{ provider_file_id: "a", provider_file_version: "5" }, { provider_file_id: "b", provider_file_version: "10" }]),
        [{ provider_file_id: "a", provider_file_version: "5" }, { provider_file_id: "b", provider_file_version: "10" }], "numeric, not text, order");
      for (const bad of [[{ provider_file_id: "a", provider_file_version: "4" }], [{ provider_file_id: "c", provider_file_version: "9" }],
        [{ provider_file_id: "a", provider_file_version: "6" }, { provider_file_id: "a", provider_file_version: "7" }],
        [{ provider_file_id: "a", provider_file_version: 6 }], [{ provider_file_id: "a", provider_file_version: "6", extra: 1 }], ["a"],
        [{ provider_file_id: "a", provider_file_version: "6" }, { provider_file_id: "b", provider_file_version: "3" }, { provider_file_id: "x", provider_file_version: "1" }]]) {
        assert.equal(await refresh(bad), null, JSON.stringify(bad));
      }
      assert.equal((await admin.query("select clued_private.storage_subtree_refresh_v1($1::jsonb,'{}'::jsonb) value", [JSON.stringify(descendants)])).rows[0].value, null);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
