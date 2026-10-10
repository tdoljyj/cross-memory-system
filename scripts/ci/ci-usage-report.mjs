#!/usr/bin/env node
// Merge Admission v0.1 §12.1 (Task f70546e5): CI usage measurement, version 1.
// The clued-ci-usage-report workflow runs this daily and by hand on a hosted
// runner, from the default branch. It reads GitHub with an installation token
// of the measurement-only read-only GitHub App when the clued-admission
// environment holds its ID and key (§12.1, Owner Decision 00b71629), and with
// the workflow's read-only GITHUB_TOKEN otherwise.
// It reads the workflow runs, their jobs and the merged pull requests of a
// window (7 days by default, at most 14) and writes ci-usage-report.json and a
// step summary: where the self-hosted minutes go, how long jobs queue, how
// many runs and heads a merged pull request takes, and what is not measured
// yet and why.
//
// The GITHUB_TOKEN pool is shared by the whole repository: the admission
// gates poll it, admission and re-verification use it. The App has a quota of
// its own (5,000 requests an hour) that nothing else spends. On 2026-10-07 an
// uncontrolled collector spent an account's whole hourly quota and a pull
// request's runner check was refused with 403. So:
//
//   - every request counts against a hard cap a run, pages included: 2,000
//     with the App token (a week has about 1,000 runs), 200 with the
//     GITHUB_TOKEN (the first report, run 37894585499, reached job details for
//     187 of 994 runs that way);
//   - before each batch of 20 requests the last response's
//     x-ratelimit-remaining is read, and below 600 the run stops;
//   - a rate-limited response stops the run too; nothing is retried;
//   - after 15 minutes the run stops too, so it ends inside the job's
//     timeout and still saves its cache and report;
//   - stopping early is not an error: the report says how many runs got job
//     details out of how many were listed, and labels the metrics partial;
//   - jobs of completed runs are cached by run id (and attempt) in
//     .ci-usage-cache/, which the workflow restores and saves, so a run's jobs
//     are fetched once and later runs fetch only new runs;
//   - per pull request commits, files and events are not read in version 1:
//     the metrics that need them, Clued receipts or check titles are reported
//     as null with the reason.
//
// GitHub requests per run: the run list of the window (one per 100 runs), the
// closed pull requests until the first one updated before the window (one per
// 100), and one jobs list (filter=all, every attempt) for each completed run
// that is not cached yet. GitHub returns at most 1,000 runs for a created
// filter, so a window that reaches that many is listed again day by day, and a
// day that reaches it is halved while its ranges are longer than 30 minutes
// (they end at 22.5); only such a range that still reaches it marks the list
// cut short, and a list whose first page reports more than 1,000 is split
// without reading its other pages (run
// 37975919780 found 6-hour ranges over the limit). The job lists of runs not
// cached yet are read four at a time, within the same budget: about 1,600 runs
// a day (11,504 listed in 7 days) is more than one run reads one by one in its
// time budget. The workflow runs daily and the cache fills up over the days
// (Owner Decision 5ca9ecc5). New runs arriving while the
// list is paged shift its pages, so runs are counted once by id (run
// 37959346703 listed 12 runs twice).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appJwt } from "./clued-work-admission.mjs";
import { collectAttribution, attributionMetrics } from "./ci-usage-attribution.mjs";

export const REQUEST_CAP = 200;
export const APP_REQUEST_CAP = 2000;
// Inside the job's 20-minute timeout, with room for setup, the self-test and
// saving the cache (review MINOR-3).
export const TIME_BUDGET_MS = 15 * 60 * 1000;
// The installation token asks for these and nothing more (§12.1).
export const MEASURE_PERMISSIONS = Object.freeze({ actions: "read", checks: "read", contents: "read", issues: "read", pull_requests: "read" });
export const BATCH_SIZE = 20;
export const RATE_LIMIT_FLOOR = 600;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 14;
export const PAGE_SIZE = 100;
// GitHub's limit on the results of one created-filtered run list.
export const RUN_LIST_CAP = 1000;
// A created range over the limit is halved while it is longer than this.
export const MIN_RANGE_MS = 30 * 60 * 1000;
// Job lists read at once.
export const JOB_CONCURRENCY = 4;
export const CACHE_DIR = ".ci-usage-cache";
export const CACHE_FILE = "runs.json";
export const CACHE_SCHEMA = "clued.ci-usage-cache/v1";
export const REPORT_SCHEMA = "clued.ci-usage-report/v1";
export const REPORT_FILE = "ci-usage-report.json";
export const GATE_JOB = "admission-gate";
const DAY_MS = 24 * 60 * 60 * 1000;

