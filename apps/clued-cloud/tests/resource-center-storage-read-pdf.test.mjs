import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { pdfDecodeGuardEsbuildPlugin } from "../build/pdfjs-decode-guard.mjs";
import { brotliBombPdf, embeddedFontPdf, encryptedPdf, flateLatinPdf, identityPdf, latinPdf, type3CharProcBombPdf, longStringPdf, operatorBombPdf, predefinedCjkPdf, repeatedStreamPdf, scannedPdf,
  realisticTextPdf, textBombPdf, textPagesPdf, textThenDrawingPdf, toUnicodeBombPdf, cidToGidMapStream } from "./resource-center-storage-pdf.fixture.mjs";

// StorageNormalUse.v0.1 §4.5: pdf.js text extraction for clued_storage_read.
// The module imports pdf.js and the generated CMaps extensionless, so it is
// bundled first, as the continuity route tests do.
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-storage-pdf-"));
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-read-pdf.ts", import.meta.url))], outfile: path.join(directory, "pdf.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "silent", plugins: [pdfDecodeGuardEsbuildPlugin()] });
stop();
const { extractPdfText, looksGarbled, readExactBody, classifyPdfError, pdfOffsetPastText, pdfTimeBudget, PDF_MAX_BYTES, PDF_PAGES_PER_CALL, PDF_TEXT_MAX,
  PDF_TIME_MS, PDF_TIME_CUT_HINT, withPdfSlot, PdfBusyError, PDF_SLOT_WAIT_MS, PDF_CONTENT_OBJECTS_MAX, PDF_DEADLINE_CHECK_EVERY, PDF_GLYPH_ENTRIES_MAX, PDF_DECODE_STREAM_MAX, PDF_DECODE_TOTAL_MAX, pdfWorkerReady } =
  await import(pathToFileURL(path.join(directory, "pdf.mjs")).href);
const extract = (bytes, options = {}) => extractPdfText(bytes, { page_start: 1, page_count: 20, max_text_bytes: PDF_TEXT_MAX, ...options });
const ZH = "资料中心存储读取测试：这是一个包含中文字符的页面。";

test("limits match the contract: 20 MiB files, 20 pages and 8 MiB of text per call", () => {
  assert.equal(PDF_MAX_BYTES, 20 * 1024 * 1024); assert.equal(PDF_PAGES_PER_CALL, 20); assert.equal(PDF_TEXT_MAX, 8 * 1024 * 1024);
});

test("Latin text: one '# Page N' header per page, pages selected by start and count", async () => {
  const pdf = latinPdf(Array.from({ length: 25 }, (_, i) => [`Page ${i + 1} heading`, `Body of page ${i + 1} (with parens) and \\ backslash.`]));
  const all = await extract(pdf.slice());
  assert.equal(all.page_count, 25); assert.equal(all.pages_extracted, 20, "at most 20 pages per call"); assert.equal(all.complete, true);
  assert.equal(all.text_layer, "present"); assert.deepEqual(all.unreliable_pages, []); assert.equal(all.cmap_missing, false);
  assert.ok(all.text.startsWith("# Page 1\nPage 1 heading\nBody of page 1 (with parens) and \\ backslash.\n# Page 2\n"));
  assert.ok(all.text.endsWith("# Page 20\nPage 20 heading\nBody of page 20 (with parens) and \\ backslash."));
  const tail = await extract(pdf.slice(), { page_start: 24, page_count: 5 });
  assert.equal(tail.pages_extracted, 2); assert.equal(tail.text, "# Page 24\nPage 24 heading\nBody of page 24 (with parens) and \\ backslash.\n" +
    "# Page 25\nPage 25 heading\nBody of page 25 (with parens) and \\ backslash.");
  const past = await extract(pdf.slice(), { page_start: 26 });
  assert.equal(past.pages_extracted, 0); assert.equal(past.text, ""); assert.equal(past.complete, true);
});

