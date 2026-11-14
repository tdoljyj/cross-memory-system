// The merge train on the resident side (quota redesign phase 2, step 3c-1; design v0.5 §5.5 "运行时机", §4.3, §4.7;
// DESIGN §22.3; Owner decision 2eea28a1). Pure: when stage 10 is due, and what of its facts the status snapshot and
// the PR page show. In shadow mode nothing here changes what the executor runs or publishes.
//
// Routine stage 10 is due when train.enabled is not 'off', no batch is running, the last run is at least
// train.maintenanceEveryMs ago and fewer than train.maintenanceMaxPerDay ran in the last 24 hours. Urgent refreshes and
// bounded idle-progress extras may run earlier; both pay the unchanged rolling total cap (trainIdleExtraDue). In step 3c-1 the
// executor also holds it under PAUSE and an intake pause (its PAUSE stops everything but reading triggers); design §4.3
// lets a pause stop only new greens, which step 3c-2 takes up with the sweeps that must run during one. A run counts
// whatever its ending. A clean failure (cleanup proven, no side effect, a clean ending) is tried again at the next due
// time and never feeds the breaker; any other ending HALTs, like any stage (executor.mjs#trainMaintenance).
//
// Step 3c-2b (DESIGN §41.3-41.7; policy /8): the run mode is 'shadow' (every node, reading only), 'on' (ACTIVE only) or
// 'revoke-only' (ACTIVE only, under PAUSE while on; never under HALT); trainRunMode decides it. Train facts /2 add the
// decision, the sweep, what was done, a PAUSE request and the one source of a front batch's S (openFrontBatch); in on and
// revoke-only a run with side effects is a normal ending. A run is due at once (urgent) when the node just became eligible
// for on-mode duty (the take-over sweep comes before any batch).
import { fail } from './canonical.mjs';

export const TRAIN_FACTS_CONTRACT = 'clued.independent-ci.train-facts/1';
export const TRAIN_FACTS_CONTRACT_V2 = 'clued.independent-ci.train-facts/2';
export const WOULD_DO = Object.freeze(['NOT_ON_DUTY', 'NO_FRONT', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND', 'FRONT_NOT_RUNNABLE', 'FRONT_NEEDS_MAIN_MERGE',
  'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']);
export const RUN_MODES = Object.freeze(['shadow', 'on', 'revoke-only']);
export const DECISIONS = Object.freeze([...WOULD_DO, 'TRAIN_REVOKE_UNCONFIRMED', 'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH',
  'TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_FRONT_BUDGET_SHORT', 'TRAIN_FRONT_ATTEMPTS_USED', 'FRONT_ADOPTED', 'FRONT_RETURNED', 'FRONT_FAILED_REPORTED', 'REVOKE_ONLY_DONE',
  'TRAIN_SOURCE_UNREADABLE', 'TRAIN_FRONT_BATCH_RUNNING', 'TRAIN_STRICT_OFF', 'TRAIN_FRONT_NOT_PROVEN']);
