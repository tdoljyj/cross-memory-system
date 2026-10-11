import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

// BUG-20261008-001 (Clued Task f7a4dd7d): queued jobs whose one dispatch was lost
// or refused. Synthetic RPCs only; no database, Drive or credential.
const worker = await loadContinuityWorker();
const bundle = async entry => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clued-queued-dispatch-"));
  const outfile = path.join(directory, path.basename(entry).replace(/\.ts$/, ".mjs"));
  await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(outfile).href);
};
const { runStorageQueuedSweepScheduled } = await bundle("../worker/storage-queued-dispatch.ts");
const { createStorageCloudWorker } = await bundle("../worker/storage-cloud-executor.ts");

const issuer = randomBytes(32).toString("base64url");
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_JOBS_V1: "true", CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_GOOGLE_V1: "true",
  CLUED_STORAGE_EXECUTOR_V1: "true", CLUED_STORAGE_CONNECTOR_ISSUER: issuer,
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
};
const job = n => ({ connection_id: `20000000-0000-4000-8000-00000000000${n}`, job_id: `10000000-0000-4000-8000-00000000000${n}` });
const withFetch = async (handler, body) => {
  const previous = globalThis.fetch; globalThis.fetch = handler;
  try { return await body(); } finally { globalThis.fetch = previous; }
};
const quiet = async body => { const warn = console.warn, lines = []; console.warn = line => lines.push(line); try { await body(); } finally { console.warn = warn; } return lines; };

test("the queued sweep is off with any storage flag off and fails closed without the issuer", async () => {
  let calls = 0, runs = 0;
  const runJob = async () => { runs++; };
  await withFetch(async () => { calls++; throw Error("unexpected IO"); }, async () => {
    for (const flag of ["CLUED_STORAGE_ACCOUNT_V1", "CLUED_STORAGE_JOBS_V1", "CLUED_STORAGE_JOBS_V2", "CLUED_STORAGE_GOOGLE_V1"])
      assert.deepEqual(await runStorageQueuedSweepScheduled({ ...env, [flag]: "false" }, { runJob }), { status: "disabled" });
    for (const value of [undefined, "short"])
      assert.deepEqual(await runStorageQueuedSweepScheduled({ ...env, CLUED_STORAGE_CONNECTOR_ISSUER: value }, { runJob }), { status: "unavailable" });
  });
  assert.equal(calls, 0); assert.equal(runs, 0);
});

test("a missing gateway dispatches nothing and never falls back to the publishable key", async () => {
  let calls = 0, runs = 0;
  await withFetch(async () => { calls++; assert.fail("unexpected database request"); }, async () => {
    for (const value of [undefined, "", " \n "])
      assert.deepEqual(await runStorageQueuedSweepScheduled({ ...env, CLUED_DB_GATEWAY_TOKEN: value }, { runJob: async () => { runs++; } }), { status: "unavailable" });
  });
  assert.equal(calls, 0); assert.equal(runs, 0);
});

test("the sweep calls only the fixed RPC with the issuer; dispatch is asked for only with the executor switch", async () => {
  const bodies = []; let reply = { status: "ok", settled: 1, jobs: [], root_busy: 2 };
  await withFetch(async (url, init) => {
    assert.equal(String(url), env.SUPABASE_URL + "/rest/v1/rpc/clued_storage_queued_sweep_v1");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer test-worker-gateway"); assert.equal(headers.get("apikey"), "fixture-public-key");
    assert.equal(init.redirect, "manual"); assert.equal(init.method, "POST");
    bodies.push(JSON.parse(init.body));
    return Response.json(reply);
  }, async () => {
    const runJob = async () => assert.fail("no job listed");
    assert.deepEqual(await runStorageQueuedSweepScheduled(env, { runJob }), { status: "ok", settled: 1, dispatched: 0, root_busy: 2 });
    assert.deepEqual(await runStorageQueuedSweepScheduled({ ...env, CLUED_STORAGE_EXECUTOR_V1: "false" }, { runJob }),
      { status: "ok", settled: 1, dispatched: 0, root_busy: 2 });
    const hash = createHash("sha256").update(issuer).digest("hex");
    assert.deepEqual(bodies, [{ p_issuer_hash: hash, p_input: { action: "due", dispatch: true } },
      { p_issuer_hash: hash, p_input: { action: "due", dispatch: false } }]);
    // Jobs listed although dispatch was not asked for is a contract breach.
    reply = { status: "ok", settled: 0, jobs: [job(1)], root_busy: 0 };
    assert.deepEqual(await runStorageQueuedSweepScheduled({ ...env, CLUED_STORAGE_EXECUTOR_V1: "false" }, { runJob }), { status: "unavailable" });
  });
});

