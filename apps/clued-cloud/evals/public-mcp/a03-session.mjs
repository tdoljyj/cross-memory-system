import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import {
  A03,
  decodeJwtClaims,
  exactReadonlyCallArgv,
  resolveInspectorInstall,
  validateAuthorizationRequest,
  validateAndRedactClaims,
} from "./a03-contract.mjs";

export function oauthStatePath(env = process.env) {
  return env.MCP_INSPECTOR_OAUTH_STATE_PATH
    ?? path.join(env.MCP_STORAGE_DIR ?? path.join(homedir(), ".mcp-inspector", "storage"), "oauth.json");
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
      env: {
        ...process.env,
        MCP_INSPECTOR_OAUTH_STATE_PATH: statePath,
      },
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
  if (command === "claims") {
    const token = await readStoredAccessToken(statePath);
    process.stdout.write(`${JSON.stringify(validateAndRedactClaims(decodeJwtClaims(token)), null, 2)}\n`);
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
  throw new Error("Usage: node a03-session.mjs <authorization-request|claims|call|clear>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
