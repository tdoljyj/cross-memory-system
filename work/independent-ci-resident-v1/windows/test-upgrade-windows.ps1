<#
  Offline checks of the Windows face of the in-place upgrade channel (018da927 B2). Nothing on the host is read or changed: every
  script is parsed, its functions are taken from the real files by AST and run against data and directories in the NEW scratch
  directory given by the caller; the C# host and its pure tests are compiled there with the in-box csc and run there.
  - upgrade-apply.ps1: takes no path or command string (parameter AST); every mutating sc call is exit-checked; the functions it shares with
    install-resident.ps1 (command-line formulas, compile recipe, broker config, companion task, node profile) are the same text;
    plan -> binPath / Arguments round trips and refusals; the plan and generation records read from a scratch root (sha, links, shapes);
    the generation's files must be in place; failure codes never carry free text; Recover is a dry run unless -Apply.
  - install-resident.ps1: plan /8, receipt /6, the dry run and plan hash unchanged, the new steps in order, generation-1 after the
    receipt, no "supabase" anywhere in its text, the upgrader section of a scratch package (accepted and refused), package /4 checks,
    the new directories ACE by ACE (and created in the scratch directory, read back), the generation files hash against node's own.
  - verify-resident.ps1: receipts /5 and /6, the new checks, the version-facts rule; uninstall-resident.ps1 stops and deletes the upgrader.
  - request-upgrade.ps1: inbox name, request bytes (A3 order, <= 2 KiB), package directory rule.
  - UpgraderServiceHost.cs: compiled with install's own function, UpgraderHostPureTests.cs run; the command line install registers is
    parsed by the host as the SCM would hand it over.
  powershell -NoProfile -ExecutionPolicy Bypass -File test-upgrade-windows.ps1 -Scratch <new empty directory> [-NodeExe <node.exe>]
#>
param([Parameter(Mandatory)][string]$Scratch, [string]$NodeExe = 'node')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Scratch) { if (@(Get-ChildItem -LiteralPath $Scratch -Force).Count) { throw 'EMPTY_SCRATCH_REQUIRED' } } else { [void][IO.Directory]::CreateDirectory($Scratch) }
$Scratch = (Resolve-Path -LiteralPath $Scratch).ProviderPath
$here = $PSScriptRoot
$n = 0
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }
function Test-Refused([scriptblock]$body, [string]$code) { try { & $body; return $false } catch { return $_.Exception.Message -ceq $code } }

