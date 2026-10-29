// Once-only batch ledger plus the HALT / PAUSE latches.
//
// A batch key is the identity of one reservation: repository, PR, exact head and base, the installed
// Source manifest and an explicit attempt number. Each key moves through create-only records
// 00-reserved -> 10-started -> 90-terminal.
//
// Execution is burned per HEAD, not per key: 10-started also creates heads/<headKey>.json, where
// headKey covers only (repo, head, Source, attempt). A head that started once is never started again,
// whatever base, PR number or claim a later trigger names. Attempt 2 exists only as the one automatic
// attempt of attempts.mjs (Owner decision 1b5d3687), recorded create-only in ledger-attempt2/ (at most
// one per attempt-1 key, and only after that key ended FAILED_CLEAN); there is no attempt 3. A reservation that ended before 10-started ran no scanner and published no success (the
// bundle failed, or stage 1 did not admit); it is closed with NOT_EXECUTED and moved, not deleted,
// into ledger-unexecuted/ so a later trigger may ask again under the cool-down and the daily caps.
//
// The hosted wait is not a blocking call (coordinator review of PR-A): right after 10-started the executor
// writes 15-relay-wait (create-only: t0 and the derived batch), and every later tick re-evaluates the wait
// from that stored t0 after recovery, the Owner's requests, HALT and PAUSE. Nothing runs while a batch waits,
// so a STARTED entry with 15-relay-wait and no 20-plan-intent is RESUMABLE, not a crash: recovery leaves it,
// a restart continues it without re-running stage 1, and re-arm may clear a HALT while it waits.
//
// Stage R (PR-A, free-minutes design §7.3): between 10-started and the local roles, 20-plan-intent records
// (create-only) which roles the executor is about to ask stage R to relay, and 25-plan records (create-only)
// the per-role outcome: RELAYED or LOCAL_REQUIRED(reason). Only LOCAL_REQUIRED roles ever run locally. An
// entry with 20-plan-intent and no 25-plan was interrupted inside stage R: a relay key may have been begun,
// so recovery closes it FAILED_UNKNOWN (RELAY_STAGE_INTERRUPTED) and HALTs; nothing of it runs locally.
//
// Owner abort (DESIGN §6.5): an accepted abort writes 80-owner-abort (create-only) before anything is stopped. An
// entry with it is never a resumable wait, so a service that dies in the middle of an abort leaves a crash scene
// that recovery closes FAILED_UNKNOWN (OWNER_ABORT_INTERRUPTED) and HALTs, exactly like any other open entry. The
// executor's own end of a superseded batch (phase 2, DESIGN §17.4) does the same with 81-self-abort
// (SUPERSEDE_INTERRUPTED).
//
// Phase 2, step 1 (resident quota redesign, design v0.5 §4.4-§4.7, Task 6451a55d): 00-reserved.json also names how the
// run queue picked the subject (`origin`, queue.mjs#ORIGINS; a record without one was a plain first try), and usage()
// derives every daily budget of the queue from the ledger itself, so a lost queue file never resets a budget: the
// executions (10-started heads, per PR too), the evaluations (reservations that did not execute, without the waits'
// own budget, the environment releases and the supersessions), the waiting retries, the new-trigger re-evaluations per
// (PR, commit), and the counted releases per head (waits never count; an environment release while the breaker was not
// closed does not either). A new release reason, SUPERSEDED, closes a reservation whose PR got a newer commit before
// stage 1 (nothing of it ran). Primary/standby C3 (DESIGN §29): a release of the failure-table class node-role (this node
// holds no ci-admission role) says nothing about the PR; it counts neither as an evaluation, nor as a new-trigger
// re-evaluation, nor towards the release cap.
//
// Phase 2, step 2 (parking, design v0.5 §4.3, §4.8, §4.9): an entry can rest at two parking points, with nothing of it
// running and Linux empty:
//   A, the hosted wait (15-relay-wait, as before); several batches may now wait at once;
//   B, after the last role stage and the close archive on both hosts (70-parked), before stage 8. Stage 8 then runs as
//      "tries": 71-try-NN is written (create-only) right before a try, 72-tried-NN right after a try that was not ready
//      (zero side effects). An entry whose every try has its 72 record is resumable; a 71 without its 72 is a crash in
//      stage 8, a crash scene like any other (recovery closes it FAILED_UNKNOWN and HALTs).
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HEX40, HEX64, REPO, ResidentError, check, digest, fail, isoNow } from './canonical.mjs';
import { ensureDir, exists, nonce, readJson, renameToNew, writeNew } from './store.mjs';

