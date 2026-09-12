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
// So each pin is now tested in both directions. The check must pass against the pristine copy AND
// must fail, with its own error, against a copy whose pinned file has been altered by one byte. A
// check that cannot be made to fail is not running, and this reports that as a failure rather than
// as ok.
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
const ok = m => console.log('  ok      ' + m);

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

// 4. The platform gate and docker binary identity that round 17 found unported, plus the Skill
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
// The Skill lives outside the qualification tree, so it cannot be mutated inside the sandbox.
// Assert it positively instead, and say plainly that this one is one-directional.
try {
  const out = prepare(SDIR);
  if (out.includes('PREPARE_OK')) ok('prepare() completes: platform gate, docker binary identity, Skill bytes (one-directional -- the Skill is outside the sandbox)');
  else fail('prepare(): ' + out.trim().slice(0, 160));
} catch (e) { fail('prepare(): ' + String(e.stderr || e.message).trim().split('\n').pop().slice(0, 160)); }

// 5. Coverage this test does NOT provide, stated rather than left to be discovered:
//    arm_watchdog()'s PYTHON_SHA comparison and trusted-github.mjs's gh binary pin are on paths
//    that need a live GA and a GitHub call respectively. R18-F1(b) is right that a stale pin there
//    passes both gates today.
console.log('  note    not covered: arm_watchdog PYTHON_SHA, trusted-github gh pin (need a live GA / API call)');

if (failures) { console.log(`runtime pin self-test FAILED (${failures})`); process.exitCode = 1; }
else console.log('runtime pin self-test passed (each check proven live by mutation)');