test("text limit stops after the page that reaches it, as a prefix of the full text; time limit ends the selection at a page boundary", async () => {
  const pdf = latinPdf(Array.from({ length: 6 }, (_, i) => [`Page ${i + 1} ` + "x".repeat(80)]));
  const full = await extract(pdf.slice());
  const cut = await extract(pdf.slice(), { max_text_bytes: 150 });
  assert.equal(cut.complete, false); assert.equal(cut.pages_extracted, 2); assert.ok(full.text.startsWith(cut.text));
  let now = 0;
  const slow = await extract(pdf.slice(), { clock: () => (now += 6000), time_ms: 10000 });
  assert.equal(slow.complete, true, "whole pages only"); assert.ok(slow.pages_extracted >= 1 && slow.pages_extracted < 6);
  assert.ok(full.text.startsWith(slow.text));
});

test("CJK: predefined UniGB-UCS2-H CMap (non-embedded STSong-Light) and ToUnicode both decode correctly", async () => {
  const predefined = await extract(predefinedCjkPdf([[ZH], ["第二页：逐页读取。"]]));
  assert.equal(predefined.text, `# Page 1\n${ZH}\n# Page 2\n第二页：逐页读取。`); assert.equal(predefined.cmap_missing, false);
  const mapped = await extract(identityPdf([[ZH, "Mixed English 与中文 123"]]));
  assert.equal(mapped.text, `# Page 1\n${ZH}\nMixed English 与中文 123`); assert.deepEqual(mapped.unreliable_pages, []);
});

// Glyph-table bounds (review of 06d2251a): /W, /W2 and CIDToGIDMap ranges are clamped to CIDs 0..0xFFFF and charged to
// PDF_GLYPH_ENTRIES_MAX; realistic CID fonts extract exactly as before (compared against the build without the clamp).
test("CID fonts with realistic /W, /W2 and CIDToGIDMap extract exactly", async () => {
  const W = "/DW 1000 /W [1 [600 650 500 720] 5 18 1000 19 [250 333 278] 22 30 556] /CIDToGIDMap 7 0 R";
  const horizontal = await extract(identityPdf([[ZH, "Mixed English 与中文 123"]], { widths: W, extras: [cidToGidMapStream(64)] }));
  assert.equal(horizontal.text, `# Page 1\n${ZH}\nMixed English 与中文 123`); assert.deepEqual(horizontal.unreliable_pages, []);
  // A standard font name takes pdf.js's CIDToGIDMap branch of the non-embedded font path; ToUnicode still maps every code.
  const arial = await extract(identityPdf([["Arial text 123 with widths"]], { widths: W, extras: [cidToGidMapStream(64)], baseFont: "ArialMT" }));
  assert.equal(arial.text, "# Page 1\nArial text 123 with widths");
  const vertical = await extract(identityPdf([["竖排文字测试"]], { vertical: true,
    widths: "/DW 1000 /W [1 30 1000] /DW2 [880 -1000] /W2 [1 [-1000 500 880 -1000 500 880] 3 30 -1000 500 880]" }));
  assert.equal(vertical.text, "# Page 1\n竖排文字测试");
  // No ToUnicode: an Identity font's codes are the text (IdentityToUnicodeMap, charged 65 536 entries).
  const identity = await extract(identityPdf([["ABC abc"]], { toUnicode: false, codes: [..."ABC abc"].map(c => c.charCodeAt(0)), widths: "/W [32 126 500]" }));
  assert.equal(identity.text, "# Page 1\nABC abc");
  assert.equal(PDF_GLYPH_ENTRIES_MAX, 2_000_000);
});

test("a CJK encoding whose CMap is not bundled is reported, never silent", async () => {
  const result = await extract(predefinedCjkPdf([[ZH]], "UniGB-UTF8-H"));
  assert.equal(result.cmap_missing, true);
});

test("no Unicode map: glyph codes are omitted as unreliable instead of returned as garbage", async () => {
  // Subset-style small codes become control characters.
  const small = await extract(identityPdf([[ZH], ["第二页"]], { toUnicode: false }));
  assert.deepEqual(small.unreliable_pages, [1, 2]); assert.equal(small.text, "# Page 1\n\n# Page 2\n");
  // Whole-font glyph IDs become a spray of unrelated scripts (measured on a real font without ToUnicode).
  const spray = [0x0bdf, 0x0d95, 0x06ab, 0x0282, 0x02cd, 0x02c0, 0x02cf, 0x0d13, 0x0886, 0x027b, 0x026d, 0x0186, 0x07ca, 0x0e94, 0x0bac, 0x0293, 0x081f, 0x029e];
  const wide = await extract(identityPdf([["日本語のテスト文書です。資料の読み取り"]], { toUnicode: false, codes: spray }));
  assert.deepEqual(wide.unreliable_pages, [1]); assert.equal(wide.text, "# Page 1\n");
  // Only the garbled page is dropped.
  assert.equal(wide.text_layer, "present");
});

