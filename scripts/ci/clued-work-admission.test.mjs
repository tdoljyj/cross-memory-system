import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DISABLED_MESSAGE,
  evaluate,
  globToRegExp,
  main,
  parseClaimReference,
  parseWorkflowTriggers,
  readWorkflowTriggers,
  renderSummary,
  workflowApplies,
} from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAIM = "0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CLAIM_BASE = "c".repeat(40);

function event(overrides = {}) {
  return {
    pull_request: {
      number: 452,
      body: overrides.body ?? "## Why\n\nSome PR.",
      head: { sha: HEAD, repo: { full_name: "o/r" } },
      base: { sha: BASE, ref: "main" },
    },
  };
}

function env(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "o/r",
    GITHUB_TOKEN: "ghs_test",
    GITHUB_API_URL: "https://api.test",
    CLUED_MCP_URL: "https://clued.test/mcp",
    CLUED_CONTEXT_READ_TOKEN: "clued_bnd_test",
    ...overrides,
  };
}

// A scripted fetch: `routes` maps "METHOD url-prefix" or MCP method names to
// responders; every call is recorded for assertions.
function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url: String(url), method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    let responder;
    if (call.url.endsWith("/mcp")) {
      responder = script[`mcp:${call.body.method}`];
    } else {
      const key = Object.keys(script).find((k) => k.startsWith("GET ") && call.url.startsWith(k.slice(4)));
      responder = key ? script[key] : undefined;
    }
    if (!responder) return { ok: false, status: 599, json: async () => ({ error: `unscripted ${call.url}` }) };
    const result = typeof responder === "function" ? responder(call) : responder;
    const status = result.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => result.body };
  };
  return { fetchImpl, calls };
}

const files = { body: [{ filename: "apps/clued-cloud/package.json" }, { filename: "docs/new.md", previous_filename: "docs/old.md" }] };
const toolsEnforced = { body: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "clued_session_resume" }, { name: "clued_work_verify" }] } } };
const toolsOff = { body: { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "clued_session_resume" }] } } };
function verdict(payload, isError = false) {
  return { body: { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError } } };
}
const admittedPayload = { status: "ok", verdict: "ADMITTED", reasons: [], paths_outside_write_set: [], current_fence: 1, claim: { claim_id: CLAIM, base_commit: CLAIM_BASE, write_set: ["apps/clued-cloud/**", "docs/**"] } };

test("non-PR events are not admission subjects", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const outcome = await evaluate({ env: env(), event: null, eventName: "push", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.verdict, "NOT_APPLICABLE");
  assert.equal(calls.length, 0);
});

test("service without the tools: NOT_ENFORCED, admitted, no verify call", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET https://api.test/repos/o/r/pulls/452/files": files, "mcp:tools/list": toolsOff });
  const outcome = await evaluate({ env: env(), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.enforced, false);
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.deepEqual(outcome.changed_paths, ["apps/clued-cloud/package.json", "docs/new.md", "docs/old.md"]);
  assert.ok(!calls.some((c) => c.body && c.body.method === "tools/call"));
});

test("enforced and no trailer anywhere: REJECTED claim_trailer_missing", async () => {
  const { fetchImpl } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "GET https://api.test/repos/o/r/commits/": { body: { commit: { message: "feat: no trailer" } } },
    "mcp:tools/list": toolsEnforced,
  });
  const outcome = await evaluate({ env: env(), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.enforced, true);
  assert.deepEqual(outcome.reasons, ["claim_trailer_missing"]);
});

test("trailer in the head commit: verify is called with the PR facts and ADMITTED is admitted", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "GET https://api.test/repos/o/r/commits/": { body: { commit: { message: `feat: x\n\nClued-Work-Claim: ${CLAIM}\nClued-Work-Scope: global\n` } } },
    "GET https://api.test/repos/o/r/compare/": { body: { status: "ahead" } },
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": verdict(admittedPayload),
  });
  const outcome = await evaluate({ env: env(), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.verdict, "ADMITTED");
  assert.equal(outcome.claim_id, CLAIM);
  const call = calls.find((c) => c.body && c.body.method === "tools/call");
  assert.equal(call.headers.authorization, "Bearer clued_bnd_test");
  assert.deepEqual(call.body.params, {
    name: "clued_work_verify",
    arguments: { scope: "global", claim_id: CLAIM, changed_paths: ["apps/clued-cloud/package.json", "docs/new.md", "docs/old.md"], head_sha: HEAD, base_sha: BASE },
  });
  const compare = calls.find((c) => c.url.includes("/compare/"));
  assert.ok(compare.url.endsWith(`/compare/${CLAIM_BASE}...${BASE}`));
});

