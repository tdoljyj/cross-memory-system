import { AsyncLocalStorage } from "node:async_hooks";
import { base64ToBytes } from "./storage-base64";
import { StorageFormatError } from "./storage-read-formats";
import { PDF_MAX_BYTES, PDF_PAGES_PER_CALL, PDF_TEXT_MAX, PDF_TIME_MS, type PdfExtraction } from "./storage-read-pdf-common";
export * from "./storage-read-pdf-common";

/** StorageNormalUse.v0.1 §4.5 (Owner decision 7dbb4c09 Q4): PDF text by page
 * range for clued_storage_read. Pure extraction only: the read agent decides
 * scope, budget and download in the main Worker, which hands the whole file (at
 * most 20 MiB) to the extractor Worker (storage-pdf-extractor.ts, Owner decision
 * 7210e5a5) through the PDF_EXTRACTOR service binding. Only that Worker bundles
 * this module, so a PDF that defeats every limit below costs one failed read in
 * the extractor's isolate, never the main Worker's isolate or its other requests.
 *
 * pdf.js (pdfjs-dist legacy build, Apache-2.0) runs in the extractor's isolate as its
 * in-thread "fake" worker: no Worker thread, no canvas, no font loading, no
 * eval (pdf.js 6 has no eval path), no network (the only loader is the bundled
 * CMap table below). pdf.js and the CMaps are imported on the first PDF read
 * only, so other requests never parse them.
 *
 * Measured (pdfjs-dist 6.3.289, local workerd and Node, see §4.5): about
 * 3–30 ms per text page once warm, 40–100 ms for the first page of a call
 * (JIT warm-up, CJK CMap parse), 200–250 ms for a page whose font is a whole
 * un-subset 6 MB CJK font. Heap stays near the file size plus 10–35 MB for a
 * 20 MiB file, because getTextContent never decodes images.
 *
 * Small hostile files (§4.5 resource bounds): pdf.js itself has no limit on
 * decoded bytes, and a 70 KB deflate bomb decodes to hundreds of MB. So
 * (1) build/pdfjs-decode-guard.mjs patches the pinned worker to call the
 * guard below for every decoded-byte allocation, content-stream token, new
 * cached name, CMap entry, parsed array / Dict element, kept operator,
 * lexed string character and per-font glyph-table entry (/W, /W2,
 * CIDToGIDMap, Identity Unicode map; clamped to CIDs 0..0xFFFF), and for every image decode (refused: text never
 * needs one), and the guard refuses past the PDF_DECODE_* / PDF_TOKENS_MAX /
 * PDF_PRIMITIVES_MAX / PDF_CMAP_ENTRIES_MAX / PDF_OBJECT_* / PDF_OBJECTS_MAX /
 * PDF_CONTENT_OBJECTS_MAX / PDF_STRING_CHARS_MAX / PDF_GLYPH_ENTRIES_MAX limits of this call
 * (archive_limit_exceeded); pdf.js decodes a page's content stream whole
 * before it evaluates it, so these also bound text bombs; the guard also
 * checks the call's deadline every PDF_DEADLINE_CHECK_EVERY calls, so a page,
 * form or CharProc without text cannot run on either; (2) page text is read as
 * a stream and cancelled once the call's text limit or deadline is passed, so
 * one page can neither grow the text nor run on, and a call stops past
 * PDF_TEXT_ITEMS_MAX text items; (3) embedded font programs are never parsed
 * (the patch removes the FontFile lookup): text comes from the font
 * dictionary (Encoding / Differences, ToUnicode, predefined CMaps), so a
 * Type1 / CFF font whose codes only its own built-in encoding names, without
 * ToUnicode, yields an unreliable page (§4.5 false negative). */

/** Decoded-byte buffers one pdf.js stream may allocate. Buffers grow by
 * doubling, so this keeps any one decoded stream under 8 MiB (at most 12 MiB
 * live while it grows); real content streams, fonts and CMaps are far smaller. */
