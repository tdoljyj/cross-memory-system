#requires -Version 5.1

# Node Resource Governance v1: the one renderer of the one governance task per node (Clued-Node-Governance). It evolved
# from the host watchdog (Task 5282d4ae, #1066) and is put together from two declarations only:
# - config/node-governance-standard.json: every number of the standard, one file for every node;
# - the host's entry in node-profiles.json: its governance block {drives, resident_distro, worktrees, overrides}, its
#   capacity profile (memory levels) and its runner entries (an active Linux runner brings its stop/start for its disk
#   and memory and its in-distribution sweep; an active Windows runner is reported, never started).
# The rendered script probes memory and the declared drives every probe_seconds, judges each drive green/yellow/red,
# runs the hourly and daily classes of the standard while the executors are idle (pressure sweeps on yellow/red), and
# writes the one status file every reader takes (C:\ProgramData\Clued\node-governance\status.json).
param(
    [Parameter(Mandatory = $true)]
    [string]$HostId,
    [string]$OutputPath,     # default: <governance root>\node-governance.ps1
    [string]$ProfilesPath,   # default: ..\node-profiles.json
    [string]$StandardPath    # default: the repository's config\node-governance-standard.json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $ProfilesPath) { $ProfilesPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'node-profiles.json' }
if (-not $StandardPath) { $StandardPath = Join-Path $PSScriptRoot '..\..\..\..\config\node-governance-standard.json' }
$data = Get-Content $ProfilesPath -Raw | ConvertFrom-Json
$standard = Get-Content $StandardPath -Raw | ConvertFrom-Json
if ($standard.schema -ne 'clued.node-governance-standard/1') { throw "Not a node governance standard: $StandardPath" }
$hosts = @($data.hosts | Where-Object { $_.host_id -eq $HostId })
if ($hosts.Count -ne 1) { throw "Unknown or duplicate HostId: $HostId" }
$hostRecord = $hosts[0]
if ($HostId -notmatch '^[A-Za-z0-9._-]+$') { throw "HostId has characters the governance file names do not take: $HostId" }
$capacityProperty = $data.capacity_profiles.PSObject.Properties | Where-Object { $_.Name -eq $hostRecord.capacity_profile }
if (-not $capacityProperty) { throw "Unknown capacity profile: $($hostRecord.capacity_profile)" }
$capacity = $capacityProperty.Value

function Escape-SingleQuoted([string]$value) { return $value.Replace("'", "''") }
function Get-Field($object, [string]$name) {
    if ($null -ne $object -and $object.PSObject.Properties.Name -contains $name) { return $object.$name }
    return $null
}
function Get-EffectiveState($runner) {
    $state = Get-Field $runner 'state'
    if ($null -ne $state) { return $state }
    return $hostRecord.state
}
function Quote-List($items) { return ((@($items) | ForEach-Object { "'" + (Escape-SingleQuoted ([string]$_)) + "'" }) -join ',') }

# The governance block: the node's one declaration.
$gov = Get-Field $hostRecord 'governance'
if ($null -eq $gov) { throw "Host $HostId has no governance block" }
$drives = @()
foreach ($letter in @(Get-Field $gov 'drives')) {
    if ([string]$letter -notmatch '^[A-Za-z]$') { throw "governance.drives of $HostId has an entry that is not one drive letter: '$letter'" }
    if ($drives -contains ([string]$letter).ToUpper()) { throw "governance.drives of $HostId names $($letter): twice" }
    $drives += ([string]$letter).ToUpper()
}
if ($drives.Count -eq 0) { throw "governance.drives of $HostId is empty" }
$residentDistro = [string](Get-Field $gov 'resident_distro')
if ($residentDistro -and $residentDistro -notmatch '^[A-Za-z0-9._-]+$') { throw "governance.resident_distro of $HostId is not a distribution name: $residentDistro" }
$worktrees = @()
foreach ($w in @(Get-Field $gov 'worktrees')) {
    if ($null -eq $w) { continue }
    if ([string]$w -notmatch '^[A-Za-z]:\\[^"''`$]*$') { throw "governance.worktrees of $HostId has a path the renderer does not take: $w" }
    $worktrees += [string]$w
}
# Overrides: numbers only, of keys the standard has; a node can neither add nor drop a rule (standard section 8).
$overrides = Get-Field $gov 'overrides'
if ($null -ne $overrides) {
    foreach ($section in $overrides.PSObject.Properties) {
        if ($section.Name -notin @('disk', 'budget', 'classes')) { throw "governance.overrides of $HostId may not set $($section.Name)" }
        $targets = if ($section.Name -eq 'classes') { @($section.Value.PSObject.Properties | ForEach-Object { @{ Path = "classes.$($_.Name)"; Base = (Get-Field $standard.classes $_.Name); Value = $_.Value } }) }
                   else { @(@{ Path = $section.Name; Base = $standard.($section.Name); Value = $section.Value }) }
        foreach ($t in $targets) {
            if ($null -eq $t.Base) { throw "governance.overrides of $HostId names an unknown $($t.Path)" }
            foreach ($k in $t.Value.PSObject.Properties) {
                $old = Get-Field $t.Base $k.Name
                if ($null -eq $old -or -not ($old -is [int] -or $old -is [long] -or $old -is [double] -or $old -is [decimal])) { throw "governance.overrides of $HostId names $($t.Path).$($k.Name), which is not a number of the standard" }
                if (-not ($k.Value -is [int] -or $k.Value -is [long] -or $k.Value -is [double] -or $k.Value -is [decimal]) -or [double]$k.Value -lt 0) { throw "governance.overrides of $HostId sets $($t.Path).$($k.Name) to something that is not a number" }
                $t.Base.($k.Name) = $k.Value
            }
        }
    }
}

if (-not $OutputPath) { $OutputPath = Join-Path (Split-Path -Parent $standard.status_file) 'node-governance.ps1' }
$sweepFile = Join-Path $PSScriptRoot 'linux-sweep.sh'
$sweepB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(((Get-Content $sweepFile -Raw) -replace "`r`n", "`n")))

