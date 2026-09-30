import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LEGACY_SCOPE, NORMAL_SCOPE, normalScopeDrive } from "./normal-scope-drive.fixture.mjs";
import { createGoogleDriveNativeModifyEffect, modifyShape } from "../../../kernel/host/resource-center-google-drive-modify-effect.mjs";
import { createGoogleDriveModifyPostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-modify-postcondition.mjs";

// StorageFullCapability.v0.1 P3: the Drive rename/move effect and verifier,
// against an in-memory Drive. Never Google.
const ROOT = "G:/test/Clued_资料中心", TRACK = ROOT + "/20_P_产品与体验";
const profile = { profile_id: "modify-test", profile_version: "test/1", managed_root: ROOT };
const intent = "10000000-0000-4000-8000-000000000001";
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const CONTENT = Object.freeze({ size: "12", sha256: "c".repeat(64), md5: "d".repeat(32), head_revision_id: "rev-1" });
const CONTENT_FIELDS = Object.freeze({ size: "12", sha256Checksum: "c".repeat(64), md5Checksum: "d".repeat(32), headRevisionId: "rev-1" });
const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });

function drive() {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root")],
    ["topic", folder("topic", "topic", "track")],
    ["file", { id: "file", name: "a.txt", parents: ["track"], version: "5", trashed: false, mimeType: "text/plain", ...CONTENT_FIELDS }]]);
  return { files, getFile: async id => structuredClone(files.get(id)),
    listChildren: async ({ parent_id, name }) => [...files.values()].filter(f => f.parents.includes(parent_id) && f.name === name).map(f => structuredClone(f)) };
}
const before = (destinationParent = "track") => ({ root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
  source_file_id: "file", source_file_version: "5", destination_parent_id: destinationParent, destination_parent_version: "1",
  destination_file_id: null, destination_file_version: null, provider_version: "a".repeat(64) });
const renameMutation = { operation: "rename", target_kind: "file", source_path: TRACK + "/a.txt", destination_path: TRACK + "/b.txt",
  source_file_version: "5", artifact_role: "clued_resource" };
const moveMutation = { ...renameMutation, operation: "move", destination_path: TRACK + "/topic/a.txt" };

function effectFixture(mutation, d = drive(), overrides = {}) {
  const events = [], provider = before(mutation.operation === "move" ? "topic" : "track");
  const binding = { profile_id: profile.profile_id, request_sha256: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") };
  let consumed = false, attempt;
  const effect = createGoogleDriveNativeModifyEffect({ trusted_profile: profile, get_file: d.getFile,
    get_credential: async () => ({ access_token: "modify-test-access-token", scope: SCOPE }),
    resolve_provider_identity: async () => ({ ...provider }),
    consume_started_provider: () => consumed ? null : (consumed = true, { intent_id: intent, request_sha256: binding.request_sha256, provider }),
    persist_provider_attempt: async value => { events.push("persist"); attempt = value; },
    fetch: async (url, options) => {
      events.push("patch");
      assert.equal(options.method, "PATCH"); assert.equal(options.redirect, "error");
      assert.equal(events.at(-2), "persist", "the attempt is durable before the only update");
      const u = new URL(url), file = d.files.get(u.pathname.split("/").at(-1)), body = JSON.parse(options.body);
      if (body.name) file.name = body.name;
      if (u.searchParams.get("addParents")) file.parents = [u.searchParams.get("addParents")];
      file.version = String(Number(file.version) + 2);
      return Response.json(file);
    }, ...overrides });
  return { effect, events, d, attempt: () => attempt,
    request: { mutation, admission: { binding, expires_at_ms: Date.now() + 30000 }, profile_identity: profile } };
}

test("modifyShape accepts only a same-parent rename or a same-name move of one file", () => {
  assert.ok(modifyShape(renameMutation)); assert.ok(modifyShape(moveMutation));
  for (const bad of [{ ...renameMutation, destination_path: TRACK + "/topic/b.txt" }, { ...renameMutation, destination_path: renameMutation.source_path },
    { ...moveMutation, destination_path: TRACK + "/topic/b.txt" }, { ...renameMutation, target_kind: "directory" },
    { ...renameMutation, source_file_version: "0" }, { ...renameMutation, content: "x" }, { ...renameMutation, operation: "replace" },
    { ...renameMutation, destination_path: TRACK + "/../b.txt" }]) assert.equal(modifyShape(bad), null, JSON.stringify(bad));
});

test("rename records the exact attempt, then renames by one PATCH and returns the new version", async () => {
  const f = effectFixture(renameMutation);
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "patch"]);
  assert.deepEqual(f.attempt(), { contract: "clued.storage-modify-attempt/1", intent_id: intent, request_sha256: f.request.admission.binding.request_sha256,
    profile_id: profile.profile_id, operation: "rename", provider_file_id: "file", source_path: renameMutation.source_path, source_file_version: "5",
    source_parent_id: "track", destination_path: renameMutation.destination_path, parent_id: "track", target_kind: "file", content: CONTENT,
    binding: f.request.admission.binding });
  assert.deepEqual(result, { operation: "rename", source_path: renameMutation.source_path, destination_path: renameMutation.destination_path,
    provider_file_id: "file", provider_file_version: "7", content: CONTENT, intent_id: intent });
  assert.equal(f.d.files.get("file").name, "b.txt");
});

