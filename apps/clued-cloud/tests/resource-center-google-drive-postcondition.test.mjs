import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoogleDriveCreatePostconditionVerifier } from "../../../kernel/host/resource-center-google-drive-postcondition.mjs";

const root = "G:/pilot/Clued_资料中心";
const folder = "application/vnd.google-apps.folder";
const metadata = (id, name, parent, extra = {}) => ({ id, name, parents: [parent],
  version: "1", trashed: false, mimeType: folder, ...extra });
function fixture({ file = false, missing = 0, alter = () => {}, options = {} } = {}) {
  const content = "合成测试\n";
  const files = { root: metadata("root", "Clued_资料中心", "container"),
    track: metadata("track", "20_P_产品与体验", "root"),
    topic: metadata("topic", "topic", "track", file ? { mimeType: "text/plain",
      size: String(Buffer.byteLength(content)), sha256Checksum: createHash("sha256").update(content).digest("hex") } : {}) };
  let now = 0;
  let targetLists = 0;
  let gets = 0;
  const verify = createGoogleDriveCreatePostconditionVerifier({ managed_root: root,
    root_folder_id: "root", root_parent_id: "container", timeout_ms: 100, poll_ms: 10,
    clock: () => now, sleep: async (ms) => { now += ms; },
    get_file: async (id) => { gets++; alter(files, { get: id, gets, targetLists }); return structuredClone(files[id]); },
    list_children: async ({ parent_id: parent }) => {
      if (parent === "root") return [structuredClone(files.track)];
      targetLists++;
      alter(files, { targetLists });
      return targetLists <= missing ? [] : [structuredClone(files.topic)];
    }, ...options });
  const request = { profile: { managed_root: root }, mutation: { operation: "create",
    destination_path: `${root}/20_P_产品与体验/topic`, target_kind: file ? "file" : "directory", content },
    provider_before: { root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
      destination_parent_id: "track", destination_parent_version: "1", destination_file_id: null, destination_file_version: null,
      provider_version: createHash("sha256").update(JSON.stringify([["root", "1"], ["track", "1"]])).digest("hex") },
    effect_result: { operation: "create", destination_path: `${root}/20_P_产品与体验/topic` } };
  return { verify, request, files, stats: () => ({ now, gets, targetLists }) };
}
test("create waits for sync then pins provider ID/version and ancestor identity", async () => {
  const f = fixture({ missing: 2 });
  assert.deepEqual(await f.verify(f.request), { path: f.request.mutation.destination_path,
    parent_id: "track", provider_file_id: "topic", provider_file_version: "1" });
  assert.equal(f.stats().now, 20);
});
test("UTF-8 file contents are proved by SHA256 and byte count metadata", async () => {
  const f = fixture({ file: true });
  assert.equal((await f.verify(f.request)).provider_file_id, "topic");
  for (const patch of [{ size: "1" }, { sha256Checksum: undefined }, { sha256Checksum: "a".repeat(64) }]) {
    const bad = fixture({ file: true }); Object.assign(bad.files.topic, patch);
    await assert.rejects(bad.verify(bad.request), /CONTENT_MISMATCH/);
  }
});
test("sync timeout is bounded and does not retry the storage effect", async () => {
  const f = fixture({ missing: 100 });
  await assert.rejects(f.verify(f.request), /SYNC_TIMEOUT/);
  assert.equal(f.stats().now, 100);
  assert.equal(f.stats().targetLists, 11);
});
test("rejects wrong intent/profile/effect before looking up anything", async () => {
  for (const mutate of [(r) => r.mutation.operation = "replace", (r) => r.profile.managed_root = "G:/other",
    (r) => r.effect_result.destination_path += "-different", (r) => r.provider_before.destination_file_id = "existing"]) {
    const f = fixture(); mutate(f.request);
    await assert.rejects(f.verify(f.request), /REQUEST_MISMATCH/);
    assert.equal(f.stats().gets, 0);
  }
});
test("moved root/parent, trashed object and shortcut all deny", async () => {
  for (const [id, patch] of [["root", { parents: ["other"] }], ["track", { version: "2" }],
    ["track", { id: "replacement" }], ["topic", { trashed: true }],
    ["topic", { mimeType: "application/vnd.google-apps.shortcut" }]]) {
    const f = fixture(); Object.assign(f.files[id], patch);
    await assert.rejects(f.verify(f.request), /IDENTITY_MISMATCH|ANCESTOR_CHANGED/);
  }
});
test("concurrent version change never produces a successful receipt postcondition", async () => {
  const f = fixture({ alter: (files, event) => { if (event.get === "topic") files.topic.version = "2"; } });
  await assert.rejects(f.verify(f.request), /VERSION_CHANGED/);
});
test("duplicate destination and final duplicate race fail closed", async () => {
  for (const finalRace of [false, true]) {
    let calls = 0;
    const f = fixture({ options: { list_children: async ({ parent_id }) => {
      if (parent_id === "root") return [metadata("track", "20_P_产品与体验", "root")];
      calls++;
      return !finalRace || calls > 1 ? [metadata("topic", "topic", "track"), metadata("other", "topic", "track")]
        : [metadata("topic", "topic", "track")];
    } } });
    await assert.rejects(f.verify(f.request), /DESTINATION_AMBIGUOUS|VERSION_CHANGED/);
  }
});
test("credential/network errors are not converted into empty successful scans", async () => {
  const f = fixture({ options: { get_file: async () => { throw new Error("DRIVE_METADATA_UNAVAILABLE"); } } });
  await assert.rejects(f.verify(f.request), /DRIVE_METADATA_UNAVAILABLE/);
});

test("native postcondition requires the exact generated ID, not a same-name same-content substitute", async () => {
  const f = fixture({ options: { require_effect_provider_id: true } });
  await assert.rejects(f.verify(f.request), /REQUEST_MISMATCH/);
  f.request.effect_result.provider_file_id = "other-generated-id";
  await assert.rejects(f.verify(f.request), /IDENTITY_MISMATCH/);
  f.request.effect_result.provider_file_id = "topic";
  assert.equal((await f.verify(f.request)).provider_file_id, "topic");
});