// §4.5: embedded font programs are never parsed; the font dictionary (Encoding / Differences, ToUnicode) maps the text.
// Measured against the unpatched worker with real fonts (Liberation Serif TrueType, a CFF built from it, Bitstream
// Charter Type 1) and reportlab / fpdf2 / pdf-lib / pdfkit output: identical text except a Type1 / Type1C font whose
// codes only its own built-in encoding names (no /Encoding, no ToUnicode), which is now unreliable (the false negative).
test("embedded fonts: text comes from the font dictionary, the program is never needed", async () => {
  const lines = ["Embedded font text, 123!", "Second line."];
  const expected = `# Page 1\n${lines.join("\n")}`;
  for (const font of ["TrueType", "Type1C", "Type1", "CIDFontType2", "CIDFontType0C"]) {
    const mapped = await extract(embeddedFontPdf(lines, { font }));
    assert.deepEqual({ font, text: mapped.text, unreliable: mapped.unreliable_pages }, { font, text: expected, unreliable: [] }, "ToUnicode, subset codes 1..n");
  }
  for (const font of ["TrueType", "Type1C", "Type1"]) {
    for (const [what, options] of [["/Differences", { codes: "subset", encoding: "differences" }], ["WinAnsiEncoding", { codes: "ascii", encoding: "/WinAnsiEncoding" }],
      ["no Encoding, ASCII codes", { codes: "ascii" }]]) {
      const result = await extract(embeddedFontPdf(lines, { font, toUnicode: false, ...options }));
      assert.deepEqual({ font, what, text: result.text }, { font, what, text: expected });
    }
  }
  // The documented false negative: codes that only the program's built-in encoding names.
  for (const font of ["Type1C", "Type1"]) {
    const builtIn = await extract(embeddedFontPdf(lines, { font, toUnicode: false }));
    assert.deepEqual({ font, text: builtIn.text, unreliable: builtIn.unreliable_pages }, { font, text: "# Page 1\n", unreliable: [1] });
  }
  // Without ToUnicode an Identity-H font gives glyph IDs, as before: omitted as unreliable.
  for (const font of ["CIDFontType2", "CIDFontType0C"]) assert.deepEqual((await extract(embeddedFontPdf(lines, { font, toUnicode: false }))).unreliable_pages, [1]);
  // Type3 fonts are content streams (budgeted), not font programs: unaffected.
  assert.equal((await extract(type3CharProcBombPdf({ unit: "0 0 m\n", count: 1 }))).text, "# Page 1\naaa");
});

test("looksGarbled: real text of many scripts passes; codes and script sprays do not", () => {
  for (const text of ["The quick brown fox jumps over the lazy dog.", ZH, "日本語のテスト文書です。資料の読み取り。", "한국어 문서를 읽습니다. 테스트입니다.",
    "Привет, мир! Это тест. Ελληνικά κείμενα.", "مرحبا بالعالم، هذا اختبار للنص العربي", "∀x ∈ ℝ: x² ≥ 0 → √(x²) = |x|, α + β = γ",
    "नमस्ते दुनिया, यह एक परीक्षण है", "Price: €12.50 — “quoted” text…", "第1章 概要 Chapter 1 Overview（2026年）", "  \n  ", "ok"])
    assert.equal(looksGarbled(text), false, text);
  for (const text of ["\u0001\u0002\u0003\u0002\u0004\u0002\u0005\u0006\u0007\b", "௟ඕګʂˍˀˏഓࢆɻɭƆߊດʂ஬ʓࠟʞƆ", "",
    "��������"])
    assert.equal(looksGarbled(text), true, JSON.stringify(text));
});

test("scans report text_layer none", async () => {
  const scan = await extract(scannedPdf(3));
  assert.equal(scan.page_count, 3); assert.equal(scan.text_layer, "none"); assert.equal(scan.text, "# Page 1\n\n# Page 2\n\n# Page 3\n");
});

