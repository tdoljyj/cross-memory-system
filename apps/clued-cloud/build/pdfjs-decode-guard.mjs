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
 * - "object": each array, array element, Dict (weight DICT_WEIGHT) and Dict
 *   entry Parser.getObj / makeInlineImage builds, charged with the parser
 *   (content streams, indirect objects, object streams, xref recovery), which
 *   carries the size of the top-level object being parsed;
 * - "oplist": each operator added to an OperatorList and each path operator
 *   PartialEvaluator.buildPath records (text extraction builds operator lists
 *   only for Type3 CharProcs, and keeps them with the font);
 * - "chars": the characters of each string, hex string and name the Lexer
 *   returns (content streams, objects and embedded CMaps alike);
 * - "cmap": CMap entries (CMap.mapOne, and the codes of each mapCidRange /
 *   mapBfRange / mapBfRangeToArray range, charged with the CMap and its
 *   highest code before the range is filled): the CMap parser reads with the
 *   Lexer directly, and one `<000000> <FFFFFF> <4100>` bfrange would otherwise
 *   fill 16 M entries;
 * - "limit": BrotliStream (its decoder has no output bound, so it is refused
 *   before decoding), every image decoder (JpegStream / Jbig2Stream /
 *   JpxStream / CCITTFaxStream.decodeImage allocate the whole image outside
 *   ensureBuffer; text extraction never needs one), and a string, hex
 *   string, name or array past 256 Ki elements (pdf.js collects them one
 *   element at a time).
 *
 * It also bounds EvaluatorPreprocessor.nonProcessedArgs (the extra operands
 * pdf.js keeps for the rest of a content stream) to the last 33.
 *
 * worker/storage-read-pdf.ts installs the guard, charges each call to the
 * extraction running in the current async context and throws once a limit is
 * reached or, checked every few thousand calls, the call's deadline has
 * passed (so CPU is bounded inside a page, a form or a CharProc). A missing guard throws (TypeError), so nothing is decoded unguarded.
 * The patched module also exports CLUED_PDF_DECODE_GUARD, which
 * storage-read-pdf.ts requires before it parses any PDF: a build that skipped
 * this step fails closed. The anchors match pdfjs-dist 6.3.289 exactly; any
 * other text fails the build. */

