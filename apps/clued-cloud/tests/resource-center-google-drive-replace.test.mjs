import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contentAfter, createGoogleDriveNativeReplaceEffect, md5Hex, replaceShape, sha256Hex } from "../../../kernel/host/resource-center-google-drive-replace-effect.mjs";
import { createGoogleDriveReplacePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-replace-postcondition.mjs";

// StorageFullCapability.v0.1 P4: the Drive replace effect and verifier,
// against an in-memory Drive with revisions. Never Google.
const ROOT = "G:/test/Clued_资料中心", TRACK = ROOT + "/20_P_产品与体验";
const profile = { profile_id: "replace-test", profile_version: "test/1", managed_root: ROOT };
const intent = "10000000-0000-4000-8000-000000000001", restoreJob = "10000000-0000-4000-8000-000000000002";
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const OLD = Buffer.from("old text\n"), NEW = Buffer.from("new text\n");
const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });
const CONTENT_BEFORE = Object.freeze({ size: String(OLD.byteLength), sha256: sha256Hex(OLD), md5: md5Hex(OLD), head_revision_id: "rev-1" });

function drive() {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root")],
    ["file", { id: "file", name: "a.txt", parents: ["track"], version: "5", trashed: false, mimeType: "text/plain",
      size: String(OLD.byteLength), sha256Checksum: sha256Hex(OLD), md5Checksum: md5Hex(OLD), headRevisionId: "rev-1" }]]);
  const revisions = new Map([["rev-0", { id: "rev-0", keepForever: true, size: "3", md5Checksum: "0".repeat(32) }],
    ["rev-1", { id: "rev-1", keepForever: false, size: String(OLD.byteLength), md5Checksum: md5Hex(OLD) }]]);
  return { files, revisions, getFile: async id => structuredClone(files.get(id)),
    getRevision: async (_file, id) => structuredClone(revisions.get(id) ?? null),
    listChildren: async ({ parent_id, name }) => [...files.values()].filter(f => f.parents.includes(parent_id) && f.name === name).map(f => structuredClone(f)) };
}
const before = () => ({ root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
  source_file_id: null, source_file_version: null, destination_parent_id: "track", destination_parent_version: "1",
  destination_file_id: "file", destination_file_version: "5", provider_version: "a".repeat(64) });
const contentMutation = { operation: "replace", target_kind: "file", destination_path: TRACK + "/a.txt", destination_file_version: "5",
  content: NEW.toString("utf8"), artifact_role: "clued_resource" };
const restoreMutation = { operation: "replace", target_kind: "file", destination_path: TRACK + "/a.txt", destination_file_version: "5",
  restore_job_id: restoreJob, artifact_role: "clued_resource" };

function upload(d, bytes) {
  const file = d.files.get("file"), head = `rev-${Number(file.headRevisionId.slice(4)) + 1}`;
  d.revisions.set(head, { id: head, keepForever: false, size: String(bytes.byteLength), md5Checksum: md5Hex(bytes) });
  Object.assign(file, { version: String(Number(file.version) + 2), headRevisionId: head, size: String(bytes.byteLength),
    sha256Checksum: sha256Hex(bytes), md5Checksum: md5Hex(bytes) });
  return file;
}

