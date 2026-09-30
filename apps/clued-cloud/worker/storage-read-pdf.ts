import { base64ToBytes } from "./storage-base64";
import { StorageFormatError } from "./storage-read-formats";

/** StorageNormalUse.v0.1 §4.5 (Owner decision 7dbb4c09 Q4): PDF text by page
 * range for clued_storage_read. Pure extraction only: the read agent decides
 * scope, budget and download, and hands the whole file (at most 20 MiB) here.
 *
 * pdf.js (pdfjs-dist legacy build, Apache-2.0) runs in this isolate as its
 * in-thread "fake" worker: no Worker thread, no canvas, no font loading, no
 * eval (pdf.js 6 has no eval path), no network (the only loader is the bundled
 * CMap table below). pdf.js and the CMaps are imported on the first PDF read
 * only, so other requests never parse them.
 *
 * Measured (pdfjs-dist 6.3.289, local workerd and Node, see §4.5): about
 * 3–30 ms per text page once warm, 40–100 ms for the first page of a call
 * (JIT warm-up, CJK CMap parse), 200–250 ms for a page whose font is a whole
 * un-subset 6 MB CJK font. Heap stays near the file size plus 10–35 MB for a
 * 20 MiB file, because getTextContent never decodes images. */

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** Pages per call (contract §5.1: at most 20). */
export const PDF_PAGES_PER_CALL = 20;
/** Extracted text per call, like Office (a call returns at most 256 KiB of it). */
export const PDF_TEXT_MAX = 8 * 1024 * 1024;
/** Wall time for extraction in one call. Checked between pages, after a timer
 * yield (a Worker's clock advances only across I/O and timers); the Worker CPU
 * limit is the backstop for a single pathological page. */
export const PDF_TIME_MS = 10000;

export type PdfTextLayer = "present" | "partial" | "none";
export type PdfExtraction = {
  page_count: number;
  /** First selected page; pages_extracted pages from it are in `text`. */
  page_start: number; pages_extracted: number;
  /** One text: "# Page N" header line per page, then its text. */
  text: string;
  /** The text of pages [page_start, page_start + pages_extracted) is whole. False only
   * when the text limit stopped extraction (the last page may be cut); a time
   * limit instead ends the selection early at a page boundary. */
  complete: boolean;
  text_layer: PdfTextLayer;
  /** Pages whose text looked like glyph codes rather than characters; their text is omitted. */
  unreliable_pages: number[];
  /** A predefined CJK CMap the document needs is not bundled; affected text may be missing. */
  cmap_missing: boolean;
};

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let loading: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    // pdf.js uses globalThis.pdfjsWorker.WorkerMessageHandler as its in-thread worker.
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  loading.catch(() => { loading = null; });
  return loading;
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

/** The whole body into one buffer of exactly `size` bytes (the Drive metadata
 * size, at most 20 MiB): no chunk list plus copy, so peak memory stays at the
 * file size. More or fewer bytes than declared fail closed. */
export async function readExactBody(response: Response, size: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 0 || size > PDF_MAX_BYTES) throw new StorageFormatError("binary_too_large");
  const out = new Uint8Array(size);
  const reader = response.body?.getReader();
  let at = 0;
  if (reader) for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { throw new StorageFormatError("storage_read_unavailable"); }
    if (chunk.done) break;
    if (at + chunk.value.length > size) { await reader.cancel().catch(() => {}); throw new StorageFormatError("storage_read_unavailable"); }
    out.set(chunk.value, at); at += chunk.value.length;
  }
  if (at !== size) throw new StorageFormatError("storage_read_unavailable");
  return out;
}

const withoutControls =(text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function extractPdfText(bytes: Uint8Array, options: { page_start: number; page_count: number; max_text_bytes: number;
  clock?: () => number; time_ms?: number }): Promise<PdfExtraction> {
  if (bytes.length > PDF_MAX_BYTES) throw new StorageFormatError("binary_too_large");
  const clock = options.clock ?? Date.now, deadline = clock() + (options.time_ms ?? PDF_TIME_MS);
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
  let task: ReturnType<PdfJs["getDocument"]>;
  try {
    task = pdfjs.getDocument({ data: bytes, password: "", BinaryDataFactory: BundledData, useWorkerFetch: false, cMapUrl: "bundled/",
      cMapPacked: true, useSystemFonts: false, disableFontFace: true, useWasm: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true, stopAtErrors: false, verbosity: 0 });
  } catch { throw new StorageFormatError("storage_read_unavailable"); }
  try {
    let doc: Awaited<typeof task.promise>;
    // Wrong or required password, damaged structure, not a PDF: fixed code, no parser text.
    try { doc = await task.promise; } catch { throw new StorageFormatError("document_invalid"); }
    const pageCount = doc.numPages;
    const end = Math.min(start + wanted - 1, pageCount);
    const parts: string[] = [], unreliable: number[] = [];
    let size = 0, empty = 0, extracted = 0, complete = start > end;
    for (let number = start; number <= end; number++) {
      // Out of time: the selection ends at the pages already extracted (whole
      // pages, so `complete` stays true and next_page_start continues after them).
      if (extracted > 0) { await pause(); if (clock() > deadline) { complete = true; break; } }
      let raw: string;
      try {
        const page = await doc.getPage(number);
        const content = await page.getTextContent();
        raw = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("");
        page.cleanup();
      } catch { throw new StorageFormatError("document_invalid"); }
      raw = raw.replace(/[ \t\r\n]+$/, "");
      let body = "";
      if (!/\S/.test(raw)) empty++;
      else if (looksGarbled(raw)) unreliable.push(number);
      else body = withoutControls(raw);
      const part = (parts.length ? "\n" : "") + `# Page ${number}\n` + body;
      parts.push(part); size += encoder.encode(part).length; extracted++;
      if (number === end) complete = true;
      if (size >= maxText) break;
    }
    const withText = extracted - empty;
    return { page_count: pageCount, page_start: start, pages_extracted: extracted, text: parts.join(""), complete,
      text_layer: extracted === 0 || withText === extracted ? "present" : withText === 0 ? "none" : "partial",
      unreliable_pages: unreliable, cmap_missing: missing.size > 0 };
  } finally {
    await task.destroy().catch(() => {});
  }
}
