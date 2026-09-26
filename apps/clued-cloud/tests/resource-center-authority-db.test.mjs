import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import EmbeddedPostgres from "embedded-postgres";

import { createResourceCenterGoogleDriveOnlineToolHost } from "../../../kernel/host/resource-center-online-tool-host.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

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

test("Canonical Resource Center registration and exact read-only authority", { timeout: 180000 }, async (t) => {
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
      "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;" +
      "create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;" +
      "grant usage on schema auth,extensions to anon,authenticated,service_role;" +
      "grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;");
    const migrationDir = path.join(process.cwd(), "supabase", "migrations");
    for (const name of (await fs.readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort()) {
      try {
        await admin.query(await fs.readFile(path.join(migrationDir, name), "utf8"));
      } catch (error) {
        throw new Error("Migration " + name + ": " + error.message, { cause: error });
      }
    }
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

    await t.test("durable journal fences restart, start replay and uncertain effects", async () => {
      const journal = async (input, client = admin) => (await client.query(
        "select public.clued_resource_center_mutation_journal_v1($1,$2::jsonb) value",
        [USER, JSON.stringify({ profile_id: profileId, source_decision_id: DECISION,
          idempotency_key: crypto.randomUUID(), ...input })],
      )).rows[0].value;
      const prepare = {
        action: "prepare", request_key: "durable-create-1", request_sha256: "b".repeat(64),
        exact_request: mutation, authority_token_hash: tokenHash,
        authority_request: {
          profile_id: profileId, profile_version: "test/1",
          policy_version: "clued.resource-center-mutation-policy/1",
          provider_identity: providerIdentity, mutation,
        },
      };
      await assert.rejects(journal(prepare, anon), /permission denied/);
      const prepared = await journal(prepare);
      assert.equal(prepared.status, "committed");
      assert.equal(prepared.state, "prepared");
      assert.equal(prepared.execution_permitted, false);
      const bound = { intent_id: prepared.intent_id, request_sha256: prepare.request_sha256 };
      const competitor = server.getPgClient();
      await competitor.connect();
      try {
        const other = await journal({ ...prepare, request_key: "another-host" }, competitor);
        assert.equal(other.status, "rejected");
        const start = { ...bound, action: "start", base_version: 1,
          idempotency_key: "durable-start-once" };
        const results = await Promise.all([journal(start), journal({ ...start,
          idempotency_key: "competing-start" }, competitor).catch((error) => ({ error: error.message }))]);
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
        request_sha256: "c".repeat(64), exact_request: mutation, authority_token_hash: tokenHash,
        authority_request: { profile_id: profileId, profile_version: "test/1",
          policy_version: "clued.resource-center-mutation-policy/1", provider_identity: providerIdentity, mutation } });
      assert.equal(prepared.state, "prepared");
      await admin.query("update clued_private.resource_center_mutations_v1 set expires_at=now()-interval '1 second' where id=$1", [prepared.intent_id]);
      const bound = { intent_id: prepared.intent_id, request_sha256: "c".repeat(64), base_version: 1 };
      assert.equal((await journal({ ...bound, action: "start" })).status, "rejected");
      assert.equal((await journal({ ...bound, action: "cancel" })).state, "cancelled");
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
      assert.equal((await resolve({ mutation: replacement, provider_identity: identity })).status, "denied");
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
      assert.equal((await resolve({ profile_version: "other" })).status, "denied");
      assert.equal((await resolve({ provider_identity: {
        ...providerIdentity, destination_parent_id: "same-name-other-id",
      } })).status, "denied");
      assert.equal((await resolve({ provider_identity: {
        ...providerIdentity, destination_parent_version: "3",
      } })).status, "denied");
      assert.equal((await resolve({ mutation: {
        ...mutation, destination_path: ROOT + "/not-registered/topic",
      } })).status, "denied");
    });
    await t.test("a generic Clued hash cannot substitute for the dedicated Binding", async () => {
      const generic = crypto.randomBytes(32).toString("hex");
      const denied = (await anon.query(
        "select public.clued_resource_center_authority_v1($1,$2::jsonb) value",
        [generic, JSON.stringify({ profile_id: profileId })],
      )).rows[0].value;
      assert.equal(denied.status, "denied");
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
    await t.test("temporary authority reaches Host and Worker but missing write receipt prevents an effect", async (child) => {
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
        assert.match(String(url), /\/rpc\/clued_resource_center_authority_v1$/);
        const body = JSON.parse(options.body);
        const result = (await anon.query(
          "select public.clued_resource_center_authority_v1($1,$2::jsonb) value",
          [body.p_token_hash, JSON.stringify(body.p_request)],
        )).rows[0].value;
        return Response.json(result);
      };
      try {
        const host = createResourceCenterGoogleDriveOnlineToolHost({
          trusted_profile: {
            registration_status: "registered", profile_id: tempProfileId,
            profile_version: "temp/1", managed_root: nativeRoot,
            allowed_root_children: ["20_P_产品与体验"],
            boundary_scan_roots: [tempParent],
          },
          root_folder_id: "temp-root-id", root_parent_id: "temp-parent-id",
          get_drive_access_token: async () => "metadata-only-test-token",
          drive_fetch: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/temp-root-id")) {
              return Response.json({
                id: "temp-root-id", name: "Clued_资料中心",
                parents: ["temp-parent-id"], version: "1", trashed: false,
                mimeType: "application/vnd.google-apps.folder",
              });
            }
            const query = parsed.searchParams.get("q") ?? "";
            if (query.includes("'temp-root-id' in parents")) return Response.json({ files: [{
                id: "temp-track-id", name: "20_P_产品与体验",
                parents: ["temp-root-id"], version: "2", trashed: false,
                mimeType: "application/vnd.google-apps.folder",
              }] });
            return Response.json({ files: [] });
          },
          authority_endpoint: "https://clued.test/v1/resource-center/authority",
          authority_binding_token: rawToken,
          authority_fetch: (url, options) => worker.fetch(
            new Request(url, options),
            { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
            { waitUntil() {}, passThroughOnException() {} },
          ),
        });
        const createTopic = (destination) => host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
          operation: "create", destination_path: destination,
          target_kind: "directory", directory_semantics: "topic",
        });
        assert.equal((await createTopic(nativeTopic)).error_code,
          "POST_WRITE_CANONICAL_RECEIPT_UNAVAILABLE");
        await assert.rejects(fs.stat(nativeTopic), { code: "ENOENT" });
        const unregisteredChild = path.join(nativeTopic, "child.txt");
        assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
          operation: "create", destination_path: unregisteredChild,
          target_kind: "file",
        })).error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
        await assert.rejects(fs.stat(unregisteredChild), { code: "ENOENT" });
        const bindingId = tempBinding.target_refs.find((ref) => ref.role === "primary").id;
        assert.equal((await adminCall({
          action: "binding_revoke", profile_id: tempProfileId, binding_id: bindingId,
        })).status, "committed");
        const deniedTopic = path.join(nativeTrack, "revoked");
        assert.equal((await createTopic(deniedTopic)).error_code,
          "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
        await assert.rejects(fs.stat(deniedTopic), { code: "ENOENT" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
    const removed = await adminCall({
      action: "artifact_revoke", profile_id: profileId, artifact_id: trackId, base_version: 2,
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
