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
import { memoryBucket, pngBytes, pdfBytes } from "./resource-center-storage-binary.fixture.mjs";

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
  // Canonical base64url only: the last signature character's unused low bits must be zero, and
  // the payload must re-encode to itself (no alternative spellings of the same bytes).
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(signature.at(-1));
  await refused(`${payload}.${signature.slice(0, -1)}${alphabet[last ^ 1]}`);
  await refused(`${payload}=.${signature}`);
  await refused(`${payload}.${signature}=`);
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
  const open = (bytes, ctx = context, k = key, s = size, digest = sha(plain)) => {
    const bucket = memoryBucket(); bucket.objects.set("staging/" + context.staging_id, Buffer.from(bytes));
    return staging.openStagedObject(bucket, context.staging_id, k, { ...ctx, staging_id: context.staging_id }, s, digest);
  };
  const opened = open(joined);
  await opened.verify(); assert.equal(opened.verified, true);
  assert.deepEqual(Buffer.from(await new Response(open(joined).stream()).arrayBuffer()), Buffer.from(plain));
  assert.deepEqual(Buffer.from(await opened.readRange(staging.STAGING_CHUNK - 5, 70000)), Buffer.from(plain.subarray(staging.STAGING_CHUNK - 5, staging.STAGING_CHUNK + 69995)));
  const fails = (bytes, ctx = context, k = key, s = size, digest = sha(plain)) =>
    assert.rejects(open(bytes, ctx, k, s, digest).verify(), e => e.code === "storage_upload_unavailable");
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
    ["/root/a/run.sh", "application/x-sh"], ["/root/a/notes.txt", "text/plain"], ["/root/a/report.docx", "application/zip"],
    // Legacy Office (CFB) is not accepted at all.
    ["/root/a/old.doc", "application/msword"], ["/root/a/old.xls", "application/vnd.ms-excel"], ["/root/a/old.ppt", "application/vnd.ms-powerpoint"]]) {
    assert.deepEqual(binaryUploadTarget(p, m), { ok: false, code: "content_type_mismatch" }, `${p} ${m}`);
  }
  assert.equal(Object.hasOwn(BINARY_EXTENSION_MIME, "doc") || Object.hasOwn(BINARY_EXTENSION_MIME, "xls") || Object.hasOwn(BINARY_EXTENSION_MIME, "ppt"), false);
  // CFB bytes never pass the first-chunk check for any accepted type.
  const cfb = new Uint8Array(512); cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  for (const mime of Object.values(BINARY_EXTENSION_MIME)) assert.throws(() => firstChunkCheck(cfb, mime), /content_type_mismatch/, mime);
});

const TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const docRels = (extra = "") => '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  // A hyperlink whose URL mentions ActiveX and carries &amp; is data, not a macro relationship.
  '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/activex?a=1&amp;b=2" TargetMode="External"/>' +
  extra + "</Relationships>";
const docx = (parts = {}) => buildZip(Object.entries({ "[Content_Types].xml": TYPES, "_rels/.rels": ROOT_RELS, "word/document.xml": "<w:document/>",
  "word/_rels/document.xml.rels": docRels(), ...parts }).filter(([, data]) => data !== null).map(([name, data]) => ({ name, data })));
const utf16 = (text, bom = true) => { const body = Buffer.from(text, "utf16le"); return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body); };

