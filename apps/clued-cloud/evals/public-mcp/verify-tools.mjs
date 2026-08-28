import assert from "node:assert/strict";
import fs from "node:fs";

const [actualPath, baselinePath] = process.argv.slice(2);
if (!actualPath) throw new Error("usage: node verify-tools.mjs <actual.json> [baseline.json]");

const envelope = JSON.parse(fs.readFileSync(actualPath, "utf8"));
const tools = envelope.result?.tools ?? envelope.tools ?? envelope;
assert.ok(Array.isArray(tools), "tools/list result must contain an array");
assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, "tool names must be unique");

const internalPattern = /(admin|maintenance|operator|debug|internal)/i;
for (const tool of tools) {
  assert.equal(typeof tool.name, "string", "tool name must be a string");
  assert.equal(typeof tool.description, "string", `${tool.name}: description missing`);
  assert.match(tool.description, /Required Clued scope|no authenticated Clued scope/i, `${tool.name}: scope statement missing`);
  assert.equal(tool.inputSchema?.type, "object", `${tool.name}: inputSchema must be an object schema`);
  assert.equal(tool.outputSchema?.type, "object", `${tool.name}: outputSchema must be an object schema`);
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name}: ${hint} missing`);
  }
  assert.ok(Array.isArray(tool._meta?.["clued/requiredScopes"]), `${tool.name}: required scopes metadata missing`);
  assert.equal(tool._meta?.["clued/scopeEnforcement"], "server-side", `${tool.name}: scope enforcement metadata missing`);
  assert.equal(internalPattern.test(tool.name), false, `${tool.name}: internal tool name exposed`);
}

if (baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.deepEqual(tools, baseline.tools, "tools/list differs from the frozen feature-flag baseline");
}

console.log(JSON.stringify({ status: "PASS", tool_count: tools.length, metadata_coverage: "100%" }));