export const PDF_DECODE_STREAM_MAX = 16 * 1024 * 1024;
/** Decoded-byte buffers all streams of one call may allocate (about 32 MiB of
 * decoded content, which also bounds the operators pdf.js interprets). */
export const PDF_DECODE_TOTAL_MAX = 48 * 1024 * 1024;

/** Content-stream objects (operands and operators) pdf.js may parse in one
 * call: about 0.5–1 µs each, so an operator bomb stops within a few seconds;
 * a dense text page has some 10–50 thousand. */
export const PDF_TOKENS_MAX = 4_000_000;
/** New entries in pdf.js's isolate-wide Name / Cmd caches in one call (a real
 * document has a few thousand distinct names). */
export const PDF_PRIMITIVES_MAX = 200_000;
/** Weighted CMap entries pdf.js may create in one call (CMap.mapOne, and every
 * code of each cidrange / bfrange, charged before the range is filled: one
 * range may name up to 2^24 codes). An entry of a bundled predefined CMap
 * weighs 1; an entry of a CMap embedded in the PDF weighs 4 (each bfrange code
 * becomes its own string, and a ToUnicode map is copied once more into the
 * font); either weighs twice as much at a code above 0xFFFF (the map becomes a
 * sparse dictionary). Measured under Node (pdfjs-dist 6.3.289): about 45
 * bytes of heap per predefined entry (its font's Unicode map included) and
 * 70–250 bytes per embedded entry, so the limit keeps CMaps to about 16–20 MB
 * of the isolate. The largest bundled CMap (GBK2K-V with its usecmap parent)
 * has about 60 thousand entries and a typical non-embedded CJK font
 * (UniGB-UCS2-H plus Adobe-GB1-UCS2) about 59 thousand, so a call may load
 * some 6 such fonts (an Identity-H font with an Adobe CIDSystemInfo and no
 * ToUnicode loads only the 18–30 thousand of the UCS2 map); a document that
 * needs more fails archive_limit_exceeded rather than exhausting the isolate. */
export const PDF_CMAP_ENTRIES_MAX = 400_000;
/** Weighted size of one top-level object pdf.js parses (a content-stream
 * operand such as a TJ array, or one indirect object): arrays and their
 * elements and Dict entries weigh 1, each Dict 6 (build/pdfjs-decode-guard.mjs
 * DICT_WEIGHT); at most about 38 bytes of heap per unit (a Dict in an array),
 * some 19 MB. Real objects are far smaller (a CJK font's /W array has some
 * 10–100 thousand elements). */
export const PDF_OBJECT_TREE_MAX = 512 * 1024;
/** Weighted units of all content-stream objects one call parses (pages, form
 * XObjects, Type3 CharProcs, annotation appearances: parsers without
 * allowStreams), plus 6 per operator and 1 per path operator added to an
 * operator list pdf.js keeps (Type3 CharProcs; build/pdfjs-decode-guard.mjs
 * OPERATOR_WEIGHT: an operator's operand array costs about a Dict). Cumulative, not per operand: pdf.js
 * holds up to 33 operands before an operator, keeps extra operands for the
 * rest of the stream, and keeps a CharProc's operators with its font, so only
 * a running total bounds what content parsing can hold at once (about 19 MB
 * at 38 bytes per unit), and it also bounds the CPU spent building objects.
 * A kerned text page (a TJ element every few characters) uses some 3–10
 * thousand units, so 20 such pages stay far below it. */
export const PDF_CONTENT_OBJECTS_MAX = 512 * 1024;
/** Weighted units of all indirect objects one call parses (parsers with
 * allowStreams: the xref, object streams, trailers). pdf.js caches parsed
 * objects for the document, so these stay alive: about 36 MB. */
export const PDF_OBJECTS_MAX = 1_000_000;
/** String, hex-string and name characters the Lexer returns in one call (each
 * string is collected one character per array element; one string is also
 * capped at 256 Ki). Real text is far less: 20 dense pages hold some 100–200
 * thousand characters. */
