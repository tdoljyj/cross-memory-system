import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoogleDriveNativeDirectoryMoveEffect, directoryMoveShape, directoryMoveProviderBefore, subtreeSampleShape,
  SUBTREE_SAMPLE_LIMIT } from "../../../kernel/host/resource-center-google-drive-directory-move-effect.mjs";
import { createGoogleDriveDirectoryMovePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-directory-move-postcondition.mjs";
import { googleDriveAccessDigest, googleDriveSharingDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";
import { evaluateResourceCenterMutation } from "../../../kernel/policy/resource-center-mutation-policy.mjs";

// StorageFullCapability.v0.1 P6: the Drive directory move effect and
// verifier, against an in-memory Drive. Never Google.
const ROOT = "G:/test/Clued_资料中心", TRACK = ROOT + "/20_P_产品与体验";
const profile = { profile_id: "subtree-test", profile_version: "test/1", managed_root: ROOT };
const intent = "10000000-0000-4000-8000-000000000006";
const SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const FOLDER = "application/vnd.google-apps.folder";
const folder = (id, name, parent, version = "1") => ({ id, name, parents: [parent], version, trashed: false, mimeType: FOLDER });
const SHARING = { shared: false, permissionIds: ["owner-permission"] };
const DIGEST = googleDriveSharingDigest(SHARING);
const PERMISSIONS = [{ id: "owner-permission", type: "user", role: "owner" }, { id: "u", type: "user", role: "reader" }];
const ACCESS = googleDriveAccessDigest({ permissions: PERMISSIONS });
const SAMPLE = [
  { provider_file_id: "inner", relative_path: "inner", target_kind: "directory" },
  { provider_file_id: "note", relative_path: "note.md", target_kind: "file" },
  { provider_file_id: "deep", relative_path: "inner/deep.md", target_kind: "file" },
];

function drive() {
  const files = new Map([["root", folder("root", "Clued_资料中心", "container")], ["track", folder("track", "20_P_产品与体验", "root")],
    ["topic", folder("topic", "topic", "track")], ["dir", folder("dir", "folder", "track", "17")],
    ["inner", folder("inner", "inner", "dir")],
    ["note", { id: "note", name: "note.md", parents: ["dir"], version: "3", trashed: false, mimeType: "text/markdown" }],
    ["deep", { id: "deep", name: "deep.md", parents: ["inner"], version: "4", trashed: false, mimeType: "text/markdown" }]]);
  const sharing = new Map([...files.keys()].map(id => [id, structuredClone(SHARING)]));
  const access = new Map([...files.keys()].map(id => [id, structuredClone(PERMISSIONS)]));
  return { files, sharing, access, getFile: async id => structuredClone(files.get(id)),
    getSharing: async id => ({ id, ...structuredClone(sharing.get(id)) }),
    getAccess: async id => ({ id, permissions: structuredClone(access.get(id)) }),
    listChildren: async ({ parent_id, name }) => [...files.values()].filter(f => f.parents.includes(parent_id) && f.name === name).map(f => structuredClone(f)) };
}
const before = () => ({ root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
  source_file_id: "dir", source_file_version: "17", destination_parent_id: "topic", destination_parent_version: "1",
  destination_file_id: null, destination_file_version: null, provider_version: "a".repeat(64),
  root_sharing_digest: DIGEST, destination_parent_sharing_digest: DIGEST,
  source_parent_id: "track", source_sharing_digest: DIGEST, source_parent_sharing_digest: DIGEST,
  source_access_digest: ACCESS, source_parent_access_digest: ACCESS, destination_parent_access_digest: ACCESS });
const moveMutation = { operation: "move", target_kind: "directory", source_path: TRACK + "/folder", destination_path: TRACK + "/topic/folder",
  source_file_version: "17", source_file_id: "dir" };
// As the Host passes it: the submitted fields plus its own authority fields.
const hostMutation = { ...moveMutation, artifact_id: "artifact-dir", artifact_role: "clued_resource", governance_class: "ordinary",
  delete_authority: false, artifact_authority_version: "a:1:1", currentness_identity: "decision:d:1", workspace_version: "p:1:1" };

function effectFixture(d = drive(), overrides = {}, mutation = hostMutation) {
  const events = [], provider = before();
  const binding = { profile_id: profile.profile_id, request_sha256: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") };
  let consumed = false, attempt;
  const effect = createGoogleDriveNativeDirectoryMoveEffect({ trusted_profile: profile, get_file: d.getFile,
    get_credential: async () => ({ access_token: "subtree-test-access-token", scope: SCOPE }),
    resolve_provider_identity: async () => ({ ...provider }),
    consume_started_provider: () => consumed ? null : (consumed = true, { intent_id: intent, request_sha256: binding.request_sha256, provider,
      subtree_sample: SAMPLE }),
    persist_provider_attempt: async value => { events.push("persist"); attempt = value; },
    fetch: async (url, options) => {
      events.push("patch");
      assert.equal(options.method, "PATCH"); assert.equal(options.redirect, "error"); assert.equal(options.body, "{}");
      assert.equal(events.at(-2), "persist", "the attempt is durable before the only update");
      const u = new URL(url), file = d.files.get(u.pathname.split("/").at(-1));
      assert.equal(u.searchParams.get("removeParents"), file.parents[0]);
      file.parents = [u.searchParams.get("addParents")];
      file.version = String(Number(file.version) + 3);
      return Response.json(file);
    }, ...overrides });
  return { effect, events, d, attempt: () => attempt,
    request: { mutation, admission: { binding, expires_at_ms: Date.now() + 30000 }, profile_identity: profile } };
}

test("directoryMoveShape accepts only a same-name move of one directory, named by Drive ID, to another folder outside itself", () => {
  assert.ok(directoryMoveShape(moveMutation)); assert.ok(directoryMoveShape(hostMutation));
  for (const bad of [{ ...moveMutation, destination_path: TRACK + "/topic/renamed" }, { ...moveMutation, destination_path: moveMutation.source_path },
    { ...moveMutation, destination_path: TRACK + "/folder/inner/folder" }, { ...moveMutation, destination_path: TRACK + "/other" },
    { ...moveMutation, target_kind: "file" }, { ...moveMutation, operation: "rename" }, { ...moveMutation, source_file_version: "0" },
    { ...moveMutation, source_file_id: "bad id" }, { ...moveMutation, source_file_id: undefined }, { ...moveMutation, content: "x" },
    { ...moveMutation, directory_semantics: "topic" }, { ...moveMutation, restore_mode: "folder" },
    { ...moveMutation, destination_path: TRACK + "/topic/../folder" }]) {
    assert.equal(directoryMoveShape(JSON.parse(JSON.stringify(bad))), null, JSON.stringify(bad));
  }
});

test("the subtree sample is at most ten distinct descendants with clean relative paths", () => {
  assert.deepEqual(subtreeSampleShape(SAMPLE), SAMPLE); assert.deepEqual(subtreeSampleShape([]), []);
  assert.equal(SUBTREE_SAMPLE_LIMIT, 10);
  const many = Array.from({ length: 11 }, (_, i) => ({ provider_file_id: "f" + i, relative_path: "f" + i, target_kind: "file" }));
  for (const bad of [null, {}, many, [SAMPLE[0], SAMPLE[0]], [{ ...SAMPLE[0], relative_path: "a/../b" }],
    [{ ...SAMPLE[0], relative_path: "" }], [{ ...SAMPLE[0], relative_path: "a//b" }], [{ ...SAMPLE[0], target_kind: "link" }],
    [{ ...SAMPLE[0], extra: 1 }], [{ ...SAMPLE[0], provider_file_id: "bad id" }]]) assert.equal(subtreeSampleShape(bad), null);
});

test("the access digest covers every permission with its role, in any order, and fails closed", () => {
  assert.match(ACCESS, /^[0-9a-f]{64}$/);
  assert.equal(googleDriveAccessDigest({ permissions: [...PERMISSIONS].reverse() }), ACCESS);
  assert.notEqual(googleDriveAccessDigest({ permissions: [PERMISSIONS[0], { ...PERMISSIONS[1], role: "writer" }] }), ACCESS,
    "a role change with the same grantee changes the digest (the sharing digest would not)");
  assert.equal(googleDriveSharingDigest({ shared: false, permissionIds: ["owner-permission", "u"] }),
    googleDriveSharingDigest({ shared: false, permissionIds: ["u", "owner-permission"] }));
  for (const bad of [null, {}, { permissions: [] }, { permissions: [{ id: "x" }] }, { permissions: [{ id: "bad id", type: "user", role: "reader" }] },
    { permissions: [{ ...PERMISSIONS[0], allowFileDiscovery: "yes" }] }]) assert.equal(googleDriveAccessDigest(bad), null);
});

test("the provider identity must name both folders with the same sharing state", () => {
  const shape = directoryMoveShape(moveMutation);
  assert.equal(directoryMoveProviderBefore(shape, before()), true);
  for (const change of [{ destination_parent_sharing_digest: "b".repeat(64) }, { source_parent_sharing_digest: null },
    { source_sharing_digest: null }, { source_parent_id: null }, { destination_parent_access_digest: "c".repeat(64) },
    { source_access_digest: null }, { source_parent_access_digest: null }, { destination_parent_id: "track" }, { destination_parent_id: "dir" },
    { destination_file_id: "x" }, { source_file_version: "16" }, { source_file_id: "other" }]) {
    assert.equal(directoryMoveProviderBefore(shape, { ...before(), ...change }), false, JSON.stringify(change));
  }
});

test("the mutation policy admits a directory move without directory semantics but keeps destination status checks", () => {
  const p = { managed_root: ROOT, allowed_root_children: ["20_P_产品与体验"] };
  const base = { profile: p, ...moveMutation, artifact_role: "clued_resource" };
  assert.equal(evaluateResourceCenterMutation(base).status, "allow");
  assert.equal(evaluateResourceCenterMutation({ ...base, operation: "rename" }).error_code, "DIRECTORY_SEMANTICS_REQUIRED");
  assert.equal(evaluateResourceCenterMutation({ ...base, destination_path: TRACK + "/历史/folder" }).error_code, "STATUS_SEMANTIC_DIRECTORY_FORBIDDEN");
  assert.equal(evaluateResourceCenterMutation({ ...base, destination_path: ROOT + "/30_other/folder" }).error_code, "RESOURCE_CENTER_ROOT_CHILD_FORBIDDEN");
});

test("a directory move records the exact attempt with the server sample, then moves by one PATCH", async () => {
  const f = effectFixture();
  const result = await f.effect(f.request);
  assert.deepEqual(f.events, ["persist", "patch"]);
  assert.deepEqual(f.attempt(), { contract: "clued.storage-subtree-move-attempt/1", intent_id: intent,
    request_sha256: f.request.admission.binding.request_sha256, profile_id: profile.profile_id, operation: "move", target_kind: "directory",
    provider_file_id: "dir", source_path: moveMutation.source_path, source_file_version: "17", source_parent_id: "track",
    destination_path: moveMutation.destination_path, parent_id: "topic", subtree_sample: SAMPLE, binding: f.request.admission.binding });
  assert.deepEqual(result, { operation: "move", target_kind: "directory", source_path: moveMutation.source_path,
    destination_path: moveMutation.destination_path, provider_file_id: "dir", provider_file_version: "20", subtree_sample: SAMPLE, intent_id: intent });
  assert.deepEqual(f.d.files.get("dir").parents, ["topic"]);
  assert.deepEqual(f.d.files.get("note").parents, ["dir"], "children keep their parent: the whole subtree moves");
});

test("a changed directory, a missing durable start, unequal sharing or a changed identity never reaches the update", async () => {
  const cases = [
    ["DRIVE_NATIVE_SOURCE_VERSION_MISMATCH", f => { f.d.files.get("dir").version = "18"; }],
    ["DRIVE_NATIVE_SOURCE_MISMATCH", f => { f.d.files.get("dir").trashed = true; }],
    ["DRIVE_NATIVE_SOURCE_MISMATCH", f => { f.d.files.get("dir").parents = ["topic"]; }],
    ["DRIVE_NATIVE_SOURCE_MISMATCH", f => { f.d.files.get("dir").mimeType = "text/plain"; }],
    ["DRIVE_NATIVE_REQUEST_MISMATCH", f => { f.request = { ...f.request, mutation: { ...hostMutation, destination_path: TRACK + "/topic/renamed" } }; }],
  ];
  for (const [code, mutate] of cases) {
    const f = effectFixture(); mutate(f);
    await assert.rejects(f.effect(f.request), new RegExp(code));
    assert.equal(f.events.includes("patch"), false, code);
  }
  const differs = effectFixture(drive(), { resolve_provider_identity: async () => ({ ...before(), destination_parent_sharing_digest: "b".repeat(64) }) });
  await assert.rejects(differs.effect(differs.request), /DRIVE_NATIVE_PROVIDER_CHANGED/);
  assert.deepEqual(differs.events, []);
  let calls = 0;
  const changed = effectFixture(drive(), { resolve_provider_identity: async () => ({ ...before(), provider_version: ++calls > 1 ? "b".repeat(64) : "a".repeat(64) }) });
  await assert.rejects(changed.effect(changed.request), /DRIVE_NATIVE_PROVIDER_CHANGED/);
  assert.deepEqual(changed.events, ["persist"], "a change after the durable flush stops before the update");
  const unstarted = effectFixture(drive(), { consume_started_provider: () => null });
  await assert.rejects(unstarted.effect(unstarted.request), /DRIVE_NATIVE_DURABLE_START_REQUIRED/);
  const expired = effectFixture();
  expired.request.admission.expires_at_ms = Date.now() - 1;
  await assert.rejects(expired.effect(expired.request), /DRIVE_NATIVE_ADMISSION_EXPIRED/);
  assert.equal(expired.events.includes("patch"), false);
  const noSample = effectFixture(drive(), { consume_started_provider: () => ({ intent_id: intent,
    request_sha256: noSampleHash, provider: before(), subtree_sample: [{ provider_file_id: "x" }] }) });
  await assert.rejects(noSample.effect(noSample.request), /DRIVE_NATIVE_DURABLE_START_REQUIRED/);
  assert.deepEqual(noSample.events, []);
  const r = drive(), wrong = effectFixture(r, { fetch: async () => {
    const file = r.files.get("dir"); file.parents = ["track"]; file.version = "20"; return Response.json(file);
  } });
  await assert.rejects(wrong.effect(wrong.request), /DRIVE_NATIVE_RESPONSE_MISMATCH/);
});

const noSampleHash = createHash("sha256").update(JSON.stringify(hostMutation)).digest("hex");

test("a registered descendant that drifted in Drive is refused before the attempt, or after the flush before the update", async () => {
  const early = effectFixture();
  early.d.files.get("note").name = "renamed.md";
  await assert.rejects(early.effect(early.request), /DRIVE_NATIVE_SUBTREE_DRIFT/);
  assert.deepEqual(early.events, [], "nothing is recorded or moved");
  let reads = 0; const d = drive(), getFile = d.getFile;
  d.getFile = async id => { const f = await getFile(id); if (id === "deep" && ++reads === 2) f.parents = ["dir"]; return f; };
  const late = effectFixture(d);
  await assert.rejects(late.effect(late.request), /DRIVE_NATIVE_SUBTREE_DRIFT/);
  assert.deepEqual(late.events, ["persist"], "a drift after the durable flush stops before the update");
});

function verifier(d, extra = {}) {
  let now = 0;
  return createGoogleDriveDirectoryMovePostconditionVerifier({ managed_root: ROOT, root_folder_id: "root", root_parent_id: "container",
    get_file: d.getFile, list_children: d.listChildren, get_sharing: d.getSharing, get_access: d.getAccess, include_verified_proof: true,
    timeout_ms: 3000, poll_ms: 1000, clock: () => now, sleep: async ms => { now += ms; }, ...extra });
}
const effectResult = (sample = SAMPLE) => ({ operation: "move", target_kind: "directory", source_path: moveMutation.source_path,
  destination_path: moveMutation.destination_path, provider_file_id: "dir", provider_file_version: "20", subtree_sample: sample });
const moved = () => { const d = drive(); Object.assign(d.files.get("dir"), { parents: ["topic"], version: "20" }); return d; };

test("the verifier proves a directory move from metadata, sharing and the sampled subtree", async () => {
  const result = await verifier(moved())({ profile, mutation: hostMutation, provider_before: before(), effect_result: effectResult() });
  assert.deepEqual({ ...result, verified_proof: undefined }, { path: moveMutation.destination_path, parent_id: "topic",
    provider_file_id: "dir", provider_file_version: "20", verified_proof: undefined });
  assert.deepEqual(result.verified_proof, { contract: "clued.storage-directory-move-verified/1", path: moveMutation.destination_path,
    parent_id: "topic", provider_file_id: "dir", provider_file_version: "20", operation: "move", target_kind: "directory",
    source_path: moveMutation.source_path, source_file_version: "17", subtree_sample: SAMPLE, provider_before: before(),
    checks: { identity: true, ancestors: true, stable_state: true, unique_name: true, source_vacated: true, sharing_unchanged: true, subtree: true } });
  const empty = await verifier(moved())({ profile, mutation: hostMutation, provider_before: before(), effect_result: effectResult([]) });
  assert.deepEqual(empty.verified_proof.subtree_sample, []);
});

test("the verifier fails closed on a wrong parent, changed sharing, a broken subtree, a leftover entry or no move", async () => {
  const cases = [
    ["DRIVE_POSTCONDITION_IDENTITY_MISMATCH", d => { d.files.get("dir").parents = ["topic", "track"]; }],
    ["DRIVE_POSTCONDITION_SHARING_CHANGED", d => { d.sharing.set("dir", { shared: true, permissionIds: ["owner-permission", "anyone"] }); }],
    ["DRIVE_POSTCONDITION_SHARING_CHANGED", d => { d.access.set("dir", [PERMISSIONS[0], { ...PERMISSIONS[1], role: "writer" }]); }],
    ["DRIVE_POSTCONDITION_SUBTREE_MISMATCH", d => { d.files.get("deep").parents = ["dir"]; }],
    ["DRIVE_POSTCONDITION_SUBTREE_MISMATCH", d => { d.files.get("note").trashed = true; }],
    ["DRIVE_POSTCONDITION_SUBTREE_MISMATCH", d => { d.files.get("inner").name = "renamed"; }],
    ["DRIVE_POSTCONDITION_SUBTREE_MISMATCH", d => { d.files.get("inner").mimeType = "text/plain"; }],
    ["DRIVE_POSTCONDITION_ANCESTOR_CHANGED", d => { d.files.get("topic").parents = ["elsewhere"]; d.files.set("topic2", folder("topic2", "topic", "track")); }],
    ["DRIVE_POSTCONDITION_SYNC_TIMEOUT", d => {
      d.listChildren = async ({ parent_id, name }) => parent_id === "track" && name === "folder" ? [{ id: "dir", name, parents: ["track"], version: "20" }]
        : [...d.files.values()].filter(f => f.parents.includes(parent_id) && f.name === name).map(f => structuredClone(f)); }],
    ["DRIVE_POSTCONDITION_IDENTITY_MISMATCH", d => { d.files.set("other", folder("other", "folder", "topic")); d.files.get("dir").parents = ["track"]; }],
  ];
  for (const [code, mutate] of cases) {
    const d = moved(); mutate(d);
    await assert.rejects(verifier(d)({ profile, mutation: hostMutation, provider_before: before(), effect_result: effectResult() }),
      new RegExp(code), code);
  }
  const unmoved = drive();
  await assert.rejects(verifier(unmoved)({ profile, mutation: hostMutation, provider_before: before(), effect_result: effectResult() }),
    /DRIVE_POSTCONDITION_SYNC_TIMEOUT/);
  for (const [provider, result] of [[{ ...before(), source_parent_sharing_digest: "b".repeat(64) }, effectResult()],
    [before(), { ...effectResult(), provider_file_id: "other" }], [before(), effectResult([{ provider_file_id: "x" }])],
    [before(), { ...effectResult(), target_kind: "file" }]]) {
    await assert.rejects(verifier(moved())({ profile, mutation: hostMutation, provider_before: provider, effect_result: result }),
      /DRIVE_POSTCONDITION_REQUEST_MISMATCH/);
  }
  assert.throws(() => verifier(moved(), { get_sharing: undefined }), TypeError);
  assert.throws(() => verifier(moved(), { get_access: undefined }), TypeError);
});

test("a directory version still settling is re-read until two observations agree, and folder versions are not pinned", async () => {
  const d = moved(); d.files.get("topic").version = "9"; d.files.get("root").version = "4";
  let reads = 0; const getFile = d.getFile;
  d.getFile = async id => { const f = await getFile(id); if (id === "dir" && ++reads === 1) f.version = "21"; return f; };
  const result = await verifier(d, { get_file: d.getFile })({ profile, mutation: hostMutation, provider_before: before(), effect_result: effectResult() });
  assert.equal(result.provider_file_version, "20"); assert.ok(reads >= 3);
});
