#requires -Version 5.1

param(
    [Parameter(Mandatory = $true)]
    [string]$HostId,
    [string]$OutputPath,
    [string]$PythonwPath,
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
# same watchdog once they are active; enrolling slots are left alone.
$linuxUnits = @($hostRecord.linux_runner.service_unit)
if ($hostRecord.PSObject.Properties.Name -contains 'additional_linux_runners') {
    foreach ($extra in @($hostRecord.additional_linux_runners)) {
        $extraState = if ($extra.PSObject.Properties.Name -contains 'state') { $extra.state } else { $hostRecord.state }
        if ($extraState -eq 'active') {
            $linuxUnits += $extra.service_unit
        }
    }
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
try{while($true){
  $os=Get-CimInstance Win32_OperatingSystem; $freeMem=[math]::Round($os.FreePhysicalMemory*1KB/1GB,2); $freeDisk=[math]::Round((Get-PSDrive C).Free/1GB,1)
  $belowSuspend=($freeMem -lt $suspendMem -or $freeDisk -lt $suspendDisk)
  if(-not $belowSuspend){$lastDeferral=''}
  # Only inspect the Linux runner when a suspend is actually due.
  if(-not $capacitySuspended -and $belowSuspend -and -not (Test-LinuxBusy)){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits docker containerd 2>$null}else{& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits 2>$null}
    $capacitySuspended=$true; $lastDeferral=''; Log ("Capacity suspend: mem={0}GB disk={1}GB" -f $freeMem,$freeDisk)
  } elseif($capacitySuspended -and $freeMem -ge $resumeMem -and $freeDisk -ge $resumeDisk){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl start containerd docker $linuxUnits 2>$null}else{& wsl.exe -d $distro -u root -e systemctl start $linuxUnits 2>$null}
    $capacitySuspended=$false; Log ("Capacity resume: mem={0}GB disk={1}GB" -f $freeMem,$freeDisk)
  }
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

if (($InstallStartup -or $StartNow) -and (Test-Path -LiteralPath $OutputPath)) {
    # Installing/starting must never overwrite deployed logic before preflight.
    if ((Get-Content -LiteralPath $OutputPath -Raw).TrimEnd() -ne $template.TrimEnd()) {
        throw 'Deployed watchdog differs from this render. Preview and deploy it in a separate approved step before installing/starting.'
    }
    Write-Host "Using unchanged watchdog: $OutputPath"
} else {
    $parent = Split-Path -Parent $OutputPath
    if ($parent) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [IO.File]::WriteAllText($OutputPath, $template, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Rendered watchdog: $OutputPath"
}

if ($InstallStartup) {
    # The compatibility switch now installs one recoverable, no-console task.
    & (Join-Path $PSScriptRoot 'install-host-watchdog-launcher.ps1') -HostId $HostId -WatchdogPath $OutputPath -PythonwPath $PythonwPath -StartNow:$StartNow
} elseif ($StartNow) {
    $taskName = "Clued-CI-Watchdog-$HostId"
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $expectedScript = (Resolve-Path -LiteralPath $OutputPath).ProviderPath
    $expectedLauncher = Join-Path $env:LOCALAPPDATA "CluedCIWatchdog\$HostId\launch-host-watchdog.py"
    $expectedLog = Join-Path $env:LOCALAPPDATA "CluedCIWatchdog\$HostId\console-output.log"
    $expectedArguments = '-I -S "' + $expectedLauncher + '" --watchdog-path "' + $expectedScript + '" --log-path "' + $expectedLog + '"'
    if (@($task.Actions).Count -ne 1 -or (Split-Path -Leaf $task.Actions[0].Execute) -ne 'pythonw.exe' -or $task.Actions[0].Arguments -ne $expectedArguments) {
        throw 'The installed task does not match this no-console launcher/script. Install the reviewed task first.'
    }
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'No-console watchdog task start requested.'
}
