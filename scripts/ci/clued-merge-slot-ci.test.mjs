import {registeredPublisherSource} from './clued-production-publisher-source.mjs';
import {registeredPublisherPrQualificationSource} from './clued-publisher-qualification-source.mjs';
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
  LEGACY_CI_REQUIRED_CHECKS as CI_REQUIRED_CHECKS,
  INDEPENDENT_CI_APP_ID,
  ciRequiredChecks,
  independentCheckBindsPullRequest,
  requiredChecksOf,
  HOLDERS_RPC,
  REQUIRED_CHECK_WORKFLOWS,
  TOUCH_RPC,
  ciStateOf as actualCiStateOf,
  ciWorkflows,
  gitBlobSha,
  main,
  renderSummary,
  reportMergeSlots,
  requiredBarrier,
} from "./clued-merge-slot-ci.mjs";
import { ADMISSION_APP_ID, workflowFormFindings, workflowIsGated, gateFindings } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "tdoljyj/cross-memory-system";
const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const CLAIM = "11111111-2222-4333-8444-555555555555";
const SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const WORKFLOWS = ciWorkflows(ROOT);
const QUALIFICATION_CATALOGUE = JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/ci/clued-publisher-qualification-sources.json'),'utf8'));
const QUALIFICATION_NAMES = Object.entries(QUALIFICATION_CATALOGUE.workflows).flatMap(([file,entry])=>entry.sources.map(source=>{
  const registered=registeredPublisherPrQualificationSource(QUALIFICATION_CATALOGUE,file,source.source_yaml);
  assert.equal(registered.passed,true,'watcher names come only from exact registered qualification Source/Role bytes');
  return registered.profile.workflow_definition.name;
}));
test('default CI enumeration excludes only exact registered dispatch publisher bytes',()=>{
  const registry=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/ci/clued-production-publisher-sources.json'),'utf8'));
  const file='.github/workflows/clued-cloud-production-release.yml';
  const source=registry.workflows[file].sources.find(s=>s.gated).source_yaml;
  const readFile=p=>Buffer.from(p.endsWith('clued-production-publisher-sources.json')?JSON.stringify(registry):source);
  assert.equal(ciWorkflows(ROOT,()=>['clued-cloud-production-release.yml'],readFile).size,0);
  assert.throws(()=>ciWorkflows(ROOT,()=>['clued-cloud-production-release.yml'],p=>p.endsWith('clued-production-publisher-sources.json')?readFile(p):Buffer.from(source+'\n')),
    /unregistered default publisher/);
  assert.equal(ciWorkflows(ROOT,()=>['unregistered-dispatch.yml'],readFile).size,1,
    'an arbitrary gated dispatch is never a basename exclusion');
});
test('qualification Sources are outside application requiredSuccess only after exact registration',()=>{
  const file='.github/workflows/clued-production-publisher-host-qualification.yml';
  const source=QUALIFICATION_CATALOGUE.workflows[file].sources[0].source_yaml;
  const readFile=p=>Buffer.from(p.endsWith('clued-publisher-qualification-sources.json')?JSON.stringify(QUALIFICATION_CATALOGUE):source);
  assert.equal(ciWorkflows(ROOT,()=>[path.basename(file)],readFile).size,0);
  assert.throws(()=>ciWorkflows(ROOT,()=>[path.basename(file)],p=>p.endsWith('clued-publisher-qualification-sources.json')?readFile(p):Buffer.from(source+'\n')),
    /unregistered default PR qualification Source/);
});
const GITLEAKS = ".github/workflows/gitleaks.yml";
const QUALITY = ".github/workflows/clued-cloud-quality-gate.yml";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", CLUED_CONTEXT_READ_TOKEN: "clued-token",
  CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: PEM, GITHUB_RUN_ID: "9001", ...extra });
const pull = (number, sha = HEAD, body = `Clued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}`) =>
  ({ number, node_id:`PR_${number}`, state: "open", body, draft: false, head: { sha }, base: { ref: "main", repo: { default_branch: "main", full_name:REPO } } });
const fixtureQualification=async pr=>({passed:true,state:'qualified',head:pr.head.sha,pr_number:pr.number,reason:'fixture execution observed',native_runs:[]});
// Design A2: the branch rules decide what counts. The earlier fixtures keep the
// pre-2026-10-20 mapping; the A2 tests below use the live one (App 5368905)
// and the Owner's disaster-recovery mapping with the hosted executor names.
const LEGACY_RULES = Object.freeze([...CI_REQUIRED_CHECKS, Object.freeze({ name: "kooyumi-merge-slot", app_id: ADMISSION_APP_ID })]);
const REQUIRED_NAMES = ["gitleaks", "trivy", "kooyumi-work-admission", "kooyumi-admission-verified", "kooyumi-merge-slot", "contract-placement"];
const INDEPENDENT_RULES = Object.freeze(REQUIRED_NAMES.map((name) => Object.freeze({ name, app_id: 5368905 })));
const DR_RULES = Object.freeze([["gitleaks-hosted-executor", 15368], ["trivy-hosted-executor", 15368], ["contract-placement-hosted-executor", 15368],
  ["kooyumi-work-admission", 15368], ["kooyumi-admission-verified", ADMISSION_APP_ID], ["kooyumi-merge-slot", ADMISSION_APP_ID]]
  .map(([name, app_id]) => Object.freeze({ name, app_id })));
const branchRules = (list) => [{ type: "pull_request", parameters: {} }, { type: "required_status_checks", ruleset_id: 24182890,
  parameters: { strict_required_status_checks_policy: true, required_status_checks: list.map(({ name, app_id }) => ({ context: name, integration_id: app_id })) } }];
const rulesRoute = (list) => ({ [`/repos/${REPO}/rules/branches/main`]: branchRules(list) });
const ciStateOf=(fetch,env,repo,head,workflows,since=null)=>actualCiStateOf(fetch,env,repo,head,workflows,since,
  {pr:pull(5),qualifyExecution:fixtureQualification,required:LEGACY_RULES});
const check = (name, extra = {}) => ({ id: CI_REQUIRED_CHECKS.findIndex(row=>row.name===name)+1, name, head_sha: HEAD, status: "completed", conclusion: "success",
  external_id: name==='kooyumi-admission-verified'?'pr:5:run:9001':undefined,
  app: { id: name === "kooyumi-admission-verified" ? ADMISSION_APP_ID : 15368 }, ...extra });
