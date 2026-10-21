// Pure normalization of the existing Native SQL queue array. This never admits execution.
export function isCurrentMergeQueueHead(claim,job,now){
 if(!claim||claim.claim_id!==job.claimId||claim.fence!==job.fence||claim.execution_epoch!==job.epoch||claim.execution_handover_pending!==false||claim.lease_key_required!==false||!Number.isSafeInteger(now)||!Array.isArray(claim.merge_queue))return false;
 const entries=claim.merge_queue.filter(q=>q?.ref===`merge:${job.repo}:main`);
 if(entries.length!==1)return false;const q=entries[0];
 return q.state==='head'&&q.position===1&&Array.isArray(q.ahead)&&q.ahead.length===0&&q.head?.claim_id===job.claimId&&q.head?.bound_pr===`${job.repo}#${job.pr}`&&Date.parse(q.head?.since)<=now&&Date.parse(q.head?.until)>now&&Date.parse(claim.merge_slot_until)>now;
}
