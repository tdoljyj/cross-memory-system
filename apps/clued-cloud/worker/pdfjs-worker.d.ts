// pdf.js ships no types for its worker module; storage-read-pdf.ts only hands
// the namespace to pdf.js as its in-thread ("fake") worker, after checking the
// marker that build/pdfjs-decode-guard.mjs adds to the patched module.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
  export const CLUED_PDF_DECODE_GUARD: true | undefined;
  export const CLUED_PDF_FONT_PROGRAMS: "skipped" | undefined;
}