test("password-protected, damaged, empty and oversized inputs fail with fixed codes", async () => {
  for (const bytes of [encryptedPdf(), new TextEncoder().encode("%PDF-1.7 ..."), new Uint8Array(0), new TextEncoder().encode("PK\u0003\u0004 not a pdf")])
    await assert.rejects(extract(bytes), error => error.code === "document_invalid");
  await assert.rejects(extract(new Uint8Array(PDF_MAX_BYTES + 1)), error => error.code === "binary_too_large");
});

test("readExactBody: exactly the declared size, else storage_read_unavailable", async () => {
  const body = (...parts) => new Response(new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } }));
  assert.deepEqual([...await readExactBody(body([1, 2], [3]), 3)], [1, 2, 3]);
  await assert.rejects(readExactBody(body([1, 2], [3, 4]), 3), error => error.code === "storage_read_unavailable");
  await assert.rejects(readExactBody(body([1]), 3), error => error.code === "storage_read_unavailable");
  await assert.rejects(readExactBody(body([1]), PDF_MAX_BYTES + 1), error => error.code === "binary_too_large");
});

test("the generated CMap module matches the pinned pdfjs-dist and leaves out only the rare UTF-8 / UTF-32 / JIS X 0213 maps", async () => {
  const { renderPdfCMapModule, excludedCMap } = await import("../scripts/generate-pdf-cmaps.mjs");
  const committed = await readFile(new URL("../worker/generated/pdf-cmaps.ts", import.meta.url), "utf8");
  assert.equal(committed, await renderPdfCMapModule(), "run node scripts/generate-pdf-cmaps.mjs");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(committed, new RegExp(`from pdfjs-dist ${pkg.dependencies["pdfjs-dist"].replace(/\./g, "\\.")} cmaps`), "pinned exact version");
  for (const name of ["UniGB-UCS2-H", "Adobe-GB1-UCS2", "Adobe-Japan1-UCS2", "Adobe-Korea1-UCS2", "Adobe-CNS1-UCS2", "GBK-EUC-H", "90ms-RKSJ-H", "UniKS-UTF16-H"])
    assert.ok(committed.includes(`"${name}": "`), name);
  assert.equal(excludedCMap("UniGB-UTF8-H"), true); assert.equal(excludedCMap("UniGB-UCS2-H"), false);
});

// §4.5 resource bounds (independent review MAJOR). Memory and time under a
// 64 MB heap are measured in resource-center-storage-read-pdf-bounds.test.mjs.
const MiB = 1024 * 1024;

test("FlateDecode content (the common case) decodes inside the guarded budget; bidi controls are stripped", async () => {
  const result = await extract(flateLatinPdf([["Hello flate world"], ["Second page"]]));
  assert.equal(result.text, "# Page 1\nHello flate world\n# Page 2\nSecond page"); assert.equal(result.complete, true); assert.equal(result.time_limited, false);
  // U+202A-202E embeddings / overrides and U+2066-2069 isolates.
  const [lre, rlo, pdf, lri, pdi] = [0x202a, 0x202e, 0x202c, 0x2066, 0x2069].map(code => String.fromCharCode(code));
  const bidi = await extract(identityPdf([[`abc ${rlo}def${pdf} ${lre}ghi${pdf} ${lri}jkl${pdi} mno`]]));
  assert.equal(bidi.text, "# Page 1\nabc def ghi jkl mno");
});

// "Aborts early" is measured as work, not as milliseconds: every unit of pdf.js work (a decode buffer, a
// token, an object ...) is announced to globalThis.__cluedPdfDecodeGuard before it is done, so wrapping
// that function counts what the extraction was allowed to do and what it asked for after the refusal. The
// counts depend only on the PDF and the pinned pdf.js, never on machine load. The call's clock is fixed, so
// the deadline cannot end the extraction either: only the resource limits can.
async function meterGuard(run) {
  assert.equal(await pdfWorkerReady(), true); // loads pdf.js, which installs the guard; no extraction, no clock
  const real = globalThis.__cluedPdfDecodeGuard;
  assert.equal(typeof real, "function");
  // chargedDecodeBytes: decode-buffer bytes the guard admitted (a buffer is charged at its new size; the native
  // DecompressionStream path charges twice each chunk); refusedDecodeBytes: what refused decode calls asked for.
  const meter = { calls: 0, refused: 0, firstRefusedKind: null, chargedDecodeBytes: 0, refusedDecodeBytes: 0, maxRefusalsPerStream: 0 };
  const refusalsPerStream = new Map();
  globalThis.__cluedPdfDecodeGuard = (kind, subject, bytes, code) => {
    meter.calls++;
    try {
      const result = real(kind, subject, bytes, code);
      if (kind === "decode") meter.chargedDecodeBytes += bytes;
      return result;
    } catch (error) {
      meter.refused++; meter.firstRefusedKind ??= kind;
      if (kind === "decode") {
        meter.refusedDecodeBytes += bytes;
        refusalsPerStream.set(subject, (refusalsPerStream.get(subject) ?? 0) + 1);
        meter.maxRefusalsPerStream = Math.max(meter.maxRefusalsPerStream, refusalsPerStream.get(subject));
      }
      throw error;
    }
  };
  try { return { outcome: await run(), meter }; } finally { globalThis.__cluedPdfDecodeGuard = real; }
}

