/** Hand-written PDF fixtures for StorageNormalUse.v0.1 §4.5 (clued_storage_read
 * PDF text). Built in-test, nothing read from disk, no PDF library: each
 * fixture isolates one pdf.js path (standard font, predefined CJK CMap,
 * ToUnicode, no Unicode map, no text layer, encryption). */

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
