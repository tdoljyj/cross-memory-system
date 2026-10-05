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
// The job's own run: re-runs are refused, and only the admission run of its
// own event counts (re-review 3, re-review 5).
const RUN = `${API}/actions/runs/555`;
const RUN_CREATED = "2026-10-04T05:00:00Z";
const thisRun = (overrides = {}) => ({ body: { id: 555, run_attempt: 1, created_at: RUN_CREATED, ...overrides } });
// Main's admission runs on the head (re-review 5, n1).
const ADMISSION_RUNS = `${API}/actions/workflows/clued-work-admission.yml/runs?head_sha=${HEAD}&event=pull_request_target`;
const admissionRun = (overrides = {}) => ({ id: 1, event: "pull_request_target", head_sha: HEAD, created_at: RUN_CREATED,
  status: "completed", conclusion: "success", ...overrides });
const admissionRuns = (...list) => ({ body: { workflow_runs: list } });
const run = async (overrides, script, event = prEvent()) => {
  const fake = fakeFetch({ [RUN]: thisRun(), [ADMISSION_RUNS]: admissionRuns(admissionRun()), ...script });
  const sleeps = [];
  const result = await decide({ env: env(overrides), fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
    readFile: (p) => (p === "/token" ? "ghp_read\n" : event) });
  return { result, calls: fake.calls, sleeps };
};
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

test("runner hook: a pull request into main runs when it changes no workflow, else only after its admission run succeeds", async () => {
  let { result, calls } = await run({}, { [COMPARE]: files("apps/x.ts") });
  assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes no workflow"]);
  assert.equal(calls[0].url, RUN);
  assert.equal(calls[1].url, `${COMPARE}${HEAD}`);
  assert.equal(calls[1].auth, "Bearer ghp_read");
  // A changed workflow, even another one than the running job's (a called workflow), needs admission.
  const change = { [COMPARE]: files(".github/workflows/heavy.yml") };
  ({ result, calls } = await run({}, change));
  assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes .github/workflows/heavy.yml; admission run 1 succeeded"]);
  assert.equal(calls[2].url, `${ADMISSION_RUNS}&per_page=100`);
  // Task b979d5a2: a fine-grained token cannot read the Checks API, so nothing reads it.
  assert.equal(calls.some((c) => /check-runs|check-suites/.test(c.url)), false);
  // Not a failed or cancelled run, not one on another head, not another event's.
  for (const overrides of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "action_required" },
    { head_sha: SHA }, { event: "pull_request" }, { event: "workflow_dispatch" }]) {
    ({ result } = await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun(overrides)) }));
    assert.equal(result.allow, false, JSON.stringify(overrides));
  }
  ({ result } = await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun({ conclusion: "failure" })) }));
  assert.match(result.reason, /no successful clued-work-admission\.yml run on b{40} from this event .*admission run 1: completed\/failure/);
  // A renamed workflow counts by its old name too; a truncated list counts as changed.
  ({ result, calls } = await run({}, { [COMPARE]: { body: { files: [{ filename: "x.yml", previous_filename: ".github/workflows/old.yml" }] } } }));
  assert.match(result.reason, /changes \.github\/workflows\/old\.yml; admission run 1/);
  assert.equal(calls.length, 3, "the admission run was consulted");
  const many = Array.from({ length: 300 }, (_, i) => `apps/f${i}.ts`);
  ({ result } = await run({}, { [COMPARE]: files(...many), [ADMISSION_RUNS]: admissionRuns() }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /truncated/);
  // It waits for a run that is still going.
  let polls = 0;
  let sleeps;
  ({ result, sleeps } = await run({}, { ...change,
    [ADMISSION_RUNS]: () => { polls += 1; return admissionRuns(admissionRun(polls < 3 ? { status: "in_progress", conclusion: null } : {})); } }));
  assert.deepEqual([result.allow, polls, sleeps.length], [true, 3, 2]);
  // And gives up after CLUED_RUNNER_HOOK_WAIT_SECONDS.
  ({ result, sleeps } = await run({}, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun({ status: "in_progress", conclusion: null })) }));
  assert.deepEqual([result.allow, sleeps.length], [false, 2]);
  assert.match(result.reason, /admission run 1: in_progress\/none/);
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
  const workflowChange = { [COMPARE]: files(".github/workflows/heavy.yml") };
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

test("runner hook (re-review 3 N-R1, re-review 5 n1): only the admission run of this event decides", async () => {
  const change = { [COMPARE]: files(".github/workflows/heavy.yml") };
  const earlier = admissionRun({ created_at: "2026-10-04T04:59:44Z" });
  let { result } = await run({}, { ...change, [ADMISSION_RUNS]: admissionRuns(earlier) });
  assert.equal(result.allow, false);
  assert.match(result.reason, /from this event \(created since 2026-10-04T05:00:00Z less 15s; no admission run\)/);
  ({ result } = await run({}, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun({ created_at: "2026-10-04T04:59:46Z" })) }));
  assert.equal(result.allow, true, "a few seconds before the run (same event)");
  // Closed and reopened within seconds: the newer admission run decides.
  const reopened = (overrides = {}) => admissionRun({ id: 2, created_at: "2026-10-04T05:00:01Z", ...overrides });
  ({ result } = await run({}, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun(), reopened({ conclusion: "failure" })) }));
  assert.deepEqual([result.allow, /admission run 2: completed\/failure/.test(result.reason)], [false, true]);
  ({ result } = await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, { ...change,
    [ADMISSION_RUNS]: admissionRuns(admissionRun(), reopened({ status: "queued", conclusion: null })) }));
  assert.equal(result.allow, false, "an older success does not stand in while the newer run is going");
  ({ result } = await run({}, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun({ conclusion: "failure" }), reopened()) }));
  assert.deepEqual([result.allow, result.reason.endsWith("admission run 2 succeeded")], [true, true]);
  // The same creation time: the higher run id decides.
  ({ result } = await run({}, { ...change, [ADMISSION_RUNS]: admissionRuns(admissionRun(), admissionRun({ id: 0, conclusion: "failure" })) }));
  assert.equal(result.allow, true);
  // A skipped admission run (a pull request into another branch) is passed over.
  ({ result } = await run({}, { ...change,
    [ADMISSION_RUNS]: admissionRuns(admissionRun(), admissionRun({ id: 3, created_at: "2026-10-04T05:00:02Z", conclusion: "skipped" })) }));
  assert.equal(result.allow, true);
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
