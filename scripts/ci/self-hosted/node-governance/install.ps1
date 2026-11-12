#requires -Version 5.1

# Install the node's one governance task (Node Resource Governance v1) and retire what it replaces, in ONE elevation:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\self-hosted\node-governance\install.ps1 -HostId home-primary
#
# Run it as the node's Owner from a checkout. It asks for one UAC prompt, waits for the elevated part and prints its
# result (also written to -ResultPath). The elevated part:
#   1. renders the task's script into C:\ProgramData\Clued\node-governance (render.ps1; ACL: SYSTEM and Administrators
#      full, the Owner modify, Users read: the resident service and the runners read the status file);
#   2. registers Clued-Node-Governance for the Owner (at logon and daily at 04:00, Limited: it never needs elevation,
#      so nothing it runs is ever elevated; single instance; restarted on failure), disabled for now;
#   3. runs ONE read-only round (-DryRun -MaxIterations 1) as the Owner through a one-shot task and reads its status;
#   4. deletes the archived upgrade generations beyond the three newest and the current one (standard class 12) with the
#      installed resident's own maintenance tool: archive\ is writable by SYSTEM/Administrators only, the upgrade service
#      that could do it on its own lives in the frozen channel (upgrader/src) and the governance task never elevates, so
#      this elevation is where it happens (each install or re-install; the companion notifies when more are due);
#   5. only when that round wrote a status: retires the old mechanisms (the host watchdog's tasks, processes, startup
#      launchers and files; the cache maintenance worker's task, processes and folder), carries the watchdog's suspend
#      intent over, enables and starts Clued-Node-Governance. A failed round changes nothing of the old ones.
# -WhatIf prints the plan (what it would register and retire on this machine) without elevating or changing anything.
param(
    [Parameter(Mandatory = $true)]
    [string]$HostId,
    [string]$TaskUser = ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME),
    [string]$ResultPath = (Join-Path $env:TEMP 'clued-node-governance-install.json'),
    [switch]$WhatIf,
    [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TaskName = 'Clued-Node-Governance'
$DryTaskName = 'Clued-Node-Governance-FirstRound'
$Root = 'C:\ProgramData\Clued\node-governance'
$Script = Join-Path $Root 'node-governance.ps1'
$Powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Renderer = Join-Path $PSScriptRoot 'render.ps1'
$UserHome = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$((New-Object Security.Principal.NTAccount($TaskUser)).Translate([Security.Principal.SecurityIdentifier]).Value)").ProfileImagePath
# What node governance v1 replaces (plan section 4, items 1 and 4), found by name or by what the task or process runs.
$Legacy = @{
    TaskNames = @("Clued-CI-Watchdog-$HostId", 'CluedCache-desk-w-591-owner-builds')
    Runs = @('watchdog-clued-ci.ps1', 'watchdog-home-runner.ps1', 'launch-host-watchdog.py', 'start-watchdog-', 'resource-maintenance\maintenance.py', '.clued-cache-maintenance')
    Files = @('C:\clued-ci\watchdog-clued-ci.ps1', 'C:\clued-ci\watchdog-home-runner.ps1', "C:\clued-ci\start-watchdog-$HostId.cmd",
        (Join-Path $UserHome "AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Clued-CI-Watchdog-$HostId.cmd"))
    Folders = @((Join-Path $UserHome "AppData\Local\CluedCIWatchdog\$HostId"), (Join-Path $UserHome '.clued-cache-maintenance'))
    RunValue = "CluedCIWatchdog-$HostId"
    State = @("C:\clued-ci\state\watchdog-$HostId.state.json", 'C:\clued-ci\state\watchdog.state.json')
}
function Find-LegacyTasks {
    @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $t = $_
        if ($t.TaskName -in @($TaskName, $DryTaskName)) { return $false }
        if ($Legacy.TaskNames -contains $t.TaskName) { return $true }
        $runs = (@($t.Actions) | ForEach-Object { $a = $_; @('Execute', 'Arguments') | ForEach-Object { $p = $a.PSObject.Properties[$_]; if ($p) { [string]$p.Value } } }) -join ' '
        @($Legacy.Runs | Where-Object { $runs -like "*$_*" }).Count -gt 0
    })
}
function Find-LegacyProcesses {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $c = [string]$_.CommandLine
        $_.ProcessId -ne $PID -and $c -and $c -notlike '*node-governance*' -and @($Legacy.Runs | Where-Object { $c -like "*$_*" }).Count -gt 0
    })
}
# No console window: conhost --headless (as the resident's notifier), never only -WindowStyle Hidden (runbook section 5).
$Conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$ResidentRoot = 'C:\ProgramData\CluedIndependentCI\resident'
# The installed resident's node.exe and maintenance tool, read from its service's command line and only below its admin-only
# root (never a checkout or another user-writable place: this runs elevated).
function Get-GenerationTool {
    $svc = Get-CimInstance Win32_Service -Filter "Name='CluedCIResident'" -ErrorAction SilentlyContinue
    if (-not $svc) { return $null }
    $m = [regex]::Match([string]$svc.PathName, '"(?<node>[^"]+\\runtime\\node\.exe)" [0-9a-f]{64} "(?<entry>[^"]+\\resident\\[0-9a-f]{64}\\src\\service-main\.mjs)"')
    if (-not $m.Success) { return $null }
    $node = [IO.Path]::GetFullPath($m.Groups['node'].Value)
    $tool = [IO.Path]::GetFullPath(($m.Groups['entry'].Value -replace '\\src\\service-main\.mjs$', '\tools\retention-generations.mjs'))
    foreach ($f in $node, $tool) { if (-not $f.StartsWith($ResidentRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $f -PathType Leaf)) { return $null } }
    return @{ Node = $node; Tool = $tool }
}
function New-TaskAction([string]$extra) {
    New-ScheduledTaskAction -Execute $Conhost -Argument ('--headless "{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}"{2}' -f $Powershell, $Script, $extra)
}
function New-TaskPrincipal { New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited }

