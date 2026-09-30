import { extractOoxmlText, OOXML_TEXT_LIMITS } from "../../../kernel/host/resource-center-ooxml-text.mjs";
import { openZip, ZIP_LIMITS } from "../../../kernel/host/resource-center-zip-reader.mjs";

/** StorageNormalUse.v0.1 §4 (N1b): format decisions for clued_storage_read.
 * Pure functions only: no provider requests, no credentials. The read agent
 * decides scope and fetches bytes through its single content channel, then
 * hands the bytes (or a bounded range reader) to these helpers.
 *
 * - `classifyFormat`: Drive mimeType first; generic types fall back to the
 *   file-name extension. Magic bytes are checked after download (§4 order).
 * - `imageInfo`: png / jpeg / gif / webp magic and pixel size from the header.
 * - `extractOfficeText`: docx / xlsx / pptx text through the bounded zip reader
 *   and DOCTYPE-rejecting SAX tokenizer (§4.3), joined into one UTF-8 text so
 *   byte ranges work exactly like text files. */

export type ReadFormat = "text" | "google_doc" | "google_sheet" | "google_slides" | "google_native" | "folder" |
  "docx" | "xlsx" | "pptx" | "pdf" | "png" | "jpeg" | "gif" | "webp" | "image_other" |
  "zip" | "archive" | "video" | "audio" | "legacy_office" | "odf" | "binary";

const GOOGLE = "application/vnd.google-apps.";
const OFFICE: Record<string, ReadFormat> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
const BY_MIME: Record<string, ReadFormat> = {
  ...OFFICE,
  "application/pdf": "pdf",
  "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/gif": "gif", "image/webp": "webp",
  "application/zip": "zip", "application/x-zip-compressed": "zip",
  "application/vnd.rar": "archive", "application/x-rar-compressed": "archive", "application/x-7z-compressed": "archive",
  "application/x-tar": "archive", "application/gzip": "archive", "application/x-gzip": "archive",
  "application/msword": "legacy_office", "application/vnd.ms-excel": "legacy_office", "application/vnd.ms-powerpoint": "legacy_office",
  "application/vnd.oasis.opendocument.text": "odf", "application/vnd.oasis.opendocument.spreadsheet": "odf",
  "application/vnd.oasis.opendocument.presentation": "odf",
};
const BY_EXTENSION: Record<string, ReadFormat> = {
  docx: "docx", xlsx: "xlsx", pptx: "pptx", pdf: "pdf", png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp",
  heic: "image_other", heif: "image_other", tif: "image_other", tiff: "image_other", bmp: "image_other",
  zip: "zip", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", tgz: "archive",
  doc: "legacy_office", xls: "legacy_office", ppt: "legacy_office", odt: "odf", ods: "odf", odp: "odf",
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", mp3: "audio", m4a: "audio", wav: "audio", flac: "audio",
};
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/binary", "application/unknown"]);
export const textualMime = (mime: string) => /^text\/[A-Za-z0-9.+-]+$/.test(mime) || mime === "application/json" || mime === "application/xml";

export function classifyFormat(mime: string, name: string): ReadFormat {
  if (textualMime(mime)) return "text";
  if (mime === GOOGLE + "folder") return "folder";
  if (mime === GOOGLE + "document") return "google_doc";
  if (mime === GOOGLE + "spreadsheet") return "google_sheet";
  if (mime === GOOGLE + "presentation") return "google_slides";
  if (mime.startsWith(GOOGLE)) return "google_native";
  if (Object.hasOwn(BY_MIME, mime)) return BY_MIME[mime];
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image_other";
  if (GENERIC.has(mime)) {
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
    if (extension && Object.hasOwn(BY_EXTENSION, extension)) return BY_EXTENSION[extension];
  }
  return "binary";
}

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024, IMAGE_MAX_EDGE = 8000;
export type ImageInfo = { format: "png" | "jpeg" | "gif" | "webp"; mime_type: string; width: number; height: number };

