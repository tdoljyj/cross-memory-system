// Proves each runtime byte check is BOTH satisfied and live, by mutation in a sandbox.
//
// Two earlier versions of this file reported ok without the check under test ever running.
//   - the first passed an expired deadline to invokeFixedHost; the liveness test sits one line
//     above the byte comparison, so the comparison never executed
//   - the second treated any unexpected error as "we got past it", so an ENOENT from readFileSync
//     also read as success (R18-F1)
// Both were the same mistake: inferring that a check ran from the ABSENCE of its failure. That
// inference is worthless, because not running produces the same absence.
//
// So each pin is tested in both directions. The check must pass against the pristine copy AND must
// fail, with its own error, against a copy whose pinned file has been altered by one byte.
//
// A third version then broke that rule in its own last item. prepare() covers four pins -- the
// platform gate, the docker binary identity, the fixture bytes and the Skill bytes -- and three of
// them sit outside the sandbox and cannot be mutated, so the item was one-directional. It printed
// ok anyway, which is exactly the claim this file exists to refuse. Anything that cannot be proven
// live is now reported as UNPROVEN, never as ok, and the unproven set is counted and printed.
//
// All mutation happens inside a throwaway copy of scripts/phase2-qualification under the system
// temp directory. The real tree is never written to. No docker operation, no container, no
// database, no budget.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const QUAL = path.resolve(DIR, '..');
const REPO = path.resolve(DIR, '..', '..', '..');
const NAME = path.basename(DIR);
let failures = 0;
const fail = m => { console.error('  FAILED  ' + m); failures++; };
const ok = m => console.log('  ok       ' + m);
let unproven = 0;
// R20-N6: same reason as the gate's stamp -- a measurement with no host attached is not a record.
const HOST_BINARIES = ['/opt/node22/bin/node', '/usr/bin/docker', '/usr/local/bin/gh', '/usr/bin/python3.11'];
const hostStamp = () => HOST_BINARIES.map(p => {
  try { return path.basename(p) + '=' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); }
  catch { return path.basename(p) + '=ABSENT'; }
}).join(' ');
const cannotProve = m => { console.log('  UNPROVEN ' + m); unproven++; };

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-pinselftest-'));
process.on('exit', () => fs.rmSync(sandbox, {recursive: true, force: true}));
// Laid out as a repository root rather than a bare directory copy: item 6 runs the real trusted
// entry script, and that resolves every REPOSITORY_SOURCE path against $REPO.
const SREPO = path.join(sandbox, 'repo');
const SQ = path.join(SREPO, 'scripts/phase2-qualification');
fs.mkdirSync(SQ, {recursive: true});
fs.cpSync(QUAL, SQ, {recursive: true, filter: s => !s.includes('node_modules')});
// The controller imports ajv out of apps/clued-cloud/node_modules. Symlinked rather than copied:
// the manifest lists those files by ABSOLUTE path, so they are verified where they really are and
// the link changes nothing about what is checked -- it only lets node resolve them.
fs.mkdirSync(path.join(SREPO, 'apps'), {recursive: true});
fs.symlinkSync(path.join(REPO, 'apps/clued-cloud'), path.join(SREPO, 'apps/clued-cloud'));
// skills/ is COPIED, not linked: prepare() reads it and item 5 mutates it. Linking would put the
// mutation back onto the real tree, and leaving it out would send prepare() looking at a third
// checkout again -- which is the defect (R19-F3) this copy exists to make testable.
fs.cpSync(path.join(REPO, 'skills'), path.join(SREPO, 'skills'), {recursive: true});
// R20-N5 is handled at the criterion, not by pruning the sandbox. Three of the expect strings
// below are shared with nine to eleven predecessor controllers, whose files the tree copy brings
// along; the criterion "does stderr contain this substring" would therefore accept a predecessor's
// check firing as proof that THIS one is live. Deleting the predecessors was tried first and does
// not work: the manifest lists their files as repository sources, so the trusted-entry items fail
// on a pruned tree. What distinguishes them is the path, so bothWays additionally requires the
// failure to name this controller -- see the NAME check there.
const SDIR = path.join(SQ, NAME);
const QREL = 'scripts/phase2-qualification';

