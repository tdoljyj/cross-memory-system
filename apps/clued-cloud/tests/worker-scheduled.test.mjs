import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Bundle the real entry point, replacing its I/O dependencies with spies.
// No database, provider, vinext server or Cloudflare runtime is started.
const entry = fileURLToPath(new URL("../worker/index.ts", import.meta.url));
const taskByKey = {
  projection_refresh: "wakeProjectionRefresh",
  storage_refresh: "runStorageRefreshScheduled",
  storage_recovery: "runStorageRecoveryScheduled",
  storage_unattempted_release: "runStorageUnattemptedReleaseScheduled",
  storage_queued_sweep: "runStorageQueuedSweepScheduled",
  storage_access_digest_backfill: "runStorageAccessDigestBackfillScheduled",
  storage_staging: "runStorageStagingScheduled",
  storage_onboard: "runStorageOnboardScheduled",
};
const modules = new Map([
  ["./continuity", Object.values(taskByKey).filter(name => ![
    taskByKey.storage_queued_sweep, taskByKey.storage_access_digest_backfill,
  ].includes(name))],
  ["./storage-queued-dispatch", [taskByKey.storage_queued_sweep]],
  ["./storage-access-digest-backfill", [taskByKey.storage_access_digest_backfill]],
]);
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-worker-scheduled-"));
const output = path.join(directory, "worker.mjs");
await build({
  stdin: { contents: `export { default as worker } from ${JSON.stringify(entry)};
    export * as continuity from ${JSON.stringify(path.resolve(path.dirname(entry), "continuity.ts"))};
    export { calls } from "scheduled-spies";`, resolveDir: path.dirname(entry) },
  outfile: output, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "scheduled-spies", setup(builder) {
    builder.onResolve({ filter: /^scheduled-spies$/ }, () => ({ path: "spies", namespace: "scheduled-test" }));
    builder.onResolve({ filter: /.*/ }, args => {
      if ((args.importer === entry || path.basename(args.importer) === "scheduled-registry.ts") &&
          (modules.has(args.path) || args.importer === entry && args.path !== "./scheduled-registry")) return { path: args.path, namespace: "scheduled-test" };
    });
    builder.onLoad({ filter: /.*/, namespace: "scheduled-test" }, args => {
      if (args.path === "spies") return { contents: `export const calls = [];
        export function invoke(name, args) { calls.push({ name, args }); return Promise.resolve({ status: "disabled" }); }` };
      const names = modules.get(args.path);
      if (names) return { resolveDir: path.dirname(entry), contents: `export * from ${JSON.stringify(path.resolve(path.dirname(entry), args.path + ".ts"))};
        import { invoke } from "scheduled-spies";
        ${names.map(name => `export const ${name} = (...args) => invoke(${JSON.stringify(name)}, args);`).join("\n")}` };
      const inert = {
        "vinext/server/image-optimization": "export const DEFAULT_DEVICE_SIZES = [], DEFAULT_IMAGE_SIZES = []; export function handleImageOptimization() {}",
        "vinext/server/app-router-entry": "export default {};",
        "./delegated-oauth": "export function delegatedOAuthEnabled() {} export function handleDelegatedOAuth() {}",
        "./storage-read-pdf-client": "export function createPdfExtractorCheckGate() {} export const PDF_EXTRACTOR_CHECK_PATH = '/check';",
        "./web-origin-routing.mjs": "export function routeStorageOrigin() {} export function routeWebOrigin() {}",
        "./oauth-origin.mjs": "export function selectOAuthOrigin() {} export class OAuthOriginConfigurationError extends Error {}",
      }[args.path];
      assert.ok(inert, `unmocked entry dependency: ${args.path}`);
      return { contents: inert };
    });
  } }],
});
const { worker, calls, continuity } = await import(pathToFileURL(output).href);
test.after(() => rm(directory, { recursive: true, force: true }));

const env = {
  SUPABASE_URL: "https://db.test", SUPABASE_PUBLISHABLE_KEY: "anon-test",
  CLUED_DB_GATEWAY_TOKEN: "synthetic-gateway", CLUED_PROJECTION_BUILDER_TOKEN: "clued_bnd_synthetic",
  CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_REFRESH_V1: "true",
  CLUED_STORAGE_JOBS_V1: "true", CLUED_STORAGE_JOBS_V2: "true", CLUED_STORAGE_EXECUTOR_V1: "true",
  CLUED_STORAGE_BINARY_V1: "true",
};
const idle = Object.fromEntries(Object.keys(taskByKey).map(key => [key, false]));
const reply = (due = idle) => ({ status: "ok", observed_at: "2026-11-18T00:00:00Z", due });

