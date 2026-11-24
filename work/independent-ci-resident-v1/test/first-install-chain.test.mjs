// The offline first-install chain (plan D:/w/tmp/PLAN-drill-loop-root-20261123.md section 3, row "bing"): the steps a first install runs,
// in their real order, on an empty CI root under TEMP, then every check the running node applies to what they left, so that a defect
// the next drill would meet (r4 spool folders missing, r8 the relay parent's DACL changed between plan and apply, r13 state's DACL) is red
// here first. Real files only, run by AST in Windows PowerShell 5.1, not elevated (first-install-fixture.mjs):
//   1. the host preparation's ci-root step (first-install-host.ps1), then the launcher's Step-Preflight (template.ps1) from its first
//      statement to its migrate-acl verdict: the spool baseline, the spool inventory, the real Invoke-Child starting migrate-acl.ps1's dry
//      run, the acceptance of the missing broker target;
//   2. install-resident.ps1: Build-Plan's ACL fields, the launcher's ACL read-back guard on them, then every Step of the file in its order;
//      the ones that write the CI root run, each other one is a named seam (services, accounts, tasks, WSL, TPM, compilers, package files);
//   3. the checks of the running node: the generic helper's FormalPublicBoundaryV2 on the six chains, the launcher's spool inventory, and
//      verify-resident.ps1's rules on the CI root (ci-root-resident-read-control, companion-account, companion-relay-parents,
//      state-parent-acl).
// Two static rules over the scripts the package carries (selectTree) close the two failures a drill met before any ACL: every script
// parses as the launcher reads it (drill 70e8be94: a BOM), and every PowerShell a script starts says -ExecutionPolicy Bypass (r4).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as U from '../rollout/fleet/universal.mjs';
import { CLOSURE } from '../rollout/fleet/facts.mjs';
import { CHECKOUT, COMPANION, CONTROLLER, HEADLESS, INSTALL, MIGRATE, MODEL, OPERATOR, POWERSHELL, PRELUDE, RESIDENT, SIX_CHAINS, TPL, VERIFY,
  ciRoot, formalBoundary, load, ps, psLiteral, skip, tempDir } from './first-install-fixture.mjs';

// The staged migrate-acl.ps1 the launcher and the installer start (seam): the real one, with -OfflineFixtureRoot on the fixture.
const wrapper = fx => `param([string]$ResidentSid, [string]$OwnerSid, [string]$ControllerSid, [switch]$Apply)
$a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ${psLiteral(MIGRATE)}, '-ResidentSid', $ResidentSid, '-OwnerSid', $OwnerSid, '-ControllerSid', $ControllerSid, '-OfflineFixtureRoot', ${psLiteral(fx)})
if ($Apply) { $a += '-Apply' }
& ${psLiteral(POWERSHELL)} @a
exit $LASTEXITCODE
`;

