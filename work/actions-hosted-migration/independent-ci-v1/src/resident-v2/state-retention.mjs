// Retention of clued-control's state (merge train step 3c-2b, DESIGN §41.7, §22.5; safety as §35.3). The resident service may
// only read state\v2\receipts and cannot write the other areas, so stage 10 runs this as clued-control
// (train-maintenance.mjs#main): at most once a day, after its facts are written, within a time budget. Nothing here fails the
// run: each pass writes its record (PASS_CONTRACT) to state\v2\receipts\retention\<ms>-<runId>.json, readable by the resident
// and the Owner, and to the observation log; an error is only logged.
//
// The stage outcome receipts, segmented by month. The open segment stays flat in state\v2\receipts\: every entry still writes
// outcome-<nonce>.json there (stage-inputs.mjs#writeOutcome) and every reader still reads it there by nonce, minutes after it
// was written: the invoker (invoke-stage.mjs), the generic helper (FormalSession0V2.OutcomeSha256 hashes exactly that path into
// the native receipt) and the supervisor's stop bundle. So the outcome contract, its name and its path stay as they are, and
// the installed behaviour does not change; writing into a month directory instead would make the C# helper, the invoker and
// the supervisor agree on a month for a nonce across a month boundary. A pass closes the months before the current one
// instead: each outcome-*.json whose modification time (UTC) lies in an earlier month and at least seven days back moves (link +
// unlink, never over another file) into receipts\<yyyy-mm>\ under its own name; when none is left,
// receipts\index\<yyyy-mm>.json (SEGMENTS_CONTRACT, the month before the current one, create-only) seals that everything up to
// it has left the open segment, and later passes read only that index until the next month. A closed outcome is found at
// receipts\<yyyy-mm>\outcome-<nonce>.json (the index lists the months); a flat one from before this code is simply part of the
// open segment until a pass closes its month. The helper's windows-formal-entry-<nonce>.json receipts carry a protected DACL
// without DELETE for clued-control and stay flat, as do the observation log and the publication-recovery audits. Month
// directories, the index and retention\ inherit the receipts ACL (acl-model.json: clued-control modify, the resident read).
//
// Pruning, by the time a record's own name carries (never a modification time), the newest record of each kind always staying:
//   train-shadow         kept whole until the Owner's review before the train goes on (TRAIN_REVIEW_FILE), then 90 days. The
//                        mark lives in resident\owner\train-review\, the one folder under owner\ clued-control may read
//                        (install-resident.ps1 Get-AclPlan 'owner\train-review'; written by the Owner with tools/rearm-tool.mjs
//                        mark-train-shadow-reviewed, §41.9 step 3); an install without that folder leaves the mark unreadable and
//                        every shadow record stays.
//   train-sweep          sweep proofs, full-sweep records and front batches: 90 days.
//   green-ledger\closed  a <yyyy-mm> directory one year after its month ended.
//   receipts\retention   these pass records: 90 days.
// As §35.3: planned first; only names of the area's own kinds directly below the area's own real directory; a redirected
// directory, or a link, junction or special file among them (or inside a month) refuses the whole area; a regular file with a
// second hard link (a write or a close that crashed between link and unlink) stays; every target is re-checked right before it
// goes and a change stops the pass; bounded per pass and by the time budget.
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../proof.mjs';
import { STATE_V2, WIN_RESIDENT } from './layout.mjs';