export const PDF_STRING_CHARS_MAX = 4 * 1024 * 1024;
/** Per-font glyph-table entries pdf.js may fill in one call from a few numbers
 * of a font dictionary: each code of a CIDFont /W or /W2 range, each CID of a
 * CIDToGIDMap stream, and each code an IdentityToUnicodeMap visits (an
 * Identity font without ToUnicode: 65 536 per font). Each range is first
 * clamped to CIDs 0..0xFFFF (build/pdfjs-decode-guard.mjs), so one font adds
 * at most 65 536 per table; this bound keeps many fonts from multiplying it.
 * Measured under Node (pdfjs-dist 6.3.289): about 8-10 bytes of heap per
 * entry, some 16-20 MB at the limit. A call may load some 30 Identity fonts
 * without ToUnicode, or 10 whose /W and /W2 each span all 65 536 CIDs; before
 * the bound, 100 such fonts (a 65 KB file) or one `/W [0 30000000 500]` (1 KB)
 * exhausted a 64 MB heap. */
export const PDF_GLYPH_ENTRIES_MAX = 2_000_000;
/** Cross-reference entries pdf.js may allocate in one call (xref table lines,
 * xref stream entries, entries found while reconstructing a damaged file): an
 * entry object costs some 40-60 bytes of heap, so about 16-24 MB at the limit.
 * A 20 MiB document with this many objects would average about 50 bytes per
 * object; real ones have far fewer (a 1 000-page manual some 50-150 thousand).
 * Before the bound, `/W [0 0 0] /Size 10000000` (a 560 B file) or `/W [1 0 0]`
 * over 9 MB of Flate zeros (9 KB) exhausted a 64 MB heap. */
export const PDF_XREF_ENTRIES_MAX = 400_000;
/** Characters x codespace ranges pdf.js may scan in one call
 * (CMap.readCharCode compares each shown character with every codespace range
 * of the font's encoding CMap; build/pdfjs-decode-guard.mjs also caps a CMap at
 * 1 024 ranges). A real CMap has 1-8 ranges, so 20 dense CJK pages (some
 * 100-200 thousand characters) scan about 1-2 M; at the limit, about 0.1 s.
 * Before, 400 000 ranges and a 200 KB string ran for minutes. */
export const PDF_CODESPACE_SCAN_MAX = 32 * 1024 * 1024;

/** The guard compares the call's clock with its deadline once every this many
 * guard calls (tokens, objects, strings, operators, decoded buffers ...), so a
 * page, form or CharProc without text cannot run past the deadline. A Worker's
 * clock advances only across I/O and timers, so inside workerd this check sees
 * the time as of pdf.js's last await; the cumulative limits above are what
 * bound CPU there (a few seconds at most). */
export const PDF_DEADLINE_CHECK_EVERY = 4096;
/** Text-content items one call may receive from pdf.js, counted in
 * extractPdfText's item loop. pdf.js builds each item (a text run, an
 * end-of-line marker) with its own transform and layout work, some 8-10 µs
 * each under Node with a 64 MB heap, so this bounds that work to about 2 s
 * whatever the other limits allow (a `(a)'` line is only 2 tokens and 5
 * decoded bytes, so the token and decode limits would allow 2 million).
 * pdf.js merges the glyphs of one run into one item, and glyphs placed one by
 * one at their natural advance too: 20 dense kerned pages yield about 1 200
 * items, and a page of individually positioned words or table cells some
 * 1-5 thousand, so only a call whose pages average more than 10 000
 * separately positioned runs is a false positive (archive_limit_exceeded;
 * read fewer pages per call). */
export const PDF_TEXT_ITEMS_MAX = 200_000;

type DecodeBudget = { allocated: number; tokens: number; primitives: number; cmap: number; objects: number; content: number; chars: number; glyphs: number;
  xref: number; scan: number; exceeded: boolean; calls: number; clock: () => number; deadline: number; timedOut: boolean; streams: WeakMap<object, number> };
