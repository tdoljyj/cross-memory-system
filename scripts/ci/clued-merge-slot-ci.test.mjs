// Merge Admission v0.1 §7.3, step 3: the merge slot follows CI
// (clued-merge-slot-ci.mjs). No network: fetch is mocked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CI_REQUIRED_CHECKS,
  HOLDERS_RPC,
  REQUIRED_CHECK_WORKFLOWS,
  TOUCH_RPC,
  ciStateOf,
  ciWorkflows,
  gitBlobSha,
  main,
  renderSummary,
  reportMergeSlots,
} from "./clued-merge-slot-ci.mjs";
import { ADMISSION_APP_ID, workflowFormFindings, workflowIsGated, gateFindings } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "tdoljyj/cross-memory-system";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const CLAIM = "11111111-2222-4333-8444-555555555555";
const SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const WORKFLOWS = ciWorkflows(ROOT);
const GITLEAKS = ".github/workflows/gitleaks.yml";
const QUALITY = ".github/workflows/clued-cloud-quality-gate.yml";

const env = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", CLUED_CONTEXT_READ_TOKEN: "clued-token", ...extra });
const pull = (number, sha = HEAD, body = `Clued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}`) =>
  ({ number, body, draft: false, head: { sha }, base: { ref: "main", repo: { default_branch: "main" } } });
const check = (name, extra = {}) => ({ id: 10, name, head_sha: HEAD, status: "completed", conclusion: "success",
  app: { id: name === "clued-admission-verified" ? ADMISSION_APP_ID : 15368 }, ...extra });
const run = (pathName, status = "in_progress", extra = {}) => ({ id: 7, path: pathName, status, event: "pull_request", head_sha: HEAD, ...extra });

// Routes are matched by prefix; an RPC route answers with a function of its input.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url).replace(/^https:\/\/api\.github\.com/, "");
    const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(route);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ route: rpc ? `rpc:${rpc[1]}` : route, input: body && body.p_input });
    const key = rpc ? `rpc:${rpc[1]}` : Object.keys(routes).find((prefix) => route.startsWith(prefix));
    if (!key || !(key in routes)) return new Response("not found", { status: 404 });
    const answer = typeof routes[key] === "function" ? routes[key](body && body.p_input) : routes[key];
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

// Only the names given; a name left out answers 404 unless another route set it.
const checksRoute = (sha, byName) => Object.fromEntries(Object.entries(byName).map(([name, checks]) =>
  [`/repos/${REPO}/commits/${sha}/check-runs?check_name=${name}&`, { check_runs: checks }]));
const allGreen = (sha = HEAD) => checksRoute(sha, Object.fromEntries(CI_REQUIRED_CHECKS.map(({ name }) => [name, [check(name, { head_sha: sha })]])));
const runsRoute = (sha, runs) => ({ [`/repos/${REPO}/actions/runs?head_sha=${sha}`]: { workflow_runs: runs } });
const listing = (sha, entries) => ({ [`/repos/${REPO}/contents/.github/workflows?ref=${sha}`]: entries });
const sameAsMain = (sha = HEAD) => listing(sha, [...WORKFLOWS].map(([p, blob]) => ({ path: p, sha: blob })));

test("gitBlobSha is git's blob id", () => {
  assert.equal(gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
  const file = path.join(ROOT, GITLEAKS);
  let expected = null;
  try { expected = execFileSync("git", ["hash-object", file], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* no git */ }
  if (expected) assert.equal(gitBlobSha(fs.readFileSync(file)), expected);
});

test("the CI workflows are gitleaks, trivy and the gated workflows of this branch", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const gated = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name) && workflowIsGated(fs.readFileSync(path.join(dir, name), "utf8")));
  assert.ok(gated.length >= 10, gated.join(", "));
  assert.deepEqual([...WORKFLOWS.keys()].sort(), [...gated, ...REQUIRED_CHECK_WORKFLOWS].map((name) => `.github/workflows/${name}`).sort());
});

test("the workflow is triggered by every CI workflow's completion, runs default-branch code and is hosted", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-merge-slot-ci.yml"), "utf8");
  const listed = /workflow_run:\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(text);
  assert.ok(listed, "workflow_run.workflows is a block list");
  const names = listed[1].trim().split("\n").map((line) => line.replace(/^\s*- /, "").trim());
  const dir = path.join(ROOT, ".github", "workflows");
  const nameOf = (file) => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, file), "utf8"))[1].trim();
  const expected = [...[...WORKFLOWS.keys()].map((p) => nameOf(path.basename(p))), nameOf("clued-work-admission.yml")];
  assert.deepEqual([...names].sort(), [...new Set(expected)].sort());
  assert.match(text, /types: \[completed\]/);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}/);
  assert.match(text, /environment: clued-admission/);
  assert.match(text, /cancel-in-progress: false/);
  assert.doesNotMatch(text, /pull_request/, "no pull request trigger: a pull request never runs its own copy");
  assert.deepEqual(workflowFormFindings(text), []);
  assert.deepEqual(gateFindings(text, null), [], "hosted only: no admission gate needed");
});

