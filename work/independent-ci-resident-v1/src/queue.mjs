// The executor's own run queue (resident quota redesign phase 2, step 1: design v0.5 §4.1-§4.5, Task 6451a55d).
//
// One row per PR, in state\queue\queue.json. The queue is a SCHEDULING VIEW, never evidence and never authority: the
// ledger decides what may run (burned and executed heads, the reservation, the release), stage 1's Native admission
// decides what is admitted, and a queue that disagrees with the ledger loses (v0.6 §7 minor 5). A queue file that
// cannot be read is renamed aside (never deleted) and the queue starts over with a new generation; the poller then
// proposes every open PR again (poller.mjs, the status board names the generation), so the queue is rebuilt from the
// poller and the ledger and nothing is ever let through because of it.
//
// The file is replaced whole (temporary file, flush, rename), the way status.json is: every change is one consistent
// snapshot, which is the design's "journal plus compacted snapshot" compacted at every write. It is the service's own
// state (resident-only modify), so nobody else can edit it.
//
// Rules (design v0.5 §4.2; v0.6 §3, §9 phase 2 item 5):
//   - The arrival sequence is numbered by the executor when it reads a trigger, never taken from the writer.
//   - A commit this PR was NEVER seen with replaces the current commit while that one only waits (QUEUED, WAITING,
//     BACKOFF): the old one goes to `superseded` (at most 8), unevaluated and unburned. While the current commit RUNS,
//     the new one becomes current and the running batch decides at its next safe point (executor.mjs#supersededCheck).
//   - A commit seen before never replaces anything (a companion that restarts and proposes an old head again).
//   - A trigger of the current commit is a NEW trigger when it carries no prUpdatedAt (an Agent's own trigger) or a
//     prUpdatedAt newer than the row's: a row that waits for its next try (WAITING, BACKOFF) is then due after the
//     10-minute cool-down; the executor counts it among the 96 evaluations and at most
//     policy.limits.reevaluationsPerPrHeadPer24h times per (PR, commit) and day (v0.6 §9 phase 2 item 1).
//   - When stage 1 or the bundle proves the current commit is no longer the PR's head, the companion reads the PR once;
//     the head it sees becomes current again when it is one of the row's superseded commits and not burned (restore).
//     A live read only ever stops or re-queues; it never admits anything.
//   - After a release the row goes to the tail with its own back-off: 10 -> 20 -> 40 minutes (§4.5); a network release under a /9
//     policy every 10 minutes and towards its own cap (generation 10, NETWORK_BACKOFF_MS). A wait backs off
//     10 -> 20 -> 40 -> 80 -> 120 minutes, then every 120 (§4.4), or until Native's ci_retry_after. A commit released
//     policy.limits.releasesPerHeadPer24h times in 24 hours (waits never count) is STOPPED: only a new commit runs the
//     PR again (§4.5); a new trigger pokes only a row that still waits for its next try.
//   - A row backing off after a claim refusal (CLAIM_REASONS) whose new trigger comes with another claim in the PR body than the one its
//     refused evaluation saw is due at once, without the cool-down (claimChanged; field defect 2026-11-08, PR #1039). The same claim
//     backs off as before.
//   - Depth: at most policy.limits.queueDepth live rows (QUEUED, RUNNING, WAITING, BACKOFF); rows DONE or STOPPED for
//     24 hours are compacted away.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, ResidentError, UUID, canonicalJson, check, isoNow, parseBoundedJson } from './canonical.mjs';
import { ensureDir, exists, nonce, readBounded } from './store.mjs';
import { POSITIONS } from './breaker.mjs';
import { claimBindingFingerprint } from './train.mjs';

