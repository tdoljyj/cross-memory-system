<#
  Offline checks of M5, the companion without the Owner's log-on (DESIGN.md section 65.7). Nothing on the host is read or changed: no
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
foreach ($file in @('companion-headless.ps1', 'install-resident.ps1', 'upgrade-apply.ps1', 'verify-resident.ps1', 'rearm-resident.ps1', 'uninstall-resident.ps1', 'companion-gh-login.ps1', 'probe-companion-headless.ps1', 'companion-headless-fallback.ps1')) {
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
foreach ($name in $sharedUpgrade) { Yes ($functions.ContainsKey('upgrade-apply.ps1:' + $name) -and $functions['upgrade-apply.ps1:' + $name] -ceq $functions['companion-headless.ps1:' + $name]) ('shared-upgrade:' + $name) }
foreach ($name in @($sharedUpgrade + 'Register-CompanionTaskInteractive')) { Yes ($functions.ContainsKey('install-resident.ps1:' + $name) -and $functions['install-resident.ps1:' + $name] -ceq $functions['companion-headless.ps1:' + $name]) ('shared-install:' + $name) }
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
# the lockout rule (DESIGN 65.4.1): threshold 0, or >= 6 with a window under 15 minutes
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

# 4. Order of the switch (DESIGN 65.4.4) and the fall-back (T6), by the code.
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
$rearm = $texts['rearm-resident.ps1']
Yes ($rearm.Contains("throw 'OWNER_ACCOUNT_REQUIRED'") -and $rearm.Contains("[switch]`$CompanionHeadless, [switch]`$CompanionCredential, [switch]`$CompanionInteractive") -and $rearm.Contains("if (-not `$elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }")) 'rearm-owner-elevated-only'

# 5. The password never in PowerShell (DESIGN 65.4.4, T8).
foreach ($file in @('companion-headless.ps1', 'rearm-resident.ps1', 'install-resident.ps1', 'upgrade-apply.ps1', 'verify-resident.ps1', 'uninstall-resident.ps1', 'probe-companion-headless.ps1', 'companion-headless-fallback.ps1')) {
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
Yes ($login.Contains("throw 'RUN_NOT_ELEVATED_IN_YOUR_OWN_WINDOW'") -and $login.Contains("throw 'CLIPBOARD_IS_NOT_A_FINE_GRAINED_TOKEN'") -and -not $login.Contains('auth login') -and -not $login.Contains('auth token')) 'gh-login-owner-only-no-shared-keyring'
Yes ($login.Contains('[Windows.Forms.Clipboard]::Clear()') -and $login.Contains('ClearHistory()') -and $login.Contains('$token = $null')) 'gh-login-clears-the-clipboard-and-its-history'
# review MINOR 13: the token is never an argument of a PowerShell function or cmdlet (only of .NET methods)
Yes (-not ([regex]::IsMatch($login, '(?m)^\s*[A-Z][A-Za-z]+-[A-Za-z]+\b[^\r\n]*\$token\b')) -and -not $login.Contains('Test-FineGrainedToken')) 'gh-login-token-only-in-dotnet-calls'

# 8. The probe writes nothing (read-only by construction).
$probe = & $codeOf $texts['probe-companion-headless.ps1']
foreach ($bad in @('Set-Content', 'Set-Acl', 'Set-Item', 'Set-Service', 'Set-ScheduledTask', 'Set-Clipboard', 'New-Item', 'Remove-', 'Register-', 'Unregister-', 'Stop-', 'Start-Process', 'Out-File', 'Add-Content', 'WriteAll', '::Move', '::Replace(', 'schtasks', 'Restart-', 'icacls', 'reg.exe', '.Run(')) { Yes (-not $probe.Contains($bad)) ('probe-read-only:' + $bad) }

[ordered]@{ status = 'COMPANION_HEADLESS_WINDOWS_OFFLINE_PASS'; assertions = $n; supervisorCsharpAssertions = $supervisorCsharp; registrarCsharpAssertions = $registrarCsharp; gitconfigNode = $nodeText; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