test("ciStateOf: failed wins, then running (default-branch workflows only), then green", async () => {
  // A required check that finally failed.
  let fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { trivy: [check("trivy", { conclusion: "failure" })] }) });
  let state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.reason], ["failed", "trivy concluded failure"]);
  // ...re-run since: the newest run of the check is queued, so not failed; it is running.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { trivy: [check("trivy", { conclusion: "failure" }), check("trivy", { id: 11, status: "queued", conclusion: null })] }),
    ...runsRoute(HEAD, [run(".github/workflows/trivy.yml", "queued")]), ...sameAsMain() });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "running");
  // cancelled and timed_out fail too; neutral and skipped pass.
  for (const conclusion of ["cancelled", "timed_out", "action_required", "startup_failure"]) {
    fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion })] }) });
    assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "failed", conclusion);
  }
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "skipped" })], trivy: [check("trivy", { conclusion: "neutral" })] }),
    ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "green");
  // A same-named check from another app, or on another head, is not the required check.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "clued-admission-verified": [check("clued-admission-verified", { app: { id: 15368 }, conclusion: "failure", id: 99 }),
    check("clued-admission-verified", { id: 98, head_sha: OTHER, conclusion: "failure" }), check("clued-admission-verified")] }), ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "green");
  // Running needs the head's workflow file to be the default branch's: a pull request's edited copy does not count.
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(QUALITY)]),
    ...listing(HEAD, [{ path: QUALITY, sha: "f".repeat(40) }]) });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.equal(state.state, "green", "an edited workflow's run is not CI activity");
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(QUALITY)]), ...sameAsMain() });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.reason], ["running", `${QUALITY} in_progress`]);
  // A workflow the pull request adds, a push run, another head's run and a finished run are not counted.
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(".github/workflows/pr-added.yml"), run(QUALITY, "in_progress", { event: "push" }),
    run(QUALITY, "in_progress", { head_sha: OTHER }), run(QUALITY, "completed")]) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "green");
  assert.ok(!fetch.calls.some((call) => call.route.includes("/contents/")), "no listing when nothing counted runs");
  // A required check not posted yet, with nothing running: not reported.
  fetch = fakeFetch({ ...checksRoute(HEAD, { gitleaks: [check("gitleaks")], trivy: [check("trivy")], "clued-work-admission": [check("clued-work-admission")],
    "clued-admission-verified": [] }),
    ...runsRoute(HEAD, []) });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.checks.find((c) => c.name === "clued-admission-verified").status], ["idle", "missing"]);
});

function slotWorld({ holders = [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_slot_until: "2026-10-08T12:00:00Z" }], pulls = [pull(5)], extra = {},
  touch = (input) => ({ status: "ok", touched: true, claims: [CLAIM], merge_slot_until: "2026-10-08T12:45:00Z", ci_state: input.ci_state, returned: input.ci_state === "failed" }) } = {}) {
  return fakeFetch({
    [`/repos/${REPO}/pulls?state=open`]: pulls,
    [`rpc:${HOLDERS_RPC}`]: () => ({ status: "ok", repository: REPO, holders }),
    [`rpc:${TOUCH_RPC}`]: touch,
    ...extra,
  });
}
const report = (fetch, more = {}) => reportMergeSlots({ env: env(more.env), event: more.event ?? null, eventName: more.eventName ?? "schedule",
  fetchImpl: fetch.fetchImpl, workspace: ROOT });

