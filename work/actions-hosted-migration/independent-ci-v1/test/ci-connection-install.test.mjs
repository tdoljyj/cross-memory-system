import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const resident = new URL('../../../independent-ci-resident-v1/', import.meta.url);
const scripts = ['windows/first-install-host.ps1', 'reinstall/launcher/template.ps1', 'windows/install-resident.ps1'];

for (const foreign of [false,true]) test('重装启动时出现轮换记录，只恢复本次准备留下的暂停 '+foreign,
  {skip:process.platform!=='win32'}, t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'ci-w1-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const script=fileURLToPath(new URL('test/ci-connection-launcher.ps1',resident));
    const p=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-FixtureRoot',root,...(foreign?['-ForeignPause']:[])],
      {encoding:'utf8',windowsHide:true});
    assert.equal(p.status,0,p.stderr);
    const r=JSON.parse(p.stdout);
    assert.equal(r.code,'CI_CONNECTION_REINSTALL_BASELINE_REQUIRED');
    assert.equal(r.paused,foreign);
    assert.deepEqual(r.calls,foreign?[]:['w1-resume']);
    assert.equal(r.terminal.code,r.code);
    assert.equal(r.terminal.w1Pause.restored,!foreign);
    if(foreign) assert.equal(r.terminal.w1Pause.reason,'PAUSE_NOT_THIS_LAUNCHS_LEFT_AS_IT_IS');
  });

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