const DAY = 86_400_000;
export const PASS_CONTRACT = 'clued.independent-ci.state-retention-pass/1';
export const SEGMENTS_CONTRACT = 'clued.independent-ci.entry-outcome-segments/1';
export const TRAIN_REVIEW_CONTRACT = 'clued.independent-ci.train-shadow-reviewed/1';
export const TRAIN_REVIEW_DIRECTORY = 'train-review';
export const TRAIN_REVIEW_NAME = 'train-shadow-reviewed.json';
export const TRAIN_REVIEW_FILE = `${WIN_RESIDENT}\\owner\\${TRAIN_REVIEW_DIRECTORY}\\${TRAIN_REVIEW_NAME}`;
export const PASS_DIRECTORY = 'retention';
export const INDEX_DIRECTORY = 'index';
export const PASS_EVERY_MS = DAY;
export const PASS_BUDGET_MS = 20_000;
// Seven days, not one (review R2 minor 7): the flat-path readers by nonce (invoke-stage.mjs, and the supervisor's stop bundle
// Read-StopFiles of an old nonce, scripts/ci/clued-independent-supervisor.mjs) never look in a month directory, so an outcome
// a stop request or a late reader may still need stays flat for a week after its month ended.
export const CLOSE_MARGIN_MS = 7 * DAY;
export const MAX_MOVES_PER_PASS = 10_000;
export const MAX_NAMES = 64;
export const OUTCOME_NAME = /^outcome-[0-9a-f]{32}\.json$/;
export const DEFAULT_ROOTS = Object.freeze({ receipts: STATE_V2.receipts, trainShadow: STATE_V2.trainShadow, trainSweep: STATE_V2.trainSweep, greenLedger: STATE_V2.greenLedger });
const RUN = '[0-9a-f]{16}-[0-9a-f]{12}';
const RUN_ID = new RegExp(`^${RUN}$`);
const STAMPED = new RegExp(`^(\\d{13})-${RUN}\\.json$`);
const SWEPT = new RegExp(`^(strict-proof|strict-round|proof|full-shadow|full-on|front)-(\\d{13})-${RUN}-[0-9a-f]{8}\\.json$`);
const MONTH = /^(\d{4})-(\d{2})$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (ok, code) => { if (!ok) fail(code); };
const iso = ms => new Date(ms).toISOString();
const monthOf = ms => iso(ms).slice(0, 7);
const monthStart = m => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const stamped = kind => n => { const m = STAMPED.exec(n); return m && { kind, time: Number(m[1]) }; };
const errorCode = e => (/^RETENTION_[A-Z0-9_]{1,60}$/.test(e?.code ?? '') ? e.code
  : ['EPERM', 'EACCES', 'EBUSY'].includes(e?.code) ? 'RETENTION_PERMISSION_REFUSED' : 'RETENTION_OPERATION_UNCONFIRMED');

// root: a DEFAULT_ROOTS key; parse(name) -> { kind, time (ms) } | null (not ours: never touched); keepNewest per kind.
export const STATE_RETENTION_RULES = Object.freeze({
  'train-shadow': Object.freeze({ root: 'trainShadow', sub: [], directories: false, keepMs: 90 * DAY, keepNewest: 1, review: true, maxDeletes: 2000, parse: stamped('shadow') }),
  'train-sweep': Object.freeze({ root: 'trainSweep', sub: [], directories: false, keepMs: 90 * DAY, keepNewest: 1, review: false, maxDeletes: 2000,
    parse: n => { const m = SWEPT.exec(n); return m && { kind: m[1], time: Number(m[2]) }; } }),
  // a month's time is its end (the first instant of the next month)
  'green-ledger-closed': Object.freeze({ root: 'greenLedger', sub: ['closed'], directories: true, keepMs: 365 * DAY, keepNewest: 0, review: false, maxDeletes: 4,
    parse: n => { const m = MONTH.exec(n), mo = m ? Number(m[2]) : 0; return mo >= 1 && mo <= 12 ? { kind: 'month', time: Date.UTC(Number(m[1]), mo, 1) } : null; } }),
  'retention-passes': Object.freeze({ root: 'receipts', sub: [PASS_DIRECTORY], directories: false, keepMs: 90 * DAY, keepNewest: 1, review: false, maxDeletes: 200, parse: stamped('pass') }),
});

// 'missing' | 'ok' | 'redirected' (not a directory, a link or junction, or a real path elsewhere).
async function realDirectory(dir) {
  let st;
  try { st = await fs.lstat(dir); } catch (e) { if (e?.code === 'ENOENT') return 'missing'; throw e; }
  return st.isDirectory() && !st.isSymbolicLink() && same(path.resolve(await fs.realpath(dir)), path.resolve(dir)) ? 'ok' : 'redirected';
}