test("reportMergeSlots: reports the holder's CI state with the policy's hard cap", async () => {
  let fetch = slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, [run(GITLEAKS)]), ...sameAsMain() } });
  let result = await report(fetch);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.reports, [{ pr: 5, head_sha: HEAD, ci_state: "running", reason: `${GITLEAKS} in_progress`, touched: true, merge_slot_until: "2026-10-08T12:45:00Z" }]);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${HOLDERS_RPC}`).input, { scope: SCOPE, repository: REPO });
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${TOUCH_RPC}`).input,
    { scope: SCOPE, pr_ref: `${REPO}#5`, head_sha: HEAD, ci_state: "running", hard_cap_minutes: 120 });
  assert.equal(result.hard_cap_minutes, 120);
  assert.match(renderSummary(result), /#5 `aaaaaaaaaaaa`: \*\*running\*\*/);
  // green
  fetch = slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.equal(fetch.calls.find((call) => call.route === `rpc:${TOUCH_RPC}`).input.ci_state, "green");
  // failed: no hard cap is sent, and the answer says whether a slot was returned.
  fetch = slotWorld({ extra: { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure" })] }) } });
  result = await report(fetch);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${TOUCH_RPC}`).input,
    { scope: SCOPE, pr_ref: `${REPO}#5`, head_sha: HEAD, ci_state: "failed" });
  assert.deepEqual([result.reports[0].ci_state, result.reports[0].returned], ["failed", true]);
  assert.match(renderSummary(result), /slot returned/);
  // idle: nothing reported.
  fetch = slotWorld({ extra: { ...checksRoute(HEAD, Object.fromEntries(CI_REQUIRED_CHECKS.map(({ name }) => [name, []]))), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.deepEqual([result.reports[0].ci_state, fetch.calls.some((call) => call.route === `rpc:${TOUCH_RPC}`)], ["idle", false]);
});

test("reportMergeSlots: nothing in the event is trusted, and nothing is asked when no slot is held", async () => {
  // No open pull request names a claim: no Clued call at all.
  let fetch = slotWorld({ pulls: [pull(5, HEAD, "no trailer")] });
  let result = await report(fetch);
  assert.deepEqual([result.holders, fetch.calls.map((call) => call.route)], [[], [`/repos/${REPO}/pulls?state=open&per_page=100&page=1`]]);
  // No holder: one GitHub call and one Clued call.
  fetch = slotWorld({ holders: [] });
  result = await report(fetch, { eventName: "workflow_run", event: { workflow_run: { head_sha: HEAD } } });
  assert.deepEqual(fetch.calls.map((call) => call.route), [`/repos/${REPO}/pulls?state=open&per_page=100&page=1`, `rpc:${HOLDERS_RPC}`]);
  // A workflow_run for another head: skipped after the slot lookup.
  fetch = slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch, { eventName: "workflow_run", event: { workflow_run: { head_sha: OTHER, conclusion: "failure", pull_requests: [{ number: 5 }] } } });
  assert.equal(result.skipped, "the event's head holds no merge slot");
  assert.equal(fetch.calls.length, 2);
  // A workflow_run for the holder's head: the state is read from the API, not the event's conclusion.
  fetch = slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch, { eventName: "workflow_run", event: { workflow_run: { head_sha: HEAD, conclusion: "failure" } } });
  assert.equal(result.reports[0].ci_state, "green");
  // A slot whose pull request is not open into the default branch is listed, not reported.
  fetch = slotWorld({ pulls: [pull(5), { ...pull(6), base: { ref: "release", repo: { default_branch: "main" } } }],
    holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#6` }, { claim_id: CLAIM, bound_pr: `${REPO}#9` }] });
  result = await report(fetch);
  assert.deepEqual([result.holders.map((holder) => holder.open), result.reports], [[false, false], []]);
  // Two claims bound to one pull request: one report.
  fetch = slotWorld({ holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#5` }, { claim_id: "22222222-2222-4333-8444-555555555555", bound_pr: `${REPO}#5` }],
    extra: { ...allGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.equal(fetch.calls.filter((call) => call.route === `rpc:${TOUCH_RPC}`).length, 1);
});

test("reportMergeSlots: Clued refusals and missing tokens are errors; main exits 1 on them", async () => {
  let fetch = slotWorld();
  let result = await report(fetch, { env: { CLUED_CONTEXT_READ_TOKEN: "" } });
  assert.match(result.errors[0], /CLUED_CONTEXT_READ_TOKEN is not set.*CLUED_ADMISSION_CLUED_TOKEN/);
  assert.equal(fetch.calls.length, 0);
  fetch = fakeFetch({ [`/repos/${REPO}/pulls?state=open`]: [pull(5)],
    [`rpc:${HOLDERS_RPC}`]: () => ({ status: "ok", holders: [], reason: "admission_binding_required" }) });
  result = await report(fetch);
  assert.match(result.errors[0], /admission_binding_required.*ci-admission role/);
  fetch = slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, []) }, touch: () => ({ status: "ok", touched: false, reason: "admission_binding_required" }) });
  result = await report(fetch);
  assert.match(result.errors[0], /^#5: .*admission_binding_required/);
  // main: the summary is written and the exit code follows the errors.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"), "merge-slot-ci-"));
  const summary = path.join(dir, "summary.md");
  const base = { ...env(), GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: summary, GITHUB_EVENT_NAME: "schedule" };
  const quiet = console.log;
  const loud = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(await main(base, slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, []) } }).fetchImpl), 0);
    assert.equal(await main(base, fetch.fetchImpl), 1);
  } finally {
    console.log = quiet;
    console.error = loud;
  }
  assert.match(fs.readFileSync(summary, "utf8"), /## clued-merge-slot-ci/);
  fs.rmSync(dir, { recursive: true, force: true });
});