test("the default public project is used when the Worker has no Supabase variables", async () => {
  let seen;
  await withFetch(async url => { seen = String(url); return Response.json({ status: "ok", settled: 0, jobs: [], root_busy: 0 }); }, async () => {
    const bare = { ...env }; delete bare.SUPABASE_URL; delete bare.SUPABASE_PUBLISHABLE_KEY;
    assert.equal((await runStorageQueuedSweepScheduled(bare, { runJob: async () => {} })).status, "ok");
  });
  assert.match(seen, /^https:\/\/[a-z0-9]+\.supabase\.co\/rest\/v1\/rpc\/clued_storage_queued_sweep_v1$/);
});

test("listed jobs go to the job queue exactly; a failed enqueue runs the job in place; one failure does not stop the rest", async () => {
  const sent = [], ran = [];
  await withFetch(async () => Response.json({ status: "ok", settled: 0, jobs: [job(1), job(2), job(3)], root_busy: 0 }), async () => {
    const queued = { ...env, CLUED_STORAGE_JOB_QUEUE: { send: async body => { sent.push(body); } } };
    assert.deepEqual(await runStorageQueuedSweepScheduled(queued, { runJob: async () => assert.fail("queue bound") }),
      { status: "ok", settled: 0, dispatched: 3, root_busy: 0 });
    assert.deepEqual(sent, [job(1), job(2), job(3)]);
    const broken = { ...env, CLUED_STORAGE_JOB_QUEUE: { send: async () => { throw Error("queue unavailable"); } } };
    const lines = await quiet(async () => {
      const result = await runStorageQueuedSweepScheduled(broken, { runJob: async (_env, reference) => {
        ran.push(reference); if (reference.job_id === job(2).job_id) throw Error("private-failure"); } });
      assert.deepEqual(result, { status: "ok", settled: 0, dispatched: 2, root_busy: 0 });
    });
    assert.deepEqual(ran, [job(1), job(2), job(3)]);
    assert.equal(lines.filter(line => line.includes("storage_job_enqueue_failed")).length, 3);
    assert.equal(lines.join("").includes("private-failure"), false);
  });
});

test("malformed or refused sweep replies are unavailable and dispatch nothing", async () => {
  let reply, status = 200;
  const runJob = async () => assert.fail("nothing may run");
  await withFetch(async () => new Response(JSON.stringify(reply), { status }), async () => {
    for (const bad of [null, { status: "denied", settled: 0, jobs: [], root_busy: 0 }, { status: "ok", settled: 4, jobs: [], root_busy: 0 },
      { status: "ok", settled: 0, jobs: [], root_busy: -1 }, { status: "ok", settled: "1", jobs: [], root_busy: 0 },
      { status: "ok", settled: 0, jobs: [job(1), job(2), job(3), job(4)], root_busy: 0 },
      { status: "ok", settled: 0, jobs: [{ ...job(1), extra: true }], root_busy: 0 },
      { status: "ok", settled: 0, jobs: [{ connection_id: "not-a-uuid", job_id: job(1).job_id }], root_busy: 0 },
      { status: "ok", settled: 0, jobs: {}, root_busy: 0 }]) {
      reply = bad;
      assert.deepEqual(await runStorageQueuedSweepScheduled(env, { runJob }), { status: "unavailable" }, JSON.stringify(bad));
    }
    reply = { message: "storage_queued_sweep_denied" }; status = 403;
    assert.deepEqual(await runStorageQueuedSweepScheduled(env, { runJob }), { status: "unavailable" });
  });
  await withFetch(async () => { throw Error("network"); }, async () => {
    assert.deepEqual(await runStorageQueuedSweepScheduled(env, { runJob }), { status: "unavailable" });
  });
});

