import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { buildPdfExtractor } from "../scripts/build-pdf-extractor.mjs";
import { loadPdfExtractorBinding } from "./worker-continuity-loader.mjs";
import { encryptedPdf, flateLatinPdf, latinPdf, operatorBombPdf, toUnicodeBombPdf } from "./resource-center-storage-pdf.fixture.mjs";

// StorageNormalUse.v0.1 §4.5, Owner decision 7210e5a5: PDFs are parsed only by the extractor Worker clued-storage-pdf,
// which the main Worker calls through the PDF_EXTRACTOR service binding (RPC). Client (main side) and extractor entry
// point in Node, then both Workers under workerd (Miniflare) with a real service binding.
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-pdf-extractor-test-"));
await build({ entryPoints: [path.join(root, "worker/storage-read-pdf-client.ts")], outfile: path.join(directory, "client.mjs"), bundle: true,
  platform: "node", format: "esm", logLevel: "silent" });
stop();
const client = await import(pathToFileURL(path.join(directory, "client.mjs")).href);
const { connectPdfExtractor, checkPdfExtractor, createPdfExtractorCheckGate, validExtraction, validMarker, PDF_EXTRACTOR_STOPPED_HINT, PDF_EXTRACTOR_UNAVAILABLE_HINT,
  PDF_EXTRACTOR_BUSY_HINT, PDF_EXTRACTOR_CHECK_TEXT } = client;
const { core, binding } = await loadPdfExtractorBinding();
const MiB = 1024 * 1024;
const OPTIONS = { page_start: 1, page_count: 20, max_text_bytes: 262144, time_ms: 10000 };
const failure = async (promise) => { try { await promise; } catch (error) { return { code: error.code, hint: error.hint }; } return { code: "none" }; };
const never = () => new Promise(() => {});

test("client: a matching extractor returns the extraction, rebuilt field by field", async () => {
  const extractor = await connectPdfExtractor(binding);
  const result = await extractor.extract(flateLatinPdf([["Hello extractor"], ["Second page"]]), OPTIONS);
  assert.deepEqual(result, { page_count: 2, page_start: 1, pages_extracted: 2, text: "# Page 1\nHello extractor\n# Page 2\nSecond page", complete: true,
    time_limited: false, text_layer: "present", unreliable_pages: [], cmap_missing: false });
  // Only the file and the four options cross the binding.
  let sent;
  await (await connectPdfExtractor({ ...binding, extract: async (bytes, options) => { sent = { bytes, options }; return binding.extract(bytes, options); } }))
    .extract(latinPdf([["x"]]), { ...OPTIONS, secret: "never sent" });
  assert.deepEqual(Object.keys(sent.options).sort(), ["max_text_bytes", "page_count", "page_start", "time_ms"]);
  assert.ok(sent.bytes instanceof Uint8Array);
});

test("client: a missing binding, a wrong marker, a failed or slow marker call are storage_read_unavailable before any PDF is sent", async () => {
  let sent = 0;
  const counting = marker => ({ marker, extract: async () => { sent++; return { contract: "clued.storage-pdf-extractor/1", ok: false, code: "document_invalid" }; } });
  const good = await binding.marker();
  for (const [name, raw] of [["undefined", undefined], ["null", null], ["empty object", {}], ["fetch-only binding", { fetch: async () => new Response() }],
    ["wrong contract", counting(async () => ({ ...good, contract: "clued.storage-pdf-extractor/0" }))],
    ["older version", counting(async () => ({ ...good, version: good.version - 1 }))], ["two versions newer", counting(async () => ({ ...good, version: good.version + 2 }))],
    ["no decode guard", counting(async () => ({ ...good, decode_guard: false }))], ["font programs parsed", counting(async () => ({ ...good, font_programs: "parsed" }))],
    ["marker throws", counting(async () => { throw new Error("Network connection lost."); })], ["marker not an object", counting(async () => "ok")]]) {
    assert.deepEqual(await failure(connectPdfExtractor(raw)), { code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT }, name);
  }
  assert.deepEqual(await failure(connectPdfExtractor(counting(never), { markerTimeoutMs: 20 })), { code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT });
  assert.equal(sent, 0);
});

