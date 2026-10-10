#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$HostId,
    [Parameter(Mandatory = $true)][string]$WatchdogPath,
    [string]$PythonwPath,
    [switch]$ValidateOnly,
    [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$manifest = Get-Content (Join-Path $PSScriptRoot 'node-profiles.json') -Raw | ConvertFrom-Json
$hostMatches = @($manifest.hosts | Where-Object { $_.host_id -eq $HostId })
if ($hostMatches.Count -ne 1 -or $HostId -notmatch '^[a-z0-9-]+$') {
    throw "Unknown or invalid HostId: $HostId"
}
if (-not [IO.Path]::IsPathRooted($WatchdogPath) -or -not (Test-Path -LiteralPath $WatchdogPath -PathType Leaf)) {
    throw 'WatchdogPath must be an existing absolute script path.'
}
$WatchdogPath = (Resolve-Path -LiteralPath $WatchdogPath).ProviderPath
if (-not $PythonwPath) {
    $python = Get-Command python.exe -ErrorAction Stop
    $PythonwPath = Join-Path (Split-Path -Parent $python.Source) 'pythonw.exe'
}
if (-not [IO.Path]::IsPathRooted($PythonwPath) -or
    (Split-Path -Leaf $PythonwPath) -ne 'pythonw.exe' -or
    -not (Test-Path -LiteralPath $PythonwPath -PathType Leaf)) {
    throw 'PythonwPath must name the installed absolute pythonw.exe (not a console interpreter).'
}
$PythonwPath = (Resolve-Path -LiteralPath $PythonwPath).ProviderPath
# Quotes cannot be represented safely inside a Windows argv path.
if ($WatchdogPath.Contains('"') -or $PythonwPath.Contains('"')) {
    throw 'Executable/script paths must not contain quotes.'
}
$root = Join-Path $env:LOCALAPPDATA "CluedCIWatchdog\$HostId"
$launcher = Join-Path $root 'launch-host-watchdog.py'
$consoleLog = Join-Path $root 'console-output.log'
$source = Join-Path $PSScriptRoot 'launch-host-watchdog.py'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Launcher source is missing.' }

$taskName = "Clued-CI-Watchdog-$HostId"
$runName = "CluedCIWatchdog-$HostId"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) "$taskName.cmd"
$runProperties = Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue
$runProperty = if ($runProperties) { $runProperties.PSObject.Properties[$runName] } else { $null }
$expectedLegacyRun = 'cmd.exe /c ""' + $startup + '""'
if ($runProperty -and [string]$runProperty.Value -ne $expectedLegacyRun) {
    throw "Unexpected HKCU Run value for $runName; preserve it and reconcile before installation."
}
if (Test-Path -LiteralPath $startup) {
    $legacy = Get-Content -LiteralPath $startup -Raw
    $legacyLauncher = Join-Path (Split-Path -Parent $WatchdogPath) "start-watchdog-$HostId.cmd"
    $expectedLegacy = '@echo off' + "`n" + 'call "' + $legacyLauncher + '"'
    if ($legacy.Replace("`r`n", "`n").TrimEnd() -ne $expectedLegacy) {
        throw 'Unexpected Startup command; preserve it and reconcile before installation.'
    }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    # Task Scheduler may return the same account as short name, domain name, or SID.
    $account = [string]$existing.Principal.UserId
    $taskSid = if ($account -match '^S-1-') {
        [Security.Principal.SecurityIdentifier]::new($account)
    } else {
        [Security.Principal.NTAccount]::new($account).Translate([Security.Principal.SecurityIdentifier])
    }
    if ($taskSid.Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or
        [string]$existing.Principal.LogonType -ne 'Interactive') {
        throw 'Existing watchdog task uses another account or logon type; do not replace it.'
    }
}
if ($existing -and [string]$existing.State -eq 'Running') {
    throw 'Stop the existing watchdog task in an authorized stable-resource window before replacing it.'
}
if ($StartNow) {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -match ('(?i)\s-File\s+"?' + [regex]::Escape($WatchdogPath) + '"?(?:\s|$)') })
    if ($running.Count) {
        throw 'An existing watchdog process is running. Stage without StartNow, then perform the verified handover.'
    }
}

if ($ValidateOnly) {
    Write-Host "No-console installer preflight passed: $HostId (no changes)"
    return
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
$backup = Join-Path $root ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
if ($existing) {
    Export-ScheduledTask -TaskName $taskName | Set-Content (Join-Path $backup 'task.xml') -Encoding Unicode
}
[pscustomobject]@{
    task_existed = [bool]$existing
    run_name = $runName
    run_value = if ($runProperty) { [string]$runProperty.Value } else { $null }
    startup_path = $startup
    watchdog_path = $WatchdogPath
} | ConvertTo-Json | Set-Content (Join-Path $backup 'startup.json') -Encoding UTF8
if (Test-Path -LiteralPath $startup) {
    Copy-Item -LiteralPath $startup -Destination (Join-Path $backup 'startup.cmd')
}
if (Test-Path -LiteralPath $launcher) {
    Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'launcher.py')
}
Copy-Item -LiteralPath $source -Destination $launcher -Force

$arguments = '-I -S "' + $launcher + '" --watchdog-path "' + $WatchdogPath + '" --log-path "' + $consoleLog + '"'
$action = New-ScheduledTaskAction -Execute $PythonwPath -Argument $arguments -WorkingDirectory $root
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$login = New-ScheduledTaskTrigger -AtLogOn -User $identity
$recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -Disable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$definition = New-ScheduledTask -Action $action -Principal $principal -Trigger @($login, $recovery) -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
$installed = Get-ScheduledTask -TaskName $taskName
if ($installed.Actions[0].Execute -ne $PythonwPath -or $installed.Actions[0].Arguments -ne $arguments) {
    throw 'Task action verification failed; leave legacy startup entries intact and restore the backed-up task.'
}
# Only the exact backed-up legacy entries are retired after task registration.
if ($runProperty) {
    $currentRun = (Get-ItemProperty -LiteralPath $runKey).PSObject.Properties[$runName]
    if (-not $currentRun -or [string]$currentRun.Value -ne [string]$runProperty.Value) {
        throw 'HKCU Run changed during installation; do not retire it.'
    }
    Remove-ItemProperty -LiteralPath $runKey -Name $runName
}
if (Test-Path -LiteralPath $startup) {
    $savedHash = (Get-FileHash -LiteralPath (Join-Path $backup 'startup.cmd')).Hash
    if ((Get-FileHash -LiteralPath $startup).Hash -ne $savedHash) {
        throw 'Startup command changed during installation; do not retire it.'
    }
    $retired = $startup + '.task-backup-' + (Split-Path -Leaf $backup)
    Move-Item -LiteralPath $startup -Destination $retired
}
if ($StartNow) {
    Enable-ScheduledTask -TaskName $taskName | Out-Null
    Start-ScheduledTask -TaskName $taskName
}
Write-Host "Installed single no-console task: $taskName (disabled unless StartNow was requested)"
Write-Host "Rollback backup: $backup"
Write-Host "Console output: $consoleLog"
