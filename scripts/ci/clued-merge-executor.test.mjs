import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXECUTOR_PERMISSIONS, optedIn, renderSummary, runExecutor } from "./clued-merge-executor.mjs";
import { CI_REQUIRED_CHECKS, HOLDERS_RPC } from "./clued-merge-slot-ci.mjs";
import { ADMISSION_APP_ID } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "tdoljyj/cross-memory-system";
const HEAD = "a".repeat(40);
const TIP = "c".repeat(40);
const CLAIM = "11111111-2222-4333-8444-555555555555";
const SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const SLOT = `merge:${REPO}:main`;

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", CLUED_CONTEXT_READ_TOKEN: "clued-token",
  CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: PEM, ...extra });
const BODY = `Clued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}`;
const pull = (extra = {}) => ({ number: 5, node_id: "PR_node5", body: `${BODY}\nClued-Auto-Merge: on`, draft: false, auto_merge: null,
  head: { sha: HEAD, repo: { full_name: REPO } }, base: { ref: "main", repo: { default_branch: "main" } }, ...extra });
const check = (name, extra = {}) => ({ id: 10, name, head_sha: HEAD, status: "completed", conclusion: "success",
  app: { id: name === "clued-admission-verified" ? ADMISSION_APP_ID : 15368 },
  ...(name === "clued-admission-verified" ? { output: { title: "ADMITTED [normal · code · reruns 1]" } } : {}), ...extra });

// Routes are matched by prefix; an RPC route answers with a function of its input.
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
    const status = answer && answer.__status ? answer.__status : (method === "POST" && key.includes("access_tokens") ? 201 : method === "PUT" ? 202 : 200);
    const payload = answer && answer.__status ? answer.body : answer;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const checksRoute = (byName) => Object.fromEntries(Object.entries(byName).map(([name, checks]) =>
  [`/repos/${REPO}/commits/${HEAD}/check-runs?check_name=${name}&`, { check_runs: checks }]));
const allGreen = () => checksRoute(Object.fromEntries([...CI_REQUIRED_CHECKS.map(({ name }) => name)].map((name) => [name, [check(name)]])));