const py = (script, cwd) => execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', script],
  {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

// Runs `probe` in the sandbox, first pristine, then with one byte appended to `target`.
// Pass means: pristine succeeds, mutated fails with an error naming `expect`.
// target is relative to the sandbox repository root (SREPO), not to the qualification
// directory: item 5 mutates skills/clued/SKILL.md, which sits outside it. QREL below spells the
// qualification prefix once so the other call sites stay readable.
function bothWays(label, target, probe, expect, attributedBy = null) {
  const abs = path.join(SREPO, target);
  if (!fs.existsSync(abs)) return fail(`${label}: ${target} is not in the sandbox`);
  const original = fs.readFileSync(abs);
  let pristine, mutated;
  try { pristine = {out: probe(SDIR), threw: null}; } catch (e) { pristine = {out: '', threw: e}; }
  try {
    fs.writeFileSync(abs, Buffer.concat([original, Buffer.from('\n')]));
    try { mutated = {out: probe(SDIR), threw: null}; } catch (e) { mutated = {out: '', threw: e}; }
  } finally { fs.writeFileSync(abs, original); }

  const text = r => String(r.threw ? (r.threw.stderr || r.threw.message) : r.out);
  if (pristine.threw || text(pristine).includes(expect))
    return fail(`${label}: does not pass on the pristine copy -- ${text(pristine).trim().split('\n').pop().slice(0, 140)}`);
  if (!text(mutated).includes(expect))
    return fail(`${label}: altering ${path.basename(target)} did NOT trigger ${expect}. The check is not running, so its passing means nothing.`);
  // R20-N5: the message alone does not say WHOSE check fired. Where the module is reached by
  // resolution, the traceback carries the raising module's path, so this controller's directory
  // name must appear in it -- otherwise a predecessor's copy of the same string would read as
  // proof about this one. A probe that already names its target by absolute path cannot make that
  // mistake; those pass attributedBy saying so, in words, rather than being silently exempt.
  if (!attributedBy && !text(mutated).includes(NAME))
    return fail(`${label}: ${expect} was raised, but nothing in the failure names ${NAME}, so it may be a predecessor's copy of the same check rather than this controller's. If the probe targets this controller by absolute path, say so via attributedBy.`);
  ok(`${label} (passes clean; altering ${path.basename(target)} raises ${expect}${attributedBy ? '; attributed because ' + attributedBy : ''})`);
}

// Mutates a PIN rather than the object it pins, then repairs the cross-pin chain and runs the
// probe. R20-F2: the previous version declared three checks unprovable because the things they
// pin -- sys.platform, /usr/bin/docker, the Skill tree -- cannot be altered from inside a
// sandbox. That confused "this one technique cannot reach it" with "it cannot be shown live".
// The pin itself is in the sandbox, and a check fires just as well when its expected value is
// wrong as when the object is. UNPROVEN was becoming the new carpet, harder to spot than a false
// ok because it looks like modesty.
//
// The chain repair is what makes this safe to do: changing one pin breaks the pins that cover the
// file containing it, and without repair the probe would fail at the wrong check and the item
// would pass for the wrong reason. --write is run to a fixed point and the run is abandoned if it
// does not reach one.
function byRepin(label, file, from, to, probe, expect) {
  const abs = path.join(SREPO, file);
  if (!fs.existsSync(abs)) return fail(`${label}: ${file} is not in the sandbox`);
  const originals = new Map();
  const snapshot = () => {
    for (const f of fs.readdirSync(SDIR)) {
      const p = path.join(SDIR, f);
      if (fs.statSync(p).isFile() && !originals.has(p)) originals.set(p, fs.readFileSync(p));
    }
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs));
  };
  const restore = () => { for (const [p, b] of originals) fs.writeFileSync(p, b); };
  // Runs --write to a fixed point and reports what the gate still objects to. A repinned HOST
  // BINARY digest is meant to leave the gate refusing -- that is the gate's whole job -- so
  // "gate exits 0" is the wrong success condition here. What must hold is that the RUNTIME pin
  // chain settled (no more repairs) and that the only literal the gate cannot explain is the one
  // this item deliberately injected. Anything else unexplained means the sandbox is in a state
  // the probe below would misattribute.
  const repair = injected => {
    for (let i = 0; i < 5; i++) {
      const r = spawnSync(process.execPath, [path.join(SDIR, 'check-digest-pins.mjs'), '--write'],
        {cwd: SDIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
      const out = (r.stdout || '') + (r.stderr || '');
      if (/repaired \d+ pin/.test(out)) continue;
      const unexplained = [...out.matchAll(/UNEXPLAINED\s+\S+ ([a-f0-9]{12})/g)].map(m => m[1]);
      if (!injected) return unexplained.length === 0 && r.status === 0;
      return unexplained.length > 0
        && unexplained.every(h => h.startsWith(injected) || injected.startsWith(h));
    }
    return false;
  };
  // A repin that changes a digest leaves that digest unexplainable by the gate; a repin that
  // changes something else (the platform string) does not. Which case this is comes from the
  // replacement text, not from a flag, so the two cannot drift apart.
  const injected = (to.match(/[0-9a-f]{8,64}/) || [])[0]?.slice(0, 12) ?? null;
  snapshot();
  let pristine, mutated;
  try { pristine = probe(SDIR); } catch (e) { pristine = String(e.stderr || e.message); }
  try {
    const text = fs.readFileSync(abs, 'utf8');
    const n = text.split(from).length - 1;
    if (n !== 1) { restore(); return fail(`${label}: the pin text occurs ${n} times in ${file}, expected exactly 1`); }
    fs.writeFileSync(abs, text.replace(from, () => to));
    if (!repair(injected)) { restore(); repair(null); return fail(`${label}: after the repin the sandbox did not settle with the injected digest as its only complaint, so the probe below would be measuring something else`); }
    try { mutated = probe(SDIR); } catch (e) { mutated = String(e.stderr || e.message); }
  } finally { restore(); if (!repair(null)) fail(`${label}: the sandbox did not return to a consistent state`); }

  if (String(pristine).includes(expect))
    return fail(`${label}: raises ${expect} on the pristine copy -- ${String(pristine).trim().split('\n').pop().slice(0, 140)}`);
  if (!String(mutated).includes(expect))
    return fail(`${label}: repinning did NOT raise ${expect}. The check is not running, so its passing means nothing. Got: ${String(mutated).trim().split('\n').pop().slice(0, 140)}`);
  ok(`${label} (passes clean; repinning raises ${expect}, with the pinned object untouched)`);
}

// 1. bridge.py pins fixed_host.py, fixed_host.py pins parent600.py.
const loadChain = cwd => py(`
import importlib.util
def load(n, f):
    s = importlib.util.spec_from_file_location(n, f)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
b = load('bridge', 'bridge.py'); b.load_host()
print('CHAIN_OK')`, cwd);
bothWays('python chain: bridge -> fixed_host', `${QREL}/${NAME}/fixed_host.py`, loadChain, 'Accepted fixed host bytes changed');
// R20-N4: this used to expect the bare path, which any traceback touching the file would print.
// Not exploitable as it stood -- load() compares digests before parsing, so even a syntax error
// hits the pin first -- but a criterion that other failures can satisfy is not a criterion.
bothWays('python chain: fixed_host -> parent600', `${QREL}/${NAME}/parent600.py`,
  loadChain, 'Frozen dependency drift: ');

// 2. fixed_host pins observe.py across directories -- the R17-F2 surface.
bothWays('cross-directory: fixed_host -> observe.py', `${QREL}/docker-engineering-observation/observe.py`,
  loadChain, 'drift: docker-engineering-observation/observe.py');

// 3. host-effect.mjs pins python3.11 and bridge.py. This is where R16-F1 lived.
const jsPin = cwd => py(`
import subprocess, json, os
r = subprocess.run(['/opt/node22/bin/node', '-e', '''
const {invokeFixedHost} = await import(process.argv[1]);
try { invokeFixedHost({gaRaw:'{"gate_authorization_id":"ga_selftest"}', operation:'CREATE',
                       containerId:null, deadline:Date.now()+120000}); console.log('NO_THROW'); }
catch (e) { console.log('THREW:' + e.message); }
''', os.path.join(${JSON.stringify(SDIR)}, 'host-effect.mjs')], capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip()[-200:])`, cwd);
bothWays('host-effect.mjs -> bridge.py bytes', `${QREL}/${NAME}/bridge.py`, jsPin, 'EXACT_PYTHON_BRIDGE_BYTES_REQUIRED',
  'the probe imports this controller\'s host-effect.mjs by absolute path');

// 4. parent600 pins the fixture across directories. Unlike the rest of prepare()'s pins this one
//    IS inside the tree, so it can be proven rather than asserted.
bothWays('cross-directory: parent600 -> fixed_skill_fixture.py',
  `${QREL}/control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py`,
  loadChain, 'Exact proposed fixture bytes changed');

// 5. The platform gate, the docker binary identity, and the Skill bytes. prepare() is CREATE's
//    first step and does all three.
//
//    The Skill part used to be untestable and was reported UNPROVEN along with the other two,
//    because fixed_host.py read a hardcoded /home/user/cross-memory-system/skills/clued -- neither
//    the sandbox nor, in round 19, even the tree under test, but whatever checkout happened to sit
//    at that path. It now resolves from the module's own location, so the sandbox copy is what
//    prepare() reads and the bytes can be proven live like any other pin.
const prepare = cwd => py(`
import importlib.util, json, secrets
from datetime import datetime, timezone, timedelta
s = importlib.util.spec_from_file_location('fh', 'fixed_host.py')
fh = importlib.util.module_from_spec(s); s.loader.exec_module(fh)
ga = json.dumps({'gate_authorization_id': 'ga_selftest',
                 'deadline': (datetime.now(timezone.utc)+timedelta(seconds=120)).isoformat().replace('+00:00','Z')})
fh.prepare(secrets.token_hex(16), ga)
print('PREPARE_OK')`, cwd);
// prepare() must still complete -- a failure here is a real failure. But completing does not prove
// its remaining pins are live: sys.platform cannot be mutated, and /usr/bin/docker and the Skill
// are outside the sandbox. So success is reported as UNPROVEN, not ok.
bothWays('prepare(): accepted Skill bytes', 'skills/clued/SKILL.md',
  prepare, 'Exact accepted Skill input bytes changed');

// 5b. The three checks that used to be reported UNPROVEN, now proven by repinning (R20-F2).
//     Nothing here touches sys.platform, /usr/bin/docker, or the real skills tree.
const QC = QREL + '/' + NAME;
byRepin('prepare(): platform gate', `${QC}/fixed_host.py`,
  "if sys.platform != 'linux':\n        raise ValueError('Exact Linux host required')",
  "if sys.platform != 'win32':\n        raise ValueError('Exact Linux host required')",
  prepare, 'Exact Linux host required');
byRepin('prepare(): /usr/bin/docker identity', `${QC}/parent600.py`,
  "DOCKER_SHA = '18c2a16d", "DOCKER_SHA = '08c2a16d",
  prepare, 'Exact Docker binary bytes required');
// 5c. host-effect.mjs's python half. Round 20 found it shared one message with the bridge half,
//     so it was neither proven nor listed as uncovered; the two now have separate messages, which
//     is what makes this item possible at all.
byRepin('host-effect.mjs -> python3.11 bytes', `${QC}/host-effect.mjs`,
  "!=='f56a588548dd", "!=='056a588548dd",
  jsPin, 'EXACT_PYTHON_BYTES_REQUIRED');
// 5d. The two load_exact pins on parent600's import path. Round 20: they sit two lines from three
//     covered pins, execute on every loadChain run, and were neither covered nor admitted.
bothWays('cross-directory: parent600 -> validation.py', `${QREL}/docker-engineering-observation/validation.py`,
  loadChain, 'Frozen dependency changed');
bothWays('cross-directory: parent600 -> remote_evidence.py', `${QREL}/qualification-runtime/remote_evidence.py`,
  loadChain, 'Frozen dependency changed');



// 6. The trusted entry script's own gates. Until now nothing exercised them, and two holes were
//    found there by hand: sha256sum and cut resolved through $PATH, so a sha256sum earlier in PATH
//    defeated both the manifest gate and the node gate; and the interpreter performing every
//    per-file byte check was itself unverified, so standing an "exit 0" in its place skipped all
//    308 comparisons. Both are fixed, and these items run the real script rather than a paraphrase.
//
//    The expected manifest digest is captured ONCE from the pristine copy and reused. Recomputing
//    it inside the probe would make the manifest-drift item unable to fail -- the same shape as the
//    three failures this file exists to stop.
const entryTemplate = (() => {
  const src = fs.readFileSync(path.join(DIR, 'tool-entry.functions.js'), 'utf8');
  const open = 'const cmd=`';
  const a = src.indexOf(open), z = src.indexOf('cli.mjs`', a);
  if (a < 0 || z < 0) throw new Error('ENTRY_COMMAND_TEMPLATE_NOT_FOUND in tool-entry.functions.js');
  // The file stores the command inside a JS template literal, so \$ and \" are escapes of the
  // literal, not of the shell. Undo exactly those two and nothing else.
  return src.slice(a + open.length, z + 'cli.mjs'.length).split('\\$').join('$').split('\\"').join('"');
})();
// The sandbox manifest is re-measured against the sandbox's own REPOSITORY_SOURCE bytes before
// anything runs. Without that, this item would be a staleness test for the committed manifest --
// which is check-digest-pins' and verify-manifest-against-host's job, not this file's -- and it
// would fail for a reason unrelated to whether the entry's gates are live, hiding the answer.
// It is deliberately NOT a licence to skip that check elsewhere: RUNTIME_DEPENDENCY entries
// (the four host binaries, node_modules, the .pyc set) are left exactly as committed, so a
// genuinely drifted binary still stops the pristine run here.
const MANIFEST_IN_SANDBOX = path.join(SDIR, 'ControllerSourceManifest.candidate.json');
{
  const m = JSON.parse(fs.readFileSync(MANIFEST_IN_SANDBOX, 'utf8'));
  let remeasured = 0;
  for (const e of m.files) {
    // This controller's source-only manifest intentionally has no role field.
    // Every declared entry is a repository source and must be remeasured.
    const bytes = fs.readFileSync(path.join(SREPO, e.path));
    e.bytes = bytes.length;
    e.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    remeasured++;
  }
  if (!remeasured) throw new Error('NO_REPOSITORY_SOURCE_ENTRIES_REMEASURED');
  fs.writeFileSync(MANIFEST_IN_SANDBOX, JSON.stringify(m, null, 2) + '\n');
}
const PRISTINE_MANIFEST_SHA = crypto.createHash('sha256')
  .update(fs.readFileSync(MANIFEST_IN_SANDBOX)).digest('hex');
const ENTRY_SCRIPT = path.join(sandbox, 'entry.sh');
{
  const bound = entryTemplate
    .replace('${expected}', PRISTINE_MANIFEST_SHA)
    .replace('REPO=/home/user/cross-memory-system', 'REPO=' + SREPO);
  if (!bound.includes('REPO=' + SREPO)) throw new Error('ENTRY_REPO_SUBSTITUTION_FAILED');
  if (bound.includes('${expected}')) throw new Error('ENTRY_EXPECTED_SUBSTITUTION_FAILED');
  fs.writeFileSync(ENTRY_SCRIPT, bound + '\n');
}
const runEntry = () => {
  const r = spawnSync('/bin/sh', [ENTRY_SCRIPT], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                                                  timeout: 120000, env: {}});
  return (r.stdout || '') + (r.stderr || '');
};
// Sanity before using it as a probe: on the pristine copy it must get all the way to node, which
// answers BOUNDED_STDIN_INPUT_REQUIRED with stdin closed. A probe that never reaches the end would
// "pass" every mutation for the wrong reason.
{
  const clean = runEntry();
  if (!clean.includes('BOUNDED_STDIN_INPUT_REQUIRED'))
    fail('trusted entry: pristine run does not reach the controller -- ' + clean.trim().split('\n').pop().slice(0, 160));
}
bothWays('trusted entry: manifest digest gate', `${QREL}/${NAME}/ControllerSourceManifest.candidate.json`,
  runEntry, 'ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT',
  'the entry script names this controller\'s manifest path');
