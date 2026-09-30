/** Binary upload type policy for Clued Storage `create` (StorageNormalUse.v0.1 §6.3, N-T6).
 *
 * Pure checks shared by the Worker (upload_begin, the signed PUT endpoint, inline submit)
 * and tests. No provider access, no storage, no secrets.
 *
 * - `binaryUploadTarget(path, mime)`: the destination extension must map to exactly this MIME
 *   in the allow table; macro-enabled, executable/script, HTML/XHTML/SVG and Google-native
 *   types are never accepted in binary form.
 * - `firstChunkCheck(bytes, mime)`: the denylisted magic numbers (MZ, ELF, Mach-O / fat, `#!`)
 *   are refused whatever the declared type, and the leading bytes must match the MIME's magic.
 * - `validateStagedContent(bytes, mime)`: the post-staging (`validating`) checks that need the
 *   whole object: zip / OOXML / ODF central directory (`vbaProject.bin`, `macroEnabled`
 *   content types, ODF Basic/Scripts) and CFB storages (`VBA`, `Macros`, `_VBA_PROJECT_CUR`).
 *
 * Every refusal is the fixed code `content_type_mismatch`. */
import { openZip } from "./resource-center-zip-reader.mjs";

export const BINARY_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const BINARY_MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
export const BINARY_INLINE_MAX_BYTES = 1024 * 1024;
export const CONTENT_TYPE_MISMATCH = "content_type_mismatch";

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
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
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
  "application/msword": "cfb",
  "application/vnd.ms-excel": "cfb",
  "application/vnd.ms-powerpoint": "cfb",
});

// Never accepted in binary form, even if a later table edit maps them.
const EXCLUDED_EXTENSIONS = new Set([
  "docm", "xlsm", "pptm", "dotm", "xltm", "potm", "ppsm", "xlam", "xlsb", "sldm", "ppam",
  "html", "htm", "xhtml", "xht", "svg", "svgz", "shtml", "mht", "mhtml",
  "exe", "dll", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "mjs", "cjs",
  "wsf", "wsh", "hta", "jar", "sh", "bash", "zsh", "csh", "py", "pl", "rb", "php", "app", "dmg", "pkg", "deb", "rpm",
  "apk", "elf", "so", "dylib", "bin", "lnk", "reg", "cpl", "gadget", "inf", "sys", "iso", "img",
]);
const EXCLUDED_MIME = [
  /^application\/vnd\.google-apps\./,
  /macroenabled/i,
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

const MACRO_STORAGES = new Set(["vba", "macros", "_vba_project_cur"]);

async function checkZip(bytes) {
  let zip;
  try {
    zip = await openZip({ size: bytes.byteLength, readRange: async (offset, length) => bytes.subarray(offset, offset + length) });
  } catch { fail(); }
  let contentTypes = null;
  for (const entry of zip.entries) {
    const name = entry.name.toLowerCase();
    const last = name.slice(name.lastIndexOf("/") + 1);
    if (last === "vbaproject.bin") fail();
    // ODF keeps Basic macros and scripts under these top-level folders.
    if (name.startsWith("basic/") || name.startsWith("scripts/")) fail();
    if (name === "[content_types].xml") {
      if (contentTypes) fail();
      contentTypes = entry;
    }
  }
  if (contentTypes) {
    let xml;
    try { xml = new TextDecoder("utf-8", { fatal: false }).decode(await zip.readEntry(contentTypes, { maxBytes: 1024 * 1024 })); }
    catch { fail(); }
    if (/macroenabled/i.test(xml)) fail();
  }
}

/** Minimal Compound File Binary directory walk: any storage named VBA / Macros /
 * _VBA_PROJECT_CUR refuses the file. Structural damage refuses it too. */
function checkCfb(bytes) {
  if (bytes.byteLength < 512) fail();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shift = dv.getUint16(0x1e, true);
  if (shift !== 9 && shift !== 12) fail();
  const sectorSize = 1 << shift;
  const sectorOffset = (sector) => (sector + 1) * sectorSize;
  const fatSectors = dv.getUint32(0x2c, true);
  const firstDirectory = dv.getUint32(0x30, true);
  let difatSector = dv.getUint32(0x44, true);
  const difatCount = dv.getUint32(0x48, true);
  const maxSectors = Math.floor(bytes.byteLength / sectorSize);
  if (fatSectors > maxSectors || difatCount > maxSectors) fail();
  const fatList = [];
  for (let i = 0; i < 109 && fatList.length < fatSectors; i += 1) fatList.push(dv.getUint32(0x4c + i * 4, true));
  for (let hops = 0; fatList.length < fatSectors; hops += 1) {
    if (hops > difatCount || difatSector >= 0xfffffffa) fail();
    const base = sectorOffset(difatSector);
    if (base + sectorSize > bytes.byteLength) fail();
    for (let i = 0; i < sectorSize / 4 - 1 && fatList.length < fatSectors; i += 1) fatList.push(dv.getUint32(base + i * 4, true));
    difatSector = dv.getUint32(base + sectorSize - 4, true);
  }
  const next = (sector) => {
    const perSector = sectorSize / 4;
    const fatSector = fatList[Math.floor(sector / perSector)];
    if (fatSector === undefined || fatSector >= 0xfffffffa) fail();
    const at = sectorOffset(fatSector) + (sector % perSector) * 4;
    if (at + 4 > bytes.byteLength) fail();
    return dv.getUint32(at, true);
  };
  const seen = new Set();
  const decoder = new TextDecoder("utf-16le");
  for (let sector = firstDirectory; sector !== 0xfffffffe;) {
    if (sector >= 0xfffffffa || seen.has(sector) || seen.size > maxSectors) fail();
    seen.add(sector);
    const base = sectorOffset(sector);
    if (base + sectorSize > bytes.byteLength) fail();
    for (let at = base; at < base + sectorSize; at += 128) {
      const type = bytes[at + 0x42];
      const nameLength = dv.getUint16(at + 0x40, true);
      if (type === 0) continue;
      if (nameLength < 2 || nameLength > 64 || nameLength % 2) fail();
      const name = decoder.decode(bytes.subarray(at, at + nameLength - 2)).toLowerCase();
      if (type === 1 && MACRO_STORAGES.has(name)) fail();
    }
    sector = next(sector);
  }
}

/** `validating` stage (§6.3): runs on the decrypted staged object before it becomes `ready`. */
export async function validateStagedContent(bytes, mimeType) {
  const kind = firstChunkCheck(bytes, mimeType);
  if (kind === "zip") await checkZip(bytes);
  else if (kind === "cfb") checkCfb(bytes);
  return true;
}