function world({ pulls = [pull()], holders = [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_refs: [SLOT], merge_slot_until: "2026-10-09T12:00:00Z",
  merge_slot_ci: { taken_at: "2026-10-09T10:00:00Z" } }], behindBy = 0, token = { token: "ghs_exec" }, extra = {} } = {}) {
  return fakeFetch({
    [`/repos/${REPO}/pulls?state=open`]: pulls,
    [`rpc:${HOLDERS_RPC}`]: () => ({ status: "ok", repository: REPO, holders }),
    [`/repos/${REPO}/branches/main`]: { commit: { sha: TIP } },
    [`/repos/${REPO}/compare/${TIP}...${HEAD}`]: { behind_by: behindBy, ahead_by: 3 },
    [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { workflow_runs: [] },
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

test("optedIn: only an exact body line turns it on", () => {
  assert.equal(optedIn("x\nClued-Auto-Merge: on\n"), true);
  assert.equal(optedIn("clued-auto-merge:   ON"), true);
  for (const body of [null, "", "Clued-Auto-Merge: off", "Clued-Auto-Merge: on please", "see Clued-Auto-Merge: on"]) {
    assert.equal(optedIn(body), false, String(body));
  }
});

test("a head behind the default branch is brought up to date as the App, bound to the head it read", async () => {
  const fetch = world({ behindBy: 2 });
  const result = await run(fetch);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.actions.map((a) => [a.pr, a.action, a.status]), [[5, "update_branch", 202]]);
  const minted = fetch.calls.find((call) => call.route.includes("access_tokens"));
  assert.deepEqual(minted.body.permissions, EXECUTOR_PERMISSIONS);
  assert.deepEqual(minted.body.repositories, ["cross-memory-system"]);
  const [put] = writes(fetch);
  assert.deepEqual([put.method, put.route, put.body, put.authorization],
    ["PUT", `/repos/${REPO}/pulls/5/update-branch`, { expected_head_sha: HEAD }, "Bearer ghs_exec"]);
  assert.deepEqual(fetch.calls.find((call) => call.route === `rpc:${HOLDERS_RPC}`).input, { scope: SCOPE, repository: REPO });
  assert.match(renderSummary(result), /#5 `aaaaaaaaaaaa`: \*\*update_branch\*\*/);
});

test("an up-to-date, green, admitted, opted-in head gets auto-merge with its expected head", async () => {
  const fetch = world();
  const result = await run(fetch);
  assert.deepEqual(result.actions.map((a) => [a.action, a.status, a.error]), [["enable_auto_merge", 200, undefined]]);
  const [mutation] = writes(fetch);
  assert.equal(mutation.route, "/graphql");
  assert.match(mutation.body.query, /enablePullRequestAutoMerge\(input: \{pullRequestId: \$id, mergeMethod: MERGE, expectedHeadOid: \$oid\}\)/);
  assert.deepEqual(mutation.body.variables, { id: "PR_node5", oid: HEAD });
});

test("nothing is written unless every condition holds", async () => {
  const cases = [
    ["not opted in", { pulls: [pull({ body: BODY })] }, /did not opt in/],
    ["auto-merge already on", { pulls: [pull({ auto_merge: { enabled_by: { login: "x" } } })] }, /already on/],
    ["CI running", { extra: { [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { workflow_runs: [] },
      ...checksRoute({ trivy: [check("trivy", { status: "in_progress", conclusion: null })] }) } }, /CI is idle/],
    ["CI failed", { extra: checksRoute({ gitleaks: [check("gitleaks", { conclusion: "failure", completed_at: "2026-10-09T11:00:00Z" })] }) }, /CI is failed/],
    ["not admitted", { extra: checksRoute({ "clued-admission-verified": [check("clued-admission-verified", { conclusion: "failure" })] }) }, /CI is failed|not admitted/],
    ["no mode in the title", { extra: checksRoute({ "clued-admission-verified": [check("clued-admission-verified", { output: { title: "ADMITTED" } })] }) }, /has not admitted/],
  ];
  for (const [name, options, reason] of cases) {
    const fetch = world(options);
    const result = await run(fetch);
    assert.deepEqual(writes(fetch), [], name);
    assert.equal(fetch.calls.some((call) => call.route.includes("access_tokens")), false, `${name}: no token is minted`);
    assert.match(result.actions[0].reason, reason, name);
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
  // Nor without the App at all.
  const bare = world({ behindBy: 1 });
  const unconfigured = await run(bare, { CLUED_ADMISSION_APP_ID: "", CLUED_ADMISSION_APP_PRIVATE_KEY: "" });
  assert.deepEqual(writes(bare), []);
  assert.match(unconfigured.notices[0], /not configured/);
});

test("only the default branch's queue head, an open same-repository non-draft pull request, is acted on", async () => {
  for (const [name, options] of [
    ["another branch's queue", { holders: [{ claim_id: CLAIM, bound_pr: `${REPO}#5`, merge_refs: [`merge:${REPO}:release`] }] }],
    ["a pull request not open", { pulls: [] }],
    ["a fork", { pulls: [pull({ head: { sha: HEAD, repo: { full_name: "someone/fork" } } })] }],
    ["a draft", { pulls: [pull({ draft: true })] }],
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

test("the workflow runs default-branch code after the slot report, hourly and by hand, read-only, in the admission environment", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-merge-executor.yml"), "utf8");
  assert.match(text, /on:\n  workflow_run:\n    workflows:\n      - clued-merge-slot-ci\n    types: \[completed\]\n  schedule:\n    - cron: "41 \* \* \* \*"\n  workflow_dispatch:\n/);
  assert.doesNotMatch(text, /pull_request/);
  assert.match(text, /permissions:\n  actions: read\n  checks: read\n  contents: read\n  pull-requests: read\n\n/);
  assert.doesNotMatch(text, /^\s+[a-z-]+: write$/m);
  assert.match(text, /runs-on: ubuntu-latest\n    timeout-minutes: 5\n    environment: clued-admission\n/);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}\n          persist-credentials: false/);
});
