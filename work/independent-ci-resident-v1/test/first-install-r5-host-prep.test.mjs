// Fable ruling 11-21 "r5 preflight gaps" (D:/w/tmp/FABLE-r5-preflight-gaps-20261121.md), the host preparation group, each part held by
// a test that failed before it:
//   baseline  section 3.2: the host preparation makes LocalMachine's execution policy RemoteSigned when it is Undefined, Restricted or
//             AllSigned (the value the frozen Source runs under on every node: held-record.mjs starts Windows PowerShell with its own
//             environment and no -ExecutionPolicy), leaves RemoteSigned, Unrestricted and Bypass alone, refuses a group policy that
//             enforces Restricted or AllSigned, and proves the result at once with a probe started the way held-record.mjs starts its
//             helper (HOST_EXECUTION_POLICY_NOT_EFFECTIVE when it does not run). Section 3.3: the table, the value written (to a
//             temporary key under HKCU: nothing of this machine's policy is changed) and the probe's shape run for real here (DESK is
//             RemoteSigned);
//   N7        section 2.2: the package carries registration/export-node-registration.ps1, and the host preparation decides with the
//             script's own Find-MachineKey: both keys there and TPM -> kept; none -> init-keys -KeyProvider tpm; one, not TPM, not
//             readable -> refused; no usable TPM -> refused before anything is written;
//   X3        section 2.5: install-resident.ps1's source-v2-acl step throws SOURCE_V2_ACL_MIGRATION_REFUSED with migrate-acl's own code.
// Real files only: functions and statements taken by AST from windows/first-install-host.ps1 and windows/install-resident.ps1, the real
// registration script, the real selectTree on this checkout's index. No machine key is created or opened for writing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as U from '../rollout/fleet/universal.mjs';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = path.resolve(RES, '..', '..');
const HOST = path.join(RES, 'windows', 'first-install-host.ps1');
const INSTALL = path.join(RES, 'windows', 'install-resident.ps1');
const REGISTRATION = path.join(RES, 'registration', 'export-node-registration.ps1');
const HELD_RECORD = path.resolve(RES, '..', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2', 'held-record.mjs');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// One Windows PowerShell 5.1 run of `command` (process scope Bypass, as every start of the package); its last stdout line is JSON.
function ps(command) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}

// The named functions and top-level assignments of a real file, dot-sourced into the script scope.
const load = (file, fns = [], vars = []) => `$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(file)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ('PARSE_ERRORS:' + ${psLiteral(path.basename(file))}) }
foreach ($name in @(${fns.map(psLiteral).join(', ') || "''"})) { if (-not $name) { continue }
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
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
Add-Type -AssemblyName System.Core
`;
const POLICY_FNS = ['Get-Key', 'Get-ExecutionPolicyCheck', 'Get-ExecutionPolicyBaseline', 'Set-ExecutionPolicyValue', 'Get-PolicyProbeStart', 'Invoke-PolicyProbe',
  'Get-PolicyProbeResult', 'Invoke-ExecutionPolicyBaseline'];
// The main flow's text (Invoke-HostPreparation), for the order of its steps.
const mainFlow = () => { const text = fs.readFileSync(HOST, 'utf8'); return text.slice(text.indexOf('function Invoke-HostPreparation')); };

