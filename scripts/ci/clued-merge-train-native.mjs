// Merge train (DESIGN §41.4 "谁调用、用哪个令牌", step 3 of §41.1): the Native write port with the CI identity. The
// resident node's Source v2 entries (stages 1, 8 and 10, run as clued-control) call it with the node's own ci-admission
// Binding token (`clued_bnd_…`, entry-runtime.mjs#controllerPrincipal); Source B (merge-slot-native.mjs) re-exports it.
// Existing server functions only, all pinned to the ci-admission role (migration 20261031060000, step 2a):
//   touch      clued_work_merge_slot_touch_v1   {scope, pr_ref, head_sha, ci_state, hard_cap_minutes?, reason?}
//   adopt      clued_work_claim_adopt_v1        {scope, pr_ref, merge_sha}
//   return     clued_work_merge_slot_return_v1  {scope, pr_ref}
//   keepalive  clued_work_verify_v1             {action: merge_queue_keepalive, scope, repository, pr_refs}
//   watermark  clued_work_verify_v1             {action: train_sweep_watermark, scope, repository, completed_at, updated_cursor, main_sha}
//   nodes      clued_work_verify_v1             {action: ci_nodes_status, scope} (a read: §41.6 Source check)
// The last two are step 2b's (migration 20261031090000). A server before 2b refuses an unknown action exactly like a bad
// input (22023 work_claim_ci_command_invalid), so only this is "not deployed": ci_nodes_status itself answering 22023 (its
// input is fixed) or the function unknown (404 PGRST202); onDuty is then null (the role was not read). A 22023 on the
// watermark while ci_nodes_status answers is a real refusal and surfaces (MERGE_TRAIN_NATIVE_INPUT_REFUSED).
// Every reply is read bounded (64 KiB); writes are parsed strictly, ci_nodes_status tolerantly (a malformed node or
// watermark entry is dropped and counted). No body, token or holder data is ever logged.
// Only one answer means "not on duty": Native's admission_binding_required (no ci-admission role on this Binding).
import { createHash } from 'node:crypto';
import { normalizeTerminalProof } from './clued-pr-task-binding.mjs';

export const TOUCH_RPC = 'clued_work_merge_slot_touch_v1';
export const ADOPT_RPC = 'clued_work_claim_adopt_v1';
export const RETURN_RPC = 'clued_work_merge_slot_return_v1';
export const VERIFY_RPC = 'clued_work_verify_v1';
export const KEEPALIVE_ACTION = 'merge_queue_keepalive';
export const WATERMARK_ACTION = 'train_sweep_watermark';
export const NODES_STATUS_ACTION = 'ci_nodes_status';
export const MERGE_TRAIN_NATIVE_RPCS = Object.freeze([TOUCH_RPC, ADOPT_RPC, RETURN_RPC, VERIFY_RPC]);
export const NOT_ON_DUTY = 'admission_binding_required';
export const MERGE_TRAIN_NATIVE_UNREADABLE = 'MERGE_TRAIN_NATIVE_UNREADABLE';
export const MERGE_TRAIN_NATIVE_INPUT_REFUSED = 'MERGE_TRAIN_NATIVE_INPUT_REFUSED';
export const SWEEP_WATERMARK_NOT_DEPLOYED = 'SWEEP_WATERMARK_NOT_DEPLOYED';
// recorded:false: Native kept a newer (or equal) watermark of this connection, or one committed concurrently (40001).
export const SWEEP_WATERMARK_NOT_NEWER = 'SWEEP_WATERMARK_NOT_NEWER';
export const SWEEP_WATERMARK_NEWER_EXISTS = 'SWEEP_WATERMARK_NEWER_EXISTS';
export const MAX_STATUS_NODES = 64;
export const CI_STATES = Object.freeze(['running', 'green', 'failed']);
export const KEEPALIVE_MAX_PRS = 50;
const BODY_LIMIT = 65536;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9][0-9]{0,9}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const iso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const pr = v => Number.isSafeInteger(v) && v > 0 && v <= 9_999_999_999;
const uuids = v => Array.isArray(v) && v.length <= 100 && v.every(x => UUID.test(x ?? ''));
const sha256hex = s => createHash('sha256').update(s).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const isoOrNull = v => (v === null || v === undefined ? null : iso(v) ? v : undefined);
const refused22023 = r => r.status === 400 && plain(r.body) && r.body.code === '22023' && r.body.message === 'work_claim_ci_command_invalid';
const unknownRpc = r => r.status === 404 && plain(r.body) && r.body.code === 'PGRST202';
function autoRelease(body) {
  check(body.terminal_replayed === undefined || typeof body.terminal_replayed === 'boolean', MERGE_TRAIN_NATIVE_UNREADABLE);
  if (body.auto_release === undefined) {
    check(body.terminal_replayed !== true, MERGE_TRAIN_NATIVE_UNREADABLE);
    return {};
  }
  const r = body.auto_release, keys = ['status','released','reason','receipt_id','retryable'];
  check(plain(r) && Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r,k))
    && ['released','retained','pending'].includes(r.status) && r.released === (r.status === 'released')
    && r.retryable === (r.status === 'pending') && typeof r.reason === 'string' && /^[a-z][a-z0-9_]{0,119}$/.test(r.reason)
    && UUID.test(r.receipt_id ?? ''), MERGE_TRAIN_NATIVE_UNREADABLE);
  check(body.terminal_replayed !== true || r.status === 'released', MERGE_TRAIN_NATIVE_UNREADABLE);
  return { autoRelease: Object.freeze({ ...r }),
    ...(body.terminal_replayed === undefined ? {} : { terminalReplayed: body.terminal_replayed }) };
}

