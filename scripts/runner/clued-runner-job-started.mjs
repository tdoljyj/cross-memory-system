#!/usr/bin/env node
// Clued self-hosted runner pre-job check (Task 869d2db7, Owner Decision
// b0c53143). The GitHub runner runs this before every job through
// ACTIONS_RUNNER_HOOK_JOB_STARTED; a non-zero exit fails the job before any
// step runs. It is installed on the runner machine, outside the repository, so
// a branch that edits a workflow cannot edit this check too.
//
// A job may start when its run comes from:
//   - main: push, schedule, workflow_run, pull_request_target, or a hand
//     dispatch on main. Those workflow files are main's own. A
//     pull_request_target run counts only for a pull request into main
//     (re-review 7, m1).
//   - clued-train/staging: only clued-required-tests.yml pushed by the
//     App 5368905 bot (ADR 0018), with a merge chain rooted at live main T.
//     Every second-parent member must be an open, current, same-repository
//     PR into main with exact-head Native admission from App 5368905.
//     This deliberately requires admission for every member, so workflow
//     and protected-path changes cannot take a weaker staging exception.
//     Missing, ambiguous or unreadable evidence refuses before any step.
//   - a pull request into main that changes no file under .github/workflows/.
//     Its workflows are main's, so each keeps its admission-gate job, which
//     waits for the Clued admission of the pull request.
//   - a pull request into main that changes a workflow, once the current
//     admission producer has admitted this head and event. The active legacy
//     workflow uses its pull_request_target run; explicit manual retirement
//     selects the exact Native App/PR/head check and the current epoch guard.
//     (Re-review 3, N-R1, and re-review 5, n1: an older success on the same
//     head cannot stand in.) Task b979d5a2: the hook reads that run, not the
//     clued-admission App's check, because a fine-grained token cannot read
//     the Checks API. See admissionRun below.
//   - a hand dispatch on another branch of one of DISPATCH_GATED_WORKFLOWS,
//     whose .github/workflows directory is exactly main's. That workflow keeps
//     the dispatch gate, which needs a Clued admission run for the dispatched
//     commit. (Re-review 2, finding B: the earlier main...sha compare saw no
//     change on a branch pointing at an old main commit, from before a
//     workflow had its gate. Re-review 3, N-R2: other dispatchable workflows
//     have no gate, so they run on main only.)
// Any workflow file counts, not only the one running: a called (reusable)
// workflow runs under its caller's name.
// Re-runs (run attempt 2 or later; MergeAdmission v0.1 §8, Owner Decisions
// 77216370 and 1b93760d, replacing re-review 3 N-R3's blanket refusal):
//   - main's own runs may be re-run, as before. That includes the admission
//     workflow (pull_request_target), which reads the pull request and main
//     afresh every time.
//   - A hand dispatch on another branch may not be re-run: dispatch again.
//   - A pull request run may be re-run only while the pull request is open,
//     into main, and its head is still the run's head. Then:
//       - its admission-gate job starts: the gate judges the re-run itself
//         (the reruns-per-head count in its admission check's title);
//       - gitleaks.yml and trivy.yml, required checks without a gate, may be
//         re-run once (attempt 2);
//       - so may any other workflow without an admission-gate job (the short
//         checks, such as runner-budget-policy) whose file at the head is the
//         default branch's, byte for byte (Task 26cced7e, Owner Decision
//         661f8c36). A pull request that changes a workflow has every job of
//         its first run refused until its admission run succeeds, so without
//         this its short checks could only run again on a new commit or a
//         close and reopen;
//       - every other job starts only when this attempt's admission-gate job
//         ran again in this attempt and succeeded ("Re-run all jobs"). "Re-run
//         failed jobs" and a single-job re-run list the earlier gate job in
//         the new attempt, successful but started before the attempt did; that
//         start time is what tells them apart (measured on GitHub, Task
//         745c288f). Exactly one job of the attempt may be named
//         admission-gate, and it must carry the self-hosted label. A gate job
//         not started or not completed yet is waited for, up to
//         CLUED_RUNNER_HOOK_WAIT_SECONDS. See rerunVerdict below.
//     The rule for a pull request that changes a workflow applies to every
//     attempt as to the first; under Native admission a later attempt also
//     needs every earlier attempt to have run nothing (late admission, below).
// Everything else is refused: other non-main pushes, pull requests into
// other branches, other events.
//
// HOOK_VERSION is printed in every ALLOW/REFUSE line, so the Owner can see in
// a job's "Set up runner" log which copy each runner has.
//
// Configuration (runner machine environment, e.g. the runner's .env file):
//   CLUED_RUNNER_HOOK_REPOSITORY   owner/name this runner serves (required)
//   CLUED_RUNNER_HOOK_APP_ID       id of the hook's own read-only GitHub App
//   CLUED_RUNNER_HOOK_APP_KEY_FILE file holding that App's private key (PEM)
//   CLUED_RUNNER_HOOK_TOKEN_FILE   older alternative to the App: a file holding
//                                  a read-only GitHub token (actions, contents
//                                  and pull requests: read); used only when no App is set
//   CLUED_RUNNER_HOOK_ENFORCE      "true" refuses; anything else only reports
//   CLUED_RUNNER_HOOK_WAIT_SECONDS how long to wait for the admission run, and
//                                  separately for a re-run's admission-gate
//                                  job (480 each). A heavy job of a re-run of a
//                                  pull request that changes a workflow can
//                                  wait for both: up to twice this, plus at
//                                  most READ_ALLOWANCE_MS of reads.
// It needs Node 18 or newer (the runner bundles one under externals/).
//
// Transient reads (work-handover-native-admission-retry-v1, component 1.0.2;
// Task 5cee3629, resident CI DESIGN 53.7): a network error, a reply cut off
// while its body is read, an attempt that runs past its own time bound
// (READ_ATTEMPT_MS; 10 s for the execution_current observation), or a
// 500/502/503/504 answer (GitHub's or the Clued RPC's) is tried again, at most
// READ_ATTEMPTS times per call with READ_RETRY_DELAYS_MS between. Only reads
// are tried again: every GET, and the two POSTs their callers mark as reads
// (the installation-token mint: a new token is harmless; the read-only
// execution_current observation). Any other answer (401, 403, 404, 429, a
// malformed body) is final at once, as before. While the hook waits for the
// admission run, the Native kooyumi-work-admission check or a re-run's
// admission-gate job, a poll that still fails transiently is "not settled
// yet", never a refusal, until the wait ends; then the last failure refuses.
// Every wait ends by the clock (CLUED_RUNNER_HOOK_WAIT_SECONDS), however long
// its reads take, and all reads of one hook run end within twice that plus
// READ_ALLOWANCE_MS. The Native check is judged at the time its pages were
// read, never at a time taken before the retries. Fail closed is unchanged:
// nothing is admitted on a failure.
//
// The pinned gate and resident lane carry the same failure classifier.
export const SETUP_STEPS = ["Set up job", "Set up runner"];
// A log longer than this is never classified (the tail with the verdict may be missing): not environment.
export const MAX_LOG_CHARS = 3_500_000;
const NETWORK_FAILURE = [
  /\bECONNRESET\b/, /\bETIMEDOUT\b/, /\bEAI_AGAIN\b/, /\bENOTFOUND\b/, /\bECONNREFUSED\b/, /\bEPIPE\b/,
  /socket hang up/i, /network (?:aborted|timeout|socket disconnected)/i, /connection reset by peer/i, /TLS handshake timeout/i,
  /could not resolve host/i, /temporary failure in name resolution/i, /unexpected disconnect while reading sideband/i,
  /RPC failed; curl \d+/, /early EOF/i, /\b429 Too Many Requests\b/i,
  /npm (?:ERR!|error) network/i, /request to https?:\/\/\S+ failed, reason:/i,
];
const TEST_FAILURE = [
  /\bnot ok \d+/, /# fail [1-9]\d*/, /\bAssertionError\b/, /✖/, /\b[1-9]\d* (?:failed|failing)\b/i, /(?:^|\s)FAIL(?:\s|$)/,
];
export function failedSteps(job) {
  return Array.isArray(job?.steps) ? job.steps.filter((step) => step && step.conclusion === "failure") : null;
}
// Did the job die in the runner's own setup, before any workflow step ran?
export function diedInSetup(job) {
  if (!job || job.status !== "completed" || job.conclusion !== "failure") return false;
  const failed = failedSteps(job);
  return failed !== null && failed.length > 0 && failed.every((step) => SETUP_STEPS[job.steps.indexOf(step)] === step.name);
}
// Did GitHub end the job before any runner took it (9aba97c1)? No step ran and the record says no runner (runner_id 0 or null and runner_name
// null or empty, as GitHub records it); a record without those fields proves nothing.
export function neverAssigned(job) {
  return !!job && job.status === "completed" && ["failure", "cancelled"].includes(job.conclusion) && Array.isArray(job.steps)
    && job.steps.length === 0 && [0, null].includes(job.runner_id) && [null, ""].includes(job.runner_name);
}
// The timeout annotation is emitted on the cancelled job's check run, independently of its log.
function hasTimeoutAnnotation(annotations) {
  return Array.isArray(annotations) && annotations.some(note =>
    typeof note?.message === "string" && note.message.startsWith("The job has exceeded the maximum execution time of "));
}
export function jobFailureKind(job, log = null, annotations = null) {
  const no = (why) => ({ environment: false, kind: "unknown", why });
  if (job?.status !== "completed" || !["failure", "cancelled"].includes(job.conclusion)) return no("the job did not fail or cancel");
  if (diedInSetup(job)) return { environment: true, kind: "setup", why: `the runner's ${failedSteps(job).map((step) => step.name).join(", ")} step failed` };
  if (neverAssigned(job)) return { environment: true, kind: "unassigned", why: "no runner took the job and no step ran" };
  const failed = failedSteps(job);
  const cancelled = job.conclusion === "cancelled";
  if (cancelled) {
    if (failed === null || !job.steps.length || failed.length > 0
      || job.steps.some(step => typeof step?.conclusion !== "string")) return no("the cancelled job lacks a complete record without failed steps");
    if (!hasTimeoutAnnotation(annotations)) return no("the cancelled job has no timeout annotation");
  } else if (!failed?.length) return no("the job record names no failed step");
  if (typeof log !== "string" || log.length === 0 || log.length > MAX_LOG_CHARS) return no("the job log is missing or too long to judge");
  if (TEST_FAILURE.some((pattern) => pattern.test(log))) return { environment: false, kind: "test", why: "the log shows a failed test" };
  if (cancelled) return { environment: true, kind: "timeout", why: "the job exceeded its maximum execution time and the log shows no failed test" };
  const network = NETWORK_FAILURE.find((pattern) => pattern.test(log));
  return network ? { environment: true, kind: "network", why: `the log shows a network failure (${network.source.slice(0, 40)}) and no failed test` } : no("the log shows no network failure");
}