async function ownDirectory(dir) {
  await fs.mkdir(dir, { recursive: true });
  check(await realDirectory(dir) === 'ok', 'RETENTION_AREA_REDIRECTED');
}

// One entry: { dir, bytes, entries, ino, linked (a second hard link), odd (a link, junction or special file, or one inside a month) }.
async function entryFacts(p, directories) {
  const st = await fs.lstat(p);
  if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || st.isDirectory() !== directories) return { odd: true };
  if (st.isFile()) return { dir: false, odd: false, bytes: st.size, entries: 1, ino: st.ino, linked: st.nlink !== 1 };
  let bytes = 0, entries = 0, linked = false;
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    const s = await fs.lstat(path.join(p, e.name));
    if (s.isSymbolicLink() || !s.isFile()) return { odd: true };
    bytes += s.size; entries++; linked ||= s.nlink !== 1;
  }
  return { dir: true, odd: false, bytes, entries, ino: st.ino, linked };
}

// A month holds files only; each is re-checked as it goes, a link or anything else met stops it.
async function removeMonth(p) {
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    const f = path.join(p, e.name), s = await fs.lstat(f);
    check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'RETENTION_LINK_REFUSED');
    await fs.unlink(f);
  }
  await fs.rmdir(p);
}

// The Owner's review mark before the train goes on: { reviewedAt (ms) | null, code } (null: nothing of train-shadow goes).
export async function readTrainReview(file = TRAIN_REVIEW_FILE) {
  let st;
  try { st = await fs.lstat(file); } catch (e) { return { reviewedAt: null, code: e?.code === 'ENOENT' ? 'RETENTION_REVIEW_PENDING' : 'RETENTION_REVIEW_UNREADABLE' }; }
  try {
    check(st.isFile() && !st.isSymbolicLink() && st.size <= 4096, 'RETENTION_REVIEW_INVALID');
    const v = JSON.parse(await fs.readFile(file, 'utf8'));
    check(v && typeof v === 'object' && Object.keys(v).sort().join() === 'contract,ref,reviewedAt' && v.contract === TRAIN_REVIEW_CONTRACT
      && typeof v.reviewedAt === 'string' && Number.isFinite(Date.parse(v.reviewedAt)) && typeof v.ref === 'string' && v.ref.length >= 1 && v.ref.length <= 200, 'RETENTION_REVIEW_INVALID');
    return { reviewedAt: Date.parse(v.reviewedAt), code: null };
  } catch (e) { return { reviewedAt: null, code: ['EPERM', 'EACCES'].includes(e?.code) ? 'RETENTION_REVIEW_UNREADABLE' : 'RETENTION_REVIEW_INVALID' }; }
}

