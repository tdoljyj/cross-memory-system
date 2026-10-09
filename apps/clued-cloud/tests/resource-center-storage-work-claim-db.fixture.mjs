import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

// raw-binding-grants: the calling test (resource-center-authority-db) calls allowRawTestBindings.

const sha = value => createHash("sha256").update(value).digest("hex");
const JOBS = "public.clued_storage_jobs_router_v2";
const BATCH = "public.clued_storage_trash_batch_v1";
const WRITE = "public.clued_storage_write_access_v1";
const TRACK = "20_P_产品与体验";

// Generic Work Claim step 2 (migration 20261003080000, GenericWorkClaim §4):
// clued_storage_submit and clued_storage_trash_batch ask the Work Claim gate
// (collision_only) after the policy evaluator and replay checks and before
// anything is created. Claims are rows of clued_private.work_claims_v1; the
// storage calls go through the real router and batch RPCs.
export async function testStorageWorkClaim(t, admin, server, user, decision) {
  await allowTestIssuerCredentials(admin);
  const clients = [], claims = [], session = randomUUID(), clientIssuer = sha(randomUUID()), resource = "https://work-claim.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    return database;
  };
  try {
    const native = await connect("authenticated"), caller = await connect("anon");
    await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [user, JSON.stringify({ sub: user, session_id: session })]);
    await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'work-claim-fixture')", [clientIssuer, resource]);
    const oauthClient = `work-claim-${randomUUID()}`;
    await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://work-claim.invalid/storage/google/callback',true)",
      [sha(randomUUID()), oauthClient]);
    const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
    const register = async input => {
      const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
        JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
      assert.equal(result.status, "committed", JSON.stringify(result)); return result;
    };
    const suffix = randomUUID(), root = `/work-claim-${suffix}/Clued_资料中心`;
    const registered = await register({ action: "profile_register", project_id: project, profile_version: `work-claim/${suffix}`,
      managed_root: root, root_folder_id: `wc-root-${suffix}`, root_parent_id: `wc-parent-${suffix}`, root_folder_version: "1" });
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    await register({ action: "artifact_register", profile_id: profile, path: root + "/" + TRACK, provider_file_id: `wc-track-${suffix}`,
      provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
    assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
      profile_id: profile, base_version: 1, allowed_root_children: [TRACK], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
    const connected = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    const connection = connected.target_refs.find(ref => ref.role === "primary").id;
    await admin.query("update clued_private.storage_connections_v1 set state='active',provider_subject='work-claim-subject',oauth_client_id=$2,credential_version=1,credential_envelope='{}' where id=$1",
      [connection, oauthClient]);
    // The writer: a storage client Binding, as the destructive fixture binds one.
    const token = sha(randomUUID()), clientId = `wc-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Work claim fixture", redirect_uri: "https://work-claim.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const writer = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value.binding_id;
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, connected.receipt_id]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, connected.receipt_id]);
    await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)", [lineage, connected.receipt_id]);
    const policy = randomUUID();
    await admin.query("begin");
    await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
        c.source_decision_id,c.decision_version,'reviewed_transition','work-claim-fixture/2',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, connection]);
    await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, connected.receipt_id]);
    await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
    await admin.query("commit");
    // One write level changes per call, each with its own disclosure (as the adopt fixture does).
    for (const level of ["modify", "destructive"]) {
      const status = (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "status", connection_id: connection })])).rows[0].value;
      const enabled = (await native.query(`select ${WRITE}($1::jsonb) value`, [JSON.stringify({ action: "set_classes", connection_id: connection,
        classes: [...status.classes, level], base_generation: status.policy_generation, disclosure_version: `clued.storage-${level}-disclosure/1`,
        idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(enabled.status, "committed", JSON.stringify(enabled));
    }

    // Claim holders: another Agent's Binding of the same user.
    const other = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','other agent',$2,array['context:read','context:write'],array['*']) returning id`, [user, sha(randomUUID())])).rows[0].id;
    const newTask = async () => (await admin.query(`insert into public.clued_memories(id,user_id,title,content,scope,record_type,status,
        record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)
      values($1,$2,'work claim fixture task','fixture','global','task','active',1,'active','global','{"execution_bucket":"next"}','{}','{}','observed','fixture')
      returning id`, [randomUUID(), user])).rows[0].id;
    const insertClaim = async (writeSet, { holder = other, status = "ACTIVE", seconds = 3600, fence = 1 } = {}) => (await admin.query(`insert into clued_private.work_claims_v1
        (user_id,task_id,context_key,holder_binding_id,holder_session_ref,write_set,fence,issued_at,expires_at,hard_deadline_at,status,idempotency_key)
      values($1,$2,'global',$3,'fixture-session',$4,$5,clock_timestamp()-interval '1 hour',clock_timestamp()+make_interval(secs=>$6),
        clock_timestamp()+interval '1 day',$7,$8) returning *`,
    [user, await newTask(), holder, writeSet, fence, seconds, status, randomUUID()])).rows[0];
    const claimRow = async (writeSet, options) => { const row = await insertClaim(writeSet, options); claims.push(row.claim_id); return row; };
    const S = `storage:${connection}/`;
    const counts = async () => (await admin.query(`select
      (select count(*)::int from clued_private.storage_jobs_v1 where connection_id=$1) jobs,
      (select count(*)::int from clued_private.storage_trash_batches_v1 where connection_id=$1) batches,
      (select count(*)::int from public.clued_audit_receipts where user_id=$2 and operation='storage_job_submit') submits`, [connection, user])).rows[0];
    const rejections = async taskId => (await admin.query(`select binding_id,context_key,metadata from public.clued_audit_receipts
      where user_id=$1 and operation='work_claim_reject' and object_id=$2 order by created_at`, [user, taskId])).rows;
    const submit = async (mutation, extra = {}, jobId = randomUUID()) => (await caller.query(`select ${JOBS}($1,$2::jsonb) value`,
      [token, JSON.stringify({ action: "submit", connection_id: connection, job_id: jobId, mutation, ...extra })])).rows[0].value;
    const batch = async (items, extra = {}) => (await caller.query(`select ${BATCH}($1,$2::jsonb) value`,
      [token, JSON.stringify({ connection_id: connection, batch_id: randomUUID(), items, ...extra })])).rows[0].value;
    const create = (path, content = "work claim fixture") => ({ operation: "create", target_kind: "file", destination_path: path, content });
    const trash = (path, kind = "file") => ({ operation: "delete", target_kind: kind, source_path: path, source_file_version: "1", source_file_id: "wc-" + randomUUID().slice(0, 8) });
    const refused = (result, code) => { assert.deepEqual([result.status, result.error_code], ["rejected", code], JSON.stringify(result)); return result; };
    const queued = result => { assert.equal(result.status, "queued", JSON.stringify(result)); return result; };

    await t.test("Work Claim storage door: the storage kind names this door", async () => {
      assert.deepEqual((await admin.query("select doors from clued_private.work_claim_resource_kinds where kind='storage'")).rows[0].doors,
        ["claim-conflict", "clued-storage"]);
    });

    await t.test("Work Claim storage door: resources of each operation, relative to the registered root", async () => {
      const of = async m => (await admin.query("select clued_private.work_claim_storage_resources_v1($1,$2,$3::jsonb) v",
        [connection, profile, JSON.stringify(m)])).rows[0].v;
      const full = rel => `${root}/${rel}`;
      assert.deepEqual(await of({ operation: "create", target_kind: "file", destination_path: full("t/a b.md") }), [S + "t/a b.md"]);
      assert.deepEqual(await of({ operation: "create", target_kind: "directory", destination_path: full("t/d") }), [S + "t/d"]);
      assert.deepEqual(await of({ operation: "replace", target_kind: "file", destination_path: full("t/a.md") }), [S + "t/a.md"]);
      assert.deepEqual(await of({ operation: "move", target_kind: "file", source_path: full("t/a.md"), destination_path: full("u/a.md") }),
        [S + "t/a.md", S + "u/a.md"]);
      assert.deepEqual(await of({ operation: "move", target_kind: "directory", source_path: full("t/d"), destination_path: full("u/d") }),
        [S + "t/d/**", S + "u/d/**"]);
      assert.deepEqual(await of({ operation: "delete", target_kind: "directory", source_path: full("t/d") }), [S + "t/d/**"]);
      assert.deepEqual(await of({ operation: "restore", target_kind: "file", source_path: full("t/a.md"), destination_path: full("t/a (1).md") }),
        [S + "t/a.md", S + "t/a (1).md"]);
      assert.deepEqual(await of({ operation: "adopt", target_kind: "file", source_path: full("t/a.md") }), []);
      await assert.rejects(of({ operation: "create", target_kind: "file", destination_path: "/elsewhere/t/a.md" }), /storage_path_invalid/);
    });

    await t.test("Work Claim storage door: without claims, and with unrelated ones, writes are admitted as before", async () => {
      queued(await submit(create(`${TRACK}/free.md`)));
      await claimRow(["apps/clued-cloud/**", `repo:o/r/${TRACK}/**`, `storage:${randomUUID()}/${TRACK}/**`, S + "elsewhere/**"]);
      await claimRow([S + `${TRACK}/expired/**`], { seconds: -60 });
      await claimRow([S + `${TRACK}/released/**`], { status: "RELEASED" });
      queued(await submit(create(`${TRACK}/still-free.md`)));
      queued(await submit(create(`${TRACK}/expired/a.md`)));
      queued(await submit(create(`${TRACK}/released/a.md`)));
    });

    await t.test("Work Claim storage door: another live claim on the path refuses the write before anything exists", async () => {
      const held = await claimRow([S + `${TRACK}/held/**`]);
      const draining = await claimRow([S + `${TRACK}/draining.md`], { status: "DRAINING" });
      const before = await counts();
      for (const path of [`${TRACK}/held/a.md`, `${root}/${TRACK}/held/a.md`, `${TRACK}/held/sub/with space.md`]) {
        const result = refused(await submit(create(path)), "work_claim_conflict");
        assert.deepEqual(result.conflicts.map(c => [c.claim_id, c.task_id, c.holder_binding_id]), [[held.claim_id, held.task_id, other]]);
        assert.equal(result.door, "clued-storage");
      }
      refused(await submit(create(`${TRACK}/draining.md`)), "work_claim_conflict");
      // A file move whose destination (or source) is held, and a trash of a held item, are refused too.
      refused(await submit({ operation: "move", target_kind: "file", source_path: `${TRACK}/free.md`, destination_path: `${TRACK}/held/free.md`,
        source_file_version: "1" }), "work_claim_conflict");
      refused(await submit(trash(`${TRACK}/held/a.md`)), "work_claim_conflict");
      refused(await submit(trash(`${TRACK}/held`, "directory")), "work_claim_conflict");
      // A claim on the directory itself conflicts with writes under it and with the directory.
      const directory = await claimRow([S + `${TRACK}/folder`]);
      refused(await submit(trash(`${TRACK}/folder`, "directory")), "work_claim_conflict");
      queued(await submit(create(`${TRACK}/folder-sibling.md`)));
      assert.deepEqual(await counts(), { ...before, jobs: before.jobs + 1, submits: before.submits + 1 });
      // One Receipt per Binding, Task, error and minute, under the writer's Binding.
      const logged = await rejections(held.task_id);
      assert.equal(logged.length, 1, JSON.stringify(logged));
      assert.deepEqual([logged[0].binding_id, logged[0].context_key, logged[0].metadata.receipt_kind, logged[0].metadata.error_code,
        logged[0].metadata.attempted_operation, logged[0].metadata.claim_id, logged[0].metadata.conflicting_claim_ids],
      [writer, "global", "WORK_CLAIM_REJECTED", "work_claim_conflict", "clued-storage:storage_submit", held.claim_id, [held.claim_id]]);
      assert.equal((await rejections(draining.task_id)).length, 1);
      assert.equal((await rejections(directory.task_id)).length, 1);
    });

    await t.test("Work Claim storage door: a replay of an existing job is answered, not refused", async () => {
      const jobId = randomUUID(), mutation = create(`${TRACK}/later-held/a.md`);
      queued(await submit(mutation, {}, jobId));
      await claimRow([S + `${TRACK}/later-held/**`]);
      const replay = await submit(mutation, {}, jobId);
      assert.deepEqual([replay.status, replay.replayed, replay.job_id], ["queued", true, jobId]);
      refused(await submit(mutation), "work_claim_conflict");
    });

    await t.test("Work Claim storage door: a presented claim must be the writer's, live, at its fence and cover every path", async () => {
      const mine = await claimRow([S + `${TRACK}/mine/**`], { holder: writer, fence: 3 });
      const ref = { claim_id: mine.claim_id, fence: 3 };
      const before = await counts();
      queued(await submit(create(`${TRACK}/mine/a.md`), { work_claim: ref }));
      // Without the claim, the writer's own claim is "another" live claim on the path.
      refused(await submit(create(`${TRACK}/mine/b.md`)), "work_claim_conflict");
      const uncovered = refused(await submit({ operation: "move", target_kind: "file", source_path: `${TRACK}/mine/a.md`,
        destination_path: `${TRACK}/a.md`, source_file_version: "1" }, { work_claim: ref }), "work_claim_not_covered");
      assert.deepEqual(uncovered.uncovered, [S + `${TRACK}/a.md`]);
      assert.equal(refused(await submit(create(`${TRACK}/mine/c.md`), { work_claim: { ...ref, fence: 2 } }), "work_claim_fence_mismatch").expected_fence, 3);
      const theirs = await claimRow([S + `${TRACK}/theirs/**`]);
      refused(await submit(create(`${TRACK}/theirs/a.md`), { work_claim: { claim_id: theirs.claim_id, fence: 1 } }), "work_claim_not_holder");
      refused(await submit(create(`${TRACK}/mine/d.md`), { work_claim: { claim_id: randomUUID(), fence: 1 } }), "work_claim_not_found");
      // A claim that covers the path but overlaps another live claim (here a narrower one) is refused for the conflict.
      const inner = await claimRow([S + `${TRACK}/mine/inner.md`]);
      assert.equal(refused(await submit(create(`${TRACK}/mine/inner.md`), { work_claim: ref }), "work_claim_conflict").conflicts[0].claim_id, inner.claim_id);
      await admin.query("update clued_private.work_claims_v1 set status='RELEASED',released_outcome='completed' where claim_id=$1", [mine.claim_id]);
      assert.equal(refused(await submit(create(`${TRACK}/mine/e.md`), { work_claim: ref }), "work_claim_not_active").claim_status, "RELEASED");
      assert.deepEqual(await counts(), { ...before, jobs: before.jobs + 1, submits: before.submits + 1 });
      // A missing claim id is logged under that id.
      const unknown = randomUUID();
      refused(await submit(create(`${TRACK}/x.md`), { work_claim: { claim_id: unknown, fence: 1 } }), "work_claim_not_found");
      assert.equal((await rejections(unknown)).length, 1);
    });

    await t.test("Work Claim storage door: a trash batch with a held item is refused before the batch exists", async () => {
      const held = await claimRow([S + `${TRACK}/batch-held/**`]);
      const before = await counts();
      const result = refused(await batch([trash(`${TRACK}/free-1.md`), trash(`${TRACK}/batch-held/a.md`)]), "work_claim_conflict");
      assert.deepEqual(result.conflicts.map(c => c.claim_id), [held.claim_id]);
      assert.deepEqual(await counts(), before);
      const logged = await rejections(held.task_id);
      assert.equal(logged[0].metadata.attempted_operation, "clued-storage:storage_trash_batch");
      // Without a held item the gate admits the batch; the registry check then refuses unregistered items as before.
      await assert.rejects(batch([trash(`${TRACK}/free-1.md`)]), /storage_trash_batch_item_unavailable/);
      // A trash job of a free item passes the gate and is queued as before (the registry is checked when it runs).
      queued(await submit(trash(`${TRACK}/free-2.md`)));
    });

    await t.test("Work Claim storage door: work_claim must be exactly {claim_id, fence} and only on submit", async () => {
      const claim = { claim_id: randomUUID(), fence: 1 };
      for (const work_claim of [{}, { claim_id: claim.claim_id }, { ...claim, fence: 0 }, { ...claim, fence: "1" }, { ...claim, extra: 1 }, "x"]) {
        await assert.rejects(submit(create(`${TRACK}/shape.md`), { work_claim }), /storage_job_input_invalid/, JSON.stringify(work_claim));
        await assert.rejects(batch([trash(`${TRACK}/shape.md`)], { work_claim }), /storage_job_input_invalid/);
      }
      await assert.rejects(caller.query(`select ${JOBS}($1,$2::jsonb) value`, [token, JSON.stringify({ action: "inspect", connection_id: connection,
        job_id: randomUUID(), work_claim: claim })]), /storage_job_input_invalid/);
    });
  } finally {
    // Later fixtures share this database: end this fixture's claims.
    await admin.query("update clued_private.work_claims_v1 set status='RELEASED',released_outcome='abandoned' where claim_id=any($1::uuid[]) and status in ('ACTIVE','DRAINING')",
      [claims]).catch(() => {});
    for (const client of clients.reverse()) await client.end().catch(() => {});
  }
}
