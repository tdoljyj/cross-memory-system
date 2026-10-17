import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";
const directory = await mkdtemp(path.join(os.tmpdir(), "storage-normal-recovery-")), output = path.join(directory, "executor.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-cloud-executor.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" });
stop();
const { createStorageCloudWorker } = await import(pathToFileURL(output));
const worker = await loadContinuityWorker(), origin = "https://clued.example.invalid", token = "clued_bnd_" + "a".repeat(40);
const env = { CLUED_DB_GATEWAY_TOKEN: "fixed-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_JOBS_V1: "true",
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "publishable" };
const ref = { connection_id: randomUUID(), job_id: randomUUID() }, mutation = { operation: "create", target_kind: "file", destination_path: "track/topic/file.md", content: "fixture" };
const request = (path, body) => new Request(origin + path, { method: "POST", headers: { origin, authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
const tool = (name, args) => request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("MCP and REST quarantine refusals wake only server-selected recovery, without dispatch, provider writes or private details", async t => {
  for (const rpcThrows of [false, true]) {
    const recoveryRef = { connection_id: randomUUID(), job_id: randomUUID() }, receipt = randomUUID();
    const recoveryEnv = { ...env, CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_EXECUTOR_V1: "true",
      CLUED_STORAGE_CONNECTOR_ISSUER: "fixture-recovery-issuer-" + "a".repeat(32),
      CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } }) };
    const calls = [], pending = [];
    let providerCalls = 0;
    t.mock.method(globalThis, "fetch", async (url, init = {}) => {
      const target = new URL(String(url));
      if (target.origin !== recoveryEnv.SUPABASE_URL) providerCalls++;
      assert.equal(target.origin, recoveryEnv.SUPABASE_URL, "a refusal and an already-settled recovery never access the provider");
      const body = JSON.parse(init.body), rpc = target.pathname.split("/").at(-1);
      assert.equal(init.method, "POST"); calls.push({ rpc, body });
      if (rpc === "clued_storage_jobs_router_v2") {
        assert.deepEqual(body.p_input, { action: "submit", ...ref, mutation });
        return rpcThrows
          ? Response.json({ code: "42501", message: "storage_object_under_review", details: "private target" }, { status: 403 })
          : Response.json({ status: "rejected", error_code: "storage_object_under_review", private: "private target" });
      }
      assert.deepEqual(Object.keys(body).sort(), ["p_input", "p_issuer_hash"]);
      assert.equal(body.p_issuer_hash, createHash("sha256").update(recoveryEnv.CLUED_STORAGE_CONNECTOR_ISSUER).digest("hex"));
      if (rpc === "clued_storage_scheduled_recovery_v2") {
        assert.deepEqual(body.p_input, { action: "due" }, "the rejected caller cannot select a privileged recovery target");
        return Response.json({ status: "ok", jobs: [recoveryRef] });
      }
      assert.equal(rpc, "clued_storage_cloud_worker_router_v2");
      assert.deepEqual(body.p_input, { ...recoveryRef, action: "verified_inspect" });
      return Response.json({ status: "committed", ...recoveryRef, receipt_id: receipt, execution_permitted: false });
    });
    const ctx = { waitUntil: promise => pending.push(promise) };
    const recovered = { status: "ok", committed: 1, released: 0, attention: 0 };
    const mcp = (await (await worker.fetch(tool("clued_storage_submit", { ...ref, mutation }), recoveryEnv, ctx)).json()).result;
    assert.deepEqual(await Promise.all(pending), [recovered]);
    assert.equal(mcp.isError, true); assert.equal(mcp.structuredContent.error, "storage_object_under_review");
    assert.match(mcp.structuredContent.message, /Unrelated storage remains available/);
    assert.doesNotMatch(JSON.stringify(mcp), /private target|storage_root_busy/);
    const rest = await (await worker.fetch(request("/v1/storage/jobs", { action: "submit", ...ref, mutation }), recoveryEnv, ctx)).json();
    assert.deepEqual(await Promise.all(pending), [recovered, recovered]);
    assert.equal(rest.error, "storage_object_under_review"); assert.equal(rest.execution_permitted, false); assert.equal(pending.length, 2);
    assert.equal(providerCalls, 0);
    assert.deepEqual(calls.map(({ rpc, body }) => [rpc, body.p_input.action]), [
      ["clued_storage_jobs_router_v2", "submit"], ["clued_storage_scheduled_recovery_v2", "due"],
      ["clued_storage_cloud_worker_router_v2", "verified_inspect"],
      ["clued_storage_jobs_router_v2", "submit"], ["clued_storage_scheduled_recovery_v2", "due"],
      ["clued_storage_cloud_worker_router_v2", "verified_inspect"],
    ]);
    t.mock.restoreAll();
  }
});

test("normal MCP and REST inspection of the original conflict is attention required with its actual receipt", async t => {
  const receipt = randomUUID();
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...ref, status: "conflict", request_digest: "a".repeat(64), intent_id: randomUUID(), receipt_id: receipt,
    execution_permitted: false, private_attempt: "private target" }));
  const mcp = (await (await worker.fetch(tool("clued_storage_inspect", ref), env)).json()).result;
  assert.equal(mcp.isError, false); assert.equal(mcp.structuredContent.status, "attention_required");
  assert.equal(mcp.structuredContent.reason_code, "PROVIDER_STATE_CONFLICT"); assert.equal(mcp.structuredContent.receipt_id, receipt);
  assert.match(mcp.structuredContent.hint, /unrelated storage remains available/);
  const rest = await (await worker.fetch(request("/v1/storage/jobs", { action: "inspect", ...ref }), env)).json();
  assert.equal(rest.status, "attention_required"); assert.equal(rest.reason_code, "PROVIDER_STATE_CONFLICT"); assert.equal(rest.receipt_id, receipt);
  assert.doesNotMatch(JSON.stringify([mcp, rest]), /private target|private_attempt|storage_job_unavailable/);
});

