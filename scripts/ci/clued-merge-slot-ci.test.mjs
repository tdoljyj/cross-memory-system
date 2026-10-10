// Merge Admission v0.1 §7.3, step 3: the merge slot follows CI
// (clued-merge-slot-ci.mjs). No network: fetch is mocked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CI_REQUIRED_CHECKS,
  HOLDERS_RPC,
  REQUIRED_CHECK_WORKFLOWS,
  TOUCH_RPC,
  ciStateOf as actualCiStateOf,
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

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", CLUED_CONTEXT_READ_TOKEN: "clued-token",
  CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: PEM, GITHUB_RUN_ID: "9001", ...extra });
const pull = (number, sha = HEAD, body = `Clued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}`) =>
  ({ number, state: "open", body, draft: false, head: { sha }, base: { ref: "main", repo: { default_branch: "main", full_name:REPO } } });
const fixtureQualification=async pr=>({passed:true,state:'qualified',head:pr.head.sha,pr_number:pr.number,reason:'fixture execution observed'});
const ciStateOf=(fetch,env,repo,head,workflows,since=null)=>actualCiStateOf(fetch,env,repo,head,workflows,since,
  {pr:pull(5),qualifyExecution:fixtureQualification});
const check = (name, extra = {}) => ({ id: 10, name, head_sha: HEAD, status: "completed", conclusion: "success",
  external_id: name==='clued-admission-verified'?'pr:5:run:9001':undefined,
  app: { id: name === "clued-admission-verified" ? ADMISSION_APP_ID : 15368 }, ...extra });
const run = (pathName, status = "in_progress", extra = {}) => ({ id: 7, path: pathName, status, event: "pull_request", head_sha: HEAD, ...extra });

// Routes are matched by prefix; an RPC route answers with a function of its input.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url).replace(/^https:\/\/api\.github\.com/, "");
    const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(route);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ route: rpc ? `rpc:${rpc[1]}` : route, method: init.method ?? "GET", input: body && body.p_input, body });
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
const runsRoute = (sha, runs) => ({ [`/repos/${REPO}/actions/runs?head_sha=${sha}`]: { total_count:runs.length,workflow_runs: runs } });
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
  assert.doesNotMatch(text, /schedule:/, "the hourly report is a step of the re-verification run");
  // Only pull request runs can be a holder's head; the event is used to skip, never to decide.
  assert.match(text, /github\.event\.workflow_run\.event == 'pull_request' \|\|\n\s+github\.event\.workflow_run\.event == 'pull_request_target'/);
  assert.match(text, /CLUED_ADMISSION_APP_PRIVATE_KEY: \$\{\{ secrets\.CLUED_ADMISSION_APP_KEY \}\}/);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}/);
  assert.match(text, /environment: clued-admission/);
  assert.match(text, /cancel-in-progress: false/);
  assert.doesNotMatch(text, /^ {2}pull_request(_target)?:/m, "no pull request trigger: a pull request never runs its own copy");
  // The hourly report runs inside clued-work-admission-reverify, after the re-verification.
  const reverify = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission-reverify.yml"), "utf8");
  assert.match(reverify, /- name: Report the CI state of the pull requests holding a merge slot\n {8}if: \$\{\{ !cancelled\(\) \}\}\n[\s\S]*?run: node scripts\/ci\/clued-merge-slot-ci\.mjs\n/);
  assert.match(reverify, /group: \$\{\{ github\.workflow \}\}-\$\{\{ inputs\.reason == 'state_change' && 'state_change' \|\| 'scheduled' \}\}/);
  assert.deepEqual(workflowFormFindings(text), []);
  assert.deepEqual(gateFindings(text, null), [], "hosted only: no admission gate needed");
});

