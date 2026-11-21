// Fable ruling 11-21 "r5 preflight gaps" sections 2.1, 2.2 (the launcher's line), 2.4 and 2.5 X2: the launcher's part, each held by a test
// that failed before it.
//   X1  a first install's Linux run directories are not made under the resident root (the installer after Linux B refuses a root that is
//       there, FRESH_INSTALL_REQUIRED_...); and right before Linux B a first install stops if the root or a service is there all the same
//   N7  a first install's preflight refuses a node whose identity keys are not there (NODE_IDENTITY_KEY_MISSING), read with the
//       registration script's own Find-MachineKey
//   N9  a launcher generated over an empty ledger (no batch ever ran) accepts the kept ledger only when it is still empty; otherwise the
//       pinned terminal entry, as before. One pure function for both
//   X2  the install preflight refuses the installer's dry run saying the controller may not log on as a service
// Real files only: functions taken by AST from reinstall/launcher/template.ps1 (and registration/export-node-registration.ps1), in Windows
// PowerShell 5.1, on directories under TEMP; the few steps around them are stand-ins that record what they were asked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
const REG = path.join(RES, 'registration', 'export-node-registration.ps1');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const HEX = c => c.repeat(64);

function ps(command) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}

// The named functions and top-level assignments of the template, dot-sourced into the script scope. `soft`: functions that may not exist
// (yet): each is loaded when it is there, and $Missing lists the ones that are not.
const load = (fns = [], vars = [], soft = []) => `$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_ERRORS' }
$Missing = @()
foreach ($pair in @(${[...fns.map(f => `@(${psLiteral(f)}, $false)`), ...soft.map(f => `@(${psLiteral(f)}, $true)`)].join(', ') || "@('', $false)"})) { $name = $pair[0]; if (-not $name) { continue }
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($f.Count -eq 0 -and $pair[1]) { $Missing += $name; continue }
  if ($f.Count -ne 1) { throw ('FUNCTION_NOT_ONE:' + $name + ':' + $f.Count) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}
foreach ($name in @(${vars.map(psLiteral).join(', ') || "''"})) { if (-not $name) { continue }
  $a = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Left.Extent.Text -ceq ('$' + $name) }, $false))
  if ($a.Count -ne 1) { throw ('ASSIGNMENT_NOT_ONE:' + $name + ':' + $a.Count) }
  . ([scriptblock]::Create($a[0].Extent.Text))
}
`;
const PRELUDE = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
function Stop-Launch([string]$code, $detail) { $script:stopped = $code; throw ('STOP:' + $code) }
$script:stopped = $null
`;

// ---------------------------------------------------------------- X1
// The real New-FleetRunDirectory, its two SDDL literals given the test account's own entry in place of the Administrators owner a
// non-elevated test cannot set (the layout and the ACL entries are otherwise the template's); the capture directory is a plain stand-in.
const RUN_DIRECTORY = `$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'New-FleetRunDirectory' }, $true))
if ($f.Count -ne 1) { throw 'RUN_DIRECTORY_FUNCTION_NOT_ONE' }
$text = $f[0].Extent.Text
foreach ($p in @(@("'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'", ("'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + $me + ")'")), @("'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'", ("'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + $me + ")'")))) {
  if (([regex]::Matches($text, [regex]::Escape($p[0]))).Count -ne 1) { throw ('SDDL_LITERAL_NOT_ONE:' + $p[0]) }
  $text = $text.Replace($p[0], $p[1])
}
. ([scriptblock]::Create($text))
function New-FleetCaptureDirectory([string]$runDirectory, [string]$leaf) { $d = Join-Path $runDirectory $leaf; [void][IO.Directory]::CreateDirectory($d); $d }
`;

test('X1: a first install makes its Linux run directories in the CI root, never the resident root; a reinstall still in resident\\install', { skip, timeout: 300_000 }, (t) => {
  const ci = path.join(tempDir(t, 'r5-x1-'), 'ci'); fs.mkdirSync(ci);
  const script = path.join(ci, '..', 'A.sh'); fs.writeFileSync(script, '#!/bin/bash\necho A\n');
  const scriptSha = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  const r = ps(`${PRELUDE}