# The parts each kind of executor brings: its variables and functions (Body), what it does once at the start (Init)
# and in each round after the drives (Step).
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
# The runner disk (the drive that holds the runner distribution's virtual disk) stops the Linux runners at the standard's
# red level and starts them again at its recover level, both taken from that drive's size (Get-Capacity); C: only alerts.
$suspendMem=__SUSPEND_MEM__; $resumeMem=__RESUME_MEM__; $suspendRunnerDisk=__SUSPEND_RUNNER_DISK__; $resumeRunnerDisk=__RESUME_RUNNER_DISK__; $capacitySuspended=$false
$lastDeferral=''
function Log-Deferral([string]$m){if($m -ne $script:lastDeferral){Log $m; $script:lastDeferral=$m}}
$stateFile=Join-Path $stateDir ('governance-__HOST_ID__.state{0}.json' -f $sfx); $forceResumeFile=Join-Path $stateDir 'force-resume'
# BEGIN capacity-alert
# A capacity suspend stops the Linux runners; it must never do that unseen (defect 2102f7e1). Each suspend writes an
# ALERT line, the hold into the node status file (linuxRunners, read by the PR page and the panel) and a desktop
# notification, repeated every $alertEveryMinutes while the hold lasts; the resume clears it.
$alertEveryMinutes=30; $lastAlert=[datetime]::MinValue; $holdSince=$null; $linuxHold=$null
function Send-CapacityAlert([string]$kind,[string]$detail){
  try{
    if($kind -eq 'Resume'){
      $script:linuxHold=$null
      Log ("ALERT cleared: runners resumed ({0})" -f $detail); Show-Toast 'Clued CI runners resumed' $detail; return
    }
    $now=Get-Date
    $since=$now.ToString('o')
    if($kind -eq 'Reminder'){if($script:linuxHold){$since=$script:linuxHold.since}elseif($holdSince){$since=$holdSince}}
    $script:linuxHold=[ordered]@{suspended=$true;since=$since;detail=$detail}
    $script:lastAlert=$now
    Log ("ALERT {0}: Linux runners are stopped for low capacity ({1})" -f $kind,$detail)
    Show-Toast 'Clued CI runners are stopped' $detail
  }catch{Log ("Capacity alert failed: {0}" -f $_.Exception.Message)}
}
# END capacity-alert
function Test-LinuxBusy {
  # A Runner.Worker process exists exactly while a job runs. Sample twice, a few seconds apart.
  foreach($sample in 1,2){
    & wsl.exe -d $distro -u $linuxUser -e bash -lc 'pgrep -f "[R]unner.Worker" >/dev/null' 2>$null
    if($LASTEXITCODE -eq 0){return $true}
    if($LASTEXITCODE -ne 1){Log-Deferral 'Capacity suspend deferred: cannot query Linux runner processes';return $true}
    if($sample -eq 1){Start-Sleep -Seconds 5}
  }
  foreach($linuxUnit in $linuxUnits){
    $events=@(& wsl.exe -d $distro -u root -e journalctl -u $linuxUnit -n 200 --no-pager -o cat 2>$null)
    if($LASTEXITCODE -ne 0){continue}
    $lastRunnerEvent=$events | Where-Object {$_ -match 'Listening for Jobs|Running job:|Job .* completed with result:'} | Select-Object -Last 1
    if($lastRunnerEvent -match 'Running job:'){Log-Deferral ("Capacity suspend deferred: {0} reports a job starting" -f $linuxUnit);return $true}
  }
  return $false
}
# BEGIN capacity-step
# Below $suspendRunnerDisk the runner distribution gets a pressure sweep first (standard: the classes at their shortest
# days) and the runners stop only when that was not enough; they start again at $resumeRunnerDisk. Low memory stops them
# without a sweep (it frees no memory). A sweep in the last $cleanupGapMinutes counts as tried.
$cleanupGapMinutes=15; $lastCleanup=[datetime]::MinValue; $runnerDiskNote=''; $lastReassertLog=[datetime]::MinValue
function Get-RunnerDisk { Get-DistroDisk $distro }
function Get-Capacity {
  $os=Get-CimInstance Win32_OperatingSystem; $disk=Get-RunnerDisk; $free=$null; $total=$null
  if($disk){try{$d=Get-PSDrive $disk.Drive -ErrorAction Stop; $free=[math]::Round($d.Free/1GB,1); $total=[math]::Round(($d.Free+$d.Used)/1GB,1)}catch{$free=$null}}
  if($null -ne $total){$script:suspendRunnerDisk=Get-RedGb $total; $script:resumeRunnerDisk=Get-RecoverGb $total}
  [pscustomobject]@{Mem=[math]::Round($os.FreePhysicalMemory*1KB/1GB,2); CFree=[math]::Round((Get-PSDrive C).Free/1GB,1); Drive=$(if($disk){$disk.Drive}else{'?'}); Free=$free; Total=$total}
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
function Invoke-RunnerCleanup { Invoke-RunnerSweep -Pressure }
function Restore-CapacityState {
  $st=Read-State
  if($st){$script:capacitySuspended=[bool]$st.suspended; $script:holdSince=[string]$st.changed; if($script:capacitySuspended){$script:linuxHold=[ordered]@{suspended=$true;since=[string]$st.changed;detail=[string]$st.reason}}; Log ("Restored state: suspended={0} (since {1}, {2})" -f $script:capacitySuspended,$st.changed,$st.reason); return}
  $c=Get-Capacity; $a=Get-RunnerActive
  if($a.Ok -and $a.Active.Count -eq 0 -and $null -ne $c.Free -and $c.Free -lt $resumeRunnerDisk){$script:capacitySuspended=$true; $script:linuxHold=[ordered]@{suspended=$true;since=(Get-Date).ToString('o');detail='inferred at start'}; Log ("No state file; the runners are all stopped and {0}: has {1} GB free, below the resume level {2} GB: assuming suspended." -f $c.Drive,$c.Free,$resumeRunnerDisk)}
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
  $active=Get-RunnerActive
  if($active.Ok -and $active.Active.Count -gt 0 -and -not (Test-LinuxBusy)){
    Stop-LinuxRunners
    if(((Get-Date)-$script:lastReassertLog).TotalMinutes -ge 10){$script:lastReassertLog=Get-Date; Log ("Capacity suspend re-asserted: {0} unit(s) were active while suspended (restart of WSL or the distribution?): mem={1}GB disk={2}:{3}GB" -f $active.Active.Count,$c.Mem,$c.Drive,$c.Free)}
  }
  if(((Get-Date)-$lastAlert).TotalMinutes -ge $alertEveryMinutes){Send-CapacityAlert 'Reminder' (Format-Capacity $c)}
}
# END capacity-step
# BEGIN runner-sweep
# The runner distribution's classes (standard 1-9): hourly the job temporary files and the dangling Docker objects,
# daily the rest and a trim; a pressure sweep runs all of them at the standard's shortest days.
function Invoke-RunnerSweep([switch]$Pressure,[switch]$Hourly){
  $d=if($Pressure){$pressureDays}else{$null}
  Invoke-Sweep $distro $linuxUser (@('runner_temp')+$linuxRoots) | Out-Null
  if($manageDocker){Invoke-Sweep $distro $linuxUser @('docker_dangling',$C.docker_dangling.hours,$C.docker_dangling.leftover_container_regex,$C.docker_dangling.volume_regex,$maxObjects) | Out-Null}
  if($Hourly){return}
  Invoke-Sweep $distro $linuxUser (@('runner_checkout',(Pick $d $C.runner_checkout.days),$C.runner_checkout.max_gb,$maxObjects)+$linuxRoots) | Out-Null
  Invoke-Sweep $distro $linuxUser (@('runner_tool',(Pick $d $C.runner_tool.days),$C.runner_tool.max_gb,$maxObjects)+$linuxRoots) | Out-Null
  if($manageDocker){
    Invoke-Sweep $distro $linuxUser @('docker_images',(Pick $d $C.docker_images.days)) | Out-Null
    Invoke-Sweep $distro $linuxUser @('docker_build_cache',(Pick $d $C.docker_build_cache.days),$C.docker_build_cache.max_gb) | Out-Null
  }
  Invoke-Sweep $distro $linuxUser @('package_caches',$C.package_caches.npm_gb,$C.package_caches.pip_gb,$C.package_caches.other_gb) | Out-Null
  Invoke-Sweep $distro $linuxUser @('temp',(Pick $d $C.temp.days),$maxObjects) | Out-Null
  Invoke-Sweep $distro $linuxUser @('scan_db',(Pick $d $C.scan_db.days),$C.scan_db.max_gb) | Out-Null
  Invoke-Sweep $distro 'root' @('fstrim') | Out-Null
}
# END runner-sweep
$vhdxDistros+=$distro
'@
$linuxInit = @'
  Log ("Linux runners: the runner disk stops at the standard's red level (now below {0} GB), resumes at its recover level ({1} GB), after a pressure sweep first; memory stops below {2} GB, resumes at {3} GB" -f $suspendRunnerDisk,$resumeRunnerDisk,$suspendMem,$resumeMem)
  $runnerDisk=Get-RunnerDisk
  Log ("Runner disk: {0}" -f $(if($runnerDisk){"{0}: ({1})" -f $runnerDisk.Drive,$runnerDisk.Vhdx}else{"unknown (no WSL registration of $distro found)"}))
  if($runnerDisk -and $probeDrives -notcontains $runnerDisk.Drive){$probeDrives+=$runnerDisk.Drive}
  Restore-CapacityState
'@
$linuxStep = @'
  Invoke-CapacityStep
  $keep=Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like ('*'+$distro+'*sleep*infinity*')}
  if(-not $keep){if($DryRun){Log 'would recover the WSL keepalive'}else{Start-Process "$env:SystemRoot\System32\wsl.exe" -ArgumentList '-d',$distro,'-u',$linuxUser,'-e','/bin/sleep','infinity' -WindowStyle Hidden; Start-Sleep 2; Log 'Recovered WSL keepalive.'}}
  if(-not $capacitySuspended){
    if($manageDocker){& wsl.exe -d $distro -u root -e systemctl is-active --quiet docker 2>$null; if($LASTEXITCODE -ne 0){if($DryRun){Log 'would recover native Docker'}else{& wsl.exe -d $distro -u root -e systemctl start containerd docker 2>$null; Log 'Recovered native Docker.'}}}
    foreach($linuxUnit in $linuxUnits){& wsl.exe -d $distro -u root -e systemctl is-active --quiet $linuxUnit 2>$null; if($LASTEXITCODE -ne 0){if($DryRun){Log ("would recover Linux runner: {0}" -f $linuxUnit)}else{& wsl.exe -d $distro -u root -e systemctl start $linuxUnit 2>$null; Log ("Recovered Linux runner: {0}" -f $linuxUnit)}}}
  }
  if($hourlyDue){Invoke-RunnerSweep -Hourly}
  if($dailyDue){Invoke-RunnerSweep}
  $rdisk=Get-RunnerDisk
  if($pressureDue -and $rdisk -and $pressureDrives -contains $rdisk.Drive){Invoke-RunnerSweep -Pressure}
