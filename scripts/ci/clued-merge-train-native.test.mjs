// The merge-train Native write port with the CI identity (DESIGN §41.4; clued-merge-train-native.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMergeTrainNativeWriter, MERGE_TRAIN_NATIVE_RPCS, NOT_ON_DUTY, SWEEP_WATERMARK_NOT_DEPLOYED, SWEEP_WATERMARK_NOT_NEWER, SWEEP_WATERMARK_NEWER_EXISTS } from "./clued-merge-train-native.mjs";

const REPO = "tdoljyj/cross-memory-system", TOKEN = "clued_bnd_fixture_secret_token";
const H = "a".repeat(40), M = "b".repeat(40);
const C1 = "11111111-2222-4333-8444-555555555555", C2 = "66666666-7777-4888-9999-aaaaaaaaaaaa", R1 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const reply = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A fetch that answers from a script and records every request (url, rpc, input, headers).
function native(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, rpc: url.split("/rpc/")[1], method: init.method, redirect: init.redirect, headers: init.headers, tokenHash: body.p_token_hash, input: body.p_input });
    return answer(calls.at(-1));
  };
  return { calls, writer: createMergeTrainNativeWriter({ supabaseUrl: "https://fixture.supabase.co/", publishableKey: "sb_publishable_fixture", scope: "project:p", repository: REPO, fetchImpl, nativeToken: TOKEN }) };
}
const code = c => e => e.code === c;

test("merge-train port: only the four existing CI-identity functions; the token itself never leaves the process", async () => {
  assert.deepEqual([...MERGE_TRAIN_NATIVE_RPCS].sort(), ["clued_work_claim_adopt_v1", "clued_work_merge_slot_return_v1", "clued_work_merge_slot_touch_v1", "clued_work_verify_v1"]);
  const { calls, writer } = native(() => reply({ status: "ok", ci_state: "running", pr_ref: `${REPO}#910`, head_sha: H, touched: true, claims: [C1], merge_slot_until: "2026-10-31T10:00:00Z" }));
  assert.deepEqual(await writer.touch({ pr: 910, headSha: H, ciState: "running", hardCapMinutes: 120 }), { onDuty: true, touched: true, until: "2026-10-31T10:00:00Z", claims: [C1], returned: null });
  assert.equal(calls[0].url, "https://fixture.supabase.co/rest/v1/rpc/clued_work_merge_slot_touch_v1");
  assert.deepEqual([calls[0].method, calls[0].redirect, calls[0].headers.apikey, calls[0].headers.authorization], ["POST", "error", "sb_publishable_fixture", "Bearer sb_publishable_fixture"]);
  assert.equal(calls[0].tokenHash, createHash("sha256").update(TOKEN).digest("hex"));
  assert.deepEqual(calls[0].input, { scope: "project:p", pr_ref: `${REPO}#910`, head_sha: H, ci_state: "running", hard_cap_minutes: 120 });
  assert.ok(!JSON.stringify(calls).includes(TOKEN));
  assert.throws(() => createMergeTrainNativeWriter({ supabaseUrl: "http://x", publishableKey: "k", scope: "project:p", repository: REPO, fetchImpl() {}, nativeToken: TOKEN }), code("MERGE_TRAIN_NATIVE_INPUT_REFUSED"));
});

