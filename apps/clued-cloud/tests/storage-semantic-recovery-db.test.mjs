// Actual disposable PostgreSQL; no production SQL, provider requests or credentials.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop as stopBuild } from "esbuild";
import EmbeddedPostgres from "embedded-postgres";
import { allowRawTestBindings } from "./raw-binding-grants-fixture.mjs";
import { assertGatewayCloseoutBoundary } from "./worker-gateway-caller-fixture.mjs";
import { testStorageModifyExecution } from "./resource-center-storage-modify-execution-db.fixture.mjs";
import { testStorageReplace } from "./resource-center-storage-replace-db.fixture.mjs";
import { testStorageDestructive } from "./resource-center-storage-destructive-db.fixture.mjs";
import { createGoogleDriveSemanticAttempt } from "../../../kernel/host/resource-center-google-drive-semantic-recovery.mjs";
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r));
 const p = s.address().port; await new Promise(r => s.close(r)); return p; }

test("semantic recovery: actual migration, independent predicates and private boundary", { timeout: 240000 }, async t => {
 const temporaryRoot = await fs.realpath(process.env.KOOYUMI_TEST_TEMP_ROOT ?? os.tmpdir()), dir = await fs.mkdtemp(path.join(temporaryRoot, "kooyumi-semantic-db-"));
 const server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: crypto.randomUUID(),
   port: await freePort(), persistent: true, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS, "-c", "listen_addresses=127.0.0.1"], onLog() {}, onError() {} });
 let db, started = false;
 try {
  await server.initialise(); await server.start(); started = true; db = server.getPgClient(); await db.connect();
  const modulePath = path.join(dir, "recovery-test.mjs"), vaultPath = path.join(dir, "vault-test.mjs");
  for (const [name, output] of [["storage-cloud-recovery", modulePath], ["storage-credential-vault", vaultPath]])
   await build({ entryPoints: [path.join(cloud, "worker", name + ".ts")], outfile: output, bundle: true, platform: "node", format: "esm" });
  stopBuild();
  const { createStorageCloudRecovery } = await import(pathToFileURL(modulePath));
  const { createStorageCredentialVault } = await import(pathToFileURL(vaultPath));
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
   create schema cron;create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true,database text default current_database(),username text default current_user);
   create function cron.schedule(text,text,text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3)
    on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid$$;`);
  for (const name of (await fs.readdir(path.join(cloud, "supabase/migrations"))).filter(n => n.endsWith(".sql")).sort()) {
   try { await db.query(await fs.readFile(path.join(cloud, "supabase/migrations", name), "utf8")); }
   catch (cause) { throw new Error("Migration " + name + ": " + cause.message + "; position=" + cause.position +
     "; internal=" + cause.internalPosition + "; where=" + cause.where +
     (cause.internalQuery ? "; near=" + cause.internalQuery.slice(Math.max(0, Number(cause.internalPosition) - 160), Number(cause.internalPosition) + 100) : ""), { cause }); }
  }
  const state = { provider_file_id: "file_1", parent_ids: ["parent_1"], name: "before.txt", trashed: false,
     explicitly_trashed: false, mime_type: "text/plain", head_revision_id: "revision_1", sha256: "a".repeat(64), marker: null, access_digest: null };
  const intent = "11111111-1111-4111-8111-111111111111";
  const attempt = { intent_id: intent, provider_file_id: "file_1", parent_id: "parent_1", content_after: { sha256: "b".repeat(64) } };
  const scalar = async (sql, args) => (await db.query(sql, args)).rows[0].v;
  await t.test("complete metadata validates; missing and type-confused states never validate", async () => {
   assert.equal(await scalar("select clued_private.storage_semantic_state_valid_v1($1::jsonb) v", [JSON.stringify(state)]), true);
   for (const bad of [null, {}, { ...state, explicitly_trashed: null }, { ...state, parent_ids: [] },
     { ...state, parent_ids: ["one", "two"] }, { ...state, marker: {} }, { ...state, sha256: "unproven" },
     { ...state, explicitly_trashed: true }, { ...state, head_revision_id: null }, { ...state, access_digest: "a".repeat(64) }])
    assert.equal(await scalar("select clued_private.storage_semantic_state_valid_v1($1::jsonb) v", [JSON.stringify(bad)]), false);
   const directory = { ...state, mime_type: "application/vnd.google-apps.folder", head_revision_id: null, sha256: null, access_digest: "a".repeat(64) };
   assert.equal(await scalar("select clued_private.storage_semantic_state_valid_v1($1::jsonb) v", [JSON.stringify(directory)]), true);
   for (const access_digest of [null, {}, "unproven", "A".repeat(64), 7])
    assert.equal(await scalar("select clued_private.storage_semantic_state_valid_v1($1::jsonb) v", [JSON.stringify({ ...directory, access_digest })]), false);
  });
  await t.test("database derives rename/move/replace/trash after predicates, never accepts a caller predicate", async () => {
   for (const operation of ["rename", "move", "replace", "delete"]) {
    const request = { operation, target_kind: "file", source_path: "root/before.txt",
      destination_path: operation === "rename" ? "root/after.txt" : "root/before.txt" };
    const result = await scalar("select clued_private.storage_semantic_expected_after_v1($1::jsonb,$2::jsonb,$3::jsonb) v",
      [JSON.stringify(request), JSON.stringify(attempt), JSON.stringify(state)]);
    assert.equal(result.marker, intent); assert.equal(result.provider_file_id, "file_1");
    assert.equal(result.trashed, operation === "delete");
    assert.equal(result.head_revision, operation === "replace" ? "different" : "same");
    assert.equal(result.sha256, (operation === "replace" ? "b" : "a").repeat(64));
   }
   await assert.rejects(db.query("select clued_private.storage_semantic_expected_after_v1($1::jsonb,$2::jsonb,$3::jsonb)",
    [JSON.stringify({ operation: "move", target_kind: "directory" }), JSON.stringify(attempt), JSON.stringify(state)]), /storage_semantic_attempt_invalid/);
  });
  await t.test("create absence is an explicit separate state, with the actual text MIME contract", async () => {
   for (const [name, mime] of [["a.md", "text/markdown"], [".foo.md", "text/markdown"], [".md", "text/plain"],
     ["a.csv", "text/csv"], ["a.json", "application/json"], ["a.xml", "text/plain"], ["a.svg", "text/plain"]]) {
    assert.equal(await scalar("select clued_private.storage_semantic_text_mime_v1($1) v", [name]), mime);
   }
   const result = await scalar("select clued_private.storage_semantic_expected_after_v1($1::jsonb,$2::jsonb,$3::jsonb) v",
    [JSON.stringify({ operation: "create", target_kind: "file", destination_path: "root/new.md" }),
     JSON.stringify({ ...attempt, sha256: "a".repeat(64) }), JSON.stringify({ exists: false, provider_file_id: "file_1" })]);
   assert.equal(result.mime_type, "text/markdown"); assert.equal(result.head_revision, "any");
  });
  await t.test("I2 request windows distinguish multipart, resumable and metadata effects", async () => {
   for (const [mutation, seconds] of [
    [{ operation: "rename", target_kind: "file" }, 10], [{ operation: "delete", target_kind: "directory" }, 10],
    [{ operation: "create", target_kind: "directory" }, 10], [{ operation: "create", target_kind: "file" }, 60],
    [{ operation: "replace", target_kind: "file", content_ref: { size: 5242880 } }, 60],
    [{ operation: "create", target_kind: "file", content_ref: { size: 5242881 } }, 120]]) {
    assert.equal(Number(await scalar("select extract(epoch from clued_private.storage_semantic_request_timeout_v1($1::jsonb)) v",
      [JSON.stringify(mutation)])), seconds);
   }
  });
  await t.test("no public/API role can call helpers or touch semantic evidence directly", async () => {
   for (const role of ["anon", "authenticated", "service_role", "clued_worker_gateway"]) {
    assert.equal(await scalar("select has_table_privilege($1,'clued_private.storage_semantic_attempts_v1','select,insert,update,delete') v", [role]), false);
    assert.equal(await scalar("select has_function_privilege($1,'clued_private.storage_semantic_record_attempt_v1(uuid,uuid,jsonb,jsonb)','execute') v", [role]), false);
   }
  });
  await t.test("a replay cannot retrofit old attempts into new evidence", async () => {
   await assert.rejects(db.query("select clued_private.storage_semantic_record_attempt_v1($1,$2,$3::jsonb,$4::jsonb)",
    [crypto.randomUUID(), crypto.randomUUID(), JSON.stringify({ evidence: {} }),
      JSON.stringify({ status: "replayed", attempt_recorded: false })]), /storage_semantic_first_attempt_required/);
   assert.equal(Number(await scalar("select count(*) v from clued_private.storage_semantic_attempts_v1")), 0);
  });
  await allowRawTestBindings(db);
  const owner = crypto.randomUUID(), project = crypto.randomUUID(), decision = crypto.randomUUID();
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'semantic@synthetic.invalid',now())", [owner]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Semantic','semantic',$3,'confirmed',now())",
    [project, owner, "project:" + project]);
  await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
   canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic approval','Disposable only','project',$3,'decision','active',1,'active',
   $4,'{"rationale":"semantic test fixture"}','{}','{}','user_explicit','Owner confirmed')`, [decision, owner, project, "project:" + project]);
  const cloudErrors = [];
  const recover = async (ctx, target, storage, job, { i9 = true } = {}) => {
   const original = await ctx.journal(job);
   await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1", [original.id]);
   if (i9) assert.equal(await scalar("select clued_private.storage_conflict_close_v1($1) v", [original.id]), "conflict");
   else await new Promise(resolve => setTimeout(resolve, 15500));
   const vaultConfig = { current_key_id: "synthetic", keys: { synthetic: crypto.randomBytes(32).toString("base64url") } };
   const vault = await createStorageCredentialVault(vaultConfig);
   const envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: ctx.access_token,
    scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: Date.now() + 3600000 }),
    { owner_id: owner, connection_id: target.connection, provider: "google-drive", provider_subject: ctx.provider_subject, oauth_client_id: ctx.oauth_client_id, credential_version: 1 });
   await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1", [target.connection, JSON.stringify(envelope)]);
   const issuer = (await db.query("select issuer_hash from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1", [ctx.oauth_client_id])).rows[0].issuer_hash;
   const descriptor = await scalar("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v", [issuer, JSON.stringify({ ...job.reference, action: "load" })]);
   const calls = [];
   const recovery = await createStorageCloudRecovery({ client_id: ctx.oauth_client_id, vault: vaultConfig, timeout_ms: 10000,
    fetch: storage.fetch, rpc: async () => { throw Error("wrong scheduler route"); }, verified: { descriptor,
     rpc: async input => { calls.push(structuredClone(input));return ctx.cloud(input); } } });
   return { result: await recovery.run(job.reference), original, calls, descriptor };
  };
  await testStorageModifyExecution(t, db, server, owner, decision, { gateway: true, only_extra: true,
   on_cloud_error: (error, input) => cloudErrors.push({ action: input.action, code: error.code, message: error.message, where: error.where }), extra_cases: async ctx => {
    await t.test("actual semantic create and move use the same normal record/verify/settle chain", async () => {
     const { target, client, storage } = await ctx.setup();
     const created = await ctx.submitJob(target, client, { operation: "create", target_kind: "file", destination_path: target.root + "/20_P_产品与体验/created.md", content: "semantic create" });
     const createdResult = await ctx.executor(target, storage, undefined, undefined, { semantic: true }).run(created.reference);
     assert.equal(createdResult.status, "committed", JSON.stringify({ createdResult, cloudErrors }));
     const source = await ctx.artifact(target, created.mutation.destination_path), destination = await ctx.directoryIn(target, storage, "destination");
     const moved = await ctx.submitJob(target, client, ctx.modify("move", source.path, destination.path + "/created.md", source.provider_file_version));
     assert.equal((await ctx.executor(target, storage, undefined, undefined, { semantic: true }).run(moved.reference)).status, "committed");
     assert.equal(storage.patches, 1);assert.deepEqual(storage.files.get(source.provider_file_id).parents, [destination.id]);
    });
    await t.test("actual semantic Kernel executes once, atomically records both proofs, settles and registers the rename", async () => {
      const { target, client, storage } = await ctx.setup();
      const source = await ctx.createFile(target, client, storage, "before.txt");
      const destination = source.path.replace("before.txt", "after.txt");
      const job = await ctx.submitJob(target, client, ctx.modify("rename", source.path, destination, source.provider_file_version));
      const result = await ctx.executor(target, storage, undefined, undefined, { semantic: true }).run(job.reference);
      assert.equal(result.status, "committed", JSON.stringify({ result, cloudErrors }));
      const journal = await ctx.journal(job);
      assert.equal(journal.state, "committed");assert.equal(storage.patches, 1);
      assert.equal((await ctx.artifact(target, destination)).id, source.id);
      const verified = (await db.query(`select s.receipt_id attempt_receipt,v.verified_receipt_id,v.verified_digest,
       v.semantic_attempt_receipt_id,v.observation,r.status,r.operation,r.response_hash=clued_private.m1_sha256(r.canonical_result) hash_valid
       from clued_private.storage_semantic_attempts_v1 s join clued_private.storage_semantic_verifications_v1 v using(intent_id)
       join public.clued_audit_receipts r on r.id=v.receipt_id where s.intent_id=$1`, [journal.id])).rows[0];
      assert.equal(verified.status, "committed");assert.equal(verified.operation, "storage_semantic_verified");assert.equal(verified.hash_valid, true);
      assert.equal(verified.semantic_attempt_receipt_id, verified.attempt_receipt);
      assert.equal(verified.verified_receipt_id, journal.verified_receipt_id_v2);assert.equal(verified.verified_digest, journal.verified_digest_v2);
      assert.equal(verified.observation.second.provider_file_version, journal.verified_result_v2.proof.provider_file_version);
      assert.equal(verified.observation.second.state.marker, journal.id);
      assert.equal((await ctx.cloud({ ...job.reference, action: "verified_inspect" })).status, "committed");
      assert.equal(storage.patches, 1);
    });
    for (const fault of ["omitted", "wrong-client", "wrong-version", "missing-ancestor", "stale", "no-marker"]) {
     await t.test("actual verified transaction rolls back unproven semantic observation: " + fault, async () => {
      const { target, client, storage } = await ctx.setup();
      const source = await ctx.createFile(target, client, storage, "before.txt");
      const job = await ctx.submitJob(target, client, ctx.modify("rename", source.path, source.path.replace("before.txt", "after.txt"), source.provider_file_version));
      let forged;
      const engine = ctx.executor(target, storage, undefined, async request => {
       if (request.action !== "verified_record") return;
       forged = structuredClone(request);
       if (fault === "omitted") delete forged.semantic_observation;
       else if (fault === "wrong-client") forged.semantic_observation.oauth_client_id = "other-client";
       else if (fault === "wrong-version") forged.semantic_observation.first.provider_file_version = forged.semantic_observation.second.provider_file_version = "999";
       else if (fault === "missing-ancestor") forged.semantic_observation.ancestors_after.pop();
       else if (fault === "stale") forged.semantic_observation.observed_at_ms -= 60000;
       else forged.semantic_observation.first.state.marker = forged.semantic_observation.second.state.marker = null;
       await ctx.cloud(forged);assert.fail("Unproven observation committed");
      }, { semantic: true });
      assert.equal((await engine.run(job.reference)).status, "unreconciled");
      assert.ok(forged);const journal = await ctx.journal(job);
      assert.equal(journal.verified_result_v2, null);assert.equal(journal.verified_receipt_id_v2, null);
      assert.equal(Number(await scalar("select count(*) v from clued_private.storage_semantic_verifications_v1 where intent_id=$1", [journal.id])), 0);
      assert.equal(storage.patches, 1, "failed verification never retries its provider effect");
      await assert.rejects(ctx.cloud({ ...job.reference, action: "settle_verified" }), /storage_semantic_verified_link_required/);
     });
    }
    const interrupted = async ({ changed = false, i9 = false, incidental = false, beforeSettle } = {}) => {
     const { target, client, storage } = await ctx.setup();
     const source = await ctx.createFile(target, client, storage, "before.txt");
     const job = await ctx.submitJob(target, client, ctx.modify("rename", source.path, source.path.replace("before.txt", "after.txt"), source.provider_file_version));
     const engine = ctx.executor(target, storage, undefined, async request => {
      if (request.action === "provider_attempt") { await ctx.cloud(request);throw Error("synthetic lost acknowledgment before effect"); }
     }, { semantic: true });
     assert.equal((await engine.run(job.reference)).status, "unreconciled");assert.equal(storage.patches, 0);
     let journal = await ctx.journal(job);
     await db.query("update clued_private.resource_center_mutations_v1 set expires_at=clock_timestamp()-interval '3 hours' where id=$1", [journal.id]);
     if (i9) assert.equal(await scalar("select clued_private.storage_conflict_close_v1($1) v", [journal.id]), "conflict");
     if (changed) { const item = storage.files.get(source.provider_file_id);item.sha256Checksum = "c".repeat(64);item.headRevisionId = "external-edit";item.version = "99"; }
     if (incidental) storage.files.get(source.provider_file_id).version = "99";
     const vaultConfig = { current_key_id: "synthetic", keys: { synthetic: crypto.randomBytes(32).toString("base64url") } };
     const vault = await createStorageCredentialVault(vaultConfig);
     const envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "fixture-modify-exec-access",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: Date.now() + 3600000 }),
      { owner_id: owner, connection_id: target.connection, provider: "google-drive", provider_subject: "modify-exec-subject", oauth_client_id: ctx.oauth_client_id, credential_version: 1 });
     await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1", [target.connection, JSON.stringify(envelope)]);
     // The real scheduler deliberately waits 15 seconds after the first durable
     // attempt. Keep that production guard; do not backdate an immutable Receipt.
     if (!i9) await new Promise(resolve => setTimeout(resolve, 15500));
     const descriptor = await scalar("select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v", [
      (await db.query("select issuer_hash from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1", [ctx.oauth_client_id])).rows[0].issuer_hash,
      JSON.stringify({ ...job.reference, action: "load" })]);
     const calls = [];
     const recovery = await createStorageCloudRecovery({ client_id: ctx.oauth_client_id, vault: vaultConfig, timeout_ms: 10000,
      fetch: storage.fetch, rpc: async () => { throw Error("wrong scheduler route"); }, verified: { descriptor,
       rpc: async input => { calls.push(structuredClone(input));await beforeSettle?.(input);return ctx.cloud(input); } } });
     return { target, client, storage, source, job, descriptor, recovery, calls, original: journal };
    };
    await t.test("semantic directory create and its lost acknowledgment recover without a second POST", async () => {
     const { target, client, storage } = await ctx.setup();
     const job = await ctx.submitJob(target, client, { operation: "create", target_kind: "directory", directory_semantics: "topic",
      destination_path: target.root + "/20_P_产品与体验/semantic-topic" });
     storage.losePost = true;
     assert.equal((await ctx.executor(target, storage, undefined, undefined, { semantic: true }).run(job.reference)).status, "unreconciled");
     assert.equal(storage.posts, 1);
     const recovered = await recover(ctx, target, storage, job);
     assert.equal(recovered.result.status, "committed", JSON.stringify({ result: recovered.result, cloudErrors }));
     assert.equal(storage.posts, 1);assert.equal((await ctx.artifact(target, job.mutation.destination_path)).target_kind, "directory");
    });
    for (const tagged of [false, true]) await t.test("actual create absence requires both ID absence and empty private marker search: " + !tagged, async () => {
     const { target, client, storage } = await ctx.setup();
     const job = await ctx.submitJob(target, client, { operation: "create", target_kind: "file",
      destination_path: target.root + "/20_P_产品与体验/never-posted.txt", content: "never posted" });
     const engine = ctx.executor(target, storage, undefined, async request => {
      if (request.action === "provider_attempt") { await ctx.cloud(request);throw Error("synthetic lost acknowledgment"); }
     }, { semantic: true });
     assert.equal((await engine.run(job.reference)).status, "unreconciled");assert.equal(storage.posts, 0);
     const originalFetch = storage.fetch;let markerSearches = 0;
     storage.fetch = async (url, init) => {
      if (new URL(url).searchParams.get("q")?.startsWith("appProperties has")) {
       markerSearches++;return Response.json({ files: tagged ? [{ id: "other-tagged-file" }] : [] });
      }
      return originalFetch(url, init);
     };
     const recovered = await recover(ctx, target, storage, job);
     assert.equal(recovered.result.status, tagged ? "inspection_required" : "resolved", JSON.stringify({ result: recovered.result, cloudErrors }));
     assert.equal(markerSearches, 1);assert.equal(storage.posts, 0);
     const row = await ctx.journal(job);assert.equal(row.state, "conflict");
     assert.equal(await scalar("select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1", [row.id]), tagged ? "active" : "resolved");
    });
    for (const fault of ["base_version", "credential_version", "missing-slot"]) await t.test("automatic before settlement refuses invalid " + fault + " atomically", async () => {
     const f = await interrupted({ i9: true, beforeSettle: input => {
      if (fault === "missing-slot") input.observation.slots_before = input.observation.slots_after = [];
      else input[fault]++;
     } });
     const prior = await ctx.journal(f.job);
     const before = await scalar("select count(*) v from public.clued_audit_receipts where user_id=$1 and operation='storage_automatic_reconcile'", [owner]);
     assert.equal((await f.recovery.run(f.job.reference)).status, "inspection_required");
     const row = await ctx.journal(f.job);assert.deepEqual(row, prior);
     assert.equal(row.final_result.semantic_settlement, undefined);assert.equal(f.storage.patches, 0);
     assert.equal(await scalar("select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1", [row.id]), "active");
     assert.equal(await scalar("select count(*) v from public.clued_audit_receipts where user_id=$1 and operation='storage_automatic_reconcile'", [owner]), before);
    });
    for (const destination of [false, true]) await t.test("before with an external occupant in the " + (destination ? "destination" : "source") + " slot preserves conflict", async () => {
     const f = await interrupted({ i9: true });
     const item = f.storage.files.get(f.source.provider_file_id), external = { ...item, id: "external-" + crypto.randomUUID(),
      name: destination ? "after.txt" : item.name };
     f.storage.files.set(external.id, external);
     const result = await f.recovery.run(f.job.reference);assert.equal(result.status, "attention_required", JSON.stringify(result));
     assert.equal(await scalar("select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1", [f.original.id]), "active");
     assert.equal((await ctx.artifact(f.target, f.source.path)).provider_file_version, f.source.provider_file_version);
     assert.equal(f.storage.patches, 0);assert.deepEqual(f.storage.files.get(external.id), external);
    });
    await t.test("two automatic recoveries settle once and return the same committed receipt", async () => {
     const f = await interrupted({ i9: true, incidental: true });
     const results = await Promise.all([f.recovery.run(f.job.reference), f.recovery.run(f.job.reference)]);
     assert.deepEqual(results.map(x => x.status), ["resolved", "resolved"], JSON.stringify(results));
     assert.equal(results[0].receipt_id, results[1].receipt_id);assert.equal(f.storage.patches, 0);
     assert.equal(Number(await scalar("select count(*) v from public.clued_audit_receipts where user_id=$1 and operation='storage_automatic_reconcile' and canonical_result->'committed_versions' ? $2", [owner, f.original.id])), 1);
     const current = await ctx.artifact(f.target, f.source.path);assert.equal(Number(current.version), Number(f.source.version) + 1);
    });
    for (const i9 of [false, true]) await t.test("actual Worker and database automatically restore unchanged rename " + (i9 ? "after I9" : "before I9"), async () => {
     const f = await interrupted({ i9, incidental: true });const result = await f.recovery.run(f.job.reference);
     assert.equal(result.status, i9 ? "resolved" : "released_not_effected", JSON.stringify({ result, cloudErrors }));
     assert.deepEqual(f.calls.map(x => x.action), ["semantic_settle"]);assert.equal(f.storage.patches, 0);
     const journal = await ctx.journal(f.job);
     assert.equal(journal.state, i9 ? "conflict" : "cancelled");assert.equal(journal.provider_attempt_receipt_id, f.original.provider_attempt_receipt_id);
     if (i9) { assert.equal(result.connection_id, f.target.connection);assert.ok(Number.isSafeInteger(result.base_version));
      assert.equal(result.source_receipt_id, await scalar("select close_receipt_id v from clued_private.storage_conflict_isolations_v1 where intent_id=$1", [journal.id]));
      assert.notEqual(result.receipt_id, result.source_receipt_id); }
     assert.equal(journal.verified_result_v2, null);
     if (i9) assert.equal(await scalar("select state v from clued_private.storage_conflict_isolations_v1 where intent_id=$1", [journal.id]), "resolved");
     const refreshed = await ctx.artifact(f.target, f.source.path);assert.equal(refreshed.provider_file_version, "99");assert.equal(Number(refreshed.version), Number(f.source.version) + 1);
     const replay = await ctx.cloud(f.calls[0]);assert.equal(replay.receipt_id, result.receipt_id);
     const later = await ctx.submitJob(f.target, f.client, ctx.modify("rename", f.source.path, f.source.path.replace("before.txt", "usable.txt"), refreshed.provider_file_version));
     assert.equal((await ctx.executor(f.target, f.storage, undefined, undefined, { semantic: true }).run(later.reference)).status, "committed");
    });
    await t.test("semantic before recovery with a replacement connection binds the actual reader into its Receipt and Event", async () => {
     const f = await interrupted({ i9: true });
     const originalConnection=f.target.connection,newPolicy=crypto.randomUUID();
     await db.query('begin');try{
      await db.query("update clued_private.storage_account_policies_v2 set state='revoked',revoked_at=clock_timestamp(),revocation_receipt_id=$2 where connection_id=$1 and state='active'",[originalConnection,f.target.receipt]);
      await db.query("update clued_private.storage_connections_v1 set state='revoked',revoked_at=clock_timestamp(),version=version+1,auth_mode='revoked',account_policy_id=null,auth_generation=auth_generation+1 where id=$1",[originalConnection]);
      await db.query('commit');
     }catch(error){await db.query('rollback');throw error;}
     const registration=await ctx.account({action:'register',profile_id:f.target.profile,source_decision_id:decision,idempotency_key:crypto.randomUUID()});
     assert.equal(registration.status,'committed');const current=registration.target_refs.find(r=>r.role==='primary').id;
     const vaultConfig={current_key_id:'replacement',keys:{replacement:crypto.randomBytes(32).toString('base64url')}},vault=await createStorageCredentialVault(vaultConfig);
     const envelope=await vault.seal(JSON.stringify({token_type:'Bearer',access_token:ctx.access_token,
      scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly',expires_at_ms:Date.now()+3600000}),
      {owner_id:owner,connection_id:current,provider:'google-drive',provider_subject:ctx.provider_subject,oauth_client_id:ctx.oauth_client_id,credential_version:2});
     await db.query('begin');try{
      await db.query("update clued_private.storage_connections_v1 set state='active',provider_subject=$2,oauth_client_id=$3,credential_version=2,credential_envelope=$4 where id=$1",[current,ctx.provider_subject,ctx.oauth_client_id,JSON.stringify(envelope)]);
      await db.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
       select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','semantic-reader-fixture/1',c.receipt_id
       from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`,[newPolicy,current]);
      await db.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1",[newPolicy,registration.receipt_id]);
      await db.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[current,newPolicy]);
      await db.query('commit');
     }catch(error){await db.query('rollback');throw error;}
     const issuer=await scalar('select issuer_hash v from clued_private.storage_oauth_apps_v1 where oauth_client_id=$1',[ctx.oauth_client_id]);
     const descriptor=await scalar('select public.clued_storage_scheduled_recovery_v2($1,$2::jsonb) v',[issuer,JSON.stringify({...f.job.reference,action:'load'})]);
     assert.equal(descriptor.recovery_reader.connection_id,current);assert.ok(descriptor.semantic_recovery);
     const calls=[],recovery=await createStorageCloudRecovery({client_id:ctx.oauth_client_id,vault:vaultConfig,fetch:f.storage.fetch,
      rpc:async()=>{throw Error('wrong recovery route');},verified:{descriptor,rpc:async input=>{calls.push(input);return ctx.cloud(input);}}});
     const result=await recovery.run(f.job.reference);assert.equal(result.status,'resolved',JSON.stringify({result,cloudErrors}));
     assert.deepEqual(calls.map(input=>input.action),['semantic_settle']);assert.equal(f.storage.patches,0);
     const audit=(await db.query(`select r.received_payload_hash=clued_private.m1_sha256(e.change_summary||jsonb_build_object('idempotency_key',r.idempotency_key)) digest_valid,
      e.change_summary payload from public.clued_audit_receipts r join public.clued_context_events e on e.receipt_id=r.id where r.id=$1`,[result.receipt_id])).rows[0];
     assert.ok(audit);assert.equal(audit.digest_valid,true);assert.equal(audit.payload.credential_version,2);
     assert.deepEqual(audit.payload.recovery_reader,descriptor.recovery_reader);assert.equal(audit.payload.job_id,f.job.reference.job_id);
     assert.equal((await ctx.journal(f.job)).state,'conflict');assert.equal(await scalar('select state v from clued_private.storage_connections_v1 where id=$1',[originalConnection]),'revoked');
    });
    await t.test("actual content conflict fences only the validated object and releases the running root", async () => {
     const f = await interrupted({ changed: true });const result = await f.recovery.run(f.job.reference);
     assert.equal(result.status, "attention_required", JSON.stringify({ result, cloudErrors }));assert.equal(f.storage.patches, 0);
     const journal = await ctx.journal(f.job);
     const scope = (await db.query("select * from clued_private.storage_conflict_isolations_v1 where intent_id=$1", [journal.id])).rows[0];
     assert.equal(scope.scope_complete, true);assert.deepEqual(scope.object_ids, [f.source.provider_file_id]);
     assert.equal(journal.state, "conflict");
     const independent = await ctx.createFile(f.target, f.client, f.storage, "unrelated.txt");assert.ok(independent);
    });
    const packet = (ctx, request, item, job) => ({ observed_file_version: item.version,
      evidence: createGoogleDriveSemanticAttempt({ oauth_client_id: ctx.oauth_client_id, mutation: job.mutation,
        attempt: request.attempt, file: { ...item, explicitlyTrashed: false } }) });
    await t.test("real account-policy attempt and semantic evidence commit together after a lost acknowledgment", async () => {
      const { target, client, storage } = await ctx.setup();
      const source = await ctx.createFile(target, client, storage, "before.txt");
      const item = storage.files.get(source.provider_file_id);
      const job = await ctx.submitJob(target, client, ctx.modify("rename", source.path, source.path.replace("before.txt", "after.txt"), source.provider_file_version));
      let sent, response, routeFailure;
      const engine = ctx.executor(target, storage, undefined, async request => {
        if (request.action !== "provider_attempt") return;
        sent = { ...request, semantic_attempt: packet(ctx, request, item, job) };
        try { response = await ctx.cloud(sent); }
        catch (error) { routeFailure = { code: error.code, message: error.message, where: error.where }; throw error; }
        throw new Error("synthetic lost attempt acknowledgment");
      });
      const result = await engine.run(job.reference);
      assert.equal(result.status, "unreconciled");
      assert.equal(routeFailure, undefined, JSON.stringify(routeFailure));
      const journal = await ctx.journal(job);
      assert.deepEqual(journal.provider_attempt, sent.attempt);
      assert.equal(storage.patches, 0, "an unknown acknowledgment never permits the effect");
      assert.equal(response.status, "committed");
      const row = (await db.query("select s.*,r.status receipt_status,r.operation receipt_operation,r.response_hash=clued_private.m1_sha256(r.canonical_result) receipt_hash_valid from clued_private.storage_semantic_attempts_v1 s join public.clued_audit_receipts r on r.id=s.receipt_id where s.intent_id=$1", [journal.id])).rows[0];
      assert.equal(row.original_attempt_receipt_id, journal.provider_attempt_receipt_id);
      assert.equal(row.receipt_status, "committed"); assert.equal(row.receipt_operation, "storage_semantic_attempt"); assert.equal(row.receipt_hash_valid, true);
      assert.deepEqual(row.evidence, sent.semantic_attempt.evidence);
      const replay = await ctx.cloud(sent);
      assert.equal(replay.attempt_recorded, false); assert.equal(replay.execution_permitted, false);
      assert.equal(Number(await scalar("select count(*) v from clued_private.storage_semantic_attempts_v1 where intent_id=$1", [journal.id])), 1);
      await assert.rejects(db.query("update clued_private.storage_semantic_attempts_v1 set oauth_client_id='forged' where intent_id=$1", [journal.id]), /storage_semantic_evidence_immutable/);
      await assert.rejects(db.query("delete from clued_private.storage_semantic_attempts_v1 where intent_id=$1", [journal.id]), /storage_semantic_evidence_immutable/);
    });
    for (const fault of ["wrong-client", "forged-after"]) await t.test("real route rolls back original attempt and semantic receipt on " + fault, async () => {
      const { target, client, storage } = await ctx.setup();
      const source = await ctx.createFile(target, client, storage, "before.txt");
      const item = storage.files.get(source.provider_file_id);
      const job = await ctx.submitJob(target, client, ctx.modify("rename", source.path, source.path.replace("before.txt", "after.txt"), source.provider_file_version));
      let beforeCount;
      const engine = ctx.executor(target, storage, undefined, async request => {
        if (request.action !== "provider_attempt") return;
        const proof = packet(ctx, request, item, job);
        const evidence = structuredClone(proof.evidence);
        if (fault === "wrong-client") evidence.oauth_client_id = "other-client";
        else evidence.expected_after.name = "forged.txt";
        beforeCount = Number(await scalar("select count(*) v from public.clued_audit_receipts where user_id=$1 and operation='storage_provider_attempt'", [owner]));
        await ctx.cloud({ ...request, semantic_attempt: { ...proof, evidence } });
        assert.fail("forged evidence unexpectedly committed");
      });
      const result = await engine.run(job.reference);
      assert.equal(result.status, "unreconciled");
      const journal = await ctx.journal(job);
      assert.equal(journal.provider_attempt, null); assert.equal(journal.provider_attempt_receipt_id, null);
      assert.equal(Number(await scalar("select count(*) v from clued_private.storage_semantic_attempts_v1 where intent_id=$1", [journal.id])), 0);
      assert.equal(Number(await scalar("select count(*) v from public.clued_audit_receipts where user_id=$1 and operation='storage_provider_attempt'", [owner])), beforeCount);
      assert.equal(storage.patches, 0);
    });
  } });
  const onCloudError = (error, input) => cloudErrors.push({ action: input.action, code: error.code, message: error.message, where: error.where });
  await testStorageReplace(t, db, server, owner, decision, { gateway: true, only_extra: true, on_cloud_error: onCloudError, extra_cases: async ctx => {
   await t.test("actual semantic replace stamps its upload and settles the old revision pin", async () => {
    const { target, client, storage } = await ctx.setup();const source = await ctx.createFile(target, client, storage, "replace.txt");
    const job = await ctx.submitJob(target, client, ctx.replace(source.path, source.provider_file_version, { content: "new semantic bytes" }));
    const result = await ctx.executor(target, storage, undefined, undefined, null, { semantic: true }).run(job.reference);
    assert.equal(result.status, "committed", JSON.stringify({ result, cloudErrors }));assert.equal(storage.content(source.provider_file_id), "new semantic bytes");
    assert.equal((await ctx.pins(source.id)).length, 1);assert.equal(storage.files.get(source.provider_file_id).appProperties.clued_intent_id, (await ctx.journal(job)).id);
   });
   await t.test("actual lost replace upload is verified and settled after I9 without another upload", async () => {
    const { target, client, storage } = await ctx.setup();const source = await ctx.createFile(target, client, storage, "replace.txt");
    const job = await ctx.submitJob(target, client, ctx.replace(source.path, source.provider_file_version, { content: "already written" }));
    storage.loseUpload = true;
    assert.equal((await ctx.executor(target, storage, undefined, undefined, null, { semantic: true }).run(job.reference)).status, "unreconciled");
    const writes = storage.writes;const recovered = await recover(ctx, target, storage, job);
    assert.equal(recovered.result.status, "committed", JSON.stringify({ recovered: recovered.result, cloudErrors }));
    assert.equal(storage.writes, writes);assert.equal((await ctx.pins(source.id)).length, 1);
   });
   for (const kept of [false, true]) await t.test("actual replace before recovery retains only an observed revision pin: " + kept, async () => {
    const { target, client, storage } = await ctx.setup();const source = await ctx.createFile(target, client, storage, "replace.txt");
    const file = storage.files.get(source.provider_file_id), revision = storage.revisions.get(file.id).get(file.headRevisionId);
    const job = await ctx.submitJob(target, client, ctx.replace(source.path, source.provider_file_version, { content: "not uploaded" }));
    const engine = ctx.executor(target, storage, undefined, async request => {
     if (request.action === "provider_attempt") { await ctx.cloud(request);throw Error("synthetic lost attempt acknowledgment"); }
    }, null, { semantic: true });
    assert.equal((await engine.run(job.reference)).status, "unreconciled");
    revision.keepForever = kept;file.version = "99";
    const writes = storage.writes;const recovered = await recover(ctx, target, storage, job);
    assert.equal(recovered.result.status, "resolved", JSON.stringify({ recovered: recovered.result, cloudErrors }));
    assert.equal(storage.writes, writes);assert.equal(storage.content(source.provider_file_id), "original text\n");
    assert.equal((await ctx.pins(source.id)).length, kept ? 1 : 0);
    assert.equal((await ctx.artifact(target, source.path)).provider_file_version, "99");
   });
  } });
  await testStorageDestructive(t, db, server, owner, decision, { gateway: true, only_extra: true, on_cloud_error: onCloudError, extra_cases: async ctx => {
   for (const digest of [null, {}, "unproven"]) await t.test("private attempt route atomically rejects missing or invalid directory access evidence: " + JSON.stringify(digest), async () => {
    const { target, client, storage } = await ctx.setup();const source = await ctx.directoryIn(target, storage, "invalid-access");
    const job = await ctx.submitJob(target, client, ctx.trash(source));
    const engine = ctx.executor(target, storage, async request => {
     if (request.action === "provider_attempt") request.semantic_attempt.evidence.before.access_digest = digest;
    }, { semantic: true });
    assert.equal((await engine.run(job.reference)).status, "unreconciled");
    const row = await ctx.journal(job);assert.equal(row.provider_attempt, null);assert.equal(row.provider_attempt_receipt_id, null);
    assert.equal(Number(await scalar("select count(*) v from clued_private.storage_semantic_attempts_v1 where intent_id=$1", [row.id])), 0);
    assert.equal(storage.patches, 0);
   });
   for (const aclChanged of [false, true]) await t.test("directory before version refresh requires the original access state: " + !aclChanged, async () => {
    const { target, client, storage } = await ctx.setup();const source = await ctx.directoryIn(target, storage, "access-bound");
    assert.equal(source.provider_access_digest, null);assert.equal(source.provider_sharing_digest, null);
    const job = await ctx.submitJob(target, client, ctx.trash(source));
    const engine = ctx.executor(target, storage, async request => {
     if (request.action === "provider_attempt") { await ctx.cloud(request);throw Error("synthetic lost acknowledgment"); }
    }, { semantic: true });
    assert.equal((await engine.run(job.reference)).status, "unreconciled");
    const item = storage.files.get(source.provider_file_id);item.version = "99";
    if (aclChanged) item.permissions.push({ id: "anyone", type: "anyone", role: "reader" });
    const recovered = await recover(ctx, target, storage, job);
    assert.equal(recovered.result.status, aclChanged ? "attention_required" : "resolved", JSON.stringify({ result: recovered.result, cloudErrors }));
    assert.equal((await ctx.artifactById(source.id)).provider_file_version, aclChanged ? source.provider_file_version : "99");
    assert.equal(storage.patches, 0);
   });
   for (const kind of ["file", "directory"]) await t.test("actual semantic trash and restore settle one " + kind + " by its original identity", async () => {
    const { target, client, storage } = await ctx.setup();
    const source = kind === "file" ? await ctx.createFile(target, client, storage, "trash.txt") : await ctx.directoryIn(target, storage, "empty");
    const job = await ctx.submitJob(target, client, ctx.trash(source));
    const done = await ctx.executor(target, storage, undefined, { semantic: true }).run(job.reference);
    assert.equal(done.status, "committed", JSON.stringify({ done, cloudErrors }));
    const trashed = await ctx.artifactById(source.id);assert.equal(trashed.state, "trashed");
    const restore = await ctx.submitJob(target, client, ctx.untrash(trashed));
    const restored = await ctx.executor(target, storage, undefined, { semantic: true }).run(restore.reference);
    assert.equal(restored.status, "committed", JSON.stringify({ restored, cloudErrors }));
    assert.equal((await ctx.artifactById(source.id)).state, "active");assert.equal(storage.patches, 2);assert.equal(storage.deletes, 0);
   });
   for (const operation of ["delete", "restore"]) await t.test("actual " + operation + " before-state is automatically reconciled without another PATCH", async () => {
    const { target, client, storage } = await ctx.setup();let source = await ctx.createFile(target, client, storage, "trash.txt");
    if (operation === "restore") source = await ctx.trashed(target, client, storage, source);
    const job = await ctx.submitJob(target, client, operation === "delete" ? ctx.trash(source) : ctx.untrash(source));
    const engine = ctx.executor(target, storage, async request => {
     if (request.action === "provider_attempt") { await ctx.cloud(request);throw Error("synthetic lost attempt acknowledgment"); }
    }, { semantic: true });
    assert.equal((await engine.run(job.reference)).status, "unreconciled");
    const patches = storage.patches;const recovered = await recover(ctx, target, storage, job);
    assert.equal(recovered.result.status, "resolved", JSON.stringify({ recovered: recovered.result, cloudErrors }));
    assert.equal(storage.patches, patches);assert.equal((await ctx.artifactById(source.id)).state, operation === "restore" ? "trashed" : "active");
   });
  } });
  await assertGatewayCloseoutBoundary(db);
 } finally {
  if (db) await db.end().catch(() => {});
  if (started && process.platform === "win32") {
   // embedded-postgres uses an external taskkill process on Windows; a sandbox
   // may hide its PID namespace. Use the handle of our OWN disposable child,
   // then detach only after its observed exit. Never enumerate/kill other PIDs.
   const child = server.process;
   if (child && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Disposable PostgreSQL shutdown timed out")), 10000);
    child.once("exit", () => { clearTimeout(timer);resolve(); });
    child.once("error", error => { clearTimeout(timer);reject(error); });
    if (!child.kill("SIGTERM")) { clearTimeout(timer);reject(new Error("Disposable PostgreSQL shutdown refused")); }
   });
   server.process = undefined;
  }
  if (started) await stopCluster(server);
  const resolved = await fs.realpath(dir).catch(() => null);
  if (resolved && path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith("kooyumi-semantic-db-"))
   await removeTestDirectory(resolved);
 }
});
