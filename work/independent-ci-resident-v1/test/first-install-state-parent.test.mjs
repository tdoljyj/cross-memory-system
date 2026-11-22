// r13 HALT (Fable ruling 0e418483, option 戊): the first install made C:\ProgramData\CluedIndependentCI\state only as a side effect of
// migrate-acl.ps1's CreateDirectory("state\v2", ds), and Windows PowerShell 5.1 gives the intermediate folder the same DACL, so state itself
// carried (A;OICI;0x1301bf;;;clued-control): the generic helper's Validate (FormalPublicBoundaryV2.cs:270, the Parents chain of StateV2)
// refused it with UNTRUSTED_PUBLIC_MUTATION_RIGHT_REFUSED before ready, and the first role probe HALTed. The fix: install-resident.ps1's
// rule state-parent-acl owns state's DACL (step before source-v2-acl; verify-resident.ps1 runs the same rule as SYSTEM in an upgrade).
// End to end on an offline fixture under TEMP, real files only (the fixture of first-install-r5-defects.test.mjs:60-95): the host
// preparation's ci-root table, the broker folders, the installer's own state-parent-acl rule, the real migrate-acl.ps1 -Apply, the
// installer's Set-CompanionSpoolAcl written to disk, then the real FormalPublicBoundaryV2.cs compiled (the generic helper's file list of
// test-pure-v2.ps1:13) and its own DangerFor and WriterAllowed run on every "allow, not inherit-only" ACE of each of the six targets of
// :270 and every folder of its chain inside the CI root (the test account's own fixture entries aside; owner BA and the two folders above
// the CI root cannot be made by a test). Windows PowerShell 5.1, not elevated; nothing of the machine is changed.
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
const HELPER_CS = ['FormalPublicBoundaryV2.cs', 'FormalSession0V2.cs', 'ScmPidHandshakeV2.cs', 'NodeProfileV2.cs'].map(f => path.join(RV2, 'windows', f));
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

const SID = 'S-1-5-21-111111111-2222222222-3333333333-';
const OPERATOR = `${SID}1000`, CONTROLLER = `${SID}1007`, COMPANION = `${SID}1008`, STRANGER = `${SID}1099`;
const RESIDENT = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';
const STATE = 'C:\\ProgramData\\CluedIndependentCI\\state';

