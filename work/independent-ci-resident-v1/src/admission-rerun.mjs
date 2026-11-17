// Generation 12 (DESIGN §56.5; Task c9dea57b item 4; Owner Decision 207c0cd0 v2, option C): the companion asks for the one repair
// re-run of the required tests that the admission gate allows, instead of the Owner clicking it.
//
// clued-required-tests.yml's admission-gate waits at most 600 s for App 5368905's kooyumi-work-admission check (this resident's
// stage 1). When the resident is busy the check comes later: the gate ends ADMISSION_PENDING, every heavy job is skipped, the
// required checks stay missing. Since #993 the gate admits one "Re-run all jobs" of such a run (independentRepairRerun in
// scripts/ci/clued-work-admission.mjs); until now the Owner clicked it. This lane clicks it with the Owner's own gh login (the one
// the companion already writes the PR page with), no new workflow, no new token, no new App permission.
//
// It asks GitHub for "Re-run all jobs" (gh api --method POST repos/<repo>/actions/runs/<id>/rerun) of the newest
// clued-required-tests pull_request run of a head only when all of these hold, and otherwise does nothing:
//   0. this node is ACTIVE (status.json), it ran or queued that head, and this lane never asked for a re-run of that head before
//      (its own record, written BEFORE the request: a request whose answer was lost is never sent again, whatever happened);
//   1. exactly one open pull request into the default branch, from this repository, has exactly that head, and App 5368905's
//      newest kooyumi-work-admission check of the head admits it (completed, success, bound to that pull request:
//      independentAdmissionCheck), i.e. stage 1 published the admission;
//   2. every clued-required-tests pull_request run of the head is completed (no attempt queued or running);
//   3. no job other than admission-gate of any attempt of any of those runs ever ran (each is completed and skipped);
//   4. the gate's own repair rule (independentRepairRerun, ported below) allows the next attempt: every earlier attempt ran only the
//      gate, and the gate ended ADMISSION_PENDING, RERUN_REFUSED or on a GitHub 5xx/unreachable ERROR;
//   5. read again right before the request, the pull request is still open on that head and the run still completed at the same
//      attempt.
// Never "Re-run failed jobs" or a single job (they keep the gate's earlier outputs). The gate of the new attempt judges the re-run
// again; this lane is never the authority for running the heavy jobs.
// Every read is `gh api --method GET` with fixed, validated routes; a read that fails or answers something unexpected ends the step
// without acting (it is asked again at the next step). The one write is never repeated: its outcome is recorded (sent; unsent: gh
// never ran; refused: GitHub answered 4xx; unknown: timed out, unconfirmed or no HTTP answer) and the head is done for this lane;
// every outcome is told to the Owner once.
//
// Lost run (Task 7067280f, PLAN 1a): GitHub sometimes creates no clued-required-tests run at all for a pushed head (a0122fd9,
// 2026-11-09: no GitHub Actions check suite either, so there is nothing to re-run or re-request; a user token is refused the
// check-suite rerequest and create routes anyway, HTTP 404 in a throwaway repository). When rule 1 holds and, LOST_RUN_AFTER_MS after
// this lane first saw the head, the complete listing of the workflow's runs of the head is empty (total_count 0), read again right
// before the request together with the pull request (still open on that head, its branch name valid), the lane asks once for
// "Run workflow" of clued-required-tests.yml on the pull request's branch (gh api --method POST
// repos/<repo>/actions/workflows/clued-required-tests.yml/dispatches -f ref=<branch> -f inputs[pr]=<pr> -f inputs[head]=<head>). A failed or truncated listing, a moved head or
// an unknown age is "not known": nothing is asked, the head is read again later. The same receipt (kind redispatch) makes it once per
// head whatever the outcome, and the PR page says what came of it. The workflow and the installed runner hook independently bind
// this recovery to the current open PR/head and preserve the ordinary identity, workflow and Native admission gates.
// Bot-pushed heads can have an admitted gate but entirely skipped heavy jobs.
// Recover those through the same one-shot dispatch receipt, after checking all
// runs and attempts. A terminal refusal with no execution is visible and told
// to the Owner once, instead of retaining a silent final verdict.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, canonicalJson, check } from './canonical.mjs';
import { STATUS_STALE_MS } from './status.mjs';
import { diedInSetup, failedSteps, jobFailureKind } from './env-failure.mjs';

