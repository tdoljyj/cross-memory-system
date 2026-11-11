#requires -Version 5.1

# One renderer for every host (Task 5282d4ae): the watchdog is put together from the host's entry in the profiles,
# never from a special case for a kind of host.
# - watchdog_drives: the drives it watches, [{drive, suspend_free_gb?, resume_free_gb?, clean?}]; default one C: entry,
#   the levels default to the capacity profile's C: levels and clean to true. Each gets the host-disk part: below the
#   level a cleanup of rebuildable caches (when clean), then an alert while still low.
# - the executors are the host's runner entries whose effective state is active; each kind brings its own part:
#   windows-runner reports its service (never starts it), linux-runner cleans its distribution and stops/starts its
#   units for its own disk and for memory. A retired runner is not there; a host may have none.
param(
    [Parameter(Mandatory = $true)]
    [string]$HostId,
    [string]$OutputPath,
    [string]$ProfilesPath,   # default: node-profiles.json next to this script
    [switch]$InstallStartup,
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $ProfilesPath) {
    $ProfilesPath = Join-Path $PSScriptRoot 'node-profiles.json'
}
$data = Get-Content $ProfilesPath -Raw | ConvertFrom-Json
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

if (-not $OutputPath) {
    $OutputPath = $hostRecord.watchdog_path
}
# The host id names the log, state and marker files and the mutex (in -f format strings).
if ($HostId -notmatch '^[A-Za-z0-9._-]+$') {
    throw "HostId has characters the watchdog's file names do not take: $HostId"
}

function Escape-SingleQuoted([string]$value) {
    return $value.Replace("'", "''")
}
function Get-Field($object, [string]$name) {
    if ($null -ne $object -and $object.PSObject.Properties.Name -contains $name) { return $object.$name }
    return $null
}
# A runner entry's own state, else the host's.
function Get-EffectiveState($runner) {
    $state = Get-Field $runner 'state'
    if ($null -ne $state) { return $state }
    return $hostRecord.state
}

# The parts each kind of executor brings: its variables and functions (Body), what it does once at the start (Init)
# and in each round after the watched drives (Step).
$windowsBody = @'
$winService='__WIN_SERVICE__'; $winServiceReported=''
'@
$windowsStep = @'
  # Only report the Windows runner service's state when it changes; never start it from here.
  $svc=Get-Service -Name $winService -ErrorAction SilentlyContinue
  $svcState=if($svc){[string]$svc.Status}else{'missing'}
  if($svcState -ne $winServiceReported){if($svcState -ne 'Running' -or $winServiceReported){Log ("Windows runner service {0}: {1}" -f $winService,$svcState)}; $winServiceReported=$svcState}
