import assert from "node:assert/strict";
import test from "node:test";
import { classifyEntryName, openZip, ZIP_LIMITS, ZipReaderError } from "../../../kernel/host/resource-center-zip-reader.mjs";
import { buildZip, deflateRaw } from "./resource-center-zip.fixture.mjs";

const MiB = 1024 * 1024;
const text = (bytes) => new TextDecoder().decode(bytes);
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof ZipReaderError, `expected ZipReaderError, got ${error}`);
  assert.equal(error.code, code);
  return true;
});

function rangeSource(bytes) {
  const calls = [];
  return {
    calls,
    input: { size: bytes.byteLength, async readRange(offset, length) { calls.push([offset, length]); return bytes.slice(offset, offset + length); } },
  };
}

test("contract limits are the StorageNormalUse §4.3 absolute values", () => {
  assert.equal(ZIP_LIMITS.inMemoryMaxBytes, 10 * MiB);
  assert.equal(ZIP_LIMITS.tailScanBytes, 64 * 1024);
  assert.equal(ZIP_LIMITS.centralDirectoryMaxBytes, 4 * MiB);
  assert.equal(ZIP_LIMITS.maxEntries, 10_000);
  assert.equal(ZIP_LIMITS.listingPageSize, 500);
  assert.equal(ZIP_LIMITS.maxEntryUncompressedBytes, 32 * MiB);
  assert.equal(ZIP_LIMITS.maxTotalUncompressedBytes, 32 * MiB);
  assert.equal(ZIP_LIMITS.maxNameBytes, 1024);
});

test("limit overrides may only tighten", async () => {
  await assert.rejects(openZip({ bytes: new Uint8Array(100) }, { limits: { maxEntries: 20_000 } }), RangeError);
  await assert.rejects(openZip({ bytes: new Uint8Array(100) }, { limits: { bogus: 1 } }), TypeError);
});

test("in-memory mode lists and reads stored and deflate entries, CJK names and content", async () => {
  const zip = await openZip({ bytes: await buildZip([
    { name: "a.txt", data: "hello", method: 0 },
    { name: "资料/说明.txt", data: "中文内容，日本語、한국어" },
    { name: "dir/", data: "", method: 0 },
  ]) });
  assert.equal(zip.mode, "memory");
  assert.deepEqual(zip.entries.map((e) => [e.name, e.method, e.directory, e.unsafe_name]),
    [["a.txt", 0, false, false], ["资料/说明.txt", 8, false, false], ["dir/", 0, true, false]]);
  assert.equal(text(await zip.readEntry("a.txt")), "hello");
  assert.equal(text(await zip.readEntry(1)), "中文内容，日本語、한국어");
  await rejectsWith(zip.readEntry("dir/"), "entry_not_found");
  await rejectsWith(zip.readEntry("missing"), "entry_not_found");
  assert.equal(zip.consumedBytes, 5 + new TextEncoder().encode("中文内容，日本語、한국어").byteLength);
});

test("range mode reads the tail (≤ 64 KiB), the central directory and one entry by offset", async () => {
  const filler = new Uint8Array(200 * 1024).map((_, i) => (i * 2654435761) >>> 24);
  const bytes = await buildZip([{ name: "big.bin", data: filler, method: 0 }, { name: "x.txt", data: "range ok" }], { comment: "c" });
  const { calls, input } = rangeSource(bytes);
  const zip = await openZip(input);
  assert.equal(zip.mode, "range");
  assert.equal(calls[0][1], 64 * 1024);
  assert.equal(calls[0][0] + calls[0][1], bytes.byteLength);
  assert.equal(calls.length, 2);
  assert.equal(text(await zip.readEntry("x.txt")), "range ok");
  assert.equal(calls.length, 4);
  assert.ok(calls.every(([, length]) => length <= 64 * 1024 || length === 0));
});

test("range callbacks returning the wrong length are archive_invalid", async () => {
  const bytes = await buildZip([{ name: "a", data: "a" }]);
  await rejectsWith(openZip({ size: bytes.byteLength, readRange: async () => new Uint8Array(3) }), "archive_invalid");
});