if ($WhatIf) {
    $plan = [ordered]@{
        host = $HostId; taskUser = $TaskUser; task = $TaskName; script = $Script; runLevel = 'Limited'; triggers = @('AtLogOn, repeated every minute', 'Daily 04:00')
        firstRound = "$Powershell -File $Script -DryRun -MaxIterations 1 (as $TaskUser, through $DryTaskName)"
        retireTasks = @(Find-LegacyTasks | ForEach-Object { $_.TaskPath + $_.TaskName })
        retireProcesses = @(Find-LegacyProcesses | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name })
        retireFiles = @($Legacy.Files | Where-Object { Test-Path -LiteralPath $_ })
        retireFolders = @($Legacy.Folders | Where-Object { Test-Path -LiteralPath $_ })
        runValue = $Legacy.RunValue
        generations = "<resident>\runtime\node.exe <resident>\resident\<sha>\tools\retention-generations.mjs --root $ResidentRoot --apply (elevated, once)"
    }
    $plan | ConvertTo-Json -Depth 4
    return
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Elevated) {
    if (Test-Path -LiteralPath $ResultPath) { Remove-Item -LiteralPath $ResultPath -Force }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-HostId', $HostId, '-TaskUser', "`"$TaskUser`"", '-ResultPath', "`"$ResultPath`"", '-Elevated')
    $p = Start-Process -FilePath $Powershell -ArgumentList $argList -Verb RunAs -Wait -PassThru
    if (Test-Path -LiteralPath $ResultPath) { Get-Content -LiteralPath $ResultPath -Raw } else { Write-Error "The elevated part wrote no result (exit $($p.ExitCode))." }
    exit $p.ExitCode
}
if (-not $isAdmin) { throw 'The elevated part must run as an administrator.' }

