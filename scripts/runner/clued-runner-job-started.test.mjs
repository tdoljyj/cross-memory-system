import assert from "node:assert/strict";
import { test } from "node:test";

import { DISPATCH_GATED_WORKFLOWS as ADMISSION_DISPATCH_GATED } from "../ci/clued-work-admission.mjs";
import { DISPATCH_GATED_WORKFLOWS, decide, main, workflowPathOf } from "./clued-runner-job-started.mjs";

const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const API = "https://api.github.com/repos/o/r";
const env = (overrides = {}) => ({
  CLUED_RUNNER_HOOK_REPOSITORY: "o/r", CLUED_RUNNER_HOOK_TOKEN_FILE: "/token", CLUED_RUNNER_HOOK_WAIT_SECONDS: "20",
  GITHUB_REPOSITORY: "o/r", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/clued-g4-database.yml@refs/pull/9/merge",
  GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/9/merge", GITHUB_SHA: SHA, GITHUB_EVENT_PATH: "/event.json",
  GITHUB_RUN_ID: "555",
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
// The job's own run: re-runs are refused, and only checks posted since it was
// created count (re-review 3).
const RUN = `${API}/actions/runs/555`;
const RUN_CREATED = "2026-10-04T05:00:00Z";
const thisRun = (overrides = {}) => ({ body: { id: 555, run_attempt: 1, created_at: RUN_CREATED, ...overrides } });
const run = async (overrides, script, event = prEvent()) => {
  const fake = fakeFetch({ [RUN]: thisRun(), ...script });
  const sleeps = [];
  const result = await decide({ env: env(overrides), fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
    readFile: (p) => (p === "/token" ? "ghp_read\n" : event) });
  return { result, calls: fake.calls, sleeps };
};
const APP = 5164952;
const check = (overrides = {}) => ({ id: 3, name: "clued-admission-verified", head_sha: HEAD, status: "completed",
  conclusion: "success", started_at: "2026-10-04T05:00:30Z", app: { id: APP, slug: "clued-admission" }, ...overrides });
const CHECKS = `${API}/commits/${HEAD}/check-runs?check_name=clued-admission-verified`;
const checks = (...list) => ({ body: { check_runs: list } });
const COMPARE = `${API}/compare/main...`;
const LIST = `${API}/contents/.github/workflows?ref=`;
const listing = (entries) => ({ body: Object.entries(entries).map(([name, sha]) => ({ path: `.github/workflows/${name}`, type: "file", sha })) });

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

test("runner hook: a pull request into main runs when it changes no workflow, else only after the admission App's check", async () => {
  let { result, calls } = await run({}, { [COMPARE]: files("apps/x.ts") });
  assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes no workflow"]);
  assert.equal(calls[0].url, RUN);
  assert.equal(calls[1].url, `${COMPARE}${HEAD}`);
  assert.equal(calls[1].auth, "Bearer ghp_read");
  // A changed workflow, even another one than the running job's (a called workflow), needs admission.
  ({ result, calls } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"), [CHECKS]: checks(check()) }));
  assert.equal(result.allow, true);
  assert.match(result.reason, /changes \.github\/workflows\/heavy\.yml; clued-admission-verified 3 succeeded/);
  assert.match(calls[2].url, /check-runs\?check_name=clued-admission-verified&filter=all/);
  // Re-review 2, N3c: no workflow run is consulted, so an admission run of a
  // pull request into another branch cannot stand in. Only the App's check
  // counts: not one posted by another App (a pull request's own workflow posts
  // as github-actions), not a failed or unfinished one, not one on another head.
  for (const list of [[check({ conclusion: "failure" })], [check({ app: { id: 15368, slug: "github-actions" } })],
    [check({ head_sha: SHA })], [check({ name: "clued-work-admission" })], [check({ status: "in_progress", conclusion: null })], []]) {
    ({ result } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"), [CHECKS]: checks(...list) }));
    assert.equal(result.allow, false, JSON.stringify(list));
  }
  // The newest check of the App decides: a later failure withdraws an earlier success.
  ({ result } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"),
    [CHECKS]: checks(check({ id: 3 }), check({ id: 4, conclusion: "failure" })) }));
  assert.equal(result.allow, false);
  ({ result } = await run({ CLUED_RUNNER_HOOK_ADMISSION_APP_ID: "77" }, { [COMPARE]: files(".github/workflows/heavy.yml"),
    [CHECKS]: checks(check({ app: { id: 77 } })) }));
  assert.equal(result.allow, true, "the App id can be configured");
  // A renamed workflow counts by its old name too; a truncated list counts as changed.
  ({ result } = await run({}, { [COMPARE]: { body: { files: [{ filename: "x.yml", previous_filename: ".github/workflows/old.yml" }] } },
    [CHECKS]: checks() }));
  assert.equal(result.allow, false);
  const many = Array.from({ length: 300 }, (_, i) => `apps/f${i}.ts`);
  ({ result } = await run({}, { [COMPARE]: files(...many), [CHECKS]: checks() }));
  assert.match(result.reason, /truncated/);
  // It waits for a check that is still running.
  let polls = 0;
  let sleeps;
  ({ result, sleeps } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml"),
    [CHECKS]: () => { polls += 1; return checks(check(polls < 3 ? { status: "in_progress", conclusion: null } : {})); } }));
  assert.deepEqual([result.allow, polls, sleeps.length], [true, 3, 2]);
});

