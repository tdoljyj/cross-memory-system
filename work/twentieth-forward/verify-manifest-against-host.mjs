// Verifies a ControllerSourceManifest against the files that are actually on disk.
//
// Why this exists: the controller digest IS the manifest digest, and 187 of the 331 entries are
// files on one Windows machine totalling 200,048,638 bytes -- node.exe, docker.exe, gh.exe, 44
// Python .pyc caches, 106 files under AppData. They were collected on 2026-09-08 and nothing has
// re-verified them since. GitHub CLI and Docker Desktop auto-update; a .pyc is regenerated when its
// source's mtime moves. If any of them has drifted, the controller digest is wrong and every
// document re-issued against it inherits the error, surfacing only when the controller runs.
//
// The script is deliberately usable from two places:
//
//   In this Linux checkout   verifies REPOSITORY_SOURCE entries directly, plus RUNTIME_DEPENDENCY
//                            entries whose Windows path can be mapped onto a local one (the
//                            node_modules tree). Everything else is reported as UNCHECKABLE HERE,
//                            never as passing.
//   On the Windows host      pass --host-root to resolve the Windows absolute paths as they are,
//                            and all 331 entries are checked.
//
// Read-only. Touches nothing, writes only the evidence file it is asked to write.
//
// Usage:
//   node verify-manifest-against-host.mjs <manifest.json> [--out <evidence.json>] [--map <fromPrefix>=<toPath>]
//
// On the Windows host, typically:
//   node verify-manifest-against-host.mjs <manifest.json> --out HostVerification.json --map /=/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const argv = process.argv.slice(2);
const manifestPath = argv[0];
assert.ok(manifestPath && !manifestPath.startsWith('--'), 'USAGE: node verify-manifest-against-host.mjs <manifest.json> [--out f] [--map from=to]');
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const maps = argv.reduce((acc, a, i) => {
  if (a !== '--map') return acc;
  const [from, ...rest] = argv[i + 1].split('=');
  return [...acc, {from, to: rest.join('=')}];
}, []);

// Default mapping: the manifest records the ajv/node_modules tree under the Windows checkout of
// this same repository, and this checkout has the same tree. Anything mapped is still verified by
// digest, so a wrong mapping shows up as a mismatch rather than a false pass.
if (!maps.length) {
  maps.push({from: 'C:/Users/Windows/.codex/projects/codex-memory-system/apps/clued-cloud/node_modules/',
             to: path.join(REPO, 'apps/clued-cloud/node_modules/')});
}

const manifestRaw = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestRaw.toString('utf8'));
assert.equal(manifest.object_type, 'ControllerSourceManifest', 'NOT_A_CONTROLLER_SOURCE_MANIFEST');

const resolveLocal = e => {
  if (e.role === 'REPOSITORY_SOURCE') return path.join(REPO, e.path);
  for (const m of maps) if (e.path.startsWith(m.from)) return m.to + e.path.slice(m.from.length);
  return null;
};

const ok = [], mismatched = [], missing = [], uncheckable = [];
for (const e of manifest.files) {
  const local = resolveLocal(e);
  if (local === null) { uncheckable.push(e); continue; }
  if (!fs.existsSync(local)) { missing.push({...e, looked_at: local}); continue; }
  const bytes = fs.readFileSync(local);
  if (bytes.length === e.bytes && sha(bytes) === e.sha256) ok.push(e);
  else mismatched.push({...e, actual_bytes: bytes.length, actual_sha256: sha(bytes), looked_at: local});
}

// gh.exe carries a second, independent pin: trusted-github.mjs:13 re-hashes it before every API
// call and throws GITHUB_CLI_BYTES_DRIFT on mismatch. Report it on its own line -- if that one has
// drifted the controller cannot make a single API call, so it is not just one entry among 331.
const GH_PIN = 'e2efa10a5d2ce93cac9bc4b676932b62947c0967c01c8f2c3a9cb4437ad358d3';
const ghEntry = manifest.files.find(e => e.path.endsWith('GitHub CLI/gh.exe'));
let ghStatus = 'NOT_IN_MANIFEST';
if (ghEntry) {
  const local = resolveLocal(ghEntry);
  if (local === null || !fs.existsSync(local)) ghStatus = 'UNCHECKABLE_FROM_HERE';
  else {
    const d = sha(fs.readFileSync(local));
    ghStatus = d === GH_PIN && d === ghEntry.sha256 ? 'MATCHES_BOTH_PINS'
      : d === ghEntry.sha256 ? 'MATCHES_MANIFEST_BUT_NOT_trusted-github.mjs_PIN'
      : 'DRIFTED';
  }
}

const byRole = r => manifest.files.filter(e => e.role === r).length;
const verdict = mismatched.length || missing.length ? 'DRIFT_DETECTED'
  : uncheckable.length ? 'PARTIAL_NO_DRIFT_IN_WHAT_COULD_BE_CHECKED'
  : 'ALL_ENTRIES_VERIFIED';

const report = {
  state: 'MANIFEST_HOST_VERIFICATION',
  verdict,
  manifest: {path: manifestPath, sha256: sha(manifestRaw), entries: manifest.files.length,
             repository_source: byRole('REPOSITORY_SOURCE'), runtime_dependency: byRole('RUNTIME_DEPENDENCY')},
  counts: {verified: ok.length, mismatched: mismatched.length, missing: missing.length, uncheckable_here: uncheckable.length},
  gh_exe: {status: ghStatus, trusted_github_mjs_pin: GH_PIN},
  mismatched: mismatched.map(e => ({path: e.path, expected_bytes: e.bytes, actual_bytes: e.actual_bytes,
                                    expected_sha256: e.sha256, actual_sha256: e.actual_sha256})),
  missing: missing.map(e => ({path: e.path, looked_at: e.looked_at})),
  uncheckable_here: uncheckable.length
    ? {count: uncheckable.length,
       bytes: uncheckable.reduce((n, e) => n + e.bytes, 0),
       note: 'Windows absolute paths with no local mapping. These are NOT verified. Run this script on that host with --map to check them.',
       sample: uncheckable.slice(0, 5).map(e => e.path)}
    : null,
  authority_effect: 'NONE',
};

if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));

// Fail loudly on drift; a partial run is not a pass and says so in the verdict.
if (mismatched.length || missing.length) process.exitCode = 1;