const run = (pathName, status = "in_progress", extra = {}) => ({ id: 7, path: pathName, status, event: "pull_request", head_sha: HEAD, ...extra });

// Routes are matched by prefix; an RPC route answers with a function of its input.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url).replace(/^https:\/\/api\.github\.com/, "");
    const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(route);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ route: rpc ? `rpc:${rpc[1]}` : route, method: init.method ?? "GET", input: body && body.p_input, body });
    // Branch rules not given by a test are the legacy mapping (design A2).
    if (route.startsWith(`/repos/${REPO}/rules/branches/`) && !Object.keys(routes).some((key) => route.startsWith(key)))
      return new Response(JSON.stringify(branchRules(LEGACY_RULES)), { status: 200, headers: { "content-type": "application/json" } });
    // Existing per-name fixtures also serve the new complete, unfiltered API.
    // Keep individual routes for admissionOf, which is outside this change.
    const snapshot = /^(.*\/check-runs)\?filter=all&/.exec(route);
    if (snapshot && !Object.keys(routes).some(key=>key.startsWith(`${snapshot[1]}?filter=all`) && route.startsWith(key))) {
      const chunks = Object.entries(routes).filter(([key])=>key.startsWith(`${snapshot[1]}?check_name=`))
        .map(([,value])=>typeof value==='function'?value(null):value);
      const checks = chunks.flatMap(chunk=>chunk.check_runs);
      const page = Number(new URL(`https://api.github.com${route}`).searchParams.get('page'));
      return new Response(JSON.stringify({total_count:checks.length,check_runs:checks.slice((page-1)*100,page*100)}));
    }
    const key = rpc ? `rpc:${rpc[1]}` : Object.keys(routes).find((prefix) => route.startsWith(prefix));
    if (!key || !(key in routes)) return new Response("not found", { status: 404 });
    const answer = typeof routes[key] === "function" ? routes[key](body && body.p_input) : routes[key];
    return new Response(JSON.stringify(answer?.__status?answer.body:answer), { status: answer?.__status??200, headers: { "content-type": "application/json" } });
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
  const publisherCatalogue=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/ci/clued-production-publisher-sources.json'),'utf8'));
  const prGated=gated.filter(name=>{
    const file='.github/workflows/'+name;
    if(Object.hasOwn(QUALIFICATION_CATALOGUE.workflows,file)){
      assert.equal(registeredPublisherPrQualificationSource(QUALIFICATION_CATALOGUE,file,fs.readFileSync(path.join(dir,name),'utf8')).passed,true);
      return false;
    }
    if(!Object.hasOwn(publisherCatalogue.workflows,file))return true;
    const text=fs.readFileSync(path.join(dir,name),'utf8');
    assert.equal(registeredPublisherSource(publisherCatalogue,file,text).passed,true,'an exact registered dispatch Source is required');
    return false;
  });
  // The three required-check workflows are gated too; each is counted once.
  assert.deepEqual([...WORKFLOWS.keys()].sort(), [...new Set([...prGated, ...REQUIRED_CHECK_WORKFLOWS])].map((name) => `.github/workflows/${name}`).sort());
});

test("the workflow is triggered by every CI workflow's completion, runs default-branch code and is hosted", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-merge-slot-ci.yml"), "utf8");
  const listed = /workflow_run:\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(text);
  assert.ok(listed, "workflow_run.workflows is a block list");
  const names = listed[1].trim().split("\n").map((line) => line.replace(/^\s*- /, "").trim());
  const dir = path.join(ROOT, ".github", "workflows");
  const nameOf = (file) => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, file), "utf8"))[1].trim();
  const expected = [...[...WORKFLOWS.keys()].map((p) => nameOf(path.basename(p))), nameOf("clued-work-admission.yml"), ...QUALIFICATION_NAMES];
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

test("both pending entry points report CI before the last executor action; sealed observations cannot authorize execution", () => {
  for (const file of ["clued-merge-executor.yml", "clued-merge-slot-ci.yml"]) {
    const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8");
    assert.match(text, /runs-on: ubuntu-slim\n    timeout-minutes: 10\n    environment: clued-admission\n/);
    assert.match(text, /run: node --test scripts\/ci\/clued-merge-slot-ci\.test\.mjs scripts\/ci\/clued-merge-executor\.test\.mjs/);
    assert.match(text, /permissions:\n(?:  #[^\n]*\n)?  actions: write\n  checks: read\n  contents: read\n  pull-requests: read/);
    const observerAt = text.indexOf("      - name: Export the closed local natural R9 packet\n");
    assert.ok(observerAt > 0, "only the explicit local export/artifact tail may follow the executor");
    const actions = text.slice(0, observerAt), observations = text.slice(observerAt);
    const report = /- name: Report the CI state of the pull requests holding a merge slot\n(?: {8}if: \$\{\{ !inputs\.measurement_opt_in \}\}\n)? {8}env:\n((?: {10}[^\n]+\n)+) {8}run: node scripts\/ci\/clued-merge-slot-ci\.mjs\n/.exec(actions);
    const execute = /- name: Bring the default branch into the queue head, turn on auto-merge or merge it\n {8}timeout-minutes: 5\n {8}env:\n((?: {10}[^\n]+\n)+) {8}run: node scripts\/ci\/clued-merge-executor\.mjs\n?$/.exec(actions);
    assert.ok(report && execute, "both steps use the same job; executor is last with default success condition");
    assert.ok(report.index < execute.index, "the slot state is reported before acting on the queue");
    assert.equal(execute[1], report[1], "same main-only App/token/state trust envelope");
    assert.equal((text.match(/run: node scripts\/ci\/clued-merge-executor\.mjs/g) ?? []).length, 1);
    assert.doesNotMatch(actions, /continue-on-error:|if:.*always\(\)/, "failed or cancelled reporting must not authorize execution");
    assert.equal((observations.match(/if: \$\{\{ always\(\) \}\}/g) ?? []).length, 2);
    assert.match(observations, new RegExp('run: node scripts/ci/merge-admission-source-producer\\.mjs --export '+(file==='clued-merge-executor.yml'?'executor':'slot')));
    assert.doesNotMatch(observations, /clued-merge-executor\.mjs|CLUED_CONTEXT_READ_TOKEN|CLUED_ADMISSION_APP/, "observers have no merge command or Clued/App credential");
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
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "kooyumi-work-admission": [check("kooyumi-work-admission", { conclusion: "cancelled" })] }),
    ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "skipped" })], trivy: [check("trivy", { conclusion: "neutral" })] }),
    ...runsRoute(HEAD, []) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "idle");
  // A same-named check from another app is not the required check.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "kooyumi-admission-verified": [check("kooyumi-admission-verified", { app: { id: 15368 }, conclusion: "failure", id: 99 }),
    check("kooyumi-admission-verified")] }), ...runsRoute(HEAD, []) });
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
  await assert.rejects(()=>ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS), /invalid workflow_runs snapshot row/);
  // A required check not posted yet, with nothing running: not reported.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks")], trivy: [check("trivy")], "kooyumi-work-admission": [check("kooyumi-work-admission")],
    "kooyumi-admission-verified": [] }),
    ...runsRoute(HEAD, []) });
  state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS);
  assert.deepEqual([state.state, state.checks.find((c) => c.name === "kooyumi-admission-verified").status], ["idle", "missing"]);
});

