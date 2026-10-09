// Merge Admission v0.1 §12.1: CI usage measurement (ci-usage-report.mjs).
// No network: fetch is mocked, and no GitHub request is ever made.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CACHE_FILE,
  CACHE_SCHEMA,
  NOT_MEASURED,
  APP_REQUEST_CAP,
  MEASURE_PERMISSIONS,
  REQUEST_CAP,
  RUN_LIST_CAP,
  TIME_BUDGET_MS,
  budgetedFetch,
  cachedJobs,
  collectUsage,
  computeMetrics,
  countBy,
  createBudget,
  durationMinutes,
  emptyCache,
  fetchPaged,
  isGateJob,
  isSelfHosted,
  loadCache,
  main,
  mergeCache,
  parseDays,
  percentile,
  pruneCache,
  renderSummary,
  runsOfPull,
  sumBy,
  daysOf,
  windowOf,
} from "./ci-usage-report.mjs";
import { gateFindings, workflowFormFindings } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "tdoljyj/cross-memory-system";
const NOW = new Date("2026-10-09T12:00:00Z");
const WINDOW = windowOf(NOW, 7);
const SELF = ["self-hosted", "Linux", "X64", "clued", "pool-general", "trust-internal"];
const HOSTED = ["ubuntu-latest"];
const sha = (n) => String(n).padStart(40, "0");

const run = (id, extra = {}) => ({ id, name: "w", path: ".github/workflows/w.yml@refs/pull/1/merge", event: "pull_request", status: "completed",
  conclusion: "success", run_attempt: 1, head_branch: "feature", head_sha: sha(id), created_at: "2026-10-05T10:00:00Z", pull_requests: [], ...extra });
const job = (id, { name = "build", labels = SELF, created = "2026-10-05T10:00:00Z", started = "2026-10-05T10:02:00Z",
  completed = "2026-10-05T10:12:00Z", conclusion = "success", status = "completed", attempt = 1 } = {}) =>
  ({ id, name, labels, created_at: created, started_at: started, completed_at: completed, conclusion, status, run_attempt: attempt, steps: [{ big: true }] });
const pr = (number, extra = {}) => ({ number, head: { ref: `branch-${number}` }, created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-06T00:00:00Z", merged_at: "2026-10-06T00:00:00Z", ...extra });

// A GitHub of runs, pull requests and jobs. remaining(n) is the
// x-ratelimit-remaining header of the n-th response (1-based); answer(route, n)
// may return a Response to override the default one.
function fakeGitHub({ runs = [], pulls = [], jobs = {}, remaining = () => 4000, answer = () => null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url).replace(/^https:\/\/api\.github\.com/, "");
    calls.push({ route, headers: init.headers, body: init.body });
    const n = calls.length;
    const headers = { "content-type": "application/json", "x-ratelimit-remaining": String(remaining(n)), "x-ratelimit-limit": "1000" };
    const special = answer(route, n, headers);
    if (special) return special;
    const page = Number(new URL(`https://x${route}`).searchParams.get("page") ?? 1);
    const slice = (items) => items.slice((page - 1) * 100, page * 100);
    let body = null;
    if (route.startsWith(`/repos/${REPO}/actions/runs?created=`)) {
      // Like GitHub: ">=date" lists at most 1,000 runs; "date" lists that day's runs, also at most 1,000.
      const created = new URL(`https://x${route}`).searchParams.get("created");
      const matching = created.startsWith(">=") ? runs : runs.filter((r) => r.created_at.startsWith(created));
      body = { total_count: matching.length, workflow_runs: page > 10 ? [] : slice(matching) };
    }
    else if (route.startsWith(`/repos/${REPO}/pulls?state=closed`)) body = slice(pulls);
    else {
      const match = new RegExp(`^/repos/${REPO}/actions/runs/(\\d+)/jobs\\?filter=all`).exec(route);
      if (match) body = { total_count: (jobs[match[1]] ?? []).length, jobs: slice(jobs[match[1]] ?? []) };
    }
    if (!body) return new Response("not found", { status: 404, headers });
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  return { fetchImpl, calls };
}

// An in-memory file system for main().
function memoryFs(files = new Map()) {
  return {
    files,
    readFile: (file) => { if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return files.get(file); },
    writeFile: (file, text) => files.set(file, String(text)),
    appendFile: (file, text) => files.set(file, (files.get(file) ?? "") + String(text)),
    mkdir: () => {},
    log: () => {},
    logError: () => {},
  };
}
const ENV = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: REPO, GITHUB_WORKSPACE: "/w", GITHUB_STEP_SUMMARY: "/w/summary.md" };
const REPORT = path.join("/w", "ci-usage-report.json");
const CACHE = path.join("/w", ".ci-usage-cache", CACHE_FILE);
const runMain = async (github, memory = memoryFs(), env = {}) => {
  const code = await main({ ...ENV, ...env }, github.fetchImpl, { now: NOW, ...memory });
  const report = memory.files.has(REPORT) ? JSON.parse(memory.files.get(REPORT)) : null;
  return { code, report, memory };
};

test("percentile is nearest-rank; durations and sums ignore what cannot be measured", () => {
  const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
  assert.equal(percentile(ten, 50), 5);
  assert.equal(percentile(ten, 95), 10);
  assert.equal(percentile(ten, 90), 9);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([null, Number.NaN, 3], 50), 3);
  assert.deepEqual(ten, [10, 1, 9, 2, 8, 3, 7, 4, 6, 5], "the input is not sorted in place");
  assert.equal(durationMinutes("2026-10-05T10:00:00Z", "2026-10-05T10:01:30Z"), 1.5);
  assert.equal(durationMinutes(null, "2026-10-05T10:00:00Z"), null);
  assert.equal(durationMinutes("2026-10-05T10:00:00Z", "2026-10-05T09:00:00Z"), null);
  assert.deepEqual(sumBy([{ k: "a", v: 1 }, { k: "b", v: 5 }, { k: "a", v: 2.26 }], (x) => x.k, (x) => x.v), { b: 5, a: 3.3 });
  assert.deepEqual(countBy(["x", "y", "x"], (x) => x), { x: 2, y: 1 });
});

