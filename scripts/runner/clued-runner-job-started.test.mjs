import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { ADMISSION_APP_ID as ADMISSION_APP, DISPATCH_GATED_WORKFLOWS as ADMISSION_DISPATCH_GATED, resolvePublicSupabaseConfig } from "../ci/clued-work-admission.mjs";
import { ADMISSION_APP_ID, DISPATCH_GATED_WORKFLOWS, HOOK_VERSION, COMPONENT_VERSION, OBSERVATION_ATTEMPT_MS, READ_ALLOWANCE_MS, READ_ATTEMPTS, READ_ATTEMPT_MS, READ_RETRY_DELAYS_MS, decide, decideWithCurrentEpoch, main, proxyBootstrapArguments, retryingFetch, shortCheckFindings, waitLimitSeconds, workflowPathOf } from "./clued-runner-job-started.mjs";
import { workflowIsGated } from "../ci/clued-work-admission.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
// A real pull request event names both repositories; a same-repository pull request by default (04f9b91b 题 1).
const prEvent = (base = "main", headRepo = { full_name: "o/r" }) => JSON.stringify({ pull_request: { number: 9,
  base: { ref: base, repo: { full_name: "o/r" } }, head: { sha: HEAD, ...(headRepo === "absent" ? {} : { repo: headRepo }) } } });

test('bors staging: only the required-tests workflow pushed by App 5368905 may be considered off main', async () => {
  const staging = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/clued-train/staging',
    GITHUB_ACTOR: 'clued-ci-checks-turing-20261018[bot]',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-required-tests.yml@refs/heads/clued-train/staging' };
  const check = overrides => decide({ env: env({ ...staging, ...overrides }),
    fetchImpl: async () => { throw Error('staging admission must not need a credential or network read'); },
    readFile: () => { throw Error('staging admission must not read credentials'); } });
  for (const changed of [
    { GITHUB_ACTOR: 'o' }, { GITHUB_ACTOR: 'clued-admission[bot]' }, { GITHUB_ACTOR: '' },
    { GITHUB_REF: 'refs/heads/clued-train/staging.tmp' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/other.yml@refs/heads/clued-train/staging' },
    { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REPOSITORY: 'other/repo' },
    ...[{ GITHUB_ACTOR: 'o' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'schedule' }].map(change => ({ ...change,
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-required-tests-windows.yml@refs/heads/clued-train/staging' })),
  ]) assert.equal((await check(changed)).allow, false, JSON.stringify(changed));
});

const proxyRuntime = overrides => ({ env: {}, execArgv: [], argv: ["node", "/protected/hook.mjs"],
  allowedFlags: new Set(["--use-env-proxy"]), ...overrides });
test("proxy bootstrap: no proxy uses the existing process; an established proxy enables native routing without putting its URL in arguments", () => {
  assert.equal(proxyBootstrapArguments(proxyRuntime()), null);
  const environment = { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost", CLUED_RUNNER_HOOK_ENFORCE: "true" };
  const before = { ...environment };
  assert.deepEqual(proxyBootstrapArguments(proxyRuntime({ env: environment, execArgv: ["--use-bundled-ca"] })),
    ["--use-bundled-ca", "--use-env-proxy", "/protected/hook.mjs"]);
  assert.deepEqual(environment, before);
});
test("proxy bootstrap: an enabled child does not fork again, including the existing environment and NODE_OPTIONS forms", () => {
  const env = { https_proxy: "http://proxy.example:8080" };
  assert.equal(proxyBootstrapArguments(proxyRuntime({ env, execArgv: ["--use-env-proxy"] })), null);
  assert.equal(proxyBootstrapArguments(proxyRuntime({ env: { ...env, NODE_USE_ENV_PROXY: "1" } })), null);
  assert.equal(proxyBootstrapArguments(proxyRuntime({ env: { ...env, NODE_OPTIONS: "--use-bundled-ca --use-env-proxy" } })), null);
});
test("proxy bootstrap: an unsupported runtime or explicit opt-out refuses before credential and network work", () => {
  const env = { HTTP_PROXY: "http://proxy.example:8080" };
  assert.throws(() => proxyBootstrapArguments(proxyRuntime({ env, allowedFlags: new Set() })), /runtime cannot use/);
  assert.throws(() => proxyBootstrapArguments(proxyRuntime({ env: { ...env, NODE_USE_ENV_PROXY: "0" } })), /explicitly disabled/);
  assert.throws(() => proxyBootstrapArguments(proxyRuntime({ env, execArgv: ["--no-use-env-proxy"] })), /explicitly disabled/);
});
test("proxy bootstrap: bad proxy values fail without exposing the supplied value", () => {
  for (const value of ["invalid-secret-value", "socks5://proxy.example:1080"]) {
    assert.throws(() => proxyBootstrapArguments(proxyRuntime({ env: { HTTP_PROXY: value } })), error =>
      !error.message.includes(value) && /configured HTTP proxy/.test(error.message));
  }
});
test("proxy bootstrap CLI: the child preserves ALLOW/REFUSE and exits without a re-execution loop", () => {
  const script = fileURLToPath(new URL("./clued-runner-job-started.mjs", import.meta.url));
  const source = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
    CLUED_RUNNER_HOOK_ENFORCE: "true", CLUED_RUNNER_HOOK_REPOSITORY: "o/r",
    GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "o/r/.github/workflows/check.yml@refs/heads/main" };
  delete source.NODE_USE_ENV_PROXY;
  delete source.NODE_OPTIONS;
  const allowed = spawnSync(process.execPath, [script], { env: source, encoding: "utf8", timeout: 5000 });
  assert.equal(allowed.error, undefined);
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    assert.equal(allowed.status, 1);
    assert.match(allowed.stderr, /runtime cannot use/);
    return;
  }
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /ALLOW push on main/);
  const refused = spawnSync(process.execPath, [script], { env: { ...source, GITHUB_REPOSITORY: "other/repo" }, encoding: "utf8", timeout: 5000 });
  assert.equal(refused.error, undefined);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /REFUSE repository other\/repo is not o\/r/);
});
const files = (...names) => ({ body: { files: names.map((filename) => ({ filename })) } });

// The longest matching key answers: the run's URL is a prefix of its
// attempts/{n}/jobs URL.
function fakeFetch(script) {
  script = { [`${API}/actions/workflows/clued-work-admission.yml`]: { body: {
    path: ".github/workflows/clued-work-admission.yml", state: "active" } },
    // The head's runs for the three-attempt budget per head and workflow (Fable 11-20): by default no other run of the workflow.
    [`${API}/actions/runs?head_sha=`]: { body: { total_count: 0, workflow_runs: [] } },
    [`${API}/actions/workflows/clued-required-tests.yml/runs?head_sha=`]: { body: { total_count: 0, workflow_runs: [] } }, ...script };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization, method: init.method ?? "GET", body: init.body });
    const key = Object.keys(script).filter((k) => String(url).startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const r = key ? (typeof script[key] === "function" ? script[key]() : script[key]) : { status: 500, body: null };
    // a real Response: the hook reads every body with text() (review of 1.0.2, round 2)
    return new Response(r.text ?? JSON.stringify(r.body ?? null), { status: r.status ?? 200 });
  };
  return { fetchImpl, calls };
}
// The job's own run: re-runs are refused, and only the admission run of its
// own event counts (re-review 3, re-review 5).
const RUN = `${API}/actions/runs/555`;
const RUN_CREATED = "2026-10-04T05:00:00Z";
const thisRun = (overrides = {}) => ({ body: { id: 555, run_attempt: 1, created_at: RUN_CREATED, ...overrides } });
// The legacy admission workflow's runs on the head: the hook no longer reads them (scaffold open-qs 1.1).
const ADMISSION_RUNS = `${API}/actions/workflows/clued-work-admission.yml/runs?head_sha=${HEAD}&event=pull_request_target`;
const admissionRun = (overrides = {}) => ({ id: 1, event: "pull_request_target", head_sha: HEAD, created_at: RUN_CREATED,
  status: "completed", conclusion: "success", ...overrides });
const admissionRuns = (...list) => ({ body: { workflow_runs: list } });
const run = async (overrides, script, event = prEvent()) => {
  // By default the head has its Native admission and the pull request is open at it.
  const fake = fakeFetch({ [RUN]: thisRun(), [NATIVE]: { body: { total_count: 1, check_runs: [nativeCheck()] } },
    [`${API}/pulls/9`]: { body: { state: "open", base: { ref: "main", repo: { full_name: "o/r" } }, head: { sha: HEAD } } }, ...script });
  const sleeps = [];
  const result = await decide({ env: env(overrides), fetchImpl: fake.fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
    readFile: (p) => (p === "/token" ? "ghp_read\n" : event) });
  return { result, calls: fake.calls, sleeps };
};

const PRODUCER = `${API}/actions/workflows/clued-work-admission.yml`;
const NATIVE = `${API}/commits/${HEAD}/check-runs?check_name=kooyumi-work-admission`;
const nativeCheck = (overrides = {}) => ({ id: 80, name: "kooyumi-work-admission", app: { id: 5368905 }, head_sha: HEAD,
  status: "completed", conclusion: "success", started_at: RUN_CREATED, completed_at: RUN_CREATED,
  external_id: `independent-ci:native-work-admission:v2:${"c".repeat(64)}:a1:c1234abcd:f1:e1`,
  output: { summary: "Native work admission o/r#9" }, ...overrides });
const nativeScript = (...checks) => ({
  [COMPARE]: files(".github/workflows/gitleaks.yml"),
  [NATIVE]: { body: { total_count: checks.length, check_runs: checks } },
  [`${API}/pulls/9`]: { body: { state: "open", base: { ref: "main", repo: { full_name: "o/r" } }, head: { sha: HEAD } } },
});

// S = merge(T, H). Admission belongs to the current member PR/head, never S
// itself or an arbitrary success with the same display name.
const STAGING_ENV = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/clued-train/staging',
  GITHUB_ACTOR: 'clued-ci-checks-turing-20261018[bot]',
  GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-required-tests.yml@refs/heads/clued-train/staging' };
const MAIN = 'd'.repeat(40);
const MAIN_REF = `${API}/git/ref/heads/main`;
const MEMBER = { number: 9, state: 'open', draft: false, created_at: RUN_CREATED,
  base: { ref: 'main', repo: { full_name: 'o/r' } }, head: { sha: HEAD, repo: { full_name: 'o/r' } } };
const memberRunsUrl = head => `${API}/actions/workflows/clued-required-tests.yml/runs?head_sha=${head}&event=pull_request`;
const memberRuns = (head = HEAD, number = 9, created_at = RUN_CREATED) => ({ body: { total_count: 1, workflow_runs: [
  { id: 550, event: 'pull_request', head_sha: head, path: '.github/workflows/clued-required-tests.yml',
    created_at, pull_requests: [{ number }] },
] } });
const stagingScript = () => ({
  [RUN]: thisRun({ event: 'push', head_sha: SHA, head_branch: 'clued-train/staging',
    path: '.github/workflows/clued-required-tests.yml', actor: { login: STAGING_ENV.GITHUB_ACTOR } }),
  [MAIN_REF]: { body: { object: { type: 'commit', sha: MAIN } } },
  [`${API}/git/commits/${SHA}`]: { body: { sha: SHA, parents: [{ sha: MAIN }, { sha: HEAD }] } },
  [`${API}/commits/${HEAD}/pulls`]: { body: [MEMBER] },
  [`${API}/pulls/9`]: { body: MEMBER },
  [memberRunsUrl(HEAD)]: memberRuns(),
  [NATIVE]: { body: { total_count: 1, check_runs: [nativeCheck()] } },
});
const stagingRun = (script = {}, overrides = {}) => run({ ...STAGING_ENV, ...overrides }, { ...stagingScript(), ...script });

test('bors staging: workflow or protected changes without member admission must fail before any step', async () => {
  // Deliberately no path exception: every staging member needs admission, so
  // changed workflows, protected paths and an unreadable diff all fail closed.
  const { result } = await stagingRun({ [NATIVE]: { body: { total_count: 0, check_runs: [] } } });
  assert.equal(result.allow, false);
});

test('bors staging: admitted current member heads in a chain rooted at live main may run, including reruns', async () => {
  for (const attempt of [1, 2]) {
    const script = stagingScript();
    script[RUN].body.run_attempt = attempt;
    script[RUN].body.run_started_at = RUN_STARTED;
    script[JOBS(attempt)] = jobsOf(gateJob({ run_attempt: attempt }));
    const { result, calls } = await stagingRun(script, { GITHUB_RUN_ATTEMPT: String(attempt), GITHUB_JOB: 'migration-verify' });
    assert.equal(result.allow, true, result.reason);
    assert.ok(calls.some(call => call.url.startsWith(NATIVE)));
    assert.equal(calls.filter(call => call.url === MAIN_REF).length, 2);
  }
});

test('bors staging: a heavy job cannot use an admission gate carried over from an earlier attempt', async () => {
  const script = stagingScript();
  Object.assign(script[RUN].body, { run_attempt: 2, run_started_at: RUN_STARTED });
  script[JOBS(2)] = jobsOf(gateJob({ run_attempt: 2, started_at: RUN_CREATED }));
  const { result } = await stagingRun(script, { GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'migration-verify' });
  assert.equal(result.allow, false, result.reason);
  assert.match(result.reason, /was not re-run/);
});

