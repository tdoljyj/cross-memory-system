import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  evaluate,
  gate,
  globToRegExp,
  renderReverifySummary,
  reverify,
  main,
  parseClaimReference,
  parseWorkflowTriggers,
  readWorkflowTriggers,
  renderSummary,
  resolvePublicSupabaseConfig,
  sha256Hex,
  workflowApplies,
  APP_CHECK_NAME,
  appCheck,
  appJwt,
  GATE_JOB_SHA256,
  checkNamesPullRequest,
  SAME_EVENT_MS,
  gateFindings,
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
  MERGE_SLOT_CHECK_NAME,
  MERGE_SLOT_RETURN_RPC,
  mergeSlotCheck,
  mergeSlotOutputs,
  mergeSlotState,
} from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAIM = "0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CLAIM_BASE = "c".repeat(40);
// Re-review 10: the base branch's tip as GitHub reports it now (it may be
// ahead of the event's base.sha).
const TIP = "7".repeat(39) + "6";
// The public project values are read from the repository file, never copied here.
const PUBLIC = resolvePublicSupabaseConfig({}, ROOT);
const RPC_URL = `${PUBLIC.url}/rest/v1/rpc/clued_work_verify_v1`;

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
    CLUED_WORK_ADMISSION_ENFORCE: "true",
    GITHUB_RUN_ID: "9001",
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
const appCheckRun = (overrides = {}) => ({ id: 1, name: "clued-admission-verified", head_sha: HEAD, status: "completed",
  conclusion: "success", started_at: "2026-10-02T04:00:40Z", external_id: "pr:452:run:77", app: { id: ADMISSION_APP_ID, slug: "clued-admission" },
  ...overrides });
const checksReturn = (list) => ({ ...SELF_RUN, [CHECKS]: { body: { check_runs: list } } });
const RERUN = `POST https://api.test/repos/o/r/actions/runs/`;
const COMMIT = `GET https://api.test/repos/o/r/commits/`;
const COMPARE = `GET https://api.test/repos/o/r/compare/`;
const RUNS = `GET https://api.test/repos/o/r/actions/runs`;
const VERIFY = `POST ${RPC_URL}`;
const files = { body: [{ filename: "apps/clued-cloud/worker/index.ts" }, { filename: "docs/new.md", previous_filename: "docs/old.md" }] };
const admittedPayload = { status: "ok", verdict: "ADMITTED", reasons: [], paths_outside_write_set: [], current_fence: 1, claim: { claim_id: CLAIM, task_id: "t-1", status: "ACTIVE", fence: 1, expires_at: "2026-10-01T13:00:00Z", base_commit: CLAIM_BASE, write_set: ["apps/clued-cloud/**", "docs/**"], holder_binding_id: "should-not-leak" } };
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
  const call = calls.find((c) => c.url === RPC_URL);
  assert.equal(call.headers.apikey, PUBLIC.key);
  assert.equal(call.headers.authorization, `Bearer ${PUBLIC.key}`);
  assert.equal(PUBLIC.source, PUBLIC_CONFIG_SOURCE);
  assert.match(PUBLIC.key, /^sb_publishable_[A-Za-z0-9_-]+$/);
  assert.match(PUBLIC.url, /^https:\/\/[a-z]+\.supabase\.co$/);
  assert.deepEqual(call.body, {
    p_token_hash: sha256Hex("clued_bnd_test"),
    p_input: { scope: "global", claim_id: CLAIM, changed_paths: ["apps/clued-cloud/worker/index.ts", "docs/new.md", "docs/old.md"], head_sha: HEAD, base_sha: BASE, pr_ref: "o/r#452" },
  });
  assert.equal(sha256Hex("clued_bnd_test").length, 64);
  assert.ok(!JSON.stringify(call.body).includes("clued_bnd_test"), "only the hash leaves the runner");
  assert.ok(calls.find((c) => c.url.includes("/compare/") && !c.url.includes(`/compare/${TIP}...`)).url.endsWith(`/compare/${CLAIM_BASE}...${BASE}`));
});

