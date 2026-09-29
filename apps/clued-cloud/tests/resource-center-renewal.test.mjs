import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { renewResourceCenter, activeRenewalCredentials, openRenewalStore, withResourceCenterLifecycle, callRenewal, stopResourceCenter, guardedResourceCenterFetch, assertResourceCenterNotStopped } from "../../../kernel/host/resource-center-renewal.mjs";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

const hash = v => createHash("sha256").update(v).digest("hex");
function fixture() {
  let time = Date.now();
  const initial = { contract: "clued.resource-center-renewal-state/1", sequence: 0, phase: "active", profile_id: randomUUID(), grant_id: randomUUID(), generation: 0,
    reader: "clued_rcb_" + "a".repeat(64), writer: "clued_rcw_" + "b".repeat(64), renewal: "clued_rcr_" + "c".repeat(64), expires_at: new Date(time + 3600000).toISOString() };
  let state = structuredClone(initial);const rows = [], calls = [];let committed;
  const store = { read: () => structuredClone(state), append: async s => { rows.push(structuredClone(s));state = structuredClone(s); } };
  const request = async (token, req) => {
    calls.push({ token, req });
    assert.equal(store.read().phase, "pending");
    if (req.action === "rotate") {
      assert.equal(req.reader_hash, hash(state.next.reader));assert.equal(req.writer_hash, hash(state.next.writer));assert.equal(req.renewal_hash, hash(state.next.renewal));
      committed ??= { status: "rotated", grant_id: state.grant_id, profile_id: state.profile_id, generation: 1, expires_at: new Date(time + 24 * 3600000).toISOString(), receipt_id: randomUUID() };return committed;
    }
    return { ...committed, status: "active" };
  };
  return { initial, store, rows, calls, request, now: () => time, advance: ms => { time += ms; }, run: extra => renewResourceCenter({ store, profile_id: initial.profile_id, jobs: "", request, now: () => time, ...extra }) };
}
test("durable pending precedes remote rotation; one sealed generation activates after live check", async () => {
  const f = fixture();const result = await f.run();assert.equal(result.status, "rotated");
  assert.equal(f.rows[0].phase, "pending");assert.equal(f.rows[1].attempts, 1);
  assert.equal(f.calls.length, 2);assert.equal(f.store.read().generation, 1);
  assert.equal(activeRenewalCredentials(f.store.read(), f.initial.profile_id).writer.startsWith("clued_rcw_"), true);
  assert.equal(JSON.stringify(result).includes("clued_rc"), false);
  assert.equal((await f.run()).status, "not_due");assert.equal(f.calls.length, 2);
});
test("lost response reuses exact pending request and cannot execute ordinary jobs", async () => {
  const f = fixture();let lost = true;
  const request = async (...args) => { const r = await f.request(...args);if (lost) { lost = false;throw Error("response lost"); }return r; };
  assert.equal((await f.run({ request })).status, "needs_attention");
  const exact = f.store.read().exact;assert.throws(() => activeRenewalCredentials(f.store.read(), f.initial.profile_id), /NOT_ACTIVE/);
  f.advance(61000);assert.equal((await f.run({ request })).status, "rotated");
  assert.deepEqual(f.calls[1].req, exact);assert.equal(f.calls[1].token, f.calls[0].token);
});
test("local pending, corrupt and cross-profile journals block before HTTP or token generation", async () => {
  const f = fixture();
  const row = { contract: "clued.resource-center-daily-job/1", job_id: randomUUID(), profile_id: f.initial.profile_id, request_sha256: "a".repeat(64), state: "pending" };
  for (const jobs of [JSON.stringify(row) + "\n", "broken\n", JSON.stringify(row)]) await assert.rejects(f.run({ jobs }));
  assert.equal(f.rows.length, 0);assert.equal(f.calls.length, 0);
});
test("pre-commit outage can retry later without mistaking server issuance time for first attempt", async () => {
  const f = fixture();let unavailable = true;
  const request = async (...args) => { if (unavailable) { unavailable = false;throw Error("never reached server"); }return f.request(...args); };
  assert.equal((await f.run({ request })).status, "needs_attention");
  f.advance(121000);assert.equal((await f.run({ request })).status, "rotated");
  assert.equal(f.store.read().phase, "active");
});
test("bounded retry and stop never revive a pending generation", async () => {
  const f = fixture();let calls = 0;
  const request = async () => { calls++;throw Error("offline"); };
  for (let i = 0; i < 7; i++) { await f.run({ request });f.advance(3600000); }
  assert.equal(calls, 5);assert.equal(f.store.read().phase, "pending");
  const result = await f.run({ stop: true, request: async (_, req) => {
    assert.equal(f.store.read().phase, "stopped");assert.equal(req.action, "stop");return { status: "stopped", receipt_id: randomUUID() };
  } });assert.equal(result.status, "stopped");assert.equal((await f.run()).status, "stopped");
});
test("revoked successor, wrong scope, expiry or generation keeps pending closed", async () => {
  for (const change of [{ status: "denied" }, { grant_id: randomUUID() }, { generation: 9 }, { expires_at: new Date(0).toISOString() }]) {
    const f = fixture();const result = await f.run({ request: async (...args) => ({ ...await f.request(...args), ...change }) });
    assert.equal(result.status, "needs_attention");assert.equal(f.store.read().phase, "pending");
  }
  const f = fixture();const r = await f.run({ request: async (token, req) => req.action === "status" ? { status: "denied" } : f.request(token, req) });
  assert.equal(r.status, "needs_attention");
});
test("whole lifecycle lock excludes credential loading; crash locks not auto-cleared", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-renewal-lock-"));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await withResourceCenterLifecycle(dir, async () => {
    let ran = false;await assert.rejects(withResourceCenterLifecycle(dir, async () => { ran = true; }));assert.equal(ran, false);
  });
  await fs.writeFile(path.join(dir, "lifecycle.lock"), "crashed");
  await assert.rejects(withResourceCenterLifecycle(dir, async () => assert.fail("must not run")));
  assert.equal(await fs.readFile(path.join(dir, "lifecycle.lock"), "utf8"), "crashed");
});
test("sealed journal verifies pre-existing identity and rejects truncated or replayed rows", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-renewal-store-"));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const seal = async v => Buffer.from(JSON.stringify(v)).toString("base64"), unseal = async s => JSON.parse(Buffer.from(s, "base64").toString());
  const file = path.join(dir, "sealed.jsonl"), f = fixture();const first = await seal(f.initial);
  await fs.writeFile(file, first + "\n");const st = await fs.lstat(file), identity = { dev: st.dev, ino: st.ino };
  const store = await openRenewalStore(file, identity, { seal, unseal });await store.append({ ...f.initial, phase: "stopped" });await store.close();
  const reopened = await openRenewalStore(file, identity, { seal, unseal });assert.equal(reopened.read().phase, "stopped");await reopened.close();
  await fs.appendFile(file, first + "\n");await assert.rejects(openRenewalStore(file, identity, { seal, unseal }), /CORRUPT/);
  await fs.writeFile(file, first);await assert.rejects(openRenewalStore(file, identity, { seal, unseal }), /INCOMPLETE/);
  await assert.rejects(openRenewalStore(file, { ...identity, ino: -1 }, { seal, unseal }), /UNSAFE/);
});
test("emergency stop works with crash locks and incomplete later journal, never clears either", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-renewal-stop-"));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = fixture(), filename = path.join(dir, "renewal.dpapi.jsonl");
  const unseal = s => JSON.parse(Buffer.from(s, "base64").toString());
  await fs.writeFile(filename, Buffer.from(JSON.stringify(f.initial)).toString("base64") + "\ninterrupted");
  await fs.writeFile(path.join(dir, "lifecycle.lock"), "crashed");await fs.writeFile(path.join(dir, "executor.lock"), "unresolved");
  const st = await fs.lstat(filename);const before = await fs.readFile(filename, "utf8");let seen;
  const request = async (token, req) => { assert.equal(token, f.initial.renewal);seen = req;assert.ok(await fs.stat(path.join(dir, "renewal-stop.json")));return { status: "stopped", receipt_id: f.initial.grant_id }; };
  await stopResourceCenter({ directory: dir, filename, identity: { dev: st.dev, ino: st.ino }, unseal, request });
  const originalRequest = seen;await stopResourceCenter({ directory: dir, filename, identity: { dev: st.dev, ino: st.ino }, unseal, request });
  assert.deepEqual(seen, originalRequest);assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.equal(await fs.readFile(path.join(dir, "executor.lock"), "utf8"), "unresolved");
  assert.equal(await fs.readFile(path.join(dir, "lifecycle.lock"), "utf8"), "crashed");
});
test("stop during stdin or credential wait blocks later dispatch even when server is offline", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-stop-race-"));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let calls = 0;const guarded = guardedResourceCenterFetch(dir, async () => { calls++;return Response.json({}); });
  assertResourceCenterNotStopped(dir); // invocation has already started
  let release;const credential = new Promise(r => { release = r; });
  const inFlight = (async () => { await credential;return guarded("https://www.googleapis.com/upload/drive/v3/files", { method: "POST" }); })();
  await fs.writeFile(path.join(dir, "renewal-stop.json"), "stop persisted; remote offline");release();
  await assert.rejects(inFlight, /STOPPED/);assert.equal(calls, 0);
  assert.throws(() => assertResourceCenterNotStopped(dir), /STOPPED/); // after stdin
});
test("stop after rotation reply prevents successor activation", async () => {
  const f = fixture();let stopped = false;
  const r = await f.run({ request: async (...args) => { const result = await f.request(...args);stopped = true;return result; },
    assert_active: () => { if (stopped) throw Error("DAILY_RENEWAL_STOPPED"); } });
  assert.equal(r.status, "needs_attention");assert.equal(f.store.read().phase, "pending");assert.equal(f.calls.length, 1);
});
test("dedicated renewal transport never echoes token hashes, rejects other credential roles", async () => {
  const worker = await loadContinuityWorker(), original = globalThis.fetch;let calls = 0;
  globalThis.fetch = async (_, options) => {
    calls++;assert.equal(JSON.parse(options.body).p_token_hash, hash("clued_rcr_" + "a".repeat(64)));
    return Response.json({ status: "rotated", grant_id: randomUUID(), generation: 1, reader_hash: "should-not-leak" });
  };
  const call = token => worker.fetch(new Request("https://clued.test/v1/resource-center/renew", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ contract: "clued.resource-center-renewal/1", request: { action: "rotate", reader_hash: "private" } }) }), { ASSETS: { fetch() {} } }, { waitUntil() {} });
  try {
    for (const prefix of ["clued_rcw_", "clued_rcb_", "clued_bnd_"]) assert.equal((await call(prefix + "a".repeat(64))).status, 403);
    assert.equal(calls, 0);const response = await call("clued_rcr_" + "a".repeat(64));assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();assert.equal(body.includes("hash"), false);assert.equal(body.includes("private"), false);
  } finally { globalThis.fetch = original; }
  await assert.rejects(callRenewal("clued_rcr_" + "a".repeat(64), {}, async () => Response.json({ status: "active", secret: "x" })), /INVALID/);
});
