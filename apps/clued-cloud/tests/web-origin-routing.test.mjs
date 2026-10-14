import test from "node:test";
import assert from "node:assert/strict";
import { routeWebOrigin } from "../worker/web-origin-routing.mjs";

const legacy = "https://clued.pixelgrav.com";
const web = "https://kooyumi.pixelgrav.com";
const env = { CLUED_OAUTH_ORIGIN: legacy, CLUED_WEB_ORIGINS: web };

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