bothWays('trusted entry: per-file byte check (the interpreter step)', `${QREL}/${NAME}/context.mjs`,
  runEntry, 'EXACT_CONTROLLER_SOURCE_BYTES_DRIFT',
  'the entry script names this controller\'s manifest path');
// Not a byte mutation -- the bypass is a directory appearing -- so this one is done by hand, in
// both directions all the same.
{
  const label = 'trusted entry: __pycache__ refusal';
  const clean = runEntry();
  const cache = path.join(SDIR, '__pycache__');
  fs.mkdirSync(cache); fs.writeFileSync(path.join(cache, 'x.pyc'), 'x');
  const withCache = runEntry();
  fs.rmSync(cache, {recursive: true, force: true});
  if (clean.includes('CONTROLLER_BYTECODE_CACHE_PRESENT'))
    fail(`${label}: fires on the pristine copy -- ${clean.trim().split('\n').pop().slice(0, 140)}`);
  else if (!withCache.includes('CONTROLLER_BYTECODE_CACHE_PRESENT'))
    fail(`${label}: creating __pycache__ did NOT trigger CONTROLLER_BYTECODE_CACHE_PRESENT. The check is not running, so its passing means nothing.`);
  else ok(`${label} (passes clean; a __pycache__ directory raises CONTROLLER_BYTECODE_CACHE_PRESENT)`);
}