'@
$linuxBody = @'
$distro='__DISTRO__'; $linuxUser='__LINUX_USER__'; $linuxUnits=@(__LINUX_UNITS__); $linuxRoots=@(__LINUX_ROOTS__); $manageDocker=__MANAGE_DOCKER__
# Owner decision 241824b2 (2026-11-08): the runner disk levels apply to the drive that holds the runner distribution's
# virtual disk; C: is a watched drive of the host (only alerts on DESK-W-591).
$suspendMem=__SUSPEND_MEM__; $resumeMem=__RESUME_MEM__; $suspendRunnerDisk=__SUSPEND_RUNNER_DISK__; $resumeRunnerDisk=__RESUME_RUNNER_DISK__; $capacitySuspended=$false
$lastDeferral=''
# A suspend held back for the same reason is logged once per low-capacity episode.
function Log-Deferral([string]$m){if($m -ne $script:lastDeferral){Log $m; $script:lastDeferral=$m}}
# The intent ($capacitySuspended) is saved on every change, so a restart of this process or of the machine keeps it;
# creating the force-resume file clears it.
$stateFile=Join-Path $stateDir ('watchdog-__HOST_ID__.state{0}.json' -f $sfx); $forceResumeFile=Join-Path $stateDir 'force-resume'
$alertFile=Join-Path $stateDir ('capacity-alert{0}.json' -f $sfx)
# BEGIN capacity-alert
# A capacity suspend stops the Linux runners; it must never do that unseen (defect
# 2102f7e1: the runners stood still for 86 minutes and only the log knew). Each
# suspend writes an ALERT line, a marker file for panels and scripts (present
# exactly while the runners are held back) and a desktop notification, repeated
# every $alertEveryMinutes while the hold lasts; the resume removes the marker.
$alertEveryMinutes=30; $lastAlert=[datetime]::MinValue; $firstLoop=$true; $holdSince=$null
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
# BEGIN capacity-step
# Owner decision 241824b2 (2026-11-08): the disk that stops the Linux runners is the one that holds their
# distribution's virtual disk (CluedCI-Linux: D: on DESK-W-591), found from the distribution's WSL registration.
# Below $suspendRunnerDisk the watchdog first cleans what is rebuildable inside that distribution (unused Docker
# images and dangling layers, the build cache, the _work/_temp of the idle runners) and stops the runners only when
# that was not enough; they start again at $resumeRunnerDisk. Low memory stops them without a cleanup (it frees no
# memory). A cleanup in the last $cleanupGapMinutes counts as tried: the disk low again goes straight to the stop.
$cleanupGapMinutes=15; $lastCleanup=[datetime]::MinValue; $runnerDiskNote=''; $lastReassertLog=[datetime]::MinValue
# The temporary files of finished jobs: <root>/_work/_temp of each runner, emptied only while no job runs on the
# distribution, as the runner account, without crossing into another file system or following a linked _work or _temp.
$runnerTempScript='set -f; pgrep -f [R]unner.Worker >/dev/null; s=$?; if [ $s -ne 1 ]; then echo kept: a job is running or the processes cannot be read; exit 0; fi; for r; do t=$r/_work/_temp; if [ ! -d $t ] || [ -L $t ] || [ -L $r/_work ]; then continue; fi; m=$(du -sm $t 2>/dev/null | cut -f1); find $t -mindepth 1 -maxdepth 1 -exec rm -rf --one-file-system -- {} +; echo emptied $t: ${m:-?} MB; done'
# The drive of a distribution's registered folder (BasePath, with or without the \\?\ prefix); $null for anything else.
function ConvertTo-RunnerDisk([string]$basePath,[string]$vhdFile){
  $base=$basePath -replace '^\\\\\?\\',''
  if($base -notmatch '^([A-Za-z]):\\'){return $null}
  $drive=$Matches[1].ToUpper()
  if(-not $vhdFile){$vhdFile='ext4.vhdx'}
  return [pscustomobject]@{Drive=$drive;Vhdx=[IO.Path]::Combine($base,$vhdFile)}
}
function Get-RunnerDisk {
  try{
    foreach($key in @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction Stop)){
      $p=Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      if($p.DistributionName -ne $distro){continue}
      $file=if($p.PSObject.Properties.Name -contains 'VhdFileName'){[string]$p.VhdFileName}else{''}
      return ConvertTo-RunnerDisk ([string]$p.BasePath) $file
    }
  }catch{}
  return $null
}
function Get-Capacity {
  $os=Get-CimInstance Win32_OperatingSystem; $disk=Get-RunnerDisk; $free=$null
  if($disk){try{$free=[math]::Round((Get-PSDrive $disk.Drive -ErrorAction Stop).Free/1GB,1)}catch{$free=$null}}
  [pscustomobject]@{Mem=[math]::Round($os.FreePhysicalMemory*1KB/1GB,2); CFree=[math]::Round((Get-PSDrive C).Free/1GB,1); Drive=$(if($disk){$disk.Drive}else{'?'}); Free=$free}
}
function Format-Capacity($c){
  $free=if($null -eq $c.Free){'unknown'}else{$c.Free}
  "{0}: {1} GB free (stops below {2}, resumes at {3}), memory {4} GB free (stops below {5}, resumes at {6})" -f $c.Drive,$free,$suspendRunnerDisk,$resumeRunnerDisk,$c.Mem,$suspendMem,$resumeMem
}
function Read-State {
  if(-not (Test-Path -LiteralPath $stateFile)){return $null}
  try{
    $o=Get-Content -LiteralPath $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if($null -eq $o.suspended){throw 'field "suspended" missing'}
    return $o
  }catch{Log ("State file unreadable ({0}); ignoring it." -f $_.Exception.Message); return $null}
}
function Save-State([bool]$suspended,[string]$reason){
  try{
    $tmp=$stateFile+'.tmp'
    [IO.File]::WriteAllText($tmp,([pscustomobject]@{suspended=$suspended;reason=$reason;changed=(Get-Date).ToString('o');host=$env:COMPUTERNAME} | ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $stateFile -Force -ErrorAction Stop
  }catch{Log ("State save failed: {0}" -f $_.Exception.Message)}
}
# One wsl call: which runner units are really active right now? Ok=$false when the query itself failed.
function Get-RunnerActive {
  $out=@(& wsl.exe -d $distro -u root -e systemctl is-active $linuxUnits 2>$null)
  if($out.Count -ne $linuxUnits.Count){return @{Ok=$false;Active=@()}}
  $act=@(); for($i=0;$i -lt $linuxUnits.Count;$i++){ if(([string]$out[$i]).Trim() -in 'active','activating','reloading'){$act+=$linuxUnits[$i]} }
  return @{Ok=$true;Active=$act}
}
function Stop-LinuxRunners {
  if($DryRun){Log 'would stop the runner units (and docker, containerd)'; return}
  if($manageDocker){& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits docker containerd 2>$null}else{& wsl.exe -d $distro -u root -e systemctl stop $linuxUnits 2>$null}
}
function Start-LinuxRunners {
  if($DryRun){Log 'would start containerd, docker and the runner units'; return}
  if($manageDocker){& wsl.exe -d $distro -u root -e systemctl start containerd docker $linuxUnits 2>$null}else{& wsl.exe -d $distro -u root -e systemctl start $linuxUnits 2>$null}
}
# Only what is rebuildable: images no container uses (dangling layers included) and the build cache, as the runner
# account (docker group); the runners' temporary files; then a trim, so what was freed can go back to the drive when
# the virtual disk is sparse. Never a container, a named store of data or a whole-engine prune.
function Invoke-RunnerCleanup {
  $steps=@()
  if($manageDocker){
    $steps+=,@('docker image prune',$linuxUser,@('docker','image','prune','--all','--force'))
    $steps+=,@('docker builder prune',$linuxUser,@('docker','builder','prune','--all','--force'))
  }
  $steps+=,@('runner temporary files',$linuxUser,(@('bash','-c',$runnerTempScript,'clued-cleanup')+$linuxRoots))
  $steps+=,@('fstrim','root',@('fstrim','-v','/'))
  foreach($s in $steps){
    if($DryRun){Log ("would run in {0} as {1}: {2}" -f $distro,$s[1],$s[0]); continue}
    $argv=$s[2]
    $out=@(& wsl.exe -d $distro -u $s[1] -e @argv 2>&1 | ForEach-Object {([string]$_).Trim()} | Where-Object {$_})
    $tail=if($out.Count){': '+(($out | Select-Object -Last 4) -join ' | ')}else{''}
    Log ("Capacity cleanup, {0}: exit {1}{2}" -f $s[0],$LASTEXITCODE,$tail)
  }
}
function Restore-CapacityState {
  # With no usable state file, infer it: all runners stopped while their disk is below the resume level means a
  # previous watchdog suspended them.
  $st=Read-State
  if($st){$script:capacitySuspended=[bool]$st.suspended; $script:holdSince=[string]$st.changed; Log ("Restored state: suspended={0} (since {1}, {2})" -f $script:capacitySuspended,$st.changed,$st.reason); return}
  $c=Get-Capacity; $a=Get-RunnerActive
  if($a.Ok -and $a.Active.Count -eq 0 -and $null -ne $c.Free -and $c.Free -lt $resumeRunnerDisk){$script:capacitySuspended=$true; Log ("No state file; the runners are all stopped and {0}: has {1} GB free, below the resume level {2} GB: assuming suspended." -f $c.Drive,$c.Free,$resumeRunnerDisk)}
  else{Log 'No state file; assuming not suspended.'}
  Save-State $script:capacitySuspended 'initial'
}
function Invoke-CapacityStep {
  $c=Get-Capacity
  $note=if($null -eq $c.Free){"Runner disk unknown: no drive found for the virtual disk of $distro; its free space is not judged (the memory rule and the watched drives still are)"}else{''}
  if($note -ne $script:runnerDiskNote){if($note){Log $note}else{Log ("Runner disk found: {0}:" -f $c.Drive)}; $script:runnerDiskNote=$note}
  $diskLow=($null -ne $c.Free -and $c.Free -lt $suspendRunnerDisk)
  $belowSuspend=($c.Mem -lt $suspendMem -or $diskLow)
  if(-not $belowSuspend){$script:lastDeferral=''}
  if(Test-Path -LiteralPath $forceResumeFile){
    if(-not $DryRun){Remove-Item -LiteralPath $forceResumeFile -Force -ErrorAction SilentlyContinue}
    if($capacitySuspended){$script:capacitySuspended=$false; Save-State $false 'force-resume file'; Log 'Manual force-resume: suspended intent cleared.'; Send-CapacityAlert 'Resume' ("force-resume: {0}" -f (Format-Capacity $c)); return}
  }
  if(-not $capacitySuspended){
    # Only inspect the Linux runners when a suspend is actually due.
    if(-not $belowSuspend -or (Test-LinuxBusy)){return}
    $cleanup=''
    if($diskLow -and ((Get-Date)-$script:lastCleanup).TotalMinutes -ge $cleanupGapMinutes){
      $script:lastCleanup=Get-Date; $before=$c.Free
      Log ("Capacity cleanup: {0}: {1} GB free, below {2} GB; cleaning the runner distribution before any stop" -f $c.Drive,$c.Free,$suspendRunnerDisk)
      Invoke-RunnerCleanup
      $c=Get-Capacity
      $diskLow=($null -ne $c.Free -and $c.Free -lt $suspendRunnerDisk); $belowSuspend=($c.Mem -lt $suspendMem -or $diskLow)
      Log ("Capacity cleanup done: {0}: {1} -> {2} GB free" -f $c.Drive,$before,$c.Free)
      if(-not $belowSuspend){$script:lastDeferral=''; Log 'Capacity cleanup was enough: the runners keep running'; return}
      $cleanup=("; cleanup before the stop: {0} -> {1} GB" -f $before,$c.Free)
      if(Test-LinuxBusy){return}
    }
    Stop-LinuxRunners
    $script:capacitySuspended=$true; $script:lastDeferral=''; Save-State $true ("low capacity mem={0}GB disk={1}:{2}GB" -f $c.Mem,$c.Drive,$c.Free)
    Log ("Capacity suspend: mem={0}GB disk={1}:{2}GB C:={3}GB" -f $c.Mem,$c.Drive,$c.Free,$c.CFree)
    Send-CapacityAlert 'Suspend' ((Format-Capacity $c)+$cleanup)
    return
  }
  if($c.Mem -ge $resumeMem -and ($null -eq $c.Free -or $c.Free -ge $resumeRunnerDisk)){
    Start-LinuxRunners
    $script:capacitySuspended=$false; Save-State $false ("resume mem={0}GB disk={1}:{2}GB" -f $c.Mem,$c.Drive,$c.Free)
    Log ("Capacity resume: mem={0}GB disk={1}:{2}GB C:={3}GB" -f $c.Mem,$c.Drive,$c.Free,$c.CFree)
    Send-CapacityAlert 'Resume' ("{0}: {1} GB free, memory {2} GB free" -f $c.Drive,$c.Free,$c.Mem)
    return
  }
  # The intent says suspended but systemd started the runners again (a restart of WSL or the distribution).
  $active=Get-RunnerActive
  if($active.Ok -and $active.Active.Count -gt 0 -and -not (Test-LinuxBusy)){
    Stop-LinuxRunners
    if(((Get-Date)-$script:lastReassertLog).TotalMinutes -ge 10){$script:lastReassertLog=Get-Date; Log ("Capacity suspend re-asserted: {0} unit(s) were active while suspended (restart of WSL or the distribution?): mem={1}GB disk={2}:{3}GB" -f $active.Active.Count,$c.Mem,$c.Drive,$c.Free)}
  }
  if(((Get-Date)-$lastAlert).TotalMinutes -ge $alertEveryMinutes){Send-CapacityAlert 'Reminder' (Format-Capacity $c)}
}
# END capacity-step
'@
$linuxInit = @'
  # the levels it works with, in the log: what a restart took over is readable without opening the script
  Log ("Linux runners: the runner disk stops below {0} GB, resumes at {1} GB (after a cleanup first); memory stops below {2} GB, resumes at {3} GB" -f $suspendRunnerDisk,$resumeRunnerDisk,$suspendMem,$resumeMem)
  $runnerDisk=Get-RunnerDisk
  Log ("Runner disk: {0}" -f $(if($runnerDisk){"{0}: ({1})" -f $runnerDisk.Drive,$runnerDisk.Vhdx}else{"unknown (no WSL registration of $distro found)"}))
  Restore-CapacityState
'@
$linuxStep = @'
  Invoke-CapacityStep
  if($firstLoop){$firstLoop=$false; if(-not $capacitySuspended){Clear-StaleCapacityAlert}}
  $keep=Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like ('*'+$distro+'*sleep*infinity*')}
  if(-not $keep){if($DryRun){Log 'would recover the WSL keepalive'}else{Start-Process "$env:SystemRoot\System32\wsl.exe" -ArgumentList '-d',$distro,'-u',$linuxUser,'-e','/bin/sleep','infinity' -WindowStyle Hidden; Start-Sleep 2; Log 'Recovered WSL keepalive.'}}
  if(-not $capacitySuspended){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl is-active --quiet docker 2>$null; if($LASTEXITCODE -ne 0){if($DryRun){Log 'would recover native Docker'}else{& wsl.exe -d $distro -u root -e systemctl start containerd docker 2>$null; Log 'Recovered native Docker.'}}}
    foreach($linuxUnit in $linuxUnits){& wsl.exe -d $distro -u root -e systemctl is-active --quiet $linuxUnit 2>$null; if($LASTEXITCODE -ne 0){if($DryRun){Log ("would recover Linux runner: {0}" -f $linuxUnit)}else{& wsl.exe -d $distro -u root -e systemctl start $linuxUnit 2>$null; Log ("Recovered Linux runner: {0}" -f $linuxUnit)}}}
  }
