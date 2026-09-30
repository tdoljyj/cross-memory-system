// StorageNormalUse.v0.1 N3 unit tests: signed upload URL, per-object chunked AEAD, magic denylist,
// extension <-> MIME binding and the post-staging (validating) checks. No network, no database.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { binaryUploadTarget, deniedMagic, firstChunkCheck, validateStagedContent, BINARY_EXTENSION_MIME }
  from "../../../kernel/host/resource-center-storage-binary.mjs";
import { buildZip } from "./resource-center-zip.fixture.mjs";
import { buildCfb, pngBytes, pdfBytes } from "./resource-center-storage-binary.fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "clued-storage-staging-"));
const output = path.join(directory, "storage-staging.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../worker/storage-staging.ts", import.meta.url))], outfile: output,
  bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const staging = await import(pathToFileURL(output));

const DOCX = BINARY_EXTENSION_MIME.docx;
const b64url = bytes => Buffer.from(bytes).toString("base64url");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const ids = () => ({ owner_id: randomUUID(), connection_id: randomUUID(), staging_id: randomUUID() });
const runtime = async (keys = { current_key_id: "k1", keys: { k1: b64url(Buffer.alloc(32, 3)) } }) => staging.createStagingRuntime({
  bucket: { put: async () => {}, get: async () => null, delete: async () => {} }, url_key: b64url(Buffer.alloc(32, 9)),
  staging_keys: JSON.stringify(keys), rpc: async () => ({}) });

test("signed upload URL: exact claims, path binding, expiry, and tamper refusal", async () => {
  const rt = await runtime();
  const claims = { ...ids(), binding_id: randomUUID(), sha256: "a".repeat(64), size: 1234, mime_type: "image/png", exp: Math.floor(Date.now() / 1000) + 600 };
  const token = await staging.signUploadToken(rt.url_key, claims);
  assert.deepEqual(await staging.verifyUploadToken(rt.url_key, token, claims.staging_id, Date.now()), claims);
  const refused = async (value, id = claims.staging_id, now = Date.now(), code = "upload_url_invalid") =>
    assert.rejects(staging.verifyUploadToken(rt.url_key, value, id, now), e => e.code === code);
  await refused(token, randomUUID());
  await refused(token, claims.staging_id, (claims.exp + 1) * 1000, "staging_expired");
  const [payload, signature] = token.split(".");
  const forged = b64url(Buffer.from(JSON.stringify(["clued.storage-staging-url/1", claims.owner_id, claims.connection_id, claims.binding_id,
    claims.staging_id, claims.sha256, 20 * 1024 * 1024, claims.mime_type, claims.exp])));
  await refused(`${forged}.${signature}`);
  await refused(`${payload}.${b64url(Buffer.alloc(32))}`);
  await refused(`${payload}.${signature}.x`);
  await refused(undefined);
  const other = await staging.createStagingRuntime({ bucket: { put() {}, get() {}, delete() {} }, url_key: b64url(Buffer.alloc(32, 1)),
    staging_keys: JSON.stringify({ current_key_id: "k1", keys: { k1: b64url(Buffer.alloc(32, 3)) } }), rpc: async () => ({}) });
  await assert.rejects(staging.verifyUploadToken(other.url_key, token, claims.staging_id, Date.now()), e => e.code === "upload_url_invalid");
});

test("configuration fails closed without the bucket, the URL key or a well-formed keyring", async () => {
  const good = { bucket: { put() {}, get() {}, delete() {} }, url_key: b64url(Buffer.alloc(32, 9)),
    staging_keys: JSON.stringify({ current_key_id: "k1", keys: { k1: b64url(Buffer.alloc(32, 3)) } }), rpc: async () => ({}) };
  await staging.createStagingRuntime(good);
  for (const bad of [{ bucket: undefined }, { url_key: undefined }, { url_key: "short" }, { staging_keys: undefined },
    { staging_keys: "{" }, { staging_keys: JSON.stringify({ current_key_id: "k2", keys: { k1: b64url(Buffer.alloc(32)) } }) },
    { staging_keys: JSON.stringify({ current_key_id: "k1", keys: { k1: b64url(Buffer.alloc(16)) } }) }]) {
    await assert.rejects(staging.createStagingRuntime({ ...good, ...bad }), e => e.code === "storage_upload_unavailable");
  }
});

