param(
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$LauncherSha256,
  [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
# Operator-only registration, never a consumer command. No password or elevation.
$taskName = 'Clued Resource Center Credential Renewal'
$full = [IO.Path]::GetFullPath($LauncherPath)
if ($full -ne $LauncherPath -or $full.Contains('"')) { throw 'RENEWAL_TASK_PATH_INVALID' }
$file = Get-Item -LiteralPath $full
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -ne $LauncherSha256) {
  throw 'RENEWAL_TASK_LAUNCHER_PIN_MISMATCH'
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$pwshPath = (Get-Command pwsh -CommandType Application).Source
$action = New-ScheduledTaskAction -Execute $pwshPath -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $full + '"')
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$task = New-ScheduledTask -Action $action -Trigger @($repeat,$logon) -Principal $principal -Settings $settings -Description 'Deterministic same-scope Clued credential renewal. No model, no provider effects. Failure remains closed.'
if ($ValidateOnly) {
  @{status='validated-not-installed';task_name=$taskName;run_level=[string]$principal.RunLevel;logon_type=[string]$principal.LogonType;interval=$repeat.Repetition.Interval;duration=$repeat.Repetition.Duration} | ConvertTo-Json -Compress
  exit 0
}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'RENEWAL_TASK_ALREADY_EXISTS' }
Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null
$installed = Get-ScheduledTask -TaskName $taskName
if ($installed.Principal.RunLevel -ne 'Limited' -or $installed.Principal.LogonType -ne 'Interactive' -or
    $installed.Actions.Execute -ne $pwshPath -or $installed.Actions.Arguments -ne $action.Arguments) {
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  throw 'RENEWAL_TASK_READBACK_FAILED_DISABLED'
}
@{status='installed';task_name=$taskName;run_level=[string]$installed.Principal.RunLevel;logon_type=[string]$installed.Principal.LogonType} | ConvertTo-Json -Compress
