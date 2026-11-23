// The offline first-install fixture shared by first-install-r5-defects.test.mjs, first-install-state-parent.test.mjs and
// first-install-chain.test.mjs (taken out of first-install-r5-defects.test.mjs:60-95, plan D:/w/tmp/PLAN-drill-loop-root-20261123.md
// section 3, row "bing"). Real files only: functions, statements and top-level assignments are taken by AST from the package's own
// PowerShell and run in Windows PowerShell 5.1, not elevated, on a CI root under TEMP. Not a test file itself (no node:test here).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKOUT = path.resolve(RES, '..', '..');
export const HOST = path.join(RES, 'windows', 'first-install-host.ps1');
export const TPL = path.join(RES, 'reinstall', 'launcher', 'template.ps1');
export const INSTALL = path.join(RES, 'windows', 'install-resident.ps1');
export const VERIFY = path.join(RES, 'windows', 'verify-resident.ps1');
export const HEADLESS = path.join(RES, 'windows', 'companion-headless.ps1');
export const RV2 = path.resolve(RES, '..', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2');
export const MIGRATE = path.join(RV2, 'migrate-acl.ps1');
export const MODEL = path.join(RV2, 'acl-model.json');
// the generic helper's file list (test-pure-v2.ps1:13)
export const HELPER_CS = ['FormalPublicBoundaryV2.cs', 'FormalSession0V2.cs', 'ScmPidHandshakeV2.cs', 'NodeProfileV2.cs'].map(f => path.join(RV2, 'windows', f));
export const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
export const skip = process.platform === 'win32' ? false : 'Windows PowerShell 5.1 runs on Windows only';
export const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
export const tempDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

export const SID = 'S-1-5-21-111111111-2222222222-3333333333-';
export const OPERATOR = `${SID}1000`, CONTROLLER = `${SID}1007`, COMPANION = `${SID}1008`, STRANGER = `${SID}1099`;
export const RESIDENT = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';

// One Windows PowerShell 5.1 run of `command` (the parent's process scope: `policy`); its last stdout line is JSON. A command too long for
// one command line (32767 characters) runs from a script file (UTF-8 with BOM) under TEMP instead, removed afterwards.
export function ps(command, { policy = 'Bypass', raw = false } = {}) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.PSExecutionPolicyPreference;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const dir = encoded.length > 30_000 ? fs.mkdtempSync(path.join(os.tmpdir(), 'fi-ps-')) : null;
  if (dir) fs.writeFileSync(path.join(dir, 'run.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(command, 'utf8')]));
  let r;
  try {
    r = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', policy, ...(dir ? ['-File', path.join(dir, 'run.ps1')] : ['-EncodedCommand', encoded])],
      { cwd: RES, env, encoding: raw ? 'buffer' : 'utf8', windowsHide: true, timeout: 300_000, maxBuffer: 1 << 26 });
  } finally { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ifError(r.error);
  if (raw) return r;
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(String(r.stdout).trim().split(/\r?\n/).at(-1));
}

// The named functions and top-level assignments of a real file, dot-sourced into the script scope (a foreach does not open a scope).
// optional: a name the file does not hold is left out (an older commit of the file); one it holds twice still throws.
export const load = (file, fns = [], vars = [], { optional = false } = {}) => `$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(file)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ('PARSE_ERRORS:' + ${psLiteral(path.basename(file))}) }
foreach ($name in @(${fns.map(psLiteral).join(', ') || "''"})) { if (-not $name) { continue }
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($f.Count -eq 0 -and ${optional ? '$true' : '$false'}) { continue }
  if ($f.Count -ne 1) { throw ('FUNCTION_NOT_ONE:' + $name + ':' + $f.Count) }
  . ([scriptblock]::Create($f[0].Extent.Text))
}
foreach ($name in @(${vars.map(psLiteral).join(', ') || "''"})) { if (-not $name) { continue }
  $a = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Parent -is [Management.Automation.Language.NamedBlockAst] -and $x.Left.Extent.Text -ceq ('$' + $name) }, $false))
  if ($a.Count -eq 0 -and ${optional ? '$true' : '$false'}) { continue }
  if ($a.Count -ne 1) { throw ('ASSIGNMENT_NOT_ONE:' + $name + ':' + $a.Count) }
  . ([scriptblock]::Create($a[0].Extent.Text))
}
`;

export const PRELUDE = `$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0; $ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$webExt = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Set-Dacl([string]$p, [string]$sddl) { $s = New-Object Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access); [IO.Directory]::SetAccessControl($p, $s) }
# READ_CONTROL only (owner rights), never the attributes Get-Acl reads first: a child of a folder this account may not list is still read
function Dacl([string]$p) { [IO.Directory]::GetAccessControl($p, [Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) }
# The test account owns every folder it made (owner rights: READ_CONTROL, WRITE_DAC), so it can always give itself full control back to clean up.
function Restore-Mine([string[]]$dirs) { foreach ($d in $dirs) { if ([IO.Directory]::Exists($d)) { try { Set-Dacl $d ('D:(A;OICI;FA;;;' + $me + ')') } catch { } } } }
# Every folder under (and with) $root, each given back to this account before it is listed: what the cleanup needs whatever a run left.
function Restore-Tree([string]$root) { if (-not [IO.Directory]::Exists($root)) { return }; Restore-Mine @($root); foreach ($d in [IO.Directory]::GetDirectories($root)) { Restore-Tree $d } }
`;

// The host preparation's ci-root step (Invoke-HostPreparation, first-install-host.ps1), its own statements between Enter-Step 'ci-root' and
// Step 'ci-root' taken by AST and run in order, with the CI root moved to $fx: New-Dir is the fixture's, the one difference from the real
// one being where (a path outside the host's CI root is refused) and the owner (a test cannot set BA; the test account's own full-control
// entry is added so it can go on and clean up, as migrate-acl.ps1 -OfflineFixtureRoot does for what it makes). Whatever the step calls
// (Get-CiRootDirectories today, the inline table before r5) is the file's own. Sets $fx, $HostCiRoot, $made (relative paths) and
// $ciRootStatements (how many statements of the step ran).
export const ciRoot = (root) => `${load(HOST, ['Get-CiRootDirectories', 'Get-CiRootSddl', 'Get-FirstInstallSddl', 'Get-AdminOnlySddl', 'Get-SecretDirectorySddl'], ['CiRoot', 'FirstDir', 'CredDir', 'SecretTargets'], { optional: true })}
$HostCiRoot = $CiRoot
$fx = ${psLiteral(root)}
$operator = ${psLiteral(OPERATOR)}; $controllerSid = ${psLiteral(CONTROLLER)}
$made = @()
function New-Dir([string]$path, [string]$sddl) {
  if (-not ($path -ceq $HostCiRoot -or $path.StartsWith($HostCiRoot + '\\', [StringComparison]::OrdinalIgnoreCase))) { throw ('TABLE_PATH_OUTSIDE_CI_ROOT:' + $path) }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm(($sddl -replace '^O:BAG:BA', '') + '(A;OICI;FA;;;' + $me + ')')
  [void][IO.Directory]::CreateDirectory($fx + $path.Substring($HostCiRoot.Length), $ds); $script:made += $path.Substring($HostCiRoot.Length)
  'made'
}
$enter = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Enter-Step' -and $n.CommandElements.Count -eq 2 -and $n.CommandElements[1].Extent.Text -ceq "'ci-root'" }, $true))
if ($enter.Count -ne 1) { throw ('CI_ROOT_STEP_NOT_ONE:' + $enter.Count) }
$block = $enter[0].Parent.Parent; $at = $block.Statements.IndexOf($enter[0].Parent)
$ciRootStatements = 0; $closed = $false
for ($i = $at + 1; $i -lt $block.Statements.Count; $i++) {
  $s = $block.Statements[$i]
  if ($s.Extent.Text -clike "Step 'ci-root' *") { $closed = $true; break }
  . ([scriptblock]::Create($s.Extent.Text)); $ciRootStatements++
}
if (-not $closed -or $ciRootStatements -eq 0) { throw 'CI_ROOT_STEP_NOT_CLOSED' }
`;

// migrate-acl.ps1 (Source v2, frozen since 10-29) on the fixture, as the launcher's and the installer's children start it.
export const invokeMigrate = `function Invoke-Migrate([switch]$Apply) {
  $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${psLiteral(MIGRATE)}, '-ResidentSid', ${psLiteral(RESIDENT)}, '-OwnerSid', ${psLiteral(OPERATOR)}, '-ControllerSid', ${psLiteral(CONTROLLER)}, '-OfflineFixtureRoot', $fx)
  if ($Apply) { $a += '-Apply' }
  $o = & ${psLiteral(POWERSHELL)} @a | Out-String
  [ordered]@{ exit = $LASTEXITCODE; result = (Parse-LastLine $o) }
}
`;

// The generic helper's own rule on $fx: the real FormalPublicBoundaryV2.cs, compiled as test-pure-v2.ps1 compiles it, the node profile
// bound as PureTestsV2 binds it, then its own DangerFor and WriterAllowed on every "allow, not inherit-only" ACE of each of the six targets
// of FormalPublicBoundaryV2.cs:270 and every folder of its chain inside the CI root (the test account's own entries aside: owner BA and
// the two folders above the CI root cannot be made by a test). Sets $checked (real paths) and $refused.
export const formalBoundary = `Add-Type -Path @(${HELPER_CS.map(psLiteral).join(', ')}) -ReferencedAssemblies @($webExt.Location, 'System.Core')
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
`;
// The six chains of FormalPublicBoundaryV2.cs:270 inside the CI root, as $checked lists them when every folder is there.
export const SIX_CHAINS = ['', '\\formal-spool', '\\formal-spool\\incoming', '\\formal-spool\\outgoing', '\\state', '\\state\\v2', '\\state\\v2\\receipts', '\\state\\v2\\temp']
  .map(s => `C:\\ProgramData\\CluedIndependentCI${s}`).sort();

// first-install-r5-defects.test.mjs's fixture: the host's ci-root step on $fx, the launcher's spool and migrate-acl functions, the
// installer's companion spool rule, and Invoke-Migrate.
export const fixture = (root) => `${PRELUDE}
${ciRoot(root)}
${load(TPL, ['Get-Key', 'Sha256Bytes', 'Parse-Json', 'Parse-LastLine', 'Get-SpoolLeftovers', 'Get-SpoolRemainder', 'Get-SpoolBaseline', 'Test-AclMissingTargetAccepted'], ['ResidentRoot', 'Strict8', 'Js'])}
${load(INSTALL, ['Get-CompanionSpoolSddl'])}
$spool = Join-Path $fx 'formal-spool'
${invokeMigrate}`;
