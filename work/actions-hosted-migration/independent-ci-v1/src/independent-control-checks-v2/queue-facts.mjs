// Pure normalization of the existing Native SQL queue array for job contract v2 (DESIGN S6, S8).
// Same rules as v1 queue-facts.mjs, but the claim is the one observed live in this admission (and,
// inside a batch, the sticky batch claim), never a claim pinned in the job. This never admits execution.
export function isCurrentMergeQueueHeadV2(claim, observed, job, now) {
  if (!claim || !observed || claim.claim_id !== observed.claimId || claim.fence !== observed.fence || claim.execution_epoch !== observed.epoch
    || claim.execution_handover_pending !== false || typeof claim.lease_key_required !== 'boolean' || !Number.isSafeInteger(now) || !Array.isArray(claim.merge_queue)) return false;
  const entries = claim.merge_queue.filter(q => q?.ref === `merge:${job.repo}:main`);
  if (entries.length !== 1) return false;
  const q = entries[0];
  return q.state === 'head' && q.position === 1 && Array.isArray(q.ahead) && q.ahead.length === 0 && q.head?.claim_id === observed.claimId
    && q.head?.bound_pr === `${job.repo}#${job.pr}` && Date.parse(q.head?.since) <= now && Date.parse(q.head?.until) > now && Date.parse(claim.merge_slot_until) > now;
}

// Resident quota redesign v0.6 §9 phase 1, item 4: "is the claim in the merge queue at all", as a scheduling
// fact the resident carries up (stage 8's neutral exit and the PR page hint of phase 2 use it). It is only a
// fact for scheduling and display, never authority: the merge slot itself is decided by mergeQueueHead above.
// One entry of merge:<repo>:main -> { entered: true, state, position }; none -> { entered: false, ... null };
// anything malformed (several entries, an unknown state) -> null (unknown). Fixed enums and integers only.
// 'none' is Native's own answer for a claim with the merge ref that has no entry in that queue
// (work_claim_merge_queue_view_v1): not in it, never unknown.
export const MERGE_QUEUE_STATES = Object.freeze(['head', 'waiting', 'lapsed', 'out', 'none']);
export function mergeQueueEntryV2(claim, job) {
  if (!claim || typeof claim !== 'object' || typeof job?.repo !== 'string') return null;
  if (claim.merge_queue === null || claim.merge_queue === undefined) return { entered: false, state: null, position: null };
  if (!Array.isArray(claim.merge_queue) || claim.merge_queue.length > 64) return null;
  const entries = claim.merge_queue.filter(q => q?.ref === `merge:${job.repo}:main`);
  if (entries.length === 0) return { entered: false, state: null, position: null };
  const q = entries[0];
  if (entries.length !== 1 || !MERGE_QUEUE_STATES.includes(q.state)) return null;
  const position = Number.isSafeInteger(q.position) && q.position > 0 && q.position <= 10_000 ? q.position : null;
  // lapsed, out and none are not in the queue: a renewal that keeps the ref joins again at the back.
  return { entered: q.state === 'head' || q.state === 'waiting', state: q.state, position };
}
