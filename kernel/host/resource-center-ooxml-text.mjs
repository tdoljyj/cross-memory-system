/** Plain-text extraction from docx / xlsx / pptx (StorageNormalUse.v0.1 §4.1, §4.3).
 *
 * Built on the bounded zip reader and the DOCTYPE-rejecting SAX tokenizer. Output is capped at
 * `maxTextBytes` of UTF-8 across all segments (default 256 KiB, the contract's per-segment cap
 * applied to the whole call; a range reader may extract up to 8 MiB and slice); once the cap is reached parsing stops, remaining parts are not decompressed, and
 * `truncated: true` is returned. Each XML part is read with a 16 MiB decompressed cap.
 *
 * - docx: main document part (via `_rels/.rels`, default `word/document.xml`); one segment.
 *   Paragraphs end in `\n`; `w:tab` → `\t`; `w:br` / `w:cr` → `\n`. Deleted text and field
 *   instructions are not text runs and are skipped.
 * - xlsx: one CSV segment per sheet, in workbook order. Values are placed by their cell
 *   reference (gaps become empty cells / rows); shared strings, inline strings, booleans
 *   (TRUE / FALSE) and raw `<v>` values (numbers, dates as serials, errors) are emitted as-is.
 * - pptx: one segment per slide in `p:sldIdLst` order; paragraphs end in `\n`, `a:br` → `\n`.
 *
 * All output is untrusted content. Relationship targets are resolved as zip-internal strings
 * only; external targets and targets escaping the archive root are ignored. */

import { openZip } from "./resource-center-zip-reader.mjs";
import { localName, parseXml, XML_LIMITS } from "./resource-center-xml-sax.mjs";

export const OOXML_TEXT_LIMITS = Object.freeze({
  maxTextBytes: 256 * 1024,
  // Ceiling for an explicit `maxTextBytes`: a caller serving a byte range at an offset extracts
  // up to offset + length and slices; it still returns at most 256 KiB per call.
  maxExtractBytes: 8 * 1024 * 1024,
  maxPartBytes: XML_LIMITS.maxPartBytes,
  maxColumns: 16_384,
  maxRows: 1_048_576,
  // Cells held at once while streaming a sheet: the current row plus out-of-order rows.
  maxBufferedCells: 65_536,
});

const REL_OFFICE_DOCUMENT = /\/officeDocument$/;
const REL_WORKSHEET = /\/worksheet$/;
const REL_SHARED_STRINGS = /\/sharedStrings$/;
const REL_SLIDE = /\/slide$/;
const DEFAULT_MAIN = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" };
const encoder = new TextEncoder();

export class OoxmlTextError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OoxmlTextError";
    this.code = code;
  }
}

/** Shared output budget across segments. */
class TextBudget {
  constructor(maxBytes) { this.left = maxBytes; this.truncated = false; }
  get exhausted() { return this.truncated || this.left <= 0; }
  /** Append `text` to `parts`; returns false once the cap is reached. */
  push(parts, text) {
    if (this.truncated) return false;
    if (!text) return true;
    const bytes = encoder.encode(text);
    if (bytes.byteLength <= this.left) { parts.push(text); this.left -= bytes.byteLength; return true; }
    // Cut at a UTF-8 character boundary.
    let end = this.left;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end > 0) parts.push(new TextDecoder().decode(bytes.subarray(0, end)));
    this.left -= end;
    this.truncated = true;
    return false;
  }
}

