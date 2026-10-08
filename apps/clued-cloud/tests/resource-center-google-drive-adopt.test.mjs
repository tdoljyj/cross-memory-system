import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoogleDriveAdoptEffect, adoptShape, adoptItemAllowed, ADOPT_KEYS } from "../../../kernel/host/resource-center-google-drive-adopt-effect.mjs";
import { createGoogleDriveAdoptPostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-adopt-postcondition.mjs";
import { createGoogleDriveProviderIdentityResolver } from "../../../kernel/host/resource-center-google-drive-identity.mjs";
import { googleDriveSharingDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";
import { evaluateResourceCenterMutation } from "../../../kernel/policy/resource-center-mutation-policy.mjs";

// StorageFullCapability.v0.1 P7 (Decisions 746fd078, 6dc1cf20): the adopt
// effect, verifier and provider identity against an in-memory Drive. Adopt
// never writes to Drive. Never Google.
const ROOT = "G:/test/Clued_资料中心", TRACK = ROOT + "/20_P_产品与体验";
const profile = { profile_id: "adopt-test", profile_version: "test/1", managed_root: ROOT };
const intent = "10000000-0000-4000-8000-000000000007";
const FOLDER = "application/vnd.google-apps.folder";
const PRIVATE = { shared: false, permissionIds: ["owner-permission"] };
const SHARED = { shared: true, permissionIds: ["anyone-with-link", "owner-permission"] };
const folder = (id, name, parent, version = "1") => ({ id, name, parents: [parent], version, trashed: false, mimeType: FOLDER });

function drive() {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root", "3")],
    ["dir", folder("dir", "uploads", "track", "4")],
    ["file", { id: "file", name: "manual.pdf", parents: ["track"], version: "9", trashed: false, mimeType: "application/pdf" }],
    ["short", { id: "short", name: "link", parents: ["track"], version: "2", trashed: false, mimeType: "application/vnd.google-apps.shortcut" }]]);
  const sharing = new Map([["root", PRIVATE], ["track", PRIVATE], ["dir", PRIVATE], ["file", PRIVATE], ["short", PRIVATE]]);
  const owned = new Set(["root", "track", "dir", "file", "short"]);
  return { files, sharing, owned, getFile: async id => structuredClone(files.get(id)),
    getOwnership: async id => ({ id, owned_by_me: owned.has(id), can_trash: true, can_untrash: true }),
    getSharing: async id => ({ id, ...sharing.get(id) }),
    listChildren: async ({ parent_id, name }) => [...files.values()]
      .filter(f => f.parents.includes(parent_id) && f.name === name && f.trashed === false).map(f => structuredClone(f)) };
}
const resolverFor = d => createGoogleDriveProviderIdentityResolver({ managed_root: ROOT, root_folder_id: "root", root_parent_id: "container",
  get_file: d.getFile, list_children: d.listChildren, get_sharing: d.getSharing });
const fileMutation = { operation: "adopt", target_kind: "file", source_path: TRACK + "/manual.pdf", source_file_id: "file" };
const dirMutation = { operation: "adopt", target_kind: "directory", source_path: TRACK + "/uploads", source_file_id: "dir" };
const authorized = m => ({ ...m, artifact_role: "clued_resource", artifact_id: null, governance_class: "ordinary", delete_authority: false });

async function effectFixture(mutation, d = drive()) {
  const events = [];
  const resolve = resolverFor(d);
  const provider = await resolve({ profile, mutation });
  const request = authorized(mutation);
  const binding = { profile_id: profile.profile_id, request_sha256: createHash("sha256").update(JSON.stringify(request)).digest("hex") };
  let consumed = false, attempt;
  const effect = createGoogleDriveAdoptEffect({ trusted_profile: profile, get_file: d.getFile, get_ownership: d.getOwnership,
    resolve_provider_identity: async input => { events.push("identity"); return resolve(input); },
    consume_started_provider: () => consumed ? null : (consumed = true, { intent_id: intent, request_sha256: binding.request_sha256, provider }),
    persist_provider_attempt: async value => { events.push("persist"); attempt = value; } });
  return { effect, events, d, provider, attempt: () => attempt,
    request: { mutation: request, admission: { binding, expires_at_ms: Date.now() + 30000 }, profile_identity: profile } };
}
const verifierFor = (d, include = true) => createGoogleDriveAdoptPostconditionVerifier({ managed_root: ROOT, root_folder_id: "root",
  root_parent_id: "container", get_file: d.getFile, list_children: d.listChildren, get_ownership: d.getOwnership,
  get_sharing: d.getSharing, include_verified_proof: include });

test("adoptShape: one existing item by path and Drive ID, nothing else", () => {
  assert.deepEqual(ADOPT_KEYS, ["operation", "source_file_id", "source_path", "target_kind"]);
  assert.ok(adoptShape(fileMutation)); assert.ok(adoptShape(dirMutation)); assert.ok(adoptShape(authorized(fileMutation)));
  for (const bad of [{ ...fileMutation, operation: "move" }, { ...fileMutation, target_kind: "link" }, { ...fileMutation, source_file_id: "bad id" },
    { ...fileMutation, source_file_id: undefined }, { ...fileMutation, destination_path: TRACK + "/x.pdf" }, { ...fileMutation, content: "x" },
    { ...dirMutation, directory_semantics: "topic" }, { ...fileMutation, source_path: TRACK + "/../manual.pdf" }, { ...fileMutation, source_path: 7 }]) {
    assert.equal(adoptShape(bad), null, JSON.stringify(bad));
  }
});

