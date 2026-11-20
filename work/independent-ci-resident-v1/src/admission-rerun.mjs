// DESIGN §56.5: the companion asks for whole-workflow repairs with the
// same gh login it uses for PR status. The new attempt's gate still decides
// whether the heavy jobs may run.
//
// Inspect gated workflows that produce required Actions checks, on an
// admitted PR head or the train's staging push. The newest qualifying run is the
// repair candidate and the previous attempts are checked by the existing
// repair rule. A different workflow's work cannot consume its repair budget.
// The main rules and exact SHA's Actions check runs determine when to stop
// watching a PR head. Staging settles on its own scoped push runs.
//
// When GitHub created no run, or a bot's run skipped all heavy jobs, an
// active workflow whose trusted definition supplies a missing check may be
// dispatched once per head. Read the PR and workflow inventory again before
// sending. An intent is durable before either kind of request. Only an
// unsent or unknown rerun may be retried, once, after ten minutes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, canonicalJson, check } from './canonical.mjs';
import { STATUS_STALE_MS } from './status.mjs';
import { LIVE_STATES } from './queue.mjs';
import { diedInSetup, failedSteps, jobFailureKind, neverAssigned, requiredTestsRepairHistory } from './env-failure.mjs';
import { RULES_UNREADABLE_REPORT_AFTER_MS, RulesShapeError, readMainRequiredChecks } from './main-required-checks.mjs';