// GitHub's earlier attempts are the repair budget. Skipped jobs after a
// known gate refusal or setup death do not consume it.
const REPAIR_GATE_JOB = "admission-gate";
const REPAIR_NOT_ADMITTED = /^(?:ADMISSION_PENDING|RERUN_REFUSED):/;
const REPAIR_TRANSIENT_API_ERROR = /^GitHub API \S+ (?:returned 5[0-9]{2}|could not be reached after [0-9]+ attempts)/;

async function repairAnnotations(read, repository, jobId) {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("the job has no check run ID");
  const notes = [];
  for (let page = 1; page <= 50; page += 1) {
    const batch = await read(`/repos/${repository}/check-runs/${jobId}/annotations?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) throw new Error("the job annotations are unreadable");
    notes.push(...batch);
    if (batch.length < 100) return notes;
  }
  throw new Error("the job annotations are incomplete");
}

async function repairEnvironmentFailures({ read, readLog, repository, heavy }) {
  if (heavy.some(job => job.status !== "completed" || !["success", "skipped", "failure", "cancelled"].includes(job.conclusion))) return null;
  const failures = [];
  for (const job of heavy) {
    if (job.conclusion === "success" || job.conclusion === "skipped") continue;
    // A job no runner took (9aba97c1) ran nothing, like a setup death: no log, no annotation.
    const unassigned = neverAssigned(job);
    const setup = diedInSetup(job) || unassigned;
    const cancelled = job.conclusion === "cancelled" && !unassigned;
    const steps = failedSteps(job);
    if (!setup && (!Number.isSafeInteger(job.id) || job.id <= 0 || !steps || (cancelled ? steps.length > 0 : steps.length === 0))) return null;
    const annotations = cancelled ? await repairAnnotations(read, repository, job.id) : null;
    if (cancelled && !hasTimeoutAnnotation(annotations)) return null;
    const log = setup ? null : await readLog(`/repos/${repository}/actions/jobs/${job.id}/logs`);
    const evidence = jobFailureKind(job, log, annotations);
    if (!evidence.environment || typeof job.name !== "string" || !job.name) return null;
    failures.push({ name: job.name, kind: evidence.kind });
  }
  return failures.length > 0 ? failures : null;
}

async function hasRepairRecovery({ read, repository, runId, workflowId, head, after, jobs }) {
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || !Number.isFinite(after)) return false;
  const needed = new Set(jobs);
  // Include old attempts of other runs and successes in runs that failed a
  // different job. A run may have started before the failed attempt ended.
  for (let page = 1; page <= 50; page += 1) {
    const listing = await read(`/repos/${repository}/actions/workflows/${workflowId}/runs?per_page=100&page=${page}`);
    const runs = listing?.workflow_runs;
    if (!Array.isArray(runs) || runs.length > 100) return false;
    for (const run of runs) {
      if (run?.workflow_id !== workflowId || !Number.isSafeInteger(run.id) || run.id <= 0 || String(run.id) === String(runId)
        || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") || run.head_sha === head
        || (run.status === "completed" && Date.parse(run.updated_at) <= after)) continue;
      for (let jobPage = 1; jobPage <= 50; jobPage += 1) {
        const { jobs: candidates } = await read(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${jobPage}`) ?? {};
        if (!Array.isArray(candidates) || candidates.length > 100) return false;
        for (const job of candidates) {
          if (job?.head_sha === run.head_sha && job.status === "completed" && job.conclusion === "success"
            && Date.parse(job.completed_at) > after) needed.delete(job.name);
        }
        if (needed.size === 0) return true;
        if (candidates.length < 100) break;
      }
    }
    if (runs.length < 100) break;
  }
  return false;
}