// Metrics version 1 does not compute, and why. Each is reported as null.
export const NOT_MEASURED = Object.freeze({
  admission_failures_by_reason: "needs the titles of the failing clued-admission-verified App checks (one check-run list per head); not read in version 1",
  update_main_rounds: "needs each merged pull request's commits (merge commits with two parents); per pull request commits are not read in version 1",
  wasted_final_rounds: "needs each merged pull request's commits and the main tip at each run; not read in version 1",
  queue_depth_p95: "needs the merge queue items from Clued receipts; this run reads GitHub only",
  unclaimed_admitted: "needs the Clued admission receipts of heads admitted without a claim in efficiency (§5.3); this run reads GitHub only",
});

// --- Small pure helpers.

export function parseDays(value) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_DAYS;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`days must be an integer from 1 to ${MAX_DAYS}, not ${JSON.stringify(text)}`);
  const days = Number(text);
  if (days < 1 || days > MAX_DAYS) throw new Error(`days must be an integer from 1 to ${MAX_DAYS}, not ${days}`);
  return days;
}

// The window starts at midnight UTC `days` days before now.
export function windowOf(now, days) {
  const end = new Date(now);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - days * DAY_MS);
  return { days, start: start.toISOString(), end: end.toISOString(), start_date: start.toISOString().slice(0, 10) };
}

// Minutes between two timestamps, or null when one is missing or the order is wrong.
export function durationMinutes(start, end) {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 60000;
}

