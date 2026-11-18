import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Bundle the real entry point, replacing its I/O dependencies with spies.
// No database, provider, vinext server or Cloudflare runtime is started.
const entry = fileURLToPath(new URL("../worker/index.ts", import.meta.url));
const storage = [
  "runStorageRefreshScheduled", "runStorageRecoveryScheduled",
  "runStorageUnattemptedReleaseScheduled", "runStorageQueuedSweepScheduled",
  "runStorageAccessDigestBackfillScheduled", "runStorageStagingScheduled",
  "runStorageOnboardScheduled",
];
const projection = "runProjectionRefreshScheduled";
const modules = new Map([
  ["./continuity", [projection, ...storage.filter(name => ![
    "runStorageQueuedSweepScheduled", "runStorageAccessDigestBackfillScheduled",
  ].includes(name)), "handleContinuityRequest", "runStorageJobQueue", "runStorageCloudJob"]],
  ["./storage-queued-dispatch", ["runStorageQueuedSweepScheduled"]],
  ["./storage-access-digest-backfill", ["runStorageAccessDigestBackfillScheduled"]],
]);
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-worker-scheduled-"));
const output = path.join(directory, "worker.mjs");
await build({
  stdin: { contents: `export { default as worker } from ${JSON.stringify(entry)};
    export { calls } from "scheduled-spies";`, resolveDir: path.dirname(entry) },
  outfile: output, bundle: true, platform: "node", format: "esm",
  plugins: [{ name: "scheduled-spies", setup(builder) {
    builder.onResolve({ filter: /^scheduled-spies$/ }, () => ({ path: "spies", namespace: "scheduled-test" }));
    builder.onResolve({ filter: /.*/ }, args => {
      if (args.importer === entry) return { path: args.path, namespace: "scheduled-test" };
    });
    builder.onLoad({ filter: /.*/, namespace: "scheduled-test" }, args => {
      if (args.path === "spies") return { contents: `export const calls = [];
        export function invoke(name, args) { calls.push({ name, args }); return Promise.resolve({ status: "disabled" }); }` };
      const names = modules.get(args.path);
      if (names) return { contents: `import { invoke } from "scheduled-spies";
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
const { worker, calls } = await import(pathToFileURL(output).href);
test.after(() => rm(directory, { recursive: true, force: true }));

const env = { marker: "synthetic-schedule-env" };
async function tick(iso) {
  calls.length = 0;
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.parse(iso), cron: "* * * * *" }, env, {
    waitUntil(promise) { pending.push(promise); },
  });
  await Promise.all(pending);
  assert.equal(pending.length, calls.length, "every started task is held by waitUntil");
  for (const call of calls) assert.equal(call.args[0], env, "task receives the original environment");
  return calls.map(call => call.name);
}

test("each minute runs only its assigned storage task; unused slots perform no storage I/O", async () => {
  for (let slot = 0; slot < 10; slot++) {
    const invoked = await tick(`2026-11-18T00:0${slot}:00.000Z`);
    assert.deepEqual(invoked.filter(name => name !== projection), slot < storage.length ? [storage[slot]] : [], `minute slot ${slot}`);
  }
});

test("every sliding ten-minute window runs each storage task exactly once across the hour/day boundary", async () => {
  const start = Date.parse("2026-11-18T23:55:00.000Z");
  const minutes = [];
  for (let minute = 0; minute < 69; minute++) {
    minutes.push(await tick(new Date(start + minute * 60_000).toISOString()));
  }
  for (let offset = 0; offset < 60; offset++) {
    const window = minutes.slice(offset, offset + 10).flat().filter(name => name !== projection);
    assert.deepEqual([...window].sort(), [...storage].sort(), `window ${offset}`);
  }
});

test("projection refresh runs every two scheduled minutes within the five-minute watchdog threshold", async () => {
  for (let minute = 0; minute < 10; minute++) {
    const invoked = await tick(`2026-11-18T00:0${minute}:00.000Z`);
    assert.equal(invoked.filter(name => name === projection).length, minute % 2 === 0 ? 1 : 0);
  }
});

test("delayed delivery uses scheduledTime rather than the wall clock", async () => {
  const original = Date.now;
  Date.now = () => Date.parse("2026-11-19T12:09:00.000Z");
  try {
    const invoked = await tick("2026-11-18T23:54:00.000Z");
    assert.deepEqual(invoked, [projection, storage[4]]);
  } finally { Date.now = original; }
});
