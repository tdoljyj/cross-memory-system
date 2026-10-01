import { StorageFormatError } from "./storage-read-formats";
import { acceptedExtractorVersions, PDF_EXTRACTOR_CHECK_OPTIONS, PDF_EXTRACTOR_CHECK_TEXT, PDF_EXTRACTOR_CONTRACT, PDF_EXTRACTOR_VERSION, PDF_MAX_BYTES,
  PDF_RESULT_TEXT_MAX, type PdfExtraction, type PdfExtractOptions } from "./storage-read-pdf-common";
export { PDF_EXTRACTOR_CHECK_TEXT };

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
export const PDF_EXTRACTOR_STOPPED_HINT = "The PDF reader stopped on this file before it finished (it ran out of memory, CPU or time). " +
  "Reading the same pages again will stop the same way: read fewer pages per call (page_count) or skip this file.";
/** The extractor isolate's one PDF slot stayed busy (for example with an
 * earlier read whose caller already timed out). */
export const PDF_EXTRACTOR_BUSY_HINT = "The PDF reader is still busy with another PDF, so no PDF text was read. Retry the same read in a few seconds.";
/** Only an error text that clearly names an exhausted resource limit counts as
 * the file stopping the reader (archive_limit_exceeded); a dropped connection,
 * a redeploy, a canceled or unknown failure is the service being unavailable. */
const RESOURCE_LIMIT = /exceeded (?:its |the )?(?:memory|cpu|resource)|(?:memory|cpu time|resource) limits?\b|out of memory/i;
export function extractorCallFailure(error: unknown): PdfExtractorError {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return RESOURCE_LIMIT.test(text) ? new PdfExtractorError("archive_limit_exceeded", PDF_EXTRACTOR_STOPPED_HINT) : unavailable();
}
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

/** The marker must name exactly this contract, this version or the one before
 * it (acceptedExtractorVersions: the deploy gap between the two Workers), and
 * report the patched pdf.js worker (decode guard, no font programs). */
export function validMarker(marker: unknown, current: number = PDF_EXTRACTOR_VERSION): boolean {
  return record(marker) && marker.contract === PDF_EXTRACTOR_CONTRACT && typeof marker.version === "number" &&
    acceptedExtractorVersions(current).includes(marker.version) && marker.decode_guard === true && marker.font_programs === "skipped";
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
        // CPU (archive_limit_exceeded), or the call was dropped, canceled or
        // crashed for another reason (unavailable). Not retried here.
        throw extractorCallFailure(error);
      }
      if (result === TIMEOUT) throw new PdfExtractorError("archive_limit_exceeded", PDF_EXTRACTOR_STOPPED_HINT);
      if (!record(result) || result.contract !== PDF_EXTRACTOR_CONTRACT) throw unavailable();
      if (result.ok === false) {
        if (result.busy === true) throw new PdfExtractorError("storage_read_unavailable", PDF_EXTRACTOR_BUSY_HINT);
        if (typeof result.code === "string" && FAILURES.has(result.code)) throw new StorageFormatError(result.code as "document_invalid");
        throw unavailable();
      }
      const extraction = result.ok === true ? validExtraction(result.extraction, request) : null;
      if (!extraction) throw unavailable();
      return extraction;
    },
  });
}

/** The main Worker's public GET route for the release check (scripts/verify-pdf-extractor.mjs). */
export const PDF_EXTRACTOR_CHECK_PATH = "/v1/storage/pdf-extractor/check";
export type PdfExtractorCheck = { contract: "clued.storage-pdf-extractor-check/1"; status: "ok" | "unavailable";
  /** The extractor's own marker (contract and version) as its check() returned it; null when there was none. */
  extractor: { contract: string; version: number } | null; code?: string };
const CHECK_CONTRACT = "clued.storage-pdf-extractor-check/1" as const;
/** How long the whole check() call may take: a cold pdf.js load plus the check extraction and the grace. */
export const PDF_EXTRACTOR_CHECK_TIMEOUT_MS = PDF_MARKER_TIMEOUT_MS + PDF_EXTRACTOR_CHECK_OPTIONS.time_ms + PDF_EXTRACTOR_GRACE_MS;

/** Release-time proof that the binding works: one check() call to the
 * extractor, which parses its own fixed built-in check PDF outside the user
 * PDF slot (so a check never makes a user read busy) and returns its marker
 * with the extraction. The marker must pass validMarker and the text must be
 * exactly PDF_EXTRACTOR_CHECK_TEXT. No user data, no secret, no request input. */
