// Task af536fcc, ComponentVersioning.v0.2 §2.4 rule 4.
// Exercise the candidate Worker's public handler with all bootstrap feature flags;
// forbid outbound I/O and emit the actual current and synthetic-part responses.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderAgentContractBootstrap, renderedBootstrapBytes, AGENT_BOOTSTRAP_BUDGET_BYTES } from "../worker/agent-contract-bootstrap.mjs";

export function validateAgentContractResponse(response, contract, part) {
  const metadata = JSON.parse(response.content[0].text);
  const fragment = response.content[1]?.text;
  assert.ok(typeof fragment === "string" && fragment.length > 0);
  const containsFragment = (value) => typeof value === "string" ? value.includes(fragment)
    : value && typeof value === "object" ? Object.values(value).some(containsFragment) : false;
  assert.equal(containsFragment(metadata), false, "bootstrap metadata duplicates the current contract fragment");
  assert.equal(containsFragment(response.structuredContent), false, "structured metadata duplicates the current contract fragment");
  assert.deepEqual(metadata.agent_contract, { version: contract.version, sha256: contract.sha256 });
  assert.equal(metadata.lifecycle.contract.version, contract.version);
  assert.deepEqual(response, renderAgentContractBootstrap(metadata, contract, part));
  return metadata;
}

async function main() {
const options = process.argv.slice(2);
const valueOf = (key) => options[options.indexOf(key) + 1];
if (!options.includes("--worker-module") || !options.includes("--output")) {
  throw new Error("usage: render-agent-contract-budget.mjs --worker-module <built handler.mjs> --output <responses.json>");
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
const metadataOnly = (response) => JSON.parse(response.content[0].text);
const request = (part) => new Request("https://clued.pixelgrav.com/mcp", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "clued_agent_bootstrap", arguments: part === undefined ? {} : { part },
  } }),
});
// No user, Binding, service secret or database connection. These flags only select
// public metadata; any attempted outbound call fails before a side effect.
const env = { PROJECT_VIEWS_V2: "true", CLUED_WORK_CLAIMS_V1: "true", CLUED_INTEGRATION_RUNTIME_V1: "true",
  CLUED_DELEGATED_OAUTH_V12: "true", SUPABASE_URL: "https://clued-budget.invalid", SUPABASE_PUBLISHABLE_KEY: "fixture-public-key" };
globalThis.fetch = async () => { throw new Error("bootstrap budget probe attempted outbound I/O"); };
const { handleContinuityRequest } = await import(pathToFileURL(resolve(valueOf("--worker-module"))).href);
const markdown = (await readFile(new URL("../../../protocol/agent/agent-contract.md", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const version = Number(/^Contract version: (\d+)$/m.exec(markdown)?.[1]);
assert.ok(Number.isInteger(version) && version > 0);
const call = async (part) => {
  const response = await handleContinuityRequest(request(part), env);
  assert.equal(response.status, 200);
  const { result, error } = await response.json();
  assert.equal(error, undefined);
  assert.equal(result.isError, false);
  assert.ok(renderedBootstrapBytes(result) <= AGENT_BOOTSTRAP_BUDGET_BYTES);
  return result;
};
const first = await call();
const identity = first.structuredContent.agent_contract;
assert.equal(identity.version, version);
assert.equal(identity.sha256, hash(markdown));
assert.ok(Number.isInteger(identity.parts) && identity.parts >= 1);
assert.ok(identity.parts <= markdown.split(/^## /m).length);
const responses = [first];
for (let part = 2; part <= identity.parts; part++) {
  const response = await call(part);
  assert.equal(response.structuredContent.agent_contract.version, version);
  assert.equal(response.structuredContent.agent_contract.sha256, identity.sha256);
  assert.equal(response.structuredContent.agent_contract.parts, identity.parts);
  assert.equal(response.structuredContent.agent_contract.part, part);
  responses.push(response);
}
assert.equal(responses.map((response) => response.content[1].text).join(""), markdown);
const bootstrap = metadataOnly(first);
assert.deepEqual(bootstrap.agent_contract, { version, sha256: hash(markdown) });
for (const [index, response] of responses.entries()) {
  validateAgentContractResponse(response, { markdown, version, sha256: hash(markdown) }, index + 1);
  assert.equal(response.structuredContent.agent_contract.markdown_in, "content[1]");
  for (const field of ["endpoints", "authentication", "capabilities"]) assert.equal(field in response.structuredContent, false);
}
const synthetic = "# Contract\nContract version: 999\n" + Array.from({ length: 4 }, (_, i) =>
  `## Synthetic ${i}\n${'字"\\\n'.repeat(7_000)}`).join("");
const contract = { markdown: synthetic, version: 999, sha256: hash(synthetic) };
const syntheticMetadata = { ...bootstrap, agent_contract: { version: 999, sha256: contract.sha256 },
  lifecycle: { ...bootstrap.lifecycle, contract: { ...bootstrap.lifecycle.contract, version: 999 } } };
const syntheticFirst = renderAgentContractBootstrap(syntheticMetadata, contract);
const syntheticResponses = Array.from({ length: syntheticFirst.structuredContent.agent_contract.parts }, (_, index) =>
  renderAgentContractBootstrap(syntheticMetadata, contract, index + 1));
assert.ok(syntheticResponses.length > 1);
assert.equal(syntheticResponses.map((response) => response.content[1].text).join(""), synthetic);
for (const response of syntheticResponses) assert.ok(renderedBootstrapBytes(response) <= AGENT_BOOTSTRAP_BUDGET_BYTES);
await writeFile(valueOf("--output"), `${JSON.stringify([...responses, ...syntheticResponses])}\n`, { flag: "wx" });
console.log(JSON.stringify({ current_parts: responses.length, current_response_bytes: responses.map(renderedBootstrapBytes),
  synthetic_parts: syntheticResponses.length, synthetic_response_bytes: syntheticResponses.map(renderedBootstrapBytes), version, sha256: identity.sha256 }));
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) await main();
