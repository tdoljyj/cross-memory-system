import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readWranglerConfig } from "../scripts/projection-postflight.mjs";
import { OAuthOriginConfigurationError, selectOAuthOrigin } from "../worker/oauth-origin.mjs";

const old = "https://clued.pixelgrav.com";
const current = "https://kooyumi.pixelgrav.com";
test("production binds the reviewed separate OAuth namespaces and exact new origin", async () => {
  // Read as Wrangler reads it (JSONC), like every release-path reader (Fable 1121 §7).
  const config = await readWranglerConfig(fileURLToPath(new URL("../wrangler.production.jsonc", import.meta.url)));
  assert.equal(config.vars.KOOYUMI_OAUTH_ORIGIN, current);
  const oldBindings = config.kv_namespaces.filter(binding => binding.binding === "OAUTH_KV");
  const newBindings = config.kv_namespaces.filter(binding => binding.binding === "KOOYUMI_OAUTH_KV");
  assert.equal(oldBindings.length, 1);
  assert.equal(newBindings.length, 1);
  assert.equal(oldBindings[0].id, "d7e56a5789854d42b191333d8b545a97");
  assert.equal(newBindings[0].id, "84dba66392314bbf82856574f85122fc");
  assert.notEqual(newBindings[0].id, oldBindings[0].id);
});
const request = (origin, path = "/mcp", init) => new Request(origin + path, init);
const storage = () => Object.freeze(Object.fromEntries(["get", "put", "delete", "list"].map(name =>
  [name, () => { throw new Error("selector must not access storage"); }])));
function environment() {
  return Object.freeze({
    CLUED_OAUTH_ORIGIN: old,
    CLUED_AUTHORIZATION_ISSUER_TOKEN: "old-private-issuer-token",
    OAUTH_KV: storage(),
    KOOYUMI_OAUTH_ORIGIN: current,
    KOOYUMI_AUTHORIZATION_ISSUER_TOKEN: "new-private-issuer-token",
    KOOYUMI_OAUTH_KV: storage(),
    SUPABASE_URL: "https://same-project.supabase.co",
    untouched: Object.freeze({ marker: true }),
  });
}
function configurationError(operation, env) {
  assert.throws(operation, error => {
    assert.ok(error instanceof OAuthOriginConfigurationError);
    assert.equal(error.message, "kooyumi_oauth_configuration_invalid");
    assert.equal(error.code, error.message);
    assert.equal(error.cause, undefined);
    const diagnostic = String(error) + error.stack + JSON.stringify(error);
    for (const secret of [env.CLUED_AUTHORIZATION_ISSUER_TOKEN, env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN]) {
      if (typeof secret === "string" && secret.trim()) assert.ok(!diagnostic.includes(secret));
    }
    return true;
  });
}

test("the new origin gets an independent scoped environment without mutating the original", () => {
  const env = environment();
  const scoped = selectOAuthOrigin(request(current), env);
  assert.notEqual(scoped, env);
  assert.deepEqual(Object.keys(scoped), Object.keys(env));
  assert.equal(scoped.CLUED_OAUTH_ORIGIN, current);
  assert.equal(scoped.CLUED_AUTHORIZATION_ISSUER_TOKEN, env.KOOYUMI_AUTHORIZATION_ISSUER_TOKEN);
  assert.equal(scoped.OAUTH_KV, env.KOOYUMI_OAUTH_KV);
  assert.equal(env.CLUED_OAUTH_ORIGIN, old);
  assert.notEqual(env.OAUTH_KV, scoped.OAUTH_KV);
  for (const key of Object.keys(env).filter(key => !["CLUED_OAUTH_ORIGIN", "CLUED_AUTHORIZATION_ISSUER_TOKEN", "OAUTH_KV"].includes(key))) {
    assert.equal(scoped[key], env[key]);
  }
});

test("the existing and unknown origins retain the exact original environment", () => {
  const env = environment();
  for (const origin of [old, "https://other.pixelgrav.com", "http://kooyumi.pixelgrav.com", "https://kooyumi.pixelgrav.com.evil.test"]) {
    assert.equal(selectOAuthOrigin(request(origin), env), env);
  }
});

