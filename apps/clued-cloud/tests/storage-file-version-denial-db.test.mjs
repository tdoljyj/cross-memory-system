import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import test from "node:test";
import { AUTHORIZATION_SUCCESSOR_MIGRATIONS, snapshotAuthorizationCallerBoundary, assertAuthorizationSuccessorBoundary, snapshotCallerCatalog, findGatewayCloseoutMigration, setWorkerGatewayCaller, assertGatewayCloseoutBoundary, replayGatewayCloseout } from "./worker-gateway-caller-fixture.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("file-version diagnosis on the current full migration chain remains read-only and fail-closed", { timeout: 180000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-file-version-db-"));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: "postgres", password: crypto.randomBytes(32).toString("hex"),
    port: await freePort(), persistent: false, postgresFlags: ["-c", "io_method=sync"], onLog() {}, onError(message) { process.stderr.write(message + "\n"); } });
  let admin, caller;
  try {
    await server.initialise(); await server.start();
    admin = server.getPgClient(); await admin.connect();
    await admin.query("create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;" +
      "create role authenticator nologin noinherit; create schema auth; create schema extensions; create extension pgcrypto with schema extensions;" +
      "create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);" +
      "create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);" +
      "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;" +
      "create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;" +
      "grant usage on schema auth,extensions to anon,authenticated,service_role; grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
    const migrationDir = path.join(process.cwd(), "supabase", "migrations");
    const closeout = await findGatewayCloseoutMigration(process.cwd());
    for (const name of (await fs.readdir(migrationDir)).filter(name => name.endsWith(".sql") && name !== closeout && !AUTHORIZATION_SUCCESSOR_MIGRATIONS.includes(name)).sort()) {
      try { await admin.query(await fs.readFile(path.join(migrationDir, name), "utf8")); }
      catch (error) { throw new Error("Migration " + name + ": " + error.message, { cause: error }); }
    }
    await replayGatewayCloseout(admin, await fs.readFile(path.join(migrationDir, closeout), "utf8"));
    await assertGatewayCloseoutBoundary(admin);
    const acl = async () => (await admin.query("select proacl::text,prosecdef,proconfig from pg_proc where oid='public.clued_resource_center_authority_v1(text,jsonb)'::regprocedure")).rows;
    const beforeAcl = await acl();
    await admin.query(await fs.readFile(path.join(migrationDir, "20261012120000_storage_file_version_denial_v1.sql"), "utf8"));
    assert.deepEqual(await acl(), beforeAcl, "replay preserves exact current ACL");
    const user = crypto.randomUUID(), project = crypto.randomUUID(), decision = crypto.randomUUID(), fileDecision = crypto.randomUUID();
    await admin.query("insert into auth.users(id,email) values($1,'version-test@example.invalid')", [user]);
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Version test','version test',$3,'confirmed',now())", [project, user, "project:" + project]);
    for (const id of [decision, fileDecision]) await admin.query("insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)" +
      " values($1,$2,'Synthetic approval','Temporary test only','project',$3,'decision','active',1,'active',$4,'{\"rationale\":\"Test registration\"}','{}','{}','user_explicit','Owner confirmed')", [id, user, project, "project:" + project]);
    const register = async input => (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user, JSON.stringify({ source_decision_id: decision, idempotency_key: crypto.randomUUID(), ...input })])).rows[0].value;
    const root = "G:/My Drive/Clued_资料中心", folder = root + "/20_P_产品与体验", file = folder + "/fixed.md", proof = crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
    const registered = await register({ action: "profile_register", project_id: project, profile_version: "version-test/1", managed_root: root, root_folder_id: "root", root_parent_id: "parent", root_folder_version: "1" });
    assert.equal(registered.status, "committed");
    const profile = registered.target_refs.find(ref => ref.role === "primary").id;
    assert.equal((await register({ action: "artifact_register", profile_id: profile, path: folder, provider_file_id: "folder", provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false })).status, "committed");
    assert.equal((await register({ action: "artifact_register", profile_id: profile, path: file, provider_file_id: "fixed", provider_file_version: "2", target_kind: "file", governance_class: "ordinary", delete_authority: false, source_decision_id: fileDecision })).status, "committed");
    assert.equal((await register({ action: "binding_issue", profile_id: profile, token_hash: proof, expires_at: new Date(Date.now() + 3600000).toISOString() })).status, "committed");
    caller = server.getPgClient(); await caller.connect(); await setWorkerGatewayCaller(caller);
    const mutation = { operation: "replace", target_kind: "file", artifact_role: "clued_resource", destination_path: file };
    const provider = { root_folder_id: "root", root_parent_id: "parent", root_folder_version: "1", destination_parent_id: "folder", destination_parent_version: "1", destination_file_id: "fixed", destination_file_version: "3", provider_version: "a".repeat(64) };
    const resolve = async (providerExtra = {}, mutationExtra = {}) => (await caller.query("select public.clued_resource_center_authority_v1($1,$2::jsonb) value", [proof, JSON.stringify({ profile_id: profile, profile_version: "version-test/1", policy_version: "clued.resource-center-mutation-policy/1", mutation: { ...mutation, ...mutationExtra }, provider_identity: { ...provider, ...providerExtra } })])).rows[0].value;
    const snapshot = async () => ({
      artifacts: (await admin.query("select id,path,provider_file_id,provider_file_version,version,source_decision_id,receipt_id from clued_private.resource_center_artifacts_v1 where profile_id=$1 order by id", [profile])).rows,
      receipts: (await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n,
      events: (await admin.query("select count(*)::int n from public.clued_context_events")).rows[0].n,
    });
    const before = await snapshot();
    await t.test("same identity at another version is denied with only the fixed label", async () => {
      assert.deepEqual(await resolve(), { status: "denied", reason: "destination_version_mismatch" });
      assert.deepEqual(await resolve(), { status: "denied", reason: "destination_version_mismatch" }, "re-reading does not repair it");
      assert.deepEqual(await snapshot(), before, "diagnosis changes no registry, Event or Receipt");
    });
    await t.test("matching version still resolves; other identity and shape failures are not misclassified", async () => {
      assert.equal((await resolve({ destination_file_version: "2" })).status, "resolved");
      for (const extra of [{ destination_file_id: "another-file" }, { destination_file_version: null }, { ancestors: [] }])
        assert.deepEqual(await resolve(extra), { status: "denied", reason: "destination_mismatch" });
      assert.deepEqual(await resolve({}, { target_kind: "directory" }), { status: "denied", reason: "destination_mismatch" });
      assert.deepEqual(await resolve({ destination_parent_id: "other-folder" }), { status: "denied", reason: "parent_unregistered" });
      assert.deepEqual(await snapshot(), before);
    });
    await t.test("a revoked file Decision never exposes the file-version category", async () => {
      await admin.query("update public.clued_memories set lifecycle_status='revoked' where id=$1", [fileDecision]);
      assert.deepEqual(await resolve(), { status: "denied", reason: "destination_mismatch" });
    });
    await t.test("historical diagnosis closes with sealed G6 replay before current authorization successors", async () => {
      const historicalCatalog = await snapshotCallerCatalog(admin);
      await replayGatewayCloseout(admin, await fs.readFile(path.join(migrationDir, closeout), "utf8"));
      assert.deepEqual(await snapshotCallerCatalog(admin), historicalCatalog,
        "actual sealed closeout replay preserves historical definitions and caller ACLs");
      await assertGatewayCloseoutBoundary(admin);
      const authorizationBefore = await snapshotAuthorizationCallerBoundary(admin);
      for (const name of AUTHORIZATION_SUCCESSOR_MIGRATIONS) {
        await admin.query(await fs.readFile(path.join(migrationDir, name), "utf8"));
      }
      await assertAuthorizationSuccessorBoundary(admin, authorizationBefore);
    });

  } finally {
    if (caller) await caller.end().catch(() => {});
    if (admin) await admin.end().catch(() => {});
    await server.stop().catch(() => {});
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("clued-file-version-db-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
