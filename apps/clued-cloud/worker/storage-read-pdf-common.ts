import { StorageFormatError } from "./storage-read-formats";

/** StorageNormalUse.v0.1 §4.5: what the main Worker and the PDF extractor
 * Worker share. Nothing here imports pdf.js: the main Worker (clued-cloud)
 * never parses a PDF itself. It downloads the file and hands it to the
 * extractor Worker (clued-storage-pdf) through the PDF_EXTRACTOR service
 * binding (storage-read-pdf-client.ts); the extractor runs pdf.js
 * (storage-read-pdf.ts) in its own isolate (storage-pdf-extractor.ts). */

/** PDFs larger than this are metadata only (and never sent to the extractor). */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** Pages per call (contract §5.1: at most 20). */
export const PDF_PAGES_PER_CALL = 20;
/** Extracted text per call, like Office (a call returns at most 256 KiB of it). */
export const PDF_TEXT_MAX = 8 * 1024 * 1024;
/** Wall time for extraction in one call (the caller may pass less). Checked
 * between pages and every few text chunks, after a timer yield (a Worker's
 * clock advances only across I/O and timers), and inside pdf.js by the guard
 * (PDF_DEADLINE_CHECK_EVERY). */
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
  /** The time limit ended the selection before its last page. */
  time_limited: boolean;
  text_layer: PdfTextLayer;
  /** Pages whose text looked like glyph codes rather than characters; their text is omitted. */
  unreliable_pages: number[];
  /** A predefined CJK CMap the document needs is not bundled; affected text may be missing. */
  cmap_missing: boolean;
};

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

/** How long a PDF read waits for its isolate's PDF slot before it gives up. */
export const PDF_SLOT_WAIT_MS = 2000;
export const PDF_BUSY_HINT = "Another PDF is being read by this server instance right now. Retry the same read in a few seconds.";
/** The PDF slot stayed busy for PDF_SLOT_WAIT_MS (storage_read_unavailable with PDF_BUSY_HINT). */
export class PdfBusyError extends Error { constructor() { super("pdf slot busy"); } }
let pdfSlot: Promise<void> | null = null;
/** Runs `fn` when no other PDF read runs in this isolate. In the main Worker
 * `fn` is the download plus the extractor call (the 20 MiB file and its RPC
 * copy); in the extractor Worker it is one extraction (the file plus pdf.js's
 * working set, about 20-60 MB under the limits of storage-read-pdf.ts), where
 * it waits briefly (pdfSlotWaitMs: at most 2 s and half its time_ms).
 * Two at once could approach the 128 MB isolate. A read waits at most `waitMs`
 * for the slot, then fails PdfBusyError. Waiters are not queued in order; each
 * takes the slot if it is free when it wakes. */
export async function withPdfSlot<T>(fn: () => Promise<T>, waitMs = PDF_SLOT_WAIT_MS): Promise<T> {
  if (pdfSlot) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), waitMs); });
    try { while (pdfSlot) if (await Promise.race([pdfSlot, timeout]) === "timeout") throw new PdfBusyError(); }
    finally { clearTimeout(timer); }
  }
  let release!: () => void;
  pdfSlot = new Promise<void>(resolve => { release = resolve; });
  try { return await fn(); } finally { pdfSlot = null; release(); }
}

/** The read's Drive calls share one 25 s signal; the post-read scope recheck
 * (a fresh ancestor walk) needs time after extraction. */
export const PDF_CALL_MS = 25000, PDF_RECHECK_RESERVE_MS = 5000, PDF_MIN_TIME_MS = 1000;
/** Extraction time for a call whose signal started `elapsedMs` ago: what is
 * left of it after the recheck reserve, at most PDF_TIME_MS; null when less
 * than PDF_MIN_TIME_MS is left (the download took the time). */
export function pdfTimeBudget(elapsedMs: number): number | null {
  const left = PDF_CALL_MS - Math.max(0, elapsedMs) - PDF_RECHECK_RESERVE_MS;
  return left < PDF_MIN_TIME_MS ? null : Math.min(left, PDF_TIME_MS);
}
export const PDF_TIME_CUT_HINT = "The time limit ended this PDF read before the requested offset. Earlier text was already returned: " +
  "read again with page_start = next_page_start and offset 0.";
/** An offset at or past the extracted text. Null: an empty chunk at eof (the
 * selection's text is whole and shorter). A cut by the text limit is
 * archive_limit_exceeded (the text up to offset + length is never reached).
 * A cut by the time limit on a continuation (offset > 0) is
 * storage_read_unavailable with next_page_start: this call ended the
 * selection earlier than the call that produced the offset, so an empty eof
 * would silently drop the rest of the selection. */
