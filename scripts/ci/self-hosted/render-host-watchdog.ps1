#requires -Version 5.1

param(
    [Parameter(Mandatory = $true)]
    [string]$HostId,
    [string]$OutputPath,
    [switch]$InstallStartup,
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$manifestPath = Join-Path $PSScriptRoot 'node-profiles.json'
$data = Get-Content $manifestPath -Raw | ConvertFrom-Json
$hosts = @($data.hosts | Where-Object { $_.host_id -eq $HostId })
if ($hosts.Count -ne 1) {
    throw "Unknown or duplicate HostId: $HostId"
}
$hostRecord = $hosts[0]

$capacityProperty = $data.capacity_profiles.PSObject.Properties | Where-Object { $_.Name -eq $hostRecord.capacity_profile }
if (-not $capacityProperty) {
    throw "Unknown capacity profile: $($hostRecord.capacity_profile)"
}
$capacity = $capacityProperty.Value

if (-not $hostRecord.windows_runner -or -not $hostRecord.linux_runner) {
    throw 'The v1 watchdog renderer expects one Windows runner and one WSL2 Linux runner on the host.'
}

if (-not $OutputPath) {
    $OutputPath = $hostRecord.watchdog_path
}

# The Windows runner is a Windows service run by a dedicated standard account.
# The watchdog runs in the login session and must never start the runner itself:
# that would run jobs as the login account again.
if (-not ($hostRecord.windows_runner.PSObject.Properties.Name -contains 'service_name') -or -not $hostRecord.windows_runner.service_name) {
    throw "windows_runner of $HostId has no service_name; the watchdog no longer starts the Windows runner from the login session."
}

function Escape-SingleQuoted([string]$value) {
    return $value.Replace("'", "''")
}

$manageDocker = if ([bool]$hostRecord.linux_runner.manage_native_docker) { '$true' } else { '$false' }

# Additional Linux slots share the primary WSL distro and are supervised by the
# same watchdog. Every Linux runner, the primary included, is supervised only
# while its own state (the host's when unset) is active; enrolling, retired and
# other runners are left alone, so a retired unit is never restarted.
$linuxRunners = @($hostRecord.linux_runner)
if ($hostRecord.PSObject.Properties.Name -contains 'additional_linux_runners') {
    $linuxRunners += @($hostRecord.additional_linux_runners)
}
$linuxUnits = @()
foreach ($linuxRunner in $linuxRunners) {
    $runnerState = if ($linuxRunner.PSObject.Properties.Name -contains 'state') { $linuxRunner.state } else { $hostRecord.state }
    if ($runnerState -eq 'active') {
        $linuxUnits += $linuxRunner.service_unit
    }
}
# The distro keepalive, native Docker and capacity suspend exist for these
# runners. Without an active one there is nothing to supervise: keep the host's
# watchdog stopped rather than render one.
if ($linuxUnits.Count -eq 0) {
    throw "$HostId has no active Linux runner, so the v1 watchdog has nothing to supervise. Keep its watchdog task and startup entries stopped."
}
$linuxUnitsLiteral = ($linuxUnits | ForEach-Object { "'" + (Escape-SingleQuoted $_) + "'" }) -join ','
$template = @'
$ErrorActionPreference='Continue'
$logDir='C:\clued-ci\logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log=Join-Path $logDir '__LOG_FILE__'; function Log([string]$m){Add-Content $log ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$m)}
$mutex=New-Object System.Threading.Mutex($false,'Local\__MUTEX__'); if(-not $mutex.WaitOne(0,$false)){exit 0}
$winService='__WIN_SERVICE__'; $winServiceReported=''
$distro='__DISTRO__'; $linuxUser='__LINUX_USER__'; $linuxUnits=@(__LINUX_UNITS__); $manageDocker=__MANAGE_DOCKER__
$suspendMem=__SUSPEND_MEM__; $resumeMem=__RESUME_MEM__; $suspendDisk=__SUSPEND_DISK__; $resumeDisk=__RESUME_DISK__; $interval=__INTERVAL__; $capacitySuspended=$false
$lastDeferral=''
# A suspend held back for the same reason is logged once per low-capacity episode.
function Log-Deferral([string]$m){if($m -ne $script:lastDeferral){Log $m; $script:lastDeferral=$m}}
# BEGIN capacity-alert
# A capacity suspend stops the Linux runners; it must never do that unseen (defect
# 2102f7e1: the runners stood still for 86 minutes and only the log knew). Each
# suspend writes an ALERT line, a marker file for panels and scripts (present
# exactly while the runners are held back) and a desktop notification, repeated
# every $alertEveryMinutes while the hold lasts; the resume removes the marker.
$alertFile='C:\clued-ci\state\capacity-alert.json'; $alertEveryMinutes=30; $lastAlert=[datetime]::MinValue; $firstLoop=$true; $holdSince=$null
function Show-Toast([string]$title,[string]$text){
  if($env:CLUED_WATCHDOG_NO_TOAST){return}
  try{
    # Windows shows a notification only for a registered application id
    $registered='HKCU:\Software\Classes\AppUserModelId\Clued CI watchdog'
    if(-not (Test-Path -LiteralPath $registered)){[void](New-Item -Path $registered -Force); [void](New-ItemProperty -Path $registered -Name DisplayName -Value 'Clued CI watchdog' -PropertyType String -Force)}
    [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
    $xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes=$xml.GetElementsByTagName('text')
    [void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title)); [void]$nodes.Item(1).AppendChild($xml.CreateTextNode($text))
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Clued CI watchdog').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  }catch{Log ("Alert notification failed: {0}" -f $_.Exception.Message)}
}
function Send-CapacityAlert([string]$kind,[string]$detail){
  try{
    if($kind -eq 'Resume'){
      $note=''
      try{if(Test-Path -LiteralPath $alertFile){Remove-Item -LiteralPath $alertFile -Force -ErrorAction Stop}}catch{$note=' (the marker file could not be removed: '+$_.Exception.Message+')'}
      Log ("ALERT cleared: runners resumed ({0}){1}" -f $detail,$note); Show-Toast 'Clued CI runners resumed' $detail; return
    }
    $now=Get-Date
    # the hold began when the persisted state says so (a restart while held back), else now
    $since=$now.ToString('o')
    if($kind -eq 'Reminder'){
      if($holdSince){$since=$holdSince}
      if(Test-Path -LiteralPath $alertFile){try{$since=(Get-Content -LiteralPath $alertFile -Raw | ConvertFrom-Json).since}catch{}}
    }
    $written=$true; $markerNote=''
    try{
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $alertFile) -ErrorAction Stop | Out-Null
      $tmp=$alertFile+'.tmp'
      # UTF-8 without a byte order mark, which JSON readers refuse (Set-Content -Encoding UTF8 writes one in Windows PowerShell)
      [IO.File]::WriteAllText($tmp,([pscustomobject]@{state='capacity-suspended';since=$since;detail=$detail;host=$env:COMPUTERNAME} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
      Move-Item -LiteralPath $tmp -Destination $alertFile -Force -ErrorAction Stop
    }catch{$written=$false; $markerNote=' (the marker file was not written: '+$_.Exception.Message+')'}
    # a marker that could not be written is tried again in 5 minutes, not after $alertEveryMinutes; the line and the notification are there either way
    if($written){$script:lastAlert=$now}else{$script:lastAlert=$now.AddMinutes(5-$alertEveryMinutes)}
    Log ("ALERT {0}: Linux runners are stopped for low capacity ({1}){2}" -f $kind,$detail,$markerNote)
    Show-Toast 'Clued CI runners are stopped' $detail
  }catch{Log ("Capacity alert failed: {0}" -f $_.Exception.Message)}
}
# A marker an earlier watchdog left is true only while the runners are held back: a watchdog that starts
# with them running (the machine restarted and the space came back) clears it.
function Clear-StaleCapacityAlert{
  try{if(Test-Path -LiteralPath $alertFile){Remove-Item -LiteralPath $alertFile -Force -ErrorAction Stop; Log 'ALERT marker of an earlier watchdog removed: the runners are not held back'}}
  catch{Log ("ALERT marker of an earlier watchdog could not be removed: {0}" -f $_.Exception.Message)}
}
# END capacity-alert
function Test-LinuxBusy {
  # A Runner.Worker process exists exactly while a job runs. Sample twice, a few
  # seconds apart, so a job the listener is just starting is not taken for idle.
  foreach($sample in 1,2){
    & wsl.exe -d $distro -u $linuxUser -e bash -lc 'pgrep -f "[R]unner.Worker" >/dev/null' 2>$null
    if($LASTEXITCODE -eq 0){return $true}
    if($LASTEXITCODE -ne 1){Log-Deferral 'Capacity suspend deferred: cannot query Linux runner processes';return $true}
    if($sample -eq 1){Start-Sleep -Seconds 5}
  }
  # The listener's own log can still show a job it accepted but has not started a
  # worker for. A missing or unreadable log no longer blocks the suspend: the
  # worker check above is the authority.
  foreach($linuxUnit in $linuxUnits){
    $events=@(& wsl.exe -d $distro -u root -e journalctl -u $linuxUnit -n 200 --no-pager -o cat 2>$null)
    if($LASTEXITCODE -ne 0){continue}
    $lastRunnerEvent=$events | Where-Object {$_ -match 'Listening for Jobs|Running job:|Job .* completed with result:'} | Select-Object -Last 1
    if($lastRunnerEvent -match 'Running job:'){Log-Deferral ("Capacity suspend deferred: {0} reports a job starting" -f $linuxUnit);return $true}
  }
  return $false
}
Log 'Clued P13 host watchdog started.'
# the levels it works with, in the log: what a restart took over is readable without opening the script
Log ("Thresholds: C: stops below {0} GB, resumes at {1} GB; memory stops below {2} GB, resumes at {3} GB" -f $suspendDisk,$resumeDisk,$suspendMem,$resumeMem)
try{while($true){
  $os=Get-CimInstance Win32_OperatingSystem; $freeMem=[math]::Round($os.FreePhysicalMemory*1KB/1GB,2); $freeDisk=[math]::Round((Get-PSDrive C).Free/1GB,1)
  $belowSuspend=($freeMem -lt $suspendMem -or $freeDisk -lt $suspendDisk)
  if(-not $belowSuspend){$lastDeferral=''}
  # Only inspect the Linux runner when a suspend is actually due.
  if(-not $capacitySuspended -and $belowSuspend -and -not (Test-LinuxBusy)){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits docker containerd 2>$null}else{& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits 2>$null}
    $capacitySuspended=$true; $lastDeferral=''; Log ("Capacity suspend: mem={0}GB disk={1}GB" -f $freeMem,$freeDisk)
    Send-CapacityAlert 'Suspend' ("C: {0} GB free (stops below {1}, resumes at {2}), memory {3} GB free (stops below {4}, resumes at {5})" -f $freeDisk,$suspendDisk,$resumeDisk,$freeMem,$suspendMem,$resumeMem)
  } elseif($capacitySuspended -and $freeMem -ge $resumeMem -and $freeDisk -ge $resumeDisk){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl start containerd docker $linuxUnits 2>$null}else{& wsl.exe -d $distro -u root -e systemctl start $linuxUnits 2>$null}
    $capacitySuspended=$false; Log ("Capacity resume: mem={0}GB disk={1}GB" -f $freeMem,$freeDisk)
    Send-CapacityAlert 'Resume' ("C: {0} GB free, memory {1} GB free" -f $freeDisk,$freeMem)
  } elseif($capacitySuspended -and ((Get-Date)-$lastAlert).TotalMinutes -ge $alertEveryMinutes){
    Send-CapacityAlert 'Reminder' ("C: {0} GB free (resumes at {1}), memory {2} GB free (resumes at {3})" -f $freeDisk,$resumeDisk,$freeMem,$resumeMem)
  }
  if($firstLoop){$firstLoop=$false; if(-not $capacitySuspended){Clear-StaleCapacityAlert}}
  # Only report the Windows runner service's state when it changes; never start it from here.
  $svc=Get-Service -Name $winService -ErrorAction SilentlyContinue
  $svcState=if($svc){[string]$svc.Status}else{'missing'}
  if($svcState -ne $winServiceReported){if($svcState -ne 'Running' -or $winServiceReported){Log ("Windows runner service {0}: {1}" -f $winService,$svcState)}; $winServiceReported=$svcState}
  $keep=Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like ('*'+$distro+'*sleep*infinity*')}
  if(-not $keep){Start-Process "$env:SystemRoot\System32\wsl.exe" -ArgumentList '-d',$distro,'-u',$linuxUser,'-e','/bin/sleep','infinity' -WindowStyle Hidden; Start-Sleep 2; Log 'Recovered WSL keepalive.'}
  if(-not $capacitySuspended){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl is-active --quiet docker 2>$null; if($LASTEXITCODE -ne 0){& wsl.exe -d $distro -u root -e systemctl start containerd docker 2>$null; Log 'Recovered native Docker.'}}
    foreach($linuxUnit in $linuxUnits){& wsl.exe -d $distro -u root -e systemctl is-active --quiet $linuxUnit 2>$null; if($LASTEXITCODE -ne 0){& wsl.exe -d $distro -u root -e systemctl start $linuxUnit 2>$null; Log ("Recovered Linux runner: {0}" -f $linuxUnit)}}
  }
  Start-Sleep -Seconds $interval
}}finally{try{$mutex.ReleaseMutex()}catch{};$mutex.Dispose();Log 'Clued P13 host watchdog stopped.'}
'@