// 7. The denominator. Two attempts at this have failed, in different ways.
//
// Round 18 printed uncovered items in a free-text line. Round 20 replaced that with
// `if (UNCOVERED.length !== 6)`, which compared an array's length to a nearby constant and had
// zero coupling to the controller -- the sixth instance of a check that cannot fail. This census
// replaced THAT, counting literals per file "across the controller's real load set", and round 21
// showed the load set was hand-enumerated and wrong: 34 modules are statically reachable from
// cli.mjs, 24 of them outside this directory, and only signing.mjs was listed. Fourteen digest
// literals in the reachable set were counted by nobody, six of them real runtime byte checks in
// read-source-blobs.mjs. A live unlisted pin was planted in runtime600/late-bound-policy.mjs --
// which context.mjs imports -- and both gates stayed green. Same shape as round 20's finding, one
// directory further out. That is the SEVENTH instance.
//
// The lesson each time was the same and I kept missing it: a hand-written set is a claim about the
// code that nothing forces to stay true. So the load set is COMPUTED here, not declared. The ESM
// side is the static import closure from cli.mjs; the Python side is bridge.py plus the
// load()/load_exact()/CHILD_PATH targets named in its chain. The tables below are expected VALUES
// over that computed set, and a file appearing in the set with no expected count fails -- which is
// exactly what controllerFiles() already does for this directory, the one list round 21 judged
// strong.
const loadSet = () => {
  const out = new Set();
  const walk = f => {
    const abs = path.resolve(f);
    // A base URL literal resolves to a directory, and the read patterns below will match it.
    // Directories are not members of the load set; only what is read out of them is.
    if (out.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    out.add(abs);
    const text = fs.readFileSync(abs, 'utf8');
    if (/\.(mjs|js)$/.test(abs)) {
      for (const m of text.matchAll(/^\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm))
        walk(path.resolve(path.dirname(abs), m[1]));
      // Files read at runtime BY PATH, which the import graph cannot see. Preparing route B turned
      // four of these up -- grr.mjs's receipt schema, context.mjs's status-manifest schema, and the
      // two profile schemas bytes() resolves -- all genuinely loaded, all in the manifest, none in
      // this walk. The load set was therefore wrong in the same way the hand-written list it
      // replaced was wrong, one level down: computed, but computed over the wrong relation.
      for (const m of text.matchAll(/new URL\(\s*'(\.[^']+)'\s*,\s*import\.meta\.url\s*\)/g))
        walk(path.resolve(path.dirname(abs), m[1]));
      // A base URL plus names resolved against it. Only the literal names are visible statically,
      // so both parts are matched and joined; a name built at runtime would still be missed, which
      // is why BASE_RELATIVE_READS below is asserted rather than assumed.
      for (const b of text.matchAll(/const (\w+)\s*=\s*new URL\(\s*'(\.[^']+\/)'\s*,\s*import\.meta\.url\s*\)/g)) {
        const base = path.resolve(path.dirname(abs), b[2]);
        for (const n of text.matchAll(/'([A-Za-z0-9._-]+\.(?:json|mjs|js|py))'/g)) {
          const cand = path.join(base, n[1]);
          if (fs.existsSync(cand)) walk(cand);
        }
      }
    }
    if (abs.endsWith('.py')) {
      // load('name', 'rel/path', digest) and load_exact(...) name their target relative to QUAL;
      // CHILD_PATH is built from parents, so it is matched on its own.
      // Two shapes, both naming their target explicitly. A path literal resolves against the
      // qualification directory; str(BASE / 'name') resolves against the module's own directory.
      // The second is how bridge.py reaches fixed_host.py and fixed_host.py reaches parent600.py,
      // and dropping it with the sibling heuristic broke the whole Python chain -- which the census
      // caught immediately, since those files have expected counts and stopped appearing.
      for (const m of text.matchAll(/load(?:_exact)?\(\s*'[^']+'\s*,\s*'([^']+)'/g)) walk(path.join(QUAL, m[1]));
      for (const m of text.matchAll(/load(?:_exact)?\(\s*'[^']+'\s*,\s*str\(BASE \/ '([^']+)'\)/g))
        walk(path.join(path.dirname(abs), m[1]));
      // A module-level constant naming a sibling: bridge.py reaches fixed_host.py as
      // HOST = BASE / 'fixed_host.py', with the load happening later through that name. Still
      // explicit -- BASE is the module's own directory and the filename is a literal -- unlike the
      // sibling heuristic removed above, which matched any '<name>.py' string anywhere.
      for (const m of text.matchAll(/^\w+ = BASE \/ '([^']+)'$/gm))
        walk(path.join(path.dirname(abs), m[1]));
      // No sibling-name heuristic. One was here -- "any '<name>.py' string pulls in the file of
      // that name next to the file mentioning it" -- and it is too loose: it would admit a file
      // merely because some module mentions its name. An over-inclusive load set is not the safe
      // direction it looks like, because the census would then demand entries for files the
      // controller never loads and the count route B turns on would be wrong.
      //
      // Correction to my own reasoning when removing it: I claimed it was what pulled
      // preentry-parent/.../host-tool-bridge600/bridge.py into the set. It was not. Tracing the
      // chain shows that module is genuinely reachable -- result-terminal.mjs ->
      // original-inputs-blob.mjs -> scenario-observations/request-denials-packed.mjs ->
      // request-denials.mjs -> runtime600/context.mjs -> runtime600/host-effect.mjs -> it. The
      // heuristic deserved removing on its own merits; the example I gave for removing it was
      // wrong, and the real load set is larger than I thought, not smaller.
      for (const m of text.matchAll(/parent\.parent\s*\/\s*'([^']+)'\s*\/\s*'([^']+)'/g))
        walk(path.join(QUAL, m[1], m[2]));
    }
  };
  // Three roots, because the controller has three entry points and only one of them is an import.
  // tool-entry.functions.js is the real outermost entry -- the harness runs its shell command,
  // which execs cli.mjs -- so it is reachable from nothing and imports nothing, while carrying
  // three genuine runtime byte checks (the manifest digest, python3.11, node). Starting only from
  // cli.mjs left those three uncounted.
  //
  // Deliberately NOT roots: check-digest-pins.mjs, build-linux-manifest.mjs and this file. They are
  // build-time and audit-time tools; the controller never loads them, and counting their literals
  // would put the auditor inside its own denominator.
  walk(path.join(DIR, 'tool-entry.functions.js'));
  walk(path.join(DIR, 'cli.mjs'));
  walk(path.join(DIR, 'bridge.py'));
  return [...out].sort();
};

// Expected literal counts over the COMPUTED set, keyed by path relative to the qualification
// directory so two files of the same basename cannot be confused. A file in the set with no entry
// here fails; an entry with no file fails.
const CENSUS = {
  'control-context-verifier-recovery-successor-root9-exact-pair/bridge.py': 1,
  'control-context-verifier-recovery-successor-root9-exact-pair/context.mjs': 28,
  'control-context-verifier-recovery-successor-root9-exact-pair/fixed_host.py': 3,
  'control-context-verifier-recovery-successor-root9-exact-pair/grr.mjs': 0,
  'control-context-verifier-recovery-successor-root9-exact-pair/host-effect.mjs': 2,
  'control-context-verifier-recovery-successor-root9-exact-pair/parent600.py': 4,
  // Read at runtime by path, not imported -- invisible until the walk learned to follow new URL().
  // grr.mjs and context.mjs read the first two; bytes() resolves the ProfileDefinitions against
  // profileBase; root-window-validation.mjs reads the trust-root schema.
  'nonproduction-control-store/protocol-successor/control-trust-root-set.schema.json': 1,
  'preentry-parent/profile-runtime600/ProfileDefinition.json': 1,
  'preentry-parent/profile-successor/ProfileDefinition.json': 1,
  // Reached transitively through the runtime600 predecessor: result-terminal -> original-inputs-blob
  // -> scenario-observations -> runtime600/context -> runtime600/host-effect -> this.
  'preentry-parent/runtime-successor/host-tool-bridge600/bridge.py': 1,
  // R21-F3: this controller's own Linux batch reader, replacing the predecessor's PowerShell one
  // on the verifySourcePublication path. Its single literal is the gh pin.
  'control-context-verifier-recovery-successor-root9-exact-pair/read-source-blobs-linux.mjs': 3,
  'control-context-verifier-recovery-successor-root9-exact-pair/result-terminal.mjs': 1,
  'control-context-verifier-recovery-successor-root9-exact-pair/trusted-github.mjs': 1,
  'control-context-verifier-recovery-successor-root9-exact-pair/tool-entry.functions.js': 3,
  // Outside this directory and statically reachable. Round 21's point: these carry real runtime
  // byte checks -- read-source-blobs.mjs alone has six FIXED_BATCH_EXECUTOR_BYTES pins -- and
  // unlike the four frozen Python dependencies, this controller does NOT pin their bytes. They are
  // covered by the manifest and by nothing else. Counting them is the minimum; it is not the same
  // as checking them, and the uncovered list below says so.
  'control-context-verifier-original-input-capacity-successor/read-source-blobs.mjs': 6,
  'control-context-verifier-runtime600/context.mjs': 2,
  'control-context-verifier-runtime600/host-effect.mjs': 2,
  'control-context-verifier-runtime600/result-terminal.mjs': 1,
  'control-context-verifier-runtime600/trusted-github.mjs': 1,
  'control-context-verifier-runtime600/write-targets.mjs': 2,
  // Frozen Python dependencies: pinned byte-for-byte by this controller, so a single changed byte
  // makes the gate REFUSE. That -- not "their digests are not mine to adjudicate" -- is why they
  // need no further scrutiny here, and round 21 was right that the earlier wording was wrong.
  'docker-engineering-observation/observe.py': 2,
  'docker-engineering-observation/validation.py': 8,
  'qualification-runtime/remote_evidence.py': 1,
  'control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py': 4,
};
{
  const set = loadSet();
  const actual = {};
  let total = 0;
  // The manifest is in the load set -- source-publication.mjs reads it by path -- but its 298
  // digest literals are ENTRIES, not pins: each is a file this manifest describes. Counting them
  // would swamp the census with data. It is excluded from the literal count and not from the set,
  // and its own integrity is not taken on faith: the trusted entry checks its digest against a
  // value read from SQL before anything else runs, and that gate is proven live by item 6.
  const MANIFEST_REL = QREL + '/' + NAME + '/ControllerSourceManifest.candidate.json';
  for (const abs of set) {
    const rel = path.relative(QUAL, abs).split(path.sep).join('/');
    if (QREL + '/' + rel === MANIFEST_REL) continue;
    const n = new Set([...fs.readFileSync(abs, 'utf8').matchAll(/[a-f0-9]{64}/g)].map(m => m[0])).size;
    actual[rel] = n;
    total += n;
  }
  for (const rel of new Set([...Object.keys(CENSUS), ...Object.keys(actual).filter(k => actual[k])])) {
    const want = CENSUS[rel], got = actual[rel];
    if (got === undefined) fail(`census: ${rel} has an expected count but is not in the computed load set`);
    else if (want === undefined) fail(`census: ${rel} is in the load set with ${got} digest literal(s) and no expected count -- a pin that is neither covered nor admitted`);
    else if (want !== got) fail(`census: ${rel} carries ${got} digest literal(s), CENSUS says ${want}`);
  }
  const declaredTotal = Object.values(CENSUS).reduce((a, b) => a + b, 0);
  if (total !== declaredTotal) fail(`census: ${total} digest literal(s) across the computed load set, the table sums to ${declaredTotal}`);
  else console.log(`  census      ${total} digest literal(s) over ${set.length} statically reachable module(s), load set computed from tool-entry.functions.js, cli.mjs and bridge.py`);
}

// Of those literals, the ones that are runtime byte checks split three ways. This list is the
// honest part -- what is NOT proven live -- and the census above is what stops it going stale.
const UNCOVERED = [

  "fixed_host.py arm_watchdog() PYTHON_SHA -- needs a live GA. Round 20 showed this one is exploitable: written as adjacent-string concatenation of the predecessor's Windows digest, both gates stay green and the controller dies at the first step of START.",
  "trusted-github.mjs expectedGh -- needs a GitHub API call",
  "read-source-blobs-linux.mjs ghSHA -- same binary, same reason: proving it live needs a real blob read, and the batch path is only reached inside a real verifySourcePublication",
  "fixed_host.py _invoke()'s platform gate and DOCKER_SHA -- needs a container operation. Separate from prepare()'s pair, which items 5b now prove; these two have their own messages (R20-N2) so they are separately provable once a container operation can be driven.",
  "grr.mjs's schema check -- it re-hashes the local receipt schema, but against acceptedSchemaSha256 passed in rather than a literal of its own, so the census below cannot see it. Needs a terminal result to exercise.",
  "result-terminal.mjs's blob refs -- digests of remote material, checked against what GitHub returns; needs an API call",
  "context.mjs's schema and issuer digests -- need a full dispatch",
  "trusted entry: the /usr/bin/python3.11 and /opt/node22/bin/node byte gates -- both binaries sit outside the sandbox, so item 6 does not prove those two live",
  "trusted entry: the shell binary -- chosen by the harness's exec_command, not by the script, so it can be neither pinned from here nor mutated",
];
// No length assertion here. There used to be one, and round 20 was right that it was the sixth
// instance of a check that cannot fail: it compared this array's length to a constant a few lines
// away and had no connection to the controller at all. The census above is the assertion that
// bites; this list is the explanation of what the census counted, not the guard.
//
// The census has one blind spot, stated rather than papered over: it counts 64-hex LITERALS, so a
// runtime byte check whose expected value arrives as an argument is invisible to it. grr.mjs is
// exactly that case and is listed above by hand. A new check of that shape would have to be added
// here by hand too -- the census will not catch it.
for (const u of UNCOVERED) console.log('  not covered  ' + u);

console.log(`  host        ${hostStamp()}`);
if (failures) { console.log(`runtime pin self-test FAILED (${failures} failed, ${unproven} unproven)`); process.exitCode = 1; }
else console.log(`runtime pin self-test passed (${unproven} item(s) UNPROVEN, ${UNCOVERED.length} not covered -- see above; passing here is not a claim about those)`);
