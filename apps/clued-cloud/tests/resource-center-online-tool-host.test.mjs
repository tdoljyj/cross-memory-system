import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createResourceCenterOnlineToolHost,
  createResourceCenterOnlineToolHostFromService,
  createResourceCenterGoogleDriveOnlineToolHost,
} from "../../../kernel/host/resource-center-online-tool-host.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";
import { qualifyResourceCenterHost } from "../../../kernel/host/resource-center-host-qualification.mjs";
import { createResourceCenterWriteClient } from "../../../kernel/host/resource-center-write-client.mjs";
import { createResourceCenterRecoveryStore } from "../../../kernel/host/resource-center-recovery-store.mjs";

function profileFor(root) {
  return {
    registration_status: "registered",
    profile_id: "online-host-test",
    profile_version: "test/1",
    managed_root: path.join(root, "Clued_资料中心"),
    allowed_root_children: ["20_P_产品与体验"],
    boundary_scan_roots: [root],
  };
}

function authority(version = "canonical/1") {
  return {
    artifact_id: null,
    artifact_role: "clued_resource",
    governance_class: "ordinary",
    delete_authority: false,
    authority_version: version,
    currentness_identity: "currentness/1",
    workspace_version: "workspace/1",
  };
}

async function testReservation({ binding }) {
  return { status: "started", execution_permitted: true,
    intent_id: "00000000-0000-4000-8000-000000000010", request_sha256: binding.request_sha256 };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clued-online-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = profileFor(root);
  await fs.mkdir(profile.managed_root);
  return { profile, destination: path.join(profile.managed_root, "20_P_产品与体验") };
}

test("online Host rechecks exact authority before a permitted effect", async (t) => {
  const { profile, destination } = await fixture(t);
  const observed = [];
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async ({ profile: boundProfile, mutation }) => {
      observed.push({ profile: boundProfile, mutation });
      return authority();
    },
    prepare_write: testReservation,
    commit_post_write: async ({ binding }) => ({
      status: "committed", receipt_id: "00000000-0000-4000-8000-000000000001",
      request_sha256: binding.request_sha256,
    }),
  });
  assert.equal(qualifyResourceCenterHost({ trusted_profile: profile, tools: host.listTools() }).status,
    "qualified");
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create",
    destination_path: destination,
    target_kind: "directory",
    directory_semantics: "track",
  });
  assert.equal(result.status, "committed");
  assert.equal(result.canonical_receipt_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(observed.length, 2);
  assert.equal(observed[0].profile.managed_root, profile.managed_root);
  assert.equal(observed[0].mutation.artifact_role, "clued_resource");
  assert.equal((await fs.stat(destination)).isDirectory(), true);
});

