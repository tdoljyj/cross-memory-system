// Two more requests of the user-writable requests\ (where the PAUSE request lives), merge train step 3c-2b (DESIGN §41.8,
// §41.3). Like a PAUSE they can only ask for something safe: any Owner process may write them, none can resume or widen anything.
//   - clued.independent-ci.resident-probe-request/1 ("立即探测"): the next idle tick runs the role probe now. It only calls
//     roleProbe.markUrgent(); it never changes the node mode (the probe's own answer does, DESIGN §29).
//   - clued.independent-ci.resident-revoke-head-request/1 ("撤车头", MergeAdmission v0.2 §4.3 step 2): the next stage 10 in mode
//     on or revoke-only revokes the green of the train front's current head and reads it back twice; the request's id travels
//     to stage 10 as the train run's revokeHeadRequestId and the result goes into the status snapshot (train.revokeHead).
// Both: { contract, requestId (uuid), requestedAt (ISO), reason (1-200 characters) }. A request older than REQUEST_MAX_AGE_MS
// (or more than REQUEST_CLOCK_SKEW_MS ahead) is refused; every request is archived by rename after it was read (inbox.mjs#dispose).
import { randomUUID } from 'node:crypto';
import { check, exactKeys } from './canonical.mjs';

export const PROBE_REQUEST_CONTRACT = 'clued.independent-ci.resident-probe-request/1';
export const REVOKE_HEAD_REQUEST_CONTRACT = 'clued.independent-ci.resident-revoke-head-request/1';
export const RESIDENT_REQUEST_CONTRACTS = Object.freeze([PROBE_REQUEST_CONTRACT, REVOKE_HEAD_REQUEST_CONTRACT]);
export const REQUEST_MAX_AGE_MS = 60 * 60_000;
export const REQUEST_CLOCK_SKEW_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// The request as read (untrusted bytes, already parsed) -> the frozen request, or throws with the refusal code:
// RESIDENT_REQUEST_REFUSED (shape) or RESIDENT_REQUEST_EXPIRED (too old, or from the future).
export function validateResidentRequest(v, now) {
  exactKeys(v, ['contract', 'requestId', 'requestedAt', 'reason'], 'RESIDENT_REQUEST_REFUSED');
  check(RESIDENT_REQUEST_CONTRACTS.includes(v.contract) && UUID.test(v.requestId ?? '') && typeof v.requestedAt === 'string' && ISO.test(v.requestedAt)
    && Number.isFinite(Date.parse(v.requestedAt)) && typeof v.reason === 'string' && v.reason.length >= 1 && v.reason.length <= 200, 'RESIDENT_REQUEST_REFUSED');
  const at = Date.parse(v.requestedAt);
  check(now - at <= REQUEST_MAX_AGE_MS && at - now <= REQUEST_CLOCK_SKEW_MS, 'RESIDENT_REQUEST_EXPIRED');
  return Object.freeze({ contract: v.contract, requestId: v.requestId, requestedAt: at, reason: v.reason });
}

// The request bytes a tool writes (create-only into requests\ through inbox.mjs#Inbox.drop).
export function probeRequest({ reason }, clock = Date.now) {
  return { contract: PROBE_REQUEST_CONTRACT, requestId: randomUUID(), requestedAt: new Date(clock()).toISOString(), reason: String(reason).slice(0, 200) };
}
export function revokeHeadRequest({ reason }, clock = Date.now) {
  return { contract: REVOKE_HEAD_REQUEST_CONTRACT, requestId: randomUUID(), requestedAt: new Date(clock()).toISOString(), reason: String(reason).slice(0, 200) };
}
