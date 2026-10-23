// KooYomi merge-slot reads with the CI identity (resident quota redesign phase 2, step 3c-1; design v0.5 §5.5 item 1,
// §5.8; DESIGN §21.2). Step 3c-1 reads only: clued_work_merge_slot_holders_v1 (pinned in ci_signatures by migration
// 20261010161848) returns the live merge-slot holder of the repository's queue in this scope. It needs the
// ci-admission role, so it doubles as the on-duty probe: without the role Native answers
// {status:'ok', holders:[], reason:'admission_binding_required'}, which means "not on duty", never "queue empty".
// touch, adopt and return (step 3c-2) are writes and are not here.
import { digest } from '../proof.mjs';

export const HOLDERS_RPC = 'clued_work_merge_slot_holders_v1';
export const NOT_ON_DUTY = 'admission_binding_required';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PR_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,9}$/;
const ISO = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// Pure: the reply -> { onDuty, holders }. Anything else is unreadable (MERGE_SLOT_HOLDERS_UNREADABLE).
export function parseHolders(status, body, repository) {
  if (status !== 200 || !plain(body) || body.status !== 'ok' || !Array.isArray(body.holders)) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
  if (body.reason === NOT_ON_DUTY) return { onDuty: false, holders: [] };
  if (body.reason !== undefined || body.repository !== repository || body.holders.length > 20) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
  const holders = body.holders.map(h => {
    if (!plain(h) || !UUID.test(h.claim_id ?? '') || !(h.bound_pr === null || PR_REF.test(h.bound_pr ?? '')) || !ISO(h.merge_slot_until)) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
    const ci = plain(h.merge_slot_ci) ? h.merge_slot_ci : {};
    const pr = h.bound_pr && h.bound_pr.startsWith(`${repository}#`) ? Number(h.bound_pr.slice(repository.length + 1)) : null;
    return Object.freeze({ claimId: h.claim_id, boundPr: h.bound_pr ?? null, pr, mergeSlotUntil: h.merge_slot_until,
      takenAt: ISO(ci.taken_at) ? ci.taken_at : null, ciState: typeof ci.ci_state === 'string' ? ci.ci_state : null,
      ciHeadSha: typeof ci.ci_head_sha === 'string' ? ci.ci_head_sha : null, hardCapUntil: ISO(ci.hard_cap_until) ? ci.hard_cap_until : null });
  });
  return { onDuty: true, holders };
}

// The read port. config: the installed record's {supabaseUrl, publishableKey, scope, repository}.
export function createMergeSlotNative({ config, fetchImpl, nativeToken }) {
  return Object.freeze({
    async holders() {
      let response, body;
      try {
        response = await fetchImpl(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${HOLDERS_RPC}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { scope: config.scope, repository: config.repository } }) });
        body = await response.json();
      } catch { fail('MERGE_SLOT_HOLDERS_UNREADABLE'); }
      return parseHolders(response.status, body, config.repository);
    },
  });
}
