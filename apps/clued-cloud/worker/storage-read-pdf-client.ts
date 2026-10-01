import { StorageFormatError } from "./storage-read-formats";
import { PDF_BUSY_HINT, PDF_EXTRACTOR_CONTRACT, PDF_EXTRACTOR_VERSION, PDF_MAX_BYTES, PDF_RESULT_TEXT_MAX, type PdfExtraction,
  type PdfExtractOptions } from "./storage-read-pdf-common";

/** StorageNormalUse.v0.1 §4.5, Owner decision 7210e5a5: the main Worker's
 * side of PDF text extraction. pdf.js never runs in the main Worker: this
 * module (which imports nothing of pdf.js) sends the downloaded file and the
 * extraction options to the extractor Worker clued-storage-pdf through the
 * PDF_EXTRACTOR service binding (RPC) and checks what comes back. Whatever the
 * extractor does with a hostile PDF (out of memory, out of CPU, a crash, a
 * hang), the main Worker sees one failed call and answers that read with a
 * fixed code and hint; it never retries the same input and never falls back
 * to parsing in its own isolate. */

export const PDF_EXTRACTOR_UNAVAILABLE_HINT = "The PDF reader service is unavailable right now, so no PDF text was read. " +
  "Other storage reads are not affected; retry this read later.";
export const PDF_EXTRACTOR_STOPPED_HINT = "The PDF reader stopped on this file before it finished (it ran out of memory, CPU or time, or crashed). " +
  "Reading the same pages again will stop the same way: read fewer pages per call (page_count) or skip this file.";
/** How long the marker call may take (it loads pdf.js on a cold extractor isolate: about 0.1-0.3 s). */
export const PDF_MARKER_TIMEOUT_MS = 5000;
/** How much longer than its own deadline (time_ms) an extraction may take
 * before the call counts as stopped: pdf.js checks the deadline between pages,
 * text chunks and every few thousand guard calls, and the result still has to
 * come back. The extractor's limits.cpu_ms ends an isolate that runs on. */
export const PDF_EXTRACTOR_GRACE_MS = 2000;

/** A failure with a fixed hint (the read's error result carries it). */
export class PdfExtractorError extends StorageFormatError {
  constructor(code: "storage_read_unavailable" | "archive_limit_exceeded", readonly hint: string) { super(code); }
}
const unavailable = () => new PdfExtractorError("storage_read_unavailable", PDF_EXTRACTOR_UNAVAILABLE_HINT);

type Binding = { marker(): Promise<unknown>; extract(bytes: Uint8Array, options: PdfExtractOptions): Promise<unknown> };
export type PdfExtractorClient = { extract(bytes: Uint8Array, options: PdfExtractOptions): Promise<PdfExtraction> };