test("listing pages at ≤ 500 entries with next_offset", async () => {
  const zip = await openZip({ bytes: await buildZip(Array.from({ length: 1203 }, (_, i) => ({ name: `f${i}`, data: "", method: 0 }))) });
  const first = zip.listEntries();
  assert.equal(first.entries.length, 500);
  assert.equal(first.next_offset, 500);
  assert.equal(zip.listEntries({ offset: 500, limit: 10_000 }).entries.length, 500);
  const last = zip.listEntries({ offset: 1000 });
  assert.equal(last.entries.length, 203);
  assert.equal(last.next_offset, null);
  assert.equal(last.total, 1203);
  assert.equal("local_header_offset" in last.entries[0], false);
});

test("entry names are data: ../, absolute, drive letters, backslashes and control characters are flagged, never resolved", async () => {
  const zip = await openZip({ bytes: await buildZip([
    { name: "../../etc/passwd", data: "x", method: 0 },
    { name: "/abs/path", data: "x", method: 0 },
    { name: "C:\\windows\\evil.dll", data: "x", method: 0 },
    { name: "ok\\nested\\file.txt", data: "x", method: 0 },
    { name: "bad\u0001name", data: "x", method: 0 },
    { name: "a/../b", data: "x", method: 0 },
    { name: "a..b/c..", data: "x", method: 0 },
  ]) });
  assert.deepEqual(zip.entries.map((e) => [e.name, e.unsafe_name]), [
    ["../../etc/passwd", true], ["/abs/path", true], ["C:/windows/evil.dll", true], ["ok/nested/file.txt", false],
    ["bad\u0001name", true], ["a/../b", true], ["a..b/c..", false],
  ]);
  assert.equal(text(await zip.readEntry("../../etc/passwd")), "x");
  assert.deepEqual(classifyEntryName("x/.."), { name: "x/..", unsafe_name: true });
});

test("encrypted entries are listed but never read", async () => {
  const zip = await openZip({ bytes: await buildZip([{ name: "secret", data: "x", method: 0, lie: { flags: 0x0801 } }]) });
  assert.equal(zip.entries[0].encrypted, true);
  await rejectsWith(zip.readEntry("secret"), "entry_encrypted");
  const localOnly = await openZip({ bytes: await buildZip([{ name: "s", data: "x", method: 0, lie: { localFlags: 0x0001 } }]) });
  await rejectsWith(localOnly.readEntry("s"), "entry_encrypted");
});

test("methods other than stored and deflate are entry_method_unsupported", async () => {
  for (const method of [1, 9, 12, 14, 93, 99]) {
    const zip = await openZip({ bytes: await buildZip([{ name: "m", data: "abc", method: 0, lie: { method } }]) });
    await rejectsWith(zip.readEntry("m"), "entry_method_unsupported");
  }
});

test("zip bomb: an honest declared size over 32 MiB is refused before inflating", async () => {
  const zeros = new Uint8Array(33 * MiB);
  const payload = await deflateRaw(zeros);
  assert.ok(payload.byteLength < 64 * 1024);
  const zip = await openZip({ bytes: await buildZip([{ name: "bomb", data: zeros, payload }]) });
  await rejectsWith(zip.readEntry("bomb"), "archive_limit_exceeded");
  assert.equal(zip.consumedBytes, 0);
});

test("zip bomb: a lying small declared size is aborted while streaming", async () => {
  const zeros = new Uint8Array(40 * MiB);
  const payload = await deflateRaw(zeros);
  const zip = await openZip({ bytes: await buildZip([{ name: "liar", data: zeros, payload, lie: { uncompressed: 1000 } }]) });
  await rejectsWith(zip.readEntry("liar"), "archive_limit_exceeded");
  assert.equal(zip.consumedBytes, 0);
});

test("zip bomb: per-call maxBytes and the cumulative 32 MiB budget apply", async () => {
  const twenty = new Uint8Array(20 * MiB);
  const payload = await deflateRaw(twenty);
  const zip = await openZip({ bytes: await buildZip([{ name: "a", data: twenty, payload }, { name: "b", data: twenty, payload }]) });
  await rejectsWith(zip.readEntry("a", { maxBytes: MiB }), "archive_limit_exceeded");
  assert.equal((await zip.readEntry("a")).byteLength, 20 * MiB);
  await rejectsWith(zip.readEntry("b"), "archive_limit_exceeded");
});

test("more than 10 000 entries is archive_limit_exceeded, declared or real", async () => {
  await rejectsWith(openZip({ bytes: await buildZip(Array.from({ length: 10_001 }, (_, i) => ({ name: String(i), data: "", method: 0 }))) }), "archive_limit_exceeded");
  const ok = await openZip({ bytes: await buildZip(Array.from({ length: 10_000 }, (_, i) => ({ name: String(i), data: "", method: 0 }))) });
  assert.equal(ok.entries.length, 10_000);
});

