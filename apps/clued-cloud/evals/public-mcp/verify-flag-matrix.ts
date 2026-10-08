import assert from "node:assert/strict";
import fs from "node:fs";
import { publicMcpTools } from "../../worker/continuity";
import { isModelDomainTool, modelDomainTools, MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL,
  MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL,
  MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL, MODEL_DOMAIN_PLAN_PREPARATION_TOOL,
  MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL } from "../../worker/model-domain-tools";

const toolVersions = JSON.parse(
  fs.readFileSync(new URL("./tool-versions.json", import.meta.url), "utf8"),
);
const baseline = JSON.parse(
  fs.readFileSync(new URL("./tools-list.baseline.json", import.meta.url), "utf8"),
);

const flags = toolVersions?.feature_flags;
assert.ok(flags && typeof flags === "object", "tool-versions.json: feature_flags missing");
assert.ok(Array.isArray(flags.full_matrix), "tool-versions.json: full_matrix missing");
// All rows retain identical defaults for flags outside these five dimensions.
// In particular OwnerRequests is OFF: BOOTSTRAP alone cannot open its existing
// prerequisite. Its positive/negative dependency cases are separate Worker tests.
const FLAGS = ["PROJECT_VIEWS_V2", "P5_TENANT_WRITES", "CLUED_INTEGRATION_RUNTIME_V1",
  "CLUED_MODEL_DOMAIN_SOURCE_V1", "CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1"] as const;
const READ_MODEL_TOOLS = [MODEL_REFERENCE_OWNER_APPROVAL_REFS_TOOL, MODEL_DOMAIN_OWNER_ANCHOR_REFS_TOOL,
  MODEL_DOMAIN_REFS_TOOL, MODEL_DOMAIN_VERIFY_TOOL, MODEL_DOMAIN_PLAN_PREPARATION_TOOL,
  MODEL_DOMAIN_SUCCESSOR_VERIFY_TOOL];
const modelOutputSchema = { type: "object",
  description: "Structured Clued result. Tool-specific fields are versioned by the Canonical Store contract.",
  additionalProperties: true };
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
  const independentCount = 18 + (item.PROJECT_VIEWS_V2 ? 11 : 0) + (item.P5_TENANT_WRITES ? 5 : 0)
    + (item.CLUED_INTEGRATION_RUNTIME_V1 ? 7 : 0)
    + (item.PROJECT_VIEWS_V2 && item.CLUED_MODEL_DOMAIN_SOURCE_V1 ? 6 : 0);
  assert.equal(tools.length, independentCount, "five-flag count differs from independent legacy plus six-readonly counts");
  const modelTools = tools.filter((tool) => isModelDomainTool(tool.name));
  assert.deepEqual(modelTools.map((tool) => tool.name),
    item.PROJECT_VIEWS_V2 && item.CLUED_MODEL_DOMAIN_SOURCE_V1 ? READ_MODEL_TOOLS : [],
    "Model readonly tools require both existing Records and source flags");
  assert.equal(tools.some((tool) => tool.name === MODEL_DOMAIN_BOOTSTRAP_REQUEST_TOOL), false,
    "all 32 uniform rows leave the existing OwnerRequests prerequisite OFF");
  for (const tool of modelTools) {
    const descriptor = modelDomainTools.find((candidate) => candidate.name === tool.name);
    assert.ok(descriptor, "Model tool must have an existing registered descriptor");
    assert.deepEqual(tool.inputSchema, descriptor.inputSchema, `${tool.name}: exact registered input schema`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: caller fields remain closed`);
    assert.deepEqual(tool.outputSchema, modelOutputSchema, `${tool.name}: existing public structured result schema`);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false,
      idempotentHint: tool.name !== MODEL_DOMAIN_PLAN_PREPARATION_TOOL, openWorldHint: true });
    assert.ok("_meta" in tool && typeof tool._meta === "object" && tool._meta !== null
      && !Array.isArray(tool._meta), `${tool.name}: public metadata object is required`);
    const meta = tool._meta;
    assert.ok("clued/requiredScopes" in meta, `${tool.name}: required scopes metadata is missing`);
    assert.deepEqual(meta["clued/requiredScopes"], ["context:read"]);
    assert.ok("clued/scopeEnforcement" in meta, `${tool.name}: scope enforcement metadata is missing`);
    assert.equal(meta["clued/scopeEnforcement"], "server-side");
    assert.match(tool.description, /Required Clued scope: context:read/);
  }
  if (key(item) === productionKey) {
    assert.deepEqual(tools, baseline.tools, "production-equivalent flag case differs from frozen baseline");
  }
  return {
    ...env,
    tool_count: tools.length,
  };
});

const productionOff = publicMcpTools({ PROJECT_VIEWS_V2: "true", P5_TENANT_WRITES: "false",
  CLUED_INTEGRATION_RUNTIME_V1: "true", CLUED_MODEL_DOMAIN_SOURCE_V1: "false",
  CLUED_MODEL_DOMAIN_BOOTSTRAP_REQUEST_V1: "false" });
assert.equal(productionOff.length, 36, "the ordinary source-OFF baseline remains 36 tools");
assert.equal(JSON.stringify(productionOff), JSON.stringify(baseline.tools.filter((tool: { name: string }) => !isModelDomainTool(tool.name))),
  "filtering the six production readonly additions must preserve every ordinary tool byte and order");

console.log(JSON.stringify({ status: "PASS", matrix: results, metadata_bound: true }));
