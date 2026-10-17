import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
import { scopeString } from "../worker/storage-google-scopes.ts";

const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid", token = "clued_bnd_" + "a".repeat(40);

async function fixture({currentRegistration = false} = {}) {
  const { createStorageCredentialVault } = await import("../worker/storage-credential-vault.ts");
  const reference = { connection_id: randomUUID(), job_id: randomUUID() };
  const context = { owner_id: randomUUID(), connection_id: reference.connection_id, provider: "google-drive",
    provider_subject: "subject", oauth_client_id: "fixture-client", credential_version: 4 };
  const keys = { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } };
  const vault = await createStorageCredentialVault(keys), source = randomUUID(), receipt = randomUUID(), intent = randomUUID();
  const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", SUPABASE_URL: "https://db.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "fixture-public-key", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true",
    CLUED_STORAGE_JOBS_V1: "true", CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_EXECUTOR_V1: "true",
    CLUED_STORAGE_CONNECTOR_ISSUER: randomBytes(32).toString("base64url"), CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture-client",
    CLUED_STORAGE_VAULT_KEYS: JSON.stringify(keys) };
  const descriptor = { ...context, ...reference, status: "recovery_only", intent_id: intent, version: 3,
    request_sha256: "d".repeat(64), root_folder_id: "root", root_parent_id: "drive", profile: { managed_root: "/root" },
    mutation: { operation: "replace", target_kind: "file", destination_path: "/root/track/a.txt", destination_file_version: "5", content: "test", artifact_role: "clued_resource" },
    provider_before: { root_folder_id: "root", root_parent_id: "drive", root_folder_version: "1", destination_parent_id: "track",
      destination_parent_version: "1", destination_file_id: "file", destination_file_version: "5", provider_version: "c".repeat(64) },
    attempt: { contract: "clued.storage-replace-attempt/1", operation: "replace", provider_file_id: "file", parent_id: "track",
      destination_path: "/root/track/a.txt", destination_file_version: "5", pinned_revision_id: "rev1",
      content_before: { size: "3", sha256: "a".repeat(64), head_revision_id: "rev1", md5: "a".repeat(32) },
      content_after: { size: "4", sha256: "b".repeat(64) }, previously_kept: false, release_revision_ids: [] },
    conflict_reconcile: { source_receipt_id: source, closed_version: 3 },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "fixture-access-token-0001",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",
      expires_at_ms: Date.now() + 3600000 }), context) };
  let registrationDescriptor;
  if (currentRegistration) {
    descriptor.mutation = { operation: "delete", target_kind: "directory", source_path: "/root/track/Topic", source_file_id: "file", source_file_version: "5" };
    descriptor.provider_before = { root_folder_id: "root", root_parent_id: "drive", root_folder_version: "1", source_file_id: "file",
      source_file_version: "5", source_parent_id: "track", source_parent_version: "1" };
    descriptor.attempt = { contract: "clued.storage-destructive-attempt/1", operation: "delete", provider_file_id: "file", parent_id: "track",
      source_path: "/root/track/Topic", destination_path: null, content: null };
    descriptor.credential_envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "fixture-access-token-0001",
      scope: scopeString("full"), expires_at_ms: Date.now() + 3600000 }), context);
    const reader = { contract: "clued.storage-recovery-reader/1", connection_id: reference.connection_id, credential_version: 4,
      connection_version: 1, auth_generation: 1, policy_id: randomUUID(), policy_generation: 1, scope_digest: "a".repeat(64), profile_version: 1 };
    descriptor.recovery_reader = reader;
    const registered = (path, id, parent) => ({ artifact_id: randomUUID(), artifact_version: 1, path, provider_file_id: id, parent_id: parent,
      access_digest: null, sharing_digest: null });
    registrationDescriptor = { status: "registration_required", ...reference, owner_id: context.owner_id, intent_id: intent,
      base_version: 3, source_receipt_id: source, credential_version: 4, credential_envelope: descriptor.credential_envelope,
      recovery_reader: reader, registration_authority: { contract: "clued.storage-registration-program-authority/1", actor_kind: "storage_program",
        ...context, original_connection_id: reference.connection_id, job_id: reference.job_id, intent_id: intent,
        issuer_id: randomUUID(), issuer_credential_generation: 1, registration_action: "modify", provider_scope_profile: "full", actions: ["modify"],
        root_folder_id: "root", root_parent_id: "drive", managed_root: "/root" },
      registration_plan: { contract: "clued.storage-registration-plan/1", mode: "refresh_directory", managed_root: "/root",
        root_folder_id: "root", root_parent_id: "drive", intent_id: intent, request_sha256: descriptor.request_sha256,
        parents: [registered("/root", "root", "drive"), registered("/root/track", "track", "root")],
        target: registered("/root/track/Topic", "file", "track") }, execution_permitted: false };
  }
  const calls = [], google = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === env.SUPABASE_URL) {
      if (u.pathname === "/auth/v1/user") return Response.json({ id: context.owner_id });
      const { p_input: input } = JSON.parse(init.body), rpc = u.pathname.split("/").at(-1); calls.push({ rpc, input });
      if (rpc === "clued_storage_jobs_router_v2") return Response.json({ status: "rejected", error_code: "storage_object_under_review" });
      if (rpc === "clued_storage_cloud_worker_router_v2") {
        assert.equal(input.action, "verified_inspect");
        return Response.json({ status: "inspection_required", ...reference, execution_permitted: false });
      }
      if (currentRegistration && rpc === "clued_storage_native_recovery_v1") {
        assert.equal(input.action, "recovery_inspect");
        return Response.json({ ...reference, status: "conflict", request_digest: "d".repeat(64), intent_id: intent,
          receipt_id: source, automatic_recovery: "current_state_conflict", review_available: false, execution_permitted: false });
      }
      if (currentRegistration && rpc === "clued_storage_native_recovery_load_v2") return Response.json(descriptor);
      assert.equal(rpc, "clued_storage_scheduled_recovery_v2");
      if (input.action === "due") { assert.deepEqual(input, { action: "due" }); return Response.json({ status: "ok", jobs: [reference] }); }
      assert.equal(input.connection_id, reference.connection_id); assert.equal(input.job_id, reference.job_id);
      if (input.action === "load") return Response.json(descriptor);
      if (currentRegistration && input.action === "registration_current_load") return Response.json(registrationDescriptor);
      if (currentRegistration && input.action === "registration_current_commit") {
        assert.equal(input.first_observation.target.empty, true);assert.equal(input.second_observation.target.provider_file_version, "6");
        assert.equal(input.source_receipt_id, source);assert.equal(input.base_version, 3);assert.equal(Object.hasOwn(input, "confirmed"), false);
        return Response.json({ status: "resolved", resolution: "automatically_registered_current_state", automatic_recovery: "resolved", ...reference,
          intent_id: intent, source_receipt_id: source, base_version: 3, receipt_id: receipt, execution_permitted: false });
      }
      assert.equal(input.action, "reconcile_before");
      if (currentRegistration) {
        assert.equal(input.second_observation.observed_state, "changed");
        return Response.json({ status: "inspection_required", automatic_recovery: "current_state_conflict", ...reference, intent_id: intent,
          source_receipt_id: source, base_version: 3, execution_permitted: false, diagnostic: { stage: "verification", reason: "CONTENT_MISMATCH",
            observed_at: input.second_observation.observed_at, automatic_next_action: "continue_object_recovery" } });
      }
      assert.equal(input.first_observation.observed_state, "before"); assert.equal(input.second_observation.observed_state, "before");
      return Response.json({ status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved", ...reference,
        intent_id: intent, source_receipt_id: source, base_version: 3, receipt_id: receipt, execution_permitted: false });
    }
    google.push({ path: u.pathname, method: init.method, body: init.body });
    assert.equal(u.origin, "https://www.googleapis.com"); assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder",
      ...(currentRegistration ? { explicitlyTrashed: false, ownedByMe: true, shared: false, permissionIds: ["drive-owner"],
        permissions: [{ id: "drive-owner", type: "user", role: "owner" }], capabilities: { canShare: true, canListChildren: true } } : {}) });
    const current = currentRegistration ? { ...folder("file", "Topic", "track"), version: "6" }
      : { id: "file", name: "a.txt", parents: ["track"], version: "5", trashed: false, mimeType: "text/plain",
        size: "3", sha256Checksum: "a".repeat(64), headRevisionId: "rev1" };
    if (u.pathname === "/drive/v3/files/file") return Response.json(current);
    if (u.pathname === "/drive/v3/files/root") return Response.json(folder("root", "root", "drive"));
    if (currentRegistration && u.pathname === "/drive/v3/files/track") return Response.json(folder("track", "track", "root"));
    assert.equal(u.pathname, "/drive/v3/files");
    if (currentRegistration) {
      const q = u.searchParams.get("q"), parent = /^'([^']+)' in parents/.exec(q)?.[1], name = /name = '([^']+)'/.exec(q)?.[1];
      return Response.json({ files: [folder("root", "root", "drive"), folder("track", "track", "root"), current]
        .filter(file => file.parents[0] === parent && (!name || file.name === name)), incompleteSearch: false });
    }
    return Response.json({ files: [u.searchParams.get("q").includes("name = 'track'") ? folder("track", "track", "root") : current] });
  };
  const request = (body, bearer = token) => new Request(origin + "/v1/storage/jobs", { method: "POST",
    headers: { origin, authorization: "Bearer " + bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { reference, env, calls, google, fetcher, request, source, receipt };
}

test("cron automatically reconciles the original before-state without a page, Agent or provider write", async () => {
  const f = await fixture(), previous = globalThis.fetch; globalThis.fetch = f.fetcher;
  try {
    assert.deepEqual(await worker.runStorageRecoveryScheduled(f.env), { status: "ok", committed: 0, released: 0, reconciled: 1, attention: 0 });
    assert.deepEqual(f.calls.map(c => c.input.action), ["due", "verified_inspect", "load", "reconcile_before"]);
    assert.equal(f.google.filter(c => c.path === "/drive/v3/files/file").length, 2);
    assert.ok(f.google.every(c => c.method === "GET" && c.body === undefined));
  } finally { globalThis.fetch = previous; }
});

test("an authenticated ordinary refusal wakes the trusted due scan rather than a caller-selected recovery", async () => {
  const f = await fixture(), previous = globalThis.fetch, pending = []; globalThis.fetch = f.fetcher;
  const untrusted = { action: "submit", connection_id: randomUUID(), job_id: randomUUID(), mutation: { operation: "create" } };
  try {
    const response = await worker.fetch(f.request(untrusted), f.env, { waitUntil: p => pending.push(p) });
    assert.equal(response.status, 200); assert.equal((await response.json()).error, "storage_object_under_review");
    await Promise.all(pending); assert.equal(pending.length, 1);
    assert.deepEqual(f.calls.filter(c => c.input.action === "due").map(c => c.input), [{ action: "due" }]);
    assert.equal(f.calls.filter(c => c.input.action === "reconcile_before").length, 1);
    assert.ok(f.calls.filter(c => c.rpc !== "clued_storage_jobs_router_v2" && c.input.job_id).every(c => c.input.job_id === f.reference.job_id));
    assert.ok(f.google.every(c => c.method === "GET"));
  } finally { globalThis.fetch = previous; }
});

test("authentication and unrelated database failures never wake privileged recovery", async () => {
  const f = await fixture(), previous = globalThis.fetch, pending = []; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ message: "private failure", code: "42501" }, { status: 403 }); };
  try {
    assert.equal((await worker.fetch(f.request({ action: "submit" }, "invalid"), f.env, { waitUntil: p => pending.push(p) })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await worker.fetch(f.request({ action: "submit" }), f.env, { waitUntil: p => pending.push(p) })).status, 403);
    assert.equal(calls, 1); assert.equal(pending.length, 0);
  } finally { globalThis.fetch = previous; }
});