export const QUEUE_CONTRACT = 'clued.independent-ci.resident-queue/1';
export const QUEUE_FILE = 'queue.json';
export const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
// PARKED (phase 2, step 2): the row's batch rests at parking point B before stage 8 (its `running` stays set).
export const ROW_STATES = Object.freeze(['QUEUED', 'RUNNING', 'PARKED', 'WAITING', 'BACKOFF', 'STOPPED', 'DONE']);
export const LIVE_STATES = Object.freeze(['QUEUED', 'RUNNING', 'PARKED', 'WAITING', 'BACKOFF']);
// How a row was picked (00-reserved.json keeps it; ledger.mjs#usage counts the waiting budget and the re-evaluations
// from it). attempt2 is the one automatic attempt 2 (attempts.mjs), never a queue row.
export const ORIGINS = Object.freeze(['queued', 'backoff-retry', 'waiting-retry', 'new-trigger', 'restored', 'lifted', 'attempt2']);
// Why a STOPPED row stopped: its head is burned (only a new commit runs it), or it hit the release cap (a new trigger
// after the fix, or a new commit; one an environment fault caused is lifted when the breaker closes).
export const STOP_KINDS = Object.freeze(['burned', 'release-cap']);
export const SUPERSEDED_MAX = 8;
export const SEEN_MAX = 32;
const MIN = 60_000;
export const WAITING_BACKOFF_MS = Object.freeze([10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 120 * MIN]);
export const RELEASE_BACKOFF_MS = Object.freeze([10 * MIN, 20 * MIN, 40 * MIN]);
// Generation 10 (DESIGN 53.3, Task 125a5162 item 3), only under a policy with breaker.network (/9): a release that was the line to GitHub
// or Native (classify.mjs#networkFailure: the executor passes outcome.network) says nothing about the PR. It counts towards the network
// cap (breaker.network.releasesPerHeadPer24h, outcome.networkReleases24h / networkCap), never towards the head's release cap, and is
// tried again every 10 minutes, flat: the breaker throttles a lasting outage for every PR together, and a flat 10 minutes is what makes
// the head run again within 10 minutes of the network coming back (the 10/20/40 ladder would leave it waiting up to 40). At the network
// cap the row stops as an environment stop (stopClass environment), lifted with the other environment stops.
export const NETWORK_BACKOFF_MS = Object.freeze([10 * MIN]);
// The reason a row stopped at the network cap shows (the status board and the PR page say it runs again by itself).
export const NETWORK_RELEASE_CAP_REACHED = 'NETWORK_RELEASE_CAP_REACHED';
export const CI_RETRY_MAX_MS = 24 * 60 * MIN;
export const COMPACT_AFTER_MS = 24 * 60 * MIN;
export const NOTICES_MAX = 50;
// A row deferred for itself is looked at again after this long (the cool-down: when it ends).
export const DEFER_RECHECK_MS = 5 * MIN;
// Field defect 2026-11-08 (PR #1039): stage 1 refused head 2e95bda4 CLAIM_NOT_CURRENT (Native: claim_not_current, fence_superseded), the
// row backed off 10 minutes; a minute later the author put a new, valid claim in the PR body (an edit, a new trigger), but the poke
// was due only after the 10-minute cool-down from that evaluation, so the head waited until the back-off ended anyway. A claim refusal
// is safeToRerun with no side effect, and the PR body naming another claim is exactly what the refusal asked for ("renew or claim,
// then trigger again", failure-table.json). The release codes of a claim refusal: the Source maps every claim reason of stage 1
// (claim_trailer_missing, claim_not_found, claim_not_current, fence_superseded, claim_bound_to_other_pr,
// work_claim_execution_epoch_stale, and the full admission's claim missing / changed / native changed) to CLAIM_NOT_CURRENT
// (Source resident-v2/stage-fact.mjs#notAdmittedCode, #outcomeFailureCode); after stage 1 a moved claim is BATCH_CLAIM_CHANGED,
// which burns the head and never backs off.
export const CLAIM_REASONS = Object.freeze(['CLAIM_NOT_CURRENT']);
// Field defect 2026-11-08 (PR #1043, task 9aafd9ec): three claim refusals in a row (no authorize_head yet, the merge-queue place aged,
// a renew after the push) each counted towards the head's release cap and burned the head, though each is safeToRerun with no side effect
// and the author or the system fixes it by itself. A claim refusal never counts towards the release cap. It uses the waiting
// budget and WAITING_BACKOFF_MS on the same head; only a changed protected Native binding wakes it early. A head that has
// waited for its claim for CLAIM_WAIT_MAX_MS since it arrived stops (release-cap).
export const CLAIM_WAIT_MAX_MS = 24 * 60 * MIN;
const CLAIM_MISSING_REASONS = ['claim_trailer_missing', 'claim_not_found', 'full_admission_claim_missing'];
export const claimWaitText = reason => (CLAIM_MISSING_REASONS.includes(reason) ? '等认领授权此提交' : '认领在推送后变动或队位过期，等下一次检查');
const claimsOk = c => Array.isArray(c) && c.length <= SEEN_MAX && c.every(x => typeof x === 'string' && UUID.test(x));
// claimsOk validates old snapshots only; current scheduling never consumes them.

const delayAt = (table, level) => table[Math.min(Math.max(level, 0), table.length - 1)];
// A queue file that could not be read took the breaker's state with it: half-open, failing "everywhere".
const rebuiltBreaker = now => ({ state: 'half-open', failures: [], streak: 0, streakPos: 0, streakPrs: [], openedAt: now, level: 0, nextTrialAt: null,
  failingPos: POSITIONS.END, failingWindowsOnly: false, exclude: [], closedAt: null });
const time = v => Number.isSafeInteger(v) && v > 0;
// A train front commit (step 3c-2b, DESIGN §41.4; offerFront) also names its tested commit S and its front attempt (1 or 2).
const frontOf = c => (Object.hasOwn(c, 'testSha') ? { testSha: c.testSha, frontAttempt: c.frontAttempt } : {});
const commitOf = c => ({ headSha: c.headSha, baseSha: c.baseSha, seq: c.seq, firstAt: c.firstAt ?? null, ...frontOf(c) });

export function emptyQueue(clock, generation = nonce()) {
  return { contract: QUEUE_CONTRACT, generation, createdAt: clock(), nextSeq: 1, rows: [], breaker: null, notices: [] };
}

const commitOk = c => !!c && HEX40.test(c.headSha ?? '') && HEX40.test(c.baseSha ?? '') && Number.isSafeInteger(c.seq) && c.seq > 0
  && (!Object.hasOwn(c, 'testSha') || (HEX40.test(c.testSha ?? '') && c.testSha !== c.headSha && [1, 2].includes(c.frontAttempt)));
