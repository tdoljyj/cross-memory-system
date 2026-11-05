// setup-clued-dev-linux.ps1 puts CluedDev-Linux on a data drive and checks the free
// space first (defect 2102f7e1: its virtual disk and local-verify's cache took
// 22 GB of C:, below the level at which the CI host's watchdog stops the
// runners). Run through its -Plan switch, which touches nothing: Windows, with
// PowerShell 7.3 or later (the script needs it), only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'setup-clued-dev-linux.ps1');
const pwsh = process.platform === 'win32'
  ? spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion -ge [version]"7.3"'], { encoding: 'utf8', windowsHide: true })
  : null;
const skip = pwsh?.status === 0 && pwsh.stdout.trim() === 'True' ? false : 'needs Windows with PowerShell 7.3 or later';

function plan(args, env = {}) {
  const cleaned = { ...process.env };
  delete cleaned.CLUED_DEV_ROOT;
  const result = spawnSync('pwsh', ['-NoProfile', '-File', SCRIPT, '-Plan', ...args], { encoding: 'utf8', windowsHide: true, env: { ...cleaned, ...env } });
  return { ...result, plan: result.status === 0 ? JSON.parse(result.stdout.trim().split(/\r?\n/).pop()) : null };
}
const systemRoot = () => path.parse(process.env.SystemRoot ?? 'C:\\Windows').root.toLowerCase();
const onSystemDrive = (dir) => path.parse(path.resolve(dir)).root.toLowerCase() === systemRoot();

test('the distribution and the downloads go under the data root, and the system drive is refused', { skip }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const allowed = plan(['-DataRoot', dir, '-AllowSystemDrive', '-RequiredFreeGB', '0.001']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.plan.InstallDir, path.join(dir, 'wsl', 'CluedDev-Linux'));
  assert.equal(allowed.plan.DownloadDir, path.join(dir, 'download'));
  assert.equal(allowed.plan.InstallDirOnSystemDrive, onSystemDrive(dir));
  const viaVariable = plan([], { CLUED_DEV_ROOT: dir });
  if (onSystemDrive(dir)) {
    assert.notEqual(viaVariable.status, 0, 'the system drive is refused');
    assert.match(`${viaVariable.stdout}${viaVariable.stderr}`, /is on the system drive/);
  } else {
    assert.equal(viaVariable.status, 0, viaVariable.stderr);
    assert.equal(viaVariable.plan.InstallDir, path.join(dir, 'wsl', 'CluedDev-Linux'), 'CLUED_DEV_ROOT is the data root');
  }
  const own = plan(['-InstallDir', path.join(dir, 'a'), '-DownloadDir', path.join(dir, 'b'), '-AllowSystemDrive']);
  assert.equal(own.status, 0, own.stderr);
  assert.deepEqual([own.plan.InstallDir, own.plan.DownloadDir], [path.join(dir, 'a'), path.join(dir, 'b')], 'each place can be set alone');
});

test('without a data root the default is a drive other than the system drive, or a refusal that says what to do', { skip }, () => {
  const result = plan([]);
  if (result.status === 0) {
    assert.match(result.plan.DataRoot, /^[D-Z]:\\clued-dev$/);
    assert.equal(result.plan.InstallDir, `${result.plan.DataRoot}\\wsl\\CluedDev-Linux`);
    assert.equal(result.plan.InstallDirOnSystemDrive, false);
  } else {
    assert.match(`${result.stdout}${result.stderr}`, /no fixed drive besides the system drive: pass -DataRoot/i);
  }
});

test('the free space is checked before anything is downloaded; on the system drive the watchdog level is kept on top', { skip }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-dev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = ['-Name', 'CluedDevTest-NotInstalled'];
  const short = plan([...name, '-DataRoot', dir, '-AllowSystemDrive', '-RequiredFreeGB', '99999999']);
  assert.equal(short.status, 0, short.stderr);
  assert.equal(short.plan.ExistingBasePath, null);
  assert.match(short.plan.SpaceProblem, /The virtual disk of CluedDevTest-NotInstalled needs 99999999 GB.*has [\d.]+ GB free; choose another drive with -DataRoot/);
  // exactly the free space is not enough on the system drive: the watchdog's 50 GB come first
  if (onSystemDrive(dir)) {
    const free = short.plan.InstallDirFreeGB;
    const tight = plan([...name, '-DataRoot', dir, '-AllowSystemDrive', '-RequiredFreeGB', String(free)]);
    assert.match(tight.plan.SpaceProblem, /the 50 GB the CI watchdog keeps free on it/);
  }
});
