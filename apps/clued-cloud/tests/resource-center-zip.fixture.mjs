/** Programmatic zip builder for the storage extraction tests. Supports stored / deflate
 * entries, deliberate header lies (sizes, CRC, flags, method) and Zip64 end records / extras. */
import { crc32 } from "../../../kernel/host/resource-center-zip-reader.mjs";

const enc = new TextEncoder();
export const bytesOf = (data) => (typeof data === "string" ? enc.encode(data) : data);

export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(b) { this.parts.push(b); this.length += b.byteLength; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.bytes(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.bytes(b); }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.bytes(b); }
  out() { const o = new Uint8Array(this.length); let at = 0; for (const p of this.parts) { o.set(p, at); at += p.byteLength; } return o; }
}

/** entries: [{ name, data, method = 8, rawName?, lie?: { uncompressed, compressed, crc, flags, method, localFlags },
 *   zip64?: bool (sentinel sizes + Zip64 extra), payload?: Uint8Array (override compressed bytes) }]
 * options: { zip64Eocd, eocd?: { entries, cdSize, cdOffset }, zip64Record?: { entries, cdSize }, comment } */
export async function buildZip(entries, options = {}) {
  const w = new Writer();
  const central = [];
  for (const entry of entries) {
    const data = bytesOf(entry.data ?? "");
    const method = entry.method ?? 8;
    const payload = entry.payload ?? (method === 8 ? await deflateRaw(data) : data);
    const lie = entry.lie ?? {};
    const nameBytes = entry.rawName ?? enc.encode(entry.name);
    const flags = lie.flags ?? 0x0800;
    const crc = lie.crc ?? crc32(data);
    const compressed = lie.compressed ?? payload.byteLength;
    const uncompressed = lie.uncompressed ?? data.byteLength;
    const offset = w.length;
    w.u32(0x04034b50); w.u16(20); w.u16(lie.localFlags ?? flags); w.u16(lie.method ?? method); w.u16(0); w.u16(0);
    w.u32(crc); w.u32(entry.zip64 ? 0xffffffff : compressed); w.u32(entry.zip64 ? 0xffffffff : uncompressed);
    w.u16(nameBytes.byteLength); w.u16(0); w.bytes(nameBytes); w.bytes(payload);
    central.push({ nameBytes, flags, method: lie.method ?? method, crc, compressed, uncompressed, offset, zip64: entry.zip64 });
  }
  const cdOffset = w.length;
  for (const c of central) {
    const extra = new Writer();
    if (c.zip64) { extra.u16(0x0001); extra.u16(24); extra.u64(c.uncompressed); extra.u64(c.compressed); extra.u64(c.offset); }
    const extraBytes = extra.out();
    w.u32(0x02014b50); w.u16(45); w.u16(c.zip64 ? 45 : 20); w.u16(c.flags); w.u16(c.method); w.u16(0); w.u16(0);
    w.u32(c.crc); w.u32(c.zip64 ? 0xffffffff : c.compressed); w.u32(c.zip64 ? 0xffffffff : c.uncompressed);
    w.u16(c.nameBytes.byteLength); w.u16(extraBytes.byteLength); w.u16(0); w.u16(0); w.u16(0); w.u32(0);
    w.u32(c.zip64 ? 0xffffffff : c.offset); w.bytes(c.nameBytes); w.bytes(extraBytes);
  }
  const cdSize = w.length - cdOffset;
  const count = entries.length;
  if (options.zip64Eocd) {
    const recordOffset = w.length;
    const rec = options.zip64Record ?? {};
    w.u32(0x06064b50); w.u64(44); w.u16(45); w.u16(45); w.u32(0); w.u32(0);
    w.u64(rec.entries ?? count); w.u64(rec.entries ?? count); w.u64(rec.cdSize ?? cdSize); w.u64(cdOffset);
    w.u32(0x07064b50); w.u32(0); w.u64(recordOffset); w.u32(1);
  }
  const e = options.eocd ?? {};
  const comment = bytesOf(options.comment ?? "");
  w.u32(0x06054b50); w.u16(0); w.u16(0);
  const n = options.zip64Eocd ? 0xffff : (e.entries ?? count);
  w.u16(n); w.u16(n);
  w.u32(options.zip64Eocd ? 0xffffffff : (e.cdSize ?? cdSize));
  w.u32(options.zip64Eocd ? 0xffffffff : (e.cdOffset ?? cdOffset));
  w.u16(comment.byteLength); w.bytes(comment);
  return w.out();
}