const token = "clued_bnd_" + "a".repeat(40);
const ref = job(1);
const status = (state, extra = {}) => ({ ...ref, status: state, request_digest: "a".repeat(64), intent_id: null,
  receipt_id: "30000000-0000-4000-8000-000000000001", execution_permitted: false, ...extra });
const toolEnv = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_JOBS_V1: "true", SUPABASE_URL: env.SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" };
const call = async (name, args, ctx) => (await (await worker.fetch(new Request("https://clued.example.invalid/mcp", { method: "POST",
  headers: { "content-type": "application/json", origin: "https://clued.example.invalid", authorization: "Bearer " + token },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), toolEnv, ctx)).json()).result;
const mutation = { operation: "create", target_kind: "file", destination_path: "track/topic/example.md", content: "fixture" };

test("a submit on a stuck root is a fixed storage_root_busy refusal and dispatches nothing", async () => {
  const pending = [];
  await withFetch(async () => Response.json({ status: "rejected", error_code: "storage_root_busy", ...ref, execution_permitted: false,
    detail: "private-database-text" }), async () => {
    const result = await call("clued_storage_submit", { ...ref, mutation }, { waitUntil: p => pending.push(p) });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, "rejected"); assert.equal(result.structuredContent.error, "storage_root_busy");
    assert.match(result.structuredContent.message, /no job exists/);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ["error", "message", "status"]);
    assert.equal(JSON.stringify(result).includes("private-database-text"), false);
  });
  assert.equal(pending.length, 0);
  // Any other unknown refusal code still fails closed.
  await withFetch(async () => Response.json({ status: "rejected", error_code: "storage_something_else" }), async () => {
    const result = await call("clued_storage_submit", { ...ref, mutation }, { waitUntil: p => pending.push(p) });
    assert.equal(result.isError, true); assert.equal(result.structuredContent.error, "storage_job_unavailable");
  });
});

test("inspect names DISPATCH_NOT_STARTED with a fixed hint only for an attention_required job", async () => {
  let reply;
  await withFetch(async () => Response.json(reply), async () => {
    reply = status("attention_required", { reason_code: "DISPATCH_NOT_STARTED" });
    const result = await call("clued_storage_inspect", ref, { waitUntil: () => {} });
    assert.equal(result.isError, false); assert.equal(result.structuredContent.reason_code, "DISPATCH_NOT_STARTED");
    assert.match(result.structuredContent.hint, /nothing was changed in Drive/);
    for (const state of ["queued", "started", "committed"]) {
      reply = status(state, { reason_code: "DISPATCH_NOT_STARTED" });
      assert.equal((await call("clued_storage_inspect", ref, { waitUntil: () => {} })).isError, true, state);
    }
  });
});

test("a refused load leaves the job unreported and logs the fixed cause", async () => {
  const keys = { current_key_id: "v1", keys: { v1: Buffer.alloc(32, 7).toString("base64url") } };
  for (const [message, code] of [["storage_root_has_unresolved_mutation", "STORAGE_ROOT_BUSY"], ["storage_cloud_snapshot_changed", "STORAGE_JOB_LOAD_REFUSED"]]) {
    const actions = [];
    const executor = await createStorageCloudWorker({ client_id: "fixture-client", vault: keys, account_policy_v2: true,
      fetch: async () => { throw Error("provider must not run"); },
      rpc: async input => {
        actions.push(input.action);
        if (input.action === "verified_inspect") return { status: "none", ...ref, execution_permitted: false };
        if (input.action === "load") throw Error(message);
        throw Error("unexpected action " + input.action);
      } });
    let result;
    const lines = await quiet(async () => { result = await executor.run(ref); });
    assert.equal(result.status, "unavailable"); assert.equal(result.error_code, code);
    assert.deepEqual(actions, ["verified_inspect", "load"], "no report: the sweep dispatches the job again");
    assert.deepEqual(lines.map(line => JSON.parse(line)), [{ event: "storage_cloud_unavailable", error_code: code }]);
  }
});