test("days: 7 by default, an integer from 1 to 14; the window starts at midnight UTC", () => {
  assert.equal(parseDays(undefined), 7);
  assert.equal(parseDays(""), 7);
  assert.equal(parseDays("14"), 14);
  assert.equal(parseDays(1), 1);
  for (const bad of ["0", "15", "3.5", "-1", "7d"]) assert.throws(() => parseDays(bad), /integer from 1 to 14/, bad);
  assert.deepEqual(WINDOW, { days: 7, start: "2026-10-02T00:00:00.000Z", end: "2026-10-09T12:00:00.000Z", start_date: "2026-10-02" });
});

test("budget: the request cap stops at 200 requests and the report states partial coverage", async () => {
  // 250 runs (3 pages), 1 page of pull requests, then one jobs list per run.
  const runs = Array.from({ length: 250 }, (_, i) => run(i + 1));
  const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(r.id * 10)]]));
  const github = fakeGitHub({ runs, jobs, pulls: [pr(1)] });
  const { code, report, memory } = await runMain(github);
  assert.equal(code, 0, "stopping early is not an error");
  assert.equal(github.calls.length, REQUEST_CAP);
  assert.equal(report.metrics.api_requests.used, 200);
  assert.equal(report.metrics.api_requests.stopped, "request_cap");
  assert.deepEqual([report.coverage.runs_listed, report.coverage.runs_completed, report.coverage.runs_with_jobs, report.coverage.partial],
    [250, 250, 196, true]);
  assert.equal(report.metrics.self_hosted_minutes.status, "partial");
  assert.equal(report.metrics.reruns.status, "measured", "the run list itself was complete");
  assert.match(memory.files.get(ENV.GITHUB_STEP_SUMMARY), /job details for 196 of 250 completed runs/);
  assert.match(memory.files.get(ENV.GITHUB_STEP_SUMMARY), /\*\*Partial coverage\*\* \(stopped: request_cap\)/);
  // The 196 runs read are cached, so the next run reads the other 54 only.
  const next = fakeGitHub({ runs, jobs, pulls: [pr(1)] });
  const again = await runMain(next, memory);
  assert.equal(next.calls.length, 3 + 1 + 54);
  assert.deepEqual([again.report.coverage.runs_from_cache, again.report.coverage.runs_fetched_now, again.report.coverage.partial], [196, 54, false]);
  assert.equal(again.report.metrics.self_hosted_minutes.status, "measured");
  assert.equal(again.report.metrics.self_hosted_minutes.total, 2500);
});

test("budget: below 600 remaining the run stops before the next batch of 20, not in the middle of one", async () => {
  const runs = Array.from({ length: 60 }, (_, i) => run(i + 1));
  const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(r.id * 10)]]));
  // 599 from the 5th response on: the batch of 20 ends, then the run stops.
  let github = fakeGitHub({ runs, jobs, remaining: (n) => (n < 5 ? 900 : 599) });
  let { code, report } = await runMain(github);
  assert.equal(code, 0);
  assert.equal(github.calls.length, 20);
  assert.equal(report.metrics.api_requests.stopped, "rate_limit_floor");
  assert.equal(report.metrics.api_requests.remaining_seen, 599);
  assert.deepEqual([report.coverage.runs_with_jobs, report.coverage.runs_completed], [18, 60]);
  // 600 is not below the floor.
  github = fakeGitHub({ runs, jobs, remaining: () => 600 });
  ({ report } = await runMain(github));
  assert.equal(github.calls.length, 62);
  assert.equal(report.coverage.partial, false);
  // The budget object on its own: no request once stopped.
  const budget = createBudget({ cap: 3 });
  const request = budgetedFetch(fakeGitHub({ runs }).fetchImpl, ENV, budget);
  for (let i = 0; i < 3; i += 1) assert.equal((await request(`/repos/${REPO}/actions/runs?created=x`)).ok, true);
  assert.deepEqual(await request(`/repos/${REPO}/actions/runs?created=x`), { ok: false, stopped: "request_cap" });
  assert.equal(budget.used, 3);
});