'@
# The watched drives.
$driveConfig = Get-Field $hostRecord 'watchdog_drives'
if ($null -eq $driveConfig) {
    $driveConfig = @([pscustomobject]@{ drive = 'C' })
}
$driveLiterals = @()
$seenDrives = @{}
foreach ($entry in @($driveConfig)) {
    $letter = [string](Get-Field $entry 'drive')
    if ($letter -notmatch '^[A-Za-z]$') {
        throw "watchdog_drives of $HostId has an entry that is not one drive letter: '$letter'"
    }
    $letter = $letter.ToUpper()
    if ($seenDrives.ContainsKey($letter)) {
        throw "watchdog_drives of $HostId names $($letter): twice"
    }
    $seenDrives[$letter] = $true
    $suspend = Get-Field $entry 'suspend_free_gb'
    if ($null -eq $suspend) { $suspend = $capacity.suspend_c_free_gb }
    $resume = Get-Field $entry 'resume_free_gb'
    if ($null -eq $resume) { $resume = $capacity.resume_c_free_gb }
    if (-not ([double]$suspend -gt 0 -and [double]$suspend -lt [double]$resume)) {
        throw "watchdog_drives of $HostId, $($letter): needs 0 < suspend_free_gb < resume_free_gb (got $suspend, $resume)"
    }
    $clean = Get-Field $entry 'clean'
    $cleanLiteral = if ($null -eq $clean -or [bool]$clean) { '$true' } else { '$false' }
    $driveLiterals += ("@{{Drive='{0}';Suspend={1};Resume={2};Clean={3}}}" -f $letter, [string]$suspend, [string]$resume, $cleanLiteral)
}

