import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { loadContinuityWorker } from "./worker-continuity-loader.mjs";

// StorageNormalUse.v0.1 N0 routes: disabled by default, native-only, Picker
// configuration fails closed with a fixed reason, and begin reaches the exact
// onboard RPC with the issuer secret (never the hash or a service role).
const worker = await loadContinuityWorker();
const origin = "https://clued.example.invalid";
const base = { CLUED_STORAGE_ACCOUNT_V1: "true", CLUED_STORAGE_GOOGLE_V1: "true", CLUED_STORAGE_ONBOARD_V1: "true", CLUED_STORAGE_REFRESH_V1: "true",
  SUPABASE_URL: "https://db.example.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key",
  CLUED_STORAGE_CONNECTOR_ISSUER: "i".repeat(48), CLUED_STORAGE_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
  CLUED_STORAGE_GOOGLE_CLIENT_SECRET: "fixture-only-client-secret", CLUED_STORAGE_GOOGLE_REDIRECT_URI: origin + "/storage/google/callback",
  CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } }) };
const picker = { CLUED_STORAGE_GOOGLE_PICKER_API_KEY: "AIzaFixtureFixtureFixtureFixture12345", CLUED_STORAGE_GOOGLE_CLOUD_PROJECT_NUMBER: "123456789012" };
const post = (route, body, token = "fixture-native-jwt") => new Request(origin + route, {
  method: "POST", headers: { "content-type": "application/json", origin, authorization: "Bearer " + token }, body: JSON.stringify(body) });
const owner = "10000000-0000-4000-8000-000000000099";
async function withFetch(handler, run) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body }); return handler(String(url), init); };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}
const database = (url, init) => {
  if (url.endsWith("/auth/v1/user")) return Response.json({ id: owner });
  const input = JSON.parse(init.body).p_input;
  if (input.action === "list") return Response.json({ attempts: [], allowed: true, refresh_token_count: 3 });
  if (input.action === "begin") return Response.json({ status: "begun", onboard_attempt_id: input.onboard_attempt_id, oauth_client_id: base.CLUED_STORAGE_GOOGLE_CLIENT_ID,
    redirect_uri: base.CLUED_STORAGE_GOOGLE_REDIRECT_URI, requested_scope_profile: input.normal_use_requested ? "normal" : "legacy" });
  return Response.json({ message: "unexpected" }, { status: 500 });
};
const choice = root => ({ root, tracks: ["资料", "项目", "归档"], normal_use: true, default_refresh: true, disclosure_version: "clued.storage-onboard-disclosure/1" });

test("onboarding is off by default: config answers a fixed reason, other routes 404, nothing is fetched", async () => {
  await withFetch(() => { throw new Error("must not fetch"); }, async calls => {
    const config = await worker.fetch(post("/v1/storage/onboard/config", {}), { ...base, CLUED_STORAGE_ONBOARD_V1: undefined });
    assert.equal(config.status, 200); assert.deepEqual(await config.json(), { enabled: false, reason: "onboard_disabled" });
    assert.equal((await worker.fetch(post("/v1/storage/onboard/begin", {}), {})).status, 404);
    assert.equal(calls.length, 0);
  });
  await withFetch(() => { throw new Error("must not fetch"); }, async calls => {
    assert.equal((await worker.fetch(post("/v1/storage/onboard/config", {}, "clued_bnd_" + "a".repeat(64)), base)).status, 401, "Binding tokens are refused");
    assert.equal(calls.length, 0);
  });
});

test("missing Picker configuration: config says picker_unconfigured and a picked root is refused before any database write", async () => {
  await withFetch(database, async calls => {
    const config = await (await worker.fetch(post("/v1/storage/onboard/config", {}), base)).json();
    assert.equal(config.enabled, true); assert.equal(config.picker, null); assert.equal(config.picker_reason, "picker_unconfigured");
    assert.equal(config.allowed, true); assert.equal(config.refresh_available, true);
    const refused = await worker.fetch(post("/v1/storage/onboard/begin", choice({ mode: "picked", name: "已有", folder_id: "picked-folder" })), base);
    assert.equal(refused.status, 403); assert.equal((await refused.json()).reason, "picker_unconfigured");
    assert.equal(calls.filter(c => c.url.endsWith("/clued_storage_onboard_v1")).map(c => JSON.parse(c.body).p_input.action).join(), "list");
  });
  for (const partial of [{ CLUED_STORAGE_GOOGLE_PICKER_API_KEY: picker.CLUED_STORAGE_GOOGLE_PICKER_API_KEY }, { CLUED_STORAGE_GOOGLE_CLOUD_PROJECT_NUMBER: "12" + "3".repeat(8) },
    { ...picker, CLUED_STORAGE_GOOGLE_CLOUD_PROJECT_NUMBER: "not-a-number" }]) {
    await withFetch(database, async () => {
      assert.equal((await (await worker.fetch(post("/v1/storage/onboard/config", {}), { ...base, ...partial })).json()).picker, null);
    });
  }
});

test("configured Picker and begin: exact RPC with the issuer secret and the native token; Google consent URL", async () => {
  await withFetch(database, async calls => {
    const config = await (await worker.fetch(post("/v1/storage/onboard/config", {}), { ...base, ...picker })).json();
    assert.deepEqual(config.picker, { api_key: picker.CLUED_STORAGE_GOOGLE_PICKER_API_KEY, app_id: "123456789012", client_id: base.CLUED_STORAGE_GOOGLE_CLIENT_ID });
    const response = await worker.fetch(post("/v1/storage/onboard/begin", choice({ mode: "new", name: "Clued_资料中心" })), { ...base, ...picker });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(new URL(result.authorization_url).origin, "https://accounts.google.com");
    const begin = calls.find(c => c.url === base.SUPABASE_URL + "/rest/v1/rpc/clued_storage_onboard_v1" && JSON.parse(c.body).p_input.action === "begin");
    const body = JSON.parse(begin.body);
    assert.equal(body.p_issuer_secret, base.CLUED_STORAGE_CONNECTOR_ISSUER); assert.equal("p_issuer_hash" in body, false);
    assert.equal(begin.headers.get("authorization"), "Bearer fixture-native-jwt");
    assert.equal(body.p_input.owner_id, owner); assert.equal(body.p_input.onboard_attempt_id, result.onboard_attempt_id);
    // Refresh opt-in needs the refresh feature.
    const noRefresh = await worker.fetch(post("/v1/storage/onboard/begin", choice({ mode: "new", name: "x" })), { ...base, CLUED_STORAGE_REFRESH_V1: "false" });
    assert.equal((await noRefresh.json()).reason, "refresh_unavailable");
  });
});
