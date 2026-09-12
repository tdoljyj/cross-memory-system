// Verifies a ControllerSourceManifest against the files that are actually on disk.
//
// Why this exists: the controller digest IS the manifest digest, and 187 of the 331 entries are
// files on one Windows machine totalling 200,048,638 bytes -- node.exe, docker.exe, gh.exe, 44
// Python .pyc caches, 106 files under AppData. They were collected on 2026-09-08 and nothing has
// re-verified them since. GitHub CLI and Docker Desktop auto-update; a .pyc is regenerated when its
// source's mtime moves. If any of them has drifted, the controller digest is wrong and every
// document re-issued against it inherits the error, surfacing only when the controller runs.
//
// That host is gone. The manifest now in use is the Linux one -- 308 entries, 161 of them
// RUNTIME_DEPENDENCY on this machine -- and it is verified in full from here. The Windows manifest
// is still readable by this script, and the paragraph below still applies to it.
//
// On top of the per-entry digests, the manifest is cross-checked against the controller's own
// runtime literals; see the cross-pin block. Its failure modes are proven live by
// selftest-cross-pins.mjs, which reproduces each one and requires the verdict to change.
//
// Read-only. Touches nothing, writes only the evidence file it is asked to write.
//
// Usage:
//   node verify-manifest-against-host.mjs <manifest.json> [--out <evidence.json>] [--map <fromPrefix>=<toPath>]
//
//   Linux manifest, from this checkout:  --map /=/
//   Windows manifest, on that host:      --map C:/=C:/
//
// For the WINDOWS manifest the prefix must be C:/ and not /. Every one of its 187
// RUNTIME_DEPENDENCY paths is a drive-letter absolute path, so a --map whose `from` is / matches
// none of them: resolveLocal returns null and they are counted UNCHECKABLE rather than verified.
// An earlier version of this header said /=/, which would silently have checked 144 entries and
// reported the other 187 as unverifiable. For the LINUX manifest /=/ is the correct prefix, since
// every runtime path there is rooted at /.
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