// ---------------------------------------------------------------- the execution policy baseline
test('baseline: LocalMachine Undefined, Restricted, AllSigned -> RemoteSigned; RemoteSigned, Unrestricted, Bypass kept; a group policy that enforces is refused', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(HOST, POLICY_FNS)}
$list = { param($machine, $user, $lm) foreach ($s in @(@('MachinePolicy', $machine), @('UserPolicy', $user), @('Process', 'Bypass'), @('CurrentUser', 'Undefined'), @('LocalMachine', $lm))) { [pscustomobject]@{ Scope = $s[0]; ExecutionPolicy = $s[1] } } }
$cases = [ordered]@{}
foreach ($lm in @('Undefined', 'Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass')) { $b = Get-ExecutionPolicyBaseline (& $list 'Undefined' 'Undefined' $lm); $cases[$lm] = [ordered]@{ action = $b.action; code = $b.code } }
foreach ($gp in @(@('AllSigned', 'Undefined'), @('Undefined', 'Restricted'))) { $b = Get-ExecutionPolicyBaseline (& $list $gp[0] $gp[1] 'Restricted'); $cases['gp:' + ($gp -join '/')] = [ordered]@{ action = $b.action; code = $b.code } }
$b = Get-ExecutionPolicyBaseline (& $list 'RemoteSigned' 'Undefined' 'Restricted'); $cases['gp:RemoteSigned'] = [ordered]@{ action = $b.action; code = $b.code }
ConvertTo-Json -Depth 4 -Compress -InputObject $cases`);
  const set = { action: 'set', code: null }, keep = { action: 'keep', code: null }, refused = { action: null, code: 'HOST_EXECUTION_POLICY_ENFORCED_BY_POLICY' };
  assert.deepEqual(r, { Undefined: set, Restricted: set, AllSigned: set, RemoteSigned: keep, Unrestricted: keep, Bypass: keep,
    'gp:AllSigned/Undefined': refused, 'gp:Undefined/Restricted': refused, 'gp:RemoteSigned': set });
});

// Section 3.3 "the value written": the writer's registry place is a parameter; here a temporary key under HKCU, written and read back,
// then removed. That the place the host preparation passes is the one Windows PowerShell reads for LocalMachine is read (never written)
// on this machine: the 64-bit registry value equals Get-ExecutionPolicy -Scope LocalMachine.
test('baseline: the writer puts RemoteSigned where it is told (a temporary HKCU key), and the host passes the key PowerShell reads for LocalMachine', { skip, timeout: 300_000 }, () => {
  const sub = `Software\\Clued-r5-policy-test-${process.pid}-${Date.now()}\\ShellIds\\Microsoft.PowerShell`;
  const root = sub.split('\\').slice(0, 2).join('\\');
  const r = ps(`${PRELUDE}