function effectFixture(mutation = contentMutation, d = drive(), overrides = {}) {
  const events = [];
  const binding = { profile_id: profile.profile_id, request_sha256: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") };
  let consumed = false, attempt;
  const effect = createGoogleDriveNativeReplaceEffect({ trusted_profile: profile, get_file: d.getFile, get_revision: d.getRevision,
    get_credential: async () => ({ access_token: "replace-test-access-token", scope: SCOPE }),
    resolve_provider_identity: async () => before(),
    consume_started_provider: () => consumed ? null : (consumed = true, { intent_id: intent, request_sha256: binding.request_sha256, provider: before() }),
    persist_provider_attempt: async value => { events.push("persist"); attempt = value; },
    replacement: NEW, release_revision_ids: ["rev-0"],
    fetch: async (url, options) => {
      assert.equal(options.method, "PATCH"); assert.equal(options.redirect, "error");
      assert.ok(events.includes("persist"), "the attempt is durable before the first provider write");
      const u = new URL(url), parts = u.pathname.split("/");
      if (parts.at(-2) === "revisions") {
        const body = JSON.parse(options.body), revision = d.revisions.get(decodeURIComponent(parts.at(-1)));
        events.push(`keep:${revision.id}:${body.keepForever}`);
        revision.keepForever = body.keepForever;
        return Response.json({ id: revision.id, keepForever: revision.keepForever });
      }
      assert.equal(u.pathname, "/upload/drive/v3/files/file"); assert.equal(u.searchParams.get("uploadType"), "media");
      assert.equal(options.headers["content-type"], "text/plain");
      events.push("upload");
      return Response.json(upload(d, Buffer.from(options.body)));
    }, ...overrides });
  return { effect, events, d, attempt: () => attempt,
    request: { mutation, admission: { binding, expires_at_ms: Date.now() + 30000 }, profile_identity: profile } };
}

test("replaceShape accepts one file with a version and exactly one of content or restore_job_id", () => {
  assert.ok(replaceShape(contentMutation)); assert.equal(replaceShape(restoreMutation).restore_job_id, restoreJob);
  for (const bad of [{ ...contentMutation, restore_job_id: restoreJob }, { ...contentMutation, content: undefined },
    { ...contentMutation, destination_file_version: "0" }, { ...contentMutation, target_kind: "directory" },
    { ...contentMutation, source_path: TRACK + "/b.txt" }, { ...contentMutation, directory_semantics: "topic" },
    { ...contentMutation, content: "字".repeat(350000) }, { ...restoreMutation, restore_job_id: "nope" },
    { ...contentMutation, operation: "rename" }, { ...contentMutation, destination_path: TRACK + "/../a.txt" }]) {
    assert.equal(replaceShape(bad), null, JSON.stringify(bad));
  }
});

test("replace records the exact attempt, keeps the head revision, uploads, then releases older pins", async () => {
  const f = effectFixture();
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "keep:rev-1:true", "upload", "keep:rev-0:false"]);
  assert.deepEqual(f.attempt(), { contract: "clued.storage-replace-attempt/1", intent_id: intent,
    request_sha256: f.request.admission.binding.request_sha256, profile_id: profile.profile_id, operation: "replace", provider_file_id: "file",
    destination_path: contentMutation.destination_path, parent_id: "track", destination_file_version: "5", content_before: CONTENT_BEFORE,
    pinned_revision_id: "rev-1", previously_kept: false, content_after: contentAfter(NEW), restore_job_id: null, release_revision_ids: ["rev-0"],
    target_kind: "file", binding: f.request.admission.binding });
  assert.deepEqual(result, { operation: "replace", source_path: null, destination_path: contentMutation.destination_path,
    provider_file_id: "file", provider_file_version: "7", content_before: CONTENT_BEFORE, content_after: contentAfter(NEW),
    pinned_revision_id: "rev-1", previously_kept: false, release_revision_ids: ["rev-0"], restore_job_id: null, intent_id: intent });
  assert.equal(f.d.revisions.get("rev-1").keepForever, true); assert.equal(f.d.revisions.get("rev-0").keepForever, false);
});

test("a head the Owner already keeps is recorded as such and not written again", async () => {
  const d = drive(); d.revisions.get("rev-1").keepForever = true;
  const f = effectFixture(contentMutation, d);
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "upload", "keep:rev-0:false"]);
  assert.equal(f.attempt().previously_kept, true); assert.equal(result.previously_kept, true);
});

test("a failed release after the upload does not fail the replace; the verifier reports it unreleased", async () => {
  const d = drive();
  const f = effectFixture(contentMutation, d, { fetch: async (url, options) => {
    const u = new URL(url), parts = u.pathname.split("/");
    if (parts.at(-2) === "revisions") {
      const id = decodeURIComponent(parts.at(-1));
      if (id === "rev-0") { f.events.push("release-lost"); throw new Error("socket closed"); }
      d.revisions.get(id).keepForever = true; f.events.push(`keep:${id}:true`); return Response.json({ id, keepForever: true });
    }
    f.events.push("upload"); return Response.json(upload(d, Buffer.from(options.body)));
  } });
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "keep:rev-1:true", "upload", "release-lost"]);
  const verified = await verifier(d)({ profile, mutation: contentMutation, provider_before: before(), effect_result: result });
  assert.deepEqual(verified.verified_proof.released_revision_ids, []);
  assert.deepEqual(verified.verified_proof.release_revision_ids, ["rev-0"]);
});

