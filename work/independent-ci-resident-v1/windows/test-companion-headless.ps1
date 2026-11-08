<#
  Offline checks of M5, the companion without the Owner's log-on (ADR 0022 section 7). Nothing on the host is read or changed: no
  task is registered or read, no credential box is shown, nothing outside the NEW scratch directory given by the caller is written.
  - one text: companion-headless.ps1's shared functions are install-resident.ps1's and upgrade-apply.ps1's (and companion-gh-login.ps1's
    folder rule); the upgrade channel never registers the companion task;
  - C#: the supervisor and the task registrar compiled with install's own function, SupervisorPureTests.cs and RegistrarPureTests.cs run
    (the registrar's vtable slots read-only); the launch file PowerShell writes is the one the supervisor accepts;
  - the launch file is replaced atomically; the lockout rule; the pending marker and its order in rearm and verify (T6);
  - the password never in PowerShell (T8): no Get-Credential, Read-Host, SecureString or password logon registered from a script; the
    registrar zeroes its buffers and prints codes only; the secure desktop flag;
  - the companion's git configuration is the same text in PowerShell and in node; the probe writes nothing.
  powershell -NoProfile -ExecutionPolicy Bypass -File test-companion-headless.ps1 -Scratch <new empty directory> [-NodeExe <node.exe>]
#>
param([Parameter(Mandatory)][string]$Scratch, [string]$NodeExe = 'node')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Scratch) { if (@(Get-ChildItem -LiteralPath $Scratch -Force).Count) { throw 'EMPTY_SCRATCH_REQUIRED' } } else { [void][IO.Directory]::CreateDirectory($Scratch) }
$Scratch = (Resolve-Path -LiteralPath $Scratch).ProviderPath
$here = $PSScriptRoot
$n = 0
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }

