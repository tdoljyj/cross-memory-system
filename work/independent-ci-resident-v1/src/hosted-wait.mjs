// Hosted-execution wait and timeout state machine (free-minutes design §7.2, §7.3).
// Pure: no I/O, no clock of its own. Hints come from the companion and are UNTRUSTED data used only
// for scheduling: a hint can make the batch relay less (more local work), never more. The only
// verdict that publishes anything is the relay helper's own attestation in stage R.
import { CODE, check, fail, parseBoundedJson, exactKeys } from './canonical.mjs';

export const HINT_CONTRACT = 'clued.independent-ci.hosted-hint/1';
export const HINT_MAX_BYTES = 2048;
export const RELAY_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const HINT_STATES = Object.freeze(['ABSENT', 'PENDING_QUEUED', 'PENDING_RUNNING', 'SUCCESS', 'HOSTED_NOT_SUCCESS', 'BILLING_REFUSED', 'NOT_ELIGIBLE']);
const TERMINAL = new Set(['SUCCESS', 'HOSTED_NOT_SUCCESS', 'NOT_ELIGIBLE']);
const MINUTE = 60_000;

// Defaults from §7.2; job timeouts are the workflows' timeout-minutes (gitleaks/trivy 25, placement 5).
export const DEFAULT_WAIT = Object.freeze({
  signalMs: 10 * MINUTE, queueMs: 15 * MINUTE, runSlackMs: 10 * MINUTE, totalMs: 60 * MINUTE,
  jobTimeoutMs: Object.freeze({ gitleaks: 25 * MINUTE, trivy: 25 * MINUTE, 'contract-placement': 5 * MINUTE }),
});

const isTime = v => Number.isSafeInteger(v) && v > 0;

// Parse one companion hint record. Anything malformed for a role degrades that role to NOT_ELIGIBLE.
export function parseHint(bytes, subject) {
  const h = parseBoundedJson(bytes, HINT_MAX_BYTES, 'HOSTED_HINT_REFUSED');
  exactKeys(h, ['contract', 'repo', 'pr', 'headSha', 'observedAt', 'roles'], 'HOSTED_HINT_REFUSED');
  check(h.contract === HINT_CONTRACT, 'HOSTED_HINT_REFUSED', 'contract');
  check(h.repo === subject.repo && h.pr === subject.pr && h.headSha === subject.headSha, 'HOSTED_HINT_SUBJECT_MISMATCH');
  check(isTime(h.observedAt), 'HOSTED_HINT_REFUSED', 'observedAt');
  check(h.roles !== null && typeof h.roles === 'object' && !Array.isArray(h.roles), 'HOSTED_HINT_REFUSED', 'roles');
  const roles = {};
  for (const role of RELAY_ROLES) roles[role] = normaliseRole(h.roles[role]);
  for (const k of Object.keys(h.roles)) check(RELAY_ROLES.includes(k), 'HOSTED_HINT_REFUSED', 'role');
  return { observedAt: h.observedAt, roles };
}

function normaliseRole(r) {
  if (r === undefined) return { state: 'ABSENT' };
  if (r === null || typeof r !== 'object' || Array.isArray(r) || !HINT_STATES.includes(r.state)) return { state: 'NOT_ELIGIBLE', reason: 'HINT_MALFORMED' };
  const out = { state: r.state };
  if (r.state === 'PENDING_QUEUED') { if (!isTime(r.queuedAt)) return { state: 'NOT_ELIGIBLE', reason: 'HINT_MALFORMED' }; out.queuedAt = r.queuedAt; }
  if (r.state === 'PENDING_RUNNING') { if (!isTime(r.startedAt)) return { state: 'NOT_ELIGIBLE', reason: 'HINT_MALFORMED' }; out.startedAt = r.startedAt; }
  if ((r.state === 'NOT_ELIGIBLE' || r.state === 'HOSTED_NOT_SUCCESS') && typeof r.reason === 'string' && CODE.test(r.reason)) out.reason = r.reason;
  return out;
}

