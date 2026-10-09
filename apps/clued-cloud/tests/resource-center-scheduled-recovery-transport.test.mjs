import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const worker = await loadContinuityWorker();
const issuer = randomBytes(32).toString("base64url");
const reference = { connection_id: randomUUID(), job_id: randomUUID() };
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true",
  CLUED_STORAGE_EXECUTOR_V1: "true",
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
  CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
  CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }),
};

test("scheduled recovery remains read-only when disabled and fails closed on missing issuer", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected IO"); };
  try {
    for (const flag of ["CLUED_STORAGE_ACCOUNT_V1", "CLUED_STORAGE_GOOGLE_V1", "CLUED_STORAGE_JOBS_V2", "CLUED_STORAGE_EXECUTOR_V1"])
      assert.deepEqual(await worker.runStorageRecoveryScheduled({ ...env, [flag]: "false" }), { status: "disabled" });
    assert.deepEqual(await worker.runStorageRecoveryScheduled({ ...env, CLUED_STORAGE_CONNECTOR_ISSUER: undefined }),
      { status: "unavailable" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test("scheduled recovery uses the fixed issuer, bounded references and the original-job descriptor only", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  let jobs = [reference];
  let verified = false;
  let alreadyCommitted = false;
  globalThis.fetch = async (url, init) => {
    assert.ok(["/rest/v1/rpc/clued_storage_scheduled_recovery_v2",
      "/rest/v1/rpc/clued_storage_cloud_worker_router_v2"].some(path => String(url) === env.SUPABASE_URL + path));
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-worker-gateway");
    assert.equal(init.redirect, "manual");
    const input = JSON.parse(init.body);
    calls.push(input.p_input);
    assert.equal(input.p_issuer_hash, createHash("sha256").update(issuer).digest("hex"));
    if (String(url).endsWith("clued_storage_cloud_worker_router_v2")) {
      if (input.p_input.action === "settle_verified") return Response.json({ status: "committed", state: "committed",
        ...reference, final_result: { status: "committed" }, receipt_id: randomUUID(), execution_permitted: false });
      assert.equal(input.p_input.action, "verified_inspect");
      return Response.json(alreadyCommitted ? { status: "committed", ...reference, receipt_id: randomUUID(),
        execution_permitted: false } : verified ? { status: "verified", ...reference, verified_receipt_id: randomUUID(),
        verified_digest: "a".repeat(64), execution_permitted: false }
        : { status: "inspection_required", ...reference, execution_permitted: false });
    }
    if (input.p_input.action === "due") return Response.json({ status: "ok", jobs });
    assert.deepEqual(input.p_input, { ...reference, action: "load" });
    return Response.json({ status: "inspection_required", execution_permitted: false });
  };
  try {
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env),
      { status: "attention_required", committed: 0, released: 0, attention: 1 });
    assert.deepEqual(calls.map(call => call.action), ["due", "verified_inspect", "load"]);
    calls.length = 0; verified = true;
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "ok", committed: 1, released: 0, attention: 0 });
    assert.deepEqual(calls.map(call => call.action), ["due", "verified_inspect", "settle_verified"]);
    calls.length = 0; alreadyCommitted = true;
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "ok", committed: 1, released: 0, attention: 0 });
    assert.deepEqual(calls.map(call => call.action), ["due", "verified_inspect"]);
    calls.length = 0; jobs = Array.from({ length: 4 }, () => ({ connection_id: randomUUID(), job_id: randomUUID() }));
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "unavailable" });
    assert.deepEqual(calls.map(call => call.action), ["due"]);
    calls.length = 0; jobs = [{ ...reference, mutation: { operation: "create" } }];
    assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "unavailable" });
    assert.deepEqual(calls.map(call => call.action), ["due"]);
  } finally { globalThis.fetch = previous; }
});