// 1. The host's ci-root step, then template.ps1's Step-Preflight statement by statement up to its migrate-acl verdict. Seams: the
//    runner service and the host's absences (the machine's own), the staging directory (a copy of acl-model.json and the wrapper), the
//    child environment's four folders (Step-Stage's), Stop-Launch (throws).
const launcher = (fx, work) => `${PRELUDE}
${ciRoot(fx)}
$NodeHostname = [Environment]::MachineName   # the launcher's parameter, read by $ChildEnv
${load(TPL, ['Get-Key', 'Sha256Bytes', 'Parse-Json', 'Parse-LastLine', 'Tail', 'Write-New', 'Write-Json', 'Invoke-Child', 'Get-SpoolLeftovers', 'Get-SpoolRemainder', 'Test-LeftoversAsPinned'], ['Strict8', 'Js', 'U8', 'PS', 'ChildEnv', 'ResidentRoot'])}
${load(TPL, ['Get-SpoolBaseline', 'Test-AclMissingTargetAccepted'], [], { optional: true })}
$tpl = $ast
function Stop-Launch([string]$code, $detail) { throw ('STOP_LAUNCH:' + $code) }
$work = ${psLiteral(work)}; $Stage = Join-Path $work 'stage'; $Out = Join-Path $work 'out'
foreach ($d in @($Stage, $Out, (Join-Path $work 'appdata'), (Join-Path $work 'localappdata'))) { [void][IO.Directory]::CreateDirectory($d) }
[IO.File]::Copy(${psLiteral(MODEL)}, (Join-Path $Stage 'acl-model.json'))
[IO.File]::WriteAllText((Join-Path $Stage 'migrate-acl.ps1'), ${psLiteral(wrapper(fx))})
$tmp = [IO.Path]::GetTempPath().TrimEnd('\\')   # migrate-acl.ps1 -OfflineFixtureRoot: under the child's own TEMP
$ChildEnv['TEMP'] = $tmp; $ChildEnv['TMP'] = $tmp; $ChildEnv['APPDATA'] = Join-Path $work 'appdata'; $ChildEnv['LOCALAPPDATA'] = Join-Path $work 'localappdata'
# Get-SpoolBaseline reads acl-model.json's production paths against the launcher's $ResidentRoot; the statements around it read the folder
# itself: the function sees the production value (template.ps1's own), everything else the fixture's
$realResidentRoot = $ResidentRoot
if (Get-Command Get-SpoolBaseline -CommandType Function -ErrorAction SilentlyContinue) {
  $spoolBaseline = ${'$'}{function:Get-SpoolBaseline}
  function Get-SpoolBaseline([string]$modelFile, [string]$ciRoot) { $ResidentRoot = $realResidentRoot; & $spoolBaseline $modelFile $ciRoot }
}
$ResidentRoot = Join-Path $fx 'resident'; $Spool = Join-Path $fx 'formal-spool'
$FleetFirstInstall = $true; $ResidentSid = ${psLiteral(RESIDENT)}; $OperatorSid = ${psLiteral(OPERATOR)}; $ControllerSid = ${psLiteral(CONTROLLER)}
$fn = @($tpl.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Step-Preflight' }, $true))
if ($fn.Count -ne 1) { throw ('STEP_PREFLIGHT_NOT_ONE:' + $fn.Count) }
$skipped = @(); $ran = 0; $closed = $false
foreach ($s in $fn[0].Body.EndBlock.Statements) {
  $t = $s.Extent.Text
  if ($t -cmatch 'Get-RunnerState|\\$runner\\b|Get-Absences|\\$absent\\b|\\$Done\\.Contains') { $skipped += ,(($t -split "\\r?\\n")[0]); continue }
  . ([scriptblock]::Create($t)); $ran++
  if ($t.Contains("'ACL_MIGRATION_PLAN_REFUSED'")) { $closed = $true; break }
}
ConvertTo-Json -Depth 8 -Compress -InputObject ([ordered]@{ ciRootStatements = $ciRootStatements; codes = @($codes); skipped = $skipped; ran = $ran; closed = $closed; made = $made; report = $report })`;

// The steps of install-resident.ps1 that write the CI root, run as they are; every other step is a seam, by name. A step the file holds
// that is in neither list is reported (unknown), so a new step is placed by hand, never silently skipped.
const RUN = ['directories', 'parent-acl', 'companion-relay-parent-acl', 'state-parent-acl', 'source-v2-acl', 'companion-account'];
const SEAMS = {
  'carry-forward': 'a first install carries nothing (no resident-uninstalled-* state)',
  'package-copy': 'package files: only the installed migrate-acl.ps1 is placed (the wrapper), for source-v2-acl',
  'service-hosts': 'csc.exe compiles the service hosts',
  'companion-supervisor': 'compiles the companion supervisor',
  'broker-config': 'the broker\'s config pins compiled binaries',
  services: 'sc.exe creates services',
  'resident-firewall': 'a firewall rule',
  'companion-launch': 'the launch file reads installed package files',
  'notifier-task': 'a scheduled task',
  'companion-task': 'a scheduled task',
  'upgrader-files': 'package files of the upgrader',
  'upgrader-host': 'csc.exe compiles the upgrader host',
  'upgrader-service': 'sc.exe creates the upgrader service',
  'node-secrets': 'the node\'s secrets (TPM, tokens)',
  'runner-unchanged': 'reads the runner service',
};

