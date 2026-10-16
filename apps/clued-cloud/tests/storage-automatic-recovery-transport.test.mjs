import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid", token = "clued_bnd_" + "a".repeat(40);

async function fixture() {
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
  const calls = [], google = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === env.SUPABASE_URL) {
      const { p_input: input } = JSON.parse(init.body), rpc = u.pathname.split("/").at(-1); calls.push({ rpc, input });
      if (rpc === "clued_storage_jobs_router_v2") return Response.json({ status: "rejected", error_code: "storage_object_under_review" });
      if (rpc === "clued_storage_cloud_worker_router_v2") {
        assert.equal(input.action, "verified_inspect");
        return Response.json({ status: "inspection_required", ...reference, execution_permitted: false });
      }
      assert.equal(rpc, "clued_storage_scheduled_recovery_v2");
      if (input.action === "due") { assert.deepEqual(input, { action: "due" }); return Response.json({ status: "ok", jobs: [reference] }); }
      assert.equal(input.connection_id, reference.connection_id); assert.equal(input.job_id, reference.job_id);
      if (input.action === "load") return Response.json(descriptor);
      assert.equal(input.action, "reconcile_before");
      assert.equal(input.first_observation.observed_state, "before"); assert.equal(input.second_observation.observed_state, "before");
      return Response.json({ status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved", ...reference,
        intent_id: intent, source_receipt_id: source, base_version: 3, receipt_id: receipt, execution_permitted: false });
    }
    google.push({ path: u.pathname, method: init.method, body: init.body });
    assert.equal(u.origin, "https://www.googleapis.com"); assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    const current = { id: "file", name: "a.txt", parents: ["track"], version: "5", trashed: false, mimeType: "text/plain",
      size: "3", sha256Checksum: "a".repeat(64), headRevisionId: "rev1" };
    if (u.pathname === "/drive/v3/files/file") return Response.json(current);
    if (u.pathname === "/drive/v3/files/root") return Response.json(folder("root", "root", "drive"));
    assert.equal(u.pathname, "/drive/v3/files");
    return Response.json({ files: [u.searchParams.get("q").includes("name = 'track'") ? folder("track", "track", "root") : current] });
  };
  const request = (body, bearer = token) => new Request(origin + "/v1/storage/jobs", { method: "POST",
    headers: { origin, authorization: "Bearer " + bearer, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { reference, env, calls, google, fetcher, request };
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
