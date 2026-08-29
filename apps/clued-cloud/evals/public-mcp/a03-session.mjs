import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import {
  A03,
  decodeJwtClaims,
  exactReadonlyCallArgv,
  resolveInspectorInstall,
  validateAuthorizationRequest,
  validateAndRedactClaims,
} from "./a03-contract.mjs";
import {
  createA03InspectorProxy,
  pkceAssertionPath,
} from "./a03-pkce-proxy.mjs";

export function oauthStatePath(env = process.env) {
  return env.MCP_INSPECTOR_OAUTH_STATE_PATH
    ?? path.join(env.MCP_STORAGE_DIR ?? path.join(homedir(), ".mcp-inspector", "storage"), "oauth.json");
}

export function a03InspectorEnvironment(env = process.env, statePath = oauthStatePath(env)) {
  return {
    ...env,
    // Inspector 2.4.0 derives the OAuth redirect host from HOST. Its default is
    // 127.0.0.1, but the registered public client permits only localhost:6400.
    HOST: "localhost",
    CLIENT_PORT: "6400",
    MCP_INSPECTOR_OAUTH_STATE_PATH: statePath,
  };
}

export function a03InspectorWebEnvironment(env = process.env, statePath = oauthStatePath(env)) {
  return {
    ...a03InspectorEnvironment(env, statePath),
    CLIENT_PORT: String(A03.inspectorInternalPort),
    ALLOWED_ORIGINS: `http://localhost:${A03.inspectorProxyPort}`,
    MCP_AUTO_OPEN_ENABLED: "false",
  };
}

function normalizedResource() {
  return new URL(A03.resource).href;
}

function activeOAuthSlot(server) {
  if (server.activeIssuer && server.byIssuer?.[server.activeIssuer]) {
    return server.byIssuer[server.activeIssuer];
  }
  return server;
}

export async function readStoredAccessToken(statePath) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const server = state.servers?.[normalizedResource()] ?? state.servers?.[A03.resource];
  assert.ok(server, "A03 OAuth state is missing");
  const slot = activeOAuthSlot(server);
  const clientInformation = slot.clientInformation
    ?? server.clientInformation
    ?? server.preregisteredClientInformation;
  const tokens = slot.tokens ?? server.tokens;
  assert.equal(clientInformation?.client_id, A03.clientId, "stored OAuth client_id drift");
  assert.equal(typeof tokens?.access_token, "string", "stored access token is missing");
  return tokens.access_token;
}

export async function clearStoredA03State(statePath) {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.servers ??= {};
  delete state.servers[A03.resource];
  delete state.servers[normalizedResource()];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return { cleared_resource: A03.resource, other_server_count: Object.keys(state.servers).length };
}

