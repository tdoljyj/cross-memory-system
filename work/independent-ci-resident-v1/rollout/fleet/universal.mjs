// The universal node package of one accepted Source (Decisions ddb4300f, b5d041d2 v2): built once on the publishing machine from
// the accepted commit, identical for every node, content-addressed and immutable; archived on a GitHub Release (publish.mjs).
//
//   node rollout/fleet/universal.mjs build --repo <git dir> --commit <40hex> --version <v> --out <new dir>
//        [--state-compat <stateCompat.json>]
//
// Outputs (create-only, in a new directory): fleet-node-<v>.tar, fleet-node-<v>.release.json, SHA256SUMS.
// The tar (tar.mjs: deterministic ustar) holds
//   tree/<path>                 the commit's files a node needs to reinstall or upgrade (selectTree): the resident tree's src/, tools/,
//                               windows/ (install, verify, uninstall, CompanionTaskRegistrar.cs ...), linux/, upgrader/src/, config/,
//                               reinstall/launcher/, reinstall/linux/, reinstall/tools/ and reinstall/rehearse.py (never reinstall/test/
//                               or reinstall/config/: no node's configuration), registration/export-node-registration.ps1 (the first
//                               install's node keys), rollout/precheck.mjs, rollout/fleet/ (install.mjs,
//                               upgrade.mjs; excludes tests and the CluedDev-Linux verification note), the CI Source closure
//                               (source-closure.json) with the closure file itself, prepare-record.mjs and record.mjs,
//                               scripts/ci/self-hosted/node-profiles.json at its repository path (the capacity profiles
//                               wsl-capacity.mjs writes from: their one source, never a copy), and every file these .mjs reach by relative import;
//   bundle/accepted.bundle      the git bundle whose only ref is refs/heads/accepted = the commit (full history, as build-upgrade.ps1),
//                               packed deterministically (single-threaded full repack, no user or system git configuration);
//   universal-manifest.json     contract, version, commit, the universal values (facts.mjs), the Source's stateCompat (null: each node keeps its installed one) and every other entry's sha256.
// The same commit and version give the same tar bytes (test/universal.test.mjs builds twice).
//
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageGenerationOf } from '../../src/selfcheck.mjs';
import { parseArgs } from 'node:util';
import { CIV1, CLOSURE, NODE_PROFILES, PREPARE_RECORD, RESIDENT, computeUniversalFacts } from './facts.mjs';
import { RESIDENT_EXTERNAL } from '../../tools/build-package.mjs';
import { pyCanonical } from './pyjson.mjs';
import { extractTar, writeTar } from './tar.mjs';

export const UNIVERSAL_CONTRACT = 'clued.independent-ci.fleet-universal/1';
export const RELEASE_CONTRACT = 'clued.independent-ci.fleet-node-release/1';
export const MANIFEST_NAME = 'universal-manifest.json';
export const BUNDLE_NAME = 'bundle/accepted.bundle';
export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,88}$/;   // the server's version shape, short enough for the tag fleet-node-<v>
export const tagOf = v => `fleet-node-${v}`;
export const TREE_PREFIXES = Object.freeze(['src/', 'tools/', 'windows/', 'linux/', 'upgrader/src/', 'config/', 'rollout/fleet/',
  'reinstall/launcher/', 'reinstall/linux/', 'reinstall/tools/'].map(p => `${RESIDENT}/${p}`));