test("runner hook: a hand dispatch off main runs only when its workflow files are exactly main's", async () => {
  const dispatch = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/x" };
  const same = { "clued-g4-database.yml": "1".repeat(40), "trivy.yml": "2".repeat(40) };
  const script = (mine) => ({ [`${LIST}${SHA}`]: listing(mine), [`${LIST}main`]: listing(same) });
  let { result, calls } = await run(dispatch, script(same));
  assert.deepEqual([result.allow, result.reason], [true, "dispatch on refs/heads/feature/x, workflows identical to main"]);
  assert.deepEqual(calls.map((c) => c.url).sort(), [RUN, `${LIST}${SHA}`, `${LIST}main`].sort());
  // Re-review 2, finding B: a branch at an old main commit (from before a
  // workflow had its gate) has older workflow files; that is a difference,
  // although a three-dot compare from the merge base shows none.
  ({ result } = await run(dispatch, script({ ...same, "clued-g4-database.yml": "9".repeat(40) })));
  assert.equal(result.allow, false);
  assert.match(result.reason, /workflows differ from main \(\.github\/workflows\/clued-g4-database\.yml\); merge main/);
  ({ result } = await run(dispatch, script({ ...same, "extra.yml": "3".repeat(40) })));
  assert.match(result.reason, /extra\.yml/, "an added workflow differs");
  ({ result } = await run(dispatch, script({ "trivy.yml": "2".repeat(40) })));
  assert.match(result.reason, /clued-g4-database\.yml/, "a removed workflow differs");
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
  const { result } = await run({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/x" }, { [LIST]: { status: 403, body: null } })
    .catch((error) => ({ result: { error: error.message } }));
  assert.match(result.error, /returned 403/);
});

test("runner hook (re-review 3, N-R3): a re-run of a pull request or branch dispatch run is refused", async () => {
  const workflowChange = { [COMPARE]: files(".github/workflows/heavy.yml"), [CHECKS]: checks(check()) };
  for (const [overrides, script] of [
    [{ GITHUB_RUN_ATTEMPT: "2" }, { [COMPARE]: files("apps/x.ts") }],
    [{}, { [RUN]: thisRun({ run_attempt: 2 }), [COMPARE]: files("apps/x.ts") }],
    [{ GITHUB_RUN_ATTEMPT: "3" }, workflowChange],
    [{ GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/x" }, {}],
  ]) {
    const { result, calls } = await run(overrides, script);
    assert.equal(result.allow, false, JSON.stringify(overrides));
    assert.match(result.reason, /run attempt [23]; re-runs are refused, push a new commit/);
    assert.deepEqual(calls.map((c) => c.url), [RUN], "nothing else is read");
  }
  // main's own runs may be re-run.
  const { result } = await run({ GITHUB_RUN_ATTEMPT: "2", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, {});
  assert.equal(result.allow, true);
  // Without a run id the check fails closed.
  await assert.rejects(run({ GITHUB_RUN_ID: "" }, { [COMPARE]: files("apps/x.ts") }), /GITHUB_RUN_ID is not a run id/);
});

test("runner hook (re-review 3, N-R1): an App check posted before this run was created does not admit it", async () => {
  const change = { [COMPARE]: files(".github/workflows/heavy.yml") };
  let { result } = await run({}, { ...change, [CHECKS]: checks(check({ started_at: "2026-10-04T04:59:59Z" })) });
  assert.equal(result.allow, false);
  assert.match(result.reason, /posted since 2026-10-04T05:00:00Z \(none\)/);
  ({ result } = await run({}, { ...change, [CHECKS]: checks(check({ id: 9, started_at: "2026-10-04T04:00:00Z" }), check({ id: 2 })) }));
  assert.equal(result.allow, true, "the newer posting decides, not the higher id");
  ({ result } = await run({}, { ...change, [CHECKS]: checks(check({ started_at: undefined })) }));
  assert.equal(result.allow, false, "no posting time, no admission");
});

test("runner hook (re-review 3, N-R2): only the dispatch-gated workflows may be dispatched off main", async () => {
  assert.deepEqual(DISPATCH_GATED_WORKFLOWS, ADMISSION_DISPATCH_GATED, "the same list as the admission script");
  for (const file of ["clued-integration-runtime-nightly.yml", "mps03-native-agent.yml", "trivy.yml"]) {
    const { result, calls } = await run({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/x",
      GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${file}@refs/heads/feature/x` }, {});
    assert.equal(result.allow, false, file);
    assert.match(result.reason, /may be dispatched on another branch; this one runs on main only/);
    assert.deepEqual(calls.map((c) => c.url), [RUN]);
    const onMain = await run({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${file}@refs/heads/main` }, {});
    assert.equal(onMain.result.allow, true, `${file} on main`);
  }
});