test('bors staging: a name alone, wrong App/PR/head, malformed binding, pending or newer failed admission never suffices', async () => {
  for (const change of [{ app: { id: 15368 } }, { head_sha: SHA }, { output: { summary: 'o/r#10' } },
    { external_id: 'unbound' }, { status: 'in_progress', conclusion: null }, { conclusion: 'failure' },
    { started_at: '2020-01-01T00:00:00Z' }]) {
    const { result } = await stagingRun({ [NATIVE]: { body: { total_count: 1, check_runs: [nativeCheck(change)] } } });
    assert.equal(result.allow, false, JSON.stringify(change));
  }
  assert.equal((await stagingRun({ [NATIVE]: { body: { total_count: 2,
    check_runs: [nativeCheck(), nativeCheck({ id: 81, conclusion: 'failure' })] } } })).result.allow, false);
});

test('bors staging: no open current same-repository PR, or a moved PR/main, refuses', async () => {
  for (const change of [{ state: 'closed' }, { draft: true }, { head: { ...MEMBER.head, sha: SHA } },
    { head: { ...MEMBER.head, repo: { full_name: 'fork/r' } } }, { base: { ...MEMBER.base, ref: 'feature' } }]) {
    assert.equal((await stagingRun({ [`${API}/commits/${HEAD}/pulls`]: { body: [{ ...MEMBER, ...change }] } })).result.allow, false);
  }
  assert.equal((await stagingRun({ [`${API}/pulls/9`]: { body: { ...MEMBER, head: { ...MEMBER.head, sha: SHA } } } })).result.allow, false);
  let reads = 0;
  assert.equal((await stagingRun({ [MAIN_REF]: () => ({ body: { object: { type: 'commit', sha: ++reads === 1 ? MAIN : HEAD } } }) })).result.allow, false);
});

test('bors staging: malformed ancestry and a run not bound to this S are refused', async () => {
  for (const commit of [{ sha: SHA, parents: [] }, { sha: HEAD, parents: [{ sha: MAIN }, { sha: HEAD }] },
    { sha: SHA, parents: [{ sha: SHA }, { sha: HEAD }] }]) {
    assert.equal((await stagingRun({ [`${API}/git/commits/${SHA}`]: { body: commit } })).result.allow, false);
  }
  for (const change of [{ head_sha: HEAD }, { event: 'workflow_dispatch' }, { actor: { login: 'o' } },
    { path: '.github/workflows/other.yml' }, { head_branch: 'feature' }]) {
    const script = stagingScript();
    Object.assign(script[RUN].body, change);
    assert.equal((await stagingRun(script)).result.allow, false, JSON.stringify(change));
  }
});

test('bors staging: every member of a multi-PR chain must have its own admission', async () => {
  const riderHead = 'e'.repeat(40), step = 'f'.repeat(40);
  const rider = { ...MEMBER, number: 10, head: { ...MEMBER.head, sha: riderHead } };
  const riderChecks = `${API}/commits/${riderHead}/check-runs?check_name=kooyumi-work-admission`;
  const script = {
    [`${API}/git/commits/${SHA}`]: { body: { sha: SHA, parents: [{ sha: step }, { sha: riderHead }] } },
    [`${API}/git/commits/${step}`]: { body: { sha: step, parents: [{ sha: MAIN }, { sha: HEAD }] } },
    [`${API}/commits/${riderHead}/pulls`]: { body: [rider] }, [`${API}/pulls/10`]: { body: rider },
    [memberRunsUrl(riderHead)]: memberRuns(riderHead, 10),
    [riderChecks]: { body: { total_count: 1, check_runs: [nativeCheck({ head_sha: riderHead, output: { summary: 'o/r#10' } })] } },
  };
  assert.equal((await stagingRun(script)).result.allow, true);
  assert.equal((await stagingRun({ ...script, [riderChecks]: { body: { total_count: 0, check_runs: [] } } })).result.allow, false);
});

// D6 N1: ci-suites-windows is required on main, so the train needs it on S too. The Windows workflow takes the
// same staging route, bound to its own run and to its own pull_request runs for each member head.
const WINDOWS_WORKFLOW = '.github/workflows/clued-required-tests-windows.yml';
const windowsMemberRunsUrl = head => `${API}/actions/workflows/clued-required-tests-windows.yml/runs?head_sha=${head}&event=pull_request`;
const windowsStagingScript = () => {
  const script = stagingScript();
  script[RUN].body.path = WINDOWS_WORKFLOW;
  delete script[memberRunsUrl(HEAD)];
  const runs = memberRuns();
  runs.body.workflow_runs[0].path = WINDOWS_WORKFLOW;
  script[windowsMemberRunsUrl(HEAD)] = runs;
  return script;
};
const WINDOWS_STAGING_ENV = { GITHUB_WORKFLOW_REF: `o/r/${WINDOWS_WORKFLOW}@refs/heads/clued-train/staging`, GITHUB_JOB: 'ci-suites-windows' };
test('bors staging: the Windows required workflow is admitted on S on the same terms as the Linux one', async () => {
  const { result, calls } = await stagingRun(windowsStagingScript(), WINDOWS_STAGING_ENV);
  assert.equal(result.allow, true, result.reason);
  assert.ok(calls.some(call => call.url.startsWith(windowsMemberRunsUrl(HEAD))), 'reads its own PR runs');
  assert.ok(!calls.some(call => call.url.startsWith(memberRunsUrl(HEAD))), 'not the Linux workflow runs');
  // No weaker: no member admission, another actor, or a run of another workflow refuses.
  assert.equal((await stagingRun({ ...windowsStagingScript(), [NATIVE]: { body: { total_count: 0, check_runs: [] } } },
    WINDOWS_STAGING_ENV)).result.allow, false);
  assert.equal((await stagingRun(windowsStagingScript(), { ...WINDOWS_STAGING_ENV, GITHUB_ACTOR: 'o' })).result.allow, false);
  const linuxRun = windowsStagingScript();
  linuxRun[RUN].body.path = '.github/workflows/clued-required-tests.yml';
  assert.equal((await stagingRun(linuxRun, WINDOWS_STAGING_ENV)).result.allow, false);
  // The member's PR runs must be of this workflow.
  const linuxMemberRuns = windowsStagingScript();
  linuxMemberRuns[windowsMemberRunsUrl(HEAD)] = memberRuns();
  assert.equal((await stagingRun(linuxMemberRuns, WINDOWS_STAGING_ENV)).result.allow, false);
});

// ADR 0019 §3: one walk of the member chain for every reader. The hook roots it at live main; the required workflows'
// push-baseline step runs the same export, read from main, over its checkout and checks out the root T.
test('bors staging: the member chain walk is one export, rooted by its reader', async () => {
  const hook = await import('./clued-runner-job-started.mjs');
  assert.equal(typeof hook.trainMemberChain, 'function');
  assert.equal(typeof hook.stagingBaseFromCheckout, 'function');
  const [T, H1, H2, M1, S] = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40));
  const graph = { [S]: [M1, H2], [M1]: [T, H1] };
  const readCommit = async (at) => graph[at] ? { sha: at, parents: graph[at].map((sha) => ({ sha })) } : null;
  assert.deepEqual(await hook.trainMemberChain(S, { isRoot: (at) => at === T, readCommit }), { root: T, heads: [H2, H1] });
  assert.deepEqual(await hook.trainMemberChain(M1, { isRoot: (at) => at === T, readCommit }), { root: T, heads: [H1] });
  // Another root, a member head on main, no member, an unreadable step: no root.
  for (const [sha, isRoot] of [[S, (at) => at === H1], [S, (at) => at === T || at === H2], [T, (at) => at === T], [S, () => false]]) {
    const chain = await hook.trainMemberChain(sha, { isRoot, readCommit });
    assert.equal(chain.root, undefined, JSON.stringify(chain));
    assert.match(chain.error, /chain|members/);
  }
  const source = fs.readFileSync(fileURLToPath(new URL('./clued-runner-job-started.mjs', import.meta.url)), 'utf8');
  const admission = source.slice(source.indexOf('async function stagingAdmission('));
  assert.match(admission.slice(0, admission.indexOf('\n}\n')), /await trainMemberChain\(sha, \{ isRoot: at => at === base,/,
    'the hook walks with the shared export, rooted at live main');
});

test('bors staging: an earlier success on the same head cannot authorize a later PR event', async () => {
  assert.equal((await stagingRun({ [memberRunsUrl(HEAD)]: memberRuns(HEAD, 9, '2026-10-04T05:01:00Z') })).result.allow, false);
  for (const body of [{ total_count: 0, workflow_runs: [] }, { total_count: 101, workflow_runs: [] }]) {
    assert.equal((await stagingRun({ [memberRunsUrl(HEAD)]: { body } })).result.allow, false);
  }
});

test('bors staging: the current epoch is observed for the admitted member PR/head', async () => {
  const { url, key } = resolvePublicSupabaseConfig({}, path.resolve(import.meta.dirname, '../..'));
  const rpc = `${url}/rest/v1/rpc/clued_work_verify_v1`;
  for (const current of [true, false]) {
    const fake = fakeFetch({ ...stagingScript(),
      [`${API}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`]: { body: { type: 'file', encoding: 'base64',
        content: Buffer.from(`return { url: "${url}", key: "${key}" };`).toString('base64') } },
      [rpc]: { body: { status: 'ok', guard_required: true, epoch_current: current } },
    });
    const result = await decideWithCurrentEpoch({ env: env(STAGING_ENV), fetchImpl: fake.fetchImpl,
      readFile: () => 'ghp_read', sleep: async () => {} });
    assert.equal(result.allow, current);
    const input = JSON.parse(fake.calls.find(call => call.url === rpc).body).p_input;
    assert.deepEqual(input, { action: 'execution_current', repository: 'o/r', head_sha: HEAD, pr_ref: 'o/r#9', target_branch: 'main' });
  }
});

test('G3 hook: required-tests dispatch stays bound to its current PR/head', async () => {
  const pr = { number: 9, state: 'open', head: { sha: HEAD, ref: 'claude/g3', repo: { full_name: 'o/r' } },
    base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const overrides = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/claude/g3',
    GITHUB_REF_NAME: 'claude/g3', GITHUB_SHA: HEAD, GITHUB_ACTOR: 'o', GITHUB_REPOSITORY_OWNER: 'o',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-required-tests.yml@refs/heads/claude/g3' };
  const payload = JSON.stringify({ inputs: { pr: '9', head: HEAD }, repository: { default_branch: 'main' } });
  const script = { [`${LIST}${HEAD}`]: listing({ 'clued-required-tests.yml': '1'.repeat(40) }),
    [`${LIST}main`]: listing({ 'clued-required-tests.yml': '1'.repeat(40) }), [`${API}/pulls/9`]: { body: pr } };
  assert.equal((await run(overrides, script, payload)).result.allow, true);
  for (const changed of [{ state: 'closed' }, { head: { ...pr.head, sha: SHA } }, { head: { ...pr.head, repo: { full_name: 'fork/r' } } }]) {
    assert.equal((await run(overrides, { ...script, [`${API}/pulls/9`]: { body: { ...pr, ...changed } } }, payload)).result.allow, false);
  }
  assert.equal((await run({ ...overrides, GITHUB_ACTOR: 'stranger' }, script, payload)).result.allow, false);
  assert.equal((await run({ ...overrides, GITHUB_RUN_ATTEMPT: '2' }, script, payload)).result.allow, false);
  assert.equal((await run({ ...overrides, GITHUB_REF: 'refs/heads/main' }, script, payload)).result.allow, false,
    'required-tests dispatch cannot use the generic main fast path');
  assert.equal((await run(overrides, { ...script, [`${LIST}${HEAD}`]: listing({ 'clued-required-tests.yml': '2'.repeat(40) }) }, payload)).result.allow, false,
    'branch dispatch still requires workflows identical to main');
});

test("Native hook: only the exact App/head/PR Native check is read; legacy success cannot stand in", async () => {
  const { result, calls } = await run({}, nativeScript(nativeCheck()));
  assert.equal(result.allow, true);
  assert.match(result.reason, /Native admission 80: succeeded/);
  assert.equal(calls.some(c => c.url.startsWith(ADMISSION_RUNS)), false);
  assert.equal((await run({}, nativeScript())).result.allow, false);
});

test("Native hook: spoofed, stale, unbound and unsuccessful checks never admit; the newest producer judgement decides", async () => {
  for (const change of [{ app: { id: 1 } }, { name: "other" }, { head_sha: SHA },
    { external_id: "independent-ci:anything" }, { output: { summary: "o/r#90" } },
    { output: { summary: "o/r#9 o/r#10" } }, { output: { summary: "other/repo#9" } },
    { started_at: "2026-10-04T04:59:44Z" }, { started_at: "bad" }, { completed_at: "bad" },
    { completed_at: "2026-10-04T04:59:59Z" }, { started_at: "2099-01-01T00:00:00Z", completed_at: "2099-01-01T00:00:00Z" },
    { conclusion: "failure" }, { status: "in_progress", conclusion: null }]) {
    assert.equal((await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, nativeScript(nativeCheck(change)))).result.allow, false, JSON.stringify(change));
  }
  assert.equal((await run({}, nativeScript(nativeCheck(), nativeCheck({ id: 81, conclusion: "failure" })))).result.allow, false);
  assert.equal((await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, nativeScript(nativeCheck(), nativeCheck({ id: 81, status: "queued", conclusion: null })))).result.allow, false);
  assert.equal((await run({}, nativeScript(nativeCheck(), nativeCheck({ id: 81, app: { id: 1 }, conclusion: "failure" })))).result.allow, true);
});