// One pass over one area: inventory, plan, apply. Returns the facts the pass record carries.
export async function pruneArea({ area, roots = DEFAULT_ROOTS, now, reviewedAt = null, reviewCode = null, until = Infinity, clock = Date.now }) {
  const rule = STATE_RETENTION_RULES[area];
  check(rule, 'RETENTION_AREA_UNKNOWN');
  const dir = path.join(roots[rule.root], ...rule.sub);
  const facts = { area, refused: null, refusedName: null, considered: 0, kept: 0, deleted: 0, deletedBytes: 0, names: [], deferred: 0, stopped: null };
  if (rule.review && reviewedAt === null) return { ...facts, refused: reviewCode ?? 'RETENTION_REVIEW_PENDING' };
  const entries = [];
  try {
    const state = await realDirectory(dir);
    if (state === 'missing') return facts;
    if (state !== 'ok') return { ...facts, refused: 'RETENTION_AREA_REDIRECTED' };
    for (const name of (await fs.readdir(dir)).sort()) {
      const id = rule.parse(name);
      if (id) entries.push({ name, ...id, ...(await entryFacts(path.join(dir, name), rule.directories)) });
    }
  } catch { return { ...facts, refused: 'RETENTION_AREA_UNREADABLE' }; }
  facts.considered = entries.length;
  const odd = entries.find(e => e.odd);
  if (odd) return { ...facts, refused: 'RETENTION_LINK_REFUSED', refusedName: odd.name };
  const due = [];
  for (const kind of new Set(entries.map(e => e.kind))) {
    const newestFirst = entries.filter(e => e.kind === kind).sort((a, b) => (b.time - a.time) || (a.name < b.name ? 1 : -1));
    due.push(...newestFirst.slice(rule.keepNewest).filter(e => e.time < now - rule.keepMs));
  }
  due.sort((a, b) => (a.time - b.time) || (a.name < b.name ? -1 : 1));
  const go = due.filter(e => !e.linked);
  facts.kept = due.length - go.length;
  let done = 0;
  for (const e of go.slice(0, rule.maxDeletes)) {
    if (clock() > until) break;
    const p = path.join(dir, e.name);
    let again = null;
    try { again = await entryFacts(p, rule.directories); } catch { /* gone or unreadable: changed */ }
    if (again?.odd || again?.linked) { facts.stopped = { name: e.name, code: 'RETENTION_LINK_REFUSED', partial: false }; break; }
    if (!again || again.dir !== e.dir || again.bytes !== e.bytes || again.entries !== e.entries || again.ino !== e.ino) {
      facts.stopped = { name: e.name, code: 'RETENTION_CHANGED_SINCE_PLAN', partial: false }; break;
    }
    try { if (e.dir) await removeMonth(p); else await fs.unlink(p); } catch (error) { facts.stopped = { name: e.name, code: errorCode(error), partial: e.dir }; break; }
    done++; facts.deletedBytes += e.bytes;
    if (facts.names.length < MAX_NAMES) facts.names.push(e.name);
  }
  facts.deleted = done;
  facts.deferred = go.length - done - (facts.stopped ? 1 : 0);
  return facts;
}

async function readSeal(file, month) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
  let v = null;
  try { v = JSON.parse(text); } catch { /* checked below */ }
  check(v?.contract === SEGMENTS_CONTRACT && v.month === month, 'RETENTION_SEGMENT_INDEX_INVALID');
  return true;
}

// Closes the months before the current one of the open outcome segment (see the head of this file).
export async function closeOutcomeMonths({ receipts = STATE_V2.receipts, now, until = Infinity, clock = Date.now, maxMoves = MAX_MOVES_PER_PASS }) {
  const current = monthOf(now), previous = monthOf(monthStart(current) - 1);
  const facts = { area: 'receipts-segments', refused: null, closedThrough: null, sealed: false, moved: 0, segments: {}, keptFlat: 0, deferred: 0, budgetUsed: false, stopped: null };
  const due = [], months = new Set();
  try {
    const state = await realDirectory(receipts);
    if (state === 'missing') return facts;
    if (state !== 'ok') return { ...facts, refused: 'RETENTION_AREA_REDIRECTED' };
    if (await readSeal(path.join(receipts, INDEX_DIRECTORY, `${previous}.json`), previous)) return { ...facts, closedThrough: previous };
    for (const e of await fs.readdir(receipts, { withFileTypes: true })) {
      if (clock() > until) return { ...facts, budgetUsed: true };
      if (MONTH.test(e.name)) { if (e.isDirectory()) months.add(e.name); continue; }
      if (!OUTCOME_NAME.test(e.name)) continue;
      const st = await fs.lstat(path.join(receipts, e.name));
      if (st.mtimeMs >= monthStart(current)) continue;
      if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) { facts.keptFlat++; continue; }
      if (st.mtimeMs > now - CLOSE_MARGIN_MS) { facts.deferred++; continue; }
      due.push({ name: e.name, month: monthOf(st.mtimeMs), size: st.size, ino: st.ino });
    }
  } catch (error) { return { ...facts, refused: error?.code === 'RETENTION_SEGMENT_INDEX_INVALID' ? error.code : 'RETENTION_AREA_UNREADABLE' }; }
  due.sort((a, b) => (a.name < b.name ? -1 : 1));
  const ready = new Set();
  for (const d of due) {
    if (facts.moved >= maxMoves || clock() > until) { facts.budgetUsed = true; break; }
    const from = path.join(receipts, d.name), target = path.join(receipts, d.month), to = path.join(target, d.name);
    try {
      if (!ready.has(d.month)) { await ownDirectory(target); ready.add(d.month); months.add(d.month); }
      const st = await fs.lstat(from);
      check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size === d.size && st.ino === d.ino, 'RETENTION_CHANGED_SINCE_PLAN');
      try { await fs.link(from, to); } catch (e) {
        // a pass that stopped between link and unlink left the copy: only the same bytes may stand for it
        if (e?.code !== 'EEXIST' || !(await fs.readFile(from)).equals(await fs.readFile(to))) throw e;
      }
      await fs.unlink(from);
    } catch (error) { facts.stopped = { name: d.name, code: errorCode(error), partial: false }; break; }
    facts.moved++; facts.segments[d.month] = (facts.segments[d.month] ?? 0) + 1;
  }
  facts.deferred += due.length - facts.moved;
  if (facts.deferred === 0 && !facts.stopped) {
    try {
      const index = path.join(receipts, INDEX_DIRECTORY);
      await ownDirectory(index);
      const h = await fs.open(path.join(index, `${previous}.json`), 'wx', 0o600);
      try { await h.writeFile(canonical({ contract: SEGMENTS_CONTRACT, month: previous, sealedAt: iso(now), segments: [...months].sort(), keptFlat: facts.keptFlat }) + '\n'); await h.sync(); }
      finally { await h.close(); }
      facts.sealed = true; facts.closedThrough = previous;
    } catch (error) { facts.stopped = { name: `${INDEX_DIRECTORY}\\${previous}.json`, code: errorCode(error), partial: false }; }
  }
  return facts;
}

