// Fable ruling 11-21 "first install r5" sections 1.1-1.4 and 2 (drill r4 stopped at step 6, SPOOL_INVENTORY_FAILED and three children refused
// by the execution policy): the PowerShell side of the fix, each part held by a test that failed before it.
//   D1    the host preparation's ci-root step makes formal-spool\outgoing and \incoming (v1 one-shot table, the operator in the Owner's place)
//   D3    the launcher's preflight reads acl-model.json's add targets: one missing is SPOOL_BASELINE_MISSING, and ACL_TARGET_MISSING is
//         accepted only with all of them there (then the missing target can only be the broker)
//   D2    every PowerShell the launcher (Invoke-Child) and the installer (source-v2-acl) start runs with -ExecutionPolicy Bypass, not with
//         whatever the machine or the parent's environment says
//   policy the host preparation reads Get-ExecutionPolicy -List first and refuses a group policy that enforces Restricted or AllSigned
//   D4a   the launcher prints terminal.json as the UTF-8 it is
// Real files only: functions and statements taken by AST from windows/first-install-host.ps1, reinstall/launcher/template.ps1 and
// windows/install-resident.ps1, the real migrate-acl.ps1 and acl-model.json of Source v2 on an offline fixture under TEMP. Windows
// PowerShell 5.1; a parent with a Restricted process scope is how a new machine looks (nothing of the machine is changed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = path.join(RES, 'windows', 'first-install-host.ps1');
const TPL = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
const INSTALL = path.join(RES, 'windows', 'install-resident.ps1');
const RV2 = path.resolve(RES, '..', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2');
const MIGRATE = path.join(RV2, 'migrate-acl.ps1');
const MODEL = path.join(RV2, 'acl-model.json');
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

const SID = 'S-1-5-21-111111111-2222222222-3333333333-';
const OPERATOR = `${SID}1000`, CONTROLLER = `${SID}1007`, COMPANION = `${SID}1008`;
const RESIDENT = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';

// One Windows PowerShell 5.1 run of `command` (the parent's process scope: `policy`); its last stdout line is JSON.
function ps(command, { policy = 'Bypass', raw = false } = {}) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', policy, '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: raw ? 'buffer' : 'utf8', windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  if (raw) return r;
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}

// The named functions and top-level assignments of a real file, dot-sourced into the script scope (a foreach does not open a scope).
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
`;

// ---------------------------------------------------------------- D1 + D3
// The fixture: a CI root under TEMP holding exactly the directories the host preparation's ci-root table names (Get-CiRootDirectories, the
// one table the step makes them from), each with the table's DACL; the owner (a test cannot set BA) and the test account's own full-control
// entry (so it can go on and clean up) are the fixture's only differences, as migrate-acl.ps1 -OfflineFixtureRoot does for what it creates.
const fixture = (root) => `${PRELUDE}
${load(HOST, ['Get-CiRootDirectories', 'Get-CiRootSddl', 'Get-FirstInstallSddl', 'Get-AdminOnlySddl', 'Get-SecretDirectorySddl'], ['CiRoot', 'FirstDir', 'CredDir', 'SecretTargets'])}
$HostCiRoot = $CiRoot
${load(TPL, ['Get-Key', 'Sha256Bytes', 'Parse-Json', 'Parse-LastLine', 'Get-SpoolLeftovers', 'Get-SpoolRemainder', 'Get-SpoolBaseline', 'Test-AclMissingTargetAccepted'], ['ResidentRoot', 'Strict8', 'Js'])}
${load(INSTALL, ['Get-CompanionSpoolSddl'])}
$fx = ${psLiteral(root)}
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$table = Get-CiRootDirectories ${psLiteral(OPERATOR)} ${psLiteral(CONTROLLER)}
$made = @()
foreach ($k in @($table.Keys)) {
  $p = [string]$table[$k][0]
  if (-not ($p -ceq $HostCiRoot -or $p.StartsWith($HostCiRoot + '\\', [StringComparison]::OrdinalIgnoreCase))) { throw ('TABLE_PATH_OUTSIDE_CI_ROOT:' + $p) }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm((([string]$table[$k][1]) -replace '^O:BAG:BA', '') + '(A;OICI;FA;;;' + $me + ')')
  [void][IO.Directory]::CreateDirectory($fx + $p.Substring($HostCiRoot.Length), $ds); $made += $p.Substring($HostCiRoot.Length)
}
$spool = Join-Path $fx 'formal-spool'
function Invoke-Migrate([switch]$Apply) {
  $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${psLiteral(MIGRATE)}, '-ResidentSid', ${psLiteral(RESIDENT)}, '-OwnerSid', ${psLiteral(OPERATOR)}, '-ControllerSid', ${psLiteral(CONTROLLER)}, '-OfflineFixtureRoot', $fx)
  if ($Apply) { $a += '-Apply' }
  $o = & ${psLiteral(POWERSHELL)} @a | Out-String
  [ordered]@{ exit = $LASTEXITCODE; result = (Parse-LastLine $o) }
}
`;

test('D1+D3: the host table makes the whole spool baseline; the launcher inventory, migrate-acl and the companion move all hold on it', { skip, timeout: 600_000 }, (t) => {
  const root = path.join(tempDir(t, 'r5-d1-'), 'ci');
  const r = ps(`${fixture(root)}
