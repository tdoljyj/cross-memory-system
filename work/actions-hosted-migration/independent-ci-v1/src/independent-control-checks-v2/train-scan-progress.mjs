// Non-authoritative continuation hints. Existing full/strict cursors and proofs keep their contracts. A hint can only
// save enumeration/judgment work inside the current cursor; callers publish it after the unchanged revocation barrier.
import { createHash } from 'node:crypto';
import { canonical } from '../proof.mjs';

export const SCAN_CONTRACT = 'clued.independent-ci.train-scan-progress/1';
export const MAX_SCAN_ITEMS = 10_000;
export const scanDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const SHA = /^[0-9a-f]{40}$/, HEX = /^[0-9a-f]{64}$/;
const count = n => Number.isSafeInteger(n) && n >= 0;
const plain = o => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
const exact = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const iso = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === s;
const cursor = s => s === null || typeof s === 'string' && s.length > 0 && s.length <= 1024;
function validPull(p) {
  return p === null || exact(p, ['key', 'snapshot', 'phase', 'cursor', 'cursors', 'commits', 'pushes', 'pushTotal', 'heads', 'next'])
    && HEX.test(p.key) && exact(p.snapshot, ['headSha', 'count', 'updatedAt']) && SHA.test(p.snapshot.headSha)
    && count(p.snapshot.count) && iso(p.snapshot.updatedAt) && ['commits', 'pushes', 'judge'].includes(p.phase) && cursor(p.cursor)
    && Array.isArray(p.cursors) && p.cursors.length <= 100 && p.cursors.every(c => typeof c === 'string' && cursor(c))
    && new Set(p.cursors).size === p.cursors.length
    && Array.isArray(p.commits) && p.commits.length <= MAX_SCAN_ITEMS && p.commits.every(h => SHA.test(h))
    && new Set(p.commits).size === p.commits.length
    && Array.isArray(p.pushes) && p.pushes.length <= MAX_SCAN_ITEMS && p.pushes.every(e => exact(e, ['before', 'after']) && [e.before, e.after].every(h => h === null || SHA.test(h)))
    && (p.pushTotal === null || count(p.pushTotal)) && Array.isArray(p.heads) && p.heads.length <= MAX_SCAN_ITEMS * 3 + 1
    && p.heads.every(h => SHA.test(h)) && new Set(p.heads).size === p.heads.length && count(p.next) && p.next <= p.heads.length;
}
export function validateScanProgress(p) {
  if (!exact(p, ['contract', 'writtenAt', 'runId', 'binding', 'units']) || p.contract !== SCAN_CONTRACT || !iso(p.writtenAt)
    || !/^[0-9a-f]{16}-[0-9a-f]{12}$/.test(p.runId ?? '') || !HEX.test(p.binding ?? '')
    || !plain(p.units) || Object.keys(p.units).some(k => !['base', 'incremental', 'full'].includes(k))
    || Object.values(p.units).some(u => !exact(u, ['key', 'next', 'pull']) || !HEX.test(u.key) || !count(u.next) || !validPull(u.pull))) fail('invalid_train_scan_progress');
  return p;
}

export class ScanProgress {
  static async open({ store, lane, identity, clock }) {
    const binding = scanDigest(identity), previous = await store.readScanProgress(lane);
    if (previous && Date.parse(previous.writtenAt) > clock()) fail('TRAIN_SCAN_STATE_UNREADABLE');
    return new ScanProgress({ store, lane, binding, previous: previous?.binding === binding ? previous : null, clock });
  }
  constructor({ store, lane, binding, previous, clock }) {
    Object.assign(this, { store, lane, binding, clock });
    this.units = structuredClone(previous?.units ?? {}); this.before = this.token();
  }
  token() { return scanDigest(this.units); }
  unit(name, key) {
    const digest = scanDigest(key);
    if (this.units[name]?.key !== digest) this.units[name] = { key: digest, next: 0, pull: null };
    return this.units[name];
  }
  clear(name) { delete this.units[name]; }
  async save(runId, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    if (this.token() === this.before) return false;
    const previous = await this.store.readScanProgress(this.lane);
    // Record filenames have no order within one millisecond. Wait for a distinct timestamp; never bless a conflict.
    if (previous && Date.parse(previous.writtenAt) === this.clock()) await sleep(1);
    if (previous && Date.parse(previous.writtenAt) >= this.clock()) fail('TRAIN_SCAN_STATE_UNWRITTEN');
    await this.store.writeScanProgress(this.lane, { writtenAt: new Date(this.clock()).toISOString(), runId, binding: this.binding, units: this.units });
    return true;
  }
}