// The stored shape, checked on every load (a file that does not validate is unreadable: renamed aside, start over).
export function validateQueue(q) {
  check(q && q.contract === QUEUE_CONTRACT && /^[0-9a-f]{12}$/.test(q.generation ?? '') && Number.isSafeInteger(q.nextSeq) && q.nextSeq > 0
    && Array.isArray(q.rows) && Array.isArray(q.notices) && (q.breaker === null || (typeof q.breaker === 'object' && !Array.isArray(q.breaker))), 'QUEUE_FILE_INVALID');
  const prs = new Set();
  for (const r of q.rows) {
    check(r && Number.isSafeInteger(r.pr) && r.pr > 0 && !prs.has(r.pr) && ROW_STATES.includes(r.state)
      && (r.current === null || commitOk(r.current)) && (r.running === null || (commitOk(r.running) && /^[0-9a-f]{64}$/.test(r.running.key ?? '')))
      && (!['RUNNING', 'PARKED'].includes(r.state) || r.running !== null) && (r.state === 'DONE' || r.state === 'STOPPED' || r.current !== null)
      && Array.isArray(r.superseded) && r.superseded.length <= SUPERSEDED_MAX && r.superseded.every(commitOk)
      && Array.isArray(r.seen) && r.seen.length <= SEEN_MAX && r.seen.every(h => HEX40.test(h))
      && Number.isSafeInteger(r.order) && Number.isSafeInteger(r.level) && r.level >= 0 && (r.stopKind === null || STOP_KINDS.includes(r.stopKind))
      && (r.origin === null || ORIGINS.includes(r.origin)) && (r.evalClaims === undefined || r.evalClaims === null || claimsOk(r.evalClaims))
      && (r.evalBinding == null || (typeof r.evalBinding === 'string' && r.evalBinding.length <= 512))
      && (r.evalBindingHead == null || HEX40.test(r.evalBindingHead)), 'QUEUE_FILE_INVALID', r?.pr);
    prs.add(r.pr);
  }
  return q;
}

export class RunQueue {
  constructor(dir, clock, data, rebuilt = null) {
    this.dir = dir;
    this.file = path.join(dir, QUEUE_FILE);
    this.clock = clock;
    this.data = data;
    // { keptAs, at } when the stored file could not be read and the queue started over (the executor writes a receipt).
    this.rebuilt = rebuilt;
  }

  static async open(dir, clock = Date.now) {
    await ensureDir(dir);
    const file = path.join(dir, QUEUE_FILE);
    if (!(await exists(file))) return new RunQueue(dir, clock, emptyQueue(clock));
    try {
      return new RunQueue(dir, clock, validateQueue(parseBoundedJson(await readBounded(file, QUEUE_MAX_BYTES, 'QUEUE_FILE_INVALID'), QUEUE_MAX_BYTES, 'QUEUE_FILE_INVALID')));
    } catch (error) {
      // Only content that does not validate starts the queue over; an I/O error (a lock, a busy file) propagates and the
      // service start is retried (independent review of step 1, m4).
      if (!(error instanceof ResidentError || error instanceof SyntaxError)) throw error;
      // Kept, never deleted: the ledger stays the authority, and the new generation makes the poller propose again. The
      // breaker's state was in the file: a queue that starts over starts it half-open, so the next counted failure opens
      // it again at once and only a completed batch closes it.
      const keptAs = path.join(dir, `queue.unreadable-${isoNow(clock).replace(/[:.]/g, '')}-${nonce()}.json`);
      await fs.rename(file, keptAs);
      const fresh = emptyQueue(clock);
      fresh.breaker = rebuiltBreaker(clock());
      return new RunQueue(dir, clock, fresh, { keptAs: path.basename(keptAs), at: clock() });
    }
  }