export const RERUN_RECORD_CONTRACT = 'clued.independent-ci.admission-rerun/1';
export const RERUN_STATE_CONTRACT = 'clued.independent-ci.admission-rerun-state/1';
// A head with no run of the workflow this long after the lane first saw it lost its run (the lane sees a head within about two
// minutes of the push: the poller's minute, then this lane's).
export const LOST_RUN_AFTER_MS = 5 * 60_000;
export const REDISPATCH_KIND = 'redispatch';
const STUCK_KIND = 'stuck';
// A pull request's branch name as it goes into the dispatch's argv: no '..', no leading or trailing '/', nothing else.
const BRANCH_REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export const REQUIRED_TESTS_WORKFLOW = 'clued-required-tests.yml';
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
const MAX_PAGES = 10;
const MAX_TEXT = 3_500_000;
// Runner refusals before any child ran (runner.mjs): nothing reached GitHub.
const UNSENT_REFUSALS = Object.freeze(['RUNNER_ARGV_REFUSED', 'RUNNER_BUSY_WITH_UNFINISHED_CHILD', 'RUNNER_SPAWN_FAILED', 'RUNNER_TIMEOUT_REFUSED']);
export const RERUN_OUTCOMES = Object.freeze(['intent', 'sent', 'unsent', 'refused', 'unknown']);
const plainObject = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
// The memory file's exact shape; anything else is unreadable (a forgotten record could click twice).
function validState(v) {
  if (!plainObject(v) || Object.keys(v).sort().join('|') !== 'contract|heads|records' || v.contract !== RERUN_STATE_CONTRACT || !plainObject(v.heads) || !plainObject(v.records)) return false;
  for (const [k, h] of Object.entries(v.heads)) if (!HEX40.test(k) || !plainObject(h) || !Number.isFinite(Date.parse(h.firstSeen))) return false;
  for (const [k, r] of Object.entries(v.records)) if (!HEX40.test(k) || !plainObject(r) || r.headSha !== k || !RERUN_OUTCOMES.includes(r.outcome) || !Number.isFinite(Date.parse(r.at)) || ![undefined, REDISPATCH_KIND, STUCK_KIND].includes(r.kind)) return false;
  return true;
}
const positive = v => Number.isSafeInteger(v) && v > 0;
const short = t => String(t).replace(/[\r\n]+/g, ' ').slice(0, 200);
class Unreadable extends Error {}
const unreadable = what => { throw new Unreadable(what); };

