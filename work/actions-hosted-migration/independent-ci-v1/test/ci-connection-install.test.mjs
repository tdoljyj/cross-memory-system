import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const resident = new URL('../../../independent-ci-resident-v1/', import.meta.url);
const scripts = ['windows/first-install-host.ps1', 'reinstall/launcher/template.ps1', 'windows/install-resident.ps1'];

const windows = { skip: process.platform !== 'win32' };
const modes = ['original', 'a-timeout', 'before-uninstall', 'b-timeout', 'inside-uninstall', 'after-uninstall', 'after-install', 'first-install', 'non-fleet'];
const refusal = 'CI_CONNECTION_REINSTALL_BASELINE_REQUIRED';
function launch(t, mode, scene) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-w1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = ext => fileURLToPath(new URL('test/ci-connection-launcher.' + ext, resident));
  const launcher = path.join(root, 'launcher.ps1');
  const run = (exe, args) => {
    const p = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(p.status, 0, p.stderr);
    return p.stdout;
  };
  run('python', ['-I', '-B', fixture('py'), mode, launcher]);
  return JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fixture('ps1'),
    '-FixtureRoot', root, '-Launcher', launcher, '-Scene', scene]));
}
for (const mode of modes) {
  const scenes = mode === 'original' ? ['own', 'foreign', 'changed-door', 'replay', 'progress'] : ['own'];
  for (const scene of scenes) test(`轮换记录在任何清扫、凭据复制或重装之前拒绝 ${mode}/${scene}`, windows, t => {
    const r = launch(t, mode, scene);
    const restore = mode === 'original' && scene === 'own';
    const fresh = mode === 'original' && ['own', 'foreign', 'changed-door'].includes(scene);
    const pauseReason = scene === 'foreign' ? 'other' : 'fixture-w1';
    const pauseSha = createHash('sha256').update(JSON.stringify({source:{reason:pauseReason}})).digest('hex');
    assert.deepEqual({ code:r.code, resume:r.resumeCalls, pause:r.pauseSha, prior:r.prior, calls:r.calls }, {
      code:refusal, resume:restore ? ['Resume'] : [], pause:restore ? null : pauseSha,
      prior:['prior evidence', 'prior evidence'], calls:fresh ? ['output'] : [],
    }, mode + '/' + scene);
    if (fresh) {
      assert.equal(r.terminal.code, refusal);
      assert.equal(r.terminal.w1Pause.restored, restore);
      if (!restore) assert.equal(r.terminal.w1Pause.reason, scene === 'foreign'
        ? 'PAUSE_NOT_THIS_LAUNCHS_LEFT_AS_IT_IS' : 'INSTALLED_RESUME_DOOR_NOT_AS_REVIEWED');
    }
  });
}
for (const [mode, first] of [['original','Step-WindowsPreflightBeforeLinux'], ['a-timeout','Step-ContinueAfterATimeout'],
  ['before-uninstall','Step-ContinueBeforeUninstall'], ['b-timeout','Step-ContinueBeforeUninstall'],
  ['inside-uninstall','Step-ContinueInsideUninstall'], ['after-uninstall','Step-ContinueAfterUninstall'], ['after-install','Step-ContinueAfterInstall']]) {
  test(`没有轮换记录时进入原定步骤 ${mode}`, windows, t => {
    const r = launch(t, mode, 'clear');
    assert.equal(r.code, 'FIXTURE_REINSTALL_STEP_REACHED');
    assert.deepEqual(r.calls, ['sweep', 'output', 'package', 'stage', first]);
    if (mode !== 'original') assert.deepEqual(r.resumeCalls, []);
  });
}

test('首次安装、重装和直接安装在修改机器之前拒绝已有的当前连接', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-install-refusal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'scratch.ps1');
  fs.writeFileSync(driver, [
    'param([string]$Script,[string]$Root)',
    "$ErrorActionPreference='Stop'",
    '$t=$null;$e=$null',
    '$ast=[Management.Automation.Language.Parser]::ParseFile($Script,[ref]$t,[ref]$e)',
    '$f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq "Assert-CiInstallBaseline"},$true)',
    'if ($null -eq $f -or $e.Count) {exit 2}',
    '. ([scriptblock]::Create($f.Extent.Text))',
    "try {Assert-CiInstallBaseline $Root; 'OK'} catch {$_.Exception.Message}",
  ].join('\n'));
  for (const script of scripts) {
    const source = fileURLToPath(new URL(script, resident));
    const text = fs.readFileSync(source, 'utf8');
    const check = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', driver, source, dir],
      { windowsHide: true, encoding: 'utf8' }).stdout.trim();
    assert.equal(check(), 'OK', script);
    const secrets = path.join(dir, 'secrets');
    fs.mkdirSync(secrets, { recursive: true });
    const file = path.join(secrets, 'ci-admission.connection.json');
    fs.writeFileSync(file, '{}');
    assert.equal(check(), 'CI_CONNECTION_REINSTALL_BASELINE_REQUIRED', script);
    fs.unlinkSync(file);
    const call = text.match(/^ *Assert-CiInstallBaseline [^\r\n]+/m);
    assert.ok(call, script);
    const firstEffect = script.includes('first-install-host') ? '  $observed = Get-ObservedResidue'
      : script.includes('template') ? '\nStep-HostHygiene' : '$script:SecretBytes = @{}';
    assert.ok(text.indexOf(firstEffect) > call.index, script);
  }
});
