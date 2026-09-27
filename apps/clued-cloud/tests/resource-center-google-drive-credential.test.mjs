import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleDrivePilotCredential } from "../../../kernel/host/resource-center-google-drive-credential.mjs";
const scope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const saved = { access_token: "original-test-access-token", refresh_token: "original-test-refresh-token",
  token_type: "Bearer", scope, expires_at: 0 };
const reply = { access_token: "refreshed-test-access-token", token_type: "Bearer", scope, expires_in: 3600 };
const setup = (options = {}) => createGoogleDrivePilotCredential({ client_id: "test.apps.googleusercontent.com",
  client_secret: "test-client-secret-only", load_tokens: async () => ({ ...saved }), clock: () => 1000, ...options });
test("single flight refresh uses only the fixed endpoint and never asks for broader consent", async () => {
  let requests = 0;
  const get = setup({ fetch: async (url, options) => {
    requests++; assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.equal(options.redirect, "error");
    assert.equal(options.body.get("grant_type"), "refresh_token");
    assert.equal(options.body.has("scope"), false);
    return Response.json(reply);
  } });
  const result = await Promise.all([get(), get(), get()]);
  assert.equal(requests, 1); assert.equal(result[0].access_token, reply.access_token);
  assert.deepEqual(Object.keys(result[0]).sort(), ["access_token", "scope"]);
  await get(); assert.equal(requests, 1);
});
test("valid cached access needs no network and returned credentials cannot mutate cache", async () => {
  const get = setup({ load_tokens: async () => ({ ...saved, expires_at: 1_000_000 }),
    fetch: async () => assert.fail("network forbidden") });
  const first = await get(); assert.ok(Object.isFrozen(first));
  assert.equal(first.access_token, saved.access_token);
});
test("missing OAuth response scope retains the exact previously granted scopes", async () => {
  const get = setup({ fetch: async () => Response.json({ ...reply, scope: undefined }) });
  assert.equal((await get()).scope, scope);
});
test("changed, malformed and invalid grants fail closed without leaking provider text or retrying", async () => {
  for (const response of [{ ...reply, scope: "https://www.googleapis.com/auth/drive" },
    { ...reply, scope: "https://www.googleapis.com/auth/drive.file" }, { ...reply, expires_in: -1 },
    { error: "secret-that-must-not-be-logged" }]) {
    let calls = 0;
    const get = setup({ fetch: async () => { calls++; return Response.json(response); } });
    await assert.rejects(get(), { message: "DRIVE_CREDENTIAL_REFRESH_FAILED" });
    await assert.rejects(get(), { message: "DRIVE_CREDENTIAL_REAUTHENTICATION_REQUIRED" });
    assert.equal(calls, 1);
  }
});
test("rotated refresh token must be persisted before access is returned", async () => {
  let stored;
  const fetch = async () => Response.json({ ...reply, refresh_token: "rotated-test-refresh-token" });
  await assert.rejects(setup({ fetch })(), /REFRESH_FAILED/);
  const get = setup({ fetch, persist_rotated_tokens: async (value) => { stored = value; } });
  await get(); assert.equal(stored.refresh_token, "rotated-test-refresh-token");
  await assert.rejects(setup({ fetch, persist_rotated_tokens: async () => { throw new Error("storage secret"); } })(),
    { message: "DRIVE_CREDENTIAL_REFRESH_FAILED" });
});
test("invalid stored scope is rejected before any network call", async () => {
  const get = setup({ load_tokens: async () => ({ ...saved, scope: "drive.file" }), fetch: async () => assert.fail() });
  await assert.rejects(get(), /REFRESH_FAILED/);
});
