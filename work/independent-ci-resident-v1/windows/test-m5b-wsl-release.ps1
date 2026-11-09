<# Offline M5-b VM release checks. AST-loaded functions and fake transports only. #>
param([switch]$InheritedPipeProbe)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'companion-headless.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'SOURCE_PARSE_FAILED' }
$definitions = @{}
foreach ($f in $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $definitions[$f.Name] = $f.Extent.Text }
if ($InheritedPipeProbe) {
  # The real transport body sees an exited client while an inherited output
  # pipe never reaches EOF. No actual process or WSL command is started.
  $script:m5bNever = New-Object 'Threading.Tasks.TaskCompletionSource[string]'
  $script:m5bDone = New-Object 'Threading.Tasks.TaskCompletionSource[string]'
  $script:m5bDone.SetResult('')
  $out = New-Object PSObject
  $out | Add-Member ScriptMethod ReadToEndAsync { $script:m5bNever.Task }
  $err = New-Object PSObject
  $err | Add-Member ScriptMethod ReadToEndAsync { $script:m5bDone.Task }
  $script:m5bFake = New-Object PSObject -Property @{ StartInfo = $null; StandardOutput = $out; StandardError = $err; ExitCode = 0 }
  $script:m5bFake | Add-Member ScriptMethod Start { $true }
  $script:m5bFake | Add-Member ScriptMethod WaitForExit { param($milliseconds) $true }
  $script:m5bFake | Add-Member ScriptMethod Dispose { }
  function New-Object { param([string]$TypeName)
    if ($TypeName -ceq 'Diagnostics.Process') { return $script:m5bFake }
    Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName
  }
  $CompanionInjectVariables = '^M5B_TEST_UNUSED$'
  . ([scriptblock]::Create($definitions['Invoke-CompanionWslControl']))
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $r = Invoke-CompanionWslControl 'list-running'
  if ($r.completed -or $watch.ElapsedMilliseconds -gt 4000) { throw 'INHERITED_PIPE_TIMEOUT_NOT_ENFORCED' }
  [ordered]@{ result = 'PASS'; boundedInheritedPipe = $true; elapsedMs = $watch.ElapsedMilliseconds; actualWslCalls = 0 } | ConvertTo-Json -Compress
  exit 0
}
foreach ($name in @('Get-CompanionRunningWslDistros', 'Assert-CompanionWslVhdxReleased')) {
  if (-not $definitions.ContainsKey($name)) { throw ('MISSING_M5B_RELEASE_IMPLEMENTATION:' + $name) }
  . ([scriptblock]::Create($definitions[$name]))
}
$script:checks = 0
function Check([bool]$ok, [string]$name) { if (-not $ok) { throw ('FAILED:' + $name) }; $script:checks++ }
function Refuses([scriptblock]$run, [string]$reason) {
  try { & $run | Out-Null; return $false } catch { return $_.Exception.Message -ceq $reason }
}
function Reset-Case {
  $script:free = New-Object 'Collections.Generic.Queue[bool]'
  $script:responses = New-Object 'Collections.Generic.Queue[object]'
  $script:calls = New-Object 'Collections.Generic.List[string]'
}
function Wait-CompanionVhdxFree([string]$path, [int]$seconds = 120) { $script:calls.Add('exclusive:' + $seconds); return $script:free.Dequeue() }
function Invoke-CompanionWslControl([string]$operation) { $script:calls.Add($operation); return $script:responses.Dequeue() }
function Reply([string]$output = '', [int]$code = 0, [bool]$completed = $true) { [ordered]@{ completed = $completed; exitCode = $code; stdout = $output } }

Reset-Case; $script:free.Enqueue($true)
$r = Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx'
Check (-not $r.vmShutdown -and @($script:calls).Count -eq 1) 'unlocked-file-never-shuts-down-a-vm'

Reset-Case; $script:free.Enqueue($false)
Check (Refuses { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' } 'WSL_VM_SHUTDOWN_REQUIRES_MAINTENANCE') 'locked-default-does-not-silently-stop-other-ci'
Check (-not (@($script:calls) -contains 'shutdown')) 'default-no-shutdown-transport-call'

Reset-Case; $script:free.Enqueue($false); $script:free.Enqueue($true)
$script:responses.Enqueue((Reply "CluedCI-Linux`r`n")); $script:responses.Enqueue((Reply)); $script:responses.Enqueue((Reply))
$r = Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown
Check ($r.vmShutdown -and $r.beforeRunning.Count -eq 1 -and $r.beforeRunning[0] -ceq 'CluedCI-Linux' -and $r.afterRunning.Count -eq 0) 'explicit-maintenance-records-the-other-distro-and-confirmed-empty-vm'
Check ((@($script:calls) -join ',') -ceq 'exclusive:2,list-running,shutdown,list-running,exclusive:120') 'shutdown-and-native-result-before-exclusive-file-proof'

foreach ($bad in @((Reply '' 5), (Reply '' 0 $false), (Reply "unexpected header:`r`n"))) {
  Reset-Case; $script:free.Enqueue($false); $script:responses.Enqueue($bad)
  Check (Refuses { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown } 'WSL_RUNNING_INVENTORY_UNCONFIRMED') 'unknown-inventory-does-not-shut-down'
  Check (-not (@($script:calls) -contains 'shutdown')) 'failed-enumeration-no-shutdown'
}

Reset-Case; $script:free.Enqueue($false)
$script:responses.Enqueue((Reply 'CluedCI-Linux')); $script:responses.Enqueue((Reply '' 7))
Check (Refuses { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown } 'WSL_VM_SHUTDOWN_FAILED') 'nonzero-shutdown-is-not-file-release'

Reset-Case; $script:free.Enqueue($false)
$script:responses.Enqueue((Reply)); $script:responses.Enqueue((Reply)); $script:responses.Enqueue((Reply 'CluedCI-Linux'))
Check (Refuses { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown } 'WSL_VM_NOT_STOPPED') 'surviving-or-restarted-distro-refuses-the-move'

Reset-Case; $script:free.Enqueue($false); $script:free.Enqueue($false)
$script:responses.Enqueue((Reply)); $script:responses.Enqueue((Reply)); $script:responses.Enqueue((Reply))
Check (Refuses { Assert-CompanionWslVhdxReleased 'C:\fixture\ext4.vhdx' -AllowVmShutdown } 'WSL_VHDX_STILL_IN_USE') 'empty-vm-is-not-enough-without-exclusive-file-proof'

# The new maintenance option is gated before reading or changing an installed root.
$rearm = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'rearm-resident.ps1'))
Check ($rearm.Contains('[switch]$CompanionWslVmShutdown') -and $rearm.IndexOf('WSL_VM_SHUTDOWN_ONLY_WITH_COMPANION_ACCOUNT') -lt $rearm.IndexOf('$installed = Get-Content')) 'maintenance-option-is-only-for-the-account-switch'
$move = $definitions['Invoke-CompanionWslMove']
Check ($move.IndexOf('Assert-CompanionWslVhdxReleased') -gt $move.IndexOf('Invoke-CompanionWslTerminate') -and $move.IndexOf('Assert-CompanionWslVhdxReleased') -lt $move.IndexOf('Copy-CompanionFileVerified')) 'real-move-checks-release-before-copy-delete'
[ordered]@{ result = 'PASS'; checks = $script:checks; actualWslCalls = 0; actualAccountOrTaskWrites = 0 } | ConvertTo-Json -Compress