test("enforced: trailer in the head commit, project scope and a custom Supabase URL are honored", async () => {
  const scope = "project:11111111-2222-4333-8444-555555555555";
  const custom = "https://db.test";
  const { fetchImpl, calls } = fakeFetch({
    [FILES]: files,
    [COMMIT]: { body: { commit: { message: `feat: x\n\nClued-Work-Claim: ${CLAIM.toUpperCase()}\nClued-Work-Scope: ${scope}\n` } } },
    [COMPARE]: { body: { status: "identical" } },
    [`POST ${custom}/rest/v1/rpc/clued_work_verify_v1`]: { body: admittedPayload },
  });
  const outcome = await evaluateIn({ env: env({ CLUED_SUPABASE_URL: `${custom}/`, CLUED_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x" }), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.scope, scope);
  const call = calls.find((c) => c.method === "POST");
  assert.equal(call.headers.apikey, "sb_publishable_x");
  assert.equal(call.body.p_input.scope, scope);
});

test("enforced: no trailer anywhere is REJECTED claim_trailer_missing", async () => {
  const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [COMMIT]: { body: { commit: { message: "feat: no trailer" } } } });
  const outcome = await evaluateIn({ env: env(), event: event(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["claim_trailer_missing"]);
  assert.ok(!calls.some((c) => c.method === "POST"), "no verification without a claim");
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

test("advisory (variable unset): a claimed PR gets its verdict in the summary and is admitted either way", async () => {
  const rejected = { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] };
  const { fetchImpl, calls } = fakeFetch({ [FILES]: files, [VERIFY]: { body: rejected } });
  const outcome = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.enforced, false);
  assert.equal(outcome.admitted, true);
  assert.equal(outcome.advisory, true);
  assert.equal(outcome.verdict, "REJECTED");
  assert.deepEqual(outcome.reasons, ["claim_not_current", "advisory only: CLUED_WORK_ADMISSION_ENFORCE is not set"]);
  assert.ok(calls.some((c) => c.method === "POST"), "the verdict is still fetched");
  assert.match(renderSummary(outcome), /advisory \(CLUED_WORK_ADMISSION_ENFORCE is not set\)/);
});

test("advisory: no trailer, no token, missing RPC, refused Binding or a transport error only report and admit", async () => {
  const quiet = { CLUED_WORK_ADMISSION_ENFORCE: "false" };
  const base = { [FILES]: files, [COMMIT]: { body: { commit: { message: "feat: no trailer" } } } };
  let outcome = await evaluateIn({ env: env(quiet), event: event(), eventName: "pull_request", fetchImpl: fakeFetch(base).fetchImpl });
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.equal(outcome.admitted, true);
  assert.match(outcome.reasons[0], /no Clued-Work-Claim trailer/);

  outcome = await evaluateIn({ env: env({ ...quiet, CLUED_CONTEXT_READ_TOKEN: "" }), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch(base).fetchImpl });
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.match(outcome.reasons[0], /CLUED_CONTEXT_READ_TOKEN is not set/);

  outcome = await evaluateIn({ env: env(quiet), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch({ ...base, [VERIFY]: { status: 404, body: { code: "PGRST202", message: "missing" } } }).fetchImpl });
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.match(outcome.reasons[0], /not deployed yet/);

  outcome = await evaluateIn({ env: env(quiet), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch({ ...base, [VERIFY]: { status: 400, body: { code: "P0001", message: "binding_not_found" } } }).fetchImpl });
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.match(outcome.reasons[0], /refused the verification request/);

  outcome = await evaluateIn({ env: env(quiet), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch({ ...base, [VERIFY]: { status: 502, body: null } }).fetchImpl });
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.match(outcome.reasons[0], /advisory verification unavailable: Clued clued_work_verify_v1 returned 502/);

  outcome = await evaluateIn({ env: env({ ...quiet, GITHUB_TOKEN: "" }), event: withClaim(), eventName: "pull_request", fetchImpl: fakeFetch(base).fetchImpl });
  assert.equal(outcome.verdict, "NOT_ENFORCED");
  assert.equal(outcome.admitted, true);
  assert.match(outcome.reasons[0], /GITHUB_TOKEN is not set/);
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

test("main: exit codes and outputs in both modes, enforced and advisory", async () => {
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

  code = await main(["--mode", "required"], { ...base, CLUED_WORK_ADMISSION_ENFORCE: "", GITHUB_OUTPUT: out("o4"), GITHUB_STEP_SUMMARY: out("s4") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 0, "advisory + REJECTED passes");
  assert.match(read("o4"), /^admitted=true$/m);
  assert.match(read("o4"), /^enforced=false$/m);
  assert.match(read("o4"), /^verdict=REJECTED$/m);

  code = await main(["--mode", "required"], { ...base, CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_CONTEXT_READ_TOKEN: "", GITHUB_OUTPUT: out("o5"), GITHUB_STEP_SUMMARY: out("s5") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 0, "advisory + missing token passes with NOT_ENFORCED");
  assert.match(read("o5"), /^verdict=NOT_ENFORCED$/m);

  code = await main(["--mode", "required"], { ...base, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: out("o6"), GITHUB_STEP_SUMMARY: out("s6") }, fakeFetch({}).fetchImpl);
  assert.equal(code, 0);
  assert.match(read("o6"), /^verdict=NOT_APPLICABLE$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Step 7 review fixes: base-branch target runs, PR binding, truncation, re-verification.

const freshPull = (overrides = {}) => ({
  number: 452, draft: false, changed_files: 2,
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
  const verifyCall = calls.find((c) => c.url === RPC_URL);
  assert.equal(verifyCall.body.p_input.pr_ref, "o/r#452");
  assert.equal(verifyCall.body.p_input.head_sha, "d".repeat(40));
  assert.ok(!calls.some((c) => c.url.includes("/commits/")), "the trailer was found in the fresh body");
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

test("a changed-file list shorter than the PR's changed_files fails closed when enforced", async () => {
  const short = { pull_request: { ...withClaim().pull_request, changed_files: 3500 } };
  let { fetchImpl, calls } = fakeFetch({ [FILES]: files, [VERIFY]: { body: admittedPayload } });
  let outcome = await evaluateIn({ env: env(), event: short, eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["changed_files_truncated:3500"]);
  assert.ok(!calls.some((c) => c.method === "POST"), "no verify on a partial file list");
  ({ fetchImpl } = fakeFetch({ [FILES]: files, [VERIFY]: { body: admittedPayload } }));
  outcome = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: short, eventName: "pull_request", fetchImpl });
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "NOT_ENFORCED"]);
  // A rename counts once in changed_files but contributes two paths.
  ({ fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload } }));
  outcome = await evaluateIn({ env: env(), event: { pull_request: { ...withClaim().pull_request, changed_files: 2 } }, eventName: "pull_request", fetchImpl });
  assert.equal(outcome.verdict, "ADMITTED");
});

// Re-review 7, MAJOR-1: re-verification follows the App check the ruleset
// reads, per pull request, and posts the failing check itself.
const appKeyPem = () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
const reverifyScript = (pulls, checksFor, extra = {}) => {
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
    [VERIFY]: (call) => ({ body: call.body.p_input.claim_id === CLAIM
      ? { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } : admittedPayload }),
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
  const { fetchImpl, calls } = reverifyScript(pulls, checksFor);
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
  assert.match(renderReverifySummary(result), /^## clued-work-admission re-verification\n\n\*\*Mode:\*\* `normal` · source `default`\n/);
  assert.ok(!calls.some((c) => c.url.includes("/pulls/455")), "drafts are skipped");
  assert.ok(!calls.some((c) => c.url.includes("/pulls/457")), "pull requests into other branches are skipped");
  assert.ok(!calls.some((c) => c.url.includes("/pulls/454")), "a head whose newest check failed is not evaluated");
  assert.match(renderReverifySummary(result), /#452: failing check 5005 posted, REJECTED: claim_not_current/);

  const advisory = await reverify({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
  assert.match(advisory.skipped, /advisory/);
  assert.match(renderReverifySummary(advisory), /Skipped/);
  // Merge Admission v0.1 §4: frozen ignores the switch; without the App key
  // that is an error, not a quiet skip.
  const frozen = await reverify({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_MERGE_ADMISSION_STATE: "frozen" }), fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
  assert.deepEqual([frozen.skipped, frozen.enforced, frozen.mode.state], [undefined, true, "frozen"]);
  assert.match(frozen.errors[0].error, /App is not configured/);
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

test("gate: deadlines, advisory mode, errors and fork pull requests, without Clued", async () => {
  const gateWith = async (list, extraEnv = {}, sleeps = []) => {
    const { fetchImpl, calls } = fakeFetch({ ...SELF_RUN, [CHECKS]: () => ({ body: { check_runs: typeof list === "function" ? list() : list } }) });
    const outcome = await gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", ...extraEnv }), event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    return { outcome, calls };
  };
  const { outcome: admitted, calls } = await gateWith([appCheckRun()]);
  assert.deepEqual([admitted.admitted, admitted.verdict], [true, "ADMITTED"]);
  assert.ok(!calls.some((c) => c.method === "POST"), "no Clued call, no write");

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

  // Advisory: never blocks, but reports what it saw.
  ({ outcome } = await gateWith([appCheckRun({ conclusion: "failure" })], { CLUED_WORK_ADMISSION_ENFORCE: "" }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.advisory], [true, "REJECTED", true]);
  for (const status of [500, 403]) {
    const broken = await gate({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request",
      fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { status, body: null } }).fetchImpl, sleep: async () => {} });
    assert.deepEqual([broken.admitted, broken.verdict], [true, "NOT_ENFORCED"]);
  }
  await assert.rejects(gate({ env: env(), event: withClaim(), eventName: "pull_request",
    fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { status: 500, body: null } }).fetchImpl, sleep: async () => {} }), /returned 500/);
  // A gate job without `checks: read` fails closed and says why; it no
  // longer falls back to the admission workflow run.
  const noChecks = fakeFetch({ ...SELF_RUN, [CHECKS]: { status: 403, body: null } });
  await assert.rejects(gate({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl: noChecks.fetchImpl,
    sleep: async () => {} }), /403: the admission-gate job needs `checks: read`/);
  assert.ok(!noChecks.calls.some((c) => c.url.includes("/actions/workflows/")));

  // A fork pull request may not see repository variables: an unset
  // CLUED_WORK_ADMISSION_ENFORCE does not open the gate, the App check decides.
  const forkEvent = withClaim();
  forkEvent.pull_request.head.repo = { full_name: "someone/r" };
  const forkGate = (list) => gate({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0" }),
    event: forkEvent, eventName: "pull_request", sleep: async () => {}, fetchImpl: fakeFetch(checksReturn(list)).fetchImpl });
  let fork = await forkGate([appCheckRun({ conclusion: "failure" })]);
  assert.deepEqual([fork.admitted, fork.enforced, fork.verdict, fork.advisory], [false, true, "REJECTED", undefined]);
  assert.match(fork.notices[0], /fork pull request from someone\/r/);
  fork = await forkGate([]);
  assert.deepEqual([fork.admitted, fork.verdict], [false, "ADMISSION_PENDING"]);
  fork = await forkGate([appCheckRun()]);
  assert.deepEqual([fork.admitted, fork.verdict], [true, "ADMITTED"]);
  await assert.rejects(gate({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: forkEvent, eventName: "pull_request",
    fetchImpl: fakeFetch({ ...SELF_RUN, [CHECKS]: { status: 500, body: null } }).fetchImpl, sleep: async () => {} }), /returned 500/);
  // A same-repository pull request keeps the variable's answer.
  ({ outcome } = await gateWith([appCheckRun({ conclusion: "failure" })], { CLUED_WORK_ADMISSION_ENFORCE: "" }));
  assert.ok(!outcome.notices.some((n) => /fork/.test(n)));

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
  assert.equal(calls.length, 3, "its own run, the checks, then the admission runs that locate this event's run");
  assert.match(calls[0].url, /\/actions\/runs\/9001$/);
  assert.match(calls[1].url, /check-runs\?check_name=clued-admission-verified&filter=all/);
  assert.match(calls[2].url, /\/actions\/workflows\/clued-work-admission\.yml\/runs\?head_sha=a{40}&event=pull_request_target/);
  // A successful admission run (for instance one of a pull request into
  // another branch that lists this one) does not admit without the App check.
  ({ outcome, calls } = await gateWith([]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "ADMISSION_PENDING"]);
  // Only the App's own check on this head counts; the newest one decides.
  for (const list of [[check({ app: { id: 15368, slug: "github-actions" } })], [check({ head_sha: "e".repeat(40) })],
    [check({ name: "clued-work-admission" })], [check({ id: 1 }), check({ id: 2, conclusion: "failure" })]]) {
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
  assert.deepEqual(gated.map(([file]) => file).sort(), [...GATED_FILES].sort());
  assert.ok(gated.length > 0);
  for (const [file, text] of gated) {
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
  assert.deepEqual(holders.sort(), ["clued-work-admission-dispatch.yml", "clued-work-admission-reverify.yml", "clued-work-admission.yml"]);
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
    "https://api.test/repos/o/r/actions/runs/77/jobs", "https://api.test/repos/o/r/check-runs/701/annotations"]);
  // Re-review N3: the admission covers the commit it verified, not a later push to the ref.
  ({ outcome } = await dispatchGateWith(admissionRun(), {}, "77", "e".repeat(40)));
  assert.deepEqual([outcome.admitted, outcome.reasons], [false, [`admission_run_other_head:${"e".repeat(40)}`]]);
  ({ outcome } = await dispatchGateWith(admissionRun(), {}, "77", null));
  assert.deepEqual([outcome.admitted, outcome.reasons], [false, ["admission_run_head_unknown"]]);
  assert.ok(!calls.some((c) => c.url.startsWith(PUBLIC.url)), "the gate never calls Clued");

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

  // Advisory never blocks; a workflow outside the gated list is not a subject.
  ({ outcome } = await dispatchGateWith(admissionRun({ conclusion: "failure" }), { CLUED_WORK_ADMISSION_ENFORCE: "" }));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.advisory], [true, "REJECTED", true]);
  ({ outcome } = await dispatchGateWith(admissionRun(), { GITHUB_WORKFLOW_REF: "o/r/.github/workflows/mps03-native-agent.yml@refs/heads/main" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "NOT_APPLICABLE"]);
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
  assert.deepEqual(verify.body.p_input, { scope: "global", claim_id: CLAIM, head_sha: HEAD, ci_dispatch: true });
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
  outcome = await dispatchAdmit({ env: { ...base, CLUED_CONTEXT_READ_TOKEN: "", CLUED_WORK_ADMISSION_ENFORCE: "" }, fetchImpl: fakeFetch(script).fetchImpl, workspace: ROOT });
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "NOT_ENFORCED"]);
});

test("workflows: dispatch-gated workflows take admission_run_id; the admission workflow lists exactly them", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const admit = fs.readFileSync(path.join(dir, "clued-work-admission-dispatch.yml"), "utf8");
  const options = [...admit.matchAll(/^ {10}- (\S+\.yml)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, DISPATCH_GATED_WORKFLOWS);
  assert.match(admit, /^run-name: admit \$\{\{ inputs\.workflow \}\} \$\{\{ inputs\.ref \}\} \$\{\{ inputs\.claim_id \}\}$/m);
  assert.match(admit, /^ {4}if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)$/m);
  assert.doesNotMatch(admit, /^ {2}pull_request/m);
  for (const file of DISPATCH_GATED_WORKFLOWS) {
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
  .filter((name) => workflowIsGated(fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8")));
const g4 = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-g4-database.yml"), "utf8");

test("gate guard: every gated workflow on this branch passes and uses a listed gate job", () => {
  // No pinned list (see "gate job digest"); the workflow this file reads below must stay gated.
  assert.ok(GATED_FILES.includes("clued-g4-database.yml"));
  for (const name of GATED_FILES) {
    const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
    assert.deepEqual(gateFindings(text, text), [], name);
    const gateJob = workflowJobs(text).find((job) => job.name === "admission-gate");
    assert.ok(GATE_JOB_SHA256.has(sha256Hex(gateJob.lines.join("\n"))), name);
    // The gate runs the base branch's script, not the PR's.
    assert.match(gateJob.lines.join("\n"), /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.repository\.default_branch \}\}/);
  }
  // Ungated workflows, even with self-hosted jobs, stay out of scope when they already exist.
  const ungated = fs.readFileSync(path.join(ROOT, ".github", "workflows", "trivy.yml"), "utf8");
  assert.deepEqual(gateFindings(ungated, ungated), []);
});

test("gate guard: the gate runs on the self-hosted Linux pool with a pinned Node", () => {
  const gateJob = workflowJobs(g4).find((job) => job.name === "admission-gate");
  const text = gateJob.lines.join("\n");
  assert.equal(sha256Hex(text), "41e789754b90dcb27c8297bf83169194b7aaab2659d909859ddd8618d0fa07c4");
  assert.match(text, /^    runs-on: \[self-hosted, Linux, X64, clued, pool-general, trust-internal\]$/m);
  assert.match(text, /^          node-version: 24\.19\.0$/m);
  // Owner Decision f86179b3: the hosted gate, another runner or another Node is a changed gate.
  const hosted = g4
    .replace("    runs-on: [self-hosted, Linux, X64, clued, pool-general, trust-internal]\n    timeout-minutes: 10\n",
      "    runs-on: ubuntu-latest\n    timeout-minutes: 10\n")
    .replace("      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 24.19.0\n      - id: gate\n",
      "      - id: gate\n");
  assert.notEqual(hosted, g4);
  assert.deepEqual(gateFindings(hosted, g4), ["admission_gate_changed"]);
  assert.deepEqual(gateFindings(g4.replace("node-version: 24.19.0", "node-version: 24"), g4), ["admission_gate_changed"]);
  assert.deepEqual(gateFindings(g4.replace("pool-general, trust-internal]\n    timeout-minutes: 10", "pool-general]\n    timeout-minutes: 10"), g4), ["admission_gate_changed"]);
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

test("gate guard (re-review N4): YAML the line reader cannot follow is refused, and only literal hosted labels count as hosted", () => {
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
  const trivy = fs.readFileSync(path.join(ROOT, ".github", "workflows", "trivy.yml"), "utf8");
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
  const refusedVerify = calls.find((c) => c.method === "POST");
  assert.deepEqual(Object.keys(refusedVerify.body.p_input).sort(), ["changed_paths", "claim_id", "scope"]);
  // The same PR with the gate intact is admitted.
  const intact = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } }, [OLD]: oldWorkflow, [CONTENTS]: b64(g4) });
  const ok = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl: intact.fetchImpl });
  assert.deepEqual([ok.admitted, ok.reasons], [true, []]);
  // Advisory: reported, not blocking.
  const advisory = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } }, [OLD]: oldWorkflow,
    [CONTENTS]: (call) => (call.url.endsWith(`?ref=${HEAD}`) ? b64(stripped) : b64(g4)) });
  const soft = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request", fetchImpl: advisory.fetchImpl });
  assert.equal(soft.admitted, true);
  assert.ok(soft.reasons.some((r) => r.startsWith("workflow_gate:")));
});

