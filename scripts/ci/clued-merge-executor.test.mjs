import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXECUTOR_PERMISSIONS, optInSha, renderSummary, runExecutor } from "./clued-merge-executor.mjs";
import { CI_REQUIRED_CHECKS, HOLDERS_RPC } from "./clued-merge-slot-ci.mjs";
import { ADMISSION_APP_ID } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "tdoljyj/cross-memory-system";
const HEAD = "a".repeat(40);
const APPROVED = "b".repeat(40);
const TIP = "c".repeat(40);
const MAINISH = "d".repeat(40);
const CLAIM = "11111111-2222-4333-8444-555555555555";
const SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const SLOT = `merge:${REPO}:main`;

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", CLUED_CONTEXT_READ_TOKEN: "clued-token",
  CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: PEM, ...extra });
const BODY = `Clued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}`;
const pull = (extra = {}) => ({ number: 5, node_id: "PR_node5", body: `${BODY}\nClued-Auto-Merge: ${HEAD}`, draft: false, auto_merge: null,
  head: { sha: HEAD, repo: { full_name: REPO } }, base: { ref: "main", repo: { default_branch: "main" } }, ...extra });
const verified = (extra = {}) => ({ id: 20, name: "clued-admission-verified", head_sha: HEAD, status: "completed", conclusion: "success",
  app: { id: ADMISSION_APP_ID }, external_id: "pr:5:run:900", output: { title: "ADMITTED [normal · code · reruns 1]" }, ...extra });
const check = (name, extra = {}) => (name === "clued-admission-verified" ? verified(extra)
  : { id: 10, name, head_sha: HEAD, status: "completed", conclusion: "success", app: { id: 15368 }, ...extra });

// Routes are matched by "METHOD prefix" (GET when no method); an RPC route answers with a function of its input.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url).replace(/^https:\/\/api\.github\.com/, "");
    const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(route);
    const body = init.body ? JSON.parse(init.body) : null;
    const method = init.method ?? "GET";
    calls.push({ route: rpc ? `rpc:${rpc[1]}` : route, method, input: body && body.p_input, body,
      authorization: init.headers && init.headers.authorization });
    const key = rpc ? `rpc:${rpc[1]}` : Object.keys(routes).find((prefix) => {
      const [m, p] = prefix.includes(" ") ? prefix.split(" ") : ["GET", prefix];
      return m === method && route.startsWith(p);
    });
    if (!key || !(key in routes)) return new Response("not found", { status: 404 });
    const answer = typeof routes[key] === "function" ? routes[key](body) : routes[key];
    const status = answer && answer.__status ? answer.__status : (key.includes("access_tokens") ? 201 : method === "PUT" ? 202 : 200);
    const payload = answer && answer.__status ? answer.body : answer;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const checksRoute = (byName) => Object.fromEntries(Object.entries(byName).map(([name, checks]) =>
  [`/repos/${REPO}/commits/${HEAD}/check-runs?check_name=${name}&`, { check_runs: checks }]));
const allGreen = () => checksRoute(Object.fromEntries(CI_REQUIRED_CHECKS.map(({ name }) => [name, [check(name)]])));

