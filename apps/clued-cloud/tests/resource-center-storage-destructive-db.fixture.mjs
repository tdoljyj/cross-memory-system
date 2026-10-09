import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import { createGoogleDriveDestructivePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-destructive-postcondition.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const CLOUD = "public.clued_storage_cloud_worker_router_v2";
const JOBS = "public.clued_storage_jobs_router_v2";
const WRITE = "public.clued_storage_write_access_v1";
const CONFIRM = "public.clued_storage_trash_confirmation_v1";
const DISCLOSURE = "clued.storage-destructive-disclosure/1";
const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const TRACK = "20_P_产品与体验";

// StorageFullCapability.v0.1 P5: trash and untrash through the real cloud
// executor (verified-result mode) against disposable PostgreSQL and an
// in-memory Drive. Never Google, never a disk.
export async function testStorageDestructive(t, admin, server, user, decision) {
  await allowTestIssuerCredentials(admin);
  const issuerSecret = randomUUID() + randomUUID();
  const clients = [], session = randomUUID(), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `destructive-${randomUUID()}`, resource = "https://destructive.invalid/mcp";
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
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'destructive-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://destructive.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const createRoot = async () => {
    const suffix = randomUUID(), root = `/destructive-${suffix}/Clued_资料中心`, rootId = `dx-root-${suffix}`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `destructive/${suffix}`,
      managed_root: root, root_folder_id: rootId, root_parent_id: `dx-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/" + TRACK, provider_file_id: `dx-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    const qualified = (await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: [TRACK], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
    assert.equal(qualified.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    assert.equal(connected.status, "committed");
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='destructive-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1", [connection, oauthClient]);
    return { root, rootId, parentId: `dx-parent-${suffix}`, trackId: `dx-track-${suffix}`, profile, connection, receipt: connected.receipt_id };
  };
  const bind = async target => {
    const token = sha(randomUUID()), clientId = `dx-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Destructive fixture", redirect_uri: "https://destructive.invalid/client-callback",
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
          c.source_decision_id,c.decision_version,'reviewed_transition','destructive-fixture/2',c.receipt_id
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
    const directory = (id, name, parent) => ({ id, name, parents: parent ? [parent] : [], version: "1", trashed: false,
      mimeType: "application/vnd.google-apps.folder", ownedByMe: true, capabilities: { canTrash: true, canUntrash: true } });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, TRACK, target.rootId)]]);
    const state = { patches: 0, deletes: 0, losePatch: false, files, directory };
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-destructive-access");
      assert.equal(u.hostname, "www.googleapis.com");
      if (init.method === "DELETE") { state.deletes++; throw new Error("files.delete must never be called"); }
      if (init.method === "PATCH") {
        state.patches++;
        const id = u.pathname.split("/").at(-1), file = files.get(id), body = JSON.parse(init.body || "{}");
        const recorded = (await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1 and provider_attempt->>'contract'='clued.storage-destructive-attempt/1'", [id])).rows[0].n;
        assert.equal(recorded, 1, "the exact attempt is durable before the update");
        assert.ok(Object.keys(body).every(key => key === "trashed" || key === "name"));
        file.trashed = body.trashed;
        if (body.name) file.name = body.name;
        if (u.searchParams.get("addParents")) { assert.deepEqual(file.parents, [u.searchParams.get("removeParents")]); file.parents = [u.searchParams.get("addParents")]; }
        file.version = String(Number(file.version) + 3); // Drive may jump by more than one.
        if (state.losePatch) throw new Error("synthetic lost provider response");
        return Response.json(file);
      }
      if (init.method === "POST") {
        const raw = init.body, match = /\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw), metadata = JSON.parse(match?.[0] ?? raw);
        const attempt = (await admin.query("select provider_attempt from clued_private.resource_center_mutations_v1 where id=$1", [metadata.appProperties.clued_intent_id])).rows[0].provider_attempt;
        const created = { ...metadata, version: "1", trashed: false, size: attempt.size, sha256Checksum: attempt.sha256,
          md5Checksum: "f".repeat(32), headRevisionId: "rev-" + randomUUID(), ownedByMe: true, capabilities: { canTrash: true, canUntrash: true } };
        files.set(metadata.id, created);
        return Response.json(created);
      }
      assert.equal(init.method ?? "GET", "GET");
      if (u.pathname.endsWith("/generateIds")) return Response.json({ ids: ["cloud-object-" + randomUUID()] });
      const query = u.searchParams.get("q");
      if (query) {
        // As Drive: name and folder listings ask trashed = false; the emptiness
        // check of a directory asks for every child, trashed ones included.
        const all = !/trashed = false/.test(query);
        const parent = /'([^']+)' in parents/.exec(query)?.[1], name = /name = '([^']+)'/.exec(query)?.[1];
        return Response.json({ files: [...files.values()].filter(file => file.parents.includes(parent) && (all || !file.trashed) && (!name || name === file.name)), incompleteSearch: false });
      }
      const found = files.get(u.pathname.split("/").at(-1));
      return found ? Response.json(found) : new Response("", { status: 404 });
    };
    return state;
  };
  const executor = (target, storage) => {
    let loaded;
    return createResourceCenterCloudExecutor({ verified_result_mode: true,
      load_job: async ref => {
        loaded = await cloud({ action: "load", ...ref });
        const descriptor = { ...loaded }; delete descriptor.credential_envelope; delete descriptor.oauth_client_id;
        return descriptor;
      },
      get_credential: async expected => ({ ...expected, access_token: "fixture-destructive-access", scope: SCOPES, expires_at_ms: Date.now() + 3600000 }),
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
  const confirmation = async (input, database = native) => (await database.query(`select ${CONFIRM}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const batchRaw = (target, client, items, batchId = randomUUID()) => caller.query("select public.clued_storage_trash_batch_v1($1,$2::jsonb) value",
    [client.token, JSON.stringify({ connection_id: target.connection, batch_id: batchId, items })]);
  const batchOf = async (target, client, items, batchId = randomUUID()) => (await batchRaw(target, client, items, batchId)).rows[0].value;
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
  const createFile = async (target, client, storage, name) => {
    const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/${name}`, content: "destructive fixture" });
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifact(target, job.mutation.destination_path);
  };
  const directoryIn = async (target, storage, name, parentPath = `${target.root}/${TRACK}`, parentId = target.trackId) => {
    const id = `dx-dir-${randomUUID()}`, path = `${parentPath}/${name}`;
    storage.files.set(id, storage.directory(id, name, parentId));
    await register({ action: "artifact_register", profile_id: target.profile, path, provider_file_id: id, provider_file_version: "1",
      target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    return artifact(target, path);
  };
  const setup = async () => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), storage = provider(target);
    const enabled = await setLevel(target, ["destructive"]);
    assert.equal(enabled.status, "committed", JSON.stringify(enabled));
    return { target, client, storage };
  };
  const versionOf = (storage, item) => storage.files.get(item.provider_file_id).version;
  const trash = (item, version = item.provider_file_version, path = item.path) => ({ operation: "delete", target_kind: item.target_kind,
    source_path: path, source_file_version: version, source_file_id: item.provider_file_id });
  const untrash = (item, version = item.provider_file_version, extra = {}) => ({ operation: "restore", target_kind: item.target_kind,
    source_path: item.path, source_file_version: version, source_file_id: item.provider_file_id, ...extra });
  const trashed = async (target, client, storage, item) => {
    const job = await submitJob(target, client, trash(item, versionOf(storage, item)));
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifactById(item.id);
  };

  try {
    await t.test("the destructive level has its own disclosure and replaces the policy like modify and overwrite", async () => {
      const initial = await createRoot(), target = await activate(initial);
      const status = await writeStatus(target);
      assert.equal(status.destructive_disclosure_version, DISCLOSURE); assert.deepEqual(status.classes, []);
      const before = (await admin.query("select auth_generation from clued_private.storage_connections_v1 where id=$1", [target.connection])).rows[0].auth_generation;
      await assert.rejects(setLevel(target, ["destructive"], "clued.storage-modify-disclosure/1"), /storage_write_disclosure_changed/);
      assert.equal((await setLevel(target, ["destructive"])).status, "committed");
      const after = await writeStatus(target);
      assert.deepEqual(after.classes, ["destructive"]); assert.equal(after.policy_generation, status.policy_generation + 1);
      const policy = (await admin.query("select p.actions,p.disclosure_version,c.auth_generation from clued_private.storage_connections_v1 c join clued_private.storage_account_policies_v2 p on p.id=c.account_policy_id where c.id=$1", [target.connection])).rows[0];
      assert.deepEqual(policy.actions, ["inspect", "create_file", "create_topic", "destructive"]);
      assert.equal(policy.disclosure_version, DISCLOSURE); assert.equal(Number(policy.auth_generation), Number(before) + 1);
      assert.equal((await setLevel(target, ["destructive", "modify"], "clued.storage-modify-disclosure/1")).status, "committed");
      assert.deepEqual((await writeStatus(target)).classes, ["destructive", "modify"]);
      assert.equal((await setLevel(target, ["modify"], DISCLOSURE)).status, "committed");
      const stopped = (await admin.query("select p.actions,p.disclosure_version from clued_private.storage_connections_v1 c join clued_private.storage_account_policies_v2 p on p.id=c.account_policy_id where c.id=$1", [target.connection])).rows[0];
      assert.deepEqual(stopped.actions, ["inspect", "create_file", "create_topic", "modify"]);
      assert.equal(stopped.disclosure_version, "clued.storage-destructive-disabled/1");
    });

    await t.test("trash then untrash a Clued-created file by its Drive ID; the Artifact follows by CAS and nothing is ever deleted", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "draft.txt");
      const file = storage.files.get(created.provider_file_id);
      const job = await submitJob(target, client, trash(created, file.version));
      const done = await executor(target, storage).run(job.reference);
      assert.equal(done.status, "committed", JSON.stringify(done));
      assert.equal(storage.patches, 1); assert.equal(storage.deletes, 0); assert.equal(file.trashed, true);
      const afterTrash = await artifact(target, created.path, "trashed");
      assert.equal(afterTrash.id, created.id, "the same Artifact; nothing new was registered");
      assert.equal(afterTrash.provider_file_version, file.version, "a version jump of more than one is recorded");
      assert.equal(Number(afterTrash.version), Number(created.version) + 1);
      assert.equal(await artifact(target, created.path), undefined);
      const intent = await journal(job);
      assert.equal(intent.state, "committed"); assert.equal(intent.provider_attempt.contract, "clued.storage-destructive-attempt/1");
      assert.equal(intent.verified_result_v2.proof.contract, "clued.storage-trash-verified/1");
      const retention = (await admin.query("select change_summary from public.clued_context_events where user_id=$1 and idempotency_key=$2",
        [user, "storage-settle-verified:" + intent.id])).rows[0].change_summary;
      assert.match(retention.trash_retention, /30 days/);
      const restore = await submitJob(target, client, untrash(afterTrash, file.version));
      const restored = await executor(target, storage).run(restore.reference);
      assert.equal(restored.status, "committed", JSON.stringify(restored));
      assert.equal(storage.patches, 2); assert.equal(file.trashed, false);
      const afterRestore = await artifact(target, created.path);
      assert.equal(afterRestore.id, created.id); assert.equal(afterRestore.provider_file_version, file.version);
      assert.equal((await journal(restore)).verified_result_v2.proof.contract, "clued.storage-untrash-verified/1");
      const replay = (await submitRaw(target, client, restore.mutation, restore.reference.job_id)).rows[0].value;
      assert.equal(replay.replayed, true); assert.equal(replay.status, "committed");
    });

    await t.test("untrash names the item by Drive ID: trash A, a new B at the same path, trash B, then untrash A", async () => {
      const { target, client, storage } = await setup();
      const a = await createFile(target, client, storage, "same.txt");
      const trashedA = await trashed(target, client, storage, a);
      const b = await createFile(target, client, storage, "same.txt");
      assert.notEqual(b.id, a.id);
      const trashedB = await trashed(target, client, storage, b);
      // Exactly one trashed row matches each untrash job.
      const jobA = await submitJob(target, client, untrash(trashedA));
      const descriptor = await cloud({ action: "load", ...jobA.reference });
      assert.deepEqual(descriptor.untrash_source, { provider_file_id: a.provider_file_id, provider_file_version: trashedA.provider_file_version });
      const result = await executor(target, storage).run(jobA.reference);
      assert.equal(result.status, "committed", JSON.stringify(result));
      assert.equal((await artifact(target, a.path)).id, a.id, "A is back; B stays trashed");
      assert.equal((await artifactById(b.id)).state, "trashed");
      assert.equal(storage.files.get(a.provider_file_id).trashed, false); assert.equal(storage.files.get(b.provider_file_id).trashed, true);
      // B now conflicts with A: refused at submit with the fixed, explanatory code.
      await assert.rejects(submitRaw(target, client, untrash(trashedB)), /restore_name_conflict/);
      // A job naming an item ID that is not the registered one gets no source.
      const wrong = await submitJob(target, client, { ...untrash(trashedB), source_file_id: a.provider_file_id, source_path: `${target.root}/${TRACK}/other.txt` });
      assert.equal((await cloud({ action: "load", ...wrong.reference })).untrash_source, null);
    });

    await t.test("untrash after a name conflict: only the user's explicit folder or numbered-name option, both settle the same Artifact", async () => {
      const { target, client, storage } = await setup();
      const topic = await directoryIn(target, storage, "topic-b");
      const one = await createFile(target, client, storage, "note.md"), two = await createFile(target, client, storage, "plan.md");
      const t1 = await trashed(target, client, storage, one), t2 = await trashed(target, client, storage, two);
      // A same-name file the Owner put in Drive by hand (not registered) blocks the in-place untrash at execution.
      storage.files.set("owner-note", { id: "owner-note", name: "note.md", parents: [target.trackId], version: "1", trashed: false, mimeType: "text/plain" });
      const blocked = await submitJob(target, client, untrash(t1));
      const before = storage.patches;
      const denied = await executor(target, storage).run(blocked.reference);
      assert.equal(denied.status, "deny"); assert.equal(denied.error_code, "RESTORE_NAME_CONFLICT");
      assert.equal(storage.patches, before);
      assert.equal((await report(blocked, denied)).status, "denied");
      const inspected = (await caller.query(`select ${JOBS}($1,$2::jsonb) value`, [client.token, JSON.stringify({ action: "inspect", ...blocked.reference })])).rows[0].value;
      assert.equal(inspected.reason_code, "RESTORE_NAME_CONFLICT");
      // Option 1: restore into another registered folder under the same name.
      const moved = await submitJob(target, client, untrash(t1, t1.provider_file_version, { destination_path: `${topic.path}/note.md`, restore_mode: "folder" }));
      assert.equal((await executor(target, storage).run(moved.reference)).status, "committed");
      const afterMove = await artifactById(one.id);
      assert.equal(afterMove.state, "active"); assert.equal(afterMove.path, `${topic.path}/note.md`);
      assert.deepEqual(storage.files.get(one.provider_file_id).parents, [topic.provider_file_id]);
      // Option 2: a numbered name in the original folder.
      storage.files.set("owner-plan", { id: "owner-plan", name: "plan.md", parents: [target.trackId], version: "1", trashed: false, mimeType: "text/plain" });
      const renamed = await submitJob(target, client, untrash(t2, t2.provider_file_version, { destination_path: `${target.root}/${TRACK}/plan (1).md`, restore_mode: "suffix" }));
      const renamedResult = await executor(target, storage).run(renamed.reference);
      assert.equal(renamedResult.status, "committed", JSON.stringify(renamedResult));
      assert.equal((await artifactById(two.id)).path, `${target.root}/${TRACK}/plan (1).md`);
      assert.equal(storage.files.get(two.provider_file_id).name, "plan (1).md");
      assert.equal((await journal(renamed)).verified_result_v2.proof.restore_mode, "suffix");
      // Any other shape of the options is refused at submit.
      for (const extra of [{ destination_path: `${target.root}/${TRACK}/plan (0).md`, restore_mode: "suffix" },
        { destination_path: `${topic.path}/other.md`, restore_mode: "folder" }, { destination_path: `${topic.path}/note.md` }]) {
        await assert.rejects(submitRaw(target, client, untrash(t2, "9", extra)), /storage_job_input_invalid/, JSON.stringify(extra));
      }
      await assert.rejects(submitRaw(target, client, { ...trash(afterMove), destination_path: `${topic.path}/x.md`, restore_mode: "folder" }),
        /storage_job_input_invalid/);
    });

    await t.test("an empty registered directory is trashed and untrashed; non-empty ones, tracks and the root are refused", async () => {
      const { target, client, storage } = await setup();
      const empty = await directoryIn(target, storage, "empty-topic");
      const job = await submitJob(target, client, trash(empty, versionOf(storage, empty)));
      const done = await executor(target, storage).run(job.reference);
      assert.equal(done.status, "committed", JSON.stringify(done));
      assert.equal(storage.files.get(empty.provider_file_id).trashed, true);
      const proof = (await journal(job)).verified_result_v2.proof;
      assert.equal(proof.target_kind, "directory"); assert.equal(proof.content, null); assert.equal(proof.checks.empty, true);
      const back = await submitJob(target, client, untrash(await artifactById(empty.id), versionOf(storage, empty)));
      assert.equal((await executor(target, storage).run(back.reference)).status, "committed");
      assert.equal((await artifactById(empty.id)).state, "active");
      // A registered item inside: refused by the authority before any reservation.
      const full = await directoryIn(target, storage, "full-topic");
      await directoryIn(target, storage, "inner", full.path, full.provider_file_id);
      const before = await counters(), patches = storage.patches;
      const registered = await submitJob(target, client, trash(full, versionOf(storage, full)));
      assert.equal((await executor(target, storage).run(registered.reference)).status, "deny");
      // Only an unregistered (even trashed) item in Drive: DIRECTORY_NOT_EMPTY, still before any reservation.
      const hidden = await directoryIn(target, storage, "hidden-topic");
      storage.files.set("hidden-child", { id: "hidden-child", name: "x.txt", parents: [hidden.provider_file_id], version: "1", trashed: true, mimeType: "text/plain" });
      const driveOnly = await submitJob(target, client, trash(hidden, versionOf(storage, hidden)));
      const refused = await executor(target, storage).run(driveOnly.reference);
      assert.equal(refused.status, "deny"); assert.equal(refused.error_code, "DIRECTORY_NOT_EMPTY");
      assert.equal(storage.patches, patches); assert.equal((await counters()).intents, before.intents);
      // A track is refused at submit; the root is never a path.
      const track = await artifact(target, `${target.root}/${TRACK}`);
      await assert.rejects(submitRaw(target, client, trash(track, "1")), /storage_job_input_invalid/);
      await assert.rejects(submitRaw(target, client, { ...trash(track, "1"), source_path: target.root }), /storage_path_invalid/);
    });

    await t.test("a governance file without delete authority, another owner's file, a stale version or another item's ID is refused with zero updates", async () => {
      const { target, client, storage } = await setup();
      const owned = await createFile(target, client, storage, "owned.txt");
      const other = await createFile(target, client, storage, "other.txt");
      const foreign = await createFile(target, client, storage, "foreign.txt");
      Object.assign(storage.files.get(foreign.provider_file_id), { ownedByMe: false, capabilities: { canTrash: false, canUntrash: false } });
      const governance = await createFile(target, client, storage, "governed.txt");
      await register({ action: "artifact_update", profile_id: target.profile, artifact_id: governance.id, base_version: Number(governance.version),
        path: governance.path, provider_file_id: governance.provider_file_id, provider_file_version: governance.provider_file_version,
        governance_class: "governance", delete_authority: false });
      const cases = [
        [trash(governance, versionOf(storage, governance))],
        [trash(foreign, versionOf(storage, foreign)), "PROVIDER_OWNER_REQUIRED"],
        [trash(owned, String(Number(versionOf(storage, owned)) + 1))],
        [{ ...trash(owned, versionOf(storage, owned)), source_file_id: other.provider_file_id }],
      ];
      for (const [mutation, code] of cases) {
        const before = await counters(), job = await submitJob(target, client, mutation);
        const result = await executor(target, storage).run(job.reference);
        assert.equal(result.status, "deny", JSON.stringify({ mutation, result }));
        if (code) assert.equal(result.error_code, code);
        assert.equal(storage.patches, 0, "no provider update was attempted");
        assert.equal((await counters()).intents, before.intents, "no durable reservation was made");
      }
      assert.equal((await artifact(target, owned.path)).id, owned.id);
    });

    await t.test("artifact_trash settles only by CAS on the Artifact version", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "cas.txt");
      const input = { action: "artifact_trash", profile_id: target.profile, artifact_id: created.id, path: created.path,
        provider_file_id: created.provider_file_id, provider_file_version: "9", source_decision_id: decision };
      for (const bad of [{ base_version: Number(created.version) + 1 }, { base_version: Number(created.version), path: `${target.root}/${TRACK}/x.txt` },
        { base_version: Number(created.version), provider_file_id: "other-id" }]) {
        const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
          JSON.stringify({ ...input, ...bad, idempotency_key: randomUUID() })])).rows[0].value;
        assert.equal(result.status, "rejected", JSON.stringify(bad));
      }
      assert.equal((await artifactById(created.id)).state, "active");
    });

    await t.test("without the destructive level, or in another shape, submit is refused", async () => {
      const initial = await createRoot(), client = await bind(initial), target = await activate(initial);
      const item = { path: `${target.root}/${TRACK}/a.txt`, provider_file_id: "drive-a", provider_file_version: "3", target_kind: "file" };
      await assert.rejects(submitRaw(target, client, trash(item)), /storage_policy_denied/);
      await assert.rejects(batchRaw(target, client, [trash(item)]), /storage_policy_denied/);
      const enabled = await setup();
      const path = `${enabled.target.root}/${TRACK}/a.txt`, good = trash({ ...item, path });
      for (const mutation of [{ ...good, destination_path: path }, { ...good, content: "x" }, { ...good, source_file_version: "03" },
        { operation: "delete", target_kind: "file", source_path: path, source_file_version: "3" }, { ...good, source_file_id: "bad id" },
        { ...good, restore_mode: "folder" }, { ...untrash({ ...item, path }), directory_semantics: "topic" },
        { operation: "create", target_kind: "file", destination_path: path, content: "x", source_file_id: "drive-a" }]) {
        await assert.rejects(submitRaw(enabled.target, enabled.client, mutation), /storage_job_input_invalid/, JSON.stringify(mutation));
      }
    });

    await t.test("beyond 5 trash jobs the Agent registers one batch and the Owner confirms it once; each item covers one job", async () => {
      const { target, client, storage } = await setup();
      const files = [];
      for (let i = 0; i < 9; i++) files.push(await createFile(target, client, storage, `batch-${i}.txt`));
      const mutationOf = file => trash(file, versionOf(storage, file));
      for (const file of files.slice(0, 5)) await submitJob(target, client, mutationOf(file));
      const before = await counters();
      await assert.rejects(submitRaw(target, client, mutationOf(files[5])), /owner_batch_confirmation_required/);
      assert.equal((await counters()).jobs, before.jobs, "the refusal creates no job");
      // Another client registration has its own count.
      const other = await bind(target);
      await submitJob(target, other, mutationOf(files[8]));
      // The Agent lists the remaining items once; a wrong version is refused for the whole batch.
      await assert.rejects(batchRaw(target, client, [mutationOf(files[5]), { ...mutationOf(files[6]), source_file_version: "999" }]),
        /storage_trash_batch_item_unavailable/);
      const batchId = randomUUID(), items = [mutationOf(files[5]), mutationOf(files[6])];
      const pending = await batchOf(target, client, items, batchId);
      assert.equal(pending.status, "pending"); assert.equal(pending.items.length, 2); assert.equal(pending.replayed, false);
      assert.equal((await batchOf(target, client, items, batchId)).replayed, true, "same batch_id and items: the same batch");
      await assert.rejects(batchRaw(target, client, [items[0]], batchId), /storage_trash_batch_conflict/);
      // Still refused until the Owner confirms.
      await assert.rejects(submitRaw(target, client, mutationOf(files[5])), /owner_batch_confirmation_required/);
      const status = await confirmation({ action: "status", connection_id: target.connection });
      assert.equal(status.destructive, true); assert.equal(status.limit, 5); assert.equal(status.batches_truncated, false);
      const listed = status.batches.find(batch => batch.batch_id === batchId);
      assert.equal(listed.status, "pending"); assert.deepEqual(listed.items.map(item => item.path), [files[5].path, files[6].path]);
      assert.ok(listed.items.every(item => item.current && !item.used));
      await assert.rejects(confirmation({ action: "confirm", connection_id: target.connection, batch_id: batchId,
        base_generation: status.policy_generation + 1, idempotency_key: randomUUID() }), /storage_owner_version_conflict/);
      const key = randomUUID();
      const confirmed = await confirmation({ action: "confirm", connection_id: target.connection, batch_id: batchId,
        base_generation: status.policy_generation, idempotency_key: key });
      assert.equal(confirmed.status, "committed", JSON.stringify(confirmed));
      const event = (await admin.query("select change_summary from public.clued_context_events where user_id=$1 and idempotency_key=$2", [user, key])).rows[0].change_summary;
      assert.deepEqual(event.items.map(item => item.provider_file_id), [files[5].provider_file_id, files[6].provider_file_id]);
      assert.equal(JSON.stringify(event).includes(files[5].path), false, "events carry Drive IDs and versions, never paths");
      await assert.rejects(confirmation({ action: "confirm", connection_id: target.connection, batch_id: batchId,
        base_generation: status.policy_generation, idempotency_key: randomUUID() }), /storage_owner_version_conflict/, "confirmed once");
      assert.equal((await batchOf(target, client, items, batchId)).status, "confirmed");
      // The other client registration cannot use this batch.
      for (const file of files.slice(0, 4)) await submitJob(target, other, mutationOf(file), randomUUID()).catch(() => {});
      await assert.rejects(submitRaw(target, other, mutationOf(files[5])), /owner_batch_confirmation_required/);
      // Covered: the sixth job proceeds; replay needs nothing more; the item is used once.
      const jobId = randomUUID();
      await submitJob(target, client, mutationOf(files[5]), jobId);
      assert.equal((await submitRaw(target, client, mutationOf(files[5]), jobId)).rows[0].value.replayed, true);
      await assert.rejects(submitRaw(target, client, mutationOf(files[5])), /owner_batch_confirmation_required/, "an item covers one job");
      // Not reusable for another version or another item.
      await assert.rejects(submitRaw(target, client, { ...mutationOf(files[6]), source_file_version: "999" }), /owner_batch_confirmation_required/);
      await assert.rejects(submitRaw(target, client, mutationOf(files[7])), /owner_batch_confirmation_required/);
      // A covered job refused before any reservation frees its item again.
      storage.files.get(files[6].provider_file_id).ownedByMe = false;
      const refusedJob = await submitJob(target, client, mutationOf(files[6]));
      const refused = await executor(target, storage).run(refusedJob.reference);
      assert.equal(refused.error_code, "PROVIDER_OWNER_REQUIRED");
      await report(refusedJob, refused);
      assert.equal((await batchOf(target, client, items, batchId)).items[1].used, false);
      storage.files.get(files[6].provider_file_id).ownedByMe = true;
      await submitJob(target, client, mutationOf(files[6]));
      assert.equal((await batchOf(target, client, items, batchId)).items[1].used, true);
    });

    await t.test("a confirmed batch expires after 24 hours and is voided by a policy replacement", async () => {
      const { target, client, storage } = await setup();
      const files = [];
      for (let i = 0; i < 8; i++) files.push(await createFile(target, client, storage, `expiry-${i}.txt`));
      const mutationOf = file => trash(file, versionOf(storage, file));
      for (const file of files.slice(0, 5)) await submitJob(target, client, mutationOf(file));
      const confirm = async items => {
        const batchId = randomUUID();
        await batchOf(target, client, items, batchId);
        const status = await confirmation({ action: "status", connection_id: target.connection });
        const done = await confirmation({ action: "confirm", connection_id: target.connection, batch_id: batchId,
          base_generation: status.policy_generation, idempotency_key: randomUUID() });
        assert.equal(done.status, "committed");
        return batchId;
      };
      const expiring = await confirm([mutationOf(files[5])]);
      await admin.query("set session_replication_role=replica");
      try {
        await admin.query("update clued_private.storage_trash_batches_v1 set confirmed_at=confirmed_at-interval '25 hours',confirmed_expires_at=clock_timestamp()-interval '1 hour' where owner_id=$1 and id=$2", [user, expiring]);
      } finally { await admin.query("set session_replication_role=origin"); }
      assert.equal((await batchOf(target, client, [mutationOf(files[5])], expiring)).status, "expired");
      await assert.rejects(submitRaw(target, client, mutationOf(files[5])), /owner_batch_confirmation_required/);
      // An unconfirmed pending batch also expires and can no longer be confirmed.
      const stale = randomUUID();
      await batchOf(target, client, [mutationOf(files[7])], stale);
      await admin.query("set session_replication_role=replica");
      try {
        await admin.query("update clued_private.storage_trash_batches_v1 set created_at=created_at-interval '25 hours',expires_at=clock_timestamp()-interval '1 hour' where owner_id=$1 and id=$2", [user, stale]);
      } finally { await admin.query("set session_replication_role=origin"); }
      const listed = await confirmation({ action: "status", connection_id: target.connection });
      assert.equal(listed.batches.some(batch => batch.batch_id === stale), false);
      await assert.rejects(confirmation({ action: "confirm", connection_id: target.connection, batch_id: stale,
        base_generation: listed.policy_generation, idempotency_key: randomUUID() }), /storage_owner_version_conflict/);
      const replaced = await confirm([mutationOf(files[6])]);
      assert.equal((await setLevel(target, ["destructive", "modify"], "clued.storage-modify-disclosure/1")).status, "committed");
      assert.equal((await batchOf(target, client, [mutationOf(files[6])], replaced)).status, "voided");
      // The level change cancelled the queued jobs (they no longer count); five new ones reach the limit again.
      for (const file of files.slice(0, 5)) await submitJob(target, client, mutationOf(file));
      await assert.rejects(submitRaw(target, client, mutationOf(files[6])), /owner_batch_confirmation_required/);
      assert.equal((await confirmation({ action: "status", connection_id: target.connection })).batches.length, 0);
    });

    await t.test("the confirmation RPC is native-session only and owner-scoped", async () => {
      const { target, client, storage } = await setup();
      const file = await createFile(target, client, storage, "auth.txt");
      const batchId = randomUUID();
      await batchOf(target, client, [trash(file, versionOf(storage, file))], batchId);
      const input = { action: "confirm", connection_id: target.connection, batch_id: batchId, base_generation: 2, idempotency_key: randomUUID() };
      await assert.rejects(caller.query(`select ${CONFIRM}($1::jsonb)`, [JSON.stringify(input)]), /permission denied/);
      const sessionless = await connect("authenticated");
      await sessionless.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify({ sub: user })]);
      await assert.rejects(confirmation(input, sessionless), /storage_native_session_required/);
      const stranger = randomUUID(), strangerSession = randomUUID();
      await admin.query("insert into auth.users(id,email) values($1,$2)", [stranger, `stranger-${stranger}@example.invalid`]);
      await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [strangerSession, stranger]);
      const outsider = await connect("authenticated");
      await outsider.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [stranger, JSON.stringify({ sub: stranger, session_id: strangerSession })]);
      await assert.rejects(confirmation({ action: "status", connection_id: target.connection }, outsider), /storage_owner_denied|storage_owner|42501|denied/);
      await assert.rejects(confirmation(input, outsider), /storage_owner_denied|denied/);
      assert.equal((await batchOf(target, client, [trash(file, versionOf(storage, file))], batchId)).status, "pending");
    });

    await t.test("a revoked Binding learns nothing about the registry: every destructive submit is storage_policy_denied", async () => {
      const { target, client, storage } = await setup();
      const a = await createFile(target, client, storage, "taken.txt");
      const trashedA = await trashed(target, client, storage, a);
      await createFile(target, client, storage, "taken.txt");
      // With a live Binding the conflict is explained; after revocation it is not.
      await assert.rejects(submitRaw(target, client, untrash(trashedA)), /restore_name_conflict/);
      await admin.query("update public.clued_agent_bindings set revoked_at=now() where id=$1", [client.id]);
      const track = await artifact(target, `${target.root}/${TRACK}`);
      for (const mutation of [untrash(trashedA), untrash({ ...trashedA, path: `${target.root}/${TRACK}/never-existed.txt` }), trash(track, "1")]) {
        await assert.rejects(submitRaw(target, client, mutation), error => /storage_policy_denied/.test(error.message), JSON.stringify(mutation));
      }
    });

    await t.test("at most 5 batches wait for the Owner per client registration and connection", async () => {
      const { target, client, storage } = await setup();
      const file = await createFile(target, client, storage, "pending.txt");
      const items = [trash(file, versionOf(storage, file))], ids = [];
      for (let i = 0; i < 5; i++) { ids.push(randomUUID()); assert.equal((await batchOf(target, client, items, ids[i])).status, "pending"); }
      const receipts = async () => (await admin.query("select count(*)::int n from public.clued_audit_receipts where user_id=$1", [user])).rows[0].n;
      const before = await receipts();
      await assert.rejects(batchRaw(target, client, items), /storage_trash_batch_pending_limit/);
      assert.equal(await receipts(), before, "the refusal writes no receipt");
      assert.equal((await batchOf(target, client, items, ids[0])).replayed, true, "an existing batch can still be read");
      // Another client registration has its own allowance.
      assert.equal((await batchOf(target, await bind(target), items)).status, "pending");
      // Confirming one frees a place.
      const status = await confirmation({ action: "status", connection_id: target.connection });
      assert.equal((await confirmation({ action: "confirm", connection_id: target.connection, batch_id: ids[0],
        base_generation: status.policy_generation, idempotency_key: randomUUID() })).status, "committed");
      assert.equal((await batchOf(target, client, items)).status, "pending");
    });

    await t.test("a lost update reply leaves the intent fenced; recovery re-verifies by GET and settles once", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "lost.txt");
      storage.losePatch = true;
      const job = await submitJob(target, client, trash(created, versionOf(storage, created)));
      const result = await executor(target, storage).run(job.reference);
      assert.equal(result.status, "unreconciled");
      assert.equal(storage.patches, 1);
      const row = await journal(job);
      assert.equal(row.state, "started", "the uncertain effect stays fenced");
      assert.equal((await artifact(target, created.path)).id, created.id, "no settlement without a verified proof");
      await admin.query("update clued_private.storage_connections_v1 set credential_envelope=$2::jsonb where id=$1", [target.connection,
        JSON.stringify({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "B".repeat(24) })]);
      await admin.query("update clued_private.resource_center_mutations_v1 set created_at=clock_timestamp()-interval '20 minutes' where id=$1", [row.id]);
      await admin.query("update public.clued_audit_receipts set created_at=clock_timestamp()-interval '30 seconds' where id=$1", [row.provider_attempt_receipt_id]);
      const descriptor = (await caller.query("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) value",
        [issuer, JSON.stringify({ action: "load", ...job.reference })])).rows[0].value;
      assert.equal(descriptor.status, "recovery_only"); assert.equal(descriptor.attempt.contract, "clued.storage-destructive-attempt/1");
      assert.equal(descriptor.attempt.parent_id, descriptor.provider_before.source_parent_id);
      const patches = storage.patches;
      const metadata = createGoogleDriveMetadataApi({ get_credential: async () => ({ access_token: "fixture-destructive-access", scope: SCOPES }),
        fetch: async (url, init = {}) => { assert.equal(init.method ?? "GET", "GET"); return storage.fetch(url, init); } });
      const verify = createGoogleDriveDestructivePostconditionVerifier({ managed_root: descriptor.profile.managed_root, root_folder_id: descriptor.root_folder_id,
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren,
        has_children: metadata.hasChildren, include_verified_proof: true });
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "delete", source_path: descriptor.mutation.source_path,
          destination_path: null, provider_file_id: descriptor.attempt.provider_file_id, content: descriptor.attempt.content } });
      const finish = { action: "finalize", intent_id: descriptor.intent_id, base_version: descriptor.version, request_sha256: descriptor.request_sha256,
        idempotency_key: `account-job:${job.reference.job_id}:finalize`, postcondition };
      const recorded = await cloud({ action: "verified_record", ...job.reference, credential_version: descriptor.credential_version, finish, proof });
      assert.equal(recorded.status, "verified", JSON.stringify(recorded));
      const settled = await cloud({ action: "settle_verified", ...job.reference, intent_id: descriptor.intent_id, base_version: descriptor.version,
        request_sha256: descriptor.request_sha256, verified_receipt_id: recorded.verified_receipt_id, verified_digest: recorded.verified_digest });
      assert.equal(settled.state, "committed", JSON.stringify(settled));
      assert.equal(storage.patches, patches, "recovery never repeats the update");
      assert.equal((await artifact(target, created.path, "trashed")).id, created.id);
    });
  } finally {
    for (const database of clients.reverse()) await database.end().catch(() => {});
  }
}
