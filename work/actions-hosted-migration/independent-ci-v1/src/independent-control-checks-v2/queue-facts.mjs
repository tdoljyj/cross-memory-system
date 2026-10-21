// Pure normalization of the existing Native SQL queue array for job contract v2 (DESIGN S6, S8).
// Same rules as v1 queue-facts.mjs, but the claim is the one observed live in this admission (and,
// inside a batch, the sticky batch claim), never a claim pinned in the job. This never admits execution.
export function isCurrentMergeQueueHeadV2(claim, observed, job, now) {
  if (!claim || !observed || claim.claim_id !== observed.claimId || claim.fence !== observed.fence || claim.execution_epoch !== observed.epoch
    || claim.execution_handover_pending !== false || claim.lease_key_required !== false || !Number.isSafeInteger(now) || !Array.isArray(claim.merge_queue)) return false;
  const entries = claim.merge_queue.filter(q => q?.ref === `merge:${job.repo}:main`);
  if (entries.length !== 1) return false;
  const q = entries[0];
  return q.state === 'head' && q.position === 1 && Array.isArray(q.ahead) && q.ahead.length === 0 && q.head?.claim_id === observed.claimId
    && q.head?.bound_pr === `${job.repo}#${job.pr}` && Date.parse(q.head?.since) <= now && Date.parse(q.head?.until) > now && Date.parse(claim.merge_slot_until) > now;
}