test("Native hook: a complete multi-page response is required and the newest producer check on any page decides", async () => {
  const old = Array.from({ length: 100 }, (_, i) => nativeCheck({ id: i + 1, app: { id: 1 } }));
  const page = checks => ({ body: { total_count: 101, check_runs: checks } });
  const script = { ...nativeScript(), [`${NATIVE}&filter=all&per_page=100&page=1`]: page(old),
    [`${NATIVE}&filter=all&per_page=100&page=2`]: page([nativeCheck({ id: 101 })]) };
  assert.equal((await run({}, script)).result.allow, true);
  assert.equal((await run({}, { ...script, [`${NATIVE}&filter=all&per_page=100&page=2`]: page([nativeCheck({ id: 101, conclusion: "failure" })]) })).result.allow, false);
  await assert.rejects(run({}, { ...script, [`${NATIVE}&filter=all&per_page=100&page=2`]: page([]) }), /incomplete/);
});

test("Native hook: no fallback on a Checks failure, incomplete pagination, closed or moved PR; no Native rerun allowance", async () => {
  // The legacy workflow's state selects nothing any more (scaffold open-qs 1.1).
  assert.equal((await run({}, { ...nativeScript(nativeCheck()), [PRODUCER]: { body: { state: "disabled_inactivity" } } })).result.allow, true);
  await assert.rejects(run({}, { ...nativeScript(nativeCheck()), [NATIVE]: { status: 403, body: null } }), /returned 403/);
  await assert.rejects(run({}, { ...nativeScript(nativeCheck()), [NATIVE]: { body: { total_count: 1001, check_runs: [] } } }), /incomplete/);
  await assert.rejects(run({}, { ...nativeScript(nativeCheck()), [NATIVE]: { body: { total_count: 1, check_runs: [] } } }), /incomplete/);
  for (const current of [{ state: "closed" }, { state: "open", base: { ref: "main", repo: { full_name: "o/r" } }, head: { sha: SHA } }])
    assert.equal((await run({}, { ...nativeScript(nativeCheck()), [`${API}/pulls/9`]: { body: current } })).result.allow, false);
  assert.equal((await run({ GITHUB_RUN_ATTEMPT: "2", GITHUB_JOB: "admission-gate" }, {
    ...nativeScript(nativeCheck()), [RUN]: thisRun({ run_attempt: 2 }) })).result.allow, false);
});

test("Native hook: an admitted job still requires the independent current epoch observation", async () => {
  const { url, key } = resolvePublicSupabaseConfig({}, path.resolve(import.meta.dirname, "../.."));
  const rpc = `${url}/rest/v1/rpc/clued_work_verify_v1`;
  const config = `${API}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`;
  const fake = fakeFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()),
    [config]: { body: { type: "file", encoding: "base64", content: Buffer.from(`return { url: "${url}", key: "${key}" };`).toString("base64") } },
    [rpc]: { body: { status: "ok", guard_required: true, epoch_current: false } } });
  const result = await decideWithCurrentEpoch({ env: env(), fetchImpl: fake.fetchImpl,
    sleep: async () => {}, readFile: p => p === "/token" ? "ghp_read" : prEvent() });
  assert.equal(result.allow, false);
  assert.match(result.reason, /epoch is stale/);
});
const COMPARE = `${API}/compare/main...`;
const LIST = `${API}/contents/.github/workflows?ref=`;
const listing = (entries) => ({ body: Object.entries(entries).map(([name, sha]) => ({ path: `.github/workflows/${name}`, type: "file", sha })) });

test("runner current epoch: old successful GitHub admission cannot start a handed-over job", async () => {
  const root=path.resolve(import.meta.dirname,"../..");
  const configuration=fs.readFileSync(path.join(root,"apps/clued-cloud/app/supabase-public-config.ts"),"utf8");
  const publicConfig=resolvePublicSupabaseConfig({},root);
  const rpc=`${publicConfig.url}/rest/v1/rpc/clued_work_verify_v1`;
  const configUrl=`${API}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`;
  const execute=async observation=>{
    const fake=fakeFetch({[RUN]:thisRun(),[COMPARE]:files(),
      [configUrl]:{body:{type:"file",encoding:"base64",content:Buffer.from(configuration).toString("base64")}},
      [rpc]:observation});
    const result=await decideWithCurrentEpoch({env:env({CLUED_SUPABASE_URL:"https://attacker.invalid",CLUED_SUPABASE_PUBLISHABLE_KEY:"fake"}),
      fetchImpl:fake.fetchImpl,readFile:p=>p==="/token"?"ghp_read":prEvent()});
    return {result,calls:fake.calls};
  };
  const current=await execute({body:{status:"ok",guard_required:true,epoch_current:true}});
  assert.equal(current.result.allow,true);
  const stale=await execute({body:{status:"ok",guard_required:true,epoch_current:false}});
  assert.equal(stale.result.allow,false);assert.match(stale.result.reason,/epoch is stale/);
  const query=stale.calls.find(c=>c.url===rpc);
  assert.equal(query.auth,`Bearer ${publicConfig.key}`);
  assert.deepEqual(JSON.parse(query.body),{p_token_hash:null,p_input:{action:"execution_current",repository:"o/r",head_sha:HEAD,pr_ref:"o/r#9",target_branch:"main"}});
  assert.equal(stale.calls.some(c=>c.url.startsWith("https://attacker.invalid")),false);
  await assert.rejects(execute({status:503,body:null}),/epoch unavailable/);
  await assert.rejects(execute({body:{status:"ok",guard_required:true,epoch_current:null}}),/observation is invalid/);
});

