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
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HEX40, HEX64, REPO, ResidentError, check, digest, fail, isoNow } from './canonical.mjs';
import { ensureDir, exists, nonce, readJson, renameToNew, writeNew } from './store.mjs';

export const BATCH_KEY_CONTRACT = 'clued.independent-ci.resident-batch-key/1';
export const HEAD_KEY_CONTRACT = 'clued.independent-ci.resident-head-key/1';
export const OUTCOMES = Object.freeze(['COMPLETED', 'FAILED_CLEAN', 'FAILED_UNKNOWN']);
export const UNEXECUTED_REASONS = Object.freeze(['NOT_ADMITTED', 'BUNDLE_UNAVAILABLE']);

function subjectCheck({ repo, pr, headSha, baseSha, sourceManifestSha256, attempt }) {
  check(REPO.test(repo) && Number.isSafeInteger(pr) && pr > 0, 'BATCH_KEY_SUBJECT_INVALID');
  check(HEX40.test(headSha) && HEX40.test(baseSha), 'BATCH_KEY_COMMIT_INVALID');
  check(HEX64.test(sourceManifestSha256), 'BATCH_KEY_SOURCE_INVALID');
  check(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 9, 'BATCH_KEY_ATTEMPT_INVALID');
}

export function batchKey(s) {
  subjectCheck(s);
  return digest({ contract: BATCH_KEY_CONTRACT, repo: s.repo, pr: s.pr, headSha: s.headSha, baseSha: s.baseSha, sourceManifestSha256: s.sourceManifestSha256, attempt: s.attempt });
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
    let reserved, started, terminal, archived;
    try {
      const read = async name => (await exists(path.join(dir, name))) ? (await readJson(path.join(dir, name))).value : null;
      reserved = await read('00-reserved.json');
      started = await read('10-started.json');
      terminal = await read('90-terminal.json');
      archived = await read('95-archived.json');
    } catch (error) {
      if (!contentError(error)) throw error;
      return { state: 'UNREADABLE' };
    }
    if (terminal) return { state: 'TERMINAL', outcome: terminal.outcome, reserved, started, terminal, archived };
    // A crash between mkdir and the reservation record leaves an INCOMPLETE entry; it is open, so
    // recovery terminalises it (FAILED_UNKNOWN) instead of wedging the ledger.
    if (!reserved) return { state: 'INCOMPLETE', reserved: null, started };
    return { state: started ? 'STARTED' : 'RESERVED', reserved, started };
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

  // Reservation decides "this subject runs at most once at a time".
  async reserve(key, subject) {
    const dir = this.dir(key);
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if (error.code === 'EEXIST') fail('BATCH_KEY_ALREADY_USED_NO_RETRY', key);
      throw error;
    }
    await writeNew(path.join(dir, '00-reserved.json'), { key, subject, headKey: headKey(subject), reservedAt: isoNow(this.clock), automaticRetryAllowed: false });
  }

  // Written right after stage 1 admitted and before any Linux or scanner effect. The head record is
  // created first: if this head ever started under any base, PR or claim, starting fails here.
  async markStarted(key, facts) {
    const s = await this.state(key);
    check(s.state === 'RESERVED', 'BATCH_START_REQUIRES_RESERVATION', s.state);
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

  // ---- the one automatic attempt 2 (attempts.mjs) ----
  // Create-only intent next to the ledger: written after attempt 1's FAILED_CLEAN terminal, consumed by
  // reserving attempt 2's own key (a different batch key and head key: the attempt is part of both).
  async scheduleAttempt2(key1, subject2, facts, notBeforeMs) {
    const s = await this.state(key1);
    check(s.state === 'TERMINAL' && s.outcome === 'FAILED_CLEAN' && s.reserved?.subject?.attempt === 1, 'ATTEMPT2_REQUIRES_CLEAN_ATTEMPT1_TERMINAL');
    const first = s.reserved.subject;
    check(subject2.attempt === 2 && ['repo', 'pr', 'headSha', 'baseSha', 'sourceManifestSha256'].every(k => subject2[k] === first[k]), 'ATTEMPT2_SUBJECT_CHANGED');
    const key2 = batchKey(subject2);
    await writeNew(path.join(this.attempts2, `${key1}.json`), { contract: 'clued.independent-ci.resident-attempt2/1', key1, key2, subject: subject2,
      notBefore: new Date(notBeforeMs).toISOString(), facts, at: isoNow(this.clock), automaticRetryAllowed: false });
    return key2;
  }

  // Intents whose attempt 2 has not been reserved and not been closed, oldest first.
  async pendingAttempts2() {
    const out = [];
    for (const name of (await fs.readdir(this.attempts2)).sort()) {
      const m = /^([0-9a-f]{64})\.json$/.exec(name);
      if (!m || await exists(path.join(this.attempts2, `${m[1]}.closed.json`))) continue;
      let v;
      try { v = (await readJson(path.join(this.attempts2, name))).value; } catch (error) { if (!contentError(error)) throw error; continue; }
      if (v.key1 !== m[1] || !HEX64.test(v.key2 ?? '') || batchKey(v.subject) !== v.key2) continue;
      if ((await this.state(v.key2)).state !== 'ABSENT') continue;
      out.push({ key1: v.key1, key2: v.key2, subject: v.subject, notBefore: Date.parse(v.notBefore) });
    }
    return out.sort((a, b) => a.notBefore - b.notBefore);
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
    check((await this.open()).length === 0, 'REARM_REQUIRES_NO_OPEN_BATCH');
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