test("mutation policy: adopt names a source only, needs no directory semantics and may sit in a status folder", () => {
  const base = { profile: { managed_root: ROOT, allowed_root_children: ["20_P_产品与体验"] }, artifact_role: "clued_resource",
    operation: "adopt", governance_class: "ordinary" };
  assert.equal(evaluateResourceCenterMutation({ ...base, source_path: TRACK + "/manual.pdf" }).status, "allow");
  assert.equal(evaluateResourceCenterMutation({ ...base, source_path: TRACK + "/uploads", target_kind: "directory" }).status, "allow");
  assert.equal(evaluateResourceCenterMutation({ ...base, source_path: TRACK + "/历史/old.pdf" }).status, "allow");
  assert.equal(evaluateResourceCenterMutation({ ...base, source_path: TRACK + "/a.pdf", destination_path: TRACK + "/b.pdf" }).error_code,
    "ADOPT_DESTINATION_FORBIDDEN");
  assert.equal(evaluateResourceCenterMutation({ ...base }).error_code, "ADOPT_TARGET_REQUIRED");
  assert.equal(evaluateResourceCenterMutation({ ...base, source_path: ROOT + "/loose.pdf" }).error_code, "RESOURCE_CENTER_ROOT_CHILD_FORBIDDEN");
  assert.equal(evaluateResourceCenterMutation({ ...base, source_path: "G:/elsewhere/x.pdf" }).error_code, "SIBLING_ISLAND_FORBIDDEN");
});

test("provider identity: adopt names the item, its folder with Drive version and sharing, and a directory's own sharing", async () => {
  const d = drive();
  const file = await resolverFor(d)({ profile, mutation: fileMutation });
  assert.equal(file.source_file_id, "file"); assert.equal(file.source_file_version, "9");
  assert.equal(file.source_parent_id, "track"); assert.equal(file.source_parent_version, "3");
  assert.equal(file.source_parent_sharing_digest, googleDriveSharingDigest(PRIVATE));
  assert.equal("source_sharing_digest" in file, false);
  assert.equal(file.destination_parent_id, null); assert.equal(file.destination_file_id, null);
  const dir = await resolverFor(d)({ profile, mutation: dirMutation });
  assert.equal(dir.source_sharing_digest, googleDriveSharingDigest(PRIVATE));
  // A missing item fails closed; a duplicate name is ambiguous.
  await assert.rejects(resolverFor(d)({ profile, mutation: { ...fileMutation, source_path: TRACK + "/none.pdf" } }), /PROVIDER_PATH_UNREGISTERED/);
  d.files.set("twin", { ...d.files.get("file"), id: "twin" });
  await assert.rejects(resolverFor(d)({ profile, mutation: fileMutation }), /PROVIDER_PATH_AMBIGUOUS/);
});

test("the adopt effect records the exact attempt and writes nothing to Drive", async () => {
  const f = await effectFixture(fileMutation);
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["identity", "persist"]);
  assert.deepEqual(f.attempt(), { contract: "clued.storage-adopt-attempt/1", intent_id: intent,
    request_sha256: f.request.admission.binding.request_sha256, profile_id: profile.profile_id, operation: "adopt", target_kind: "file",
    provider_file_id: "file", source_path: fileMutation.source_path, provider_file_version: "9", parent_id: "track",
    binding: f.request.admission.binding });
  assert.deepEqual(result, { operation: "adopt", source_path: fileMutation.source_path, provider_file_id: "file",
    provider_file_version: "9", intent_id: intent });
  // One durable start only.
  await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_DURABLE_START_REQUIRED/);
});

test("the adopt effect refuses, before any attempt, another owner, a shortcut, a trashed or changed item", async () => {
  for (const [label, change, mutation] of [
    ["not owned", d => d.owned.delete("file"), fileMutation],
    ["changed version", d => { d.files.get("file").version = "10"; }, fileMutation],
    ["shortcut", () => {}, { ...fileMutation, source_path: TRACK + "/link", source_file_id: "short" }]]) {
    const d = drive();
    const f = await effectFixture(mutation, d);
    change(d);
    await assert.rejects(f.effect(f.request), /DRIVE_NATIVE_(SOURCE_MISMATCH|PROVIDER_CHANGED)/, label);
    assert.equal(f.attempt(), undefined, label);
  }
  // The wrong kind is refused by the provider identity itself.
  await assert.rejects(effectFixture({ ...fileMutation, target_kind: "directory" }), /PROVIDER_METADATA_MISMATCH/);
  assert.equal(adoptItemAllowed(adoptShape(fileMutation), { id: "file", name: "manual.pdf", parents: ["track"], version: "9", trashed: true,
    mimeType: "application/pdf" }, { id: "file", owned_by_me: true }), false, "a trashed item");
  assert.equal(adoptItemAllowed(adoptShape(fileMutation), { id: "file", name: "manual.pdf", parents: ["track", "elsewhere"], version: "9",
    trashed: false, mimeType: "application/pdf" }, { id: "file", owned_by_me: true }), false, "an item in two folders");
});

