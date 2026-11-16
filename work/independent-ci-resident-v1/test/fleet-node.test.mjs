// The universal node package's node side in CI: rollout/fleet/test (prepare, the first install, publish, the tar reader) and the
// offline checks of the two first-install PowerShell scripts (rollout/fleet/test/test-bootstrap.ps1, windows/test-first-install-host.ps1).
// No CI suite ran any of them (the resident-fleet-node suite was taken out of the selector again in b596acbc: its selector source is
// pinned and re-pinning needs the whole registry chain). They run here, in resident-node, which every change under this directory
// selects (ci-required-selection.mjs RESIDENT_AND_SOURCE). They need Windows (sc.exe, Windows PowerShell 5.1, Windows paths): on Linux
// this file is skipped by name. Each fleet test file runs in a process of its own, as `node --test <dir>` would run it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLEET_TESTS = path.join(RES, 'rollout', 'fleet', 'test');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const windows = process.platform === 'win32';
const skip = windows ? false : 'the node side of the universal package runs on the Windows host only';
const tail = (s, n = 6000) => (String(s ?? '').length > n ? String(s).slice(-n) : String(s ?? ''));
// a child of `node --test` must not think it reports to this runner
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };

const files = windows ? fs.readdirSync(FLEET_TESTS).filter(n => n.endsWith('.test.mjs')).sort() : [];
test('rollout/fleet/test holds the fleet tests this file runs', { skip }, () => {
  assert.ok(files.includes('first-install.test.mjs') && files.includes('install.test.mjs'), files.join(','));
});
for (const name of files) {
  test(`rollout/fleet/test/${name}`, { skip, timeout: 3_600_000 }, () => {
    const r = spawnSync(process.execPath, ['--test', path.join(FLEET_TESTS, name)], { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true, timeout: 3_500_000 });
    assert.ifError(r.error);
    assert.equal(r.status, 0, `${name} failed:\n${tail(r.stdout)}\n${tail(r.stderr, 2000)}`);
  });
}

function powershellFile(script, extra = []) {
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra],
    { cwd: RES, env: childEnv(), encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true, timeout: 900_000 });
  assert.ifError(r.error);
  const last = String(r.stdout ?? '').trim().split(/\r?\n/).at(-1) ?? '';
  let verdict = null;
  try { verdict = JSON.parse(last); } catch { verdict = null; }
  return { status: r.status, verdict, out: `${tail(r.stdout)}\n${tail(r.stderr, 3000)}` };
}

test('rollout/fleet/test/test-bootstrap.ps1: the bootstrap\'s offline checks pass', { skip, timeout: 900_000 }, () => {
  const r = powershellFile(path.join(FLEET_TESTS, 'test-bootstrap.ps1'));
  assert.equal(r.status, 0, r.out);
  assert.equal(r.verdict?.status, 'BOOTSTRAP_PURE_TESTS_PASSED', r.out);
});

test('windows/test-first-install-host.ps1: the host preparation\'s offline checks pass, none skipped', { skip, timeout: 900_000 }, () => {
  const r = powershellFile(path.join(RES, 'windows', 'test-first-install-host.ps1'), ['-Node', process.execPath]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.verdict?.status, 'FIRST_INSTALL_HOST_PURE_TESTS_PASSED', r.out);
  assert.equal(r.verdict?.skipped, null, r.out);
});
