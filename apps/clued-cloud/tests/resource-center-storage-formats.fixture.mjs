/** Small in-test fixtures for StorageNormalUse.v0.1 N1b reads: image headers
 * (png / jpeg / gif / webp) and minimal docx / xlsx / pptx archives. Nothing
 * is read from disk. */
import { buildZip } from "./resource-center-zip.fixture.mjs";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const DECL = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const rels = items => `${DECL}<Relationships xmlns="${PKG}">${items.map(([id, type, target]) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** paragraphs: string[]; extra: more zip entries (e.g. a large stored padding part). */
export const docxOf = (paragraphs, { extra = [], documentXml } = {}) => buildZip([
  { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
  { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "word/document.xml"]]) },
  { name: "word/document.xml", data: documentXml ?? `${DECL}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${paragraphs.map(p =>
    `<w:p><w:r><w:t xml:space="preserve">${escape(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>` },
  ...extra,
]);

/** sheets: [{ name, rows: string[][] }] with inline strings. */
export const xlsxOf = sheets => buildZip([
  { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "xl/workbook.xml"]]) },
  { name: "xl/workbook.xml", data: `${DECL}<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets.map((s, i) =>
    `<sheet name="${escape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
  { name: "xl/_rels/workbook.xml.rels", data: rels(sheets.map((_, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`])) },
  ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `${DECL}<worksheet xmlns="${S}"><sheetData>${s.rows.map((row, r) =>
    `<row r="${r + 1}">${row.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${escape(v)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>` })),
]);

/** slides: string[][] (paragraphs per slide), in presentation order. */
export const pptxOf = slides => buildZip([
  { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "ppt/presentation.xml"]]) },
  { name: "ppt/presentation.xml", data: `${DECL}<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${slides.map((_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>` },
  { name: "ppt/_rels/presentation.xml.rels", data: rels(slides.map((_, i) => [`rId${i + 1}`, "slide", `slides/slide${i + 1}.xml`])) },
  ...slides.map((paragraphs, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: `${DECL}<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs.map(p =>
    `<a:p><a:r><a:t>${escape(p)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>` })),
]);

const u16be = v => [(v >> 8) & 0xff, v & 0xff], u16le = v => [v & 0xff, (v >> 8) & 0xff];
const u32be = v => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u24le = v => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const ascii = text => [...text].map(c => c.charCodeAt(0));
const pad = (bytes, size) => { const out = new Uint8Array(Math.max(size, bytes.length)); out.set(bytes); return out; };

/** Header-valid images (not decodable pictures): enough for magic and pixel size. `size` pads the body. */
export const pngOf = (width, height, size = 64) =>
  pad(new Uint8Array([0x89, ...ascii("PNG\r\n\x1a\n"), ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0]), size);
export const gifOf = (width, height, size = 64) => pad(new Uint8Array([...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0]), size);
export const jpegOf = (width, height, size = 64) => pad(new Uint8Array([0xff, 0xd8,
  0xff, 0xe0, ...u16be(16), ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), size);
export const webpOf = (width, height, variant = "VP8X", size = 64) => {
  const head = [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")];
  if (variant === "VP8X") return pad(new Uint8Array([...head, ...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]), size);
  if (variant === "VP8L") {
    const w = width - 1, h = height - 1;
    return pad(new Uint8Array([...head, ...ascii("VP8L"), 0, 0, 0, 0, 0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x3) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f]), size);
  }
  return pad(new Uint8Array([...head, ...ascii("VP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]), size);
};
