// The ops journal (spec A4): upgrade\ops\<opId>\, files only ever created, never rewritten.
//   000-request.json            the request's own bytes
//   001-cancel.json             the cancel request's own bytes (accepted only before STAGE)
//   010-accept.plan.json        the plan (plan.mjs)
//   <NNN>-<step>.intent.json    written BEFORE a step acts: what it will touch (before), what it means to leave (planned), its args
//   <NNN>-<step>.result.json    written after: ok, code, what it found (after), whether it was only recorded on resume (replayed)
//   900-terminal.json           the outcome
// The journal IS the operation's state: the machine keeps nothing else, so a restart at any point reads it and goes on.
//
// Retries take the next number of their range (drain 040..049, pause 050..059, stage-windows 060..064, stage-linux
// 065..069): a step's file is never written twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE, HEX64, UUID, canonicalJson, check, isoNow, parseBoundedJson, sha256 } from '../../src/canonical.mjs';
import { exists } from '../../src/store.mjs';
import { UPGRADE_OUTCOMES } from '../../src/upgrade-mailbox.mjs';
import { U } from './codes.mjs';

export const JOURNAL_CONTRACT = 'clued.independent-ci.resident-upgrade-journal/1';
export const STEPS = Object.freeze({
  accept: 10, grant: 20, hold: 30, drain: 40, pause: 50, 'stage-windows': 60, 'stage-linux': 65, stop: 70, 'switch-linux': 80, 'switch-windows': 85,
  start: 90, verify: 100, resume: 110, 'rollback-stop': 200, 'rollback-switch-windows': 210, 'rollback-switch-linux': 215, 'rollback-start': 220,
  'rollback-verify': 230, 'keep-paused-notify': 240, retention: 300,
});
// Steps that a deferral may repeat, and how many numbers each has.
export const RETRY_SLOTS = Object.freeze({ drain: 10, pause: 10, 'stage-windows': 5, 'stage-linux': 5 });
export const TERMINAL_SEQ = 900;
export const REQUEST_FILE = '000-request.json';
export const CANCEL_FILE = '001-cancel.json';
export const PLAN_FILE = '010-accept.plan.json';
export const TERMINAL_FILE = '900-terminal.json';
const RECORD = /^(\d{3})-([a-z-]{3,40})\.(intent|result)\.json$/;
const RECORD_MAX_BYTES = 256 * 1024;
const DETAIL_VALUE = /^[A-Za-z0-9_.:-]{1,80}$/;

export const seqName = (seq, step, kind) => `${String(seq).padStart(3, '0')}-${step}.${kind}.json`;
export function seqFor(step, attempt = 0) {
  const base = STEPS[step];
  check(base !== undefined, 'UPGRADE_STEP_UNKNOWN', step);
  check(attempt === 0 || (RETRY_SLOTS[step] && attempt < RETRY_SLOTS[step]), 'UPGRADE_RETRY_SLOTS_EXHAUSTED', step);
  return base + attempt;
}
export const stepOfSeq = seq => {
  for (const [step, base] of Object.entries(STEPS)) if (seq >= base && seq < base + (RETRY_SLOTS[step] ?? 1)) return step;
  return null;
};