// 2. install-resident.ps1. Its functions, its own top-level names, Build-Plan's fields that the written steps read (the plan's other
//    fields read the package, services and the runner: seams; the launcher's INSTALLER_ACL_READBACK_WOULD_FAIL guard is for the
//    installer of 5417a04c only, $ExactAclReadbackGuard), then the fixture's one change (owner BA cannot be set by a test: the owner and group a test folder gets, and the test
//    account's own full-control entry so it can go on and clean up), then every Step in the file's order.
const installer = (fx, work) => `${PRELUDE}
$fx = ${psLiteral(fx)}; $work = ${psLiteral(work)}
$CiRoot = $fx; $Root = Join-Path $fx 'resident'
$OwnerSid = ${psLiteral(COMPANION)}; $OperatorSid = ${psLiteral(OPERATOR)}; $ControllerSid = ${psLiteral(CONTROLLER)}
$tokens = $null; $errors = $null
$install = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(INSTALL)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_ERRORS:install-resident.ps1' }
foreach ($f in @($install.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })) { . ([scriptblock]::Create($f.Extent.Text)) }
${load(INSTALL, [], ['ServiceName', 'CompanionAccountFile', 'CompanionAccountContract', 'CompanionSpoolFolders', 'AccountNode'])}
$bp = @($install.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Build-Plan' }, $true))
if ($bp.Count -ne 1) { throw 'BUILD_PLAN_NOT_ONE' }
$bs = $bp[0].Body.EndBlock.Statements
if ($bs[0].Extent.Text -cne '$res = Get-ServiceSid $ServiceName') { throw ('BUILD_PLAN_FIRST_STATEMENT:' + $bs[0].Extent.Text) }
. ([scriptblock]::Create($bs[0].Extent.Text))
$pkg = [pscustomobject]@{ ciSourceManifestSha256 = ('c' * 64) }   # seam: the package manifest
$pa = @($bs | Where-Object { $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq '$p' })
if ($pa.Count -ne 1) { throw 'BUILD_PLAN_P_NOT_ONE' }
$ht = $pa[0].Right.Find({ param($n) $n -is [Management.Automation.Language.HashtableAst] }, $true)
$plan = [ordered]@{}
foreach ($kv in $ht.KeyValuePairs) {
  $k = $kv.Item1.Extent.Text
  if (@('residentSid', 'ownerSid', 'controllerSid', 'ciSourceManifestSha256', 'acl', 'parentAcl', 'stateParent') -ccontains $k) { $plan[$k] = . ([scriptblock]::Create($kv.Item2.Extent.Text)) }
}
$p = $plan
foreach ($i in @($bs | Where-Object { $_ -is [Management.Automation.Language.IfStatementAst] -and $_.Clauses[0].Item1.Extent.Text -cmatch 'AccountNode' })) { . ([scriptblock]::Create($i.Extent.Text)) }
# the fixture's one change
$probe = Join-Path $work 'owner-probe'; [void][IO.Directory]::CreateDirectory($probe)
$og = [IO.Directory]::GetAccessControl($probe).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner, Group')
foreach ($k in @($plan.acl.Keys)) {
  if ([string]$plan.acl[$k] -cnotmatch '^O:BAG:BAD:') { throw ('PLAN_ACL_OWNER_NOT_BA:' + $k) }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  $ds.SetSecurityDescriptorSddlForm($og + ([string]$plan.acl[$k]).Substring(8) + '(A;OICI;FA;;;' + $me + ')')
  $plan.acl[$k] = $ds.GetSecurityDescriptorSddlForm('All')
}
if (Get-Command Get-StateParentSddl -CommandType Function -ErrorAction SilentlyContinue) {
  $stateSddl = \${function:Get-StateParentSddl}
  function Get-StateParentSddl([string]$controllerSid) { (& $stateSddl $controllerSid) -replace '^O:BAG:BA', '' }
}
$SEAM = @(${Object.keys(SEAMS).map(psLiteral).join(', ')}); $RUN = @(${RUN.map(psLiteral).join(', ')})
$receipt = [ordered]@{ steps = @() }
$order = @(); $seams = @(); $unknown = @(); $notRun = @(); $failed = $null
$steps = @($install.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -eq 3 -and $n.CommandElements[1] -is [Management.Automation.Language.StringConstantExpressionAst] }, $true))
foreach ($c in $steps) {
  $name = $c.CommandElements[1].Value; $order += $name
  $if = $null; for ($q = $c.Parent; $null -ne $q; $q = $q.Parent) { if ($q -is [Management.Automation.Language.IfStatementAst]) { $if = $q; break } }
  if ($if -and -not [bool](. ([scriptblock]::Create($if.Clauses[0].Item1.Extent.Text)))) { continue }
  if ($SEAM -ccontains $name) {
    $seams += $name
    if ($name -ceq 'package-copy' -and -not $failed) {
      $tool = Join-Path $Root ('source\\' + $plan.ciSourceManifestSha256 + '\\work\\actions-hosted-migration\\independent-ci-v1\\src\\resident-v2\\migrate-acl.ps1')
      [void][IO.Directory]::CreateDirectory((Split-Path -Parent $tool)); [IO.File]::WriteAllText($tool, ${psLiteral(wrapper(fx))})
    }
    continue
  }
  if ($RUN -cnotcontains $name) { $unknown += $name; continue }
  if ($failed) { $notRun += $name; continue }
  try { . ([scriptblock]::Create($c.Extent.Text)) } catch { $failed = [ordered]@{ step = $name; error = $_.Exception.Message }; continue }
  # the fixture's own entry on state, so that migrate-acl.ps1 (this account, offline) can make state\\v2 under it; taken off before the checks
  if ($name -ceq 'state-parent-acl') { $sd = Join-Path $fx 'state'; Set-Dacl $sd ((Dacl $sd) + '(A;;FA;;;' + $me + ')') }
}
$get = { param($k) if ($receipt.Contains($k)) { $receipt[$k] } else { $null } }
ConvertTo-Json -Depth 8 -Compress -InputObject ([ordered]@{ planKeys = @($plan.Keys); order = $order; steps = @($receipt.steps); seams = $seams; unknown = $unknown
  notRun = $notRun; failed = $failed; sourceV2Acl = (& $get 'sourceV2Acl'); stateParentAcl = (& $get 'stateParentAcl'); relayParents = (& $get 'companionRelayParents') })`;