test("client: out of memory, a CPU limit or a timeout stops the read (same-way hint); any other failed call is unavailable (retry hint); never retried", async () => {
  const stopped = { code: "archive_limit_exceeded", hint: PDF_EXTRACTOR_STOPPED_HINT }, down = { code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT };
  for (const [message, expected] of [["Worker exceeded memory limit.", stopped], ["Worker exceeded CPU time limit.", stopped], ["Exceeded CPU Limit", stopped],
    ["Worker exceeded resource limits", stopped], ["RangeError: out of memory", stopped],
    ["Network connection lost.", down], ["internal error", down], ["This script has been upgraded. Please send a new request to connect to the new version.", down],
    ["The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.", down],
    ["Rate limit header missing", down], ["something unknown", down]]) {
    let calls = 0;
    const extractor = await connectPdfExtractor({ marker: binding.marker, extract: async () => { calls++; throw new Error(message); } });
    assert.deepEqual(await failure(extractor.extract(latinPdf([["x"]]), OPTIONS)), expected, message);
    assert.equal(calls, 1, message);
  }
  const thrown = await connectPdfExtractor({ marker: binding.marker, extract: async () => { throw "dropped"; } });
  assert.deepEqual(await failure(thrown.extract(latinPdf([["x"]]), OPTIONS)), down, "a non-Error rejection");
  // The call outlives its deadline plus the grace: stopped (archive_limit_exceeded), not awaited further.
  const slow = await connectPdfExtractor({ marker: binding.marker, extract: never }, { graceMs: 30 });
  const started = Date.now();
  assert.deepEqual(await failure(slow.extract(latinPdf([["x"]]), { ...OPTIONS, time_ms: 20 })), { code: "archive_limit_exceeded", hint: PDF_EXTRACTOR_STOPPED_HINT });
  assert.ok(Date.now() - started < 1000);
});

test("client: request and response are bounded; malformed or oversized results are refused", async () => {
  let calls = 0;
  const counted = await connectPdfExtractor({ marker: binding.marker, extract: async (...args) => { calls++; return binding.extract(...args); } });
  assert.deepEqual(await failure(counted.extract(new Uint8Array(20 * MiB + 1), OPTIONS)), { code: "binary_too_large", hint: undefined });
  assert.equal(calls, 0, "an oversized request is never sent");
  const good = await binding.extract(latinPdf([["bounded"]]), OPTIONS);
  const variants = [["wrong contract", { ...good, contract: "other" }], ["not an object", "text"], ["ok missing", { contract: good.contract }],
    ["text over the bound", { ...good, extraction: { ...good.extraction, text: "x".repeat(16 * MiB + 1) } }],
    ["page_start mismatch", { ...good, extraction: { ...good.extraction, page_start: 2 } }],
    ["more pages than asked", { ...good, extraction: { ...good.extraction, pages_extracted: 21 } }],
    ["unreliable page outside the selection", { ...good, extraction: { ...good.extraction, unreliable_pages: [7] } }],
    ["unknown text layer", { ...good, extraction: { ...good.extraction, text_layer: "maybe" } }],
    ["unknown failure code", { contract: good.contract, ok: false, code: "provider_text_here" }]];
  for (const [name, result] of variants) {
    const extractor = await connectPdfExtractor({ marker: binding.marker, extract: async () => result });
    assert.deepEqual(await failure(extractor.extract(latinPdf([["x"]]), OPTIONS)), { code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT }, name);
  }
  // The extractor's own fixed failure codes keep their meaning; busy carries the busy hint.
  for (const code of ["document_invalid", "archive_limit_exceeded", "binary_too_large", "storage_read_unavailable"]) {
    const extractor = await connectPdfExtractor({ marker: binding.marker, extract: async () => ({ contract: good.contract, ok: false, code }) });
    assert.deepEqual(await failure(extractor.extract(latinPdf([["x"]]), OPTIONS)), { code, hint: undefined }, code);
  }
  // Busy (the extractor's slot is still taken, e.g. by a read whose caller timed out) is unavailable with the short retry hint, not the same-way hint.
  const busy = await connectPdfExtractor({ marker: binding.marker, extract: async () => ({ contract: good.contract, ok: false, code: "storage_read_unavailable", busy: true }) });
  assert.deepEqual(await failure(busy.extract(latinPdf([["x"]]), OPTIONS)), { code: "storage_read_unavailable", hint: PDF_EXTRACTOR_BUSY_HINT });
  assert.match(PDF_EXTRACTOR_BUSY_HINT, /Retry the same read in a few seconds/);
  assert.notEqual(PDF_EXTRACTOR_BUSY_HINT, PDF_EXTRACTOR_STOPPED_HINT);
  assert.equal(validExtraction(good.extraction, OPTIONS).text, "# Page 1\nbounded");
});