// Raw bytes, create-only, flushed.
export async function writeBytesNew(file, bytes) {
  let handle;
  try { handle = await fs.open(file, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') check(false, 'CREATE_ONLY_TARGET_EXISTS', path.basename(file));
    throw error;
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return sha256(bytes);
}
export const jsonBytes = value => Buffer.from(canonicalJson(value) + '\n', 'utf8');

// Only ids, codes, digests, numbers and flags: never free text, a path or a token.
function checkDetail(detail) {
  check(detail !== null && typeof detail === 'object' && !Array.isArray(detail) && Object.keys(detail).length <= 16, 'UPGRADE_JOURNAL_DETAIL_REFUSED');
  for (const [k, v] of Object.entries(detail)) {
    check(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k), 'UPGRADE_JOURNAL_DETAIL_REFUSED', k);
    check(v === null || typeof v === 'boolean' || Number.isSafeInteger(v) || (typeof v === 'string' && DETAIL_VALUE.test(v)), 'UPGRADE_JOURNAL_DETAIL_REFUSED', k);
  }
  return detail;
}

// An observation of one object: { exists, sha256|null }; a plan for it: { sha256 } (null: must exist, content decided by the step) or 'absent'.
const matchesPlanned = (a, p) => (p === 'absent' ? !a?.exists : (a?.exists === true && (p.sha256 === null || a.sha256 === p.sha256)));
const sameObservation = (a, b) => (!a?.exists && !b?.exists) || (a?.exists === true && b?.exists === true && a.sha256 === b.sha256);

export class Journal {
  constructor(dir, { opId, clock = Date.now, pid = process.pid }) { this.dir = dir; this.opId = opId; this.clock = clock; this.pid = pid; }

  static async create(opsRoot, opId, requestBytes, options = {}) {
    check(UUID.test(opId ?? ''), U.REQUEST_REFUSED, 'opId');
    const dir = path.join(opsRoot, opId);
    await fs.mkdir(dir); // a second request with the same id is refused by the existing directory
    await writeBytesNew(path.join(dir, REQUEST_FILE), requestBytes);
    return new Journal(dir, { opId, ...options });
  }

  static open(opsRoot, opId, options = {}) {
    check(UUID.test(opId ?? ''), U.JOURNAL_INCONSISTENT, 'opId');
    return new Journal(path.join(opsRoot, opId), { opId, ...options });
  }

  file(name) { return path.join(this.dir, name); }

  // The ops directory is the upgrader's own (SYSTEM and administrators write there): a size-bounded read is enough.
  async readSmall(name, max = RECORD_MAX_BYTES) {
    const st = await fs.lstat(this.file(name));
    check(st.isFile() && st.size > 0 && st.size <= max, U.JOURNAL_INCONSISTENT, name);
    return fs.readFile(this.file(name));
  }

  async readRecord(name) {
    return parseBoundedJson(await this.readSmall(name), RECORD_MAX_BYTES, U.JOURNAL_INCONSISTENT);
  }

  // Everything the machine needs, from the files alone.
  async load() {
    const names = (await fs.readdir(this.dir)).sort();
    const requestBytes = await this.readSmall(REQUEST_FILE, 4096);
    const out = { opId: this.opId, requestBytes, requestSha256: sha256(requestBytes), request: JSON.parse(requestBytes.toString('utf8')),
      plan: null, planSha256: null, cancel: null, terminal: null, steps: [] };
    if (names.includes(PLAN_FILE)) {
      const bytes = await this.readSmall(PLAN_FILE, 4 * 1024 * 1024);
      out.plan = JSON.parse(bytes.toString('utf8'));
      out.planSha256 = sha256(bytes);
    }
    if (names.includes(CANCEL_FILE)) out.cancel = { sha256: sha256(await this.readSmall(CANCEL_FILE, 4096)) };
    if (names.includes(TERMINAL_FILE)) out.terminal = await this.readRecord(TERMINAL_FILE);
    const bySeq = new Map();
    for (const name of names) {
      const m = RECORD.exec(name);
      if (!m) continue;
      const seq = Number(m[1]);
      check(stepOfSeq(seq) === m[2], U.JOURNAL_INCONSISTENT, name);
      const entry = bySeq.get(seq) ?? { seq, step: m[2], intent: null, result: null };
      entry[m[3]] = await this.readRecord(name);
      check(entry[m[3]].contract === JOURNAL_CONTRACT && entry[m[3]].seq === seq && entry[m[3]].step === m[2] && entry[m[3]].opId === this.opId, U.JOURNAL_INCONSISTENT, name);
      bySeq.set(seq, entry);
    }
    out.steps = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    for (const s of out.steps) check(s.intent !== null, U.JOURNAL_INCONSISTENT, `result-without-intent:${s.seq}`);
    // At most one step may be open (an intent without its result): the machine finishes one before it starts the next.
    check(out.steps.filter(s => s.result === null).length <= 1, U.JOURNAL_INCONSISTENT, 'two-open-steps');
    return out;
  }

  async writePlan(planBytes) { return writeBytesNew(this.file(PLAN_FILE), planBytes); }
  async writeCancel(bytes) { return writeBytesNew(this.file(CANCEL_FILE), bytes); }
  async hasPlan() { return exists(this.file(PLAN_FILE)); }

  async intent({ seq, step, attempt = 1, before = {}, planned = {}, args = {} }) {
    check(stepOfSeq(seq) === step, 'UPGRADE_STEP_UNKNOWN', `${seq}-${step}`);
    const value = { contract: JOURNAL_CONTRACT, opId: this.opId, seq, step, kind: 'intent', attempt, at: isoNow(this.clock), upgraderPid: this.pid, before, planned, args };
    await writeBytesNew(this.file(seqName(seq, step, 'intent')), jsonBytes(value));
    return value;
  }

  async result(intent, { ok, code = null, after = {}, replayed = false, detail = {} }) {
    check(typeof ok === 'boolean' && (ok ? code === null : CODE.test(code ?? '')), 'UPGRADE_JOURNAL_RESULT_REFUSED');
    const value = { contract: JOURNAL_CONTRACT, opId: this.opId, seq: intent.seq, step: intent.step, kind: 'result', attempt: intent.attempt, at: isoNow(this.clock),
      upgraderPid: this.pid, ok, code, after, replayed, detail: checkDetail(detail) };
    await writeBytesNew(this.file(seqName(intent.seq, intent.step, 'result')), jsonBytes(value));
    return value;
  }

  async terminal({ outcome, code = null, generation, grantId = null }) {
    check(UPGRADE_OUTCOMES.includes(outcome) && (code === null || CODE.test(code)) && Number.isSafeInteger(generation) && (grantId === null || UUID.test(grantId)), 'UPGRADE_TERMINAL_REFUSED');
    const value = { contract: JOURNAL_CONTRACT, opId: this.opId, seq: TERMINAL_SEQ, step: 'terminal', kind: 'terminal', outcome, code, generation, grantId, at: isoNow(this.clock) };
    await writeBytesNew(this.file(TERMINAL_FILE), jsonBytes(value));
    return value;
  }

  // The resume rule (spec A4), on the objects of the open step only:
  //   'replay'        after = planned (and the step planned something): record the result, replayed.
  //   'redo'          after = before: do the step again.
  //   'items'         neither, but every object is in a state a rename-only step can leave it in (as before, as planned, or
  //                   moved out and not yet replaced): the step's per-item rules finish it.
  //   'inconsistent'  anything else: UPGRADE_JOURNAL_INCONSISTENT.
  static recover({ before = {}, planned = {}, after = {} }) {
    const plannedKeys = Object.keys(planned);
    const keys = new Set([...Object.keys(before), ...plannedKeys, ...Object.keys(after)]);
    if (plannedKeys.length > 0 && [...keys].every(k => planned[k] !== undefined && matchesPlanned(after[k], planned[k]))) return 'replay';
    if ([...keys].every(k => sameObservation(after[k], before[k]))) return 'redo';
    const itemOk = k => sameObservation(after[k], before[k]) || (planned[k] !== undefined && matchesPlanned(after[k], planned[k])) || !after[k]?.exists;
    return [...keys].every(itemOk) ? 'items' : 'inconsistent';
  }
}

export const observation = (sha) => (sha === null || sha === undefined ? { exists: false, sha256: null } : { exists: true, sha256: sha });
export const plannedSha = sha => (sha === 'absent' ? 'absent' : { sha256: sha ?? null });