// Stage 10's decisions after which the executor starts no new batch (DESIGN §41.6: no publication of any stage before the
// take-over sweep; no on-mode duty while another node runs another Source, or while the nodes' Sources cannot be read).
export const TRAIN_SCHEDULE_DEFERRALS = Object.freeze(['TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH', 'TRAIN_SOURCE_UNREADABLE']);
// The decisions the Owner hears of (a notice, one per key).
// DESIGN §65: TRAIN_STRICT_OFF, strict read off in strict-permanent mode (sweep audit or off): PAUSE and an Owner notice.
export const TRAIN_OWNER_NOTICE_DECISIONS = Object.freeze(['TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_SOURCE_MISMATCH', 'TRAIN_STRICT_OFF']);
export const REQUEST_PAUSE_CODES = Object.freeze(['TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_STRICT_OFF']);
export const TRAIN_RUN_SWEEPS = Object.freeze(['gate', 'audit', 'off']);
// Front batches per head (DESIGN §41.4: attempt 2 and both kinds of re-open count).
export const FRONT_BATCHES_PER_HEAD = 2;
const SWEEP_KINDS = ['none', 'incremental', 'full-segment'];
const FULL_STATES = ['none', 'running', 'complete', 'abandoned'];
const FULL_SCOPES = ['all', 'current']; // generation 15 (DESIGN 60)
const SWEEP_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const codeOrNull = v => (typeof v === 'string' && SWEEP_CODE.test(v) ? v : null);
const DAY = 24 * 3600_000;
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CLAIM = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[A-Za-z0-9_-]{1,80}$/;
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const isoOrNull = v => (typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const isoExact = v => isoOrNull(v) !== null && new Date(Date.parse(v)).toISOString() === v;
const CLAIM_BINDING_FIELDS = ['repository','scope','pr','headSha','baseSha','targetBranch','bindingStatus','taskId','claimId','fence','epoch',
  'headAuthorizationId','observedAt','sourceManifestSha256'];
// Protected stage-10 data is still advisory. Keep its exact subject and stable
// generation; a lease renewal alone must never trigger another evaluation.
export function claimBindingObservationOf(b) {
  if (!exact(b, CLAIM_BINDING_FIELDS) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(b.repository ?? '')
    || !/^(?:global|project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(b.scope ?? '') || !Number.isSafeInteger(b.pr) || b.pr < 1
    || !SHA.test(b.headSha ?? '') || !SHA.test(b.baseSha ?? '') || b.targetBranch !== 'main'
    || !['bound','unbound','no_live_claim','handover_pending','conflict','head_not_authorized'].includes(b.bindingStatus)
    || !isoExact(b.observedAt) || !/^[0-9a-f]{64}$/.test(b.sourceManifestSha256 ?? '')
    || !(b.headAuthorizationId === null || UUID.test(b.headAuthorizationId ?? ''))) return null;
  const task = !['unbound','conflict'].includes(b.bindingStatus), claim = ['bound','handover_pending','head_not_authorized'].includes(b.bindingStatus);
  if (!(task ? UUID.test(b.taskId ?? '') : b.taskId === null) || !(claim ? UUID.test(b.claimId ?? '') && Number.isSafeInteger(b.fence) && b.fence > 0
    && Number.isSafeInteger(b.epoch) && b.epoch > 0 : b.claimId === null && b.fence === null && b.epoch === null)) return null;
  return Object.freeze({ ...b });
}
export function claimBindingFingerprint(b) {
  const v = claimBindingObservationOf(b);
  return v ? JSON.stringify([v.bindingStatus,v.taskId,v.claimId,v.fence,v.epoch,v.headAuthorizationId]) : null;
}
export const TRAIN_STRICT_READINESS_CONTRACT = 'clued.independent-ci.train-strict-readiness/1';
export const TRAIN_STRICT_FRONT_READINESS_CONTRACT = 'clued.independent-ci.train-strict-front-readiness/1';
const HEX64 = /^[0-9a-f]{64}$/;
const STRICT_PROOF = /^strict-proof-\d{13}-[0-9a-f]{16}-[0-9a-f]{12}-[0-9a-f]{8}\.json$/;
const STRICT_FRONT_PROOF = /^strict-front-proof-\d{13}-[0-9a-f]{16}-[0-9a-f]{12}-[0-9a-f]{8}\.json$/;

// This is a scheduling observation, never publication authority. Stage 8 revalidates live strict and the Native writer.
export function strictCoverageOf(v) {
  if (!exact(v, ['contract', 'state', 'repo', 'mainSha', 'sourceManifestSha256', 'settingsDigest', 'onSince', 'front', 'proofRef', 'writtenAt', 'expiresAt', 'backgroundAllPending', 'reason'])
    || v.contract !== TRAIN_STRICT_READINESS_CONTRACT || !['none', 'running', 'ready', 'invalid'].includes(v.state)
    || (v.backgroundAllPending !== null && codeOrNull(v.backgroundAllPending) === null) || (v.reason !== null && codeOrNull(v.reason) === null)) return null;
  const front = v.front;
  const bound = SHA.test(v.mainSha ?? '') && HEX64.test(v.sourceManifestSha256 ?? '') && HEX64.test(v.settingsDigest ?? '')
    && typeof v.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo) && isoExact(v.onSince)
    && exact(front, ['pr', 'headSha', 'claimId', 'since']) && Number.isSafeInteger(front.pr) && front.pr > 0 && SHA.test(front.headSha ?? '')
    && UUID.test(front.claimId ?? '') && isoExact(front.since);
  if (v.state === 'none') {
    if (!['repo', 'mainSha', 'sourceManifestSha256', 'settingsDigest', 'onSince', 'front', 'proofRef', 'writtenAt', 'expiresAt'].every(k => v[k] === null)) return null;
  } else if (!bound) return null;
  if (v.state === 'ready' ? !STRICT_PROOF.test(v.proofRef ?? '') || !isoExact(v.writtenAt) || !isoExact(v.expiresAt)
    || !(Date.parse(v.expiresAt) > Date.parse(v.writtenAt)) || Date.parse(v.expiresAt) - Date.parse(v.writtenAt) > 3_600_000
    : v.proofRef !== null || v.writtenAt !== null || v.expiresAt !== null) return null;
  return Object.freeze({ contract: v.contract, state: v.state, repo: bound ? v.repo : null, mainSha: bound ? v.mainSha : null,
    sourceManifestSha256: bound ? v.sourceManifestSha256 : null, settingsDigest: bound ? v.settingsDigest : null,
    onSince: bound ? v.onSince : null, front: bound ? Object.freeze({ pr: front.pr, headSha: front.headSha, claimId: front.claimId, since: front.since }) : null,
    proofRef: v.proofRef, writtenAt: v.writtenAt, expiresAt: v.expiresAt,
    backgroundAllPending: v.backgroundAllPending, reason: v.reason });
}

// The front-only observation shares the identity/clock shape, but never claims historical coverage.
export function strictFrontReadinessOf(v) {
  if (!plain(v) || v.contract !== TRAIN_STRICT_FRONT_READINESS_CONTRACT || v.historyCoverage !== false
    || (v.state === 'ready' && !STRICT_FRONT_PROOF.test(v.proofRef ?? ''))) return null;
  const { historyCoverage, ...base } = v;
  const common = strictCoverageOf({ ...base, contract: TRAIN_STRICT_READINESS_CONTRACT,
    proofRef: typeof base.proofRef === 'string' ? base.proofRef.replace(/^strict-front-proof-/, 'strict-proof-') : base.proofRef });
  return common ? Object.freeze({ ...common, contract: TRAIN_STRICT_FRONT_READINESS_CONTRACT, proofRef: v.proofRef, historyCoverage: false }) : null;
}

function strictObservationMatches(r, { now, repo, sourceManifestSha256, settingsDigest, onSince, front, sweepFreshMs }) {
  if (!r || r.state !== 'ready' || !plain(front) || !Number.isFinite(now)) return false;
  const written = Date.parse(r.writtenAt), expires = Date.parse(r.expiresAt);
  return written >= Date.parse(r.onSince) && now >= written && now < expires && expires - written <= sweepFreshMs && r.repo === repo && r.sourceManifestSha256 === sourceManifestSha256
    && r.settingsDigest === settingsDigest && r.onSince === onSince && r.mainSha === front.baseSha && r.front.pr === front.pr
    && r.front.headSha === front.headSha && r.front.claimId === front.claimId && r.front.since === front.since;
}

export const strictCoverageMatches = (v, context) => strictObservationMatches(strictCoverageOf(v), context);
export const strictFrontReadinessMatches = (v, context) => strictObservationMatches(strictFrontReadinessOf(v), context);

// The mode of the next stage-10 run, or null (none), with why: train.enabled 'off' runs nothing; 'shadow' runs shadow on
// every node; 'on' runs only on an ACTIVE node (STANDBY and UNCERTAIN: NOT_ON_DUTY), 'on' normally, 'revoke-only' under
// PAUSE (DESIGN §41.3) or an intake pause; HALT runs nothing (the caller never asks then).
// Shadow keeps step 3c-1's rule: held by PAUSE and an intake pause.
export function trainRunMode({ enabled, active, paused = false, intakeHeld = false }) {
  if (enabled === 'shadow') return { mode: paused || intakeHeld ? null : 'shadow', notOnDuty: false };
  if (enabled !== 'on') return { mode: null, notOnDuty: false };
  if (!active) return { mode: null, notOnDuty: true };
  return { mode: paused || intakeHeld ? 'revoke-only' : 'on', notOnDuty: false };
}

// Peer-not-ready decisions (another node still on the old Source, or a status that could not be read) clear within minutes, so the
// next run after one comes TRAIN_RECHECK_MS later, not a full maintenanceEveryMs. The daily cap, pause and halt are unchanged.
export const TRAIN_RECHECK_MS = 2 * 60_000;
export const TRAIN_RECHECK_DECISIONS = Object.freeze(['TRAIN_SOURCE_MISMATCH', 'TRAIN_SOURCE_UNREADABLE']);
export function trainDue({ train, now, runs = [], busy, urgent = false, recheck = false }) {
  if (!train || train.enabled === 'off' || busy) return false;
  const recent = runs.filter(at => at > now - DAY);
  if (recent.length >= train.maintenanceMaxPerDay) return false;
  const last = recent.length ? Math.max(...recent) : null;
  return last === null || urgent === true || now - last >= (recheck === true ? Math.min(TRAIN_RECHECK_MS, train.maintenanceEveryMs) : train.maintenanceEveryMs);
}

// A finite cadence exception for an already-required all/current round, not a new sweep or an urgent flag.
// Reserve the number of normal cadence calls that fit in one day; every extra also pays the unchanged total cap.
export function trainIdleExtraDue({ train, now, runs = [], extraRuns = [], busy = false, urgent = false, frontWork = false,
  progress = null, providerBudget = null, consumed = null }) {
  if (!train || train.enabled !== 'on' || busy || urgent || frontWork || !Number.isFinite(now)) return false;
  if (trainDue({ train, now, runs, busy })) return false;
  const recent = runs.filter(at => at > now - DAY), extra = extraRuns.filter(at => at > now - DAY);
  const allowance = Math.max(0, train.maintenanceMaxPerDay - Math.ceil(DAY / train.maintenanceEveryMs));
  if (recent.length >= train.maintenanceMaxPerDay || extra.length >= allowance || recent.some(at => at > now)) return false;
  if (!progress || progress.contract !== 'clued.independent-ci.train-sweep-progress/1' || !FULL_SCOPES.includes(progress.scope) || progress.required !== true
    || progress.advanced !== true || !HEX64.test(progress.roundId ?? '') || !HEX64.test(progress.token ?? '') || !isoOrNull(progress.at)
    || Date.parse(progress.at) > now || now - Date.parse(progress.at) >= train.maintenanceEveryMs
    || consumed === `${progress.roundId}:${progress.token}`) return false;
  return providerBudgetOf(providerBudget, now)?.extraSlicesAllowed === true;
}

function progressOf(v) {
  return exact(v, ['contract', 'roundId', 'scope', 'required', 'advanced', 'token', 'at']) && v.contract === 'clued.independent-ci.train-sweep-progress/1' && HEX64.test(v.roundId ?? '') && HEX64.test(v.token ?? '')
    && FULL_SCOPES.includes(v.scope) && v.required === true && typeof v.advanced === 'boolean' && isoExact(v.at)
    ? Object.freeze({ contract: v.contract, roundId: v.roundId, scope: v.scope, required: true, advanced: v.advanced, token: v.token, at: v.at }) : null;
}

export function providerBudgetOf(v, now = null) {
  const resource = r => r === null || exact(r, ['limit', 'remaining', 'resetAt']) && count(r.limit) !== null && r.limit > 0
    && count(r.remaining) !== null && r.remaining <= r.limit && isoExact(r.resetAt);
  if (!exact(v, ['contract', 'state', 'requests', 'restRequests', 'graphqlRequests', 'rest', 'graphql', 'retryAt', 'observedAt', 'extraSlicesAllowed'])
    || v.contract !== 'clued.independent-ci.train-provider-budget/1' || !['ok', 'low', 'unknown'].includes(v.state)
    || !['requests', 'restRequests', 'graphqlRequests'].every(k => count(v[k]) !== null) || v.requests !== v.restRequests + v.graphqlRequests
    || !resource(v.rest) || !resource(v.graphql) || !(v.retryAt === null || isoExact(v.retryAt)) || !(v.observedAt === null || isoExact(v.observedAt))
    || typeof v.extraSlicesAllowed !== 'boolean' || v.extraSlicesAllowed !== (v.state === 'ok') || (v.state !== 'unknown' && v.observedAt === null)) return null;
  if (v.state === 'ok' && now !== null && (!Number.isSafeInteger(now) || v.observedAt === null || Date.parse(v.observedAt) > now || now - Date.parse(v.observedAt) > 60_000
    || v.retryAt !== null || ![v.rest, v.graphql].every(r => r !== null && Date.parse(r.resetAt) > now && r.remaining > Math.ceil(r.limit / 2)))) return null;
  return Object.freeze({ ...v, rest: v.rest ? Object.freeze({ ...v.rest }) : null, graphql: v.graphql ? Object.freeze({ ...v.graphql }) : null });
}

// The resident's part of the train-run job /3 (INTERFACES §2; /2 plus sweep, DESIGN §65): every field the derivation does not take from the install
// record (contract, id, repo, runId, sourceManifestSha256 and createdAt are the derivation's), in the job's order. settings:
// policy.mjs#trainSettings; onSince: ms or null (null in shadow); frontOutcome: { pr, headSha, testSha, attempt, code } or null
// (mode on only); revokeHeadRequestId: uuid or null (on and revoke-only); sweep: policy.mjs#trainSweepMode (train-run /3, DESIGN §65).
export const TRAIN_RUN_INPUT_FIELDS = Object.freeze(['mode', 'slotHardCapMinutes', 'frontBatchBudgetMs', 'sweepFreshMs', 'fullSweepMaxMs', 'onSince',
  'frontPr', 'frontHeadSha', 'frontTestSha', 'frontAttempt', 'frontCode', 'revokeHeadRequestId', 'sweep']);
const FRONT_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
export function trainRunInput({ mode, settings, onSince = null, frontOutcome = null, revokeHeadRequestId = null, sweep = 'gate' }) {
  const on = mode === 'on', acting = mode !== 'shadow';
  const f = on ? frontOutcome : null;
  const input = { mode, slotHardCapMinutes: settings.slotHardCapMinutes, frontBatchBudgetMs: settings.frontBatchBudgetMs, sweepFreshMs: settings.sweepFreshMs,
    fullSweepMaxMs: settings.fullSweepMaxMs, onSince: acting && Number.isSafeInteger(onSince) ? new Date(onSince).toISOString() : null,
    frontPr: f?.pr ?? null, frontHeadSha: f?.headSha ?? null, frontTestSha: f?.testSha ?? null, frontAttempt: f?.attempt ?? null, frontCode: f?.code ?? null,
    revokeHeadRequestId: acting ? revokeHeadRequestId : null, sweep };
  return validateTrainRunInput(input);
}
// The same rules as the job /3 (train-run.mjs#validateTrainRun, C# ValidateTrainRun) for the resident's part of it.
export function validateTrainRunInput(v) {
  const flat = [v?.frontPr, v?.frontHeadSha, v?.frontTestSha, v?.frontAttempt, v?.frontCode];
  const int = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
  const ok = plain(v) && Object.keys(v).length === TRAIN_RUN_INPUT_FIELDS.length && TRAIN_RUN_INPUT_FIELDS.every(k => Object.hasOwn(v, k)) && RUN_MODES.includes(v.mode)
    && int(v.slotHardCapMinutes, 60, 180) && int(v.frontBatchBudgetMs, 60_000, 10_800_000) && int(v.sweepFreshMs, 60_000, 3_600_000) && int(v.fullSweepMaxMs, 600_000, 86_400_000)
    && (v.onSince === null ? v.mode === 'shadow' : isoOrNull(v.onSince) !== null && v.mode !== 'shadow')
    && (flat.every(x => x === null) || (v.mode === 'on' && Number.isSafeInteger(v.frontPr) && v.frontPr > 0 && SHA.test(v.frontHeadSha ?? '') && SHA.test(v.frontTestSha ?? '')
      && v.frontTestSha !== v.frontHeadSha && [1, 2].includes(v.frontAttempt) && FRONT_CODE.test(v.frontCode ?? '')))
    && (v.revokeHeadRequestId === null || (v.mode !== 'shadow' && UUID.test(v.revokeHeadRequestId))) && TRAIN_RUN_SWEEPS.includes(v.sweep);
  if (!ok) fail('TRAIN_RUN_INPUT_INVALID');
  return Object.freeze({ ...v });
}

// facts /2 openFrontBatch -> the frozen front of a batch with S, or null when it does not fit (never a guess).
// ADR 0019: a batch of several PRs also names its members [{pr, headSha}] in merge order, the front first (2..4, distinct PRs and heads,
// none of them S or T); they go into the descriptor /4. A members value that does not fit makes the whole batch not fit.
const membersOf = o => {
  if (o.members === undefined) return undefined;
  const m = o.members;
  const ok = Array.isArray(m) && m.length >= 2 && m.length <= 4 && m.every(x => plain(x) && Object.keys(x).length === 2 && Number.isSafeInteger(x.pr) && x.pr > 0 && SHA.test(x.headSha ?? '')
    && x.headSha !== o.testSha && x.headSha !== o.baseSha) && m[0].pr === o.pr && m[0].headSha === o.headSha
    && new Set(m.map(x => x.pr)).size === m.length && new Set(m.map(x => x.headSha)).size === m.length;
  return ok ? Object.freeze(m.map(x => Object.freeze({ pr: x.pr, headSha: x.headSha }))) : null;
};
export function openFrontBatchOf(o) {
  if (!plain(o)) return null;
  const members = membersOf(o);
  // headTree (rule 41ab823a, DESIGN §75): H's own tree, which stage 10 names for a front of one member only; anything else names none.
  const headTree = !members && SHA.test(o.headTree ?? '') ? o.headTree : null;
  const ok = Number.isSafeInteger(o.pr) && o.pr > 0 && SHA.test(o.headSha ?? '') && SHA.test(o.baseSha ?? '') && SHA.test(o.testSha ?? '') && SHA.test(o.testTree ?? '')
    && o.testSha !== o.headSha && typeof o.claimId === 'string' && CLAIM.test(o.claimId) && isoOrNull(o.since) !== null && [1, 2].includes(o.attempt) && members !== null;
  return ok ? Object.freeze({ pr: o.pr, headSha: o.headSha, baseSha: o.baseSha, testSha: o.testSha, testTree: o.testTree, claimId: o.claimId, since: o.since, attempt: o.attempt,
    ...(members ? { members } : {}), ...(headTree ? { headTree } : {}) }) : null;
}

// ADR 0019 (engine-windows.mjs#derive, executor.mjs#drive): the front batch's members and S's tree as the descriptor /4 names them,
// or null when they do not fit the subject (never a guess).
export function chainOfFront(subject, front) {
  const m = front?.members;
  if (!Array.isArray(m) || m.length < 2 || m.length > 4 || !SHA.test(front.testTree ?? '')) return null;
  if (!subject || !Object.hasOwn(subject, 'testSha') || front.pr !== subject.pr || front.headSha !== subject.headSha || front.baseSha !== subject.baseSha
    || front.testSha !== subject.testSha) return null;
  const heads = m.map(x => x?.headSha);
  const ok = m.every(x => x && Object.keys(x).length === 2 && Number.isSafeInteger(x.pr) && x.pr > 0 && SHA.test(x.headSha ?? ''))
    && m[0].pr === subject.pr && m[0].headSha === subject.headSha && new Set(m.map(x => x.pr)).size === m.length && new Set(heads).size === m.length
    && !heads.includes(subject.testSha) && !heads.includes(subject.baseSha);
  return ok ? Object.freeze({ members: Object.freeze(m.map(x => Object.freeze({ pr: x.pr, headSha: x.headSha }))), testTree: front.testTree }) : null;
}

// facts /2 sweep -> the summary's copy, or null.
export function sweepOf(s) {
  if (!plain(s) || !SWEEP_KINDS.includes(s.kind) || typeof s.complete !== 'boolean' || !plain(s.fullSweep) || !FULL_STATES.includes(s.fullSweep.state)) return null;
  const strictCoverage = s.strictCoverage === undefined ? null : strictCoverageOf(s.strictCoverage);
  if (s.strictCoverage !== undefined && strictCoverage === null) return null;
  if (strictCoverage?.state === 'ready' && (s.complete !== true || s.proofWritten !== true || s.unconfirmed !== 0)) return null;
  const strictFrontReadiness = s.strictFrontReadiness === undefined ? null : strictFrontReadinessOf(s.strictFrontReadiness);
  if (s.strictFrontReadiness !== undefined && strictFrontReadiness === null) return null;
  if (strictFrontReadiness?.state === 'ready' && (s.unconfirmed !== 0 || s.fullSweep.allPending === 'TRAIN_MAIN_REWRITTEN')) return null;
  return Object.freeze({ kind: s.kind, complete: s.complete, revoked: count(s.revoked) ?? 0, unconfirmed: count(s.unconfirmed) ?? 0, wouldRevokeCount: count(s.wouldRevokeCount) ?? 0,
    fullSweep: Object.freeze({ state: s.fullSweep.state, startedAt: isoOrNull(s.fullSweep.startedAt), completedAt: isoOrNull(s.fullSweep.completedAt), sinceOn: s.fullSweep.sinceOn === true,
      // generation 15 (DESIGN 60): 'all' (every pull and commit) or 'current' (open pulls whole, closed unmerged heads), why, and why rounds
      // enumerate everything until one of scope 'all' completes (main rewritten, no main tip recorded)
      scope: FULL_SCOPES.includes(s.fullSweep.scope) ? s.fullSweep.scope : null, scopeReason: codeOrNull(s.fullSweep.scopeReason), allPending: codeOrNull(s.fullSweep.allPending) }),
    proofWritten: s.proofWritten === true, ...(strictCoverage ? { strictCoverage } : {}),
    ...(strictFrontReadiness ? { strictFrontReadiness } : {}),
    ...(s.progress !== undefined ? { progress: progressOf(s.progress) } : {}),
    ...(s.providerBudget !== undefined ? { providerBudget: providerBudgetOf(s.providerBudget) } : {}) });
}

const actionsOf = a => (plain(a) ? Object.freeze({ touchedRunning: a.touchedRunning === true, adopted: a.adopted === true, returned: a.returned === true, failedReported: a.failedReported === true,
  keptAlive: count(a.keptAlive) ?? 0, watermarkReported: a.watermarkReported === true,
  revokeHead: plain(a.revokeHead) && UUID.test(a.revokeHead.requestId ?? '') ? Object.freeze({ requestId: a.revokeHead.requestId, done: a.revokeHead.done === true }) : null }) : null);

// The part of stage 10's facts the resident keeps (status snapshot, PR page). Anything that does not look like train
// facts is null ("facts unconfirmed"). Facts /1 are shadow only and keep the /1 summary; facts /2 add the decision, the sweep,
// what was done, the PAUSE request and the front batch. In on and revoke-only a /2 run must name a decision and, when it says
// OPEN_FRONT_BATCH in mode on, a front batch that fits; a requestPause the executor does not know is no summary either (it
// would be a PAUSE the executor cannot latch: fail closed).
export function trainSummary(f) {
  if (!f || ![TRAIN_FACTS_CONTRACT, TRAIN_FACTS_CONTRACT_V2].includes(f.contract) || !WOULD_DO.includes(f.wouldDo) || typeof f.at !== 'string') return null;
  const v2 = f.contract === TRAIN_FACTS_CONTRACT_V2;
  const claimBindings = f.claimBindings === undefined ? [] : Array.isArray(f.claimBindings) && f.claimBindings.length <= 50
    ? f.claimBindings.map(claimBindingObservationOf) : null;
  if (!claimBindings || claimBindings.some(b => b === null) || new Set(claimBindings.map(b => b.pr)).size !== claimBindings.length
    || new Set(claimBindings.map(b => JSON.stringify([b.repository,b.scope,b.sourceManifestSha256]))).size > 1) return null;
  if (v2 ? !RUN_MODES.includes(f.mode) : f.mode !== 'shadow') return null;
  const front = f.front && Number.isSafeInteger(f.front.pr) ? { pr: f.front.pr, headSha: SHA.test(f.front.headSha ?? '') ? f.front.headSha : null } : null;
  const base = { at: f.at, mode: f.mode, wouldDo: f.wouldDo, onDuty: f.onDuty === true, front, mainSha: SHA.test(f.mainSha ?? '') ? f.mainSha : null,
    ...(f.claimBindings === undefined ? {} : { claimBindings }),
    strict: typeof f.rules?.strict === 'boolean' ? f.rules.strict : null, wouldRevokeCount: Number.isSafeInteger(f.wouldRevokeCount) ? f.wouldRevokeCount : 0 };
  if (!v2) return Object.freeze(base);
  const decision = DECISIONS.includes(f.decision) ? f.decision : null;
  const acting = f.mode !== 'shadow';
  if (acting && decision === null) return null;
  if (f.requestPause !== undefined && f.requestPause !== null && !REQUEST_PAUSE_CODES.includes(f.requestPause)) return null;
  const openFrontBatch = f.mode === 'on' && decision === 'OPEN_FRONT_BATCH' ? openFrontBatchOf(f.openFrontBatch) : null;
  if (f.mode === 'on' && decision === 'OPEN_FRONT_BATCH' && !openFrontBatch) return null;
  const sweep = sweepOf(f.sweep);
  if ((f.sweep?.strictCoverage !== undefined || f.sweep?.strictFrontReadiness !== undefined) && !sweep) return null;
  // DESIGN §62.4: the take-over front binding observation, kept by the executor only (a malformed one is none: no exception).
  const frontBind = f.mode === 'on' && decision === 'TRAIN_TAKEOVER_SWEEP_PENDING' && f.wouldDo === 'FRONT_NOT_BOUND' ? frontBindOf(f.frontBind, f.front) : null;
  return Object.freeze({ ...base, decision, sweep, actions: actionsOf(f.actions), requestPause: acting ? (f.requestPause ?? null) : null, openFrontBatch,
    ...(frontBind ? { frontBind } : {}) });
}

function frontBindOf(b, front) {
  return exact(b, ['pr', 'headSha', 'claimId']) && Number.isSafeInteger(b.pr) && b.pr > 0 && SHA.test(b.headSha ?? '') && UUID.test(b.claimId ?? '')
    && front?.pr === null && front.claimId === b.claimId ? Object.freeze({ pr: b.pr, headSha: b.headSha, claimId: b.claimId }) : null;
}

// The PR page line on the front PR (info only: in shadow mode the train does nothing).
const TEXT = {
  FRONT_NOT_RUNNABLE: '车头 PR 现在不能跑（草稿、已关闭或不是合到 main）',
  FRONT_NEEDS_MAIN_MERGE: '开车后会请作者先把 main 合进分支（冲突，或 strict 开着而 head 落后）',
  FRONT_TEST_MERGE_NOT_READY: '开车后会等 GitHub 算好试合并',
  FRONT_GREEN_WAIT_MERGE: '车头六项已绿，等合并',
  OPEN_FRONT_BATCH: '开车后会在 GitHub 的试合并提交上跑车头批次',
};
// The train on (DESIGN §41.2-41.4): stage 10's decision on the front PR, in words.
const ON_TEXT = {
  FRONT_NOT_RUNNABLE: '车头 PR 现在不能跑（草稿、已关闭或不是合到 main）',
  FRONT_NEEDS_MAIN_MERGE: '请先把 main 合进分支再推送（冲突，或 head 不含 main 尖端）',
  FRONT_TEST_MERGE_NOT_READY: '等 GitHub 算好试合并',
  FRONT_GREEN_WAIT_MERGE: '车头六项已绿，等合并',
  OPEN_FRONT_BATCH: '车头批次已开，在 GitHub 的试合并提交上跑',
  TRAIN_FRONT_BUDGET_SHORT: '位子剩余时间不够跑一批：请让位子过期后重新入队',
  TRAIN_FRONT_ATTEMPTS_USED: '这个 head 的两次车头批次已用完：请推新提交',
  TRAIN_SWEEP_INCOMPLETE: '清扫未完成，暂不发绿',
  TRAIN_REVOKE_UNCONFIRMED: '有撤销未确认，暂不发绿',
  TRAIN_TAKEOVER_SWEEP_PENDING: '接班清扫未完成，暂不发绿',
  TRAIN_LANDED_TREE_MISMATCH: '落地的树与测过的不同，已停车，等 Owner',
  TRAIN_FRONT_BATCH_RUNNING: '车头批次进行中',
  TRAIN_SOURCE_UNREADABLE: '读不到各常驻节点的 Source，暂不开车',
  TRAIN_STRICT_OFF: 'main 的 strict 被关了：strict 永久开模式下不发绿，已停车，等 Owner 把 strict 开回',
  TRAIN_FRONT_NOT_PROVEN: '这一轮没能确认车头的严格检查条件，暂不开车头批次，下一轮再看',
};
// Generation 15 (DESIGN 60.2): why nothing goes green while the train re-sweeps everything after main was rewritten.
export const MAIN_REWRITTEN_TEXT = 'main 被改写，合并列车在重扫全部 PR 和提交，扫完前不发绿';
export function trainPageLine(summary, pr) {
  if (!summary || summary.front?.pr !== pr) return null;
  if (summary.mode === 'shadow') return TEXT[summary.wouldDo] ? `列车影子（只记录，不执行）：你是合并队列车头。${TEXT[summary.wouldDo]}。` : null;
  const text = summary.decision === 'TRAIN_TAKEOVER_SWEEP_PENDING' && summary.sweep?.fullSweep?.allPending === 'TRAIN_MAIN_REWRITTEN' ? MAIN_REWRITTEN_TEXT
    : ON_TEXT[summary.decision] ?? null;
  const background = summary.sweep?.strictFrontReadiness?.state === 'ready'
    ? '车头采用严格检查路径，历史清扫仍单独进行。'
    : summary.sweep?.strictCoverage?.state === 'ready' && summary.sweep.strictCoverage.backgroundAllPending !== null
      ? '车头严格屏障已核验，后台全量清扫仍未完成。' : '';
  return text ? `合并列车：你是车头。${text}。${background}` : null;
}

// The status reader's copy of a summary (untrusted bytes in state\status.json): the same fields with `at` in ms, or null.
// A /2 summary (it has `decision`) keeps its decision, sweep and PAUSE request; the front batch and the actions stay with the
// executor (the companion never acts on them).
export function parseTrainLast(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l) || !RUN_MODES.includes(l.mode) || !WOULD_DO.includes(l.wouldDo) || !Number.isFinite(Date.parse(l.at))) return null;
  const v2 = Object.hasOwn(l, 'decision');
  if (!v2 && l.mode !== 'shadow') return null;
  const base = { at: Date.parse(l.at), mode: l.mode, wouldDo: l.wouldDo, onDuty: l.onDuty === true,
    front: l.front && Number.isSafeInteger(l.front.pr) ? { pr: l.front.pr, headSha: SHA.test(l.front.headSha ?? '') ? l.front.headSha : null } : null,
    mainSha: SHA.test(l.mainSha ?? '') ? l.mainSha : null, strict: typeof l.strict === 'boolean' ? l.strict : null,
    wouldRevokeCount: Number.isSafeInteger(l.wouldRevokeCount) && l.wouldRevokeCount >= 0 ? l.wouldRevokeCount : 0 };
  if (!v2) return Object.freeze(base);
  return Object.freeze({ ...base, decision: DECISIONS.includes(l.decision) ? l.decision : null, sweep: sweepOf(l.sweep),
    requestPause: REQUEST_PAUSE_CODES.includes(l.requestPause) ? l.requestPause : null });
}