test("budget: a rate-limited answer stops without retry; any other failure is an error", async () => {
  const runs = [run(1), run(2), run(3)];
  const jobs = { 1: [job(1)], 2: [job(2)], 3: [job(3)] };
  for (const limited of [
    (headers) => new Response("{}", { status: 403, headers: { ...headers, "x-ratelimit-remaining": "0" } }),
    (headers) => new Response("{}", { status: 403, headers: { ...headers, "retry-after": "60" } }),
    (headers) => new Response("{}", { status: 429, headers }),
  ]) {
    const github = fakeGitHub({ runs, jobs, answer: (route, n, headers) => (n === 4 ? limited(headers) : null) });
    const { code, report } = await runMain(github);
    assert.equal(code, 0);
    assert.equal(github.calls.length, 4, "no retry, no further request");
    assert.equal(report.metrics.api_requests.stopped, "rate_limited");
    assert.deepEqual([report.coverage.runs_with_jobs, report.coverage.runs_completed], [1, 3]);
  }
  // A plain 403 (no rate-limit headers) or a 500 is unexpected: exit 1, no report.
  for (const status of [403, 500]) {
    const github = fakeGitHub({ runs, jobs, answer: (route, n, headers) => (n === 2 ? new Response("{}", { status, headers }) : null) });
    const errors = [];
    const memory = { ...memoryFs(), logError: (line) => errors.push(line) };
    const { code, report } = await runMain(github, memory);
    assert.equal(code, 1);
    assert.equal(report, null);
    assert.equal(github.calls.length, 2);
    assert.match(errors.join("\n"), new RegExp(`::error title=clued-ci-usage-report::GitHub API .* returned ${status}`));
  }
  // No token, or an invalid window: exit 1 before any request.
  const github = fakeGitHub({ runs });
  assert.equal((await runMain(github, memoryFs(), { GITHUB_TOKEN: "" })).code, 1);
  assert.equal((await runMain(github, memoryFs(), { CI_USAGE_DAYS: "30" })).code, 1);
  assert.equal(github.calls.length, 0);
});