test("extractor entry point: marker, option and byte validation, fixed failure codes, one PDF per isolate", async () => {
  assert.deepEqual(await core.extractorMarker(), { contract: "clued.storage-pdf-extractor/1", version: 1, decode_guard: true, font_programs: "skipped" });
  assert.equal((await core.extractorMarker(async () => false)).decode_guard, false);
  const pdf = latinPdf([["entry point"]]);
  for (const [name, bytes, options] of [["no bytes", undefined, OPTIONS], ["string bytes", "%PDF", OPTIONS], ["empty", new Uint8Array(0), OPTIONS],
    ["extra option", pdf, { ...OPTIONS, clock: 1 }], ["missing option", pdf, { page_start: 1, page_count: 1, max_text_bytes: 1 }],
    ["page_count 21", pdf, { ...OPTIONS, page_count: 21 }], ["page_start 0", pdf, { ...OPTIONS, page_start: 0 }], ["fractional", pdf, { ...OPTIONS, max_text_bytes: 1.5 }],
    ["text over 8 MiB", pdf, { ...OPTIONS, max_text_bytes: 8 * MiB + 1 }], ["time over 10 s", pdf, { ...OPTIONS, time_ms: 10001 }], ["options array", pdf, []]])
    assert.deepEqual(await core.runExtraction(bytes, options), { contract: "clued.storage-pdf-extractor/1", ok: false, code: "storage_read_unavailable" }, name);
  assert.deepEqual(await core.runExtraction(new Uint8Array(20 * MiB + 1), OPTIONS), { contract: "clued.storage-pdf-extractor/1", ok: false, code: "binary_too_large" });
  const ok = await core.runExtraction(pdf, OPTIONS);
  assert.equal(ok.ok, true); assert.equal(ok.extraction.text, "# Page 1\nentry point");
  // pdf.js takes ownership of (detaches) the buffer it is given, so each call gets its own copy.
  assert.equal((await core.runExtraction(latinPdf([["entry point"]]).buffer, OPTIONS)).ok, true, "an ArrayBuffer is accepted");
  assert.deepEqual(await core.runExtraction(encryptedPdf(), OPTIONS), { contract: "clued.storage-pdf-extractor/1", ok: false, code: "document_invalid" });
  assert.deepEqual(await core.runExtraction(operatorBombPdf(100 * MiB), OPTIONS), { contract: "clued.storage-pdf-extractor/1", ok: false, code: "archive_limit_exceeded" });
  // A second PDF while one runs in this isolate waits briefly for the slot (the wait taken off its time_ms), then is refused as busy.
  const empty = { page_count: 1, page_start: 1, pages_extracted: 0, text: "", complete: true, time_limited: false, text_layer: "present", unreliable_pages: [], cmap_missing: false };
  let release;
  const held = core.runExtraction(latinPdf([["held"]]), OPTIONS, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await core.runExtraction(latinPdf([["second"]]), OPTIONS, undefined, 30), { contract: "clued.storage-pdf-extractor/1", ok: false, code: "storage_read_unavailable", busy: true });
  let seen;
  const waiting = core.runExtraction(latinPdf([["third"]]), OPTIONS, async (bytes, options) => { seen = options; return empty; });
  await new Promise(resolve => setTimeout(resolve, 50));
  release(empty);
  assert.equal((await held).ok, true);
  assert.equal((await waiting).ok, true, "a read that finds the slot freed within the wait runs");
  assert.ok(seen.time_ms < OPTIONS.time_ms && seen.time_ms > OPTIONS.time_ms - 2000, "the wait is taken off its time_ms");
  // An unexpected exception is classified, never passed through.
  assert.deepEqual(await core.runExtraction(latinPdf([["x"]]), OPTIONS, async () => { throw new RangeError("Array buffer allocation failed"); }),
    { contract: "clued.storage-pdf-extractor/1", ok: false, code: "storage_read_unavailable" });
});

