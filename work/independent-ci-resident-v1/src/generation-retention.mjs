// Only archived generations. Live content and generations/ are outside this module's write boundary. Node governance v1
// (Owner decision): enabled, the three newest archived generations and the current one stay; settings may protect more.
import fs from 'node:fs/promises';
import path from 'node:path';
import { treeFacts, removeTree } from './retention.mjs';
import { readBounded } from './store.mjs';
const NAME = /^g([1-9][0-9]{0,8})(?:-[0-9]{1,8})?$/;
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function plain(dir) {
  const s = await fs.lstat(dir);
  return s.isDirectory() && !s.isSymbolicLink() && same(path.resolve(await fs.realpath(dir)), path.resolve(dir));
}
async function boundary(root) {
  if (!await plain(root) || !await plain(path.join(root, 'archive'))) return null;
  if (!await plain(path.join(root, 'upgrade')) || !await plain(path.join(root, 'upgrade', 'ops'))) return null;
  const current = (await readBounded(path.join(root, 'upgrade', 'current.json'), 65536, 'RETENTION_GENERATIONS_BOUNDARY_UNCONFIRMED')).toString('utf8');
  const generation = JSON.parse(current)?.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  // Unknown or incomplete upgrade journals forbid cleanup, including a freshly created operation.
  for (const op of await fs.readdir(path.join(root, 'upgrade', 'ops'))) {
    const dir = path.join(root, 'upgrade', 'ops', op);
    if (!await plain(dir)) return null;
    const terminal = JSON.parse((await readBounded(path.join(dir, '900-terminal.json'), 65536, 'RETENTION_GENERATIONS_BOUNDARY_UNCONFIRMED')).toString('utf8'));
    if (terminal?.kind !== 'terminal' || !['SUCCEEDED', 'SUCCEEDED_STILL_PAUSED', 'ROLLED_BACK_PAUSED', 'REFUSED', 'CANCELLED', 'GRANT_REJECTED', 'GRANT_EXPIRED', 'STALE'].includes(terminal.outcome)) return null;
  }
  return { current, generation };
}
export async function pruneArchivedGenerations({ root, settings = {}, allowDelete = false, remove = removeTree, authorizeDelete = async () => true }) {
  const result = { keepNewest: 3, candidates: [], deleted: [], partial: null, code: null };
  try {
    try { await fs.lstat(path.join(root, 'archive')); } catch (e) { if (e.code === 'ENOENT') return result; throw e; }
    const before = await boundary(root);
    if (!before) return { ...result, code: 'RETENTION_GENERATIONS_BOUNDARY_UNCONFIRMED' };
    const dir = path.join(root, 'archive');
    const entries = (await fs.readdir(dir)).filter(n => NAME.test(n)).map(name => ({ name, generation: Number(NAME.exec(name)[1]) }));
    // A name alone is not proof of an archived generation. Refuse the whole inventory if a record cannot be confirmed.
    for (const e of entries) {
      if (!await plain(path.join(dir, e.name))) return { ...result, code: 'RETENTION_GENERATIONS_BOUNDARY_UNCONFIRMED' };
      const record = JSON.parse((await readBounded(path.join(dir, e.name, 'generation.json'), 65536, 'RETENTION_GENERATIONS_RECORD_INVALID')).toString('utf8'));
      if (record.generation !== e.generation || !/^[0-9a-f]{64}$/.test(record.packageManifestSha256 ?? '')
        || !/^[0-9a-f]{64}$/.test(record.filesSha256 ?? '') || !['residentBinPath', 'brokerBinPath', 'companionTaskArguments'].every(k => typeof record[k] === 'string' && record[k].length > 0))
        return { ...result, code: 'RETENTION_GENERATIONS_RECORD_INVALID' };
    }
    const latest = new Set([...new Set(entries.map(e => e.generation))].sort((a, b) => b - a).slice(0, 3));
    const protectedNames = new Set(settings.generations?.protected ?? []);
    const candidates = entries.filter(e => !latest.has(e.generation) && e.generation !== before.generation && !protectedNames.has(e.name))
      .sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name));
    result.candidates = candidates.slice(0, 16).map(e => e.name);
    if (!candidates.length) return result;
    if (!allowDelete) return { ...result, code: 'RETENTION_GENERATIONS_MAINTENANCE_REQUIRED' };
    for (const e of candidates.slice(0, 16)) {
      const p = path.join(dir, e.name), original = await fs.lstat(p), facts = await treeFacts(p);
      const now = await boundary(root), current = await fs.lstat(p);
      if (!await authorizeDelete() || !now || now.current !== before.current || !await plain(p) || !facts.complete || facts.links
        || original.ino !== current.ino || original.dev !== current.dev || original.mtimeMs !== current.mtimeMs)
        return { ...result, code: 'RETENTION_GENERATIONS_CHANGED' };
      try { await remove(p); } catch {
        return { ...result, partial: e.name, code: 'RETENTION_GENERATIONS_DELETE_UNCONFIRMED' };
      }
      result.deleted.push(e.name);
    }
    return result;
  } catch (e) {
    if (e.code === 'ENOENT') return { ...result, code: 'RETENTION_GENERATIONS_BOUNDARY_UNCONFIRMED' };
    return { ...result, code: 'RETENTION_GENERATIONS_UNCONFIRMED' };
  }
}