export const PDF_WORKER_MODULE = /[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.worker\.mjs$/;

const G = "globalThis.__cluedPdfDecodeGuard";
const MAX_ELEMENTS = 256 * 1024;
/** A Dict (an object with its own Map) costs about as much heap as 6 array elements. */
const DICT_WEIGHT = 6;
/** EvaluatorPreprocessor.read refuses a 34th operand ("Too many arguments"). */
const MAX_OPERANDS = 33;
/** An operator kept in an operator list (its operand array has room for 17
 * elements) costs about as much heap as a Dict; a path operator adds 3–7
 * numbers to one shared path buffer and weighs 1. */
const OPERATOR_WEIGHT = 6;
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
  // EvaluatorPreprocessor.read: operands beyond an operator's count move to
  // nonProcessedArgs, which pdf.js keeps for the rest of the stream (a later
  // operator short of operands takes them back). Only the last MAX_OPERANDS
  // are kept, as many as one operator can be given before "Too many arguments".
  ["            while (argsLength > numArgs) {\n              nonProcessedArgs.push(args.shift());\n              argsLength--;\n            }\n",
    "            while (argsLength > numArgs) {\n              nonProcessedArgs.push(args.shift());\n              argsLength--;\n            }\n" +
    `            if (nonProcessedArgs.length > ${MAX_OPERANDS}) nonProcessedArgs.splice(0, nonProcessedArgs.length - ${MAX_OPERANDS});\n`],
  // OperatorList.addOp / PartialEvaluator.buildPath: an operator list pdf.js
  // keeps (a Type3 font's CharProcs, built when the font loads for text) holds
  // every operator, its operands and its path points.
  ["  addOp(fn, args) {\n    this.optimizer.push(fn, args);\n    this.weight++;", `  addOp(fn, args) {\n    ${G}("oplist", null, ${OPERATOR_WEIGHT});\n    this.optimizer.push(fn, args);\n    this.weight++;`],
  ["  buildPath(fn, args, state) {\n    const {\n      pathMinMax: minMax,\n      pathBuffer\n    } = state;",
    `  buildPath(fn, args, state) {\n    ${G}("oplist", null, 1);\n    const {\n      pathMinMax: minMax,\n      pathBuffer\n    } = state;`],
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
  // Parser.getObj: a wrapper tracks the nesting depth, so the guard can bound
  // each top-level object (a content-stream operand or one indirect object).
  ["  getObj(cipherTransform = null) {\n    const buf1 = this.buf1;\n    this.shift();",
    "  getObj(cipherTransform = null) {\n    if (!this.__cluedDepth) this.__cluedTree = 0;\n    this.__cluedDepth = (this.__cluedDepth || 0) + 1;\n" +
    "    try {\n      return this.__cluedGetObj(cipherTransform);\n    } finally {\n      this.__cluedDepth--;\n    }\n  }\n" +
    "  __cluedGetObj(cipherTransform = null) {\n    const buf1 = this.buf1;\n    this.shift();"],
  // Parser.getObj arrays: each new array and each element.
  ["        case \"[\":\n          const array = [];", `        case "[":\n          ${G}("object", this, 1);\n          const array = [];`],
  ["            array.push(this.getObj(cipherTransform));",
    `            if (array.length > ${MAX_ELEMENTS}) ${G}("limit");\n            ${G}("object", this, 1);\n            array.push(this.getObj(cipherTransform));`],
  // Parser.getObj dictionaries: each new Dict (a Map of its own) and each entry.
  ["        case \"<<\":\n          const dict = new Dict(this.xref);", `        case "<<":\n          ${G}("object", this, ${DICT_WEIGHT});\n          const dict = new Dict(this.xref);`],
  ["            dict.set(key, this.getObj(cipherTransform));", `            ${G}("object", this, 1);\n            dict.set(key, this.getObj(cipherTransform));`],
  // Parser.makeInlineImage: the inline image dictionary.
  ["    const dict = new Dict(this.xref);\n    let dictLength;", `    ${G}("object", this, ${DICT_WEIGHT});\n    const dict = new Dict(this.xref);\n    let dictLength;`],
  ["      dict.set(key, this.getObj(cipherTransform));\n    }\n    if (lexer.beginInlineImagePos !== -1) {",
    `      ${G}("object", this, 1);\n      dict.set(key, this.getObj(cipherTransform));\n    }\n    if (lexer.beginInlineImagePos !== -1) {`],
  // Lexer.getString / getName / getHexString: characters per call.
  ["    return strBuf.join(\"\");\n  }\n  getName() {", `    ${G}("chars", null, strBuf.length);\n    return strBuf.join("");\n  }\n  getName() {`],
  ["    return Name.get(strBuf.join(\"\"));", `    ${G}("chars", null, strBuf.length);\n    return Name.get(strBuf.join(""));`],
  ["    return strBuf.join(\"\");\n  }\n  getObj() {", `    ${G}("chars", null, strBuf.length);\n    return strBuf.join("");\n  }\n  getObj() {`],
  // CMap.mapOne / mapCidRange / mapBfRange / mapBfRangeToArray: each fills one
  // map entry per code (a string per code for bfrange), up to 2^24 per range.
  ["  mapOne(src, dst) {\n    this._map[src] = dst;", `  mapOne(src, dst) {\n    ${G}("cmap", this, 1, src);\n    this._map[src] = dst;`],
  ...["mapCidRange", "mapBfRange"].map(name => [`throw new Error("${name} - ignoring data above MAX_MAP_RANGE.");\n    }`,
    `throw new Error("${name} - ignoring data above MAX_MAP_RANGE.");\n    }\n    ${G}("cmap", this, high - low + 1, high);`]),
  ["throw new Error(\"mapBfRangeToArray - ignoring data above MAX_MAP_RANGE.\");\n    }\n    const ii = array.length;",
    `throw new Error("mapBfRangeToArray - ignoring data above MAX_MAP_RANGE.");\n    }\n    const ii = array.length;\n    ${G}("cmap", this, Math.min(high - low + 1, ii), high);`],
  // Image decoders (DCT, JBIG2, JPX, CCITTFax) decode the whole image at once
  // outside DecodeStream.ensureBuffer. Text extraction never paints images, so
  // any image decode (e.g. a ToUnicode or font stream with /Filter /DCTDecode) is refused.
  ["  decodeImage(bytes) {\n    if (this.eof) {\n      return this.buffer;\n    }\n    bytes = this.#skipUselessBytes(bytes || this.bytes);",
    `  decodeImage(bytes) {\n    ${G}("limit");\n    if (this.eof) {\n      return this.buffer;\n    }\n    bytes = this.#skipUselessBytes(bytes || this.bytes);`],
  ["    bytes = Jbig2Stream.stripFileHeader(bytes || this.bytes);", `    ${G}("limit");\n    bytes = Jbig2Stream.stripFileHeader(bytes || this.bytes);`],
  ["    bytes ||= this.bytes;\n    this.buffer = await JpxImage.instance.decode(", `    ${G}("limit");\n    bytes ||= this.bytes;\n    this.buffer = await JpxImage.instance.decode(`],
  ["    bytes ??= this.stream.isAsync ? (await this.stream.asyncGetBytes()) || this.bytes : this.bytes;\n    this.buffer = await JBig2CCITTFaxImage.instance.decode(bytes, this.dict.get(\"W\", \"Width\")",
    `    ${G}("limit");\n    bytes ??= this.stream.isAsync ? (await this.stream.asyncGetBytes()) || this.bytes : this.bytes;\n    this.buffer = await JBig2CCITTFaxImage.instance.decode(bytes, this.dict.get("W", "Width")`],
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