export const BATCH_KEY_CONTRACT = 'clued.independent-ci.resident-batch-key/1';
export const HEAD_KEY_CONTRACT = 'clued.independent-ci.resident-head-key/1';
export const OUTCOMES = Object.freeze(['COMPLETED', 'FAILED_CLEAN', 'FAILED_UNKNOWN']);
// Why a reservation was closed before 10-started (classify.mjs#UNEXECUTED_REASON_RULES says, per reason, that the
// cool-down and the daily cap of a later trigger apply): Native refused on a safe-to-re-run stage 1 outcome, the bundle
// failed, or the broker refused stage 1 before any launch with the original restored (resident quota redesign phase 1).
export const UNEXECUTED_REASONS = Object.freeze(['NOT_ADMITTED', 'BUNDLE_UNAVAILABLE', 'BROKER_NOT_LAUNCHED', 'SUPERSEDED']);
// Releases that never count as an evaluation nor towards a head's release cap (nothing about the PR was decided).
export const UNCOUNTED_RELEASES = Object.freeze(['BUNDLE_UNAVAILABLE', 'BROKER_NOT_LAUNCHED', 'SUPERSEDED']);
// Risk tiers of the daily budgets (Task 12ada80e, DESIGN §35): a head burned by a stage-1 ending that proved it published
// nothing (clean on both hosts, zero side effects, mayHavePublished false) carries quotaTier 'evaluation' in its burn
// facts. usage() counts it once, as the evaluation its batch entry already is, not as an execution. Every other head
// record (10-started, any other burn, an older record without the field, one that cannot be read) is an execution.
export const QUOTA_TIER_EVALUATION = 'evaluation';
export const RESERVATION_ORIGINS = Object.freeze(['queued', 'backoff-retry', 'waiting-retry', 'new-trigger', 'restored', 'lifted', 'attempt2']);
// The records of an open entry, oldest first; the newest one present is what an Owner abort names by digest.
export const OPEN_RECORDS = Object.freeze(['00-reserved.json', '10-started.json', '15-relay-wait.json', '20-plan-intent.json', '25-plan.json', '70-parked.json']);
export const OWNER_ABORT_RECORD = '80-owner-abort.json';
export const PARK_RECORD = '70-parked.json';
export const MAX_TRIES = 99;
const TRY = /^7(?:(1)-try|(2)-tried)-(\d{2})\.json$/;
const tryName = (begun, n) => `${begun ? '71-try' : '72-tried'}-${String(n).padStart(2, '0')}.json`;
export const SELF_ABORT_RECORD = '81-self-abort.json';

// Step 3c-2: a train front batch's subject also names its tested commit S (never the head); every other subject has no
// `testSha` and its key stays what it always was (Source v2 derive-batch.mjs#residentBatchKey computes the same).
function subjectCheck({ repo, pr, headSha, baseSha, sourceManifestSha256, attempt, ...rest }) {
  check(REPO.test(repo) && Number.isSafeInteger(pr) && pr > 0, 'BATCH_KEY_SUBJECT_INVALID');
  check(HEX40.test(headSha) && HEX40.test(baseSha), 'BATCH_KEY_COMMIT_INVALID');
  check(!Object.hasOwn(rest, 'testSha') || (HEX40.test(rest.testSha) && rest.testSha !== headSha), 'BATCH_KEY_COMMIT_INVALID');
  check(HEX64.test(sourceManifestSha256), 'BATCH_KEY_SOURCE_INVALID');
  check(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 9, 'BATCH_KEY_ATTEMPT_INVALID');
}

export function batchKey(s) {
  subjectCheck(s);
  return digest({ contract: BATCH_KEY_CONTRACT, repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, sourceManifestSha256: s.sourceManifestSha256, attempt: s.attempt,
    ...(Object.hasOwn(s, 'testSha') ? { testSha: s.testSha } : {}) });
}

export function headKey(s) {
  subjectCheck(s);
  return digest({ contract: HEAD_KEY_CONTRACT, repo: s.repo, headSha: s.headSha, sourceManifestSha256: s.sourceManifestSha256, attempt: s.attempt });
}

const stamp = clock => isoNow(clock).replace(/[:.]/g, '');
// Only a record whose CONTENT is bad (bounded-read refusal: link, extra hard link, size; or invalid
// JSON) makes an entry UNREADABLE. Any other I/O error (busy, permission, disk) is transient and
// propagates, so it can never quarantine a valid entry (third review, MAJOR 2).
const contentError = error => error instanceof ResidentError || error instanceof SyntaxError;

export class Ledger {
  constructor(root, clock) {
    this.root = root;
    this.clock = clock;
    this.batches = path.join(root, 'ledger');
    this.heads = path.join(root, 'ledger-heads');
    this.unexecuted = path.join(root, 'ledger-unexecuted');
    this.halts = path.join(root, 'halts');
    this.attempts2 = path.join(root, 'ledger-attempt2');
  }

  static async open(root, clock = Date.now) {
    const ledger = new Ledger(root, clock);
    await ensureDir(root);
    for (const d of [ledger.batches, ledger.heads, ledger.unexecuted, ledger.halts, ledger.attempts2]) await ensureDir(d);
    return ledger;
  }

  dir(key) { check(HEX64.test(key), 'BATCH_KEY_INVALID'); return path.join(this.batches, key); }

  async state(key) {
    const dir = this.dir(key);
    if (!(await exists(dir))) return { state: 'ABSENT' };
    // A record that cannot be read (torn write, wrong type, extra hard link) makes the entry
    // UNREADABLE: it is open, recovery closes or quarantines it, and nothing ever throws past here.
    let reserved, started, wait, planIntent, plan, parked, tries, abort, selfAbort, terminal, archived;
    try {
      const read = async name => (await exists(path.join(dir, name))) ? (await readJson(path.join(dir, name))).value : null;
      reserved = await read('00-reserved.json');
      started = await read('10-started.json');
      wait = await read('15-relay-wait.json');
      planIntent = await read('20-plan-intent.json');
      plan = await read('25-plan.json');
      parked = await read(PARK_RECORD);
      tries = await this.readTries(dir, read);
      abort = await read(OWNER_ABORT_RECORD);
      selfAbort = await read(SELF_ABORT_RECORD);
      terminal = await read('90-terminal.json');
      archived = await read('95-archived.json');
    } catch (error) {
      if (!contentError(error)) throw error;
      return { state: 'UNREADABLE' };
    }
    if (terminal) return { state: 'TERMINAL', outcome: terminal.outcome, reserved, started, wait, planIntent, plan, parked, tries, abort, selfAbort, terminal, archived };
    // A crash between mkdir and the reservation record leaves an INCOMPLETE entry; it is open, so
    // recovery terminalises it (FAILED_UNKNOWN) instead of wedging the ledger.
    if (!reserved) return { state: 'INCOMPLETE', reserved: null, started, abort, selfAbort };
    return { state: started ? 'STARTED' : 'RESERVED', reserved, started, wait, planIntent, plan, parked, tries, abort, selfAbort };
  }