${load(['Sha256Bytes', 'Write-New', 'Get-FleetScriptPin'], ['U8'], ['Get-FleetRunParent'])}
${RUN_DIRECTORY}
$CarryParent = ${psLiteral(ci)}; $ResidentRoot = Join-Path $CarryParent 'resident'
$FleetCompanionAccount = $false; $OwnerSid = $me
$FleetScriptA = ${psLiteral(script)}; $FleetScriptASha256 = ${psLiteral(scriptSha)}; $FleetTimeoutA = 60
$runs = [ordered]@{}
$FleetFirstInstall = $true
foreach ($n in @('probe', 'A')) { $x = $(if ($n -ceq 'probe') { New-FleetRunDirectory 'probe' -Probe } else { New-FleetRunDirectory 'A' }); $runs['first-' + $n] = [ordered]@{ parent = (Split-Path -Parent $x.directory); leaf = (Split-Path -Leaf $x.directory); script = [bool]($x.script -and [IO.File]::Exists($x.script)) } }
$rootAfterFirst = [IO.Directory]::Exists($ResidentRoot) -or [IO.File]::Exists($ResidentRoot)
$FleetFirstInstall = $null
foreach ($n in @('probe', 'A')) { $x = $(if ($n -ceq 'probe') { New-FleetRunDirectory 'probe' -Probe } else { New-FleetRunDirectory 'A' }); $runs['re-' + $n] = [ordered]@{ parent = (Split-Path -Parent $x.directory); leaf = (Split-Path -Leaf $x.directory); script = [bool]($x.script -and [IO.File]::Exists($x.script)) } }
ConvertTo-Json -Depth 5 -Compress -InputObject ([ordered]@{ rootAfterFirst = $rootAfterFirst; runs = $runs })`);
  assert.equal(r.rootAfterFirst, false, 'a first install\'s run directories leave the resident root as it found it: not there');
  for (const n of ['probe', 'A']) {
    assert.equal(r.runs[`first-${n}`].parent, ci, n);
    assert.equal(r.runs[`re-${n}`].parent, path.join(ci, 'resident', 'install'), n);
    for (const k of ['first', 're']) assert.match(r.runs[`${k}-${n}`].leaf, n === 'probe' ? /^linux-run-[0-9a-f]{32}-probe$/ : /^linux-run-[0-9a-f]{32}$/, `${k} ${n}`);
  }
  assert.equal(r.runs['first-A'].script, true); assert.equal(r.runs['re-A'].script, true);
});

// The real Step-LinuxRoot of a first install (no companion account, so no registrar and no probe) with the Linux runs as stand-ins: one
// that makes the resident root while it runs (any step that does, now or later) and one that leaves it alone; the services read through
// a stand-in Get-Service (the machine running the test is a CI node and has them).
const LINUX_ROOT = (ci, { rootByA = false, services = [] } = {}) => `${PRELUDE}
${load(['Sha256Bytes', 'Write-New', 'Write-Json', 'Get-Key', 'Parse-Json', 'Parse-LastLine', 'Tail', 'Get-FileSha', 'Test-FleetLinuxOutput', 'Get-FleetOutFile',
  'Test-FleetRun', 'Get-FleetRunReport', 'Read-FleetFileChecked', 'Test-FleetRefusedBeforeAnyChange', 'Set-FleetW1PauseKept', 'Step-LinuxRoot'], ['U8', 'Strict8'],
  ['Get-FirstInstallResidue', 'Test-FirstInstallResiduePresent'])}
