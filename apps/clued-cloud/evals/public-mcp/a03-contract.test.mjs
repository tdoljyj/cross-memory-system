import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  A03,
  exactReadonlyCallArgv,
  resolveInspectorInstall,
  validateAndRedactClaims,
  validateAuthorizationRequest,
} from "./a03-contract.mjs";
import {
  a03InspectorEnvironment,
  a03InspectorWebEnvironment,
  clearStoredA03State,
  readRedactedPkceAssertion,
  readStoredAccessToken,
  runExactReadonlyCall,
  runInspectorWeb,
} from "./a03-session.mjs";
import {
  captureRedactedPkceAssertion,
  createA03InspectorProxy,
  instrumentInspectorBundle,
  instrumentInspectorHtml,
  pkceAssertionPath,
} from "./a03-pkce-proxy.mjs";

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
  const url = new URL(A03.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", A03.clientId);
  url.searchParams.set("redirect_uri", A03.callbackUrl);
  url.searchParams.set("resource", A03.resource);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", "redacted-nonempty-value");
  url.searchParams.set("scope", "openid email profile");
  assert.deepEqual(validateAuthorizationRequest(url), {
    authorization_endpoint: A03.authorizationEndpoint,
    response_type: "code",
    client_id: A03.clientId,
    redirect_uri: A03.callbackUrl,
    resource: A03.resource,
    code_challenge_method: "S256",
    code_challenge_present: true,
    code_challenge_length: 23,
    scope: ["openid", "email", "profile"],
  });
  const wrongCallback = new URL(url);
  wrongCallback.searchParams.set("redirect_uri", "http://127.0.0.1:6400/oauth/callback");
  assert.throws(() => validateAuthorizationRequest(wrongCallback), /redirect_uri/);
  url.searchParams.set("code_challenge_method", "plain");
  assert.throws(() => validateAuthorizationRequest(url), /S256/);
});