export async function scanHeads({ sweeper, heads, unit, options, late = sweeper.late, cap = Infinity }) {
  if (!count(unit.next) || unit.next > heads.length) fail('TRAIN_SCAN_STATE_UNREADABLE');
  const targets = [];
  while (unit.next < heads.length) {
    if (late() || targets.length >= cap) return { complete: false, targets };
    targets.push(...await sweeper.judge([heads[unit.next]], options));
    unit.next++;
  }
  return { complete: true, targets };
}

// Every page is tied to the current PR snapshot. No judgment happens before both complete inventories have been read.
// On resume a live snapshot invalidates cached pages/positions if the PR changed. A final live snapshot detects races.
export async function scanPull({ sweeper, github, pull, scope = 'all', unit, options, late = sweeper.late, cap = Infinity }) {
  if (!['open', 'closed'].includes(pull?.state) || pull.state === 'closed' && typeof pull.merged !== 'boolean') fail('TRAIN_PULLS_INCOMPLETE');
  if (typeof github.readPullHistorySnapshot !== 'function' || typeof github.readPullHistoryPage !== 'function') {
    const r = scope === 'current' && pull.state === 'closed' ? pull.merged ? pull.baseRef === 'main'
      ? await sweeper.forcePushHeadsOfPull(pull.number) : await sweeper.headsOfPull(pull.number) : { heads: [pull.headSha] }
      : await sweeper.headsOfPull(pull.number);
    if (r.tooMany) fail('TRAIN_PULL_OVER_250_COMMITS');
    const key = scanDigest({ pull, scope, heads: r.heads });
    if (unit.pull?.key !== key) unit.pull = { key, snapshot: { headSha: pull.headSha, count: 0, updatedAt: pull.updatedAt }, phase: 'judge', cursor: null,
      cursors: [], commits: [], pushes: [], pushTotal: null, heads: r.heads, next: 0 };
    const result = await scanHeads({ sweeper, heads: r.heads, unit: unit.pull, options, late, cap });
    if (result.complete) unit.pull = null;
    return result;
  }
  const snapshot = await github.readPullHistorySnapshot(pull.number);
  if (!SHA.test(snapshot?.headSha ?? '') || !count(snapshot?.count) || !iso(snapshot?.updatedAt)
    || snapshot.headSha !== pull.headSha || Date.parse(snapshot.updatedAt) !== Date.parse(pull.updatedAt)) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
  const key = scanDigest({ number: pull.number, scope, state: pull.state, merged: pull.merged, baseRef: pull.baseRef, snapshot });
  const onlyHead = scope === 'current' && pull.state === 'closed' && pull.merged === false;
  const onlyPushes = scope === 'current' && pull.state === 'closed' && pull.merged === true && pull.baseRef === 'main';
  if (unit.pull?.key !== key) {
    unit.pull = { key, snapshot, phase: onlyHead ? 'judge' : onlyPushes ? 'pushes' : 'commits', cursor: null,
      cursors: [], commits: [], pushes: [], pushTotal: null, heads: onlyHead ? [snapshot.headSha] : [], next: 0 };
    sweeper.stats.prs++;
  }
  const p = unit.pull;
  if (p.phase !== 'commits' && !onlyHead && ((!onlyPushes && (p.commits.length !== snapshot.count || !p.commits.includes(snapshot.headSha)))
    || onlyPushes && p.commits.length !== 0)) fail('TRAIN_SCAN_STATE_UNREADABLE');
  if (p.phase === 'judge') {
    const expected = onlyHead ? [snapshot.headSha] : [...new Set([...(onlyPushes ? [] : [snapshot.headSha, ...p.commits]), ...p.pushes.flatMap(e => [e.before, e.after]).filter(Boolean)])];
    if ((!onlyHead && p.pushes.length !== p.pushTotal) || scanDigest(expected) !== scanDigest(p.heads)) fail('TRAIN_SCAN_STATE_UNREADABLE');
  }
  while (p.phase !== 'judge') {
    if (late()) return { complete: false, targets: [] };
    const page = await github.readPullHistoryPage(pull.number, p.phase, p.cursor);
    if (page.headSha !== snapshot.headSha || page.updatedAt !== snapshot.updatedAt || !Array.isArray(page.rows)
      || page.rows.length > 100 || !count(page.count) || !cursor(page.next)) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
    if (p.phase === 'commits') {
      if (page.count !== snapshot.count || page.count > MAX_SCAN_ITEMS || page.rows.some(h => !SHA.test(h))) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
      p.commits.push(...page.rows);
      sweeper.stats.commits += page.rows.length;
      if (p.commits.length > page.count || new Set(p.commits).size !== p.commits.length) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
      if (page.next === null && (p.commits.length !== page.count || !p.commits.includes(snapshot.headSha))) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
    } else {
      p.pushTotal ??= page.count;
      if (p.pushTotal !== p.pushes.length + page.count || p.pushTotal > MAX_SCAN_ITEMS
        || page.rows.some(e => !plain(e) || ![e.before, e.after].every(h => h === null || SHA.test(h)))) fail('TRAIN_FORCE_PUSHES_INCOMPLETE');
      p.pushes.push(...page.rows);
      if (p.pushes.length > p.pushTotal || page.next === null && p.pushes.length !== p.pushTotal) fail('TRAIN_FORCE_PUSHES_INCOMPLETE');
    }
    if (page.next !== null) {
      if (page.rows.length === 0 || p.cursors.includes(page.next) || p.cursors.length >= 100) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
      p.cursors.push(page.next); p.cursor = page.next;
    } else if (p.phase === 'commits') { p.phase = 'pushes'; p.cursor = null; p.cursors = []; }
    else {
      const final = await github.readPullHistorySnapshot(pull.number);
      if (scanDigest(final) !== scanDigest(snapshot)) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
      p.phase = 'judge'; p.cursor = null; p.cursors = [];
      p.heads = [...new Set([...(onlyPushes ? [] : [snapshot.headSha, ...p.commits]), ...p.pushes.flatMap(e => [e.before, e.after]).filter(Boolean)])];
    }
  }
  const result = await scanHeads({ sweeper, heads: p.heads, unit: p, options, late, cap });
  // The current slice's judgments also belong to that snapshot, including when resuming directly in phase 'judge'.
  // A push during the check reads must not let a cached head position certify the changed pull.
  try {
    if (scanDigest(await github.readPullHistorySnapshot(pull.number)) !== scanDigest(snapshot)) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
    if (!onlyHead) {
      // updated_at has only second precision. A push away and back in that second can keep head/count/timestamp equal;
      // timeline events are append-only, so rechecking their live count detects that race even for a restored inventory.
      const live = await github.readPullHistoryPage(pull.number, 'pushes', null);
      if (live.headSha !== snapshot.headSha || live.updatedAt !== snapshot.updatedAt || live.count !== p.pushTotal) fail('TRAIN_FORCE_PUSHES_INCOMPLETE');
    }
  } catch (e) { unit.pull = null; throw e; }
  if (result.complete) unit.pull = null;
  return result;
}
