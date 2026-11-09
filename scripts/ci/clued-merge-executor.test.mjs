import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { fileURLToPath } from "node:url";

import { EXECUTOR_PERMISSIONS, currentOperationAuthority, optInSha, renderSummary, runExecutor } from "./clued-merge-executor.mjs";
import { resolveMode } from "./merge-admission-policy.mjs";
import { LEGACY_CI_REQUIRED_CHECKS as CI_REQUIRED_CHECKS, HOLDERS_RPC } from "./clued-merge-slot-ci.mjs";
import { ADMISSION_APP_ID, VERIFY_RPC } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "tdoljyj/cross-memory-system";
const HEAD = "a".repeat(40);
const APPROVED = "b".repeat(40);
const TIP = "c".repeat(40);
const MAINISH = "d".repeat(40);
const CLAIM = "11111111-2222-4333-8444-555555555555";
const SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f";
const SLOT = `merge:${REPO}:main`;
const HEAD_AUTH = '22222222-2222-4222-8222-222222222222';
function nativeBinding(pr, patch={}) { return {status:'ok',binding_status:'bound',reason:null,repository:REPO,pr_number:pr.number,
  pr_ref:`${REPO}#${pr.number}`,head_sha:pr.head.sha,base_sha:pr.base.sha,target_branch:pr.base.ref,scope:SCOPE,task_id:CLAIM,
  claim:{claim_id:CLAIM,task_id:CLAIM,context_key:SCOPE,fence:3,execution_epoch:1,lease_version:1,status:'ACTIVE',
    execution_handover_pending:false,expires_at:'2099-01-01T00:00:00.000Z'},head_authorization_id:HEAD_AUTH,auto_bound:false,receipt_id:null,...patch}; }

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "t", CLUED_CONTEXT_READ_TOKEN: "clued-token",
  CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: PEM, ...extra });
const BODY = `Clued-Work-Claim: ${CLAIM}\nClued-Work-Scope: ${SCOPE}`;
const pull = (extra = {}) => ({ number: 5, node_id: "PR_node5", body: `${BODY}\nClued-Auto-Merge: ${HEAD}`, state: "open", mergeable_state:"clean", draft: false, auto_merge: null,
  head: { sha: HEAD, repo: { full_name: REPO } }, base: { ref: "main", sha: TIP, repo: { default_branch: "main", full_name: REPO } }, ...extra });
const verified = (extra = {}) => ({ id: 20, name: "kooyumi-admission-verified", head_sha: HEAD, status: "completed", conclusion: "success",
  app: { id: ADMISSION_APP_ID }, external_id: "pr:5:run:900", output: { title: "ADMITTED [normal · code · reruns 1]" }, ...extra });
const check = (name, extra = {}) => (name === "kooyumi-admission-verified" ? verified(extra)
  : { id: CI_REQUIRED_CHECKS.findIndex(row=>row.name===name)+1, name, head_sha: HEAD, status: "completed", conclusion: "success", app: { id: 15368 }, ...extra });

// Design A2: the branch rules decide which checks and sources count.
const LEGACY_RULES = Object.freeze([...CI_REQUIRED_CHECKS, Object.freeze({ name: "kooyumi-merge-slot", app_id: ADMISSION_APP_ID })]);
const REQUIRED_NAMES = ["gitleaks", "trivy", "kooyumi-work-admission", "kooyumi-admission-verified", "kooyumi-merge-slot", "contract-placement"];
const INDEPENDENT_RULES = Object.freeze(REQUIRED_NAMES.map((name) => Object.freeze({ name, app_id: 5368905 })));
const branchRules = (list) => [{ type: "required_status_checks", ruleset_id: 24182890, parameters: { strict_required_status_checks_policy: true,
  required_status_checks: list.map(({ name, app_id }) => ({ context: name, integration_id: app_id })) } }];
