// StorageNormalUse.v0.1 N3 §6.4: binary create effect (multipart <= 5 MiB, one resumable
// session above) and the create-verified/3 verifier, against a synthetic Drive. No network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoogleDriveNativeCreateEffect } from "../../../kernel/host/resource-center-google-drive-create-effect.mjs";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";
import { parseMultipart, pngBytes, pdfBytes, sha256Hex } from "./resource-center-storage-binary.fixture.mjs";

const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const profile = { profile_id: "binary-test", profile_version: "test/1", managed_root: "G:/test/Clued_资料中心" };
const provider = { root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
  destination_parent_id: "track", destination_parent_version: "1", destination_file_id: null, destination_file_version: null };
const intent = "10000000-0000-4000-8000-000000000002";
const STAGING = "50000000-0000-4000-8000-000000000002";
const ref = (bytes, mime = "image/png") => ({ staging_id: STAGING, sha256: sha256Hex(bytes), size: bytes.length, mime_type: mime });

function fixture(bytes, options = {}) {
  const { mime = "image/png", name = "photo.png", drive = {} } = options;
  const content = "content" in options ? options.content : bytes;
  const mutation = { operation: "create", destination_path: profile.managed_root + "/20_P_产品与体验/" + name, target_kind: "file",
    content_ref: ref(bytes, mime), artifact_role: "clued_resource" };
  const binding = { profile_id: profile.profile_id, operation: "create", destination_path: mutation.destination_path,
    request_sha256: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") };
  const calls = [];
  let attempt, consumed = false;
  const effect = createGoogleDriveNativeCreateEffect({ trusted_profile: profile, content_bytes: content,
    get_credential: async () => ({ access_token: "binary-test-access-token", scope: SCOPE }),
    resolve_provider_identity: async () => ({ ...provider }),
    consume_started_provider: () => consumed ? null : (consumed = true, { intent_id: intent, request_sha256: binding.request_sha256, provider }),
    persist_provider_attempt: async value => { calls.push("persist"); attempt = value; },
    fetch: async (url, init) => {
      assert.equal(init.redirect, "error");
      const u = new URL(url);
      if (u.pathname.endsWith("/generateIds")) { calls.push("generate"); return Response.json({ ids: ["generated-id"] }); }
      assert.equal(calls.at(-1) === "persist" || calls.at(-1) === "session", true, "attempt is durable before any upload request");
      if (init.method === "POST" && u.searchParams.get("uploadType") === "multipart") {
        calls.push("multipart");
        const part = parseMultipart(init.body, new Headers(init.headers).get("content-type"));
        drive.received = part;
        if (drive.lose) throw new Error("synthetic lost reply");
        return Response.json({ id: part.metadata.id, name: part.metadata.name, parents: part.metadata.parents, mimeType: part.mediaType, version: "1", trashed: false });
      }
      if (init.method === "POST" && u.searchParams.get("uploadType") === "resumable") {
        calls.push("session");
        const h = new Headers(init.headers);
        drive.metadata = JSON.parse(init.body);
        assert.equal(h.get("x-upload-content-type"), mime); assert.equal(h.get("x-upload-content-length"), String(bytes.length));
        return new Response("", { status: 200, headers: { location: drive.location ?? "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION_1" } });
      }
      if (init.method === "PUT") {
        calls.push("put");
        assert.equal(url, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION_1");
        assert.equal(new Headers(init.headers).get("content-type"), mime);
        drive.received = { bytes: Buffer.from(init.body), mediaType: mime, metadata: drive.metadata };
        if (drive.lose) throw new Error("synthetic lost reply");
        return Response.json({ id: drive.metadata.id, name: drive.metadata.name, parents: drive.metadata.parents, mimeType: mime, version: "1", trashed: false });
      }
      throw new Error("unexpected request " + init.method + " " + url);
    } });
  return { effect, calls, attempt: () => attempt, request: { mutation, admission: { binding, expires_at_ms: Date.now() + 60000 }, profile_identity: profile } };
}

test("binary up to 5 MiB: one multipart POST with the requested MIME and exact bytes", async () => {
  const bytes = pngBytes(5 * 1024 * 1024);
  const drive = {};
  const f = fixture(bytes, { drive });
  const result = await f.effect(f.request);
  assert.equal(result.provider_file_id, "generated-id");
  assert.deepEqual(f.calls, ["generate", "persist", "multipart"]);
  assert.equal(drive.received.mediaType, "image/png");
  assert.equal(drive.received.metadata.mimeType, "image/png");
  assert.equal(drive.received.metadata.appProperties.clued_intent_id, intent);
  assert.equal(Buffer.compare(drive.received.bytes, Buffer.from(bytes)), 0);
  assert.equal(f.attempt().size, String(bytes.length)); assert.equal(f.attempt().sha256, sha256Hex(bytes));
});

test("above 5 MiB: one resumable session, the whole body in a single PUT, session URI never returned", async () => {
  const bytes = pdfBytes(5 * 1024 * 1024 + 1);
  const drive = {};
  const f = fixture(bytes, { mime: "application/pdf", name: "report.pdf", drive });
  const result = await f.effect(f.request);
  assert.deepEqual(f.calls, ["generate", "persist", "session", "put"]);
  assert.equal(drive.metadata.id, "generated-id"); assert.equal(drive.metadata.mimeType, "application/pdf");
  assert.equal(Buffer.compare(drive.received.bytes, Buffer.from(bytes)), 0);
  assert.equal(JSON.stringify(result).includes("SESSION_1"), false);
  assert.equal(JSON.stringify(f.attempt()).includes("SESSION_1"), false);
});

test("a lost reply is an unknown outcome and is never retried; a foreign session host is refused before bytes", async () => {
  for (const size of [1024, 6 * 1024 * 1024]) {
    const bytes = pngBytes(size), drive = { lose: true };
    const f = fixture(bytes, { drive });
    await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN/);
    assert.equal(f.calls.filter(c => c === "multipart" || c === "put").length, 1, "exactly one upload request");
    await assert.rejects(f.effect(f.request), /DURABLE_START_REQUIRED/, "the same admission cannot upload again");
  }
  const drive = { location: "https://evil.example/upload?uploadType=resumable&upload_id=x" };
  const f = fixture(pngBytes(6 * 1024 * 1024), { drive });
  await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN/);
  assert.equal(f.calls.includes("put"), false);
});

