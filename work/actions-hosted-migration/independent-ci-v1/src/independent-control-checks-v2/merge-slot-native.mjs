// KooYomi merge-slot reads with the CI identity (resident quota redesign phase 2, step 3c-1; design v0.5 §5.5 item 1,
// §5.8; DESIGN §21.2). Step 3c-1 reads only: clued_work_merge_slot_holders_v1 (pinned in ci_signatures by migration
// 20261010161848) returns the live merge-slot holder of the repository's queue in this scope. It needs the
// ci-admission role, so it doubles as the on-duty probe: without the role Native answers
// {status:'ok', holders:[], reason:'admission_binding_required'}, which means "not on duty", never "queue empty".
// Merge train (DESIGN §41.4, §41.6): the writes touch, adopt, return, lifecycleReport, keepalive and the sweep watermark, and the read
// nodesStatus (ci_nodes_status: nodes, watchdog, watermarks), are Source A's port (scripts/ci/clued-merge-train-native.mjs),
// offered here with the same config and token. Holders require the Native Task/PR
// projection; an older API is unknown, never authority from its old scalar column.
import { digest } from '../proof.mjs';
import { createMergeTrainNativeWriter } from '../../../../../scripts/ci/clued-merge-train-native.mjs';

export const HOLDERS_RPC = 'clued_work_merge_slot_holders_v1';
export const NOT_ON_DUTY = 'admission_binding_required';
export const HOLDERS_PROJECTION_UNSUPPORTED = 'MERGE_SLOT_HOLDERS_PROJECTION_UNSUPPORTED';
export const YIELD_ACTION = 'merge_queue_yield';
export const YIELD_REASONS = Object.freeze(['cannot_land', 'turn_short']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PR_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]{0,9}$/;
const ISO = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// C2 sanitizes to three states (held, not-held, uncertain; a watch's held may name its own PR as the slot holder): no holder/claim
// data reaches the resident. The database intentionally shares binding_not_authorized for revoked, expired and scope-refused; do not
// pretend to distinguish them.
// watchPr (generation 12, resident DESIGN 56.2; null: no watch): a held answer whose holders are exactly one, bound to
// <repository>#watchPr, is ROLE_PROBE_HELD_WATCHED_HEAD. Still no holder data leaves: one bit about the PR the resident asked for.
export function parseRoleProbe(status, body, repository, watchPr = null) {
  if ((status === 401 || status === 403) && plain(body) && body.code === '42501' && ['binding_not_authorized', 'authorization_revoked_or_expired'].includes(body.message))
    return { result: 'uncertain', code: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED' };
  if (plain(body) && body.reason === NOT_ON_DUTY && (!Array.isArray(body.holders) || body.holders.length !== 0)) return { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' };
  let parsed;
  try { parsed = parseHolders(status, body, repository); } catch { return { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' }; }
  if (!parsed.onDuty) return { result: 'not-held', code: 'ROLE_PROBE_NOT_HELD' };
  const watched = Number.isSafeInteger(watchPr) && watchPr > 0 && parsed.holders.length === 1 && parsed.holders[0].pr === watchPr;
  return { result: 'held', code: watched ? 'ROLE_PROBE_HELD_WATCHED_HEAD' : 'ROLE_PROBE_HELD' };
}

// C2 consumes at most 64 KiB; neither an arbitrary upstream error nor a holder list is logged.
async function roleProbeBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('ROLE_PROBE_BODY_MISSING');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw Error('ROLE_PROBE_BODY_LIMIT'); }
      chunks.push(Buffer.from(value));
    }
    if (size === 0) throw Error('ROLE_PROBE_BODY_MISSING');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } finally { reader.releaseLock(); }
}

