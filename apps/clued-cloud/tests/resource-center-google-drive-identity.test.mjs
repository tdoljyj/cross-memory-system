import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleDriveProviderIdentityResolver } from "../../../kernel/host/resource-center-google-drive-identity.mjs";

const root = "G:/我的云端硬盘/Clued_资料中心";
const folderMime = "application/vnd.google-apps.folder";
const file = (id, name, parent, version, folder = false) => ({
  id, name, parents: [parent], version, trashed: false,
  mimeType: folder ? folderMime : "text/markdown",
});

function fixture(overrides = {}) {
  const files = [
    file("root-id", "Clued_资料中心", "drive-root", "1", true),
    file("inbox", "90_待归类", "root-id", "2", true),
    file("track", "20_P_产品与体验", "root-id", "3", true),
    file("topic", "品牌与视觉", "track", "4", true),
    file("source", "a.md", "inbox", "5"),
  ];
  const list = overrides.list_children ?? (async ({ parent_id: parentId, name }) =>
    files.filter((item) => item.parents.includes(parentId) && item.name === name));
  const resolve = createGoogleDriveProviderIdentityResolver({
    managed_root: root, root_folder_id: "root-id", root_parent_id: "drive-root",
    get_file: overrides.get_file ?? (async (id) => files.find((item) => item.id === id)),
    list_children: list,
  });
  return { files, resolve };
}

test("Drive identity binds a normal track-to-topic move to exact IDs and versions", async () => {
  const { files, resolve } = fixture();
  const mutation = {
    operation: "move", target_kind: "file",
    source_path: `${root}/90_待归类/a.md`,
    destination_path: `${root}/20_P_产品与体验/品牌与视觉/a.md`,
  };
  const identity = await resolve({ profile: { managed_root: root }, mutation });
  assert.equal(identity.root_folder_id, "root-id");
  assert.equal(identity.root_parent_id, "drive-root");
  assert.equal(identity.root_folder_version, "1");
  assert.equal(identity.source_file_id, "source");
  assert.equal(identity.source_file_version, "5");
  assert.equal(identity.destination_parent_id, "topic");
  assert.equal(identity.destination_parent_version, "4");
  assert.equal(identity.destination_file_id, null);
  assert.match(identity.provider_version, /^[0-9a-f]{64}$/);
  files.find((item) => item.id === "source").version = "6";
  assert.notEqual((await resolve({ profile: { managed_root: root }, mutation })).provider_version,
    identity.provider_version);
});

test("Drive identity refuses duplicate names and unregistered parent paths", async () => {
  const { files, resolve } = fixture();
  const mutation = {
    operation: "create", target_kind: "file",
    destination_path: `${root}/20_P_产品与体验/品牌与视觉/new.md`,
  };
  files.push(file("duplicate-1", "品牌与视觉", "track", "9", true));
  await assert.rejects(resolve({ profile: { managed_root: root }, mutation }), /PROVIDER_PATH_AMBIGUOUS/);
  files.pop();
  await assert.rejects(resolve({ profile: { managed_root: root }, mutation: {
    ...mutation, destination_path: `${root}/20_P_产品与体验/未登记/new.md`,
  } }), /PROVIDER_PATH_UNREGISTERED/);
});

test("Drive identity refuses root moves, fake root metadata, collisions and sibling islands", async () => {
  const { files, resolve } = fixture();
  const create = { operation: "create", target_kind: "file", destination_path: `${root}/90_待归类/a.md` };
  await assert.rejects(resolve({ profile: { managed_root: root }, mutation: create }), /PROVIDER_DESTINATION_EXISTS/);
  await assert.rejects(resolve({ profile: { managed_root: root }, mutation: {
    ...create, destination_path: "G:/我的云端硬盘/Clued_孤岛/a.md",
  } }), /PROVIDER_PATH_OUTSIDE_REGISTERED_ROOT/);
  files[0].parents = ["other-root"];
  await assert.rejects(resolve({ profile: { managed_root: root }, mutation: create }), /PROVIDER_METADATA_MISMATCH/);
});

test("existing-file write requires an exact destination ID", async () => {
  const { files, resolve } = fixture();
  const mutation = { operation: "write", target_kind: "file",
    destination_path: `${root}/90_待归类/a.md` };
  const identity = await resolve({ profile: { managed_root: root }, mutation });
  assert.equal(identity.destination_parent_id, "inbox");
  assert.equal(identity.destination_file_id, "source");
  files.push(file("collision", "a.md", "inbox", "6"));
  await assert.rejects(resolve({ profile: { managed_root: root }, mutation }), /PROVIDER_PATH_AMBIGUOUS/);
});