test("release check: the extractor's fixed check PDF passes through a working binding, reports the extractor's own marker, and reports anything else", async () => {
  assert.deepEqual(await checkPdfExtractor(binding), { contract: "clued.storage-pdf-extractor-check/1", status: "ok",
    extractor: { contract: "clued.storage-pdf-extractor/1", version: 1 } });
  for (const raw of [undefined, null, {}, { marker: binding.marker, extract: binding.extract }])
    assert.deepEqual(await checkPdfExtractor(raw), { contract: "clued.storage-pdf-extractor-check/1", status: "unavailable", extractor: null, code: "storage_read_unavailable" });
  assert.equal((await checkPdfExtractor({ check: async () => { throw new Error("Worker exceeded memory limit."); } })).code, "archive_limit_exceeded");
  assert.equal((await checkPdfExtractor({ check: async () => { throw new Error("Network connection lost."); } })).code, "storage_read_unavailable");
  assert.equal((await checkPdfExtractor({ check: () => new Promise(() => {}) }, { timeoutMs: 20 })).code, "storage_read_unavailable");
  const good = await binding.check();
  // The extractor's own marker is reported, also when it is not accepted.
  const older = await checkPdfExtractor({ check: async () => ({ ...good, marker: { ...good.marker, version: 0 } }) });
  assert.deepEqual(older, { contract: "clued.storage-pdf-extractor-check/1", status: "unavailable", extractor: { contract: "clued.storage-pdf-extractor/1", version: 0 },
    code: "extractor_marker_invalid" });
  const wrong = await checkPdfExtractor({ check: async () => ({ ...good, result: { ...good.result, extraction: { ...good.result.extraction, text: "# Page 1\nother" } } }) });
  assert.deepEqual([wrong.status, wrong.code], ["unavailable", "check_text_mismatch"]);
  const busy = await checkPdfExtractor({ check: async () => ({ ...good, result: { contract: good.result.contract, ok: false, code: "storage_read_unavailable", busy: true } }) });
  assert.deepEqual([busy.status, busy.code], ["unavailable", "check_busy"]);
  assert.equal(PDF_EXTRACTOR_CHECK_TEXT, "# Page 1\nClued PDF extractor check");
});

test("release check: a check flood never takes the user PDF slot, so real extractions keep working", async () => {
  // Twenty checks at once alongside a real extraction: the extraction succeeds; one check parses, the others are answered busy at once.
  const [read, ...checks] = await Promise.all([binding.extract(flateLatinPdf([["real read"]]), OPTIONS), ...Array.from({ length: 20 }, () => binding.check())]);
  assert.equal(read.ok, true); assert.equal(read.extraction.text, "# Page 1\nreal read");
  assert.ok(checks.filter(c => c.result.ok === true).length >= 1);
  assert.ok(checks.every(c => c.result.ok === true || c.result.busy === true));
  // While a user extraction holds the slot, a check still runs (and does not wait for it); afterwards the slot is free for the next read.
  let release;
  const held = core.runExtraction(latinPdf([["held"]]), OPTIONS, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await binding.check()).result.ok, true);
  release({ page_count: 1, page_start: 1, pages_extracted: 1, text: "# Page 1\nheld", complete: true, time_limited: false, text_layer: "present", unreliable_pages: [], cmap_missing: false });
  assert.equal((await held).ok, true);
  assert.equal((await binding.extract(latinPdf([["after"]]), OPTIONS)).ok, true);
  // A running check makes concurrent checks busy, never user reads.
  let finish;
  const slowCheck = core.runCheck(() => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await core.runCheck()).result.busy, true);
  assert.equal((await binding.extract(latinPdf([["during check"]]), OPTIONS)).ok, true);
  finish({ page_count: 1, page_start: 1, pages_extracted: 1, text: PDF_EXTRACTOR_CHECK_TEXT, complete: true, time_limited: false, text_layer: "present", unreliable_pages: [], cmap_missing: false });
  assert.equal((await slowCheck).result.ok, true);
});

