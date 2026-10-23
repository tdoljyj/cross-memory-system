import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import { AGENT_BOOTSTRAP_BUDGET_BYTES, renderAgentContractBootstrap, renderedBootstrapBytes } from "../worker/agent-contract-bootstrap.mjs";
import { validateAgentContractResponse } from "../scripts/render-agent-contract-budget.mjs";

const hash = (markdown) => createHash("sha256").update(markdown).digest("hex");
const bootstrap = {
  schema_version: "1.0", kernel_version: "0.4.5", components: { versions: { "mcp.server": "0.4.5" } },
  lifecycle: { contract: { version: 42, url: "https://clued.test/clued-agent.md" } },
  endpoints: { mcp: "https://clued.test/mcp" }, authentication: { scheme: "Bearer" }, capabilities: { arbitrary: true },
};
const source = (markdown) => ({ markdown, version: Number(/^Contract version: (\d+)$/m.exec(markdown)?.[1] ?? 42), sha256: hash(markdown) });

function allParts(markdown, payload = bootstrap) {
  const contract = source(markdown);
  const first = renderAgentContractBootstrap(payload, contract);
  const responses = Array.from({ length: first.structuredContent.agent_contract.parts }, (_, index) =>
    renderAgentContractBootstrap(payload, contract, index + 1));
  assert.equal(responses.map((response) => response.content[1].text).join(""), markdown);
  assert.equal(hash(responses.map((response) => response.content[1].text).join("")), contract.sha256);
  for (const [index, response] of responses.entries()) {
    assert.ok(renderedBootstrapBytes(response) <= AGENT_BOOTSTRAP_BUDGET_BYTES);
    assert.equal(response.structuredContent.agent_contract.part, index + 1);
    assert.equal(response.structuredContent.agent_contract.sha256, contract.sha256);
    assert.equal(response.structuredContent.agent_contract.version, contract.version);
  }
  return responses;
}

test("current source travels exactly once, while full public metadata stays in content[0]", async () => {
  const markdown = (await fs.readFile(new URL("../../../protocol/agent/agent-contract.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const contract = source(markdown);
  const payload = { ...bootstrap, lifecycle: { ...bootstrap.lifecycle, contract: { ...bootstrap.lifecycle.contract, version: contract.version } },
    agent_contract: { version: contract.version, sha256: contract.sha256 } };
  const responses = allParts(markdown, payload);
  for (const [index,response] of responses.entries()) {
    assert.equal(response.content.length, responses.length === 1 ? 2 : 3);
    assert.deepEqual(JSON.parse(response.content[0].text), payload);
    assert.equal(response.structuredContent.agent_contract.version, contract.version);
    assert.equal(response.structuredContent.agent_contract.markdown_in, "content[1]");
    for (const field of ["endpoints", "authentication", "capabilities"]) assert.equal(field in response.structuredContent, false);
    assert.equal(JSON.stringify(response.structuredContent).includes("# BeamingFace Agent Contract"), false);
    if (responses.length > 1) assert.match(response.content[2].text, index === responses.length - 1 ? /last part/ : /part=/);
  }
});

test("oversized contract uses the fewest whole-section parts and an explicit next/last hint", () => {
  const markdown = "# Contract\nContract version: 42\n" + Array.from({ length: 3 }, (_, i) => `## Section ${i}\n${"x".repeat(40_000)}\n`).join("");
  const responses = allParts(markdown);
  assert.equal(responses.length, 3);
  assert.match(responses[0].content[2].text, /Part 1 of 3.*part=2/);
  assert.match(responses[2].content[2].text, /Part 3 of 3.*last part/);
  assert.ok(responses.slice(1).every((response) => response.content[1].text.startsWith("## ")));
  assert.ok(responses[0].content[1].text.includes("Contract version: 42"));
});

test("UTF-8 and JSON escaping count against the actual complete response budget", () => {
  const markdown = "Contract version: 42\n" + Array.from({ length: 3 }, (_, i) => `## 中文 ${i}\n${'字"\\\n'.repeat(7_000)}`).join("");
  assert.ok(allParts(markdown).length > 1);
});

test("fenced pseudo-headings are never partition boundaries", () => {
  for (const fence of ["```", "~~~~"]) {
    const markdown = `Contract version: 42\n## Large\n${fence}\n${"x".repeat(40_000)}\n## Not a boundary\n${"x".repeat(40_000)}\n${fence}\n## Next\nsmall\n`;
    assert.throws(() => renderAgentContractBootstrap(bootstrap, source(markdown)), RangeError);
  }
});

test("indivisible sections fail rather than dropping or trimming contract bytes", () => {
  const markdown = `Contract version: 42\n## Large\n${"x".repeat(80_000)}\n`;
  assert.throws(() => renderAgentContractBootstrap(bootstrap, source(markdown)), RangeError);
});

test("invalid parts return a tool error with the real part count", () => {
  const markdown = "Contract version: 42\n## Rules\ncomplete\n";
  for (const part of [0, 2, -1, 1.5, "1", null, NaN, Infinity]) {
    const result = renderAgentContractBootstrap(bootstrap, source(markdown), part);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.parts, 1);
    assert.equal(result.content.length, 1);
  }
});

test("larger metadata can force a split even when contract bytes alone fit", () => {
  const payload = { ...bootstrap, capabilities: { ...bootstrap.capabilities, metadata: "x".repeat(15_000) } };
  const markdown = "Contract version: 42\n" + Array.from({ length: 2 }, (_, i) => `## Section ${i}\n${"x".repeat(32_000)}\n`).join("");
  assert.equal(allParts(markdown, payload).length, 2);
});

test("rendering has no shared mutable request state", () => {
  const first = source("Contract version: 42\n## Rules\nfirst\n");
  const second = source("Contract version: 43\n## Rules\nsecond\n");
  second.version = 43;
  assert.equal(renderAgentContractBootstrap(bootstrap, first).content[1].text, first.markdown);
  assert.equal(renderAgentContractBootstrap(bootstrap, second).structuredContent.agent_contract.version, 43);
  assert.equal(renderAgentContractBootstrap(bootstrap, first).structuredContent.agent_contract.version, 42);
});

test("budget probe rejects duplicated multiline fragments and extra response fields", () => {
  const contract = source("Contract version: 42\n## Rules\ncomplete multiline text\n");
  const payload = { ...bootstrap, agent_contract: { version: contract.version, sha256: contract.sha256 } };
  const valid = renderAgentContractBootstrap(payload, contract);
  assert.deepEqual(validateAgentContractResponse(valid, contract, 1), payload);
  for (const surface of ["bootstrap", "structured", "content"]) {
    const response = structuredClone(valid);
    if (surface === "bootstrap") response.content[0].text = JSON.stringify({ ...payload, duplicate: contract.markdown });
    if (surface === "structured") response.structuredContent.duplicate = contract.markdown;
    if (surface === "content") response.content.push({ type: "text", text: "extra" });
    assert.throws(() => validateAgentContractResponse(response, contract, 1));
  }
  const oversized = source("Contract version: 42\n" + Array.from({ length: 3 }, (_, i) => `## Section ${i}\n${"x".repeat(40_000)}\n`).join(""));
  const metadata = { ...bootstrap, agent_contract: { version: oversized.version, sha256: oversized.sha256 } };
  const part = renderAgentContractBootstrap(metadata, oversized, 2);
  assert.doesNotThrow(() => validateAgentContractResponse(part, oversized, 2));
  part.structuredContent.duplicate = part.content[1].text;
  assert.throws(() => validateAgentContractResponse(part, oversized, 2));
});