test("a stale version, a Google-native file, unproven content or a changed file never reaches a provider write", async () => {
  const cases = [
    ["DRIVE_NATIVE_TARGET_VERSION_MISMATCH", f => { f.d.files.get("file").version = "6"; }],
    ["DRIVE_NATIVE_TARGET_MISMATCH", f => { f.d.files.get("file").mimeType = "application/vnd.google-apps.document"; }],
    ["DRIVE_NATIVE_TARGET_MISMATCH", f => { f.d.files.get("file").trashed = true; }],
    ["DRIVE_NATIVE_TARGET_CONTENT_UNPROVEN", f => { delete f.d.files.get("file").headRevisionId; }],
    ["DRIVE_NATIVE_REQUEST_MISMATCH", f => { f.request = { ...f.request, mutation: { ...contentMutation, content: "other" } }; }],
  ];
  for (const [code, mutate] of cases) {
    const f = effectFixture(); mutate(f);
    await assert.rejects(f.effect(f.request), new RegExp(code), code);
    assert.deepEqual(f.events.filter(e => e !== "persist"), [], code);
  }
  let reads = 0;
  const d = drive(), getFile = d.getFile;
  d.getFile = async id => { const file = await getFile(id); if (++reads === 2) file.headRevisionId = "rev-9"; return file; };
  const raced = effectFixture(contentMutation, d);
  await assert.rejects(raced.effect(raced.request), /DRIVE_NATIVE_TARGET_MISMATCH/);
  assert.deepEqual(raced.events, ["persist"], "an edit after the durable flush stops before the first write");
  const pinnedRelease = effectFixture(contentMutation, drive(), { release_revision_ids: ["rev-1"] });
  await assert.rejects(pinnedRelease.effect(pinnedRelease.request), /DRIVE_NATIVE_REQUEST_MISMATCH/);
  const unstarted = effectFixture(contentMutation, drive(), { consume_started_provider: () => null });
  await assert.rejects(unstarted.effect(unstarted.request), /DRIVE_NATIVE_DURABLE_START_REQUIRED/);
  const expired = effectFixture();
  expired.request.admission.expires_at_ms = Date.now() - 1;
  await assert.rejects(expired.effect(expired.request), /DRIVE_NATIVE_ADMISSION_EXPIRED/);
  assert.deepEqual(expired.events, ["persist"]);
  assert.throws(() => createGoogleDriveNativeReplaceEffect({ trusted_profile: profile, get_file: d.getFile, get_credential: async () => ({}),
    resolve_provider_identity: async () => before(), consume_started_provider: () => null, persist_provider_attempt: async () => {},
    replacement: "not bytes", release_revision_ids: [] }), TypeError);
});

test("a lost upload reply is not retried; a mismatched reply fails", async () => {
  const lost = effectFixture(contentMutation, drive(), { fetch: async (url, options) => {
    if (new URL(url).pathname.includes("/revisions/")) return Response.json({ id: "rev-1", keepForever: true });
    lost.events.push("upload"); throw new Error("socket closed");
  } });
  await assert.rejects(lost.effect(lost.request), /DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN/);
  assert.deepEqual(lost.events, ["persist", "upload"]);
  const d = drive(), wrong = effectFixture(contentMutation, d, { fetch: async url => {
    if (new URL(url).pathname.includes("/revisions/")) return Response.json({ id: "rev-1", keepForever: true });
    return Response.json({ ...upload(d, Buffer.from("something else")) });
  } });
  await assert.rejects(wrong.effect(wrong.request), /DRIVE_NATIVE_RESPONSE_MISMATCH/);
});

function verifier(d, extra = {}) {
  let now = 0;
  return createGoogleDriveReplacePostconditionVerifier({ managed_root: ROOT, root_folder_id: "root", root_parent_id: "container",
    get_file: d.getFile, list_children: d.listChildren, get_revision: d.getRevision, include_verified_proof: true,
    timeout_ms: 3000, poll_ms: 1000, clock: () => now, sleep: async ms => { now += ms; }, ...extra });
}
const effectResult = (mutation = contentMutation, restore = null) => ({ operation: "replace", source_path: null,
  destination_path: mutation.destination_path, provider_file_id: "file", provider_file_version: "7", content_before: CONTENT_BEFORE,
  content_after: contentAfter(NEW), pinned_revision_id: "rev-1", previously_kept: false, release_revision_ids: ["rev-0"], restore_job_id: restore });
const replaced = () => {
  const d = drive(); upload(d, NEW); d.revisions.get("rev-1").keepForever = true; d.revisions.get("rev-0").keepForever = false; return d;
};

