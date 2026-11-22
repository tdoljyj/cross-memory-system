// The C# mirror (FormalPublicBoundaryV2.cs and the rest of src/resident-v2/windows) run, not only read: test-pure-v2.ps1 compiles the
// helper and the pure harness with the in-box csc into a new scratch directory, derives its fixture with this checkout's Node side
// (the shared train-run table, test/fixtures/train-run-cases.json, among it) and runs the pure assertions. Offline: no service, no
// ProgramData, no elevation (the script's own header). R3 batch 2 follow-up §3a (task 04f9b91b): before this nothing ran it.
// Windows only, like test/fleet-node.test.mjs's wrapper of test-bootstrap.ps1 in the resident.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'resident-v2', 'windows', 'test-pure-v2.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'the C# boundary is compiled with the Windows in-box csc';
const tail = (s, n = 6000) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''));
// a child of `node --test` must not think it reports to this runner, and carries the test marker itself
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; e.CLUED_UNDER_TEST = '1'; return e; };

test('src/resident-v2/windows/test-pure-v2.ps1: the C# boundary compiles and passes the pure checks (the shared train-run table among them)', { skip, timeout: 900_000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-pure-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'scratch'); // a new directory, as the script requires
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Scratch', scratch, '-Node', process.execPath],
    { env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: 850_000 });
  assert.ifError(r.error);
  const out = `${tail(r.stdout)}\n${tail(r.stderr, 3000)}`;
  assert.equal(r.status, 0, out);
  let verdict = null;
  try { verdict = JSON.parse(String(r.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? ''); } catch { verdict = null; }
  assert.equal(verdict?.status, 'SOURCE_V2_CSHARP_OFFLINE_PASS', out);
});
