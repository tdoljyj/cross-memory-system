// Train facts (resident quota redesign phase 2, step 3c-1; design v0.5 §5.2, §5.5 items 1, 2, 8, §5.6; DESIGN §21.2).
// Pure: what stage 10 read, and what the train WOULD do with it. In shadow mode nothing acts on it; the facts go to
// the resident (status, PR page) and to the shadow records for the step-4 statistics. No I/O, no credential.
// Facts /2 (step 3c-2b, DESIGN §41.7; INTERFACES §3): mode shadow | on | revoke-only; the /1 fields (wouldDo is the
// shadow judgement in every mode) plus `decision` (what this run ended on: WOULD_DO or DECISIONS_V2), `openFrontBatch`
// (on only, after a confirmed sweep and a confirmed touch running: the executor's one source of a test commit S),
// `sweep`, `actions`, `requestPause` and the holders' `nodes`.
// `frontBind` (on only, optional; DESIGN §62.4): during the take-over sweep, with strict confirmed in this run, the one open PR
// {pr, headSha, claimId} whose Native Task projection names the single queue head's current claim (FRONT_NOT_BOUND).
// It is a scheduling observation, never publication authority: the resident may run that PR's stage 1 only, which binds the claim
// through Native's verify; the front, the proofs and stage 8 are then decided exactly as before.
//
// wouldDo is one of WOULD_DO:
//   NOT_ON_DUTY              Native says this binding has no ci-admission role (the standby node)
//   NO_FRONT                 no live merge-slot holder in this scope (holders is scope-filtered: design §5.5 item 1)
//   FRONT_AMBIGUOUS          more than one live holder
//   FRONT_NOT_BOUND          the holder's claim names no PR of this repository
//   FRONT_NOT_RUNNABLE       the front PR is closed, a draft, or not based on main
//   FRONT_NEEDS_MAIN_MERGE   GitHub reports a conflict, or strict is on and the head does not contain main's tip
//   FRONT_TEST_MERGE_NOT_READY  no test merge yet, still computing, or not exactly [main, head]
//   FRONT_GREEN_WAIT_MERGE   on the current path (route github-merge) only: the front head already carries App 5368905's kooyumi-merge-slot
//                            success, and every check main's live rules require is passed on the head
//   FRONT_CHECKS_WAIT        the merge slot is green, a required check is not yet passed and it is queued or running, a re-run's gate is
//                            in flight, or the rules could not be read
//   FRONT_CHECKS_MISSING     the merge slot is green, a required check is absent, skipped or failed and nothing of it runs: the companion's
//                            repair lane re-runs a process-cause gap (admission-rerun.mjs)
//   Both end in FRONT_CHECKS_MISSING_YIELDED at once when the re-run budget is used up, at the latest REQUIRED_CHECKS_MAX_WAIT_MS after the
//   merge slot went green (requiredYieldReason).
//   OPEN_FRONT_BATCH         the train would open the front batch: T = main, H = head, S = the test merge
// wouldRevoke: ledgered merge-slot greens that are neither in main nor the front's current head (§5.4 item 3).
// The protected-layer pre-check (§41.4, MergeAdmission v0.2 §2.4: a protected-layer front H must contain T) runs in mode on
// only: stage 10 sets front.protectedLayer from the PR's changed paths and the admission policy (train-maintenance.mjs);
// shadow mode reports FRONT_NEEDS_MAIN_MERGE only from GitHub's own facts, as before.
import { BYPASS_STATES, validLandingMissing } from './train-landing.mjs';
import { RULE_SCAN_NAMES } from './train-rules.mjs';
import { validStrictReadiness, validStrictFrontReadiness, validTrainProviderBudget, validSweepProgress } from './train-strict.mjs';
export const TRAIN_FACTS_CONTRACT = 'clued.independent-ci.train-facts/2';
export const WOULD_DO = Object.freeze(['NOT_ON_DUTY', 'NO_FRONT', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND', 'FRONT_NOT_RUNNABLE', 'FRONT_NEEDS_MAIN_MERGE',
  'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH', 'FRONT_CHECKS_WAIT', 'FRONT_CHECKS_MISSING']);
// The on and revoke-only endings beyond WOULD_DO (DESIGN §41.3, §41.4, §41.6). TRAIN_SOURCE_UNREADABLE: ci_nodes_status
// could not be read, so the Source check could not be made (a deferral like TRAIN_SOURCE_MISMATCH, nothing written).
// TRAIN_FRONT_BATCH_RUNNING: this node's front batch of (claim, T, S) is still running (the holder's CI clock is running on
// H); the proof was refreshed for its stage 8, no new batch and no attempt counted (review R2 M1).
export const DECISIONS_V2 = Object.freeze(['TRAIN_REVOKE_UNCONFIRMED', 'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH',
  'TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_FRONT_BUDGET_SHORT', 'TRAIN_FRONT_ATTEMPTS_USED', 'FRONT_ADOPTED', 'FRONT_RETURNED', 'FRONT_FAILED_REPORTED', 'REVOKE_ONLY_DONE',
  'TRAIN_SOURCE_UNREADABLE', 'TRAIN_FRONT_BATCH_RUNNING', 'TRAIN_STRICT_OFF', 'TRAIN_FRONT_NOT_PROVEN', 'TRAIN_LANDING_STATE_UNREADABLE',
  'FRONT_CHECKS_MISSING_YIELDED']);
