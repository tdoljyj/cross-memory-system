/** Binary upload type policy for Clued Storage `create` (StorageNormalUse.v0.1 §6.3, N-T6).
 *
 * Pure checks shared by the Worker (upload_begin, the signed PUT endpoint, inline submit)
 * and tests. No provider access, no storage, no secrets.
 *
 * - `binaryUploadTarget(path, mime)`: the destination extension must map to exactly this MIME
 *   in the allow table; macro-enabled, legacy Office (CFB: doc / xls / ppt), executable/script,
 *   HTML/XHTML/SVG and Google-native types are never accepted in binary form.
 * - `firstChunkCheck(bytes, mime)`: the denylisted magic numbers (MZ, ELF, Mach-O / fat, `#!`)
 *   are refused whatever the declared type, and the leading bytes must match the MIME's magic.
 * - `validateStagedContent(source, mime)`: the post-staging (`validating`) checks. `source` is
 *   either the bytes or a range reader `{ size, readRange(offset, length) }`, so the Worker never
 *   needs the whole object in memory: the zip reader's range mode reads the tail, the central
 *   directory (capped) and only the XML parts inspected below.
 *   zip / OOXML / ODF: entries named `vbaProject.bin` and ODF `Basic/` / `Scripts/` folders are
 *   refused; `[Content_Types].xml` and every `.rels` part is decoded strictly (UTF-8 only, BOM
 *   or declaration naming anything else refused, UTF-16 refused, no DOCTYPE / entity
 *   declarations, no character references, only the five predefined entities, which are
 *   resolved), then any content type or relationship type naming a VBA project, VBA data,
 *   ActiveX, a macro sheet, key-map customizations or a macro-enabled main type refuses the
 *   file whatever the part is called.
 *
 * Every refusal is the fixed code `content_type_mismatch`. */
import { openZip } from "./resource-center-zip-reader.mjs";

export const BINARY_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const BINARY_MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
export const BINARY_INLINE_MAX_BYTES = 1024 * 1024;
export const CONTENT_TYPE_MISMATCH = "content_type_mismatch";
/** Leading bytes the first-chunk check looks at (one staging chunk). */
export const FIRST_CHUNK_BYTES = 64 * 1024;

const OOXML = "application/vnd.openxmlformats-officedocument.";
const ODF = "application/vnd.oasis.opendocument.";

/** Extension -> the one MIME it may be uploaded as, and the magic that MIME requires. */
export const BINARY_EXTENSION_MIME = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  docx: OOXML + "wordprocessingml.document",
  xlsx: OOXML + "spreadsheetml.sheet",
  pptx: OOXML + "presentationml.presentation",
  odt: ODF + "text",
  ods: ODF + "spreadsheet",
  odp: ODF + "presentation",
});

const MIME_MAGIC = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/zip": "zip",
  [OOXML + "wordprocessingml.document"]: "zip",
  [OOXML + "spreadsheetml.sheet"]: "zip",
  [OOXML + "presentationml.presentation"]: "zip",
  [ODF + "text"]: "zip",
  [ODF + "spreadsheet"]: "zip",
  [ODF + "presentation"]: "zip",
});