test("chunked AEAD: per-object HKDF key, counter nonce, AAD binds position, finality and identity", async () => {
  const rt = await runtime(); const master = rt.keyring.keys.get("k1"); const context = ids();
  const size = 3 * staging.STAGING_CHUNK + 17, plain = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
  const key = await staging.stagingObjectKeyMaterial(master, context.staging_id);
  const count = staging.stagingChunkCount(size); assert.equal(count, 4);
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push(await staging.encryptStagingChunk(key, context, i, i === count - 1,
    plain.subarray(i * staging.STAGING_CHUNK, Math.min(size, (i + 1) * staging.STAGING_CHUNK))));
  const joined = Buffer.concat(chunks);
  assert.equal(joined.length, staging.stagingObjectSize(size));
  assert.deepEqual(Buffer.from(await staging.decryptStagingObject(key, context, joined, size, sha(plain))), Buffer.from(plain));
  const fails = (bytes, ctx = context, k = key, s = size, digest = sha(plain)) =>
    assert.rejects(staging.decryptStagingObject(k, ctx, bytes, s, digest), e => e.code === "storage_upload_unavailable");
  // Truncation: drop the final chunk and claim the shorter size; the new last chunk was not sealed final.
  await fails(Buffer.concat(chunks.slice(0, 3)), context, key, 3 * staging.STAGING_CHUNK, sha(plain.subarray(0, 3 * staging.STAGING_CHUNK)));
  await fails(Buffer.concat([chunks[1], chunks[0], chunks[2], chunks[3]]));
  const flipped = Buffer.from(joined); flipped[5] ^= 1; await fails(flipped);
  await fails(joined, { ...context, connection_id: randomUUID() });
  await fails(joined, { ...context, owner_id: randomUUID() });
  // Another staging_id derives another key (HKDF salt) even under the same master.
  await fails(joined, context, await staging.stagingObjectKeyMaterial(master, randomUUID()));
  await fails(joined, context, key, size, "0".repeat(64));
  // The nonce is a big-endian chunk counter: the same chunk sealed at index 0 and 1 differs.
  const a = await staging.encryptStagingChunk(key, context, 0, false, new Uint8Array(8));
  const b = await staging.encryptStagingChunk(key, context, 1, false, new Uint8Array(8));
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
});

test("first-chunk denylist refuses executables and scripts whatever the declared type", () => {
  const cases = [[0x4d, 0x5a], [0x7f, 0x45, 0x4c, 0x46], [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0x23, 0x21]];
  for (const prefix of cases) {
    const bytes = new Uint8Array([...prefix, ...new Uint8Array(64)]);
    assert.equal(deniedMagic(bytes), true, prefix.join(","));
    for (const mime of ["image/png", "application/pdf", "application/zip"]) assert.throws(() => firstChunkCheck(bytes, mime), /content_type_mismatch/);
  }
  assert.equal(firstChunkCheck(pngBytes(), "image/png"), "png");
  assert.equal(firstChunkCheck(pdfBytes(), "application/pdf"), "pdf");
  assert.throws(() => firstChunkCheck(pngBytes(), "application/pdf"), /content_type_mismatch/);
  assert.throws(() => firstChunkCheck(pdfBytes(), "image/jpeg"), /content_type_mismatch/);
  assert.throws(() => firstChunkCheck(new Uint8Array([0xff, 0xd8]), "image/jpeg"), /content_type_mismatch/);
});

