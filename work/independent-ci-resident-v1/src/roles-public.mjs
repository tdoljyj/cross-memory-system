// The public copy of the live Linux role files (Task 3ea699f6, DESIGN §63).
//
// Every generation re-derives and re-signs the three role policies and their signed qualifications under
// /etc/clued-independent-ci/roles-v3 (root, 0700/0600). The next upgrade package is built against them byte for byte
// (rollout/tools/roles-derived.py checks each one against the node's own Linux version facts), so before this copy existed the
// Owner had to run a root export with UAC once per generation and node, on top of the upgrade approval.
//
// The companion already reads the facts with the frozen root tool; right after it writes them, it reads the six files with the
// fixed argv companion.mjs#argv().rolePublic (base64 of one fixed path, as root, read-only) when the copy it keeps is not the one
// the facts name, and replaces upgrade\mailbox\responses\roles-public.json whole (temporary file + rename). A file is taken only
// when its bytes hash to the facts just read; anything else leaves the copy as it was. The files are PUBLIC (policies and signed
// qualifications; no key, no token) and the copy is no authority: its reader checks every file again against the facts.
//
// Not imported by the upgrader (its frozen copy is src/canonical, inbox, instance-lock, intake-pause, store, upgrade-mailbox).
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX64, canonicalJson, check, exactKeys, parseBoundedJson, sha256 } from './canonical.mjs';
import { TEMP_PREFIX, exists, nonce, readBounded } from './store.mjs';

export const ROLES_PUBLIC_CONTRACT = 'clued.independent-ci.linux-roles-public/1';
export const ROLES_PUBLIC_FILE = 'roles-public.json';
export const ROLES_PUBLIC_LINUX_DIR = '/etc/clued-independent-ci/roles-v3';
export const ROLES_PUBLIC_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
// file name -> the facts field that names its sha256
export const ROLES_PUBLIC_NAMES = Object.freeze(ROLES_PUBLIC_ROLES.flatMap(r => [`${r}.json`, `${r}.qualification.json`]));
export const ROLES_PUBLIC_FILE_MAX_BYTES = 16 * 1024;   // the root export's own bound (copy-desk-six-public*.py)
export const ROLES_PUBLIC_MAX_BYTES = 192 * 1024;
export const ROLES_PUBLIC_TIMEOUT_MS = 60_000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isIso = v => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const roleOf = name => name.slice(0, name.indexOf('.'));
const fieldOf = name => (name.endsWith('.qualification.json') ? 'qualificationSha256' : 'policySha256');

// { name: sha256 } of the six files the facts name, or null when the facts do not name all six (or have no generation).
export function rolesPublicWanted(facts) {
  if (!facts || !Number.isSafeInteger(facts.generation) || facts.roles === null || typeof facts.roles !== 'object') return null;
  const out = {};
  for (const name of ROLES_PUBLIC_NAMES) {
    const sha = facts.roles[roleOf(name)]?.[fieldOf(name)];
    if (typeof sha !== 'string' || !HEX64.test(sha)) return null;
    out[name] = sha;
  }
  return out;
}

// One file's bytes from the root read's stdout (base64 on one line), or null unless they are exactly a canonical base64 of 1..max
// bytes that hash to `want`.
export function rolePublicBytes(stdout, want) {
  const text = String(stdout ?? '').trim();
  if (!BASE64.test(text) || text.length > Math.ceil(ROLES_PUBLIC_FILE_MAX_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length === 0 || bytes.length > ROLES_PUBLIC_FILE_MAX_BYTES || bytes.toString('base64') !== text) return null;
  return sha256(bytes) === want ? bytes : null;
}

export function validateRolesPublic(v) {
  const code = 'ROLES_PUBLIC_COPY_REFUSED';
  exactKeys(v, ['contract', 'generation', 'factsObservedAt', 'observedAt', 'files'], code);
  check(v.contract === ROLES_PUBLIC_CONTRACT && Number.isSafeInteger(v.generation) && v.generation >= 1 && isIso(v.factsObservedAt) && isIso(v.observedAt), code, 'head');
  exactKeys(v.files, ROLES_PUBLIC_NAMES, code);
  for (const name of ROLES_PUBLIC_NAMES) {
    const f = v.files[name];
    exactKeys(f, ['sha256', 'base64'], code);
    check(HEX64.test(f.sha256 ?? '') && typeof f.base64 === 'string' && BASE64.test(f.base64) && rolePublicBytes(f.base64, f.sha256) !== null, code, name);
  }
  return v;
}

// true when the copy is the one these facts name (same generation, every file's sha256 the facts' own).
export function rolesPublicCurrent(copy, facts) {
  const want = rolesPublicWanted(facts);
  if (!want || !copy) return false;
  try { validateRolesPublic(copy); } catch { return false; }
  return copy.generation === facts.generation && ROLES_PUBLIC_NAMES.every(n => copy.files[n].sha256 === want[n]);
}

export function rolesPublicDocument(facts, files, now) {
  return validateRolesPublic({ contract: ROLES_PUBLIC_CONTRACT, generation: facts.generation, factsObservedAt: facts.observedAt, observedAt: new Date(now).toISOString(),
    files: Object.fromEntries(ROLES_PUBLIC_NAMES.map(n => [n, { sha256: sha256(files[n]), base64: files[n].toString('base64') }])) });
}

// The copy in a responses directory, or null (none, unfinished or invalid).
export async function readRolesPublic(dir) {
  const file = path.join(dir, ROLES_PUBLIC_FILE);
  try {
    if (!(await exists(file))) return null;
    return validateRolesPublic(parseBoundedJson(await readBounded(file, ROLES_PUBLIC_MAX_BYTES, 'ROLES_PUBLIC_COPY_REFUSED'), ROLES_PUBLIC_MAX_BYTES, 'ROLES_PUBLIC_COPY_REFUSED'));
  } catch { return null; }
}

// Replaced whole, as the version facts are (upgrade-mailbox.mjs#writeVersionFacts): a reader finds the old or the new file.
export async function writeRolesPublic(dir, doc) {
  validateRolesPublic(doc);
  const bytes = Buffer.from(canonicalJson(doc) + '\n', 'utf8');
  check(bytes.length <= ROLES_PUBLIC_MAX_BYTES, 'ROLES_PUBLIC_COPY_REFUSED', 'size');
  const tmp = path.join(dir, `${TEMP_PREFIX}${nonce()}-${ROLES_PUBLIC_FILE}`);
  try {
    const handle = await fs.open(tmp, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, path.join(dir, ROLES_PUBLIC_FILE));
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}
