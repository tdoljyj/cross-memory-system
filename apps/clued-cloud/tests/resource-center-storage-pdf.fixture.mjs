/** Hand-written PDF fixtures for StorageNormalUse.v0.1 §4.5 (clued_storage_read
 * PDF text). Built in-test, nothing read from disk, no PDF library: each
 * fixture isolates one pdf.js path (standard font, predefined CJK CMap,
 * ToUnicode, no Unicode map, no text layer, encryption, deflate bombs). */
import { brotliCompressSync, deflateSync } from "node:zlib";

/** objects: bodies of objects 1..n (object 1 is the catalog). trailerExtra goes into the trailer dictionary. */
export function buildPdf(objects, { trailerExtra = "" } = {}) {
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const stream = content => `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`;
const hex4 = code => code.toString(16).padStart(4, "0");

/** pages: one array of show operations per page; font: the /F1 font object body and its extra objects.
 * Objects: 1 catalog, 2 pages, 3 font, 4.. extras, then page + content pairs. */
function pagesPdf(pages, fontBody, extras = [], trailerExtra = "") {
  const firstPage = 4 + extras.length;
  const kids = pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, fontBody, ...extras];
  pages.forEach((shows, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`);
    objects.push(stream(shows.map((show, line) => `BT /F1 11 Tf 50 ${740 - line * 14} Td ${show} Tj ET`).join("\n")));
  });
  return buildPdf(objects, { trailerExtra });
}

const literal = text => "(" + text.replace(/[\\()]/g, c => "\\" + c) + ")";

/** Latin text in the standard Helvetica font: pages[i] = lines of page i+1 (ASCII). */
export const latinPdf = pages => pagesPdf(pages.map(lines => lines.map(literal)),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

/** Chinese in a non-embedded STSong-Light with the predefined UniGB-UCS2-H CMap
 * (typical iText / reportlab output): pdf.js needs the bundled CMaps. */
export const predefinedCjkPdf = (pages, encoding = "UniGB-UCS2-H") => pagesPdf(
  pages.map(lines => lines.map(text => "<" + [...text].map(c => hex4(c.charCodeAt(0))).join("") + ">")),
  `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /${encoding} /DescendantFonts [4 0 R] >>`,
  ["<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>"]);

/** Identity-H font whose glyph codes are 1..n in order of first use; with
 * `toUnicode` a ToUnicode CMap maps them back (Word / pdf-lib style), without
 * it pdf.js can only emit the codes themselves. `codes` overrides the glyph codes.
 * `widths` replaces the CIDFont's `/DW 1000 /CIDToGIDMap /Identity` (e.g. /W, /W2
 * or a /CIDToGIDMap stream among `extras`, which become objects 7.. of the file);
 * `vertical` uses Identity-V; `baseFont` names the font. */
export function identityPdf(pages, { toUnicode = true, codes, widths = "/DW 1000 /CIDToGIDMap /Identity", extras = [], vertical = false, baseFont = "Embedded" } = {}) {
  const map = new Map();
  const codeOf = c => { if (!map.has(c)) map.set(c, codes?.[map.size] ?? map.size + 1); return map.get(c); };
  const shows = pages.map(lines => lines.map(text => "<" + [...text].map(c => hex4(codeOf(c))).join("") + ">"));
  const cmap = ["/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange", `${map.size} beginbfchar`,
    ...[...map].map(([c, code]) => `<${hex4(code)}> <${hex4(c.charCodeAt(0))}>`), "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"].join("\n");
  return pagesPdf(shows,
    `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-${vertical ? "V" : "H"} /DescendantFonts [4 0 R]${toUnicode ? " /ToUnicode 6 0 R" : ""} >>`,
    [`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R ${widths} >>`,
      `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>`,
      stream(cmap), ...extras]);
}

/** Pages with an image and no text operators (a scan). */
export const scannedPdf = pageCount => buildPdf(["<< /Type /Catalog /Pages 2 0 R >>",
  `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
  ...Array.from({ length: pageCount }, (_, i) => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`,
    stream("q 200 0 0 200 100 300 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x10\x80\x80\x10 EI Q")]).flat()]);

/** Standard security handler with a user password: pdf.js cannot open it without one. */
export const encryptedPdf = () => {
  const plain = Buffer.from(latinPdf([["secret"]])).toString("latin1");
  return new Uint8Array(Buffer.from(plain.replace("/Root 1 0 R ", "/Root 1 0 R /Encrypt << /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <" +
    "3a".repeat(32) + "> /U <" + "5c".repeat(32) + "> >> /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] "), "latin1"));
};

/** Latin PDF padded to at least `size` bytes by a comment after the last
 * object; the xref moves, object offsets do not. */
export function paddedLatinPdf(pages, size) {
  const text = Buffer.from(latinPdf(pages)).toString("latin1");
  const cut = text.lastIndexOf("xref\n");
  const body = text.slice(0, cut) + "%" + "p".repeat(Math.max(0, size - text.length - 2)) + "\n";
  return new Uint8Array(Buffer.from(body + text.slice(cut).replace(/startxref\n\d+/, `startxref\n${body.length}`), "latin1"));
}

// Deflate bombs (§4.5 resource bounds): a small file whose streams decode to many MB.
const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
/** A FlateDecode stream object of `content` (a string), or of `unit` repeated to `decodedBytes` between prefix and suffix. */
export function flateStream(content, { dict = "" } = {}) {
  const data = deflateSync(Buffer.from(content, "latin1"), { level: 9 }).toString("latin1");
  return `<< /Length ${data.length} /Filter /FlateDecode ${dict}>>\nstream\n${data}\nendstream`;
}
function repeatedFlate(prefix, unit, decodedBytes, suffix = "", dict = "") {
  const body = Buffer.alloc(Math.max(unit.length, decodedBytes - prefix.length - suffix.length), unit, "latin1");
  const data = deflateSync(Buffer.concat([Buffer.from(prefix, "latin1"), body, Buffer.from(suffix, "latin1")]), { level: 9 }).toString("latin1");
  return `<< /Length ${data.length} /Filter /FlateDecode ${dict}>>\nstream\n${data}\nendstream`;
}
const onePage = (contents, resources = "/Font << /F1 3 0 R >>") => [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} >>`];
const catalog = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R] /Count 1 >>"];

/** Latin pages whose content streams are FlateDecode (the common real-world case). */
export const flateLatinPdf = pages => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, HELVETICA];
  pages.forEach((lines, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(flateStream(lines.map((line, n) => `BT /F1 11 Tf 50 ${740 - n * 14} Td ${literal(line)} Tj ET`).join("\n")));
  });
  return buildPdf(objects);
};
/** One page per entry, each with a FlateDecode text-line stream of about that many decoded bytes. */
export const textPagesPdf = sizes => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${sizes.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${sizes.length} >>`, HELVETICA];
  sizes.forEach((size, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objects.push(repeatedFlate(`BT /F1 11 Tf 50 700 Td\n(Page ${i + 1} starts here) Tj 0 -14 Td\n`, "(The quick brown fox jumps over the lazy dog) Tj 0 -14 Td (and the second line of the text bomb) Tj 0 14 Td\n", size, "ET\n"));
  });
  return buildPdf(objects);
};
/** A page whose content stream uses the PDF 2.0 BrotliDecode filter and decodes to `decodedBytes` of operators. */
export const brotliBombPdf = decodedBytes => {
  const data = brotliCompressSync(Buffer.alloc(decodedBytes, "q Q\n", "latin1")).toString("latin1");
  return buildPdf([...catalog, HELVETICA, ...onePage("5 0 R"), `<< /Length ${data.length} /Filter /BrotliDecode >>\nstream\n${data}\nendstream`]);
};
/** One page whose content decodes to `decodedBytes` of text lines (text bomb: about 3/4 of it becomes extracted text). */
export const textBombPdf = decodedBytes => buildPdf([...catalog, HELVETICA, ...onePage("5 0 R"),
  repeatedFlate("BT /F1 11 Tf 50 700 Td\n", "(The quick brown fox jumps over the lazy dog) Tj 0 -14 Td (and the second line of the text bomb) Tj 0 14 Td\n", decodedBytes, "ET\n")]);
/** One page whose content decodes to `decodedBytes` of operators that show no text (operator bomb). */
export const operatorBombPdf = decodedBytes => buildPdf([...catalog, HELVETICA, ...onePage("5 0 R"), repeatedFlate("", "q Q\n", decodedBytes)]);
/** One page whose content is one text string of `stringBytes` characters. */
export const longStringPdf = stringBytes => buildPdf([...catalog, HELVETICA, ...onePage("5 0 R"),
  repeatedFlate("BT /F1 11 Tf 50 700 Td (", "x", stringBytes + 25, ") Tj ET\n")]);
/** One page whose Contents array names the same small-looking stream `count` times (pdf.js decodes each reference again). */
export const repeatedStreamPdf = (count, decodedBytes) => buildPdf([...catalog, HELVETICA, ...onePage(`[${Array(count).fill("5 0 R").join(" ")}]`),
  repeatedFlate("", "q Q\n", decodedBytes)]);
/** A Type0 font whose ToUnicode CMap stream decodes to `decodedBytes` (pdf.js inflates CMaps with the native DecompressionStream). */
export const toUnicodeBombPdf = decodedBytes => buildPdf([...catalog,
  "<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>",
  ...onePage("5 0 R"), stream("BT /F1 11 Tf 50 700 Td <00010002> Tj ET"),
  "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Embedded /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Identity >>",
  "<< /Type /FontDescriptor /FontName /Embedded /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
  repeatedFlate("/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n", "% padding padding padding\n",
    decodedBytes, "2 beginbfchar\n<0001> <0041>\n<0002> <0042>\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end\n")]);

// Bombs without compression (independent re-review): allocation that no decoded-byte limit sees.
const identityFont = (toUnicodeRef, fontFileRef = "") => [
  `<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding /Identity-H /DescendantFonts [6 0 R]${toUnicodeRef ? ` /ToUnicode ${toUnicodeRef}` : ""} >>`,
  ...onePage("5 0 R"), stream("BT /F1 11 Tf 50 700 Td <00010002> Tj ET"),
  "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Embedded /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Identity >>",
  `<< /Type /FontDescriptor /FontName /Embedded /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80${fontFileRef ? ` /FontFile2 ${fontFileRef}` : ""} >>`];
/** A plain (unfiltered) ToUnicode CMap whose `ranges` ([low, high, dst] hex strings) are
 * bfrange (`<dst>`) or cidrange (a CID number) entries: pdf.js fills one map entry per code. */
export const cmapRangeBombPdf = (ranges = [["000000", "FFFFFF", "4100"]], { kind = "bfrange" } = {}) => buildPdf([...catalog, ...identityFont("8 0 R"),
  stream(["/CIDInit /ProcSet findresource begin 12 dict begin begincmap", "1 begincodespacerange <000000> <FFFFFF> endcodespacerange",
    `${ranges.length} begin${kind}`, ...ranges.map(([low, high, dst]) => `<${low}> <${high}> ${kind === "bfrange" ? `<${dst}>` : Number.parseInt(dst, 16)}`),
    `end${kind} endcmap CMapName currentdict /CMap defineresource pop end end`].join("\n"))]);
/** A text page whose content is one Flate stream `prefix + unit × count + suffix` (built
 * without holding the repetition in one JS string twice). */
function repeatedUnitPage(prefix, unit, count, suffix) {
  const data = deflateSync(Buffer.concat([Buffer.from(prefix, "latin1"), Buffer.alloc(unit.length * count, unit, "latin1"), Buffer.from(suffix, "latin1")]),
    { level: 9 }).toString("latin1");
  return buildPdf([...catalog, HELVETICA, ...onePage("5 0 R"), `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data}\nendstream`]);
}
/** Object bombs (independent re-review): nested arrays of empty dictionaries in one TJ operand,
 * `groups` arrays of `perGroup` `<<>>` each (`[ [<<>>...] ... ] TJ`). */
export const dictArrayBombPdf = (perGroup = 250000, groups = 8) =>
  repeatedUnitPage("BT /F1 12 Tf [ ", "[" + "<<>>".repeat(perGroup) + "] ", groups, "] TJ ET\n");
/** `[ [[]×perGroup] ×groups ] TJ`: one operand of millions of empty arrays. */
export const emptyArrayBombPdf = (perGroup = 250000, groups = 16) => repeatedUnitPage("BT /F1 12 Tf [ ", "[" + "[]".repeat(perGroup) + "] ", groups, "] TJ ET\n");
/** `[ (a×length)×count ] TJ`: strings each under the per-string cap, together millions of characters. */
export const stringArrayBombPdf = (length = 200000, count = 40) => repeatedUnitPage("BT /F1 12 Tf [ ", "(" + "a".repeat(length) + ") ", count, "] TJ ET\n");
/** An uncompressed Catalog whose /Junk holds `groups` arrays of `perGroup` empty dictionaries (parsed through the xref path). */
export const catalogDictBombPdf = (perGroup = 200000, groups = 5) => {
  const pdf = Buffer.from(buildPdf(["<< /Type /Catalog /Pages 2 0 R /Junk [JUNK] >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("BT /F1 12 Tf 50 700 Td (Hello) Tj ET"), HELVETICA])).toString("latin1");
  // Offsets after the catalog shift by the junk: rebuild the xref instead of patching it.
  const junk = Array(groups).fill("[" + "<<>>".repeat(perGroup) + "]").join(" ");
  const text = pdf.replace("[JUNK]", `[${junk}]`);
  const body = text.slice(0, text.indexOf("xref\n"));
  const offsets = [...body.matchAll(/(\d+) 0 obj\n/g)].map(m => m.index);
  return new Uint8Array(Buffer.from(body + `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`, "latin1"));
};
/** One page in `count` distinct non-embedded STSong-Light fonts with the predefined `encoding`:
 * pdf.js parses the bundled encoding and Adobe-GB1-UCS2 CMaps once per font. */
export function predefinedCjkFontsPdf(count, encoding = "UniGB-UCS2-H") {
  const fonts = Array.from({ length: count }, (_, i) => `/F${i + 1} ${5 + i * 2} 0 R`).join(" ");
  const hex = text => "<" + [...text].map(c => hex4(c.charCodeAt(0))).join("") + ">";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fonts} >> >> /Contents 4 0 R >>`,
    stream(Array.from({ length: count }, (_, i) => `BT /F${i + 1} 11 Tf 50 ${740 - i * 14} Td ${hex(`中文${i + 1}`)} Tj ET`).join("\n"))];
  for (let i = 0; i < count; i++) objects.push(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /${encoding} /DescendantFonts [${6 + i * 2} 0 R] >>`,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>");
  return buildPdf(objects);
}
/** A baseline JPEG header claiming `width` x `height` (three components, no scan data worth decoding). */
export function jpegHeader(width, height) {
  const segment = (marker, body) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const dqt = segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
  const sof = segment(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]));
  // One DC and one AC Huffman table with a single 1-bit code each.
  const dht = segment(0xc4, Buffer.concat([Buffer.from([0x00, 1]), Buffer.alloc(15), Buffer.from([0]), Buffer.from([0x10, 1]), Buffer.alloc(15), Buffer.from([0])]));
  const sos = segment(0xda, Buffer.from([3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, sof, dht, sos, Buffer.alloc(256, 0), Buffer.from([0xff, 0xd9])]);
}
/** A ToUnicode CMap (`target: "tounicode"`) or FontFile2 (`"fontfile"`) stream with an image filter (default
 * /DCTDecode) whose data is a JPEG header claiming `width` x `height`: pdf.js decodes it as an image on the text path. */
export const imageFilterBombPdf = ({ width = 30000, height = 30000, filter = "DCTDecode", target = "tounicode" } = {}) => {
  const data = jpegHeader(width, height).toString("latin1");
  const imageStream = `<< /Length ${data.length} /Filter /${filter} /Width ${width} /Height ${height} >>\nstream\n${data}\nendstream`;
  return buildPdf([...catalog, ...(target === "tounicode" ? identityFont("8 0 R") : identityFont("", "8 0 R")), imageStream]);
};

// Operands held at once and CPU without text (independent review of 26ee7e4e).
const DICTS_70K = "[" + "<<>>".repeat(70000) + "]";
/** H2: `operands` arrays of `perArray` `<<>>` each before one TJ: pdf.js holds every one until the operator. */
export const heldOperandsBombPdf = (perArray = 70000, operands = 26) =>
  repeatedUnitPage("BT /F1 12 Tf ", "[" + "<<>>".repeat(perArray) + "] ", operands, " TJ ET\n");
/** I2 / I3: `[<<>>×perArray] n` × `lines`, then text. `n` takes no operand, so each array is
 * shifted into EvaluatorPreprocessor.nonProcessedArgs. */
export const extraOperandsBombPdf = (perArray = 70000, lines = 10) =>
  repeatedUnitPage("", "[" + "<<>>".repeat(perArray) + "] n\n", lines, "BT /F1 12 Tf 50 700 Td (after the operands) Tj ET\n");
/** K: one page that draws `forms` Flate form XObjects, each `unit` repeated to about `decodedBytes`. */
export function formXObjectsBombPdf({ forms = 6, unit = DICTS_70K + " n\n", decodedBytes = Math.round(7.8 * 1024 * 1024) } = {}) {
  const names = Array.from({ length: forms }, (_, i) => `/X${i + 1} ${6 + i} 0 R`).join(" ");
  const count = Math.max(1, Math.floor(decodedBytes / unit.length));
  const objects = [...catalog, HELVETICA, ...onePage("5 0 R", `/Font << /F1 3 0 R >> /XObject << ${names} >>`),
    stream("BT /F1 12 Tf 50 700 Td (before the forms) Tj ET\n" + Array.from({ length: forms }, (_, i) => `q /X${i + 1} Do Q`).join("\n"))];
  for (let i = 0; i < forms; i++) {
    const data = deflateSync(Buffer.alloc(unit.length * count, unit, "latin1"), { level: 9 }).toString("latin1");
    objects.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data}\nendstream`);
  }
  return buildPdf(objects);
}
/** A Type3 font whose one CharProc is `d0` then `unit` × `count` (Flate): pdf.js builds and keeps
 * the CharProc's operator list (operands included) when it loads the font for text. */
