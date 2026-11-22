import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {parseWorkflowProfiles,registeredWorkflowSource,rolesForSource,roleDefinitionDigest,workflowBlob} from "./clued-workflow-profile.mjs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {ACTOR_WORKFLOW,registeredActorTransition as actorSourceTransition} from './clued-standard-runner-actor-source.mjs';
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as admissionModule from './clued-work-admission.mjs';

function mechanicalGitFixture(before, after, headMode = '100644') {
  const repository = 'tdoljyj/cross-memory-system';
  const file = 'scripts/ci/clued-independent-publication-port.mjs';
  const url = `https://api.test/repos/${repository}`;
  const ids = ['1', '2', '3', '4', '5', '6'].map(c => c.repeat(40));
  const tree = entries => ({ body: { truncated: false, tree: entries } });
  const dir = (name, sha) => ({ path: name, sha, mode: '040000', type: 'tree' });
  const leaf = (sha, mode) => ({ path: path.basename(file), sha, mode, type: 'blob' });
  const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
  const response = value => ({ body: { encoding: 'base64', content: bytes(value).toString('base64') } });
  return fakeFetch({
    [`GET ${url}/git/trees/${BASE}`]: tree([dir('scripts', ids[0])]),
    [`GET ${url}/git/trees/${HEAD}`]: tree([dir('scripts', ids[1])]),
    [`GET ${url}/git/trees/${ids[0]}`]: tree([dir('ci', ids[2])]),
    [`GET ${url}/git/trees/${ids[1]}`]: tree([dir('ci', ids[3])]),
    [`GET ${url}/git/trees/${ids[2]}`]: tree([leaf(ids[4], '100644')]),
    [`GET ${url}/git/trees/${ids[3]}`]: tree([leaf(ids[5], headMode)]),
    [`GET ${url}/git/blobs/${ids[4]}`]: () => response(before()),
    [`GET ${url}/git/blobs/${ids[5]}`]: () => response(after()),
    // Keep the old Contents response to reproduce why dereferencing a link is unsafe.
    [`GET ${url}/contents/${file}?ref=${BASE}`]: () => response(before()),
    [`GET ${url}/contents/${file}?ref=${HEAD}`]: () => response(after()),
  });
}

test('trusted admission proves version-only changes but never waives an executable body edit', async () => {
  const repository = 'tdoljyj/cross-memory-system', file = 'scripts/ci/clued-independent-publication-port.mjs';
  const before = "export const COMPONENT_VERSION = '1.0.0';\nexport const bound = true;\n";
  let after = before.replace('1.0.0', '1.0.1');
  const f = mechanicalGitFixture(() => before, () => after);
  const pr = { base: { sha: BASE }, head: { sha: HEAD } };
  const call = () => admissionModule.mechanicalProofForPull(f.fetchImpl, env(), repository, pr, [file]);
  assert.deepEqual(await call(), [file]);
  after = after.replace('bound = true', 'bound = false');
  assert.deepEqual(await call(), []);
  assert.ok(f.calls.every(c => c.url.includes('/git/')));
});

test('mechanical proof never hides different invalid UTF-8 source bytes', async () => {
  const repository = 'tdoljyj/cross-memory-system', file = 'scripts/ci/clued-independent-publication-port.mjs';
  const bytes = (version, bad) => Buffer.concat([Buffer.from(`export const COMPONENT_VERSION='${version}';\n//`), Buffer.from([bad])]);
  const f = mechanicalGitFixture(() => bytes('1.0.0', 255), () => bytes('1.0.1', 254));
  assert.deepEqual(await admissionModule.mechanicalProofForPull(f.fetchImpl, env(), repository,
    { base: { sha: BASE }, head: { sha: HEAD } }, [file]), []);
});

test('mechanical proof refuses a symlink or executable mode change even when Contents returns version-only bytes', async () => {
  const before = "export const COMPONENT_VERSION='1.0.0';\nexport const bound = true;\n";
  for (const mode of ['120000', '100755', '160000']) {
    const f = mechanicalGitFixture(() => before, () => before.replace('1.0.0', '1.0.1'), mode);
    assert.deepEqual(await admissionModule.mechanicalProofForPull(f.fetchImpl, env(), 'tdoljyj/cross-memory-system',
      { base: { sha: BASE }, head: { sha: HEAD } }, ['scripts/ci/clued-independent-publication-port.mjs']), []);
  }
});

test("admission CLI honors configured proxy routing and preserves child exit semantics before network work", () => {
  const script = fileURLToPath(new URL("./clued-work-admission.mjs", import.meta.url));
  const source = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
    GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", CLUED_DEFAULT_BRANCH: "main" };
  for (const key of ["NODE_OPTIONS", "NODE_USE_ENV_PROXY", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) delete source[key];
  const admitted = spawnSync(process.execPath, [script, "--mode", "gate"], { env: source, encoding: "utf8", timeout: 5000 });
  assert.equal(admitted.error, undefined);
  if (!process.allowedNodeEnvironmentFlags.has("--use-env-proxy")) {
    assert.equal(admitted.status, 1);
    assert.match(admitted.stderr, /runtime cannot use/);
    return;
  }
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.stdout, /"admitted": true/);
  const refused = spawnSync(process.execPath, [script, "--mode", "unknown-fixture-mode"], { env: source, encoding: "utf8", timeout: 5000 });
  assert.equal(refused.error, undefined);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /usage: clued-work-admission/);
});

import {
  ADMISSION_APP_ID,
  ADMISSION_TOKEN_HINT,
  withTokenHint,
  ADOPT_RPC,
  adoptMerged,
  PUBLIC_CONFIG_SOURCE,
  DISPATCH_GATED_WORKFLOWS,
  dispatchAdmit,
  dispatchTitle,
  evaluate as evaluateWith,
  gate,
  globToRegExp,
  renderReverifySummary,
  reverify as reverifyWith,
  main as mainWith,
  parseClaimReference,
  parseWorkflowTriggers,
  readWorkflowTriggers,
  renderSummary,
  resolvePublicSupabaseConfig,
  sha256Hex,
  workflowApplies,
  APP_CHECK_NAME,
  appCheck,
  postAppCheckCore,
  appJwt,
  GATE_JOB_SHA256,
  GATE_WAIT_SECONDS,
  INDEPENDENT_GATE_SOURCE,
  INDEPENDENT_GATE_WAIT_SECONDS,
  INDEPENDENT_GATE_POLL_SECONDS,
  INDEPENDENT_GATE_WAIT_CEILING_SECONDS,
  GITHUB_READ_RETRY_ATTEMPTS,
  GITHUB_READ_RETRY_STATUSES,
  withGithubReadRetry,
  independentAdmissionCheck,
  checkNamesPullRequest,
  SAME_EVENT_MS,
  gateFindings,
  PRODUCTION_PUBLISHER_WORKFLOW,
  registeredPublisherGatedSuccessor,
  registeredPlacementSuccessor,
  registeredBootstrapOrdinarySuccessor,
  jobIsHosted,
  jobTimeout,
  rerunAttempt,
  workflowFormFindings,
  workflowIsGated,
  workflowJobs,
  workflowBasePath,
  workflowFindings,
  ownerReviewFindings,
  protectedPathFindings,
  workflowHasEnvironment,
  workflowSecrets,
  OWNER_REVIEW_RPC,
  DOOR_RETRY_DELAYS_MS,
  ownerReviewDoor,
  MERGE_SLOT_CHECK_NAME,
  mergeSlotCheck,
  mergeSlotOutputs,
  mergeSlotState,
  appChecksOnHead,
} from "./clued-work-admission.mjs";
import { fixedPolicy, RECOMMENDED_POLICY_TEXT } from "./merge-admission-policy.fixtures.mjs";
import { parseModeLabel } from "./merge-admission-policy.mjs";
import {registeredPublisherSource} from './clued-production-publisher-source.mjs';

// Merge Admission v0.1 (review MAJOR-1): these self-tests run on the default
// branch before every admission, so every evaluation here judges against the
// fixed compatibility table, never the repository's policy file.
const evaluate = (options) => evaluateWith({ readPolicyFile: fixedPolicy(), ...options });
const reverify = (options) => reverifyWith({ readPolicyFile: fixedPolicy(), ...options });
const main = (argv, environment, fetchImpl) => mainWith(argv, environment, fetchImpl, { readPolicyFile: fixedPolicy() });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAIM = "0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
const TASK = "00000000-0000-4000-8000-000000000452";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CLAIM_BASE = "c".repeat(40);
// Re-review 10: the base branch's tip as GitHub reports it now (it may be
// ahead of the event's base.sha).
const TIP = "7".repeat(39) + "6";
// The public project values are read from the repository file, never copied here.
const PUBLIC = resolvePublicSupabaseConfig({}, ROOT);
const RPC_URL = `${PUBLIC.url}/rest/v1/rpc/clued_work_verify_v1`;
const EPOCH_URL = RPC_URL;

test("Kooyumi check contexts keep the trusted App, workflow path and technical job ID", () => {
  assert.equal(ADMISSION_APP_ID, 5164952);
  assert.equal(APP_CHECK_NAME, "kooyumi-admission-verified");
  assert.equal(MERGE_SLOT_CHECK_NAME, "kooyumi-merge-slot");
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/clued-work-admission.yml"), "utf8");
  assert.match(workflow, /^name: kooyumi-work-admission$/m);
  assert.match(workflow, /^  clued-work-admission:\r?\n    name: kooyumi-work-admission$/m);
  assert.match(workflow, /environment: clued-admission/);
  const slotWorkflow = fs.readFileSync(path.join(ROOT, ".github/workflows/clued-merge-slot-ci.yml"), "utf8");
  assert.match(slotWorkflow, /^      - kooyumi-work-admission$/m);
  assert.doesNotMatch(slotWorkflow, /^      - clued-work-admission$/m);
});

function event(overrides = {}) {
  return {
    pull_request: {
      number: 452,
      body: overrides.body ?? "## Why\n\nSome PR.",
      head: { sha: HEAD, repo: { full_name: "o/r" } },
      base: { sha: BASE, ref: "main" },
    },
  };
}

function env(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "o/r",
    GITHUB_TOKEN: "ghs_test",
    GITHUB_API_URL: "https://api.test",
    CLUED_CONTEXT_READ_TOKEN: "clued_bnd_test",
    GITHUB_RUN_ID: "9001",
    GITHUB_WORKSPACE: ROOT,
    ...overrides,
  };
}

// A scripted fetch: keys are "METHOD url-prefix"; every call is recorded.
function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const call = { url: String(url), method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const key = Object.keys(script).find((k) => k.startsWith(`${method} `) && call.url.startsWith(k.slice(method.length + 1)));
    let responder = key ? script[key] : undefined;
    if (call.body?.p_input?.action === 'resolve_pr_claim') {
      // A separate Native authority fixture; never derive its choice from the
      // body/commit text being tested. Explicit cases may override this action.
      const actionKey = `${method} ${call.url}#resolve_pr_claim`;
      responder = Object.hasOwn(script, actionKey) ? script[actionKey]
        : { body: bindingPayload(call.body.p_input) };
    }
    if (!responder && call.url === EPOCH_URL && call.body?.p_input?.action === "execution_current")
      responder = { body: { status: "ok", guard_required: false, epoch_current: null } };
    // Re-review 10: unless a test scripts them, the base branch's tip is TIP
    // and the head is ahead of it with no files of its own.
    const tipCompare = `https://api.test/repos/o/r/compare/${TIP}...`;
    if (call.url.startsWith(tipCompare) && !Object.keys(script).some((k) => k.startsWith(`GET ${tipCompare}`))) {
      responder = { body: { status: "ahead", files: [] } };
    }
    if (!responder && /\/branches\/[^/]+$/.test(call.url)) responder = { body: { name: "main", commit: { sha: TIP } } };
    if (!responder) return { ok: false, status: 599, headers: { get: () => null }, json: async () => ({ error: `unscripted ${call.url}` }), text: async () => "" };
    const result = typeof responder === "function" ? responder(call) : responder;
    const status = result.status ?? 200;
    const text = result.body === null || result.body === undefined ? "" : JSON.stringify(result.body);
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (name) => (result.headers ?? {})[name] ?? null },
      json: async () => result.body, text: async () => text,
    };
  };
  return { fetchImpl, calls };
}

const FILES = `GET https://api.test/repos/o/r/pulls/452/files`;
const PULL = `GET https://api.test/repos/o/r/pulls/452`;
const OPEN_PULLS = `GET https://api.test/repos/o/r/pulls?state=open`;
const ADMISSION_RUNS = `GET https://api.test/repos/o/r/actions/workflows/clued-work-admission.yml/runs`;
const CHECKS = `GET https://api.test/repos/o/r/commits/${HEAD}/check-runs`;
// The gate's own run (GITHUB_RUN_ID 9001): only the App check of the admission
// run of its own event counts (re-review 3, N-R1; re-review 5, n1).
const THIS_RUN = `GET https://api.test/repos/o/r/actions/runs/9001`;
const RUN_CREATED = "2026-10-02T04:00:00Z";
// Main's admission run of the same event (re-review 5, n1): the gate binds to
// it, and its check names it ("pr:452:run:77").
const admissionTargetRun = (overrides = {}) => ({ id: 77, event: "pull_request_target", head_sha: HEAD, status: "completed",
  conclusion: "success", created_at: RUN_CREATED, ...overrides });
const SELF_RUN = { [THIS_RUN]: { body: { id: 9001, run_attempt: 1, created_at: RUN_CREATED } },
  [ADMISSION_RUNS]: { body: { workflow_runs: [admissionTargetRun()] } } };
const appCheckRun = (overrides = {}) => ({ id: 1, name: "kooyumi-admission-verified", head_sha: HEAD, status: "completed",
  conclusion: "success", started_at: "2026-10-02T04:00:40Z", external_id: "pr:452:run:77", app: { id: ADMISSION_APP_ID, slug: "clued-admission" },
  ...overrides });
const checksReturn = (list) => ({ ...SELF_RUN, [CHECKS]: { body: { check_runs: list } } });
const RERUN = `POST https://api.test/repos/o/r/actions/runs/`;
const COMMIT = `GET https://api.test/repos/o/r/commits/`;
const COMPARE = `GET https://api.test/repos/o/r/compare/`;
const RUNS = `GET https://api.test/repos/o/r/actions/runs`;
const VERIFY = `POST ${RPC_URL}`;
const files = { body: [{ filename: "apps/clued-cloud/worker/index.ts" }, { filename: "docs/new.md", previous_filename: "docs/old.md" }] };
const admittedPayload = { status: "ok", verdict: "ADMITTED", reasons: [], paths_outside_write_set: [], current_fence: 1,
  execution_epoch: 1, claim: { claim_id: CLAIM, task_id: TASK, context_key: 'global', status: "ACTIVE", fence: 1,
    execution_epoch: 1, lease_version: 1, expires_at: "2026-10-01T13:00:00Z", base_commit: CLAIM_BASE,
    write_set: ["apps/clued-cloud/**", "docs/**"], holder_binding_id: "should-not-leak" } };
function bindingPayload(input, changes = {}) {
  const split = input.pr_ref.lastIndexOf('#');
  return { status: 'ok', binding_status: 'bound', reason: null, repository: input.pr_ref.slice(0, split),
    pr_number: Number(input.pr_ref.slice(split + 1)), pr_ref: input.pr_ref, head_sha: input.head_sha,
    base_sha: input.base_sha, target_branch: input.target_branch, scope: 'global', task_id: TASK,
    claim: { claim_id: CLAIM, task_id: TASK, context_key: 'global', fence: 1, execution_epoch: 1,
      lease_version: 1, status: 'ACTIVE', expires_at: '2099-01-01T00:00:00.000Z', execution_handover_pending: false },
    head_authorization_id: '00000000-0000-4000-8000-000000000453', auto_bound: false, receipt_id: null,
    ...changes };
}
const withClaim = () => event({ body: `Body\n\nClued-Work-Claim: ${CLAIM}` });
// Re-review 7, m2: an admitted evaluation reads the pull request once more to
// see that its head did not move. Tests that do not script that read get the
// event's head back.
const evaluateIn = (options) => {
  const inner = options.fetchImpl;
  const number = options.event?.pull_request?.number;
  const fetchImpl = async (url, init = {}) => {
    const response = await inner(url, init);
    if (response.status === 599 && (init.method ?? "GET") === "GET" && String(url) === `https://api.test/repos/o/r/pulls/${number}`) {
      const body = { number, head: options.event.pull_request.head, base: options.event.pull_request.base };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return response;
  };
  return evaluate({ workspace: ROOT, ...options, fetchImpl });
};

test("non-PR events are not admission subjects", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const outcome = await evaluateIn({ env: env(), event: null, eventName: "push", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.verdict, "NOT_APPLICABLE");
  assert.equal(calls.length, 0);
});

test("enforced: the RPC is called on PostgREST with the publishable key and the token hash, ADMITTED is admitted", async () => {
  const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.verdict, "ADMITTED");
  assert.equal(outcome.enforced, true);
  assert.equal(outcome.advisory, undefined);
  assert.equal(outcome.claim.base_commit, CLAIM_BASE);
  assert.equal("holder_binding_id" in outcome.claim, false);
  const call = calls.find((c) => c.url === RPC_URL && c.body?.p_input?.action !== 'resolve_pr_claim');
  assert.equal(call.headers.apikey, PUBLIC.key);
  assert.equal(call.headers.authorization, `Bearer ${PUBLIC.key}`);
  assert.equal(PUBLIC.source, PUBLIC_CONFIG_SOURCE);
  assert.match(PUBLIC.key, /^sb_publishable_[A-Za-z0-9_-]+$/);
  assert.match(PUBLIC.url, /^https:\/\/[a-z]+\.supabase\.co$/);
  assert.deepEqual(call.body, {
    p_token_hash: sha256Hex("clued_bnd_test"),
    p_input: { scope: "global", claim_id: CLAIM, changed_paths: ["apps/clued-cloud/worker/index.ts", "docs/new.md", "docs/old.md"], head_sha: HEAD, base_sha: BASE, pr_ref: "o/r#452", target_branch: "main",
      // The trusted list goes to Native with every main verification; Native reads only it.
      mechanical_paths_proven: [], mechanical_policy: admissionModule.trustedMechanicalPolicy(),
      // Merge Admission v0.1 §10 (step 3): the mode goes into the Receipts.
      admission_mode: { state: "normal", layer: "code", reruns_per_head: outcome.admission_mode.rules.reruns_per_head } },
  });
  assert.equal(sha256Hex("clued_bnd_test").length, 64);
  assert.ok(!JSON.stringify(call.body).includes("clued_bnd_test"), "only the hash leaves the runner");
  assert.ok(calls.find((c) => c.url.includes("/compare/") && !c.url.includes(`/compare/${TIP}...`)).url.endsWith(`/compare/${CLAIM_BASE}...${BASE}`));
});

test("Native project binding and custom Supabase URL govern despite explanatory text", async () => {
  const scope = "project:11111111-2222-4333-8444-555555555555";
  const custom = "https://db.test";
  const { fetchImpl, calls } = fakeFetch({
    [FILES]: files,
    [COMMIT]: { body: { commit: { message: `feat: x\n\nClued-Work-Claim: ${CLAIM.toUpperCase()}\nClued-Work-Scope: ${scope}\n` } } },
    [COMPARE]: { body: { status: "identical" } },
    [`POST ${custom}/rest/v1/rpc/clued_work_verify_v1#resolve_pr_claim`]: call => {
      const value = bindingPayload(call.body.p_input);
      return { body: { ...value, scope, claim: { ...value.claim, context_key: scope } } };
    },
    [`POST ${custom}/rest/v1/rpc/clued_work_verify_v1`]: { body: { ...admittedPayload,
      claim: { ...admittedPayload.claim, context_key: scope } } },
  });
  const outcome = await evaluateIn({ env: env({ CLUED_SUPABASE_URL: `${custom}/`, CLUED_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.scope, scope);
  const call = calls.find((c) => c.method === "POST" && c.body?.p_input?.action !== 'resolve_pr_claim');
  assert.equal(call.headers.apikey, "sb_publishable_x");
  assert.equal(call.body.p_input.scope, scope);
});

test("a Native-unbound PR waits without falling back to any explanatory trailer or burning a head", async () => {
  const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [`${VERIFY}#resolve_pr_claim`]: call => ({
    body: bindingPayload(call.body.p_input, { binding_status: 'unbound', scope: null, task_id: null, claim: null,
      head_authorization_id: null }) }) });
  const outcome = await evaluateIn({ env: env(), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["pr_task_binding_unbound"]);
  assert.ok(calls.filter(c => c.method === 'POST').every(c => c.body.p_input.action === 'resolve_pr_claim'),
    'only lookup, no metered verification or head authorization');
  assert.ok(!calls.some(c => c.url === `${COMMIT}${HEAD}`), 'no commit fallback');
});

test("Native identity admits both missing and contradictory explanatory text", async () => {
  for (const body of ["", "Clued-Work-Claim: 00000000-0000-4000-8000-000000000999\nClued-Work-Scope: project:00000000-0000-4000-8000-000000000998"]) {
    const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: 'identical' } }, [VERIFY]: { body: admittedPayload } });
    const outcome = await evaluateIn({ env: env(), event: event({ body }), eventName: "pull_request", fetchImpl });
    assert.equal(outcome.admitted, true);
    assert.equal(outcome.claim_id, CLAIM);
    assert.equal(outcome.task_id, TASK);
    assert.equal(outcome.scope, 'global');
    assert.ok(!calls.some(c => c.url === `${COMMIT}${HEAD}`), 'text is not a fallback identity source');
  }
});

test("full Native verification cannot substitute the projected Task or claim generation", async () => {
  const changes = [
    { claim: { ...admittedPayload.claim, task_id: '00000000-0000-4000-8000-000000000998' } },
    { claim: { ...admittedPayload.claim, claim_id: '00000000-0000-4000-8000-000000000999' } },
    { claim: { ...admittedPayload.claim, context_key: `project:${TASK}` } },
    { claim: { ...admittedPayload.claim, fence: 2 } },
    { claim: { ...admittedPayload.claim, execution_epoch: 2 } },
    { current_fence: 2 }, { execution_epoch: 2 },
  ];
  for (const change of changes) {
    const { fetchImpl } = fakeFetch({ [FILES]: files, [VERIFY]: { body: { ...admittedPayload, ...change } } });
    const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
    assert.equal(outcome.admitted, false);
    assert.ok(outcome.reasons.includes('pr_task_binding_changed'));
  }
});

test("enforced: REJECTED with paths outside the write set is not admitted and lists them", async () => {
  const payload = { ...admittedPayload, verdict: "REJECTED", reasons: ["paths_outside_write_set"], paths_outside_write_set: ["docs/new.md"] };
  const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [VERIFY]: { body: payload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["paths_outside_write_set"]);
  assert.deepEqual(outcome.paths_outside_write_set, ["docs/new.md"]);
  assert.ok(!calls.some((c) => c.url.includes("/compare/") && !c.url.includes(`/compare/${TIP}...`)), "no claim base comparison after a rejection");
  assert.match(renderSummary(outcome), /docs\/new\.md/);
});

test("enforced: a claim past its head cap is REJECTED with a hint to claim again", async () => {
  const payload = { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_head_cap_reached"], admitted_heads: 20, max_heads_per_claim: 20 };
  const { fetchImpl } = fakeFetch({ [FILES]: files, [VERIFY]: { body: payload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual([outcome.reasons, outcome.admitted_heads, outcome.max_heads_per_claim], [["claim_head_cap_reached"], 20, 20]);
  assert.match(renderSummary(outcome), /already admitted 20 pull-request heads \(cap 20, Owner Decision a264ea02\)/);
});

test("enforced: a Task past its 24-hour CI head cap is REJECTED with when the next place frees up", async () => {
  const payload = { ...admittedPayload, verdict: "REJECTED", reasons: ["task_ci_head_cap_reached"], admitted_heads: 3,
    task_ci_heads_24h: 40, task_ci_head_cap: 40, ci_retry_after: "2026-10-04T09:00:00+00:00" };
  const { fetchImpl } = fakeFetch({ [FILES]: files, [VERIFY]: { body: payload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual([outcome.reasons, outcome.task_ci_heads_24h, outcome.task_ci_head_cap, outcome.ci_retry_after],
    [["task_ci_head_cap_reached"], 40, 40, "2026-10-04T09:00:00+00:00"]);
  const summary = renderSummary(outcome);
  assert.match(summary, /already ran CI on 40 pull-request heads in the last 24 hours \(cap 40, all of its claims together\)/);
  assert.match(summary, /frees up at 2026-10-04T09:00:00\+00:00\. Another claim does not help/);
});

test("enforced: a claim taken on a newer base than the PR targets is admitted with a notice", async () => {
  for (const status of ["behind", "diverged"]) {
    const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status } }, [VERIFY]: { body: admittedPayload } });
    const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
    assert.deepEqual([outcome.admitted, outcome.verdict, outcome.reasons], [true, "ADMITTED", []], status);
    assert.equal(outcome.notices.length, 1);
    assert.match(outcome.notices[0], new RegExp(`^base_behind_claim:${status} `));
    assert.match(renderSummary(outcome), /Notices \(not blocking\):\n- base_behind_claim/);
  }
});

test("enforced: a claim whose base_commit is not in the repository is rejected", async () => {
  const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { status: 404, body: { message: "Not Found" } }, [VERIFY]: { body: admittedPayload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, [`claim_base_unknown:${CLAIM_BASE}`]);
  assert.deepEqual(outcome.notices, []);
});

test("enforced: fail closed on missing token, missing RPC, refused Binding, rejection envelope, transport error", async () => {
  const base = { [FILES]: files };
  const run = (extra, overrides = {}) => evaluateIn({ env: env(overrides), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch({ ...base, ...extra }).fetchImpl });
  await assert.rejects(run({}, { CLUED_CONTEXT_READ_TOKEN: "" }), /CLUED_CONTEXT_READ_TOKEN is not set/);
  await assert.rejects(run({ [VERIFY]: { status: 404, body: { code: "PGRST202", message: "Could not find the function public.clued_work_verify_v1" } } }), /is not deployed \(404: code=PGRST202/);
  await assert.rejects(run({ [VERIFY]: { status: 400, body: { code: "P0001", message: "binding_not_found" } } }), /refused the verification request \(400: code=P0001 message=binding_not_found\)/);
  await assert.rejects(run({ [VERIFY]: { status: 200, body: { status: "rejected", error_code: "work_claim_id_invalid" } } }), /error_code=work_claim_id_invalid/);
  await assert.rejects(run({ [VERIFY]: { status: 502, body: null, headers: { server: "cloudflare", "cf-ray": "abc-SEA" } } }), /returned 502: \[server=cloudflare cf-ray=abc-SEA\]/);
  await assert.rejects(run({ [VERIFY]: { status: 200, body: { status: "ok" } } }), /returned no verdict/);
});

// Merge Admission step 6: the two retired switches are no longer read, so
// unset or "false" they change nothing; admission fails closed as before.
const RETIRED_SWITCHES = [
  { CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_OWNER_REVIEW_ENFORCE: "" },
  { CLUED_WORK_ADMISSION_ENFORCE: "false", CLUED_OWNER_REVIEW_ENFORCE: "false" },
];

test("retired switches (Merge Admission step 6): CLUED_WORK_ADMISSION_ENFORCE and CLUED_OWNER_REVIEW_ENFORCE unset or false change nothing", async () => {
  const rejected = { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] };
  const base = { [FILES]: files, [COMMIT]: { body: { commit: { message: "feat: no trailer" } } } };
  for (const off of RETIRED_SWITCHES) {
    const outcome = await evaluateIn({ env: env(off), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch({ ...base, [VERIFY]: { body: rejected } }).fetchImpl });
    assert.deepEqual([outcome.admitted, outcome.enforced, outcome.verdict, outcome.advisory], [false, true, "REJECTED", undefined]);
    assert.deepEqual(outcome.reasons, ["claim_not_current"]);
    assert.ok(!/advisory|NOT_ENFORCED|ENFORCE/.test(renderSummary(outcome)));
    assert.equal(outcome.admission_mode.legacy_advisory, undefined);

    const missingFetch = fakeFetch({ ...base, [`${VERIFY}#resolve_pr_claim`]: call => ({
      body: bindingPayload(call.body.p_input, { binding_status: 'unbound', scope: null, task_id: null,
        claim: null, head_authorization_id: null }) }) });
    const missing = await evaluateIn({ env: env(off), event: event(), eventName: "pull_request", fetchImpl: missingFetch.fetchImpl });
    assert.deepEqual([missing.admitted, missing.verdict, missing.reasons], [false, "REJECTED", ["pr_task_binding_unbound"]]);

    const run = (extra, overrides = {}) => evaluateIn({ env: env({ ...off, ...overrides }), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch({ ...base, ...extra }).fetchImpl });
    await assert.rejects(run({}, { CLUED_CONTEXT_READ_TOKEN: "" }), /CLUED_CONTEXT_READ_TOKEN is not set/);
    await assert.rejects(run({ [VERIFY]: { status: 404, body: { code: "PGRST202", message: "missing" } } }), /is not deployed/);
    await assert.rejects(run({ [VERIFY]: { status: 400, body: { code: "P0001", message: "binding_not_found" } } }), /refused the verification request/);
    await assert.rejects(run({ [VERIFY]: { status: 502, body: null } }), /returned 502/);
    await assert.rejects(run({}, { GITHUB_TOKEN: "" }), /GITHUB_TOKEN is not set/);
  }
});

test("workflow filters: parser reads this repository and globs follow GitHub semantics", () => {
  const triggers = readWorkflowTriggers(ROOT);
  const byFile = Object.fromEntries(triggers.map((t) => [t.file, t]));
  assert.deepEqual(workflowApplies(byFile["gitleaks.yml"].pull_request, ["x"]), { applies: true, reason: "unfiltered" });
  assert.deepEqual(workflowApplies(byFile["trivy.yml"].pull_request, ["x"]), { applies: true, reason: "unfiltered" });
  assert.deepEqual(workflowApplies(byFile["clued-work-admission.yml"].pull_request, ["x"]), { applies: true, reason: "unfiltered" });
  assert.equal(workflowApplies(byFile["clued-cloud-node22-install.yml"].pull_request, ["apps/clued-cloud/package.json"]).applies, true);
  assert.equal(workflowApplies(byFile["clued-cloud-node22-install.yml"].pull_request, ["apps/clued-cloud/worker/x.ts"]).applies, false);
  assert.equal(workflowApplies(byFile["information-flow-e2e.yml"].pull_request, ["apps/clued-cloud/worker/x.ts"]).applies, true);
  assert.equal(workflowApplies(byFile["clued-ci-runner-heartbeat.yml"].pull_request, ["x"]).applies, false);
  assert.equal(byFile["memory-publication-gate.yml"].pull_request.paths.length > 0, true, "pull_request_target filters are read");

  assert.ok(globToRegExp("apps/clued-cloud/**").test("apps/clued-cloud/a/b/c.ts"));
  assert.ok(!globToRegExp("*.md").test("docs/a.md"));
  assert.ok(globToRegExp("**/*.md").test("docs/a.md"));
  assert.ok(globToRegExp("**/*.md").test("a.md"));
  assert.ok(globToRegExp("docs/*").test("docs/a.md"));
  assert.ok(!globToRegExp("docs/*").test("docs/sub/a.md"));

  // Both PR triggers: unfiltered if either is; otherwise either filter applies.
  assert.deepEqual(parseWorkflowTriggers("on:\n  pull_request_target:\n    types: [opened]\n  pull_request:\n    paths:\n      - a/**\n").pull_request,
    { paths: [], pathsIgnore: [] });
  const both = parseWorkflowTriggers("on:\n  pull_request_target:\n    paths: [a/**]\n  pull_request:\n    paths:\n      - b/**\n").pull_request;
  assert.equal(workflowApplies(both, ["b/x"]).applies, true);
  assert.equal(workflowApplies(both, ["a/x"]).applies, true);
  assert.equal(workflowApplies(both, ["c/x"]).applies, false);
  const parsed = parseWorkflowTriggers("name: x\non:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\n  push:\n    branches: [main]\n");
  assert.deepEqual(parsed.pull_request, { paths: [], pathsIgnore: ["docs/**"] });
  assert.equal(workflowApplies(parsed.pull_request, ["docs/a.md"]).applies, false);
  assert.equal(workflowApplies(parsed.pull_request, ["docs/a.md", "src/a.ts"]).applies, true);
  assert.deepEqual(parseWorkflowTriggers("on: [push, pull_request]\n").pull_request, { paths: [], pathsIgnore: [] });
});

test("public Supabase config: repository file by default, env override only as a pair", () => {
  assert.deepEqual(resolvePublicSupabaseConfig({ CLUED_SUPABASE_URL: "https://db.test/", CLUED_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }, null), { url: "https://db.test", key: "sb_publishable_x", source: "env" });
  assert.throws(() => resolvePublicSupabaseConfig({ CLUED_SUPABASE_URL: "https://db.test" }, ROOT), /must be set together/);
  assert.throws(() => resolvePublicSupabaseConfig({}, null), /GITHUB_WORKSPACE is not set/);
  assert.throws(() => resolvePublicSupabaseConfig({}, ROOT, () => "export const nothing = 1;"), /no recognizable public default/);
  const fromFile = resolvePublicSupabaseConfig({}, ROOT);
  assert.equal(fromFile.source, PUBLIC_CONFIG_SOURCE);
  assert.equal(fromFile.url, PUBLIC.url);
});

test("claim trailer parsing", () => {
  assert.equal(parseClaimReference(null), null);
  assert.equal(parseClaimReference("Clued-Work-Claim: not-a-uuid"), null);
  assert.deepEqual(parseClaimReference(`x\nClued-Work-Claim: ${CLAIM}\n`), { claim_id: CLAIM, scope: "global" });
  assert.equal(parseClaimReference(`  Clued-Work-Claim: ${CLAIM}`), null, "a trailer starts at column 0");
});

test("main: exit codes and outputs in the required and gate modes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(withClaim()));
  const base = { ...env(), GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_WORKSPACE: ROOT };
  const rejected = {
    [FILES]: files,
    [RUNS]: { body: { workflow_runs: [{ path: ".github/workflows/gitleaks.yml", status: "completed", conclusion: "success" }] } },
    [VERIFY]: { body: { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } },
  };
  const out = (name) => path.join(dir, name);
  const read = (name) => fs.readFileSync(out(name), "utf8");

  let code = await main(["--mode", "required"], { ...base, GITHUB_OUTPUT: out("o1"), GITHUB_STEP_SUMMARY: out("s1") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 1, "enforced + REJECTED fails the required check");
  assert.match(read("o1"), /^admitted=false$/m);
  assert.match(read("o1"), /^enforced=true$/m);
  assert.match(read("s1"), /claim_not_current/);
  assert.match(read("s1"), /\| `gitleaks\.yml` \| yes \| unfiltered \| completed \/ success \|/);
  assert.match(read("s1"), /\| `clued-cloud-node22-install\.yml` \| no \|/);

  const failedRun = checksReturn([appCheckRun({ id: 7, conclusion: "failure" })]);
  const gateCalls = fakeFetch(failedRun);
  code = await main(["--mode", "gate"], { ...base, CLUED_CONTEXT_READ_TOKEN: "", GITHUB_OUTPUT: out("o2"), GITHUB_STEP_SUMMARY: out("s2") }, gateCalls.fetchImpl);
  assert.equal(code, 0, "the gate job itself succeeds; heavy jobs read admitted=false");
  assert.match(read("o2"), /^admitted=false$/m);
  assert.match(read("o2"), /^verdict=REJECTED$/m);
  assert.ok(!read("s2").includes("| Workflow |"), "gate mode writes no workflow table");
  assert.ok(!gateCalls.calls.some((c) => c.url.startsWith(PUBLIC.url)), "the gate never calls Clued");

  code = await main(["--mode", "gate"], { ...base, GITHUB_TOKEN: "", GITHUB_OUTPUT: out("o3"), GITHUB_STEP_SUMMARY: out("s3") }, fakeFetch(failedRun).fetchImpl);
  assert.equal(code, 1, "enforced + no GitHub token is an error");
  assert.match(read("o3"), /^admitted=false$/m);
  assert.match(read("o3"), /^verdict=ERROR$/m);

  // Merge Admission step 6: the retired switch no longer makes a REJECTED or
  // unverifiable head pass.
  code = await main(["--mode", "required"], { ...base, CLUED_WORK_ADMISSION_ENFORCE: "", GITHUB_OUTPUT: out("o4"), GITHUB_STEP_SUMMARY: out("s4") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 1, "REJECTED fails the required check whatever CLUED_WORK_ADMISSION_ENFORCE says");
  assert.match(read("o4"), /^admitted=false$/m);
  assert.match(read("o4"), /^enforced=true$/m);
  assert.match(read("o4"), /^verdict=REJECTED$/m);

  code = await main(["--mode", "required"], { ...base, CLUED_WORK_ADMISSION_ENFORCE: "false", CLUED_CONTEXT_READ_TOKEN: "", GITHUB_OUTPUT: out("o5"), GITHUB_STEP_SUMMARY: out("s5") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 1, "a missing token is an error whatever CLUED_WORK_ADMISSION_ENFORCE says");
  assert.match(read("o5"), /^verdict=ERROR$/m);

  code = await main(["--mode", "required"], { ...base, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: out("o6"), GITHUB_STEP_SUMMARY: out("s6") }, fakeFetch({}).fetchImpl);
  assert.equal(code, 0);
  assert.match(read("o6"), /^verdict=NOT_APPLICABLE$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Step 7 review fixes: base-branch target runs, PR binding, truncation, re-verification.

const freshPull = (overrides = {}) => ({
  number: 452, state: "open", draft: false, changed_files: 2,
  body: `Edited body\n\nClued-Work-Claim: ${CLAIM}`,
  head: { sha: "d".repeat(40), repo: { full_name: "o/r" } }, base: { sha: BASE, ref: "main" },
  ...overrides,
});

test("pull_request_target: the PR is read fresh, so an edited body or a re-run sees the current trailer and head", async () => {
  // FILES must come before PULL: a fetch key matches by URL prefix.
  const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [PULL]: { body: freshPull() }, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload } });
  const outcome = await evaluateIn({ env: env(), event: event(), eventName: "pull_request_target", fetchImpl });
  assert.equal(outcome.verdict, "ADMITTED");
  assert.equal(outcome.head_sha, "d".repeat(40), "the head comes from the fresh read, not the payload");
  assert.equal(outcome.pr_ref, "o/r#452");
  const verifyCall = calls.find((c) => c.url === RPC_URL && c.body?.p_input?.action !== 'resolve_pr_claim');
  assert.equal(verifyCall.body.p_input.pr_ref, "o/r#452");
  assert.equal(verifyCall.body.p_input.head_sha, "d".repeat(40));
  assert.ok(!calls.some((c) => c.url.includes("/commits/")), "the trailer was found in the fresh body");
});

test("pull_request_target (Merge Admission step 2): a pull request merged or closed by the time it is read is not judged and does not pass", async () => {
  for (const state of ["closed"]) {
    const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [PULL]: { body: freshPull({ state }) }, [VERIFY]: { body: admittedPayload } });
    const outcome = await evaluateIn({ env: env(), event: event(), eventName: "pull_request_target", fetchImpl });
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "PR_NOT_OPEN"], state);
    assert.match(outcome.reasons[0], new RegExp(`pull request #452 is ${state}; nothing to judge`));
    assert.deepEqual(calls.map((c) => c.url), ["https://api.test/repos/o/r/pulls/452"], "no other call, Clued included");
  }
  const { fetchImpl } = fakeFetch({ [FILES]: files, [PULL]: { body: freshPull({ state: "open" }) }, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload } });
  assert.equal((await evaluateIn({ env: env(), event: event(), eventName: "pull_request_target", fetchImpl })).verdict, "ADMITTED");
  // main: the run fails (the runner hook admits on run success alone), and the workflow posts no check for it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-closed-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(event()));
  const code = await main(["--mode", "required"], { ...env(), GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: ROOT, GITHUB_OUTPUT: path.join(dir, "out") }, fakeFetch({ [PULL]: { body: freshPull({ state: "closed" }) } }).fetchImpl);
  assert.equal(code, 1);
  assert.match(fs.readFileSync(path.join(dir, "out"), "utf8"), /^verdict=PR_NOT_OPEN$/m);
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  assert.ok(workflow.includes("if: ${{ !cancelled() && steps.admit.outputs.verdict != 'PR_NOT_OPEN' }}"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("gate (Merge Admission step 2, review MAJOR-1): a re-run that is not admitted fails the gate job; attempt 1 does not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-gate-exit-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(withClaim()));
  const pull = { [PULL]: { body: { number: 452, state: "open", head: { sha: HEAD }, base: { ref: "main" } } } };
  const checks = [appCheckRun({ output: { title: "ADMITTED [normal · code · reruns 1]" } })];
  const base = { ...env({ CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" }), GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: path.join(dir, "o") };
  const run = (extra, script) => main(["--mode", "gate"], { ...base, ...extra }, fakeFetch(script).fetchImpl);
  assert.equal(await run({ GITHUB_RUN_ATTEMPT: "2" }, { ...checksReturn(checks), ...pull }), 0, "an admitted re-run");
  assert.equal(await run({ GITHUB_RUN_ATTEMPT: "3" }, { ...checksReturn(checks), ...pull }), 1, "past the allowance: red");
  assert.equal(await run({ GITHUB_RUN_ATTEMPT: "2" }, { ...checksReturn([appCheckRun({ conclusion: "failure", output: { title: "REJECTED [normal · code · reruns 1]" } })]), ...pull }), 1,
    "a rejected re-run: red");
  assert.equal(await run({}, checksReturn([appCheckRun({ conclusion: "failure" })])), 0, "attempt 1 not admitted: the gate succeeds, heavy jobs skip");
  // Merge Admission step 6: the retired switch no longer turns it green.
  assert.equal(await run({ GITHUB_RUN_ATTEMPT: "3", CLUED_WORK_ADMISSION_ENFORCE: "" }, { ...checksReturn(checks), ...pull }), 1, "retired switch unset: still red");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("enforced: a claim bound to another PR is rejected and the binding is reported", async () => {
  const payload = { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_bound_to_other_pr"], bound_pr: "o/r#1",
    claim: { ...admittedPayload.claim, bound_pr: "o/r#1" } };
  const { fetchImpl } = fakeFetch({ [FILES]: files, [VERIFY]: { body: payload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["claim_bound_to_other_pr"]);
  assert.equal(outcome.claim.bound_pr, "o/r#1");
  assert.match(renderSummary(outcome), /Claim bound to:\*\* `o\/r#1`/);
});

test("a changed-file list shorter than the PR's changed_files fails closed", async () => {
  const short = { pull_request: { ...withClaim().pull_request, changed_files: 3500 } };
  let { fetchImpl, calls } = fakeFetch({ [FILES]: files, [VERIFY]: { body: admittedPayload } });
  let outcome = await evaluateIn({ env: env(), event: short, eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["changed_files_truncated:3500"]);
  assert.ok(!calls.some((c) => c.method === "POST"), "no verify on a partial file list");
  ({ fetchImpl } = fakeFetch({ [FILES]: files, [VERIFY]: { body: admittedPayload } }));
  outcome = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: short, eventName: "pull_request", fetchImpl });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.reasons], [false, "REJECTED", ["changed_files_truncated:3500"]], "the retired switch changes nothing");
  // A rename counts once in changed_files but contributes two paths.
  ({ fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload } }));
  outcome = await evaluateIn({ env: env(), event: { pull_request: { ...withClaim().pull_request, changed_files: 2 } }, eventName: "pull_request", fetchImpl });
  assert.equal(outcome.verdict, "ADMITTED");
});

// Re-review 7, MAJOR-1: re-verification follows the App check the ruleset
// reads, per pull request, and posts the failing check itself.
const appKeyPem = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const reverifyScript = (pulls, checksFor, extra = {}, nativeClaims = {}) => {
  const script = {
    [OPEN_PULLS]: { body: pulls },
    "GET https://api.test/repos/o/r/commits/": (call) => {
      const sha = /commits\/([0-9a-f]{40})\/check-runs/.exec(call.url)?.[1];
      const list = checksFor(sha);
      return list ? { body: { check_runs: list } } : { status: 500, body: { message: "boom" } };
    },
    "GET https://api.test/repos/o/r/installation": { body: { id: 99 } },
    "POST https://api.test/app/installations/99/access_tokens": { status: 201, body: { token: "ghs_app" } },
    "POST https://api.test/repos/o/r/check-runs": { status: 201, body: { id: 5005 } },
    [RERUN]: { status: 201, body: null },
    [COMPARE]: { body: { status: "ahead" } },
    [`${VERIFY}#resolve_pr_claim`]: call => {
      const input = call.body.p_input, value = bindingPayload(input);
      return { body: { ...value, claim: { ...value.claim,
        claim_id: nativeClaims[input.pr_ref] ?? CLAIM } } };
    },
    [VERIFY]: (call) => ({ body: call.body.p_input.claim_id === CLAIM
      ? { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] }
      : { ...admittedPayload, claim: { ...admittedPayload.claim, claim_id: call.body.p_input.claim_id } } }),
    ...extra,
  };
  for (const pull of pulls) {
    script[`GET https://api.test/repos/o/r/pulls/${pull.number}/files`] = files;
    script[`GET https://api.test/repos/o/r/pulls/${pull.number}`] = { body: pull };
  }
  return fakeFetch(script);
};
const appCheckOn = (sha, id, conclusion, externalId) => appCheckRun({ id, head_sha: sha, conclusion, external_id: externalId });

test("reverify: a pull request whose green App check outlived its claim gets a failing App check; others are left alone", async () => {
  const sha = (c) => c.repeat(40);
  const other = "1f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
  const pulls = [
    freshPull({ number: 452 }), // claim expired since its check passed
    freshPull({ number: 453, head: { sha: sha("e") }, body: `x\n\nClued-Work-Claim: ${other}` }), // still admitted
    freshPull({ number: 454, head: { sha: sha("f") } }), // newest check already failed
    freshPull({ number: 455, draft: true }),
    freshPull({ number: 456, head: { sha: sha("9") } }), // check lookup fails
    freshPull({ number: 457, head: { sha: sha("8") }, base: { sha: BASE, ref: "dev", repo: { default_branch: "main" } } }), // not into main
    // MAJOR-1: the newest green check on the head was posted for another pull
    // request (or the newest run was skipped or cancelled); this one's claim
    // no longer admits it, so it is blocked all the same.
    freshPull({ number: 458, head: { sha: sha("7") } }),
  ];
  const checksFor = (head) => ({
    [sha("d")]: [appCheckOn(sha("d"), 3, "success", "pr:452:run:77"), appCheckOn(sha("d"), 2, "failure", "pr:452:run:70")],
    [sha("e")]: [appCheckOn(sha("e"), 4, "success", "pr:453:run:78")],
    [sha("f")]: [appCheckOn(sha("f"), 6, "failure", "pr:454:run:80"), appCheckOn(sha("f"), 5, "success", "pr:454:run:79")],
    [sha("8")]: [appCheckOn(sha("8"), 7, "success", "pr:457:run:81")],
    [sha("7")]: [appCheckOn(sha("7"), 9, "success", "pr:999:run:90"), appCheckOn(sha("7"), 8, "success", "pr:458:run:89")],
  })[head] ?? null;
  const pem = appKeyPem();
  const { fetchImpl, calls } = reverifyScript(pulls, checksFor, {}, { 'o/r#453': other });
  const result = await reverify({ env: env({ CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: pem }), fetchImpl, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(result.checked.map((c) => [c.pr, c.verdict]), [[452, "REJECTED"], [453, "ADMITTED"], [458, "REJECTED"]]);
  assert.deepEqual(result.blocked.map((b) => [b.pr, b.check_run_id]), [[452, 5005], [458, 5005]]);
  assert.deepEqual(result.errors.map((e) => e.pr), [456]);
  const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
  assert.deepEqual(posts.map((c) => [c.body.head_sha, c.body.conclusion, c.body.external_id]),
    [[sha("d"), "failure", "pr:452:run:9001"], [sha("7"), "failure", "pr:458:run:9001"]]);
  // Merge Admission v0.1 §10: the title names the mode the head was judged in.
  assert.equal(posts[0].body.output.title, "RE-VERIFIED: REJECTED [normal · code · reruns 0]");
  assert.deepEqual(result.checked.map((c) => c.mode), ["normal · code · reruns 0", "normal · code · reruns 0", "normal · code · reruns 0"]);
  assert.match(renderReverifySummary(result), /^## kooyumi-work-admission re-verification\n\n\*\*Mode:\*\* `normal` · source `default`\n/);
  assert.ok(!calls.some((c) => c.url.includes("/pulls/455")), "drafts are skipped");
  assert.ok(!calls.some((c) => c.url.includes("/pulls/457")), "pull requests into other branches are skipped");
  assert.ok(!calls.some((c) => c.url.includes("/pulls/454")), "a head whose newest check failed is not evaluated");
  assert.match(renderReverifySummary(result), /#452: failing check 5005 posted, REJECTED: claim_not_current/);

  // Merge Admission step 6: the retired switch no longer skips it; in any
  // state, without the App key that is an error, not a quiet skip.
  for (const state of ["normal", "frozen"]) {
    const unset = await reverify({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_MERGE_ADMISSION_STATE: state }), fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
    assert.deepEqual([unset.skipped, unset.mode.state], [undefined, state]);
    assert.match(unset.errors[0].error, /App is not configured/);
    assert.ok(!/Skipped/.test(renderReverifySummary(unset)));
  }
});

test("reverify reason=state_change (Merge Admission step 3): every open pull request is judged again and gets both checks", async () => {
  const sha = (c) => c.repeat(40);
  const other = "1f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
  const pulls = [
    freshPull({ number: 452 }), // its claim no longer admits it
    freshPull({ number: 453, head: { sha: sha("e") }, body: `x\n\nClued-Work-Claim: ${other}` }), // admitted
    freshPull({ number: 455, draft: true }),
    freshPull({ number: 457, head: { sha: sha("8") }, base: { sha: BASE, ref: "dev", repo: { default_branch: "main" } } }),
  ];
  // No App check is read: a red check is judged again too.
  const { fetchImpl, calls } = reverifyScript(pulls, () => { throw new Error("no check lookup in state_change"); }, {}, { 'o/r#453': other });
  const appEnv = { CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem(), CLUED_REVERIFY_REASON: "state_change" };
  const result = await reverify({ env: env(appEnv), fetchImpl, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.reason, "state_change");
  assert.deepEqual(result.rejudged.map((r) => [r.pr, r.verdict, r.admitted]), [[452, "REJECTED", false], [453, "ADMITTED", true]]);
  const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
  assert.deepEqual(posts.map((c) => [c.body.name, c.body.head_sha, c.body.conclusion, c.body.external_id]), [
    [APP_CHECK_NAME, sha("d"), "failure", "pr:452:run:9001"], [MERGE_SLOT_CHECK_NAME, sha("d"), "failure", "pr:452:run:9001"],
    [APP_CHECK_NAME, sha("e"), "success", "pr:453:run:9001"], [MERGE_SLOT_CHECK_NAME, sha("e"), posts[3].body.conclusion, "pr:453:run:9001"]]);
  assert.match(posts[0].body.output.title, /^RE-VERIFIED \(state change\): REJECTED \[normal · code · reruns \d\]$/);
  assert.match(posts[1].body.output.title, /^RE-VERIFIED \(state change\): Not admitted$/);
  assert.match(posts[2].body.output.title, /^RE-VERIFIED \(state change\): ADMITTED \[normal · code · reruns \d\]$/);
  // The gate reads the mode back from a state-change title.
  assert.equal(parseModeLabel(posts[2].body.output.title).state, "normal");
  assert.ok(!calls.some((c) => c.url.includes("/pulls/455") || c.url.includes("/pulls/457")), "drafts and other bases are skipped");
  assert.match(renderReverifySummary(result), /State change: open PRs judged again: 2 · errors: 0\n- #452: REJECTED \(check 5005\)/);

  // Passing checks are posted too: a switch back from frozen has to turn red
  // checks green (the retired CLUED_WORK_ADMISSION_ENFORCE changes nothing).
  const green = reverifyScript([freshPull({ number: 453, head: { sha: sha("e") }, body: `x\n\nClued-Work-Claim: ${other}` })], () => [], {}, { 'o/r#453': other });
  const again = await reverify({ env: env({ ...appEnv, CLUED_WORK_ADMISSION_ENFORCE: "" }), fetchImpl: green.fetchImpl, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(again.rejudged.map((r) => [r.pr, r.admitted]), [[453, true]]);
  assert.deepEqual(green.calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs")).map((c) => c.body.conclusion), ["success", "success"]);
  // Any other reason is the hourly run (here without the App key: an error).
  const hourly = await reverify({ env: env({ CLUED_REVERIFY_REASON: "scheduled" }), fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
  assert.deepEqual([hourly.reason, hourly.rejudged, hourly.errors.length], ["scheduled", [], 1]);
  // The workflow passes the dispatch input through.
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission-reverify.yml"), "utf8");
  assert.match(workflow, /options: \[scheduled, state_change\]/);
  assert.match(workflow, /CLUED_REVERIFY_REASON: \$\{\{ inputs\.reason \}\}/);
});

test("reverify workflow: slim migration is admitted and retains the longer hosted state-change mode", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission-reverify.yml"), "utf8");
  const runner = "${{ inputs.reason == 'state_change' && 'ubuntu-latest' || 'ubuntu-slim' }}";
  const job = workflowJobs(workflow).find((j) => j.name === "reverify");
  assert.equal(jobIsHosted(job), true, "the deployed guard must recognize the actual workflow as hosted");
  assert.deepEqual(gateFindings(workflow, workflow.replace(runner, "ubuntu-latest")), [], "the migration must stay compatible with the trusted main guard");
  assert.match(workflow, /^    runs-on: \$\{\{ inputs\.reason == 'state_change' && 'ubuntu-latest' \|\| 'ubuntu-slim' \}\}$/m);
  assert.match(workflow, /^    timeout-minutes: \$\{\{ inputs\.reason == 'state_change' && 30 \|\| 10 \}\}$/m);
  assert.match(workflow, /cron: "17 \* \* \* \*"/, "hourly revocation re-check stays in place");
});

test("reverify (re-review 8): without the App key it reads nothing and fails", async () => {
  const { fetchImpl, calls } = reverifyScript([freshPull()], () => []);
  const result = await reverify({ env: env(), fetchImpl, workspace: ROOT });
  assert.deepEqual(result.errors.map((e) => e.pr), [null]);
  assert.match(result.errors[0].error, /App is not configured/);
  assert.deepEqual(calls, []);
  assert.match(renderReverifySummary(result), /- re-verification: error the clued-admission App is not configured/);
});

test("main --mode reverify: exit 1 only when a PR could not be re-verified", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-reverify-"));
  const out = path.join(dir, "summary.md");
  const app = { CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: "pem" };
  let code = await main(["--mode", "reverify"], { ...env(app), GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: out }, fakeFetch({ [OPEN_PULLS]: { body: [] } }).fetchImpl);
  assert.equal(code, 0);
  assert.match(fs.readFileSync(out, "utf8"), /failing checks posted: 0/);
  code = await main(["--mode", "reverify"], { ...env(), GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: out }, fakeFetch({}).fetchImpl);
  assert.equal(code, 1, "no App: an error, not a quiet pass");
  code = await main(["--mode", "reverify"], { ...env(app), GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: out },
    fakeFetch({ [OPEN_PULLS]: { body: [freshPull()] }, "GET https://api.test/repos/o/r/commits/": { status: 500, body: null } }).fetchImpl);
  assert.equal(code, 1);
  assert.equal(await main(["--mode", "nope"], env(), fakeFetch({}).fetchImpl), 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Token isolation: the gate reads the trusted pull_request_target check run.

test("R1: a late admission cannot promote an expired gate; only a fresh permitted whole-job attempt admits", async () => {
  assert.equal(GATE_WAIT_SECONDS, 180);
  let elapsed = 0;
  const current = { number: 452, state: "open", head: { sha: HEAD }, base: { ref: "main" } };
  const check = () => appCheckRun({ output: { title: "ADMITTED [normal · code · reruns 1]" } });
  const run = async (extra = {}, lateAt = 181, pull = current) => {
    const { fetchImpl, calls } = fakeFetch({ ...SELF_RUN, [PULL]: { body: pull },
      [CHECKS]: () => ({ body: { check_runs: elapsed >= lateAt ? [check()] : [] } }) });
    const outcome = await gate({ env: env(extra), event: withClaim(), eventName: "pull_request", fetchImpl,
      sleep: async (ms) => { elapsed += ms / 1000; } });
    return { outcome, calls };
  };
  const first = await run();
  assert.equal(elapsed, 180);
  assert.deepEqual([first.outcome.admitted, first.outcome.enforced, first.outcome.verdict], [false, true, "ADMISSION_PENDING"]);
  elapsed = 200; // The same event's trusted App check arrives after this attempt ended.
  assert.equal(first.outcome.admitted, false, "later checks cannot mutate the recorded gate output");
  const second = await run({ GITHUB_RUN_ATTEMPT: "2" });
  assert.deepEqual([second.outcome.admitted, second.outcome.verdict], [true, "ADMITTED"]);
  assert.equal((await run({ GITHUB_RUN_ATTEMPT: "3" })).outcome.verdict, "RERUN_REFUSED");
  assert.equal((await run({ GITHUB_RUN_ATTEMPT: "2" }, 181, { ...current, head: { sha: BASE } })).outcome.verdict, "RERUN_REFUSED");
  assert.ok(![...first.calls, ...second.calls].some(c => c.method !== "GET" && c.url !== EPOCH_URL), "the gate only observes; it never retries CI or writes authorization");
  elapsed = 0;
  const boundary = await run({}, 180);
  assert.deepEqual([boundary.outcome.admitted, elapsed], [true, 180], "a trusted check visible at the last poll still counts");
});

test("R1: wait overrides cannot restore the old eight-minute polling budget", async () => {
  for (const value of [undefined, "480", "181", "bad", "-1"]) {
    let waited = 0;
    const extra = value === undefined ? {} : { CLUED_ADMISSION_GATE_WAIT_SECONDS: value };
    const outcome = await gate({ env: env(extra), event: withClaim(), eventName: "pull_request",
      fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { body: { check_runs: [] } } }).fetchImpl,
      sleep: async ms => { waited += ms / 1000; } });
    assert.deepEqual([waited, outcome.admitted, outcome.verdict], [180, false, "ADMISSION_PENDING"], String(value));
  }
  let waited = 0;
  const outcome = await gate({ env: env({ CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" }), event: withClaim(), eventName: "pull_request",
    fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { body: { check_runs: [] } } }).fetchImpl,
    sleep: async ms => { waited += ms / 1000; } });
  assert.deepEqual([waited, outcome.admitted], [0, false], "the existing immediate fail-closed test mode stays available");
  for (const limit of [1, 179]) {
    const sleeps = [];
    const expired = await gate({ env: env({ CLUED_ADMISSION_GATE_WAIT_SECONDS: String(limit) }), event: withClaim(), eventName: "pull_request",
      fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { body: { check_runs: [] } } }).fetchImpl,
      sleep: async ms => { sleeps.push(ms / 1000); } });
    assert.equal(sleeps.reduce((a, b) => a + b, 0), limit, "last sleep consumes only the remaining shorter budget");
    assert.equal(sleeps.at(-1), limit % 10);
    assert.deepEqual([expired.admitted, expired.verdict], [false, "ADMISSION_PENDING"]);
  }
});

test("handover gate: a previous green check cannot substitute for the current service epoch", async () => {
  const run=async observation=>{
    const fake=fakeFetch({...SELF_RUN,[CHECKS]:{body:{check_runs:[appCheckRun()]}},[`POST ${EPOCH_URL}`]:observation});
    return gate({env:env({CLUED_CONTEXT_READ_TOKEN:""}),event:withClaim(),eventName:"pull_request",fetchImpl:fake.fetchImpl});
  };
  assert.equal((await run({body:{status:"ok",guard_required:true,epoch_current:true}})).admitted,true);
  const stale=await run({body:{status:"ok",guard_required:true,epoch_current:false}});
  assert.equal(stale.admitted,false);assert.ok(stale.reasons.includes("work_claim_execution_epoch_stale"));
  await assert.rejects(run({status:503,body:null}),/epoch unavailable/);
  await assert.rejects(run({body:{status:"ok",guard_required:true,epoch_current:"true"}}),/observation is invalid/);
});

test("gate: deadlines, errors and fork pull requests, without private Clued credentials", async () => {
  const gateWith = async (list, extraEnv = {}, sleeps = []) => {
    const { fetchImpl, calls } = fakeFetch({ ...SELF_RUN, [CHECKS]: () => ({ body: { check_runs: typeof list === "function" ? list() : list } }) });
    const outcome = await gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", ...extraEnv }), event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    return { outcome, calls };
  };
  const { outcome: admitted, calls } = await gateWith([appCheckRun()]);
  assert.deepEqual([admitted.admitted, admitted.verdict], [true, "ADMITTED"]);
  assert.ok(!calls.some((c) => c.method === "POST" && c.url !== EPOCH_URL), "only the bounded public epoch observation is allowed");

  // It waits for a check that has not been posted yet.
  let polls = 0;
  const sleeps = [];
  let { outcome } = await gateWith(() => { polls += 1; return polls < 3 ? [] : [appCheckRun()]; }, {}, sleeps);
  assert.deepEqual([outcome.admitted, polls, sleeps.length], [true, 3, 2]);

  // Enforced: no check, or a check still pending, at the deadline fails closed.
  ({ outcome } = await gateWith([], { CLUED_ADMISSION_GATE_WAIT_SECONDS: "20" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
  assert.match(outcome.reasons[0], /run 77 has posted no check after 20s/);
  ({ outcome } = await gateWith([appCheckRun({ status: "queued", conclusion: null })], { CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);

  // Merge Admission step 6: the retired switch no longer opens the gate.
  for (const off of RETIRED_SWITCHES) {
    ({ outcome } = await gateWith([appCheckRun({ conclusion: "failure" })], off));
    assert.deepEqual([outcome.admitted, outcome.enforced, outcome.verdict, outcome.advisory], [false, true, "REJECTED", undefined]);
    for (const status of [500, 403]) {
      await assert.rejects(gate({ env: env(off), event: withClaim(), eventName: "pull_request",
        fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { status, body: null } }).fetchImpl, sleep: async () => {} }), new RegExp(`returned ${status}`));
    }
  }
  await assert.rejects(gate({ env: env(), event: withClaim(), eventName: "pull_request",
    fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { status: 500, body: null } }).fetchImpl, sleep: async () => {} }), /returned 500/);
  // A gate job without `checks: read` fails closed and says why; it no
  // longer falls back to the admission workflow run.
  const noChecks = fakeFetch({ ...SELF_RUN, [CHECKS]: { status: 403, body: null } });
  await assert.rejects(gate({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl: noChecks.fetchImpl,
    sleep: async () => {} }), /403: the admission-gate job needs `checks: read`/);
  assert.ok(!noChecks.calls.some((c) => c.url.includes("/actions/workflows/")));

  // A fork pull request, which may not see repository variables, follows the
  // App check like any other.
  const forkEvent = withClaim();
  forkEvent.pull_request.head.repo = { full_name: "someone/r" };
  const forkGate = (list) => gate({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" }),
    event: forkEvent, eventName: "pull_request", sleep: async () => {}, fetchImpl: fakeFetch(checksReturn(list)).fetchImpl });
  let fork = await forkGate([appCheckRun({ conclusion: "failure" })]);
  assert.deepEqual([fork.admitted, fork.enforced, fork.verdict, fork.advisory, fork.notices], [false, true, "REJECTED", undefined, []]);
  fork = await forkGate([]);
  assert.deepEqual([fork.admitted, fork.verdict], [false, "ADMISSION_PENDING"]);
  fork = await forkGate([appCheckRun()]);
  assert.deepEqual([fork.admitted, fork.verdict], [true, "ADMITTED"]);
  await assert.rejects(gate({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: forkEvent, eventName: "pull_request",
    fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { status: 500, body: null } }).fetchImpl, sleep: async () => {} }), /returned 500/);

  // Non-PR events are not admission subjects.
  const push = await gate({ env: env(), event: null, eventName: "push", fetchImpl: fakeFetch({}).fetchImpl });
  assert.deepEqual([push.admitted, push.verdict], [true, "NOT_APPLICABLE"]);
});

test("gate (re-review 2, N3c): the clued-admission App's check decides, never a workflow run's result", async () => {
  const check = appCheckRun;
  const gateWith = async (list, extraEnv = {}, sleeps = []) => {
    const { fetchImpl, calls } = fakeFetch({ ...SELF_RUN, [CHECKS]: () => ({ body: { check_runs: typeof list === "function" ? list() : list } }) });
    const outcome = await gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0", ...extraEnv }),
      event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    return { outcome, calls };
  };
  let { outcome, calls } = await gateWith([check({})]);
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_run.id, outcome.admission_run.workflow_run_id], [true, "ADMITTED", 1, 77]);
  assert.equal(calls.length, 4, "its own run, the checks, the admission run, then current execution epoch");
  assert.match(calls[0].url, /\/actions\/runs\/9001$/);
  assert.match(calls[1].url, /check-runs\?check_name=kooyumi-admission-verified&filter=all/);
  assert.match(calls[2].url, /\/actions\/workflows\/clued-work-admission\.yml\/runs\?head_sha=a{40}&event=pull_request_target/);
  // A successful admission run (for instance one of a pull request into
  // another branch that lists this one) does not admit without the App check.
  ({ outcome, calls } = await gateWith([]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
  // Only the App's own check on this head counts; the newest one decides.
  for (const list of [[check({ app: { id: 15368, slug: "github-actions" } })], [check({ head_sha: "e".repeat(40) })],
    [check({ name: "kooyumi-work-admission" })], [check({ name: "clued-admission-verified" })],
    [check({ id: 1 }), check({ id: 2, conclusion: "failure" })]]) {
    ({ outcome } = await gateWith(list));
    assert.equal(outcome.admitted, false, JSON.stringify(list));
  }
  ({ outcome } = await gateWith([check({ id: 2, conclusion: "failure" }), check({ id: 3 })]));
  assert.equal(outcome.admitted, true, "a later success after a re-run admits");
  // It waits for a check that is still running.
  let polls = 0;
  const sleeps = [];
  ({ outcome } = await gateWith(() => { polls += 1; return polls < 3 ? [check({ status: "in_progress", conclusion: null })] : [check({})]; },
    { CLUED_ADMISSION_GATE_WAIT_SECONDS: "60" }, sleeps));
  assert.deepEqual([outcome.admitted, polls, sleeps.length], [true, 3, 2]);
});

test("gate job digest: every gated workflow's gate job has checks: read; the form without it is refused", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const gated = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]).filter(([, text]) => workflowIsGated(text));
  // Derived from the workflows on this branch, not a pinned count: a pinned count
  // broke main's self-test, and so every pull request, each time a gated
  // workflow was added (#552, #598). Admission itself refuses a removed or changed gate.
  assert.deepEqual(gated.map(([file]) => file).sort(), [...GATED_FILES,'clued-standard-runner-actor-qualification.yml'].sort());
  assert.ok(gated.length > 0);
  for (const [file, text] of gated) {
    if(actorSourceTransition('.github/workflows/'+file,text).passed){
      assert.deepEqual(gateFindings(text,text,{registeredActorTransition:true}),[],file);
      const changed=text.replace('checks: read','checks: write');
      assert.equal(actorSourceTransition('.github/workflows/'+file,changed).passed,false);
      assert.ok(gateFindings(changed,text,{registeredActorTransition:true}).includes('admission_gate_changed'));continue;
    }
    assert.deepEqual(gateFindings(text, text), [], file);
    const withoutChecks = text.replace("      actions: read\n      checks: read\n", "      actions: read\n");
    assert.notEqual(withoutChecks, text, file);
    assert.deepEqual(gateFindings(withoutChecks, text), ["admission_gate_changed"], file);
  }
});

test("workflows: only base-branch jobs in the clued-admission environment get the Clued token", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const holders = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (text.includes("secrets.CLUED_ADMISSION_CLUED_TOKEN")) holders.push(file);
    // Re-review 3, N-R4: the old names are retired, so a re-run of a run from
    // before the rename gets no token and no App key.
    assert.doesNotMatch(text, /secrets\.(CLUED_CONTEXT_READ_TOKEN|CLUED_ADMISSION_APP_PRIVATE_KEY)\b/, file);
  }
  // Merge Admission step 3: clued-merge-slot-ci reports CI states with the same token; step 5:
  // clued-merge-executor reads the queue heads with it.
  assert.deepEqual(holders.sort(), ["clued-merge-executor.yml", "clued-merge-reconcile.yml", "clued-merge-slot-ci.yml", "clued-native617-admission-dispatch.yml", "clued-work-admission-dispatch.yml", "clued-work-admission-reverify.yml", "clued-work-admission.yml"]);
  const measurement = fs.readFileSync(path.join(dir, "clued-ci-usage-report.yml"), "utf8");
  assert.doesNotMatch(measurement, /^ {2}pull_request(?:_target)?:/m, "the measurement credential never enters a PR workflow");
  assert.match(measurement, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}/);
  assert.match(measurement, /environment: clued-admission/);
  assert.doesNotMatch(measurement, /secrets\.CLUED_ADMISSION_CLUED_TOKEN/);
  assert.match(measurement, /CLUED_CONTEXT_READ_TOKEN: \$\{\{ secrets\.CLUED_R9_CLOCK_READ_TOKEN \}\}/);
  const clockReader = fs.readFileSync(path.join(ROOT, "scripts/ci/merge-admission-r9-runtime-inputs.mjs"), "utf8");
  assert.ok(clockReader.indexOf("CLOCK_CREDENTIAL_IS_NOT_THE_ACCEPTED_MINIMAL_BINDING") < clockReader.indexOf("const sealed=await rpc("), "an unaccepted credential cannot reach the clock without the accepted minimal-binding fingerprint");
  const admission = fs.readFileSync(path.join(dir, "clued-work-admission.yml"), "utf8");
  assert.doesNotMatch(admission, /^ {2}pull_request:/m, "no pull_request trigger: PR-edited copies never run");
  assert.match(admission, /^ {2}pull_request_target:$/m);
  for (const file of holders) {
    assert.match(fs.readFileSync(path.join(dir, file), "utf8"), /^ {4}environment: clued-admission$/m, file);
  }
});

// --- Hand dispatch: a heavy workflow runs only after a default-branch admission run verified a claim.

const RUN_NOW = Date.parse("2026-10-02T06:30:00Z");
const ADMIT_RUN = `GET https://api.test/repos/o/r/actions/runs/`;
const dispatchEnv = (overrides = {}) => env({
  CLUED_CONTEXT_READ_TOKEN: "",
  GITHUB_SHA: HEAD,
  GITHUB_WORKFLOW_REF: "o/r/.github/workflows/clued-g4-database.yml@refs/heads/feature/x",
  GITHUB_REF_NAME: "feature/x",
  ...overrides,
});
const dispatchEvent = (runId) => ({ inputs: runId === null ? {} : { admission_run_id: runId }, repository: { default_branch: "main" } });
const admissionRun = (overrides = {}) => ({
  id: 77, path: ".github/workflows/clued-work-admission-dispatch.yml", event: "workflow_dispatch", head_branch: "main",
  status: "completed", conclusion: "success", created_at: "2026-10-02T06:10:00Z",
  display_title: dispatchTitle("clued-g4-database.yml", "feature/x", CLAIM), ...overrides,
});
const ADMIT_JOBS = "GET https://api.test/repos/o/r/actions/runs/77/jobs";
const ADMIT_NOTES = "GET https://api.test/repos/o/r/check-runs/701/annotations";
const dispatchGateWith = async (run, envOverrides = {}, runId = "77", admittedHead = HEAD) => {
  const { fetchImpl, calls } = fakeFetch({
    [ADMIT_JOBS]: { body: { jobs: [{ id: 701 }] } },
    [ADMIT_NOTES]: { body: admittedHead === null ? [] : [{ title: "other", message: "x" }, { title: "clued-admitted-head", message: admittedHead }] },
    [ADMIT_RUN]: run === null ? { status: 404, body: { message: "Not Found" } } : { body: run },
  });
  const outcome = await gate({ env: dispatchEnv(envOverrides), event: dispatchEvent(runId), eventName: "workflow_dispatch", fetchImpl, now: () => RUN_NOW });
  return { outcome, calls };
};

test("dispatch gate: admits only a fresh, successful default-branch admission run naming this workflow and ref", async () => {
  let { outcome, calls } = await dispatchGateWith(admissionRun());
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.claim_id], [true, "ADMITTED", CLAIM]);
  assert.deepEqual(calls.map((c) => c.url), ["https://api.test/repos/o/r/actions/runs/77",
    "https://api.test/repos/o/r/actions/runs/77/jobs", "https://api.test/repos/o/r/check-runs/701/annotations", EPOCH_URL]);
  // Re-review N3: the admission covers the commit it verified, not a later push to the ref.
  ({ outcome } = await dispatchGateWith(admissionRun(), {}, "77", "e".repeat(40)));
  assert.deepEqual([outcome.admitted, outcome.reasons], [false, [`admission_run_other_head:${"e".repeat(40)}`]]);
  ({ outcome } = await dispatchGateWith(admissionRun(), {}, "77", null));
  assert.deepEqual([outcome.admitted, outcome.reasons], [false, ["admission_run_head_unknown"]]);
  assert.deepEqual(calls.find(c => c.url === EPOCH_URL).body.p_input,
    { action: "execution_current", repository: "o/r", head_sha: HEAD, target_branch: "feature/x", workflow: "clued-g4-database.yml" });
  assert.equal(calls.find(c => c.url === EPOCH_URL).body.p_token_hash, null);
  assert.equal(calls.find(c => c.url === EPOCH_URL).headers.authorization, `Bearer ${PUBLIC.key}`);

  const rejects = [
    [admissionRun({ path: ".github/workflows/other.yml" }), /admission_run_wrong_workflow/],
    [admissionRun({ event: "push" }), /admission_run_wrong_event/],
    [admissionRun({ head_branch: "feature/x" }), /admission_run_not_on_default_branch/],
    [admissionRun({ conclusion: "failure" }), /admission_run_not_successful/],
    [admissionRun({ status: "in_progress", conclusion: null }), /admission_run_not_successful/],
    [admissionRun({ created_at: "2026-10-02T05:59:00Z" }), /admission_run_expired/],
    [admissionRun({ display_title: dispatchTitle("information-flow-e2e.yml", "feature/x", CLAIM) }), /admission_run_other_target/],
    [admissionRun({ display_title: dispatchTitle("clued-g4-database.yml", "main", CLAIM) }), /admission_run_other_target/],
    [admissionRun({ display_title: "admit clued-g4-database.yml feature/x not-a-claim" }), /admission_run_other_target/],
  ];
  for (const [run, reason] of rejects) {
    ({ outcome } = await dispatchGateWith(run));
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"], String(reason));
    assert.match(outcome.reasons.join(" "), reason);
  }
  ({ outcome } = await dispatchGateWith(admissionRun(), {}, null));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"]);
  assert.match(outcome.reasons[0], /admission_run_missing: dispatch clued-work-admission-dispatch\.yml/);
  ({ outcome } = await dispatchGateWith(null));
  assert.match(outcome.reasons[0], /admission_run_not_found:77/);

  // The retired switch changes nothing (Merge Admission step 6); a workflow
  // outside the gated list is not a subject.
  ({ outcome } = await dispatchGateWith(admissionRun({ conclusion: "failure" }), { CLUED_WORK_ADMISSION_ENFORCE: "" }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.advisory], [false, "REJECTED", undefined]);
  ({ outcome } = await dispatchGateWith(admissionRun(), { GITHUB_WORKFLOW_REF: "o/r/.github/workflows/mps03-native-agent.yml@refs/heads/main" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "NOT_APPLICABLE"]);
});

test("dispatch gate: uninstalled publisher targets fail closed without admission network reads", async () => {
  for (const file of ["clued-cloud-production-release.yml", "clued-production-publisher-qualification.yml"]) {
    for (const runId of [null, "77"]) {
      const { outcome, calls } = await dispatchGateWith(admissionRun(), {
        GITHUB_WORKFLOW_REF: `o/r/.github/workflows/${file}@refs/heads/main`,
      }, runId);
      assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"]);
      assert.match(outcome.reasons.join(" "), /publisher_dispatch_not_installed/);
      assert.equal(calls.length, 0);
    }
  }
});

test("dispatch admission: verifies the claim on the default branch only, against the ref's head", async () => {
  const base = env({
    GITHUB_REF: "refs/heads/main", CLUED_DEFAULT_BRANCH: "main",
    ADMIT_WORKFLOW: "clued-g4-database.yml", ADMIT_REF: "feature/x", ADMIT_CLAIM_ID: CLAIM, ADMIT_SCOPE: "global",
  });
  const script = {
    [`GET https://api.test/repos/o/r/commits/feature%2Fx`]: { body: { sha: HEAD } },
    [VERIFY]: { body: admittedPayload },
  };
  let { fetchImpl, calls } = fakeFetch(script);
  let outcome = await dispatchAdmit({ env: base, fetchImpl, workspace: ROOT });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.head_sha], [true, "ADMITTED", HEAD]);
  const verify = calls.find((c) => c.method === "POST");
  assert.deepEqual(verify.body.p_input, { scope: "global", claim_id: CLAIM, head_sha: HEAD, ci_dispatch: true,
    repository: "o/r", target_branch: "feature/x", workflow: "clued-g4-database.yml" });
  assert.equal(verify.body.p_token_hash, sha256Hex("clued_bnd_test"));

  ({ fetchImpl } = fakeFetch({ ...script, [VERIFY]: { body: { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } } }));
  outcome = await dispatchAdmit({ env: base, fetchImpl, workspace: ROOT });
  assert.deepEqual([outcome.admitted, outcome.reasons], [false, ["claim_not_current"]]);

  for (const [overrides, message] of [
    [{ GITHUB_REF: "refs/heads/feature/x" }, /runs only on main/],
    [{ ADMIT_WORKFLOW: "public-mcp-behavior.yml" }, /not dispatch-gated/],
    [{ ADMIT_REF: "a b" }, /not a branch or tag/],
    [{ ADMIT_REF: "x/../y" }, /not a branch or tag/],
    [{ ADMIT_CLAIM_ID: "nope" }, /not a claim id/],
    [{ ADMIT_SCOPE: "project:1" }, /not global or project/],
  ]) {
    await assert.rejects(dispatchAdmit({ env: { ...base, ...overrides }, fetchImpl: fakeFetch(script).fetchImpl, workspace: ROOT }), message);
  }
  await assert.rejects(dispatchAdmit({ env: { ...base, CLUED_CONTEXT_READ_TOKEN: "" }, fetchImpl: fakeFetch(script).fetchImpl, workspace: ROOT }), /CLUED_CONTEXT_READ_TOKEN is not set/);
  // Merge Admission step 6: the retired switch no longer turns this into a pass.
  await assert.rejects(dispatchAdmit({ env: { ...base, CLUED_CONTEXT_READ_TOKEN: "", CLUED_WORK_ADMISSION_ENFORCE: "" }, fetchImpl: fakeFetch(script).fetchImpl, workspace: ROOT }), /CLUED_CONTEXT_READ_TOKEN is not set/);
  ({ fetchImpl } = fakeFetch({ ...script, [VERIFY]: { body: { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } } }));
  outcome = await dispatchAdmit({ env: { ...base, CLUED_WORK_ADMISSION_ENFORCE: "false" }, fetchImpl, workspace: ROOT });
  assert.deepEqual([outcome.admitted, outcome.enforced, outcome.advisory], [false, true, undefined]);
});

test("workflows: dispatch-gated workflows take admission_run_id; the admission workflow lists exactly them", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const admit = fs.readFileSync(path.join(dir, "clued-work-admission-dispatch.yml"), "utf8");
  const options = [...admit.matchAll(/^ {10}- (\S+\.yml)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, DISPATCH_GATED_WORKFLOWS);
  assert.match(admit, /^run-name: admit \$\{\{ inputs\.workflow \}\} \$\{\{ inputs\.ref \}\} \$\{\{ inputs\.claim_id \}\}$/m);
  assert.match(admit, /^ {4}if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)$/m);
  assert.doesNotMatch(admit, /^ {2}pull_request/m);
  // Deleted with its checks moved to migration-verify; its name stays in this frozen list and in the disabled
  // dispatch Source until either changes. Exactly this one is missing, nothing else.
  const DELETED = ["clued-connection-authorization.yml"];
  for (const file of DELETED) assert.ok(DISPATCH_GATED_WORKFLOWS.includes(file) && !fs.existsSync(path.join(dir, file)), file);
  for (const file of DISPATCH_GATED_WORKFLOWS.filter((name) => !DELETED.includes(name))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");

    assert.match(text, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}admission_run_id:\n/m, file);
    assert.match(text, /--mode gate/, file);
  }
  for (const file of ["public-mcp-behavior.yml", "public-mcp-protocol.yml"]) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.equal((text.match(/^ {4}needs: admission-gate$/gm) ?? []).length, 2, file);
    assert.match(text, /--mode gate/, file);
  }
});

// --- Gate guard (Owner Decision 37e01bb1).

const GATED_FILES = fs.readdirSync(path.join(ROOT, ".github", "workflows")).filter((name) => /\.ya?ml$/.test(name))
  .filter((name) => workflowIsGated(fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8")))
  .filter(name=>!actorSourceTransition('.github/workflows/'+name,fs.readFileSync(path.join(ROOT,'.github','workflows',name),'utf8')).passed);
// These three workflows acquired the registered source-proof gate after the
// earlier gate-template rollouts. Their actual gates remain covered by the
// all-workflows and retired-switch attack checks below.
const NEWLY_GATED_FILES = ["contract-placement.yml", "gitleaks.yml", "trivy.yml"];
// These consumers use the independently registered Linux Native gate; their
// current gates are covered separately from the historical permission/bootstrap templates.
// clued-required-tests-windows.yml (resident ADR 0032): the Windows side keeps the same Linux gate job, byte for byte.
const INDEPENDENT_LINUX_GATE_FILES = ["clued-required-tests.yml", "clued-required-tests-windows.yml", "clued-g4-database.yml", "clued-front-main-merge.yml"];
const LEGACY_TEMPLATE_FILES = GATED_FILES.filter((name) => !NEWLY_GATED_FILES.includes(name) && !INDEPENDENT_LINUX_GATE_FILES.includes(name));
const SOURCE_PROOF_GATE_DIGEST = "542e34a7c9c11bb713ff3db7e1b57e681e091e6716b29c9a016a86429a590bcb";
// Owner Decisions 325717a6 and 22b0e0ed (PR-B): the Stage C gate on ubuntu-latest that admits on
// the independent CI's own admission with a bounded wait (hostedGateOf below).
const HOSTED_SOURCE_PROOF_GATE_DIGEST = "3f48159e97624c9dd17f6d3e3ae626bc145c69124e4f7e3fbe4de20474d0dfe9";
// Exactly the PR-B change of the self-hosted Stage C gate: runner, timeout and the independent source.
const SELF_HOSTED_GATE_ROUTE = "\n    runs-on: [ self-hosted, Linux, X64, clued, pool-general, trust-internal ]\n    timeout-minutes: 10\n";
const HOSTED_GATE_ROUTE = "\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n";
const SELF_HOSTED_GATE_STEP = "      - id: gate\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n        run:";
const HOSTED_GATE_STEP = "      # Owner Decision 22b0e0ed: admit on the independent CI's own App 5368905 kooyumi-work-admission\n" +
  "      # check for this exact head, polled for at most 10 minutes; never on another App's check.\n" +
  "      - id: gate\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n" +
  "          CLUED_ADMISSION_GATE_SOURCE: independent-ci-native-work-admission\n" +
  "          CLUED_ADMISSION_GATE_WAIT_SECONDS: \"600\"\n        run:";
const hostedGateOf = (text) => text.replace(SELF_HOSTED_GATE_ROUTE, HOSTED_GATE_ROUTE).replace(SELF_HOSTED_GATE_STEP, HOSTED_GATE_STEP);
const selfHostedGateOf = (text) => text.replace(HOSTED_GATE_ROUTE, SELF_HOSTED_GATE_ROUTE).replace(HOSTED_GATE_STEP, SELF_HOSTED_GATE_STEP);
// The frozen PR-B bytes (hosted executors): file -> [main's self-hosted Source, PR-B Source] sha256.
const HOSTED_EXECUTOR_SOURCES = {
  ".github/workflows/gitleaks.yml": ["168aebaf047a7c1b1e96d874f5b79500854175e809a373f236ab1079cff2d579",
    "688073ac1281c4322c90673816b761852989f6849083c07eca2cbd8f4e424091"],
  ".github/workflows/trivy.yml": ["cea2fd770663e65f554719903da90aaf4b8aae4a52bf52098d3d258340e2727d",
    "94e9ac722e3a3e0c4f924ce3b27371803dc2a04b5e177a7b0bcffd2bdf28b810"],
  ".github/workflows/contract-placement.yml": ["762f1b1346a699068660e46648a665d25873a396fc0d2186ef8f44a844625ffd",
    "4898299bee3e804a19acfef51d15b582e5a52526a655a290cf09bb56c39de84b"],
};
const HOSTED_EXECUTOR_NAMES = { ".github/workflows/gitleaks.yml": "gitleaks-hosted-executor",
  ".github/workflows/trivy.yml": "trivy-hosted-executor", ".github/workflows/contract-placement.yml": "contract-placement-hosted-executor" };
const REQUIRED_CHECK_NAMES = ["gitleaks", "trivy", "kooyumi-work-admission", "kooyumi-admission-verified", "kooyumi-merge-slot", "contract-placement"];

// The ungated attack cases exercise the exact registered predecessor, not the
// newly gated working-tree Trivy workflow.
function historicalUngatedTrivy() {
  const profiles = parseWorkflowProfiles(fs.readFileSync(path.join(ROOT, "scripts/ci/clued-gated-proof-profiles.json"), "utf8"));
  const predecessor = profiles.workflows[".github/workflows/trivy.yml"];
  assert.equal(predecessor.gated, false);
  assert.equal(predecessor.source_sha256, "85df37f10587af183dfac642d3f289ae4973ba2623a1e3dceb6537967d0c1e95");
  assert.equal(sha256Hex(predecessor.source_yaml), predecessor.source_sha256);
  assert.equal(workflowIsGated(predecessor.source_yaml), false);
  return predecessor.source_yaml;
}

// Keep the historical one-dependency attack fixtures below in their original
// spelling. The all-workflows test reads the actual new dependency graph;
// clued-push-reuse.test.mjs checks the additional proof dependency itself.
const g4 = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-g4-database.yml"), "utf8")
  .replace("needs: [admission-gate, push-reuse]", "needs: admission-gate")
  .replace("(!cancelled() && needs.admission-gate.result == 'success' &&\n       (github.event_name != 'push' || needs.push-reuse.result != 'success' ||\n        needs.push-reuse.outputs.run_heavy != 'false') &&\n      ((", "((")
  .replace("github.actor == github.repository_owner)))\n    name:", "github.actor == github.repository_owner))\n    name:");

function publisherTransitionFixture() {
  const profiles=JSON.parse(fs.readFileSync(path.join(ROOT,"scripts/ci/clued-production-publisher-sources.json"),"utf8"));
  const entries=profiles.workflows[PRODUCTION_PUBLISHER_WORKFLOW].sources;
  const base=entries.find(s=>s.source_kind==='legacy_predecessor').source_yaml;
  const head=entries.find(s=>s.source_kind==='gated_successor').source_yaml;
  return {base,head,profiles};
}

test("publisher transition: exact trusted dispatch sources retain every canonical gate check",()=>{
  const {base,head,profiles}=publisherTransitionFixture();
  const file={filename:PRODUCTION_PUBLISHER_WORKFLOW,status:"modified"};
  const registeredPublisherTransition=registeredPublisherGatedSuccessor(file,head,base,profiles);
  assert.equal(registeredPublisherTransition,true);
  assert.deepEqual(gateFindings(head,base,{registeredPublisherTransition}),[]);
  assert.ok(gateFindings(head,base).includes("self_hosted_job_switched_ungated:release"));
  assert.equal(registeredPublisherGatedSuccessor(file,head.replaceAll("\n","\r\n"),base,profiles),false,
    "independent review M1: a different raw Git blob is never the registered LF source");
  assert.equal(registeredPublisherGatedSuccessor(file,head,base.replaceAll("\n","\r\n"),profiles),false);
});

test("publisher transition: unknown, ambiguous, unrelated and newly added production sources remain refused",()=>{
  const {base,head,profiles}=publisherTransitionFixture(),file={filename:PRODUCTION_PUBLISHER_WORKFLOW,status:"modified"};
  for(const mutate of [r=>r.schema='unrecognized',r=>r.workflows[PRODUCTION_PUBLISHER_WORKFLOW].registration_status='candidate',
    r=>r.workflows[PRODUCTION_PUBLISHER_WORKFLOW].sources.push(structuredClone(r.workflows[PRODUCTION_PUBLISHER_WORKFLOW].sources[1])),
    r=>r.workflows[PRODUCTION_PUBLISHER_WORKFLOW].sources[1].source_sha256='0'.repeat(64),
    r=>r.workflows[PRODUCTION_PUBLISHER_WORKFLOW].sources[1].workflow_blob='0'.repeat(40),
    r=>r.workflows[PRODUCTION_PUBLISHER_WORKFLOW].sources[1].primary_ids=['other']]) {
    const altered=structuredClone(profiles);mutate(altered);
    assert.equal(registeredPublisherGatedSuccessor(file,head,base,altered),false);
  }
  assert.equal(registeredPublisherGatedSuccessor(file,head,base,null),false);
  assert.equal(registeredPublisherGatedSuccessor(file,head+'\n',base,profiles),false);
  assert.equal(registeredPublisherGatedSuccessor(file,head,null,profiles),false);
  assert.equal(registeredPublisherGatedSuccessor({...file,filename:'.github/workflows/other.yml'},head,base,profiles),false);
  for(const status of ['added','copied','renamed','removed'])assert.equal(registeredPublisherGatedSuccessor({...file,status},head,base,profiles),false);
});

test("publisher transition: even a registered transition cannot waive the frozen gate, dependency or condition",()=>{
  const {base,head}=publisherTransitionFixture();
  for(const [changed,expected] of [
    [head.replace('node-version: 24.19.0','node-version: 24'),'admission_gate_changed'],
    [head.replace('    needs: admission-gate\n',''),'job_not_gated:release'],
    [head.replace("needs.admission-gate.outputs.admitted == 'true' &&",'true &&'),'job_condition_not_gated:release'],
  ])assert.ok(gateFindings(changed,base,{registeredPublisherTransition:true}).includes(expected),expected);
});

test("publisher transition: caller workspace or API profiles never select the trusted default source",async()=>{
  const {base,head}=publisherTransitionFixture();const calls=[];
  const fetchImpl=async url=>{calls.push(String(url));assert.ok(String(url).includes('/contents/.github/workflows/clued-cloud-production-release.yml?ref='));
    const text=String(url).endsWith(`?ref=${HEAD}`)?head+'# caller-only altered source\n':base;
    return new Response(JSON.stringify({content:Buffer.from(text).toString('base64'),encoding:'base64'}),{status:200});};
  const result=await workflowFindings(fetchImpl,{GITHUB_WORKSPACE:'untrusted-profile-fixture'},'o/r',[
    {filename:PRODUCTION_PUBLISHER_WORKFLOW,status:'modified'},
    {filename:'scripts/ci/clued-production-publisher-sources.json',status:'modified'},
  ],HEAD,BASE);
  assert.ok(result.gate.some(f=>f.endsWith('self_hosted_job_switched_ungated:release')));
  assert.equal(calls.length,2);
});

// Owner Decisions 325717a6, 22b0e0ed and bc6fdad1 (A1): this trusted main
// registers the exact PR-B hosted executor Sources as successors of the
// self-hosted ones on main, through the existing exact ordinary/placement
// registrations. Both Sources come from the registry, so this holds before
// and after PR-B lands.
function hostedExecutorPair() {
  const profiles = parseWorkflowProfiles(fs.readFileSync(path.join(ROOT, "scripts/ci/clued-gated-proof-profiles.json"), "utf8"));
  const texts = {};
  for (const [file, [before, after]] of Object.entries(HOSTED_EXECUTOR_SOURCES)) {
    const record = profiles.workflows[file];
    const source = (digest) => [record, ...record.accepted_sources].filter((entry) => entry.source_sha256 === digest);
    assert.equal(source(before).length, 1, `${file}: main's Source is registered once`);
    assert.equal(source(after).length, 1, `${file}: the PR-B Source is registered once`);
    texts[file] = { base: source(before)[0].source_yaml, head: source(after)[0].source_yaml, profile: source(after)[0] };
  }
  return texts;
}
const hostedExecutorFindings = (texts, heads, extra = []) => workflowFindings(async (url) => {
  const [, file, ref] = /\/contents\/(.+)\?ref=(.+)$/.exec(String(url));
  const text = ref === HEAD ? heads[file] : texts[file].base;
  return new Response(JSON.stringify({ content: Buffer.from(text).toString("base64"), encoding: "base64" }), { status: 200 });
}, {}, "o/r", [...Object.keys(heads).map((filename) => ({ filename, status: "modified" })), ...extra], HEAD, BASE);

test("gate guard (A1): the exact PR-B hosted executor Sources are registered successors of main's self-hosted ones", async () => {
  const texts = hostedExecutorPair();
  for (const [file, { base, head, profile }] of Object.entries(texts)) {
    const current=fs.readFileSync(path.join(ROOT,file),"utf8"),
      profiles=parseWorkflowProfiles(fs.readFileSync(path.join(ROOT,"scripts/ci/clued-gated-proof-profiles.json"))),
      specs=JSON.parse(fs.readFileSync(path.join(ROOT,"scripts/ci/clued-gated-proof-role-specs.json"))),
      selected=registeredWorkflowSource(profiles,file,workflowBlob(current));
    assert.equal(selected.passed,true,`${file}: the current ordinary Source must independently register exactly`);
    assert.equal(selected.profile.source_yaml,current);
    const currentRoles=rolesForSource(specs,file,workflowBlob(current));
    assert.ok(currentRoles?.length>0,`${file}: independent current Source roles exist`);
    for(const role of currentRoles)assert.equal(roleDefinitionDigest(role.definition),role.definition_sha256,file);
    if(![base,head].includes(current)){
      const row=profiles.workflows[file],predecessors=[row,...(row.accepted_sources??[])].filter(source=>source.source_yaml!==current&&
        registeredBootstrapOrdinarySuccessor({file:{filename:file,status:'modified'},headText:current,baseText:source.source_yaml,profiles,roleSpecs:specs}).passed);
      assert.equal(predecessors.length,1,`${file}: later ordinary Source has one exact registered predecessor`);
    }
    assert.ok(workflowJobs(base).some((job) => job.name === "admission-gate" && !jobIsHosted(job)), file);
    assert.ok(workflowJobs(head).every((job) => jobIsHosted(job)), file);
    assert.equal(sha256Hex(workflowJobs(head).find((job) => job.name === "admission-gate").lines.join("\n")), HOSTED_SOURCE_PROOF_GATE_DIGEST, file);
    // Owner Decision bc6fdad1: no hosted job carries a required check name.
    assert.deepEqual(profile.routes.map((route) => [route.name, route.self_hosted]), [[HOSTED_EXECUTOR_NAMES[file], false]], file);
    for (const name of REQUIRED_CHECK_NAMES) {
      assert.doesNotMatch(head, new RegExp(`^ {4}name: ${name}$`, "m"), file);
      assert.ok(!head.includes(`'${name}' ||`) && !head.includes(`|| '${name}' }}`), `${file}: ${name} in a dynamic name branch`);
    }
    // The relay identity step is registered as a required step after every scan.
    assert.equal(profile.routes[0].required_steps["Emit relay identity"],1,file);
    const executorRole=rolesForSource(specs,file,workflowBlob(head)).find(role=>role.job_id===profile.routes[0].job_id);
    assert.equal(executorRole.definition.steps.at(-1).name,"Emit relay identity",file);
    assert.match(head, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n {4}steps:$/m, file);
    assert.match(head, /audience=clued-hosted-relay-v1/, file);
  }
  const heads = Object.fromEntries(Object.entries(texts).map(([file, { head }]) => [file, head]));
  assert.deepEqual(await hostedExecutorFindings(texts, heads), { gate: [], owner: [] });
  // The PR-B change set also carries the budget validator, docs and tests.
  assert.deepEqual((await hostedExecutorFindings(texts, heads, [{ filename: "scripts/ci/validate_runner_budget_policy.py", status: "modified" },
    { filename: "docs/maintenance/independent-ci.md", status: "added" }])).gate, []);
});

test("placement Source validation ignores object member order but preserves values and FullRole step order",()=>{
  const file=".github/workflows/contract-placement.yml",{base,head}=hostedExecutorPair()[file],
    profiles=parseWorkflowProfiles(fs.readFileSync(path.join(ROOT,"scripts/ci/clued-gated-proof-profiles.json"))),
    roleSpecs=JSON.parse(fs.readFileSync(path.join(ROOT,"scripts/ci/clued-gated-proof-role-specs.json"))),
    reverseMembers=value=>Array.isArray(value)?value.map(reverseMembers):value&&typeof value==='object'
      ?Object.fromEntries(Object.entries(value).reverse().map(([key,entry])=>[key,reverseMembers(entry)])):value,
    invoke=(p=profiles,r=roleSpecs)=>registeredPlacementSuccessor({file:{filename:file,status:'modified'},headText:head,baseText:base,profiles:p,roleSpecs:r}),
    reordered=reverseMembers(profiles);
  assert.notEqual(JSON.stringify(reordered),JSON.stringify(profiles),'the regression really changes member order');
  assert.equal(invoke().passed,true,'the actual disk/3 semantic view is accepted');
  assert.equal(invoke(reordered,reverseMembers(roleSpecs)).passed,true,'member order carries no Source or Role semantics');
  const changedProfile=structuredClone(profiles),row=changedProfile.workflows[file],
    source=[row,...row.accepted_sources].find(profile=>profile.workflow_blob===workflowBlob(head));
  source.routes[0].required_steps["Emit relay identity"]++;
  assert.equal(invoke(changedProfile).passed,false,'a changed required-step count is still rejected');
  const changedRole=structuredClone(roleSpecs),role=rolesForSource(changedRole,file,workflowBlob(head))[0];
  assert.ok(role.definition.steps.length>1);
  role.definition.steps.reverse();role.definition_sha256=roleDefinitionDigest(role.definition);
  assert.equal(invoke(profiles,changedRole).passed,false,'reordering execution steps cannot self-register even with its recomputed digest');
});

test("gate guard (A1): any other byte of a hosted executor Source is refused, and main's bytes stay valid", async () => {
  const texts = hostedExecutorPair();
  const heads = Object.fromEntries(Object.entries(texts).map(([file, { head }]) => [file, head]));
  const mutations = {
    ".github/workflows/gitleaks.yml": [["timeout-minutes: 15", "timeout-minutes: 14"],
      ["'gitleaks-hosted-executor' ||", "'gitleaks' ||"], ["      id-token: write\n", ""],
      ["audience=clued-hosted-relay-v1", "audience=sts.amazonaws.com"], ["--redact --exit-code 1", "--redact --exit-code 0"]],
    ".github/workflows/trivy.yml": [["timeout-minutes: 15", "timeout-minutes: 14"],
      ["|| 'trivy-hosted-executor-skipped' }}", "|| 'trivy-skipped' }}"], ["      - name: Emit relay identity\n", "      - name: Emit relay identity\n        if: always()\n"]],
    ".github/workflows/contract-placement.yml": [["timeout-minutes: 15", "timeout-minutes: 14"],
      ["    name: contract-placement-hosted-executor\n", "    name: contract-placement\n"], ["      contents: read\n      id-token: write\n", "      contents: write\n      id-token: write\n"]],
  };
  for (const [file, list] of Object.entries(mutations)) {
    for (const [from, to] of list) {
      const changed = { ...heads, [file]: heads[file].replace(from, to) };
      assert.notEqual(changed[file], heads[file], `${file}: ${from}`);
      const { gate } = await hostedExecutorFindings(texts, changed);
      assert.ok(gate.some((finding) => finding.startsWith(`workflow_gate:${file}:`) && finding.endsWith("_Source_not_registered")),
        `${file}: ${from} -> ${JSON.stringify(gate)}`);
    }
  }
  // main's current self-hosted bytes keep their registered gate.
  for (const { base } of Object.values(texts)) assert.deepEqual(gateFindings(base, base), []);
  // An unchanged head (a PR that does not touch these workflows) needs no transition at all.
  const unchanged = await workflowFindings(async () => { throw new Error("no workflow read expected"); }, {}, "o/r",
    [{ filename: "README.md", status: "modified" }], HEAD, BASE);
  assert.deepEqual(unchanged, { gate: [], owner: [] });
});

test("gate guard: every gated workflow on this branch passes and uses a listed gate job", () => {
  // No pinned list (see "gate job digest"); the workflow this file reads below must stay gated.
  assert.ok(GATED_FILES.includes("clued-g4-database.yml"));
  for (const name of NEWLY_GATED_FILES) assert.ok(GATED_FILES.includes(name), name + ": migrated workflow remains gated");
  for (const name of GATED_FILES) {
    const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
    assert.deepEqual(gateFindings(text, text), [], name);
    const gateJob = workflowJobs(text).find((job) => job.name === "admission-gate");
    assert.ok(GATE_JOB_SHA256.has(sha256Hex(gateJob.lines.join("\n"))), name);
    // The gate runs the base branch's script, not the PR's.
    assert.match(gateJob.lines.join("\n"), /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.repository\.default_branch \}\}/);
  }
  // Ungated workflows, even with self-hosted jobs, stay out of scope when they already exist.
  const ungated = historicalUngatedTrivy();
  assert.deepEqual(gateFindings(ungated, ungated), []);
});

const TEMPORARY_GATE_BOOTSTRAP = "      - name: Configure job temporary storage\n        uses: ./.github/actions/ci-temporary-storage\n";
const TEMPORARY_GATE_DIGEST = "d6d96a1eef2f756770304c25b1bf0aab3b8ec72408553ceb141edc0230a995c9";
const ANY_RUNNER_GATE_DIGEST = "b000e5a2bc4b0ca76de4beb7dfc3001dca7a428dde79578e457057081e1109ce";
const SELF_HOSTED_INDEPENDENT_GATE_DIGEST = "9c582144f424d1bc9ef7d3b048d3b7771c7b639ef5544bc04a8a80515c52b2f2";
const withoutTemporaryGateBootstrap = (text) => text.replace(TEMPORARY_GATE_BOOTSTRAP + "      - id: gate\n", "      - id: gate\n");

test("gate guard: the exact PR-read version is registered before workflow rollout; other changes are refused", () => {
  const legacyDigest = "41e789754b90dcb27c8297bf83169194b7aaab2659d909859ddd8618d0fa07c4";
  const prReadDigest = "4136409cf9440c3e8755ed03014cd3c39f90a169f4f8a2ce3d83af2e4a0111cd";
  const noEnforceDigest = "37620beee0357ddf3b46f145e170ea7819db0fbbaded1156d656b9bbfbf2e7dc";
  assert.deepEqual([...GATE_JOB_SHA256], [legacyDigest, prReadDigest, noEnforceDigest, TEMPORARY_GATE_DIGEST, SOURCE_PROOF_GATE_DIGEST,
    HOSTED_SOURCE_PROOF_GATE_DIGEST, ANY_RUNNER_GATE_DIGEST, SELF_HOSTED_INDEPENDENT_GATE_DIGEST], "only the eight exact gate versions");
  // Task 2a5fdb66: contract-placement's independent-admission gate with runs-on moved to the
  // self-hosted Linux pool, nothing else, is accepted; any other runs-on or source is not.
  const placement = fs.readFileSync(new URL("../../.github/workflows/contract-placement.yml", import.meta.url), "utf8");
  const hostedGate = "    name: admission-gate\n    runs-on: ubuntu-latest\n";
  assert.ok(placement.includes(hostedGate), "contract-placement's gate runs on ubuntu-latest on this base");
  const selfHostedGate = hostedGate.replace("ubuntu-latest", "[self-hosted, Linux, X64, clued, pool-general, trust-internal]");
  const selfHostedIndependent = placement.replace(hostedGate, selfHostedGate);
  const gateOf = (text) => sha256Hex(workflowJobs(text).find((job) => job.name === "admission-gate").lines.join("\n"));
  assert.equal(gateOf(selfHostedIndependent), SELF_HOSTED_INDEPENDENT_GATE_DIGEST);
  assert.equal(gateOf(placement), HOSTED_SOURCE_PROOF_GATE_DIGEST);
  assert.match(selfHostedIndependent, /CLUED_ADMISSION_GATE_SOURCE: independent-ci-native-work-admission\n/);
  assert.deepEqual(gateFindings(selfHostedIndependent, null), [], "the self-hosted independent-admission gate is registered");
  assert.deepEqual(gateFindings(placement.replace(hostedGate, selfHostedGate.replace("Linux, ", "Windows, ")), null),
    ["admission_gate_changed"], "another self-hosted runs-on is not");
  assert.deepEqual(gateFindings(selfHostedIndependent.replace('CLUED_ADMISSION_GATE_WAIT_SECONDS: "600"', 'CLUED_ADMISSION_GATE_WAIT_SECONDS: "60"'), null),
    ["admission_gate_changed"], "another wait is not");
  // Decision b30b1b79: the temporary-storage gate with `Linux` dropped from runs-on, nothing else, is accepted.
  const panel = fs.readFileSync(new URL("../../.github/workflows/clued-compute-panel.yml", import.meta.url), "utf8");
  const gateRunsOn = "    name: admission-gate\n    runs-on: [self-hosted, Linux, X64, clued, pool-general, trust-internal]\n";
  assert.ok(panel.includes(gateRunsOn), "the panel's gate is the Linux-only temporary-storage gate on this base");
  const anyRunner = panel.replace(gateRunsOn, gateRunsOn.replace("Linux, ", ""));
  assert.deepEqual(gateFindings(anyRunner, panel), [], "the any-runner gate is registered");
  assert.deepEqual(gateFindings(panel.replace(gateRunsOn, gateRunsOn.replace("Linux, ", "Windows, ")), panel),
    ["admission_gate_changed"], "another runs-on is not");
  // Merge Admission step 6 dropped this line from the gate; the two older
  // versions below still carry it.
  const token = "          GITHUB_TOKEN: ${{ github.token }}\n";
  const enforceLine = "          CLUED_WORK_ADMISSION_ENFORCE: ${{ vars.CLUED_WORK_ADMISSION_ENFORCE }}\n";
  for (const name of LEGACY_TEMPLATE_FILES) {
    const current = withoutTemporaryGateBootstrap(fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8"));
    assert.equal(sha256Hex(workflowJobs(current).find((job) => job.name === "admission-gate").lines.join("\n")), noEnforceDigest, name);
    const withEnforce = current.replace(token, `${enforceLine}${token}`);
    assert.notEqual(withEnforce, current, `${name}: fixture adds the retired variable line back`);
    // Exercise both bootstrap phases, before and after the workflow PR.
    const legacy = withEnforce.replace("      pull-requests: read\n", "");
    const withPrRead = legacy.replace("      contents: read\n    outputs:",
      "      contents: read\n      pull-requests: read\n    outputs:");
    assert.notEqual(withPrRead, legacy, `${name}: fixture adds the permission`);
    assert.deepEqual(gateFindings(legacy, legacy), [], `${name}: old version stays valid`);
    assert.deepEqual(gateFindings(withPrRead, legacy), [], `${name}: only PR read is added`);
    const gateJob = workflowJobs(withPrRead).find((job) => job.name === "admission-gate");
    assert.equal(sha256Hex(gateJob.lines.join("\n")), prReadDigest, name);
    const changes = [
      ["pull request write", "      pull-requests: read", "      pull-requests: write"],
      ["actions write", "      actions: read", "      actions: write"],
      ["additional permission", "      pull-requests: read", "      pull-requests: read\n      issues: read"],
      ["checkout version", "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683", "actions/checkout@v4"],
      ["untrusted ref", "ref: ${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}",
        "ref: ${{ github.event.pull_request.head.sha }}"],
      ["gate command", "run: node scripts/ci/clued-work-admission.mjs --mode gate", "run: echo admitted=true"],
      ["extra step", "      - id: gate\n", "      - run: echo extra\n      - id: gate\n"],
      ["timeout", "    timeout-minutes: 10\n", "    timeout-minutes: 11\n"],
    ];
    for (const [label, from, to] of changes) {
      const changed = withPrRead.replace(from, to);
      assert.notEqual(changed, withPrRead, `${name}: ${label} fixture changed`);
      assert.deepEqual(gateFindings(changed, legacy), ["admission_gate_changed"], `${name}: ${label}`);
    }
  }
});

test("gate guard: only the exact temporary bootstrap template is registered before rollout", () => {
  for (const name of LEGACY_TEMPLATE_FILES) {
    const legacy = withoutTemporaryGateBootstrap(fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8"));
    const candidate = legacy.replace("      - id: gate\n", TEMPORARY_GATE_BOOTSTRAP + "      - id: gate\n");
    assert.notEqual(candidate, legacy, name);
    assert.equal(sha256Hex(workflowJobs(candidate).find(job => job.name === "admission-gate").lines.join("\n")), TEMPORARY_GATE_DIGEST, name);
    assert.deepEqual(gateFindings(candidate, legacy), [], name);
    // Old templates remain admitted; their temporary lifecycle is checked separately.
    assert.deepEqual(gateFindings(legacy, candidate), [], name);
    for (const changed of [
      candidate.replace(TEMPORARY_GATE_BOOTSTRAP, TEMPORARY_GATE_BOOTSTRAP + "        if: false\n"),
      candidate.replace(TEMPORARY_GATE_BOOTSTRAP, TEMPORARY_GATE_BOOTSTRAP.replace("./.github/", "./candidate/.github/")),
      candidate.replace(TEMPORARY_GATE_BOOTSTRAP, TEMPORARY_GATE_BOOTSTRAP + "        env:\n          TMPDIR: /tmp/shared\n"),
      candidate.replace(TEMPORARY_GATE_BOOTSTRAP, TEMPORARY_GATE_BOOTSTRAP + "      - run: echo extra\n"),
      candidate.replace("ref: ${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}", "ref: ${{ github.event.pull_request.head.sha }}"),
      candidate.replace("run: node scripts/ci/clued-work-admission.mjs --mode gate", "run: echo admitted=true"),
    ]) {
      assert.notEqual(changed, candidate, name);
      assert.deepEqual(gateFindings(changed, legacy), ["admission_gate_changed"], name);
    }
  }
});

test("gate guard (Merge Admission step 6): every gated workflow's gate no longer passes CLUED_WORK_ADMISSION_ENFORCE", () => {
  const token = "          GITHUB_TOKEN: ${{ github.token }}\n";
  for (const name of GATED_FILES) {
    const current = fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
    const gateJob = workflowJobs(current).find((job) => job.name === "admission-gate");
    assert.ok(!gateJob.lines.some((line) => /_ENFORCE\b/.test(line)), `${name}: the gate reads no retired switch`);
    if (INDEPENDENT_LINUX_GATE_FILES.includes(name)) {
      assert.equal(sha256Hex(gateJob.lines.join("\n")), SELF_HOSTED_INDEPENDENT_GATE_DIGEST, name);
    } else if (NEWLY_GATED_FILES.includes(name)) {
      // Owner Decisions 325717a6 and 22b0e0ed (PR-B): the Stage C gate on ubuntu-latest that admits on
      // the independent CI's own admission; exactly runner, timeout and gate source differ.
      const text = gateJob.lines.join("\n");
      const hosted = hostedGateOf(text), selfHosted = selfHostedGateOf(hosted);
      assert.ok([SOURCE_PROOF_GATE_DIGEST, HOSTED_SOURCE_PROOF_GATE_DIGEST].includes(sha256Hex(text)), name);
      assert.equal(sha256Hex(hosted), HOSTED_SOURCE_PROOF_GATE_DIGEST, name);
      assert.equal(sha256Hex(selfHosted), SOURCE_PROOF_GATE_DIGEST, name);
    } else {
      assert.equal(sha256Hex(workflowJobs(withoutTemporaryGateBootstrap(current)).find(job => job.name === "admission-gate").lines.join("\n")), "37620beee0357ddf3b46f145e170ea7819db0fbbaded1156d656b9bbfbf2e7dc", name);
    }
    assert.deepEqual(gateFindings(current, current), [], name);
    // Dropping the token or adding another variable is still a changed gate.
    assert.deepEqual(gateFindings(current.replace(token, ""), current), ["admission_gate_changed"], name);
    assert.deepEqual(gateFindings(current.replace(token, `          CLUED_OWNER_REVIEW_ENFORCE: \${{ vars.CLUED_OWNER_REVIEW_ENFORCE }}\n${token}`), current),
      ["admission_gate_changed"], name);
  }
});

test("gate guard: the gate runs on the self-hosted Linux pool with a pinned Node", () => {
  const gateJob = workflowJobs(g4).find((job) => job.name === "admission-gate");
  const text = gateJob.lines.join("\n");
  assert.ok(GATE_JOB_SHA256.has(sha256Hex(text)), "the gate is one of the exact registered versions");
  assert.match(text, /^    runs-on: \[self-hosted, Linux, X64, clued, pool-general, trust-internal\]$/m);
  assert.match(text, /^          node-version: 24\.19\.0$/m);
  // A different, unregistered hosted runner or Node remains a changed gate.
  // ubuntu-latest with this complete Native gate is a separately registered family.
  const hosted = g4
    .replace("    runs-on: [self-hosted, Linux, X64, clued, pool-general, trust-internal]\n    timeout-minutes: 15\n",
      "    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n")
    .replace("      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 24.19.0\n      - id: gate\n",
      "      - id: gate\n");
  assert.notEqual(hosted, g4);
  assert.deepEqual(gateFindings(hosted, g4), ["admission_gate_changed"]);
  assert.deepEqual(gateFindings(g4.replace("node-version: 24.19.0", "node-version: 24"), g4), ["admission_gate_changed"]);
  assert.deepEqual(gateFindings(g4.replace("pool-general, trust-internal]\n    timeout-minutes: 15", "pool-general]\n    timeout-minutes: 15"), g4), ["admission_gate_changed"]);
});

test("gate guard: removing or loosening the gate is found", () => {
  const job = "database-gate-trusted-self-hosted";
  const cases = [
    [g4.replace(/\n  admission-gate:\n[\s\S]*?\n\n(?=  database-gate-trusted-self-hosted:)/, "\n"), ["admission_gate_missing"]],
    [g4.replace("          ref: ${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}\n", ""), ["admission_gate_changed"]],
    [g4.replace("        run: node scripts/ci/clued-work-admission.mjs --mode gate", "        run: echo admitted=true >> \"$GITHUB_OUTPUT\""), ["admission_gate_changed"]],
    [g4.replace(`  ${job}:\n    needs: admission-gate\n`, `  ${job}:\n`), [`job_not_gated:${job}`]],
    [g4.replace(`  ${job}:\n    needs: admission-gate\n    if: >-\n      needs.admission-gate.outputs.admitted == 'true' &&`, `  ${job}:\n    needs: admission-gate\n    if: >-\n      always() ||`), [`job_condition_not_gated:${job}`]],
    [g4.replace(`  ${job}:\n    needs: admission-gate\n    if: >-\n      needs.admission-gate.outputs.admitted == 'true' &&\n      ((`, `  ${job}:\n    needs: admission-gate\n    if: >-\n      needs.admission-gate.outputs.admitted == 'true' && (true) || ((`), [`job_condition_not_gated:${job}`]],
    [g4.replace(`  ${job}:\n    needs: admission-gate\n    if: >-`, `  ${job}:\n    needs: admission-gate\n    if: always()\n    x-old-if: >-`), [`job_condition_not_gated:${job}`]],
    [`${g4}\n  sneaky:\n    runs-on: [self-hosted, Linux]\n    steps:\n      - run: npm test\n`, ["job_not_gated:sneaky"]],
  ];
  for (const [text, expected] of cases) {
    assert.notEqual(text, g4, `fixture did not change: ${expected}`);
    assert.deepEqual(gateFindings(text, g4), expected);
  }
  // Equivalent spellings of needs are accepted.
  const listed = g4.replace(`  ${job}:\n    needs: admission-gate\n`, `  ${job}:\n    needs: [admission-gate]\n`);
  assert.deepEqual(gateFindings(listed, g4), []);
  const block = g4.replace(`  ${job}:\n    needs: admission-gate\n`, `  ${job}:\n    needs:\n      - admission-gate\n`);
  assert.deepEqual(gateFindings(block, g4), []);
  const bare = g4.replace(`    if: >-\n      needs.admission-gate.outputs.admitted == 'true' &&\n      ((github.event_name == 'workflow_dispatch' &&\n       github.actor == github.repository_owner)`, `    if: \${{ needs.admission-gate.outputs.admitted == 'true' }}\n    x-was: ((github.event_name == 'workflow_dispatch' &&\n       github.actor == github.repository_owner)`);
  assert.notEqual(bare, g4);
  assert.deepEqual(gateFindings(bare, g4), []);
});

test("gate guard: new workflows with self-hosted jobs need the gate; new hosted ones do not", () => {
  const hosted = "name: x\non: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  assert.deepEqual(gateFindings(hosted, null), []);
  const selfHosted = hosted.replace("ubuntu-latest", "[self-hosted, Linux, X64]");
  assert.deepEqual(gateFindings(selfHosted, null), ["admission_gate_missing"]);
  const comment = hosted.replace("    steps:", "    # self-hosted was considered\n    steps:");
  assert.deepEqual(gateFindings(comment, null), []);
});

test("gate guard: the exact state_change expression stays hosted without weakening other expressions", () => {
  const hosted = "name: x\non: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  const expression = "${{ inputs.reason == 'state_change' && 'ubuntu-latest' || 'ubuntu-slim' }}";
  const withRunner = (runner) => hosted.replace("ubuntu-latest", runner);
  for (const runner of [expression, `${expression} # fixed hosted branches`]) {
    const text = withRunner(runner);
    assert.equal(jobIsHosted(workflowJobs(text)[0]), true, runner);
    assert.deepEqual(gateFindings(text, null), [], runner);
    assert.deepEqual(gateFindings(text, hosted), [], runner);
  }
  const unsafe = [
    expression.replace("'ubuntu-latest'", "'self-hosted'"),
    expression.replace("'ubuntu-slim'", "'self-hosted'"),
    expression.replace("'ubuntu-latest'", "''"),
    expression.replace("'ubuntu-slim'", "''"),
    expression.replace("'ubuntu-latest'", "inputs.runner"),
    expression.replace("'ubuntu-slim'", "matrix.os"),
    expression.replace("'ubuntu-slim'", "vars.runner"),
    expression.replace(" }}", " || inputs.runner }}"),
    expression.replace(" || 'ubuntu-slim'", ""),
    expression.replace("state_change", "other"),
    expression.replace("ubuntu-latest", "ubuntu-24.04"),
    expression.replace(" && ", " &&\n      "),
    `${expression}#not-a-comment`,
    `"${expression}"`,
  ];
  for (const runner of unsafe) {
    const text = withRunner(runner);
    assert.equal(jobIsHosted(workflowJobs(text)[0]), false, runner);
    assert.deepEqual(gateFindings(text, null), ["admission_gate_missing"], runner);
    assert.deepEqual(gateFindings(text, hosted), ["self_hosted_job_switched_ungated:build"], runner);
  }
  for (const extra of ["    uses: ./.github/workflows/heavy.yml\n", "    <<: *heavy\n"]) {
    const text = withRunner(expression).replace("    steps:", `${extra}    steps:`);
    assert.equal(jobIsHosted(workflowJobs(text)[0]), false, extra);
    assert.deepEqual(gateFindings(text, null), ["admission_gate_missing"], extra);
    assert.deepEqual(gateFindings(text, hosted), ["self_hosted_job_switched_ungated:build"], extra);
  }
});

test("gate guard (re-review N4): YAML the line reader cannot follow is refused, and other expressions do not count as hosted", () => {
  const hosted = "name: x\non: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  const cases = [
    [`${g4}\n  "evil":\n    runs-on: [self-hosted, Linux]\n    steps:\n      - run: x\n`, /workflow_not_canonical:job_line/],
    [`${g4}\n  evil: {runs-on: [self-hosted, Linux], steps: [{run: x}]}\n`, /workflow_not_canonical:job_line/],
    [`${g4}\n  evil: *anchor\n`, /workflow_not_canonical:job_line/],
    ["name: x\non: pull_request\njobs:\n    evil:\n      runs-on: [self-hosted]\n      steps:\n        - run: x\n", /workflow_not_canonical:job_line/],
    ["name: x\non: pull_request\njobs: {evil: {runs-on: self-hosted}}\n", /workflow_not_canonical:jobs/],
    ["name: x\non: pull_request\n\"jobs\":\n  evil:\n    runs-on: self-hosted\n", /workflow_not_canonical:jobs/],
    [`${hosted}---\njobs:\n  evil:\n    runs-on: self-hosted\n`, /workflow_not_canonical:jobs/],
    [hosted.replace("    runs-on", "\truns-on"), /workflow_not_canonical:(tab|job_line)/],
  ];
  for (const [text, finding] of cases) {
    assert.match(gateFindings(text, null).join(" "), finding, text.slice(-80));
    assert.match(gateFindings(text, g4).join(" "), finding);
  }
  // Re-review 2: a lone CR (or NEL, LS, PS, or another control character) is a
  // line break to YAML parsers but not to the line reader, so it could hide a
  // whole job; it is refused anywhere in the file. CRLF stays allowed.
  const smuggled = "  smuggled:{0}    runs-on: [self-hosted, Linux]{0}    steps:{0}      - run: x";
  for (const brk of ["\r", "\u0085", "\u2028", "\u2029", "\u000b", "\u000c"]) {
    const text = `${g4.trimEnd()}${brk}${smuggled.replaceAll("{0}", brk)}\n`;
    assert.deepEqual(gateFindings(text, g4), ["workflow_not_canonical:line_break"], JSON.stringify(brk));
    assert.deepEqual(gateFindings(text, null), ["workflow_not_canonical:line_break"]);
  }
  assert.deepEqual(workflowFormFindings(g4.replace(/\n/g, "\r\n")), [], "CRLF files are fine");
  // Labels that are not one literal GitHub-hosted image count as self-hosted.
  for (const runsOn of ["[Linux, X64, clued]", "${{ format('{0}-hosted','self') }}", "[ubuntu-latest, self-hosted]",
    "\n      - ubuntu-latest", "${{ matrix.os }}", "\n      group: runners"]) {
    const text = hosted.replace(" ubuntu-latest", ` ${runsOn}`);
    assert.deepEqual(gateFindings(text, null), ["admission_gate_missing"], runsOn);
  }
  assert.deepEqual(gateFindings(hosted.replace("ubuntu-latest", "'ubuntu-24.04'"), null), []);
  const reusable = "name: x\non: pull_request\njobs:\n  call:\n    uses: ./.github/workflows/heavy.yml\n";
  assert.deepEqual(gateFindings(reusable, null), ["admission_gate_missing"]);
  const merged = hosted.replace("    steps:", "    <<: *heavy\n    steps:");
  assert.deepEqual(gateFindings(merged, null), ["admission_gate_missing"]);
  // An existing ungated short check may not grow a new self-hosted job.
  const trivy = historicalUngatedTrivy();
  assert.deepEqual(gateFindings(`${trivy}\n  extra:\n    runs-on: [self-hosted, Linux]\n    steps:\n      - run: x\n`, trivy),
    ["self_hosted_job_added_ungated:extra"]);
  assert.deepEqual(gateFindings(`${trivy}\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: x\n`, trivy), []);
  // Every workflow in this repository is in the form the guard reads.
  for (const name of fs.readdirSync(path.join(ROOT, ".github", "workflows")).filter((n) => /\.ya?ml$/.test(n))) {
    assert.deepEqual(workflowFormFindings(fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8")), [], name);
  }
});

test("enforced: a PR that unties a heavy job from the gate is REJECTED even with an admitted claim", async () => {
  const stripped = g4.replace("  database-gate-trusted-self-hosted:\n    needs: admission-gate\n", "  database-gate-trusted-self-hosted:\n");
  const b64 = (text) => ({ body: { content: Buffer.from(text).toString("base64"), encoding: "base64" } });
  const CONTENTS = "GET https://api.test/repos/o/r/contents/.github/workflows/clued-g4-database.yml";
  const workflowFiles = { body: [{ filename: ".github/workflows/clued-g4-database.yml", status: "modified" },
    { filename: ".github/workflows/old.yml", status: "removed" }, { filename: "apps/clued-cloud/package.json", status: "modified" }] };
  const OLD = "GET https://api.test/repos/o/r/contents/.github/workflows/old.yml";
  const oldWorkflow = b64("name: old\non: pull_request\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n");
  const { fetchImpl, calls } = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } },
    [OLD]: oldWorkflow, [CONTENTS]: (call) => (call.url.endsWith(`?ref=${HEAD}`) ? b64(stripped) : b64(g4)) });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["workflow_gate:.github/workflows/clued-g4-database.yml:job_not_gated:database-gate-trusted-self-hosted"]);
  // Re-review 7, MAJOR-3: a removed workflow is read at the base only, to see
  // whether it held an environment.
  assert.deepEqual(calls.filter((c) => c.url.includes("old.yml")).map((c) => c.url.endsWith(`?ref=${BASE}`)), [true]);
  // Re-review N8: a PR the guard refuses is verified read-only, so it neither
  // binds the claim nor uses the Task's CI budget.
  const refusedVerify = calls.find((c) => c.method === "POST" && c.body?.p_input?.action !== 'resolve_pr_claim');
  assert.deepEqual(Object.keys(refusedVerify.body.p_input).sort(), ["changed_paths", "claim_id", "scope"]);
  // The same PR with the gate intact is admitted (its workflow paths are
  // protected, so with the Owner Grant that Owner review always needs now).
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const intact = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } }, [OLD]: oldWorkflow, [CONTENTS]: b64(g4),
    [DOOR]: { body: { status: "ok", admitted: true, grant: { grant_id: "g1" } } } });
  const ok = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl: intact.fetchImpl });
  assert.deepEqual([ok.admitted, ok.reasons], [true, []]);
  assert.ok(ok.notices.some((n) => n.startsWith("owner_review_granted:g1")));
  // Merge Admission step 6: the retired switch no longer softens it.
  const unset = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } }, [OLD]: oldWorkflow,
    [CONTENTS]: (call) => (call.url.endsWith(`?ref=${HEAD}`) ? b64(stripped) : b64(g4)) });
  const still = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request", fetchImpl: unset.fetchImpl });
  assert.equal(still.admitted, false);
  assert.ok(still.reasons.some((r) => r.startsWith("workflow_gate:")));
});

// --- App-posted check (Owner Decision 37e01bb1).

test("efficiency claimless code and docs still publish only through Native's existing no-publication decision", async () => {
  for (const filename of ['apps/clued-cloud/worker/example.ts', 'docs/example.md']) {
    const unbound = call => ({ body: bindingPayload(call.body.p_input, { binding_status: 'unbound', scope: null,
      task_id: null, claim: null, head_authorization_id: null }) });
    const actualPR = freshPull({ body: '', head: { sha: HEAD }, changed_files: 1 });
    const environment = env({ CLUED_MERGE_ADMISSION_STATE: 'efficiency', CLUED_ADMISSION_APP_ID: '12345',
      CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() });
    const { fetchImpl, calls } = fakeFetch({
      [FILES]: { body: [{ filename }] }, [PULL]: { body: actualPR },
      [`${VERIFY}#resolve_pr_claim`]: unbound,
      [VERIFY]: { body: { status: 'ok', publication_required: false } },
      'GET https://api.test/repos/o/r/installation': { body: { id: 99 } },
      'POST https://api.test/app/installations/99/access_tokens': { body: { token: 'ghs_app' } },
      'POST https://api.test/repos/o/r/check-runs': { body: { id: 5 } },
    });
    const evaluated = await evaluateIn({ env: environment, event: { pull_request: actualPR }, eventName: 'pull_request', fetchImpl,
      readPolicyFile: fixedPolicy(RECOMMENDED_POLICY_TEXT) });
    assert.equal(evaluated.admitted, true);
    const posted = await postAppCheckCore({ env: environment, fetchImpl, headSha: HEAD, success: true,
      title: 'ADMITTED', summary: 'fixture', prNumber: 452, readPolicyFile: fixedPolicy(RECOMMENDED_POLICY_TEXT) });
    assert.equal(posted.posted, true, posted.error);
    assert.equal(posted.conclusion, 'success');
    const input = calls.find(c => c.body?.p_input?.action === 'publication_begin').body.p_input;
    assert.equal(Object.hasOwn(input, 'scope'), false);
    assert.equal(Object.hasOwn(input, 'claim_id'), false);
  }
});

test("claimless publication cannot bypass strict policy, protected tip paths or an explicit Native refusal", async () => {
  const cases = [
    { mode: 'normal' }, { mode: 'efficiency', filename: 'scripts/ci/protected.mjs' },
    { mode: 'efficiency', tipPaths: [{ filename: 'config/merge-admission-policy.json' }] },
    { mode: 'efficiency', native: { status: 'rejected', publication_required: false } },
    { mode: 'efficiency', native: { status: 'ok', publication_required: false, verdict: 'REJECTED' } },
    { mode: 'efficiency', native: { status: 'ok', publication_required: true, verdict: 'ADMITTED' } },
    { mode: 'efficiency', binding_status: 'conflict' },
  ];
  for (const item of cases) {
    const { fetchImpl, calls } = fakeFetch({
      [FILES]: { body: [{ filename: item.filename ?? 'docs/example.md' }] },
      [PULL]: { body: freshPull({ body: '', head: { sha: HEAD }, changed_files: 1 }) },
      [`GET https://api.test/repos/o/r/compare/${TIP}...`]: { body: { status: 'ahead', files: item.tipPaths ?? [] } },
      [`${VERIFY}#resolve_pr_claim`]: call => ({ body: bindingPayload(call.body.p_input, {
        binding_status: item.binding_status ?? 'unbound', scope: null, task_id: null, claim: null, head_authorization_id: null }) }),
      [VERIFY]: { body: item.native ?? { status: 'ok', publication_required: false } },
    });
    const posted = await postAppCheckCore({ env: env({ CLUED_MERGE_ADMISSION_STATE: item.mode,
      CLUED_ADMISSION_APP_ID: '12345', CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() }), fetchImpl,
      headSha: HEAD, success: true, title: 'ADMITTED', summary: 'fixture', prNumber: 452,
      readPolicyFile: fixedPolicy(RECOMMENDED_POLICY_TEXT) });
    assert.equal(posted.posted, false, JSON.stringify(item));
    assert.ok(!calls.some(c => c.url.endsWith('/check-runs') && c.method === 'POST'));
  }
});

test("app check: posts the admission result as the App on the evaluated head", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = appJwt("12345", pem, 1_800_000_000);
  const [h, p, sig] = jwt.split(".");
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });

  const appEnv = (extra) => env({ GITHUB_RUN_ID: "77", ADMISSION_PR_NUMBER: "452",
    CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: pem, ADMISSION_HEAD_SHA: HEAD, ...extra });
  const script = () => fakeFetch({
    [FILES]: files, [PULL]: { body: freshPull({head:{sha:HEAD}}) }, [VERIFY]: {body:{...admittedPayload,publication_required:false}},
    "GET https://api.test/repos/o/r/installation": { body: { id: 99 } },
    "POST https://api.test/app/installations/99/access_tokens": { status: 201, body: { token: "ghs_app" } },
    "POST https://api.test/repos/o/r/check-runs": { status: 201, body: { id: 5 } },
  });
  for (const [outcome, conclusion] of [["success", "success"], ["failure", "failure"], ["skipped", "failure"]]) {
    const { fetchImpl, calls } = script();
    const result = await appCheck({ env: appEnv({ ADMISSION_OUTCOME: outcome }), fetchImpl, now: () => 1_800_000_000_000 });
    assert.deepEqual([result.posted, result.conclusion, result.head_sha], [true, conclusion, HEAD], outcome);
    assert.match(calls.find(c=>c.url.endsWith('/installation')).headers.authorization, /^Bearer ey/, "installation lookup uses the App JWT");
    assert.deepEqual(calls.find(c=>c.url.endsWith('/access_tokens')).body, { repositories: ["r"], permissions: { checks: "write" } });
    const post = calls.find(c=>c.method==='POST'&&c.url.endsWith('/check-runs'));
    assert.equal(post.headers.authorization, "Bearer ghs_app");
    assert.deepEqual([post.body.name, post.body.head_sha, post.body.status, post.body.conclusion], [APP_CHECK_NAME, HEAD, "completed", conclusion]);
    assert.equal(post.body.external_id, "pr:452:run:77");
  }
  // Re-review 4, m1: the check names its pull request and admission run.
  const named = script();
  await appCheck({ env: appEnv({ ADMISSION_OUTCOME: "success", ADMISSION_PR_NUMBER: "452" }), fetchImpl: named.fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(named.calls.find(c=>c.method==='POST'&&c.url.endsWith('/check-runs')).body.external_id, "pr:452:run:77");
  // Not configured, or no evaluated head: nothing is posted.
  let quiet = await appCheck({ env: appEnv({ CLUED_ADMISSION_APP_PRIVATE_KEY: "" }), fetchImpl: fakeFetch({}).fetchImpl });
  assert.equal(quiet.posted, false);
  assert.match(quiet.reason, /not configured/);
  quiet = await appCheck({ env: appEnv({ ADMISSION_HEAD_SHA: "" }), fetchImpl: fakeFetch({}).fetchImpl });
  assert.match(quiet.reason, /no head commit/);
  // An API failure is an error, never a silent pass.
  const broken = await appCheck({ env: appEnv({ ADMISSION_OUTCOME: "success" }), fetchImpl: fakeFetch({
    [FILES]:files,[PULL]:{body:freshPull({head:{sha:HEAD}})},[VERIFY]:{body:{...admittedPayload,publication_required:false}},
    "GET https://api.test/repos/o/r/installation": { status: 404, body: {} } }).fetchImpl });
  assert.match(broken.error, /returned 404/);
});

test("app check: the admission workflow posts it after the admission step, keys from the environment", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  assert.match(text, /id: admit\n/);
  assert.match(text, /if: \$\{\{ !cancelled\(\)[^\n]*\}\}\n[\s\S]*ADMISSION_HEAD_SHA: \$\{\{ steps\.admit\.outputs\.head_sha \|\| github\.event\.pull_request\.head\.sha \}\}[\s\S]*secrets\.CLUED_ADMISSION_APP_KEY[\s\S]*--mode app-check/);
  // Re-review 3, N-R4: the admission job checks out the branch as it is now,
  // not the event's base commit that a re-run would replay. Re-review 6, B1:
  // always the default branch, never the pull request's base branch, whose
  // script an Agent could have edited, since pull_request_target hands this
  // environment's secrets to a pull request into any branch.
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n[\s\S]*--mode required/);
  assert.doesNotMatch(text, /pull_request\.base\.sha/);
  assert.doesNotMatch(text, /ref: \$\{\{ github\.event\.pull_request\.base\.ref/);
  assert.match(text, /environment: clued-admission/);
});

// --- Multi-copy write-back: a merged pull request is reported once for adoption.

const ADOPT = `POST ${PUBLIC.url}/rest/v1/rpc/clued_work_claim_adopt_v1`;
const MERGE = "d".repeat(40);
const merged = (overrides = {}) => {
  const value = event({ body: overrides.body ?? `Body\n\nClued-Work-Claim: ${CLAIM}` });
  Object.assign(value.pull_request, { merged: true, merge_commit_sha: MERGE }, overrides.pull_request ?? {});
  return { action: "closed", ...value, ...(overrides.action ? { action: overrides.action } : {}) };
};

test("adopt: a merged copy's pull request is reported with the token hash, its pr_ref and merge commit", async () => {
  assert.equal(ADOPT_RPC, "clued_work_claim_adopt_v1");
  const adopted = { status: "ok", adopted: true, replayed: false, claim_id: CLAIM, task_id: "t-1", copy_index: 2,
    receipt_id: "r-1", not_adopted: ["c-1", "c-3"], pr_ref: "o/r#452" };
  const adoptedScope = 'project:11111111-2222-4333-8444-555555555555';
  const { fetchImpl, calls } = fakeFetch({ [ADOPT]: { body: adopted }, [`${VERIFY}#resolve_pr_claim`]: call => {
    const value = bindingPayload(call.body.p_input);
    return { body: { ...value, scope: adoptedScope, claim: { ...value.claim, context_key: adoptedScope } } };
  } });
  const result = await adoptMerged({ env: env(), event: merged({ body: `B\n\nClued-Work-Claim: ${CLAIM}\nClued-Work-Scope: project:11111111-2222-4333-8444-555555555555` }),
    eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.deepEqual([result.adopted, result.error, result.pr_ref, result.merge_sha], [true, null, "o/r#452", MERGE]);
  assert.equal(calls.length, 2, 'read-only identity lookup followed by the one adoption mutation');
  assert.equal(calls[0].body.p_input.read_only, true);
  const adoption = calls.find(c => c.url.endsWith(`/rpc/${ADOPT_RPC}`));
  assert.equal(adoption.headers.apikey, PUBLIC.key);
  assert.equal(adoption.headers.authorization, `Bearer ${PUBLIC.key}`);
  assert.deepEqual(adoption.body, { p_token_hash: sha256Hex("clued_bnd_test"),
    p_input: { scope: "project:11111111-2222-4333-8444-555555555555", pr_ref: "o/r#452", merge_sha: MERGE } });
});

test("adopt: not a copy, a lost race and an unmerged close change nothing; failures are errors", async () => {
  let r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", workspace: ROOT,
    fetchImpl: fakeFetch({ [ADOPT]: { body: { status: "ok", adopted: false, reason: "no_copy_for_pr", pr_ref: "o/r#452" } } }).fetchImpl });
  assert.deepEqual([r.adopted, r.reason, r.error], [false, "no_copy_for_pr", null]);
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", workspace: ROOT,
    fetchImpl: fakeFetch({ [ADOPT]: { body: { status: "rejected", error_code: "copy_not_adopted", adopted_claim_id: "c-9" } } }).fetchImpl });
  assert.deepEqual([r.adopted, r.error], [false, null]);
  assert.match(r.reason, /copy_not_adopted/);

  // No Clued call at all: other events, no trailer, no token.
  for (const [value, name] of [[merged({ action: "synchronize" }), "pull_request_target"], [merged(), "pull_request"]]) {
    const { fetchImpl, calls } = fakeFetch({});
    r = await adoptMerged({ env: env(), event: value, eventName: name, fetchImpl, workspace: ROOT });
    assert.deepEqual([r.adopted, r.reason, calls.length], [false, "not a merged pull request", 0]);
  }
  let fake = fakeFetch({ [`${VERIFY}#resolve_pr_claim`]: call => ({ body: bindingPayload(call.body.p_input,
    { binding_status: 'unbound', scope: null, task_id: null, claim: null, head_authorization_id: null }) }) });
  r = await adoptMerged({ env: env(), event: merged({ body: "no trailer" }), eventName: "pull_request_target", fetchImpl: fake.fetchImpl, workspace: ROOT });
  assert.match(r.reason, /no Native PR Task binding/);
  assert.ok(fake.calls.every(c => c.body?.p_input?.action === 'resolve_pr_claim'), 'no mutation without a binding');
  // Explanatory text does not determine the already-bound identity.
  fake = fakeFetch({ [COMMIT]: { body: { commit: { message: `x\n\nClued-Work-Claim: ${CLAIM}` } } },
    [ADOPT]: { body: { status: "ok", adopted: false, reason: "no_copy_for_pr" } } });
  r = await adoptMerged({ env: env(), event: merged({ body: "no trailer" }), eventName: "pull_request_target", fetchImpl: fake.fetchImpl, workspace: ROOT });
  assert.deepEqual([r.claim_id, r.scope, r.reason], [CLAIM, "global", "no_copy_for_pr"]);
  fake = fakeFetch({});
  r = await adoptMerged({ env: env({ CLUED_CONTEXT_READ_TOKEN: "" }), event: merged(), eventName: "pull_request_target", fetchImpl: fake.fetchImpl, workspace: ROOT });
  assert.deepEqual([r.adopted, fake.calls.length], [false, 0]);
  assert.match(r.reason, /not set/);

  // A missing merge commit, a refused token or a transport answer is an error.
  r = await adoptMerged({ env: env(), event: merged({ pull_request: { merge_commit_sha: null } }), eventName: "pull_request_target", fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
  assert.match(r.error, /no merge commit/);
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", workspace: ROOT,
    fetchImpl: fakeFetch({ [ADOPT]: { status: 401, body: { code: "42501", message: "binding_not_authorized" } } }).fetchImpl });
  assert.match(r.error, /returned 401/);
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", workspace: ROOT,
    fetchImpl: fakeFetch({ [ADOPT]: { status: 400, body: { code: "22023", message: "work_claim_pr_ref_invalid" } } }).fetchImpl });
  assert.match(r.error, /work_claim_pr_ref_invalid/);
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", workspace: ROOT, fetchImpl: fakeFetch({}).fetchImpl });
  assert.match(r.error, /returned 599/);
  // Not deployed yet: reported, not an error.
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", workspace: ROOT,
    fetchImpl: fakeFetch({ [ADOPT]: { status: 404, body: { code: "PGRST202" } } }).fetchImpl });
  assert.deepEqual([r.error, /not deployed/.test(r.reason)], [null, true]);
});

test("adopt: main exits 1 only on an error and writes a summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-"));
  const eventPath = path.join(dir, "event.json");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(eventPath, JSON.stringify(merged()));
  const base = env({ GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: ROOT });
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    let code = await main(["--mode", "adopt"], base, fakeFetch({ [ADOPT]: { body: { status: "ok", adopted: true, copy_index: 1, task_id: "t-1", not_adopted: ["c-2"] } } }).fetchImpl);
    assert.equal(code, 0);
    assert.match(fs.readFileSync(summary, "utf8"), /Adopted copy 1 of Task `t-1`; 1 other copy put out/);
    code = await main(["--mode", "adopt"], base, fakeFetch({}).fetchImpl);
    assert.equal(code, 1);
  } finally { console.log = log; console.error = error; }
});

test("adopt: the admission workflow runs it for a closed pull request into the default branch, from the default branch", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  // The types the adopt job needs (closed) and that re-judge a pull request; the full
  // list is pinned on pull request heads (merge-admission-policy-file.test.mjs).
  const types = /^ {4}types: \[([^\]]*)\]$/m.exec(text);
  for (const type of ["opened", "synchronize", "reopened", "edited", "closed"]) assert.ok(types && types[1].split(", ").includes(type), type);
  // Re-review 6, B1: both jobs hold the environment's secrets, so both run
  // only for pull requests into the default branch.
  const intoDefault = "github.event.pull_request.base.ref == github.event.repository.default_branch";
  const admit = text.slice(text.indexOf("  clued-work-admission:"), text.indexOf("  clued-work-adopt:"));
  assert.match(admit, /^ {4}if: >-\n {6}github\.event\.action != 'closed' &&\n/m);
  assert.ok(admit.includes(`\n      ${intoDefault}\n`), "admission runs only for pull requests into the default branch");
  const job = text.slice(text.indexOf("  clued-work-adopt:"));
  // Owner Decision 2ea795e4: a close without a merge returns the merge slot.
  assert.match(job, /^ {4}if: >-\n {6}github\.event\.action == 'closed' &&\n/m);
  assert.ok(job.includes(`\n      ${intoDefault}\n`), "adoption runs only for pull requests into the default branch");
  assert.match(job, /^ {4}environment: clued-admission$/m);
  assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n {10}persist-credentials: false/);
  assert.match(job, /--mode adopt$/m);
  assert.doesNotMatch(job, /head\.sha|head\.ref|merge_commit_sha/);
});

// --- Re-review 3 (main d0100ff4).

test("gate (re-review 3 N-R1, re-review 5 n1): only the admission run of this event decides", async () => {
  const gateWith = async (list, runs = [admissionTargetRun()], extraEnv = {}) => {
    const { fetchImpl, calls } = fakeFetch({ ...checksReturn(list), [ADMISSION_RUNS]: { body: { workflow_runs: runs } } });
    const outcome = await gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0", ...extraEnv }),
      event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async () => {} });
    return { outcome, calls };
  };
  assert.equal(SAME_EVENT_MS, 15_000);
  // An admission run of an earlier event (a force-push back to an admitted
  // commit, a reopened pull request) does not count, whenever its check posted.
  const earlier = admissionTargetRun({ created_at: "2026-10-02T03:59:44Z" });
  let { outcome } = await gateWith([appCheckRun({ id: 5, started_at: "2026-10-02T04:00:40Z" })], [earlier]);
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "NO_ADMISSION_RUN"]);
  assert.match(outcome.reasons[0], /from the admission run of this event \(created since 2026-10-02T04:00:00Z less 15s\)/);
  // The runs of one event are created together; a few seconds apart still count.
  ({ outcome } = await gateWith([appCheckRun({ id: 5 })], [admissionTargetRun({ created_at: "2026-10-02T03:59:46Z" })]));
  assert.equal(outcome.admitted, true);
  // Closed and reopened within seconds: the reopen's admission run is the
  // newest, so the earlier event's success does not admit while it runs ...
  const reopened = admissionTargetRun({ id: 78, created_at: "2026-10-02T04:00:01Z", status: "in_progress", conclusion: null });
  const first = admissionTargetRun({ created_at: "2026-10-02T03:59:50Z" });
  ({ outcome } = await gateWith([appCheckRun({ id: 5 })], [first, reopened]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
  assert.match(outcome.reasons[0], /run 78 has posted no check/);
  // ... and its failure decides once posted, whatever the check ids.
  ({ outcome } = await gateWith([appCheckRun({ id: 9 }), appCheckRun({ id: 6, conclusion: "failure", external_id: "pr:452:run:78" })], [first, reopened]));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_run.workflow_run_id], [false, "REJECTED", 78]);
  // Another pull request's admission run on the same head is passed over.
  const other = admissionTargetRun({ id: 79, created_at: "2026-10-02T04:00:02Z" });
  ({ outcome } = await gateWith([appCheckRun(), appCheckRun({ id: 7, external_id: "pr:453:run:79" })], [admissionTargetRun(), other]));
  assert.deepEqual([outcome.admitted, outcome.admission_run.workflow_run_id], [true, 77]);
  // A skipped admission run (a pull request with this head into another
  // branch, re-review 6) posts nothing and is passed over.
  ({ outcome } = await gateWith([appCheckRun()], [admissionTargetRun(), admissionTargetRun({ id: 80, created_at: "2026-10-02T04:00:03Z", conclusion: "skipped" })]));
  assert.deepEqual([outcome.admitted, outcome.admission_run.workflow_run_id], [true, 77]);
  // Only main's pull_request_target admission runs are looked at.
  ({ outcome } = await gateWith([appCheckRun()], [admissionTargetRun({ event: "pull_request" })]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "NO_ADMISSION_RUN"]);
  // A check naming no admission run, or a run without a creation time, counts for nothing.
  ({ outcome } = await gateWith([appCheckRun({ external_id: "pr:452" })]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
  ({ outcome } = await gateWith([appCheckRun()], [admissionTargetRun({ created_at: null })]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "NO_ADMISSION_RUN"]);
  // The gate needs its own run id; without it, enforced fails closed.
  await assert.rejects(gate({ env: env({ GITHUB_RUN_ID: "" }), event: withClaim(), eventName: "pull_request",
    fetchImpl: fakeFetch(checksReturn([appCheckRun()])).fetchImpl, sleep: async () => {} }), /GITHUB_RUN_ID is not set/);
});

test("gate (re-review 3, N-R3; Merge Admission step 2): a pull request run's re-run is judged again, a dispatch run's is refused", async () => {
  assert.equal(rerunAttempt({}), null);
  assert.equal(rerunAttempt({ GITHUB_RUN_ATTEMPT: "1" }), null);
  assert.equal(rerunAttempt({ GITHUB_RUN_ATTEMPT: "3" }), 3);
  const titled = (title, overrides = {}) => appCheckRun({ output: { title }, ...overrides });
  const current = (overrides = {}) => ({ [PULL]: { body: { number: 452, state: "open", head: { sha: HEAD }, base: { ref: "main" }, ...overrides } } });
  const rerun = async (attempt, checks, { pull = current(), envOverrides = {}, runs } = {}) => {
    const script = { ...checksReturn(checks), ...pull, ...(runs ? { [ADMISSION_RUNS]: { body: { workflow_runs: runs } } } : {}) };
    const { fetchImpl, calls } = fakeFetch(script);
    const outcome = await gate({ env: env({ GITHUB_RUN_ATTEMPT: String(attempt), CLUED_ADMISSION_GATE_WAIT_SECONDS: "0", ...envOverrides }),
      event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async () => {} });
    return { outcome, calls };
  };
  // "Re-run all jobs" on the current head within the title's allowance.
  let { outcome, calls } = await rerun(2, [titled("ADMITTED [normal · code · reruns 1]")]);
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_mode.label], [true, "ADMITTED", "normal · code · reruns 1"]);
  assert.equal(calls[0].url, "https://api.test/repos/o/r/pulls/452", "the current head is read first");
  ({ outcome } = await rerun(3, [titled("ADMITTED [normal · docs · reruns 2]")]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"]);
  // Past the allowance, or a title without one (an admission run from before step 2).
  for (const [attempt, title, reason] of [[3, "ADMITTED [normal · code · reruns 1]", /run attempt 3: the code layer allows 1 re-run\(s\) per head in normal/],
    [4, "ADMITTED [normal · docs · reruns 2]", /run attempt 4: the docs layer allows 2/], [2, "ADMITTED", /run attempt 2: the admission check names no re-run allowance/],
    [2, "ADMITTED [normal · code · reruns 0]", /allows 0 re-run/]]) {
    ({ outcome } = await rerun(attempt, [titled(title)]));
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"], title);
    assert.match(outcome.reasons[0], reason);
    assert.match(outcome.reasons[0], /only "Re-run all jobs" of the current head's run/);
  }
  // An old head, a closed pull request, or one that cannot be read: refused before any check is read.
  for (const pull of [current({ head: { sha: "e".repeat(40) } }), current({ state: "closed" }), current({ base: { ref: "release" } }), { [PULL]: { status: 500, body: null } }]) {
    ({ outcome, calls } = await rerun(2, [titled("ADMITTED [normal · code · reruns 1]")], { pull }));
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"]);
    assert.ok(!calls.some((c) => c.url.includes("/check-runs")), "no check is read for a stale re-run");
  }
  // A newer failing check for this pull request (the re-verification) wins over the event's admission.
  ({ outcome } = await rerun(2, [titled("ADMITTED [normal · code · reruns 1]"),
    appCheckRun({ id: 9, conclusion: "failure", external_id: "pr:452:run:999", output: { title: "RE-VERIFIED: REJECTED [normal · code · reruns 1]" } })]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"]);
  assert.match(outcome.reasons[0], /kooyumi-admission-verified of App .* 9 concluded failure/);
  // ...and a newer success (an older admission run re-run after a grant) is not shadowed by the event's failure.
  ({ outcome } = await rerun(2, [titled("REJECTED [normal · code · reruns 1]", { conclusion: "failure" }),
    appCheckRun({ id: 9, external_id: "pr:452:run:70", output: { title: "ADMITTED [normal · code · reruns 1]" } })]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"]);
  // A frozen newer check holds too (the retired switch changes nothing).
  ({ outcome } = await rerun(2, [titled("ADMITTED [normal · code · reruns 1]"),
    appCheckRun({ id: 9, conclusion: "failure", external_id: "pr:452:run:999", output: { title: "RE-VERIFIED: REJECTED [frozen · code · reruns 1]" } })],
  { envOverrides: { CLUED_WORK_ADMISSION_ENFORCE: "" } }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.enforced], [false, "REJECTED", true]);
  // The admission run is itself running again: its earlier check does not count.
  ({ outcome } = await rerun(2, [titled("ADMITTED [normal · code · reruns 1]")], { runs: [admissionTargetRun({ status: "in_progress", conclusion: null })] }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
  // Merge Admission step 6: the retired switch unset no longer admits a refused re-run.
  ({ outcome } = await rerun(3, [titled("ADMITTED [normal · code · reruns 1]")], { envOverrides: { CLUED_WORK_ADMISSION_ENFORCE: "" } }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.advisory], [false, "RERUN_REFUSED", undefined]);
  // Nor in frozen.
  ({ outcome } = await rerun(3, [titled("ADMITTED [frozen · code · reruns 1]")], { envOverrides: { CLUED_WORK_ADMISSION_ENFORCE: "" } }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.enforced], [false, "RERUN_REFUSED", true]);
  ({ outcome } = await gateRun([titled("REJECTED [frozen · docs · reruns 1]", { conclusion: "failure" })], { CLUED_WORK_ADMISSION_ENFORCE: "" }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.enforced], [false, "REJECTED", true]);
  // A branch dispatch run's re-run stays refused.
  ({ outcome } = await dispatchGateWith(admissionRun(), { GITHUB_RUN_ATTEMPT: "2" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"]);
});

// The first attempt of a gate run against a list of App checks.
async function gateRun(checks, envOverrides = {}) {
  const { fetchImpl, calls } = fakeFetch(checksReturn(checks));
  const outcome = await gate({ env: env({ CLUED_ADMISSION_GATE_WAIT_SECONDS: "0", ...envOverrides }), event: withClaim(), eventName: "pull_request",
    fetchImpl, sleep: async () => {} });
  return { outcome, calls };
}

test("gate guard (re-review 3, N-R5): an ungated workflow may not move a job to a self-hosted runner or loosen its timeout", () => {
  const ungated = historicalUngatedTrivy();
  const job = "trivy-trusted-self-hosted";
  const selfHosted = workflowJobs(ungated).find((j) => j.name === job);
  assert.equal(jobTimeout(selfHosted), 25);
  const cases = [
    [ungated.replace("    timeout-minutes: 25\n", ""), [`self_hosted_timeout_raised_ungated:${job}`]],
    [ungated.replace("    timeout-minutes: 25\n", "    timeout-minutes: 360\n"), [`self_hosted_timeout_raised_ungated:${job}`]],
    [ungated.replace("    timeout-minutes: 25\n", "    timeout-minutes: ${{ vars.T }}\n"), [`self_hosted_timeout_raised_ungated:${job}`]],
  ];
  for (const [text, expected] of cases) {
    assert.notEqual(text, ungated, String(expected));
    assert.deepEqual(gateFindings(text, ungated), expected);
  }
  assert.deepEqual(gateFindings(ungated.replace("    timeout-minutes: 25\n", "    timeout-minutes: 10\n"), ungated), [], "a lower timeout is fine");
  // A hosted job of an ungated workflow switched to a self-hosted runner.
  const hosted = workflowJobs(ungated).find((j) => jobIsHosted(j));
  assert.ok(hosted, "trivy.yml has a hosted job");
  const runsOn = hosted.lines.find((line) => /^ {4}runs-on:/.test(line));
  const switched = ungated.replace(hosted.lines.join("\n"), hosted.lines.join("\n").replace(runsOn, "    runs-on: [self-hosted, Linux]\n    timeout-minutes: 5"));
  assert.notEqual(switched, ungated);
  assert.deepEqual(gateFindings(switched, ungated), [`self_hosted_job_switched_ungated:${hosted.name}`]);
});

test("a missing or role-less admission token names the secret to update", () => {
  assert.equal(withTokenHint("CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified."),
    `CLUED_CONTEXT_READ_TOKEN is not set; admission cannot be verified. ${ADMISSION_TOKEN_HINT}`);
  assert.match(withTokenHint("REJECTED: admission_binding_required"), /CLUED_ADMISSION_CLUED_TOKEN/);
  assert.match(ADMISSION_TOKEN_HINT, /clued-admission environment/);
  assert.equal(withTokenHint("REJECTED: claim_not_current"), "REJECTED: claim_not_current");
});

test("gate (re-review 4, m1): only an App check naming this pull request admits it", async () => {
  const gateWith = async (list) => gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" }),
    event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch(checksReturn(list)).fetchImpl, sleep: async () => {} });
  for (const externalId of [undefined, null, "", "pr:453:run:77", "pr:452", "pr:4520:run:77", "x pr:452:run:77"]) {
    const outcome = await gateWith([appCheckRun({ external_id: externalId })]);
    assert.equal(outcome.admitted, false, String(externalId));
  }
  // Another pull request's later success does not hide this one's failure.
  const outcome = await gateWith([appCheckRun({ id: 1, conclusion: "failure" }), appCheckRun({ id: 2, external_id: "pr:453:run:78" })]);
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"]);
  assert.equal(checkNamesPullRequest({ external_id: "pr:452:run:77" }, 452), true);
});

test("app check (re-review 4, m1): the posted check names the pull request and the admission run", async () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  assert.match(workflow, /ADMISSION_PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
});

test("gate guard (re-review 4, m3): an ungated self-hosted job may not add or change its strategy", () => {
  const ungated = historicalUngatedTrivy();
  const job = "trivy-trusted-self-hosted";
  const matrix = ungated.replace("    timeout-minutes: 25\n", "    timeout-minutes: 25\n    strategy:\n      matrix:\n        shard: [1, 2, 3]\n");
  assert.notEqual(matrix, ungated);
  assert.deepEqual(gateFindings(matrix, ungated), [`self_hosted_strategy_changed_ungated:${job}`]);
  assert.deepEqual(gateFindings(ungated, ungated), []);
});

// Owner Decision 586181ec: an ungated self-hosted job's strategy may lose
// matrix entries, and change nothing else.
const SHRUNK = [];
const STRATEGY_CHANGED = ["self_hosted_strategy_changed_ungated:trivy-trusted-self-hosted"];
const NOT_PLAIN_JOB_KEY = /^workflow_not_canonical:job_key:\d+$/;
const INCLUDE_STRATEGY = [
  "    strategy:",
  "      fail-fast: false",
  "      max-parallel: 2",
  "      matrix:",
  "        include:",
  "          # One entry per runner.",
  "          - runner_name: runner-a",
  "            route_label: route-a",
  "          - runner_name: runner-b",
  "            route_label: \"route-b\"",
  "          - runner_name: runner-c",
  "            route_label: route-c",
];
// The historical ungated Trivy workflow with these strategy lines on its self-hosted job.
const withStrategy = (lines) => historicalUngatedTrivy().replace("    timeout-minutes: 25\n", `    timeout-minutes: 25\n${lines.join("\n")}\n`);
const dropLines = (lines, ...drop) => lines.filter((_, i) => !drop.includes(i));
const setLine = (lines, i, ...text) => [...lines.slice(0, i), ...text, ...lines.slice(i + 1)];
const insertLines = (lines, i, ...text) => [...lines.slice(0, i), ...text, ...lines.slice(i)];
function assertShrinkCases(cases) {
  for (const [label, base, head, expected] of cases) {
    const baseText = withStrategy(base);
    const headText = withStrategy(head);
    assert.notEqual(headText, baseText, label);
    // A RegExp: the head is refused, by its form (Task b5234943) rather than by the strategy check.
    if (expected instanceof RegExp) assert.match(gateFindings(headText, baseText).join(" "), expected, label);
    else assert.deepEqual(gateFindings(headText, baseText), expected, label);
  }
}

test("gate guard (Owner Decision 586181ec): an include entry may be removed, nothing added or changed", () => {
  const S = INCLUDE_STRATEGY;
  const lastGone = dropLines(S, 10, 11);
  assertShrinkCases([
    ["remove the last entry", S, lastGone, SHRUNK],
    ["remove a middle entry", S, dropLines(S, 8, 9), SHRUNK],
    ["remove all but one entry", S, dropLines(S, 8, 9, 10, 11), SHRUNK],
    ["remove an entry and reword the comment", S, setLine(lastGone, 5, "          # Runner c is retired."), SHRUNK],
    ["remove an entry, drop the comment and add a blank line", S, insertLines(dropLines(S, 5, 10, 11), 4, ""), SHRUNK],
    ["remove every entry", S, dropLines(S, 5, 6, 7, 8, 9, 10, 11), STRATEGY_CHANGED],
    ["add an entry", S, [...S, "          - runner_name: runner-d", "            route_label: route-d"], STRATEGY_CHANGED],
    ["replace an entry by a new one", S, [...lastGone, "          - runner_name: runner-d", "            route_label: route-d"], STRATEGY_CHANGED],
    ["change a value in a kept entry", S, setLine(lastGone, 7, "            route_label: route-x"), STRATEGY_CHANGED],
    ["change a value without a removal", S, setLine(S, 7, "            route_label: route-x"), STRATEGY_CHANGED],
    ["requote a value in a kept entry", S, setLine(lastGone, 9, "            route_label: route-b"), STRATEGY_CHANGED],
    ["add a key to a kept entry", S, insertLines(lastGone, 8, "            extra: x"), STRATEGY_CHANGED],
    ["remove a key from a kept entry", S, dropLines(S, 7), STRATEGY_CHANGED],
    ["change fail-fast", S, setLine(lastGone, 1, "      fail-fast: true"), STRATEGY_CHANGED],
    ["remove fail-fast", S, dropLines(lastGone, 1), STRATEGY_CHANGED],
    ["change max-parallel", S, setLine(lastGone, 2, "      max-parallel: 3"), STRATEGY_CHANGED],
    ["remove max-parallel", S, dropLines(lastGone, 2), STRATEGY_CHANGED],
    ["add max-parallel after the matrix", dropLines(S, 2), [...dropLines(lastGone, 2), "      max-parallel: 4"], STRATEGY_CHANGED],
    ["add an exclude", S, insertLines(lastGone, 4, "        exclude:", "          - runner_name: runner-a"), STRATEGY_CHANGED],
    ["add an axis", S, insertLines(lastGone, 4, "        shard: [1, 2]"), STRATEGY_CHANGED],
    ["reorder the keys", S, [S[0], S[2], S[1], ...lastGone.slice(3)], STRATEGY_CHANGED],
    // Decided: a reorder is a change (an include entry may overwrite values an
    // earlier one added), with or without a removal.
    ["reorder the entries", S, [...S.slice(0, 6), ...S.slice(8, 10), ...S.slice(6, 8), ...S.slice(10)], STRATEGY_CHANGED],
    ["reorder the entries and remove one", S, [...S.slice(0, 6), ...S.slice(8, 10), ...S.slice(6, 8)], STRATEGY_CHANGED],
    // Decided: comments and blank lines alone remove nothing, so a change of
    // only those stays reported, as before.
    ["change only the comment", S, setLine(S, 5, "          # Runners a to c."), STRATEGY_CHANGED],
    ["change only a trailing comment", [...S, "          # End of the list."], [...S, "          # Last runner: c."], STRATEGY_CHANGED],
    ["add only a blank line", S, insertLines(S, 6, ""), STRATEGY_CHANGED],
  ]);
  // A removal does not hide a timeout raise next to it.
  const raised = withStrategy(lastGone).replace("    timeout-minutes: 25\n", "    timeout-minutes: 360\n");
  assert.deepEqual(gateFindings(raised, withStrategy(S)), ["self_hosted_timeout_raised_ungated:trivy-trusted-self-hosted"]);
  assert.deepEqual(gateFindings(withStrategy(S), withStrategy(S)), []);
});

// Bootstrap review 11af4710, finding 1: jobField's view of a field ends at a
// comment line indented four spaces or less, but YAML reads on past it.
test("gate guard (re-review 4, m3): a comment line indented less than the strategy does not hide entries after it", () => {
  const S = INCLUDE_STRATEGY;
  const runnerD = ["          - runner_name: runner-d", "            route_label: route-d"];
  assertShrinkCases([
    ["entries appended after a four-space comment", [...S, "    # more runners"], [...S, "    # more runners", ...runnerD], STRATEGY_CHANGED],
    ["entries appended after a column-0 comment", [...S, "# more runners"], [...S, "# more runners", ...runnerD], STRATEGY_CHANGED],
    ["an entry added after a two-space comment inside the list", insertLines(S, 6, "  # runners"),
      [...insertLines(S, 6, "  # runners"), ...runnerD], STRATEGY_CHANGED],
    ["fail-fast changed after a four-space comment", insertLines(S, 1, "    # options"),
      setLine(insertLines(S, 1, "    # options"), 2, "      fail-fast: true"), STRATEGY_CHANGED],
    // The exemption still applies across such a comment.
    ["an entry removed after a four-space comment", insertLines(S, 10, "    # retired below"), insertLines(dropLines(S, 10, 11), 10, "    # retired below"), SHRUNK],
    // A trailing comment or blank line carries nothing, as before.
    ["only a trailing comment added after the strategy", S, [...S, "  # end of matrix"], []],
    ["only a trailing blank line added after the strategy", S, [...S, ""], []],
  ]);
});

// Each case took from a minute to many minutes with the quadratic code it guards against.
test("gate guard (Owner Decision 586181ec): large strategies are read in linear time", () => {
  const S = INCLUDE_STRATEGY;
  const axis = ["    strategy:", "      matrix:", "        os: [a, b]"];
  const spaces = " ".repeat(1000000);
  const many = (count, line) => Array.from({ length: count }, (_, n) => line(n));
  const cases = [
    ["a long run of spaces in a line", S, [...dropLines(S, 10, 11), `     ${spaces}x`]],
    ["a long run of spaces in a flow item", axis, ["    strategy:", "      matrix:", `        os: [a${spaces}x]`]],
    ["many keys in one mapping", axis, ["    strategy:", "      matrix:", "        os: [a]", ...many(60000, (n) => `        k${n}: 1`)]],
    ["one large kept entry against many base entries", [...S.slice(0, 5), ...many(50000, (n) => `          - n: ${n}`)],
      [...S.slice(0, 5), "          - k0: 0", ...many(30000, (n) => `            k${n + 1}: 0`)]],
  ];
  for (const [label, base, head] of cases) {
    const started = Date.now();
    assert.deepEqual(gateFindings(withStrategy(head), withStrategy(base)), STRATEGY_CHANGED, label);
    assert.ok(Date.now() - started < 5000, `${label}: ${Date.now() - started} ms`);
  }
});

test("gate guard (Owner Decision 586181ec): an axis value may be removed only from a matrix without include", () => {
  const flow = ["    strategy:", "      matrix:", "        shard: [1, 2, 3]", "        os: [linux]"];
  const block = ["    strategy:", "      matrix:", "        shard:", "          - 1", "          - 2", "          - 3"];
  const withInclude = [...flow, "        include:", "          - shard: 2", "            extra: x", "          - shard: 3", "            extra: y"];
  const withExclude = [...flow, "        exclude:", "          - shard: 1", "          - shard: 2"];
  assertShrinkCases([
    ["remove a flow value", flow, setLine(flow, 2, "        shard: [1, 3]"), SHRUNK],
    ["remove all but one flow value", flow, setLine(flow, 2, "        shard: [3]"), SHRUNK],
    ["remove a block value", block, dropLines(block, 4), SHRUNK],
    ["remove every flow value", flow, setLine(flow, 2, "        shard: []"), STRATEGY_CHANGED],
    ["remove every block value", block, dropLines(block, 3, 4, 5), STRATEGY_CHANGED],
    ["remove an axis", flow, dropLines(flow, 3), STRATEGY_CHANGED],
    ["add a value", flow, setLine(flow, 2, "        shard: [1, 2, 3, 4]"), STRATEGY_CHANGED],
    ["replace a value", flow, setLine(flow, 2, "        shard: [1, 2, 4]"), STRATEGY_CHANGED],
    ["reorder and remove", flow, setLine(flow, 2, "        shard: [3, 1]"), STRATEGY_CHANGED],
    ["flow to block with fewer values", flow, [...flow.slice(0, 2), "        shard:", "          - 1", "          - 3", flow[3]], STRATEGY_CHANGED],
    // A removed value could turn an include entry into a combination of its own.
    ["remove a value next to include", withInclude, setLine(withInclude, 2, "        shard: [1, 3]"), STRATEGY_CHANGED],
    ["remove an include entry next to an axis", withInclude, dropLines(withInclude, 7, 8), SHRUNK],
    ["remove a value next to exclude", withExclude, setLine(withExclude, 2, "        shard: [1, 2]"), SHRUNK],
    ["remove an exclude entry", withExclude, dropLines(withExclude, 6), STRATEGY_CHANGED],
    ["remove an entry of an Exclude written in another case", setLine(withExclude, 4, "        Exclude:"),
      dropLines(setLine(withExclude, 4, "        Exclude:"), 6), STRATEGY_CHANGED],
    ["add an exclude entry", withExclude, [...withExclude, "          - shard: 3"], STRATEGY_CHANGED],
  ]);
});

test("gate guard (Owner Decision 586181ec): a strategy that is not read with certainty stays reported", () => {
  const S = INCLUDE_STRATEGY;
  // Each pair is the same base form with the last entry removed in the head.
  const both = (label, lines) => [label, lines, lines.filter((line) => !/runner-c|route-c/.test(line)), STRATEGY_CHANGED];
  assertShrinkCases([
    both("an anchor", setLine(S, 3, "      matrix: &m")),
    both("an anchor and an alias on values", setLine(setLine(S, 9, "            route_label: *n"), 6, "          - runner_name: &n runner-a")),
    both("an inline comment", setLine(S, 7, "            route_label: route-a # a")),
    both("a block scalar", setLine(S, 7, "            route_label: |", "              route-a")),
    both("a multi-line plain scalar", insertLines(S, 8, "              more")),
    both("a bare dash", setLine(S, 6, "          -", "            runner_name: runner-a")),
    both("an indentless sequence", S.map((line) => line.replace(/^ {10}/, "        "))),
    both("uneven indentation", setLine(S, 7, "             route_label: route-a")),
    ["a line less indented than the strategy keys", [...S, "     extra: [1]"], [...dropLines(S, 10, 11), "     extra: [1, 2, 3]"], STRATEGY_CHANGED],
    both("a duplicate key", insertLines(S, 8, "            route_label: route-z")),
    both("a no-break space", setLine(S, 7, "            route_label: route-a ")),
    both("a merge key in the job", insertLines(S, 0, "    <<: *defaults")),
    // Task b5234943: a job key that is not plain is refused by its form.
    [...both("a quoted second strategy key", [...S, "    \"strategy\":", "      matrix:", "        n: [1, 2, 3]"]).slice(0, 3), NOT_PLAIN_JOB_KEY],
    both("a second strategy key in another case", [...S, "    Strategy:", "      matrix:", "        n: [1, 2, 3]"]),
    both("a strategy line with a value", setLine(S, 0, "    strategy: # entries below")),
    ["a flow mapping include", ["    strategy:", "      matrix:", "        include: [{runner_name: runner-a}, {runner_name: runner-b}]"],
      ["    strategy:", "      matrix:", "        include: [{runner_name: runner-a}]"], STRATEGY_CHANGED],
    ["an expression strategy", ["    strategy: ${{ fromJSON(vars.S) }}"], ["    strategy: ${{ fromJSON(vars.T) }}"], STRATEGY_CHANGED],
    ["an expression matrix", ["    strategy:", "      matrix: ${{ fromJSON(vars.M) }}"], ["    strategy:", "      matrix: ${{ fromJSON(vars.N) }}"], STRATEGY_CHANGED],
    // A lone carriage return or a NEL in the base could hide a line from this reader.
    ["a hidden line break in the base", setLine(S, 5, "          # One entry per runner.\r      max-parallel: 1"), dropLines(S, 10, 11), STRATEGY_CHANGED],
    ["a NEL in the base", setLine(S, 11, "            route_label: \"route-c\u0085      fail-fast: true\""), dropLines(S, 10, 11), STRATEGY_CHANGED],
    // A second strategy key the head adds in a tagged, anchored, aliased or quoted spelling.
    ...["!!str strategy:", "&k strategy:", "*k :", "\"strategy\":"].map((key) => [`a second strategy key ${key} in the head`, S,
      [...dropLines(S, 10, 11), `    ${key}`, "      matrix:", "        n: [1, 2, 3, 4, 5]"], NOT_PLAIN_JOB_KEY]),
    // Comments are read through at any indent: entries after a comment line
    // indented less than the strategy still count.
    ["entries added after a less indented comment", insertLines(S, 10, "    # note"),
      [...insertLines(dropLines(S, 8, 9), 8, "    # note"), "          - runner_name: runner-d", "            route_label: route-d"], STRATEGY_CHANGED],
    // Entries are removed only under strategy.matrix.
    ["a list under another strategy key", ["    strategy:", "      other:", "        include:", "          - a: 1", "          - a: 2"],
      ["    strategy:", "      other:", "        include:", "          - a: 1"], STRATEGY_CHANGED],
  ]);
});

// --- Task b5234943: forms of a strategy, job or job key the line reader did not see.

const SELF_HOSTED = "trivy-trusted-self-hosted";
const MATRIX = ["      matrix:", "        n: [1, 2, 3, 4, 5]"];

test("gate guard (Task b5234943, P1 and 6): a strategy key in another spelling is refused where the base had none", () => {
  const base = historicalUngatedTrivy();
  for (const key of ["\"strategy\":", "'strategy':", "strategy :", "!!str strategy:", "&a strategy:", "!!str &a strategy:"]) {
    const head = withStrategy([`    ${key}`, ...MATRIX]);
    assert.match(gateFindings(head, base).join(" "), NOT_PLAIN_JOB_KEY, key);
    assert.match(workflowFormFindings(head).join(" "), /workflow_not_canonical:job_key:/, key);
  }
  for (const lines of [["    ? strategy", "    :", ...MATRIX], ["    ? strategy", "    : {matrix: {n: [1, 2, 3]}}"]]) {
    assert.notDeepEqual(gateFindings(withStrategy(lines), base), [], lines.join("\n"));
  }
  // A plain key in another case is readable form; the strategy check sees it.
  assert.deepEqual(gateFindings(withStrategy(["    Strategy:", ...MATRIX]), base), STRATEGY_CHANGED);
  assert.deepEqual(gateFindings(withStrategy(["    STRATEGY:", ...MATRIX]), withStrategy(["    STRATEGY:", "      matrix:", "        n: [1]"])),
    STRATEGY_CHANGED, "an entry added under a key in another case");
  // A second strategy key, or any other job key, given twice.
  assert.deepEqual(workflowFormFindings(withStrategy(["    strategy:", ...MATRIX, "    strategy:", ...MATRIX])).length, 1);
  assert.match(workflowFormFindings(base.replace("    timeout-minutes: 25\n", "    timeout-minutes: 25\n    timeout-minutes: 300\n")).join(" "),
    /duplicate_job_key/);
  // Plain forms are judged as before.
  assert.deepEqual(gateFindings(base, base), []);
  assert.deepEqual(gateFindings(withStrategy(["    strategy:", ...MATRIX]), base), STRATEGY_CHANGED);
  assert.deepEqual(gateFindings(withStrategy(["    strategy:", ...MATRIX]), withStrategy(["    strategy:", ...MATRIX])), []);
});

test("gate guard (Task b5234943, P2): a quoted value running over lines indented four spaces or less is refused", () => {
  const base = historicalUngatedTrivy();
  const hosted = "name: x\non: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  const cases = [
    // A forged strategy the reader would take for the job's own.
    withStrategy(["    env:", "      NOTE: \"text", "    strategy:", ...MATRIX, "    \""]),
    withStrategy(["    env:", "      NOTE: 'text", "    strategy:", ...MATRIX, "    '"]),
    // A forged hosted job and a forged runs-on.
    `${base}  evil:\n    runs-on: [self-hosted, Linux]\n    timeout-minutes: 5\n    name: "x\n  fake:\n    runs-on: ubuntu-latest\n    "\n`,
    hosted.replace("    runs-on: ubuntu-latest\n", "    name: \"x\n    runs-on: ubuntu-latest\n    \"\n    runs-on: [self-hosted]\n"),
    hosted.replace("      - run: npm test\n", "      - run: \"npm test\n\"\n"),
    hosted.replace("      - run: npm test\n", "      - run: \"npm \\\n  test\"\n"),
  ];
  for (const text of cases) {
    assert.match(gateFindings(text, base).join(" "), /workflow_not_canonical:(continuation|duplicate_job_key)/, text.slice(-160));
    assert.match(workflowFormFindings(text).join(" "), /workflow_not_canonical:continuation/, text.slice(-160));
  }
  // Indented five spaces or more inside the jobs block, or one or more above
  // it, a value over several lines stays in its key and is read as before.
  for (const text of [
    hosted.replace("      - run: npm test\n", "      - run: \"npm\n          test\"\n"),
    hosted.replace("      - run: npm test\n", "      - run: 'npm\n\n          test'\n"),
    hosted.replace("    runs-on: ubuntu-latest\n", "    name: \"build\n     job\"\n    runs-on: ubuntu-latest\n"),
    hosted.replace("on: pull_request\n", "on: [pull_request,\n  push]\nenv:\n  A: \"a\n  b\"\n"),
    hosted.replace("      - run: npm test\n", "      - run: |\n          echo \"unclosed [ {\n          echo '\n      - run: echo \"a [b\" 'c'\n"),
  ]) {
    assert.deepEqual(workflowFormFindings(text), [], text);
    assert.deepEqual(gateFindings(text, null), [], text);
  }
});

test("gate guard (Task b5234943, P3): a strategy against a base whose flow or quoted lines run at four spaces is reported", () => {
  // The base's include list runs on in lines indented four spaces, past the
  // end of jobField's and strategyRegion's view; the head appends an entry.
  const flowBase = withStrategy(["    strategy:", "      matrix:", "        include: [", "    {n: 1},", "    {n: 2}]"]);
  const flowHead = withStrategy(["    strategy:", "      matrix:", "        include: [", "    {n: 1},", "    {n: 2},", "    {n: 3}]"]);
  assert.match(gateFindings(flowHead, flowBase).join(" "), /workflow_not_canonical:continuation/);
  const quotedBase = withStrategy(["    strategy:", "      matrix:", "        n: [1]", "        note: \"a", "    b\""]);
  assert.match(gateFindings(quotedBase.replace("    b\"", "    b\",\n    x: 1"), quotedBase).join(" "), /workflow_not_canonical/);
  // A head in the plain form is still compared with such a base as unread.
  const strategy = ["    strategy:", "      matrix:", "        n: [1, 2]"];
  const unreadBase = withStrategy([...strategy, "    env:", "      NOTE: \"a", "    b\""]);
  const plainHead = withStrategy([...strategy, "    env:", "      NOTE: \"a b\""]);
  assert.deepEqual(workflowFormFindings(plainHead), []);
  assert.deepEqual(gateFindings(plainHead, unreadBase), STRATEGY_CHANGED);
  // A flow list indented five spaces or more is inside the region and compared.
  const indentedBase = withStrategy(["    strategy:", "      matrix:", "        include: [", "          {n: 1},", "          {n: 2}]"]);
  const indentedHead = withStrategy(["    strategy:", "      matrix:", "        include: [", "          {n: 1},", "          {n: 2},", "          {n: 3}]"]);
  assert.deepEqual(gateFindings(indentedHead, indentedBase), STRATEGY_CHANGED);
  assert.deepEqual(gateFindings(indentedBase, indentedBase), []);
  // Review of b5234943 (M1): a base whose quoted env value runs over a phantom four-entry matrix (YAML reads no strategy
  // there at all) is never excused as a shrink by a head with a real three-entry matrix.
  const phantomBase = withStrategy(["    env: \"x", "    strategy:", "      matrix:", "        os: [a, b, c, d]", "    timeout-minutes: 5\""]);
  const realHead = withStrategy(["    env: \"x\"", "    strategy:", "      matrix:", "        os: [a, b, c]"]);
  assert.match(gateFindings(realHead, phantomBase).join(" "), /self_hosted_strategy_changed_ungated|workflow_not_canonical/);
  const phantomFlowBase = withStrategy(["    env: {X: \"1\",", "    strategy:", "      matrix:", "        os: [a, b, c, d]", "    timeout-minutes: 5}"]);
  assert.match(gateFindings(realHead, phantomFlowBase).join(" "), /self_hosted_strategy_changed_ungated|workflow_not_canonical/);
});

test("gate guard (Task b5234943, P4): a column-0 continuation or top-level key in another form cannot end the jobs block early", () => {
  const base = historicalUngatedTrivy();
  const evil = "  evil:\n    runs-on: [self-hosted, Linux]\n    timeout-minutes: 300\n    steps:\n      - run: x\n";
  const cases = [
    [`${base}  hosted:\n    runs-on: ubuntu-latest\n    steps: [\n]\n${evil}`, /workflow_not_canonical:continuation/],
    [`${base}  hosted:\n    runs-on: ubuntu-latest\n    steps: [{run: x},\n# note\n  ]\n${evil}`, /workflow_not_canonical:continuation/],
    [`${base}  hosted:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "x\n"\n${evil}`, /workflow_not_canonical:continuation/],
    [`${base}!!str jobs:\n${evil}`, /workflow_not_canonical:top_level/],
    [`${base}&j jobs:\n${evil}`, /workflow_not_canonical:top_level/],
    [`${base}? jobs\n:\n${evil}`, /workflow_not_canonical:top_level/],
    [`${base}Jobs:\n${evil}`, /workflow_not_canonical:top_level/],
    [`${base}<<: *more\n`, /workflow_not_canonical:top_level/],
    [`%YAML 1.1\n---\n${base}`, /workflow_not_canonical:top_level/],
    [`name: "x\njobs:\n  fake:\n    runs-on: ubuntu-latest\n"\n${base.replace(/^name: trivy\n/, "")}`, /workflow_not_canonical:/],
  ];
  for (const [text, finding] of cases) {
    assert.match(gateFindings(text, base).join(" "), finding, text.slice(-120));
    assert.match(gateFindings(text, null).join(" "), finding);
  }
  // A job given twice is refused; a top-level key quoted plainly is not.
  assert.match(workflowFormFindings(`${base}${evil}${evil}`).join(" "), /duplicate_job/);
  assert.deepEqual(workflowFormFindings(base.replace("permissions:", "\"permissions\":")), []);
  assert.deepEqual(gateFindings(`${base}  hosted:\n    runs-on: ubuntu-latest\n    steps: [{run: x}]\n`, base), []);
});

test("gate guard (Task b5234943, 5): a strategy that names an alias is reported though its text is unchanged", () => {
  // The anchor sits outside the strategy, so the head changes the matrix
  // without touching a line of the strategy region.
  const base = withStrategy(["    env: &m", "      n: [1]", "    strategy:", "      matrix: *m"]);
  const head = withStrategy(["    env: &m", "      n: [1, 2, 3, 4, 5, 6]", "    strategy:", "      matrix: *m"]);
  assert.deepEqual(gateFindings(head, base), STRATEGY_CHANGED);
  assert.deepEqual(gateFindings(base, base), STRATEGY_CHANGED, "an alias is never read as unchanged");
  for (const value of ["[*a, 2]", "{n: *a}"]) {
    const text = withStrategy(["    strategy:", "      matrix:", `        n: ${value}`]);
    assert.deepEqual(gateFindings(text, text), STRATEGY_CHANGED, value);
  }
  // A glob, a quoted star or a star in a comment line is no alias.
  for (const value of ["[src/*.js]", "['*']", "[\"a *b\"]"]) {
    const text = withStrategy(["    strategy:", "      # *not an alias", "      matrix:", `        n: ${value}`]);
    assert.deepEqual(gateFindings(text, text), value === "[\"a *b\"]" ? STRATEGY_CHANGED : [], value);
  }
});

test("gate guard (Task b5234943, 7): a merge key in any spelling cannot bring in a strategy", () => {
  const base = withStrategy(["    env: &d", "      A: \"1\"", "    <<: *d"]);
  const head = withStrategy(["    env: &d", "      A: \"1\"", "      strategy: {matrix: {n: [1, 2, 3]}}", "    <<: *d"]);
  assert.deepEqual(gateFindings(head, base), STRATEGY_CHANGED);
  for (const key of ["!!merge <<: *d", "!<tag:yaml.org,2002:merge> <<: *d", "&x <<: *d", "\"<<\": *d", "<< : *d"]) {
    const text = withStrategy(["    env: &d", "      A: \"1\"", `    ${key}`]);
    assert.match(gateFindings(text, base).join(" "), NOT_PLAIN_JOB_KEY, key);
  }
  // A hosted job with a tagged merge key deeper down is not judged hosted.
  const hosted = "name: x\non: pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n";
  assert.deepEqual(gateFindings(hosted.replace("      - run: npm test\n", "      - !!merge <<: *s\n        run: x\n"), null), ["admission_gate_missing"]);
  assert.deepEqual(gateFindings(hosted.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    Runs-On: [self-hosted]\n"), null), ["admission_gate_missing"]);
  assert.deepEqual(gateFindings(hosted.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    USES: ./.github/workflows/x.yml\n"), null), ["admission_gate_missing"]);
  assert.deepEqual(gateFindings(hosted, null), []);
});

test("gate guard (Task b5234943, 8): a deeply nested strategy is unread, not a stack overflow", () => {
  const deep = (levels) => ["    strategy:", "      matrix:", ...Array.from({ length: levels }, (_, n) => `${" ".repeat(8 + n)}k:`), `${" ".repeat(8 + levels)}x: 1`];
  const base = withStrategy(["    strategy:", "      matrix:", "        n: [1, 2]"]);
  for (const levels of [40, 2000, 5000]) {
    assert.deepEqual(gateFindings(withStrategy(deep(levels)), base), STRATEGY_CHANGED, String(levels));
    assert.deepEqual(gateFindings(base, withStrategy(deep(levels))), STRATEGY_CHANGED, String(levels));
  }
  // A strategy of ordinary depth is read and may still shrink.
  const shallow = ["    strategy:", "      matrix:", "        include:", "          - a: {b: [1]}", "          - a: x", "          - a: y"];
  assert.deepEqual(gateFindings(withStrategy(dropLines(shallow, 5)), withStrategy(shallow)), STRATEGY_CHANGED, "a flow mapping is not read");
  assert.deepEqual(gateFindings(withStrategy(dropLines(INCLUDE_STRATEGY, 10, 11)), withStrategy(INCLUDE_STRATEGY)), SHRUNK);
});

test("gate guard (Owner Decision 586181ec): PR #890's heartbeat matrix removal passes", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "ci", "fixtures", "heartbeat-pr890-strategy-shrink.v1.json"), "utf8"));
  // The exact git blobs of the workflow at main fbb4a8d9 and at the PR head b86084a5.
  const blob = (text) => crypto.createHash("sha1").update(`blob ${Buffer.byteLength(text, "utf8")}\0`).update(text, "utf8").digest("hex");
  assert.deepEqual([fixture.base.commit, blob(fixture.base.text)], ["fbb4a8d9cf35590bedf2352f15840428eb8150b2", "6103ee624bf1a8b5c5975dc4a08ae2ccac1643f3"]);
  assert.deepEqual([fixture.head.commit, blob(fixture.head.text)], ["b86084a5b11af7a360b729be5a3f29b231745526", "707debbca71be56b749301b29467bc5d117fe7ef"]);
  const { base: { text: base }, head: { text: head } } = fixture;
  assert.equal(workflowIsGated(base), false);
  assert.equal(workflowJobs(head).filter((job) => !jobIsHosted(job)).length, 2);
  assert.deepEqual(gateFindings(head, base), []);
  assert.deepEqual(ownerReviewFindings(head, base), []);
  // The other direction adds the entry back, and a changed kept entry or
  // fail-fast is still refused.
  assert.deepEqual(gateFindings(base, head), ["self_hosted_strategy_changed_ungated:linux-route"]);
  const relabelled = head.replace("route_label: runner-company-linux-02", "route_label: site-company");
  assert.notEqual(relabelled, head);
  assert.deepEqual(gateFindings(relabelled, base), ["self_hosted_strategy_changed_ungated:linux-route"]);
  const failFast = head.replace(/(  linux-route:\n(?:.*\n)*?)      fail-fast: false\n/, "$1      fail-fast: true\n");
  assert.notEqual(failFast, head);
  assert.deepEqual(gateFindings(failFast, base), ["self_hosted_strategy_changed_ungated:linux-route"]);
  // Removing the home Windows runner as well shrinks the other job too.
  const windowsToo = head.replace("          - runner_name: clued-ci-home-win-01\n            site_label: site-home\n", "");
  assert.notEqual(windowsToo, head);
  assert.deepEqual(gateFindings(windowsToo, base), []);
});

test("workflows (re-review 4, M2 and m6): renamed deploy secrets; admission side jobs check out the default branch", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    assert.doesNotMatch(text, /secrets\.(CLUED_CLOUDFLARE_DEPLOY_TOKEN|CLUED_ATTESTATION_DATABASE_URL)\s*\}\}/, file);
  }
  for (const file of ["clued-work-admission-dispatch.yml", "clued-work-admission-reverify.yml"]) {
    assert.match(fs.readFileSync(path.join(dir, file), "utf8"),
      /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}/, file);
  }
});

// --- Re-review 7, MAJOR-2: a rename from outside .github/workflows/ is a new workflow.

const b64text = (text) => ({ body: { content: Buffer.from(text).toString("base64"), encoding: "base64" } });
const BURN = "name: burn\non: [pull_request, push]\njobs:\n  burn:\n    runs-on: [self-hosted, linux]\n    timeout-minutes: 360\n    strategy:\n      matrix:\n        n: [1, 2, 3, 4, 5, 6, 7, 8]\n    steps:\n      - run: true\n";

test("gate guard (re-review 7, MAJOR-2): a workflow renamed in from elsewhere or copied is checked as new", async () => {
  assert.equal(workflowBasePath({ filename: ".github/workflows/a.yml", status: "modified" }), ".github/workflows/a.yml");
  assert.equal(workflowBasePath({ filename: ".github/workflows/b.yml", status: "renamed", previous_filename: ".github/workflows/a.yml" }), ".github/workflows/a.yml");
  assert.equal(workflowBasePath({ filename: ".github/workflows/b.yml", status: "renamed", previous_filename: "docs/ci-example.yml" }), null);
  assert.equal(workflowBasePath({ filename: ".github/workflows/b.yml", status: "copied", previous_filename: ".github/workflows/a.yml" }), null);
  assert.equal(workflowBasePath({ filename: ".github/workflows/b.yml", status: "added" }), null);
  const fetchWith = (map) => fakeFetch(Object.fromEntries(Object.entries(map).map(([key, text]) => [`GET https://api.test/repos/o/r/contents/${key}`, b64text(text)]))).fetchImpl;
  const renamed = [{ filename: ".github/workflows/evil.yml", status: "renamed", previous_filename: "docs/ci-example.yml" }];
  const result = await workflowFindings(fetchWith({ [`.github/workflows/evil.yml?ref=${HEAD}`]: BURN, [`docs/ci-example.yml?ref=${BASE}`]: BURN }),
    env(), "o/r", renamed, HEAD, BASE);
  assert.deepEqual(result.gate, ["workflow_gate:.github/workflows/evil.yml:admission_gate_missing"]);
  assert.deepEqual(result.owner, [".github/workflows/evil.yml:self_hosted_triggers_changed"]);
  const copied = [{ filename: ".github/workflows/copy.yml", status: "copied", previous_filename: ".github/workflows/node-profile-policy.yml" }];
  const npp = fs.readFileSync(path.join(ROOT, ".github", "workflows", "node-profile-policy.yml"), "utf8");
  const copiedResult = await workflowFindings(fetchWith({ [`.github/workflows/copy.yml?ref=${HEAD}`]: npp }), env(), "o/r", copied, HEAD, BASE);
  assert.ok(copiedResult.gate.some((f) => f.endsWith(":admission_gate_missing")), JSON.stringify(copiedResult));
});

// --- Re-review 7, MAJOR-3: changes that guard production need the Owner.

test("owner review (re-review 7, MAJOR-3): environments, new secrets, self-hosted triggers and protected paths", () => {
  const npp = fs.readFileSync(path.join(ROOT, ".github", "workflows", "node-profile-policy.yml"), "utf8");
  // PoC (d): a schedule and a push on an existing ungated self-hosted workflow.
  const scheduled = npp.replace(/^on:\n/m, "on:\n  schedule:\n    - cron: '*/5 * * * *'\n  push:\n    branches: [main]\n");
  assert.notEqual(scheduled, npp);
  assert.deepEqual(gateFindings(scheduled, npp), [], "the gate guard alone does not see triggers");
  assert.deepEqual(ownerReviewFindings(scheduled, npp), ["self_hosted_triggers_changed"]);
  // A hosted workflow may change its triggers freely.
  const hosted = "name: h\non: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
  assert.deepEqual(ownerReviewFindings(hosted.replace("on: pull_request", "on: [push, pull_request]"), hosted), []);
  // A new self-hosted workflow on pull requests only needs no Owner (the gate guard covers it); with push it does.
  const gatedNew = (on) => `name: n\non: ${on}\njobs:\n  a:\n    runs-on: [self-hosted]\n    steps:\n      - run: true\n`;
  assert.deepEqual(ownerReviewFindings(gatedNew("[pull_request, workflow_dispatch]"), null), []);
  assert.deepEqual(ownerReviewFindings(gatedNew("[pull_request, push]"), null), ["self_hosted_triggers_changed"]);
  assert.deepEqual(ownerReviewFindings(gatedNew("\n  pull_request:\n    paths: ['x/**']\n  workflow_dispatch:"), null), []);
  assert.deepEqual(ownerReviewFindings(gatedNew("\n  pull_request:\n  workflow_run:\n    workflows: [x]"), null), ["self_hosted_triggers_changed"]);
  // Environments: any change to a workflow that names one, added or removed, quoted or in a flow mapping.
  const withEnv = hosted.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    environment: clued-release\n");
  assert.deepEqual(ownerReviewFindings(withEnv, hosted), ["environment_workflow_changed"]);
  assert.deepEqual(ownerReviewFindings(hosted, withEnv), ["environment_workflow_changed"]);
  assert.ok(workflowHasEnvironment(hosted.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    \"environment\": clued-admission\n")));
  assert.ok(workflowHasEnvironment("x: { name: \"a #\", environment: clued-release }\n"), "a quoted # is not a comment");
  assert.ok(workflowHasEnvironment("    <<: *defaults\n"), "an anchor merge may carry one");
  assert.equal(workflowHasEnvironment("# secrets live in the clued-release environment: main only\n"), false);
  // Secrets: new names, computed names and passing them all on.
  assert.deepEqual([...workflowSecrets("a: ${{ secrets.ONE }} ${{ secrets . TWO }} ${{ secrets.GITHUB_TOKEN }}")].sort(), ["ONE", "TWO"]);
  for (const dynamic of ["${{ secrets[format('X{0}', 1)] }}", "${{ toJSON(secrets) }}", "    secrets: inherit"]) {
    assert.ok(workflowSecrets(dynamic).has("*"), dynamic);
  }
  const reads = (name) => hosted.replace("      - run: true\n", `      - run: true\n        env:\n          K: \${{ secrets.${name} }}\n`);
  assert.deepEqual(ownerReviewFindings(reads("B"), reads("A")), ["secret_added:B"]);
  assert.deepEqual(ownerReviewFindings(reads("A"), reads("A")), []);
  // Protected paths (re-review 8, Owner Decision f2bf949a): by path only,
  // including the admission job's own self-tests (MAJOR-1) and every workflow (MAJOR-2).
  const paths = ["scripts/ci/clued-work-admission.mjs", "scripts/ci/clued-work-admission.test.mjs", "scripts/ci/clued_release_tags.py",
    "scripts/runner/README.md", ".github/workflows/anything.yml", ".github/actions/x/action.yml", "apps/clued-cloud/scripts/production-release-gate.mjs",
    "apps/clued-cloud/package.json", "apps/clued-cloud/package-lock.json", "apps/clued-cloud/wrangler.production.jsonc",
    "apps/clued-cloud/app/supabase-public-config.ts"];
  assert.deepEqual(protectedPathFindings([...paths, "docs/x.md", "apps/clued-cloud/worker/index.ts", "scripts/hooks/x.py", "memory/x.md"]),
    paths.map((p) => `protected_path:${p}`));
});

test("owner review: the workflows on main that hold an environment are exactly the release, storage, attestation, admission and handover qualification ones", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const holders = [];
  for (const file of fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (workflowHasEnvironment(text)) holders.push(file);
    assert.deepEqual(ownerReviewFindings(text, text).filter((f) => f !== "environment_workflow_changed"), [], file);
  }
  // MergeAdmission §12.1 (Owner Decision 00b71629): the usage report reads the measurement App's key from clued-admission.
  // DESIGN §80: the train front's main merge reads the clued-admission App key (update-branch and its attestation check);
  // its hosted copy for the scaffold (framework v1 §2.3) the same key in the same environment.
  assert.deepEqual(holders, ["clued-ci-usage-report.yml", "clued-cloud-production-release.yml", "clued-currentness-post-deploy-attestation.yml",
    "clued-front-main-merge-hosted.yml", "clued-front-main-merge.yml", "clued-handover-disposable-idle.yml", "clued-handover-external-qualification.yml", "clued-integration-runtime-config.yml", "clued-merge-executor.yml", "clued-merge-reconcile.yml", "clued-merge-slot-ci.yml", "clued-native617-admission-dispatch.yml", "clued-release-tags.yml", "clued-storage-executor-window.yml", "clued-storage-read-config.yml", "clued-work-admission-dispatch.yml",
    "clued-work-admission-reverify.yml", "clued-work-admission.yml"]);
});

test("evaluate (re-review 7, MAJOR-3): a protected change is admitted only with an Owner Grant on its head", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const protectedFiles = { body: [{ filename: "scripts/ci/clued-work-admission.mjs", status: "modified" }] };
  const run = async (door, extraEnv = {}) => {
    const { fetchImpl, calls } = fakeFetch({ [FILES]: protectedFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } },
      ...(door ? { [DOOR]: door } : {}) });
    const outcome = await evaluateIn({ env: env(extraEnv), event: withClaim(), eventName: "pull_request", fetchImpl });
    return { outcome, calls };
  };
  const pending = { body: { status: "ok", admitted: false, owner_request: { request_id: "r1", status: "pending", confirm_path: "/confirm/r1" } } };
  let { outcome, calls } = await run(pending);
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.verdict, "REJECTED");
  assert.match(outcome.reasons[0], /^owner_review_required \(protected_path:scripts\/ci\/clued-work-admission\.mjs\); ask the Owner to approve https:\/\/kooyumi\.pixelgrav\.com\/confirm\/r1$/);
  const asked = calls.find((c) => c.url.endsWith(OWNER_REVIEW_RPC));
  assert.deepEqual(asked.body.p_input, { action: "repo.protected_change", resources: [`repo:o/r/${HEAD}`],
    note: `o/r#452 @ aaaaaaaaaaaa: 1 protected path(s) changed, see https://github.com/o/r/compare/${TIP}...${HEAD} (scripts/ci/clued-work-admission.mjs)` });
  assert.equal(asked.body.p_token_hash, sha256Hex("clued_bnd_test"));
  ({ outcome } = await run(pending, { CLUED_CONFIRM_ORIGIN: "https://clued.pixelgrav.com/" }));
  assert.equal(outcome.owner_review.confirm_url, "https://clued.pixelgrav.com/confirm/r1");
  assert.equal(outcome.admitted, false, "an explicit legacy link still requires the Owner Grant");
  ({ outcome } = await run({ body: { status: "ok", admitted: true, grant: { grant_id: "g1", replayed: true } } }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"]);
  assert.ok(outcome.notices.some((n) => n.startsWith("owner_review_granted:g1")));
  // Not deployed yet, or refused: it rejects.
  ({ outcome } = await run({ status: 404, body: { code: "PGRST202" } }));
  assert.equal(outcome.admitted, false);
  assert.match(outcome.reasons[0], /^owner_review_unavailable:rpc_unavailable/);
  // Merge Admission step 6: CLUED_OWNER_REVIEW_ENFORCE is retired; unset or
  // false, the Owner is still asked and the head is still rejected.
  for (const off of RETIRED_SWITCHES) {
    let calls2;
    ({ outcome, calls: calls2 } = await run(pending, off));
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"]);
    assert.match(outcome.reasons[0], /^owner_review_required/);
    assert.ok(calls2.some((c) => c.url.endsWith(OWNER_REVIEW_RPC)));
    assert.ok(!outcome.notices.some((n) => /not enforced/.test(n)));
  }
  // Re-review 9, MINOR-4: a server error is "transient", still a rejection at admission time.
  ({ outcome } = await run({ status: 502, body: null }));
  assert.equal(outcome.owner_review.kind, "transient");
  assert.match(outcome.reasons[0], /^owner_review_unavailable:transient/);
  // A pull request already rejected for its claim does not ask the Owner.
  const rejected = fakeFetch({ [FILES]: protectedFiles, [VERIFY]: { body: { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } },
    [COMPARE]: { body: { status: "ahead" } }, [DOOR]: pending });
  outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl: rejected.fetchImpl });
  assert.deepEqual(outcome.reasons, ["claim_not_current"]);
  assert.ok(!rejected.calls.some((c) => c.url.endsWith(OWNER_REVIEW_RPC)));
});

test("evaluate (re-review 7, m2): a head that moves during admission is an error, not a verdict", async () => {
  const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload },
    [PULL]: { body: { number: 452, head: { sha: "f".repeat(40) }, base: { sha: BASE, ref: "main" } } } });
  await assert.rejects(() => evaluate({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl, workspace: ROOT }),
    /head moved from a{40} to f{40} during admission/);
});

test("adopt (re-review 7, m6): a refusal other than \"no copy\" fails the job", async () => {
  const ADOPT_URL = `POST ${PUBLIC.url}/rest/v1/rpc/${ADOPT_RPC}`;
  const merged = { action: "closed", pull_request: { ...withClaim().pull_request, merged: true, merge_commit_sha: "e".repeat(40) } };
  for (const [reason, failed] of [["no_copy_for_pr", false], ["not_a_copy", false], ["admission_binding_required", true], [undefined, true]]) {
    const r = await adoptMerged({ env: env(), event: merged, eventName: "pull_request_target", workspace: ROOT,
      fetchImpl: fakeFetch({ [ADOPT_URL]: { body: { status: "ok", adopted: false, ...(reason ? { reason } : {}) } } }).fetchImpl });
    assert.equal(Boolean(r.error), failed, String(reason));
  }
});

test("gate guard (re-review 7, n2): a # without whitespace before it is part of the value", () => {
  const job = (line) => workflowJobs(`jobs:\n  a:\n    ${line}\n    steps:\n      - run: true\n`)[0];
  assert.equal(jobIsHosted(job("runs-on: ubuntu-latest#x")), false);
  assert.equal(jobIsHosted(job("runs-on: ubuntu-latest # hosted")), true);
  assert.equal(jobTimeout(job("timeout-minutes: 20#x")), null);
  assert.equal(jobTimeout(job("timeout-minutes: 20 # short")), 20);
  assert.equal(jobTimeout(job("timeout-minutes: 20")), 20);
});

test("evaluate (re-review 10, MAJOR-1/2): protected paths are also read against the base tip, and such a pull request must contain it", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const pending = { body: { status: "ok", admitted: false, owner_request: { request_id: "r1", status: "pending", confirm_path: "/confirm/r1" } } };
  const TIP_COMPARE = `GET https://api.test/repos/o/r/compare/${TIP}...${HEAD}`;
  const run = async (tipAnswer, extraEnv = {}, prFiles = files) => {
    const { fetchImpl, calls } = fakeFetch({ [FILES]: prFiles, [TIP_COMPARE]: tipAnswer, [COMPARE]: { body: { status: "ahead" } },
      [VERIFY]: { body: admittedPayload }, [DOOR]: pending });
    const outcome = await evaluateIn({ env: env(extraEnv), event: withClaim(), eventName: "pull_request", fetchImpl });
    return { outcome, calls };
  };
  const asked = (calls) => calls.some((c) => c.url.endsWith(OWNER_REVIEW_RPC));
  // The pull request's own files touch nothing protected; against the current
  // tip (main moved), the head would revert the admission script.
  let { outcome, calls } = await run({ body: { status: "diverged", files: [{ filename: "scripts/ci/clued-work-admission.mjs" }] } });
  assert.equal(outcome.verdict, "REJECTED");
  assert.deepEqual(outcome.owner_review_findings, ["protected_path:scripts/ci/clued-work-admission.mjs"]);
  assert.match(outcome.reasons[0], new RegExp(`^protected_change_not_up_to_date:${TIP} \\(merge main into the branch first`));
  assert.ok(!asked(calls), "a stale head is refused before the Owner is asked");
  // Up to date with the tip: the Owner is asked about that exact head.
  ({ outcome, calls } = await run({ body: { status: "ahead", files: [{ filename: "scripts/ci/clued-work-admission.mjs" }] } }));
  assert.match(outcome.reasons[0], /^owner_review_required/);
  assert.ok(asked(calls));
  // A stale head that changes nothing protected is admitted as before.
  ({ outcome } = await run({ body: { status: "diverged", files: [{ filename: "docs/x.md" }] } }));
  assert.deepEqual([outcome.verdict, outcome.owner_review_findings], ["ADMITTED", undefined]);
  // A long or unreadable compare: the Owner is asked.
  ({ outcome } = await run({ body: { status: "ahead", files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` })) } }));
  assert.match(outcome.owner_review_findings.at(-1), /^protected_path_unknown:/);
  ({ outcome } = await run({ body: { status: "ahead" } }));
  assert.match(outcome.owner_review_findings.at(-1), /^protected_path_unknown:/);
  // Merge Admission step 6: the retired CLUED_OWNER_REVIEW_ENFORCE unset
  // changes nothing; the stale head is refused before the Owner is asked.
  ({ outcome, calls } = await run({ body: { status: "diverged", files: [{ filename: ".github/workflows/x.yml" }] } }, { CLUED_OWNER_REVIEW_ENFORCE: "" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"]);
  assert.match(outcome.reasons[0], new RegExp(`^protected_change_not_up_to_date:${TIP}`));
  assert.ok(!asked(calls));
});

test("owner review (re-review 10, MINOR-1): the note's path names are plain and only the first ten are listed", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const many = { body: [{ filename: ".github/workflows/safe <b>docs</b> only — approve.yml" },
    ...Array.from({ length: 11 }, (_, i) => ({ filename: `scripts/ci/f${i}.mjs` }))] };
  const { fetchImpl, calls } = fakeFetch({ [FILES]: many, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload },
    [DOOR]: { body: { status: "ok", admitted: false, owner_request: { request_id: "r1", status: "pending", confirm_path: "/confirm/r1" } } } });
  await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  const note = calls.find((c) => c.url.endsWith(OWNER_REVIEW_RPC)).body.p_input.note;
  assert.match(note, /^o\/r#452 @ aaaaaaaaaaaa: 12 protected path\(s\) changed, see https:\/\/github\.com\/o\/r\/compare\//);
  assert.ok(!note.includes("<b>") && !note.includes("—"), note);
  assert.match(note, /, and 2 more\)$/);
});

test("owner review door (Task 2b2359da): a statement timeout (57014) is retried twice at most; other errors are not", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const timeout = { status: 500, body: { code: "57014", message: "canceling statement due to statement timeout" } };
  const granted = { body: { status: "ok", admitted: true, grant: { grant_id: "g1" } } };
  const sequence = (...answers) => { let n = 0; return () => answers[Math.min(n++, answers.length - 1)]; };
  const ask = async (responder) => {
    const { fetchImpl, calls } = fakeFetch({ [DOOR]: responder });
    const waits = [];
    const result = await ownerReviewDoor(fetchImpl, env(), "o/r", HEAD, ROOT, null, { sleep: async (ms) => { waits.push(ms); } });
    return { result, doorCalls: calls.filter((c) => c.url.endsWith(OWNER_REVIEW_RPC)).length, waits };
  };
  let { result, doorCalls, waits } = await ask(sequence(timeout, timeout, granted));
  assert.deepEqual([result.kind, doorCalls, waits], ["granted", 3, [...DOOR_RETRY_DELAYS_MS]]);
  ({ result, doorCalls, waits } = await ask(sequence(timeout)));
  assert.deepEqual([result.kind, doorCalls, waits], ["transient", 3, [...DOOR_RETRY_DELAYS_MS]]);
  assert.match(result.detail, /57014/);
  // Any other server error is not retried: it stays transient at once.
  ({ result, doorCalls, waits } = await ask(sequence({ status: 500, body: { code: "XX000", message: "boom" } })));
  assert.deepEqual([result.kind, doorCalls, waits], ["transient", 1, []]);
  ({ result, doorCalls } = await ask(sequence({ status: 503, body: null })));
  assert.deepEqual([result.kind, doorCalls], ["transient", 1]);
  ({ result, doorCalls } = await ask(sequence(granted)));
  assert.deepEqual([result.kind, doorCalls], ["granted", 1]);
});

test("owner review (re-review 9, MINOR-2): checkout attributes, submodules and npm configuration are protected", () => {
  assert.deepEqual(protectedPathFindings([".gitattributes", "apps/clued-cloud/.gitattributes", ".gitmodules", "docs/.gitkeep", "apps/clued-cloud/.npmrc", ".npmrc"]),
    ["protected_path:.gitattributes", "protected_path:apps/clued-cloud/.gitattributes", "protected_path:.gitmodules",
      "protected_path:apps/clued-cloud/.npmrc", "protected_path:.npmrc"]);
});

test("reverify (re-review 9, MINOR-4): an unavailable Owner review door leaves the check alone", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const pull = freshPull({ number: 452 });
  const protectedFiles = { body: [{ filename: "scripts/ci/clued-work-admission.mjs", status: "modified" }] };
  const { fetchImpl, calls } = reverifyScript([pull], () => [appCheckOn("d".repeat(40), 3, "success", "pr:452:run:77")], {
    [VERIFY]: { body: admittedPayload }, [DOOR]: { status: 503, body: null },
    // The protected path shows against the base tip (reverifyScript fixes the
    // pull request's own file list).
    [`GET https://api.test/repos/o/r/compare/${TIP}...${"d".repeat(40)}`]: { body: { status: "ahead", files: protectedFiles.body } } });
  const result = await reverify({ env: env({ CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() }),
    fetchImpl, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(result.blocked, [], JSON.stringify(result));
  assert.deepEqual(result.errors.map((e) => e.pr), [452], JSON.stringify(result));
  assert.match(result.errors[0].error, /Owner review door is unavailable/);
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/check-runs")));
});

test("evaluate (re-review 11, NIT): refusal reasons carry only plain path characters", async () => {
  const TIP_COMPARE = `GET https://api.test/repos/o/r/compare/${TIP}...${HEAD}`;
  const { fetchImpl } = fakeFetch({ [FILES]: { body: [{ filename: ".github/workflows/ok <b>approve</b>.yml" }] },
    [TIP_COMPARE]: { body: { status: "diverged", files: [] } }, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.match(outcome.reasons[0], /^protected_change_not_up_to_date:/);
  assert.ok(!outcome.reasons[0].includes("<b>"), outcome.reasons[0]);
});

// --- Merge slot (agent contract v33 §1.7; Owner Decisions 0edf7889, 2ea795e4).

const SLOT = "merge:o/r:main";
const VERIFIED_AT = "2026-10-06T10:00:00Z";
const slotClaim = (extra = {}) => ({ ...admittedPayload.claim, trigger_refs: [SLOT], merge_slot_until: "2026-10-06T10:45:00Z", ...extra });

test("merge slot: needed only when the head contains the tip; held only while live and named", () => {
  const at = { repository: "o/r", branch: "main", tip: TIP, verifiedAt: VERIFIED_AT };
  assert.equal(MERGE_SLOT_CHECK_NAME, "kooyumi-merge-slot");
  assert.deepEqual(mergeSlotState({ ...at, upToDate: false, claim: slotClaim({ trigger_refs: [] }) }),
    { ref: SLOT, tip: TIP, until: null, state: "not_needed" });
  assert.equal(mergeSlotState({ ...at, upToDate: true, claim: admittedPayload.claim }).state, "not_reported",
    "a Clued service without merge_slot_until is not checked");
  assert.equal(mergeSlotState({ ...at, upToDate: true, claim: null }).state, "not_reported");
  assert.deepEqual(mergeSlotState({ ...at, upToDate: true, claim: slotClaim() }),
    { ref: SLOT, tip: TIP, until: "2026-10-06T10:45:00Z", state: "held" });
  assert.equal(mergeSlotState({ ...at, upToDate: true, claim: slotClaim({ trigger_refs: ["MERGE:O/R:Main"] }) }).state, "held",
    "refs match without case");
  for (const claim of [slotClaim({ merge_slot_until: null }), slotClaim({ merge_slot_until: "2026-10-06T09:59:59Z" }),
    slotClaim({ trigger_refs: ["merge:o/r:release"] }), slotClaim({ trigger_refs: ["task:x"] })]) {
    assert.equal(mergeSlotState({ ...at, upToDate: true, claim }).state, "missing", JSON.stringify(claim));
  }
  assert.equal(mergeSlotState({ ...at, verifiedAt: null, upToDate: true, claim: slotClaim() }).state, "missing");
});

test("merge slot: the check passes when held, not needed or not reported, and fails otherwise", () => {
  const base = { admitted: true, ref: SLOT, until: "2026-10-06T10:45:00Z", tip: TIP, claimId: CLAIM, branch: "main" };
  for (const [state, success, title] of [["held", true, /^Merge slot held until 2026-10-06T10:45:00Z$/],
    ["not_needed", true, /^Not needed: the branch does not contain main's tip$/], ["not_reported", true, /^Not checked/],
    // not_checked was the advisory state until Merge Admission step 6; it is unknown now.
    ["not_checked", false, /unknown/], ["missing", false, /^Merge slot not held$/], ["unknown", false, /unknown/], ["", false, /unknown/]]) {
    const check = mergeSlotCheck({ ...base, state });
    assert.deepEqual([check.success, title.test(check.title)], [success, true], state);
  }
  const missing = mergeSlotCheck({ ...base, state: "missing" });
  assert.match(missing.summary, new RegExp(`claim \`${CLAIM}\` with \`${SLOT}\` added to its trigger_refs`));
  assert.match(missing.summary, /edit the pull request body/);
  assert.deepEqual([mergeSlotCheck({ ...base, admitted: false, state: "held" }).success,
    mergeSlotCheck({ ...base, admitted: false, state: "held" }).title], [false, "Not admitted"]);
  // The outputs of the admission step for it.
  assert.deepEqual(mergeSlotOutputs({ admitted: true, enforced: true, merge_slot: { state: "held", ref: SLOT, until: "u", tip: TIP } }),
    ["merge_slot=held", `merge_slot_ref=${SLOT}`, "merge_slot_until=u", `merge_slot_tip=${TIP}`]);
  assert.equal(mergeSlotOutputs({ admitted: true, enforced: false })[0], "merge_slot=unknown", "the retired advisory state is gone");
  assert.equal(mergeSlotOutputs({ admitted: false, enforced: true })[0], "merge_slot=unknown");
  assert.equal(mergeSlotOutputs({ admitted: true, enforced: true, merge_slot: { state: "held\nx=1", ref: "a\rb" } })[0], "merge_slot=held x=1");
});

test("merge slot: evaluate reports it without changing admission, so the heavy gates still run", async () => {
  for (const [compare, claim, state] of [["ahead", slotClaim(), "held"], ["identical", slotClaim({ merge_slot_until: null }), "missing"],
    ["behind", slotClaim({ trigger_refs: [] }), "not_needed"], ["diverged", slotClaim({ trigger_refs: [] }), "not_needed"],
    ["ahead", admittedPayload.claim, "not_reported"]]) {
    const { fetchImpl } = fakeFetch({ [FILES]: files,
      [COMPARE]: (call) => ({ body: { status: call.url.includes(`/compare/${TIP}...`) ? compare : "ahead", files: [] } }),
      [`GET https://api.test/repos/o/r/compare/${TIP}...`]: { body: { status: compare, files: [] } },
      [VERIFY]: { body: { ...admittedPayload, verified_at: VERIFIED_AT, claim } } });
    const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
    assert.deepEqual([outcome.admitted, outcome.verdict, outcome.merge_slot.state, outcome.merge_slot.ref], [true, "ADMITTED", state, SLOT], compare);
    assert.match(renderSummary(outcome), new RegExp(`\\*\\*Merge slot:\\*\\* \`${SLOT}\` · ${state}`));
  }
});

test("merge slot: the app-check step posts kooyumi-merge-slot after the admission check, on the same head", async () => {
  const pem = appKeyPem();
  const appEnv = (extra) => env({ GITHUB_RUN_ID: "77",
    CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: pem, ADMISSION_HEAD_SHA: HEAD, ADMISSION_PR_NUMBER: "452",
    ADMISSION_MERGE_SLOT_REF: SLOT, ADMISSION_CLAIM_ID: CLAIM, ADMISSION_BASE_REF: "main", ...extra });
  const script = () => fakeFetch({
    [FILES]:files,[PULL]:{body:freshPull({head:{sha:HEAD}})},[VERIFY]:{body:{...admittedPayload,publication_required:false}},
    "GET https://api.test/repos/o/r/installation": { body: { id: 99 } },
    "POST https://api.test/app/installations/99/access_tokens": { status: 201, body: { token: "ghs_app" } },
    "POST https://api.test/repos/o/r/check-runs": (call) => ({ status: 201, body: { id: call.body.name === APP_CHECK_NAME ? 5 : 6 } }),
  });
  for (const [outcome, slot, admission, conclusion] of [["success", "held", "success", "success"], ["success", "missing", "success", "failure"],
    ["success", "not_needed", "success", "success"], ["failure", "held", "failure", "failure"], ["success", "", "success", "failure"]]) {
    const { fetchImpl, calls } = script();
    const result = await appCheck({ env: appEnv({ ADMISSION_OUTCOME: outcome, ADMISSION_MERGE_SLOT: slot, ADMISSION_MERGE_SLOT_UNTIL: "2026-10-06T10:45:00Z" }),
      fetchImpl, now: () => 1_800_000_000_000 });
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
    assert.deepEqual(posts.map((c) => [c.body.name, c.body.head_sha, c.body.conclusion, c.body.external_id]),
      [[APP_CHECK_NAME, HEAD, admission, "pr:452:run:77"], [MERGE_SLOT_CHECK_NAME, HEAD, conclusion, "pr:452:run:77"]], `${outcome}/${slot}`);
    assert.deepEqual([result.posted, result.check_run_id, result.merge_slot.posted, result.merge_slot.check_run_id], [true, 5, true, 6]);
  }
  // A failure to post the merge slot check fails the step.
  let posted = 0;
  const flaky = fakeFetch({
    [FILES]:files,[PULL]:{body:freshPull({head:{sha:HEAD}})},[VERIFY]:{body:{...admittedPayload,publication_required:false}},
    "GET https://api.test/repos/o/r/installation": { body: { id: 99 } },
    "POST https://api.test/app/installations/99/access_tokens": { status: 201, body: { token: "ghs_app" } },
    "POST https://api.test/repos/o/r/check-runs": () => (posted++ === 0 ? { status: 201, body: { id: 5 } } : { status: 502, body: {} }),
  });
  const code = await main(["--mode", "app-check"], appEnv({ ADMISSION_OUTCOME: "success", ADMISSION_MERGE_SLOT: "held" }), flaky.fetchImpl);
  assert.equal(code, 1);
});

test("merge slot: the admission workflow hands the slot state to the app-check step", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  const step = text.slice(text.indexOf("- name: Post the result as the clued-admission App"), text.indexOf("--mode app-check"));
  for (const line of ["ADMISSION_MERGE_SLOT: ${{ steps.admit.outputs.merge_slot }}",
    "ADMISSION_MERGE_SLOT_REF: ${{ steps.admit.outputs.merge_slot_ref }}",
    "ADMISSION_MERGE_SLOT_UNTIL: ${{ steps.admit.outputs.merge_slot_until }}",
    "ADMISSION_MERGE_SLOT_TIP: ${{ steps.admit.outputs.merge_slot_tip }}",
    "ADMISSION_CLAIM_ID: ${{ steps.admit.outputs.claim_id }}",
    "ADMISSION_BASE_REF: ${{ github.event.pull_request.base.ref }}"]) {
    assert.ok(step.includes(line), line);
  }
});

test("merge slot: main --mode required writes the slot state for the app-check step", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-slot-"));
  const out = path.join(dir, "output");
  const eventFile = path.join(dir, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify(withClaim()));
  const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead" } },
    [VERIFY]: { body: { ...admittedPayload, verified_at: VERIFIED_AT, claim: slotClaim() } },
    [PULL]: { body: { ...withClaim().pull_request } } });
  const code = await main(["--mode", "required"], { ...env(), GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: eventFile,
    GITHUB_WORKSPACE: ROOT, GITHUB_OUTPUT: out }, fetchImpl);
  assert.equal(code, 0);
  const lines = fs.readFileSync(out, "utf8").split("\n");
  assert.ok(lines.includes("admitted=true"));
  assert.ok(lines.includes("merge_slot=held"));
  assert.ok(lines.includes(`merge_slot_ref=${SLOT}`));
  assert.ok(lines.includes("merge_slot_until=2026-10-06T10:45:00Z"));
});

test("merge slot: re-verification fails a green kooyumi-merge-slot check whose slot lapsed", async () => {
  const sha = (c) => c.repeat(40);
  const other = "1f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
  const pulls = [
    freshPull({ number: 460, head: { sha: sha("1") }, body: `x\n\nClued-Work-Claim: ${other}` }), // slot lapsed
    freshPull({ number: 461, head: { sha: sha("2") }, body: `x\n\nClued-Work-Claim: ${other}` }), // slot check already failed
    freshPull({ number: 462, head: { sha: sha("3") }, body: `x\n\nClued-Work-Claim: ${other}` }), // behind main now
  ];
  const slotCheck = (head, id, conclusion) => appCheckRun({ id, name: MERGE_SLOT_CHECK_NAME, head_sha: head, conclusion, external_id: `pr:0:run:${id}` });
  const checksFor = (head) => ({
    [sha("1")]: [appCheckOn(sha("1"), 11, "success", "pr:460:run:1"), slotCheck(sha("1"), 12, "success")],
    [sha("2")]: [appCheckOn(sha("2"), 21, "success", "pr:461:run:2"), slotCheck(sha("2"), 22, "failure")],
    [sha("3")]: [appCheckOn(sha("3"), 31, "success", "pr:462:run:3"), slotCheck(sha("3"), 32, "success")],
  })[head] ?? null;
  const { fetchImpl, calls } = reverifyScript(pulls, checksFor, {
    [VERIFY]: { body: { ...admittedPayload, verified_at: VERIFIED_AT, claim: slotClaim({ merge_slot_until: null }) } },
    // #462 no longer contains the tip; every other compare is ahead.
    [COMPARE]: (call) => ({ body: { status: call.url.endsWith(`/compare/${TIP}...${sha("3")}`) ? "diverged" : "ahead", files: [] } }),
    [`GET https://api.test/repos/o/r/compare/${TIP}...`]: { body: { status: "ahead", files: [] } },
  });
  const result = await reverify({ env: env({ CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() }),
    fetchImpl, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.checked.map((c) => [c.pr, c.verdict, c.merge_slot]),
    [[460, "ADMITTED", "missing"], [461, "ADMITTED", "missing"], [462, "ADMITTED", "not_needed"]]);
  assert.deepEqual(result.blocked.map((b) => [b.pr, b.check]), [[460, MERGE_SLOT_CHECK_NAME]]);
  const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs"));
  assert.deepEqual(posts.map((c) => [c.body.name, c.body.head_sha, c.body.conclusion, c.body.external_id]),
    [[MERGE_SLOT_CHECK_NAME, sha("1"), "failure", "pr:460:run:9001"]]);
  assert.match(posts[0].body.output.title, /^RE-VERIFIED: Merge slot not held$/);
  assert.match(renderReverifySummary(result), /#460: failing kooyumi-merge-slot 5005 posted, Merge slot not held: merge:o\/r:main/);
});

test("merge slot: a pull request closed without a merge is not reported here; a merge reports what it returned", async () => {
  // FABLE 11-19 L3: the binding of a PR closed without a merge ends on GitHub's facts (webhook, the resident's PR lifecycle report);
  // the adopt mode makes no call for it, and nothing here gives a merge slot back.
  const closed = () => merged({ pull_request: { merged: false, merge_commit_sha: null } });
  let { fetchImpl, calls } = fakeFetch({});
  let r = await adoptMerged({ env: env(), event: closed(), eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.deepEqual([r.adopted, r.error, r.reason, r.closed_unmerged], [false, null, "not a merged pull request", undefined]);
  assert.deepEqual(calls, []);
  // A merge: adoption answers with the slots it returned.
  ({ fetchImpl } = fakeFetch({ [ADOPT]: { body: { status: "ok", adopted: false, reason: "no_copy_for_pr", merge_slot_returned: [CLAIM] } } }));
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.deepEqual([r.adopted, r.reason, r.error, r.merge_slot_returned], [false, "no_copy_for_pr", null, [CLAIM]]);
});

test("merge slot (review MINOR-2/3/4): the retired switch does not skip it; a transient door or a failed post does not stop re-verification", async () => {
  // Merge Admission step 6: with CLUED_WORK_ADMISSION_ENFORCE unset the slot
  // is checked as always (it was reported as not_checked before).
  const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead", files: [] } },
    [VERIFY]: { body: { ...admittedPayload, verified_at: VERIFIED_AT, claim: slotClaim({ merge_slot_until: null }) } } });
  const unset = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.deepEqual([unset.admitted, unset.merge_slot.state, unset.merge_slot.observed], [true, "missing", undefined]);
  assert.equal(mergeSlotOutputs(unset)[0], "merge_slot=missing");

  const sha = (c) => c.repeat(40);
  const both = (head, pr) => [appCheckOn(head, 1, "success", `pr:${pr}:run:1`),
    appCheckRun({ id: 2, name: MERGE_SLOT_CHECK_NAME, head_sha: head, conclusion: "success", external_id: `pr:${pr}:run:1` })];
  // #470: its claim is no longer current and the slot check cannot be posted; the admission check is still failed.
  let posts = 0;
  let { fetchImpl: f1, calls } = reverifyScript([freshPull({ number: 470, head: { sha: sha("4") } })], (head) => both(head, 470), {
    "POST https://api.test/repos/o/r/check-runs": (call) => (call.body.name === MERGE_SLOT_CHECK_NAME ? { status: 502, body: {} } : { status: 201, body: { id: 7000 + posts++ } }),
  });
  let result = await reverify({ env: env({ CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() }),
    fetchImpl: f1, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(result.errors.map((e) => e.pr), [470]);
  assert.match(result.errors[0].error, /kooyumi-merge-slot/);
  assert.deepEqual(result.blocked.map((b) => [b.pr, b.check ?? APP_CHECK_NAME]), [[470, APP_CHECK_NAME]]);
  assert.deepEqual(calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs")).map((c) => [c.body.name, c.body.conclusion]),
    [[MERGE_SLOT_CHECK_NAME, "failure"], [APP_CHECK_NAME, "failure"]]);

  // #471: a protected change whose Owner review door is down: neither check is touched.
  const other = "1f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
  ({ fetchImpl: f1, calls } = reverifyScript([freshPull({ number: 471, head: { sha: sha("5") }, body: `x\n\nClued-Work-Claim: ${other}` })],
    (head) => both(head, 471), {}, { 'o/r#471': other }));
  const protectedFiles = async (url, init) => (String(url).startsWith("https://api.test/repos/o/r/pulls/471/files")
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ filename: "scripts/ci/x.mjs" }, { filename: "docs/x.md" }], text: async () => "" }
    : f1(url, init));
  result = await reverify({ env: env({ CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() }),
    fetchImpl: protectedFiles, workspace: ROOT, now: () => 1_800_000_000_000 });
  assert.deepEqual(result.errors.map((e) => e.pr), [471], JSON.stringify(result));
  assert.match(result.errors[0].error, /Owner review door is unavailable/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs")).length, 0);
});

// --- Owner Decision a0d93cd0: merging main into an approved head keeps its approval.

test("evaluate (Owner Decision a0d93cd0): a head that only merged main keeps the approval of the head before it", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const SCRIPT = "scripts/ci/clued-work-admission.mjs";
  const APPROVED = "1".repeat(40);
  const MIDDLE = "2".repeat(40);
  const MAIN_1 = "3".repeat(40);
  const MAIN_2 = "4".repeat(40);
  const OLD_BASE = "5".repeat(40);
  const pending = { body: { status: "ok", admitted: false, owner_request: { request_id: "r1", status: "pending", confirm_path: "/confirm/r1" } } };
  const granted = { body: { status: "ok", admitted: true, grant: { grant_id: "g-approved", replayed: true } } };
  // A world: commits and their parents, the compares the walk reads, the heads
  // with a green admission check, and the door's answer per commit.
  const run = async ({ parents = { [HEAD]: [APPROVED, MAIN_1] }, compares = {}, green = [APPROVED], reverified = [], door = {} } = {}) => {
    const compareAnswer = (call) => {
      const pair = call.url.split("/compare/")[1].split("?")[0];
      if (pair in compares) return compares[pair];
      if (pair === `${TIP}...${HEAD}`) return { body: { status: "ahead", files: [{ filename: SCRIPT }] } };
      if (pair.startsWith(`${TIP}...`)) return { body: { status: "diverged", merge_base_commit: { sha: OLD_BASE }, files: [{ filename: SCRIPT }] } };
      if (pair === `${OLD_BASE}...${TIP}`) return { body: { status: "ahead", files: [{ filename: ".github/workflows/other.yml" }] } };
      if (pair.endsWith(`...${HEAD}`)) return { body: { status: "ahead", files: [{ filename: ".github/workflows/other.yml" }, { filename: "docs/x.md" }] } };
      return { body: { status: "ahead", files: [] } };
    };
    const commitAnswer = (call) => {
      const rest = call.url.split("/commits/")[1];
      const sha = rest.slice(0, 40);
      if (rest.includes("/check-runs")) {
        const runs = green.includes(sha) ? [appCheckRun({ head_sha: sha })] : [];
        // The re-verification's later failing check once main moved past the head.
        if (reverified.includes(sha)) runs.push(appCheckRun({ id: 2, head_sha: sha, conclusion: "failure" }));
        return { body: { check_runs: runs } };
      }
      return { body: { sha, parents: (parents[sha] ?? [OLD_BASE]).map((p) => ({ sha: p })) } };
    };
    const doorAnswer = (call) => {
      const sha = call.body.p_input.resources[0].split("/").pop();
      return door[sha] ?? (sha === APPROVED ? granted : pending);
    };
    const { fetchImpl, calls } = fakeFetch({
      [`GET https://api.test/repos/o/r/compare/${TIP}...`]: compareAnswer, [COMPARE]: compareAnswer, [COMMIT]: commitAnswer,
      [FILES]: { body: [{ filename: SCRIPT, status: "modified" }] }, [VERIFY]: { body: admittedPayload }, [DOOR]: doorAnswer });
    const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
    const asked = calls.filter((c) => c.url.endsWith(OWNER_REVIEW_RPC)).map((c) => c.body.p_input.resources[0].split("/").pop());
    return { outcome, asked };
  };

  // The approved head with main merged in: the approval carries over, and the
  // Owner is not asked about the new head.
  let { outcome, asked } = await run();
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"], JSON.stringify(outcome.reasons));
  assert.equal(outcome.owner_review.carried_from, APPROVED);
  assert.equal(outcome.owner_review.grant_id, "g-approved");
  assert.ok(outcome.notices.some((n) => n.startsWith(`owner_review_carried:g-approved from ${APPROVED}`)));
  assert.deepEqual(asked, [APPROVED]);

  // Main moved after the approval, so the re-verification posted a newer
  // failing check on the approved head: the approval still carries over.
  ({ outcome, asked } = await run({ reverified: [APPROVED] }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"], JSON.stringify(outcome.reasons));
  assert.equal(outcome.owner_review.carried_from, APPROVED);
  assert.deepEqual(asked, [APPROVED]);
  // Only failing checks on the earlier head: not asked about.
  ({ asked } = await run({ green: [], reverified: [APPROVED] }));
  assert.deepEqual(asked, [HEAD]);

  // Two merges of main in a row: the deepest admitted head is asked.
  ({ outcome, asked } = await run({ parents: { [HEAD]: [MIDDLE, MAIN_2], [MIDDLE]: [APPROVED, MAIN_1] }, green: [MIDDLE, APPROVED] }));
  assert.equal(outcome.verdict, "ADMITTED");
  assert.deepEqual(asked, [APPROVED]);

  const askedAboutHead = (result) => {
    assert.equal(result.outcome.verdict, "REJECTED");
    assert.match(result.outcome.reasons[0], /^owner_review_required/);
    assert.equal(result.asked.at(-1), HEAD);
  };
  // The merge changed the protected file the pull request changes: a new approval.
  let result = await run({ compares: { [`${APPROVED}...${HEAD}`]: { body: { status: "ahead", files: [{ filename: SCRIPT }] } } } });
  askedAboutHead(result);
  assert.deepEqual(result.asked, [HEAD]);
  // Main changed that file since the approved head's base: a new approval.
  result = await run({ compares: { [`${OLD_BASE}...${TIP}`]: { body: { status: "ahead", files: [{ filename: SCRIPT }] } } } });
  askedAboutHead(result);
  assert.deepEqual(result.asked, [HEAD]);
  // The merged-in commit is not on main.
  result = await run({ compares: { [`${MAIN_1}...${TIP}`]: { body: { status: "diverged", files: [] } } } });
  assert.deepEqual(result.asked, [HEAD]);
  // A head that is not a merge, or a merge of three parents.
  result = await run({ parents: { [HEAD]: [APPROVED] } });
  assert.deepEqual(result.asked, [HEAD]);
  result = await run({ parents: { [HEAD]: [APPROVED, MAIN_1, MAIN_2] } });
  assert.deepEqual(result.asked, [HEAD]);
  // The earlier head was never admitted: the door is not asked about it.
  result = await run({ green: [] });
  assert.deepEqual(result.asked, [HEAD]);
  // A long compare is not trusted.
  result = await run({ compares: { [`${APPROVED}...${HEAD}`]: { body: { status: "ahead", files: Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` })) } } } });
  assert.deepEqual(result.asked, [HEAD]);
  // The door no longer admits the earlier head (its grant was revoked): the
  // Owner is asked about the new head.
  result = await run({ door: { [APPROVED]: pending } });
  askedAboutHead(result);
  assert.deepEqual(result.asked, [APPROVED, HEAD]);
  assert.ok(result.outcome.notices.some((n) => n.startsWith(`owner_review_not_carried: ${APPROVED}`)));
  // The door is down: a transient rejection, so the re-verification leaves the check alone.
  result = await run({ door: { [APPROVED]: { status: 503, body: null } } });
  assert.equal(result.outcome.verdict, "REJECTED");
  assert.equal(result.outcome.owner_review.kind, "transient");
  assert.match(result.outcome.reasons[0], /^owner_review_unavailable:transient/);
  assert.deepEqual(result.asked, [APPROVED]);
});

// Source v2 resident executor (PR-A): the merge gate counts the v2 control pair through the v2 consumer.
// Off the installed clued-control principal the consumer refuses before it opens any file, so the gate
// can never turn a v2 check into an admission here; the consumption itself runs on the fixture engine below.
test("independent-control-checks-v2: the gate and the head reader dispatch to the v2 consumer and fail closed off the controller", async () => {
  const env = { CLUED_EXECUTION_PROVIDER: "independent-control-checks-v2", GITHUB_REPOSITORY: "tdoljyj/cross-memory-system" };
  const event = { pull_request: { number: 7, head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } } };
  const noNetwork = async () => { throw new Error("no network in this test"); };
  await assert.rejects(gate({ env, event, eventName: "pull_request", fetchImpl: noNetwork }), { code: "CONTROL_CONSUMER_V2_PRINCIPAL_REQUIRED" });
  await assert.rejects(appChecksOnHead(noNetwork, env, "tdoljyj/cross-memory-system", "a".repeat(40), "kooyumi-admission-verified"), { code: "CONTROL_CONSUMER_V2_PRINCIPAL_REQUIRED" });
  await assert.rejects(appChecksOnHead(noNetwork, env, "tdoljyj/cross-memory-system", "a".repeat(40), "kooyumi-merge-slot"), { code: "CONTROL_CONSUMER_V2_PRINCIPAL_REQUIRED" });
  // A wrong repository or an unknown check name is refused before the principal is even looked at.
  await assert.rejects(appChecksOnHead(noNetwork, env, "evil/repo", "a".repeat(40), "kooyumi-admission-verified"), { code: "CONTROL_HEAD_SELECTOR_REQUIRED" });
  const consumer = await import("../../work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/consumer.mjs");
  assert.throws(() => consumer.assertControllerPrincipal({ platform: "linux", username: "clued-control" }), { code: "CONTROL_CONSUMER_V2_PRINCIPAL_REQUIRED" });
  assert.doesNotThrow(() => consumer.assertControllerPrincipal({ platform: "win32", username: "clued-control" }));
});

test("independent-control-checks-v2: a settled v2 control pair counts; another claim generation or Source does not, and one head counts one batch", async () => {
  const CI = "../../work/actions-hosted-migration/independent-ci-v1/";
  const { batchJobsV2, claimGeneration } = await import(CI + "src/job-v2.mjs");
  const { recordBatchClaim } = await import(CI + "src/batch-claim-v2.mjs");
  const { EffectJournal } = await import(CI + "src/effect-journal.mjs");
  const { createFixtureControlPublisherV2 } = await import(CI + "src/independent-control-checks-v2/publisher.mjs");
  const { controlJobsFor, consumeControlV2 } = await import(CI + "src/independent-control-checks-v2/consumer.mjs");
  const { admittedFacts } = await import(CI + "test/resident-v2-fixtures.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clued-v2-control-"));
  try {
    const repo = "tdoljyj/cross-memory-system", head = "a".repeat(40), base = "b".repeat(40), ci = "d".repeat(64);
    const now = Date.now(), iso = ms => new Date(ms).toISOString();
    const claim = { claimId: crypto.randomUUID(), fence: 3, epoch: 1, expiresAt: iso(now + 3_600_000) };
    const jobs = batchJobsV2({ repo, pr: 888, headSha: head, baseSha: base, testSha: head, sourceManifestSha256: ci, createdAt: iso(now - 60_000), attempt: 1 });
    const claims = path.join(root, "batch-claims");
    const { record } = await recordBatchClaim(claims, jobs["work-admission"], claim, iso(now - 30_000));
    const checks = []; let next = 100;
    // Stage 8 (quota phase 2, step 3a) also reads main's rules and GitHub's test merge: strict on, the six checks pinned
    // to 5368905, and a test merge of exactly [base, head] with the head's tree (the head contains the base).
    const tree = "c".repeat(40), testMerge = "e".repeat(40);
    const six = ["kooyumi-work-admission", "gitleaks", "trivy", "contract-placement", "kooyumi-admission-verified", "kooyumi-merge-slot"];
    const commits = { [head]: { sha: head, tree, parents: [base] }, [testMerge]: { sha: testMerge, tree, parents: [base, head] } };
    const github = { fixture: true,
      async readChangedPaths(j) { return { complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: ["a.txt"] }; },
      async readBranchRules(branch) { return { complete: true, branch, rules: [{ type: "deletion", rulesetId: 24182890, parameters: null },
        { type: "pull_request", rulesetId: 24182890, parameters: { allowed_merge_methods: ["merge", "squash", "rebase"], required_approving_review_count: 0 } },
        { type: "required_status_checks", rulesetId: 24182890, parameters: { strict_required_status_checks_policy: true, required_status_checks: six.map(context => ({ context, integration_id: 5368905 })) } }] }; },
      async readPullRequest(n) { return { number: n, state: "open", merged: false, mergeable: true, merge_commit_sha: testMerge, head: { sha: head, repo: { full_name: repo } }, base: { sha: base, ref: "main", repo: { full_name: repo } } }; },
      async readGitCommit(sha) { if (!commits[sha]) throw Object.assign(new Error("github_http_404"), { code: "github_http_404" }); return structuredClone(commits[sha]); },
      async readChecks(h) { return { complete: true, checks: checks.filter(c => c.head_sha === h).map(c => structuredClone(c)) }; },
      async createCheck(body) { const c = { id: next++, app: { id: 5368905 }, ...structuredClone(body) }; checks.push(c); return structuredClone(c); },
      async revokeCheck(id, body) { const c = checks.find(x => x.id === id); Object.assign(c, structuredClone(body)); return structuredClone(c); } };
    let observed = claim;
    const admission = { fixture: true, async evaluatePr(j, packet, opts) {
      return admittedFacts(j, observed, packet, { domain: "fixture", mergeQueueHead: true, batchClaim: opts?.batchClaim, observedAt: Date.now(), slotUntil: now + 3_600_000 });
    } };
    const journal = await EffectJournal.open(path.join(root, "effects-control"));
    const consumerFor = batchClaim => createFixtureControlPublisherV2({ github, journal, admission, assertLive() {}, record() {}, authority: {}, batchClaim });
    // stage 8 published the pair under the batch claim generation
    const pub = consumerFor(claimGeneration(claim));
    for (const role of ["control-admission", "control-merge-slot"]) assert.equal((await pub.publishOne(jobs[role])).status, "SETTLED");
    for (const name of ["kooyumi-admission-verified", "kooyumi-merge-slot"]) {
      const candidates = controlJobsFor([record], { repository: repo, headSha: head, name }, ci);
      assert.equal(candidates.length, 1);
      const { proof } = await consumeControlV2({ candidates, consumerFor });
      assert.equal(proof.contract, "clued.independent-ci.control-consumption/2");
      assert.equal(proof.check.name, name);
      assert.match(proof.check.external_id, /^independent-ci:control:control-(admission|merge-slot):v2:[0-9a-f]{64}:a1:c[0-9a-f]{8}:f3:e1$/);
    }
    // another CI Source: no candidate, no green check
    assert.deepEqual(controlJobsFor([record], { repository: repo, headSha: head, name: "kooyumi-admission-verified" }, "e".repeat(64)), []);
    await assert.rejects(consumeControlV2({ candidates: [], consumerFor }), { code: "CONTROL_HEAD_NOT_CURRENT" });
    // a takeover (new fence) after publication: the settled check no longer counts and is compensated once
    observed = { ...claim, fence: 4 };
    await assert.rejects(consumeControlV2({ candidates: controlJobsFor([record], { repository: repo, pr: 888, headSha: head, name: "kooyumi-admission-verified" }, ci), consumerFor }));
    assert.equal(checks.find(c => c.name === "kooyumi-admission-verified" && c.external_id.includes(jobs["control-admission"].id)).conclusion, "failure");
    observed = claim;
    // the same head under a second PR: the role is already on GitHub for this head (C4, cross-node "already published"),
    // so that batch never publishes it again; the head's compensated check counts for no batch, under any PR
    const jobs2 = batchJobsV2({ repo, pr: 889, headSha: head, baseSha: base, testSha: head, sourceManifestSha256: ci, createdAt: iso(now - 60_000), attempt: 1 });
    const second = (await recordBatchClaim(claims, jobs2["work-admission"], claim, iso(now - 30_000))).record;
    const again = await pub.publishOne(jobs2["control-admission"]);
    assert.deepEqual([again.status, again.reason, again.sideEffects], ["BLOCKED", "ROLE_ALREADY_ON_GITHUB", 0]);
    await assert.rejects(consumeControlV2({ candidates: controlJobsFor([record, second], { repository: repo, headSha: head, name: "kooyumi-admission-verified" }, ci), consumerFor }),
      { code: "TRUSTED_SETTLED_CONTROL_JOURNAL_REQUIRED" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- PR-B hosted executor gate: the independent CI's own admission (Owner Decision 22b0e0ed).
const NATIVE_ID = `independent-ci:native-work-admission:${"3".repeat(64)}:f9:e1:a1`;
const nativeCheck = (overrides = {}) => ({ id: 50, name: "kooyumi-work-admission", head_sha: HEAD, status: "completed", conclusion: "success",
  external_id: NATIVE_ID, app: { id: 5368905 },
  output: { title: "Work claim and complete Native admission verified", summary: `Independent Native control check for o/r#452; observation sha256 ${"5".repeat(64)}.` },
  ...overrides });
const independentEvent = () => {
  const value = withClaim();
  value.pull_request.base.repo = { full_name: "o/r", default_branch: "main" };
  return value;
};
async function requiredDispatch({ inputs = { pr: '452', head: HEAD }, current = {}, checks = [nativeCheck()], overrides = {}, others = [], jobs = {}, truncated = false, epoch = true, moveAfterGate = false } = {}) {
  const pr = independentEvent().pull_request;
  Object.assign(pr, { state: 'open', head: { ...pr.head, ref: 'claude/g3' } }, current);
  const self = { id: 9001, head_sha: HEAD, head_branch: 'claude/g3', event: 'workflow_dispatch', run_attempt: 1,
    path: '.github/workflows/clued-required-tests.yml', created_at: RUN_CREATED, actor: { login: 'o', type: 'User' } };
  let prReads = 0;
  const fake = fakeFetch({ ...SELF_RUN, ...Object.fromEntries(Object.entries(jobs).map(([id, value]) =>
    [`GET https://api.test/repos/o/r/actions/runs/${id.split(':')[0]}/attempts/${id.split(':')[1] ?? 1}/jobs`,
      { body: Array.isArray(value) ? { total_count: value.length, jobs: value } : value }])),
    [THIS_RUN]: { body: self }, [PULL]: () => ({ body:
    moveAfterGate && ++prReads > 1 ? { ...pr, head: { ...pr.head, sha: BASE } } : pr }),
    [CHECKS]: { body: { check_runs: checks } },
    [`POST ${EPOCH_URL}`]: { body: { status: 'ok', guard_required: true, epoch_current: epoch } },
    [`GET https://api.test/repos/o/r/actions/workflows/clued-required-tests.yml/runs`]: {
      body: { total_count: truncated ? 101 : others.length + 1, workflow_runs: [self, ...others] } } });
  const outcome = await gate({ env: env({ CLUED_ADMISSION_GATE_SOURCE: INDEPENDENT_GATE_SOURCE,
    CLUED_ADMISSION_GATE_WAIT_SECONDS: '0', GITHUB_ACTOR: 'o', GITHUB_REPOSITORY_OWNER: 'o',
    GITHUB_SHA: HEAD, GITHUB_REF: 'refs/heads/claude/g3', GITHUB_REF_NAME: 'claude/g3',
    GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-required-tests.yml@refs/heads/claude/g3', ...overrides }),
    event: { inputs, repository: { default_branch: 'main' } }, eventName: 'workflow_dispatch', fetchImpl: fake.fetchImpl });
  return { outcome, calls: fake.calls };
}

test('G3 dispatch: current open PR/head needs the original Native admission and execution epoch', async () => {
  const { outcome, calls } = await requiredDispatch();
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.head_sha, outcome.pr_ref], [true, 'ADMITTED', HEAD, 'o/r#452']);
  assert.ok(calls.some(call => call.url.includes('check_name=kooyumi-work-admission')));
  assert.ok(calls.some(call => call.body?.p_input?.action === 'execution_current' && call.body.p_input.pr_ref === 'o/r#452'));
});

const skippedDispatchRun = (overrides = {}) => ({ id: 8001, head_sha: HEAD, event: 'pull_request', status: 'completed', run_attempt: 1,
  actor: { login: 'clued-admission[bot]', type: 'Bot' }, ...overrides });
const skippedDispatchJobs = () => [{ id: 80, name: 'admission-gate', head_sha: HEAD, status: 'completed', conclusion: 'success' },
  ...['ci-suites-skipped', 'clued-cloud-tests-skipped', 'migration-verify-skipped'].map((name, i) =>
    ({ id: 81 + i, name, head_sha: HEAD, status: 'completed', conclusion: 'skipped' }))];

test('bot head dispatch: Owner recovers completed PR runs whose heavy jobs all skipped', async () => {
  const { outcome, calls } = await requiredDispatch({ others: [skippedDispatchRun()], jobs: { 8001: skippedDispatchJobs() } });
  assert.equal(outcome.admitted, true, JSON.stringify(outcome));
  assert.equal(outcome.automation_self_hosted, false, 'does not extend automation trust');
  assert.ok(calls.some(c => c.url.includes('/actions/runs/8001/attempts/1/jobs')));
});

test('bot head dispatch: active, dispatch, foreign, empty or previously executed jobs stay refused', async () => {
  const ran = skippedDispatchJobs(); ran[1].conclusion = 'success';
  const wrongHead = skippedDispatchJobs(); wrongHead[1].head_sha = BASE;
  for (const opts of [
    { others: [skippedDispatchRun({ status: 'queued' })] },
    { others: [skippedDispatchRun({ status: 'in_progress' })] },
    { others: [skippedDispatchRun({ event: 'workflow_dispatch' })] },
    { others: [skippedDispatchRun({ event: 'push' })] },
    { others: [skippedDispatchRun({ head_sha: BASE })] },
    { jobs: { 8001: [] } }, { jobs: { 8001: ran } }, { jobs: { 8001: wrongHead } },
  ]) assert.equal((await requiredDispatch({ others: [skippedDispatchRun()], jobs: { 8001: skippedDispatchJobs() }, ...opts })).outcome.admitted, false, JSON.stringify(opts));
});

test('bot head dispatch: all runs and earlier attempts are checked, incomplete inventories refuse; the dispatch is a new run with its own budget', async () => {
  const twoAttempts = [skippedDispatchRun({ run_attempt: 2 })], twoRuns = [skippedDispatchRun(), skippedDispatchRun({ id: 8002 })];
  const jobs = { 8001: skippedDispatchJobs(), '8001:2': skippedDispatchJobs(), 8002: skippedDispatchJobs() };
  for (const others of [twoAttempts, twoRuns]) assert.equal((await requiredDispatch({ others, jobs })).outcome.admitted, true, 'two attempts and this dispatch: three');
  // Fable 11-20 补“补跑上限的范围”: the dispatch is a new run with its own budget, whatever earlier runs used.
  const three = await requiredDispatch({ others: [skippedDispatchRun({ run_attempt: 2 }), skippedDispatchRun({ id: 8002 })], jobs });
  assert.equal(three.outcome.admitted, true, JSON.stringify(three.outcome.reasons));
  const ran = skippedDispatchJobs(); ran[1].conclusion = 'failure';
  for (const [others, changed] of [
    [twoAttempts, { ...jobs, 8001: ran }], [twoAttempts, { ...jobs, '8001:2': ran }], [twoRuns, { ...jobs, 8002: ran }],
    [twoRuns, { ...jobs, 8001: { total_count: 5, jobs: skippedDispatchJobs() } }],
  ]) assert.equal((await requiredDispatch({ others, jobs: changed })).outcome.admitted, false);
});

test('G3 dispatch: malformed, closed, moved, foreign, duplicate and unauthorized requests fail closed', async () => {
  for (const opts of [
    { inputs: {} }, { inputs: { pr: '452;echo', head: HEAD } }, { inputs: { pr: '452', head: BASE } },
    { current: { state: 'closed' } }, { current: { head: { sha: BASE } } },
    { current: { base: { ref: 'other', repo: { full_name: 'o/r', default_branch: 'main' } } } },
    { current: { head: { sha: HEAD, ref: 'claude/g3', repo: { full_name: 'fork/r' } } } },
    { overrides: { GITHUB_ACTOR: 'stranger' } }, { overrides: { GITHUB_RUN_ATTEMPT: '2' } },
    { checks: [nativeCheck({ app: { id: 1 } })] }, { checks: [nativeCheck({ conclusion: 'failure' })] },
    { others: [{ id: 9002, head_sha: HEAD, event: 'pull_request', status: 'queued' }] }, { truncated: true },
    { epoch: false }, { moveAfterGate: true },
  ]) assert.equal((await requiredDispatch(opts)).outcome.admitted, false, JSON.stringify(opts));
});

async function independentGate(checks, { envOverrides = {}, script = {}, eventValue = independentEvent() } = {}) {
  const { fetchImpl, calls } = fakeFetch({ ...SELF_RUN, [CHECKS]: typeof checks === "function" ? checks : { body: { check_runs: checks } }, ...script });
  const slept = [];
  const outcome = await gate({ env: env({ CLUED_ADMISSION_GATE_SOURCE: INDEPENDENT_GATE_SOURCE, ...envOverrides }), event: eventValue,
    eventName: "pull_request", fetchImpl, sleep: async (ms) => { slept.push(ms); } });
  return { outcome, calls, slept };
}

test("independent gate: App 5368905's bound kooyumi-work-admission success for the exact head admits at once", async () => {
  assert.deepEqual([INDEPENDENT_GATE_SOURCE, INDEPENDENT_GATE_WAIT_SECONDS, INDEPENDENT_GATE_POLL_SECONDS],
    ["independent-ci-native-work-admission", 600, 30]);
  const { outcome, calls, slept } = await independentGate([nativeCheck()]);
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_source, outcome.automation_self_hosted, outcome.enforced, slept],
    [true, "ADMITTED", INDEPENDENT_GATE_SOURCE, false, true, []]);
  assert.deepEqual([outcome.head_sha, outcome.base_sha, outcome.pr_ref], [HEAD, BASE, "o/r#452"]);
  assert.ok(calls.some((call) => call.url.includes("/check-runs?check_name=kooyumi-work-admission&filter=all")));
  assert.ok(calls.every((call) => call.method === "GET" || call.url === EPOCH_URL), "read-only, besides the public epoch observation");
  // The newest of App 5368905 decides: a later success over a failure admits, a later failure refuses.
  assert.equal((await independentGate([nativeCheck({ id: 40, conclusion: "failure" }), nativeCheck({ id: 51 })])).outcome.admitted, true);
  const refused = (await independentGate([nativeCheck({ id: 40 }), nativeCheck({ id: 51, conclusion: "failure" })])).outcome;
  assert.deepEqual([refused.admitted, refused.verdict], [false, "REJECTED"]);
  assert.match(refused.reasons[0], /concluded failure/);
});

test("independent gate: same-name checks of other Apps, other heads, unbound ids or summaries never admit", async () => {
  for (const [label, list, verdict] of [
    ["GitHub Actions", [nativeCheck({ app: { id: 15368 } })], "ADMISSION_PENDING"],
    ["clued-admission App", [nativeCheck({ app: { id: 5164952 } })], "ADMISSION_PENDING"],
    ["another App", [nativeCheck({ app: { id: 999 } })], "ADMISSION_PENDING"],
    ["another head", [nativeCheck({ head_sha: BASE })], "ADMISSION_PENDING"],
    ["an admission-run id", [nativeCheck({ external_id: "pr:452:run:77" })], "REJECTED"],
    ["a staged id", [nativeCheck({ external_id: `independent-ci:staged:${"4".repeat(64)}:f9:e1:a1` })], "REJECTED"],
    ["a control id", [nativeCheck({ external_id: `independent-ci:control:control-admission:${"1".repeat(64)}:f9:e1:a1` })], "REJECTED"],
    ["another pull request", [nativeCheck({ output: { summary: "Independent Native control check for o/r#453; x" } })], "REJECTED"],
    ["no pull request", [nativeCheck({ output: { summary: "Independent Native control check" } })], "REJECTED"],
    ["still running", [nativeCheck({ status: "in_progress", conclusion: null })], "ADMISSION_PENDING"],
  ]) {
    const { outcome } = await independentGate(list, { envOverrides: { CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" } });
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, verdict], label);
  }
  // Not into the default branch, a stale execution epoch or a re-run: refused.
  const other = independentEvent(); other.pull_request.base.ref = "release";
  assert.equal((await independentGate([nativeCheck()], { eventValue: other })).outcome.verdict, "REJECTED");
  const stale = await independentGate([nativeCheck()], { script: { [VERIFY]: { body: { status: "ok", guard_required: true, epoch_current: false } } } });
  assert.deepEqual([stale.outcome.admitted, stale.outcome.reasons], [false, ["work_claim_execution_epoch_stale"]]);
  const rerun = await independentGate([nativeCheck()], { envOverrides: { GITHUB_RUN_ATTEMPT: "2" },
    script: { [PULL]: { body: { state: "open", head: { sha: HEAD }, base: { ref: "main" } } } } });
  assert.deepEqual([rerun.outcome.admitted, rerun.outcome.verdict], [false, "RERUN_REFUSED"]);
  // An unknown source fails the gate instead of falling back.
  await assert.rejects(() => gate({ env: env({ CLUED_ADMISSION_GATE_SOURCE: "any" }), event: independentEvent(), eventName: "pull_request",
    fetchImpl: fakeFetch(SELF_RUN).fetchImpl, sleep: async () => {} }), /unknown admission gate source/);
});

test("independent gate: polls about every 30 seconds for at most 10 minutes, then skips the executor", async () => {
  let reads = 0;
  const late = (call) => {
    if (!call.url.includes("check_name=kooyumi-work-admission")) return { body: { check_runs: [] } };
    reads += 1;
    return { body: { check_runs: reads < 4 ? [] : [nativeCheck()] } };
  };


  let result = await independentGate(late);
  assert.deepEqual([result.outcome.admitted, result.slept], [true, [30000, 30000, 30000]]);
  result = await independentGate([]);
  assert.deepEqual([result.outcome.admitted, result.outcome.verdict], [false, "ADMISSION_PENDING"]);
  assert.equal(result.slept.length, 20);
  assert.equal(result.slept.reduce((sum, ms) => sum + ms, 0), 600000);
  assert.match(result.outcome.reasons[0], /kooyumi-work-admission of App 5368905 for #452 .* has posted no check after 600s/);
  // A longer configured wait is capped at the ceiling (see the wait test below).
  result = await independentGate([], { envOverrides: { CLUED_ADMISSION_GATE_WAIT_SECONDS: "3600" } });
  assert.equal(result.slept.reduce((sum, ms) => sum + ms, 0), 780000);
  // independentAdmissionCheck needs checks: read.
  const forbidden = fakeFetch({ [CHECKS]: { status: 403, body: {} } });
  await assert.rejects(() => independentAdmissionCheck(forbidden.fetchImpl, env(), "o/r", HEAD, 452), /needs `checks: read`/);
});

// --- Repair re-run of the independent gate: a slow independent CI makes attempt 1 end in ADMISSION_PENDING with every
// heavy job skipped; "Re-run all jobs" is admitted once the admission settled, and only while no heavy job of the head ever ran.
const HEAVY_JOBS = ["clued-cloud-tests", "ci-suites", "migration-verify"];
const attemptJob = (id, name, conclusion, overrides = {}) => ({ id, name, head_sha: HEAD, status: "completed", conclusion, ...overrides });
const pendingNote = { title: "admission-gate", message: "ADMISSION_PENDING: kooyumi-work-admission of App 5368905 for #452 has posted no check after 600s; heavy jobs are skipped." };
const refusedNote = { title: "admission-gate", message: "RERUN_REFUSED: run attempt 2: the independent CI admission allows one repair re-run; push a new commit; this re-run did not run the heavy jobs." };
const timeoutIncident = JSON.parse(fs.readFileSync(new URL("./fixtures/required-tests-timeout-1159.json", import.meta.url), "utf8"));
const timeoutJobId = 134709790262;
const shiftAttemptTime = (timestamp, n) => n === 1 ? timestamp : new Date(Date.parse(timestamp) + (n - 1) * 35 * 60_000).toISOString();
const timeoutAttempt = (n = 1, log = "2026-11-18T10:08:08.8314618Z ##[error]The operation was canceled.", head = HEAD) => ({
  jobs: timeoutIncident.first_jobs.map(job => ({ ...job, head_sha: head, run_attempt: n, id: job.id + n - 1,
    started_at: shiftAttemptTime(job.started_at, n), completed_at: shiftAttemptTime(job.completed_at, n) })),
  notes: [],
  annotations: { [timeoutJobId + n - 1]: timeoutIncident.timeout_annotations },
  logs: { [timeoutJobId + n - 1]: log },
});
const incidentRefusal = {
  jobs: timeoutIncident.second_jobs.map(job => ({ ...job, head_sha: HEAD })),
  notes: timeoutIncident.refused_annotation,
};
const stagingRef = "refs/heads/clued-train/staging";
const stagingActor = "clued-ci-checks-turing-20261018[bot]";
const stagingWorkflow = ".github/workflows/clued-required-tests.yml";
const recoveryWorkflowPath = `https://api.test/repos/o/r/actions/workflows/${timeoutIncident.workflow_id}/runs`;
const recoveryJobsPath = "https://api.test/repos/o/r/actions/runs/7000/jobs";
const recoveredAt = "2026-11-18T10:44:00Z";
const recoveredHead = "d".repeat(40);
const recoveryRun = { id: 7000, workflow_id: timeoutIncident.workflow_id, head_sha: recoveredHead,
  path: stagingWorkflow, event: "push", status: "completed", updated_at: recoveredAt };
const recoveryJob = attemptJob(7010, "migration-verify", "success", { head_sha: recoveredHead, completed_at: recoveredAt });
const recoveryScript = (run = recoveryRun, job = recoveryJob) => ({
  [`GET ${recoveryWorkflowPath}`]: { body: { total_count: 1, workflow_runs: [run] } },
  [`GET ${recoveryJobsPath}?filter=all`]: { body: { total_count: 1, jobs: [job] } },
});
// A previous attempt n: the gate job (id 100n) with its annotations, and the heavy jobs with the given conclusions.
const earlierAttempt = (n, { heavy = ["skipped", "skipped", "skipped"], notes = [pendingNote], extraJobs = [], gateJobs } = {}) => ({
  jobs: gateJobs ?? [attemptJob(100 * n, "admission-gate", "success"), ...heavy.map((conclusion, index) => attemptJob(100 * n + 1 + index, HEAVY_JOBS[index] ?? `heavy-${index}`,
    conclusion === "in_progress" ? null : conclusion, conclusion === "in_progress" ? { status: "in_progress" } : {})), ...extraJobs],
  notes,
});
async function repairGate(earlier, { attempt = earlier.length + 1, checks = [nativeCheck()], selfRun = {}, script = {}, listStatus = {}, envOverrides = {}, staging = false, otherRuns = [] } = {}) {
  const extra = [];
  const base = fakeFetch({ ...SELF_RUN, [THIS_RUN]: { body: { id: 9001, run_attempt: attempt, head_sha: HEAD, created_at: RUN_CREATED,
    workflow_id: timeoutIncident.workflow_id, ...(staging ? { event: "push", head_branch: "clued-train/staging", path: stagingWorkflow, actor: { login: stagingActor } } : {}), ...selfRun } },
    [CHECKS]: { body: { check_runs: checks } }, [PULL]: { body: { state: "open", head: { sha: HEAD }, base: { ref: "main" } } }, ...script });
  // The attempt-jobs and annotation URLs extend the run URL key, so they are served here, not by the first-prefix script.
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    // The head's runs (Fable 11-20: three attempts per head and workflow): this run at its attempt, and any other run of the head.
    if (/\/actions\/runs\?head_sha=/.test(text)) {
      extra.push({ url: text, method: init.method ?? "GET" });
      const runs = [{ id: 9001, workflow_id: timeoutIncident.workflow_id, head_sha: HEAD, run_attempt: attempt }, ...otherRuns];
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ total_count: runs.length, workflow_runs: runs }), text: async () => "" };
    }
    const jobs = /\/actions\/runs\/9001\/attempts\/(\d+)\/jobs/.exec(text);
    const notes = /\/check-runs\/(\d+)\/annotations/.exec(text);
    const logs = /\/actions\/jobs\/(\d+)\/logs/.exec(text);
    if (logs) {
      extra.push({ url: text, method: init.method ?? "GET" });
      const found = earlier.map((entry) => entry.logs?.[logs[1]]).find((value) => value !== undefined);
      const status = listStatus.logs ?? (found === undefined ? 404 : 200);
      return { ok: status === 200, status, headers: { get: () => null }, json: async () => ({}), text: async () => found ?? "" };
    }
    if (jobs || notes) {
      extra.push({ url: text, method: init.method ?? "GET" });
      const status = (jobs ? listStatus.jobs : listStatus.notes) ?? 200;
      const found = jobs ? earlier[Number(jobs[1]) - 1] : earlier.find((entry) => entry.jobs.some((job) => String(job.id) === notes[1]));
      const body = status !== 200 || !found ? {} : jobs ? { total_count: found.jobs.length, jobs: found.jobs } : found.annotations?.[notes[1]] ?? found.notes;
      return { ok: status === 200, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return base.fetchImpl(url, init);
  };
  const slept = [];
  const outcome = await gate({ env: env({ CLUED_ADMISSION_GATE_SOURCE: INDEPENDENT_GATE_SOURCE, GITHUB_RUN_ATTEMPT: String(attempt),
    ...(staging ? { GITHUB_REF: stagingRef, GITHUB_SHA: HEAD, GITHUB_ACTOR: stagingActor, GITHUB_WORKFLOW_REF: `o/r/${stagingWorkflow}@${stagingRef}` } : {}), ...envOverrides }),
    event: staging ? {} : independentEvent(), eventName: staging ? "push" : "pull_request", fetchImpl, sleep: async (ms) => { slept.push(ms); } });
  return { outcome, calls: base.calls, extra, slept };
}

test("independent gate repair re-run: earlier attempts that only ended in ADMISSION_PENDING allow one re-run once the admission settled", async () => {
  const { outcome, calls, extra, slept } = await repairGate([earlierAttempt(1)]);
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.reasons, slept], [true, "ADMITTED", [], []]);
  assert.deepEqual(outcome.repair_rerun, { attempt: 2, earlier_attempts: [{ attempt: 1, heavy_jobs: 3 }] });
  assert.deepEqual(extra.map((call) => call.url.replace("https://api.test/repos/o/r/", "").replace(/\?.*$/, "")),
    ["actions/runs/9001/attempts/1/jobs", "check-runs/100/annotations"], "the budget is this run's own attempt number: no other run is read");
  assert.ok([...calls, ...extra].every((call) => call.method === "GET" || call.url === EPOCH_URL), "read-only, besides the public epoch observation");
  // A first re-run that was itself refused (an old gate, or a stale head) ran nothing: the next one is still the repair.
  const second = await repairGate([earlierAttempt(1), earlierAttempt(2, { notes: [refusedNote] })]);
  assert.deepEqual([second.outcome.admitted, second.outcome.verdict], [true, "ADMITTED"]);
  assert.deepEqual(second.outcome.repair_rerun.earlier_attempts.map((entry) => entry.attempt), [1, 2]);
  // Any number of other jobs are heavy jobs.
  const many = await repairGate([earlierAttempt(1, { heavy: ["skipped", "skipped", "skipped", "skipped", "skipped"] })]);
  assert.equal(many.outcome.admitted, true);
});

test("independent gate repair re-run: an earlier attempt that ran any heavy job refuses, whatever its conclusion", async () => {
  for (const conclusion of ["success", "failure", "cancelled", "timed_out", "neutral", "in_progress"]) {
    const { outcome } = await repairGate([earlierAttempt(1, { heavy: ["skipped", conclusion, "skipped"] })]);
    assert.deepEqual([conclusion, outcome.admitted, outcome.verdict], [conclusion, false, "RERUN_REFUSED"]);
    assert.match(outcome.reasons[0], /attempt 1 already ran ci-suites: (completed\/\w+|in_progress\/none)/);
    assert.match(outcome.reasons[0], /environment evidence does not allow repair/);
  }
  // All heavy jobs ran in attempt 1 (the ordinary failed-test case): refused, the commit's tests ran once.
  assert.equal((await repairGate([earlierAttempt(1, { heavy: ["failure", "success", "success"], notes: [] })])).outcome.verdict, "RERUN_REFUSED");
  // The skipped attempt uses no budget, but attempt 2 provides no evidence of an environment failure.
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const { outcome } = await repairGate([earlierAttempt(1), earlierAttempt(2, { heavy: [conclusion, "skipped", "skipped"], notes: [] })]);
    assert.deepEqual([conclusion, outcome.admitted, outcome.verdict], [conclusion, false, "RERUN_REFUSED"]);
    assert.match(outcome.reasons[0], /attempt 2 already ran clued-cloud-tests/);
  }
  // A later attempt does not hide an earlier one that ran.
  assert.equal((await repairGate([earlierAttempt(1, { heavy: ["success", "success", "success"] }), earlierAttempt(2), earlierAttempt(3)])).outcome.verdict, "RERUN_REFUSED");
});

// --- Environment re-run (Task 1b): an earlier attempt that ran heavy jobs is repaired once when every failed job died of the
// environment alone (the runner's "Set up job", or a network failure in its log with no failed test).
const step = (name, conclusion) => ({ name, status: "completed", conclusion });
const SETUP_DIED = [step("Set up job", "failure"), step("Run tests", "skipped")];
const TESTS_DIED = [step("Set up job", "success"), step("Run tests", "failure")];
const NET_LOG = "2026-11-15T01:00:00Z npm error code ECONNRESET\n2026-11-15T01:00:01Z npm error network aborted\n##[error]Process completed with exit code 1.";
const TEST_LOG = "2026-11-15T01:00:00Z not ok 3 - admission refuses\n2026-11-15T01:00:01Z # fail 1\n##[error]Process completed with exit code 1.";
// An attempt n that ran: each spec is { conclusion, steps, log }. Job ids are 100n+1... like earlierAttempt.
const ranAttempt = (n, specs, { gate = attemptJob(100 * n, "admission-gate", "success"), notes = [] } = {}) => ({
  jobs: [gate, ...specs.map((spec, index) => attemptJob(100 * n + 1 + index, HEAVY_JOBS[index] ?? `heavy-${index}`, spec.conclusion, spec.steps ? { steps: spec.steps } : {}))],
  notes,
  logs: Object.fromEntries(specs.flatMap((spec, index) => spec.log === undefined ? [] : [[String(100 * n + 1 + index), spec.log]])),
});
const pass = { conclusion: "success", steps: [step("Set up job", "success"), step("Run tests", "success")] };
const netFail = { conclusion: "failure", steps: TESTS_DIED, log: NET_LOG };
const setupFail = { conclusion: "failure", steps: SETUP_DIED };

test("independent gate: #1159 job records with timeout-only evidence admit attempt 2 and attempt 3 after a refused attempt ran nothing", async () => {
  for (const earlier of [[timeoutAttempt()], [timeoutAttempt(), incidentRefusal]]) {
    const { outcome, extra } = await repairGate(earlier);
    assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"], outcome.reasons.join("; "));
    assert.deepEqual(outcome.repair_rerun.earlier_attempts[0].environment_failure, ["migration-verify"]);
    assert.deepEqual(outcome.repair_rerun.earlier_attempts[0].environment_failure_kinds, { "migration-verify": "timeout" });
    assert.ok(extra.some(call => call.url.includes(`/check-runs/${timeoutJobId}/annotations`)));
    assert.ok(extra.some(call => call.url.endsWith(`/actions/jobs/${timeoutJobId}/logs`)));
    assert.ok(extra.every(call => call.method === "GET"));
  }
});

test("independent gate: real #1159 failures and missing timeout evidence refuse repair", async () => {
  const noTimeout = timeoutAttempt();
  noTimeout.annotations[timeoutJobId] = [{ message: "The operation was canceled." }];
  const failedStep = timeoutAttempt();
  failedStep.jobs = failedStep.jobs.map(job => job.id === timeoutJobId
    ? { ...job, steps: [...job.steps, step("Run tests", "failure")] } : job);
  for (const [label, earlier, options] of [
    ["actual #1159 log excerpt", timeoutAttempt(1, timeoutIncident.migration_log_excerpt), {}],
    ["ordinary cancellation", noTimeout, {}],
    ["failed step", failedStep, {}],
    ["unreadable annotations", timeoutAttempt(), { listStatus: { notes: 404 } }],
    ["unreadable log", timeoutAttempt(), { listStatus: { logs: 404 } }],
    ["empty log", timeoutAttempt(1, ""), {}],
  ]) {
    const { outcome, extra } = await repairGate([earlier], options);
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"], label);
    if (label === "ordinary cancellation") assert.ok(extra.every(call => !call.url.endsWith("/logs")));
  }
});

test("independent gate: a second repair needs a matching job success after the last real attempt and on another commit", async () => {
  const twice = [timeoutAttempt(), timeoutAttempt(2)];
  for (const [label, script] of [
    ["none", { [`GET ${recoveryWorkflowPath}`]: { body: { total_count: 0, workflow_runs: [] } } }],
    ["same head", recoveryScript({ ...recoveryRun, head_sha: HEAD }, { ...recoveryJob, head_sha: HEAD })],
    ["wrong workflow", recoveryScript({ ...recoveryRun, workflow_id: 123 })],
    ["wrong job", recoveryScript(recoveryRun, { ...recoveryJob, name: "ci-suites" })],
    ["success between real attempts", recoveryScript(recoveryRun, { ...recoveryJob, completed_at: "2026-11-18T10:15:00Z" })],
    ["success exactly at the end of the last real attempt", recoveryScript(recoveryRun, { ...recoveryJob, completed_at: "2026-11-18T10:43:17Z" })],
    ["job from another head", recoveryScript(recoveryRun, { ...recoveryJob, head_sha: "e".repeat(40) })],
  ]) {
    const { outcome } = await repairGate(twice, { script });
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"], label);
    assert.match(outcome.reasons[0], /recovery evidence/, label);
  }
  const recovered = await repairGate(twice, { script: recoveryScript() });
  assert.deepEqual([recovered.outcome.admitted, recovered.outcome.verdict], [true, "ADMITTED"], recovered.outcome.reasons.join("; "));
  const capped = await repairGate([...twice, timeoutAttempt(3)], { script: recoveryScript() });
  assert.equal(capped.outcome.verdict, "RERUN_REFUSED");
  assert.match(capped.outcome.reasons[0], /three .*attempts/i);
  assert.ok(capped.calls.every(call => !call.url.startsWith(recoveryWorkflowPath)));
});

test("staging gate: the required-tests push uses the same repair budget on S without PR admission", async () => {
  const [timeout, ordinaryCancel, twice] = [timeoutAttempt(), timeoutAttempt(), [timeoutAttempt(), timeoutAttempt(2)]];
  ordinaryCancel.annotations[timeoutJobId] = [];
  for (const [label, earlier, options, verdict] of [
    ["first staging run", [], {}, "NOT_APPLICABLE"],
    ["timeout", [timeout], {}, "ADMITTED"],
    ["ordinary cancellation", [ordinaryCancel], {}, "RERUN_REFUSED"],
    ["second repair without recovery", twice, {}, "RERUN_REFUSED"],
    ["second repair after recovery", twice, { script: recoveryScript() }, "ADMITTED"],
    ["attempt history is for a PR head, not S", [timeoutAttempt(1, undefined, recoveredHead)], {}, "RERUN_REFUSED"],
    ["API run is for another branch", [timeout], { selfRun: { head_branch: "main" } }, "RERUN_REFUSED"],
  ]) {
    const { outcome, calls } = await repairGate(earlier, { staging: true, ...options });
    assert.equal(outcome.verdict, verdict, `${label}: ${outcome.reasons.join("; ")}`);
    assert.ok(calls.every(call => !/\/pulls\/|kooyumi-work-admission/.test(call.url)), label);
  }
});

// Fable 11-20 (单一判定, B1) and review 2 high 4: the one failure rule is scripts/ci/required-tests-failure-rule.mjs, under the protected
// scripts/ci/** path, which the gate imports. The companion's env-failure.mjs is the same file byte for byte (its package cannot import
// scripts/ci), and the runner hook, run by its loader as one file from main, keeps a copy of the classifier and the repair history.
test("required-tests failure rule: one protected module the gate imports; the companion's and the hook's copies equal it byte for byte", () => {
  const source = relative => fs.readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const classifier = text => text.match(/export const SETUP_STEPS[\s\S]*?\nexport function jobFailureKind[\s\S]*?\n\}/)?.[0];
  const history = text => text.match(/const REPAIR_GATE_JOB[\s\S]*?\nexport async function requiredTestsRepairHistory[\s\S]*?\n\}/)?.[0];
  const moduleSource = source("./required-tests-failure-rule.mjs");
  const hookSource = source("../runner/clued-runner-job-started.mjs");
  assert.equal(source("../../work/independent-ci-resident-v1/src/env-failure.mjs"), moduleSource, "the companion's copy is the module, byte for byte");
  assert.match(classifier(moduleSource), /kind: "timeout"/);
  assert.match(history(moduleSource), /hasRepairRecovery/);
  assert.match(history(moduleSource), /REPAIR_ATTEMPTS_MAX/);
  assert.equal(classifier(hookSource), classifier(moduleSource));
  assert.equal(history(hookSource), history(moduleSource));
  assert.equal(classifier(source("./clued-work-admission.mjs")), undefined, "the gate keeps no copy");
});

test("independent gate environment re-run: a network failure or a setup death of the one attempt that ran admits one re-run", async () => {
  const net = await repairGate([ranAttempt(1, [netFail, pass, pass])]);
  assert.deepEqual([net.outcome.admitted, net.outcome.verdict], [true, "ADMITTED"]);
  assert.deepEqual(net.outcome.repair_rerun, { attempt: 2, earlier_attempts: [{ attempt: 1, heavy_jobs: 3,
    environment_failure: ["clued-cloud-tests"], environment_failure_kinds: { "clued-cloud-tests": "network" } }] });
  assert.ok(net.extra.some((call) => /\/actions\/jobs\/101\/logs$/.test(call.url)), "the failed job's log was read");
  assert.ok([...net.calls, ...net.extra].every((call) => call.method === "GET" || call.url === EPOCH_URL), "read-only");
  // Setup death needs no log: the step record alone is the evidence.
  const setup = await repairGate([ranAttempt(1, [setupFail, setupFail, setupFail])]);
  assert.deepEqual([setup.outcome.admitted, setup.outcome.verdict, setup.extra.some((call) => /\/logs/.test(call.url))], [true, "ADMITTED", false]);
  // Several environment failures at once, the rest passed or skipped.
  assert.equal((await repairGate([ranAttempt(1, [netFail, setupFail, { conclusion: "skipped" }])])).outcome.admitted, true);
  // After a pending attempt, the attempt that did run may be repaired too (the heavy jobs ran once).
  assert.equal((await repairGate([earlierAttempt(1), ranAttempt(2, [netFail, pass, pass])])).outcome.admitted, true);
  // A gate job that died in the runner's setup ran nothing: no verdict annotation is needed (the RERUN_REFUSED of the setup death).
  const gateDied = earlierAttempt(1, { gateJobs: [attemptJob(100, "admission-gate", "failure", { steps: SETUP_DIED }), ...HEAVY_JOBS.map((name, index) => attemptJob(101 + index, name, "skipped"))], notes: [] });
  assert.deepEqual([(await repairGate([gateDied])).outcome.admitted], [true]);
  // Defect B: the runner's job-started hook refused the gate before any step (job 132831819306 of #1121): its "Set up runner" step,
  // right after "Set up job", failed. That ran nothing either.
  const hookRefused = [step("Set up job", "success"), step("Set up runner", "failure"),
    step("Run node scripts/ci/clued-work-admission.mjs --mode gate", "skipped"), step("Complete job", "success")];
  const refusedGate = earlierAttempt(1, { gateJobs: [attemptJob(100, "admission-gate", "failure", { steps: hookRefused }), ...HEAVY_JOBS.map((name, index) => attemptJob(101 + index, name, "skipped"))], notes: [] });
  assert.deepEqual([(await repairGate([refusedGate])).outcome.admitted], [true]);
  // A workflow step of that name, later in the job, is not the runner's setup.
  const named = [step("Set up job", "success"), step("Run tests", "success"), step("Set up runner", "failure")];
  const namedGate = earlierAttempt(1, { gateJobs: [attemptJob(100, "admission-gate", "failure", { steps: named }), ...HEAVY_JOBS.map((name, index) => attemptJob(101 + index, name, "skipped"))], notes: [] });
  assert.deepEqual([(await repairGate([namedGate])).outcome.verdict], ["RERUN_REFUSED"]);
});

test("independent gate environment re-run: a failed test, an unproven failure or an unproven recovery refuses", async () => {
  const refused = async (label, earlier, options, reason = /already ran/) => {
    const { outcome } = await repairGate(earlier, options);
    assert.deepEqual([label, outcome.admitted, outcome.verdict], [label, false, "RERUN_REFUSED"]);
    assert.match(outcome.reasons[0], reason, label);
  };
  await refused("a failed test, whatever else the log says", [ranAttempt(1, [{ conclusion: "failure", steps: TESTS_DIED, log: TEST_LOG }, pass, pass])]);
  await refused("a network failure and a failed test in one log", [ranAttempt(1, [{ conclusion: "failure", steps: TESTS_DIED, log: NET_LOG + "\n" + TEST_LOG }, pass, pass])]);
  await refused("an environment failure beside a failed test of another job", [ranAttempt(1, [netFail, { conclusion: "failure", steps: TESTS_DIED, log: TEST_LOG }, pass])]);
  await refused("a failure with no network signature", [ranAttempt(1, [{ conclusion: "failure", steps: TESTS_DIED, log: "##[error]lint failed" }, pass, pass])]);
  await refused("a failure whose steps are not recorded", [ranAttempt(1, [{ conclusion: "failure", log: NET_LOG }, pass, pass])]);
  await refused("a failure after the setup step passed is not a setup death", [ranAttempt(1, [{ conclusion: "failure", steps: TESTS_DIED, log: "" }, pass, pass])]);
  await refused("a cancelled job", [ranAttempt(1, [netFail, { conclusion: "cancelled", steps: TESTS_DIED, log: NET_LOG }, pass])]);
  await refused("a timed-out job", [ranAttempt(1, [{ conclusion: "timed_out", steps: TESTS_DIED, log: NET_LOG }, pass, pass])]);
  await refused("all green", [ranAttempt(1, [pass, pass, pass])]);
  await refused("a gate job that did not succeed", [ranAttempt(1, [netFail, pass, pass], { gate: attemptJob(100, "admission-gate", "failure", { steps: TESTS_DIED }) })]);
  await refused("a log that cannot be read", [ranAttempt(1, [netFail, pass, pass])], { listStatus: { logs: 500 } }, /earlier attempts could not be read/);
  await refused("a log that is gone", [ranAttempt(1, [netFail, pass, pass])], { listStatus: { logs: 404 } }, /earlier attempts could not be read/);
  await refused("a second environment failure without recovery evidence", [ranAttempt(1, [netFail, pass, pass]), ranAttempt(2, [netFail, pass, pass])], {}, /recovery evidence/);
  await refused("a ran attempt that passed, then an environment failure", [ranAttempt(1, [pass, pass, pass]), ranAttempt(2, [netFail, pass, pass])], {}, /attempt 1 already ran/);
});

test("independent gate repair re-run: anything the earlier attempts do not prove refuses", async () => {
  const cases = [
    ["no annotation (admitted, heavy jobs skipped for another reason)", { earlier: [earlierAttempt(1, { notes: [] })], reason: /did not end in ADMISSION_PENDING/ }],
    ["a different verdict", { earlier: [earlierAttempt(1, { notes: [{ title: "admission-gate", message: "REJECTED: concluded failure" }] })], reason: /did not end in ADMISSION_PENDING/ }],
    ["another annotation title", { earlier: [earlierAttempt(1, { notes: [{ title: "other", message: pendingNote.message }] })], reason: /did not end in ADMISSION_PENDING/ }],
    ["no heavy job listed", { earlier: [earlierAttempt(1, { heavy: [] })], reason: /does not list one admission-gate job and its heavy jobs/ }],
    ["no gate job listed", { earlier: [earlierAttempt(1, { gateJobs: HEAVY_JOBS.map((name, index) => attemptJob(10 + index, name, "skipped")) })], reason: /does not list one admission-gate job/ }],
    ["two gate jobs", { earlier: [earlierAttempt(1, { extraJobs: [attemptJob(150, "admission-gate", "success")] })], reason: /does not list one admission-gate job/ }],
    ["a job of another head", { earlier: [earlierAttempt(1, { extraJobs: [attemptJob(160, "extra", "skipped", { head_sha: BASE })] })], reason: /another head/ }],
    ["a job list that cannot be read", { earlier: [earlierAttempt(1)], listStatus: { jobs: 403 }, reason: /earlier attempts could not be read \(GitHub API .*attempts\/1\/jobs.* returned 403\)/ }],
    ["annotations that cannot be read", { earlier: [earlierAttempt(1)], listStatus: { notes: 500 }, reason: /earlier attempts could not be read/ }],
    ["a run of another head", { earlier: [earlierAttempt(1)], selfRun: { head_sha: BASE }, reason: /is not attempt 2 of a run of/ }],
    ["a run whose attempt differs", { earlier: [earlierAttempt(1)], selfRun: { run_attempt: 3 }, reason: /is not attempt 2 of a run of/ }],
  ];
  for (const [label, { earlier, reason, ...options }] of cases) {
    const { outcome } = await repairGate(earlier, options);
    assert.deepEqual([label, outcome.admitted, outcome.verdict], [label, false, "RERUN_REFUSED"]);
    assert.match(outcome.reasons[0], reason, label);
  }
  // Without any readable history (the pre-existing re-run test): refused.
  const rerun = await independentGate([nativeCheck()], { envOverrides: { GITHUB_RUN_ATTEMPT: "2" },
    script: { [PULL]: { body: { state: "open", head: { sha: HEAD }, base: { ref: "main" } } } } });
  assert.deepEqual([rerun.outcome.admitted, rerun.outcome.verdict], [false, "RERUN_REFUSED"]);
});

test("independent gate repair re-run: an admission that has not settled or does not admit never reads the history and never admits", async () => {
  // Not settled: keeps waiting the whole limit, then ADMISSION_PENDING (a failed re-run, its heavy jobs stay skipped).
  for (const checks of [[], [nativeCheck({ status: "in_progress", conclusion: null })]]) {
    const { outcome, extra, slept } = await repairGate([earlierAttempt(1)], { checks });
    assert.deepEqual([outcome.admitted, outcome.verdict, extra, slept.reduce((sum, ms) => sum + ms, 0)], [false, "ADMISSION_PENDING", [], 600000]);
  }
  // Settled but failed, or not bound to this pull request: REJECTED without history reads.
  for (const checks of [[nativeCheck({ conclusion: "failure" })], [nativeCheck({ output: { summary: "Independent Native control check for o/r#453" } })]]) {
    const { outcome, extra } = await repairGate([earlierAttempt(1)], { checks });
    assert.deepEqual([outcome.admitted, outcome.verdict, extra], [false, "REJECTED", []]);
  }
  // The admission settles while the re-run waits: admitted by that re-run.
  let reads = 0;
  const late = (call) => {
    if (!call.url.includes("check_name=kooyumi-work-admission")) return { body: { check_runs: [] } };
    reads += 1;
    return { body: { check_runs: reads < 3 ? [] : [nativeCheck()] } };
  };
  const waited = await repairGate([earlierAttempt(1)], { script: { [CHECKS]: late } });
  assert.deepEqual([waited.outcome.admitted, waited.outcome.verdict, waited.slept], [true, "ADMITTED", [30000, 30000]]);
  // A stale execution epoch and a moved head still refuse the repair.
  const stale = await repairGate([earlierAttempt(1)], { script: { [VERIFY]: { body: { status: "ok", guard_required: true, epoch_current: false } } } });
  assert.deepEqual([stale.outcome.admitted, stale.outcome.reasons], [false, ["work_claim_execution_epoch_stale"]]);
  const moved = await repairGate([earlierAttempt(1)], { script: { [PULL]: { body: { state: "open", head: { sha: BASE }, base: { ref: "main" } } } } });
  assert.deepEqual([moved.outcome.admitted, moved.outcome.verdict], [false, "RERUN_REFUSED"]);
  assert.match(moved.outcome.reasons[0], /no longer the head of #452/);
  assert.deepEqual(moved.extra, []);
});

test("independent gate: the wait is configurable, lowered freely and raised up to the registered job's ceiling", async () => {
  assert.equal(INDEPENDENT_GATE_WAIT_CEILING_SECONDS, 780);
  assert.ok(INDEPENDENT_GATE_WAIT_CEILING_SECONDS + 60 <= 15 * 60, "the polling fits the gate job's 15-minute timeout with room for setup");
  const waitOf = async (value) => {
    const { slept, outcome } = await independentGate([], { envOverrides: value === undefined ? {} : { CLUED_ADMISSION_GATE_WAIT_SECONDS: value } });
    assert.equal(outcome.verdict, "ADMISSION_PENDING");
    return slept.reduce((sum, ms) => sum + ms, 0) / 1000;
  };
  assert.deepEqual([await waitOf(undefined), await waitOf("600"), await waitOf("300"), await waitOf("0")], [600, 600, 300, 0]);
  assert.deepEqual([await waitOf("700"), await waitOf("780"), await waitOf("3600"), await waitOf("-5"), await waitOf("abc")], [700, 780, 780, 600, 600]);
  // The default gate keeps its 180-second limit whatever the env says.
  const { fetchImpl } = fakeFetch(checksReturn([]));
  const slept = [];
  await gate({ env: env({ CLUED_ADMISSION_GATE_WAIT_SECONDS: "3600" }), event: event(), eventName: "pull_request", fetchImpl, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(slept.reduce((sum, ms) => sum + ms, 0), 180000);
});

// --- Bounded retry of the read-only GitHub API calls, and a gate that stopped on an API outage ran no heavy job.
const retryReply = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
function scriptedFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    const next = replies[Math.min(calls.length, replies.length) - 1];
    if (next instanceof Error) throw next;
    return typeof next === "number" ? retryReply(next) : next;
  };
  return { fetchImpl, calls };
}
const API = "https://api.test";

test("github read retry: 500/502/503/504 and network errors are retried with 1s, 2s pauses; everything else is final at once", async () => {
  assert.deepEqual([GITHUB_READ_RETRY_ATTEMPTS, GITHUB_READ_RETRY_STATUSES], [3, [500, 502, 503, 504]]);
  for (const status of GITHUB_READ_RETRY_STATUSES) {
    const { fetchImpl, calls } = scriptedFetch([status, status, 200]);
    const budget = { spentMs: 0 };
    const slept = [];
    const response = await withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API }, { sleep: async (ms) => { slept.push(ms); }, budget })(`${API}/repos/o/r/x`);
    assert.deepEqual([response.status, calls.length, slept, budget.spentMs], [200, 3, [1000, 2000], 3000], String(status));
  }
  // The attempts run out: the last answer is handed back for the caller's own error; a network failure becomes a named error.
  let { fetchImpl, calls } = scriptedFetch([502, 502, 502, 200]);
  assert.equal((await withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API }, { sleep: async () => {} })(`${API}/repos/o/r/x`)).status, 502);
  assert.equal(calls.length, 3);
  ({ fetchImpl, calls } = scriptedFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")]));
  await assert.rejects(withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API }, { sleep: async () => {} })(`${API}/repos/o/r/x?y=1`),
    /^Error: GitHub API \/repos\/o\/r\/x\?y=1 could not be reached after 3 attempts \(fetch failed\)$/);
  assert.equal(calls.length, 3);
  ({ fetchImpl, calls } = scriptedFetch([new TypeError("fetch failed"), 200]));
  assert.equal((await withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API }, { sleep: async () => {} })(`${API}/repos/o/r/x`)).status, 200);
  // 4xx (rate limit, permission, missing), 599 and success are never repeated.
  for (const status of [200, 304, 400, 401, 403, 404, 422, 429, 501, 599]) {
    ({ fetchImpl, calls } = scriptedFetch([status, 200]));
    const slept = [];
    assert.equal((await withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API }, { sleep: async (ms) => { slept.push(ms); } })(`${API}/repos/o/r/x`)).status, status);
    assert.deepEqual([calls.length, slept], [1, []], String(status));
  }
  // Only a GET to the GitHub API is repeated: writes and other hosts are not.
  ({ fetchImpl, calls } = scriptedFetch([502, 200]));
  const wrapped = withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API }, { sleep: async () => {} });
  assert.equal((await wrapped(`${API}/repos/o/r/x`, { method: "POST" })).status, 502);
  assert.equal((await wrapped(`${PUBLIC.url}/rest/v1/rpc/clued_work_verify_v1`, { method: "GET" })).status, 200);
  assert.equal(calls.length, 2);
  // Wrapping twice does not multiply the attempts; the pause scales with CLUED_GITHUB_RETRY_BASE_MS.
  ({ fetchImpl, calls } = scriptedFetch([502]));
  const slept = [];
  const once = withGithubReadRetry(fetchImpl, { GITHUB_API_URL: API, CLUED_GITHUB_RETRY_BASE_MS: "50" }, { sleep: async (ms) => { slept.push(ms); } });
  await withGithubReadRetry(once, { GITHUB_API_URL: API, CLUED_GITHUB_RETRY_BASE_MS: "50" }, { sleep: async (ms) => { slept.push(ms); } })(`${API}/repos/o/r/x`);
  assert.deepEqual([calls.length, slept], [3, [50, 100]]);
});

test("independent gate: a transient 502 is retried inside the wait budget; an outage that outlasts the retries is an ERROR", async () => {
  // One 502 on the first poll: retried after 1s, the admission settles, nothing else changes.
  let failed = false;
  const flaky = (call) => {
    if (!call.url.includes("check_name=kooyumi-work-admission")) return { body: { check_runs: [] } };
    if (!failed) { failed = true; return { status: 502, body: {} }; }
    return { body: { check_runs: [nativeCheck()] } };
  };
  let result = await independentGate(flaky);
  assert.deepEqual([result.outcome.admitted, result.outcome.verdict, result.slept], [true, "ADMITTED", [1000]]);
  // The pause counts into the wait: 1s of retry plus the polls still end at exactly 600s.
  failed = false;
  const flakyEmpty = (call) => {
    if (!call.url.includes("check_name=kooyumi-work-admission")) return { body: { check_runs: [] } };
    if (!failed) { failed = true; return { status: 503, body: {} }; }
    return { body: { check_runs: [] } };
  };
  result = await independentGate(flakyEmpty);
  assert.deepEqual([result.outcome.verdict, result.slept.reduce((sum, ms) => sum + ms, 0), result.slept[0]], ["ADMISSION_PENDING", 600000, 1000]);
  // A 4xx is never retried.
  let reads = 0;
  await assert.rejects(independentGate((call) => { if (call.url.includes("check_name=kooyumi-work-admission")) reads += 1; return { status: 429, body: {} }; }), /returned 429/);
  assert.equal(reads, 1);
  // The outage outlasts the three attempts: the gate throws (main reports ERROR).
  reads = 0;
  const outage = (call) => { if (call.url.includes("check_name=kooyumi-work-admission")) reads += 1; return { status: 502, body: {} }; };
  await assert.rejects(independentGate(outage), /^Error: GitHub API \/repos\/o\/r\/commits\/a{40}\/check-runs\?check_name=kooyumi-work-admission.* returned 502$/);
  assert.equal(reads, 3);
});

test("independent gate repair re-run: an attempt that ended in a GitHub API outage ran no heavy job and allows the one repair", async () => {
  // Run the real main() on attempt 1 with the API down for the whole retry, then feed its own annotation to the repair.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify(independentEvent()));
  const down = (status) => fakeFetch({ ...SELF_RUN, [CHECKS]: { status, body: {} } });
  const errors = [];
  const original = console.error;
  const originalLog = console.log;
  let code;
  try {
    console.error = (text) => { errors.push(String(text)); };
    console.log = () => {};
    code = await main(["--mode", "gate"], { ...env({ CLUED_ADMISSION_GATE_SOURCE: INDEPENDENT_GATE_SOURCE, CLUED_GITHUB_RETRY_BASE_MS: "0" }),
      GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: path.join(dir, "out"), GITHUB_STEP_SUMMARY: path.join(dir, "sum") }, down(502).fetchImpl);
  } finally { console.error = original; console.log = originalLog; }
  assert.equal(code, 1);
  assert.match(fs.readFileSync(path.join(dir, "out"), "utf8"), /^verdict=ERROR$/m);
  const annotation = /^::error title=([^:]+)::(.*)$/.exec(errors[0]);
  assert.deepEqual([annotation[1], annotation[2].endsWith("returned 502")], ["kooyumi-work-admission", true]);
  const outageNote = { title: annotation[1], message: annotation[2] };
  const repaired = await repairGate([earlierAttempt(1, { notes: [outageNote] })]);
  assert.deepEqual([repaired.outcome.admitted, repaired.outcome.verdict], [true, "ADMITTED"]);
  // An outage on the repair attempt itself, or an unreachable API, is the same: the next re-run is still the repair.
  const unreachable = { title: "kooyumi-work-admission", message: "GitHub API /repos/o/r/pulls/452 could not be reached after 3 attempts (fetch failed)" };
  const chain = await repairGate([earlierAttempt(1), earlierAttempt(2, { notes: [unreachable] })]);
  assert.deepEqual([chain.outcome.admitted, chain.outcome.verdict], [true, "ADMITTED"]);
  // Other errors prove nothing about the heavy jobs: a 4xx, a missing token, an error that is not an API outage, or an outage note
  // under another title refuses; so does an outage attempt that did run a heavy job.
  for (const [label, note, heavy] of [
    ["a 403", { title: "kooyumi-work-admission", message: "GitHub API /repos/o/r/commits/x/check-runs returned 403: the admission-gate job needs `checks: read`" }, undefined],
    ["a 404", { title: "kooyumi-work-admission", message: "GitHub API /repos/o/r/pulls/452 returned 404" }, undefined],
    ["a missing token", { title: "kooyumi-work-admission", message: "GITHUB_TOKEN is not set." }, undefined],
    ["a 5xx text in the middle", { title: "kooyumi-work-admission", message: "see: GitHub API /x returned 502" }, undefined],
    ["another title", { title: "other", message: annotation[2] }, undefined],
    ["a heavy job that ran", outageNote, ["skipped", "success", "skipped"]],
  ]) {
    const { outcome } = await repairGate([earlierAttempt(1, { notes: [note], ...(heavy ? { heavy } : {}) })]);
    assert.deepEqual([label, outcome.admitted, outcome.verdict], [label, false, "RERUN_REFUSED"]);
  }
});

test("independent gate: the clued-admission App check of this event never decides, even with its workflow running again", async () => {
  // Before FABLE-scaffold-open-qs 问题 1 改法 2 the legacy check decided when it settled first (the Owner's disaster-recovery switch).
  const { outcome } = await independentGate([appCheckRun()], { envOverrides: { CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" } });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_source], [false, "ADMISSION_PENDING", INDEPENDENT_GATE_SOURCE]);
  const failed = (await independentGate([appCheckRun({ conclusion: "failure" }), nativeCheck()])).outcome;
  assert.deepEqual([failed.admitted, failed.verdict], [true, "ADMITTED"]);
});

test("independent gate: the Source v2 native-work-admission id admits; malformed or foreign v2 ids refuse", async () => {
  const V2 = `independent-ci:native-work-admission:v2:${"6".repeat(64)}:a1:cd1dd735d:f3:e2`;
  assert.equal((await independentGate([nativeCheck({ external_id: V2 })])).outcome.admitted, true);
  assert.equal((await independentGate([nativeCheck({ external_id: V2.replace(":a1:", ":a2:") })])).outcome.admitted, true);
  for (const [label, externalId] of [
    ["attempt 3", V2.replace(":a1:", ":a3:")],
    ["no claim generation", `independent-ci:native-work-admission:v2:${"6".repeat(64)}:a1`],
    ["a short claim prefix", V2.replace(":cd1dd735d:", ":cd1dd73:")],
    ["an upper-case claim prefix", V2.replace(":cd1dd735d:", ":cD1DD735D:")],
    ["fence 0", V2.replace(":f3:", ":f0:")],
    ["v1 field order", `independent-ci:native-work-admission:v2:${"6".repeat(64)}:f3:e2:a1`],
    ["a trailing field", `${V2}:x`],
    ["a staged v2 id", `independent-ci:staged:v2:${"6".repeat(64)}:a1`],
    ["a control v2 id", `independent-ci:control:control-admission:v2:${"6".repeat(64)}:a1:cd1dd735d:f3:e2`],
    ["a v3 id", V2.replace(":v2:", ":v3:")],
  ]) {
    const { outcome } = await independentGate([nativeCheck({ external_id: externalId })]);
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, "REJECTED"], label);
  }
  // A well-formed v2 id from another App is never read.
  const { outcome } = await independentGate([nativeCheck({ external_id: V2, app: { id: 15368 } })], { envOverrides: { CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" } });
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
});


test('dispatch closed verdict preserves real Native fields without inventing missing authority',async()=>{
 const {closeNativeDispatchVerdict}=await import('./clued-work-admission.mjs');
 const request={scope:'project:0597aa60-9b98-4da6-a4ab-63d7705b632f',claim_id:'11111111-1111-4111-8111-111111111111',head_sha:'a'.repeat(40),repository:'tdoljyj/cross-memory-system',target_branch:'main',workflow:'clued-standard-runner-actor-qualification.yml'};
 const payload={verdict:'ADMITTED',execution_authorized:true,execution_epoch:7,execution_policy:'staged',head_authorization_id:null,claim:{task_id:'22222222-2222-4222-8222-222222222222',fence:8,status:'ACTIVE',expires_at:'2026-11-03T08:00:00.000Z'},secret:'must not project'};
 const result=closeNativeDispatchVerdict(payload,request);assert.equal(result.complete,true);assert.deepEqual(result.subject,request);
 assert.deepEqual(result.native,{verdict:'ADMITTED',execution_authorized:true,execution_epoch:7,execution_policy:'staged',head_authorization_id:null,task_id:payload.claim.task_id,fence:8,claim_status:'ACTIVE',expires_at:payload.claim.expires_at});
 assert.equal(JSON.stringify(result).includes('must not project'),false);
 for(const update of [p=>delete p.execution_epoch,p=>{p.execution_authorized='true';},p=>{p.claim.fence='8';},p=>delete p.claim,p=>{p.verdict='REJECTED';}]){
  const changed=structuredClone(payload);update(changed);assert.equal(closeNativeDispatchVerdict(changed,request).complete,false);
 }
 const missing=closeNativeDispatchVerdict({verdict:'ADMITTED'},request);assert.equal(missing.native.fence,null);assert.equal(missing.native.execution_epoch,null);assert.equal(missing.complete,false);
});


test('typed manual actor retains exact full Source/FullRole gate while generic PR gate versions stay frozen',async()=>{
 const text=fs.readFileSync(path.join(ROOT,ACTOR_WORKFLOW),'utf8');
 assert.equal(workflowIsGated(text),true);
 assert.equal(actorSourceTransition(ACTOR_WORKFLOW,text).passed,true);
 assert.deepEqual(gateFindings(text,text,{registeredActorTransition:true}),[]);
 assert.ok(gateFindings(text,text).length>0,'a caller without exact typed Source classification cannot silently use the PR template');
 for(const changed of [text.replace('checks: read','checks: write'),text.replace("github.actor_id == '52366662'","true"),text.replace('--mode gate','--mode other')]){
  assert.equal(actorSourceTransition(ACTOR_WORKFLOW,changed).passed,false);
  assert.ok(gateFindings(changed,text,{registeredActorTransition:true}).length>0,'boolean alone cannot self-register changed Source');
 }
});


test('trusted admission catalogue reader permits only the profile through 2 MiB and keeps role bounds',async()=>{
  const file='.github/workflows/gitleaks.yml',profilesUrl=new URL('./clued-gated-proof-profiles.json',import.meta.url),
    rolesUrl=new URL('./clued-gated-proof-role-specs.json',import.meta.url),raw=fs.readFileSync(profilesUrl),
    profiles=parseWorkflowProfiles(raw),legacy=Buffer.from(JSON.stringify(profiles)+'\n'),source=blob=>registeredWorkflowSource(profiles,file,blob).profile.source_yaml,
    before=source('ba4690650935961e7f4aa289a3aa0dc874b8b4fd'),after=source('6441fc32b084002de697415ea8343af07816c929'),
    originalStat=fs.lstatSync,originalRead=fs.readFileSync;
  assert.ok(raw.length<=2097152,'the actual catalogue fits the 2 MiB bound');
  const fetchImpl=async url=>{
    const address=new URL(url);assert.equal(address.pathname,`/repos/o/r/contents/${file}`);
    const text=address.searchParams.get('ref')===HEAD?after:before;
    return Response.json({type:'file',encoding:'base64',content:Buffer.from(text).toString('base64')});
  };
  const run=()=>workflowFindings(fetchImpl,env(),'o/r',[{filename:file,status:'modified'}],HEAD,BASE);
  for(const [size,roleTooLarge,allowed] of [[2097152,false,true],[2097153,false,false],[2097152,true,false]]) {
    const padded=Buffer.concat([legacy,Buffer.alloc(size-legacy.length,32)]);
    try {
      fs.lstatSync=function(location,...args){const value=originalStat.call(this,location,...args),href=String(location);
        if(href===String(profilesUrl)||roleTooLarge&&href===String(rolesUrl))return Object.assign(Object.create(value),{size:href===String(profilesUrl)?size:524289});
        return value;};
      fs.readFileSync=function(location,...args){return String(location)===String(profilesUrl)?padded:originalRead.call(this,location,...args);};
      const result=await run();
      assert.equal(result.gate.some(code=>code.includes('bootstrap_ordinary_Source_not_registered')),!allowed);
      if(allowed)assert.deepEqual(result.gate,[]);
    } finally {fs.lstatSync=originalStat;fs.readFileSync=originalRead;}
  }
});

test('G4 uses the registered required-tests Native gate without changing any execution route', async () => {
  const file = '.github/workflows/clued-g4-database.yml';
  const text = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const required = fs.readFileSync(new URL('../../.github/workflows/clued-required-tests.yml', import.meta.url), 'utf8');
  const gateJob = value => admissionModule.workflowJobs(value).find(job => job.name === 'admission-gate');
  assert.deepEqual(gateJob(text).lines, gateJob(required).lines);
  assert.equal(admissionModule.sha256Hex(gateJob(text).lines.join('\n')),
    '9c582144f424d1bc9ef7d3b048d3b7771c7b639ef5544bc04a8a80515c52b2f2');
  const profiles = parseWorkflowProfiles(fs.readFileSync(new URL('./clued-gated-proof-profiles.json', import.meta.url)));
  const before = registeredWorkflowSource(profiles, file, 'a09cfc44e506a9672e5221a7fa6737747ddcb787').profile.source_yaml;
  assert.deepEqual(admissionModule.workflowJobs(text).filter(job => job.name !== 'admission-gate'),
    admissionModule.workflowJobs(before).filter(job => job.name !== 'admission-gate'));
  assert.deepEqual(admissionModule.gateFindings(text, before), []);
  const { outcome } = await independentGate([nativeCheck()], { envOverrides: {
    GITHUB_WORKFLOW_REF: `o/r/${file}@refs/pull/452/merge`,
  } });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_source],
    [true, 'ADMITTED', INDEPENDENT_GATE_SOURCE]);
});

test('G4 all-jobs repair requires a current Native admission and every prior heavy job to have skipped', async () => {
  const file = '.github/workflows/clued-g4-database.yml';
  const jobs = admissionModule.workflowJobs(fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8'));
  const make = (n, notes = [pendingNote]) => earlierAttempt(n, { notes, gateJobs: jobs.map((job, i) => {
    const name = job.lines.find(line => /^    name: /.test(line))?.slice('    name: '.length) ?? job.name;
    return attemptJob(n * 100 + i, name, job.name === 'admission-gate' ? 'success' : 'skipped');
  }) });
  const envOverrides = { GITHUB_WORKFLOW_REF: `o/r/${file}@refs/pull/452/merge` };
  assert.equal((await repairGate([make(1)], { envOverrides })).outcome.admitted, true);
  for (const conclusion of ['success', 'failure', 'cancelled', 'neutral', null]) {
    const earlier = make(1); earlier.jobs[2].conclusion = conclusion;
    assert.equal((await repairGate([earlier], { envOverrides })).outcome.verdict, 'RERUN_REFUSED');
  }
  for (const verdict of ['NO_ADMISSION_RUN', 'REJECTED', 'UNKNOWN', 'NOT_APPLICABLE']) {
    const earlier = make(1, [{ title: 'admission-gate', message: `${verdict}: old or unqualified gate` }]);
    assert.equal((await repairGate([earlier], { envOverrides })).outcome.verdict, 'RERUN_REFUSED');
  }
  const gateOnly = make(1); gateOnly.jobs = gateOnly.jobs.filter(job => job.name === 'admission-gate');
  assert.equal((await repairGate([gateOnly], { envOverrides })).outcome.verdict, 'RERUN_REFUSED');
  const onceUsed = make(2); onceUsed.jobs[2].conclusion = 'success';
  assert.equal((await repairGate([make(1), onceUsed], { envOverrides })).outcome.verdict, 'RERUN_REFUSED');
  const oldHead = make(1); oldHead.jobs[2].head_sha = BASE;
  assert.equal((await repairGate([oldHead], { envOverrides })).outcome.verdict, 'RERUN_REFUSED');
  assert.equal((await repairGate([make(1)], { envOverrides, checks: [nativeCheck({ conclusion: 'failure' })] })).outcome.verdict, 'REJECTED');
});

// Native automation: exact signed main refresh and the preregistered G4 successor.
{
const {qualifyTrustedAutomationRoute,gate,AUTOMATION_BOT,INDEPENDENT_GATE_SOURCE,mainMergeExternalId}=admissionModule;
const repo='o/r',head='a'.repeat(40),base='b'.repeat(40),previous='c'.repeat(40),tree='d'.repeat(40);
const owner={id:123,login:'o',type:'User'},bot={...AUTOMATION_BOT};
const when='2026-11-17T07:00:00Z';
function fixture(){
 const pr={number:452,state:'open',user:owner,head:{sha:head,ref:'feature',repo:{full_name:repo}},base:{sha:base,ref:'main',repo:{full_name:repo,default_branch:'main'}}};
 const event={action:'synchronize',pull_request:pr};
 const run={id:9001,run_attempt:1,event:'pull_request',head_sha:head,head_branch:'feature',repository:{full_name:repo},head_repository:{full_name:repo},path:'.github/workflows/clued-required-tests.yml',actor:bot,triggering_actor:bot,created_at:'2026-11-17T07:01:00Z'};
 const env={GITHUB_REPOSITORY:repo,GITHUB_REPOSITORY_OWNER:'o',GITHUB_EVENT_NAME:'pull_request',GITHUB_ACTOR:bot.login,GITHUB_TRIGGERING_ACTOR:bot.login,GITHUB_RUN_ID:'9001',GITHUB_RUN_ATTEMPT:'1',GITHUB_REF:'refs/pull/452/merge',GITHUB_HEAD_REF:'feature',GITHUB_BASE_REF:'main',CLUED_ADMISSION_GATE_SOURCE:INDEPENDENT_GATE_SOURCE,CLUED_ADMISSION_GATE_WAIT_SECONDS:'0',GITHUB_API_URL:'https://api.test',GITHUB_TOKEN:'fixture',GITHUB_WORKSPACE:ROOT};
 // Resolve the original checkout without ambient credentials.
 env.GITHUB_WORKSPACE=ROOT;
 const check=(sha,id)=>({id,name:'kooyumi-work-admission',app:{id:5368905},head_sha:sha,status:'completed',conclusion:'success',completed_at:when,external_id:`independent-ci:native-work-admission:v2:${'e'.repeat(64)}:a1:ca3d3640e:f46:e1`,output:{summary:`Independent Native control check for ${repo}#452; observation sha256 ${'f'.repeat(64)}.`}});
 const current=check(head,50),prior=check(previous,40),attestation={id:60,name:'kooyumi-main-merge',app:{id:5164952},head_sha:head,status:'completed',conclusion:'success',external_id:mainMergeExternalId({pr:452,from:previous,main:base})};
 const commit={sha:head,parents:[{sha:previous},{sha:base}],author:bot,committer:{id:19864447,login:'web-flow',type:'User'},commit:{tree:{sha:tree},committer:{date:when},verification:{verified:true,reason:'valid',signature:'fixture-signature',payload:`tree ${tree}\nparent ${previous}\nparent ${base}\nfixture`}}};
 const f={env,event,run,currentAdmission:current,pr,current,prior,attestation,commit,currentChecks:[current],priorChecks:[prior],attestations:[attestation],epochReads:0,liveReads:0};
 f.read=async route=>{
  if(route===`/repos/${repo}`)return {full_name:repo,default_branch:'main',owner};
  if(route===`/repos/${repo}/pulls/452`){f.liveReads++;return f.liveOverride??pr;}
  if(route===`/repos/${repo}/branches/main`)return {name:'main',commit:{sha:f.mainTip??base}};
  if(route===`/repos/${repo}/commits/${head}`)return commit;
  if(route.includes('check_name=kooyumi-main-merge'))return {total_count:f.attestationTotal??f.attestations.length,check_runs:f.attestations};
  if(route.includes(`/commits/${previous}/check-runs`))return {total_count:f.priorTotal??f.priorChecks.length,check_runs:f.priorChecks};
  if(route.includes(`/commits/${head}/check-runs`))return {total_count:f.currentTotal??f.currentChecks.length,check_runs:f.currentChecks};
  if(route===`/repos/${repo}/actions/runs/9001`)return run;
  if(route===`/repos/${repo}/actions/runs/77`)return f.legacyOrigin;
  if(route===`/repos/${repo}/actions/runs/78`)return {...f.legacyOrigin,id:78,created_at:'2026-11-17T06:59:00Z'};
  if(route.includes('/actions/workflows/clued-work-admission.yml/runs'))return {workflow_runs:[]};
  throw new Error(`unscripted ${route}`);
 };
 f.fetchImpl=async(url,init={})=>{
  let body;
  if(init.method==='POST') {f.epochReads++;body={status:'ok',guard_required:true,epoch_current:!(f.staleSecondEpoch&&f.epochReads>1)};}
  else body=await f.read(String(url).replace('https://api.test',''));
  return {ok:true,status:200,headers:{get:()=>null},json:async()=>body,text:async()=>JSON.stringify(body)};
 };
 return f;
}
test('Native signed main refresh qualifies only through current Native and main-only attestation',async()=>{
 const f=fixture(),r=await qualifyTrustedAutomationRoute(f);assert.equal(r.qualified,true);assert.equal(r.prior_admission_run_id,null);assert.equal(r.current_check_id,50);
});
const denials=[
 ['foreign actor',f=>f.run.actor={...bot,id:1}],['actor name only',f=>f.env.GITHUB_ACTOR='other[bot]'],
 ['non-synchronize event',f=>f.event.action='opened'],['fork',f=>f.pr.head.repo.full_name='fork/r'],
 ['wrong Native App',f=>f.current.app.id=5164952],['unbound current id',f=>f.current.external_id='pr:452:run:77'],
 ['wrong PR',f=>f.current.output.summary='o/r#453'],['mixed PRs',f=>f.current.output.summary='o/r#452 o/r#453'],
 ['failed admission',f=>f.current.conclusion='failure'],['old head',f=>f.current.head_sha=previous],
 ['moved main',f=>f.mainTip=previous],['missing signature',f=>f.commit.commit.verification.verified=false],
 ['different signed tree',f=>f.commit.commit.verification.payload='tree wrong'],['wrong parent',f=>f.commit.parents[1].sha=previous],
 ['wrong platform committer',f=>f.commit.committer.id=1],['wrong native-run head',f=>f.run.head_sha=previous],
 ['missing prior proof',f=>f.priorChecks=[]],['late prior proof',f=>f.prior.completed_at='2026-11-17T07:02:00Z'],
 ['prior proof wrong App',f=>f.prior.app.id=1],['missing attestation',f=>f.attestations=[]],
 ['attestation wrong App',f=>f.attestation.app.id=5368905],['attestation wrong PR',f=>f.attestation.external_id=mainMergeExternalId({pr:453,from:previous,main:base})],
 ['newer attestation failure',f=>f.attestations.push({...f.attestation,id:61,conclusion:'failure'})],
 ['newer malformed current proof',f=>f.currentChecks.push({...f.current,id:51,external_id:'wrong'})],
 ['truncated checks',f=>f.currentTotal=100],['changed live PR',f=>f.liveOverride={...f.pr,state:'closed'}],
 ['unsupported retry actor',f=>{f.run.triggering_actor={id:456,login:'other',type:'User'};f.env.GITHUB_TRIGGERING_ACTOR='other';}],
];
for(const [label,change]of denials)test(`Native automation refuses ${label}`,async()=>{const f=fixture();change(f);assert.equal((await qualifyTrustedAutomationRoute(f)).qualified,false);});
test('independent gate wires the exact event through route and rechecks execution epoch',async()=>{
 const f=fixture();const r=await gate({...f,eventName:'pull_request'});assert.deepEqual([r.admitted,r.automation_self_hosted],[true,true]);assert.equal(f.epochReads,2);
 const stale=fixture();stale.staleSecondEpoch=true;const refused=await gate({...stale,eventName:'pull_request'});assert.equal(refused.admitted,false);assert.equal(refused.automation_self_hosted,false);assert.deepEqual(refused.reasons,['work_claim_execution_epoch_stale']);
});
test('Native proof cannot qualify through an undeclared source',async()=>{
 const f=fixture();delete f.env.CLUED_ADMISSION_GATE_SOURCE;assert.equal((await qualifyTrustedAutomationRoute(f)).qualified,false);
});
function legacyFixture(){
 const f=fixture();
 for(const c of [f.current,f.prior])Object.assign(c,{name:'kooyumi-admission-verified',app:{id:5164952,slug:'clued-admission'},external_id:'pr:452:run:77',output:{title:'normal · code · reruns 1'}});
 f.prior.external_id='pr:452:run:78';
 f.legacyOrigin={id:77,event:'pull_request_target',path:'.github/workflows/clued-work-admission.yml',status:'completed',conclusion:'success',repository:{full_name:repo},head_repository:{full_name:repo},created_at:'2026-11-17T06:59:00Z',actor:owner};
 return f;
}
test('Legacy proof remains valid with Native source configured during disaster recovery',async()=>{
 const f=legacyFixture();assert.equal((await qualifyTrustedAutomationRoute(f)).qualified,true);
 delete f.env.CLUED_ADMISSION_GATE_SOURCE;assert.equal((await qualifyTrustedAutomationRoute(f)).qualified,true);
});
test('Native-source gate does not take a settled legacy check (scaffold open-qs 1.2): without Native it waits, and admits nothing',async()=>{
 const f=legacyFixture(),read=f.read;
 f.legacyOrigin.created_at='2026-11-17T07:01:00Z';
 f.read=async route=>{
  if(route.includes('check_name=kooyumi-work-admission'))return {total_count:0,check_runs:[]};
  if(route.includes('/actions/workflows/clued-work-admission.yml/runs'))return {workflow_runs:[f.legacyOrigin]};
  return read(route);
 };
 const r=await gate({...f,eventName:'pull_request'});assert.deepEqual([r.admitted,r.verdict,r.automation_self_hosted],[false,'ADMISSION_PENDING',false],JSON.stringify(r));assert.equal(f.epochReads,0);
});


}

// Main push tree reuse (FABLE-main-push-tree-reuse §2.2, §5 T1/T1w/T2): a merge whose tree equals the PR
// head's tree, with main's old tip an ancestor of that head, reuses the head's passing required-test run.
// The fixture is #1178's real GitHub replies (scripts/ci/fixtures/main-push-tree-reuse-1178.json).
const TREE_REUSE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/fixtures/main-push-tree-reuse-1178.json'), 'utf8'));
// #1202's real GitHub replies: its head is the executor bot's merge of main, so the bot triggered the head's runs.
const TREE_REUSE_1202 = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/fixtures/main-push-tree-reuse-1202.json'), 'utf8'));
// Both recordings predate R1 (the three scans joined clued-required-tests.yml afterwards): the head's run carries them
// here as a run does now, each a passing job of that run and attempt; the run as recorded is refused (test below).
const R1_SCANS = ['gitleaks', 'trivy', 'contract-placement'];
function withScans(jobs) {
  const model = jobs.jobs.find((job) => job.name === 'clued-cloud-tests');
  jobs.jobs.push(...R1_SCANS.map((name, i) => ({ ...model, id: model.id + 1000 + i, name })));
  jobs.total_count += R1_SCANS.length;
}
function treeReuseCase(workflow, mutate = () => {}, fixture = TREE_REUSE, { scans = true } = {}) {
  const f = structuredClone(fixture);
  const w = f.workflows[workflow];
  if (scans && workflow === 'clued-required-tests.yml') withScans(w.jobs);
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: f.merge.sha, GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: String(w.push_run.id), GITHUB_ACTOR: w.push_run.actor.login, GITHUB_REPOSITORY_OWNER: f.owner,
    GITHUB_REPOSITORY: f.repository, GITHUB_TOKEN: 'test-only-placeholder',
    GITHUB_WORKFLOW_REF: `${f.repository}/.github/workflows/${workflow}@refs/heads/main` };
  const routes = {};
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    const body = typeof route === 'function' ? route() : route;
    if (body instanceof Error) throw body;
    if (body === undefined || body?.status >= 400) return { ok: false, status: body?.status ?? 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  const ctx = { f, w, env, routes, calls, fetchImpl, event: { ref: env.GITHUB_REF, after: f.merge.sha } };
  const api = `https://api.github.com/repos/${f.repository}`;
  const head = f.pr.head.sha;
  ctx.runsRoute = `${api}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${head}&per_page=100`;
  // Routes read the (possibly mutated) fixture objects at call time.
  Object.assign(routes, {
    [`${api}/commits/${f.merge.sha}`]: f.merge,
    [`${api}/commits/${f.merge.sha}/pulls?per_page=100`]: () => f.pulls,
    [`${api}/pulls/${f.pr.number}`]: f.pr,
    [`${api}/commits/${head}`]: f.source,
    [ctx.runsRoute]: () => w.runs,
    [`${api}/actions/runs/${w.runs.workflow_runs[0].id}/attempts/${w.runs.workflow_runs[0].run_attempt}/jobs?per_page=100`]: w.jobs,
    [`${api}/compare/${f.merge.parents[0].sha}...${head}`]: f.compare,
  });
  mutate(ctx);
  return ctx;
}
const treeReuseGate = (ctx) => admissionModule.gate({ env: ctx.env, event: ctx.event, eventName: ctx.env.GITHUB_EVENT_NAME,
  fetchImpl: ctx.fetchImpl, sleep: async () => {} });

for (const [label, workflow] of [['T1 Linux', 'clued-required-tests.yml'], ['T1w Windows', 'clued-required-tests-windows.yml']]) {
  test(`${label}: #1178's main push is not run again; the head's passing run of the same tree decides`, async () => {
    const ctx = treeReuseCase(workflow);
    const outcome = await treeReuseGate(ctx);
    const source = ctx.w.runs.workflow_runs[0];
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, 'TREE_ALREADY_TESTED'], JSON.stringify(outcome));
    const why = outcome.reasons.join(' ');
    assert.match(why, new RegExp(`run ${source.id} attempt 1`));
    assert.match(why, /PR #1178/);
    assert.match(why, new RegExp(TREE_REUSE.merge.commit.tree.sha));
    assert.equal(outcome.tree_reuse.qualification, 'PR_EVIDENCE_ONLY');
    assert.equal(outcome.tree_reuse.current_sha_pass, false);
  });
}

test('T1 Linux: a head run from before the scans joined the required workflow is not reused; the heavy jobs run', async () => {
  for (const fixture of [TREE_REUSE, TREE_REUSE_1202]) {
    const outcome = await treeReuseGate(treeReuseCase('clued-required-tests.yml', undefined, fixture, { scans: false }));
    assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], JSON.stringify(outcome));
    assert.ok(outcome.notices.includes('main push tree reuse: required_jobs_not_passed; the heavy jobs run'), JSON.stringify(outcome));
  }
});

test('T1: the gate step of #1178 main push exits 0 with admitted=false, so the heavy jobs are skipped', async () => {
  const ctx = treeReuseCase('clued-required-tests.yml');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-reuse-'));
  try {
    const eventPath = path.join(dir, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify(ctx.event));
    const code = await mainWith(['--mode', 'gate'], { ...ctx.env, GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary') }, ctx.fetchImpl);
    assert.equal(code, 0);
    const out = fs.readFileSync(path.join(dir, 'out'), 'utf8');
    assert.match(out, /^admitted=false$/m);
    assert.match(out, /^verdict=TREE_ALREADY_TESTED$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// R1 (FABLE-tree-reuse-close-out §1): a head run the executor bot triggered is same-tree evidence for the two
// required-test workflows. The heavy jobs carry their real names only after the gate proved the bot's signed merge
// of main, and the reuse requires those names, so no trust is added.
for (const [label, workflow, sourceRun] of [['R1 Linux', 'clued-required-tests.yml', 44757766226],
  ['R1w Windows', 'clued-required-tests-windows.yml', 44757766314]]) {
  test(`${label}: #1202's main push is not run again; the head's run that the executor bot triggered decides`, async () => {
    const ctx = treeReuseCase(workflow, undefined, TREE_REUSE_1202);
    assert.deepEqual(ctx.w.runs.workflow_runs[0].actor, { login: 'clued-admission[bot]', id: 337003645, type: 'Bot' });
    const outcome = await treeReuseGate(ctx);
    assert.deepEqual([outcome.admitted, outcome.verdict], [false, 'TREE_ALREADY_TESTED'], JSON.stringify(outcome));
    const why = outcome.reasons.join(' ');
    assert.match(why, new RegExp(`run ${sourceRun} attempt 1`));
    assert.match(why, /PR #1202/);
    assert.match(why, /tree a92406746d0a/);
    assert.equal(outcome.tree_reuse.qualification, 'PR_EVIDENCE_ONLY');
  });
}

test('R1: the gate step of #1202 main push exits 0 with admitted=false, so the heavy jobs are skipped', async () => {
  const ctx = treeReuseCase('clued-required-tests.yml', undefined, TREE_REUSE_1202);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-reuse-'));
  try {
    const eventPath = path.join(dir, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify(ctx.event));
    const code = await mainWith(['--mode', 'gate'], { ...ctx.env, GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary') }, ctx.fetchImpl);
    assert.equal(code, 0);
    const out = fs.readFileSync(path.join(dir, 'out'), 'utf8');
    assert.match(out, /^admitted=false$/m);
    assert.match(out, /^verdict=TREE_ALREADY_TESTED$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// R1 guards: green before and after the fix. Only the exact executor identity counts, and only a run whose heavy
// jobs carry their real names (a bot run the gate did not prove gets "-skipped" names).
for (const [label, mutate] of [
  ['another bot id', (c) => { c.w.runs.workflow_runs[0].actor.id = 337003646; }],
  ['the executor login on a User account', (c) => { c.w.runs.workflow_runs[0].actor.type = 'User'; }],
  ['another bot login', (c) => { c.w.runs.workflow_runs[0].actor.login = 'someone[bot]'; }],
  ['a heavy job under its "-skipped" name', (c) => { const job = c.w.jobs.jobs.at(-1); job.name += '-skipped'; job.conclusion = 'skipped'; }],
  ['a heavy job under its "-skipped" name that reports success', (c) => { c.w.jobs.jobs.at(-1).name += '-skipped'; }],
]) {
  for (const workflow of ['clued-required-tests.yml', 'clued-required-tests-windows.yml']) {
    test(`R1 guard (${workflow}, #1202): ${label} -> the heavy jobs run`, async () => {
      const outcome = await treeReuseGate(treeReuseCase(workflow, mutate, TREE_REUSE_1202));
      assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], JSON.stringify(outcome));
    });
  }
}

// R2 (FABLE-tree-reuse-close-out §2, §12.1): no workflow runs once on the PR and again on the main push of its merge
// unless the reuse table covers it. Read off the trigger block of every workflow file; no list of names.
function workflowTriggers(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^(on|'on'|"on"):/.test(line));
  assert.ok(start >= 0, 'the workflow has an on: block');
  // A spelling this reading does not know is refused, never read as "no push": R2 is the only stop.
  const unread = (why) => assert.fail(`cannot read the trigger block (${why}): write it as block YAML with two-space keys, or teach workflowTriggers this spelling`);
  const inline = lines[start].replace(/^[^:]+:/, '').replace(/\s+#.*$/, '').trim();
  if (inline.includes('{')) unread('flow mapping after on:');
  // `on: push` or `on: [push, pull_request]`: no filter, so a push trigger hits main.
  if (inline) {
    const names = inline.replace(/[[\]'"]/g, '').split(',').map((name) => name.trim());
    if (!names.length || names.some((name) => !/^[A-Za-z_]+$/.test(name))) unread(`on: ${inline}`);
    return { names, pushHitsMain: names.includes('push') };
  }
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === '' || /^#/.test(lines[end]))) end += 1;
  const block = lines.slice(start + 1, end);
  for (const line of block) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    // Every trigger key sits at exactly two spaces and is a bare name; nothing under on: is a flow mapping.
    if (/^ {0,2}\S/.test(line) && !/^  [A-Za-z_]+:/.test(line)) unread(`trigger key ${JSON.stringify(line)}`);
    if (/^\s*[^\s#][^#]*:\s*\{/.test(line)) unread(`flow mapping ${JSON.stringify(line)}`);
  }
  const names = block.filter((line) => /^  [A-Za-z_]+:/.test(line)).map((line) => line.trim().replace(/:.*/, ''));
  if (!names.length) unread('no trigger name');
  const at = block.findIndex((line) => /^  push:/.test(line));
  if (at < 0) return { names, pushHitsMain: false };
  let stop = at + 1;
  while (stop < block.length && !/^  [A-Za-z_]+:/.test(block[stop])) stop += 1;
  const push = block.slice(at + 1, stop);
  const listOf = (key) => {
    const index = push.findIndex((line) => new RegExp(`^    ${key}:`).test(line));
    if (index < 0) return null;
    const rest = push[index].replace(/^[^:]+:/, '').trim();
    if (rest) return rest.replace(/[[\]'"]/g, '').split(',').map((item) => item.trim());
    const items = [];
    for (let i = index + 1; i < push.length && /^      - /.test(push[i]); i += 1) items.push(push[i].replace(/^      - /, '').replace(/['"]/g, '').trim());
    return items;
  };
  const branches = listOf('branches');
  // Tags only: no branch push triggers it. Otherwise it hits main unless every branch pattern plainly cannot.
  const pushHitsMain = branches === null ? listOf('tags') === null && listOf('tags-ignore') === null
    : branches.some((branch) => branch === 'main' || branch.includes('*'));
  return { names, pushHitsMain };
}

test('R2: a workflow with a PR trigger and a main push trigger is in the reuse table; only Sources the gate holds byte-frozen are exempt, and never more of them', async () => {
  const { TARGETS } = await import('./clued-tree-reuse.mjs');
  const dir = path.join(ROOT, '.github/workflows');
  const both = fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort().filter((file) => {
    const { names, pushHitsMain } = workflowTriggers(fs.readFileSync(path.join(dir, file), 'utf8'));
    return pushHitsMain && (names.includes('pull_request') || names.includes('pull_request_target'));
  });
  // The reading finds every workflow of the table, so it is not blind.
  for (const workflow of Object.keys(TARGETS)) assert.ok(both.includes(workflow), `${workflow} has both triggers`);
  const outside = both.filter((file) => !Object.hasOwn(TARGETS, file));
  // The only exemption is the gate's own word that the file's bytes are frozen (changing it takes a registered
  // successor on trusted main first): its bootstrap ordinary Sources and its placement Source. No file name here.
  const frozen = (file) => admissionModule.bootstrapOrdinaryKnownFile(`.github/workflows/${file}`) ||
    `.github/workflows/${file}` === admissionModule.PLACEMENT_WORKFLOW;
  assert.deepEqual(outside.filter((file) => !frozen(file)), [],
    'these run on the PR and again on the main push of its merge: drop `push: main` or enter the reuse table');
  // 5 on 2026-11-21 (two scans, placement, two public MCP), each waiting for its registered successor. This number
  // only goes down, and the test holds that: it is an equality, so each one done lowers it here in the same change
  // (and one more is red at once). Delete the exemption at 0.
  assert.equal(outside.filter(frozen).length, 5, `byte-frozen workflows still running on main push: ${outside.filter(frozen).join(', ')}`);
});

test('R2: the trigger reading refuses a spelling it cannot read instead of reading no push out of it', () => {
  // R2 is the only stop, so an unread trigger block must be red, never "no push here".
  for (const [name, text] of [
    ['flow mapping', 'name: x\non: {push: {branches: [main]}, pull_request: {}}\njobs:\n'],
    ['flow mapping under a trigger', 'name: x\non:\n  pull_request:\n  push: {branches: [main]}\njobs:\n'],
    ['four-space indent', 'name: x\non:\n    pull_request:\n    push:\n        branches: [main]\njobs:\n'],
    ['quoted trigger name', 'name: x\non:\n  pull_request:\n  "push":\n    branches: [main]\njobs:\n'],
    ['empty block', 'name: x\non:\njobs:\n'],
  ]) assert.throws(() => workflowTriggers(text), /cannot read the trigger block/, name);
  // What it does read stays read.
  assert.deepEqual(workflowTriggers('on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n'), { names: ['pull_request', 'push'], pushHitsMain: true });
  assert.deepEqual(workflowTriggers('on: [push, pull_request]\njobs:\n'), { names: ['push', 'pull_request'], pushHitsMain: true });
});

// R2b (FABLE-tree-reuse-registry B): a counted CI workflow whose bytes at this head are not a registered Source makes
// the merge slot and the merge executor wait for ever on every head that carries it. The set is the merge slot's own
// (ciWorkflows); no list of names. The YAML-parsing check of the entries stays in ci-proof-profiles.test.mjs.
test('R2b: every counted CI workflow is a registered Source at this head', async () => {
  const { ciWorkflows } = await import('./clued-merge-slot-ci.mjs');
  const { recognizeCatalogueWorkflow } = await import('./clued-source-only-workflow.mjs');
  const registry = parseWorkflowProfiles(fs.readFileSync(path.join(ROOT, 'scripts/ci/clued-gated-proof-profiles.json'), 'utf8'));
  const roleSpecs = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/clued-gated-proof-role-specs.json'), 'utf8'));
  const counted = [...ciWorkflows(ROOT)];
  assert.ok(counted.length > 0, 'the merge slot counts at least one workflow');
  const unknown = counted.filter(([file, blob]) => recognizeCatalogueWorkflow({ registry, roleSpecs, file, blob }).source_identified !== true)
    .map(([file, blob]) => `${file} (${blob})`);
  assert.deepEqual(unknown, [],
    'the bytes of these counted workflows are not a registered Source: register the new Source and its roles in ' +
    'clued-gated-proof-profiles.json and clued-gated-proof-role-specs.json, then run merge-admission-r9-reregister.mjs --write');
});

test('T2: every required job of every gate-decided workflow of the reuse table is in the table, and so is every Actions-bound required check', async () => {
  const { TARGETS } = await import('./clued-tree-reuse.mjs');
  const covered = new Set();
  // Every 'ancestry' entry, not two names: a workflow entered in the table without the gate's job names is red here.
  const ancestry = Object.keys(TARGETS).filter((workflow) => TARGETS[workflow].proof === 'ancestry');
  assert.ok(ancestry.includes('clued-required-tests.yml') && ancestry.includes('clued-required-tests-windows.yml'));
  for (const workflow of ancestry) {
    const target = TARGETS[workflow];
    const text = fs.readFileSync(path.join(ROOT, '.github/workflows', workflow), 'utf8');
    const jobs = workflowJobs(text).map((job) => job.name).filter((name) => name !== 'admission-gate');
    assert.deepEqual([...target.jobs].sort(), [...jobs].sort(), `${workflow}: jobs and table agree`);
    // The required name is the job id, or <id>-skipped when the job does not run.
    for (const job of jobs) assert.ok(text.includes(`&& '${job}' || '${job}-skipped'`), `${workflow}: ${job} carries its required name`);
    for (const job of target.jobs) covered.add(job);
  }
  // The main ruleset's required checks as recorded with the fixture (rules/branches/main, 2026-11-19).
  const actionsBound = TREE_REUSE.required_checks.filter((check) => check.integration_id === 15368).map((check) => check.context);
  assert.ok(actionsBound.length >= 4);
  for (const check of actionsBound) assert.ok(covered.has(check), `required check ${check} is covered`);
});

// Guards: each one must still run the heavy jobs.
// R3a (FABLE-tree-reuse-close-out §3): and the gate's notice says why, with exactly the code in the third column.
const reuseNotice = (code) => `main push tree reuse: ${code}; the heavy jobs run`;
const reuseNotices = (outcome) => outcome.notices.filter((notice) => notice.startsWith('main push tree reuse:'));
const STILL_RUNS = [
  ['the merge tree differs from the head tree', (c) => { c.f.source.commit.tree.sha = 'f'.repeat(40); }, 'merged_tree_differs'],
  ['main\'s old tip is not an ancestor of the head', (c) => { Object.assign(c.f.compare, { status: 'diverged', behind_by: 1 }); }, 'base_not_ancestor'],
  ['the compare names another base', (c) => { c.f.compare.base_commit.sha = 'e'.repeat(40); }, 'base_not_ancestor'],
  ['a required job is missing', (c) => { c.w.jobs.jobs.pop(); c.w.jobs.total_count -= 1; }, 'required_jobs_not_passed'],
  ['a required job failed', (c) => { c.w.jobs.jobs.at(-1).conclusion = 'failure'; }, 'required_jobs_not_passed'],
  ['a required job was skipped', (c) => { const job = c.w.jobs.jobs.at(-1); job.name += '-skipped'; job.conclusion = 'skipped'; }, 'required_jobs_not_passed'],
  ['the gate job did not pass', (c) => { c.w.jobs.jobs[0].conclusion = 'skipped'; }, 'required_jobs_not_passed'],
  ['the run has a job the table does not know', (c) => { c.w.jobs.jobs.push({ ...c.w.jobs.jobs.at(-1), id: 1, name: 'new-required-job' }); c.w.jobs.total_count += 1; }, 'required_jobs_not_passed'],
  ['the latest run is still running', (c) => { Object.assign(c.w.runs.workflow_runs[0], { status: 'in_progress', conclusion: null }); }, 'pr_run_not_passed'],
  ['the latest run failed', (c) => { c.w.runs.workflow_runs[0].conclusion = 'failure'; }, 'pr_run_not_passed'],
  ['a newer run of the head exists', (c) => { c.w.runs.workflow_runs.push({ ...c.w.runs.workflow_runs[0], id: 1, run_number: 99999, conclusion: 'failure' }); c.w.runs.total_count += 1; }, 'pr_run_not_passed'],
  ['the run changed while the proof was read', (c) => { let reads = 0; const runs = c.w.runs;
    c.routes[c.runsRoute] = () => (++reads === 1 ? runs : { ...runs, workflow_runs: [{ ...runs.workflow_runs[0], run_attempt: 2, status: 'in_progress', conclusion: null }] }); }, 'latest_attempt_changed'],
  ['the PR author is not the owner', (c) => { c.f.pr.user.login = 'someone'; }, 'merged_pr_identity'],
  ['the run was triggered by someone else', (c) => { c.w.runs.workflow_runs[0].actor.login = 'someone'; }, 'pr_run_actor'],
  ['the pusher is not the owner or the executor', (c) => { c.env.GITHUB_ACTOR = 'someone'; }, 'push_context_not_eligible'],
  ['a direct push has no merged PR', (c) => { c.f.pulls = []; }, 'merged_pr_missing'],
  ['the PR came from a fork', (c) => { c.f.pr.head.repo.full_name = 'someone/fork'; }, 'merged_pr_identity'],
  ['the run listing is at its limit', (c) => { c.w.runs.total_count = 100; }, 'run_listing_incomplete'],
  ['the job listing is at its limit', (c) => { c.w.jobs.total_count = 100; }, 'job_listing_incomplete'],
  ['the merge reply names another commit', (c) => { c.f.merge.sha = 'd'.repeat(40); }, 'merge_identity'],
  ['the PR listing of the merge is at its limit', (c) => { c.f.pulls = Array.from({ length: 100 }, () => c.f.pulls[0]); }, 'pr_listing_incomplete'],
  ['the head run is another workflow\'s', (c) => { c.w.runs.workflow_runs[0].path = '.github/workflows/other.yml'; }, 'pr_run_identity'],
  ['the head run is not a pull_request run', (c) => { c.w.runs.workflow_runs[0].event = 'push'; }, 'pr_run_identity'],
  ['the run listing is at its limit when read again', (c) => { let reads = 0; const runs = c.w.runs;
    c.routes[c.runsRoute] = () => (++reads === 1 ? runs : { ...runs, total_count: 100 }); }, 'latest_run_listing_incomplete'],
];
for (const [label, mutate, code] of STILL_RUNS) {
  for (const workflow of ['clued-required-tests.yml', 'clued-required-tests-windows.yml']) {
    test(`tree reuse guard (${workflow}): ${label} -> the heavy jobs run, reason ${code}`, async () => {
      const outcome = await treeReuseGate(treeReuseCase(workflow, mutate));
      assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], JSON.stringify(outcome));
      assert.deepEqual(reuseNotices(outcome), [reuseNotice(code)]);
    });
  }
}

// R3b: a read that failed or threw names its step (and the HTTP status), never the error text.
const READ_STEPS = ['merge', 'pulls', 'pr', 'source', 'runs', 'jobs', 'compare'];
const READ_FAILURES = [
  [() => ({ status: 500 }), (step) => `github_request_failed@${step}:500`],
  [() => ({ status: 404 }), (step) => `github_request_failed@${step}:404`],
  [() => new Error('offline https://api.github.com/x?token=must-not-leak'), (step) => `github_request_threw@${step}`],
];
test('R3b: every failed or thrown GitHub read runs the heavy jobs and names its step and status', async () => {
  const keys = Object.keys(treeReuseCase('clued-required-tests.yml').routes);
  assert.equal(keys.length, READ_STEPS.length);
  for (const [index, key] of keys.entries()) {
    for (const [failure, code] of READ_FAILURES) {
      const ctx = treeReuseCase('clued-required-tests.yml');
      ctx.routes[key] = failure();
      const outcome = await treeReuseGate(ctx);
      assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], `${key}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(reuseNotices(outcome), [reuseNotice(code(READ_STEPS[index]))], key);
    }
  }
});

test('R3b: the second read of the run listing is its own step (runs_again)', async () => {
  for (const [failure, code] of READ_FAILURES) {
    const ctx = treeReuseCase('clued-required-tests.yml');
    const runs = ctx.w.runs;
    let reads = 0;
    ctx.routes[ctx.runsRoute] = () => (++reads === 1 ? runs : failure());
    const outcome = await treeReuseGate(ctx);
    assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], JSON.stringify(outcome));
    assert.deepEqual(reuseNotices(outcome), [reuseNotice(code('runs_again'))]);
  }
});

test('R3d: a malformed reply body is unexpected_error at its step, not a bare exception and not an empty code', async () => {
  const keys = Object.keys(treeReuseCase('clued-required-tests.yml').routes);
  for (const step of ['merge', 'pr', 'source', 'jobs', 'compare']) {
    const ctx = treeReuseCase('clued-required-tests.yml');
    ctx.routes[keys[READ_STEPS.indexOf(step)]] = null;
    const outcome = await treeReuseGate(ctx);
    assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], JSON.stringify(outcome));
    assert.deepEqual(reuseNotices(outcome), [reuseNotice(`unexpected_error@${step}`)]);
  }
  // A reply of the right kind but the wrong shape: the PR has no head.
  const ctx = treeReuseCase('clued-required-tests.yml', (c) => { delete c.f.pr.head; });
  assert.deepEqual(reuseNotices(await treeReuseGate(ctx)), [reuseNotice('unexpected_error@pr')]);
});

// The codes the gate cannot reach (it calls only for an 'ancestry' target on a push): asked of the module directly.
// The tree-report proof's own reads go under the step name "report".
function reportCase() {
  const ctx = treeReuseCase('clued-required-tests.yml');
  const g4 = 'clued-g4-database.yml';
  ctx.routes[ctx.runsRoute.replace('clued-required-tests.yml', g4)] = () => ctx.w.runs;
  ctx.env.REUSE_WORKFLOW = g4;
  return ctx;
}
const DIRECT_REASONS = [
  ['pr_and_dispatch_always_run', (reuse, c) => reuse.evaluatePush({ ...c.env, GITHUB_EVENT_NAME: 'pull_request' }, c.fetchImpl)],
  ['tree_report_proof_unavailable', (reuse, c) => reuse.evaluatePush(c.env, c.fetchImpl)],
  ['proof_kind', (reuse, c) => reuse.evaluatePush(c.env, c.fetchImpl,
    { reportProof: ({ evidence }) => reuse.validateAncestryEvidence({ ...evidence, compare: c.f.compare }) })],
  ['request_budget', (reuse, c) => reuse.evaluatePush(c.env, c.fetchImpl,
    { reportProof: async ({ get }) => { for (let i = 0; i < 9; i += 1) await get(`/commits/${c.f.merge.sha}`); } })],
  ['artifact_too_large', (reuse, c) => reuse.evaluatePush(c.env, async (url, init) => (String(url).endsWith('/zip')
    ? { ok: true, status: 200, body: (async function* body() { yield Buffer.alloc(reuse.MAX_BYTES + 1); })() }
    : c.fetchImpl(url, init)), { reportProof: ({ get }) => get('/zip', true) })],
  ['github_request_failed@report:404', (reuse, c) => reuse.evaluatePush(c.env, c.fetchImpl, { reportProof: ({ get }) => get('/missing') })],
  ['unexpected_error@report', (reuse, c) => reuse.evaluatePush(c.env, c.fetchImpl,
    { reportProof: () => { throw new Error('must-not-leak'); } })],
];
for (const [code, ask] of DIRECT_REASONS) {
  test(`R3 reason ${code}: the heavy jobs run and the reason is exactly this code`, async () => {
    const reuse = await import('./clued-tree-reuse.mjs');
    assert.deepEqual(await ask(reuse, reportCase()), { run_heavy: true, reason: code, current_sha_pass: false });
  });
}

test('R3c: the reason vocabulary is closed - every code is in REASONS, and every code of clued-tree-reuse.mjs has a guard', async () => {
  const reuse = await import('./clued-tree-reuse.mjs');
  assert.ok(Array.isArray(reuse.REASONS) && Object.isFrozen(reuse.REASONS), 'REASONS is a frozen array');
  assert.equal(new Set(reuse.REASONS).size, reuse.REASONS.length);
  const literals = (name) => {
    const text = fs.readFileSync(path.join(ROOT, 'scripts/ci', name), 'utf8');
    const refusals = [...text.matchAll(/\brequireProof\((?:(?!requireProof\()[\s\S])*?'([a-z_]+)'\);/g)].map((m) => m[1]);
    // Every requireProof call ends in a literal code: a computed code would escape this scan.
    assert.equal(refusals.length, [...text.matchAll(/\brequireProof\(/g)].length, `${name}: every requireProof names a literal code`);
    const fallbacks = [...text.matchAll(/\bfallback\('([a-z_]+)'\)/g)].map((m) => m[1]);
    const families = [...text.matchAll(/`([a-z_]+)@\$\{/g)].map((m) => m[1]);
    return [...new Set([...refusals, ...fallbacks, ...families])];
  };
  const own = literals('clued-tree-reuse.mjs');
  const report = literals('clued-push-reuse.mjs');
  for (const code of [...own, ...report]) assert.ok(reuse.REASONS.includes(code), `${code} is in REASONS`);
  for (const code of reuse.REASONS) assert.ok(own.includes(code) || report.includes(code), `${code} is still produced`);
  const guarded = new Set([...STILL_RUNS.map((row) => row[2]), ...DIRECT_REASONS.map((row) => row[0].split('@')[0]),
    'github_request_failed', 'github_request_threw', 'unexpected_error']);
  for (const code of own) assert.ok(guarded.has(code), `${code} has a guard that expects it`);
  for (const family of ['github_request_failed', 'github_request_threw', 'unexpected_error']) assert.ok(own.includes(family), family);
  assert.ok(!reuse.REASONS.includes('proof_unavailable_or_not_applicable'), 'the catch-all word is gone');
});

// This pins the scope of reuse to a first-attempt push to main (FABLE-tree-reuse-close-out §4).
// 扩范围前先让 admission-rerun 按门的 verdict 判 final。
test('tree reuse guard: a re-run, staging, another branch or a workflow outside the table reads nothing and runs', async () => {
  for (const [label, mutate] of [
    ['attempt 2 (Re-run all jobs is the manual way to force a real run)', (c) => { c.env.GITHUB_RUN_ATTEMPT = '2'; }],
    ['clued-train/staging', (c) => { c.env.GITHUB_REF = 'refs/heads/clued-train/staging'; c.env.GITHUB_WORKFLOW_REF = c.env.GITHUB_WORKFLOW_REF.replace('@refs/heads/main', '@refs/heads/clued-train/staging'); }],
    ['another branch', (c) => { c.env.GITHUB_REF = 'refs/heads/feature'; }],
    ['a workflow with its own push-reuse job (G4)', (c) => { c.env.GITHUB_WORKFLOW_REF = `${c.f.repository}/.github/workflows/clued-g4-database.yml@refs/heads/main`; }],
    ['a workflow outside the table', (c) => { c.env.GITHUB_WORKFLOW_REF = `${c.f.repository}/.github/workflows/public-mcp-behavior.yml@refs/heads/main`; }],
    ['no workflow ref', (c) => { delete c.env.GITHUB_WORKFLOW_REF; }],
  ]) {
    const ctx = treeReuseCase('clued-required-tests.yml', mutate);
    const outcome = await treeReuseGate(ctx);
    assert.deepEqual([outcome.admitted, outcome.verdict], [true, 'NOT_APPLICABLE'], label);
    assert.deepEqual(ctx.calls, [], label);
  }
});

test('the gate loads only the pure reuse judgement: clued-tree-reuse.mjs imports no repository file', () => {
  // clued-work-admission.mjs is a Source v2 walk entry: whatever its gate imports ships in every resident package.
  const gateText = fs.readFileSync(path.join(ROOT, 'scripts/ci/clued-work-admission.mjs'), 'utf8');
  assert.match(gateText, /await import\("\.\/clued-tree-reuse\.mjs"\)/);
  assert.doesNotMatch(gateText, /clued-push-reuse\.mjs/);
  const text = fs.readFileSync(path.join(ROOT, 'scripts/ci/clued-tree-reuse.mjs'), 'utf8');
  const specifiers = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(specifiers.filter((spec) => !spec.startsWith('node:')), []);
});

// 9aba97c1 (Fable 11-20, 补：车头缺必需检查): a job no runner ever took ran nothing: no step, runner_id 0, runner_name null (GitHub's record
// of job 136029949967 of run 44658316395 and job 134948221590 of run 44345691588). Like a setup death it is the process, not the change:
// one repair re-run is admitted, with no log and no annotation read. The same for a gate job no runner took.
const unassigned = (job) => ({ ...job, steps: [], runner_id: 0, runner_name: null });
test("independent gate repair re-run: a required job or a gate job that no runner took admits one re-run", async () => {
  for (const conclusion of ["cancelled", "failure"]) {
    const earlier = ranAttempt(1, [pass, pass, pass]);
    earlier.jobs[1] = unassigned({ ...earlier.jobs[1], conclusion });
    const { outcome, extra } = await repairGate([earlier]);
    assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"], `${conclusion}: ${outcome.reasons.join("; ")}`);
    assert.deepEqual(outcome.repair_rerun.earlier_attempts[0].environment_failure_kinds, { [earlier.jobs[1].name]: "unassigned" });
    assert.ok(extra.every((call) => !/\/logs|\/annotations/.test(call.url)), "nothing ran: no log or annotation is evidence");
  }
  const gateNeverTaken = ranAttempt(1, [{ conclusion: "skipped" }, { conclusion: "skipped" }, { conclusion: "skipped" }],
    { gate: unassigned(attemptJob(100, "admission-gate", "cancelled")) });
  const { outcome } = await repairGate([gateNeverTaken]);
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"], outcome.reasons.join("; "));
  // A job a runner took that failed with no failed step on record is not proven to be the environment.
  const taken = ranAttempt(1, [pass, pass, pass]);
  taken.jobs[1] = { ...taken.jobs[1], conclusion: "failure", steps: [], runner_id: 7, runner_name: "clued-ci-company-linux-01" };
  assert.equal((await repairGate([taken])).outcome.admitted, false);
});

// Independent review (Codex, 051b7d585) high 3: GitHub records a gate no runner took with every job after it cancelled the same way (run
// 44658316395: steps [], runner_id 0 or null, runner_name null). Nothing ran: the repair re-run is admitted, as for the gate alone.
test("independent gate repair re-run: a gate no runner took with its downstream jobs cancelled unrun admits one re-run", async () => {
  const gate = unassigned(attemptJob(100, "admission-gate", "cancelled"));
  const earlier = ranAttempt(1, [{ conclusion: "cancelled" }, { conclusion: "cancelled" }, { conclusion: "cancelled" }], { gate });
  earlier.jobs = earlier.jobs.map((job) => job.name === "admission-gate" ? job : unassigned(job));
  const { outcome, extra } = await repairGate([earlier]);
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"], outcome.reasons.join("; "));
  assert.ok(extra.every((call) => !/\/logs|\/annotations/.test(call.url)), "nothing ran: no log or annotation is evidence");
});

// Fable 11-20 (单一判定): one budget of three attempts per head and workflow, shared by both kinds of process cause (a run that produced no
// result, and the environment rule's failures), counted over every run of the workflow on the head; the smaller of it and the environment
// rule's own limit holds.
test("independent gate repair re-run: skipped and environment-failed attempts share three attempts per head and workflow", async () => {
  const third = await repairGate([earlierAttempt(1), ranAttempt(2, [netFail, pass, pass])]);
  assert.deepEqual([third.outcome.admitted, third.outcome.verdict], [true, "ADMITTED"], third.outcome.reasons.join("; "));
  const fourth = await repairGate([earlierAttempt(1), ranAttempt(2, [netFail, pass, pass]), ranAttempt(3, [netFail, pass, pass])]);
  assert.equal(fourth.outcome.admitted, false);
  assert.match(fourth.outcome.reasons.join("; "), /three attempts/);
  // Fable 11-20 补“补跑上限的范围”: the budget is per run ID; another run of the head, of this workflow or another, never counts
  for (const workflowId of [timeoutIncident.workflow_id, timeoutIncident.workflow_id + 1]) {
    const other = await repairGate([earlierAttempt(1)], { otherRuns: [{ id: 9002, workflow_id: workflowId, head_sha: HEAD, run_attempt: 3 }] });
    assert.equal(other.outcome.admitted, true, other.outcome.reasons.join("; "));
  }
});

test("one judgement: the gate defines no failure rule of its own, and the hook's copy is the companion's, byte for byte", () => {
  const source = relative => fs.readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const gateSource = source("./clued-work-admission.mjs");
  for (const name of ["jobFailureKind", "diedInSetup", "neverAssigned", "requiredTestsRepairHistory", "repairEnvironmentFailures", "hasRepairRecovery"])
    assert.doesNotMatch(gateSource, new RegExp(`function ${name}\\b`), `the gate keeps no copy of ${name}`);
  assert.match(gateSource, /from "\.\/required-tests-failure-rule\.mjs"/, "the gate imports the rule from the protected scripts/ci path");
  assert.doesNotMatch(gateSource, /work\/independent-ci-resident-v1/, "and nothing outside it");
});


// Fable 11-20 补“补跑上限的范围”: the budget is per run ID. A new run of the same workflow on the head (the PR reopened) is admitted on its
// first attempt as any run, and its re-runs count from 1, whatever other runs of the head used.
test("independent gate repair re-run: the budget is per run; another run's attempts on the head never count", async () => {
  const other = { id: 9000, workflow_id: timeoutIncident.workflow_id, head_sha: HEAD, run_attempt: 3 };
  const second = await repairGate([earlierAttempt(1)], { otherRuns: [other] });
  assert.deepEqual([second.outcome.admitted, second.outcome.verdict], [true, "ADMITTED"], second.outcome.reasons.join("; "));
  const fourth = await repairGate([earlierAttempt(1), earlierAttempt(2), earlierAttempt(3)], { otherRuns: [other] });
  assert.equal(fourth.outcome.admitted, false);
  assert.match(fourth.outcome.reasons.join("; "), /three attempts/);
  const dispatched = await requiredDispatch({ others: [skippedDispatchRun({ run_attempt: 3 })], jobs: { 8001: skippedDispatchJobs(), '8001:2': skippedDispatchJobs(), '8001:3': skippedDispatchJobs() } });
  assert.equal(dispatched.outcome.admitted, true, `a re-dispatched run's first attempt is admitted: ${JSON.stringify(dispatched.outcome.reasons)}`);
});

// FABLE-scaffold-open-qs 问题 1 改法 2: a gate with the independent source admits on Native only. Enabling the legacy
// clued-work-admission.yml again must not let its event-bound App check decide first (it settles in a minute or two, Native's
// p90 is ten), so every pull request would be judged by the legacy workflow again.
test("independent gate, Native only (scaffold open-qs 1.2): a legacy failure that settles first does not decide; Native's later success admits", async () => {
  let nativeReads = 0;
  const { outcome, calls } = await independentGate((call) => {
    const native = call.url.includes("check_name=kooyumi-work-admission") && ++nativeReads > 1;
    return { body: { check_runs: [appCheckRun({ conclusion: "failure" }), ...(native ? [nativeCheck()] : [])] } };
  });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_source], [true, "ADMITTED", INDEPENDENT_GATE_SOURCE], JSON.stringify(outcome.reasons));
  assert.equal(calls.some((call) => call.url.includes("/actions/workflows/clued-work-admission.yml/runs")), false, "the legacy run is not read");
});
test("independent gate, Native only (scaffold open-qs 1.2): a legacy success without Native in time is ADMISSION_PENDING, not ADMITTED", async () => {
  const { outcome, calls } = await independentGate([appCheckRun()], { envOverrides: { CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" } });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_source], [false, "ADMISSION_PENDING", INDEPENDENT_GATE_SOURCE]);
  assert.equal(calls.some((call) => call.url.includes("/actions/workflows/clued-work-admission.yml/runs")), false);
});