# 1. Parse; functions and top-level assignments by file.
$functions = @{}; $assignments = @{}; $asts = @{}; $texts = @{}
foreach ($file in @('upgrade-apply.ps1', 'install-resident.ps1', 'verify-resident.ps1', 'uninstall-resident.ps1', 'request-upgrade.ps1')) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here $file), [ref]$tokens, [ref]$errors)
  Yes ($errors.Count -eq 0) ('parse:' + $file)
  $asts[$file] = $ast; $texts[$file] = [IO.File]::ReadAllText((Join-Path $here $file))
  foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$file + ':' + $f.Name] = $f.Extent.Text }
  foreach ($s in $ast.EndBlock.Statements) { if ($s -is [Management.Automation.Language.AssignmentStatementAst] -and $s.Left -is [Management.Automation.Language.VariableExpressionAst]) { $assignments[$file + ':' + $s.Left.VariablePath.UserPath] = $s.Extent.Text } }
}
# Return the text to dot-source at script scope: . (Use <file> <names>)
function Use([string]$file, [string[]]$names) { $parts = @(foreach ($name in $names) { Yes ($functions.ContainsKey($file + ':' + $name)) ('present:' + $file + ':' + $name); $functions[$file + ':' + $name] }); [scriptblock]::Create(($parts -join "`n")) }
function UseVar([string]$file, [string[]]$names) { $parts = @(foreach ($name in $names) { Yes ($assignments.ContainsKey($file + ':' + $name)) ('assigned:' + $file + ':' + $name); $assignments[$file + ':' + $name] }); [scriptblock]::Create(($parts -join "`n")) }
$apply = $texts['upgrade-apply.ps1']; $install = $texts['install-resident.ps1']; $verify = $texts['verify-resident.ps1']; $uninstall = $texts['uninstall-resident.ps1']
$codeOf = { param([string]$t) (@($t -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n") }

# 2. One text for what install and the upgrader share (a rollback is executed by the frozen copy, so both must build the same thing).
foreach ($name in @('Sha256Bytes', 'Sha256Text', 'Sha256File', 'Invoke-Sc', 'Get-DaclPart', 'Assert-ServiceBinary', 'Write-New', 'Assert-NodeProfile', 'ConvertTo-NodeProfileCanonical',
    'Get-CompanionAction', 'Get-ResidentBinPath', 'Get-BrokerBinPath', 'Get-BrokerConfigJson', 'Invoke-CompileRecipe', 'Register-CompanionTask', 'Get-CompanionTaskSddl')) {
  Yes ($functions.ContainsKey('install-resident.ps1:' + $name) -and $functions['install-resident.ps1:' + $name] -ceq $functions['upgrade-apply.ps1:' + $name]) ('shared-with-install:' + $name)
}
foreach ($name in @('Root', 'OriginalBinary', 'Sc', 'Csc', 'GenericHelper', 'CompanionJobHost', 'SourceV2Windows', 'NodeProfileKeys')) {
  Yes ($assignments.ContainsKey('upgrade-apply.ps1:' + $name) -and $assignments['upgrade-apply.ps1:' + $name] -ceq $assignments['install-resident.ps1:' + $name]) ('same-constant:' + $name)
}
foreach ($name in @('Get-UpgraderBinPath', 'Get-GenerationFilesSha256')) { Yes ($functions['install-resident.ps1:' + $name] -ceq $functions['verify-resident.ps1:' + $name]) ('shared-with-verify:' + $name) }
foreach ($name in @('Sha256Bytes', 'Get-Field')) { Yes ($functions.ContainsKey('request-upgrade.ps1:' + $name)) ('request-has:' + $name) }

# 3. upgrade-apply.ps1 takes no path and no command string: every parameter is a fixed set, a fixed pattern, an int range or a switch.
$params = @($asts['upgrade-apply.ps1'].ParamBlock.Parameters)
Yes ((@($params | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ',') -ceq 'Action,OpId,PlanSha256,Generation,ExpectPausedSha256,Recover,Apply') 'apply-parameters-exactly'
foreach ($p in $params) {
  $attrs = @($p.Attributes | ForEach-Object { $_.TypeName.Name })
  $type = $p.StaticType.FullName
  $bounded = ($type -ceq 'System.Management.Automation.SwitchParameter') -or ($attrs -ccontains 'ValidateSet') -or ($attrs -ccontains 'ValidatePattern') -or (($type -ceq 'System.Int32') -and ($attrs -ccontains 'ValidateRange'))
  Yes $bounded ('apply-parameter-bounded:' + $p.Name.VariablePath.UserPath)
}
Yes ($apply.Contains("[ValidatePattern('^[0-9a-f]{64}$')][string]`$PlanSha256") -and $apply.Contains('upgrade\ops\') -and $apply.Contains("'010-accept.plan.json'")) 'apply-reads-only-the-op-plan-by-its-sha'
$applyCode = & $codeOf $apply
foreach ($bad in @('Invoke-Expression', 'iex ', '-Command', 'Start-Process', 'Add-Type', 'DownloadString', 'Invoke-WebRequest', 'Invoke-RestMethod')) { Yes (-not $applyCode.Contains($bad)) ('apply-never:' + $bad) }
$raw = @([regex]::Matches($apply, '& \$Sc (?!@scArgs)([a-z]+)') | ForEach-Object { $_.Groups[1].Value })
Yes ((@($raw | Where-Object { @('qc', 'queryex') -cnotcontains $_ }).Count) -eq 0) 'apply-every-mutating-sc-call-is-exit-checked'
Yes ($apply.Contains("@('config', `$pair[0], 'binPath=', `$pair[1].Replace('`"', '\`"'))") -and $apply.Contains('Assert-ServiceBinary $pair[0] $pair[1]')) 'apply-switch-writes-then-reads-back'
Yes ($apply.Contains("[IO.Path]::GetFullPath(`$PSCommandPath) -match `$InstalledCopy") -and $apply.Contains("'S-1-5-18'")) 'apply-installed-copy-and-system-only'
$recover = $functions['upgrade-apply.ps1:Invoke-Recover']
Yes ($recover.IndexOf('if (-not $apply) { return $view }') -gt 0 -and $recover.IndexOf('if (-not $apply) { return $view }') -lt $recover.IndexOf('$script:Touched = $true') -and $recover.Contains('ELEVATED_OWNER_TOKEN_REQUIRED')) 'recover-is-a-dry-run-unless-apply'
Yes ($recover.Contains('startsAnything = $false') -and -not $recover.Contains('Invoke-StartServices') -and -not $recover.Contains("'start'")) 'recover-starts-nothing'
Yes ($functions['upgrade-apply.ps1:Invoke-StopServices'].Contains('Test-ExecutorAlive $Root') -and -not $functions['upgrade-apply.ps1:Invoke-StopServices'].Contains('Stop-Process')) 'stop-waits-for-the-executor-never-kills-it'
$stopFn = $functions['upgrade-apply.ps1:Invoke-StopServices']
Yes ($stopFn.IndexOf("@('stop', `$ServiceName)") -lt $stopFn.IndexOf("@('stop', `$BrokerName)")) 'stop-resident-before-broker'
$startFn = $functions['upgrade-apply.ps1:Invoke-StartServices']
Yes ($startFn.IndexOf("@('start', `$BrokerName)") -lt $startFn.IndexOf("@('start', `$ServiceName)")) 'start-broker-before-resident'

# 4. Pure: the command lines, the plan, the generation records (functions of upgrade-apply.ps1).
. (UseVar 'upgrade-apply.ps1' @('Root', 'OriginalBinary', 'Sc', 'GenericHelper', 'CompanionJobHost', 'SourceV2Windows', 'SourceV2Files', 'PlanContract', 'CompileContract', 'PackageSlots', 'GeneratedSlots', 'ReceiptSlot', 'NodeProfileKeys'))
$ProdRoot = $Root
. (Use 'upgrade-apply.ps1' @('Sha256Bytes', 'Sha256Text', 'Sha256File', 'Get-DaclPart', 'Write-New', 'Assert-NodeProfile', 'ConvertTo-NodeProfileCanonical', 'Get-CompanionAction', 'Get-ResidentBinPath', 'Get-BrokerBinPath',
  'Get-BrokerConfigJson', 'Invoke-CompileRecipe', 'Get-Field', 'Test-Int', 'Test-Hex', 'Test-PackagePath', 'ConvertFrom-ResidentBinPath', 'ConvertFrom-BrokerBinPath', 'ConvertFrom-CompanionArguments', 'ConvertFrom-ScState', 'ConvertFrom-ScBinPath',
  'Test-CompanionCommandLine', 'Read-SmallFile', 'ConvertFrom-StrictJson', 'Assert-NoLinkChain', 'Assert-UpgradePlan', 'Read-UpgradePlan', 'Find-PlanSlot', 'Read-StagedManifest', 'Find-CompileInput', 'Read-CompileRecord', 'ConvertTo-GenerationView', 'Read-GenerationRecord', 'Get-PlanGeneration', 'Read-CurrentRecord',
  'Assert-GenerationInPlace', 'Get-Match', 'Get-FailureCode'))
$h = { param([string]$c) $c * 64 }
$rb = Get-ResidentBinPath $ProdRoot (& $h 'a') (& $h 'b') (& $h 'c') (& $h 'd')
Yes ($rb -ceq ('"C:\ProgramData\CluedIndependentCI\resident\bin\ResidentServiceHost.exe" "C:\ProgramData\CluedIndependentCI\resident" ' + (& $h 'a') + ' "C:\ProgramData\CluedIndependentCI\resident\runtime\node.exe" ' + (& $h 'b') + ' "C:\ProgramData\CluedIndependentCI\resident\resident\' + (& $h 'c') + '\src\service-main.mjs" ' + (& $h 'd'))) 'resident-binpath-formula'
$pr = ConvertFrom-ResidentBinPath $ProdRoot $rb
Yes ($null -ne $pr -and $pr.policySha256 -ceq (& $h 'a') -and $pr.nodeSha256 -ceq (& $h 'b') -and $pr.residentManifestSha256 -ceq (& $h 'c') -and $pr.entrySha256 -ceq (& $h 'd')) 'resident-binpath-round-trip'
foreach ($bad in @(($rb + ' '), ($rb + ' --x'), $rb.Replace((& $h 'a'), (& $h 'A')), $rb.Replace('\resident" ', '\other" '), $rb.Replace('ResidentServiceHost.exe', 'Other.exe'), $rb.Replace('service-main.mjs', 'companion-main.mjs'), $rb.Replace('" "C:\ProgramData', '"  "C:\ProgramData'), ('"x" ' + $rb), '')) {
  Yes ($null -eq (ConvertFrom-ResidentBinPath $ProdRoot $bad)) ('resident-binpath-refused:' + $bad.Length)
}
$bb = Get-BrokerBinPath $ProdRoot (& $h 'e') (& $h 'f')
Yes ($bb -ceq ('"C:\ProgramData\CluedIndependentCI\resident\bin\SwapBroker.exe" "C:\ProgramData\CluedIndependentCI\resident" ' + (& $h 'e') + ' ' + (& $h 'f'))) 'broker-binpath-formula'
$pb = ConvertFrom-BrokerBinPath $ProdRoot $bb
Yes ($null -ne $pb -and $pb.brokerConfigSha256 -ceq (& $h 'e') -and $pb.nodeProfileSha256 -ceq (& $h 'f')) 'broker-binpath-round-trip'
foreach ($bad in @(($bb + ' x'), $bb.Replace((& $h 'f'), ''), $bb.Replace('SwapBroker', 'Swap'), ($bb -replace ' [0-9a-f]{64} ', ' '))) { Yes ($null -eq (ConvertFrom-BrokerBinPath $ProdRoot $bad)) 'broker-binpath-refused' }
$ca = Get-CompanionAction $ProdRoot (& $h 'c') (& $h '9')
$pc = ConvertFrom-CompanionArguments $ProdRoot $ca.arguments
Yes ($null -ne $pc -and $pc.residentManifestSha256 -ceq (& $h 'c') -and $pc.companionConfigSha256 -ceq (& $h '9')) 'companion-arguments-round-trip'
foreach ($bad in @(($ca.arguments + ' --extra'), $ca.arguments.Replace('--headless ', ''), $ca.arguments.Replace('companion-main', 'service-main'), $ca.arguments.Replace('--root "C:\ProgramData\CluedIndependentCI\resident"', '--root "C:\x"'))) {
  Yes ($null -eq (ConvertFrom-CompanionArguments $ProdRoot $bad)) 'companion-arguments-refused'
}
Yes (Test-CompanionCommandLine ('"C:\ProgramData\CluedIndependentCI\resident\runtime\node.exe" ' + $ca.arguments.Substring($ca.arguments.IndexOf('" "') + 2)) $ProdRoot) 'companion-process-command-line'
Yes (-not (Test-CompanionCommandLine ('"C:\ProgramData\CluedIndependentCI\resident\runtime\node.exe" "' + $ProdRoot + '\resident\' + (& $h 'c') + '\src\service-main.mjs" --root "' + $ProdRoot + '" --policy-sha256 ' + (& $h 'a')) $ProdRoot)) 'resident-process-is-not-the-companion'
# Task 42fe5ae4 (op 8e3b3e1b): the node child conhost --headless really starts has no quotes. This is TURING's companion as
# Win32_Process.CommandLine showed it on 2026-11-01 (PID 29028, parent conhost 44520 running the task's quoted arguments).
$real = 'C:\ProgramData\CluedIndependentCI\resident\runtime\node.exe C:\ProgramData\CluedIndependentCI\resident\resident\716587c3dfd689e6a6d517b2bbddef1c4033ec2d79f1689b7c5de96f8fdd1142\src\companion-main.mjs --root C:\ProgramData\CluedIndependentCI\resident --config-sha256 d9beb17b0b2dc35fd0695afc4ed5147716d12de9b33802dc94bffc4d08eace28'
Yes (Test-CompanionCommandLine $real $ProdRoot) 'companion-real-conhost-child-command-line'
Yes (Test-CompanionCommandLine ('"C:\ProgramData\CluedIndependentCI\resident\runtime\node.exe" ' + $ca.arguments.Substring($ca.arguments.IndexOf('" "') + 2).Replace('"', '')) $ProdRoot) 'companion-mixed-quoting'
foreach ($bad in @($real.Replace('companion-main', 'service-main'), $real.Replace('--root C:\ProgramData\CluedIndependentCI\resident', '--root C:\ProgramData\CluedIndependentCI'),
    ($real + ' --extra'), ('x ' + $real), $real.Replace('runtime\node.exe', 'runtime\other.exe'), $real.Replace(' --config-sha256 ', ' --config-sha256 0'),
    $real.Replace('C:\ProgramData\CluedIndependentCI\resident\resident\', 'C:\ProgramData\CluedIndependentCI\residentX\resident\'),
    $real.Replace('C:\ProgramData', 'c:\programdata'))) {
  Yes (-not (Test-CompanionCommandLine $bad $ProdRoot)) 'companion-command-line-refused'
}
$qx = "SERVICE_NAME: CluedCIResident`r`n        TYPE               : 10  WIN32_OWN_PROCESS`r`n        STATE              : 4  RUNNING`r`n                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)`r`n        WIN32_EXIT_CODE    : 0  (0x0)`r`n        PID                : 4242`r`n"
$st = ConvertFrom-ScState $qx
Yes ($st.state -ceq 'running' -and $st.processId -eq 4242) 'sc-queryex-parsed'
Yes ((ConvertFrom-ScState $qx.Replace(': 4  RUNNING', ': 1  STOPPED').Replace('4242', '0')).state -ceq 'stopped') 'sc-queryex-stopped'
Yes ((ConvertFrom-ScBinPath ("        BINARY_PATH_NAME   : " + $bb + "`r`n        LOAD_ORDER_GROUP   :`r`n")) -ceq $bb) 'sc-qc-binpath-parsed'
foreach ($c in @(@('SERVICE_QC_FAILED:1060', 'SERVICE_QC_FAILED', '1060'), @('UPGRADE_PLAN_REFUSED:windows.files.target', 'UPGRADE_PLAN_REFUSED', 'windows.files.target'), @('Access to the path C:\x is denied.', 'UPGRADE_APPLY_UNEXPECTED', $null),
    @('COMPILE_INPUT_NOT_THE_PLAN:bin\SwapBroker.cs', 'COMPILE_INPUT_NOT_THE_PLAN', 'bin\SwapBroker.cs'), @('X_Y:has a space', 'X_Y', $null), @('lower:case', 'UPGRADE_APPLY_UNEXPECTED', $null), @('RESIDENT_STOP_TIMEOUT', 'RESIDENT_STOP_TIMEOUT', $null))) {
  $fc = Get-FailureCode $c[0]
  Yes ($fc.code -ceq $c[1] -and $fc.detail -ceq $c[2]) ('failure-code:' + $c[1])
}
Yes ((Get-Match 'x' 'x' 'y') -ceq 'from' -and (Get-Match 'y' 'x' 'y') -ceq 'to' -and (Get-Match 'z' 'x' 'y') -ceq 'neither' -and (Get-Match 'x' 'x' $null) -ceq 'from') 'match-from-to-neither'

# 4b. The plan (upgrader/src/plan.mjs buildPlan's shape) and the generation records, read from a scratch root.
$Root = Join-Path $Scratch 'root'
$opId = '11111111-2222-4333-8444-555555555555'
$node = [pscustomobject][ordered]@{ contract = 'clued.independent-ci.node-profile/1'; nodeName = 'company'; hostname = 'COMPANY-PC'; ownerSid = 'S-1-5-21-1-2-3-1001'; ownerProfileDirectory = 'C:\Users\owner'
  controllerSid = 'S-1-5-21-1-2-3-1015'; runnerService = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02'; mutationMutex = 'Global\CluedControlControllerMutationV1-COMPANY-PC-1015'; wslDistribution = 'Ubuntu-24.04' }
$profileSha = Sha256Text (ConvertTo-NodeProfileCanonical $node)
function Put([string]$rel, [string]$text) { $p = Join-Path $Root $rel; [void][IO.Directory]::CreateDirectory((Split-Path -Parent $p)); [IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding($false))); Sha256File $p }
$r1 = & $h '1'; $r2 = & $h '2'; $c2 = & $h 'd'
$live = [ordered]@{ node = (Put 'runtime\node.exe' 'node-1'); entry = (Put ('resident\' + $r1 + '\src\service-main.mjs') 'main-1'); policy = (Put 'config\policy.json' '{"p":1}'); broker = (Put 'config\broker.json' '{"b":1}')
  companion = (Put 'config\companion.json' '{"c":1}'); companionMain = (Put ('resident\' + $r1 + '\src\companion-main.mjs') 'cm-1') }
$null = Put 'record\acceptance.json' (([ordered]@{ node = $node }) | ConvertTo-Json -Depth 4 -Compress)
# The staged package (stage-windows writes it, upgrade\staged\<sha of its manifest>\): the job host source under its package path.
$jobCs = 'class CompanionJobHostStandIn {}'
$stagedManifest = ([ordered]@{ contract = 'clued.independent-ci.resident-package/4'; files = @([ordered]@{ path = 'resident/windows/CompanionJobHost.cs'; target = ('resident\' + $r2 + '\windows\CompanionJobHost.cs'); sha256 = (Sha256Text $jobCs) }) } | ConvertTo-Json -Depth 5 -Compress)
$pkg = Sha256Text $stagedManifest
$null = Put ('upgrade\staged\' + $pkg + '\package-manifest.json') $stagedManifest
$null = Put ('upgrade\staged\' + $pkg + '\resident\windows\CompanionJobHost.cs') $jobCs
function Write-GenRecord([int]$g, [string]$pk, [string]$policy, [string]$nodeSha, [string]$res, [string]$entry, [string]$brokerCfg, [string]$compCfg, [hashtable]$override = @{}) {
  $rec = [ordered]@{ generation = $g; packageManifestSha256 = $pk; residentBinPath = (Get-ResidentBinPath $Root $policy $nodeSha $res $entry); brokerBinPath = (Get-BrokerBinPath $Root $brokerCfg $profileSha)
    companionTaskArguments = (Get-CompanionAction $Root $res $compCfg).arguments; filesSha256 = (& $h '7') }
  foreach ($k in $override.Keys) { $rec[$k] = $override[$k] }
  $null = Put ('generations\g' + $g + '\generation.json') ($rec | ConvertTo-Json -Compress)
}
Write-GenRecord 1 (& $h '3') $live.policy $live.node $r1 $live.entry $live.broker $live.companion
function New-Slots {
  $out = @()
  foreach ($s in $PackageSlots) {
    $sha = if ($s -ceq 'config\policy.json') { & $h '5' } elseif ($s -ceq 'config\companion.json') { & $h 'a' } elseif ($s -ceq 'runtime\node.exe') { & $h '6' } else { & $h 'b' }
    $out += ,([ordered]@{ target = $s; kind = 'package'; from = ('p/' + $s.Replace('\', '/')); sha256 = $sha; oldSha256 = (& $h '1') })
  }
  foreach ($s in $GeneratedSlots) { $out += ,([ordered]@{ target = $s; kind = 'generated'; from = $null; sha256 = $null; oldSha256 = (& $h '1') }) }
  $out += ,([ordered]@{ target = $ReceiptSlot; kind = 'receipt'; from = $null; sha256 = $null; oldSha256 = (& $h '1') })
  ,$out
}
function New-Plan([hashtable]$top = @{}, [hashtable]$tgt = @{}, $slots = (New-Slots)) {
  $compat = [ordered]@{ schema = 6; readableBySchemas = @(5, 6) }
  $t = [ordered]@{ residentManifestSha256 = $r2; ciSourceManifestSha256 = $c2; sourceManifestSha256 = (& $h 'e'); bridgeManifestSha256 = $null; policySha256 = (& $h '5'); companionConfigSha256 = (& $h 'a')
    nodeSha256 = (& $h '6'); residentEntrySha256 = (& $h '8'); companionEntrySha256 = (& $h '9'); stateCompat = $compat; windowsLayout = 'clued.independent-ci.resident-layout/1'; nodeIdentitySha256 = (& $h 'f')
    nodeProfileSha256 = $profileSha; linux = [ordered]@{ manifestSha256 = (& $h 'e'); sourceCommit = $null } }
  foreach ($k in $tgt.Keys) { $t[$k] = $tgt[$k] }
  $p = [ordered]@{ contract = $PlanContract; opId = $opId; node = 'company'; requestSha256 = (& $h 'c'); packageManifestSha256 = $pkg; packageDirectory = 'C:\pkg'; fromGeneration = 1; toGeneration = 2
    acceptanceDecisionRef = 'abcdef01-2345-4678-9abc-def012345678'; drainMaxMinutes = 120; grantResource = ('ci-resident:company/' + $pkg)
    current = [ordered]@{ packageManifestSha256 = (& $h '3'); residentManifestSha256 = $r1; ciSourceManifestSha256 = (& $h 'c'); policySha256 = $live.policy; installReceiptSha256 = (& $h '0'); stateCompat = $compat; linux = $null; fileSha256 = (& $h '0') }
    target = $t; dirs = @([ordered]@{ kind = 'resident'; sha256 = $r2; present = $false }, [ordered]@{ kind = 'source'; sha256 = $c2; present = $false }); slots = $slots
    scm = [ordered]@{ resident = 'binPath'; broker = 'binPath' }; companionTask = 'arguments' }
  foreach ($k in $top.Keys) { $p[$k] = $top[$k] }
  $p
}
function Write-Plan($p, [string]$id = $opId) {
  $dir = Join-Path $Root ('upgrade\ops\' + $id); [void][IO.Directory]::CreateDirectory($dir)
  $f = Join-Path $dir '010-accept.plan.json'; if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f }
  [IO.File]::WriteAllText($f, (($p | ConvertTo-Json -Depth 8 -Compress) + "`n"), (New-Object Text.UTF8Encoding($false))); Sha256File $f
}
$planSha = Write-Plan (New-Plan)
$plan = Read-UpgradePlan $Root $opId $planSha
Yes ($plan.toGeneration -eq 2 -and (Find-PlanSlot $plan 'bin\ResidentServiceHost.cs').sha256 -ceq (& $h 'b') -and (Find-PlanSlot $plan 'config\broker.json').kind -ceq 'generated') 'plan-read-by-sha'
Yes (Test-Refused { Read-UpgradePlan $Root $opId (& $h '0') } 'UPGRADE_PLAN_SHA_MISMATCH') 'plan-other-sha-refused'
Yes (Test-Refused { Find-PlanSlot $plan 'bin\Other.cs' } 'UPGRADE_PLAN_SLOT_MISSING:bin\Other.cs') 'plan-slot-missing'
Yes (Test-Refused { Read-UpgradePlan $Root '99999999-2222-4333-8444-555555555555' $planSha } 'DIRECTORY_MISSING:99999999-2222-4333-8444-555555555555') 'plan-other-op-missing'
$slotEdit = { param([string]$target, [hashtable]$set) $s = New-Slots; foreach ($x in $s) { if ($x.target -ceq $target) { foreach ($k in $set.Keys) { $x[$k] = $set[$k] } } }; ,$s }
$extraSlot = New-Slots; $extraSlot += ,([ordered]@{ target = 'upgrader\config\upgrader.json'; kind = 'package'; from = 'x'; sha256 = (& $h 'b'); oldSha256 = (& $h '1') })
$missingSlot = @(New-Slots | Where-Object { $_.target -cne 'record\signers.json' })
$cases = @(
  @(@{ contract = 'clued.independent-ci.resident-upgrade-plan/2' }, @{}, $null, 'UPGRADE_PLAN_REFUSED:contract'),
  @(@{ opId = '99999999-2222-4333-8444-555555555555' }, @{}, $null, 'UPGRADE_PLAN_REFUSED:opId'),
  @(@{ node = 'Company' }, @{}, $null, 'UPGRADE_PLAN_REFUSED:node'),
  @(@{ packageManifestSha256 = 'x' }, @{}, $null, 'UPGRADE_PLAN_REFUSED:packageManifestSha256'),
  @(@{ toGeneration = 3 }, @{}, $null, 'UPGRADE_PLAN_REFUSED:generations'),
  @(@{ fromGeneration = 0; toGeneration = 1 }, @{}, $null, 'UPGRADE_PLAN_REFUSED:generations'),
  @(@{ fromGeneration = '1' }, @{}, $null, 'UPGRADE_PLAN_REFUSED:generations'),
  @(@{ current = $null }, @{}, $null, 'UPGRADE_PLAN_REFUSED:current.residentManifestSha256'),
  @(@{}, @{ policySha256 = (& $h 'A') }, $null, 'UPGRADE_PLAN_REFUSED:target.policySha256'),
  @(@{}, @{ policySha256 = (& $h 'c') }, $null, 'UPGRADE_PLAN_REFUSED:target.policySha256'),
  @(@{}, @{ nodeSha256 = (& $h 'c') }, $null, 'UPGRADE_PLAN_REFUSED:target.nodeSha256'),
  @(@{}, @{ residentEntrySha256 = $null }, $null, 'UPGRADE_PLAN_REFUSED:target.residentEntrySha256'),
  @(@{ scm = [ordered]@{ resident = 'binPath'; broker = 'binPath'; upgrader = 'binPath' } }, @{}, $null, 'UPGRADE_PLAN_REFUSED:scm'),
  @(@{ scm = [ordered]@{ resident = 'binPath'; broker = 'sddl' } }, @{}, $null, 'UPGRADE_PLAN_REFUSED:scm'),
  @(@{ companionTask = 'principal' }, @{}, $null, 'UPGRADE_PLAN_REFUSED:scm'),
  @(@{}, @{}, $extraSlot, 'UPGRADE_PLAN_REFUSED:slots'),
  @(@{}, @{}, $missingSlot, 'UPGRADE_PLAN_REFUSED:slots'),
  @(@{}, @{}, (& $slotEdit 'config\broker.json' @{ kind = 'package'; sha256 = (& $h 'b'); from = 'x' }), 'UPGRADE_PLAN_REFUSED:slot:config\broker.json'),
  @(@{}, @{}, (& $slotEdit 'record\acceptance.json' @{ from = '../outside' }), 'UPGRADE_PLAN_REFUSED:slot:record\acceptance.json'),
  @(@{}, @{}, (& $slotEdit 'record\acceptance.json' @{ from = 'C:/x' }), 'UPGRADE_PLAN_REFUSED:slot:record\acceptance.json'),
  @(@{}, @{}, (& $slotEdit 'bin\SwapBroker.cs' @{ sha256 = $null }), 'UPGRADE_PLAN_REFUSED:slot:bin\SwapBroker.cs'),
  @(@{}, @{}, (& $slotEdit $ReceiptSlot @{ kind = 'package' }), ('UPGRADE_PLAN_REFUSED:slot:' + $ReceiptSlot)),
  @(@{ dirs = @([ordered]@{ kind = 'resident'; sha256 = $r1; present = $true }) }, @{}, $null, 'UPGRADE_PLAN_REFUSED:dirs'),
  @(@{ dirs = @([ordered]@{ kind = 'upgrader'; sha256 = $r2; present = $false }) }, @{}, $null, 'UPGRADE_PLAN_REFUSED:dirs'))
$i = 0
foreach ($c in $cases) {
  $i++
  $s = if ($null -eq $c[2]) { Write-Plan (New-Plan $c[0] $c[1]) } else { Write-Plan (New-Plan $c[0] $c[1] $c[2]) }
  Yes (Test-Refused { Read-UpgradePlan $Root $opId $s } $c[3]) ('plan-refused-' + $i + ':' + $c[3])
}
$planSha = Write-Plan (New-Plan)
$plan = Read-UpgradePlan $Root $opId $planSha
# A link anywhere on the way to the plan is refused.
$elsewhere = Join-Path $Scratch 'elsewhere\ops-target'; [void][IO.Directory]::CreateDirectory($elsewhere)
$linkedId = '22222222-2222-4333-8444-555555555555'
[void](New-Item -ItemType Junction -Path (Join-Path $Root ('upgrade\ops\' + $linkedId)) -Target $elsewhere)
Copy-Item -LiteralPath (Join-Path $Root ('upgrade\ops\' + $opId + '\010-accept.plan.json')) -Destination (Join-Path $elsewhere '010-accept.plan.json')
Yes (Test-Refused { Read-UpgradePlan $Root $linkedId $planSha } ('LINK_REFUSED:' + $linkedId)) 'plan-through-a-link-refused'
[IO.Directory]::Delete((Join-Path $Root ('upgrade\ops\' + $linkedId)))
# The staged package and the compile inputs: the staged copy, or the placed content-addressed one, by the package manifest's hash.
$staged = Read-StagedManifest $Root $plan
$jobTarget = 'resident\' + $r2 + '\windows\CompanionJobHost.cs'
Yes ((Find-CompileInput $Root $staged $jobTarget) -ceq (Join-Path $Root ('upgrade\staged\' + $pkg + '\resident\windows\CompanionJobHost.cs'))) 'compile-input-staged'
Yes (Test-Refused { Find-CompileInput $Root $staged 'bin\Other.cs' } 'COMPILE_INPUT_NOT_IN_PACKAGE:bin\Other.cs') 'compile-input-not-in-package'
[IO.Directory]::Move((Join-Path $Root ('upgrade\staged\' + $pkg + '\resident')), (Join-Path $Root ('resident\' + $r2)))
Yes ((Find-CompileInput $Root $staged $jobTarget) -ceq (Join-Path $Root $jobTarget)) 'compile-input-placed'
$null = Put $jobTarget 'class Changed {}'
Yes (Test-Refused { Find-CompileInput $Root $staged $jobTarget } ('COMPILE_INPUT_NOT_THE_PLAN:' + $jobTarget)) 'compile-input-changed-refused'
$null = Put ('upgrade\staged\' + $pkg + '\package-manifest.json') ($stagedManifest + ' ')
Yes (Test-Refused { Read-StagedManifest $Root $plan } 'STAGED_PACKAGE_CHANGED') 'staged-manifest-changed-refused'
$null = Put ('upgrade\staged\' + $pkg + '\package-manifest.json') $stagedManifest
# The generation records: from (1) by its record; to (2) by the plan and compile.json, and by its record once written.
$g1 = Get-PlanGeneration $plan 1
Yes ($g1.resident.entrySha256 -ceq $live.entry -and $g1.broker.brokerConfigSha256 -ceq $live.broker -and $g1.companion.companionConfigSha256 -ceq $live.companion) 'generation-from-read'
Yes (Test-Refused { Get-PlanGeneration $plan 2 } 'COMPILE_RECORD_MISSING') 'generation-to-needs-the-compile-record'
$compileRecord = { param([string]$op, [string]$broker) $null = Put ('upgrade\staged\' + $pkg + '\compiled\compile.json') (([ordered]@{ contract = $CompileContract; opId = $op; packageManifestSha256 = $pkg; brokerConfigSha256 = $broker; files = @() }) | ConvertTo-Json -Compress) }
& $compileRecord '33333333-2222-4333-8444-555555555555' (& $h '9')
Yes (Test-Refused { Get-PlanGeneration $plan 2 } 'COMPILE_RECORD_OTHER_OP') 'generation-to-other-op-compile-refused'
& $compileRecord $opId (& $h '9')
$g2 = Get-PlanGeneration $plan 2
Yes ($g2.resident.residentManifestSha256 -ceq $r2 -and $g2.resident.policySha256 -ceq (& $h '5') -and $g2.resident.entrySha256 -ceq (& $h '8') -and $g2.broker.brokerConfigSha256 -ceq (& $h '9') -and
  $g2.companion.companionConfigSha256 -ceq (& $h 'a') -and $g2.record.residentBinPath -ceq (Get-ResidentBinPath $Root (& $h '5') (& $h '6') $r2 (& $h '8'))) 'generation-to-from-the-plan'
Yes (Test-Refused { Get-PlanGeneration $plan 3 } 'UPGRADE_APPLY_GENERATION_REFUSED') 'generation-outside-the-plan-refused'
Assert-GenerationInPlace $Root $g1; Assert-GenerationInPlace $Root $g1 -Companion
Yes $true 'generation-from-in-place'
Yes (Test-Refused { Assert-GenerationInPlace $Root $g2 } 'GENERATION_FILES_NOT_IN_PLACE:runtime\node.exe') 'generation-to-not-in-place-refused'
$null = Put 'config\broker.json' '{"b":2}'
Yes (Test-Refused { Assert-GenerationInPlace $Root $g1 } 'GENERATION_FILES_NOT_IN_PLACE:config\broker.json') 'generation-changed-file-refused'
$null = Put 'config\broker.json' '{"b":1}'
Write-GenRecord 2 $pkg (& $h '5') (& $h '6') $r2 (& $h '8') (& $h '9') (& $h 'a')
Yes ((Get-PlanGeneration $plan 2).record.brokerBinPath -ceq $g2.record.brokerBinPath) 'generation-to-record-agrees'
Write-GenRecord 2 $pkg (& $h '5') (& $h '6') $r2 (& $h '8') (& $h 'b') (& $h 'a')
Yes (Test-Refused { Get-PlanGeneration $plan 2 } 'GENERATION_RECORD_NOT_THE_PLAN') 'generation-to-record-disagrees-refused'
Write-GenRecord 2 (& $h 'f') (& $h '5') (& $h '6') $r2 (& $h '8') (& $h '9') (& $h 'a')
Yes (Test-Refused { Get-PlanGeneration $plan 2 } 'GENERATION_RECORD_NOT_THE_PLAN') 'generation-to-record-other-package-refused'
foreach ($o in @(@{ generation = 7 }, @{ residentBinPath = ($rb) }, @{ brokerBinPath = (Get-BrokerBinPath $Root (& $h '9') (& $h '0')) }, @{ companionTaskArguments = (Get-CompanionAction $Root $r1 (& $h 'a')).arguments }, @{ filesSha256 = 'x' })) {
  Write-GenRecord 2 $pkg (& $h '5') (& $h '6') $r2 (& $h '8') (& $h '9') (& $h 'a') $o
  Yes (Test-Refused { Get-PlanGeneration $plan 2 } ('GENERATION_RECORD_REFUSED:' + @($o.Keys)[0])) ('generation-record-refused:' + @($o.Keys)[0])
}
$otherCurrent = New-Plan @{ current = [ordered]@{ residentManifestSha256 = $r2; ciSourceManifestSha256 = (& $h 'c'); policySha256 = $live.policy } }
$s = Write-Plan $otherCurrent
Yes (Test-Refused { Get-PlanGeneration (Read-UpgradePlan $Root $opId $s) 1 } 'GENERATION_RECORD_NOT_THE_PLAN') 'generation-from-not-the-plans-current-refused'
$planSha = Write-Plan (New-Plan)
$null = Put 'upgrade\current.json' (([ordered]@{ contract = 'clued.independent-ci.resident-generation/1'; generation = 1; residentManifestSha256 = $r1; installReceiptSha256 = (& $h '0') }) | ConvertTo-Json -Compress)
Yes ((Read-CurrentRecord $Root).generation -eq 1) 'current-record-read'
$null = Put 'upgrade\current.json' (([ordered]@{ contract = 'x'; generation = 1; residentManifestSha256 = $r1; installReceiptSha256 = (& $h '0') }) | ConvertTo-Json -Compress)
Yes (Test-Refused { Read-CurrentRecord $Root } 'CURRENT_RECORD_REFUSED') 'current-record-refused'
# 4c. PR-1 review M2: a tree moved in from upgrade\staged keeps the ACEs it inherited there; SwitchScm gives generation N's resident\<sha>
#     and source\<sha> their live parent's inheritance back (Repair-GenerationContentAcl) and verify checks it (Test-ContentAcl, shared).
. (Use 'upgrade-apply.ps1' @('Get-InheritableAceKeys', 'Test-ItemAcl', 'Test-ContentAcl', 'Reset-InheritedAcl', 'Repair-ContentAcl', 'Repair-GenerationContentAcl'))
foreach ($name in @('Get-InheritableAceKeys', 'Test-ItemAcl', 'Test-ContentAcl')) { Yes ($functions['upgrade-apply.ps1:' + $name] -ceq $functions['verify-resident.ps1:' + $name]) ('content-acl-shared-with-verify:' + $name) }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ctrl = 'S-1-5-21-1-2-3-1015'; $stagedReader = 'S-1-5-21-1-2-3-1001'
function New-AclDir([string]$path, [string]$sddl) { $sec = New-Object Security.AccessControl.DirectorySecurity; $sec.SetSecurityDescriptorSddlForm($sddl); [void][IO.Directory]::CreateDirectory($path, $sec) }
$m2 = Join-Path $Scratch 'm2'; [void][IO.Directory]::CreateDirectory($m2)
New-AclDir (Join-Path $m2 'source') "D:P(A;OICI;FA;;;$me)(A;OICI;0x1200a9;;;$ctrl)"
New-AclDir (Join-Path $m2 'staged') "D:P(A;OICI;FA;;;$me)(A;OICI;0x1200a9;;;$stagedReader)"
$tree = Join-Path $m2 ('staged\' + $c2)
[void][IO.Directory]::CreateDirectory((Join-Path $tree 'work\deep')); [IO.File]::WriteAllText((Join-Path $tree 'work\deep\a.cs'), 'a'); [IO.File]::WriteAllText((Join-Path $tree 'top.txt'), 't')
$placed = Join-Path $m2 ('source\' + $c2)
[IO.Directory]::Move($tree, $placed)
$sourceSddl = (Get-Acl -LiteralPath (Join-Path $m2 'source')).Sddl
Yes ((Test-ContentAcl $placed) -cne 'ok') ('moved-tree-keeps-the-staged-aces:' + (Test-ContentAcl $placed))
$fileAces = { param([string]$f) @((New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $f).Sddl)).DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value }) }
Yes ((& $fileAces (Join-Path $placed 'work\deep\a.cs')) -ccontains $stagedReader -and (& $fileAces (Join-Path $placed 'work\deep\a.cs')) -cnotcontains $ctrl) 'moved-file-has-no-controller-read'
$n1 = Repair-ContentAcl $placed
Yes ($n1 -ge 1 -and (Test-ContentAcl $placed) -ceq 'ok') ('repair-gives-the-live-inheritance:' + $n1)
Yes ((& $fileAces (Join-Path $placed 'work\deep\a.cs')) -ccontains $ctrl -and (& $fileAces (Join-Path $placed 'work\deep\a.cs')) -cnotcontains $stagedReader -and (& $fileAces (Join-Path $placed 'top.txt')) -ccontains $ctrl) 'repaired-files-carry-the-controller-read'
Yes ((Get-Acl -LiteralPath (Join-Path $m2 'source')).Sddl -ceq $sourceSddl) 'repair-leaves-the-live-parent-alone'
Yes ((Repair-ContentAcl $placed) -eq 0) 'repair-again-is-a-no-op'
# A child with an explicit ACE, and one protected: found, and reset.
$f = Join-Path $placed 'top.txt'; $fs = Get-Acl -LiteralPath $f; $fs.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($stagedReader)), 'Read', 'Allow'))); [IO.File]::SetAccessControl($f, $fs)
Yes ((Test-ContentAcl $placed) -ceq 'explicit:top.txt') 'explicit-ace-found'
$d = Join-Path $placed 'work'; $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm("D:P(A;OICI;FA;;;$me)", 'Access'); [IO.Directory]::SetAccessControl($d, $ds)
Yes ((Test-ContentAcl $placed) -cmatch '^(?:protected:work|explicit:top\.txt)$') 'protected-child-found'
Yes ((Repair-ContentAcl $placed) -ge 2 -and (Test-ContentAcl $placed) -ceq 'ok') 'explicit-and-protected-children-reset'
# A link inside a content tree is refused, never followed.
$lt = Join-Path $Scratch 'm2-link-target'; [void][IO.Directory]::CreateDirectory($lt)
[void](New-Item -ItemType Junction -Path (Join-Path $placed 'link') -Target $lt)
Yes (Test-Refused { Repair-ContentAcl $placed } 'LINK_REFUSED:content') 'repair-refuses-a-link'
Yes ((Test-ContentAcl $placed) -ceq 'link:link') 'verify-refuses-a-link'
[IO.Directory]::Delete((Join-Path $placed 'link'))
# SwitchScm's own call: generation N's two trees (the to generation: the plan's target; the from generation: the plan's current).
$Root = Join-Path $Scratch 'root'
[void][IO.Directory]::CreateDirectory((Join-Path $Root ('source\' + $c2))); [void][IO.Directory]::CreateDirectory((Join-Path $Root ('source\' + (& $h 'c'))))
$rg2 = Repair-GenerationContentAcl $Root $plan $g2
Yes ($null -ne $rg2 -and (Test-ContentAcl (Join-Path $Root ('resident\' + $r2))) -ceq 'ok' -and (Test-ContentAcl (Join-Path $Root ('source\' + $c2))) -ceq 'ok') 'repair-generation-to'
$rg1 = Repair-GenerationContentAcl $Root $plan $g1
Yes ($rg1.repaired -eq 0) 'repair-generation-from-already-right'
$sw = $functions['upgrade-apply.ps1:Invoke-SwitchScm']
Yes ($sw.IndexOf('Repair-GenerationContentAcl $Root $plan $gen') -gt 0 -and $sw.IndexOf('Repair-GenerationContentAcl $Root $plan $gen') -lt $sw.IndexOf("Invoke-Sc (`$pair[3]")) 'switch-repairs-before-the-binary-paths'
Yes ($functions['upgrade-apply.ps1:Invoke-Recover'].Contains("'repair-content-acl'")) 'recover-repairs-the-content-acl'
Yes ($verify.Contains("Record 'content-addressed-acl'") -and $verify.Contains("Test-ContentAcl (Join-Path `$Root ('source\' + `$ciSourceSha))")) 'verify-checks-the-content-acl'
# PR-1 review m8: an earlier op's compile output of the same package is set aside, never a refusal of the new op.
$cf = $functions['upgrade-apply.ps1:Invoke-Compile']
Yes ($cf.Contains('$asideOther = ($null -ne $earlier) -and ((Get-Field $earlier ''opId'') -cne $plan.opId)') -and $cf.Contains("-and -not `$asideOther)") -and $cf.IndexOf('[IO.Directory]::Move($out, $out + $why') -gt 0) 'compile-sets-aside-an-earlier-op'
# NIT: the verify script that runs as SYSTEM is the one generation N's resident manifest pins.
$vf = $functions['upgrade-apply.ps1:Invoke-Verify']
Yes ($vf.IndexOf("'VERIFY_SCRIPT_NOT_THE_GENERATION'") -gt 0 -and $vf.IndexOf("'VERIFY_SCRIPT_NOT_THE_GENERATION'") -lt $vf.IndexOf('& $PowerShellExe') -and $vf.Contains("'RESIDENT_MANIFEST_NOT_THE_GENERATION'")) 'verify-script-hash-checked-before-it-runs'
$Root = $ProdRoot

# 5. install-resident.ps1: plan /8, receipt /6, the dry run, the plan hash and the new steps.
Yes ($install -notmatch '(?i)supabase') 'install-never-names-supabase'
Yes ($install.Contains("contract = 'clued.independent-ci.resident-install-plan/8'") -and $install.Contains("contract = 'clued.independent-ci.resident-install-receipt/6'")) 'install-plan-8-receipt-6'
Yes (([regex]::Matches($install, [regex]::Escape('$planSha = Sha256Text ($plan | ConvertTo-Json -Depth 8)'))).Count -eq 1 -and $install.Contains("if (`$ExpectedPlanSha256 -cne `$planSha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }")) 'install-plan-hash-unchanged'
$at = { param([string]$needle) $k = $install.IndexOf($needle); Yes ($k -gt 0) ('install-has:' + $needle); $k }
Yes ((& $at 'if (-not $Apply) {') -lt (& $at "Step 'directories'")) 'install-dry-run-before-any-write'
$order = @("Step 'directories'", "Step 'package-copy'", "Step 'service-hosts'", "Step 'services'", "Step 'companion-task'", "Step 'upgrader-files'", "Step 'upgrader-host'", "Step 'upgrader-service'", "Step 'node-secrets'", "Step 'runner-unchanged'",
  "Write-New `$out", "`$genDir = Join-Path `$Root 'generations\g1'", "Write-New (Join-Path `$Root 'upgrade\current.json')", "'UPGRADER_SERVICE_START_FAILED'")
for ($k = 1; $k -lt $order.Count; $k++) { Yes ((& $at $order[$k - 1]) -lt (& $at $order[$k])) ('install-order:' + $order[$k]) }
Yes ($install.Contains("'FRESH_INSTALL_REQUIRED_UPGRADE_THROUGH_CLUEDCIUPGRADER_REQUEST_UPGRADE'") -and -not $install.Contains('FRESH_INSTALL_REQUIRED_USE_UPGRADE_PATH')) 'install-refusal-points-at-the-upgrader'
Yes ($install.Contains("@('create', `$UpgraderName, 'binPath=', `$u.binaryPath.Replace('`"', '\`"'), 'start=', 'delayed-auto', 'type=', 'own')") -and $install.Contains("Assert-ServiceBinary `$UpgraderName `$u.binaryPath")) 'install-upgrader-service-created-and-read-back'
foreach ($call in @("'privs', `$UpgraderName", "'failure', `$UpgraderName", "'failureflag', `$UpgraderName", "'sdset', `$UpgraderName", "'qprivs', `$UpgraderName", "'sdshow', `$UpgraderName")) { Yes ($install.Contains($call)) ('install-upgrader:' + $call) }
$installRaw = @([regex]::Matches($install, '& \$Sc (?!@scArgs)([a-z]+)') | ForEach-Object { $_.Groups[1].Value })
Yes ((@($installRaw | Where-Object { @('qc', 'queryex', 'sdshow') -cnotcontains $_ }).Count) -eq 0) 'install-every-mutating-sc-call-is-exit-checked'
. (UseVar 'install-resident.ps1' @('UpgraderName', 'UpgraderPrivileges', 'UpgradeTokenTarget', 'UpgradeTokenSddl', 'WindowsLayout', 'ServiceSddl', 'TargetShape'))
Yes ((@($UpgraderPrivileges) -join '/') -ceq 'SeChangeNotifyPrivilege' -and $UpgradeTokenSddl -ceq 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)' -and $UpgradeTokenTarget -ceq 'C:\ProgramData\CluedIndependentCI\resident\secrets\resident-upgrade.token') 'install-upgrader-constants'
Yes ($install.Contains("[string]`$UpgradeTokenFile") -and $functions['install-resident.ps1:Get-UpgradeTokenPlan'].Contains("'UPGRADE_TOKEN_IS_THE_CI_ADMISSION_TOKEN'") -and $functions['install-resident.ps1:Get-UpgradeTokenPlan'].Contains('Get-SecretFingerprint')) 'install-upgrade-token-own-and-fingerprinted'
Yes ($install.Contains('Write-NewSecret $ut.target $script:SecretBytes[''upgradeToken''] $ut.sddl')) 'install-upgrade-token-placed-create-only-with-its-sddl'
$ha = & $h 'a'
foreach ($t in @("upgrader\$ha\upgrader\src\upgrader-main.mjs", "upgrader\$ha\src\canonical.mjs", "upgrader\$ha\windows\upgrade-apply.ps1", 'upgrader\config\upgrader.json', 'upgrader\runtime\node.exe', 'upgrader\bin\UpgraderServiceHost.cs', "resident\$ha\src\x.mjs", 'bin\SwapBroker.cs')) { Yes ($t -cmatch $TargetShape) ('target-accepted:' + $t) }
foreach ($t in @('upgrader\other\x', 'upgrader\config\sub\x', 'upgrader\state\x', "upgrader\$ha", 'upgrade\current.json', 'generations\g1\generation.json', 'secrets\resident-upgrade.token', 'state\PAUSED.json')) { Yes ($t -cnotmatch $TargetShape) ('target-refused:' + $t) }

# 5b. The upgrader section and package /4 of a scratch package (install's own functions).
. (Use 'install-resident.ps1' @('Get-JsonField', 'Get-UpgraderPlan', 'Get-UpgradeTokenPlan', 'Assert-Package4', 'Read-PackageRecordFile', 'Get-UpgraderBinPath', 'Get-AclPlan', 'Get-GenerationFilesSha256', 'Invoke-UpgraderHostCompile'))
$Root = $ProdRoot; $OwnerSid = $node.ownerSid; $ControllerSid = $node.controllerSid; $Node = $node; $NodeProfileSha256 = $profileSha
$UpgradeTokenTarget = Join-Path $Scratch 'secrets\resident-upgrade.token'; $UpgradeTokenFile = $null; $elevated = $false; $Identity = [ordered]@{ ciTokenPinSha256 = (& $h '0') }
$m = & $h '7'
function Write-ScratchPackage([string]$name, [hashtable]$contents, [hashtable]$extra) {
  $dir = Join-Path $Scratch ('pkg-' + $name); [void][IO.Directory]::CreateDirectory($dir)
  $list = @(); $k = 0
  foreach ($t in @($contents.Keys | Sort-Object)) { $k++; $rel = 'f' + $k; [IO.File]::WriteAllText((Join-Path $dir $rel), $contents[$t], (New-Object Text.UTF8Encoding($false))); $list += ,([ordered]@{ path = $rel; target = $t; sha256 = (Sha256File (Join-Path $dir $rel)) }) }
  $manifest = [ordered]@{ contract = 'clued.independent-ci.resident-package/4'; files = $list }
  foreach ($e in $extra.Keys) { $manifest[$e] = $extra[$e] }
  [IO.File]::WriteAllText((Join-Path $dir 'package-manifest.json'), ($manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
  $script:PackageRoot = $dir; $script:pkgBytes = [IO.File]::ReadAllBytes((Join-Path $dir 'package-manifest.json')); $script:ExpectedPackageManifestSha256 = Sha256Bytes $script:pkgBytes
  [Text.Encoding]::UTF8.GetString($script:pkgBytes) | ConvertFrom-Json
}
$decision = 'abcdef01-2345-4678-9abc-def012345678'
$cfg = [ordered]@{ contract = 'clued.independent-ci.resident-upgrader-config/1'; node = 'company'; nodeProfileSha256 = $profileSha; ownerSid = $node.ownerSid; root = $ProdRoot; tokenFile = $UpgradeTokenTarget; keepGenerations = 3 }
function Get-UpgraderContents([hashtable]$cfgOverride = @{}, [hashtable]$more = @{}) {
  $c = [ordered]@{}; foreach ($k in $cfg.Keys) { $c[$k] = $cfg[$k] }; foreach ($k in $cfgOverride.Keys) { $c[$k] = $cfgOverride[$k] }
  $out = @{ ('upgrader\' + $m + '\upgrader\src\upgrader-main.mjs') = 'main'; ('upgrader\' + $m + '\src\canonical.mjs') = 'canonical'; ('upgrader\' + $m + '\windows\upgrade-apply.ps1') = 'apply'; 'upgrader\config\upgrader.json' = ($c | ConvertTo-Json -Compress)
    'upgrader\runtime\node.exe' = 'node'; 'upgrader\bin\UpgraderServiceHost.cs' = 'host'; 'config\policy.json' = ('{"ownerAcceptance":{"decisionRef":"' + $decision + '","installReceiptRef":null}}') }
  foreach ($k in $more.Keys) { $out[$k] = $more[$k] }
  $out
}
$extra4 = @{ upgrader = [ordered]@{ manifestSha256 = $m; files = @() }; windowsLayout = $WindowsLayout; stateCompat = [ordered]@{ schema = 6; readableBySchemas = @(5, 6) }; acceptance = [ordered]@{ decisionRef = $decision }; linux = [ordered]@{ manifestSha256 = (& $h '1'); sourceV2 = $null; files = @() } }
$pkg = Write-ScratchPackage 'ok' (Get-UpgraderContents) $extra4
Assert-Package4 $pkg
$up = Get-UpgraderPlan $pkg
$entrySha = Sha256Text 'main'; $cfgSha = @($pkg.files | Where-Object { $_.target -ceq 'upgrader\config\upgrader.json' })[0].sha256
Yes ($up.binaryPath -ceq (Get-UpgraderBinPath $ProdRoot $cfgSha (Sha256Text 'node') $m $entrySha) -and $up.manifestSha256 -ceq $m -and $up.entrySha256 -ceq $entrySha -and $up.applySha256 -ceq (Sha256Text 'apply')) 'upgrader-plan-command-line'
Yes ($up.account -ceq 'LocalSystem' -and $up.start -ceq 'delayed-auto' -and (@($up.requiredPrivileges) -join '/') -ceq 'SeChangeNotifyPrivilege' -and $up.sddl -ceq $ServiceSddl -and $up.files -eq 6) 'upgrader-plan-service'
Yes ($up.token.supplied -eq $false -and $null -eq $up.token.fingerprint -and $up.token.sddl -ceq $UpgradeTokenSddl -and $up.stopFile -ceq 'upgrade\STOP-REQUESTED' -and $up.tokenRecord -ceq 'upgrade\upgrader-token.json') 'upgrader-plan-token-and-host-files'
$ubin = $up.binaryPath
foreach ($c in @(@('root', @{ root = 'C:\Other' }), @('owner', @{ ownerSid = 'S-1-5-21-1-2-3-1002' }), @('profile', @{ nodeProfileSha256 = (& $h '0') }), @('token', @{ tokenFile = 'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token' }), @('node', @{ node = 'other' }), @('contract', @{ contract = 'x' }))) {
  $p = Write-ScratchPackage ('cfg-' + $c[0]) (Get-UpgraderContents $c[1]) $extra4
  Yes (Test-Refused { Get-UpgraderPlan $p } 'PACKAGE_UPGRADER_CONFIG_REFUSED') ('upgrader-config-refused:' + $c[0])
}
$p = Write-ScratchPackage 'two-copies' (Get-UpgraderContents @{} @{ ('upgrader\' + (& $h '8') + '\src\x.mjs') = 'x' }) $extra4
Yes (Test-Refused { Get-UpgraderPlan $p } 'PACKAGE_UPGRADER_COPY_REFUSED') 'upgrader-second-copy-refused'
$noApply = Get-UpgraderContents; $noApply.Remove('upgrader\' + $m + '\windows\upgrade-apply.ps1')
$p = Write-ScratchPackage 'no-apply' $noApply $extra4
Yes (Test-Refused { Get-UpgraderPlan $p } ('PACKAGE_UPGRADER_FILE_REQUIRED:upgrader\' + $m + '\windows\upgrade-apply.ps1')) 'upgrader-apply-required'
$e = @{}; foreach ($k in $extra4.Keys) { $e[$k] = $extra4[$k] }; $e.upgrader = $null
$p = Write-ScratchPackage 'no-section' (Get-UpgraderContents) $e
Yes (Test-Refused { Get-UpgraderPlan $p } 'PACKAGE_UPGRADER_SECTION_REQUIRED') 'upgrader-section-required'
foreach ($c in @(@('layout', 'windowsLayout', 'clued.independent-ci.resident-layout/2', 'PACKAGE_WINDOWS_LAYOUT_REFUSED'), @('compat', 'stateCompat', [ordered]@{ schema = 0; readableBySchemas = @() }, 'PACKAGE_STATE_COMPAT_REFUSED'),
    @('compat2', 'stateCompat', [ordered]@{ schema = 6; readableBySchemas = @('5') }, 'PACKAGE_STATE_COMPAT_REFUSED'), @('acceptance', 'acceptance', [ordered]@{ decisionRef = '00000000-2345-4678-9abc-def012345678' }, 'PACKAGE_ACCEPTANCE_REFUSED'),
    @('linux', 'linux', $null, 'PACKAGE_LINUX_MANIFEST_REQUIRED'))) {
  $e = @{}; foreach ($k in $extra4.Keys) { $e[$k] = $extra4[$k] }; $e[$c[1]] = $c[2]
  $p = Write-ScratchPackage ('p4-' + $c[0]) (Get-UpgraderContents) $e
  Yes (Test-Refused { Assert-Package4 $p } $c[3]) ('package-4-refused:' + $c[0])
}
$p = Write-ScratchPackage 'p3' (Get-UpgraderContents) $extra4; $p.contract = 'clued.independent-ci.resident-package/3'
Yes (Test-Refused { Assert-Package4 $p } 'RESIDENT_PACKAGE_4_REQUIRED') 'package-3-refused'

# 5c. The new directories, ACE by ACE, then created in the scratch directory and read back.
$res = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
$acl = Get-AclPlan $res
$fileWrite = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
$admins = @('S-1-5-18', 'S-1-5-32-544')
function Aces([string]$sddl) { @((New-Object Security.AccessControl.RawSecurityDescriptor($sddl)).DiscretionaryAcl) }
function Others([string]$sddl) { @(Aces $sddl | Where-Object { $admins -cnotcontains $_.SecurityIdentifier.Value }) }
$new = @('upgrader', 'secrets', 'upgrade', 'upgrade\inbox', 'upgrade\mailbox', 'upgrade\mailbox\requests', 'upgrade\mailbox\responses', 'generations', 'archive')
$keys = @($acl.Keys)
foreach ($k in $new) {
  Yes ($keys -ccontains $k) ('acl-planned:' + $k)
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($acl[$k])
  Yes ($raw.Owner.Value -ceq 'S-1-5-32-544' -and (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0)) ('acl-owner-ba-protected:' + $k)
  Yes (@(Aces $acl[$k] | Where-Object { $admins -ccontains $_.SecurityIdentifier.Value -and $_.AccessMask -eq 0x1f01ff -and [int]$_.AceFlags -eq 3 }).Count -eq 2) ('acl-system-and-admins-full:' + $k)
  Yes (@(Aces $acl[$k] | Where-Object { [string]$_.AceQualifier -cne 'AccessAllowed' }).Count -eq 0) ('acl-allow-only:' + $k)
}
for ($k = 1; $k -lt $new.Count; $k++) { if ($new[$k].Contains('\')) { Yes ($keys.IndexOf((Split-Path -Parent $new[$k])) -lt $keys.IndexOf($new[$k])) ('acl-parent-first:' + $new[$k]) } }
foreach ($k in @('upgrader', 'secrets')) { Yes (@(Others $acl[$k]).Count -eq 0) ('acl-admin-only:' + $k) }
$o = @(Others $acl['upgrade'])
Yes ($o.Count -eq 2 -and @($o | Where-Object { $_.AccessMask -eq 0x1200a9 -and [int]$_.AceFlags -eq 3 -and @($res, $OwnerSid) -ccontains $_.SecurityIdentifier.Value }).Count -eq 2) 'acl-upgrade:resident-and-owner-read'
$o = @(Others $acl['upgrade\inbox'])
Yes (@($o | Where-Object { $_.SecurityIdentifier.Value -ceq $res }).Count -eq 0) 'acl-upgrade-inbox:no-resident'
$ownerAces = @($o | Where-Object { $_.SecurityIdentifier.Value -ceq $OwnerSid })
Yes ($ownerAces.Count -eq 2 -and @($ownerAces | Where-Object { $_.AccessMask -eq 0x1000a2 -and [int]$_.AceFlags -eq 0 }).Count -eq 1 -and @($ownerAces | Where-Object { ([int]$_.AceFlags -band 8) -ne 0 -and ($_.AccessMask -band $fileWrite) -eq 0 }).Count -eq 1) 'acl-upgrade-inbox:owner-create-only'
Yes (@($o | Where-Object { $_.SecurityIdentifier.Value -ceq 'S-1-3-4' -and ($_.AccessMask -band $fileWrite) -eq 0 }).Count -eq 1 -and $o.Count -eq 3) 'acl-upgrade-inbox:owner-rights-restricted'
Yes ($acl['upgrade\inbox'] -ceq $acl['inbox'].Replace("(A;OICI;0x1301bf;;;$res)", '')) 'acl-upgrade-inbox:the-inbox-rule-without-the-resident'
foreach ($k in @('upgrade\mailbox', 'upgrade\mailbox\requests')) { Yes (@(Others $acl[$k] | Where-Object { ($_.AccessMask -band $fileWrite) -ne 0 }).Count -eq 0) ('acl-no-write-but-system:' + $k) }
$o = @(Others $acl['upgrade\mailbox\responses'])
Yes (@($o | Where-Object { $_.SecurityIdentifier.Value -ceq $OwnerSid -and $_.AccessMask -eq 0x1301bf }).Count -eq 1 -and @($o | Where-Object { $_.SecurityIdentifier.Value -ceq $res -and ($_.AccessMask -band $fileWrite) -eq 0 }).Count -eq 1 -and $o.Count -eq 2) 'acl-upgrade-responses:owner-writes-resident-reads'
Yes ($acl['generations'] -ceq $acl['config']) 'acl-generations-as-config'
$o = @(Others $acl['archive'])
Yes ($o.Count -eq 1 -and $o[0].SecurityIdentifier.Value -ceq $OwnerSid -and $o[0].AccessMask -eq 0x1200a9) 'acl-archive-owner-read-only'
Yes (@(Others $acl['upgrader'] | Where-Object { $_.SecurityIdentifier.Value -ceq $ControllerSid }).Count -eq 0 -and @(Others $acl['secrets']).Count -eq 0) 'acl-no-controller-on-the-channel'
$aclRoot = Join-Path $Scratch 'acl'; [void][IO.Directory]::CreateDirectory($aclRoot)
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($k in $new) {
  # Side by side (the planned DACLs give this test account nothing, so it could not create a child in one); the owner (BA) needs an
  # elevated token, so the DACL is what is created and read back here.
  $dir = Join-Path $aclRoot $k.Replace('\', '_')
  $dacl = $acl[$k].Substring($acl[$k].IndexOf('D:'))
  $sec = New-Object Security.AccessControl.DirectorySecurity; $sec.SetSecurityDescriptorSddlForm($dacl)
  $null = [IO.Directory]::CreateDirectory($dir, $sec)
  $back = @(Aces (Get-Acl -LiteralPath $dir).Sddl | ForEach-Object { $_.SecurityIdentifier.Value + '|' + $_.AccessMask + '|' + [int]$_.AceFlags } | Sort-Object)
  $want = @(Aces $acl[$k] | ForEach-Object { $_.SecurityIdentifier.Value + '|' + $_.AccessMask + '|' + [int]$_.AceFlags } | Sort-Object)
  Yes (($back -join ';') -ceq ($want -join ';')) ('acl-created-and-read-back:' + $k)
  # The creator owns it and may rewrite its DACL: give it back to this account so the scratch directory can be removed.
  $mine = New-Object Security.AccessControl.DirectorySecurity; $mine.SetSecurityDescriptorSddlForm('D:(A;OICI;FA;;;' + $me + ')', [Security.AccessControl.AccessControlSections]::Access)
  [IO.Directory]::SetAccessControl($dir, $mine)
}

# 5d. The generation files hash (generation.json filesSha256): the upgrader's digest of { slot: sha256 } over its package and generated slots
#     (upgrader/src/machine.mjs digest(newShas)); install writes it for g1, verify recomputes it. Held to node's own over the same files.
$groot = Join-Path $Scratch 'gen-root'
foreach ($s in @($PackageSlots + $GeneratedSlots + @($ReceiptSlot, 'install\backfill-manifest.json', 'state\x.json'))) { $f = Join-Path $groot $s; [void][IO.Directory]::CreateDirectory((Split-Path -Parent $f)); [IO.File]::WriteAllText($f, ('content of ' + $s)) }
$gsha = Get-GenerationFilesSha256 $groot
[string[]]$sorted = @($PackageSlots + $GeneratedSlots); [Array]::Sort($sorted, [StringComparer]::Ordinal)
$expect = Sha256Text ('{' + ((@($sorted | ForEach-Object { '"' + $_.Replace('\', '\\') + '":"' + (Sha256File (Join-Path $groot $_)) + '"' })) -join ',') + '}')
Yes ($gsha -ceq $expect) 'generation-files-canonical'
[IO.File]::WriteAllText((Join-Path $groot 'install\install-receipt.json'), 'other receipt'); [IO.File]::WriteAllText((Join-Path $groot 'state\x.json'), 'other')
Yes ((Get-GenerationFilesSha256 $groot) -ceq $gsha) 'generation-files-receipt-and-state-not-part'
$nodeCheck = 'skipped-no-node'
$nodeCmd = (Get-Command $NodeExe -ErrorAction SilentlyContinue)
if ($nodeCmd) {
  $js = Join-Path $Scratch 'gen-files.mjs'
  $planUrl = ([Uri][IO.Path]::GetFullPath((Join-Path $here '..\upgrader\src\plan.mjs'))).AbsoluteUri
  $canUrl = ([Uri][IO.Path]::GetFullPath((Join-Path $here '..\src\canonical.mjs'))).AbsoluteUri
  [IO.File]::WriteAllText($js, @"
import fs from 'node:fs'; import path from 'node:path';
const { PACKAGE_SLOTS, GENERATED_SLOTS, RECEIPT_SLOT } = await import('$planUrl');
const { digest, sha256 } = await import('$canUrl');
const root = process.argv[2], shas = {};
for (const s of [...PACKAGE_SLOTS, ...GENERATED_SLOTS]) shas[s] = sha256(fs.readFileSync(path.join(root, ...s.split('\\'))));
process.stdout.write(JSON.stringify({ digest: digest(shas), slots: [...PACKAGE_SLOTS, ...GENERATED_SLOTS, RECEIPT_SLOT] }));
"@)
  $fromNode = (& $nodeCmd.Source $js $groot | Out-String).Trim() | ConvertFrom-Json
  Yes ($LASTEXITCODE -eq 0 -and $fromNode.digest -ceq $gsha) ('generation-files-same-as-the-upgrader:' + $fromNode.digest)
  Yes ((@($fromNode.slots) -join '|') -ceq (@($PackageSlots + $GeneratedSlots + @($ReceiptSlot)) -join '|')) 'apply-slots-are-the-upgraders'
  $nodeCheck = 'checked'
}
# 6. verify-resident.ps1: /5 and /6, the new checks and their rules.
Yes ($verify.Contains("'clued.independent-ci.resident-install-receipt/5', 'clued.independent-ci.resident-install-receipt/6'") -and $verify.Contains('$ReceiptContracts -cnotcontains $receipt.contract')) 'verify-accepts-5-and-6'
foreach ($name in @("Record 'paused-as-expected'", "Record 'not-paused'", "Record 'upgrader-service'", "Record 'upgrader-pin'", "Record 'generation-current'", "Record 'two-sides-consistent'", '[string]$LinuxVersionFactsFile', "[ValidatePattern('^[0-9a-f]{64}$')][string]`$ExpectPausedSha256")) { Yes ($verify.Contains($name)) ('verify-has:' + $name) }
Yes ($verify.IndexOf("if (`$receipt.contract -ceq 'clued.independent-ci.resident-install-receipt/6') {") -lt $verify.IndexOf("Record 'upgrader-service'")) 'verify-upgrade-checks-only-for-6'
. (Use 'verify-resident.ps1' @('Test-VersionFacts', 'Test-AdminOnlySddl'))
$now = [DateTimeOffset]::Parse('2026-10-29T12:00:00Z')
$cur = [pscustomobject]@{ generation = 1; ciSourceManifestSha256 = (& $h 'c'); linux = [pscustomobject]@{ generation = 1; manifestSha256 = (& $h 'e'); ciSourceManifestSha256 = (& $h 'c') } }
function New-Facts([hashtable]$o = @{}) { $f = [ordered]@{ contract = 'clued.independent-ci.linux-version-facts/1'; generation = 1; ciSourceManifestSha256 = (& $h 'c'); sourceCommit = $null; manifestSha256 = (& $h 'e'); roles = @{}; pinsOk = $true; staged = $null; upgradeToolSha256 = (& $h 'f'); observedAt = '2026-10-29T11:55:00.000Z' }; foreach ($k in $o.Keys) { $f[$k] = $o[$k] }; ($f | ConvertTo-Json -Compress) | ConvertFrom-Json }
Yes ((Test-VersionFacts $cur (New-Facts) $now $true) -ceq 'ok') 'facts-consistent'
foreach ($c in @(@(@{ generation = 2 }, 'GENERATION'), @(@{ generation = $null }, 'GENERATION'), @(@{ ciSourceManifestSha256 = (& $h 'd') }, 'CI_SOURCE'), @(@{ manifestSha256 = (& $h 'd') }, 'LINUX_MANIFEST'), @(@{ pinsOk = $false }, 'PINS'),
    @(@{ pinsOk = 'true' }, 'PINS'), @(@{ contract = 'x' }, 'FACTS_CONTRACT'), @(@{ observedAt = '2026-10-29T11:44:59.000Z' }, 'FACTS_STALE'), @(@{ observedAt = '2026-10-29T12:06:00.000Z' }, 'FACTS_STALE'), @(@{ observedAt = 'yesterday' }, 'FACTS_STALE'))) {
  Yes ((Test-VersionFacts $cur (New-Facts $c[0]) $now $true) -ceq $c[1]) ('facts-refused:' + $c[1] + ':' + @($c[0].Keys)[0])
}
Yes ((Test-VersionFacts $cur (New-Facts @{ observedAt = '2026-10-28T00:00:00.000Z' }) $now $false) -ceq 'ok') 'facts-file-given-age-not-checked'
Yes (Test-AdminOnlySddl 'O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)') 'admin-only-sddl'
Yes (-not (Test-AdminOnlySddl ('O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FR;;;' + $OwnerSid + ')')) -and -not (Test-AdminOnlySddl ('O:' + $OwnerSid + 'G:SYD:P(A;OICI;FA;;;SY)'))) 'admin-only-sddl-refuses-others'

# 7. uninstall-resident.ps1 stops the upgrader first and deletes it; request-upgrade.ps1's request.
Yes ($uninstall.IndexOf('& $Sc stop CluedCIUpgrader') -gt 0 -and $uninstall.IndexOf('& $Sc stop CluedCIUpgrader') -lt $uninstall.IndexOf('& $Sc stop CluedCIResident') -and $uninstall.Contains('& $Sc delete CluedCIUpgrader')) 'uninstall-upgrader-first-and-deleted'
Yes ($uninstall.Contains("'UNINSTALL_REQUIRES_NO_RUNNING_UPGRADE'") -and $uninstall.Contains("(Join-Path `$Root 'upgrader\runtime\node.exe')")) 'uninstall-no-running-upgrade-and-upgrader-node-waited'
. (UseVar 'request-upgrade.ps1' @('RequestContract', 'CancelContract', 'MaxRequestBytes'))
. (Use 'request-upgrade.ps1' @('Test-PackageDirectory', 'Get-InboxName', 'New-UpgradeRequestBytes', 'New-CancelRequestBytes', 'New-Hex'))
Yes ((Get-InboxName 1761739200123 'a1b2c3d4e5f6') -cmatch '^[0-9]{13}-[0-9a-f]{12}\.json$') 'inbox-name-shape'
Yes (Test-Refused { Get-InboxName 1761739200123 'A1B2C3D4E5F6' } 'INBOX_NAME_REFUSED') 'inbox-name-hex-lower'
foreach ($p in @('C:\Users\owner\pkg', 'D:\x')) { Yes (Test-PackageDirectory $p) ('package-directory-ok:' + $p) }
foreach ($p in @('\\server\share\pkg', '\\?\C:\pkg', 'C:\a\..\b', 'C:\a\.\b', 'pkg', 'C:/a', ('C:\' + ('x' * 260)), 'C:\a"b', '')) { Yes (-not (Test-PackageDirectory $p)) ('package-directory-refused:' + $p.Length) }
$reqBytes = New-UpgradeRequestBytes '33333333-2222-4333-8444-555555555555' 'company' (& $h 'a') 'C:\Users\owner\pkg' $decision 120 'note "quoted" ok' '2026-10-29T12:00:00.000Z' (New-Hex 16)
$reqText = (New-Object Text.UTF8Encoding($false, $true)).GetString($reqBytes)
$req = $reqText | ConvertFrom-Json
Yes ((@($req.PSObject.Properties.Name) -join ',') -ceq 'contract,requestId,node,packageManifestSha256,packageDirectory,acceptanceDecisionRef,drainMaxMinutes,note,requestedAt,nonce') 'request-keys-in-a3-order'
Yes ($req.contract -ceq 'clued.independent-ci.resident-upgrade-request/1' -and $req.packageDirectory -ceq 'C:\Users\owner\pkg' -and $req.drainMaxMinutes -eq 120 -and $req.note -ceq 'note "quoted" ok' -and $req.nonce -cmatch '^[0-9a-f]{32}$' -and $reqBytes.Length -le 2048 -and $reqBytes[0] -ne 0xEF) 'request-bytes'
Yes (Test-Refused { New-UpgradeRequestBytes '33333333-2222-4333-8444-555555555555' 'company' (& $h 'a') 'C:\pkg' $decision 9 '' 'x' (New-Hex 16) } 'UPGRADE_REQUEST_REFUSED') 'request-drain-range'
Yes (Test-Refused { New-UpgradeRequestBytes '33333333-2222-4333-8444-555555555555' 'company' (& $h 'a') '\\s\x' $decision 60 '' 'x' (New-Hex 16) } 'UPGRADE_REQUEST_REFUSED') 'request-unc-refused'
Yes (Test-Refused { New-UpgradeRequestBytes '33333333-2222-4333-8444-555555555555' 'company' (& $h 'a') 'C:\pkg' $decision 60 (([string][char]1) * 500) 'x' (New-Hex 16) } 'UPGRADE_REQUEST_TOO_LARGE') 'request-2kib-bound'
$cancel = ((New-Object Text.UTF8Encoding($false)).GetString((New-CancelRequestBytes '33333333-2222-4333-8444-555555555555' '2026-10-29T12:00:00.000Z' (New-Hex 16)))) | ConvertFrom-Json
Yes ((@($cancel.PSObject.Properties.Name) -join ',') -ceq 'contract,requestId,requestedAt,nonce' -and $cancel.contract -ceq 'clued.independent-ci.resident-upgrade-cancel/1') 'cancel-bytes'

# 8. C#: the host compiled with install's own function, its pure tests, the shared recipe, and the command line as the SCM hands it over.
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'; $csc = Join-Path $fw 'csc.exe'
$hostBin = Join-Path $Scratch 'upgrader-bin'; [void][IO.Directory]::CreateDirectory($hostBin)
$hostSha = Invoke-UpgraderHostCompile $csc $fw $hostBin (Join-Path $here 'UpgraderServiceHost.cs')
Yes ($hostSha -cmatch '^[0-9a-f]{64}$' -and (Test-Path -LiteralPath (Join-Path $hostBin 'UpgraderServiceHost.exe'))) 'compile-upgrader-host-with-the-install-function'
$pure = Join-Path $Scratch 'upgrader-host-pure.exe'
& $csc /nologo /noconfig /target:exe /main:UpgraderHostPureTests ('/out:' + $pure) "/reference:$($fw)System.dll" "/reference:$($fw)System.ServiceProcess.dll" (Join-Path $here 'UpgraderServiceHost.cs') (Join-Path $here 'UpgraderHostPureTests.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-upgrader-host-pure'
$out = & $pure $Scratch | Out-String
Yes ($LASTEXITCODE -eq 0 -and $out -match 'UPGRADER_HOST_PURE_PASS') ('upgrader-host-pure:' + $out.Trim())
$csharp = [int](($out | ConvertFrom-Json).assertions)
$tail = $ubin.Substring($ubin.IndexOf('" ') + 2)
$psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $pure; $psi.Arguments = '--check-args ' + $tail; $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
$pp = [Diagnostics.Process]::Start($psi); $said = $pp.StandardOutput.ReadToEnd().Trim(); $pp.WaitForExit()
Yes ($pp.ExitCode -eq 0 -and $said -ceq ('ok|"' + $ProdRoot + '\upgrader\runtime\node.exe" "' + $ProdRoot + '\upgrader\' + $m + '\upgrader\src\upgrader-main.mjs" --root "' + $ProdRoot + '" --config-sha256 ' + $cfgSha)) ('host-parses-the-installed-command-line:' + $said)
$psi.Arguments = '--check-args ' + $tail.Replace('\upgrader\runtime\node.exe', '\runtime\node.exe')
$pp = [Diagnostics.Process]::Start($psi); $said = $pp.StandardOutput.ReadToEnd().Trim(); $pp.WaitForExit()
Yes ($pp.ExitCode -eq 3 -and $said -ceq 'UPGRADER_ARGS_REFUSED') 'host-refuses-another-node'
# The shared compile recipe (install step service-hosts = upgrade-apply Compile) into the scratch directory.
$v2 = [IO.Path]::GetFullPath((Join-Path $here '..\..\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'))
$rbin = Join-Path $Scratch 'recipe\bin'; $rhelpers = Join-Path $Scratch 'recipe\helpers'; [void][IO.Directory]::CreateDirectory($rbin); [void][IO.Directory]::CreateDirectory($rhelpers)
$hashes = Invoke-CompileRecipe $csc $fw $rbin $rhelpers (Join-Path $here 'ResidentServiceHost.cs') (Join-Path $here 'SwapBroker.cs') $v2 (Join-Path $here 'CompanionJobHost.cs')
Yes ((@($hashes.Keys) -join ',') -ceq 'ResidentServiceHostSha256,SwapBrokerSha256,genericHelperSha256,companionJobHostSha256' -and @($hashes.Values | Where-Object { $_ -cnotmatch '^[0-9a-f]{64}$' }).Count -eq 0) 'compile-recipe-four-outputs'
foreach ($f in @('bin\ResidentServiceHost.exe', 'bin\SwapBroker.exe', 'bin\CluedCompanionJobHost.exe', 'helpers\controller-formal-generic-v2.exe')) { Yes (Test-Path -LiteralPath (Join-Path $Scratch ('recipe\' + $f))) ('compile-recipe-output:' + $f) }
$bc = Get-BrokerConfigJson (& $h 'a') (& $h 'b') (ConvertTo-NodeProfileCanonical $node) $profileSha (& $h 'c')
$bcv = $bc | ConvertFrom-Json
Yes ($bcv.contract -ceq 'clued.independent-ci.swap-broker-config/3' -and $bcv.helper.name -ceq 'controller-formal-generic-v2.exe' -and $bcv.originalBinary -ceq '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"' -and $bcv.node.nodeName -ceq 'company' -and $bcv.acceptanceSha256 -ceq (& $h 'c')) 'broker-config-json'

[ordered]@{ status = 'UPGRADE_WINDOWS_OFFLINE_PASS'; assertions = $n; csharpAssertions = $csharp; generationFilesNode = $nodeCheck; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