test("validating stage: zip/OOXML/ODF macro parts, content types and relationships are refused; clean files pass", async () => {
  const clean = await docx();
  assert.equal(await validateStagedContent(clean, DOCX), true);
  assert.equal(await validateStagedContent(clean, "application/zip"), true);
  assert.equal(await validateStagedContent(await docx({ "[Content_Types].xml": "﻿" + TYPES }), DOCX), true, "UTF-8 BOM is fine");
  const vbaType = "application/vnd.ms-office.vbaProject";
  const refused = {
    "vbaProject.bin part": await docx({ "word/vbaProject.bin": "vba" }),
    "VBAPROJECT.BIN with a backslash": await docx({ "xl\\VBAPROJECT.BIN": "vba" }),
    "macroEnabled main type": await docx({ "[Content_Types].xml": TYPES.replace("document.main+xml", "document.macroEnabled.main+xml").replace("openxmlformats-officedocument.wordprocessingml", "ms-word") }),
    "renamed VBA part by Override": await docx({ "word/notes.dat": "vba",
      "[Content_Types].xml": TYPES.replace("</Types>", `<Override PartName="/word/notes.dat" ContentType="${vbaType}"/></Types>`) }),
    "renamed VBA part by Default extension": await docx({ "word/notes.dat": "vba",
      "[Content_Types].xml": TYPES.replace("</Types>", `<Default Extension="dat" ContentType="${vbaType}"/></Types>`) }),
    "vbaProject relationship": await docx({ "word/_rels/document.xml.rels": docRels('<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="notes.dat"/>') }),
    "wordVbaData relationship": await docx({ "word/_rels/document.xml.rels": docRels('<Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2006/relationships/wordVbaData" Target="vbaData.xml"/>') }),
    "activeX content type": await docx({ "[Content_Types].xml": TYPES.replace("</Types>", '<Default Extension="bin" ContentType="application/vnd.ms-office.activeX"/></Types>') }),
    "activeX relationship in a sub-part": await docx({ "word/activeX/_rels/activeX1.xml.rels": docRels('<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/activeXControlBinary" Target="x.bin"/>') }),
    "Excel 4 macro sheet": await docx({ "[Content_Types].xml": TYPES.replace("</Types>", '<Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>') }),
    "&#x45; obfuscation": await docx({ "[Content_Types].xml": TYPES.replace("document.main+xml", "document.macro&#x45;nabled.main+xml") }),
    "decimal character reference": await docx({ "[Content_Types].xml": TYPES.replace(`"/></Types>`, `"/><Override PartName="/x.dat" ContentType="application/vnd.ms-office.vba&#80;roject"/></Types>`) }),
    "character reference in a relationship": await docx({ "word/_rels/document.xml.rels": docRels('<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2006/relationships/vba&#x50;roject" Target="a.bin"/>') }),
    "custom entity": await docx({ "[Content_Types].xml": '<?xml version="1.0"?><!DOCTYPE Types [<!ENTITY m "macroEnabled">]>' + TYPES.slice(TYPES.indexOf("<Types")) }),
    "undeclared entity": await docx({ "[Content_Types].xml": TYPES.replace("application/xml", "application/&x;xml") }),
    "bare ampersand": await docx({ "[Content_Types].xml": TYPES.replace("application/xml", "application/a&b") }),
    "UTF-16 content types (BOM)": await docx({ "[Content_Types].xml": utf16(TYPES.replace("UTF-8", "UTF-16")) }),
    "UTF-16 content types (no BOM)": await docx({ "[Content_Types].xml": utf16(TYPES, false) }),
    "UTF-16 relationships": await docx({ "word/_rels/document.xml.rels": utf16(docRels()) }),
    "declared non-UTF-8 encoding": await docx({ "[Content_Types].xml": TYPES.replace("UTF-8", "ISO-8859-1") }),
    "invalid UTF-8": await docx({ "[Content_Types].xml": Buffer.concat([Buffer.from(TYPES.slice(0, 60)), Buffer.from([0xc3, 0x28]), Buffer.from(TYPES.slice(60))]) }),
    "missing content types": await docx({ "[Content_Types].xml": null }),
    "duplicate content types": await buildZip([{ name: "[Content_Types].xml", data: TYPES }, { name: "[content_types].xml", data: TYPES }]),
    "ODF Basic folder": await buildZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 }, { name: "Basic/Standard/Module1.xml", data: "x" }]),
    "encrypted content types": await buildZip([{ name: "[Content_Types].xml", data: TYPES, lie: { flags: 0x0801 } }]),
  };
  for (const [label, archive] of Object.entries(refused)) {
    await assert.rejects(validateStagedContent(archive, DOCX), /content_type_mismatch/, label);
  }
  // A truncated archive (no central directory) is refused, not skipped.
  await assert.rejects(validateStagedContent(clean.subarray(0, clean.length - 30), "application/zip"), /content_type_mismatch/);
  assert.equal(await validateStagedContent(pngBytes(), "image/png"), true);
});