test("release check route: results are cached per isolate (OK 60 s, failure 5 s) and only one check is in flight; nothing bypasses it", async () => {
  let clock = 1_000_000, calls = 0, next = "ok", gateOpen = null;
  const run = async () => { calls++; if (gateOpen) await gateOpen; return next === "ok" ? { contract: "clued.storage-pdf-extractor-check/1", status: "ok",
    extractor: { contract: "clued.storage-pdf-extractor/1", version: 1 } } : { contract: "clued.storage-pdf-extractor-check/1", status: "unavailable", extractor: null, code: "storage_read_unavailable" }; };
  const gate = createPdfExtractorCheckGate({ now: () => clock, run });
  const first = await gate(binding);
  assert.deepEqual([first.status, first.cached, first.checked_at], ["ok", false, new Date(1_000_000).toISOString()]);
  for (let i = 0; i < 100; i++) { clock += 500; assert.equal((await gate(binding)).cached, true); }
  assert.equal(calls, 1, "a flood within 60 s is served from the cache");
  const replay = await gate(binding);
  assert.deepEqual([replay.status, replay.checked_at, replay.extractor.version], ["ok", new Date(1_000_000).toISOString(), 1]);
  clock = 1_000_000 + 60_000;
  assert.equal((await gate(binding)).cached, false); assert.equal(calls, 2, "after 60 s a real round trip runs again");
  // A failure is cached for 5 s only.
  next = "fail"; clock += 60_000;
  assert.equal((await gate(binding)).status, "unavailable"); assert.equal(calls, 3);
  clock += 4_000; assert.equal((await gate(binding)).cached, true); assert.equal(calls, 3);
  clock += 1_000; next = "ok"; assert.equal((await gate(binding)).status, "ok"); assert.equal(calls, 4);
  // Single flight: requests during a running check get the last result (or check_in_progress) without calling the extractor.
  clock += 60_000;
  let open; gateOpen = new Promise(resolve => { open = resolve; });
  const leader = gate(binding);
  const during = await Promise.all(Array.from({ length: 10 }, () => gate(binding)));
  assert.ok(during.every(r => r.cached === true && r.status === "ok")); assert.equal(calls, 5);
  open(); gateOpen = null; assert.equal((await leader).cached, false);
  const fresh = createPdfExtractorCheckGate({ now: () => clock, run: () => new Promise(() => {}) });
  void fresh(binding);
  assert.deepEqual(await fresh(binding), { contract: "clued.storage-pdf-extractor-check/1", status: "unavailable", extractor: null, code: "check_in_progress", checked_at: null, cached: false });
  // A check whose request was canceled (never settled) stops counting as in flight after its timeout.
  let ran = false;
  const recovered = createPdfExtractorCheckGate({ now: () => clock, run: async () => { if (!ran) { ran = true; return new Promise(() => {}); } return run(); } });
  void recovered(binding); clock += 20_000;
  assert.equal((await recovered(binding)).status, "ok");
  // The route reads nothing from the request (no bypass parameter).
  const index = await readFile(path.join(root, "worker/index.ts"), "utf8");
  assert.match(index, /const pdfExtractorCheck = createPdfExtractorCheckGate\(\);/);
  assert.match(index, /await pdfExtractorCheck\(env\.PDF_EXTRACTOR\)/);
  const route = index.slice(index.indexOf("url.pathname === PDF_EXTRACTOR_CHECK_PATH"), index.indexOf("handleContinuityRequest(request"));
  assert.doesNotMatch(route, /searchParams|request\.(?:json|text|arrayBuffer|headers)/);
});

test("version skew: the main Worker accepts its extractor version and its neighbours (N-1, N+1), never others, with the strict contract and patch markers", async () => {
  const good = await binding.marker();
  assert.equal(validMarker(good), true);
  assert.equal(validMarker({ ...good, version: 4 }, 5), true, "N-1");
  assert.equal(validMarker({ ...good, version: 5 }, 5), true, "N");
  // The release deploys the extractor first: the previous main Worker meets the next version.
  assert.equal(validMarker({ ...good, version: 6 }, 5), true, "N+1");
  for (const [name, marker] of [["N-2", { ...good, version: 3 }], ["N+2", { ...good, version: 7 }], ["string version", { ...good, version: "4" }],
    ["other contract", { ...good, version: 4, contract: "clued.storage-pdf-extractor/2" }], ["no decode guard", { ...good, version: 4, decode_guard: false }],
    ["font programs", { ...good, version: 4, font_programs: "parsed" }]])
    assert.equal(validMarker(marker, 5), false, name);
  // At version 1 there is no N-1: version 0 is refused; version 2 (the next) is accepted.
  assert.equal(validMarker({ ...good, version: 0 }), false);
  assert.equal(validMarker({ ...good, version: 2 }), true);
});