test("Drive identity carries root and parent sharing digests that change with permissions, not versions", async () => {
  const sharingState = new Map([["root-id", { shared: false, permissionIds: ["owner"] }],
    ["topic", { shared: false, permissionIds: ["owner"] }]]);
  const files = [
    file("root-id", "Clued_资料中心", "drive-root", "1", true),
    file("track", "20_P_产品与体验", "root-id", "3", true),
    file("topic", "品牌与视觉", "track", "4", true),
  ];
  const sharingReads = [];
  const resolve = createGoogleDriveProviderIdentityResolver({
    managed_root: root, root_folder_id: "root-id", root_parent_id: "drive-root",
    get_file: async (id) => files.find((item) => item.id === id),
    list_children: async ({ parent_id: parentId, name }) =>
      files.filter((item) => item.parents.includes(parentId) && item.name === name),
    get_sharing: async (id) => { sharingReads.push(id); return { id, ...sharingState.get(id) }; },
  });
  const mutation = { operation: "create", target_kind: "file",
    destination_path: `${root}/20_P_产品与体验/品牌与视觉/new.md` };
  const first = await resolve({ profile: { managed_root: root }, mutation });
  assert.deepEqual(sharingReads, ["root-id", "topic"]);
  assert.match(first.root_sharing_digest, /^[0-9a-f]{64}$/);
  assert.match(first.destination_parent_sharing_digest, /^[0-9a-f]{64}$/);

  files.find((item) => item.id === "topic").version = "5";
  const bumped = await resolve({ profile: { managed_root: root }, mutation });
  assert.equal(bumped.destination_parent_sharing_digest, first.destination_parent_sharing_digest);
  assert.notEqual(bumped.provider_version, first.provider_version);

  sharingState.set("topic", { shared: true, permissionIds: ["anyoneWithLink", "owner"] });
  const shared = await resolve({ profile: { managed_root: root }, mutation });
  assert.notEqual(shared.destination_parent_sharing_digest, first.destination_parent_sharing_digest);
  assert.equal(shared.root_sharing_digest, first.root_sharing_digest);

  sharingState.set("root-id", { shared: false });
  assert.equal((await resolve({ profile: { managed_root: root }, mutation })).root_sharing_digest, null);
  const { resolve: withoutSharing } = fixture();
  const plain = await withoutSharing({ profile: { managed_root: root }, mutation });
  assert.equal(plain.root_sharing_digest, null);
  assert.equal(plain.destination_parent_sharing_digest, null);
});

test("P6.2: a directory move records its source folder's Drive version; other operations do not", async () => {
  const { files, resolve } = fixture();
  files.push(file("dir", "资料夹", "inbox", "7", true));
  const move = { operation: "move", target_kind: "directory", source_path: `${root}/90_待归类/资料夹`,
    destination_path: `${root}/20_P_产品与体验/品牌与视觉/资料夹` };
  const identity = await resolve({ profile: { managed_root: root }, mutation: move });
  assert.equal(identity.source_parent_id, "inbox");
  assert.equal(identity.source_parent_version, "2");
  assert.equal(identity.destination_parent_version, "4");
  const fileMove = await resolve({ profile: { managed_root: root }, mutation: {
    operation: "move", target_kind: "file", source_path: `${root}/90_待归类/a.md`,
    destination_path: `${root}/20_P_产品与体验/品牌与视觉/a.md` } });
  assert.equal("source_parent_version" in fileMove, false);
});