// --- App-posted check (Owner Decision 37e01bb1).

test("app check: posts the admission result as the App on the evaluated head", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = appJwt("12345", pem, 1_800_000_000);
  const [h, p, sig] = jwt.split(".");
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });

  const appEnv = (extra) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "https://api.test", GITHUB_RUN_ID: "77",
    CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: pem, ADMISSION_HEAD_SHA: HEAD, ...extra });
  const script = () => fakeFetch({
    "GET https://api.test/repos/o/r/installation": { body: { id: 99 } },
    "POST https://api.test/app/installations/99/access_tokens": { status: 201, body: { token: "ghs_app" } },
    "POST https://api.test/repos/o/r/check-runs": { status: 201, body: { id: 5 } },
  });
  for (const [outcome, conclusion] of [["success", "success"], ["failure", "failure"], ["skipped", "failure"]]) {
    const { fetchImpl, calls } = script();
    const result = await appCheck({ env: appEnv({ ADMISSION_OUTCOME: outcome }), fetchImpl, now: () => 1_800_000_000_000 });
    assert.deepEqual([result.posted, result.conclusion, result.head_sha], [true, conclusion, HEAD], outcome);
    assert.match(calls[0].headers.authorization, /^Bearer ey/, "installation lookup uses the App JWT");
    assert.deepEqual(calls[1].body, { repositories: ["r"], permissions: { checks: "write" } });
    const post = calls[2];
    assert.equal(post.headers.authorization, "Bearer ghs_app");
    assert.deepEqual([post.body.name, post.body.head_sha, post.body.status, post.body.conclusion], [APP_CHECK_NAME, HEAD, "completed", conclusion]);
    assert.equal(post.body.external_id, undefined, "no pull request number, no external_id");
  }
  // Re-review 4, m1: the check names its pull request and admission run.
  const named = script();
  await appCheck({ env: appEnv({ ADMISSION_OUTCOME: "success", ADMISSION_PR_NUMBER: "452" }), fetchImpl: named.fetchImpl, now: () => 1_800_000_000_000 });
  assert.equal(named.calls[2].body.external_id, "pr:452:run:77");
  // Not configured, or no evaluated head: nothing is posted.
  let quiet = await appCheck({ env: appEnv({ CLUED_ADMISSION_APP_PRIVATE_KEY: "" }), fetchImpl: fakeFetch({}).fetchImpl });
  assert.equal(quiet.posted, false);
  assert.match(quiet.reason, /not configured/);
  quiet = await appCheck({ env: appEnv({ ADMISSION_HEAD_SHA: "" }), fetchImpl: fakeFetch({}).fetchImpl });
  assert.match(quiet.reason, /no head commit/);
  // An API failure is an error, never a silent pass.
  const broken = await appCheck({ env: appEnv({ ADMISSION_OUTCOME: "success" }), fetchImpl: fakeFetch({ "GET https://api.test/repos/o/r/installation": { status: 404, body: {} } }).fetchImpl });
  assert.match(broken.error, /returned 404/);
});