test("contract-placement is an always-run hosted required check, and failures return the merge slot", async () => {
  assert.ok(CI_REQUIRED_CHECKS.some(({ name, app_id }) => name === "contract-placement" && app_id === 15368));
  const text = fs.readFileSync(path.join(ROOT, ".github/workflows/contract-placement.yml"), "utf8");
  // Owner Decision bc6fdad1: the hosted executor never carries the required check's name.
  assert.match(text, /^ {4}name: contract-placement-hosted-executor$/m);
  assert.doesNotMatch(text, /^ {4}name: contract-placement$/m);
  // Owner Decision 325717a6: the gate and the executor run on a hosted runner, on every pull request.
  assert.equal(text.match(/^ {4}runs-on: /gm).length, 2);
  assert.equal(text.match(/^ {4}runs-on: ubuntu-latest$/gm).length, 2);
  assert.doesNotMatch(text, /^\s*(?:paths|paths-ignore):/m);
  assert.match(text, /^ {4}needs: admission-gate$/m);
  assert.deepEqual(workflowFormFindings(text), []);
  assert.deepEqual(gateFindings(text, text), []);
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
  const old = check("kooyumi-admission-verified", { conclusion: "failure", completed_at: "2026-10-09T04:59:00Z" });
  let fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "kooyumi-admission-verified": [old] }), ...runsRoute(HEAD, []) });
  let state = await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE);
  assert.deepEqual([state.state, state.reason], ["idle", "kooyumi-admission-verified concluded failure before the slot was taken"]);
  // Without the time the slot was taken, or a failure after it, it is failed as before.
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS)).state, "failed");
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "kooyumi-admission-verified": [{ ...old, completed_at: "2026-10-09T05:01:00Z" }] }) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE)).state, "failed");
  // Only the admission checks: a gitleaks failure from before the slot is the head's own.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure", completed_at: "2026-10-09T04:59:00Z" })] }) });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE)).state, "failed");
  // A counted run still reports running, so the holder keeps the slot while CI runs on its new head.
  fetch = fakeFetch({ ...allGreen(), ...checksRoute(HEAD, { "kooyumi-admission-verified": [old] }),
    ...runsRoute(HEAD, [run(GITLEAKS)]), ...sameAsMain() });
  assert.equal((await ciStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, SINCE)).state, "running");
  // reportMergeSlots passes the slot's taken_at from Clued.
  fetch = slotWorld({ holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_slot_until: "2026-10-09T05:45:00Z",
    merge_slot_ci: { taken_at: "2026-10-09T05:00:00Z" } }],
  extra: { ...allGreen(), ...checksRoute(HEAD, { "kooyumi-admission-verified": [old] }), ...runsRoute(HEAD, []) } });
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
  const wrong=slotWorld({extra:{...allGreen(),...checksRoute(HEAD,{'kooyumi-admission-verified':[check('kooyumi-admission-verified',{external_id:'pr:6:run:9'})]}),...runsRoute(HEAD,[])}});
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
  // failed: no hard cap is sent; a returned slot fails the head's kooyumi-merge-slot check (review MAJOR-2).
  fetch = slotWorld({ extra: { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure" })] }) } });
  result = await report(fetch);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${TOUCH_RPC}`).input,
    { scope: SCOPE, pr_ref: `${REPO}#5`, head_sha: HEAD, ci_state: "failed", reason: 'gitleaks concluded failure' });
  assert.deepEqual([result.reports[0].ci_state, result.reports[0].returned, result.reports[0].merge_slot_check_run_id], ["failed", true, 5005]);
  const posted = fetch.calls.find((call) => call.method === "POST" && call.route === `/repos/${REPO}/check-runs`).body;
  assert.deepEqual([posted.name, posted.head_sha, posted.conclusion, posted.external_id, posted.output.title],
    ["kooyumi-merge-slot", HEAD, "failure", "pr:5:run:9001", "Merge slot returned: CI failed"]);
  assert.match(posted.output.summary, /^gitleaks concluded failure on this head.*Turn auto-merge off/);
  assert.match(renderSummary(result), /slot returned/);
  assert.match(renderSummary(result), /notified 0 claim\(s\)/);
  const notified = slotWorld({ extra: { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check('gitleaks', { conclusion: 'failure' })] }) },
    touch: () => ({ status: 'ok', returned: true, notified: [CLAIM] }) });
  const noticeResult = await report(notified);
  assert.deepEqual(noticeResult.reports[0].notified, [CLAIM]);
  assert.match(renderSummary(noticeResult), /notified 1 claim\(s\)/);
  // Nothing returned (already given back) and the newest slot check already failed: no check is posted.
  const slotCheck = (conclusion) => ({ id: 30, name: "kooyumi-merge-slot", head_sha: HEAD, status: "completed", conclusion, app: { id: ADMISSION_APP_ID } });
  const failedCi = { ...allGreen(), ...checksRoute(HEAD, { gitleaks: [check("gitleaks", { conclusion: "failure" })] }) };
  const notReturned = () => ({ status: "ok", returned: false, merge_slot_returned: [] });
  fetch = slotWorld({ extra: { ...failedCi, ...checksRoute(HEAD, { "kooyumi-merge-slot": [slotCheck("failure")] }) }, touch: notReturned });
  result = await report(fetch);
  assert.deepEqual([result.errors, fetch.calls.some((call) => call.method === "POST" && call.route.endsWith("/check-runs"))], [[], false]);
  // ...but a green one left by a run that could not post is failed now (confirmation review NIT-2).
  fetch = slotWorld({ extra: { ...failedCi, ...checksRoute(HEAD, { "kooyumi-merge-slot": [slotCheck("success")] }) }, touch: notReturned });
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
  assert.match(result.errors[0], /^#5: the slot was returned but no failing kooyumi-merge-slot check could be posted/);
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
  assert.equal(fetch.calls.length, 1, "cleanup checks open PRs before returning for a missing Clued token");
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
      [`/repos/${REPO}/commits/${HEAD}/check-runs?check_name=kooyumi-admission-verified&`]:()=>({check_runs:[check("kooyumi-admission-verified",{conclusion:changed&&change==="required"?"failure":"success"})]}),
      [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:()=>({total_count:changed&&change==="queued"?1:0,
        workflow_runs:changed&&change==="queued"?[run(".github/workflows/other.yml","queued")]:[]})}});
    const result=await report(fetch,{qualifyExecution:async pr=>{changed=true;return fixtureQualification(pr)}});
    assert.equal(result.reports[0].ci_state,"idle");
    assert.equal(fetch.calls.some(c=>c.route===`rpc:${TOUCH_RPC}`),false);
  }
});

