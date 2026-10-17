import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { build, stop } from "esbuild";
import { fileURLToPath } from "node:url";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
import { createStorageCredentialVault } from "../worker/storage-credential-vault.ts";
import { createGoogleDriveSemanticAttempt } from "../../../kernel/host/resource-center-google-drive-semantic-recovery.mjs";

const worker = await loadContinuityWorker();
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-recovery-diagnostics.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false });
const { storageRecoveryResolutionResult } = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
stop();

for (const expiredReader of [false, true]) test("Native semantic recovery resolves without confirmation" + (expiredReader ? " after renewing the actual replacement reader" : ""), async t => {
  const origin = "https://clued.example.invalid", ref = { connection_id: randomUUID(), job_id: randomUUID() };
  const owner = randomUUID(), intent = randomUUID(), source = randomUUID(), receipt = randomUUID();
  const client = "native-semantic-client", calls = [], provider = [];
  const vaultConfig = { current_key_id: "test", keys: { test: randomBytes(32).toString("base64url") } };
  const context = { owner_id: owner, connection_id: expiredReader ? randomUUID() : ref.connection_id, provider: "google-drive",
    provider_subject: "native-semantic-subject", oauth_client_id: client, credential_version: 1 };
  const vault = await createStorageCredentialVault(vaultConfig);
  const current = { id: "file", name: "before.txt", parents: ["root"], version: "99", trashed: false,
    explicitlyTrashed: false, mimeType: "text/plain", headRevisionId: "revision", sha256Checksum: "a".repeat(64) };
  const mutation = { operation: "rename", target_kind: "file", source_path: "/root/before.txt", destination_path: "/root/after.txt", source_file_version: "1" };
  const attempt = { contract: "clued.storage-modify-attempt/1", operation: "rename", intent_id: intent,
    provider_file_id: "file", parent_id: "root", source_parent_id: "root", source_path: mutation.source_path,
    destination_path: mutation.destination_path, source_file_version: "1" };
  const descriptor = { ...context, ...ref, status: "recovery_only", intent_id: intent, version: 3,
    request_sha256: "d".repeat(64), root_folder_id: "root", root_parent_id: "drive", profile: { managed_root: "/root" }, mutation, attempt,
    provider_before: { root_folder_id: "root", root_parent_id: "drive", source_parent_id: "root", destination_parent_id: "root",
      ancestors: [{ path: "/root", id: "root", parent_id: "drive", match: "access", value: "a".repeat(64) }] },
    semantic_recovery: { receipt_id: randomUUID(), no_effect_after_ms: 0,
      evidence: createGoogleDriveSemanticAttempt({ oauth_client_id: client, mutation, attempt, file: current }) },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-native-semantic-access", refresh_token: "synthetic-native-refresh-token",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",
      expires_at_ms: Date.now() + (expiredReader ? -60000 : 3600000) }), context) };
  if (expiredReader) descriptor.recovery_reader = { contract: "clued.storage-recovery-reader/1", connection_id: context.connection_id,
    credential_version: 1, connection_version: 1, auth_generation: 1, policy_id: randomUUID(), policy_generation: 1, scope_digest: "b".repeat(64), profile_version: 1 };
  const env = { SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key",
    CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true",
    CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40), CLUED_STORAGE_GOOGLE_CLIENT_ID: client,
    CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vaultConfig), CLUED_STORAGE_REFRESH_V1: "true", CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "synthetic-native-client-secret" };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === env.SUPABASE_URL) {
      if (u.pathname === "/auth/v1/user") return Response.json({ id: owner });
      const rpc = u.pathname.split("/").at(-1), input = JSON.parse(init.body).p_input;calls.push({ rpc, input });
      if (rpc === "clued_storage_native_recovery_v1") {
        assert.equal(input.action, "recovery_inspect");
        return Response.json({ ...ref, status: "conflict", request_digest: "d".repeat(64), intent_id: intent,
          receipt_id: source, automatic_recovery: "pending", review_available: false, execution_permitted: false });
      }
      if (rpc === "clued_storage_native_recovery_load_v2") return Response.json(descriptor);
      if (rpc === "clued_storage_scheduled_recovery_v2") {
        assert.equal(input.action, "report");assert.equal(input.diagnostic.reason, "CREDENTIAL_EXPIRING");
        return Response.json({ ...ref, status: "recorded", execution_permitted: false });
      }
      if (rpc === "clued_storage_refresh_worker_v1") {
        assert.equal(expiredReader, true);assert.equal(input.connection_id, context.connection_id);assert.equal(input.recovery_job_id, ref.job_id);
        if (input.action === "claim") return Response.json({ ...context, status: "acquired", attempt_id: input.attempt_id,
          root_folder_id: "root", root_parent_id: "drive", expires_at: new Date(Date.now() + 120000).toISOString(), credential_envelope: descriptor.credential_envelope });
        assert.equal(input.action, "commit");descriptor.credential_envelope = input.credential_envelope;descriptor.credential_version++;
        descriptor.recovery_reader.credential_version++;descriptor.recovery_reader.connection_version++;
        return Response.json({ status: "committed" });
      }
      assert.equal(rpc, "clued_storage_cloud_worker_router_v2");
      if (input.action === "verified_inspect") return Response.json({ ...ref, status: "inspection_required", execution_permitted: false });
      assert.equal(input.action, "semantic_settle");assert.equal(input.observation.second.provider_file_version, "99");
      return Response.json({ ...ref, intent_id: intent, status: "resolved", state: "conflict", receipt_id: receipt,
        source_receipt_id: source, base_version: 3, execution_permitted: false });
    }
    if (u.origin === "https://oauth2.googleapis.com") {
      assert.equal(expiredReader, true);assert.equal(init.method, "POST");provider.push("token-exchange");
      return Response.json({ access_token: "synthetic-native-renewed-token", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(u.origin, "https://www.googleapis.com");assert.equal(init.method ?? "GET", "GET");assert.equal(init.body, undefined);
    provider.push(u.pathname);
    if (u.pathname.endsWith("/about")) return Response.json({ user: { me: true, permissionId: context.provider_subject } });
    if (u.pathname.endsWith("/root")) return Response.json({ id: "root", name: "root", parents: ["drive"], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder", isAppAuthorized: true, capabilities: { canAddChildren: true } });
    if (u.pathname.endsWith("/file")) return Response.json(current);
    assert.equal(u.pathname, "/drive/v3/files");return Response.json({ files: u.searchParams.get("q").includes("name = 'before.txt'") ? [current] : [], incompleteSearch: false });
  });
  const response = await worker.fetch(new Request(origin + "/v1/storage/recovery", { method: "POST",
    headers: { origin, authorization: "Bearer owner-jwt", "content-type": "application/json" }, body: JSON.stringify({ ...ref, action: "settle" }) }), env);
  assert.equal(response.status, 200);const value = await response.json();
  const accepted = storageRecoveryResolutionResult(value, ref);
  assert.equal(accepted.receipt_id, receipt);assert.equal(accepted.source_receipt_id, source);assert.equal(accepted.base_version, 3);
  assert.equal(accepted.automatic_recovery, "resolved");assert.ok(provider.length > 0);
  assert.deepEqual(calls.map(c => c.input.action), expiredReader
    ? ["recovery_inspect", "verified_inspect", "recovery_load", "report", "claim", "commit", "recovery_inspect", "recovery_load", "semantic_settle"]
    : ["recovery_inspect", "verified_inspect", "recovery_load", "semantic_settle"]);
  assert.equal(provider.filter(path => path === "token-exchange").length, expiredReader ? 1 : 0);
  assert.ok(calls.filter(c => ["recovery_load", "semantic_settle"].includes(c.input.action)).every(c => c.input.connection_id === ref.connection_id && c.input.job_id === ref.job_id));
  assert.doesNotMatch(JSON.stringify(value), /credential_envelope|access_token|semantic_attempt|confirmed/);
});

for (const targetKind of ["file", "directory"]) for (const outcome of ["resolved", "wrong_receipt", "legacy_cancelled"])
test(`Native ${targetKind} create absence uses the original job and live read authority: ${outcome}`, async t => {
  const origin = "https://clued.example.invalid", ref = { connection_id: randomUUID(), job_id: randomUUID() };
  const owner = randomUUID(), intent = randomUUID(), source = randomUUID(), receipt = randomUUID();
  const client = "native-absence-client", calls = [], provider = [];
  const vaultConfig = { current_key_id: "test", keys: { test: randomBytes(32).toString("base64url") } };
  const context = { owner_id: owner, connection_id: randomUUID(), provider: "google-drive",
    provider_subject: "native-absence-subject", oauth_client_id: client, credential_version: 4 };
  const vault = await createStorageCredentialVault(vaultConfig);
  const mutation = { operation: "create", target_kind: targetKind, destination_path: "/root/missing" };
  const descriptor = { ...context, ...ref, status: "recovery_only", intent_id: intent, version: 3,
    request_sha256: "d".repeat(64), root_folder_id: "root", root_parent_id: "drive", profile: { managed_root: "/root" }, mutation,
    attempt: { provider_file_id: "missing", parent_id: "root", intent_id: intent, destination_path: mutation.destination_path },
    provider_before: { root_folder_id: "root", root_parent_id: "drive", root_folder_version: "1",
      destination_parent_id: "root", destination_parent_version: "1", destination_file_id: null, destination_file_version: null,
      provider_version: createHash("sha256").update(JSON.stringify([["root", "1"]])).digest("hex") },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-native-absence-access",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",
      expires_at_ms: Date.now() + 3600000 }), context) };
  if (outcome !== "legacy_cancelled") {
    descriptor.recovery_reader = { contract: "clued.storage-recovery-reader/1", connection_id: context.connection_id,
      credential_version: 4, connection_version: 2, auth_generation: 1, policy_id: randomUUID(), policy_generation: 1,
      scope_digest: "b".repeat(64), profile_version: 1 };
    descriptor.conflict_absence = { closed_version: 3, source_receipt_id: source };
  } else {
    // Legacy started/uncertain descriptors seal their original connection.
    descriptor.credential_envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-native-absence-access",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",
      expires_at_ms: Date.now() + 3600000 }), { ...context, connection_id: ref.connection_id });
  }
  const env = { SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key",
    CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true",
    CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40),
    CLUED_STORAGE_GOOGLE_CLIENT_ID: client, CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vaultConfig) };
  let settled = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === env.SUPABASE_URL) {
      if (u.pathname === "/auth/v1/user") return Response.json({ id: owner });
      const rpc = u.pathname.split("/").at(-1), input = JSON.parse(init.body).p_input;
      calls.push({ rpc, input });
      assert.equal(input.connection_id, ref.connection_id); assert.equal(input.job_id, ref.job_id);
      if (rpc === "clued_storage_native_recovery_v1") return Response.json({ ...ref,
        status: outcome === "legacy_cancelled" ? settled ? "cancelled" : "uncertain" : "conflict",
        request_digest: "d".repeat(64), intent_id: intent, receipt_id: settled && outcome === "legacy_cancelled" ? receipt : source,
        ...(outcome === "legacy_cancelled" ? {} : { automatic_recovery: "pending" }),
        review_available: false, execution_permitted: false });
      if (rpc === "clued_storage_native_recovery_load_v2") return Response.json(descriptor);
      if (rpc === "clued_storage_cloud_worker_router_v2") {
        assert.equal(input.action, "verified_inspect");
        return Response.json({ ...ref, status: "inspection_required", execution_permitted: false });
      }
      if (rpc === "clued_storage_scheduled_recovery_v2") {
        assert.equal(input.action, "report"); return Response.json({ ...ref, status: "recorded", execution_permitted: false });
      }
      assert.equal(rpc, "clued_storage_recovery_absent_v1"); assert.equal(input.action, "settle_absent");
      assert.equal(input.intent_id, intent); assert.equal(input.base_version, 3);
      assert.equal(input.proof.provider_file_id, "missing"); assert.equal(input.proof.parent_id, "root");
      if (outcome !== "legacy_cancelled") {
        assert.deepEqual(input.recovery_reader, descriptor.recovery_reader); assert.equal(input.credential_version, 4);
      }
      settled = true;
      return Response.json({ ...ref, intent_id: intent, receipt_id: receipt, execution_permitted: false,
        ...(outcome === "legacy_cancelled" ? { status: "committed", state: "cancelled" } : {
          status: "resolved", state: "conflict", resolution: "automatically_reconciled_before", automatic_recovery: "resolved",
          base_version: 3, source_receipt_id: outcome === "wrong_receipt" ? randomUUID() : source }) });
    }
    assert.equal(u.origin, "https://www.googleapis.com"); assert.equal(init.method ?? "GET", "GET"); assert.equal(init.body, undefined);
    provider.push({ path: u.pathname, q: u.searchParams.get("q") });
    if (u.pathname.endsWith("/about")) return Response.json({ user: { me: true, permissionId: context.provider_subject } });
    if (u.pathname.endsWith("/root")) return Response.json({ id: "root", name: "root", parents: ["drive"], version: "1",
      trashed: false, mimeType: "application/vnd.google-apps.folder" });
    if (u.pathname.endsWith("/missing")) return Response.json({ error: { code: 404 } }, { status: 404 });
    assert.equal(u.pathname, "/drive/v3/files"); return Response.json({ files: [], incompleteSearch: false });
  });
  const response = await worker.fetch(new Request(origin + "/v1/storage/recovery", { method: "POST",
    headers: { origin, authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ ...ref, action: "settle" }) }), env);
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(calls.filter(c => c.rpc === "clued_storage_recovery_absent_v1").length, 1, "no replay after any absence result");
  assert.ok(provider.some(c => c.path.endsWith("/missing")));
  assert.ok(provider.some(c => c.q?.startsWith("appProperties has")));
  if (outcome === "resolved") {
    const accepted = storageRecoveryResolutionResult(value, ref);
    assert.equal(accepted.receipt_id, receipt); assert.equal(accepted.source_receipt_id, source); assert.equal(accepted.base_version, 3);
  } else if (outcome === "legacy_cancelled") {
    assert.equal(value.status, "cancelled"); assert.equal(value.receipt_id, receipt);
    assert.equal(calls.filter(c => c.rpc === "clued_storage_native_recovery_v1").length, 2);
  } else {
    assert.equal(value.status, "attention_required"); assert.equal(value.outcome, "inspection_required"); assert.equal(value.receipt_id, source);
    assert.ok(value.diagnostic); assert.throws(() => storageRecoveryResolutionResult(value, ref));
  }
  assert.doesNotMatch(JSON.stringify(value), /credential_envelope|access_token|confirmed/);
});
