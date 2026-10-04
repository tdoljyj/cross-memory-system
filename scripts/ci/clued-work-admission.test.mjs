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
  gateFindings,
  jobIsHosted,
  jobTimeout,
  rerunAttempt,
  workflowFormFindings,
  workflowIsGated,
  workflowJobs,
} from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAIM = "0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const CLAIM_BASE = "c".repeat(40);
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
    const responder = key ? script[key] : undefined;
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
// The gate's own run (GITHUB_RUN_ID 9001): only App checks posted since it was
// created count (re-review 3, N-R1).
const THIS_RUN = `GET https://api.test/repos/o/r/actions/runs/9001`;
const RUN_CREATED = "2026-10-02T04:00:00Z";
const SELF_RUN = { [THIS_RUN]: { body: { id: 9001, run_attempt: 1, created_at: RUN_CREATED } } };
const appCheckRun = (overrides = {}) => ({ id: 1, name: "clued-admission-verified", head_sha: HEAD, status: "completed",
  conclusion: "success", started_at: "2026-10-02T04:00:40Z", app: { id: ADMISSION_APP_ID, slug: "clued-admission" }, ...overrides });
const checksReturn = (list) => ({ ...SELF_RUN, [CHECKS]: { body: { check_runs: list } } });
const RERUN = `POST https://api.test/repos/o/r/actions/runs/`;
const COMMIT = `GET https://api.test/repos/o/r/commits/`;
const COMPARE = `GET https://api.test/repos/o/r/compare/`;
const RUNS = `GET https://api.test/repos/o/r/actions/runs`;
const VERIFY = `POST ${RPC_URL}`;
const files = { body: [{ filename: "apps/clued-cloud/package.json" }, { filename: "docs/new.md", previous_filename: "docs/old.md" }] };
const admittedPayload = { status: "ok", verdict: "ADMITTED", reasons: [], paths_outside_write_set: [], current_fence: 1, claim: { claim_id: CLAIM, task_id: "t-1", status: "ACTIVE", fence: 1, expires_at: "2026-10-01T13:00:00Z", base_commit: CLAIM_BASE, write_set: ["apps/clued-cloud/**", "docs/**"], holder_binding_id: "should-not-leak" } };
const withClaim = () => event({ body: `Body\n\nClued-Work-Claim: ${CLAIM}` });
const evaluateIn = (options) => evaluate({ workspace: ROOT, ...options });

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
    p_input: { scope: "global", claim_id: CLAIM, changed_paths: ["apps/clued-cloud/package.json", "docs/new.md", "docs/old.md"], head_sha: HEAD, base_sha: BASE, pr_ref: "o/r#452" },
  });
  assert.equal(sha256Hex("clued_bnd_test").length, 64);
  assert.ok(!JSON.stringify(call.body).includes("clued_bnd_test"), "only the hash leaves the runner");
  assert.ok(calls.find((c) => c.url.includes("/compare/")).url.endsWith(`/compare/${CLAIM_BASE}...${BASE}`));
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
  assert.ok(!calls.some((c) => c.url.includes("/compare/")), "no base comparison after a rejection");
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
  assert.match(read("s1"), /\| `clued-cloud-node22-install\.yml` \| yes \| matches apps\/clued-cloud\/package\.json \| none \|/);

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