# The executors: each active runner entry, by kind. The Linux part runs before the Windows report in each round.
$executors = @()
$replacements = [ordered]@{}

# Linux runners (the primary and additional slots) share one WSL distribution and are supervised together while their
# own state (the host's when unset) is active; enrolling, retired and other runners are left alone, so a retired unit
# is never restarted.
$linuxRunners = @()
$primaryLinux = Get-Field $hostRecord 'linux_runner'
if ($null -ne $primaryLinux) {
    $linuxRunners += $primaryLinux
    $additional = Get-Field $hostRecord 'additional_linux_runners'
    if ($null -ne $additional) { $linuxRunners += @($additional) }
}
$linuxUnits = @()
$linuxRoots = @()
foreach ($linuxRunner in $linuxRunners) {
    if ((Get-EffectiveState $linuxRunner) -eq 'active') {
        $linuxUnits += $linuxRunner.service_unit
        # The capacity cleanup empties <root>/_work/_temp of these runners, passed unquoted to bash.
        if ($linuxRunner.root -notmatch '^/[A-Za-z0-9._/-]+$' -or $linuxRunner.root -match '(^|/)\.\.?(/|$)' -or $linuxRunner.root -eq '/') {
            throw "Linux runner $($linuxRunner.name) has a root the capacity cleanup does not take: $($linuxRunner.root)"
        }
        $linuxRoots += $linuxRunner.root.TrimEnd('/')
    }
}
if ($linuxUnits.Count -gt 0) {
    foreach ($key in 'suspend_runner_disk_free_gb', 'resume_runner_disk_free_gb') {
        if (-not ($capacity.PSObject.Properties.Name -contains $key)) {
            throw "Capacity profile $($hostRecord.capacity_profile) has no $key"
        }
    }
    $executors += @{ Body = $linuxBody; Init = $linuxInit; Step = $linuxStep }
    $replacements['__DISTRO__'] = (Escape-SingleQuoted $primaryLinux.distro)
    $replacements['__LINUX_USER__'] = (Escape-SingleQuoted $primaryLinux.user)
    $replacements['__LINUX_UNITS__'] = (($linuxUnits | ForEach-Object { "'" + (Escape-SingleQuoted $_) + "'" }) -join ',')
    $replacements['__LINUX_ROOTS__'] = (($linuxRoots | ForEach-Object { "'" + (Escape-SingleQuoted $_) + "'" }) -join ',')
    $replacements['__MANAGE_DOCKER__'] = $(if ([bool](Get-Field $primaryLinux 'manage_native_docker')) { '$true' } else { '$false' })
    $replacements['__SUSPEND_MEM__'] = [string]$capacity.suspend_free_memory_gb
    $replacements['__RESUME_MEM__'] = [string]$capacity.resume_free_memory_gb
    $replacements['__SUSPEND_RUNNER_DISK__'] = [string]$capacity.suspend_runner_disk_free_gb
    $replacements['__RESUME_RUNNER_DISK__'] = [string]$capacity.resume_runner_disk_free_gb
}