/** Magic and pixel size from the header; null when it is not one of the four formats or the header is damaged. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, text: string) => at + text.length <= bytes.length && [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));
  const out = (format: ImageInfo["format"], width: number, height: number): ImageInfo | null =>
    width > 0 && height > 0 ? { format, mime_type: "image/" + format, width, height } : null;
  if (bytes.length >= 24 && ascii(0, "\x89PNG\r\n\x1a\n") && ascii(12, "IHDR")) return out("png", dv.getUint32(16), dv.getUint32(20));
  if (bytes.length >= 10 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return out("gif", dv.getUint16(6, true), dv.getUint16(8, true));
  if (bytes.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return out("webp", dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
    if (ascii(12, "VP8L") && bytes[20] === 0x2f) {
      const b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
      return out("webp", 1 + (bytes[21] | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
    }
    if (ascii(12, "VP8X")) {
      const u24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
      return out("webp", 1 + u24(24), 1 + u24(27));
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) { at++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = dv.getUint16(at + 2);
      if (length < 2) return null;
      // SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return at + 9 <= bytes.length ? out("jpeg", dv.getUint16(at + 7), dv.getUint16(at + 5)) : null;
      at += 2 + length;
    }
    return null;
  }
  return null;
}

// Text of an Office file extracted for one call: at most 8 MiB, so a range read
// at an offset can be served; each call still returns at most 256 KiB.
export const EXTRACT_TEXT_MAX: number = OOXML_TEXT_LIMITS.maxExtractBytes;
export const IN_MEMORY_ZIP_MAX: number = ZIP_LIMITS.inMemoryMaxBytes;

type StorageFormatCode = "document_invalid" | "archive_limit_exceeded" | "binary_too_large" | "content_not_accessible" | "storage_read_unavailable" |
  "request_limit_exceeded";
export class StorageFormatError extends Error {
  readonly code: StorageFormatCode;
  constructor(code: StorageFormatCode) { super(code); this.code = code; }
}

/** One joined text, stable across budgets: `join(budget B)` is a prefix of
 * `join(budget B' > B)`, so byte offsets from an earlier call stay valid.
 * xlsx sheets and pptx slides get a header line; separators go BEFORE a header,
 * never after a (possibly truncated) segment. */
export async function extractOfficeText(source: { bytes: Uint8Array } |
  { size: number; readRange: (offset: number, length: number) => Promise<Uint8Array>; release?: () => void },
  kind: "docx" | "xlsx" | "pptx", maxTextBytes: number): Promise<{ text: string; complete: boolean }> {
  let result: { segments: { name: string; text: string }[]; truncated: boolean };
  try {
    const zip = await openZip(source);
    // The tail and central directory are parsed: a range reader may drop its cached blocks.
    if ("release" in source) source.release?.();
    result = await extractOoxmlText(zip, { kind, maxTextBytes });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    // Budget / transport failures raised by the caller's readRange pass through unchanged.
    if (error instanceof StorageFormatError) throw error;
    if (code === "archive_limit_exceeded") throw new StorageFormatError("archive_limit_exceeded");
    if (["archive_invalid", "document_invalid", "entry_not_found", "entry_encrypted", "entry_method_unsupported"].includes(code))
      throw new StorageFormatError("document_invalid");
    throw new StorageFormatError("storage_read_unavailable");
  }
  // Headers are single lines: a sheet name cannot inject a line break. A pptx header is the
  // segment name ("Slide N" in presentation order, also when a listed slide part is missing).
  const text = result.segments.map((segment, index) => (index ? "\n" : "") +
    (kind === "xlsx" ? `# Sheet: ${segment.name.replace(/[\r\n]+/g, " ")}\n` : kind === "pptx" ? `# ${segment.name}\n` : "") + segment.text).join("");
  return { text, complete: !result.truncated };
}