test("online authority drift and failure cause zero filesystem effects", async (t) => {
  const { profile, destination } = await fixture(t);
  let calls = 0;
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => authority(++calls === 1 ? "canonical/1" : "canonical/2"),
    prepare_write: testReservation,
    commit_post_write: async ({ binding }) => ({
      status: "committed", receipt_id: "00000000-0000-4000-8000-000000000001",
      request_sha256: binding.request_sha256,
    }),
  });
  const request = {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  };
  const drift = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, request);
  assert.equal(drift.error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal(calls, 2);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });

  const offline = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => { throw new Error("offline"); },
  });
  assert.equal((await offline.callTool(RESOURCE_CENTER_MUTATION_TOOL, request)).error_code,
    "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });

  let revalidationCalls = 0;
  const revalidationOffline = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => {
      if (++revalidationCalls === 2) throw new Error("offline after preflight");
      return authority();
    },
  });
  assert.equal((await revalidationOffline.callTool(RESOURCE_CENTER_MUTATION_TOOL, request)).error_code,
    "ARTIFACT_AUTHORITY_REVALIDATION_FAILED");
  assert.equal(revalidationCalls, 2);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("online Host refuses an effect without a Canonical post-write finalizer", async (t) => {
  const { profile, destination } = await fixture(t);
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => authority(),
  });
  assert.equal(host.listTools().some((tool) => tool.name === RESOURCE_CENTER_MUTATION_TOOL), false);
  assert.equal(qualifyResourceCenterHost({ trusted_profile: profile, tools: host.listTools() }).status,
    "not_qualified");
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.error_code, "POST_WRITE_CANONICAL_RECEIPT_UNAVAILABLE");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("one Host cannot run two governed mutations concurrently", async (t) => {
  const { profile, destination } = await fixture(t);
  let release;
  let signal;
  const entered = new Promise((resolve) => { signal = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => {
      signal();
      await held;
      return authority();
    },
  });
  const mutation = {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  };
  const first = host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation);
  await entered;
  assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation)).error_code,
    "MUTATION_ALREADY_IN_PROGRESS");
  release();
  assert.equal((await first).error_code, "POST_WRITE_CANONICAL_RECEIPT_UNAVAILABLE");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("a finalizer alone is insufficient without a durable reservation", async (t) => {
  const { profile, destination } = await fixture(t);
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile, resolve_artifact_online: async () => authority(),
    commit_post_write: async () => { throw new Error("must not be reached"); },
  });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.error_code, "DURABLE_WRITE_RESERVATION_UNAVAILABLE");
  assert.equal(host.listTools().some((tool) => tool.name === RESOURCE_CENTER_MUTATION_TOOL), false);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("lost or mismatched durable start responses cause zero effects and no retry", async (t) => {
  for (const mode of ["lost", "wrong_digest", "replayed"]) {
    const { profile, destination } = await fixture(t);
    let calls = 0;
    const host = createResourceCenterOnlineToolHost({
      trusted_profile: profile, resolve_artifact_online: async () => authority(),
      prepare_write: async ({ binding }) => {
        calls += 1;
        if (mode === "lost") throw new Error("response lost after start");
        return { ...await testReservation({ binding }),
          ...(mode === "wrong_digest" ? { request_sha256: "f".repeat(64) } : { execution_permitted: false }) };
      },
      commit_post_write: async () => { throw new Error("must not be reached"); },
    });
    const mutation = { operation: "create", destination_path: destination,
      target_kind: "directory", directory_semantics: "track" };
    assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation)).error_code,
      "DURABLE_WRITE_RESERVATION_FAILED");
    assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation)).error_code,
      "POST_WRITE_RECONCILIATION_REQUIRED");
    assert.equal(calls, 1);
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  }
});

test("failed post-write finalization never reports committed and quarantines the Host", async (t) => {
  const { profile, destination } = await fixture(t);
  let finalizeCalls = 0;
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => authority(),
    prepare_write: testReservation,
    commit_post_write: async () => { finalizeCalls += 1; throw new Error("offline"); },
  });
  const mutation = {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  };
  const first = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation);
  assert.equal(first.status, "unreconciled");
  assert.equal(first.error_code, "POST_WRITE_CANONICAL_RECONCILIATION_FAILED");
  assert.equal(first.side_effects, 1);
  assert.equal((await fs.stat(destination)).isDirectory(), true);
  assert.equal(finalizeCalls, 1);
  assert.equal(host.listTools().some((tool) => tool.name === RESOURCE_CENTER_MUTATION_TOOL), false);
  const second = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation);
  assert.equal(second.error_code, "POST_WRITE_RECONCILIATION_REQUIRED");
  assert.equal(finalizeCalls, 1);
});

test("a receipt for another mutation cannot acknowledge this storage effect", async (t) => {
  const { profile, destination } = await fixture(t);
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => authority(),
    prepare_write: testReservation,
    commit_post_write: async () => ({
      status: "committed", receipt_id: "00000000-0000-4000-8000-000000000002",
      request_sha256: "0".repeat(64),
    }),
  });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.status, "unreconciled");
  assert.equal(result.error_code, "POST_WRITE_CANONICAL_RECONCILIATION_FAILED");
  assert.equal((await fs.stat(destination)).isDirectory(), true);
});

