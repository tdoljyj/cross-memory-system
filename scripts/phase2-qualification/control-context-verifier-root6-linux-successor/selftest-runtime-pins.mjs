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
// The other two pins prepare() carries still cannot be touched from here: sys.platform is not a
// file, and /usr/bin/docker is outside the sandbox. Completing does not prove either live.
cannotProve("prepare() completes, but its platform gate and its /usr/bin/docker identity check cannot be mutated from inside the sandbox, so neither of those two is proven live");

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

// 7. The denominator. Round 18 printed two uncovered items in a free-text line while at least six
//    existed. Writing the set down and asserting its length is what stops it drifting again: add a
//    pin without listing it here and this fails.
const UNCOVERED = [
  "arm_watchdog() PYTHON_SHA -- needs a live GA",
  "trusted-github.mjs expectedGh -- needs a GitHub API call",
  "_invoke() platform gate and DOCKER_SHA -- needs a container operation",
  "grr.mjs accepted schema digest -- needs a terminal result",
  "result-terminal.mjs blob refs -- needs a GitHub API call",
  "context.mjs schema and issuer digests -- need a full dispatch",
  "trusted entry: the /usr/bin/python3.11 and /opt/node22/bin/node byte gates -- both binaries sit outside the sandbox, so item 6 does not prove those two live",
  "trusted entry: the shell binary -- chosen by the harness's exec_command, not by the script, so it can be neither pinned from here nor mutated",
];
if (UNCOVERED.length !== 8) fail(`UNCOVERED has ${UNCOVERED.length} entries; update the assertion deliberately, not by accident`);
for (const u of UNCOVERED) console.log('  not covered  ' + u);

if (failures) { console.log(`runtime pin self-test FAILED (${failures} failed, ${unproven} unproven)`); process.exitCode = 1; }
else console.log(`runtime pin self-test passed (${unproven} item(s) UNPROVEN, ${UNCOVERED.length} not covered -- see above; passing here is not a claim about those)`);
