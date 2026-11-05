// Builds the PDF extractor Worker clued-storage-pdf (StorageNormalUse.v0.1
// §4.5, Owner decision 7210e5a5) into dist/pdf-extractor/index.js, the `main`
// of wrangler.pdf-extractor.jsonc (no_bundle: the file is uploaded as built).
// pdf.js is bundled with the decode-guard patch (build/pdfjs-decode-guard.mjs);
// the build fails if the patch markers are missing from the output or if the
// main Worker's server bundle contains pdf.js (it must never parse a PDF).
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { pdfDecodeGuardEsbuildPlugin } from "../build/pdfjs-decode-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export const PDF_EXTRACTOR_OUTDIR = path.join(root, "dist", "pdf-extractor");
export const PDF_EXTRACTOR_ENTRY = path.join(root, "worker", "storage-pdf-extractor.ts");
/** Strings only the patched pdf.js worker contains; all must be in the extractor bundle. */
export const PDF_EXTRACTOR_REQUIRED = ["CLUED_PDF_DECODE_GUARD = true", "CLUED_PDF_FONT_PROGRAMS = \"skipped\"", "__cluedPdfDecodeGuard(\"xref\"",
  "cluedObjStmBytes", "cmap.length <= 65536 ? new Array(cmap.length) : []", "__cluedPdfDecodeGuard(\"scan\""];
/** Strings that mark a bundled pdf.js; none may be in the main Worker's server bundle. */
export const PDF_JS_MARKERS = ["CLUED_PDF_DECODE_GUARD", "__cluedPdfDecodeGuard", "WorkerMessageHandler", "pdfjsVersion"];

export async function buildPdfExtractor({ outdir = PDF_EXTRACTOR_OUTDIR } = {}) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const outfile = path.join(outdir, "index.js");
  await build({ entryPoints: [PDF_EXTRACTOR_ENTRY], outfile, bundle: true, platform: "neutral", conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"], external: ["node:*", "cloudflare:*"], format: "esm", target: "es2022", logLevel: "warning",
    legalComments: "inline", plugins: [pdfDecodeGuardEsbuildPlugin()] });
  const files = await readdir(outdir);
  if (files.length !== 1 || files[0] !== "index.js") throw new Error(`pdf extractor build: unexpected output ${files.join(", ")}`);
  const code = await readFile(outfile, "utf8");
  for (const marker of PDF_EXTRACTOR_REQUIRED) if (!code.includes(marker)) throw new Error(`pdf extractor build: patched pdf.js marker missing: ${marker}`);
  return { outfile, bytes: Buffer.byteLength(code) };
}

/** The main Worker's server bundle must not contain pdf.js. */
export async function assertMainWithoutPdfJs(serverDir = path.join(root, "dist", "server")) {
  const found = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(m?js)$/.test(entry.name)) {
        const code = await readFile(full, "utf8");
        for (const marker of PDF_JS_MARKERS) if (code.includes(marker)) found.push(`${path.relative(root, full)}: ${marker}`);
      }
    }
  };
  await walk(serverDir);
  if (found.length) throw new Error(`main Worker bundle contains pdf.js (PDFs must be parsed only by clued-storage-pdf):\n${found.join("\n")}`);
}

if (import.meta.main) {
  const { outfile, bytes } = await buildPdfExtractor();
  console.log(`Built PDF extractor Worker ${path.relative(root, outfile)} (${bytes} bytes).`);
  if (process.argv.includes("--check-main")) {
    await assertMainWithoutPdfJs();
    console.log("Main Worker server bundle contains no pdf.js.");
  }
}
