import assert from "node:assert/strict";
import { test } from "node:test";

import { decide, main, workflowPathOf } from "./clued-runner-job-started.mjs";

const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const API = "https://api.github.com/repos/o/r";
const env = (overrides = {}) => ({
  CLUED_RUNNER_HOOK_REPOSITORY: "o/r", CLUED_RUNNER_HOOK_TOKEN_FILE: "/token", CLUED_RUNNER_HOOK_WAIT_SECONDS: "20",
  GITHUB_REPOSITORY: "o/r", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/clued-g4-database.yml@refs/pull/9/merge",
  GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/9/merge", GITHUB_SHA: SHA, GITHUB_EVENT_PATH: "/event.json",
  ...overrides,
});
const prEvent = (base = "main") => JSON.stringify({ pull_request: { number: 9, base: { ref: base }, head: { sha: HEAD } } });
const files = (...names) => ({ body: { files: names.map((filename) => ({ filename })) } });

function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    const key = Object.keys(script).find((k) => String(url).startsWith(k));
    const r = key ? (typeof script[key] === "function" ? script[key]() : script[key]) : { status: 500, body: null };
    return { status: r.status ?? 200, json: async () => r.body };
  };
  return { fetchImpl, calls };
}
const run = async (overrides, script, event = prEvent()) => {
  const fake = fakeFetch(script);
  const sleeps = [];
  const result = await decide({ env: env(overrides), fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
    readFile: (p) => (p === "/token" ? "ghp_read\n" : event) });
  return { result, calls: fake.calls, sleeps };
};
const admission = (overrides = {}) => ({ id: 3, event: "pull_request_target", head_sha: HEAD, status: "completed",
  conclusion: "success", created_at: "2026-10-03T20:00:00Z", pull_requests: [{ number: 9 }], ...overrides });
const RUNS = `${API}/actions/workflows/clued-work-admission.yml/runs`;
const COMPARE = `${API}/compare/main...`;

test("runner hook: main's own runs start without any call", async () => {
  for (const event of ["push", "schedule", "workflow_run", "pull_request_target", "workflow_dispatch"]) {
    const { result, calls } = await run({ GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main" }, {});
    assert.deepEqual([result.allow, calls.length], [true, 0], event);
  }
  assert.equal(workflowPathOf(env()), ".github/workflows/clued-g4-database.yml");
});

test("runner hook: other branches, other events and other repositories are refused", async () => {
  for (const [overrides, reason] of [
    [{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/feat/clued-two-level-views-v1" }, /push on refs\/heads\/feat/],
    [{ GITHUB_EVENT_NAME: "issue_comment", GITHUB_REF: "refs/heads/x" }, /issue_comment/],
    [{ GITHUB_REPOSITORY: "someone/else" }, /not o\/r/],
  ]) {
    const { result } = await run(overrides, { [COMPARE]: files() });
    assert.equal(result.allow, false);
    assert.match(result.reason, reason);
  }
  const { result } = await run({}, { [COMPARE]: files() }, prEvent("feature"));
  assert.deepEqual([result.allow, result.reason], [false, "pull request into feature, not main"]);
});

test("runner hook: a pull request into main runs when it changes no workflow, else only after its admission", async () => {
  let { result, calls } = await run({}, { [COMPARE]: files("apps/x.ts") });
  assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes no workflow"]);
  assert.equal(calls[0].url, `${COMPARE}${HEAD}`);
  assert.equal(calls[0].auth, "Bearer ghp_read");
  // A changed workflow, even another one than the running job's (a called workflow), needs admission.
  ({ result } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"), [RUNS]: { body: { workflow_runs: [admission()] } } }));
  assert.equal(result.allow, true);
  assert.match(result.reason, /changes \.github\/workflows\/heavy\.yml; admission run 3 succeeded/);
  for (const runs of [[admission({ conclusion: "failure" })], [admission({ pull_requests: [{ number: 10 }] })],
    [admission({ head_sha: SHA })], [admission({ event: "pull_request" })], []]) {
    ({ result } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"), [RUNS]: { body: { workflow_runs: runs } } }));
    assert.equal(result.allow, false, JSON.stringify(runs));
  }
  // A renamed workflow counts by its old name too; a truncated list counts as changed.
  ({ result } = await run({}, { [COMPARE]: { body: { files: [{ filename: "x.yml", previous_filename: ".github/workflows/old.yml" }] } },
    [RUNS]: { body: { workflow_runs: [] } } }));
  assert.equal(result.allow, false);
  const many = Array.from({ length: 300 }, (_, i) => `apps/f${i}.ts`);
  ({ result } = await run({}, { [COMPARE]: files(...many), [RUNS]: { body: { workflow_runs: [] } } }));
  assert.match(result.reason, /truncated/);
  // It waits for an admission run that is still going.
  let polls = 0;
  let sleeps;
  ({ result, sleeps } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"),
    [RUNS]: () => { polls += 1; return { body: { workflow_runs: [admission(polls < 3 ? { status: "in_progress", conclusion: null } : {})] } }; } }));
  assert.deepEqual([result.allow, polls, sleeps.length], [true, 3, 2]);
});

test("runner hook: a hand dispatch off main runs only when it changes no workflow", async () => {
  const dispatch = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/x" };
  let { result, calls } = await run(dispatch, { [COMPARE]: files("apps/x.ts") });
  assert.equal(result.allow, true);
  assert.equal(calls[0].url, `${COMPARE}${SHA}`);
  ({ result } = await run(dispatch, { [COMPARE]: files(".github/workflows/clued-g4-database.yml") }));
  assert.deepEqual([result.allow, result.reason], [false, "dispatch on refs/heads/feature/x changes .github/workflows/clued-g4-database.yml"]);
});

test("runner hook: exit codes, enforcement and failures", async () => {
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    const bad = { ...env({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/x" }) };
    assert.equal(await main({ ...bad, CLUED_RUNNER_HOOK_ENFORCE: "true" }, fakeFetch({}).fetchImpl), 1);
    assert.match(lines.at(-1), /::error title=Clued runner check::clued-runner-hook: REFUSE push on refs\/heads\/x/);
    assert.equal(await main(bad, fakeFetch({}).fetchImpl), 0, "advisory until enforced");
    assert.match(lines.at(-1), /::warning .*WOULD REFUSE/);
    // A missing configuration or an API failure refuses when enforced.
    assert.equal(await main({ ...bad, CLUED_RUNNER_HOOK_REPOSITORY: "", CLUED_RUNNER_HOOK_ENFORCE: "true" }, fakeFetch({}).fetchImpl), 1);
    assert.match(lines.at(-1), /check failed: CLUED_RUNNER_HOOK_REPOSITORY is not set/);
    assert.equal(await main({ ...env({ CLUED_RUNNER_HOOK_TOKEN_FILE: "" }), CLUED_RUNNER_HOOK_ENFORCE: "true" }, fakeFetch({}).fetchImpl), 1);
    assert.match(lines.at(-1), /CLUED_RUNNER_HOOK_TOKEN_FILE is not set/);
    assert.equal(await main({ ...env({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }), CLUED_RUNNER_HOOK_ENFORCE: "true" },
      fakeFetch({}).fetchImpl), 0);
    assert.match(lines.at(-1), /ALLOW push on main/);
  } finally { console.log = log; }
  const { result } = await run({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/x" }, { [COMPARE]: { status: 403, body: null } })
    .catch((error) => ({ result: { error: error.message } }));
  assert.match(result.error, /returned 403/);
});