test("trailer in the PR body wins and no commit is fetched; project scope is passed through", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "GET https://api.test/repos/o/r/compare/": { body: { status: "identical" } },
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": verdict(admittedPayload),
  });
  const scope = "project:11111111-2222-4333-8444-555555555555";
  const outcome = await evaluate({
    env: env(), eventName: "pull_request", fetchImpl,
    event: event({ body: `Body\n\nClued-Work-Claim: ${CLAIM.toUpperCase()}\nClued-Work-Scope: ${scope}` }),
  });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.scope, scope);
  assert.ok(!calls.some((c) => c.url.includes("/commits/")));
});

test("REJECTED with paths outside the write set is not admitted and lists them", async () => {
  const payload = { ...admittedPayload, verdict: "REJECTED", reasons: ["paths_outside_write_set"], paths_outside_write_set: ["docs/new.md"] };
  const { fetchImpl, calls } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": verdict(payload),
  });
  const outcome = await evaluate({ env: env(), eventName: "pull_request", fetchImpl, event: event({ body: `Clued-Work-Claim: ${CLAIM}` }) });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["paths_outside_write_set"]);
  assert.deepEqual(outcome.paths_outside_write_set, ["docs/new.md"]);
  assert.ok(!calls.some((c) => c.url.includes("/compare/")), "no base comparison after a rejection");
  assert.match(renderSummary(outcome), /docs\/new\.md/);
});

test("a claim taken on a newer base than the PR targets is rejected", async () => {
  const { fetchImpl } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "GET https://api.test/repos/o/r/compare/": { body: { status: "behind" } },
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": verdict(admittedPayload),
  });
  const outcome = await evaluate({ env: env(), eventName: "pull_request", fetchImpl, event: event({ body: `Clued-Work-Claim: ${CLAIM}` }) });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["base_behind_claim:behind"]);
});

test("verify refused with the disabled message is NOT_ENFORCED", async () => {
  const { fetchImpl } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": { status: 404, body: { jsonrpc: "2.0", id: 2, error: { code: -32000, message: DISABLED_MESSAGE } } },
  });
  const outcome = await evaluate({ env: env(), eventName: "pull_request", fetchImpl, event: event({ body: `Clued-Work-Claim: ${CLAIM}` }) });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.enforced, false);
  assert.equal(outcome.verdict, "NOT_ENFORCED");
});

test("a tool error envelope is a rejection, never an admission", async () => {
  const { fetchImpl } = fakeFetch({
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": verdict({ status: "rejected", error_code: "work_claim_id_invalid" }, true),
  });
  const outcome = await evaluate({ env: env(), eventName: "pull_request", fetchImpl, event: event({ body: `Clued-Work-Claim: ${CLAIM}` }) });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["verify_error:work_claim_id_invalid"]);
});

test("fail closed: missing token, rejected token, transport failure", async () => {
  const scripts = {
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "mcp:tools/list": { status: 401, body: { error: { message: "Authorize with Clued OAuth or a Clued Binding Token." } } },
  };
  await assert.rejects(
    evaluate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "" }), eventName: "pull_request", fetchImpl: fakeFetch(scripts).fetchImpl, event: event() }),
    /CLUED_CONTEXT_READ_TOKEN is not set/,
  );
  await assert.rejects(
    evaluate({ env: env(), eventName: "pull_request", fetchImpl: fakeFetch(scripts).fetchImpl, event: event() }),
    /401/,
  );
  await assert.rejects(
    evaluate({ env: env(), eventName: "pull_request", fetchImpl: fakeFetch({ ...scripts, "mcp:tools/list": { status: 502, body: null } }).fetchImpl, event: event() }),
    /tools\/list returned 502/,
  );
});