// 3. The checks of the running node on what the install left. The fixture first takes the test account's own explicit entry off state
//    (it stays the owner).
const checks = fx => `${PRELUDE}
$fx = ${psLiteral(fx)}; $spool = Join-Path $fx 'formal-spool'; $stateDir = Join-Path $fx 'state'
if ([IO.Directory]::Exists($stateDir)) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor((Dacl $stateDir))
  for ($i = $raw.DiscretionaryAcl.Count - 1; $i -ge 0; $i--) { $a = $raw.DiscretionaryAcl[$i]; if (-not $a.IsInherited -and $a.SecurityIdentifier.Value -ceq $me) { $raw.DiscretionaryAcl.RemoveAce($i) } }
  Set-Dacl $stateDir $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
}
${load(TPL, ['Get-Key', 'Sha256Bytes', 'Parse-Json', 'Parse-LastLine', 'Get-SpoolLeftovers', 'Get-SpoolRemainder'], ['Strict8', 'Js'])}
$inventory = try { $found = Get-SpoolLeftovers $spool; $rem = Get-SpoolRemainder $spool $found; [ordered]@{ records = $found.Count; remainder = @($rem); error = $null } } catch { [ordered]@{ error = $_.Exception.GetType().Name + ': ' + $_.Exception.Message } }
${formalBoundary}
${load(VERIFY, ['Get-ServiceSid', 'Test-ParentAclRule'])}
${load(VERIFY, ['Invoke-StateParentEnsure'], [], { optional: true })}
${load(HEADLESS, ['Read-CompanionAccountRecord', 'Test-CompanionAccountRecord', 'Get-CompanionAccountProblem', 'Get-RelayParentAclPresence', 'Get-CompanionRelayParentPaths', 'Get-CompanionRelayParentsProblem'], ['CompanionAccountFile', 'CompanionAccountContract', 'CompanionSidPattern'])}
$verify = [ordered]@{}
$verify['ci-root-resident-read-control'] = try { Test-ParentAclRule (Get-Acl -LiteralPath $fx).Sddl (Get-ServiceSid 'CluedCIResident') } catch { 'THREW:' + $_.Exception.Message }
# companion-account: the account's own facts (it exists, enabled, not an administrator, hardened, its profile) are seams; the record and
# formal-spool\\incoming's DACL are what the install wrote
$nodeProfile = [pscustomobject]@{ ownerSid = ${psLiteral(COMPANION)}; ownerProfileDirectory = 'C:\\Users\\fixture'; controllerSid = ${psLiteral(CONTROLLER)} }
$record = try { Read-CompanionAccountRecord (Join-Path $fx 'resident') $nodeProfile } catch { 'COMPANION_ACCOUNT_RECORD_REFUSED' }
$verify['companion-account'] = $(if ($record -is [string]) { $record } elseif ($null -eq $record) { 'NO_RECORD' } else {
  Get-CompanionAccountProblem $nodeProfile $record ([pscustomobject]@{ Enabled = $true }) @() 'C:\\Users\\fixture' (Dacl (Join-Path $spool 'incoming')) @() })
# companion-relay-parents: the rule's two fixed paths, moved to the fixture
$relayPaths = @(Get-CompanionRelayParentPaths)
function Get-CompanionRelayParentPaths { @($fx, (Join-Path $fx 'formal-spool')) }
$verify['companion-relay-parents'] = Get-CompanionRelayParentsProblem ${psLiteral(COMPANION)}
# state-parent-acl: read only (verify-resident.ps1 elevated by hand), the installer's own rule by its sha256
$verify['state-parent-acl'] = $(if (Get-Command Invoke-StateParentEnsure -CommandType Function -ErrorAction SilentlyContinue) {
  try { $sp = Invoke-StateParentEnsure (Join-Path $fx 'resident') ${psLiteral(CONTROLLER)} ${psLiteral(INSTALL)} (Get-FileHash -Algorithm SHA256 -LiteralPath ${psLiteral(INSTALL)}).Hash.ToLowerInvariant()
    [ordered]@{ ok = ($sp.action -ceq 'none' -or $sp.wrote); action = $sp.action; after = $sp.after } } catch { 'STATE_PARENT_ENSURE_REFUSED:' + $_.Exception.Message } } else { 'NOT_IN_THIS_COMMIT' })
ConvertTo-Json -Depth 8 -Compress -InputObject ([ordered]@{ inventory = $inventory; checked = $checked; refused = $refused; verify = $verify; relayPaths = $relayPaths })`;