test("report cleans a managed waiting request before source observation, Clued or slow proof",async()=>{
  const pr={...pull(5),auto_merge:{enabled_by:{login:"clued-admission[bot]"}}};
  const fetch=slotWorld({pulls:[pr],extra:{[`/repos/${REPO}/pulls/5`]:pr,
    "/graphql":{data:{disablePullRequestAutoMerge:{pullRequest:{number:5}}}},
    "/app/installations/99/access_tokens":{__status:201,body:{token:"ghs_app"}}}});
  let proofCalls=0;const result=await report(fetch,{env:{CLUED_CONTEXT_READ_TOKEN:""},qualifyExecution:async()=>{proofCalls++;throw Error("must not run")}});
  assert.equal(proofCalls,0);assert.equal(result.managed_cleanup[0].action,"disable_auto_merge");
  assert.equal(result.managed_cleanup[0].error,undefined);
  assert.equal(fetch.calls.some(c=>c.route.startsWith("rpc:")),false);
  assert.equal(fetch.calls.some(c=>c.route.includes("/actions/runs")),false);
});

const snapshotRoute = () => `/repos/${REPO}/commits/${HEAD}/check-runs?filter=all&`;
const snapshotRows = () => CI_REQUIRED_CHECKS.map(({name})=>check(name));
test('one fresh complete check snapshot per observation preserves newest name/App/head and PR identity',async()=>{
  const rows=[...snapshotRows(),check('trivy',{id:40,conclusion:'failure'}),
    check('trivy',{id:41,app:{id:999},conclusion:'success'})];
  const fetch=fakeFetch({[snapshotRoute()]:{total_count:rows.length,check_runs:rows}});
  const seen=await ciStateOf(fetch.fetchImpl,env(),REPO,HEAD,WORKFLOWS);
  assert.equal(seen.state,'failed');assert.match(seen.reason,/trivy/);
  assert.equal(fetch.calls.filter(c=>c.route.includes('/check-runs?')).length,1);
  const wrong=fakeFetch({[snapshotRoute()]:{total_count:5,check_runs:snapshotRows().map(row=>
    row.name==='kooyumi-admission-verified'?{...row,external_id:'pr:6:run:1'}:row)}});
  assert.equal((await ciStateOf(wrong.fetchImpl,env(),REPO,HEAD,WORKFLOWS)).state,'idle');
});
test('complete pagination includes a required failure and an uncounted active run after page one',async()=>{
  const filler=Array.from({length:100},(_,i)=>check('auxiliary',{id:1000+i}));
  const rows=[...filler,...snapshotRows().map(row=>row.name==='trivy'?{...row,conclusion:'failure'}:row)];
  const fetchImpl=async url=>{
    const page=Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({total_count:105,check_runs:rows.slice((page-1)*100,page*100)}));
  };
  assert.equal((await ciStateOf(fetchImpl,env(),REPO,HEAD,WORKFLOWS)).state,'failed');
  const completeRuns=Array.from({length:100},(_,i)=>run(`.github/workflows/aux-${i}.yml`,'completed',{id:1000+i}));
  completeRuns.push(run('.github/workflows/late-aux.yml','queued',{id:2000}));
  const reads=[];
  const runFetch=async url=>{
    reads.push(String(url)); const page=Number(new URL(url).searchParams.get('page'));
    if(String(url).includes('/check-runs?'))return new Response(JSON.stringify({total_count:5,check_runs:snapshotRows()}));
    return new Response(JSON.stringify({total_count:101,workflow_runs:completeRuns.slice((page-1)*100,page*100)}));
  };
  const seen=await ciStateOf(runFetch,env(),REPO,HEAD,WORKFLOWS);
  assert.equal(seen.state,'idle');assert.equal(seen.active_runs[0].id,2000);
  assert.equal(reads.filter(url=>url.includes('/actions/runs?')).length,2);
});
test('partial, conflicting or malformed snapshots cannot classify or pass a final barrier',async()=>{
  const good=snapshotRows();
  const invalid=[
    {check_runs:good},
    {total_count:6,check_runs:good},
    {total_count:5,check_runs:[...good.slice(0,4),good[0]]},
    {total_count:5,check_runs:good.map((row,i)=>i?row:{...row,head_sha:OTHER})},
    {total_count:5,check_runs:good.map((row,i)=>i?row:{...row,app:{id:'15368'}})},
    {total_count:5,check_runs:good.map((row,i)=>i?row:{...row,id:0})},
    {total_count:5,check_runs:good.map((row,i)=>i?row:{...row,status:'mystery'})},
    {total_count:2001,check_runs:good},
  ];
  for(const body of invalid){
    const fetch=fakeFetch({[snapshotRoute()]:body});
    await assert.rejects(()=>ciStateOf(fetch.fetchImpl,env(),REPO,HEAD,WORKFLOWS),/snapshot/);
    assert.equal(await requiredBarrier(fetch.fetchImpl,env(),REPO,HEAD,5,{native_runs:[],default_branch:"main"}),false);
  }
  const full=Array.from({length:100},(_,i)=>check('auxiliary',{id:1000+i}));
  const changing=async url=>new Response(JSON.stringify(Number(new URL(url).searchParams.get('page'))===1?
    {total_count:101,check_runs:full}:{total_count:102,check_runs:[check('trivy')]}));
  await assert.rejects(()=>ciStateOf(changing,env(),REPO,HEAD,WORKFLOWS),/snapshot/);
  // A partial run list cannot manufacture absence of an active run.
  const partial=fakeFetch({...allGreen(),[`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:{total_count:1,workflow_runs:[]}});
  await assert.rejects(()=>ciStateOf(partial.fetchImpl,env(),REPO,HEAD,WORKFLOWS),/snapshot/);
});
test('qualification and final barriers never reuse the initial green check snapshot',async()=>{
  let observations=0,proofs=0;
  const fetch=fakeFetch({[snapshotRoute()]:()=>{
    observations++;
    return {total_count:5,check_runs:snapshotRows().map(row=>
      observations>1 && row.name==='trivy'?{...row,conclusion:'failure'}:row)};
  },...runsRoute(HEAD,[])});
  const seen=await actualCiStateOf(fetch.fetchImpl,env(),REPO,HEAD,WORKFLOWS,null,{pr:pull(5),
    qualifyExecution:async pr=>{proofs++;return fixtureQualification(pr);}});
  assert.equal(proofs,1);assert.equal(seen.state,'idle');
  assert.equal(fetch.calls.filter(c=>c.route.includes('/check-runs?')).length,2);
  const fresh=fakeFetch({...allGreen(),...runsRoute(HEAD,[])});
  assert.equal(await requiredBarrier(fresh.fetchImpl,env(),REPO,HEAD,5,{native_runs:[],default_branch:"main"}),true);
  assert.equal(await requiredBarrier(fresh.fetchImpl,env(),REPO,HEAD,5,{native_runs:[],default_branch:"main"}),true);
  assert.equal(fresh.calls.filter(c=>c.route.includes('/check-runs?')).length,2);
});

test('IDs repeated across pages and malformed PR run metadata stay unknown',async()=>{
  const checkPage=Array.from({length:100},(_,i)=>check('auxiliary',{id:1000+i}));
  const duplicate=async url=>new Response(JSON.stringify({total_count:101,check_runs:
    Number(new URL(url).searchParams.get('page'))===1?checkPage:[checkPage[0]]}));
  await assert.rejects(()=>ciStateOf(duplicate,env(),REPO,HEAD,WORKFLOWS),/invalid check_runs snapshot row/);
  const runPage=Array.from({length:100},(_,i)=>run('.github/workflows/aux.yml','completed',{id:1000+i}));
  const duplicateRun=async url=>new Response(JSON.stringify(String(url).includes('/check-runs?')?
    {total_count:5,check_runs:snapshotRows()}:{total_count:101,workflow_runs:
      Number(new URL(url).searchParams.get('page'))===1?runPage:[runPage[0]]}));
  await assert.rejects(()=>ciStateOf(duplicateRun,env(),REPO,HEAD,WORKFLOWS),/invalid workflow_runs snapshot row/);
  for(const row of [run(QUALITY,'mystery'),run(QUALITY,'queued',{head_sha:OTHER}),run(QUALITY,'queued',{event:'push'}),run('', 'queued')]) {
    const fetch=fakeFetch({...allGreen(),...runsRoute(HEAD,[row])});
    await assert.rejects(()=>ciStateOf(fetch.fetchImpl,env(),REPO,HEAD,WORKFLOWS),/invalid workflow_runs snapshot row/);
  }
});

// --- Design A2: the merge slot counts the ruleset's actual sources.

const JOB64 = (digit) => digit.repeat(64);
const INDEPENDENT_IDS = {
  "kooyumi-work-admission": `independent-ci:native-work-admission:${JOB64("3")}:f9:e1:a1`,
  "kooyumi-admission-verified": `independent-ci:control:control-admission:${JOB64("1")}:f9:e1:a1`,
  "kooyumi-merge-slot": `independent-ci:control:control-merge-slot:${JOB64("2")}:f9:e1:a1`,
};
const independent = (name, extra = {}) => ({ id: 500 + REQUIRED_NAMES.indexOf(name), name, head_sha: HEAD, status: "completed", conclusion: "success",
  external_id: INDEPENDENT_IDS[name] ?? `independent-ci:staged:${JOB64("4")}:f9:e1:a1`, app: { id: 5368905 },
  output: { title: "Independent check", summary: name === "kooyumi-admission-verified"
    ? `Independent Native control check for ${REPO}#5; observation sha256 ${JOB64("5")}.` : `Independent CI job ${JOB64("4")}.` }, ...extra });
const independentGreen = () => checksRoute(HEAD, Object.fromEntries(REQUIRED_NAMES.filter((name) => name !== "kooyumi-merge-slot")
  .map((name) => [name, [independent(name)]])));
const hosted = (name, extra = {}) => ({ id: 800 + name.length, name, head_sha: HEAD, status: "completed", conclusion: "success", app: { id: 15368 }, ...extra });
const independentState = (fetch, { qualifyExecution = fixtureQualification, since = null } = {}) =>
  actualCiStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, since, { pr: pull(5), qualifyExecution, required: INDEPENDENT_RULES });

test("A2: required checks come from every required_status_checks rule of the branch, by context and integration, and fail closed", async () => {
  assert.equal(INDEPENDENT_CI_APP_ID, 5368905);
  let fetch = fakeFetch(rulesRoute(INDEPENDENT_RULES));
  const live = await requiredChecksOf(fetch.fetchImpl, env(), REPO, "main");
  assert.deepEqual(live, INDEPENDENT_RULES);
  assert.deepEqual(ciRequiredChecks(live).map((row) => row.name), REQUIRED_NAMES.filter((name) => name !== "kooyumi-merge-slot"));
  assert.ok(fetch.calls.some((call) => call.route.startsWith(`/repos/${REPO}/rules/branches/main?per_page=100&page=1`)));
  // The disaster-recovery mapping is read as it is, with the hosted executor names.
  fetch = fakeFetch(rulesRoute(DR_RULES));
  assert.deepEqual(await requiredChecksOf(fetch.fetchImpl, env(), REPO, "main"), DR_RULES);
  // A second ruleset adds to the first (GitHub requires both); duplicates count once; no integration is any App.
  fetch = fakeFetch({ [`/repos/${REPO}/rules/branches/main`]: [...branchRules(INDEPENDENT_RULES),
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "gitleaks", integration_id: 5368905 }, { context: "extra" }] } }] });
  assert.deepEqual((await requiredChecksOf(fetch.fetchImpl, env(), REPO, "main")).slice(-1), [{ name: "extra", app_id: null }]);
  for (const answer of [[{ type: "pull_request", parameters: {} }], [{ type: "required_status_checks", parameters: {} }],
    branchRules([{ name: "", app_id: 5368905 }]), [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "gitleaks", integration_id: "5368905" }] } }],
    { __status: 404, body: { message: "Not Found" } }]) {
    fetch = fakeFetch({ [`/repos/${REPO}/rules/branches/main`]: answer });
    await assert.rejects(() => requiredChecksOf(fetch.fetchImpl, env(), REPO, "main"), String(JSON.stringify(answer)).slice(0, 80));
  }
  await assert.rejects(() => requiredChecksOf(fakeFetch({}).fetchImpl, env(), REPO, undefined), /default branch is unknown/);
});