test("without an optional origin the existing behavior is unchanged", () => {
  for (const configured of [undefined, ""]) {
    const env = { ...environment(), KOOYUMI_OAUTH_ORIGIN: configured };
    for (const origin of [old, current, "https://other.test"]) assert.equal(selectOAuthOrigin(request(origin), env), env);
  }
});

test("query parameters, headers and paths cannot select another issuer", () => {
  const env = environment();
  const untrusted = request("https://other.test", "/oauth/token?issuer=" + encodeURIComponent(current), {
    headers: { host: "kooyumi.pixelgrav.com", origin: current, "x-forwarded-host": "kooyumi.pixelgrav.com" },
  });
  assert.equal(selectOAuthOrigin(untrusted, env), env);
  for (const path of ["/", "/oauth/token", "/.well-known/oauth-protected-resource/mcp", "/mcp?issuer=" + encodeURIComponent(old)]) {
    assert.equal(selectOAuthOrigin(request(current, path), env).CLUED_OAUTH_ORIGIN, current);
  }
});

test("the new origin requires its own nonempty issuer token", () => {
  for (const token of [undefined, "", "   ", 42, environment().CLUED_AUTHORIZATION_ISSUER_TOKEN]) {
    const env = { ...environment(), KOOYUMI_AUTHORIZATION_ISSUER_TOKEN: token };
    configurationError(() => selectOAuthOrigin(request(current), env), env);
    assert.equal(selectOAuthOrigin(request(old), env), env);
    assert.equal(selectOAuthOrigin(request("https://other.test"), env), env);
  }
});

test("the new origin requires its own complete KV binding", () => {
  const base = environment();
  for (const binding of [undefined, null, {}, { get() {}, put() {}, delete() {} }, "not-a-binding", base.OAUTH_KV]) {
    const env = { ...base, KOOYUMI_OAUTH_KV: binding };
    configurationError(() => selectOAuthOrigin(request(current), env), env);
    assert.equal(selectOAuthOrigin(request(old), env), env);
  }
});

test("only an exact HTTPS origin may enable the optional issuer", () => {
  for (const configured of [current + "/", current + "/path", current + "?query=1", current + "#fragment", "https://user:password@kooyumi.pixelgrav.com", "https://KOOYUMI.pixelgrav.com", "http://kooyumi.pixelgrav.com"]) {
    const env = { ...environment(), KOOYUMI_OAUTH_ORIGIN: configured };
    configurationError(() => selectOAuthOrigin(request(new URL(configured).origin), env), env);
    assert.equal(selectOAuthOrigin(request(old), env), env);
  }
});

test("an invalid optional address cannot redirect the existing issuer or enable an unknown host", () => {
  for (const configured of ["invalid", "//kooyumi.pixelgrav.com", 42]) {
    const env = { ...environment(), KOOYUMI_OAUTH_ORIGIN: configured };
    for (const origin of [old, current, "https://other.test"]) assert.equal(selectOAuthOrigin(request(origin), env), env);
  }
});

test("configuring the existing origin leaves the optional issuer disabled", () => {
  for (const configured of [old, old + "/"]) {
    const env = { ...environment(), KOOYUMI_OAUTH_ORIGIN: configured,
      KOOYUMI_AUTHORIZATION_ISSUER_TOKEN: undefined, KOOYUMI_OAUTH_KV: undefined };
    for (const origin of [old, current, "https://other.test"]) assert.equal(selectOAuthOrigin(request(origin), env), env);
  }
});

test("bad new-origin dependencies are never read by existing or unknown origins", () => {
  const env = { CLUED_OAUTH_ORIGIN: old, KOOYUMI_OAUTH_ORIGIN: current };
  for (const key of ["KOOYUMI_AUTHORIZATION_ISSUER_TOKEN", "KOOYUMI_OAUTH_KV"]) {
    Object.defineProperty(env, key, { get() { throw new Error("new-origin dependencies must stay unused"); } });
  }
  assert.equal(selectOAuthOrigin(request(old), env), env);
  assert.equal(selectOAuthOrigin(request("https://other.test"), env), env);
});