// One entry of ci_failover_nodes_v1 -> the port's shape, or null (malformed: dropped and counted). `node` null: a marked
// connection with no live stage-1 node; its fields null: a node that never sent a heartbeat (§41.6 "no record").
function statusNode(x) {
  if (!plain(x) || !UUID.test(x.binding_id ?? '') || typeof x.agent_name !== 'string' || x.agent_name.length > 200 || typeof x.live !== 'boolean'
    || !(x.rank === null || x.rank === undefined || Number.isSafeInteger(x.rank)) || isoOrNull(x.marked_at) === undefined) return null;
  let node = null;
  if (x.node !== null && x.node !== undefined) {
    const n = x.node;
    if (!plain(n)) return null;
    const name = n.name === null || n.name === undefined ? null : typeof n.name === 'string' && n.name.length <= 200 ? n.name : undefined;
    const source = n.ci_source_manifest_sha256 === null || n.ci_source_manifest_sha256 === undefined ? null : HEX64.test(n.ci_source_manifest_sha256) ? n.ci_source_manifest_sha256 : undefined;
    const text = v => (v === null || v === undefined ? null : typeof v === 'string' && v.length <= 40 ? v : undefined);
    const heard = isoOrNull(n.last_heartbeat_at), state = text(n.state), mode = text(n.mode);
    if ([name, source, heard, state, mode].includes(undefined)) return null;
    node = Object.freeze({ name, sourceManifestSha256: source, state, mode, lastHeartbeatAt: heard });
  }
  return Object.freeze({ bindingId: x.binding_id, agentName: x.agent_name, live: x.live, rank: x.rank ?? null, markedAt: x.marked_at ?? null, node });
}

// The reply: status and JSON body, at most 64 KiB, strict UTF-8. Anything else is unreadable.
async function boundedReply(response) {
  check(Number.isSafeInteger(response?.status), MERGE_TRAIN_NATIVE_UNREADABLE);
  const reader = response.body?.getReader?.();
  check(reader, MERGE_TRAIN_NATIVE_UNREADABLE);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) { await reader.cancel().catch(() => {}); fail(MERGE_TRAIN_NATIVE_UNREADABLE); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  check(size > 0, MERGE_TRAIN_NATIVE_UNREADABLE);
  return { status: response.status, body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) };
}