test("the verifier proves the new content, the kept previous revision and the released pins from metadata", async () => {
  const result = await verifier(replaced())({ profile, mutation: contentMutation, provider_before: before(), effect_result: effectResult() });
  assert.deepEqual({ ...result, verified_proof: undefined }, { path: contentMutation.destination_path, parent_id: "track",
    provider_file_id: "file", provider_file_version: "7", verified_proof: undefined });
  const proof = result.verified_proof;
  assert.equal(proof.contract, "clued.storage-replace-verified/1");
  assert.deepEqual(proof.checks, { identity: true, ancestors: true, stable_state: true, content: true, revision_changed: true,
    previous_revision_kept: true, releases_observed: true });
  assert.deepEqual(proof.content_before, CONTENT_BEFORE); assert.deepEqual(proof.content_after, contentAfter(NEW));
  assert.equal(proof.pinned_revision_id, "rev-1"); assert.deepEqual(proof.release_revision_ids, ["rev-0"]);
  assert.deepEqual(proof.released_revision_ids, ["rev-0"]); assert.equal(proof.previously_kept, false);
  const restored = await verifier(replaced())({ profile, mutation: restoreMutation, provider_before: before(), effect_result: effectResult(restoreMutation, restoreJob) });
  assert.equal(restored.verified_proof.restore_job_id, restoreJob);
});

test("a checksum published late is re-read, not failed", async () => {
  const d = replaced(), getFile = d.getFile; let reads = 0;
  d.getFile = async id => { const f = await getFile(id); if (id === "file" && ++reads === 1) delete f.sha256Checksum; return f; };
  const result = await verifier(d, { get_file: d.getFile })({ profile, mutation: contentMutation, provider_before: before(), effect_result: effectResult() });
  assert.equal(result.provider_file_version, "7"); assert.ok(reads >= 3);
});

test("the verifier fails closed on unchanged or wrong content, an unkept or changed previous revision, or an unreleased pin", async () => {
  const cases = [
    ["DRIVE_POSTCONDITION_REVISION_UNCHANGED", () => drive()],
    ["DRIVE_POSTCONDITION_CONTENT_MISMATCH", () => { const d = replaced(); d.files.get("file").sha256Checksum = "e".repeat(64); return d; }],
    ["DRIVE_POSTCONDITION_CONTENT_MISMATCH", () => { const d = replaced(); d.files.get("file").size = "1"; return d; }],
    ["DRIVE_POSTCONDITION_PREVIOUS_REVISION_NOT_KEPT", () => { const d = replaced(); d.revisions.get("rev-1").keepForever = false; return d; }],
    ["DRIVE_POSTCONDITION_PREVIOUS_REVISION_NOT_KEPT", () => { const d = replaced(); d.revisions.get("rev-1").md5Checksum = "f".repeat(32); return d; }],
    ["DRIVE_POSTCONDITION_IDENTITY_MISMATCH", () => { const d = replaced(); d.files.get("file").parents = ["track", "root"]; return d; }],
    ["DRIVE_POSTCONDITION_SYNC_TIMEOUT", () => { const d = replaced(); delete d.files.get("file").sha256Checksum; return d; }],
  ];
  for (const [code, make] of cases) {
    const d = make();
    await assert.rejects(verifier(d)({ profile, mutation: contentMutation, provider_before: before(), effect_result: effectResult() }), new RegExp(code), code);
  }
  for (const [provider, effect] of [[{ ...before(), destination_file_version: "4" }, effectResult()],
    [before(), { ...effectResult(), release_revision_ids: ["rev-1"] }], [before(), effectResult(contentMutation, restoreJob)],
    [before(), { ...effectResult(), content_before: { ...CONTENT_BEFORE, head_revision_id: "rev-0" } }],
    [before(), { ...effectResult(), previously_kept: undefined }]]) {
    await assert.rejects(verifier(replaced())({ profile, mutation: contentMutation, provider_before: provider, effect_result: effect }),
      /DRIVE_POSTCONDITION_REQUEST_MISMATCH/);
  }
});

// StorageNormalUse.v0.1 §2.2: writes accept either allowed profile; any other set is refused before the first write.
test("scope profiles: replace accepts legacy and normal grants and refuses every other set", async () => {
  const normal = SCOPE + " https://www.googleapis.com/auth/drive.readonly";
  const ok = effectFixture(contentMutation, drive(), { get_credential: async () => ({ access_token: "replace-test-access-token", scope: normal }) });
  assert.equal((await ok.effect(ok.request)).operation, "replace");
  for (const scope of [SCOPE + " https://www.googleapis.com/auth/drive", SCOPE + " https://www.googleapis.com/auth/drive.metadata",
    "https://www.googleapis.com/auth/drive.file", undefined]) {
    const f = effectFixture(contentMutation, drive(), { get_credential: async () => ({ access_token: "replace-test-access-token", scope }) });
    await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_GRANT_UNAVAILABLE/, String(scope));
    assert.deepEqual(f.events, ["persist"], String(scope));
  }
});