for (const native of [false, true]) test((native ? "Native settle" : "background cron") + " runs the same current qualification without Owner confirmation or Drive writes", async t => {
  const f = await fixture({currentRegistration: true});t.mock.method(globalThis, "fetch", f.fetcher);
  if (native) {
    const response = await worker.fetch(new Request(origin + "/v1/storage/recovery", { method: "POST",
      headers: { origin, authorization: "Bearer owner-jwt", "content-type": "application/json" },
      body: JSON.stringify({ ...f.reference, action: "settle" }) }), f.env);
    assert.equal(response.status, 200);const result = await response.json();
    assert.equal(result.status, "resolved");assert.equal(result.resolution, "automatically_registered_current_state");
    assert.equal(result.receipt_id, f.receipt);assert.equal(result.source_receipt_id, f.source);assert.equal(result.automatic_recovery, "resolved");
  } else assert.deepEqual(await worker.runStorageRecoveryScheduled(f.env), { status: "ok", committed: 0, released: 0, reconciled: 1, attention: 0 });
  assert.equal(f.calls.filter(c => c.input.action === "registration_current_load").length, 1);
  assert.equal(f.calls.filter(c => c.input.action === "registration_current_commit").length, 1);
  assert.ok(f.calls.every(c => !Object.hasOwn(c.input, "confirmed")));
  assert.ok(f.google.length > 0);assert.ok(f.google.every(c => c.method === "GET" && c.body === undefined));
});