export function resolvePartTarget(sourcePart, target) {
  if (typeof target !== "string" || target === "" || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  const clean = target.replace(/\\/g, "/").split("#")[0];
  const base = clean.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
  for (const encoded of clean.split("/")) {
    // Targets are URIs: percent-decode each segment; a decoded separator, NUL or a bad escape is ignored.
    let segment;
    try { segment = decodeURIComponent(encoded); } catch { return null; }
    if (/[\/\\\u0000]/.test(segment)) return null;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { if (base.length === 0) return null; base.pop(); } else base.push(segment);
  }
  return base.length ? base.join("/") : null;
}

const relsPathFor = (part) => {
  const at = part.lastIndexOf("/");
  return `${part.slice(0, at + 1)}_rels/${part.slice(at + 1)}.rels`;
};

function hasEntry(zip, name) { return zip.entries.some((entry) => entry.name === name && !entry.directory); }

async function readPart(zip, name, maxPartBytes) {
  return zip.readEntry(name, { maxBytes: maxPartBytes });
}

async function readRelationships(zip, part, maxPartBytes) {
  const path = relsPathFor(part);
  if (!hasEntry(zip, path)) return new Map();
  const rels = new Map();
  parseXml(await readPart(zip, path, maxPartBytes), {
    onOpen(name, attrs) {
      if (localName(name) !== "Relationship" || attrs.TargetMode === "External") return;
      const target = resolvePartTarget(part, attrs.Target);
      if (attrs.Id && target) rels.set(attrs.Id, { type: attrs.Type ?? "", target });
    },
  });
  return rels;
}

async function readPackageRels(zip, maxPartBytes) {
  const path = "_rels/.rels";
  if (!hasEntry(zip, path)) return [];
  const out = [];
  parseXml(await readPart(zip, path, maxPartBytes), {
    onOpen(name, attrs) {
      if (localName(name) !== "Relationship" || attrs.TargetMode === "External") return;
      const target = resolvePartTarget("", attrs.Target);
      if (target) out.push({ type: attrs.Type ?? "", target });
    },
  });
  return out;
}

async function findMain(zip, kind, maxPartBytes) {
  for (const rel of await readPackageRels(zip, maxPartBytes)) {
    if (REL_OFFICE_DOCUMENT.test(rel.type) && hasEntry(zip, rel.target)) return rel.target;
  }
  if (hasEntry(zip, DEFAULT_MAIN[kind])) return DEFAULT_MAIN[kind];
  throw new OoxmlTextError("document_invalid", `${kind} main part not found`);
}

// ---------- docx ----------

function paragraphText(xml, budget, { paragraph, text, breaks, tabs }) {
  const parts = [];
  let inText = 0;
  parseXml(xml, {
    onOpen(name, _attrs, selfClosing) {
      const local = localName(name);
      if (local === text && !selfClosing) inText += 1;
      else if (breaks.has(local)) return budget.push(parts, "\n");
      else if (tabs.has(local)) return budget.push(parts, "\t");
      return true;
    },
    onClose(name) {
      const local = localName(name);
      if (local === text) inText = Math.max(0, inText - 1);
      else if (local === paragraph) return budget.push(parts, "\n");
      return true;
    },
    onText(value) { return inText ? budget.push(parts, value) : true; },
  });
  return parts.join("");
}

async function extractDocx(zip, budget, limits) {
  const main = await findMain(zip, "docx", limits.maxPartBytes);
  const text = paragraphText(await readPart(zip, main, limits.maxPartBytes), budget, {
    paragraph: "p", text: "t", breaks: new Set(["br", "cr"]), tabs: new Set(["tab"]),
  });
  return [{ name: "document", part: main, text }];
}

// ---------- pptx ----------

async function extractPptx(zip, budget, limits) {
  const main = await findMain(zip, "pptx", limits.maxPartBytes);
  const rels = await readRelationships(zip, main, limits.maxPartBytes);
  const order = [];
  parseXml(await readPart(zip, main, limits.maxPartBytes), {
    onOpen(name, attrs) {
      if (localName(name) !== "sldId") return;
      const id = attrs["r:id"] ?? Object.entries(attrs).find(([key]) => localName(key) === "id" && key.includes(":"))?.[1];
      const rel = id && rels.get(id);
      if (rel && REL_SLIDE.test(rel.type)) order.push(rel.target);
    },
  });
  const segments = [];
  for (const [n, part] of order.entries()) {
    if (budget.exhausted) { budget.truncated = true; break; }
    if (!hasEntry(zip, part)) continue;
    const text = paragraphText(await readPart(zip, part, limits.maxPartBytes), budget, {
      paragraph: "p", text: "t", breaks: new Set(["br"]), tabs: new Set(),
    });
    segments.push({ name: `Slide ${n + 1}`, part, text });
  }
  return segments;
}

// ---------- xlsx ----------

export function parseCellRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(ref ?? "");
  if (!m) return null;
  let col = 0;
  for (const c of m[1].toUpperCase()) col = col * 26 + (c.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (col < 1 || row < 1) return null;
  return { col, row };
}

export function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function readSharedStrings(xml) {
  const strings = [];
  let current = null, inT = 0, inPhonetic = 0;
  parseXml(xml, {
    onOpen(name, _attrs, selfClosing) {
      const local = localName(name);
      if (local === "si" && !selfClosing) current = [];
      else if (local === "si") strings.push("");
      else if (local === "rPh" && !selfClosing) inPhonetic += 1;
      else if (local === "t" && !selfClosing) inT += 1;
    },
    onClose(name) {
      const local = localName(name);
      if (local === "si" && current) { strings.push(current.join("")); current = null; }
      else if (local === "rPh") inPhonetic = Math.max(0, inPhonetic - 1);
      else if (local === "t") inT = Math.max(0, inT - 1);
    },
    onText(value) { if (current && inT && !inPhonetic) current.push(value); },
  });
  return strings;
}

/** One sheet as CSV, streamed: a row is emitted as soon as a cell of a higher row arrives, so
 * memory holds only the current row plus rows that arrive out of order (at most
 * `maxBufferedCells` cells). Parsing stops as soon as the output budget is spent. A cell for a
 * row that was already emitted (rows out of order across an emitted row) is `document_invalid`;
 * the spec requires ascending rows, and silently dropping or reordering it would change the
 * text. Gaps between rows become empty lines. */
function sheetCsv(xml, sharedStrings, budget, limits) {
  const parts = [];
  const buffer = new Map();
  let buffered = 0, emitted = 0, high = 0;
  let rowIndex = 0, colIndex = 0, cell = null, inValue = 0, inInline = 0, inInlineT = 0, inPhonetic = 0;
  // Emit every buffered row below `limit` in order; false once the budget is spent.
  const flushBelow = (limit) => {
    const order = [...buffer.keys()].filter((r) => r < limit).sort((a, b) => a - b);
    for (const r of order) {
      const row = buffer.get(r);
      buffer.delete(r);
      buffered -= row.size;
      const gap = r - emitted - 1;
      emitted = r;
      if (gap > 0 && !budget.push(parts, "\n".repeat(Math.min(gap, budget.left + 1)))) return false;
      let maxCol = 0;
      for (const c of row.keys()) if (c > maxCol) maxCol = c;
      const fields = [];
      for (let c = 1; c <= maxCol; c += 1) fields.push(csvField(row.get(c) ?? ""));
      if (!budget.push(parts, `${fields.join(",")}\n`)) return false;
    }
    return true;
  };
  parseXml(xml, {
    onOpen(name, attrs, selfClosing) {
      switch (localName(name)) {
        case "row": {
          const r = Number(attrs.r);
          rowIndex = Number.isSafeInteger(r) && r >= 1 ? r : rowIndex + 1;
          if (rowIndex > limits.maxRows) throw new OoxmlTextError("document_invalid", "row beyond sheet limits");
          colIndex = 0;
          break;
        }
        case "c": {
          const ref = parseCellRef(attrs.r);
          if (ref) { rowIndex = ref.row; colIndex = ref.col; } else colIndex += 1;
          if (rowIndex === 0) rowIndex = 1;
          if (colIndex > limits.maxColumns || rowIndex > limits.maxRows) throw new OoxmlTextError("document_invalid", "cell beyond sheet limits");
          cell = { type: attrs.t ?? "n", value: [], inline: [] };
          if (selfClosing) cell = null;
          break;
        }
        case "v": if (cell && !selfClosing) inValue += 1; break;
        case "is": if (cell && !selfClosing) inInline += 1; break;
        case "rPh": if (!selfClosing) inPhonetic += 1; break;
        case "t": if (inInline && !selfClosing) inInlineT += 1; break;
        default: break;
      }
      return true;
    },
    onClose(name) {
      switch (localName(name)) {
        case "v": inValue = Math.max(0, inValue - 1); break;
        case "is": inInline = Math.max(0, inInline - 1); break;
        case "rPh": inPhonetic = Math.max(0, inPhonetic - 1); break;
        case "t": inInlineT = Math.max(0, inInlineT - 1); break;
        case "c": {
          if (!cell) break;
          const raw = cell.value.join("");
          let value;
          if (cell.type === "s") value = sharedStrings[Number(raw)] ?? "";
          else if (cell.type === "inlineStr") value = cell.inline.join("");
          else if (cell.type === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
          else value = raw;
          cell = null;
          if (value === "") break;
          if (rowIndex <= emitted) throw new OoxmlTextError("document_invalid", "rows out of order");
          if (rowIndex > high) {
            if (!flushBelow(rowIndex)) return false;
            high = rowIndex;
          }
          let row = buffer.get(rowIndex);
          if (!row) buffer.set(rowIndex, (row = new Map()));
          if (!row.has(colIndex)) {
            if (++buffered > limits.maxBufferedCells) throw new OoxmlTextError("archive_limit_exceeded", "too many buffered cells");
          }
          row.set(colIndex, value);
          break;
        }
        default: break;
      }
      return true;
    },
    onText(value) {
      if (!cell) return true;
      if (inValue) cell.value.push(value);
      else if (inInlineT && !inPhonetic) cell.inline.push(value);
      return true;
    },
  });
  if (!budget.truncated) flushBelow(Infinity);
  return parts.join("");
}

async function extractXlsx(zip, budget, limits, { segment } = {}) {
  const main = await findMain(zip, "xlsx", limits.maxPartBytes);
  const rels = await readRelationships(zip, main, limits.maxPartBytes);
  const sheets = [];
  parseXml(await readPart(zip, main, limits.maxPartBytes), {
    onOpen(name, attrs) {
      if (localName(name) !== "sheet") return;
      const id = attrs["r:id"] ?? Object.entries(attrs).find(([key]) => localName(key) === "id" && key.includes(":"))?.[1];
      const rel = id && rels.get(id);
      if (rel && REL_WORKSHEET.test(rel.type)) sheets.push({ name: String(attrs.name ?? `Sheet${sheets.length + 1}`), part: rel.target });
    },
  });
  const selected = segment === undefined ? sheets : sheets.filter((sheet) => sheet.name === segment);
  if (segment !== undefined && selected.length === 0) throw new OoxmlTextError("entry_not_found", "sheet not found");
  let sharedStrings = [];
  const sharedRel = [...rels.values()].find((rel) => REL_SHARED_STRINGS.test(rel.type));
  if (selected.length && sharedRel && hasEntry(zip, sharedRel.target)) {
    sharedStrings = readSharedStrings(await readPart(zip, sharedRel.target, limits.maxPartBytes));
  }
  const segments = [];
  for (const sheet of selected) {
    if (budget.exhausted) { budget.truncated = true; break; }
    if (!hasEntry(zip, sheet.part)) continue;
    const text = sheetCsv(await readPart(zip, sheet.part, limits.maxPartBytes), sharedStrings, budget, limits);
    segments.push({ name: sheet.name, part: sheet.part, text });
  }
  return segments;
}

/** Extract text. `source` is a reader from `openZip` or the archive bytes (in-memory mode).
 * Options: `kind` ("docx" | "xlsx" | "pptx", required), `maxTextBytes` (default 256 KiB,
 * at most `maxExtractBytes` for range reads at an offset),
 * `segment` (xlsx sheet name to extract alone). Returns
 * `{ kind, segments: [{ name, part, text }], truncated, text_bytes, untrusted_content: true }`.
 * @param {any} source
 * @param {{ kind?: string, maxTextBytes?: number, segment?: string }} [options] */
export async function extractOoxmlText(source, { kind, maxTextBytes = OOXML_TEXT_LIMITS.maxTextBytes, segment } = {}) {
  if (!Object.hasOwn(DEFAULT_MAIN, kind)) throw new TypeError("kind must be docx, xlsx or pptx");
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0 || maxTextBytes > OOXML_TEXT_LIMITS.maxExtractBytes) {
    throw new RangeError(`maxTextBytes must be 1..${OOXML_TEXT_LIMITS.maxExtractBytes}`);
  }
  const zip = source instanceof Uint8Array ? await openZip({ bytes: source }) : source;
  if (!zip || typeof zip.readEntry !== "function") throw new TypeError("source must be a zip reader or Uint8Array");
  const budget = new TextBudget(maxTextBytes);
  const limits = OOXML_TEXT_LIMITS;
  const segments = kind === "docx" ? await extractDocx(zip, budget, limits)
    : kind === "xlsx" ? await extractXlsx(zip, budget, limits, { segment })
      : await extractPptx(zip, budget, limits);
  return {
    kind,
    segments,
    truncated: budget.truncated,
    text_bytes: maxTextBytes - budget.left,
    untrusted_content: true,
  };
}
