import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";

export const A03 = Object.freeze({
  inspectorVersion: "2.4.0",
  serverName: "clued-a03-production-readonly",
  resource: "https://clued.pixelgrav.com/mcp",
  clientId: "87924be5-cec9-415f-b1a2-8a4d9ae9d1a8",
  callbackUrl: "http://localhost:6400/oauth/callback",
  issuer: "https://ccxsikzwxlolxqlosril.supabase.co/auth/v1",
  authorizationEndpoint: "https://ccxsikzwxlolxqlosril.supabase.co/auth/v1/oauth/authorize",
  inspectorProxyPort: 6400,
  inspectorInternalPort: 6403,
  subject: "e9dc13e7-41b0-421b-bfa3-07890675e92d",
  oauthScopes: Object.freeze(["openid", "email", "profile"]),
  tool: "clued_project_list",
});

export function validateAuthorizationRequest(value) {
  const url = value instanceof URL ? value : new URL(value);
  const scope = (url.searchParams.get("scope") ?? "").trim().split(/\s+/).filter(Boolean);
  const challenge = url.searchParams.get("code_challenge") ?? "";
  assert.equal(`${url.origin}${url.pathname}`, A03.authorizationEndpoint, "unexpected OAuth authorization endpoint");
  assert.equal(url.searchParams.get("response_type"), "code", "unexpected OAuth response_type");
  assert.equal(url.searchParams.get("client_id"), A03.clientId, "unexpected OAuth client_id");
  assert.equal(url.searchParams.get("redirect_uri"), A03.callbackUrl, "unexpected OAuth redirect_uri");
  assert.deepEqual(url.searchParams.getAll("resource"), [A03.resource], "unexpected OAuth resource");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256", "PKCE must use S256");
  assert.ok(challenge, "PKCE code_challenge is required");
  assert.ok(scope.every((item) => A03.oauthScopes.includes(item)), "OAuth scope exceeds A03 allowance");
  return {
    authorization_endpoint: A03.authorizationEndpoint,
    response_type: "code",
    client_id: A03.clientId,
    redirect_uri: A03.callbackUrl,
    resource: A03.resource,
    code_challenge_method: "S256",
    code_challenge_present: true,
    code_challenge_length: challenge.length,
    scope,
  };
}

function normalizeAudience(aud) {
  return Array.isArray(aud) ? aud : [aud];
}

export function validateAndRedactClaims(claims) {
  assert.equal(claims.sub, A03.subject, "unexpected token subject");
  assert.equal(claims.client_id, A03.clientId, "unexpected token client_id");
  assert.equal(claims.iss, A03.issuer, "unexpected token issuer");
  assert.ok(Number.isInteger(claims.iat), "iat must be an integer");
  assert.ok(Number.isInteger(claims.exp), "exp must be an integer");
  assert.ok(claims.exp > claims.iat, "exp must be greater than iat");
  assert.deepEqual(normalizeAudience(claims.aud), ["authenticated"], "unexpected Supabase audience");

  const resource = claims.resource ?? null;
  if (resource !== null) {
    const values = Array.isArray(resource) ? resource : [resource];
    assert.ok(values.includes(A03.resource), "token resource does not include the production MCP URL");
  }

  const scope = typeof claims.scope === "string"
    ? claims.scope.trim().split(/\s+/).filter(Boolean)
    : [];
  assert.ok(scope.every((item) => A03.oauthScopes.includes(item)), "token scope exceeds A03 allowance");

  return {
    sub: claims.sub,
    client_id: claims.client_id,
    iss: claims.iss,
    iat: claims.iat,
    exp: claims.exp,
    exp_gt_iat: true,
    aud: claims.aud,
    resource,
    scope,
    resource_contract: resource === null
      ? "absent-as-documented-for-standard-supabase-oauth-jwt"
      : "production-mcp-present",
  };
}

export function decodeJwtClaims(accessToken) {
  assert.equal(typeof accessToken, "string", "stored access token is missing");
  const parts = accessToken.split(".");
  assert.equal(parts.length, 3, "stored access token is not a JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

export function exactReadonlyCallArgv(launcherPath) {
  return [
    launcherPath,
    "--cli",
    "--server-url", A03.resource,
    "--method", "tools/call",
    "--tool-name", A03.tool,
    "--tool-args-json", "{}",
    "--use-stored-auth",
    "--stored-auth-only",
    "--format", "json",
  ];
}

export async function resolveInspectorInstall(fromUrl = import.meta.url) {
  const require = createRequire(fromUrl);
  const packagePath = require.resolve("@modelcontextprotocol/inspector/package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  assert.equal(manifest.version, A03.inspectorVersion, "Inspector version drift");
  return {
    packagePath,
    launcherPath: path.join(path.dirname(packagePath), "clients", "launcher", "build", "index.js"),
  };
}