test("a quarantined cloud load preserves the fixed scoped reason and invokes no provider", async t => {
  t.mock.method(console, "warn", () => {});
  const executor = await createStorageCloudWorker({ client_id: "fixture-client", vault: { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } },
    fetch: async () => assert.fail("a refused object never reaches the provider"), rpc: async input => {
      if (input.action === "recovery_load") throw Error("not recoverable");
      assert.equal(input.action, "load"); throw Error("storage_object_under_review");
    } });
  const result = await executor.run(ref);
  assert.equal(result.status, "unavailable"); assert.equal(result.error_code, "STORAGE_OBJECT_UNDER_REVIEW"); assert.equal(result.execution_permitted, false);
});

test("a queued overlap already denied by the database keeps its reason without a second report or writer", async t => {
  t.mock.method(console, "warn", () => {});
  const calls = [], receipt = randomUUID();
  const executor = await createStorageCloudWorker({ client_id: "fixture-client",
    vault: { current_key_id: "fixture", keys: { fixture: randomBytes(32).toString("base64url") } },
    fetch: async () => assert.fail("an isolated queued job cannot reach Google"), rpc: async input => {
      calls.push(input.action);
      if (input.action === "recovery_load") throw Error("not recoverable");
      assert.equal(input.action, "load");
      return { contract: "clued.storage-job-execution/1", owner_id: randomUUID(), ...ref, status: "denied", intent_id: null,
        receipt_id: receipt, request_digest: "a".repeat(64), reason_code: "STORAGE_OBJECT_UNDER_REVIEW", execution_permitted: false };
    } });
  const result = await executor.run(ref);
  assert.equal(result.status, "unavailable"); assert.equal(result.error_code, "STORAGE_OBJECT_UNDER_REVIEW");
  assert.deepEqual(calls, ["recovery_load", "load"]); assert.equal(result.execution_permitted, false);
});

test("normal inspection explains the database's final denial of a previously queued overlap", async t => {
  const receipt = randomUUID();
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...ref, status: "denied", intent_id: null,
    receipt_id: receipt, request_digest: "a".repeat(64), reason_code: "STORAGE_OBJECT_UNDER_REVIEW", execution_permitted: false }));
  const mcp = (await (await worker.fetch(tool("clued_storage_inspect", ref), env)).json()).result;
  assert.equal(mcp.isError, false); assert.equal(mcp.structuredContent.status, "denied");
  assert.equal(mcp.structuredContent.receipt_id, receipt); assert.match(mcp.structuredContent.hint, /before a writer was issued or any Drive write began/);
  assert.match(mcp.structuredContent.hint, /Unrelated storage remains available/);
});

test("normal inspection distinguishes a resolved registration from the uncertain original effect using real independent receipt references", async t => {
  for (const resolution of ["accepted_current_state", "abandoned_registration"]) {
    const journalReceipt = randomUUID(), resolutionReceipt = randomUUID();
    let malformed = false;
    t.mock.method(globalThis, "fetch", async () => Response.json({ ...ref, status: "attention_required", request_digest: "a".repeat(64), intent_id: randomUUID(),
      receipt_id: journalReceipt, execution_permitted: false, reason_code: "PROVIDER_RESULT_RECONCILED", resolution,
      source_receipt_id: journalReceipt, ...(malformed ? {} : { resolution_receipt_id: resolutionReceipt }), private_attempt: "private target" }));
    const mcp = (await (await worker.fetch(tool("clued_storage_inspect", ref), env)).json()).result;
    assert.equal(mcp.isError, false); assert.equal(mcp.structuredContent.status, "attention_required");
    assert.equal(mcp.structuredContent.reason_code, "PROVIDER_RESULT_RECONCILED");
    assert.equal(mcp.structuredContent.receipt_id, journalReceipt); assert.equal(mcp.structuredContent.resolution_receipt_id, resolutionReceipt);
    assert.equal(mcp.structuredContent.resolution, resolution); assert.match(mcp.structuredContent.hint, /registration hold has ended through a separate reconciliation receipt/);
    assert.match(mcp.structuredContent.hint, /Storage can continue/);
    assert.match(mcp.structuredContent.hint, /use the separate resolution receipt and do not replay the old effect/);
    assert.doesNotMatch(mcp.structuredContent.hint, /is held for review/);
    assert.match(mcp.structuredContent.hint, /is not declared successful/);
    const rest = await (await worker.fetch(request("/v1/storage/jobs", { action: "inspect", ...ref }), env)).json();
    assert.equal(rest.reason_code, "PROVIDER_RESULT_RECONCILED"); assert.equal(rest.resolution_receipt_id, resolutionReceipt);
    assert.doesNotMatch(JSON.stringify([mcp, rest]), /private target|private_attempt/);
    malformed = true;
    const refused = (await (await worker.fetch(tool("clued_storage_inspect", ref), env)).json()).result;
    assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error, "storage_job_unavailable");
    t.mock.restoreAll();
  }
});
