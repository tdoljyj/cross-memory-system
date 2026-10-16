import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createResourceCenterOnlineToolHost } from "../../../kernel/host/resource-center-online-tool-host.mjs";
import { createResourceCenterWriteClient, resourceCenterReservationDiagnostic,
  sanitizeReservationDiagnostic } from "../../../kernel/host/resource-center-write-client.mjs";
import { runDailyJob } from "../../../kernel/host/resource-center-daily-job.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL, RESOURCE_CENTER_BOUNDARY_SCAN_TOOL } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";
import { fixture as cloudFixture } from "./resource-center-cloud-executor.fixture.mjs";
import { cloudDispatchOutcome } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";

const authority = { artifact_id: null, artifact_role: "clued_resource", governance_class: "ordinary", delete_authority: false,
  authority_version: "test/1", currentness_identity: "test/1", workspace_version: "test/1" };
const secret = "private provider reply clued_rcw_secret /private/owner/path";

async function nativeFixture(t, failureStage) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reservation-diagnostics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const profile = { registration_status: "registered", profile_id: "native-fixture", profile_version: "test/1",
    managed_root: path.join(directory, "Clued_资料中心"), allowed_root_children: ["20_P_产品与体验"], boundary_scan_roots: [directory] };
  await fs.mkdir(path.join(profile.managed_root, "20_P_产品与体验"), { recursive: true });
  const state = path.join(directory, "state"); await fs.mkdir(state); await fs.writeFile(path.join(state, "jobs.jsonl"), "");
  const actions = [], tickets = [];
  let failOnce = true;
  const failAt = stage => { if (failureStage === stage && failOnce) { failOnce = false; throw new Error(secret); } };
  const writer = createResourceCenterWriteClient({ endpoint: "https://writer.example.invalid/v1/resource-center/write",
    binding_token: "clued_rcw_" + "a".repeat(40),
    resolve_provider_identity: async () => { failAt("provider_identity"); return {}; }, verify_postcondition: async () => ({}),
    persist_recovery: async ticket => { tickets.push(ticket); failAt("recovery_ticket"); },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body), request = body.request; actions.push(request.action);
      failAt(request.action === "prepare" ? "prepare_rpc" : "start_rpc");
      return Response.json({ ...body, outcome: { status: "committed", state: request.action === "prepare" ? "prepared" : "started",
        version: request.action === "prepare" ? 1 : 2, intent_id: "00000000-0000-4000-8000-000000000010",
        request_sha256: request.request_sha256, ...(request.action === "start" ? { execution_permitted: true } : {}) } });
    } });
  const host = createResourceCenterOnlineToolHost({ trusted_profile: profile, resolve_artifact_online: async () => authority,
    prepare_write: writer.prepare_write, commit_post_write: async ({ binding }) => ({ status: "committed", receipt_id: randomUUID(), request_sha256: binding.request_sha256 }) });
  const mutation = { operation: "create", target_kind: "directory", directory_semantics: "topic",
    destination_path: path.join(profile.managed_root, "20_P_产品与体验", "new-topic") };
  return { profile, host, writer, mutation, actions, tickets, state };
}

