// Optional Owner settings. Since node governance v1 every number comes from the standard (retention.mjs RETENTION_RULE, the
// three newest archived generations plus the current one); the file only names archived generations the Owner protects.
// Absence is no extra protection; a malformed file stops deletion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check } from './canonical.mjs';
import { readBounded } from './store.mjs';

export const SETTINGS_FILE = 'retention-settings.json';
export const SETTINGS_CONTRACT = 'clued.independent-ci.retention-settings/1';
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
export function parseRetentionSettings(bytes) {
  const code = 'RETENTION_SETTINGS_INVALID';
  let v;
  try { v = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { check(false, code); }
  check(keys(v, ['contract', 'generations']) && v.contract === SETTINGS_CONTRACT, code);
  if (v.generations !== undefined) check(keys(v.generations, ['protected'])
    && Array.isArray(v.generations.protected) && v.generations.protected.length <= 2000
    && v.generations.protected.every(n => typeof n === 'string' && /^g[1-9][0-9]{0,8}(?:-[0-9]{1,8})?$/.test(n)), code);
  return v;
}
export async function readRetentionSettings(file) {
  let found = false;
  try {
    const st = await fs.lstat(file);
    found = true;
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 262144) return { ok: false, code: 'RETENTION_SETTINGS_INVALID' };
    const real = await fs.realpath(file);
    const same = process.platform === 'win32' ? path.resolve(real).toLowerCase() === path.resolve(file).toLowerCase() : path.resolve(real) === path.resolve(file);
    if (!same) return { ok: false, code: 'RETENTION_SETTINGS_INVALID' };
    const raw = await readBounded(file, 262144, 'RETENTION_SETTINGS_INVALID');
    const after = await fs.lstat(file);
    if (after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size || after.mtimeMs !== st.mtimeMs || raw.length > 262144)
      return { ok: false, code: 'RETENTION_SETTINGS_CHANGED' };
    return { ok: true, settings: parseRetentionSettings(raw) };
  } catch (e) {
    return e.code === 'ENOENT' && !found ? { ok: true, settings: {} }
      : { ok: false, code: e.code === 'RETENTION_SETTINGS_INVALID' ? e.code : 'RETENTION_SETTINGS_UNREADABLE' };
  }
}
