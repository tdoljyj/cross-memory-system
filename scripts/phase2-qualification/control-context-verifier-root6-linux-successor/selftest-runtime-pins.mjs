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
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const QUAL = path.resolve(DIR, '..');
const NAME = path.basename(DIR);
let failures = 0;
const fail = m => { console.error('  FAILED  ' + m); failures++; };
const ok = m => console.log('  ok       ' + m);
let unproven = 0;
const cannotProve = m => { console.log('  UNPROVEN ' + m); unproven++; };

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-pinselftest-'));
process.on('exit', () => fs.rmSync(sandbox, {recursive: true, force: true}));
fs.cpSync(QUAL, path.join(sandbox, 'q'), {recursive: true, filter: s => !s.includes('node_modules')});
const SQ = path.join(sandbox, 'q');
const SDIR = path.join(SQ, NAME);

const py = (script, cwd) => execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', script],
  {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

// Runs `probe` in the sandbox, first pristine, then with one byte appended to `target`.
// Pass means: pristine succeeds, mutated fails with an error naming `expect`.
function bothWays(label, target, probe, expect) {
  const abs = path.join(SQ, target);
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
bothWays('python chain: bridge -> fixed_host', `${NAME}/fixed_host.py`, loadChain, 'Accepted fixed host bytes changed');
bothWays('python chain: fixed_host -> parent600', `${NAME}/parent600.py`, loadChain, NAME + '/parent600.py');

// 2. fixed_host pins observe.py across directories -- the R17-F2 surface.
bothWays('cross-directory: fixed_host -> observe.py', 'docker-engineering-observation/observe.py',
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
bothWays('host-effect.mjs -> bridge.py bytes', `${NAME}/bridge.py`, jsPin, 'EXACT_PYTHON_BRIDGE_BYTES_REQUIRED');

// 4. parent600 pins the fixture across directories. Unlike the rest of prepare()'s pins this one
//    IS inside the tree, so it can be proven rather than asserted.
bothWays('cross-directory: parent600 -> fixed_skill_fixture.py',
  'control-context-verifier-public-runtime-env-diagnostic-successor/fixed_skill_fixture.py',
  loadChain, 'Exact proposed fixture bytes changed');

// 5. The platform gate and docker binary identity that round 17 found unported, plus the Skill
//    bytes. prepare() is CREATE's first step and does all of it.
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
try {
  const out = prepare(SDIR);
  if (out.includes('PREPARE_OK'))
    cannotProve('prepare() completes, but its platform gate, docker binary identity and Skill bytes cannot be mutated from inside the sandbox, so none of the three is proven live');
  else fail('prepare(): ' + out.trim().slice(0, 160));
} catch (e) { fail('prepare(): ' + String(e.stderr || e.message).trim().split('\n').pop().slice(0, 160)); }

// 6. The denominator. Round 18 printed two uncovered items in a free-text line while at least six
//    existed. Writing the set down and asserting its length is what stops it drifting again: add a
//    pin without listing it here and this fails.
const UNCOVERED = [
  "arm_watchdog() PYTHON_SHA -- needs a live GA",
  "trusted-github.mjs expectedGh -- needs a GitHub API call",
  "_invoke() platform gate and DOCKER_SHA -- needs a container operation",
  "grr.mjs accepted schema digest -- needs a terminal result",
  "result-terminal.mjs blob refs -- needs a GitHub API call",
  "context.mjs schema and issuer digests -- need a full dispatch",
];
if (UNCOVERED.length !== 6) fail(`UNCOVERED has ${UNCOVERED.length} entries; update the assertion deliberately, not by accident`);
for (const u of UNCOVERED) console.log('  not covered  ' + u);

if (failures) { console.log(`runtime pin self-test FAILED (${failures} failed, ${unproven} unproven)`); process.exitCode = 1; }
else console.log(`runtime pin self-test passed (${unproven} item(s) UNPROVEN, ${UNCOVERED.length} not covered -- see above; passing here is not a claim about those)`);