// The gh port: fixed argv, routes built here from validated values only. get -> parsed JSON or throws Unreadable.
export function ghPort({ ghExe, repo, run }) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') && typeof run === 'function', 'ADMISSION_RERUN_CONFIG_INVALID');
  const routeOk = route => typeof route === 'string' && /^[A-Za-z0-9_./?&=%:-]*$/.test(route) && !route.split(/[/?]/).slice(1).some(p => p === '.' || p === '..');
  async function get(route) {
    check(routeOk(route), 'ADMISSION_RERUN_ROUTE_REFUSED');
    let r;
    try { r = await run([ghExe, 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repo}${route}`], { timeoutMs: READ_TIMEOUT_MS }); }
    catch { return unreadable(`GET ${route} could not start`); }
    if (r?.code !== 0) unreadable(`GET ${route} failed`);
    try { return JSON.parse(r.stdout); } catch { return unreadable(`GET ${route} answered no JSON`); }
  }
  // A job log: plain text (gh follows GitHub's redirect). The runner keeps at most MAX_TEXT characters of stdout; a log that long may have lost
  // its verdict, so it is answered as empty, which never proves an environment failure.
  async function text(route) {
    check(routeOk(route), 'ADMISSION_RERUN_ROUTE_REFUSED');
    let r;
    try { r = await run([ghExe, 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repo}${route}`], { timeoutMs: READ_TIMEOUT_MS }); }
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
    return http ? { outcome: 'refused', why: `GitHub 拒绝（HTTP ${http[1]}）` } : { outcome: 'unknown', why: `gh 退出码 ${short(r?.code ?? '无')}，没有 HTTP 答复` };
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
    async dispatch(ref, pr, headSha) {
      check(BRANCH_REF.test(ref ?? '') && positive(pr) && HEX40.test(headSha ?? ''), 'ADMISSION_RERUN_ROUTE_REFUSED');
      return post(['-f', `ref=${ref}`, '-f', `inputs[pr]=${pr}`, '-f', `inputs[head]=${headSha}`,
        `repos/${repo}/actions/workflows/${REQUIRED_TESTS_WORKFLOW}/dispatches`]);
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

// clued-work-admission.mjs#independentRepairRerun (#993), over the gh port: may attempt `attempt` of run `runId` be a repair re-run?
// Task 1b: besides the attempts that ran nothing, the ONE earlier attempt that ran heavy jobs is repaired when every job that did not pass
// died of the environment alone (env-failure.mjs, the same evidence as the gate's environmentFailures) and its gate job succeeded.
// -> { allowed: true, environment: names | null } | { allowed: false, reason }
export async function repairAllowed(gh, runId, headSha, attempt) {
  let environment = null;
  for (let earlier = 1; earlier < attempt; earlier += 1) {
    const jobs = await gh.paged(`/actions/runs/${runId}/attempts/${earlier}/jobs`, 'jobs');
    const listed = jobs.filter(j => j && typeof j === 'object');
    const gates = listed.filter(j => j.name === GATE_JOB_NAME), heavy = listed.filter(j => j.name !== GATE_JOB_NAME);
    if (listed.length !== jobs.length || gates.length !== 1 || heavy.length === 0) return { allowed: false, reason: `attempt ${earlier} does not list one ${GATE_JOB_NAME} job and its heavy jobs` };
    if (listed.some(j => j.head_sha !== headSha)) return { allowed: false, reason: `attempt ${earlier} has a job of another head` };
    if (heavy.some(j => !(j.status === 'completed' && j.conclusion === 'skipped'))) {
      const failed = heavy.filter(j => j.conclusion === 'failure');
      const settled = failed.length > 0 && gates[0].status === 'completed' && gates[0].conclusion === 'success'
        && heavy.every(j => j.status === 'completed' && ['success', 'skipped', 'failure'].includes(j.conclusion));
      if (environment !== null || !settled) return { allowed: false, reason: `attempt ${earlier} already ran a heavy job` };
      for (const j of failed) {
        const log = diedInSetup(j) || !(failedSteps(j)?.length > 0) || !positive(j.id) ? null : await gh.text(`/actions/jobs/${j.id}/logs`);
        if (!jobFailureKind(j, log).environment) return { allowed: false, reason: `attempt ${earlier} already ran a heavy job (not an environment failure)` };
      }
      environment = failed.map(j => String(j.name).slice(0, 80));
      continue;
    }
    if (diedInSetup(gates[0])) continue; // the gate job died in the runner's setup: it ran nothing and left no verdict
    if (!positive(gates[0].id)) unreadable(`the gate job of attempt ${earlier} has no id`);
    const notes = await gh.paged(`/check-runs/${gates[0].id}/annotations`);
    if (!notes.some(n => n && ((n.title === GATE_JOB_NAME && NOT_ADMITTED_VERDICT.test(String(n.message ?? '')))
      || (n.title === ERROR_ANNOTATION_TITLE && TRANSIENT_API_ERROR.test(String(n.message ?? '')))))) {
      return { allowed: false, reason: `the ${GATE_JOB_NAME} job of attempt ${earlier} did not end in ADMISSION_PENDING or a GitHub API outage` };
    }
  }
  return { allowed: true, environment };
}

// The decision for one head (rules 1-5, or the lost run). -> { action: 'rerun' | 'redispatch' | 'skip' | 'final' | 'error', reason, pr,
// runId, attempt, ref }. 'final': this head never needs this lane again (a heavy job ran, the repair rule refused). 'skip': not now.
// 'error': unreadable. headAgeMs: how long ago this lane first saw the head (null: not known, never old).
export async function decide({ gh, headSha, defaultBranch = 'main', headAgeMs = null }) {
  const out = { action: 'skip', reason: '', pr: null, runId: null, attempt: null, ref: null, environment: null };
  const say = (action, reason) => Object.assign(out, { action, reason: short(reason) });
  if (!HEX40.test(headSha ?? '')) return say('final', 'no head');
  try {
    // 1. The open pull request with exactly this head, into the default branch, from this repository, admitted now.
    const listed = await gh.paged(`/commits/${headSha}/pulls`);
    const open = listed.filter(p => p && p.state === 'open' && p.head?.sha === headSha && p.base?.ref === defaultBranch
      && p.base?.repo?.full_name === gh.repo && p.head?.repo?.full_name === gh.repo && positive(p.number));
    if (open.length !== 1) return say(open.length === 0 ? 'skip' : 'final', open.length === 0 ? 'no open pull request into the default branch has this head' : 'more than one pull request has this head');
    const pr = open[0];
    out.pr = pr.number;
    // 2. The required-tests runs of this head, every event; none at all is a lost run.
    const runsRoute = `/actions/workflows/${REQUIRED_TESTS_WORKFLOW}/runs?head_sha=${headSha}&per_page=100`;
    const listRuns = async () => {
      const body = await gh.get(runsRoute);
      const runs = body?.workflow_runs;
      if (!Array.isArray(runs) || body.total_count !== runs.length || runs.length > 100 || new Set(runs.map(r => r?.id)).size !== runs.length
        || runs.some(r => !r || !positive(r.id) || !positive(r.run_attempt) || typeof r.status !== 'string')) unreadable('the required-tests runs are incomplete');
      return runs;
    };
    const runs = await listRuns();
    if (runs.length === 0) {
      if (!(Number.isFinite(headAgeMs) && headAgeMs >= LOST_RUN_AFTER_MS)) return say('skip', `#${pr.number} has no ${REQUIRED_TESTS_WORKFLOW} run on this head (yet)`);
      const now = await gh.get(`/pulls/${pr.number}`);
      if (!now || now.state !== 'open' || now.head?.sha !== headSha || now.base?.ref !== defaultBranch || now.base?.repo?.full_name !== gh.repo || now.head?.repo?.full_name !== gh.repo || !BRANCH_REF.test(now.head?.ref ?? '')) return say('skip', `#${pr.number} is no longer open on this head`);
      if ((await listRuns()).length !== 0) return say('skip', `a ${REQUIRED_TESTS_WORKFLOW} run of this head appeared`);
      if (!(await admissionOf(gh, headSha, pr.number)).admitted) return say('skip', `the ${ADMISSION_CHECK} check does not admit #${pr.number} (yet)`);
      out.ref = now.head.ref;
      return say('redispatch', `GitHub created no ${REQUIRED_TESTS_WORKFLOW} run of this head: "Run workflow" on ${now.head.ref} for #${pr.number}`);
    }
    if (!(await admissionOf(gh, headSha, pr.number)).admitted) return say('skip', `the ${ADMISSION_CHECK} check does not admit #${pr.number} (yet)`);
    const ofHead = runs.filter(r => r.head_sha === headSha && r.event === 'pull_request');
    const ofPr = ofHead.filter(r => Array.isArray(r.pull_requests) && r.pull_requests.some(e => e?.number === pr.number));
    if (ofPr.length === 0) return say('skip', `#${pr.number} has no ${REQUIRED_TESTS_WORKFLOW} run on this head`);
    const newest = ofPr.reduce((a, b) => (b.id > a.id ? b : a));
    Object.assign(out, { runId: newest.id, attempt: newest.run_attempt });
    if (runs.some(r => r.status !== 'completed')) return say('skip', 'an attempt is queued or running');
    // Inspect every attempt of every event, including a previous dispatch. A
    // missing job inventory is unknown, never proof that nothing executed.
    const jobsByRun = new Map();
    let allSkipped = true, latestGate = null;
    for (const r of runs) {
      if (r.head_sha !== headSha || r.run_attempt > 100) unreadable(`run ${r.id} has an invalid head or attempt`);
      const all = [];
      for (let n = 1; n <= r.run_attempt; n += 1) {
        const jobs = await gh.paged(`/actions/runs/${r.id}/attempts/${n}/jobs`, 'jobs');
        if (jobs.some(j => !j || typeof j !== 'object' || j.head_sha !== headSha)
          || jobs.filter(j => j.name === GATE_JOB_NAME).length !== 1 || !jobs.some(j => j.name !== GATE_JOB_NAME))
          unreadable(`attempt ${n} of run ${r.id} has an incomplete job inventory`);
        if (jobs.some(j => j.status !== 'completed')) unreadable(`attempt ${n} of run ${r.id} still has unfinished jobs`);
        if (jobs.some(j => j.name !== GATE_JOB_NAME && j.conclusion !== 'skipped')) allSkipped = false;
        if (r.id === newest.id && n === r.run_attempt) latestGate = jobs.find(j => j.name === GATE_JOB_NAME);
        all.push(...jobs);
      }
      jobsByRun.set(r.id, all);
    }
    out.neverRan = allSkipped;
    if (allSkipped && runs.some(r => r.event !== 'pull_request')) return say('final', 'a previous dispatch or non-PR run already exists');
    let skippedByActor = newest.actor?.type === 'Bot';
    if (allSkipped && !skippedByActor && positive(latestGate?.id)) {
      const log = await gh.text(`/actions/jobs/${latestGate.id}/logs`);
      skippedByActor = /"verdict"\s*:\s*"ADMITTED"/.test(log) && /"automation_self_hosted"\s*:\s*false/.test(log);
    }
    if (allSkipped && skippedByActor) {
      const now = await gh.get(`/pulls/${pr.number}`);
      if (!now || now.state !== 'open' || now.head?.sha !== headSha || now.base?.ref !== defaultBranch
        || now.base?.repo?.full_name !== gh.repo || now.head?.repo?.full_name !== gh.repo || !BRANCH_REF.test(now.head?.ref ?? ''))
        return say('skip', `#${pr.number} is no longer open on this head`);
      const again = await listRuns();
      if (again.length !== runs.length || again.some(r => !runs.some(old => old.id === r.id && old.head_sha === r.head_sha
        && old.event === r.event && old.status === r.status && old.run_attempt === r.run_attempt)))
        return say('skip', 'the required-tests runs changed since they were read');
      out.ref = now.head.ref;
      out.skipped = true;
      return say('redispatch', 'required tests were skipped for a non-Owner actor');
    }
    // 3. No heavy job of this head ever ran in another run (the newest run's own attempts are judged by step 4, which also allows the one
    // environment failure).
    for (const r of runs.filter(x => x.id !== newest.id)) {
      const jobs = jobsByRun.get(r.id);
      if (jobs.some(j => j.name !== GATE_JOB_NAME && !(j.status === 'completed' && j.conclusion === 'skipped'))) return say('final', `run ${r.id} already ran its heavy jobs`);
    }
    // 4. The gate's own repair rule for the attempt this would start.
    const next = newest.run_attempt + 1;
    const repair = await repairAllowed(gh, newest.id, headSha, next);
    if (!repair.allowed) return say('final', `attempt ${next} of run ${newest.id} would not be a repair re-run: ${repair.reason}`);
    // 5. Fresh reads right before the one write.
    const now = await gh.get(`/pulls/${pr.number}`);
    if (!now || now.state !== 'open' || now.head?.sha !== headSha || now.base?.ref !== defaultBranch) return say('skip', `#${pr.number} is no longer open on this head`);
    const again = await gh.get(`/actions/runs/${newest.id}`);
    if (!again || again.head_sha !== headSha || again.status !== 'completed' || again.run_attempt !== newest.run_attempt) return say('skip', `run ${newest.id} changed since it was read`);
    out.environment = repair.environment;
    return say('rerun', `"Re-run all jobs" of run ${newest.id} (attempt ${next}) for #${pr.number}${repair.environment ? ` after an environment failure of ${repair.environment.join(', ')}` : ''}`);
  } catch (e) {
    return say('error', `nothing re-run: ${e instanceof Unreadable ? e.message : 'a read failed'}`);
  }
}

// The lane's own memory (the Owner's profile, its own file: two lanes never write one file): per head, first seen and last looked
// at; and the records (receipts) of every re-run asked for, written before the request and completed after it.
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
    s.data = { contract: RERUN_STATE_CONTRACT, heads: v.heads, records: v.records };
    return s;
  }
  record(headSha) { return Object.hasOwn(this.data.records, headSha) ? this.data.records[headSha] : null; }
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
export function candidateHeads(status, pulls, now) {
  if (!status || status.node?.mode !== 'ACTIVE' || status.halt || !statusFresh(status, now)) return [];
  const mine = new Set([status.current, ...(status.pending ?? []), ...(status.recent ?? [])].filter(x => x && Number.isSafeInteger(x.pr) && HEX40.test(x.headSha ?? '')).map(x => `${x.pr}:${x.headSha}`));
  return (pulls ?? []).filter(p => p && HEX40.test(p.headSha ?? '') && mine.has(`${p.pr}:${p.headSha}`)).map(p => ({ pr: p.pr, headSha: p.headSha }));
}