export const round = (value, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

// Nearest-rank percentile: the smallest value with at least p% of the values
// at or below it. null for no values.
export function percentile(values, p) {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function sum(values) {
  return values.reduce((total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

// { key: rounded sum }, largest first.
export function sumBy(items, keyOf, valueOf) {
  const totals = new Map();
  for (const item of items) {
    const key = keyOf(item);
    totals.set(key, (totals.get(key) ?? 0) + (valueOf(item) ?? 0));
  }
  return Object.fromEntries([...totals].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, value]) => [key, round(value)]));
}

export function countBy(items, keyOf) {
  return sumBy(items, keyOf, () => 1);
}

export const isSelfHosted = (job) => Array.isArray(job && job.labels)
  && job.labels.some((label) => String(label).toLowerCase() === "self-hosted");

export const isGateJob = (job) => Boolean(job) && typeof job.name === "string"
  && (job.name === GATE_JOB || job.name.endsWith(` / ${GATE_JOB}`));

// The workflow file of a run (its path without @ref), or its name.
export const workflowOf = (run) => String((run && (run.path || run.name)) ?? "unknown").replace(/@.*$/, "");

const statusOf = (complete) => (complete ? "measured" : "partial");

// --- The budgeted fetch: every GitHub request of a run goes through it.

export function createBudget({ cap = REQUEST_CAP, batchSize = BATCH_SIZE, floor = RATE_LIMIT_FLOOR, source = "github_token",
  deadline = null, clock = Date.now } = {}) {
  return { cap, batchSize, floor, source, deadline, clock, used: 0, remaining: null, limit: null, reset: null, stopped: null };
}

const headerNumber = (headers, name) => {
  const value = headers && typeof headers.get === "function" ? headers.get(name) : null;
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
};

// A response GitHub sends when a rate limit (primary or secondary) is hit.
export function isRateLimited(response, bodyText = "") {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return headerNumber(response.headers, "x-ratelimit-remaining") === 0 || headerNumber(response.headers, "retry-after") !== null
    // A secondary rate limit can come without either header (review MAJOR-1).
    || /secondary rate limit|abuse detection/i.test(bodyText);
}

// request(route) -> { ok: true, body }, or { ok: false, stopped } when the
// budget or the rate limit stops the run. Any other non-OK answer throws.
export function budgetedFetch(fetchImpl, env, budget, token = env.GITHUB_TOKEN) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  return async function request(route) {
    if (budget.stopped) return { ok: false, stopped: budget.stopped };
    if (budget.used >= budget.cap) {
      budget.stopped = "request_cap";
      return { ok: false, stopped: budget.stopped };
    }
    if (budget.deadline !== null && budget.clock() >= budget.deadline) {
      budget.stopped = "time_budget";
      return { ok: false, stopped: budget.stopped };
    }
    // Before each batch: the remaining quota the last response reported.
    if (budget.used > 0 && budget.used % budget.batchSize === 0 && budget.remaining !== null && budget.remaining < budget.floor) {
      budget.stopped = "rate_limit_floor";
      return { ok: false, stopped: budget.stopped };
    }
    budget.used += 1;
    const response = await fetchImpl(`${base}${route}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "clued-ci-usage-report",
      },
    });
    const remaining = headerNumber(response.headers, "x-ratelimit-remaining");
    // Responses finish out of order: keep the lowest remaining seen (review NIT).
    if (remaining !== null) budget.remaining = budget.remaining === null ? remaining : Math.min(budget.remaining, remaining);
    budget.limit = headerNumber(response.headers, "x-ratelimit-limit") ?? budget.limit;
    budget.reset = headerNumber(response.headers, "x-ratelimit-reset") ?? budget.reset;
    const refusedBody = response.status === 403 ? await response.text().catch(() => "") : "";
    if (isRateLimited(response, refusedBody)) {
      budget.stopped = "rate_limited";
      return { ok: false, stopped: budget.stopped };
    }
    if (!response.ok) throw new Error(`GitHub API ${route} returned ${response.status}`);
    return { ok: true, body: await response.json() };
  };
}

// The token the measurement reads with: the App's installation token when the
// App is configured and grants it, otherwise the GITHUB_TOKEN with the reason,
// also when the key cannot sign or a request fails (review MINOR-2). The two
// App requests are outside the budget: they are signed with the App's JWT and
// spend no token pool.
export async function measureToken({ env, fetchImpl, now = () => Date.now() }) {
  const appId = (env.CLUED_MEASURE_APP_ID ?? "").trim();
  const key = (env.CLUED_MEASURE_APP_KEY ?? "").trim();
  const fallback = (reason) => ({ token: env.GITHUB_TOKEN || null, source: "github_token", reason });
  if (!appId || !key) return fallback("the measurement App is not configured (CLUED_MEASURE_APP_ID / CLUED_MEASURE_APP_KEY)");
  try {
    return await mintMeasureToken({ env, fetchImpl, now, appId, key, fallback });
  } catch (error) {
    // The message of a signing or network error, never the key itself.
    const name = error instanceof Error ? error.name : "Error";
    return fallback(`the measurement App token could not be minted (${name}: ${error instanceof Error ? error.message : String(error)})`);
  }
}

async function mintMeasureToken({ env, fetchImpl, now, appId, key, fallback }) {
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const repository = env.GITHUB_REPOSITORY;
  const jwt = appJwt(appId, key, Math.floor(now() / 1000));
  const call = async (method, route, body) => {
    const response = await fetchImpl(`${base}${route}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "clued-ci-usage-report",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, body: parsed };
  };
  const installation = await call("GET", `/repos/${repository}/installation`);
  if (installation.status !== 200 || !installation.body || !installation.body.id) {
    return fallback(`the measurement App is not installed on ${repository} or not authenticated (GET installation returned ${installation.status})`);
  }
  const minted = await call("POST", `/app/installations/${installation.body.id}/access_tokens`,
    { repositories: [repository.split("/")[1]], permissions: MEASURE_PERMISSIONS });
  if (minted.status === 201 && minted.body && minted.body.token) return { token: minted.body.token, source: "app", reason: null };
  return fallback(`the measurement App token was refused (POST access_tokens returned ${minted.status}; `
    + "it needs read access to actions, checks, contents, issues and pull requests)");
}

// The pages of a list until a short page, until `done(chunk)`, until
// `maxItems` (capped: true), or until the budget stops it; complete is false
// in the last case.
export async function fetchPaged(request, route, key, { done = () => false, maxItems = Infinity, splitOnTotal = false } = {}) {
  const items = [];
  const sep = route.includes("?") ? "&" : "?";
  for (let page = 1; ; page += 1) {
    const answer = await request(`${route}${sep}per_page=${PAGE_SIZE}&page=${page}`);
    if (!answer.ok) return { items, complete: false, capped: false };
    const chunk = key ? answer.body && answer.body[key] : answer.body;
    if (!Array.isArray(chunk)) throw new Error(`GitHub API ${route} returned no ${key ?? "list"}`);
    items.push(...chunk);
    // With splitOnTotal, a list whose first page says it holds more than maxItems is capped at once (review m3).
    const total = key && answer.body ? Number(answer.body.total_count) : NaN;
    if (splitOnTotal && page === 1 && Number.isFinite(total) && total > maxItems && chunk.length === PAGE_SIZE) {
      return { items, complete: true, capped: true };
    }
    if (chunk.length < PAGE_SIZE || done(chunk)) return { items, complete: true, capped: false };
    if (items.length >= maxItems) return { items, complete: true, capped: true };
  }
}

// The window's days, start_date to the end's date (UTC).
export function daysOf(window) {
  const days = [];
  for (let day = Date.parse(`${window.start_date}T00:00:00Z`); day <= Date.parse(window.end); day += DAY_MS) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}

// A created range in GitHub's syntax, whole seconds, both ends included.
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const rangeOf = (fromMs, toMs) => `${iso(fromMs)}..${iso(toMs)}`;

// The two halves of [fromMs, toMs] (inclusive, whole seconds).
export function halvesOf(fromMs, toMs) {
  if (toMs - fromMs < 1000) throw new Error("halvesOf needs a range of at least two seconds");
  const mid = fromMs + Math.floor((toMs - fromMs + 1000) / 2000) * 1000;
  return [[fromMs, mid - 1000], [mid, toMs]];
}

// The window's runs, once each by id. complete is false when the budget
// stopped the list or a single day reached GitHub's 1,000-run limit.
export async function listRuns(request, repository, window) {
  const route = (created) => `/repos/${repository}/actions/runs?created=${encodeURIComponent(created)}`;
  const once = (items) => [...new Map(items.map((run) => [run.id, run])).values()];
  const whole = await fetchPaged(request, route(`>=${window.start_date}`), "workflow_runs", { maxItems: RUN_LIST_CAP, splitOnTotal: true });
  if (!whole.capped) return { items: once(whole.items), complete: whole.complete, by_day: false, day_capped: [] };
  const items = [];
  const dayCapped = [];
  let stopped = false;
  // A range over the limit is halved down to MIN_RANGE_MS; false when the budget stopped it.
  const listRange = async (fromMs, toMs) => {
    // A range too short to halve is read in full, up to the limit.
    const leaf = toMs - fromMs + 1000 <= MIN_RANGE_MS;
    const listed = await fetchPaged(request, route(rangeOf(fromMs, toMs)), "workflow_runs", { maxItems: RUN_LIST_CAP, splitOnTotal: !leaf });
    if (!listed.complete) { items.push(...listed.items); return false; }
    if (!listed.capped) { items.push(...listed.items); return true; }
    if (leaf) { items.push(...listed.items); dayCapped.push(rangeOf(fromMs, toMs)); return true; }
    for (const [a, b] of halvesOf(fromMs, toMs)) {
      // Stopped part-way: keep what this range already listed (review m2); once() drops repeats.
      if (!(await listRange(a, b))) { items.push(...listed.items); return false; }
    }
    return true;
  };
  for (const day of daysOf(window)) {
    const listed = await fetchPaged(request, route(day), "workflow_runs", { maxItems: RUN_LIST_CAP, splitOnTotal: true });
    if (!listed.complete) { items.push(...listed.items); stopped = true; break; }
    if (!listed.capped) { items.push(...listed.items); continue; }
    const start = Date.parse(`${day}T00:00:00Z`);
    let whole = true;
    for (const [a, b] of halvesOf(start, start + DAY_MS - 1000)) if (!(await listRange(a, b))) { whole = false; break; }
    if (!whole) { items.push(...listed.items); stopped = true; break; }
  }
  // Stopped: the whole window's first pages are kept as well (review m2).
  if (stopped) items.push(...whole.items);
  return { items: once(items), complete: !stopped && dayCapped.length === 0, by_day: true, day_capped: dayCapped };
}

// --- The cache of completed runs' jobs, keyed by run id.

export function emptyCache(repository) {
  return { schema: CACHE_SCHEMA, repository, runs: {} };
}

// A missing, unreadable or foreign cache is an empty one.
export function loadCache(dir, repository, readFile = fs.readFileSync) {
  try {
    const cache = JSON.parse(readFile(path.join(dir, CACHE_FILE), "utf8"));
    if (cache && cache.schema === CACHE_SCHEMA && cache.repository === repository && cache.runs && typeof cache.runs === "object") return cache;
  } catch {
    // No cache yet.
  }
  return emptyCache(repository);
}

// The cached jobs of a run, if they belong to the attempt listed now: a
// re-run keeps its id and is read again.
export function cachedJobs(cache, run) {
  const entry = cache.runs[String(run.id)];
  return entry && entry.run_attempt === (run.run_attempt ?? 1) && Array.isArray(entry.jobs) ? entry.jobs : null;
}

const slimJob = (job) => ({
  id: job.id, name: job.name, run_attempt: job.run_attempt ?? null, status: job.status, conclusion: job.conclusion ?? null,
  created_at: job.created_at ?? null, started_at: job.started_at ?? null, completed_at: job.completed_at ?? null,
  labels: Array.isArray(job.labels) ? job.labels : [],
});

// Adds a run's jobs; only completed runs are ever cached.
export function mergeCache(cache, run, jobs) {
  if (!run || run.status !== "completed") return cache;
  cache.runs[String(run.id)] = { run_attempt: run.run_attempt ?? 1, created_at: run.created_at ?? null, jobs: jobs.map(slimJob) };
  return cache;
}

// Drops runs created before the longest window, so the cache stays small.
export function pruneCache(cache, now) {
  const oldest = Date.parse(new Date(now).toISOString()) - (MAX_DAYS + 1) * DAY_MS;
  for (const [id, entry] of Object.entries(cache.runs)) {
    if (!entry || !entry.created_at || Date.parse(entry.created_at) < oldest) delete cache.runs[id];
  }
  return cache;
}

export function saveCache(dir, cache, writeFile = fs.writeFileSync, mkdir = fs.mkdirSync) {
  mkdir(dir, { recursive: true });
  writeFile(path.join(dir, CACHE_FILE), `${JSON.stringify(cache)}\n`);
}

// --- Collection.

const slimRun = (run) => ({
  id: run.id, name: run.name ?? null, path: run.path ?? null, event: run.event ?? null, status: run.status ?? null,
  conclusion: run.conclusion ?? null, run_attempt: run.run_attempt ?? 1, head_branch: run.head_branch ?? null,
  head_sha: run.head_sha ?? null, created_at: run.created_at ?? null,
  pull_requests: Array.isArray(run.pull_requests) ? run.pull_requests.map((pr) => pr && pr.number).filter(Number.isInteger) : [],
});

export async function collectUsage({ request, repository, window, cache }) {
  const listed = await listRuns(request, repository, window);
  const runs = listed.items.map(slimRun).filter((run) => run.created_at && run.created_at >= window.start);
  // Closed pull requests, newest update first, until one was updated before the window.
  const before = (pr) => !pr || !pr.updated_at || pr.updated_at < window.start;
  const closed = await fetchPaged(request, `/repos/${repository}/pulls?state=closed&sort=updated&direction=desc`, null,
    { done: (chunk) => chunk.some(before) });
  const pulls = closed.items.filter((pr) => pr && pr.merged_at && pr.merged_at >= window.start)
    .map((pr) => ({ number: pr.number, head_ref: pr.head ? pr.head.ref : null, created_at: pr.created_at, merged_at: pr.merged_at }));
  // Jobs of completed runs, oldest first: those closest to leaving the window
  // are read first, and a run that stops leaves the newest for the next one.
  const jobsByRun = new Map();
  const coverage = { runs_listed: runs.length, runs_completed: 0, runs_in_progress: 0, runs_with_jobs: 0, runs_from_cache: 0,
    runs_fetched_now: 0, run_list_complete: listed.complete, run_list_by_day: listed.by_day, run_list_days_capped: listed.day_capped,
    pull_list_complete: closed.complete };
  const pending = [];
  for (const run of [...runs].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)) {
    if (run.status !== "completed") { coverage.runs_in_progress += 1; continue; }
    coverage.runs_completed += 1;
    const cached = cachedJobs(cache, run);
    if (cached) {
      jobsByRun.set(run.id, cached);
      coverage.runs_from_cache += 1;
      continue;
    }
    pending.push(run);
  }
  // Oldest first, JOB_CONCURRENCY at a time; every request still goes through the budget.
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < pending.length && !failure) {
      const run = pending[next];
      next += 1;
      try {
        const jobs = await fetchPaged(request, `/repos/${repository}/actions/runs/${run.id}/jobs?filter=all`, "jobs");
        // A run whose job pages were cut short is neither counted nor cached.
        if (!jobs.complete || failure) continue;
        mergeCache(cache, run, jobs.items);
        jobsByRun.set(run.id, cachedJobs(cache, run));
        coverage.runs_fetched_now += 1;
      } catch (error) {
        // The others stop taking runs; every worker ends before the error is thrown (review m1).
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOB_CONCURRENCY, pending.length) }, worker));
  if (failure) throw failure;
  coverage.runs_with_jobs = jobsByRun.size;
  return { runs, pulls, jobsByRun, coverage };
}