${load(HOST, POLICY_FNS, ['ExecutionPolicyKey'])}
$cu = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
try {
  $written = Set-ExecutionPolicyValue 'CurrentUser' ${psLiteral(sub)} 'RemoteSigned'
  $k = $cu.OpenSubKey(${psLiteral(sub)}); $read = [string]$k.GetValue('ExecutionPolicy'); $kind = [string]$k.GetValueKind('ExecutionPolicy'); $k.Dispose()
} finally { $cu.DeleteSubKeyTree(${psLiteral(root)}, $false) }
$gone = $null -eq $cu.OpenSubKey(${psLiteral(root)}); $cu.Dispose()
$lm = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$lk = $lm.OpenSubKey($ExecutionPolicyKey); $machine = if ($lk) { [string]$lk.GetValue('ExecutionPolicy') } else { '' }; if ($lk) { $lk.Dispose() }; $lm.Dispose()
$calls = @(@($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Invoke-ExecutionPolicyBaseline' }, $true)) | ForEach-Object { $_.Extent.Text })
ConvertTo-Json -Compress -InputObject ([ordered]@{ written = $written; read = $read; kind = $kind; gone = $gone; key = $ExecutionPolicyKey
  machineRegistry = $machine; machineCmdlet = [string](Get-ExecutionPolicy -Scope LocalMachine); calls = $calls })`);
  assert.deepEqual({ written: r.written, read: r.read, kind: r.kind, gone: r.gone }, { written: 'RemoteSigned', read: 'RemoteSigned', kind: 'String', gone: true });
  assert.equal(r.key, 'SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell');
  assert.equal(r.machineRegistry || 'Undefined', r.machineCmdlet, 'the key the host writes is the one Windows PowerShell reads for LocalMachine');
  assert.equal(r.calls.length, 1, JSON.stringify(r.calls));
  assert.match(r.calls[0], /^Invoke-ExecutionPolicyBaseline \(Get-ExecutionPolicy -List\) 'LocalMachine' \$ExecutionPolicyKey /);
});

// The probe is started the way held-record.mjs starts hold-record.ps1: the same executable, the same arguments before the script, the same
// seven environment variables (nothing else), no -ExecutionPolicy. Read from held-record.mjs's own text, so the two cannot drift apart.
test('baseline: the probe is held-record.mjs\'s start (executable, arguments, the seven variables), and it runs here under the machine\'s policy, not the parent\'s', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-probe-');
  const held = fs.readFileSync(HELD_RECORD, 'utf8');
  const m = held.match(/spawn\('([^']+)', \[([^\]]*)\],\s*\{[^}]*env: \{ ([^}]*) \}/);
  assert.ok(m, 'held-record.mjs starts PowerShell as this test reads it');
  const heldExe = m[1].replaceAll('\\\\', '\\');
  const heldArgs = [...m[2].matchAll(/'([^']*)'|(\w+)/g)].map(x => x[1] ?? `<${x[2]}>`);
  const heldEnv = [...m[3].matchAll(/(\w+): (?:'([^']*)'|(\w+))/g)].map(x => [x[1], x[2] !== undefined ? x[2].replaceAll('\\\\', '\\') : `<${x[3]}>`]);
  const r = ps(`${PRELUDE}
${load(HOST, POLICY_FNS, ['PowerShellExe'])}
$probe = Join-Path ${psLiteral(dir)} 'probe.ps1'
$start = Get-PolicyProbeStart $PowerShellExe $probe ${psLiteral(dir)}
$run = Invoke-PolicyProbe $start
$res = Get-PolicyProbeResult $run
# what the probe's child should see: the first defined of the group policies, CurrentUser and LocalMachine (no process scope reaches it)
$scopes = [ordered]@{}; foreach ($e in @(Get-ExecutionPolicy -List)) { $scopes[[string]$e.Scope] = [string]$e.ExecutionPolicy }
$want = 'Restricted'; foreach ($s in @('MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine')) { if ($scopes[$s] -cne 'Undefined') { $want = $scopes[$s]; break } }
ConvertTo-Json -Depth 5 -Compress -InputObject ([ordered]@{ file = $start.file; arguments = @($start.arguments); environment = @($start.environment.Keys | ForEach-Object { , @($_, $start.environment[$_]) })
  parent = [string](Get-ExecutionPolicy); run = $run; result = $res; want = $want; probeExists = [IO.File]::Exists($probe) })`);
  assert.equal(r.file, heldExe);
  assert.deepEqual(r.arguments.slice(0, -1), heldArgs.slice(0, -1), 'the options before the script');
  assert.equal(r.arguments.at(-1), path.join(dir, 'probe.ps1'));
  assert.ok(!r.arguments.some(a => /ExecutionPolicy/i.test(a)), 'no -ExecutionPolicy');
  const temp = new Set(heldEnv.filter(([, v]) => v.startsWith('<')).map(([k]) => k));
  assert.deepEqual(r.environment.map(([k]) => k), heldEnv.map(([k]) => k), 'the same seven variables, in the same order');
  for (const [k, v] of r.environment) assert.equal(v, temp.has(k) ? dir : Object.fromEntries(heldEnv)[k], k);
  assert.equal(r.parent, 'Bypass');
  assert.deepEqual({ exit: r.run.exit, stderr: r.run.stderr, timedOut: r.run.timedOut }, { exit: 0, stderr: '', timedOut: false }, JSON.stringify(r.run));
  assert.deepEqual(r.result, { code: null, effective: r.want }, 'the probe reports the machine\'s policy, not its parent\'s Bypass');
  assert.notEqual(r.want, 'Bypass');
});

test('baseline: a probe that did not run, wrote to stderr or printed something else is HOST_EXECUTION_POLICY_NOT_EFFECTIVE', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(HOST, POLICY_FNS)}
$denied = 'File C:\\x\\probe.ps1 cannot be loaded because running scripts is disabled on this system.'
$cases = [ordered]@{
  ok = Get-PolicyProbeResult ([ordered]@{ exit = 0; stdout = "CLUED_EXECUTION_POLICY_PROBE RemoteSigned\`r\`n"; stderr = ''; timedOut = $false })
  restricted = Get-PolicyProbeResult ([ordered]@{ exit = 1; stdout = ''; stderr = $denied; timedOut = $false })
  stderr = Get-PolicyProbeResult ([ordered]@{ exit = 0; stdout = 'CLUED_EXECUTION_POLICY_PROBE RemoteSigned'; stderr = 'a warning'; timedOut = $false })
  other = Get-PolicyProbeResult ([ordered]@{ exit = 0; stdout = 'hello'; stderr = ''; timedOut = $false })
  timeout = Get-PolicyProbeResult ([ordered]@{ exit = $null; stdout = ''; stderr = ''; timedOut = $true }) }
ConvertTo-Json -Depth 4 -Compress -InputObject $cases`);
  const no = { code: 'HOST_EXECUTION_POLICY_NOT_EFFECTIVE', effective: null };
  assert.deepEqual(r, { ok: { code: null, effective: 'RemoteSigned' }, restricted: no, stderr: no, other: no, timeout: no });
});