test("configuration: the extractor Worker has no bindings, no public route and a CPU limit; the main Worker binds it by name", async () => {
  const extractor = JSON.parse(await readFile(path.join(root, "wrangler.pdf-extractor.jsonc"), "utf8"));
  assert.equal(extractor.name, "clued-storage-pdf");
  assert.equal(extractor.workers_dev, false); assert.equal(extractor.preview_urls, false);
  assert.ok(Number.isInteger(extractor.limits.cpu_ms) && extractor.limits.cpu_ms >= 10000 && extractor.limits.cpu_ms <= 30000);
  assert.deepEqual(extractor.compatibility_flags, ["nodejs_als"]);
  for (const key of ["kv_namespaces", "r2_buckets", "d1_databases", "services", "queues", "vars", "durable_objects", "hyperdrive", "ai", "images", "assets",
    "routes", "route", "triggers", "secrets_store_secrets", "analytics_engine_datasets", "browser", "vectorize", "workflows", "send_email", "mtls_certificates", "dispatch_namespaces"])
    assert.equal(key in extractor, false, key);
  const main = JSON.parse(await readFile(path.join(root, "wrangler.production.jsonc"), "utf8"));
  assert.deepEqual(main.services.find(s => s.binding === "PDF_EXTRACTOR"), { binding: "PDF_EXTRACTOR", service: "clued-storage-pdf" });
  // The main Worker's code never imports pdf.js (storage-read-pdf.ts); only the extractor does.
  for (const file of ["worker/storage-read-agent.ts", "worker/continuity.ts", "worker/index.ts", "worker/storage-read-pdf-client.ts", "worker/storage-read-pdf-common.ts"]) {
    const source = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /from "\.\/storage-read-pdf"|from "pdfjs-dist|import\("pdfjs-dist|from "\.\/storage-pdf-extractor/, file);
  }
  const vite = await readFile(path.join(root, "vite.config.ts"), "utf8");
  assert.doesNotMatch(vite, /pdfDecodeGuardVitePlugin|pdfjs/);
});

