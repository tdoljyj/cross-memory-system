import assert from "node:assert/strict";
import test from "node:test";
import { googleDriveSemanticState, createGoogleDriveSemanticAttempt, classifyGoogleDriveSemanticObservation, observeGoogleDriveSemanticAttempt } from "../../../kernel/host/resource-center-google-drive-semantic-recovery.mjs";

const intent = "11111111-1111-4111-8111-111111111111";
const client = "test-client.apps.googleusercontent.com";
const digest = "a".repeat(64), changedDigest = "b".repeat(64);
const file = () => ({ id: "file_1", name: "before.txt", parents: ["parent_1"], version: "7",
  mimeType: "text/plain", trashed: false, explicitlyTrashed: false,
  headRevisionId: "revision_1", sha256Checksum: digest, appProperties: { another_key: "preserve-me" } });
const mutation = operation => ({ operation, target_kind: "file", source_path: "root/before.txt",
  destination_path: operation === "rename" ? "root/after.txt" : operation === "move" ? "root/other/before.txt" : "root/before.txt" });
function semantic(operation = "rename", before = file()) {
  const attempt = { intent_id: intent, provider_file_id: before.id, parent_id: operation === "move" ? "parent_2" : "parent_1",
    content_after: { sha256: changedDigest } };
  return createGoogleDriveSemanticAttempt({ oauth_client_id: client, mutation: mutation(operation), attempt, file: before });
}
const observe = (attempt, current, now = 1000, extra = {}) => classifyGoogleDriveSemanticObservation({
  attempt, file: current, oauth_client_id: client, now_ms: now, no_effect_after_ms: 1000, ...extra });