// --- Metrics.

// The runs of a merged pull request: those that name it, else (no pull
// request on the run, as for forks) a run of its head branch while it was open.
export function runsOfPull(pr, runs) {
  return runs.filter((run) => run.event === "pull_request" && (run.pull_requests.length
    ? run.pull_requests.includes(pr.number)
    : run.head_branch === pr.head_ref && run.created_at >= pr.created_at && run.created_at <= pr.merged_at));
}

const distribution = (values) => ({ count: values.length, p50: round(percentile(values, 50), 2), p95: round(percentile(values, 95), 2),
  mean: values.length ? round(sum(values) / values.length, 2) : null });

export function computeMetrics({ runs, pulls, jobsByRun, coverage, window, budget, attribution }) {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const jobs = [];
  for (const [runId, list] of jobsByRun) {
    const run = runById.get(runId);
    for (const job of list) {
      jobs.push({ ...job, workflow: workflowOf(run), minutes: durationMinutes(job.started_at, job.completed_at),
        queue: durationMinutes(job.created_at, job.started_at) });
    }
  }
  const finished = jobs.filter((job) => job.status === "completed" && job.minutes !== null);
  const selfHosted = finished.filter(isSelfHosted);
  const hosted = finished.filter((job) => !isSelfHosted(job));
  const gates = finished.filter(isGateJob);
  const jobsComplete = coverage.run_list_complete && coverage.runs_with_jobs === coverage.runs_completed;
  const runsComplete = coverage.run_list_complete;
  const pullsComplete = coverage.pull_list_complete;

  // A pull request opened before the window has runs outside it: left out.
  const observable = pulls.filter((pr) => pr.created_at >= window.start);
  const perPull = observable.map((pr) => {
    const own = runsOfPull(pr, runs);
    return { number: pr.number, runs: own.length, heads: new Set(own.map((run) => run.head_sha)).size };
  }).sort((a, b) => a.number - b.number);
  const prNote = `${observable.length} of ${pulls.length} pull requests merged in the window were opened in it; the others are left out`;
  const merged = pulls.map((pr) => durationMinutes(pr.created_at, pr.merged_at)).filter((value) => value !== null);
  const reruns = runs.filter((run) => (run.run_attempt ?? 1) > 1);

  const metrics = {
    self_hosted_minutes: {
      status: statusOf(jobsComplete), total: round(sum(selfHosted.map((job) => job.minutes))), jobs: selfHosted.length,
      by_workflow: sumBy(selfHosted, (job) => job.workflow, (job) => job.minutes),
      by_conclusion: sumBy(selfHosted, (job) => job.conclusion ?? "none", (job) => job.minutes),
      by_layer: null, by_state: null,
      not_measured: { by_layer: "needs each pull request's changed paths (per pull request files); not read in version 1",
        by_state: "the Merge Admission state is not recorded on runs; not read in version 1" },
    },
    hosted_minutes: { status: statusOf(jobsComplete), total: round(sum(hosted.map((job) => job.minutes))), jobs: hosted.length,
      by_workflow: sumBy(hosted, (job) => job.workflow, (job) => job.minutes) },
    queue_minutes: { status: statusOf(jobsComplete), ...distribution(selfHosted.map((job) => job.queue).filter((v) => v !== null)),
      note: "self-hosted jobs, started_at - created_at" },
    runs_per_merged_pr: { status: statusOf(runsComplete && pullsComplete), ...distribution(perPull.map((pr) => pr.runs)), note: prNote },
    heads_per_merged_pr: { status: statusOf(runsComplete && pullsComplete), ...distribution(perPull.map((pr) => pr.heads)), note: prNote,
      per_pr: perPull },
    reruns: { status: statusOf(runsComplete), count: reruns.length, by_workflow: countBy(reruns, workflowOf) },
    gate_minutes: { status: statusOf(jobsComplete), total: round(sum(gates.map((job) => job.minutes))), jobs: gates.length,
      self_hosted_jobs: gates.filter(isSelfHosted).length },
    gate_queue_minutes: { status: statusOf(jobsComplete), ...distribution(gates.map((job) => job.queue).filter((v) => v !== null)) },
    time_to_merge_minutes: { status: statusOf(pullsComplete), ...distribution(merged), by_layer: null, by_state: null,
      not_measured: { by_layer: "needs each pull request's changed paths", by_state: "the Merge Admission state is not recorded on pull requests" } },
  };
  for (const [name, reason] of Object.entries(NOT_MEASURED)) metrics[name] = { status: "not_measured", value: null, reason };
  if (attribution) {
    const attributed = attributionMetrics({ runs, pulls, jobsByRun, attribution, isSelfHosted, durationMinutes, round });
    metrics.attribution = attributed;
    metrics.self_hosted_minutes.by_layer = attributed.self_hosted_minutes.by_layer;
    metrics.self_hosted_minutes.by_state = attributed.self_hosted_minutes.by_state;
    metrics.self_hosted_minutes.attribution_status = jobsComplete && !attributed.self_hosted_minutes.unknown_jobs ? "measured" : "partial";
    metrics.self_hosted_minutes.not_measured = {};
    metrics.self_hosted_minutes.attribution_note = attributed.self_hosted_minutes.note;
  }
  metrics.api_requests = {
    status: "measured", token_source: budget.source, used: budget.used, cap: budget.cap, remaining_seen: budget.remaining,
    limit_seen: budget.limit, stopped: budget.stopped, by_pool: null,
    not_measured: { by_pool: budget.source === "app"
      ? "the measurement App's quota is its own; the GITHUB_TOKEN pool was not used"
      : "the other users of the GITHUB_TOKEN pool (gate polling, admission, re-verification) are not counted here" },
  };
  return metrics;
}