export class AdmissionRerunner {
  // ports: { gh (ghPort), state (AdmissionRerunState), clock, readStatus() -> parsed status.json, pulls() -> the poller's open pull
  //   requests, notify(key, title, body) (a toast for the Owner) }
  constructor(ports) { Object.assign(this, ports); }
  // Whether this lane asked for a re-run of the head and GitHub accepted it.
  done(headSha) { const r = this.state.record(headSha); return r?.outcome === 'sent' && !r.kind; }
  // What the PR page says of this head (pr-status.mjs#withRerunLine): a re-run GitHub accepted, or what came of a lost run's dispatch.
  line(headSha) {
    const r = this.state.record(headSha);
    if (r?.kind === STUCK_KIND || (r?.skipped && ['unsent', 'refused'].includes(r.outcome)))
      return `必需测试被跳过且不能自动补跑：${r.why}，请推新提交或手动 Run workflow`;
    if (r?.kind === REDISPATCH_KIND && r.skipped) return r.outcome === 'sent'
      ? '必需测试被跳过（推送者非 Owner），已自动补发一次' : '必需测试被跳过，自动补发结果不确定';
    if (r?.kind === REDISPATCH_KIND) return r.outcome === 'sent' ? '必需测试没有运行，已自动补发一次' : ['intent', 'unknown'].includes(r.outcome) ? '必需测试没有运行，自动补发结果不确定' : '必需测试没有运行，自动补发未成功';
    return this.done(headSha) ? '已自动补跑一次必需测试' : null;
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
    // A record left as intent (the companion stopped between its two saves): whether GitHub got the request is not known. Never asked
    // again; it becomes unknown, and the Owner hears of it once (review round 29, NIT 4).
    for (const [headSha, rec] of Object.entries(this.state.data.records)) {
      if (rec?.outcome !== 'intent') continue;
      rec.outcome = 'unknown';
      rec.why = '伴随进程在发出请求前后停止，不知道请求是否到了 GitHub';
      let saved = true;
      try { await this.state.save(); } catch { saved = false; }
      if (!saved) { rec.outcome = 'intent'; rec.why = null; break; }
      const told = rec.kind === REDISPATCH_KIND ? [`PR #${rec.pr}：必需测试没有运行，自动补发结果不确定`, `${rec.why}。请到 PR 页面看是否已有 ${REQUIRED_TESTS_WORKFLOW} 的运行；没有再推一个新提交。不会再自动补发。`]
        : [`PR #${rec.pr}：自动补跑结果不确定`, `${rec.why}。请到 PR 页面看 run ${rec.runId} 是否已经重新开始；没有开始再手动补跑一次。不会再自动点。`];
      try { await this.notify(`admission-rerun:${headSha}`, told[0], told[1]); } catch { /* a toast only */ }
    }
    let status;
    try { status = await this.readStatus(); } catch { return { acted: 0, reason: 'STATUS_UNREADABLE' }; }
    const now = this.clock();
    let looked = 0, acted = 0, changed = false;
    const pulls = this.pulls();
    const candidates = candidateHeads(status, pulls, now);
    // A head's entry lives as long as the head is a candidate, whatever its age (so the window is never started again for it, and a
    // final verdict is kept); lastCandidateAt says when it last was one (refreshed at most every HEAD_CANDIDATE_MARK_MS). A head that is
    // not a candidate goes once a full view (a fresh status of an ACTIVE node, no HALT, a poller pass with open pull requests) no longer
    // lists it, or twice HEAD_WATCH_MS after it last was a candidate: a companion start (no poller pass yet), a STANDBY or UNCERTAIN
    // spell, a HALT or a stale status never resets the window or forgets a final verdict.
    const fullView = status?.node?.mode === 'ACTIVE' && !status.halt && statusFresh(status, now) && Array.isArray(pulls) && pulls.length > 0;
    const live = new Set(candidates.map(c => c.headSha));
    for (const [k, h] of Object.entries(this.state.data.heads)) {
      if (live.has(k)) {
        if (!(now - Date.parse(h.lastCandidateAt ?? '') < HEAD_CANDIDATE_MARK_MS)) { h.lastCandidateAt = new Date(now).toISOString(); changed = true; }
        continue;
      }
      if (fullView || !(now - Date.parse(h.lastCandidateAt ?? h.firstSeen) < 2 * HEAD_WATCH_MS)) { delete this.state.data.heads[k]; changed = true; }
    }
    for (const { pr, headSha } of candidates) {
      // One request per head in all, whatever it was: the lost-run dispatch, the ADMISSION_PENDING repair or the environment-failure re-run share this one
      // record (a head whose run was re-dispatched is not re-run again by this lane; the gate still allows its own one environment re-run by hand).
      if (this.state.record(headSha)) continue; // asked once already, whatever came of it
      if (!this.state.data.heads[headSha]) { this.state.data.heads[headSha] = { firstSeen: new Date(now).toISOString(), lastCandidateAt: new Date(now).toISOString(), lookedAt: null, final: null }; changed = true; }
      const seen = this.state.data.heads[headSha];
      // Old versions stored silent final verdicts without looking for skipped
      // execution. Reconcile those once; retain the original watch window.
      if (seen.final && !seen.skippedRecoveryChecked) { seen.final = null; changed = true; }
      if (seen.final || now - Date.parse(seen.firstSeen) > HEAD_WATCH_MS) continue;
      if (seen.lookedAt && now - Date.parse(seen.lookedAt) < HEAD_RECHECK_MS) continue;
      if (looked >= HEADS_PER_STEP) break;
      looked += 1;
      changed = true;
      seen.lookedAt = new Date(now).toISOString();
      const d = await decide({ gh: this.gh, headSha, headAgeMs: now - Date.parse(seen.firstSeen) });
      if (d.action === 'final') {
        seen.final = d.reason;
        seen.skippedRecoveryChecked = true;
        if (d.neverRan) {
          this.state.data.records[headSha] = { contract: RERUN_RECORD_CONTRACT, kind: STUCK_KIND, pr: d.pr ?? pr, headSha,
            runId: d.runId, attempt: d.attempt, outcome: 'refused', at: new Date(now).toISOString(), why: d.reason };
          try { await this.state.save(); } catch {
            delete this.state.data.records[headSha]; seen.final = null; this.unsaved = true;
            return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' };
          }
          try { await this.notify(`admission-rerun:${headSha}`, `PR #${d.pr ?? pr}：${this.line(headSha)}`, d.reason); } catch { /* a toast only */ }
        }
      }
      if (d.action !== 'rerun' && d.action !== 'redispatch') continue;
      const lost = d.action === 'redispatch';
      // The receipt first, on disk, then the one request. A crash or a lost answer in between leaves the intent: never sent again.
      const record = lost ? { contract: RERUN_RECORD_CONTRACT, kind: REDISPATCH_KIND, pr: d.pr ?? pr, headSha, runId: null, attempt: null, outcome: 'intent', at: new Date(now).toISOString(), why: null }
        : { contract: RERUN_RECORD_CONTRACT, pr: d.pr ?? pr, headSha, runId: d.runId, attempt: d.attempt + 1, outcome: 'intent', at: new Date(now).toISOString(), why: null };
      if (d.skipped) record.skipped = true;
      this.state.data.records[headSha] = record;
      // No receipt, no request; this step's earlier changes stay to be written at the next step (review round 30, NIT 1).
      try { await this.state.save(); } catch { delete this.state.data.records[headSha]; this.unsaved = true; return { acted, reason: 'ADMISSION_RERUN_STATE_UNSAVED' }; }
      let r;
      try { r = await (lost ? this.gh.dispatch(d.ref, record.pr, headSha) : this.gh.rerun(d.runId)); } catch { r = { outcome: 'unsent', why: 'gh 没有启动' }; }
      Object.assign(record, { outcome: r.outcome, why: r.outcome === 'sent' ? null : short(r.why), at: new Date(this.clock()).toISOString() });
      // The intent on disk already stops a second request; an unsaved outcome is written again at the end of this step or the next
      // (review round 29, NIT 3).
      try { await this.state.save(); changed = false; } catch { changed = true; this.unsaved = true; }
      acted += 1;
      const text = lost && d.skipped ? [`PR #${record.pr}：${this.line(headSha)}`, record.why ?? `已在分支 ${d.ref} 上点了一次“Run workflow”。`]
        : lost ? {
        sent: [`PR #${record.pr}：必需测试没有运行，已自动补发一次`, `推送 ${LOST_RUN_AFTER_MS / 60_000} 分钟后 GitHub 仍没有创建 ${REQUIRED_TESTS_WORKFLOW} 的运行，已在分支 ${d.ref} 上点了一次“Run workflow”。`],
        unsent: [`PR #${record.pr}：必需测试没有运行，自动补发没有发出`, `${record.why}，请求没有到 GitHub。不会再自动补发；请推一个新提交。`],
        refused: [`PR #${record.pr}：必需测试没有运行，自动补发被 GitHub 拒绝`, `${record.why}。不会再自动补发；请先核对工作流入口和权限。`],
        unknown: [`PR #${record.pr}：必需测试没有运行，自动补发结果不确定`, `${record.why}。请到 PR 页面看是否已有 ${REQUIRED_TESTS_WORKFLOW} 的运行；没有再推一个新提交。不会再自动补发。`],
      }[r.outcome] : {
        sent: d.environment
          ? [`PR #${record.pr}：环境类失败，已自动整轮重跑一次`, `${d.environment.join('、')} 因网络或 runner 启动失败（日志里没有测试失败），已按 gate 的规则点了一次“Re-run all jobs”（run ${d.runId}）。`]
          : [`PR #${record.pr}：已自动补跑一次必需测试`, `准入在 gate 超时后才到，已按 #993 的规则点了一次“Re-run all jobs”（run ${d.runId}）。`],
        unsent: [`PR #${record.pr}：自动补跑没有发出`, `${record.why}，请求没有到 GitHub。不会再自动点；需要时请在 PR 页面手动补跑一次。`],
        refused: [`PR #${record.pr}：自动补跑被 GitHub 拒绝`, `${record.why}。不会再自动点；需要时请在 PR 页面手动补跑一次。`],
        unknown: [`PR #${record.pr}：自动补跑结果不确定`, `${record.why}。请到 PR 页面看 run ${d.runId} 是否已经重新开始；没有开始再手动补跑一次。不会再自动点。`],
      }[r.outcome] ?? [`PR #${record.pr}：自动补跑结果不确定`, '不会再自动点。'];
      try { await this.notify(`admission-rerun:${headSha}`, text[0], text[1]); } catch { /* a toast only */ }
    }
    // An unsaved change (this step's, or one an earlier step could not write) is written now, else at the next step.
    if (changed || this.unsaved) { try { await this.state.save(); this.unsaved = false; } catch { this.unsaved = true; } }
    return { acted, looked };
  }
}