test("semantic before captures explicit trash and private marker, excluding incidental Drive version", () => {
  const original = googleDriveSemanticState(file());
  assert.equal(original.explicitly_trashed, false);
  assert.equal(original.marker, null);
  assert.deepEqual(original, googleDriveSemanticState({ ...file(), version: "999" }));
  assert.throws(() => googleDriveSemanticState({ ...file(), explicitlyTrashed: undefined }), /SEMANTIC/);
  assert.throws(() => googleDriveSemanticState({ ...file(), parents: ["a", "b"] }), /SEMANTIC/);
  assert.throws(() => googleDriveSemanticState({ ...file(), explicitlyTrashed: true }), /SEMANTIC/);
});
test("directory semantic state binds the access digest to the same metadata response", () => {
  const directory = { ...file(), mimeType: "application/vnd.google-apps.folder", headRevisionId: undefined, sha256Checksum: undefined,
    permissions: [{ id: "owner", type: "user", role: "owner" }] };
  const state = googleDriveSemanticState(directory);
  assert.match(state.access_digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(googleDriveSemanticState({ ...directory, version: "99" }), state);
  assert.notEqual(googleDriveSemanticState({ ...directory, permissions: [{ id: "owner", type: "user", role: "reader" }] }).access_digest, state.access_digest);
  assert.throws(() => googleDriveSemanticState({ ...directory, permissions: undefined }), /SEMANTIC/);
});
test("before and conflict cannot conclude before I2; matching after can", () => {
  const attempt = semantic();
  assert.equal(observe(attempt, file(), 999).outcome, "deferred");
  assert.equal(observe(attempt, { ...file(), name: "unrelated.txt" }, 999).outcome, "deferred");
  assert.equal(observe(attempt, { ...file(), name: "after.txt", appProperties: { clued_intent_id: intent } }, 999).outcome, "after");
  assert.equal(observe(attempt, file()).outcome, "before");
  assert.equal(observe(attempt, { ...file(), name: "unrelated.txt" }).outcome, "conflict");
});
test("after must carry this intent's private marker and unchanged content for rename/move", () => {
  const attempt = semantic();
  assert.equal(observe(attempt, { ...file(), name: "after.txt" }).outcome, "conflict");
  assert.equal(observe(attempt, { ...file(), name: "after.txt", appProperties: { clued_intent_id: "another-intent" } }).outcome, "conflict");
  assert.equal(observe(attempt, { ...file(), name: "after.txt", headRevisionId: "owner_edit", appProperties: { clued_intent_id: intent } }).outcome, "conflict");
  const moved = semantic("move");
  assert.equal(observe(moved, { ...file(), parents: ["parent_2"], appProperties: { clued_intent_id: intent } }).outcome, "after");
});
test("I3 requires the same actual OAuth client; caller time and old/malformed evidence cannot conclude", () => {
  const attempt = semantic();
  assert.throws(() => observe(attempt, file(), 1000, { oauth_client_id: "different-client" }), /SEMANTIC/);
  assert.throws(() => observe(attempt, file(), NaN), /SEMANTIC/);
  assert.throws(() => observe({ ...attempt, before: null }, file()), /SEMANTIC/);
  assert.throws(() => semantic("rename", { ...file(), appProperties: { clued_intent_id: intent } }), /SEMANTIC/);
  assert.throws(() => createGoogleDriveSemanticAttempt({ oauth_client_id: client, mutation: mutation("move"), attempt: { intent_id: intent, provider_file_id: "other", parent_id: "parent_2" }, file: file() }), /SEMANTIC/);
});
test("replace requires new checksum, a new head revision and its own marker", () => {
  const attempt = semantic("replace");
  const after = { ...file(), headRevisionId: "revision_2", sha256Checksum: changedDigest, appProperties: { clued_intent_id: intent } };
  assert.equal(observe(attempt, after).outcome, "after");
  assert.equal(observe(attempt, { ...after, headRevisionId: "revision_1" }).outcome, "conflict");
  assert.equal(observe(attempt, { ...after, sha256Checksum: digest }).outcome, "conflict");
  assert.equal(observe(attempt, file()).outcome, "before");
  assert.throws(() => createGoogleDriveSemanticAttempt({ oauth_client_id: client, mutation: mutation("replace"),
    attempt: { intent_id: intent, provider_file_id: "file_1", parent_id: "parent_1", content_after: { sha256: null } },
    file: file() }), /SEMANTIC/);
});
test("trash and restore include explicit trash, target parent and target name", () => {
  const trash = semantic("delete");
  assert.equal(observe(trash, { ...file(), trashed: true, explicitlyTrashed: true, appProperties: { clued_intent_id: intent } }).outcome, "after");
  assert.equal(observe(trash, { ...file(), trashed: true, explicitlyTrashed: false, appProperties: { clued_intent_id: intent } }).outcome, "conflict");
  const original = { ...file(), trashed: true, explicitlyTrashed: true };
  const restored = semantic("restore", original);
  assert.equal(observe(restored, { ...file(), appProperties: { clued_intent_id: intent } }).outcome, "after");
  assert.equal(observe(restored, original).outcome, "before");
});
test("create missing ID still needs the existing same-client marker absence probe", () => {
  const attempt = createGoogleDriveSemanticAttempt({ oauth_client_id: client,
    mutation: { operation: "create", target_kind: "file", destination_path: "root/new.txt", content: "hello" },
    attempt: { intent_id: intent, provider_file_id: "file_1", parent_id: "parent_1", sha256: digest }, file: null });
  assert.equal(observe(attempt, null, 999).outcome, "deferred");
  assert.equal(observe(attempt, null).outcome, "absence_probe_required");
  assert.equal(observe(attempt, { ...file(), name: "new.txt", appProperties: { clued_intent_id: intent } }).outcome, "after");
});

function observerConfig(current, overrides = {}) {
  const reads = [];
  const rootFile = { id: "parent_1", name: "root", parents: ["outside"], version: "100",
    trashed: false, mimeType: "application/vnd.google-apps.folder" };
  const config = {
    semantic: { receipt_id: "22222222-2222-4222-8222-222222222222", evidence: semantic(), no_effect_after_ms: 1000 },
    oauth_client_id: client, mutation: mutation("rename"),
    provider_attempt: { intent_id: intent, provider_file_id: "file_1", parent_id: "parent_1" },
    provider_before: { root_folder_id: "parent_1", root_parent_id: "outside", source_parent_id: "parent_1",
      destination_parent_id: "parent_1", ancestors: [{ path: "root", id: "parent_1", parent_id: "outside", match: "access", value: digest }] },
    profile: { managed_root: "root" }, root_folder_id: "parent_1", root_parent_id: "outside", clock: () => 1000,
    get_file: async identifier => { reads.push(identifier); return structuredClone(identifier === "parent_1" ? rootFile : current); },
    list_children: async slot => current && !current.trashed && current.name === slot.name && current.parents[0] === slot.parent_id ? [structuredClone(current)] : [],
    ...overrides,
  };
  return { config, reads };
}
test("observer walks pinned ancestors around two same-client semantic reads", async () => {
  const { config, reads } = observerConfig(file());
  const result = await observeGoogleDriveSemanticAttempt(config);
  assert.equal(result.outcome, "before"); assert.equal(result.execution_permitted, false);
  assert.deepEqual(reads, ["parent_1", "file_1", "file_1", "parent_1"]);
  assert.equal(result.proof.semantic_attempt_receipt_id, config.semantic.receipt_id);
  assert.deepEqual(result.proof.first.state, result.proof.second.state);
  assert.equal(result.proof.ancestors_before.length, 1); assert.equal(result.proof.ancestors_after.length, 1);
});
test("observer after proof carries the stable file version and same request marker", async () => {
  const { config } = observerConfig({ ...file(), name: "after.txt", version: "20", appProperties: { clued_intent_id: intent } });
  const result = await observeGoogleDriveSemanticAttempt(config);
  assert.equal(result.outcome, "after"); assert.equal(result.proof.first.provider_file_version, "20");
  assert.equal(result.proof.second.state.marker, intent);
});
test("rename/move source parent uses the immutable attempt when legacy identity omits that field", async () => {
  const { config } = observerConfig(file());
  delete config.provider_before.source_parent_id;
  config.provider_attempt.source_parent_id = "parent_1";
  assert.equal((await observeGoogleDriveSemanticAttempt(config)).outcome, "before");
});
test("observer rejects changed ancestors, a wrong client and a request outside its root before settlement", async () => {
  const { config } = observerConfig(file());
  await assert.rejects(observeGoogleDriveSemanticAttempt({ ...config, oauth_client_id: "other" }), /SEMANTIC/);
  await assert.rejects(observeGoogleDriveSemanticAttempt({ ...config, mutation: { ...mutation("rename"), destination_path: "outside/after.txt" } }), /SEMANTIC/);
  const broken = observerConfig(file(), { get_file: async identifier => identifier === "parent_1"
    ? { id: "parent_1", name: "root", parents: ["escaped"], version: "1", trashed: false, mimeType: "application/vnd.google-apps.folder" } : file() });
  await assert.rejects(observeGoogleDriveSemanticAttempt(broken.config), /ANCESTOR/);
});
test("observer detects an edit between reads and aborts an adapter that ignores cancellation", async () => {
  let targetReads = 0;
  const { config } = observerConfig(file());
  const originalRead = config.get_file;
  await assert.rejects(observeGoogleDriveSemanticAttempt({ ...config, get_file: async identifier => {
    const value = await originalRead(identifier); if (identifier === "file_1" && ++targetReads === 2) value.name = "owner-edit.txt"; return value;
  } }), /UNSTABLE/);
  const start = Date.now();
  await assert.rejects(observeGoogleDriveSemanticAttempt({ ...config, timeout_ms: 5, get_file: () => new Promise(() => {}) }), /ABORTED/);
  assert.ok(Date.now() - start < 1000);
});
test("an unchanged target with another occupant in its name slot remains a conflict", async () => {
  const { config } = observerConfig(file());
  const original = config.list_children;
  const result = await observeGoogleDriveSemanticAttempt({ ...config, list_children: async slot => {
    const values = await original(slot);
    return slot.name === "before.txt" ? [...values, { ...file(), id: "external-file" }] : values;
  } });
  assert.equal(result.outcome, "conflict");
});