for (const stage of ["provider_identity", "recovery_ticket"]) {
  test(`native ${stage} failure never reserves or fences unrelated work`, async t => {
    const f = await nativeFixture(t, stage);
    const result = await f.host.callTool(RESOURCE_CENTER_MUTATION_TOOL, f.mutation);
    assert.equal(result.error_code, "DURABLE_WRITE_PREPARATION_FAILED"); assert.equal(result.side_effects, 0);
    assert.deepEqual(result.reservation_diagnostic, { stage, reservation_status: "not_started",
      reason_code: stage === "provider_identity" ? "RESERVATION_PROVIDER_IDENTITY_UNAVAILABLE" : "RESERVATION_RECOVERY_TICKET_UNAVAILABLE" });
    assert.deepEqual(f.actions, []); assert.doesNotMatch(JSON.stringify(result), /private provider|clued_rcw_|owner\/path/);
    await assert.rejects(fs.stat(f.mutation.destination_path), { code: "ENOENT" });
    const next = { ...f.mutation, destination_path: path.join(path.dirname(f.mutation.destination_path), "unrelated-topic") };
    assert.equal((await f.host.callTool(RESOURCE_CENTER_MUTATION_TOOL, next)).status, "committed");
    assert.deepEqual(f.actions, ["prepare", "start"]); assert.equal((await fs.stat(next.destination_path)).isDirectory(), true);
  });

  test(`daily job finishes a proven ${stage} refusal and permits the next job`, async t => {
    const f = await nativeFixture(t, stage);
    const execute = mutation => runDailyJob({ state_directory: f.state, trusted_profile: f.profile, host: f.host,
      job: { job_id: randomUUID(), tool: RESOURCE_CENTER_MUTATION_TOOL, arguments: mutation },
      run_isolated: async ({ job, call_tool: call }) => {
        assert.deepEqual(await call(RESOURCE_CENTER_BOUNDARY_SCAN_TOOL, {}), []);
        return call(job.tool, job.arguments);
      } });
    const first = await execute(f.mutation);
    assert.equal(first.result.reservation_diagnostic.reservation_status, "not_started");
    await assert.rejects(fs.stat(path.join(f.state, "executor.lock")), { code: "ENOENT" });
    const rows = (await fs.readFile(path.join(f.state, "jobs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.at(-1).state, "finished"); assert.deepEqual(f.actions, []);
    const next = { ...f.mutation, destination_path: path.join(path.dirname(f.mutation.destination_path), "unrelated-topic") };
    assert.equal((await execute(next)).result.status, "committed");
    assert.deepEqual(f.actions, ["prepare", "start"]);
  });
}

for (const stage of ["prepare_rpc", "start_rpc"]) {
  test(`lost native ${stage} response preserves the original ticket and quarantine`, async t => {
    const f = await nativeFixture(t, stage);
    const first = await f.host.callTool(RESOURCE_CENTER_MUTATION_TOOL, f.mutation);
    assert.equal(first.error_code, "DURABLE_WRITE_RESERVATION_FAILED");
    assert.equal(first.reservation_diagnostic.stage, stage); assert.equal(first.reservation_diagnostic.reservation_status, "unknown");
    assert.doesNotMatch(JSON.stringify(first), /private provider|clued_rcw_|owner\/path/); assert.equal(f.tickets.length, 1);
    const actions = [...f.actions];
    assert.equal((await f.host.callTool(RESOURCE_CENTER_MUTATION_TOOL, f.mutation)).error_code, "POST_WRITE_RECONCILIATION_REQUIRED");
    assert.deepEqual(f.actions, actions); await assert.rejects(fs.stat(f.mutation.destination_path), { code: "ENOENT" });
  });
}

test("a diagnosed lost start still retains the daily profile fence across different job IDs", async t => {
  const f = await nativeFixture(t, "start_rpc");
  const run = (host = f.host) => runDailyJob({ state_directory: f.state, trusted_profile: f.profile, host,
    job: { job_id: randomUUID(), tool: RESOURCE_CENTER_MUTATION_TOOL, arguments: f.mutation },
    run_isolated: async ({ job, call_tool: call }) => {
      await call(RESOURCE_CENTER_BOUNDARY_SCAN_TOOL, {});
      return call(job.tool, job.arguments);
    } });
  const first = await run();
  assert.equal(first.result.reservation_diagnostic.reservation_status, "unknown");
  assert.deepEqual(f.actions, ["prepare", "start"]);
  await assert.rejects(run(), /DAILY_HOST_UNQUALIFIED/);
  const restarted = createResourceCenterOnlineToolHost({ trusted_profile: f.profile, resolve_artifact_online: async () => authority,
    prepare_write: async () => assert.fail("a restarted Host must not reserve past the old daily lock"),
    commit_post_write: async () => assert.fail("no effect can be finalized") });
  await assert.rejects(run(restarted), /EEXIST/);
  assert.deepEqual(f.actions, ["prepare", "start"]);
  const rows = (await fs.readFile(path.join(f.state, "jobs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(rows.at(-1).state, "unreconciled"); assert.equal(f.tickets.length, 1);
});

test("forged diagnostic properties cannot claim that an untyped reservation failure is safe", async t => {
  const f = await nativeFixture(t, "none");
  const host = createResourceCenterOnlineToolHost({ trusted_profile: f.profile, resolve_artifact_online: async () => authority,
    prepare_write: async () => { throw Object.assign(new Error(secret), { reservation_diagnostic: { stage: "provider_identity",
      reason_code: "RESERVATION_PROVIDER_IDENTITY_UNAVAILABLE", reservation_status: "not_started" } }); },
    commit_post_write: async () => assert.fail("no finalizer") });
  const result = await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, f.mutation);
  assert.deepEqual(result, { status: "deny", error_code: "DURABLE_WRITE_RESERVATION_FAILED", side_effects: 0 });
  assert.equal(resourceCenterReservationDiagnostic({ reservation_diagnostic: result }), undefined);
  assert.equal((await host.callTool(RESOURCE_CENTER_MUTATION_TOOL, f.mutation)).error_code, "POST_WRITE_RECONCILIATION_REQUIRED");
  for (const diagnostic of [null, { stage: "begin_rpc", reason_code: "RESERVATION_BEGIN_RPC_UNAVAILABLE", reservation_status: "not_started" },
    { stage: "provider_identity", reason_code: secret, reservation_status: "not_started" },
    { stage: "provider_identity", reason_code: "RESERVATION_PROVIDER_IDENTITY_UNAVAILABLE", reservation_status: "not_started", private: secret }]) {
    assert.equal(sanitizeReservationDiagnostic(diagnostic), null);
  }
});

for (const mode of ["provider_identity", "begin_rpc", "begin_result", "begin_known_denial"]) {
  test(`cloud ${mode} failure retains a bounded phase and stores only its safe reason`, async t => {
    const f = cloudFixture(), rpc = f.config.rpc;
    let authorities = 0;
    f.config.rpc = async input => {
      if (input.action === "authority") authorities++;
      if (input.action === "begin") {
        if (mode === "begin_rpc") throw new Error(secret);
        if (mode === "begin_known_denial") throw new Error("storage_job_attempt_mismatch");
        if (mode === "begin_result") return { status: "invalid", private: secret };
      }
      return rpc(input);
    };
    // The executor captures callbacks at construction; change the read closure,
    // rather than replacing its function after it has been captured.
    const getCredential = f.config.get_credential;
    f.config.get_credential = async (...args) => {
      if (mode === "provider_identity" && authorities >= 2) throw new Error(secret);
      return getCredential(...args);
    };
    const logs = []; t.mock.method(console, "warn", message => logs.push(JSON.parse(message)));
    const result = await f.run().run(f.reference);
    const expectedStage = mode === "provider_identity" ? "provider_identity" : mode === "begin_result" ? "begin_result" : "begin_rpc";
    const expectedCode = mode === "provider_identity" ? "RESERVATION_PROVIDER_IDENTITY_UNAVAILABLE" :
      mode === "begin_result" ? "RESERVATION_BEGIN_RESPONSE_INVALID" : mode === "begin_known_denial" ? "STORAGE_JOB_ATTEMPT_MISMATCH" : "RESERVATION_BEGIN_RPC_UNAVAILABLE";
    assert.equal(result.error_code, mode === "provider_identity" ? "DURABLE_WRITE_PREPARATION_FAILED" : "DURABLE_WRITE_RESERVATION_FAILED");
    assert.deepEqual(result.reservation_diagnostic, { stage: expectedStage, reason_code: expectedCode,
      reservation_status: mode === "provider_identity" ? "not_started" : "unknown" });
    assert.equal(f.info().starts, 0); assert.equal(f.info().posts, 0);
    assert.deepEqual(cloudDispatchOutcome(result), { status: "denied", reason: { code: expectedCode } });
    assert.deepEqual(logs, [{ event: "storage_cloud_prepare_failed", ...result.reservation_diagnostic },
      { event: "storage_cloud_denied", error_code: result.error_code }]);
    assert.doesNotMatch(JSON.stringify({ result, logs, outcome: cloudDispatchOutcome(result) }), /private provider|clued_rcw_|owner\/path/);
  });
}

test("the actual Worker bridge reports a safe begin diagnosis without replaying a lost durable start", async t => {
  const { outputFiles } = await build({ stdin: { contents: `
    export { fixture } from './tests/resource-center-cloud-executor.fixture.mjs';
    export { createStorageCloudWorker } from './worker/storage-cloud-executor.ts';
    export { createStorageCredentialVault } from './worker/storage-credential-vault.ts';`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "prepare-diagnostic-worker-fixture.mjs" },
    bundle: true, platform: "node", format: "esm", write: false });
  stop();
  const { fixture, createStorageCloudWorker, createStorageCredentialVault } = await import(
    "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
  const f = fixture({ lostBegin: true, redirect: "manual" }), descriptor = await f.config.load_job(f.reference);
  const credential = await f.config.get_credential(), keys = { current_key_id: "fixture", keys: { fixture: Buffer.alloc(32, 7).toString("base64url") } };
  const vault = await createStorageCredentialVault(keys), context = { owner_id: descriptor.owner_id,
    connection_id: descriptor.connection_id, provider: "google-drive", provider_subject: descriptor.provider_subject,
    credential_version: descriptor.credential_version, oauth_client_id: "fixture-client" };
  const envelope = await vault.seal(JSON.stringify({ ...credential, token_type: "Bearer" }), context), reports = [], calls = [];
  t.mock.method(console, "warn", () => {});
  const bridge = await createStorageCloudWorker({ client_id: "fixture-client", vault: keys, clock: f.config.clock,
    fetch: f.config.drive_fetch, account_policy_v2: true, rpc: async input => {
      calls.push(input.action);
      if (input.action === "verified_inspect") return { status: "none", ...f.reference, execution_permitted: false };
      if (input.action === "load") return { ...descriptor, credential_envelope: envelope, oauth_client_id: "fixture-client" };
      if (input.action === "report") {
        reports.push(input.outcome);
        // The begin response was lost after commit. The original journal wins;
        // reporting a fixed diagnosis must not turn that journal into a denial.
        assert.equal(f.info().status, "started");
        return { ...f.reference, status: "started", execution_permitted: false };
      }
      return f.config.rpc(input);
    } });
  const result = await bridge.run(f.reference);
  assert.equal(result.error_code, "DURABLE_WRITE_RESERVATION_FAILED");
  assert.deepEqual(result.reservation_diagnostic, { stage: "begin_rpc", reason_code: "RESERVATION_BEGIN_RPC_UNAVAILABLE", reservation_status: "unknown" });
  assert.deepEqual(reports, [{ status: "denied", reason: { code: "RESERVATION_BEGIN_RPC_UNAVAILABLE" } }]);
  assert.equal(calls.filter(action => action === "begin").length, 1); assert.equal(f.info().starts, 1); assert.equal(f.info().posts, 0);
  assert.equal(f.info().status, "started"); assert.doesNotMatch(JSON.stringify({ result, reports }), /lost begin|synthetic-cloud-token/);
});