async function tick(t, respond, flags = env) {
  calls.length = 0;
  const pending = [];
  const requests = [];
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    return respond();
  });
  await worker.scheduled({ scheduledTime: Date.parse("2026-11-18T00:00:00Z"), cron: "*/10 * * * *" }, flags, {
    waitUntil(promise) { pending.push(promise); },
  });
  await Promise.all(pending);
  assert.deepEqual(requests.map(({ url }) => String(url)), ["https://db.test/rest/v1/rpc/clued_worker_due_v1"]);
  const { init } = requests[0];
  assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${flags.CLUED_DB_GATEWAY_TOKEN}`);
  assert.deepEqual(JSON.parse(init.body), {
    p_token_hash: createHash("sha256").update(flags.CLUED_DB_GATEWAY_TOKEN).digest("hex"),
  });
  assert.ok(init.signal instanceof AbortSignal, "due fetch has a deadline");
  for (const call of calls) assert.equal(call.args[0], flags);
  return { tasks: calls.map(call => call.name), pending: pending.length, warnings: warnings.length };
}

test("idle tick makes only the read-only due RPC and starts no task or heartbeat", async t => {
  assert.deepEqual(await tick(t, () => Response.json(reply())), { tasks: [], pending: 0, warnings: 0 });
});

for (const [key, task] of Object.entries(taskByKey)) {
  test(`due ${key} dispatches only ${task} under waitUntil`, async t => {
    assert.deepEqual(await tick(t, () => Response.json(reply({ ...idle, [key]: true }))),
      { tasks: [task], pending: 1, warnings: 0 });
  });
}

for (const [failure, respond] of Object.entries({
  timeout: () => { throw new DOMException("deadline exceeded", "TimeoutError"); },
  "HTTP 503": () => new Response(null, { status: 503 }),
  "broken JSON": () => new Response("{"),
  "bad status": () => Response.json({ ...reply(), status: "unavailable" }),
  "missing observation": () => Response.json({ due: idle, status: "ok" }),
  "partial flags": () => Response.json(reply({ projection_refresh: true })),
  "non-boolean flag": () => Response.json(reply({ ...idle, projection_refresh: true, storage_onboard: 0 })),
})) {
  test(`due failure (${failure}) warns once and starts no tasks`, async t => {
    assert.deepEqual(await tick(t, respond), { tasks: [], pending: 0, warnings: 1 });
  });
}

test("disabled tasks are never started even when all eight are due", async t => {
  const due = Object.fromEntries(Object.keys(taskByKey).map(key => [key, true]));
  const flags = { ...env, CLUED_PROJECTION_BUILDER_TOKEN: "", CLUED_STORAGE_ACCOUNT_V1: "false" };
  assert.deepEqual(await tick(t, () => Response.json(reply(due)), flags), { tasks: [], pending: 0, warnings: 0 });
});

test("executor off still allows queued settlement, release and onboard expiry", async t => {
  const due = Object.fromEntries(Object.keys(taskByKey).map(key => [key, true]));
  const flags = { ...env, CLUED_PROJECTION_BUILDER_TOKEN: "", CLUED_STORAGE_REFRESH_V1: "false",
    CLUED_STORAGE_EXECUTOR_V1: "false", CLUED_STORAGE_ONBOARD_V1: "false" };
  const result = await tick(t, () => Response.json(reply(due)), flags);
  assert.deepEqual(result.tasks.sort(), [taskByKey.storage_queued_sweep, taskByKey.storage_unattempted_release,
    taskByKey.storage_onboard].sort());
  assert.equal(result.pending, 3);
});

test("projection wake policy agrees with every advertised tool annotation", () => {
  const allEnabled = new Proxy({}, { get: () => "true" });
  for (const tool of continuity.publicMcpTools(allEnabled)) {
    assert.equal(continuity.isProjectionWriteTool(tool.name), tool.annotations.readOnlyHint === false, tool.name);
  }
  assert.equal(continuity.isProjectionWriteTool("unknown_tool"), false);
});