$replacements = [ordered]@{
    '__LOG_FILE__' = "watchdog-$HostId.log"
    '__MUTEX__' = "CluedCIWatchdog-$HostId"
    '__WIN_SERVICE__' = (Escape-SingleQuoted $hostRecord.windows_runner.service_name)
    '__DISTRO__' = (Escape-SingleQuoted $hostRecord.linux_runner.distro)
    '__LINUX_USER__' = (Escape-SingleQuoted $hostRecord.linux_runner.user)
    '__LINUX_UNITS__' = $linuxUnitsLiteral
    '__MANAGE_DOCKER__' = $manageDocker
    '__SUSPEND_MEM__' = [string]$capacity.suspend_free_memory_gb
    '__RESUME_MEM__' = [string]$capacity.resume_free_memory_gb
    '__SUSPEND_DISK__' = [string]$capacity.suspend_c_free_gb
    '__RESUME_DISK__' = [string]$capacity.resume_c_free_gb
    '__INTERVAL__' = [string]$capacity.watchdog_interval_seconds
}
foreach ($entry in $replacements.GetEnumerator()) {
    $template = $template.Replace($entry.Key, $entry.Value)
}

$parent = Split-Path -Parent $OutputPath
if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
[IO.File]::WriteAllText($OutputPath, $template, (New-Object Text.UTF8Encoding($false)))
Write-Host "Rendered watchdog: $OutputPath"

if ($InstallStartup) {
    $root = Split-Path -Parent $OutputPath
    $launcher = Join-Path $root "start-watchdog-$HostId.cmd"
    @(
        '@echo off',
        ('start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $OutputPath + '"')
    ) | Set-Content $launcher -Encoding ASCII

    $startup = [Environment]::GetFolderPath('Startup')
    $startupFile = Join-Path $startup "Clued-CI-Watchdog-$HostId.cmd"
    @('@echo off', ('call "' + $launcher + '"')) | Set-Content $startupFile -Encoding ASCII

    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name "CluedCIWatchdog-$HostId" -Value ('cmd.exe /c ""' + $startupFile + '""')
    Write-Host "Installed startup launcher: $startupFile"
}

if ($StartNow) {
    Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$OutputPath -WindowStyle Hidden
    Write-Host 'Watchdog start requested.'
}