// The status snapshot's `train.sweep` (DESIGN §41.7): when this node last completed a full sweep, whether that was after it
// became eligible for on-mode duty (the change to on or the take-over), and the newest run's sweep result. null before any.
export function trainSweepView({ summary, previous = null, onSince = null }) {
  const s = summary?.sweep;
  if (!s) return previous;
  const completedAt = s.fullSweep.state === 'complete' && s.fullSweep.completedAt ? s.fullSweep.completedAt : (previous?.fullCompletedAt ?? null);
  // generation 15 (DESIGN 60.2): main rewritten voids the full sweep since on until a round of scope 'all' completes
  const sinceOn = s.fullSweep.allPending === 'TRAIN_MAIN_REWRITTEN' ? false
    : s.fullSweep.state === 'complete' ? s.fullSweep.sinceOn === true : (previous?.fullSinceOn === true && previous?.onSince === onSince);
  return Object.freeze({ at: summary.at, mode: summary.mode, kind: s.kind, complete: s.complete, revoked: s.revoked, unconfirmed: s.unconfirmed, fullState: s.fullSweep.state,
    fullCompletedAt: completedAt, fullSinceOn: sinceOn && summary.mode !== 'shadow', onSince,
    fullScope: s.fullSweep.scope ?? null, fullScopeReason: s.fullSweep.scopeReason ?? null, fullAllPending: s.fullSweep.allPending ?? null });
}
// The status reader's copy of train.sweep, or null.
export function parseTrainSweep(v) {
  if (!plain(v) || !RUN_MODES.includes(v.mode) || !SWEEP_KINDS.includes(v.kind) || typeof v.complete !== 'boolean' || !FULL_STATES.includes(v.fullState) || !Number.isFinite(Date.parse(v.at))) return null;
  return Object.freeze({ at: Date.parse(v.at), mode: v.mode, kind: v.kind, complete: v.complete, revoked: count(v.revoked) ?? 0, unconfirmed: count(v.unconfirmed) ?? 0, fullState: v.fullState,
    fullCompletedAt: Number.isFinite(Date.parse(v.fullCompletedAt)) ? Date.parse(v.fullCompletedAt) : null, fullSinceOn: v.fullSinceOn === true,
    onSince: Number.isFinite(Date.parse(v.onSince)) ? Date.parse(v.onSince) : null,
    fullScope: FULL_SCOPES.includes(v.fullScope) ? v.fullScope : null, fullScopeReason: codeOrNull(v.fullScopeReason), fullAllPending: codeOrNull(v.fullAllPending) });
}
// The status reader's copy of train.revokeHead (DESIGN §41.3: the Owner's "撤车头" request and its result), or null.
export function parseRevokeHead(v) {
  if (!plain(v) || !UUID.test(v.requestId ?? '') || !['accepted', 'done', 'not-done', 'refused', 'expired'].includes(v.state) || !Number.isFinite(Date.parse(v.at))) return null;
  return Object.freeze({ requestId: v.requestId, state: v.state, at: Date.parse(v.at), code: typeof v.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(v.code) ? v.code : null });
}