// ---- cross-pins: the manifest against the controller's own runtime literals -------------------
//
// Every host binary the controller re-hashes at runtime carries TWO independent digests: its
// manifest entry, and a literal inside the controller source. Agreement is the property; a
// disagreement means the controller will refuse to run against the very manifest that describes it.
//
// This block replaces a single hardcoded check on gh.exe, which was the fifth instance of the
// pattern this project keeps hitting -- a verification that cannot fail. It looked the entry up by
// path.endsWith('GitHub CLI/gh.exe'), which matches nothing in the Linux manifest (the entry is
// /usr/local/bin/gh), so it reported NOT_IN_MANIFEST; NOT_IN_MANIFEST fed into no verdict; and its
// pin constant was still the Windows gh.exe digest, stale against trusted-github.mjs. The report
// printed ALL_ENTRIES_VERIFIED next to a check that had silently stopped existing.
//
// Three things stop that recurring. The expected digest is READ OUT OF the controller source
// rather than copied here, so a port cannot leave it stale. The set is written down and its length
// asserted, so a pin added to the controller without a line here fails. And every outcome other
// than a real match is verdict-affecting -- "the check could not be located" is a failure, not a
// neutral string.
//
// The pin must be found EXACTLY ONCE in its source. Zero occurrences is the interesting case: it
// means the construct this block was written against is gone, which is precisely what happened to
// the gh check.
const CROSS_PINS = [
  {what: 'node',   source: 'tool-entry.functions.js', path: /sha256sum (\/[^ "|]+node) \| /,
                                                      digest: /sha256sum \/[^ "|]+node \|[\s\S]{0,80}?= "([a-f0-9]{64})"/},
  {what: 'python (entry)', source: 'tool-entry.functions.js', path: /sha256sum (\/[^ "|]+python[0-9.]*) \| /,
                                                      digest: /sha256sum \/[^ "|]+python[0-9.]* \|[\s\S]{0,80}?= "([a-f0-9]{64})"/},
  {what: 'python (fixed_host)', source: 'fixed_host.py', path: /^PYTHON = Path\('([^']+)'\)/m,
                                                      digest: /^PYTHON_SHA = '([a-f0-9]{64})'/m},
  {what: 'python (host-effect)', source: 'host-effect.mjs', path: /const python='([^']+)'/,
                                                      digest: /sha\(fs\.readFileSync\(python\)\)!=='([a-f0-9]{64})'/},
  {what: 'docker', source: 'parent600.py', path: /^DOCKER = '([^']+)'/m,
                                                      digest: /^DOCKER_SHA = '([a-f0-9]{64})'/m},
  {what: 'gh',     source: 'trusted-github.mjs', path: /const gh='([^']+)'/,
                                                      digest: /const expectedGh='([a-f0-9]{64})'/},
];
if (CROSS_PINS.length !== 6) throw new Error('CROSS_PINS length changed; update this assertion deliberately');

// The controller directory is taken from the manifest itself rather than assumed, so this works
// for any manifest that describes a controller of this shape. It is the directory holding ALL of
// the cross-pin sources: several earlier controllers are also listed as REPOSITORY_SOURCE, so three
// directories carry a trusted-github.mjs and matching on that file alone is ambiguous.
const dirsWith = name => new Set(manifest.files
  .filter(e => e.path.endsWith('/' + name)).map(e => path.posix.dirname(e.path)));
// Two directories still hold the whole set (an earlier controller is listed as source too), and
// neither manifest lists itself, so neither of those separates them. What does, exactly and without
// circularity: the entry script names the manifest path it guards, and that must be THIS manifest.
const manifestRel = path.relative(REPO, path.resolve(manifestPath)).split(path.sep).join('/');
const anchor = [...[...new Set(CROSS_PINS.map(p => p.source))]
  .map(dirsWith).reduce((a, d) => new Set([...a].filter(x => d.has(x))))]
  .filter(dir => {
    const e = manifest.files.find(x => x.path === dir + '/tool-entry.functions.js');
    const local = e && resolveLocal(e);
    return local && fs.existsSync(local) && fs.readFileSync(local, 'utf8').includes(manifestRel);
  });
const crossPins = [];
let crossPinFailures = 0;
const cp = (what, status, extra = {}) => {
  crossPins.push({what, status, ...extra});
  if (status !== 'MATCHES_MANIFEST_AND_DISK' && status !== 'MATCHES_MANIFEST_DISK_UNREACHABLE') crossPinFailures++;
};

if (anchor.length !== 1) {
  cp('*', 'CONTROLLER_DIRECTORY_NOT_IDENTIFIABLE', {candidate_directories: anchor});
} else {
  const controllerDir = anchor[0];
  for (const pin of CROSS_PINS) {
    const srcPath = controllerDir + '/' + pin.source;
    const srcEntry = manifest.files.find(e => e.path === srcPath);
    if (!srcEntry) { cp(pin.what, 'SOURCE_NOT_IN_MANIFEST', {source: srcPath}); continue; }
    const srcLocal = resolveLocal(srcEntry);
    if (srcLocal === null || !fs.existsSync(srcLocal)) { cp(pin.what, 'SOURCE_UNREADABLE', {source: srcPath}); continue; }
    const srcBytes = fs.readFileSync(srcLocal);
    // A source that does not match its own manifest entry cannot be quoted as authority for anything.
    if (sha(srcBytes) !== srcEntry.sha256) { cp(pin.what, 'SOURCE_DOES_NOT_MATCH_ITS_MANIFEST_ENTRY', {source: srcPath}); continue; }
    const text = srcBytes.toString('utf8');
    const once = (re, kind) => {
      const all = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
      return all.length === 1 ? all[0][1] : {error: kind + (all.length ? '_NOT_UNIQUE_' + all.length : '_NOT_FOUND')};
    };
    const binPath = once(pin.path, 'PATH'), binSha = once(pin.digest, 'DIGEST');
    if (typeof binPath !== 'string' || typeof binSha !== 'string') {
      cp(pin.what, 'PIN_NOT_LOCATED_IN_SOURCE', {source: srcPath,
        detail: [binPath, binSha].filter(v => typeof v !== 'string').map(v => v.error).join(',')});
      continue;
    }
    const binEntry = manifest.files.find(e => e.path === binPath);
    if (!binEntry) { cp(pin.what, 'BINARY_NOT_IN_MANIFEST', {source: srcPath, binary: binPath, source_pin: binSha}); continue; }
    if (binEntry.sha256 !== binSha) {
      cp(pin.what, 'DIGEST_DISAGREES', {binary: binPath, manifest: binEntry.sha256, source_pin: binSha, source: srcPath});
      continue;
    }
    const binLocal = resolveLocal(binEntry);
    if (binLocal === null || !fs.existsSync(binLocal)) {
      cp(pin.what, 'MATCHES_MANIFEST_DISK_UNREACHABLE', {binary: binPath, digest: binSha});
      continue;
    }
    const onDisk = sha(fs.readFileSync(binLocal));
    cp(pin.what, onDisk === binSha ? 'MATCHES_MANIFEST_AND_DISK' : 'DIGEST_DISAGREES',
       {binary: binPath, digest: binSha, ...(onDisk === binSha ? {} : {on_disk: onDisk})});
  }
}

const byRole = r => manifest.files.filter(e => e.role === r).length;
const crossPinUnreachable = crossPins.some(p => p.status === 'MATCHES_MANIFEST_DISK_UNREACHABLE');
const verdict = mismatched.length || missing.length ? 'DRIFT_DETECTED'
  : crossPinFailures ? 'CROSS_PIN_FAILURE'
  : uncheckable.length || crossPinUnreachable ? 'PARTIAL_NO_DRIFT_IN_WHAT_COULD_BE_CHECKED'
  : 'ALL_ENTRIES_VERIFIED';

const report = {
  state: 'MANIFEST_HOST_VERIFICATION',
  verdict,
  manifest: {path: manifestPath, sha256: sha(manifestRaw), entries: manifest.files.length,
             repository_source: byRole('REPOSITORY_SOURCE'), runtime_dependency: byRole('RUNTIME_DEPENDENCY')},
  counts: {verified: ok.length, mismatched: mismatched.length, missing: missing.length, uncheckable_here: uncheckable.length},
  cross_pins: {declared: CROSS_PINS.length, failures: crossPinFailures, entries: crossPins},
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
if (mismatched.length || missing.length || crossPinFailures) process.exitCode = 1;
