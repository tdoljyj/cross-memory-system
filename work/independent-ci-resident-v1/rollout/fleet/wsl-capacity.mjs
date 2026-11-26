// The Owner's WSL memory limit, written by the universal package (Task 87d330d0; FABLE-drill-memory-short-20261124.md section 3; ADR 0030
// revision 1). The node's capacity profile in scripts/ci/self-hosted/node-profiles.json (the one source of the number, carried in the
// package at its repository path) names wsl_memory_gb; this module writes it as memory=<n>GB into the [wsl2] section of the Owner's
// %USERPROFILE%\.wslconfig, and nothing else:
//   - every other byte stays: other keys and sections, comments, line ends, a BOM (only the value of a [wsl2] memory= line changes;
//     a missing key is added under the first [wsl2] header, a missing section at the end);
//   - a backup of the old file first (<file>.clued-backup-<UTC>, create-only), then the new bytes through a temporary file and a rename;
//   - no wsl.exe, no restart, no distribution touched: the limit takes effect when the Owner's WSL VM next starts.
// The node is found by its host name (hosts[].hostname, case-insensitive, exactly one; the drill finds its registry entry the same way).
// It never fails its caller: a host it cannot place, a profile or file it cannot read, or a write that fails is { status: 'skipped',
// reason } and the file is left as it was (an auxiliary step may only not happen; it never holds an upgrade or a reinstall).
// Under a test marker it writes only inside the temporary directory (src/production-root-guard.mjs): a test never reaches the
// Owner's real file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REFUSED_UNDER_TEST, writableUnderTest } from '../../src/production-root-guard.mjs';
import { NODE_PROFILES } from './facts.mjs';

export { NODE_PROFILES };
export const BACKUP_INFIX = '.clued-backup-';
export const defaultWslConfigPath = () => path.join(os.homedir(), '.wslconfig');

const SECTION = /^\s*\[([^\]]*)\]\s*(?:[#;].*)?$/;
const MEMORY = /^(\s*memory\s*=\s*)(.*?)(\s*)$/i;
const skipped = (reason, detail) => ({ status: 'skipped', reason, ...(detail === undefined ? {} : { detail }), from: null, to: null, backup: null });

// The memory value of the host's capacity profile ('17GB'), or { reason } when it cannot be placed.
export function capacityMemoryFor(profilesBytes, hostname) {
  if (!profilesBytes) return { reason: 'PROFILES_MISSING' };
  let data;
  try { data = JSON.parse(Buffer.from(profilesBytes).toString('utf8')); } catch { return { reason: 'PROFILES_UNREADABLE' }; }
  const want = String(hostname ?? '').toLowerCase();
  const hosts = Array.isArray(data?.hosts) ? data.hosts.filter(h => want !== '' && typeof h?.hostname === 'string' && h.hostname.toLowerCase() === want) : [];
  if (hosts.length === 0) return { reason: 'HOST_NOT_REGISTERED' };
  if (hosts.length > 1) return { reason: 'HOST_AMBIGUOUS' };
  const name = hosts[0].capacity_profile;
  const profiles = data.capacity_profiles;
  if (typeof name !== 'string' || profiles === null || typeof profiles !== 'object' || !Object.hasOwn(profiles, name)) return { reason: 'PROFILE_UNKNOWN', detail: name ?? null };
  const gb = profiles[name]?.wsl_memory_gb;
  if (!Number.isInteger(gb) || gb < 1 || gb > 4096) return { reason: 'PROFILE_MEMORY_REFUSED', detail: gb ?? null };
  return { memory: `${gb}GB` };
}

// The text with every [wsl2] memory= value set to `memory`; from = the last value it had (null: none). Pure.
export function setWslMemory(text, memory) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = text.slice(bom.length);
  const eol = body.includes('\r\n') ? '\r\n' : body.includes('\n') ? '\n' : '\r\n';
  // each line with its own line end, so that what is not changed is put back byte for byte
  const lines = [...body.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)].map(m => ({ content: m[1], end: m[2] })).filter((l, i, all) => !(i === all.length - 1 && l.content === '' && l.end === ''));
  let section = null, firstHeader = -1, from = null, found = false;
  for (let i = 0; i < lines.length; i += 1) {
    const s = SECTION.exec(lines[i].content);
    if (s) { section = s[1].trim().toLowerCase(); if (section === 'wsl2' && firstHeader < 0) firstHeader = i; continue; }
    if (section !== 'wsl2') continue;
    const m = MEMORY.exec(lines[i].content);
    if (!m) continue;
    found = true; from = m[2];
    // the same value in another letter case (17gb) is the same limit to WSL: the line stays as it is
    if (m[2].toLowerCase() !== memory.toLowerCase()) lines[i] = { ...lines[i], content: `${m[1]}${memory}${m[3]}` };
  }
  if (!found && firstHeader >= 0) {
    if (lines[firstHeader].end === '') lines[firstHeader].end = eol;
    lines.splice(firstHeader + 1, 0, { content: `memory=${memory}`, end: eol });
  } else if (!found) {
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last.end === '') last.end = eol;
      if (last.content.trim() !== '') lines.push({ content: '', end: eol });
    }
    lines.push({ content: '[wsl2]', end: eol }, { content: `memory=${memory}`, end: eol });
  }
  return { text: bom + lines.map(l => l.content + l.end).join(''), from };
}