const show = v => JSON.stringify(v, null, 1);

test('chain: host ci-root, launcher preflight, install plan and apply, then the helper\'s rule, the spool inventory and verify-resident\'s rules all hold', { skip, timeout: 900_000 }, (t) => {
  const root = tempDir(t, 'fi-chain-');
  const fx = path.join(root, 'ci'), work = path.join(root, 'launch');
  try {
    const host = ps(launcher(fx, work));
    const inst = ps(installer(fx, work));
    const after = ps(checks(fx));
    // 1. host preparation and the launcher's preflight: no stop code (r4: SPOOL_INVENTORY_FAILED, then ACL_MIGRATION_PLAN_REFUSED)
    assert.ok(host.ciRootStatements !== 0 && host.closed && host.ran > 0, show(host));
    assert.deepEqual(host.codes, [], `launcher preflight: ${show(host.report)}\nmade: ${show(host.made)}`);
    assert.equal(host.skipped.length, 7, `the preflight's seams are the runner and the host's absences only: ${show(host.skipped)}`);
    assert.equal(host.report.migrateAcl.code, 'ACL_TARGET_MISSING', show(host.report.migrateAcl));   // residentroker comes with the install
    // 2. the installer: every step that writes the CI root (r8: companion-relay-parent-acl)
    assert.equal(inst.failed, null, `install step failed: ${show(inst.failed)}\nsteps: ${show(inst.steps)}`);
    assert.deepEqual(inst.steps, inst.order.filter(s => RUN.includes(s)), show(inst));
    assert.equal(inst.sourceV2Acl?.status, 'SOURCE_V2_ACL_MIGRATED', show(inst.sourceV2Acl));
    // 3. what the running node checks (r13: the helper refuses state)
    assert.deepEqual(after.inventory, { records: 0, remainder: [], error: null }, show(after.inventory));
    assert.deepEqual([...after.checked].sort(), SIX_CHAINS, show(after));
    assert.deepEqual(after.refused, [], `FormalPublicBoundaryV2 refuses: ${show(after.refused)}`);
    assert.equal(after.verify['ci-root-resident-read-control'], true, show(after.verify));
    assert.equal(after.verify['companion-account'], null, show(after.verify));
    assert.deepEqual(after.relayPaths, ['C:\\ProgramData\\CluedIndependentCI', 'C:\\ProgramData\\CluedIndependentCI\\formal-spool']);
    assert.equal(after.verify['companion-relay-parents'], null, show(after.verify));
    const sp = after.verify['state-parent-acl'];
    if (sp !== 'NOT_IN_THIS_COMMIT') assert.deepEqual([sp?.ok, sp?.action], [true, 'none'], show(sp));
    // last: every step of the installer is placed (run or a named seam), and every seam is still a step of the file
    assert.deepEqual(inst.unknown, [], `a step neither run nor a named seam: ${show(inst.unknown)}`);
    assert.deepEqual(Object.keys(SEAMS).filter(s => !inst.order.includes(s)), [], 'a seam the installer no longer holds');
  } finally {
    ps(`${PRELUDE}Restore-Tree ${psLiteral(fx)}; Restore-Tree ${psLiteral(work)}; '{}'`);
  }
});