test("both pending entry points report CI before the executor last in the same trusted job", () => {
  for (const file of ["clued-merge-executor.yml", "clued-merge-slot-ci.yml"]) {
    const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8");
    assert.match(text, /runs-on: ubuntu-slim\n    timeout-minutes: 10\n    environment: clued-admission\n/);
    assert.match(text, /run: node --test scripts\/ci\/clued-merge-slot-ci\.test\.mjs scripts\/ci\/clued-merge-executor\.test\.mjs/);
    assert.match(text, /permissions:\n(?:  #[^\n]*\n)?  actions: write\n  checks: read\n  contents: read\n  pull-requests: read/);
    const report = /- name: Report the CI state of the pull requests holding a merge slot\n {8}env:\n((?: {10}[^\n]+\n)+) {8}run: node scripts\/ci\/clued-merge-slot-ci\.mjs\n/.exec(text);
    const execute = /- name: Bring the default branch into the queue head, turn on auto-merge or merge it\n {8}timeout-minutes: 5\n {8}env:\n((?: {10}[^\n]+\n)+) {8}run: node scripts\/ci\/clued-merge-executor\.mjs\n?$/.exec(text);
    assert.ok(report && execute, "both steps use the same job; executor is last with default success condition");
    assert.ok(report.index < execute.index, "the slot state is reported before acting on the queue");
    assert.equal(execute[1], report[1], "same main-only App/token/state trust envelope");
    assert.equal((text.match(/run: node scripts\/ci\/clued-merge-executor\.mjs/g) ?? []).length, 1);
    assert.doesNotMatch(text, /continue-on-error:|if:.*always\(\)/, "failed or cancelled reporting must not authorize execution");
  }
});

test("both executor entry points share one repository-wide job lock without cancelling running work", () => {
  for (const file of ["clued-merge-executor.yml", "clued-merge-slot-ci.yml"]) {
    const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8");
    assert.doesNotMatch(text, /^concurrency:/m, "no nested workflow lock");
    assert.match(text, /    concurrency:\n      group: clued-merge-executor\n      cancel-in-progress: false\n/);
    assert.equal((text.match(/group:/g) ?? []).length, 1, "one shared job lock, no separate queue mutation group");
  }
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
  // timed_out and the like fail too; neutral and skipped pass.
  for (const conclusion of ["timed_out", "action_required", "startup_failure"]) {
    fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion })] }) });
    assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "failed", conclusion);
  }
  // cancelled is not final: an edit cancels the admission run on the same head before the next one posts (review NIT).
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "clued-work-admission": [check("clued-work-admission", { conclusion: "cancelled" })] }),
    ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "skipped" })], trivy: [check("trivy", { conclusion: "neutral" })] }),
    ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
  // A same-named check from another app, or on another head, is not the required check.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "clued-admission-verified": [check("clued-admission-verified", { app: { id: 15368 }, conclusion: "failure", id: 99 }),
    check("clued-admission-verified", { id: 98, head_sha: OTHER, conclusion: "failure" }), check("clued-admission-verified")] }), ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "green");
  // Running needs the head's workflow file to be the default branch's: a pull request's edited copy does not count.
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(QUALITY)]),
    ...listing(HEAD, [{ path: QUALITY, sha: "f".repeat(40) }]) });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  // ...nor green while it still runs (confirmation review MINOR-C): not reported.
  assert.deepEqual([state.state, state.reason], ["idle", `only runs that are not counted are active: ${QUALITY} in_progress`]);
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(QUALITY)]), ...sameAsMain() });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.reason], ["running", `${QUALITY} in_progress`]);
  // A workflow the pull request adds keeps nothing alive and holds green back.
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(".github/workflows/pr-added.yml")]) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
  assert.ok(!fetch.calls.some((call) => call.route.includes("/contents/")), "no listing when nothing counted runs");
  // A filtered native PR listing with wrong event/head is inconsistent, not green.
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, [run(QUALITY, "in_progress", { event: "push" }),
    run(QUALITY, "in_progress", { head_sha: OTHER }), run(QUALITY, "completed")]) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
  // A required check not posted yet, with nothing running: not reported.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks")], trivy: [check("trivy")], "clued-work-admission": [check("clued-work-admission")],
    "clued-admission-verified": [] }),
    ...runsRoute(HEAD, []) });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.checks.find((c) => c.name === "clued-admission-verified").status], ["idle", "missing"]);
});