test("reverify: a passing run whose claim no longer admits is re-run; admitted, red, draft and errored PRs are left alone", async () => {
  const pulls = [
    freshPull({ number: 452 }), // claim expired since its check passed
    freshPull({ number: 453, head: { sha: "e".repeat(40) } }), // still admitted
    freshPull({ number: 454, head: { sha: "f".repeat(40) } }), // last run already failed
    freshPull({ number: 455, draft: true }),
    freshPull({ number: 456, head: { sha: "9".repeat(40) } }), // runs lookup fails
  ];
  const runsFor = (sha) => {
    if (sha === "d".repeat(40)) return [
      { id: 11, event: "pull_request_target", status: "completed", conclusion: "success", created_at: "2026-10-01T10:00:00Z" },
      { id: 10, event: "pull_request_target", status: "completed", conclusion: "failure", created_at: "2026-10-01T09:00:00Z" },
      { id: 12, event: "pull_request", status: "completed", conclusion: "success", created_at: "2026-10-01T10:00:01Z" },
    ];
    if (sha === "e".repeat(40)) return [{ id: 21, event: "pull_request_target", status: "completed", conclusion: "success", created_at: "2026-10-01T10:00:00Z" }];
    if (sha === "f".repeat(40)) return [{ id: 31, event: "pull_request_target", status: "completed", conclusion: "failure", created_at: "2026-10-01T10:00:00Z" }];
    return null;
  };
  const verdictFor = (claim) => claim === CLAIM ? { ...admittedPayload, verdict: "REJECTED", reasons: ["claim_not_current"] } : admittedPayload;
  const other = "1f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f";
  pulls[1].body = `x\n\nClued-Work-Claim: ${other}`;
  const script = {
    [OPEN_PULLS]: { body: pulls },
    [ADMISSION_RUNS]: (call) => {
      const runs = runsFor(new URL(call.url).searchParams.get("head_sha"));
      return runs ? { body: { workflow_runs: runs } } : { status: 500, body: { message: "boom" } };
    },
    [RERUN]: { status: 201, body: null },
    [COMPARE]: { body: { status: "ahead" } },
    [VERIFY]: (call) => ({ body: verdictFor(call.body.p_input.claim_id) }),
  };
  for (const pull of pulls) {
    script[`GET https://api.test/repos/o/r/pulls/${pull.number}/files`] = files;
    script[`GET https://api.test/repos/o/r/pulls/${pull.number}`] = { body: pull };
  }
  const { fetchImpl, calls } = fakeFetch(script);
  const result = await reverify({ env: env(), fetchImpl, workspace: ROOT });
  assert.deepEqual(result.checked.map((c) => [c.pr, c.verdict]), [[452, "REJECTED"], [453, "ADMITTED"]]);
  assert.deepEqual(result.reran.map((r) => [r.pr, r.run_id, r.event]), [[452, 11, "pull_request_target"], [452, 12, "pull_request"]]);
  assert.deepEqual(result.errors.map((e) => e.pr), [456]);
  assert.deepEqual(calls.filter((c) => c.method === "POST" && c.url.includes("/rerun")).map((c) => c.url),
    ["https://api.test/repos/o/r/actions/runs/11/rerun", "https://api.test/repos/o/r/actions/runs/12/rerun"]);
  assert.ok(!calls.some((c) => c.url.includes("/pulls/455")), "drafts are skipped");
  assert.match(renderReverifySummary(result), /#452: run 11 \(pull_request_target\) re-run, REJECTED: claim_not_current/);

  const advisory = await reverify({ env: env({ CLUED_WORK_ADMISSION_ENFORCE: "" }), fetchImpl: fakeFetch({}).fetchImpl, workspace: ROOT });
  assert.match(advisory.skipped, /advisory/);
  assert.match(renderReverifySummary(advisory), /Skipped/);
});

test("main --mode reverify: exit 1 only when a PR could not be re-verified", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clued-work-admission-reverify-"));
  const out = path.join(dir, "summary.md");
  let code = await main(["--mode", "reverify"], { ...env(), GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: out }, fakeFetch({ [OPEN_PULLS]: { body: [] } }).fetchImpl);
  assert.equal(code, 0);
  assert.match(fs.readFileSync(out, "utf8"), /re-runs requested: 0/);
  code = await main(["--mode", "reverify"], { ...env(), GITHUB_WORKSPACE: ROOT, GITHUB_STEP_SUMMARY: out },
    fakeFetch({ [OPEN_PULLS]: { body: [freshPull()] }, [ADMISSION_RUNS]: { status: 500, body: null } }).fetchImpl);
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
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "NO_ADMISSION_RUN"]);
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
  assert.deepEqual([fork.admitted, fork.verdict], [false, "NO_ADMISSION_RUN"]);
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

