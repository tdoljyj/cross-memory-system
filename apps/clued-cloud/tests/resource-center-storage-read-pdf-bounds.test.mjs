import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { patchPdfWorker, pdfDecodeGuardEsbuildPlugin } from "../build/pdfjs-decode-guard.mjs";
import { flateLatinPdf, longStringPdf, operatorBombPdf, repeatedStreamPdf, textBombPdf, toUnicodeBombPdf } from "./resource-center-storage-pdf.fixture.mjs";

// StorageNormalUse.v0.1 §4.5 resource bounds (independent review MAJOR): small
// deflate bombs must not exhaust a Worker isolate. Each case runs in its own
// child with a 64 MB JS heap (half a Worker isolate); the child reports time
// and the peak ArrayBuffer / heap use sampled at every decode allocation.
// Before the fix a 71 KB PDF took 12 s CPU and a 178 KB PDF crashed a 128 MB heap.
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-storage-pdf-bounds-"));
const entry = fileURLToPath(new URL("../worker/storage-read-pdf.ts", import.meta.url));
await build({ entryPoints: [entry], outfile: path.join(directory, "guarded.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
  plugins: [pdfDecodeGuardEsbuildPlugin()] });
// The same module bundled WITHOUT the pdf.js patch, as a build that skipped it would be.
await build({ entryPoints: [entry], outfile: path.join(directory, "unguarded.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
stop();
const child = path.join(directory, "child.mjs");
await writeFile(child, `
import { readFile } from "node:fs/promises";
import v8 from "node:v8";
const [bundle, file, maxText] = process.argv.slice(2);
const { extractPdfText } = await import(bundle);
const run = bytes => extractPdfText(bytes, { page_start: 1, page_count: 20, max_text_bytes: Number(maxText) });
let peakBuffers = 0, peakHeap = 0;
try { await run(new Uint8Array(await readFile(file + ".warm"))); } catch {}
const guard = globalThis.__cluedPdfDecodeGuard;
if (typeof guard === "function") globalThis.__cluedPdfDecodeGuard = (kind, stream, bytes) => {
  if (kind === "decode") { peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers); peakHeap = Math.max(peakHeap, v8.getHeapStatistics().used_heap_size); }
  return guard(kind, stream, bytes);
};
const bytes = new Uint8Array(await readFile(file));
const started = performance.now(), cpu = process.cpuUsage();
let outcome;
try { const r = await run(bytes); outcome = { ok: true, text_bytes: Buffer.byteLength(r.text), complete: r.complete, pages: r.pages_extracted }; }
catch (error) { outcome = { ok: false, code: error.code ?? String(error) }; }
const used = process.cpuUsage(cpu);
process.stdout.write(JSON.stringify({ ...outcome, wall_ms: Math.round(performance.now() - started), cpu_ms: Math.round((used.user + used.system) / 1000),
  peak_buffers_mb: Math.round(peakBuffers / 1048576), peak_heap_mb: Math.round(peakHeap / 1048576) }));
`);
await writeFile(path.join(directory, "warm"), flateLatinPdf([["warm up"]]));

let seq = 0;
async function measure(pdf, { bundle = "guarded.mjs", maxText = 256 * 1024 } = {}) {
  const file = path.join(directory, `case-${++seq}.pdf`);
  await writeFile(file, pdf); await writeFile(file + ".warm", flateLatinPdf([["warm up"]]));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=64", child, path.join(directory, bundle), file, String(maxText)],
    { env, timeout: 60000, maxBuffer: 1 << 20 });
  return JSON.parse(stdout.slice(stdout.indexOf("{")));
}

const MiB = 1024 * 1024;
for (const [name, pdf, expect, seconds] of [
  ["7 MB text bomb stops at the 256 KiB text limit", () => textBombPdf(7 * MiB), r => r.ok && !r.complete && r.text_bytes >= 256 * 1024 && r.text_bytes < 320 * 1024, 5],
  ["300 MB text bomb (about 1 MB file)", () => textBombPdf(300 * MiB), r => r.code === "archive_limit_exceeded", 5],
  ["100 MB operator bomb (about 100 KB file)", () => operatorBombPdf(100 * MiB), r => r.code === "archive_limit_exceeded", 5],
  ["7 MB operator bomb inside the decode limits ends by the token limit or completes", () => operatorBombPdf(7 * MiB),
    r => (r.ok && r.complete) || r.code === "archive_limit_exceeded", 12],
  ["200 references to one 1 MB stream", () => repeatedStreamPdf(200, MiB), r => r.code === "archive_limit_exceeded", 5],
  ["200 MB ToUnicode CMap bomb (native DecompressionStream)", () => toUnicodeBombPdf(200 * MiB), r => r.code === "archive_limit_exceeded", 5],
  ["7 MB single string", () => longStringPdf(7 * MiB), r => r.code === "archive_limit_exceeded", 5],
]) {
  test(`bounded under a 64 MB heap: ${name}`, { timeout: 90000 }, async t => {
    const result = await measure(pdf());
    t.diagnostic(JSON.stringify(result));
    assert.ok(expect(result), JSON.stringify(result));
    assert.ok(result.wall_ms < seconds * 1000, `time: ${JSON.stringify(result)}`);
    assert.ok(result.peak_buffers_mb < 64, `decoded buffers: ${JSON.stringify(result)}`);
    assert.ok(result.peak_heap_mb < 64, `heap: ${JSON.stringify(result)}`);
  });
}

test("a bundle whose pdf.js worker lacks the decode guard refuses every PDF (storage_read_unavailable)", { timeout: 90000 }, async () => {
  const result = await measure(flateLatinPdf([["Hello"]]), { bundle: "unguarded.mjs" });
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: "storage_read_unavailable" });
});

// The guard finds its extraction through AsyncLocalStorage across pdf.js's
// in-thread worker promise jobs; check that workerd propagates it like Node.
test("native workerd: guarded pdf.js reads FlateDecode text and refuses a decode bomb", { timeout: 90000 }, async () => {
  const { Miniflare } = await import("miniflare");
  const { outputFiles } = await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "pdf-runtime.ts", contents: `
      import { extractPdfText } from "./worker/storage-read-pdf.ts";
      export default { async fetch(request) {
        try { const r = await extractPdfText(new Uint8Array(await request.arrayBuffer()), { page_start: 1, page_count: 20, max_text_bytes: 262144 });
          return Response.json({ ok: true, text: r.text.slice(0, 200), text_bytes: r.text.length, complete: r.complete }); }
        catch (error) { return Response.json({ ok: false, code: error.code ?? "unexpected" }); }
      } };` }, bundle: true, platform: "neutral", conditions: ["workerd", "worker", "browser"], mainFields: ["module", "main"], external: ["node:*"],
    format: "esm", write: false, logLevel: "silent", plugins: [pdfDecodeGuardEsbuildPlugin()] });
  stop();
  const runtime = new Miniflare({ host: "127.0.0.1", port: 0, cf: false, telemetry: { enabled: false }, workers: [{
    config: { name: "pdf-bounds-runtime", type: "worker", compatibilityDate: "2026-08-23", compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: outputFiles[0].text } } } } }] });
  const read = async pdf => (await runtime.dispatchFetch("http://localhost/", { method: "POST", body: pdf })).json();
  try {
    assert.deepEqual(await read(flateLatinPdf([["Hello flate world"], ["Second page"]])),
      { ok: true, text: "# Page 1\nHello flate world\n# Page 2\nSecond page", text_bytes: 47, complete: true });
    assert.deepEqual(await read(operatorBombPdf(100 * MiB)), { ok: false, code: "archive_limit_exceeded" });
    assert.deepEqual(await read(toUnicodeBombPdf(200 * MiB)), { ok: false, code: "archive_limit_exceeded" });
    const text = await read(textBombPdf(7 * MiB));
    assert.equal(text.ok, true); assert.equal(text.complete, false); assert.ok(text.text_bytes >= 256 * 1024 && text.text_bytes < 320 * 1024, JSON.stringify(text.text_bytes));
  } finally { await runtime.dispose(); }
});

test("the patch fails the build when pdf.js does not match the pinned anchors", () => {
  assert.throws(() => patchPdfWorker("export const WorkerMessageHandler = {};"), /does not match the pinned pdfjs-dist/);
});
