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
import { testStorageDestructive } from "./resource-center-storage-destructive-db.fixture.mjs";
import { testStorageDirectoryMove } from "./resource-center-storage-directory-move-db.fixture.mjs";
import { testStorageAdopt } from "./resource-center-storage-adopt-db.fixture.mjs";
import { testStorageWorkClaim } from "./resource-center-storage-work-claim-db.fixture.mjs";
import { testStorageNormalUse } from "./resource-center-storage-normal-use-db.fixture.mjs";
import { testStorageBinaryUpload } from "./resource-center-storage-binary-db.fixture.mjs";
import { testStorageOnboard } from "./resource-center-storage-onboard-db.fixture.mjs";
import { testStorageBudget } from "./resource-center-storage-budget-db.fixture.mjs";
import { testStorageConnections } from "./resource-center-storage-connections-db.fixture.mjs";
import { seedRefreshUpgrade, verifyRefreshUpgrade } from "./resource-center-refresh-upgrade-db.fixture.mjs";
import { allowRawTestBindings } from "./raw-binding-grants-fixture.mjs";
import { allowTestIssuerCredentials } from './issuer-credentials-fixture.mjs';
import { AUTHORIZATION_SUCCESSOR_MIGRATIONS, snapshotAuthorizationCallerBoundary, assertAuthorizationSuccessorBoundary, findGatewayCloseoutMigration, setWorkerGatewayCaller, workerGatewayRpc,
  snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

const USER = "10000000-0000-4000-8000-000000000071";
const PROJECT = "20000000-0000-4000-8000-000000000071";
const DECISION = "30000000-0000-4000-8000-000000000071";
const ROOT = "G:/My Drive/Clued_资料中心";
const ROOT_ID = "drive-root-id";
const TRACK = ROOT + "/20_P_产品与体验";
const TRACK_ID = "drive-track-id";
const tokenHash = crypto.createHash("sha256").update("clued_rcb_test_token").digest("hex");

// The imported resource fixtures retain historical upgrade and retired-alias
// assertions. Close that history with the actual current G6 migration, then
// exercise current callers; historical PASS is not current-chain qualification.
async function qualifyCurrentCallers(t, admin, server, closeoutSql) {
  await t.test("historical resource setup closes with actual G6 apply/replay and exact GW80/CI8", async () => {
    await replayGatewayCloseout(admin, closeoutSql);
    await assertGatewayCloseoutBoundary(admin);
    const catalog = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, closeoutSql);
    assert.deepEqual(await snapshotCallerCatalog(admin), catalog);
    await assertGatewayCloseoutBoundary(admin);
  });
  await t.test("current authorization successors preserve actual OIDs, caller ACLs and early entrances", async () => {
    const authorizationBefore = await snapshotAuthorizationCallerBoundary(admin);
    for (const name of AUTHORIZATION_SUCCESSOR_MIGRATIONS) {
      await admin.query(await fs.readFile(path.join(process.cwd(), "supabase", "migrations", name), "utf8"));
    }
    await assertAuthorizationSuccessorBoundary(admin, authorizationBefore);
  });
  const gateway = server.getPgClient(), native = server.getPgClient(), ci = server.getPgClient();
  await gateway.connect(); await native.connect(); await ci.connect();
  try {
    await setWorkerGatewayCaller(gateway);
    const nonce = crypto.randomUUID(), proof = crypto.createHash("sha256").update(nonce).digest("hex");
    const managedRoot = "/g6-" + nonce + "/Clued_资料中心", track = managedRoot + "/20_P_产品与体验";
    const rootId = "g6-root-" + nonce, parentId = "g6-parent-" + nonce, trackId = "g6-track-" + nonce;
    const register = async input => (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value",
      [USER, JSON.stringify({ source_decision_id: DECISION, idempotency_key: crypto.randomUUID(), ...input })])).rows[0].value;
    const profile = await register({ action: "profile_register", project_id: PROJECT, profile_version: "g6/1",
      managed_root: managedRoot, root_folder_id: rootId, root_parent_id: parentId, root_folder_version: "1" });
    assert.equal(profile.status, "committed");
    const profileId = profile.target_refs.find(ref => ref.role === "primary").id;
    assert.equal((await register({ action: "artifact_register", profile_id: profileId, path: track,
      provider_file_id: trackId, provider_file_version: "1", target_kind: "directory",
      governance_class: "ordinary", delete_authority: false })).status, "committed");
    assert.equal((await register({ action: "binding_issue", profile_id: profileId, token_hash: proof,
      expires_at: new Date(Date.now() + 3600000).toISOString() })).status, "committed");
    const request = { contract: "clued.resource-center-authority/1", nonce: crypto.randomUUID(),
      policy_version: "clued.resource-center-mutation-policy/1", profile_id: profileId, profile_version: "g6/1",
      provider_identity: { root_folder_id: rootId, root_parent_id: parentId, root_folder_version: "1",
        source_file_id: null, source_file_version: null, destination_parent_id: trackId, destination_parent_version: "1",
        destination_file_id: null, destination_file_version: null, provider_version: "a".repeat(64) },
      mutation: { operation: "create", source_path: null, destination_path: track + "/current.txt", artifact_role: "clued_resource",
        target_kind: "file", directory_semantics: null, artifact_id: null, governance_class: null,
        delete_authority: false, artifact_authority_version: null, duplicate_bytes: false,
        currentness_identity: null, workspace_version: null } };
    await t.test("current gateway resolves real registered authority while invalid proof and old callers remain denied", async () => {
      const result = await workerGatewayRpc(gateway, "clued_resource_center_authority_v1", proof, request);
      assert.equal(result.status, "resolved");
      assert.match(result.authority.currentness_identity, /^decision:/);
      const before = (await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n;
      assert.equal((await workerGatewayRpc(gateway, "clued_resource_center_authority_v1", "f".repeat(64), request)).status, "denied");
      for (const role of ["anon", "authenticated"]) {
        await ci.query(`set role ${role}`);
        await assert.rejects(ci.query("select public.clued_resource_center_authority_v1($1,$2::jsonb)", [proof, JSON.stringify(request)]), /permission denied/);
      }
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n, before);
    });
    await t.test("current Native account list and scoped anon CI holders are legal without gateway impersonation", async () => {
      const session = crypto.randomUUID(), ciProof = crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
      await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, USER]);
      await native.query("set role authenticated");
      await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
        [USER, JSON.stringify({ sub: USER, role: "authenticated", session_id: session })]);
      const listed = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({ action: "list" })])).rows[0].value;
      assert.ok(Array.isArray(listed.connections));
      const binding = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','Current G6 CI fixture',$2,array['context:read','context:write'],array['*']) returning id`, [USER, ciProof])).rows[0].id;
      const receipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,metadata)
        values($1,'global','binding_role_set','binding',$2,'{}') returning id`, [USER, binding])).rows[0].id;
      await admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'ci-admission',now(),$3)",
        [USER, binding, receipt]);
      await ci.query("set role anon");
      const before = (await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n;
      const holders = (await ci.query("select public.clued_work_merge_slot_holders_v1($1,$2::jsonb) value",
        [ciProof, JSON.stringify({ scope: "global", repository: "synthetic/resource-center-g6" })])).rows[0].value;
      assert.equal(holders.status, "ok"); assert.deepEqual(holders.holders, []);
      assert.equal(holders.reason, undefined, "a real CI-admission Binding must pass authority, not return a denied empty result");
      assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts")).rows[0].n, before);
    });
    await t.test("retired jobs_v2 and project aliases stay inaccessible to every API role after closeout", async () => {
      for (const signature of ["public.clued_storage_jobs_v2(text,jsonb)", "public.clued_project_mutate(text,jsonb)"]) {
        for (const role of ["anon", "authenticated", "service_role", "clued_worker_gateway"])
          assert.equal((await admin.query("select has_function_privilege($1,$2,'EXECUTE') yes", [role, signature])).rows[0].yes, false);
      }
      await assert.rejects(gateway.query("select public.clued_storage_jobs_v2($1,'{}'::jsonb)", [proof]), /permission denied/);
      await assertGatewayCloseoutBoundary(admin);
    });
  } finally { await gateway.end(); await native.end(); await ci.end(); }
}

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
const focusedOnboard = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-onboard";
const focusedDirectoryMove = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-directory-move";
const focusedAdopt = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-adopt";
const focusedWorkClaim = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-work-claim";
const focusedConnections = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-connections";
const focusedAncestors = process.env.CLUED_RESOURCE_CENTER_DB_FOCUS === "storage-ancestors";
for (const bindingSchema of focusedCloud || focusedAdmin || focusedRead || focusedOnboard || focusedDirectoryMove || focusedAdopt || focusedWorkClaim || focusedConnections || focusedAncestors ? ["legacy-expiry"] : ["legacy-expiry", "production-no-legacy-expiry"]) test(`Canonical Resource Center registration and exact read-only authority (${bindingSchema})`, { timeout: 180000 }, async (t) => {
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
    const closeout = await findGatewayCloseoutMigration(process.cwd());
    const closeoutSql = await fs.readFile(path.join(migrationDir, closeout), "utf8");
    let refreshUpgrade;
    for (const name of (await fs.readdir(migrationDir)).filter((name) => name.endsWith(".sql") && name !== closeout && !AUTHORIZATION_SUCCESSOR_MIGRATIONS.includes(name)).sort()) {
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
    await allowRawTestBindings(admin);
    await allowTestIssuerCredentials(admin);
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
      await testAccountCloud(t, admin, server, USER, DECISION,{demandRenewal:true});
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedRead) {
      await testStorageRead(t, admin, server, USER, DECISION,{demandRenewal:true});
      await testStorageClientRedirectIdentity(t, admin, server, USER, DECISION);
      await testStorageReadContent(t, admin, server, USER, DECISION);
      await testStorageModifyLevel(t, admin, server, USER, DECISION);
      await testStorageModifyExecution(t, admin, server, USER, DECISION);
      await testStorageReplace(t, admin, server, USER, DECISION);
      await testStorageDestructive(t, admin, server, USER, DECISION);
      await testStorageDirectoryMove(t, admin, server, USER, DECISION);
      await testStorageAdopt(t, admin, server, USER, DECISION);
      await testStorageWorkClaim(t, admin, server, USER, DECISION);
      await testStorageNormalUse(t, admin, server, USER, DECISION);
      await testStorageBinaryUpload(t, admin, server, USER, DECISION);
      await testStorageBudget(t, admin, server, USER);
      await testStorageOnboard(t, admin, server, USER, DECISION);
      await testStorageConnections(t, admin, server);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedDirectoryMove) {
      await testStorageDirectoryMove(t, admin, server, USER, DECISION);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedWorkClaim) {
      await testStorageWorkClaim(t, admin, server, USER, DECISION);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedConnections) {
      await testStorageConnections(t, admin, server);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedAdopt) {
      await testStorageAdopt(t, admin, server, USER, DECISION);
      await testStorageNormalUse(t, admin, server, USER, DECISION);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedOnboard) {
      await testStorageOnboard(t, admin, server, USER, DECISION);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

    if (focusedAdmin) {
      await testStorageAdmin(t, admin, server, USER, PROJECT);
      await testStorageClientCapability(t, admin, server, USER, DECISION);
      await testStorageSourceReader(t, admin);
      await testStoragePolicyTransition(t, admin, server, USER, DECISION);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
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
    await setWorkerGatewayCaller(anon);
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

    // Storage step 3 (Task 469700eb): a request that carries
    // provider_identity.ancestors is matched by identity and digest.
    const ancestorIdentity = () => t.test("a new-shape request matches its ancestors by identity and digest, not by Drive version", async () => {
      const ACCESS = "a1".repeat(32), OTHER = "b2".repeat(32), SHARED = "c3".repeat(32);
      const MID = TRACK + "/中间", MID_ID = "drive-mid-id";
      const query = async (sql, args) => (await admin.query(sql, args)).rows[0];
      const rowOf = path => query(`select * from clued_private.resource_center_artifacts_v1
        where profile_id=$1 and path=$2 and state='active'`, [profileId, path]);
      const update = async (path, extra) => {
        const row = await rowOf(path);
        const result = await adminCall({ action: "artifact_update", profile_id: profileId, artifact_id: row.id, base_version: Number(row.version),
          path, provider_file_id: row.provider_file_id, provider_file_version: row.provider_file_version,
          governance_class: row.governance_class, delete_authority: row.delete_authority, ...extra });
        assert.equal(result.status, "committed", JSON.stringify(result));
      };
      const match2 = async (...args) => (await query(
        "select clued_private.resource_center_directory_match_v2($1,$2,$3,$4,$5) value", args)).value;
      assert.equal(await match2("3", null, null, "version", "3"), "match");
      assert.equal(await match2("3", null, null, "version", "4"), "version_mismatch");
      assert.equal(await match2("3", null, null, "version", null), "version_mismatch");
      assert.equal(await match2(null, null, null, "version", null), "version_mismatch");
      assert.equal(await match2("3", SHARED, null, "sharing", SHARED), "match");
      assert.equal(await match2("3", SHARED, null, "sharing", OTHER), "sharing_changed");
      assert.equal(await match2("3", SHARED, null, "sharing", null), "sharing_unavailable");
      assert.equal(await match2("3", SHARED, null, "version", "3"), "match_changed");
      assert.equal(await match2("3", SHARED, ACCESS, "access", ACCESS), "match");
      assert.equal(await match2("3", SHARED, ACCESS, "access", OTHER), "access_changed");
      assert.equal(await match2("3", SHARED, ACCESS, "access", null), "access_unavailable");
      assert.equal(await match2("3", SHARED, ACCESS, "sharing", SHARED), "match_changed");
      assert.equal(await match2("3", null, ACCESS, "version", "3"), "match_changed");

      const parents = async value => (await query("select clued_private.resource_center_ancestor_parents_v1($1::jsonb) value",
        [JSON.stringify(value)])).value;
      assert.deepEqual(await parents({ operation: "create", destination_path: MID + "/x" }), [MID]);
      assert.deepEqual(await parents({ operation: "move", source_path: TRACK + "/a", destination_path: MID + "/a" }), [TRACK, MID].sort());
      assert.deepEqual(await parents({ operation: "delete", source_path: MID + "/a" }), [MID]);
      assert.deepEqual(await parents({ operation: "restore", source_path: MID + "/a" }), [MID]);
      assert.deepEqual(await parents({ operation: "restore", source_path: MID + "/a", destination_path: TRACK + "/a" }), [TRACK]);
      assert.deepEqual(await parents({ operation: "rename", source_path: MID + "/a", destination_path: MID + "/b" }), [MID]);

      const midRegistered = await adminCall({ action: "artifact_register", profile_id: profileId, path: MID, provider_file_id: MID_ID,
        provider_file_version: "5", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
      assert.equal(midRegistered.status, "committed");
      await update(TRACK, { provider_access_digest: ACCESS });
      const root = await rowOf(ROOT);
      const createMutation = { ...mutation, destination_path: MID + "/新目录" };
      const descriptor = (await query(`select clued_private.storage_ancestor_match_v1(p,$2,$3::jsonb) value
        from clued_private.resource_center_profiles_v1 p where id=$1`, [profileId, USER, JSON.stringify(createMutation)])).value;
      assert.deepEqual(descriptor, [
        { path: ROOT, provider_file_id: ROOT_ID, match: "version" },
        { path: TRACK, provider_file_id: TRACK_ID, match: "access" },
        { path: MID, provider_file_id: MID_ID, match: "version" },
      ]);
      const chain = () => [
        { path: ROOT, id: ROOT_ID, parent_id: "my-drive", match: "version", value: root.provider_file_version },
        { path: TRACK, id: TRACK_ID, parent_id: ROOT_ID, match: "access", value: ACCESS },
        { path: MID, id: MID_ID, parent_id: TRACK_ID, match: "version", value: "5" },
      ];
      const withChain = (ancestors, extra = {}) => resolve({ mutation: createMutation, provider_identity: { ...providerIdentity,
        destination_parent_id: MID_ID, root_folder_version: null, destination_parent_version: null, ancestors, ...extra } });
      const edit = (index, change) => chain().map((entry, i) => i === index ? { ...entry, ...change } : entry);
      // Root and destination folder versions are not consulted for a new-shape request.
      assert.equal((await withChain(chain())).status, "resolved");
      assert.equal((await withChain(chain(), { root_folder_version: "999", destination_parent_version: "999" })).status, "resolved");
      // Each ancestor by its own mode.
      assert.deepEqual(await withChain(edit(1, { value: OTHER })), { status: "denied", reason: "ancestor_access_changed" });
      assert.deepEqual(await withChain(edit(1, { value: null })), { status: "denied", reason: "ancestor_access_unavailable" });
      assert.deepEqual(await withChain(edit(1, { match: "version", value: "3" })), { status: "denied", reason: "ancestor_match_changed" });
      assert.deepEqual(await withChain(edit(2, { value: "6" })), { status: "denied", reason: "parent_version_mismatch" });
      assert.deepEqual(await withChain(edit(0, { value: "999" })), { status: "denied", reason: "root_version_mismatch" });
      // Identity and set.
      assert.deepEqual(await withChain(edit(1, { id: "another-id" })), { status: "denied", reason: "ancestor_identity_mismatch" });
      assert.deepEqual(await withChain(edit(2, { parent_id: ROOT_ID })), { status: "denied", reason: "ancestor_identity_mismatch" });
      assert.deepEqual(await withChain(edit(0, { parent_id: "elsewhere" })), { status: "denied", reason: "ancestor_identity_mismatch" });
      assert.deepEqual(await withChain(chain().slice(1)), { status: "denied", reason: "ancestor_set_mismatch" });
      assert.deepEqual(await withChain(chain().slice(0, 2)), { status: "denied", reason: "ancestor_set_mismatch" });
      assert.deepEqual(await withChain([...chain(), { path: MID + "/外", id: "x", parent_id: MID_ID, match: "version", value: "1" }]),
        { status: "denied", reason: "ancestor_set_mismatch" });
      for (const malformed of [{}, [], "x", [...chain(), chain()[0]], edit(1, { extra: 1 }), edit(1, { match: "name" }),
        edit(1, { value: 7 }), edit(1, { id: "bad id" }), chain().map(entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "parent_id")))])
        assert.deepEqual(await withChain(malformed), { status: "denied", reason: "ancestors_invalid" }, JSON.stringify(malformed));
      // Without ancestors the request is checked exactly as before.
      assert.deepEqual(await resolve({ mutation: createMutation, provider_identity: { ...providerIdentity, destination_parent_id: MID_ID,
        destination_parent_version: "6", root_folder_version: root.provider_file_version } }), { status: "denied", reason: "parent_version_mismatch" });
      assert.equal((await resolve({ mutation: createMutation, provider_identity: { ...providerIdentity, destination_parent_id: MID_ID,
        destination_parent_version: "5", root_folder_version: root.provider_file_version } })).status, "resolved");
      // Adopt and a directory move keep their version checks: ancestors are refused.
      for (const shape of [{ operation: "adopt", target_kind: "file", directory_semantics: null, source_path: MID + "/外来.txt", destination_path: null },
        { operation: "move", target_kind: "directory", source_path: MID, destination_path: TRACK + "/另一处" }]) {
        const request = { mutation: { ...mutation, ...shape }, provider_identity: { ...providerIdentity, destination_parent_id: null,
          destination_parent_version: null, source_file_id: "x", source_file_version: "1" } };
        assert.deepEqual(await resolve({ ...request, provider_identity: { ...request.provider_identity, ancestors: chain() } }),
          { status: "denied", reason: "request_invalid" });
        assert.notEqual((await resolve(request)).reason, "request_invalid");
      }
      // A version-matched directory between the root and the destination
      // folder is not compared with its registered version (as today); a
      // sharing-matched one is compared by sharing.
      await update(TRACK, { provider_access_digest: null });
      assert.equal((await withChain(edit(1, { match: "version", value: "777" }))).status, "resolved");
      assert.deepEqual(await withChain(edit(1, { match: "access", value: ACCESS })), { status: "denied", reason: "ancestor_match_changed" });
      await update(TRACK, { provider_sharing_digest: SHARED });
      assert.equal((await withChain(edit(1, { match: "sharing", value: SHARED }))).status, "resolved");
      assert.deepEqual(await withChain(edit(1, { match: "sharing", value: OTHER })), { status: "denied", reason: "ancestor_sharing_changed" });
      // The root and the destination folder by access digest.
      await update(ROOT, { provider_access_digest: ACCESS });
      await update(MID, { provider_access_digest: OTHER });
      const digestChain = [{ ...chain()[0], match: "access", value: ACCESS }, { ...chain()[1], match: "sharing", value: SHARED },
        { ...chain()[2], match: "access", value: OTHER }];
      assert.equal((await withChain(digestChain)).status, "resolved");
      assert.deepEqual(await withChain([{ ...digestChain[0], value: OTHER }, ...digestChain.slice(1)]),
        { status: "denied", reason: "root_access_changed" });
      assert.deepEqual(await withChain([...digestChain.slice(0, 2), { ...digestChain[2], value: ACCESS }]),
        { status: "denied", reason: "parent_access_changed" });
      // A file move works in both folders; the source folder is a parent_.
      const move = { ...mutation, operation: "move", target_kind: "file", directory_semantics: null,
        source_path: TRACK + "/文件.txt", destination_path: MID + "/文件.txt" };
      assert.deepEqual((await query(`select clued_private.storage_ancestor_match_v1(p,$2,$3::jsonb) value
        from clued_private.resource_center_profiles_v1 p where id=$1`, [profileId, USER, JSON.stringify(move)])).value.map(e => e.path), [ROOT, TRACK, MID]);
      const moveMatch = async ancestors => (await query(`select clued_private.resource_center_ancestors_match_v1(p,$2::jsonb,$3::jsonb) value
        from clued_private.resource_center_profiles_v1 p where id=$1`, [profileId, JSON.stringify({ ancestors }), JSON.stringify(move)])).value;
      assert.equal(await moveMatch(digestChain), "match");
      assert.equal(await moveMatch([digestChain[0], { ...digestChain[1], value: OTHER }, digestChain[2]]), "parent_sharing_changed");

      // settle_verified compares registry ancestors by identity, mode and value.
      const identity = async rows => (await query("select clued_private.resource_center_ancestor_rows_identity_v1($1::jsonb) value",
        [JSON.stringify(rows)])).value;
      const saved = [await rowOf(ROOT), await rowOf(TRACK), await rowOf(MID)].map(row => JSON.parse(JSON.stringify(row)));
      const same = saved.map(row => ({ ...row, version: Number(row.version) + 1, updated_at: "2026-10-08T00:00:00Z", receipt_id: crypto.randomUUID(),
        provider_file_version: row.provider_file_version + "0" }));
      assert.deepEqual(await identity(same), await identity(saved));
      assert.notDeepEqual(await identity(saved.map((row, i) => i === 1 ? { ...row, provider_sharing_digest: OTHER } : row)), await identity(saved));
      assert.notDeepEqual(await identity(saved.map((row, i) => i === 0 ? { ...row, provider_access_digest: null } : row)), await identity(saved));
      assert.notDeepEqual(await identity(saved.map((row, i) => i === 2 ? { ...row, path: MID + "x" } : row)), await identity(saved));
      const versionRow = { ...saved[1], provider_sharing_digest: null, provider_access_digest: null };
      assert.notDeepEqual(await identity([{ ...versionRow, provider_file_version: "8" }]), await identity([versionRow]));
      assert.equal(await identity(null), null);

      // Leave the registry as the later checks expect it.
      await update(ROOT, { provider_access_digest: null });
      await update(TRACK, { provider_sharing_digest: null });
      const mid = await rowOf(MID);
      assert.equal((await adminCall({ action: "artifact_revoke", profile_id: profileId, artifact_id: mid.id,
        base_version: Number(mid.version) })).status, "committed");
    });
    if (focusedAncestors) {
      await ancestorIdentity();
      await testStorageModifyExecution(t, admin, server, USER, DECISION);
      await qualifyCurrentCallers(t, admin, server, closeoutSql);
      return;
    }

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
      await setWorkerGatewayCaller(competitor);
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
        { status: "denied", reason: "destination_version_mismatch" });
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
      const gatewayToken = "synthetic-resource-center-authority-worker-gateway";
      const gateway = server.getPgClient();
      await gateway.connect();
      await gateway.query("set session authorization authenticator; set role clued_worker_gateway");
      await gateway.query(`select set_config('request.jwt.claims','{"role":"clued_worker_gateway"}',false)`);
      const workerEnv = { SUPABASE_URL: "https://storage.clued.test",
        CLUED_DB_GATEWAY_TOKEN: gatewayToken,
        ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        assert.equal(new URL(String(url)).host, "storage.clued.test", "no external call");
        assert.match(String(url), /\/rpc\/clued_resource_center_(authority|write)_v1$/);
        if (new Headers(options.headers).get("authorization") !== `Bearer ${gatewayToken}`) {
          return Response.json({ code: "PGRST301", message: "invalid JWT" }, { status: 401 });
        }
        const body = JSON.parse(options.body);
        const rpcName = String(url).endsWith("/clued_resource_center_write_v1")
          ? "clued_resource_center_write_v1" : "clued_resource_center_authority_v1";
        const result = (await gateway.query(
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
            workerEnv,
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
        await gateway.end();
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
    await testAccountCloud(t, admin, server, USER, DECISION,{demandRenewal:true});
    await testStorageRead(t, admin, server, USER, DECISION,{demandRenewal:true});
    await testStorageClientRedirectIdentity(t, admin, server, USER, DECISION);
    await testStorageReadContent(t, admin, server, USER, DECISION);
    await testStorageModifyLevel(t, admin, server, USER, DECISION);
    await testStorageModifyExecution(t, admin, server, USER, DECISION);
    await testStorageReplace(t, admin, server, USER, DECISION);
    await testStorageDestructive(t, admin, server, USER, DECISION);
    await testStorageDirectoryMove(t, admin, server, USER, DECISION);
    await testStorageAdopt(t, admin, server, USER, DECISION);
    await testStorageWorkClaim(t, admin, server, USER, DECISION);
    await testStorageNormalUse(t, admin, server, USER, DECISION);
    await testStorageBinaryUpload(t, admin, server, USER, DECISION);
    await testStorageBudget(t, admin, server, USER);
    await testStorageOnboard(t, admin, server, USER, DECISION);
    await testStorageConnections(t, admin, server);
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
    await ancestorIdentity();
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
    await qualifyCurrentCallers(t, admin, server, closeoutSql);
  } finally {
    if (anon) await anon.end();
    if (admin) await admin.end();
    await server.stop();
  }
});
