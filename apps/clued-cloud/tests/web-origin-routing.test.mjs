import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { routeWebOrigin } from "../worker/web-origin-routing.mjs";
import { routeStorageOrigin } from "../worker/web-origin-routing.mjs";
import { selectOAuthOrigin } from "../worker/oauth-origin.mjs";

const legacy = "https://clued.pixelgrav.com";
const web = "https://kooyumi.pixelgrav.com";
const env = { CLUED_OAUTH_ORIGIN: legacy, CLUED_WEB_ORIGINS: web };

test("the primary domain serves Native requests while existing issuers and callback sessions stay on their registered origins", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8"));
  const primary = "https://kooyomi.com";
  const production = { ...config.vars, CLUED_OAUTH_ORIGIN: legacy,
    CLUED_STORAGE_GOOGLE_REDIRECT_URI: web + "/storage/google/callback" };
  for (const host of ["clued.pixelgrav.com", "kooyumi.pixelgrav.com", "kooyomi.com", "beamingface.com", "dev.beamingface.com"]) {
    assert.ok(config.routes.some(route => route.pattern === host && route.custom_domain === true));
  }
  assert.equal(production.KOOYUMI_OAUTH_ORIGIN, web);
  assert.equal(selectOAuthOrigin(new Request(primary + "/"), production), production);
  for (const origin of [web, primary]) {
    for (const path of ["/", "/contexts", "/v1/records"]) {
      const request = new Request(origin + path, { method: "POST", body: "same-origin-body",
        headers: { authorization: "Bearer same-origin-session" } });
      const response = await routeWebOrigin(request, production, async received => {
        assert.equal(received, request);
        assert.equal(received.headers.get("authorization"), "Bearer same-origin-session");
        assert.equal(await received.text(), "same-origin-body");
        return new Response("native");
      });
      assert.equal(await response.text(), "native");
    }
  }
  const unexpected = async () => { throw Error("protocol request must not reach Native handler"); };
  for (const path of ["/mcp", "/oauth/token", "/oauth/register"]) {
    const response = await routeWebOrigin(new Request(primary + path, { method: "POST", body: "secret" }), production, unexpected);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  }
  const metadata = await routeWebOrigin(new Request(primary + "/.well-known/oauth-authorization-server"), production, unexpected);
  assert.equal(metadata.status, 302);
  assert.equal(metadata.headers.get("location"), legacy + "/.well-known/oauth-authorization-server");
  for (const method of ["GET", "HEAD"]) {
    const storage = routeStorageOrigin(new Request(primary + "/storage/admin?source=primary", { method }), production);
    assert.equal(storage.status, 302);
    assert.equal(storage.headers.get("location"), web + "/storage/admin?source=primary");
  }
  const storageMutation = routeStorageOrigin(new Request(primary + "/storage/admin", { method: "POST", body: "private" }), production);
  assert.equal(storageMutation.status, 404);
  assert.equal(storageMutation.headers.get("location"), null);
  const authenticatedNavigation = routeStorageOrigin(new Request(primary + "/storage/admin", { headers: { authorization: "Bearer private" } }), production);
  assert.equal(authenticatedNavigation.status, 404);
  assert.equal(authenticatedNavigation.headers.get("location"), null);
});

test("explicit web origin serves Native pages and authenticated same-origin APIs", async () => {
  for (const path of ["/", "/contexts", "/v1/records", "/assets/app.js"]) {
    let received;
    const request = new Request(web + path, { headers: { authorization: "Bearer test-native-user" } });
    const response = await routeWebOrigin(request, env, async next => { received = next; return new Response("native"); });
    assert.equal(await response.text(), "native");
    assert.equal(received, request);
  }
});

test("legacy and unknown hosts stay under the existing OAuth origin evaluator", async () => {
  for (const origin of [legacy, "https://other.pixelgrav.com", "http://kooyumi.pixelgrav.com", "https://kooyumi.com"]) {
    const response = await routeWebOrigin(new Request(origin + "/"), env, async () => { throw Error("must not bypass original evaluator"); });
    assert.equal(response, null);
  }
});

test("web alias never creates an OAuth issuer or accepts MCP and OAuth protocol requests", async () => {
  for (const path of ["/mcp", "/mcp/", "/mcp/subroute", "/oauth/token", "/oauth/register", "/oauth/decision", "/%6f%61uth/token"]) {
    const response = await routeWebOrigin(new Request(web + path, { method: "POST", body: "secret-body" }), env, async () => { throw Error("protocol request reached Native handler"); });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  }
});