  // The stage-8 tries of a parked entry, in order: [{ n, begun, ended }] (ended null while a try runs or crashed). A gap
  // (try n+1 without try n, a result without its try) is content that does not fit: UNREADABLE.
  async readTries(dir, read) {
    const names = (await fs.readdir(dir)).filter(n => TRY.test(n)).sort();
    const tries = [];
    for (const name of names) {
      const [, one, two, nn] = TRY.exec(name); const kind = one ?? two;
      const n = Number(nn);
      if (kind === '1') { check(n === tries.length + 1 && n <= MAX_TRIES, 'PARKED_TRY_SEQUENCE_INVALID'); tries.push({ n, begun: await read(name), ended: null }); }
    }
    for (const name of names) {
      const [, one, two, nn] = TRY.exec(name); const kind = one ?? two;
      if (kind !== '2') continue;
      const t = tries[Number(nn) - 1];
      check(t && t.ended === null, 'PARKED_TRY_SEQUENCE_INVALID');
      t.ended = await read(name);
    }
    return tries;
  }

  // The newest record of an OPEN entry with the SHA-256 of its exact bytes (what an Owner abort names), or null
  // when the entry is absent, terminal, unreadable or already being aborted.
  async latestRecord(key) {
    const s = await this.state(key);
    if (!['RESERVED', 'STARTED'].includes(s.state) || s.abort || s.selfAbort) return null;
    // A parked entry's newest record is its newest try record, if it has any.
    const last = s.tries?.at(-1);
    if (last) {
      const name = tryName(last.ended === null, last.n);
      return { name, sha256: (await readJson(path.join(this.dir(key), name))).sha256 };
    }
    for (const name of [...OPEN_RECORDS].reverse()) {
      const file = path.join(this.dir(key), name);
      if (await exists(file)) return { name, sha256: (await readJson(file)).sha256 };
    }
    return null;
  }

  // Create-only, before anything of the abort happens; a second acceptance of the same entry fails here.
  async beginOwnerAbort(key, facts) {
    const s = await this.state(key);
    check(['RESERVED', 'STARTED'].includes(s.state) && !s.abort && !s.selfAbort, 'OWNER_ABORT_BATCH_NOT_OPEN', s.state);
    await writeNew(path.join(this.dir(key), OWNER_ABORT_RECORD), { key, contract: 'clued.independent-ci.resident-owner-abort-accepted/1', at: isoNow(this.clock), ...facts });
  }

  // The executor's own end of a superseded batch (phase 2): create-only, before quiescence is proven or anything is
  // archived; from here on the batch is never resumed or continued.
  async beginSelfAbort(key, facts) {
    const s = await this.state(key);
    check(s.state === 'STARTED' && !s.abort && !s.selfAbort, 'SELF_ABORT_REQUIRES_STARTED_ENTRY', s.state);
    await writeNew(path.join(this.dir(key), SELF_ABORT_RECORD), { key, contract: 'clued.independent-ci.resident-self-abort/1', at: isoNow(this.clock), ...facts });
  }

  // The hosted wait record: written once, right after 10-started, before anything else of the batch.
  async beginWait(key, { t0, batch }) {
    const s = await this.state(key);
    check(s.state === 'STARTED' && !s.wait && !s.planIntent && !s.abort && Number.isSafeInteger(t0) && t0 > 0 && batch && typeof batch.batchId === 'string', 'RELAY_WAIT_REQUIRES_STARTED_ENTRY', s.state);
    await writeNew(path.join(this.dir(key), '15-relay-wait.json'), { key, contract: 'clued.independent-ci.resident-relay-wait/1', t0, batch, at: isoNow(this.clock) });
  }

  // An open entry at a parking point (nothing of it can be running): A, waiting for hosted signals; B, parked before
  // stage 8 with every try settled. One whose Owner abort (or the executor's own end) was accepted is never resumed: if it
  // is still open at a tick start, that end was interrupted (a crash scene).
  static waitingAt(entry) { return entry?.state === 'STARTED' && !!entry.wait && !entry.planIntent && !entry.plan && !entry.parked && !entry.abort && !entry.selfAbort; }
  static parkedAt(entry) { return entry?.state === 'STARTED' && !!entry.plan && !!entry.parked && !entry.abort && !entry.selfAbort && (entry.tries ?? []).every(t => t.ended !== null); }
  static resumable(entry) { return Ledger.waitingAt(entry) || Ledger.parkedAt(entry); }

  // Open entries that are a crash scene (recovery closes them) - everything open except an entry at a parking point.
  async crashed() { return (await this.open()).filter(e => !Ledger.resumable(e)); }