// The scripts the package carries: the real tree through the real selectTree (package-ps1-ascii.test.mjs reads it the same way).
async function packageScripts() {
  const out = spawnSync('git', ['-C', CHECKOUT, 'ls-files', '-s', '-z'], { maxBuffer: 1 << 28 });
  assert.equal(out.status, 0, String(out.stderr));
  const listing = new Map();
  for (const rec of out.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t'); const [mode, oid] = rec.slice(0, tab).split(' ');
    listing.set(rec.slice(tab + 1), { mode, oid });
  }
  const read = async paths => new Map(await Promise.all(paths.map(async p => [p, await fs.promises.readFile(path.join(CHECKOUT, ...p.split('/')))])));
  return (await U.selectTree(listing, read)).filter(p => /\.(?:ps1|psm1|psd1)$/i.test(p));
}
const listFile = (t, list) => { const f = path.join(tempDir(t, 'fi-chain-list-'), 'list.json'); fs.writeFileSync(f, JSON.stringify(list)); return f; };

// Drill 70e8be94 (launcher VERIFY_SCRIPT_PARSE_ERRORS): the launcher reads a package script as UTF8Encoding($false).GetString(bytes) and
// parses that text (Read-VerifySecretHelpers), which keeps a BOM. Every script the package carries parses so in Windows PowerShell 5.1.
test('static: every PowerShell script of the package parses in Windows PowerShell 5.1 as the launcher reads it', { skip }, async (t) => {
  const scripts = await packageScripts();
  assert.ok(scripts.length > 10, `${scripts.length} scripts`);
  const r = ps(`$ErrorActionPreference = 'Stop'; $U8 = New-Object Text.UTF8Encoding($false); $bad = @()
foreach ($rel in @(Get-Content -Raw -LiteralPath ${psLiteral(listFile(t, scripts))} | ConvertFrom-Json | ForEach-Object { $_ })) {
  $tk = $null; $er = $null
  [void][Management.Automation.Language.Parser]::ParseInput($U8.GetString([IO.File]::ReadAllBytes((Join-Path ${psLiteral(CHECKOUT)} $rel))), [ref]$tk, [ref]$er)
  if ($er.Count) { $bad += ,[ordered]@{ file = $rel; errors = $er.Count; first = ('line ' + $er[0].Extent.StartLineNumber + ': ' + $er[0].ErrorId) } }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($bad)`);
  assert.deepEqual(r, [], show(r));
});