function ps(command) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { cwd: RES, env, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}
// The named functions and top-level assignments of a real file, dot-sourced into the script scope (first-install-r5-defects.test.mjs).
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
$webExt = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Set-Dacl([string]$p, [string]$sddl) { $s = New-Object Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access); [IO.Directory]::SetAccessControl($p, $s) }
# READ_CONTROL only (owner rights), never the attributes Get-Acl reads first: a child of a folder this account may not list is still read
function Dacl([string]$p) { [IO.Directory]::GetAccessControl($p, [Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) }
# The test account owns every folder it made (owner rights: READ_CONTROL, WRITE_DAC), so it can always give itself full control back to clean up.
function Restore-Mine([string[]]$dirs) { foreach ($d in $dirs) { if ([IO.Directory]::Exists($d)) { try { Set-Dacl $d ('D:(A;OICI;FA;;;' + $me + ')') } catch { } } } }
# state's DACL as the fixture reads it: the fixture account's own entry (A;;FA;;;<sid>) taken out, the rest compared with the production DACL.
function Get-FixtureFreeState([string]$sddl, [string]$sid, [string]$terminal) {
  $dacl = $sddl -replace [regex]::Escape('(A;;FA;;;' + $sid + ')'), ''
  [ordered]@{ dacl = $dacl; terminal = ($dacl -ceq $terminal) }
}
`;
// The installer's state-parent-acl rule, by exact name (the functions verify-resident.ps1 loads too).
const STATE_RULE = ['Get-DaclShape', 'Get-StateParentSddl', 'Get-StateParentTarget', 'Get-StateParentState', 'Invoke-StateParentAcl'];

// The fixture of first-install-r5-defects.test.mjs:72-95 (the host's ci-root table, the broker folders, migrate-acl.ps1 -OfflineFixtureRoot),
// then the step order of install-resident.ps1: [state-parent-acl] -> source-v2-acl -> companion-account's Set-CompanionSpoolAcl.
const firstInstall = (root, { stateStep }) => `${PRELUDE}
${load(HOST, ['Get-CiRootDirectories', 'Get-CiRootSddl', 'Get-FirstInstallSddl', 'Get-AdminOnlySddl', 'Get-SecretDirectorySddl'], ['CiRoot', 'FirstDir', 'CredDir', 'SecretTargets'])}
$HostCiRoot = $CiRoot
${load(INSTALL, ['Get-CompanionSpoolSddl', 'Set-CompanionSpoolAcl', ...(stateStep ? STATE_RULE : [])])}
$fx = ${psLiteral(root)}
$table = Get-CiRootDirectories ${psLiteral(OPERATOR)} ${psLiteral(CONTROLLER)}
foreach ($k in @($table.Keys)) {
  $p = [string]$table[$k][0]
  if (-not ($p -ceq $HostCiRoot -or $p.StartsWith($HostCiRoot + '\\', [StringComparison]::OrdinalIgnoreCase))) { throw ('TABLE_PATH_OUTSIDE_CI_ROOT:' + $p) }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm((([string]$table[$k][1]) -replace '^O:BAG:BA', '') + '(A;OICI;FA;;;' + $me + ')')
  [void][IO.Directory]::CreateDirectory($fx + $p.Substring($HostCiRoot.Length), $ds)
}
$bds = New-Object Security.AccessControl.DirectorySecurity; $bds.SetSecurityDescriptorSddlForm('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $me + ')')
foreach ($d in @('resident', 'resident\\broker', 'resident\\broker\\requests', 'resident\\broker\\responses')) { [void][IO.Directory]::CreateDirectory((Join-Path $fx $d), $bds) }
$stateDir = Join-Path $fx 'state'
$stateStep = $null
${stateStep ? `# step state-parent-acl, as install-resident.ps1 runs it (the owner BA left out: a test account cannot set it)
$sp = Get-StateParentState $stateDir ${psLiteral(CONTROLLER)}
$sp.sddl = $sp.sddl -replace '^O:BAG:BA', ''
$stateStep = Invoke-StateParentAcl $sp ${psLiteral(CONTROLLER)}
# the fixture's own entry so that migrate-acl (this account, offline) can make state\\v2 under it; the chain check below sets it aside
Set-Dacl $stateDir ((Dacl $stateDir) + '(A;;FA;;;' + $me + ')')` : ''}
$a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${psLiteral(MIGRATE)}, '-ResidentSid', ${psLiteral(RESIDENT)}, '-OwnerSid', ${psLiteral(OPERATOR)}, '-ControllerSid', ${psLiteral(CONTROLLER)}, '-OfflineFixtureRoot', $fx, '-Apply')
$migrate = (& ${psLiteral(POWERSHELL)} @a | Out-String).Trim().Split([char]10)[-1] | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw ('MIGRATE_FAILED:' + $migrate.code) }
foreach ($leaf in @('incoming', 'outgoing')) { Set-CompanionSpoolAcl (Join-Path $fx ('formal-spool\\' + $leaf)) ${psLiteral(OPERATOR)} ${psLiteral(COMPANION)} }
# The generic helper's own rule: the real C#, compiled as test-pure-v2.ps1 compiles it, the node profile bound as PureTestsV2 binds it.
Add-Type -Path @(${HELPER_CS.map(psLiteral).join(', ')}) -ReferencedAssemblies @($webExt.Location, 'System.Core')
$node = New-Object 'Collections.Generic.Dictionary[string,object]'
foreach ($kv in @(@('contract', 'clued.independent-ci.node-profile/1'), @('nodeName', 'state-parent-fixture'), @('hostname', 'FIXTURE01'), @('ownerSid', ${psLiteral(COMPANION)}),
    @('ownerProfileDirectory', 'C:\\Users\\fixture'), @('controllerSid', ${psLiteral(CONTROLLER)}), @('runnerService', 'actions.runner.tdoljyj-cross-memory-system.clued-ci-fixture'),
    @('mutationMutex', 'Global\\CluedControlControllerMutationV1-FIXTURE01-1007'), @('wslDistribution', 'Ubuntu'))) { $node[$kv[0]] = $kv[1] }