// Defect 15894c2a: the nodes stage 10 compared in its §41.6 Source check (ci_nodes_status, train-maintenance.mjs; facts /2 `nodes`),
// kept as the status snapshot's `train.nodes` so that the upgrade precheck (rollout/precheck.mjs, NON-elevated: it cannot call Native
// with this node's ci-admission token) reads the very list the runtime guard reads. A view only: nothing in the executor decides on it.
// Only an on-mode run on duty reads the nodes (every other run says nothing: nodes null), so `at` tells the reader how old the list is.
// { at, sourceManifestSha256 (this node's Source at that run), nodes: [{ node, sourceManifestSha256, state, lastHeartbeatAt }], dropped }
export const TRAIN_NODES_MAX = 64;
const nodeEntry = n => (plain(n) && (n.node === null || (typeof n.node === 'string' && n.node.length >= 1 && n.node.length <= 200))
  && (n.sourceManifestSha256 === null || HEX64.test(n.sourceManifestSha256 ?? ''))
  && (n.state === null || (typeof n.state === 'string' && n.state.length <= 40))
  && (n.lastHeartbeatAt === null || (typeof n.lastHeartbeatAt === 'string' && n.lastHeartbeatAt.length <= 40 && Number.isFinite(Date.parse(n.lastHeartbeatAt))))
  ? Object.freeze({ node: n.node, sourceManifestSha256: n.sourceManifestSha256, state: n.state, lastHeartbeatAt: n.lastHeartbeatAt }) : null);