# 1. the launcher's inventory on what the host made
$inv = $null; try { $found = Get-SpoolLeftovers $spool; $rem = Get-SpoolRemainder $spool $found; $inv = [ordered]@{ records = $found.Count; remainder = @($rem) } } catch { $inv = [ordered]@{ error = $_.Exception.GetType().Name + ': ' + $_.Exception.Message } }
if ($inv.Contains('error')) { ConvertTo-Json -Depth 4 -Compress -InputObject ([ordered]@{ made = $made; inventory = $inv }); return }   # the rest stands on it
# 2. migrate-acl before the install made resident\\broker: the missing target is the broker's, and the launcher accepts exactly that
$dry = Invoke-Migrate
$baseline = Get-SpoolBaseline ${psLiteral(MODEL)} $fx
$accepted = Test-AclMissingTargetAccepted $dry.exit $dry.result ([IO.Directory]::Exists((Join-Path $fx 'resident'))) $true $null $baseline.missing
# 3. the broker made (as the installer does before source-v2-acl: protected, no controller entry; Get-AclPlan): the plan passes, then -Apply does
$bds = New-Object Security.AccessControl.DirectorySecurity; $bds.SetSecurityDescriptorSddlForm('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $me + ')')
foreach ($d in @('resident', 'resident\\broker', 'resident\\broker\\requests', 'resident\\broker\\responses')) { [void][IO.Directory]::CreateDirectory((Join-Path $fx $d), $bds) }
$plan = Invoke-Migrate; $apply = Invoke-Migrate -Apply
# 4. the installer's companion move (Set-CompanionSpoolAcl's pure rule) on the two folders as they are after source-v2-acl
$write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
$moved = [ordered]@{}
foreach ($leaf in @('incoming', 'outgoing')) {
  $before = (Get-Acl -LiteralPath (Join-Path $spool $leaf)).Sddl
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor((Get-CompanionSpoolSddl $before ${psLiteral(OPERATOR)} ${psLiteral(COMPANION)}))
  $of = { param($sid) @($raw.DiscretionaryAcl | Where-Object { $_.SecurityIdentifier.Value -ceq $sid } | ForEach-Object { [ordered]@{ mask = ('0x{0:x}' -f $_.AccessMask); writes = (($_.AccessMask -band $write) -ne 0) } }) }
  $moved[$leaf] = [ordered]@{ operator = @(& $of ${psLiteral(OPERATOR)}); companion = @(& $of ${psLiteral(COMPANION)}); resident = @(& $of ${psLiteral(RESIDENT)}) }
}
ConvertTo-Json -Depth 8 -Compress -InputObject ([ordered]@{ made = $made; inventory = $inv
  dry = [ordered]@{ exit = $dry.exit; status = (Get-Key $dry.result 'status'); code = (Get-Key $dry.result 'code') }; baseline = $baseline; accepted = $accepted
  plan = [ordered]@{ exit = $plan.exit; status = (Get-Key $plan.result 'status'); code = (Get-Key $plan.result 'code') }
  apply = [ordered]@{ exit = $apply.exit; status = (Get-Key $apply.result 'status'); code = (Get-Key $apply.result 'code') }; moved = $moved })`);
  assert.deepEqual(r.inventory, { records: 0, remainder: [] }, 'the inventory reads an empty baseline');
  assert.ok(r.made.includes('\\formal-spool\\outgoing') && r.made.includes('\\formal-spool\\incoming'), JSON.stringify(r.made));
  assert.deepEqual(r.dry, { exit: 2, status: 'REFUSED', code: 'ACL_TARGET_MISSING' }, 'before the install only the broker is missing');
  assert.deepEqual(r.baseline, { code: null, missing: [] });
  assert.equal(r.accepted, true, 'the launcher accepts the missing broker on a complete baseline');
  assert.deepEqual(r.plan, { exit: 0, status: 'SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN', code: null });
  assert.deepEqual(r.apply, { exit: 0, status: 'SOURCE_V2_ACL_MIGRATED', code: null });
  // incoming: the companion writes, the operator no longer can; outgoing: both read only. The resident's two entries are there on both.
  const masks = list => list.map(a => a.mask).sort();
  assert.ok(r.moved.incoming.operator.every(a => !a.writes), JSON.stringify(r.moved.incoming));
  assert.ok(r.moved.incoming.companion.some(a => a.mask === '0x1301bf'), JSON.stringify(r.moved.incoming));
  for (const who of ['operator', 'companion']) {
    assert.ok(r.moved.outgoing[who].length > 0 && r.moved.outgoing[who].every(a => a.mask === '0x1200a9' && !a.writes), JSON.stringify(r.moved.outgoing));
  }
  for (const leaf of ['incoming', 'outgoing']) assert.deepEqual(masks(r.moved[leaf].resident), ['0x120089', '0x1200e1'], leaf);
});

test('D3: a spool baseline target missing is SPOOL_BASELINE_MISSING, and ACL_TARGET_MISSING is then refused', { skip, timeout: 600_000 }, (t) => {
  const root = path.join(tempDir(t, 'r5-d3-'), 'ci');
  const r = ps(`${fixture(root)}