function world({ pulls = [pull()], holders = [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_refs: [SLOT], merge_slot_until: "2026-10-09T12:00:00Z",
  merge_slot_ci: { taken_at: "2026-10-09T10:00:00Z" } }], behindBy = 0, token = { token: "ghs_exec" }, extra = {} } = {}) {
  return fakeFetch({
    [`/repos/${REPO}/pulls?state=open`]: pulls,
    [`rpc:${HOLDERS_RPC}`]: () => ({ status: "ok", repository: REPO, holders }),
    [`/repos/${REPO}/branches/main`]: { commit: { sha: TIP } },
    [`/repos/${REPO}/compare/${TIP}...${HEAD}`]: { behind_by: behindBy, ahead_by: 3 },
    // By default the head's CI ran and passed (Task 114d43cf); tests override these two routes.
    [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { workflow_runs: [{ id: 700, path: ".github/workflows/clued-components.yml@refs/pull/5/merge",
      head_sha: HEAD, event: "pull_request", status: "completed", conclusion: "success" }] },
    [`/repos/${REPO}/actions/runs/700/jobs`]: { jobs: [{ name: "admission-gate", conclusion: "success" }, { name: "components", conclusion: "success" }] },
    [`/repos/${REPO}/installation`]: { id: 99 },
    "POST /app/installations/99/access_tokens": token,
    [`PUT /repos/${REPO}/pulls/5/update-branch`]: { message: "Updating pull request branch." },
    "POST /graphql": { data: { enablePullRequestAutoMerge: { pullRequest: { number: 5, autoMergeRequest: { enabledAt: "now" } } } } },
    ...allGreen(),
    ...extra,
  });
}
const run = (fetch, extraEnv = {}) => runExecutor({ env: env(extraEnv), fetchImpl: fetch.fetchImpl, workspace: ROOT });
const writes = (fetch) => fetch.calls.filter((call) => call.method !== "GET" && !call.route.startsWith("rpc:") && !call.route.includes("access_tokens"));

test("optInSha: only an exact body line naming a full head sha", () => {
  assert.equal(optInSha(`x\nClued-Auto-Merge: ${HEAD}\n`), HEAD);
  assert.equal(optInSha(`clued-auto-merge:   ${HEAD.toUpperCase().replace(/A/g, "a")}`), HEAD);
  for (const body of [null, "", "Clued-Auto-Merge: on", `Clued-Auto-Merge: ${HEAD.slice(0, 12)}`, `see Clued-Auto-Merge: ${HEAD}`, `Clued-Auto-Merge: ${HEAD} please`]) {
    assert.equal(optInSha(body), null, String(body));
  }
});

test("a head behind the default branch is brought up to date as the App, bound to the head it read", async () => {
  const fetch = world({ behindBy: 2 });
  const result = await run(fetch);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.actions.map((a) => [a.pr, a.action, a.status]), [[5, "update_branch", 202]]);
  const minted = fetch.calls.find((call) => call.route.includes("access_tokens"));
  assert.deepEqual([minted.body.permissions, minted.body.repositories], [EXECUTOR_PERMISSIONS, ["cross-memory-system"]]);
  const [put] = writes(fetch);
  assert.deepEqual([put.method, put.route, put.body, put.authorization],
    ["PUT", `/repos/${REPO}/pulls/5/update-branch`, { expected_head_sha: HEAD }, "Bearer ghs_exec"]);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${HOLDERS_RPC}`).input, { scope: SCOPE, repository: REPO });
  assert.match(renderSummary(result), /#5 `aaaaaaaaaaaa`: \*\*update_branch\*\*/);
  // Not a protected-layer pull request (review MINOR-4), nor one whose admission has no mode yet.
  for (const title of ["ADMITTED [normal · protected · reruns 0]", "ADMITTED"]) {
    const held = world({ behindBy: 2, extra: checksRoute({ "clued-admission-verified": [verified({ output: { title } })] }) });
    const outcome = await run(held);
    assert.deepEqual([writes(held), outcome.actions[0].action], [[], "none"], title);
  }
});

test("an up-to-date, admitted head opted in for itself gets auto-merge once its CI ran and passed; GitHub waits for the required checks", async () => {
  // A required check still running (trivy) does not hold it back: GitHub waits for it.
  const running = checksRoute({ trivy: [check("trivy", { status: "in_progress", conclusion: null })] });
  for (const extra of [{}, running]) {
    const fetch = world({ extra });
    const result = await run(fetch);
    assert.deepEqual(result.actions.map((a) => [a.action, a.status, a.error]), [["enable_auto_merge", 200, undefined]]);
    const [mutation] = writes(fetch);
    assert.equal(mutation.route, "/graphql");
    assert.match(mutation.body.query, /enablePullRequestAutoMerge\(input: \{pullRequestId: \$id, mergeMethod: MERGE, expectedHeadOid: \$oid\}\)/);
    assert.deepEqual(mutation.body.variables, { id: "PR_node5", oid: HEAD });
  }
});

test("an opt-in for an approved head covers later changes only where they equal the default branch", async () => {
  const body = `${BODY}
Clued-Auto-Merge: ${APPROVED}`;
  const files = (...names) => names.map((filename) => ({ filename, status: "modified" }));
  // compare/{approved}...{head}: what changed since the approval; compare/{tip}...{head}: where the head differs from main.
  const since = (list, behind = 0) => ({ [`/repos/${REPO}/compare/${APPROVED}...${HEAD}`]: { behind_by: behind, files: list } });
  const vsTip = (list) => ({ [`/repos/${REPO}/compare/${TIP}...${HEAD}`]: { behind_by: 0, ahead_by: 3, files: list } });
  let fetch = world({ pulls: [pull({ body })], extra: { ...since(files("README.md", "worker/a.ts")), ...vsTip(files("scripts/pr-change.mjs")) } });
  assert.equal((await run(fetch)).actions[0].action, "enable_auto_merge", "only main's files changed since the approval");
  for (const [name, extra] of [
    ["a change of the pull request's own after the approval", { ...since(files("README.md", "scripts/pr-change.mjs")), ...vsTip(files("scripts/pr-change.mjs")) }],
    ["a hand-resolved conflict or an amended merge (an evil merge)", { ...since(files("worker/a.ts")), ...vsTip(files("worker/a.ts", "scripts/pr-change.mjs")) }],
    ["a rename onto a file that differs from main", { ...since([{ filename: "x.md", previous_filename: "scripts/pr-change.mjs", status: "renamed" }]), ...vsTip(files("scripts/pr-change.mjs")) }],
    ["the approved head is not an ancestor", { ...since(files("README.md"), 2), ...vsTip(files("scripts/pr-change.mjs")) }],
    ["a diff that may be truncated", { ...since(Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }))), ...vsTip(files("scripts/pr-change.mjs")) }],
  ]) {
    fetch = world({ pulls: [pull({ body })], extra });
    const result = await run(fetch);
    assert.deepEqual([writes(fetch), result.actions[0].action], [[], "none"], name);
    assert.match(result.actions[0].reason, /opt-in names bbbbbbbbbbbb/, name);
  }
});

test("auto-merge on with an opt-in for another head is turned off (review MAJOR-2)", async () => {
  const body = `${BODY}\nClued-Auto-Merge: ${APPROVED}`;
  const fetch = world({ pulls: [pull({ body, auto_merge: { merge_method: "merge" } })],
    extra: { [`/repos/${REPO}/compare/${APPROVED}...${HEAD}`]: { behind_by: 0, files: [{ filename: "scripts/pr-change.mjs" }] },
      [`/repos/${REPO}/compare/${TIP}...${HEAD}`]: { behind_by: 0, files: [{ filename: "scripts/pr-change.mjs" }] },
      "POST /graphql": { data: { disablePullRequestAutoMerge: { pullRequest: { number: 5 } } } } } });
  const result = await run(fetch);
  assert.deepEqual(result.actions.map((a) => [a.action, a.status]), [["disable_auto_merge", 200]]);
  const [mutation] = writes(fetch);
  assert.match(mutation.body.query, /disablePullRequestAutoMerge\(input: \{pullRequestId: \$id\}\)/);
  assert.deepEqual(mutation.body.variables, { id: "PR_node5" });
  // Auto-merge someone turned on without an opt-in line is left alone.
  const manual = world({ pulls: [pull({ body: BODY, auto_merge: { merge_method: "merge" } })] });
  assert.deepEqual([writes(manual), (await run(manual)).actions[0].reason], [[], "auto-merge is already on"]);
});

// CI runs on the head: the newest pull_request run of a gated workflow, and its jobs (review MAJOR-1).
const GATED = ".github/workflows/clued-components.yml";
const ciRuns = ({ conclusion = "success", status = "completed", jobs = [["admission-gate", "success"], ["components", "success"]] } = {}) => ({
  [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { workflow_runs: [
    { id: 600, path: `${GATED}@refs/pull/5/merge`, head_sha: HEAD, event: "pull_request", status: "completed", conclusion: "failure" },
    { id: 700, path: `${GATED}@refs/pull/5/merge`, head_sha: HEAD, event: "pull_request", status, conclusion: status === "completed" ? conclusion : null },
  ] },
  [`/repos/${REPO}/actions/runs/700/jobs`]: { jobs: jobs.map(([name, c]) => ({ name, conclusion: c })) },
});
const mergeable = (status) => ({ "POST /graphql": { data: null, errors: [{ message: `Pull request Pull request is in ${status} status` }] } });
const MERGE = `PUT /repos/${REPO}/pulls/5/merge`;
const mergeCall = (fetch) => writes(fetch).find((call) => call.method === "PUT" && call.route === `/repos/${REPO}/pulls/5/merge`);

test("a clean, opted-in head whose CI all ran and passed is merged by the executor, bound to its head (Task ff476b06)", async () => {
  const fetch = world({ extra: { ...mergeable("clean"), ...ciRuns(),
    [MERGE]: { __status: 200, body: { merged: true, sha: "c".repeat(40), message: "Pull Request successfully merged" } } } });
  const result = await run(fetch);
  assert.deepEqual([result.errors, result.actions[0].result, result.actions[0].merge_status, result.actions[0].merge_commit, result.actions[0].error],
    [[], "merged", 200, "c".repeat(40), undefined]);
  const merge = mergeCall(fetch);
  assert.deepEqual([merge.body, merge.authorization], [{ merge_method: "merge", sha: HEAD }, "Bearer ghs_exec"]);
  assert.ok(fetch.calls.some((call) => call.route === `/repos/${REPO}/actions/runs/700/jobs?filter=latest&per_page=100`), "the newest run's jobs");
  assert.match(result.notices[0], /already mergeable, so GitHub does not take auto-merge; the executor merged it/);
  assert.match(renderSummary(result), /\*\*merged\*\*/);
});

test("Task 114d43cf: skipped gated jobs, a red or running CI run or no CI run get neither auto-merge nor a merge", async () => {
  for (const [name, extra, reason] of [
    ["gated jobs skipped", ciRuns({ jobs: [["admission-gate", "success"], ["components", "skipped"]] }),
      /\.github\/workflows\/clued-components\.yml skipped components/],
    ["CI run failed", ciRuns({ conclusion: "failure" }), /clued-components\.yml is completed \(failure\)/],
    ["CI run still running", { ...ciRuns({ status: "in_progress" }),
      [`/repos/${REPO}/contents/.github/workflows?ref=${HEAD}`]: [] }, /clued-components\.yml is in_progress/],
    ["no CI run", { [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { workflow_runs: [] } }, /no CI workflow ran on this head/],
  ]) {
    for (const status of ["clean", "pending"]) {
      const fetch = world({ extra: { ...(status === "clean" ? mergeable("clean") : {}), ...extra } });
      const result = await run(fetch);
      assert.deepEqual([result.errors, result.actions[0].action, writes(fetch)], [[], "none", []], `${name} ${status}`);
      assert.match(result.actions[0].reason, new RegExp(`^waiting for CI on this head: .*${reason.source}`), `${name} ${status}`);
    }
  }
  // Unstable (a check that is not required failed or is pending) is never merged.
  const fetch = world({ extra: { ...mergeable("unstable"), ...ciRuns() } });
  const result = await run(fetch);
  assert.deepEqual([result.errors, result.actions[0].result, result.actions[0].error, mergeCall(fetch)], [[], "mergeable_now", undefined, undefined]);
  assert.match(result.notices[0], /already mergeable, but not merged: .*not required failed or is still pending \(unstable status\)/);
});

test("GitHub refuses the merge: 405 and 409 stay mergeable_now with the reason; any other answer is merge_refused", async () => {
  for (const [code, message, expected] of [[405, 'Required status check "trivy" is expected.', "mergeable_now"],
    [409, "Head branch was modified. Review and try the merge again.", "mergeable_now"], [403, "Resource not accessible by integration", "merge_refused"]]) {
    const fetch = world({ extra: { ...mergeable("clean"), ...ciRuns(), [MERGE]: { __status: code, body: { message } } } });
    const result = await run(fetch);
    assert.deepEqual([result.errors, result.actions[0].result, result.actions[0].merge_status, result.actions[0].error],
      [[], expected, code, `merge refused: ${message}`], String(code));
    assert.match(result.notices[0], /enable_auto_merge was refused: merge refused/);
  }
});

test("any other GraphQL error is a refusal notice", async () => {
  const other = world({ extra: { "POST /graphql": { data: null, errors: [{ message: "Resource not accessible by integration" }] } } });
  const refused = await run(other);
  assert.deepEqual([refused.errors, refused.actions[0].error], [[], "Resource not accessible by integration"]);
  assert.match(refused.notices[0], /enable_auto_merge was refused/);
});

test("nothing is written unless every condition holds", async () => {
  const cases = [
    ["not opted in", { pulls: [pull({ body: BODY })] }, /did not opt in/],
    ["auto-merge already on", { pulls: [pull({ auto_merge: { merge_method: "merge" } })] }, /already on/],
    ["CI failed", { extra: checksRoute({ gitleaks: [check("gitleaks", { conclusion: "failure", completed_at: "2026-10-09T11:00:00Z" })] }) }, /CI failed/],
    ["not admitted", { extra: checksRoute({ "clued-admission-verified": [verified({ conclusion: "failure" })] }) }, /has not admitted/],
    ["admitted for another pull request (review MINOR-2)", { extra: checksRoute({ "clued-admission-verified": [verified({ external_id: "pr:6:run:901" })] }) }, /has not admitted/],
    ["no mode in the title", { extra: checksRoute({ "clued-admission-verified": [verified({ output: { title: "ADMITTED" } })] }) }, /has not admitted/],
  ];
  for (const [name, options, reason] of cases) {
    const fetch = world(options);
    const result = await run(fetch);
    assert.deepEqual(writes(fetch), [], name);
    assert.equal(fetch.calls.some((call) => call.route.includes("access_tokens")), false, `${name}: no token is minted`);
    assert.match(result.actions[0].reason, reason, name);
  }
});

test("a protected-layer pull request gets auto-merge like any other; Owner review is always enforced (Merge Admission step 6)", async () => {
  const protectedCheck = { extra: checksRoute({ "clued-admission-verified": [verified({ output: { title: "ADMITTED [normal · protected · reruns 0]" } })] }) };
  for (const retired of [undefined, "", "false"]) {
    const fetch = world(protectedCheck);
    const result = await run(fetch, retired === undefined ? {} : { CLUED_OWNER_REVIEW_ENFORCE: retired });
    assert.equal(result.actions[0].action, "enable_auto_merge", String(retired));
  }
});

test("frozen: the executor does nothing, not even read the queue", async () => {
  const fetch = world({ behindBy: 1 });
  const result = await run(fetch, { CLUED_MERGE_ADMISSION_STATE: "frozen" });
  assert.deepEqual([result.state, fetch.calls.length], ["frozen", 0]);
  assert.match(result.notices[0], /frozen/);
});

test("without the App permissions it reports and changes nothing", async () => {
  const fetch = world({ behindBy: 1, token: { __status: 422, body: { message: "The permissions requested are not granted to this installation." } } });
  const result = await run(fetch);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(writes(fetch), []);
  assert.deepEqual(result.actions.map((a) => [a.action, a.wanted]), [["skipped", "update_branch"]]);
  assert.match(result.notices[0], /does not have Contents: write and Pull requests: write/);
  const bare = world({ behindBy: 1 });
  const unconfigured = await run(bare, { CLUED_ADMISSION_APP_ID: "", CLUED_ADMISSION_APP_PRIVATE_KEY: "" });
  assert.deepEqual(writes(bare), []);
  assert.match(unconfigured.notices[0], /not configured/);
  const missing = world({ behindBy: 1, extra: { [`/repos/${REPO}/installation`]: { __status: 404, body: { message: "Not Found" } } } });
  const uninstalled = await run(missing);
  assert.deepEqual(writes(missing), []);
  assert.match(uninstalled.notices[0], /installation returned 404/);
});

test("only the default branch's queue head, an open same-repository non-draft pull request that names its claim, is acted on", async () => {
  for (const [name, options] of [
    ["another branch's queue", { holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_refs: [`merge:${REPO}:release`] }] }],
    ["a pull request not open", { pulls: [] }],
    ["a fork", { pulls: [pull({ head: { sha: HEAD, repo: { full_name: "someone/fork" } } })] }],
    ["a draft", { pulls: [pull({ draft: true })] }],
    ["no claim in the body (review MINOR-3)", { pulls: [pull({ body: `Clued-Auto-Merge: ${HEAD}` })] }],
    ["no head", { holders: [] }],
  ]) {
    const fetch = world({ behindBy: 1, ...options });
    const result = await run(fetch);
    assert.deepEqual([result.actions, writes(fetch)], [[], []], name);
  }
});

test("a refused update (head moved, conflict) is a notice, not an error", async () => {
  const fetch = world({ behindBy: 1, extra: { [`PUT /repos/${REPO}/pulls/5/update-branch`]: { __status: 422, body: { message: "merge conflict between base and head" } } } });
  const result = await run(fetch);
  assert.deepEqual(result.errors, []);
  assert.equal(result.actions[0].error, "merge conflict between base and head");
  assert.match(result.notices[0], /#5: update_branch was refused: merge conflict/);
});

test("the independent executor workflow runs default-branch code on main push and by hand, read-only, in the admission environment", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-merge-executor.yml"), "utf8");
  assert.match(text, /on:\n  # [^\n]*\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/);
  assert.doesNotMatch(text, /^  workflow_run:/m, "slot reports execute inline, without another hosted run");
  assert.doesNotMatch(text, /^  schedule:/m, "executor recovery is event driven, not another hourly hosted run");
  assert.doesNotMatch(text, /pull_request/);
  assert.match(text, /permissions:\n  actions: read\n  checks: read\n  contents: read\n  pull-requests: read\n\n/);
  assert.doesNotMatch(text, /^\s+[a-z-]+: write$/m);
  assert.match(text, /name: clued-merge-executor\n    runs-on: ubuntu-slim\n    timeout-minutes: 10\n    environment: clued-admission\n/);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}\n          persist-credentials: false/);
  assert.doesNotMatch(text, /_ENFORCE/);
});
