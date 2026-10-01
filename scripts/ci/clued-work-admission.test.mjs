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
    p_input: { scope: "global", claim_id: CLAIM, changed_paths: ["apps/clued-cloud/package.json", "docs/new.md", "docs/old.md"], head_sha: HEAD, base_sha: BASE },
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