export const TREE_EXCLUDED = Object.freeze([`${RESIDENT}/rollout/fleet/test/`]);
// Coordinator's development verification instructions. No node preparation step reads this note.
const DEV_VERIFY_NOTE = `${RESIDENT}/rollout/fleet/CLUEDDEV-LINUX-VERIFY.md`;
// Below reinstall/ no test directory or Python byte-code (never under src/, tools/, windows/: those are the resident manifest's, whole).
const EXCLUDED_PART = /^reinstall\/(?:.*\/)?(?:test|tests|__pycache__)\//;
export const TREE_FILES = Object.freeze([`${RESIDENT}/rollout/precheck.mjs`, `${RESIDENT}/rollout/fleet/upgrade.mjs`, `${RESIDENT}/rollout/fleet/install.mjs`,
  `${RESIDENT}/reinstall/tools/check-record.mjs`, `${RESIDENT}/reinstall/rehearse.py`, `${RESIDENT}/windows/install-resident.ps1`, `${RESIDENT}/windows/verify-resident.ps1`,
  `${RESIDENT}/windows/uninstall-resident.ps1`, `${RESIDENT}/windows/CompanionTaskRegistrar.cs`, `${RESIDENT}/reinstall/linux/prep.py`, `${RESIDENT}/reinstall/launcher/generate.py`,
  `${RESIDENT}/reinstall/launcher/template.ps1`, `${RESIDENT}/reinstall/launcher/expected-plan.ps1`, `${RESIDENT}/reinstall/launcher/continue.py`,
  `${RESIDENT}/reinstall/launcher/continue-install.ps1`, `${RESIDENT}/reinstall/tools/ledger-evidence.py`,
  `${RESIDENT}/reinstall/tools/rconfig.py`, `${RESIDENT}/reinstall/linux/assemble.py`,
  // the node's identity keys (Fable 11-21 r5 N7): first-install-host.ps1 reads them with this script's Find-MachineKey and makes them with
  // its init-keys, which needs no other file (export-node-registration.mjs is its export mode's, run where a node is registered)
  `${RESIDENT}/registration/export-node-registration.ps1`,
  CLOSURE, PREPARE_RECORD, `${CIV1}/src/resident-v2/record.mjs`,
  // the nodes' capacity profiles (Task 87d330d0): wsl-capacity.mjs writes the Owner's WSL memory limit from it, read where it lives
  NODE_PROFILES,
  // the resident files whose one source lies outside the resident tree (build-package.mjs RESIDENT_EXTERNAL): the node builds from this tree
  ...RESIDENT_EXTERNAL.map(e => e.source)]);
const excluded = p => TREE_EXCLUDED.some(x => p.startsWith(x)) || (p.startsWith(`${RESIDENT}/`) && EXCLUDED_PART.test(p.slice(RESIDENT.length + 1)));
// Whether a repository path is left out of the tree (the package's own rule; test/native-child.test.mjs walks the package's .ps1 by it).
export const isExcludedFromTree = p => excluded(p);
// A packaged PowerShell script is ASCII (tab, LF, CR, 0x20-0x7e), with one exception. Windows PowerShell 5.1 reads a script with a BOM as
// UTF-8 and one without as the system ANSI code page, and the launcher parses verify-resident.ps1 from its bytes as a third reader;
// only ASCII means the same to all three (a BOM made the launcher's parse fail with VERIFY_SCRIPT_PARSE_ERRORS; a UTF-8 comment under
// cp936 swallowed the next line). The exception is the section sign, bytes C2 A7: frozen texts carry it and cannot change (the
// compile recipe of upgrade-apply.ps1 is compared word for word with install-resident.ps1's); as two bytes it reads as one character
// under 936/950/949 and as two under 932 and the single-byte code pages, and swallows no neighbour. This set is a constant, never a
// place to add characters later. A BOM is not ASCII, so it needs no rule of its own.
export const PS1_ALLOWED_MULTIBYTE = Object.freeze(['c2a7']);
const PS1_ALLOWED = PS1_ALLOWED_MULTIBYTE.map(h => Buffer.from(h, 'hex'));
const PS1_SCRIPT = /\.(?:ps1|psm1|psd1)$/i;
const IMPORT_RE = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]|new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g;