async function requiredTestsRepairHistory({ read, readLog, repository, runId, head, attempt, workflowId }) {
  const refuse = reason => ({ allowed: false, reason });
  const attempts = [];
  let realAttempts = 0;
  let lastFailures = [];
  let completedAt;
  try {
    for (let earlier = 1; earlier < attempt; earlier += 1) {
      const body = await read(`/repos/${repository}/actions/runs/${runId}/attempts/${earlier}/jobs?per_page=100`);
      const jobs = body?.jobs;
      if (!Array.isArray(jobs) || body.total_count !== jobs.length || jobs.length > 100 || jobs.some(job => !job || typeof job !== "object"))
        return refuse(`attempt ${earlier}'s job list is incomplete`);
      const gates = jobs.filter(job => job.name === REPAIR_GATE_JOB);
      const heavy = jobs.filter(job => job.name !== REPAIR_GATE_JOB);
      if (gates.length !== 1 || heavy.length === 0)
        return refuse(`attempt ${earlier} does not list one ${REPAIR_GATE_JOB} job and its heavy jobs`);
      if (jobs.some(job => job.head_sha !== head))
        return refuse(`attempt ${earlier} has a job of another head than ${head}`);
      if (jobs.some(job => job.run_attempt != null && Number(job.run_attempt) !== earlier))
        return refuse(`attempt ${earlier} has a job of another attempt`);
      const [gateJob] = gates;
      const ran = heavy.filter(job => job.status !== "completed" || job.conclusion !== "skipped");
      if (ran.length > 0) {
        realAttempts += 1;
        if (realAttempts === 3) return refuse("three real attempts have already run");
        const failures = gateJob.status === "completed" && gateJob.conclusion === "success"
          ? await repairEnvironmentFailures({ read, readLog, repository, heavy }) : null;
        if (!failures)
          return refuse(`attempt ${earlier} already ran ${ran.map(job => `${String(job.name).slice(0, 80)}: ${job.status}/${job.conclusion ?? "none"}`).join(", ")}; its gate or environment evidence does not allow repair`);
        lastFailures = failures.map(job => job.name);
        completedAt = Math.max(...jobs.map(job => Date.parse(job.completed_at)));
        attempts.push({ attempt: earlier, heavy_jobs: heavy.length, environment_failure: lastFailures,
          environment_failure_kinds: Object.fromEntries(failures.map(job => [job.name, job.kind])) });
        continue;
      }
      const setup = diedInSetup(gateJob) || neverAssigned(gateJob);
      const notes = !setup && gateJob.status === "completed" ? await repairAnnotations(read, repository, gateJob.id) : [];
      if (!setup && !notes.some(note =>
        (note?.title === REPAIR_GATE_JOB && REPAIR_NOT_ADMITTED.test(note.message ?? "")) ||
        (note?.title === "kooyumi-work-admission" && REPAIR_TRANSIENT_API_ERROR.test(note.message ?? ""))))
        return refuse(`the ${REPAIR_GATE_JOB} job of attempt ${earlier} did not end in ADMISSION_PENDING, RERUN_REFUSED or a GitHub API outage`);
      attempts.push({ attempt: earlier, heavy_jobs: heavy.length });
    }
    if (realAttempts === 2 && !await hasRepairRecovery({ read, repository, runId, workflowId, head, after: completedAt, jobs: lastFailures }))
      return refuse("the second repair needs recovery evidence: a later success of each failed job in the same workflow on another commit");
  } catch (error) {
    return refuse(`the earlier attempts could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  return { allowed: true, attempts };
}

// Late Native admission (required-tests-late-admission-v1, component 1.0.3;
// defect B, 2026-11-15, PR #1121 run 43720693841): Native admits a pull
// request only once it is the train's front, often long after the push, so
// every job of attempt 1 of a pull request that changes a workflow waits the
// limit and is refused in "Set up runner". Attempt 1 alone was admitted, so
// the companion's one "Re-run all jobs" after the admission was refused too
// and only a new commit helped. Now the Native rule admits the first attempt
// that runs anything: a later attempt starts when every job of every earlier
// attempt ran nothing (skipped, or refused in the runner's setup; see
// ranNothing). Still one run per admitted head.
//
// Loaded from main (runner-hook-loader-v1, component 1.0.4; Owner Decision
// 2026-11-16): runners keep only clued-runner-hook-loader.mjs, installed under
// this file's name. At each job start it reads this file from the protected
// default branch, checks its blob id and imports it from memory, then calls
// main(env, fetch, { sourceSha256 }). So this file is never the entry point
// there, and its clued-r9-pre-job source_sha256 is the loader's. Merging this
// file is its rollout; there are no per-version copies to install any more.

import { createSign,createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_VERSION = "required-tests-dispatch-v1";
export const COMPONENT_VERSION = "1.0.6";

// Transient reads (see the header).
export const READ_ATTEMPTS = 3;
export const READ_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
export const READ_ATTEMPT_MS = 30_000;
export const OBSERVATION_ATTEMPT_MS = 10_000;
export const READ_ALLOWANCE_MS = 120_000;
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);
const RETRYING = Symbol("clued-runner-hook-retrying-fetch");
const transient = (error) => Boolean(error && error.transient === true);
const markTransient = (failure) => {
  const error = failure instanceof Error ? failure : new Error(String(failure));
  error.transient = true;
  return error;
};
// CLUED_RUNNER_HOOK_WAIT_SECONDS (480 when unset or not a whole number of seconds).
export function waitLimitSeconds(env) {
  const seconds = Number.parseInt(env.CLUED_RUNNER_HOOK_WAIT_SECONDS ?? "", 10);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : 480;
}
// fetchImpl with bounded retries of transient read failures. A request is a read when its method is GET, or when its caller marks it
// (init.retryRead, a POST that only reads). Each attempt gets its own time bound (init.attemptMs, else READ_ATTEMPT_MS, never past
// deadlineAt) and reads the whole body inside it, so a reply cut off mid-body is a failed attempt too. A failure left at the end is
// marked transient (a transient status is returned as it is: github() marks its error). No attempt starts and no retry waits past
// deadlineAt. Wrapping twice adds nothing. Nothing that is not a read is ever repeated.
export function retryingFetch(fetchImpl, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(),
  deadlineAt = () => Infinity, timeoutSignal = (ms) => AbortSignal.timeout(ms) } = {}) {
  if (fetchImpl[RETRYING]) return fetchImpl;
  const wrapped = async (url, init = {}) => {
    const { retryRead = false, attemptMs = READ_ATTEMPT_MS, ...request } = init;
    if (String(request.method ?? "GET").toUpperCase() !== "GET" && retryRead !== true) return fetchImpl(url, request);
    let failure = null;
    for (let attempt = 1; ; attempt += 1) {
      const left = deadlineAt() - now();
      if (!(left >= 1)) throw markTransient(failure ?? new Error("the hook's time for reads is used up"));
      let response = null;
      failure = null;
      try {
        const answer = await fetchImpl(url, { ...request, signal: timeoutSignal(Math.min(attemptMs, left)) });
        if (TRANSIENT_STATUS.has(answer.status)) {
          try { await answer.body?.cancel?.(); } catch { /* the failed answer is discarded */ }
          response = { status: answer.status, ok: false, json: async () => null, text: async () => "" };
        } else {
          // A malformed body stays the caller's refusal (json() throws there, once, never transient).
          const text = await answer.text();
          return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => JSON.parse(text), text: async () => text };
        }
      } catch (error) {
        failure = error;
      }
      const delay = READ_RETRY_DELAYS_MS[attempt - 1];
      if (attempt >= READ_ATTEMPTS || now() + delay >= deadlineAt()) {
        if (response) return response;
        throw markTransient(failure);
      }
      await sleep(delay);
    }
  };
  wrapped[RETRYING] = true;
  return wrapped;
}

// Native fetch otherwise ignores the runner's established proxy settings.
// Enable Node's own proxy support before any credential or network read,
// without changing wrappers, protected settings, TLS or job permissions.
export function proxyBootstrapArguments({ env = process.env, execArgv = process.execArgv,
  argv = process.argv, allowedFlags = process.allowedNodeEnvironmentFlags } = {}) {
  const proxies = [env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy]
    .filter(value => typeof value === "string" && value.trim());
  if (!proxies.length) return null;
  for (const value of proxies) {
    let protocol;
    try { protocol = new URL(value).protocol; } catch { throw new Error("The configured HTTP proxy is invalid."); }
    if (protocol !== "http:" && protocol !== "https:") throw new Error("The configured HTTP proxy protocol is unsupported.");
  }
  if (!allowedFlags.has("--use-env-proxy")) throw new Error("The installed Node runtime cannot use the configured HTTP proxy.");
  if (env.NODE_USE_ENV_PROXY === "0" || execArgv.includes("--no-use-env-proxy")
    || /(?:^|\s)--no-use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? ""))
    throw new Error("Node proxy use is explicitly disabled for this execution.");
  if (env.NODE_USE_ENV_PROXY === "1" || execArgv.includes("--use-env-proxy")
    || /(?:^|\s)--use-env-proxy(?:\s|$)/.test(env.NODE_OPTIONS ?? "")) return null;
  return [...execArgv, "--use-env-proxy", ...argv.slice(1)];
}

// The same list as DISPATCH_GATED_WORKFLOWS in scripts/ci/clued-work-admission.mjs
// (this file is installed alone, so it keeps its own copy; a test compares them).
export const DISPATCH_GATED_WORKFLOWS = ["clued-connection-authorization.yml", "clued-g4-database.yml", "information-flow-e2e.yml", "clued-handover-external-qualification.yml", "clued-handover-disposable-idle.yml"];
const MAIN_EVENTS = new Set(["push", "schedule", "workflow_run", "pull_request_target", "workflow_dispatch"]);

export function workflowPathOf(env) {
  const match = /^[^/]+\/[^/]+\/(\.github\/workflows\/[^@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "");
  return match ? match[1] : null;
}

async function github(fetchImpl, token, url, { allowMissing = false, method = "GET", body, expect = 200, retryRead = false, asText = false } = {}) {
  const response = await fetchImpl(`https://api.github.com${url}`, {
    method, ...(retryRead ? { retryRead: true } : {}),
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "clued-runner-hook",
      "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allowMissing && response.status === 404) return null;
  if (response.status !== expect) {
    const error = new Error(`GitHub ${url} returned ${response.status}`);
    error.transient = TRANSIENT_STATUS.has(response.status);
    throw error;
  }
  return asText ? response.text() : response.json();
}

// Owner Decision d8bc893c: the hook calls GitHub as its own read-only App, on
// the App's rate limit. On 2026-10-07 an Agent's script spent the Owner
// account's hourly limit, which the hook's personal token shared, and every
// pull request job was refused. The App's key mints a one-hour installation
// token for this repository only, with actions, contents and pull requests
// read whatever else the App may hold. Every job can read the key (the hook
// runs as the runner's account), so the clued-admission App, which posts the admission
// checks, must never be the one configured here: its id is refused.
// The same id as ADMISSION_APP_ID in scripts/ci/clued-work-admission.mjs
// (this file is installed alone, so it keeps its own copy; a test compares them).
export const ADMISSION_APP_ID = 5164952;

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function appJwt(appId, privateKeyPem, nowSeconds) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

async function readToken({ env, fetchImpl, readFile, now, repository, checksRead = false }) {
  const appId = (env.CLUED_RUNNER_HOOK_APP_ID ?? "").trim();
  const keyFile = (env.CLUED_RUNNER_HOOK_APP_KEY_FILE ?? "").trim();
  if (appId || keyFile) {
    if (!/^[0-9]{1,20}$/.test(appId)) throw new Error("CLUED_RUNNER_HOOK_APP_ID is not set to an App id on this runner.");
    if ([ADMISSION_APP_ID, INDEPENDENT_ADMISSION_APP_ID].includes(Number(appId))) {
      throw new Error(`App ${appId} is the clued-admission App; its key must not be on a runner. Configure the hook's read-only App.`);
    }
    if (!keyFile) throw new Error("CLUED_RUNNER_HOOK_APP_KEY_FILE is not set on this runner.");
    const key = String(readFile(keyFile, "utf8")).trim();
    if (!key) throw new Error(`${keyFile} is empty.`);
    const jwt = appJwt(appId, key, Math.floor(now() / 1000));
    const installation = await github(fetchImpl, jwt, `/repos/${repository}/installation`);
    if (!installation || !/^[0-9]{1,20}$/.test(String(installation.id))) throw new Error(`App ${appId} has no installation on ${repository}.`);
    const minted = await github(fetchImpl, jwt, `/app/installations/${installation.id}/access_tokens`, { method: "POST", expect: 201, retryRead: true,
      body: { repositories: [repository.split("/")[1]], permissions: { actions: "read", contents: "read", pull_requests: "read",
        ...(checksRead ? { checks: "read" } : {}) } } });
    if (!minted || typeof minted.token !== "string" || !minted.token) throw new Error(`App ${appId} returned no installation token.`);
    return minted.token;
  }
  const tokenFile = (env.CLUED_RUNNER_HOOK_TOKEN_FILE ?? "").trim();
  if (!tokenFile) {
    throw new Error("CLUED_RUNNER_HOOK_APP_ID and CLUED_RUNNER_HOOK_APP_KEY_FILE (or the older CLUED_RUNNER_HOOK_TOKEN_FILE) are not set on this runner.");
  }
  const token = String(readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error(`${tokenFile} is empty.`);
  return token;
}

// The workflow files a pull request changes against the default branch (from
// their merge base). Its workflows run from the merge ref, which is main plus
// these changes. A list GitHub truncates counts as changing workflows.
export const COMPARE_FILE_LIMIT = 300;
async function changedWorkflows(fetchImpl, token, repository, base, head) {
  const body = await github(fetchImpl, token, `/repos/${repository}/compare/${encodeURIComponent(base)}...${head}`);
  const files = (body && Array.isArray(body.files)) ? body.files : null;
  if (!files || files.length >= COMPARE_FILE_LIMIT) return ["(file list unavailable or truncated)"];
  return files.map((f) => String(f.filename ?? "")).concat(files.map((f) => String(f.previous_filename ?? "")))
    .filter((name) => name.startsWith(".github/workflows/"));
}

// A hand dispatch runs the dispatched commit's own workflow files, so they
// must be main's exactly: same entries, same blob (or tree) object ids.
async function workflowsDifferFromMain(fetchImpl, token, repository, base, sha) {
  const listing = async (ref) => {
    const body = await github(fetchImpl, token, `/repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
      { allowMissing: true });
    if (body === null) return new Map();
    if (!Array.isArray(body)) throw new Error(".github/workflows is not a directory");
    return new Map(body.map((entry) => [String(entry.path ?? entry.name ?? ""), `${entry.type}:${entry.sha}`]));
  };
  const [mine, main] = await Promise.all([listing(sha), listing(base)]);
  const names = new Set([...mine.keys(), ...main.keys()]);
  return [...names].filter((name) => mine.get(name) !== main.get(name)).sort();
}

// The admission run of this run's own event (re-review 5, n1; the same
// selection as eventAdmissionCheck in scripts/ci/clued-work-admission.mjs).
// The runs of one event are created together, so it is the newest
// pull_request_target run of the admission workflow on this head created no
// earlier than SAME_EVENT_MS before this run. A run's creation time, not a
// later posting time, tells a closed and reopened pull request's events apart.
// Skipped runs are passed over: the admission job skips a pull request into
// another branch, and an Agent can open one on the same head.
//
// The run stands in for the clued-admission App's check, which a fine-grained
// token cannot read (Task b979d5a2):
//   - pull_request_target always runs the default branch's copy of the
//     workflow, whatever the pull request's base, and that copy admits only
//     pull requests into the default branch (re-review 6, B1). No branch's
//     edited copy of the file runs on pull_request_target. Runs are listed by
//     the workflow's file name, so a workflow another file adds under the same
//     display name does not count.
//   - The run succeeds only when its admit step does, the same condition on
//     which it posts a successful check.
// The check also named its pull request (re-review 4, m1); a run does not
// (its pull_requests list names every open pull request with the same head).
// Another pull request into main with the same head and an event within
// SAME_EVENT_MS can therefore stand in. Its run judged the same commit and the
// same workflow changes.
export const SAME_EVENT_MS = 15_000;
const ADMISSION_WORKFLOW = "clued-work-admission.yml";
// Installed standalone: keep these producer bindings identical to the
// independent gate in scripts/ci/clued-work-admission.mjs. A status/name alone
// and the negative-only execution_current observation never admit a job.
export const INDEPENDENT_ADMISSION_APP_ID = 5368905;
export const INDEPENDENT_ADMISSION_CHECK = "kooyumi-work-admission";
const NATIVE_ADMISSION_ID = /^independent-ci:native-work-admission:(?:[a-f0-9]{64}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}:a[1-9][0-9]{0,9}|v2:[a-f0-9]{64}:a[12]:c[a-f0-9]{8}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9})$/;

// observedAt: the time the pages were read (a number), or a clock read after the last page (a function; the hook passes its clock,
// so a check completed while a read was tried again is judged at the time it was seen, not at a time taken before the retries).
export async function nativeAdmissionCheck(fetchImpl, token, repository, headSha, prNumber, since, observedAt = Date.now) {
  const checks = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await github(fetchImpl, token, `/repos/${repository}/commits/${headSha}/check-runs?check_name=${INDEPENDENT_ADMISSION_CHECK}&filter=all&per_page=100&page=${page}`);
    if (!body || !Array.isArray(body.check_runs) || !Number.isSafeInteger(body.total_count)
      || body.total_count < 0 || body.total_count > 1000) throw new Error("Native admission checks are incomplete or malformed.");
    checks.push(...body.check_runs);
    if (checks.length >= body.total_count) break;
    if (page === 10 || body.check_runs.length === 0) throw new Error("Native admission checks are incomplete.");
  }
  const observed = typeof observedAt === "function" ? observedAt() : observedAt;
  const newest = checks.filter(check => check?.name === INDEPENDENT_ADMISSION_CHECK
    && check.head_sha === headSha && Number(check.app?.id) === INDEPENDENT_ADMISSION_APP_ID)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
  if (!newest || newest.status !== "completed") return { settled: false, check: newest, admitted: false };
  const named = [...String(newest.output?.summary ?? "").matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]{1,10})(?![0-9])/g)]
    .filter(match => match[1].toLowerCase() === repository.toLowerCase()).map(match => Number(match[2]));
  const started = Date.parse(newest.started_at);
  const completed = Date.parse(newest.completed_at);
  const bound = NATIVE_ADMISSION_ID.test(String(newest.external_id ?? ""))
    && named.length > 0 && named.every(number => number === Number(prNumber))
    && Number.isSafeInteger(newest.id) && newest.id > 0
    && Number.isFinite(started) && Number.isFinite(completed) && completed >= started
    && completed <= observed + SAME_EVENT_MS && Number.isFinite(since) && started >= since - SAME_EVENT_MS;
  return { settled: true, check: newest, admitted: bound && newest.conclusion === "success" };
}

async function admissionRun(fetchImpl, token, repository, headSha, since) {
  const runs = (await github(fetchImpl, token,
    `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}/runs?head_sha=${headSha}&event=pull_request_target&per_page=100`))
    ?.workflow_runs ?? [];
  return runs
    .filter((run) => run && run.event === "pull_request_target" && run.head_sha === headSha && run.conclusion !== "skipped"
      && Date.parse(run.created_at) >= since - SAME_EVENT_MS)
    .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || (Number(b.id) - Number(a.id)))[0] ?? null;
}

// Installed alone and loaded from main: do not import candidate policy/code.
// Requiring admission for ALL members covers protected paths (including any
// additions in main's policy), changed workflow bytes and unavailable diffs.
// S carries the heads as second parents of the train's first-parent chain;
// neither the push payload nor a candidate-authored member list is authority.
async function stagingAdmission({ env, fetchImpl, readFile, now, sleep, repository, defaultBranch, workflow, result }) {
  const refuse = reason => ({ ...result, allow: false, reason: `staging: ${reason}` });
  const sha = env.GITHUB_SHA ?? '', runId = env.GITHUB_RUN_ID ?? '';
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[0-9]{1,20}$/.test(runId)) return refuse('invalid S or run id');
  const token = await readToken({ env, fetchImpl, readFile, now, repository, checksRead: true });
  const run = await github(fetchImpl, token, `/repos/${repository}/actions/runs/${runId}`);
  const attempt = attemptNumber(env.GITHUB_RUN_ATTEMPT ?? '1');
  if (run?.event !== 'push' || run.head_sha !== sha || run.head_branch !== 'clued-train/staging'
    || run.path !== workflow || run.actor?.login !== env.GITHUB_ACTOR
    || attempt === null || run.run_attempt !== attempt || !Number.isFinite(Date.parse(run.created_at)))
    return refuse('run does not bind the workflow, App actor, attempt and S');
  if (attempt > 1 && env.GITHUB_JOB !== GATE_JOB) {
    const attemptStarted = Date.parse(run.run_started_at);
    if (!Number.isFinite(attemptStarted)) return refuse("the run has no run_started_at; re-run refused");
    const gate = await waitForAttemptGate({ fetchImpl, token, repository, runId, attempt, attemptStarted, limit: waitLimitSeconds(env), sleep, now });
    if (gate.state !== "ok") return refuse(`run attempt ${attempt} needs a fresh successful ${GATE_JOB} job: ${gate.detail}`);
  }
  const mainPath = `/repos/${repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`;
  const main = await github(fetchImpl, token, mainPath);
  const base = main?.object?.sha;
  if (main?.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(base ?? '')) return refuse('live main is unavailable');
  const heads = [], seen = new Set();
  let at = sha;
  // Bounded reads; a malformed, cyclic or oversized chain never admits.
  while (at !== base) {
    if (heads.length >= 20 || seen.has(at)) return refuse('merge chain is cyclic, oversized or not rooted at main');
    seen.add(at);
    const commit = await github(fetchImpl, token, `/repos/${repository}/git/commits/${at}`);
    if (commit?.sha !== at || !Array.isArray(commit.parents) || commit.parents.length !== 2
      || commit.parents.some(parent => !/^[a-f0-9]{40}$/.test(parent?.sha ?? ''))
      || commit.parents[0].sha === commit.parents[1].sha || commit.parents[1].sha === base
      || heads.includes(commit.parents[1].sha)) return refuse('invalid merge chain');
    heads.push(commit.parents[1].sha);
    at = commit.parents[0].sha;
  }
  if (!heads.length) return refuse('S has no PR members');
  const memberIsLive = (pr, head) => Number.isSafeInteger(pr?.number) && pr.number > 0
    && pr.state === 'open' && pr.draft === false && pr.head?.sha === head
    && pr.head?.repo?.full_name === repository && pr.base?.repo?.full_name === repository
    && pr.base?.ref === defaultBranch && Number.isFinite(Date.parse(pr.created_at));
  const members = [];
  for (const head of heads.reverse()) {
    const pulls = await github(fetchImpl, token, `/repos/${repository}/commits/${head}/pulls?per_page=100`);
    if (!Array.isArray(pulls) || pulls.length >= 100) return refuse('member PR list is unavailable or truncated');
    const candidates = pulls.filter(pr => memberIsLive(pr, head));
    if (candidates.length !== 1) return refuse('member has no unique open current PR into main');
    const pr = candidates[0];
    // Preserve the PR route's same-event lower bound: an older success on
    // the same head must not authorize a close/reopen or a new workflow run.
    const runs = await github(fetchImpl, token, `/repos/${repository}/actions/workflows/clued-required-tests.yml/runs?head_sha=${head}&event=pull_request&per_page=100`);
    if (!Array.isArray(runs?.workflow_runs) || !Number.isSafeInteger(runs.total_count)
      || runs.total_count !== runs.workflow_runs.length || runs.total_count >= 100)
      return refuse('member PR workflow runs are unavailable or truncated');
    const latest = runs.workflow_runs.filter(candidate => candidate?.event === 'pull_request' && candidate.head_sha === head
      && candidate.path === workflow && candidate.pull_requests?.some(pull => pull.number === pr.number))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    const since = Date.parse(latest?.created_at);
    if (!Number.isFinite(since) || since < Date.parse(pr.created_at) || since > now() + SAME_EVENT_MS)
      return refuse('member has no current PR workflow event');
    const admission = await nativeAdmissionCheck(fetchImpl, token, repository, head, pr.number, since, now);
    if (!admission.admitted) return refuse(`PR #${pr.number} has no successful exact-head Native admission`);
    members.push({ number: pr.number, head });
  }
  // Re-read all members after the proof reads, then main. A moved/closed PR
  // or an advanced base requires a new staging batch, never an old proof.
  for (const member of members) {
    const current = await github(fetchImpl, token, `/repos/${repository}/pulls/${member.number}`);
    if (current?.number !== member.number || !memberIsLive(current, member.head)) return refuse('member PR moved or closed');
  }
  const currentMain = await github(fetchImpl, token, mainPath);
  if (currentMain?.object?.type !== 'commit' || currentMain.object.sha !== base) return refuse('main moved');
  return { ...result, allow: true, reason: `App 5368905 staging S rooted at ${base}, all ${members.length} PR heads admitted`,
    execution_targets: members.map(member => ({ repository, head_sha: member.head,
      pr_ref: `${repository}#${member.number}`, target_branch: defaultBranch })) };
}

// Whether the workflow is an ungated short check on the default branch and
// the run's commit has that very file: same path, same git blob, the default
// branch's copy names no admission-gate anywhere (fail closed: any mention
// counts as gated), and every job in it has a literal timeout-minutes of at
// most UNGATED_RERUN_TIMEOUT_CAP. The attempt's job list is checked first;
// the default branch's file decides as well, as defense in depth. A copy the
// pull request changed is never re-run this way (Task 26cced7e; review
// MINOR-1, MINOR-2).
export const UNGATED_RERUN_TIMEOUT_CAP = 30;
export function shortCheckFindings(text) {
  const yaml = String(text ?? "").replace(/\r\n?/g, "\n");
  if (yaml.includes("admission-gate")) return ["names admission-gate"];
  const jobsAt = yaml.search(/^jobs:\s*(#.*)?$/m);
  if (jobsAt < 0) return ["has no jobs block"];
  const jobs = yaml.slice(jobsAt).split("\n").slice(1).join("\n").split(/^(?= {2}[A-Za-z0-9_-]+:\s*(#.*)?$)/m)
    .filter((chunk) => /^ {2}[A-Za-z0-9_-]+:/.test(chunk));
  if (!jobs.length) return ["has no jobs"];
  const findings = [];
  for (const job of jobs) {
    const name = /^ {2}([A-Za-z0-9_-]+):/.exec(job)[1];
    const timeout = /^ {4}timeout-minutes:\s*(\d{1,4})\s*(#.*)?$/m.exec(job);
    if (!timeout) findings.push(`job ${name} has no literal timeout-minutes`);
    else if (Number(timeout[1]) > UNGATED_RERUN_TIMEOUT_CAP) findings.push(`job ${name} may run ${timeout[1]} minutes (cap ${UNGATED_RERUN_TIMEOUT_CAP})`);
  }
  return findings;
}
async function ungatedAsDefaultBranch(fetchImpl, token, repository, defaultBranch, sha, workflow) {
  const file = async (ref) => {
    const body = await github(fetchImpl, token,
      `/repos/${repository}/contents/${workflow.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      { allowMissing: true });
    return body && body.type === "file" && /^[0-9a-f]{40}$/.test(String(body.sha ?? "")) ? body : null;
  };
  const [atHead, atDefault] = await Promise.all([file(sha), file(defaultBranch)]);
  if (!atHead || !atDefault || atHead.sha !== atDefault.sha) return { ok: false, why: `its file at ${sha} is not ${defaultBranch}'s` };
  if (typeof atDefault.content !== "string" || atDefault.encoding !== "base64") return { ok: false, why: `${defaultBranch}'s copy cannot be read` };
  const findings = shortCheckFindings(Buffer.from(atDefault.content, "base64").toString("utf8"));
  if (findings.includes("names admission-gate")) {
    return { ok: false, why: `${defaultBranch}'s copy has an ${GATE_JOB} job, so it re-runs only with "Re-run all jobs"` };
  }
  if (findings.length) return { ok: false, why: `${defaultBranch}'s copy is not a short check (${findings.join("; ")})` };
  return { ok: true };
}

// Re-runs of a pull request run (MergeAdmission v0.1 §8; Owner Decisions
// 77216370 item 2 and 3, 1b93760d item 2, 661f8c36).
export const GATE_JOB = "admission-gate";
// Required checks without a gate: one re-run (attempt 2) on the current head.
export const RERUN_ONCE_WORKFLOWS = [".github/workflows/gitleaks.yml", ".github/workflows/trivy.yml"];

// A run attempt number, or null when it is not one.
function attemptNumber(value) {
  const text = String(value ?? "").trim();
  return /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : null;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// This attempt's admission-gate job. "Re-run all jobs" runs the gate again,
// so its start time is no earlier than the attempt's (run_started_at, which
// changes per attempt; created_at does not). "Re-run failed jobs" and a
// single-job re-run list the earlier, not re-run gate job in the new attempt,
// with a new id, a later created_at, conclusion success and this attempt's
// number, but its started_at stays the earlier attempt's (measured on
// microsoft/vscode run 37727629063). A list that is not complete, or a time
// that cannot be read, refuses.
// The gate is found by its display name, so exactly one job of the attempt
// may carry it, and that job must run on a self-hosted runner (every gate job
// does; review MINOR-2): a second job named admission-gate, or one on a hosted
// runner, refuses.
// A gate job of this attempt that has not started yet (no started_at) or has
// not completed is pending: the caller polls again within its bounded wait
// and refuses at the end of it (review NIT-5).
async function gateInAttempt(fetchImpl, token, repository, runId, attempt, attemptStarted) {
  const body = await github(fetchImpl, token, `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
  const jobs = body && Array.isArray(body.jobs) ? body.jobs : null;
  if (!jobs) return { state: "refused", detail: `attempt ${attempt}'s job list is unavailable` };
  const total = Number(body.total_count);
  if (!Number.isInteger(total) || total > jobs.length) {
    return { state: "refused", detail: `attempt ${attempt} has ${body.total_count ?? "an unknown number of"} jobs and ${jobs.length} were listed` };
  }
  const gates = jobs.filter((job) => job && job.name === GATE_JOB);
  if (gates.length === 0) return { state: "refused", ungated: true, detail: `attempt ${attempt} has no ${GATE_JOB} job` };
  if (gates.length > 1) {
    return { state: "refused", detail: `attempt ${attempt} has ${gates.length} jobs named ${GATE_JOB} (${gates.map((job) => job.id).join(", ")}); exactly one is required` };
  }
  const gate = gates[0];
  if (!Array.isArray(gate.labels) || !gate.labels.includes("self-hosted")) {
    return { state: "refused", detail: `${GATE_JOB} job ${gate.id} does not run on a self-hosted runner (labels ${JSON.stringify(gate.labels ?? null)})` };
  }
  if (gate.run_attempt !== undefined && gate.run_attempt !== null && Number(gate.run_attempt) !== attempt) {
    return { state: "refused", detail: `${GATE_JOB} job ${gate.id} belongs to attempt ${gate.run_attempt}, not ${attempt}` };
  }
  const state = `${GATE_JOB} job ${gate.id}: ${gate.status ?? "unknown"}/${gate.conclusion ?? "none"}`;
  const noStart = gate.started_at === undefined || gate.started_at === null || gate.started_at === "";
  if (noStart || gate.status !== "completed") return { state: "pending", detail: noStart ? `${state}, not started` : state };
  const started = Date.parse(gate.started_at);
  if (!Number.isFinite(started)) return { state: "refused", detail: `${GATE_JOB} job ${gate.id} has an unreadable started_at ${JSON.stringify(gate.started_at)}` };
  if (started < attemptStarted) {
    return { state: "refused", detail: `${GATE_JOB} job ${gate.id} started ${gate.started_at}, not in this attempt: it was not re-run` };
  }
  if (gate.conclusion !== "success") return { state: "refused", detail: state };
  return { state: "ok", job: gate };
}

async function waitForAttemptGate({ fetchImpl, token, repository, runId, attempt, attemptStarted, limit, sleep, now }) {
  const waitUntil = now() + limit * 1000;
  for (let waited = 0; ; waited += 10) {
    let seen;
    try {
      seen = await gateInAttempt(fetchImpl, token, repository, runId, attempt, attemptStarted);
    } catch (error) {
      if (!transient(error) || waited >= limit || now() >= waitUntil) throw error;
      seen = { state: "pending" };
    }
    if (seen.state !== "pending" || waited >= limit || now() >= waitUntil) return seen;
    await sleep(10_000);
  }
}

// Late Native admission (required-tests-late-admission-v1, defect B): a pull
// request that changes a workflow writes its own admission-gate job, so the
// gate's re-run rules are its own to forge, and this hook alone bounds how
// often such a run runs: once per admitted head. That once is the first
// attempt that runs anything. A job ran nothing when it was skipped, or
// failed only in the runner's own setup, before any step of the workflow:
// "Set up job" (the runner) or "Set up runner" (this hook, which always comes
// right after it, so a workflow step of that name sits later and does not
// count), with every later step skipped but the closing "Complete job". The
// whole job list of every earlier attempt must be readable; anything else
// counts as having run.
export const RUNNER_SETUP_STEPS = ["Set up job", "Set up runner"];
export function ranNothing(job) {
  if (!job || job.status !== "completed") return false;
  if (job.conclusion === "skipped") return true;
  const steps = job.conclusion === "failure" && Array.isArray(job.steps) ? job.steps : [];
  const failed = steps.filter((step) => step && step.conclusion === "failure");
  return failed.length > 0 && steps.every((step, index) => step && (RUNNER_SETUP_STEPS[index] === step.name
    || step.conclusion === "skipped" || (index === steps.length - 1 && step.name === "Complete job" && step.conclusion !== "failure")));
}
async function earlierAttemptsRanNothing(fetchImpl, token, repository, runId, attempt) {
  for (let earlier = 1; earlier < attempt; earlier += 1) {
    const body = await github(fetchImpl, token, `/repos/${repository}/actions/runs/${runId}/attempts/${earlier}/jobs?per_page=100`);
    const jobs = body && Array.isArray(body.jobs) ? body.jobs : null;
    if (!jobs || !Number.isInteger(Number(body.total_count)) || Number(body.total_count) > jobs.length)
      return { ok: false, why: `attempt ${earlier}'s job list is incomplete` };
    const ran = jobs.filter((job) => !ranNothing(job));
    if (ran.length) return { ok: false, why: `attempt ${earlier} already ran ${ran.map((job) => `${String(job?.name).slice(0, 40)} ${job?.status}/${job?.conclusion ?? "none"}`).join(", ")}` };
  }
  return { ok: true, why: "" };
}

// Whether a job of attempt `attempt` (2 or later) of this pull request run may
// start. The workflow-change rule is applied afterwards, as for attempt 1.
// Every error, and everything that cannot be observed, refuses.
async function rerunVerdict({ env, fetchImpl, token, repository, defaultBranch, runId, run, pr, attempt, workflow, limit, sleep, now }) {
  const what = `pull request #${pr.number ?? "(none)"}, run attempt ${attempt}`;
  const refuse = (why) => ({ allow: false, reason: `${what}: ${why}` });
  if (!/^[1-9][0-9]{0,9}$/.test(String(pr.number ?? ""))) return refuse("the event names no pull request number; re-run refused");
  if (!/^[0-9a-f]{40}$/.test(String(pr.head.sha ?? ""))) return refuse("the event names no head commit; re-run refused");
  let current;
  try {
    current = await github(fetchImpl, token, `/repos/${repository}/pulls/${pr.number}`);
  } catch (error) {
    return refuse(`cannot read the pull request (${errorText(error)}); re-run refused`);
  }
  if (!current || current.state !== "open") {
    return refuse(`the pull request is ${current && current.state ? current.state : "unreadable"}; only an open pull request's current head may be re-run`);
  }
  if (!current.base || current.base.ref !== defaultBranch) {
    return refuse(`the pull request now targets ${current.base ? current.base.ref : "(unknown)"}, not ${defaultBranch}; re-run refused`);
  }
  if (!current.head || current.head.sha !== pr.head.sha) {
    return refuse(`${pr.head.sha} is not the pull request's current head (${current.head ? current.head.sha : "unknown"}); `
      + "an old head's run may not be re-run, re-run the current head's run");
  }
  if ((env.GITHUB_JOB ?? "") === GATE_JOB) {
    return { allow: true, reason: `run attempt ${attempt} on the current head: the ${GATE_JOB} job judges the re-run itself` };
  }
  if (RERUN_ONCE_WORKFLOWS.includes(workflow)) {
    return attempt === 2 ? { allow: true, reason: `run attempt 2 of ${workflow} on the current head (one re-run allowed)` }
      : refuse(`${workflow} may be re-run once (attempt 2) only`);
  }
  const attemptStarted = Date.parse(run && run.run_started_at);
  if (!Number.isFinite(attemptStarted)) return refuse("the run has no run_started_at; re-run refused");
  // A heavy job needs the gate, so a gate job of this attempt still shown as
  // not started or not completed is the API's lag: wait for it, like for the
  // admission run below, and refuse at the end of the wait.
  let seen;
  try {
    seen = await waitForAttemptGate({ fetchImpl, token, repository, runId, attempt, attemptStarted, limit, sleep, now });
  } catch (error) {
    return refuse(`cannot read attempt ${attempt}'s jobs (${errorText(error)}); re-run refused`);
  }
  if (seen.state === "ok") {
    return { allow: true, reason: `run attempt ${attempt} on the current head: ${GATE_JOB} job ${seen.job.id} ran again in this attempt and succeeded` };
  }
  // An ungated workflow (no admission-gate job in this attempt), as the
  // default branch has it: once, like gitleaks and trivy (Task 26cced7e).
  if (seen.ungated) {
    if (attempt !== 2) return refuse(`attempt ${attempt} lists no ${GATE_JOB} job (${seen.detail}); a workflow without one may be re-run once (attempt 2) only`);
    let verdict;
    try {
      // The run's own commit (GITHUB_SHA, the merge commit the job runs), so the file compared is the one that runs (review NIT-1).
      verdict = await ungatedAsDefaultBranch(fetchImpl, token, repository, defaultBranch, (env.GITHUB_SHA ?? "").trim(), workflow);
    } catch (error) {
      return refuse(`cannot compare ${workflow} with ${defaultBranch} (${errorText(error)}); re-run refused`);
    }
    if (!verdict.ok) {
      return refuse(`attempt 2 lists no ${GATE_JOB} job, but ${workflow}: ${verdict.why}; `
        + `an ungated workflow is re-run only as ${defaultBranch} has it`);
    }
    return { allow: true, reason: `run attempt 2 of ${workflow} on the current head: no ${GATE_JOB} job, the file is ${defaultBranch}'s (one re-run allowed)` };
  }
  return refuse(`no ${GATE_JOB} job that ran again in this attempt and succeeded (${seen.detail}); `
    + `use "Re-run all jobs", not "Re-run failed jobs" or a single job`);
}

// The reads of one hook run: one wrapper, its deadline twice the wait plus READ_ALLOWANCE_MS from the run's start.
function hookReads({ env, fetchImpl, sleep, now, timeoutSignal }) {
  const deadline = now() + 2 * waitLimitSeconds(env) * 1000 + READ_ALLOWANCE_MS;
  return retryingFetch(fetchImpl, { sleep, now, deadlineAt: () => deadline, ...(timeoutSignal ? { timeoutSignal } : {}) });
}
export async function decide({ env, fetchImpl: rawFetch, readFile = fs.readFileSync, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(), timeoutSignal = null }) {
  const fetchImpl = hookReads({ env, fetchImpl: rawFetch, sleep, now, timeoutSignal });
  const result = { allow: false, reason: "", event: env.GITHUB_EVENT_NAME ?? "", ref: env.GITHUB_REF ?? "", workflow: null };
  const repository = (env.CLUED_RUNNER_HOOK_REPOSITORY ?? "").trim();
  const defaultBranch = (env.CLUED_RUNNER_HOOK_DEFAULT_BRANCH ?? "").trim() || "main";
  const mainRef = `refs/heads/${defaultBranch}`;
  if (!repository) throw new Error("CLUED_RUNNER_HOOK_REPOSITORY is not set on this runner.");
  if (env.GITHUB_REPOSITORY !== repository) {
    result.reason = `repository ${env.GITHUB_REPOSITORY} is not ${repository}`;
    return result;
  }
  const workflow = workflowPathOf(env);
  result.workflow = workflow;
  if (!workflow) throw new Error(`GITHUB_WORKFLOW_REF is not a workflow path: ${env.GITHUB_WORKFLOW_REF}`);
  const event = result.event;
  if (event === 'push' && result.ref === 'refs/heads/clued-train/staging' &&
    workflow === '.github/workflows/clued-required-tests.yml' &&
    env.GITHUB_ACTOR === 'clued-ci-checks-turing-20261018[bot]') {
    return stagingAdmission({ env, fetchImpl, readFile, now, sleep, repository, defaultBranch, workflow, result });
  }
  const requiredDispatch = event === 'workflow_dispatch' && workflow === '.github/workflows/clued-required-tests.yml';
  if (MAIN_EVENTS.has(event) && result.ref === mainRef && !requiredDispatch) {
    // Re-review 7, m1: pull_request_target runs on the default branch's ref
    // whatever the pull request's base, and a workflow may check out that
    // base, which an Agent controls when it is another branch.
    if (event === "pull_request_target") {
      const payload = JSON.parse(String(readFile(env.GITHUB_EVENT_PATH, "utf8")));
      const base = payload && payload.pull_request && payload.pull_request.base;
      if (!base || base.ref !== defaultBranch) {
        result.reason = `pull_request_target for a pull request into ${base ? base.ref : "(unknown)"}, not ${defaultBranch}`;
        return result;
      }
    }
    result.allow = true;
    result.reason = `${event} on ${defaultBranch}`;
    return result;
  }
  if (event !== "pull_request" && event !== "workflow_dispatch") {
    result.reason = `${event} on ${result.ref} is not allowed on this runner`;
    return result;
  }
  const sha = (env.GITHUB_SHA ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_SHA is not a commit SHA.");
  const runId = (env.GITHUB_RUN_ID ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(runId)) throw new Error("GITHUB_RUN_ID is not a run id.");
  const token = await readToken({ env, fetchImpl, readFile, now, repository });
  const run = await github(fetchImpl, token, `/repos/${repository}/actions/runs/${runId}`);
  if (event === "workflow_dispatch") {
    // Re-review 3, N-R3, unchanged: a hand dispatch off main is never re-run.
    const attempt = Math.max(Number(run && run.run_attempt) || 1, Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? "1", 10) || 1);
    if (attempt > 1) {
      result.reason = `${event} on ${result.ref}: run attempt ${attempt}; re-runs are refused, push a new commit`;
      return result;
    }
    const file = workflow.slice(".github/workflows/".length);
    if (requiredDispatch) {
      const payload = JSON.parse(String(readFile(env.GITHUB_EVENT_PATH, 'utf8')));
      const { pr: number, head } = payload?.inputs ?? {};
      if (!/^[1-9][0-9]{0,9}$/.test(String(number ?? '')) || head !== sha
        || !env.GITHUB_REPOSITORY_OWNER || env.GITHUB_ACTOR !== env.GITHUB_REPOSITORY_OWNER
        || run?.run_attempt !== 1) {
        result.reason = 'required-tests dispatch target, actor or attempt refused';
        return result;
      }
      const pr = await github(fetchImpl, token, `/repos/${repository}/pulls/${number}`);
      if (pr?.number !== Number(number) || pr.state !== 'open' || pr.head?.sha !== head
        || pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository
        || pr.base?.ref !== defaultBranch || result.ref !== `refs/heads/${pr.head.ref}`) {
        result.reason = 'required-tests dispatch PR is closed, foreign or moved';
        return result;
      }
      // Retain the branch-dispatch rule: workflow bytes must match main.
      // The unchanged trusted gate then judges the Native PR admission.
      const differing = await workflowsDifferFromMain(fetchImpl, token, repository, defaultBranch, sha);
      result.allow = differing.length === 0;
      result.reason = result.allow ? `required-tests recovery for current PR #${number}` : 'required-tests dispatch workflows differ from main';
      if (result.allow) result.execution_target = { repository, head_sha: head, pr_ref: `${repository}#${number}`, target_branch: defaultBranch };
      return result;
    }
    if (!DISPATCH_GATED_WORKFLOWS.includes(file)) {
      result.reason = `dispatch of ${workflow} on ${result.ref}: only ${DISPATCH_GATED_WORKFLOWS.join(", ")} may be dispatched on another branch; this one runs on ${defaultBranch} only`;
      return result;
    }
    const differing = await workflowsDifferFromMain(fetchImpl, token, repository, defaultBranch, sha);
    result.allow = differing.length === 0;
    result.reason = result.allow ? `dispatch on ${result.ref}, workflows identical to ${defaultBranch}`
      : `dispatch on ${result.ref}: workflows differ from ${defaultBranch} (${differing.join(", ")}); merge ${defaultBranch} into the branch first`;
    return result;
  }
  if (event === "pull_request") {
    const payload = JSON.parse(String(readFile(env.GITHUB_EVENT_PATH, "utf8")));
    const pr = payload && payload.pull_request;
    if (!pr || !pr.base || !pr.head) throw new Error("pull_request payload is missing.");
    if (pr.base.ref !== defaultBranch) {
      result.reason = `pull request into ${pr.base.ref}, not ${defaultBranch}`;
      return result;
    }
    const limit = waitLimitSeconds(env);
    // The attempt as the runner and as GitHub see it; both must be readable
    // and the same.
    const runnerAttempt = attemptNumber((env.GITHUB_RUN_ATTEMPT ?? "").trim() || "1");
    const apiAttempt = attemptNumber(run && run.run_attempt);
    if (runnerAttempt === null || apiAttempt === null || runnerAttempt !== apiAttempt) {
      result.reason = `pull request #${pr.number}: run attempt ${env.GITHUB_RUN_ATTEMPT ?? "(unset)"} on the runner and `
        + `${run && run.run_attempt !== undefined ? run.run_attempt : "(none)"} on GitHub do not agree; refused`;
      return result;
    }
    let rerun = "";
    if (runnerAttempt > 1) {
      const verdict = await rerunVerdict({ env, fetchImpl, token, repository, defaultBranch, runId, run, pr, attempt: runnerAttempt,
        workflow, limit, sleep, now });
      if (!verdict.allow) {
        result.reason = verdict.reason;
        return result;
      }
      rerun = `; ${verdict.reason}`;
    }
    const changed = await changedWorkflows(fetchImpl, token, repository, defaultBranch, pr.head.sha);
    if (changed.length === 0) {
      result.allow = true;
      result.reason = `pull request #${pr.number} changes no workflow${rerun}`;
      return result;
    }
    const since = Date.parse(run && run.created_at);
    if (!Number.isFinite(since)) throw new Error(`run ${runId} has no created_at.`);
    // GitHub's workflow state is an Owner-controlled producer switch. Only
    // explicit manual retirement selects Native. Unknown/404/403 fail closed;
    // a failed Native check never falls back to legacy success.
    const producer = await github(fetchImpl, token, `/repos/${repository}/actions/workflows/${ADMISSION_WORKFLOW}`);
    if (producer?.path !== `.github/workflows/${ADMISSION_WORKFLOW}`
      || !["active", "disabled_manually"].includes(producer.state)) throw new Error("Admission producer state is unavailable or unsupported.");
    if (producer.state === "disabled_manually") {
      const nativeToken = await readToken({ env, fetchImpl, readFile, now, repository, checksRead: true });
      let native;
      const waitUntil = now() + limit * 1000;
      for (let waited = 0; ; waited += 10) {
        try {
          native = await nativeAdmissionCheck(fetchImpl, nativeToken, repository, pr.head.sha, pr.number, since, now);
        } catch (error) {
          // Not settled yet while the wait lasts; the last transient failure refuses at its end (fail closed).
          if (!transient(error) || waited >= limit || now() >= waitUntil) throw error;
          native = { settled: false, check: null, admitted: false };
        }
        if (native.settled || waited >= limit || now() >= waitUntil) break;
        await sleep(10_000);
      }
      const current = await github(fetchImpl, token, `/repos/${repository}/pulls/${pr.number}`);
      const live = current?.state === "open" && current.base?.ref === defaultBranch
        && current.base?.repo?.full_name?.toLowerCase() === repository.toLowerCase() && current.head?.sha === pr.head.sha;
      let repair = { ok: true, why: "" };
      if (native.admitted && live && runnerAttempt > 1) {
        if (workflow !== ".github/workflows/clued-required-tests.yml") {
          repair = await earlierAttemptsRanNothing(fetchImpl, token, repository, runId, runnerAttempt);
        } else if (run.head_sha !== pr.head.sha || run.path !== workflow || run.event !== "pull_request") {
          repair = { ok: false, why: "the run does not bind this workflow and PR head" };
        } else {
          const history = await requiredTestsRepairHistory({ repository, runId, head: pr.head.sha, attempt: runnerAttempt,
            workflowId: run.workflow_id, read: route => github(fetchImpl, nativeToken, route),
            readLog: route => github(fetchImpl, nativeToken, route, { asText: true }) });
          repair = { ok: history.allowed, why: history.reason };
        }
      }
      result.allow = Boolean(native.admitted && live && repair.ok);
      result.reason = `pull request #${pr.number} changes ${[...new Set(changed)].join(", ")}; Native admission ${native.check?.id ?? "absent"}: `
        + `${result.allow ? "succeeded" : `not admitted (binding, current head, conclusion, freshness or rerun${repair.why ? `: ${repair.why}` : ""})`}${rerun}`;
      return result;
    }
    let found = null;
    const waitUntil = now() + limit * 1000;
    for (let waited = 0; ; waited += 10) {
      try {
        found = await admissionRun(fetchImpl, token, repository, pr.head.sha, since);
      } catch (error) {
        if (!transient(error) || waited >= limit || now() >= waitUntil) throw error;
        found = null;
      }
      if ((found && found.status === "completed") || waited >= limit || now() >= waitUntil) break;
      await sleep(10_000);
    }
    result.allow = Boolean(found && found.status === "completed" && found.conclusion === "success");
    const what = [...new Set(changed)].join(", ");
    const seen = !found ? "no admission run" : `admission run ${found.id}: ${found.status}/${found.conclusion ?? "none"}`;
    result.reason = result.allow ? `pull request #${pr.number} changes ${what}; admission run ${found.id} succeeded${rerun}`
      : `pull request #${pr.number} changes ${what}; no successful ${ADMISSION_WORKFLOW} run on ${pr.head.sha} from this event (created since ${run.created_at} less ${SAME_EVENT_MS / 1000}s; ${seen})${rerun}`;
    return result;
  }
  throw new Error(`unreachable event ${event}`);
}

// The existing GitHub verdict is necessary. Just before starting a branch
// job, independently observe the service's current execution epoch as well.
// The public configuration is read from trusted default-branch contents,
// never from a pull request's checkout or environment overrides. The query
// carries no Binding token, private lease key, or admission App credential.
export async function decideWithCurrentEpoch(options) {
  const { env, readFile = fs.readFileSync, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutSignal = null } = options;
  const fetchImpl = hookReads({ env, fetchImpl: options.fetchImpl, sleep, now, timeoutSignal });
  const result = await decide({ ...options, fetchImpl });
  if (!result.allow || (MAIN_EVENTS.has(env.GITHUB_EVENT_NAME) && env.GITHUB_REF ===
    `refs/heads/${(env.CLUED_RUNNER_HOOK_DEFAULT_BRANCH ?? "").trim() || "main"}`)) return result;
  const repository = env.CLUED_RUNNER_HOOK_REPOSITORY;
  const defaultBranch = (env.CLUED_RUNNER_HOOK_DEFAULT_BRANCH ?? "").trim() || "main";
  const token = await readToken({ env, fetchImpl, readFile, now, repository });
  const configuration = await github(fetchImpl, token, `/repos/${repository}/contents/apps/clued-cloud/app/supabase-public-config.ts?ref=${encodeURIComponent(defaultBranch)}`);
  if (configuration?.type !== "file" || configuration.encoding !== "base64"
    || typeof configuration.content !== "string" || configuration.content.length > 32768)
    throw new Error("Trusted Clued public configuration is unavailable");
  const source = Buffer.from(configuration.content, "base64").toString("utf8");
  const match = /return \{ url: "(https:\/\/[a-z0-9-]+\.supabase\.co)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(source);
  if (!match) throw new Error("Trusted Clued public configuration is invalid");
  let targets;
  if (result.execution_targets) {
    targets = result.execution_targets;
  } else if (result.execution_target) {
    targets = [result.execution_target];
  } else if (env.GITHUB_EVENT_NAME === "pull_request") {
    const payload = JSON.parse(String(readFile(env.GITHUB_EVENT_PATH, "utf8")));
    targets = [{ repository, head_sha: payload.pull_request.head.sha,
      pr_ref: `${repository}#${payload.pull_request.number}`, target_branch: payload.pull_request.base.ref }];
  } else {
    targets = [{ repository, head_sha: env.GITHUB_SHA, target_branch: env.GITHUB_REF_NAME,
      workflow: result.workflow.slice(".github/workflows/".length) }];
  }
  for (const target of targets) {
    const response = await fetchImpl(`${match[1]}/rest/v1/rpc/clued_work_verify_v1`, {
      method: "POST", retryRead: true, attemptMs: OBSERVATION_ATTEMPT_MS, headers: { apikey: match[2], authorization: `Bearer ${match[2]}`, "content-type": "application/json" },
      body: JSON.stringify({ p_token_hash: null, p_input: { action: "execution_current", ...target } }),
    });
    if (response.status !== 200) throw new Error(`Clued execution epoch unavailable (${response.status})`);
    const observation = await response.json();
    if (observation?.status !== "ok" || typeof observation.guard_required !== "boolean"
      || (observation.guard_required && typeof observation.epoch_current !== "boolean"))
      throw new Error("Clued execution epoch observation is invalid");
    if (observation.guard_required && !observation.epoch_current)
      return { ...result, allow: false, reason: "work claim execution epoch is stale or handover is pending" };
  }
  return result;
}

// options.sourceSha256: the sha256 of the bytes this hook runs from, given by the loader that read them from main (a hook it runs
// from memory has no file of its own); without it, this file's own bytes.
export async function main(env = process.env, fetchImpl = globalThis.fetch, { sourceSha256 = null } = {}) {
  const enforce = /^(1|true|on|enabled)$/i.test((env.CLUED_RUNNER_HOOK_ENFORCE ?? "").trim());
  let result;
  try {
    result = await decideWithCurrentEpoch({ env, fetchImpl });
  } catch (error) {
    result = { allow: false, reason: `check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  // Same original pre-job point; this does not assert Native job execution.
  try {
    const positive=v=>/^[1-9][0-9]{0,19}$/.test(String(v??""))?String(v):null;
    const key=v=>/^[A-Za-z0-9_./:@-]{1,250}$/.test(String(v??""))?String(v):null;
    console.log("clued-r9-pre-job: "+JSON.stringify({schema:"clued.merge-admission-runner-observation/1",
      run_id:positive(env.GITHUB_RUN_ID),attempt:positive(env.GITHUB_RUN_ATTEMPT),logical_job_key:key(env.GITHUB_JOB),
      repository:key(env.GITHUB_REPOSITORY),workflow:key(result.workflow),hook_version:HOOK_VERSION,
      source_sha256:/^[0-9a-f]{64}$/.test(String(sourceSha256))?sourceSha256:createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
      observed_at:new Date().toISOString(),allow:result.allow,enforced:enforce,
      phase:"pre_job_permission",native_job_started_at:null,native_job_completed_at:null,
      source_authenticated:false,official_metric:false,t0:null}));
  } catch { /* Observation failure cannot alter the original gate result. */ }
  const line = `clued-runner-hook: ${result.allow ? "ALLOW" : enforce ? "REFUSE" : "WOULD REFUSE"} ${result.reason} [hook ${HOOK_VERSION}]`;
  if (result.allow) { console.log(line); return 0; }
  console.log(enforce ? `::error title=Clued runner check::${line}` : `::warning title=Clued runner check (not enforced)::${line}`);
  return enforce ? 1 : 0;
}

// The entry point, also behind a link or junction (defect 2102f7e1). An argv[1] that does not exist is not this file
// (an importer's); this file's own path always resolves.
// Run from memory by the loader (a data: URL), it is never the entry point.
const realOrNull = (file) => { try { return fs.realpathSync(file); } catch { return null; } };
if (import.meta.url.startsWith("file:") && process.argv[1] && realOrNull(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const proxyArguments = proxyBootstrapArguments();
    if (proxyArguments) {
      const child = spawnSync(process.execPath, proxyArguments, { env: process.env, stdio: "inherit" });
      if (child.error) throw new Error("The proxy-enabled hook process could not start.");
      process.exit(Number.isInteger(child.status) ? child.status : 1);
    }
  } catch (error) {
    console.error(`::error title=Clued runner check::clued-runner-hook: REFUSE ${error.message} [hook ${HOOK_VERSION}]`);
    process.exit(1);
  }
  main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
}