$bind = [NodeProfileV2].GetMethod('BindForProcess', [Reflection.BindingFlags]'NonPublic, Static')
[void]$bind.Invoke($null, @([NodeProfileV2]::FromDictionary($node), ('a' * 64)))
if ([FormalPublicBoundaryV2]::Controller -cne ${psLiteral(CONTROLLER)} -or [FormalPublicBoundaryV2]::OwnerUser -cne ${psLiteral(COMPANION)}) { throw 'PROFILE_NOT_BOUND' }
$B = [FormalPublicBoundaryV2]; $chain = New-Object 'Collections.Generic.List[string]'
foreach ($target in @($B::StateV2, $B::Receipts, $B::Temp, $B::Spool, $B::Outgoing, $B::Incoming)) {
  for ($p = $target; $p.Length -ge $B::Root.Length; $p = [IO.Path]::GetDirectoryName($p)) { if (-not $chain.Contains($p)) { $chain.Add($p) } }
}
$refused = @(); $checked = @()
foreach ($real in ($chain | Sort-Object)) {
  $local = $fx + $real.Substring($B::Root.Length)
  if (-not [IO.Directory]::Exists($local)) { $refused += ,[ordered]@{ path = $real; code = 'MISSING' }; continue }
  $danger = [int64]$B::DangerFor($real)
  foreach ($r in (Get-Acl -LiteralPath $local).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne 'Allow' -or ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    $sid = $r.IdentityReference.Value
    if ($sid -ceq $me) { continue }   # the fixture's own entries
    if (([int64]$r.FileSystemRights -band $danger) -ne 0 -and -not $B::WriterAllowed($real, $sid)) { $refused += ,[ordered]@{ path = $real; sid = $sid; mask = ('0x{0:x}' -f [int64]$r.FileSystemRights); inherited = $r.IsInherited } }
  }
  $checked += $real
}
$stateDacl = $(if ($stateStep) { Get-FixtureFreeState (Dacl $stateDir) $me ${psLiteral(TERMINAL_DACL)} } else { $null })
Restore-Mine @($fx, $stateDir)
ConvertTo-Json -Depth 6 -Compress -InputObject ([ordered]@{ migrate = $migrate.status; checked = $checked; refused = $refused; stateStep = $stateStep; stateDacl = $stateDacl })`;

const SIX_CHAINS = ['', '\\formal-spool', '\\formal-spool\\incoming', '\\formal-spool\\outgoing', '\\state', '\\state\\v2', '\\state\\v2\\receipts', '\\state\\v2\\temp']
  .map(s => `C:\\ProgramData\\CluedIndependentCI${s}`).sort();
// as Windows reads it back (AI set; Get-DaclShape compares without it)
const TERMINAL_DACL = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;${CONTROLLER})(A;;0x1200a9;;;${CONTROLLER})`;

// Without state-parent-acl (the install as it was until r13): the helper's rule refuses exactly one ACE on the whole chain, the
// controller's write on state itself, made by migrate-acl's CreateDirectory. This also shows the check below can see a refusal.
test('r13 cause: without state-parent-acl, the helper\'s rule refuses state itself, and nothing else on the six chains', { skip, timeout: 600_000 }, (t) => {
  const r = ps(firstInstall(path.join(tempDir(t, 'r13-cause-'), 'ci'), { stateStep: false }));
  assert.equal(r.migrate, 'SOURCE_V2_ACL_MIGRATED');
  assert.deepEqual([...r.checked].sort(), SIX_CHAINS);
  assert.deepEqual(r.refused, [{ path: STATE, sid: CONTROLLER, mask: '0x1301bf', inherited: false }], JSON.stringify(r.refused));
});

// With it: state is made by the rule with the production DACL (DESIGN.md section 8, the TURING fix of 2026-10-21), migrate-acl only adds
// state\v2 under it, and the whole chain of all six targets passes the helper's rule.
test('r13 fix: the first install\'s state-parent-acl makes state, and the helper\'s rule passes every folder of the six chains', { skip, timeout: 600_000 }, (t) => {
  const r = ps(firstInstall(path.join(tempDir(t, 'r13-fix-'), 'ci'), { stateStep: true }));
  assert.equal(r.migrate, 'SOURCE_V2_ACL_MIGRATED');
  assert.deepEqual([...r.checked].sort(), SIX_CHAINS);
  assert.deepEqual(r.refused, [], JSON.stringify(r.refused));
  assert.equal(r.stateStep.action, 'create'); assert.equal(r.stateStep.wrote, true); assert.equal(r.stateStep.before, null);
  assert.equal(r.stateDacl.terminal, true, `state carries the production DACL after migrate-acl: ${r.stateDacl.dacl}`);
});