test("persists only a redacted one-shot PKCE assertion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clued-a03-pkce-"));
  const outputPath = pkceAssertionPath(directory);
  const url = new URL(A03.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", A03.clientId);
  url.searchParams.set("redirect_uri", A03.callbackUrl);
  url.searchParams.set("resource", A03.resource);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", "complete-secret-challenge-must-not-persist");
  url.searchParams.set("state", "complete-secret-state-must-not-persist");
  url.searchParams.set("scope", "openid email profile");
  try {
    const assertion = await captureRedactedPkceAssertion(url.href, outputPath, {
      now: () => new Date("2026-08-29T06:00:00.000Z"),
    });
    assert.equal(assertion.code_challenge_present, true);
    assert.equal(assertion.code_challenge_length, 42);
    const stored = await readFile(outputPath, "utf8");
    assert.doesNotMatch(stored, /complete-secret-challenge|complete-secret-state|code_verifier|authorization_code/);
    await assert.rejects(
      captureRedactedPkceAssertion(url.href, outputPath),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to echo unexpected fields from a tampered PKCE assertion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clued-a03-pkce-tamper-"));
  const outputPath = pkceAssertionPath(directory);
  const valid = {
    authorization_endpoint: A03.authorizationEndpoint,
    captured_at: "2026-08-29T06:00:00.000Z",
    client_id: A03.clientId,
    code_challenge_length: 43,
    code_challenge_method: "S256",
    code_challenge_present: true,
    contract: "clued-a03-pkce-redacted-v1",
    redirect_uri: A03.callbackUrl,
    resource: A03.resource,
    response_type: "code",
    scope: ["openid", "email", "profile"],
  };
  try {
    await writeFile(outputPath, JSON.stringify({ ...valid, code_challenge: "must-not-echo" }));
    await assert.rejects(
      readRedactedPkceAssertion({ MCP_STORAGE_DIR: directory }),
      /unexpected PKCE assertion fields/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("instruments the exact Inspector 2.4.0 navigation hook fail closed", () => {
  const observerPath = `/__a03/pkce-assertion/${"a".repeat(64)}`;
  const source = "before;return t?.(n),window.location.href=n.href,e?.(n);after";
  const instrumented = instrumentInspectorBundle(source, observerPath);
  assert.match(instrumented, /XMLHttpRequest/);
  assert.match(instrumented, /A03 PKCE capture failed closed/);
  assert.match(instrumented, new RegExp(observerPath));
  assert.throws(() => instrumentInspectorBundle("hook drift", observerPath), /navigation hook drift/);
});

test("cache-busts the Inspector main bundle with the one-shot observer nonce", () => {
  const nonce = "d".repeat(64);
  const observerPath = `/__a03/pkce-assertion/${nonce}`;
  const html = '<html><head><script type="module" src="/assets/index-fixed.js"></script></head></html>';
  const instrumented = instrumentInspectorHtml(html, observerPath);
  assert.match(instrumented, new RegExp(`/assets/index-fixed\\.js\\?a03_pkce=${nonce}`));
  assert.throws(() => instrumentInspectorHtml("<html></html>", observerPath), /bundle reference drift/);
});

test("finds the pinned navigation hook in the installed Inspector 2.4.0 bundle", async () => {
  const { packagePath } = await resolveInspectorInstall();
  const assetsDirectory = path.join(path.dirname(packagePath), "clients", "web", "dist", "assets");
  const bundleNames = (await readdir(assetsDirectory)).filter((name) => /^index-.*\.js$/.test(name));
  assert.equal(bundleNames.length, 1);
  const source = await readFile(path.join(assetsDirectory, bundleNames[0]), "utf8");
  const instrumented = instrumentInspectorBundle(
    source,
    `/__a03/pkce-assertion/${"c".repeat(64)}`,
  );
  assert.ok(instrumented.length > source.length);
  assert.match(instrumented, /A03 PKCE capture failed closed/);
});

test("proxies the Inspector bundle and accepts exactly one redacted assertion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clued-a03-proxy-"));
  const source = "before;return t?.(n),window.location.href=n.href,e?.(n);after";
  const upstream = http.createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<html><head><script type="module" src="/assets/index-test.js"></script></head></html>');
      return;
    }
    if (request.url === "/assets/index-test.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  upstream.listen(0, "localhost");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await createA03InspectorProxy({
    listenPort: 0,
    internalPort: upstreamAddress.port,
    storageDir: directory,
    observerNonce: "b".repeat(64),
  });
  try {
    const htmlResponse = await fetch(`http://localhost:${proxy.port}/`);
    assert.equal(htmlResponse.status, 200);
    assert.equal(htmlResponse.headers.get("cache-control"), "no-store");
    assert.match(await htmlResponse.text(), /index-test\.js\?a03_pkce=b{64}/);
    const bundleResponse = await fetch(`http://localhost:${proxy.port}/assets/index-test.js`);
    assert.equal(bundleResponse.status, 200);
    assert.equal(bundleResponse.headers.get("x-a03-pkce-capture"), "redacted-only");
    assert.match(await bundleResponse.text(), /A03 PKCE capture failed closed/);

    const url = new URL(A03.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", A03.clientId);
    url.searchParams.set("redirect_uri", A03.callbackUrl);
    url.searchParams.set("resource", A03.resource);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", "proxy-secret-challenge");
    url.searchParams.set("state", "proxy-secret-state");
    url.searchParams.set("scope", "openid email profile");
    const first = await fetch(`http://localhost:${proxy.port}${proxy.observerPath}`, {
      method: "POST",
      body: url.href,
    });
    assert.equal(first.status, 204);
    const stored = await readFile(proxy.assertionPath, "utf8");
    assert.doesNotMatch(stored, /proxy-secret-challenge|proxy-secret-state/);
    const second = await fetch(`http://localhost:${proxy.port}${proxy.observerPath}`, {
      method: "POST",
      body: url.href,
    });
    assert.equal(second.status, 409);
  } finally {
    await proxy.close();
    upstream.close();
    await once(upstream, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("forces the registered localhost callback origin for every Inspector process", () => {
  const statePath = path.join("isolated", "oauth.json");
  const env = a03InspectorEnvironment({
    HOST: "127.0.0.1",
    CLIENT_PORT: "6274",
    MCP_INSPECTOR_OAUTH_STATE_PATH: "wrong-state.json",
  }, statePath);
  assert.equal(env.HOST, "localhost");
  assert.equal(env.CLIENT_PORT, "6400");
  assert.equal(env.MCP_INSPECTOR_OAUTH_STATE_PATH, statePath);
  assert.equal(`http://${env.HOST}:${env.CLIENT_PORT}/oauth/callback`, A03.callbackUrl);
  const webEnv = a03InspectorWebEnvironment(env, statePath);
  assert.equal(webEnv.HOST, "localhost");
  assert.equal(webEnv.CLIENT_PORT, String(A03.inspectorInternalPort));
  assert.equal(webEnv.ALLOWED_ORIGINS, `http://localhost:${A03.inspectorProxyPort}`);
  assert.equal(webEnv.MCP_AUTO_OPEN_ENABLED, "false");
});

test("launches Inspector Web only through the fixed A03 environment", async () => {
  const calls = [];
  const proxyCalls = [];
  let proxyClosed = false;
  await runInspectorWeb({
    env: { HOST: "127.0.0.1", CLIENT_PORT: "6274" },
    statePath: path.join("isolated", "oauth.json"),
    async proxyFactory(options) {
      proxyCalls.push(options);
      return { async close() { proxyClosed = true; } };
    },
    spawnProcess(command, argv, options) {
      calls.push({ command, argv, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].listenPort, A03.inspectorProxyPort);
  assert.equal(proxyCalls[0].internalPort, A03.inspectorInternalPort);
  assert.equal(proxyClosed, true);
  assert.equal(calls[0].options.env.HOST, "localhost");
  assert.equal(calls[0].options.env.CLIENT_PORT, "6403");
  assert.equal(calls[0].options.env.ALLOWED_ORIGINS, "http://localhost:6400");
  assert.equal(calls[0].options.env.MCP_AUTO_OPEN_ENABLED, "false");
  assert.equal(calls[0].argv.at(-2), "--config");
  assert.match(calls[0].argv.at(-1), /a03-inspector-config\.json$/);
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
        assert.equal(options.env.HOST, "localhost");
        assert.equal(options.env.CLIENT_PORT, "6400");
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