test("move sends addParents/removeParents and no rename body", async () => {
  let seen;
  const d = drive(), f = effectFixture(moveMutation, d, { fetch: async (url, options) => {
    seen = { url: new URL(url), body: JSON.parse(options.body) };
    const file = d.files.get("file"); file.parents = ["topic"]; file.version = "9"; return Response.json(file);
  } });
  const result = await f.effect(f.request);
  assert.equal(seen.url.searchParams.get("addParents"), "topic"); assert.equal(seen.url.searchParams.get("removeParents"), "track");
  assert.deepEqual(seen.body, {}); assert.equal(result.provider_file_version, "9");
  assert.equal(f.attempt().source_parent_id, "track"); assert.equal(f.attempt().parent_id, "topic");
});

test("a changed source, a missing durable start or a changed identity never reaches the update", async () => {
  const cases = [
    ["DRIVE_NATIVE_SOURCE_VERSION_MISMATCH", f => { f.d.files.get("file").version = "6"; }],
    ["DRIVE_NATIVE_SOURCE_MISMATCH", f => { f.d.files.get("file").trashed = true; }],
    ["DRIVE_NATIVE_SOURCE_MISMATCH", f => { f.d.files.get("file").parents = ["topic"]; }],
    ["DRIVE_NATIVE_SOURCE_CONTENT_UNPROVEN", f => { delete f.d.files.get("file").headRevisionId; }],
    ["DRIVE_NATIVE_SOURCE_CONTENT_UNPROVEN", f => { Object.assign(f.d.files.get("file"), { sha256Checksum: undefined, md5Checksum: undefined }); }],
    ["DRIVE_NATIVE_REQUEST_MISMATCH", f => { f.request = { ...f.request, mutation: { ...renameMutation, destination_path: TRACK + "/topic/b.txt" } }; }],
  ];
  for (const [code, mutate] of cases) {
    const f = effectFixture(renameMutation); mutate(f);
    await assert.rejects(f.effect(f.request), new RegExp(code));
    assert.equal(f.events.includes("patch"), false, code);
  }
  let calls = 0;
  const changed = effectFixture(renameMutation, drive(), { resolve_provider_identity: async () => ({ ...before(), provider_version: ++calls > 1 ? "b".repeat(64) : "a".repeat(64) }) });
  await assert.rejects(changed.effect(changed.request), /DRIVE_NATIVE_PROVIDER_CHANGED/);
  assert.deepEqual(changed.events, ["persist"], "a change after the durable flush stops before the update");
  const unstarted = effectFixture(renameMutation, drive(), { consume_started_provider: () => null });
  await assert.rejects(unstarted.effect(unstarted.request), /DRIVE_NATIVE_DURABLE_START_REQUIRED/);
  const expired = effectFixture(renameMutation);
  expired.request.admission.expires_at_ms = Date.now() - 1;
  await assert.rejects(expired.effect(expired.request), /DRIVE_NATIVE_ADMISSION_EXPIRED/);
  assert.equal(expired.events.includes("patch"), false);
});

function verifier(d, extra = {}) {
  let now = 0;
  return createGoogleDriveModifyPostconditionVerifier({ managed_root: ROOT, root_folder_id: "root", root_parent_id: "container",
    get_file: d.getFile, list_children: d.listChildren, include_verified_proof: true, timeout_ms: 3000, poll_ms: 1000,
    clock: () => now, sleep: async ms => { now += ms; }, ...extra });
}
const effectResult = (mutation, version) => ({ operation: mutation.operation, source_path: mutation.source_path,
  destination_path: mutation.destination_path, provider_file_id: "file", provider_file_version: version, content: CONTENT });

