// The circuit breaker of the resident executor (resident quota redesign phase 2, step 1: design v0.5 §4.6; v0.6 §1, §4,
// §9 phase 2 items 6 and 7). Pure: the state lives in the run queue's file (queue.mjs), the executor feeds it one event
// per batch end and asks it before every batch start.
//
//   - Counted: an ending whose failure-table row says breaker: counts (environment, transient, unmapped stage-1 and
//     unknown codes). neutral rows never count.
//   - Opens on policy.breaker.consecutive counted failures in a row (an ending that got past the place of the last
//     counted failure, or a completed batch, breaks the row), or policy.breaker.windowCount counted failures within
//     policy.breaker.windowMs.
//   - Open: nothing starts until the next trial (policy.breaker.backoffMs: 30, 60, 120 minutes, then every 120; it never
//     locks for good). Then half-open: one batch at a time is a trial, and a trial never picks the rows that just failed
//     (when there is another candidate).
//   - Closes when a trial completes, or gets past the place that failed, or ends THERE with a neutral ending (for a
//     stage-1 fault: KooYomi answered, also with an explicit refusal). An ending that touched only Windows (stage 8 on
//     its own, a later step) closes only a breaker whose failing place was Windows-only too (design v0.5 §4.6, m3).
//   - A trial that fails counted opens it again with the next delay. Any other ending (neutral before the failing place,
//     a release, an ignore) is inconclusive: the breaker stays half-open and the next candidate is the next trial.
//   - A failure after stage 1 still burns its head, trial or not (v0.6 §9 phase 2 item 7).
//   - Generation 10 (DESIGN 53.4, Task 125a5162 item 4), only with a policy that names breaker.network (contract /9): a breaker that
//     every opening failure says was the network (NETWORK_FAULT_CODES: GitHub, Native or the bundle unreachable) has the cause
//     'network' and the delays breaker.network.backoffMs (first 10 minutes); a trial that fails with a network code again reopens it at
//     the SAME level (one outage is one cause: its failures never stack the delay), any other failure at the next level as before (and
//     the cause is no longer network); breaker.network.earlyTrialProbes read-only probes in a row that reached the outside (the role
//     probe, stage 10's run) after it opened bring its trial forward to now (breakerProbe; a failed probe starts the count again). The
//     Owner's release (breakerRelease, rearm-resident.ps1 -Request ReleaseBreaker, with a reason, in the receipts) brings the trial of
//     any open breaker forward to now, whatever the policy. Neither one closes it: the trial still has to get past the failing place.
import { check } from './canonical.mjs';

export const BREAKER_STATES = Object.freeze(['closed', 'open', 'half-open']);
// The place of a batch ending, in the order a batch runs: the bundle, stage 1, stage R, the workspace preparation, the
// six role stages and stage 8. END: the batch completed.
export const POSITIONS = Object.freeze({ bundle: 1, 1: 2, 9: 3, workspace: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 10, 8: 11, END: 12 });
// Places that touch Linux (the workspace preparation and the three scanner executions); every other one is Windows-only.
export const LINUX_POSITIONS = Object.freeze([POSITIONS.workspace, POSITIONS[2], POSITIONS[4], POSITIONS[6]]);
const FAILURES_KEPT = 16;
// The endings that mean "the outside could not be reached" (generation 10): the bundle (GitHub), GitHub or Native unreadable at stage 1,
// and stage 1's own check withdrawn because it could not be verified.
export const NETWORK_FAULT_CODES = Object.freeze(['BUNDLE_UNAVAILABLE', 'GITHUB_TRANSIENT_UNAVAILABLE', 'NATIVE_ADMISSION_UNAVAILABLE', 'ADMISSION_VERIFICATION_UNAVAILABLE']);
export const NETWORK_CAUSE = 'network';
const networkOf = policy => policy?.breaker?.network ?? null;
const networkCode = code => NETWORK_FAULT_CODES.includes(code);

