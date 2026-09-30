import { readFile } from "node:fs/promises";

/** StorageNormalUse.v0.1 §4.5 resource bounds. pdf.js has no limit on decoded
 * bytes, parsed tokens or token sizes, so a small PDF (a deflate bomb) can make
 * it allocate far beyond a 128 MB Worker isolate or run for many seconds. This
 * build step adds a call to globalThis.__cluedPdfDecodeGuard(kind, subject,
 * bytes) at every place the pinned pdf.js worker grows without bound:
 *
 * - "decode": DecodeStream.ensureBuffer (every synchronous decoder: Flate, LZW,
 *   RunLength, ASCII85/Hex, predictors, decryption, concatenated page content)
 *   and asyncGetBytesFromDecompressionStream (the native DecompressionStream
 *   path pdf.js takes for embedded CMaps / ToUnicode and images);
 * - "token": each object EvaluatorPreprocessor reads from a content stream, so
 *   operator bombs are bounded by count, not only by decoded size;
 * - "primitive": each new entry in pdf.js's isolate-wide Name / Cmd caches;
 * - "limit": BrotliStream (its decoder has no output bound, so it is refused
 *   before decoding), and a string, hex string, name or array past 256 Ki
 *   elements (pdf.js collects them one element at a time).
 *
 * worker/storage-read-pdf.ts installs the guard, charges each call to the
 * extraction running in the current async context and throws once a limit is
 * reached. A missing guard throws (TypeError), so nothing is decoded unguarded.
 * The patched module also exports CLUED_PDF_DECODE_GUARD, which
 * storage-read-pdf.ts requires before it parses any PDF: a build that skipped
 * this step fails closed. The anchors match pdfjs-dist 6.3.289 exactly; any
 * other text fails the build. */

export const PDF_WORKER_MODULE = /[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.worker\.mjs$/;

const G = "globalThis.__cluedPdfDecodeGuard";
const MAX_ELEMENTS = 256 * 1024;
const PATCHES = [
  // DecodeStream.ensureBuffer
  ["    while (size < requested) {\n      size *= 2;\n    }\n    const buffer2 = new Uint8Array(size);",
    `    while (size < requested) {\n      size *= 2;\n    }\n    ${G}("decode", this, size);\n    const buffer2 = new Uint8Array(size);`],
  // DecodeStream.asyncGetBytesFromDecompressionStream
  ["      for await (const chunk of readable) {\n        chunks.push(chunk);",
    // Twice the chunk: the chunks are joined into one more buffer of the same size at the end.
    `      for await (const chunk of readable) {\n        ${G}("decode", this, 2 * chunk.byteLength);\n        chunks.push(chunk);`],
  // BrotliStream.readBlock
  ["  readBlock() {\n    const bytes = this.stream.getBytes();\n    const decodedData = BrotliDecode(",
    `  readBlock() {\n    ${G}("limit");\n    const bytes = this.stream.getBytes();\n    const decodedData = BrotliDecode(`],
  // EvaluatorPreprocessor.read
  ["  read(operation) {\n    let args = operation.args;\n    while (true) {\n      const obj = this.parser.getObj();",
    `  read(operation) {\n    let args = operation.args;\n    while (true) {\n      ${G}("token");\n      const obj = this.parser.getObj();`],
  // Name.get / Cmd.get
  ["    return NameCache[name] ||= new Name(name);", `    return NameCache[name] ||= (${G}("primitive"), new Name(name));`],
  ["    return CmdCache[cmd] ||= new Cmd(cmd);", `    return CmdCache[cmd] ||= (${G}("primitive"), new Cmd(cmd));`],
  // Lexer.getString
  ["    let ch = this.nextChar();\n    while (true) {\n      let charBuffered = false;",
    `    let ch = this.nextChar();\n    while (true) {\n      if (strBuf.length > ${MAX_ELEMENTS}) ${G}("limit");\n      let charBuffered = false;`],
  // Lexer.getName
  ["    while ((ch = this.nextChar()) >= 0 && !specialChars[ch]) {\n      if (ch === 0x23) {",
    `    while ((ch = this.nextChar()) >= 0 && !specialChars[ch]) {\n      if (strBuf.length > ${MAX_ELEMENTS}) ${G}("limit");\n      if (ch === 0x23) {`],
  // Lexer.getHexString
  ["        } else {\n          strBuf.push(String.fromCharCode(firstDigit << 4 | digit));",
    `        } else {\n          if (strBuf.length > ${MAX_ELEMENTS}) ${G}("limit");\n          strBuf.push(String.fromCharCode(firstDigit << 4 | digit));`],
  // Parser.getObj arrays
  ["            array.push(this.getObj(cipherTransform));",
    `            if (array.length > ${MAX_ELEMENTS}) ${G}("limit");\n            array.push(this.getObj(cipherTransform));`],
];

export function patchPdfWorker(source) {
  let out = source;
  for (const [anchor, replacement] of PATCHES) {
    if (out.split(anchor).length !== 2) throw new Error("pdfjs-decode-guard: pdf.worker.mjs does not match the pinned pdfjs-dist; re-check the patch anchors");
    out = out.replace(anchor, () => replacement);
  }
  return out + "\nexport const CLUED_PDF_DECODE_GUARD = true;\n";
}

const clean = id => id.split("?")[0];

/** Vite (Worker build). */
export function pdfDecodeGuardVitePlugin() {
  return { name: "clued-pdfjs-decode-guard", enforce: "pre",
    transform(code, id) { return PDF_WORKER_MODULE.test(clean(id)) ? { code: patchPdfWorker(code), map: null } : null; } };
}

/** esbuild (tests bundle worker/storage-read-pdf.ts with esbuild). */
export function pdfDecodeGuardEsbuildPlugin() {
  return { name: "clued-pdfjs-decode-guard", setup(build) {
    build.onLoad({ filter: PDF_WORKER_MODULE }, async args => ({ contents: patchPdfWorker(await readFile(args.path, "utf8")), loader: "js" }));
  } };
}