$windowsRunner = Get-Field $hostRecord 'windows_runner'
if ($null -ne $windowsRunner -and (Get-EffectiveState $windowsRunner) -eq 'active') {
    # The Windows runner is a Windows service run by a dedicated standard account. The watchdog runs in the login
    # session and must never start the runner itself: that would run jobs as the login account again.
    if (-not (Get-Field $windowsRunner 'service_name')) {
        throw "windows_runner of $HostId has no service_name; the watchdog no longer starts the Windows runner from the login session."
    }
    $executors += @{ Body = $windowsBody; Init = ''; Step = $windowsStep }
    $replacements['__WIN_SERVICE__'] = (Escape-SingleQuoted $windowsRunner.service_name)
}

$template = @'
param(
  # Ops hooks (taken over from the hand-edited watchdog of DESK-W-591). The defaults are the production behaviour.
  [int]$MaxIterations=0,   # 0: run forever
  [switch]$DryRun          # read-only: every stop, start and cleanup is only logged as "would ..."; own log, state, marker and mutex; no notification
)
$ErrorActionPreference='Continue'
$sfx=if($DryRun){'.dryrun'}else{''}
$logDir='C:\clued-ci\logs'; $stateDir='C:\clued-ci\state'; New-Item -ItemType Directory -Force -Path $logDir,$stateDir | Out-Null
$log=Join-Path $logDir ('watchdog-__HOST_ID__{0}.log' -f $sfx); function Log([string]$m){if($DryRun){$m='[DRYRUN] '+$m}; Add-Content $log ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$m)}
$mutex=New-Object System.Threading.Mutex($false,('Local\CluedCIWatchdog-__HOST_ID__{0}' -f $sfx)); if(-not $mutex.WaitOne(0,$false)){exit 0}
$interval=__INTERVAL__
# BEGIN notify
function Show-Toast([string]$title,[string]$text){
  if($env:CLUED_WATCHDOG_NO_TOAST -or $DryRun){return}
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
# END notify
# BEGIN host-disk
# Every watched drive of the host: below its Suspend level a host cleanup when it says Clean (at most once per
# $cleanupGapMinutes), then, still below, an ALERT line and a notification, again every $alertEveryMinutes while it
# lasts, cleared once at its Resume level. It never stops or starts anything.
$hostDrives=@(__HOST_DRIVES__)
$alertEveryMinutes=30; $cleanupGapMinutes=60; $cleanAgeDays=1; $driveState=@{}
# Never touched, whatever a cleanup root or a link says: the resident CI's state and WSL distribution, the runners and
# this watchdog (C:\clued-ci), the evidence.
$protectedRoots=@('C:\ProgramData\CluedIndependentCI','C:\clued-resident','C:\clued-ci','C:\w','D:\w')
# What is rebuildable, of the account the watchdog runs as (of the system TEMP, what that account may delete).
$cleanRoots=@($env:TEMP,(Join-Path $env:SystemRoot 'Temp'),(Join-Path $env:LOCALAPPDATA 'npm-cache'),(Join-Path $env:LOCALAPPDATA 'pip\Cache'),(Join-Path $env:LOCALAPPDATA 'NuGet\v3-cache'))
# A path inside a protected folder, or one that contains a protected folder.
function Test-Protected([string]$p){
  $f=[IO.Path]::GetFullPath($p).TrimEnd('\')+'\'
  foreach($r in $protectedRoots){$x=$r.TrimEnd('\')+'\'; if($f.StartsWith($x,[StringComparison]::OrdinalIgnoreCase) -or $x.StartsWith($f,[StringComparison]::OrdinalIgnoreCase)){return $true}}
  return $false
}
# The files older than $cleanAgeDays under $root when it is on $drive, without entering a link (junction or symbolic
# link) or a protected folder; a file in use is left.
function Remove-OldFiles([string]$root,[string]$drive){
  $n=0; $bytes=0L
  if(-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)){return @{Files=0;Bytes=0L}}
  if(-not [IO.Path]::GetFullPath($root).StartsWith($drive+':\',[StringComparison]::OrdinalIgnoreCase)){return @{Files=0;Bytes=0L}}
  if(Test-Protected $root){Log ("Disk cleanup: {0} refused: a protected folder" -f $root); return @{Files=0;Bytes=0L}}
  $cutoff=(Get-Date).AddDays(-$cleanAgeDays)
  $dirs=New-Object System.Collections.Stack; $dirs.Push((Get-Item -LiteralPath $root -Force))
  while($dirs.Count -gt 0){
    $d=$dirs.Pop()
    if(($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Protected $d.FullName)){continue}
    foreach($e in @(Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue)){
      if($e.PSIsContainer){$dirs.Push($e); continue}
      if($e.LastWriteTime -ge $cutoff){continue}
      $len=$e.Length
      if($DryRun){$n++; $bytes+=$len; continue}
      try{Remove-Item -LiteralPath $e.FullName -Force -ErrorAction Stop; $n++; $bytes+=$len}catch{}
    }
  }
  return @{Files=$n;Bytes=$bytes}
}
function Invoke-HostCleanup([string]$drive){
  $verb=if($DryRun){'would remove'}else{'removed'}
  foreach($r in $cleanRoots){$x=Remove-OldFiles $r $drive; if($x.Files -gt 0){Log ("Disk cleanup, {0}: {1} {2} file(s), {3} MB" -f $r,$verb,$x.Files,[math]::Round($x.Bytes/1MB))}}
}
function Get-FreeGB([string]$drive){ [math]::Round((Get-PSDrive $drive -ErrorAction Stop).Free/1GB,1) }
function Invoke-DriveStep($d){
  $drive=$d.Drive
  if(-not $script:driveState.ContainsKey($drive)){$script:driveState[$drive]=@{LastCleanup=[datetime]::MinValue;AlertOn=$false;LastAlert=[datetime]::MinValue}}
  $s=$script:driveState[$drive]
  $free=Get-FreeGB $drive
  if($free -lt $d.Suspend){
    $after=''
    if($d.Clean){
      $after=' after a cleanup'
      if(((Get-Date)-$s.LastCleanup).TotalMinutes -ge $cleanupGapMinutes){
        $s.LastCleanup=Get-Date; $before=$free
        Log ("Disk cleanup: {0}: {1} GB free, below {2} GB" -f $drive,$free,$d.Suspend)
        Invoke-HostCleanup $drive
        $free=Get-FreeGB $drive
        Log ("Disk cleanup done: {0}: {1} -> {2} GB free" -f $drive,$before,$free)
      }
    }
    if($free -ge $d.Suspend -or ($s.AlertOn -and ((Get-Date)-$s.LastAlert).TotalMinutes -lt $alertEveryMinutes)){return}
    $s.AlertOn=$true; $s.LastAlert=Get-Date
    Log ("ALERT {0}: {1} GB free, below {2} GB{3}; free space on {0}:" -f $drive,$free,$d.Suspend,$after)
    Show-Toast ("Clued CI host: {0}: is low" -f $drive) ("{0}: {1} GB free{3} (alerts below {2} GB); free space on {0}:" -f $drive,$free,$d.Suspend,$after)
  }elseif($s.AlertOn -and $free -ge $d.Resume){
    $s.AlertOn=$false
    Log ("ALERT {0}: cleared: {1} GB free" -f $drive,$free); Show-Toast ("Clued CI host: {0}: has space again" -f $drive) ("{0}: {1} GB free" -f $drive,$free)
  }
}
function Invoke-HostDiskStep { foreach($d in $hostDrives){ try{Invoke-DriveStep $d}catch{Log ("Disk step for {0}: failed: {1}" -f $d.Drive,$_.Exception.Message)} } }
# END host-disk
__BODIES__
Log 'Clued P13 host watchdog started.'
Log ("Watched drives: {0}" -f (($hostDrives | ForEach-Object {"{0}: below {1} GB {2}alerts, clears at {3} GB" -f $_.Drive,$_.Suspend,$(if($_.Clean){"removes caches older than $cleanAgeDays day(s), then "}else{''}),$_.Resume}) -join '; '))
try{
__INITS__
  $iter=0
  while($true){
  Invoke-HostDiskStep
__STEPS__
  $iter++; if($MaxIterations -gt 0 -and $iter -ge $MaxIterations){break}
  Start-Sleep -Seconds $interval
}}finally{try{$mutex.ReleaseMutex()}catch{};$mutex.Dispose();Log 'Clued P13 host watchdog stopped.'}
'@
$template = $template.Replace('__BODIES__', (@($executors | ForEach-Object { $_.Body }) -join "`n"))
$template = $template.Replace('__INITS__', (@($executors | Where-Object { $_.Init } | ForEach-Object { $_.Init }) -join "`n"))
$template = $template.Replace('__STEPS__', (@($executors | ForEach-Object { $_.Step }) -join "`n"))
$replacements['__HOST_ID__'] = $HostId
$replacements['__INTERVAL__'] = [string]$capacity.watchdog_interval_seconds
$replacements['__HOST_DRIVES__'] = ($driveLiterals -join ',')
foreach ($entry in $replacements.GetEnumerator()) {
    $template = $template.Replace($entry.Key, $entry.Value)
}
if ($template -match '__[A-Z_]+__') {
    throw "The rendered watchdog still has a placeholder: $($Matches[0])"
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