// stage 0 is the bundle (phase bundle) or the workspace preparation (phase workspace).
export function positionOf(stage, phase = 'stage') {
  if (stage === 0) return phase === 'bundle' ? POSITIONS.bundle : POSITIONS.workspace;
  const p = POSITIONS[stage];
  check(Number.isSafeInteger(p), 'BREAKER_STAGE_INVALID', stage);
  return p;
}

export const closedBreaker = () => ({ state: 'closed', failures: [], streak: 0, streakPos: 0, streakPrs: [], streakFails: [], openedAt: null, level: 0, nextTrialAt: null,
  failingPos: null, failingWindowsOnly: null, exclude: [], closedAt: null, cause: null, probeOks: 0 });

const valid = b => b && BREAKER_STATES.includes(b.state) && Array.isArray(b.failures) && Array.isArray(b.exclude) && Array.isArray(b.streakPrs) && Number.isSafeInteger(b.level);
export const breakerOf = stored => (valid(stored) ? stored : closedBreaker());

// Before a batch starts: { allow, trial, exclude, until }. Moves an open breaker whose trial time came to half-open.
export function breakerGate(b, now) {
  if (b.state === 'closed') return { allow: true, trial: false, exclude: [], until: null };
  if (b.state === 'open' && now < b.nextTrialAt) return { allow: false, trial: false, exclude: b.exclude, until: b.nextTrialAt };
  b.state = 'half-open';
  return { allow: true, trial: true, exclude: b.exclude, until: null };
}

// pos / windowsOnly: the furthest place among the failures that opened it (a trial must get past every one of them), and
// whether all of them were Windows-only (independent review of step 1, m3).
// cause: NETWORK_CAUSE (generation 10: the network delays of a /9 policy) or null (the policy's own delays, as before).
const open = (b, policy, now, { pos, windowsOnly, prs, level, cause = null }) => {
  const delays = cause === NETWORK_CAUSE && networkOf(policy) ? networkOf(policy).backoffMs : policy.breaker.backoffMs;
  const reopening = b.state !== 'closed';
  Object.assign(b, { state: 'open', openedAt: reopening ? (b.openedAt ?? now) : now, level, nextTrialAt: now + delays[Math.min(level, delays.length - 1)], cause, probeOks: 0,
    failingPos: reopening ? Math.max(b.failingPos ?? pos, pos) : pos,
    failingWindowsOnly: reopening ? (b.failingWindowsOnly === true && windowsOnly === true) : windowsOnly === true,
    exclude: [...new Set([...b.exclude, ...prs])].slice(-FAILURES_KEPT) });
};

