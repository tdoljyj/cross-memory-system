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
    const directory = (id, name, parent) => ({ id, name, parents: parent ? [parent] : [], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    const files = new Map([[target.parentId, directory(target.parentId, target.root.split("/").at(-2))],
      [target.rootId, directory(target.rootId, "Clued_资料中心", target.parentId)], [target.trackId, directory(target.trackId, TRACK, target.rootId)]]);
    const state = { patches: 0, deletes: 0, losePatch: false, files };
    state.fetch = async (url, init = {}) => {
      const u = new URL(url); assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-destructive-access");
      assert.equal(u.hostname, "www.googleapis.com");
      if (init.method === "DELETE") { state.deletes++; throw new Error("files.delete must never be called"); }
      if (init.method === "PATCH") {
        state.patches++;
        const id = u.pathname.split("/").at(-1), file = files.get(id), body = JSON.parse(init.body || "{}");
        const recorded = (await admin.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1 and provider_attempt->>'contract'='clued.storage-destructive-attempt/1'", [id])).rows[0].n;
        assert.equal(recorded, 1, "the exact attempt is durable before the update");
        assert.deepEqual(Object.keys(body), ["trashed"]);
        file.trashed = body.trashed;
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
        // As Drive: every query here asks trashed = false.
        assert.match(query, /trashed = false/);
        const parent = /'([^']+)' in parents/.exec(query)?.[1], name = /name = '([^']+)'/.exec(query)?.[1];
        return Response.json({ files: [...files.values()].filter(file => file.parents.includes(parent) && !file.trashed && (!name || name === file.name)), incompleteSearch: false });
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
  const writeStatus = async target => (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "status", connection_id: target.connection })])).rows[0].value;
  const setLevel = async (target, classes, disclosure = DISCLOSURE) => {
    const status = await writeStatus(target);
    return (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: target.connection,
      classes, base_generation: status.policy_generation, disclosure_version: disclosure, idempotency_key: randomUUID() })])).rows[0].value;
  };
  const confirmation = async input => (await native.query(`select ${CONFIRM}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;
  const submitRaw = (target, client, mutation, jobId = randomUUID()) => caller.query(`select ${JOBS}($1,$2::jsonb) value`,
    [client.token, JSON.stringify({ action: "submit", connection_id: target.connection, job_id: jobId, mutation })]);
  const submitJob = async (target, client, mutation, jobId = randomUUID()) => {
    const result = (await submitRaw(target, client, mutation, jobId)).rows[0].value;
    assert.equal(result.status, "queued", JSON.stringify(result));
    return { reference: { connection_id: target.connection, job_id: jobId }, mutation, result };
  };
  const artifact = async (target, path, state = "active") => (await admin.query(
    "select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2 and state=$3", [target.profile, path, state])).rows[0];
  const createFile = async (target, client, storage, name) => {
    const job = await submitJob(target, client, { operation: "create", target_kind: "file", destination_path: `${target.root}/${TRACK}/${name}`, content: "destructive fixture" });
    const result = await executor(target, storage).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify(result));
    return artifact(target, job.mutation.destination_path);
  };
  const setup = async () => {
    const initial = await createRoot(), client = await bind(initial), target = await activate(initial), storage = provider(target);
    const enabled = await setLevel(target, ["destructive"]);
    assert.equal(enabled.status, "committed", JSON.stringify(enabled));
    return { target, client, storage };
  };
  const trash = (path, version) => ({ operation: "delete", target_kind: "file", source_path: path, source_file_version: version });
  const untrash = (path, version) => ({ operation: "restore", target_kind: "file", source_path: path, source_file_version: version });

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

    await t.test("trash then untrash a Clued-created file; the Artifact follows by CAS and nothing is ever deleted", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "draft.txt");
      const file = storage.files.get(created.provider_file_id);
      const job = await submitJob(target, client, trash(created.path, file.version));
      const trashed = await executor(target, storage).run(job.reference);
      assert.equal(trashed.status, "committed", JSON.stringify(trashed));
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
      // The trashed file's own version is what untrash names.
      const restore = await submitJob(target, client, untrash(created.path, file.version));
      const restored = await executor(target, storage).run(restore.reference);
      assert.equal(restored.status, "committed", JSON.stringify(restored));
      assert.equal(storage.patches, 2); assert.equal(file.trashed, false);
      const afterRestore = await artifact(target, created.path);
      assert.equal(afterRestore.id, created.id); assert.equal(afterRestore.provider_file_version, file.version);
      assert.equal((await journal(restore)).verified_result_v2.proof.contract, "clued.storage-untrash-verified/1");
      // Replaying the same job and payload returns the original job, no new effect.
      const replay = (await submitRaw(target, client, restore.mutation, restore.reference.job_id)).rows[0].value;
      assert.equal(replay.replayed, true); assert.equal(replay.status, "committed");
    });

    await t.test("a governance file without delete authority, another owner's file, a stale version or the track is refused with zero updates", async () => {
      const { target, client, storage } = await setup();
      const owned = await createFile(target, client, storage, "owned.txt");
      const foreign = await createFile(target, client, storage, "foreign.txt");
      Object.assign(storage.files.get(foreign.provider_file_id), { ownedByMe: false, capabilities: { canTrash: false, canUntrash: false } });
      const governance = await createFile(target, client, storage, "governed.txt");
      await register({ action: "artifact_update", profile_id: target.profile, artifact_id: governance.id, base_version: Number(governance.version),
        path: governance.path, provider_file_id: governance.provider_file_id, provider_file_version: governance.provider_file_version,
        governance_class: "governance", delete_authority: false });
      const version = id => storage.files.get(id).version;
      const cases = [
        [trash(governance.path, version(governance.provider_file_id)), "deny"],
        [trash(foreign.path, version(foreign.provider_file_id)), "deny", "PROVIDER_OWNER_REQUIRED"],
        [trash(owned.path, String(Number(version(owned.provider_file_id)) + 1)), "deny"],
        [trash(`${target.root}/${TRACK}`, "1"), "deny"],
      ];
      for (const [mutation, status, code] of cases) {
        const before = await counters(), job = await submitJob(target, client, mutation);
        const result = await executor(target, storage).run(job.reference);
        assert.equal(result.status, status, JSON.stringify({ mutation, result }));
        if (code) assert.equal(result.error_code, code);
        assert.equal(storage.patches, 0, "no provider update was attempted");
        assert.equal((await counters()).intents, before.intents, "no durable reservation was made");
      }
      assert.equal((await artifact(target, owned.path)).id, owned.id);
    });

    await t.test("untrash is refused while a new file holds the name; the trashed Artifact stays", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "taken.txt");
      const job = await submitJob(target, client, trash(created.path, storage.files.get(created.provider_file_id).version));
      assert.equal((await executor(target, storage).run(job.reference)).status, "committed");
      const replacement = await createFile(target, client, storage, "taken.txt");
      assert.notEqual(replacement.id, created.id);
      const patches = storage.patches;
      const restore = await submitJob(target, client, untrash(created.path, storage.files.get(created.provider_file_id).version));
      const result = await executor(target, storage).run(restore.reference);
      assert.equal(result.status, "deny", JSON.stringify(result));
      assert.equal(storage.patches, patches);
      assert.equal((await artifact(target, created.path, "trashed")).id, created.id);
    });

    await t.test("without the destructive level, or in another shape, submit is refused", async () => {
      const initial = await createRoot(), client = await bind(initial), target = await activate(initial);
      const source = `${target.root}/${TRACK}/a.txt`;
      await assert.rejects(submitRaw(target, client, trash(source, "3")), /storage_policy_denied/);
      const enabled = await setup(), root = enabled.target.root;
      const path = `${root}/${TRACK}/a.txt`;
      for (const mutation of [{ ...trash(path, "3"), target_kind: "directory" }, { ...trash(path, "3"), destination_path: path },
        { ...trash(path, "3"), content: "x" }, { ...trash(path, "03") }, { operation: "delete", target_kind: "file", source_path: path },
        { ...untrash(path, "3"), directory_semantics: "topic" }]) {
        await assert.rejects(submitRaw(enabled.target, enabled.client, mutation), /storage_job_input_invalid/, JSON.stringify(mutation));
      }
    });

    await t.test("beyond 5 trash jobs in 24 hours each file needs the Owner's native confirmation, consumed once", async () => {
      const { target, client, storage } = await setup();
      const files = [];
      for (let i = 0; i < 8; i++) files.push(await createFile(target, client, storage, `batch-${i}.txt`));
      const mutationOf = file => trash(file.path, storage.files.get(file.provider_file_id).version);
      for (const file of files.slice(0, 5)) await submitJob(target, client, mutationOf(file));
      const before = await counters();
      await assert.rejects(submitRaw(target, client, mutationOf(files[5])), /storage_trash_confirmation_required/);
      assert.equal((await counters()).jobs, before.jobs, "the refusal creates no job");
      // Another client lineage has its own count.
      const other = await bind(target);
      await submitJob(target, other, mutationOf(files[7]));
      // The Owner lists the registered files and confirms exactly one of them.
      const status = await confirmation({ action: "status", connection_id: target.connection });
      assert.equal(status.destructive, true); assert.equal(status.limit, 5);
      const listed = status.files.find(file => file.artifact_id === files[5].id);
      assert.equal(listed.path, files[5].path); assert.equal(listed.provider_file_version, files[5].provider_file_version);
      await assert.rejects(confirmation({ action: "confirm", connection_id: target.connection, base_generation: status.policy_generation + 1,
        items: [{ artifact_id: listed.artifact_id, artifact_version: listed.artifact_version }], idempotency_key: randomUUID() }), /storage_owner_version_conflict/);
      const key = randomUUID();
      const confirmed = await confirmation({ action: "confirm", connection_id: target.connection, base_generation: status.policy_generation,
        items: [{ artifact_id: listed.artifact_id, artifact_version: listed.artifact_version }], idempotency_key: key });
      assert.equal(confirmed.status, "committed", JSON.stringify(confirmed));
      const event = (await admin.query("select change_summary from public.clued_context_events where user_id=$1 and idempotency_key=$2",
        [user, key])).rows[0].change_summary;
      assert.deepEqual(event.items, [{ artifact_id: files[5].id, provider_file_id: files[5].provider_file_id, path: files[5].path,
        provider_file_version: files[5].provider_file_version }]);
      assert.equal((await confirmation({ action: "status", connection_id: target.connection })).open_items.length, 1);
      const jobId = randomUUID();
      const sixth = await submitJob(target, client, mutationOf(files[5]), jobId);
      assert.equal(sixth.result.status, "queued");
      // Replay of the same job does not need (or consume) another confirmation.
      assert.equal((await submitRaw(target, client, mutationOf(files[5]), jobId)).rows[0].value.replayed, true);
      assert.equal((await confirmation({ action: "status", connection_id: target.connection })).open_items.length, 0);
      await assert.rejects(submitRaw(target, client, mutationOf(files[6])), /storage_trash_confirmation_required/);
      await assert.rejects(submitRaw(target, client, mutationOf(files[5])), /storage_trash_confirmation_required/, "an item is consumed once");
    });

    await t.test("a governance file without delete authority cannot be confirmed for the trash", async () => {
      const { target, client, storage } = await setup();
      const governance = await createFile(target, client, storage, "governed.txt");
      const updated = await register({ action: "artifact_update", profile_id: target.profile, artifact_id: governance.id, base_version: Number(governance.version),
        path: governance.path, provider_file_id: governance.provider_file_id, provider_file_version: governance.provider_file_version,
        governance_class: "governance", delete_authority: false });
      assert.equal(updated.status, "committed");
      const status = await confirmation({ action: "status", connection_id: target.connection });
      const listed = status.files.find(file => file.artifact_id === governance.id);
      assert.equal(listed.trashable, false);
      await assert.rejects(confirmation({ action: "confirm", connection_id: target.connection, base_generation: status.policy_generation,
        items: [{ artifact_id: listed.artifact_id, artifact_version: listed.artifact_version }], idempotency_key: randomUUID() }), /storage_owner_version_conflict/);
    });

    await t.test("a lost update reply leaves the intent fenced; recovery re-verifies by GET and settles once", async () => {
      const { target, client, storage } = await setup();
      const created = await createFile(target, client, storage, "lost.txt");
      storage.losePatch = true;
      const job = await submitJob(target, client, trash(created.path, storage.files.get(created.provider_file_id).version));
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
        root_parent_id: descriptor.root_parent_id, get_file: metadata.getFile, list_children: metadata.listChildren, include_verified_proof: true });
      const { verified_proof: proof, ...postcondition } = await verify({ profile: descriptor.profile, mutation: descriptor.mutation,
        provider_before: descriptor.provider_before, effect_result: { operation: "delete", source_path: descriptor.mutation.source_path,
          provider_file_id: descriptor.attempt.provider_file_id, content: descriptor.attempt.content } });
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
