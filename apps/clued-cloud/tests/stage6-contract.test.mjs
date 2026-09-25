import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";

const baseEnv = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const ctx = { waitUntil() {}, passThroughOnException() {} };

test("bootstrap and record config publish one M1 semantic contract", async () => {
  const worker = await loadWorker();
  const env = { ...baseEnv, PROJECT_VIEWS_V2: "true" };
  const [bootstrap, config] = await Promise.all([
    worker.fetch(new Request("https://clued.test/v1/continuity/bootstrap"), env, ctx),
    worker.fetch(new Request("https://clued.test/v1/records/config"), env, ctx),
  ]);
  const bootstrapBody = await bootstrap.json();
  const configBody = await config.json();
  assert.deepEqual(bootstrapBody.capabilities.project_views_v2.semantic_contract, configBody.semantic_contract);
  assert.equal(configBody.enabled, true);
  assert.equal(configBody.semantic_contract.double_write, false);
  assert.equal(bootstrapBody.lifecycle.during, undefined);
  assert.equal(bootstrapBody.lifecycle.durable_changes.condition, "authorized_business_change_only");
  assert.equal(bootstrapBody.lifecycle.durable_changes.records, "clued_record_mutate");
  assert.equal(bootstrapBody.lifecycle.durable_changes.duplicate_event_after_canonical_mutation, false);
  assert.equal(bootstrapBody.lifecycle.reconcile_when_required, "clued_session_reconcile");
});

test("agent contract makes stable ids and one transactional write explicit", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/clued-agent.md"), baseEnv, ctx);
  const contract = await response.text();
  assert.match(contract, /Global registry and priority first, then Project State, Task and Decision/);
  assert.match(contract, /Preserve the returned canonical `id`/);
  assert.match(contract, /Canonical entity \+ Event \+ Receipt/);
  assert.match(contract, /never dual-write Markdown/);
  assert.match(contract, /do not append a second event/);
  assert.match(contract, /missing capability or failed admission remains unavailable/);
  assert.match(contract, /Active Event truth carriers are separate current sources/);
  assert.match(contract, /never recover current actions from old Markdown/);
  assert.match(contract, /Governed external workspace mutations/);
  assert.match(contract, /NO SIBLING ISLAND/);
  assert.match(contract, /Byte equality is not deletion authority/);
  assert.match(contract, /If the Host has no usable preflight path, mutation is unavailable/);
});

test("repository Skill, project rules and root snapshot share the v1.6 authority boundary", async () => {
  const [skill, contract, agents, rootAgents, manifestText] = await Promise.all([
    readFile(new URL("../../../skills/clued/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../../skills/clued/references/agent-contract.md", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../../../memory/manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(skill, /authenticated Clued service/);
  assert.match(contract, /only online Canonical Store/);
  assert.match(contract, /never dual-write Markdown/);
  assert.match(contract, /read-only, versioned export/);
  for (const text of [skill, agents, rootAgents]) {
    assert.match(text, /agent-contract\.md/);
  }
  assert.match(rootAgents, /clued_record_mutate/);
  assert.equal(manifest.baseline_claim, "current");
  assert.equal(manifest.source_verification, "live_rechecked");
  assert.equal(manifest.views_complete, true);
  assert.equal(manifest.status, "ready");
});

test("the Worker serves the single agent contract and advertises capture", async () => {
  const worker = await loadWorker();
  const [source, response, bootstrap] = await Promise.all([
    readFile(new URL("../../../skills/clued/references/agent-contract.md", import.meta.url), "utf8"),
    worker.fetch(new Request("https://clued.test/clued-agent.md"), baseEnv, ctx),
    worker.fetch(new Request("https://clued.test/v1/continuity/bootstrap"), baseEnv, ctx),
  ]);
  const served = await response.text();
  assert.ok(served.startsWith(source), "served contract must be the source file verbatim");
  assert.match(served, /## 3\. Capture/);
  const { renderAgentContractModule } = await import("../scripts/generate-agent-contract.mjs");
  const generated = await readFile(new URL("../worker/generated/agent-contract.ts", import.meta.url), "utf8");
  assert.equal(generated, await renderAgentContractModule(), "run node scripts/generate-agent-contract.mjs");
  const lifecycle = (await bootstrap.json()).lifecycle;
  assert.equal(lifecycle.contract.version, 3);
  assert.equal(lifecycle.contract.url, "https://clued.test/clued-agent.md");
  assert.equal(lifecycle.durable_changes.capture, "material_outcomes_in_same_turn_before_reporting");
});
