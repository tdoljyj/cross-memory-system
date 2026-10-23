// The intake pause (resident primary/standby design v0.4 §5.4 step 1, §9 C6; Task 6444f88a; DESIGN §20).
//
// A bounded hold on new batches: while any hold is in force the executor starts no batch from its run queue (no queued
// row, no due attempt 2, no released wait). It interrupts nothing: a batch in flight runs to its end, and a batch at a
// parking point goes on as before (the hosted wait at A is evaluated, stage-8 tries at B run, a supersession or the
// Owner's abort and drain still end it). Triggers are still read into the run queue, so nothing is lost and a parked
// batch still sees main move and a newer commit of its PR. It is the first step of a planned switch-over: the node
// finishes what it has and starts nothing new, then the Owner moves the ci-admission role (design §5.4).
//
// Not the same thing as, and independent of:
//   - PAUSE (PAUSED.json): the emergency stop; it also stops the parked batches, and only the Owner's elevated resume
//     clears it;
//   - the Owner's drain request (executor.mjs#DRAIN_CONTRACT, DESIGN §18.6): one action that ENDS every parked batch
//     before a reinstall;
//   - the Owner's abort (DESIGN §6.5): ends one batch.
// All of them may be in force at once; each keeps its own rules.
//
// Requests come through the user-writable requests\ directory (like PAUSE: any Owner session process may write one;
// tools/rearm-tool.mjs request-intake-pause / request-intake-resume). Each names a holder, so the Owner's own pause and
// the companion's dual-active hold (design §5.2, C5) never cancel each other: the latest word of each holder counts
// (by its requestedAt), and the pause is in force while any holder's hold is. A hold lasts the requested minutes, at
// most INTAKE_PAUSE_MAX_MS from the executor's own clock, and runs out by itself; a holder renews it with a new request
// and lifts it early with a resume. A renewal or a lift lets nobody start anything the Owner stopped: the hold never
// outlives two hours, and PAUSE, HALT and the role fence are unaffected.
//
// Who may lift a hold: any Owner session process, by naming its holder, like the pause itself. Lifting only returns to
// the normal service: the ci-admission role fence and the GitHub read-back (C4) are untouched, and it is no more than an
// Agent of the Owner's account can already do to the dual-active lock by forging a 已交班 status (design §5.2 accepts
// that the PR page statuses are forgeable: availability only). The emergency stop stays PAUSE, which only the Owner's
// elevated resume clears (DESIGN §20.3).
//
// state\INTAKE-PAUSE.json is the service's own state (resident-only modify), replaced whole like the run queue. A file
// that does not validate is copied aside (create-only, kept) and replaced by one hold of holder `unreadable` for the
// full two hours: it fails safe, it is bounded, and the Owner may lift it like any other hold. Until the replacement is
// written the bad file stays where it is, so a crash in between reads it again and holds again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ResidentError, canonicalJson, check, exactKeys, isoNow, parseBoundedJson } from './canonical.mjs';
import { exists, nonce, readBounded } from './store.mjs';

export const INTAKE_PAUSE_CONTRACT = 'clued.independent-ci.resident-intake-pause/1';
export const INTAKE_RESUME_CONTRACT = 'clued.independent-ci.resident-intake-resume/1';
export const INTAKE_STATE_CONTRACT = 'clued.independent-ci.resident-intake-pause-state/1';
export const INTAKE_PAUSE_FILE = 'INTAKE-PAUSE.json';
export const INTAKE_PAUSE_MAX_MS = 2 * 60 * 60_000;
export const INTAKE_PAUSE_MAX_MINUTES = 120;
// A request dated this far ahead of the executor's clock is refused (the writer's clock is wrong).
export const INTAKE_REQUEST_SKEW_MS = 5 * 60_000;
export const INTAKE_HOLDS_MAX = 8;
export const UNREADABLE_HOLDER = 'unreadable';
// The status board's marker for a state that cannot be read now (executor.mjs#intakeTrouble); never a request's holder.
export const UNCONFIRMED_HOLDER = 'unconfirmed';
export const HOLDER = /^[a-z][a-z0-9-]{0,31}$/;
const NONCE = /^[0-9a-f]{12,32}$/;
const INTAKE_STATE_MAX_BYTES = 16 * 1024;
const MIN = 60_000;