function nodesOf(list, dropped, at, sourceManifestSha256) {
  if (!Array.isArray(list) || !isoOrNull(at) || !HEX64.test(sourceManifestSha256 ?? '')) return null;
  const nodes = list.slice(0, TRAIN_NODES_MAX).map(nodeEntry);
  if (nodes.includes(null)) return null;
  return Object.freeze({ at, sourceManifestSha256, nodes: Object.freeze(nodes), dropped: (count(dropped) ?? 0) + Math.max(0, list.length - TRAIN_NODES_MAX) });
}
// From stage 10's facts (any shape: null unless an on-mode facts /2 with a nodes list).
export function trainNodesView(f, sourceManifestSha256) {
  if (!plain(f) || f.contract !== TRAIN_FACTS_CONTRACT_V2 || f.mode !== 'on') return null;
  return nodesOf(f.nodes, f.nodesDropped, f.at, sourceManifestSha256);
}
// The status reader's copy of train.nodes, or null.
export function parseTrainNodes(v) { return plain(v) ? nodesOf(v.nodes, v.dropped, v.at, v.sourceManifestSha256) : null; }

// The PR page (pr-status.mjs): the front PR's own description, with the shadow line appended when the newest run (at most
// TRAIN_PAGE_MAX_AGE_MS old) saw this very head at the front. Never on a failure or an error, never instead of the
// executor's own words.
export const TRAIN_PAGE_MAX_AGE_MS = 30 * 60_000;
export function withTrainLine(want, last, pull, now, max = 140) {
  if (!want || ['failure', 'error'].includes(want.state) || !last || now - last.at > TRAIN_PAGE_MAX_AGE_MS || !last.front?.headSha || last.front.headSha !== pull?.headSha) return want;
  const line = trainPageLine(last, pull.pr);
  if (!line) return want;
  const d = `${want.description}；${line}`;
  return { ...want, description: d.length <= max ? d : `${d.slice(0, max - 1)}…` };
}