// The whole step as the host runs it, the registry place a temporary HKCU key: "set" writes RemoteSigned there and the probe then proves it;
// "keep" writes nothing; a group policy is refused before anything is written. Before and after lists go into the step's detail.
test('baseline: the step writes only when it must, then proves the result with the probe; a refusal writes nothing', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-step-');
  const sub = `Software\\Clued-r5-policy-step-${process.pid}-${Date.now()}`;
  const r = ps(`${PRELUDE}
${load(HOST, POLICY_FNS, ['PowerShellExe'])}
$list = { param($machine, $lm) foreach ($s in @(@('MachinePolicy', $machine), @('UserPolicy', 'Undefined'), @('Process', 'Undefined'), @('CurrentUser', 'Undefined'), @('LocalMachine', $lm))) { [pscustomobject]@{ Scope = $s[0]; ExecutionPolicy = $s[1] } } }
$cu = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
$val = { param($k) $x = $cu.OpenSubKey($k); if ($null -eq $x) { return '<no key>' }; try { [string]$x.GetValue('ExecutionPolicy') } finally { $x.Dispose() } }
$out = [ordered]@{}
try {
  foreach ($c in @(@('set', 'Undefined', 'Restricted'), @('keep', 'Undefined', 'RemoteSigned'), @('refused', 'AllSigned', 'Restricted'))) {
    $key = ${psLiteral(sub)} + '\\' + $c[0]
    $s = Invoke-ExecutionPolicyBaseline (& $list $c[1] $c[2]) 'CurrentUser' $key ${psLiteral(dir)} $PowerShellExe
    $out[$c[0]] = [ordered]@{ action = $s.action; code = $s.code; written = $s.written; stored = (& $val $key); before = $s.before.LocalMachine
      after = $(if ($s.after) { @($s.after.Keys) } else { $null }); probe = $s.probe }
  }
} finally { $cu.DeleteSubKeyTree(${psLiteral(sub)}, $false); $cu.Dispose() }
ConvertTo-Json -Depth 6 -Compress -InputObject $out`);
  const scopes = ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'];
  assert.deepEqual({ ...r.set, probe: r.set.probe?.code }, { action: 'set', code: null, written: 'RemoteSigned', stored: 'RemoteSigned', before: 'Restricted', after: scopes, probe: null });
  assert.ok(r.set.probe.effective, JSON.stringify(r.set.probe));
  assert.deepEqual({ ...r.keep, probe: r.keep.probe?.code }, { action: 'keep', code: null, written: null, stored: '<no key>', before: 'RemoteSigned', after: scopes, probe: null });
  assert.deepEqual(r.refused, { action: null, code: 'HOST_EXECUTION_POLICY_ENFORCED_BY_POLICY', written: null, stored: '<no key>', before: 'Restricted', after: null, probe: null });
});