test("the verifier proves a rename and a move from metadata, recording a jumped version", async () => {
  const d = drive(); Object.assign(d.files.get("file"), { name: "b.txt", version: "8" });
  const renamed = await verifier(d)({ profile, mutation: renameMutation, provider_before: before(), effect_result: effectResult(renameMutation, "8") });
  assert.deepEqual(renamed.verified_proof.checks, { identity: true, ancestors: true, stable_state: true, unique_name: true, source_vacated: true,
    content_unchanged: true });
  assert.deepEqual(renamed.verified_proof.content, CONTENT);
  assert.equal(renamed.verified_proof.contract, "clued.storage-rename-verified/1");
  assert.deepEqual({ ...renamed, verified_proof: undefined }, { path: renameMutation.destination_path, parent_id: "track",
    provider_file_id: "file", provider_file_version: "8", verified_proof: undefined });
  const m = drive(); Object.assign(m.files.get("file"), { parents: ["topic"], version: "12" });
  const moved = await verifier(m)({ profile, mutation: moveMutation, provider_before: before("topic"), effect_result: effectResult(moveMutation, "12") });
  assert.equal(moved.verified_proof.contract, "clued.storage-move-verified/1"); assert.equal(moved.parent_id, "topic");
});

test("the verifier fails closed on a wrong parent, a changed ancestor, a leftover old name or no change", async () => {
  const cases = [
    ["DRIVE_POSTCONDITION_IDENTITY_MISMATCH", d => { Object.assign(d.files.get("file"), { name: "b.txt", parents: ["track", "topic"] }); }],
    ["DRIVE_POSTCONDITION_CONTENT_CHANGED", d => { Object.assign(d.files.get("file"), { name: "b.txt", headRevisionId: "rev-2", sha256Checksum: "e".repeat(64) }); }],
    ["DRIVE_POSTCONDITION_ANCESTOR_CHANGED", d => { Object.assign(d.files.get("file"), { name: "b.txt" }); d.files.get("track").parents = ["elsewhere"];
      d.files.set("track2", folder("track2", "20_P_产品与体验", "root")); }],
    ["DRIVE_POSTCONDITION_SYNC_TIMEOUT", d => { Object.assign(d.files.get("file"), { name: "b.txt" });
      d.listChildren = async ({ parent_id, name }) => name === "a.txt" ? [{ id: "file", name: "a.txt", parents: [parent_id], version: "5" }]
        : [...d.files.values()].filter(f => f.parents.includes(parent_id) && f.name === name).map(f => structuredClone(f)); }],
    ["DRIVE_POSTCONDITION_SYNC_TIMEOUT", () => {}],
    ["DRIVE_POSTCONDITION_IDENTITY_MISMATCH", d => { d.files.set("other", { id: "other", name: "b.txt", parents: ["track"], version: "1", trashed: false, mimeType: "text/plain" }); }],
  ];
  for (const [code, mutate] of cases) {
    const d = drive(); mutate(d);
    await assert.rejects(verifier(d)({ profile, mutation: renameMutation, provider_before: before(), effect_result: effectResult(renameMutation, "8") }),
      new RegExp(code), code);
  }
  await assert.rejects(verifier(drive())({ profile, mutation: renameMutation, provider_before: { ...before(), source_file_version: "4" },
    effect_result: effectResult(renameMutation, "8") }), /DRIVE_POSTCONDITION_REQUEST_MISMATCH/);
});

test("a version still settling is re-read until two observations agree", async () => {
  const d = drive(); Object.assign(d.files.get("file"), { name: "b.txt", version: "8" });
  let reads = 0; const getFile = d.getFile;
  d.getFile = async id => { const f = await getFile(id); if (id === "file" && ++reads === 1) f.version = "9"; return f; };
  const result = await verifier(d, { get_file: d.getFile })({ profile, mutation: renameMutation, provider_before: before(), effect_result: effectResult(renameMutation, "8") });
  assert.equal(result.provider_file_version, "8"); assert.ok(reads >= 3);
});

test("a folder version advanced by the change itself does not fail verification", async () => {
  const d = drive(); Object.assign(d.files.get("file"), { name: "b.txt", version: "8" }); d.files.get("track").version = "4"; d.files.get("root").version = "3";
  const result = await verifier(d)({ profile, mutation: renameMutation, provider_before: before(), effect_result: effectResult(renameMutation, "8") });
  assert.equal(result.provider_file_version, "8");
});

