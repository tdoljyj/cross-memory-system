import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";

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
    });
    stop();
    const { handleContinuityRequest } = await import(pathToFileURL(output).href);
    return { fetch: (request, env) => handleContinuityRequest(request, env) };
  })();
  return workerPromise;
}