  // The batches at a parking point (phase 2: several may rest at once; the executor bounds how many).
  async parkedEntries() { return (await this.open()).filter(e => Ledger.resumable(e)); }

  // The oldest batch waiting for hosted signals, if any.
  async waiting() { return (await this.open()).find(e => Ledger.waitingAt(e)) ?? null; }

  // Parking point B: after the last role stage and the close archive on both hosts, before stage 8. Create-only.
  async park(key, facts) {
    const s = await this.state(key);
    check(s.state === 'STARTED' && s.plan && !s.parked && !s.abort && !s.selfAbort, 'PARK_REQUIRES_STARTED_ENTRY_WITH_PLAN', s.state);
    await writeNew(path.join(this.dir(key), PARK_RECORD), { key, contract: 'clued.independent-ci.resident-parked/1', at: isoNow(this.clock), ...facts });
  }

  // One stage-8 try of a parked entry: begun right before it runs, ended only when it was not ready (zero side effects).
  async beginTry(key, facts) {
    const s = await this.state(key);
    check(Ledger.parkedAt(s) && s.tries.length < MAX_TRIES, 'PARKED_TRY_REQUIRES_PARKED_ENTRY', s.state);
    const n = s.tries.length + 1;
    await writeNew(path.join(this.dir(key), tryName(true, n)), { key, contract: 'clued.independent-ci.resident-stage8-try/1', n, at: isoNow(this.clock), ...facts });
    return n;
  }

  async endTry(key, n, facts) {
    const s = await this.state(key);
    check(s.state === 'STARTED' && s.parked && s.tries.length === n && s.tries[n - 1].ended === null && !s.abort && !s.selfAbort, 'PARKED_TRY_END_REQUIRES_OPEN_TRY', s.state);
    await writeNew(path.join(this.dir(key), tryName(false, n)), { key, contract: 'clued.independent-ci.resident-stage8-tried/1', n, at: isoNow(this.clock), ...facts });
  }

  // Stage R bookkeeping, both create-only and only on a started entry; 25-plan only after 20-plan-intent.
  async writePlanIntent(key, intent) {
    const s = await this.state(key);
    check(s.state === 'STARTED' && s.wait && !s.planIntent && !s.plan && !s.abort && !s.selfAbort, 'RELAY_PLAN_INTENT_REQUIRES_STARTED_ENTRY', s.state);
    await writeNew(path.join(this.dir(key), '20-plan-intent.json'), { key, contract: 'clued.independent-ci.resident-relay-plan-intent/1', at: isoNow(this.clock), ...intent });
  }

  async writePlan(key, plan) {
    const s = await this.state(key);
    check(s.state === 'STARTED' && s.planIntent && !s.plan && !s.abort && !s.selfAbort, 'RELAY_PLAN_REQUIRES_INTENT', s.state);
    await writeNew(path.join(this.dir(key), '25-plan.json'), { key, contract: 'clued.independent-ci.resident-relay-plan/1', at: isoNow(this.clock), ...plan });
  }

  // Moves an entry that cannot be terminalised in place (for example an unreadable 90-terminal) into
  // ledger-quarantine/ intact, so the ledger never stays wedged. Before moving, its head is burned from
  // whatever reservation bytes can still be parsed, and the quarantine stays visible to re-arm, which
  // must archive its scene before HALT can clear (third review, MAJOR 2).
  async quarantine(key, facts) {
    const dir = this.dir(key);
    const tryJson = async name => { try { const b = await fs.readFile(path.join(dir, name)); return b.length <= 4 * 1024 * 1024 ? JSON.parse(b.toString('utf8')) : null; } catch { return null; } };
    const reserved = await tryJson('00-reserved.json');
    const started = await tryJson('10-started.json');
    const hk = HEX64.test(reserved?.headKey ?? '') ? reserved.headKey : null;
    if (hk && !(await exists(path.join(this.heads, `${hk}.json`)))) {
      await writeNew(path.join(this.heads, `${hk}.json`), { headKey: hk, key, subject: reserved.subject ?? null, startedAt: isoNow(this.clock), burnedBy: { quarantine: true } });
    }
    const batchId = typeof started?.facts?.batchId === 'string' && /^[0-9a-f]{16}-[0-9a-f]{12}$/.test(started.facts.batchId) ? started.facts.batchId : null;
    const n = nonce();
    const to = path.join(this.root, 'ledger-quarantine', `${key}-${stamp(this.clock)}-${n}`);
    await ensureDir(path.join(this.root, 'ledger-quarantine'));
    // The marker is written BEFORE the move, so a crash in between leaves a marker (visible to re-arm)
    // next to a still-present entry (picked up again by recovery) — never an invisible scene (N1).
    await writeNew(`${to}.quarantine.json`, { key, headKey: hk, batchId, nonce: n, facts, at: isoNow(this.clock) });
    await renameToNew(dir, to);
    return to;
  }

