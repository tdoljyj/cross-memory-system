// Swap broker request/response contracts (DESIGN S1). The resident (NT SERVICE\CluedCIResident)
// writes a request; CluedCISwapBroker (LocalSystem, independent-ci-resident-v1/windows/SwapBroker.cs)
// answers. The broker parses the same five request fields with the same bounds; this module is the
// resident side and the offline reference. Pure.
import { HEX64, NONCE32, STAGES_V2, STAGE_MARGIN_MS } from './layout.mjs';

export const BROKER_REQUEST_CONTRACT = 'clued.independent-ci.swap-broker-request/2';
export const BROKER_RESPONSE_CONTRACT = 'clued.independent-ci.swap-broker-response/2';
export const REQUEST_FIELDS = Object.freeze(['contract', 'stage', 'nonce', 'deadline', 'configSha256']);
export const RESPONSE_FIELDS = Object.freeze(['contract', 'requestId', 'ok', 'code', 'started', 'startCallIssued', 'helperPid', 'stoppedInTime',
  'restored', 'accountUnchanged', 'stableBefore', 'stableAfter', 'configurationConflict']);
// Fixed refusal codes of the broker (no free text ever crosses this boundary).
export const BROKER_CODES = Object.freeze(['BROKER_REQUEST_SIZE', 'BROKER_REQUEST_SHAPE', 'BROKER_REQUEST_FIELDS', 'BROKER_REQUEST_EXPIRED',
  'BROKER_REQUEST_INTERRUPTED_NOT_REPEATED', 'BROKER_REQUEST_PREDATES_START', 'BROKER_CONFIG_CHANGED', 'BROKER_HELPER_NOT_ALLOW_LISTED',
  'BROKER_BUSY', 'BROKER_RUNNER_NOT_ORIGINAL_STOPPED', 'BROKER_START_FAILED', 'BROKER_PID_HANDSHAKE_UNCONFIRMED', 'BROKER_HELPER_NOT_STOPPED_IN_TIME',
  'BROKER_ORIGINAL_NOT_RESTORED', 'BROKER_CONFIGURATION_CONFLICT', 'BROKER_UNCONFIRMED']);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export const maxStageWindowMs = n => (STAGES_V2.find(s => s.number === n)?.runMilliseconds ?? 0) + STAGE_MARGIN_MS;

export function makeBrokerRequest({ stage, nonce, configSha256, now }) {
  const row = STAGES_V2.find(s => s.number === stage);
  if (!row || !NONCE32.test(nonce ?? '') || !HEX64.test(configSha256 ?? '') || !Number.isSafeInteger(now)) fail('BROKER_REQUEST_INPUT_INVALID');
  return { contract: BROKER_REQUEST_CONTRACT, stage, nonce, deadline: new Date(now + row.runMilliseconds + 135_000).toISOString(), configSha256 };
}

// Mirror of SwapBroker.Handle's field checks (the broker is authoritative; this is its spec).
export function validateBrokerRequest(v, now) {
  if (!exact(v, REQUEST_FIELDS) || v.contract !== BROKER_REQUEST_CONTRACT) fail('BROKER_REQUEST_SHAPE');
  if (!Number.isSafeInteger(v.stage) || !STAGES_V2.some(s => s.number === v.stage) || !NONCE32.test(v.nonce ?? '') || !HEX64.test(v.configSha256 ?? '')
    || typeof v.deadline !== 'string' || !ISO.test(v.deadline)) fail('BROKER_REQUEST_FIELDS');
  const d = Date.parse(v.deadline);
  if (d > now + maxStageWindowMs(v.stage)) fail('BROKER_REQUEST_FIELDS');
  if (d < now + 120_000) fail('BROKER_REQUEST_EXPIRED');
  return v;
}

export function validateBrokerResponse(v, requestId) {
  if (!exact(v, RESPONSE_FIELDS) || v.contract !== BROKER_RESPONSE_CONTRACT || v.requestId !== requestId || !UUID.test(requestId)) return null;
  for (const k of ['ok', 'started', 'startCallIssued', 'stoppedInTime', 'restored', 'accountUnchanged', 'stableBefore', 'stableAfter', 'configurationConflict']) if (typeof v[k] !== 'boolean') return null;
  if (!(v.code === null || BROKER_CODES.includes(v.code)) || (v.ok && v.code !== null) || (!v.ok && v.code === null)) return null;
  if (!(v.helperPid === null || (Number.isSafeInteger(v.helperPid) && v.helperPid > 0))) return null;
  // ok means: started once, observed running, stopped before the deadline, original restored,
  // account and stable configuration unchanged before and after, no conflict.
  if (v.ok && !(v.started && v.startCallIssued && v.helperPid && v.stoppedInTime && v.restored && v.accountUnchanged && v.stableBefore && v.stableAfter && !v.configurationConflict)) return null;
  return v;
}
