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
