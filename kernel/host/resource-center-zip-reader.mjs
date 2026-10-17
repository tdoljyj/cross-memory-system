/** Dependency-free zip reader for Clued Storage reads (StorageNormalUse.v0.1 §4.3, N-T3).
 *
 * Two modes, one parser:
 * - in-memory: `openZip({ bytes })`, whole archive ≤ 10 MB (EXPORT_MAX), e.g. a Sheets → xlsx export;
 * - range: `openZip({ size, readRange })` with `readRange(offset, length) => Promise<Uint8Array>`;
 *   the tail read is ≤ 64 KiB, then the central directory by offset, then one local header and
 *   one data range per entry read.
 *
 * Limits are absolute (never a compression ratio). Any breach throws
 * `ZipReaderError` with code `archive_limit_exceeded`; only stored (0) and deflate (8) are read
 * (`entry_method_unsupported`); encrypted entries throw `entry_encrypted`; structural damage throws
 * `archive_invalid`. Zip64 end records and Zip64 extra fields are parsed, and their 64-bit values
 * are held to the same absolute limits, so Zip64 cannot widen any bound.
 *
 * Entry names are untrusted data: `\` is normalised to `/`, and names with a `..` segment, an
 * absolute path, a drive letter or control characters are flagged `unsafe_name: true`. This
 * module never resolves a name against any filesystem.
 *
 * Deflate uses the platform `DecompressionStream("deflate-raw")` (Workers, Node ≥ 18). Output is
 * counted while streaming and the stream is cancelled as soon as it passes the entry's declared
 * size, the per-entry limit or the per-reader cumulative budget (zip-bomb safe). CRC-32 and the
 * exact declared size are verified before bytes are returned. */

export const ZIP_LIMITS = Object.freeze({
  inMemoryMaxBytes: 10 * 1024 * 1024,
  tailScanBytes: 64 * 1024,
  centralDirectoryMaxBytes: 4 * 1024 * 1024,
  maxEntries: 10_000,
  listingPageSize: 500,
  maxEntryUncompressedBytes: 32 * 1024 * 1024,
  maxEntryCompressedBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 32 * 1024 * 1024,
  maxNameBytes: 1024,
});

export class ZipReaderError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ZipReaderError";
    this.code = code;
  }
}

const fail = (code, detail) => { throw new ZipReaderError(code, detail); };
const invalid = (detail) => fail("archive_invalid", detail);
const limit = (detail) => fail("archive_limit_exceeded", detail);

const SIG_EOCD = 0x06054b50, SIG_ZIP64_LOCATOR = 0x07064b50, SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50, SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22, ZIP64_LOCATOR_SIZE = 20, ZIP64_EOCD_MIN = 56, CENTRAL_SIZE = 46, LOCAL_SIZE = 30;
const U16_MAX = 0xffff, U32_MAX = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, seed = 0) {
  let c = (seed ^ U32_MAX) >>> 0;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ U32_MAX) >>> 0;
}

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function u64(dv, offset) {
  const value = dv.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) limit("64-bit field beyond safe range");
  return Number(value);
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_FLAG = 0x0800;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Normalise and classify an untrusted entry name. Pure string work, no path resolution. */
export function classifyEntryName(raw) {
  const name = String(raw).replace(/\\/g, "/");
  const segments = name.split("/");
  const unsafe = CONTROL.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)
    || segments.some((segment) => segment === "..") || name.includes("�");
  return { name, unsafe_name: unsafe };
}

function normaliseLimits(overrides) {
  const out = { ...ZIP_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in ZIP_LIMITS)) throw new TypeError(`unknown zip limit ${key}`);
    // Overrides may only tighten a contract limit, never widen it.
    if (!Number.isSafeInteger(value) || value <= 0 || value > ZIP_LIMITS[key]) throw new RangeError(`zip limit ${key} must be 1..${ZIP_LIMITS[key]}`);
    out[key] = value;
  }
  return Object.freeze(out);
}

function makeSource(input, limits) {
  if (input?.bytes !== undefined) {
    const bytes = input.bytes;
    if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
    if (bytes.byteLength > limits.inMemoryMaxBytes) limit("in-memory archive larger than the export cap");
    return {
      size: bytes.byteLength,
      async read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > bytes.byteLength) invalid("read outside the archive");
        return bytes.subarray(offset, offset + length);
      },
    };
  }
  const { size, readRange } = input ?? {};
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("size must be a non-negative safe integer");
  if (typeof readRange !== "function") throw new TypeError("readRange must be a function");
  return {
    size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) invalid("read outside the archive");
      if (length === 0) return new Uint8Array(0);
      const chunk = await readRange(offset, length);
      if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) invalid("range read returned the wrong length");
      return chunk;
    },
  };
}