test("runner current epoch: new handover branch dispatches still require the exact current execution target", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const configuration = fs.readFileSync(path.join(root, "apps/clued-cloud/app/supabase-public-config.ts"), "utf8");
  const publicConfig = resolvePublicSupabaseConfig({}, root);
  const rpc = `${publicConfig.url}/rest/v1/rpc/clued_work_verify_v1`;
  const configUrl = `${API}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`;
  for (const file of ["clued-handover-external-qualification.yml", "clued-handover-disposable-idle.yml"]) {
    const same = { [file]: "1".repeat(40) };
    const execute = async observation => {
      const fake = fakeFetch({ [RUN]: thisRun(), [`${LIST}${SHA}`]: listing(same), [`${LIST}main`]: listing(same),
        [configUrl]: { body: { type: "file", encoding: "base64", content: Buffer.from(configuration).toString("base64") } },
        [rpc]: observation });
      const result = await decideWithCurrentEpoch({ env: env({ GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/clued-handover-disposable-fixture", GITHUB_REF_NAME: "clued-handover-disposable-fixture",
        GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${file}@refs/heads/clued-handover-disposable-fixture` }),
        fetchImpl: fake.fetchImpl, readFile: p => p === "/token" ? "ghp_read" : prEvent() });
      return { result, calls: fake.calls };
    };
    const current = await execute({ body: { status: "ok", guard_required: true, epoch_current: true } });
    assert.equal(current.result.allow, true, file);
    const stale = await execute({ body: { status: "ok", guard_required: true, epoch_current: false } });
    assert.equal(stale.result.allow, false, file);
    assert.match(stale.result.reason, /epoch is stale/);
    const query = stale.calls.find(c => c.url === rpc);
    assert.deepEqual(JSON.parse(query.body), { p_token_hash: null, p_input: { action: "execution_current",
      repository: "o/r", head_sha: SHA, target_branch: "clued-handover-disposable-fixture", workflow: file } });
    await assert.rejects(execute({ status: 503, body: null }), /epoch unavailable/);
    await assert.rejects(execute({ body: { status: "ok", guard_required: true, epoch_current: null } }), /observation is invalid/);
  }
});

test("runner hook: main's own runs start without any call", async () => {
  for (const event of ["push", "schedule", "workflow_run", "pull_request_target", "workflow_dispatch"]) {
    const { result, calls } = await run({ GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main" }, {});
    assert.deepEqual([result.allow, calls.length], [true, 0], event);
  }
  assert.equal(workflowPathOf(env()), ".github/workflows/clued-g4-database.yml");
});

test("runner hook (re-review 7, m1): pull_request_target counts as main only for a pull request into main", async () => {
  const { result, calls } = await run({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_REF: "refs/heads/main" }, {}, prEvent("feature"));
  assert.deepEqual([result.allow, result.reason, calls.length], [false, "pull_request_target for a pull request into feature, not main", 0]);
});

// 04f9b91b 题 1: a pull request whose head is not in this repository (a fork, or a head repository GitHub no longer
// names) never runs on this runner, on either pull request event, whatever the workflow's own if says.
const FORK_REFUSED = "pull request #9 comes from fork stranger/r, not o/r; a fork's head never runs on this runner";
test("runner hook (04f9b91b, 1): a fork's pull_request that changes no workflow is refused before the head is read", async () => {
  // Before: ALLOW "changes no workflow".
  const { result, calls } = await run({}, { [COMPARE]: files("apps/x.ts") }, prEvent("main", { full_name: "stranger/r" }));
  assert.deepEqual([result.allow, result.reason], [false, FORK_REFUSED]);
  assert.equal(calls.some((c) => c.url.startsWith(COMPARE)), false, "nothing about the head is read");
  // A fork named like this repository but another repository is still a fork.
  assert.equal((await run({}, { [COMPARE]: files() }, prEvent("main", { full_name: "o/r-fork" }))).result.allow, false);
});
test("runner hook (04f9b91b, 2): a fork's pull_request that changes a workflow is refused as a fork, not on admission", async () => {
  // Before: ALLOW on the (successful) admission run.
  const { result, calls } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml") }, prEvent("main", { full_name: "stranger/r" }));
  assert.deepEqual([result.allow, result.reason], [false, FORK_REFUSED]);
  assert.equal(calls.some((c) => c.url.startsWith(ADMISSION_RUNS) || c.url.startsWith(PRODUCER)), false);
});
test("runner hook (04f9b91b, 3): a fork's pull_request_target into main is refused without a call", async () => {
  // Before: ALLOW as main's own run.
  const { result, calls } = await run({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_REF: "refs/heads/main" }, {},
    prEvent("main", { full_name: "stranger/r" }));
  assert.deepEqual([result.allow, result.reason, calls.length],
    [false, "pull_request_target for pull request #9 comes from fork stranger/r, not o/r; a fork's head never runs on this runner", 0]);
});
test("runner hook (04f9b91b, 4): no readable head or base repository (a deleted fork) refuses on both events", async () => {
  let result, calls;
  for (const headRepo of [null, "absent", {}, { full_name: "" }]) {
    ({ result } = await run({}, { [COMPARE]: files() }, prEvent("main", headRepo)));
    assert.deepEqual([result.allow, result.reason],
      [false, "pull request #9 comes from an unreadable head repository (a deleted fork?), not o/r; a fork's head never runs on this runner"],
      JSON.stringify(headRepo));
    ({ result, calls } = await run({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_REF: "refs/heads/main" }, {}, prEvent("main", headRepo)));
    assert.deepEqual([result.allow, calls.length], [false, 0], `pull_request_target ${JSON.stringify(headRepo)}`);
    assert.match(result.reason, /^pull_request_target for pull request #9 comes from an unreadable head repository/);
  }
  // A base repository that is not this one (or unreadable) is refused the same way: head and base must both be o/r.
  const otherBase = JSON.stringify({ pull_request: { number: 9, base: { ref: "main", repo: { full_name: "stranger/r" } },
    head: { sha: HEAD, repo: { full_name: "o/r" } } } });
  ({ result } = await run({}, { [COMPARE]: files() }, otherBase));
  assert.equal(result.allow, false);
  assert.match(result.reason, /comes from base repository stranger\/r, not o\/r/);
});

test("runner hook (04f9b91b, 5): a same-repository pull request is judged as before on both events", async () => {
  // Same repository, any letter case: unchanged.
  for (const headRepo of [{ full_name: "o/r" }, { full_name: "O/R" }]) {
    let { result } = await run({}, { [COMPARE]: files("apps/x.ts") }, prEvent("main", headRepo));
    assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes no workflow"]);
    ({ result } = await run({}, { [COMPARE]: files(".github/workflows/heavy.yml") }, prEvent("main", headRepo)));
    assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes .github/workflows/heavy.yml; Native admission 80: succeeded"]);
    const target = await run({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_REF: "refs/heads/main" }, {}, prEvent("main", headRepo));
    assert.deepEqual([target.result.allow, target.result.reason, target.calls.length], [true, "pull_request_target on main", 0]);
  }
  // The base check still comes first: a fork's pull request into another branch keeps that reason.
  const { result } = await run({}, { [COMPARE]: files() }, prEvent("feature", { full_name: "stranger/r" }));
  assert.deepEqual([result.allow, result.reason], [false, "pull request into feature, not main"]);
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

test("runner hook: a pull request into main runs when it changes no workflow, else only after its Native admission succeeds", async () => {
  let { result, calls } = await run({}, { [COMPARE]: files("apps/x.ts") });
  assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes no workflow"]);
  assert.equal(calls[0].url, RUN);
  assert.equal(calls[1].url, `${COMPARE}${HEAD}`);
  assert.equal(calls[1].auth, "Bearer ghp_read");
  // A changed workflow, even another one than the running job's (a called workflow), needs admission.
  const change = { [COMPARE]: files(".github/workflows/heavy.yml") };
  ({ result, calls } = await run({}, change));
  assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes .github/workflows/heavy.yml; Native admission 80: succeeded"]);
  assert.deepEqual(urls(calls), [RUN, `${COMPARE}${HEAD}`, `${NATIVE}&filter=all&per_page=100&page=1`, `${API}/pulls/9`]);
  // Not a failed or cancelled check, not one on another head.
  for (const overrides of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: "action_required" }, { head_sha: SHA }]) {
    ({ result } = await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, { ...change, [NATIVE]: { body: { total_count: 1, check_runs: [nativeCheck(overrides)] } } }));
    assert.equal(result.allow, false, JSON.stringify(overrides));
  }
  // A renamed workflow counts by its old name too; a truncated list counts as changed.
  ({ result, calls } = await run({}, { [COMPARE]: { body: { files: [{ filename: "x.yml", previous_filename: ".github/workflows/old.yml" }] } } }));
  assert.match(result.reason, /changes \.github\/workflows\/old\.yml; Native admission 80/);
  assert.equal(calls.length, 4, "the run, the compare, the Native check and the pull request");
  const many = Array.from({ length: 300 }, (_, i) => `apps/f${i}.ts`);
  ({ result } = await run({}, { [COMPARE]: files(...many), [NATIVE]: { body: { total_count: 0, check_runs: [] } } }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /truncated/);
  // It waits for a check that is still going.
  let polls = 0;
  let sleeps;
  ({ result, sleeps } = await run({}, { ...change,
    [NATIVE]: () => { polls += 1; return { body: { total_count: 1, check_runs: [nativeCheck(polls < 3 ? { status: "in_progress", conclusion: null } : {})] } }; } }));
  assert.deepEqual([result.allow, polls, sleeps.length], [true, 3, 2]);
  // And gives up after CLUED_RUNNER_HOOK_WAIT_SECONDS.
  ({ result, sleeps } = await run({}, { ...change, [NATIVE]: { body: { total_count: 1, check_runs: [nativeCheck({ status: "in_progress", conclusion: null })] } } }));
  assert.deepEqual([result.allow, sleeps.length], [false, 2]);
  assert.match(result.reason, /Native admission 80: not admitted/);
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
    assert.match(lines.at(-1), /CLUED_RUNNER_HOOK_APP_ID and CLUED_RUNNER_HOOK_APP_KEY_FILE \(or the older CLUED_RUNNER_HOOK_TOKEN_FILE\) are not set/);
    assert.equal(await main({ ...env({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }), CLUED_RUNNER_HOOK_ENFORCE: "true" },
      fakeFetch({}).fetchImpl), 0);
    assert.match(lines.at(-1), /ALLOW push on main/);
  } finally { console.log = log; }
  // Each line names the hook's version, so the Owner can check every runner's copy.
  assert.equal(HOOK_VERSION, "native-only-admission-v1");
  assert.ok(lines.length >= 5);
  const observations = lines.filter((line) => line.startsWith("clued-r9-pre-job: "));
  const diagnostics = lines.filter((line) => !line.startsWith("clued-r9-pre-job: "));
  assert.ok(diagnostics.length >= 5);
  for (const line of diagnostics) assert.ok(line.endsWith(` [hook ${HOOK_VERSION}]`), line);
  assert.equal(observations.length, diagnostics.length);
  for (const line of observations) {
    const observation = JSON.parse(line.slice("clued-r9-pre-job: ".length));
    assert.equal(observation.hook_version, HOOK_VERSION);
    assert.equal(observation.phase, "pre_job_permission");
    assert.equal(observation.native_job_started_at, null);
    assert.equal(observation.native_job_completed_at, null);
    assert.equal(observation.source_authenticated, false);
    assert.equal(observation.official_metric, false);
    assert.equal(observation.t0, null);
  }
  const { result } = await run({ GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/x" }, { [LIST]: { status: 403, body: null } })
    .catch((error) => ({ result: { error: error.message } }));
  assert.match(result.error, /returned 403/);
});

// Re-runs (MergeAdmission v0.1 §8; Owner Decisions 77216370, 1b93760d).
// Attempt n starts at RUN_STARTED (run_started_at changes per attempt,
// created_at does not).
const PULLS = `${API}/pulls/9`;
const JOBS = (n) => `${API}/actions/runs/555/attempts/${n}/jobs`;
const RUN_STARTED = "2026-10-04T06:00:00Z";
const rerunOf = (n, overrides = {}) => thisRun({ run_attempt: n, run_started_at: RUN_STARTED, ...overrides });
const pull = (overrides = {}) => ({ body: { number: 9, state: "open", base: { ref: "main" }, head: { sha: HEAD }, ...overrides } });
// This attempt's gate job ("Re-run all jobs" ran it again), and the job being started.
const SELF_HOSTED = ["self-hosted", "Windows", "X64"];
const gateJob = (overrides = {}) => ({ id: 77, name: "admission-gate", status: "completed", conclusion: "success", run_attempt: 2,
  started_at: "2026-10-04T06:00:04Z", labels: SELF_HOSTED, ...overrides });
const heavyJob = (overrides = {}) => ({ id: 78, name: "trusted-self-hosted", status: "in_progress", conclusion: null, run_attempt: 2,
  started_at: "2026-10-04T06:01:00Z", labels: SELF_HOSTED, ...overrides });
const jobsOf = (...jobs) => ({ body: { total_count: jobs.length, jobs } });
const HEAVY = { GITHUB_JOB: "trusted-self-hosted" };
const GATE = { GITHUB_JOB: "admission-gate" };
const GITLEAKS = { GITHUB_JOB: "gitleaks-trusted-self-hosted", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/gitleaks.yml@refs/pull/9/merge" };
const TRIVY = { GITHUB_JOB: "trivy-trusted-self-hosted", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/trivy.yml@refs/pull/9/merge" };
const rerun = (n, overrides, script = {}) => run({ GITHUB_RUN_ATTEMPT: String(n), ...overrides }, {
  [RUN]: rerunOf(n), [PULLS]: pull(), [JOBS(n)]: jobsOf(gateJob({ run_attempt: n }), heavyJob({ run_attempt: n })),
  [COMPARE]: files("apps/x.ts"), ...script });
const urls = (calls) => calls.map((c) => c.url);

test("runner hook (Decision 77216370): the admission-gate job of a re-run on the current head starts; the gate judges the re-run", async () => {
  for (const n of [2, 3, 5]) {
    const { result, calls } = await rerun(n, GATE);
    assert.equal(result.allow, true, `attempt ${n}`);
    assert.equal(result.reason, `pull request #9 changes no workflow; run attempt ${n} on the current head: the admission-gate job judges the re-run itself`);
    assert.deepEqual(urls(calls), [RUN, PULLS, `${COMPARE}${HEAD}`], "the attempt's jobs are not read for the gate itself");
  }
});

test("runner hook (Decision 77216370): a heavy job of \"Re-run all jobs\" starts when this attempt's gate ran again and succeeded", async () => {
  let { result, calls } = await rerun(2, HEAVY);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "pull request #9 changes no workflow; run attempt 2 on the current head: admission-gate job 77 ran again in this attempt and succeeded");
  assert.deepEqual(urls(calls), [RUN, PULLS, `${JOBS(2)}?per_page=100`, `${COMPARE}${HEAD}`]);
  // Any attempt: the gate enforces the policy's reruns_per_head.
  ({ result } = await rerun(3, HEAVY));
  assert.equal(result.allow, true, "attempt 3");
  // A gate that started the same second as the attempt counts.
  ({ result } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(heavyJob(), gateJob({ started_at: RUN_STARTED })) }));
  assert.equal(result.allow, true, "started_at equal to run_started_at");
  // The API may show the fresh gate as running for a moment after the job that needs it starts: wait for it.
  let polls = 0;
  let sleeps;
  ({ result, sleeps } = await rerun(2, HEAVY, {
    [JOBS(2)]: () => { polls += 1; return jobsOf(gateJob(polls < 2 ? { status: "in_progress", conclusion: null } : {}), heavyJob()); } }));
  assert.deepEqual([result.allow, polls, sleeps], [true, 2, [10_000]]);
});

test("runner hook (Decision 77216370): \"Re-run failed jobs\" and single-job re-runs are refused", async () => {
  const refused = async (label, overrides, script) => {
    const { result, calls, sleeps } = await rerun(2, { ...HEAVY, ...overrides }, script);
    assert.equal(result.allow, false, label);
    assert.match(result.reason, /^pull request #9, run attempt 2: /, label);
    assert.equal(calls.some((c) => c.url.startsWith(COMPARE)), false, `${label}: refused before the workflow-change rule`);
    return { result, calls, sleeps };
  };
  // GitHub lists the earlier gate job in the new attempt, successful and with
  // this attempt's number, but with the earlier attempt's start time.
  let { result } = await refused("not re-run gate", {}, { [JOBS(2)]: jobsOf(gateJob({ started_at: "2026-10-04T05:00:04Z" }), heavyJob()) });
  assert.match(result.reason, /admission-gate job 77 started 2026-10-04T05:00:04Z, not in this attempt: it was not re-run/);
  assert.match(result.reason, /use "Re-run all jobs", not "Re-run failed jobs" or a single job$/);
  // An attempt that lists no gate job of a workflow main gates (Task 26cced7e: main's copy decides).
  const G4 = `${API}/contents/.github/workflows/clued-g4-database.yml?ref=`;
  const g4 = { type: "file", sha: "c".repeat(40), encoding: "base64",
    content: Buffer.from("jobs:\n  admission-gate:\n    runs-on: [self-hosted]\n", "utf8").toString("base64") };
  ({ result } = await refused("no gate", {}, { [JOBS(2)]: jobsOf(heavyJob()), [`${G4}${SHA}`]: { body: g4 }, [`${G4}main`]: { body: g4 } }));
  assert.match(result.reason, /attempt 2 lists no admission-gate job, but \.github\/workflows\/clued-g4-database\.yml: main's copy has an admission-gate job/);
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", null]) {
    ({ result } = await refused(`gate ${conclusion}`, {}, { [JOBS(2)]: jobsOf(gateJob({ conclusion }), heavyJob()) }));
    assert.match(result.reason, new RegExp(`admission-gate job 77: completed/${conclusion ?? "none"}`));
  }
  // Still running after the wait: refused.
  let sleeps;
  ({ result, sleeps } = await refused("gate in_progress", {}, { [JOBS(2)]: jobsOf(gateJob({ status: "in_progress", conclusion: null }), heavyJob()) }));
  assert.match(result.reason, /admission-gate job 77: in_progress\/none/);
  assert.equal(sleeps.length, 2, "waited CLUED_RUNNER_HOOK_WAIT_SECONDS");
  ({ sleeps } = await refused("gate queued, no wait", { CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" },
    { [JOBS(2)]: jobsOf(gateJob({ status: "queued", conclusion: null }), heavyJob()) }));
  assert.equal(sleeps.length, 0);
  for (const name of ["admission-gate / check", "Admission-gate", "admission-gate-2", "trusted / admission-gate", " admission-gate"]) {
    await refused(`name ${JSON.stringify(name)}`, {}, { [JOBS(2)]: jobsOf(gateJob({ name }), heavyJob()) });
  }
  // A list that is not complete may hide nothing, or the gate: refused either way.
  ({ result } = await refused("total_count > returned", {}, { [JOBS(2)]: { body: { total_count: 101, jobs: [gateJob(), heavyJob()] } } }));
  assert.match(result.reason, /attempt 2 has 101 jobs and 2 were listed/);
  await refused("total_count missing", {}, { [JOBS(2)]: { body: { jobs: [gateJob(), heavyJob()] } } });
  await refused("jobs missing", {}, { [JOBS(2)]: { body: { total_count: 0 } } });
  // A start time that cannot be read refuses at once.
  ({ result, sleeps } = await refused("gate started_at unreadable", {}, { [JOBS(2)]: jobsOf(gateJob({ started_at: "yesterday" }), heavyJob()) }));
  assert.match(result.reason, /admission-gate job 77 has an unreadable started_at "yesterday"/);
  assert.equal(sleeps.length, 0);
  for (const run_started_at of [undefined, null, "", "soon"]) {
    let calls;
    ({ result, calls } = await refused(`run_started_at ${run_started_at}`, {}, { [RUN]: rerunOf(2, { run_started_at }) }));
    assert.match(result.reason, /the run has no run_started_at; re-run refused/);
    assert.deepEqual(urls(calls), [RUN, PULLS], "the jobs are not read without the attempt's start");
  }
  // A gate job of another attempt does not count.
  ({ result } = await refused("gate of attempt 1", {}, { [JOBS(2)]: jobsOf(gateJob({ run_attempt: 1 }), heavyJob()) }));
  assert.match(result.reason, /admission-gate job 77 belongs to attempt 1, not 2/);
  // The jobs cannot be read: refused, not thrown.
  for (const status of [403, 404, 500]) {
    ({ result } = await refused(`jobs ${status}`, {}, { [JOBS(2)]: { status, body: null } }));
    assert.match(result.reason, new RegExp(`cannot read attempt 2's jobs \\(GitHub .*/attempts/2/jobs\\?per_page=100 returned ${status}\\)`));
  }
  await refused("jobs transport error", {}, { [JOBS(2)]: () => { throw new Error("socket hang up"); } });
});

test("runner hook (review item 3): the measured \"Re-run failed jobs\" shape is refused", async () => {
  // Measured on GitHub: in the new attempt the not re-run gate job is listed
  // with a new id, a later created_at and this attempt's number, successful,
  // but its started_at is the earlier attempt's, before run_started_at.
  const listed = gateJob({ id: 9101, run_attempt: 2, status: "completed", conclusion: "success",
    created_at: "2026-10-04T06:00:02Z", started_at: "2026-10-04T05:00:04Z", completed_at: "2026-10-04T05:00:30Z" });
  const { result, calls, sleeps } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(listed, heavyJob({ id: 9102, created_at: "2026-10-04T06:00:02Z" })) });
  assert.equal(result.allow, false);
  assert.match(result.reason, /^pull request #9, run attempt 2: no admission-gate job that ran again in this attempt and succeeded \(admission-gate job 9101 started 2026-10-04T05:00:04Z, not in this attempt: it was not re-run\)/);
  assert.deepEqual(sleeps, [], "refused at once, not waited for");
  assert.equal(calls.some((c) => c.url.startsWith(COMPARE)), false);
});

test("runner hook (review MINOR-2): exactly one self-hosted job named admission-gate", async () => {
  // A second job with the gate's display name (another workflow's job, or one
  // a called workflow adds) cannot stand in, even when one of them passed.
  let { result, sleeps } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(gateJob(), gateJob({ id: 79 }), heavyJob()) });
  assert.equal(result.allow, false, "duplicate gate");
  assert.match(result.reason, /attempt 2 has 2 jobs named admission-gate \(77, 79\); exactly one is required/);
  assert.deepEqual(sleeps, []);
  ({ result } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(gateJob({ conclusion: "failure" }), gateJob({ id: 79 }), heavyJob()) }));
  assert.equal(result.allow, false, "duplicate gate, one failed");
  // Every gate job runs on a self-hosted runner: one without that label is refused.
  for (const labels of [["ubuntu-latest"], [], undefined, null, "self-hosted"]) {
    ({ result, sleeps } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(gateJob({ labels }), heavyJob()) }));
    assert.equal(result.allow, false, `labels ${JSON.stringify(labels)}`);
    assert.match(result.reason, /admission-gate job 77 does not run on a self-hosted runner/);
    assert.deepEqual(sleeps, []);
  }
});