test("workflow filters: parser reads this repository and globs follow GitHub semantics", () => {
  const triggers = readWorkflowTriggers(ROOT);
  const byFile = Object.fromEntries(triggers.map((t) => [t.file, t]));
  assert.deepEqual(workflowApplies(byFile["gitleaks.yml"].pull_request, ["x"]), { applies: true, reason: "unfiltered" });
  assert.deepEqual(workflowApplies(byFile["trivy.yml"].pull_request, ["x"]), { applies: true, reason: "unfiltered" });
  assert.equal(workflowApplies(byFile["clued-cloud-node22-install.yml"].pull_request, ["apps/clued-cloud/package.json"]).applies, true);
  assert.equal(workflowApplies(byFile["clued-cloud-node22-install.yml"].pull_request, ["apps/clued-cloud/worker/x.ts"]).applies, false);
  assert.equal(workflowApplies(byFile["information-flow-e2e.yml"].pull_request, ["apps/clued-cloud/worker/x.ts"]).applies, true);
  assert.equal(workflowApplies(byFile["clued-ci-runner-heartbeat.yml"].pull_request, ["x"]).applies, false);
  assert.equal(byFile["memory-publication-gate.yml"].pull_request.paths.length > 0, true, "pull_request_target filters are read");

  assert.ok(globToRegExp("apps/clued-cloud/**").test("apps/clued-cloud/a/b/c.ts"));
  assert.ok(!globToRegExp("*.md").test("docs/a.md"));
  assert.ok(globToRegExp("**/*.md").test("docs/a.md"));
  assert.ok(globToRegExp("**/*.md").test("a.md"));
  assert.ok(globToRegExp("docs/*").test("docs/a.md"));
  assert.ok(!globToRegExp("docs/*").test("docs/sub/a.md"));

  const parsed = parseWorkflowTriggers("name: x\non:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\n  push:\n    branches: [main]\n");
  assert.deepEqual(parsed.pull_request, { paths: [], pathsIgnore: ["docs/**"] });
  assert.equal(workflowApplies(parsed.pull_request, ["docs/a.md"]).applies, false);
  assert.equal(workflowApplies(parsed.pull_request, ["docs/a.md", "src/a.ts"]).applies, true);
  assert.deepEqual(parseWorkflowTriggers("on: [push, pull_request]\n").pull_request, { paths: [], pathsIgnore: [] });
});

test("claim trailer parsing", () => {
  assert.equal(parseClaimReference(null), null);
  assert.equal(parseClaimReference("Clued-Work-Claim: not-a-uuid"), null);
  assert.deepEqual(parseClaimReference(`x\nClued-Work-Claim: ${CLAIM}\n`), { claim_id: CLAIM, scope: "global" });
  assert.equal(parseClaimReference(`  Clued-Work-Claim: ${CLAIM}`), null, "a trailer starts at column 0");
});

test("main: required mode fails on rejection and on error, gate mode only withholds admission", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(event({ body: `Clued-Work-Claim: ${CLAIM}` })));
  const base = {
    ...env(),
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: ROOT,
  };
  const rejected = {
    "GET https://api.test/repos/o/r/pulls/452/files": files,
    "GET https://api.test/repos/o/r/actions/runs": { body: { workflow_runs: [{ path: ".github/workflows/gitleaks.yml", status: "completed", conclusion: "success" }] } },
    "mcp:tools/list": toolsEnforced,
    "mcp:tools/call": verdict({ ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] }),
  };
  const outputs = (name) => path.join(dir, name);

  let code = await main(["--mode", "required"], { ...base, GITHUB_OUTPUT: outputs("o1"), GITHUB_STEP_SUMMARY: outputs("s1") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 1);
  assert.match(fs.readFileSync(outputs("o1"), "utf8"), /^admitted=false$/m);
  const summary = fs.readFileSync(outputs("s1"), "utf8");
  assert.match(summary, /claim_not_current/);
  assert.match(summary, /\| `gitleaks\.yml` \| yes \| unfiltered \| completed \/ success \|/);
  assert.match(summary, /\| `clued-cloud-node22-install\.yml` \| yes \| matches apps\/clued-cloud\/package\.json \| none \|/);

  code = await main(["--mode", "gate"], { ...base, GITHUB_OUTPUT: outputs("o2"), GITHUB_STEP_SUMMARY: outputs("s2") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 0, "the gate job itself succeeds; heavy jobs read admitted=false");
  assert.match(fs.readFileSync(outputs("o2"), "utf8"), /^admitted=false$/m);
  assert.ok(!fs.readFileSync(outputs("s2"), "utf8").includes("| Workflow |"), "gate mode writes no workflow table");

  code = await main(["--mode", "gate"], { ...base, CLUED_CONTEXT_READ_TOKEN: "", GITHUB_OUTPUT: outputs("o3"), GITHUB_STEP_SUMMARY: outputs("s3") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 1, "a missing token is an error in every mode");
  assert.match(fs.readFileSync(outputs("o3"), "utf8"), /^admitted=false$/m);

  const admitted = { ...rejected, "mcp:tools/list": toolsOff };
  code = await main(["--mode", "required"], { ...base, GITHUB_OUTPUT: outputs("o4"), GITHUB_STEP_SUMMARY: outputs("s4") }, fakeFetch(admitted).fetchImpl);
  assert.equal(code, 0);
  assert.match(fs.readFileSync(outputs("o4"), "utf8"), /^admitted=true$/m);
  assert.match(fs.readFileSync(outputs("o4"), "utf8"), /^verdict=NOT_ENFORCED$/m);

  code = await main(["--mode", "required"], { ...base, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: outputs("o5"), GITHUB_STEP_SUMMARY: outputs("s5") }, fakeFetch({}).fetchImpl);
  assert.equal(code, 0);
  assert.match(fs.readFileSync(outputs("o5"), "utf8"), /^verdict=NOT_APPLICABLE$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