test("merge-train port: touch green, running and failed; not on duty; no live slot", async () => {
  let next;
  const { calls, writer } = native(() => next);
  next = reply({ status: "ok", ci_state: "green", pr_ref: `${REPO}#910`, head_sha: H, touched: false, claims: [], merge_slot_until: null, reason: "no_live_slot_for_pr" });
  assert.deepEqual(await writer.touch({ pr: 910, headSha: H, ciState: "green", hardCapMinutes: 90 }), { onDuty: true, touched: false, until: null, claims: [], returned: null });
  next = reply({ status: "ok", touched: false, reason: NOT_ON_DUTY });
  assert.deepEqual(await writer.touch({ pr: 910, headSha: H, ciState: "green", hardCapMinutes: 90 }), { onDuty: false, touched: false, until: null, claims: [], returned: null });
  next = reply({ status: "ok", ci_state: "failed", pr_ref: `${REPO}#910`, head_sha: H, notified: [C1], returned: true, merge_slot_returned: [C1] });
  assert.deepEqual(await writer.touch({ pr: 910, headSha: H, ciState: "failed", reason: "TRAIN_FRONT_FAILED" }), { onDuty: true, touched: true, until: null, claims: [C1], returned: true });
  assert.deepEqual(calls.at(-1).input, { scope: "project:p", pr_ref: `${REPO}#910`, head_sha: H, ci_state: "failed", reason: "TRAIN_FRONT_FAILED" });
  // failed with nothing to return (review R1 m7); returned must agree with the list
  next = reply({ status: "ok", ci_state: "failed", pr_ref: `${REPO}#910`, head_sha: H, notified: [], returned: false, merge_slot_returned: [] });
  assert.deepEqual(await writer.touch({ pr: 910, headSha: H, ciState: "failed" }), { onDuty: true, touched: false, until: null, claims: [], returned: false });
  next = reply({ status: "ok", ci_state: "failed", pr_ref: `${REPO}#910`, head_sha: H, notified: [], returned: true, merge_slot_returned: [] });
  await assert.rejects(writer.touch({ pr: 910, headSha: H, ciState: "failed" }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  // refused before any call: a cap outside 60..180, a missing cap for running/green, a short SHA, a control character
  const before = calls.length;
  for (const bad of [{ pr: 910, headSha: H, ciState: "green", hardCapMinutes: 59 }, { pr: 910, headSha: H, ciState: "running" }, { pr: 910, headSha: "abc", ciState: "failed" },
    { pr: 0, headSha: H, ciState: "failed" }, { pr: 910, headSha: H, ciState: "merged", hardCapMinutes: 90 }, { pr: 910, headSha: H, ciState: "failed", reason: "a\nb" }])
    await assert.rejects(writer.touch(bad), code("MERGE_TRAIN_NATIVE_INPUT_REFUSED"));
  assert.equal(calls.length, before);
  // anything Native did not answer exactly is unreadable: another head echoed, a touched answer without claims, an HTTP error
  for (const r of [reply({ status: "ok", ci_state: "green", pr_ref: `${REPO}#910`, head_sha: M, touched: true, claims: [C1], merge_slot_until: "2026-10-31T10:00:00Z" }),
    reply({ status: "ok", ci_state: "green", pr_ref: `${REPO}#910`, head_sha: H, touched: true, claims: [], merge_slot_until: "2026-10-31T10:00:00Z" }),
    reply({ code: "22023", message: "work_claim_merge_slot_hard_cap_invalid" }, 400), reply("not json"), reply({ status: "ok", touched: true, reason: NOT_ON_DUTY })]) {
    next = r;
    await assert.rejects(writer.touch({ pr: 910, headSha: H, ciState: "green", hardCapMinutes: 90 }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  }
  next = reply("x".repeat(70_000));
  await assert.rejects(writer.touch({ pr: 910, headSha: H, ciState: "green", hardCapMinutes: 90 }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  const down = createMergeTrainNativeWriter({ supabaseUrl: "https://x.supabase.co", publishableKey: "k", scope: "global", repository: REPO, nativeToken: TOKEN, fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  await assert.rejects(down.touch({ pr: 910, headSha: H, ciState: "green", hardCapMinutes: 90 }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
});

test("merge-train port: adopt and return", async () => {
  let next;
  const { calls, writer } = native(() => next);
  next = reply({ status: "ok", adopted: true, replayed: false, claim_id: C1, pr_ref: `${REPO}#910`, merge_slot_returned: [C1] });
  assert.deepEqual(await writer.adopt({ pr: 910, mergeSha: M }), { onDuty: true, adopted: true, returned: [C1] });
  assert.deepEqual([calls[0].rpc, calls[0].input], ["clued_work_claim_adopt_v1", { scope: "project:p", pr_ref: `${REPO}#910`, merge_sha: M }]);
  next = reply({ status: "ok", adopted: false, reason: "no_copy_for_pr", pr_ref: `${REPO}#910` });
  assert.deepEqual(await writer.adopt({ pr: 910, mergeSha: M }), { onDuty: true, adopted: false, returned: [] });
  next = reply({ status: "rejected", error_code: "copy_not_adopted", task_id: C2, adopted_claim_id: C2, pr_ref: `${REPO}#910` });
  assert.deepEqual(await writer.adopt({ pr: 910, mergeSha: M }), { onDuty: true, adopted: false, returned: [] });
  next = reply({ status: "ok", adopted: false, reason: NOT_ON_DUTY });
  assert.deepEqual(await writer.adopt({ pr: 910, mergeSha: M }), { onDuty: false, adopted: false, returned: [] });
  // the echo is checked (review R1 m6): another PR, an adoption without its claim, an unknown refusal
  for (const r of [{ status: "rejected", error_code: "something_else", pr_ref: `${REPO}#910` }, { status: "ok", adopted: true, claim_id: C1, pr_ref: `${REPO}#911` },
    { status: "ok", adopted: true, pr_ref: `${REPO}#910` }, { status: "ok", adopted: false, reason: "no_copy_for_pr" }]) {
    next = reply(r);
    await assert.rejects(writer.adopt({ pr: 910, mergeSha: M }), code("MERGE_TRAIN_NATIVE_UNREADABLE"), JSON.stringify(r));
  }
  await assert.rejects(writer.adopt({ pr: 910, mergeSha: "x" }), code("MERGE_TRAIN_NATIVE_INPUT_REFUSED"));
  next = reply({ status: "ok", returned: true, pr_ref: `${REPO}#910`, merge_slot_returned: [C1] });
  assert.deepEqual(await writer.returnSlot({ pr: 910 }), { onDuty: true, returned: true, claims: [C1] });
  assert.deepEqual([calls.at(-1).rpc, calls.at(-1).input], ["clued_work_merge_slot_return_v1", { scope: "project:p", pr_ref: `${REPO}#910` }]);
  next = reply({ status: "ok", returned: false, reason: NOT_ON_DUTY });
  assert.deepEqual(await writer.returnSlot({ pr: 910 }), { onDuty: false, returned: false, claims: [] });
  next = reply({ status: "ok", returned: true, pr_ref: `${REPO}#910`, merge_slot_returned: [] });
  await assert.rejects(writer.returnSlot({ pr: 910 }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
});

test("merge-train port: keepalive through the CI command door, at most 50 open PRs of this repository", async () => {
  let next;
  const { calls, writer } = native(() => next);
  next = reply({ status: "ok", repository: REPO, kept_alive: [{ claim_id: C1, bound_pr: `${REPO}#910`, expires_at: "2026-10-31T12:00:00Z", previous_expires_at: "2026-10-31T10:30:00Z", receipt_id: R1 },
    { claim_id: C2, bound_pr: `${REPO}#911`, expires_at: "2026-10-31T12:00:00Z", previous_expires_at: "2026-10-31T11:00:00Z", receipt_id: null }] });
  assert.deepEqual(await writer.keepalive({ prs: [910, 911, 912] }), { onDuty: true, keptAlive: [{ claimId: C1, boundPr: `${REPO}#910`, expiresAt: "2026-10-31T12:00:00Z" }, { claimId: C2, boundPr: `${REPO}#911`, expiresAt: "2026-10-31T12:00:00Z" }] });
  assert.deepEqual([calls[0].rpc, calls[0].input], ["clued_work_verify_v1", { action: "merge_queue_keepalive", scope: "project:p", repository: REPO, pr_refs: [`${REPO}#910`, `${REPO}#911`, `${REPO}#912`] }]);
  next = reply({ status: "rejected", error_code: NOT_ON_DUTY });
  assert.deepEqual(await writer.keepalive({ prs: [910] }), { onDuty: false, keptAlive: [] });
  // a claim of a PR that was not asked for, a lease that did not move, another repository: unreadable
  for (const kept of [[{ claim_id: C1, bound_pr: `${REPO}#999`, expires_at: "2026-10-31T12:00:00Z", previous_expires_at: "2026-10-31T10:30:00Z", receipt_id: null }],
    [{ claim_id: C1, bound_pr: `${REPO}#910`, expires_at: "2026-10-31T10:30:00Z", previous_expires_at: "2026-10-31T10:30:00Z", receipt_id: null }],
    // the same claim twice (review R1 m7)
    [{ claim_id: C1, bound_pr: `${REPO}#910`, expires_at: "2026-10-31T12:00:00Z", previous_expires_at: "2026-10-31T10:30:00Z", receipt_id: null },
      { claim_id: C1, bound_pr: `${REPO}#910`, expires_at: "2026-10-31T12:00:00Z", previous_expires_at: "2026-10-31T10:30:00Z", receipt_id: null }]]) {
    next = reply({ status: "ok", repository: REPO, kept_alive: kept });
    await assert.rejects(writer.keepalive({ prs: [910] }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  }
  next = reply({ status: "ok", repository: "other/repo", kept_alive: [] });
  await assert.rejects(writer.keepalive({ prs: [910] }), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  for (const prs of [Array.from({ length: 51 }, (_, i) => i + 1), [910, 910], ["910"], undefined]) await assert.rejects(writer.keepalive({ prs }), code("MERGE_TRAIN_NATIVE_INPUT_REFUSED"));
});

const INVALID = () => reply({ code: "22023", message: "work_claim_ci_command_invalid" }, 400);
const STATUS_OK = (o = {}) => reply({ status: "ok", observed_at: "2026-10-31T09:00:00Z", watchdog: { last_tick_at: "2026-10-31T08:59:30Z", stale: false }, nodes: [], sweep_watermarks: [], ...o });

test("merge-train port: the sweep watermark (2b train_sweep_watermark); only an unknown action is 'not deployed', a real refusal surfaces", async () => {
  let script = [];
  const { calls, writer } = native(() => script.shift());
  const w = { completedAt: "2026-10-31T09:00:00.000Z", updatedCursor: "2026-10-31T08:59:00Z", mainSha: M };
  const RECORDED = { status: "ok", recorded: true, repository: REPO, completed_at: w.completedAt, receipt_id: R1 };
  script = [reply(RECORDED)];
  assert.deepEqual(await writer.reportSweepWatermark(w), { onDuty: true, recorded: true, reason: null });
  assert.deepEqual(calls[0].input, { action: "train_sweep_watermark", scope: "project:p", repository: REPO, completed_at: w.completedAt, updated_cursor: w.updatedCursor, main_sha: M });
  script = [reply({ ...RECORDED, recorded: false, completed_at: "2026-10-31T09:30:00Z" })];
  assert.deepEqual(await writer.reportSweepWatermark(w), { onDuty: true, recorded: false, reason: SWEEP_WATERMARK_NOT_NEWER });
  script = [reply({ code: "40001", message: "work_claim_ci_command_conflict" }, 500)];
  assert.deepEqual(await writer.reportSweepWatermark(w), { onDuty: true, recorded: false, reason: SWEEP_WATERMARK_NEWER_EXISTS });
  // before 2b: the watermark and ci_nodes_status are both unknown actions (22023), or the function is unknown (404)
  script = [INVALID(), INVALID()];
  assert.deepEqual(await writer.reportSweepWatermark(w), { onDuty: null, recorded: false, reason: SWEEP_WATERMARK_NOT_DEPLOYED });
  assert.deepEqual(calls.slice(-2).map(c => c.input.action), ["train_sweep_watermark", "ci_nodes_status"]);
  script = [reply({ code: "PGRST202", message: "Could not find the function" }, 404)];
  assert.deepEqual(await writer.reportSweepWatermark(w), { onDuty: null, recorded: false, reason: SWEEP_WATERMARK_NOT_DEPLOYED });
  // 2b deployed (ci_nodes_status answers): the 22023 was a refused input
  script = [INVALID(), STATUS_OK()];
  await assert.rejects(writer.reportSweepWatermark(w), code("MERGE_TRAIN_NATIVE_INPUT_REFUSED"));
  script = [reply({ status: "rejected", error_code: NOT_ON_DUTY })];
  assert.deepEqual(await writer.reportSweepWatermark(w), { onDuty: false, recorded: false, reason: NOT_ON_DUTY });
  for (const r of [reply({ code: "22023", message: "other" }, 400), reply({ status: "ok", recorded: true }), reply({ ...RECORDED, repository: "other/repo" }), reply({}, 500)]) {
    script = [r];
    await assert.rejects(writer.reportSweepWatermark(w), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  }
  const before = calls.length;
  for (const bad of [{ ...w, mainSha: "x" }, { ...w, updatedCursor: "2026-10-31T09:00:01Z" }]) await assert.rejects(writer.reportSweepWatermark(bad), code("MERGE_TRAIN_NATIVE_INPUT_REFUSED"));
  assert.equal(calls.length, before);
});

test("merge-train port: ci_nodes_status, tolerant per entry; a node never heard is no record; not on duty; not deployed", async () => {
  let next;
  const { calls, writer } = native(() => next);
  const heard = { node_id: C2, name: "TURING", project_id: null, stage1_state: "active", last_heartbeat_at: "2026-10-31T08:55:00Z", mode: "ACTIVE", probe: "held", state: "NORMAL",
    ci_source_manifest_sha256: "e".repeat(64), service_running: true };
  const never = { node_id: C1, name: "DESK-W-591", stage1_state: "active", last_heartbeat_at: null, heartbeat_sequence: 0, mode: null, state: null, ci_source_manifest_sha256: null };
  const entry = (o = {}) => ({ binding_id: C1, agent_name: "TURING", vendor: "claude", live: true, rank: 1, marked_at: "2026-10-30T00:00:00Z", node: heard, ...o });
  next = STATUS_OK({ nodes: [entry(), entry({ binding_id: C2, rank: null, marked_at: null, node: null }), entry({ node: never }), entry({ node: { ...heard, ci_source_manifest_sha256: "short" } }), "x"],
    sweep_watermarks: [{ repository: REPO, binding_id: C1, completed_at: "2026-10-31T08:00:00Z", updated_cursor: "2026-10-31T07:59:00Z", main_sha: M, reported_at: "2026-10-31T08:00:01Z", receipt_id: R1 }, { repository: 1 }] });
  const s = await writer.nodesStatus();
  assert.deepEqual(calls.at(-1).input, { action: "ci_nodes_status", scope: "project:p" });
  assert.deepEqual([s.onDuty, s.deployed, s.dropped, s.nodes.length, s.watchdog], [true, true, 3, 3, { lastTickAt: "2026-10-31T08:59:30Z", stale: false }]);
  assert.deepEqual(s.nodes[0].node, { name: "TURING", sourceManifestSha256: "e".repeat(64), state: "NORMAL", mode: "ACTIVE", lastHeartbeatAt: "2026-10-31T08:55:00Z" });
  assert.deepEqual([s.nodes[1].node, s.nodes[2].node.lastHeartbeatAt, s.nodes[2].node.sourceManifestSha256], [null, null, null]);
  assert.deepEqual(s.sweepWatermark, { completedAt: "2026-10-31T08:00:00Z", updatedCursor: "2026-10-31T07:59:00Z", mainSha: M });
  next = reply({ status: "rejected", error_code: NOT_ON_DUTY });
  const idle = await writer.nodesStatus();
  assert.deepEqual([idle.onDuty, idle.deployed, idle.nodes], [false, true, null]);
  next = INVALID();
  const old = await writer.nodesStatus();
  assert.deepEqual([old.onDuty, old.deployed, old.nodes], [null, false, null]);
  for (const r of [reply({ status: "ok", observed_at: "2026-10-31T09:00:00Z", nodes: {} }), reply({ status: "ok", nodes: [] }), reply({}, 502), reply("x".repeat(70_000))]) {
    next = r;
    await assert.rejects(writer.nodesStatus(), code("MERGE_TRAIN_NATIVE_UNREADABLE"));
  }
});