test("status folder and caller authority are denied without an effect", async (t) => {
  const { profile, destination } = await fixture(t);
  let calls = 0;
  const host = createResourceCenterOnlineToolHost({
    trusted_profile: profile,
    resolve_artifact_online: async () => { calls += 1; return authority(); },
  });
  const statusPath = path.join(destination, "00_现行基线");
  const status = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: statusPath,
    target_kind: "directory", directory_semantics: "topic",
  });
  assert.equal(status.error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN");
  assert.equal(calls, 1);
  assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
    managed_root: profile.managed_root,
  })).error_code, "CONTROLLED_TOOL_ARGUMENTS_INVALID");
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(statusPath), { code: "ENOENT" });
});

test("production wiring rejects a mismatched authority reply before touching the filesystem", async (t) => {
  const { profile, destination } = await fixture(t);
  const host = createResourceCenterOnlineToolHostFromService({
    trusted_profile: profile,
    authority_endpoint: "https://clued.example/v1/resource-center/authority",
    authority_binding_token: `clued_rcb_${"a".repeat(40)}`,
    resolve_provider_identity: async () => ({
      root_folder_id: "root-id", root_parent_id: "my-drive", root_folder_version: "1",
      source_file_id: null, source_file_version: null,
      destination_parent_id: "parent-id", destination_parent_version: "2",
      destination_file_id: null, destination_file_version: null,
      provider_version: "a".repeat(64),
    }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        contract: body.request.contract, status: "resolved",
        request_sha256: body.request_sha256,
        request: { ...body.request, profile_id: "wrong-profile" },
        authority: authority(),
      }) };
    },
  });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("production wiring consumes admission when the Drive parent version changes", async (t) => {
  const { profile, destination } = await fixture(t);
  let reads = 0;
  const host = createResourceCenterOnlineToolHostFromService({
    trusted_profile: profile,
    prepare_write: testReservation,
    commit_post_write: async ({ binding }) => ({
      status: "committed", receipt_id: "00000000-0000-4000-8000-000000000001",
      request_sha256: binding.request_sha256,
    }),
    authority_endpoint: "https://clued.example/v1/resource-center/authority",
    authority_binding_token: `clued_rcb_${"a".repeat(40)}`,
    resolve_provider_identity: async () => ({
      root_folder_id: "root-id", root_parent_id: "my-drive", root_folder_version: "1",
      source_file_id: null, source_file_version: null,
      destination_parent_id: "parent-id", destination_parent_version: String(++reads),
      destination_file_id: null, destination_file_version: null,
      provider_version: "a".repeat(64),
    }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        contract: body.request.contract, status: "resolved",
        request_sha256: body.request_sha256, request: body.request,
        authority: authority(),
      }) };
    },
  });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal(reads, 2);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("pinned Drive metadata and Clued service compose without exposing authority to the caller", async (t) => {
  const { profile, destination } = await fixture(t);
  const rootName = path.basename(profile.managed_root);
  let driveReads = 0;
  let authorityReads = 0;
  const host = createResourceCenterGoogleDriveOnlineToolHost({
    trusted_profile: profile,
    root_folder_id: "drive-root-folder",
    root_parent_id: "my-drive",
    get_drive_credential: async () => ({ access_token: "metadata-only-test-token",
      scope: "https://www.googleapis.com/auth/drive.metadata.readonly" }),
    drive_fetch: async (url, options) => {
      driveReads += 1;
      assert.equal(options.headers.authorization, "Bearer metadata-only-test-token");
      return { ok: true, json: async () => new URL(url).pathname.endsWith("/drive-root-folder")
        ? { id: "drive-root-folder", name: rootName, parents: ["my-drive"],
          mimeType: "application/vnd.google-apps.folder", version: "1", trashed: false }
        : { files: [] } };
    },
    authority_endpoint: "https://clued.example/v1/resource-center/authority",
    authority_binding_token: `clued_rcb_${"a".repeat(40)}`,
    prepare_write: testReservation,
    commit_post_write: async ({ binding }) => ({
      status: "committed", receipt_id: "00000000-0000-4000-8000-000000000001",
      request_sha256: binding.request_sha256,
    }),
    authority_fetch: async (_url, options) => {
      authorityReads += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.request.provider_identity.root_folder_id, "drive-root-folder");
      assert.equal(body.request.provider_identity.root_parent_id, "my-drive");
      assert.equal(body.request.provider_identity.destination_parent_id, "drive-root-folder");
      return { ok: true, json: async () => ({
        contract: body.request.contract, status: "resolved",
        request_sha256: body.request_sha256, request: body.request, authority: authority(),
      }) };
    },
  });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.status, "committed");
  assert.equal(result.canonical_receipt_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(authorityReads, 2);
  assert.equal(driveReads, 4);
  assert.equal((await fs.stat(destination)).isDirectory(), true);
});