const rulesRoute = (list) => ({ [`/repos/${REPO}/rules/branches/main`]: branchRules(list) });

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
    if(rpc?.[1]===VERIFY_RPC && body?.p_input?.action==='resolve_pr_claim') {
      const input=body.p_input,selected=routes['binding:resolve'];
      const binding=selected ? (typeof selected==='function'?selected(body):selected) : nativeBinding({number:Number(input.pr_ref.split('#')[1]),
        head:{sha:input.head_sha},base:{sha:input.base_sha,ref:input.target_branch}});
      return new Response(JSON.stringify(binding),{status:200});
    }
    // Branch rules not given by a test are the legacy mapping (design A2).
    if (method === "GET" && route.startsWith(`/repos/${REPO}/rules/branches/`) && !Object.keys(routes).some((key) => route.startsWith(key)))
      return new Response(JSON.stringify(branchRules(LEGACY_RULES)), { status: 200, headers: { "content-type": "application/json" } });
    const snapshot = /^(.*\/check-runs)\?filter=all&/.exec(route);
    if (snapshot && !Object.keys(routes).some(key=>key.startsWith(`${snapshot[1]}?filter=all`) && route.startsWith(key))) {
      const chunks = Object.entries(routes).filter(([key])=>key.startsWith(`${snapshot[1]}?check_name=`))
        .map(([,value])=>typeof value==='function'?value(null):value);
      const checks = chunks.flatMap(chunk=>chunk.check_runs);
      const page = Number(new URL(`https://api.github.com${route}`).searchParams.get('page'));
      return new Response(JSON.stringify({total_count:checks.length,check_runs:checks.slice((page-1)*100,page*100)}));
    }
    const key = rpc ? `rpc:${rpc[1]}` : Object.keys(routes).sort((a,b)=>b.length-a.length).find((prefix) => {
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

const PROOF = Symbol("execution fixture");
const fixtureProof = pr => ({passed:true,state:"qualified",head:pr.head.sha,pr_number:pr.number,reason:"qualified execution fixture",native_runs:[]});
function world({ pulls = [pull()], holders = [{ claim_id: CLAIM, task_id: CLAIM, bound_pr: `${REPO}#5`, bound_prs:[`${REPO}#5`], merge_refs: [SLOT], merge_slot_until: "2026-10-09T12:00:00Z",
  merge_slot_ci: { taken_at: "2026-10-09T10:00:00Z" } }], behindBy = 0, token = { token: "ghs_exec" }, extra = {} } = {}) {
  const result = fakeFetch({
    ...Object.fromEntries(pulls.map(pr=>[`/repos/${REPO}/pulls/${pr.number}`,pr])),
    [`/repos/${REPO}/pulls?state=open`]: pulls,
    [`rpc:${HOLDERS_RPC}`]: () => ({ status: "ok", repository: REPO, holders }),
    [`/repos/${REPO}/branches/main`]: { commit: { sha: TIP } },
    [`/repos/${REPO}/compare/${TIP}...${HEAD}`]: { behind_by: behindBy, ahead_by: 3 },
    // By default the head's CI ran and passed (Task 114d43cf); tests override these two routes.
    [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { total_count:1,workflow_runs: [{ id: 700, path: ".github/workflows/clued-components.yml@refs/pull/5/merge",
      head_sha: HEAD, event: "pull_request", status: "completed", conclusion: "success" }] },
    [`/repos/${REPO}/actions/runs/700/jobs`]: { jobs: [{ name: "admission-gate", conclusion: "success" }, { name: "clued-components", conclusion: "success" },
      { name: "${{ (((github.event_name == 'push' && github.actor != github.repository_owner) ... 'clued-components-hosted-skipped' }}", conclusion: "skipped" }] },
    [`/repos/${REPO}/installation`]: { id: 99 },
    "POST /app/installations/99/access_tokens": token,
    [`PUT /repos/${REPO}/pulls/5/update-branch`]: { message: "Updating pull request branch." },
    "POST /graphql": {data:{disablePullRequestAutoMerge:{pullRequest:{number:5}}}},
    [`PUT /repos/${REPO}/pulls/5/merge`]:{__status:200,body:{merged:true,sha:TIP}},
    ...allGreen(),
    ...extra,
  });
  result.execution = extra[PROOF]; result.progress_ref=holders[0]?.progress_ref;
  return result;
}
// These fixtures test consumer/authority ordering. Source/job qualification is
// tested independently by the pure proof and runtime suites, not bypassed by env.
const run = (fetch, extraEnv = {}, dependencies = {}) => runExecutor({ env: env(extraEnv), fetchImpl: fetch.fetchImpl, workspace: ROOT,
  qualifyExecution: async pr=>({...fixtureProof(pr),...(typeof fetch.execution==='function'?await fetch.execution(pr):fetch.execution)}),
  authorizeOperation: async ({pr,env})=>{
    const current=await (await fetch.fetchImpl(`https://api.github.com/repos/${REPO}/pulls/${pr.number}`)).json();
    const mode=resolveMode({env,workspace:ROOT,readFile:fs.readFileSync});
    return {valid:current.state==='open' && current.head?.sha===pr.head.sha && current.draft===false,
      pr:current,mode,progress_ref:fetch.progress_ref};
  },...dependencies });
const writes = (fetch) => fetch.calls.filter((call) => call.method !== "GET" && !call.route.startsWith("rpc:") && !call.route.includes("access_tokens"));

test('Native PR binding discovers missing and contradictory claim trailers in the real scope',async()=>{
  for(const body of [`Clued-Auto-Merge: ${HEAD}`,`Clued-Work-Claim: ${HEAD_AUTH}\nClued-Work-Scope: global\nClued-Auto-Merge: ${HEAD}`]){
    const fetch=world({pulls:[pull({body})]});const result=await run(fetch);
    assert.deepEqual(result.heads,[{pr:5,head_sha:HEAD}]);
    assert.ok(fetch.calls.some(c=>c.input?.action==='resolve_pr_claim'&&c.input.read_only===true));
    assert.ok(fetch.calls.filter(c=>c.route===`rpc:${HOLDERS_RPC}`).every(c=>c.input.scope===SCOPE));
  }
});

test('unbound PRs never query a default global holder scope',async()=>{
  const fetch=world({extra:{'binding:resolve':body=>({...nativeBinding(pull()),binding_status:'unbound',task_id:null,claim:null,scope:null,
    head_authorization_id:null})}});
  const result=await run(fetch);assert.deepEqual(result.heads,[]);
  assert.equal(fetch.calls.some(c=>c.route===`rpc:${HOLDERS_RPC}`),false);
  assert.deepEqual(writes(fetch),[]);
});

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
    const held = world({ behindBy: 2, extra: checksRoute({ "kooyumi-admission-verified": [verified({ output: { title } })] }) });
    const outcome = await run(held);
    assert.deepEqual([writes(held), outcome.actions[0].action], [[], "none"], title);
  }
});

test("qualified clean current opted-in head uses normal match-head merge, without creating auto-merge",async()=>{
  const fetch=world();const result=await run(fetch);
  assert.deepEqual([result.actions[0].action,result.actions[0].result,result.actions[0].merge_status],["merge_pull_request","merged",200]);
  assert.deepEqual(writes(fetch).map(c=>[c.method,c.route,c.body]),[["PUT",`/repos/${REPO}/pulls/5/merge`,{merge_method:"merge",sha:HEAD}]]);
  assert.equal(fetch.calls.some(c=>c.route==="/graphql"),false);
});

test("an opt-in for an approved head covers later changes only where they equal the default branch", async () => {
  const body = `${BODY}
Clued-Auto-Merge: ${APPROVED}`;
  const files = (...names) => names.map((filename) => ({ filename, status: "modified" }));
  // compare/{approved}...{head}: what changed since the approval; compare/{tip}...{head}: where the head differs from main.
  const since = (list, behind = 0) => ({ [`/repos/${REPO}/compare/${APPROVED}...${HEAD}`]: { behind_by: behind, files: list } });
  const vsTip = (list) => ({ [`/repos/${REPO}/compare/${TIP}...${HEAD}`]: { behind_by: 0, ahead_by: 3, files: list } });
  let fetch = world({ pulls: [pull({ body })], extra: { ...since(files("README.md", "worker/a.ts")), ...vsTip(files("scripts/pr-change.mjs")) } });
  assert.equal((await run(fetch)).actions[0].action, "merge_pull_request", "only main's files changed since the approval");
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
  assert.deepEqual([writes(manual), (await run(manual)).actions[0].reason], [[], "manual auto-merge is not managed by this executor"]);
});