test("A2: independent CI checks bind to the pull request by head and the independent CI external_id formats", () => {
  const ok = { headSha: HEAD, prNumber: 5, repository: REPO };
  for (const name of REQUIRED_NAMES) assert.equal(independentCheckBindsPullRequest(independent(name), ok), true, name);
  assert.equal(independentCheckBindsPullRequest(independent("gitleaks", { external_id: "independent-ci:relay:gitleaks:aaaaaaaaaaaa:run123:a1" }), ok), true);
  for (const [label, check] of [
    ["another head", independent("gitleaks", { head_sha: OTHER })],
    ["another App", independent("gitleaks", { app: { id: 15368 } })],
    ["no external id", independent("gitleaks", { external_id: undefined })],
    ["an admission-run id", independent("kooyumi-admission-verified", { external_id: "pr:5:run:9001" })],
    ["a truncated job id", independent("trivy", { external_id: `independent-ci:staged:${JOB64("4").slice(1)}:f9:e1:a1` })],
    ["no fence", independent("trivy", { external_id: `independent-ci:staged:${JOB64("4")}:f0:e1:a1` })],
    ["a control id on a scanner", independent("gitleaks", { external_id: INDEPENDENT_IDS["kooyumi-admission-verified"] })],
    ["a staged id on the admission check", independent("kooyumi-admission-verified", { external_id: `independent-ci:staged:${JOB64("4")}:f9:e1:a1` })],
    ["the merge-slot role on the admission check", independent("kooyumi-admission-verified", { external_id: INDEPENDENT_IDS["kooyumi-merge-slot"] })],
    ["a summary naming another pull request", independent("kooyumi-admission-verified", { output: { summary: `Independent Native control check for ${REPO}#6; x` } })],
  ]) assert.equal(independentCheckBindsPullRequest(check, ok), false, label);
});