const decodeBudgets = new AsyncLocalStorage<DecodeBudget>();
/** Thrown by the guard; `cluedPdfLimit` lets the patched CMap parser rethrow it
 * instead of skipping to the next token. Once a call is over a limit or past its
 * deadline every further guard call throws the same prebuilt error, so a pdf.js
 * loop that swallows errors (one per token) does not also build a stack trace
 * per token (800 000 of them took 10 s). */
class DecodeLimit extends Error { readonly cluedPdfLimit = true; }
const OVER_LIMIT = new DecodeLimit("pdf resource limit"), OVER_TIME = new DecodeLimit("pdf time limit");
/** Called by the patched pdf.js worker (build/pdfjs-decode-guard.mjs): before
 * it allocates `bytes` of decoded data for `stream` ("decode"), for each
 * content-stream token ("token"), for each new cached Name / Cmd
 * ("primitive"), before CMap `stream` gets `bytes` entries up to `code`
 * ("cmap", weighted: PDF_CMAP_ENTRIES_MAX), before parser `stream` builds an
 * array, element, Dict or Dict entry of weight `bytes` ("object":
 * PDF_OBJECT_TREE_MAX / PDF_OBJECTS_MAX / PDF_CONTENT_OBJECTS_MAX), for each
 * operator or path operator added to a kept operator list ("oplist":
 * PDF_CONTENT_OBJECTS_MAX), for the `bytes` characters of each
 * lexed string or name ("chars": PDF_STRING_CHARS_MAX), before a font's
 * glyph table gets `bytes` entries ("glyphs": PDF_GLYPH_ENTRIES_MAX), before
 * `bytes` cross-reference entries are allocated ("xref": PDF_XREF_ENTRIES_MAX),
 * before `bytes` characters x codespace ranges are scanned ("scan":
 * PDF_CODESPACE_SCAN_MAX), and where a
 * hard limit is hit ("limit", which includes every image decode). Outside an
 * extraction (no budget in the async context) nothing may be decoded. pdf.js
 * may swallow the throw (stopAtErrors: false skips a failing stream), so the
 * budget records it and the extraction fails with archive_limit_exceeded
 * instead of returning partial text; past the deadline (timedOut) it fails
 * with the time-limit semantics of extractPdfText instead. */