const sha = b => createHash('sha256').update(b).digest('hex');
const fail = (code, detail) => { throw Object.assign(new Error(detail === undefined ? code : `${code} ${JSON.stringify(detail)}`), { code, detail }); };
const check = (ok, code, detail) => { if (!ok) fail(code, detail); };
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
// the offset of the first byte of a script that is neither ASCII text nor an allowed sequence, or -1
function firstNonAscii(buf) {
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) { i += 1; continue; }
    const hit = PS1_ALLOWED.find(seq => seq.length <= buf.length - i && buf.compare(seq, 0, seq.length, i, i + seq.length) === 0);
    if (!hit) return i;
    i += hit.length;
  }
  return -1;
}

// The tree subset. listing: Map(path -> { mode, oid }); read(paths) -> Map(path -> Buffer) (async, batched).
export async function selectTree(listing, read) {
  const chosen = new Set();
  for (const p of listing.keys()) if (p !== DEV_VERIFY_NOTE && TREE_PREFIXES.some(x => p.startsWith(x)) && !excluded(p)) chosen.add(p);
  for (const p of TREE_FILES) { check(listing.has(p), 'UNIVERSAL_TREE_FILE_MISSING', p); chosen.add(p); }
  const closure = JSON.parse((await read([CLOSURE])).get(CLOSURE).toString('utf8'));
  check(closure?.contract === 'clued.independent-ci.source-closure/2' && Array.isArray(closure.paths), 'SOURCE_CLOSURE_REFUSED');
  for (const p of closure.paths) { check(listing.has(p), 'SOURCE_CLOSURE_FILE_MISSING', p); chosen.add(p); }
  const scanned = new Set();
  for (;;) {
    const todo = [...chosen].filter(p => p.endsWith('.mjs') && !scanned.has(p));
    if (todo.length === 0) break;
    const texts = await read(todo);
    for (const p of todo) {
      scanned.add(p);
      for (const m of texts.get(p).toString('utf8').matchAll(IMPORT_RE)) {
        const q = path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1] ?? m[2] ?? m[3]));
        if (listing.has(q) && !excluded(q)) chosen.add(q);
      }
    }
  }
  for (const p of chosen) check(['100644', '100755'].includes(listing.get(p).mode), 'UNIVERSAL_TREE_ENTRY_NOT_A_FILE', p);
  // the node entry (bootstrap.ps1) extracts the archive with Windows' own tar.exe, which cannot write a name outside ASCII: a package
  // never holds one (review M6; none at the commit this rule was added with)
  for (const p of chosen) check(/^[\x20-\x7e]+$/.test(p), 'UNIVERSAL_TREE_PATH_NOT_ASCII', p);
  // the scripts a node runs or parses are ASCII (see PS1_ALLOWED_MULTIBYTE): the package cannot be built with another byte
  const sorted = [...chosen].sort(byteOrder);
  const scripts = sorted.filter(p => PS1_SCRIPT.test(p));
  const bytes = scripts.length ? await read(scripts) : new Map();
  for (const p of scripts) {
    const offset = firstNonAscii(bytes.get(p));
    check(offset < 0, 'UNIVERSAL_TREE_PS1_NOT_ASCII', { path: p, offset });
  }
  return sorted;
}

