import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_CONFIG_SOURCE,
  evaluate,
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

test("enforced: a claim taken on a newer base than the PR targets is rejected", async () => {
  const { fetchImpl } = fakeFetch({ [FILES]: files, [COMPARE]: { body: { status: "behind" } }, [VERIFY]: { body: admittedPayload } });
  const outcome = await evaluateIn({ env: env(), event: withClaim(), eventName: "pull_request", fetchImpl });
  assert.equal(outcome.admitted, false);
  assert.deepEqual(outcome.reasons, ["base_behind_claim:behind"]);
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

  code = await main(["--mode", "gate"], { ...base, GITHUB_OUTPUT: out("o2"), GITHUB_STEP_SUMMARY: out("s2") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 0, "the gate job itself succeeds; heavy jobs read admitted=false");
  assert.match(read("o2"), /^admitted=false$/m);
  assert.ok(!read("s2").includes("| Workflow |"), "gate mode writes no workflow table");

  code = await main(["--mode", "gate"], { ...base, CLUED_CONTEXT_READ_TOKEN: "", GITHUB_OUTPUT: out("o3"), GITHUB_STEP_SUMMARY: out("s3") }, fakeFetch(rejected).fetchImpl);
  assert.equal(code, 1, "enforced + missing token is an error in every mode");
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
