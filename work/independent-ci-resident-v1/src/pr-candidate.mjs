// Is this PR, as one live read shows it now, still a candidate of this resident (DESIGN §72.11; PLAN-resident-draft-batch-20261123 §2)?
// The one judgement every live read of the executor goes through (before a queue row is reserved, before attempt 2, a flow continuation,
// a batch at a safe point) and the poller's draft filter: one fact, one place.
//
// prCandidate(live, subject): live is the companion's pr-head answer ({ number, state, headSha, draft? } or null), subject the batch or
// queue subject (its headSha). Returns
//   null                                   no answer: never a fact (the caller keeps what it did before);
//   { basis: null, live }                  the PR is open at the subject's head and not a draft: it stands;
//   { basis: 'pr-closed', final: true }    closed or merged;
//   { basis: 'head-moved', final: true }   open, another head;
//   { basis: 'pr-draft', final: false }    open at this head but a draft: held, not ended for good. Its next trigger (ready for
//                                          review moves GitHub's updated_at, the poller proposes it again) turns it back on.
// An older reply without the draft key is no draft fact (it stands).
export const PR_CLOSED = 'pr-closed';
export const HEAD_MOVED = 'head-moved';
export const PR_DRAFT = 'pr-draft';
// The queue row's hold (queue.mjs#hold) and the PR page say this code.
export const PR_DRAFT_HELD = 'PR_DRAFT';

// A draft by GitHub's word: only a boolean true (pr-head's draft; the poller passes gh's isDraft as draft).
export const isDraft = pull => pull?.draft === true;

export function prCandidate(live, subject) {
  if (!live || typeof live !== 'object') return null;
  if (live.state !== 'open') return { basis: PR_CLOSED, final: true, live };
  if (live.headSha !== subject.headSha) return { basis: HEAD_MOVED, final: true, live };
  if (isDraft(live)) return { basis: PR_DRAFT, final: false, live };
  return { basis: null, final: false, live };
}
