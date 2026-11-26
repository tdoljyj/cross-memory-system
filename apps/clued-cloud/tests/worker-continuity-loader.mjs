import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { pdfDecodeGuardEsbuildPlugin } from "../build/pdfjs-decode-guard.mjs";

let workerPromise, extractorPromise;

// The production entry bundles vinext and Cloudflare runtime imports. Route
// tests run the same continuity handler directly in Node, as other transport
// tests in this suite already do.
export function loadContinuityWorker() {
  workerPromise ??= (async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clued-continuity-route-"));
    const output = path.join(directory, "continuity.mjs");
    // No pdf.js patch here: the main Worker never bundles pdf.js (StorageNormalUse
    // §4.5, Owner decision 7210e5a5); PDFs go to the extractor Worker binding.
    await build({
      entryPoints: [fileURLToPath(new URL("../worker/continuity.ts", import.meta.url))],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    stop();
    if ((await readFile(output, "utf8")).includes("WorkerMessageHandler")) throw new Error("the continuity handler bundles pdf.js");
    const { handleContinuityRequest, runProjectionRefreshPipeline,
      wakeProjectionRefresh, runStorageRefreshScheduled, runStorageRecoveryScheduled, runStorageJobQueue,
      runStorageStagingScheduled, runStorageOnboardScheduled, runStorageUnattemptedReleaseScheduled } = await import(pathToFileURL(output).href);
    return {
      fetch: (request, env, ctx) => handleContinuityRequest(request, env, ctx),
      runProjectionRefreshPipeline,
      wakeProjectionRefresh,
      runStorageRefreshScheduled,
      runStorageRecoveryScheduled,
      runStorageJobQueue,
      runStorageStagingScheduled,
      runStorageOnboardScheduled,
      runStorageUnattemptedReleaseScheduled,
    };
  })();
  return workerPromise;
}

/** An in-process stand-in for the PDF_EXTRACTOR service binding: the extractor
 * Worker's own code (storage-pdf-extractor-core.ts, pdf.js with the decode-guard
 * patch), with arguments and results structured-cloned as RPC does. The real
 * RPC path is exercised under workerd by resource-center-storage-pdf-extractor.test.mjs. */
export function loadPdfExtractorBinding() {
  extractorPromise ??= (async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clued-pdf-extractor-"));
    const output = path.join(directory, "extractor.mjs");
    await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-pdf-extractor-core.ts", import.meta.url))], outfile: output,
      bundle: true, platform: "node", format: "esm", logLevel: "silent", plugins: [pdfDecodeGuardEsbuildPlugin()] });
    stop();
    const core = await import(pathToFileURL(output).href);
    return { core, binding: Object.freeze({
      async marker() { return structuredClone(await core.extractorMarker()); },
      async extract(bytes, options) { return structuredClone(await core.runExtraction(structuredClone(bytes), structuredClone(options))); },
      async check() { return structuredClone(await core.runCheck()); },
    }) };
  })();
  return extractorPromise;
}