'@

$executors = @()
$replacements = [ordered]@{}
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
        if ($linuxRunner.root -notmatch '^/[A-Za-z0-9._/-]+$' -or $linuxRunner.root -match '(^|/)\.\.?(/|$)' -or $linuxRunner.root -eq '/') {
            throw "Linux runner $($linuxRunner.name) has a root the sweep does not take: $($linuxRunner.root)"
        }
        $linuxRoots += $linuxRunner.root.TrimEnd('/')
    }
}
if ($linuxUnits.Count -gt 0) {
    if ($primaryLinux.distro -eq $residentDistro) { throw "The runner distribution of $HostId cannot also be its resident distribution" }
    $executors += @{ Body = $linuxBody; Init = $linuxInit; Step = $linuxStep }
    $replacements['__DISTRO__'] = (Escape-SingleQuoted $primaryLinux.distro)
    $replacements['__LINUX_USER__'] = (Escape-SingleQuoted $primaryLinux.user)
    $replacements['__LINUX_UNITS__'] = (Quote-List $linuxUnits)
    $replacements['__LINUX_ROOTS__'] = (Quote-List $linuxRoots)
    $replacements['__MANAGE_DOCKER__'] = $(if ([bool](Get-Field $primaryLinux 'manage_native_docker')) { '$true' } else { '$false' })
    $replacements['__SUSPEND_MEM__'] = [string]$capacity.suspend_free_memory_gb
    $replacements['__RESUME_MEM__'] = [string]$capacity.resume_free_memory_gb
    $replacements['__SUSPEND_RUNNER_DISK__'] = [string]$standard.disk.red_gb
    $replacements['__RESUME_RUNNER_DISK__'] = [string]$standard.disk.recover_gb
}
$windowsRunner = Get-Field $hostRecord 'windows_runner'
if ($null -ne $windowsRunner -and (Get-EffectiveState $windowsRunner) -eq 'active') {
    if (-not (Get-Field $windowsRunner 'service_name')) { throw "windows_runner of $HostId has no service_name; the governance task never starts the Windows runner from the login session." }
    $executors += @{ Body = $windowsBody; Init = ''; Step = $windowsStep }
    $replacements['__WIN_SERVICE__'] = (Escape-SingleQuoted $windowsRunner.service_name)
}

