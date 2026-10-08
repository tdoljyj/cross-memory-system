import assert from "node:assert/strict";
import test from "node:test";
import { fixture, ids, root } from "./resource-center-cloud-executor.fixture.mjs";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { EMPTY_PROVIDER_VERSION } from "../../../kernel/host/resource-center-google-drive-identity.mjs";
import { googleDriveAccessDigest } from "../../../kernel/host/resource-center-google-drive-sharing.mjs";

// Storage step 3 (StorageFineGrainedConcurrency §4.2, Task 469700eb): with
// load's ancestor_match the executor matches ancestors by identity and digest.
const OWNER = [{ id: "owner", type: "user", role: "owner" }];
const MATCH = [{ path: root, provider_file_id: "root", match: "access" },
  { path: root + "/track", provider_file_id: "track", match: "access" }];

function ancestorFixture({ ancestor_match: ancestorMatch = MATCH, verified = true, during } = {}) {
  const f = fixture(), load = f.config.load_job, rpc = f.config.rpc;
  for (const id of ["root", "track"]) f.files.get(id).permissions = structuredClone(OWNER);
  const requests = [];
  let finish;
  f.config.verified_result_mode = verified;
  f.config.load_job = async reference => ({ ...await load(reference), ...(ancestorMatch === null ? {} : { ancestor_match: ancestorMatch }) });
  f.config.rpc = async input => {
    if (input.action === "authority") requests.push(structuredClone(input.request));
    // Something else happens in the folders after the durable start.
    if (input.action === "provider_attempt") during?.(f.files);
    if (input.action === "verified_record") {
      finish = input.finish;
      return { status: "verified", intent_id: ids.intent, verified_receipt_id: ids.receipt, verified_digest: "a".repeat(64), version: 3, execution_permitted: false };
    }
    if (input.action === "settle_verified") return rpc({ ...input, ...finish, action: "finalize" });
    return rpc(input);
  };
  return { f, requests };
}
const sibling = files => {
  for (const id of ["root", "track"]) files.get(id).version = "9";
  files.set("sibling", { id: "sibling", name: "other.txt", parents: ["track"], version: "1", trashed: false, mimeType: "text/plain" });
};

test("a sibling change in the folders after the durable start no longer fails the job", async () => {
  const { f, requests } = ancestorFixture({ during: sibling });
  const result = await createResourceCenterCloudExecutor(f.config).run(f.reference);
  assert.equal(result.status, "committed", JSON.stringify(result));
  assert.equal(f.info().posts, 1);
  const identity = requests[0].provider_identity;
  assert.deepEqual(identity.ancestors, [
    { path: root, id: "root", parent_id: "parent", match: "access", value: googleDriveAccessDigest({ permissions: OWNER }) },
    { path: root + "/track", id: "track", parent_id: "root", match: "access", value: googleDriveAccessDigest({ permissions: OWNER }) },
  ]);
  assert.equal(identity.root_folder_version, null);
  assert.equal(identity.destination_parent_version, null);
  assert.equal(identity.provider_version, EMPTY_PROVIDER_VERSION);
});

test("the legacy identity (no ancestor_match, or not the verified-result mode) still fails on a sibling change", async () => {
  for (const options of [{ ancestor_match: null }, { verified: false }]) {
    const { f, requests } = ancestorFixture({ ...options, during: sibling });
    const result = await createResourceCenterCloudExecutor(f.config).run(f.reference);
    assert.notEqual(result.status, "committed");
    assert.equal(f.info().posts, 0);
    assert.equal("ancestors" in requests[0].provider_identity, false);
    assert.equal(requests[0].provider_identity.root_folder_version, "1");
  }
});

test("a changed role on an ancestor after the durable start stops the job before any write", async () => {
  const { f } = ancestorFixture({ during: files => { files.get("track").permissions = [...OWNER, { id: "w", type: "anyone", role: "reader" }]; } });
  const result = await createResourceCenterCloudExecutor(f.config).run(f.reference);
  assert.notEqual(result.status, "committed");
  assert.equal(f.info().posts, 0);
});

test("a version-matched ancestor keeps failing on a sibling change; a digest-matched one does not", async () => {
  const versioned = MATCH.map((entry, index) => index === 1 ? { ...entry, match: "version" } : entry);
  const { f, requests } = ancestorFixture({ ancestor_match: versioned, during: sibling });
  const result = await createResourceCenterCloudExecutor(f.config).run(f.reference);
  assert.notEqual(result.status, "committed");
  assert.equal(f.info().posts, 0);
  assert.equal(requests[0].provider_identity.destination_parent_version, "1");
  assert.notEqual(requests[0].provider_identity.provider_version, EMPTY_PROVIDER_VERSION);
  // Only the root changing is fine when the root is matched by its digest.
  const rootOnly = ancestorFixture({ ancestor_match: versioned, during: files => { files.get("root").version = "9"; } });
  assert.equal((await createResourceCenterCloudExecutor(rootOnly.f.config).run(rootOnly.f.reference)).status, "committed");
});

test("a malformed ancestor_match is refused before any reservation", async () => {
  for (const bad of [{}, [{ path: root, provider_file_id: "root" }], [{ path: "G:/elsewhere", provider_file_id: "root", match: "access" }],
    [MATCH[0], MATCH[0]]]) {
    const { f } = ancestorFixture({ ancestor_match: bad });
    const result = await createResourceCenterCloudExecutor(f.config).run(f.reference);
    assert.equal(result.status, "unavailable");
    assert.equal(f.info().starts, 0);
  }
});

test("ancestor denial reasons are logged as fixed labels", async () => {
  const warnings = [], warn = console.warn;
  console.warn = message => warnings.push(String(message));
  try {
    for (const reason of ["parent_access_changed", "ancestor_access_unavailable", "root_match_changed", "ancestor_set_mismatch",
      "ancestor_identity_mismatch", "ancestors_invalid", "ancestor_sharing_changed"]) {
      const { f } = ancestorFixture();
      const rpc = f.config.rpc;
      f.config.rpc = async input => input.action === "authority" ? { status: "denied", reason } : rpc(input);
      await createResourceCenterCloudExecutor(f.config).run(f.reference);
      assert.ok(warnings.some(line => JSON.parse(line).reason === reason), reason);
    }
  } finally { console.warn = warn; }
});
