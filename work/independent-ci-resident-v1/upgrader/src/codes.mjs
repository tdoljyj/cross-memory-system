// The upgrader's failure codes and their categories (spec A8). A category says what follows a code:
//   refused   no side effect; terminal.
//   deferred  no lasting side effect; tried again later (DRAIN every drainRetryMinutes, at most deferMaxHours after the Grant).
//   aborted   the staging is withdrawn and the node restored; terminal (outcome REFUSED).
//   rollback  back to the previous generation; the node stays paused and the Owner is told.
//   owner     the Owner looks, elevated (upgrade-apply.ps1 -Recover); the node stays paused.
//   transient retried inside the step with backoff.
import { check } from '../../src/canonical.mjs';

const CATEGORY_CODES = Object.freeze({
  refused: ['REQUEST_REFUSED', 'NODE_MISMATCH', 'PACKAGE_UNREADABLE', 'PACKAGE_CHANGED', 'PACKAGE_CONTRACT_REFUSED', 'TARGET_OUTSIDE_WHITELIST',
    'CHANNEL_CHANGE_NEEDS_REINSTALL', 'SAME_AS_CURRENT', 'STATE_COMPAT_REFUSED', 'ANOTHER_OP_ACTIVE', 'GRANT_REJECTED', 'GRANT_REVOKED', 'GRANT_EXPIRED',
    'GRANT_STALE', 'GRANT_BINDING_NOT_AUTHORIZED', 'CANCELLED', 'RETRIES_EXHAUSTED'],
  transient: ['GRANT_DOOR_UNAVAILABLE', 'UPGRADER_STOPPED'],
  deferred: ['RESIDENT_HALTED', 'DRAIN_TIMEOUT', 'PAUSE_UNCONFIRMED', 'COMPANION_UNAVAILABLE'],
  aborted: ['WINDOWS_STAGE_REFUSED', 'LINUX_STAGE_REFUSED', 'LINUX_HOST_FACTS_CHANGED', 'LINUX_QUIESCENCE_UNCONFIRMED'],
  rollback: ['SWITCH_FAILED', 'START_FAILED', 'VERIFY_FAILED', 'VERIFY_TIMEOUT', 'VERSION_SKEW'],
  // ROLLBACK_COMPANION_UNAVAILABLE: a rollback that waited its bound for the companion (Owner logged off, host restarted).
  owner: ['ROLLBACK_FAILED', 'JOURNAL_INCONSISTENT', 'ROLLBACK_COMPANION_UNAVAILABLE'],
});

export const CATEGORIES = Object.freeze(Object.keys(CATEGORY_CODES));
export const U = Object.freeze(Object.fromEntries(Object.values(CATEGORY_CODES).flat().map(c => [c, `UPGRADE_${c}`])));
const CATEGORY_OF = new Map(Object.entries(CATEGORY_CODES).flatMap(([cat, codes]) => codes.map(c => [`UPGRADE_${c}`, cat])));
export const UPGRADE_CODES = Object.freeze([...CATEGORY_OF.keys()]);

export function categoryOf(code) {
  const c = CATEGORY_OF.get(code);
  check(c, 'UPGRADE_CODE_UNKNOWN', code);
  return c;
}

// The terminal outcome a code ends in (when it ends the operation).
export function outcomeOf(code) {
  switch (code) {
    case U.GRANT_REJECTED: return 'GRANT_REJECTED';
    case U.GRANT_EXPIRED: return 'GRANT_EXPIRED';
    case U.GRANT_STALE: return 'STALE';
    case U.RETRIES_EXHAUSTED: return 'STALE';
    case U.CANCELLED: return 'CANCELLED';
    default: break;
  }
  const cat = categoryOf(code);
  if (cat === 'refused' || cat === 'aborted' || cat === 'transient') return 'REFUSED';
  if (cat === 'rollback') return 'ROLLED_BACK_PAUSED';
  if (cat === 'owner') return 'ROLLBACK_FAILED';
  return check(false, 'UPGRADE_CODE_NOT_TERMINAL', code);
}

// A code from a port that is not one of ours becomes the step's own default (never free text).
export const ownCode = (code, fallback) => (typeof code === 'string' && CATEGORY_OF.has(code)) ? code : fallback;
