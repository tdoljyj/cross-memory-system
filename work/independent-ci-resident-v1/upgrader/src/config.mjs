// The upgrader's configuration (clued.independent-ci.resident-upgrader-config/1), installed admin-only at
// upgrader\config\upgrader.json; its SHA-256 is a command-line argument of the service host, and a file that does not hash
// to it is refused. Only public values live here: the token is a separate admin-only file (tokenFile), read when the door is
// called and never logged or copied.
import { check, exactKeys, parseBoundedJson, sha256 } from '../../src/canonical.mjs';
import { readBounded } from '../../src/store.mjs';
// The node name (node-duty.mjs NODE_NAME; spec A2's resource name): kept here so the frozen upgrader loads only a few resident modules.
export const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export const UPGRADER_CONFIG_CONTRACT = 'clued.independent-ci.resident-upgrader-config/1';
export const UPGRADER_CONFIG_MAX_BYTES = 16 * 1024;
export const PAUSE_CONFIRM_MIN_MS = 420_000;
export const DEFAULT_TIMEOUTS = Object.freeze({ drainMaxMinutes: 120, drainRetryMinutes: 60, deferMaxHours: 24, pauseConfirmMs: 600_000, verifyMaxMs: 2_700_000,
  grantPollMs: Object.freeze([30_000, 120_000]) });

const SID = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,200}(?::[0-9]{1,5})?$/;
// A publishable key is public (it is in every web page of the service); a secret key is refused here.
const PUBLISHABLE = /^(?:sb_publishable_[A-Za-z0-9_-]{10,200}|eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,1000})$/;
// An absolute local path: a drive path on Windows, or an absolute POSIX path (tests on other hosts). Never UNC, never `..`.
export function localAbsolutePath(p, max = 260) {
  if (typeof p !== 'string' || p.length === 0 || p.length > max || p.includes('\0')) return false;
  if (p.startsWith('\\\\') || p.startsWith('//')) return false;
  const parts = p.split(/[\\/]/);
  if (parts.includes('..') || parts.includes('.')) return false;
  return /^[A-Za-z]:\\/.test(p) || (process.platform !== 'win32' && p.startsWith('/'));
}

const intIn = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export function validateUpgraderConfig(v) {
  const code = 'UPGRADER_CONFIG_REFUSED';
  exactKeys(v, ['contract', 'node', 'nodeProfileSha256', 'ownerSid', 'root', 'supabaseUrl', 'publishableKey', 'confirmOrigin', 'tokenFile', 'timeouts', 'keepGenerations'], code);
  check(v.contract === UPGRADER_CONFIG_CONTRACT, code, 'contract');
  check(NODE_NAME.test(v.node ?? '') && HEX64.test(v.nodeProfileSha256 ?? '') && SID.test(v.ownerSid ?? ''), code, 'node');
  check(localAbsolutePath(v.root) && localAbsolutePath(v.tokenFile), code, 'paths');
  check(ORIGIN.test(v.supabaseUrl ?? '') && ORIGIN.test(v.confirmOrigin ?? ''), code, 'origins');
  check(typeof v.publishableKey === 'string' && PUBLISHABLE.test(v.publishableKey), code, 'publishableKey');
  const t = v.timeouts;
  exactKeys(t, ['drainMaxMinutes', 'drainRetryMinutes', 'deferMaxHours', 'pauseConfirmMs', 'verifyMaxMs', 'grantPollMs'], code);
  check(intIn(t.drainMaxMinutes, 10, 120) && intIn(t.drainRetryMinutes, 1, 1440) && intIn(t.deferMaxHours, 1, 24), code, 'timeouts');
  // b593aa03 a: a pause is confirmed only after the resident had at least 420 s to finish its first look.
  check(intIn(t.pauseConfirmMs, PAUSE_CONFIRM_MIN_MS, 3_600_000), code, 'pauseConfirmMs');
  check(intIn(t.verifyMaxMs, 60_000, 6 * 3_600_000), code, 'verifyMaxMs');
  check(Array.isArray(t.grantPollMs) && t.grantPollMs.length === 2 && intIn(t.grantPollMs[0], 1_000, 600_000) && intIn(t.grantPollMs[1], t.grantPollMs[0], 600_000), code, 'grantPollMs');
  check(intIn(v.keepGenerations, 2, 10), code, 'keepGenerations');
  return v;
}

// Reads the file once, checks its hash against the one the service host was given, then its shape.
export async function loadUpgraderConfig(file, expectedSha256) {
  check(HEX64.test(expectedSha256 ?? ''), 'UPGRADER_CONFIG_SHA_REQUIRED');
  const bytes = await readBounded(file, UPGRADER_CONFIG_MAX_BYTES, 'UPGRADER_CONFIG_UNREADABLE');
  check(sha256(bytes) === expectedSha256, 'UPGRADER_CONFIG_CHANGED');
  return { config: validateUpgraderConfig(parseBoundedJson(bytes, UPGRADER_CONFIG_MAX_BYTES, 'UPGRADER_CONFIG_REFUSED')), sha256: expectedSha256 };
}