export function buildReport({ repository, window, collected, budget, now }) {
  const seen = collected.coverage;
  const coverage = { ...seen, stopped: budget.stopped,
    partial: Boolean(budget.stopped) || !seen.run_list_complete || !seen.pull_list_complete || seen.runs_with_jobs < seen.runs_completed };
  return {
    schema: REPORT_SCHEMA, repository, generated_at: new Date(now).toISOString(), window, coverage,
    metrics: computeMetrics({ ...collected, coverage, window, budget }),
  };
}

// --- Rendering.

const show = (value, unit = "") => (value === null || value === undefined ? "–" : `${value}${unit}`);

export function renderSummary(report) {
  const { window, coverage, metrics } = report;
  const lines = ["## clued-ci-usage-report", "",
    `Window ${window.start_date} to ${window.end.slice(0, 10)} (${window.days} days) · ${report.repository}`, ""];
  lines.push(`Coverage: job details for ${coverage.runs_with_jobs} of ${coverage.runs_completed} completed runs `
    + `(${coverage.runs_from_cache} from cache, ${coverage.runs_fetched_now} fetched now) out of ${coverage.runs_listed} runs listed; `
    + `${coverage.runs_in_progress} still running.`);
  if (coverage.partial) {
    lines.push("", `**Partial coverage**${coverage.stopped ? ` (stopped: ${coverage.stopped})` : ""}: `
      + `run list ${coverage.run_list_complete ? "complete" : "cut short"}`
      + `${coverage.run_list_days_capped && coverage.run_list_days_capped.length ? ` (over GitHub's 1,000-run limit on ${coverage.run_list_days_capped.join(", ")})` : ""}, `
      + `pull request list ${coverage.pull_list_complete ? "complete" : "cut short"}.`);
  }
  const dist = (metric, unit) => `p50 ${show(metric.p50, unit)} · p95 ${show(metric.p95, unit)} · n ${metric.count}`;
  lines.push("", "| Metric | Status | Value |", "| --- | --- | --- |");
  lines.push(`| self_hosted_minutes | ${metrics.self_hosted_minutes.status} | ${metrics.self_hosted_minutes.total} min in ${metrics.self_hosted_minutes.jobs} jobs |`);
  lines.push(`| hosted_minutes | ${metrics.hosted_minutes.status} | ${metrics.hosted_minutes.total} min in ${metrics.hosted_minutes.jobs} jobs |`);
  lines.push(`| queue_minutes (self-hosted) | ${metrics.queue_minutes.status} | ${dist(metrics.queue_minutes, " min")} |`);
  lines.push(`| runs_per_merged_pr | ${metrics.runs_per_merged_pr.status} | ${dist(metrics.runs_per_merged_pr, "")} |`);
  lines.push(`| heads_per_merged_pr | ${metrics.heads_per_merged_pr.status} | ${dist(metrics.heads_per_merged_pr, "")} |`);
  lines.push(`| reruns | ${metrics.reruns.status} | ${metrics.reruns.count} runs with run_attempt > 1 |`);
  lines.push(`| gate_minutes | ${metrics.gate_minutes.status} | ${metrics.gate_minutes.total} min in ${metrics.gate_minutes.jobs} ${GATE_JOB} jobs |`);
  lines.push(`| gate_queue_minutes | ${metrics.gate_queue_minutes.status} | ${dist(metrics.gate_queue_minutes, " min")} |`);
  lines.push(`| time_to_merge_minutes | ${metrics.time_to_merge_minutes.status} | ${dist(metrics.time_to_merge_minutes, " min")} |`);
  for (const name of Object.keys(NOT_MEASURED)) lines.push(`| ${name} | ${metrics[name].status} | ${show(metrics[name].value)} |`);
  const pool = metrics.api_requests.token_source === "app" ? "measurement App" : "GITHUB_TOKEN";
  lines.push(`| api_requests | ${metrics.api_requests.status} | ${metrics.api_requests.used} of ${metrics.api_requests.cap} (${pool}); remaining ${show(metrics.api_requests.remaining_seen)} |`);
  const byWorkflow = Object.entries(metrics.self_hosted_minutes.by_workflow);
  if (byWorkflow.length) {
    lines.push("", "Self-hosted minutes by workflow:", "", "| Workflow | Minutes |", "| --- | --- |");
    for (const [workflow, minutes] of byWorkflow) lines.push(`| \`${workflow}\` | ${minutes} |`);
  }
  lines.push("", `${metrics.runs_per_merged_pr.note}.`, "", "Not measured in version 1:", "");
  for (const [name, reason] of Object.entries(NOT_MEASURED)) if (metrics[name].status === "not_measured") lines.push(`- \`${name}\`: ${reason}`);
  if (metrics.attribution) lines.push("", "Merged-PR attribution coverage:", "",
    `\`\`\`json\n${JSON.stringify(metrics.attribution, null, 2)}\n\`\`\``,
    "Cancellation observations and failure verdicts are not causal reasons. Unobserved layer/state remain unknown; no Clued historical queue depth or unclaimed-admission count is inferred.");
  return `${lines.join("\n")}\n`;
}

// --- Entry point. 0 also for partial coverage; 1 only for an unexpected error.

export async function main(env = process.env, fetchImpl = globalThis.fetch, {
  now = new Date(), readFile = fs.readFileSync, writeFile = fs.writeFileSync, mkdir = fs.mkdirSync,
  appendFile = fs.appendFileSync, log = console.log, logError = console.error, clock = Date.now,
} = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const cacheDir = env.CI_USAGE_CACHE_DIR || path.join(workspace, CACHE_DIR);
  let cache = null;
  try {
    if (!repository) throw new Error("GITHUB_REPOSITORY is not set.");
    const window = windowOf(now, parseDays(env.CI_USAGE_DAYS));
    const access = await measureToken({ env, fetchImpl, now: () => now.getTime() });
    if (!access.token) throw new Error(`GITHUB_TOKEN is not set, and ${access.reason}.`);
    if (access.source === "app") log(`::add-mask::${access.token}`);
    if (access.reason) logError(`::notice title=clued-ci-usage-report::reading with the GITHUB_TOKEN (cap ${REQUEST_CAP}): ${access.reason}`);
    cache = pruneCache(loadCache(cacheDir, repository, readFile), now);
    const deadline = clock() + TIME_BUDGET_MS;
    const budget = access.source === "app"
      ? createBudget({ cap: APP_REQUEST_CAP, source: "app", deadline, clock })
      : createBudget({ deadline, clock });
    const request = budgetedFetch(fetchImpl, env, budget, access.token);
    const collected = await collectUsage({ request, repository, window, cache });
    // Extra attribution uses only the independent measurement App pool, after
    // the existing run/job collection. No new secret or workflow privilege.
    if (access.source === "app") {
      try { collected.attribution = await collectAttribution({ request, repository, ...collected, runsOfPull }); }
      catch { collected.attribution = { heads: new Map(), updates: [], coverage: {
        scope: "merged-PR samples", heads_requested: null, heads_complete: 0,
        pulls_requested: collected.pulls.length, pulls_complete: 0, errors: 1 } }; }
    }
    const report = buildReport({ repository, window, collected, budget, now });
    writeFile(env.CI_USAGE_REPORT_PATH || path.join(workspace, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
    log(JSON.stringify({ window: report.window, coverage: report.coverage, api_requests: report.metrics.api_requests }, null, 2));
    if (env.GITHUB_STEP_SUMMARY) appendFile(env.GITHUB_STEP_SUMMARY, renderSummary(report));
    if (report.coverage.partial) {
      logError(`::notice title=clued-ci-usage-report::partial coverage: job details for ${report.coverage.runs_with_jobs} `
        + `of ${report.coverage.runs_completed} completed runs${budget.stopped ? ` (stopped: ${budget.stopped})` : ""}`);
    }
    return 0;
  } catch (error) {
    logError(`::error title=clued-ci-usage-report::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    // What was fetched is kept, also when the run stopped early or failed.
    if (cache) saveCache(cacheDir, cache, writeFile, mkdir);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
