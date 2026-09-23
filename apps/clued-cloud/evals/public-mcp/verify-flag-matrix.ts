import assert from "node:assert/strict";
import fs from "node:fs";
import { publicMcpTools } from "../../worker/continuity";

const cases = [
  { PROJECT_VIEWS_V2: "false", P5_TENANT_WRITES: "false", expected: 18 },
  { PROJECT_VIEWS_V2: "true", P5_TENANT_WRITES: "false", expected: 29, productionEquivalent: true },
  { PROJECT_VIEWS_V2: "false", P5_TENANT_WRITES: "true", expected: 23 },
  { PROJECT_VIEWS_V2: "true", P5_TENANT_WRITES: "true", expected: 34 },
] as const;

const results = cases.map((item) => {
  const tools = publicMcpTools(item);
  assert.equal(tools.length, item.expected, `unexpected count for ${JSON.stringify(item)}`);
  if ("productionEquivalent" in item) {
    const baseline = JSON.parse(fs.readFileSync(new URL("./tools-list.baseline.json", import.meta.url), "utf8"));
    assert.deepEqual(tools, baseline.tools, "production-equivalent flag case differs from frozen baseline");
  }
  return {
    PROJECT_VIEWS_V2: item.PROJECT_VIEWS_V2,
    P5_TENANT_WRITES: item.P5_TENANT_WRITES,
    tool_count: tools.length,
  };
});

console.log(JSON.stringify({ status: "PASS", matrix: results }));