const reasonOk = r => typeof r === 'string' && r.length > 0 && r.length <= 200;
const at = v => (typeof v === 'string' && Number.isFinite(Date.parse(v))) ? Date.parse(v) : null;

// A request's own shape (the executor reads at most 1024 bytes of it). Returns the value with requestedAt in ms.
export function validateIntakeRequest(v) {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), 'INTAKE_REQUEST_REFUSED');
  if (v.contract === INTAKE_PAUSE_CONTRACT) {
    exactKeys(v, ['contract', 'holder', 'minutes', 'reason', 'requestedAt', 'nonce'], 'INTAKE_REQUEST_REFUSED');
    check(Number.isSafeInteger(v.minutes) && v.minutes >= 1 && v.minutes <= INTAKE_PAUSE_MAX_MINUTES, 'INTAKE_REQUEST_REFUSED');
  } else {
    check(v.contract === INTAKE_RESUME_CONTRACT, 'INTAKE_REQUEST_REFUSED');
    exactKeys(v, ['contract', 'holder', 'reason', 'requestedAt', 'nonce'], 'INTAKE_REQUEST_REFUSED');
  }
  check(HOLDER.test(v.holder ?? '') && v.holder !== UNCONFIRMED_HOLDER && reasonOk(v.reason) && NONCE.test(v.nonce ?? '') && at(v.requestedAt) !== null, 'INTAKE_REQUEST_REFUSED');
  return { ...v, requestedAtMs: at(v.requestedAt) };
}

// The request bytes the tool (and the companion) write into requests\.
export function intakePauseRequest({ holder = 'owner', minutes = INTAKE_PAUSE_MAX_MINUTES, reason }, clock = Date.now) {
  const v = { contract: INTAKE_PAUSE_CONTRACT, holder, minutes, reason, requestedAt: isoNow(clock), nonce: nonce(8) };
  validateIntakeRequest(v);
  return v;
}

export function intakeResumeRequest({ holder = 'owner', reason }, clock = Date.now) {
  const v = { contract: INTAKE_RESUME_CONTRACT, holder, reason, requestedAt: isoNow(clock), nonce: nonce(8) };
  validateIntakeRequest(v);
  return v;
}

// One hold per holder: { holder, requestedAt, since, until, reason, requestSha256, ended }. ended: null while it may be
// in force, 'expired' or 'resumed' after; an ended hold is kept (its requestedAt orders later requests) until no request
// that old could still be in force, or until a new holder needs its place, then dropped.
function validateState(v) {
  exactKeys(v, ['contract', 'holds'], 'INTAKE_PAUSE_STATE_INVALID');
  check(v.contract === INTAKE_STATE_CONTRACT && Array.isArray(v.holds) && v.holds.length <= INTAKE_HOLDS_MAX, 'INTAKE_PAUSE_STATE_INVALID');
  const seen = new Set();
  for (const h of v.holds) {
    exactKeys(h, ['holder', 'requestedAt', 'since', 'until', 'reason', 'requestSha256', 'ended'], 'INTAKE_PAUSE_STATE_INVALID');
    check(HOLDER.test(h.holder) && !seen.has(h.holder) && at(h.requestedAt) !== null && at(h.since) !== null && at(h.until) !== null
      && typeof h.reason === 'string' && h.reason.length <= 200 && (h.requestSha256 === null || /^[0-9a-f]{64}$/.test(h.requestSha256))
      && [null, 'expired', 'resumed'].includes(h.ended), 'INTAKE_PAUSE_STATE_INVALID');
    seen.add(h.holder);
  }
  return v;
}

export class IntakePause {
  constructor(file, clock, data, unreadable = null) {
    Object.assign(this, { file, clock, data, unreadable });
  }