function findEocd(tail) {
  const dv = view(tail);
  for (let i = tail.byteLength - EOCD_SIZE; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLength = dv.getUint16(i + 20, true);
    if (i + EOCD_SIZE + commentLength === tail.byteLength) return i;
  }
  return -1;
}

function parseZip64Extra(extra, need) {
  const dv = view(extra);
  let at = 0;
  while (at + 4 <= extra.byteLength) {
    const id = dv.getUint16(at, true), len = dv.getUint16(at + 2, true);
    const start = at + 4, end = start + len;
    if (end > extra.byteLength) invalid("extra field overruns");
    if (id === 0x0001) {
      let p = start;
      const take = () => { if (p + 8 > end) invalid("short Zip64 extra field"); const v = u64(dv, p); p += 8; return v; };
      const out = {};
      if (need.uncompressed) out.uncompressed = take();
      if (need.compressed) out.compressed = take();
      if (need.offset) out.offset = take();
      return out;
    }
    at = end;
  }
  invalid("Zip64 sentinel without Zip64 extra field");
}

/** Open an archive and parse its central directory. Returns a reader with `entries`,
 * `listEntries({ offset, limit })`, `readEntry(indexOrName, { maxBytes })` and the opt-in
 * upload interoperability check `validateEntryName(indexOrName)`. */