// Deliberately typed source-qualified execution fixtures. These tests exercise
// how the consumer handles them; arbitrary helper success cannot mint a proof.
const GATED = ".github/workflows/clued-components.yml";
const ciRuns = ({conclusion="success",status="completed",jobs=[["primary","success"]]}={}) => ({
  [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: {total_count:1,workflow_runs:[{id:700,path:GATED,head_sha:HEAD,event:"pull_request",status,conclusion}]},
  [PROOF]: {passed:status==="completed" && conclusion==="success" && jobs.some(([name,c])=>name!=="admission-gate"&&c==="success") && jobs.every(([,c])=>c==="success"||c==="skipped"),
    state:"qualified",reason:"qualified execution fixture"},
});
const mergeable = (status) => ({[`/repos/${REPO}/pulls/5`]:pull({mergeable_state:status})});
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
  assert.ok(fetch.calls.filter(call=>call.route===`/repos/${REPO}/pulls/5`).length>=2,"current native PR is revalidated before writes");

  assert.match(renderSummary(result), /\*\*merged\*\*/);
});

test("Task 114d43cf: a workflow without a gate passes with one twin run and the other skipped", async () => {
  const fetch = world({ extra: ciRuns({ jobs: [["gitleaks", "success"], ["gitleaks-hosted-skipped", "skipped"]] }) });
  assert.equal((await run(fetch)).actions[0].action, "merge_pull_request");
});

test("typed unknown, failed, skipped-primary and identity mismatches never enable or directly merge",async()=>{
  for(const proof of [{passed:false,state:"unknown"},{passed:false,state:"failed"},{passed:true,state:"unknown"},
    {passed:true,state:"qualified",head:APPROVED},{passed:true,state:"qualified",pr_number:6}]) {
    const fetch=world({extra:{...mergeable("clean"),[PROOF]:proof}});
    const result=await run(fetch);
    assert.equal(result.actions[0].action,"none");assert.deepEqual(writes(fetch),[]);
  }
  const fetch=world({extra:{...mergeable("unstable"),...ciRuns()}});
  const result=await run(fetch);
  assert.deepEqual([result.errors,result.actions[0].result,mergeCall(fetch)],[[],undefined,undefined]);
  assert.match(result.actions[0].reason,/not clean/);
});

test("GitHub refuses the merge: 405 and 409 stay mergeable_now with the reason; any other answer is merge_refused", async () => {
  for (const [code, message, expected] of [[405, 'Required status check "trivy" is expected.', "mergeable_now"],
    [409, "Head branch was modified. Review and try the merge again.", "mergeable_now"], [403, "Resource not accessible by integration", "merge_refused"]]) {
    const fetch = world({ extra: { ...mergeable("clean"), ...ciRuns(), [MERGE]: { __status: code, body: { message } } } });
    const result = await run(fetch);
    assert.deepEqual([result.errors, result.actions[0].result, result.actions[0].merge_status, result.actions[0].error],
      [[], expected, code, `merge refused: ${message}`], String(code));
    assert.match(result.notices[0], /merge_pull_request was refused: merge refused/);
  }
});

test("managed cleanup refusal prevents proof, Clued reads and merge",async()=>{
  const fetch=world({pulls:[pull({auto_merge:{merge_method:"merge"}})],extra:{"POST /graphql":{errors:[{message:"refused"}]}}});
  let proofs=0;const result=await run(fetch,{}, {qualifyExecution:async()=>{proofs++;throw Error("must not call")}});
  assert.equal(proofs,0);assert.equal(fetch.calls.some(c=>c.route.startsWith("rpc:")),false);
  assert.equal(mergeCall(fetch),undefined);assert.match(result.actions[0].error,/did not confirm/);
});