test("A2: with the rules on App 5368905, hosted executor results never return the slot; a 5368905 final failure does", async () => {
  // Hosted executors (App 15368) failed, also under a required check's old name: not counted.
  const hostedFailures = checksRoute(HEAD, { "gitleaks-hosted-executor": [hosted("gitleaks-hosted-executor", { conclusion: "failure" })],
    "trivy-hosted-executor": [hosted("trivy-hosted-executor", { conclusion: "failure" })] });
  let fetch = fakeFetch({ ...independentGreen(), ...hostedFailures, ...checksRoute(HEAD, { gitleaks: [independent("gitleaks"), hosted("gitleaks", { id: 999, conclusion: "failure" })] }),
    ...runsRoute(HEAD, []) });
  let state = await independentState(fetch);
  assert.deepEqual([state.state, state.checks.map((check) => [check.name, check.app_id, check.conclusion])],
    ["green", REQUIRED_NAMES.filter((name) => name !== "kooyumi-merge-slot").map((name) => [name, 5368905, "success"])]);
  // The execution proof fails on a hosted executor workflow (billing refusal): idle, not failed.
  for (const file of REQUIRED_CHECK_WORKFLOWS) {
    state = await independentState(fakeFetch({ ...independentGreen(), ...runsRoute(HEAD, []) }),
      { qualifyExecution: async (pr) => ({ passed: false, state: "failed", head: pr.head.sha, pr_number: pr.number, reason: `.github/workflows/${file}: qualified workflow failed` }) });
    assert.equal(state.state, "idle", file);
    assert.match(state.reason, /hosted executor is not a required check of these rules, so the slot is not returned/);
  }
  // ...but another gated workflow's failure, or the same under rules that count Actions checks, still fails as before.
  const failedProof = (file) => async (pr) => ({ passed: false, state: "failed", head: pr.head.sha, pr_number: pr.number, reason: `.github/workflows/${file}: CI job failed` });
  state = await independentState(fakeFetch({ ...independentGreen(), ...runsRoute(HEAD, []) }), { qualifyExecution: failedProof("clued-cloud-quality-gate.yml") });
  assert.equal(state.state, "failed");
  state = await actualCiStateOf(fakeFetch({ ...allGreen(), ...runsRoute(HEAD, []) }).fetchImpl, env(), REPO, HEAD, WORKFLOWS, null,
    { pr: pull(5), qualifyExecution: failedProof("gitleaks.yml"), required: LEGACY_RULES });
  assert.equal(state.state, "failed");
  // A 5368905 final failure is the head's own.
  fetch = fakeFetch({ ...independentGreen(), ...checksRoute(HEAD, { trivy: [independent("trivy", { conclusion: "failure" })] }) });
  assert.deepEqual([(await independentState(fetch)).state, (await independentState(fetch)).reason], ["failed", "trivy concluded failure"]);
  // A hosted executor still running keeps the slot running.
  fetch = fakeFetch({ ...independentGreen(), ...runsRoute(HEAD, [run(GITLEAKS)]), ...sameAsMain() });
  assert.equal((await independentState(fetch)).state, "running");
  // A missing or unbound 5368905 check is never green.
  fetch = fakeFetch({ ...independentGreen(), ...checksRoute(HEAD, { "contract-placement": [] }), ...runsRoute(HEAD, []) });
  assert.equal((await independentState(fetch)).state, "idle");
  fetch = fakeFetch({ ...independentGreen(), ...checksRoute(HEAD, { "kooyumi-admission-verified": [independent("kooyumi-admission-verified", { external_id: "pr:5:run:9001" })] }),
    ...runsRoute(HEAD, []) });
  assert.deepEqual([(await independentState(fetch)).state, (await independentState(fetch)).reason], ["idle", "the newest admission check does not bind this pull request"]);
  // The legacy sources do not stand in for the ruleset's.
  fetch = fakeFetch({ ...allGreen(), ...runsRoute(HEAD, []) });
  assert.equal((await independentState(fetch)).state, "idle");
  // The final barrier reads the rules and binds every 5368905 check.
  fetch = fakeFetch({ ...independentGreen(), ...rulesRoute(INDEPENDENT_RULES), ...runsRoute(HEAD, []) });
  assert.equal(await requiredBarrier(fetch.fetchImpl, env(), REPO, HEAD, 5, { native_runs: [], default_branch: "main" }), true);
  fetch = fakeFetch({ ...independentGreen(), ...rulesRoute(INDEPENDENT_RULES), ...runsRoute(HEAD, []),
    ...checksRoute(HEAD, { gitleaks: [independent("gitleaks", { external_id: INDEPENDENT_IDS["kooyumi-merge-slot"] })] }) });
  assert.equal(await requiredBarrier(fetch.fetchImpl, env(), REPO, HEAD, 5, { native_runs: [], default_branch: "main" }), false);
  fetch = fakeFetch({ ...independentGreen(), ...runsRoute(HEAD, []) });
  assert.equal(await requiredBarrier(fetch.fetchImpl, env(), REPO, HEAD, 5, { native_runs: [], default_branch: "main" }), false, "legacy rules need legacy checks");
});

