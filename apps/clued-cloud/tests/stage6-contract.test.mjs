import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadContinuityWorker as loadWorker } from "./worker-continuity-loader.mjs";
import { contractVersionOf, verifyServedAgentContract } from "../scripts/verify-served-agent-contract.mjs";

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

test("the Worker passes the release's served-contract check against the repository contract", async () => {
  // The production release runs verifyServedAgentContract against the live
  // Worker after deploy; run the same check against this Worker before merge,
  // so a contract version bump cannot leave the bootstrap behind.
  const worker = await loadWorker();
  const contract = await readFile(new URL("../../../skills/clued/references/agent-contract.md", import.meta.url), "utf8");
  const [served, bootstrap] = await Promise.all([
    worker.fetch(new Request("https://clued.test/clued-agent.md"), baseEnv, ctx).then((r) => r.text()),
    worker.fetch(new Request("https://clued.test/v1/continuity/bootstrap"), baseEnv, ctx).then((r) => r.json()),
  ]);
  assert.deepEqual(verifyServedAgentContract({ contract, served, bootstrap }), []);
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
  assert.match(contract, /Host-owned trusted configuration/);
  assert.match(contract, /short-lived, single-use, unforgeable within that Host instance/);
  assert.match(contract, /not a bearer capability/);
  assert.match(contract, /shared guarded mutation wrapper/);
  assert.match(contract, /reject a missing, forged, expired, already-consumed, cross-Host or binding-mismatched admission/);
  assert.match(contract, /normal scans never call a model/);
  assert.match(contract, /side-effect function zero times/);
});

test("current-state answers are sourced from Clued on every injected surface (contract, MCP instructions, Skill)", async () => {
  // BUG-20260930-004: a Host answered "latest logo?" from its own memory without calling Clued.
  // The guard must live on Clued's own surfaces that every Host receives, not in any Host's memory.
  const worker = await loadWorker();
  const [contract, skill, init] = await Promise.all([
    worker.fetch(new Request("https://clued.test/clued-agent.md"), baseEnv, ctx).then((r) => r.text()),
    readFile(new URL("../../../skills/clued/SKILL.md", import.meta.url), "utf8"),
    worker
      .fetch(
        new Request("https://clued.test/mcp", {
          method: "POST",
          headers: { authorization: `Bearer clued_bnd_${"a".repeat(43)}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        }),
        baseEnv,
        ctx,
      )
      .then((r) => r.json()),
  ]);
  assert.match(contract, /Contract version: 11/);
  assert.match(contract, /Say what you are about to record before you write it, in one line of your reply/);
  assert.match(contract, /The line is a statement, not a question/);
  assert.match(contract, /`user_confirmed: true` records where the claim came from, not a confirmation step/);
  assert.doesNotMatch(contract, /only when the user explicitly confirmed this exact record/);
  assert.match(skill, /say in one line what you record, where and on what authority \(§3\.7\)/);
  assert.match(contract, /Write each outcome as it happens, before the next production action/);
  assert.match(contract, /Starting a deployment or release is not itself a §3 outcome/);
  assert.match(contract, /A Host may refuse a Clued call itself, before it leaves the Host/);
  assert.match(contract, /It is not a Clued error, a Binding, scope or currentness failure, or evidence that Clued is unavailable/);
  assert.match(contract, /Once the Owner allows it, make the owed writes first \(same idempotency keys\)/);
  assert.match(skill, /write each outcome as it happens and never right after you start a release/);
  assert.match(contract, /Claim work before you spend on it/);
  assert.match(contract, /On `work_claim_conflict`, stop and report the holder/);
  assert.match(contract, /Never retry under another title, another Task, a new idempotency key or another Binding/);
  assert.match(contract, /`Clued-Work-Claim: <claim_id>` in the pull request body and as a trailer of the head commit/);
  assert.match(contract, /A live claim is never preempted/);
  assert.match(contract, /resume also returns `contract_version`/);
  assert.match(skill, /claim its Task as the contract's §1\.7 says/);
  assert.match(contract, /Resume lists unabsorbed work-log events newest first \(`event_order: "newest"`, the default\)/);
  assert.match(contract, /`checkpoint_recommended` and `pending_event_count_recent` count only those of the last 24 hours/);
  assert.match(contract, /Set `coverage.binding_events: "all"` to also absorb every pending event your Binding wrote in this context/);
  assert.match(contract, /returned in `already_absorbed_event_ids` and does not fail the checkpoint/);
  assert.match(contract, /Resume returns resident constraints \(`active_constraints`, decisions the Owner marked as standing rules\) as an index/);
  assert.match(contract, /read its full text by resuming again with `constraint_ids`/);
  assert.match(contract, /do not act on a summary alone/);
  assert.match(contract, /returns `session_renewal`/);
  assert.match(contract, /Retry with the `expected_version` the error returns; your session token stays valid/);
  assert.match(contract, /with no second resume/);
  assert.match(contract, /When `foreign_event_count` is above zero, another client wrote to this context: resume/);
  assert.match(contract, /When `reconciliation_required` is true, call `clued_session_reconcile` with the renewed token/);
  assert.match(contract, /in the chain's `constraint_view`/);
  assert.match(contract, /If a ref's id and version is not one you hold \(/);
  assert.match(contract, /Current-state answers come only from Clued/);
  assert.match(contract, /Host's own memory, Host-side conversation summaries, earlier replies, cached files, repository snapshots and old checkpoints are not sources/);
  assert.match(contract, /say that the current state is unknown/);
  assert.match(skill, /Required for any question about the current or latest state/);
  assert.match(skill, /must come from Clued/);
  const instructions = init.result?.instructions ?? "";
  assert.match(instructions, /answered only from records read in this session after clued_session_resume/);
  assert.match(instructions, /host memory, chat summaries, earlier replies, cached files and old checkpoints are not sources/);
  assert.match(instructions, /say the current state is unknown/);
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
  assert.equal(lifecycle.contract.version, contractVersionOf(source));
  assert.equal(lifecycle.contract.url, "https://clued.test/clued-agent.md");
  assert.equal(lifecycle.durable_changes.capture, "material_outcomes_in_same_turn_before_reporting");
});