test("step 3: with ancestor_match the identity names each walked folder by its digest or version", async () => {
  const { googleDriveAccessDigest, googleDriveSharingDigest } = await import("../../../kernel/host/resource-center-google-drive-sharing.mjs");
  const { EMPTY_PROVIDER_VERSION, ancestorMatchShape } = await import("../../../kernel/host/resource-center-google-drive-identity.mjs");
  const files = [
    file("root-id", "Clued_资料中心", "drive-root", "1", true),
    file("inbox", "90_待归类", "root-id", "2", true),
    file("track", "20_P_产品与体验", "root-id", "3", true),
    file("topic", "品牌与视觉", "track", "4", true),
    file("source", "a.md", "inbox", "5"),
  ];
  const permissions = new Map([["root-id", [{ id: "owner", type: "user", role: "owner" }]],
    ["track", [{ id: "owner", type: "user", role: "owner" }, { id: "w", type: "user", role: "writer" }]]]);
  const reads = [];
  const make = (ancestorMatch, extra = {}) => createGoogleDriveProviderIdentityResolver({
    managed_root: root, root_folder_id: "root-id", root_parent_id: "drive-root",
    get_file: async id => files.find(item => item.id === id),
    list_children: async ({ parent_id: parentId, name }) => files.filter(item => item.parents.includes(parentId) && item.name === name),
    get_sharing: async id => { reads.push("sharing:" + id); return { id, shared: false, permissionIds: ["owner"] }; },
    get_access: async id => { reads.push("access:" + id); return { id, permissions: permissions.get(id) ?? [] }; },
    ancestor_match: ancestorMatch, ...extra,
  });
  const descriptor = [
    { path: root, provider_file_id: "root-id", match: "access" },
    { path: `${root}/20_P_产品与体验`, provider_file_id: "track", match: "access" },
    { path: `${root}/20_P_产品与体验/品牌与视觉`, provider_file_id: "topic", match: "sharing" },
  ];
  const create = { operation: "create", target_kind: "file", destination_path: `${root}/20_P_产品与体验/品牌与视觉/new.md` };
  const first = await make(descriptor)({ profile: { managed_root: root }, mutation: create });
  assert.deepEqual(first.ancestors, [
    { path: root, id: "root-id", parent_id: "drive-root", match: "access", value: googleDriveAccessDigest({ permissions: permissions.get("root-id") }) },
    { path: `${root}/20_P_产品与体验`, id: "track", parent_id: "root-id", match: "access",
      value: googleDriveAccessDigest({ permissions: permissions.get("track") }) },
    { path: `${root}/20_P_产品与体验/品牌与视觉`, id: "topic", parent_id: "track", match: "sharing",
      value: googleDriveSharingDigest({ shared: false, permissionIds: ["owner"] }) },
  ]);
  assert.equal(first.root_folder_version, null);
  assert.equal(first.destination_parent_version, null);
  assert.equal(first.provider_version, EMPTY_PROVIDER_VERSION);
  // Each folder's sharing and access are read once per resolution.
  assert.deepEqual(reads.filter(r => r === "sharing:topic").length, 1);
  // A sibling change moves folder versions only: the identity is unchanged.
  for (const id of ["root-id", "track", "topic"]) files.find(item => item.id === id).version = "40";
  assert.deepEqual(await make(descriptor)({ profile: { managed_root: root }, mutation: create }), first);
  // A changed role changes the identity.
  permissions.set("track", [{ id: "owner", type: "user", role: "owner" }, { id: "w", type: "user", role: "reader" }]);
  assert.notDeepEqual((await make(descriptor)({ profile: { managed_root: root }, mutation: create })).ancestors, first.ancestors);
  // A version-matched folder (or one the server did not describe) keeps its
  // version, in provider_version too.
  const versioned = descriptor.map((entry, index) => index === 2 ? { ...entry, match: "version" } : entry);
  const byVersion = await make(versioned)({ profile: { managed_root: root }, mutation: create });
  assert.equal(byVersion.destination_parent_version, "40");
  assert.equal(byVersion.ancestors[2].value, "40");
  assert.notEqual(byVersion.provider_version, EMPTY_PROVIDER_VERSION);
  const undescribed = await make(descriptor.slice(0, 2))({ profile: { managed_root: root }, mutation: create });
  assert.equal(undescribed.ancestors[2].match, "version");
  assert.equal(undescribed.provider_version, byVersion.provider_version);
  files.find(item => item.id === "topic").version = "41";
  assert.notEqual((await make(versioned)({ profile: { managed_root: root }, mutation: create })).provider_version, byVersion.provider_version);
  // An unreadable digest is null, never a match.
  const unreadable = await make(descriptor, { get_access: async () => { throw new Error("DRIVE_METADATA_UNAVAILABLE"); } });
  await assert.rejects(unreadable({ profile: { managed_root: root }, mutation: create }), /DRIVE_METADATA_UNAVAILABLE/);
  const foreign = await make(descriptor, { get_access: async () => ({ id: "elsewhere", permissions: [] }) })({ profile: { managed_root: root }, mutation: create });
  assert.equal(foreign.ancestors[0].value, null);
  // A file move walks both folders; the source and target keep their versions.
  const move = { operation: "move", target_kind: "file", source_path: `${root}/90_待归类/a.md`, destination_path: `${root}/20_P_产品与体验/a.md` };
  const moved = await make([...descriptor, { path: `${root}/90_待归类`, provider_file_id: "inbox", match: "access" }])({ profile: { managed_root: root }, mutation: move });
  assert.deepEqual(moved.ancestors.map(entry => entry.path), [root, `${root}/20_P_产品与体验`, `${root}/90_待归类`]);
  assert.equal(moved.source_file_version, "5");
  assert.equal(moved.destination_parent_version, null);
  // Adopt keeps its version fields and the legacy provider_version.
  const adopt = { operation: "adopt", target_kind: "file", source_path: `${root}/90_待归类/a.md` };
  const legacy = await make(undefined)({ profile: { managed_root: root }, mutation: adopt });
  const adopted = await make([...descriptor, { path: `${root}/90_待归类`, provider_file_id: "inbox", match: "access" }])({ profile: { managed_root: root }, mutation: adopt });
  assert.equal(adopted.root_folder_version, legacy.root_folder_version);
  assert.equal(adopted.source_parent_version, legacy.source_parent_version);
  assert.equal(adopted.provider_version, legacy.provider_version);
  assert.deepEqual(adopted.ancestors.map(entry => entry.path), [root, `${root}/90_待归类`]);
  assert.equal("ancestors" in legacy, false);
  // The descriptor shape.
  for (const bad of [{}, [{ path: root, provider_file_id: "root-id" }], [{ path: root, provider_file_id: "root-id", match: "name" }],
    [{ path: "G:/elsewhere", provider_file_id: "x", match: "version" }], [descriptor[0], descriptor[0]],
    [{ ...descriptor[0], provider_file_id: "bad id" }], Array.from({ length: 65 }, (_, i) => ({ path: `${root}/${i}`, provider_file_id: "x", match: "version" }))]) {
    assert.equal(ancestorMatchShape(bad, root), null);
    assert.throws(() => make(bad), TypeError);
  }
  assert.deepEqual(ancestorMatchShape([], root), []);
});
