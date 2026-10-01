import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoogleDriveNativeDestructiveEffect, destructiveShape, destructiveOwnershipAllowed,
  DESTRUCTIVE_PROOF_CONTRACTS } from "../../../kernel/host/resource-center-google-drive-destructive-effect.mjs";
import { createGoogleDriveDestructivePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-destructive-postcondition.mjs";
import { createGoogleDriveProviderIdentityResolver } from "../../../kernel/host/resource-center-google-drive-identity.mjs";
import { evaluateResourceCenterMutation } from "../../../kernel/policy/resource-center-mutation-policy.mjs";

// StorageFullCapability.v0.1 P5: the Drive trash/untrash effect, verifier and
// provider identity, against an in-memory Drive. Never Google.
const ROOT = "G:/test/Clued_资料中心", TRACK = ROOT + "/20_P_产品与体验";
const profile = { profile_id: "destructive-test", profile_version: "test/1", managed_root: ROOT };
const intent = "10000000-0000-4000-8000-000000000005";
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const CONTENT = Object.freeze({ size: "12", sha256: "c".repeat(64), md5: "d".repeat(32), head_revision_id: "rev-1" });
const CONTENT_FIELDS = Object.freeze({ size: "12", sha256Checksum: "c".repeat(64), md5Checksum: "d".repeat(32), headRevisionId: "rev-1" });
const folder = (id, name, parent) => ({ id, name, parents: [parent], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" });

function drive({ trashed = false } = {}) {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root")],
    ["file", { id: "file", name: "a.txt", parents: ["track"], version: "5", trashed, mimeType: "text/plain", ...CONTENT_FIELDS }]]);
  const ownership = { id: "file", owned_by_me: true, can_trash: true, can_untrash: true };
  return { files, ownership, getFile: async id => structuredClone(files.get(id)),
    getOwnership: async id => ({ ...ownership, id }),
    // As Drive's name query: trashed entries are never listed.
    listChildren: async ({ parent_id, name }) => [...files.values()]
      .filter(f => f.parents.includes(parent_id) && f.name === name && f.trashed === false).map(f => structuredClone(f)) };
}
const before = () => ({ root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
  source_file_id: "file", source_file_version: "5", destination_parent_id: null, destination_parent_version: null,
  destination_file_id: null, destination_file_version: null, provider_version: "a".repeat(64),
  root_sharing_digest: null, destination_parent_sharing_digest: null, source_parent_id: "track" });
const trashMutation = { operation: "delete", target_kind: "file", source_path: TRACK + "/a.txt", source_file_version: "5",
  artifact_role: "clued_resource", governance_class: "ordinary", delete_authority: false };
const untrashMutation = { ...trashMutation, operation: "restore" };

function effectFixture(mutation, d = drive({ trashed: mutation.operation === "restore" }), overrides = {}) {
  const events = [], provider = before();
  const binding = { profile_id: profile.profile_id, request_sha256: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") };
  let consumed = false, attempt;
  const effect = createGoogleDriveNativeDestructiveEffect({ trusted_profile: profile, get_file: d.getFile, get_ownership: d.getOwnership,
    get_credential: async () => ({ access_token: "destructive-test-access-token", scope: SCOPE }),
    resolve_provider_identity: async () => ({ ...provider }),
    consume_started_provider: () => consumed ? null : (consumed = true, { intent_id: intent, request_sha256: binding.request_sha256, provider }),
    persist_provider_attempt: async value => { events.push("persist"); attempt = value; },
    fetch: async (url, options) => {
      events.push("patch");
      assert.equal(options.method, "PATCH", "never files.delete"); assert.equal(options.redirect, "error");
      assert.equal(events.at(-2), "persist", "the attempt is durable before the only update");
      const u = new URL(url), file = d.files.get(u.pathname.split("/").at(-1)), body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ["trashed"]);
      file.trashed = body.trashed;
      file.version = String(Number(file.version) + 3);
      return Response.json(file);
    }, ...overrides });
  return { effect, events, d, attempt: () => attempt,
    request: { mutation, admission: { binding, expires_at_ms: Date.now() + 30000 }, profile_identity: profile } };
}

test("destructiveShape accepts only one file by source path and version", () => {
  assert.ok(destructiveShape(trashMutation)); assert.ok(destructiveShape(untrashMutation));
  for (const bad of [{ ...trashMutation, destination_path: TRACK + "/b.txt" }, { ...trashMutation, target_kind: "directory" },
    { ...trashMutation, source_file_version: "0" }, { ...trashMutation, content: "x" }, { ...trashMutation, operation: "rename" },
    { ...trashMutation, source_path: TRACK + "/../a.txt" }, { ...trashMutation, source_path: "a.txt" }]) {
    assert.equal(destructiveShape(bad), null, JSON.stringify(bad));
  }
  assert.equal(DESTRUCTIVE_PROOF_CONTRACTS.delete, "clued.storage-trash-verified/1");
  assert.equal(DESTRUCTIVE_PROOF_CONTRACTS.restore, "clued.storage-untrash-verified/1");
});

test("ownership: only an owned file with Drive's matching capability", () => {
  assert.equal(destructiveOwnershipAllowed("delete", { owned_by_me: true, can_trash: true }), true);
  assert.equal(destructiveOwnershipAllowed("restore", { owned_by_me: true, can_untrash: true }), true);
  assert.equal(destructiveOwnershipAllowed("delete", { owned_by_me: false, can_trash: true }), false);
  assert.equal(destructiveOwnershipAllowed("delete", { owned_by_me: true, can_trash: false, can_untrash: true }), false);
  assert.equal(destructiveOwnershipAllowed("restore", { owned_by_me: true, can_trash: true }), false);
});

test("mutation policy: restore is source-only like delete; governance trash needs delete authority", () => {
  const base = { profile: { managed_root: ROOT, allowed_root_children: ["20_P_产品与体验"] }, artifact_role: "clued_resource",
    source_path: TRACK + "/a.txt", governance_class: "ordinary" };
  assert.equal(evaluateResourceCenterMutation({ ...base, operation: "restore" }).status, "allow");
  assert.equal(evaluateResourceCenterMutation({ ...base, operation: "restore", destination_path: TRACK + "/b.txt" }).error_code, "DELETE_DESTINATION_FORBIDDEN");
  assert.equal(evaluateResourceCenterMutation({ ...base, operation: "delete", governance_class: "governance" }).error_code, "DELETE_AUTHORITY_REQUIRED");
  assert.equal(evaluateResourceCenterMutation({ ...base, operation: "delete", governance_class: "governance", delete_authority: true }).status, "allow");
});

test("trash records the exact attempt, then sets trashed=true by one PATCH and returns the new version", async () => {
  const f = effectFixture(trashMutation);
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "patch"]);
  assert.deepEqual(f.attempt(), { contract: "clued.storage-destructive-attempt/1", intent_id: intent,
    request_sha256: f.request.admission.binding.request_sha256, profile_id: profile.profile_id, operation: "delete",
    provider_file_id: "file", source_path: trashMutation.source_path, source_file_version: "5", parent_id: "track",
    target_kind: "file", content: CONTENT, binding: f.request.admission.binding });
  assert.deepEqual(result, { operation: "delete", source_path: trashMutation.source_path, provider_file_id: "file",
    provider_file_version: "8", parent_id: "track", content: CONTENT, intent_id: intent });
  assert.equal(f.d.files.get("file").trashed, true);
});