test("decode bombs, operator bombs, oversized tokens and BrotliDecode fail with archive_limit_exceeded instead of partial text, after a bounded amount of work", async () => {
  // pdf.js decodes Brotli with the runtime's DecompressionStream when it has "brotli" (the guard then refuses at
  // "decode", as for the other bombs); otherwise BrotliStream.readBlock asks the guard for "limit" before it decodes.
  assert.equal(PDF_DECODE_STREAM_MAX, 16 * MiB); assert.equal(PDF_DECODE_TOTAL_MAX, 48 * MiB); // the bounds below follow these limits
  const nativeBrotli = (() => { try { new DecompressionStream("brotli"); return true; } catch { return false; } })();
  // [name, pdf, charged-bytes range, kind of the first refused guard call]. A stream is capped at 16 MiB
  // (PDF_DECODE_STREAM_MAX) and one call at 48 MiB (PDF_DECODE_TOTAL_MAX), far below what each bomb would decode (100-300 MB);
  // the numbers are literal on purpose: a test that read the limits from the module would follow a loosened limit;
  // the guard refuses when the next buffer would pass the cap, so a bomb is charged up to the cap, not less: the
  // lower bounds show the limit was reached, not that the guard refused at once. The 1 MiB string needs a 2 MiB
  // buffer (doubling) and is refused by the 256 Ki element cap on a string, which is no decode charge.
  const cases = [["operator bomb 100 MB", operatorBombPdf(100 * MiB), [8 * MiB, 16 * MiB], "decode"],
    ["text bomb 300 MB", textBombPdf(300 * MiB), [8 * MiB, 16 * MiB], "decode"],
    ["ToUnicode bomb 200 MB (native DecompressionStream path)", toUnicodeBombPdf(200 * MiB), [8 * MiB, 16 * MiB], "decode"],
    ["200 references to one 1 MB stream", repeatedStreamPdf(200, MiB), [24 * MiB, 48 * MiB], "decode"],
    ["one 1 MiB string", longStringPdf(MiB), [MiB, 2 * MiB + 1024], "limit"],
    [`BrotliDecode 100 MB (${nativeBrotli ? "native DecompressionStream" : "BrotliStream.readBlock"})`, brotliBombPdf(100 * MiB),
      [nativeBrotli ? 8 * MiB : 0, 16 * MiB], nativeBrotli ? "decode" : "limit"]];
  for (const [name, pdf, [chargedMin, chargedMax], refusedKind] of cases) {
    const { meter } = await meterGuard(() => assert.rejects(extract(pdf, { clock: () => 0 }), error => error.code === "archive_limit_exceeded", name));
    const seen = `${name}: ${JSON.stringify(meter)}`;
    assert.equal(meter.firstRefusedKind, refusedKind, seen);
    assert.ok(meter.chargedDecodeBytes >= chargedMin && meter.chargedDecodeBytes <= chargedMax, seen);
    // Decoding stops at the refusal: nothing asks for more than one more buffer, and a refused stream is not
    // asked again and again (a pdf.js loop that swallows the refusal and goes on, or one that decodes the whole
    // bomb and charges it afterwards, shows here). Real runs: at most 2 refusals per stream, <= 6.6 MB asked.
    assert.ok(meter.refusedDecodeBytes <= 16 * MiB, seen);
    assert.ok(meter.maxRefusalsPerStream <= 2, seen);
    // Every further call after a refusal is refused too: a few hundred at most (200 streams, 2 each), never the
    // hundreds of thousands of a loop that carries on per token. 2.5-3x above the real runs (401 refused, 3425 calls).
    assert.ok(meter.refused >= 1 && meter.refused <= 1000, seen);
    assert.ok(meter.calls <= 10000, seen);
  }
});

