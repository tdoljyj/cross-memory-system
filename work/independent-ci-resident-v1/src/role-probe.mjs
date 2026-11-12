// C2: a read-only role observation. This module never changes node mode or grants a batch; the executor does (C3, DESIGN §29).
// A held reply is useful only after Owner parking established a retained role row (design 1.4).
// The RPC deliberately cannot tell a holder from an open-to-all role; C3 must not infer parking.
import { check, exactKeys } from './canonical.mjs';

export const ROLE_PROBE_STAGE = 11;
// Smooth hand-over (ADR 0026): a node that is not on duty (STANDBY, and UNCERTAIN, which acts as STANDBY) asks every
// minute, so it takes over about a minute after its new role starts. An idle ACTIVE node asks every 5 minutes: the server ends the
// old holder's role at once but starts the new one only 5 minutes later (binding_role_activation_delay_v1), so an idle old node always
// knows it is STANDBY before the new one can be ACTIVE; asking more often would buy nothing (its publishing is stopped by the live
// admission, never by this probe). Before: STANDBY 15, ACTIVE 30 minutes (C2), chosen when nothing needed a fast take-over.
export const ROLE_PROBE_INTERVAL_MS = Object.freeze({ STANDBY: 60_000, ACTIVE: 5 * 60_000 });
// An uncertain answer (network, server) is retried after 1, 2, 4, then every 5 minutes, in every mode, but never sooner than the
// mode's own interval (DESIGN §29.2 item 5; ADR 0026). TURING 2026-11-11: a probe 2.5 minutes after boot answered uncertain and the node
// stayed UNCERTAIN, taking nothing, for the full 15 minutes; the tail was STANDBY's 15 minutes then and is ACTIVE's 5 now, so a node
// back from a long outage confirms its role within 5 minutes (the failover watchdog only picks a STANDBY whose last probe said not-held).
export const ROLE_PROBE_UNCERTAIN_BACKOFF_MS = Object.freeze([60_000, 120_000, 240_000, 5 * 60_000]);
export const ROLE_PROBE_CODES = Object.freeze({ held: 'ROLE_PROBE_HELD', 'not-held': 'ROLE_PROBE_NOT_HELD',
  uncertain: 'ROLE_PROBE_UNCERTAIN', connection: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED', watchedHead: 'ROLE_PROBE_HELD_WATCHED_HEAD' });
export const ROLE_PROBE_FACT_FIELDS = Object.freeze(['result', 'code']);
export const ROLE_PROBE_NOTICE_KINDS = Object.freeze(['role-probe-uncertain', 'role-probe-connection', 'role-probe-interrupted']);

// Generation 12 (DESIGN §56.2): a queue watch's held answer may name the watched PR as the merge-slot holder
// (ROLE_PROBE_HELD_WATCHED_HEAD). For the node mode it is a plain held answer: roleBookFact turns it into one, so the book
// (snapshot, receipts' state) only ever stores the four codes an earlier generation can read back.
export function validateRoleProbeFact(v) {
  exactKeys(v, ROLE_PROBE_FACT_FIELDS, 'ROLE_PROBE_FACT_REFUSED');
  check((v.result === 'held' && [ROLE_PROBE_CODES.held, ROLE_PROBE_CODES.watchedHead].includes(v.code))
    || (v.result === 'not-held' && v.code === ROLE_PROBE_CODES['not-held'])
    || (v.result === 'uncertain' && [ROLE_PROBE_CODES.uncertain, ROLE_PROBE_CODES.connection].includes(v.code)), 'ROLE_PROBE_FACT_REFUSED');
  return Object.freeze({ result: v.result, code: v.code });
}
export const roleBookFact = f => (f.code === ROLE_PROBE_CODES.watchedHead ? Object.freeze({ result: 'held', code: ROLE_PROBE_CODES.held }) : f);

// `idle` comes from the executor's authoritative ledger, never from the advisory status file.
// A backward or invalid clock is not due. No timer, receipt, ledger or network lives in this class.
// `urgent` (C3, DESIGN §29): the next idle tick probes without waiting for the interval. The executor sets it at a start, after an
// Owner re-arm, and after a failure that may mean the role is gone; any observation clears it. It is not part of the stored
// book (snapshot/restore): a restart is urgent anyway.
export class RoleProbe {
  constructor() { this.last = null; this.failures = 0; this.failingSince = null; this.connectionNotified = false; this.uncertainNotified = false; this.urgent = false; }
  markUrgent() { this.urgent = true; }
  snapshot() { return { last: this.last, failures: this.failures, failingSince: this.failingSince, connectionNotified: this.connectionNotified, uncertainNotified: this.uncertainNotified }; }
  restore(v) {
    exactKeys(v, ['last', 'failures', 'failingSince', 'connectionNotified', 'uncertainNotified'], 'ROLE_PROBE_BOOK_REFUSED');
    check(Number.isSafeInteger(v.failures) && v.failures >= 0 && typeof v.connectionNotified === 'boolean' && typeof v.uncertainNotified === 'boolean', 'ROLE_PROBE_BOOK_REFUSED');
    if (v.last !== null) {
      exactKeys(v.last, ['at', 'result', 'code'], 'ROLE_PROBE_BOOK_REFUSED');
      validateRoleProbeFact({ result: v.last.result, code: v.last.code });
      check(Number.isSafeInteger(v.last.at) && v.last.at > 0, 'ROLE_PROBE_BOOK_REFUSED');
    }
    check(v.failures === 0 ? v.failingSince === null && !v.connectionNotified && !v.uncertainNotified
      : v.last?.result === 'uncertain' && Number.isSafeInteger(v.failingSince) && v.failingSince > 0 && v.failingSince <= v.last.at
        && v.uncertainNotified === (v.failures >= 3), 'ROLE_PROBE_BOOK_REFUSED');
    check(v.last !== null || v.failures === 0, 'ROLE_PROBE_BOOK_REFUSED');
    Object.assign(this, structuredClone(v));
  }
  // mode: the node mode, ACTIVE, STANDBY or UNCERTAIN (UNCERTAIN is STANDBY). A run of uncertain answers backs off (failures > 0
  // only after an uncertain answer, restore() checks it), never below the mode's own interval.
  interval(mode) {
    const base = ROLE_PROBE_INTERVAL_MS[mode === 'UNCERTAIN' ? 'STANDBY' : mode];
    return this.failures > 0 ? Math.max(base, ROLE_PROBE_UNCERTAIN_BACKOFF_MS[Math.min(this.failures, ROLE_PROBE_UNCERTAIN_BACKOFF_MS.length) - 1]) : base;
  }
  due({ now, mode, idle }) {
    return idle === true && Number.isSafeInteger(now) && now > 0 && (mode === 'UNCERTAIN' || Object.hasOwn(ROLE_PROBE_INTERVAL_MS, mode))
      && (this.last === null || (now >= this.last.at && (this.urgent === true || now - this.last.at >= this.interval(mode))));
  }
  observe(fact, now) {
    const f = validateRoleProbeFact(fact);
    check(Number.isSafeInteger(now) && now > 0 && (this.last === null || now >= this.last.at), 'ROLE_PROBE_CLOCK_REFUSED');
    const notices = [];
    if (f.result === 'uncertain') {
      this.failures++;
      this.failingSince ??= now;
      if (f.code === ROLE_PROBE_CODES.connection && !this.connectionNotified) {
        this.connectionNotified = true;
        notices.push({ kind: 'role-probe-connection', key: `role-probe-connection:${now}`, code: f.code, at: new Date(now).toISOString() });
      }
      if (this.failures >= 3 && !this.uncertainNotified) {
        this.uncertainNotified = true;
        notices.push({ kind: 'role-probe-uncertain', key: `role-probe-uncertain:${this.failingSince}`, code: ROLE_PROBE_CODES.uncertain, at: new Date(now).toISOString() });
      }
    } else {
      this.failures = 0; this.failingSince = null; this.connectionNotified = false; this.uncertainNotified = false;
    }
    this.last = Object.freeze({ at: now, ...f });
    this.urgent = false;
    return { probe: { at: new Date(now).toISOString(), result: f.result, failures: this.failures,
      failingSince: this.failingSince === null ? null : new Date(this.failingSince).toISOString() }, notices };
  }
}