export async function checkPdfExtractor(raw: unknown, { timeoutMs = PDF_EXTRACTOR_CHECK_TIMEOUT_MS } = {}): Promise<PdfExtractorCheck> {
  const candidate = raw as { check?: unknown } | null | undefined;
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function") || typeof candidate.check !== "function")
    return { contract: CHECK_CONTRACT, status: "unavailable", extractor: null, code: "storage_read_unavailable" };
  const binding = candidate as { check(): Promise<unknown> };
  let reply: unknown;
  try { reply = await within(() => binding.check(), timeoutMs); }
  catch (error) { return { contract: CHECK_CONTRACT, status: "unavailable", extractor: null, code: extractorCallFailure(error).code }; }
  if (reply === TIMEOUT || !record(reply)) return { contract: CHECK_CONTRACT, status: "unavailable", extractor: null, code: "storage_read_unavailable" };
  const marker = reply.marker;
  const extractor = record(marker) && typeof marker.contract === "string" && marker.contract.length <= 128 && Number.isSafeInteger(marker.version)
    ? { contract: marker.contract, version: Number(marker.version) } : null;
  const base = { contract: CHECK_CONTRACT, extractor };
  if (!validMarker(marker)) return { ...base, status: "unavailable", code: "extractor_marker_invalid" };
  const result = reply.result;
  if (!record(result) || result.contract !== PDF_EXTRACTOR_CONTRACT) return { ...base, status: "unavailable", code: "storage_read_unavailable" };
  if (result.ok !== true) return { ...base, status: "unavailable", code: result.busy === true ? "check_busy"
    : typeof result.code === "string" && FAILURES.has(result.code) ? result.code : "storage_read_unavailable" };
  const extraction = validExtraction(result.extraction, PDF_EXTRACTOR_CHECK_OPTIONS);
  if (!extraction || extraction.text !== PDF_EXTRACTOR_CHECK_TEXT || extraction.page_count !== 1 || !extraction.complete)
    return { ...base, status: "unavailable", code: "check_text_mismatch" };
  return { ...base, status: "ok" };
}

export type PdfExtractorCheckResponse = PdfExtractorCheck & {
  /** When the round trip this answer reports ran (ISO 8601); null when none ran. */
  checked_at: string | null;
  /** True when the answer is a recent round trip's result served again without calling the extractor. */
  cached: boolean };
/** The public check route's guard in the main Worker isolate: an OK result is
 * served again for okTtlMs (60 s) and a failure for failureTtlMs (5 s)
 * without calling the extractor, and only one check per isolate is in flight
 * (single flight: a request arriving meanwhile gets the last result, or
 * check_in_progress, and never waits on another request's promise). So the
 * public route calls the extractor at most about once a minute per main
 * isolate while it works and once every 5 s while it does not, and there is
 * no parameter that bypasses this. A newly deployed main Worker starts with
 * new isolates and therefore an empty cache. */
export function createPdfExtractorCheckGate({ okTtlMs = 60_000, failureTtlMs = 5_000, now = Date.now, run = checkPdfExtractor }:
  { okTtlMs?: number; failureTtlMs?: number; now?: () => number; run?: (raw: unknown) => Promise<PdfExtractorCheck> } = {}) {
  let last: { at: number; check: PdfExtractorCheck } | null = null;
  // When the running check started; one older than the check timeout plus 5 s
  // (its request was canceled before it could clear this) no longer counts.
  let runningSince: number | null = null;
  const replay = (entry: { at: number; check: PdfExtractorCheck }): PdfExtractorCheckResponse =>
    ({ ...entry.check, checked_at: new Date(entry.at).toISOString(), cached: true });
  return async (raw: unknown): Promise<PdfExtractorCheckResponse> => {
    const started = now();
    if (last && started >= last.at && started - last.at < (last.check.status === "ok" ? okTtlMs : failureTtlMs)) return replay(last);
    if (runningSince !== null && started - runningSince < PDF_EXTRACTOR_CHECK_TIMEOUT_MS + 5000)
      return last ? replay(last) : { contract: CHECK_CONTRACT, status: "unavailable", extractor: null, code: "check_in_progress", checked_at: null, cached: false };
    runningSince = started;
    let check: PdfExtractorCheck;
    try { check = await run(raw); }
    catch { check = { contract: CHECK_CONTRACT, status: "unavailable", extractor: null, code: "storage_read_unavailable" }; }
    finally { if (runningSince === started) runningSince = null; }
    const entry = { at: now(), check };
    last = entry;
    return { ...check, checked_at: new Date(entry.at).toISOString(), cached: false };
  };
}