// One batch ending. ev: { pos (where it ended: positionOf, or POSITIONS.END), completed, counts, neutral, windowsOnly, pr,
// code }. Returns the transition: 'opened', 'reopened', 'closed' or null. A trial that closes the breaker and fails
// counted later in the same batch closes it first, then counts that failure (it got past the failing place).
export function breakerRecord(b, ev, policy, now) {
  check(Number.isSafeInteger(ev?.pos) && ev.pos >= POSITIONS.bundle && ev.pos <= POSITIONS.END, 'BREAKER_EVENT_INVALID');
  let transition = null;
  if (b.state === 'half-open' || b.state === 'open') {
    const linuxFailing = b.failingWindowsOnly === false;
    const passed = ev.completed === true || ev.pos > b.failingPos || (ev.pos === b.failingPos && ev.neutral === true);
    if (passed && !(ev.windowsOnly === true && linuxFailing)) {
      Object.assign(b, closedBreaker(), { closedAt: now });
      transition = 'closed';
    } else if (ev.counts === true) {
      // Generation 10: the same network outage failing the trial again keeps its level (and its cause); anything else escalates.
      const same = b.cause === NETWORK_CAUSE && networkCode(ev.code) && networkOf(policy) !== null;
      open(b, policy, now, { pos: ev.pos, windowsOnly: ev.windowsOnly, prs: [ev.pr], level: same ? b.level : b.level + 1, cause: same ? NETWORK_CAUSE : null });
      b.failures = [...b.failures, { at: now, pos: ev.pos, pr: ev.pr, code: ev.code ?? null }].slice(-FAILURES_KEPT);
      return 'reopened';
    } else {
      return null; // inconclusive: still half-open
    }
  }
  // closed
  if (ev.completed === true || (ev.counts !== true && ev.pos > b.streakPos)) { b.streak = 0; b.streakPos = 0; b.streakPrs = []; b.streakFails = []; }
  if (ev.counts !== true) return transition;
  b.failures = [...b.failures.filter(f => now - f.at < policy.breaker.windowMs), { at: now, pos: ev.pos, pr: ev.pr, code: ev.code ?? null, windowsOnly: ev.windowsOnly === true }].slice(-FAILURES_KEPT);
  b.streak += 1;
  b.streakPos = ev.pos;
  b.streakPrs = [...b.streakPrs, ev.pr].slice(-FAILURES_KEPT);
  b.streakFails = [...(b.streakFails ?? []), { pos: ev.pos, windowsOnly: ev.windowsOnly === true, code: ev.code ?? null }].slice(-FAILURES_KEPT);
  const inWindow = b.failures.filter(f => now - f.at < policy.breaker.windowMs);
  if (b.streak >= policy.breaker.consecutive || inWindow.length >= policy.breaker.windowCount) {
    const opening = b.streak >= policy.breaker.consecutive ? b.streakFails : inWindow;
    const prs = [...new Set([...b.streakPrs, ...inWindow.map(f => f.pr)])];
    b.exclude = [];
    const cause = networkOf(policy) !== null && opening.every(f => networkCode(f.code)) ? NETWORK_CAUSE : null;
    open(b, policy, now, { pos: Math.max(...opening.map(f => f.pos)), windowsOnly: opening.every(f => f.windowsOnly === true), prs, level: 0, cause });
    return 'opened';
  }
  return transition;
}

// Generation 10: one read-only probe that ran while the breaker is open (ok: it reached the outside and answered). Only an open breaker
// of cause network under a /9 policy listens. Returns 'early-trial' when this probe completed the run of breaker.network.earlyTrialProbes
// and the trial was still ahead (it is due now), else null.
export function breakerProbe(b, ok, policy, now) {
  const n = networkOf(policy);
  if (!n || b.state !== 'open' || b.cause !== NETWORK_CAUSE) return null;
  if (ok !== true) { b.probeOks = 0; return null; }
  b.probeOks = (Number.isSafeInteger(b.probeOks) ? b.probeOks : 0) + 1;
  if (b.probeOks < n.earlyTrialProbes || !(now < b.nextTrialAt)) return null;
  b.nextTrialAt = now;
  b.probeOks = 0;
  return 'early-trial';
}

// Generation 10: the Owner's release of an open breaker (any cause, any policy): its trial is due now. It never closes the breaker
// and never touches a half-open or closed one (BREAKER_NOT_OPEN). Returns what the receipt records.
export function breakerRelease(b, now) {
  if (b.state !== 'open') return { released: false, code: 'BREAKER_NOT_OPEN', state: b.state };
  const previousNextTrialAt = b.nextTrialAt;
  if (now < b.nextTrialAt) b.nextTrialAt = now;
  b.probeOks = 0;
  return { released: true, code: null, state: b.state, previousNextTrialAt, level: b.level, cause: b.cause ?? null, openedAt: b.openedAt };
}

// The status board's view.
export const breakerView = b => ({ state: b.state, openedAt: b.openedAt, nextTrialAt: b.state === 'open' ? b.nextTrialAt : null, level: b.level,
  failingPos: b.failingPos, recent: b.failures.length, streak: b.streak, cause: b.cause === NETWORK_CAUSE ? NETWORK_CAUSE : null });