[IO.Directory]::Delete((Join-Path $spool 'incoming'))
$dry = Invoke-Migrate
$baseline = Get-SpoolBaseline ${psLiteral(MODEL)} $fx
$accepted = Test-AclMissingTargetAccepted $dry.exit $dry.result ([IO.Directory]::Exists((Join-Path $fx 'resident'))) $true $null $baseline.missing
# Step-Preflight decides with these two functions and nothing else: the staged model next to the staged migrate-acl, the real CI root
$tplAst = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(TPL)}, [ref]$tokens, [ref]$errors)
$step = @($tplAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Step-Preflight' }, $true))[0]
$calls = @($step.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.Extent.Text } | Where-Object { $_ -match '^(Get-SpoolBaseline|Test-AclMissingTargetAccepted) ' })
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ dry = [ordered]@{ exit = $dry.exit; code = (Get-Key $dry.result 'code') }; baseline = $baseline; accepted = $accepted
  calls = $calls; literal = $step.Extent.Text.Contains('ACL_TARGET_MISSING') })`);
  assert.deepEqual(r.dry, { exit: 2, code: 'ACL_TARGET_MISSING' });
  assert.deepEqual(r.baseline, { code: 'SPOOL_BASELINE_MISSING', missing: ['C:\\ProgramData\\CluedIndependentCI\\formal-spool\\incoming'] });
  assert.equal(r.accepted, false, 'a missing spool target is never taken for the missing broker');
  assert.deepEqual(r.calls, ["Get-SpoolBaseline (Join-Path $Stage 'acl-model.json') (Split-Path -Parent $ResidentRoot)",
    'Test-AclMissingTargetAccepted $m.exit $mv ([IO.Directory]::Exists($ResidentRoot)) ([bool]$FleetFirstInstall) $aclBefore $baseline.missing']);
  assert.equal(r.literal, false, 'the acceptance is the pure function\'s alone');
});

// ---------------------------------------------------------------- D2
// The real Invoke-Child (its environment cleared to $ChildEnv) under a parent whose process scope is Restricted: the child must run its
// script with Bypass, whatever the machine's LocalMachine scope is (RemoteSigned on DESK and the CI runners, Restricted on a new Windows 11).
test('D2: the launcher\'s children run with -ExecutionPolicy Bypass, not the machine\'s policy', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-d2-');
  const out = path.join(dir, 'out'); const tmp = path.join(dir, 'tmp'); fs.mkdirSync(out); fs.mkdirSync(tmp);
  const probe = path.join(dir, 'probe.ps1'); fs.writeFileSync(probe, "[Console]::Out.Write([string](Get-ExecutionPolicy))\r\n");
  const r = ps(`${PRELUDE}