test("drive.file visibility failure stops the real Host composition before reservation or mutation", async (t) => {
  const { profile, destination } = await fixture(t);
  let authorityCalls = 0;
  let writes = 0;
  let driveCalls = 0;
  const host = createResourceCenterGoogleDriveOnlineToolHost({
    trusted_profile: profile, root_folder_id: "root", root_parent_id: "my-drive",
    get_drive_credential: async () => ({ access_token: "file-scoped-test-token",
      scope: "https://www.googleapis.com/auth/drive.file" }),
    drive_fetch: async () => {
      driveCalls += 1;
      return Response.json({ id: "root", name: path.basename(profile.managed_root),
        parents: ["my-drive"], mimeType: "application/vnd.google-apps.folder", version: "1", trashed: false });
    },
    authority_endpoint: "https://clued.example/v1/resource-center/authority",
    authority_binding_token: `clued_rcb_${"a".repeat(40)}`,
    authority_fetch: async () => { authorityCalls += 1; throw new Error("must not run"); },
    prepare_write: async () => { writes += 1; throw new Error("must not run"); },
    commit_post_write: async () => { writes += 1; throw new Error("must not run"); },
  });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, {
    operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track",
  });
  assert.equal(result.status, "deny");
  assert.equal(result.side_effects, 0);
  assert.equal(result.error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
  assert.equal(driveCalls, 1);
  assert.equal(authorityCalls, 0);
  assert.equal(writes, 0);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("writer client persists before network and can inspect a lost start without replay", async (t) => {
  const { profile } = await fixture(t);
  const journalPath = path.join(path.dirname(profile.managed_root), "recovery.jsonl");
  await fs.writeFile(journalPath, "", { flag: "wx" });
  const store = createResourceCenterRecoveryStore(journalPath);
  let ticket;
  const bootstrap = {
    endpoint: "https://clued.example/v1/resource-center/write",
    resolve_provider_identity: async () => ({}), verify_postcondition: async () => ({}),
    persist_recovery: async (value) => { await store.persist_recovery(value); ticket = value; },
  };
  assert.throws(() => createResourceCenterWriteClient({ ...bootstrap,
    binding_token: `clued_rcb_${"a".repeat(40)}` }), /dedicated writer/);
  let calls = 0;
  const client = createResourceCenterWriteClient({ ...bootstrap,
    binding_token: `clued_rcw_${"a".repeat(40)}`,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls += 1;
      assert.deepEqual(await store.read_recovery(ticket.request_key), ticket);
      assert.equal(body.request.profile_id, undefined);
      assert.equal(body.request.managed_root, undefined);
      assert.equal(body.request.source_decision_id, undefined);
      assert.equal(body.request.authority_token_hash, undefined);
      if (calls === 2) throw new Error("start response lost");
      if (body.request.action === "inspect") return Response.json({ ...body,
        outcome: { status: "started", execution_permitted: false } });
      return Response.json({ ...body, outcome: { status: "committed", state: "prepared",
        intent_id: "00000000-0000-4000-8000-000000000010", version: 1,
        request_sha256: body.request.request_sha256 } });
    },
  });
  await assert.rejects(client.prepare_write({ profile: { profile_id: "profile", profile_version: "1" },
    mutation: { operation: "create" }, binding: { request_sha256: "a".repeat(64) } }), /response lost/);
  assert.equal(calls, 2);
  assert.equal((await client.inspect_recovery(await store.read_recovery(ticket.request_key))).status, "started");
  assert.equal(calls, 3);
  await assert.rejects(store.persist_recovery(ticket), /ALREADY_EXISTS/);
  assert.equal(JSON.stringify(ticket).includes("clued_rcw_"), false);
  await fs.appendFile(journalPath, '{"partial":');
  await assert.rejects(store.persist_recovery({ ...ticket,
    request_key: "00000000-0000-4000-8000-000000000099" }), /PARTIAL_RECORD/);
  await assert.rejects(store.read_recovery(ticket.request_key), /PARTIAL_RECORD/);
});

test("writer client rejects substituted replies and unqualified operations", async () => {
  let calls = 0;
  const client = createResourceCenterWriteClient({
    endpoint: "https://clued.example/v1/resource-center/write", binding_token: `clued_rcw_${"a".repeat(40)}`,
    resolve_provider_identity: async () => ({}), verify_postcondition: async () => ({}),
    persist_recovery: async () => {},
    fetch: async (_url, options) => {
      calls += 1;
      return Response.json({ ...JSON.parse(options.body), nonce: "substituted" });
    },
  });
  const input = { profile: { profile_id: "profile", profile_version: "1" },
    mutation: { operation: "create" }, binding: { request_sha256: "a".repeat(64) } };
  await assert.rejects(client.prepare_write({ ...input, mutation: { operation: "delete" } }), /NOT_QUALIFIED/);
  assert.equal(calls, 0);
  await assert.rejects(client.prepare_write(input), /RESPONSE_MISMATCH/);
  assert.equal(calls, 1);
  await assert.rejects(client.commit_post_write({ reservation: { intent_id: "foreign" } }), /RESERVATION_MISMATCH/);
});

test("unsupported operation does not quarantine subsequent create", async (t) => {
  const { profile, destination } = await fixture(t);
  let reserves = 0;
  const host = createResourceCenterOnlineToolHost({ trusted_profile: profile,
    resolve_artifact_online: async () => authority(),
    prepare_write: async (input) => { reserves += 1; return testReservation(input); },
    commit_post_write: async ({ binding }) => ({ status: "committed",
      receipt_id: "00000000-0000-4000-8000-000000000001", request_sha256: binding.request_sha256 }),
  });
  const mutation = { operation: "create", destination_path: destination,
    target_kind: "directory", directory_semantics: "track" };
  assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL,
    { ...mutation, operation: "write" })).error_code, "WRITER_OPERATION_NOT_QUALIFIED");
  assert.equal(reserves, 0);
  assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, mutation)).status, "committed");
  assert.equal(reserves, 1);
});

test("unavailable durable recovery storage prevents all service calls", async () => {
  let calls = 0;
  const client = createResourceCenterWriteClient({
    endpoint: "https://clued.example/v1/resource-center/write", binding_token: `clued_rcw_${"a".repeat(40)}`,
    resolve_provider_identity: async () => ({}), verify_postcondition: async () => ({}),
    persist_recovery: async () => { throw new Error("disk unavailable"); },
    fetch: async () => { calls += 1; throw new Error("must not call"); },
  });
  await assert.rejects(client.prepare_write({ profile: { profile_id: "profile", profile_version: "1" },
    mutation: { operation: "create" }, binding: { request_sha256: "a".repeat(64) } }), /disk unavailable/);
  assert.equal(calls, 0);
});