export function createMergeTrainNativeWriter({ supabaseUrl, publishableKey, scope, repository, fetchImpl, nativeToken } = {}) {
  check(typeof supabaseUrl === 'string' && /^https:\/\/[^/\s]+\/?$/.test(supabaseUrl) && typeof publishableKey === 'string' && publishableKey.length > 0
    && typeof scope === 'string' && (scope === 'global' || /^project:[A-Za-z0-9-]{1,64}$/.test(scope)) && REPO.test(repository ?? '')
    && typeof fetchImpl === 'function' && typeof nativeToken === 'string' && nativeToken.length > 0, MERGE_TRAIN_NATIVE_INPUT_REFUSED);
  const base = supabaseUrl.replace(/\/$/, ''), tokenHash = sha256hex(nativeToken);
  const prRef = n => `${repository}#${n}`;
  async function call(rpc, input) {
    let reply;
    try {
      const response = await fetchImpl(`${base}/rest/v1/rpc/${rpc}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { apikey: publishableKey, authorization: `Bearer ${publishableKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ p_token_hash: tokenHash, p_input: input }) });
      reply = await boundedReply(response);
    } catch { fail(MERGE_TRAIN_NATIVE_UNREADABLE); }
    return reply;
  }
  const ok = ({ status, body }) => { check(status === 200 && plain(body), MERGE_TRAIN_NATIVE_UNREADABLE); return body; };
  const port = Object.freeze({
    // ci_state running/green need hard_cap_minutes (60..180, the policy's train.slotHardCapMinutes); failed may omit it.
    async touch({ pr: n, headSha, ciState, hardCapMinutes, reason } = {}) {
      check(pr(n) && SHA.test(headSha ?? '') && CI_STATES.includes(ciState)
        && (hardCapMinutes === undefined ? ciState === 'failed' : Number.isSafeInteger(hardCapMinutes) && hardCapMinutes >= 60 && hardCapMinutes <= 180)
        && (reason === undefined || (typeof reason === 'string' && reason.length >= 1 && reason.length <= 300 && !/[\x00-\x1f\x7f]/.test(reason))), MERGE_TRAIN_NATIVE_INPUT_REFUSED);
      const input = { scope, pr_ref: prRef(n), head_sha: headSha, ci_state: ciState, ...(hardCapMinutes === undefined ? {} : { hard_cap_minutes: hardCapMinutes }), ...(reason === undefined ? {} : { reason }) };
      const b = ok(await call(TOUCH_RPC, input));
      check(b.status === 'ok', MERGE_TRAIN_NATIVE_UNREADABLE);
      if (b.reason === NOT_ON_DUTY) { check(b.touched === false, MERGE_TRAIN_NATIVE_UNREADABLE); return { onDuty: false, touched: false, until: null, claims: [], returned: null }; }
      check(b.ci_state === ciState && b.pr_ref === input.pr_ref && b.head_sha === headSha, MERGE_TRAIN_NATIVE_UNREADABLE);
      if (ciState === 'failed') {
        check(typeof b.returned === 'boolean' && uuids(b.merge_slot_returned) && uuids(b.notified) && b.returned === b.merge_slot_returned.length > 0, MERGE_TRAIN_NATIVE_UNREADABLE);
        return { onDuty: true, touched: b.returned, until: null, claims: [...b.merge_slot_returned], returned: b.returned };
      }
      check(typeof b.touched === 'boolean' && uuids(b.claims) && b.touched === b.claims.length > 0
        && (b.touched ? iso(b.merge_slot_until) : b.merge_slot_until === null && b.reason === 'no_live_slot_for_pr'), MERGE_TRAIN_NATIVE_UNREADABLE);
      return { onDuty: true, touched: b.touched, until: b.touched ? b.merge_slot_until : null, claims: [...b.claims], returned: null };
    },
    async adopt({ pr: n, mergeSha, terminalProof } = {}) {
      check(pr(n) && SHA.test(mergeSha ?? ''), MERGE_TRAIN_NATIVE_INPUT_REFUSED);
      const proof = terminalProof === undefined ? null : normalizeTerminalProof(terminalProof,
        { repository, prNumber: n, merged: true, mergeSha });
      const b = ok(await call(ADOPT_RPC, { scope, pr_ref: prRef(n), merge_sha: mergeSha,
        ...(proof ? { terminal_proof: proof } : {}) }));
      if (b.status === 'ok' && b.reason === NOT_ON_DUTY) { check(b.adopted === false, MERGE_TRAIN_NATIVE_UNREADABLE); return { onDuty: false, adopted: false, returned: [] }; }
      // Native's own refusal of a copy that is out (copy_not_adopted) is an answer: not adopted.
      // Every answer past the role check echoes the PR (migration 20261031060000 appends pr_ref); an adoption names its claim.
      check(((b.status === 'ok' && typeof b.adopted === 'boolean') || (b.status === 'rejected' && b.error_code === 'copy_not_adopted')) && b.pr_ref === prRef(n)
        && (!(b.status === 'ok' && b.adopted) || UUID.test(b.claim_id ?? '')), MERGE_TRAIN_NATIVE_UNREADABLE);
      check(b.merge_slot_returned === undefined || uuids(b.merge_slot_returned), MERGE_TRAIN_NATIVE_UNREADABLE);
      return { onDuty: true, adopted: b.status === 'ok' && b.adopted, returned: [...(b.merge_slot_returned ?? [])], ...autoRelease(b) };
    },
    async returnSlot({ pr: n, terminalProof } = {}) {
      check(pr(n), MERGE_TRAIN_NATIVE_INPUT_REFUSED);
      const proof = terminalProof === undefined ? null : normalizeTerminalProof(terminalProof,
        { repository, prNumber: n, merged: false });
      const b = ok(await call(RETURN_RPC, { scope, pr_ref: prRef(n), ...(proof ? { terminal_proof: proof } : {}) }));
      check(b.status === 'ok' && typeof b.returned === 'boolean', MERGE_TRAIN_NATIVE_UNREADABLE);
      if (b.reason === NOT_ON_DUTY) { check(b.returned === false, MERGE_TRAIN_NATIVE_UNREADABLE); return { onDuty: false, returned: false, claims: [] }; }
      check(b.pr_ref === prRef(n) && uuids(b.merge_slot_returned) && b.returned === b.merge_slot_returned.length > 0, MERGE_TRAIN_NATIVE_UNREADABLE);
      return { onDuty: true, returned: b.returned, claims: [...b.merge_slot_returned], ...autoRelease(b) };
    },
    // prs: the repository's pull requests the caller has just read as open (at most 50, distinct).
    async keepalive({ prs } = {}) {
      check(Array.isArray(prs) && prs.length <= KEEPALIVE_MAX_PRS && prs.every(pr) && new Set(prs).size === prs.length, MERGE_TRAIN_NATIVE_INPUT_REFUSED);
      const refs = prs.map(prRef);
      const b = ok(await call(VERIFY_RPC, { action: KEEPALIVE_ACTION, scope, repository, pr_refs: refs }));
      if (b.status === 'rejected' && b.error_code === NOT_ON_DUTY) return { onDuty: false, keptAlive: [] };
      check(b.status === 'ok' && b.repository === repository && Array.isArray(b.kept_alive) && b.kept_alive.length <= 100, MERGE_TRAIN_NATIVE_UNREADABLE);
      const keptAlive = b.kept_alive.map(k => {
        check(plain(k) && UUID.test(k.claim_id ?? '') && PR_REF.test(k.bound_pr ?? '') && refs.includes(k.bound_pr) && iso(k.expires_at) && iso(k.previous_expires_at)
          && Date.parse(k.expires_at) > Date.parse(k.previous_expires_at) && (k.receipt_id === null || UUID.test(k.receipt_id ?? '')), MERGE_TRAIN_NATIVE_UNREADABLE);
        return Object.freeze({ claimId: k.claim_id, boundPr: k.bound_pr, expiresAt: k.expires_at });
      });
      check(new Set(keptAlive.map(k => k.claimId)).size === keptAlive.length, MERGE_TRAIN_NATIVE_UNREADABLE);
      return { onDuty: true, keptAlive };
    },
    // Reported once per complete on-mode full sweep whose revocations were all confirmed (§41.6). Informational only: no
    // node uses a watermark to skip its take-over sweep (revocations_list lists open publications only; review R2 B1).
    async reportSweepWatermark({ completedAt, updatedCursor, mainSha } = {}) {
      check(iso(completedAt) && iso(updatedCursor) && Date.parse(updatedCursor) <= Date.parse(completedAt) && SHA.test(mainSha ?? ''), MERGE_TRAIN_NATIVE_INPUT_REFUSED);
      const reply = await call(VERIFY_RPC, { action: WATERMARK_ACTION, scope, repository, completed_at: completedAt, updated_cursor: updatedCursor, main_sha: mainSha });
      if (unknownRpc(reply)) return { onDuty: null, recorded: false, reason: SWEEP_WATERMARK_NOT_DEPLOYED };
      if (refused22023(reply)) {
        // Unknown action (before 2b) or a refused input (2b): ci_nodes_status tells them apart.
        const probe = await port.nodesStatus();
        if (probe.deployed === false) return { onDuty: null, recorded: false, reason: SWEEP_WATERMARK_NOT_DEPLOYED };
        if (probe.onDuty === false) return { onDuty: false, recorded: false, reason: NOT_ON_DUTY };
        fail(MERGE_TRAIN_NATIVE_INPUT_REFUSED);
      }
      // 40001 work_claim_ci_command_conflict: a newer report of this connection committed in between (after the role check).
      if (reply.status !== 200 && plain(reply.body) && reply.body.code === '40001' && reply.body.message === 'work_claim_ci_command_conflict')
        return { onDuty: true, recorded: false, reason: SWEEP_WATERMARK_NEWER_EXISTS };
      const b = ok(reply);
      if (b.status === 'rejected' && b.error_code === NOT_ON_DUTY) return { onDuty: false, recorded: false, reason: NOT_ON_DUTY };
      check(b.status === 'ok' && typeof b.recorded === 'boolean' && b.repository === repository.toLowerCase() && iso(b.completed_at) && UUID.test(b.receipt_id ?? ''), MERGE_TRAIN_NATIVE_UNREADABLE);
      return { onDuty: true, recorded: b.recorded, reason: b.recorded ? null : SWEEP_WATERMARK_NOT_NEWER };
    },
    // The role holder's view of every node (§41.6): -> { onDuty, deployed, observedAt, watchdog, nodes, dropped, sweepWatermark }.
    // Not on duty: { onDuty:false, deployed:true, nodes:null, ... }. Not deployed (before 2b): { onDuty:null, deployed:false,
    // nodes:null, ... }: no node record exists, which §41.6 treats as "no record". The reply's frame (status, nodes array) is
    // strict; one malformed node or watermark is dropped and counted, never fatal; past MAX_STATUS_NODES the rest is dropped.
    async nodesStatus() {
      const none = (onDuty, deployed) => ({ onDuty, deployed, observedAt: null, watchdog: null, nodes: null, dropped: 0, sweepWatermark: null });
      const reply = await call(VERIFY_RPC, { action: NODES_STATUS_ACTION, scope });
      if (unknownRpc(reply) || refused22023(reply)) return none(null, false);
      const b = ok(reply);
      if (b.status === 'rejected' && b.error_code === NOT_ON_DUTY) return none(false, true);
      check(b.status === 'ok' && iso(b.observed_at) && Array.isArray(b.nodes) && (b.sweep_watermarks === undefined || Array.isArray(b.sweep_watermarks)), MERGE_TRAIN_NATIVE_UNREADABLE);
      let dropped = Math.max(0, b.nodes.length - MAX_STATUS_NODES);
      const nodes = [];
      for (const x of b.nodes.slice(0, MAX_STATUS_NODES)) { const n = statusNode(x); if (n) nodes.push(n); else dropped++; }
      const w = plain(b.watchdog) && typeof b.watchdog.stale === 'boolean' && isoOrNull(b.watchdog.last_tick_at) !== undefined
        ? Object.freeze({ lastTickAt: b.watchdog.last_tick_at ?? null, stale: b.watchdog.stale }) : null;
      let sweepWatermark = null;
      for (const x of (b.sweep_watermarks ?? []).slice(0, MAX_STATUS_NODES)) {
        if (!plain(x) || typeof x.repository !== 'string' || !iso(x.completed_at) || !iso(x.updated_cursor) || !SHA.test(x.main_sha ?? '')) { dropped++; continue; }
        if (x.repository === repository.toLowerCase()) sweepWatermark = Object.freeze({ completedAt: x.completed_at, updatedCursor: x.updated_cursor, mainSha: x.main_sha });
      }
      return { onDuty: true, deployed: true, observedAt: b.observed_at, watchdog: w, nodes: Object.freeze(nodes), dropped, sweepWatermark };
    },
  });
  return port;
}