test("runner hook (review NIT-5): a gate job of this attempt not started or not completed yet is waited for", async () => {
  // Queued without a start time, then running, then done: allowed after polling.
  let polls = 0;
  let { result, sleeps } = await rerun(2, HEAVY, { [JOBS(2)]: () => {
    polls += 1;
    const stage = polls === 1 ? { status: "queued", conclusion: null, started_at: null }
      : polls === 2 ? { status: "in_progress", conclusion: null } : {};
    return jobsOf(gateJob(stage), heavyJob());
  } });
  assert.deepEqual([result.allow, polls, sleeps], [true, 3, [10_000, 10_000]]);
  // Completed but with no start time yet (the API's lag): pending too.
  polls = 0;
  ({ result, sleeps } = await rerun(2, HEAVY, { [JOBS(2)]: () => {
    polls += 1;
    return jobsOf(gateJob(polls === 1 ? { started_at: "" } : {}), heavyJob());
  } }));
  assert.deepEqual([result.allow, polls, sleeps.length], [true, 2, 1]);
  // Still without a start time at the end of the wait: refused then, not at once.
  for (const started_at of [undefined, null, ""]) {
    ({ result, sleeps } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(gateJob({ started_at }), heavyJob()) }));
    assert.equal(result.allow, false, `started_at ${started_at}`);
    assert.equal(sleeps.length, 2, "waited CLUED_RUNNER_HOOK_WAIT_SECONDS");
    assert.match(result.reason, /admission-gate job 77: completed\/success, not started\); use "Re-run all jobs"/);
  }
  ({ result, sleeps } = await rerun(2, { ...HEAVY, CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" },
    { [JOBS(2)]: jobsOf(gateJob({ status: "waiting", conclusion: null, started_at: null }), heavyJob()) }));
  assert.deepEqual([result.allow, sleeps.length], [false, 0]);
  assert.match(result.reason, /admission-gate job 77: waiting\/none, not started/);
});

