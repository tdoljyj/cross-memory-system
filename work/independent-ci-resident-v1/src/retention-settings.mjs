// Optional Owner settings. Absence keeps the installed rule; malformed settings stop deletion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { check } from './canonical.mjs';
import { RETENTION_RULE } from './retention.mjs';
import { readBounded } from './store.mjs';

export const SETTINGS_FILE = 'retention-settings.json';
export const SETTINGS_CONTRACT = 'clued.independent-ci.retention-settings/1';
const integer = n => Number.isSafeInteger(n) && n >= 0;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
export function parseRetentionSettings(bytes) {
  const code = 'RETENTION_SETTINGS_INVALID';
  let v;
  try { v = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { check(false, code); }
  check(keys(v, ['contract', 'windows', 'linux', 'emptyKeep', 'generations', 'disk']) && v.contract === SETTINGS_CONTRACT, code);
  for (const spool of ['windows', 'linux']) if (v[spool] !== undefined) {
    check(keys(v[spool], ['success', 'failure']), code);
    for (const c of Object.values(v[spool])) check(keys(c, ['classBudgetBytes', 'minKeepPerClass'])
      && integer(c.classBudgetBytes) && integer(c.minKeepPerClass) && c.minKeepPerClass >= 1, code);
  }
  check(v.emptyKeep === undefined || ['legacy', 'refuse', 'allow'].includes(v.emptyKeep), code);
  if (v.generations !== undefined) check(keys(v.generations, ['enabled', 'keepNewest', 'protected'])
    && typeof v.generations.enabled === 'boolean' && v.generations.keepNewest === 3
    && Array.isArray(v.generations.protected) && v.generations.protected.length <= 2000
    && v.generations.protected.every(n => typeof n === 'string' && /^g[1-9][0-9]{0,8}(?:-[0-9]{1,8})?$/.test(n)), code);
  if (v.disk !== undefined) check(keys(v.disk, ['thresholdBytes', 'drives']) && integer(v.disk.thresholdBytes)
    && Array.isArray(v.disk.drives) && v.disk.drives.length >= 1 && v.disk.drives.length <= 26
    && new Set(v.disk.drives).size === v.disk.drives.length && v.disk.drives.every(d => /^[A-Z]:$/.test(d)), code);
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
export function retentionRule(settings, spool) {
  if (!settings?.[spool] || Object.keys(settings[spool]).length === 0) return RETENTION_RULE;
  return { ...RETENTION_RULE, classRules: Object.fromEntries(['success', 'failure'].map(c => [c,
    settings[spool][c] ?? { classBudgetBytes: RETENTION_RULE.classBudgetBytes, minKeepPerClass: RETENTION_RULE.minKeepPerClass }])) };
}
export function retentionKeep(keep, settings) {
  if (!keep.ok || keep.entries !== 0) return keep;
  return settings.emptyKeep === 'refuse' ? { ok: false, code: 'RETENTION_EMPTY_KEEP_UNCONFIRMED' } : keep;
}
