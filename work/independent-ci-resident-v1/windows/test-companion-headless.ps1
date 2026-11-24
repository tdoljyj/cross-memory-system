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
foreach ($file in @('companion-headless.ps1', 'install-resident.ps1', 'upgrade-apply.ps1', 'verify-resident.ps1', 'rearm-resident.ps1', 'uninstall-resident.ps1', 'companion-gh-login.ps1', 'probe-companion-headless.ps1', 'companion-headless-fallback.ps1', 'prepare-companion-account.ps1', 'request-upgrade.ps1', 'remove-companion-account.ps1')) {
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here $file), [ref]$tokens, [ref]$errors)
  Yes ($errors.Count -eq 0) ('parse:' + $file)
  $texts[$file] = [IO.File]::ReadAllText((Join-Path $here $file))
  foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$file + ':' + $f.Name] = $f.Extent.Text }
}
# The code without its comment lines and without the leading <# ... #> help block.
$codeOf = { param([string]$t) $i = $t.IndexOf("`n#>"); if ($t.StartsWith('<#') -and $i -gt 0) { $t = $t.Substring($i + 3) }; (@($t -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n") }

Yes ($functions['install-resident.ps1:Get-RelayParentAclPresence'] -ceq $functions['companion-headless.ps1:Get-RelayParentAclPresence']) 'relay-parent-rule-one-text'
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
$ownerT = 'S-1-5-21-10-11-12-1000'
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
# A reinstall builds the registrar from the NEW package (its root-run mode runs the Linux root steps as the companion account before
# the uninstall; the installed generation's registrar may not have it): the caller's staged copy of the package's source, read once, must
# be the pinned bytes; same directory, recipe and result shape as New-CompanionBuild; the installed generation's files are never read.
$pkgRoot = Join-Path $Scratch ('pkg-build-' + [guid]::NewGuid().ToString('N')); [void][IO.Directory]::CreateDirectory((Join-Path $pkgRoot 'install'))
$pkgSource = Join-Path $Scratch 'staged-CompanionTaskRegistrar.cs'; $regBytes = [IO.File]::ReadAllBytes((Join-Path $here 'CompanionTaskRegistrar.cs'))
[IO.File]::WriteAllBytes($pkgSource, $regBytes); $pkgPin = Get-CompanionSha256 $regBytes
$stalePkg = Join-Path $pkgRoot ('install\companion-build-' + ('b' * 32)); [void][IO.Directory]::CreateDirectory($stalePkg)
$pb = New-CompanionBuildFromPackage $pkgRoot $pkgSource $pkgPin ('c' * 64) $testDacl
Yes ((Split-Path -Leaf $pb.directory) -cmatch '^companion-build-[0-9a-f]{32}$' -and (Split-Path -Parent $pb.directory) -ceq (Join-Path $pkgRoot 'install') -and (@($pb.Keys) -join ',') -ceq 'directory,generation,registrar' -and $pb.generation -ceq ('c' * 64) -and
  $pb.registrar.sourceSha256 -ceq $pkgPin -and $pb.registrar.sha256 -ceq (Get-CompanionSha256 ([IO.File]::ReadAllBytes($pb.registrar.exe))) -and -not (Test-Path -LiteralPath $stalePkg)) 'package-build-same-place-and-shape'
Yes (-not (Test-Path -LiteralPath (Join-Path $pkgRoot 'install\install-receipt.json')) -and -not (Test-Path -LiteralPath (Join-Path $pkgRoot 'config'))) 'package-build-reads-no-installed-generation'
$pacl = (Get-Acl -LiteralPath $pb.directory).Sddl
Yes ($pacl.Contains('D:P') -and -not $pacl.Contains('ID;')) ('package-build-directory-protected:' + $pacl)
# the built program has the root-run mode: one ROOT_RUN_* line on stdout, here a refusal (another root; never the real root)
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'   # the refusal's JSON on stderr must not stop the test (PowerShell 5.1)
$v = (& $pb.registrar.exe root-run 'C:\Temp' ('C:\Temp\install\linux-run-' + ('0' * 32) + '\script.sh') ('a' * 64) ('C:\Temp\install\linux-run-' + ('0' * 32) + '\out') 60 2>$null | Out-String).Trim()
$ErrorActionPreference = $eap
Yes ($v -ceq 'ROOT_RUN_REFUSED REGISTRAR_ELEVATION_REQUIRED' -or $v -ceq 'ROOT_RUN_REFUSED REGISTRAR_ARGS_REFUSED') ('package-build-registrar-has-root-run:' + $v)
Remove-CompanionBuild $pb.directory
foreach ($c in @(
    @('COMPANION_BUILD_SOURCE_NOT_THE_PACKAGE', $pkgSource, ('f' * 64), ('c' * 64)),
    @('COMPANION_BUILD_PACKAGE_SOURCE_UNREADABLE', (Join-Path $Scratch 'no-such-source.cs'), $pkgPin, ('c' * 64)),
    @('COMPANION_BUILD_PACKAGE_PIN_REFUSED', $pkgSource, 'x', ('c' * 64)),
    @('COMPANION_BUILD_PACKAGE_PIN_REFUSED', $pkgSource, $pkgPin, 'x'))) {
  $why = try { $null = New-CompanionBuildFromPackage $pkgRoot $c[1] $c[2] $c[3] $testDacl; 'built' } catch { $_.Exception.Message }
  Yes ($why -ceq $c[0]) ('package-build-refused:' + $c[0] + ':' + $why)
  Yes (@(Get-ChildItem -LiteralPath (Join-Path $pkgRoot 'install') -Force | Where-Object { $_.Name -like 'companion-build-*' }).Count -eq 0) ('package-build-refused-leaves-nothing:' + $c[0])
}
[IO.File]::WriteAllText((Join-Path $pkgRoot 'install\companion-headless-pending.json'), '{}'); $otherBuild = Join-Path $pkgRoot ('install\companion-build-' + ('d' * 32)); [void][IO.Directory]::CreateDirectory($otherBuild)
$why = try { $null = New-CompanionBuildFromPackage $pkgRoot $pkgSource $pkgPin ('c' * 64) $testDacl; 'built' } catch { $_.Exception.Message }
Yes ($why -ceq 'COMPANION_BUILD_SWITCH_IN_PROGRESS' -and (Test-Path -LiteralPath $otherBuild)) ('package-build-never-clears-a-running-switch:' + $why)
Remove-Item -LiteralPath (Join-Path $pkgRoot 'install\companion-headless-pending.json') -Force; Remove-Item -LiteralPath $otherBuild -Recurse -Force
$badSource = Join-Path $Scratch 'staged-bad.cs'; [IO.File]::WriteAllText($badSource, 'class X { void Main( }')
$why = try { $null = New-CompanionBuildFromPackage $pkgRoot $badSource (Get-CompanionSha256 ([IO.File]::ReadAllBytes($badSource))) ('c' * 64) $testDacl; 'built' } catch { $_.Exception.Message }
Yes ($why -ceq 'COMPANION_BUILD_COMPILE_FAILED' -and @(Get-ChildItem -LiteralPath (Join-Path $pkgRoot 'install') -Force).Count -eq 0) ('package-build-compile-failure-leaves-nothing:' + $why)
Yes ($functions['companion-headless.ps1:New-CompanionBuild'].Contains('New-CompanionBuildFromBytes $root $gen $sources $dacl') -and $functions['companion-headless.ps1:New-CompanionBuildFromPackage'].Contains('New-CompanionBuildFromBytes $root $generation $sources $dacl') -and
  -not $functions['companion-headless.ps1:New-CompanionBuildFromPackage'].Contains('install-receipt.json')) 'package-build-shares-the-one-compile-path'
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
  function Register-CompanionStartTask { }
  function Remove-CompanionStartTask { }
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
foreach ($file in @('companion-headless.ps1', 'rearm-resident.ps1', 'install-resident.ps1', 'upgrade-apply.ps1', 'verify-resident.ps1', 'uninstall-resident.ps1', 'probe-companion-headless.ps1', 'companion-headless-fallback.ps1', 'prepare-companion-account.ps1', 'request-upgrade.ps1', 'remove-companion-account.ps1')) {
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
$acct = 'S-1-5-21-10-11-12-1010'; $opr = 'S-1-5-21-10-11-12-1000'; $ctl = 'S-1-5-21-10-11-12-1007'
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
$regT = [ordered]@{ guid = '{y}'; name = 'Ubuntu-24.04'; basePath = 'C:\Users\owner-b\AppData\Local\wsl\{7483e0fe-20a8-4d63-8ff8-8572cdf2e45c}' }
$p = Get-CompanionWslMovePlan $regT $true 'C:\clued-resident\wsl\Ubuntu-24.04' $false
Yes ($p.action -ceq 'move' -and $p.sameVolume) 'wsl-plan-node-b-rename-on-c'
Yes ((Get-CompanionWslMovePlan $regD $false 'D:\clued-resident\wsl\CluedResident-Linux' $true).action -ceq 'forget') 'wsl-plan-file-moved-registration-left-forget'
Yes ((Get-CompanionWslMovePlan $null $false 'D:\clued-resident\wsl\CluedResident-Linux' $true).action -ceq 'done') 'wsl-plan-done-earlier'
Yes ((Get-CompanionWslMovePlan $regD $true 'D:\clued-resident\wsl\CluedResident-Linux' $true).code -ceq 'WSL_TARGET_EXISTS') 'wsl-plan-both-present-refused'
Yes ((Get-CompanionWslMovePlan $null $false 'D:\clued-resident\wsl\CluedResident-Linux' $false).code -ceq 'WSL_DISTRIBUTION_NOT_FOUND') 'wsl-plan-nothing-anywhere-refused'
Yes ((Get-CompanionWslMovePlan $regD $false 'D:\clued-resident\wsl\CluedResident-Linux' $false).code -ceq 'WSL_SOURCE_MISSING') 'wsl-plan-no-file-refused'
Yes ((Get-CompanionWslMovePlan $regD $true 'D:\clued resident\x' $false).code -ceq 'WSL_TARGET_REFUSED' -and (Get-CompanionWslMovePlan $regD $true 'D:\a\..\b' $false).code -ceq 'WSL_TARGET_REFUSED' -and (Get-CompanionWslMovePlan $regD $true '\\server\share' $false).code -ceq 'WSL_TARGET_REFUSED') 'wsl-plan-target-shape-refused'
$regAt = [ordered]@{ guid = '{z}'; name = 'CluedResident-Linux'; basePath = 'D:\clued-resident\wsl\CluedResident-Linux' }
Yes ((Get-CompanionWslMovePlan $regAt $true 'D:\clued-resident\wsl\CluedResident-Linux' $true).action -ceq 'forget') 'wsl-plan-already-there-only-forget'
Yes ((Get-CompanionVhdxSddl $acct) -ceq ('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;' + $acct + ')')) 'vhdx-sddl-admins-and-the-account-only'
Yes ($CompanionVhdxParentSddl -ceq 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)' -and $functions['companion-headless.ps1:Assert-CompanionVhdxParents'].Contains('New-CompanionProtectedDirectory $d $CompanionVhdxParentSddl') -and $functions['companion-headless.ps1:Invoke-CompanionWslMove'].Contains('Assert-CompanionVhdxParents $targetDir')) 'vhdx-missing-parents-created-protected'
# the verified copy (a real small file in the scratch directory): both hashes, then the move deletes the source only after they match
$src = Join-Path $Scratch 'vhdx-src.bin'; $dst = Join-Path $Scratch 'vhdx-dst.bin'
$bytes = New-Object byte[] 9437185; (New-Object Random 7).NextBytes($bytes); [IO.File]::WriteAllBytes($src, $bytes)
$script:CompanionRegistrarExe = Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe'
$c = Copy-CompanionFileVerified $src $dst
Yes ($c.sourceSha256 -ceq $c.targetSha256 -and $c.length -eq 9437185 -and $c.sourceSha256 -ceq (Get-CompanionFileSha256 $src)) 'wsl-copy-hashed-on-both-sides'
$mv = $functions['companion-headless.ps1:Invoke-CompanionWslMove']
Yes ($mv.IndexOf('WSL_COPY_HASH_MISMATCH') -lt $mv.IndexOf('Remove-Item -LiteralPath $source') -and $mv.IndexOf('Invoke-CompanionWslTerminate') -lt $mv.IndexOf('Copy-CompanionFileVerified') -and $mv.IndexOf('Assert-CompanionWslVhdxReleased') -ge 0 -and $mv.IndexOf('Assert-CompanionWslVhdxReleased') -lt $mv.IndexOf('Copy-CompanionFileVerified') -and $mv.IndexOf('[IO.File]::Move($partial, $target)') -gt $mv.IndexOf('WSL_COPY_HASH_MISMATCH')) 'wsl-move-terminate-free-copy-verify-then-delete'
Yes (-not $mv.Contains('Remove-CompanionLxssKey') -and $mv.IndexOf('Export-CompanionLxssKey') -lt $mv.IndexOf('Invoke-CompanionWslTerminate', $mv.IndexOf('# 2. moved')) -and $functions['companion-headless.ps1:Remove-CompanionOwnerRegistration'].Contains('Remove-CompanionLxssKey $guid')) 'wsl-move-exports-first-and-never-forgets-the-owner-registration'
foreach ($file in @('companion-headless.ps1', 'rearm-resident.ps1', 'install-resident.ps1', 'verify-resident.ps1', 'prepare-companion-account.ps1')) {
  $normal = $texts[$file]
  if ($file -ceq 'companion-headless.ps1') { $normal = $normal.Replace($functions['companion-headless.ps1:Invoke-CompanionWslControl'], '') }
  Yes (-not ((& $codeOf $normal) -match '--unregister|--shutdown|wsl(\.exe)?''?\s+--export|--import(?!-in-place)')) ('normal-route-never-unregister-shutdown-export-import:' + $file)
}
$releaseGate = $functions['companion-headless.ps1:Assert-CompanionWslVhdxReleased']
$legacyReleaseGate = $releaseGate.Substring($releaseGate.IndexOf('# Preserve the original'))
Yes ($legacyReleaseGate.IndexOf('if (-not $AllowVmShutdown)') -lt $legacyReleaseGate.IndexOf("Invoke-CompanionWslControl 'shutdown'") -and $legacyReleaseGate.Contains("throw 'WSL_VM_SHUTDOWN_REQUIRES_MAINTENANCE'")) 'whole-vm-stop-requires-explicit-maintenance'
# Exercise the final boundary with no real SCM, WSL or VHD access. An explicit
# context must be checked even when the old free-file path would return early.
& {
  . ([scriptblock]::Create($releaseGate))
  $script:maintenanceEvents = New-Object Collections.Generic.List[string]
  $script:maintenanceMode = 'refuse'
  function Wait-CompanionVhdxFree { $script:maintenanceEvents.Add('legacy-free-check'); $true }
  function Assert-CompanionMaintenanceShutdownGuard($Path, $ContextFile, $ExpectedContextSha256) {
    $script:maintenanceEvents.Add('guard')
    if ($Path -cne 'C:\fixture\ext4.vhdx' -or $ContextFile -cne 'C:\fixture\context.json' -or $ExpectedContextSha256 -cne ('a' * 64)) { throw 'CONTEXT_ARGUMENT_BINDING_LOST' }
    if ($script:maintenanceMode -ceq 'refuse') { throw 'FIXTURE_AUTHORITY_REFUSED' }
    [ordered]@{ operationId = ('b' * 64); vmShutdownRequired = ($script:maintenanceMode -cne 'free') }
  }
  function Invoke-CompanionWslControl($operation) {
    if ($operation -cne 'shutdown') { throw 'UNEXPECTED_WSL_CONTROL' }
    $script:maintenanceEvents.Add('shutdown'); [ordered]@{ completed = $true; exitCode = 0 }
  }
  function Complete-CompanionMaintenanceShutdown($ContextFile, $ExpectedContextSha256, $Result) {
    $script:maintenanceEvents.Add('complete')
    if ($script:maintenanceMode -ceq 'completion-failed') { return [ordered]@{ completed = $false; exclusiveFileConfirmed = $false } }
    [ordered]@{ completed = $true; exclusiveFileConfirmed = $true }
  }
  $bound = @{ MaintenanceContextFile = 'C:\fixture\context.json'; ExpectedMaintenanceContextSha256 = ('a' * 64) }
  $refused = try { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' @bound; $false } catch { $_.Exception.Message -ceq 'WSL_MAINTENANCE_CONTEXT_REQUIRED' }
  Yes ($refused -and $script:maintenanceEvents.Count -eq 0) 'context-cannot-enable-shutdown-without-explicit-mode'
  $refused = try { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown @bound; $false } catch { $_.Exception.Message -ceq 'FIXTURE_AUTHORITY_REFUSED' }
  Yes ($refused -and ($script:maintenanceEvents -join ',') -ceq 'guard') 'context-refusal-never-falls-through-to-free-file-or-shutdown'
  $script:maintenanceEvents.Clear(); $script:maintenanceMode = 'free'
  $free = Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown @bound
  Yes (-not $free.vmShutdown -and ($script:maintenanceEvents -join ',') -ceq 'guard') 'context-free-vhd-never-shuts-down'
  $script:maintenanceEvents.Clear(); $script:maintenanceMode = 'shutdown'
  $done = Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown @bound
  Yes ($done.vmShutdown -and ($script:maintenanceEvents -join ',') -ceq 'guard,shutdown,complete') 'context-order-intent-guard-fixed-shutdown-completion'
  $script:maintenanceEvents.Clear(); $script:maintenanceMode = 'completion-failed'
  $refused = try { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown @bound; $false } catch { $_.Exception.Message -ceq 'WSL_MAINTENANCE_COMPLETION_UNCONFIRMED' }
  Yes ($refused -and ($script:maintenanceEvents -join ',') -ceq 'guard,shutdown,complete') 'context-unknown-completion-cannot-report-released'
}
Yes ($mv.Contains('WSL_COPY_SOURCE_CHANGED') -and $mv.IndexOf('WSL_COPY_SOURCE_CHANGED') -lt $mv.IndexOf('Remove-Item -LiteralPath ([string]$record.source)')) 'copied-resume-rechecks-the-source-before-delete'

# the account switch: preflight before the fall-back task, the marker before the move, the move before the registrar, the registrar
# before the import task, qualified before the WSL record and before the marker goes; no password argument anywhere
$as = $functions['companion-headless.ps1:Invoke-CompanionAccountSwitch']
$i = [ordered]@{ pre = $as.IndexOf('Get-CompanionAccountPreflight'); fb = $as.IndexOf('Register-CompanionFallbackTask'); mark = $as.IndexOf('Write-CompanionPending'); stop = $as.IndexOf('Stop-CompanionTask')
  move = $as.IndexOf('Invoke-CompanionWslMove'); reg = $as.IndexOf('Invoke-CompanionRegistrar'); imp = $as.IndexOf('Invoke-CompanionWslImportTask'); run = $as.IndexOf('Start-CompanionTask')
  qual = $as.IndexOf('Wait-CompanionQualified'); rec = $as.LastIndexOf('Write-CompanionWslRecord'); done = $as.IndexOf('$result.qualified = $true') }
Yes (@($i.Values | Where-Object { $_ -lt 0 }).Count -eq 0 -and $i.pre -lt $i.fb -and $i.fb -lt $i.mark -and $i.mark -lt $i.stop -and $i.stop -lt $i.move -and $i.move -lt $i.reg -and $i.reg -lt $i.imp -and $i.imp -lt $i.run -and $i.run -lt $i.qual -and $i.qual -lt $i.rec -and $i.rec -lt $i.done) 'account-switch-order'
Yes ($as.Contains("@('register-account', `$root, `$distro, `$vhdx, [string]`$uid)") -and $as.Contains("@('register-account', `$root)") -and $as.Contains('New-CompanionBuild $root') -and $as.Contains('Remove-CompanionBuild $build.directory')) 'account-switch-own-build-register-account-only'
Yes ($as.IndexOf('Invoke-CompanionFallback $root $sid', $i.move) -gt $i.move -and $as.Contains('COMPANION_HEADLESS_QUALIFICATION_FAILED') -and $as.Contains('Invoke-CompanionStopAndFallback $root $sid')) 'account-switch-falls-back'
Yes ($functions['companion-headless.ps1:Invoke-CompanionRootShell'].Contains("@('root-shell', `$root)")) 'root-shell-through-the-registrar'
# the preflight over fake facts (pure; the profile directory is a scratch folder)
$okFacts = [pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; refusal = $null; rights = @('SeBatchLogonRight', 'SeDenyNetworkLogonRight'); profileDirectory = $nodeB.ownerProfileDirectory; hardening = @() }
$lockGood = [ordered]@{ threshold = 10; durationMinutes = 10; windowMinutes = 10 }
$ghB = Get-CompanionGhDirs $nodeB.ownerProfileDirectory
$pf = Get-CompanionAccountPreflight $rootB $nodeB $okFacts 'D:\clued-resident\wsl\CluedResident-Linux' 0 $lockGood
Yes (@($pf.refusals) -ccontains 'COMPANION_GH_CONFIG_MISSING' -and @($pf.refusals) -ccontains 'COMPANION_HEADLESS_NOT_INSTALLED:bin\CluedCompanionSupervisor.exe') 'account-preflight-needs-gh-config-and-install'
foreach ($d in @($ghB.gh, $ghB.home, (Join-Path $rootB 'bin'), (Join-Path $rootB 'config'))) { [void][IO.Directory]::CreateDirectory($d) }
foreach ($f in @((Join-Path $ghB.gh 'hosts.yml'), (Join-Path $ghB.home '.gitconfig'), (Join-Path $rootB 'bin\CluedCompanionSupervisor.exe'), (Join-Path $rootB 'config\companion-launch.json'))) { [IO.File]::WriteAllText($f, 'x') }
$pf = Get-CompanionAccountPreflight $rootB $nodeB $okFacts 'D:\clued-resident\wsl\CluedResident-Linux' 0 $lockGood
Yes (@($pf.refusals | Where-Object { $_ -notlike 'COMPANION_HEADLESS_INJECTION_VARIABLES:*' }).Count -eq 0) ('account-preflight-passes:' + (@($pf.refusals) -join ','))
$bad = [pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; refusal = 'COMPANION_ACCOUNT_IS_ADMINISTRATOR'; rights = @('SeDenyBatchLogonRight'); profileDirectory = 'C:\Users\other' }
$pf = Get-CompanionAccountPreflight $rootB $nodeB $bad 'D:\x y' 0 $lockGood
foreach ($code in @('COMPANION_ACCOUNT_IS_ADMINISTRATOR', 'COMPANION_ACCOUNT_BATCH_LOGON_RIGHT_MISSING', 'COMPANION_ACCOUNT_BATCH_LOGON_DENIED', 'COMPANION_ACCOUNT_PROFILE_NOT_THE_NODE_PROFILE', 'WSL_TARGET_REFUSED')) { Yes (@($pf.refusals) -ccontains $code) ('account-preflight-refuses:' + $code) }
Yes (@((Get-CompanionAccountPreflight $rootB $nodeB $null 'D:\a' 0 $lockGood).refusals) -ccontains 'COMPANION_ACCOUNT_MISSING') 'account-preflight-no-facts-refused'
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
# M5-b: the account's token is the Owner's existing companion token when there is a classic one (fake tokens, scratch files only).
foreach ($fn in @('Get-LinkCount', 'Get-OwnerTokenState', 'Copy-OwnerToken')) { . ([scriptblock]::Create($functions['companion-gh-login.ps1:' + $fn])) }
$GithubTokenRx = [regex]::Match($texts['companion-gh-login.ps1'], '(?m)^\$GithubTokenRx = ''(.+)''\r?$').Groups[1].Value
$meSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$cpRoot = Join-Path $Scratch 'copy-owner'; [void][IO.Directory]::CreateDirectory($cpRoot)
$fakeClassic = 'ghp_' + ('A1b2' * 9)
function New-OwnerProfile([string]$name, $hostsText) {
  $pd = Join-Path $cpRoot $name; $g = (Get-CompanionGhDirs $pd).gh; [void][IO.Directory]::CreateDirectory($g)
  if ($null -ne $hostsText) { [IO.File]::WriteAllText((Join-Path $g 'hosts.yml'), $hostsText) }
  $pd
}
$tg = Join-Path $cpRoot 'target-hosts.yml'
# the real full path: classic token, other host entries around it; the target is a NEW file with only github.com
$op = New-OwnerProfile 'ok' ("other.example.com:`n    oauth_token: ghp_" + ('Z' * 36) + "`ngithub.com:`n    user: someone`n    oauth_token: $fakeClassic`n    git_protocol: ssh`nthird.example.com:`n    oauth_token: ghp_" + ('Y' * 36) + "`n")
Yes ((Copy-OwnerToken $op $meSid $tg $cpRoot) -ceq 'copied' -and [IO.File]::ReadAllText($tg) -ceq "github.com:`n    oauth_token: $fakeClassic`n    git_protocol: https`n" -and @(Get-ChildItem -LiteralPath $cpRoot -Filter '*.tmp' -Recurse).Count -eq 0) 'copy-owner-token-classic-regenerated-github-only'
# the real default profile root (C:\Users): the pattern that once threw on a single backslash accepts C:\Users\x and refuses elsewhere
Yes ((Get-OwnerTokenState 'C:\Users\clued-test-no-such-profile' $meSid) -ceq 'OWNER_TOKEN_MISSING' -and (Get-OwnerTokenState 'C:\Windows\x' $meSid) -ceq 'OWNER_PROFILE_REFUSED') 'copy-owner-token-default-profile-pattern'
Yes ((Get-OwnerTokenState $op 'S-1-5-21-1-2-3-4' $cpRoot) -ceq 'OWNER_SID_MISMATCH') 'copy-owner-token-wrong-sid-refused'
Remove-Item -LiteralPath $tg -Force
Yes ((Copy-OwnerToken (Join-Path $cpRoot 'absent') $meSid $tg $cpRoot) -ceq 'OWNER_TOKEN_MISSING' -and -not (Test-Path -LiteralPath $tg)) 'copy-owner-token-missing-nothing-written'
$op2 = New-OwnerProfile 'fine' ("github.com:`n    oauth_token: github_pat_" + ('x' * 40) + "`n")
Yes ((Copy-OwnerToken $op2 $meSid $tg $cpRoot) -ceq 'OWNER_TOKEN_NOT_CLASSIC' -and -not (Test-Path -LiteralPath $tg)) 'copy-owner-token-wrong-format-refused'
$op3 = New-OwnerProfile 'other-host' ("other.example.com:`n    oauth_token: $fakeClassic`n")
Yes ((Copy-OwnerToken $op3 $meSid $tg $cpRoot) -ceq 'OWNER_TOKEN_MISSING' -and -not (Test-Path -LiteralPath $tg)) 'copy-owner-token-only-from-github-com'
# links: the file hard-linked, a folder on the way a junction
$op4 = New-OwnerProfile 'hard' ("github.com:`n    oauth_token: $fakeClassic`n")
$hl = Join-Path $cpRoot 'hardlink-peer'; $null = New-Item -ItemType HardLink -Path $hl -Target (Join-Path (Get-CompanionGhDirs $op4).gh 'hosts.yml')
Yes ((Get-LinkCount $hl) -eq 2 -and (Copy-OwnerToken $op4 $meSid $tg $cpRoot) -ceq 'OWNER_TOKEN_FILE_HARDLINKED' -and -not (Test-Path -LiteralPath $tg)) 'copy-owner-token-hardlink-refused'
$op5 = New-OwnerProfile 'junc' $null
$realGh = Join-Path $cpRoot 'real-gh'; [void][IO.Directory]::CreateDirectory($realGh); [IO.File]::WriteAllText((Join-Path $realGh 'hosts.yml'), "github.com:`n    oauth_token: $fakeClassic`n")
$ghp = (Get-CompanionGhDirs $op5).gh; Remove-Item -LiteralPath $ghp -Force
$null = & cmd.exe /c mklink /J "$ghp" "$realGh"
Yes ((Copy-OwnerToken $op5 $meSid $tg $cpRoot) -ceq 'OWNER_TOKEN_PATH_IS_A_LINK' -and -not (Test-Path -LiteralPath $tg)) 'copy-owner-token-junction-on-the-path-refused'
[IO.Directory]::Delete($ghp)
$glc = & $codeOf $texts['companion-gh-login.ps1']
Yes ($glc.Contains("throw 'COPYFROMOWNER_NEEDS_THE_ACCOUNT'") -and $glc.Contains("'COMPANION_GH_' + `$state") -and ([regex]::Matches($glc, 'Initialize-CompanionGhFolder \$dirs')).Count -eq 2) 'copy-mode-needs-account-shares-the-acl-function'
# prepare: the child copy first, the clipboard login as the fallback, the source recorded in the log
$prc = & $codeOf $texts['prepare-companion-account.ps1']
Yes ($prc.IndexOf('Invoke-CompanionTokenChild $ps $gl ''CopyFromOwner'' $profileDir $sid') -gt 0 -and $prc.IndexOf('Invoke-CompanionTokenChild $ps $gl ''CopyFromOwner'' $profileDir $sid') -lt $prc.IndexOf('Invoke-CompanionTokenChild $ps $gl ''Login'' $profileDir $sid') -and $prc.Contains("source = 'owner-existing-token'") -and $prc.Contains("source = 'clipboard'") -and $prc.Contains("'COMPANION_GH_LOGIN_COPIED'")) 'prepare-copies-owner-token-else-clipboard'
$tpl = [IO.File]::ReadAllText((Join-Path $here '..\reinstall\launcher\template.ps1'))
Yes ($tpl.Contains("if (`$id.User.Value -cne `$OperatorSid) { throw 'OWNER_ACCOUNT_REQUIRED' }") -and $tpl.Contains("@('-CompanionAccount', '-WslVhdxDirectory', `$CompanionWslVhdxDirectory)") -and $tpl.Contains("'-OperatorSid', `$OperatorSid)")) 'launcher-operator-and-account-step'
# the prepare script: elevated runs only; -Plan is read-only and runs here (not elevated); it never handles a password or the token
$pr = & $codeOf $texts['prepare-companion-account.ps1']
$rmScript = & $codeOf $texts['remove-companion-account.ps1']
Yes ($rmScript.Contains("@('remove-account', `$AccountName)") -and $rmScript.Contains("throw 'REGISTRAR_SOURCE_NOT_THE_PINNED_ONE'") -and $rmScript.Contains("throw 'RUN_ELEVATED_IN_YOUR_OWN_WINDOW'") -and $rmScript.Contains('Remove-ItemProperty -LiteralPath $UserList -Name $AccountName')) 'remove-account-script-shape'
Yes ($pr.Contains("throw 'RUN_ELEVATED_IN_YOUR_OWN_WINDOW'") -and $pr.Contains("@('prepare-account', `$AccountName)") -and $pr.Contains('Invoke-CompanionTokenChild $ps $gl ''Login'' $profileDir $sid') -and -not $pr.Contains('Get-Clipboard') -and -not $pr.Contains('oauth_token')) 'prepare-script-shape'
Yes (([regex]::Matches($pr, 'Invoke-PrepCompile \$Csc')).Count -eq 1 -and $functions['prepare-companion-account.ps1:Invoke-PrepCompile'].Contains('/target:winexe /platform:x64 /optimize+')) 'prepare-compiles-with-the-install-recipe'
. ([scriptblock]::Create($functions['prepare-companion-account.ps1:Get-CompanionWslConfig']))
Yes ((Get-CompanionWslConfig '16GB' 8 '4GB') -ceq "[wsl2]`r`nmemory=16GB`r`nprocessors=8`r`nswap=4GB`r`n") 'prepare-wslconfig'
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $planOut = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $here 'prepare-companion-account.ps1') -Plan -LogDirectory (Join-Path $Scratch 'prep-log') -RegistrarSha256 ('0' * 64) | Out-String
  Yes ($LASTEXITCODE -eq 0 -and $planOut.Contains('PLAN_ONLY_NOTHING_CHANGED') -and -not (Test-Path -LiteralPath (Join-Path $Scratch 'prep-log'))) 'prepare-plan-read-only'
  # review r1 m5: the roll-back script, read-only in -Plan
  $rmOut = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $here 'remove-companion-account.ps1') -Plan -LogDirectory (Join-Path $Scratch 'rm-log') -RegistrarSha256 ('0' * 64) | Out-String
  Yes ($LASTEXITCODE -eq 0 -and $rmOut.Contains('PLAN_ONLY_NOTHING_CHANGED') -and -not (Test-Path -LiteralPath (Join-Path $Scratch 'rm-log'))) 'remove-account-plan-read-only'
}

# 10. M5-b independent review r1 (BLOCKER B1, MAJOR M1-M5, MINOR m1-m12): behaviour tests. Every scenario runs in the scratch directory
# with the host-facing steps (wsl.exe, the registry, ACLs, the Task Scheduler, the registrar) replaced by recording stubs in a child
# scope (PowerShell resolves functions dynamically, so the real switch calls the stubs). Each check is reported on its own.
$r1 = [ordered]@{}
function R1([string]$id, [scriptblock]$body) { try { $null = & $body; $script:r1[$id] = 'pass' } catch { $script:r1[$id] = 'FAIL: ' + $_.Exception.Message } }
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acctR = 'S-1-5-21-111-222-333-1010'; $oprR = $me
$rootR = Join-Path $Scratch 'r1-root'; foreach ($d in @('install', 'bin', 'config')) { [void][IO.Directory]::CreateDirectory((Join-Path $rootR $d)) }
[IO.File]::WriteAllText((Join-Path $rootR 'install\install-receipt.json'), '{"residentManifestSha256":"' + ('a' * 64) + '"}')
$profR = Join-Path $Scratch 'r1-profile'; $ghR = Get-CompanionGhDirs $profR
foreach ($d in @($ghR.gh, $ghR.home)) { [void][IO.Directory]::CreateDirectory($d) }
foreach ($f in @((Join-Path $ghR.gh 'hosts.yml'), (Join-Path $ghR.home '.gitconfig'), (Join-Path $rootR 'bin\CluedCompanionSupervisor.exe'), (Join-Path $rootR 'config\companion-launch.json'))) { [IO.File]::WriteAllText($f, 'x') }
$nodeR = [pscustomobject]@{ ownerSid = $acctR; ownerProfileDirectory = $profR; wslDistribution = 'CluedResident-Linux' }
$factsR = [pscustomobject]@{ code = 'ACCOUNT_FACTS'; exists = $true; refusal = $null; rights = @('SeBatchLogonRight', 'SeDenyNetworkLogonRight', 'SeDenyRemoteInteractiveLogonRight'); profileDirectory = $profR; hardening = @() }
$lockOk = [ordered]@{ threshold = 10; durationMinutes = 10; windowMinutes = 10 }

# A fresh scenario: a source vhdx in "the Owner's" folder, a target directory, a fake Lxss registration. Returns the paths and a log.
function New-R1Scenario([string]$name, [int]$bytes = 3145730) {
  $base = Join-Path $Scratch ('r1-' + $name)
  $src = Join-Path $base 'owner\CluedResident-Linux'; [void][IO.Directory]::CreateDirectory($src)
  $data = New-Object byte[] $bytes; (New-Object Random $bytes).NextBytes($data); [IO.File]::WriteAllBytes((Join-Path $src 'ext4.vhdx'), $data)
  Remove-Item -LiteralPath (Join-Path $rootR 'install\companion-wsl.json') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $rootR $CompanionPendingFile) -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath (Join-Path $rootR 'install') -Filter 'companion-wsl-owner-*' -ErrorAction SilentlyContinue | Remove-Item -Force
  [ordered]@{ base = $base; source = (Join-Path $src 'ext4.vhdx'); sourceDir = $src; targetDir = (Join-Path $base 'd\clued-resident\wsl\CluedResident-Linux'); sha = (Get-CompanionFileSha256 (Join-Path $src 'ext4.vhdx'))
    log = (New-Object Collections.ArrayList); keyPresent = $true; default = '{g1}' }
}
# The stubs every switch scenario uses; $sc is the scenario, $opt overrides (registrar code, import result, faults).
function Invoke-R1Switch($sc, $opt, [string]$vhdxDir) {
  $script:sc = $sc; $script:opt = $opt
  & {
    function Get-CompanionRelayParentsProblem { $null }
    function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r1-build-none'); generation = ('a' * 64); registrar = [ordered]@{ exe = 'registrar.exe'; sourceSha256 = ('b' * 64); sha256 = ('c' * 64) } } }
    function Remove-CompanionBuild { }
    function Get-CompanionAccountFacts { $factsR }
    function Get-LockoutPolicy { $lockOk }
    function Get-CompanionDomainCredsDisabled { if ($script:opt.ContainsKey('lsa')) { $script:opt.lsa } else { 0 } }
    function Register-CompanionFallbackTask { [void]$script:sc.log.Add('fallback-task') }
    function Register-CompanionStartTask { }
    function Remove-CompanionStartTask { }
    function Remove-CompanionFallbackTask { [void]$script:sc.log.Add('fallback-task-removed') }
    function Stop-CompanionTask { [void]$script:sc.log.Add('stop') }
    function Get-CompanionProcessTree { [ordered]@{ supervisors = @(); children = @() } }
    function Wait-CompanionTaskNotRunning { }
    # as the real ones: the interactive definition comes back and the pending marker goes
    function Invoke-CompanionFallback { [void]$script:sc.log.Add('fallback'); Remove-Item -LiteralPath (Join-Path $rootR $CompanionPendingFile) -Force -ErrorAction SilentlyContinue; [ordered]@{ fellBack = $true } }
    function Invoke-CompanionStopAndFallback { [void]$script:sc.log.Add('stop-and-fallback'); Remove-Item -LiteralPath (Join-Path $rootR $CompanionPendingFile) -Force -ErrorAction SilentlyContinue; [ordered]@{ fellBack = $true } }
    function Get-WslRegistrations { if ($script:sc.keyPresent) { @([ordered]@{ guid = '{g1}'; name = 'CluedResident-Linux'; basePath = $script:sc.sourceDir; defaultUid = 1000; values = [ordered]@{ DistributionName = 'CluedResident-Linux'; BasePath = $script:sc.sourceDir; DefaultUid = 1000; VhdFileName = 'ext4.vhdx' } }) } else { @() } }
    function Export-CompanionLxssKey([string]$guid, [string]$file) { [void]$script:sc.log.Add('export:' + $guid); [IO.File]::WriteAllText($file, 'REGEDIT4') }
    function Remove-CompanionLxssKey([string]$guid) { [void]$script:sc.log.Add('remove-key:' + $guid); $script:sc.keyPresent = $false; if ($script:opt.ContainsKey('throwAfterKeyRemoved')) { throw 'BOOM_AFTER_KEY' } }
    function Get-CompanionLxssDefault { $script:sc.default }
    function Remove-CompanionLxssDefault { [void]$script:sc.log.Add('remove-default'); $script:sc.default = $null }
    function Import-CompanionLxssKey([string]$file) { [void]$script:sc.log.Add('import-key'); $script:sc.keyPresent = $true }
    function Invoke-CompanionWslTerminate { [void]$script:sc.log.Add('terminate') }
    function Test-CompanionSameVolume { if ($script:opt.ContainsKey('sameVolume')) { $script:opt.sameVolume } else { $false } }
    function Get-CompanionDirSddl([string]$path) { if ($script:opt.ContainsKey('unsafeParent') -and $path -like ('*' + $script:opt.unsafeParent)) { 'O:S-1-5-21-9-9-9-1013G:SYD:(A;;FA;;;S-1-5-21-9-9-9-1013)' } else { 'O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)' } }
    function New-CompanionProtectedDirectory([string]$path, [string]$sddl) { [void][IO.Directory]::CreateDirectory($path); [void]$script:sc.log.Add('mkdir:' + (Split-Path -Leaf $path)) }
    function Set-CompanionVhdxAcl { [void]$script:sc.log.Add('vhdx-acl') }
    function Get-CompanionFileSha256Unbuffered([string]$path) { if ($script:opt.ContainsKey('badHash')) { 'f' * 64 } else { Get-CompanionFileSha256 $path } }
    function Invoke-CompanionRegistrar($root, [string[]]$arguments, $exe) { [void]$script:sc.log.Add('registrar:' + ($arguments -join ' ')); '{"code":"' + $(if ($script:opt.ContainsKey('registrar')) { $script:opt.registrar } else { 'REGISTERED' }) + '"}' }
    function Invoke-CompanionWslImportTask { [void]$script:sc.log.Add('import-task'); if ($script:opt.ContainsKey('import')) { $script:opt.import } else { [int64]$CompanionImportDoneExitCode } }
    function Start-CompanionTask { [void]$script:sc.log.Add('run') }
    function Wait-CompanionQualified { if ($script:opt.ContainsKey('qualify')) { $script:opt.qualify } else { $null } }
    function Get-CompanionTaskFacts { [ordered]@{ mode = 'password'; problems = @() } }
    Invoke-CompanionAccountSwitch $rootR $nodeR $vhdxDir 'account'
  }
}

R1 'B1-source-v2-acl-runs-as-the-operator' {
  # the install's own step body, run with a fake migrate-acl.ps1 that refuses (as Source v2 line 49 does) unless -OwnerSid is the caller
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $here 'install-resident.ps1'), [ref]$tokens, [ref]$errors)
  $step = $ast.FindAll({ param($a) $a -is [Management.Automation.Language.CommandAst] -and $a.CommandElements.Count -eq 3 -and [string]$a.CommandElements[0] -ceq 'Step' -and [string]$a.CommandElements[1] -ceq "'source-v2-acl'" }, $true) | Select-Object -First 1
  if ($null -eq $step) { throw 'STEP_NOT_FOUND' }
  $body = $step.CommandElements[2].ScriptBlock.GetScriptBlock()
  $Root = Join-Path $Scratch 'b1-root'; $plan = [pscustomobject]@{ ciSourceManifestSha256 = ('d' * 64); residentSid = 'S-1-5-80-1-2-3-4-5' }
  $toolDir = Join-Path $Root ('source\' + ('d' * 64) + '\work\actions-hosted-migration\independent-ci-v1\src\resident-v2'); [void][IO.Directory]::CreateDirectory($toolDir)
  [IO.File]::WriteAllText((Join-Path $toolDir 'migrate-acl.ps1'), "param([switch]`$Apply, [string]`$ResidentSid, [string]`$OwnerSid, [string]`$ControllerSid)`nif (`$OwnerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { 'ELEVATED_OWNER_REQUIRED'; exit 1 }`n'{`"code`":`"FAKE_MIGRATE_OK`"}'")
  $OwnerSid = $acctR; $OperatorSid = $oprR; $ControllerSid = 'S-1-5-21-111-222-333-1007'; $AccountNode = $true
  $script:receipt = [ordered]@{}
  & $body
  if ([string]$script:receipt.sourceV2Acl.code -cne 'FAKE_MIGRATE_OK') { throw 'NOT_RUN_AS_OPERATOR' }
}
R1 'M1-parent-acl-rules' {
  if ($null -ne (Get-CompanionDirAclProblem 'O:SYG:SYD:(A;OICIIO;SDGXGWGR;;;AU)(A;;0x1301bf;;;AU)(A;;FA;;;SY)(A;OICIIO;GA;;;SY)(A;OICIIO;GA;;;BA)(A;;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)' $true)) { throw 'D_ROOT_REFUSED' }
  if ($null -ne (Get-CompanionDirAclProblem 'O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:SYD:PAI(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)' $true)) { throw 'C_ROOT_REFUSED' }
  if ($null -ne (Get-CompanionDirAclProblem $CompanionVhdxParentSddl $false)) { throw 'OWN_PARENT_REFUSED' }
  if ((Get-CompanionDirAclProblem 'O:S-1-5-21-9-9-9-1013G:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' $false) -cne 'owner') { throw 'USER_OWNER_ACCEPTED' }
  foreach ($mask in @('0x10000', '0x40', '0x40000', '0x80000', 'GA')) {
    if ((Get-CompanionDirAclProblem ('O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;' + $mask + ';;;AU)') $false) -notlike 'ace:*') { throw ('DANGEROUS_ACE_ACCEPTED:' + $mask) }
  }
  if ((Get-CompanionDirAclProblem 'O:SYG:SYD:(A;;0x40;;;AU)(A;;FA;;;SY)' $true) -notlike 'ace:*') { throw 'ROOT_DELETE_CHILD_ACCEPTED' }
  if ($null -ne (Get-CompanionDirAclProblem 'O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;GA;;;CO)(A;OICI;0x1200a9;;;BU)' $false)) { throw 'INHERIT_ONLY_COUNTED' }
}
R1 'M1-existing-unsafe-parent-refused-before-anything' {
  $sc = New-R1Scenario 'm1'; [void][IO.Directory]::CreateDirectory((Join-Path $sc.base 'd\clued-resident'))
  $r = Invoke-R1Switch $sc @{ unsafeParent = 'd\clued-resident' } $sc.targetDir
  if ($r.failed -cne 'COMPANION_WSL_MOVE_FAILED:WSL_TARGET_PARENT_UNSAFE') { throw ('got:' + $r.failed) }
  if (-not (Test-Path -LiteralPath $sc.source) -or @($sc.log) -contains 'remove-key:{g1}') { throw 'SOURCE_OR_KEY_TOUCHED' }
}
R1 'M3-copy-fault-leaves-no-partial-and-rerun-copies' {
  $sc = New-R1Scenario 'm3' 9437185
  $partial = Join-Path $sc.base 'p\ext4.vhdx.partial'; [void][IO.Directory]::CreateDirectory((Split-Path -Parent $partial))
  $threw = try { $null = Copy-CompanionFileVerified $sc.source $partial { param($done) if ($done -gt 0) { throw 'DISK_GONE' } }; $false } catch { $_.Exception.Message -like '*DISK_GONE*' }
  if (-not $threw -or (Test-Path -LiteralPath $partial) -or (Get-CompanionFileSha256 $sc.source) -cne $sc.sha) { throw 'PARTIAL_LEFT_OR_SOURCE_CHANGED' }
  # a partial left by a cut-off earlier run does not block the move
  [void][IO.Directory]::CreateDirectory($sc.targetDir); [IO.File]::WriteAllText((Join-Path $sc.targetDir 'ext4.vhdx.partial'), 'stale')
  $rec = & { function Get-WslRegistrations { @([ordered]@{ guid = '{g1}'; name = 'CluedResident-Linux'; basePath = $sc.sourceDir; values = [ordered]@{ DefaultUid = 0 } }) }
    function Export-CompanionLxssKey($g, $f) { [IO.File]::WriteAllText($f, 'x') }; function Invoke-CompanionWslTerminate { }; function Test-CompanionSameVolume { $false }
    function Get-CompanionDirSddl { $CompanionVhdxParentSddl.Replace('O:BAG:BAD:', 'O:BAG:SYD:') }; function New-CompanionProtectedDirectory($p, $s) { [void][IO.Directory]::CreateDirectory($p) }
    function Set-CompanionVhdxAcl { }; function Get-CompanionFileSha256Unbuffered($p) { Get-CompanionFileSha256 $p }
    Invoke-CompanionWslMove $rootR 'CluedResident-Linux' $sc.targetDir $acctR }
  if ((Get-CompanionFileSha256 (Join-Path $sc.targetDir 'ext4.vhdx')) -cne $sc.sha -or (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx.partial')) -or (Test-Path -LiteralPath $sc.source) -or $rec.stage -cne 'moved') { throw 'RERUN_DID_NOT_MOVE' }
}
R1 'M3-hash-mismatch-deletes-the-partial-keeps-the-source' {
  $sc = New-R1Scenario 'm3b'
  $r = Invoke-R1Switch $sc @{ badHash = $true } $sc.targetDir
  if ($r.failed -cne 'COMPANION_WSL_MOVE_FAILED:WSL_COPY_HASH_MISMATCH' -or -not (Test-Path -LiteralPath $sc.source) -or (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx')) -or (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx.partial'))) { throw ('got:' + $r.failed) }
  if (@($sc.log) -contains 'remove-key:{g1}') { throw 'KEY_REMOVED' }
}
R1 'M4-record-and-export-before-registrar-key-only-after-import' {
  $sc = New-R1Scenario 'm4'
  $r = Invoke-R1Switch $sc @{} $sc.targetDir
  $log = @($sc.log)
  $iExport = [array]::IndexOf($log, 'export:{g1}'); $iReg = [array]::IndexOf(@($log | ForEach-Object { $_ -replace '^registrar:.*$', 'registrar' }), 'registrar'); $iImp = [array]::IndexOf($log, 'import-task'); $iKey = [array]::IndexOf($log, 'remove-key:{g1}')
  if (-not $r.qualified -or $iExport -lt 0 -or $iExport -gt $iReg -or $iImp -lt 0 -or $iKey -lt $iImp) { throw ('order:' + ($log -join ',')) }
  $rec = Read-CompanionWslRecord $rootR
  if ($rec.stage -cne 'qualified' -or -not (Test-Path -LiteralPath ([string]$rec.ownerExport)) -or [string]$rec.ownerRegistration.values.VhdFileName -cne 'ext4.vhdx' -or [int64]$rec.ownerRegistration.values.DefaultUid -ne 1000) { throw 'RECORD_INCOMPLETE' }
  if (@($log | Where-Object { $_ -like 'registrar:register-account * CluedResident-Linux *ext4.vhdx 1000' }).Count -ne 1) { throw 'DEFAULT_UID_NOT_PASSED' }
  if (-not ($log -contains 'remove-default')) { throw 'DEFAULT_NOT_CLEARED' }
}
R1 'M4-registrar-failure-after-move-keeps-the-owner-key-and-resumes' {
  $sc = New-R1Scenario 'm4b'
  $r = Invoke-R1Switch $sc @{ registrar = 'REGISTER_FAILED' } $sc.targetDir
  if ($r.failed -cne 'REGISTER_FAILED' -or @($sc.log) -contains 'remove-key:{g1}' -or -not (@($sc.log) -contains 'fallback')) { throw ('got:' + $r.failed) }
  $rec = Read-CompanionWslRecord $rootR
  if ($rec.stage -cne 'moved' -or [bool]$rec.imported) { throw 'RECORD_NOT_MOVED' }
  # resume from the record alone (no -WslVhdxDirectory): no second copy, import, then the key
  $sc.log.Clear()
  $r = Invoke-R1Switch $sc @{} ''
  if (-not $r.qualified -or @($sc.log) -contains 'terminate' -or -not (@($sc.log) -contains 'import-task') -or -not (@($sc.log) -contains 'remove-key:{g1}')) { throw ('resume:' + $r.failed + ':' + (@($sc.log) -join ',')) }
}
R1 'M4-m1-import-failure-reported-key-kept' {
  $sc = New-R1Scenario 'm4c'
  $r = Invoke-R1Switch $sc @{ import = 3L } $sc.targetDir
  if ($r.failed -cne 'WSL_IMPORT_FAILED:3' -or @($sc.log) -contains 'remove-key:{g1}' -or -not (@($sc.log) -contains 'fallback')) { throw ('got:' + $r.failed) }
  if ((Read-CompanionWslRecord $rootR).stage -cne 'moved') { throw 'STAGE' }
  $r = Invoke-R1Switch $sc @{ import = 'timeout' } ''
  if ($r.failed -cne 'WSL_IMPORT_FAILED:timeout') { throw ('timeout:' + $r.failed) }
}
# task 87d330d0 (drill r11): only the import program's own success code is an import; the Task Scheduler's 0 (an instance that never ran)
# and an instance that never started are failures that keep the Owner's registration and the record at moved.
R1 'import-0-or-not-started-is-no-import-key-kept' {
  if ([int64]$CompanionImportDoneExitCode -ne 0x434C4901 -or $texts['companion-headless.ps1'] -cnotmatch '(?m)^\$CompanionImportDoneExitCode = 0x434C4901\s*$' -or
      -not ([IO.File]::ReadAllText((Join-Path $here 'CompanionTaskRegistrar.cs'))).Contains('public const int ImportDoneExitCode = 0x434C4901;')) { throw 'DONE_CODE_NOT_ONE_VALUE' }
  foreach ($case in @(@{ import = 0L; want = 'WSL_IMPORT_FAILED:0' }, @{ import = 'not-started'; want = 'WSL_IMPORT_FAILED:not-started' }, @{ import = 'unreadable'; want = 'WSL_IMPORT_FAILED:unreadable' })) {
    $sc = New-R1Scenario ('dq-' + $case.want.Length)
    $r = Invoke-R1Switch $sc @{ import = $case.import } $sc.targetDir
    if ($r.failed -cne $case.want -or @($sc.log) -contains 'remove-key:{g1}' -or -not (@($sc.log) -contains 'fallback')) { throw ('got:' + $r.failed + ':' + (@($sc.log) -join ',')) }
    $rec = Read-CompanionWslRecord $rootR
    if ($rec.stage -cne 'moved' -or [bool]$rec.imported) { throw ('RECORD:' + $rec.stage) }
  }
}
R1 'M4-exception-after-key-removed-resumes' {
  $sc = New-R1Scenario 'm4d'
  $r = Invoke-R1Switch $sc @{ throwAfterKeyRemoved = $true } $sc.targetDir
  if (-not $r.failed -or $r.qualified) { throw 'NOT_FAILED' }
  $rec = Read-CompanionWslRecord $rootR
  if (-not (Test-Path -LiteralPath ([string]$rec.ownerExport)) -or $rec.stage -cne 'imported') { throw ('RECORD:' + $rec.stage) }
  $sc.log.Clear()
  $r = Invoke-R1Switch $sc @{} ''
  if (-not $r.qualified -or @($sc.log) -contains 'import-task') { throw ('resume:' + $r.failed + ':' + (@($sc.log) -join ',')) }
}
R1 'M4-restore-moves-back-and-reimports-the-key' {
  $sc = New-R1Scenario 'm4e'
  $null = Invoke-R1Switch $sc @{} $sc.targetDir
  $script:sc = $sc
  $res = & {
    $script:restoreLeafAcl = Get-CompanionVhdxSddl $acctR
    function Get-CompanionDirSddl([string]$path) { if ($path -ieq $script:sc.targetDir) { $script:restoreLeafAcl } else { $CompanionVhdxParentSddl } }
    function Set-CompanionRestoreTargetAcl([string]$dir) { if ($dir -ine $script:sc.targetDir) { throw 'UNEXPECTED_RESTORE_ACL_TARGET' }; $script:restoreLeafAcl = $CompanionRestoredVhdxSddl; [void]$script:sc.log.Add('restore-leaf-acl') }
    function Get-WslRegistrations { @() }; function Import-CompanionLxssKey($f) { [void]$script:sc.log.Add('import-key') }; function Invoke-CompanionStopAndFallback { [void]$script:sc.log.Add('stop-and-fallback') }
    function Test-CompanionSameVolume { $false }; function Set-CompanionOwnerFileAcl { }
    # review r2 N1: the real unbuffered hash through a real registrar build (only the build's location is the scratch one)
    function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r1-restore-build'); generation = ('a' * 64); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe'); sourceSha256 = ('b' * 64); sha256 = ('c' * 64) } } }
    function Remove-CompanionBuild { }
    Invoke-CompanionWslRestore $rootR $nodeR }
  if (-not $res.restored -or (Get-CompanionFileSha256 $sc.source) -cne $sc.sha -or (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx')) -or -not (@($sc.log) -contains 'import-key') -or -not (@($sc.log) -contains 'restore-leaf-acl') -or $res.record.restoreTargetDirectory.status -cne 'REUSABLE') { throw ('restore:' + $res.failed) }
}
R1 'M4-restore-unexpected-failure-retains-stage-and-cleans-build-without-secret-message' {
  $sc = New-R1Scenario 'm4diag'
  $null = Invoke-R1Switch $sc @{} $sc.targetDir
  $script:sc = $sc
  $res = & {
    function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r1-restore-error-build'); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe') } } }
    function Remove-CompanionBuild { [void]$script:sc.log.Add('error-build-cleaned') }
    function Invoke-CompanionStopAndFallback { throw [InvalidOperationException]::new('fixture-private-message-must-not-appear') }
    Invoke-CompanionWslRestore $rootR $nodeR
  }
  $json = $res | ConvertTo-Json -Depth 10 -Compress
  if ($res.restored -or $res.failed -cne 'WSL_RESTORE_UNEXPECTED' -or $res.error.operation -cne 'stop-companion' -or
      $res.error.chain[0].type -cne 'System.InvalidOperationException' -or $res.error.chain[0].hresult -cnotmatch '^0x[0-9A-F]{8}$' -or
      $json.Contains('fixture-private-message') -or -not (@($sc.log) -contains 'error-build-cleaned') -or
      -not (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx')) -or (Test-Path -LiteralPath $sc.source)) { throw ('restore-diagnostic:' + $json) }
}
R1 'M4-restore-expected-refusal-keeps-code-and-identifies-stage' {
  $sc = New-R1Scenario 'm4known'
  $null = Invoke-R1Switch $sc @{} $sc.targetDir
  $script:sc = $sc
  [IO.File]::WriteAllText($sc.source, 'existing source must be preserved')
  $res = & {
    function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r1-restore-known-build'); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe') } } }
    function Remove-CompanionBuild { }
    function Invoke-CompanionStopAndFallback { }
    Invoke-CompanionWslRestore $rootR $nodeR
  }
  if ($res.restored -or $res.failed -cne 'WSL_SOURCE_EXISTS' -or $res.error.operation -cne 'check-source' -or
      [IO.File]::ReadAllText($sc.source) -cne 'existing source must be preserved' -or
      -not (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx'))) { throw 'RESTORE_REFUSAL_NOT_PRESERVED' }
}
R1 'M4-restore-missing-vhdx-reports-path-check-not-stop' {
  $sc = New-R1Scenario 'm4missing'
  $null = Invoke-R1Switch $sc @{} $sc.targetDir
  [IO.File]::Delete((Join-Path $sc.targetDir 'ext4.vhdx'))
  $res = & {
    function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r1-restore-missing-build'); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe') } } }
    function Remove-CompanionBuild { }
    function Invoke-CompanionStopAndFallback { }
    Invoke-CompanionWslRestore $rootR $nodeR
  }
  if ($res.restored -or $res.failed -cne 'WSL_VHDX_MISSING' -or $res.error.operation -cne 'check-vhdx-paths') { throw 'MISSING_VHDX_WRONG_DIAGNOSTIC_STAGE' }
}
R1 'M4-restore-same-volume-move-race-reports-move-and-retains-vhdx' {
  $sc = New-R1Scenario 'm4moverace'
  $null = Invoke-R1Switch $sc @{} $sc.targetDir
  $held = [IO.File]::Open((Join-Path $sc.targetDir 'ext4.vhdx'), 'Open', 'Read', 'Read')
  try {
    $res = & {
      function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r1-restore-move-build'); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe') } } }
      function Remove-CompanionBuild { }
      function Invoke-CompanionStopAndFallback { }
      function Wait-CompanionVhdxFree { $true } # A new holder races the preflight.
      function Test-CompanionSameVolume { $true }
      Invoke-CompanionWslRestore $rootR $nodeR
    }
    if ($res.restored -or $res.failed -cne 'WSL_RESTORE_UNEXPECTED' -or $res.error.operation -cne 'move-back' -or
        -not (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx')) -or (Test-Path -LiteralPath $sc.source)) { throw 'MOVE_RACE_WRONG_DIAGNOSTIC_OR_LOST_VHDX' }
  } finally { $held.Dispose() }
}
R1 'm2-preflight-domain-creds-and-lockout-before-the-move' {
  $p = Get-CompanionAccountPreflight $rootR $nodeR $factsR 'D:\clued-resident\wsl\CluedResident-Linux' 1 ([ordered]@{ threshold = 3; durationMinutes = 10; windowMinutes = 30 })
  if (-not (@($p.refusals) -ccontains 'COMPANION_HEADLESS_DOMAIN_CREDS_DISABLED') -or -not (@($p.refusals) -ccontains 'COMPANION_LOCKOUT_MARGIN_INSUFFICIENT')) { throw (@($p.refusals) -join ',') }
  $sc = New-R1Scenario 'm2'
  $r = Invoke-R1Switch $sc @{ lsa = 1 } $sc.targetDir
  if ($r.failed -cne 'PREFLIGHT' -or @($sc.log) -contains 'terminate' -or @($sc.log) -contains 'export:{g1}') { throw 'MOVED_DESPITE_PREFLIGHT' }
}
R1 'm3-unbuffered-rehash-through-the-registrar' {
  $f = Join-Path $Scratch 'r1-hash.bin'; $b = New-Object byte[] 5000001; (New-Object Random 3).NextBytes($b); [IO.File]::WriteAllBytes($f, $b)
  $script:CompanionRegistrarExe = Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe'
  if ((Get-CompanionFileSha256Unbuffered $f) -cne (Get-CompanionFileSha256 $f)) { throw 'HASH_DIFFERS' }
  if (-not ([IO.File]::ReadAllText((Join-Path $here 'CompanionTaskRegistrar.cs'))).Contains('0x20000000')) { throw 'NO_FILE_FLAG_NO_BUFFERING' }
}
R1 'm5-hardening-in-preflight-and-verify' {
  $f2 = $factsR.PSObject.Copy(); $f2.hardening = @('PASSWORD_EXPIRES', 'NOT_HIDDEN')
  $p = Get-CompanionAccountPreflight $rootR $nodeR $f2 'D:\clued-resident\wsl\CluedResident-Linux' 0 $lockOk
  if (-not (@($p.refusals) -ccontains 'COMPANION_ACCOUNT_NOT_HARDENED:PASSWORD_EXPIRES,NOT_HIDDEN')) { throw (@($p.refusals) -join ',') }
  $recH = [pscustomobject]@{ contract = 'clued.independent-ci.companion-account/1'; companionSid = $acctR; operatorSid = $oprR }
  $inc = "O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$acctR)"
  if ((Get-CompanionAccountProblem $nodeR $recH ([pscustomobject]@{ Enabled = $true }) @($oprR) $profR $inc @('GROUPS_NOT_USERS_ONLY')) -cne 'ACCOUNT_NOT_HARDENED:GROUPS_NOT_USERS_ONLY') { throw 'VERIFY_HARDENING' }
  if (-not (Test-Path -LiteralPath (Join-Path $here 'remove-companion-account.ps1'))) { throw 'NO_ROLLBACK_SCRIPT' }
}
R1 'm6-administrators-read-without-throwing' {
  $recH = [pscustomobject]@{ contract = 'clued.independent-ci.companion-account/1'; companionSid = $acctR; operatorSid = $oprR }
  $inc = "O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$acctR)"
  if ((Get-CompanionAccountProblem $nodeR $recH ([pscustomobject]@{ Enabled = $true }) $null $profR $inc @()) -cne 'ADMINISTRATORS_UNREADABLE') { throw 'UNREADABLE_SEEN_AS_ADMIN' }
  foreach ($file in @('install-resident.ps1', 'verify-resident.ps1', 'companion-headless.ps1')) { if ((& $codeOf $texts[$file]).Contains('Get-LocalGroupMember')) { throw ('GET_LOCALGROUPMEMBER:' + $file) } }
  if (-not $functions.ContainsKey('install-resident.ps1:Get-AdministratorSids') -or $functions['install-resident.ps1:Get-AdministratorSids'] -cne $functions['companion-headless.ps1:Get-AdministratorSids']) { throw 'NOT_SHARED' }
}
R1 'm7-m8-m4-registrar-source' {
  $cs = [IO.File]::ReadAllText((Join-Path $here 'CompanionTaskRegistrar.cs'))
  if ($cs.Contains('CoInitializeEx') -or $cs.Contains('CoInitializeSecurity')) { throw 'M7' }
  if (-not ([regex]::IsMatch($cs, 'IntPtr pFolder = Qi\(folder, IidTaskFolder\);\s*try \{'))) { throw 'M8' }
  $np = [regex]::Match($cs, '(?s)static IntPtr NewRandomPassword\(\).*?\n  \}').Value
  if (-not $np.Contains('BCryptGenRandom') -or $np.Contains('new byte[')) { throw 'M4' }
}
R1 'm9-system-once-stops-a-running-instance' {
  $f = $functions['install-resident.ps1:Invoke-AsSystemOnce']
  if (-not $f.Contains('INSTALL_SYSTEM_ONCE_TIMEOUT') -or $f.IndexOf('.Stop(0)') -lt 0 -or $f.IndexOf('.Stop(0)') -gt $f.LastIndexOf('DeleteTask')) { throw 'M9' }
}
R1 'm10-m11-runbook-real-machine-steps' {
  $rb = [IO.File]::ReadAllText((Join-Path $here '..\rollout\M5-COMPANION-HEADLESS-RUNBOOK.md'))
  foreach ($k in @('T10', 'T11', 'DefaultUid')) { if (-not $rb.Contains($k)) { throw ('RUNBOOK:' + $k) } }
}
R1 'm12-prepare-checks-the-pinned-registrar-hash' {
  $pr = $texts['prepare-companion-account.ps1']
  if (-not $pr.Contains('[Parameter(Mandatory)][ValidatePattern(''^[0-9a-f]{64}$'')][string]$RegistrarSha256') -or -not $pr.Contains("throw 'REGISTRAR_SOURCE_NOT_THE_PINNED_ONE'")) { throw 'M12' }
}
R1 'M2-registrar-flow-behaviour' {
  $out = & (Join-Path $Scratch 'registrar-pure.exe') | Out-String
  if ($out -notmatch 'REGISTRAR_PURE_PASS' -or -not ([IO.File]::ReadAllText((Join-Path $here 'RegistrarPureTests.cs'))).Contains('password-flow-register-fails-parks')) { throw 'NO_FLOW_TESTS' }
}
$r1Failed = @($r1.Keys | Where-Object { $r1[$_] -ne 'pass' })
if ($r1Failed.Count) { $r1 | ConvertTo-Json | Write-Host }
Yes ($r1Failed.Count -eq 0) ('review-r1:' + ($r1Failed -join ','))
$n += $r1.Count