test('baseline: the step runs after the read-only policy step, the operator and the residue check, and before the host\'s first write', { skip }, () => {
  const main = mainFlow();
  const at = s => { const i = main.indexOf(s); assert.ok(i >= 0, s); return i; };
  const read = at("Enter-Step 'execution-policy'"), operator = at("Enter-Step 'operator'"), residue = at("Enter-Step 'residue'");
  const step = at("Enter-Step 'execution-policy-baseline'"), call = at('Invoke-ExecutionPolicyBaseline (Get-ExecutionPolicy -List)');
  const refuse = at("Stop-Host 'HOST_EXECUTION_POLICY_NOT_EFFECTIVE'"), stage = at("Enter-Step 'stage'"), firstWrite = at('New-Dir ');
  assert.ok(read < operator && operator < residue && residue < step && step < call && call < refuse && refuse < stage, JSON.stringify({ read, operator, residue, step, call, refuse, stage }));
  assert.ok(step < firstWrite, 'nothing is written before the baseline step');
});

// ---------------------------------------------------------------- N7: the node's identity keys
test('N7: the package carries registration/export-node-registration.ps1 (selectTree on this checkout)', async () => {
  const out = spawnSync('git', ['-C', CHECKOUT, 'ls-files', '-s', '-z'], { maxBuffer: 1 << 28 });
  assert.equal(out.status, 0, String(out.stderr));
  const listing = new Map();
  for (const rec of out.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [mode, oid] = rec.slice(0, tab).split(' ');
    listing.set(rec.slice(tab + 1), { mode, oid });
  }
  const read = async paths => new Map(await Promise.all(paths.map(async p => [p, await fsp.readFile(path.join(CHECKOUT, ...p.split('/')))])));
  const selected = await U.selectTree(listing, read);
  assert.ok(selected.includes('work/independent-ci-resident-v1/registration/export-node-registration.ps1'));
  assert.ok(U.TREE_FILES.includes('work/independent-ci-resident-v1/registration/export-node-registration.ps1'), 'named, not reached by a prefix');
});

test('N7: both keys in the TPM -> kept; none -> created; one, software, invalid or unreadable -> refused; none without a usable TPM -> refused', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(HOST, ['Get-Key', 'Get-NodeKeyPlan'])}
$tpm = [ordered]@{ origin = 'tpm'; valid = $true }; $sw = [ordered]@{ origin = 'software'; valid = $true }; $bad = [ordered]@{ origin = 'tpm'; valid = $false }
$cases = [ordered]@{
  both = @($tpm, $tpm, $true); bothNoTpmNow = @($tpm, $tpm, $false); none = @($null, $null, $true); noneNoTpm = @($null, $null, $false)
  identityOnly = @($tpm, $null, $true); encryptionOnly = @($null, $tpm, $true); software = @($tpm, $sw, $true); invalid = @($bad, $tpm, $true)
  unreadable = @('unreadable', $tpm, $true) }