test("runner hook (Decision 77216370): a re-run of an old head, a closed or a retargeted pull request is refused", async () => {
  const pulls = [
    ["head moved", pull({ head: { sha: "c".repeat(40) } }), new RegExp(`${HEAD} is not the pull request's current head \\(${"c".repeat(40)}\\); an old head's run may not be re-run`)],
    ["closed", pull({ state: "closed" }), /the pull request is closed; only an open pull request's current head may be re-run/],
    ["merged", pull({ state: "closed", merged: true }), /the pull request is closed/],
    ["retargeted", pull({ base: { ref: "feature" } }), /the pull request now targets feature, not main/],
    ["no head", pull({ head: null }), /is not the pull request's current head \(unknown\)/],
    ["404", { status: 404, body: null }, /cannot read the pull request \(GitHub \/repos\/o\/r\/pulls\/9 returned 404\); re-run refused/],
    ["403", { status: 403, body: null }, /cannot read the pull request \(GitHub \/repos\/o\/r\/pulls\/9 returned 403\)/],
    ["500", { status: 500, body: null }, /returned 500/],
    ["transport", () => { throw new Error("ECONNRESET"); }, /cannot read the pull request \(ECONNRESET\)/],
  ];
  for (const [kind, overrides] of [["gate", GATE], ["heavy", HEAVY], ["gitleaks", GITLEAKS], ["trivy", TRIVY]]) {
    for (const [label, answer, reason] of pulls) {
      const { result, calls } = await rerun(2, overrides, { [PULLS]: answer });
      assert.equal(result.allow, false, `${kind}: ${label}`);
      assert.match(result.reason, /^pull request #9, run attempt 2: /);
      assert.match(result.reason, reason, `${kind}: ${label}`);
      // a 500 and a transport failure are transient: the read is tried again (READ_ATTEMPTS in all), then refuses as before
      const reads = ["500", "transport"].includes(label) ? READ_ATTEMPTS : 1;
      assert.deepEqual(urls(calls), [RUN, ...Array(reads).fill(PULLS)], `${kind}: ${label}: nothing else is read`);
    }
  }
  // An event without a usable number or head refuses without asking GitHub.
  const own = { full_name: "o/r" };
  for (const event of [JSON.stringify({ pull_request: { base: { ref: "main", repo: own }, head: { sha: HEAD, repo: own } } }),
    JSON.stringify({ pull_request: { number: 9, base: { ref: "main", repo: own }, head: { repo: own } } })]) {
    const fake = fakeFetch({ [RUN]: rerunOf(2), [PULLS]: pull() });
    const result = await decide({ env: env({ GITHUB_RUN_ATTEMPT: "2", ...GATE }), fetchImpl: fake.fetchImpl, sleep: async () => {},
      readFile: (p) => (p === "/token" ? "ghp_read\n" : event) });
    assert.equal(result.allow, false);
    assert.match(result.reason, /names no (pull request number|head commit); re-run refused/);
    assert.deepEqual(urls(fake.calls), [RUN]);
  }
});

test("runner hook (Decision 1b93760d): gitleaks.yml and trivy.yml may be re-run once on the current head", async () => {
  for (const overrides of [GITLEAKS, TRIVY]) {
    const file = workflowPathOf(env(overrides));
    let { result, calls } = await rerun(2, overrides);
    assert.equal(result.allow, true, file);
    assert.equal(result.reason, `pull request #9 changes no workflow; run attempt 2 of ${file} on the current head (one re-run allowed)`);
    assert.deepEqual(urls(calls), [RUN, PULLS, `${COMPARE}${HEAD}`], "no gate job is looked for");
    for (const n of [3, 4]) {
      ({ result, calls } = await rerun(n, overrides));
      assert.equal(result.allow, false, `${file} attempt ${n}`);
      assert.equal(result.reason, `pull request #9, run attempt ${n}: ${file} may be re-run once (attempt 2) only`);
      assert.deepEqual(urls(calls), [RUN, PULLS]);
    }
  }
});

test("runner hook (Task 26cced7e): another ungated workflow may be re-run once, only as main has it", async () => {
  const BUDGET = { GITHUB_JOB: "runner-budget-policy", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/runner-budget-policy.yml@refs/pull/9/merge" };
  const FILE = `${API}/contents/.github/workflows/runner-budget-policy.yml?ref=`;
  const text = (yaml) => Buffer.from(yaml, "utf8").toString("base64");
  const UNGATED = text("name: runner-budget-policy\njobs:\n  runner-budget-policy:\n    timeout-minutes: 20\n    runs-on: [self-hosted]\n");
  // The run's own commit (GITHUB_SHA) is compared with main (review NIT-1).
  const blobs = (head, main, content = UNGATED, headType = "file") => ({ [`${FILE}${SHA}`]: { body: { type: headType, sha: head, encoding: "base64", content } },
    [`${FILE}main`]: { body: { type: "file", sha: main, encoding: "base64", content } } });
  const ungated = (n) => ({ [JOBS(n)]: jobsOf(heavyJob({ name: "runner-budget-policy", run_attempt: n })) });
  let { result, calls } = await rerun(2, BUDGET, { ...ungated(2), ...blobs("c".repeat(40), "c".repeat(40)) });
  assert.equal(result.allow, true);
  assert.equal(result.reason, "pull request #9 changes no workflow; run attempt 2 of .github/workflows/runner-budget-policy.yml on the current head: "
    + "no admission-gate job, the file is main's (one re-run allowed)");
  assert.deepEqual(urls(calls).sort(), [RUN, PULLS, `${JOBS(2)}?per_page=100`, `${FILE}${SHA}`, `${FILE}main`, `${COMPARE}${HEAD}`].sort());
  // Only once.
  ({ result, calls } = await rerun(3, BUDGET, { ...ungated(3), ...blobs("c".repeat(40), "c".repeat(40)) }));
  assert.equal(result.allow, false);
  assert.equal(result.reason, "pull request #9, run attempt 3: attempt 3 lists no admission-gate job (attempt 3 has no admission-gate job); "
    + "a workflow without one may be re-run once (attempt 2) only");
  assert.equal(calls.some((c) => c.url.startsWith(FILE)), false);
  // A copy the pull request changed, added or that cannot be read is not re-run.
  for (const [label, script] of [["changed", blobs("d".repeat(40), "c".repeat(40))],
    ["added", { [`${FILE}${SHA}`]: { body: { type: "file", sha: "d".repeat(40) } }, [`${FILE}main`]: { status: 404, body: null } }],
    ["not a file", blobs(null, null)], ["a symlink", blobs("c".repeat(40), "c".repeat(40), UNGATED, "symlink")]]) {
    ({ result } = await rerun(2, BUDGET, { ...ungated(2), ...script }));
    assert.equal(result.allow, false, label);
    assert.match(result.reason, /lists no admission-gate job, but \.github\/workflows\/runner-budget-policy\.yml: its file at a{40} is not main's; an ungated workflow is re-run only as main has it$/, label);
  }
  // A gated workflow whose attempt lists no gate job (a single-job re-run) is not taken for an ungated one.
  const GATED = text("name: g4\njobs:\n  admission-gate:\n    runs-on: [self-hosted]\n  heavy:\n    needs: admission-gate\n");
  ({ result } = await rerun(2, BUDGET, { ...ungated(2), ...blobs("c".repeat(40), "c".repeat(40), GATED) }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /main's copy has an admission-gate job, so it re-runs only with "Re-run all jobs"/);
  // A file GitHub returns without content (over 1 MB) is not read as ungated.
  ({ result } = await rerun(2, BUDGET, { ...ungated(2), [`${FILE}${SHA}`]: { body: { type: "file", sha: "c".repeat(40), encoding: "none", content: "" } },
    [`${FILE}main`]: { body: { type: "file", sha: "c".repeat(40), encoding: "none", content: "" } } }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /main's copy cannot be read/);
  // No literal timeout, or one over the cap: not a short check (review MINOR-1).
  for (const [label, yaml, why] of [["no timeout", "jobs:\n  m0:\n    runs-on: [self-hosted]\n", /job m0 has no literal timeout-minutes/],
    ["long timeout", "jobs:\n  m0:\n    timeout-minutes: 360\n    runs-on: [self-hosted]\n", /job m0 may run 360 minutes \(cap 30\)/]]) {
    ({ result } = await rerun(2, BUDGET, { ...ungated(2), ...blobs("c".repeat(40), "c".repeat(40), text(yaml)) }));
    assert.equal(result.allow, false, label);
    assert.match(result.reason, why, label);
  }
  ({ result } = await rerun(2, BUDGET, { ...ungated(2), [`${FILE}${SHA}`]: { status: 500, body: null } }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /cannot compare \.github\/workflows\/runner-budget-policy\.yml with main/);
  // The workflow-change rule still applies afterwards: a pull request that changes a workflow needs its successful Native admission.
  ({ result } = await rerun(2, BUDGET, { ...ungated(2), ...blobs("c".repeat(40), "c".repeat(40)),
    [COMPARE]: files(".github/workflows/other.yml"), [NATIVE]: { body: { total_count: 1, check_runs: [nativeCheck({ conclusion: "failure" })] } } }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /changes \.github\/workflows\/other\.yml; Native admission 80: not admitted/);
  // A gated workflow is still judged by its gate: a gate that did not run again in this attempt refuses.
  ({ result } = await rerun(2, HEAVY, { [JOBS(2)]: jobsOf(heavyJob(), gateJob({ started_at: "2026-10-04T05:30:00Z" })) }));
  assert.equal(result.allow, false);
  assert.match(result.reason, /not in this attempt: it was not re-run/);
});

test("runner hook (Task 26cced7e, review MINOR-2/3): the short-check reading agrees with the gate guard on every workflow of this branch", async () => {
  // Any mention of admission-gate counts as gated (fail closed): CRLF, comments and quoted keys included.
  for (const yaml of ["jobs:\r\n  admission-gate:\r\n    timeout-minutes: 5\r\n", "jobs:\n  admission-gate: # gate\n    timeout-minutes: 5\n",
    "jobs:\n  'admission-gate':\n    timeout-minutes: 5\n", "jobs:\n  check:\n    timeout-minutes: 5\n    needs: [admission-gate]\n"]) {
    assert.deepEqual(shortCheckFindings(yaml), ["names admission-gate"], JSON.stringify(yaml));
  }
  assert.deepEqual(shortCheckFindings("jobs:\r\n  a:\r\n    timeout-minutes: 20 # short\r\n  b:\r\n    timeout-minutes: 30\r\n"), []);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
  for (const name of fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file))) {
    const yaml = fs.readFileSync(path.join(dir, name), "utf8");
    const gatedHere = shortCheckFindings(yaml).includes("names admission-gate");
    assert.equal(gatedHere || !workflowIsGated(yaml), true, `${name}: the gate guard sees a gate the hook would miss`);
    if (workflowIsGated(yaml)) assert.equal(gatedHere, true, name);
  }
});

test("runner hook (re-review 3, N-R3): a re-run of a hand dispatch off main is still refused, after reading only the run", async () => {
  const dispatch = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/x" };
  for (const [overrides, script] of [
    [{ ...dispatch, GITHUB_RUN_ATTEMPT: "2" }, { [RUN]: rerunOf(2) }],
    [{ ...dispatch, GITHUB_RUN_ATTEMPT: "2" }, {}],
    [dispatch, { [RUN]: rerunOf(2) }],
    [{ ...dispatch, GITHUB_RUN_ATTEMPT: "3", ...GATE }, { [RUN]: rerunOf(3) }],
  ]) {
    const { result, calls } = await run(overrides, { [PULLS]: pull(), [JOBS(2)]: jobsOf(gateJob(), heavyJob()), ...script });
    assert.equal(result.allow, false, JSON.stringify(overrides));
    assert.match(result.reason, /^workflow_dispatch on refs\/heads\/feature\/x: run attempt [23]; re-runs are refused, push a new commit$/);
    assert.deepEqual(urls(calls), [RUN], "nothing else is read");
  }
  // main's own runs may be re-run, the admission workflow's (pull_request_target) without limit.
  for (const [event, n] of [["push", "2"], ["schedule", "3"], ["pull_request_target", "7"], ["workflow_dispatch", "2"]]) {
    const { result, calls } = await run({ GITHUB_RUN_ATTEMPT: n, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main" }, {});
    assert.deepEqual([result.allow, calls.length], [true, 0], event);
  }
  // Without a run id the check fails closed.
  await assert.rejects(run({ GITHUB_RUN_ID: "" }, { [COMPARE]: files("apps/x.ts") }), /GITHUB_RUN_ID is not a run id/);
});

test("runner hook: the run attempt on the runner and on GitHub must agree", async () => {
  for (const [label, overrides, apiRun] of [
    ["runner 2, GitHub 1", { GITHUB_RUN_ATTEMPT: "2", ...GATE }, thisRun()],
    ["runner unset, GitHub 2", { ...GATE }, rerunOf(2)],
    ["runner 1, GitHub 2", { GITHUB_RUN_ATTEMPT: "1", ...HEAVY }, rerunOf(2)],
    ["runner 3, GitHub 2", { GITHUB_RUN_ATTEMPT: "3", ...HEAVY }, rerunOf(2)],
    ["runner not a number", { GITHUB_RUN_ATTEMPT: "two", ...GATE }, rerunOf(2)],
    ["runner 0", { GITHUB_RUN_ATTEMPT: "0" }, thisRun({ run_attempt: 0 })],
    ["GitHub without run_attempt", { GITHUB_RUN_ATTEMPT: "1" }, thisRun({ run_attempt: undefined })],
    ["GitHub run_attempt not a number", { GITHUB_RUN_ATTEMPT: "2", ...GITLEAKS }, rerunOf("2x")],
  ]) {
    const { result, calls } = await run(overrides, { [RUN]: apiRun, [PULLS]: pull(), [JOBS(2)]: jobsOf(gateJob(), heavyJob()),
      [COMPARE]: files("apps/x.ts") });
    assert.equal(result.allow, false, label);
    assert.match(result.reason, /^pull request #9: run attempt .* on the runner and .* on GitHub do not agree; refused$/, label);
    assert.deepEqual(urls(calls), [RUN], `${label}: nothing else is read`);
  }
  // Attempt 1 on both (the runner always sets GITHUB_RUN_ATTEMPT; unset counts as 1).
  for (const overrides of [{}, { GITHUB_RUN_ATTEMPT: "1" }]) {
    const { result, calls } = await run(overrides, { [COMPARE]: files("apps/x.ts") });
    assert.deepEqual([result.allow, result.reason], [true, "pull request #9 changes no workflow"]);
    assert.deepEqual(urls(calls), [RUN, `${COMPARE}${HEAD}`], "a first attempt reads neither the pull request nor the jobs");
  }
});

test("runner hook (re-review 3, N-R1): a re-run of a pull request that changes a workflow still needs its successful Native admission", async () => {
  const change = { [COMPARE]: files(".github/workflows/heavy.yml") };
  for (const overrides of [HEAVY, GATE, GITLEAKS]) {
    for (const native of [[nativeCheck({ conclusion: "failure" })], []]) {
      const { result, calls } = await rerun(2, overrides, { ...change, [NATIVE]: { body: { total_count: native.length, check_runs: native } } });
      assert.equal(result.allow, false, `${overrides.GITHUB_JOB}: ${JSON.stringify(native)}`);
      assert.match(result.reason, /^pull request #9 changes \.github\/workflows\/heavy\.yml; Native admission (80|absent): not admitted .*; run attempt 2 (of \S+ )?on the current head/);
      assert.equal(calls.some((c) => c.url.startsWith(ADMISSION_RUNS)), false);
    }
  }
  // The re-run check comes first: a refused re-run never reaches the admission.
  const { result, calls } = await rerun(2, HEAVY, { ...change, [JOBS(2)]: jobsOf(gateJob({ started_at: "2026-10-04T05:00:04Z" })) });
  assert.equal(result.allow, false);
  assert.equal(calls.some((c) => c.url.startsWith(NATIVE) || c.url.startsWith(COMPARE)), false);
});

// Defect B (2026-11-15, PR #1121 run 43720693841, #1122 run 43720708199): a pull request that changes a workflow is pushed long
// before it is the train's front; every job of attempt 1 waits the hook's limit and is refused in "Set up runner" ("Native admission
// absent"). The Native check comes later (14:11:36), the resident's lane asks for "Re-run all jobs" once, and attempt 2 was refused
// only for being attempt 2 ("Native admission 132838811702: not admitted (... rerun)"), so a new commit had to be pushed by hand.
// Now the first attempt that runs anything is the run's one run: a later attempt starts when every earlier attempt ran nothing.
const lateStep = (name, conclusion) => ({ name, status: "completed", conclusion });
// The measured shape of a job the hook refused (job 132831819306): the runner's "Set up job", then this hook's "Set up runner".
const refusedInSetup = (overrides = {}) => ({ id: 70, name: "admission-gate", status: "completed", conclusion: "failure", run_attempt: 1,
  labels: SELF_HOSTED, steps: [lateStep("Set up job", "success"), lateStep("Set up runner", "failure"),
    lateStep("Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "skipped"),
    lateStep("Run node scripts/ci/clued-work-admission.mjs --mode gate", "skipped"), lateStep("Complete job", "success")], ...overrides });
const skippedHeavy = (overrides = {}) => ({ id: 71, name: "ci-suites", status: "completed", conclusion: "skipped", run_attempt: 1, steps: [], ...overrides });
const lateCheck = nativeCheck({ started_at: "2026-10-04T05:30:00Z", completed_at: "2026-10-04T05:30:00Z" });
const lateRerun = (n, who, earlier, overrides = {}) => run({ GITHUB_RUN_ATTEMPT: String(n), ...who }, {
  ...nativeScript(lateCheck), [RUN]: rerunOf(n), [JOBS(n)]: jobsOf(gateJob({ run_attempt: n }), heavyJob({ run_attempt: n })),
  ...Object.fromEntries(earlier.map((jobs, i) => [JOBS(i + 1), jobs])), ...overrides });

test("Native hook: workflow-changing required-tests PRs may repair a timeout, but never a test failure", async () => {
  const incident = JSON.parse(fs.readFileSync(new URL("../ci/fixtures/required-tests-timeout-1159.json", import.meta.url), "utf8"));
  const workflow = ".github/workflows/clued-required-tests.yml";
  const failedJob = 134709790262;
  const annotations = `${API}/check-runs/${failedJob}/annotations`;
  const logs = `${API}/actions/jobs/${failedJob}/logs`;
  const recorded = jobs => jobsOf(...jobs.map(job => ({ ...job, head_sha: HEAD })));
  const past = recorded(incident.first_jobs);
  const second = recorded(incident.second_jobs);
  const secondNotes = `${API}/check-runs/134727693143/annotations`;
  const options = {
    [RUN]: rerunOf(2, { event: "pull_request", head_sha: HEAD, workflow_id: incident.workflow_id, path: workflow }),
    [annotations]: { body: incident.timeout_annotations },
    [logs]: { text: "2026-11-18T10:08:08.8314618Z ##[error]The operation was canceled." },
    [secondNotes]: { body: incident.refused_annotation },
  };
  const target = { GITHUB_JOB: "migration-verify", GITHUB_WORKFLOW_REF: `o/r/${workflow}@refs/pull/9/merge` };
  for (const who of [GATE, target]) {
    const { result, calls } = await lateRerun(2, { ...target, ...who }, [past], options);
    assert.equal(result.allow, true, result.reason);
    assert.ok(calls.some(call => call.url.startsWith(annotations)));
    assert.ok(calls.some(call => call.url === logs));
  }
  const refused = await lateRerun(2, target, [past], { ...options, [logs]: { text: incident.migration_log_excerpt } });
  assert.equal(refused.result.allow, false);
  assert.match(refused.result.reason, /already ran/);
  const later = await lateRerun(3, target, [past, second], { ...options, [RUN]: rerunOf(3,
    { event: "pull_request", head_sha: HEAD, workflow_id: incident.workflow_id, path: workflow }) });
  assert.equal(later.result.allow, true, later.result.reason);
});

test("Native hook (defect B): a re-run of a workflow-changing pull request starts when every earlier attempt ran nothing", async () => {
  for (const who of [GATE, HEAVY]) {
    const { result, calls } = await lateRerun(2, who, [jobsOf(refusedInSetup(), skippedHeavy(), skippedHeavy({ id: 72, name: "migration-verify" }))]);
    assert.equal(result.allow, true, who.GITHUB_JOB);
    assert.match(result.reason, /Native admission 80: succeeded/);
    assert.ok(urls(calls).includes(`${JOBS(1)}?per_page=100`), "the earlier attempt's jobs were read");
  }
  // Two attempts that ran nothing (the runner itself failed "Set up job" in attempt 2): attempt 3 is still the first real run.
  const setupJob = refusedInSetup({ id: 73, run_attempt: 2, steps: [lateStep("Set up job", "failure"), lateStep("Complete job", "success")] });
  assert.equal((await lateRerun(3, HEAVY, [jobsOf(refusedInSetup(), skippedHeavy()), jobsOf(setupJob, skippedHeavy({ run_attempt: 2 }))])).result.allow, true);
});

test("Native hook (defect B): an earlier attempt that ran anything, or that cannot be read, refuses; one admitted head runs once", async () => {
  const ranGate = refusedInSetup({ conclusion: "success", steps: [lateStep("Set up job", "success"), lateStep("Set up runner", "success"),
    lateStep("Run node scripts/ci/clued-work-admission.mjs --mode gate", "success"), lateStep("Complete job", "success")] });
  const cases = {
    "the gate ran and succeeded": [jobsOf(ranGate, skippedHeavy())],
    "the gate ran and failed in its own step": [jobsOf(refusedInSetup({ steps: [lateStep("Set up job", "success"), lateStep("Set up runner", "success"),
      lateStep("Run node scripts/ci/clued-work-admission.mjs --mode gate", "failure"), lateStep("Complete job", "success")] }), skippedHeavy())],
    "a workflow step named like the hook": [jobsOf(refusedInSetup({ steps: [lateStep("Set up job", "success"), lateStep("Set up runner", "success"),
      lateStep("Set up runner", "failure"), lateStep("Complete job", "success")] }), skippedHeavy())],
    "a heavy job ran": [jobsOf(refusedInSetup(), skippedHeavy({ conclusion: "failure", steps: [lateStep("Set up job", "success"), lateStep("Set up runner", "success"), lateStep("Run tests", "failure")] }))],
    "a cancelled job": [jobsOf(refusedInSetup(), skippedHeavy({ conclusion: "cancelled" }))],
    "a job still running": [jobsOf(refusedInSetup({ status: "in_progress", conclusion: null }), skippedHeavy())],
    "a failed job with no step record": [jobsOf(refusedInSetup({ steps: undefined }), skippedHeavy())],
    "an incomplete job list": [{ body: { total_count: 3, jobs: [refusedInSetup(), skippedHeavy()] } }],
    "no job list": [{ body: { message: "nope" } }],
    "attempt 2 ran, attempt 1 did not": [jobsOf(refusedInSetup(), skippedHeavy()), jobsOf(ranGate, skippedHeavy())],
  };
  for (const [label, earlier] of Object.entries(cases)) {
    const { result } = await lateRerun(earlier.length + 1, HEAVY, earlier);
    assert.equal(result.allow, false, label);
    assert.match(result.reason, /Native admission 80: not admitted/, label);
    assert.match(result.reason, /earlier attempt|attempt \d/, label);
  }
  // Not admitted (yet): the earlier attempts are not read at all.
  const { result, calls } = await run({ GITHUB_RUN_ATTEMPT: "2", ...GATE, CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" },
    { ...nativeScript(), [RUN]: rerunOf(2), [JOBS(1)]: jobsOf(refusedInSetup(), skippedHeavy()) });
  assert.equal(result.allow, false);
  assert.equal(urls(calls).some((u) => u.startsWith(JOBS(1))), false);
});

test("runner hook (re-review 3, N-R2): only the dispatch-gated workflows may be dispatched off main", async () => {
  // clued-standard-runner-actor-qualification.yml is admitted by the admission script but runs on main only (both qualification jobs require github.ref == refs/heads/main),
  // so the hook must keep refusing its dispatch on any other branch: it is the one deliberate difference.
  const MAIN_ONLY_ADMITTED = ["clued-standard-runner-actor-qualification.yml"];
  assert.deepEqual(DISPATCH_GATED_WORKFLOWS, ADMISSION_DISPATCH_GATED.filter((file) => !MAIN_ONLY_ADMITTED.includes(file)), "the admission script's list without the main-only workflows");
  for (const file of DISPATCH_GATED_WORKFLOWS) {
    const dispatch = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature/x",
      GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${file}@refs/heads/feature/x` };
    const same = { [file]: "1".repeat(40), "trivy.yml": "2".repeat(40) };
    const identical = { [`${LIST}${SHA}`]: listing(same), [`${LIST}main`]: listing(same) };
    const permitted = await run(dispatch, identical);
    assert.equal(permitted.result.allow, true, `${file}: identical workflows`);
    const changed = await run(dispatch, { ...identical, [`${LIST}${SHA}`]: listing({ ...same, [file]: "9".repeat(40) }) });
    assert.equal(changed.result.allow, false, `${file}: changed workflow`);
    assert.match(changed.result.reason, /workflows differ from main/);
    const rerun = await run({ ...dispatch, GITHUB_RUN_ATTEMPT: "2" }, { ...identical, [RUN]: thisRun({ run_attempt: 2 }) });
    assert.equal(rerun.result.allow, false, `${file}: branch dispatch rerun`);
    assert.match(rerun.result.reason, /re-runs are refused/);
    assert.deepEqual(rerun.calls.map((c) => c.url), [RUN]);
  }
  for (const file of ["clued-integration-runtime-nightly.yml", "mps03-native-agent.yml", "trivy.yml", "clued-standard-runner-actor-qualification.yml"]) {
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

test("runner hook (Decision d8bc893c): with its read-only App configured, the hook calls GitHub as that App", async () => {
  assert.equal(ADMISSION_APP_ID, ADMISSION_APP, "the same id as the admission script");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const INSTALLATION = "https://api.github.com/repos/o/r/installation";
  const MINT = "https://api.github.com/app/installations/77/access_tokens";
  const NOW = 1_790_000_000;
  const reads = [];
  const readFile = (p) => { reads.push(p); return p === "/app.pem" ? pem : p === "/token" ? "ghp_personal\n" : prEvent(); };
  const decideWith = (overrides, script) => {
    const fake = fakeFetch({ [INSTALLATION]: { body: { id: 77 } }, [MINT]: { status: 201, body: { token: "ghs_app" } },
      [RUN]: thisRun(), [COMPARE]: files("apps/x.ts"), ...script });
    return decide({ env: env({ CLUED_RUNNER_HOOK_APP_ID: "4242", CLUED_RUNNER_HOOK_APP_KEY_FILE: "/app.pem", ...overrides }),
      fetchImpl: fake.fetchImpl, readFile, now: () => NOW * 1000, sleep: async () => {} })
      .then((result) => ({ result, calls: fake.calls }), (error) => ({ error: error.message, calls: fake.calls }));
  };

  const { result, calls } = await decideWith({}, {});
  assert.equal(result.allow, true);
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", INSTALLATION], ["POST", MINT], ["GET", RUN], ["GET", `${COMPARE}${HEAD}`]]);
  // The App's JWT, signed with its key, asks for the installation token.
  const jwt = calls[0].auth.replace(/^Bearer /, "");
  assert.equal(calls[1].auth, `Bearer ${jwt}`);
  const [header, payload, signature] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature, "base64url")), true);
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), { iat: NOW - 60, exp: NOW + 540, iss: "4242" });
  // This repository only, actions, contents and pull requests read only, whatever else the App holds.
  assert.deepEqual(JSON.parse(calls[1].body), { repositories: ["r"], permissions: { actions: "read", contents: "read", pull_requests: "read" } });
  // Every other call uses the installation token; the personal token file is not read.
  assert.deepEqual(calls.slice(2).map((c) => c.auth), ["Bearer ghs_app", "Bearer ghs_app"]);
  assert.equal(reads.includes("/token"), false);

  // A re-run must use the App installation token for the live pull request
  // read, both for the gate and for a job that waits on the fresh gate.
  for (const job of [GATE, HEAVY]) {
    const current = await decideWith({ ...job, GITHUB_RUN_ATTEMPT: "2" }, {
      [RUN]: rerunOf(2), [PULLS]: pull(), [JOBS(2)]: jobsOf(gateJob(), heavyJob()),
    });
    assert.equal(current.result.allow, true, job.GITHUB_JOB);
    const pullRead = current.calls.find((c) => c.url === PULLS);
    assert.deepEqual([pullRead.method, pullRead.auth], ["GET", "Bearer ghs_app"], job.GITHUB_JOB);
    assert.equal(current.calls.some((c) => c.url.startsWith(JOBS(2))), job === HEAVY);
  }
  // Adding the read scope must not admit a re-run when GitHub still refuses
  // the pull request read (for example, an installation not yet approved).
  const refused = await decideWith({ ...GATE, GITHUB_RUN_ATTEMPT: "2" }, {
    [RUN]: rerunOf(2), [PULLS]: { status: 403, body: null },
  });
  assert.equal(refused.result.allow, false);
  assert.match(refused.result.reason, /cannot read the pull request .*returned 403.*re-run refused/);
  assert.equal(refused.calls.some((c) => c.url.startsWith(COMPARE) || c.url.startsWith(JOBS(2))), false);

  const onMain = await decideWith({ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, {});
  assert.deepEqual([onMain.result.allow, onMain.calls.length], [true, 0], "main's own runs mint no token");

  // The admission App's key would let any job post the admission checks.
  const admission = await decideWith({ CLUED_RUNNER_HOOK_APP_ID: String(ADMISSION_APP_ID) }, {});
  assert.match(admission.error, /is the clued-admission App; its key must not be on a runner/);
  assert.equal(admission.calls.length, 0);
  const nativeProducer = await decideWith({ CLUED_RUNNER_HOOK_APP_ID: "5368905" }, {});
  assert.equal(nativeProducer.calls.length, 0, "the Native publisher's key must never be read on a runner");
  assert.match(nativeProducer.error, /its key must not be on a runner/);
  const mintTime = new Date(NOW * 1000).toISOString();
  const native = await decideWith({}, { ...nativeScript(nativeCheck({ started_at: mintTime, completed_at: mintTime })),
    [RUN]: thisRun({ created_at: mintTime }) });
  assert.equal(native.result.allow, true);
  const mints = native.calls.filter(c => c.url === MINT).map(c => JSON.parse(c.body));
  assert.deepEqual(mints, [
    { repositories: ["r"], permissions: { actions: "read", contents: "read", pull_requests: "read" } },
    { repositories: ["r"], permissions: { actions: "read", contents: "read", pull_requests: "read", checks: "read" } },
  ]);
  // A half-configured App fails; it never falls back to the token file.
  reads.length = 0;
  assert.match((await decideWith({ CLUED_RUNNER_HOOK_APP_KEY_FILE: "" }, {})).error, /CLUED_RUNNER_HOOK_APP_KEY_FILE is not set/);
  assert.match((await decideWith({ CLUED_RUNNER_HOOK_APP_ID: "" }, {})).error, /CLUED_RUNNER_HOOK_APP_ID is not set to an App id/);
  assert.equal(reads.includes("/token"), false);
  assert.match((await decideWith({}, { [INSTALLATION]: { status: 404, body: null } })).error, /installation returned 404/);
  assert.match((await decideWith({}, { [MINT]: { status: 403, body: null } })).error, /access_tokens returned 403/);
  assert.match((await decideWith({}, { [MINT]: { status: 201, body: {} } })).error, /returned no installation token/);
});

// Since the loader (runner-hook-loader-v1) the component is this file itself, run from main: no immutable per-version copy is added.
test("the hook component is the file runners load from main; the earlier immutable sources stay for their pins", () => {
  assert.equal(COMPONENT_VERSION, "1.0.7");
  const manifest = JSON.parse(fs.readFileSync(new URL("../../config/clued-components.json", import.meta.url), "utf8"));
  const component = manifest.components.find((c) => c.id === "hook.runner-job-started");
  assert.deepEqual([component.version, component.files, component.version_marker.file], [COMPONENT_VERSION, ["clued-runner-job-started.mjs"], "clued-runner-job-started.mjs"]);
  for (const [name, version] of [["required-tests-late-admission-v1", "1.0.3"], ["work-handover-native-admission-retry-v1", "1.0.2"], ["work-handover-native-admission-v1", "1.0.1"]]) {
    const earlier = fs.readFileSync(new URL(`./clued-runner-job-started.${name}.mjs`, import.meta.url), "utf8");
    assert.ok(earlier.includes(`export const COMPONENT_VERSION = "${version}";`), name);
  }
});

// ---- Transient reads (work-handover-native-admission-retry-v1, component 1.0.2; Task 5cee3629) ----
// Network cuts simulated by the fake fetch: a throw is a rejected fetch (ECONNRESET), a 503 a gateway answer.
const cut = (failures, answer, error = () => { throw new Error("ECONNRESET"); }) => {
  let calls = 0;
  const fn = () => { calls += 1; return calls <= failures ? error() : answer; };
  fn.count = () => calls;
  return fn;
};

test("transient reads: the Native kooyumi-work-admission read cut by the network is read again within the wait and admits", async () => {
  // poll 1: three attempts cut; poll 2: one more cut, then the check
  const native = cut(4, { body: { total_count: 1, check_runs: [nativeCheck()] } });
  const { result, sleeps } = await run({}, { ...nativeScript(nativeCheck()), [NATIVE]: native });
  assert.equal(result.allow, true, result.reason);
  assert.match(result.reason, /Native admission 80: succeeded/);
  assert.equal(native.count(), 5);
  assert.deepEqual(sleeps, [...READ_RETRY_DELAYS_MS, 10_000, READ_RETRY_DELAYS_MS[0]]);
});

test("transient reads: a 503 that lasts the whole wait refuses with that failure (fail closed); 403 and malformed are final at once", async () => {
  const always = cut(Infinity, null, () => ({ status: 503, body: null }));
  await assert.rejects(run({}, { ...nativeScript(nativeCheck()), [NATIVE]: always }), /returned 503/);
  // CLUED_RUNNER_HOOK_WAIT_SECONDS 20: polls at 0, 10 and 20 s, three attempts each
  assert.equal(always.count(), 3 * READ_ATTEMPTS);
  const forbidden = cut(Infinity, null, () => ({ status: 403, body: null }));
  await assert.rejects(run({}, { ...nativeScript(nativeCheck()), [NATIVE]: forbidden }), /returned 403/);
  assert.equal(forbidden.count(), 1, "403 is not tried again");
  const malformed = cut(0, { body: { total_count: 1, check_runs: "x" } });
  await assert.rejects(run({}, { ...nativeScript(nativeCheck()), [NATIVE]: malformed }), /incomplete or malformed/);
  assert.equal(malformed.count(), 1);
});

test("transient reads: a re-run's admission-gate job is polled through a cut", async () => {
  const jobs = cut(3, jobsOf(gateJob(), heavyJob()));
  const gate = await rerun(2, HEAVY, { [JOBS(2)]: jobs });
  assert.equal(gate.result.allow, true, gate.result.reason);
  assert.equal(jobs.count(), 4);
  // a cut that outlasts the wait still refuses the re-run, naming the failure
  const gone = cut(Infinity, null);
  const refused = await rerun(2, HEAVY, { [JOBS(2)]: gone });
  assert.equal(refused.result.allow, false);
  assert.match(refused.result.reason, /cannot read attempt 2's jobs \(ECONNRESET\); re-run refused/);
});

test("transient reads: the App token mint and the execution_current observation are tried again; a write never is", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const INSTALLATION = "https://api.github.com/repos/o/r/installation";
  const MINT = "https://api.github.com/app/installations/77/access_tokens";
  const mint = cut(2, { status: 201, body: { token: "ghs_app" } }, () => ({ status: 502, body: null }));
  const fake = fakeFetch({ [INSTALLATION]: { body: { id: 77 } }, [MINT]: mint, [RUN]: thisRun(), [COMPARE]: files("apps/x.ts") });
  const result = await decide({ env: env({ CLUED_RUNNER_HOOK_APP_ID: "4242", CLUED_RUNNER_HOOK_APP_KEY_FILE: "/app.pem" }), fetchImpl: fake.fetchImpl,
    readFile: (p) => (p === "/app.pem" ? pem : prEvent()), sleep: async () => {} });
  assert.equal(result.allow, true, result.reason);
  assert.equal(mint.count(), 3);
  // the execution_current observation
  const { url, key } = resolvePublicSupabaseConfig({}, path.resolve(import.meta.dirname, "../.."));
  const rpc = `${url}/rest/v1/rpc/clued_work_verify_v1`;
  const config = `${API}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`;
  const observation = cut(1, { body: { status: "ok", guard_required: true, epoch_current: true } });
  const epoch = fakeFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()),
    [config]: { body: { type: "file", encoding: "base64", content: Buffer.from(`return { url: "${url}", key: "${key}" };`).toString("base64") } },
    [rpc]: observation });
  const current = await decideWithCurrentEpoch({ env: env(), fetchImpl: epoch.fetchImpl, sleep: async () => {}, readFile: p => p === "/token" ? "ghp_read" : prEvent() });
  assert.equal(current.allow, true, current.reason);
  assert.equal(observation.count(), 2);
  // the wrapper itself: only reads (GET, or a POST its caller marks) are tried again; wrapping twice adds nothing; every attempt has a
  // time bound of its own, a new one each time; the read marks never reach the network
  const seen = [];
  const raw = async (u, init) => { seen.push([init.method ?? "GET", String(u), init.signal, Object.hasOwn(init, "retryRead") || Object.hasOwn(init, "attemptMs")]);
    return { status: 503, json: async () => null }; };
  const wrapped = retryingFetch(raw, { sleep: async () => {} });
  assert.equal(retryingFetch(wrapped), wrapped);
  assert.equal((await wrapped("https://api.github.com/repos/o/r/issues", { method: "POST" })).status, 503);
  assert.equal((await wrapped(rpc, { method: "POST" })).status, 503, "the RPC URL alone does not make a read");
  assert.equal(seen.length, 2, "a POST that is not marked as a read is never repeated");
  assert.equal((await wrapped("https://api.github.com/repos/o/r/pulls/9", {})).status, 503);
  assert.equal((await wrapped(rpc, { method: "POST", retryRead: true, attemptMs: OBSERVATION_ATTEMPT_MS })).status, 503);
  assert.equal(seen.length, 2 + 2 * READ_ATTEMPTS);
  const signals = seen.slice(2).map(([, , signal]) => signal);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal), "a time bound per attempt");
  assert.equal(new Set(signals).size, signals.length, "a new one each attempt");
  assert.ok(seen.every(([, , , marks]) => !marks), "retryRead and attemptMs are not sent");
  const rejecting = retryingFetch(async () => { throw new TypeError("fetch failed"); }, { sleep: async () => {} });
  await assert.rejects(rejecting("https://api.github.com/x", {}), (error) => error.transient === true && /fetch failed/.test(error.message));
  assert.equal(READ_RETRY_DELAYS_MS.length, READ_ATTEMPTS - 1);
  assert.equal(waitLimitSeconds({}), 480);
  assert.equal(waitLimitSeconds({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "20" }), 20);
});

// ---- the clock (review of 1.0.2: MAJOR-1, MAJOR-2, MINOR-1, MINOR-2) ----
// A fake clock: sleeps advance it; an attempt that hangs advances it by its own time bound and fails as AbortSignal.timeout would.
function clockFor(startMs) {
  let clock = startMs;
  const h = { now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutSignal: (ms) => ({ fakeTimeoutMs: ms }), bounds: [] };
  h.hang = (init) => { h.bounds.push(init.signal.fakeTimeoutMs); clock += init.signal.fakeTimeoutMs; throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
  h.elapsed = () => clock - startMs;
  return h;
}
// fakeFetch, with `intercept(url, init)` answering first (undefined: the script answers).
function clockedFetch(script, intercept) {
  const base = fakeFetch(script);
  return { calls: base.calls, fetchImpl: async (url, init) => { const r = await intercept(String(url), init); return r === undefined ? base.fetchImpl(url, init) : r; } };
}
const decideAt = (h, fake, overrides = {}) => decide({ env: env(overrides), fetchImpl: fake.fetchImpl, now: h.now, sleep: h.sleep, timeoutSignal: h.timeoutSignal,
  readFile: (p) => (p === "/token" ? "ghp_read\n" : prEvent()) });

test("clock: a Native check that completed while its read was tried again is judged at the time it was seen, and admits (MAJOR-1)", async () => {
  const h = clockFor(Date.parse(RUN_CREATED) + 1_000);
  // the first read hangs for its full 30 s; the check completed 20 s after the run was created, inside that hang
  const late = nativeCheck({ completed_at: new Date(Date.parse(RUN_CREATED) + 20_000).toISOString() });
  let hung = false;
  const fake = clockedFetch({ [RUN]: thisRun(), ...nativeScript(late) }, (url, init) => {
    if (url.startsWith(NATIVE) && !hung) { hung = true; return h.hang(init); }
    return undefined;
  });
  const result = await decideAt(h, fake);
  assert.equal(result.allow, true, result.reason);
  assert.deepEqual(h.bounds, [READ_ATTEMPT_MS]);
});

test("clock: a check-runs endpoint that never answers ends the wait by the clock, inside twice the wait plus the read allowance (MAJOR-2)", async () => {
  const h = clockFor(Date.parse(RUN_CREATED) + 1_000);
  const fake = clockedFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()) }, (url, init) => (url.startsWith(NATIVE) ? h.hang(init) : undefined));
  await assert.rejects(decideAt(h, fake, { CLUED_RUNNER_HOOK_WAIT_SECONDS: "480" }), (error) => error.name === "TimeoutError" && error.transient === true);
  const oneCall = READ_ATTEMPTS * READ_ATTEMPT_MS + READ_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(h.elapsed() <= 480_000 + oneCall + 10_000, `${h.elapsed()} ms`);
  assert.ok(h.elapsed() <= 2 * 480_000 + READ_ALLOWANCE_MS, `${h.elapsed()} ms`);
  // a cut that fails at once (ECONNRESET) ends by the clock too: no longer 49 polls of 17 s
  const g = clockFor(Date.parse(RUN_CREATED) + 1_000);
  const fast = clockedFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()) }, (url) => { if (url.startsWith(NATIVE)) throw new TypeError("fetch failed"); return undefined; });
  await assert.rejects(decideAt(g, fast, { CLUED_RUNNER_HOOK_WAIT_SECONDS: "480" }), /fetch failed/);
  assert.ok(g.elapsed() <= 480_000 + 7_000 + 10_000, `${g.elapsed()} ms`);
  // a re-run's gate wait the same way
  const r = clockFor(Date.parse(RUN_STARTED) + 1_000);
  const gate = clockedFetch({ [RUN]: rerunOf(2), [PULLS]: pull(), [COMPARE]: files("apps/x.ts") }, (url, init) => (url.startsWith(JOBS(2)) ? r.hang(init) : undefined));
  const refused = await decide({ env: env({ ...HEAVY, GITHUB_RUN_ATTEMPT: "2", CLUED_RUNNER_HOOK_WAIT_SECONDS: "480" }), fetchImpl: gate.fetchImpl, now: r.now, sleep: r.sleep,
    timeoutSignal: r.timeoutSignal, readFile: (p) => (p === "/token" ? "ghp_read\n" : prEvent()) });
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /cannot read attempt 2's jobs/);
  assert.ok(r.elapsed() <= 480_000 + oneCall + 10_000, `${r.elapsed()} ms`);
});

test("clock: no read starts and no retry waits past the hook's read deadline (twice the wait plus the allowance)", async () => {
  const h = clockFor(0);
  const wrapped = retryingFetch(async (url, init) => h.hang(init), { sleep: h.sleep, now: h.now, deadlineAt: () => 31_000, timeoutSignal: h.timeoutSignal });
  await assert.rejects(wrapped("https://api.github.com/x", {}), (error) => error.transient === true);
  assert.deepEqual(h.bounds, [30_000], "the second attempt would not fit after its 2 s wait: none");
  const g = clockFor(0);
  const late = retryingFetch(async (url, init) => g.hang(init), { sleep: g.sleep, now: g.now, deadlineAt: () => 45_000, timeoutSignal: g.timeoutSignal });
  await assert.rejects(late("https://api.github.com/x", {}), (error) => error.transient === true);
  assert.deepEqual(g.bounds, [30_000, 13_000], "an attempt never runs past the deadline");
  const spent = retryingFetch(async () => { throw new Error("not reached"); }, { now: () => 50_000, deadlineAt: () => 45_000 });
  await assert.rejects(spent("https://api.github.com/x", {}), /time for reads is used up/);
});

test("bodies: a real 200 reply is read and admits; a 200 whose body is not JSON is refused at once, read once, not transient", async () => {
  const { result } = await run({}, nativeScript(nativeCheck()));
  assert.equal(result.allow, true);
  let reads = 0;
  const malformed = clockedFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()) }, (url) => {
    if (url.startsWith(NATIVE)) { reads += 1; return new Response("{not json", { status: 200 }); }
    return undefined;
  });
  const h = clockFor(Date.parse(RUN_CREATED) + 1_000);
  await assert.rejects(decideAt(h, malformed), (error) => error instanceof SyntaxError && error.transient !== true);
  assert.equal(reads, 1);
});

test("clock: a reply cut off while its body is read is a failed attempt, tried again (MINOR-1); the observation has its own 10 s bound (MINOR-2)", async () => {
  const h = clockFor(Date.parse(RUN_CREATED) + 1_000);
  let cut = true;
  const fake = clockedFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()) }, (url) => {
    if (url.startsWith(NATIVE) && cut) { cut = false; return { status: 200, text: async () => { throw new TypeError("terminated"); } }; }
    return undefined;
  });
  const result = await decideAt(h, fake);
  assert.equal(result.allow, true, result.reason);
  assert.equal(fake.calls.filter((c) => c.url.startsWith(NATIVE)).length, 1, "the cut reply came from the intercept; the script answered the second");
  // the execution_current observation: each attempt 10 s, its own
  const { url, key } = resolvePublicSupabaseConfig({}, path.resolve(import.meta.dirname, "../.."));
  const rpc = `${url}/rest/v1/rpc/clued_work_verify_v1`;
  const config = `${API}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=main`;
  const g = clockFor(Date.parse(RUN_CREATED) + 1_000);
  let hangs = 2;
  const epoch = clockedFetch({ [RUN]: thisRun(), ...nativeScript(nativeCheck()),
    [config]: { body: { type: "file", encoding: "base64", content: Buffer.from(`return { url: "${url}", key: "${key}" };`).toString("base64") } },
    [rpc]: { body: { status: "ok", guard_required: true, epoch_current: true } } }, (u, init) => {
    if (u === rpc) { assert.equal(Object.hasOwn(init, "retryRead") || Object.hasOwn(init, "attemptMs"), false); if (hangs-- > 0) return g.hang(init); }
    return undefined;
  });
  const current = await decideWithCurrentEpoch({ env: env(), fetchImpl: epoch.fetchImpl, now: g.now, sleep: g.sleep, timeoutSignal: g.timeoutSignal,
    readFile: (p) => (p === "/token" ? "ghp_read" : prEvent()) });
  assert.equal(current.allow, true, current.reason);
  assert.deepEqual(g.bounds, [OBSERVATION_ATTEMPT_MS, OBSERVATION_ATTEMPT_MS]);
});

// Fable 11-20 补“补跑上限的范围”: the budget is per run ID; a dispatch is a new run, admitted on its first attempt whatever earlier runs used.
test('required-tests dispatch: a new run, admitted in the hook whatever earlier runs of the workflow used', async () => {
  const pr = { number: 9, state: 'open', head: { sha: HEAD, ref: 'claude/g3', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const overrides = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/claude/g3', GITHUB_REF_NAME: 'claude/g3', GITHUB_SHA: HEAD,
    GITHUB_ACTOR: 'o', GITHUB_REPOSITORY_OWNER: 'o', GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-required-tests.yml@refs/heads/claude/g3' };
  const payload = JSON.stringify({ inputs: { pr: '9', head: HEAD }, repository: { default_branch: 'main' } });
  const script = { [`${LIST}${HEAD}`]: listing({ 'clued-required-tests.yml': '1'.repeat(40) }),
    [`${LIST}main`]: listing({ 'clued-required-tests.yml': '1'.repeat(40) }), [`${API}/pulls/9`]: { body: pr } };
  const runs = (...list) => ({ [`${API}/actions/workflows/clued-required-tests.yml/runs?head_sha=`]: { body: { total_count: list.length, workflow_runs: list } } });
  const self = { id: 555, head_sha: HEAD, run_attempt: 1 };
  assert.equal((await run(overrides, { ...script, ...runs(self, { id: 556, head_sha: HEAD, run_attempt: 2 }) }, payload)).result.allow, true, 'two attempts and this one: three');
  const used = await run(overrides, { ...script, ...runs(self, { id: 556, head_sha: HEAD, run_attempt: 3 }) }, payload);
  assert.equal(used.result.allow, true, used.result.reason);
});

// FABLE-scaffold-open-qs 问题 1 改法 1: the hook admits a pull request that changes a workflow on Native admission only. The
// legacy clued-work-admission.yml state no longer selects a route: enabling that workflow again must not let its
// pull_request_target success stand in for Native, and its state is not read at all (one GitHub read less per job).
test("Native only (scaffold open-qs 1.1): an active legacy workflow with a successful run on the head never admits without Native", async () => {
  const { result, calls } = await run({ CLUED_RUNNER_HOOK_WAIT_SECONDS: "0" }, { ...nativeScript(),
    [PRODUCER]: { body: { path: ".github/workflows/clued-work-admission.yml", state: "active" } },
    [ADMISSION_RUNS]: admissionRuns(admissionRun()) });
  assert.equal(result.allow, false, result.reason);
  assert.match(result.reason, /Native admission absent: not admitted/);
  assert.equal(calls.some(c => c.url.startsWith(PRODUCER)), false, "neither the workflow's state nor its runs are read");
});
test("Native only (scaffold open-qs 1.1): the legacy workflow's state is not read, so a 404 for it does not refuse a Native success", async () => {
  const { result, calls } = await run({}, { ...nativeScript(nativeCheck()), [PRODUCER]: { status: 404, body: { message: "Not Found" } } });
  assert.equal(result.allow, true, result.reason);
  assert.match(result.reason, /Native admission 80: succeeded/);
  assert.equal(calls.some(c => c.url.startsWith(PRODUCER)), false);
});