// Never accepted in binary form, even if a later table edit maps them. Legacy Office (CFB)
// is excluded because its macro storages cannot be checked without reading arbitrary sectors.
const EXCLUDED_EXTENSIONS = new Set([
  "docm", "xlsm", "pptm", "dotm", "xltm", "potm", "ppsm", "xlam", "xlsb", "sldm", "ppam",
  "doc", "dot", "xls", "xlt", "xla", "ppt", "pot", "pps", "msg",
  "html", "htm", "xhtml", "xht", "svg", "svgz", "shtml", "mht", "mhtml",
  "exe", "dll", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "mjs", "cjs",
  "wsf", "wsh", "hta", "jar", "sh", "bash", "zsh", "csh", "py", "pl", "rb", "php", "app", "dmg", "pkg", "deb", "rpm",
  "apk", "elf", "so", "dylib", "bin", "lnk", "reg", "cpl", "gadget", "inf", "sys", "iso", "img",
]);
const EXCLUDED_MIME = [
  /^application\/vnd\.google-apps\./,
  /macroenabled/i,
  /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.ms-outlook|x-ole-storage|x-cfb)$/,
  /^text\/html$/, /^application\/xhtml\+xml$/, /^image\/svg\+xml$/,
  /^application\/(x-)?(msdownload|msdos-program|dosexec|executable|elf|mach-binary|sh|shellscript|javascript|ecmascript|java-archive|x-msi|vnd\.microsoft\.portable-executable)$/,
  /^text\/(javascript|ecmascript|x-shellscript|x-python|x-perl)$/,
];

const fail = () => { throw new Error(CONTENT_TYPE_MISMATCH); };

export function destinationExtension(path) {
  if (typeof path !== "string") return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Extension <-> MIME binding and exclusions, checked before any byte is accepted. */
export function binaryUploadTarget(destinationPath, mimeType) {
  if (typeof mimeType !== "string" || EXCLUDED_MIME.some(re => re.test(mimeType))) return { ok: false, code: CONTENT_TYPE_MISMATCH };
  const extension = destinationExtension(destinationPath);
  if (!extension || EXCLUDED_EXTENSIONS.has(extension) || !Object.hasOwn(BINARY_EXTENSION_MIME, extension) ||
    BINARY_EXTENSION_MIME[extension] !== mimeType) return { ok: false, code: CONTENT_TYPE_MISMATCH };
  return { ok: true, extension, mime_type: mimeType, magic: MIME_MAGIC[mimeType] };
}

const starts = (bytes, prefix, offset = 0) => bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text) => [...text].map(c => c.charCodeAt(0));

/** Refused whatever the declared type (§6.3 first-chunk table). */
export function deniedMagic(bytes) {
  return starts(bytes, ascii("MZ")) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    starts(bytes, [0xfe, 0xed, 0xfa, 0xce]) || starts(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    starts(bytes, [0xce, 0xfa, 0xed, 0xfe]) || starts(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    starts(bytes, [0xca, 0xfe, 0xba, 0xbe]) || starts(bytes, ascii("#!"));
}

export function magicKind(bytes) {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "gif";
  if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) return "webp";
  if (starts(bytes, ascii("%PDF-"))) return "pdf";
  // Local file header of a non-empty archive (an empty zip has no data to upload).
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "cfb";
  return null;
}

/** First bytes of the stream (at least the first 64 KiB chunk, or the whole object if shorter). */
export function firstChunkCheck(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) fail();
  if (deniedMagic(bytes)) fail();
  const wanted = MIME_MAGIC[mimeType];
  if (!wanted || magicKind(bytes) !== wanted) fail();
  return wanted;
}