$result = [ordered]@{ host = $HostId; taskUser = $TaskUser; at = (Get-Date).ToString('o'); steps = New-Object System.Collections.ArrayList; ok = $false }
function Step([string]$what, [scriptblock]$do) {
    try { $out = & $do; [void]$result.steps.Add([ordered]@{ step = $what; ok = $true; detail = [string]$out }) }
    catch { [void]$result.steps.Add([ordered]@{ step = $what; ok = $false; detail = $_.Exception.Message }); throw }
}
try {
    Step 'folder and ACL' {
        New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root 'logs'), (Join-Path $Root 'state') | Out-Null
        $item = Get-Item -LiteralPath $Root -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$Root is a link" }
        & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$($TaskUser):(OI)(CI)M" '*S-1-5-32-545:(OI)(CI)RX' '*S-1-5-11:(OI)(CI)RX' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "icacls exit $LASTEXITCODE" }
        $Root
    }
    Step 'render' { & $Powershell -NoProfile -ExecutionPolicy Bypass -File $Renderer -HostId $HostId -OutputPath $Script; if ($LASTEXITCODE -ne 0) { throw "render exit $LASTEXITCODE" } }
    Step 'register (disabled)' {
        # At logon, repeated every minute (a stopped instance is back within 90 s; IgnoreNew keeps one), and daily.
        $logon = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
        $logon.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)).Repetition
        $triggers = @($logon, (New-ScheduledTaskTrigger -Daily -At '04:00'))
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $TaskName -Action (New-TaskAction '') -Trigger $triggers -Principal (New-TaskPrincipal) -Settings $settings -Force | Out-Null
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        $TaskName
    }
    Step 'first read-only round' {
        $dryStatus = Join-Path $Root 'status.dryrun.json'
        if (Test-Path -LiteralPath $dryStatus) { Remove-Item -LiteralPath $dryStatus -Force }
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $DryTaskName -Action (New-TaskAction ' -DryRun -MaxIterations 1') -Principal (New-TaskPrincipal) -Settings $settings -Force | Out-Null
        try {
            Start-ScheduledTask -TaskName $DryTaskName
            $deadline = (Get-Date).AddMinutes(20)
            do { Start-Sleep -Seconds 5 } while ((Get-ScheduledTask -TaskName $DryTaskName).State -eq 'Running' -and (Get-Date) -lt $deadline)
        } finally { Unregister-ScheduledTask -TaskName $DryTaskName -Confirm:$false }
        if (-not (Test-Path -LiteralPath $dryStatus)) { throw 'the read-only round wrote no status: nothing old was retired; see logs\governance-*.dryrun.log' }
        $s = Get-Content -LiteralPath $dryStatus -Raw | ConvertFrom-Json
        $result.firstRound = $s
        'level {0}, intake {1}: {2}' -f $s.level, $s.intake.drive, $s.intake.level
    }
    Step 'retire the old mechanisms' {
        $done = @()
        foreach ($t in Find-LegacyTasks) {
            try { Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue } catch {}
            Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false; $done += "task $($t.TaskPath)$($t.TaskName)"
        }
        # Only the processes of the old mechanisms, by what they run (never by an image name).
        foreach ($p in Find-LegacyProcesses) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $done += "process $($p.ProcessId)" }
        $run = 'Registry::HKEY_USERS\' + (New-Object Security.Principal.NTAccount($TaskUser)).Translate([Security.Principal.SecurityIdentifier]).Value + '\Software\Microsoft\Windows\CurrentVersion\Run'
        if ((Test-Path $run) -and (Get-ItemProperty -Path $run -Name $Legacy.RunValue -ErrorAction SilentlyContinue)) { Remove-ItemProperty -Path $run -Name $Legacy.RunValue; $done += "run value $($Legacy.RunValue)" }
        foreach ($state in $Legacy.State) {
            if (Test-Path -LiteralPath $state) { Copy-Item -LiteralPath $state -Destination (Join-Path $Root "state\governance-$HostId.state.json") -Force; $done += "suspend intent from $state"; break }
        }
        foreach ($f in $Legacy.Files) { if (Test-Path -LiteralPath $f -PathType Leaf) { Remove-Item -LiteralPath $f -Force; $done += "file $f" } }
        foreach ($d in $Legacy.Folders) {
            if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
            if ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { $done += "kept $d (a link)"; continue }
            Remove-Item -LiteralPath $d -Recurse -Force; $done += "folder $d"
        }
        $done -join '; '
    }
    Step 'archived generations: three newest and the current one stay' {
        $g = Get-GenerationTool
        if (-not $g) { return 'no installed resident tool found: skipped' }
        $out = @(& $g.Node $g.Tool --root $ResidentRoot --apply 2>&1 | ForEach-Object { [string]$_ })
        'exit {0}: {1}' -f $LASTEXITCODE, (($out | Select-Object -Last 2) -join ' ')
    }
    Step 'enable and start' { Enable-ScheduledTask -TaskName $TaskName | Out-Null; Start-ScheduledTask -TaskName $TaskName; (Get-ScheduledTask -TaskName $TaskName).State }
    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    [IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
}
if (-not $result.ok) { exit 1 }