test("an edit between the effect's reads, or a content change in the reply, never reaches settlement", async () => {
  let reads = 0;
  const d = drive(), getFile = d.getFile;
  d.getFile = async id => { const f = await getFile(id); if (id === "file" && ++reads === 2) f.headRevisionId = "rev-2"; return f; };
  const f = effectFixture(renameMutation, d);
  await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_SOURCE_MISMATCH/);
  assert.deepEqual(f.events, ["persist"], "the change after the durable flush stops before the update");
  const r = drive(), g = effectFixture(renameMutation, r, { fetch: async () => {
    const file = r.files.get("file"); file.name = "b.txt"; file.version = "8"; file.headRevisionId = "rev-9"; return Response.json(file);
  } });
  await assert.rejects(g.effect(g.request), /DRIVE_NATIVE_RESPONSE_MISMATCH/);
});

// StorageNormalUse.v0.1 §2.2: writes accept either allowed profile; any other set is refused before the update.
test("scope profiles: rename accepts legacy and normal grants and refuses every other set", async () => {
  const normal = SCOPE + " https://www.googleapis.com/auth/drive.readonly";
  const ok = effectFixture(renameMutation, drive(), { get_credential: async () => ({ access_token: "modify-test-access-token", scope: normal }) });
  assert.equal((await ok.effect(ok.request)).operation, "rename");
  for (const scope of [SCOPE + " https://www.googleapis.com/auth/drive", SCOPE + " https://www.googleapis.com/auth/drive.metadata",
    "https://www.googleapis.com/auth/drive.file", undefined]) {
    const f = effectFixture(renameMutation, drive(), { get_credential: async () => ({ access_token: "modify-test-access-token", scope }) });
    await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_GRANT_UNAVAILABLE/, String(scope));
    assert.equal(f.events.includes("patch"), false, String(scope));
  }
});

// StorageNormalUse.v0.1 §3.1: with a normal (drive.readonly) credential the
// verifier lists through the write-path metadata API and never sees the Owner's
// own files, so an Owner "a.txt" or "b.txt" beside the file changes nothing.
test("normal scope: a rename and a move verify although the Owner has same-named files", async () => {
  const owner = [{ id: "o-a", name: "a.txt", parents: ["track"], version: "1", trashed: false, mimeType: "text/plain" },
    { id: "o-b", name: "b.txt", parents: ["track"], version: "1", trashed: false, mimeType: "text/plain" },
    { id: "o-topic-file", name: "a.txt", parents: ["topic"], version: "1", trashed: false, mimeType: "text/plain" },
    folder("o-track", "20_P_产品与体验", "root"), folder("o-topic", "topic", "track")];
  for (const scope of [LEGACY_SCOPE, NORMAL_SCOPE]) {
    const d = drive(); Object.assign(d.files.get("file"), { name: "b.txt", version: "8" });
    const api = normalScopeDrive(d.files, owner, { scope });
    const renamed = await verifier(d, { get_file: api.getFile, list_children: api.listChildren })({ profile, mutation: renameMutation,
      provider_before: before(), effect_result: effectResult(renameMutation, "8") });
    assert.equal(renamed.verified_proof.checks.unique_name, true, scope);
    assert.equal(renamed.verified_proof.checks.source_vacated, true, scope);
    const m = drive(); Object.assign(m.files.get("file"), { parents: ["topic"], version: "12" });
    const moveApi = normalScopeDrive(m.files, owner, { scope });
    const moved = await verifier(m, { get_file: moveApi.getFile, list_children: moveApi.listChildren })({ profile, mutation: moveMutation,
      provider_before: before("topic"), effect_result: effectResult(moveMutation, "12") });
    assert.equal(moved.parent_id, "topic", scope);
  }
  // A second Clued-created "b.txt" is still ambiguity, exactly as before.
  const d = drive(); Object.assign(d.files.get("file"), { name: "b.txt", version: "8" });
  d.files.set("other", { id: "other", name: "b.txt", parents: ["track"], version: "1", trashed: false, mimeType: "text/plain" });
  const api = normalScopeDrive(d.files, owner);
  await assert.rejects(verifier(d, { get_file: api.getFile, list_children: api.listChildren })({ profile, mutation: renameMutation,
    provider_before: before(), effect_result: effectResult(renameMutation, "8") }), /DRIVE_POSTCONDITION_DESTINATION_AMBIGUOUS/);
});