// The installer runs the rule as its own step, before source-v2-acl, with the plan's path and the receipt's record.
test('install-resident.ps1: step state-parent-acl runs the rule on <CiRoot>\\state before source-v2-acl and records it', { skip, timeout: 120_000 }, () => {
  const r = ps(`${PRELUDE}
$tokens = $null; $errors = $null; $ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(INSTALL)}, [ref]$tokens, [ref]$errors)
$steps = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -eq 3 }, $true) | ForEach-Object { $_.CommandElements[1].Extent.Text.Trim("'") })
$body = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -eq 3 -and $n.CommandElements[1].Extent.Text -ceq "'state-parent-acl'" }, $true))
$plan = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Build-Plan' }, $true))[0].Extent.Text
ConvertTo-Json -Compress -InputObject ([ordered]@{ steps = $steps; body = @($body | ForEach-Object { $_.CommandElements[2].Extent.Text }); plan = $plan.Contains(${psLiteral("stateParent = [ordered]@{ path = (Join-Path $CiRoot 'state'); sddl = (Get-StateParentSddl $ControllerSid)")}) })`);
  const at = name => r.steps.indexOf(name);
  assert.ok(at('state-parent-acl') > at('directories') && at('state-parent-acl') < at('source-v2-acl'), JSON.stringify(r.steps));
  assert.equal(r.body.length, 1);
  assert.match(r.body[0], /\$sp = Get-StateParentState \$plan\.stateParent\.path \$ControllerSid\s+\$script:receipt\.stateParentAcl = Invoke-StateParentAcl \$sp \$ControllerSid/);
  assert.equal(r.plan, true, 'the plan names the path and the DACL the rule makes');
});

// The rule's cases on real NTFS (folders this account owns, so it may set any DACL on them).
const rule = (root, body) => ps(`${PRELUDE}
${load(INSTALL, STATE_RULE)}
$root = ${psLiteral(root)}; [void][IO.Directory]::CreateDirectory($root)
$C = ${psLiteral(CONTROLLER)}
$made = New-Object 'Collections.Generic.List[string]'
function New-State([string]$name, [string]$dacl) {
  $s = Join-Path $root $name; [void][IO.Directory]::CreateDirectory($s); $made.Add($s)
  # v1's own subfolder that inherits from state, and Source v2's protected one (as migrate-acl makes it)
  $e = Join-Path $s 'effects'; [void][IO.Directory]::CreateDirectory($e); $made.Add($e); Set-Dacl $e 'D:AI'
  $v = Join-Path $s 'v2'; [void][IO.Directory]::CreateDirectory($v); $made.Add($v); Set-Dacl $v ('D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')(A;OICI;FA;;;' + $me + ')')
  Set-Dacl $s $dacl; $s
}
function Try-Rule([string]$s) { try { $p = Get-StateParentState $s $C; $p.sddl = $p.sddl -replace '^O:BAG:BA', ''; Invoke-StateParentAcl $p $C } catch { $_.Exception.Message } }
$out = [ordered]@{}
${body}
Restore-Mine @($made)
ConvertTo-Json -Depth 6 -Compress -InputObject $out`);

