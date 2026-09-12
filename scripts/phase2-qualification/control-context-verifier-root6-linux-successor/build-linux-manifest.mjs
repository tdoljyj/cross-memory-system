// Rebuilds ControllerSourceManifest for the Linux successor host.
//
// The predecessor manifest pinned 331 files, 187 of them local to a Windows machine that no
// longer exists. This does not translate those paths: it re-measures what THIS host actually
// uses, which is the only thing a manifest can honestly claim.
//
//   REPOSITORY_SOURCE   the same repository files the predecessor listed, with the controller
//                       directory remapped. Verified byte-identical where the file is unchanged.
//   RUNTIME_DEPENDENCY  this host's node, docker, gh and python binaries; the node_modules files
//                       the controller imports (all 45 measured byte-identical to the
//                       predecessor's); and the Python standard-library modules actually imported
//                       when parent600.py loads, enumerated from sys.modules rather than guessed.
//
// Run:  node build-linux-manifest.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OLD_DIR = 'scripts/phase2-qualification/control-context-verifier-root6-window11-successor';
const NEW_DIR = 'scripts/phase2-qualification/control-context-verifier-root6-linux-successor';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const NM_WIN = 'C:/Users/Windows/.codex/projects/codex-memory-system/apps/clued-cloud/node_modules/';

// Gate: the controller's own internal digest pins must hold before its bytes are described.
// A manifest over a controller that contradicts itself is worse than no manifest -- round 14 had
// exactly that, the manifest listing one python digest while the code demanded another.
execFileSync(process.execPath, [path.join(HERE, 'check-digest-pins.mjs')], {stdio: 'inherit'});

const prev = JSON.parse(fs.readFileSync(path.join(REPO, OLD_DIR, 'ControllerSourceManifest.candidate.json'), 'utf8'));
const entry = (p, role) => {
  const abs = path.isAbsolute(p) ? p : path.join(REPO, p);
  const b = fs.readFileSync(abs);
  return {path: p, role, bytes: b.length, sha256: sha(b)};
};

// 1. Repository sources, controller directory remapped. The manifest never lists itself.
const repoSrc = [];
for (const f of prev.files.filter(f => f.role === 'REPOSITORY_SOURCE')) {
  const p = f.path.startsWith(OLD_DIR + '/') ? NEW_DIR + f.path.slice(OLD_DIR.length) : f.path;
  if (p.endsWith('ControllerSourceManifest.candidate.json')) continue;
  repoSrc.push(entry(p, 'REPOSITORY_SOURCE'));
}
// Every file in the controller directory is a repository source of this controller, enumerated
// rather than carried over from the predecessor's list plus hand-added extras. That is how
// check-sibling-pins.mjs -- a file the build gate itself depends on -- was missing from the first
// 301-entry manifest: anything NEW in this directory fell outside a list built by remapping.
const listed = new Set(repoSrc.map(f => f.path));
for (const f of fs.readdirSync(path.join(REPO, NEW_DIR)).sort()) {
  const p = NEW_DIR + '/' + f;
  if (listed.has(p)) continue;
  if (f === 'ControllerSourceManifest.candidate.json') continue;   // never lists itself
  if (!fs.statSync(path.join(REPO, p)).isFile()) continue;
  repoSrc.push(entry(p, 'REPOSITORY_SOURCE'));
}

// 2. Host binaries. Symlinks are resolved: what is pinned must be the bytes that execute.
const bins = ['/opt/node22/bin/node', '/usr/bin/docker', '/usr/local/bin/gh', '/usr/bin/python3.11']
  .map(p => entry(fs.realpathSync(p), 'RUNTIME_DEPENDENCY'));

// 3. node_modules the controller imports, taken from the predecessor's own list so nothing is
//    silently added or dropped, then measured locally.
const nm = prev.files
  .filter(f => f.role === 'RUNTIME_DEPENDENCY' && f.path.startsWith(NM_WIN))
  .map(f => entry(path.join(REPO, 'apps/clued-cloud/node_modules', f.path.slice(NM_WIN.length)), 'RUNTIME_DEPENDENCY'));

// 4. Python standard library actually imported, enumerated by importing parent600.py.
// R14-F4: the predecessor pinned .pyc files, and it was right to. CPython loads the cached
// bytecode, not the source, and a timestamp-based .pyc carries its own validation fields, so
// editing a .pyc while leaving its .py alone passes a source-only manifest. Both are pinned, and
// the .pyc set comes from each module's own __cached__ rather than from guessing the layout.
const pyList = execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', `
import sys, importlib.util, json
spec = importlib.util.spec_from_file_location('p600', ${JSON.stringify(path.join(REPO, NEW_DIR, 'parent600.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
src, cached = set(), set()
for mod in list(sys.modules.values()):
    f = getattr(mod, '__file__', None)
    if f and f.startswith('/usr/lib/python3.11/'):
        src.add(f)
        c = getattr(mod, '__cached__', None)
        if c and c.startswith('/usr/lib/python3.11/'):
            cached.add(c)
print(json.dumps({'src': sorted(src), 'cached': sorted(cached)}))
`], {encoding: 'utf8', cwd: path.join(REPO, NEW_DIR)});
const pyParsed = JSON.parse(pyList);
const py = [...pyParsed.src, ...pyParsed.cached.filter(p => fs.existsSync(p))]
  .map(p => entry(p, 'RUNTIME_DEPENDENCY'));

// R14-F5: steps 1 and 4 of the trusted entry -- the manifest digest check and the node byte check
// -- run on a shell and three coreutils that nothing pinned. The predecessor pinned
// powershell.exe and its two assemblies for exactly this role.
const shellTools = ['/bin/sh', '/usr/bin/sha256sum', '/usr/bin/cut', '/usr/bin/test']
  .map(p => entry(fs.realpathSync(p), 'RUNTIME_DEPENDENCY'));

const files = [...repoSrc, ...bins, ...nm, ...py, ...shellTools].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const dup = files.map(f => f.path).filter((p, i, a) => a.indexOf(p) !== i);
if (dup.length) { console.error('DUPLICATE PATHS:', dup.slice(0, 5)); process.exit(1); }

const manifest = {
  object_type: 'ControllerSourceManifest',
  format: prev.format,
  scope: prev.scope,
  files,
  authority_effect: prev.authority_effect,
  qualification_issued: false,
};

const counts = files.reduce((a, f) => (a[f.role] = (a[f.role] || 0) + 1, a), {});
console.log('files      ', files.length, JSON.stringify(counts));
console.log('repo source', repoSrc.length, ' host bins', bins.length, ' node_modules', nm.length, ' python .py+.pyc', py.length, ' shell tools', shellTools.length);
if (process.argv.includes('--write')) {
  const out = path.join(REPO, NEW_DIR, 'ControllerSourceManifest.candidate.json');
  fs.writeFileSync(out, JSON.stringify(manifest));
  console.log('wrote', out, fs.statSync(out).size, 'bytes');
} else console.log('(dry run; pass --write)');
