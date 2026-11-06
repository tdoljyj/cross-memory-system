// Train facts (resident quota redesign phase 2, step 3c-1; design v0.5 §5.2, §5.5 items 1, 2, 8, §5.6; DESIGN §21.2).
// Pure: what stage 10 read, and what the train WOULD do with it. In shadow mode nothing acts on it; the facts go to
// the resident (status, PR page) and to the shadow records for the step-4 statistics. No I/O, no credential.
// Facts /2 (step 3c-2b, DESIGN §41.7; INTERFACES §3): mode shadow | on | revoke-only; the /1 fields (wouldDo is the
// shadow judgement in every mode) plus `decision` (what this run ended on: WOULD_DO or DECISIONS_V2), `openFrontBatch`
// (on only, after a confirmed sweep and a confirmed touch running: the executor's one source of a test commit S),
// `sweep`, `actions`, `requestPause` and the holders' `nodes`.
//
// wouldDo is one of WOULD_DO:
//   NOT_ON_DUTY              Native says this binding has no ci-admission role (the standby node)
//   NO_FRONT                 no live merge-slot holder in this scope (holders is scope-filtered: design §5.5 item 1)
//   FRONT_AMBIGUOUS          more than one live holder
//   FRONT_NOT_BOUND          the holder's claim names no PR of this repository
//   FRONT_NOT_RUNNABLE       the front PR is closed, a draft, or not based on main
//   FRONT_NEEDS_MAIN_MERGE   GitHub reports a conflict, or strict is on and the head does not contain main's tip
//   FRONT_TEST_MERGE_NOT_READY  no test merge yet, still computing, or not exactly [main, head]
//   FRONT_GREEN_WAIT_MERGE   the front head already carries App 5368905's kooyumi-merge-slot success
//   OPEN_FRONT_BATCH         the train would open the front batch: T = main, H = head, S = the test merge
// wouldRevoke: ledgered merge-slot greens that are neither in main nor the front's current head (§5.4 item 3).
// The protected-layer pre-check (§41.4, MergeAdmission v0.2 §2.4: a protected-layer front H must contain T) runs in mode on
// only: stage 10 sets front.protectedLayer from the PR's changed paths and the admission policy (train-maintenance.mjs);
// shadow mode reports FRONT_NEEDS_MAIN_MERGE only from GitHub's own facts, as before.
import { validStrictReadiness, validStrictFrontReadiness, validTrainProviderBudget, validSweepProgress } from './train-strict.mjs';
export const TRAIN_FACTS_CONTRACT = 'clued.independent-ci.train-facts/2';
export const WOULD_DO = Object.freeze(['NOT_ON_DUTY', 'NO_FRONT', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND', 'FRONT_NOT_RUNNABLE', 'FRONT_NEEDS_MAIN_MERGE',
  'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']);
// The on and revoke-only endings beyond WOULD_DO (DESIGN §41.3, §41.4, §41.6). TRAIN_SOURCE_UNREADABLE: ci_nodes_status
// could not be read, so the Source check could not be made (a deferral like TRAIN_SOURCE_MISMATCH, nothing written).
// TRAIN_FRONT_BATCH_RUNNING: this node's front batch of (claim, T, S) is still running (the holder's CI clock is running on
// H); the proof was refreshed for its stage 8, no new batch and no attempt counted (review R2 M1).
export const DECISIONS_V2 = Object.freeze(['TRAIN_REVOKE_UNCONFIRMED', 'TRAIN_SWEEP_INCOMPLETE', 'TRAIN_TAKEOVER_SWEEP_PENDING', 'TRAIN_SOURCE_MISMATCH',
  'TRAIN_LANDED_TREE_MISMATCH', 'TRAIN_FRONT_BUDGET_SHORT', 'TRAIN_FRONT_ATTEMPTS_USED', 'FRONT_ADOPTED', 'FRONT_RETURNED', 'FRONT_FAILED_REPORTED', 'REVOKE_ONLY_DONE',
  'TRAIN_SOURCE_UNREADABLE', 'TRAIN_FRONT_BATCH_RUNNING']);
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