test("requests: authenticated with the token, the window's date, jobs of every attempt, nothing per pull request", async () => {
  const github = fakeGitHub({ runs: [run(1)], jobs: { 1: [job(1)] }, pulls: [pr(1)] });
  await runMain(github);
  assert.deepEqual(github.calls.map((call) => call.route), [
    `/repos/${REPO}/actions/runs?created=%3E%3D2026-10-02&per_page=100&page=1`,
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1`,
    `/repos/${REPO}/actions/runs/1/jobs?filter=all&per_page=100&page=1`,
  ]);
  assert.equal(github.calls[0].headers.authorization, "Bearer t");
});

// The measurement App (Owner Decision 00b71629): GET installation and POST
// access_tokens answered by `app`, everything else by the GitHub of runs.
const APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const APP_ENV = { CLUED_MEASURE_APP_ID: "4242", CLUED_MEASURE_APP_KEY: APP_KEY };
const withApp = ({ installation = 200, minted = 201 } = {}) => (route, n, headers) => {
  if (route === `/repos/${REPO}/installation`) {
    return new Response(JSON.stringify(installation === 200 ? { id: 77 } : { message: "Not Found" }), { status: installation, headers });
  }
  if (route === "/app/installations/77/access_tokens") {
    return new Response(JSON.stringify(minted === 201 ? { token: "app-token" } : { message: "denied" }), { status: minted, headers });
  }
  return null;
};

test("measurement App: its read-only installation token reads everything, with the larger cap and outside the GITHUB_TOKEN pool", async () => {
  const runs = Array.from({ length: 250 }, (_, i) => run(i + 1));
  const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(r.id * 10)]]));
  const github = fakeGitHub({ runs, jobs, pulls: [pr(1)], answer: withApp() });
  const { code, report, memory } = await runMain(github, memoryFs(), APP_ENV);
  assert.equal(code, 0);
  const [installation, minted, ...reads] = github.calls;
  assert.equal(installation.route, `/repos/${REPO}/installation`);
  assert.match(installation.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/, "signed with the App's JWT");
  assert.equal(minted.route, "/app/installations/77/access_tokens");
  assert.deepEqual(JSON.parse(minted.body), { repositories: ["cross-memory-system"], permissions: MEASURE_PERMISSIONS });
  assert.deepEqual(Object.values(MEASURE_PERMISSIONS), ["read", "read", "read", "read", "read"]);
  assert.ok(reads.every((call) => call.headers.authorization === "Bearer app-token"), "never the GITHUB_TOKEN");
  assert.equal(reads.length, 3 + 1 + 250);
  assert.deepEqual([report.coverage.runs_with_jobs, report.coverage.partial], [250, false]);
  assert.deepEqual([report.metrics.api_requests.token_source, report.metrics.api_requests.cap, report.metrics.api_requests.used],
    ["app", APP_REQUEST_CAP, 254]);
  assert.match(report.metrics.api_requests.not_measured.by_pool, /App's quota is its own/);
  assert.match(memory.files.get(ENV.GITHUB_STEP_SUMMARY), /254 of 2000 \(measurement App\)/);
});

test("measurement App: not configured, not installed or refused falls back to the GITHUB_TOKEN with its cap and says why", async () => {
  for (const [name, env, answer, reason] of [
    ["not configured", {}, () => null, /not configured/],
    ["half configured", { CLUED_MEASURE_APP_ID: "4242" }, () => null, /not configured/],
    ["not installed", APP_ENV, withApp({ installation: 404 }), /not installed .* or not authenticated .*returned 404/],
    ["not authenticated", APP_ENV, withApp({ installation: 401 }), /or not authenticated .*returned 401/],
    ["refused", APP_ENV, withApp({ minted: 422 }), /token was refused .*returned 422/],
    // Review MINOR-2: a key that cannot sign, or a failing request, falls back too.
    ["malformed key", { ...APP_ENV, CLUED_MEASURE_APP_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nnot a key\\n-----END RSA PRIVATE KEY-----" },
      () => null, /could not be minted \(\w+: /],
    ["network error", APP_ENV, (route) => { if (route.includes("installation")) throw new TypeError("fetch failed"); return null; },
      /could not be minted \(TypeError: fetch failed\)/],
  ]) {
    const github = fakeGitHub({ runs: [run(1)], jobs: { 1: [job(1)] }, pulls: [pr(1)], answer });
    const notices = [];
    const memory = { ...memoryFs(), logError: (line) => notices.push(line) };
    const { code, report } = await runMain(github, memory, env);
    assert.equal(code, 0, name);
    assert.ok(github.calls.filter((call) => !call.route.includes("installation")).every((call) => call.headers.authorization === "Bearer t"), name);
    assert.deepEqual([report.metrics.api_requests.token_source, report.metrics.api_requests.cap], ["github_token", REQUEST_CAP], name);
    assert.ok(notices.some((line) => /^::notice title=clued-ci-usage-report::reading with the GITHUB_TOKEN \(cap 200\)/.test(line) && reason.test(line)), name);
    assert.ok(notices.every((line) => !line.includes("PRIVATE KEY") && !line.includes(APP_KEY.slice(40, 80))), `${name}: no key material`);
  }
  const github = fakeGitHub({ runs: [run(1)], jobs: { 1: [job(1)] }, pulls: [pr(1)] });
  const errors = [];
  const { code } = await runMain(github, { ...memoryFs(), logError: (line) => errors.push(line) }, { GITHUB_TOKEN: "" });
  assert.equal(code, 1, "no App and no GITHUB_TOKEN is an error");
  assert.match(errors.join("\n"), /GITHUB_TOKEN is not set, and the measurement App is not configured/);
  assert.equal(github.calls.length, 0);
});

test("time budget (review MINOR-3): after 15 minutes the run stops, keeps what it read and saves the cache", async () => {
  const runs = Array.from({ length: 30 }, (_, i) => run(i + 1));
  const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(r.id * 10)]]));
  const github = fakeGitHub({ runs, jobs, pulls: [pr(1)] });
  // Each request takes one minute of the clock.
  const clock = () => github.calls.length * 60 * 1000;
  const memory = { ...memoryFs(), clock };
  const { code, report } = await runMain(github, memory);
  assert.equal(code, 0);
  assert.equal(github.calls.length, TIME_BUDGET_MS / 60000);
  assert.deepEqual([report.metrics.api_requests.stopped, report.coverage.partial, report.coverage.runs_with_jobs], ["time_budget", true, 13]);
  assert.equal(Object.keys(JSON.parse(memory.files.get(CACHE)).runs).length, 13);
});

test("measurement App: the installation token is masked in the log", async () => {
  const lines = [];
  const github = fakeGitHub({ runs: [run(1)], jobs: { 1: [job(1)] }, pulls: [pr(1)], answer: withApp() });
  await runMain(github, { ...memoryFs(), log: (line) => lines.push(line) }, APP_ENV);
  assert.equal(lines[0], "::add-mask::app-token");
});

test("run list: a run listed twice (pages shifted by new runs) counts once", async () => {
  const runs = Array.from({ length: 150 }, (_, i) => run(i + 1));
  const jobs = Object.fromEntries(runs.map((r) => [r.id, [job(r.id * 10)]]));
  // Page 2 starts with the last run of page 1 again, as when a new run arrives between the two pages.
  const shifted = (route, n, headers) => (route.includes("actions/runs?created=") && route.endsWith("page=2")
    ? new Response(JSON.stringify({ total_count: 151, workflow_runs: [runs[99], ...runs.slice(100)] }), { status: 200, headers }) : null);
  const github = fakeGitHub({ runs, jobs, pulls: [pr(1)], answer: shifted });
  const { report } = await runMain(github);
  assert.deepEqual([report.coverage.runs_listed, report.coverage.runs_completed, report.coverage.runs_with_jobs, report.coverage.partial],
    [150, 150, 150, false]);
  assert.equal(report.metrics.self_hosted_minutes.jobs, 150);
});

test("run list: a window over GitHub's 1,000-run limit is listed day by day; a day over it is cut short", async () => {
  assert.deepEqual(daysOf(WINDOW), ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  const on = (day, from, count) => Array.from({ length: count }, (_, i) => run(from + i, { created_at: `${day}T10:00:00Z` }));
  // 1,200 runs over three days: the whole window stops at 1,000, each day is under it.
  let runs = [...on("2026-10-03", 1, 400), ...on("2026-10-05", 401, 400), ...on("2026-10-07", 801, 400)];
  let github = fakeGitHub({ runs, jobs: {}, pulls: [pr(1)], answer: withApp() });
  let { report } = await runMain(github, memoryFs(), APP_ENV);
  const lists = github.calls.filter((call) => call.route.includes("actions/runs?created="));
  assert.equal(lists.filter((call) => call.route.includes("created=%3E%3D")).length, RUN_LIST_CAP / 100, "the whole window: 10 full pages, no 11th");
  assert.deepEqual([...new Set(lists.map((call) => new URL(`https://x${call.route}`).searchParams.get("created")).filter((c) => !c.startsWith(">=")))],
    daysOf(WINDOW));
  assert.deepEqual([report.coverage.runs_listed, report.coverage.run_list_by_day, report.coverage.run_list_complete, report.coverage.run_list_days_capped],
    [1200, true, true, []]);
  // 1,100 runs on one day: that day is cut short at 1,000 and the report says so.
  runs = on("2026-10-05", 1, 1100);
  github = fakeGitHub({ runs, jobs: {}, pulls: [pr(1)], answer: withApp() });
  ({ report } = await runMain(github, memoryFs(), APP_ENV));
  assert.deepEqual([report.coverage.runs_listed, report.coverage.run_list_complete, report.coverage.run_list_days_capped, report.coverage.partial],
    [1000, false, ["2026-10-05"], true]);
  assert.match(renderSummary(report), /run list cut short \(over GitHub's 1,000-run limit on 2026-10-05\)/);
});

test("cache: a completed run's jobs are fetched once; running runs are not cached; a re-run is read again", async () => {
  const memory = memoryFs();
  const jobs = { 1: [job(1)], 2: [job(2)], 3: [job(3)] };
  let github = fakeGitHub({ runs: [run(1), run(2), run(3, { status: "in_progress", conclusion: null })], jobs });
  let { report } = await runMain(github, memory);
  assert.equal(github.calls.filter((call) => call.route.includes("/jobs")).length, 2, "the running run is not read");
  assert.equal(report.coverage.runs_in_progress, 1);
  const cache = JSON.parse(memory.files.get(CACHE));
  assert.equal(cache.schema, CACHE_SCHEMA);
  assert.deepEqual(Object.keys(cache.runs).sort(), ["1", "2"]);
  assert.equal(cache.runs["1"].jobs[0].steps, undefined, "only what the metrics need is kept");
  // Next week: run 3 finished, run 2 was re-run (attempt 2): those two are read.
  github = fakeGitHub({ runs: [run(1), run(2, { run_attempt: 2 }), run(3)], jobs });
  ({ report } = await runMain(github, memory));
  assert.deepEqual(github.calls.filter((call) => call.route.includes("/jobs")).map((call) => call.route.split("/")[6]).sort(), ["2", "3"]);
  assert.deepEqual([report.coverage.runs_from_cache, report.coverage.runs_fetched_now], [1, 2]);
  // Pure helpers.
  const fresh = emptyCache(REPO);
  mergeCache(fresh, run(9, { status: "in_progress" }), [job(9)]);
  assert.deepEqual(fresh.runs, {});
  mergeCache(fresh, run(9), [job(9)]);
  assert.equal(cachedJobs(fresh, run(9)).length, 1);
  assert.equal(cachedJobs(fresh, run(9, { run_attempt: 2 })), null);
  mergeCache(fresh, run(8, { created_at: "2026-09-01T00:00:00Z" }), [job(8)]);
  assert.deepEqual(Object.keys(pruneCache(fresh, NOW).runs), ["9"], "older than the longest window: dropped");
  // A foreign, unreadable or missing cache is empty.
  const read = (text) => () => text;
  assert.deepEqual(loadCache("/c", REPO, read("not json")), emptyCache(REPO));
  assert.deepEqual(loadCache("/c", REPO, read(JSON.stringify({ ...emptyCache("other/repo"), runs: { 1: {} } }))), emptyCache(REPO));
  assert.deepEqual(loadCache("/c", REPO, () => { throw new Error("ENOENT"); }), emptyCache(REPO));
});

test("metrics: self-hosted and hosted minutes split; queue, gate and re-run counts", async () => {
  const runs = [
    run(1, { path: ".github/workflows/trivy.yml@refs/heads/main" }),
    run(2, { path: ".github/workflows/design-refs.yml", run_attempt: 2 }),
    run(3, { path: ".github/workflows/design-refs.yml", run_attempt: 3, conclusion: "failure" }),
  ];
  const jobs = {
    // 10 min self-hosted, 2 min queue; 4 min hosted.
    1: [job(11), job(12, { labels: HOSTED, started: "2026-10-05T10:00:00Z", completed: "2026-10-05T10:04:00Z" })],
    // admission-gate: 1 min, queued 6 min; a failed self-hosted build of 20 min.
    2: [job(21, { name: "admission-gate", started: "2026-10-05T10:06:00Z", completed: "2026-10-05T10:07:00Z" }),
      job(22, { started: "2026-10-05T10:00:00Z", completed: "2026-10-05T10:20:00Z", conclusion: "failure" })],
    // A job that never started counts nowhere.
    3: [job(31, { started: null, completed: null, conclusion: "cancelled" })],
  };
  const { report } = await runMain(fakeGitHub({ runs, jobs }));
  const m = report.metrics;
  assert.equal(m.self_hosted_minutes.total, 31);
  assert.deepEqual(m.self_hosted_minutes.by_workflow, { ".github/workflows/design-refs.yml": 21, ".github/workflows/trivy.yml": 10 });
  assert.deepEqual(m.self_hosted_minutes.by_conclusion, { failure: 20, success: 11 });
  assert.equal(m.self_hosted_minutes.by_layer, null);
  assert.match(m.self_hosted_minutes.not_measured.by_layer, /not read in version 1/);
  assert.deepEqual([m.hosted_minutes.total, m.hosted_minutes.jobs], [4, 1]);
  assert.deepEqual([m.queue_minutes.count, m.queue_minutes.p50, m.queue_minutes.p95], [3, 2, 6]);
  assert.deepEqual([m.gate_minutes.total, m.gate_minutes.jobs, m.gate_minutes.self_hosted_jobs], [1, 1, 1]);
  assert.deepEqual([m.gate_queue_minutes.p50, m.gate_queue_minutes.p95], [6, 6]);
  assert.deepEqual([m.reruns.count, m.reruns.by_workflow], [2, { ".github/workflows/design-refs.yml": 2 }]);
  for (const [name, reason] of Object.entries(NOT_MEASURED)) {
    assert.deepEqual(m[name], { status: "not_measured", value: null, reason }, name);
  }
  assert.equal(m.api_requests.used, 5);
  assert.equal(m.api_requests.remaining_seen, 4000);
  assert.equal(m.api_requests.by_pool, null);
  assert.ok(isSelfHosted({ labels: ["Self-Hosted", "Linux"] }));
  assert.ok(!isSelfHosted({ labels: ["ubuntu-latest"] }));
  assert.ok(isGateJob({ name: "caller / admission-gate" }));
  assert.ok(!isGateJob({ name: "admission-gate-extra" }));
  const summary = renderSummary(report);
  assert.match(summary, /\| self_hosted_minutes \| measured \| 31 min in 3 jobs \|/);
  assert.match(summary, /\| `\.github\/workflows\/design-refs\.yml` \| 21 \|/);
  assert.match(summary, /\| update_main_rounds \| not_measured \| – \|/);
});

test("merged pull requests: paging stops at the first page that reaches before the window", async () => {
  const inWindow = Array.from({ length: 100 }, (_, i) => pr(1000 - i, { updated_at: "2026-10-08T00:00:00Z" }));
  const older = [pr(800, { updated_at: "2026-10-03T00:00:00Z" }), pr(799, { updated_at: "2026-09-30T00:00:00Z", merged_at: "2026-09-29T00:00:00Z" }),
    ...Array.from({ length: 98 }, (_, i) => pr(700 - i, { updated_at: "2026-09-20T00:00:00Z", merged_at: "2026-09-19T00:00:00Z" }))];
  const extra = Array.from({ length: 100 }, (_, i) => pr(500 - i, { updated_at: "2026-09-01T00:00:00Z" }));
  const github = fakeGitHub({ pulls: [...inWindow, ...older, ...extra] });
  const { report } = await runMain(github);
  assert.deepEqual(github.calls.filter((call) => call.route.includes("/pulls")).map((call) => /&page=(\d+)/.exec(call.route)[1]), ["1", "2"]);
  assert.equal(report.coverage.pull_list_complete, true);
  // Merged in the window: the 100 recent and #800; closed but not merged is not one.
  assert.equal(report.metrics.time_to_merge_minutes.count, 101);
  const closedOnly = fakeGitHub({ pulls: [pr(5, { merged_at: null }), pr(6)] });
  assert.equal((await runMain(closedOnly)).report.metrics.time_to_merge_minutes.count, 1);
  // A page that stops early: the budget cut the list short.
  const request = budgetedFetch(github.fetchImpl, ENV, createBudget({ cap: 1 }));
  const paged = await fetchPaged(request, `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc`, null);
  assert.deepEqual([paged.items.length, paged.complete], [100, false]);
});

test("runs and heads per merged pull request; time to merge", async () => {
  const pulls = [
    pr(10, { created_at: "2026-10-03T00:00:00Z", merged_at: "2026-10-03T06:00:00Z" }),
    pr(11, { head: { ref: "fork-branch" }, created_at: "2026-10-04T00:00:00Z", merged_at: "2026-10-04T02:00:00Z" }),
    // Opened before the window: its early runs are outside it, so it is left out of runs per PR.
    pr(12, { created_at: "2026-09-25T00:00:00Z", merged_at: "2026-10-05T00:00:00Z" }),
  ];
  const runs = [
    run(1, { pull_requests: [{ number: 10 }], head_sha: sha(100), created_at: "2026-10-03T01:00:00Z" }),
    run(2, { pull_requests: [{ number: 10 }], head_sha: sha(100), created_at: "2026-10-03T01:00:00Z" }),
    run(3, { pull_requests: [{ number: 10 }], head_sha: sha(101), created_at: "2026-10-03T02:00:00Z" }),
    // No pull request on the run (a fork): matched by head branch while #11 was open.
    run(4, { head_branch: "fork-branch", head_sha: sha(110), created_at: "2026-10-04T01:00:00Z" }),
    run(5, { head_branch: "fork-branch", head_sha: sha(111), created_at: "2026-10-05T01:00:00Z" }),
    // Not pull_request events.
    run(6, { event: "push", pull_requests: [{ number: 10 }], created_at: "2026-10-03T01:00:00Z" }),
    run(7, { pull_requests: [{ number: 12 }], created_at: "2026-10-04T00:00:00Z" }),
  ];
  const { report } = await runMain(fakeGitHub({ runs, pulls, jobs: {} }));
  const m = report.metrics;
  assert.deepEqual(m.heads_per_merged_pr.per_pr, [{ number: 10, runs: 3, heads: 2 }, { number: 11, runs: 1, heads: 1 }]);
  assert.deepEqual([m.runs_per_merged_pr.count, m.runs_per_merged_pr.p50, m.runs_per_merged_pr.p95, m.runs_per_merged_pr.mean], [2, 1, 3, 2]);
  assert.deepEqual([m.heads_per_merged_pr.p50, m.heads_per_merged_pr.p95], [1, 2]);
  assert.match(m.runs_per_merged_pr.note, /^2 of 3 pull requests merged in the window were opened in it/);
  // Time to merge: 360, 120 and 14,400 minutes.
  assert.deepEqual([m.time_to_merge_minutes.count, m.time_to_merge_minutes.p50], [3, 360]);
  const slim = (r) => ({ ...r, pull_requests: r.pull_requests.map((p) => p.number) });
  assert.deepEqual(runsOfPull({ number: 11, head_ref: "fork-branch", created_at: "2026-10-04T00:00:00Z", merged_at: "2026-10-04T02:00:00Z" },
    runs.map(slim)).map((r) => r.id), [4]);
});

test("computeMetrics on nothing: zero and null, labelled measured", () => {
  const budget = createBudget();
  const coverage = { runs_listed: 0, runs_completed: 0, runs_with_jobs: 0, run_list_complete: true, pull_list_complete: true };
  const m = computeMetrics({ runs: [], pulls: [], jobsByRun: new Map(), coverage, window: WINDOW, budget });
  assert.deepEqual([m.self_hosted_minutes.total, m.self_hosted_minutes.status, m.queue_minutes.p50, m.runs_per_merged_pr.mean],
    [0, "measured", null, null]);
});

test("collectUsage: a run whose job pages are cut short is neither counted nor cached", async () => {
  const many = Array.from({ length: 150 }, (_, i) => job(i + 1));
  const github = fakeGitHub({ runs: [run(1)], jobs: { 1: many } });
  const cache = emptyCache(REPO);
  const budget = createBudget({ cap: 3 });
  const collected = await collectUsage({ request: budgetedFetch(github.fetchImpl, ENV, budget), repository: REPO, window: WINDOW, cache });
  assert.deepEqual([collected.coverage.runs_with_jobs, Object.keys(cache.runs).length, budget.stopped], [0, 0, "request_cap"]);
  const enough = await collectUsage({ request: budgetedFetch(github.fetchImpl, ENV, createBudget()), repository: REPO, window: WINDOW, cache });
  assert.equal(enough.jobsByRun.get(1).length, 150);
});

test("the workflow: weekly and by hand, hosted, read-only, the measurement App's secrets only, default-branch code", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "clued-ci-usage-report.yml"), "utf8");
  assert.ok(!text.includes("\r"), "LF line endings");
  assert.match(text, /^on:\n {2}schedule:\n {4}- cron: "23 3 \* \* 0"\n {2}workflow_dispatch:\n {4}inputs:\n {6}days:\n/m);
  assert.match(text, / {8}default: 7\n/);
  assert.doesNotMatch(text, /^ {2}(pull_request(_target)?|push|workflow_run):/m, "no pull request, push or workflow_run trigger");
  const permissions = /^permissions:\n((?: {2}.+\n)+)/m.exec(text);
  assert.ok(permissions, "a top-level permissions block");
  assert.deepEqual(permissions[1].trim().split("\n").map((line) => line.trim()).sort(),
    ["actions: read", "checks: read", "contents: read", "issues: read", "pull-requests: read"]);
  assert.doesNotMatch(text, /:\s*write\b/);
  // Owner Decision 00b71629: the App's ID and key, from the clued-admission environment, and no other secret.
  assert.deepEqual([...text.matchAll(/^\s*environment: (.+)$/gm)].map((match) => match[1]), ["clued-admission"]);
  assert.deepEqual([...text.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]), ["CLUED_MEASURE_APP_ID", "CLUED_MEASURE_APP_KEY"]);
  assert.match(text, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.deepEqual([...text.matchAll(/runs-on: (.+)/g)].map((match) => match[1]), ["ubuntu-latest"]);
  assert.match(text, /ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}\n {10}persist-credentials: false/);
  assert.match(text, /concurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n {2}cancel-in-progress: false/);
  assert.match(text, /timeout-minutes: 20/);
  // Every action is pinned to a full commit SHA.
  const uses = [...text.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.deepEqual(uses.map((u) => u.split("@")[0]), ["actions/checkout", "actions/cache", "actions/upload-artifact"]);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.match(text, /path: \.ci-usage-cache\n/);
  assert.match(text, /path: ci-usage-report\.json\n/);
  assert.match(text, /run: node scripts\/ci\/ci-usage-report\.mjs\n/);
  // The days input reaches the script through env, never into the shell text.
  assert.match(text, /CI_USAGE_DAYS: \$\{\{ inputs\.days \|\| 7 \}\}/);
  assert.doesNotMatch(text, /run: .*\$\{\{/);
  assert.deepEqual(workflowFormFindings(text), []);
  assert.deepEqual(gateFindings(text, null), [], "hosted only: no admission gate needed");
});

test("the runner budget policy passes, with this workflow hosted-only allowlisted", () => {
  const script = path.join(ROOT, "scripts", "ci", "validate_runner_budget_policy.py");
  let report = null;
  for (const python of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const result = spawnSync(python, [script], { cwd: ROOT, encoding: "utf8" });
    try { report = JSON.parse(result.stdout); break; } catch { /* not this interpreter */ }
  }
  assert.ok(report, "a Python interpreter ran the validator");
  assert.deepEqual(report.violations, []);
  assert.equal(report.status, "PASS");
  const record = report.workflows.find((w) => w.workflow === "clued-ci-usage-report.yml");
  assert.deepEqual([record.hosted, record.self_hosted, record.hosted_only_allowlisted, record.pr_triggered], [true, false, true, false]);
});
