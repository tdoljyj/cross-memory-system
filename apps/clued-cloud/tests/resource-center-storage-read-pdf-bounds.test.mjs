import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { patchPdfWorker, pdfDecodeGuardEsbuildPlugin } from "../build/pdfjs-decode-guard.mjs";
import { catalogDictBombPdf, cmapRangeBombPdf, dictArrayBombPdf, emptyArrayBombPdf, extraOperandsBombPdf, flateLatinPdf, formXObjectsBombPdf, heldOperandsBombPdf,
  stringArrayBombPdf, imageFilterBombPdf, longStringPdf, operatorBombPdf, predefinedCjkFontsPdf, realisticTextPdf, repeatedStreamPdf, textBombPdf, toUnicodeBombPdf,
  type3CharProcBombPdf } from "./resource-center-storage-pdf.fixture.mjs";

// StorageNormalUse.v0.1 §4.5 resource bounds (independent review MAJOR): small
// deflate bombs must not exhaust a Worker isolate. Each case runs in its own
// child with a 64 MB JS heap (half a Worker isolate) and must finish there; the child reports time
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
const [bundle, file, maxText, timeMs] = process.argv.slice(2);
const { extractPdfText } = await import(bundle);
const run = bytes => extractPdfText(bytes, { page_start: 1, page_count: 20, max_text_bytes: Number(maxText), ...(timeMs ? { time_ms: Number(timeMs) } : {}) });
let peakBuffers = 0, peakHeap = 0, cmapCalls = 0;
try { await run(new Uint8Array(await readFile(file + ".warm"))); } catch {}
const guard = globalThis.__cluedPdfDecodeGuard;
if (typeof guard === "function") globalThis.__cluedPdfDecodeGuard = (kind, ...args) => {
  // CMap entries are charged one by one: sample every 256th.
  if (kind === "decode" || (kind === "cmap" && cmapCalls++ % 256 === 0)) { peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers); peakHeap = Math.max(peakHeap, v8.getHeapStatistics().used_heap_size); }
  return guard(kind, ...args);
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
async function measure(pdf, { bundle = "guarded.mjs", maxText = 256 * 1024, timeMs } = {}) {
  const file = path.join(directory, `case-${++seq}.pdf`);
  await writeFile(file, pdf); await writeFile(file + ".warm", flateLatinPdf([["warm up"]]));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.NODE_OPTIONS;
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=64", child, path.join(directory, bundle), file, String(maxText), ...(timeMs ? [String(timeMs)] : [])],
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
  // Independent re-review: allocation outside every decoded-byte path, from files under 1.6 KB.
  // Before: a 16 M-code bfrange crashed a 1 GB heap after 29 s; the cidrange took 9 s and 850 MB.
  ["1.4 KB ToUnicode with one <000000> <FFFFFF> bfrange (CMap range bomb)", () => cmapRangeBombPdf(), r => r.code === "archive_limit_exceeded", 3],
  ["1.4 KB ToUnicode with one 16 M-code cidrange", () => cmapRangeBombPdf([["000000", "FFFFFF", "0001"]], { kind: "cidrange" }), r => r.code === "archive_limit_exceeded", 3],
  ["many small bfranges that together pass the CMap limit", () => cmapRangeBombPdf(Array.from({ length: 64 }, (_, i) => [(i * 0x1000).toString(16).padStart(6, "0"),
    (i * 0x1000 + 0xfff).toString(16).padStart(6, "0"), "4100"])), r => r.code === "archive_limit_exceeded", 3],
  ["a sparse bfrange just under the CMap limit still fits", () => cmapRangeBombPdf([["100000", (0x100000 + 49000).toString(16), "4100"]]), r => r.ok && r.complete, 5],
  // Before: 5.2 GB RSS and 28 s CPU for the 30000 x 30000 JPEG header.
  ["1.6 KB ToUnicode stream with /Filter /DCTDecode claiming a 30000 x 30000 image", () => imageFilterBombPdf(), r => r.code === "archive_limit_exceeded", 3],
  ["1.6 KB FontFile2 stream with /Filter /DCTDecode claiming a 30000 x 30000 image", () => imageFilterBombPdf({ target: "fontfile" }), r => r.code === "archive_limit_exceeded", 3],
  // These decoders have no readBlock: a byte read on the text path throws before
  // anything is decoded (pdf.js drops that ToUnicode), and decodeImage is refused.
  ...["JBIG2Decode", "JPXDecode", "CCITTFaxDecode"].map(filter => [`ToUnicode stream with /Filter /${filter} decodes nothing`, () => imageFilterBombPdf({ filter }),
    r => r.ok || r.code === "archive_limit_exceeded", 3]),
  ["four predefined CJK fonts (bundled CMaps) stay inside the CMap limit", () => predefinedCjkFontsPdf(4),
    r => r.ok && r.complete && r.text_bytes > 0, 5],
  // Before the CMap limit, 30 such fonts (a 12 KB file) exhausted this 64 MB heap.
  ["eight predefined CJK fonts pass the CMap limit", () => predefinedCjkFontsPdf(8), r => r.code === "archive_limit_exceeded", 5],
  // Independent re-review (object bombs): Parser.getObj builds arrays and Dicts one element at a time.
  // Before (128 MB heap): A, B and C ran out of memory (the review measured peaks of 527 MB for A and 171 MB for B), and
  // S completed after 3.4 s with a 110 MB heap.
  ["A: 8 KB page, [ [<<>> x 250 000] x 8 ] TJ", () => dictArrayBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["B: 8 KB page, [ [[] x 250 000] x 16 ] TJ", () => emptyArrayBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["C: 4 MB uncompressed Catalog /Junk of 1 M empty dictionaries (xref path)", () => catalogDictBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["S: 8.5 KB page, [ (a x 200 000) x 40 ] TJ", () => stringArrayBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["an operand just under the object limit still fits", () => dictArrayBombPdf(74000, 1), r => r.ok && r.complete, 5],
  ["a Catalog just under the object limit still fits", () => catalogDictBombPdf(74000, 1), r => r.ok && r.complete && r.text_bytes > 0, 5],
  // Independent review of 26ee7e4e (operands held at once, kept operands, CPU without text). Before, measured
  // with a 2 GB heap: H2 peaked at 481 MB, I2 at 482 MB, I3 at 196 MB, K at 1 056 MB after 5.1 s wall / 9.5 s
  // CPU; all four ran out of memory under this 64 MB heap. The Type3 CharProcs peaked at 219 MB (d operands,
  // completed after 5 s at 64 MB) and 476 MB (2 M kept `w` operators, out of memory at 64 MB).
  ["H2: 7.8 KB page, 26 operands of 70 000 <<>> each before one TJ", () => heldOperandsBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["I2: 7.9 KB page, ([<<>> x 70 000] n) x 26 (extra operands kept in nonProcessedArgs)", () => extraOperandsBombPdf(70000, 26), r => r.code === "archive_limit_exceeded", 5],
  ["I3: 3.4 KB page, ([<<>> x 70 000] n) x 10, then text", () => extraOperandsBombPdf(70000, 10), r => r.code === "archive_limit_exceeded", 5],
  ["K: 49 KB page drawing 6 form XObjects of 7.8 MiB ([<<>> x 70 000] n) lines each", () => formXObjectsBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["Type3 CharProc keeping 26 d operands of 70 000 <<>> each in its operator list", () => type3CharProcBombPdf(), r => r.code === "archive_limit_exceeded", 5],
  ["Type3 CharProc keeping 2 M `1 w` operators in its operator list", () => type3CharProcBombPdf({ unit: "1 w\n", count: 2_000_000 }),
    r => r.code === "archive_limit_exceeded", 5],
  ["Type3 CharProc with one path of 1.4 M lineto", () => type3CharProcBombPdf({ unit: "1 1 l\n", count: 1_400_000 }), r => r.code === "archive_limit_exceeded", 5],
  ["60 000 x 33 extra numeric operands before `n` (nonProcessedArgs keeps only the last 33)", () => type3CharProcBombPdf({
    unit: Array.from({ length: 33 }, (_, i) => i + 1).join(" ") + " n\n", count: 60000 }), r => r.ok && r.complete, 5],
  ["20 dense kerned text pages extract whole", () => realisticTextPdf(20), r => r.ok && r.complete && r.pages === 20 && r.text_bytes > 90000, 5],
]) {
  test(`bounded under a 64 MB heap: ${name}`, { timeout: 90000 }, async t => {
    const result = await measure(pdf());
    t.diagnostic(JSON.stringify(result));
    assert.ok(expect(result), JSON.stringify(result));
    assert.ok(result.wall_ms < seconds * 1000, `time: ${JSON.stringify(result)}`);
    assert.ok(result.peak_buffers_mb < 64, `decoded buffers: ${JSON.stringify(result)}`);
    // The heap bound is the child finishing at all under --max-old-space-size=64 (an
    // exhausted heap aborts it and execFile rejects). peak_heap_mb is only a diagnostic:
    // V8 lets garbage accumulate close to the limit before a full collection.
  });
}

// The guard checks the call's deadline inside pdf.js, so a page whose form XObjects only draw (no text
// chunk, no page boundary, every limit but tokens far away) still stops at the deadline.
test("bounded under a 64 MB heap: 6 form XObjects of 7 MiB `q Q` each stop at the call's deadline", { timeout: 90000 }, async t => {
  const pdf = formXObjectsBombPdf({ unit: "q Q\n", decodedBytes: 7 * MiB });
  const whole = await measure(pdf);
  t.diagnostic(JSON.stringify(whole));
  // With the default 10 s deadline the token limit ends it first (about 3 s).
  assert.equal(whole.code, "archive_limit_exceeded"); assert.ok(whole.wall_ms < 10000, JSON.stringify(whole));
  const cut = await measure(pdf, { timeMs: 500 });
  t.diagnostic(JSON.stringify(cut));
  // A time cut inside the first page: storage_read_unavailable (nothing whole to return), at about the deadline.
  assert.equal(cut.code, "storage_read_unavailable");
  assert.ok(cut.wall_ms >= 450 && cut.wall_ms < 1500, JSON.stringify(cut));
  // K (object-heavy forms): the content-object limit ends it well before the default deadline, and a
  // shorter deadline ends it at about that deadline if the limit has not already.
  const k = await measure(formXObjectsBombPdf());
  t.diagnostic(JSON.stringify(k));
  assert.equal(k.code, "archive_limit_exceeded"); assert.ok(k.wall_ms < 2000, JSON.stringify(k));
  const kShort = await measure(formXObjectsBombPdf(), { timeMs: 100 });
  t.diagnostic(JSON.stringify(kShort));
  assert.ok(["archive_limit_exceeded", "storage_read_unavailable"].includes(kShort.code) && kShort.wall_ms < 1000, JSON.stringify(kShort));
});

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

test("the patch fails the build when pdf.js does not match the pinned anchors", async () => {
  assert.throws(() => patchPdfWorker("export const WorkerMessageHandler = {};"), /does not match the pinned pdfjs-dist/);
  // Every anchor matches the pinned worker exactly once; a second copy of any new anchor fails the build.
  const source = await readFile(fileURLToPath(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url)), "utf8");
  const patched = patchPdfWorker(source);
  for (const inserted of ["nonProcessedArgs.splice(0, nonProcessedArgs.length - 33)", '__cluedPdfDecodeGuard("oplist", null, 6);\n    this.optimizer.push',
    '__cluedPdfDecodeGuard("oplist", null, 1);\n    const {\n      pathMinMax'])
    assert.equal(patched.split(inserted).length, 2, inserted);
  for (const anchor of ["  addOp(fn, args) {\n    this.optimizer.push(fn, args);\n    this.weight++;",
    "            while (argsLength > numArgs) {\n              nonProcessedArgs.push(args.shift());\n              argsLength--;\n            }\n"])
    assert.throws(() => patchPdfWorker(source + "\n" + anchor), /does not match the pinned pdfjs-dist/);
});