$out = [ordered]@{}
foreach ($k in @($cases.Keys)) { $p = Get-NodeKeyPlan ([ordered]@{ identity = $cases[$k][0]; encryption = $cases[$k][1]; tpmUsable = $cases[$k][2] }); $out[$k] = [ordered]@{ action = $p.action; code = $p.code } }
ConvertTo-Json -Depth 4 -Compress -InputObject $out`);
  const refused = code => ({ action: null, code });
  assert.deepEqual(r, { both: { action: 'present', code: null }, bothNoTpmNow: { action: 'present', code: null }, none: { action: 'create', code: null },
    noneNoTpm: refused('HOST_TPM_NOT_USABLE'), identityOnly: refused('HOST_NODE_KEY_INCOMPLETE'), encryptionOnly: refused('HOST_NODE_KEY_INCOMPLETE'),
    software: refused('HOST_NODE_KEY_NOT_TPM'), invalid: refused('HOST_NODE_KEY_INVALID'), unreadable: refused('HOST_NODE_KEY_UNREADABLE') });
});

// The observation is the registration script's own Find-MachineKey (loaded from the packaged script, never a copy), read-only. Here with
// two names no machine has: both absent, and whether the TPM provider answers.
test('N7: the observation runs the registration script\'s own Find-MachineKey, read-only', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(HOST, ['Get-Key', 'Get-NodeKeyObservation', 'Get-NodeKeyPlan'])}
$names = [ordered]@{ identity = ('Clued-r5-test-absent-' + [Guid]::NewGuid().ToString('N')); encryption = ('Clued-r5-test-absent-' + [Guid]::NewGuid().ToString('N')) }
$o = Get-NodeKeyObservation ${psLiteral(REGISTRATION)} $names
$p = Get-NodeKeyPlan $o
ConvertTo-Json -Depth 4 -Compress -InputObject ([ordered]@{ identity = $o.identity; encryption = $o.encryption; tpmUsable = $o.tpmUsable; action = $p.action
  failDefined = [bool](Get-Command Fail -CommandType Function -ErrorAction SilentlyContinue); findDefined = [bool](Get-Command Find-MachineKey -CommandType Function -ErrorAction SilentlyContinue) })`);
  assert.deepEqual({ identity: r.identity, encryption: r.encryption }, { identity: null, encryption: null });
  assert.equal(typeof r.tpmUsable, 'boolean');
  assert.equal(r.action, r.tpmUsable ? 'create' : null);
  assert.deepEqual({ fail: r.failDefined, find: r.findDefined }, { fail: false, find: false }, 'the script\'s functions stay inside the observation (its Fail exits)');
});