test("untrash takes a trashed file out by one PATCH trashed=false", async () => {
  const f = effectFixture(untrashMutation);
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "patch"]);
  assert.equal(f.attempt().operation, "restore");
  assert.equal(result.provider_file_version, "8"); assert.equal(f.d.files.get("file").trashed, false);
});

test("a file someone else owns, a stale version or a governance file without delete authority never reaches the attempt", async () => {
  const notOwned = drive(); notOwned.ownership.owned_by_me = false;
  const cases = [
    [effectFixture(trashMutation, notOwned), "PROVIDER_OWNER_REQUIRED"],
    [effectFixture({ ...trashMutation, source_file_version: "4" }), "DRIVE_NATIVE_PROVIDER_CHANGED"],
    [effectFixture({ ...trashMutation, governance_class: "governance" }), "DRIVE_NATIVE_REQUEST_MISMATCH"],
    [effectFixture(untrashMutation, drive({ trashed: false })), "DRIVE_NATIVE_SOURCE_MISMATCH"],
  ];
  for (const [f, code] of cases) {
    await assert.rejects(f.effect(f.request), new RegExp(code));
    assert.deepEqual(f.events, [], code);
  }
});

test("a content edit after the durable flush stops before the update", async () => {
  const d = drive(); let reads = 0;
  const getFile = async id => { const file = structuredClone(d.files.get(id)); if (id === "file" && ++reads > 1) file.headRevisionId = "rev-2"; return file; };
  const f = effectFixture(trashMutation, { ...d, getFile });
  await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_SOURCE_MISMATCH/);
  assert.deepEqual(f.events, ["persist"]);
});

test("a lost update reply is an unknown outcome, never retried", async () => {
  const f = effectFixture(trashMutation, drive(), { fetch: async () => { throw new Error("lost"); } });
  await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN/);
});

const verifier = (d, overrides = {}) => createGoogleDriveDestructivePostconditionVerifier({ managed_root: ROOT, root_folder_id: "root",
  root_parent_id: "container", get_file: d.getFile, list_children: d.listChildren, include_verified_proof: true,
  timeout_ms: 50, poll_ms: 10, sleep: async () => {}, ...overrides });
