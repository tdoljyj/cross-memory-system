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
$winRoot='__WIN_ROOT__'; $winExe=Join-Path $winRoot 'bin\Runner.Listener.exe'; $winLauncher='__WIN_LAUNCHER__'
$distro='__DISTRO__'; $linuxUser='__LINUX_USER__'; $linuxUnits=@(__LINUX_UNITS__); $manageDocker=__MANAGE_DOCKER__
$suspendMem=__SUSPEND_MEM__; $resumeMem=__RESUME_MEM__; $suspendDisk=__SUSPEND_DISK__; $resumeDisk=__RESUME_DISK__; $interval=__INTERVAL__; $capacitySuspended=$false
Log 'Clued P13 host watchdog started.'
try{while($true){
  $os=Get-CimInstance Win32_OperatingSystem; $freeMem=[math]::Round($os.FreePhysicalMemory*1KB/1GB,2); $freeDisk=[math]::Round((Get-PSDrive C).Free/1GB,1)
  & wsl.exe -d $distro -u $linuxUser -e bash -lc 'pgrep -f "Runner.Worker" >/dev/null' 2>$null; $linuxBusy=($LASTEXITCODE -eq 0)
  if(-not $capacitySuspended -and ($freeMem -lt $suspendMem -or $freeDisk -lt $suspendDisk) -and -not $linuxBusy){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits docker containerd 2>$null}else{& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits 2>$null}
    $capacitySuspended=$true; Log ("Capacity suspend: mem={0}GB disk={1}GB" -f $freeMem,$freeDisk)
  } elseif($capacitySuspended -and $freeMem -ge $resumeMem -and $freeDisk -ge $resumeDisk){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl start containerd docker $linuxUnits 2>$null}else{& wsl.exe -d $distro -u root -e systemctl start $linuxUnits 2>$null}
    $capacitySuspended=$false; Log ("Capacity resume: mem={0}GB disk={1}GB" -f $freeMem,$freeDisk)
  }
  $win=Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.ExecutablePath -eq $winExe}
  if(-not $win -and (Test-Path (Join-Path $winRoot '.runner'))){Start-Process cmd.exe -ArgumentList '/c',('call "'+$winLauncher+'"') -WindowStyle Hidden; Start-Sleep 2; $win=Get-CimInstance Win32_Process -Filter "Name='Runner.Listener.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.ExecutablePath -eq $winExe}; Log 'Recovered Windows runner.'}
  if($win){try{(Get-Process -Id $win.ProcessId).PriorityClass='BelowNormal'}catch{}}
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
    '__WIN_ROOT__' = (Escape-SingleQuoted $hostRecord.windows_runner.root)
    '__WIN_LAUNCHER__' = (Escape-SingleQuoted $hostRecord.windows_runner.launcher)
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