$ci = ${psLiteral(ci)}
$CarryParent = $ci; $ResidentRoot = Join-Path $ci 'resident'
$Out = Join-Path $ci 'launch'; $Stage = Join-Path $ci 'stage'; $FleetOutDir = Join-Path $ci 'out'
foreach ($d in @($Out, $Stage, $FleetOutDir)) { [void][IO.Directory]::CreateDirectory($d) }
$Done = New-Object Collections.Generic.List[string]
$FleetFirstInstall = $true; $FleetCompanionAccount = $false; $FleetDistribution = 'D'; $FleetPlanSha256 = ('d' * 64); $FleetWslOutDir = '/mnt/x/out'
$CiSourceManifestSha256 = ('a' * 64); $PackageManifestSha256 = ('c' * 64); $FleetLinuxManifestSha256 = ('b' * 64)
$W1Restore = [ordered]@{ armed = $false; result = $null }
$calls = New-Object Collections.Generic.List[string]
$present = @(${services.map(psLiteral).join(', ')})
function Get-Service { param([string[]]$Name, $ErrorAction) foreach ($n in @($Name)) { if ($present -ccontains $n) { [pscustomobject]@{ Name = $n } } } }
function Set-FleetLinuxDirectories { $calls.Add('directories') }
function Read-FleetOutFile([string]$leaf, $run, [string]$registrar, [int]$max) { $null }
function Remove-FleetRegistrar($build) { $calls.Add('remove') }
function Invoke-FleetLinuxScript([string]$name, [string]$registrar) {
  $calls.Add('run:' + $name)
  if ($name -ceq 'A' -and ${rootByA ? '$true' : '$false'}) { [void][IO.Directory]::CreateDirectory((Join-Path $ResidentRoot ('install\\linux-run-' + ('e' * 32)))) }
  $status = $(if ($name -ceq 'A') { 'PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED' } else { 'LINUX_FIRST_INSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1' })
  [ordered]@{ name = $name; directory = ('run-' + $name); outcome = 'EXITED'; exit = 0; code = $null; captureRefused = $null; stdout = ('{"status":"' + $status + '"}'); stderrTail = $null; registrarStderr = $null; seconds = 1 }
}
try { $null = Step-LinuxRoot } catch { if (-not $script:stopped) { throw } }
$report = $(if ([IO.File]::Exists((Join-Path $Out 'linux-report.json'))) { Get-Content -LiteralPath (Join-Path $Out 'linux-report.json') -Raw | ConvertFrom-Json } else { $null })
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ missing = $Missing; stopped = $script:stopped; calls = @($calls); done = @($Done); codes = $(if ($report) { , @($report.codes) } else { $null }) })`;

test('X1: right before Linux B a first install stops when the resident root or one of its services is there', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-x1b-');
  const made = ps(LINUX_ROOT(path.join(dir, 'a'), { rootByA: true }));
  assert.deepEqual(made.calls.filter(c => c.startsWith('run:')), ['run:A'], `Linux B must not start: ${JSON.stringify(made)}`);
  assert.equal(made.stopped, 'FIRST_INSTALL_ROOT_PRESENT_BEFORE_LINUX_B');
  assert.deepEqual(made.codes, ['FIRST_INSTALL_ROOT_PRESENT_BEFORE_LINUX_B'], 'linux-report.json names it');
  assert.deepEqual(made.done, ['linux-A']);
  const service = ps(LINUX_ROOT(path.join(dir, 'b'), { services: ['CluedCIUpgrader'] }));
  assert.equal(service.stopped, 'FIRST_INSTALL_ROOT_PRESENT_BEFORE_LINUX_B', JSON.stringify(service));
  assert.deepEqual(service.calls.filter(c => c.startsWith('run:')), ['run:A']);
  // nothing there: B runs (and the stand-in's missing output stops it later, by its own code)
  const clean = ps(LINUX_ROOT(path.join(dir, 'c')));
  assert.deepEqual(clean.calls.filter(c => c.startsWith('run:')), ['run:A', 'run:B'], JSON.stringify(clean));
  assert.notEqual(clean.stopped, 'FIRST_INSTALL_ROOT_PRESENT_BEFORE_LINUX_B');
  assert.deepEqual(clean.missing, []);
});

// ---------------------------------------------------------------- N7
test('N7: the identity-key rule: both keys there passes, one or both missing is NODE_IDENTITY_KEY_MISSING (the finder injected)', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(['Get-Key'], [], ['Test-NodeIdentityKeys'])}
if ($Missing.Count) { ConvertTo-Json -Compress -InputObject ([ordered]@{ missing = $Missing }); return }
$names = [ordered]@{ identity = 'Id-v1'; encryption = 'Enc-v1' }
$cases = [ordered]@{}
foreach ($have in @(@('Id-v1', 'Enc-v1'), @('Enc-v1'), @('Id-v1'), @())) {
  $finder = { param($n) if ($have -ccontains $n) { @{ key = $null; origin = 'tpm' } } else { $null } }.GetNewClosure()
  $cases[($have -join '+')] = Test-NodeIdentityKeys $names $finder
}
ConvertTo-Json -Depth 5 -Compress -InputObject ([ordered]@{ missing = $Missing; cases = $cases })`);
  assert.deepEqual(r.missing, [], 'the launcher has the rule');
  assert.equal(r.cases['Id-v1+Enc-v1'].code, null);
  assert.deepEqual(r.cases['Id-v1+Enc-v1'].keys, { identity: 'tpm', encryption: 'tpm' });
  for (const k of ['Enc-v1', 'Id-v1', '']) assert.equal(r.cases[k].code, 'NODE_IDENTITY_KEY_MISSING', k);
  assert.deepEqual(r.cases['Enc-v1'].missing, ['Id-v1']);
});