// The front PR as GitHub reports it now, reduced to what the train decides on.
export function frontPullFacts({ pull, mergeCommit, compare, checks, mainSha, appId, slotCheckName = 'kooyumi-merge-slot' }) {
  const headSha = SHA.test(pull?.head?.sha ?? '') ? pull.head.sha : null;
  const testMerge = mergeCommit && SHA.test(mergeCommit.sha ?? '') ? { sha: mergeCommit.sha, tree: mergeCommit.tree,
    parentsOk: Array.isArray(mergeCommit.parents) && mergeCommit.parents.length === 2 && mergeCommit.parents[0] === mainSha && mergeCommit.parents[1] === headSha } : null;
  const greens = Array.isArray(checks) ? checks.filter(c => c?.app?.id === appId && c.name === slotCheckName && c.head_sha === headSha) : [];
  const latest = greens.sort((a, b) => b.id - a.id)[0] ?? null;
  return { state: pull?.state ?? null, draft: pull?.draft === true, merged: pull?.merged === true, baseRef: pull?.base?.ref ?? null, headSha,
    mergeable: typeof pull?.mergeable === 'boolean' ? pull.mergeable : null, testMerge,
    headContainsMain: compare ? compare.behindBy === 0 && ['ahead', 'identical'].includes(compare.status) : null,
    green: !!latest && latest.status === 'completed' && latest.conclusion === 'success' };
}

