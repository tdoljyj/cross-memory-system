// Hosted-execution wait and timeout state machine (free-minutes design §7.2, §7.3).
// Pure: no I/O, no clock of its own. Hints come from the companion and are UNTRUSTED data used only
// for scheduling only. Owner once-per-head rule 41ab823a supersedes the older
// timeout/local-fallback design: a hint or deadline can never transfer a hosted
// scan to Native. Only stage R's fresh protected attestation can publish.
//
// Relayable roles are exactly those of the installed relay registry (hosted-relay-v1/registry.mjs
// RELAYABLE_ROLES: gitleaks, trivy). contract-placement is a heavy role that is never relayed (its hosted
// job runs PR code while it holds id-token: write), so it is always local and never waited for.
import { CODE, check, fail, parseBoundedJson, exactKeys } from './canonical.mjs';

export const HINT_CONTRACT = 'clued.independent-ci.hosted-hint/1';
export const HINT_MAX_BYTES = 2048;
export const RELAY_ROLES = Object.freeze(['gitleaks', 'trivy']);
export const HEAVY_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const HINT_STATES = Object.freeze(['ABSENT', 'PENDING_QUEUED', 'PENDING_RUNNING', 'SUCCESS', 'HOSTED_NOT_SUCCESS', 'BILLING_REFUSED', 'NOT_ELIGIBLE']);
// Legacy receipt vocabulary remains readable. The enabled route below never
// emits these historical failure/timeout reasons as Native scan authority.
export const SCHEDULING_REASONS = Object.freeze(['RELAY_DISABLED', 'RELAY_ROLE_NOT_RELAYABLE', 'RELAY_HINT_BILLING_REFUSED', 'RELAY_HINT_NOT_ELIGIBLE',
  'RELAY_HINT_HOSTED_NOT_SUCCESS', 'RELAY_WAIT_TIMED_OUT']);
const MINUTE = 60_000;

// Deadlines change the reason for a hold, never the scan provider. Job timeout
// values remain the registry's hosted job timeout-minutes (gitleaks/trivy 25).
export const DEFAULT_WAIT = Object.freeze({
  signalMs: 10 * MINUTE, queueMs: 15 * MINUTE, runSlackMs: 10 * MINUTE, totalMs: 60 * MINUTE, pollMs: MINUTE,
  jobTimeoutMs: Object.freeze({ gitleaks: 25 * MINUTE, trivy: 25 * MINUTE }),
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
  for (const k of Object.keys(h.roles)) check(RELAY_ROLES.includes(k), 'HOSTED_HINT_REFUSED', 'role');
  const roles = {};
  for (const role of RELAY_ROLES) roles[role] = normaliseRole(h.roles[role]);
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

// The wait knobs of policy.relay.wait (exact keys are checked by policy.mjs); defaults for a partial object.
export function waitConfig(relay) {
  const w = { ...DEFAULT_WAIT, ...(relay?.wait ?? {}) };
  for (const k of ['signalMs', 'queueMs', 'runSlackMs', 'totalMs', 'pollMs']) check(isTime(w[k]), 'RELAY_WAIT_POLICY_INVALID', k);
  const jt = { ...DEFAULT_WAIT.jobTimeoutMs, ...(relay?.wait?.jobTimeoutMs ?? {}) };
  for (const role of RELAY_ROLES) check(isTime(jt[role]), 'RELAY_WAIT_POLICY_INVALID', role);
  return { ...w, jobTimeoutMs: jt };
}

// Decide what the executor does now for one batch (after stage 1, design order of PR-A).
//   relay: policy.relay ({enabled, roles?, wait?}); t0: when the executor first read the trigger
//   (its reservation); now: current clock; hint: parseHint() result or null (no hint yet).
// Returns { action: 'WAIT', until, reason } or
//         { action: 'START', relayCandidates, local, reasons: {role: reason for every local role}, reason }.
export function decide({ relay, t0, now, hint }) {
  check(isTime(t0) && isTime(now) && now >= t0, 'RELAY_WAIT_CLOCK_INVALID');
  const start = (relayCandidates, reasons, reason) => ({ action: 'START', relayCandidates, local: HEAVY_ROLES.filter(r => !relayCandidates.includes(r)),
    reasons: Object.fromEntries(HEAVY_ROLES.filter(r => !relayCandidates.includes(r)).map(r => [r, reasons[r] ?? 'RELAY_ROLE_NOT_RELAYABLE'])), reason });
  const allLocal = (reason, perRole) => start([], Object.fromEntries(RELAY_ROLES.map(r => [r, perRole])), reason);
  if (!relay || relay.enabled !== true) return { ...allLocal('RELAY_DISABLED', 'RELAY_DISABLED'), reasons: Object.fromEntries(HEAVY_ROLES.map(r => [r, 'RELAY_DISABLED'])) };
  const enabledRoles = (relay.roles ?? RELAY_ROLES);
  check(Array.isArray(enabledRoles) && enabledRoles.every(r => RELAY_ROLES.includes(r)), 'RELAY_WAIT_POLICY_INVALID', 'roles');
  const w = waitConfig(relay);
  const wait = reason => ({ action: 'WAIT', until: now + w.pollMs, reason });
  if (enabledRoles.length !== RELAY_ROLES.length || new Set(enabledRoles).size !== RELAY_ROLES.length)
    return wait('RELAY_HOSTED_ROLE_SET_INCOMPLETE');
  const roles = Object.fromEntries(RELAY_ROLES.map(r => [r, normaliseRole(hint?.roles?.[r])]));
  if (RELAY_ROLES.every(r => roles[r].state === 'SUCCESS'))
    return start([...RELAY_ROLES], {}, 'RELAY_ALL_HOSTED_SUCCESS');
  // Failure, billing, ineligibility and unknown/missing evidence establish no
  // right to scan elsewhere. No provider-transfer mechanism is implemented here.
  if (RELAY_ROLES.some(r => ['BILLING_REFUSED', 'NOT_ELIGIBLE', 'HOSTED_NOT_SUCCESS'].includes(roles[r].state)))
    return wait('RELAY_PROVIDER_TRANSFER_REQUIRED');
  const hardStop = t0 + w.totalMs;
  const deadlines = [];
  let expired = now >= hardStop;
  for (const role of RELAY_ROLES) {
    const s = roles[role];
    if (s.state === 'SUCCESS') continue;
    let until;
    if (s.state === 'ABSENT') until = t0 + w.signalMs;
    else if (s.state === 'PENDING_QUEUED') until = s.queuedAt + w.queueMs;
    else if (s.state === 'PENDING_RUNNING') until = s.startedAt + w.jobTimeoutMs[role] + w.runSlackMs;
    else fail('RELAY_WAIT_STATE_UNKNOWN', s.state);
    if (now < Math.min(until, hardStop)) deadlines.push(Math.min(until, hardStop));
    else expired = true;
  }
  return expired ? wait('RELAY_PROVIDER_TRANSFER_REQUIRED')
    : { action: 'WAIT', until: Math.min(...deadlines), reason: 'RELAY_WAITING_FOR_HOSTED' };
}