// ---- git (publishing machine only)
async function gitEnv(tmp) {
  const cfg = path.join(tmp, 'empty.gitconfig');
  await fs.writeFile(cfg, '', { flag: 'wx' });
  return { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
function git(env, args, input) {
  const r = spawnSync('git', args, { env, input, maxBuffer: 1 << 30, windowsHide: true });
  check(r.status === 0, 'GIT_FAILED', { command: args.filter(a => !a.startsWith('-') && !path.isAbsolute(a)).slice(0, 3).join(' '), stderr: String(r.stderr ?? r.error ?? '').slice(-300) });
  return r.stdout;
}

function lsTree(env, repo, commit) {
  const out = git(env, ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', commit]);
  const listing = new Map();
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, , oid] = rec.slice(0, tab).split(' ');
    listing.set(rec.slice(tab + 1), { mode, oid });
  }
  return listing;
}

function catBlobs(env, repo, listing, paths) {
  const out = git(env, ['-C', repo, 'cat-file', '--batch'], paths.map(p => listing.get(p).oid).join('\n') + '\n');
  const res = new Map();
  let at = 0;
  for (const p of paths) {
    const nl = out.indexOf(0x0a, at);
    const [oid, type, size] = out.subarray(at, nl).toString('ascii').split(' ');
    check(oid === listing.get(p).oid && type === 'blob', 'GIT_BLOB_REFUSED', p);
    res.set(p, Buffer.from(out.subarray(nl + 1, nl + 1 + Number(size))));
    at = nl + 1 + Number(size) + 1;
  }
  return res;
}

// refs/heads/accepted = commit, full history, single-threaded full repack: the same bytes for the same commit and git version.
function makeBundle(env, repo, commit, tmp) {
  const bare = path.join(tmp, 'src.git'), file = path.join(tmp, 'accepted.bundle');
  git(env, ['init', '-q', '--bare', '--initial-branch=accepted', bare]);
  git(env, ['-C', bare, 'fetch', '-q', '--no-tags', path.resolve(repo), `${commit}:refs/heads/accepted`]);
  git(env, ['-C', bare, '-c', 'pack.threads=1', 'repack', '-a', '-d', '-f', '-q']);
  git(env, ['-C', bare, '-c', 'pack.threads=1', 'bundle', 'create', '-q', file, 'refs/heads/accepted']);
  git(env, ['-C', bare, 'bundle', 'verify', '-q', file]);
  const heads = git(env, ['bundle', 'list-heads', file]).toString('utf8').split('\n').filter(Boolean);
  check(heads.length === 1 && heads[0] === `${commit} refs/heads/accepted`, 'BUNDLE_NOT_ONLY_THE_ACCEPTED_COMMIT', heads);
  return file;
}

// The bundle's header as a node checks it without git: v2, no prerequisite, exactly refs/heads/accepted = commit.
export function bundleHeads(bytes) {
  const end = bytes.indexOf('\n\n');
  check(end > 0 && end < 64 * 1024, 'BUNDLE_HEADER_REFUSED');
  const lines = bytes.subarray(0, end).toString('utf8').split('\n');
  check(lines[0] === '# v2 git bundle', 'BUNDLE_HEADER_REFUSED', lines[0]);
  return lines.slice(1);
}

const json = v => Buffer.from(pyCanonical(v) + '\n', 'utf8');

export async function buildUniversal({ repo, commit, version, out, stateCompat = null }) {
  check(/^[0-9a-f]{40}$/.test(commit ?? ''), 'COMMIT_MUST_BE_40_LOWERCASE_HEX');
  check(VERSION.test(version ?? ''), 'VERSION_REFUSED');
  check(typeof repo === 'string' && typeof out === 'string', 'USAGE');
  check(stateCompat === null || (Number.isSafeInteger(stateCompat?.schema) && Array.isArray(stateCompat.readableBySchemas)
    && Object.keys(stateCompat).sort().join('|') === 'readableBySchemas|schema'), 'STATE_COMPAT_REFUSED');
  await fs.mkdir(out, { recursive: false });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-universal-'));
  try {
    const env = await gitEnv(tmp);
    check(git(env, ['-C', repo, 'cat-file', '-t', commit]).toString('utf8').trim() === 'commit', 'COMMIT_NOT_IN_REPO');
    const listing = lsTree(env, repo, commit);
    const cache = new Map();
    const read = async paths => {
      const missing = paths.filter(p => !cache.has(p));
      if (missing.length) for (const [p, b] of catBlobs(env, repo, listing, missing)) cache.set(p, b);
      return new Map(paths.map(p => [p, cache.get(p)]));
    };
    const selected = await selectTree(listing, read);
    const blobs = await read(selected);
    const bundle = await fs.readFile(makeBundle(env, repo, commit, tmp));
    // the commit's own code computes the universal values from the selected tree, as each node's build-package will
    const entries = selected.map(p => ({ path: `tree/${p}`, data: blobs.get(p) }));
    entries.push({ path: BUNDLE_NAME, data: bundle });
    await extractTar(entries.filter(e => e.path.startsWith('tree/')).map(e => ({ path: e.path.slice(5), data: e.data })), path.join(tmp, 'tree'));
    const facts = await computeUniversalFacts({ tree: path.join(tmp, 'tree') });
    const files = entries.map(e => ({ path: e.path, sha256: sha(e.data), bytes: e.data.length })).sort((a, b) => byteOrder(a.path, b.path));
    const universal = { contract: UNIVERSAL_CONTRACT, version, commit, releaseTag: tagOf(version),
      facts: { residentManifestSha256: facts.residentManifestSha256, sourceManifestSha256: facts.sourceManifestSha256,
        upgraderManifestSha256: facts.upgraderManifestSha256, bundleSha256: sha(bundle), universalFilesSha256: facts.universalFilesSha256, bridgeManifestSha256: facts.bridgeManifestSha256 },
      stateCompat, files };
    const manifestBytes = json(universal);
    entries.push({ path: MANIFEST_NAME, data: manifestBytes });
    const tar = writeTar(entries);
    const tarName = `${tagOf(version)}.tar`, releaseName = `${tagOf(version)}.release.json`;
    const archiveSha = sha(tar);
    const release = { contract: RELEASE_CONTRACT,
      source: { version, release_tag: tagOf(version), archive_sha256: archiveSha, commit,
        ...(packageGenerationOf(version) === null ? {} : { built_at: new Date().toISOString() }),
        resident_manifest_sha256: universal.facts.residentManifestSha256, source_manifest_sha256: universal.facts.sourceManifestSha256,
        upgrader_manifest_sha256: universal.facts.upgraderManifestSha256, bundle_sha256: universal.facts.bundleSha256, universal_files_sha256: universal.facts.universalFilesSha256 },
      archive: { name: tarName, bytes: tar.length, sha256: archiveSha }, universalManifestSha256: sha(manifestBytes),
      bridgeManifestSha256: universal.facts.bridgeManifestSha256, stateCompat, files };
    const releaseBytes = Buffer.from(JSON.stringify(release, null, 1) + '\n', 'utf8');
    const sums = [[tarName, archiveSha], [releaseName, sha(releaseBytes)]].sort((a, b) => byteOrder(a[0], b[0])).map(([n, h]) => `${h}  ${n}\n`).join('');
    await fs.writeFile(path.join(out, tarName), tar, { flag: 'wx' });
    await fs.writeFile(path.join(out, releaseName), releaseBytes, { flag: 'wx' });
    await fs.writeFile(path.join(out, 'SHA256SUMS'), sums, { flag: 'wx' });
    return { status: 'FLEET_UNIVERSAL_BUILT', out, tar: path.join(out, tarName), release: path.join(out, releaseName), source: release.source, files: files.length };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  check(cmd === 'build', 'USAGE');
  const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, commit: { type: 'string' }, version: { type: 'string' }, out: { type: 'string' },
    'state-compat': { type: 'string' } } });
  check(!/^g[0-9]/.test(values.version ?? ''), 'FORMAL_GENERATION_ASSIGNED_BY_PUBLISH');
  const stateCompat = values['state-compat'] ? JSON.parse(await fs.readFile(values['state-compat'], 'utf8')) : null;
  return buildUniversal({ repo: values.repo, commit: values.commit, version: values.version, out: values.out, stateCompat });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r)), e => {
    console.log(JSON.stringify({ status: 'FLEET_UNIVERSAL_REFUSED', code: e?.code ?? 'FLEET_UNIVERSAL_FAILED', detail: e?.detail ?? String(e?.message ?? e).slice(0, 300) }));
    process.exitCode = 1;
  });
}