// FRONT_CHECKS_MISSING_YIELDED (Fable 11-20 补“车头缺必需检查”): the merge slot was green but a required check was missing when its re-run budget
// was used up, or at the longest wait (REQUIRED_YIELD_REASONS, in front.required.yieldReason): the front gave the slot to the next claim.
// D6 §8.4 (b): TRAIN_LANDING_STATE_UNREADABLE, push mode would open the front batch but this node's landing state cannot be read while it
// has landing batches (landing.error says the same); no batch, the resident tells the Owner.
// Strict-permanent mode (train-run /3 sweep audit|off; resident DESIGN §65): TRAIN_STRICT_OFF, strict read off in an on-mode run
// (no front batch; requestPause TRAIN_STRICT_OFF: the resident latches PAUSE and tells the Owner); TRAIN_FRONT_NOT_PROVEN, the front
// would be opened but this run could not write its strict current-front observation (stage 8 could not green it), so it opens none.
export const STRICT_PERMANENT_SWEEPS = Object.freeze(['audit', 'off']);
// The requestPause codes, each only with the decision of the same name, in mode on.
export const REQUEST_PAUSE_CODES = Object.freeze(['TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_STRICT_OFF']);
export const DECISIONS = Object.freeze([...WOULD_DO, ...DECISIONS_V2]);
export const TRAIN_MODES = Object.freeze(['shadow', 'on', 'revoke-only']);
export const SWEEP_KINDS = Object.freeze(['none', 'incremental', 'full-segment']);
export const MAX_REVOKE_LISTED = 20;
export const MAX_TRAIN_FACTS_BYTES = 32768;
export const NO_SWEEP = Object.freeze({ kind: 'none', complete: false, revoked: 0, unconfirmed: 0, wouldRevokeCount: 0,
  fullSweep: Object.freeze({ state: 'none', startedAt: null, completedAt: null, sinceOn: false, reason: null }), proofWritten: false, calls: 0, ms: 0 });
export const NO_ACTIONS = Object.freeze({ touchedRunning: false, adopted: false, returned: false, failedReported: false, keptAlive: 0, watermarkReported: false, revokeHead: null });
const SHA = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/, CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v));

// Fable 11-20 补“车头缺必需检查” (#1192), with the independent review of 051b7d585: green is success on every check main's live rules require,
// on the head; the list is the rules this run read, never one kept here. A merge-slot-green front that is not green gives the slot away
// (requiredYieldReason):
//   at once when a missing check has used its re-run budget, as GitHub shows it: REQUIRED_ATTEMPTS_MAX attempts of its job on the head (the
//   first run and two re-runs, every run of the workflow, a person's re-runs included; admission-rerun.mjs keeps the same budget per head and
//   workflow): REQUIRED_RERUNS_EXHAUSTED;
//   at the latest REQUIRED_CHECKS_MAX_WAIT_MS after the merge slot went green, whatever runs on the head and also when the rules cannot be
//   read: REQUIRED_CHECKS_DEADLINE. The clock starts at the merge slot's completion (its start if that is missing), else at the holder's front
//   time; with neither there is no wait to prove, so the deadline is already reached.
// Why 60 minutes (measured 2026-11-20 on runs 44633481108 and 44633481239, attempt 2): with the admission present (it is, once the merge slot
// is green) a re-run's gate admits in 24-27 s and the heavy jobs take 4-15 minutes; the companion's lane asks within 3 minutes (a step a
// minute, a head again every 2 minutes). One re-run cycle is about 19 minutes and the first run may still be finishing when the slot goes
// green (up to 15 minutes): 15 + 2 x 19 = 53 minutes. 60 covers both re-runs and stays under the merge slot's hard cap (120 minutes).
export const REQUIRED_CHECKS_MAX_WAIT_MS = 60 * 60_000;
// Three attempts of one run ID (required-tests-failure-rule.mjs REPAIR_ATTEMPTS_MAX; Fable 11-20 补“补跑上限的范围”).
export const REQUIRED_ATTEMPTS_MAX = 3;
export const REQUIRED_YIELD_REASONS = Object.freeze(['REQUIRED_RERUNS_EXHAUSTED', 'REQUIRED_CHECKS_DEADLINE', 'REQUIRED_CHECK_NOT_RERUN']);
// Fable 11-20 (A3): the train judges no failure. The one judgement is the companion's lane and the gate (env-failure.mjs); the train only
// watches for its result. After a required GitHub Actions check fails or stays missing, it waits REQUIRED_RERUN_WINDOW_MS (from the later of
// the check's last attempt ending and the head's admission, which the lane needs before it may re-run): a new attempt of the workflow inside
// it is a re-run in progress; none means the failure is real (the existing failure path, FRONT_RETURNED) or the missing check was not re-run
// (REQUIRED_CHECK_NOT_RERUN). Why 10 minutes: at least two polls of the side that finds and re-runs (the lane looks at the train's front
// first, takes a step a minute and looks at a head again every 2 minutes: 2 x 2 = 4 minutes, plus a step for its five heads a step), and
// the gate's check run of a re-run is created at once. The deadline and the attempt budget above stay the limits.
export const REQUIRED_RERUN_WINDOW_MS = 10 * 60_000;
const ADMISSION_CHECK = 'kooyumi-work-admission';
export const ACTIONS_APP_ID = 15368;
const GATE_JOB = 'admission-gate';
const MAX_REQUIRED_LISTED = 20;

