import assert from "node:assert/strict";
import fs from "node:fs";

const components = JSON.parse(fs.readFileSync(
  new URL("../../../../config/clued-components.json", import.meta.url), "utf8",
)).components;
assert.ok(Array.isArray(components), "component manifest must contain components");
const mcpComponents = components.filter((component) => component?.id === "mcp.server");
assert.equal(mcpComponents.length, 1, "component manifest must contain exactly one mcp.server");
const mcpServerVersion = mcpComponents[0].version;
assert.ok(typeof mcpServerVersion === "string" && mcpServerVersion.length > 0
  && mcpServerVersion.trim() === mcpServerVersion, "mcp.server version must be a nonempty string");

const url = process.env.MCP_ISOLATED_URL ?? "http://127.0.0.1:8787/mcp";
async function rpc(id, method, params = {}, authenticated = true) {
  const headers = { "content-type": "application/json" };
  if (authenticated) headers.authorization = `Bearer clued_bnd_${"a".repeat(43)}`;
  return await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const anonymousInitialize = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  }),
});
assert.equal(anonymousInitialize.status, 401);
assert.match(anonymousInitialize.headers.get("www-authenticate") ?? "", /^Bearer realm="Clued", resource_metadata=/);

const initialize = await rpc(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "clued-public-mcp-acceptance", version: "1.0" },
});
assert.equal(initialize.status, 200);
const initialized = await initialize.json();
assert.equal(initialized.result.protocolVersion, "2025-06-18");
assert.deepEqual(initialized.result.serverInfo, { name: "BeamingFace Continuity", version: mcpServerVersion });

const ping = await rpc(2, "ping");
assert.equal(ping.status, 200);
assert.deepEqual((await ping.json()).result, {});

const listed = await rpc(3, "tools/list");
assert.equal(listed.status, 200);
const listEnvelope = await listed.json();
const baseline = JSON.parse(fs.readFileSync(new URL("./tools-list.baseline.json", import.meta.url), "utf8"));
assert.deepEqual(listEnvelope.result.tools, baseline.tools);

const protectedCall = await rpc(4, "tools/call", {
  name: "clued_session_resume",
  arguments: { context_key: "accept-pos-project" },
}, false);
assert.equal(protectedCall.status, 401);
assert.match(protectedCall.headers.get("www-authenticate") ?? "", /^Bearer realm="Clued", resource_metadata=/);
assert.match((await protectedCall.json()).error.message, /Authorize with BeamingFace OAuth or a Clued Binding Token/);

console.log(JSON.stringify({
  status: "PASS",
  protocol_version: initialized.result.protocolVersion,
  server_info: initialized.result.serverInfo,
  tool_count: listEnvelope.result.tools.length,
  protected_call_status: protectedCall.status,
  initialization_challenge_status: anonymousInitialize.status,
  challenge_present: true,
}));
