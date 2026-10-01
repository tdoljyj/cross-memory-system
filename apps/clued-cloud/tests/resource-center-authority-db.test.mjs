import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import EmbeddedPostgres from "embedded-postgres";

import { createResourceCenterGoogleDriveOnlineToolHost, createResourceCenterGoogleDriveWriterToolHost,
  createResourceCenterGoogleDriveNativeWriterToolHost } from "../../../kernel/host/resource-center-online-tool-host.mjs";
import { createResourceCenterRecoveryStore, createResourceCenterProviderAttemptStore } from "../../../kernel/host/resource-center-recovery-store.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
import { testRenewalDatabase } from "./resource-center-renewal-db.fixture.mjs";
import { testStorageAccount } from "./resource-center-account-db.fixture.mjs";
import { testStorageOAuth } from "./resource-center-oauth-db.fixture.mjs";
import { testAccountRefresh } from "./resource-center-account-refresh-db.fixture.mjs";
import { testDirectoryProbe } from "./resource-center-directory-probe-db.fixture.mjs";
import { testAccountPolicy } from "./resource-center-account-policy-db.fixture.mjs";
import { testStorageClientCapability } from "./resource-center-client-capability-db.fixture.mjs";
import { testStoragePolicyTransition } from "./resource-center-policy-transition-db.fixture.mjs";
import { testStorageAdmin } from "./resource-center-storage-admin-db.fixture.mjs";
import { testStorageSourceReader } from "./resource-center-storage-source-reader-db.fixture.mjs";
import { testAccountCloud } from "./resource-center-account-cloud-db.fixture.mjs";
import { testStorageRead } from "./resource-center-storage-read-db.fixture.mjs";
import { testStorageClientRedirectIdentity } from "./resource-center-client-redirect-identity-db.fixture.mjs";
import { testStorageReadContent } from "./resource-center-storage-read-content-db.fixture.mjs";
import { testStorageModifyLevel } from "./resource-center-storage-modify-level-db.fixture.mjs";
import { testStorageModifyExecution } from "./resource-center-storage-modify-execution-db.fixture.mjs";
import { testStorageReplace } from "./resource-center-storage-replace-db.fixture.mjs";
import { testStorageNormalUse } from "./resource-center-storage-normal-use-db.fixture.mjs";
import { testStorageBinaryUpload } from "./resource-center-storage-binary-db.fixture.mjs";
import { testStorageBudget } from "./resource-center-storage-budget-db.fixture.mjs";
import { seedRefreshUpgrade, verifyRefreshUpgrade } from "./resource-center-refresh-upgrade-db.fixture.mjs";