function decodeGuard(kind: "decode" | "token" | "primitive" | "cmap" | "object" | "oplist" | "chars" | "glyphs" | "xref" | "scan" | "limit", stream?: object | null, bytes = 0, code = 0): void {
  const budget = decodeBudgets.getStore();
  if (!budget) {
    // Module evaluation creates a few Names before any extraction runs.
    if (kind === "token" || kind === "primitive") return;
    throw new DecodeLimit("pdf decode outside an extraction");
  }
  if (budget.timedOut || (++budget.calls % PDF_DEADLINE_CHECK_EVERY === 0 && budget.clock() > budget.deadline)) {
    budget.timedOut = true;
    throw OVER_TIME;
  }
  if (!budget.exceeded) {
    if (kind === "token") { if (++budget.tokens <= PDF_TOKENS_MAX) return; }
    else if (kind === "primitive") { if (++budget.primitives <= PDF_PRIMITIVES_MAX) return; }
    else if (kind === "cmap") {
      // A range with high < low fills nothing; anything not a count is refused.
      const weight = ((stream as { builtInCMap?: unknown } | undefined)?.builtInCMap === true ? 1 : 4) * (code > 0xffff ? 2 : 1);
      if (Number.isFinite(bytes) && (budget.cmap += Math.max(0, bytes) * weight) <= PDF_CMAP_ENTRIES_MAX) return;
    }
    else if (kind === "object" && stream) {
      // __cluedTree: the size of the top-level object this parser is building
      // (reset by the patched Parser.getObj at depth 0).
      // allowStreams: an indirect-object parser (PDF_OBJECTS_MAX); any other
      // parser reads a content stream (PDF_CONTENT_OBJECTS_MAX).
      const parser = stream as { __cluedTree?: number; allowStreams?: unknown };
      const tree = parser.__cluedTree = (parser.__cluedTree ?? 0) + bytes;
      if (tree <= PDF_OBJECT_TREE_MAX && (parser.allowStreams === true ? (budget.objects += bytes) <= PDF_OBJECTS_MAX
        : (budget.content += bytes) <= PDF_CONTENT_OBJECTS_MAX)) return;
    }
    else if (kind === "oplist") { if ((budget.content += bytes) <= PDF_CONTENT_OBJECTS_MAX) return; }
    else if (kind === "chars") { if ((budget.chars += bytes) <= PDF_STRING_CHARS_MAX) return; }
    else if (kind === "glyphs") { if (Number.isFinite(bytes) && (budget.glyphs += Math.max(0, bytes)) <= PDF_GLYPH_ENTRIES_MAX) return; }
    else if (kind === "xref") { if (Number.isFinite(bytes) && (budget.xref += Math.max(0, bytes)) <= PDF_XREF_ENTRIES_MAX) return; }
    else if (kind === "scan") { if (Number.isFinite(bytes) && (budget.scan += Math.max(0, bytes)) <= PDF_CODESPACE_SCAN_MAX) return; }
    else if (kind === "decode" && stream) {
      const used = (budget.streams.get(stream) ?? 0) + bytes;
      if (used <= PDF_DECODE_STREAM_MAX && budget.allocated + bytes <= PDF_DECODE_TOTAL_MAX) {
        budget.streams.set(stream, used); budget.allocated += bytes;
        return;
      }
    }
  }
  budget.exceeded = true;
  throw OVER_LIMIT;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loading: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    (globalThis as { __cluedPdfDecodeGuard?: unknown }).__cluedPdfDecodeGuard = decodeGuard;
    // pdf.js uses globalThis.pdfjsWorker.WorkerMessageHandler as its in-thread worker.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    // Only the worker patched with the decode guard may parse a PDF.
    if (worker.CLUED_PDF_DECODE_GUARD !== true) throw new Error("pdf.js worker without the decode guard");
    // ... and only one that never parses embedded font programs.
    if (worker.CLUED_PDF_FONT_PROGRAMS !== "skipped") throw new Error("pdf.js worker that parses embedded font programs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** True once the patched pdf.js worker (both build markers) is loaded: the
 * extractor's marker reports it, so the main Worker never sends a PDF to an
 * extractor built without the guard. */
export async function pdfWorkerReady(): Promise<boolean> {
  try { await loadPdfJs(); return true; } catch { return false; }
}

const encoder = new TextEncoder();

/** Share of characters that cannot be real text, and how scattered the rest is
 * across unrelated scripts. A font without a usable ToUnicode map makes pdf.js
 * emit glyph IDs as code points: small IDs become control characters, large
 * ones a spray of unrelated scripts (Tamil, Sinhala, IPA, ...) in one line.
 * Heuristic by design: plausible-looking wrong CJK can still pass. */
export function looksGarbled(text: string): boolean {
  let total = 0, bad = 0, other = 0;
  const buckets = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x3000 || cp === 0xa0) continue;
    total++;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfffd || (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000 ||
      (cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe || (cp >= 0xd800 && cp <= 0xdfff)) { bad++; continue; }
    // Common text families count as one bucket each; anything else by 128-code-point block.
    const common = cp < 0x250 || (cp >= 0x370 && cp < 0x530) || (cp >= 0x2000 && cp < 0x2c00) || (cp >= 0x2e80 && cp < 0xa000) ||
      (cp >= 0xac00 && cp < 0xd7b0) || (cp >= 0xf900 && cp < 0xfb00) || (cp >= 0xfe30 && cp < 0xfe50) || (cp >= 0xff00 && cp < 0xfff0) ||
      (cp >= 0x1d400 && cp < 0x1d800) || (cp >= 0x1f300 && cp < 0x1fb00) || (cp >= 0x20000 && cp < 0x40000);
    if (!common) { other++; buckets.add(cp >> 7); }
  }
  if (total < 8) return bad > total / 2;
  return bad / total > 0.1 || (buckets.size >= 4 && other / total >= 0.2);
}


// C0/C1 controls, and the bidi embedding / override / isolate controls that
// could make extracted text display in another order than it reads.
const withoutControls = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
/** UTF-8 length without encoding (a lone surrogate counts 3, as TextEncoder writes U+FFFD). */
function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Failures that are not about the file (allocation, stack depth) are
 * storage_read_unavailable; a decode limit is archive_limit_exceeded; the rest
 * is the parser refusing the file. pdf.js hands worker errors to this side as
 * UnknownErrorException whose `details` keep the original "Name: message". */
export function classifyPdfError(error: unknown, limitHit: boolean): StorageFormatError {
  if (error instanceof StorageFormatError) return error;
  if (limitHit) return new StorageFormatError("archive_limit_exceeded");
  const e = (error ?? {}) as { name?: unknown; message?: unknown; details?: unknown };
  const text = `${String(e.name)}: ${String(e.message)} ${String(e.details ?? "")}`;
  if (error instanceof RangeError || /RangeError|InternalError|allocation failed|out of memory|invalid (typed )?array length/i.test(text))
    return new StorageFormatError("storage_read_unavailable");
  return new StorageFormatError("document_invalid");
}


export async function extractPdfText(bytes: Uint8Array, options: { page_start: number; page_count: number; max_text_bytes: number;
  clock?: () => number; time_ms?: number }): Promise<PdfExtraction> {
  if (bytes.length > PDF_MAX_BYTES) throw new StorageFormatError("binary_too_large");
  const clock = options.clock ?? Date.now, deadline = clock() + Math.min(options.time_ms ?? PDF_TIME_MS, PDF_TIME_MS);
  const start = options.page_start, wanted = Math.min(options.page_count, PDF_PAGES_PER_CALL);
  const maxText = Math.min(options.max_text_bytes, PDF_TEXT_MAX);
  let pdfjs: PdfJs, cmaps: Readonly<Record<string, string>>;
  try {
    [pdfjs, { PDF_CMAPS: cmaps }] = await Promise.all([loadPdfJs(), import("./generated/pdf-cmaps")]);
  } catch { throw new StorageFormatError("storage_read_unavailable"); }
  const missing = new Set<string>();
  // The only data pdf.js may load: bundled packed CMaps. Standard font data and
  // wasm decoders are refused (text extraction does not need them).
  class BundledData {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      const name = String(filename).replace(/\.bcmap$/, "");
      if (kind === "cMapUrl") {
        if (Object.hasOwn(cmaps, name)) return base64ToBytes(cmaps[name]);
        missing.add(name);
      }
      throw new Error("unavailable");
    }
  }
  const budget: DecodeBudget = { allocated: 0, tokens: 0, primitives: 0, cmap: 0, objects: 0, content: 0, chars: 0, glyphs: 0, xref: 0, scan: 0, exceeded: false,
    calls: 0, clock, deadline, timedOut: false, streams: new WeakMap() };
  // pdf.js's in-thread worker runs in promise jobs started from here, so all
  // decoding for this document sees this budget through the async context.
  return decodeBudgets.run(budget, async (): Promise<PdfExtraction> => {
    let task: ReturnType<PdfJs["getDocument"]>;
    try {
      task = pdfjs.getDocument({ data: bytes, password: "", BinaryDataFactory: BundledData, useWorkerFetch: false, cMapUrl: "bundled/",
        cMapPacked: true, useSystemFonts: false, disableFontFace: true, useWasm: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
        enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true, stopAtErrors: false, verbosity: 0 });
    } catch { throw new StorageFormatError("storage_read_unavailable"); }
    try {
      let doc: Awaited<typeof task.promise>;
      // Wrong or required password, damaged structure, not a PDF: fixed code, no parser text.
      try { doc = await task.promise; } catch (error) { throw budget.timedOut && !budget.exceeded ? new StorageFormatError("storage_read_unavailable") : classifyPdfError(error, budget.exceeded); }
      if (budget.exceeded) throw new StorageFormatError("archive_limit_exceeded");
      // The deadline passed inside the guard before any page: nothing whole to return.
      if (budget.timedOut) throw new StorageFormatError("storage_read_unavailable");
      const pageCount = doc.numPages;
      const end = Math.min(start + wanted - 1, pageCount);
      const parts: string[] = [], unreliable: number[] = [];
      let size = 0, empty = 0, extracted = 0, items = 0, complete = start > end, timeLimited = false;
      for (let number = start; number <= end; number++) {
        // Out of time: the selection ends at the pages already extracted (whole
        // pages, so `complete` stays true and next_page_start continues after them).
        if (extracted > 0) { await pause(); if (clock() > deadline) { complete = true; timeLimited = true; break; } }
        let raw = "", pageBytes = 0, cut: "text" | "time" | null = null;
        try {
          const page = await doc.getPage(number);
          const reader = page.streamTextContent().getReader();
          try {
            for (let chunks = 1; ; chunks++) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const item of value.items) {
                if (++items > PDF_TEXT_ITEMS_MAX) { budget.exceeded = true; throw new StorageFormatError("archive_limit_exceeded"); }
                if (!("str" in item)) continue;
                const piece = item.str + (item.hasEOL ? "\n" : "");
                raw += piece; pageBytes += utf8Length(piece);
              }
              // Past the text this call can return: stop pdf.js evaluating the page.
              if (size + pageBytes > maxText) { cut = "text"; break; }
              if (chunks % 16 === 0) { await pause(); if (clock() > deadline) { cut = "time"; break; } }
            }
          } finally {
            if (cut || budget.exceeded) await reader.cancel(new Error(`pdf ${cut ?? "resource"} limit`)).catch(() => {});
            page.cleanup();
          }
        } catch (error) {
          if (!budget.timedOut || budget.exceeded) throw classifyPdfError(error, budget.exceeded);
        }
        if (budget.exceeded) throw new StorageFormatError("archive_limit_exceeded");
        // The guard saw the deadline pass inside the page (pdf.js may have
        // swallowed its throw and returned part of the page): a time cut.
        if (budget.timedOut) cut = "time";
        if (cut === "time") {
          // Mid-page: the page is dropped and the selection ends before it. If
          // not even the first page finished in time there is nothing whole to return.
          if (extracted === 0) throw new StorageFormatError("storage_read_unavailable");
          complete = true; timeLimited = true; break;
        }
        raw = raw.replace(/[ \t\r\n]+$/, "");
        let body = "";
        if (!/\S/.test(raw)) empty++;
        else if (looksGarbled(raw)) unreliable.push(number);
        else body = withoutControls(raw);
        const part = (parts.length ? "\n" : "") + `# Page ${number}\n` + body;
        parts.push(part); size += encoder.encode(part).length; extracted++;
        // Text limit inside the page: this page is cut, so the text is unfinished.
        if (cut === "text") { complete = false; break; }
        if (number === end) complete = true;
        if (size >= maxText) break;
      }
      const withText = extracted - empty;
      return { page_count: pageCount, page_start: start, pages_extracted: extracted, text: parts.join(""), complete, time_limited: timeLimited,
        text_layer: extracted === 0 || withText === extracted ? "present" : withText === 0 ? "none" : "partial",
        unreliable_pages: unreliable, cmap_missing: missing.size > 0 };
    } finally {
      await task.destroy().catch(() => {});
    }
  });
}