export async function stageStoredAuthForInspectorCli(statePath) {
  const original = await readFile(statePath);
  const state = JSON.parse(original.toString("utf8"));
  const resource = normalizedResource();
  const key = state.servers?.[resource] ? resource : A03.resource;
  const server = state.servers?.[key];
  assert.ok(server, "A03 OAuth state is missing");
  const slot = activeOAuthSlot(server);
  const clientInformation = slot.clientInformation
    ?? server.clientInformation
    ?? server.preregisteredClientInformation;
  const tokens = slot.tokens ?? server.tokens;
  const serverMetadata = slot.serverMetadata ?? server.serverMetadata;
  assert.equal(clientInformation?.client_id, A03.clientId, "stored OAuth client_id drift");
  assert.equal(typeof tokens?.access_token, "string", "stored access token is missing");

  // Inspector 2.4.0 Web persists issuer-scoped auth under byIssuer[activeIssuer],
  // while its CLI --use-stored-auth reader only checks the top-level fields.
  // Stage the minimum compatibility projection in the same isolated state file;
  // callers must restore the exact original bytes in a finally block.
  state.servers[key] = {
    ...server,
    tokens,
    clientInformation,
    ...(serverMetadata ? { serverMetadata } : {}),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return async function restoreOriginalState() {
    await writeFile(statePath, original, { mode: 0o600 });
  };
}

export async function runInspectorWeb({
  spawnProcess = spawn,
  proxyFactory = createA03InspectorProxy,
  env = process.env,
  statePath = oauthStatePath(env),
} = {}) {
  const { launcherPath } = await resolveInspectorInstall();
  const configPath = fileURLToPath(new URL("./a03-inspector-config.json", import.meta.url));
  const storageDir = env.MCP_STORAGE_DIR ?? path.dirname(statePath);
  const proxy = await proxyFactory({
    listenPort: A03.inspectorProxyPort,
    internalPort: A03.inspectorInternalPort,
    storageDir,
  });
  try {
    const child = spawnProcess(process.execPath, [launcherPath, "--config", configPath], {
      env: a03InspectorWebEnvironment(env, statePath),
      stdio: "inherit",
      windowsHide: true,
    });
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (code !== 0) {
      throw new Error(`Inspector Web exited with status ${String(code)}${signal ? ` (${signal})` : ""}`);
    }
  } finally {
    await proxy.close();
  }
}

export async function readRedactedPkceAssertion(env = process.env) {
  const storageDir = env.MCP_STORAGE_DIR ?? path.dirname(oauthStatePath(env));
  const assertion = JSON.parse(await readFile(pkceAssertionPath(storageDir), "utf8"));
  const expectedKeys = [
    "authorization_endpoint",
    "captured_at",
    "client_id",
    "code_challenge_length",
    "code_challenge_method",
    "code_challenge_present",
    "contract",
    "redirect_uri",
    "resource",
    "response_type",
    "scope",
  ];
  assert.deepEqual(Object.keys(assertion).sort(), expectedKeys, "unexpected PKCE assertion fields");
  assert.equal(assertion.contract, "clued-a03-pkce-redacted-v1");
  assert.ok(Number.isFinite(Date.parse(assertion.captured_at)), "invalid PKCE capture timestamp");
  assert.equal(assertion.authorization_endpoint, A03.authorizationEndpoint);
  assert.equal(assertion.response_type, "code");
  assert.equal(assertion.client_id, A03.clientId);
  assert.equal(assertion.redirect_uri, A03.callbackUrl);
  assert.equal(assertion.resource, A03.resource);
  assert.equal(assertion.code_challenge_method, "S256");
  assert.equal(assertion.code_challenge_present, true);
  assert.ok(assertion.code_challenge_length > 0);
  assert.ok(
    Array.isArray(assertion.scope) && assertion.scope.every((item) => A03.oauthScopes.includes(item)),
    "unexpected PKCE assertion scope",
  );
  return Object.fromEntries(expectedKeys.map((key) => [key, assertion[key]]));
}

function summarizeInspectorResult(stdout) {
  const parsed = JSON.parse(stdout);
  const structured = parsed?.structuredContent
    ?? parsed?.result?.structuredContent
    ?? parsed?.result
    ?? parsed;
  const projects = Array.isArray(structured?.projects) ? structured.projects : null;
  assert.ok(projects, "Inspector result does not contain a projects array");
  return {
    status: "ok",
    inspector_version: A03.inspectorVersion,
    tool: A03.tool,
    arguments: {},
    protected_tool_transport_attempts: 1,
    project_count: projects.length,
  };
}

export async function runExactReadonlyCall({
  spawn = spawnSync,
  statePath = oauthStatePath(),
} = {}) {
  const { launcherPath } = await resolveInspectorInstall();
  const argv = exactReadonlyCallArgv(launcherPath);
  const restoreOriginalState = await stageStoredAuthForInspectorCli(statePath);
  let result;
  try {
    result = spawn(process.execPath, argv, {
      encoding: "utf8",
      env: a03InspectorEnvironment(process.env, statePath),
      windowsHide: true,
    });
  } finally {
    await restoreOriginalState();
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Inspector call failed closed (exit ${String(result.status)}); no retry was attempted`);
  }
  return summarizeInspectorResult(result.stdout);
}

async function main() {
  const command = process.argv[2];
  const statePath = oauthStatePath();
  if (command === "authorization-request") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(`${JSON.stringify(validateAuthorizationRequest(input.trim()), null, 2)}\n`);
    return;
  }
  if (command === "inspector") {
    await runInspectorWeb({ statePath });
    return;
  }
  if (command === "claims") {
    const token = await readStoredAccessToken(statePath);
    process.stdout.write(`${JSON.stringify(validateAndRedactClaims(decodeJwtClaims(token)), null, 2)}\n`);
    return;
  }
  if (command === "pkce") {
    process.stdout.write(`${JSON.stringify(await readRedactedPkceAssertion(), null, 2)}\n`);
    return;
  }
  if (command === "call") {
    process.stdout.write(`${JSON.stringify(await runExactReadonlyCall(), null, 2)}\n`);
    return;
  }
  if (command === "clear") {
    process.stdout.write(`${JSON.stringify(await clearStoredA03State(statePath), null, 2)}\n`);
    return;
  }
  throw new Error("Usage: node a03-session.mjs <inspector|authorization-request|pkce|claims|call|clear>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
