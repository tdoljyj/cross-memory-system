// pdf.js ships no types for its worker module; storage-read-pdf.ts only hands
// the namespace to pdf.js as its in-thread ("fake") worker.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