  // unreadable (when the file did not validate): { keptAs } of the copy kept aside; the caller writes its receipt.
  static async open(stateDir, clock = Date.now) {
    const file = path.join(stateDir, INTAKE_PAUSE_FILE);
    if (!(await exists(file))) return new IntakePause(file, clock, { contract: INTAKE_STATE_CONTRACT, holds: [] });
    try {
      return new IntakePause(file, clock, validateState(parseBoundedJson(await readBounded(file, INTAKE_STATE_MAX_BYTES, 'INTAKE_PAUSE_STATE_INVALID'),
        INTAKE_STATE_MAX_BYTES, 'INTAKE_PAUSE_STATE_INVALID')));
    } catch (error) {
      // An I/O error (a lock) propagates: the executor holds this tick and reads again on the next one.
      if (!(error instanceof ResidentError || error instanceof SyntaxError)) throw error;
      const keptAs = path.join(stateDir, `INTAKE-PAUSE.unreadable-${isoNow(clock).replace(/[:.]/g, '')}-${nonce()}.json`);
      await fs.copyFile(file, keptAs, fs.constants.COPYFILE_EXCL);
      const now = clock();
      const p = new IntakePause(file, clock, { contract: INTAKE_STATE_CONTRACT, holds: [{ holder: UNREADABLE_HOLDER, requestedAt: isoNow(clock), since: isoNow(clock),
        until: new Date(now + INTAKE_PAUSE_MAX_MS).toISOString(), reason: 'INTAKE_PAUSE_STATE_INVALID', requestSha256: null, ended: null }] }, { keptAs: path.basename(keptAs) });
      await p.save();
      return p;
    }
  }

