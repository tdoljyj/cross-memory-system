/** Minimal binary fixtures for StorageNormalUse N3 tests: PNG / PDF bytes, a tiny Compound File
 * (CFB, one FAT sector + one directory sector), an in-memory R2 bucket and a fake Drive that
 * accepts multipart and single-PUT resumable uploads. */
import { createHash, randomUUID } from "node:crypto";

export function pngBytes(size = 256) {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) out[i] = (i * 7) & 0xff;
  return out;
}
export function pdfBytes(size = 256) {
  const out = new Uint8Array(size).fill(0x20);
  out.set(new TextEncoder().encode("%PDF-1.7\n"));
  return out;
}

/** entries: [name, type] pairs after the root (type 1 = storage, 2 = stream). */
export function buildCfb(...entries) {
  const out = new Uint8Array(512 * 3);
  const dv = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  dv.setUint16(0x18, 0x3e, true); dv.setUint16(0x1a, 3, true); dv.setUint16(0x1c, 0xfffe, true);
  dv.setUint16(0x1e, 9, true); dv.setUint16(0x20, 6, true);
  dv.setUint32(0x2c, 1, true); dv.setUint32(0x30, 1, true); dv.setUint32(0x38, 4096, true);
  dv.setUint32(0x3c, 0xfffffffe, true); dv.setUint32(0x44, 0xfffffffe, true);
  for (let i = 0; i < 109; i++) dv.setUint32(0x4c + i * 4, 0xffffffff, true);
  dv.setUint32(0x4c, 0, true);
  const fat = 512;
  for (let i = 0; i < 128; i++) dv.setUint32(fat + i * 4, 0xffffffff, true);
  dv.setUint32(fat, 0xfffffffd, true); dv.setUint32(fat + 4, 0xfffffffe, true);
  const dir = 1024;
  const put = (index, name, type) => {
    const at = dir + index * 128;
    for (let i = 0; i < name.length; i++) dv.setUint16(at + i * 2, name.charCodeAt(i), true);
    dv.setUint16(at + 0x40, (name.length + 1) * 2, true);
    out[at + 0x42] = type;
    dv.setUint32(at + 0x44, 0xffffffff, true); dv.setUint32(at + 0x48, 0xffffffff, true); dv.setUint32(at + 0x4c, 0xffffffff, true);
  };
  put(0, "Root Entry", 5);
  entries.forEach(([name, type], i) => put(i + 1, name, type));
  return out;
}

/** In-memory R2: put consumes streams concurrently, like the binding. */
export function memoryBucket() {
  const objects = new Map();
  const bucket = {
    objects, puts: 0, deletes: [],
    async put(key, value) {
      bucket.puts++;
      let bytes;
      if (value instanceof Uint8Array) bytes = Buffer.from(value);
      else bytes = Buffer.from(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) } : null;
    },
    async delete(keys) { for (const key of [keys].flat()) { bucket.deletes.push(key); objects.delete(key); } },
  };
  return bucket;
}

export const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

/** Parse a Drive multipart/related upload body (JSON metadata part + media part) into bytes. */
export function parseMultipart(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const raw = Buffer.from(body);
  const marker = Buffer.from(`--${boundary}`);
  const first = raw.indexOf(marker), second = raw.indexOf(marker, first + marker.length), end = raw.indexOf(Buffer.from(`\r\n--${boundary}--`), second);
  const metaPart = raw.subarray(first + marker.length, second).toString("utf8");
  const metadata = JSON.parse(metaPart.slice(metaPart.indexOf("\r\n\r\n") + 4).trim());
  const mediaPart = raw.subarray(second + marker.length, end);
  const split = mediaPart.indexOf(Buffer.from("\r\n\r\n"));
  const headers = mediaPart.subarray(0, split).toString("utf8");
  return { metadata, mediaType: /Content-Type: (.+)/i.exec(headers)[1].trim(), bytes: mediaPart.subarray(split + 4) };
}

export { randomUUID };
