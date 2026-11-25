// The right to log on as a service for clued-control in the first install (Fable renew-key ruling, supplement "service logon grant"): by the
// system's account-rights interface, through the companion registrar's own grant (the one that gives the companion its batch logon), never
// by exporting, editing and writing back the whole security policy (secedit /configure: probe round one stopped there with exit 1 and an
// empty stderr, cause still to be found). Success is the result read back: the account's rights must hold SeServiceLogonRight. A refusal
// says the step it stopped in (resolve, open, grant, readback) and the system's raw status. Offline: the grant and the read-back are two
// replaceable steps (no real grant: that needs elevation and changes the machine's policy); the real path is the next probe round's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREP = path.join(RES, 'windows', 'prepare-companion-account.ps1');
const HOST = path.join(RES, 'windows', 'first-install-host.ps1');
const REGISTRAR = path.join(RES, 'windows', 'CompanionTaskRegistrar.cs');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

function ps(command) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim());
}
const functionsOf = (file, names) => `$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(file)}, [ref]$tokens, [ref]$errors)
foreach ($name in @(${names.map(psLiteral).join(', ')})) {
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($f.Count -lt 1) { throw ('FUNCTION_MISSING:' + $name) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}`;
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1002';

test('the grant and the read-back, each replaceable: a failed grant, a grant not read back, and both done', { skip, timeout: 120_000 }, () => {
  const r = ps(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
${functionsOf(PREP, ['Get-PrepField', 'Grant-PrepServiceLogon'])}
$script:calls = @()
function Invoke-PrepGrantServiceLogon([string]$exe, [string]$sid) { $script:calls += "grant $sid"; $script:grant }
function Read-PrepAccountRights([string]$exe, [string]$sid) { $script:calls += "readback $sid"; $script:facts }
$case = { param($grant, $facts) $script:grant = $grant; $script:facts = $facts; $script:calls = @(); $v = Grant-PrepServiceLogon 'reg.exe' ${psLiteral(SID)}; [ordered]@{ v = $v; calls = $script:calls } }
$ok = [pscustomobject]@{ contract = 'x'; code = 'RIGHT_GRANTED' }
[ordered]@{
  refused = (& $case ([pscustomobject]@{ contract = 'x'; code = 'RIGHT_NOT_GRANTED'; detail = 'grant:0xC0000022:5' }) $null)
  notOpened = (& $case ([pscustomobject]@{ contract = 'x'; code = 'RIGHT_NOT_GRANTED'; detail = 'open:0xC0000022:5' }) $null)
  unresolved = (& $case ([pscustomobject]@{ contract = 'x'; code = 'RIGHT_NOT_GRANTED'; detail = 'resolve' }) $null)
  silent = (& $case $null $null)
  notReadBack = (& $case $ok ([pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; rights = @('SeBatchLogonRight') }))
  readbackFailed = (& $case $ok ([pscustomobject]@{ code = 'REGISTRAR_UNEXPECTED'; detail = 'LSA_RIGHTS:5' }))
  done = (& $case $ok ([pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; rights = @('SeBatchLogonRight', 'SeServiceLogonRight') }))
} | ConvertTo-Json -Depth 6 -Compress`);
  assert.deepEqual(r.refused.v, { status: 'SERVICE_LOGON_RIGHT_NOT_GRANTED', step: 'grant', ntStatus: '0xC0000022', win32: '5', registrarCode: 'RIGHT_NOT_GRANTED', detail: 'grant:0xC0000022:5', rights: null });
  assert.deepEqual(r.refused.calls, [`grant ${SID}`], 'no read-back after a failed grant');
  assert.deepEqual([r.notOpened.v.step, r.notOpened.v.ntStatus], ['open', '0xC0000022']);
  assert.deepEqual([r.unresolved.v.step, r.unresolved.v.ntStatus], ['resolve', null]);
  assert.deepEqual([r.silent.v.status, r.silent.v.step, r.silent.v.registrarCode], ['SERVICE_LOGON_RIGHT_NOT_GRANTED', 'grant', null]);
  assert.deepEqual(r.notReadBack.v, { status: 'SERVICE_LOGON_RIGHT_NOT_GRANTED', step: 'readback', ntStatus: null, win32: null, registrarCode: 'ACCOUNT_FACTS', detail: null, rights: ['SeBatchLogonRight'] },
    'the grant said done, the account does not hold it: refused');
  assert.deepEqual([r.readbackFailed.v.step, r.readbackFailed.v.registrarCode, r.readbackFailed.v.detail], ['readback', 'REGISTRAR_UNEXPECTED', 'LSA_RIGHTS:5']);
  assert.deepEqual([r.done.v.status, r.done.v.step], ['SERVICE_LOGON_GRANTED', null]);
  assert.deepEqual(r.done.calls, [`grant ${SID}`, `readback ${SID}`]);
});

test('the host preparation stops on anything but a grant read back, the step and the raw status in the refusal', { skip, timeout: 120_000 }, () => {
  const r = ps(`$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2
${functionsOf(HOST, ['Get-Key', 'Assert-ServiceLogonGranted'])}
Add-Type -AssemblyName System.Web.Extensions
function Stop-Host([string]$code, $detail) { throw (New-Object InvalidOperationException ($code + ' ' + (ConvertTo-Json $detail -Compress -Depth 4))) }
$js = New-Object Web.Script.Serialization.JavaScriptSerializer
$run = { param($json) try { Assert-ServiceLogonGranted ($js.DeserializeObject($json)); 'passed' } catch { $_.Exception.Message } }
[ordered]@{
  granted = (& $run '{"status":"COMPANION_ACCOUNT_PREPARED","steps":{"serviceLogon":{"status":"SERVICE_LOGON_GRANTED","step":null}}}')
  refused = (& $run '{"status":"COMPANION_ACCOUNT_PREPARED","steps":{"serviceLogon":{"status":"SERVICE_LOGON_RIGHT_NOT_GRANTED","step":"grant","ntStatus":"0xC0000022","win32":"5","registrarCode":"RIGHT_NOT_GRANTED","rights":null}}}')
  missing = (& $run '{"status":"COMPANION_ACCOUNT_PREPARED","steps":{}}')
} | ConvertTo-Json -Compress`);
  assert.equal(r.granted, 'passed');
  assert.match(r.refused, /^SERVICE_LOGON_RIGHT_NOT_GRANTED /);
  const detail = JSON.parse(r.refused.replace(/^SERVICE_LOGON_RIGHT_NOT_GRANTED /, ''));
  assert.deepEqual([detail.step, detail.ntStatus, detail.win32], ['grant', '0xC0000022', '5']);
  assert.match(r.missing, /^SERVICE_LOGON_RIGHT_NOT_GRANTED /, 'no record of the grant is no grant');
});

test('no whole-policy write-back is left; the one grant is the registrar\'s, shared with the companion\'s batch logon', () => {
  const host = fs.readFileSync(HOST, 'utf8'), prep = fs.readFileSync(PREP, 'utf8'), reg = fs.readFileSync(REGISTRAR, 'utf8');
  for (const [name, text] of [['first-install-host.ps1', host], ['prepare-companion-account.ps1', prep]]) {
    assert.doesNotMatch(text, /secedit(\.exe)?['"]?\s*[^\r\n]*\/(configure|import)\b/i, `${name}: no secedit /configure or /import`);
    assert.doesNotMatch(text, /\bLsaAddAccountRights\b/, `${name}: no second grant written in the script`);
  }
  // the host hands clued-control's SID to the companion account script, which grants through the registrar and reads back
  assert.match(host, /'-ServiceLogonSid', \$controllerSid/);
  assert.match(host, /Assert-ServiceLogonGranted \$pr/);
  assert.match(prep, /Invoke-PrepRegistrar \$exe @\('grant-service-logon', \$sid\)/);
  assert.match(prep, /Invoke-PrepRegistrar \$exe @\('account-facts', \$sid\)/);
  // one call of LsaAddAccountRights in the registrar (its declaration aside): prepare-account and grant-service-logon share it
  const calls = [...reg.matchAll(/LsaAddAccountRights\(/g)].length - [...reg.matchAll(/extern uint LsaAddAccountRights\(/g)].length;
  assert.equal(calls, 1, 'one grant implementation');
  assert.match(reg, /args\[0\] == "grant-service-logon"/);
  assert.match(reg, /GrantRights\(sid, new\[\] \{ "SeBatchLogonRight"|AddRights\(sid, new\[\] \{ "SeBatchLogonRight"/);
});
