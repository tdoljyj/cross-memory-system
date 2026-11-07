// Generation 12 (resident DESIGN 56.4; Owner decisions "第 12 代‘推送后全自动’设计决定" 1 = A, 2 approved, and 207c0cd0 v3/v4: through the
// existing CI command door, the anon surface stays CI8; the server checks no Owner Grant for the join and trusts the admission check):
// the CI identity's two claim-assist writes on Native, actions of the door
// clued_work_verify_v1, for the claim bound to the batch's PR whose head Native admitted for its current execution epoch:
//   merge_queue_join  {action, scope, pr_ref, head_sha}           puts merge:<repo>:main into the claim's trigger_refs (the back of
//                                                                  the queue), never the lease, fence, lease_version or progress
//   lease_extend      {action, scope, pr_ref, head_sha, minutes}  expires_at = least(max(expires_at, now + minutes), the claim's hard
//                                                                  deadline), never an expired claim
// The callers' obligation (Decision 207c0cd0 v4): call them only for a head whose full admission (including the Owner review where one
// is needed) has just passed in this run, i.e. after an observation that passed factsValid (publisher.mjs#waitForQueueHead) or a SETTLED
// stage 1 (stage1WithLease). Joining is not merging: the merge still needs the required checks, which require the Grant.
// Both are idempotent and the server bounds them (an extension at most every 5 minutes, 1..180 minutes). They are claim
// maintenance, not publications: no GitHub check, no Native publication record, nothing a later stage or the merge gate reads as
// authority. So a stage counts them in no sideEffects (a clean not-ready stage 8 stays a clean park), and a failure is only
// recorded: the batch goes on exactly as without them (the holder's own renewal and the resident's reminder, DESIGN §56.3).
// The port never throws. A server without the actions (the door refuses an unknown action with 22023 work_claim_ci_command_invalid;
// 404 / PGRST202 without the door) answers NOT_DEPLOYED; the door's {status:'rejected'} (not the CI admission binding) is REFUSED.
// Neither action is a read (entry-runtime.mjs#nativeReadPost lists only the door's read actions), so no layer repeats them.
import { digest } from '../proof.mjs';
import { isTrainFrontJobV2 } from '../job-v2.mjs';
import { mergeQueueEntryV2 } from './queue-facts.mjs';

export const DOOR_RPC = 'clued_work_verify_v1';
export const JOIN_ACTION = 'merge_queue_join';
export const EXTEND_ACTION = 'lease_extend';
export const CLAIM_ASSIST_TIMEOUT_MS = 10_000;
// The lease a stage asks for, in minutes from now, when less than that is left: stage 1 covers an average batch (LEASE_BATCH_ESTIMATE_MS,
// 22 minutes) plus stage 8 and the merge (LEASE_MARGIN_MS, 30 minutes) with room (DESIGN §56.3); a stage-8 try asks for the most Native gives (180): the longest back-off to the next try
// (PARK_RETRY_MS, 120 minutes) plus the resident's reminder margin (LEASE_MARGIN_MS, 30 minutes) plus room, so a lease the CI keeps
// extending never triggers the renewal reminder before the next try (review round 17, MINOR 1).
export const STAGE1_LEASE_MINUTES = 90;
export const STAGE8_LEASE_MINUTES = 180;
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
export const CLAIM_ASSIST_BODY_MAX = 65536;
const isoOf = v => (typeof v === 'string' && v.length <= 40 && ISO.test(v) && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
// At most CLAIM_ASSIST_BODY_MAX bytes of JSON, like the other Native reads of a controller entry; anything else is null.
async function boundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > CLAIM_ASSIST_BODY_MAX) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
  } finally { try { reader.releaseLock(); } catch { /* released */ } }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { return null; }
}