test("staged bytes that differ from the content reference are refused before any provider request", async () => {
  const bytes = pngBytes(4096), other = Buffer.from(bytes); other[100] ^= 1;
  const f = fixture(bytes, { content: new Uint8Array(other) });
  await assert.rejects(f.effect(f.request), /STORAGE_CONTENT_STAGING_MISMATCH/);
  assert.deepEqual(f.calls, []);
  const missing = fixture(bytes, { content: undefined });
  await assert.rejects(missing.effect(missing.request), /DRIVE_NATIVE_REQUEST_MISMATCH/);
});

function verifierFixture(file, { bytes = pngBytes(2048), mime = "image/png" } = {}) {
  const destination = profile.managed_root + "/20_P_产品与体验/photo.png";
  const nodes = { root: { id: "root", name: "Clued_资料中心", parents: ["container"], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" },
    track: { id: "track", name: "20_P_产品与体验", parents: ["root"], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" },
    "generated-id": { id: "generated-id", name: "photo.png", parents: ["track"], version: "3", trashed: false, mimeType: mime,
      size: String(bytes.length), sha256Checksum: sha256Hex(bytes), ...file } };
  const trackVersions = createHash("sha256").update(JSON.stringify([["root", "1"], ["track", "1"]])).digest("hex");
  const verify = createGoogleDriveCreatePostconditionVerifier({ managed_root: profile.managed_root, root_folder_id: "root", root_parent_id: "container",
    get_file: async id => nodes[id], list_children: async ({ parent_id, name }) => Object.values(nodes).filter(n => n.parents[0] === parent_id && n.name === name),
    require_effect_provider_id: true, include_verified_proof: true, timeout_ms: 20, poll_ms: 5, sleep: async () => {} });
  const mutation = { operation: "create", destination_path: destination, target_kind: "file", content_ref: ref(bytes, mime), artifact_role: "clued_resource" };
  return () => verify({ profile, mutation, provider_before: { ...provider, provider_version: trackVersions },
    effect_result: { operation: "create", destination_path: destination, provider_file_id: "generated-id" } });
}

test("create-verified/3: size, sha256 and MIME from the content reference; Drive sha256Checksum must match", async () => {
  const bytes = pngBytes(2048);
  const { verified_proof: proof, ...post } = await verifierFixture({}, { bytes })();
  assert.equal(proof.contract, "clued.storage-create-verified/3");
  assert.equal(proof.mime_type, "image/png"); assert.equal(proof.sha256, sha256Hex(bytes)); assert.equal(proof.size, "2048");
  assert.equal(proof.checks.sha256_checksum, true); assert.equal(post.provider_file_id, "generated-id");
  await assert.rejects(verifierFixture({ sha256Checksum: "0".repeat(64) })(), /DRIVE_POSTCONDITION_CONTENT_MISMATCH/);
  await assert.rejects(verifierFixture({ size: "2049" })(), /DRIVE_POSTCONDITION_CONTENT_MISMATCH/);
  await assert.rejects(verifierFixture({ mimeType: "application/pdf" })(), /DRIVE_POSTCONDITION_IDENTITY_MISMATCH/);
  // No checksum ever published: never verified (the job stays fenced for recovery / attention).
  await assert.rejects(verifierFixture({ sha256Checksum: undefined })(), /DRIVE_POSTCONDITION_SYNC_TIMEOUT/);
});