// BUG-20261007-005: an attempted create on an account-policy connection whose
// token expired while the root was fenced. The run refreshes once through the
// recovery-only branch bound to this job, reloads the descriptor and, as Drive
// has neither the generated file nor a tagged one, settles it as not effected.
test("an expiring credential gets one job-bound recovery refresh, then an absent create is released", async () => {
  const { createStorageCredentialVault } = await import("../worker/storage-credential-vault.ts");
  const vault = await createStorageCredentialVault(JSON.parse(env.CLUED_STORAGE_VAULT_KEYS));
  const owner = randomUUID(), intent = randomUUID(), subject = "subject-1", fileId = "generatedFile0001";
  const refreshEnv = { ...env, CLUED_STORAGE_REFRESH_V1: "true", CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "fixture-client-secret-0001" };
  const context = version => ({ owner_id: owner, connection_id: reference.connection_id, provider: "google-drive",
    provider_subject: subject, oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID, credential_version: version });
  const scope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
  let credentialVersion = 4;
  let envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "expiring-access-token-01", scope,
    refresh_token: "fixture-refresh-token-0001", expires_at_ms: Date.now() + 5000 }), context(4));
  const descriptor = () => ({ status: "recovery_only", ...reference, owner_id: owner, intent_id: intent, provider: "google-drive",
    oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID, provider_subject: subject, credential_version: credentialVersion,
    credential_envelope: envelope, version: 2, request_sha256: "b".repeat(64), root_folder_id: "rootFolder000001",
    root_parent_id: "myDrive000000001", profile: { managed_root: "G:/My Drive/Clued_资料中心" },
    mutation: { operation: "create", target_kind: "file", destination_path: "G:/My Drive/Clued_资料中心/10_E/evidence.zip" },
    provider_before: { destination_parent_id: "trackFolder00001" },
    attempt: { provider_file_id: fileId, parent_id: "trackFolder00001", intent_id: intent,
      destination_path: "G:/My Drive/Clued_资料中心/10_E/evidence.zip" } });
  const rpcs = [], google = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === env.SUPABASE_URL) {
      const { p_issuer_hash: hash, p_input: input } = JSON.parse(init.body);
      assert.equal(hash, createHash("sha256").update(issuer).digest("hex"));
      const rpc = u.pathname.split("/").at(-1);
      rpcs.push([rpc, input.action, input]);
      if (rpc === "clued_storage_scheduled_recovery_v2")
        return Response.json(input.action === "due" ? { status: "ok", jobs: [reference] } : descriptor());
      if (rpc === "clued_storage_cloud_worker_router_v2")
        return Response.json({ status: "inspection_required", ...reference, execution_permitted: false });
      if (rpc === "clued_storage_refresh_worker_v1") {
        assert.equal(input.recovery_job_id, reference.job_id, "the refresh is bound to the job being recovered");
        if (input.action === "claim") return Response.json({ status: "acquired", attempt_id: input.attempt_id, connection_id: reference.connection_id,
          owner_id: owner, provider_subject: subject, oauth_client_id: env.CLUED_STORAGE_GOOGLE_CLIENT_ID, credential_version: credentialVersion,
          credential_envelope: envelope, expires_at: new Date(Date.now() + 120000).toISOString(),
          root_folder_id: "rootFolder000001", root_parent_id: "myDrive000000001" });
        assert.equal(input.action, "commit");
        envelope = input.credential_envelope; credentialVersion++;
        return Response.json({ status: "committed", receipt_id: randomUUID() });
      }
      assert.equal(rpc, "clued_storage_recovery_absent_v1");
      assert.equal(input.action, "settle_absent"); assert.equal(input.intent_id, intent);
      assert.deepEqual(input.proof, { contract: "clued.storage-create-absent/1", provider_file_id: fileId,
        parent_id: "trackFolder00001", intent_id: intent });
      return Response.json({ status: "committed", state: "cancelled", replayed: false, ...reference, intent_id: intent,
        receipt_id: randomUUID(), execution_permitted: false });
    }
    google.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (u.href === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "renewed-access-token-01",
      token_type: "Bearer", expires_in: 3600 });
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer renewed-access-token-01", "no Drive read with the expiring token");
    if (u.pathname === "/drive/v3/about") return Response.json({ user: { me: true, permissionId: subject } });
    if (u.pathname === "/drive/v3/files/rootFolder000001") return Response.json({ id: "rootFolder000001", parents: ["myDrive000000001"],
      mimeType: "application/vnd.google-apps.folder", trashed: false, isAppAuthorized: true, capabilities: { canAddChildren: true } });
    if (u.pathname === "/drive/v3/files") return Response.json({ files: [] });
    return Response.json({ error: { code: 404 } }, { status: 404 });
  };
  try {
    assert.deepEqual(await worker.runStorageRecoveryScheduled(refreshEnv), { status: "ok", committed: 0, released: 1, attention: 0 });
    assert.deepEqual(rpcs.map(([rpc, action]) => `${rpc}:${action}`), [
      "clued_storage_scheduled_recovery_v2:due", "clued_storage_cloud_worker_router_v2:verified_inspect",
      "clued_storage_scheduled_recovery_v2:load", "clued_storage_refresh_worker_v1:claim", "clued_storage_refresh_worker_v1:commit",
      "clued_storage_scheduled_recovery_v2:load", "clued_storage_recovery_absent_v1:settle_absent"]);
    assert.equal(google.filter(request => request.startsWith("POST")).length, 1, "one token request, no Drive write");
    assert.equal(credentialVersion, 5);
  } finally { globalThis.fetch = previous; }
});