$template = @'
# Clued-Node-Governance of __HOST_ID__, rendered by scripts/ci/self-hosted/node-governance/render.ps1 from
# config/node-governance-standard.json and node-profiles.json. Do not edit here: change the declarations and render again.
param(
  [int]$MaxIterations=0,   # 0: run forever
  [switch]$DryRun          # read-only: every stop, start and deletion is only logged as "would ..."; own log, state, status file and mutex; no notification
)
$ErrorActionPreference='Continue'
$sfx=if($DryRun){'.dryrun'}else{''}
$hostId='__HOST_ID__'
$govRoot='__GOV_ROOT__'; $logDir=Join-Path $govRoot 'logs'; $stateDir=Join-Path $govRoot 'state'
New-Item -ItemType Directory -Force -Path $logDir,$stateDir | Out-Null
$statusFile=if($DryRun){'__STATUS_FILE_DRYRUN__'}else{'__STATUS_FILE__'}
$log=Join-Path $logDir ('governance-{0}{1}.log' -f $hostId,$sfx); function Log([string]$m){if($DryRun){$m='[DRYRUN] '+$m}; Add-Content $log ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$m)}
$mutex=New-Object System.Threading.Mutex($false,('Local\CluedNodeGovernance-{0}{1}' -f $hostId,$sfx)); if(-not $mutex.WaitOne(0,$false)){exit 0}
$interval=__INTERVAL__
# BEGIN notify
function Show-Toast([string]$title,[string]$text){
  if($env:CLUED_WATCHDOG_NO_TOAST -or $DryRun){return}
  try{
    $registered='HKCU:\Software\Classes\AppUserModelId\Clued node governance'
    if(-not (Test-Path -LiteralPath $registered)){[void](New-Item -Path $registered -Force); [void](New-ItemProperty -Path $registered -Name DisplayName -Value 'Clued node governance' -PropertyType String -Force)}
    [void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
    $xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes=$xml.GetElementsByTagName('text')
    [void]$nodes.Item(0).AppendChild($xml.CreateTextNode($title)); [void]$nodes.Item(1).AppendChild($xml.CreateTextNode($text))
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Clued node governance').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
  }catch{Log ("Alert notification failed: {0}" -f $_.Exception.Message)}
}
# One alert channel (standard section 6): an ALERT line and a notification, the same key at most once per $everyMinutes.
$alertsSent=@{}
function Send-Alert([string]$key,[string]$title,[string]$text,[int]$everyMinutes){
  $last=$script:alertsSent[$key]
  if($last -and ((Get-Date)-$last).TotalMinutes -lt $everyMinutes){return $false}
  $script:alertsSent[$key]=Get-Date
  Log ("ALERT {0}: {1}" -f $key,$text); Show-Toast $title $text
  return $true
}
# END notify
# BEGIN levels
# Standard section 2: per drive the stricter of a share and an absolute level; red holds until the recover level.
$disk=@{YellowPct=__YELLOW_PCT__;YellowGb=__YELLOW_GB__;RedPct=__RED_PCT__;RedGb=__RED_GB__;RecoverPct=__RECOVER_PCT__;RecoverGb=__RECOVER_GB__}
function Get-RedGb([double]$total){[math]::Round([math]::Max($disk.RedGb,$total*$disk.RedPct/100),1)}
function Get-RecoverGb([double]$total){[math]::Round([math]::Max($disk.RecoverGb,$total*$disk.RecoverPct/100),1)}
function Get-YellowGb([double]$total){[math]::Round([math]::Max($disk.YellowGb,$total*$disk.YellowPct/100),1)}
function Get-DriveLevel([double]$free,[double]$total,[string]$previous){
  if($free -lt (Get-RedGb $total)){return 'red'}
  if($previous -eq 'red' -and $free -lt (Get-RecoverGb $total)){return 'red'}
  if($free -lt (Get-YellowGb $total)){return 'yellow'}
  return 'green'
}
# END levels
$C=ConvertFrom-Json '__CLASSES_JSON__'
$maxObjects=__MAX_OBJECTS__; $maxSeconds=__MAX_SECONDS__; $debtAlertRounds=__DEBT_ROUNDS__; $pressureDays=__PRESSURE_DAYS__
$repeatMinutes=__REPEAT_MINUTES__; $redRepeatMinutes=__RED_REPEAT_MINUTES__; $pressureGapMinutes=__PRESSURE_GAP__; $dailyAfterHour=__DAILY_HOUR__
$probeDrives=@(__DRIVES__); $residentDistro='__RESIDENT_DISTRO__'; $worktreeRoots=@(__WORKTREES__); $vhdxDistros=@()
$residentStatusFile='C:\ProgramData\CluedIndependentCI\resident\state\status.json'
function Pick($a,$b){if($null -ne $a){$a}else{$b}}
# BEGIN distro-disk
# The drive and virtual disk of a WSL distribution of this account, from its registration (BasePath, with or without \\?\).
function ConvertTo-RunnerDisk([string]$basePath,[string]$vhdFile){
  $base=$basePath -replace '^\\\\\?\\',''
  if($base -notmatch '^([A-Za-z]):\\'){return $null}
  $drive=$Matches[1].ToUpper()
  if(-not $vhdFile){$vhdFile='ext4.vhdx'}
  return [pscustomobject]@{Drive=$drive;Vhdx=[IO.Path]::Combine($base,$vhdFile)}
}
function Get-DistroDisk([string]$name){
  if(-not $name){return $null}
  try{
    foreach($key in @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction Stop)){
      $p=Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      if($p.DistributionName -ne $name){continue}
      $file=if($p.PSObject.Properties.Name -contains 'VhdFileName'){[string]$p.VhdFileName}else{''}
      return ConvertTo-RunnerDisk ([string]$p.BasePath) $file
    }
  }catch{}
  return $null
}
# END distro-disk
# BEGIN sweep
# One class of linux-sweep.sh in a distribution, passed base64-encoded (no file in the distribution, no double quote on
# the command line); at most $maxSeconds. Every result goes into the status file's actions and debt.
$sweepB64='__SWEEP_B64__'
$actions=New-Object System.Collections.ArrayList; $debt=@{}; $debtRounds=@{}
function Add-Action([string]$what,[string]$result){[void]$script:actions.Add([ordered]@{at=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');what=$what;result=$result}); while($script:actions.Count -gt 24){$script:actions.RemoveAt(0)}}
function Set-Debt([string]$key,[int]$n){
  if($n -gt 0){$script:debt[$key]=$n; $script:debtRounds[$key]=1+[int]$script:debtRounds[$key]
    if($script:debtRounds[$key] -ge $debtAlertRounds){[void](Send-Alert ("debt:{0}" -f $key) 'Clued node governance: debt' ("{0}: {1} object(s) left after {2} rounds; the budget is not raised to hide it" -f $key,$n,$script:debtRounds[$key]) $repeatMinutes)}}
  else{[void]$script:debt.Remove($key); [void]$script:debtRounds.Remove($key)}
}
function Invoke-Sweep([string]$name,[string]$user,[object[]]$sweepArgs){
  $cls=[string]$sweepArgs[0]; $key="{0}:{1}" -f $name,$cls
  $cmd=if($DryRun){'set -f; echo $0 | base64 -d | SWEEP_DRY_RUN=1 timeout __MAX_SECONDS__ bash -s -- $@'}else{'set -f; echo $0 | base64 -d | timeout __MAX_SECONDS__ bash -s -- $@'}
  $argv=@($sweepArgs | ForEach-Object {[string]$_})
  $out=@(& wsl.exe -d $name -u $user -e bash -c $cmd $sweepB64 @argv 2>&1 | ForEach-Object {([string]$_).Trim()} | Where-Object {$_})
  $code=$LASTEXITCODE
  $freed=0; $n=0; $left=0
  foreach($line in $out){
    if($line -match '^freed (\d+)$'){$freed=[int]$Matches[1]}
    elseif($line -match '^debt (\d+)$'){$left+=[int]$Matches[1]}
    elseif($line -match '^(would )?delete'){$n++}
  }
  $tail=if($out.Count){($out | Select-Object -Last 3) -join ' | '}else{''}
  $result=if($code -ne 0){"exit $code"}else{"{0} object(s), {1} MB" -f $n,$freed}
  Log ("Sweep {0} as {1}: {2}{3}" -f $key,$user,$result,$(if($tail){': '+$tail}else{''}))
  Add-Action $key $result
  if($code -ne 0 -and $code -ne 124){[void](Send-Alert ("sweep:{0}" -f $key) 'Clued node governance: a sweep failed' ("{0} could not run (exit {1}); nothing more was deleted" -f $key,$code) $repeatMinutes)}
  Set-Debt $key $left
  return [pscustomobject]@{Exit=$code;Freed=$freed;Objects=$n;Debt=$left;Lines=$out}
}
# END sweep
# BEGIN idle
# The resident CI is idle when every signal of its status view agrees (a view only ever adds a refusal: on 2026-11-04 it
# read IDLE while a batch sat at stage 6); unknown is busy.
$busyRowStates=@('RUNNING','PARKED','WAITING','QUEUED','BACKOFF'); $busyExecutorStates=@('STARTING','RUNNING','PARKED','WAITING','BACKFILL_PENDING')
function Test-ResidentIdle($s,[datetime]$now,[int]$maxAgeSeconds=90){
  if($null -eq $s -or ([string]$s.contract) -notmatch '^clued\.independent-ci\.resident-status/[5-8]$'){return $false}
  $written=[datetime]::MinValue
  if(-not [datetime]::TryParse([string]$s.writtenAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal,[ref]$written)){return $false}
  if([math]::Abs(($now.ToUniversalTime()-$written).TotalSeconds) -gt $maxAgeSeconds){return $false}
  $es=$null; if($null -ne $s.executor){$es=$s.executor.state}
  if($es -isnot [string] -or $busyExecutorStates -ccontains $es){return $false}
  if($null -ne $s.halt -or $s.paused -isnot [bool] -or $s.paused -or $null -ne $s.current){return $false}
  if($s.pending -isnot [array]){return $false}
  foreach($row in $s.pending){$st=$null; if($null -ne $row){$st=$row.state}; if($st -isnot [string] -or $busyRowStates -ccontains $st){return $false}}
  return $true
}
function Read-ResidentStatus{try{$i=Get-Item -LiteralPath $residentStatusFile -ErrorAction Stop; if($i.Length -le 0 -or $i.Length -gt 262144){return $null}; return (Get-Content -LiteralPath $residentStatusFile -Raw -ErrorAction Stop | ConvertFrom-Json)}catch{return $null}}
# END idle
# BEGIN windows-sweep
# This account's rebuildable files on Windows (standard 7, 8, 13): never inside a protected folder, never through a link,
# a file in use is left; at most $maxSeconds per root.
$protectedRoots=@('C:\ProgramData\CluedIndependentCI','C:\ProgramData\Clued','C:\clued-resident','C:\w','D:\w',(Join-Path $env:TEMP 'claude'),__PROTECTED_EXTRA__)
function Test-Protected([string]$p){
  $f=[IO.Path]::GetFullPath($p).TrimEnd('\')+'\'
  foreach($r in $protectedRoots){$x=$r.TrimEnd('\')+'\'; if($f.StartsWith($x,[StringComparison]::OrdinalIgnoreCase) -or $x.StartsWith($f,[StringComparison]::OrdinalIgnoreCase)){return $true}}
  return $false
}
function Remove-OldFiles([string]$root,[int]$days){
  $n=0; $bytes=0L
  if(-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)){return @{Files=0;Bytes=0L}}
  if(Test-Protected $root){Log ("Windows sweep: {0} refused: a protected folder" -f $root); return @{Files=0;Bytes=0L}}
  $cutoff=(Get-Date).AddDays(-$days); $clock=[Diagnostics.Stopwatch]::StartNew()
  $dirs=New-Object System.Collections.Stack; $dirs.Push((Get-Item -LiteralPath $root -Force))
  while($dirs.Count -gt 0 -and $clock.Elapsed.TotalSeconds -lt $maxSeconds){
    $d=$dirs.Pop()
    if(($d.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Test-Protected $d.FullName)){continue}
    foreach($e in @(Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue)){
      if($e.PSIsContainer){$dirs.Push($e); continue}
      if($e.LastWriteTime -ge $cutoff -or ($e.Attributes -band [IO.FileAttributes]::ReparsePoint)){continue}
      $len=$e.Length
      if($DryRun){$n++; $bytes+=$len; continue}
      try{Remove-Item -LiteralPath $e.FullName -Force -ErrorAction Stop; $n++; $bytes+=$len}catch{}
    }
  }
  return @{Files=$n;Bytes=$bytes}
}
function Invoke-WindowsSweep([switch]$Pressure){
  $d=if($Pressure){$pressureDays}else{$null}
  $verb=if($DryRun){'would remove'}else{'removed'}
  $roots=@(@($env:TEMP,(Pick $d $C.temp.days)),@((Join-Path $env:LOCALAPPDATA 'npm-cache'),(Pick $d $C.package_caches.days)),@((Join-Path $env:LOCALAPPDATA 'pip\Cache'),(Pick $d $C.package_caches.days)),
    @((Join-Path $env:LOCALAPPDATA 'NuGet\v3-cache'),(Pick $d $C.package_caches.days)),@($logDir,$C.logs.days),@('C:\clued-ci\logs',$C.logs.days))
  foreach($r in $roots){$x=Remove-OldFiles $r[0] $r[1]; if($x.Files -gt 0){Log ("Windows sweep, {0}: {1} {2} file(s), {3} MB" -f $r[0],$verb,$x.Files,[math]::Round($x.Bytes/1MB)); Add-Action ("windows:{0}" -f $r[0]) ("{0} file(s), {1} MB" -f $x.Files,[math]::Round($x.Bytes/1MB))}}
}
# END windows-sweep
# BEGIN resident-sweep
# The resident distribution: only Docker, temporary files, the scan cache and a trim, only while the resident CI is idle;
# its archives are the resident executor's own (between batches, retention.mjs), never this task's.
function Invoke-ResidentSweep([switch]$Pressure,[switch]$Hourly){
  if(-not $residentDistro -or -not $residentReachable){return}
  if(-not (Test-ResidentIdle (Read-ResidentStatus) (Get-Date))){Log 'Resident sweep deferred: the resident CI is not idle or its status cannot be read'; return}
  $d=if($Pressure){$pressureDays}else{$null}
  Invoke-Sweep $residentDistro 'root' @('docker_dangling',$C.docker_dangling.hours,$C.docker_dangling.leftover_container_regex,$C.docker_dangling.volume_regex,$maxObjects) | Out-Null
  if($Hourly){return}
  Invoke-Sweep $residentDistro 'root' @('docker_images',(Pick $d $C.docker_images.days)) | Out-Null
  Invoke-Sweep $residentDistro 'root' @('docker_build_cache',(Pick $d $C.docker_build_cache.days),$C.docker_build_cache.max_gb) | Out-Null
  Invoke-Sweep $residentDistro 'root' @('temp',(Pick $d $C.temp.days),$maxObjects) | Out-Null
  Invoke-Sweep $residentDistro 'root' @('scan_db',(Pick $d $C.scan_db.days),$C.scan_db.max_gb) | Out-Null
  Invoke-Sweep $residentDistro 'root' @('fstrim') | Out-Null
}
# END resident-sweep
# BEGIN daily-checks
# Standard 14 and 15, checks only: a virtual disk swollen past max(bloat_gb, bloat_pct) of its file (to be compacted in an
# idle window, or better made sparse), and development worktrees untouched for their days.
$vhdx=@()
function Invoke-DailyChecks{
  $script:vhdx=@()
  foreach($name in @($vhdxDistros+$(if($residentReachable){$residentDistro}) | Where-Object {$_} | Select-Object -Unique)){
    $dd=Get-DistroDisk $name
    if(-not $dd -or -not (Test-Path -LiteralPath $dd.Vhdx)){continue}
    $fileGb=[math]::Round((Get-Item -LiteralPath $dd.Vhdx).Length/1GB,1)
    $u=Invoke-Sweep $name 'root' @('usage')
    $usedLine=@($u.Lines | Where-Object {$_ -match '^used_kb \d+$'})
    if($usedLine.Count -eq 0){continue}
    $usedGb=[math]::Round([double]($usedLine[0] -replace '^used_kb ','')/1MB,1)
    $bloat=[math]::Round($fileGb-$usedGb,1); $limit=[math]::Max($C.vhdx.bloat_gb,$fileGb*$C.vhdx.bloat_pct/100)
    $script:vhdx+=[ordered]@{distro=$name;drive=$dd.Drive;fileGb=$fileGb;usedGb=$usedGb;bloatGb=$bloat;compactDue=($bloat -gt $limit)}
    if($bloat -gt $limit){[void](Send-Alert ("vhdx:{0}" -f $name) 'Clued node governance: virtual disk swollen' ("{0}: {1} GB file, {2} GB used; {3} GB can come back by a sparse disk or an idle-window compaction" -f $name,$fileGb,$usedGb,$bloat) $repeatMinutes)}
  }
  $stale=0
  foreach($w in $worktreeRoots){
    if(-not (Test-Path -LiteralPath $w -PathType Container)){continue}
    $stale+=@(Get-ChildItem -LiteralPath $w -Directory -Force -ErrorAction SilentlyContinue | Where-Object {-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.LastWriteTime -lt (Get-Date).AddDays(-$C.worktrees.days)}).Count
  }
  $script:staleWorktrees=$stale
  if($stale -gt 0){[void](Send-Alert 'worktrees' 'Clued node governance: old worktrees' ("{0} development worktree(s) untouched for {1} days under {2}; delete the merged ones" -f $stale,$C.worktrees.days,($worktreeRoots -join ', ')) $repeatMinutes)}
}
$staleWorktrees=0
# END daily-checks
# BEGIN drive-round
# Every probe: each drive's level (red holds until the recover level), the alerts of standard section 6, and whether a
# pressure sweep is due (yellow or red, at most once per $pressureGapMinutes).
$driveLevels=@{}; $driveFacts=@(); $lastPressure=[datetime]::MinValue
function Invoke-DriveRound{
  $facts=@(); $worst='green'; $pressure=$false; $script:pressureDrives=@()
  foreach($drive in $probeDrives){
    try{$p=Get-PSDrive $drive -ErrorAction Stop; $free=[math]::Round($p.Free/1GB,1); $total=[math]::Round(($p.Free+$p.Used)/1GB,1)}
    catch{[void](Send-Alert ("drive:{0}:unreadable" -f $drive) 'Clued node governance: a drive cannot be read' ("{0}: cannot be read: {1}" -f $drive,$_.Exception.Message) $repeatMinutes); continue}
    $prev=[string]$script:driveLevels[$drive]
    $level=Get-DriveLevel $free $total $prev
    $script:driveLevels[$drive]=$level
    $facts+=[ordered]@{drive=$drive;freeGb=$free;totalGb=$total;level=$level;redGb=(Get-RedGb $total);yellowGb=(Get-YellowGb $total);recoverGb=(Get-RecoverGb $total)}
    if($level -eq 'red'){$worst='red'}elseif($level -eq 'yellow' -and $worst -ne 'red'){$worst='yellow'}
    if($level -ne 'green'){$pressure=$true; $script:pressureDrives+=$drive}
    if($level -eq 'red'){[void](Send-Alert ("drive:{0}:red" -f $drive) ("Clued node {0}: {1}: red" -f $hostId,$drive) ("{0}: {1} GB free of {2} GB, below {3} GB: new resident batches wait until {4} GB" -f $drive,$free,$total,(Get-RedGb $total),(Get-RecoverGb $total)) $redRepeatMinutes)}
    elseif($level -eq 'yellow'){[void](Send-Alert ("drive:{0}:yellow" -f $drive) ("Clued node {0}: {1}: yellow" -f $hostId,$drive) ("{0}: {1} GB free of {2} GB, below {3} GB; pressure sweeps run" -f $drive,$free,$total,(Get-YellowGb $total)) $repeatMinutes)}
    if($prev -eq 'red' -and $level -ne 'red'){$script:alertsSent.Remove(("drive:{0}:red" -f $drive)); Log ("ALERT drive:{0}: recovered: {1} GB free" -f $drive,$free); Show-Toast ("Clued node {0}: {1}: recovered" -f $hostId,$drive) ("{0}: {1} GB free" -f $drive,$free)}
  }
  $script:driveFacts=$facts; $script:nodeLevel=$worst
  $script:pressureDue=$pressure -and ((Get-Date)-$script:lastPressure).TotalMinutes -ge $pressureGapMinutes
  if($script:pressureDue){$script:lastPressure=Get-Date}
}
$nodeLevel='green'; $pressureDue=$false; $pressureDrives=@()
# END drive-round
# BEGIN status
# The one status file (contract clued.node-governance-status/1), rewritten whole every probe, UTF-8 without a byte order
# mark: the executor (red on its drive holds new batches), the PR page, the compute panel and the Owner read it.
function Write-Status{
  $intakeDrive=$script:residentDrive
  $intake=@($script:driveFacts | Where-Object {$_.drive -eq $intakeDrive})
  $intakeLevel=if($intake.Count){$intake[0].level}else{'green'}
  $status=[ordered]@{
    contract='clued.node-governance-status/1'; host=$hostId; writtenAt=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); dryRun=[bool]$DryRun
    level=$script:nodeLevel; intake=[ordered]@{drive=$intakeDrive;level=$intakeLevel}; drives=@($script:driveFacts)
    memoryFreeGb=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory*1KB/1GB,2)
    linuxRunners=$script:linuxHold
    vhdx=@($script:vhdx); staleWorktrees=$script:staleWorktrees; debt=$script:debt; actions=@($script:actions)
    nextDaily=$script:nextDaily
  }
  try{
    $tmp=$statusFile+'.tmp'
    [IO.File]::WriteAllText($tmp,($status | ConvertTo-Json -Depth 6),(New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $statusFile -Force -ErrorAction Stop
  }catch{Log ("Status write failed: {0}" -f $_.Exception.Message)}
}
# END status
__BODIES__
# The resident CI's WSL disk: the install record's target (companion-headless.ps1; the distribution may belong to the
# companion account), else this account's registration of resident_distro, else C:.
$residentDrive='C'; $residentReachable=$false
try{$rec=Get-Content -LiteralPath 'C:\ProgramData\CluedIndependentCI\resident\install\companion-wsl.json' -Raw -ErrorAction Stop | ConvertFrom-Json
  if($rec.contract -eq 'clued.independent-ci.companion-wsl/1' -and [string]$rec.target -match '^([A-Za-z]):\\'){$residentDrive=$Matches[1].ToUpper()}}catch{}
$rd=Get-DistroDisk $residentDistro
if($rd){$residentReachable=$true; if(-not (Test-Path -LiteralPath 'C:\ProgramData\CluedIndependentCI\resident\install\companion-wsl.json')){$residentDrive=$rd.Drive}}
elseif($residentDistro){Log ("Resident distribution {0} is not registered for this account (the companion account's): its in-distribution sweep is left to the resident" -f $residentDistro)}
if($probeDrives -notcontains $residentDrive){$probeDrives+=$residentDrive}
Log ("Clued node governance of {0} started; drives {1}; resident {2} on {3}:" -f $hostId,($probeDrives -join ','),$(if($residentDistro){$residentDistro}else{'none'}),$residentDrive)
$lastHourly=[datetime]::MinValue; $lastDailyDate=''; $nextDaily=''
try{
__INITS__
  $iter=0
  while($true){
  Invoke-DriveRound
  $now=Get-Date
  $hourlyDue=($now-$lastHourly).TotalMinutes -ge 60
  $dailyDue=($now.Hour -ge $dailyAfterHour -and $lastDailyDate -ne $now.ToString('yyyy-MM-dd'))
  if($hourlyDue){$lastHourly=$now}
  if($dailyDue){$lastDailyDate=$now.ToString('yyyy-MM-dd'); $nextDaily=$now.Date.AddDays(1).AddHours($dailyAfterHour).ToString('o')}
__STEPS__
  if($hourlyDue){Invoke-ResidentSweep -Hourly}
  if($dailyDue){Invoke-ResidentSweep; Invoke-WindowsSweep; Invoke-DailyChecks}
  if($pressureDue){
    if($pressureDrives -contains $residentDrive){Invoke-ResidentSweep -Pressure}
    if($pressureDrives -contains $env:SystemDrive.Substring(0,1)){Invoke-WindowsSweep -Pressure}
    Invoke-DriveRound; $pressureDue=$false
  }
  Write-Status
  $iter++; if($MaxIterations -gt 0 -and $iter -ge $MaxIterations){break}
  Start-Sleep -Seconds $interval
}}finally{try{$mutex.ReleaseMutex()}catch{};$mutex.Dispose();Log 'Clued node governance stopped.'}
'@
$template = $template.Replace('__BODIES__', (@($executors | ForEach-Object { $_.Body }) -join "`n"))
$template = $template.Replace('__INITS__', (@($executors | Where-Object { $_.Init } | ForEach-Object { $_.Init }) -join "`n"))
$template = $template.Replace('__STEPS__', (@($executors | ForEach-Object { $_.Step }) -join "`n"))
$classesJson = ($standard.classes | ConvertTo-Json -Compress -Depth 4)
if ($classesJson.Contains("'")) { throw 'The standard classes may not contain a single quote' }
$replacements['__HOST_ID__'] = $HostId
$replacements['__GOV_ROOT__'] = (Escape-SingleQuoted (Split-Path -Parent $standard.status_file))
$replacements['__STATUS_FILE_DRYRUN__'] = (Escape-SingleQuoted ($standard.status_file -replace '\.json$', '.dryrun.json'))
$replacements['__STATUS_FILE__'] = (Escape-SingleQuoted $standard.status_file)
$replacements['__PROTECTED_EXTRA__'] = $(if ($null -ne $windowsRunner -and (Get-Field $windowsRunner 'root')) { Quote-List @($windowsRunner.root) } else { "'C:\clued-ci\runner'" })
$replacements['__INTERVAL__'] = [string]$standard.schedule.probe_seconds
$replacements['__YELLOW_PCT__'] = [string]$standard.disk.yellow_pct
$replacements['__YELLOW_GB__'] = [string]$standard.disk.yellow_gb
$replacements['__RED_PCT__'] = [string]$standard.disk.red_pct
$replacements['__RED_GB__'] = [string]$standard.disk.red_gb
$replacements['__RECOVER_PCT__'] = [string]$standard.disk.recover_pct
$replacements['__RECOVER_GB__'] = [string]$standard.disk.recover_gb
$replacements['__CLASSES_JSON__'] = $classesJson
$replacements['__MAX_OBJECTS__'] = [string]$standard.budget.max_objects
$replacements['__MAX_SECONDS__'] = [string]$standard.budget.max_seconds
$replacements['__DEBT_ROUNDS__'] = [string]$standard.budget.debt_alert_rounds
$replacements['__PRESSURE_DAYS__'] = [string]$standard.pressure_days
$replacements['__REPEAT_MINUTES__'] = [string]$standard.alerts.repeat_minutes
$replacements['__RED_REPEAT_MINUTES__'] = [string]$standard.alerts.red_repeat_minutes
$replacements['__PRESSURE_GAP__'] = [string]$standard.schedule.pressure_gap_minutes
$replacements['__DAILY_HOUR__'] = [string]$standard.schedule.daily_after_hour
$replacements['__DRIVES__'] = (Quote-List $drives)
$replacements['__RESIDENT_DISTRO__'] = (Escape-SingleQuoted $residentDistro)
$replacements['__WORKTREES__'] = (Quote-List $worktrees)
$replacements['__SWEEP_B64__'] = $sweepB64
foreach ($entry in $replacements.GetEnumerator()) { $template = $template.Replace($entry.Key, $entry.Value) }
if ($template -match '__[A-Z_]+__') { throw "The rendered governance script still has a placeholder: $($Matches[0])" }

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[IO.File]::WriteAllText($OutputPath, $template, (New-Object Text.UTF8Encoding($false)))
Write-Host "Rendered node governance: $OutputPath"