// Range-mode limits for validation: tighter than the read contract so a request never holds
// more than about 2 MiB of archive structure or one XML part at a time.
const VALIDATION_ZIP_LIMITS = Object.freeze({
  centralDirectoryMaxBytes: 2 * 1024 * 1024,
  maxEntryCompressedBytes: 1024 * 1024,
  maxEntryUncompressedBytes: 1024 * 1024,
});
const XML_PART_MAX_BYTES = 1024 * 1024;
// Lower-cased markers of content types / relationship types that carry or enable macros or
// active content (vbaProject, vbaProjectSignature, wordVbaData / vbaData+xml, activeX /
// activeXControlBinary, (intl)macrosheet, keyMapCustomizations, *.macroEnabled.main+xml).
const ACTIVE_CONTENT_MARKERS = ["vbaproject", "vbadata", "activex", "macrosheet", "keymapcustomizations", "macroenabled"];
const PREDEFINED_ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" });
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict decode of an OOXML package part used for the macro checks. */
export function decodePackageXml(bytes) {
  if (!(bytes instanceof Uint8Array)) fail();
  // UTF-16 / UTF-32 (with or without a BOM) is refused outright: a NUL byte never occurs in UTF-8 XML.
  if (starts(bytes, [0xff, 0xfe]) || starts(bytes, [0xfe, 0xff]) || bytes.includes(0)) fail();
  const body = starts(bytes, [0xef, 0xbb, 0xbf]) ? bytes.subarray(3) : bytes;
  let text;
  try { text = utf8Strict.decode(body); } catch { fail(); }
  const declaration = /^\s*<\?xml\b([^?]*)\?>/.exec(text);
  if (declaration) {
    const encoding = /\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(declaration[1]);
    if (encoding && !/^utf-?8$/i.test(encoding[1] ?? encoding[2])) fail();
  } else if (/<\?xml\b/i.test(text)) fail();
  // No DTD, entity declarations or CDATA; no character references at all.
  if (/<!doctype|<!entity|<!\[cdata\[/i.test(text) || text.includes("&#")) fail();
  return text.replace(/&([^;&\s]{0,16});?/g, (match, name) => {
    if (!match.endsWith(";") || !Object.hasOwn(PREDEFINED_ENTITIES, name)) fail();
    return PREDEFINED_ENTITIES[name];
  });
}

function refuseActiveContent(text) {
  const lower = text.toLowerCase();
  if (ACTIVE_CONTENT_MARKERS.some(marker => lower.includes(marker))) fail();
}

async function checkZip(source, mimeType) {
  let zip;
  try { zip = await openZip(source, { limits: VALIDATION_ZIP_LIMITS }); } catch { fail(); }
  let contentTypes = null;
  const rels = [];
  for (const entry of zip.entries) {
    const name = entry.name.toLowerCase();
    const last = name.slice(name.lastIndexOf("/") + 1);
    if (last === "vbaproject.bin") fail();
    // ODF keeps Basic macros and scripts under these top-level folders.
    if (name.startsWith("basic/") || name.startsWith("scripts/")) fail();
    if (name === "[content_types].xml") {
      if (contentTypes) fail();
      contentTypes = entry;
    } else if (last.endsWith(".rels") && !entry.directory) rels.push(entry);
  }
  // Every OOXML package has exactly one content types part.
  if (mimeType.startsWith(OOXML) && !contentTypes) fail();
  const read = async (entry) => {
    try { return await zip.readEntry(entry, { maxBytes: XML_PART_MAX_BYTES }); } catch { return fail(); }
  };
  if (contentTypes) refuseActiveContent(decodePackageXml(await read(contentTypes)));
  for (const entry of rels) {
    // Relationship targets are data (e.g. hyperlinks); the Type / Id / TargetMode carry the meaning.
    const text = decodePackageXml(await read(entry)).replace(/\bTarget\s*=\s*(?:"[^"]*"|'[^']*')/g, "Target=\"\"");
    refuseActiveContent(text);
  }
}

function rangeSource(input) {
  if (input instanceof Uint8Array) {
    if (!input.byteLength) fail();
    return { size: input.byteLength, readRange: async (offset, length) => input.subarray(offset, offset + length) };
  }
  if (!input || typeof input !== "object" || !Number.isSafeInteger(input.size) || input.size < 1 ||
    typeof input.readRange !== "function") fail();
  return { size: input.size, readRange: (offset, length) => input.readRange(offset, length) };
}

/** `validating` stage (§6.3): runs on the staged object (bytes or a range reader) before `ready`. */
export async function validateStagedContent(input, mimeType) {
  const source = rangeSource(input);
  let head;
  try { head = await source.readRange(0, Math.min(source.size, FIRST_CHUNK_BYTES)); } catch { fail(); }
  const kind = firstChunkCheck(head, mimeType);
  if (kind === "zip") await checkZip(source, mimeType);
  return true;
}
