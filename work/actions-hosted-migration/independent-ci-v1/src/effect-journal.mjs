import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './proof.mjs';

const KEY = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const transitions = Object.freeze({ intent: ['authorized', 'not_sent'], authorized: ['sent', 'not_sent'],
  sent: ['created', 'settled', 'uncertain', 'revoked'], created: ['completing', 'revoked'],
  completing: ['settled', 'revoked'], uncertain: ['settled', 'revoked'], settled: ['revoked'],
  not_sent: [], revoked: [] });

// The directory is service state, outside PR workspaces. Installation must
// independently qualify its ACLs. No automatic replay follows an uncertain send.
export class EffectJournal {
  static async open(directory) {
    const resolved = path.resolve(directory);
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    for (let current = resolved; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_journal_directory');
      if (current === path.dirname(current)) break;
    }
    return new EffectJournal(resolved);
  }
  constructor(directory) { this.directory = directory; }
  file(key) { if (!KEY.test(key)) fail('invalid_effect_key'); return path.join(this.directory, `${key}.json`); }
  async read(key) {
    const file = this.file(key);
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('unsafe_journal_file');
    const contents = await fs.readFile(file, 'utf8');
    let record;
    try { record = JSON.parse(contents); }
    catch { fail('invalid_effect_record'); }
    if (record?.contract !== 'independent-ci.effect.v1' || record.key !== key
      || typeof record.value?.state !== 'string' || !Object.hasOwn(transitions, record.value.state)
      || record.integrity !== digest(record.value)) fail('invalid_effect_record');
    return record.value;
  }
  async begin(key, subject) {
    const file = this.file(key);
    const value = { state: 'intent', subject, subjectSha256: digest(subject), revision: 1 };
    const record = { contract: 'independent-ci.effect.v1', key, value, integrity: digest(value) };
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await this.read(key);
      if (previous.subjectSha256 !== value.subjectSha256) fail('effect_identity_conflict');
      return { existing: true, value: previous };
    }
    try { await handle.writeFile(canonical(record)); await handle.sync(); }
    finally { await handle.close(); }
    return { existing: false, value };
  }
  async transition(key, expectedState, nextState, details = {}) {
    if (!transitions[expectedState]?.includes(nextState)) fail('invalid_effect_transition');
    const file = this.file(key), lock = `${file}.lock`;
    let lockHandle;
    try { lockHandle = await fs.open(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('effect_busy'); throw error; }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const previous = await this.read(key);
      if (!previous || previous.state !== expectedState) fail('effect_state_conflict');
      const next = { ...previous, state: nextState, revision: previous.revision + 1, details };
      const record = { contract: 'independent-ci.effect.v1', key, value: next, integrity: digest(next) };
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(canonical(record)); await handle.sync(); }
      finally { await handle.close(); }
      // A crash before rename keeps the old state; after a 'sent' state was
      // persisted the controller may only reconcile, never repeat the write.
      await fs.rename(temporary, file);
      return next;
    } finally {
      await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await lockHandle.close();
      await fs.unlink(lock);
    }
  }
}

// Role-on-head mutex K(head, role) (hosted relay design §7.4). Hosted relay and
// local publication of one role on one head are mutually exclusive: each path
// begins K with create-exclusive semantics ('wx') before it begins its own
// effect key. The first holder wins forever; K has no release. The same holder
// may re-enter (crash recovery continues through its own key's states); any
// other holder is refused with role_already_published_on_head. Neither the base
// nor the attempt is part of K (PR-A review MAJOR 2): a role is published at
// most once per head across bases, batches, attempts and Source installs. This
// costs nothing, because the one automatic attempt 2 only follows a stage 0-2
// failure where no role was published. Both paths must open the same journal
// directory for K to exclude anything (v2: state\v2\effects-scan); the v1 local
// one-shot path does not take K at all (it has its own journal, so K could
// exclude nothing there, and v1 jobs differ by claim, fence and base).
export const ROLE_PUBLICATION_CONTRACT = 'clued.independent-ci.role-publication/2';
const ROLE_PATHS = ['local', 'relay'];

// Merge train (DESIGN §41.4): a train front batch (S != H, never relayed) takes its own K(head, S, role) apart from the
// non-front run of H; every K without testSha is the one it always was.
export function rolePublicationKey({ repo, headSha, role, checkName, appId, ...rest }) {
  const front = Object.hasOwn(rest, 'testSha');
  if (Object.keys(rest).length !== (front ? 1 : 0) || (front && (!/^[a-f0-9]{40}$/.test(rest.testSha ?? '') || rest.testSha === headSha))
    || typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(headSha ?? '')
    || typeof role !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(role) || typeof checkName !== 'string'
    || !checkName || checkName.length > 100 || !Number.isSafeInteger(appId) || appId < 1) fail('invalid_role_publication_subject');
  return digest({ contract: ROLE_PUBLICATION_CONTRACT, repo, headSha, role, checkName, appId, ...(front ? { testSha: rest.testSha } : {}) });
}

// holder: { path: 'local' | 'relay', effectKey, externalId }
export async function claimRolePublication(journal, subject, holder) {
  const key = rolePublicationKey(subject);
  if (!holder || !ROLE_PATHS.includes(holder.path) || !KEY.test(holder.effectKey ?? '') || typeof holder.externalId !== 'string'
    || !holder.externalId.startsWith('independent-ci:') || holder.externalId.length > 200) fail('invalid_role_publication_holder');
  const record = { contract: ROLE_PUBLICATION_CONTRACT, repo: subject.repo, headSha: subject.headSha, role: subject.role,
    checkName: subject.checkName, appId: subject.appId, ...(Object.hasOwn(subject, 'testSha') ? { testSha: subject.testSha } : {}),
    holder: { path: holder.path, effectKey: holder.effectKey, externalId: holder.externalId } };
  let claimed;
  try { claimed = await journal.begin(key, record); }
  catch (error) { if (error?.code === 'effect_identity_conflict') fail('role_already_published_on_head'); throw error; }
  return { key, existing: claimed.existing, holder: record.holder };
}

export async function readRolePublication(journal, subject) {
  const key = rolePublicationKey(subject);
  const value = await journal.read(key);
  return value ? { key, holder: value.subject.holder } : { key, holder: null };
}
