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
// Every production flag that changes tools/list is a matrix dimension (IntegrationRuntime §12.6 adds
// CLUED_INTEGRATION_RUNTIME_V1).
const FLAGS = ["PROJECT_VIEWS_V2", "P5_TENANT_WRITES", "CLUED_INTEGRATION_RUNTIME_V1"] as const;
assert.equal(flags.full_matrix.length, 2 ** FLAGS.length,
  `tool-versions.json: full_matrix must contain exactly ${2 ** FLAGS.length} flag combinations`);

function key(item: Record<string, unknown>) {
  return FLAGS.map((flag) => String(item[flag])).join("|");
}

const requiredKeys = Array.from({ length: 2 ** FLAGS.length }, (_, n) =>
  FLAGS.map((_, bit) => String(Boolean(n & (1 << (FLAGS.length - 1 - bit))))).join("|")).sort();
const declaredKeys: string[] = [];

for (const item of flags.full_matrix) {
  for (const flag of FLAGS) assert.equal(typeof item[flag], "boolean", `${flag} metadata must be boolean`);
  assert.ok(
    Number.isInteger(item.expected_tool_count) && item.expected_tool_count > 0,
    "expected_tool_count metadata must be a positive integer",
  );
  declaredKeys.push(key(item));
}
assert.deepEqual([...new Set(declaredKeys)].sort(), requiredKeys, "tool-versions.json: full flag matrix is incomplete or duplicated");

const production = flags.production_equivalent;
assert.ok(production && typeof production === "object", "tool-versions.json: production_equivalent missing");
for (const flag of FLAGS) assert.equal(typeof production[flag], "boolean", `production ${flag} must be boolean`);
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

const results = flags.full_matrix.map((item: Record<(typeof FLAGS)[number], boolean> & { expected_tool_count: number }) => {
  const env = Object.fromEntries(FLAGS.map((flag) => [flag, item[flag] ? "true" : "false"])) as
    Record<(typeof FLAGS)[number], string>;
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
