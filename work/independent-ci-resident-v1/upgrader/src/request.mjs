// Upgrade and cancel requests (spec A3): resident\upgrade\inbox\<13 ms>-<12 hex>.json, at most 2 KiB each, create-only for
// the Owner (request-upgrade.ps1, unelevated). A request is untrusted data: it names a package by its hash and a local
// directory to read it from; the Owner's Grant on the page, not the request, admits the upgrade.
import { CODE, HEX64, UUID, check, exactKeys, parseBoundedJson, sha256 } from '../../src/canonical.mjs';
import { NODE_NAME, localAbsolutePath } from './config.mjs';
import { U } from './codes.mjs';

export const UPGRADE_REQUEST_CONTRACT = 'clued.independent-ci.resident-upgrade-request/1';
export const UPGRADE_CANCEL_CONTRACT = 'clued.independent-ci.resident-upgrade-cancel/1';
export const REQUEST_MAX_BYTES = 2048;
export const DRAIN_MINUTES = Object.freeze({ min: 10, max: 120, default: 120 });
const NONCE = /^[0-9a-f]{16,32}$/;
const isIso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

export function validateUpgradeRequest(v) {
  const code = U.REQUEST_REFUSED;
  check(v !== null && typeof v === 'object' && !Array.isArray(v) && v.contract === UPGRADE_REQUEST_CONTRACT, code, 'contract');
  const optional = ['drainMaxMinutes', 'note'].filter(k => k in v);
  exactKeys(v, ['contract', 'requestId', 'node', 'packageManifestSha256', 'packageDirectory', 'acceptanceDecisionRef', 'requestedAt', 'nonce', ...optional], code);
  check(UUID.test(v.requestId ?? '') && NODE_NAME.test(v.node ?? '') && HEX64.test(v.packageManifestSha256 ?? '') && UUID.test(v.acceptanceDecisionRef ?? ''), code, 'identity');
  check(localAbsolutePath(v.packageDirectory, 260), code, 'packageDirectory');
  check(v.drainMaxMinutes === undefined || (Number.isSafeInteger(v.drainMaxMinutes) && v.drainMaxMinutes >= DRAIN_MINUTES.min && v.drainMaxMinutes <= DRAIN_MINUTES.max), code, 'drainMaxMinutes');
  check(v.note === undefined || (typeof v.note === 'string' && v.note.length <= 500), code, 'note');
  check(isIso(v.requestedAt) && NONCE.test(v.nonce ?? ''), code, 'time');
  return { ...v, drainMaxMinutes: v.drainMaxMinutes ?? DRAIN_MINUTES.default };
}

export function validateCancelRequest(v) {
  const code = U.REQUEST_REFUSED;
  exactKeys(v, ['contract', 'requestId', 'requestedAt', 'nonce'], code);
  check(v.contract === UPGRADE_CANCEL_CONTRACT && UUID.test(v.requestId ?? '') && isIso(v.requestedAt) && NONCE.test(v.nonce ?? ''), code);
  return v;
}

// One inbox entry: { kind: 'upgrade' | 'cancel', value, sha256 } or a refusal code.
export function parseInboxEntry(bytes) {
  try {
    const v = parseBoundedJson(bytes, REQUEST_MAX_BYTES, U.REQUEST_REFUSED);
    if (v.contract === UPGRADE_CANCEL_CONTRACT) return { kind: 'cancel', value: validateCancelRequest(v), sha256: sha256(bytes) };
    return { kind: 'upgrade', value: validateUpgradeRequest(v), sha256: sha256(bytes) };
  } catch (error) {
    return { kind: 'refused', code: CODE.test(error?.code ?? '') && error.code.startsWith('UPGRADE_') ? error.code : U.REQUEST_REFUSED };
  }
}

// The Grant resource of one upgrade (spec A2): exactly one, matched by equality on the server.
export const GRANT_RESOURCE = /^ci-resident:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\/[0-9a-f]{64}$/;
export function grantResource(node, packageManifestSha256) {
  const r = `ci-resident:${node}/${packageManifestSha256}`;
  check(GRANT_RESOURCE.test(r), U.REQUEST_REFUSED, 'resource');
  return r;
}