async function lastPass(dir) {
  const state = await realDirectory(dir);
  if (state === 'missing') return null;
  check(state === 'ok', 'RETENTION_AREA_REDIRECTED');
  let last = null;
  for (const name of await fs.readdir(dir)) { const m = STAMPED.exec(name); if (m && (last === null || Number(m[1]) > last)) last = Number(m[1]); }
  return last;
}

// Stage 10's daily pass (train-maintenance.mjs#main). Never throws: { skipped } when not due or out of time, the pass record
// when it ran, { error } when it could not (logged).
export async function stateRetention({ runId, roots = DEFAULT_ROOTS, reviewFile = TRAIN_REVIEW_FILE, clock = Date.now, log = null, notAfter = Infinity, budgetMs = PASS_BUDGET_MS }) {
  try {
    check(RUN_ID.test(runId ?? ''), 'RETENTION_RUN_ID_INVALID');
    const now = clock(), until = Math.min(now + budgetMs, notAfter);
    if (until - now < 5_000) return { skipped: 'RETENTION_PASS_NO_TIME' };
    const passes = path.join(roots.receipts, PASS_DIRECTORY), last = await lastPass(passes);
    if (last !== null && now - last < PASS_EVERY_MS && now >= last) return { skipped: 'RETENTION_PASS_NOT_DUE' };
    const review = await readTrainReview(reviewFile);
    const segments = await closeOutcomeMonths({ receipts: roots.receipts, now, until, clock });
    const areas = [];
    for (const area of Object.keys(STATE_RETENTION_RULES)) areas.push(await pruneArea({ area, roots, now, reviewedAt: review.reviewedAt, reviewCode: review.code, until, clock }));
    const record = { contract: PASS_CONTRACT, at: iso(now), runId, review: { reviewedAt: review.reviewedAt === null ? null : iso(review.reviewedAt), code: review.code }, segments, areas };
    await ownDirectory(passes);
    const h = await fs.open(path.join(passes, `${String(now).padStart(13, '0')}-${runId}.json`), 'wx', 0o600);
    try { await h.writeFile(canonical(record) + '\n'); await h.sync(); } finally { await h.close(); }
    try { log?.('state_retention', record); } catch { /* the pass record stands */ }
    return record;
  } catch (error) {
    const code = errorCode(error);
    try { log?.('state_retention_failed', { code }); } catch { /* nothing more to record */ }
    return { error: code };
  }
}