// Fable ruling 11-21 "r5 a2 points" 3, as ruling "r5 node key" 3.3 (T3) restates it: the launcher's check is the host preparation's
// rule (M5 accepts a TPM identity key only): both keys there and the identity key not in the TPM is NODE_IDENTITY_KEY_NOT_TPM; the
// encryption key may be in software (the layout of both nodes in service); a missing key is named first.
test('N7: both keys there but the identity key not in the TPM is NODE_IDENTITY_KEY_NOT_TPM; a software encryption key passes; a missing key comes first (the finder injected)', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(['Get-Key'], [], ['Test-NodeIdentityKeys'])}
if ($Missing.Count) { ConvertTo-Json -Compress -InputObject ([ordered]@{ missing = $Missing }); return }
$names = [ordered]@{ identity = 'Id-v1'; encryption = 'Enc-v1' }
$cases = [ordered]@{}
foreach ($c in @(@('tpm', @{ 'Id-v1' = 'tpm'; 'Enc-v1' = 'tpm' }), @('inService', @{ 'Id-v1' = 'tpm'; 'Enc-v1' = 'software' }), @('softwareIdentity', @{ 'Id-v1' = 'software'; 'Enc-v1' = 'tpm' }),
    @('bothSoftware', @{ 'Id-v1' = 'software'; 'Enc-v1' = 'software' }), @('missingAndSoftware', @{ 'Enc-v1' = 'software' }))) {
  $have = $c[1]
  $finder = { param($n) if ($have.ContainsKey($n)) { @{ key = $null; origin = $have[$n] } } else { $null } }.GetNewClosure()
  $cases[$c[0]] = Test-NodeIdentityKeys $names $finder
}
ConvertTo-Json -Depth 5 -Compress -InputObject ([ordered]@{ missing = $Missing; cases = $cases })`);
  assert.deepEqual(r.missing, [], 'the launcher has the rule');
  assert.equal(r.cases.tpm.code, null);
  assert.equal(r.cases.inService.code, null, JSON.stringify(r.cases.inService));
  assert.deepEqual(r.cases.inService.keys, { identity: 'tpm', encryption: 'software' });
  assert.equal(r.cases.softwareIdentity.code, 'NODE_IDENTITY_KEY_NOT_TPM');
  assert.equal(r.cases.bothSoftware.code, 'NODE_IDENTITY_KEY_NOT_TPM');
  assert.deepEqual(r.cases.softwareIdentity.keys, { identity: 'software', encryption: 'tpm' }, 'the report keeps each origin');
  assert.equal(r.cases.missingAndSoftware.code, 'NODE_IDENTITY_KEY_MISSING');
});

test('N7: the launcher reads the keys with the pinned registration script\'s own names and finder, and a first install\'s preflight refuses a node without them', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-n7-');
  const regSha = crypto.createHash('sha256').update(fs.readFileSync(REG)).digest('hex');
  const cred = path.join(dir, 'credentials'); fs.mkdirSync(cred);
  const r = ps(`${PRELUDE}
