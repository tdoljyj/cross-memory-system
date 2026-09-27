import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGoogleDriveNativeCreateEffect } from "../../../kernel/host/resource-center-google-drive-create-effect.mjs";
import { createResourceCenterProviderAttemptStore } from "../../../kernel/host/resource-center-recovery-store.mjs";

const profile = { profile_id: "native-test", profile_version: "test/1", managed_root: "G:/test/Clued_资料中心" };
const provider = { root_folder_id: "root", root_parent_id: "container", root_folder_version: "1",
  destination_parent_id: "track", destination_parent_version: "1", destination_file_id: null, destination_file_version: null };
const intent = "10000000-0000-4000-8000-000000000001";
function fixture(overrides = {}) {
  const events = [];
  const mutation = { operation: "create", destination_path: profile.managed_root + "/20_P_产品与体验/test.txt",
    target_kind: "file", content: "合成\n", artifact_role: "clued_resource" };
  const binding = { profile_id: profile.profile_id, operation: "create", destination_path: mutation.destination_path,
    request_sha256: createHash("sha256").update(JSON.stringify(mutation)).digest("hex") };
  let consumed = false;
  let attempt;
  const effect = createGoogleDriveNativeCreateEffect({ trusted_profile: profile,
    get_credential: async () => ({ access_token: "native-test-access-token",
      scope: "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly" }),
    resolve_provider_identity: async () => ({ ...provider }),
    consume_started_provider: () => {
      if (consumed) return null;
      consumed = true;
      return { intent_id: intent, request_sha256: binding.request_sha256, provider };
    },
    persist_provider_attempt: async (value) => { events.push("persist"); attempt = value; },
    fetch: async (url, options) => {
      assert.equal(options.redirect, "error");
      if (url.includes("/generateIds")) { events.push("generate"); return Response.json({ ids: ["generated-id"] }); }
      events.push("storage-post");
      assert.equal(events.at(-2), "persist");
      assert.match(url, /^https:\/\/www.googleapis.com\/upload\/drive\/v3\/files/);
      assert.match(options.body, /合成/);
      assert.match(options.body, /generated-id/);
      return Response.json({ id: "generated-id", name: "test.txt", parents: ["track"],
        mimeType: "text/plain", version: "1", trashed: false });
    }, ...overrides });
  return { effect, events, binding, request: { mutation, admission: { binding, expires_at_ms: Date.now() + 30000 }, profile_identity: profile }, attempt: () => attempt };
}
test("admission expiry during every awaited phase prevents the sole storage POST", async () => {
  for (const phase of ["generate", "persist", "identity", "credential", "missing-expiry"]) {
    let now = 1000, identities = 0, credentials = 0, posts = 0;
    const f = fixture({ clock: () => now,
      get_credential: async () => {
        if (++credentials === 2 && phase === "credential") now = 2000;
        return { access_token: "native-test-access-token", scope:
          "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly" };
      },
      resolve_provider_identity: async () => {
        if (++identities === 2 && phase === "identity") now = 2000;
        return { ...provider };
      },
      persist_provider_attempt: async () => { if (phase === "persist") now = 2000; },
      fetch: async (url) => {
        if (url.includes("generateIds")) {
          if (phase === "generate") now = 2000;
          return Response.json({ ids: ["generated-id"] });
        }
        posts++; throw new Error("must not POST");
      } });
    f.request.admission.expires_at_ms = phase === "missing-expiry" ? undefined : 2000;
    await assert.rejects(f.effect(f.request), /ADMISSION_EXPIRED/, phase);
    assert.equal(posts, 0, phase);
    await assert.rejects(f.effect(f.request), /DURABLE_START_REQUIRED/, phase);
  }
});
test("native create records exact generated ID and binding before one POST, never replays", async () => {
  const f = fixture();
  const result = await f.effect(f.request);
  assert.equal(result.provider_file_id, "generated-id");
  assert.deepEqual(f.events, ["generate", "persist", "storage-post"]);
  assert.equal(f.attempt().request_sha256, f.binding.request_sha256);
  assert.equal(f.attempt().sha256, createHash("sha256").update("合成\n").digest("hex"));
  assert.equal(f.attempt().size, "7");
  await assert.rejects(f.effect(f.request), /DURABLE_START_REQUIRED/);
  assert.equal(f.events.filter((e) => e === "storage-post").length, 1);
});
test("changed content or missing durable start never reaches Google", async () => {
  const f = fixture(); f.request.mutation.content = "changed";
  await assert.rejects(f.effect(f.request), /REQUEST_MISMATCH/); assert.equal(f.events.length, 0);
  const noStart = fixture({ consume_started_provider: () => null });
  await assert.rejects(noStart.effect(noStart.request), /DURABLE_START_REQUIRED/); assert.equal(noStart.events.length, 0);
});
test("attempt persistence failure prevents storage creation", async () => {
  const f = fixture({ persist_provider_attempt: async () => { throw new Error("RECOVERY_STORAGE_FAILED"); } });
  await assert.rejects(f.effect(f.request), /RECOVERY_STORAGE_FAILED/);
  assert.deepEqual(f.events, ["generate"]);
});
test("provider changes before or after persistence prevent the storage POST", async () => {
  for (const afterFlush of [false, true]) {
    let calls = 0;
    const f = fixture({ resolve_provider_identity: async () => ({ ...provider,
      destination_parent_version: ++calls >= (afterFlush ? 2 : 1) ? "2" : "1" }) });
    await assert.rejects(f.effect(f.request), /PROVIDER_CHANGED/);
    assert.equal(f.events.includes("storage-post"), false);
  }
});
test("lost POST response preserves persisted ID and never retries or leaks error text", async () => {
  let posts = 0;
  const f = fixture({ fetch: async (url) => {
    if (url.includes("generateIds")) return Response.json({ ids: ["generated-id"] });
    posts++; throw new Error("provider-secret-should-not-leak");
  } });
  await assert.rejects(f.effect(f.request), { message: "DRIVE_NATIVE_REQUEST_OUTCOME_UNKNOWN" });
  assert.equal(f.attempt().provider_file_id, "generated-id");
  await assert.rejects(f.effect(f.request), /DURABLE_START_REQUIRED/);
  assert.equal(posts, 1);
});
test("wrong scope, malformed ID and substituted response fail closed", async () => {
  const noScope = fixture({ get_credential: async () => ({ access_token: "native-test-access-token", scope: "drive.file" }) });
  await assert.rejects(noScope.effect(noScope.request), /GRANT_UNAVAILABLE/);
  assert.deepEqual(noScope.events, []);
  const badId = fixture({ fetch: async () => Response.json({ ids: ["../evil"] }) });
  await assert.rejects(badId.effect(badId.request), /GENERATED_ID_INVALID/);
  const replaced = fixture({ fetch: async (url) => Response.json(url.includes("generateIds") ? { ids: ["generated-id"] }
    : { id: "different-id" }) });
  await assert.rejects(replaced.effect(replaced.request), /RESPONSE_MISMATCH/);
});
test("provider-attempt journal is durable, exact, single-append and recovery-only", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "clued-native-attempt-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, "attempts.jsonl");
  await fs.writeFile(journalPath, "", { flag: "wx" });
  const store = createResourceCenterProviderAttemptStore(journalPath);
  const f = fixture({ persist_provider_attempt: store.persist_provider_attempt });
  // Supply a POST mock that does not depend on the fixture's in-memory recorder.
  const saving = fixture({ persist_provider_attempt: store.persist_provider_attempt,
    fetch: async (url) => Response.json(url.includes("generateIds") ? { ids: ["generated-id"] }
      : { id: "generated-id", name: "test.txt", parents: ["track"], mimeType: "text/plain", version: "1", trashed: false }) });
  await saving.effect(saving.request);
  const restarted = createResourceCenterProviderAttemptStore(journalPath);
  const saved = await restarted.read_provider_attempt(intent, f.binding.request_sha256);
  assert.equal(saved.provider_file_id, "generated-id");
  await assert.rejects(restarted.persist_provider_attempt(saved), /RECOVERY_KEY_ALREADY_EXISTS/);
  await assert.rejects(restarted.read_provider_attempt(intent, "b".repeat(64)), /ATTEMPT_MISMATCH/);
  assert.equal(typeof restarted.start, "undefined");
});