test("contract-placement is an always-run hosted required check, and failures return the merge slot", async () => {
  assert.ok(CI_REQUIRED_CHECKS.some(({ name, app_id }) => name === "contract-placement" && app_id === 15368));
  const text = fs.readFileSync(path.join(ROOT, ".github/workflows/contract-placement.yml"), "utf8");
  assert.match(text, /^ {4}name: contract-placement$/m);
  assert.match(text, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(text, /^\s*(?:if|needs|paths|paths-ignore):/m);
  assert.deepEqual(workflowFormFindings(text), []);
  assert.deepEqual(gateFindings(text, null), []);
  const fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, {
    "contract-placement": [check("contract-placement", { conclusion: "failure" })],
  }) });
  const state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.reason], ["failed", "contract-placement concluded failure"]);
  const missing = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "contract-placement": [] }), ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(missing.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
});

test("ciStateOf: a failure from before the slot was taken is not reported and holds green back (step 4)", async () => {
  const SINCE = Date.parse("2026-10-09T05:00:00Z");
  const old = check("clued-admission-verified", { conclusion: "failure", completed_at: "2026-10-09T04:59:00Z" });
  let fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "clued-admission-verified": [old] }), ...runsRoute(HEAD, []) });
  let state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE);
  assert.deepEqual([state.state, state.reason], ["idle", "clued-admission-verified concluded failure before the slot was taken"]);
  // Without the time the slot was taken, or a failure after it, it is failed as before.
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "failed");
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "clued-admission-verified": [{ ...old, completed_at: "2026-10-09T05:01:00Z" }] }) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE)).state, "failed");
  // Only the admission checks: a gitleaks failure from before the slot is the head's own.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure", completed_at: "2026-10-09T04:59:00Z" })] }) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE)).state, "failed");
  // A counted run still reports running, so the holder keeps the slot while CI runs on its new head.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "clued-admission-verified": [old] }),
    ...runsRoute(HEAD, [run(GITLEAKS)]), ...sameAsMain() });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE)).state, "running");
  // reportMergeSlots passes the slot's taken_at from Clued.
  fetch = slotWorld({ holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_slot_until: "2026-10-09T05:45:00Z",
    merge_slot_ci: { taken_at: "2026-10-09T05:00:00Z" } }],
  extra: { ...allGreen(), ...checksRoute(HEAD, { "clued-admission-verified": [old] }), ...runsRoute(HEAD, []) } });
  const result = await report(fetch);
  assert.deepEqual([result.errors, result.reports[0].ci_state, fetch.calls.some((call) => call.route === `rpc:${TOUCH_RPC}`)],
    [[], "idle", false]);
});

function slotWorld({ holders = [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_slot_until: "2026-10-08T12:00:00Z" }], pulls = [pull(5)], extra = {},
  touch = (input) => ({ status: "ok", touched: true, claims: [CLAIM], merge_slot_until: "2026-10-08T12:45:00Z", ci_state: input.ci_state, returned: input.ci_state === "failed" }) } = {}) {
  return fakeFetch({
    [`/repos/${REPO}/pulls?state=open`]: pulls,
    ...Object.fromEntries(pulls.map(pr=>[`/repos/${REPO}/pulls/${pr.number}`,pr])),
    [`rpc:${HOLDERS_RPC}`]: () => ({ status: "ok", repository: REPO, holders }),
    [`rpc:${TOUCH_RPC}`]: touch,
    [`/repos/${REPO}/installation`]: { id: 99 },
    "/app/installations/99/access_tokens": { token: "ghs_app" },
    [`/repos/${REPO}/check-runs`]: { id: 5005 },
    ...extra,
  });
}
const report = (fetch, more = {}) => reportMergeSlots({ env: env(more.env), event: more.event ?? null, eventName: more.eventName ?? "schedule",
  fetchImpl: fetch.fetchImpl, workspace: ROOT, qualifyExecution:more.qualifyExecution??fixtureQualification });