export const RERUN_RECORD_CONTRACT = 'clued.independent-ci.admission-rerun/1';
export const RERUN_STATE_CONTRACT = 'clued.independent-ci.admission-rerun-state/1';
// A head with no run of the workflow this long after the lane first saw it lost its run (the lane sees a head within about two
// minutes of the push: the poller's minute, then this lane's).
export const LOST_RUN_AFTER_MS = 5 * 60_000;
export const REDISPATCH_KIND = 'redispatch';
const STUCK_KIND = 'stuck';
// A pull request's branch name as it goes into the dispatch's argv: no '..', no leading or trailing '/', nothing else.
const BRANCH_REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
const STAGING_BRANCH = 'clued-train/staging';
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const ACTIONS_APP_ID = 15368;
export const ADMISSION_APP_ID = 5368905;
export const ADMISSION_CHECK = 'kooyumi-work-admission';
export const GATE_JOB_NAME = 'admission-gate';
// The same patterns as scripts/ci/clued-work-admission.mjs (#993): the not-admitted verdicts of the gate, the transient API ERROR.
const NOT_ADMITTED_VERDICT = /^(?:ADMISSION_PENDING|RERUN_REFUSED):/;
const TRANSIENT_API_ERROR = /^GitHub API \S+ (?:returned 5[0-9]{2}|could not be reached after [0-9]+ attempts)/;
const ERROR_ANNOTATION_TITLE = 'kooyumi-work-admission';
const NATIVE_ADMISSION_ID = /^independent-ci:native-work-admission:(?:[a-f0-9]{64}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9}:a[1-9][0-9]{0,9}|v2:[a-f0-9]{64}:a[12]:c[a-f0-9]{8}:f[1-9][0-9]{0,9}:e[1-9][0-9]{0,9})$/;
// The lane's pace: one step a minute; a head is looked at again at most every HEAD_RECHECK_MS, and only for HEAD_WATCH_MS after this
// lane first saw it (the gate's admission is for a fresh head). Records are kept RECORD_KEEP_MS.
export const RERUN_LANE_EVERY_MS = 60_000;
export const HEAD_RECHECK_MS = 2 * 60_000;
export const HEAD_WATCH_MS = 12 * 60 * 60_000;
export const RECORD_KEEP_MS = 14 * 86_400_000;
export const READ_TIMEOUT_MS = 30_000;
export const POST_TIMEOUT_MS = 30_000;
export const HEADS_PER_STEP = 5;
export const HEAD_CANDIDATE_MARK_MS = 60 * 60_000;
const REQUEST_RETRY_MS = 10 * 60_000;
const RECENT_OTHER_HEADS = 3;
const MAX_RECOVERY_PAGES = 50;
// 5: jobs no runner took ran nothing (9aba97c1), and the budget is per head and workflow; verdicts of 4 are judged again.
const REPAIR_RULE_VERSION = 5;
const MAX_PAGES = 10;
const MAX_TEXT = 3_500_000;
// Runner refusals before any child ran (runner.mjs): nothing reached GitHub.
const UNSENT_REFUSALS = Object.freeze(['RUNNER_ARGV_REFUSED', 'RUNNER_BUSY_WITH_UNFINISHED_CHILD', 'RUNNER_SPAWN_FAILED', 'RUNNER_TIMEOUT_REFUSED']);
export const RERUN_OUTCOMES = Object.freeze(['intent', 'sent', 'unsent', 'refused', 'unknown']);
const plainObject = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const positive = v => Number.isSafeInteger(v) && v > 0;
const stringList = v => Array.isArray(v) && v.every(item => typeof item === 'string');
const requestKey = (runId, attempt) => `${runId}:${attempt}`;
const headRecordKey = (headSha, workflowId) => workflowId ? `${headSha}:${workflowId}` : headSha;
// The memory file's exact shape; anything else is unreadable (a forgotten record could click twice).
function validState(v) {
  if (!plainObject(v) || Object.keys(v).sort().join('|') !== 'contract|heads|records' || v.contract !== RERUN_STATE_CONTRACT || !plainObject(v.heads) || !plainObject(v.records)) return false;
  for (const [k, h] of Object.entries(v.heads)) {
    if (!HEX40.test(k) || !plainObject(h) || !Number.isFinite(Date.parse(h.firstSeen))) return false;
    const notice = h.systemicNotice;
    if (notice !== undefined && (!plainObject(notice) || typeof notice.target !== 'string'
      || !Array.isArray(notice.jobs) || notice.jobs.some(name => typeof name !== 'string'))) return false;
    if (h.systemicNotices !== undefined && (!plainObject(h.systemicNotices) || !Object.values(h.systemicNotices).every(stringList))) return false;
    if (h.exhausted !== undefined && !stringList(h.exhausted)) return false;
    if (h.missing !== undefined && !stringList(h.missing)) return false;
    if (h.workflowIds !== undefined && (!Array.isArray(h.workflowIds) || !h.workflowIds.every(positive))) return false;
    const issue = h.scopeIssue;
    if (issue !== undefined && (!plainObject(issue) || !HEX40.test(issue.prHead ?? '')
      || typeof issue.message !== 'string' || typeof issue.told !== 'boolean')) return false;
    const inventory = h.workflowInventory;
    if (inventory !== undefined && (!plainObject(inventory) || !HEX40.test(inventory.base ?? '') || !Array.isArray(inventory.entries)
      || inventory.entries.some(entry => !plainObject(entry) || !positive(entry.id) || !WORKFLOW_PATH.test(entry.path ?? '')
        || (entry.blob !== undefined && ((entry.blob !== null && !HEX40.test(entry.blob)) || !stringList(entry.checks)))))) return false;
  }
  const keys = new Set();
  for (const [k, r] of Object.entries(v.records)) {
    if (!plainObject(r) || !HEX40.test(r.headSha ?? '') || !RERUN_OUTCOMES.includes(r.outcome) || !Number.isFinite(Date.parse(r.at))
      || ![undefined, REDISPATCH_KIND, STUCK_KIND].includes(r.kind)) return false;
    if (!r.kind && (!positive(r.runId) || !positive(r.attempt) || r.attempt < 2 || ![undefined, 1, 2].includes(r.requests))) return false;
    if (r.frontHeadSha !== undefined && (r.kind || !HEX40.test(r.frontHeadSha ?? '') || r.frontHeadSha === r.headSha)) return false;
    if (r.failures !== undefined && (!Array.isArray(r.failures) || r.failures.some(f =>
      !plainObject(f) || typeof f.name !== 'string' || !['setup', 'network', 'timeout', 'unassigned'].includes(f.kind)))) return false;
    if (r.workflowId !== undefined && (r.kind !== REDISPATCH_KIND || !positive(r.workflowId))) return false;
    if (r.checks !== undefined && !stringList(r.checks)) return false;
    if (r.http !== undefined && (!Number.isInteger(r.http) || r.http < 400 || r.http > 499)) return false;
    const key = r.kind ? headRecordKey(r.headSha, r.workflowId) : requestKey(r.runId, r.attempt);
    // A v1 receipt written by the old companion is still authoritative for its one run/attempt.
    if ((k !== key && (r.kind || k !== r.headSha)) || keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}
const short = t => String(t).replace(/[\r\n]+/g, ' ').slice(0, 200);
class Unreadable extends Error {}
const unreadable = what => { throw new Unreadable(what); };

// The gh port: fixed argv, routes built here from validated values only. get -> parsed JSON or throws Unreadable.
export function ghPort({ ghExe, repo, run }) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') && typeof run === 'function', 'ADMISSION_RERUN_CONFIG_INVALID');
  const routeOk = route => typeof route === 'string' && /^[A-Za-z0-9_./?&=%:-]*$/.test(route) && !route.split(/[/?]/).slice(1).some(p => p === '.' || p === '..');
  async function get(route, { missingOk = false } = {}) {
    check(routeOk(route), 'ADMISSION_RERUN_ROUTE_REFUSED');
    let r;
    try { r = await run([ghExe, 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repo}${route}`], { timeoutMs: READ_TIMEOUT_MS }); }
    catch { return unreadable(`GET ${route} could not start`); }
    if (r?.code !== 0) {
      if (missingOk && !r?.timedOut && !r?.refused && /\(HTTP 404\)/.test(String(r?.stderr ?? ''))) return null;
      unreadable(`GET ${route} failed`);
    }
    try { return JSON.parse(r.stdout); } catch { return unreadable(`GET ${route} answered no JSON`); }
  }
  // A job log: plain text (gh follows GitHub's redirect). The runner keeps at most MAX_TEXT characters of stdout; a log that long may have lost
  // its verdict, so it is answered as empty, which never proves an environment failure.
  // #1192 (Fable 11-20): gh 2.97 refuses to print a response holding terminal escape sequences (exit 1) unless --allow-escape-sequences is
  // given, and every Actions log of a `run:` step holds them; without it every log read failed and the lane never re-ran. The text goes to a
  // string here, never to a terminal.
  async function text(route) {
    check(routeOk(route), 'ADMISSION_RERUN_ROUTE_REFUSED');
    let r;
    try { r = await run([ghExe, 'api', '--method', 'GET', '--allow-escape-sequences', '-H', 'Accept: application/vnd.github+json', `repos/${repo}${route}`], { timeoutMs: READ_TIMEOUT_MS }); }
    catch { return unreadable(`GET ${route} could not start`); }
    if (r?.code !== 0 || typeof r.stdout !== 'string') unreadable(`GET ${route} failed`);
    return r.stdout.length >= MAX_TEXT ? '' : r.stdout;
  }
  async function post(tail) {
    let r;
    try { r = await run([ghExe, 'api', '--method', 'POST', '-H', 'Accept: application/vnd.github+json', ...tail], { timeoutMs: POST_TIMEOUT_MS }); }
    catch { return { outcome: 'unsent', why: 'gh 没有启动' }; }
    if (r?.code === 0) return { outcome: 'sent' };
    if (UNSENT_REFUSALS.includes(r?.refused)) return { outcome: 'unsent', why: `gh 没有启动（${r.refused}）` };
    if (r?.timedOut || r?.refused) return { outcome: 'unknown', why: r?.timedOut ? 'gh 超时' : `gh 的结束状态无法确认（${short(r.refused)}）` };
    const http = /\(HTTP (4\d\d)\)/.exec(String(r?.stderr ?? ''));
    return http ? { outcome: 'refused', http: Number(http[1]), why: `GitHub 拒绝（HTTP ${http[1]}）` } : { outcome: 'unknown', why: `gh 退出码 ${short(r?.code ?? '无')}，没有 HTTP 答复` };
  }
  return Object.freeze({
    repo, get, text,
    // Every page of a list route (key: the array's field, or null for a bare array).
    async paged(route, key = null) {
      const out = [];
      let total = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const reply = await get(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        const items = key === null ? reply : reply?.[key];
        if (!Array.isArray(items) || items.length > 100) unreadable(`${route} is not a list`);
        if (key !== null) {
          if (!Number.isSafeInteger(reply.total_count) || reply.total_count < 0 || (total !== null && total !== reply.total_count))
            unreadable(`${route} has an incomplete or changed count`);
          total = reply.total_count;
        }
        out.push(...items);
        if (items.length < 100) {
          if (total !== null && out.length !== total) unreadable(`${route} is truncated`);
          return out;
        }
      }
      return unreadable(`${route} has more than ${MAX_PAGES} pages`);
    },
    // The one write. -> { outcome: 'sent' } | { outcome: 'unsent' | 'refused' | 'unknown', why }; never thrown, never repeated here.
    //   unsent: gh never ran (the Runner refused or could not start it): nothing reached GitHub;
    //   refused: gh ran and GitHub answered an HTTP 4xx: the run was not started;
    //   unknown: gh timed out, its job host could not confirm how it ended, or it failed without an HTTP answer (the line): GitHub may
    //   or may not have started the run.
    async rerun(runId) {
      check(positive(runId), 'ADMISSION_RERUN_ROUTE_REFUSED');
      return post([`repos/${repo}/actions/runs/${runId}/rerun`]);
    },
    // The lost-run write: "Run workflow" of the required tests on a pull request's branch. Same outcomes as rerun.
    async dispatch(workflowId, ref, pr, headSha) {
      check(positive(workflowId) && BRANCH_REF.test(ref ?? '') && positive(pr) && HEX40.test(headSha ?? ''), 'ADMISSION_RERUN_ROUTE_REFUSED');
      return post(['-f', `ref=${ref}`, '-f', `inputs[pr]=${pr}`, '-f', `inputs[head]=${headSha}`,
        `repos/${repo}/actions/workflows/${workflowId}/dispatches`]);
    },
  });
}

// App 5368905's newest kooyumi-work-admission check of the head, bound to the pull request (clued-work-admission.mjs#independentAdmissionCheck).
async function admissionOf(gh, headSha, prNumber) {
  const checks = await gh.paged(`/commits/${headSha}/check-runs?check_name=${ADMISSION_CHECK}&filter=all`, 'check_runs');
  const newest = checks.filter(c => c && c.name === ADMISSION_CHECK && c.head_sha === headSha && Number(c.app?.id) === ADMISSION_APP_ID)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
  if (!newest || newest.status !== 'completed') return { admitted: false };
  const named = [...String(newest.output?.summary ?? '').matchAll(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]{1,10})(?![0-9])/g)]
    .filter(m => m[1].toLowerCase() === gh.repo.toLowerCase()).map(m => Number(m[2]));
  const bound = NATIVE_ADMISSION_ID.test(String(newest.external_id ?? '')) && named.length > 0 && named.every(n => n === Number(prNumber));
  return { admitted: bound && newest.conclusion === 'success' };
}

async function classifyJob(gh, job) {
  const failed = failedSteps(job);
  if (job.conclusion === 'cancelled' && positive(job.id) && failed?.length === 0
    && job.steps.length && job.steps.every(step => typeof step?.conclusion === 'string')) {
    const notes = await gh.paged(`/check-runs/${job.id}/annotations`);
    const log = notes.length ? await gh.text(`/actions/jobs/${job.id}/logs`) : null;
    return jobFailureKind(job, log, notes);
  }
  const log = job.conclusion === 'failure' && !diedInSetup(job) && failed?.length > 0 && positive(job.id)
    ? await gh.text(`/actions/jobs/${job.id}/logs`) : null;
  return jobFailureKind(job, log);
}

// Inspect runs newest first, counting at most one completed sample per other head for each timed-out job.
// Skipped attempts and duplicate heads do not displace a sample. No run status alone proves recovery.
async function otherJobEvidence(gh, workflowId, headSha, failures, recoveryAfter) {
  const samples = new Map(failures.filter(f => f.kind === 'timeout').map(f => [f.name, new Map()]));
  const needsRecovery = new Set(recoveryAfter === null ? [] : failures.map(f => f.name));
  const stillSampling = () => [...samples.values()].some(rows => rows.size < RECENT_OTHER_HEADS);
  if (!stillSampling() && !needsRecovery.size) return { systemic: [], recovered: true };
  const seen = new Set();
  let total = null;
  const pageLimit = needsRecovery.size ? MAX_RECOVERY_PAGES : MAX_PAGES;
  for (let page = 1; page <= pageLimit && (stillSampling() || needsRecovery.size); page++) {
    const body = await gh.get(`/actions/workflows/${workflowId}/runs?per_page=100&page=${page}`);
    const runs = body?.workflow_runs;
    if (!Array.isArray(runs) || !Number.isSafeInteger(body.total_count) || body.total_count < 0
      || (total !== null && total !== body.total_count)
      || runs.length !== Math.min(100, Math.max(0, body.total_count - (page - 1) * 100)))
      unreadable('recent required-tests runs are incomplete');
    total = body.total_count;
    for (const run of runs) {
      if (!stillSampling() && !needsRecovery.size) break;
      if (!positive(run?.id) || seen.has(run.id) || !HEX40.test(run.head_sha ?? '') || typeof run.status !== 'string'
        || !positive(run.run_attempt) || run.run_attempt > 100) unreadable('a recent required-tests run is invalid or changed');
      seen.add(run.id);
      if (run.head_sha === headSha) continue;
      const possiblyRecovered = run.status !== 'completed' || !(Date.parse(run.updated_at) <= recoveryAfter);
      const wanted = new Set([...(possiblyRecovered ? needsRecovery : []), ...[...samples].filter(([, rows]) =>
        rows.size < RECENT_OTHER_HEADS && !rows.has(run.head_sha)).map(([name]) => name)]);
      for (let n = run.run_attempt; n > 0 && wanted.size; n--) {
        const jobs = await gh.paged(`/actions/runs/${run.id}/attempts/${n}/jobs`, 'jobs');
        if (jobs.some(j => !j || j.head_sha !== run.head_sha || (j.run_attempt != null && Number(j.run_attempt) !== n)))
          unreadable(`recent run ${run.id} attempt ${n} has incomplete jobs`);
        for (const name of wanted) {
          const matched = jobs.filter(j => j.name === name && j.status === 'completed' && typeof j.conclusion === 'string' && j.conclusion !== 'skipped');
          if (matched.length > 1) unreadable(`recent run ${run.id} attempt ${n} repeats job ${name}`);
          const job = matched[0];
          if (!job) continue;
          const doneAt = Date.parse(job.completed_at);
          if (job.conclusion === 'success' && doneAt > recoveryAfter) needsRecovery.delete(name);
          const rows = samples.get(name);
          if (rows && rows.size < RECENT_OTHER_HEADS && !rows.has(run.head_sha)) {
            const timeout = job.conclusion === 'cancelled' && (await classifyJob(gh, job)).kind === 'timeout';
            rows.set(run.head_sha, { timeout, success: job.conclusion === 'success', doneAt });
          }
          // Earlier attempts can still prove recovery if a later attempt of that run failed.
          if (!needsRecovery.has(name)) wanted.delete(name);
        }
      }
    }
    if (page * 100 >= total) break;
  }
  const systemic = [];
  for (const failure of failures) {
    if (!samples.has(failure.name)) continue;
    const rows = [...samples.get(failure.name).values()];
    const timeouts = rows.filter(row => row.timeout);
    const latestTimeout = Math.max(Date.parse(failure.completedAt), ...timeouts.map(row => row.doneAt));
    if (timeouts.length >= 2 && !rows.some(row => row.success && row.doneAt > latestTimeout)) systemic.push(failure.name);
  }
  return { systemic, recovered: !needsRecovery.size };
}

// The one rule reads GitHub with the gate's routes; over the gh port its lists are read whole (paged) and served page by page.
function historyPort(gh) {
  const prefix = `/repos/${gh.repo}`;
  const local = route => route.startsWith(`${prefix}/`) ? route.slice(prefix.length) : unreadable('a repair route outside the repository');
  const notes = new Map();
  async function read(route) {
    const r = local(route);
    let m;
    if ((m = /^(\/actions\/runs\/\d+\/attempts\/\d+\/jobs)\?per_page=100$/.exec(r))) {
      const jobs = await gh.paged(m[1], 'jobs');
      return { total_count: jobs.length, jobs };
    }
    if ((m = /^(\/check-runs\/\d+\/annotations)\?per_page=100&page=([1-9][0-9]?)$/.exec(r))) {
      if (!notes.has(m[1])) notes.set(m[1], await gh.paged(m[1]));
      return notes.get(m[1]).slice((Number(m[2]) - 1) * 100, Number(m[2]) * 100);
    }
    if ((m = /^(\/actions\/runs\?head_sha=[0-9a-f]{40})&per_page=100&page=1$/.exec(r))) {
      const runs = await gh.paged(m[1], 'workflow_runs');
      return { total_count: runs.length, workflow_runs: runs };
    }
    return gh.get(r);
  }
  return { read, readLog: route => gh.text(local(route)) };
}

// The gate's repair rule is the one rule (env-failure.mjs#requiredTestsRepairHistory, Fable 11-20 单一判定), called over the gh port: the
// classification, three attempts per head and workflow for both kinds of process cause, the recovery evidence of a second repair. On top,
// only the lane's own pacing: a timeout that other heads show too is systemic, so the lane waits instead of clicking.
async function repairAllowed(gh, workflowId, runId, headSha, attempt, attempts) {
  const history = await requiredTestsRepairHistory({ repository: gh.repo, runId, head: headSha, attempt, workflowId, ...historyPort(gh) });
  if (!history.allowed) {
    if (history.unreadable) unreadable(history.reason);
    return { allowed: false, waiting: history.waiting === true, exhausted: history.exhausted, reason: history.reason };
  }
  const last = [...history.attempts].reverse().find(a => a.environment_failure_kinds);
  const doneAt = last ? Math.max(...(attempts[last.attempt - 1] ?? []).map(j => Date.parse(j.completed_at)).filter(Number.isFinite)) : NaN;
  const failures = last ? Object.entries(last.environment_failure_kinds).map(([name, kind]) => ({ name, kind, completedAt: new Date(Number.isFinite(doneAt) ? doneAt : 0).toISOString() })) : [];
  const { systemic } = await otherJobEvidence(gh, workflowId, headSha, failures, null);
  if (systemic.length) return { allowed: false, waiting: true, systemic, reason: `${systemic.join(', ')} has systemic timeouts` };
  return { allowed: true, environment: failures.length ? failures.map(f => f.name.slice(0, 80)) : null,
    failures: failures.map(f => ({ name: f.name.slice(0, 80), kind: f.kind })) };
}

// A head's full inventory is also used to fence dispatch across all events.
async function runsOf(gh, sha) {
  const runs = await gh.paged('/actions/runs?head_sha=' + sha, 'workflow_runs');
  if (new Set(runs.map(r => r?.id)).size !== runs.length || runs.some(r => r?.head_sha !== sha
    || !positive(r.id) || !positive(r.workflow_id) || !positive(r.run_attempt) || r.run_attempt > 100
    || typeof r.event !== 'string' || typeof r.status !== 'string')) unreadable('the head run inventory is incomplete');
  return runs;
}

async function jobsOf(gh, run, attempt) {
  const jobs = await gh.paged('/actions/runs/' + run.id + '/attempts/' + attempt + '/jobs', 'jobs');
  if (jobs.some(j => !j || j.head_sha !== run.head_sha || typeof j.name !== 'string'
    || (j.run_attempt != null && Number(j.run_attempt) !== attempt))) unreadable('run ' + run.id + ' has an invalid job inventory');
  return jobs;
}

const hasGate = jobs => jobs.filter(j => j.name === GATE_JOB_NAME).length === 1 && jobs.length > 1;
const boundPr = (p, number, head, branch, repo) => p?.number === number && p.state === 'open' && p.head?.sha === head
  && p.base?.ref === branch && p.head?.repo?.full_name === repo && p.base?.repo?.full_name === repo;
const sameRun = (a, b) => a?.id === b.id && a.workflow_id === b.workflow_id && a.head_sha === b.head_sha
  && a.event === b.event && a.status === b.status && a.run_attempt === b.run_attempt && a.path === b.path;

async function missingActionsChecks(gh, sha, required) {
  if (!required.size) return [];
  const runs = await gh.paged('/commits/' + sha + '/check-runs?filter=all', 'check_runs');
  const present = new Set(runs.filter(c => c?.head_sha === sha && c.app?.id === ACTIONS_APP_ID).map(c => c.name));
  return [...required].filter(context => !present.has(context));
}

// Read the check names from the workflow source. The naming convention is in DESIGN §56.5.
export function gatedCheckNames(yaml) {
  const start = /^jobs:[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(yaml);
  if (!start) return [];
  const block = yaml.slice(start.index + start[0].length + 1).split(/^[^\s#]/m, 1)[0];
  const jobs = [...block.matchAll(/^  ([A-Za-z0-9_-]+):[ \t]*(?:#.*)?\r?$/gm)];
  if (jobs.filter(job => job[1] === GATE_JOB_NAME).length !== 1) return [];
  return jobs.flatMap((job, i) => {
    const body = block.slice(job.index + job[0].length, jobs[i + 1]?.index);
    if (!/^    needs: admission-gate[ \t]*\r?$/m.test(body)) return [];
    const name = /^    name:[ \t]*([^\r\n]*)(?:\r?\n((?: {6}[^\r\n]*\r?\n?)*))?/m.exec(body);
    if (!name) return [job[1]];
    const value = (name[1].trim() === '>-' ? (name[2] ?? '').replace(/\s+/g, ' ') : name[1]).trim();
    const literal = /^([\w. /()-]+)$/.exec(value)?.[1] ?? /^(['"])([\w. /()-]+)\1$/.exec(value)?.[2];
    const admitted = /&&\s*'([\w. /()-]+)'\s*\|\|\s*'\1-skipped'\s*\}\}$/.exec(value)?.[1];
    return literal || admitted ? [literal ?? admitted] : [];
  });
}

async function workflowFile(gh, file, sha, missingOk = false) {
  const source = await gh.get('/contents/' + file + '?ref=' + sha, { missingOk });
  if (source === null && missingOk) return null;
  if (source?.path !== file || source.encoding !== 'base64' || typeof source.content !== 'string'
    || !HEX40.test(source.sha ?? '')) unreadable('the workflow source is unreadable');
  return source;
}

async function workflowChecks(gh, file, base, memo, inventory) {
  const entry = inventory?.base === base && inventory.entries.find(w => w.path === file);
  if (entry && entry.blob !== undefined) return { blob: entry.blob, checks: entry.checks };
  let files = memo.byBase.get(base);
  if (!files) {
    if (memo.byBase.size === 4) memo.byBase.delete(memo.byBase.keys().next().value);
    memo.byBase.set(base, files = new Map());
  }
  if (files.has(file)) return files.get(file);
  const source = await workflowFile(gh, file, base, true);
  const blob = source?.sha ?? null;
  if (blob && !memo.byBlob.has(blob)) memo.byBlob.set(blob, gatedCheckNames(Buffer.from(source.content, 'base64').toString('utf8')));
  const result = { blob, checks: memo.byBlob.get(blob) ?? [] };
  files.set(file, result);
  return result;
}

async function activeWorkflows(gh) {
  const listed = await gh.paged('/actions/workflows', 'workflows');
  if (new Set(listed.map(w => w?.id)).size !== listed.length || listed.some(w => !positive(w?.id) || typeof w.state !== 'string'))
    unreadable('the workflow inventory is incomplete');
  return listed.filter(w => w.state === 'active' && WORKFLOW_PATH.test(w.path ?? ''));
}

async function dispatchDecision({ gh, pull, defaultBranch, target, runs, missing, skipped }) {
  const { number: pr, head: { sha: headSha }, base: { sha: base } } = pull;
  const out = { pr, workflowId: target.id, checks: target.checks.filter(c => missing.includes(c)), skipped };
  const now = await gh.get('/pulls/' + pr);
  if (!boundPr(now, pr, headSha, defaultBranch, gh.repo) || now.base.sha !== base || !BRANCH_REF.test(now.head.ref ?? ''))
    return { ...out, action: 'skip', reason: 'the pull request or base moved' };
  // GitHub dispatches the workflow at ref. Use the trusted definition only on
  // a head that has that same file, and recheck the inventory before asking.
  if ((await workflowFile(gh, target.path, headSha)).sha !== target.blob)
    return { ...out, action: 'skip', reason: 'the workflow differs from its default-branch definition' };
  const again = (await runsOf(gh, headSha)).filter(r => r.workflow_id === target.id);
  if (again.length !== runs.length || again.some(r => !runs.some(old => sameRun(r, old))))
    return { ...out, action: 'skip', reason: 'the workflow runs changed since they were read' };
  if (!(await admissionOf(gh, headSha, pr)).admitted)
    return { ...out, action: 'skip', reason: 'the pull request is no longer admitted' };
  return { ...out, ref: now.head.ref, action: 'redispatch',
    reason: skipped ? 'required tests were skipped for a non-Owner actor' : 'GitHub created no required workflow run of this head' };
}

// Keep the old newest-run and historical repair checks within one workflow.
async function decideWorkflow({ gh, runs, newest, recentJobs, select, pull, headSha, base, defaultBranch, testSha, canRequest, checks }) {
  const { id: runId, workflow_id: workflowId, run_attempt: attempt } = newest;
  const out = { pr: pull, runId, workflowId, attempt, checks };
  const say = (action, reason) => ({ ...out, action, reason: short(reason) });
  const sha = testSha ?? headSha;
  if (runs.some(r => r.status !== 'completed')) return say('skip', 'an attempt is queued or running');
  if (testSha && runs.filter(select).length !== 1) return say('skip', 'no single settled push run for staging');
  if (testSha && newest.conclusion === 'success') return say('final', 'the staging run already passed');

  const attempts = [];
  let allSkipped = true, latestGate;
  for (const run of runs) {
    for (let n = 1; n <= run.run_attempt; n++) {
      const jobs = run.id === runId && n === attempt ? recentJobs : await jobsOf(gh, run, n);
      if (!hasGate(jobs) || jobs.some(j => j.status !== 'completed'))
        unreadable('run ' + run.id + ' attempt ' + n + ' has an incomplete or unfinished job inventory');
      const didWork = jobs.some(j => j.name !== GATE_JOB_NAME && j.conclusion !== 'skipped' && !neverAssigned(j));
      if (run.id !== runId && didWork) return say('final', 'another run of the workflow already ran its heavy jobs');
      if (run.id === runId) attempts.push(jobs);
      if (didWork) allSkipped = false;
      if (run.id === runId && n === attempt) latestGate = jobs.find(j => j.name === GATE_JOB_NAME);
    }
  }
  if (!testSha) {
    out.neverRan = allSkipped;
    if (allSkipped && runs.some(r => r.event !== 'pull_request')) return say('final', 'a previous dispatch or non-PR run already exists');
    if (allSkipped) {
      // Only a gate that ran can have skipped the heavy jobs for the actor (and has a verdict in its log); a gate no runner took ran nothing.
      const gateRan = latestGate?.status === 'completed' && latestGate.conclusion === 'success';
      let skippedByActor = gateRan && newest.actor?.type === 'Bot';
      if (!skippedByActor && gateRan && positive(latestGate?.id)) {
        const log = await gh.text('/actions/jobs/' + latestGate.id + '/logs');
        skippedByActor = /"verdict"\s*:\s*"ADMITTED"/.test(log) && /"automation_self_hosted"\s*:\s*false/.test(log);
      }
      if (skippedByActor) return say('bot-dispatch', 'required tests were skipped for a non-Owner actor');
    }
  }

  const next = attempt + 1;
  if (!canRequest(runId, next)) return say('skip', 'this run and attempt already has a receipt');
  const repair = await repairAllowed(gh, workflowId, runId, sha, next, attempts);
  if (!repair.allowed) {
    Object.assign(out, { systemic: repair.systemic, exhausted: repair.exhausted });
    return say(repair.waiting ? 'skip' : 'final', repair.reason);
  }
  const current = await gh.get('/pulls/' + pull);
  if (!boundPr(current, pull, headSha, defaultBranch, gh.repo) || current.base.sha !== base)
    return say('skip', 'the pull request or base moved');
  if (testSha) {
    const ref = await gh.get('/git/ref/heads/' + STAGING_BRANCH);
    if (ref?.ref !== 'refs/heads/' + STAGING_BRANCH || ref.object?.sha !== testSha) return say('skip', 'the staging ref moved');
  }
  const again = await gh.get('/actions/runs/' + runId);
  if (!sameRun(again, newest) || (testSha && (again.head_branch !== STAGING_BRANCH || again.conclusion !== newest.conclusion)))
    return say('skip', 'the run changed since it was read');
  // The admission is read again right before the request (independent review): one withdrawn since the first read stops it.
  if (!testSha && !(await admissionOf(gh, headSha, pull)).admitted) return say('skip', 'the pull request is no longer admitted');
  Object.assign(out, { environment: repair.environment, failures: repair.failures });
  return say('rerun', '"Re-run all jobs" of run ' + runId + ' (attempt ' + next + ') for #' + pull);
}

const newWorkflowMemo = () => ({ byBase: new Map(), byBlob: new Map() });

// Resolve the whole scope before any POST. Each scoped decision still runs its
// fresh checks immediately before the lane persists and sends it.
async function* decisions({ gh, headSha, pr: frontPr, testSha, defaultBranch = 'main', headAgeMs = null,
  canRequest = () => true, canDispatch = () => true, workflowMemo = newWorkflowMemo(), workflowInventory, rulesRead = () => {} }) {
  const staging = testSha !== undefined;
  const say = (action, reason) => ({ action, reason, pr: frontPr, runId: null, attempt: null });
  const readError = e => say('error', 'nothing re-run: ' + (e instanceof Error ? short(e.message) : 'a read failed'));
  const mappingError = e => ({ ...readError(e), scopeIssue: '无法核对必需检查对应工作流，自动补跑已暂停' });
  try {
    if (!HEX40.test(headSha ?? '') || (staging && (!HEX40.test(testSha ?? '') || testSha === headSha || !positive(frontPr)))) {
      yield say('skip', 'invalid head or staging subject');
      return;
    }
    let pull;
    if (staging) {
      pull = await gh.get('/pulls/' + frontPr);
      if (!boundPr(pull, frontPr, headSha, defaultBranch, gh.repo)) {
        yield say('skip', 'the staging pull request is no longer open on this head');
        return;
      }
    } else {
      const listed = await gh.paged('/commits/' + headSha + '/pulls');
      const open = listed.filter(p => positive(p?.number) && boundPr(p, p.number, headSha, defaultBranch, gh.repo));
      if (open.length !== 1) {
        yield say('skip', 'no unique open pull request into the default branch has this head');
        return;
      }
      [pull] = open;
      if (!(await admissionOf(gh, headSha, pull.number)).admitted) {
        yield say('skip', 'the ' + ADMISSION_CHECK + ' check does not admit this head yet');
        return;
      }
    }

    const sha = testSha ?? headSha;
    const base = pull.base.sha;
    if (!HEX40.test(base ?? '')) unreadable('the pull request base is unreadable');
    let rules;
    try { rules = await readMainRequiredChecks(gh.paged); } catch (e) {
      // A failed read (the network) is told apart from an answer of the wrong shape: only the first may be a flap (the step holds its words back).
      yield { ...readError(e), scopeIssue: '无法读取 main 必需检查规则，自动补跑已暂停', rulesUnreadable: !(e instanceof RulesShapeError) };
      return;
    }
    rulesRead();
    const required = new Set(rules.filter(c => c.integrationId === ACTIONS_APP_ID).map(c => c.context));
    const missing = staging ? [] : await missingActionsChecks(gh, sha, required);
    const runs = await runsOf(gh, sha);
    const byWorkflow = Map.groupBy(runs, r => r.workflow_id);
    const select = staging ? r => r.event === 'push' && r.head_branch === STAGING_BRANCH
      : r => r.event === 'pull_request' && Array.isArray(r.pull_requests) && r.pull_requests.some(p => p?.number === pull.number);
    const scoped = [];
    const unmapped = new Set(missing);
    let waiting = false;
    for (const group of byWorkflow.values()) {
      const newest = group.filter(select).sort((a, b) => b.id - a.id)[0];
      if (!newest || !required.size) continue;
      let recentJobs;
      try { recentJobs = await jobsOf(gh, newest, newest.run_attempt); } catch (e) {
        waiting = true;
        yield readError(e);
        continue;
      }
      if (!recentJobs.length && newest.status !== 'completed') {
        waiting = true;
        continue;
      }
      if (!hasGate(recentJobs)) continue;
      const file = typeof newest.path === 'string' ? newest.path.split('@', 1)[0] : '';
      let source;
      try {
        if (!WORKFLOW_PATH.test(file)) unreadable('the gated workflow run has no valid source path');
        source = await workflowChecks(gh, file, base, workflowMemo, workflowInventory);
      } catch (e) {
        yield mappingError(e);
        return;
      }
      const checks = source.checks.filter(c => required.has(c));
      if (!checks.length) continue;
      for (const context of checks) unmapped.delete(context);
      scoped.push({ group, newest, recentJobs, target: { id: newest.workflow_id, path: file, blob: source.blob, checks } });
    }

    const absent = [];
    if (unmapped.size) {
      if (workflowInventory?.base !== base) {
        let workflows;
        try { workflows = workflowInventory?.entries ?? await activeWorkflows(gh); } catch (e) {
          yield mappingError(e);
          return;
        }
        workflowInventory = { base, entries: workflows.map(({ id, path }) => ({ id, path })) };
        yield { action: 'inventory', workflowInventory };
      }
      if (workflowInventory.entries.some(entry => entry.blob === undefined)) {
        const entries = [];
        try {
          for (const { id, path } of workflowInventory.entries) {
            const source = await workflowChecks(gh, path, base, workflowMemo, workflowInventory);
            entries.push({ id, path, ...source });
          }
        } catch (e) {
          yield mappingError(e);
          return;
        }
        workflowInventory = { base, entries };
        yield { action: 'inventory', workflowInventory };
      }
      const uncovered = new Set(unmapped);
      for (const target of workflowInventory.entries) {
        if (!target.checks.some(c => uncovered.has(c))) continue;
        for (const context of target.checks) unmapped.delete(context);
        if (!byWorkflow.has(target.id) && canDispatch(target.id)) absent.push(target);
      }
      if (unmapped.size) {
        const scopeIssue = `必需检查 ${[...unmapped].join('、')} 找不到对应工作流`;
        yield { ...say('error', scopeIssue), scopeIssue };
        return;
      }
    }

    yield { action: 'scope-ready', missing, workflowIds: [...byWorkflow.keys()] };
    for (const { group, newest, recentJobs, target } of scoped) {
      let d;
      try {
        d = await decideWorkflow({ gh, runs: group, newest, recentJobs, select, pull: pull.number, headSha, base,
          defaultBranch, testSha, canRequest, checks: target.checks });
      } catch (e) {
        waiting = true;
        yield readError(e);
        continue;
      }
      if (d.action === 'bot-dispatch') {
        if (canDispatch(target.id) && target.checks.some(c => missing.includes(c)))
          yield await dispatchDecision({ gh, pull, defaultBranch, target, runs: group, missing, skipped: true });
        continue;
      }
      if (d.action !== 'final') waiting = true;
      yield d;
    }
    if (headAgeMs >= LOST_RUN_AFTER_MS) {
      for (const target of absent)
        yield await dispatchDecision({ gh, pull, defaultBranch, target, runs: [], missing, skipped: false });
    }
    const settled = !waiting && (staging ? scoped.length > 0 || !required.size : !missing.length);
    yield say(settled ? 'settled' : 'skip', staging ? 'staging workflows ' + (settled ? 'are settled' : 'are not settled')
      : 'main Actions checks ' + (missing.length ? 'are missing' : 'all appeared'));
  } catch (e) {
    yield readError(e);
  }
}

export async function decide(options) {
  for await (const value of decisions(options)) {
    if (['inventory', 'scope-ready'].includes(value.action)) continue;
    return value.action === 'settled' ? { ...value, action: 'final' } : value;
  }
}

// The lane's own memory: head watch windows, per-attempt rerun receipts and per-head dispatch receipts.
export class AdmissionRerunState {
  constructor(file, clock) { this.file = file; this.clock = clock; this.data = { contract: RERUN_STATE_CONTRACT, heads: {}, records: {} }; }
  // No file is a fresh memory. A file that exists but cannot be read, is not JSON, or does not have exactly the state's shape is not
  // (unreadable): forgetting a record could re-run a head twice. unreadableCode says why (ENOENT never).
  static async open(file, clock = Date.now) {
    const s = new AdmissionRerunState(file, clock);
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (e) {
      if (e?.code !== 'ENOENT') { s.unreadable = true; s.unreadableCode = typeof e?.code === 'string' ? e.code : 'READ_FAILED'; }
      return s;
    }
    let v;
    try { v = JSON.parse(text); } catch { v = null; }
    if (!validState(v)) { s.unreadable = true; s.unreadableCode = 'STATE_SHAPE_REFUSED'; return s; }
    s.data = { contract: RERUN_STATE_CONTRACT, heads: v.heads, records: Object.fromEntries(Object.values(v.records)
      .map(r => [r.kind ? headRecordKey(r.headSha, r.workflowId) : requestKey(r.runId, r.attempt), r])) };
    return s;
  }
  headRecord(headSha) { return this.data.records[headSha] ?? null; }
  request(runId, attempt) { return this.data.records[requestKey(runId, attempt)] ?? null; }
  record(headSha) {
    let newest = this.headRecord(headSha);
    for (const r of Object.values(this.data.records)) {
      if (r.headSha === headSha && (!newest || Date.parse(r.at) > Date.parse(newest.at)
        || (r.runId === newest.runId && r.attempt > newest.attempt && Date.parse(r.at) === Date.parse(newest.at)))) newest = r;
    }
    return newest;
  }
  // Records are kept RECORD_KEEP_MS; a head's entry is dropped by the lane once the head is no longer a candidate (AdmissionRerunner).
  async save() {
    const cut = this.clock() - RECORD_KEEP_MS;
    for (const [k, v] of Object.entries(this.data.records)) if (!(Date.parse(v?.at) > cut)) delete this.data.records[k];
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, canonicalJson(this.data));
    await fs.rename(tmp, this.file);
  }
}

// Which heads the lane looks at: those this node ran or queued (current, the queue's rows, its recent outcomes) among the open pull
// requests the poller saw, only on an ACTIVE node, and only by a status.json written within STATUS_STALE_MS (an older one proves
// nothing about the role: the executor may have stopped and the other node taken over, as panel-dispatch.mjs and pr-status.mjs read
// it too). pulls: null before the poller's first pass.
export function statusFresh(status, now) {
  return Number.isSafeInteger(status?.writtenAt) && Number.isSafeInteger(now) && now - status.writtenAt <= STATUS_STALE_MS && status.writtenAt - now <= 60_000;
}
// Fable 11-20 (A3): the train's front head (status.train.last, mode on) is a candidate of its own and comes first, so the front whose required
// runs ended with no result (skipped by the gate, never on a runner: the runner hook never fires for them) is found and re-run here even
// when the head is no longer among this node's queue rows. The train itself judges nothing: it waits its observation window for the new
// attempt (train-facts.mjs REQUIRED_RERUN_WINDOW_MS).
export function candidateHeads(status, pulls, now) {
  if (!status || status.node?.mode !== 'ACTIVE' || status.halt || !statusFresh(status, now)) return [];
  const mine = new Set([status.current, ...(status.pending ?? []), ...(status.recent ?? [])].filter(x => x && Number.isSafeInteger(x.pr) && HEX40.test(x.headSha ?? '')).map(x => `${x.pr}:${x.headSha}`));
  const last = status.train?.last;
  const trainFront = last?.mode === 'on' && Number.isSafeInteger(last.front?.pr) && HEX40.test(last.front?.headSha ?? '') ? `${last.front.pr}:${last.front.headSha}` : null;
  const open = (pulls ?? []).filter(p => p && HEX40.test(p.headSha ?? ''));
  const heads = [...open.filter(p => `${p.pr}:${p.headSha}` === trainFront), ...open.filter(p => `${p.pr}:${p.headSha}` !== trainFront && mine.has(`${p.pr}:${p.headSha}`))]
    .map(p => ({ pr: p.pr, headSha: p.headSha }));
  if (status.train?.enabled !== 'on' || status.train.landing !== 'push' || status.train.notOnDuty) return heads;
  const fronts = (status.pending ?? []).filter(p => LIVE_STATES.includes(p?.state) && HEX40.test(p.testSha ?? '')
    && p.testSha !== p.headSha && heads.some(h => h.pr === p.pr && h.headSha === p.headSha));
  return [...fronts.map(({ pr, headSha, testSha }) => ({ pr, headSha, testSha })), ...heads];
}

export class AdmissionRerunner {
  // ports: { gh (ghPort), state (AdmissionRerunState), clock, readStatus() -> parsed status.json, pulls() -> the poller's open pull
  //   requests, notify(key, title, body) (a toast for the Owner) }
  constructor(ports) { Object.assign(this, ports); this.workflowMemo = newWorkflowMemo(); }
  // Whether the latest receipt for the head is an accepted re-run.
  done(headSha) { const r = this.state.record(headSha); return r?.outcome === 'sent' && !r.kind; }

  // What the PR page says of this head (pr-status.mjs#withRerunLine).
  line(headSha) {
    const seen = this.state.data.heads[headSha];
    const issue = seen?.scopeIssue ?? Object.values(this.state.data.heads).find(h => h.scopeIssue?.prHead === headSha)?.scopeIssue;
    if (issue) return issue.message;
    const unavailable = new Set();
    for (const receipt of Object.values(this.state.data.records)) {
      if (receipt.headSha !== headSha || receipt.kind !== REDISPATCH_KIND || receipt.http !== 422) continue;
      if (!receipt.skipped && seen?.workflowIds?.includes(receipt.workflowId)) continue;
      for (const name of receipt.checks ?? []) if (!seen?.missing || seen.missing.includes(name)) unavailable.add(name);
    }
    if (unavailable.size) return `${[...unavailable].join('、')} 没有运行，无法自动补发`;
    const r = this.state.record(headSha);
    if (r?.kind === REDISPATCH_KIND && r.http === 422) return null;
    if (!r) {
      const staging = Object.values(this.state.data.records).filter(rec => rec.frontHeadSha === headSha && rec.outcome === 'sent')
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.attempt - a.attempt)[0];
      if (staging) {
        const details = ['列车暂存提交', failureLabel(staging.failures) || staging.checks?.join('、'), `尝试 ${staging.attempt}`].filter(Boolean);
        return `已自动补跑一次必需测试（${details.join('，')}）`;
      }
    }
    if (r?.kind === STUCK_KIND || (r?.skipped && ['unsent', 'refused'].includes(r.outcome)))
      return `必需测试被跳过且不能自动补跑：${r.checks?.join('、') ? `${r.checks.join('、')}，` : ''}${r.why}，请推新提交或手动 Run workflow`;
    if (r?.kind === REDISPATCH_KIND && r.skipped) return r.outcome === 'sent'
      ? '必需测试被跳过（推送者非 Owner），已自动补发一次' : '必需测试被跳过，自动补发结果不确定';
    if (r?.kind === REDISPATCH_KIND) return r.outcome === 'sent' ? '必需测试没有运行，已自动补发一次' : ['intent', 'unknown'].includes(r.outcome) ? '必需测试没有运行，自动补发结果不确定' : '必需测试没有运行，自动补发未成功';
    const failures = failureLabel(r?.failures);
    if (r?.outcome === 'sent') return `已自动补跑一次必需测试${failures ? `（${failures}，尝试 ${r.attempt}）` : r.checks?.length ? `（${r.checks.join('、')}）` : ''}`;
    const outcome = { unsent: '自动补跑没有发出', refused: '自动补跑被拒绝', unknown: '自动补跑结果不确定' }[r?.outcome];
    return outcome ? `${outcome}${failures ? `（${failures}）` : ''}` : null;
  }
  async step() {
    // An unreadable memory file stops the lane (a forgotten record could click twice). It is read again at each step (a passing lock
    // by an antivirus or a profile sync), and the Owner is told once while it stays unreadable.
    if (this.state.unreadable) {
      let again = null;
      try { again = await AdmissionRerunState.open(this.state.file, this.clock); } catch { again = null; }
      if (again && !again.unreadable) this.state = again;
      else {
        if (!this.unreadableTold) {
          this.unreadableTold = true;
          try { await this.notify('admission-rerun:state-unreadable', '自动补跑已暂停', `补跑记忆文件读不出（${this.state.unreadableCode ?? '?'}）：${this.state.file}。为免同一个 head 点两次，自动补跑暂停，直到文件能读或被移走。`); } catch { /* a toast only */ }
        }
        return { acted: 0, reason: 'ADMISSION_RERUN_STATE_UNREADABLE' };
      }
    }
    this.unreadableTold = false;
    // A record left as intent is an unknown result. The Owner hears of it after the conversion is persisted.
    for (const [key, rec] of Object.entries(this.state.data.records)) {
      if (rec?.outcome !== 'intent') continue;
      rec.outcome = 'unknown';
      rec.why = '伴随进程在发出请求前后停止，不知道请求是否到了 GitHub';
      let saved = true;
      try { await this.state.save(); } catch { saved = false; }
      if (!saved) { rec.outcome = 'intent'; rec.why = null; break; }
      const told = rec.kind === REDISPATCH_KIND ? [`PR #${rec.pr}：必需测试没有运行，自动补发结果不确定`, `${rec.why}。请到 PR 页面看是否已有对应工作流的运行。不会再自动补发。`]
        : [`PR #${rec.pr}：自动补跑结果不确定`, `${rec.why}。${failureLabel(rec.failures)} 当前运行 ${rec.runId}，目标尝试 ${rec.attempt}。${retryExplanation(rec)}`];
        try { await this.notify(`admission-rerun:${key}:${rec.requests ?? 1}`, told[0], withCheckNames(told[1], rec.checks)); } catch { /* a toast only */ }
    }
    let status;
    try { status = await this.readStatus(); } catch { return { acted: 0, reason: 'STATUS_UNREADABLE' }; }
    const now = this.clock();
    let looked = 0, acted = 0, changed = false;
    const errors = [];
    const pulls = this.pulls();
    const candidates = candidateHeads(status, pulls, now);
    // A head's entry lives as long as the head is a candidate, whatever its age (so the window is never started again for it, and a
    // final verdict is kept); lastCandidateAt says when it last was one (refreshed at most every HEAD_CANDIDATE_MARK_MS). A head that is
    // not a candidate goes once a full view (a fresh status of an ACTIVE node, no HALT, a poller pass with open pull requests) no longer
    // lists it, or twice HEAD_WATCH_MS after it last was a candidate: a companion start (no poller pass yet), a STANDBY or UNCERTAIN
    // spell, a HALT or a stale status never resets the window or forgets a final verdict.
    const fullView = status?.node?.mode === 'ACTIVE' && !status.halt && statusFresh(status, now) && Array.isArray(pulls) && pulls.length > 0;
    const live = new Set(candidates.map(c => c.testSha ?? c.headSha));
    for (const [k, h] of Object.entries(this.state.data.heads)) {
      if (live.has(k)) {
        if (!(now - Date.parse(h.lastCandidateAt ?? '') < HEAD_CANDIDATE_MARK_MS)) { h.lastCandidateAt = new Date(now).toISOString(); changed = true; }
        continue;
      }
      if (fullView || !(now - Date.parse(h.lastCandidateAt ?? h.firstSeen) < 2 * HEAD_WATCH_MS)) { delete this.state.data.heads[k]; changed = true; }
    }
    for (const candidate of candidates) {
      const { pr, testSha } = candidate;
      const headSha = testSha ?? candidate.headSha;
      const headRecord = this.state.headRecord(headSha);
      if (!this.state.data.heads[headSha]) { this.state.data.heads[headSha] = { firstSeen: new Date(now).toISOString(), lastCandidateAt: new Date(now).toISOString(), lookedAt: null, final: null }; changed = true; }
      const seen = this.state.data.heads[headSha];
      // Older verdicts used different repair or scope rules. Recheck within the original watch window.
      if (seen.final && seen.repairRuleVersion !== REPAIR_RULE_VERSION) { seen.final = null; changed = true; }
      if (seen.final || now - Date.parse(seen.firstSeen) > HEAD_WATCH_MS) continue;
      if (seen.lookedAt && now - Date.parse(seen.lookedAt) < HEAD_RECHECK_MS) continue;
      if (looked >= HEADS_PER_STEP) break;
      looked += 1;
      changed = true;
      seen.lookedAt = new Date(now).toISOString();
      const results = decisions({ gh: this.gh, ...candidate, headAgeMs: now - Date.parse(seen.firstSeen), workflowMemo: this.workflowMemo,
        workflowInventory: seen.workflowInventory, rulesRead: () => { this.rulesFailingSince = null; },
        canDispatch: id => headRecord?.kind !== REDISPATCH_KIND && !this.state.data.records[headRecordKey(headSha, id)],
        canRequest: (runId, attempt) => {
          const prior = this.state.request(runId, attempt);
          return !prior || (canRetry(prior) && now - Date.parse(prior.at) >= REQUEST_RETRY_MS);
        } });
      for await (const d of results) {
        if (d.action === 'error') errors.push({ headSha, reason: d.reason });
        if (d.action === 'inventory') seen.workflowInventory = d.workflowInventory;
        if (d.action === 'scope-ready') {
          delete seen.scopeIssue;
          Object.assign(seen, { missing: d.missing, workflowIds: d.workflowIds });
        }
        if (d.rulesUnreadable) this.rulesFailingSince ??= now;
        // A network flap on the rules read is logged (errors) and nothing more until it has lasted RULES_UNREADABLE_REPORT_AFTER_MS.
        if (d.scopeIssue && !(d.rulesUnreadable && now - this.rulesFailingSince < RULES_UNREADABLE_REPORT_AFTER_MS)) {
          const prior = seen.scopeIssue;
          const repeated = prior?.message === d.scopeIssue;
          const alreadyTold = Object.values(this.state.data.heads).some(h => h.scopeIssue?.prHead === candidate.headSha
            && h.scopeIssue.message === d.scopeIssue && h.scopeIssue.told);
          seen.scopeIssue = { prHead: candidate.headSha, message: d.scopeIssue, told: alreadyTold };
          if (repeated && !alreadyTold) {
            seen.scopeIssue.told = true;
            try { await this.state.save(); } catch {
              seen.scopeIssue.told = false;
              this.unsaved = true;
              return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' };
            }
            try { await this.notify(`admission-rerun:${candidate.headSha}:scope:${now}`, `PR #${pr}：${d.scopeIssue}`, d.reason); } catch { /* a toast only */ }
          }
        }
        if (d.action === 'settled') {
          seen.final = d.reason;
          seen.repairRuleVersion = REPAIR_RULE_VERSION;
        }
        if (d.systemic?.length) {
          const target = requestKey(d.runId, d.attempt + 1);
          const prior = seen.systemicNotices;
          const told = prior?.[target] ?? (seen.systemicNotice?.target === target ? seen.systemicNotice.jobs : []);
          const next = d.systemic.filter(name => !told.includes(name));
          if (next.length) {
            seen.systemicNotices = { ...prior, [target]: [...told, ...next] };
            try { await this.state.save(); } catch {
              if (prior === undefined) delete seen.systemicNotices;
              else seen.systemicNotices = prior;
              this.unsaved = true;
              return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' };
            }
            for (const name of next) {
              try { await this.notify(`admission-rerun:${target}:systemic:${name}`, `PR #${d.pr ?? pr}：${name} 系统性超时，暂不自动重跑`, d.reason); } catch { /* a toast only */ }
            }
          }
        }
        if (d.action === 'final') {
          const target = requestKey(d.runId, d.attempt);
          if (d.exhausted && !seen.exhausted?.includes(target)) {
            const prior = seen.exhausted;
            seen.exhausted = [...(prior ?? []), target];
            try { await this.state.save(); } catch {
              seen.exhausted = prior;
              this.unsaved = true;
              return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' };
            }
            try {
              await this.notify(`admission-rerun:${d.runId}:exhausted`, `PR #${d.pr ?? pr}：三次环境类失败，已停止自动重跑（${failureLabel(d.exhausted)}）`,
                `运行 ${d.runId} 已达到环境类修复上限，待查故障原因。`);
            } catch { /* a toast only */ }
          } else if (!d.exhausted && d.neverRan && !this.state.headRecord(headSha)
            && !this.state.data.records[headRecordKey(headSha, d.workflowId)]) {
            this.state.data.records[headSha] = { contract: RERUN_RECORD_CONTRACT, kind: STUCK_KIND, pr: d.pr ?? pr, headSha,
              runId: d.runId, attempt: d.attempt, checks: d.checks, outcome: 'refused', at: new Date(now).toISOString(), why: d.reason };
            try { await this.state.save(); } catch {
              delete this.state.data.records[headSha]; this.unsaved = true;
              return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' };
            }
            try { await this.notify(`admission-rerun:${headSha}`, `PR #${d.pr ?? pr}：${this.line(headSha)}`, d.reason); } catch { /* a toast only */ }
          }
        }
        if (d.action !== 'rerun' && d.action !== 'redispatch') continue;
        const lost = d.action === 'redispatch';
        const key = lost ? headRecordKey(headSha, d.workflowId) : requestKey(d.runId, d.attempt + 1);
        const prior = this.state.data.records[key];
        // Before a POST, durably consume one request for this key. Do not refund it on an ambiguous answer.
        const record = lost ? { contract: RERUN_RECORD_CONTRACT, kind: REDISPATCH_KIND, pr: d.pr ?? pr, headSha, workflowId: d.workflowId, checks: d.checks,
          runId: null, attempt: null, outcome: 'intent', at: new Date(now).toISOString(), why: null }
          : { contract: RERUN_RECORD_CONTRACT, pr: d.pr ?? pr, headSha, runId: d.runId, attempt: d.attempt + 1, outcome: 'intent', at: new Date(now).toISOString(),
            why: null, checks: d.checks, failures: d.failures, requests: prior ? (prior.requests ?? 1) + 1 : 1 };
        if (d.skipped) record.skipped = true;
        if (testSha) record.frontHeadSha = candidate.headSha;
        this.state.data.records[key] = record;
        // No receipt, no request; this step's earlier changes stay to be written at the next step (review round 30, NIT 1).
        try { await this.state.save(); } catch {
          if (prior) this.state.data.records[key] = prior;
          else delete this.state.data.records[key];
          this.unsaved = true;
          return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' };
        }
        let r;
        try { r = await (lost ? this.gh.dispatch(d.workflowId, d.ref, record.pr, headSha) : this.gh.rerun(d.runId)); } catch { r = { outcome: 'unsent', why: 'gh 没有启动' }; }
        Object.assign(record, { outcome: r.outcome, why: r.outcome === 'sent' ? null : short(r.why), at: new Date(this.clock()).toISOString() });
        if (lost && r.http !== undefined) record.http = r.http;
        // The intent on disk already stops a second request; an unsaved outcome is written again at the end of this step or the next
        // (review round 29, NIT 3).
        try { await this.state.save(); changed = false; } catch { changed = true; this.unsaved = true; }
        acted += 1;
        const text = lost && (d.skipped || r.http === 422) ? [`PR #${record.pr}：${this.line(headSha)}`, record.why ?? `已在分支 ${d.ref} 上点了一次“Run workflow”。`]
          : lost ? {
          sent: [`PR #${record.pr}：必需测试没有运行，已自动补发一次`, `GitHub 仍没有创建工作流 ${d.workflowId} 的运行，已在分支 ${d.ref} 上点了一次“Run workflow”。`],
          unsent: [`PR #${record.pr}：必需测试没有运行，自动补发没有发出`, `${record.why}，请求没有到 GitHub。不会再自动补发；请推一个新提交。`],
          refused: [`PR #${record.pr}：必需测试没有运行，自动补发被 GitHub 拒绝`, `${record.why}。不会再自动补发；请先核对工作流入口和权限。`],
          unknown: [`PR #${record.pr}：必需测试没有运行，自动补发结果不确定`, `${record.why}。请到 PR 页面看是否已有对应工作流的运行。不会再自动补发。`],
        }[r.outcome] : {
          sent: record.frontHeadSha
            ? [`PR #${record.pr}：已自动补跑 ${d.checks.join('、')}（列车暂存提交）`, `${failureLabel(record.failures)} 已请求“Re-run all jobs”（运行 ${d.runId}，尝试 ${record.attempt}）。`.trim()]
            : d.environment
            ? [`PR #${record.pr}：已自动补跑 ${d.checks.join('、')}（环境类失败）`, `${failureLabel(record.failures)}。已请求“Re-run all jobs”（运行 ${d.runId}，尝试 ${record.attempt}）。`]
            : [`PR #${record.pr}：已自动补跑 ${d.checks.join('、')}`, `准入在 gate 超时后才到，已按 #993 的规则点了一次“Re-run all jobs”（run ${d.runId}）。`],
          unsent: [`PR #${record.pr}：自动补跑没有发出`, `${failureLabel(record.failures)} ${record.why}，请求没有到 GitHub。${retryExplanation(record)}`.trim()],
          refused: [`PR #${record.pr}：自动补跑被 GitHub 拒绝`, `${failureLabel(record.failures)} ${record.why}。这个尝试号不再自动请求。`.trim()],
          unknown: [`PR #${record.pr}：自动补跑结果不确定`, `${failureLabel(record.failures)} ${record.why}。${retryExplanation(record)}`.trim()],
        }[r.outcome] ?? [`PR #${record.pr}：自动补跑结果不确定`, '不会再自动点。'];
        const body = text[0].includes(record.checks.join('、')) ? text[1] : withCheckNames(text[1], record.checks);
        try { await this.notify(`admission-rerun:${key}:${record.requests ?? 1}`, text[0], body); } catch { /* a toast only */ }
      }
    }
    // An unsaved change (this step's, or one an earlier step could not write) is written now, else at the next step.
    if (changed || this.unsaved) { try { await this.state.save(); this.unsaved = false; } catch { this.unsaved = true; } }
    return errors.length ? { acted, looked, errors } : { acted, looked };
  }
}

const failureLabel = failures => failures?.map(({ name, kind }) => `${name} ${kind}`).join('、') ?? '';
const withCheckNames = (body, checks) => checks?.length ? `${checks.join('、')}。${body}` : body;
const canRetry = r => ['unsent', 'unknown'].includes(r.outcome) && (r.requests ?? 1) === 1;
const retryExplanation = r => canRetry(r)
  ? '10 分钟后若 GitHub 仍显示同一尝试已结束，将再请求一次。'
  : '这个尝试号不再自动请求。';