${load(['Get-Key', 'Sha256Bytes', 'Write-New', 'Write-Json', 'Step-FirstInstallPreflight'], ['U8', 'Strict8'], ['Test-NodeIdentityKeys', 'Get-NodeIdentityKeyCheck', 'Get-FirstInstallResidue', 'Test-FirstInstallResiduePresent'])}
$real = $null; $changed = $null
if ($Missing -notcontains 'Get-NodeIdentityKeyCheck') {
  $FirstInstallRegistrationScript = ${psLiteral(REG)}; $FirstInstallRegistrationScriptSha256 = ${psLiteral(regSha)}
  $real = Get-NodeIdentityKeyCheck
  $FirstInstallRegistrationScriptSha256 = ('0' * 64)
  $changed = Get-NodeIdentityKeyCheck
  # the first install's preflight with the reading stood in: keys missing (what a host whose preparation made none has)
  function Get-NodeIdentityKeyCheck { [ordered]@{ keys = [ordered]@{ identity = $null; encryption = $null }; missing = @('Clued-CI-Node-Identity-v1', 'Clued-CI-Node-Encryption-v1'); code = 'NODE_IDENTITY_KEY_MISSING' } }
}
$Out = ${psLiteral(dir)}; $ResidentRoot = Join-Path $Out 'no-resident'; $FleetFirstInstallDirectory = ${psLiteral(cred)}
$Done = New-Object Collections.Generic.List[string]
function Get-Service { param([string[]]$Name, $ErrorAction) }
try { Step-FirstInstallPreflight } catch { if (-not $script:stopped) { throw } }
$report = Get-Content -LiteralPath (Join-Path $Out 'first-install-preflight-report.json') -Raw | ConvertFrom-Json
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ missing = $Missing; real = $real; changed = $changed; stopped = $script:stopped; codes = @($report.codes) })`);
  assert.deepEqual(r.missing, [], 'the launcher reads the keys');
  // on this machine the keys may be there or not, readable unelevated or not: the reading itself is what is held here
  assert.ok([null, 'NODE_IDENTITY_KEY_MISSING', 'NODE_IDENTITY_KEY_UNREADABLE'].includes(r.real.code), JSON.stringify(r.real));
  if (r.real.code !== 'NODE_IDENTITY_KEY_UNREADABLE') assert.deepEqual(Object.keys(r.real.keys), ['identity', 'encryption'], 'the script\'s own two names');
  assert.equal(r.changed.code, 'NODE_REGISTRATION_SCRIPT_CHANGED', 'only the pinned bytes are read');
  assert.ok(r.codes.includes('NODE_IDENTITY_KEY_MISSING'), JSON.stringify(r));
});

// ---------------------------------------------------------------- N9
// The launcher's evidence reading (Test-TerminalEvidence, as every launcher, continuation and finish uses it) over a root under TEMP, and
// the one rule (Test-LedgerEvidence) the uninstall's after-check uses too.
test('N9: a launcher pinned to an empty ledger accepts exactly an empty ledger; the pinned terminal entry otherwise, as before', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-n9-');
  const mk = (name, entries = [], backfill = []) => {
    const root = path.join(dir, name);
    fs.mkdirSync(path.join(root, 'state', 'ledger'), { recursive: true });
    for (const e of entries) fs.mkdirSync(path.join(root, 'state', 'ledger', e));
    for (const e of backfill) fs.mkdirSync(path.join(root, 'state', 'backfill', '3', 'ledger', e), { recursive: true });
    return root;
  };
  const roots = { empty: mk('empty'), open: mk('open', [HEX('b')]), backfill: mk('backfill', [], [HEX('c')]), none: path.join(dir, 'none') };
  fs.mkdirSync(path.join(roots.none, 'state'), { recursive: true });
  const terminal = mk('terminal', [HEX('a')]); fs.writeFileSync(path.join(terminal, 'state', 'ledger', HEX('a'), '90-terminal.json'), '{"outcome":"COMPLETED"}');
  const terminalSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(terminal, 'state', 'ledger', HEX('a'), '90-terminal.json'))).digest('hex');
  const r = ps(`${PRELUDE}
