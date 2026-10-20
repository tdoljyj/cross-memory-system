import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest } from './proof.mjs';

const KEY = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const transitions = Object.freeze({ intent: ['authorized', 'not_sent'], authorized: ['sent', 'not_sent'],
  sent: ['settled', 'uncertain', 'revoked'], uncertain: ['settled', 'revoked'], settled: ['revoked'],
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
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    if (record.contract !== 'independent-ci.effect.v1' || record.key !== key
      || record.integrity !== digest(record.value) || !transitions[record.value.state]) fail('invalid_effect_record');
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