$NodeHostname = $env:COMPUTERNAME
${load(TPL, ['Write-New', 'Invoke-Child'], ['PS', 'U8', 'ChildEnv'])}
$Out = ${psLiteral(out)}
foreach ($k in @('TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA')) { $ChildEnv[$k] = ${psLiteral(tmp)} }
$c = Invoke-Child 'probe' ${psLiteral(probe)} @()
ConvertTo-Json -Compress -InputObject ([ordered]@{ parent = [string](Get-ExecutionPolicy); exit = $c.exit; stdout = [string]$c.stdout; stderr = [string]$c.stderr })`, { policy: 'Restricted' });
  assert.equal(r.parent, 'Restricted', 'the parent runs as a new machine would');
  assert.deepEqual({ exit: r.exit, stdout: r.stdout }, { exit: 0, stdout: 'Bypass' }, r.stderr);
});

// The installer's own nested PowerShell (step source-v2-acl), the statement as it is in install-resident.ps1, run under a Restricted parent
// (the launcher's install child before the fix: it inherited the policy of whoever started it). The tool is a probe that takes the same
// parameters and says which policy it ran under.
test('D2: the installer\'s source-v2-acl child runs with -ExecutionPolicy Bypass under a Restricted parent', { skip, timeout: 300_000 }, (t) => {
  const dir = tempDir(t, 'r5-d2i-');
  const probe = path.join(dir, 'migrate-probe.ps1');
  fs.writeFileSync(probe, "param([switch]$Apply, [string]$ResidentSid, [string]$OwnerSid, [string]$ControllerSid)\r\n"
    + "[Console]::Out.Write('{\"policy\":\"' + [string](Get-ExecutionPolicy) + '\",\"apply\":' + ([string][bool]$Apply).ToLowerInvariant() + ',\"owner\":\"' + $OwnerSid + '\"}')\r\n");
  const r = ps(`${PRELUDE}
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(INSTALL)}, [ref]$tokens, [ref]$errors)
$step = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -ge 3 -and $n.CommandElements[1].Extent.Text -ceq "'source-v2-acl'" }, $true))
if ($step.Count -ne 1) { throw ('STEP_NOT_ONE:' + $step.Count) }
$calls = @($step[0].FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$out' -and $n.Right.Extent.Text -match 'powershell\\.exe' }, $true))
if ($calls.Count -ne 1) { throw ('CALL_NOT_ONE:' + $calls.Count) }
$tool = ${psLiteral(probe)}; $plan = @{ residentSid = ${psLiteral(RESIDENT)} }; $OwnerSid = ${psLiteral(COMPANION)}; $OperatorSid = ${psLiteral(OPERATOR)}; $ControllerSid = ${psLiteral(CONTROLLER)}
$ErrorActionPreference = 'Continue'
. ([scriptblock]::Create($calls[0].Extent.Text))
$exit = $LASTEXITCODE
ConvertTo-Json -Compress -InputObject ([ordered]@{ parent = [string](Get-ExecutionPolicy); exit = $exit; out = [string]$out })`, { policy: 'Restricted' });
  assert.equal(r.parent, 'Restricted');
  assert.equal(r.exit, 0, r.out);
  assert.deepEqual(JSON.parse(r.out.trim()), { policy: 'Bypass', apply: true, owner: OPERATOR });
});

// ---------------------------------------------------------------- the host preparation's policy check
test('policy: the host preparation refuses a group policy that enforces Restricted or AllSigned, and records every scope', { skip, timeout: 300_000 }, () => {
  const r = ps(`${PRELUDE}
${load(HOST, ['Get-ExecutionPolicyCheck'])}
$list = { param($machine, $user) foreach ($s in @(@('MachinePolicy', $machine), @('UserPolicy', $user), @('Process', 'Undefined'), @('CurrentUser', 'Undefined'), @('LocalMachine', 'Undefined'))) { [pscustomobject]@{ Scope = $s[0]; ExecutionPolicy = $s[1] } } }
$cases = [ordered]@{}
foreach ($c in @(@('AllSigned', 'Undefined'), @('Undefined', 'Restricted'), @('Restricted', 'Undefined'), @('Undefined', 'Undefined'), @('RemoteSigned', 'Undefined'), @('Unrestricted', 'Bypass'))) { $cases[$c -join '/'] = Get-ExecutionPolicyCheck (& $list $c[0] $c[1]) }
$real = Get-ExecutionPolicyCheck (Get-ExecutionPolicy -List)
$text = [IO.File]::ReadAllText(${psLiteral(HOST)}); $main = $text.Substring($text.IndexOf('function Invoke-HostPreparation'))
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ cases = $cases; real = @($real.scopes.Keys)
  order = @($main.IndexOf("Enter-Step 'execution-policy'"), $main.IndexOf('Get-ExecutionPolicyCheck (Get-ExecutionPolicy -List)'), $main.IndexOf("Enter-Step 'operator'"), $main.IndexOf('New-Dir ')) })`);
  const code = 'HOST_EXECUTION_POLICY_ENFORCED_BY_POLICY';
  assert.deepEqual(Object.fromEntries(Object.entries(r.cases).map(([k, v]) => [k, v.code])),
    { 'AllSigned/Undefined': code, 'Undefined/Restricted': code, 'Restricted/Undefined': code, 'Undefined/Undefined': null, 'RemoteSigned/Undefined': null, 'Unrestricted/Bypass': null });
  assert.deepEqual(r.cases['Undefined/Undefined'].scopes, { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Undefined', CurrentUser: 'Undefined', LocalMachine: 'Undefined' });
  assert.deepEqual(r.real, ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'], 'the real cmdlet\'s shape');
  const [enter, read, operator, firstDir] = r.order;
  assert.ok(enter >= 0 && enter < read && read < operator && operator < firstDir, JSON.stringify(r.order));
});

// ---------------------------------------------------------------- D4a
// terminal.json as the real Write-Json writes it (UTF-8, no BOM) with a detail in Chinese, then every statement of the template that prints
// it, run by itself in a new Windows PowerShell 5.1 whose output is UTF-8: what it prints is the file, byte for byte.
test('D4a: the launcher prints terminal.json as the UTF-8 it is', { skip, timeout: 300_000 }, (t) => {
  const out = tempDir(t, 'r5-d4-');
  const r = ps(`${PRELUDE}