test("A2: reportMergeSlots follows the live rules: no slot return for hosted executors, App 5368905 owns the slot check", async () => {
  const touches = (fetch) => fetch.calls.filter((call) => call.route === `rpc:${TOUCH_RPC}`).map((call) => call.input.ci_state);
  const posts = (fetch) => fetch.calls.filter((call) => call.method === "POST" && call.route === `/repos/${REPO}/check-runs`);
  // Hosted executors failed (billing refusal): no failed report, nothing posted.
  let fetch = slotWorld({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...independentGreen(), ...runsRoute(HEAD, []),
    ...checksRoute(HEAD, { "gitleaks-hosted-executor": [hosted("gitleaks-hosted-executor", { conclusion: "failure" })] }) } });
  let result = await report(fetch, { qualifyExecution: async (pr) => ({ passed: false, state: "failed", head: pr.head.sha, pr_number: pr.number,
    reason: ".github/workflows/gitleaks.yml: qualified workflow failed" }) });
  assert.deepEqual([result.errors, result.reports[0].ci_state, touches(fetch), posts(fetch).length], [[], "idle", [], 0]);
  // All six from 5368905 green: green.
  fetch = slotWorld({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...independentGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.deepEqual([result.errors, result.reports[0].ci_state, touches(fetch)], [[], "green", ["green"]]);
  // A 5368905 final failure returns the slot; the clued-admission App posts no foreign kooyumi-merge-slot check.
  fetch = slotWorld({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...independentGreen(), ...runsRoute(HEAD, []),
    ...checksRoute(HEAD, { gitleaks: [independent("gitleaks", { conclusion: "failure" })] }) } });
  result = await report(fetch);
  assert.deepEqual([result.errors, result.reports[0].ci_state, result.reports[0].returned, touches(fetch), posts(fetch).length],
    [[], "failed", true, ["failed"], 0]);
  // Unreadable rules: nothing reported, an error.
  fetch = slotWorld({ extra: { [`/repos/${REPO}/rules/branches/main`]: { __status: 403, body: { message: "Forbidden" } }, ...independentGreen(), ...runsRoute(HEAD, []) } });
  result = await report(fetch);
  assert.deepEqual([result.reports, touches(fetch)], [[], []]);
  assert.match(result.errors[0], /^#5: GitHub API .*rules\/branches\/main.* returned 403/);
});

test("A2: the Owner's disaster-recovery mapping counts the hosted executor names from App 15368", async () => {
  const drGreen = checksRoute(HEAD, Object.fromEntries(DR_RULES.filter((row) => row.name !== "kooyumi-merge-slot").map(({ name, app_id }) =>
    [name, [{ ...hosted(name), app: { id: app_id }, ...(name === "kooyumi-admission-verified" ? { external_id: "pr:5:run:9001" } : {}) }]])));
  const drState = (fetch, qualifyExecution = fixtureQualification) =>
    actualCiStateOf(fetch.fetchImpl, env(), REPO, HEAD, WORKFLOWS, null, { pr: pull(5), qualifyExecution, required: DR_RULES });
  assert.equal((await drState(fakeFetch({ ...drGreen, ...runsRoute(HEAD, []) }))).state, "green");
  const failed = fakeFetch({ ...drGreen, ...checksRoute(HEAD, { "trivy-hosted-executor": [hosted("trivy-hosted-executor", { conclusion: "failure" })] }) });
  assert.deepEqual([(await drState(failed)).state, (await drState(failed)).reason], ["failed", "trivy-hosted-executor concluded failure"]);
  // Actions checks are counted there, so a hosted executor workflow's failure is CI's again.
  const proof = async (pr) => ({ passed: false, state: "failed", head: pr.head.sha, pr_number: pr.number, reason: ".github/workflows/trivy.yml: qualified workflow failed" });
  assert.equal((await drState(fakeFetch({ ...drGreen, ...runsRoute(HEAD, []) }), proof)).state, "failed");
  // The reporter posts the failing slot check as before: the rules take it from the clued-admission App.
  const fetch = slotWorld({ extra: { ...rulesRoute(DR_RULES), ...drGreen, ...checksRoute(HEAD, { "gitleaks-hosted-executor": [hosted("gitleaks-hosted-executor", { conclusion: "failure" })] }) } });
  const result = await report(fetch);
  assert.deepEqual([result.errors, result.reports[0].ci_state, result.reports[0].merge_slot_check_run_id], [[], "failed", 5005]);
});

// --- Source v2 external ids (src/job-v2.mjs scanExternalIdV2, admissionExternalIdV2).
const V2_JOB = "6".repeat(64);
const V2_IDS = {
  gitleaks: `independent-ci:staged:v2:${V2_JOB}:a1`,
  trivy: `independent-ci:staged:v2:${V2_JOB}:a2`,
  "contract-placement": `independent-ci:staged:v2:${V2_JOB}:a1`,
  "kooyumi-work-admission": `independent-ci:native-work-admission:v2:${V2_JOB}:a1:c0123abcd:f9:e1`,
  "kooyumi-admission-verified": `independent-ci:control:control-admission:v2:${V2_JOB}:a2:cd1dd735d:f3:e2`,
  "kooyumi-merge-slot": `independent-ci:control:control-merge-slot:v2:${V2_JOB}:a1:cd1dd735d:f3:e2`,
};
const v2 = (name, extra = {}) => independent(name, { external_id: V2_IDS[name], ...extra });

test("A2 v2: the Source v2 staged, native admission and control ids bind by head; malformed and foreign ids never do", () => {
  const ok = { headSha: HEAD, prNumber: 5, repository: REPO };
  for (const name of REQUIRED_NAMES) assert.equal(independentCheckBindsPullRequest(v2(name), ok), true, name);
  assert.equal(independentCheckBindsPullRequest(v2("gitleaks"), { ...ok, headSha: OTHER }), false, "another head");
  for (const [label, name, externalId] of [
    ["attempt 3", "gitleaks", `independent-ci:staged:v2:${V2_JOB}:a3`],
    ["attempt 0", "trivy", `independent-ci:staged:v2:${V2_JOB}:a0`],
    ["a staged id with a claim suffix", "gitleaks", `independent-ci:staged:v2:${V2_JOB}:a1:cd1dd735d:f3:e2`],
    ["a native id without its claim generation", "kooyumi-work-admission", `independent-ci:native-work-admission:v2:${V2_JOB}:a1`],
    ["a short claim prefix", "kooyumi-work-admission", `independent-ci:native-work-admission:v2:${V2_JOB}:a1:cd1dd73:f3:e2`],
    ["an upper-case job id", "kooyumi-work-admission", `independent-ci:native-work-admission:v2:${"A".repeat(64)}:a1:cd1dd735d:f3:e2`],
    ["fence 0", "kooyumi-admission-verified", `independent-ci:control:control-admission:v2:${V2_JOB}:a1:cd1dd735d:f0:e2`],
    ["a trailing field", "kooyumi-admission-verified", `${V2_IDS["kooyumi-admission-verified"]}:x`],
    ["v1 field order inside v2", "kooyumi-admission-verified", `independent-ci:control:control-admission:v2:${V2_JOB}:f3:e2:a1`],
    ["the merge-slot role on the admission check", "kooyumi-admission-verified", V2_IDS["kooyumi-merge-slot"]],
    ["a v2 control id on a scanner", "gitleaks", V2_IDS["kooyumi-admission-verified"]],
    ["a v2 native id on a scanner", "trivy", V2_IDS["kooyumi-work-admission"]],
    ["a v2 staged id on the admission check", "kooyumi-admission-verified", V2_IDS.gitleaks],
    ["an unknown control role", "kooyumi-admission-verified", `independent-ci:control:control-other:v2:${V2_JOB}:a1:cd1dd735d:f3:e2`],
    ["an unknown v1 control role", "kooyumi-admission-verified", `independent-ci:control:control-other:${V2_JOB}:f3:e2:a1`],
    ["a v3 id", "gitleaks", `independent-ci:staged:v3:${V2_JOB}:a1`],
    ["a relay id for another head", "gitleaks", "independent-ci:relay:gitleaks:bbbbbbbbbbbb:run123:a1"],
    ["a relay id for another role", "trivy", "independent-ci:relay:gitleaks:aaaaaaaaaaaa:run123:a1"],
    ["a relay id for placement", "contract-placement", "independent-ci:relay:contract-placement:aaaaaaaaaaaa:run123:a1"],
    ["a foreign prefix", "gitleaks", `other-ci:staged:v2:${V2_JOB}:a1`],
  ]) assert.equal(independentCheckBindsPullRequest(v2(name, { external_id: externalId }), ok), false, label);
  assert.equal(independentCheckBindsPullRequest(v2("trivy", { external_id: "independent-ci:relay:trivy:aaaaaaaaaaaa:run123:a1" }), ok), true);
});

test("A2 v2: the slot reporter counts v2 checks: green, and a v2 final failure returns the slot", async () => {
  const v2Green = () => checksRoute(HEAD, Object.fromEntries(REQUIRED_NAMES.filter((name) => name !== "kooyumi-merge-slot").map((name) => [name, [v2(name)]])));
  let state = await independentState(fakeFetch({ ...v2Green(), ...runsRoute(HEAD, []) }));
  assert.equal(state.state, "green");
  state = await independentState(fakeFetch({ ...v2Green(), ...checksRoute(HEAD, { trivy: [v2("trivy", { conclusion: "failure" })] }) }));
  assert.deepEqual([state.state, state.reason], ["failed", "trivy concluded failure"]);
  state = await independentState(fakeFetch({ ...v2Green(), ...runsRoute(HEAD, []),
    ...checksRoute(HEAD, { "kooyumi-admission-verified": [v2("kooyumi-admission-verified", { external_id: V2_IDS["kooyumi-admission-verified"].replace(":cd1dd735d:", ":cD1DD735D:") })] }) }));
  assert.deepEqual([state.state, state.reason], ["idle", "the newest admission check does not bind this pull request"]);
  const fetch = slotWorld({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...v2Green(), ...runsRoute(HEAD, []),
    ...checksRoute(HEAD, { gitleaks: [v2("gitleaks", { conclusion: "failure" })] }) } });
  const result = await report(fetch);
  assert.deepEqual([result.errors, result.reports[0].ci_state, result.reports[0].returned], [[], "failed", true]);
  assert.equal(await requiredBarrier(fakeFetch({ ...v2Green(), ...rulesRoute(INDEPENDENT_RULES), ...runsRoute(HEAD, []) }).fetchImpl,
    env(), REPO, HEAD, 5, { native_runs: [], default_branch: "main" }), true);
});
