// Train facts (resident quota redesign phase 2, step 3c-1; design v0.5 §5.2, §5.5 items 1, 2, 8, §5.6; DESIGN §21.2).
// Pure: what stage 10 read, and what the train WOULD do with it. In shadow mode nothing acts on it; the facts go to
// the resident (status, PR page) and to the shadow records for the step-4 statistics. No I/O, no credential.
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
// The protected-layer pre-check of §5.2 needs the admission policy and is left to step 3c-2; shadow mode reports
// FRONT_NEEDS_MAIN_MERGE only from GitHub's own facts.
export const TRAIN_FACTS_CONTRACT = 'clued.independent-ci.train-facts/1';
export const WOULD_DO = Object.freeze(['NOT_ON_DUTY', 'NO_FRONT', 'FRONT_AMBIGUOUS', 'FRONT_NOT_BOUND', 'FRONT_NOT_RUNNABLE', 'FRONT_NEEDS_MAIN_MERGE',
  'FRONT_TEST_MERGE_NOT_READY', 'FRONT_GREEN_WAIT_MERGE', 'OPEN_FRONT_BATCH']);
export const MAX_REVOKE_LISTED = 20;
const SHA = /^[0-9a-f]{40}$/;
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
  if (front.mergeable === false || (rules?.strict === true && front.headContainsMain === false)) return 'FRONT_NEEDS_MAIN_MERGE';
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

export function trainFacts({ mode, at, onDuty, holders, mainSha, rules, rulesReason = null, front, revoke, ledger }) {
  const holder = holders?.[0] ?? null;
  const facts = {
    contract: TRAIN_FACTS_CONTRACT, mode, at, onDuty, mainSha: mainSha ?? null,
    rules: rules ? { strict: rules.strict, mergeOnly: rules.mergeOnly } : null, rulesReason,
    holders: holders?.length ?? 0,
    front: holder ? { claimId: holder.claimId, pr: holder.pr, mergeSlotUntil: holder.mergeSlotUntil, takenAt: holder.takenAt, ciState: holder.ciState,
      ...(front ? { headSha: front.headSha, state: front.state, draft: front.draft, mergeable: front.mergeable, headContainsMain: front.headContainsMain, green: front.green,
        testMergeSha: front.testMerge?.sha ?? null, testMergeTree: front.testMerge?.tree ?? null, testMergeParentsOk: front.testMerge?.parentsOk ?? null } : {}) } : null,
    wouldDo: decideShadow({ onDuty, holders, holder, front, rules, mainSha }),
    wouldRevoke: (revoke ?? []).slice(0, MAX_REVOKE_LISTED), wouldRevokeCount: (revoke ?? []).length,
    ledger: { records: ledger?.records ?? 0, refused: ledger?.refused ?? 0 },
  };
  return validateTrainFacts(facts);
}

// Bounded shape check, shared by the entry (before writing) and stage-inputs (the outcome's train block).
export function validateTrainFacts(f) {
  if (!plain(f) || f.contract !== TRAIN_FACTS_CONTRACT || f.mode !== 'shadow' || !iso(f.at) || typeof f.onDuty !== 'boolean'
    || !(f.mainSha === null || SHA.test(f.mainSha)) || !WOULD_DO.includes(f.wouldDo) || !Number.isSafeInteger(f.holders) || f.holders < 0
    || !(f.rules === null || (plain(f.rules) && typeof f.rules.strict === 'boolean' && typeof f.rules.mergeOnly === 'boolean'))
    || !(f.rulesReason === null || (typeof f.rulesReason === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(f.rulesReason)))
    || !(f.front === null || (plain(f.front) && UUID.test(f.front.claimId ?? '') && (f.front.pr === null || Number.isSafeInteger(f.front.pr))))
    || !Array.isArray(f.wouldRevoke) || f.wouldRevoke.length > MAX_REVOKE_LISTED
    || !f.wouldRevoke.every(r => plain(r) && SHA.test(r.headSha ?? '') && Number.isSafeInteger(r.checkRunId) && r.checkRunId > 0)
    || !Number.isSafeInteger(f.wouldRevokeCount) || !plain(f.ledger) || JSON.stringify(f).length > 16384) fail('invalid_train_facts');
  return f;
}