test("gate (re-review 2, N3c): reads the clued-admission App's check on the head, never a workflow run", async () => {
  const check = appCheckRun;
  const gateWith = async (list, extraEnv = {}, sleeps = []) => {
    const { fetchImpl, calls } = fakeFetch({ ...SELF_RUN, [CHECKS]: () => ({ body: { check_runs: typeof list === "function" ? list() : list } }),
      [ADMISSION_RUNS]: { body: { workflow_runs: [{ id: 9, event: "pull_request_target", head_sha: HEAD, status: "completed",
        conclusion: "success", created_at: "2026-10-02T04:00:00Z", pull_requests: [{ number: 452 }] }] } } });
    const outcome = await gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0", ...extraEnv }),
      event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
    return { outcome, calls };
  };
  let { outcome, calls } = await gateWith([check({})]);
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_run.id], [true, "ADMITTED", 1]);
  assert.equal(calls.length, 2, "its own run, then the checks; no workflow run is consulted");
  assert.match(calls[0].url, /\/actions\/runs\/9001$/);
  assert.match(calls[1].url, /check-runs\?check_name=clued-admission-verified&filter=all/);
  // A successful admission run (for instance one of a pull request into
  // another branch that lists this one) does not admit without the App check.
  ({ outcome, calls } = await gateWith([]));
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "NO_ADMISSION_RUN"]);
  assert.ok(!calls.some((c) => c.url.includes("/actions/workflows/")));
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
  assert.equal(gated.length, 7);
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
  assert.deepEqual(GATED_FILES.sort(), [
    "clued-cloud-node22-install.yml", "clued-connection-authorization.yml", "clued-g4-database.yml",
    "design-refs.yml", "information-flow-e2e.yml", "public-mcp-behavior.yml", "public-mcp-protocol.yml",
  ]);
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
  const { fetchImpl, calls } = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } },
    [CONTENTS]: (call) => (call.url.endsWith(`?ref=${HEAD}`) ? b64(stripped) : b64(g4)) });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["workflow_gate:.github/workflows/clued-g4-database.yml:job_not_gated:database-gate-trusted-self-hosted"]);
  assert.ok(!calls.some((c) => c.url.includes("old.yml")), "removed workflows are not read");
  // Re-review N8: a PR the guard refuses is verified read-only, so it neither
  // binds the claim nor uses the Task's CI budget.
  const refusedVerify = calls.find((c) => c.method === "POST");
  assert.deepEqual(Object.keys(refusedVerify.body.p_input).sort(), ["changed_paths", "claim_id", "scope"]);
  // The same PR with the gate intact is admitted.
  const intact = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } }, [CONTENTS]: b64(g4) });
  const ok = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl: intact.fetchImpl });
  assert.deepEqual([ok.admitted, ok.reasons], [true, []]);
  // Advisory: reported, not blocking.
  const advisory = fakeFetch({ [FILES]: workflowFiles, [VERIFY]: { body: admittedPayload }, [COMPARE]: { body: { status: "ahead" } },
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
  }
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
  // Re-review 3, N-R4: the admission job checks out the base branch as it is
  // now, not the event's base commit that a re-run would replay.
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}\n[\s\S]*--mode required/);
  assert.doesNotMatch(text, /pull_request\.base\.sha/);
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

  // No Clued call at all: closed without merging, other events, no trailer, no token.
  for (const [value, name] of [[merged({ pull_request: { merged: false } }), "pull_request_target"],
    [merged({ action: "synchronize" }), "pull_request_target"], [merged(), "pull_request"]]) {
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

test("adopt: the admission workflow runs it only for a merged pull request, from the base branch", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-work-admission.yml"), "utf8");
  assert.match(text, /types: \[opened, synchronize, reopened, edited, ready_for_review, closed\]/);
  assert.match(text, /clued-work-admission:\n {4}name: clued-work-admission\n {4}if: github\.event\.action != 'closed'\n/);
  const job = text.slice(text.indexOf("  clued-work-adopt:"));
  assert.match(job, /if: github\.event\.action == 'closed' && github\.event\.pull_request\.merged == true\n/);
  assert.match(job, /^ {4}environment: clued-admission$/m);
  assert.match(job, /ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}\n {10}persist-credentials: false/);
  assert.match(job, /--mode adopt$/m);
  assert.doesNotMatch(job, /head\.sha|head\.ref|merge_commit_sha/);
});

// --- Re-review 3 (main d0100ff4).

test("gate (re-review 3, N-R1): an App check posted before this run was created never admits it", async () => {
  const gateWith = async (list, extraEnv = {}) => {
    const { fetchImpl, calls } = fakeFetch(checksReturn(list));
    const outcome = await gate({ env: env({ CLUED_CONTEXT_READ_TOKEN: "", CLUED_ADMISSION_GATE_WAIT_SECONDS: "0", ...extraEnv }),
      event: withClaim(), eventName: "pull_request", fetchImpl, sleep: async () => {} });
    return { outcome, calls };
  };
  // An older success on the same head (a force-push back to an admitted
  // commit, a reopened pull request, a second pull request with this head).
  let { outcome } = await gateWith([appCheckRun({ id: 5, started_at: "2026-10-02T03:59:59Z" })]);
  assert.deepEqual([outcome.admitted, outcome.verdict], [false, "NO_ADMISSION_RUN"]);
  assert.match(outcome.reasons[0], /posted since 2026-10-02T04:00:00Z/);
  // A newer id does not help an older check; the posting time decides.
  ({ outcome } = await gateWith([appCheckRun({ id: 9, started_at: "2026-10-02T03:00:00Z" }), appCheckRun({ id: 3, conclusion: "failure" })]));
  assert.deepEqual([outcome.admitted, outcome.verdict, outcome.admission_run.id], [false, "REJECTED", 3]);
  // A check without a posting time does not count.
  ({ outcome } = await gateWith([appCheckRun({ started_at: null, completed_at: null })]));
  assert.equal(outcome.admitted, false);
  ({ outcome } = await gateWith([appCheckRun({ started_at: RUN_CREATED })]));
  assert.equal(outcome.admitted, true, "posted the same second the run was created");
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
