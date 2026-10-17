import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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

test("Native semantic recovery returns a complete accepted resolution without an Owner confirmation step", async t => {
  const origin = "https://clued.example.invalid", ref = { connection_id: randomUUID(), job_id: randomUUID() };
  const owner = randomUUID(), intent = randomUUID(), source = randomUUID(), receipt = randomUUID();
  const client = "native-semantic-client", calls = [], provider = [];
  const vaultConfig = { current_key_id: "test", keys: { test: randomBytes(32).toString("base64url") } };
  const context = { owner_id: owner, connection_id: ref.connection_id, provider: "google-drive",
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
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-native-semantic-access",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",
      expires_at_ms: Date.now() + 3600000 }), context) };
  const env = { SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "synthetic-public-key",
    CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true",
    CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40), CLUED_STORAGE_GOOGLE_CLIENT_ID: client,
    CLUED_STORAGE_VAULT_KEYS: JSON.stringify(vaultConfig) };
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
      assert.equal(rpc, "clued_storage_cloud_worker_router_v2");
      if (input.action === "verified_inspect") return Response.json({ ...ref, status: "inspection_required", execution_permitted: false });
      assert.equal(input.action, "semantic_settle");assert.equal(input.observation.second.provider_file_version, "99");
      return Response.json({ ...ref, intent_id: intent, status: "resolved", state: "conflict", receipt_id: receipt,
        source_receipt_id: source, base_version: 3, execution_permitted: false });
    }
    assert.equal(u.origin, "https://www.googleapis.com");assert.equal(init.method, "GET");assert.equal(init.body, undefined);
    provider.push(u.pathname);
    if (u.pathname.endsWith("/root")) return Response.json({ id: "root", name: "root", parents: ["drive"], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
    if (u.pathname.endsWith("/file")) return Response.json(current);
    assert.equal(u.pathname, "/drive/v3/files");return Response.json({ files: u.searchParams.get("q").includes("name = 'before.txt'") ? [current] : [], incompleteSearch: false });
  });
  const response = await worker.fetch(new Request(origin + "/v1/storage/recovery", { method: "POST",
    headers: { origin, authorization: "Bearer owner-jwt", "content-type": "application/json" }, body: JSON.stringify({ ...ref, action: "settle" }) }), env);
  assert.equal(response.status, 200);const value = await response.json();
  const accepted = storageRecoveryResolutionResult(value, ref);
  assert.equal(accepted.receipt_id, receipt);assert.equal(accepted.source_receipt_id, source);assert.equal(accepted.base_version, 3);
  assert.equal(accepted.automatic_recovery, "resolved");assert.ok(provider.length > 0);
  assert.deepEqual(calls.map(c => c.input.action), ["recovery_inspect", "verified_inspect", "recovery_load", "semantic_settle"]);
  assert.doesNotMatch(JSON.stringify(value), /credential_envelope|access_token|semantic_attempt|confirmed/);
});