# 1. Parse; functions by file.
$functions = @{}; $texts = @{}
foreach ($file in @('companion-headless.ps1', 'install-resident.ps1', 'upgrade-apply.ps1', 'verify-resident.ps1', 'rearm-resident.ps1', 'uninstall-resident.ps1', 'companion-gh-login.ps1', 'probe-companion-headless.ps1', 'companion-headless-fallback.ps1', 'prepare-companion-account.ps1', 'request-upgrade.ps1')) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here $file), [ref]$tokens, [ref]$errors)
  Yes ($errors.Count -eq 0) ('parse:' + $file)
  $texts[$file] = [IO.File]::ReadAllText((Join-Path $here $file))
  foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$file + ':' + $f.Name] = $f.Extent.Text }
}
# The code without its comment lines and without the leading <# ... #> help block.
$codeOf = { param([string]$t) $i = $t.IndexOf("`n#>"); if ($t.StartsWith('<#') -and $i -gt 0) { $t = $t.Substring($i + 3) }; (@($t -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n") }

# 2. One text.
$sharedUpgrade = @('Get-SupervisorAction', 'Get-CompanionTaskSddl', 'Get-CompanionLaunchArguments', 'Get-CompanionGhDirs', 'Get-CompanionPathDirs', 'Get-CompanionLaunchJson', 'Write-CompanionLaunch', 'Get-NotifierAction', 'Register-NotifierTask', 'Get-CompanionTaskFacts')
# The frozen upgrade channel's Get-CompanionTaskFacts keeps the text comparison of the DACL (2026-11-08, 29th DESK reinstall: the
# non-frozen copies compare it as a security descriptor, Test-CompanionTaskDacl); apart from that one line it is the same text.
$frozenDacl = @{ 'Get-CompanionTaskFacts' = @('if (-not (Test-CompanionTaskDacl $dacl $ownerSid)) {', 'if ($dacl -cne (Get-CompanionTaskSddl $ownerSid)) {') }
foreach ($name in $sharedUpgrade) {
  $mine = $functions['companion-headless.ps1:' + $name]
  if ($frozenDacl.ContainsKey($name)) { Yes ($mine.Contains($frozenDacl[$name][0])) ('frozen-difference-present:' + $name); $mine = $mine.Replace($frozenDacl[$name][0], $frozenDacl[$name][1]) }
  Yes ($functions.ContainsKey('upgrade-apply.ps1:' + $name) -and $functions['upgrade-apply.ps1:' + $name] -ceq $mine) ('shared-upgrade:' + $name)
}
foreach ($name in @($sharedUpgrade + 'Register-CompanionTaskInteractive' + 'Test-CompanionTaskDacl')) { Yes ($functions.ContainsKey('install-resident.ps1:' + $name) -and $functions['install-resident.ps1:' + $name] -ceq $functions['companion-headless.ps1:' + $name]) ('shared-install:' + $name) }
Yes ($functions['companion-gh-login.ps1:Get-CompanionGhDirs'] -ceq $functions['companion-headless.ps1:Get-CompanionGhDirs']) 'shared-gh-login:Get-CompanionGhDirs'
Yes (-not $functions.ContainsKey('upgrade-apply.ps1:Register-CompanionTaskInteractive')) 'upgrade-has-no-companion-task-registration'
foreach ($file in @('install-resident.ps1', 'upgrade-apply.ps1')) {
  $code = & $codeOf $texts[$file]
  Yes (-not ($code -match 'RegisterTaskDefinition\([^)]*,\s*1\s*,')) ('no-password-logon-from-a-script:' + $file)
}

# 3. Pure functions of the shared file.
. ([scriptblock]::Create($texts['companion-headless.ps1']))
$root = Join-Path $Scratch 'root'; $profileDir = 'C:\Users\owner'
foreach ($d in @('config', 'install', 'runtime', ('resident\' + ('b' * 64) + '\src'))) { [void][IO.Directory]::CreateDirectory((Join-Path $root $d)) }
$sa = Get-SupervisorAction 'C:\ProgramData\CluedIndependentCI\resident'
Yes ($sa.path -ceq 'C:\ProgramData\CluedIndependentCI\resident\bin\CluedCompanionSupervisor.exe' -and $sa.arguments -ceq '"C:\ProgramData\CluedIndependentCI\resident"') 'supervisor-action'
Yes ((Get-CompanionTaskSddl 'S-1-5-21-1-2-3-1001') -ceq 'D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;S-1-5-21-1-2-3-1001)') 'task-sddl-owner-read-only'
# 2026-11-08, the 29th DESK reinstall: the Task Scheduler reads the protected DACL back as D:PAI(...) (a D:P(...) cannot be stored), so
# Get-CompanionTaskFacts compares the DACL as a security descriptor (protected, the same ACEs in order), not as a string. Run against a
# fake Schedule.Service (no task is read): the interactive and the password definitions with the DACL the scheduler returns.
$ownerT = 'S-1-5-21-858977881-4031698862-3006450925-1000'
$fakeFacts = {
  param([string]$dacl, [int]$logonType)
  $sa2 = Get-SupervisorAction $root
  $actions = [pscustomobject]@{ Count = 1; Only = [pscustomobject]@{ Path = $sa2.path; Arguments = $sa2.arguments } }
  $actions | Add-Member -MemberType ScriptMethod -Name Item -Value { param($i) $this.Only }
  $triggers = if ($logonType -eq 1) { @([pscustomobject]@{ Type = 1; Repetition = [pscustomobject]@{ Interval = 'PT15M'; Duration = '' } }, [pscustomobject]@{ Type = 8; Delay = 'PT30S' }) } else { @([pscustomobject]@{ Type = 9 }) }
  $def = [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = $ownerT; RunLevel = 0; LogonType = $logonType }; Actions = $actions; Triggers = $triggers
    Settings = [pscustomobject]@{ MultipleInstances = 2; ExecutionTimeLimit = 'PT0S'; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false; RestartCount = 0; StartWhenAvailable = $true } }
  $task = [pscustomobject]@{ Definition = $def; State = 3; LastTaskResult = 0; Xml = '<Task/>'; Dacl = $dacl }
  $task | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptor -Value { param($f) if ($f -eq 4) { $this.Dacl } else { 'O:BA' } }
  $folder = [pscustomobject]@{ Task = $task }; $folder | Add-Member -MemberType ScriptMethod -Name GetTask -Value { param($name) if ($name -cne 'CluedCIResidentCompanion') { throw 'NO_TASK' }; $this.Task }
  $svc = [pscustomobject]@{ Folder = $folder }; $svc | Add-Member -MemberType ScriptMethod -Name Connect -Value { }
  $svc | Add-Member -MemberType ScriptMethod -Name GetFolder -Value { param($path) if ($path -cne '\Clued') { throw 'NO_FOLDER' }; $this.Folder }
  function New-Object { param([string]$ComObject) if ($ComObject -cne 'Schedule.Service') { throw 'UNEXPECTED_NEW_OBJECT' }; $svc }
  Get-CompanionTaskFacts $root $ownerT
}
$aces = "(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;$ownerT)"
foreach ($c in @(@('D:PAI', 3, 'interactive'), @('D:P', 3, 'interactive'), @('D:PAI', 1, 'password'), @('D:PARAI', 3, 'interactive'))) {
  $f = & $fakeFacts ($c[0] + $aces) $c[1]
  Yes ($f.mode -ceq $c[2] -and @($f.problems).Count -eq 0) ('task-dacl-semantic-ok:' + $c[0] + ':' + $c[2] + ':' + $f.mode + ':' + (@($f.problems) -join ','))
}
$f = & $fakeFacts "D:PAI(A;;0x1f01ff;;;SY)(A;;0x1f01ff;;;BA)(A;;0x120089;;;$ownerT)" 3
Yes ($f.mode -ceq 'interactive' -and @($f.problems).Count -eq 0) 'task-dacl-semantic-ok:numeric-rights'
foreach ($c in @(@('not-protected', ('D:AI' + $aces)), @('no-flags', ('D:' + $aces)), @('extra-ace', ('D:PAI' + $aces + '(A;;FR;;;AU)')), @('owner-full', "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;$ownerT)"),
    @('order', "D:PAI(A;;FA;;;BA)(A;;FA;;;SY)(A;;FR;;;$ownerT)"), @('missing-ace', 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)'), @('other-owner', 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;S-1-5-21-1-2-3-1001)'),
    @('inherited-ace', "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;ID;FR;;;$ownerT)"), @('deny-ace', "D:PAI(D;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;$ownerT)"), @('null-dacl', 'D:NO_ACCESS_CONTROL'), @('empty', ''), @('garbage', 'D:PAI(x'))) {
  foreach ($lt in @(3, 1)) {
    $f = & $fakeFacts $c[1] $lt
    Yes ($f.mode -ceq 'other' -and @($f.problems) -ccontains 'sddl') ('task-dacl-semantic-refused:' + $c[0] + ':' + $lt + ':' + $f.mode + ':' + (@($f.problems) -join ','))
  }
}
$json = Get-CompanionLaunchJson 'C:\ProgramData\CluedIndependentCI\resident' 3 ('a' * 64) ('b' * 64) ('c' * 64) ('d' * 64) $profileDir (Get-CompanionPathDirs 'C:\Program Files\GitHub CLI\gh.exe')
$parsed = $json | ConvertFrom-Json
Yes ((@($parsed.PSObject.Properties.Name) -join ',') -ceq 'contract,generation,nodeExe,nodeExeSha256,entry,entrySha256,configSha256,ghConfigDir,homeDir,pathDirs') 'launch-keys-in-order'
Yes ($parsed.ghConfigDir -ceq 'C:\Users\owner\AppData\Local\CluedIndependentCI\companion-gh\gh' -and $parsed.homeDir -ceq 'C:\Users\owner\AppData\Local\CluedIndependentCI\companion-gh\home') 'launch-own-gh-login'
Yes (((@($parsed.pathDirs)) -join ';') -ceq 'C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd') 'launch-path-dirs'
$refusedHash = try { $null = Get-CompanionLaunchJson $root 1 ('A' * 64) ('b' * 64) ('c' * 64) ('d' * 64) $profileDir @(); $false } catch { $_.Exception.Message -ceq 'COMPANION_LAUNCH_HASH_REFUSED' }
Yes $refusedHash 'launch-hash-shape'
# atomic replace in config\: the old or the new file, never a part; no temporary file left
$sha1 = Write-CompanionLaunch $root '{"a":1}'
$sha2 = Write-CompanionLaunch $root '{"a":2}'
Yes (([IO.File]::ReadAllText((Join-Path $root 'config\companion-launch.json'))) -ceq '{"a":2}' -and $sha1 -cne $sha2) 'launch-replaced'
Yes (@(Get-ChildItem -LiteralPath (Join-Path $root 'config') -Filter '*.tmp').Count -eq 0) 'launch-no-temporary-left'
$na = Get-NotifierAction 'C:\ProgramData\CluedIndependentCI\resident' ('b' * 64)
Yes ($na.path -ceq 'C:\Windows\System32\conhost.exe' -and $na.arguments.Contains('\src\notifier-main.mjs" --root "C:\ProgramData\CluedIndependentCI\resident"')) 'notifier-action'
# the lockout rule (ADR 0022 section 4.1): threshold 0, or >= 6 with a window under 15 minutes
$net = "Force user logoff how long after time expires?:       Never`r`nMinimum password age (days):                          0`r`nMaximum password age (days):                          42`r`nMinimum password length:                              0`r`nLength of password history maintained:                None`r`nLockout threshold:                                    10`r`nLockout duration (minutes):                           10`r`nLockout observation window (minutes):                 10`r`nComputer role:                                        WORKSTATION`r`nThe command completed successfully.`r`n"
$p = ConvertFrom-NetAccounts $net
Yes ($p.threshold -eq 10 -and $p.durationMinutes -eq 10 -and $p.windowMinutes -eq 10 -and (Test-LockoutMargin $p)) 'lockout-desk-today-passes'
Yes ((ConvertFrom-NetAccounts $net.Replace('Lockout threshold:                                    10', 'Lockout threshold:                                    Never')).threshold -eq 0) 'lockout-never-is-0'
foreach ($c in @(@(0, 30, $true), @(6, 14, $true), @(5, 10, $false), @(10, 15, $false), @(10, 30, $false))) { Yes ((Test-LockoutMargin ([ordered]@{ threshold = $c[0]; windowMinutes = $c[1] })) -eq $c[2]) ('lockout-rule:' + $c[0] + '/' + $c[1]) }
Yes ($null -eq (ConvertFrom-NetAccounts 'garbage') -and -not (Test-LockoutMargin $null)) 'lockout-unreadable-fails'
# the pending marker: create-only, read back, stale after 15 minutes (T6)
Write-CompanionPending $root 'headless' 'S-1-5-21-1-2-3-1001'
$pm = Read-CompanionPending $root
Yes ($pm.contract -ceq 'clued.independent-ci.companion-headless-pending/1' -and $pm.mode -ceq 'headless' -and $pm.fallback.logonType -ceq 'InteractiveToken') 'pending-written'
$again = try { Write-CompanionPending $root 'headless' 'S-1-5-21-1-2-3-1001'; $false } catch { $true }
Yes $again 'pending-create-only'
Yes (-not (Test-CompanionPendingStale $pm ([DateTimeOffset]::UtcNow.AddMinutes(14)))) 'pending-fresh'
Yes (Test-CompanionPendingStale $pm ([DateTimeOffset]::UtcNow.AddMinutes(16))) 'pending-stale-after-15-minutes'
Yes (Test-CompanionPendingStale ([pscustomobject]@{ startedAt = 'x' }) ([DateTimeOffset]::UtcNow)) 'pending-unreadable-time-is-stale'
Yes ((Test-CompanionLogonFailure 0x8007052EL) -and (Test-CompanionLogonFailure 0x8007052E) -and (Test-CompanionLogonFailure ([int64]-2147023570)) -and -not (Test-CompanionLogonFailure 0)) 'logon-failure-codes'

# 4. Order of the switch (ADR 0022 section 4.4) and the fall-back (T6), by the code.
$sw = $functions['companion-headless.ps1:Invoke-CompanionHeadless']
$iPre = $sw.IndexOf('Get-CompanionHeadlessPreflight'); $iMark = $sw.IndexOf('Write-CompanionPending'); $iReg = $sw.IndexOf('register-password'); $iRun = $sw.IndexOf('Start-CompanionTask'); $iQual = $sw.IndexOf('Wait-CompanionQualified')
Yes ($iPre -gt 0 -and $iPre -lt $iMark -and $iMark -lt $iReg -and $iReg -lt $iRun -and $iRun -lt $iQual) 'switch-order-preflight-marker-password-run-qualify'
# review M1: the SYSTEM fall-back task is registered with the marker, before the password; removed only when qualified (or by a fall-back)
$iFb = $sw.IndexOf('Register-CompanionFallbackTask')
Yes ($iFb -gt $iPre -and $iFb -lt $iReg) 'switch-registers-the-fallback-task-before-the-password'
Yes ($functions['companion-headless.ps1:Invoke-CompanionFallback'].Contains('Remove-CompanionFallbackTask')) 'fallback-removes-the-fallback-task'
$fbReg = $functions['companion-headless.ps1:Register-CompanionFallbackTask']
Yes ($fbReg.Contains("UserId = 'S-1-5-18'") -and $fbReg.Contains('Triggers.Create(8)') -and $fbReg.Contains('Triggers.Create(1)') -and $fbReg.Contains("'D:P(A;;FA;;;SY)(A;;FA;;;BA)'") -and $fbReg.Contains('companion-headless-fallback.ps1')) 'fallback-task-system-boot-and-16-minutes-admin-only'
$fb = $texts['companion-headless-fallback.ps1']
Yes ($fb.Contains("throw 'SYSTEM_REQUIRED'") -and $fb.Contains("throw 'RUN_THE_INSTALLED_COPY'") -and $fb.IndexOf('Test-CompanionPendingAbandoned') -lt $fb.IndexOf('Invoke-CompanionStopAndFallback') -and -not ($fb -match 'param\s*\(')) 'fallback-script-system-installed-abandoned-only-no-arguments'
# review round 2: the fall-back task before the marker; a repeated time trigger; culture-invariant time; never rolls back a running switch
Yes ($iFb -lt $iMark) 'switch-fallback-task-before-the-marker'
Yes ($fbReg.Contains("`$t.Repetition.Interval = 'PT15M'") -and $fbReg.Contains('InvariantCulture')) 'fallback-task-repeats-invariant-time'
$alive = [pscustomobject]@{ startedAt = [DateTimeOffset]::UtcNow.AddMinutes(-60).ToString('o'); pid = $PID; processStart = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o') }
Yes ((Test-CompanionPendingOwnerAlive $alive) -and -not (Test-CompanionPendingAbandoned $alive ([DateTimeOffset]::UtcNow))) 'pending-of-a-running-switch-is-never-abandoned'
$gone = [pscustomobject]@{ startedAt = $alive.startedAt; pid = $PID; processStart = '2000-01-01T00:00:00.0000000Z' }
Yes (-not (Test-CompanionPendingOwnerAlive $gone) -and (Test-CompanionPendingAbandoned $gone ([DateTimeOffset]::UtcNow))) 'pending-of-an-ended-switch-is-abandoned-when-stale'
$young = [pscustomobject]@{ startedAt = [DateTimeOffset]::UtcNow.ToString('o'); pid = 1; processStart = 'x' }
Yes (-not (Test-CompanionPendingAbandoned $young ([DateTimeOffset]::UtcNow))) 'pending-young-is-not-abandoned'
Yes ($pm.pid -eq $PID -and $pm.processStart) 'pending-records-the-switch-process'
Yes ($sw.Contains("'COMPANION_HEADLESS_SWITCH_IN_PROGRESS'") -and $sw.Contains('Remove-Item -LiteralPath (Join-Path $root $CompanionPendingFile) -Force -ErrorAction SilentlyContinue')) 'switch-never-two-at-once-marker-removal-tolerant'
foreach ($f in @('rearm-resident.ps1', 'verify-resident.ps1', 'companion-headless-fallback.ps1')) { Yes ($texts[$f].Contains('Invoke-CompanionStopAndFallback')) ('stop-before-fallback:' + $f) }
# review B1: the time the qualification counts from is taken after the old instance ended, and the child's own start bounds the signals
$iSince = $sw.IndexOf('$since = [DateTimeOffset]::UtcNow')
Yes ($iSince -gt $sw.IndexOf('Wait-CompanionTaskNotRunning') -and $iSince -lt $iRun) 'switch-counts-from-after-the-old-instance'
Yes ($functions['companion-headless.ps1:Test-CompanionQualifiedOnce'].Contains("'companion-process-older-than-the-switch'") -and $functions['companion-headless.ps1:Test-CompanionQualifiedOnce'].Contains('$since = $childStart')) 'qualification-signals-after-the-child-started'
# review M2: the registrar runs with a cleared environment; injection variables refuse the switch
$ir = $functions['companion-headless.ps1:Invoke-CompanionRegistrar']
Yes ($ir.Contains('$psi.EnvironmentVariables.Clear()') -and -not $ir.Contains('USERPROFILE')) 'registrar-cleared-environment'
Yes ($functions['companion-headless.ps1:Get-CompanionHeadlessPreflight'].Contains('COMPANION_HEADLESS_INJECTION_VARIABLES')) 'preflight-refuses-injection-variables'
foreach ($v in @('COR_ENABLE_PROFILING', 'COR_PROFILER_PATH_64', 'COMPlus_ReadyToRun', 'DOTNET_StartupHooks', 'NODE_OPTIONS')) { Yes ($v -match $CompanionInjectVariables) ('inject-variable:' + $v) }
Yes (-not ('PATH' -match $CompanionInjectVariables)) 'inject-variable-not-path'
$vt = $texts['verify-resident.ps1']
Yes ($vt.Contains("'STALE_MARKER_LEFT_TO_THE_FALLBACK_TASK'") -and $vt.IndexOf("-ceq 'S-1-5-18') {") -lt $vt.IndexOf('elseif ($verifyCanFix) {')) 'verify-as-system-never-touches-the-task'
Yes ($sw.IndexOf('Read-CompanionPending') -lt $iPre -and $sw.Substring(0, $iPre).Contains('Invoke-CompanionStopAndFallback')) 'switch-first-rolls-back-an-earlier-marker'
Yes (([regex]::Matches($sw, 'Invoke-Companion(StopAnd)?Fallback')).Count -ge 3 -and ([regex]::Matches($sw, "Remove-Item -LiteralPath \(Join-Path \`$root \`$CompanionPendingFile\)")).Count -eq 1) 'switch-removes-the-marker-only-when-qualified'
$q = $functions['companion-headless.ps1:Test-CompanionQualifiedOnce']
foreach ($k in @("'session-not-0'", "'token-elevated'", "'token-user'", "'image-path'", "'heartbeat'", "'linux-facts'", 'token-facts', 'adminsDenyOnly')) { Yes ($q.Contains($k) -or $functions['companion-headless.ps1:Get-ProcessTokenFacts'].Contains($k)) ('qualification-checks:' + $k) }
Yes ((Get-Variable CompanionQualifySeconds).Value -eq 480) 'qualification-8-minutes'
$verify = $texts['verify-resident.ps1']
Yes ($verify.IndexOf('Test-CompanionPendingAbandoned') -gt 0 -and $verify.IndexOf('Test-CompanionPendingAbandoned') -lt $verify.IndexOf("Record 'companion-task'") -and $verify.Contains('STALE_MARKER_FELL_BACK')) 'verify-rolls-back-a-stale-marker-first'
# 4b. 2026-11-08 (30th DESK): bin\'s registrar is install-only and imported CredUnpackAuthenticationBufferW (credui.dll exports
# CredUnPackAuthenticationBufferW). The switch builds this generation's registrar for itself, from the pinned source, with install's
# recipe, in a new admin-only directory it deletes at the end. The supervisor stays bin\'s.
$iBuild = $sw.IndexOf('New-CompanionBuild $root')
Yes ($iBuild -gt $iPre -and $iBuild -lt $iFb -and $iBuild -lt $iMark) 'switch-builds-before-the-fallback-task-and-the-marker'
Yes ($sw.Contains("Invoke-CompanionRegistrar `$root @('register-password', `$root) `$build.registrar.exe") -and $sw.Contains('Wait-CompanionQualified $root $ownerSid $since -registrar $build.registrar.exe') -and [regex]::IsMatch($sw, '\} finally \{ Remove-CompanionBuild \$build\.directory \}\s*\}\s*\z')) 'switch-uses-its-build-and-always-deletes-it'
Yes ($functions['companion-headless.ps1:Get-ProcessTokenFacts'].Contains("Invoke-CompanionRegistrar `$root @('token-facts', [string]`$processId) `$registrar") -and $functions['companion-headless.ps1:Test-CompanionQualifiedOnce'].Contains('Get-ProcessTokenFacts $root ([int]$p[0].ProcessId) $registrar') -and $functions['companion-headless.ps1:Wait-CompanionQualified'].Contains('Test-CompanionQualifiedOnce $root $ownerSid $since $registrar')) 'token-facts-through-the-build'
# the recipe: the csc command line of install's Invoke-CompanionSupervisorCompile (which compiles exactly these two programs), the same text
$cscLine = { param([string]$f) @($f -split "`r?`n" | Where-Object { $_ -match '^\s*& \$compiler ' } | ForEach-Object { $_.Trim() }) }
$installCsc = @(& $cscLine $functions['install-resident.ps1:Invoke-CompanionSupervisorCompile']); $mineCsc = @(& $cscLine $functions['companion-headless.ps1:Invoke-CompanionBinaryCompile'])
Yes ($installCsc.Count -eq 1 -and $mineCsc.Count -eq 1 -and $installCsc[0].Replace('$pair[1]', '$cs') -ceq $mineCsc[0] -and $mineCsc[0].Contains('/noconfig /target:winexe /platform:x64 /optimize+')) ('build-recipe-is-install:' + ($mineCsc -join '|'))
Yes ((@($CompanionBuildPrograms.Keys) -join ',') -ceq 'registrar' -and $CompanionBuildPrograms.registrar[0] -ceq 'windows/CompanionTaskRegistrar.cs' -and $CompanionBuildPrograms.registrar[1] -ceq 'CluedCompanionTaskRegistrar.exe' -and
  $functions['install-resident.ps1:Invoke-CompanionSupervisorCompile'].Contains("@('CluedCompanionTaskRegistrar.exe', `$registrarCs") -and -not $sw.Contains('CluedCompanionSupervisor.exe')) 'build-only-the-registrar'
Yes ($CompanionCsc -ceq ($CompanionFramework + 'csc.exe') -and $CompanionFramework -ceq 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\' -and $texts['install-resident.ps1'].Contains("`$Csc = '$CompanionCsc'")) 'build-compiler-is-installs'
Yes ($CompanionBuildSddl -ceq 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' -and $functions['companion-headless.ps1:New-CompanionBuild'].Contains('[string]$dacl = $CompanionBuildSddl')) 'build-directory-system-and-administrators-only'
Yes ($functions['companion-headless.ps1:Get-CompanionHeadlessPreflight'].Contains("'COMPANION_HEADLESS_COMPILER_MISSING'")) 'preflight-needs-the-compiler'
# A real build in the scratch directory (not elevated: the test adds its own account to the DACL; only the registrar's read-only self-test
# and a refused root run, never register-password on the real root).
$meSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$testDacl = $CompanionBuildSddl + "(A;OICI;FA;;;$meSid)"
$regText = [IO.File]::ReadAllText((Join-Path $here 'CompanionTaskRegistrar.cs')); $supText = [IO.File]::ReadAllText((Join-Path $here 'CompanionSupervisor.cs'))
$newGen = {
  param([hashtable]$sourceTexts, [hashtable]$pinSha = @{}, [string[]]$unpinned = @(), [string]$receiptGen = $null)
  $r = Join-Path $Scratch ('gen-' + [guid]::NewGuid().ToString('N'))
  foreach ($d in @('install', 'config', 'bin')) { [void][IO.Directory]::CreateDirectory((Join-Path $r $d)) }
  $rows = @('{"path":"windows/CompanionTool.cs","sha256":"' + ('0' * 64) + '"}')
  $files = @{}
  foreach ($rel in @('windows/CompanionTaskRegistrar.cs', 'windows/CompanionSupervisor.cs')) {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$sourceTexts[$rel]); $files[$rel] = $bytes
    if ($unpinned -notcontains $rel) { $rows += ('{"path":"' + $rel + '","sha256":"' + $(if ($pinSha.ContainsKey($rel)) { $pinSha[$rel] } else { Get-CompanionSha256 $bytes }) + '"}') }
  }
  $manBytes = [Text.Encoding]::UTF8.GetBytes('{"contract":"x","files":[' + ($rows -join ',') + '],"root":"resident"}' + "`n")
  [IO.File]::WriteAllBytes((Join-Path $r 'config\resident-installed-manifest.json'), $manBytes)
  $gen = Get-CompanionSha256 $manBytes
  [void][IO.Directory]::CreateDirectory((Join-Path $r ('resident\' + $gen + '\windows')))
  foreach ($rel in @($files.Keys)) { [IO.File]::WriteAllBytes((Join-Path $r ('resident\' + $gen + '\' + $rel.Replace('/', '\'))), $files[$rel]) }
  [IO.File]::WriteAllText((Join-Path $r 'install\install-receipt.json'), '{"residentManifestSha256":"' + $(if ($receiptGen) { $receiptGen } else { $gen }) + '"}')
  $r
}
$good = @{ 'windows/CompanionTaskRegistrar.cs' = $regText; 'windows/CompanionSupervisor.cs' = $supText }
$gr = & $newGen $good
$stale = Join-Path $gr ('install\companion-build-' + ('a' * 32)); [void][IO.Directory]::CreateDirectory($stale)
$b = New-CompanionBuild $gr $testDacl
Yes ((Split-Path -Leaf $b.directory) -cmatch '^companion-build-[0-9a-f]{32}$' -and (Split-Path -Parent $b.directory) -ceq (Join-Path $gr 'install') -and (Test-Path -LiteralPath $b.registrar.exe -PathType Leaf) -and (@($b.Keys) -join ',') -ceq 'directory,generation,registrar' -and @(Get-ChildItem -LiteralPath $b.directory -Filter '*.exe').Count -eq 1) 'build-in-a-new-directory-under-install'
Yes ($b.registrar.sourceSha256 -ceq (Get-CompanionSha256 ([Text.Encoding]::UTF8.GetBytes($regText))) -and $b.registrar.sha256 -ceq (Get-CompanionSha256 ([IO.File]::ReadAllBytes($b.registrar.exe))) -and $b.generation -cmatch '^[0-9a-f]{64}$') 'build-hashes'
Yes (-not (Test-Path -LiteralPath $stale)) 'build-deletes-a-cut-off-switch-build'
$acl = (Get-Acl -LiteralPath $b.directory).Sddl
Yes ($acl.Contains('D:P') -and -not $acl.Contains('ID;')) ('build-directory-protected:' + $acl)
$v = (& $b.registrar.exe vtable-selftest | Out-String).Trim()
Yes ($v.StartsWith('{"contract":"clued.independent-ci.companion-registrar/1","code":"VTABLE_OK"')) ('build-registrar-runs:' + $v)
$v = (& $b.registrar.exe register-password 'C:\Temp' | Out-String).Trim()
Yes ($v.Contains('REGISTRAR_ELEVATION_REQUIRED') -or $v.Contains('REGISTRAR_ARGS_REFUSED')) ('build-registrar-refuses-other-root:' + $v)
Remove-CompanionBuild $b.directory
Yes (-not (Test-Path -LiteralPath $b.directory)) 'build-deleted'
# refused: a source not the pinned bytes, not pinned, the manifest not the receipt's generation, a source that does not compile; nothing left
foreach ($c in @(
    @('COMPANION_BUILD_SOURCE_NOT_THE_GENERATION', (& $newGen $good @{ 'windows/CompanionTaskRegistrar.cs' = ('f' * 64) })),
    @('COMPANION_BUILD_SOURCE_NOT_PINNED', (& $newGen $good @{} @('windows/CompanionTaskRegistrar.cs'))),
    @('COMPANION_BUILD_MANIFEST_NOT_THE_GENERATION', (& $newGen $good @{} @() ('e' * 64))),
    @('COMPANION_BUILD_RECEIPT_REFUSED', (& $newGen $good @{} @() 'x')),
    @('COMPANION_BUILD_COMPILE_FAILED', (& $newGen @{ 'windows/CompanionTaskRegistrar.cs' = 'class X { void Main( }'; 'windows/CompanionSupervisor.cs' = $supText })))) {
  $why = try { $null = New-CompanionBuild $c[1] $testDacl; 'built' } catch { $_.Exception.Message }
  Yes ($why -ceq $c[0]) ('build-refused:' + $c[0] + ':' + $why)
  Yes (@(Get-ChildItem -LiteralPath (Join-Path $c[1] 'install') -Force | Where-Object { $_.Name -like 'companion-build-*' }).Count -eq 0) ('build-refused-leaves-nothing:' + $c[0])
}
# The switch with fakes (no task is read or registered, no registrar runs, no credential box): the build is used for register-password and
# token-facts and deleted on every way out; a build that fails changes nothing.
$runSwitch = {
  param([string]$registrarOut, [string]$buildFails = $null, [object]$qualify = $null, [bool]$throwAtRun = $false)
  $dir = Join-Path $Scratch ('switch-' + [guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory((Join-Path $dir 'install'))
  [IO.File]::WriteAllText((Join-Path $dir 'install\install-receipt.json'), '{"residentManifestSha256":"' + ('b' * 64) + '"}')
  $fakeCalls = [Collections.Generic.List[string]]::new()
  $fakeBuild = Join-Path $dir ('install\companion-build-' + ('c' * 32))
  $fakeRegistrar = Join-Path $fakeBuild 'CluedCompanionTaskRegistrar.exe'
  # New-Object refuses a COM object, so a missing fake can never reach the Task Scheduler
  function New-Object { param([string]$TypeName, [object[]]$ArgumentList, [string]$ComObject) if ($ComObject) { throw 'UNEXPECTED_COM_OBJECT' }; if ($null -eq $ArgumentList) { Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName } else { Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList } }
  function Get-CompanionHeadlessPreflight { $fakeCalls.Add('preflight'); [ordered]@{ refusals = @() } }
  function New-CompanionBuild([string]$r) {
    $fakeCalls.Add('build'); if ($buildFails) { throw $buildFails }; [void][IO.Directory]::CreateDirectory($fakeBuild)
    [ordered]@{ directory = $fakeBuild; generation = ('b' * 64); registrar = [ordered]@{ exe = $fakeRegistrar; sourceSha256 = ('1' * 64); sha256 = ('2' * 64) } }
  }
  function Register-CompanionFallbackTask { $fakeCalls.Add('fallback-task') }
  function Invoke-CompanionRegistrar([string]$r, [string[]]$a, [string]$exe) { $fakeCalls.Add('registrar:' + $a[0] + ':' + $(if ($exe -ceq $fakeRegistrar) { 'build' } else { $exe })); $registrarOut }
  function Invoke-CompanionFallback([string]$r, [string]$o) { $fakeCalls.Add('fallback'); Remove-Item -LiteralPath (Join-Path $r $CompanionPendingFile) -Force -ErrorAction SilentlyContinue; [ordered]@{ fellBack = $true } }
  function Invoke-CompanionStopAndFallback([string]$r, [string]$o) { $fakeCalls.Add('stop-and-fallback'); Invoke-CompanionFallback $r $o }
  function Stop-CompanionTask { $fakeCalls.Add('stop-task') }
  function Get-CompanionProcessTree { [ordered]@{ supervisors = @(); children = @() } }
  function Wait-CompanionTaskNotRunning { }
  function Start-CompanionTask { $fakeCalls.Add('run-task'); if ($throwAtRun) { throw 'BOOM' } }
  function Wait-CompanionQualified { param([string]$r, [string]$o, $s, [int]$seconds, [string]$registrar) $fakeCalls.Add('qualify:' + $(if ($registrar -ceq $fakeRegistrar) { 'build' } else { $registrar })); if ($qualify -ceq 'THROW') { throw 'QUALIFY_THREW' }; $qualify }
  function Get-CompanionTaskFacts { [ordered]@{ mode = 'password' } }
  function Remove-CompanionFallbackTask { $fakeCalls.Add('remove-fallback-task') }
  $r = $null; $thrown = $null
  try { $r = Invoke-CompanionHeadless $dir ([pscustomobject]@{ ownerSid = 'S-1-5-21-1-2-3-1001' }) 'headless' } catch { $thrown = $_.Exception.Message }
  [ordered]@{ result = $r; thrown = $thrown; calls = (@($fakeCalls) -join ','); markerLeft = (Test-Path -LiteralPath (Join-Path $dir $CompanionPendingFile)); buildLeft = (Test-Path -LiteralPath $fakeBuild) }
}
$regOut = { param([string]$code, [string]$detail) $o = [ordered]@{ contract = 'clued.independent-ci.companion-registrar/1'; code = $code }; if ($detail) { $o.detail = $detail }; $o | ConvertTo-Json -Compress }
$s = & $runSwitch (& $regOut 'REGISTERED' ('e' * 64))
Yes ($s.result.qualified -and $s.result.registrar -ceq 'REGISTERED' -and $s.result.build.registrarSourceSha256 -ceq ('1' * 64) -and $s.result.build.registrarSha256 -ceq ('2' * 64) -and -not $s.buildLeft -and -not $s.markerLeft) ('switch-with-the-build-qualifies:' + $s.calls)
Yes ($s.calls -ceq 'preflight,build,fallback-task,registrar:register-password:build,stop-task,run-task,qualify:build,remove-fallback-task') ('switch-with-the-build-order:' + $s.calls)
foreach ($c in @('CREDENTIAL_NOT_GIVEN', 'ACCOUNT_MISMATCH', 'LOGON_REJECTED', 'PENDING_MARKER_NOT_THIS_SWITCH', 'CREDENTIAL_UNPACK_FAILED')) {
  $s = & $runSwitch (& $regOut $c)
  Yes ($s.result.failed -ceq $c -and $s.result.registrar -ceq $c -and $s.result.fellBack -and -not $s.buildLeft -and -not $s.markerLeft -and $s.calls -ceq 'preflight,build,fallback-task,registrar:register-password:build,fallback') ('switch-registrar-refused-build-deleted:' + $c + ':' + $s.calls)
}
$s = & $runSwitch (& $regOut 'REGISTRAR_UNEXPECTED' 'unpack:EntryPointNotFoundException:0x80131523')
Yes ($s.result.failed -ceq 'REGISTRAR_UNEXPECTED' -and $s.result.registrarDetail -ceq 'unpack:EntryPointNotFoundException:0x80131523' -and -not $s.buildLeft) 'switch-records-where-the-registrar-stopped'
# CREDENTIAL_UNPACK_FAILED: the two unpack error numbers only (review L1), in exactly that shape
foreach ($c in @(@('protected:775:plain:87', 'protected:775:plain:87'), @('protected:122:plain:skipped', 'protected:122:plain:skipped'), @('protected:775:plain:87:size:212', $null), @('protected:775:plain:x', $null))) {
  $s = & $runSwitch (& $regOut 'CREDENTIAL_UNPACK_FAILED' $c[0])
  $kept = if (@($s.result.Keys) -ccontains 'registrarDetail') { $s.result.registrarDetail } else { $null }
  Yes ($s.result.failed -ceq 'CREDENTIAL_UNPACK_FAILED' -and $kept -ceq $c[1] -and -not $s.buildLeft) ('switch-records-unpack-errors-only:' + $c[0] + ':' + $kept)
}
$s = & $runSwitch (& $regOut 'ACCOUNT_MISMATCH' 'protected:775:plain:87')
Yes (-not (@($s.result.Keys) -ccontains 'registrarDetail')) 'switch-keeps-a-detail-only-for-its-code'
foreach ($o in @('', 'not json', '{"code":"my secret text"}', (& $regOut 'REGISTRAR_UNEXPECTED' 'free text here'))) {
  $s = & $runSwitch $o
  Yes ($s.result.fellBack -and -not $s.buildLeft -and -not (($s.result | ConvertTo-Json -Depth 6 -Compress) -match 'secret|free text') -and ($s.result.registrar -ceq 'REGISTRAR_OUTPUT_UNREADABLE' -or ($s.result.registrar -ceq 'REGISTRAR_UNEXPECTED' -and -not (@($s.result.Keys) -ccontains 'registrarDetail')))) ('switch-records-codes-only:' + $s.result.registrar)
}
$s = & $runSwitch (& $regOut 'REGISTERED' ('e' * 64)) $null 'heartbeat'
Yes ($s.result.failed -ceq 'COMPANION_HEADLESS_QUALIFICATION_FAILED:heartbeat' -and $s.result.fellBack -and -not $s.buildLeft -and -not $s.markerLeft) ('switch-not-qualified-build-deleted:' + $s.calls)
$s = & $runSwitch (& $regOut 'REGISTERED' ('e' * 64)) $null $null $true
Yes ($s.result.runError -ceq 'COMPANION_TASK_RUN_FAILED' -and -not $s.buildLeft) 'switch-run-error-build-deleted'
$s = & $runSwitch (& $regOut 'REGISTERED' ('e' * 64)) $null 'THROW'
Yes ($s.thrown -ceq 'QUALIFY_THREW' -and -not $s.buildLeft) ('switch-exception-build-deleted:' + $s.thrown)
foreach ($c in @(@('COMPANION_BUILD_SOURCE_NOT_THE_GENERATION', 'COMPANION_BUILD_FAILED:COMPANION_BUILD_SOURCE_NOT_THE_GENERATION'), @('Access to the path C:\x is denied.', 'COMPANION_BUILD_FAILED:UNEXPECTED'))) {
  $s = & $runSwitch (& $regOut 'REGISTERED' ('e' * 64)) $c[0]
  Yes ($s.result.failed -ceq $c[1] -and -not $s.result.fellBack -and $s.calls -ceq 'preflight,build' -and -not $s.markerLeft -and -not $s.buildLeft) ('switch-build-failed-changes-nothing:' + $s.result.failed + ':' + $s.calls)
}

$rearm = $texts['rearm-resident.ps1']
Yes ($rearm.Contains("throw 'OWNER_ACCOUNT_REQUIRED'") -and $rearm.Contains("[switch]`$CompanionHeadless, [switch]`$CompanionCredential, [switch]`$CompanionInteractive") -and $rearm.Contains("if (-not `$elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }")) 'rearm-owner-elevated-only'

# 5. The password never in PowerShell (ADR 0022 section 4.4, T8).
foreach ($file in @('companion-headless.ps1', 'rearm-resident.ps1', 'install-resident.ps1', 'upgrade-apply.ps1', 'verify-resident.ps1', 'uninstall-resident.ps1', 'probe-companion-headless.ps1', 'companion-headless-fallback.ps1', 'prepare-companion-account.ps1', 'request-upgrade.ps1')) {
  $code = & $codeOf $texts[$file]
  foreach ($bad in @('Get-Credential', 'Read-Host', 'SecureString', 'PSCredential', '-Password', 'NetworkCredential', 'Register-ScheduledTask')) { Yes (-not $code.Contains($bad)) ('no-password-in-powershell:' + $file + ':' + $bad) }
}
Yes ($sw.Contains("Invoke-CompanionRegistrar `$root @('register-password', `$root)") -and $sw.Contains('ConvertFrom-Json).code')) 'switch-takes-only-the-registrar-code'
$reg = [IO.File]::ReadAllText((Join-Path $here 'CompanionTaskRegistrar.cs'))
Yes ($reg.Contains('CREDUIWIN_IN_CRED_ONLY | CREDUIWIN_SECURE_PROMPT') -and $reg.Contains('CREDUIWIN_SECURE_PROMPT = 0x1000') -and -not $reg.Contains('CredUIPromptForCredentials')) 'registrar-secure-desktop-only'
Yes (-not ([regex]::IsMatch($reg, 'PtrToString\w*\(\s*pw\b')) -and -not ([regex]::IsMatch($reg, 'PtrToString\w*\(\s*bstr\b')) -and -not $reg.Contains('SecureString')) 'registrar-no-managed-copy-of-the-password'
Yes ($reg.Contains('ZeroMemory(bstr, new UIntPtr(chars * 2)); SysFreeString(bstr)') -and $reg.Contains('ZeroMemory(outBuf, new UIntPtr(outSize))') -and $reg.Contains('ZeroMemory(pw, new UIntPtr(PwChars * 2)); Marshal.FreeHGlobal(pw)')) 'registrar-zeroes-every-buffer'
Yes (-not ([regex]::IsMatch($reg, 'Console\.\w+\([^)]*\b(pw|bstr|user|domain)\b'))) 'registrar-prints-no-credential'

# 6. C#: compiled with install's own function into the scratch bin\, then the pure tests.
$bin = Join-Path $Scratch 'bin'; [void][IO.Directory]::CreateDirectory($bin)
foreach ($name in @('install-resident.ps1:Invoke-CompanionSupervisorCompile', 'install-resident.ps1:Sha256File', 'install-resident.ps1:Sha256Bytes')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'; $csc = Join-Path $fw 'csc.exe'
$hashes = Invoke-CompanionSupervisorCompile $csc $fw $bin (Join-Path $here 'CompanionSupervisor.cs') (Join-Path $here 'CompanionTaskRegistrar.cs')
Yes ($hashes.companionSupervisorSha256 -cmatch '^[0-9a-f]{64}$' -and $hashes.companionRegistrarSha256 -cmatch '^[0-9a-f]{64}$') 'compile-with-install-recipe'
$refs = @("/reference:$($fw)System.dll", "/reference:$($fw)System.Core.dll", "/reference:$($fw)System.Web.Extensions.dll")
& $csc /nologo /noconfig /target:exe /main:SupervisorPureTests $refs ('/out:' + (Join-Path $Scratch 'supervisor-pure.exe')) (Join-Path $here 'CompanionSupervisor.cs') (Join-Path $here 'SupervisorPureTests.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-supervisor-pure'
$out = & (Join-Path $Scratch 'supervisor-pure.exe') | Out-String
Yes ($LASTEXITCODE -eq 0 -and $out -match 'SUPERVISOR_PURE_PASS') ('supervisor-pure:' + $out.Trim())
$supervisorCsharp = [int](($out | ConvertFrom-Json).assertions)
& $csc /nologo /noconfig /target:exe /main:RegistrarPureTests $refs "/reference:$($fw)System.Xml.dll" ('/out:' + (Join-Path $Scratch 'registrar-pure.exe')) (Join-Path $here 'CompanionTaskRegistrar.cs') (Join-Path $here 'RegistrarPureTests.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile-registrar-pure'
$out = & (Join-Path $Scratch 'registrar-pure.exe') (Join-Path $bin 'CluedCompanionTaskRegistrar.exe') | Out-String
Yes ($LASTEXITCODE -eq 0 -and $out -match 'REGISTRAR_PURE_PASS') ('registrar-pure:' + $out.Trim())
$registrarCsharp = [int](($out | ConvertFrom-Json).assertions)
# 2026-11-08 (30th DESK): every P/Invoke of every program install compiles binds on this machine. The registrar imported
# CredUnpackAuthenticationBufferW, which credui.dll does not export (it is CredUnPackAuthenticationBufferW): every password typed ended in
# REGISTRAR_UNEXPECTED. Each program is compiled with install's own recipe and each [DllImport] method is bound by the CLR itself
# (Marshal.Prelink: the DLL is loaded and the entry point found, with the CLR's own W-suffix probing; nothing is called). The count of
# bound methods must equal the count of [DllImport] attributes in the program's sources, so no import is skipped.
foreach ($name in @('install-resident.ps1:Invoke-CompileRecipe', 'install-resident.ps1:Invoke-UpgraderHostCompile')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
foreach ($v in @('GenericHelper', 'CompanionJobHost')) { Yes ($texts['install-resident.ps1'] -match ('(?m)^\$' + $v + " = '([A-Za-z0-9.-]+)'")) ('install-name:' + $v); Set-Variable -Name $v -Value $Matches[1] }
$v2 = [IO.Path]::GetFullPath((Join-Path $here '..\..\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'))
$pbin = Join-Path $Scratch 'pinvoke-bin'; $phelpers = Join-Path $Scratch 'pinvoke-helpers'
foreach ($d in @($pbin, $phelpers)) { [void][IO.Directory]::CreateDirectory($d) }
$null = Invoke-CompileRecipe $csc $fw $pbin $phelpers (Join-Path $here 'ResidentServiceHost.cs') (Join-Path $here 'SwapBroker.cs') $v2 (Join-Path $here 'CompanionJobHost.cs')
$null = Invoke-UpgraderHostCompile $csc $fw $pbin (Join-Path $here 'UpgraderServiceHost.cs')
$programs = @(
  @((Join-Path $bin 'CluedCompanionTaskRegistrar.exe'), @((Join-Path $here 'CompanionTaskRegistrar.cs'))),
  @((Join-Path $bin 'CluedCompanionSupervisor.exe'), @((Join-Path $here 'CompanionSupervisor.cs'))),
  @((Join-Path $pbin $CompanionJobHost), @((Join-Path $here 'CompanionJobHost.cs'))),
  @((Join-Path $pbin 'ResidentServiceHost.exe'), @((Join-Path $here 'ResidentServiceHost.cs'))),
  @((Join-Path $pbin 'SwapBroker.exe'), @((Join-Path $here 'SwapBroker.cs'), (Join-Path $v2 'ResidentScmV2.cs'), (Join-Path $v2 'ScmPidHandshakeV2.cs'), (Join-Path $v2 'NodeProfileV2.cs'))),
  @((Join-Path $phelpers $GenericHelper), @((Join-Path $v2 'FormalPublicBoundaryV2.cs'), (Join-Path $v2 'FormalSession0V2.cs'), (Join-Path $v2 'ScmPidHandshakeV2.cs'), (Join-Path $v2 'NodeProfileV2.cs'))),
  @((Join-Path $pbin 'UpgraderServiceHost.exe'), @((Join-Path $here 'UpgraderServiceHost.cs'))))
$pinvokeBound = 0
foreach ($pr in $programs) {
  $exeName = Split-Path -Leaf $pr[0]
  Yes (Test-Path -LiteralPath $pr[0] -PathType Leaf) ('pinvoke-compiled:' + $exeName)
  $declared = 0; foreach ($cs in $pr[1]) { $declared += ([regex]::Matches([IO.File]::ReadAllText($cs), '\[(System\.Runtime\.InteropServices\.)?DllImport\(')).Count }
  $asm = [Reflection.Assembly]::LoadFile($pr[0])
  $bound = 0; $unbound = @()
  foreach ($t in $asm.GetTypes()) {
    foreach ($m in $t.GetMethods([Reflection.BindingFlags]'Public,NonPublic,Static,Instance,DeclaredOnly')) {
      if (($m.Attributes -band [Reflection.MethodAttributes]::PinvokeImpl) -eq 0) { continue }
      $bound++
      try { [Runtime.InteropServices.Marshal]::Prelink($m) } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; $unbound += ($t.Name + '.' + $m.Name + ':' + $e.GetType().Name) }
    }
  }
  Yes ($bound -gt 0 -and $bound -eq $declared) ('pinvoke-all-found:' + $exeName + ':' + $bound + '/' + $declared)
  Yes ($unbound.Count -eq 0) ('pinvoke-entry-points-resolve:' + $exeName + ':' + ($unbound -join ','))
  $pinvokeBound += $bound
}
# the launch file PowerShell writes is the one the supervisor accepts; one changed byte of shape is refused
$lf = Join-Path $Scratch 'launch.json'
[IO.File]::WriteAllText($lf, $json, (New-Object Text.UTF8Encoding($false)))
$v = (& (Join-Path $Scratch 'supervisor-pure.exe') --parse $lf 'C:\ProgramData\CluedIndependentCI\resident' $profileDir | Out-String).Trim()
Yes ($v -ceq 'LAUNCH_ACCEPTED') ('launch-accepted-by-the-supervisor:' + $v)
[IO.File]::WriteAllText($lf, $json.Replace('companion-gh\\gh', 'gh'), (New-Object Text.UTF8Encoding($false)))
$v = (& (Join-Path $Scratch 'supervisor-pure.exe') --parse $lf 'C:\ProgramData\CluedIndependentCI\resident' $profileDir | Out-String).Trim()
Yes ($v -ceq 'LAUNCH_FILE_GH_CONFIG') ('launch-other-gh-config-refused:' + $v)

# 7. The companion's git configuration: the same text in PowerShell (companion-gh-login.ps1) and node (companion-session.mjs).
. ([scriptblock]::Create($functions['companion-gh-login.ps1:Get-CompanionGitConfig']))
$nodeText = 'skipped-no-node'
if (Get-Command $NodeExe -ErrorAction SilentlyContinue) {
  $url = ([Uri][IO.Path]::GetFullPath((Join-Path $here '..\src\companion-session.mjs'))).AbsoluteUri
  # no double quote in the script: Windows PowerShell 5.1 drops them from a native argument
  $js = & $NodeExe --input-type=module -e 'const m = await import(process.argv[1]); process.stdout.write(Buffer.from(m.companionGitConfig(process.argv[2], process.argv[3])).toString(`base64`));' $url $profileDir 'C:\Program Files\GitHub CLI\gh.exe'
  Yes ($LASTEXITCODE -eq 0 -and [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($js)) -ceq (Get-CompanionGitConfig $profileDir 'C:\Program Files\GitHub CLI\gh.exe')) 'gitconfig-same-in-node-and-powershell'
  $nodeText = 'checked'
}
$login = & $codeOf $texts['companion-gh-login.ps1']
Yes ($login.Contains("throw 'RUN_NOT_ELEVATED_IN_YOUR_OWN_WINDOW'") -and $login.Contains("throw 'CLIPBOARD_IS_NOT_A_CLASSIC_TOKEN'") -and -not $login.Contains('auth login') -and -not $login.Contains('auth token')) 'gh-login-owner-only-no-shared-keyring'
Yes ($login.Contains('[Windows.Forms.Clipboard]::Clear()') -and $login.Contains('ClearHistory()') -and $login.Contains('$token = $null')) 'gh-login-clears-the-clipboard-and-its-history'
# review MINOR 13: the token is never an argument of a PowerShell function or cmdlet (only of .NET methods)
Yes (-not ([regex]::IsMatch($login, '(?m)^\s*[A-Z][A-Za-z]+-[A-Za-z]+\b[^\r\n]*\$token\b')) -and -not $login.Contains('Test-FineGrainedToken')) 'gh-login-token-only-in-dotnet-calls'

# 8. The probe writes nothing (read-only by construction).
$probe = & $codeOf $texts['probe-companion-headless.ps1']
foreach ($bad in @('Set-Content', 'Set-Acl', 'Set-Item', 'Set-Service', 'Set-ScheduledTask', 'Set-Clipboard', 'New-Item', 'Remove-', 'Register-', 'Unregister-', 'Stop-', 'Start-Process', 'Out-File', 'Add-Content', 'WriteAll', '::Move', '::Replace(', 'schtasks', 'Restart-', 'icacls', 'reg.exe', '.Run(')) { Yes (-not $probe.Contains($bad)) ('probe-read-only:' + $bad) }

# 9. M5-b (ADR 0023): the companion as its own non-administrator account. Pure functions and the order of the account switch; nothing on
# the host is read or changed (the prepare script runs only in -Plan mode, read-only and not elevated).
$acct = 'S-1-5-21-858977881-4031698862-3006450925-1010'; $opr = 'S-1-5-21-858977881-4031698862-3006450925-1000'; $ctl = 'S-1-5-21-858977881-4031698862-3006450925-1007'
$nodeB = [pscustomobject]@{ ownerSid = $acct; ownerProfileDirectory = (Join-Path $Scratch 'companion-profile'); wslDistribution = 'CluedResident-Linux' }
# the record: exactly three keys, the account is the profile's ownerSid, the operator another user SID
$rec = { param($c, $a, $o) [pscustomobject]([ordered]@{ contract = $c; companionSid = $a; operatorSid = $o }) }
Yes (Test-CompanionAccountRecord (& $rec 'clued.independent-ci.companion-account/1' $acct $opr) $nodeB) 'account-record-accepted'
Yes (-not (Test-CompanionAccountRecord (& $rec 'clued.independent-ci.companion-account/1' $opr $opr) $nodeB)) 'account-record-not-the-profile-owner-refused'
Yes (-not (Test-CompanionAccountRecord (& $rec 'clued.independent-ci.companion-account/1' $acct $acct) $nodeB)) 'account-record-operator-equals-account-refused'
Yes (-not (Test-CompanionAccountRecord (& $rec 'clued.independent-ci.companion-account/2' $acct $opr) $nodeB)) 'account-record-contract-refused'
Yes (-not (Test-CompanionAccountRecord (& $rec 'clued.independent-ci.companion-account/1' $acct 'S-1-5-18') $nodeB)) 'account-record-operator-shape-refused'
$extra = & $rec 'clued.independent-ci.companion-account/1' $acct $opr; $extra | Add-Member -NotePropertyName more -NotePropertyValue 1
Yes (-not (Test-CompanionAccountRecord $extra $nodeB)) 'account-record-extra-key-refused'
# operator: from the record on an M5-b node, the profile's ownerSid elsewhere (Get-CompanionOperatorSid reads install\companion-account.json)
$rootB = Join-Path $Scratch 'root-m5b'; [void][IO.Directory]::CreateDirectory((Join-Path $rootB 'install'))
Yes ((Get-CompanionOperatorSid $rootB $nodeB) -ceq $acct) 'operator-is-owner-without-a-record'
[IO.File]::WriteAllText((Join-Path $rootB 'install\companion-account.json'), ((& $rec 'clued.independent-ci.companion-account/1' $acct $opr) | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
Yes ((Get-CompanionOperatorSid $rootB $nodeB) -ceq $opr) 'operator-from-the-record'
[IO.File]::WriteAllText((Join-Path $rootB 'install\companion-account.json'), ((& $rec 'clued.independent-ci.companion-account/1' $opr $ctl) | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
$threw = try { $null = Get-CompanionOperatorSid $rootB $nodeB; $false } catch { $_.Exception.Message -ceq 'COMPANION_ACCOUNT_RECORD_REFUSED' }
Yes $threw 'operator-record-that-does-not-fit-throws'
# the WSL move plan
$regD = [ordered]@{ guid = '{x}'; name = 'CluedResident-Linux'; basePath = 'C:\Users\Windows\WSL\CluedResident-Linux' }
$p = Get-CompanionWslMovePlan $regD $true 'D:\clued-resident\wsl\CluedResident-Linux' $false
Yes ($p.action -ceq 'move' -and -not $p.sameVolume) 'wsl-plan-desk-copy-to-d'
$regT = [ordered]@{ guid = '{y}'; name = 'Ubuntu-24.04'; basePath = 'C:\Users\17531\AppData\Local\wsl\{7483e0fe-20a8-4d63-8ff8-8572cdf2e45c}' }
$p = Get-CompanionWslMovePlan $regT $true 'C:\clued-resident\wsl\Ubuntu-24.04' $false
Yes ($p.action -ceq 'move' -and $p.sameVolume) 'wsl-plan-turing-rename-on-c'
Yes ((Get-CompanionWslMovePlan $regD $false 'D:\clued-resident\wsl\CluedResident-Linux' $true).action -ceq 'forget') 'wsl-plan-file-moved-registration-left-forget'
Yes ((Get-CompanionWslMovePlan $null $false 'D:\clued-resident\wsl\CluedResident-Linux' $true).action -ceq 'done') 'wsl-plan-done-earlier'
Yes ((Get-CompanionWslMovePlan $regD $true 'D:\clued-resident\wsl\CluedResident-Linux' $true).code -ceq 'WSL_TARGET_EXISTS') 'wsl-plan-both-present-refused'
Yes ((Get-CompanionWslMovePlan $null $false 'D:\clued-resident\wsl\CluedResident-Linux' $false).code -ceq 'WSL_DISTRIBUTION_NOT_FOUND') 'wsl-plan-nothing-anywhere-refused'
Yes ((Get-CompanionWslMovePlan $regD $false 'D:\clued-resident\wsl\CluedResident-Linux' $false).code -ceq 'WSL_SOURCE_MISSING') 'wsl-plan-no-file-refused'
Yes ((Get-CompanionWslMovePlan $regD $true 'D:\clued resident\x' $false).code -ceq 'WSL_TARGET_REFUSED' -and (Get-CompanionWslMovePlan $regD $true 'D:\a\..\b' $false).code -ceq 'WSL_TARGET_REFUSED' -and (Get-CompanionWslMovePlan $regD $true '\\server\share' $false).code -ceq 'WSL_TARGET_REFUSED') 'wsl-plan-target-shape-refused'
$regAt = [ordered]@{ guid = '{z}'; name = 'CluedResident-Linux'; basePath = 'D:\clued-resident\wsl\CluedResident-Linux' }
Yes ((Get-CompanionWslMovePlan $regAt $true 'D:\clued-resident\wsl\CluedResident-Linux' $true).action -ceq 'forget') 'wsl-plan-already-there-only-forget'
Yes ((Get-CompanionVhdxSddl $acct) -ceq ('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $acct + ')')) 'vhdx-sddl-admins-and-the-account-only'
Yes ($CompanionVhdxParentSddl -ceq 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)' -and $functions['companion-headless.ps1:Invoke-CompanionWslMove'].Contains('SetSecurityDescriptorSddlForm($CompanionVhdxParentSddl)')) 'vhdx-missing-parents-created-protected'
# the verified copy (a real small file in the scratch directory): both hashes, then the move deletes the source only after they match
$src = Join-Path $Scratch 'vhdx-src.bin'; $dst = Join-Path $Scratch 'vhdx-dst.bin'
$bytes = New-Object byte[] 9437185; (New-Object Random 7).NextBytes($bytes); [IO.File]::WriteAllBytes($src, $bytes)
$c = Copy-CompanionFileVerified $src $dst
Yes ($c.sourceSha256 -ceq $c.targetSha256 -and $c.length -eq 9437185 -and $c.sourceSha256 -ceq (Get-CompanionFileSha256 $src)) 'wsl-copy-hashed-on-both-sides'
$mv = $functions['companion-headless.ps1:Invoke-CompanionWslMove']
Yes ($mv.IndexOf('WSL_COPY_HASH_MISMATCH') -lt $mv.IndexOf('Remove-Item -LiteralPath $source') -and $mv.IndexOf("--terminate") -lt $mv.IndexOf('Copy-CompanionFileVerified') -and $mv.IndexOf('Wait-CompanionVhdxFree') -lt $mv.IndexOf('Copy-CompanionFileVerified')) 'wsl-move-terminate-free-copy-verify-then-delete'
Yes ($mv.Contains("Remove-Item -LiteralPath (Join-Path `$lxss ([string]`$r.guid))") -and $mv.IndexOf('ownerDefaultWas') -lt $mv.IndexOf('Remove-Item -LiteralPath (Join-Path $lxss')) 'wsl-move-forgets-the-owner-registration-after-recording-it'
foreach ($file in @('companion-headless.ps1', 'rearm-resident.ps1', 'install-resident.ps1', 'verify-resident.ps1', 'prepare-companion-account.ps1')) {
  Yes (-not ((& $codeOf $texts[$file]) -match '--unregister|--shutdown|wsl(\.exe)?''?\s+--export|--import(?!-in-place)')) ('never-unregister-shutdown-export-import:' + $file)
}
# the account switch: preflight before the fall-back task, the marker before the move, the move before the registrar, the registrar
# before the import task, qualified before the WSL record and before the marker goes; no password argument anywhere
$as = $functions['companion-headless.ps1:Invoke-CompanionAccountSwitch']
$i = [ordered]@{ pre = $as.IndexOf('Get-CompanionAccountPreflight'); fb = $as.IndexOf('Register-CompanionFallbackTask'); mark = $as.IndexOf('Write-CompanionPending'); stop = $as.IndexOf('Stop-CompanionTask')
  move = $as.IndexOf('Invoke-CompanionWslMove'); reg = $as.IndexOf('Invoke-CompanionRegistrar'); imp = $as.IndexOf('Invoke-CompanionWslImportTask'); run = $as.IndexOf('Start-CompanionTask')
  qual = $as.IndexOf('Wait-CompanionQualified'); rec = $as.IndexOf('Write-CompanionWslRecord'); done = $as.IndexOf('$result.qualified = $true') }
Yes (@($i.Values | Where-Object { $_ -lt 0 }).Count -eq 0 -and $i.pre -lt $i.fb -and $i.fb -lt $i.mark -and $i.mark -lt $i.stop -and $i.stop -lt $i.move -and $i.move -lt $i.reg -and $i.reg -lt $i.imp -and $i.imp -lt $i.run -and $i.run -lt $i.qual -and $i.qual -lt $i.rec -and $i.rec -lt $i.done) 'account-switch-order'
Yes ($as.Contains("@('register-account', `$root, `$distro, `$vhdx)") -and $as.Contains("@('register-account', `$root)") -and $as.Contains('New-CompanionBuild $root') -and $as.Contains('Remove-CompanionBuild $build.directory')) 'account-switch-own-build-register-account-only'
Yes ($as.IndexOf('Invoke-CompanionFallback $root $sid', $i.move) -gt $i.move -and $as.Contains('COMPANION_HEADLESS_QUALIFICATION_FAILED') -and $as.Contains('Invoke-CompanionStopAndFallback $root $sid')) 'account-switch-falls-back'
Yes ($functions['companion-headless.ps1:Invoke-CompanionRootShell'].Contains("@('root-shell', `$root)")) 'root-shell-through-the-registrar'
# the preflight over fake facts (pure; the profile directory is a scratch folder)
$okFacts = [pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; refusal = $null; rights = @('SeBatchLogonRight', 'SeDenyNetworkLogonRight'); profileDirectory = $nodeB.ownerProfileDirectory }
$ghB = Get-CompanionGhDirs $nodeB.ownerProfileDirectory
$pf = Get-CompanionAccountPreflight $rootB $nodeB $okFacts 'D:\clued-resident\wsl\CluedResident-Linux'
Yes (@($pf.refusals) -ccontains 'COMPANION_GH_CONFIG_MISSING' -and @($pf.refusals) -ccontains 'COMPANION_HEADLESS_NOT_INSTALLED:bin\CluedCompanionSupervisor.exe') 'account-preflight-needs-gh-config-and-install'
foreach ($d in @($ghB.gh, $ghB.home, (Join-Path $rootB 'bin'), (Join-Path $rootB 'config'))) { [void][IO.Directory]::CreateDirectory($d) }
foreach ($f in @((Join-Path $ghB.gh 'hosts.yml'), (Join-Path $ghB.home '.gitconfig'), (Join-Path $rootB 'bin\CluedCompanionSupervisor.exe'), (Join-Path $rootB 'config\companion-launch.json'))) { [IO.File]::WriteAllText($f, 'x') }
$pf = Get-CompanionAccountPreflight $rootB $nodeB $okFacts 'D:\clued-resident\wsl\CluedResident-Linux'
Yes (@($pf.refusals | Where-Object { $_ -notlike 'COMPANION_HEADLESS_INJECTION_VARIABLES:*' }).Count -eq 0) ('account-preflight-passes:' + (@($pf.refusals) -join ','))
$bad = [pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; refusal = 'COMPANION_ACCOUNT_IS_ADMINISTRATOR'; rights = @('SeDenyBatchLogonRight'); profileDirectory = 'C:\Users\other' }
$pf = Get-CompanionAccountPreflight $rootB $nodeB $bad 'D:\x y'
foreach ($code in @('COMPANION_ACCOUNT_IS_ADMINISTRATOR', 'COMPANION_ACCOUNT_BATCH_LOGON_RIGHT_MISSING', 'COMPANION_ACCOUNT_BATCH_LOGON_DENIED', 'COMPANION_ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE', 'WSL_TARGET_REFUSED')) { Yes (@($pf.refusals) -ccontains $code) ('account-preflight-refuses:' + $code) }
Yes (@((Get-CompanionAccountPreflight $rootB $nodeB $null 'D:\a').refusals) -ccontains 'COMPANION_ACCOUNT_MISSING') 'account-preflight-no-facts-refused'
# verify's account check (pure)
$recB = & $rec 'clued.independent-ci.companion-account/1' $acct $opr
$user = [pscustomobject]@{ Enabled = $true }
$incomingAfter = "O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$acct)(A;OICI;0x1200a9;;;$ctl)"
$incomingBefore = "O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$opr)(A;OICI;0x1200a9;;;$ctl)"
Yes ($null -eq (Get-CompanionAccountProblem $nodeB $recB $user @($opr) $nodeB.ownerProfileDirectory $incomingAfter)) 'verify-account-ok'
Yes ((Get-CompanionAccountProblem $nodeB $recB $user @($opr) $nodeB.ownerProfileDirectory $incomingBefore) -ceq 'SPOOL_INCOMING_WRITABLE_BY_THE_OWNER') 'verify-owner-write-on-incoming-refused'
Yes ((Get-CompanionAccountProblem $nodeB $recB $user @($opr, $acct) $nodeB.ownerProfileDirectory $incomingAfter) -ceq 'ACCOUNT_IS_ADMINISTRATOR') 'verify-account-administrator-refused'
Yes ((Get-CompanionAccountProblem $nodeB $recB ([pscustomobject]@{ Enabled = $false }) @() $nodeB.ownerProfileDirectory $incomingAfter) -ceq 'ACCOUNT_DISABLED' -and (Get-CompanionAccountProblem $nodeB $recB $null @() '' '') -ceq 'ACCOUNT_MISSING') 'verify-account-disabled-or-missing'
Yes ((Get-CompanionAccountProblem $nodeB $recB $user @() 'C:\Users\other' $incomingAfter) -ceq 'ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE') 'verify-account-profile'
Yes ($texts['verify-resident.ps1'].Contains("Record 'companion-account'") -and $texts['verify-resident.ps1'].IndexOf('Read-CompanionAccountRecord') -gt $texts['verify-resident.ps1'].IndexOf(". (Join-Path `$PSScriptRoot 'companion-headless.ps1')")) 'verify-checks-the-account-after-loading-the-functions'
# install: the ACL plan without a companion account is the one before M5-b; with one the Owner reads and drops requests, the account writes
foreach ($name in @('install-resident.ps1:Get-AclPlan', 'install-resident.ps1:Get-CompanionSpoolSddl')) { Yes ($functions.ContainsKey($name)) ('present:' + $name); . ([scriptblock]::Create($functions[$name])) }
$res = 'S-1-5-80-1-2-3-4-5'
$OwnerSid = $opr; $OperatorSid = $opr; $ControllerSid = $ctl; $AccountNode = $false
$plain = Get-AclPlan $res
Yes (@($plain.Values | Where-Object { $_.Contains('$') }).Count -eq 0 -and $plain['bundles'] -ceq "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;$res)(A;OICI;0x1301bf;;;$opr)" -and $plain['upgrade\inbox'] -ceq "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1000a2;;;$opr)(A;OIIO;0x120089;;;$opr)(A;OIIO;0x120089;;;OW)") 'acl-plan-without-account-unchanged'
$OwnerSid = $acct; $OperatorSid = $opr; $AccountNode = $true
$m5b = Get-AclPlan $res
Yes ($m5b['bundles'].Contains("(A;OICI;0x1301bf;;;$acct)") -and $m5b['bundles'].Contains("(A;OICI;0x1200a9;;;$opr)") -and -not $m5b['bundles'].Contains("0x1301bf;;;$opr")) 'acl-plan-bundles-account-writes-owner-reads'
foreach ($k in @('mailbox\responses', 'upgrade\mailbox\responses')) { Yes ($m5b[$k].Contains("(A;OICI;0x1301bf;;;$acct)") -and -not $m5b[$k].Contains("0x1301bf;;;$opr") -and $m5b[$k].Contains("(A;OICI;0x1200a9;;;$opr)")) ('acl-plan-responses-account-only:' + $k) }
foreach ($k in @('inbox', 'requests')) { Yes ($m5b[$k].Contains("(A;;0x1000a2;;;$acct)") -and $m5b[$k].Contains("(A;;0x1000a2;;;$opr)")) ('acl-plan-both-drop:' + $k) }
Yes ($m5b['upgrade\inbox'].Contains("(A;;0x1000a2;;;$opr)") -and -not $m5b['upgrade\inbox'].Contains($acct)) 'acl-plan-upgrade-inbox-owner-only'
Yes ($m5b['owner\train-review'].Contains("(A;OICI;0x1301bf;;;$opr)") -and -not $m5b['owner\train-review'].Contains($acct)) 'acl-plan-train-review-owner-only'
foreach ($k in @('secrets', 'upgrader', 'broker', 'broker\requests', 'broker\responses', 'helpers', 'stage')) { Yes (-not $m5b[$k].Contains($opr)) ('acl-plan-owner-not-in:' + $k) }
foreach ($k in @('', 'bin', 'config', 'install', 'resident', 'runtime', 'state', 'upgrade', 'record', 'source', 'mailbox')) { Yes ($m5b[$k].Contains("(A;OICI;0x1200a9;;;$opr)") -and $m5b[$k].Contains($acct)) ('acl-plan-both-read:' + $k) }
# install: the formal spool follows the account (Source v2 accepts only the node profile's ownerSid as a writer of incoming)
$after = Get-CompanionSpoolSddl $incomingBefore $opr $acct
$raw = New-Object Security.AccessControl.RawSecurityDescriptor($after)
$aces = @($raw.DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value + '|' + $_.AccessMask + '|' + [int]$_.AceFlags })
Yes ($aces -ccontains ($acct + '|' + 0x1301bf + '|3') -and -not ($aces | Where-Object { $_ -like ($opr + '|*') }) -and $aces -ccontains ($ctl + '|' + 0x1200a9 + '|3')) ('spool-incoming-write-moves-to-the-account:' + $after)
Yes ((Get-CompanionSpoolSddl $after $opr $acct) -ceq $after) 'spool-acl-idempotent'
$outBefore = "O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;$opr)(A;OICI;0x1301bf;;;$ctl)"
$outAfter = Get-CompanionSpoolSddl $outBefore $opr $acct
$aces = @((New-Object Security.AccessControl.RawSecurityDescriptor($outAfter)).DiscretionaryAcl | ForEach-Object { $_.SecurityIdentifier.Value + '|' + $_.AccessMask })
Yes ($aces -ccontains ($opr + '|' + 0x1200a9) -and $aces -ccontains ($acct + '|' + 0x1200a9) -and $aces -ccontains ($ctl + '|' + 0x1301bf)) 'spool-outgoing-read-kept-and-copied'
$inst = & $codeOf $texts['install-resident.ps1']
Yes ($inst.Contains("if (`$id.User.Value -cne `$operator) { throw 'OWNER_ACCOUNT_REQUIRED' }") -and $functions['install-resident.ps1:Assert-Owner'].Contains('$operator = if ((Test-Path variable:OperatorSid) -and $OperatorSid) { $OperatorSid } else { $OwnerSid }') -and $inst.Contains("throw 'COMPANION_ACCOUNT_IS_ADMINISTRATOR'") -and $inst.Contains("if (-not `$OperatorSid) { `$OperatorSid = `$OwnerSid }")) 'install-operator-and-account-checks'
Yes ($inst.Contains("Invoke-AsSystemOnce (Join-Path `$Root 'bin\SwapBroker.exe') @('--stable-digest'") -and $functions['install-resident.ps1:Invoke-AsSystemOnce'].Contains("UserId = 'S-1-5-18'") -and $functions['install-resident.ps1:Invoke-AsSystemOnce'].Contains("DeleteTask(`$name, 0)")) 'install-stable-digest-as-localsystem-on-an-account-node'
Yes ($inst.IndexOf("Step 'companion-account'") -gt $inst.IndexOf("Step 'source-v2-acl'") -and $inst.IndexOf("Step 'companion-account'") -lt $inst.IndexOf("Step 'companion-launch'")) 'install-account-step-after-source-acl-before-the-companion'
# rearm, request-upgrade, gh login, the launcher
$rm = & $codeOf $texts['rearm-resident.ps1']
Yes ($rm.Contains("if (`$me.User.Value -cne (Get-CompanionOperatorSid `$Root `$node)) { throw 'OWNER_ACCOUNT_REQUIRED' }") -and $rm.Contains("throw 'COMPANION_ACCOUNT_NODE_USE_COMPANION_ACCOUNT'") -and $rm.Contains("Invoke-CompanionAccountSwitch `$Root `$node `$WslVhdxDirectory")) 'rearm-operator-and-account-modes'
Yes ($texts['request-upgrade.ps1'].Contains("-cne (Get-OperatorSid `$node)) { throw 'OWNER_ACCOUNT_REQUIRED' }") -and $texts['request-upgrade.ps1'].Contains("'clued.independent-ci.companion-account/1'")) 'request-upgrade-operator'
$gl = & $codeOf $texts['companion-gh-login.ps1']
Yes ($gl.Contains("throw 'RUN_ELEVATED_FOR_THE_COMPANION_ACCOUNT'") -and $gl.Contains("throw 'PROFILE_DIRECTORY_NOT_THE_ACCOUNTS'") -and $gl.Contains('$ownerSid = $AccountSid') -and $gl.Contains("throw 'RUN_NOT_ELEVATED_IN_YOUR_OWN_WINDOW'")) 'gh-login-for-the-account-elevated-only'
$tpl = [IO.File]::ReadAllText((Join-Path $here '..\reinstall\launcher\template.ps1'))
Yes ($tpl.Contains("if (`$id.User.Value -cne `$OperatorSid) { throw 'OWNER_ACCOUNT_REQUIRED' }") -and $tpl.Contains("@('-CompanionAccount', '-WslVhdxDirectory', `$CompanionWslVhdxDirectory)") -and $tpl.Contains("'-OperatorSid', `$OperatorSid)")) 'launcher-operator-and-account-step'
# the prepare script: elevated runs only; -Plan is read-only and runs here (not elevated); it never handles a password or the token
$pr = & $codeOf $texts['prepare-companion-account.ps1']
Yes ($pr.Contains("throw 'RUN_ELEVATED_IN_YOUR_OWN_WINDOW'") -and $pr.Contains("@('prepare-account', `$AccountName)") -and $pr.Contains('-Login -ProfileDirectory $profileDir -AccountSid $sid') -and -not $pr.Contains('Get-Clipboard') -and -not $pr.Contains('oauth_token')) 'prepare-script-shape'
Yes (([regex]::Matches($pr, 'Invoke-PrepCompile \$Csc')).Count -eq 1 -and $functions['prepare-companion-account.ps1:Invoke-PrepCompile'].Contains('/target:winexe /platform:x64 /optimize+')) 'prepare-compiles-with-the-install-recipe'
. ([scriptblock]::Create($functions['prepare-companion-account.ps1:Get-CompanionWslConfig']))
Yes ((Get-CompanionWslConfig '16GB' 8 '4GB') -ceq "[wsl2]`r`nmemory=16GB`r`nprocessors=8`r`nswap=4GB`r`n") 'prepare-wslconfig'
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $planOut = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $here 'prepare-companion-account.ps1') -Plan -LogDirectory (Join-Path $Scratch 'prep-log') | Out-String
  Yes ($LASTEXITCODE -eq 0 -and $planOut.Contains('PLAN_ONLY_NOTHING_CHANGED') -and -not (Test-Path -LiteralPath (Join-Path $Scratch 'prep-log'))) 'prepare-plan-read-only'
}

[ordered]@{ status = 'COMPANION_HEADLESS_WINDOWS_OFFLINE_PASS'; assertions = $n; supervisorCsharpAssertions = $supervisorCsharp; registrarCsharpAssertions = $registrarCsharp; pinvokeBound = $pinvokeBound; gitconfigNode = $nodeText; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