  // Quarantined scenes not archived yet (re-arm archives them too). Every quarantine directory and
  // every marker counts, whether or not its partner exists or parses: an unreadable marker is
  // "unarchived, batch unknown", never an error that would wedge re-arm (N1). The stand-in batch id
  // for an unknown batch uses the quarantine's own nonce, so it is unique per quarantine.
  async quarantinedUnarchived() {
    const dir = path.join(this.root, 'ledger-quarantine');
    if (!(await exists(dir))) return [];
    const QDIR = /^([0-9a-f]{64})-\d{4}-\d{2}-\d{2}T\d+Z-([0-9a-f]{12})$/; // <key>-<stamp>-<nonce>
    const bases = new Set();
    for (const name of await fs.readdir(dir)) {
      const base = name.replace(/\.(quarantine|archived)\.json$/, '');
      if (QDIR.test(base)) bases.add(base);
    }
    const out = [];
    for (const base of [...bases].sort()) {
      const marker = path.join(dir, `${base}.quarantine.json`);
      if (await exists(path.join(dir, `${base}.archived.json`))) continue;
      const [, key, n] = QDIR.exec(base);
      let batchId = null;
      try {
        const v = (await readJson(marker)).value;
        if (typeof v.batchId === 'string' && /^[0-9a-f]{16}-[0-9a-f]{12}$/.test(v.batchId)) batchId = v.batchId;
      } catch { /* missing or unreadable marker: still unarchived, batch unknown */ }
      out.push({ key, batchId: batchId ?? `${key.slice(0, 16)}-${n}`, batchKnown: batchId !== null, marker });
    }
    return out;
  }

  async markQuarantineArchived(marker, facts) {
    await writeNew(marker.replace(/\.quarantine\.json$/, '.archived.json'), { facts, at: isoNow(this.clock) });
  }

  // Re-arm bookkeeping: every FAILED_UNKNOWN entry whose scene has not been archived yet.
  async unknownUnarchived() {
    const out = [];
    for (const key of await this.keys()) {
      const s = await this.state(key);
      if (s.state === 'TERMINAL' && s.outcome === 'FAILED_UNKNOWN' && !s.archived) out.push({ key, ...s });
    }
    return out;
  }

  async markArchived(key, facts) {
    await writeNew(path.join(this.dir(key), '95-archived.json'), { key, facts, at: isoNow(this.clock) });
  }

  async headBurned(hk) {
    check(HEX64.test(hk), 'HEAD_KEY_INVALID');
    return exists(path.join(this.heads, `${hk}.json`));
  }

