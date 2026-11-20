<#
  Offline checks of the companion job host (DESIGN §24, Task 8e1f07d3). Nothing on the host is read or changed:
  - CompanionJobHost.cs is compiled with the in-box csc, with the install's flags, into the NEW scratch directory
    given by the caller;
  - the host refuses malformed arguments before it starts anything (exit 120 and its report line);
  - test/job-host.test.mjs runs with CLUED_JOB_HOST_EXE set to the compiled host, which adds the live cases: output and
    exit code pass through, arguments arrive exactly, a child and its grandchildren (also a detached one) past the limit
    or left behind are ended, a process outside the job lives on, and a git fetch hanging on a silent local server is
    ended whole at the limit. -Wsl adds the companion's real wsl, powershell and git chains (needs Ubuntu-24.04).
  powershell -NoProfile -File test-job-host.ps1 -Scratch <new empty directory> [-Node <node.exe>] [-Wsl]
#>
param([Parameter(Mandatory)][string]$Scratch, [string]$Node = 'node', [switch]$Wsl)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Scratch) { if (@(Get-ChildItem -LiteralPath $Scratch -Force).Count) { throw 'EMPTY_SCRATCH_REQUIRED' } } else { [void][IO.Directory]::CreateDirectory($Scratch) }
$here = $PSScriptRoot
$n = 0
function Yes([bool]$ok, [string]$what) { if (-not $ok) { throw ('FAILED:' + $what) }; $script:n++ }
# H1, one rule for every child a package script starts (first-install-host.ps1's own; test/native-child.test.mjs holds every copy the same
# text and no package .ps1 merging a stream into its output): stdout, stderr and the exit code read apart; never an error from stderr.
function Invoke-NativeChild([string]$exe, [string[]]$arguments, [int]$seconds = 3600, [Text.Encoding]$encoding = (New-Object Text.UTF8Encoding($false)), [bool]$shareConsole = $false, [byte[]]$stdin = $null) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = ($null -ne $stdin); $psi.CreateNoWindow = (-not $shareConsole)
  $psi.StandardOutputEncoding = $encoding; $psi.StandardErrorEncoding = $encoding
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if ($null -ne $stdin) { try { $p.StandardInput.BaseStream.Write($stdin, 0, $stdin.Length); $p.StandardInput.BaseStream.Flush() } finally { $p.StandardInput.Close() } }   # a secret: never a command line
  if (-not $p.WaitForExit($seconds * 1000)) { return [ordered]@{ exit = $null; stdout = ''; stderr = ''; timedOut = $true } }
  $p.WaitForExit()   # the asynchronous reads end with the child
  $tail = { param($t) $t = ([string]$t) -replace "`0", ''; if ($t.Length -gt 1500) { $t.Substring($t.Length - 1500) } else { $t } }
  [ordered]@{ exit = $p.ExitCode; stdout = ([string]$o.Result -replace "`0", ''); stderr = (& $tail $e.Result); timedOut = $false }
}

foreach ($file in @('test-job-host.ps1', 'install-resident.ps1', 'verify-resident.ps1')) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $here $file), [ref]$tokens, [ref]$errors)
  Yes ($errors.Count -eq 0) ('parse:' + $file)
}
# The installer compiles the host with exactly the flags used below, from the installed resident copy, and pins it; verify checks the pin.
$install = [IO.File]::ReadAllText((Join-Path $here 'install-resident.ps1'))
Yes ($install.Contains('& $Csc /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" ("/out:" + $jobHost) (Join-Path $Root (''resident\'' + $plan.residentManifestSha256 + ''\windows\CompanionJobHost.cs''))')) 'install-compiles-host'
Yes ($install.Contains('$script:receipt.companionJobHostSha256 = Sha256File $jobHost') -and $install.Contains("`$CompanionJobHost = 'CluedCompanionJobHost.exe'")) 'install-pins-host'
Yes ([IO.File]::ReadAllText((Join-Path $here 'verify-resident.ps1')).Contains("Record 'companion-job-host-pin' ((`$receipt.PSObject.Properties.Name -ccontains 'companionJobHostSha256') -and (Test-Path -LiteralPath `$jobHost -PathType Leaf) -and ((Sha256File `$jobHost) -ceq [string]`$receipt.companionJobHostSha256))")) 'verify-checks-host-pin'
Yes ([IO.File]::ReadAllText((Join-Path $here 'uninstall-resident.ps1')).Contains("(Join-Path `$Root 'bin\CluedCompanionJobHost.exe')")) 'uninstall-waits-for-hosts'
foreach ($file in @('uninstall-resident.ps1')) {
  $tokens = $null; $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $here $file), [ref]$tokens, [ref]$errors)
  Yes ($errors.Count -eq 0) ('parse:' + $file)
}