// The whole key step with a stand-in registration script (the same parameters; its Find-MachineKey reads a state file, its init-keys
// writes it and records how it was called): none -> init-keys -ConfirmCreateKeys -KeyProvider tpm once, then present; present -> nothing
// called; one -> refused without a call; init-keys that leaves them absent -> HOST_NODE_KEY_NOT_CREATED.
test('N7: the key step creates with the packaged script only when both are absent, and holds the result to the same rule', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-keys-');
  const state = path.join(dir, 'state.json'), calls = path.join(dir, 'calls.txt'), fake = path.join(dir, 'export-node-registration.ps1');
  fs.writeFileSync(fake, `param([ValidateSet('export', 'init-keys')] [string]$Mode = 'export', [switch]$ConfirmCreateKeys, [ValidateSet('auto', 'tpm', 'software')] [string]$KeyProvider = 'auto')
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
function Fail([string]$Code, [string]$Detail) { [Console]::Error.WriteLine("\${Code}: $Detail"); exit 2 }
Add-Type -AssemblyName System.Core
$KeyNames = [ordered]@{ identity = 'Clued-CI-Node-Identity-v1'; encryption = 'Clued-CI-Node-Encryption-v1' }
$TpmProviderName = 'Microsoft Software Key Storage Provider'
$Magic = @{ identity = [uint32]0x31534345; encryption = [uint32]0x314B4345 }
function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function ConvertFrom-EccPublicBlob([byte[]]$Blob, [uint32]$ExpectedMagic) {
  if ($Blob.Length -ne 72) { throw "PUBLIC_KEY_INVALID: blob length $($Blob.Length)" }
  if ([BitConverter]::ToUInt32($Blob, 0) -ne $ExpectedMagic -or [BitConverter]::ToUInt32($Blob, 4) -ne 32) { throw 'PUBLIC_KEY_INVALID: magic' }
  [ordered]@{ kty = 'EC'; crv = 'P-256' }
}
function Get-Providers { $list = @(); $list += , @((New-Object System.Security.Cryptography.CngProvider $TpmProviderName), 'tpm'); $list }
function Find-MachineKey([string]$KeyName) {
  $s = if ([IO.File]::Exists(${psLiteral(state)})) { [IO.File]::ReadAllText(${psLiteral(state)}).Trim() } else { '' }
  $role = if ($KeyName -ceq $KeyNames.identity) { 'identity' } else { 'encryption' }
  if (@($s -split ',') -cnotcontains $role) { return $null }
  $blob = New-Object byte[] 72; [BitConverter]::GetBytes([uint32]$Magic[$role]).CopyTo($blob, 0); [BitConverter]::GetBytes([uint32]32).CopyTo($blob, 4)
  $export = { param($f) $blob }.GetNewClosure()
  $key = New-Object psobject; $key | Add-Member ScriptMethod Export $export; $key | Add-Member ScriptMethod Dispose { }
  @{ key = $key; origin = 'tpm' }
}
if ($Mode -eq 'init-keys') {
  [IO.File]::AppendAllText(${psLiteral(calls)}, ('init-keys confirm=' + [bool]$ConfirmCreateKeys + ' provider=' + $KeyProvider + ' policy=' + [string](Get-ExecutionPolicy -Scope Process) + "\`n"))
  if (-not [IO.File]::Exists(${psLiteral(path.join(dir, 'leave-absent'))})) { [IO.File]::WriteAllText(${psLiteral(state)}, 'identity,encryption') }
  '{"status":"created"}'
  exit 0
}
`);
  const r = ps(`${PRELUDE}
${load(HOST, ['Get-Key', 'Get-NodeKeyObservation', 'Get-NodeKeyPlan', 'Invoke-NodeKeyStep', 'Invoke-NativeChild'], ['PowerShellExe', 'Utf8'])}
function Invoke-Native([string]$exe, [string[]]$arguments, [int]$seconds = 3600, [Text.Encoding]$encoding = $Utf8, [bool]$shareConsole = $false, [byte[]]$stdin = $null) { Invoke-NativeChild $exe $arguments $seconds $encoding $shareConsole $stdin }
$state = ${psLiteral(state)}; $calls = ${psLiteral(calls)}
$read = { if ([IO.File]::Exists($calls)) { @([IO.File]::ReadAllLines($calls)) } else { @() } }
$out = [ordered]@{}
foreach ($c in @(@('none', ''), @('present', 'identity,encryption'), @('one', 'identity'), @('notCreated', ''))) {
  if ([IO.File]::Exists($calls)) { [IO.File]::Delete($calls) }
  if ($c[1]) { [IO.File]::WriteAllText($state, $c[1]) } elseif ([IO.File]::Exists($state)) { [IO.File]::Delete($state) }
  if ($c[0] -ceq 'notCreated') { [IO.File]::WriteAllText(${psLiteral(path.join(dir, 'leave-absent'))}, '') }
  $s = Invoke-NodeKeyStep ${psLiteral(fake)} $PowerShellExe
  $out[$c[0]] = [ordered]@{ action = $s.action; code = $s.code; identity = (Get-Key $s.after 'identity'); calls = @(& $read) }
}
ConvertTo-Json -Depth 6 -Compress -InputObject $out`);
  const tpm = { origin: 'tpm', valid: true };
  assert.deepEqual(r.none, { action: 'created', code: null, identity: tpm, calls: ['init-keys confirm=True provider=tpm policy=Bypass'] });
  assert.deepEqual(r.present, { action: 'present', code: null, identity: null, calls: [] });
  assert.deepEqual(r.one, { action: null, code: 'HOST_NODE_KEY_INCOMPLETE', identity: null, calls: [] });
  assert.deepEqual(r.notCreated, { action: null, code: 'HOST_NODE_KEY_NOT_CREATED', identity: null, calls: ['init-keys confirm=True provider=tpm policy=Bypass'] });
});

test('N7: the host checks the keys before its first write and creates them after the accounts, before the credentials, from the packaged script', { skip }, () => {
  const main = mainFlow();
  const at = s => { const i = main.indexOf(s); assert.ok(i >= 0, s); return i; };
  const v1 = at("Enter-Step 'v1-base'"), check = at("Enter-Step 'node-key-check'"), wsl = at("Enter-Step 'wsl'");
  const accounts = at("Enter-Step 'accounts'"), step = at("Enter-Step 'node-key'\n"), credentials = at("Enter-Step 'credentials'");
  assert.ok(v1 < check && check < wsl && accounts < step && step < credentials, JSON.stringify({ v1, check, wsl, accounts, step, credentials }));
  assert.ok(main.includes("$NodeKeyScript = Join-Path $R 'registration\\export-node-registration.ps1'"), 'the packaged script, from the archive\'s tree');
  const text = fs.readFileSync(HOST, 'utf8');
  const fn = text.slice(text.indexOf('function Invoke-NodeKeyStep'));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /'-ExecutionPolicy', 'Bypass', '-File', \$registrationScript, '-Mode', 'init-keys', '-ConfirmCreateKeys', '-KeyProvider', 'tpm'/);
});

