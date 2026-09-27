import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const outputPath = process.argv[2];
if (!outputPath || !path.isAbsolute(outputPath)) throw new Error("An absolute Host output path is required.");
await build({ entryPoints: [fileURLToPath(new URL("./resource-center-daily-runner.mjs", import.meta.url))],
  outfile: outputPath, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning" });