# 1. Compile exactly as install-resident.ps1 does (winexe: never a console window of its own).
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
$hostExe = Join-Path $Scratch 'CluedCompanionJobHost.exe'
& (Join-Path $fw 'csc.exe') /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" ('/out:' + $hostExe) (Join-Path $here 'CompanionJobHost.cs') | Out-Null
Yes ($LASTEXITCODE -eq 0) 'compile'

# 2. Refusals before anything starts: exit 120 and a report that no child ran.
function Invoke-Host([string[]]$HostArgs) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $hostExe
  $psi.Arguments = (@($HostArgs | ForEach-Object { if ($_ -match '\s' -or $_.Length -eq 0) { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync(); $p.WaitForExit()
  return [pscustomobject]@{ code = $p.ExitCode; stdout = $out.Result; stderr = $err.Result }
}
$nonce = '0123456789abcdef0123456789abcdef'
$node = (Get-Command $Node -ErrorAction Stop).Source
foreach ($case in @(
    @('bad-nonce', @('XYZ', '5000', $node, '-e', '0')),
    @('short-limit', @($nonce, '999', $node, '-e', '0')),
    @('long-limit', @($nonce, '3600001', $node, '-e', '0')),
    @('relative-application', @($nonce, '5000', 'node.exe', '-e', '0')),
    @('missing-application', @($nonce, '5000', (Join-Path $Scratch 'absent.exe'))),
    @('no-application', @($nonce, '5000')))) {
  $r = Invoke-Host $case[1]
  Yes ($r.code -eq 120) ('refused-exit:' + $case[0])
  $line = @($r.stderr.Trim() -split "`n")[-1]
  Yes ($line -match '^clued-job-host \S+ \{.*"started":false.*\}$') ('refused-report:' + $case[0])
  Yes ($r.stdout.Length -eq 0) ('refused-silent:' + $case[0])
}
$ok = Invoke-Host @($nonce, '5000', $node, '-e', 'process.stdout.write(process.argv.slice(1).join(''|''));process.exit(9)', 'x y', 'z')
Yes ($ok.code -eq 9 -and $ok.stdout -ceq 'x y|z') 'pass-through'
Yes ((@($ok.stderr.Trim() -split "`n")[-1]) -match ('^clued-job-host ' + $nonce + ' \{.*"started":true.*"timedOut":false,"exitCode":9.*"treeZero":true\}$')) 'pass-through-report'

# 3. The node suite with the live cases against the compiled host.
$env:CLUED_JOB_HOST_EXE = $hostExe
$env:CLUED_JOB_HOST_WSL = $(if ($Wsl) { '1' } else { '0' })
$suite = Join-Path (Split-Path -Parent $here) 'test\job-host.test.mjs'
$suiteRun = Invoke-NativeChild $node @('--test', $suite) 3600
$lines = @(([string]$suiteRun.stdout + "`n" + [string]$suiteRun.stderr) -split "`r?`n")
Yes ($suiteRun.exit -eq 0) ('node-suite:' + (($lines | Select-Object -Last 30) -join "`n"))
function Skipped([string]$text) { $m = [regex]::Match($text, '(?m)^\S+ skipped (\d+)\s*$'); if (-not $m.Success) { throw 'FAILED:skipped-count-not-found' }; return [int]$m.Groups[1].Value }
Yes ((Skipped ($lines -join "`n")) -eq $(if ($Wsl) { 0 } else { 1 })) 'live-cases-ran'

# 4. The live cases again, nested: node itself runs inside an outer job host's job (no breakaway, as under the companion's
#    scheduled task), so every inner host must create its child inside that job's hierarchy.
$nested = Invoke-Host @('fedcba9876543210fedcba9876543210', '600000', $node, '--test', '--test-name-pattern=^live', $suite)
Yes ($nested.code -eq 0) ('nested-suite:' + (($nested.stdout -split "`n" | Select-Object -Last 30) -join "`n"))
Yes ((@($nested.stderr.Trim() -split "`n")[-1]) -match '^clued-job-host fedcba9876543210fedcba9876543210 \{.*"timedOut":false,"exitCode":0.*"treeZero":true\}$') 'nested-outer-report'
Yes ((Skipped $nested.stdout) -eq $(if ($Wsl) { 0 } else { 1 })) 'nested-live-cases-ran'
$n++
[pscustomobject]@{ status = 'COMPANION_JOB_HOST_OFFLINE_PASS'; checks = $n; wsl = [bool]$Wsl; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