test("nothing is written unless every condition holds", async () => {
  const cases = [
    ["not opted in", { pulls: [pull({ body: BODY })] }, /did not opt in/],
    ["CI failed", { extra: checksRoute({ gitleaks: [check("gitleaks", { conclusion: "failure", completed_at: "2026-10-09T11:00:00Z" })] }) }, /CI failed/],
    ["not admitted", { extra: checksRoute({ "kooyumi-admission-verified": [verified({ conclusion: "failure" })] }) }, /has not admitted/],
    ["admitted for another pull request (review MINOR-2)", { extra: checksRoute({ "kooyumi-admission-verified": [verified({ external_id: "pr:6:run:901" })] }) }, /has not admitted/],
    ["no mode in the title", { extra: checksRoute({ "kooyumi-admission-verified": [verified({ output: { title: "ADMITTED" } })] }) }, /has not admitted/],
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
  const protectedCheck = { extra: checksRoute({ "kooyumi-admission-verified": [verified({ output: { title: "ADMITTED [normal · protected · reruns 0]" } })] }) };
  for (const retired of [undefined, "", "false"]) {
    const fetch = world(protectedCheck);
    const result = await run(fetch, retired === undefined ? {} : { CLUED_OWNER_REVIEW_ENFORCE: retired });
    assert.equal(result.actions[0].action, "merge_pull_request", String(retired));
  }
});

test("frozen refuses new work while disabling executor-managed auto-merge",async()=>{
  const fetch=world({behindBy:1});const result=await run(fetch,{CLUED_MERGE_ADMISSION_STATE:"frozen"});
  assert.equal(result.state,"frozen");assert.deepEqual(writes(fetch),[]);
  const managed=world({pulls:[pull({auto_merge:{merge_method:"merge"}})]});
  assert.equal((await run(managed,{CLUED_MERGE_ADMISSION_STATE:"frozen"})).actions[0].action,"disable_auto_merge");
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

test("only the default branch's queue head and an open same-repository non-draft Native-bound PR is acted on", async () => {
  for (const [name, options] of [
    ["another branch's queue", { holders: [{ claim_id: CLAIM, task_id:CLAIM, bound_pr: `${REPO}#5`, bound_prs:[`${REPO}#5`], merge_refs: [`merge:${REPO}:release`] }] }],
    ["a pull request not open", { pulls: [] }],
    ["a fork", { pulls: [pull({ head: { sha: HEAD, repo: { full_name: "someone/fork" } } })] }],
    ["a draft", { pulls: [pull({ draft: true })] }],
    ["no current Native PR binding", { pulls: [pull({ body: `Clued-Auto-Merge: ${HEAD}` })],extra:{'binding:resolve':{
      ...nativeBinding(pull()),binding_status:'unbound',scope:null,task_id:null,claim:null,head_authorization_id:null}} }],
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

test("the independent executor uses actions write for full reruns and otherwise read-only workflow permissions", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-merge-executor.yml"), "utf8");
  assert.match(text, /on:\n  # [^\n]*\n  push:\n    branches: \[main\]\n  workflow_dispatch:\n/);
  assert.doesNotMatch(text, /^  workflow_run:/m, "slot reports execute inline, without another hosted run");
  assert.doesNotMatch(text, /^  schedule:/m, "executor recovery is event driven, not another hourly hosted run");
  assert.doesNotMatch(text, /pull_request/);
  assert.match(text, /permissions:\n(?:  #[^\n]*\n)?  actions: write\n  checks: read\n  contents: read\n  pull-requests: read\n\n/);
  assert.deepEqual(text.match(/^\s+[a-z-]+: write$/gm), ['  actions: write']);
  assert.match(text, /name: clued-merge-executor\n    runs-on: ubuntu-slim\n    timeout-minutes: 10\n    environment: clued-admission\n/);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}\n          persist-credentials: false/);
  assert.doesNotMatch(text, /_ENFORCE/);
});

test("claim renewal opts in only a full matching head of a non-protected layer", async () => {
  for (const [layer, progress, expected] of [['code', HEAD, 'merge_pull_request'], ['docs', HEAD.toUpperCase(), 'merge_pull_request'],
    ['protected', HEAD, 'none'], ['code', HEAD.slice(0, 12), 'none'], ['code', APPROVED, 'none'], ['code', `receipt:${HEAD}`, 'none']]) {
    const fetch = world({ pulls: [pull({ body: BODY })],
      holders: [{ claim_id: CLAIM, task_id:CLAIM, bound_pr: `${REPO}#5`, bound_prs:[`${REPO}#5`], merge_refs: [SLOT], progress_ref: progress }],
      extra: checksRoute({ 'kooyumi-admission-verified': [verified({ output: { title: `ADMITTED [normal · ${layer} · reruns 1]` } })] }) });
    const result = await run(fetch);
    assert.equal(result.actions[0].action, expected, `${layer}: ${progress}`);
    if (expected === 'merge_pull_request') assert.match(result.actions[0].reason, new RegExp(`opted in by the claim renewal at ${HEAD}`));
  }
});

const gateOnlyRun = (extra = {}) => ({ id: 700, path: `${GATED}@refs/pull/5/merge`, head_sha: HEAD,
  event: 'pull_request', status: 'completed', conclusion: 'success', run_attempt: 1, ...extra });
const rerunWorld = ({ attempt = 1, limit = 1, admitted = true, jobs = [['admission-gate', 'success'], ['clued-components', 'skipped']],
  runs, currentHead = HEAD, currentAttempt = attempt, extra = {} } = {}) => world({
  pulls: [pull({ body: BODY })], extra: {
    ...checksRoute({ 'kooyumi-admission-verified': [verified({ conclusion: admitted ? 'success' : 'failure',
      output: { title: `${admitted ? 'ADMITTED' : 'REJECTED'} [normal · code · reruns ${limit}]` } })] }),
    [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]: { total_count:(runs ?? [0]).length,workflow_runs: runs ?? [gateOnlyRun({ run_attempt: attempt })] },
    [PROOF]:{passed:false,state:"unknown",reason:"qualified gate-only recovery",rerun:{id:700,run_attempt:attempt,path:GATED}},
    [`/repos/${REPO}/actions/runs/700/jobs`]: { jobs: jobs.map(([name, conclusion]) => ({ name, conclusion })) },
    [`/repos/${REPO}/pulls/5`]: { ...pull(), state: 'open', head: { sha: currentHead } },
    [`/repos/${REPO}/actions/runs/700`]: gateOnlyRun({ run_attempt: currentAttempt }),
    [`POST /repos/${REPO}/actions/runs/700/rerun`]: { __status: 201, body: {} },
    ...extra,
  },
});

test("an admitted gate-only run is rerun with all jobs once using GITHUB_TOKEN, with no App token or merge opt-in", async () => {
  const fetch = rerunWorld();
  const result = await run(fetch, { CLUED_ADMISSION_APP_ID: '', CLUED_ADMISSION_APP_PRIVATE_KEY: '' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual([result.actions[0].action, result.actions[0].run_id, result.actions[0].status], ['rerun_gated', 700, 201]);
  assert.deepEqual(writes(fetch).map((c) => [c.method, c.route, c.authorization, c.body]),
    [['POST', `/repos/${REPO}/actions/runs/700/rerun`, 'Bearer t', null]]);
  assert.equal(fetch.calls.some((c) => c.route.includes('access_tokens')), false);
});

test("unqualified recovery cannot rerun",async()=>{
  for(const proof of [{passed:false,state:"unknown"},{passed:false,state:"failed"},
    {passed:false,state:"unknown",head:APPROVED,rerun:{id:700,run_attempt:1,path:GATED}}]) {
    const fetch=rerunWorld({extra:{[PROOF]:proof}});
    assert.notEqual((await run(fetch)).actions[0].action,"rerun_gated");assert.deepEqual(writes(fetch),[]);
  }
});

test("reruns are bounded by admission, attempt metadata and the one automatic retry", async () => {
  for (const options of [{ admitted: false }, { limit: 0 }, { attempt: 2 }, { attempt: 2, limit: 2 }, { attempt: undefined }, { attempt: '1' }]) {
    if (options.attempt === undefined && 'attempt' in options) options.attempt = null;
    const fetch = rerunWorld(options);
    assert.equal((await run(fetch)).actions[0].action, 'none', JSON.stringify(options));
    assert.deepEqual(writes(fetch), []);
  }
});

test("a newer run, a moved PR head or a changed attempt prevents rerunning the stale run", async () => {
  for (const options of [{ currentHead: APPROVED }, { currentAttempt: 2 },
    { extra:{[PROOF]:{passed:false,state:"unknown",reason:"newer run"}} }]) {
    const fetch = rerunWorld(options);
    assert.equal((await run(fetch)).actions[0].action, 'none', JSON.stringify(options));
    assert.deepEqual(writes(fetch), []);
  }
});

test("a rerun refusal is reported without merging or requesting App actions permissions", async () => {
  const fetch = rerunWorld({ extra: { [`POST /repos/${REPO}/actions/runs/700/rerun`]: { __status: 403, body: { message: 'Resource not accessible' } } } });
  const result = await run(fetch);
  assert.match(result.notices[0], /rerun_gated was refused/);
  assert.equal(result.actions[0].status, 403);
  assert.equal(writes(fetch).length, 1);
});

test("execution becomes unknown after planning: no rerun",async()=>{
  let reads=0;const fetch=rerunWorld({extra:{[PROOF]:()=>++reads===1?{passed:false,state:"unknown",rerun:{id:700,run_attempt:1,path:GATED}}:{passed:false,state:"unknown"}}});
  assert.equal((await run(fetch)).actions[0].action,"none");assert.deepEqual(writes(fetch),[]);
});

// Production authority reader: native PR/default-tip, current claim verifier,
// queue and App observation, with no execution proof in the ADMITTED evaluator.
function authorityWorld(extra={}) {
  const current=pull({changed_files:1,base:{ref:"main",sha:TIP,repo:{default_branch:"main",full_name:REPO}}});
  const fetch=world({pulls:[current],extra:{
    ...checksRoute({"kooyumi-admission-verified":[verified({output:{title:"ADMITTED [normal · docs · reruns 2]"}})]}),
    [`/repos/${REPO}/pulls/5/files`]:[{filename:"README.md",status:"modified"}],
    [`/repos/${REPO}/compare/${TIP}...${HEAD}`]:{status:"ahead",files:[{filename:"README.md",status:"modified"}]},
    [`rpc:${VERIFY_RPC}`]:{status:'ok',verdict:"ADMITTED",reasons:[],execution_authorized:true,execution_policy:'staged',
      current_fence:3,execution_epoch:1,head_authorization_id:HEAD_AUTH,verified_at:"2026-10-10T20:00:00Z",
      claim:{...nativeBinding(current).claim,lease_key_required:false,trigger_refs:[SLOT],merge_slot_until:"2099-01-01T00:00:00Z"}},...extra}});
  return {fetch,current};
}
test("real live authority reader admits the current claimed FIFO head and rejects withdrawal",async()=>{
  for(const revoked of [false,true]) {
    const {fetch,current}=authorityWorld(revoked?{[`rpc:${VERIFY_RPC}`]:{verdict:"REJECTED",reasons:["claim_revoked"]}}:{});
    const result=await currentOperationAuthority({env:env(),fetchImpl:fetch.fetchImpl,workspace:ROOT,
      readPolicyFile:fs.readFileSync,repository:REPO,pr:current,tip:TIP,scope:SCOPE,expectedBinding:nativeBinding(current),action:"merge_pull_request"});
    assert.equal(result.valid,!revoked);assert.deepEqual(writes(fetch),[]);
    assert.ok(fetch.calls.some(c=>c.route===`rpc:${VERIFY_RPC}`));
  }
});

test('a planned Native binding rejects Task claim generation and private head-key changes before an old operation',async()=>{
  const other='33333333-3333-4333-8333-333333333333';
  for(const field of ['task','claim','fence','epoch','head-key']){
    const current=pull(),expected=nativeBinding(current),fresh=structuredClone(expected);
    if(field==='task'){fresh.task_id=other;fresh.claim.task_id=other;}
    if(field==='claim')fresh.claim.claim_id=other;
    if(field==='fence')fresh.claim.fence++;
    if(field==='epoch')fresh.claim.execution_epoch++;
    if(field==='head-key')fresh.head_authorization_id=other;
    const {fetch}=authorityWorld({'binding:resolve':fresh});
    const r=await currentOperationAuthority({env:env(),fetchImpl:fetch.fetchImpl,workspace:ROOT,readPolicyFile:fs.readFileSync,
      repository:REPO,pr:current,tip:TIP,scope:SCOPE,expectedBinding:expected,action:'update_branch'});
    assert.equal(r.valid,false,field);assert.deepEqual(writes(fetch),[]);
  }
});

test('one Task with two authorized PRs plans one stable front and retains the same expected binding through rechecks',async()=>{
  const second=pull({number:6,node_id:'PR_node6'}),seen=[];
  const fetch=world({pulls:[second,pull()],holders:[{claim_id:CLAIM,task_id:CLAIM,bound_pr:null,bound_prs:[`${REPO}#6`,`${REPO}#5`],
    merge_refs:[SLOT],merge_slot_until:'2099-01-01T00:00:00Z',merge_slot_ci:{taken_at:'2026-10-09T10:00:00Z'}}]});
  const result=await run(fetch,{}, {authorizeOperation:async({pr,env:environment,expectedBinding})=>{
    assert.equal(expectedBinding.pr_number,5);seen.push(expectedBinding);
    return {valid:true,pr,mode:resolveMode({env:environment,workspace:ROOT,readFile:fs.readFileSync}),progress_ref:fetch.progress_ref};
  }});
  assert.deepEqual(result.heads,[{pr:5,head_sha:HEAD}]);assert.ok(seen.length>=2);assert.ok(seen.every(b=>b===seen[0]));
});
test("the real production qualifier refuses fixture head/source; required greens do not mint execution proof",async()=>{
  const fetch=world();const result=await runExecutor({env:env(),fetchImpl:fetch.fetchImpl,workspace:ROOT});
  assert.equal(result.actions[0].action,"none");assert.deepEqual(writes(fetch),[]);
});
test("live authority is checked after qualification and before enable, direct merge and rerun",async()=>{
  for(const type of ["enable","direct","rerun"]){
    const fetch=type==="rerun"?rerunWorld():world({extra:type==="direct"?mergeable("clean"): {}});
    let checks=0;
    const result=await run(fetch,{}, {authorizeOperation:async ({pr,env})=>({valid:++checks<2,pr,
      mode:resolveMode({env,workspace:ROOT,readFile:fs.readFileSync}),progress_ref:fetch.progress_ref})});
    assert.equal(mergeCall(fetch),undefined);assert.equal(writes(fetch).filter(c=>c.route.endsWith("/rerun")).length,0);
    if(type!=="direct")assert.deepEqual(writes(fetch),[]);
    assert.ok(result.actions.length);
  }
});
test("managed auto already on loses eligibility: unknown source, expired slot and revoked permission turn it off",async()=>{
  for(const [options,dependencies] of [
    [{extra:{[PROOF]:{passed:false,state:"unknown",reason:"unregistered source"}}},{}],
    [{holders:[]},{}],
    [{},{authorizeOperation:async()=>({valid:false})}],
    [{pulls:[pull({body:"no claim",auto_merge:{enabled_by:{login:"clued-admission[bot]"}}})]},{}],
    [{pulls:[pull({draft:true,auto_merge:{merge_method:"merge"}})]},{}],
  ]) {
    const fetch=world({pulls:[pull({auto_merge:{merge_method:"merge"}})],...options});
    const result=await run(fetch,{},dependencies);
    assert.equal(result.actions[0].action,"disable_auto_merge");
    assert.equal(writes(fetch).length,1);assert.match(writes(fetch)[0].body.query,/disablePullRequestAutoMerge/);
  }
});
test("manual non-opted auto remains untouched even when claim leaves the queue",async()=>{
  const fetch=world({holders:[],pulls:[pull({body:BODY,auto_merge:{enabled_by:{login:"tdoljyj"}}})]});
  assert.deepEqual((await run(fetch)).actions,[]);assert.deepEqual(writes(fetch),[]);
});

test("final native barrier after authority refuses newer run, changed attempt, new active run or required failure",async()=>{
  for(const change of ["newer","attempt","active","required"]){
    let changed=false,authorizations=0;
    const row={id:700,path:GATED,head_sha:HEAD,event:"pull_request",run_attempt:1,status:"completed",conclusion:"success",pull_requests:[{number:5}]};
    const observed={...row,pull_requests:[5]};
    const fetch=world({extra:{
      [PROOF]:{native_runs:[observed]},
      [`/repos/${REPO}/actions/runs/700`]:()=>({...row,run_attempt:changed&&change==="attempt"?2:1}),
      [`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:()=>{
        const rows=changed&&["newer","active"].includes(change)?[row,{...row,id:701,
          status:change==="active"?"queued":"completed"}]:[row];
        return {total_count:rows.length,workflow_runs:rows};
      },
      [`/repos/${REPO}/commits/${HEAD}/check-runs?check_name=trivy&`]:()=>({check_runs:[check("trivy",{conclusion:changed&&change==="required"?"failure":"success"})]}),
    }});
    const result=await run(fetch,{}, {authorizeOperation:async({pr,env})=>{
      if(++authorizations===2)changed=true;
      return {valid:true,pr,mode:resolveMode({env,workspace:ROOT,readFile:fs.readFileSync}),progress_ref:fetch.progress_ref};
    }});
    assert.equal(result.actions[0].action,"none",change);assert.deepEqual(writes(fetch),[],change);
  }
});
test("production live authority retains efficiency's actual FIFO holder",async()=>{
  const {fetch,current}=authorityWorld(checksRoute({"kooyumi-admission-verified":[verified({output:{title:"ADMITTED [efficiency · docs · reruns 2]"}})]}));
  const result=await currentOperationAuthority({env:env({CLUED_MERGE_ADMISSION_STATE:"efficiency"}),fetchImpl:fetch.fetchImpl,workspace:ROOT,
    readPolicyFile:fs.readFileSync,repository:REPO,pr:current,tip:TIP,scope:SCOPE,expectedBinding:nativeBinding(current),action:"merge_pull_request"});
  assert.equal(result.valid,true);assert.deepEqual(writes(fetch),[]);
});

test("a stale App layer or retry limit does not describe the current policy",async()=>{
  for(const title of ["ADMITTED [normal · code · reruns 1]","ADMITTED [normal · docs · reruns 1]"]) {
    const {fetch,current}=authorityWorld(checksRoute({"kooyumi-admission-verified":[verified({output:{title}})]}));
    const result=await currentOperationAuthority({env:env(),fetchImpl:fetch.fetchImpl,workspace:ROOT,
      readPolicyFile:fs.readFileSync,repository:REPO,pr:current,tip:TIP,scope:SCOPE,expectedBinding:nativeBinding(current),action:"rerun_gated"});
    assert.equal(result.valid,false,title);assert.deepEqual(writes(fetch),[]);
  }
});
test("cleanup with withdrawn opt-in, empty claim or missing Clued token never starts slow qualification",async()=>{
  for(const body of [BODY,"",`${BODY}\nClued-Auto-Merge: ${HEAD}`]) {
    const fetch=world({pulls:[pull({body,auto_merge:{enabled_by:{login:"clued-admission[bot]"}}})]});
    let proofs=0;const result=await run(fetch,{CLUED_CONTEXT_READ_TOKEN:""},{qualifyExecution:async()=>{proofs++;throw Error("must not call")}});
    assert.equal(proofs,0);assert.equal(result.actions[0].action,"disable_auto_merge");
    assert.equal(fetch.calls.some(c=>c.route.startsWith("rpc:")),false);
  }
});

test("final Native PR binding refuses body/opt-in withdrawal, new auto request, non-clean state and retargeting",async()=>{
  for(const mutation of [pr=>({...pr,body:BODY}),pr=>({...pr,body:""}),
    pr=>({...pr,auto_merge:{enabled_by:{login:"tdoljyj"}}}),pr=>({...pr,mergeable_state:"unstable"}),
    pr=>({...pr,base:{...pr.base,repo:{...pr.base.repo,default_branch:"release"}}})]) {
    let lastNative=false;
    const fetch=world({extra:{[`/repos/${REPO}/pulls/5`]:()=>{
      const pr=pull();return lastNative?mutation(pr):pr;
    }}});
    let authorities=0;
    const result=await run(fetch,{}, {authorizeOperation:async({pr,env})=>{
      const current=pull();if(++authorities===2)lastNative=true;
      return {valid:true,pr:current,mode:resolveMode({env,workspace:ROOT,readFile:fs.readFileSync}),progress_ref:fetch.progress_ref};
    }});
    assert.equal(result.actions[0].action,"none");assert.deepEqual(writes(fetch),[]);
  }
});

test('explicit uncounted active CI waits without qualification; missing checks still permit qualified gate-only recovery',async()=>{
  const active={id:701,path:'.github/workflows/unregistered.yml',head_sha:HEAD,event:'pull_request',status:'queued',conclusion:null};
  let proofs=0;
  const busy=world({extra:{[`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:{total_count:1,workflow_runs:[active]}}});
  const waited=await run(busy,{}, {qualifyExecution:async()=>{proofs++;throw Error('must not qualify while explicitly active');}});
  assert.equal(proofs,0);assert.equal(waited.actions[0].action,'none');assert.match(waited.actions[0].reason,/active CI/);
  assert.deepEqual(writes(busy),[]);
  const behind=world({behindBy:2,extra:{[`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:{total_count:1,workflow_runs:[active]}}});
  assert.equal((await run(behind,{}, {qualifyExecution:async()=>{throw Error('update must stay before qualification');}})).actions[0].action,'update_branch');
  // Missing required check is idle, not the new active-wait branch. The existing
  // recovery planner still runs; its final barrier refuses until required checks arrive.
  const recovering=rerunWorld({extra:checksRoute({trivy:[]})});
  let recoverProofs=0;
  const observed=await run(recovering,{}, {qualifyExecution:async pr=>{
    recoverProofs++; return {...fixtureProof(pr),passed:false,state:'unknown',rerun:{id:700,run_attempt:1,path:GATED}};
  }});
  assert.ok(recoverProofs>0);assert.equal(observed.actions[0].action,'none');assert.deepEqual(writes(recovering),[]);
  // Without an active run, the usual successful one-all-jobs recovery is unchanged.
  assert.equal((await run(rerunWorld())).actions[0].action,'rerun_gated');
});
test('partial active listings never enable an operation or manufacture a clean head',async()=>{
  const fetch=world({extra:{[`/repos/${REPO}/actions/runs?head_sha=${HEAD}`]:{total_count:2,workflow_runs:[]}}});
  let proofs=0;const result=await run(fetch,{}, {qualifyExecution:async()=>{proofs++;return fixtureProof(pull());}});
  assert.equal(proofs,0);assert.deepEqual(writes(fetch),[]);assert.match(result.errors[0],/incomplete workflow_runs snapshot/);
});

// --- Design A2: the executor counts the branch rules' actual sources.
const J64 = (digit) => digit.repeat(64);
const independentCheck = (name, extra = {}) => ({ id: 500 + REQUIRED_NAMES.indexOf(name), name, head_sha: HEAD, status: "completed", conclusion: "success",
  external_id: name === "kooyumi-admission-verified" ? `independent-ci:control:control-admission:${J64("1")}:f9:e1:a1`
    : name === "kooyumi-work-admission" ? `independent-ci:native-work-admission:${J64("3")}:f9:e1:a1` : `independent-ci:staged:${J64("4")}:f9:e1:a1`,
  app: { id: 5368905 }, output: { title: "Complete Native control and exact subject verified",
    summary: `Independent Native control check for ${REPO}#5; observation sha256 ${J64("5")}.` }, ...extra });
const independentChecks = (overrides = {}) => checksRoute({ ...Object.fromEntries(REQUIRED_NAMES.filter((name) => name !== "kooyumi-merge-slot")
  .map((name) => [name, [independentCheck(name)]])), ...overrides });
const LIVE_MODE = { state: "normal", layer: "code", reruns_per_head: 1 };

test("A2: under rules on App 5368905 an independent admission check admits with the live evaluation's mode, and the head merges", async () => {
  const fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...independentChecks(), ...mergeable("clean"), ...ciRuns(),
    [MERGE]: { __status: 200, body: { merged: true, sha: "c".repeat(40) } } } });
  const asked = [];
  const result = await run(fetch, {}, { admissionMode: async (pr) => { asked.push(pr.head.sha); return LIVE_MODE; } });
  assert.deepEqual([result.errors, result.actions[0].action, result.actions[0].result], [[], "merge_pull_request", "merged"]);
  assert.ok(asked.length >= 1 && asked.every((sha) => sha === HEAD));
  assert.ok(fetch.calls.some((call) => call.route.startsWith(`/repos/${REPO}/rules/branches/main`)));
  assert.equal(fetch.calls.some((call) => call.route.includes("check-runs?check_name=kooyumi-admission-verified") && call.route.includes("&per_page=100")), true);
});

test("A2: no live mode, a legacy source or an unbound independent check never admits under the 5368905 rules", async () => {
  for (const [label, extra, admissionMode] of [
    ["no live mode", independentChecks(), async () => null],
    ["clued-admission App check only", independentChecks({ "kooyumi-admission-verified": [verified()] }), async () => LIVE_MODE],
    ["admission-run external id", independentChecks({ "kooyumi-admission-verified": [independentCheck("kooyumi-admission-verified", { external_id: "pr:5:run:900" })] }), async () => LIVE_MODE],
    ["another pull request's control check", independentChecks({ "kooyumi-admission-verified": [independentCheck("kooyumi-admission-verified",
      { output: { summary: `Independent Native control check for ${REPO}#6; x` } })] }), async () => LIVE_MODE],
    ["another head", independentChecks({ "kooyumi-admission-verified": [independentCheck("kooyumi-admission-verified", { head_sha: APPROVED })] }), async () => LIVE_MODE],
  ]) {
    const fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...extra, ...mergeable("clean"), ...ciRuns() } });
    const result = await run(fetch, {}, { admissionMode });
    assert.equal(result.actions[0].action, "none", label);
    assert.match(result.actions[0].reason, /kooyumi-admission-verified check for this pull request has not admitted it/, label);
    assert.deepEqual(writes(fetch), [], label);
  }
  // Unreadable rules: nothing is planned or written.
  const fetch = world({ extra: { [`/repos/${REPO}/rules/branches/main`]: { __status: 403, body: { message: "Forbidden" } }, ...mergeable("clean"), ...ciRuns() } });
  const result = await run(fetch);
  assert.match(result.errors[0], /^#5: GitHub API \/repos\/.*\/rules\/branches\/main.* returned 403/);
  assert.deepEqual([result.actions, writes(fetch)], [[], []]);
});

test("A2: a hosted executor workflow's failure is not CI under the 5368905 rules; under Actions rules it still is", async () => {
  const proof = { [PROOF]: { passed: false, state: "failed", reason: ".github/workflows/trivy.yml: qualified workflow failed" } };
  let fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...independentChecks(), ...mergeable("clean"), ...proof } });
  let result = await run(fetch, {}, { admissionMode: async () => LIVE_MODE });
  assert.equal(result.actions[0].action, "none");
  assert.match(result.actions[0].reason, /^waiting for CI execution on this head: \.github\/workflows\/trivy\.yml: qualified workflow failed/);
  assert.deepEqual(writes(fetch), []);
  fetch = world({ extra: { ...mergeable("clean"), ...proof } });
  result = await run(fetch);
  assert.match(result.actions[0].reason, /^CI failed: \.github\/workflows\/trivy\.yml: qualified workflow failed/);
  // A 5368905 final failure stops the merge as CI failed.
  fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...independentChecks({ gitleaks: [independentCheck("gitleaks", { conclusion: "failure" })] }), ...mergeable("clean"), ...ciRuns() } });
  result = await run(fetch, {}, { admissionMode: async () => LIVE_MODE });
  assert.deepEqual([result.actions[0].action, result.actions[0].reason, writes(fetch)], ["none", "CI failed: gitleaks concluded failure", []]);
});

test("A2: the live authority reader accepts an independent admission check by its live evaluation, never a legacy or unbound one", async () => {
  for (const [label, checks, valid] of [
    ["independent", { "kooyumi-admission-verified": [independentCheck("kooyumi-admission-verified")] }, true],
    ["legacy App under 5368905 rules", { "kooyumi-admission-verified": [verified({ output: { title: "ADMITTED [normal · docs · reruns 2]" } })] }, false],
    ["unbound independent", { "kooyumi-admission-verified": [independentCheck("kooyumi-admission-verified", { external_id: "independent-ci:control:control-admission:x" })] }, false],
  ]) {
    const { fetch, current } = authorityWorld({ ...rulesRoute(INDEPENDENT_RULES), ...checksRoute(checks) });
    const result = await currentOperationAuthority({ env: env(), fetchImpl: fetch.fetchImpl, workspace: ROOT,
      readPolicyFile: fs.readFileSync, repository: REPO, pr: current, tip: TIP, scope: SCOPE, expectedBinding:nativeBinding(current), action: "merge_pull_request" });
    assert.equal(result.valid, valid, label); assert.deepEqual(writes(fetch), [], label);
  }
});

// --- Source v2 external ids in the executor (src/job-v2.mjs).
const V2J = "6".repeat(64);
const v2Check = (name, extra = {}) => independentCheck(name, { external_id: name === "kooyumi-admission-verified"
  ? `independent-ci:control:control-admission:v2:${V2J}:a2:cd1dd735d:f3:e2`
  : name === "kooyumi-work-admission" ? `independent-ci:native-work-admission:v2:${V2J}:a1:cd1dd735d:f3:e2`
    : `independent-ci:staged:v2:${V2J}:a1`, ...extra });
const v2Checks = (overrides = {}) => checksRoute({ ...Object.fromEntries(REQUIRED_NAMES.filter((name) => name !== "kooyumi-merge-slot")
  .map((name) => [name, [v2Check(name)]])), ...overrides });

test("A2 v2: Source v2 admission and scanner checks admit and merge; malformed or foreign v2 ids never do", async () => {
  let fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...v2Checks(), ...mergeable("clean"), ...ciRuns(),
    [MERGE]: { __status: 200, body: { merged: true, sha: "c".repeat(40) } } } });
  let result = await run(fetch, {}, { admissionMode: async () => LIVE_MODE });
  assert.deepEqual([result.errors, result.actions[0].action, result.actions[0].result], [[], "merge_pull_request", "merged"]);
  for (const [label, externalId] of [
    ["attempt 3", `independent-ci:control:control-admission:v2:${V2J}:a3:cd1dd735d:f3:e2`],
    ["no claim generation", `independent-ci:control:control-admission:v2:${V2J}:a1`],
    ["the merge-slot role", `independent-ci:control:control-merge-slot:v2:${V2J}:a1:cd1dd735d:f3:e2`],
    ["a staged v2 id", `independent-ci:staged:v2:${V2J}:a1`],
    ["a native v2 id", `independent-ci:native-work-admission:v2:${V2J}:a1:cd1dd735d:f3:e2`],
    ["a trailing field", `independent-ci:control:control-admission:v2:${V2J}:a1:cd1dd735d:f3:e2:x`],
  ]) {
    fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...v2Checks({ "kooyumi-admission-verified": [v2Check("kooyumi-admission-verified", { external_id: externalId })] }),
      ...mergeable("clean"), ...ciRuns() } });
    result = await run(fetch, {}, { admissionMode: async () => LIVE_MODE });
    assert.equal(result.actions[0].action, "none", label);
    assert.match(result.actions[0].reason, /has not admitted it/, label);
    assert.deepEqual(writes(fetch), [], label);
  }
  // A malformed v2 scanner id is not the required check: no merge.
  fetch = world({ extra: { ...rulesRoute(INDEPENDENT_RULES), ...v2Checks({ trivy: [v2Check("trivy", { external_id: `independent-ci:staged:v2:${V2J}:a1:cd1dd735d:f3:e2` })] }),
    ...mergeable("clean"), ...ciRuns() } });
  result = await run(fetch, {}, { admissionMode: async () => LIVE_MODE });
  assert.equal(mergeCall(fetch), undefined);
  assert.notEqual(result.actions[0].action, "merge_pull_request");
});