test("the work meter counts what the guard admits and refuses", async () => {
  // An extraction that stays inside the limits: charged decode buffers, no refusal.
  const ok = await meterGuard(() => extract(flateLatinPdf([["Hello flate world"]]), { clock: () => 0 }));
  assert.equal(ok.outcome.text, "# Page 1\nHello flate world");
  assert.ok(ok.meter.calls > 0 && ok.meter.chargedDecodeBytes > 0, JSON.stringify(ok.meter));
  assert.deepEqual({ ...ok.meter, calls: 0, chargedDecodeBytes: 0 }, { calls: 0, refused: 0, firstRefusedKind: null, chargedDecodeBytes: 0, refusedDecodeBytes: 0, maxRefusalsPerStream: 0 });
  // Outside an extraction the guard lets a token or a new name through and refuses anything else.
  const { meter } = await meterGuard(() => {
    const guard = globalThis.__cluedPdfDecodeGuard, stream = {};
    guard("token"); guard("primitive");
    for (let i = 0; i < 3; i++) assert.throws(() => guard("decode", stream, 4096), error => error.cluedPdfLimit === true);
    assert.throws(() => guard("limit"), error => error.cluedPdfLimit === true);
  });
  assert.deepEqual(meter, { calls: 6, refused: 4, firstRefusedKind: "decode", chargedDecodeBytes: 0, refusedDecodeBytes: 12288, maxRefusalsPerStream: 3 });
});

test("page text is streamed: the text limit cancels inside a page and the text is a prefix of the full text", async () => {
  const pdf = textBombPdf(2 * MiB);
  const cut = await extract(pdf.slice(), { max_text_bytes: 64 * 1024 });
  assert.equal(cut.complete, false); assert.equal(cut.pages_extracted, 1);
  const size = Buffer.byteLength(cut.text);
  assert.ok(size > 64 * 1024 && size < 96 * 1024, `stops within one chunk of the limit: ${size}`);
  const more = await extract(pdf.slice(), { max_text_bytes: 256 * 1024 });
  assert.ok(more.text.startsWith(cut.text));
});

test("the guard's deadline check ends a page without text chunks the same way: page dropped, selection ends, first page unavailable", async () => {
  // Page 2 only draws (about 1.8 M content tokens, no text chunk to check the time at); the guard
  // reads the clock every PDF_DEADLINE_CHECK_EVERY calls, and each reading advances it 1 s.
  const pdf = textThenDrawingPdf("Short first page", 7 * MiB);
  let now = 0;
  const cut = await extract(pdf.slice(), { clock: () => (now += 1000), time_ms: 10000 });
  assert.deepEqual({ text: cut.text, pages: cut.pages_extracted, complete: cut.complete, time_limited: cut.time_limited },
    { text: "# Page 1\nShort first page", pages: 1, complete: true, time_limited: true });
  now = 0;
  await assert.rejects(extract(pdf.slice(), { page_start: 2, clock: () => (now += 1000), time_ms: 10000 }), error => error.code === "storage_read_unavailable");
  assert.equal(PDF_DEADLINE_CHECK_EVERY, 4096);
});

test("a realistic 20-page kerned text document extracts whole, within the content-object limit", async () => {
  const result = await extract(realisticTextPdf(20));
  assert.equal(result.page_count, 20); assert.equal(result.pages_extracted, 20); assert.equal(result.complete, true); assert.equal(result.text_layer, "present");
  assert.ok(result.text.startsWith("# Page 1\nSection 1: Findings\n"), result.text.slice(0, 80));
  assert.ok(result.text.includes("# Page 20\nSection 20: Findings\n")); assert.ok(result.text.length > 90000);
  assert.equal(PDF_CONTENT_OBJECTS_MAX, 512 * 1024);
});