const effectResult = (operation, version = "8") => ({ operation, source_path: TRACK + "/a.txt", provider_file_id: "file",
  provider_file_version: version, parent_id: "track", content: { ...CONTENT } });

test("trash verifier proves trashed, same parent and content, name vacated and a stable version", async () => {
  const d = drive({ trashed: true }); d.files.get("file").version = "9"; // Drive may jump by more than one.
  const result = await verifier(d)({ profile, mutation: trashMutation, provider_before: before(), effect_result: effectResult("delete") });
  assert.deepEqual(result.verified_proof, { contract: "clued.storage-trash-verified/1", path: TRACK + "/a.txt", parent_id: "track",
    provider_file_id: "file", provider_file_version: "9", operation: "delete", source_path: TRACK + "/a.txt", source_file_version: "5",
    trashed: true, content: CONTENT, provider_before: before(), checks: { identity: true, ancestors: true, stable_state: true,
      trashed: true, parent_unchanged: true, name_vacated: true, content_unchanged: true } });
});

test("untrash verifier requires the only entry of its name and fails on a same-name file", async () => {
  const d = drive();
  const result = await verifier(d)({ profile, mutation: untrashMutation, provider_before: before(), effect_result: effectResult("restore") });
  assert.equal(result.verified_proof.contract, "clued.storage-untrash-verified/1");
  assert.equal(result.verified_proof.trashed, false); assert.equal(result.verified_proof.checks.unique_name, true);
  d.files.set("other", { ...structuredClone(d.files.get("file")), id: "other" });
  await assert.rejects(verifier(d)({ profile, mutation: untrashMutation, provider_before: before(), effect_result: effectResult("restore") }),
    /DRIVE_POSTCONDITION_DESTINATION_AMBIGUOUS/);
});

test("verifier fails closed on changed content, a moved file or a still-untrashed file", async () => {
  const changed = drive({ trashed: true }); changed.files.get("file").headRevisionId = "rev-2";
  await assert.rejects(verifier(changed)({ profile, mutation: trashMutation, provider_before: before(), effect_result: effectResult("delete") }),
    /DRIVE_POSTCONDITION_CONTENT_CHANGED/);
  const moved = drive({ trashed: true }); moved.files.get("file").parents = ["root"];
  await assert.rejects(verifier(moved)({ profile, mutation: trashMutation, provider_before: before(), effect_result: effectResult("delete") }),
    /DRIVE_POSTCONDITION_IDENTITY_MISMATCH/);
  await assert.rejects(verifier(drive())({ profile, mutation: trashMutation, provider_before: before(), effect_result: effectResult("delete") }),
    /DRIVE_POSTCONDITION_SYNC_TIMEOUT/);
  await assert.rejects(verifier(drive({ trashed: true }))({ profile, mutation: trashMutation,
    provider_before: { ...before(), destination_parent_id: "track" }, effect_result: effectResult("delete") }), /DRIVE_POSTCONDITION_REQUEST_MISMATCH/);
});

test("provider identity: delete names the source folder; restore reads the trashed source by ID and needs its name free", async () => {
  const resolver = (d, extra = {}) => createGoogleDriveProviderIdentityResolver({ managed_root: ROOT, root_folder_id: "root",
    root_parent_id: "container", get_file: d.getFile, list_children: d.listChildren, ...extra });
  const live = await resolver(drive())({ profile, mutation: trashMutation });
  assert.equal(live.source_file_id, "file"); assert.equal(live.source_parent_id, "track"); assert.equal(live.destination_parent_id, null);
  const rename = await resolver(drive())({ profile, mutation: { operation: "rename", target_kind: "file", source_path: TRACK + "/a.txt",
    destination_path: TRACK + "/b.txt" } });
  assert.equal("source_parent_id" in rename, false, "other operations keep their identity shape");
  const trashed = drive({ trashed: true });
  const restored = await resolver(trashed, { restore_source_id: "file" })({ profile, mutation: untrashMutation });
  assert.equal(restored.source_file_id, "file"); assert.equal(restored.source_file_version, "5"); assert.equal(restored.source_parent_id, "track");
  await assert.rejects(resolver(trashed)({ profile, mutation: untrashMutation }), /PROVIDER_PATH_UNREGISTERED/);
  trashed.files.set("new", { ...structuredClone(trashed.files.get("file")), id: "new", trashed: false });
  await assert.rejects(resolver(trashed, { restore_source_id: "file" })({ profile, mutation: untrashMutation }), /PROVIDER_DESTINATION_EXISTS/);
  await assert.rejects(resolver(drive(), { restore_source_id: "file" })({ profile, mutation: untrashMutation }), /PROVIDER_METADATA_MISMATCH/);
});
