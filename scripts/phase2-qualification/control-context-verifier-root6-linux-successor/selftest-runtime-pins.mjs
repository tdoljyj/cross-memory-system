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
const SDIR = path.join(SQ, NAME);
const QREL = 'scripts/phase2-qualification';

const py = (script, cwd) => execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', script],
  {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

// Runs `probe` in the sandbox, first pristine, then with one byte appended to `target`.
// Pass means: pristine succeeds, mutated fails with an error naming `expect`.
// target is relative to the sandbox repository root (SREPO), not to the qualification
// directory: item 5 mutates skills/clued/SKILL.md, which sits outside it. QREL below spells the
// qualification prefix once so the other call sites stay readable.
function bothWays(label, target, probe, expect) {
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
  ok(`${label} (passes clean; altering ${path.basename(target)} raises ${expect})`);
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
bothWays('python chain: fixed_host -> parent600', `${QREL}/${NAME}/parent600.py`, loadChain, NAME + '/parent600.py');

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
bothWays('host-effect.mjs -> bridge.py bytes', `${QREL}/${NAME}/bridge.py`, jsPin, 'EXACT_PYTHON_BRIDGE_BYTES_REQUIRED');

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
    if (e.role !== 'REPOSITORY_SOURCE') continue;
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
  runEntry, 'ACTUAL_CONTROLLER_SOURCE_MANIFEST_DRIFT');
bothWays('trusted entry: per-file byte check (the interpreter step)', `${QREL}/${NAME}/context.mjs`,
  runEntry, 'EXACT_CONTROLLER_SOURCE_BYTES_DRIFT');
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

// 7. The denominator, and why the previous attempt at one was worthless.
//
// Round 18 printed two uncovered items in a free-text line while at least six existed. The fix was
// to write the set down and assert its length -- and the comment claimed "add a pin without
// listing it here and this fails". Round 20 showed that sentence was simply false: UNCOVERED.length
// is compared against a constant eight lines above it, with ZERO coupling to the controller. A real,
// live, unlisted byte pin was added to fixed_host.py and this file still printed "6 not covered" and
// exited 0. That was the SIXTH instance of a check that cannot fail -- and the first one that was
// born inside the remedy for the previous five.
//
// So the denominator is now taken FROM the thing under test. Every byte pin necessarily carries a
// 64-hex literal, so the census counts distinct 64-hex literals per file across the controller's
// real load set -- its own sources plus the modules it execs or imports across directories -- and
// requires the total and every per-file count to match. Add a pin anywhere in that set and a count
// moves and this fails, whatever the lists below say. Counts, not digest values, so repairing a
// cross-pin chain does not churn the table; a NEW literal is what must be noticed.
const CENSUS = {
  'bridge.py': 1, 'check-digest-pins.mjs': 8, 'context.mjs': 22, 'fixed_host.py': 3,
  'host-effect.mjs': 2, 'parent600.py': 4, 'result-terminal.mjs': 1, 'tool-entry.functions.js': 3,
  'trusted-github.mjs': 1,
  // Loaded across directories, so they are part of what runs even though they are not in the
  // controller directory. signing.mjs is here because round 18 and round 20 both noted that
  // check-digest-pins' non-recursive readdirSync cannot even see it.
  'observe.py': 2, 'validation.py': 8, 'remote_evidence.py': 1, 'fixed_skill_fixture.py': 4,
  'signing.mjs': 0,
};
const CENSUS_TOTAL = 60;
{
  const CROSS = ['docker-engineering-observation/observe.py',
                 'docker-engineering-observation/validation.py',
                 'qualification-runtime/remote_evidence.py',
                 'control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py',
                 'nonproduction-control-store/runtime-successor/commitment-signing-root6-window/signing.mjs'];
  const scanned = [
    ...fs.readdirSync(DIR).filter(f => /\.(py|mjs|js)$/.test(f)).map(f => path.join(DIR, f)),
    ...CROSS.map(rel => path.join(QUAL, rel)),
  ];
  const actual = {};
  let total = 0;
  for (const p of scanned) {
    const n = new Set([...fs.readFileSync(p, 'utf8').matchAll(/[a-f0-9]{64}/g)].map(m => m[0])).size;
    if (n) actual[path.basename(p)] = n;
    total += n;
  }
  for (const rel of CROSS) if (!fs.existsSync(path.join(QUAL, rel))) fail(`census: ${rel} is not there to scan`);
  const names = new Set([...Object.keys(CENSUS).filter(k => CENSUS[k] > 0), ...Object.keys(actual)]);
  for (const n of [...names].sort()) {
    const want = CENSUS[n], got = actual[n] ?? 0;
    if (want === undefined) fail(`census: ${n} carries ${got} digest literal(s) and is not in CENSUS -- a new pin is not covered and not admitted`);
    else if (want !== got) fail(`census: ${n} carries ${got} digest literal(s), CENSUS says ${want} -- reclassify the difference below, deliberately`);
  }
  if (total !== CENSUS_TOTAL) fail(`census: ${total} digest literal(s) across the load set, CENSUS_TOTAL says ${CENSUS_TOTAL}`);
  else console.log(`  census      ${total} digest literal(s) across ${scanned.length} file(s) of the real load set, all accounted for`);
}

// Of those literals, the ones that are runtime byte checks split three ways. This list is the
// honest part -- what is NOT proven live -- and the census above is what stops it going stale.
const UNCOVERED = [
  "fixed_host.py arm_watchdog() PYTHON_SHA -- needs a live GA. Round 20 showed this one is exploitable: written as adjacent-string concatenation of the predecessor's Windows digest, both gates stay green and the controller dies at the first step of START.",
  "trusted-github.mjs expectedGh -- needs a GitHub API call",
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

if (failures) { console.log(`runtime pin self-test FAILED (${failures} failed, ${unproven} unproven)`); process.exitCode = 1; }
else console.log(`runtime pin self-test passed (${unproven} item(s) UNPROVEN, ${UNCOVERED.length} not covered -- see above; passing here is not a claim about those)`);