  // Whole-file replacement: the temporary file is flushed before the rename, so a crash leaves the old or the new
  // snapshot, never a torn one.
  async save() {
    const bytes = Buffer.from(canonicalJson(this.data) + '\n', 'utf8');
    check(bytes.length <= QUEUE_MAX_BYTES, 'QUEUE_FILE_TOO_LARGE');
    if (this.saved && this.saved.equals(bytes)) return false; // nothing changed since the last write
    const tmp = path.join(this.dir, `${QUEUE_FILE}.${process.pid}.${nonce()}.tmp`);
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, this.file);
    this.saved = bytes;
    return true;
  }

  get generation() { return this.data.generation; }
  get breaker() { return this.data.breaker; }
  set breaker(b) { this.data.breaker = b; }
  get notices() { return this.data.notices; }

  row(pr) { return this.data.rows.find(r => r.pr === pr) ?? null; }

  // Only the ledger calls this for a proven flow ending. Re-reading it cannot replace a newer head or a running row,
  // nor repeatedly reorder an already queued continuation. A missing queue is rebuilt from the same durable evidence.
  readmit(subject, now, { depth, cooldownMs }) {
    let r = this.row(subject.pr);
    if (r?.running || (r?.current && (r.current.headSha !== subject.headSha || r.current.testSha !== subject.testSha))) return false;
    if (r && ['QUEUED', 'WAITING', 'BACKOFF'].includes(r.state)) return true;
    if (this.live().length >= depth) return false;
    if (!r) {
      if (this.offer(subject, now, { depth, cooldownMs }).action === 'refused') return false;
      r = this.row(subject.pr);
    }
    r.current ??= { headSha: subject.headSha, baseSha: subject.baseSha, seq: this.seq(), firstAt: now };
    if (Object.hasOwn(subject, 'testSha')) r.current = { ...r.current, testSha: subject.testSha, frontAttempt: 1 };
    Object.assign(r, { nextAt: null, stopKind: null, stopClass: null, poke: null, deferred: null, deferUntil: null, order: this.seq() });
    this.setState(r, 'QUEUED', 'SAFE_POINT_READMISSION', now);
    return true;
  }
  live() { return this.data.rows.filter(r => LIVE_STATES.includes(r.state)); }
  seq() { const s = this.data.nextSeq; this.data.nextSeq += 1; return s; }

  // A notice for the Owner (pr-status.mjs turns each key into one Windows notification).
  notice(n) {
    this.data.notices = [{ ...n, at: n.at ?? this.clock() }, ...this.data.notices.filter(x => x.key !== n.key)].slice(0, NOTICES_MAX);
  }

  setState(row, state, reason, now) {
    if (row.state !== state || row.reason !== reason) row.since = now;
    row.state = state;
    row.reason = reason;
    row.updatedAt = now;
  }

  // One trigger (trigger.mjs#parseTrigger) read now. Returns { action }: new (a new commit of an idle or new row),
  // superseded (it replaced a waiting current commit), pending (the PR's running batch got a newer commit), new-trigger
  // (it poked a row that waits), seen (nothing changed) or refused (the queue is full).
  offer(t, now, { depth, cooldownMs }) {
    let row = this.row(t.pr);
    if (!row) {
      if (this.live().length >= depth) return { action: 'refused', code: 'QUEUE_DEPTH_EXCEEDED' };
      row = { pr: t.pr, current: null, running: null, superseded: [], seen: [], state: 'DONE', reason: null, since: now, nextAt: null, level: 0, levelKind: null,
        order: 0, poke: null, prUpdatedAt: null, lastEvalAt: null, stopKind: null, stopClass: null, origin: null, deferred: null, deferUntil: null, updatedAt: now };
      this.data.rows.push(row);
      this.data.rows.sort((a, b) => a.pr - b.pr);
    }
    // An update time from the future (an untrusted writer) is taken as now: it can never silence later edits (review m8).
    const updatedAt = typeof t.prUpdatedAt === 'string' ? Math.min(Date.parse(t.prUpdatedAt), now) : null;
    const newer = updatedAt !== null && (row.prUpdatedAt === null || updatedAt > row.prUpdatedAt);
    if (newer) row.prUpdatedAt = updatedAt;
    if (row.seen.includes(t.headSha)) {
      if (row.current?.headSha !== t.headSha || row.running?.headSha === t.headSha) return { action: 'seen' };
      // The current commit asked again: a new trigger pokes a row that waits for its next try.
      // A closed PR that is open again (the poller proposes it): its head is tried again; the ledger decides.
      if (row.state === 'DONE' && row.reason === 'PR_CLOSED') { this.setState(row, 'QUEUED', null, now); row.order = this.seq(); row.origin = 'queued'; return { action: 'reopened' }; }
      const waits = ['WAITING', 'BACKOFF'].includes(row.state);
      if (!waits || !(updatedAt === null || newer)) return { action: 'seen' };
      row.poke = { at: now, dueAt: Math.max(now, (row.lastEvalAt ?? 0) + cooldownMs) };
      // A row backing off after a claim refusal whose evaluation saw the PR's claims: the executor reads the PR once before its next
      // scheduling pass and makes the poke due now when the PR names other claims (claimChanged; field defect 2026-11-08, PR #1039).
      if (this.claimRefused(row)) row.poke.claimCheck = true;
      row.deferUntil = null;
      row.updatedAt = now;
      return { action: 'new-trigger', dueAt: row.poke.dueAt };
    }
    // A commit this PR was never seen with.
    if (!LIVE_STATES.includes(row.state) && this.live().length >= depth) return { action: 'refused', code: 'QUEUE_DEPTH_EXCEEDED' };
    let action = 'new';
    if (['RUNNING', 'PARKED'].includes(row.state)) {
      action = 'pending';
      // A newer commit that was waiting behind the running one is itself replaced now.
      if (row.current && row.current.headSha !== row.running?.headSha) row.superseded = [commitOf(row.current), ...row.superseded.filter(c => c.headSha !== row.current.headSha)].slice(0, SUPERSEDED_MAX);
    } else if (['QUEUED', 'WAITING', 'BACKOFF'].includes(row.state) || (row.state === 'STOPPED' && row.stopKind === 'release-cap' && row.current)) {
      row.superseded = [commitOf(row.current), ...row.superseded.filter(c => c.headSha !== row.current.headSha)].slice(0, SUPERSEDED_MAX);
      action = 'superseded';
    }
    row.seen = [t.headSha, ...row.seen].slice(0, SEEN_MAX);
    row.current = { headSha: t.headSha, baseSha: t.baseSha, seq: this.seq(), firstAt: now };
    Object.assign(row, { order: row.current.seq, level: 0, levelKind: null, nextAt: null, poke: null, stopKind: null, stopClass: null, origin: 'queued', deferred: null, deferUntil: null });
    // A running or parked batch keeps going (the row stays as it is and shows the newer commit as the next one).
    this.setState(row, row.running ? (row.state === 'PARKED' ? 'PARKED' : 'RUNNING') : 'QUEUED', row.running && row.state === 'PARKED' ? row.reason : null, now);
    return { action, seq: row.current.seq };
  }

  // A claim refusal of the current commit, still eligible for bounded rechecking.
  claimRefused(row) {
    // BACKOFF is the persisted shape from before claim waits used the waiting budget.
    return !!row && ['WAITING', 'BACKOFF'].includes(row.state) && CLAIM_REASONS.includes(row.reason) && !row.running && !!row.current;
  }

  // A protected read-only observation can recheck these rows without a body edit.
  claimChecks() {
    return this.data.rows.filter(r => this.claimRefused(r)).map(r => ({ pr: r.pr, headSha: r.current.headSha, baseSha: r.current.baseSha }));
  }

  // Only a changed, confirmed bound generation makes a poke due. A first known
  // observation establishes the baseline; unknown keeps the original back-off.
  // Once-only, re-evaluation and daily caps still decide whether it can run.
  claimChanged(pr, live, now) {
    const r = this.row(pr);
    if (!this.claimRefused(r) || !live || live.pr !== pr || live.headSha !== r.current.headSha || live.baseSha !== r.current.baseSha) return false;
    const fingerprint = claimBindingFingerprint(live);
    if (fingerprint === null) return false;
    if (r.poke) delete r.poke.claimCheck;
    const before = r.evalBindingHead === live.headSha ? r.evalBinding : null;
    r.evalBinding = fingerprint; r.evalBindingHead = live.headSha; r.updatedAt = now;
    if (before == null || fingerprint === before || live.bindingStatus !== 'bound') return false;
    r.poke = { ...r.poke, at: now, dueAt: now, claimChanged: true };
    r.deferUntil = null;
    return true;
  }

  // A train front batch (step 3c-2b, DESIGN §41.4): the executor's only producer of a subject with S is on-mode stage 10's
  // openFrontBatch. The PR's current commit becomes H with S and the front attempt, queued before every other row. Never while
  // the PR's batch runs or rests at a parking point (busy: stage 10 opens it again later); a commit that waits is superseded.
  offerFront({ pr, headSha, baseSha, testSha, attempt }, now, { depth }) {
    check(Number.isSafeInteger(pr) && pr > 0 && HEX40.test(headSha ?? '') && HEX40.test(baseSha ?? '') && HEX40.test(testSha ?? '') && testSha !== headSha && [1, 2].includes(attempt),
      'QUEUE_FRONT_INVALID');
    let row = this.row(pr);
    if (row?.running) return { action: 'busy' };
    if (!row) {
      if (this.live().length >= depth) return { action: 'refused', code: 'QUEUE_DEPTH_EXCEEDED' };
      row = { pr, current: null, running: null, superseded: [], seen: [], state: 'DONE', reason: null, since: now, nextAt: null, level: 0, levelKind: null,
        order: 0, poke: null, prUpdatedAt: null, lastEvalAt: null, stopKind: null, stopClass: null, origin: null, deferred: null, deferUntil: null, updatedAt: now };
      this.data.rows.push(row);
      this.data.rows.sort((a, b) => a.pr - b.pr);
    } else if (!LIVE_STATES.includes(row.state) && this.live().length >= depth) return { action: 'refused', code: 'QUEUE_DEPTH_EXCEEDED' };
    if (row.current && row.current.headSha !== headSha && ['QUEUED', 'WAITING', 'BACKOFF'].includes(row.state)) {
      row.superseded = [commitOf(row.current), ...row.superseded.filter(c => c.headSha !== row.current.headSha)].slice(0, SUPERSEDED_MAX);
    }
    row.seen = [headSha, ...row.seen.filter(h => h !== headSha)].slice(0, SEEN_MAX);
    row.current = { headSha, baseSha, seq: this.seq(), firstAt: now, testSha, frontAttempt: attempt };
    Object.assign(row, { order: row.current.seq, level: 0, levelKind: null, nextAt: null, poke: null, stopKind: null, stopClass: null, origin: 'queued', deferred: null, deferUntil: null });
    this.setState(row, 'QUEUED', null, now);
    return { action: 'front', seq: row.current.seq };
  }

  // A front commit (S) is offered by on-mode stage 10 of this node's duty only: when the duty ends (STANDBY, or a start with the
  // train not on) every front commit that is not running is dropped, the row DONE with the reason (review R3 MINOR 5; a running
  // or parked one goes on, its live admission deciding). Returns how many.
  dropFronts(code, now) {
    let n = 0;
    for (const r of this.data.rows) {
      if (r.running || !r.current || !Object.hasOwn(r.current, 'testSha') || !['QUEUED', 'WAITING', 'BACKOFF'].includes(r.state)) continue;
      r.current = null;
      Object.assign(r, { nextAt: null, poke: null, deferred: null, deferUntil: null });
      this.setState(r, 'DONE', code, now);
      n += 1;
    }
    return n;
  }

  // A bundle found that main is no longer baseSha (RESIDENT_BASE_MOVED): every other waiting row on that same base can never pass
  // either, so it stops now with the same code, without a bundle of its own (only a new commit runs that PR again). Returns how many.
  stopBase(baseSha, code, now) {
    let n = 0;
    for (const r of this.data.rows) {
      if (r.running || r.current?.baseSha !== baseSha || !['QUEUED', 'WAITING', 'BACKOFF'].includes(r.state)) continue;
      Object.assign(r, { stopKind: 'burned', stopClass: 'superseded', nextAt: null, poke: null, deferred: null, deferUntil: null });
      this.setState(r, 'STOPPED', code, now);
      n += 1;
    }
    return n;
  }

  // The rows that may be tried now, in the order the executor tries them (design v0.5 §4.3 steps 5 and 6; v0.6 §7
  // minor 4): a train front batch first (step 3c-2b), due waits and poked rows next (by due time), then the rest first come,
  // first served (by order; a released row went to the tail).
  candidates(now) {
    const first = [], rest = [];
    for (const r of this.data.rows) {
      if (!r.current || r.running || (time(r.deferUntil) && r.deferUntil > now)) continue;
      const poked = !!r.poke && r.poke.dueAt <= now;
      if (this.claimRefused(r)) {
        // Ordinary edits do not change Native authority and cannot bypass the
        // exponential wait or switch its budget back to normal evaluations.
        if (poked && r.poke.claimChanged === true) first.push({ r, origin: 'new-trigger', at: r.poke.dueAt, poked: true });
        else if (time(r.nextAt) && r.nextAt <= now) first.push({ r, origin: 'waiting-retry', at: r.nextAt, poked });
        continue;
      }
      if (r.state === 'QUEUED' && Object.hasOwn(r.current, 'testSha')) first.push({ r, origin: 'queued', at: 0, poked: false });
      else if (r.state === 'WAITING' && time(r.nextAt) && r.nextAt <= now) first.push({ r, origin: 'waiting-retry', at: r.nextAt, poked });
      else if (poked && ['WAITING', 'BACKOFF'].includes(r.state)) first.push({ r, origin: 'new-trigger', at: r.poke.dueAt, poked: true });
      else if (r.state === 'BACKOFF' && time(r.nextAt) && r.nextAt <= now) rest.push({ r, origin: r.origin === 'lifted' ? 'lifted' : 'backoff-retry' });
      else if (r.state === 'QUEUED') rest.push({ r, origin: r.origin === 'restored' ? 'restored' : 'queued' });
    }
    first.sort((a, b) => a.at - b.at || a.r.pr - b.r.pr);
    rest.sort((a, b) => a.r.order - b.r.order);
    // claimChanged: a poke whose PR names another claim than the refused evaluation saw (claimChanged): the precheck skips the cool-down.
    return [...first, ...rest].map(({ r, origin, poked }) => ({ pr: r.pr, headSha: r.current.headSha, baseSha: r.current.baseSha, origin, poked: poked === true,
      ...(origin === 'new-trigger' && r.poke?.claimChanged === true ? { claimChanged: true } : {}), ...frontOf(r.current) }));
  }

  // A candidate the executor did not start (a per-row defer: the cool-down, the PR's daily batches, the waiting budget,
  // the re-evaluation cap). The reason is shown and the row is looked at again at `until` (default DEFER_RECHECK_MS); a
  // poke that cannot be used is dropped.
  defer(pr, reason, now, { dropPoke = false, until = null } = {}) {
    const r = this.row(pr);
    if (!r) return;
    if (dropPoke) r.poke = null;
    r.deferUntil = time(until) && until > now ? until : now + DEFER_RECHECK_MS;
    if (r.state === 'QUEUED') this.setState(r, 'QUEUED', reason, now);
    else { r.deferred = reason; r.updatedAt = now; }
  }

  // Record the last protected observation, if known, for a later claim wait.
  begin(pr, headSha, key, origin, now, { binding = null } = {}) {
    const r = this.row(pr);
    check(r && r.current?.headSha === headSha && !r.running && ORIGINS.includes(origin), 'QUEUE_ROW_NOT_CURRENT', pr);
    r.running = { ...commitOf(r.current), key };
    r.evalClaims = null; // legacy body claims are never authority for rechecking.
    const fingerprint = claimBindingFingerprint(binding);
    r.evalBinding = fingerprint ?? (r.evalBindingHead === headSha ? r.evalBinding ?? null : null);
    r.evalBindingHead = headSha;
    r.lastEvalAt = now;
    r.poke = null;
    r.deferred = null;
    r.deferUntil = null;
    r.origin = origin;
    this.setState(r, 'RUNNING', null, now);
  }

  // Phase 2, step 2: the row's batch rests at parking point B (reason: why stage 8 was not ready; nextAt: its next try;
  // position: its claim's place in the merge queue at that try). A newer commit that arrived meanwhile stays current.
  park(pr, headSha, { reason, nextAt, position }, now) {
    const r = this.row(pr);
    if (!r || r.running?.headSha !== headSha) return false;
    r.parked = { reason: reason ?? null, nextAt: Number.isSafeInteger(nextAt) ? nextAt : null, position: Number.isSafeInteger(position) ? position : null };
    if (r.current?.headSha === headSha) this.setState(r, 'PARKED', reason ?? null, now);
    else r.updatedAt = now;
    return true;
  }

  // A batch of (pr, headSha) ended (a precheck that ignored it counts as one). outcome: { kind: completed | burned |
  //   released | ignored, code, klass (failure-table class), reason (the release reason), ciRetryAfter (ms or null),
  //   releases24h (this head's counted releases in 24 hours, this one included), releaseCap }.
  // Returns 'stopped' when the row stopped at the release cap now (the executor notifies once), else null.
  settle(pr, headSha, outcome, now) {
    const r = this.row(pr);
    if (!r) return null;
    const ran = r.running?.headSha === headSha ? r.running : null;
    if (ran) { r.running = null; r.parked = null; }
    if (r.current?.headSha !== headSha) {
      // A newer commit took over while this one ran. An unburned one may come back (restore); a burned one never.
      if (ran && outcome.kind === 'released') r.superseded = [commitOf(ran), ...r.superseded.filter(c => c.headSha !== headSha)].slice(0, SUPERSEDED_MAX);
      if (['RUNNING', 'PARKED'].includes(r.state) && !r.running) this.setState(r, r.current ? 'QUEUED' : 'DONE', null, now);
      return null;
    }
    r.deferred = null;
    r.poke = null;
    switch (outcome.kind) {
      case 'readmit':
        Object.assign(r, { stopKind: null, stopClass: null, nextAt: null, order: this.seq() });
        this.setState(r, 'QUEUED', 'SAFE_POINT_READMISSION', now);
        return null;
      case 'completed':
        r.stopKind = null;
        this.setState(r, 'DONE', null, now);
        return null;
      case 'released': {
        r.order = this.seq(); // to the tail
        const claimWait = CLAIM_REASONS.includes(outcome.code);
        if (claimWait) {
          const since = r.current.firstAt ?? r.lastEvalAt ?? now;
          if (now - since >= CLAIM_WAIT_MAX_MS) {
            Object.assign(r, { stopKind: 'release-cap', stopClass: outcome.klass ?? null, nextAt: null });
            this.setState(r, 'STOPPED', outcome.code, now);
            return 'stopped';
          }
        }
        const waiting = claimWait || outcome.klass === 'waiting';
        const network = !waiting && outcome.network === true;
        if (network && Number.isSafeInteger(outcome.networkReleases24h) && outcome.networkReleases24h >= outcome.networkCap) {
          Object.assign(r, { stopKind: 'release-cap', stopClass: 'environment', nextAt: null });
          this.setState(r, 'STOPPED', NETWORK_RELEASE_CAP_REACHED, now);
          return 'stopped';
        }
        if (!waiting && !network && Number.isSafeInteger(outcome.releases24h) && outcome.releases24h >= outcome.releaseCap) {
          Object.assign(r, { stopKind: 'release-cap', stopClass: outcome.klass ?? null, nextAt: null });
          this.setState(r, 'STOPPED', outcome.code ?? null, now);
          return 'stopped';
        }
        const kind = waiting ? 'waiting' : network ? 'network' : 'release';
        const level = r.levelKind === kind ? r.level : 0;
        const retryAfter = waiting && Number.isSafeInteger(outcome.ciRetryAfter) ? Math.min(Math.max(outcome.ciRetryAfter, now + WAITING_BACKOFF_MS[0]), now + CI_RETRY_MAX_MS) : null;
        r.nextAt = retryAfter ?? now + delayAt(waiting ? WAITING_BACKOFF_MS : network ? NETWORK_BACKOFF_MS : RELEASE_BACKOFF_MS, level);
        Object.assign(r, { level: level + 1, levelKind: kind, stopKind: null, stopClass: null });
        this.setState(r, waiting ? 'WAITING' : 'BACKOFF', outcome.code ?? null, now);
        if (claimWait) r.deferred = `${outcome.code}: ${claimWaitText(outcome.outcomeReason)}`;
        return null;
      }
      default: // burned, ignored: only a new commit runs this PR again
        Object.assign(r, { stopKind: 'burned', stopClass: outcome.klass ?? null, nextAt: null });
        this.setState(r, 'STOPPED', outcome.code ?? null, now);
        return null;
    }
  }

  // The precheck found the head at its release cap (from the ledger): the row stops without a batch. true when it stopped
  // now (the executor notifies once).
  // stopClass: 'environment' for the network cap (generation 10), so the environment lift applies to it.
  stopAtCap(pr, headSha, code, now, stopClass = null) {
    const r = this.row(pr);
    if (!r || r.current?.headSha !== headSha || r.running || r.state === 'STOPPED') return false;
    Object.assign(r, { stopKind: 'release-cap', stopClass, nextAt: null, poke: null, deferred: null, deferUntil: null });
    this.setState(r, 'STOPPED', code, now);
    return true;
  }

  // Attempt 2 of a head whose PR got a newer commit, and the live read says the head is still the PR's: the newer commit
  // goes back to superseded and the head is current again (not running: attempt 2 starts next). true when it changed.
  keepCurrent(pr, headSha, baseSha, now) {
    const r = this.row(pr);
    if (!r || r.running || !r.current || r.current.headSha === headSha) return false;
    const was = r.superseded.find(c => c.headSha === headSha);
    r.superseded = [commitOf(r.current), ...r.superseded.filter(c => c.headSha !== headSha && c.headSha !== r.current.headSha)].slice(0, SUPERSEDED_MAX);
    r.current = was ? commitOf(was) : { headSha, baseSha, seq: this.seq(), firstAt: now };
    Object.assign(r, { order: this.seq(), nextAt: null, poke: null, deferred: null, deferUntil: null, origin: 'queued' });
    this.setState(r, 'STOPPED', 'ATTEMPT2_PENDING', now);
    r.stopKind = 'burned';
    return true;
  }

  // The running batch's safe point found it superseded, but the live read says it IS the PR's head: the newer commit in
  // the queue is disproved and goes back to superseded; the running one is current again.
  keepRunning(pr, headSha, now) {
    const r = this.row(pr);
    if (!r || r.running?.headSha !== headSha || !r.current || r.current.headSha === headSha) return false;
    r.superseded = [commitOf(r.current), ...r.superseded.filter(c => c.headSha !== headSha && c.headSha !== r.current.headSha)].slice(0, SUPERSEDED_MAX);
    r.current = commitOf(r.running);
    // A batch parked at B stays parked (phase 2, step 2).
    this.setState(r, r.state === 'PARKED' ? 'PARKED' : 'RUNNING', r.state === 'PARKED' ? r.reason : null, now);
    return true;
  }

  // Falsification (stage 1 or the bundle proved the current commit is no longer the PR's head) answered by one live read:
  // the head the companion saw becomes current again when it is one of this PR's superseded commits and the caller
  // (which asked the ledger and the executed heads) says it is not burned. Returns true when it restored one.
  restore(pr, liveHead, now, { burned }) {
    const r = this.row(pr);
    if (!r || r.running || burned !== false || !HEX40.test(liveHead ?? '') || r.current?.headSha === liveHead) return false;
    const was = r.superseded.find(c => c.headSha === liveHead);
    if (!was) return false;
    r.superseded = [...(r.current ? [commitOf(r.current)] : []), ...r.superseded.filter(c => c.headSha !== liveHead && c.headSha !== r.current?.headSha)].slice(0, SUPERSEDED_MAX);
    r.current = commitOf(was);
    Object.assign(r, { order: this.seq(), level: 0, levelKind: null, nextAt: null, poke: null, stopKind: null, stopClass: null, origin: 'restored', deferred: null, deferUntil: null });
    this.setState(r, 'QUEUED', null, now);
    return true;
  }

  // The PR is closed (a live read): nothing of it runs any more.
  closePr(pr, now) {
    const r = this.row(pr);
    if (!r || r.running) return false;
    Object.assign(r, { poke: null, nextAt: null, stopKind: null, deferred: null });
    this.setState(r, 'DONE', 'PR_CLOSED', now);
    return true;
  }

  // The breaker closed (breaker.mjs): rows the release cap stopped because of an environment fault are tried again.
  liftEnvironmentStops(now, { eligible = () => true } = {}) {
    const lifted = [];
    for (const r of this.data.rows) {
      if (r.state !== 'STOPPED' || r.stopKind !== 'release-cap' || r.stopClass !== 'environment' || !r.current) continue;
      if (!eligible(r)) continue;
      // 'lifted': the next try is not held back by the release cap its environment releases reached (executor precheck).
      Object.assign(r, { stopKind: null, stopClass: null, level: 0, levelKind: null, nextAt: now, order: this.seq(), origin: 'lifted', deferUntil: null });
      this.setState(r, 'BACKOFF', null, now);
      lifted.push(r.pr);
    }
    return lifted;
  }

  // Generation 10 (DESIGN 53.4): the probes see the outside again: only the rows the network cap stopped are lifted (any other environment
  // stop, a deterministic refusal at the ordinary cap among them, still waits for the breaker to close, as before). Returns the PRs.
  liftNetworkStops(now) {
    const lifted = [];
    for (const r of this.data.rows) {
      if (r.state !== 'STOPPED' || r.stopKind !== 'release-cap' || r.stopClass !== 'environment' || r.reason !== NETWORK_RELEASE_CAP_REACHED || !r.current) continue;
      Object.assign(r, { stopKind: null, stopClass: null, level: 0, levelKind: null, nextAt: now, order: this.seq(), origin: 'lifted', deferUntil: null });
      this.setState(r, 'BACKOFF', null, now);
      lifted.push(r.pr);
    }
    return lifted;
  }

  // Generation 10 (DESIGN 53.4): the outside answers again (probes, the Owner's release): a row that backs off after a network release
  // is due now instead of at its next 10-minute mark. Returns the PRs it woke.
  wakeNetworkRows(now) {
    const woke = [];
    for (const r of this.data.rows) {
      if (r.state !== 'BACKOFF' || r.levelKind !== 'network' || !r.current || !(r.nextAt > now)) continue;
      r.nextAt = now;
      r.updatedAt = now;
      woke.push(r.pr);
    }
    return woke;
  }

  // Rows done or stopped for 24 hours leave the queue; so do notices older than that.
  compact(now) {
    const before = this.data.rows.length;
    this.data.rows = this.data.rows.filter(r => LIVE_STATES.includes(r.state) || now - (r.updatedAt ?? 0) < COMPACT_AFTER_MS);
    this.data.notices = this.data.notices.filter(n => now - (n.at ?? 0) < COMPACT_AFTER_MS);
    return before - this.data.rows.length;
  }

  // The status board's view: every row with a current commit. position: its place among the rows that may run now;
  // eta: an ESTIMATE only (etaBatchMs per batch ahead of it, after the running one), never a decision.
  view(now, { etaBatchMs, runningUntil = null } = {}) {
    const runnable = this.candidates(now).map(c => c.pr);
    const ahead = new Map(runnable.map((pr, i) => [pr, i]));
    const start = Math.max(now, runningUntil ?? now);
    // A parked row whose current commit is a newer one (its batch still rests at B) shows that commit as waiting for the
    // batch, never as tested (independent review of step 2, m3).
    const parkedHere = r => r.state === 'PARKED' && r.running?.headSha === r.current.headSha;
    // A back-off or wait keeps its own reason; a per-row deferral that holds it now (defer: the row keeps its state; until deferUntil)
    // is named apart (heldBy), so the PR page can tell the two (review round 21, MINOR 1 and NIT 2). A deferral whose time ran out
    // holds nothing any more (review round 22, MINOR 1): the row is a candidate again.
    const own = r => r.state === 'BACKOFF' || r.state === 'WAITING';
    const held = r => own(r) && r.deferred && time(r.deferUntil) && r.deferUntil > now ? r.deferred : null;
    // A queued row's reason is only ever its deferral (defer); once that ran out it says none, as a row that may run (review round 23,
    // MINOR 2).
    const queuedReason = r => (time(r.deferUntil) && r.deferUntil <= now ? null : (r.deferred ?? r.reason ?? null));
    const testSha = r => parkedHere(r) ? r.running.testSha
      : LIVE_STATES.includes(r.state) && (!r.running || r.running.testSha === r.current.testSha) ? r.current.testSha : null;
    return this.data.rows.filter(r => r.current).map(r => ({
      pr: r.pr, headSha: r.current.headSha, baseSha: r.current.baseSha, state: r.state === 'PARKED' && !parkedHere(r) ? 'RUNNING' : r.state,
      // The companion can begin checking the staging run while the executor is still running stages 1-7.
      ...(testSha(r) ? { testSha: testSha(r) } : {}),
      reason: r.state === 'PARKED' && !parkedHere(r) ? null : own(r) ? (r.reason ?? null) : r.state === 'QUEUED' ? queuedReason(r) : (r.deferred ?? r.reason ?? null),
      heldBy: held(r), since: r.since ?? null,
      nextAt: parkedHere(r) ? (r.parked?.nextAt ?? null) : r.state === 'PARKED' ? null : time(r.nextAt) ? r.nextAt : (r.poke ? r.poke.dueAt : null), level: r.level, origin: r.origin ?? null, stopKind: r.stopKind ?? null,
      queuePosition: parkedHere(r) ? (r.parked?.position ?? null) : null,
      // Generation 12 (defect 050560ac): a back-off after a network release (the line to GitHub or Native, DESIGN 53.3), for the PR page.
      network: r.state === 'BACKOFF' && r.levelKind === 'network',
      firstAt: r.current.firstAt ?? null, position: ahead.has(r.pr) ? ahead.get(r.pr) + 1 : null,
      eta: ahead.has(r.pr) ? start + ahead.get(r.pr) * etaBatchMs : null,
    })).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.pr - b.pr);
  }
}