export function type3CharProcBombPdf({ unit = DICTS_70K + " 0 d\n", count = 26 } = {}) {
  const data = deflateSync(Buffer.concat([Buffer.from("1000 0 d0\n", "latin1"), Buffer.alloc(unit.length * count, unit, "latin1")]), { level: 9 }).toString("latin1");
  return buildPdf([...catalog,
    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> " +
      "/Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1000] >>",
    ...onePage("5 0 R"), stream("BT /F1 12 Tf 50 700 Td (aaa) Tj ET"),
    `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data}\nendstream`]);
}
/** Page 1 shows `text`; page 2 only draws: a Flate stream of `q Q` operators decoding to `decodedBytes`. */
export const textThenDrawingPdf = (text, decodedBytes) => buildPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>", HELVETICA,
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
  stream(`BT /F1 11 Tf 50 740 Td ${literal(text)} Tj ET`),
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>",
  repeatedFlate("", "q Q\n", decodedBytes)]);
/** A realistic multi-page text document: `pageCount` Flate pages of kerned TJ lines (typeset
 * output: a kern every three characters), a bold heading, a rule and a page number. */
export function realisticTextPdf(pageCount = 20, linesPerPage = 55) {
  const words = "the quick brown fox jumps over lazy dogs while storage extraction reads every kerned line of this realistic report".split(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${5 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    HELVETICA, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"];
  for (let p = 0; p < pageCount; p++) {
    const lines = [`BT /F2 14 Tf 50 760 Td (Section ${p + 1}: Findings) Tj ET`, "BT /F1 10 Tf 50 740 Td 12 TL"];
    for (let l = 0; l < linesPerPage; l++) {
      const text = Array.from({ length: 14 }, (_, w) => words[(p * 7 + l * 3 + w) % words.length]).join(" ");
      lines.push(`[${text.match(/.{1,3}/g).map((s, i) => `${literal(s)} ${i % 2 ? -18 : 12}`).join(" ")}] TJ T*`);
    }
    lines.push("ET", "0.5 w 50 40 m 562 40 l S", `BT /F1 8 Tf 300 25 Td (${p + 1}) Tj ET`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + p * 2} 0 R >>`);
    objects.push(flateStream(lines.join("\n")));
  }
  return buildPdf(objects);
}

// Embedded font programs (FontFile / FontFile2 / FontFile3). The text path
// never parses them (build/pdfjs-decode-guard.mjs), so text comes from the
// font dictionary only: Encoding / Differences, ToUnicode, predefined CMaps.
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
/** An sfnt (TrueType) file of `tables` ({ tag: Buffer }). */
function sfnt(tables) {
  const tags = Object.keys(tables).sort(), header = 12 + 16 * tags.length;
  let offset = header;
  const dir = [], bodies = [];
  for (const tag of tags) {
    const data = tables[tag], padded = Buffer.concat([data, Buffer.alloc((4 - data.length % 4) % 4)]);
    dir.push(Buffer.from(tag.padEnd(4), "latin1"), u32(0), u32(offset), u32(data.length)); bodies.push(padded); offset += padded.length;
  }
  return Buffer.concat([u32(0x00010000), u16(tags.length), u16(0), u16(0), u16(0), ...dir, ...bodies]);
}
/** A TrueType program of `glyphs` simple glyphs of `points` on-curve points each, every glyph
 * with its own hmtx entry (numberOfHMetrics = glyphs), a (1,0) cmap for codes 0..255 and a (3,1)
 * cmap for U+0020..U+007E. With the defaults (65 535 glyphs, the most an sfnt can declare, and
 * as many hmtx entries) the program is about 6.3 MB, inside the per-stream decode limit, and
 * compresses to some 20 KB. */
export function trueTypeProgram({ glyphs = 65535, points = 26 } = {}) {
  const glyph = Buffer.concat([u16(1), u16(0), u16(0), u16(1000), u16(1000), u16(points - 1), u16(0),
    Buffer.alloc(points, 0x01 | 0x02 | 0x04 | 0x10 | 0x20), Buffer.alloc(points * 2, 10)]);
  const glyphData = Buffer.concat([glyph, Buffer.alloc(glyph.length % 2)]);
  const loca = Buffer.alloc((glyphs + 1) * 4);
  for (let i = 0; i <= glyphs; i++) loca.writeUInt32BE(i * glyphData.length, i * 4);
  const glyf = Buffer.alloc(glyphData.length * glyphs, glyphData);
  const hmtx = Buffer.alloc(glyphs * 4); for (let i = 0; i < glyphs; i++) hmtx.writeUInt16BE(600, i * 4);
  const head = Buffer.concat([u32(0x00010000), u32(0x00010000), u32(0), u32(0x5f0f3cf5), u16(0), u16(1000), Buffer.alloc(16), u16(0), u16(0), u16(1000), u16(1000),
    u16(0), u16(8), u16(2), u16(1), u16(0)]);
  const hhea = Buffer.concat([u32(0x00010000), u16(900), u16(0x10000 - 200), u16(0), u16(1000), u16(0), u16(0), u16(1000), u16(1), u16(0), u16(0), Buffer.alloc(8), u16(0), u16(glyphs)]);
  const maxp = Buffer.concat([u32(0x00010000), u16(glyphs), u16(points), u16(1), u16(0), u16(0), u16(2), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0)]);
  const fmt0 = Buffer.concat([u16(0), u16(262), u16(0), Buffer.from(Array.from({ length: 256 }, (_, c) => Math.min(c + 1, glyphs - 1, 255)))]);
  const fmt4 = Buffer.concat([u16(4), u16(32), u16(0), u16(4), u16(4), u16(1), u16(0), u16(0x7e), u16(0xffff), u16(0), u16(0x20), u16(0xffff),
    u16(0x10000 - 31), u16(1), u16(0), u16(0)]);
  const cmap = Buffer.concat([u16(0), u16(2), u16(1), u16(0), u32(20), u16(3), u16(1), u32(20 + fmt0.length), fmt0, fmt4]);
  const post = Buffer.concat([u32(0x00030000), Buffer.alloc(28)]);
  return sfnt({ head, hhea, maxp, hmtx, loca, glyf, cmap, post });
}
/** CFF DICT integer operand (always 5 bytes). */
const cffInt = n => Buffer.from([29, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
function cffIndex(items) {
  if (items.length === 0) return u16(0);
  const offsets = Buffer.alloc((items.length + 1) * 4);
  let at = 1; items.forEach((item, i) => { offsets.writeUInt32BE(at, i * 4); at += item.length; }); offsets.writeUInt32BE(at, items.length * 4);
  return Buffer.concat([u16(items.length), Buffer.from([4]), offsets, ...items]);
}
/** A bare CFF (Type1C) program of `glyphs` charstrings, each a width, a moveto and `lines`
 * rlineto segments, with a range charset. With the defaults (65 535 glyphs, the most a CFF
 * INDEX can hold) the program is about 6.4 MB, inside the per-stream decode limit, and
 * compresses to some 20 KB. */
export function cffProgram({ glyphs = 65535, lines = 30 } = {}) {
  const charstring = Buffer.concat([Buffer.from([139 + 100, 139, 139, 21]), Buffer.alloc(lines * 3, Buffer.from([149, 149, 5])), Buffer.from([14])]);
  const charStrings = cffIndex([Buffer.from([139, 14]), ...Array(glyphs - 1).fill(charstring)]);
  const charset = Buffer.concat([Buffer.from([2]), u16(391), u16(glyphs - 2)]);
  const privateDict = Buffer.concat([cffInt(0), Buffer.from([20])]);
  const name = cffIndex([Buffer.from("CluedHostile", "latin1")]), strings = cffIndex([]), gsubrs = cffIndex([]);
  const top = o => Buffer.concat([cffInt(o.charset), Buffer.from([15]), cffInt(o.charStrings), Buffer.from([17]), cffInt(privateDict.length), cffInt(o.priv), Buffer.from([18])]);
  const fixed = 4 + name.length + cffIndex([top({ charset: 0, charStrings: 0, priv: 0 })]).length + strings.length + gsubrs.length;
  const offsets = { charset: fixed, charStrings: fixed + charset.length, priv: fixed + charset.length + charStrings.length };
  return Buffer.concat([Buffer.from([1, 0, 4, 4]), name, cffIndex([top(offsets)]), strings, gsubrs, charset, charStrings, privateDict]);
}
/** One page in an embedded font. `font`: "TrueType" (FontFile2), "Type1C" (FontFile3 /Type1C), "Type1"
 * (FontFile: a clear-text Type 1 header whose built-in encoding maps the codes), or "CIDFontType2" /
 * "CIDFontType0C" (Type0, Identity-H). `codes`: "ascii" (code = character) or "subset" (codes 1..n in order
 * of first use, as subsetting producers write). `encoding`: an /Encoding value, "differences" (/Differences
 * naming each glyph), or null. `program` replaces the default small program; it is stored Flate-compressed. */
export function embeddedFontPdf(lines, { font = "TrueType", codes = "subset", toUnicode = true, encoding = null, program } = {}) {
  const chars = [...new Set(lines.join(""))];
  const composite = font.startsWith("CID");
  const codeOf = c => codes === "ascii" ? c.charCodeAt(0) : chars.indexOf(c) + 1;
  const glyphName = c => /[A-Za-z]/.test(c) ? c : `uni${hex4(c.charCodeAt(0)).toUpperCase()}`;
  const hexCode = c => composite ? hex4(codeOf(c)) : codeOf(c).toString(16).padStart(2, "0");
  const cmap = ["/CIDInit /ProcSet findresource begin 12 dict begin begincmap", "/CMapName /Clued-UCS def /CMapType 2 def",
    `1 begincodespacerange ${composite ? "<0000> <FFFF>" : "<00> <FF>"} endcodespacerange`, `${chars.length} beginbfchar`,
    ...chars.map(c => `<${hexCode(c)}> <${hex4(c.charCodeAt(0))}>`), "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"].join("\n");
  const truetype = font === "TrueType" || font === "CIDFontType2";
  const bytes = program ?? (font === "Type1" ? Buffer.from("%!PS-AdobeFont-1.0: Clued\n11 dict begin\n/FontName /Clued def\n/Encoding 256 array\n" +
    "0 1 255 {1 index exch /.notdef put} for\n" + chars.map(c => `dup ${codeOf(c)} /${glyphName(c)} put\n`).join("") + "readonly def\ncurrentdict end\ncurrentfile eexec\n", "latin1")
    : truetype ? trueTypeProgram({ glyphs: 128, points: 8 }) : cffProgram({ glyphs: 128, lines: 4 }));
  const fileKey = font === "Type1" ? "FontFile" : truetype ? "FontFile2" : "FontFile3";
  const fileDict = font === "Type1C" ? "/Subtype /Type1C " : font === "CIDFontType0C" ? "/Subtype /CIDFontType0C " : font === "Type1" ? `/Length1 ${bytes.length} /Length2 0 /Length3 0 ` : `/Length1 ${bytes.length} `;
  const data = deflateSync(bytes, { level: 9 }).toString("latin1");
  const tu = toUnicode ? " /ToUnicode 8 0 R" : "";
  const enc = encoding === "differences" ? ` /Encoding << /Type /Encoding /Differences [${chars.map(c => `${codeOf(c)} /${glyphName(c)}`).join(" ")}] >>` : encoding ? ` /Encoding ${encoding}` : "";
  const first = Math.min(...chars.map(codeOf)), last = Math.max(...chars.map(codeOf));
  const fontDict = composite
    ? `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Clued /Encoding /Identity-H /DescendantFonts [5 0 R]${tu} >>`
    : `<< /Type /Font /Subtype /${font === "TrueType" ? "TrueType" : "Type1"} /BaseFont /AAAAAA+Clued /FirstChar ${first} /LastChar ${last} /Widths [${Array(last - first + 1).fill(600).join(" ")}] /FontDescriptor 6 0 R${enc}${tu} >>`;
  const descendant = composite ? `<< /Type /Font /Subtype /${font === "CIDFontType2" ? "CIDFontType2" : "CIDFontType0"} /BaseFont /AAAAAA+Clued /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 600${font === "CIDFontType2" ? " /CIDToGIDMap /Identity" : ""} >>` : "<< >>";
  // Objects: 1 catalog, 2 pages, 3 font, 4 page, 5 descendant, 6 descriptor, 7 program, 8 ToUnicode, 9 content.
  return buildPdf([...catalog, fontDict, ...onePage("9 0 R"), descendant,
    `<< /Type /FontDescriptor /FontName /AAAAAA+Clued /Flags ${encoding ? 32 : 4} /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /${fileKey} 7 0 R >>`,
    `<< /Length ${data.length} /Filter /FlateDecode ${fileDict}>>\nstream\n${data}\nendstream`, stream(cmap),
    stream(lines.map((line, i) => `BT /F1 12 Tf 50 ${740 - i * 16} Td <${[...line].map(hexCode).join("")}> Tj ET`).join("\n"))]);
}
/** One page of `count` lines `(a)'` (next line, show "a") in a 0.002 pt font, in columns of
 * 300 000 lines so every line stays on the page (pdf.js drops text outside it): pdf.js returns
 * one text item per line, from 2 content tokens and 5 decoded bytes each. */
export function textItemsBombPdf(count = 1_100_000, perColumn = 300_000) {
  const columns = Array.from({ length: Math.ceil(count / perColumn) }, (_, i) => Math.min(perColumn, count - i * perColumn));
  const content = Buffer.concat(columns.flatMap((lines, i) => [Buffer.from(`BT /F1 0.002 Tf 0.002 TL ${50 + i * 20} 700 Td\n`, "latin1"),
    Buffer.alloc(lines * 5, "(a)'\n", "latin1"), Buffer.from("ET\n", "latin1")]));
  const data = deflateSync(content, { level: 9 }).toString("latin1");
  return buildPdf([...catalog, HELVETICA, ...onePage("5 0 R"), `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data}\nendstream`]);
}

/** Glyph-table bombs (review of 06d2251a): one page showing <00410042> ("AB" as Identity codes, no ToUnicode) in each of
 * `count` Identity-H (`vertical`: Identity-V) CIDFontType2 fonts whose CIDFont dictionary adds `entries(i, ref)`;
 * `extra(i)` is one more object per font, at `ref`. pdf.js fills its width, vertical-metric, CIDToGIDMap and Unicode
 * tables one entry per code from a few numbers of these dictionaries. */
export function cidFontsPdf(count, { entries = () => "", extra = () => stream(""), vertical = false, ordering = "Identity", baseFont = "CIDFont", type0Entries = "" } = {}) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${Array.from({ length: count }, (_, i) => `/F${i} ${5 + i * 4} 0 R`).join(" ")} >> >> /Contents 4 0 R >>`,
    stream(Array.from({ length: count }, (_, i) => `BT /F${i} 11 Tf 50 ${740 - i * 2} Td <00410042> Tj ET`).join("\n"))];
  for (let i = 0; i < count; i++) {
    const ref = 5 + i * 4;
    objects.push(`<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont}${i} /Encoding /Identity-${vertical ? "V" : "H"} /DescendantFonts [${ref + 1} 0 R] ${type0Entries}>>`,
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont}${i} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 0 >> /FontDescriptor ${ref + 2} 0 R ${entries(i, ref + 3)} >>`,
      `<< /Type /FontDescriptor /FontName /${baseFont}${i} /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>`, extra(i));
  }
  return buildPdf(objects);
}
/** A FlateDecode CIDToGIDMap stream of `bytes` bytes (GID 1 for every CID). */
export const cidToGidMapStream = bytes => {
  const data = deflateSync(Buffer.alloc(bytes, Buffer.from([0, 1])), { level: 9 }).toString("latin1");
  return `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data}\nendstream`;
};