  // Reservation decides "this subject runs at most once at a time". origin: how the run queue picked it (usage()).
  async reserve(key, subject, { origin = 'queued' } = {}) {
    check(RESERVATION_ORIGINS.includes(origin), 'RESERVATION_ORIGIN_INVALID');
    const dir = this.dir(key);
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if (error.code === 'EEXIST') fail('BATCH_KEY_ALREADY_USED_NO_RETRY', key);
      throw error;
    }
    await writeNew(path.join(dir, '00-reserved.json'), { key, subject, headKey: headKey(subject), reservedAt: isoNow(this.clock), automaticRetryAllowed: false, origin });
  }

  // Written right after stage 1 admitted and before any Linux or scanner effect. The head record is
  // created first: if this head ever started under any base, PR or claim, starting fails here.
  async markStarted(key, facts) {
    const s = await this.state(key);
    check(s.state === 'RESERVED' && !s.abort, 'BATCH_START_REQUIRES_RESERVATION', s.state);
    try {
      await writeNew(path.join(this.heads, `${s.reserved.headKey}.json`), { headKey: s.reserved.headKey, key, subject: s.reserved.subject, startedAt: isoNow(this.clock) });
    } catch (error) {
      if (error.code === 'CREATE_ONLY_TARGET_EXISTS') fail('BATCH_HEAD_ALREADY_EXECUTED_NO_RETRY', s.reserved.headKey);
      throw error;
    }
    await writeNew(path.join(this.dir(key), '10-started.json'), { key, startedAt: isoNow(this.clock), facts });
  }

  // A failure that is not a plain stage-1 "not admitted" burns the head even if 10-started was
  // never written (stage 1 may already have published its check), so it cannot run again either.
  async burnHead(key, facts) {
    const s = await this.state(key);
    if (!s.reserved) return false; // INCOMPLETE / UNREADABLE: the head is unknown, the entry stays as evidence
    if (await this.headBurned(s.reserved.headKey)) return false;
    await writeNew(path.join(this.heads, `${s.reserved.headKey}.json`), { headKey: s.reserved.headKey, key, subject: s.reserved.subject, startedAt: isoNow(this.clock), burnedBy: facts });
    return true;
  }

  async terminal(key, outcome, facts) {
    check(OUTCOMES.includes(outcome), 'BATCH_OUTCOME_INVALID');
    const s = await this.state(key);
    check(['RESERVED', 'STARTED', 'INCOMPLETE', 'UNREADABLE'].includes(s.state), 'BATCH_TERMINAL_REQUIRES_OPEN_ENTRY', s.state);
    await writeNew(path.join(this.dir(key), '90-terminal.json'), { key, outcome, at: isoNow(this.clock), facts });
  }

  async releaseUnexecuted(key, reason, facts) {
    check(UNEXECUTED_REASONS.includes(reason), 'UNEXECUTED_REASON_INVALID');
    const s = await this.state(key);
    check(s.state === 'RESERVED', 'RELEASE_REQUIRES_UNSTARTED_ENTRY', s.state);
    const dir = this.dir(key);
    await writeNew(path.join(dir, '90-terminal.json'), { key, outcome: 'NOT_EXECUTED', reason, at: isoNow(this.clock), facts });
    const archived = path.join(this.unexecuted, `${key}-${stamp(this.clock)}-${nonce()}`);
    await renameToNew(dir, archived);
    return archived;
  }

  // The releases of one batch key since sinceMs with their reason (classify.mjs#UNEXECUTED_REASON_RULES says which ones
  // the cool-down applies to); an unreadable one counts as a release just now.
  async unexecutedRecords(key, sinceMs) {
    const out = [];
    for (const name of (await fs.readdir(this.unexecuted)).sort()) {
      if (!name.startsWith(`${key}-`)) continue;
      try {
        const { value } = await readJson(path.join(this.unexecuted, name, '90-terminal.json'));
        if (Date.parse(value.at) >= sinceMs) out.push({ at: Date.parse(value.at), reason: UNEXECUTED_REASONS.includes(value.reason) ? value.reason : null, klass: typeof value.facts?.class === 'string' ? value.facts.class : null });
      } catch (error) {
        if (!contentError(error)) throw error;
        out.push({ at: this.clock(), reason: null, klass: null });
      }
    }
    return out;
  }

  async unexecutedSince(key, sinceMs) {
    const out = [];
    for (const name of (await fs.readdir(this.unexecuted)).sort()) {
      if (!name.startsWith(`${key}-`)) continue;
      try {
        const { value } = await readJson(path.join(this.unexecuted, name, '90-terminal.json'));
        if (Date.parse(value.at) >= sinceMs) out.push(Date.parse(value.at));
      } catch (error) {
        if (!contentError(error)) throw error;
        out.push(this.clock()); // unreadable: counted as just now (cool-down applies), never a wedge
      }
    }
    return out;
  }

  async keys() {
    return (await fs.readdir(this.batches)).filter(n => HEX64.test(n)).sort();
  }

  async open() {
    const out = [];
    for (const key of await this.keys()) {
      const s = await this.state(key);
      if (s.state !== 'TERMINAL') out.push({ key, ...s });
    }
    return out;
  }

  // Executions (entries that reached 10-started) per window: the batch limit.
  async startedSince(sinceMs) {
    let n = 0;
    for (const name of await fs.readdir(this.heads)) {
      try {
        if (Date.parse((await readJson(path.join(this.heads, name))).value.startedAt) >= sinceMs) n += 1;
      } catch (error) { if (!contentError(error)) throw error; n += 1; }
    }
    return n;
  }

  // Every reservation (stage-1 evaluations included) per window: bounds junk triggers separately,
  // so they cannot use up the execution budget of real batches.
  async evaluationsSince(sinceMs) {
    let n = 0;
    for (const key of await this.keys()) {
      const r = (await this.state(key)).reserved;
      if (r && Date.parse(r.reservedAt) >= sinceMs) n += 1;
    }
    for (const name of await fs.readdir(this.unexecuted)) {
      try {
        if (Date.parse((await readJson(path.join(this.unexecuted, name, '00-reserved.json'))).value.reservedAt) >= sinceMs) n += 1;
      } catch (error) { if (!contentError(error)) throw error; n += 1; }
    }
    return n;
  }

  // The run queue's daily budgets for the window since sinceMs, from the ledger alone (one pass; see the header).
  // A record that cannot be read counts as one more execution or evaluation (never a wedge, never a free pass).
  async usage(sinceMs) {
    const u = { started: 0, lowRiskBurns: 0, startedByPr: new Map(), evaluations: 0, waitingRetries: 0, reevaluations: new Map(), releasesByHead: new Map(), stage8Retries: 0 };
    const bump = (map, k) => map.set(k, (map.get(k) ?? 0) + 1);
    // A file or entry last written before the window (with an hour's margin) cannot hold a record of it: its recorded
    // times are older still. Only a prefilter: every record it lets through is decided by its own recorded time.
    const before = async p => { try { return (await fs.stat(p)).mtimeMs < sinceMs - 3_600_000; } catch { return false; } };
    for (const name of await fs.readdir(this.heads)) {
      if (await before(path.join(this.heads, name))) continue;
      try {
        const v = (await readJson(path.join(this.heads, name))).value;
        if (Date.parse(v.startedAt) >= sinceMs) {
          if (v.burnedBy?.quotaTier === QUOTA_TIER_EVALUATION) { u.lowRiskBurns += 1; continue; }
          u.started += 1; if (Number.isSafeInteger(v.subject?.pr)) bump(u.startedByPr, v.subject.pr);
        }
      } catch (error) { if (!contentError(error)) throw error; u.started += 1; }
    }
    // One reservation: its origin, whether it executed, and how it ended (a release reason and the failure-table facts).
    const count = ({ reserved, started, reason, facts, burned = false }) => {
      const origin = RESERVATION_ORIGINS.includes(reserved.origin) ? reserved.origin : 'queued';
      const s = reserved.subject ?? {};
      if (origin === 'waiting-retry') u.waitingRetries += 1;
      const nodeRole = facts?.class === 'node-role';
      if (origin === 'new-trigger' && !nodeRole) bump(u.reevaluations, `${s.pr}:${s.headSha}`);
      const environment = ['environment', 'transient'].includes(facts?.class);
      // A burned entry that never started (a low-risk tier burn among them) is an evaluation whatever its class: it no
      // longer counts as an execution, so it must count somewhere (DESIGN §35).
      if (!started && origin !== 'waiting-retry' && !UNCOUNTED_RELEASES.includes(reason) && (burned || (!environment && !nodeRole))) u.evaluations += 1;
      if (reason && reason !== 'SUPERSEDED' && facts?.class !== 'waiting' && !nodeRole && !(environment && facts?.breakerState && facts.breakerState !== 'closed') && HEX40.test(s.headSha ?? '')) bump(u.releasesByHead, s.headSha);
    };
    const read = async file => (await exists(file)) ? (await readJson(file)).value : null;
    for (const key of await this.keys()) {
      const dir = path.join(this.batches, key);
      if (await before(dir)) continue;
      try {
        // Every try after the first one of a parked entry is a stage-8 retry (phase 2, step 2), whenever it was reserved.
        for (const name of (await fs.readdir(dir)).filter(n => /^71-try-(\d{2})\.json$/.test(n) && n !== '71-try-01.json')) {
          const at = Date.parse((await read(path.join(dir, name)))?.at);
          if (!(at < sinceMs)) u.stage8Retries += 1;
        }
        const reserved = await read(path.join(dir, '00-reserved.json'));
        if (!reserved || !(Date.parse(reserved.reservedAt) >= sinceMs)) continue;
        const terminal = await read(path.join(dir, '90-terminal.json'));
        count({ reserved, started: await exists(path.join(dir, '10-started.json')), reason: null, facts: terminal?.facts ?? null,
          burned: ['FAILED_CLEAN', 'FAILED_UNKNOWN'].includes(terminal?.outcome) });
      } catch (error) { if (!contentError(error)) throw error; u.evaluations += 1; }
    }
    for (const name of await fs.readdir(this.unexecuted)) {
      if (await before(path.join(this.unexecuted, name))) continue;
      try {
        const reserved = (await readJson(path.join(this.unexecuted, name, '00-reserved.json'))).value;
        if (!(Date.parse(reserved.reservedAt) >= sinceMs)) continue;
        const terminal = (await readJson(path.join(this.unexecuted, name, '90-terminal.json'))).value;
        count({ reserved, started: false, reason: UNEXECUTED_REASONS.includes(terminal.reason) ? terminal.reason : 'NOT_ADMITTED', facts: terminal.facts ?? null });
      } catch (error) { if (!contentError(error)) throw error; u.evaluations += 1; }
    }
    return u;
  }

  // ---- the one automatic attempt 2 (attempts.mjs) ----
  // Create-only intent next to the ledger: written after attempt 1's FAILED_CLEAN terminal, consumed by
  // reserving attempt 2's own key (a different batch key and head key: the attempt is part of both).
  async scheduleAttempt2(key1, subject2, facts, notBeforeMs) {
    const s = await this.state(key1);
    check(s.state === 'TERMINAL' && s.outcome === 'FAILED_CLEAN' && s.reserved?.subject?.attempt === 1, 'ATTEMPT2_REQUIRES_CLEAN_ATTEMPT1_TERMINAL');
    const first = s.reserved.subject;
    // Step 3c-2: a train front batch's attempt 2 tests the same S (and a head batch's never gains one).
    check(subject2.attempt === 2 && ['repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256'].every(k => subject2[k] === first[k])
      && Object.hasOwn(subject2, 'testSha') === Object.hasOwn(first, 'testSha') && subject2.testSha === first.testSha, 'ATTEMPT2_SUBJECT_CHANGED');
    const key2 = batchKey(subject2);
    await writeNew(path.join(this.attempts2, `${key1}.json`), { contract: 'clued.independent-ci.resident-attempt2/1', key1, key2, subject: subject2,
      notBefore: new Date(notBeforeMs).toISOString(), facts, at: isoNow(this.clock), automaticRetryAllowed: false });
    return key2;
  }

  // Intents that were neither consumed (attempt 2 reserved once) nor closed, oldest first. Consumption is a
  // create-only record written BEFORE the reservation, so any outcome of attempt 2 (also NOT_ADMITTED or
  // BUNDLE_UNAVAILABLE, which release its ledger entry again) ends the intent for good (PR-A review MAJOR 1).
  //
  // Primary/standby C3 (DESIGN §29.10): a node-role release of attempt 2 (this node held no role at its stage 1; nothing about the
  // PR was decided) gives the same attempt 2 back with reopenAttempt2. The intent is pending while it is not closed and every
  // consumption (consumed.json, consumed-2.json, ...) has been reopened (reopened-1.json, ...); the key is the same, so it is
  // never an attempt 3.
  async attempt2Marks(key1) {
    const names = await fs.readdir(this.attempts2);
    const count = re => names.filter(n => n.startsWith(`${key1}.`) && re.test(n.slice(key1.length + 1))).length;
    return { closed: names.includes(`${key1}.closed.json`), consumed: count(/^consumed(-\d+)?\.json$/), reopened: count(/^reopened-\d+\.json$/) };
  }

  async pendingAttempts2() {
    const out = [];
    for (const name of (await fs.readdir(this.attempts2)).sort()) {
      const m = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!m) continue;
      const marks = await this.attempt2Marks(m[1]);
      if (marks.closed || marks.consumed !== marks.reopened) continue;
      let v;
      try { v = (await readJson(path.join(this.attempts2, name))).value; } catch (error) { if (!contentError(error)) throw error; continue; }
      if (v.key1 !== m[1] || !HEX64.test(v.key2 ?? '') || batchKey(v.subject) !== v.key2) continue;
      if ((await this.state(v.key2)).state !== 'ABSENT') continue;
      out.push({ key1: v.key1, key2: v.key2, subject: v.subject, notBefore: Date.parse(v.notBefore) });
    }
    return out.sort((a, b) => a.notBefore - b.notBefore);
  }

  // Written once, right before attempt 2 is reserved; a crash in between loses attempt 2 (the safe side).
  async consumeAttempt2(key1, facts) {
    check(HEX64.test(key1), 'BATCH_KEY_INVALID');
    const marks = await this.attempt2Marks(key1);
    check(!marks.closed && marks.consumed === marks.reopened, 'ATTEMPT2_NOT_PENDING');
    await writeNew(path.join(this.attempts2, marks.consumed === 0 ? `${key1}.consumed.json` : `${key1}.consumed-${marks.consumed + 1}.json`), { key1, facts, at: isoNow(this.clock) });
  }

  // Gives a consumed attempt 2 back once: create-only, only when the latest consumption is not reopened yet and the intent is
  // not closed. The executor calls it for a node-role release of attempt 2 only (DESIGN §29.10).
  async reopenAttempt2(key1, facts) {
    check(HEX64.test(key1), 'BATCH_KEY_INVALID');
    const marks = await this.attempt2Marks(key1);
    check(!marks.closed && marks.consumed === marks.reopened + 1, 'ATTEMPT2_NOT_REOPENABLE');
    await writeNew(path.join(this.attempts2, `${key1}.reopened-${marks.reopened + 1}.json`), { key1, facts, at: isoNow(this.clock) });
  }

  async closeAttempt2(key1, facts) {
    check(HEX64.test(key1), 'BATCH_KEY_INVALID');
    await writeNew(path.join(this.attempts2, `${key1}.closed.json`), { key1, facts, at: isoNow(this.clock) });
  }

  // HALT: any process may raise it (failing safe); only the Owner re-arm path clears it.
  async halt(code, facts) {
    const file = path.join(this.root, 'HALT.json');
    if (await exists(file)) return false;
    await writeNew(file, { code, facts, at: isoNow(this.clock), clearedOnlyBy: 'owner-rearm' });
    return true;
  }

  // A HALT record that cannot be parsed (torn write) is still a HALT; its digest is that of the raw
  // bytes, so the Owner's re-arm can name it exactly and clear it through the normal path.
  async halted() {
    const file = path.join(this.root, 'HALT.json');
    if (!(await exists(file))) return null;
    try {
      return await readJson(file);
    } catch (error) {
      if (!contentError(error)) throw error;
      const raw = await fs.readFile(file);
      return { value: { code: 'HALT_RECORD_UNREADABLE', facts: {} }, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
    }
  }

  // The lasting gate: any failed-unknown or quarantined scene not archived yet keeps the executor
  // halted, whether or not HALT.json itself survived (N1).
  async unarchivedScenes() {
    return (await this.unknownUnarchived()).length + (await this.quarantinedUnarchived()).length;
  }

  // Re-arm: compare-and-swap on the exact HALT bytes the Owner reviewed, then rename it into
  // halts/ (kept forever) next to a record of who re-armed and why.
  async clearHalt(expectedSha256, rearm) {
    const current = await this.halted();
    check(current, 'NOT_HALTED');
    check(current.sha256 === expectedSha256, 'HALT_CHANGED_SINCE_REVIEW');
    // A batch that only waits for hosted signals runs nothing and is no scene: it does not block re-arm.
    check((await this.crashed()).length === 0, 'REARM_REQUIRES_NO_OPEN_BATCH');
    check((await this.quarantinedUnarchived()).length === 0, 'REARM_REQUIRES_QUARANTINE_ARCHIVED');
    check((await this.unknownUnarchived()).length === 0, 'REARM_REQUIRES_UNKNOWN_SCENES_ARCHIVED');
    const archived = path.join(this.halts, `cleared-${stamp(this.clock)}-${nonce()}.json`);
    await renameToNew(path.join(this.root, 'HALT.json'), archived);
    await writeNew(`${archived}.rearm.json`, { haltSha256: expectedSha256, rearm, at: isoNow(this.clock) });
    return archived;
  }

  async pause(source) {
    const file = path.join(this.root, 'PAUSED.json');
    if (await exists(file)) return false;
    await writeNew(file, { source, at: isoNow(this.clock) });
    return true;
  }

  // Same rule as HALT: a torn PAUSED record is still a pause, named by its raw-bytes digest, so the
  // Owner's resume clears it through the normal path (fifth review, minor 1).
  async paused() {
    const file = path.join(this.root, 'PAUSED.json');
    if (!(await exists(file))) return null;
    try {
      return await readJson(file);
    } catch (error) {
      if (!contentError(error)) throw error;
      const raw = await fs.readFile(file);
      return { value: { source: 'PAUSE_RECORD_UNREADABLE' }, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length };
    }
  }

  async resume(expectedSha256, by) {
    const current = await this.paused();
    check(current && current.sha256 === expectedSha256, 'PAUSE_CHANGED_SINCE_REVIEW');
    const archived = path.join(this.halts, `resumed-${stamp(this.clock)}-${nonce()}.json`);
    await renameToNew(path.join(this.root, 'PAUSED.json'), archived);
    await writeNew(`${archived}.resume.json`, { pauseSha256: expectedSha256, by, at: isoNow(this.clock) });
    return archived;
  }
}
