// Read an install package (clued.independent-ci.resident-package/4, spec A1) ONCE: every byte the upgrade will use is read
// here, hashed and kept; nothing is read from the package directory again (the Owner's session can write there). Links,
// junctions and UNC paths are refused, every file must hash to its manifest entry, and the manifest must hash to the
// packageManifestSha256 the request and the Grant name.
import fs from 'node:fs/promises';
import path from 'node:path';
import { HEX40, HEX64, UUID, canonicalJson, check, exactKeys, fail, parseBoundedJson, sha256 } from '../../src/canonical.mjs';
import { validateStateCompat } from '../../src/upgrade-mailbox.mjs';
import { localAbsolutePath } from './config.mjs';
import { U } from './codes.mjs';

export const PACKAGE_CONTRACT = 'clued.independent-ci.resident-package/4';
export const WINDOWS_LAYOUT = 'clued.independent-ci.resident-layout/1';
export const MANIFEST_FILE = 'package-manifest.json';
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const FILE_MAX_BYTES = 512 * 1024 * 1024;
export const PACKAGE_MAX_FILES = 20_000;
export const LINUX_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
// A package-relative path: forward slashes, plain names, no '.' or '..'.
const REL = /^(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+$/;
const relOk = p => typeof p === 'string' && p.length <= 400 && REL.test(p) && !p.split('/').some(s => s === '.' || s === '..');
const TARGET = /^[A-Za-z0-9_.@-]+(?:\\[A-Za-z0-9_.@-]+)*$/;

const fileEntry = (f, code) => {
  exactKeys(f, ['path', 'target', 'sha256'], code);
  check(relOk(f.path) && typeof f.target === 'string' && f.target.length <= 400 && TARGET.test(f.target) && !f.target.split('\\').some(s => s === '.' || s === '..')
    && HEX64.test(f.sha256 ?? ''), code, 'file');
};
const listedFile = (f, code) => {
  exactKeys(f, ['path', 'sha256', 'bytes'], code);
  check(relOk(f.path) && HEX64.test(f.sha256 ?? '') && Number.isSafeInteger(f.bytes) && f.bytes >= 0, code, 'file');
};

export function validatePackageManifest(m) {
  const code = U.PACKAGE_CONTRACT_REFUSED;
  check(m && m.contract === PACKAGE_CONTRACT, code, 'contract');
  exactKeys(m, ['contract', 'sourceManifestSha256', 'ciSourceManifestSha256', 'residentManifestSha256', 'bridgeManifestSha256', 'nodeIdentitySha256', 'nodeProfileSha256',
    'windowsLayout', 'stateCompat', 'acceptance', 'files', 'linux', 'upgrader'], code);
  for (const k of ['sourceManifestSha256', 'ciSourceManifestSha256', 'residentManifestSha256', 'nodeIdentitySha256', 'nodeProfileSha256']) check(HEX64.test(m[k] ?? ''), code, k);
  check(m.bridgeManifestSha256 === null || HEX64.test(m.bridgeManifestSha256), code, 'bridgeManifestSha256');
  check(typeof m.windowsLayout === 'string' && m.windowsLayout.length <= 100, code, 'windowsLayout');
  validateStateCompat(m.stateCompat, code);
  exactKeys(m.acceptance, ['decisionRef'], code);
  check(UUID.test(m.acceptance.decisionRef ?? ''), code, 'acceptance');
  check(Array.isArray(m.files) && m.files.length >= 1 && m.files.length <= PACKAGE_MAX_FILES, code, 'files');
  m.files.forEach(f => fileEntry(f, code));
  check(new Set(m.files.map(f => f.target.toLowerCase())).size === m.files.length, code, 'duplicate-target');
  const l = m.linux;
  exactKeys(l, ['manifestSha256', 'sourceV2', 'files'], code);
  check(HEX64.test(l.manifestSha256 ?? '') && Array.isArray(l.files) && l.files.length <= PACKAGE_MAX_FILES, code, 'linux');
  l.files.forEach(f => listedFile(f, code));
  if (l.sourceV2 !== null) {
    exactKeys(l.sourceV2, ['commit', 'bundlePath', 'bundleSha256', 'rolesDerivedSha256'], code);
    check(HEX40.test(l.sourceV2.commit ?? '') && relOk(l.sourceV2.bundlePath) && HEX64.test(l.sourceV2.bundleSha256 ?? ''), code, 'sourceV2');
    exactKeys(l.sourceV2.rolesDerivedSha256, LINUX_ROLES, code);
    check(LINUX_ROLES.every(r => HEX64.test(l.sourceV2.rolesDerivedSha256[r] ?? '')), code, 'roles');
  }
  if (m.upgrader !== null) {
    exactKeys(m.upgrader, ['manifestSha256', 'files'], code);
    check(HEX64.test(m.upgrader.manifestSha256 ?? '') && Array.isArray(m.upgrader.files) && m.upgrader.files.length <= PACKAGE_MAX_FILES, code, 'upgrader');
  }
  return m;
}

// No link or junction anywhere from the package directory down to the file (lstat of each component).
async function assertNoLinks(base, rel) {
  let at = base;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    const st = await fs.lstat(at);
    check(!st.isSymbolicLink(), U.PACKAGE_UNREADABLE, 'link');
  }
}

