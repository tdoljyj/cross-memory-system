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
 * it pdf.js can only emit the codes themselves. `codes` overrides the glyph codes. */
export function identityPdf(pages, { toUnicode = true, codes } = {}) {
  const map = new Map();
  const codeOf = c => { if (!map.has(c)) map.set(c, codes?.[map.size] ?? map.size + 1); return map.get(c); };
  const shows = pages.map(lines => lines.map(text => "<" + [...text].map(c => hex4(codeOf(c))).join("") + ">"));
  const cmap = ["/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange", `${map.size} beginbfchar`,
    ...[...map].map(([c, code]) => `<${hex4(code)}> <${hex4(c.charCodeAt(0))}>`), "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"].join("\n");
  return pagesPdf(shows,
    `<< /Type /Font /Subtype /Type0 /BaseFont /Embedded /Encoding /Identity-H /DescendantFonts [4 0 R]${toUnicode ? " /ToUnicode 6 0 R" : ""} >>`,
    ["<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Embedded /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 /CIDToGIDMap /Identity >>",
      "<< /Type /FontDescriptor /FontName /Embedded /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
      stream(cmap)]);
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