function waitConfig(relay) {
  const w = { ...DEFAULT_WAIT, ...(relay?.wait ?? {}) };
  for (const k of ['signalMs', 'queueMs', 'runSlackMs', 'totalMs']) check(isTime(w[k]), 'RELAY_WAIT_POLICY_INVALID', k);
  const jt = { ...DEFAULT_WAIT.jobTimeoutMs, ...(relay?.wait?.jobTimeoutMs ?? {}) };
  for (const role of RELAY_ROLES) check(isTime(jt[role]), 'RELAY_WAIT_POLICY_INVALID', role);
  return { ...w, jobTimeoutMs: jt };
}

// Decide what the executor does now for one trigger.
//   relay: policy.relay ({enabled, roles?, wait?}); t0: first time the executor read this trigger;
//   now: current clock; hint: parseHint() result or null (no hint yet).
// Returns { action: 'WAIT', until, reason } or { action: 'START', relayCandidates, local, reason }.
export function decide({ relay, t0, now, hint }) {
  check(isTime(t0) && isTime(now) && now >= t0, 'RELAY_WAIT_CLOCK_INVALID');
  const allLocal = reason => ({ action: 'START', relayCandidates: [], local: [...RELAY_ROLES], reason });
  if (!relay || relay.enabled !== true) return allLocal('RELAY_DISABLED');
  const enabledRoles = (relay.roles ?? RELAY_ROLES);
  check(Array.isArray(enabledRoles) && enabledRoles.every(r => RELAY_ROLES.includes(r)), 'RELAY_WAIT_POLICY_INVALID', 'roles');
  const w = waitConfig(relay);
  const roles = hint?.roles ?? Object.fromEntries(RELAY_ROLES.map(r => [r, { state: 'ABSENT' }]));
  if (RELAY_ROLES.some(r => roles[r].state === 'BILLING_REFUSED')) return allLocal('RELAY_BILLING_REFUSED');
  const candidates = enabledRoles.filter(r => roles[r].state !== 'NOT_ELIGIBLE' && roles[r].state !== 'HOSTED_NOT_SUCCESS');
  if (candidates.length === 0) return allLocal('RELAY_NO_ELIGIBLE_ROLE');
  const hardStop = t0 + w.totalMs;
  const deadlines = [];
  for (const role of candidates) {
    const s = roles[role];
    if (TERMINAL.has(s.state)) continue;
    let until;
    if (s.state === 'ABSENT') until = t0 + w.signalMs;
    else if (s.state === 'PENDING_QUEUED') until = s.queuedAt + w.queueMs;
    else if (s.state === 'PENDING_RUNNING') until = s.startedAt + w.jobTimeoutMs[role] + w.runSlackMs;
    else fail('RELAY_WAIT_STATE_UNKNOWN', s.state);
    if (now < Math.min(until, hardStop)) deadlines.push(Math.min(until, hardStop));
  }
  if (deadlines.length > 0 && now < hardStop) return { action: 'WAIT', until: Math.min(...deadlines), reason: 'RELAY_WAITING_FOR_HOSTED' };
  // Start now. Relay is attempted only for roles whose hint says SUCCESS; everything else runs locally.
  // (Stage R still verifies each candidate independently and may send it back to LOCAL_REQUIRED.)
  const relayCandidates = candidates.filter(r => roles[r].state === 'SUCCESS');
  const local = RELAY_ROLES.filter(r => !relayCandidates.includes(r));
  const reason = now >= hardStop ? 'RELAY_TOTAL_WAIT_REACHED' : (relayCandidates.length === RELAY_ROLES.length ? 'RELAY_ALL_HOSTED_SUCCESS' : 'RELAY_PARTIAL_OR_TIMED_OUT');
  return { action: 'START', relayCandidates, local, reason };
}
