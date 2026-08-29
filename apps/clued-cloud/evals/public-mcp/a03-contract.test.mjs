import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  A03,
  exactReadonlyCallArgv,
  validateAndRedactClaims,
  validateAuthorizationRequest,
} from "./a03-contract.mjs";
import {
  clearStoredA03State,
  readStoredAccessToken,
  runExactReadonlyCall,
} from "./a03-session.mjs";

function isolatedOAuthState(accessToken = "test-access-token") {
  return {
    servers: {
      [new URL(A03.resource).href]: {
        activeIssuer: A03.issuer,
        preregisteredClientInformation: { client_id: A03.clientId },
        byIssuer: {
          [A03.issuer]: { tokens: { access_token: accessToken } },
        },
      },
    },
    idpSessions: {},
  };
}

test("accepts only the fixed A03 PKCE authorization request", () => {
  const url = new URL(`${A03.issuer}/authorize`);
  url.searchParams.set("client_id", A03.clientId);
  url.searchParams.set("redirect_uri", A03.callbackUrl);
  url.searchParams.set("resource", A03.resource);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", "redacted-nonempty-value");
  url.searchParams.set("scope", "openid email profile");
  assert.deepEqual(validateAuthorizationRequest(url), {
    client_id: A03.clientId,
    redirect_uri: A03.callbackUrl,
    resource: A03.resource,
    code_challenge_method: "S256",
    code_challenge_present: true,
    scope: ["openid", "email", "profile"],
  });
  url.searchParams.set("code_challenge_method", "plain");
  assert.throws(() => validateAuthorizationRequest(url), /S256/);
});

test("records the documented Supabase audience and truthful absent resource", () => {
  const redacted = validateAndRedactClaims({
    sub: A03.subject,
    client_id: A03.clientId,
    iss: A03.issuer,
    iat: 100,
    exp: 200,
    aud: "authenticated",
    scope: "openid email profile",
  });
  assert.equal(redacted.resource, null);
  assert.equal(redacted.resource_contract, "absent-as-documented-for-standard-supabase-oauth-jwt");
  assert.throws(() => validateAndRedactClaims({ ...redacted, aud: "wrong" }), /audience/);
});

test("builds one fail-closed Inspector call with exact empty arguments", () => {
  const argv = exactReadonlyCallArgv("inspector-launcher.js");
  assert.equal(argv.filter((value) => value === "tools/call").length, 1);
  assert.deepEqual(argv.slice(argv.indexOf("--tool-args-json"), argv.indexOf("--tool-args-json") + 2), [
    "--tool-args-json", "{}",
  ]);
  assert.ok(argv.includes("--use-stored-auth"));
  assert.ok(argv.includes("--stored-auth-only"));
  assert.ok(!argv.includes("--relogin"));
});

test("executes the Inspector transport exactly once and emits no project bodies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clued-a03-call-"));
  const statePath = path.join(directory, "oauth.json");
  const original = `${JSON.stringify(isolatedOAuthState(), null, 2)}\n`;
  await writeFile(statePath, original, { mode: 0o600 });
  const calls = [];
  try {
    const summary = await runExactReadonlyCall({
      statePath,
      spawn(command, argv, options) {
        const staged = JSON.parse(readFileSync(options.env.MCP_INSPECTOR_OAUTH_STATE_PATH, "utf8"));
        const server = staged.servers[new URL(A03.resource).href];
        assert.equal(server.tokens.access_token, "test-access-token");
        assert.equal(server.byIssuer[A03.issuer].tokens.access_token, "test-access-token");
        calls.push({ command, argv, options });
        return {
          status: 0,
          stdout: JSON.stringify({ result: { structuredContent: { status: "ok", projects: [] } } }),
          stderr: "",
        };
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(summary, {
      status: "ok",
      inspector_version: "2.4.0",
      tool: A03.tool,
      arguments: {},
      protected_tool_transport_attempts: 1,
      project_count: 0,
    });
    assert.doesNotMatch(JSON.stringify(summary), /access_token|refresh_token|projects\s*:/i);
    assert.equal(await readFile(statePath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores issuer-scoped OAuth state after one fail-closed Inspector attempt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clued-a03-fail-"));
  const statePath = path.join(directory, "oauth.json");
  const original = JSON.stringify(isolatedOAuthState("failure-path-token"));
  await writeFile(statePath, original, { mode: 0o600 });
  let attempts = 0;
  try {
    await assert.rejects(
      runExactReadonlyCall({
        statePath,
        spawn(_command, _argv, options) {
          attempts += 1;
          const staged = JSON.parse(readFileSync(options.env.MCP_INSPECTOR_OAUTH_STATE_PATH, "utf8"));
          assert.equal(staged.servers[new URL(A03.resource).href].tokens.access_token, "failure-path-token");
          return { status: 3, stdout: "", stderr: "auth required" };
        },
      }),
      /failed closed \(exit 3\); no retry was attempted/,
    );
    assert.equal(attempts, 1);
    assert.equal(await readFile(statePath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads and clears only the fixed A03 OAuth state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clued-a03-"));
  const statePath = path.join(directory, "oauth.json");
  const other = "https://other.example/mcp";
  const state = {
    servers: {
      [new URL(A03.resource).href]: {
        activeIssuer: A03.issuer,
        preregisteredClientInformation: { client_id: A03.clientId },
        byIssuer: {
          [A03.issuer]: { tokens: { access_token: "secret-token-must-not-be-returned" } },
        },
      },
      [other]: { tokens: { access_token: "other-secret" } },
    },
    idpSessions: {},
  };
  try {
    await writeFile(statePath, JSON.stringify(state));
    assert.equal(await readStoredAccessToken(statePath), "secret-token-must-not-be-returned");
    assert.deepEqual(await clearStoredA03State(statePath), {
      cleared_resource: A03.resource,
      other_server_count: 1,
    });
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(after.servers[other].tokens.access_token, "other-secret");
    assert.equal(after.servers[new URL(A03.resource).href], undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