test("extension <-> MIME binding and exclusions (macro, HTML/SVG, Google native, executables)", () => {
  assert.equal(binaryUploadTarget("/root/a/photo.PNG", "image/png").ok, true);
  assert.equal(binaryUploadTarget("/root/a/photo.jpeg", "image/jpeg").ok, true);
  assert.equal(binaryUploadTarget("/root/a/report.docx", DOCX).ok, true);
  for (const [p, m] of [["/root/a/photo.png", "image/jpeg"], ["/root/a/photo", "image/png"], ["/root/a/.png", "image/png"],
    ["/root/a/report.docm", "application/vnd.ms-word.document.macroEnabled.12"], ["/root/a/sheet.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
    ["/root/a/page.html", "text/html"], ["/root/a/logo.svg", "image/svg+xml"], ["/root/a/page.xhtml", "application/xhtml+xml"],
    ["/root/a/doc.gdoc", "application/vnd.google-apps.document"], ["/root/a/tool.exe", "application/x-msdownload"],
    ["/root/a/run.sh", "application/x-sh"], ["/root/a/notes.txt", "text/plain"], ["/root/a/report.docx", "application/zip"]]) {
    assert.deepEqual(binaryUploadTarget(p, m), { ok: false, code: "content_type_mismatch" }, `${p} ${m}`);
  }
});

test("validating stage: zip/OOXML/ODF macros and CFB VBA storages are refused; clean files pass", async () => {
  const types = '<?xml version="1.0"?><Types><Default Extension="xml" ContentType="application/xml"/></Types>';
  const clean = await buildZip([{ name: "[Content_Types].xml", data: types }, { name: "word/document.xml", data: "<w:document/>" }]);
  assert.equal(await validateStagedContent(clean, DOCX), true);
  assert.equal(await validateStagedContent(clean, "application/zip"), true);
  for (const archive of [
    await buildZip([{ name: "[Content_Types].xml", data: types }, { name: "word/vbaProject.bin", data: "vba" }]),
    await buildZip([{ name: "[Content_Types].xml", data: types }, { name: "xl\\VBAPROJECT.BIN", data: "vba", method: 0 }]),
    await buildZip([{ name: "[Content_Types].xml", data: types.replace("application/xml", "application/vnd.ms-word.document.macroEnabled.main+xml") }]),
    await buildZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 }, { name: "Basic/Standard/Module1.xml", data: "x" }]),
    await buildZip([{ name: "[Content_Types].xml", data: types, lie: { flags: 0x0801 } }]),
  ]) {
    await assert.rejects(validateStagedContent(archive, DOCX), /content_type_mismatch/);
  }
  // A truncated archive (no central directory) is refused, not skipped.
  await assert.rejects(validateStagedContent(clean.subarray(0, clean.length - 30), "application/zip"), /content_type_mismatch/);
  assert.equal(await validateStagedContent(buildCfb(["WordDocument", 2]), "application/msword"), true);
  for (const name of ["VBA", "Macros", "_VBA_PROJECT_CUR", "vba"]) {
    await assert.rejects(validateStagedContent(buildCfb([name, 1]), "application/msword"), /content_type_mismatch/, name);
  }
  // A stream (not a storage) of that name is not a macro project.
  assert.equal(await validateStagedContent(buildCfb(["Macros", 2]), "application/vnd.ms-excel"), true);
  const loop = buildCfb(["WordDocument", 2]); new DataView(loop.buffer).setUint32(512 + 4, 1, true); // directory chain points to itself
  await assert.rejects(validateStagedContent(loop, "application/msword"), /content_type_mismatch/);
  assert.equal(await validateStagedContent(pngBytes(), "image/png"), true);
});

test("inline content_base64 decoding is strict", () => {
  assert.deepEqual([...staging.decodeContentBase64(Buffer.from([1, 2, 3, 250]).toString("base64"))], [1, 2, 3, 250]);
  for (const bad of ["", "abc", "ab=c", "a-b_", 5, null, "YWJj\n"]) assert.throws(() => staging.decodeContentBase64(bad), e => e.code === "storage_job_input_invalid");
});