test("the verifier proves the same item, version, owner and folder; a directory with its folder's sharing", async () => {
  for (const mutation of [fileMutation, dirMutation]) {
    const f = await effectFixture(mutation);
    const effect = await f.effect(f.request);
    const verified = await verifierFor(f.d)({ profile, mutation: f.request.mutation, provider_before: f.provider, effect_result: effect });
    const directory = mutation.target_kind === "directory";
    assert.deepEqual(verified.verified_proof, { contract: "clued.storage-adopt-verified/1", path: mutation.source_path, parent_id: "track",
      provider_file_id: mutation.source_file_id, provider_file_version: directory ? "4" : "9", operation: "adopt",
      target_kind: mutation.target_kind, provider_before: f.provider,
      checks: { identity: true, ancestors: true, stable_state: true, unique_name: true, owned_by_me: true, not_shortcut: true,
        ...(directory ? { sharing_matches_parent: true } : {}) },
      ...(directory ? { provider_sharing_digest: googleDriveSharingDigest(PRIVATE) } : {}) });
    const { verified_proof: _, ...postcondition } = verified;
    assert.deepEqual(postcondition, { path: mutation.source_path, parent_id: "track", provider_file_id: mutation.source_file_id,
      provider_file_version: directory ? "4" : "9" });
  }
});

test("the verifier refuses a changed version, owner, name, ancestor or a directory's sharing", async () => {
  for (const [label, mutation, change, code] of [
    ["version", fileMutation, d => { d.files.get("file").version = "11"; }, /VERSION_CHANGED/],
    ["owner", fileMutation, d => d.owned.delete("file"), /IDENTITY_MISMATCH/],
    ["twin", fileMutation, d => d.files.set("twin", { ...d.files.get("file"), id: "twin" }), /DESTINATION_AMBIGUOUS/],
    ["moved", fileMutation, d => { d.files.get("file").parents = ["dir"]; }, /DESTINATION_AMBIGUOUS|IDENTITY_MISMATCH/],
    ["folder", fileMutation, d => { d.files.get("track").name = "renamed"; }, /PARENT_AMBIGUOUS/],
    ["sharing", dirMutation, d => d.sharing.set("dir", SHARED), /SHARING_CHANGED/]]) {
    const f = await effectFixture(mutation);
    const effect = await f.effect(f.request);
    change(f.d);
    await assert.rejects(verifierFor(f.d)({ profile, mutation: f.request.mutation, provider_before: f.provider, effect_result: effect }), code, label);
  }
  // A directory whose sharing differs from its folder's is never proven.
  const d = drive(); d.sharing.set("dir", SHARED);
  const f = await effectFixture(dirMutation, d);
  const effect = await f.effect(f.request);
  await assert.rejects(verifierFor(d)({ profile, mutation: f.request.mutation, provider_before: f.provider, effect_result: effect }),
    /DRIVE_POSTCONDITION_REQUEST_MISMATCH/);
});

test("storage step 2: with an access reader, an adopted directory also carries its access digest", async () => {
  const { googleDriveAccessDigest } = await import("../../../kernel/host/resource-center-google-drive-sharing.mjs");
  const permissions = [{ id: "owner-permission", type: "user", role: "owner" }];
  const verify = async (mutation, getAccess) => {
    const f = await effectFixture(mutation);
    const effect = await f.effect(f.request);
    const base = { managed_root: ROOT, root_folder_id: "root", root_parent_id: "container", get_file: f.d.getFile,
      list_children: f.d.listChildren, get_ownership: f.d.getOwnership, get_sharing: f.d.getSharing, include_verified_proof: true };
    return (await createGoogleDriveAdoptPostconditionVerifier({ ...base, ...(getAccess ? { get_access: getAccess } : {}) })({
      profile, mutation: f.request.mutation, provider_before: f.provider, effect_result: effect })).verified_proof;
  };
  const proof = await verify(dirMutation, async (id) => ({ id, permissions }));
  assert.equal(proof.provider_access_digest, googleDriveAccessDigest({ permissions }));
  assert.equal(proof.provider_sharing_digest, googleDriveSharingDigest(PRIVATE));
  // A file, no reader, a failed or foreign read: no access digest, and the adopt still verifies.
  assert.equal("provider_access_digest" in await verify(fileMutation, async (id) => ({ id, permissions })), false);
  assert.equal("provider_access_digest" in await verify(dirMutation), false);
  assert.equal("provider_access_digest" in await verify(dirMutation, async () => { throw new Error("DRIVE_METADATA_UNAVAILABLE"); }), false);
  assert.equal("provider_access_digest" in await verify(dirMutation, async () => ({ id: "track", permissions })), false);
});