const stampOf = now => new Date(now).toISOString().replace(/[-:.]/g, '');

// The step: { status: 'written' | 'unchanged' | 'skipped', from, to, backup[, reason, detail] }. Never throws.
export function applyWslCapacity({ profilesBytes, hostname, configPath = defaultWslConfigPath(), now = Date.now(), env = process.env }) {
  try {
    const want = capacityMemoryFor(profilesBytes, hostname);
    if (!want.memory) return skipped(want.reason, want.detail);
    if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) return skipped('CONFIG_PATH_REFUSED');
    if (!writableUnderTest(path.dirname(configPath), { env })) return skipped(REFUSED_UNDER_TEST);
    let old = null;
    try { old = fs.readFileSync(configPath); } catch (e) { if (e?.code !== 'ENOENT') return skipped('CONFIG_UNREADABLE', e?.code ?? null); }
    const oldText = old === null ? '' : old.toString('utf8');
    if (old !== null && (old.includes(0) || !Buffer.from(oldText, 'utf8').equals(old))) return skipped('CONFIG_NOT_UTF8');
    const { text, from } = setWslMemory(oldText, want.memory);
    if (old !== null && text === oldText) return { status: 'unchanged', from, to: want.memory, backup: null };
    const stamp = stampOf(now);
    let backup = null;
    if (old !== null) {
      backup = `${configPath}${BACKUP_INFIX}${stamp}`;
      fs.writeFileSync(backup, old, { flag: 'wx' });
    }
    const temporary = `${configPath}.clued-new-${stamp}`;
    try {
      fs.writeFileSync(temporary, text, { flag: 'wx' });
      fs.renameSync(temporary, configPath);
    } catch (e) {
      fs.rmSync(temporary, { force: true });
      return { ...skipped('CONFIG_WRITE_FAILED', e?.code ?? null), backup };
    }
    return { status: 'written', from, to: want.memory, backup };
  } catch (e) {
    return skipped('WSL_CAPACITY_FAILED', String(e?.code ?? e?.message ?? e).slice(0, 200));
  }
}

// The step not taken: a run that requests nothing (a drill's --no-request, an open operation, a reinstall answer) reads and writes no
// .wslconfig, so that a write is always in the answer of a run that goes on; `to` is the profile's value, for a drill to compare.
export function wslCapacityNotApplied(byPath, { hostname, reason }) {
  return { ...skipped(reason), to: capacityMemoryFor(byPath.get(`tree/${NODE_PROFILES}`) ?? null, hostname).memory ?? null };
}

// The step on a package: node-profiles.json from the archive's verified bytes (entries by path, as install.mjs readArchive gives them).
export function wslCapacityOfArchive(byPath, { hostname, configPath = defaultWslConfigPath(), now = Date.now(), env = process.env } = {}) {
  return applyWslCapacity({ profilesBytes: byPath.get(`tree/${NODE_PROFILES}`) ?? null, hostname, configPath, now, env });
}