${load(TPL, ['Write-New', 'Write-Json'], ['U8'])}
$Out = ${psLiteral(out)}
$zh = -join ([char[]](0x5728, 0x6B64, 0x7CFB, 0x7EDF, 0x4E0A, 0x7981, 0x6B62, 0x8FD0, 0x884C, 0x811A, 0x672C))
Write-Json 'terminal.json' ([ordered]@{ status = 'STOPPED'; code = 'ACL_MIGRATION_PLAN_REFUSED'; detail = [ordered]@{ stderr = $zh } })
$prints = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Get-Content' -and $n.Extent.Text.Contains("'terminal.json'") }, $true) | ForEach-Object { $_.Extent.Text })
ConvertTo-Json -Compress -InputObject ([ordered]@{ prints = $prints })`);
  assert.ok(r.prints.length >= 1, 'the template prints its terminal');
  const file = fs.readFileSync(path.join(out, 'terminal.json'));
  assert.ok(file.includes(Buffer.from('\u5728\u6b64\u7cfb\u7edf', 'utf8')), 'the file is UTF-8');
  for (const statement of r.prints) {
    const p = ps(`[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $Out = ${psLiteral(out)}\n${statement}`, { raw: true });
    assert.equal(p.status, 0, String(p.stderr));
    let printed = p.stdout; if (printed.subarray(-2).toString('latin1') === '\r\n') printed = printed.subarray(0, -2);
    assert.ok(printed.equals(file), `${statement}\nprinted: ${printed.toString('utf8')}\nfile:    ${file.toString('utf8')}`);
  }
});