# 11. M5-b re-review r2 (N1, n2-n7): tests written before the fixes; each reported on its own.
$r2 = [ordered]@{}
function R2([string]$id, [scriptblock]$body) { try { $null = & $body; $script:r2[$id] = 'pass' } catch { $script:r2[$id] = 'FAIL: ' + $_.Exception.Message } }
# A moved scenario: the record says qualified, the vhdx is in the target, the source folder empty.
function New-R2Moved([string]$name, [string]$stage = 'qualified') {
  $sc = New-R1Scenario $name
  $null = Invoke-R1Switch $sc @{} $sc.targetDir
  if ($stage -cne 'qualified') { $rec = ConvertTo-CompanionOrdered (Read-CompanionWslRecord $rootR); $rec.stage = $stage; Write-CompanionWslRecord $rootR $rec }
  $sc
}
# Real move/copy/restore/record code over scratch files, with only platform ACL,
# registry, task and binary-build operations replaced. New restore helpers run.
function Invoke-R2RestoreFixture($scenario) {
  $script:sc = $scenario; $script:restoreLeafAcl = Get-CompanionVhdxSddl $acctR
  & {
    function New-CompanionBuild { [ordered]@{ directory = (Join-Path $Scratch 'r2-cycle-build'); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe') } } }
    function Remove-CompanionBuild { }
    function Get-WslRegistrations { @() }
    function Import-CompanionLxssKey { $script:sc.keyPresent = $true }
    function Invoke-CompanionStopAndFallback { }
    function Test-CompanionSameVolume { $false }
    function Set-CompanionOwnerFileAcl { }
    function Get-CompanionDirSddl([string]$path) { if ($path -ieq $script:sc.targetDir) { $script:restoreLeafAcl } else { $CompanionVhdxParentSddl } }
    function Set-CompanionRestoreTargetAcl([string]$dir) { if ($dir -ine $script:sc.targetDir) { throw 'UNEXPECTED_RESTORE_ACL_TARGET' }; $script:restoreLeafAcl = $CompanionRestoredVhdxSddl }
    Invoke-CompanionWslRestore $rootR $nodeR
  }
}
R2 'restore-move-restore-retains-exact-record-creation-proof' {
  $sc = New-R1Scenario 'twice'
  $one = Invoke-R1Switch $sc @{} $sc.targetDir
  if (-not $one.qualified) { throw ('FIRST_MOVE:' + $one.failed) }
  $proof = @((Read-CompanionWslRecord $rootR).parentsCreated)
  if ($proof -inotcontains $sc.targetDir) { throw 'FIRST_PROOF_MISSING' }
  $one = Invoke-R2RestoreFixture $sc
  if (-not $one.restored) { throw ('FIRST_RESTORE:' + $one.failed) }
  $two = Invoke-R1Switch $sc @{} $sc.targetDir
  if (-not $two.qualified) { throw ('SECOND_MOVE:' + $two.failed) }
  if (@((Read-CompanionWslRecord $rootR).parentsCreated) -inotcontains $sc.targetDir) { throw 'SECOND_MOVE_ERASED_PROOF' }
  $two = Invoke-R2RestoreFixture $sc
  if (-not $two.restored -or $two.record.restoreTargetDirectory.status -cne 'REUSABLE' -or (Get-CompanionFileSha256 $sc.source) -cne $sc.sha) { throw ('SECOND_RESTORE:' + $two.failed) }
}
R2 'copied-cut-persists-proof-before-copy-and-restores-after-resume' {
  $sc = New-R1Scenario 'proof-cut'; $script:sc = $sc
  $script:realWriteWslRecord = ${function:Write-CompanionWslRecord}
  $script:realCopyVerified = ${function:Copy-CompanionFileVerified}
  $platform = {
    function Get-WslRegistrations { @([ordered]@{ guid = '{g1}'; name = 'CluedResident-Linux'; basePath = $script:sc.sourceDir; values = [ordered]@{ DefaultUid = 0 } }) }
    function Export-CompanionLxssKey($g, $f) { [IO.File]::WriteAllText($f, 'x') }
    function Invoke-CompanionWslTerminate { }
    function Test-CompanionSameVolume { $false }
    function Get-CompanionDirSddl { $CompanionVhdxParentSddl }
    function New-CompanionProtectedDirectory($p, $s) { [void][IO.Directory]::CreateDirectory($p) }
    function Set-CompanionVhdxAcl { }
    function Get-CompanionFileSha256Unbuffered($p) { Get-CompanionFileSha256 $p }
  }
  $cut = & {
    . $platform
    function Copy-CompanionFileVerified($source, $partial, $progress) {
      if (@((Read-CompanionWslRecord $rootR).parentsCreated) -inotcontains $script:sc.targetDir) { throw 'COPY_BEFORE_PROOF_PERSISTED' }
      & $script:realCopyVerified $source $partial $progress
    }
    function Write-CompanionWslRecord($root, $record) { & $script:realWriteWslRecord $root $record; if ($record.stage -ceq 'copied') { throw 'SIMULATED_COPIED_CUT' } }
    try { $null = Invoke-CompanionWslMove $rootR 'CluedResident-Linux' $sc.targetDir $acctR; 'NO_CUT' } catch { [string]$_.Exception.Message }
  }
  if ($cut -cne 'SIMULATED_COPIED_CUT') { throw ('CUT:' + $cut) }
  $rec = Read-CompanionWslRecord $rootR
  if ($rec.stage -cne 'copied' -or @($rec.parentsCreated) -inotcontains $sc.targetDir -or -not (Test-Path -LiteralPath ($sc.targetDir + '\ext4.vhdx.partial'))) { throw 'CUT_PROOF_OR_PARTIAL_MISSING' }
  $rec = & { . $platform; Invoke-CompanionWslMove $rootR 'CluedResident-Linux' $sc.targetDir $acctR }
  if ($rec.stage -cne 'moved' -or @($rec.parentsCreated) -inotcontains $sc.targetDir) { throw 'RESUME_LOST_PROOF' }
  $res = Invoke-R2RestoreFixture $sc
  if (-not $res.restored -or (Get-CompanionFileSha256 $sc.source) -cne $sc.sha) { throw ('COPIED_RESTORE:' + $res.failed) }
}
R2 'N1-restore-across-volumes-builds-its-own-hash-tool' {
  $sc = New-R2Moved 'n1'; $script:sc = $sc; $script:built = 0; $script:removed = 0
  $res = & {
    $script:restoreLeafAcl = Get-CompanionVhdxSddl $acctR
    function Get-CompanionDirSddl([string]$path) { if ($path -ieq $script:sc.targetDir) { $script:restoreLeafAcl } else { $CompanionVhdxParentSddl } }
    function Set-CompanionRestoreTargetAcl([string]$dir) { if ($dir -ine $script:sc.targetDir) { throw 'UNEXPECTED_RESTORE_ACL_TARGET' }; $script:restoreLeafAcl = $CompanionRestoredVhdxSddl; [void]$script:sc.log.Add('restore-leaf-acl') }
    function New-CompanionBuild { $script:built++; [ordered]@{ directory = (Join-Path $Scratch 'r2-build'); generation = ('a' * 64); registrar = [ordered]@{ exe = (Join-Path $Scratch 'bin\CluedCompanionTaskRegistrar.exe'); sourceSha256 = ('b' * 64); sha256 = ('c' * 64) } } }
    function Remove-CompanionBuild { $script:removed++ }
    function Get-WslRegistrations { @() }; function Import-CompanionLxssKey($f) { [void]$script:sc.log.Add('import-key') }; function Invoke-CompanionStopAndFallback { }
    function Test-CompanionSameVolume { $false }; function Set-CompanionOwnerFileAcl { }
    $script:CompanionRegistrarExe = $null
    Invoke-CompanionWslRestore $rootR $nodeR }
  if (-not $res.restored) { throw ('not-restored:' + $res.failed) }
  if ((Get-CompanionFileSha256 $sc.source) -cne $sc.sha -or $script:built -ne 1 -or $script:removed -ne 1 -or $null -ne $script:CompanionRegistrarExe) { throw 'BUILD_OR_HASH' }
}
R2 'n2-runbook-restart-when-the-account-vm-holds-the-vhdx' {
  $rb = [IO.File]::ReadAllText((Join-Path $here '..\rollout\M5-COMPANION-HEADLESS-RUNBOOK.md'))
  if (-not $rb.Contains('T13') -or -not $rb.Contains('WSL_VHDX_STILL_IN_USE')) { throw 'RUNBOOK' }
}
R2 'n3-restore-refuses-while-a-switch-runs' {
  $sc = New-R2Moved 'n3'; $script:sc = $sc
  Write-CompanionPending $rootR 'account' $acctR
  try {
    $res = & { function New-CompanionBuild { throw 'SHOULD_NOT_BUILD' }; function Invoke-CompanionStopAndFallback { [void]$script:sc.log.Add('stopped') }; Invoke-CompanionWslRestore $rootR $nodeR }
    if ($res.restored -or $res.failed -cne 'COMPANION_HEADLESS_SWITCH_IN_PROGRESS' -or @($sc.log) -contains 'stopped' -or -not (Test-Path -LiteralPath (Join-Path $sc.targetDir 'ext4.vhdx'))) { throw ('got:' + $res.failed) }
  } finally { Remove-Item -LiteralPath (Join-Path $rootR $CompanionPendingFile) -Force -ErrorAction SilentlyContinue }
}
R2 'n4-copied-stage-resumes-a-cut-between-rename-and-delete' {
  $sc = New-R1Scenario 'n4'
  $script:sc = $sc
  $stubs = { function Get-WslRegistrations { @([ordered]@{ guid = '{g1}'; name = 'CluedResident-Linux'; basePath = $script:sc.sourceDir; values = [ordered]@{ DefaultUid = 0 } }) }
    function Export-CompanionLxssKey($g, $f) { [IO.File]::WriteAllText($f, 'x') }; function Invoke-CompanionWslTerminate { }; function Test-CompanionSameVolume { $false }
    function Get-CompanionDirSddl { $CompanionVhdxParentSddl.Replace('O:BAG:BAD:', 'O:BAG:SYD:') }; function New-CompanionProtectedDirectory($p, $s) { [void][IO.Directory]::CreateDirectory($p) }
    function Set-CompanionVhdxAcl { }; function Get-CompanionFileSha256Unbuffered($p) { Get-CompanionFileSha256 $p } }
  # the state a cut leaves: both files there, the record at 'copied' with the hashes
  [void][IO.Directory]::CreateDirectory($sc.targetDir); Copy-Item -LiteralPath $sc.source -Destination (Join-Path $sc.targetDir 'ext4.vhdx')
  Write-CompanionWslRecord $rootR ([ordered]@{ contract = $CompanionWslContract; distro = 'CluedResident-Linux'; target = (Join-Path $sc.targetDir 'ext4.vhdx'); companionSid = $acctR; stage = 'copied'; imported = $false
    source = $sc.source; ownerRegistration = [ordered]@{ guid = '{g1}'; values = [ordered]@{ DefaultUid = 0 } }; ownerExport = (Join-Path $rootR 'install\x.reg'); copy = [ordered]@{ sourceSha256 = $sc.sha; targetSha256 = $sc.sha; length = 3145730 } })
  $rec = & { . $stubs; Invoke-CompanionWslMove $rootR 'CluedResident-Linux' $sc.targetDir $acctR }
  if ($rec.stage -cne 'moved' -or (Test-Path -LiteralPath $sc.source) -or (Get-CompanionFileSha256 (Join-Path $sc.targetDir 'ext4.vhdx')) -cne $sc.sha) { throw ('both-files:' + $rec.stage) }
  # the other cut: the partial is complete, not renamed yet
  $sc2 = New-R1Scenario 'n4b'; $script:sc = $sc2
  [void][IO.Directory]::CreateDirectory($sc2.targetDir); Copy-Item -LiteralPath $sc2.source -Destination (Join-Path $sc2.targetDir 'ext4.vhdx.partial')
  Write-CompanionWslRecord $rootR ([ordered]@{ contract = $CompanionWslContract; distro = 'CluedResident-Linux'; target = (Join-Path $sc2.targetDir 'ext4.vhdx'); companionSid = $acctR; stage = 'copied'; imported = $false
    source = $sc2.source; ownerRegistration = [ordered]@{ guid = '{g1}'; values = [ordered]@{ DefaultUid = 0 } }; ownerExport = (Join-Path $rootR 'install\x.reg'); copy = [ordered]@{ sourceSha256 = $sc2.sha; targetSha256 = $sc2.sha; length = 3145730 } })
  $rec = & { . $stubs; Invoke-CompanionWslMove $rootR 'CluedResident-Linux' $sc2.targetDir $acctR }
  if ($rec.stage -cne 'moved' -or (Test-Path -LiteralPath $sc2.source) -or (Test-Path -LiteralPath (Join-Path $sc2.targetDir 'ext4.vhdx.partial')) -or (Get-CompanionFileSha256 (Join-Path $sc2.targetDir 'ext4.vhdx')) -cne $sc2.sha) { throw ('partial:' + $rec.stage) }
  $mv2 = $functions['companion-headless.ps1:Invoke-CompanionWslMove']
  if ($mv2.IndexOf("'copied'") -lt 0 -or $mv2.IndexOf("'copied'") -gt $mv2.IndexOf('[IO.File]::Move($partial, $target)')) { throw 'COPIED_NOT_RECORDED_BEFORE_THE_RENAME' }
}
R2 'n5-hash-tool-gets-a-cleared-environment' {
  $f = $functions['companion-headless.ps1:Get-CompanionFileSha256Unbuffered']
  if (-not $f.Contains('$psi.EnvironmentVariables.Clear()')) { throw 'ENV_NOT_CLEARED' }
}
R2 'n6-lsa-remove-all-is-one-byte' {
  if (-not ([IO.File]::ReadAllText((Join-Path $here 'CompanionTaskRegistrar.cs'))).Contains('[MarshalAs(UnmanagedType.U1)] bool all')) { throw 'NOT_U1' }
}
R2 'n7-uninstall-refuses-an-unfinished-move' {
  $u = $texts['uninstall-resident.ps1']
  if (-not $functions.ContainsKey('uninstall-resident.ps1:Get-CompanionWslUnfinished')) { throw 'NO_FUNCTION' }
  . ([scriptblock]::Create($functions['uninstall-resident.ps1:Get-CompanionWslUnfinished']))
  $ur = Join-Path $Scratch 'r2-uninstall'; [void][IO.Directory]::CreateDirectory((Join-Path $ur 'install'))
  if ($null -ne (Get-CompanionWslUnfinished $ur)) { throw 'NO_RECORD_SEEN_AS_UNFINISHED' }
  foreach ($st in @('exported', 'copied', 'moved', 'imported', 'forgotten')) { [IO.File]::WriteAllText((Join-Path $ur 'install\companion-wsl.json'), ('{"stage":"' + $st + '"}')); if ((Get-CompanionWslUnfinished $ur) -cne $st) { throw ('NOT_REFUSED:' + $st) } }
  foreach ($st in @('qualified', 'restored')) { [IO.File]::WriteAllText((Join-Path $ur 'install\companion-wsl.json'), ('{"stage":"' + $st + '"}')); if ($null -ne (Get-CompanionWslUnfinished $ur)) { throw ('REFUSED:' + $st) } }
  [IO.File]::WriteAllText((Join-Path $ur 'install\companion-wsl.json'), 'not json'); if ((Get-CompanionWslUnfinished $ur) -cne 'unreadable') { throw 'UNREADABLE_ACCEPTED' }
  $i = $u.IndexOf("throw ('COMPANION_WSL_MOVE_UNFINISHED:'")
  if ($i -lt 0 -or $i -gt $u.IndexOf('UPGRADER_STILL_RUNNING_NOTHING_REMOVED')) { throw 'NOT_BEFORE_ANY_CHANGE' }
}

# A restart after a verified copy must not delete a source changed in between.
R2 'm5b-copied-source-changed-is-never-deleted' {
  $sc = New-R1Scenario 'm5b-source-changed'; $script:sc = $sc
  [void][IO.Directory]::CreateDirectory($sc.targetDir)
  Copy-Item -LiteralPath $sc.source -Destination (Join-Path $sc.targetDir 'ext4.vhdx')
  [IO.File]::WriteAllText($sc.source, 'NEW_OWNER_DATA')
  Write-CompanionWslRecord $rootR ([ordered]@{ contract = $CompanionWslContract; distro = 'CluedResident-Linux'; target = (Join-Path $sc.targetDir 'ext4.vhdx'); companionSid = $acctR; stage = 'copied'; imported = $false
    source = $sc.source; ownerRegistration = [ordered]@{ guid = '{g1}'; values = [ordered]@{ DefaultUid = 0 } }; ownerExport = (Join-Path $rootR 'install\x.reg'); copy = [ordered]@{ sourceSha256 = $sc.sha; targetSha256 = $sc.sha; length = 3145730 } })
  $refused = & {
    function Invoke-CompanionWslTerminate { }
    function Wait-CompanionVhdxFree { $true }
    function Get-CompanionFileSha256Unbuffered($path) { Get-CompanionFileSha256 $path }
    try { Invoke-CompanionWslMove $rootR 'CluedResident-Linux' $sc.targetDir $acctR | Out-Null; $false }
    catch { $_.Exception.Message -ceq 'WSL_COPY_SOURCE_CHANGED' }
  }
  if (-not $refused -or -not (Test-Path -LiteralPath $sc.source) -or [IO.File]::ReadAllText($sc.source) -cne 'NEW_OWNER_DATA') { throw 'CHANGED_SOURCE_WAS_NOT_PRESERVED' }
  if ((Get-CompanionFileSha256 (Join-Path $sc.targetDir 'ext4.vhdx')) -cne $sc.sha) { throw 'VERIFIED_COPY_CHANGED' }
}

$r2Failed = @($r2.Keys | Where-Object { $r2[$_] -ne 'pass' })
if ($r2Failed.Count) { $r2 | ConvertTo-Json | Write-Host }
Yes ($r2Failed.Count -eq 0) ('review-r2:' + ($r2Failed -join ','))
$n += $r2.Count

$leafOutput = @(& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $here 'test-vhdx-file-acl.ps1') -Scratch (Join-Path $Scratch 'vhdx-leaf-access'))
Yes ($LASTEXITCODE -eq 0 -and $leafOutput.Count -eq 1) 'real-file-acl-fixture-exit'
$leafResult = $leafOutput[0] | ConvertFrom-Json
Yes ($leafResult.status -ceq 'VHDX_FILE_ACL_FIXTURE_PASS' -and -not $leafResult.wslExecuted -and $leafResult.accountTaskServiceEffects -eq 0) 'real-file-acl-fixture-isolated'
$n += [int]$leafResult.assertions
$maintenanceOutput = @(& 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $here 'test-companion-maintenance-switch.ps1') -Scratch (Join-Path $Scratch 'maintenance-switch'))
Yes ($LASTEXITCODE -eq 0 -and $maintenanceOutput.Count -eq 1) 'maintenance-switch-fixture-exit'
$maintenanceResult = $maintenanceOutput[0] | ConvertFrom-Json
Yes ($maintenanceResult.status -ceq 'MAINTENANCE_SWITCH_OFFLINE_PASS' -and $maintenanceResult.scmTaskWslEffects -eq 0) 'maintenance-switch-fixture-isolated'
$n += [int]$maintenanceResult.assertions

[ordered]@{ status = 'COMPANION_HEADLESS_WINDOWS_OFFLINE_PASS'; assertions = $n; supervisorCsharpAssertions = $supervisorCsharp; registrarCsharpAssertions = $registrarCsharp; pinvokeBound = $pinvokeBound; gitconfigNode = $nodeText; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
