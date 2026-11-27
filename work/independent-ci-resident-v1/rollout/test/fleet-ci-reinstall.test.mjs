import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const resident = fileURLToPath(new URL('../../', import.meta.url));
const windows = process.platform === 'win32';
const check = String.raw`
$ErrorActionPreference = 'Stop'
$errors = $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:FIXTURE_TEMPLATE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$fn = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-CiInstallBaseline'}, $true)
. ([scriptblock]::Create($fn.Extent.Text))
$FleetCiConnectionB64 = 'fixture'
$invoked = $false
function Assert-FleetCiConnection([string]$ciRoot) {
  $script:invoked = $true
  if ($env:FIXTURE_REFUSAL) { throw $env:FIXTURE_REFUSAL }
}
try {
  Assert-CiInstallBaseline $env:FIXTURE_ROOT
  if (-not $invoked) { throw 'FIXTURE_PROBE_NOT_USED' }
  [Console]::Write('PASS')
} catch { [Console]::Write($_.Exception.Message) }
`;

for (const code of ['PASS', 'CI_CONNECTION_GENERATION_CHANGED', 'CI_CONNECTION_REVOKED',
  'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED', 'CI_PRIVATE_FILE_REFUSED']) {
  test('安装前的当前连接门禁 ' + code, { skip: !windows }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-reinstall-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'secrets'));
    await fs.writeFile(path.join(root, 'secrets', 'ci-admission.connection.json'), '{"fixture":true}');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], {
      windowsHide: true, encoding: 'utf8',
      env: { ...process.env, FIXTURE_TEMPLATE: path.join(resident, 'reinstall', 'launcher', 'template.ps1'),
        FIXTURE_ROOT: root, FIXTURE_REFUSAL: code === 'PASS' ? '' : code },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, code);
  });
}
