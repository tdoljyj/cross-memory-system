import { StorageFormatError } from "./storage-read-formats";
import { classifyPdfError, extractPdfText, pdfWorkerReady, withPdfSlot, PdfBusyError, PDF_EXTRACTOR_CONTRACT, PDF_EXTRACTOR_VERSION,
  PDF_EXTRACTOR_CHECK_OPTIONS, PDF_EXTRACTOR_SLOT_WAIT_MS, pdfExtractorCheckPdf,
  PDF_MAX_BYTES, PDF_PAGES_PER_CALL, PDF_TEXT_MAX, PDF_TIME_MS, type PdfExtractFailure, type PdfExtractOptions, type PdfExtractResult,
  type PdfExtractorCheckResult, type PdfExtractorMarker } from "./storage-read-pdf";

/** StorageNormalUse.v0.1 §4.5, Owner decision 7210e5a5: the PDF extractor
 * Worker (clued-storage-pdf). It takes the bytes of one PDF plus the
 * extraction options and returns the extraction or a fixed failure code. It
 * has no secrets, no database, no network and no bindings: a hostile PDF that
 * gets past every limit of storage-read-pdf.ts can only exhaust this Worker's
 * isolate (128 MB, limits.cpu_ms), which the main Worker sees as one failed
 * extractor call. The limits and patches of storage-read-pdf.ts and
 * build/pdfjs-decode-guard.mjs stay the first line of defence. */

const FAILURES: ReadonlySet<string> = new Set<PdfExtractFailure>(["document_invalid", "archive_limit_exceeded", "storage_read_unavailable", "binary_too_large"]);
const failure = (code: string, busy = false): PdfExtractResult =>
  ({ contract: PDF_EXTRACTOR_CONTRACT, ok: false, code: (FAILURES.has(code) ? code : "storage_read_unavailable") as PdfExtractFailure, ...(busy ? { busy: true as const } : {}) });

/** The marker the main Worker checks before it sends a PDF; decode_guard is
 * true only when the patched pdf.js worker (both build markers) loads. */
export async function extractorMarker(ready: () => Promise<boolean> = pdfWorkerReady): Promise<PdfExtractorMarker | { contract: string; version: number; decode_guard: false }> {
  return await ready() ? { contract: PDF_EXTRACTOR_CONTRACT, version: PDF_EXTRACTOR_VERSION, decode_guard: true, font_programs: "skipped" }
    : { contract: PDF_EXTRACTOR_CONTRACT, version: PDF_EXTRACTOR_VERSION, decode_guard: false };
}

const integer = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
/** Exactly the four options, each an integer in range; anything else is refused. */
export function extractOptions(raw: unknown): PdfExtractOptions | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "max_text_bytes,page_count,page_start,time_ms") return null;
  if (!integer(o.page_start, 1, Number.MAX_SAFE_INTEGER) || !integer(o.page_count, 1, PDF_PAGES_PER_CALL) ||
    !integer(o.max_text_bytes, 0, PDF_TEXT_MAX) || !integer(o.time_ms, 1, PDF_TIME_MS)) return null;
  return { page_start: Number(o.page_start), page_count: Number(o.page_count), max_text_bytes: Number(o.max_text_bytes), time_ms: Number(o.time_ms) };
}

const classified = (error: unknown): PdfExtractResult =>
  failure(error instanceof StorageFormatError ? error.code : classifyPdfError(error, false).code);

/** One extraction. One user PDF runs in this isolate at a time (each holds its
 * file here). A second waits for the slot at most PDF_EXTRACTOR_SLOT_WAIT_MS
 * and at most half its time_ms (for example the first read's extraction still
 * running after its caller timed out), with the wait taken off its time_ms,
 * then is refused as busy. */
export async function runExtraction(bytes: unknown, rawOptions: unknown, extract: typeof extractPdfText = extractPdfText,
  slotWaitMs: number = PDF_EXTRACTOR_SLOT_WAIT_MS): Promise<PdfExtractResult> {
  const input = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
  if (!input || input.length === 0) return failure("storage_read_unavailable");
  if (input.length > PDF_MAX_BYTES) return failure("binary_too_large");
  const options = extractOptions(rawOptions);
  if (!options) return failure("storage_read_unavailable");
  const queued = Date.now();
  try {
    const extraction = await withPdfSlot(() => extract(input, { ...options, time_ms: Math.max(1, options.time_ms - (Date.now() - queued)) }),
      Math.min(slotWaitMs, Math.floor(options.time_ms / 2)));
    return { contract: PDF_EXTRACTOR_CONTRACT, ok: true, extraction };
  } catch (error) {
    if (error instanceof PdfBusyError) return failure("storage_read_unavailable", true);
    return classified(error);
  }
}

/** When the running check started; a check older than its own time limit plus
 * 5 s (its call was canceled before it could clear this) no longer counts. */
let checkSince: number | null = null;
const CHECK_STALE_MS = PDF_EXTRACTOR_CHECK_OPTIONS.time_ms + 5000;
/** The release check: the marker plus the extraction of the fixed built-in
 * check PDF (a few hundred bytes, no caller input). It never takes the user
 * PDF slot, so checks cannot make user reads busy. It has its own slot of
 * one: a check arriving while another runs in this isolate is answered busy at
 * once (no promise is shared across calls), so at most one check PDF is parsed
 * here at a time next to at most one user PDF. */
export async function runCheck(extract: typeof extractPdfText = extractPdfText, ready: () => Promise<boolean> = pdfWorkerReady,
  now: () => number = Date.now): Promise<PdfExtractorCheckResult> {
  const marker = await extractorMarker(ready);
  if (!marker.decode_guard) return { marker, result: failure("storage_read_unavailable") };
  const started = now();
  if (checkSince !== null && started - checkSince < CHECK_STALE_MS) return { marker, result: failure("storage_read_unavailable", true) };
  checkSince = started;
  try { return { marker, result: { contract: PDF_EXTRACTOR_CONTRACT, ok: true, extraction: await extract(pdfExtractorCheckPdf(), { ...PDF_EXTRACTOR_CHECK_OPTIONS }) } }; }
  catch (error) { return { marker, result: classified(error) }; }
  finally { if (checkSince === started) checkSince = null; }
}