const USER = "10000000-0000-4000-8000-000000000071";
const PROJECT = "20000000-0000-4000-8000-000000000071";
const DECISION = "30000000-0000-4000-8000-000000000071";
const ROOT = "G:/My Drive/Clued_资料中心";
const ROOT_ID = "drive-root-id";
const TRACK = ROOT + "/20_P_产品与体验";
const TRACK_ID = "drive-track-id";
const tokenHash = crypto.createHash("sha256").update("clued_rcb_test_token").digest("hex");

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const focusedCloud = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "account-cloud";
const focusedAdmin = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-admin";
const focusedRead = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-read";
for (const bindingSchema of focusedCloud || focusedAdmin || focusedRead ? ["legacy-expiry"] : ["legacy-expiry", "production-no-legacy-expiry"]) test(`Canonical Resource Center registration and exact read-only authority (${bindingSchema})`, { timeout: 180000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-resource-center-db-"));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: "postgres", password: crypto.randomBytes(32).toString("hex"),
    port: await freePort(), persistent: false, postgresFlags: ["-c", "io_method=sync"],
    onLog() {}, onError(message) { process.stderr.write(message + "\n"); },
  });
  let admin;
  let anon;
  try {
    await server.initialise();
    await server.start();
    admin = server.getPgClient();
    await admin.connect();
    await admin.query("create role anon nologin; create role authenticated nologin;" +
      "create role service_role nologin bypassrls; create role authenticator nologin noinherit;" +
      "create schema auth; create schema extensions; create extension pgcrypto with schema extensions;" +
      "create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);" +
      "create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);" +
      "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;" +
      "create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;" +
      "grant usage on schema auth,extensions to anon,authenticated,service_role;" +
      "grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
    const migrationDir = path.join(process.cwd(), "supabase", "migrations");
    let refreshUpgrade;
    for (const name of (await fs.readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort()) {
      try {
        if (name === "20260927145426_resource_center_default_refresh_consent_v1.sql") refreshUpgrade = await seedRefreshUpgrade(admin,server);
        if (name === "20260927232454_resource_center_binding_expiry_compat_v1.sql" && bindingSchema === "production-no-legacy-expiry") {
          // Model the deployed shape only in this ephemeral database. Prove the
          // native readback fails before this successor and works after it.
          await admin.query("alter table public.clued_agent_bindings drop column expires_at restrict");
          const native = server.getPgClient(); await native.connect();
          try {
            await native.query("set role authenticated");
            await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
              [refreshUpgrade.user,JSON.stringify({sub:refreshUpgrade.user,session_id:refreshUpgrade.session})]);
            const read = () => native.query("select public.clued_storage_account_v1($1::jsonb) value",
              [JSON.stringify({action:"client_grants",connection_id:refreshUpgrade.connections[0].id})]);
            const before = (await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n;
            await t.test("deployed missing-column readback reproduces before the exact successor",async()=>{
              await assert.rejects(read(),/column b\.expires_at does not exist/);
            });
            await admin.query(await fs.readFile(path.join(migrationDir,name),"utf8"));
            await t.test("the same native readback succeeds after the successor without a receipt or schema expansion",async()=>{
              assert.deepEqual((await read()).rows[0].value.grants,[]);
              assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n,before);
            });
          } finally {await native.end();}
          continue;
        }
        await admin.query(await fs.readFile(path.join(migrationDir, name), "utf8"));
      } catch (error) {
        throw new Error("Migration " + name + ": " + error.message, { cause: error });
      }
    }
    await t.test("Binding schema explicitly covers deployed missing-column and optional legacy shapes",async()=>{
      const has=(await admin.query("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='clued_agent_bindings' and column_name='expires_at') present")).rows[0].present;
      assert.equal(has,bindingSchema==="legacy-expiry");
    });
    await t.test("actual upgrade never opts in pre-existing connections or old attempts, including a pre-delegation stop",async()=>{
      assert.ok(refreshUpgrade);
      await verifyRefreshUpgrade(admin,server,refreshUpgrade);
    });
    await admin.query("insert into auth.users(id,email) values($1,'owner@example.invalid')", [USER]);
    await admin.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)" +
      " values($1,$2,'Resource Center','resource center',$3,'confirmed',now())",
    [PROJECT, USER, "project:" + PROJECT]);
    await admin.query("insert into public.clued_memories(" +
      "id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status," +
      "canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)" +
      " values($1,$2,'Owner approval','Temporary test objects only','project',$3,'decision','active',1,'active'," +
      "$4,'{\"rationale\":\"Test registration\"}','{}','{}','user_explicit','Owner confirmed')",
    [DECISION, USER, PROJECT, "project:" + PROJECT]);

    // Fast local diagnosis only. CI leaves this unset and runs both complete
    // schema shapes plus every existing Resource Center regression.
    if (focusedCloud) {
      await testAccountCloud(t, admin, server, USER, DECISION);
      return;
    }

    if (focusedRead) {
      await testStorageRead(t, admin, server, USER, DECISION);
      await testStorageClientRedirectIdentity(t, admin, server, USER, DECISION);
      await testStorageReadContent(t, admin, server, USER, DECISION);
      await testStorageModifyLevel(t, admin, server, USER, DECISION);
      await testStorageModifyExecution(t, admin, server, USER, DECISION);
      await testStorageReplace(t, admin, server, USER, DECISION);
      await testStorageNormalUse(t, admin, server, USER, DECISION);
      await testStorageBinaryUpload(t, admin, server, USER, DECISION);
      await testStorageBudget(t, admin, server, USER);
      return;
    }

    if (focusedAdmin) {
      await testStorageAdmin(t, admin, server, USER, PROJECT);
      await testStorageClientCapability(t, admin, server, USER, DECISION);
      await testStorageSourceReader(t, admin);
      await testStoragePolicyTransition(t, admin, server, USER, DECISION);
      return;
    }

    const adminCall = async (input) => (await admin.query(
      "select public.clued_resource_center_admin_v1($1,$2::jsonb) value",
      [USER, JSON.stringify({
        idempotency_key: crypto.randomUUID(), source_decision_id: DECISION, ...input,
      })],
    )).rows[0].value;
    const registered = await adminCall({
      action: "profile_register", project_id: PROJECT, profile_version: "test/1",
      managed_root: ROOT, root_folder_id: ROOT_ID, root_parent_id: "my-drive",
      root_folder_version: "1",
    });
    assert.equal(registered.status, "committed");
    assert.equal(registered.event_ids.length, 1);
    const profileId = registered.target_refs.find((ref) => ref.role === "primary").id;
    assert.ok(profileId);
    assert.equal((await admin.query(
      "select status from public.clued_audit_receipts where id=$1", [registered.receipt_id],
    )).rows[0].status, "committed");

    const track = await adminCall({
      action: "artifact_register", profile_id: profileId, path: TRACK,
      provider_file_id: TRACK_ID, provider_file_version: "2",
      target_kind: "directory", governance_class: "ordinary", delete_authority: false,
    });
    assert.equal(track.status, "committed");
    const issued = await adminCall({
      action: "binding_issue", profile_id: profileId, token_hash: tokenHash,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    assert.equal(issued.status, "committed");
    const bindingId = issued.target_refs.find((ref) => ref.role === "primary").id;

    anon = server.getPgClient();
    await anon.connect();
    await anon.query("set role anon");
    const providerIdentity = {
      root_folder_id: ROOT_ID, root_parent_id: "my-drive", root_folder_version: "1",
      source_file_id: null, source_file_version: null,
      destination_parent_id: TRACK_ID, destination_parent_version: "2",
      destination_file_id: null, destination_file_version: null,
      provider_version: "a".repeat(64),
    };
    const mutation = {
      operation: "create", source_path: null,
      destination_path: TRACK + "/视觉探索", artifact_role: "clued_resource",
      target_kind: "directory", directory_semantics: "topic", artifact_id: null,
      governance_class: null, delete_authority: false,
      artifact_authority_version: null, duplicate_bytes: false,
      currentness_identity: null, workspace_version: null,
    };
    const resolve = async (overrides = {}) => {
      const request = {
        contract: "clued.resource-center-authority/1", nonce: crypto.randomUUID(),
        policy_version: "clued.resource-center-mutation-policy/1",
        profile_id: profileId, profile_version: "test/1",
        provider_identity: providerIdentity, mutation, ...overrides,
      };
      return (await anon.query(
        "select public.clued_resource_center_authority_v1($1,$2::jsonb) value",
        [tokenHash, JSON.stringify(request)],
      )).rows[0].value;
    };
    const allowed = await resolve();
    assert.equal(allowed.status, "resolved");
    assert.equal(allowed.authority.artifact_id, null);
    assert.equal(allowed.authority.governance_class, "ordinary");
    assert.match(allowed.authority.currentness_identity, /^decision:/);
    assert.match(allowed.authority.authority_version, /:1:1$/);
    const exactRequest = (digest) => ({ mutation, binding: {
      ...mutation, profile_id: profileId, profile_version: "test/1",
      policy_version: "clued.resource-center-mutation-policy/1", request_sha256: digest,
      artifact_authority_version: allowed.authority.authority_version,
      currentness_identity: allowed.authority.currentness_identity,
      governance_class: allowed.authority.governance_class,
    } });

    await t.test("durable journal fences restart, start replay and uncertain effects", async () => {
      const journal = async (input, client = admin) => (await client.query(
        "select public.clued_resource_center_mutation_journal_v1($1,$2::jsonb) value",
        [USER, JSON.stringify({ profile_id: profileId, source_decision_id: DECISION,
          idempotency_key: crypto.randomUUID(), ...input })],
      )).rows[0].value;
      const prepare = {
        action: "prepare", request_key: "durable-create-1", request_sha256: "b".repeat(64),
        exact_request: exactRequest("b".repeat(64)), authority_token_hash: tokenHash,
        authority_request: {
          profile_id: profileId, profile_version: "test/1",
          policy_version: "clued.resource-center-mutation-policy/1",
          provider_identity: providerIdentity, mutation,
        },
      };
      await assert.rejects(journal(prepare, anon), /permission denied/);
      assert.equal((await journal({ ...prepare, exact_request: { ...prepare.exact_request,
        binding: { ...prepare.exact_request.binding, destination_path: TRACK + "/substituted" } } })).status, "rejected");
      const prepared = await journal(prepare);
      assert.equal(prepared.status, "committed");
      assert.equal(prepared.state, "prepared");
      assert.equal(prepared.execution_permitted, false);
      assert.equal((await journal({ action: "inspect", request_key: prepare.request_key,
        request_sha256: prepare.request_sha256 })).intent_id, prepared.intent_id);
      const bound = { intent_id: prepared.intent_id, request_sha256: prepare.request_sha256 };
      const competitor = server.getPgClient();
      await competitor.connect();
      try {
        const other = await journal({ ...prepare, request_key: "another-host" }, competitor);
        assert.equal(other.status, "rejected");
        const start = { ...bound, action: "start", base_version: 1,
          idempotency_key: "durable-start-once" };
        const results = await Promise.all([journal(start), journal({ ...start,
          idempotency_key: "competing-start" }, competitor)].map((attempt) =>
          attempt.catch((error) => ({ error: error.message }))));
        assert.equal(results.filter((value) => value.execution_permitted === true).length, 1);
        await assert.rejects(journal(start), /intent_conflict/);
        const unknown = await journal({ ...bound, action: "uncertain", base_version: 2 });
        assert.equal(unknown.state, "uncertain");
        // Expiry is not a lock-release mechanism once the effect might exist.
        await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=now()-interval '1 hour' where id=$1", [prepared.intent_id]);
        assert.equal((await journal({ ...prepare, request_key: "after-restart" }, competitor)).status, "rejected");
        assert.equal((await journal({ ...bound, action: "cancel", base_version: 3 })).status, "rejected");
        const postcondition = { path: mutation.destination_path, parent_id: TRACK_ID,
          provider_file_id: "journal-created-topic", provider_file_version: "1" };
        assert.equal((await journal({ ...bound, action: "finalize", base_version: 3,
          postcondition: { ...postcondition, path: ROOT + "/wrong" } })).status, "rejected");
        assert.equal((await journal({ ...bound, action: "inspect" })).status, "uncertain");
        const finalized = await journal({ ...bound, action: "finalize", base_version: 3, postcondition });
        assert.equal(finalized.state, "committed");
        assert.equal(finalized.final_result.status, "committed");
        assert.equal(finalized.execution_permitted, false);
        const receipt = await admin.query("select status from public.clued_audit_receipts where id=$1", [finalized.receipt_id]);
        assert.equal(receipt.rows[0].status, "committed");
        assert.equal((await journal({ ...bound, action: "inspect" }, competitor)).status, "committed");
        assert.equal((await admin.query("select count(*)::int n from clued_private.resource_center_artifacts_v1 where provider_file_id='journal-created-topic'")).rows[0].n, 1);
      } finally {
        await competitor.end();
      }
      // Keep later read-resolver fixtures independent of this created topic.
      const artifact = (await admin.query("select id,version from clued_private.resource_center_artifacts_v1 where provider_file_id='journal-created-topic'")).rows[0];
      assert.equal((await adminCall({ action: "artifact_revoke", profile_id: profileId,
        artifact_id: artifact.id, base_version: artifact.version })).status, "committed");
    });

    await t.test("expired unstarted journal can cancel but cannot execute", async () => {
      const journal = async (input) => (await admin.query(
        "select public.clued_resource_center_mutation_journal_v1($1,$2::jsonb) value",
        [USER, JSON.stringify({ profile_id: profileId, source_decision_id: DECISION,
          idempotency_key: crypto.randomUUID(), ...input })],
      )).rows[0].value;
      const prepared = await journal({ action: "prepare", request_key: "expired-create",
        request_sha256: "c".repeat(64), exact_request: exactRequest("c".repeat(64)), authority_token_hash: tokenHash,
        authority_request: { profile_id: profileId, profile_version: "test/1",
          policy_version: "clued.resource-center-mutation-policy/1", provider_identity: providerIdentity, mutation } });
      assert.equal(prepared.state, "prepared");
      await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=now()-interval '1 second' where id=$1", [prepared.intent_id]);
      const bound = { intent_id: prepared.intent_id, request_sha256: "c".repeat(64), base_version: 1 };
      assert.equal((await journal({ ...bound, action: "start" })).status, "rejected");
      assert.equal((await journal({ ...bound, action: "cancel" })).state, "cancelled");
    });

    await t.test("a second profile cannot bypass the fence for the same provider root", async () => {
      const alias = await adminCall({ action: "profile_register", project_id: PROJECT,
        profile_version: "alias/1", managed_root: "G:/Alias/Clued_资料中心",
        root_folder_id: ROOT_ID, root_parent_id: "my-drive", root_folder_version: "1" });
      assert.equal(alias.status, "rejected");
    });

    await t.test("writer revocation wins a waiting start and exact fenced recovery releases no-effect intent", async () => {
      const writerHash = crypto.createHash("sha256").update("revocation-race").digest("hex");
      const issue = (await admin.query("select public.clued_resource_center_writer_admin_v1($1,$2::jsonb) value",
        [USER, JSON.stringify({ action: "issue", authority_binding_id: bindingId,
          source_decision_id: DECISION, token_hash: writerHash, idempotency_key: crypto.randomUUID(),
          expires_at: new Date(Date.now() + 600000).toISOString() })])).rows[0].value;
      const writerId = issue.target_refs.find((ref) => ref.role === "primary").id;
      const digest = "d".repeat(64);
      const request = { action: "prepare", request_key: "revoke-race", request_sha256: digest,
        idempotency_key: crypto.randomUUID(), exact_request: exactRequest(digest),
        authority_request: { profile_id: profileId, profile_version: "test/1",
          policy_version: "clued.resource-center-mutation-policy/1", provider_identity: providerIdentity, mutation } };
      const call = async (input, client = anon) => (await client.query(
        "select public.clued_resource_center_write_v1($1,$2::jsonb) value",
        [writerHash, JSON.stringify(input)])).rows[0].value;
      const prepared = await call(request);
      assert.equal(prepared.state, "prepared");
      const competitor = server.getPgClient();
      await competitor.connect();
      const pid = (await competitor.query("select pg_backend_pid() pid")).rows[0].pid;
      await competitor.query("set role anon");
      let pendingStart;
      try {
        await admin.query("begin");
        const revoke = (await admin.query("select public.clued_resource_center_writer_admin_v1($1,$2::jsonb) value",
          [USER, JSON.stringify({ action: "revoke", authority_binding_id: bindingId,
            writer_binding_id: writerId, source_decision_id: DECISION, idempotency_key: crypto.randomUUID() })])).rows[0].value;
        assert.equal(revoke.status, "committed");
        pendingStart = call({ action: "start", intent_id: prepared.intent_id,
          request_sha256: digest, base_version: 1, idempotency_key: crypto.randomUUID() }, competitor);
        let blocked = false;
        for (let i = 0; i < 100; i += 1) {
          blocked = (await admin.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type === "Lock";
          if (blocked) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, "start must actually wait behind revocation");
        await admin.query("commit");
        assert.equal((await pendingStart).status, "denied");
      } finally {
        await admin.query("rollback");
        if (pendingStart) await pendingStart;
        await competitor.end();
      }
      const journal = async (input) => (await admin.query(
        "select public.clued_resource_center_mutation_journal_v1($1,$2::jsonb) value",
        [USER, JSON.stringify({ profile_id: profileId, writer_binding_id: writerId,
          source_decision_id: DECISION, intent_id: prepared.intent_id, request_sha256: digest,
          idempotency_key: crypto.randomUUID(), ...input })])).rows[0].value;
      assert.equal((await journal({ action: "inspect" })).status, "prepared");
      // Trusted internal journal simulates an already-issued permit. No storage
      // effect is performed by this test. Revocation alone cannot settle it.
      assert.equal((await journal({ action: "start", base_version: 1 })).state, "started");
      assert.equal((await journal({ action: "settle_no_effect", base_version: 2,
        recovery_decision_id: DECISION })).status, "rejected");
      assert.equal((await call({ action: "settle_no_effect" })).status, "denied");
      await admin.query("update clued_private.resource_center_profiles_v1 set state='revoked' where id=$1", [profileId]);
      const replacement = await adminCall({ action: "profile_register", project_id: PROJECT,
        profile_version: "replacement/1", managed_root: ROOT,
        root_folder_id: ROOT_ID, root_parent_id: "my-drive", root_folder_version: "1" });
      assert.equal(replacement.status, "committed");
      const replacementId = replacement.target_refs.find((ref) => ref.role === "primary").id;
      const fenced = await journal({ ...request, profile_id: replacementId, writer_binding_id: null,
        idempotency_key: crypto.randomUUID() });
      assert.equal(fenced.status, "rejected");
      assert.match(fenced.error_code, /provider_root_fenced/);
      assert.equal((await adminCall({ action: "profile_revoke", profile_id: replacementId, base_version: 1 })).status, "committed");
      const recoveryId = crypto.randomUUID();
      await admin.query("insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status," +
        "record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)" +
        " select $1,user_id,'Exact test recovery','Executor terminated then provider absence verified',scope,project_id," +
        "record_type,status,record_schema_version,lifecycle_status,canonical_scope,$2::jsonb,relations,source_refs,authority,confidence_reason" +
        " from public.clued_memories where id=$3", [recoveryId, JSON.stringify({ rationale: "Test-only exact recovery",
          resource_center_recovery_intent_id: prepared.intent_id, resource_center_recovery_request_sha256: digest,
          executor_terminated: true, provider_absence_verified_after_termination: true }), DECISION]);
      await admin.query("update public.clued_memories set lifecycle_status='revoked' where id=$1", [DECISION]);
      try {
        const inspected = await journal({ action: "inspect", source_decision_id: recoveryId });
        assert.equal(inspected.status, "started");
        const settled = await journal({ action: "settle_no_effect", base_version: 2,
          source_decision_id: recoveryId, recovery_decision_id: recoveryId });
        assert.equal(settled.state, "cancelled");
        assert.equal(settled.execution_permitted, false);
        assert.equal(settled.final_result.outcome, "verified_no_effect");
        assert.equal((await admin.query("select status from public.clued_audit_receipts where id=$1", [settled.receipt_id])).rows[0].status, "committed");
      } finally {
        // Fixture isolation only; production recovery must never reactivate old grants.
        await admin.query("update public.clued_memories set lifecycle_status='active' where id=$1", [DECISION]);
        await admin.query("update clued_private.resource_center_profiles_v1 set state='active' where id=$1", [profileId]);
      }
    });

    await t.test("new Owner authority can cancel prepared intent after original profile and Decision revocation", async () => {
      const recoveryId = crypto.randomUUID();
      await admin.query("insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status," +
        "record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason)" +
        " select $1,user_id,'Cancel unstarted test intent',content,scope,project_id,record_type,status," +
        "record_schema_version,lifecycle_status,canonical_scope,type_fields,relations,source_refs,authority,confidence_reason" +
        " from public.clued_memories where id=$2", [recoveryId, DECISION]);
      const journal = async (input) => (await admin.query(
        "select public.clued_resource_center_mutation_journal_v1($1,$2::jsonb) value",
        [USER, JSON.stringify({ profile_id: profileId, source_decision_id: recoveryId,
          idempotency_key: crypto.randomUUID(), ...input })])).rows[0].value;
      const prepared = await journal({ action: "prepare", request_key: "revoked-prepared",
        request_sha256: "e".repeat(64), exact_request: exactRequest("e".repeat(64)), authority_token_hash: tokenHash,
        authority_request: { profile_id: profileId, profile_version: "test/1",
          policy_version: "clued.resource-center-mutation-policy/1", provider_identity: providerIdentity, mutation } });
      assert.equal(prepared.state, "prepared");
      await admin.query("update clued_private.resource_center_profiles_v1 set state='revoked' where id=$1", [profileId]);
      await admin.query("update public.clued_memories set lifecycle_status='revoked' where id=$1", [DECISION]);
      try {
        const bound = { intent_id: prepared.intent_id, request_sha256: "e".repeat(64), base_version: 1 };
        await assert.rejects(journal({ ...bound, action: "start" }), /profile_unavailable/);
        const cancelled = await journal({ ...bound, action: "cancel" });
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.execution_permitted, false);
      } finally {
        await admin.query("update public.clued_memories set lifecycle_status='active' where id=$1", [DECISION]);
        await admin.query("update clued_private.resource_center_profiles_v1 set state='active' where id=$1", [profileId]);
      }
    });

    await t.test("file registration and CAS update bind current provider version", async () => {
      const filePath = TRACK + "/logo.svg";
      const file = await adminCall({
        action: "artifact_register", profile_id: profileId, path: filePath,
        provider_file_id: "drive-logo-id", provider_file_version: "5",
        target_kind: "file", governance_class: "governance", delete_authority: false,
      });
      assert.equal(file.status, "committed");
      const fileId = file.target_refs.find((ref) => ref.role === "primary").id;
      const replacement = {
        ...mutation, operation: "replace", destination_path: filePath,
        target_kind: "file", directory_semantics: null,
      };
      const identity = {
        ...providerIdentity, destination_file_id: "drive-logo-id",
        destination_file_version: "5",
      };
      const initial = await resolve({ mutation: replacement, provider_identity: identity });
      assert.equal(initial.status, "resolved");
      assert.equal(initial.authority.artifact_id, fileId);
      assert.equal(initial.authority.governance_class, "governance");
      assert.equal(initial.authority.delete_authority, false);
      const updated = await adminCall({
        action: "artifact_update", profile_id: profileId, artifact_id: fileId,
        base_version: 1, path: filePath, provider_file_id: "drive-logo-id",
        provider_file_version: "6", governance_class: "governance",
        delete_authority: false,
      });
      assert.equal(updated.status, "committed");
      assert.deepEqual(await resolve({ mutation: replacement, provider_identity: identity }),
        { status: "denied", reason: "destination_mismatch" });
      const next = await resolve({ mutation: replacement, provider_identity: {
        ...identity, destination_file_version: "6",
      } });
      assert.equal(next.status, "resolved");
      assert.notEqual(next.authority.authority_version, initial.authority.authority_version);
      const stale = await adminCall({
        action: "artifact_update", profile_id: profileId, artifact_id: fileId,
        base_version: 1, path: filePath, provider_file_id: "drive-logo-id",
        provider_file_version: "7", governance_class: "ordinary",
        delete_authority: false,
      });
      assert.equal(stale.status, "rejected");
    });

    await t.test("registration is receipt-backed, idempotent and rejects ambiguous paths", async () => {
      const input = {
        action: "artifact_register", profile_id: profileId,
        path: ROOT + "/30_R_基础研究", provider_file_id: "drive-research-id",
        provider_file_version: "1", target_kind: "directory",
        governance_class: "ordinary", delete_authority: false,
        idempotency_key: "resource-center-test-research-once",
      };
      const first = await adminCall(input);
      const replay = await adminCall(input);
      assert.equal(first.status, "committed");
      assert.equal(replay.replayed, true);
      assert.equal(replay.receipt_id, first.receipt_id);
      const duplicatePath = await adminCall({
        ...input, idempotency_key: "resource-center-test-research-conflict",
        provider_file_id: "different-drive-id",
      });
      assert.equal(duplicatePath.status, "rejected");
      assert.equal((await admin.query(
        "select count(*)::int n from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2 and state='active'",
        [profileId, input.path],
      )).rows[0].n, 1);
      const missingParent = await adminCall({
        ...input, idempotency_key: "resource-center-test-parent-missing",
        path: ROOT + "/unregistered/child", provider_file_id: "orphan-id",
      });
      assert.equal(missingParent.status, "rejected");
    });
    await t.test("Canonical Decision version changes the returned Currentness identity", async () => {
      await admin.query("update public.clued_memories set version=version+1 where id=$1", [DECISION]);
      const changed = await resolve();
      assert.equal(changed.status, "resolved");
      assert.notEqual(changed.authority.currentness_identity, allowed.authority.currentness_identity);
      assert.match(changed.authority.authority_version, /:1:2$/);
      await admin.query("update public.clued_memories set lifecycle_status='superseded' where id=$1", [DECISION]);
      assert.equal((await resolve()).status, "denied");
      await admin.query("update public.clued_memories set lifecycle_status='active' where id=$1", [DECISION]);
      assert.equal((await resolve()).status, "resolved");
    });

    await t.test("unregistered paths, wrong IDs/versions and profile fail closed", async () => {
      assert.deepEqual(await resolve({ profile_version: "other" }), { status: "denied", reason: "profile_mismatch" });
      assert.deepEqual(await resolve({ provider_identity: {
        ...providerIdentity, destination_parent_id: "same-name-other-id",
      } }), { status: "denied", reason: "parent_unregistered" });
      assert.deepEqual(await resolve({ provider_identity: {
        ...providerIdentity, destination_parent_version: "3",
      } }), { status: "denied", reason: "parent_version_mismatch" });
      assert.deepEqual(await resolve({ provider_identity: {
        ...providerIdentity, root_folder_version: "999",
      } }), { status: "denied", reason: "root_version_mismatch" });
      assert.deepEqual(await resolve({ provider_identity: {
        ...providerIdentity, root_folder_id: "other-root-id",
      } }), { status: "denied", reason: "root_identity_mismatch" });
      assert.deepEqual(await resolve({ mutation: {
        ...mutation, destination_path: ROOT + "/not-registered/topic",
      } }), { status: "denied", reason: "parent_unregistered" });
      assert.deepEqual(await resolve({ mutation: {
        ...mutation, destination_path: "/elsewhere/topic",
      } }), { status: "denied", reason: "destination_outside_root" });
    });
    await t.test("a generic Clued hash cannot substitute for the dedicated Binding", async () => {
      const generic = crypto.randomBytes(32).toString("hex");
      const denied = (await anon.query(
        "select public.clued_resource_center_authority_v1($1,$2::jsonb) value",
        [generic, JSON.stringify({ profile_id: profileId })],
      )).rows[0].value;
      assert.deepEqual(denied, { status: "denied", reason: "request_invalid" });
    });
    await t.test("administrative writes and tables are inaccessible to anon", async () => {
      assert.equal((await admin.query("select has_function_privilege('anon'," +
        "'public.clued_resource_center_admin_v1(uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed, false);
      assert.equal((await admin.query("select has_table_privilege('anon'," +
        "'clued_private.resource_center_bindings_v1','SELECT') allowed")).rows[0].allowed, false);
    });
    const trackId = track.target_refs.find((ref) => ref.role === "primary").id;
    await t.test("directory metadata can refresh without permitting a subtree move", async () => {
      const moved = await adminCall({
        action: "artifact_update", profile_id: profileId, artifact_id: trackId,
        base_version: 1, path: ROOT + "/another-track",
        provider_file_id: TRACK_ID, provider_file_version: "3",
        governance_class: "ordinary", delete_authority: false,
      });
      assert.equal(moved.status, "rejected");
      const refreshed = await adminCall({
        action: "artifact_update", profile_id: profileId, artifact_id: trackId,
        base_version: 1, path: TRACK, provider_file_id: TRACK_ID,
        provider_file_version: "3", governance_class: "ordinary",
        delete_authority: false,
      });
      assert.equal(refreshed.status, "committed");
      assert.equal((await resolve()).status, "denied");
      assert.equal((await resolve({ provider_identity: {
        ...providerIdentity, destination_parent_version: "3",
      } })).status, "resolved");
    });
    await t.test("temporary Host/Worker/DB chain denies read-only then atomically finalizes qualified create", async (child) => {
      const tempParent = await fs.mkdtemp(path.join(os.tmpdir(), "clued-rc-acceptance-"));
      child.after(() => fs.rm(tempParent, { recursive: true, force: true }));
      const nativeRoot = path.join(tempParent, "Clued_资料中心");
      const nativeTrack = path.join(nativeRoot, "20_P_产品与体验");
      const nativeTopic = path.join(nativeTrack, "视觉探索");
      const dbRoot = nativeRoot.replaceAll("\\", "/");
      const dbTrack = nativeTrack.replaceAll("\\", "/");
      await fs.mkdir(nativeTrack, { recursive: true });
      const tempProfile = await adminCall({
        action: "profile_register", project_id: PROJECT, profile_version: "temp/1",
        managed_root: dbRoot, root_folder_id: "temp-root-id",
        root_parent_id: "temp-parent-id", root_folder_version: "1",
      });
      assert.equal(tempProfile.status, "committed");
      const tempProfileId = tempProfile.target_refs.find((ref) => ref.role === "primary").id;
      assert.equal((await adminCall({
        action: "artifact_register", profile_id: tempProfileId, path: dbTrack,
        provider_file_id: "temp-track-id", provider_file_version: "2",
        target_kind: "directory", governance_class: "ordinary", delete_authority: false,
      })).status, "committed");
      const rawToken = "clued_rcb_" + "t".repeat(40);
      const tempBinding = await adminCall({
        action: "binding_issue", profile_id: tempProfileId,
        token_hash: crypto.createHash("sha256").update(rawToken).digest("hex"),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      assert.equal(tempBinding.status, "committed");
      const worker = await loadContinuityWorker();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        assert.match(String(url), /\/rpc\/clued_resource_center_(authority|write)_v1$/);
        const body = JSON.parse(options.body);
        const rpcName = String(url).endsWith("/clued_resource_center_write_v1")
          ? "clued_resource_center_write_v1" : "clued_resource_center_authority_v1";
        const result = (await anon.query(
          `select public.${rpcName}($1,$2::jsonb) value`,
          [body.p_token_hash, JSON.stringify(body.p_request)],
        )).rows[0].value;
        return Response.json(result);
      };
      try {
        const hostOptions = {
          trusted_profile: {
            registration_status: "registered", profile_id: tempProfileId,
            profile_version: "temp/1", managed_root: nativeRoot,
            allowed_root_children: ["20_P_产品与体验"],
            boundary_scan_roots: [tempParent],
          },
          root_folder_id: "temp-root-id", root_parent_id: "temp-parent-id",
          get_drive_credential: async () => ({ access_token: "metadata-only-test-token",
            scope: "https://www.googleapis.com/auth/drive.metadata.readonly" }),
          drive_fetch: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/temp-root-id")) {
              return Response.json({
                id: "temp-root-id", name: "Clued_资料中心",
                parents: ["temp-parent-id"], version: "1", trashed: false,
                mimeType: "application/vnd.google-apps.folder",
              });
            }
            if (parsed.pathname.endsWith("/temp-track-id")) {
              return Response.json({
                id: "temp-track-id", name: "20_P_产品与体验",
                parents: ["temp-root-id"], version: "2", trashed: false,
                mimeType: "application/vnd.google-apps.folder",
              });
            }
            const query = parsed.searchParams.get("q") ?? "";
            if (query.includes("'temp-root-id' in parents")) return Response.json({ files: [{
                id: "temp-track-id", name: "20_P_产品与体验",
                parents: ["temp-root-id"], version: "2", trashed: false,
                mimeType: "application/vnd.google-apps.folder",
              }] });
            let topicExists = false;
            try { topicExists = (await fs.stat(nativeTopic)).isDirectory(); } catch { /* Not yet created. */ }
            const topicMetadata = { id: "temp-new-topic-id", name: "视觉探索", parents: ["temp-track-id"],
              version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" };
            if (parsed.pathname.endsWith("/temp-new-topic-id") && topicExists) return Response.json(topicMetadata);
            if (query.includes("'temp-track-id' in parents") && query.includes("视觉探索") && topicExists) {
              return Response.json({ files: [topicMetadata] });
            }
            return Response.json({ files: [] });
          },
          authority_endpoint: "https://clued.test/v1/resource-center/authority",
          authority_binding_token: rawToken,
          authority_fetch: (url, options) => worker.fetch(
            new Request(url, options),
            { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
            { waitUntil() {}, passThroughOnException() {} },
          ),
        };
        const host = createResourceCenterGoogleDriveOnlineToolHost(hostOptions);
        const createTopic = (destination) => host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
          operation: "create", destination_path: destination,
          target_kind: "directory", directory_semantics: "topic",
        });
        assert.equal((await createTopic(nativeTopic)).error_code,
          "POST_WRITE_CANONICAL_RECEIPT_UNAVAILABLE");
        await assert.rejects(fs.stat(nativeTopic), { code: "ENOENT" });
        const writerToken = "clued_rcw_" + "w".repeat(40);
        const readBindingId = tempBinding.target_refs.find((ref) => ref.role === "primary").id;
        const writerIssued = (await admin.query(
          "select public.clued_resource_center_writer_admin_v1($1,$2::jsonb) value", [USER, JSON.stringify({
            action: "issue", authority_binding_id: readBindingId, source_decision_id: DECISION,
            token_hash: crypto.createHash("sha256").update(writerToken).digest("hex"),
            expires_at: new Date(Date.now() + 1800000).toISOString(), idempotency_key: crypto.randomUUID(),
          })],
        )).rows[0].value;
        assert.equal(writerIssued.status, "committed");
        const recoveryPath = path.join(tempParent, "recovery.jsonl");
        await fs.writeFile(recoveryPath, "", { flag: "wx" });
        assert.throws(() => createResourceCenterGoogleDriveWriterToolHost({
          ...hostOptions,
          ...createResourceCenterRecoveryStore(recoveryPath),
          writer_endpoint: "https://clued.test/v1/resource-center/write", writer_binding_token: writerToken,
        }), /DRIVE_MOUNTED_WRITER_IDENTITY_UNQUALIFIED/);
        await assert.rejects(fs.stat(nativeTopic), { code: "ENOENT" });
        const attemptPath = path.join(tempParent, "provider-attempts.jsonl");
        await fs.writeFile(attemptPath, "", { flag: "wx" });
        const attempts = createResourceCenterProviderAttemptStore(attemptPath);
        const nativeFilePath = path.join(nativeTrack, "native.txt");
        const nativeContent = "Synthetic native-ID create\n";
        let nativeMetadata = null;
        let nativePosts = 0;
        const nativeWriter = createResourceCenterGoogleDriveNativeWriterToolHost({ ...hostOptions,
          get_drive_credential: async () => ({ access_token: "native-create-test-token",
            scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly" }),
          ...createResourceCenterRecoveryStore(recoveryPath), ...attempts,
          writer_endpoint: "https://clued.test/v1/resource-center/write", writer_binding_token: writerToken,
          drive_fetch: async (url, options) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/generateIds")) return Response.json({ ids: ["native-id"] });
            if (options?.method === "POST") {
              nativePosts++;
              // The real store must already contain the exact generated ID.
              const saved = JSON.parse((await fs.readFile(attemptPath, "utf8")).trim()).provider_attempt;
              assert.equal(saved.provider_file_id, "native-id");
              assert.equal(saved.destination_path, nativeFilePath.replaceAll("\\", "/"));
              assert.match(options.body, /Synthetic native-ID create/);
              nativeMetadata = { id: "native-id", name: "native.txt", parents: ["temp-track-id"],
                mimeType: "text/plain", version: "1", trashed: false,
                size: String(Buffer.byteLength(nativeContent)), sha256Checksum: crypto.createHash("sha256").update(nativeContent).digest("hex") };
              return Response.json(nativeMetadata);
            }
            if (parsed.pathname.endsWith("/native-id")) return Response.json(nativeMetadata);
            if ((parsed.searchParams.get("q") ?? "").includes("name = 'native.txt'")) {
              return Response.json({ files: nativeMetadata ? [nativeMetadata] : [] });
            }
            return hostOptions.drive_fetch(url, options);
          },
        });
        const nativeWritten = await nativeWriter.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
          operation: "create", destination_path: nativeFilePath, target_kind: "file", content: nativeContent,
        });
        assert.equal(nativeWritten.status, "committed", JSON.stringify(nativeWritten));
        assert.match(nativeWritten.canonical_receipt_id, /^[0-9a-f-]{36}$/);
        assert.equal(nativePosts, 1);
        assert.equal((await admin.query("select state from clued_private.resource_center_mutations_v1 where profile_id=$1", [tempProfileId])).rows[0].state, "committed");
        await assert.rejects(fs.stat(nativeFilePath), { code: "ENOENT" });
        const nativeAttempt = await attempts.read_provider_attempt(nativeWritten.effect_result.intent_id, nativeWritten.binding.request_sha256);
        assert.equal(nativeAttempt.provider_file_id, "native-id");
        assert.equal((await admin.query("select count(*)::int n from clued_private.resource_center_artifacts_v1 where profile_id=$1 and provider_file_id='native-id'", [tempProfileId])).rows[0].n, 1);
        assert.equal((await nativeWriter.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
          operation: "create", destination_path: nativeFilePath, target_kind: "file", content: "must not overwrite",
        })).status, "deny");
        assert.equal(nativePosts, 1);
        const writerHash = crypto.createHash("sha256").update(writerToken).digest("hex");
        const callWriter = async (token, input) => (await anon.query(
          "select public.clued_resource_center_write_v1($1,$2::jsonb) value", [token, JSON.stringify(input)],
        )).rows[0].value;
        assert.equal((await callWriter(crypto.createHash("sha256").update(rawToken).digest("hex"), { action: "inspect" })).status, "denied");
        assert.equal((await callWriter(writerHash, { action: "inspect", profile_id: profileId })).status, "denied");
        assert.equal((await callWriter(writerHash, { action: "inspect", authority_token_hash: tokenHash })).status, "denied");
        const ownIntent = (await admin.query(
          "select id,request_sha256 from clued_private.resource_center_mutations_v1 where profile_id=$1", [tempProfileId],
        )).rows[0];
        const inspect = { action: "inspect", intent_id: ownIntent.id, request_sha256: ownIntent.request_sha256 };
        assert.equal((await callWriter(writerHash, inspect)).status, "committed");
        const secondWriterHash = crypto.createHash("sha256").update("second-writer-test-only").digest("hex");
        const writerAdmin = async (input) => (await admin.query(
          "select public.clued_resource_center_writer_admin_v1($1,$2::jsonb) value", [USER, JSON.stringify({
            authority_binding_id: readBindingId, source_decision_id: DECISION,
            idempotency_key: crypto.randomUUID(), ...input,
          })],
        )).rows[0].value;
        const secondWriter = await writerAdmin({ action: "issue", token_hash: secondWriterHash,
          expires_at: new Date(Date.now() + 1800000).toISOString() });
        assert.equal(secondWriter.status, "committed");
        assert.equal((await callWriter(secondWriterHash, inspect)).status, "denied");
        assert.equal((await writerAdmin({ action: "revoke",
          writer_binding_id: secondWriter.target_refs.find((ref) => ref.role === "primary").id })).status, "committed");
        assert.equal((await callWriter(secondWriterHash, inspect)).status, "denied");
        assert.equal((await callWriter(writerHash, inspect)).status, "committed");
        // An unregistered parent remains unavailable after finalization.
        const unregisteredChild = path.join(nativeTrack, "unregistered-parent", "child.txt");
        assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
          operation: "create", destination_path: unregisteredChild,
          target_kind: "file",
        })).error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
        await assert.rejects(fs.stat(unregisteredChild), { code: "ENOENT" });
        const bindingId = tempBinding.target_refs.find((ref) => ref.role === "primary").id;
        assert.equal((await adminCall({
          action: "binding_revoke", profile_id: tempProfileId, binding_id: bindingId,
        })).status, "committed");
        assert.equal((await callWriter(writerHash, { action: "inspect" })).status, "denied");
        const deniedTopic = path.join(nativeTrack, "revoked");
        assert.equal((await createTopic(deniedTopic)).error_code,
          "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
        await assert.rejects(fs.stat(deniedTopic), { code: "ENOENT" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
    await testRenewalDatabase(t, admin, server, USER, DECISION);
    await testStorageAccount(t, admin, server, USER, DECISION);
    await testStorageOAuth(t, admin, server, USER, DECISION);
    await testAccountRefresh(t, admin, server, USER, DECISION);
    await testDirectoryProbe(t, admin, server, USER, DECISION);
    await testAccountPolicy(t, admin, server, USER, DECISION);
    await testStorageAdmin(t, admin, server, USER, PROJECT);
    await testStorageClientCapability(t, admin, server, USER, DECISION);
    await testStorageSourceReader(t, admin);
    await testStoragePolicyTransition(t, admin, server, USER, DECISION);
    await testAccountCloud(t, admin, server, USER, DECISION);
    await testStorageRead(t, admin, server, USER, DECISION);
    await testStorageClientRedirectIdentity(t, admin, server, USER, DECISION);
    await testStorageReadContent(t, admin, server, USER, DECISION);
    await testStorageModifyLevel(t, admin, server, USER, DECISION);
    await testStorageModifyExecution(t, admin, server, USER, DECISION);
    await testStorageReplace(t, admin, server, USER, DECISION);
    await testStorageNormalUse(t, admin, server, USER, DECISION);
    await testStorageBinaryUpload(t, admin, server, USER, DECISION);
    await testStorageBudget(t, admin, server, USER);
    await t.test("a directory with a recorded sharing digest is matched by sharing, not Drive version", async () => {
      const shared = "d".repeat(64), changed = "e".repeat(64);
      const rowVersion = async (id) => Number((await admin.query(
        "select version from clued_private.resource_center_artifacts_v1 where id=$1", [id])).rows[0].version);
      const update = async (id, path, fileId, fileVersion, extra) => {
        const row = (await admin.query(`select governance_class,delete_authority
          from clued_private.resource_center_artifacts_v1 where id=$1`, [id])).rows[0];
        return adminCall({
          action: "artifact_update", profile_id: profileId, artifact_id: id, base_version: await rowVersion(id),
          path, provider_file_id: fileId, provider_file_version: fileVersion,
          governance_class: row.governance_class, delete_authority: row.delete_authority, ...extra,
        });
      };
      const parent = (overrides) => resolve({ provider_identity: { ...providerIdentity, ...overrides } });
      // The authority lookup and the verified settlement share this rule.
      const match = async (...args) => (await admin.query(
        "select clued_private.resource_center_directory_match_v1($1,$2,$3,$4) value", args)).rows[0].value;
      assert.equal(await match("3", null, "3", null), "match");
      assert.equal(await match("3", null, "4", shared), "version_mismatch");
      assert.equal(await match("3", shared, "9", shared), "match");
      assert.equal(await match("3", shared, "3", changed), "sharing_changed");
      assert.equal(await match("3", shared, "3", null), "sharing_unavailable");
      assert.equal((await update(trackId, TRACK, TRACK_ID, "3", { provider_sharing_digest: "not-a-digest" })).status,
        "rejected");
      assert.equal((await update(trackId, TRACK, TRACK_ID, "3", { provider_sharing_digest: shared })).status, "committed");
      assert.equal((await parent({ destination_parent_version: "9", destination_parent_sharing_digest: shared })).status,
        "resolved");
      assert.deepEqual(await parent({ destination_parent_version: "3", destination_parent_sharing_digest: changed }),
        { status: "denied", reason: "parent_sharing_changed" });
      assert.deepEqual(await parent({ destination_parent_version: "3" }),
        { status: "denied", reason: "parent_sharing_unavailable" });
      // A version-only update keeps the recorded digest.
      assert.equal((await update(trackId, TRACK, TRACK_ID, "4")).status, "committed");
      assert.equal((await parent({ destination_parent_version: "9", destination_parent_sharing_digest: shared })).status,
        "resolved");
      // Clearing the digest restores exact version matching.
      assert.equal((await update(trackId, TRACK, TRACK_ID, "3", { provider_sharing_digest: null })).status, "committed");
      assert.deepEqual(await parent({ destination_parent_version: "9", destination_parent_sharing_digest: shared }),
        { status: "denied", reason: "parent_version_mismatch" });
      assert.equal((await parent({ destination_parent_version: "3" })).status, "resolved");

      const rootId = (await admin.query(`select id from clued_private.resource_center_artifacts_v1
        where profile_id=$1 and path=$2 and state='active'`, [profileId, ROOT])).rows[0].id;
      const rootVersion = (await admin.query(
        "select provider_file_version v from clued_private.resource_center_artifacts_v1 where id=$1", [rootId])).rows[0].v;
      assert.equal((await update(rootId, ROOT, ROOT_ID, rootVersion, { provider_sharing_digest: shared })).status, "committed");
      assert.equal((await parent({ destination_parent_version: "3", root_folder_version: "999",
        root_sharing_digest: shared })).status, "resolved");
      assert.deepEqual(await parent({ destination_parent_version: "3", root_folder_version: rootVersion,
        root_sharing_digest: changed }), { status: "denied", reason: "root_sharing_changed" });
      assert.equal((await update(rootId, ROOT, ROOT_ID, rootVersion, { provider_sharing_digest: null })).status, "committed");
      assert.deepEqual(await parent({ destination_parent_version: "3", root_folder_version: "999" }),
        { status: "denied", reason: "root_version_mismatch" });
      const file = (await admin.query(`select id,path,provider_file_id,provider_file_version v
        from clued_private.resource_center_artifacts_v1 where profile_id=$1 and target_kind='file' and state='active'
        limit 1`, [profileId])).rows[0];
      if (file) {
        assert.equal((await update(file.id, file.path, file.provider_file_id, file.v,
          { provider_sharing_digest: shared })).status, "rejected");
      }
    });
    const removed = await adminCall({
      action: "artifact_revoke", profile_id: profileId, artifact_id: trackId,
      base_version: Number((await admin.query(
        "select version from clued_private.resource_center_artifacts_v1 where id=$1", [trackId])).rows[0].version),
    });
    assert.equal(removed.status, "committed");
    assert.equal((await resolve()).status, "denied");
    assert.equal((await resolve({
      mutation: {
        ...mutation, operation: "replace", destination_path: TRACK + "/logo.svg",
        target_kind: "file", directory_semantics: null,
      },
      provider_identity: {
        ...providerIdentity, destination_parent_version: "3",
        destination_file_id: "drive-logo-id", destination_file_version: "6",
      },
    })).status, "denied");
    const revoked = await adminCall({
      action: "binding_revoke", profile_id: profileId, binding_id: bindingId,
    });
    assert.equal(revoked.status, "committed");
    assert.equal((await resolve()).status, "denied");
  } finally {
    if (anon) await anon.end();
    if (admin) await admin.end();
    await server.stop();
  }
});