const TIMEOUT = Symbol("timeout");
async function within<T>(start: () => Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
  try { return await Promise.race([Promise.resolve().then(start), timeout]); } finally { clearTimeout(timer); }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The marker must name exactly this contract and version, and report the
 * patched pdf.js worker (decode guard, no font programs). */
export function validMarker(marker: unknown): boolean {
  return record(marker) && marker.contract === PDF_EXTRACTOR_CONTRACT && marker.version === PDF_EXTRACTOR_VERSION &&
    marker.decode_guard === true && marker.font_programs === "skipped";
}

/** The extraction as the read agent uses it, rebuilt field by field; null
 * when anything is missing, out of range or larger than PDF_RESULT_TEXT_MAX. */
export function validExtraction(raw: unknown, options: PdfExtractOptions): PdfExtraction | null {
  if (!record(raw)) return null;
  const { page_count: pages, page_start: start, pages_extracted: extracted, text, complete, time_limited: timeLimited, text_layer: layer,
    unreliable_pages: unreliable, cmap_missing: cmapMissing } = raw;
  if (!Number.isSafeInteger(pages) || Number(pages) < 0 || start !== options.page_start || !Number.isSafeInteger(extracted) ||
    Number(extracted) < 0 || Number(extracted) > options.page_count || (Number(extracted) > 0 && options.page_start + Number(extracted) - 1 > Number(pages)) ||
    typeof text !== "string" || text.length > PDF_RESULT_TEXT_MAX || typeof complete !== "boolean" || typeof timeLimited !== "boolean" ||
    (layer !== "present" && layer !== "partial" && layer !== "none") || typeof cmapMissing !== "boolean" || !Array.isArray(unreliable) ||
    unreliable.length > Number(extracted) || !unreliable.every(page => Number.isSafeInteger(page) && page >= options.page_start && page < options.page_start + Number(extracted)))
    return null;
  return { page_count: Number(pages), page_start: options.page_start, pages_extracted: Number(extracted), text, complete, time_limited: timeLimited,
    text_layer: layer, unreliable_pages: unreliable.map(Number), cmap_missing: cmapMissing };
}

const FAILURES = new Set(["document_invalid", "archive_limit_exceeded", "storage_read_unavailable", "binary_too_large"]);

/** Checks the binding and the extractor's marker before any PDF is downloaded.
 * A missing binding, a failed or slow marker call, or a marker for another
 * contract or version is storage_read_unavailable (fixed hint). */
export async function connectPdfExtractor(raw: unknown, { markerTimeoutMs = PDF_MARKER_TIMEOUT_MS, graceMs = PDF_EXTRACTOR_GRACE_MS } = {}): Promise<PdfExtractorClient> {
  const candidate = raw as Partial<Binding> | null | undefined;
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function") || typeof candidate.marker !== "function" || typeof candidate.extract !== "function")
    throw unavailable();
  const binding = candidate as Binding;
  let marker: unknown;
  try { marker = await within(() => binding.marker(), markerTimeoutMs); } catch { throw unavailable(); }
  if (marker === TIMEOUT || !validMarker(marker)) throw unavailable();
  return Object.freeze({
    async extract(bytes: Uint8Array, options: PdfExtractOptions): Promise<PdfExtraction> {
      // Request bound: one file of at most 20 MiB (under the 32 MiB RPC limit) and the four options.
      if (!(bytes instanceof Uint8Array) || bytes.length > PDF_MAX_BYTES) throw new StorageFormatError("binary_too_large");
      const request: PdfExtractOptions = { page_start: options.page_start, page_count: options.page_count, max_text_bytes: options.max_text_bytes, time_ms: options.time_ms };
      let result: unknown;
      try { result = await within(() => binding.extract(bytes, request), request.time_ms + graceMs); }
      catch (error) {
        // The call itself failed: the extractor's isolate ran out of memory or
        // CPU, crashed, or was torn down. Not retried with the same input.
        const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new PdfExtractorError(/memory|cpu|exceeded|limit|resource/i.test(text) ? "archive_limit_exceeded" : "storage_read_unavailable", PDF_EXTRACTOR_STOPPED_HINT);
      }
      if (result === TIMEOUT) throw new PdfExtractorError("archive_limit_exceeded", PDF_EXTRACTOR_STOPPED_HINT);
      if (!record(result) || result.contract !== PDF_EXTRACTOR_CONTRACT) throw unavailable();
      if (result.ok === false) {
        if (result.busy === true) throw new PdfExtractorError("storage_read_unavailable", PDF_BUSY_HINT);
        if (typeof result.code === "string" && FAILURES.has(result.code)) throw new StorageFormatError(result.code as "document_invalid");
        throw unavailable();
      }
      const extraction = result.ok === true ? validExtraction(result.extraction, request) : null;
      if (!extraction) throw unavailable();
      return extraction;
    },
  });
}

/** A one-page PDF reading "Clued PDF extractor check" (Helvetica, no
 * compression), built once: the release check sends it through the binding. */
function checkPdf(): Uint8Array {
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
/** The main Worker's public GET route for checkPdfExtractor (scripts/verify-pdf-extractor.mjs). */
export const PDF_EXTRACTOR_CHECK_PATH = "/v1/storage/pdf-extractor/check";
export type PdfExtractorCheck = { contract: "clued.storage-pdf-extractor-check/1"; status: "ok" | "unavailable";
  extractor: { contract: string; version: number }; code?: string };

/** Release-time proof that the binding works: the fixed check PDF goes
 * through connectPdfExtractor and must come back as exactly
 * PDF_EXTRACTOR_CHECK_TEXT. No user data, no secret; a fixed input of a few
 * hundred bytes, so the public route that serves it costs one tiny extraction. */
export async function checkPdfExtractor(raw: unknown): Promise<PdfExtractorCheck> {
  const base = { contract: "clued.storage-pdf-extractor-check/1" as const, extractor: { contract: PDF_EXTRACTOR_CONTRACT, version: PDF_EXTRACTOR_VERSION } };
  try {
    const client = await connectPdfExtractor(raw);
    const result = await client.extract(checkPdf(), { page_start: 1, page_count: 1, max_text_bytes: 4096, time_ms: 5000 });
    if (result.text !== PDF_EXTRACTOR_CHECK_TEXT || result.page_count !== 1 || !result.complete) return { ...base, status: "unavailable", code: "check_text_mismatch" };
    return { ...base, status: "ok" };
  } catch (error) {
    return { ...base, status: "unavailable", code: error instanceof StorageFormatError ? error.code : "storage_read_unavailable" };
  }
}
