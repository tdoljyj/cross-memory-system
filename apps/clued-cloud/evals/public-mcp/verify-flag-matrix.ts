import assert from "node:assert/strict";
import fs from "node:fs";
import { publicMcpTools } from "../../worker/continuity";

const toolVersions = JSON.parse(
  fs.readFileSync(new URL("./tool-versions.json", import.meta.url), "utf8"),
);
const baseline = JSON.parse(
  fs.readFileSync(new URL("./tools-list.baseline.json", import.meta.url), "utf8"),
);

const flags = toolVersions?.feature_flags;
assert.ok(flags && typeof flags === "object", "tool-versions.json: feature_flags missing");
assert.ok(Array.isArray(flags.full_matrix), "tool-versions.json: full_matrix missing");
assert.equal(flags.full_matrix.length, 4, "tool-versions.json: full_matrix must contain exactly four flag combinations");

function key(item: Record<string, unknown>) {
  return `${String(item.PROJECT_VIEWS_V2)}|${String(item.P5_TENANT_WRITES)}`;
}

const requiredKeys = ["false|false", "false|true", "true|false", "true|true"];
const declaredKeys: string[] = [];

for (const item of flags.full_matrix) {
  assert.equal(typeof item.PROJECT_VIEWS_V2, "boolean", "PROJECT_VIEWS_V2 metadata must be boolean");
  assert.equal(typeof item.P5_TENANT_WRITES, "boolean", "P5_TENANT_WRITES metadata must be boolean");
  assert.ok(
    Number.isInteger(item.expected_tool_count) && item.expected_tool_count > 0,
    "expected_tool_count metadata must be a positive integer",
  );
  declaredKeys.push(key(item));
}
assert.deepEqual([...new Set(declaredKeys)].sort(), requiredKeys, "tool-versions.json: full flag matrix is incomplete or duplicated");

const production = flags.production_equivalent;
assert.ok(production && typeof production === "object", "tool-versions.json: production_equivalent missing");
assert.equal(typeof production.PROJECT_VIEWS_V2, "boolean", "production PROJECT_VIEWS_V2 must be boolean");
assert.equal(typeof production.P5_TENANT_WRITES, "boolean", "production P5_TENANT_WRITES must be boolean");
assert.ok(
  Number.isInteger(production.expected_tool_count) && production.expected_tool_count > 0,
  "production expected_tool_count must be a positive integer",
);

const productionKey = key(production);
const productionRows = flags.full_matrix.filter((item: Record<string, unknown>) => key(item) === productionKey);
assert.equal(productionRows.length, 1, "production-equivalent flags must resolve to exactly one full_matrix row");
assert.equal(
  productionRows[0].expected_tool_count,
  production.expected_tool_count,
  "production-equivalent tool count disagrees with full_matrix",
);
assert.equal(
  baseline.tools.length,
  production.expected_tool_count,
  "frozen tools baseline count disagrees with tool-versions.json production metadata",
);

const results = flags.full_matrix.map((item: {
  PROJECT_VIEWS_V2: boolean;
  P5_TENANT_WRITES: boolean;
  expected_tool_count: number;
}) => {
  const env = {
    PROJECT_VIEWS_V2: item.PROJECT_VIEWS_V2 ? "true" : "false",
    P5_TENANT_WRITES: item.P5_TENANT_WRITES ? "true" : "false",
  };
  const tools = publicMcpTools(env);
  assert.equal(
    tools.length,
    item.expected_tool_count,
    `runtime tool count disagrees with tool-versions.json for ${JSON.stringify(env)}`,
  );
  if (key(item as unknown as Record<string, unknown>) === productionKey) {
    assert.deepEqual(tools, baseline.tools, "production-equivalent flag case differs from frozen baseline");
  }
  return {
    ...env,
    tool_count: tools.length,
  };
});

console.log(JSON.stringify({ status: "PASS", matrix: results, metadata_bound: true }));