test("time limit inside a page drops that page and ends the selection; on the first page it is storage_read_unavailable", async () => {
  // Page 1 is short; page 2 streams hundreds of chunks, and the clock advances 1 s per reading.
  const pdf = textPagesPdf([200, MiB, 200]);
  let now = 0;
  const cut = await extract(pdf.slice(), { clock: () => (now += 1000), time_ms: 10000 });
  assert.equal(cut.pages_extracted, 1); assert.equal(cut.complete, true); assert.equal(cut.time_limited, true);
  assert.ok(cut.text.startsWith("# Page 1\nPage 1 starts here\n")); assert.equal(cut.text.includes("# Page 2"), false);
  now = 0;
  await assert.rejects(extract(pdf.slice(), { page_start: 2, clock: () => (now += 1000), time_ms: 10000 }), error => error.code === "storage_read_unavailable");
  // The caller may pass less time, never more than PDF_TIME_MS.
  now = 0;
  const capped = await extract(pdf.slice(), { page_start: 3, clock: () => (now += 1000), time_ms: 10 * PDF_TIME_MS });
  assert.equal(capped.pages_extracted, 1);
});

test("the extraction deadline comes from what is left of the call's 25 s signal after the 5 s recheck reserve", () => {
  assert.equal(pdfTimeBudget(0), PDF_TIME_MS); assert.equal(pdfTimeBudget(12000), 8000); assert.equal(pdfTimeBudget(19000), 1000);
  assert.equal(pdfTimeBudget(19001), null); assert.equal(pdfTimeBudget(-5), PDF_TIME_MS);
});

test("an offset past the text: eof when whole, archive_limit_exceeded when the text limit cut it, re-read hint when the time limit cut a continuation", () => {
  const pages = { page_count: 9, page_start: 3, pages_extracted: 2, text: "", complete: true, time_limited: false, text_layer: "present", unreliable_pages: [], cmap_missing: false };
  assert.equal(pdfOffsetPastText(pages, 100, 50), null);
  assert.equal(pdfOffsetPastText(pages, 100, 100), null, "whole and shorter: empty eof");
  assert.deepEqual(pdfOffsetPastText({ ...pages, complete: false }, 100, 100), { code: "archive_limit_exceeded" });
  assert.deepEqual(pdfOffsetPastText({ ...pages, time_limited: true }, 100, 150), { code: "storage_read_unavailable", hint: PDF_TIME_CUT_HINT, next_page_start: 5 });
  assert.equal(pdfOffsetPastText({ ...pages, time_limited: true }, 0, 0), null, "offset 0 is not a continuation");
  assert.equal(pdfOffsetPastText({ ...pages, time_limited: true }, 100, 40), null, "inside the text");
});

test("failures that are not about the file are storage_read_unavailable; a hit limit is archive_limit_exceeded; parser errors are document_invalid", () => {
  const code = (error, hit = false) => classifyPdfError(error, hit).code;
  assert.equal(code(new RangeError("Array buffer allocation failed")), "storage_read_unavailable");
  // pdf.js passes worker errors on as UnknownErrorException with the original in `details`.
  assert.equal(code(Object.assign(new Error("Invalid typed array length: 99999999999"), { name: "UnknownErrorException", details: "RangeError: Invalid typed array length" })), "storage_read_unavailable");
  assert.equal(code(Object.assign(new Error("Maximum call stack size exceeded"), { name: "UnknownErrorException", details: "RangeError: Maximum call stack size exceeded" })), "storage_read_unavailable");
  assert.equal(code(Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" })), "document_invalid");
  assert.equal(code(Object.assign(new Error("Bad FCHECK in flate stream"), { name: "UnknownErrorException", details: "FormatError: Bad FCHECK in flate stream" })), "document_invalid");
  assert.equal(code(new Error("anything"), true), "archive_limit_exceeded");
});

test("one PDF read per isolate: a second read waits for the slot, one that waits too long is PdfBusyError", async () => {
  assert.equal(PDF_SLOT_WAIT_MS, 2000);
  const order = [];
  let finishFirst;
  const first = withPdfSlot(() => new Promise(resolve => { order.push("first start"); finishFirst = () => { order.push("first end"); resolve(1); }; }));
  const second = withPdfSlot(async () => { order.push("second start"); return 2; }, 1000);
  const third = withPdfSlot(async () => 3, 20);
  await assert.rejects(third, error => error instanceof PdfBusyError);
  assert.deepEqual(order, ["first start"]);
  finishFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first start", "first end", "second start"]);
  // A failing read releases the slot.
  await assert.rejects(withPdfSlot(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withPdfSlot(async () => 4, 0), 4);
});