// The same two Workers under workerd: the built extractor bundle (wrangler.pdf-extractor.jsonc's main and flags) and a
// caller with the PDF_EXTRACTOR service binding, plus stand-in extractors that crash, hang, or answer with another version.
test("workerd: the main side reads PDF text through a real service binding and fails closed on every broken extractor", { timeout: 120000 }, async () => {
  const { Miniflare } = await import("miniflare");
  const config = JSON.parse(await readFile(path.join(root, "wrangler.pdf-extractor.jsonc"), "utf8"));
  const { outfile } = await buildPdfExtractor({ outdir: path.join(directory, "extractor") });
  const { outputFiles } = await build({ stdin: { resolveDir: root, sourcefile: "caller.ts", contents: `
      import { connectPdfExtractor, checkPdfExtractor } from "./worker/storage-read-pdf-client.ts";
      export default { async fetch(request, env) {
        const url = new URL(request.url), target = env[url.searchParams.get("binding") ?? "PDF_EXTRACTOR"];
        if (url.pathname === "/check") return Response.json(await checkPdfExtractor(target));
        try {
          const extractor = await connectPdfExtractor(target, { graceMs: 200 });
          const r = await extractor.extract(new Uint8Array(await request.arrayBuffer()), { page_start: 1, page_count: 20, max_text_bytes: 262144, time_ms: Number(url.searchParams.get("time") ?? 10000) });
          return Response.json({ ok: true, text: r.text.slice(0, 200), complete: r.complete });
        } catch (error) { return Response.json({ ok: false, code: error.code ?? "unexpected", hint: error.hint ?? null }); }
      } };` }, bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent" });
  stop();
  const stub = body => `import { WorkerEntrypoint } from "cloudflare:workers";
    export default class extends WorkerEntrypoint { async marker() { return { contract: "clued.storage-pdf-extractor/1", version: 1, decode_guard: true, font_programs: "skipped" }; } ${body} }`;
  const worker = (name, contents, { flags = config.compatibility_flags, env } = {}) => ({ config: { name, type: "worker", compatibilityDate: config.compatibility_date,
    compatibilityFlags: flags, manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents } } }, ...(env ? { env } : {}) } });
  const service = workerName => ({ type: "worker", workerName });
  const runtime = new Miniflare({ host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false }, workers: [
    worker("caller", outputFiles[0].text, { flags: ["nodejs_compat"], env: { PDF_EXTRACTOR: service("clued-storage-pdf"), CRASHING: service("crashing"),
      HANGING: service("hanging"), DEADLOCKED: service("deadlocked"), OLDER: service("older") } }),
    worker("clued-storage-pdf", await readFile(outfile, "utf8")),
    worker("crashing", stub('async extract() { throw new Error("Worker exceeded memory limit."); }')),
    // Runs past the caller's deadline (a timer keeps it alive), and one that can never finish (workerd ends that call itself).
    worker("hanging", stub("async extract() { await new Promise(resolve => setTimeout(resolve, 5000)); return null; }")),
    worker("deadlocked", stub("async extract() { await new Promise(() => {}); }")),
    worker("older", stub("async extract() { return null; }").replace("version: 1", "version: 0")),
  ] });
  const read = async (pdf, query = "") => (await runtime.dispatchFetch(`http://localhost/read?${query}`, { method: "POST", body: pdf })).json();
  try {
    assert.deepEqual(await (await runtime.dispatchFetch("http://localhost/check")).json(), { contract: "clued.storage-pdf-extractor-check/1", status: "ok",
      extractor: { contract: "clued.storage-pdf-extractor/1", version: 1 } });
    assert.deepEqual(await read(flateLatinPdf([["Hello workerd"], ["Second page"]])), { ok: true, text: "# Page 1\nHello workerd\n# Page 2\nSecond page", complete: true });
    // The extractor's own limits still answer first, as fixed codes.
    assert.deepEqual(await read(operatorBombPdf(100 * MiB)), { ok: false, code: "archive_limit_exceeded", hint: null });
    assert.deepEqual(await read(toUnicodeBombPdf(200 * MiB)), { ok: false, code: "archive_limit_exceeded", hint: null });
    assert.deepEqual(await read(encryptedPdf()), { ok: false, code: "document_invalid", hint: null });
    assert.deepEqual(await read(latinPdf([["x"]]), "binding=CRASHING"), { ok: false, code: "archive_limit_exceeded", hint: PDF_EXTRACTOR_STOPPED_HINT });
    assert.deepEqual(await read(latinPdf([["x"]]), "binding=HANGING&time=100"), { ok: false, code: "archive_limit_exceeded", hint: PDF_EXTRACTOR_STOPPED_HINT });
    assert.deepEqual(await read(latinPdf([["x"]]), "binding=DEADLOCKED"), { ok: false, code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT });
    assert.deepEqual(await read(latinPdf([["x"]]), "binding=OLDER"), { ok: false, code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT });
    assert.deepEqual(await read(latinPdf([["x"]]), "binding=MISSING"), { ok: false, code: "storage_read_unavailable", hint: PDF_EXTRACTOR_UNAVAILABLE_HINT });
    assert.equal((await (await runtime.dispatchFetch("http://localhost/check?binding=CRASHING")).json()).status, "unavailable");
    // The extractor still serves after the failures above.
    assert.equal((await read(latinPdf([["still serving"]]))).text, "# Page 1\nstill serving");
    // A flood of checks through the real binding does not make a concurrent real read busy.
    const [flooded, ...checks] = await Promise.all([read(flateLatinPdf([["during a check flood"]])),
      ...Array.from({ length: 20 }, async () => (await runtime.dispatchFetch("http://localhost/check")).json())]);
    assert.deepEqual(flooded, { ok: true, text: "# Page 1\nduring a check flood", complete: true });
    assert.ok(checks.some(c => c.status === "ok"));
    assert.ok(checks.every(c => c.status === "ok" || c.code === "check_busy"));
  } finally { await runtime.dispose(); }
});