export function pdfOffsetPastText(pages: PdfExtraction, textLength: number, offset: number):
  null | { code: "archive_limit_exceeded" } | { code: "storage_read_unavailable"; hint: string; next_page_start: number } {
  if (offset < textLength) return null;
  if (!pages.complete) return { code: "archive_limit_exceeded" };
  if (pages.time_limited && offset > 0)
    return { code: "storage_read_unavailable", hint: PDF_TIME_CUT_HINT, next_page_start: pages.page_start + pages.pages_extracted };
  return null;
}

/** The extractor's RPC contract. The main Worker refuses an extractor whose
 * marker does not name exactly this contract and version (an older or newer
 * extractor deployed without the matching main Worker), and never falls back
 * to parsing in its own isolate. Bump PDF_EXTRACTOR_VERSION whenever the
 * request, result or guard semantics change. */
export const PDF_EXTRACTOR_CONTRACT = "clued.storage-pdf-extractor/1";
export const PDF_EXTRACTOR_VERSION = 1;
/** The Worker the PDF_EXTRACTOR binding names (wrangler.pdf-extractor.jsonc). */
export const PDF_EXTRACTOR_SERVICE = "clued-storage-pdf";
export type PdfExtractorMarker = { contract: typeof PDF_EXTRACTOR_CONTRACT; version: typeof PDF_EXTRACTOR_VERSION;
  /** The pdf.js worker loaded in the extractor carries both build markers of build/pdfjs-decode-guard.mjs. */
  decode_guard: true; font_programs: "skipped" };
/** What the main Worker sends besides the file: these options, nothing else
 * (no credential, identity, file ID or name). */
export type PdfExtractOptions = { page_start: number; page_count: number; max_text_bytes: number; time_ms: number };
export type PdfExtractFailure = "document_invalid" | "archive_limit_exceeded" | "storage_read_unavailable" | "binary_too_large";
export type PdfExtractResult = { contract: typeof PDF_EXTRACTOR_CONTRACT; ok: true; extraction: PdfExtraction } |
  { contract: typeof PDF_EXTRACTOR_CONTRACT; ok: false; code: PdfExtractFailure; busy?: true };
/** Text one result may carry, in UTF-16 code units (at most one per UTF-8 byte
 * of the text limit, plus the rest of the page chunk that crossed it): far
 * under the 32 MiB serialized RPC limit. A larger result is refused. */
export const PDF_RESULT_TEXT_MAX = 16 * 1024 * 1024;

/** Extractor versions the main Worker accepts: this one and its neighbours
 * (never below 1). The release deploys the extractor first, so during the gap
 * the previous main Worker (N-1) meets extractor N (accepted as current+1);
 * a rollback of only the extractor leaves main N with extractor N-1 (accepted
 * as current-1). A version bump must therefore keep the request and result
 * readable by the neighbouring main Worker; a change that cannot is a new
 * PDF_EXTRACTOR_CONTRACT name. When PDF_EXTRACTOR_VERSION changes, the two
 * Workers are still rolled back together. */
export function acceptedExtractorVersions(current: number = PDF_EXTRACTOR_VERSION): number[] {
  return current > 1 ? [current, current + 1, current - 1] : [current, current + 1];
}
/** How long an extraction waits inside the extractor isolate for that
 * isolate's one PDF slot (at most half its own time_ms; the wait is taken off
 * that time) before it is refused as busy. */
export const PDF_EXTRACTOR_SLOT_WAIT_MS = 2000;

/** What the extractor's check() returns: its own marker and the extraction of
 * the fixed check PDF, which it runs outside the user PDF slot. */
export type PdfExtractorCheckResult = { marker: unknown; result: PdfExtractResult };
/** A one-page PDF reading "Clued PDF extractor check" (Helvetica, no
 * compression, a few hundred bytes), built inside the extractor by check():
 * nothing is taken from the caller. */
export function pdfExtractorCheckPdf(): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td (Clued PDF extractor check) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let out = "%PDF-1.7\n";
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
export const PDF_EXTRACTOR_CHECK_TEXT = "# Page 1\nClued PDF extractor check";
export const PDF_EXTRACTOR_CHECK_OPTIONS: Readonly<PdfExtractOptions> = Object.freeze({ page_start: 1, page_count: 1, max_text_bytes: 4096, time_ms: 5000 });