export async function openZip(input, { limits: overrides } = {}) {
  const limits = normaliseLimits(overrides);
  const source = makeSource(input, limits);
  if (source.size < EOCD_SIZE) invalid("too small to be a zip");

  const tailLength = Math.min(source.size, limits.tailScanBytes);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  const eocdAt = findEocd(tail);
  if (eocdAt < 0) invalid("end of central directory not found in the tail window");
  const eocdOffset = tailStart + eocdAt;
  const eocd = view(tail.subarray(eocdAt));
  const disk = eocd.getUint16(4, true), cdDisk = eocd.getUint16(6, true);
  let entriesOnDisk = eocd.getUint16(8, true), totalEntries = eocd.getUint16(10, true);
  let cdSize = eocd.getUint32(12, true), cdOffset = eocd.getUint32(16, true);
  let zip64 = false;
  let cdEndBoundary = eocdOffset;

  if (totalEntries === U16_MAX || entriesOnDisk === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    zip64 = true;
    const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
    if (locatorOffset < 0) invalid("Zip64 locator missing");
    const locator = view(locatorOffset >= tailStart
      ? tail.subarray(locatorOffset - tailStart, locatorOffset - tailStart + ZIP64_LOCATOR_SIZE)
      : await source.read(locatorOffset, ZIP64_LOCATOR_SIZE));
    if (locator.getUint32(0, true) !== SIG_ZIP64_LOCATOR) invalid("Zip64 locator missing");
    if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) !== 1) invalid("multi-disk archive");
    const recordOffset = u64(locator, 8);
    if (recordOffset + ZIP64_EOCD_MIN > locatorOffset) invalid("Zip64 end record out of range");
    const record = view(await source.read(recordOffset, ZIP64_EOCD_MIN));
    if (record.getUint32(0, true) !== SIG_ZIP64_EOCD) invalid("Zip64 end record signature");
    if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) invalid("multi-disk archive");
    entriesOnDisk = u64(record, 24);
    totalEntries = u64(record, 32);
    cdSize = u64(record, 40);
    cdOffset = u64(record, 48);
    cdEndBoundary = recordOffset;
  } else if (disk !== 0 || cdDisk !== 0) {
    invalid("multi-disk archive");
  }

  if (entriesOnDisk !== totalEntries) invalid("multi-disk archive");
  if (totalEntries > limits.maxEntries) limit(`entry count ${totalEntries} > ${limits.maxEntries}`);
  if (cdSize > limits.centralDirectoryMaxBytes) limit(`central directory ${cdSize} bytes`);
  if (cdOffset + cdSize > cdEndBoundary) invalid("central directory overlaps the end records");
  if (totalEntries > 0 && cdSize < totalEntries * CENTRAL_SIZE) invalid("central directory too small for its entry count");

  const cd = await source.read(cdOffset, cdSize);
  const dv = view(cd);
  const entries = [];
  const nameMetadata = [];
  let at = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (at + CENTRAL_SIZE > cd.byteLength || dv.getUint32(at, true) !== SIG_CENTRAL) invalid(`central header ${index}`);
    const flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true);
    const crc = dv.getUint32(at + 16, true);
    let compressed = dv.getUint32(at + 20, true), uncompressed = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true), extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true), diskStart = dv.getUint16(at + 34, true);
    let localOffset = dv.getUint32(at + 42, true);
    const nameStart = at + CENTRAL_SIZE, extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > cd.byteLength) invalid(`central header ${index} overruns`);
    if (nameLength > limits.maxNameBytes) limit(`entry name ${nameLength} bytes`);
    const rawName = cd.subarray(nameStart, extraStart);
    const extra = cd.subarray(extraStart, extraStart + extraLength);
    const rawComment = cd.subarray(extraStart + extraLength, next);
    const need = { uncompressed: uncompressed === U32_MAX, compressed: compressed === U32_MAX, offset: localOffset === U32_MAX };
    let entryZip64 = false;
    if (need.uncompressed || need.compressed || need.offset || diskStart === U16_MAX) {
      if (diskStart === U16_MAX) invalid("multi-disk entry");
      const values = parseZip64Extra(extra, need);
      if (need.uncompressed) uncompressed = values.uncompressed;
      if (need.compressed) compressed = values.compressed;
      if (need.offset) localOffset = values.offset;
      entryZip64 = true;
    } else if (diskStart !== 0) {
      invalid("multi-disk entry");
    }
    if (localOffset + LOCAL_SIZE > cdOffset) invalid(`entry ${index} local header outside the data area`);
    const { name, unsafe_name } = classifyEntryName(utf8.decode(rawName));
    entries.push(Object.freeze({
      index,
      name,
      unsafe_name,
      directory: name.endsWith("/"),
      method,
      encrypted: (flags & 0x1) !== 0 || (flags & 0x40) !== 0,
      compressed_size: compressed,
      uncompressed_size: uncompressed,
      crc32: crc,
      zip64: entryZip64,
      local_header_offset: localOffset,
      flags,
    }));
    nameMetadata.push({ rawName, rawComment });
    at = next;
  }

  const byName = new Map();
  for (const entry of entries) byName.set(entry.name, byName.has(entry.name) ? null : entry);
  let consumed = 0;
  const validatedLocalHeaders = new Map();

  function listEntries({ offset = 0, limit: pageSize = limits.listingPageSize } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("offset must be a non-negative integer");
    const size = Math.min(Math.max(1, pageSize | 0), limits.listingPageSize);
    const page = entries.slice(offset, offset + size).map((entry) => ({
      index: entry.index, name: entry.name, unsafe_name: entry.unsafe_name, directory: entry.directory,
      method: entry.method, encrypted: entry.encrypted,
      compressed_size: entry.compressed_size, uncompressed_size: entry.uncompressed_size,
    }));
    const end = offset + page.length;
    return { entries: page, total: entries.length, next_offset: end < entries.length ? end : null };
  }

  function resolve(ref) {
    if (typeof ref === "number") return entries[ref] ?? fail("entry_not_found");
    if (typeof ref === "string") {
      const hit = byName.get(ref);
      if (hit === null) invalid("duplicate entry name");
      return hit ?? fail("entry_not_found");
    }
    if (ref && typeof ref.index === "number" && entries[ref.index]?.name === ref.name) return entries[ref.index];
    return fail("entry_not_found");
  }

  /** Opt-in upload check. Existing reads retain their legacy filename decoding. Non-ASCII
   * names must explicitly use UTF-8 in both headers for Windows-compatible downloads;
   * a Unicode path extra field alone cannot provide that guarantee. Never rewrites bytes. */
  async function validateEntryName(ref) {
    const entry = resolve(ref);
    const { rawName, rawComment } = nameMetadata[entry.index];
    if (!(entry.flags & UTF8_FLAG) && rawName.some(byte => byte >= 0x80)) invalid("non-ASCII entry name without the UTF-8 flag");
    if (entry.flags & UTF8_FLAG) {
      // Bit 11 governs the entry comment as well as its name. Setting it over arbitrary
      // comment bytes would create a second encoding error rather than repair a package.
      try { utf8Strict.decode(rawName); utf8Strict.decode(rawComment); }
      catch { invalid("entry name or comment is not valid UTF-8"); }
    }
    if (validatedLocalHeaders.has(entry.index)) return true;
    const headerLength = LOCAL_SIZE + rawName.byteLength;
    if (entry.local_header_offset + headerLength > cdOffset) invalid("local entry name outside the data area");
    const header = await source.read(entry.local_header_offset, headerLength);
    const hv = view(header);
    if (hv.getUint32(0, true) !== SIG_LOCAL) invalid("local header signature");
    const flags = hv.getUint16(6, true), method = hv.getUint16(8, true);
    if ((flags & UTF8_FLAG) !== (entry.flags & UTF8_FLAG)) invalid("local and central UTF-8 flags differ");
    if (hv.getUint16(26, true) !== rawName.byteLength ||
      rawName.some((byte, index) => byte !== header[LOCAL_SIZE + index])) invalid("local and central entry names differ");
    const dataStart = entry.local_header_offset + headerLength + hv.getUint16(28, true);
    if (dataStart + entry.compressed_size > cdOffset) invalid("entry data outside the data area");
    validatedLocalHeaders.set(entry.index, { flags, method, dataStart });
    return true;
  }

  async function readEntry(ref, { maxBytes } = {}) {
    const entry = resolve(ref);
    if (entry.directory) fail("entry_not_found", "directory entry");
    if (entry.encrypted) fail("entry_encrypted");
    if (entry.method !== 0 && entry.method !== 8) fail("entry_method_unsupported", `method ${entry.method}`);
    const cap = Math.min(limits.maxEntryUncompressedBytes, maxBytes ?? Infinity);
    if (entry.uncompressed_size > cap) limit(`entry ${entry.uncompressed_size} bytes > ${cap}`);
    if (consumed + entry.uncompressed_size > limits.maxTotalUncompressedBytes) limit("cumulative decompressed budget");
    if (entry.compressed_size > limits.maxEntryCompressedBytes) limit("compressed entry too large");
    if (entry.method === 0 && entry.compressed_size !== entry.uncompressed_size) invalid("stored entry size mismatch");

    let local = validatedLocalHeaders.get(entry.index);
    if (!local) {
      const header = await source.read(entry.local_header_offset, LOCAL_SIZE);
      const hv = view(header);
      if (hv.getUint32(0, true) !== SIG_LOCAL) invalid("local header signature");
      local = { flags: hv.getUint16(6, true), method: hv.getUint16(8, true),
        dataStart: entry.local_header_offset + LOCAL_SIZE + hv.getUint16(26, true) + hv.getUint16(28, true) };
    }
    const localFlags = local.flags;
    if ((localFlags & 0x1) !== 0 || (localFlags & 0x40) !== 0) fail("entry_encrypted");
    if (local.method !== entry.method) invalid("local and central method differ");
    const dataStart = local.dataStart;
    if (dataStart + entry.compressed_size > cdOffset) invalid("entry data outside the data area");

    const compressed = await source.read(dataStart, entry.compressed_size);
    const budgetLeft = limits.maxTotalUncompressedBytes - consumed;
    const out = entry.method === 0 ? compressed.slice() : await inflateCapped(compressed, entry.uncompressed_size, Math.min(cap, budgetLeft));
    consumed += out.byteLength;
    if (out.byteLength !== entry.uncompressed_size) invalid("decompressed size differs from the declared size");
    if (crc32(out) !== entry.crc32) invalid("CRC-32 mismatch");
    return out;
  }

  return Object.freeze({
    mode: input?.bytes !== undefined ? "memory" : "range",
    size: source.size,
    zip64,
    limits,
    entries: Object.freeze(entries),
    listEntries,
    readEntry,
    validateEntryName,
    get consumedBytes() { return consumed; },
  });
}

/** Inflate raw deflate, cancelling as soon as output passes `declared` or `cap`. */
async function inflateCapped(compressed, declared, cap) {
  if (typeof DecompressionStream !== "function") fail("storage_read_unavailable", "DecompressionStream unavailable");
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const ignore = () => {};
  const CHUNK = 64 * 1024;
  // Feed without awaiting so backpressure cannot deadlock against the reader below.
  (async () => {
    try {
      for (let i = 0; i < compressed.byteLength; i += CHUNK) await writer.write(compressed.subarray(i, i + CHUNK));
      await writer.close();
    } catch { /* surfaced through the reader */ }
  })().catch(ignore);
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      let step;
      try {
        step = await reader.read();
      } catch (error) {
        if (error instanceof ZipReaderError) throw error;
        invalid("corrupt deflate stream");
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > cap) limit("decompressed bytes passed the limit");
      if (total > declared) limit("decompressed bytes passed the declared size");
      parts.push(step.value);
    }
  } catch (error) {
    reader.cancel().catch(ignore);
    writer.abort().catch(ignore);
    throw error;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}
