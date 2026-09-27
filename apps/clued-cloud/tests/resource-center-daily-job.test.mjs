import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runDailyJob, validateDailyJob } from "../../../kernel/host/resource-center-daily-job.mjs";
import { RESOURCE_CENTER_GOVERNED_TOOL_MANIFEST as tools } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";

const profile = { registration_status: "registered", profile_id: "official", profile_version: "1", managed_root: "/resource", allowed_root_children: ["10_E"] };
const job = () => ({ job_id: randomUUID(), tool: tools[0].name, arguments: { operation: "create", destination_path: "/resource/10_E/topic/new.md", target_kind: "file", content: "owner request" } });
async function fixture(t, result = { status: "committed", canonical_receipt_id: randomUUID() }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-daily-test-"));
  await fs.writeFile(path.join(dir, "jobs.jsonl"), "");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let effects = 0;
  return { state_directory: dir, trusted_profile: profile, get effects() { return effects; },
    host: { listTools: () => tools, callTool: async (name) => name === tools[1].name ? [] : (effects++, result) },
    run_isolated: async ({ job, call_tool: call }) => {
      await call(tools[1].name, {});
      return job.tool === tools[1].name ? [] : call(job.tool, job.arguments);
    } };
}
test("same job cannot repeat after a successful process restart", async t => {
  const f = await fixture(t), request = job();
  assert.equal((await runDailyJob({ ...f, job: request })).result.status, "committed");
  const replay = await runDailyJob({ ...f, job: request });
  assert.equal(replay.replayed, true); assert.equal(replay.result.status, "committed");
  assert.equal(f.effects, 1);
  assert.equal((await runDailyJob({ ...f, job: job() })).result.status, "committed");
});
test("same job ID with changed contents is a conflict and never executes", async t => {
  const f = await fixture(t), request = job();
  await runDailyJob({ ...f, job: request });
  await assert.rejects(runDailyJob({ ...f, job: { ...request, arguments: { ...request.arguments, content: "changed" } } }), /DAILY_JOB_IDENTITY_CONFLICT/);
  assert.equal(f.effects, 1);
});
test("field order and UUID casing do not change job identity", async t => {
  const f = await fixture(t), request = job();await runDailyJob({ ...f, job: request });
  const reordered = { arguments: Object.fromEntries(Object.entries(request.arguments).reverse()), tool: request.tool, job_id: request.job_id.toUpperCase() };
  assert.equal((await runDailyJob({ ...f, job: reordered })).replayed, true);
  assert.equal(f.effects, 1);
});
test("partial prior job cannot be mistaken for a new request", async t => {
  const f = await fixture(t), request = job();
  await fs.writeFile(path.join(f.state_directory, "jobs.jsonl"), '{"partial":');
  await assert.rejects(runDailyJob({ ...f, job: request }), /DAILY_JOB_JOURNAL_INCOMPLETE/);
  assert.equal(f.effects, 0);
});
test("lost reservation response remains unresolved despite side_effects zero", async t => {
  const f = await fixture(t, { status: "deny", error_code: "DURABLE_WRITE_RESERVATION_FAILED", side_effects: 0 });
  await runDailyJob({ ...f, job: job() });
  assert.match(await fs.readFile(path.join(f.state_directory, "jobs.jsonl"), "utf8"), /unreconciled/);
  // Simulate a crash losing the lock entry; the pre-existing ledger still fences.
  await fs.unlink(path.join(f.state_directory, "executor.lock"));
  await assert.rejects(runDailyJob({ ...f, job: job() }), /DAILY_JOB_RECONCILIATION_REQUIRED/);
  assert.equal(f.effects, 1);
});
test("missing pre-provisioned ledger never creates a replacement", async t => {
  const f = await fixture(t);await fs.unlink(path.join(f.state_directory, "jobs.jsonl"));
  await assert.rejects(runDailyJob({ ...f, job: job() }), /ENOENT/);
  assert.equal(f.effects, 0);
});
test("independent concurrent invocations share an exclusive lock", async t => {
  const f = await fixture(t);let signal;const acquired = new Promise(r => { signal = r; });let release;
  const waiting = new Promise(r => { release = r; });
  const first = runDailyJob({ ...f, job: job(), run_isolated: async args => { signal(); await waiting; return f.run_isolated(args); } });
  await acquired;
  await assert.rejects(runDailyJob({ ...f, job: job() }), /EEXIST/);
  release(); await first; assert.equal(f.effects, 1);
});
test("unknown effect retains the executor fence across different job IDs", async t => {
  const f = await fixture(t, { status: "unreconciled", side_effects: "unknown" });
  await runDailyJob({ ...f, job: job() });
  await assert.rejects(runDailyJob({ ...f, job: job() }), /EEXIST/);
  assert.equal(f.effects, 1);
});
test("crash before completion retains pending job and lock", async t => {
  const f = await fixture(t);
  await assert.rejects(runDailyJob({ ...f, job: job(), run_isolated: async () => { throw new Error("crash"); } }), /crash/);
  await assert.rejects(runDailyJob({ ...f, job: job() }), /EEXIST/);
  assert.equal(f.effects, 0);
});
test("changed consumer request is denied before storage", async t => {
  const f = await fixture(t);
  await assert.rejects(runDailyJob({ ...f, job: job(), run_isolated: async ({ call_tool: call }) => {
    await call(tools[1].name, {}); return call(tools[0].name, { operation: "create", destination_path: "/other" });
  } }), /DAILY_CONSUMER_REQUEST_CHANGED/);
  assert.equal(f.effects, 0);
});
test("consumer cannot forge a successful result", async t => {
  const f = await fixture(t);
  await assert.rejects(runDailyJob({ ...f, job: job(), run_isolated: async () => ({ status: "committed" }) }), /DAILY_CONSUMER_RESULT_MISMATCH/);
  assert.equal(f.effects, 0);
});
test("full manifest is qualified; no filtered view of generic tools", async t => {
  const f = await fixture(t);f.host.listTools = () => [...tools, { name: "exec_command" }];
  await assert.rejects(runDailyJob({ ...f, job: job() }), /DAILY_HOST_UNQUALIFIED/);
  assert.equal(f.effects, 0);
});
test("caller authority, non-create, invalid IDs and content are rejected", () => {
  for (const change of [
    { profile_id: "caller" }, { job_id: "../escape" }, { tool: "exec_command" },
    { arguments: { ...job().arguments, operation: "replace" } },
    { arguments: { ...job().arguments, managed_root: "/caller" } },
    { arguments: { ...job().arguments, content: "a".repeat(1024 * 1024 + 1) } },
    { arguments: { operation: "create", target_kind: "directory", destination_path: "/resource/new" } },
  ]) assert.throws(() => validateDailyJob({ ...job(), ...change }), /DAILY_JOB_INVALID/);
});
test("clean scan is reusable using distinct IDs without mutation", async t => {
  const f = await fixture(t);const request = { job_id: randomUUID(), tool: tools[1].name, arguments: {} };
  assert.deepEqual((await runDailyJob({ ...f, job: request })).result, []);
  assert.equal(f.effects, 0);
});
test("boundary findings deny the exact job without a mutation call", async t => {
  const f = await fixture(t);const findings = [{ code: "UNAUTHORIZED_WORKSPACE_MUTATION" }];
  f.host.callTool = async () => findings;
  f.run_isolated = async ({ call_tool: call }) => ({ status: "deny", error_code: "UNAUTHORIZED_WORKSPACE_MUTATION", side_effects: 0, findings: await call(tools[1].name, {}) });
  assert.equal((await runDailyJob({ ...f, job: job() })).result.status, "deny");
  assert.equal(f.effects, 0);
});