${load(['Sha256Bytes', 'Get-FileSha', 'Test-TerminalEvidence'], [], ['Test-LedgerEvidence', 'Get-LedgerEntryNames'])}
$LedgerEvidenceRelativeDirectory = 'state\\ledger'; $BackfillEvidenceManifestSha256 = $null; $InstalledReceiptSha256 = $null
$LedgerEmptyAtGeneration = $true; $HaltedBatchKey = $null; $TerminalEvidenceSha256 = $null
$empty = [ordered]@{}
foreach ($k in @('empty', 'open', 'backfill', 'none')) { $empty[$k] = Test-TerminalEvidence (@{ empty = ${psLiteral(roots.empty)}; open = ${psLiteral(roots.open)}; backfill = ${psLiteral(roots.backfill)}; none = ${psLiteral(roots.none)} })[$k] }
$LedgerEmptyAtGeneration = $false; $HaltedBatchKey = ${psLiteral(HEX('a'))}; $TerminalEvidenceSha256 = ${psLiteral(terminalSha)}
$pinned = [ordered]@{ terminal = (Test-TerminalEvidence ${psLiteral(terminal)}); empty = (Test-TerminalEvidence ${psLiteral(roots.empty)}) }
$rule = $null
if ($Missing -notcontains 'Test-LedgerEvidence') {
  $rule = [ordered]@{
    emptyEmpty = (Test-LedgerEvidence $true $null $null @()); emptyOne = (Test-LedgerEvidence $true $null $null @(${psLiteral(HEX('a'))})); emptyUnread = (Test-LedgerEvidence $true $null $null $null)
    emptyButKey = (Test-LedgerEvidence $true ${psLiteral(HEX('a'))} $null @())
    keyThere = (Test-LedgerEvidence $false ${psLiteral(HEX('a'))} ${psLiteral(terminalSha)} @(${psLiteral(HEX('b'))}, ${psLiteral(HEX('a'))})); keyNot = (Test-LedgerEvidence $false ${psLiteral(HEX('a'))} ${psLiteral(terminalSha)} @(${psLiteral(HEX('b'))}))
    noKey = (Test-LedgerEvidence $false $null $null @()) }
}
# the uninstall's after-check: the kept ledger is judged by that rule, not by "contains the pinned key" alone
$step = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Step-Uninstall' }, $true))[0].Extent.Text
$check = @($step -split "\`n" | Where-Object { $_.Contains("Stop-Launch 'UNINSTALL_EVIDENCE_OR_DELETION_UNCONFIRMED'") })
ConvertTo-Json -Depth 5 -Compress -InputObject ([ordered]@{ missing = $Missing; empty = $empty; pinned = $pinned; rule = $rule; check = $check })`);
  assert.deepEqual(r.empty, { empty: true, open: false, backfill: false, none: false }, 'pinned empty: only a ledger that is still empty');
  assert.deepEqual(r.pinned, { terminal: true, empty: false }, 'pinned to an entry: as before');
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.rule, { emptyEmpty: true, emptyOne: false, emptyUnread: false, emptyButKey: false, keyThere: true, keyNot: false, noKey: false });
  assert.equal(r.check.length, 1);
  assert.match(r.check[0], /-not \(Test-LedgerEvidence \(\$LedgerEmptyAtGeneration -eq \$true\) \$HaltedBatchKey \$TerminalEvidenceSha256 \$e\.ledgerEntries\)/);
  assert.doesNotMatch(r.check[0], /-notcontains \$HaltedBatchKey/);
});

// ---------------------------------------------------------------- X2
// The real Step-Preflight of a first install, everything around it a stand-in that passes; the installer's dry run (install.dry-run) is
// the one thing varied: its preflight block's controllerServiceLogonRight.
const PREFLIGHT = (dir, logon) => `${PRELUDE}
${load(['Get-Key', 'Parse-Json', 'Parse-LastLine', 'Tail', 'Write-New', 'Write-Json', 'Step-Preflight'], ['U8'], ['Test-ControllerLogonRightRefused'])}
$Out = ${psLiteral(dir)}; $Stage = $Out; $Spool = Join-Path $Out 'spool'; [void][IO.Directory]::CreateDirectory((Join-Path $Spool 'outgoing'))
$ResidentRoot = Join-Path $Out 'resident'; $FleetFirstInstall = $true; $Done = New-Object Collections.Generic.List[string]
$ResidentSid = 'S-1-5-80-1'; $OperatorSid = 'S-1-5-21-1-2-3-1000'; $ControllerSid = 'S-1-5-21-1-2-3-1007'; $PlanSha256 = ('9' * 64); $ExactAclReadbackGuard = $false
$Staged = [ordered]@{ 'install-resident.ps1' = @('x', ('8' * 64)) }
function Get-RunnerState { [ordered]@{ ok = $true } }
function Get-Absences { [ordered]@{ residentRoot = $true; services = $true } }
function Get-SpoolBaseline($model, $root) { [ordered]@{ code = $null; missing = @() } }
function Get-SpoolLeftovers($spool) { [ordered]@{} }
function Get-SpoolRemainder($spool, $found) { , @() }
function Test-AclMissingTargetAccepted { $true }
function Test-TokenPlan($stdout) { [ordered]@{ codes = @() } }
function Get-InstallArgs([switch]$Apply, [switch]$NoToken, [switch]$NoHeartbeat) { , @() }
function Invoke-Child([string]$name, [string]$file, [string[]]$argList) {
  if ($name -ceq 'install.dry-run') {
    $doc = [ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = ('9' * 64); plan = [ordered]@{ installScriptSha256 = ('8' * 64); residentSid = 'S-1-5-80-1'; rootExists = $false; servicesExist = $false; openBatches = 0 }; carryForwardPreview = @() }
    ${logon === undefined ? '' : `$doc['preflight'] = [ordered]@{ controllerServiceLogonRight = ${logon} }`}
    return [ordered]@{ exit = 0; stdout = ($doc | ConvertTo-Json -Depth 6); stderr = '' }
  }
  [ordered]@{ exit = 0; stdout = '{"status":"SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN"}'; stderr = '' }
}
try { $null = Step-Preflight } catch { if (-not $script:stopped) { throw } }
$report = Get-Content -LiteralPath (Join-Path $Out 'preflight-report.json') -Raw | ConvertFrom-Json
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ stopped = $script:stopped; codes = @($report.codes); done = @($Done) })`;

test('X2: the install preflight refuses a dry run that says the controller may not log on as a service', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-x2-');
  const code = 'CONTROLLER_SERVICE_LOGON_RIGHT_NOT_CONFIRMED';
  const run = (name, logon) => { const d = path.join(dir, name); fs.mkdirSync(d); return ps(PREFLIGHT(d, logon)); };
  const no = run('false', '$false');
  assert.deepEqual({ stopped: no.stopped, codes: no.codes }, { stopped: code, codes: [code] });
  const unreadable = run('unreadable', "'unreadable'");
  assert.deepEqual({ stopped: unreadable.stopped, codes: unreadable.codes }, { stopped: code, codes: [code] });
  const yes = run('true', '$true');
  assert.deepEqual({ stopped: yes.stopped, codes: yes.codes, done: yes.done }, { stopped: null, codes: [], done: ['preflight'] });
  const older = run('older', undefined);   // an installer with no preflight block says nothing about it (older installers): not refused
  assert.deepEqual({ stopped: older.stopped, codes: older.codes }, { stopped: null, codes: [] });
});
