import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

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
});

test("agent contract makes stable ids and one transactional write explicit", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(new Request("https://clued.test/clued-agent.md"), baseEnv, ctx);
  const contract = await response.text();
  assert.match(contract, /Global registry and priority first, then Project State, Task and Decision/);
  assert.match(contract, /Preserve the returned canonical `id`/);
  assert.match(contract, /Canonical entity \+ Event \+ Receipt/);
  assert.match(contract, /never dual-write Markdown/);
});

test("repository Skill, project rules and root snapshot share the v1.6 authority boundary", async () => {
  const [skill, agents, rootAgents, manifestText] = await Promise.all([
    readFile(new URL("../../../skills/clued-continuity/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../../../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../../../memory/manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(skill, /authenticated Clued service/);
  assert.match(skill, /Never dual-write Markdown/);
  assert.match(agents, /only online Canonical Store/);
  assert.match(agents, /Never dual-write Markdown/);
  assert.match(rootAgents, /clued_record_mutate/);
  assert.equal(manifest.baseline_claim, "current");
  assert.equal(manifest.source_verification, "live_rechecked");
  assert.equal(manifest.views_complete, true);
  assert.equal(manifest.status, "ready");
});