// ---------------------------------------------------------------- X3
// The real source-v2-acl step of install-resident.ps1, run with a stand-in migrate-acl.ps1 at the place the step computes, which prints
// what migrate-acl.ps1 prints on a refusal (one JSON line with its code) and exits 2.
test('X3: source-v2-acl throws SOURCE_V2_ACL_MIGRATION_REFUSED with migrate-acl\'s own code', { skip, timeout: 300_000 }, (t) => {
  const root = tempDir(t, 'r5-x3-');
  const sha = 'c'.repeat(64);
  const toolDir = path.join(root, 'source', sha, 'work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2');
  fs.mkdirSync(toolDir, { recursive: true });
  const mode = path.join(root, 'mode.txt');
  fs.writeFileSync(path.join(toolDir, 'migrate-acl.ps1'), `param([switch]$Apply, [string]$ResidentSid, [string]$OwnerSid, [string]$ControllerSid)
$m = [IO.File]::ReadAllText(${psLiteral(mode)}).Trim()
switch ($m) {
  'refused' { '{"contract":"clued.independent-ci.resident-acl-migration/1","status":"REFUSED","apply":true,"steps":[],"code":"ACL_TARGET_MISSING","exceptionType":"RuntimeException"}'; exit 2 }
  'garbage' { 'not json'; exit 2 }
  'odd' { '{"status":"REFUSED","code":"no such code; rm -rf"}'; exit 2 }
  default { '{"contract":"clued.independent-ci.resident-acl-migration/1","status":"SOURCE_V2_ACL_MIGRATED","apply":true,"steps":[],"code":null}'; exit 0 }
}
`);
  const r = ps(`${PRELUDE}
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(INSTALL)}, [ref]$tokens, [ref]$errors)
$step = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -eq 3 -and $n.CommandElements[1].Extent.Text -ceq "'source-v2-acl'" }, $true))
if ($step.Count -ne 1) { throw ('STEP_NOT_ONE:' + $step.Count) }
$body = $step[0].CommandElements[2].ScriptBlock.GetScriptBlock()
$Root = ${psLiteral(root)}; $plan = @{ ciSourceManifestSha256 = ${psLiteral(sha)}; residentSid = 'S-1-5-80-1-2-3-4-5' }
$OwnerSid = 'S-1-5-21-1-2-3-1008'; $ControllerSid = 'S-1-5-21-1-2-3-1007'
$out = [ordered]@{}
foreach ($m in @('refused', 'garbage', 'odd', 'ok')) {
  [IO.File]::WriteAllText(${psLiteral(mode)}, $m)
  $script:receipt = [ordered]@{ sourceV2Acl = $null }
  $out[$m] = try { & $body; [ordered]@{ thrown = $null; status = [string]$script:receipt.sourceV2Acl.status } } catch { [ordered]@{ thrown = $_.Exception.Message; status = $null } }
}
ConvertTo-Json -Depth 4 -Compress -InputObject $out`);
  assert.deepEqual(r.refused, { thrown: 'SOURCE_V2_ACL_MIGRATION_REFUSED:ACL_TARGET_MISSING', status: null });
  assert.deepEqual(r.garbage, { thrown: 'SOURCE_V2_ACL_MIGRATION_REFUSED', status: null }, 'no code read: the prefix alone, as before');
  assert.deepEqual(r.odd, { thrown: 'SOURCE_V2_ACL_MIGRATION_REFUSED', status: null }, 'only a code-shaped value is carried');
  assert.deepEqual(r.ok, { thrown: null, status: 'SOURCE_V2_ACL_MIGRATED' });
});
