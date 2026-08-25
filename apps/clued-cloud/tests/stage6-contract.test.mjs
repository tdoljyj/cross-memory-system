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

test("route, bootstrap and record config publish one semantic contract", async () => {
  const route = JSON.parse(
    await readFile(new URL("../../../memory/contexts/routes.json", import.meta.url), "utf8"),
  );
  const worker = await loadWorker();
  const env = { ...baseEnv, PROJECT_VIEWS_V2: "true" };
  const bootstrap = await worker.fetch(
    new Request("https://clued.test/v1/continuity/bootstrap"),
    env,
    ctx,
  );
  const config = await worker.fetch(
    new Request("https://clued.test/v1/records/config"),
    env,
    ctx,
  );
  const bootstrapBody = await bootstrap.json();
  const configBody = await config.json();

  assert.deepEqual(
    bootstrapBody.capabilities.project_views_v2.semantic_contract,
    route.semantic_contract,
  );
  assert.deepEqual(configBody.semantic_contract, route.semantic_contract);
  assert.equal(configBody.enabled, true);
});

test("agent contract makes current truth, stable ids and single write explicit", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("https://clued.test/clued-agent.md"),
    baseEnv,
    ctx,
  );
  const contract = await response.text();

  assert.match(contract, /Log or Archive only when history or evidence is needed/);
  assert.match(contract, /canonical `id` across API, MCP, UI and Markdown mirrors/);
  assert.match(contract, /Canonical entity \+ Event \+ Receipt/);
  assert.match(contract, /never dual-write Markdown/);
});

test("versioned Skill and project rules fail closed without inventing projects or mirrors", async () => {
  const [skill, agents, readme, routeText] = await Promise.all([
    readFile(new URL("../../../skills/clued-continuity/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../../../memory/contexts/routes.json", import.meta.url), "utf8"),
  ]);
  const route = JSON.parse(routeText);
  const mirror = route.semantic_contract.mirror_layout;

  assert.match(skill, /memory\/contexts\/routes\.json/);
  assert.match(skill, /Never invent a project ID or auto-confirm a project/);
  assert.match(skill, /Never dual-write a Markdown business record/);
  assert.match(skill, /Global\/\{State,Task,Decision,Archive,Log\}\.md/);
  assert.match(skill, /Projects\/\{canonical-project-id\}\/\{State,Task,Decision,Archive,Log\}\.md/);
  assert.equal(skill.includes(mirror.entry_template), true);
  assert.match(agents, /skills\/clued-continuity\/SKILL\.md/);
  assert.match(agents, /canonical Record → Event \+ Receipt/);
  assert.equal(agents.includes(mirror.entry_template), true);
  assert.match(readme, /two-level-five-view-v1/);
  assert.equal(readme.includes(mirror.entry_template), true);
  assert.match(readme, /record endpoints\/tools\/panel remain unavailable/);
});