// r4: every PowerShell a package script starts carries -ExecutionPolicy Bypass. A start: a command whose name is powershell(.exe) or pwsh,
// or a variable holding such a path (assigned or a parameter default, in the same function or the script); Start-Process with one;
// a call of a function of the same file with one as an argument (the callee's body is the evidence); a ProcessStartInfo-like .FileName or
// .Path given one (the enclosing function is the evidence). The evidence, with the values of its variables two levels deep and the bodies
// of the same file's functions it calls, holds "-ExecutionPolicy" and "Bypass". The frozen Source closure is not scanned (its bytes are
// pinned; the host's execution policy baseline covers it, and its probe is the one start without Bypass, by design).
const SCANNER = String.raw`param([string]$Checkout, [string]$ListFile)
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0
$U8 = New-Object Text.UTF8Encoding($false); $NL = [string][char]10
$exe = '(?i)(^|[\\/])(powershell|pwsh)(\.exe)?$'
$bypass = '(?i)-ExecutionPolicy\W{0,6}Bypass'
$files = @(Get-Content -Raw -LiteralPath $ListFile | ConvertFrom-Json | ForEach-Object { $_ })
$sites = New-Object Collections.Generic.List[object]
function Get-Fn($n) { for ($p = $n.Parent; $null -ne $p; $p = $p.Parent) { if ($p -is [Management.Automation.Language.FunctionDefinitionAst]) { return $p } }; $null }
function Get-ScopeKey($n) { $f = Get-Fn $n; if ($f) { [string]$f.Extent.StartOffset } else { 'S' } }
function Get-VarName($v) { $v.VariablePath.UserPath.ToLowerInvariant() -replace '^(script|global|local|private):', '' }
foreach ($rel in $files) {
  [Console]::Error.WriteLine($rel)
  $text = $U8.GetString([IO.File]::ReadAllBytes((Join-Path $Checkout $rel))).TrimStart([char]0xFEFF)
  $tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tk, [ref]$er)
  $fns = @{}; foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $fns[$f.Name.ToLowerInvariant()] = $f }
  $assign = @{}
  $put = { param([string]$k, $r) if (-not $assign.ContainsKey($k)) { $assign[$k] = New-Object Collections.Generic.List[object] }; $assign[$k].Add($r) }
  foreach ($a in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] }, $true)) {
    $l = $a.Left; if ($l -is [Management.Automation.Language.ConvertExpressionAst]) { $l = $l.Child }
    if ($l -is [Management.Automation.Language.VariableExpressionAst] -and (Get-VarName $l) -cne 'null') { & $put ((Get-ScopeKey $a) + '|' + (Get-VarName $l)) $a.Right }
  }
  foreach ($p in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.ParameterAst] -and $null -ne $n.DefaultValue }, $true)) { & $put ((Get-ScopeKey $p) + '|' + (Get-VarName $p.Name)) $p.DefaultValue }
  $lookup = { param($v) $n = Get-VarName $v; foreach ($k in @(((Get-ScopeKey $v) + '|' + $n), ('S|' + $n))) { if ($assign.ContainsKey($k)) { return $k } }; $null }
  $holders = @{}
  $isRef = { param($n) (($n -is [Management.Automation.Language.StringConstantExpressionAst] -or $n -is [Management.Automation.Language.ExpandableStringExpressionAst]) -and $n.Value -match $exe) -or
    ($n -is [Management.Automation.Language.VariableExpressionAst] -and $($k = & $lookup $n; $null -ne $k -and $holders.ContainsKey($k))) }
  # a value, not what running something printed: no command in it but Join-Path
  $launches = { param($r) @($r.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ine 'Join-Path' }, $true)).Count -gt 0 }
  do { $grew = $false
    foreach ($k in @($assign.Keys)) { if ($holders.ContainsKey($k)) { continue }
      foreach ($r in $assign[$k]) { if (@($r.FindAll({ param($n) & $isRef $n }, $true)).Count -and -not (& $launches $r)) { $holders[$k] = $true; $grew = $true; break } } }
  } while ($grew)
  $resolve = { param($node, [int]$depth)
    $t = $node.Extent.Text
    if ($depth -gt 0) {
      foreach ($v in $node.FindAll({ param($n) $n -is [Management.Automation.Language.VariableExpressionAst] }, $true)) { $k = & $lookup $v; if ($k) { foreach ($r in $assign[$k]) { $t += $NL + (& $resolve $r ($depth - 1)) } } }
      foreach ($c in $node.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)) { $cn = $c.GetCommandName(); if ($cn -and $fns.ContainsKey($cn.ToLowerInvariant())) { $t += $NL + $fns[$cn.ToLowerInvariant()].Extent.Text } }
    }
    $t }
  $add = { param($n, [string]$kind, [string]$evidence, [string]$via)
    $f = Get-Fn $n
    $sites.Add([ordered]@{ file = $rel; line = $n.Extent.StartLineNumber; function = $(if ($f) { $f.Name } else { $null }); via = $via; kind = $kind; bypass = ($evidence -match $bypass); text = $n.Extent.Text.Substring(0, [Math]::Min(160, $n.Extent.Text.Length)) }) }
  foreach ($c in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)) {
    $els = @($c.CommandElements); $rest = @($els | Select-Object -Skip 1); $name = $c.GetCommandName()
    if (& $isRef $els[0]) { $ev = ''; foreach ($e in $rest) { $ev += $NL + (& $resolve $e 2) }; & $add $c 'invoke' $ev $null; continue }
    if ($name -and $name -ieq 'Start-Process' -and @($rest | Where-Object { & $isRef $_ }).Count) { & $add $c 'start-process' (& $resolve $c 2) $null; continue }
    if ($name -and $fns.ContainsKey($name.ToLowerInvariant()) -and @($rest | Where-Object { & $isRef $_ }).Count) {
      $callee = $fns[$name.ToLowerInvariant()]; & $add $c 'call' ((& $resolve $c 2) + $NL + (& $resolve $callee.Body 1)) $callee.Name }
  }
  foreach ($a in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [Management.Automation.Language.MemberExpressionAst] -and $n.Left.Member.Extent.Text -match '^(?i)(FileName|Path)$' }, $true)) {
    if (@($a.Right.FindAll({ param($n) & $isRef $n }, $true)).Count) { $f = Get-Fn $a; & $add $a 'start-info' $(if ($f) { $f.Extent.Text } else { $a.Parent.Extent.Text }) $null }
  }
}
ConvertTo-Json -Depth 4 -Compress -InputObject $sites.ToArray()`;
// The one start without Bypass by design: the host preparation's probe of the machine's own policy (ps-execution-policy.test.mjs PROBE).
const PROBE = { file: 'work/independent-ci-resident-v1/windows/first-install-host.ps1', via: 'Invoke-ExecutionPolicyBaseline' };