// Pure: the reply -> { onDuty, holders }. Anything else is unreadable (MERGE_SLOT_HOLDERS_UNREADABLE).
export function parseHolders(status, body, repository) {
  if (status !== 200 || !plain(body) || body.status !== 'ok' || !Array.isArray(body.holders)) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
  if (body.reason === NOT_ON_DUTY) {
    if (body.holders.length !== 0) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
    return { onDuty: false, holders: [] };
  }
  if (body.reason !== undefined || body.repository !== repository || body.holders.length > 20) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
  const claims = new Set(), tasks = new Set(), targets = new Set();
  const holders = body.holders.map(h => {
    if (!plain(h) || !UUID.test(h.claim_id ?? '') || !ISO(h.merge_slot_until)) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
    if (h.task_id === undefined || h.bound_prs === undefined) fail(HOLDERS_PROJECTION_UNSUPPORTED);
    if (!UUID.test(h.task_id ?? '') || !Array.isArray(h.bound_prs) || h.bound_prs.length > 50
      || claims.has(h.claim_id) || tasks.has(h.task_id)) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
    const refs = h.bound_prs;
    if (refs.some(ref => typeof ref !== 'string' || !PR_REF.test(ref) || !ref.startsWith(`${repository}#`) || targets.has(ref))
      || new Set(refs).size !== refs.length) fail('MERGE_SLOT_HOLDERS_UNREADABLE');
    claims.add(h.claim_id); tasks.add(h.task_id); refs.forEach(ref => targets.add(ref));
    const prs = refs.map(ref => Number(ref.slice(repository.length + 1))).sort((a,b) => a-b);
    const boundPrs = prs.map(pr => `${repository}#${pr}`), pr = prs.length === 1 ? prs[0] : null;
    const ci = plain(h.merge_slot_ci) ? h.merge_slot_ci : {};
    return Object.freeze({ claimId: h.claim_id, taskId: h.task_id, boundPrs: Object.freeze(boundPrs), prs: Object.freeze(prs),
      boundPr: pr === null ? null : `${repository}#${pr}`, pr, mergeSlotUntil: h.merge_slot_until,
      takenAt: ISO(ci.taken_at) ? ci.taken_at : null, ciState: typeof ci.ci_state === 'string' ? ci.ci_state : null,
      ciHeadSha: typeof ci.ci_head_sha === 'string' ? ci.ci_head_sha : null, hardCapUntil: ISO(ci.hard_cap_until) ? ci.hard_cap_until : null });
  });
  return { onDuty: true, holders };
}

// The port. config: the installed record's {supabaseUrl, publishableKey, scope, repository}. Source A's port is built on
// first use, so the role probe and holders never depend on it.
export function createMergeSlotNative({ config, fetchImpl, nativeToken }) {
  let writer = null;
  const write = () => writer ??= createMergeTrainNativeWriter({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey, scope: config.scope,
    repository: config.repository, fetchImpl, nativeToken });
  return Object.freeze({
    touch: async input => write().touch(input),
    adopt: async input => write().adopt(input),
    returnSlot: async input => write().returnSlot(input),
    lifecycleReport: async input => write().lifecycleReport(input),
    keepalive: async input => write().keepalive(input),
    reportSweepWatermark: async input => write().reportSweepWatermark(input),
    nodesStatus: async () => write().nodesStatus(),
    // Migration 20261115150000: the head claim whose front PR cannot land joins its queue again at the back when another claim waits
    // (CI door action merge_queue_yield). -> {onDuty, yielded}; onDuty null: a server without the action (or an answer that cannot be
    // read), which yields nothing and changes nothing. Never throws.
    // Migration 20261119120000: reason turn_short (sent only when given; absent means cannot_land) ends a head's turn that is too short
    // for its front batch even when nobody waits. A server without it refuses the unknown key: onDuty null, nothing written.
    async yieldSlot({ pr, headSha, reason } = {}) {
      if (!Number.isSafeInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(headSha ?? '')
        || (reason !== undefined && !YIELD_REASONS.includes(reason))) return { onDuty: null, yielded: false };
      let response, body;
      try {
        response = await fetchImpl(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/clued_work_verify_v1`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { action: YIELD_ACTION, scope: config.scope, pr_ref: `${config.repository}#${pr}`, head_sha: headSha, ...(reason !== undefined ? { reason } : {}) } }) });
        body = await roleProbeBody(response);
      } catch { return { onDuty: null, yielded: false }; }
      if (response.status === 200 && plain(body) && body.status === 'rejected' && body.error_code === NOT_ON_DUTY) return { onDuty: false, yielded: false };
      if (response.status !== 200 || !plain(body) || body.status !== 'ok' || typeof body.yielded !== 'boolean') return { onDuty: null, yielded: false };
      return { onDuty: true, yielded: body.yielded };
    },
    async roleProbe({ watchPr = null } = {}) {
      let response, body;
      try {
        response = await fetchImpl(`${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${HOLDERS_RPC}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { apikey: config.publishableKey, authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ p_token_hash: digest(nativeToken), p_input: { scope: config.scope, repository: config.repository } }) });
        body = await roleProbeBody(response);
      } catch { return { result: 'uncertain', code: 'ROLE_PROBE_UNCERTAIN' }; }
      return parseRoleProbe(response.status, body, config.repository, watchPr);
    },
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