test('rule: a wide state (the controller writes on state itself) converges to inherit-only plus a read entry; its children keep what they inherit', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-wide-'), 'r'), `
$s = New-State 'wide' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')')
$child = @((Dacl (Join-Path $s 'effects')), (Dacl (Join-Path $s 'v2')))
$out.first = Try-Rule $s; $out.after = Dacl $s
$out.childKept = ((Dacl (Join-Path $s 'effects')) -ceq $child[0]) -and ((Dacl (Join-Path $s 'v2')) -ceq $child[1])
$out.second = Try-Rule $s; $out.afterSecond = Dacl $s
$out.shape = (Get-DaclShape $out.after) -ceq (Get-DaclShape (Get-StateParentSddl $C))`);
  assert.equal(r.first.action, 'converge'); assert.equal(r.first.wrote, true);
  assert.equal(r.shape, true, `${r.after}: exactly the production DACL`);
  assert.equal(r.childKept, true, 'the inheritable entries are unchanged, so every child inherits what it did');
  assert.equal(r.second.action, 'none'); assert.equal(r.second.wrote, false); assert.equal(r.afterSecond, r.after);
});

test('rule: a state that already passes is not written; a missing one is made with the production DACL', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-same-'), 'r'), `
$s = New-State 'terminal' (((Get-StateParentSddl $C) -replace '^O:BAG:BA', '') -replace '^D:P', 'D:PAI')
$before = Dacl $s; $out.terminal = Try-Rule $s; $out.terminalSame = (Dacl $s) -ceq $before
# the production DACL with one more read-only entry of another account (the helper's rule lets it through): kept as it is
$s2 = New-State 'reader' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;' + $C + ')(A;;0x1200a9;;;' + $C + ')(A;OICI;0x1200a9;;;${STRANGER})')
$before2 = Dacl $s2; $out.reader = Try-Rule $s2; $out.readerSame = (Dacl $s2) -ceq $before2
$m = Join-Path $root 'missing'; $made.Add($m); $out.missing = Try-Rule $m
$out.missingShape = (Get-DaclShape (Dacl $m)) -ceq (Get-DaclShape (Get-StateParentSddl $C))`);
  assert.equal(r.terminal.action, 'none'); assert.equal(r.terminal.wrote, false); assert.equal(r.terminalSame, true);
  assert.equal(r.reader.action, 'none'); assert.equal(r.reader.wrote, false); assert.equal(r.readerSame, true);
  assert.equal(r.missing.action, 'create'); assert.equal(r.missing.wrote, true); assert.equal(r.missingShape, true);
});

test('rule: another account that can write, a controller write it does not own, a link or a change since the plan: refused, nothing written', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-refuse-'), 'r'), `
$cases = [ordered]@{
  stranger = ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')(A;;0x1301bf;;;${STRANGER})')
  strangerDelete = ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;' + $C + ')(A;;0x1200a9;;;' + $C + ')(A;;0x10000;;;${STRANGER})')
  everyone = ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;WD)')
  nullDacl = 'D:NO_ACCESS_CONTROL'
}
foreach ($k in @($cases.Keys)) { $s = New-State $k $cases[$k]; $before = Dacl $s; $out[$k] = [ordered]@{ result = (Try-Rule $s); same = ((Dacl $s) -ceq $before) } }
$target = New-State 'target' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')')
$link = Join-Path $root 'link'; New-Item -ItemType Junction -Path $link -Value $target | Out-Null
$before = Dacl $target; $out.link = [ordered]@{ result = (Try-Rule $link); same = ((Dacl $target) -ceq $before) }
[IO.Directory]::Delete($link)
$s = New-State 'changed' ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $C + ')')
$p = Get-StateParentState $s $C; Set-Dacl $s ('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $C + ')'); $before = Dacl $s
$out.changed = [ordered]@{ result = $(try { Invoke-StateParentAcl $p $C } catch { $_.Exception.Message }); same = ((Dacl $s) -ceq $before) }`);
  for (const k of ['stranger', 'strangerDelete', 'everyone', 'nullDacl', 'link', 'changed']) {
    assert.equal(typeof r[k].result, 'string', `${k}: ${JSON.stringify(r[k])}`);
    assert.equal(r[k].same, true, `${k}: nothing written`);
  }
  for (const k of ['stranger', 'strangerDelete', 'everyone', 'nullDacl', 'link']) assert.match(r[k].result, /^STATE_PARENT_ACL_REFUSED:/, k);
  assert.match(r.stranger.result, new RegExp(`OTHER_WRITER:${STRANGER}`));
  assert.equal(r.changed.result, 'STATE_PARENT_ACL_CHANGED_SINCE_PLAN');
});

// The hosted Windows runner (run 45055934390, job 137311039345) runs as the built-in Administrator (RID 500 of the machine's domain), which
// Windows writes as the alias LA, not as its SID; and DirectorySecurity (the fixture's Set-Dacl) sorts explicit allow entries by SID once
// one sorts before the controller's, swapping the controller's two entries. Both are the fixture's own doing, not the rule's: here on
// real NTFS, the rule makes state, the fixture appends its entry for such an account, and the read must still find the production DACL.
test('fixture read: the fixture account as the built-in Administrator (alias LA) or sorting before the controller still reads as the production DACL', { skip, timeout: 300_000 }, (t) => {
  const r = rule(path.join(tempDir(t, 'r13-hosted-'), 'r'), `
$la = $me.Substring(0, $me.LastIndexOf('-')) + '-500'
$s = Join-Path $root 'state'; $made.Add($s); $p = Get-StateParentState $s $C; $p.sddl = $p.sddl -replace '^O:BAG:BA', ''; [void](Invoke-StateParentAcl $p $C)
$base = Dacl $s
foreach ($x in @($la, 'S-1-5-21-1-2-3-500')) { Set-Dacl $s ($base + '(A;;FA;;;' + $x + ')'); $out[$x] = Get-FixtureFreeState (Dacl $s) $x ${psLiteral(TERMINAL_DACL)} }
# the exact DACL the hosted runner read back (its LA is this machine's LA here)
$out.hostedLog = Get-FixtureFreeState ${psLiteral(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;LA)(A;;0x1200a9;;;${CONTROLLER})(A;OICIIO;0x1301bf;;;${CONTROLLER})`)} $la ${psLiteral(TERMINAL_DACL)}`);
  for (const [k, v] of Object.entries(r)) assert.equal(v.terminal, true, `${k}: ${v.dacl}`);
  assert.equal(Object.keys(r).length, 3);
});