test('static: every PowerShell a package script starts carries -ExecutionPolicy Bypass', { skip }, async (t) => {
  const closure = JSON.parse(fs.readFileSync(path.join(CHECKOUT, ...CLOSURE.split('/')), 'utf8')).paths;
  const scripts = (await packageScripts()).filter(p => !closure.includes(p));
  const sites = ps(`& { ${SCANNER} } ${psLiteral(CHECKOUT)} ${psLiteral(listFile(t, scripts))}`);
  const isProbe = s => s.file === PROBE.file && s.via === PROBE.via;
  assert.deepEqual(sites.filter(s => !s.bypass && !isProbe(s)), [], 'a PowerShell started without -ExecutionPolicy Bypass');
  // the scan sees the starts it must: the launcher's children and the installer's migrate-acl
  const at = (file, kind, fn) => sites.some(s => s.file.endsWith(file) && s.kind === kind && s.function === fn);
  assert.ok(at('/reinstall/launcher/template.ps1', 'start-info', 'Invoke-Child'), show(sites));
  assert.ok(sites.some(s => s.file.endsWith('/windows/install-resident.ps1') && s.kind === 'invoke' && /migrate-acl|\$tool/.test(s.text)), show(sites));
  assert.equal(sites.filter(isProbe).length, 1, `the probe exception is one start: ${show(sites.filter(isProbe))}`);
});

// Task 11092b8b (run 45201050855: 300582 ms, spawnSync powershell.exe ETIMEDOUT): the shared ps() sets no wall-clock limit, and when a
// run does fail it says what PowerShell last wrote. A spawn "slower than any finite limit": a call that sets a timeout gets ETIMEDOUT
// at once; one without gets a normal result.
const etimedout = (exe, args) => Object.assign(new Error(`spawnSync ${exe} ETIMEDOUT`), { code: 'ETIMEDOUT', errno: -4039, syscall: `spawnSync ${exe}`, path: exe, spawnargs: args });
const slowerThanAnyLimit = (exe, args, options = {}) => options.timeout === undefined
  ? { status: 0, signal: null, stdout: '{"ok":true}\n', stderr: '', error: undefined }
  : { status: null, signal: null, stdout: '', stderr: '', error: etimedout(exe, args) };

test('ps(): a PowerShell run sets no wall-clock limit (a busy machine is not a red)', () => {
  assert.deepEqual(ps(`'{"ok":true}'`, { spawn: slowerThanAnyLimit }), { ok: true });
});

test('ps(): a failed spawn reports the last lines PowerShell wrote to stderr', () => {
  const stderr = Array.from({ length: 25 }, (_, i) => `progress-line-${i + 1}`).join('\r\n') + '\r\n';
  const failed = (exe, args) => ({ status: null, signal: 'SIGTERM', stdout: '', stderr, error: etimedout(exe, args) });
  const message = (() => { try { ps(`'{}'`, { spawn: failed }); } catch (e) { return String(e.message); } return 'did not throw'; })();
  assert.match(message, /ETIMEDOUT/);
  assert.match(message, /progress-line-25/, message);
  assert.match(message, /progress-line-6\b/, message);
  assert.doesNotMatch(message, /progress-line-5\b/, 'the last 20 lines, not the whole stream');
});
