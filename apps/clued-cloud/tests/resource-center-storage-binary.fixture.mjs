/** Minimal binary fixtures for StorageNormalUse N3 tests: PNG / PDF bytes, an in-memory R2 bucket
 * that records every read (so tests can assert bounded, ranged processing), a bytes-backed
 * content source with the executor's verify / stream contract, and a multipart parser. */
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

/** In-memory R2: put consumes streams concurrently, like the binding; get honours `range`
 * (with R2's `size` = whole object) and records the largest body handed out and any
 * whole-object read. */
export function memoryBucket() {
  const objects = new Map();
  const bucket = {
    objects, puts: 0, deletes: [], reads: 0, maxReadBytes: 0, wholeReads: 0,
    async put(key, value) {
      bucket.puts++;
      let bytes;
      if (value instanceof Uint8Array) bytes = Buffer.from(value);
      else bytes = Buffer.from(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return { key, size: bytes.length };
    },
    async get(key, options = {}) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const range = options.range;
      const offset = range ? range.offset : 0, length = range ? range.length : bytes.length;
      if (!range) bucket.wholeReads++;
      if (offset < 0 || length < 0 || offset + length > bytes.length) throw new Error("range outside the object");
      return { size: bytes.length, arrayBuffer: async () => {
        bucket.reads++; bucket.maxReadBytes = Math.max(bucket.maxReadBytes, length);
        return bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length);
      } };
    },
    async delete(keys) { for (const key of [keys].flat()) { bucket.deletes.push(key); objects.delete(key); } },
  };
  return bucket;
}

export const sha256Hex = bytes => createHash("sha256").update(bytes).digest("hex");

/** The executor's content-source contract over plain bytes: `size` / `sha256` are the declared
 * values, `verify()` hashes the bytes, `stream()` yields 64 KiB pieces and errors before the
 * last piece if the bytes differ from the declared digest. */
export function bytesContentSource(bytes, declared = { size: bytes.length, sha256: sha256Hex(bytes) }) {
  let verified = false;
  return {
    size: declared.size, sha256: declared.sha256,
    get verified() { return verified; },
    async verify() {
      if (bytes.length !== declared.size || sha256Hex(bytes) !== declared.sha256) throw new Error("staged content mismatch");
      verified = true;
    },
    stream() {
      let at = 0;
      const digest = createHash("sha256");
      return new ReadableStream({ pull(controller) {
        const piece = bytes.subarray(at, at + 65536); at += piece.length;
        digest.update(piece);
        if (at >= bytes.length && digest.digest("hex") !== declared.sha256) return controller.error(new Error("digest"));
        controller.enqueue(piece);
        if (at >= bytes.length) controller.close();
      } }, { highWaterMark: 0 });
    },
  };
}

/** Read a fetch body (bytes, string or stream) into a Buffer. */
export async function bodyBytes(body) {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(await new Response(body).arrayBuffer());
}

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