export function createClaimAssistNative({ config, fetchImpl, nativeToken }) {
  const base = `${String(config?.supabaseUrl ?? '').replace(/\/$/, '')}/rest/v1/rpc/`;
  async function call(action, input) {
    let response, body;
    try {
      response = await fetchImpl(base + DOOR_RPC, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(CLAIM_ASSIST_TIMEOUT_MS),
        headers: { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { action, scope: config.scope, ...input } }) });
    } catch { return { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' }; }
    let cut = false;
    try { body = await boundedJson(response); } catch { body = null; cut = true; }
    if (response.status === 404 || (plain(body) && body.code === 'PGRST202')
      || (plain(body) && body.code === '22023' && /work_claim_ci_command_invalid/.test(String(body.message ?? '')))) return { ok: false, code: 'CLAIM_ASSIST_NOT_DEPLOYED' };
    // A 5xx, or a stream cut while the answer was read (review round 27, NIT 3): the door was not reached for sure.
    if (response.status >= 500 || cut) return { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' };
    if (response.status !== 200 || !plain(body) || body.status !== 'ok') return { ok: false, code: 'CLAIM_ASSIST_REFUSED' };
    return { ok: true, body };
  }
  const reasonOf = body => (typeof body?.reason === 'string' && CODE.test(body.reason) ? body.reason : null);
  // Never throws, also on a malformed config or subject (they are refused before anything is sent).
  const safe = async (action, pr, headSha, extra) => {
    // A head that is not 40 lower-case hex is refused here, so the door's 22023 always means an older door (NOT_DEPLOYED).
    if (!plain(config) || typeof config.repository !== 'string' || !Number.isSafeInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(headSha ?? '')) return { ok: false, code: 'CLAIM_ASSIST_REFUSED' };
    try { return await call(action, { pr_ref: `${config.repository}#${pr}`, head_sha: headSha, ...extra }); } catch { return { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' }; }
  };
  return Object.freeze({
    // mergeQueue (generation 28): the claim's merge-queue entry as the answer's merge_queue (the claim view's, as a renewal answers it) says
    // it (queue-facts.mjs#mergeQueueEntryV2), or null when the answer names none or it does not normalize.
    async joinQueue({ pr, headSha } = {}) {
      const r = await safe(JOIN_ACTION, pr, headSha, {});
      return r.ok ? { ok: true, joined: r.body.joined === true, reason: reasonOf(r.body),
        mergeQueue: Object.hasOwn(r.body, 'merge_queue') ? mergeQueueEntryV2({ merge_queue: r.body.merge_queue }, { repo: config.repository }) : null } : r;
    },
    // expiresAt: the lease end Native answered (normalized), else null.
    async extendLease({ pr, headSha, minutes } = {}) {
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 180) return { ok: false, code: 'CLAIM_ASSIST_REFUSED' };
      const r = await safe(EXTEND_ACTION, pr, headSha, { minutes });
      return r.ok ? { ok: true, extended: r.body.extended === true, expiresAt: isoOf(r.body.expires_at), reason: reasonOf(r.body) } : r;
    },
  });
}

// Ask for `minutes` more when the lease Native reported (scheduling.claimExpiresAt) leaves less than that. -> the answer, or null
// when nothing was asked (no lease fact, enough left, no port).
export async function extendLeaseIfShort({ claimAssist, job, claimExpiresAt, minutes, now, record = () => {} }) {
  const expires = Date.parse(claimExpiresAt ?? '');
  if (!claimAssist || !Number.isFinite(expires) || !Number.isSafeInteger(now) || expires - now >= minutes * 60_000) return null;
  let r;
  try { r = await claimAssist.extendLease({ pr: job.pr, headSha: job.headSha, minutes }); } catch { r = { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' }; }
  try { record('native_lease_extend', { jobId: job.id, ok: r.ok === true, extended: r.extended === true, code: r.code ?? r.reason ?? null, minutes }); } catch { /* a log only */ }
  return r;
}

// The lease end to report after an extension answer r (resident DESIGN 56.3, review MAJOR 1 of round 2): Native's new end when it
// answered one; when it said it extended but named no end, none (a stale end would make the resident warn wrongly); else unchanged.
export function leaseAfter(claimExpiresAt, r) {
  if (!r?.ok) return claimExpiresAt ?? null;
  if (r.expiresAt) return r.expiresAt;
  return r.extended ? null : (claimExpiresAt ?? null);
}

// Stage 1 (formal-work-admission-check-v2/startup.mjs): after a SETTLED publication, extend a lease shorter than STAGE1_LEASE_MINUTES
// and report the lease end Native answered. Any other result, and any failure, leaves the result exactly as it was.
export async function stage1WithLease({ result, claimAssist, job, now, record = () => {} }) {
  if (result?.status !== 'SETTLED' || !plain(result.scheduling)) return result;
  const r = await extendLeaseIfShort({ claimAssist, job, claimExpiresAt: result.scheduling.claimExpiresAt, minutes: STAGE1_LEASE_MINUTES, now, record });
  if (!r) return result;
  return { ...result, scheduling: { ...result.scheduling, claimExpiresAt: leaseAfter(result.scheduling.claimExpiresAt, r) } };
}

// Generation 28 (resident docs/adr/0016, defect 1b31b06b; field #1037 15:30-16:09 on 2026-11-07): the train front's batch for an older head H1
// rested at B with REQUIRED_CHECK_FAILED, and its stage 8 returned the merge slot (publisher.mjs#waitForQueueHead: failed work gives the next
// claim its turn), which takes the merge ref off the claim: the claim left the queue. The PR then got a new head H2 (the fix). H2's ordinary
// batch found the claim outside the queue at its stage 1 (mergeQueue entered false, rightly), so the resident did not give way after stage 1
// (executor.mjs#trainFrontYield, DESIGN §62.6), stages 2-7 ran for nothing (13 minutes), and only H2's stage 8 joined the queue again.
// Now, at H2's stage 1, after a SETTLED admission and with the train on, the claim joins the queue again (at its back, as stage 8 would) when
// exactly this is true: this node's newest front batch (train-sweep-store.mjs#latestFrontBatch) is of this PR, of another head, under this
// batch's claim, and Native says the claim is not in the queue now. Native's join answer then says where it stands; only when that is the
// head (position 1) does the resident give way, with every condition of §62.6 unchanged.
//   - Never for a PR this node never opened a front batch for, nor once another PR's front batch is newer: a PR that was not the queue head
//     never joins here, so it never gives way here either (it joins at stage 8 as before).
//   - Joining is not merging and grants nothing (the obligations above: a head whose admission just passed in this run); the front batch
//     still runs stages 1-8 and stage 8 checks every live condition again; a queue that holds other claims puts this one behind them.
//   - Not for a train front job (S != H; it is the front already), only with the train on, only when Native said entered false; any failure
//     leaves the result exactly as it was (logged only).
export async function stage1FrontRequeue({ result, job, trainMode, claimAssist, sweepStore, batchClaim, record = () => {} }) {
  if (trainMode !== 'on' || result?.status !== 'SETTLED' || !plain(result.scheduling) || result.scheduling.mergeQueue?.entered !== false || !claimAssist
    || typeof sweepStore?.latestFrontBatch !== 'function' || typeof batchClaim?.claimId !== 'string') return result;
  try { if (isTrainFrontJobV2(job)) return result; } catch { return result; }
  let front;
  try { front = await sweepStore.latestFrontBatch(); } catch { return result; }
  if (!front || front.pr !== job.pr || front.headSha === job.headSha || front.claimId !== batchClaim.claimId) return result;
  let j;
  try { j = await claimAssist.joinQueue({ pr: job.pr, headSha: job.headSha }); } catch { j = { ok: false, code: 'CLAIM_ASSIST_UNREACHABLE' }; }
  try { record('native_front_requeue', { jobId: job.id, frontHeadSha: front.headSha, ok: j.ok === true, joined: j.joined === true, code: j.code ?? j.reason ?? null,
    mergeQueue: j.mergeQueue ?? null }); } catch { /* a log only */ }
  if (j.ok !== true) return result;
  // In the queue now; where exactly only Native's answer says (an answer without its view: at an unknown place, never the head).
  return { ...result, scheduling: { ...result.scheduling, mergeQueue: j.mergeQueue ?? { entered: true, state: 'waiting', position: null } } };
}