test('required green cannot extend a slot with gate-only, unknown, wrong-identity or skipped execution',async()=>{
  const props=[{passed:false,state:'unknown',reason:'gate only',rerun:{id:7,run_attempt:1}},
    {passed:false,state:'unknown',reason:'unregistered source'},
    {passed:true,state:'qualified',head:OTHER,pr_number:5,reason:'other head'},
    {passed:true,state:'qualified',head:HEAD,pr_number:6,reason:'other PR'}];
  for(const proof of props) {
    const fetch=slotWorld({extra:{...allGreen(),...runsRoute(HEAD,[])}});
    const result=await report(fetch,{qualifyExecution:async()=>({head:HEAD,pr_number:5,...proof})});
    assert.equal(result.reports[0].ci_state,'idle');
    assert.equal(fetch.calls.some(call=>call.route===`rpc:${TOUCH_RPC}`),false);
  }
  const wrong=slotWorld({extra:{...allGreen(),...checksRoute(HEAD,{'clued-admission-verified':[check('clued-admission-verified',{external_id:'pr:6:run:9'})]}),...runsRoute(HEAD,[])}});
  assert.equal((await report(wrong)).reports[0].ci_state,'idle');
  const moved=slotWorld({extra:{...allGreen(),...runsRoute(HEAD,[]),[`/repos/${REPO}/pulls/5`]:{...pull(5),head:{sha:OTHER}}}});
  assert.equal((await report(moved)).reports[0].ci_state,'idle');
  assert.equal(moved.calls.some(call=>call.route===`rpc:${TOUCH_RPC}`),false);
  const failed=slotWorld({extra:{...allGreen(),...runsRoute(HEAD,[])}});
  const outcome=await report(failed,{qualifyExecution:async()=>({head:HEAD,pr_number:5,passed:false,state:'failed',reason:'actual primary failed'})});
  assert.equal(outcome.reports[0].ci_state,'failed');assert.equal(outcome.reports[0].returned,true);
});

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
  // failed: no hard cap is sent; a returned slot fails the head's clued-merge-slot check (review MAJOR-2).
  fetch = slotWorld({ extra: { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure" })] }) } });
  result = await report(fetch);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${TOUCH_RPC}`).input,
    { scope: SCOPE, pr_ref: `${REPO}#5`, head_sha: HEAD, ci_state: "failed", reason: 'gitleaks concluded failure' });
  assert.deepEqual([result.reports[0].ci_state, result.reports[0].returned, result.reports[0].merge_slot_check_run_id], ["failed", true, 5005]);
  const posted = fetch.calls.find((call) => call.method === "POST" && call.route === `/repos/${REPO}/check-runs`).body;
  assert.deepEqual([posted.name, posted.head_sha, posted.conclusion, posted.external_id, posted.output.title],
    ["clued-merge-slot", HEAD, "failure", "pr:5:run:9001", "Merge slot returned: CI failed"]);
  assert.match(posted.output.summary, /^gitleaks concluded failure on this head.*Turn auto-merge off/);
  assert.match(renderSummary(result), /slot returned/);
  assert.match(renderSummary(result), /notified 0 claim\(s\)/);
  const notified = slotWorld({ extra: { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check('gitleaks', { conclusion: 'failure' })] }) },
    touch: () => ({ status: 'ok', returned: true, notified: [CLAIM] }) });
  const noticeResult = await report(notified);
  assert.deepEqual(noticeResult.reports[0].notified, [CLAIM]);
  assert.match(renderSummary(noticeResult), /notified 1 claim\(s\)/);
  // Nothing returned (already given back) and the newest slot check already failed: no check is posted.
  const slotCheck = (conclusion) => ({ id: 30, name: "clued-merge-slot", head_sha: HEAD, status: "completed", conclusion, app: { id: ADMISSION_APP_ID } });
  const failedCi = { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure" })] }) };
  const notReturned = () => ({ status: "ok", returned: false, merge_slot_returned: [] });
  fetch = slotWorld({ extra: { ...failedCi, ...checksRoute(HEAD, { "clued-merge-slot": [slotCheck("failure")] }) }, touch: notReturned });
  result = await report(fetch);
  assert.deepEqual([result.errors, fetch.calls.some((call) => call.method === "POST" && call.route.endsWith("/check-runs"))], [[], false]);
  // ...but a green one left by a run that could not post is failed now (confirmation review NIT-2).
  fetch = slotWorld({ extra: { ...failedCi, ...checksRoute(HEAD, { "clued-merge-slot": [slotCheck("success")] }) }, touch: notReturned });
  result = await report(fetch);
  assert.deepEqual([result.errors, result.reports[0].merge_slot_check_run_id], [[], 5005]);
  // Where the policy does not require the slot (efficiency), the check is not failed (confirmation review MINOR-B).
  fetch = slotWorld({ extra: failedCi });
  result = await report(fetch, { env: { CLUED_MERGE_ADMISSION_STATE: "efficiency" } });
  assert.deepEqual([result.reports[0].returned, fetch.calls.some((call) => call.method === "POST" && call.route.endsWith("/check-runs"))],
    [true, false]);
  // Frozen requires it; since step 6 the retired switch changes nothing either way.
  for (const extraEnv of [{ CLUED_MERGE_ADMISSION_STATE: "frozen" }, { CLUED_WORK_ADMISSION_ENFORCE: "" }, { CLUED_WORK_ADMISSION_ENFORCE: "false" }]) {
    fetch = slotWorld({ extra: failedCi });
    result = await report(fetch, { env: extraEnv });
    assert.equal(result.reports[0].merge_slot_check_run_id, 5005, JSON.stringify(extraEnv));
  }
  // Without the App key a returned slot is an error: its green check would outlive it.
  fetch = slotWorld({ extra: { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure" })] }) } });
  result = await report(fetch, { env: { CLUED_ADMISSION_APP_ID: "", CLUED_ADMISSION_APP_PRIVATE_KEY: "" } });
  assert.match(result.errors[0], /^#5: the slot was returned but no failing clued-merge-slot check could be posted/);
  // idle: nothing reported.
  fetch = slotWorld({ extra: { ...checksRoute(HEAD, Object.fromEntries(CI_REQUIRED_CHECKS.map(({ name }) => [name, []]))), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.deepEqual([result.reports[0].ci_state, fetch.calls.some((call) => call.route === `rpc:${TOUCH_RPC}`)], ["idle", false]);
});

test("reportMergeSlots: nothing in the event is trusted, and nothing is asked when no slot is held", async () => {
  // No open pull request names a claim, in its body or head commit: no Clued call at all.
  let fetch = slotWorld({ pulls: [pull(5, HEAD, "no trailer")], extra: { [`/repos/${REPO}/commits/${HEAD}`]: { commit: { message: "no trailer" } } } });
  let result = await report(fetch);
  assert.deepEqual([result.holders, fetch.calls.map((call) => call.route)],
    [[], [`/repos/${REPO}/pulls?state=open&per_page=100&page=1`, `/repos/${REPO}/commits/${HEAD}`]]);
  // An unreadable commit is an error for that pull request; the others are still reported.
  fetch = slotWorld({ pulls: [pull(4, OTHER, "no trailer"), pull(5)], extra: { ...allGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.deepEqual([result.errors.length, result.reports.map((r) => [r.pr, r.ci_state])], [1, [[5, "green"]]]);
  assert.match(result.errors[0], /^#4: GitHub API .*returned 404/);
  // No holder: one GitHub call and one Clued call.
  fetch = slotWorld({ holders: [] });
  result = await report(fetch, { eventName: "workflow_run", event: { workflow_run: { head_sha: HEAD } } });
  assert.deepEqual(fetch.calls.map((call) => call.route), [`/repos/${REPO}/pulls?state=open&per_page=100&page=1`, `rpc:${HOLDERS_RPC}`]);
  // A workflow_run for another head still reports every slot: concurrency may have dropped the holder's own run (confirmation review MINOR-A).
  fetch = slotWorld({ extra: { ...allGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch, { eventName: "workflow_run", event: { workflow_run: { head_sha: OTHER, conclusion: "failure", pull_requests: [{ number: 5 }] } } });
  assert.deepEqual([result.skipped, result.reports.map((r) => [r.pr, r.ci_state])], [null, [[5, "green"]]]);
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

test("reportMergeSlots: a claim named only in the head commit counts; a service without the RPC is a notice", async () => {
  let fetch = slotWorld({ pulls: [pull(5, HEAD, "no trailer in the body")], extra: { ...allGreen(), ...runsRoute(HEAD, []),
    [`/repos/${REPO}/commits/${HEAD}`]: { sha: HEAD, commit: { message: `step\n\nClued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}` } } } });
  let result = await report(fetch);
  assert.deepEqual([result.errors, result.reports.map((r) => r.ci_state)], [[], ["green"]]);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${HOLDERS_RPC}`).input, { scope: SCOPE, repository: REPO });
  // Merged before the migration is applied (review MINOR-6): PostgREST answers 404 PGRST202.
  fetch = fakeFetch({ [`/repos/${REPO}/pulls?state=open`]: [pull(5)] });
  const missing = async (url, init) => (String(url).includes(`/rpc/${HOLDERS_RPC}`)
    ? new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 })
    : fetch.fetchImpl(url, init));
  result = await reportMergeSlots({ env: env(), event: null, eventName: "schedule", fetchImpl: missing, workspace: ROOT });
  assert.deepEqual([result.errors, result.notices], [[], [`${HOLDERS_RPC} is not deployed yet (migration 20261009010000); nothing reported`]]);
  assert.match(renderSummary(result), /- notice: clued_work_merge_slot_holders_v1 is not deployed yet/);
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
    assert.equal(await main(base, fetch.fetchImpl), 0, 'no touch until real default-branch qualification is available');
    const refused=fakeFetch({[`/repos/${REPO}/pulls?state=open`]:[pull(5)],
      [`rpc:${HOLDERS_RPC}`]:()=>({status:'ok',reason:'admission_binding_required',holders:[]})});
    assert.equal(await main(base, refused.fetchImpl), 1);
  } finally {
    console.log = quiet;
    console.error = loud;
  }
  assert.match(fs.readFileSync(summary, "utf8"), /## clued-merge-slot-ci/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("qualification cannot retain old required success or miss a newly queued uncounted workflow",async()=>{
  for(const change of ["required","queued"]){
    let changed=false;
    const fetch=slotWorld({extra:{...allGreen(),
      [`/repos/${REPO}/commits/${HEAD}/check-runs?check_name=clued-admission-verified&`]:()=>({check_runs:[check("clued-admission-verified",{conclusion:changed&&change==="required"?"failure":"success"})]}),
      [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:()=>({total_count:changed&&change==="queued"?1:0,
        workflow_runs:changed&&change==="queued"?[run(".github/workflows/other.yml","queued")]:[]})}});
    const result=await report(fetch,{qualifyExecution:async pr=>{changed=true;return fixtureQualification(pr)}});
    assert.equal(result.reports[0].ci_state,"idle");
    assert.equal(fetch.calls.some(c=>c.route===`rpc:${TOUCH_RPC}`),false);
  }
});