test("central directory over 4 MiB and names over 1024 bytes are archive_limit_exceeded", async () => {
  const small = await buildZip([{ name: "a", data: "a" }]);
  const dv = new DataView(small.buffer);
  const eocd = small.byteLength - 22;
  dv.setUint32(eocd + 12, 4 * MiB + 1, true);
  await rejectsWith(openZip({ bytes: small }), "archive_limit_exceeded");
  await rejectsWith(openZip({ bytes: await buildZip([{ name: "n".repeat(1025), data: "", method: 0 }]) }), "archive_limit_exceeded");
});

test("in-memory mode refuses archives over 10 MB", async () => {
  await rejectsWith(openZip({ bytes: new Uint8Array(10 * MiB + 1) }), "archive_limit_exceeded");
});

test("Zip64: end records and extras are parsed and still held to the absolute limits", async () => {
  const good = await openZip({ bytes: await buildZip([{ name: "z.txt", data: "zip64 ok", zip64: true }], { zip64Eocd: true }) });
  assert.equal(good.zip64, true);
  assert.equal(good.entries[0].zip64, true);
  assert.equal(text(await good.readEntry("z.txt")), "zip64 ok");

  const huge = await openZip({ bytes: await buildZip([{ name: "huge", data: "x", zip64: true, lie: { uncompressed: 2 ** 40 } }], { zip64Eocd: true }) });
  assert.equal(huge.entries[0].uncompressed_size, 2 ** 40);
  await rejectsWith(huge.readEntry("huge"), "archive_limit_exceeded");

  await rejectsWith(openZip({ bytes: await buildZip([{ name: "a", data: "a" }], { zip64Eocd: true, zip64Record: { entries: 2 ** 33 } }) }), "archive_limit_exceeded");
  await rejectsWith(openZip({ bytes: await buildZip([{ name: "a", data: "a" }], { zip64Eocd: true, zip64Record: { entries: 1, cdSize: 2 ** 62 } }) }), "archive_limit_exceeded");

  // Sentinel sizes without a Zip64 extra field are structural damage.
  const bytes = await buildZip([{ name: "a", data: "abc", method: 0 }]);
  const dv = new DataView(bytes.buffer);
  const cdOffset = dv.getUint32(bytes.byteLength - 22 + 16, true);
  dv.setUint32(cdOffset + 24, 0xffffffff, true);
  await rejectsWith(openZip({ bytes }), "archive_invalid");
});

test("truncated and corrupt archives are archive_invalid", async () => {
  const bytes = await buildZip([{ name: "a.txt", data: "hello hello hello hello" }]);
  await rejectsWith(openZip({ bytes: bytes.subarray(0, bytes.byteLength - 5) }), "archive_invalid");
  await rejectsWith(openZip({ bytes: bytes.subarray(0, 10) }), "archive_invalid");
  await rejectsWith(openZip({ bytes: new TextEncoder().encode("not a zip at all, just some text padding.....") }), "archive_invalid");

  const badCrc = await openZip({ bytes: await buildZip([{ name: "a", data: "abc", lie: { crc: 1 } }]) });
  await rejectsWith(badCrc.readEntry("a"), "archive_invalid");

  const garbage = await openZip({ bytes: await buildZip([{ name: "a", data: "abc", payload: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }]) });
  await rejectsWith(garbage.readEntry("a"), "archive_invalid");

  const short = await openZip({ bytes: await buildZip([{ name: "a", data: "abc", lie: { uncompressed: 10 } }]) });
  await rejectsWith(short.readEntry("a"), "archive_invalid");

  const storedMismatch = await openZip({ bytes: await buildZip([{ name: "a", data: "abc", method: 0, lie: { uncompressed: 2 } }]) });
  await rejectsWith(storedMismatch.readEntry("a"), "archive_invalid");

  const wrongOffset = await buildZip([{ name: "a", data: "abc" }]);
  const dv = new DataView(wrongOffset.buffer);
  dv.setUint32(wrongOffset.byteLength - 22 + 16, 3, true);
  await rejectsWith(openZip({ bytes: wrongOffset }), "archive_invalid");

  const dup = await openZip({ bytes: await buildZip([{ name: "d", data: "1" }, { name: "d", data: "2" }]) });
  await rejectsWith(dup.readEntry("d"), "archive_invalid");
  assert.equal(text(await dup.readEntry(1)), "2");
});