  // Whole-file replacement (temporary file, flush, rename): a crash leaves the old or the new state, never a torn one.
  async save(data = this.data) {
    const bytes = Buffer.from(canonicalJson(data) + '\n', 'utf8');
    check(bytes.length <= INTAKE_STATE_MAX_BYTES, 'INTAKE_PAUSE_STATE_TOO_LARGE');
    const tmp = `${this.file}.${process.pid}.${nonce()}.tmp`;
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, this.file);
    this.data = data;
  }

  // The holds in force at `now`, the latest end first. An end more than two hours ahead (the clock went back) counts as
  // two hours from now; settle() writes it so.
  active(now = this.clock()) {
    const cap = now + INTAKE_PAUSE_MAX_MS;
    return this.data.holds.filter(h => h.ended === null && at(h.until) > now).map(h => (at(h.until) > cap ? { ...h, until: new Date(cap).toISOString() } : h))
      .sort((a, b) => at(b.until) - at(a.until));
  }

  // The status board's view: null when no hold is in force; holder names and times only (the reason is free text from a
  // user session and goes to the receipts, never to the status).
  view(now = this.clock()) {
    const holds = this.active(now);
    if (holds.length === 0) return null;
    return { until: holds[0].until, holders: holds.map(h => ({ holder: h.holder, since: h.since, until: h.until })) };
  }

  // A request as the next state, without writing it: { data, result }. Throws a ResidentError with the refusal's code.
  // result: { kind: 'intake-paused', holder, until, renewed } | { kind: 'intake-resumed', holder, held }.
  apply(request, requestSha256, now = this.clock()) {
    const v = validateIntakeRequest(request);
    check(v.requestedAtMs <= now + INTAKE_REQUEST_SKEW_MS, 'INTAKE_REQUEST_CLOCK_SKEW');
    // An ended hold is dropped once no request as old as its last word could still be in force (such a request ends
    // within two hours of its requestedAt). A hold not yet marked ended stays until settle() has marked it.
    let holds = this.data.holds.filter(h => h.ended === null || at(h.requestedAt) + INTAKE_PAUSE_MAX_MS > now);
    const current = holds.find(h => h.holder === v.holder) ?? null;
    // The latest word of a holder counts: an older request (an out-of-order file, a replayed copy) changes nothing.
    check(!current || v.requestedAtMs > at(current.requestedAt), 'INTAKE_REQUEST_SUPERSEDED');
    const inForce = !!current && current.ended === null && at(current.until) > now;
    let next, result;
    if (v.contract === INTAKE_PAUSE_CONTRACT) {
      const until = Math.min(v.requestedAtMs + v.minutes * MIN, now + INTAKE_PAUSE_MAX_MS);
      check(until > now, 'INTAKE_PAUSE_REQUEST_EXPIRED');
      // A new holder needs a place: the ended hold with the oldest last word gives it up (an ended hold holds nothing;
      // losing its order lets at most an older pause of that holder hold again, the safe way). Eight holds that may all
      // still be in force: refused, while they hold anyway.
      if (!current && holds.length >= INTAKE_HOLDS_MAX) {
        const ended = holds.filter(h => h.ended !== null).sort((a, b) => at(a.requestedAt) - at(b.requestedAt))[0];
        check(ended, 'INTAKE_PAUSE_HOLDERS_FULL');
        holds = holds.filter(h => h !== ended);
      }
      next = { holder: v.holder, requestedAt: new Date(v.requestedAtMs).toISOString(), since: inForce ? current.since : new Date(now).toISOString(),
        until: new Date(until).toISOString(), reason: v.reason, requestSha256, ended: null };
      result = { kind: 'intake-paused', holder: v.holder, until: next.until, renewed: inForce };
    } else {
      // A resume of a holder with no hold in force is accepted and changes nothing but the order of that holder's words.
      // A holder never seen gets no record: a resume never takes a place a pause may need (independent review M2). A hold
      // that ran out but is not marked yet keeps ended null: settle() marks it and writes its receipt.
      const word = { requestedAt: new Date(v.requestedAtMs).toISOString(), requestSha256 };
      if (inForce) next = { ...current, ...word, until: new Date(now).toISOString(), ended: 'resumed' };
      else if (current) next = { ...current, ...word };
      else next = null;
      result = { kind: 'intake-resumed', holder: v.holder, held: inForce };
    }
    const rest = holds.filter(h => h.holder !== v.holder);
    return { data: { contract: INTAKE_STATE_CONTRACT, holds: next ? [...rest, next] : rest }, result };
  }

  // The state as it should be at `now`, or null when it already is: holds that ran out are marked 'expired' (ended: one
  // receipt each, the caller's), and an end more than two hours ahead (the clock went back) is set to two hours from now.
  settle(now = this.clock()) {
    const cap = now + INTAKE_PAUSE_MAX_MS;
    const ran = this.data.holds.filter(h => h.ended === null && at(h.until) <= now);
    const far = this.data.holds.filter(h => h.ended === null && at(h.until) > cap);
    if (ran.length === 0 && far.length === 0) return null;
    return { data: { ...this.data, holds: this.data.holds.map(h => (ran.includes(h) ? { ...h, ended: 'expired' } : far.includes(h) ? { ...h, until: new Date(cap).toISOString() } : h)) },
      ended: ran.map(h => ({ holder: h.holder, since: h.since, until: h.until })) };
  }
}

// The Owner's tool (inspect): the state as the service has it, read-only. A file that cannot be read (its content, or a
// lock) is said so: inspect never fails because of it.
export async function readIntakePause(stateDir, clock = Date.now) {
  const file = path.join(stateDir, INTAKE_PAUSE_FILE);
  try {
    if (!(await exists(file))) return null;
    const p = new IntakePause(file, clock, validateState(parseBoundedJson(await readBounded(file, INTAKE_STATE_MAX_BYTES, 'INTAKE_PAUSE_STATE_INVALID'),
      INTAKE_STATE_MAX_BYTES, 'INTAKE_PAUSE_STATE_INVALID')));
    return { view: p.view(), holds: p.data.holds };
  } catch (error) {
    const code = error instanceof ResidentError ? error.code : error instanceof SyntaxError ? 'INTAKE_PAUSE_STATE_INVALID' : 'INTAKE_PAUSE_STATE_UNAVAILABLE';
    return { view: null, holds: null, unreadable: true, code };
  }
}
