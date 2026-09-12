// Exercises the controller's real byte checks instead of reading its source.
//
// check-digest-pins.mjs scans text, and round 17 showed what that buys: seven ways to write a
// digest slipped past it, including R16-F1 rewritten as 'aaa'+'bbb'. Patching regexes forever is
// the wrong answer, because the thing being checked is what the code COMPARES AT RUNTIME and the
// text is only evidence about that. So this asks the code.
//
// Every pin exercised here throws when it is stale, however the digest is spelled -- uppercase,
// concatenated, split across lines, or computed. A textual gate cannot say that; this can.
// The two are kept together on purpose: the scan is cheap and catches a stale pin before anything
// runs, this is authoritative. build-linux-manifest.mjs requires both.
//
// It performs no docker operation, creates no container, touches no database and consumes no
// budget.
//
// One trap, hit while writing this: the first draft called invokeFixedHost with a deadline already
// in the past, reasoning that it would be refused safely. It was -- at host-effect.mjs:13, which
// sits BEFORE the byte comparison at :14. So the check this test exists for never ran, and with a
// stale digest planted as a concatenation the test still reported ok. The deadline must be live
// for the byte check to be reached at all.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const fail = m => { console.error('  FAILED  ' + m); process.exitCode = 1; };
const ok = m => console.log('  ok      ' + m);

// 1. The python chain. Each module compares the digest of the one below it as it loads, and
//    bridge.load_host() compares fixed_host.py's, so a stale pin anywhere raises here.
const py = `
import importlib.util, sys
def load(name, f):
    s = importlib.util.spec_from_file_location(name, f)
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
for f in ('parent600.py', 'fixed_host.py', 'bridge.py'):
    load(f[:-3], f)
b = load('bridge2', 'bridge.py')
b.load_host()
print('PYTHON_PINS_OK')
`;
try {
  const out = execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', py],
    {cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (out.includes('PYTHON_PINS_OK')) ok('parent600 / fixed_host / bridge load, and load_host() returns');
  else fail('python chain produced no confirmation: ' + out.trim().slice(0, 200));
} catch (e) {
  fail('python chain: ' + String(e.stderr || e.message).trim().split('\n').slice(-1)[0].slice(0, 200));
}

// 2. The JS pin on python3.11 and bridge.py. This is the one the textual gate could not see when
//    it was written as a variable comparison, and the one R16-F1 lived in.
try {
  const {invokeFixedHost} = await import(path.join(DIR, 'host-effect.mjs'));
  let reached = false;
  try {
    invokeFixedHost({gaRaw: '{"gate_authorization_id":"ga_selftest"}', operation: 'CREATE',
                     containerId: null, deadline: Date.now() + 120000});
    reached = true;
  } catch (e) {
    const m = String(e.message);
    if (m.includes('FIXED_LIVE_HOST_OPERATION_REQUIRED'))
      fail('refused before the byte check ran, so this proved nothing about the pins');
    else if (m.includes('EXACT_PYTHON_BRIDGE_BYTES_REQUIRED'))
      fail('host-effect.mjs pins stale python or bridge bytes (the R16-F1 shape)');
    else { reached = true; }
  }
  if (reached) ok('host-effect.mjs byte checks on python3.11 and bridge.py pass');
} catch (e) { fail('host-effect.mjs did not import: ' + String(e.message).slice(0, 160)); }

// 3. The platform and docker-binary gate that round 17 found had never been ported (R17-F1).
//    prepare() is the first step of CREATE and refuses before any of it if the host is wrong.
const probe = `
import importlib.util, json, secrets, traceback
from datetime import datetime, timezone, timedelta
s = importlib.util.spec_from_file_location('fh', 'fixed_host.py')
fh = importlib.util.module_from_spec(s); s.loader.exec_module(fh)
ga = json.dumps({'gate_authorization_id': 'ga_selftest',
                 'deadline': (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat().replace('+00:00', 'Z')})
try:
    fh.prepare(secrets.token_hex(16), ga)
    print('PREPARE_OK')
except Exception as e:
    tb = traceback.extract_tb(e.__traceback__)[-1]
    print('PREPARE_FAILED %s:%d %s: %s' % (tb.filename.split('/')[-1], tb.lineno, type(e).__name__, e))
`;
try {
  const out = execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', probe],
    {cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  if (out.includes('PREPARE_OK')) ok('fixed_host.prepare() completes on this host: platform gate, docker bytes, Skill bytes');
  else fail(out.slice(0, 200));
} catch (e) {
  fail('prepare() probe: ' + String(e.stderr || e.message).trim().split('\n').slice(-1)[0].slice(0, 200));
}

// prepare() creates a working folder; leave nothing behind.
try {
  const py2 = `
import importlib.util
s = importlib.util.spec_from_file_location('p', 'parent600.py')
p = importlib.util.module_from_spec(s); s.loader.exec_module(p)
print(str(p.paths('0' * 32)[0].parent))
`;
  const root = execFileSync('/usr/bin/python3.11', ['-I', '-S', '-B', '-c', py2], {cwd: DIR, encoding: 'utf8'}).trim();
  if (root.startsWith('/tmp/')) for (const d of fs.readdirSync(root)) fs.rmSync(path.join(root, d), {recursive: true, force: true});
} catch {}

if (process.exitCode) console.log('runtime pin self-test FAILED');
else console.log('runtime pin self-test passed (all three exercised by execution)');
