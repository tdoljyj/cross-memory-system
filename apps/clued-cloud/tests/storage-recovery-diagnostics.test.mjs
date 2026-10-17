import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "storage-recovery-diagnostic-"));
async function load(name) {
  const output = path.join(directory, `${name}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL(`../worker/${name}.ts`, import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(output));
}
const { createStorageCloudRecovery } = await load("storage-cloud-recovery");
const { recoveryDiagnostic, sanitizeRecoveryDiagnostic, storageRecoveryListResult } = await load("storage-recovery-diagnostics");
const { storageAgentResult } = await load("storage-agent-tools");
const { createStorageCredentialVault } = await load("storage-credential-vault");
const { createStorageRecoveryReview } = await load("storage-recovery-review");
stop();
const worker = await loadContinuityWorker();
const now = Date.parse("2026-10-16T10:00:00Z");
const reference = () => ({ connection_id: randomUUID(), job_id: randomUUID() });
const keys = () => ({ current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } });

test("automatic resolution exposes a distinct receipt and routine pending does not offer Owner settlement", () => {
  const ref = reference(), source = randomUUID(), receipt = randomUUID();
  const resolved = { ...ref, status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved",
    receipt_id: receipt, source_receipt_id: source, base_version: 3, execution_permitted: false };
  const listed = value => storageRecoveryListResult({ status: "ok", connection_id: ref.connection_id, execution_permitted: false, jobs: [value] }, ref.connection_id).jobs[0];
  assert.equal(listed(resolved).automatic_recovery, "resolved");assert.equal(listed(resolved).receipt_id, receipt);
  for (const invalid of [{ ...resolved, receipt_id: source }, { ...resolved, automatic_recovery: undefined }, { ...resolved, base_version: 0 }])
    assert.throws(() => listed(invalid), /storage_recovery_response_invalid/);
  const pending = listed({ ...ref, status: "conflict", receipt_id: source, execution_permitted: false, automatic_recovery: "pending", review_available: false, abandon_available: false });
  assert.equal(pending.automatic_recovery, "pending");assert.equal(pending.review_available, false);assert.equal(pending.abandon_available, false);
  const normal = storageAgentResult({ ...ref, status: "attention_required", request_digest: "a".repeat(64), intent_id: randomUUID(), receipt_id: source,
    reason_code: "PROVIDER_RESULT_RECONCILED", resolution: resolved.resolution, resolution_receipt_id: receipt, source_receipt_id: source, execution_permitted: false }, ref);
  assert.equal(normal.status, "attention_required");assert.equal(normal.resolution_receipt_id, receipt);assert.match(normal.hint, /not declared successful/);
});

test("current qualification has its own strict automatic resolution rather than old-operation success", () => {
  const ref = reference(), source = randomUUID(), receipt = randomUUID();
  const resolved = { ...ref, status: "resolved", resolution: "automatically_registered_current_state", automatic_recovery: "resolved",
    receipt_id: receipt, source_receipt_id: source, base_version: 7, execution_permitted: false };
  const listed = value => storageRecoveryListResult({ status: "ok", connection_id: ref.connection_id, execution_permitted: false, jobs: [value] }, ref.connection_id).jobs[0];
  assert.equal(listed(resolved).resolution, resolved.resolution);assert.equal(listed(resolved).review_available, false);
  for (const invalid of [{ ...resolved, receipt_id: source }, { ...resolved, automatic_recovery: undefined },
    { ...resolved, base_version: 0 }]) {
    assert.throws(() => listed(invalid), /storage_recovery_response_invalid/);
  }
  const normal = storageAgentResult({ ...ref, status: "attention_required", request_digest: "a".repeat(64), intent_id: randomUUID(), receipt_id: source,
    reason_code: "PROVIDER_RESULT_RECONCILED", resolution: resolved.resolution, resolution_receipt_id: receipt,
    source_receipt_id: source, execution_permitted: false }, ref);
  assert.equal(normal.status, "attention_required");assert.equal(normal.resolution, resolved.resolution);
  assert.match(normal.hint, /not declared successful/);
});

test("closed diagnostics preserve failure categories and never copy exception text", () => {
  for (const [message, reason] of [["DRIVE_POSTCONDITION_REVISION_UNCHANGED", "REVISION_UNCHANGED"],
    ["DRIVE_POSTCONDITION_CONTENT_MISMATCH", "CONTENT_MISMATCH"], ["DRIVE_METADATA_TIMEOUT", "PROVIDER_TIMEOUT"]]) {
    const d = recoveryDiagnostic("verification", new Error(message), now);
    assert.equal(d.reason, reason);
    assert.deepEqual(sanitizeRecoveryDiagnostic(d), d);
  }
  const d = recoveryDiagnostic("verified_record", new Error("secret provider response token-123"), now);
  assert.equal(d.reason, "VERIFIED_RECORD_UNCONFIRMED");
  assert.equal(d.automatic_next_action, "inspect_original_receipt");
  assert.doesNotMatch(JSON.stringify(d), /secret|token|provider response/);
  assert.equal(sanitizeRecoveryDiagnostic({ ...d, private_token: "secret" }), undefined);
  assert.equal(sanitizeRecoveryDiagnostic({ ...d, reason: "arbitrary server error" }), undefined);
  assert.equal(recoveryDiagnostic("descriptor", new Error("__proto__"), now).reason, "DESCRIPTOR_UNAVAILABLE");
});

test("a lost diagnostic write preserves the descriptor failure on the exact original job", async () => {
  const ref = reference(), reports = [], provider = [];
  const recovery = await createStorageCloudRecovery({ client_id: "fixture-client", vault: keys(), clock: () => now,
    rpc: async input => { assert.deepEqual(input, { ...ref, action: "recovery_load" }); throw Error("private SQL diagnostic"); },
    fetch: async input => { provider.push(input); assert.fail("no provider access without a valid descriptor"); },
    report_diagnostic: async (r, d) => { reports.push({ r, d }); throw Error("private lost report response"); } });
  const result = await recovery.run(ref);
  assert.equal(result.status, "inspection_required");
  assert.equal(result.job_id, ref.job_id);
  assert.equal(result.execution_permitted, false);
  assert.equal(result.diagnostic.stage, "descriptor");
  assert.equal(result.diagnostic.reason, "DESCRIPTOR_UNAVAILABLE");
  assert.deepEqual(reports, [{ r: ref, d: result.diagnostic }]);
  assert.equal(provider.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private|SQL|lost report/);
});

test("a stalled diagnostic adapter cannot hold the original recovery request indefinitely", async () => {
  const ref = reference(), start = Date.now();
  const recovery = await createStorageCloudRecovery({ client_id: "fixture-client", vault: keys(), timeout_ms: 25,
    rpc: async () => { throw Error("original descriptor unavailable"); }, report_diagnostic: async () => new Promise(() => {}) });
  const result = await recovery.run(ref);
  assert.equal(result.diagnostic.reason, "DESCRIPTOR_UNAVAILABLE");
  assert.ok(Date.now() - start < 1000);
  assert.equal(result.execution_permitted, false);
});

test("expiring original credentials are reported before metadata, without a new effect or delegation", async () => {
  const ref = reference(), vaultConfig = keys(), vault = await createStorageCredentialVault(vaultConfig), reports = [];
  const context = { owner_id: randomUUID(), connection_id: ref.connection_id, provider: "google-drive", provider_subject: "subject", oauth_client_id: "fixture-client", credential_version: 1 };
  const descriptor = { ...context, ...ref, status: "recovery_only", intent_id: randomUUID(), version: 2, request_sha256: "a".repeat(64),
    root_folder_id: "root", root_parent_id: "parent", profile: { managed_root: "/root" }, mutation: { operation: "create", destination_path: "/root/file" },
    provider_before: { destination_parent_id: "track" }, attempt: { provider_file_id: "file", parent_id: "track", destination_path: "/root/file" },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-expired-access", scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: now - 1000 }), context) };
  const recovery = await createStorageCloudRecovery({ client_id: "fixture-client", vault: vaultConfig, clock: () => now, report_expiring: true,
    verified: { descriptor, rpc: async () => assert.fail("no verification without metadata") }, rpc: async () => assert.fail("descriptor is pinned"),
    fetch: async () => assert.fail("no provider read with an expiring credential"), report_diagnostic: async (r, d) => reports.push({ r, d }) });
  const result = await recovery.run(ref);
  assert.equal(result.status, "credential_expiring");
  assert.equal(result.diagnostic.reason, "CREDENTIAL_EXPIRING");
  assert.equal(result.diagnostic.automatic_next_action, "check_existing_authorization");
  assert.deepEqual(reports, [{ r: ref, d: result.diagnostic }]);
});

async function replaceRecovery({ after = false, loseRecord = false, version = 2 } = {}) {
  const ref = reference(), vaultConfig = keys(), vault = await createStorageCredentialVault(vaultConfig), reports = [], calls = [], reads = [];
  const root = "G:/My Drive/Clued_资料中心", destination = root + "/track/a.txt", intent = randomUUID(), receipt = randomUUID();
  const hash = value => createHash("sha256").update(value).digest("hex"), old = { size: "3", sha256: hash("old"), md5: "c".repeat(32), head_revision_id: "rev-1" };
  const context = { owner_id: randomUUID(), connection_id: ref.connection_id, provider: "google-drive", provider_subject: "subject", oauth_client_id: "fixture-client", credential_version: 1 };
  const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
  const files = [folder("root", "Clued_资料中心", "parent"), folder("track", "track", "root"),
    { id: "file", name: "a.txt", parents: ["track"], version: after ? "7" : "5", trashed: false, mimeType: "text/plain",
      size: "3", sha256Checksum: after ? hash("new") : old.sha256, headRevisionId: after ? "rev-2" : "rev-1" }];
  const descriptor = { ...context, ...ref, status: "recovery_only", intent_id: intent, version, request_sha256: "a".repeat(64),
    root_folder_id: "root", root_parent_id: "parent", profile: { managed_root: root },
    mutation: { operation: "replace", target_kind: "file", destination_path: destination, destination_file_version: "5", content: "new", artifact_role: "clued_resource" },
    provider_before: { root_folder_id: "root", root_parent_id: "parent", root_folder_version: "1", destination_parent_id: "track", destination_parent_version: "1",
      destination_file_id: "file", destination_file_version: "5", provider_version: "b".repeat(64) },
    attempt: { contract: "clued.storage-replace-attempt/1", operation: "replace", provider_file_id: "file", parent_id: "track", destination_path: destination,
      destination_file_version: "5", content_before: old, content_after: { size: "3", sha256: hash("new") }, pinned_revision_id: "rev-1", previously_kept: false, release_revision_ids: [], restore_job_id: null },
    credential_envelope: await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-original-access", scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: Math.max(now, Date.now()) + 3600000 }), context) };
  const config = { client_id: "fixture-client", vault: vaultConfig, clock: () => now,
    rpc: async () => assert.fail("use the original pinned descriptor"), verified: { descriptor, rpc: async input => {
      calls.push(input);
      if (input.action === "verified_record") {
        if (loseRecord) throw Error("private lost recorded proof response");
        return { status: "verified", intent_id: intent, version, verified_receipt_id: randomUUID(), verified_digest: "d".repeat(64), execution_permitted: false };
      }
      assert.equal(input.action, "settle_verified");
      return { status: "committed", state: "committed", ...ref, intent_id: intent, receipt_id: receipt, final_result: { status: "committed" }, execution_permitted: false };
    } }, fetch: async (url, init) => {
      const u = new URL(String(url)); reads.push(u.pathname); assert.equal(init.method, "GET");
      if (u.pathname.endsWith("/revisions/rev-1")) return Response.json({ id: "rev-1", keepForever: true, size: old.size, md5Checksum: old.md5 });
      if (u.pathname === "/drive/v3/files") {
        const q = u.searchParams.get("q"), parent = /'([^']+)' in parents/.exec(q)?.[1], name = /name = '([^']+)'/.exec(q)?.[1];
        return Response.json({ files: files.filter(file => file.parents.includes(parent) && (!name || file.name === name)), incompleteSearch: false });
      }
      const file = files.find(file => u.pathname.endsWith("/" + file.id));
      assert.ok(file); return Response.json(file);
    }, report_diagnostic: async (r, d) => reports.push({ r, d }) };
  const recovery = await createStorageCloudRecovery(config);
  return { recovery, ref, receipt, calls, reads, reports, config, descriptor };
}

test("unchanged before metadata remains an exact-job failure, never proof of no effect or successful settlement", async () => {
  const f = await replaceRecovery(), result = await f.recovery.run(f.ref);
  assert.equal(result.status, "inspection_required"); assert.equal(result.diagnostic.reason, "REVISION_UNCHANGED");
  assert.equal(result.diagnostic.stage, "verification"); assert.equal(result.job_id, f.ref.job_id);
  assert.equal(f.calls.length, 0); assert.ok(f.reads.length > 0);
  assert.deepEqual(f.reports, [{ r: f.ref, d: result.diagnostic }]);
});

test("late expected after metadata resolves the original replace through verified record and settlement only", async () => {
  const f = await replaceRecovery({ after: true }), result = await f.recovery.run(f.ref);
  assert.deepEqual(result, { status: "committed", job_id: f.ref.job_id, receipt_id: f.receipt, execution_permitted: false });
  assert.deepEqual(f.calls.map(call => call.action), ["verified_record", "settle_verified"]);
  assert.ok(f.calls.every(call => call.job_id === f.ref.job_id && call.connection_id === f.ref.connection_id));
  assert.equal(f.reports.length, 0);
});

test("unknown proof-registration reply asks to inspect the original receipt and never repeats the effect", async () => {
  const f = await replaceRecovery({ after: true, loseRecord: true }), result = await f.recovery.run(f.ref);
  assert.equal(result.status, "inspection_required"); assert.equal(result.diagnostic.reason, "VERIFIED_RECORD_UNCONFIRMED");
  assert.equal(result.diagnostic.automatic_next_action, "inspect_original_receipt");
  assert.deepEqual(f.calls.map(call => call.action), ["verified_record"]);
  assert.doesNotMatch(JSON.stringify(result), /private lost/);
});

test("Owner recovery listing is bounded, scoped, and strips all private fields", () => {
  const ref = reference(), receipt = randomUUID();
  const raw = { status: "ok", connection_id: ref.connection_id, execution_permitted: false,
    jobs: [{ ...ref, receipt_id: receipt, status: "conflict", execution_permitted: false,
      diagnostic: { stage: "verification", reason: "UNKNOWN_EFFECT", observed_at: new Date(now).toISOString(), automatic_next_action: "continue_object_recovery" },
      credential_envelope: "private", provider_attempt: "private" }] };
  const result = storageRecoveryListResult(raw, ref.connection_id);
  assert.equal(result.jobs[0].status, "attention_required");
  assert.doesNotMatch(JSON.stringify(result), /private|credential|provider_attempt/);
  assert.throws(() => storageRecoveryListResult({ ...raw, jobs: [{ ...raw.jobs[0], connection_id: randomUUID() }] }, ref.connection_id));
  assert.throws(() => storageRecoveryListResult({ ...raw, jobs: [raw.jobs[0], raw.jobs[0]] }, ref.connection_id));
});

test("a validated current read context keeps predecessor job identities and rejects a substituted context", () => {
  const ref = reference(), context = randomUUID(), receipt = randomUUID();
  const job = { ...ref, read_connection_id: context, receipt_id: receipt, status: "conflict", execution_permitted: false };
  const list = value => storageRecoveryListResult({ status: "ok", connection_id: context, execution_permitted: false, jobs: [value] }, context);
  const projected = list(job).jobs[0];
  assert.equal(projected.connection_id, ref.connection_id); assert.equal(projected.read_connection_id, context);
  assert.equal(projected.job_id, ref.job_id); assert.equal(projected.receipt_id, receipt);
  for (const fields of [{ read_connection_id: randomUUID() }, { read_connection_id: undefined }, { connection_id: "not-a-connection" }])
    assert.throws(() => list({ ...job, ...fields }));
  const resolved = { ...job, status: "resolved", resolution: "automatically_reconciled_before", automatic_recovery: "resolved",
    receipt_id: randomUUID(), source_receipt_id: receipt, base_version: 3 };
  assert.equal(list(resolved).jobs[0].connection_id, ref.connection_id);
  assert.equal(list(resolved).jobs[0].read_connection_id, context);
});

test("incomplete identity exposes only a separately confirmed withdrawal and its exact CAS references", () => {
  const ref = reference(), receipt = randomUUID();
  const job = { ...ref, receipt_id: receipt, status: "conflict", execution_permitted: false, review_available: false,
    abandon_available: true, base_version: 3, source_receipt_id: receipt, file_name: "fixture.zip", credential_envelope: "private" };
  const list = jobs => storageRecoveryListResult({ status: "ok", connection_id: ref.connection_id, execution_permitted: false, jobs }, ref.connection_id);
  const projected = list([job]).jobs[0];
  assert.equal(projected.review_available, false); assert.equal(projected.abandon_available, true);
  assert.equal(projected.base_version, 3); assert.equal(projected.source_receipt_id, receipt); assert.equal(projected.file_name, "fixture.zip");
  assert.doesNotMatch(JSON.stringify(projected), /credential|private/);
  for (const fields of [{ base_version: 0 }, { source_receipt_id: "invalid" }, { abandon_available: "true" }]) assert.throws(() => list([{ ...job, ...fields }]));
});

function environment() {
  return { CLUED_DB_GATEWAY_TOKEN: "fixed-gateway", SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "publishable",
    CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_EXECUTOR_V1: "true",
    CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(40), CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture-client", CLUED_STORAGE_VAULT_KEYS: JSON.stringify(keys()) };
}

test("Owner list uses the existing authenticated connection RPC and never a provider or executor", async t => {
  const env = environment(), ref = reference(), owner = randomUUID(), receipt = randomUUID(), calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    assert.equal(u.origin, env.SUPABASE_URL);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer owner-jwt");
    if (u.pathname === "/auth/v1/user") return Response.json({ id: owner });
    assert.equal(u.pathname, "/rest/v1/rpc/clued_storage_native_recovery_v1");
    const input = JSON.parse(init.body).p_input; calls.push(input);
    assert.deepEqual(input, { action: "recovery_list", connection_id: ref.connection_id });
    return Response.json({ status: "ok", connection_id: ref.connection_id, execution_permitted: false,
      jobs: [{ ...ref, status: "started", receipt_id: receipt, execution_permitted: false, private: "not public" }] });
  });
  const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ action: "list", connection_id: ref.connection_id }) }), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.jobs, [{ ...ref, status: "started", receipt_id: receipt, execution_permitted: false }]);
  assert.equal(calls.length, 1);
});

test("scheduled recovery records a load failure against the exact old job and never dispatches a new effect", async t => {
  const env = environment(), ref = reference(), calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, env.SUPABASE_URL);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixed-gateway");
    const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); calls.push({ name, input });
    if (name === "clued_storage_cloud_worker_router_v2") {
      assert.deepEqual(input, { ...ref, action: "verified_inspect" });
      return Response.json({ ...ref, status: "inspection_required", execution_permitted: false });
    }
    assert.equal(name, "clued_storage_scheduled_recovery_v2");
    if (input.action === "due") return Response.json({ status: "ok", jobs: [ref] });
    if (input.action === "load") return Response.json({ status: "private_descriptor_error" }, { status: 503 });
    assert.equal(input.action, "report");
    assert.equal(input.connection_id, ref.connection_id); assert.equal(input.job_id, ref.job_id);
    assert.equal(input.diagnostic.reason, "DESCRIPTOR_UNAVAILABLE");
    return Response.json({ ...ref, status: "recorded", execution_permitted: false });
  });
  assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "attention_required", committed: 0, released: 0, attention: 1 });
  assert.equal(calls.filter(c => c.input.action === "report").length, 1);
  assert.deepEqual(calls.map(c => c.input.action), ["due", "verified_inspect", "load", "report"]);
});

test("scheduled recovery continues a quarantined original job at its current version and settles late after metadata without replay", async t => {
  const f = await replaceRecovery({ after: true, version: 3 }), env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === "https://www.googleapis.com") return f.config.fetch(url, init);
    assert.equal(u.origin, env.SUPABASE_URL);
    const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); calls.push(input.action);
    if (name === "clued_storage_scheduled_recovery_v2") {
      if (input.action === "due") return Response.json({ status: "ok", jobs: [f.ref] });
      assert.deepEqual(input, { ...f.ref, action: "load" });
      return Response.json(f.descriptor);
    }
    assert.equal(name, "clued_storage_cloud_worker_router_v2");
    if (input.action === "verified_inspect") return Response.json({ ...f.ref, status: "inspection_required", execution_permitted: false });
    assert.equal(input.base_version ?? input.finish?.base_version, 3, "proof binds the current conflict version");
    return Response.json(await f.config.verified.rpc(input));
  });
  assert.deepEqual(await worker.runStorageRecoveryScheduled(env), { status: "ok", committed: 1, released: 0, attention: 0 });
  assert.deepEqual(calls, ["due", "verified_inspect", "load", "verified_record", "settle_verified"]);
  assert.ok(f.reads.length > 0);
  assert.ok(f.calls.every(call => call.connection_id === f.ref.connection_id && call.job_id === f.ref.job_id));
});

test("Owner recovery continues the original quarantined conflict through the exact native descriptor and verified path", async t => {
  const f = await replaceRecovery({ after: true, version: 3 }), env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === "https://www.googleapis.com") return f.config.fetch(url, init);
    assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: f.descriptor.owner_id });
    const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); calls.push(input.action);
    if (name === "clued_storage_native_recovery_v1") return Response.json({ ...f.ref, status: "conflict", request_digest: "a".repeat(64),
      intent_id: f.descriptor.intent_id, receipt_id: randomUUID(), execution_permitted: false, reason_code: "PROVIDER_STATE_CONFLICT" });
    if (name === "clued_storage_native_recovery_load_v2") return Response.json(f.descriptor);
    assert.equal(name, "clued_storage_cloud_worker_router_v2");
    if (input.action === "verified_inspect") return Response.json({ ...f.ref, status: "inspection_required", execution_permitted: false });
    return Response.json(await f.config.verified.rpc(input));
  });
  const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ action: "settle", ...f.ref }) }), env);
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.status, "committed"); assert.equal(result.receipt_id, f.receipt);
  assert.deepEqual(calls, ["recovery_inspect", "verified_inspect", "recovery_load", "verified_record", "settle_verified"]);
  assert.ok(f.calls.every(call => (call.base_version ?? call.finish?.base_version) === 3));
});

test("Owner settle preserves the old receipt and diagnostic after an unknown descriptor reply", async t => {
  const env = environment(), ref = reference(), receipt = randomUUID(), intent = randomUUID(), owner = randomUUID(), calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: owner });
    const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); calls.push({ name, input });
    if (name === "clued_storage_native_recovery_v1") return Response.json({ ...ref, status: "started", request_digest: "a".repeat(64), intent_id: intent, receipt_id: receipt, execution_permitted: false });
    if (name === "clued_storage_cloud_worker_router_v2") return Response.json({ ...ref, status: "inspection_required", execution_permitted: false });
    if (name === "clued_storage_native_recovery_load_v2") return Response.json({ private: "never exposed" }, { status: 503 });
    assert.equal(name, "clued_storage_scheduled_recovery_v2"); assert.equal(input.action, "report");
    return Response.json({ ...ref, status: "recorded", execution_permitted: false });
  });
  const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ action: "settle", ...ref }) }), env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "started"); assert.equal(result.outcome, "inspection_required"); assert.equal(result.job_id, ref.job_id); assert.equal(result.receipt_id, receipt);
  assert.equal(result.diagnostic.reason, "DESCRIPTOR_UNAVAILABLE"); assert.equal(result.execution_permitted, false);
  assert.equal(calls.filter(c => c.input.action === "recovery_inspect").length, 2, "inspect the original once after the failure");
  assert.equal(calls.filter(c => c.input.action === "report").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|never exposed/);
});

test("a lost settlement response is resolved by inspecting the same original job once, never by resubmitting", async t => {
  const env = environment(), ref = reference(), oldReceipt = randomUUID(), finalReceipt = randomUUID(), intent = randomUUID(), owner = randomUUID(), calls = [];
  let inspections = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: owner });
    const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); calls.push(input.action);
    if (name === "clued_storage_native_recovery_v1") {
      inspections++;
      return Response.json({ ...ref, status: inspections === 1 ? "started" : "committed", request_digest: "a".repeat(64), intent_id: intent,
        receipt_id: inspections === 1 ? oldReceipt : finalReceipt, execution_permitted: false });
    }
    if (name === "clued_storage_scheduled_recovery_v2") {
      assert.equal(input.action, "report"); assert.equal(input.diagnostic.stage, "settlement");
      assert.equal(input.diagnostic.reason, "SETTLEMENT_UNCONFIRMED");
      return Response.json({ ...ref, status: "recorded", execution_permitted: false });
    }
    assert.equal(name, "clued_storage_cloud_worker_router_v2");
    if (input.action === "verified_inspect") return Response.json({ ...ref, status: "verified", verified_receipt_id: randomUUID(), verified_digest: "e".repeat(64), execution_permitted: false });
    assert.equal(input.action, "settle_verified"); return Response.json({ private: "lost committed response" }, { status: 503 });
  });
  const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ action: "settle", ...ref }) }), env);
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.status, "committed"); assert.equal(result.receipt_id, finalReceipt);
  assert.deepEqual(calls, ["recovery_inspect", "verified_inspect", "settle_verified", "report", "recovery_inspect"]);
});

async function reviewFixture(options = {}) {
  const f = await replaceRecovery({ version: 3, after: options.after }), source = randomUUID(), observationId = randomUUID(), observations = [], gets = [];
  const descriptor = structuredClone(f.descriptor);
  if (options.expiring) {
    const vault = await createStorageCredentialVault(f.config.vault);
    descriptor.credential_envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-original-access",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: now + 59999 }),
    { owner_id: descriptor.owner_id, connection_id: f.ref.connection_id, provider: "google-drive", provider_subject: descriptor.provider_subject,
      oauth_client_id: "fixture-client", credential_version: 1 });
  }
  let targetReads = 0;
  const review = await createStorageRecoveryReview({ client_id: "fixture-client", vault: f.config.vault, descriptor, source_receipt_id: source, clock: () => now,
    fetch: async (url, init) => {
      const u = new URL(String(url)); gets.push({ url: String(url), method: init.method });
      if (u.pathname === "/drive/v3/files/file") {
        targetReads++;
        if (options.targetStatus) return new Response("{}", { status: options.targetStatus });
        const response = await f.config.fetch(url, init), value = await response.json();
        if (options.unstable && targetReads > 1) value.version = "8";
        return Response.json(value);
      }
      if (options.targetStatus === 404 && u.searchParams.get("q")?.includes("name = 'a.txt'")) return Response.json({ files: [], incompleteSearch: false });
      return f.config.fetch(url, init);
    }, rpc: async input => {
      observations.push(input);
      return { status: "review_prepared", connection_id: f.ref.connection_id, job_id: f.ref.job_id, observation_id: observationId,
        base_version: 3, source_receipt_id: source, observed_at: input.observation.observed_at,
        observed_state: input.observation.observed_state, execution_permitted: false };
    } });
  return { ...f, review, descriptor, source, observationId, observations, gets };
}

test("Owner review prepares two stable real GET observations of the original before file without declaring replace success", async () => {
  const f = await reviewFixture(), result = await f.review.prepare(f.ref);
  assert.equal(result.status, "review_prepared"); assert.equal(result.observed_state, "before");
  assert.equal(result.file_name, "a.txt"); assert.equal(result.provider_file_id, "file"); assert.equal(result.provider_file_version, "5");
  assert.equal(result.base_version, 3); assert.equal(result.source_receipt_id, f.source); assert.equal(result.execution_permitted, false);
  assert.equal(f.gets.filter(get => new URL(get.url).pathname === "/drive/v3/files/file").length, 2);
  assert.ok(f.gets.every(get => get.method === "GET")); assert.equal(f.calls.length, 0);
  assert.equal(f.observations.length, 1); const input = f.observations[0];
  assert.equal(input.action, "review_observe"); assert.equal(input.job_id, f.ref.job_id); assert.equal(input.source_receipt_id, f.source);
  assert.deepEqual(Object.keys(input.observation).sort(), ["head_revision_id", "mime_type", "name", "observed_at", "observed_state", "parent_id", "provider_file_id", "provider_file_version", "sha256", "size", "trashed"]);
  assert.equal(f.observations[0].observation.observed_state, "before");
});

test("a truly absent original ID and empty exact name slot can prepare absence, while 403 and unstable metadata cannot", async () => {
  const absent = await reviewFixture({ targetStatus: 404 }), result = await absent.review.prepare(absent.ref);
  assert.equal(result.observed_state, "absent"); assert.equal(result.file_name, "a.txt");
  for (const key of ["provider_file_version", "mime_type", "size", "sha256"]) assert.equal(result[key], null);
  for (const options of [{ targetStatus: 403 }, { unstable: true }, { expiring: true }]) {
    const f = await reviewFixture(options);
    await assert.rejects(f.review.prepare(f.ref)); assert.equal(f.observations.length, 0);
    if (options.expiring) assert.equal(f.gets.length, 0, "the sixty-second credential floor is checked before any GET");
  }
});

test("Owner review_prepare route uses only same-Owner private metadata and never trusts browser observations", async t => {
  const f = await reviewFixture(), env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, nativeCalls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === "https://www.googleapis.com") return f.config.fetch(url, init);
    assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: f.descriptor.owner_id });
    const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); nativeCalls.push(input);
    if (name === "clued_storage_native_recovery_v1") return Response.json({ ...f.ref, status: "conflict", request_digest: "a".repeat(64),
      intent_id: f.descriptor.intent_id, receipt_id: f.source, execution_permitted: false, reason_code: "PROVIDER_STATE_CONFLICT",
      review_available: true, base_version: 3, source_receipt_id: f.source, file_name: "a.txt" });
    if (name === "clued_storage_native_recovery_load_v2") return Response.json(f.descriptor);
    assert.equal(name, "clued_storage_scheduled_recovery_v2"); assert.equal(input.action, "review_observe");
    return Response.json({ status: "review_prepared", ...f.ref, observation_id: f.observationId, base_version: 3, source_receipt_id: f.source,
      observed_at: input.observation.observed_at, observed_state: input.observation.observed_state, execution_permitted: false });
  });
  const request = extra => new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ action: "review_prepare", ...f.ref, ...extra }) });
  const response = await worker.fetch(request({}), env), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.observed_state, "before"); assert.equal(result.file_name, "a.txt");
  assert.equal(nativeCalls.filter(input => input.action === "review_observe").length, 1);
  nativeCalls.length = 0;
  const forged = await worker.fetch(request({ observation: { observed_state: "after" } }), env);
  assert.equal(forged.status, 403); assert.equal(nativeCalls.length, 0);
});

test("Owner acceptance forwards only observation CAS references, restores current registration without a replacement-success claim", async t => {
  const f = await reviewFixture(), env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, ref = f.ref,
    source = f.source, observation = f.observationId, receipt = randomUUID(), intent = f.descriptor.intent_id, inputs = [];
  const body = { action: "review_accept", ...ref, source_receipt_id: source, base_version: 3, observation_id: observation, confirmed: true };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url)); if (u.origin === "https://www.googleapis.com") return f.config.fetch(url, init);
    assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: randomUUID() });
    const input = JSON.parse(init.body).p_input; inputs.push(input);
    if (input.action === "recovery_load") return Response.json(f.descriptor);
    if (input.action === "review_revalidate") return Response.json({ status: "review_revalidated", ...ref, observation_id: observation,
      base_version: 3, source_receipt_id: source, execution_permitted: false });
    if (input.action === "recovery_inspect") return Response.json({ ...ref, status: "conflict", intent_id: intent, request_digest: "a".repeat(64),
      receipt_id: source, execution_permitted: false, review_available: true, base_version: 3, source_receipt_id: source, file_name: "a.txt" });
    assert.deepEqual(input, body);
    return Response.json({ status: "resolved", resolution: "accepted_current_state", ...ref, receipt_id: receipt, base_version: 3,
      source_receipt_id: source, observation_id: observation, execution_permitted: false });
  });
  const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.status, "resolved"); assert.equal(result.resolution, "accepted_current_state");
  assert.notEqual(result.status, "committed"); assert.equal(result.receipt_id, receipt); assert.equal(result.execution_permitted, false);
  assert.deepEqual(inputs.map(input => input.action), ["recovery_inspect", "recovery_load", "review_revalidate", "review_accept"]);
});

test("expired or stale review observations cannot commit; switched accounts never reach accept", async t => {
  for (const mode of ["expired", "stale", "CAS_race", "account_switched"]) {
    const f = await reviewFixture(), env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, ref = f.ref,
      source = f.source, observation = f.observationId, inputs = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const u = new URL(String(url)); if (u.origin === "https://www.googleapis.com") return f.config.fetch(url, init);
      assert.equal(u.origin, env.SUPABASE_URL);
      if (u.pathname === "/auth/v1/user") return Response.json({ id: randomUUID() });
      const input = JSON.parse(init.body).p_input; inputs.push(input);
      if (input.action === "recovery_inspect") {
        if (mode === "account_switched") return Response.json({ code: "42501", message: "private account detail" }, { status: 403 });
        return Response.json({ ...ref, status: "conflict", intent_id: f.descriptor.intent_id, request_digest: "a".repeat(64), receipt_id: source,
          execution_permitted: false, review_available: true, base_version: mode === "stale" ? 4 : 3, source_receipt_id: source, file_name: "a.txt" });
      }
      if (input.action === "recovery_load") return Response.json(f.descriptor);
      if (input.action === "review_revalidate") {
        if (mode === "expired") return Response.json({ code: "40001", message: "private expired" }, { status: 409 });
        return Response.json({ status: "review_revalidated", ...ref, observation_id: observation, base_version: 3, source_receipt_id: source, execution_permitted: false });
      }
      assert.equal(input.action, "review_accept"); return Response.json({ code: "40001", message: "private " + mode }, { status: 409 });
    });
    const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
      headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
      body: JSON.stringify({ action: "review_accept", ...ref, base_version: 3, source_receipt_id: source, observation_id: observation, confirmed: true }) }), env);
    const result = await response.json();
    assert.notEqual(result.status, "resolved"); assert.equal(result.execution_permitted, false); assert.doesNotMatch(JSON.stringify(result), /private/);
    assert.equal(inputs.filter(input => input.action === "review_accept").length, mode === "CAS_race" ? 1 : 0);
    if (mode !== "account_switched") assert.equal(result.review_error, "REVIEW_REFRESH_REQUIRED");
    t.mock.restoreAll();
  }
});

test("unknown acceptance is recovered only from the original matching source, observation and action receipt", async t => {
  for (const matches of [true, false]) {
    const f = await reviewFixture(), env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, ref = f.ref,
      source = f.source, observation = f.observationId, receipt = randomUUID(), inputs = [];
    let inspect = 0;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const u = new URL(String(url)); if (u.origin === "https://www.googleapis.com") return f.config.fetch(url, init);
      assert.equal(u.origin, env.SUPABASE_URL);
      if (u.pathname === "/auth/v1/user") return Response.json({ id: randomUUID() });
      const input = JSON.parse(init.body).p_input; inputs.push(input);
      if (input.action === "recovery_inspect") {
        if (++inspect === 1) return Response.json({ ...ref, status: "conflict", request_digest: "a".repeat(64), intent_id: f.descriptor.intent_id,
          receipt_id: source, execution_permitted: false, review_available: true, base_version: 3, source_receipt_id: source, file_name: "a.txt" });
        return Response.json({ ...ref, status: "resolved", resolution: "accepted_current_state", source_receipt_id: source, base_version: 3,
          observation_id: matches ? observation : randomUUID(), receipt_id: receipt, execution_permitted: false });
      }
      if (input.action === "recovery_load") return Response.json(f.descriptor);
      if (input.action === "review_revalidate") return Response.json({ status: "review_revalidated", ...ref, observation_id: observation,
        base_version: 3, source_receipt_id: source, execution_permitted: false });
      assert.equal(input.action, "review_accept"); return Response.json({ private: "lost reply" }, { status: 503 });
    });
    const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
      headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
      body: JSON.stringify({ action: "review_accept", ...ref, base_version: 3, source_receipt_id: source, observation_id: observation, confirmed: true }) }), env);
    const result = await response.json();
    assert.equal(result.status, matches ? "resolved" : "attention_required");
    if (matches) assert.equal(result.receipt_id, receipt);
    else assert.equal(result.review_error, "REVIEW_COMPLETION_UNKNOWN");
    assert.deepEqual(inputs.map(input => input.action), ["recovery_inspect", "recovery_load", "review_revalidate", "review_accept", "recovery_inspect"]);
    t.mock.restoreAll();
  }
});

test("Owner abandonment is a separate confirmed CAS action and rejects browser metadata or a missing confirmation", async t => {
  const env = environment(), ref = reference(), source = randomUUID(), receipt = randomUUID(), inputs = [];
  delete env.CLUED_STORAGE_VAULT_KEYS;
  const body = { action: "review_abandon", ...ref, source_receipt_id: source, base_version: 3, confirmed: true };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: randomUUID() });
    const input = JSON.parse(init.body).p_input; inputs.push(input);
    if (input.action === "recovery_inspect") return Response.json({ ...ref, status: "conflict", intent_id: randomUUID(), request_digest: "a".repeat(64),
      receipt_id: source, execution_permitted: false, review_available: false, abandon_available: true, base_version: 3, source_receipt_id: source, file_name: "fixture.zip" });
    assert.deepEqual(input, body);
    return Response.json({ status: "resolved", resolution: "abandoned_registration", ...ref, receipt_id: receipt, base_version: 3,
      source_receipt_id: source, observation_id: null, execution_permitted: false });
  });
  const request = extra => new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" }, body: JSON.stringify({ ...body, ...extra }) });
  const result = await (await worker.fetch(request({}), env)).json();
  assert.equal(result.status, "resolved"); assert.equal(result.resolution, "abandoned_registration"); assert.equal(result.receipt_id, receipt);
  assert.deepEqual(inputs.map(input => input.action), ["recovery_inspect", "review_abandon"]);
  inputs.length = 0;
  for (const extra of [{ confirmed: false }, { observation: { observed_state: "before" } }, { action: "abandon" }]) {
    assert.equal((await worker.fetch(request(extra), env)).status, 403);
    assert.equal(inputs.length, 0);
  }
});

test("a Drive edit after preview is freshly observed and refuses acceptance of the old preview", async t => {
  const f = await reviewFixture(); await f.review.prepare(f.ref);
  const original = f.observations[0].observation, env = { ...environment(), CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, inputs = [], reads = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const u = new URL(String(url));
    if (u.origin === "https://www.googleapis.com") {
      assert.equal(init.method, "GET"); reads.push(u.pathname);
      const response = await f.config.fetch(url, init);
      if (u.pathname !== "/drive/v3/files/file") return response;
      return Response.json({ ...await response.json(), version: "8", sha256Checksum: "e".repeat(64), headRevisionId: "rev-external" });
    }
    assert.equal(u.origin, env.SUPABASE_URL);
    if (u.pathname === "/auth/v1/user") return Response.json({ id: f.descriptor.owner_id });
    const input = JSON.parse(init.body).p_input; inputs.push(input);
    if (input.action === "recovery_inspect") return Response.json({ ...f.ref, status: "conflict", request_digest: "a".repeat(64),
      intent_id: f.descriptor.intent_id, receipt_id: f.source, execution_permitted: false,
      review_available: true, base_version: 3, source_receipt_id: f.source, file_name: "a.txt" });
    if (input.action === "recovery_load") return Response.json(f.descriptor);
    assert.equal(input.action, "review_revalidate"); assert.equal(input.observation.provider_file_version, "8");
    const semantic = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "observed_at"));
    assert.notDeepEqual(semantic(input.observation), semantic(original));
    return Response.json({ code: "40001", message: "private changed observation" }, { status: 409 });
  });
  const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
    headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
    body: JSON.stringify({ action: "review_accept", ...f.ref, source_receipt_id: f.source, base_version: 3, observation_id: f.observationId, confirmed: true }) }), env);
  const result = await response.json();
  assert.equal(result.review_error, "REVIEW_REFRESH_REQUIRED"); assert.notEqual(result.status, "resolved");
  assert.equal(inputs.filter(input => input.action === "review_accept").length, 0);
  assert.equal(reads.filter(path => path === "/drive/v3/files/file").length, 2);
});

test("existing delegation refreshes the same quarantined job once, reloads Owner and descriptor, then resumes preview or settlement", async t => {
  for (const action of ["review_prepare", "settle"]) {
    const f = await reviewFixture({ after: action === "settle" }), vault = await createStorageCredentialVault(f.config.vault);
    const context = { owner_id: f.descriptor.owner_id, connection_id: f.ref.connection_id, provider: "google-drive", provider_subject: f.descriptor.provider_subject,
      oauth_client_id: "fixture-client", credential_version: 1 };
    let envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-expiring-access", refresh_token: "synthetic-original-refresh-token",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: Date.now() - 1000 }), context), version = 1;
    const env = { ...environment(), CLUED_STORAGE_REFRESH_V1: "true", CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "synthetic-original-client-secret", CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) };
    const inputs = [], provider = [];
    t.mock.method(globalThis, "fetch", async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.origin === env.SUPABASE_URL) {
        if (u.pathname === "/auth/v1/user") return Response.json({ id: f.descriptor.owner_id });
        const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); inputs.push({ name, input });
        if (name === "clued_storage_native_recovery_v1") return Response.json({ ...f.ref, status: "conflict", request_digest: "a".repeat(64),
          intent_id: f.descriptor.intent_id, receipt_id: f.source, execution_permitted: false,
          review_available: true, base_version: 3, source_receipt_id: f.source, file_name: "a.txt" });
        if (name === "clued_storage_native_recovery_load_v2") return Response.json({ ...f.descriptor, credential_version: version, credential_envelope: envelope });
        if (name === "clued_storage_refresh_worker_v1") {
          assert.equal(input.recovery_job_id, f.ref.job_id);
          if (input.action === "claim") return Response.json({ ...context, status: "acquired", attempt_id: input.attempt_id, credential_envelope: envelope,
            root_folder_id: "root", root_parent_id: "parent", expires_at: new Date(Date.now() + 120000).toISOString() });
          assert.equal(input.action, "commit"); envelope = input.credential_envelope; version = 2;
          return Response.json({ status: "committed" });
        }
        if (name === "clued_storage_cloud_worker_router_v2") {
          if (input.action === "verified_inspect") return Response.json({ ...f.ref, status: "inspection_required", execution_permitted: false });
          return Response.json(await f.config.verified.rpc(input));
        }
        assert.equal(name, "clued_storage_scheduled_recovery_v2");
        if (input.action === "report") return Response.json({ status: "recorded", ...f.ref, execution_permitted: false });
        assert.equal(input.action, "review_observe");
        return Response.json({ status: "review_prepared", ...f.ref, observation_id: f.observationId, source_receipt_id: f.source, base_version: 3,
          observed_at: input.observation.observed_at, observed_state: input.observation.observed_state, execution_permitted: false });
      }
      provider.push({ path: u.pathname, method: init.method ?? "GET" });
      if (u.origin === "https://oauth2.googleapis.com") return Response.json({ token_type: "Bearer", access_token: "synthetic-renewed-access-token", expires_in: 3600 });
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-renewed-access-token");
      if (u.pathname === "/drive/v3/about") return Response.json({ user: { me: true, permissionId: context.provider_subject } });
      const response = await f.config.fetch(url, { ...init, method: "GET" });
      if (u.pathname === "/drive/v3/files/root" && u.searchParams.get("fields")?.includes("capabilities")) return Response.json({ ...await response.json(), isAppAuthorized: true, capabilities: { canAddChildren: true } });
      return response;
    });
    const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
      headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" },
      body: JSON.stringify({ action, ...f.ref }) }), env);
    const result = await response.json();
    assert.equal(result.status, action === "settle" ? "committed" : "review_prepared");
    assert.equal(inputs.filter(call => call.input.action === "recovery_load").length, 2);
    assert.equal(inputs.filter(call => call.input.action === "recovery_inspect").length, 2);
    assert.equal(inputs.filter(call => call.name === "clued_storage_refresh_worker_v1" && call.input.action === "claim").length, 1);
    assert.equal(provider.filter(call => call.method === "POST").length, 1, "one token exchange, never a Drive write");
    assert.ok(provider.filter(call => call.path.startsWith("/drive/")).every(call => call.method === "GET"));
    assert.ok(provider.filter(call => call.path === "/drive/v3/files/file").length >= 2);
    t.mock.restoreAll();
  }
});

test("disabled or stopped renewal never exchanges a token or enables a delegation for Owner preview", async t => {
  for (const enabled of [false, true]) {
    const f = await reviewFixture(), vault = await createStorageCredentialVault(f.config.vault);
    const envelope = await vault.seal(JSON.stringify({ token_type: "Bearer", access_token: "synthetic-expiring-access", refresh_token: "synthetic-original-refresh-token",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly", expires_at_ms: Date.now() - 1000 }),
    { owner_id: f.descriptor.owner_id, connection_id: f.ref.connection_id, provider: "google-drive", provider_subject: f.descriptor.provider_subject, oauth_client_id: "fixture-client", credential_version: 1 });
    const env = { ...environment(), CLUED_STORAGE_REFRESH_V1: String(enabled), CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "synthetic-original-client-secret", CLUED_STORAGE_VAULT_KEYS: JSON.stringify(f.config.vault) }, actions = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const u = new URL(String(url)); assert.equal(u.origin, env.SUPABASE_URL, "no provider call is authorized");
      if (u.pathname === "/auth/v1/user") return Response.json({ id: f.descriptor.owner_id });
      const input = JSON.parse(init.body).p_input, name = u.pathname.split("/").at(-1); actions.push(input.action);
      if (input.action === "recovery_inspect") return Response.json({ ...f.ref, status: "conflict", request_digest: "a".repeat(64), intent_id: f.descriptor.intent_id,
        receipt_id: f.source, execution_permitted: false, review_available: true, base_version: 3, source_receipt_id: f.source, file_name: "a.txt" });
      if (input.action === "recovery_load") return Response.json({ ...f.descriptor, credential_envelope: envelope });
      if (name === "clued_storage_refresh_worker_v1") { assert.equal(input.action, "claim"); return Response.json({ status: "not_acquired" }); }
      assert.equal(input.action, "report"); return Response.json({ status: "recorded", ...f.ref, execution_permitted: false });
    });
    const response = await worker.fetch(new Request("https://clued.example.invalid/v1/storage/recovery", { method: "POST",
      headers: { origin: "https://clued.example.invalid", authorization: "Bearer owner-jwt", "content-type": "application/json" }, body: JSON.stringify({ action: "review_prepare", ...f.ref }) }), env);
    const result = await response.json(); assert.notEqual(result.status, "review_prepared"); assert.equal(result.diagnostic.reason, "CREDENTIAL_EXPIRING");
    assert.equal(actions.filter(action => action === "claim").length, enabled ? 1 : 0);
    t.mock.restoreAll();
  }
});
