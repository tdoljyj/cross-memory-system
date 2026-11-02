// Permanent, restrictive-only head guard. No dispatch, qualification or release.
// Presence (including an empty/torn/unreadable directory) always holds the head.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, HEX64, UUID, REPO, check, digest, isoNow } from './canonical.mjs';
import { ensureDir, readJson, writeNew } from './store.mjs';

export const RELAY_QUALIFICATION_HELD = 'RELAY_QUALIFICATION_HELD';
const CONTRACT = 'clued.independent-ci.relay-qualification-head-hold/1';
const WINDOW_FIELDS = ['contract', 'qualificationRef', 'sourceManifestSha256', 'ownerReceiptRef', 'authorityDecisionId',
  'authorityDecisionSha256', 'authorityReadReceiptRef', 'subject', 'validUntil', 'allowedPhases', 'executionPolicy',
  'guarded', 'changedPaths', 'changedPathsSha256'];
const SUBJECT_FIELDS = ['repo', 'runId', 'pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256',
  'nodeProfileSha256', 'claimId', 'fence', 'executionEpoch', 'stage1JobId'];
const CODE = 'RELAY_QUALIFICATION_WINDOW_UNCONFIRMED';
function fields(value, names) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, CODE);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === names.length && names.every(k => {
    const d = descriptors[k]; return d && Object.hasOwn(d, 'value') && d.enumerable;
  }), CODE);
  return Object.fromEntries(names.map(k => [k, descriptors[k].value]));
}
function list(value, max) {
  check(Array.isArray(value), CODE);
  const d = Object.getOwnPropertyDescriptors(value), n = d.length.value;
  check(Number.isSafeInteger(n) && n > 0 && n <= max && Reflect.ownKeys(d).length === n + 1, CODE);
  return Array.from({ length: n }, (_, i) => {
    check(d[i] && Object.hasOwn(d[i], 'value') && d[i].enumerable && typeof d[i].value === 'string', CODE); return d[i].value;
  });
}
export function qualificationWindowSnapshot(value) {
  const q = fields(value, WINDOW_FIELDS), s = fields(q.subject, SUBJECT_FIELDS);
  check(WINDOW_FIELDS.filter(k => !['subject', 'allowedPhases', 'changedPaths', 'guarded'].includes(k)).every(k => typeof q[k] === 'string'), CODE);
  check(SUBJECT_FIELDS.every(k => ['pr', 'fence', 'executionEpoch'].includes(k) ? typeof s[k] === 'number' : typeof s[k] === 'string'), CODE);
  check(q.contract === 'clued.independent-ci.relay-qualification-window/1'
    && q.qualificationRef.startsWith('receipt:') && UUID.test(q.qualificationRef.slice(8))
    && UUID.test(q.ownerReceiptRef) && q.authorityDecisionId === 'c32676f4-4528-408c-b5e6-88cb27fca13a'
    && HEX64.test(q.authorityDecisionSha256) && UUID.test(q.authorityReadReceiptRef)
    && HEX64.test(q.sourceManifestSha256) && q.sourceManifestSha256 === s.sourceManifestSha256
    && ['staged', 'active'].includes(q.executionPolicy) && typeof q.guarded === 'boolean'
    && typeof q.validUntil === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(q.validUntil)
    && Number.isFinite(Date.parse(q.validUntil)) && new Date(q.validUntil).toISOString() === q.validUntil, CODE);
  check(typeof s.repo === 'string' && REPO.test(s.repo) && /^[a-f0-9]{16}-[a-f0-9]{12}$/.test(s.runId)
    && Number.isSafeInteger(s.pr) && s.pr > 0 && ['headSha', 'baseSha', 'testSha'].every(k => typeof s[k] === 'string' && HEX40.test(s[k]))
    && s.testSha === s.headSha && ['sourceManifestSha256', 'nodeProfileSha256', 'stage1JobId'].every(k => typeof s[k] === 'string' && HEX64.test(s[k]))
    && typeof s.claimId === 'string' && UUID.test(s.claimId) && Number.isSafeInteger(s.fence) && s.fence > 0
    && Number.isSafeInteger(s.executionEpoch) && s.executionEpoch > 0, CODE);
  const phases = list(q.allowedPhases, 2), paths = list(q.changedPaths, 2000);
  check(phases.every((p, i) => ['initial', 'after-ref-move'].includes(p)
      && (i === 0 || ['initial', 'after-ref-move'].indexOf(phases[i - 1]) < ['initial', 'after-ref-move'].indexOf(p)))
    && paths.every((p, i) => p.length > 0 && p.length <= 512 && !/[\\:\x00-\x1f\x7f]/.test(p) && !p.startsWith('/')
      && p.split('/').every(x => x && x !== '.' && x !== '..') && (i === 0 || paths[i - 1] < p))
    && typeof q.changedPathsSha256 === 'string' && HEX64.test(q.changedPathsSha256), CODE);
  // Source uses SHA256(JSON.stringify(paths)); resident digest sorts object keys.
  check(digest(paths) === q.changedPathsSha256, CODE);
  return Object.freeze({ ...q, subject: Object.freeze(s), allowedPhases: Object.freeze(phases), changedPaths: Object.freeze(paths) });
}
export function qualificationHeadKey(s) {
  check(typeof s.repo === 'string' && REPO.test(s.repo) && typeof s.headSha === 'string' && HEX40.test(s.headSha), CODE);
  return digest({ contract: CONTRACT, repo: s.repo.toLowerCase(), headSha: s.headSha });
}
export function qualificationWindowMatches(q, subject, policy) {
  return q.subject.repo === subject.repo && q.subject.pr === subject.pr && q.subject.headSha === subject.headSha
    && q.subject.baseSha === subject.baseSha && q.subject.testSha === (subject.testSha ?? subject.headSha)
    && q.sourceManifestSha256 === policy.ciSourceManifestSha256 && q.subject.nodeProfileSha256 === policy.nodeProfileSha256;
}
export class RelayQualificationHolds {
  constructor(stateRoot, clock = Date.now) { this.root = path.join(stateRoot, 'relay-qualification-holds'); this.clock = clock; }
  directory(s) { return path.join(this.root, qualificationHeadKey(s)); }
  async inspect(subject) {
    try {
      const root = await fs.lstat(this.root).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!root) return { held: false };
      check(root.isDirectory() && !root.isSymbolicLink(), CODE);
      const dir = this.directory(subject);
      const st = await fs.lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!st) return { held: false };
      check(st.isDirectory() && !st.isSymbolicLink(), CODE);
      const { value } = await readJson(path.join(dir, '00-window.json'), 32768);
      const q = qualificationWindowSnapshot(value.window);
      check(value.contract === CONTRACT && value.headKey === qualificationHeadKey(subject)
        && qualificationHeadKey(q.subject) === value.headKey && value.windowSha256 === digest(q), CODE);
      return { held: true, record: value };
    } catch { return { held: true, unconfirmed: true }; }
  }
  async arm(window, subject, { key, batchId = null } = {}) {
    const q = qualificationWindowSnapshot(window);
    check(qualificationHeadKey(q.subject) === qualificationHeadKey(subject) && typeof key === 'string' && HEX64.test(key)
      && (batchId === null || typeof batchId === 'string' && /^[a-f0-9]{16}-[a-f0-9]{12}$/.test(batchId)), CODE);
    await ensureDir(this.root);
    const dir = this.directory(subject);
    try { await fs.mkdir(dir, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') return { created: false, ...(await this.inspect(subject)) }; throw e; }
    // A crash before/during this write leaves the directory as a permanent hold.
    await writeNew(path.join(dir, '00-window.json'), { contract: CONTRACT, headKey: qualificationHeadKey(subject), key, batchId,
      window: q, windowSha256: digest(q), at: isoNow(this.clock), authority: 'RESTRICTIVE_HOLD_ONLY' });
    return { created: true, held: true, window: q };
  }
  async recordStage1(subject, { key, batchId, result }) {
    check(typeof key === 'string' && HEX64.test(key) && typeof batchId === 'string' && /^[a-f0-9]{16}-[a-f0-9]{12}$/.test(batchId), CODE);
    const safe = { key, batchId, nativeReceiptSha256: typeof result.factsSha256 === 'string' && HEX64.test(result.factsSha256) ? result.factsSha256 : null };
    // The engine may supply fixed public locators. Never persist its raw result.
    const locator = result.stage1Locator;
    if (locator) {
      const v = fields(locator, ['nonce', 'outcomeSha256', 'nativeReceiptSha256', 'jobId']);
      check(typeof v.nonce === 'string' && /^[a-f0-9]{32}$/.test(v.nonce)
        && ['outcomeSha256', 'nativeReceiptSha256', 'jobId'].every(k => typeof v[k] === 'string' && HEX64.test(v[k])), CODE);
      safe.locator = v;
    }
    await writeNew(path.join(this.directory(subject), '10-stage1-locator.json'), { contract: CONTRACT, ...safe, at: isoNow(this.clock),
      authority: 'LOCATOR_ONLY_NOT_STAGE13_PROOF' });
  }
  async stage1Intent(subject, { key, batchId }) {
    await writeNew(path.join(this.directory(subject), '05-stage1-intent.json'), { contract: CONTRACT, key, batchId, at: isoNow(this.clock) });
  }
  // A locator is only a fixed reference for the installed Source to re-prove.
  // Never return arbitrary engine fields or treat this record as qualification.
  async readStage1Locator(subject) {
    const held = await this.inspect(subject);
    check(held.held === true && held.record && held.unconfirmed !== true, CODE);
    const file = path.join(this.directory(subject), '10-stage1-locator.json');
    try { await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const { value } = await readJson(file, 4096);
    const names = ['contract', 'key', 'batchId', 'nativeReceiptSha256', 'at', 'authority'];
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const v = fields(value, Object.hasOwn(descriptors, 'locator') ? [...names, 'locator'] : names);
    check(v.contract === CONTRACT && v.key === held.record.key && v.batchId === held.record.batchId
      && v.authority === 'LOCATOR_ONLY_NOT_STAGE13_PROOF'
      && (v.nativeReceiptSha256 === null || typeof v.nativeReceiptSha256 === 'string' && HEX64.test(v.nativeReceiptSha256)), CODE);
    if (!Object.hasOwn(v, 'locator')) return null;
    const locator = fields(v.locator, ['nonce', 'outcomeSha256', 'nativeReceiptSha256', 'jobId']);
    check(typeof locator.nonce === 'string' && /^[a-f0-9]{32}$/.test(locator.nonce)
      && ['outcomeSha256', 'nativeReceiptSha256', 'jobId'].every(k => typeof locator[k] === 'string' && HEX64.test(locator[k]))
      && locator.jobId === held.record.window.subject.stage1JobId
      && (v.nativeReceiptSha256 === null || locator.nativeReceiptSha256 === v.nativeReceiptSha256), CODE);
    return Object.freeze(locator);
  }
  async stage1Attempted(subject) {
    try { await fs.lstat(path.join(this.directory(subject), '05-stage1-intent.json')); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; return true; }
  }
}