test("bounded memory: staging, validation and execution touch the object only in ranged windows", async () => {
  const bucket = memoryBucket(), calls = [];
  const rt = await staging.createStagingRuntime({ bucket, url_key: b64url(Buffer.alloc(32, 9)),
    staging_keys: JSON.stringify({ current_key_id: "k1", keys: { k1: b64url(Buffer.alloc(32, 3)) } }),
    rpc: async input => {
      calls.push(input.action + ":" + (input.outcome ?? ""));
      if (input.action === "receive") return { staging_id: input.staging_id, owner_id: input.owner_id, connection_id: input.connection_id,
        size: input.size, sha256: input.sha256, mime_type: input.mime_type, key_id: input.key_id, state: "receiving" };
      return { staging_id: input.staging_id, state: input.outcome };
    } });
  // A 6 MiB docx: a clean package plus one large stored media part.
  const archive = await buildZip([{ name: "[Content_Types].xml", data: TYPES }, { name: "_rels/.rels", data: ROOT_RELS },
    { name: "word/document.xml", data: "<w:document/>" }, { name: "word/_rels/document.xml.rels", data: docRels() },
    { name: "word/media/image1.png", data: pngBytes(6 * 1024 * 1024), method: 0 }]);
  const context = ids();
  const claims = { ...context, binding_id: randomUUID(), sha256: sha(archive), size: archive.length, mime_type: DOCX, exp: Math.floor(Date.now() / 1000) + 600 };
  let at = 0;
  const body = new ReadableStream({ pull(controller) {
    if (at >= archive.length) return controller.close();
    controller.enqueue(archive.slice(at, at + 100000)); at += 100000;
  } });
  const stored = await staging.receiveStaged(rt, claims, body);
  assert.equal(stored.state, "ready");
  assert.deepEqual(calls, ["receive:", "received:validating", "validated:ready"]);
  const windowBytes = staging.STAGING_WINDOW_CHUNKS * (staging.STAGING_CHUNK + 16);
  assert.equal(bucket.wholeReads, 0, "validation never reads the whole object");
  assert.ok(bucket.maxReadBytes <= windowBytes, `largest R2 read ${bucket.maxReadBytes} <= ${windowBytes}`);
  assert.ok(bucket.reads >= staging.stagingChunkCount(archive.length) / staging.STAGING_WINDOW_CHUNKS, "the verify pass walks every window");

  // Executor: a full verify pass, then a stream of chunk-sized pieces, all by range.
  bucket.reads = 0; bucket.maxReadBytes = 0;
  const ref = { staging_id: context.staging_id, sha256: claims.sha256, size: claims.size, mime_type: DOCX };
  const load = () => staging.loadStagedContent(rt, { owner_id: context.owner_id, connection_id: context.connection_id,
    staging: { staging_id: context.staging_id, key_id: "k1", size: claims.size, sha256: claims.sha256 }, content_ref: ref });
  const content = await load();
  assert.equal(content.verified, false);
  await content.verify();
  assert.equal(content.verified, true);
  const reader = content.stream().getReader(), digest = createHash("sha256");
  let total = 0, largest = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    digest.update(value); total += value.byteLength; largest = Math.max(largest, value.byteLength);
  }
  assert.equal(total, archive.length); assert.equal(digest.digest("hex"), claims.sha256);
  assert.ok(largest <= staging.STAGING_CHUNK, "stream pieces are single chunks");
  assert.equal(bucket.wholeReads, 0);
  assert.ok(bucket.maxReadBytes <= windowBytes, `largest R2 read ${bucket.maxReadBytes} <= ${windowBytes}`);

  // A stored object whose bytes decrypt but no longer match the declared digest (simulated by a
  // wrong declared sha256): verify refuses, and the stream errors before its final window.
  const wrong = staging.openStagedObject(bucket, context.staging_id,
    await staging.stagingObjectKeyMaterial(rt.keyring.keys.get("k1"), context.staging_id), context, claims.size, "0".repeat(64));
  await assert.rejects(wrong.verify(), e => e.code === "storage_upload_unavailable");
  const wrongReader = wrong.stream().getReader();
  let delivered = 0, failed = false;
  try { for (;;) { const { done, value } = await wrongReader.read(); if (done) break; delivered += value.byteLength; } }
  catch { failed = true; }
  assert.equal(failed, true);
  const lastWindow = claims.size - Math.floor((staging.stagingChunkCount(claims.size) - 1) / staging.STAGING_WINDOW_CHUNKS) * staging.STAGING_WINDOW_CHUNKS * staging.STAGING_CHUNK;
  assert.equal(delivered, claims.size - lastWindow, "the final window is withheld");
  // A tampered ciphertext byte fails authentication in the pass that reaches it.
  const object = bucket.objects.get("staging/" + context.staging_id); object[object.length - 3] ^= 1;
  await assert.rejects((await load()).verify(), e => e.code === "storage_upload_unavailable");
});

test("inline content_base64 decoding is strict", () => {
  assert.deepEqual([...staging.decodeContentBase64(Buffer.from([1, 2, 3, 250]).toString("base64"))], [1, 2, 3, 250]);
  for (const bad of ["", "abc", "ab=c", "a-b_", 5, null, "YWJj\n"]) assert.throws(() => staging.decodeContentBase64(bad), e => e.code === "storage_job_input_invalid");
});