// One required Actions check's attempts on the head: check runs of its job under its own name, its skipped name, or the unevaluated name
// expression a gated job shows when the gate's output is missing (... && 'X' || 'X-skipped'; the convention admission-rerun.mjs#gatedCheckNames
// reads). Every attempt of every run of the workflow leaves one.
function attemptsOf(own, context) {
  const expression = `'${context}' || '${context}-skipped'`;
  return own.filter(c => c.app?.id === ACTIONS_APP_ID && (c.name === context || c.name === `${context}-skipped` || c.name.includes(expression)));
}
const timeOf = v => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
// The workflow run a GitHub Actions check run belongs to, from GitHub's own details_url (.../actions/runs/<run>/job/<job>), or null.
const RUN_OF = /\/actions\/runs\/([1-9][0-9]{0,19})\/job\/[0-9]+/;
const runOf = c => RUN_OF.exec(typeof c?.details_url === 'string' ? c.details_url : '')?.[1] ?? null;

// What main's live rules require that is not success on the head: { missing: [{ context, state, attempts }], reruns, waiting }; state pending
// (queued or running), absent (no check run of that name and App), skipped, failed (any other conclusion, neutral included: the ruling asks for
// success) or unverifiable (an unpinned rule, which a commit status may meet: this train reads check runs only); the newest check run of a
// name counts. reruns: the re-runs GitHub shows for the missing checks (attempts beyond the first, and a gate in flight after an earlier
// attempt); waiting: a missing check is queued or running, or a gate is in flight. null when the rules cannot be read (no rule list, or an
// entry that is not exactly a context with an integration id or none).
export function requiredOnHead({ rules, checks, headSha, appId }) {
  const required = Array.isArray(rules) ? rules.filter(r => plain(r) && r.type === 'required_status_checks') : [];
  if (!required.length || !required.every(r => plain(r.parameters) && Array.isArray(r.parameters.required_status_checks))) return null;
  const own = Array.isArray(checks) ? checks.filter(c => plain(c) && c.head_sha === headSha && typeof c.name === 'string' && Number.isSafeInteger(c.id)) : [];
  const missing = [], seen = new Set();
  for (const r of required) for (const entry of r.parameters.required_status_checks) {
    if (!plain(entry) || typeof entry.context !== 'string' || !(entry.integration_id == null || Number.isSafeInteger(entry.integration_id))) return null;
    const app = entry.integration_id > 0 ? entry.integration_id : null;
    const key = `${entry.context}\n${app}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const latest = app === null ? null : own.filter(c => c.name === entry.context && c.app?.id === app).sort((a, b) => b.id - a.id)[0];
    const state = app === null ? 'unverifiable' : !latest ? 'absent' : latest.status !== 'completed' ? 'pending'
      : latest.conclusion === 'success' ? null : latest.conclusion === 'skipped' ? 'skipped' : 'failed';
    if (!state) continue;
    const tries = app === ACTIONS_APP_ID ? attemptsOf(own, entry.context) : [];
    const ends = tries.map(c => timeOf(c.completed_at)).filter(t => t !== null);
    const runs = [...new Set(tries.map(runOf).filter(r => r !== null))];
    // Review 3 medium 2 and Fable 11-20 补“补跑上限的范围”: attempts per run ID, the newest run of the check (a reopened PR's new run counts
    // from 1): every attempt of a gated run has one gate, so its attempts are its gates (or its own check runs of this job, where more are
    // listed); check runs that name no run count one each.
    const newest = runs.length ? runs.reduce((a, b) => (Number(b) > Number(a) ? b : a)) : null;
    const attempts = newest !== null ? Math.max(gatesOf(own, newest).length, tries.filter(c => runOf(c) === newest).length) : tries.length;
    missing.push({ context: entry.context, state, actions: app === ACTIONS_APP_ID, attempts, lastEndAt: ends.length ? Math.max(...ends) : null,
      runs, lastId: tries.length ? Math.max(...tries.map(c => c.id)) : 0 });
  }
  // Reviews 2 (high 2) and 3 (high 1): a re-run of a missing check is a new attempt of its own workflow run (an earlier attempt of the check
  // names the run): that run's gate is newer than the check's last attempt (GitHub numbers check runs in creation order) and is queued, running
  // or has admitted (its jobs may not be listed yet). A gate of another run, or one that ended without admitting, is not a re-run. A check
  // with no attempt names no run: nothing is tied to it.
  const live = own.filter(c => c.app?.id === ACTIONS_APP_ID && c.name === GATE_JOB && runOf(c) !== null && (c.status !== 'completed' || c.conclusion === 'success'));
  for (const m of missing) {
    m.gateRerun = m.actions && m.state !== 'pending' && live.some(g => m.runs.includes(runOf(g)) && g.id > m.lastId);
    m.rerunning = m.state === 'pending' || m.gateRerun;
  }
  const admitted = own.filter(c => c.app?.id === appId && c.name === ADMISSION_CHECK && c.status === 'completed' && c.conclusion === 'success')
    .map(c => timeOf(c.completed_at)).filter(t => t !== null);
  // The re-runs shown are those of what runs now (review 3 medium 2): one workflow's first run is never shown with another's re-runs.
  const running = missing.filter(m => m.rerunning);
  return { missing, reruns: Math.min(REQUIRED_ATTEMPTS_MAX - 1, Math.max(0, ...(running.length ? running : missing).map(m => m.attempts - 1))),
    waiting: running.length > 0, admittedAt: admitted.length ? Math.max(...admitted) : null };
}
// The gate check runs of one workflow run: one an attempt.
function gatesOf(own, run) { return own.filter(c => c.app?.id === ACTIONS_APP_ID && c.name === GATE_JOB && runOf(c) === run); }

// Whether the observation window of one missing check has passed with no new attempt (A3). It starts at the latest of its last attempt's end,
// the head's admission and floor (review 2 high 1: the later of the claim becoming the front and the merge slot going green, so the companion,
// which finds the front from stage 10's own summary, has a whole window after the head became the front); with none of them it has passed.
export function requiredWindowExpired(required, m, now, floor = null) {
  if (!required || !m || m.rerunning) return false;
  // A failed check whose end GitHub did not record cannot start a window: when in doubt it is a real failure.
  if (m.state === 'failed' && !Number.isFinite(m.lastEndAt)) return true;
  const known = [m.lastEndAt, required.admittedAt, floor].filter(Number.isFinite);
  return !known.length || !Number.isFinite(now) || now - Math.max(...known) >= REQUIRED_RERUN_WINDOW_MS;
}
// The later of the merge slot's green and the claim's front time (the holder's takenAt), or null.
function frontFloor(front, takenAt) {
  const known = [front?.slotGreenAt, timeOf(takenAt)].filter(Number.isFinite);
  return known.length ? Math.max(...known) : null;
}

// Whether a failed required check is excused for now (A3): a GitHub Actions check whose window is still open or whose re-run is in flight.
// The judgement is the lane's and the gate's; until their answer can show, the train does not call the failure real.
export function requiredFailureExcused(front, context, now, takenAt = null) {
  const r = front?.required;
  const m = r?.missing?.find(x => x.context === context && x.actions && x.state === 'failed');
  return !!m && !requiredWindowExpired(r, m, now, frontFloor(front, takenAt));
}

// Why a merge-slot-green front that is not green gives the slot away now (REQUIRED_YIELD_REASONS), or null. fallbackStart: the holder's front
// time (ISO), the clock's start when no check carries a time.
export function requiredYieldReason(front, now, fallbackStart = null) {
  // Review 3 medium 1: the 60 minutes have one start, the merge slot's green (read from the checks, or this node's record of it when they
  // cannot be read); the front time never stands in. Unreadable checks with no record of the green prove no wait: the next round looks again.
  // Review 4 medium 2: with no merge-slot time (a take-over, checks unreadable from the first round, a check without times) the start is when
  // this node first saw the head at the front (recorded in the train store): later than the truth, so never early. Native's merge-slot hard
  // cap (slotHardCapMinutes from the turn's start) ends the turn on its own whatever this start is.
  const start = Number.isFinite(front?.slotGreenAt) ? front.slotGreenAt : front?.frontSeenAt;
  const deadline = Number.isFinite(start) && Number.isFinite(now) && now - start >= REQUIRED_CHECKS_MAX_WAIT_MS;
  if (front?.checksUnreadable === true) return deadline ? 'REQUIRED_CHECKS_DEADLINE' : null;
  if (front?.green !== true) return null;
  // Fable 11-21 应修 1: green always carries its judged required checks (frontPullFacts); none is unreadable rules, bounded by the deadline.
  const r = front.required ?? null;
  if (r !== null && !r.missing.length) return null;
  if (r !== null && r.missing.some(m => !m.rerunning && m.attempts >= REQUIRED_ATTEMPTS_MAX)) return 'REQUIRED_RERUNS_EXHAUSTED';
  if (deadline) return 'REQUIRED_CHECKS_DEADLINE';
  // A3: a missing check (not a failed one: the failure path has that) with no new attempt in its observation window was not re-run.
  const floor = frontFloor(front, fallbackStart);
  return r !== null && r.missing.some(m => m.state !== 'failed' && requiredWindowExpired(r, m, now, floor)) ? 'REQUIRED_CHECK_NOT_RERUN' : null;
}

// The front PR as GitHub reports it now, reduced to what the train decides on. rules: main's live rules (the reply's list, or null when it
// could not be read); route: this round's landing route (train-landing.mjs#landingRoute: github-merge, push or park; a package without
// push is always github-merge). Both are always given.
// Fable 11-21 应修 1: a merge-slot green counts only on the current path (route github-merge), where GitHub merges H: there green is the
// merge slot's success and `required` (requiredOnHead) says what main's rules still need on H. On route push the train lands S itself, and
// on park nothing lands: a merge-slot green on H is what the current path left before the rules changed, never green, and no `required`.
// "Green with no judged required checks" is no state this function can produce.
const FRONT_ROUTES = Object.freeze(['github-merge', 'push', 'park']);
export function frontPullFacts({ pull, mergeCommit, compare, checks, mainSha, appId, slotCheckName = 'kooyumi-merge-slot', rules, route }) {
  if (rules === undefined || !FRONT_ROUTES.includes(route)) fail('FRONT_FACTS_ROUTE_REQUIRED');
  const currentPath = route === 'github-merge';
  const headSha = SHA.test(pull?.head?.sha ?? '') ? pull.head.sha : null;
  const testMerge = mergeCommit && SHA.test(mergeCommit.sha ?? '') ? { sha: mergeCommit.sha, tree: mergeCommit.tree,
    parentsOk: Array.isArray(mergeCommit.parents) && mergeCommit.parents.length === 2 && mergeCommit.parents[0] === mainSha && mergeCommit.parents[1] === headSha } : null;
  const greens = Array.isArray(checks) ? checks.filter(c => c?.app?.id === appId && c.name === slotCheckName && c.head_sha === headSha) : [];
  const latest = greens.sort((a, b) => b.id - a.id)[0] ?? null;
  return { state: pull?.state ?? null, draft: pull?.draft === true, merged: pull?.merged === true, baseRef: pull?.base?.ref ?? null, headSha,
    mergeable: typeof pull?.mergeable === 'boolean' ? pull.mergeable : null, testMerge,
    headContainsMain: compare ? compare.behindBy === 0 && ['ahead', 'identical'].includes(compare.status) : null,
    green: currentPath && !!latest && latest.status === 'completed' && latest.conclusion === 'success',
    ...(currentPath ? { required: requiredOnHead({ rules, checks, headSha, appId }),
      slotGreenAt: [latest?.completed_at, latest?.started_at].map(v => Date.parse(v ?? '')).find(Number.isFinite) ?? null } : {}) };
}

// The decision. front: frontPullFacts or null; holder: the merge-slot holder or null.
export function decideShadow({ onDuty, holders, holder = holders?.[0] ?? null, front, rules, mainSha }) {
  if (!onDuty) return 'NOT_ON_DUTY';
  if (!holders?.length) return 'NO_FRONT';
  if (holders.length > 1) return 'FRONT_AMBIGUOUS';
  if (!holder?.pr) return 'FRONT_NOT_BOUND';
  if (!front || front.state !== 'open' || front.draft || front.baseRef !== 'main' || !front.headSha) return 'FRONT_NOT_RUNNABLE';
  // Review 2 medium 1: with the front's check runs unreadable nothing opens or greens; the front waits, bounded by the longest wait.
  if (front.checksUnreadable === true) return 'FRONT_CHECKS_WAIT';
  if (front.mergeable === false || (rules?.strict === true && front.headContainsMain === false)
    || (front.protectedLayer === true && front.headContainsMain !== true)) return 'FRONT_NEEDS_MAIN_MERGE';
  if (front.green) {
    // green means GitHub will merge: every required check passed, not the merge slot alone (#1192)
    // Fable 11-21 应修 1: no green without judged required checks (frontPullFacts); none judged is a wait, never a merge on the slot alone
    const r = front.required ?? null;
    if (r === null) return 'FRONT_CHECKS_WAIT';
    if (!r.missing.length) return 'FRONT_GREEN_WAIT_MERGE';
    return r.waiting ? 'FRONT_CHECKS_WAIT' : 'FRONT_CHECKS_MISSING';
  }
  if (front.mergeable !== true || !front.testMerge?.parentsOk || !SHA.test(mainSha ?? '')) return 'FRONT_TEST_MERGE_NOT_READY';
  return 'OPEN_FRONT_BATCH';
}

// Ledgered greens that would be revoked: the last phase of each (head, check run) is posted, settled or (merged but its
// head is not in main), the head is not in main, and it is not the front's current head. inMain: head -> true|false|null.
export function wouldRevoke({ entries, inMain, frontHeadSha }) {
  const last = new Map();
  for (const { entry } of entries ?? []) if (entry?.checkRunId) last.set(`${entry.headSha}:${entry.checkRunId}`, entry);
  const out = [];
  for (const e of last.values()) {
    if (e.phase === 'revoked' || e.headSha === frontHeadSha || inMain.get(e.headSha) !== false) continue;
    out.push({ headSha: e.headSha, checkRunId: e.checkRunId, pr: e.pr, phase: e.phase });
  }
  return out.sort((a, b) => a.checkRunId - b.checkRunId);
}

// revoke: the would-revoke (shadow) or revocation targets (on, revoke-only) of this run; decision defaults to wouldDo.
export function trainFacts({ mode, at, onDuty, holders, mainSha, rules, rulesReason = null, appScans = null, front, revoke, ledger, decision = null, openFrontBatch = null,
  sweep = NO_SWEEP, actions = NO_ACTIONS, requestPause = null, nodes = null, nodesDropped = 0, frontBind = null, landing = null }) {
  const holder = holders?.[0] ?? null;
  const wouldDo = decideShadow({ onDuty, holders, holder, front, rules, mainSha });
  const facts = {
    contract: TRAIN_FACTS_CONTRACT, mode, at, onDuty, mainSha: mainSha ?? null,
    rules: rules ? { strict: rules.strict, mergeOnly: rules.mergeOnly, ...(Array.isArray(rules.appScans) ? { appScans: [...rules.appScans] } : {}) } : null, rulesReason,
    // Task 04f9b91b (admission p90): the scans the rules pin to this App (train-rules.mjs#appScansPinned), also when rules is null (the
    // scaffold ruleset alone: []). Absent: not read, every scan runs. The resident reads this one first (train.mjs#trainSummary).
    ...(Array.isArray(appScans) ? { appScans: [...appScans] } : {}),
    holders: holders?.length ?? 0,
    front: holder ? { claimId: holder.claimId, pr: holder.pr, mergeSlotUntil: holder.mergeSlotUntil, takenAt: holder.takenAt, ciState: holder.ciState,
      ...(front ? { headSha: front.headSha, state: front.state, draft: front.draft, mergeable: front.mergeable, headContainsMain: front.headContainsMain, green: front.green,
        testMergeSha: front.testMerge?.sha ?? null, testMergeTree: front.testMerge?.tree ?? null, testMergeParentsOk: front.testMerge?.parentsOk ?? null,
        ...(front.checksUnreadable === true ? { checksUnreadable: true } : {}),
        ...(front.requiredYieldHeld ? { requiredYieldHeld: front.requiredYieldHeld } : {}),
        ...(front.yieldHeadMoved === true ? { yieldHeadMoved: true } : {}),
        ...(Number.isFinite(front.frontSeenAt) ? { frontSeenAt: new Date(front.frontSeenAt).toISOString() } : {}),
        ...(front.required !== undefined ? { required: front.required === null
          ? (front.requiredYieldReason ? { unreadable: true, yieldReason: front.requiredYieldReason } : null)
          : { missing: front.required.missing.slice(0, MAX_REQUIRED_LISTED).map(m => ({ ...m, lastEndAt: m.lastEndAt === null ? null : new Date(m.lastEndAt).toISOString() })),
            missingCount: front.required.missing.length, reruns: front.required.reruns,
            admittedAt: front.required.admittedAt === null ? null : new Date(front.required.admittedAt).toISOString(),
            waiting: front.required.waiting, slotGreenAt: Number.isFinite(front.slotGreenAt) ? new Date(front.slotGreenAt).toISOString() : null,
            ...(front.requiredYieldReason ? { yieldReason: front.requiredYieldReason } : {}) } } : {}) } : {}) } : null,
    wouldDo,
    wouldRevoke: (revoke ?? []).slice(0, MAX_REVOKE_LISTED), wouldRevokeCount: (revoke ?? []).length,
    ledger: { records: ledger?.records ?? 0, refused: ledger?.refused ?? 0, ...(Number.isSafeInteger(ledger?.closed) ? { closed: ledger.closed } : {}) },
    decision: decision ?? wouldDo, openFrontBatch, sweep, actions, requestPause,
    // ci_nodes_status (§41.6): one entry per listed connection; node null (no live node), fields null (never heard).
    nodes: Array.isArray(nodes) ? nodes.slice(0, 64).map(n => ({ node: n.node ?? null, sourceManifestSha256: n.sourceManifestSha256 ?? null, state: n.state ?? null,
      lastHeartbeatAt: n.lastHeartbeatAt ?? null })) : null,
    nodesDropped: Number.isSafeInteger(nodesDropped) && nodesDropped >= 0 ? nodesDropped : 0,
    ...(frontBind ? { frontBind: { pr: frontBind.pr, headSha: frontBind.headSha, claimId: frontBind.claimId } } : {}),
    // resident ADR 0018 (push mode, on only): what was adopted from landed batches, the members GitHub has not marked merged yet, the
    // bisection, or why the landing state could not be read. Informational for the status and the PR page; never authority.
    ...(landing && mode === 'on' ? { landing: structuredClone(landing) } : {}),
  };
  return validateTrainFacts(facts);
}

const count = v => Number.isSafeInteger(v) && v >= 0;
const validSweep = (s, now) => plain(s) && SWEEP_KINDS.includes(s.kind) && typeof s.complete === 'boolean' && ['revoked', 'unconfirmed', 'wouldRevokeCount', 'calls', 'ms'].every(k => count(s[k]))
  && typeof s.proofWritten === 'boolean' && plain(s.fullSweep) && ['none', 'running', 'complete', 'abandoned'].includes(s.fullSweep.state)
  && [s.fullSweep.startedAt, s.fullSweep.completedAt].every(v => v === null || iso(v)) && typeof s.fullSweep.sinceOn === 'boolean'
  && (s.fullSweep.reason === null || (typeof s.fullSweep.reason === 'string' && CODE.test(s.fullSweep.reason)))
  // generation 15 (DESIGN 60): what the round enumerates and why, and why rounds enumerate everything until one of scope 'all' completes
  && [undefined, null, 'all', 'current'].includes(s.fullSweep.scope) && (s.fullSweep.scopeReason == null || (typeof s.fullSweep.scopeReason === 'string' && CODE.test(s.fullSweep.scopeReason)))
  && (s.fullSweep.allPending == null || (typeof s.fullSweep.allPending === 'string' && CODE.test(s.fullSweep.allPending)))
  && (s.strictCoverage === undefined || validStrictReadiness(s.strictCoverage))
  && (s.strictFrontReadiness === undefined || validStrictFrontReadiness(s.strictFrontReadiness))
  && (s.providerBudget === undefined || validTrainProviderBudget(s.providerBudget, now + s.ms))
  && (s.progress === undefined || validSweepProgress(s.progress));
const validActions = a => plain(a) && ['touchedRunning', 'adopted', 'returned', 'failedReported', 'watermarkReported'].every(k => typeof a[k] === 'boolean') && count(a.keptAlive)
  && (a.revokeHead === null || (plain(a.revokeHead) && UUID.test(a.revokeHead.requestId ?? '') && typeof a.revokeHead.done === 'boolean'));
// ADR 0019: a batch of several PRs names its members in merge order, the front first (2..4, distinct PRs and heads, none of them S or T).
const validMembers = (b, m) => m === undefined || (Array.isArray(m) && m.length >= 2 && m.length <= 4
  && m.every(x => plain(x) && Object.keys(x).length === 2 && Number.isSafeInteger(x.pr) && x.pr > 0 && SHA.test(x.headSha ?? '') && x.headSha !== b.testSha && x.headSha !== b.baseSha)
  && m[0].pr === b.pr && m[0].headSha === b.headSha && new Set(m.map(x => x.pr)).size === m.length && new Set(m.map(x => x.headSha)).size === m.length);
const validBatch = b => plain(b) && Number.isSafeInteger(b.pr) && b.pr > 0 && ['headSha', 'baseSha', 'testSha', 'testTree'].every(k => SHA.test(b[k] ?? ''))
  && UUID.test(b.claimId ?? '') && iso(b.since) && [1, 2].includes(b.attempt) && validMembers(b, b.members)
  // headTree (rule 41ab823a, resident DESIGN §75): H's own tree, only for a front of one member.
  && (b.headTree === undefined || (SHA.test(b.headTree) && b.members === undefined))
  // baseInHead (resident DESIGN §75, the review ruling): stage 10's own compare of exactly (T, H) says T is in H; only true, one member only.
  && (b.baseInHead === undefined || (b.baseInHead === true && b.members === undefined));
const validNodes = n => n === null || (Array.isArray(n) && n.length <= 64 && n.every(x => plain(x) && (x.node === null || (typeof x.node === 'string' && x.node.length <= 200))
  && (x.sourceManifestSha256 === null || HEX64.test(x.sourceManifestSha256 ?? '')) && (x.state === null || (typeof x.state === 'string' && x.state.length <= 40))
  && (x.lastHeartbeatAt === null || iso(x.lastHeartbeatAt))));
const validFrontBind = b => plain(b) && Object.keys(b).length === 3 && Number.isSafeInteger(b.pr) && b.pr > 0 && SHA.test(b.headSha ?? '') && UUID.test(b.claimId ?? '');
const BINDING_FIELDS = ['repository','scope','pr','headSha','baseSha','targetBranch','bindingStatus','taskId','claimId','fence','epoch',
  'headAuthorizationId','observedAt','sourceManifestSha256'];
const validBindingObservation = b => {
  if (!plain(b) || Object.keys(b).length !== BINDING_FIELDS.length || !BINDING_FIELDS.every(k => Object.hasOwn(b,k))
    || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(b.repository ?? '') || !/^(?:global|project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(b.scope ?? '')
    || !Number.isSafeInteger(b.pr) || b.pr < 1 || !SHA.test(b.headSha ?? '') || !SHA.test(b.baseSha ?? '') || b.targetBranch !== 'main'
    || !['bound','unbound','no_live_claim','handover_pending','conflict','head_not_authorized'].includes(b.bindingStatus)
    || !iso(b.observedAt) || !HEX64.test(b.sourceManifestSha256 ?? '') || !(b.headAuthorizationId === null || UUID.test(b.headAuthorizationId ?? ''))) return false;
  const task = !['unbound','conflict'].includes(b.bindingStatus), claim = ['bound','handover_pending','head_not_authorized'].includes(b.bindingStatus);
  return (task ? UUID.test(b.taskId ?? '') : b.taskId === null) && (claim ? UUID.test(b.claimId ?? '') && Number.isSafeInteger(b.fence) && b.fence > 0
    && Number.isSafeInteger(b.epoch) && b.epoch > 0 : b.claimId === null && b.fence === null && b.epoch === null);
};
const prList = v => Array.isArray(v) && v.length <= 64 && v.every(n => Number.isSafeInteger(n) && n > 0);
// route / missing (ADR 0018 §2 L2 item 7, Fable 2026-11-20): which way main's rules said this run, and what push still misses.
// Fable 11-21 open points §5: bypass, this App's bypass state of the main and the independent ruleset as stage 10 read them this round
// (train-landing.mjs#landingRoute: BYPASS_STATES, and absent for the independent ruleset).
const validBypass = b => plain(b) && Object.keys(b).sort().join('|') === 'independent|main' && BYPASS_STATES.includes(b.main)
  && (BYPASS_STATES.includes(b.independent) || b.independent === 'absent');
const validLanding = l => plain(l) && Object.keys(l).every(k => ['error', 'mainSha', 'landed', 'adopted', 'notMarkedMerged', 'bisect', 'route', 'missing', 'bypass'].includes(k))
  && (l.route === undefined || ['push', 'github-merge', 'park'].includes(l.route)) && (l.bypass === undefined || validBypass(l.bypass))
  && (l.missing === undefined || validLandingMissing(l.missing))
  && (l.error === undefined || (typeof l.error === 'string' && CODE.test(l.error))) && (l.mainSha === undefined || l.mainSha === null || SHA.test(l.mainSha))
  && (l.landed === undefined || (Array.isArray(l.landed) && l.landed.length <= 20 && l.landed.every(b => plain(b) && SHA.test(b.testSha ?? '') && prList(b.members))))
  && (l.adopted === undefined || prList(l.adopted)) && (l.notMarkedMerged === undefined || prList(l.notMarkedMerged))
  && (l.bisect === undefined || (plain(l.bisect) && prList(l.bisect.failed) && (l.bisect.suspect === null || prList(l.bisect.suspect))));
// R3 lean: the rules' optional appScans (train-rules.mjs#rulesetFacts): the scans this App must still publish, RULE_SCAN_NAMES order, each once.
const validAppScans = v => Array.isArray(v) && v.length <= RULE_SCAN_NAMES.length && v.every(n => RULE_SCAN_NAMES.includes(n))
  && v.every((n, i) => i === 0 || RULE_SCAN_NAMES.indexOf(v[i - 1]) < RULE_SCAN_NAMES.indexOf(n));
const validRules = r => r === null || (plain(r) && typeof r.strict === 'boolean' && typeof r.mergeOnly === 'boolean'
  && Object.keys(r).every(k => ['strict', 'mergeOnly', 'appScans'].includes(k)) && (r.appScans === undefined || validAppScans(r.appScans)));
const quiet = f => f.openFrontBatch === null && f.requestPause === null && f.sweep.revoked === 0 && f.sweep.unconfirmed === 0 && !f.sweep.proofWritten
  && Object.entries(NO_ACTIONS).every(([k, v]) => f.actions[k] === v);

// Bounded shape check, shared by the entry (before writing) and stage-inputs (the outcome's train block). Shadow writes
// nothing (no front batch, no action, no revocation, no proof); a front batch only in on and only as OPEN_FRONT_BATCH.
export function validateTrainFacts(f) {
  if (!plain(f) || f.contract !== TRAIN_FACTS_CONTRACT || !TRAIN_MODES.includes(f.mode) || !iso(f.at) || typeof f.onDuty !== 'boolean'
    || !(f.mainSha === null || SHA.test(f.mainSha)) || !WOULD_DO.includes(f.wouldDo) || !Number.isSafeInteger(f.holders) || f.holders < 0
    || !validRules(f.rules) || !(f.appScans === undefined || validAppScans(f.appScans))
    || !(f.rulesReason === null || (typeof f.rulesReason === 'string' && CODE.test(f.rulesReason)))
    || !(f.front === null || (plain(f.front) && UUID.test(f.front.claimId ?? '') && (f.front.pr === null || Number.isSafeInteger(f.front.pr))))
    || !Array.isArray(f.wouldRevoke) || f.wouldRevoke.length > MAX_REVOKE_LISTED
    || !f.wouldRevoke.every(r => plain(r) && SHA.test(r.headSha ?? '') && Number.isSafeInteger(r.checkRunId) && r.checkRunId > 0)
    || !Number.isSafeInteger(f.wouldRevokeCount) || !plain(f.ledger)
    || !DECISIONS.includes(f.decision) || !validSweep(f.sweep, Date.parse(f.at)) || !validActions(f.actions) || !validNodes(f.nodes) || !count(f.nodesDropped)
    || !(f.requestPause === null || (REQUEST_PAUSE_CODES.includes(f.requestPause) && f.decision === f.requestPause && f.mode === 'on'))
    || !(f.openFrontBatch === null || (f.mode === 'on' && validBatch(f.openFrontBatch)))
    || (f.mode === 'on' && (f.decision === 'OPEN_FRONT_BATCH') !== (f.openFrontBatch !== null))
    || !(f.frontBind === undefined || (f.mode === 'on' && f.decision === 'TRAIN_TAKEOVER_SWEEP_PENDING' && f.wouldDo === 'FRONT_NOT_BOUND' && validFrontBind(f.frontBind)
      && f.front?.pr === null && f.front.claimId === f.frontBind.claimId))
    || !(f.landing === undefined || (f.mode === 'on' && validLanding(f.landing)))
    || !(f.claimBindings === undefined || (Array.isArray(f.claimBindings) && f.claimBindings.length <= 50 && f.claimBindings.every(validBindingObservation)
      && new Set(f.claimBindings.map(b => b.pr)).size === f.claimBindings.length
      && new Set(f.claimBindings.map(b => JSON.stringify([b.repository,b.scope,b.sourceManifestSha256]))).size <= 1))
    || (f.mode === 'shadow' && (!quiet(f) || f.decision !== f.wouldDo))
    || (f.mode === 'revoke-only' && (f.openFrontBatch !== null || f.actions.touchedRunning || f.actions.adopted || f.actions.returned || f.actions.failedReported || f.actions.keptAlive > 0))
    || JSON.stringify(f).length > MAX_TRAIN_FACTS_BYTES) fail('invalid_train_facts');
  return f;
}
