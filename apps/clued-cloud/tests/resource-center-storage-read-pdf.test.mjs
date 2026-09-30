import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { encryptedPdf, identityPdf, latinPdf, predefinedCjkPdf, scannedPdf } from "./resource-center-storage-pdf.fixture.mjs";

// StorageNormalUse.v0.1 §4.5: pdf.js text extraction for clued_storage_read.
// The module imports pdf.js and the generated CMaps extensionless, so it is
// bundled first, as the continuity route tests do.
const directory = await mkdtemp(path.join(os.tmpdir(), "clued-storage-pdf-"));
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-read-pdf.ts", import.meta.url))], outfile: path.join(directory, "pdf.mjs"),
  bundle: true, platform: "node", format: "esm", logLevel: "silent" });
stop();
const { extractPdfText, looksGarbled, readExactBody, PDF_MAX_BYTES, PDF_PAGES_PER_CALL, PDF_TEXT_MAX } =
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
