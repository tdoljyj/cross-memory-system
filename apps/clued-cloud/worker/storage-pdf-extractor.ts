import { WorkerEntrypoint } from "cloudflare:workers";
import { extractorMarker, runCheck, runExtraction } from "./storage-pdf-extractor-core";

/** Entry point of the PDF extractor Worker clued-storage-pdf
 * (wrangler.pdf-extractor.jsonc; StorageNormalUse.v0.1 §4.5, Owner decision
 * 7210e5a5). Reachable only through the main Worker's PDF_EXTRACTOR service
 * binding (no workers.dev route, no preview URL, no custom domain). RPC only:
 * marker(), extract(bytes, options) and check() (the fixed built-in check
 * PDF, outside the user PDF slot). */
export default class PdfExtractor extends WorkerEntrypoint {
  async marker() { return await extractorMarker(); }
  async extract(bytes: Uint8Array, options: unknown) { return await runExtraction(bytes, options); }
  async check() { return await runCheck(); }
  async fetch(): Promise<Response> { return new Response(null, { status: 404 }); }
}