// The decision. front: frontPullFacts or null; holder: the merge-slot holder or null.
export function decideShadow({ onDuty, holders, holder = holders?.[0] ?? null, front, rules, mainSha }) {
  if (!onDuty) return 'NOT_ON_DUTY';
  if (!holders?.length) return 'NO_FRONT';
  if (holders.length > 1) return 'FRONT_AMBIGUOUS';
  if (!holder?.pr) return 'FRONT_NOT_BOUND';
  if (!front || front.state !== 'open' || front.draft || front.baseRef !== 'main' || !front.headSha) return 'FRONT_NOT_RUNNABLE';
  if (front.mergeable === false || (rules?.strict === true && front.headContainsMain === false)
    || (front.protectedLayer === true && front.headContainsMain !== true)) return 'FRONT_NEEDS_MAIN_MERGE';
  if (front.green) return 'FRONT_GREEN_WAIT_MERGE';
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
export function trainFacts({ mode, at, onDuty, holders, mainSha, rules, rulesReason = null, front, revoke, ledger, decision = null, openFrontBatch = null,
  sweep = NO_SWEEP, actions = NO_ACTIONS, requestPause = null, nodes = null, nodesDropped = 0 }) {
  const holder = holders?.[0] ?? null;
  const wouldDo = decideShadow({ onDuty, holders, holder, front, rules, mainSha });
  const facts = {
    contract: TRAIN_FACTS_CONTRACT, mode, at, onDuty, mainSha: mainSha ?? null,
    rules: rules ? { strict: rules.strict, mergeOnly: rules.mergeOnly } : null, rulesReason,
    holders: holders?.length ?? 0,
    front: holder ? { claimId: holder.claimId, pr: holder.pr, mergeSlotUntil: holder.mergeSlotUntil, takenAt: holder.takenAt, ciState: holder.ciState,
      ...(front ? { headSha: front.headSha, state: front.state, draft: front.draft, mergeable: front.mergeable, headContainsMain: front.headContainsMain, green: front.green,
        testMergeSha: front.testMerge?.sha ?? null, testMergeTree: front.testMerge?.tree ?? null, testMergeParentsOk: front.testMerge?.parentsOk ?? null } : {}) } : null,
    wouldDo,
    wouldRevoke: (revoke ?? []).slice(0, MAX_REVOKE_LISTED), wouldRevokeCount: (revoke ?? []).length,
    ledger: { records: ledger?.records ?? 0, refused: ledger?.refused ?? 0, ...(Number.isSafeInteger(ledger?.closed) ? { closed: ledger.closed } : {}) },
    decision: decision ?? wouldDo, openFrontBatch, sweep, actions, requestPause,
    // ci_nodes_status (§41.6): one entry per listed connection; node null (no live node), fields null (never heard).
    nodes: Array.isArray(nodes) ? nodes.slice(0, 64).map(n => ({ node: n.node ?? null, sourceManifestSha256: n.sourceManifestSha256 ?? null, state: n.state ?? null,
      lastHeartbeatAt: n.lastHeartbeatAt ?? null })) : null,
    nodesDropped: Number.isSafeInteger(nodesDropped) && nodesDropped >= 0 ? nodesDropped : 0,
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
const validBatch = b => plain(b) && Number.isSafeInteger(b.pr) && b.pr > 0 && ['headSha', 'baseSha', 'testSha', 'testTree'].every(k => SHA.test(b[k] ?? ''))
  && UUID.test(b.claimId ?? '') && iso(b.since) && [1, 2].includes(b.attempt);
const validNodes = n => n === null || (Array.isArray(n) && n.length <= 64 && n.every(x => plain(x) && (x.node === null || (typeof x.node === 'string' && x.node.length <= 200))
  && (x.sourceManifestSha256 === null || HEX64.test(x.sourceManifestSha256 ?? '')) && (x.state === null || (typeof x.state === 'string' && x.state.length <= 40))
  && (x.lastHeartbeatAt === null || iso(x.lastHeartbeatAt))));
const quiet = f => f.openFrontBatch === null && f.requestPause === null && f.sweep.revoked === 0 && f.sweep.unconfirmed === 0 && !f.sweep.proofWritten
  && Object.entries(NO_ACTIONS).every(([k, v]) => f.actions[k] === v);

// Bounded shape check, shared by the entry (before writing) and stage-inputs (the outcome's train block). Shadow writes
// nothing (no front batch, no action, no revocation, no proof); a front batch only in on and only as OPEN_FRONT_BATCH.
export function validateTrainFacts(f) {
  if (!plain(f) || f.contract !== TRAIN_FACTS_CONTRACT || !TRAIN_MODES.includes(f.mode) || !iso(f.at) || typeof f.onDuty !== 'boolean'
    || !(f.mainSha === null || SHA.test(f.mainSha)) || !WOULD_DO.includes(f.wouldDo) || !Number.isSafeInteger(f.holders) || f.holders < 0
    || !(f.rules === null || (plain(f.rules) && typeof f.rules.strict === 'boolean' && typeof f.rules.mergeOnly === 'boolean'))
    || !(f.rulesReason === null || (typeof f.rulesReason === 'string' && CODE.test(f.rulesReason)))
    || !(f.front === null || (plain(f.front) && UUID.test(f.front.claimId ?? '') && (f.front.pr === null || Number.isSafeInteger(f.front.pr))))
    || !Array.isArray(f.wouldRevoke) || f.wouldRevoke.length > MAX_REVOKE_LISTED
    || !f.wouldRevoke.every(r => plain(r) && SHA.test(r.headSha ?? '') && Number.isSafeInteger(r.checkRunId) && r.checkRunId > 0)
    || !Number.isSafeInteger(f.wouldRevokeCount) || !plain(f.ledger)
    || !DECISIONS.includes(f.decision) || !validSweep(f.sweep, Date.parse(f.at)) || !validActions(f.actions) || !validNodes(f.nodes) || !count(f.nodesDropped)
    || !(f.requestPause === null || (f.requestPause === 'TRAIN_LANDED_TREE_MISMATCH' && f.decision === 'TRAIN_LANDED_TREE_MISMATCH' && f.mode === 'on'))
    || !(f.openFrontBatch === null || (f.mode === 'on' && validBatch(f.openFrontBatch)))
    || (f.mode === 'on' && (f.decision === 'OPEN_FRONT_BATCH') !== (f.openFrontBatch !== null))
    || (f.mode === 'shadow' && (!quiet(f) || f.decision !== f.wouldDo))
    || (f.mode === 'revoke-only' && (f.openFrontBatch !== null || f.actions.touchedRunning || f.actions.adopted || f.actions.returned || f.actions.failedReported || f.actions.keptAlive > 0))
    || JSON.stringify(f).length > MAX_TRAIN_FACTS_BYTES) fail('invalid_train_facts');
  return f;
}