test("app check: the admission workflow posts it after the admission step, keys from the environment", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  assert.match(text, /id: admit\n/);
  assert.match(text, /if: \$\{\{ !cancelled\(\) \}\}\n[\s\S]*ADMISSION_HEAD_SHA: \$\{\{ steps\.admit\.outputs\.head_sha \|\| github\.event\.pull_request\.head\.sha \}\}[\s\S]*secrets\.CLUED_ADMISSION_APP_KEY[\s\S]*--mode app-check/);
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
  const { fetchImpl, calls } = fakeFetch({ [ADOPT]: { body: adopted } });
  const result = await adoptMerged({ env: env(), event: merged({ body: `B\n\nClued-Work-Claim: ${CLAIM}\nClued-Work-Scope: project:11111111-2222-4333-8444-555555555555` }),
    eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.deepEqual([result.adopted, result.error, result.pr_ref, result.merge_sha], [true, null, "o/r#452", MERGE]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.apikey, PUBLIC.key);
  assert.equal(calls[0].headers.authorization, `Bearer ${PUBLIC.key}`);
  assert.deepEqual(calls[0].body, { p_token_hash: sha256Hex("clued_bnd_test"),
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
  let fake = fakeFetch({ [COMMIT]: { body: { commit: { message: "no trailer" } } } });
  r = await adoptMerged({ env: env(), event: merged({ body: "no trailer" }), eventName: "pull_request_target", fetchImpl: fake.fetchImpl, workspace: ROOT });
  assert.match(r.reason, /no Clued-Work-Claim trailer/);
  assert.ok(!fake.calls.some((c) => c.url.startsWith(PUBLIC.url)));
  // The trailer may live in the head commit only.
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
  assert.match(text, /types: \[opened, synchronize, reopened, edited, ready_for_review, closed\]/);
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

test("gate (re-review 3, N-R3): re-runs of pull request and dispatch runs are refused before any lookup", async () => {
  assert.equal(rerunAttempt({}), null);
  assert.equal(rerunAttempt({ GITHUB_RUN_ATTEMPT: "1" }), null);
  assert.equal(rerunAttempt({ GITHUB_RUN_ATTEMPT: "3" }), 3);
  const { fetchImpl, calls } = fakeFetch(checksReturn([appCheckRun()]));
  let outcome = await gate({ env: env({ GITHUB_RUN_ATTEMPT: "2" }), event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async () => {} });
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"]);
  assert.match(outcome.reasons[0], /run attempt 2: re-runs are not admitted; push a new commit/);
  assert.equal(calls.length, 0);
  outcome = await gate({ env: env({ GITHUB_RUN_ATTEMPT: "2", CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request",
    fetchImpl, sleep: async () => {} });
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.advisory], [true, "RERUN_REFUSED", true]);
  ({ outcome } = await dispatchGateWith(admissionRun(), { GITHUB_RUN_ATTEMPT: "2" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "RERUN_REFUSED"]);
});

test("gate guard (re-review 3, N-R5): an ungated workflow may not move a job to a self-hosted runner or loosen its timeout", () => {
  const ungated = fs.readFileSync(path.join(ROOT, ".github", "workflows", "trivy.yml"), "utf8");
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
  const ungated = fs.readFileSync(path.join(ROOT, ".github", "workflows", "trivy.yml"), "utf8");
  const job = "trivy-trusted-self-hosted";
  const matrix = ungated.replace("    timeout-minutes: 25\n", "    timeout-minutes: 25\n    strategy:\n      matrix:\n        shard: [1, 2, 3]\n");
  assert.notEqual(matrix, ungated);
  assert.deepEqual(gateFindings(matrix, ungated), [`self_hosted_strategy_changed_ungated:${job}`]);
  assert.deepEqual(gateFindings(ungated, ungated), []);
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

test("owner review: the workflows on main that hold an environment are exactly the release, storage, attestation and admission ones", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const holders = [];
  for (const file of fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (workflowHasEnvironment(text)) holders.push(file);
    assert.deepEqual(ownerReviewFindings(text, text).filter((f) => f !== "environment_workflow_changed"), [], file);
  }
  assert.deepEqual(holders, ["clued-cloud-production-release.yml", "clued-currentness-post-deploy-attestation.yml",
    "clued-integration-runtime-config.yml", "clued-release-tags.yml", "clued-storage-executor-window.yml", "clued-storage-read-config.yml", "clued-work-admission-dispatch.yml",
    "clued-work-admission-reverify.yml", "clued-work-admission.yml"]);
});

test("evaluate (re-review 7, MAJOR-3): a protected change is admitted only with an Owner Grant on its head", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const protectedFiles = { body: [{ filename: "scripts/ci/clued-work-admission.mjs", status: "modified" }] };
  const run = async (door, extraEnv = {}) => {
    const { fetchImpl, calls } = fakeFetch({ [FILES]: protectedFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } },
      ...(door ? { [DOOR]: door } : {}) });
    const outcome = await evaluateIn({ env: env({ CLUED_OWNER_REVIEW_ENFORCE: "true", ...extraEnv }), event: withClaim(), eventName: "pull_request", fetchImpl });
    return { outcome, calls };
  };
  const pending = { body: { status: "ok", admitted: false, owner_request: { request_id: "r1", status: "pending", confirm_path: "/confirm/r1" } } };
  let { outcome, calls } = await run(pending);
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.verdict, "REJECTED");
  assert.match(outcome.reasons[0], /^owner_review_required \(protected_path:scripts\/ci\/clued-work-admission\.mjs\); ask the Owner to approve https:\/\/clued\.pixelgrav\.com\/confirm\/r1$/);
  const asked = calls.find((c) => c.url.endsWith(OWNER_REVIEW_RPC));
  assert.deepEqual(asked.body.p_input, { action: "repo.protected_change", resources: [`repo:o/r/${HEAD}`],
    note: `o/r#452 @ aaaaaaaaaaaa: 1 protected path(s) changed, see https://github.com/o/r/compare/${TIP}...${HEAD} (scripts/ci/clued-work-admission.mjs)` });
  assert.equal(asked.body.p_token_hash, sha256Hex("clued_bnd_test"));
  ({ outcome } = await run({ body: { status: "ok", admitted: true, grant: { grant_id: "g1", replayed: true } } }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"]);
  assert.ok(outcome.notices.some((n) => n.startsWith("owner_review_granted:g1")));
  // Not deployed yet, or refused: enforced, it rejects; not enforced, a notice.
  ({ outcome } = await run({ status: 404, body: { code: "PGRST202" } }));
  assert.equal(outcome.admitted, false);
  assert.match(outcome.reasons[0], /^owner_review_unavailable:rpc_unavailable/);
  // Re-review 9, NIT: not enforced, the door is not asked (no Owner request).
  let calls2;
  ({ outcome, calls: calls2 } = await run(pending, { CLUED_OWNER_REVIEW_ENFORCE: "" }));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"]);
  assert.ok(outcome.notices.some((n) => /^not enforced \(CLUED_OWNER_REVIEW_ENFORCE is not set\): an Owner Grant on a{40} would be needed/.test(n)));
  assert.ok(!calls2.some((c) => c.url.endsWith(OWNER_REVIEW_RPC)));
  // Re-review 9, MINOR-4: a server error is "transient", still a rejection at admission time.
  ({ outcome } = await run({ status: 502, body: null }));
  assert.equal(outcome.owner_review.kind, "transient");
  assert.match(outcome.reasons[0], /^owner_review_unavailable:transient/);
  // A pull request already rejected for its claim does not ask the Owner.
  const rejected = fakeFetch({ [FILES]: protectedFiles, [VERIFY]: { body: { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } },
    [COMPARE]: { body: { status: "ahead" } }, [DOOR]: pending });
  outcome = await evaluateIn({ env: env({ CLUED_OWNER_REVIEW_ENFORCE: "true" }), event: withClaim(), eventName: "pull_request", fetchImpl: rejected.fetchImpl });
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
  const run = async (tipAnswer, extraEnv = { CLUED_OWNER_REVIEW_ENFORCE: "true" }, prFiles = files) => {
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
  // Not enforced: a notice only, and the door is not asked.
  ({ outcome, calls } = await run({ body: { status: "diverged", files: [{ filename: ".github/workflows/x.yml" }] } }, {}));
  assert.deepEqual([outcome.admitted, outcome.verdict], [true, "ADMITTED"]);
  assert.ok(outcome.notices.some((n) => n.includes(`would first need main at ${TIP}`)));
  assert.ok(!asked(calls));
});

test("owner review (re-review 10, MINOR-1): the note's path names are plain and only the first ten are listed", async () => {
  const DOOR = `POST ${PUBLIC.url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
  const many = { body: [{ filename: ".github/workflows/safe <b>docs</b> only — approve.yml" },
    ...Array.from({ length: 11 }, (_, i) => ({ filename: `scripts/ci/f${i}.mjs` }))] };
  const { fetchImpl, calls } = fakeFetch({ [FILES]: many, [COMPARE]: { body: { status: "ahead" } }, [VERIFY]: { body: admittedPayload },
    [DOOR]: { body: { status: "ok", admitted: false, owner_request: { request_id: "r1", status: "pending", confirm_path: "/confirm/r1" } } } });
  await evaluateIn({ env: env({ CLUED_OWNER_REVIEW_ENFORCE: "true" }), event: withClaim(), eventName: "pull_request", fetchImpl });
  const note = calls.find((c) => c.url.endsWith(OWNER_REVIEW_RPC)).body.p_input.note;
  assert.match(note, /^o\/r#452 @ aaaaaaaaaaaa: 12 protected path\(s\) changed, see https:\/\/github\.com\/o\/r\/compare\//);
  assert.ok(!note.includes("<b>") && !note.includes("—"), note);
  assert.match(note, /, and 2 more\)$/);
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
  const result = await reverify({ env: env({ CLUED_OWNER_REVIEW_ENFORCE: "true", CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem() }),
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
  const outcome = await evaluateIn({ env: env({ CLUED_OWNER_REVIEW_ENFORCE: "true" }), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.match(outcome.reasons[0], /^protected_change_not_up_to_date:/);
  assert.ok(!outcome.reasons[0].includes("<b>"), outcome.reasons[0]);
});

// --- Merge slot (agent contract v33 §1.7; Owner Decisions 0edf7889, 2ea795e4).

const SLOT = "merge:o/r:main";
const VERIFIED_AT = "2026-10-06T10:00:00Z";
const slotClaim = (extra = {}) => ({ ...admittedPayload.claim, trigger_refs: [SLOT], merge_slot_until: "2026-10-06T10:45:00Z", ...extra });

test("merge slot: needed only when the head contains the tip; held only while live and named", () => {
  const at = { repository: "o/r", branch: "main", tip: TIP, verifiedAt: VERIFIED_AT };
  assert.equal(MERGE_SLOT_CHECK_NAME, "clued-merge-slot");
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
    ["not_checked", true, /advisory/], ["missing", false, /^Merge slot not held$/], ["unknown", false, /unknown/], ["", false, /unknown/]]) {
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
  assert.equal(mergeSlotOutputs({ admitted: true, enforced: false })[0], "merge_slot=not_checked");
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

test("merge slot: the app-check step posts clued-merge-slot after the admission check, on the same head", async () => {
  const pem = appKeyPem();
  const appEnv = (extra) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "https://api.test", GITHUB_RUN_ID: "77",
    CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: pem, ADMISSION_HEAD_SHA: HEAD, ADMISSION_PR_NUMBER: "452",
    ADMISSION_MERGE_SLOT_REF: SLOT, ADMISSION_CLAIM_ID: CLAIM, ADMISSION_BASE_REF: "main", ...extra });
  const script = () => fakeFetch({
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

test("merge slot: re-verification fails a green clued-merge-slot check whose slot lapsed", async () => {
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
  assert.match(renderReverifySummary(result), /#460: failing clued-merge-slot 5005 posted, Merge slot not held: merge:o\/r:main/);
});

const SLOT_RETURN = `POST ${PUBLIC.url}/rest/v1/rpc/${MERGE_SLOT_RETURN_RPC}`;
test("merge slot: a pull request closed without a merge gives its slot back; a merge reports what it returned", async () => {
  const closed = () => merged({ pull_request: { merged: false, merge_commit_sha: null } });
  let { fetchImpl, calls } = fakeFetch({ [SLOT_RETURN]: { body: { status: "ok", returned: true, pr_ref: "o/r#452", merge_slot_returned: [CLAIM] } } });
  let r = await adoptMerged({ env: env(), event: closed(), eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.deepEqual([r.adopted, r.error, r.closed_unmerged, r.merge_slot_returned], [false, null, true, [CLAIM]]);
  assert.match(r.reason, /merge slot returned/);
  assert.deepEqual(calls.map((c) => c.url), [`${PUBLIC.url}/rest/v1/rpc/${MERGE_SLOT_RETURN_RPC}`]);
  assert.deepEqual(calls[0].body, { p_token_hash: sha256Hex("clued_bnd_test"), p_input: { scope: "global", pr_ref: "o/r#452" } });
  // Nothing held, not deployed yet, no trailer, no token: quiet.
  for (const [script, reason] of [[{ [SLOT_RETURN]: { body: { status: "ok", returned: false, merge_slot_returned: [] } } }, /no merge slot held/],
    [{ [SLOT_RETURN]: { status: 404, body: { code: "PGRST202" } } }, /not deployed/]]) {
    r = await adoptMerged({ env: env(), event: closed(), eventName: "pull_request_target", fetchImpl: fakeFetch(script).fetchImpl, workspace: ROOT });
    assert.deepEqual([r.error, reason.test(r.reason)], [null, true]);
  }
  ({ fetchImpl, calls } = fakeFetch({ [COMMIT]: { body: { commit: { message: "no trailer" } } } }));
  r = await adoptMerged({ env: env(), event: merged({ body: "none", pull_request: { merged: false } }), eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.match(r.reason, /no Clued-Work-Claim trailer/);
  assert.ok(!calls.some((c) => c.url.startsWith(PUBLIC.url)));
  r = await adoptMerged({ env: env({ CLUED_CONTEXT_READ_TOKEN: "" }), event: closed(), eventName: "pull_request_target", fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
  assert.match(r.reason, /not set/);
  // Refusals are errors.
  for (const script of [{ [SLOT_RETURN]: { body: { status: "ok", returned: false, reason: "admission_binding_required" } } },
    { [SLOT_RETURN]: { status: 400, body: { code: "22023", message: "work_claim_pr_ref_invalid" } } }, {}]) {
    r = await adoptMerged({ env: env(), event: closed(), eventName: "pull_request_target", fetchImpl: fakeFetch(script).fetchImpl, workspace: ROOT });
    assert.ok(r.error, JSON.stringify(script));
  }
  // A merge: adoption answers with the slots it returned.
  ({ fetchImpl } = fakeFetch({ [ADOPT]: { body: { status: "ok", adopted: false, reason: "no_copy_for_pr", merge_slot_returned: [CLAIM] } } }));
  r = await adoptMerged({ env: env(), event: merged(), eventName: "pull_request_target", fetchImpl, workspace: ROOT });
  assert.deepEqual([r.adopted, r.reason, r.error, r.merge_slot_returned], [false, "no_copy_for_pr", null, [CLAIM]]);
});

test("merge slot (review MINOR-2/3/4): advisory runs do not enforce it; a transient door or a failed post does not stop re-verification", async () => {
  // Advisory admission: the slot is reported but not checked.
  const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "ahead", files: [] } },
    [VERIFY]: { body: { ...admittedPayload, verified_at: VERIFIED_AT, claim: slotClaim({ merge_slot_until: null }) } } });
  const advisory = await evaluateIn({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.deepEqual([advisory.admitted, advisory.merge_slot.state, advisory.merge_slot.observed], [true, "not_checked", "missing"]);
  assert.equal(mergeSlotOutputs(advisory)[0], "merge_slot=not_checked");

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
  assert.match(result.errors[0].error, /clued-merge-slot/);
  assert.deepEqual(result.blocked.map((b) => [b.pr, b.check ?? APP_CHECK_NAME]), [[470, APP_CHECK_NAME]]);
  assert.deepEqual(calls.filter((c) => c.method === "POST" && c.url.endsWith("/check-runs")).map((c) => [c.body.name, c.body.conclusion]),
    [[MERGE_SLOT_CHECK_NAME, "failure"], [APP_CHECK_NAME, "failure"]]);

  // #471: a protected change whose Owner review door is down: neither check is touched.
  const other = "1f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
  ({ fetchImpl: f1, calls } = reverifyScript([freshPull({ number: 471, head: { sha: sha("5") }, body: `x\n\nClued-Work-Claim: ${other}` })],
    (head) => both(head, 471)));
  const protectedFiles = async (url, init) => (String(url).startsWith("https://api.test/repos/o/r/pulls/471/files")
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ filename: "scripts/ci/x.mjs" }, { filename: "docs/x.md" }], text: async () => "" }
    : f1(url, init));
  result = await reverify({ env: env({ CLUED_ADMISSION_APP_ID: "12345", CLUED_ADMISSION_APP_PRIVATE_KEY: appKeyPem(), CLUED_OWNER_REVIEW_ENFORCE: "true" }),
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
    const outcome = await evaluateIn({ env: env({ CLUED_OWNER_REVIEW_ENFORCE: "true" }), event: withClaim(), eventName: "pull_request", fetchImpl });
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