// One file, one handle: not a link, one name, the size from the open handle (fstat) under the cap; exactly that many bytes
// are allocated (no buffer of the cap's size per file: a real package holds hundreds of files), and a file that grew or
// shrank under the read is refused.
export async function readFileOnce(file, max = FILE_MAX_BYTES) {
  const link = await fs.lstat(file);
  check(link.isFile() && !link.isSymbolicLink(), U.PACKAGE_UNREADABLE, 'type');
  const handle = await fs.open(file, 'r');
  try {
    const st = await handle.stat();
    check(st.isFile() && st.nlink === 1 && st.ino === link.ino, U.PACKAGE_UNREADABLE, 'identity');
    check(st.size <= max, U.PACKAGE_UNREADABLE, 'size');
    const out = Buffer.allocUnsafe(st.size);
    let at = 0;
    while (at < st.size) {
      const { bytesRead } = await handle.read(out, at, st.size - at, at);
      if (bytesRead === 0) break;
      at += bytesRead;
    }
    check(at === st.size, U.PACKAGE_UNREADABLE, 'size-changed');
    // One byte more than fstat said means the file grew under the read.
    const { bytesRead: extra } = await handle.read(Buffer.alloc(1), 0, 1, st.size);
    check(extra === 0, U.PACKAGE_UNREADABLE, 'size-changed');
    return out;
  } finally {
    await handle.close();
  }
}

export async function readPackageOnce(dir, expectedSha) {
  check(HEX64.test(expectedSha ?? ''), U.REQUEST_REFUSED, 'expectedSha');
  check(localAbsolutePath(dir, 260), U.PACKAGE_UNREADABLE, 'directory');
  try {
    const st = await fs.lstat(dir);
    check(st.isDirectory() && !st.isSymbolicLink(), U.PACKAGE_UNREADABLE, 'directory');
    // A junction or link above the directory resolves elsewhere: the real path must be the path given.
    const real = await fs.realpath(dir);
    check(path.resolve(real).toLowerCase() === path.resolve(dir).toLowerCase(), U.PACKAGE_UNREADABLE, 'realpath');
  } catch (error) {
    if (error?.code?.startsWith?.('UPGRADE_')) throw error;
    fail(U.PACKAGE_UNREADABLE, 'directory');
  }
  const read = async (rel, max) => {
    try {
      await assertNoLinks(dir, rel);
      const file = path.join(dir, ...rel.split('/'));
      return await readFileOnce(path.join(dir, ...rel.split('/')), max);
    } catch (error) {
      if (error?.code === U.PACKAGE_UNREADABLE) throw error;
      return fail(U.PACKAGE_UNREADABLE, 'read');
    }
  };
  const manifestBytes = await read(MANIFEST_FILE, MANIFEST_MAX_BYTES);
  check(sha256(manifestBytes) === expectedSha, U.PACKAGE_CHANGED, 'manifest');
  const manifest = validatePackageManifest(parseBoundedJson(manifestBytes, MANIFEST_MAX_BYTES, U.PACKAGE_CONTRACT_REFUSED));
  // The manifest's bytes are its canonical form plus a newline (A1): any other spelling of the same object is refused.
  check(manifestBytes.toString('utf8') === canonicalJson(manifest) + '\n', U.PACKAGE_CONTRACT_REFUSED, 'canonical');
  const bytesByPath = new Map();
  const want = new Map();
  for (const f of manifest.files) want.set(f.path, f.sha256);
  for (const f of manifest.linux.files) {
    check(!want.has(f.path) || want.get(f.path) === f.sha256, U.PACKAGE_CONTRACT_REFUSED, 'path-twice');
    want.set(f.path, f.sha256);
  }
  if (manifest.linux.sourceV2) want.set(manifest.linux.sourceV2.bundlePath, manifest.linux.sourceV2.bundleSha256);
  for (const [rel, sha] of [...want.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const bytes = await read(rel, FILE_MAX_BYTES);
    check(sha256(bytes) === sha, U.PACKAGE_CHANGED, rel);
    bytesByPath.set(rel, bytes);
  }
  for (const f of manifest.linux.files) check(bytesByPath.get(f.path).length === f.bytes, U.PACKAGE_CHANGED, f.path);
  return { manifest, manifestBytes, packageManifestSha256: expectedSha, bytesByPath };
}
