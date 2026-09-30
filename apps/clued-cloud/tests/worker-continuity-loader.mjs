import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { pdfDecodeGuardEsbuildPlugin } from "../build/pdfjs-decode-guard.mjs";

let workerPromise;

// The production entry bundles vinext and Cloudflare runtime imports. Route
// tests run the same continuity handler directly in Node, as other transport
// tests in this suite already do.
export function loadContinuityWorker() {
  workerPromise ??= (async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clued-continuity-route-"));
    const output = path.join(directory, "continuity.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../worker/continuity.ts", import.meta.url))],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      // The production build patches pdf.js with the decode guard; so does this one.
      plugins: [pdfDecodeGuardEsbuildPlugin()],
    });
    stop();
    const { handleContinuityRequest, runProjectionRefreshPipeline,
      runProjectionRefreshScheduled, runStorageRefreshScheduled, runStorageRecoveryScheduled, runStorageJobQueue,
      runStorageStagingScheduled } = await import(pathToFileURL(output).href);
    return {
      fetch: (request, env, ctx) => handleContinuityRequest(request, env, ctx),
      runProjectionRefreshPipeline,
      runProjectionRefreshScheduled,
      runStorageRefreshScheduled,
      runStorageRecoveryScheduled,
      runStorageJobQueue,
      runStorageStagingScheduled,
    };
  })();
  return workerPromise;
}