test("existing consent and Google callback pages navigate to their original origin", async () => {
  for (const path of ["/bindings", "/oauth/account", "/oauth/projects", "/oauth/connections", "/oauth/consent", "/storage/onboard", "/storage/google/callback", "/.well-known/oauth-authorization-server", "/v1/continuity/bootstrap", "/clued-agent.md"]) {
    const response = await routeWebOrigin(new Request(web + path + "?state=test"), env, async () => { throw Error("compatibility page changed origin"); });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), legacy + path + "?state=test");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("compatibility navigations never redirect mutation bodies", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await routeWebOrigin(new Request(web + "/storage/onboard", { method, body: "private-body" }), env, async () => { throw Error("unexpected mutation"); });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("location"), null);
  }
});

test("missing or malformed web origin configuration never enables an alias", async () => {
  for (const value of [undefined, "", "http://kooyumi.pixelgrav.com", web + "/", web + "/path", "not a URL"]) {
    assert.equal(await routeWebOrigin(new Request(web), { ...env, CLUED_WEB_ORIGINS: value }, async () => { throw Error("invalid configuration admitted"); }), null);
  }
  assert.equal(await routeWebOrigin(new Request(web), { ...env, CLUED_OAUTH_ORIGIN: "invalid" }, async () => { throw Error("missing canonical issuer admitted"); }), null);
});

test("beamingface.com and dev.beamingface.com are Native web aliases without their own issuer or storage callback", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8"));
  // CLUED_OAUTH_ORIGIN and CLUED_STORAGE_GOOGLE_REDIRECT_URI are not in wrangler.production.jsonc
  // (production values come from elsewhere), so the test injects them.
  const production = { ...config.vars, CLUED_OAUTH_ORIGIN: legacy,
    CLUED_STORAGE_GOOGLE_REDIRECT_URI: web + "/storage/google/callback" };
  const unexpected = async () => { throw Error("request must not reach Native handler"); };
  for (const host of ["beamingface.com", "dev.beamingface.com"]) {
    const origin = "https://" + host;
    assert.ok(production.CLUED_WEB_ORIGINS.split(",").includes(origin));
    assert.equal(selectOAuthOrigin(new Request(origin + "/"), production), production);
    const home = new Request(origin + "/", { headers: { authorization: "Bearer same-origin-session" } });
    const native = await routeWebOrigin(home, production, async received => { assert.equal(received, home); return new Response("native"); });
    assert.equal(await native.text(), "native");
    for (const path of ["/oauth/consent", "/.well-known/oauth-authorization-server"]) {
      const response = await routeWebOrigin(new Request(origin + path + "?x=1"), production, unexpected);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), legacy + path + "?x=1");
    }
    for (const path of ["/mcp", "/oauth/token", "/oauth/register"]) {
      const response = await routeWebOrigin(new Request(origin + path, { method: "POST", body: "secret" }), production, unexpected);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("location"), null);
    }
    const storage = routeStorageOrigin(new Request(origin + "/storage/admin?source=alias"), production);
    assert.equal(storage.status, 302);
    assert.equal(storage.headers.get("location"), web + "/storage/admin?source=alias");
  }
});

test("look-alike hosts of the beamingface.com aliases are not admitted", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8"));
  const production = { ...config.vars, CLUED_OAUTH_ORIGIN: legacy };
  assert.deepEqual(production.CLUED_WEB_ORIGINS.split(",").sort(), ["https://beamingface.com", "https://dev.beamingface.com",
    "https://kooyomi.com", "https://kooyumi.pixelgrav.com"]);
  assert.deepEqual(config.routes.map(route => route.pattern).sort(), ["beamingface.com", "clued.pixelgrav.com",
    "dev.beamingface.com", "kooyomi.com", "kooyumi.pixelgrav.com"]);
  assert.ok(!config.routes.some(route => route.pattern === "www.beamingface.com"));
  for (const origin of ["https://www.beamingface.com", "https://beamingface.com.evil.test", "https://evilbeamingface.com",
    "https://prod.beamingface.com", "http://beamingface.com", "http://dev.beamingface.com", "https://beamingface.com:8443",
    "https://dev-beamingface.com", "https://beamingface.com.evil.com", "https://beamingface.com.",
    "https://x.dev.beamingface.com"]) {
    assert.equal(await routeWebOrigin(new Request(origin + "/"), production, async () => { throw Error("look-alike admitted"); }), null);
    assert.equal(routeStorageOrigin(new Request(origin + "/storage/admin"), production), null);
  }
  // A URL with credentials is refused by Request before any router can see it.
  assert.throws(() => new Request("https://beamingface.com@evil.test/"), TypeError);
});
