# drill-vm.ps1 -- the new-node first-install drill machine: one Hyper-V VM on this host (plan PLAN-drill-vm-20261116, phase A).
#
#   pwsh -NoProfile -File drill-vm.ps1 -BaselineOnly
#   pwsh -NoProfile -File drill-vm.ps1 -PrereqOnly      (baseline copy + the pinned prerequisites from D:\clued-drill\prereq, then restored)
#   pwsh -NoProfile -File drill-vm.ps1 -Version <v> -From <dir with tar/acceptance/SHA256SUMS> -Kit <first-install kit dir> [-SkipReinstall] [-RunTimeoutMinutes 70]
#     (a candidate: -From without an acceptance; the kit carries a drill-only one, see Test-DrillPackageDir and FIRST-INSTALL-KIT.md)
#   pwsh -NoProfile -File drill-vm.ps1 -Finalize <receipt.json> -ProductionReadback <readback.json>
#
# Inputs on the host: D:\clued-drill\iso (the Windows 11 ISO and expected-sha256.txt), D:\clued-drill\prereq\prereq.json (the
# pinned WSL package, Ubuntu image and docker .debs, see Read-DrillPrereq), and the kit's kit.json:
#   { contract: clued.drill.first-install-kit/1, files: [{path, sha256}], entry: {file: <.ps1>, arguments: [-Name | {from} {kit}
#     {fake} {work} {version}]}, timeoutMinutes: 5..240, perNodeSteps: [..], prereqSha256: <sha256 of prereq.json> }
# The entry's last stdout line is { status, stopCode, tree, node } (tree: the unpacked package; node: a node.exe to run it).
# No node parameter. Every state is read from the scene (does the VM exist, is the checkpoint there); there is no state file.
# Prints one JSON line: { status, code, receipt, ... }.
#
# The drill machine is NOT a node to the service: it holds no production credential (the CI token, upgrade token and App key are
# generated inside the VM at every drill and die with the checkpoint restore), it is never registered, has no heartbeat link
# and is never in the failover list. Its role probe can only answer "unauthorized", so it stays UNCERTAIN, which starts nothing.
#
# Host boundary: writes only under D:\clued-drill\; touches only the VM whose name AND notes are ours; never touches the
# host services, scheduled tasks, switches, WSL distributions, or any process by name. Read the public host status and
# installed generation pointer. The installed Owner request CLI is the sole production request path. No elevation: the account
# must be in Hyper-V Administrators. Every wait is bounded; nothing is retried; a failed drill still restores the checkpoint.
# Host duty, CI activity and memory are checked before start and independently every 30 seconds while running.
[CmdletBinding()]
param(
  [string]$Version,
  [string]$From,
  [string]$Kit,
  [switch]$BaselineOnly,
  [switch]$PrereqOnly,
  [switch]$SkipReinstall,
  [switch]$Interactive,
  [ValidateRange(5, 240)][int]$InteractiveTimeoutMinutes = 120,
  [ValidateRange(5, 240)][int]$RunTimeoutMinutes = 70,
  [string]$Finalize,
  [string]$ProductionReadback
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$script:DrillScriptPath = $PSCommandPath
$script:HostGuard = $null

# ---------------------------------------------------------------- constants (the one place each fact lives)
$script:Drill = [ordered]@{
  Root = 'D:\clued-drill'
  VmName = 'clued-drill-win11'
  Marker = 'clued.drill-vm/1'
  Checkpoint = 'S0-clean-os'
  Iso = 'D:\clued-drill\iso\Win11_zh-cn_x64.iso'
  IsoExpectedSha = 'D:\clued-drill\iso\expected-sha256.txt'
  VmDir = 'D:\clued-drill\vm'
  Vhd = 'D:\clued-drill\vm\os.vhdx'
  AnswerDir = 'D:\clued-drill\vm\answer'
  AnswerIso = 'D:\clued-drill\vm\answer.iso'
  Credential = 'D:\clued-drill\guest-admin.clixml'
  Runs = 'D:\clued-drill\runs'
  GuestUser = 'drill'
  ComputerName = 'CLUED-DRILL'
  # Microsoft's published generic install key for Windows 11 Pro: it only selects the edition; the VM is never activated.
  ProProductKey = @('VK7JG', 'NPHTM', 'C97JM', '9MPGT', '3V66T') -join '-'
  MemoryBytes = 8GB
  # Keep production's workstation low-memory margin (Runner Runbook 2.2: 6 GiB) plus any VM memory still to allocate.
  ProductionReserveBytes = 6GB
  # The boot gate's margin over the guest and the running gate: passing the boot gate means the running gate still passes once the
  # guest is up, as long as the host's other usage grows by no more than this margin meanwhile (Fable renew-key ruling, supplement
  # "drill host memory" item 2). The boot gate is guest + running gate + this margin; nothing else holds the value. PROVISIONAL, to be recalibrated from the first receipt taken
  # under clean conditions (Fable, 2026-11-20). The receipts' "free at start - free after boot - guest 8 GB" (5.9 GB in run
  # 20261119T172257Z, 3.3 GB in run 20261119T030253Z) is not counted: it was the production WSL growing under a CI job of the host's
  # Actions runners, which the Runner.Worker refusal below now keeps from overlapping a boot.
  BootMarginBytes = 1GB
  HostGuardSeconds = 30
  HostStatusStaleSeconds = 300 # resident src/status.mjs: STATUS_STALE_MS
  HostStatus = 'C:\ProgramData\CluedIndependentCI\resident\state\status.json'
  IntakeHolder = 'drill'
  IntakeWaitMinutes = 40
  IntakeMarginMinutes = 10
  IntakeMaxMinutes = 120 # resident src/intake-pause.mjs: INTAKE_PAUSE_MAX_MS
  IntakePollSeconds = 5
  HostMutex = 'Global\CluedFirstInstallDrill'
  BootMutex = 'Global\CluedFirstInstallDrillBoot'
  MinDiskFreeBytes = 100GB
  VhdBytes = 80GB
  Cpu = 4; CpuMaximum = 75; CpuWeight = 50; MaxIops = 2000
  Switch = 'Default Switch'
  InstallTimeoutMinutes = 90
  # No logon attempt while Windows setup is still copying and rebooting: SetupComplete.cmd (written in specialize) runs when
  # setup hands over to OOBE and publishes one Hyper-V KVP item, read on the host without logging on (Msvm_KvpExchangeComponent).
  # From there Wait-DrillGuest's probes take over (ImageState IMAGE_STATE_COMPLETE, OOBEInProgress 0, the same boot twice).
  SetupSignalName = 'CluedDrillSetup'
  SetupSignalCommand = 'cmd.exe /c "if not exist %WINDIR%\Setup\Scripts mkdir %WINDIR%\Setup\Scripts & echo reg add "HKLM\SOFTWARE\Microsoft\Virtual Machine\Guest" /v CluedDrillSetup /t REG_SZ /d complete /f>%WINDIR%\Setup\Scripts\SetupComplete.cmd"'
  BootKeySeconds = 30
  GuestRoot = 'C:\ProgramData\CluedIndependentCI\resident'
  GuestWork = 'C:\drill'
  SelfcheckFreshMinutes = 30
  UnattendedRebootMinutes = 10
  KitContract = 'clued.drill.first-install-kit/1'
  PrereqDir = 'D:\clued-drill\prereq'
  PrereqContract = 'clued.drill.prereq/1'
  PrereqTimeoutMinutes = 40
  ReceiptContract = 'clued.independent-ci.drill-receipt/1'
  ReadbackContract = 'clued.drill.production-readback/1'
}

# A stop carries its code in the message so every catch reports one code (no free text from the guest reaches it).
function New-DrillError([string]$Code, $Detail = $null) {
  $e = [System.InvalidOperationException]::new("DRILL:$Code")
  $e.Data['drillCode'] = $Code; $e.Data['drillDetail'] = $Detail
  return $e
}
function Get-DrillCode($err) {
  $ex = $err; if ($err -is [System.Management.Automation.ErrorRecord]) { $ex = $err.Exception }
  while ($ex) { if ($ex.Data -and $ex.Data.Contains('drillCode')) { return @{ code = $ex.Data['drillCode']; detail = $ex.Data['drillDetail'] } }; $ex = $ex.InnerException }
  $m = if ($err -is [System.Management.Automation.ErrorRecord]) { $err.Exception.Message } else { [string]$err }
  return @{ code = 'DRILL_UNEXPECTED'; detail = ([string]$m).Substring(0, [Math]::Min(300, ([string]$m).Length)) }
}

function Get-Sha256Hex([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-TextSha256Hex([string]$Text) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function ConvertTo-DrillJson($Value) { $Value | ConvertTo-Json -Depth 12 -Compress }
function Read-DrillJson([string]$Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-DrillJson([string]$Path, $Value) {
  $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($tmp, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Get-Prop($Object, [string]$Path) {
  $cur = $Object
  foreach ($k in $Path.Split('.')) {
    if ($null -eq $cur) { return $null }
    if ($cur -is [System.Collections.IDictionary]) { if ($cur.Contains($k)) { $cur = $cur[$k] } else { return $null } }
    else { $p = $cur.PSObject.Properties[$k]; if ($null -eq $p) { return $null }; $cur = $p.Value }
  }
  return $cur
}

# ---------------------------------------------------------------- pure decisions (unit-tested offline)

function Test-DrillHostMemory([long]$FreeBytes, [long]$VmMemoryBytes = $script:Drill.MemoryBytes, [switch]$Running, [long]$MemoryAssigned = 0) {
  $target = [Math]::Max($script:Drill.MemoryBytes, $VmMemoryBytes)
  $vmFreeRequired = if ($Running) {
    # Hyper-V's assigned memory has already been deducted from the host's free memory.
    [Math]::Max(0L, $target - $MemoryAssigned)
  } else {
    [Math]::Max($target, $MemoryAssigned) + $script:Drill.BootMarginBytes
  }
  $required = $vmFreeRequired + $script:Drill.ProductionReserveBytes
  return @{ ok = ($FreeBytes -ge $required); code = $(if ($FreeBytes -lt $required) { 'DRILL_HOST_MEMORY_SHORT' } else { $null });
    freeGB = [Math]::Round($FreeBytes / 1GB, 1); requiredFreeBytes = $required }
}

# An Actions self-hosted runner executes each job in a Runner.Worker process (its Runner.Listener only waits for work). Judged from the
# host's process list, not from runner names: how many runners the host has and what they are called is read from the machine.
function Test-DrillHostRunnerJob([string[]]$ProcessNames) {
  return @($ProcessNames | Where-Object { $_ -ieq 'Runner.Worker' }).Count -gt 0
}

function ConvertTo-DrillTimestamp($Value) {
  # ConvertFrom-Json can supply a DateTime in PowerShell 7.
  if ($Value -is [DateTime]) {
    if ($Value.Kind -ne [DateTimeKind]::Unspecified) { return [DateTimeOffset]$Value }
    return
  }
  $timestamp = [DateTimeOffset]::MinValue
  if ($Value -is [string] -and $Value -cmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$' -and
    [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$timestamp)) { return $timestamp }
}

function Test-DrillHostStatusFresh($WrittenAt, [DateTimeOffset]$Now) {
  $timestamp = ConvertTo-DrillTimestamp $WrittenAt
  if ($null -eq $timestamp) { return $false }
  $ageSeconds = ($Now - $timestamp).TotalSeconds
  return $ageSeconds -le $script:Drill.HostStatusStaleSeconds -and $ageSeconds -ge -60
}

# An absolute deadline keeps the required hold from moving forward at each poll.
# Without a deadline this is the standby-only gate (baseline installation and runs that did not request a hold).
# A drill hold leaves the parked stage-8 tries and revoke-only train maintenance on the Windows side.
function Test-DrillHostSafety([string]$StatusJson, [long]$FreeBytes, [switch]$Running, [long]$VmMemoryBytes = $script:Drill.MemoryBytes,
  [long]$MemoryAssigned = 0, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
  [DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue, [string[]]$ProcessNames = @()) {
  $memory = Test-DrillHostMemory $FreeBytes $VmMemoryBytes -Running:$Running -MemoryAssigned $MemoryAssigned
  $code = 'DRILL_HOST_STATUS_UNREADABLE'
  $mode = $null; $since = $null; $until = $null; $busyWith = $null
  $executorObservation = $null
  try {
    if (-not $StatusJson.TrimStart().StartsWith('{')) { throw 'expected a status object' }
    $s = ConvertFrom-Json -InputObject $StatusJson -ErrorAction Stop
    $reportedMode = $s.node.mode; $executor = $s.executor.state
    if ($reportedMode -is [string] -and $reportedMode -cin @('ACTIVE', 'STANDBY') -and
        $null -ne $s.PSObject.Properties['current'] -and $executor -is [string]) {
      $code = 'DRILL_HOST_STATUS_STALE'
      $writtenAt = $s.PSObject.Properties['writtenAt']
      if ($writtenAt -and (Test-DrillHostStatusFresh $writtenAt.Value $Now)) {
        $mode = $reportedMode
        $reason = $s.executor.PSObject.Properties['reason']
        $executorObservation = [ordered]@{
          state = $executor
          reason = $(if ($reason -and $reason.Value -is [string]) { $reason.Value } else { $null })
          current = $null
        }
        if ($null -ne $s.current) {
          $stageProperty = $s.current.PSObject.Properties['stage']
          $phaseProperty = $s.current.PSObject.Properties['phase']
          $executorObservation.current = [ordered]@{
            stage = $(if ($stageProperty -and ($stageProperty.Value -is [int] -or $stageProperty.Value -is [long])) { $stageProperty.Value } else { $null })
            phase = $(if ($phaseProperty -and $phaseProperty.Value -is [string]) { $phaseProperty.Value } else { $null })
          }
        }
        $pause = $s.PSObject.Properties['intakePause']
        $holders = if ($pause -and $pause.Value -is [pscustomobject]) { $pause.Value.PSObject.Properties['holders'] }
        $drillHolds = @()
        if ($holders -and $holders.Value -is [array]) {
          $drillHolds = @($holders.Value | Where-Object {
            $_ -and $_.PSObject.Properties['holder'] -and $_.holder -is [string] -and $_.holder -ceq $script:Drill.IntakeHolder
          })
        }
        if ($drillHolds.Count -eq 1) {
          $h = $drillHolds[0]
          if ($h.PSObject.Properties['since']) { $since = ConvertTo-DrillTimestamp $h.since }
          if ($h.PSObject.Properties['until']) { $until = ConvertTo-DrillTimestamp $h.until }
        }
        $quiet = $executor -cin @('IDLE', 'WAITING', 'DEFERRED', 'HALTED', 'PAUSED', 'BACKFILL_PENDING', 'STOPPED',
          'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED')
        $stage8 = $false
        if ($mode -ceq 'ACTIVE' -and $s.executor -is [pscustomobject]) {
          $maintenance = $executor -ceq 'RUNNING' -and $null -ne $reason -and
            $reason.Value -is [string] -and $reason.Value -ceq 'TRAIN_MAINTENANCE'
          $quiet = $quiet -or $executor -ceq 'PARKED' -or $maintenance

          # resumeParkedB's start checks leave the status board alone. atStage publishes stage and phase together.
          $runningBatch = $executor -ceq 'RUNNING' -and $null -ne $reason -and $null -eq $reason.Value
          if ($Running -and $s.current -is [pscustomobject] -and ($quiet -or $runningBatch) -and
              $s.current.PSObject.Properties['stage'] -and $s.current.PSObject.Properties['phase']) {
            $stage = $s.current.stage
            $phase = $s.current.phase
            $stage8 = ($stage -is [int] -or $stage -is [long]) -and $stage -eq 8 -and
              $phase -is [string] -and $phase -ceq 'stage'
          }
        }
        if (-not (($quiet -and $null -eq $s.current) -or $stage8)) {
          $code = if ($executor -cin @('RUNNING', 'PARKED') -or $null -ne $s.current) { 'DRILL_HOST_CI_BUSY' }
            else { 'DRILL_HOST_STATUS_UNREADABLE' }
        }
        elseif ($mode -ceq 'ACTIVE' -and ($HoldUntil -le $Now -or $null -eq $since -or $since -gt $Now -or
          $null -eq $until -or $until -lt $HoldUntil -or $until -gt $Now.AddMinutes($script:Drill.IntakeMaxMinutes))) {
          $code = 'DRILL_HOST_IS_ON_DUTY'
        }
        # Before boot only (Clued Task e71ceb33): the hold does not cover the host's Actions runners, and a job they pick up after the
        # boot is left to the running memory gate.
        elseif (-not $Running -and (Test-DrillHostRunnerJob $ProcessNames)) { $code = 'DRILL_HOST_CI_BUSY'; $busyWith = 'ACTIONS_RUNNER_JOB' }
        else { $code = $memory.code }
      }
    }
  } catch { $code = 'DRILL_HOST_STATUS_UNREADABLE' }
  return @{ ok = ($null -eq $code); code = $code; busyWith = $busyWith; mode = $mode; holdSince = $since; holdUntil = $until;
    freeGB = $memory.freeGB; requiredFreeBytes = $memory.requiredFreeBytes;
    executorObservation = $executorObservation; observedAt = $Now.ToUniversalTime().ToString('o');
    action = $(if ($code) { if ($Running) { 'abort' } else { 'refuse' } } else { if ($Running) { 'continue' } else { 'start' } }) }
}

# What to do with the VM named ours. $Vm: $null or @{ notes; state; checkpoints = @(names) }.
#   ready    the VM is ours, Off, and has the clean-OS checkpoint
#   build    no VM by that name: build the baseline
#   rebuild  ours but without the checkpoint (a baseline build that did not finish): remove it and build again
#   refuse   a VM by that name that is not ours (DRILL_VM_NAME_TAKEN_NOT_OURS), or ours and not Off (DRILL_VM_NOT_OFF)
function Get-DrillBaselineAction($Vm) {
  if ($null -eq $Vm) { return @{ action = 'build'; code = $null } }
  if ([string]$Vm.notes -cne $script:Drill.Marker) { return @{ action = 'refuse'; code = 'DRILL_VM_NAME_TAKEN_NOT_OURS' } }
  if ([string]$Vm.state -ne 'Off') { return @{ action = 'refuse'; code = 'DRILL_VM_NOT_OFF' } }
  if (@($Vm.checkpoints) -contains $script:Drill.Checkpoint) { return @{ action = 'ready'; code = $null } }
  return @{ action = 'rebuild'; code = $null }
}

# Guest readiness from successive probes (@{ boot; imageState; oobe }, $null when PowerShell Direct does not answer).
# Ready = Windows setup and OOBE are finished (ImageState IMAGE_STATE_COMPLETE, OOBEInProgress 0), the boot is after $After, and
# the same boot answers ready on two probes in a row. The local account, and so PowerShell Direct, works from the middle of OOBE
# on, and OOBE still restarts the machine after that: the first real baseline (2026-11-16 10:29) took that answer for "installed"
# and its next step died with "the system is shutting down".
function Step-DrillReadiness($Previous, $Probe, [DateTimeOffset]$After) {
  if ($null -eq $Probe) { return @{ ready = $false; candidate = $null } }
  $boot = [DateTimeOffset]::Parse([string]$Probe.boot, [Globalization.CultureInfo]::InvariantCulture)
  $settled = ([string]$Probe.imageState -ceq 'IMAGE_STATE_COMPLETE') -and ([int]$Probe.oobe -eq 0) -and ($boot -gt $After)
  if (-not $settled) { return @{ ready = $false; candidate = $null } }
  $id = $boot.ToUniversalTime().ToString('o')
  return @{ ready = ($null -ne $Previous -and [string]$Previous -ceq $id); candidate = $id }
}

# The value of KVP item $Name among Msvm_KvpExchangeComponent.GuestExchangeItems (each an Msvm_KvpExchangeDataItem as XML).
function Get-DrillKvpValue([string[]]$Items, [string]$Name) {
  foreach ($item in @($Items)) {
    try { $x = [xml]$item } catch { continue }
    $props = @($x.SelectNodes('/INSTANCE/PROPERTY'))
    $n = @($props | Where-Object { $_.GetAttribute('NAME') -ceq 'Name' })
    $d = @($props | Where-Object { $_.GetAttribute('NAME') -ceq 'Data' })
    if ($n.Count -eq 1 -and $d.Count -eq 1 -and [string]$n[0].InnerText -ceq $Name) { return [string]$d[0].InnerText }
  }
  return $null
}

# Why a guest step failed, from the boot time before it and the boot time once the guest is ready again ('' = never ready).
function Get-DrillStepFailureKind([string]$BootBefore, [string]$BootAfter) {
  if ([string]::IsNullOrEmpty($BootAfter)) { return 'unreachable' }
  if ([string]::IsNullOrEmpty($BootBefore)) { return 'restarted' }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  if ([DateTimeOffset]::Parse($BootAfter, $inv) -ne [DateTimeOffset]::Parse($BootBefore, $inv)) { return 'restarted' }
  return 'failed'
}

# The ISO is used only when its sha256 equals the expected value written next to it (the download's single source of truth).
function Test-DrillIsoHash([string]$Actual, [string]$ExpectedText) {
  $expected = ([string]$ExpectedText).Trim().Split()[0].ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-f]{64}$') { return @{ ok = $false; code = 'DRILL_ISO_EXPECTED_SHA_UNREADABLE' } }
  if ($Actual -cne $expected) { return @{ ok = $false; code = 'DRILL_ISO_HASH_MISMATCH'; expected = $expected; actual = $Actual } }
  return @{ ok = $true; code = $null; sha256 = $expected }
}

function ConvertTo-XmlText([string]$s) { [Security.SecurityElement]::Escape($s) }

# The answer file: GPT disk, Windows 11 Pro chosen by the generic key, zh-CN, local admin, no online account, no auto-logon.
function New-DrillAutounattend([string]$Password) {
  if ([string]::IsNullOrEmpty($Password)) { throw (New-DrillError 'DRILL_ANSWER_PASSWORD_EMPTY') }
  $amd = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"'
  $locale = '<InputLocale>0804:00000804</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale>'
  $pw = ConvertTo-XmlText $Password
  @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" $amd>
      <SetupUILanguage><UILanguage>zh-CN</UILanguage></SetupUILanguage>
      $locale
    </component>
    <component name="Microsoft-Windows-Setup" $amd>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><Key>$($script:Drill.ProProductKey)</Key><WillShowUI>OnError</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" $amd>
      <ComputerName>$($script:Drill.ComputerName)</ComputerName>
      <TimeZone>China Standard Time</TimeZone>
    </component>
    <component name="Microsoft-Windows-Deployment" $amd>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>setup-complete signal to the host (Hyper-V KVP), written by SetupComplete.cmd once OOBE is over</Description>
          <Path>$(ConvertTo-XmlText $script:Drill.SetupSignalCommand)</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" $amd>
      $locale
    </component>
    <component name="Microsoft-Windows-Shell-Setup" $amd>
      <OOBE>
        <HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$($script:Drill.GuestUser)</Name><Group>Administrators</Group>
            <Password><Value>$pw</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
    </component>
  </settings>
</unattend>
"@
}

# A small ISO holding only autounattend.xml, built with Windows' own IMAPI2 (no ADK, no elevation). Windows Setup reads the
# Joliet name from any removable drive. Never overwrites: the target must not exist.
function New-DrillAnswerIso([string]$SourceDir, [string]$IsoPath) {
  if (-not ('DrillIsoWriter' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class DrillIsoWriter {
  public static long Write(object stream, string path) {
    IStream s = (IStream)stream; long total = 0;
    using (FileStream f = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) {
      byte[] buf = new byte[65536]; IntPtr p = Marshal.AllocHGlobal(4);
      try { while (true) { s.Read(buf, buf.Length, p); int n = Marshal.ReadInt32(p); if (n <= 0) break; f.Write(buf, 0, n); total += n; } }
      finally { Marshal.FreeHGlobal(p); }
    }
    return total;
  }
}
'@
  }
  $fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $fsi.FileSystemsToCreate = 3   # ISO9660 + Joliet
  $fsi.VolumeName = 'CLUEDANSWER'
  $fsi.Root.AddTree($SourceDir, $false)
  [void][DrillIsoWriter]::Write($fsi.CreateResultImage().ImageStream, $IsoPath)
  return $IsoPath
}

# The release triple (fetch.mjs names): the tar is accepted only when its sha256 equals SHA256SUMS and the acceptance file.
# A candidate (Fable ruling 11-19 section 2.3: the drill runs BEFORE the Owner accepts): the From directory has no acceptance and the
# kit carries the candidate's own (make-drill-kit.mjs candidateAcceptance, for the guest only); the run is held to the three hashes the
# kit names and the receipt says candidate: true with them. A candidate kit with an Owner's acceptance in From is refused (which one?).
function Test-DrillPackageDir([string]$Dir, [string]$Version, $KitInfo = $null) {
  if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.\-]{0,63}$') { throw (New-DrillError 'DRILL_VERSION_REFUSED') }
  $tag = "fleet-node-$Version"
  $tar = Join-Path $Dir "$tag.tar"; $acc = Join-Path $Dir "$tag.acceptance.json"; $sums = Join-Path $Dir 'SHA256SUMS'
  $candidate = Get-Prop $KitInfo 'candidate'
  if ($null -ne $candidate) {
    if (Test-Path -LiteralPath $acc) { throw (New-DrillError 'DRILL_CANDIDATE_KIT_BUT_FROM_HAS_AN_ACCEPTANCE' ([IO.Path]::GetFileName($acc))) }
    $acc = [string](Get-Prop $candidate 'acceptance')
  }
  foreach ($f in @($tar, $acc, $sums)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw (New-DrillError 'DRILL_PACKAGE_FILE_MISSING' ([IO.Path]::GetFileName($f))) } }
  $sha = Get-Sha256Hex $tar
  $acceptance = Read-DrillJson $acc
  if ([string](Get-Prop $acceptance 'contract') -cne 'clued.independent-ci.fleet-node-acceptance/1' -or [string](Get-Prop $acceptance 'version') -cne $Version) { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED') }
  if ([string](Get-Prop $acceptance 'archive_sha256') -cne $sha) { throw (New-DrillError 'DRILL_TAR_NOT_THE_ACCEPTED_ONE' @{ actual = $sha }) }
  $line = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match "^[0-9a-f]{64}\s+\*?$([regex]::Escape("$tag.tar"))$" })
  if ($line.Count -ne 1 -or $line[0].Substring(0, 64) -cne $sha) { throw (New-DrillError 'DRILL_TAR_NOT_IN_SHA256SUMS') }
  $source = [string](Get-Prop $acceptance 'ciSourceManifestSha256')
  if ($source -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED' 'ciSourceManifestSha256') }
  $kitSha = [string](Get-Prop $acceptance 'firstInstallKitSha256')
  if ($null -ne $candidate -and ($sha -cne [string](Get-Prop $candidate 'tarSha256') -or $source -cne [string](Get-Prop $candidate 'ciSourceManifestSha256') -or
      $kitSha -cne [string](Get-Prop $candidate 'firstInstallKitSha256'))) { throw (New-DrillError 'DRILL_CANDIDATE_NOT_THE_KITS') }
  return [ordered]@{ version = $Version; tar = $tar; acceptance = $acc; sums = $sums; tarSha256 = $sha; ciSourceManifestSha256 = $source
    firstInstallKitSha256 = $kitSha; candidate = ($null -ne $candidate) }
}

# The first-install kit (kit.json, contract clued.drill.first-install-kit/1): every file pinned by sha256; one entry run in the
# guest with only the fixed placeholders {from} {kit} {fake} {work} {version} (no node value can be passed); perNodeSteps names
# the manual per-node steps the kit still stands in for (A10 passes only when it is empty, i.e. after the universal first install).
function Read-DrillKit([string]$Dir) {
  $file = Join-Path $Dir 'kit.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw (New-DrillError 'DRILL_FIRST_INSTALL_KIT_MISSING') }
  $kit = Read-DrillJson $file
  if ([string](Get-Prop $kit 'contract') -cne $script:Drill.KitContract) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'contract') }
  $files = @(Get-Prop $kit 'files')
  if ($files.Count -lt 1) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'files') }
  $root = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
  $seen = @{}
  foreach ($f in $files) {
    $rel = [string](Get-Prop $f 'path'); $want = [string](Get-Prop $f 'sha256')
    if ($rel -notmatch '^[A-Za-z0-9._+~\-\\]+$' -or $rel -match '(^|\\)\.\.(\\|$)' -or $want -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "file $rel") }
    $full = [IO.Path]::GetFullPath((Join-Path $Dir $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw (New-DrillError 'DRILL_KIT_REFUSED' "file $rel") }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw (New-DrillError 'DRILL_KIT_FILE_MISSING' $rel) }
    if ((Get-Sha256Hex $full) -cne $want) { throw (New-DrillError 'DRILL_KIT_FILE_CHANGED' $rel) }
    $seen[$rel.ToLowerInvariant()] = $true
  }
  $entry = Get-Prop $kit 'entry'
  $entryFile = [string](Get-Prop $entry 'file')
  if (-not $seen.ContainsKey($entryFile.ToLowerInvariant()) -or $entryFile -notmatch '\.ps1$') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'entry.file') }
  $kitArgs = @(Get-Prop $entry 'arguments')
  foreach ($a in $kitArgs) {
    $s = [string]$a
    if ($s -notmatch '^(-[A-Za-z][A-Za-z0-9]*|\{(from|kit|fake|work|version)\})$') { throw (New-DrillError 'DRILL_KIT_ARGUMENT_REFUSED' $s) }
  }
  $timeout = Get-Prop $kit 'timeoutMinutes'
  if (-not ($timeout -is [int] -or $timeout -is [long]) -or $timeout -lt 5 -or $timeout -gt 240) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'timeoutMinutes') }
  if ($null -eq $kit.PSObject.Properties['perNodeSteps']) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'perNodeSteps') }
  $perNode = @($kit.perNodeSteps | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  $prereqSha = [string](Get-Prop $kit 'prereqSha256')
  if ($prereqSha -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'prereqSha256') }
  $mode = [string](Get-Prop $kit 'prerequisiteMode')
  if ($mode -and $mode -cne 'first-install-host') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'prerequisiteMode') }
  if ($mode -and -not $seen.ContainsKey('release-pins.json')) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'release-pins.json') }
  $blocker = [string](Get-Prop $kit 'executionBlocker')
  # a candidate's kit (make-drill-kit.mjs): its acceptance is one of the kit's pinned files, and the three hashes it names
  $candidate = $null; $c = Get-Prop $kit 'candidate'
  if ($null -ne $c) {
    $accName = [string](Get-Prop $c 'acceptance')
    if ($accName -cnotmatch '^fleet-node-[0-9A-Za-z][0-9A-Za-z.\-]{0,63}\.acceptance\.json$' -or -not $seen.ContainsKey($accName.ToLowerInvariant())) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'candidate.acceptance') }
    $candidate = [ordered]@{ acceptance = (Join-Path $Dir $accName) }
    foreach ($k in @('tarSha256', 'ciSourceManifestSha256', 'firstInstallKitSha256')) {
      $v = [string](Get-Prop $c $k); if ($v -cnotmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "candidate.$k") }
      $candidate[$k] = $v
    }
  }
  return [ordered]@{ dir = $Dir; sha256 = (Get-Sha256Hex $file); entryFile = $entryFile; arguments = @($kitArgs | ForEach-Object { [string]$_ }); timeoutMinutes = [int]$timeout; perNodeSteps = $perNode; prereqSha256 = $prereqSha; prerequisiteMode = $mode; executionBlocker = $blocker; candidate = $candidate }
}

# A generated kit binds the complete Release directory, not just the old package triple.
# Validate before touching Hyper-V; entry validates these pins again after PowerShell Direct copy.
function Get-DrillReleaseFiles($Package, $KitInfo) {
  if ($KitInfo.prerequisiteMode -cne 'first-install-host') { return @($Package.tar, $Package.acceptance, $Package.sums) }
  $pins = Read-DrillJson (Join-Path $KitInfo.dir 'release-pins.json')
  if ([string](Get-Prop $pins 'version') -cne $Package.version) { throw (New-DrillError 'DRILL_RELEASE_VERSION_MISMATCH') }
  $root = Split-Path -Parent $Package.tar; $seen = @{}; $files = @(); $inRoot = 0
  # a candidate's acceptance is the kit's (Test-DrillPackageDir), every other asset is From's
  $candidateAcceptance = if ($Package['candidate']) { [IO.Path]::GetFileName($Package.acceptance) } else { $null }
  foreach ($f in @(Get-Prop $pins 'files')) {
    $name = [string](Get-Prop $f 'path'); $hash = [string](Get-Prop $f 'sha256')
    if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$' -or $hash -cnotmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($name)) { throw (New-DrillError 'DRILL_RELEASE_PINS_REFUSED') }
    $seen[$name] = $true
    $file = if ($name -ceq $candidateAcceptance) { $Package.acceptance } else { $inRoot++; Join-Path $root $name }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Sha256Hex $file) -cne $hash) { throw (New-DrillError 'DRILL_RELEASE_ASSET_CHANGED' $name) }
    $files += $file
  }
  foreach ($file in @($Package.tar, $Package.acceptance, $Package.sums)) {
    if (-not $seen.ContainsKey([IO.Path]::GetFileName($file))) { throw (New-DrillError 'DRILL_RELEASE_PINS_REFUSED') }
  }
  if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne $inRoot) { throw (New-DrillError 'DRILL_RELEASE_UNLISTED_ASSET') }
  return $files
}

# The prerequisites a new node needs before the first install (plan 1.2; Owner approved 11-16): the WSL package, the Ubuntu
# 24.04 WSL image and the .deb closure of docker.io, all downloaded once from their official sources into D:\clued-drill\prereq
# and pinned in prereq.json (contract clued.drill.prereq/1, one place for these pins; the kit names it by sha256). The drill
# injects them into the VM: nothing is downloaded inside the VM, so every drill starts from the same bytes.
function Read-DrillPrereq([string]$Dir) {
  $file = Join-Path $Dir 'prereq.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw (New-DrillError 'DRILL_PREREQ_MISSING') }
  $p = Read-DrillJson $file
  if ([string](Get-Prop $p 'contract') -cne $script:Drill.PrereqContract) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'contract') }
  $distro = [string](Get-Prop $p 'distribution')
  if ($distro -notmatch '^[A-Za-z][A-Za-z0-9._-]{0,63}$') { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'distribution') }
  $root = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
  $check = {
    param($f, [string]$what, [string]$suffix)
    $rel = [string](Get-Prop $f 'path'); $want = [string](Get-Prop $f 'sha256'); $url = [string](Get-Prop $f 'url')
    if ($rel -notmatch '^[A-Za-z0-9._+~\-\\]+$' -or $rel -match '(^|\\)\.\.(\\|$)' -or -not $rel.EndsWith($suffix) -or $want -notmatch '^[0-9a-f]{64}$' -or $url -notmatch '^https?://(github\.com/microsoft/WSL/|releases\.ubuntu\.com/|archive\.ubuntu\.com/ubuntu/|security\.ubuntu\.com/ubuntu/)') {
      throw (New-DrillError 'DRILL_PREREQ_REFUSED' "$what $rel") }
    $full = [IO.Path]::GetFullPath((Join-Path $Dir $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' "$what $rel") }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw (New-DrillError 'DRILL_PREREQ_FILE_MISSING' $rel) }
    if ((Get-Sha256Hex $full) -cne $want) { throw (New-DrillError 'DRILL_PREREQ_FILE_CHANGED' $rel) }
    return $rel
  }
  $wsl = & $check (Get-Prop $p 'wsl') 'wsl' '.msi'
  $rootfs = & $check (Get-Prop $p 'rootfs') 'rootfs' '.wsl'
  $debs = @(Get-Prop $p 'debs')
  if ($debs.Count -lt 1) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'debs') }
  $debPaths = @($debs | ForEach-Object { & $check $_ 'deb' '.deb' })
  if (@($debPaths | Where-Object { $_ -notmatch '^debs\\[^\\]+$' }).Count) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'debs live in debs\') }
  return [ordered]@{ dir = $Dir; sha256 = (Get-Sha256Hex $file); distribution = $distro; wsl = $wsl; rootfs = $rootfs; debs = $debPaths; wslVersion = [string](Get-Prop $p 'wsl.version') }
}

# Inside the VM (elevated PowerShell Direct session): install the pinned WSL package, register the pinned Ubuntu image under the
# prerequisite distribution name, install the pinned .deb closure offline and confirm docker.service runs under systemd.
# Returns facts only; the host judges them. Never downloads: dpkg installs exactly the pinned files. (apt-get, even with
# --no-download, resolved against the apt lists the Ubuntu image ships and wanted archives from the network: 2026-11-16 12:58.)
$script:GuestPrereq = {
  param($Dir, $Wsl, $Rootfs, $Distro, $WslVersion, $NativeText)
  $ErrorActionPreference = 'Stop'
  $native = [scriptblock]::Create($NativeText)
  $wslExe = "$env:SystemRoot\System32\wsl.exe"
  # Every child here is read apart (Invoke-DrillNative) and kept in the facts, a refusal included: a refusal returns the facts with its
  # code in `failure` (the host writes them, then stops by that code), never a bare exception (Codex review of 58136df61, medium 3).
  # wsl's own output is UTF-16LE (the package reads wsl --version so: first-install-host.ps1); the MSI writes its log to wsl-msi.log.
  $f = [ordered]@{ failure = $null; distribution = $Distro }
  $msiLog = Join-Path $Dir 'wsl-msi.log'
  $mi = & $native "$env:SystemRoot\System32\msiexec.exe" @('/i', (Join-Path $Dir $Wsl), '/qn', '/norestart', '/L*v', $msiLog) 1800
  $f.msi = [ordered]@{ exit = $mi.exit; stdout = $mi.stdout; stderr = $mi.stderr; logTail = @(if (Test-Path -LiteralPath $msiLog -PathType Leaf) { Get-Content -LiteralPath $msiLog -Tail 40 | ForEach-Object { [string]$_ } }) }
  if ($mi.exit -notin @(0, 3010)) { $f.failure = "PREREQ_WSL_MSI_EXIT_$($mi.exit)"; return $f }
  $vr = & $native $wslExe @('--version') 120 'utf-16'
  $ver = (@($vr.stdout -split "`r?`n" | Where-Object { $_ -ne '' }) -join ' ')
  $f.wslVersion = $ver; $f.wslVersionRun = [ordered]@{ exit = $vr.exit; stderr = $vr.stderr }
  if ($WslVersion -and $ver -notmatch [regex]::Escape($WslVersion)) { $f.failure = 'PREREQ_WSL_VERSION_NOT_PINNED'; return $f }
  $ir = & $native $wslExe @('--install', '--from-file', (Join-Path $Dir $Rootfs), '--name', $Distro, '--no-launch') 1800 'utf-16'
  $f.install = [ordered]@{ exit = $ir.exit; stdout = $ir.stdout; stderr = $ir.stderr }
  if ($ir.exit -ne 0) { $f.failure = "PREREQ_DISTRO_INSTALL_EXIT_$($ir.exit)"; return $f }
  # --exec: the arguments go to env as they are (with `--` WSL runs the command line through root's shell, which split the
  # bash -c text at its | and ; - 2026-11-16 13:07). stdout and stderr apart (Invoke-DrillNative): the stdout lines are judged as data,
  # stderr is kept beside them.
  $root = { param([string]$cmd) $n = & $native $wslExe @('-d', $Distro, '-u', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C', 'LC_ALL=C', 'DEBIAN_FRONTEND=noninteractive', '/bin/bash', '-c', $cmd) 3600
    [ordered]@{ exit = $n.exit; out = @($n.stdout -split "`r?`n" | Where-Object { $_ -ne '' }); err = $n.stderr } }
  $debDir = '/mnt/' + $Dir.Substring(0, 1).ToLowerInvariant() + ($Dir.Substring(2) -replace '\\', '/') + '/debs'
  $dpkg = & $root "dpkg -i --force-confold $debDir/*.deb 2>&1 | tail -n 25; echo DPKG_EXIT=`${PIPESTATUS[0]}; echo AUDIT=`$(dpkg --audit | wc -l)"
  $dpkgExit = @($dpkg.out | Where-Object { $_ -match '^DPKG_EXIT=(\d+)$' } | ForEach-Object { [int]$Matches[1] }) | Select-Object -Last 1
  $audit = @($dpkg.out | Where-Object { $_ -match '^AUDIT=(\d+)$' } | ForEach-Object { [int]$Matches[1] }) | Select-Object -Last 1
  $facts = & $root "for i in `$(seq 1 30); do systemctl is-active --quiet docker.service && break; sleep 2; done; grep ^PRETTY_NAME /usr/lib/os-release; ps -p 1 -o comm=; systemctl is-active docker.service; dpkg-query -W -f='`${Package} `${Version}\n' docker.io containerd runc"
  $f.dpkgExit = $dpkgExit; $f.dpkgAuditLines = $audit; $f.dpkgTail = @($dpkg.out); $f.dpkgStderr = $dpkg.err; $f.facts = $facts.out; $f.factsStderr = $facts.err
  $f.dockerActive = (@($facts.out) -contains 'active'); $f.systemdPid1 = (@($facts.out) -contains 'systemd')
  $f
}

# The kit entry's arguments with the fixed guest paths in place.
function Resolve-DrillKitArguments([string[]]$Arguments, [hashtable]$Paths) {
  @($Arguments | ForEach-Object { $a = $_; if ($a -match '^\{(\w+)\}$') { [string]$Paths[$Matches[1]] } else { $a } })
}

# The kit entry's last stdout line: { status, stopCode, tree, node } (A1 reads stopCode; A8 needs tree and node).
function Read-DrillEntryResult([string[]]$Lines, [int]$ExitCode) {
  $last = @($Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -Last 1
  $doc = $null; if ($last) { try { $doc = $last | ConvertFrom-Json } catch { $doc = $null } }
  return [ordered]@{ exitCode = $ExitCode; status = [string](Get-Prop $doc 'status'); stopCode = (Get-Prop $doc 'stopCode'); tree = [string](Get-Prop $doc 'tree'); node = [string](Get-Prop $doc 'node'); parsed = ($null -ne $doc) }
}

# A property by its exact name (Get-Prop splits a path on '.', and these names are file names).
function Get-DrillField($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] }; return $null }
  $p = $Object.PSObject.Properties[$Name]; if ($null -eq $p) { return $null }; return $p.Value
}

# The first install's step record (Fable renew-key ruling, supplements "companion account and evidence" section 2.3 and "package branch,
# two points"): steps come from COMPLETE stdout logs only -- the entry's (first-install.log), the host preparation's (host.stdout.log) and
# the launcher stage's (launcher.stdout.log). A stage result file (host-result.json keeps only the last 6000 characters of the output)
# gives its verdict line and never steps, so a long record cut at its head is not read as "the earlier steps did not run": a stage that
# ran (its result file is there) without its complete log is "incomplete". A step line is one JSON object with a name (older lines: step)
# and a result, and a rejectCode when refused. Nothing parsed is "missing", never a pass; no verdict line (a run cut off) is said so.
function ConvertFrom-DrillFirstInstallSteps($Logs, $StageEvidence) {
  $steps = New-Object System.Collections.ArrayList
  $read = {
    param([string]$Stage, [string]$Text)
    $n = 0
    foreach ($line in @($Text -split "`r?`n")) {
      $t = $line.Trim()
      if (-not $t.StartsWith('{')) { continue }
      $o = $null
      try { $o = $t | ConvertFrom-Json } catch { continue }
      if ($o -isnot [pscustomobject]) { continue }
      $name = Get-DrillField $o 'name'
      if ($name -isnot [string]) { $name = Get-DrillField $o 'step' }
      if ($name -isnot [string] -or -not $name -or $null -eq $o.PSObject.Properties['result']) { continue }
      $reject = Get-DrillField $o 'rejectCode'
      if ($reject -isnot [string] -or -not $reject) { $reject = $null }
      [void]$steps.Add([ordered]@{ stage = $Stage; name = $name; result = $o.result; rejectCode = $reject; detail = (Get-DrillField $o 'detail') })
      $n++
    }
    $n
  }
  $stages = [ordered]@{ entry = $null; host = $null; prepare = $null; launcher = $null }
  foreach ($stage in @('entry', 'host', 'prepare', 'launcher')) { $text = Get-DrillField $Logs $stage; if ($text -is [string]) { $stages[$stage] = & $read $stage $text } }
  # A stage ran when its result file or its log is there. It is incomplete (Codex review of 1cedea9ef, medium 2) when its log is missing
  # or empty, holds no step line (only its verdict), or ends without its verdict line -- the stage gave no verdict (cut off, a timeout):
  # what that log holds is read all the same, never taken for the whole record.
  $stageVerdicts = [ordered]@{ host = $null; launcher = $null }; $incomplete = @(); $reasons = [ordered]@{}; $noStageVerdict = @()
  foreach ($pair in @(@('host', 'host-result.json'), @('launcher', 'launcher-result.json'))) {
    $stage = $pair[0]
    $result = Get-DrillField $StageEvidence $pair[1]
    $text = Get-DrillField $Logs $stage
    if ($null -eq $result -and $text -isnot [string]) { continue }
    $s = Get-DrillField (Get-DrillField $result 'terminal') 'status'
    if ($s -is [string] -and $s) { $stageVerdicts[$stage] = $s }
    $why = @()
    if ($text -isnot [string]) { $why += 'log-missing' }
    elseif ([string]::IsNullOrWhiteSpace($text)) { $why += 'log-empty' }
    else {
      if ($stages[$stage] -eq 0) { $why += 'no-step-lines' }
      $tail = @($text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -Last 1
      $doc = $null; try { $doc = $tail | ConvertFrom-Json } catch { $doc = $null }
      $logVerdict = Get-DrillField $doc 'status'
      if ($logVerdict -isnot [string] -or -not $logVerdict) { $why += 'no-verdict'; $noStageVerdict += $stage }
    }
    if ($why.Count) { $incomplete += $stage; $reasons[$stage] = $why }
  }
  $verdict = $null
  $entryText = Get-DrillField $Logs 'entry'
  $last = if ($entryText -is [string]) { @($entryText -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -Last 1 }
  if ($last) {
    $doc = $null
    try { $doc = $last | ConvertFrom-Json } catch { $doc = $null }
    $status = Get-DrillField $doc 'status'
    if ($status -is [string] -and $status) { $verdict = [ordered]@{ status = $status; stopCode = (Get-DrillField $doc 'stopCode') } }
  }
  # Codex review of c1497e0a1, high 1: a later stage reached, or an entry that says done, says the earlier stages ran (host preparation,
  # then prepare, then the launcher stage). An earlier stage with neither its log nor its result is then incomplete too (no-evidence).
  $order = @('host', 'prepare', 'launcher')
  $ranStage = @{}
  foreach ($st in $order) { $ranStage[$st] = ($null -ne (Get-DrillField $StageEvidence ($st + '-result.json'))) -or ((Get-DrillField $Logs $st) -is [string]) }
  $entryDone = ($null -ne $verdict) -and ([string]$verdict.status -ceq 'FIRST_INSTALL_DONE')
  for ($i = 0; $i -lt $order.Count; $i++) {
    $laterRan = $entryDone
    for ($j = $i + 1; $j -lt $order.Count; $j++) { if ($ranStage[$order[$j]]) { $laterRan = $true } }
    if ($laterRan -and -not $ranStage[$order[$i]] -and $incomplete -notcontains $order[$i]) { $incomplete += $order[$i]; $reasons[$order[$i]] = @('no-evidence') }
  }
  $incomplete = @($order | Where-Object { $incomplete -contains $_ })
  $all = @($steps)
  $completed = @($all | Where-Object { $null -eq $_.rejectCode })
  $rejected = @($all | Where-Object { $null -ne $_.rejectCode })
  $lastStep = $null; $lastCompleted = $null; $firstRejected = $null
  if ($all.Count) { $lastStep = $all[$all.Count - 1].name }
  if ($completed.Count) { $lastCompleted = $completed[$completed.Count - 1].name }
  if ($rejected.Count) { $firstRejected = $rejected[0].name }
  return [ordered]@{ missing = ($all.Count -eq 0); incomplete = ($incomplete.Count -gt 0); incompleteStages = $incomplete; incompleteReasons = $reasons; noStageVerdict = $noStageVerdict; stages = $stages; steps = $all
    lastStep = $lastStep; lastCompletedStep = $lastCompleted; firstRejected = $firstRejected; verdict = $verdict; stageVerdicts = $stageVerdicts; noVerdict = ($null -eq $verdict) }
}

function Read-DrillFirstInstallSteps([string]$RunDir) {
  $text = { param($n) $p = Join-Path $RunDir $n; if (Test-Path -LiteralPath $p -PathType Leaf) { [IO.File]::ReadAllText($p) } else { $null } }
  $logs = [ordered]@{ entry = (& $text 'first-install.log'); host = (& $text 'host.stdout.log'); prepare = (& $text 'prepare.stdout.log'); launcher = (& $text 'launcher.stdout.log') }
  $stage = $null
  $evidence = Join-Path $RunDir 'stage-evidence.json'
  if (Test-Path -LiteralPath $evidence -PathType Leaf) { try { $stage = Read-DrillJson $evidence } catch { $stage = $null } }
  return ConvertFrom-DrillFirstInstallSteps $logs $stage
}

# Pure conversion. A1 is the launcher's terminal object, never an Owner-supplied success string.
function ConvertFrom-DrillInteractiveEvidence($Evidence) {
  $ok = (Get-Prop $Evidence 'fileCount') -eq 1 -and (Get-Prop $Evidence 'qualified') -eq $true -and
    (Get-Prop $Evidence 'screenshot') -eq $true -and (Get-Prop $Evidence 'tree') -and (Get-Prop $Evidence 'node')
  [ordered]@{ exitCode = $(if ($ok) { 0 } else { 1 }); status = $(if ($ok) { 'FIRST_INSTALL_DONE' } else { 'FIRST_INSTALL_STOPPED' });
    stopCode = $(if ($ok) { $null } else { 'DRILL_INTERACTIVE_EVIDENCE_NOT_COMPLETE' }); tree = [string](Get-Prop $Evidence 'tree'); node = [string](Get-Prop $Evidence 'node'); parsed = $true }
}

function Wait-DrillInteractive([string]$RunDir, $Paths, [pscredential]$Cred) {
  # Owner chooses a temporary password via secure input; it is sent as SecureString, never printed or saved.
  $password = Read-Host '为本次 VM 的 drill 交互登录设置临时口令（不记录）' -AsSecureString
  if ($password.Length -eq 0) { throw (New-DrillError 'DRILL_INTERACTIVE_PASSWORD_EMPTY') }
  Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { param($p) Set-LocalUser -Name 'drill' -Password $p } -ArgumentList $password | Out-Null
  $Cred = New-Object pscredential ('drill', $password); $password = $null
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\drill\from\fleet-node-$($Paths.version).bootstrap.ps1 -From C:\drill\from"
  [Console]::Error.WriteLine("请在 VM 内以 drill 登录，打开普通 PowerShell，运行：$command")
  [Console]::Error.WriteLine('凭据仅在 VM 内读取 C:\drill\fake：app-key.pem、ci-admission.token、resident-upgrade.token、public.json；心跳留空点确定。关闭凭据窗口后，保存结局截图 C:\drill\work\interactive-screen.png。')
  [Console]::Error.WriteLine("全部结束（包含需要重启后重跑）再执行：New-Item C:\drill\work\interactive.done -ItemType File；等待上限 $InteractiveTimeoutMinutes 分钟，超时或取消会还原 S0。")
  Start-Process -FilePath "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList @('localhost', $script:Drill.VmName) -WindowStyle Normal | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes($InteractiveTimeoutMinutes)
  $done = $false
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Assert-DrillGuard
    # Reboot during the genuine bootstrap is expected. Do not restart/bootstrap through Direct.
    $job = $null
    try {
      $job = Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { Test-Path -LiteralPath 'C:\drill\work\interactive.done' } -AsJob -ErrorAction Stop
      $remaining = [Math]::Max(1, [Math]::Min(15, [int]($deadline - [DateTimeOffset]::UtcNow).TotalSeconds))
      if (Wait-Job -Job $job -Timeout $remaining) { $done = (Receive-Job -Job $job -ErrorAction Stop) -eq $true }
    } catch { $done = $false }
    finally { if ($job) { Stop-Job -Job $job -ErrorAction SilentlyContinue; Remove-Job -Job $job -Force -ErrorAction SilentlyContinue } }
    if ($done) { break }
    Start-Sleep -Seconds 5
  }
  if (-not $done) { throw (New-DrillError 'DRILL_INTERACTIVE_TIMEOUT') }
  $observed = Invoke-DrillGuest $Cred {
    param($assets, $version)
    . (Join-Path $assets "fleet-node-$version.bootstrap.ps1") -From $assets
    $files = @(Get-ChildItem -Path 'C:\ProgramData\CluedBootstrap\*\elevated-launcher-*.txt' -File)
    $treePath = ''; $nodePath = ''; $terminal = $null; $qualified = $false; $source = ''; $text = ''
    if ($files.Count -eq 1) {
      $source = $files[0].FullName; $text = [IO.File]::ReadAllText($source); $terminal = Get-LastJsonLine $text
      $qualified = (Get-LauncherVerdict $true $terminal).status -ceq 'BOOTSTRAP_DONE'
      $treePath = Join-Path $files[0].DirectoryName 'x\tree'
      $js = New-Object Web.Script.Serialization.JavaScriptSerializer
      $pm = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path $assets "fleet-node-$version.prereq-manifest.json")))
      $nodePin = @($pm['items'] | Where-Object { $_['name'] -ceq 'node' })
      if ($nodePin.Count -eq 1) {
        $nodes = @(Get-ChildItem -Path (Join-Path $WorkParent ('tools\node-' + $nodePin[0]['sha256'])) -Recurse -Filter node.exe)
        if ($nodes.Count -eq 1) { $nodePath = $nodes[0].FullName }
      }
      if (-not (Test-Path -LiteralPath (Join-Path $treePath 'work\independent-ci-resident-v1\rollout\fleet\install.mjs'))) { $treePath = '' }
    }
    $screen = 'C:\drill\work\interactive-screen.png'; $png = $false
    if (Test-Path -LiteralPath $screen -PathType Leaf) {
      $stream = [IO.File]::OpenRead($screen)
      try { $header = New-Object byte[] 8; $png = $stream.Read($header, 0, 8) -eq 8 -and [BitConverter]::ToString($header) -ceq '89-50-4E-47-0D-0A-1A-0A' } finally { $stream.Dispose() }
    }
    [ordered]@{ fileCount = $files.Count; source = $source; text = $text; terminal = $terminal; qualified = $qualified;
      tree = $treePath; node = $nodePath; screenshot = $png }
  } -ArgumentList @($Paths.from, $Paths.version) -TimeoutMinutes 2 -Step 'interactive-evidence'
  Write-DrillJson (Join-Path $RunDir 'interactive-launcher.json') $observed
  if ($observed.screenshot) {
    $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
    try { Copy-Item -LiteralPath 'C:\drill\work\interactive-screen.png' -Destination (Join-Path $RunDir 'interactive-screen.png') -FromSession $session }
    finally { Remove-PSSession -Session $session }
  }
  return @{ entry = (ConvertFrom-DrillInteractiveEvidence $observed); launcher = $observed.terminal; credential = $Cred }
}

function New-DrillItem([string]$Id, $Pass, [string]$Detail) { [ordered]@{ id = $Id; pass = $Pass; detail = $Detail } }

function Test-DrillReinstallLauncher($Reinstall) {
  $exitCode = Get-Prop $Reinstall 'launcherExit'
  return ($exitCode -is [int]) -and ($exitCode -eq 0) -and ((Get-Prop $Reinstall 'launcherVerdict') -ceq 'BOOTSTRAP_DONE')
}

# The phase-A verdict (plan section 3) from what the drill read in the guest. pass: $true, $false, or $null (not judged here:
# A5's production half and A9 are judged by -Finalize from the production read-back).
#   $E: entry (Read-DrillEntryResult), launcher (the launcher's terminal), pause (state\PAUSED.json: sha256, requestSha256),
#       verify (@{status}), status (status.json), current (upgrade\current.json), facts (version-facts.json), acceptanceSource,
#       now (DateTimeOffset), reboot (@{ok, status, readAt, boot}), reinstall (@{skipped, ...}), skipReinstall (the option given), kit,
#       firstInstallSteps (Read-DrillFirstInstallSteps)
function Get-DrillVerdict($E) {
  $items = New-Object System.Collections.ArrayList
  $now = [DateTimeOffset]$E.now
  $entry = $E.entry
  # A1 needs the step record (Read-DrillFirstInstallSteps, read before this verdict): a first install whose steps cannot be shown -- none
  # parsed, or a stage that ran without its complete log -- does not pass, and the detail says why (Codex review of 1cedea9ef, high 1;
  # branch one 74e7a65e7 holds the same).
  $steps = Get-Prop $E 'firstInstallSteps'
  $stepsWhy = if ($null -eq $steps -or (Get-Prop $steps 'missing') -ne $false) { 'steps=missing' } elseif ((Get-Prop $steps 'incomplete') -ne $false) { 'steps=incomplete:' + (@(Get-Prop $steps 'incompleteStages') -join ',') } else { 'steps=complete' }
  $a1 = ($null -ne $entry) -and $entry.parsed -and $entry.exitCode -eq 0 -and $null -eq $entry.stopCode -and $entry.status -ceq 'FIRST_INSTALL_DONE' -and $stepsWhy -ceq 'steps=complete'
  [void]$items.Add((New-DrillItem 'A1' $a1 $(if ($null -eq $entry) { "no entry result $stepsWhy" } else { "exit=$($entry.exitCode) status=$($entry.status) stopCode=$($entry.stopCode) $stepsWhy" })))
  $vs = [string](Get-Prop $E.verify 'status')
  [void]$items.Add((New-DrillItem 'A2' ($vs -ceq 'RESIDENT_VERIFIED') "verify=$vs"))
  [void]$items.Add((Test-DrillSelfcheck 'A3' $E.status $now))
  # A4: both halves on the same package (upgrade-mailbox.mjs#consistent) and a settled first generation.
  $c = $E.current; $f = $E.facts
  $a4 = ($null -ne $c) -and ($null -ne $f) -and (Get-Prop $f 'generation') -eq 1 -and (Get-Prop $c 'generation') -eq 1 -and $null -eq (Get-Prop $f 'staged') -and (Get-Prop $f 'pinsOk') -eq $true `
    -and [string](Get-Prop $f 'ciSourceManifestSha256') -ceq [string](Get-Prop $c 'ciSourceManifestSha256') -and [string](Get-Prop $f 'manifestSha256') -ceq [string](Get-Prop $c 'linux.manifestSha256') `
    -and (Get-Prop $f 'manifestSha256') -match '^[0-9a-f]{64}$'
  [void]$items.Add((New-DrillItem 'A4' $a4 "facts.generation=$(Get-Prop $f 'generation') staged=$(Get-Prop $f 'staged') pinsOk=$(Get-Prop $f 'pinsOk')"))
  $local = [string](Get-Prop $c 'ciSourceManifestSha256')
  $a5 = ($local -match '^[0-9a-f]{64}$') -and $local -ceq [string]$E.acceptanceSource
  # a candidate (Fable ruling 11-19 renew-key section 4.3) has no production half: A5 is the guest's Source against the request's, here
  if ((Get-Prop $E 'candidate') -eq $true) { [void]$items.Add((New-DrillItem 'A5' $a5 "local=$local acceptance=$($E.acceptanceSource); candidate: no production half")) }
  else { [void]$items.Add((New-DrillItem 'A5' $(if ($a5) { $null } else { $false }) "local=$local acceptance=$($E.acceptanceSource); production half by -Finalize")) }
  # A6 (Fable renew-key ruling, supplement "eight on the path", item 5): a successful launcher ends with its own pause confirmed, so the
  # node holds THAT pause: the request the launcher's terminal confirmed (pause.requestSha256, the one source) is the one state\PAUSED.json
  # names, the status says paused and the executor rests PAUSED, with UNCERTAIN, no current batch, live 0 and no HALT. Idle is no pass.
  $s = $E.status
  $want = [string](Get-Prop $E.launcher 'pause.requestSha256'); $held = [string](Get-Prop $E.pause 'requestSha256')
  $ownPause = ((Get-Prop $E.launcher 'pause.confirmed') -eq $true) -and ($want -cmatch '^[0-9a-f]{64}$') -and ($held -ceq $want)
  $a6 = $ownPause -and ((Get-Prop $s 'paused') -eq $true) -and ([string](Get-Prop $s 'executor.state') -ceq 'PAUSED') -and ([string](Get-Prop $s 'node.mode') -ceq 'UNCERTAIN') `
    -and ($null -eq (Get-Prop $s 'current')) -and ((Get-Prop $s 'queue.live') -eq 0) -and ($null -eq (Get-Prop $s 'halt'))
  [void]$items.Add((New-DrillItem 'A6' $a6 "pause=$held confirmedByLauncher=$want paused=$(Get-Prop $s 'paused') executor=$(Get-Prop $s 'executor.state') mode=$(Get-Prop $s 'node.mode') current=$($null -ne (Get-Prop $s 'current')) live=$(Get-Prop $s 'queue.live') halt=$(Get-Prop $s 'halt.code')"))
  # A7: the status rewritten after this boot, and a self-check that passed, is fresh AND was observed after this boot (never the boot before's).
  $r = $E.reboot
  if ($null -eq $r) { [void]$items.Add((New-DrillItem 'A7' $false 'not run')) }
  else {
    $sc = Test-DrillSelfcheck 'A7' $r.status ([DateTimeOffset]$r.readAt)
    $scAfter = Test-DrillAfterBoot ([string](Get-Prop $r.status 'versions.selfcheck.observedAt')) ([string](Get-Prop $r 'boot'))
    [void]$items.Add((New-DrillItem 'A7' ([bool]$r.ok -and $sc.pass -and $scAfter) "refreshedAfterBoot=$($r.ok) selfcheckAfterBoot=$scAfter boot=$(Get-Prop $r 'boot') $($sc.detail)"))
  }
  # A8: the operator's choice (-SkipReinstall, $E.skipReinstall) and the run's A8 result reach here apart (Codex review of 58136df61,
  # medium 2). Only the choice, with a result that says skipped, is "skipped"; no result, or a skip nobody chose, is FAIL.
  $ri = $E.reinstall
  $chosen = (Get-Prop $E 'skipReinstall') -eq $true
  $saysSkipped = (Get-Prop $ri 'skipped') -eq $true
  if ($chosen -and $saysSkipped) { [void]$items.Add((New-DrillItem 'A8' $null 'skipped (-SkipReinstall): same-package reinstall not drilled (同包重装未演练)')) }
  elseif ($null -eq $ri) { [void]$items.Add((New-DrillItem 'A8' $false 'no A8 result: the run handed none over')) }
  elseif ($saysSkipped) { [void]$items.Add((New-DrillItem 'A8' $false 'the A8 result says skipped, but the run was not started with the skip option')) }
  elseif ($chosen) { [void]$items.Add((New-DrillItem 'A8' $false 'started with the skip option, but an A8 result came back')) }
  else {
    $a8 = ([string]$ri.upgradeStatus -ceq 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') -and ([string]$ri.prepareStatus -ceq 'FLEET_NODE_INSTALL_PREPARED') `
      -and (Test-DrillReinstallLauncher $ri) -and [bool]$ri.reverifyPassed -and ([string]$ri.prepareAgainStatus -ceq 'FLEET_NODE_INSTALL_PREPARED')
    [void]$items.Add((New-DrillItem 'A8' $a8 "upgrade=$($ri.upgradeStatus) prepare=$($ri.prepareStatus) launcher=$(Get-Prop $ri 'launcherVerdict') launcherStatus=$(Get-Prop $ri 'launcherStatus') launcherExit=$(Get-Prop $ri 'launcherExit') reverify=$($ri.reverifyPassed) prepareAgain=$($ri.prepareAgainStatus)"))
  }
  [void]$items.Add((New-DrillItem 'A9' $null 'production read-back by -Finalize'))
  $steps = @($E.kit.perNodeSteps)
  # A malformed/edited adapted kit cannot erase the shell exception by clearing perNodeSteps.
  if ([string](Get-Prop $E.kit 'prerequisiteMode') -ceq 'first-install-host') {
    $steps = @($steps) + @('adapted drill: non-elevated check, RunAs and credential dialogs not validated')
  }
  [void]$items.Add((New-DrillItem 'A10' ($steps.Count -eq 0) $(if ($steps.Count) { 'per-node steps: ' + ($steps -join ' | ') } else { 'one command, no node value' })))
  return ,$items.ToArray()
}

# $At (a status or self-check time) later than $Boot (this boot); either missing or unreadable is not later.
function Test-DrillAfterBoot([string]$At, [string]$Boot) {
  if (-not $At -or -not $Boot) { return $false }
  try { return [DateTimeOffset]::Parse($At, [Globalization.CultureInfo]::InvariantCulture) -gt [DateTimeOffset]::Parse($Boot, [Globalization.CultureInfo]::InvariantCulture) } catch { return $false }
}

function Test-DrillSelfcheck([string]$Id, $Status, [DateTimeOffset]$Now) {
  $sc = Get-Prop $Status 'versions.selfcheck'
  $result = [string](Get-Prop $sc 'result'); $at = [string](Get-Prop $sc 'observedAt')
  $fresh = $false
  if ($at) { try { $age = $Now - [DateTimeOffset]::Parse($at, [Globalization.CultureInfo]::InvariantCulture); $fresh = $age.TotalMinutes -le $script:Drill.SelfcheckFreshMinutes -and $age.TotalSeconds -ge -30 } catch { $fresh = $false } }
  return (New-DrillItem $Id (($result -ceq 'PASS') -and $fresh) "selfcheck=$result observedAt=$at")
}

# Overall: FAIL if any required item is missing or a core item failed, or M5 (the renewal observations) is not PASS; PASS_A when
# A1-A9 hold and M5 passed; PENDING_PRODUCTION_READBACK while the read-back (-Finalize) has not been judged. The three PASS values are the
# set publish.mjs seal --drill-receipt takes (test/drill-vm.test.mjs holds them equal); a candidate is shown to the Owner only after its
# -Finalize (Fable renew-key ruling section 4.3: drill -> -Finalize -> accept -> seal). M5 has no "not evaluated" exit (section 2.2): a package
# without the renewal leaves its observations missing and fails here; NOT_EVALUATED only marks a run that stopped before M5 was read.
# A candidate (its receipt is what the Owner's acceptance and seal rest on): each of A1-A7 must be true, and A8 true unless the run chose
# to skip it (-SkipReinstall, an explicit option, never the default; Fable renew-key ruling, supplement "candidate skips A8"). A candidate
# that skipped A8 ends in its own value, PASS_A_REINSTALL_NOT_DRILLED, never in the two others (Codex review of PR-甲, blocking 1: a skipped
# candidate must not look like a full one; the value tells them apart, in the receipt and in the index seal writes). It is reported even
# when per-node steps remain too (the larger gap; A10's detail still names them). An accepted version's re-drill keeps "skipped" as the
# diagnosis it was.
function Get-DrillConclusion($Items, $M5, [bool]$Candidate = $false) {
  if ([string](Get-Prop $M5 'result') -cne 'PASS') { return 'FAIL' }
  $byId = @{}; foreach ($i in $Items) { $byId[$i.id] = $i }
  $core = @('A1','A2','A3','A4','A5','A6','A7','A8','A9')
  foreach ($id in ($core + 'A10')) {
    if (-not $byId.ContainsKey($id)) { return 'FAIL' }
  }
  if (@($core | Where-Object { $byId[$_].pass -eq $false }).Count) { return 'FAIL' }
  $a8Skipped = $null -eq $byId['A8'].pass -and [string]$byId['A8'].detail -match '^skipped'
  if ($Candidate -and @(@('A1','A2','A3','A4','A5','A6','A7','A8') | Where-Object { $byId[$_].pass -ne $true -and -not ($_ -eq 'A8' -and $a8Skipped) }).Count) { return 'FAIL' }
  if (@($core | Where-Object { $null -eq $byId[$_].pass -and $byId[$_].detail -notmatch '^skipped' }).Count) { return 'PENDING_PRODUCTION_READBACK' }
  if ($Candidate -and $a8Skipped) { return 'PASS_A_REINSTALL_NOT_DRILLED' }
  if ($byId['A10'].pass) { return 'PASS_A_FULL' }
  return 'PASS_A_PER_NODE_STEPS_REMAIN'
}

# The production read-back (one read-only query after the drill, by DESK; plan 2.3/A9). The SQL is carried in the receipt.
function Get-DrillReadbackSql([string]$StartedAt) {
  if ($StartedAt -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$') { throw (New-DrillError 'DRILL_STARTED_AT_REFUSED') }
  @"
select
 (select count(*) from clued_private.ci_nodes_v1 where created_at >= '$StartedAt' or updated_at >= '$StartedAt') as nodes_changed,
 (select count(*) from clued_private.ci_failover_members_v1 where marked_at >= '$StartedAt') as failover_marked,
 (select count(*) from clued_private.binding_roles_v1 where granted_at >= '$StartedAt' or revoked_at >= '$StartedAt') as roles_changed,
 (select count(*) from public.clued_agent_bindings where created_at >= '$StartedAt') as bindings_created,
 (select count(*) from clued_private.ci_node_liveness_v1 l join clued_private.ci_nodes_v1 n using (node_id) where n.name ilike '%drill%') as drill_liveness,
 (select coalesce(jsonb_agg(distinct l.reported_source_sha256), '[]'::jsonb) from clued_private.ci_node_liveness_v1 l where l.last_heartbeat_at >= now() - interval '24 hours') as live_sources;
"@
}

# A5's production half and A9 from the read-back row. nodes_changed counts every touch of ci_nodes_v1 (heartbeats of the
# in-service nodes do not write it: they write ci_node_liveness_v1), so any non-zero count is looked at, never ignored.
# A candidate's receipt (candidate: true) is read back right after its drill, before the Owner accepts, and judged on A9 alone: what
# A5's production half guarded against (the drilled package is not the one the fleet runs) is held by seal (the receipt's three hashes
# are the acceptance's) and by every node recomputing the Source of the accepted Release it installs (Fable renew-key section 4.3).
function Get-DrillProductionVerdict($Receipt, $Readback) {
  if ([string](Get-Prop $Readback 'contract') -cne $script:Drill.ReadbackContract) { throw (New-DrillError 'DRILL_READBACK_REFUSED' 'contract') }
  if ([string](Get-Prop $Readback 'startedAt') -cne [string](Get-Prop $Receipt 'startedAt')) { throw (New-DrillError 'DRILL_READBACK_NOT_THIS_DRILL') }
  $row = Get-Prop $Readback 'row'
  $counts = [ordered]@{}
  foreach ($k in @('nodes_changed','failover_marked','roles_changed','bindings_created','drill_liveness')) {
    $v = Get-Prop $row $k
    if (-not ($v -is [int] -or $v -is [long])) { throw (New-DrillError 'DRILL_READBACK_REFUSED' $k) }
    $counts[$k] = [long]$v
  }
  $a9 = @($counts.Values | Where-Object { $_ -ne 0 }).Count -eq 0
  if ((Get-Prop $Receipt 'candidate') -eq $true) { return @((New-DrillItem 'A9' $a9 (($counts.Keys | ForEach-Object { "$_=$($counts[$_])" }) -join ' '))) }
  $sources = @(Get-Prop $row 'live_sources' | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  $local = [string](Get-Prop $Receipt 'evidence.localSource')
  $a5 = $sources.Count -ge 1 -and @($sources | Where-Object { $_ -cne $local }).Count -eq 0
  return @(
    (New-DrillItem 'A5' $a5 "local=$local production=$($sources -join ',')"),
    (New-DrillItem 'A9' $a9 (($counts.Keys | ForEach-Object { "$_=$($counts[$_])" }) -join ' '))
  )
}

# ---------------------------------------------------------------- guest-side fake credentials (Windows PowerShell 5.1 in the VM)
# Generates, inside the VM, the CI token, upgrade token and an RSA App key nobody registered, and prints only public values.
# Fingerprints use the package's formulas (tools/secret-fingerprint.mjs; the offline test cross-checks them).
function New-DrillFakeCredentials {
  param([string]$OutDir)   # in the body: the guest receives this function as a script block, which keeps only the body
  $ErrorActionPreference = 'Stop'
  if (Test-Path -LiteralPath $OutDir) { throw 'FAKE_CREDENTIALS_DIR_EXISTS' }
  New-Item -ItemType Directory -Path $OutDir | Out-Null
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $b64url = { param([byte[]]$b) [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  $sha = { param([byte[]]$b) $h = [System.Security.Cryptography.SHA256]::Create(); try { $h.ComputeHash($b) } finally { $h.Dispose() } }
  $hex = { param([byte[]]$b) -join ($b | ForEach-Object { $_.ToString('x2') }) }
  $token = { $r = New-Object byte[] 32; $rng.GetBytes($r); 'clued_bnd_' + (& $b64url $r) }
  $pin = { param([string]$t) & $hex (& $sha ([Text.Encoding]::UTF8.GetBytes("clued.independent-ci.ci-binding-pin/1`0" + $t))) }
  $derLen = { param([int]$n) if ($n -lt 128) { ,([byte[]]@($n)) } else { $l = New-Object System.Collections.Generic.List[byte]; while ($n -gt 0) { $l.Insert(0, [byte]($n -band 0xff)); $n = $n -shr 8 }; $l.Insert(0, [byte](0x80 + $l.Count)); ,($l.ToArray()) } }
  $tlv = { param([byte]$tag, [byte[]]$v) $o = New-Object System.Collections.Generic.List[byte]; $o.Add($tag); $o.AddRange([byte[]](& $derLen $v.Length)); $o.AddRange($v); ,($o.ToArray()) }
  $int = { param([byte[]]$v) $i = 0; while ($i -lt $v.Length - 1 -and $v[$i] -eq 0) { $i++ }; $v = [byte[]]$v[$i..($v.Length - 1)]; if ($v[0] -band 0x80) { $v = [byte[]](@([byte]0) + $v) }; & $tlv 0x02 $v }
  $seq = { param($parts) $o = New-Object System.Collections.Generic.List[byte]; foreach ($p in $parts) { $o.AddRange([byte[]]$p) }; & $tlv 0x30 $o.ToArray() }
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 2048
  try { $k = $rsa.ExportParameters($true) } finally { $rsa.Dispose() }
  $pkcs1 = & $seq @((& $int ([byte[]]@(0))), (& $int $k.Modulus), (& $int $k.Exponent), (& $int $k.D), (& $int $k.P), (& $int $k.Q), (& $int $k.DP), (& $int $k.DQ), (& $int $k.InverseQ))
  $rsaPub = & $seq @((& $int $k.Modulus), (& $int $k.Exponent))
  $algo = & $seq @(([byte[]](0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01)), ([byte[]](0x05, 0x00)))
  $spki = & $seq @($algo, (& $tlv 0x03 ([byte[]](@([byte]0) + $rsaPub))))
  $b64 = [Convert]::ToBase64String($pkcs1)
  $pemFence = '-----'
  $pemLabel = 'RSA PRIVATE KEY'
  $pemBody = ($b64 -split '(.{64})' | Where-Object { $_ }) -join "`n"
  $pem = "{0}BEGIN {1}{0}`n{2}`n{0}END {1}{0}`n" -f $pemFence, $pemLabel, $pemBody
  $ci = & $token; $up = & $token
  $enc = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText((Join-Path $OutDir 'ci-admission.token'), $ci, $enc)
  [IO.File]::WriteAllText((Join-Path $OutDir 'resident-upgrade.token'), $up, $enc)
  [IO.File]::WriteAllText((Join-Path $OutDir 'app-key.pem'), $pem, $enc)
  $public = [ordered]@{
    contract = 'clued.drill.fake-credentials/1'
    note = 'generated inside the drill VM; registered nowhere; the service refuses them'
    ciPrincipalBindingId = [guid]::NewGuid().ToString()
    ciPrincipalRoleRef = [guid]::NewGuid().ToString()
    ciPrincipalQualificationRef = [guid]::NewGuid().ToString()
    ciTokenPinSha256 = (& $pin $ci)
    upgradeTokenFingerprint = (& $pin $up)
    appKeyId = 1
    appPublicKeySha256Base64 = [Convert]::ToBase64String((& $sha $spki))
    files = [ordered]@{ ciToken = 'ci-admission.token'; upgradeToken = 'resident-upgrade.token'; appKey = 'app-key.pem' }
  }
  [IO.File]::WriteAllText((Join-Path $OutDir 'public.json'), ($public | ConvertTo-Json -Depth 4), $enc)
  $ci = $null; $up = $null; $pem = $null
  return $public
}

# ---------------------------------------------------------------- Hyper-V side (needs the host; not unit-tested)

function Get-DrillVmInfo {
  $vm = Get-VM -Name $script:Drill.VmName -ErrorAction SilentlyContinue
  if ($null -eq $vm) { return $null }
  return @{ vm = $vm; notes = $vm.Notes; state = [string]$vm.State; checkpoints = @(Get-VMSnapshot -VM $vm -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }
}

function Get-DrillTime { [DateTimeOffset]::UtcNow }

function Read-DrillHostStatus {
  try { Get-Content -LiteralPath $script:Drill.HostStatus -Raw -Encoding UTF8 -ErrorAction Stop } catch { $null }
}

function Get-DrillHostSafety([switch]$Running, [DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue, [switch]$StatusOnly) {
  $json = Read-DrillHostStatus
  $duty = Test-DrillHostSafety $json ([long]::MaxValue) -Running:$Running -Now (Get-DrillTime) -HoldUntil $HoldUntil
  if (-not $duty.ok -or $StatusOnly) { return $duty }
  try {
    $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 5 -ErrorAction Stop
    if ($null -eq $os.FreePhysicalMemory) { throw 'missing memory reading' }
    $free = [long]$os.FreePhysicalMemory * 1KB
    $target = $script:Drill.MemoryBytes
    $assigned = 0L
    $vm = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $script:Drill.VmName }
    if ($vm) {
      if ($vm.Notes -cne $script:Drill.Marker) { throw (New-DrillError 'DRILL_VM_NAME_TAKEN_NOT_OURS') }
      $target = [Math]::Max($target, [long]$vm.MemoryStartup)
      $assigned = [long]$vm.MemoryAssigned
    }
    $processes = if ($Running) { @() } else { @(Get-Process -ErrorAction Stop | ForEach-Object { [string]$_.ProcessName }) }
    $safety = Test-DrillHostSafety $json $free -VmMemoryBytes $target -MemoryAssigned $assigned -Running:$Running -Now (Get-DrillTime) -HoldUntil $HoldUntil -ProcessNames $processes
  } catch {
    $c = Get-DrillCode $_
    $safety = @{ ok = $false; code = $(if ($c.code -eq 'DRILL_VM_NAME_TAKEN_NOT_OURS') { $c.code } else { 'DRILL_HOST_RESOURCE_UNREADABLE' }); action = $(if ($Running) { 'abort' } else { 'refuse' }) }
  }
  # The resource checks can take time. Keep the observation from the original status read.
  $safety.executorObservation = $duty.executorObservation
  $safety.observedAt = $duty.observedAt
  return $safety
}

function Assert-DrillHostSafety([DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  Assert-DrillGuard
  $safety = Get-DrillHostSafety -HoldUntil $HoldUntil
  if (-not $safety.ok) { throw (New-DrillError $safety.code $safety) }
  return $safety
}

function Get-DrillIntakeTool {
  # Follow the same installed generation and runtime as windows/rearm-resident.ps1's unprivileged inspect.
  $root = Split-Path -Parent (Split-Path -Parent $script:Drill.HostStatus)
  try {
    $receipt = Read-DrillJson (Join-Path $root 'install\install-receipt.json')
    $manifest = $receipt.residentManifestSha256
    if ($manifest -isnot [string] -or $manifest -cnotmatch '^[0-9a-f]{64}$') { throw 'invalid resident generation' }
    $tool = Join-Path $root "resident\$manifest\tools\rearm-tool.mjs"
    $node = Join-Path $root 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'installed CLI unavailable' }
    return @{ root = $root; node = $node; tool = $tool }
  } catch { throw (New-DrillError 'DRILL_HOST_INTAKE_TOOL_UNAVAILABLE') }
}

# Every child the drill starts in the guest (the kit entry, verify, the A8 tools, root in the prerequisite distribution) runs here, by the
# package's rule (Invoke-Native, windows/first-install-host.ps1): stdout and stderr read apart, so a line a tool writes on stderr is text,
# never a PowerShell error that ends the step under Stop (the merged 2>&1 reads did that: Fable renew-key ruling, supplement "eight on
# the path", risks taken in). A child still running at $Seconds is left running (nothing is killed) and the step stops by name.
# Self-contained: the guest receives it as text ($script:DrillNativeText) and makes it a script block there.
function Invoke-DrillNative {
  param([string]$Exe, [string[]]$Arguments, [int]$Seconds = 3600, [string]$Encoding = 'utf-8')
  $quote = { param([string]$a) if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { $a } else { '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' } }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = (@($Arguments | ForEach-Object { & $quote $_ }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  # 'utf-16': a child that writes UTF-16LE (wsl.exe's own messages); UTF-8 otherwise
  $enc = if ($Encoding -ceq 'utf-16') { [Text.Encoding]::Unicode } else { New-Object Text.UTF8Encoding($false) }
  $psi.StandardOutputEncoding = $enc; $psi.StandardErrorEncoding = $enc
  $p = [Diagnostics.Process]::Start($psi)
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($Seconds * 1000)) { throw ('COMMAND_TIMEOUT_NOTHING_KILLED: ' + [IO.Path]::GetFileName($Exe)) }
  $p.WaitForExit()   # the asynchronous reads end with the child
  $err = ([string]$e.Result) -replace "`0", ''
  [ordered]@{ exit = $p.ExitCode; stdout = (([string]$o.Result) -replace "`0", ''); stderr = $(if ($err.Length -gt 4000) { $err.Substring($err.Length - 4000) } else { $err }) }
}
$script:DrillNativeText = ${function:Invoke-DrillNative}.ToString()

function Invoke-DrillNode([string]$Node, [string[]]$Arguments, [int]$TimeoutSeconds) {
  $child = [Diagnostics.Process]::new()
  try {
    $child.StartInfo.FileName = $Node
    # All arguments are fixed literals or Windows file paths.
    $child.StartInfo.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $child.StartInfo.UseShellExecute = $false
    $child.StartInfo.CreateNoWindow = $true
    $child.StartInfo.RedirectStandardOutput = $true
    $child.StartInfo.RedirectStandardError = $true
    $child.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $child.StartInfo.EnvironmentVariables.Remove('NODE_OPTIONS')
    $child.StartInfo.EnvironmentVariables.Remove('NODE_PATH')
    [void]$child.Start()
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit($TimeoutSeconds * 1000)) {
      if (-not $child.HasExited) { $child.Kill() }
      throw 'Node CLI timed out'
    }
    return @{ exit = $child.ExitCode; stdout = $stdout.GetAwaiter().GetResult() }
  } finally { $child.Dispose() }
}

# Clued Task fe8a2cbf (Fable renew-key ruling, supplements "test touching production" and "the test guard criterion"): the one act of
# the drill that changes the host is executing the installed intake tool (it writes a request the service on duty acts on). Under a test
# marker -- NODE_TEST_CONTEXT, which the node test runner gives every test process and its children inherit, or CLUED_UNDER_TEST,
# honoured here as well (the one test entry is to set it for every suite: PR-丁, not yet) -- no tool is executed, whatever its paths:
# nothing about a path is judged, so no spelling of a root can slip through. A test that needs the hold logic injects the sender
# ($script:DrillIntakeSender: { param($Tool, $Verb, $Minutes, $Arguments) ... returns @{ exit; stdout } }), used only under a marker (without one an injected sender is refused, DRILL_INTAKE_SENDER_WITHOUT_TEST_MARKER). Reading the host status and
# locating the tool are read-only and not fenced. The boot watchdog (started through WMI, so it inherits no environment) never executes
# the intake tool: it only stops and restores the drill VM (Stop-DrillOwnedVm), so it needs no marker of its own. Cooperative: the marker
# stops a mistake, not code that clears it on purpose.
$script:DrillIntakeSender = $null
function Get-DrillIntakeArguments($Tool, [ValidateSet('pause', 'resume')][string]$Verb, [int]$Minutes = 0) {
  $a = @($Tool.tool, "request-intake-$Verb", '--root', $Tool.root, '--holder', $script:Drill.IntakeHolder, '--reason', 'first-install drill')
  if ($Verb -ceq 'pause') { $a += @('--minutes', [string]$Minutes) }
  , $a
}
function Request-DrillIntake($Tool, [ValidateSet('pause', 'resume')][string]$Verb, [int]$Minutes = 0) {
  # first, before the tool record is read: under a marker only an injected sender is used; without one an injected sender is refused
  # (production never takes a request from a stand-in: Codex review r5), so neither it nor the real tool runs
  $marked = [bool]($env:NODE_TEST_CONTEXT -or $env:CLUED_UNDER_TEST)
  if ($marked -and $null -eq $script:DrillIntakeSender) { throw (New-DrillError 'DRILL_HOST_ACCESS_UNDER_TEST' "request-intake-$Verb") }
  if (-not $marked -and $null -ne $script:DrillIntakeSender) { throw (New-DrillError 'DRILL_INTAKE_SENDER_WITHOUT_TEST_MARKER' "request-intake-$Verb") }
  $argsForTool = Get-DrillIntakeArguments $Tool $Verb $Minutes
  $expected = if ($Verb -ceq 'pause') { 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES' } else { 'INTAKE_RESUME_REQUESTED' }
  try {
    $run = if ($marked) { & $script:DrillIntakeSender $Tool $Verb $Minutes $argsForTool } else { Invoke-DrillNode $Tool.node $argsForTool 15 }
    $status = Get-Prop (ConvertFrom-Json -InputObject $run.stdout) 'status'
    if ($run.exit -ne 0 -or $status -cne $expected) { throw 'request refused' }
  } catch { throw (New-DrillError "DRILL_HOST_INTAKE_$($Verb.ToUpperInvariant())_FAILED") }
}
function Invoke-DrillWithHostHold([int]$Minutes, [scriptblock]$Body, [switch]$StandbyOnly) {
  # Serialize all invocations using the same VM and the fixed public holder, across logon sessions.
  $mutex = [Threading.Mutex]::new($false, $script:Drill.HostMutex)
  $locked = $false; $resume = $false; $tool = $null; $failure = $null; $resumeFailure = $null
  $window = @{ safeToResume = $true; deadline = [DateTimeOffset]::MinValue; holdUntil = [DateTimeOffset]::MinValue }
  try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw (New-DrillError 'DRILL_HOST_CI_BUSY') }
    # An orphaned boot watchdog may still be waiting for an in-flight Hyper-V start to become visible.
    $bootMutex = [Threading.Mutex]::new($false, $script:Drill.BootMutex)
    try {
      try { $bootFree = $bootMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $bootFree = $true }
      if (-not $bootFree) { throw (New-DrillError 'DRILL_HOST_CI_BUSY' 'previous drill boot cleanup in progress') }
      $bootMutex.ReleaseMutex()
    } finally { $bootMutex.Dispose() }
    $now = Get-DrillTime
    $initial = Test-DrillHostSafety (Read-DrillHostStatus) ([long]::MaxValue) -Now $now
    if ($initial.mode -ceq 'ACTIVE' -and $initial.code -cin @('DRILL_HOST_IS_ON_DUTY', 'DRILL_HOST_CI_BUSY') -and -not $StandbyOnly) {
      $holdMinutes = $script:Drill.IntakeWaitMinutes + $Minutes + $script:Drill.IntakeMarginMinutes
      if ($holdMinutes -gt $script:Drill.IntakeMaxMinutes) { throw (New-DrillError 'DRILL_HOST_INTAKE_BUDGET_EXCEEDED' @{ minutes = $holdMinutes }) }
      if ($initial.holdUntil -gt $now) { throw (New-DrillError 'DRILL_HOST_CI_BUSY' 'a previous drill hold is still in force') }
      $tool = Get-DrillIntakeTool
      $clock = [Diagnostics.Stopwatch]::StartNew()
      $requestedAt = Get-DrillTime
      $wait = [TimeSpan]::FromMinutes($script:Drill.IntakeWaitMinutes)
      $resume = $true  # The CLI may have written the request before losing its reply.
      Request-DrillIntake $tool pause $holdMinutes
      while ($clock.Elapsed -lt $wait) {
        $deadline = (Get-DrillTime).AddMinutes($Minutes)
        $holdUntil = $deadline.AddMinutes($script:Drill.IntakeMarginMinutes)
        $safety = Get-DrillHostSafety -HoldUntil $holdUntil -StatusOnly
        if ($safety.ok -and $safety.holdSince -ge $requestedAt.AddMilliseconds(-1) -and
            $safety.holdUntil -ge $holdUntil -and $clock.Elapsed -lt $wait) {
          $window.deadline = $deadline
          $window.holdUntil = $holdUntil
          break
        }
        $remainingMs = ($wait - $clock.Elapsed).TotalMilliseconds
        if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min($remainingMs, $script:Drill.IntakePollSeconds * 1000)) }
      }
      if ($window.deadline -eq [DateTimeOffset]::MinValue) { throw (New-DrillError 'DRILL_HOST_CI_BUSY') }
    } elseif (-not $initial.ok) { throw (New-DrillError $initial.code $initial) }
    $result = & $Body $window
  } catch { $failure = Get-DrillCode $_ }
  finally {
    try {
      if ($resume -and $window.safeToResume) {
        try { Request-DrillIntake (Get-DrillIntakeTool) resume 0 } catch { $resumeFailure = Get-DrillCode $_ }
      }
    } finally {
      if ($locked) { $mutex.ReleaseMutex() }
      $mutex.Dispose()
    }
  }
  if ($failure) {
    if ($resumeFailure) { throw (New-DrillError $failure.code @{ failure = $failure.detail; resumeFailure = $resumeFailure }) }
    throw (New-DrillError $failure.code $failure.detail)
  }
  if ($resumeFailure) { throw (New-DrillError $resumeFailure.code @{ receipt = (Get-Prop $result 'receipt') }) }
  return $result
}

# Always revalidate name + notes before destructive Hyper-V operations. Never touch a VM we do not own.
function Stop-DrillOwnedVm([switch]$RestoreCheckpoint) {
  $info = Get-DrillVmInfo
  if ($null -eq $info) { throw (New-DrillError 'DRILL_VM_MISSING') }
  if ($info.notes -cne $script:Drill.Marker) { throw (New-DrillError 'DRILL_VM_NAME_TAKEN_NOT_OURS') }
  if ($info.state -ne 'Off') { Stop-VM -VM $info.vm -TurnOff -Force -ErrorAction Stop }
  if ($RestoreCheckpoint) {
    Restore-VMCheckpoint -VMName $script:Drill.VmName -Name $script:Drill.Checkpoint -Confirm:$false -ErrorAction Stop
  }
  return (Get-VM -Name $script:Drill.VmName -ErrorAction Stop).State -eq 'Off'
}

function Stop-DrillGuardedVm($Guard, [switch]$RestoreCheckpoint) {
  if (-not $Guard) { return (Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint) }
  $state = $Guard.state
  # The foreground and the aborting guard can both reach cleanup.
  [Threading.Monitor]::Enter($state.SyncRoot)
  try {
    $stopped = Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint
    if ($stopped) { $state.armed = $false; $state.stop = $true }
    return $stopped
  } finally { [Threading.Monitor]::Exit($state.SyncRoot) }
}

function Add-DrillExecutorObservation($State, $Safety) {
  $sample = Get-Prop $Safety 'executorObservation'
  if ($null -eq $sample) { return }
  $key = ConvertTo-DrillJson $sample
  if (-not $State.executorStates.Contains($key)) {
    $State.executorStates.Add($key, [ordered]@{
      state = $sample.state; reason = $sample.reason; current = $sample.current; firstSeenAt = $Safety.observedAt
    })
  }
}

# A separate runspace owns this loop: guest jobs, Copy-Item, Read-Host and long waits cannot delay host protection.
# The start and abort share a lock, so an abort can never be followed by a late Start-VM.
function Invoke-DrillHostGuardLoop($State, [string]$RunDir, [switch]$RestoreCheckpoint) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    while (-not $State.stop) {
      if (-not $State.ready -or $clock.Elapsed.TotalSeconds -ge $script:Drill.HostGuardSeconds) {
        $clock.Restart()
        [Threading.Monitor]::Enter($State.SyncRoot)
        try {
          if ($State.stop) { return }
          $safety = Get-DrillGuardSafety $State
          if ($State.armed) { Add-DrillExecutorObservation $State $safety }
          if (-not $safety.ok) { $State.failure = @{ code = $safety.code; detail = $safety } }
          $State.ready = $true
        } finally { [Threading.Monitor]::Exit($State.SyncRoot) }
        if ($State.failure) { break }
      }
      Start-Sleep -Milliseconds 200
    }
  } catch { $State.failure = @{ code = 'DRILL_HOST_GUARD_FAILED'; detail = (Get-DrillCode $_) } }
  finally {
    $State.ready = $true
    [Threading.Monitor]::Enter($State.SyncRoot)
    try {
      if ($State.failure -and $State.armed) {
        $receipt = [ordered]@{ status = 'DRILL_ABORTED'; code = $State.failure.code; detail = $State.failure.detail;
          hostExecutorStates = @($State.executorStates.Values);
          abortedAt = [DateTimeOffset]::UtcNow.ToString('o'); restoredToCheckpoint = $false; stopped = $false; cleanupFailure = $null; cleanupDone = $false }
        # Persist the reason before cleanup, then its outcome. A receipt write failure must never prevent shutdown.
        try { Write-DrillJson (Join-Path $RunDir 'host-guard.json') $receipt } catch { }
        try {
          $receipt.stopped = Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint
          $receipt.restoredToCheckpoint = $RestoreCheckpoint -and $receipt.stopped
        } catch { $receipt.cleanupFailure = Get-DrillCode $_ }
        # the record says the cleanup ran (Get-DrillGuardOutcome): one left from before it says "not known", never "restored"
        $receipt.cleanupDone = $true
        $State.cleanup = $receipt
        try { Write-DrillJson (Join-Path $RunDir 'host-guard.json') $receipt } catch { $State.receiptFailure = $true }
      }
    } finally { [Threading.Monitor]::Exit($State.SyncRoot) }
  }
}

function Get-DrillGuardSafety($State) {
  $deadline = Get-Prop $State 'deadline'
  if ($deadline -and $deadline -ne [DateTimeOffset]::MinValue -and (Get-DrillTime) -ge $deadline) {
    return @{ ok = $false; code = 'DRILL_RUN_TIMEOUT'; deadline = $deadline }
  }
  $holdUntil = Get-Prop $State 'holdUntil'
  if ($null -eq $holdUntil) { $holdUntil = [DateTimeOffset]::MinValue }
  return Get-DrillHostSafety -Running:$State.armed -HoldUntil $holdUntil
}

function Start-DrillHostGuard([string]$RunDir, [switch]$RestoreCheckpoint, $Window) {
  $state = [hashtable]::Synchronized(@{ stop = $false; ready = $false; armed = $false; failure = $null; cleanup = $null;
    executorStates = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal);
    deadline = (Get-Prop $Window 'deadline'); holdUntil = (Get-Prop $Window 'holdUntil') })
  $worker = [PowerShell]::Create()
  [void]$worker.AddScript({ param($file, $config, $state, $dir, $restore)
    . $file
    $script:Drill = $config
    Invoke-DrillHostGuardLoop $state $dir -RestoreCheckpoint:$restore
  }).AddArgument($script:DrillScriptPath).AddArgument($script:Drill).AddArgument($state).AddArgument($RunDir).AddArgument([bool]$RestoreCheckpoint)
  $guard = @{ worker = $worker; pending = $worker.BeginInvoke(); state = $state }
  $script:HostGuard = $guard
  $until = [DateTime]::UtcNow.AddSeconds(15)
  while (-not $state.ready -and -not $guard.pending.IsCompleted -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 50 }
  if (-not $state.ready) { $state.failure = @{ code = 'DRILL_HOST_GUARD_FAILED'; detail = 'guard did not become ready' } }
  return $guard
}

function Assert-DrillGuard {
  if ($script:HostGuard) {
    $guard = $script:HostGuard
    if ($guard.state.failure) { throw (New-DrillError $guard.state.failure.code $guard.state.failure.detail) }
    if (-not $guard.state.ready -or $guard.pending.IsCompleted) { throw (New-DrillError 'DRILL_HOST_GUARD_FAILED') }
  }
}

# $Watchdog (from Start-DrillBootWatchdog) is checked alive after the starting signal and right before Start-VM.
function Start-DrillGuardedVm($Watchdog) {
  if (-not $script:HostGuard) { throw (New-DrillError 'DRILL_HOST_GUARD_FAILED') }
  $state = $script:HostGuard.state
  [Threading.Monitor]::Enter($state.SyncRoot)
  try {
    Assert-DrillGuard
    $safety = Get-DrillGuardSafety $state
    if (-not $safety.ok) { throw (New-DrillError $safety.code $safety) }
    if ($Watchdog) {
      [IO.File]::WriteAllText("$(Get-Prop $Watchdog 'signal').starting", 'starting')
      Assert-DrillWatchdogAlive $Watchdog
    }
    Start-VM -Name $script:Drill.VmName -ErrorAction Stop
    $state.armed = $true
    Add-DrillExecutorObservation $state $safety
  } finally { [Threading.Monitor]::Exit($state.SyncRoot) }
}

function Stop-DrillHostGuard($Guard) {
  if (-not $Guard) { return }
  $Guard.state.stop = $true
  try { [void]$Guard.worker.EndInvoke($Guard.pending) }
  catch {
    $Guard.state.failure = @{ code = 'DRILL_HOST_GUARD_FAILED'; detail = @{ endInvoke = (Get-DrillCode $_); priorFailure = $Guard.state.failure } }
  } finally {
    try { $Guard.worker.Dispose() }
    finally { $script:HostGuard = $null }
  }
}

function Assert-DrillHost([DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  $mem = Assert-DrillHostSafety -HoldUntil $HoldUntil
  $groups = [Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object { $_.Value }
  if (@($groups) -notcontains 'S-1-5-32-578') { throw (New-DrillError 'DRILL_NOT_IN_HYPERV_ADMINISTRATORS') }
  $d = Get-PSDrive -Name D
  if ($d.Free -lt $script:Drill.MinDiskFreeBytes) { throw (New-DrillError 'DRILL_DISK_SHORT' @{ freeGB = [Math]::Round($d.Free / 1GB) }) }
  if (-not (Get-VMSwitch -Name $script:Drill.Switch -ErrorAction SilentlyContinue)) { throw (New-DrillError 'DRILL_SWITCH_MISSING') }
  return $mem
}

function Get-DrillCredential {
  if (-not (Test-Path -LiteralPath $script:Drill.Credential)) { throw (New-DrillError 'DRILL_GUEST_CREDENTIAL_MISSING') }
  Import-Clixml -LiteralPath $script:Drill.Credential   # DPAPI, this Windows user only
}

# Send Enter through the VM's synthetic keyboard for a few seconds: "Press any key to boot from CD or DVD".
function Send-DrillBootKeys([string]$VmName, [int]$Seconds) {
  $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$VmName'"
  $kb = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_Keyboard
  $until = [DateTime]::UtcNow.AddSeconds($Seconds); $sent = 0
  while ([DateTime]::UtcNow -lt $until) {
    Assert-DrillGuard
    $r = Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = [uint32]13 }
    if ($r.ReturnValue -eq 0) { $sent++ }
    Start-Sleep -Milliseconds 400
  }
  return $sent
}

# The VM's screen as a BMP (evidence when an unattended step times out).
function Save-DrillScreen([string]$VmName, [string]$Path) {
  try {
    $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$VmName'"
    $svc = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
    $sd = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_VirtualSystemSettingData | Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
    $w = 1024; $h = 768
    $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $sd; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h }
    if ($r.ReturnValue -ne 0 -or $null -eq $r.ImageData) { return $null }
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    [Runtime.InteropServices.Marshal]::Copy([byte[]]$r.ImageData, 0, $data.Scan0, [Math]::Min($r.ImageData.Length, $data.Stride * $h))
    $bmp.UnlockBits($data); $bmp.Save($Path); $bmp.Dispose()
    return $Path
  } catch { return $null }
}

# The guest's KVP item $Name, read on the host (no logon in the guest); $null when the guest has not published it.
function Get-DrillGuestKvp([string]$Name) {
  try {
    $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$($script:Drill.VmName)'"
    $kvp = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_KvpExchangeComponent
    return Get-DrillKvpValue @($kvp.GuestExchangeItems) $Name
  } catch { return $null }
}

# Waits, logging on nowhere, until SetupComplete.cmd has published the setup signal (setup is over; OOBE starts).
function Wait-DrillSetupSignal([int]$Minutes) {
  $until = [DateTime]::UtcNow.AddMinutes($Minutes)
  while ([DateTime]::UtcNow -lt $until) {
    Assert-DrillGuard
    if ((Get-DrillGuestKvp $script:Drill.SetupSignalName) -ceq 'complete') { return }
    Start-Sleep -Seconds 20
  }
  throw (New-DrillError 'DRILL_BASELINE_INSTALL_TIMEOUT' @{ minutes = $Minutes; signal = 'no setup-complete KVP item' })
}

# One readiness probe inside the guest (read-only): this boot's time and how far Windows setup is.
$script:GuestProbe = {
  $setup = Get-ItemProperty -Path 'HKLM:\SYSTEM\Setup'
  $state = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' -ErrorAction SilentlyContinue
  @{ boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
     imageState = $(if ($state) { [string]$state.ImageState } else { '' })
     oobe = $(if ($setup.PSObject.Properties['OOBEInProgress']) { [int]$setup.OOBEInProgress } else { 0 }) }
}
function Get-DrillGuestProbe([pscredential]$Credential) {
  Assert-DrillGuard
  try { return Invoke-Command -VMName $script:Drill.VmName -Credential $Credential -ErrorAction Stop -ScriptBlock $script:GuestProbe } catch { return $null }
}

function Wait-DrillGuest([pscredential]$Credential, [int]$Minutes, [DateTimeOffset]$After = [DateTimeOffset]::MinValue) {
  $until = [DateTime]::UtcNow.AddMinutes($Minutes); $candidate = $null; $last = $null
  while ([DateTime]::UtcNow -lt $until) {
    $probe = Get-DrillGuestProbe $Credential
    if ($probe) { $last = $probe }
    $step = Step-DrillReadiness $candidate $probe $After
    if ($step.ready) { return [DateTimeOffset]::Parse($step.candidate, [Globalization.CultureInfo]::InvariantCulture) }
    $candidate = $step.candidate
    Start-Sleep -Seconds 20
  }
  throw (New-DrillError 'DRILL_GUEST_NOT_READY_IN_TIME' @{ minutes = $Minutes; lastProbe = $last })
}

# Run one step in the guest, bounded. A failure is classified by the guest's boot time, never by the (localized) message:
#   the guest restarted under the step -> a restartable (idempotent) step waits for the guest to be ready and runs again, at
#   most twice; any other step stops with DRILL_GUEST_RESTARTED_DURING_STEP; the same boot -> DRILL_GUEST_STEP_FAILED.
function Invoke-DrillGuest([pscredential]$Credential, [scriptblock]$Script, [object[]]$ArgumentList = @(), [int]$TimeoutMinutes = 10,
    [string]$Code = 'DRILL_GUEST_STEP_TIMEOUT', [string]$Step = 'guest-step', [switch]$Restartable) {
  for ($restarts = 0; ; $restarts++) {
    $probe = Get-DrillGuestProbe $Credential
    if ($null -eq $probe) { [void](Wait-DrillGuest $Credential 20); $probe = Get-DrillGuestProbe $Credential }
    $before = if ($probe) { [string]$probe.boot } else { '' }
    $job = Invoke-Command -VMName $script:Drill.VmName -Credential $Credential -ScriptBlock $Script -ArgumentList $ArgumentList -AsJob
    try {
      if (-not (Wait-Job -Job $job -Timeout ($TimeoutMinutes * 60))) { throw (New-DrillError $Code @{ step = $Step; minutes = $TimeoutMinutes }) }
      return Receive-Job -Job $job -ErrorAction Stop
    } catch {
      $c = Get-DrillCode $_
      if ($c.code -ne 'DRILL_UNEXPECTED') { throw }
      $after = ''
      try { $after = (Wait-DrillGuest $Credential 30).ToString('o') } catch { Assert-DrillGuard; $after = '' }
      $kind = Get-DrillStepFailureKind $before $after
      if ($kind -eq 'restarted' -and $Restartable -and $restarts -lt 2) { continue }
      $codeOut = @{ restarted = 'DRILL_GUEST_RESTARTED_DURING_STEP'; unreachable = 'DRILL_GUEST_NOT_READY_IN_TIME'; failed = 'DRILL_GUEST_STEP_FAILED' }[$kind]
      throw (New-DrillError $codeOut @{ step = $Step; message = $c.detail; bootBefore = $before; bootAfter = $after })
    } finally { Remove-Job -Job $job -Force -ErrorAction SilentlyContinue }
  }
}

function Remove-DrillVm {
  $info = Get-DrillVmInfo
  if ($null -ne $info) {
    if ($info.notes -cne $script:Drill.Marker) { throw (New-DrillError 'DRILL_VM_NAME_TAKEN_NOT_OURS') }
    if ($info.state -ne 'Off') { Stop-VM -VM $info.vm -TurnOff -Force }
    Get-VMSnapshot -VM $info.vm -ErrorAction SilentlyContinue | Remove-VMSnapshot -ErrorAction SilentlyContinue
    Remove-VM -VM $info.vm -Force
  }
  if (Test-Path -LiteralPath $script:Drill.VmDir) { Remove-Item -LiteralPath $script:Drill.VmDir -Recurse -Force }
}

function New-DrillPassword {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $b = New-Object byte[] 24; $rng.GetBytes($b)
  'Dr-' + (-join ($b | ForEach-Object { $chars[$_ % $chars.Length] }))
}

# Baseline: build the VM, install Windows 11 Pro unattended, settle it, shut it down, take S0-clean-os. Returns evidence.
function Invoke-DrillBaseline([string]$RunDir, [switch]$ExistingOnly) {
  $info = Get-DrillVmInfo
  $decision = Get-DrillBaselineAction $(if ($info) { @{ notes = $info.notes; state = $info.state; checkpoints = $info.checkpoints } } else { $null })
  if ($decision.action -eq 'refuse') { throw (New-DrillError $decision.code) }
  if ($decision.action -eq 'ready') { return [ordered]@{ action = 'ready'; checkpoint = $script:Drill.Checkpoint } }
  if ($ExistingOnly) { throw (New-DrillError 'DRILL_CHECKPOINT_NOT_READY') }

  if (-not (Test-Path -LiteralPath $script:Drill.Iso -PathType Leaf)) { throw (New-DrillError 'DRILL_ISO_MISSING') }
  $isoCheck = Test-DrillIsoHash (Get-Sha256Hex $script:Drill.Iso) (Get-Content -LiteralPath $script:Drill.IsoExpectedSha -Raw)
  if (-not $isoCheck.ok) { throw (New-DrillError $isoCheck.code $isoCheck) }
  if ($decision.action -eq 'rebuild') { Remove-DrillVm }
  [void](Assert-DrillHost)

  New-Item -ItemType Directory -Force -Path $script:Drill.VmDir, $script:Drill.AnswerDir | Out-Null
  $password = New-DrillPassword
  $cred = New-Object pscredential ($script:Drill.GuestUser, (ConvertTo-SecureString $password -AsPlainText -Force))
  $cred | Export-Clixml -LiteralPath $script:Drill.Credential -Force
  [IO.File]::WriteAllText((Join-Path $script:Drill.AnswerDir 'autounattend.xml'), (New-DrillAutounattend $password), [Text.UTF8Encoding]::new($false))
  $password = $null
  [void](New-DrillAnswerIso $script:Drill.AnswerDir $script:Drill.AnswerIso)
  Remove-Item -LiteralPath $script:Drill.AnswerDir -Recurse -Force

  $vm = New-VM -Name $script:Drill.VmName -Generation 2 -MemoryStartupBytes $script:Drill.MemoryBytes -NewVHDPath $script:Drill.Vhd -NewVHDSizeBytes $script:Drill.VhdBytes -Path $script:Drill.VmDir
  # The network adapter stays unplugged until the checkpoint: offline, OOBE skips its update step (OOBEZDP), which on the
  # 2026-11-16 runs failed ("Something went wrong OOBEZDP") and sent OOBE to its "Why did my PC restart?" screen.
  Set-VM -VM $vm -Notes $script:Drill.Marker -StaticMemory -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Standard -AutomaticCheckpointsEnabled $false
  Set-VMProcessor -VM $vm -Count $script:Drill.Cpu -Maximum $script:Drill.CpuMaximum -RelativeWeight $script:Drill.CpuWeight -ExposeVirtualizationExtensions $true
  Set-VMHardDiskDrive -VMHardDiskDrive (Get-VMHardDiskDrive -VM $vm)[0] -MaximumIOPS $script:Drill.MaxIops
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
  try { Set-VMKeyProtector -VM $vm -NewLocalKeyProtector; Enable-VMTPM -VM $vm }
  catch { throw (New-DrillError 'DRILL_BASELINE_NEEDS_ONE_UAC' @{ step = 'vTPM local key protector'; elevatedCommand = "Set-VMKeyProtector -VMName $($script:Drill.VmName) -NewLocalKeyProtector"; message = $_.Exception.Message }) }
  Add-VMDvdDrive -VM $vm -Path $script:Drill.Iso
  Add-VMDvdDrive -VM $vm -Path $script:Drill.AnswerIso
  Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMDvdDrive -VM $vm)[0]

  # Everything after Start-VM: any stop turns the VM off (it never stays running) and leaves the screen and the step log as
  # evidence; the VM keeps no checkpoint, so the next run rebuilds it.
  $log = Join-Path $RunDir 'baseline-steps.log'
  $note = { param([string]$m) Add-Content -LiteralPath $log -Value ("{0} {1}" -f [DateTimeOffset]::UtcNow.ToString('o'), $m) -Encoding UTF8 }
  $started = [DateTimeOffset]::UtcNow
  $guard = $null
  $off = $false
  try {
    $guard = Start-DrillHostGuard $RunDir
    Start-DrillGuardedVm
    & $note 'started; sending boot keys'
    $keys = Send-DrillBootKeys $script:Drill.VmName $script:Drill.BootKeySeconds
    & $note "boot keys sent: $keys; waiting for setup and OOBE to finish"
    Wait-DrillSetupSignal $script:Drill.InstallTimeoutMinutes   # no logon attempt before this: see SetupSignalName
    & $note 'setup-complete signal read (KVP); waiting for PowerShell Direct'
    [void](Wait-DrillGuest $cred 15)
    $installMinutes = [Math]::Round(([DateTimeOffset]::UtcNow - $started).TotalMinutes, 1)
    & $note "setup and OOBE finished after $installMinutes min"

    # Settle (idempotent, so it survives a guest restart): never-expiring local password (a restored checkpoint must still log in
    # months later), no sleep/hibernate, no automatic updates (every drill starts from the same bits), WSL and VMP enabled.
    $settle = Invoke-DrillGuest $cred {
      $ErrorActionPreference = 'Stop'
      Set-LocalUser -Name $args[0] -PasswordNeverExpires $true
      & powercfg.exe /hibernate off | Out-Null
      & powercfg.exe /change standby-timeout-ac 0 | Out-Null
      & powercfg.exe /change monitor-timeout-ac 0 | Out-Null
      $au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
      New-Item -Path $au -Force | Out-Null
      Set-ItemProperty -Path $au -Name NoAutoUpdate -Value 1 -Type DWord
      $f = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux, VirtualMachinePlatform -All -NoRestart -WarningAction SilentlyContinue
      $os = Get-CimInstance Win32_OperatingSystem
      [ordered]@{ caption = $os.Caption; build = $os.BuildNumber; edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID; host = $env:COMPUTERNAME; restartNeeded = [bool]$f.RestartNeeded }
    } -ArgumentList @($script:Drill.GuestUser) -TimeoutMinutes 20 -Step 'settle' -Restartable
    & $note "settled: $($settle.caption) $($settle.build) $($settle.edition)"
    if ([string]$settle.edition -cne 'Professional') { throw (New-DrillError 'DRILL_BASELINE_NOT_PRO' @{ edition = [string]$settle.edition }) }

    $beforeReboot = [DateTimeOffset]::UtcNow
    try { Invoke-Command -VMName $script:Drill.VmName -Credential $cred -ScriptBlock { Restart-Computer -Force } -ErrorAction Stop } catch { }
    [void](Wait-DrillGuest $cred 20 $beforeReboot)
    & $note 'restarted for the features'
    $nested = Invoke-DrillGuest $cred {
      $feat = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') | ForEach-Object { [ordered]@{ name = $_; state = [string](Get-WindowsOptionalFeature -Online -FeatureName $_).State } }
      $hv = @(Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Hypervisor-Operational' -MaxEvents 20 -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { "$($_.Id):$($_.Message.Split([Environment]::NewLine)[0])" })
      [ordered]@{ features = @($feat); hypervisorEvents = $hv; vbs = [string](Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue).VirtualizationBasedSecurityStatus }
    } -TimeoutMinutes 5 -Step 'features' -Restartable
    if (@($nested.features | Where-Object { [string]$_.state -ne 'Enabled' }).Count) { throw (New-DrillError 'DRILL_BASELINE_FEATURES_NOT_ENABLED' $nested.features) }
    Stop-VM -VM $vm -Force   # graceful shutdown
    if ((Get-VM -Name $script:Drill.VmName).State -ne 'Off') { throw (New-DrillError 'DRILL_BASELINE_NOT_OFF') }
    $off = $true
  } catch {
    [void](Save-DrillScreen $script:Drill.VmName (Join-Path $RunDir 'baseline-failure.bmp'))
    $c = Get-DrillCode $_
    & $note "stopped: $($c.code)"
    throw
  } finally {
    try {
      if (-not $off -and -not (Stop-DrillGuardedVm $guard)) { throw (New-DrillError 'DRILL_BASELINE_NOT_OFF') }
    } finally {
      Stop-DrillHostGuard $guard
      if ($guard -and $guard.state.failure) { throw (New-DrillError $guard.state.failure.code $guard.state.failure.detail) }
    }
  }
  # Both DVD drives go (removing a drive takes its medium with it; ejecting first made the removal fail: 2026-11-16 12:18),
  # and only now is the network plugged in.
  foreach ($d in @(Get-VMDvdDrive -VM $vm)) { Remove-VMDvdDrive -VMDvdDrive $d }
  Connect-VMNetworkAdapter -VMName $script:Drill.VmName -SwitchName $script:Drill.Switch
  Remove-Item -LiteralPath $script:Drill.AnswerIso -Force
  Checkpoint-VM -VM $vm -SnapshotName $script:Drill.Checkpoint
  & $note "checkpoint $($script:Drill.Checkpoint) taken (Off)"
  return [ordered]@{ action = $decision.action; checkpoint = $script:Drill.Checkpoint; isoSha256 = $isoCheck.sha256; bootKeysSent = $keys; installMinutes = $installMinutes; guest = $settle; nested = $nested }
}

# The guest reads of one verdict pass: status, current, facts, verify. Inside the VM only.
$script:GuestRead = {
  param($Root, $NativeText)
  $ErrorActionPreference = 'Stop'
  $native = [scriptblock]::Create($NativeText)
  $read = { param($p) if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
  $status = & $read (Join-Path $Root 'state\status.json')
  $current = & $read (Join-Path $Root 'upgrade\current.json')
  $factsFile = Join-Path $Root 'upgrade\mailbox\responses\version-facts.json'
  $facts = & $read $factsFile
  # the pause the node holds (A6 holds it to the one the launcher confirmed): the file's sha256 and the request it names
  $pausedFile = Join-Path $Root 'state\PAUSED.json'
  $pause = $null
  if (Test-Path -LiteralPath $pausedFile -PathType Leaf) {
    $pausedSource = try { (Get-Content -LiteralPath $pausedFile -Raw -Encoding UTF8 | ConvertFrom-Json).source } catch { $null }
    $pause = [ordered]@{ sha256 = (Get-FileHash -LiteralPath $pausedFile -Algorithm SHA256).Hash.ToLowerInvariant()
      requestSha256 = $(if ($pausedSource -and $pausedSource.PSObject.Properties['requestSha256']) { [string]$pausedSource.requestSha256 } else { $null }) }
  }
  $verify = [ordered]@{ status = 'NOT_RUN'; exit = $null; tail = @(); stderr = $null }
  $receipt = Join-Path $Root 'install\install-receipt.json'
  if ($current -and (Test-Path -LiteralPath $receipt)) {
    $script = Join-Path $Root ("resident\" + $current.residentManifestSha256 + "\windows\verify-resident.ps1")
    $rs = (Get-FileHash -LiteralPath $receipt -Algorithm SHA256).Hash.ToLowerInvariant()
    $n = & $native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-ExpectedInstallReceiptSha256', $rs, '-LinuxVersionFactsFile', $factsFile) 840
    $out = @($n.stdout -split "`r?`n")
    $verdict = @($out | Where-Object { $_ -match 'RESIDENT_VERIF' }) | Select-Object -Last 1
    $verify = [ordered]@{ status = $(if ($verdict -match '(RESIDENT_[A-Z_]+)') { $Matches[1] } else { 'UNPARSED' }); exit = $n.exit; tail = @($out | Select-Object -Last 40); stderr = $n.stderr }
  }
  [ordered]@{ status = $status; current = $current; facts = $facts; pause = $pause; verify = $verify; readAt = [DateTimeOffset]::UtcNow.ToString('o') }
}

# Copy the pinned prerequisites into the VM, re-check their hashes there, install them (GuestPrereq). Stops on any miss.
function Invoke-DrillPrereqInGuest([string]$RunDir, $Prereq, [pscredential]$Cred) {
  $dest = "$($script:Drill.GuestWork)\prereq"
  $files = @($Prereq.wsl, $Prereq.rootfs) + @($Prereq.debs)
  $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
  try {
    Invoke-Command -Session $session -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d, (Join-Path $d 'debs') | Out-Null } -ArgumentList $dest
    foreach ($rel in $files) { Copy-Item -LiteralPath (Join-Path $Prereq.dir $rel) -Destination (Join-Path $dest $rel) -ToSession $session }
    $want = @{}; foreach ($rel in $files) { $want[$rel] = Get-Sha256Hex (Join-Path $Prereq.dir $rel) }
    $bad = Invoke-Command -Session $session -ScriptBlock { param($d, $w) @($w.Keys | Where-Object { (Get-FileHash -LiteralPath (Join-Path $d $_) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $w[$_] }) } -ArgumentList $dest, $want
    if (@($bad).Count) { throw (New-DrillError 'DRILL_PREREQ_CHANGED_IN_COPY' @($bad)) }
  } finally { Remove-PSSession -Session $session }
  try { $facts = Invoke-DrillGuest $Cred $script:GuestPrereq -ArgumentList @($dest, $Prereq.wsl, $Prereq.rootfs, $Prereq.distribution, $Prereq.wslVersion, $script:DrillNativeText) -TimeoutMinutes $script:Drill.PrereqTimeoutMinutes -Code 'DRILL_PREREQ_TIMEOUT' -Step 'prereq' }
  catch { $c = Get-DrillCode $_; if ($c.code -ne 'DRILL_GUEST_STEP_FAILED') { throw }; throw (New-DrillError 'DRILL_PREREQ_FAILED' $c.detail) }
  Write-DrillJson (Join-Path $RunDir 'prereq-facts.json') $facts
  if (Get-Prop $facts 'failure') { throw (New-DrillError 'DRILL_PREREQ_FAILED' (Get-Prop $facts 'failure')) }
  if ($facts.dpkgExit -ne 0 -or $facts.dpkgAuditLines -ne 0 -or -not $facts.dockerActive -or -not $facts.systemdPid1) {
    throw (New-DrillError 'DRILL_PREREQ_NOT_READY' @{ dpkgExit = $facts.dpkgExit; audit = $facts.dpkgAuditLines; docker = $facts.dockerActive; systemd = $facts.systemdPid1 }) }
  return $facts
}

# Until PowerShell Direct can arm the guest's own timer, a detached copy of this script covers loss of the host process.
# It never starts a VM or releases a hold. The parent signals completion once the timer is installed or the VM is restored.
function Invoke-DrillBootWatchdog([string]$Signal, [int]$ParentId, [long]$ParentStarted, [guid]$VmId, [DateTimeOffset]$Deadline) {
  $mutex = [Threading.Mutex]::new($false, $script:Drill.BootMutex)
  $locked = $false; $parent = $null
  try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    $parent = [Diagnostics.Process]::GetProcessById($ParentId)
    if ($parent.StartTime.ToUniversalTime().Ticks -ne $ParentStarted) { return }
    [IO.File]::WriteAllText("$Signal.ready", '')
    while (-not (Test-Path -LiteralPath "$Signal.armed") -and (Get-DrillTime) -lt $Deadline) {
      if ($parent.WaitForExit(500)) {
        if (-not (Test-Path -LiteralPath "$Signal.starting")) { return }
        # A Start-VM request submitted before the process died can still become visible asynchronously.
        try {
          $info = Get-DrillVmInfo
          if ($info -and $info.vm.Id -eq $VmId -and $info.notes -ceq $script:Drill.Marker -and $info.state -ne 'Off') {
            $stopped = Stop-DrillOwnedVm -RestoreCheckpoint
            Write-DrillWatchdogOutcome $Signal 'PARENT_GONE' $stopped
            if ($stopped) { return }
          }
        } catch { Write-DrillWatchdogOutcome $Signal 'PARENT_GONE' $false }
        Start-Sleep -Milliseconds 500
      }
    }
    # A final cleanup at the boundary also covers a foreground stuck before timer registration.
    if (-not (Test-Path -LiteralPath "$Signal.armed")) {
      $info = Get-DrillVmInfo
      if ($info -and $info.vm.Id -eq $VmId -and $info.notes -ceq $script:Drill.Marker) {
        $stopped = $false
        try { $stopped = Stop-DrillOwnedVm -RestoreCheckpoint } finally { Write-DrillWatchdogOutcome $Signal 'TIMER_NOT_ARMED_BY_DEADLINE' $stopped }
      }
    }
  } finally {
    if ($parent) { $parent.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

# The boot watchdog's record of a restore it made (Codex review of 1cedea9ef, medium 4): its parent is gone, so there is no receipt; the
# record sits beside the run as <signal>.outcome.json. It acts only before the guest's own timer is armed, that is before the run's first
# step, so no evidence was taken.
function Write-DrillWatchdogOutcome([string]$Signal, [string]$Why, $Stopped) {
  $restore = if ($Stopped -eq $true) { 'RESTORED' } else { 'RESTORE_FAILED' }
  $r = [ordered]@{ status = 'DRILL_WATCHDOG_RESTORE'; why = $Why; restore = $restore; evidence = 'NOT_TAKEN'
    note = $(if ($restore -ceq 'RESTORED') { '由开机看门进程紧急还原，证据未取' } else { '开机看门进程紧急还原失败，证据未取' }); at = [DateTimeOffset]::UtcNow.ToString('o') }
  try { Write-DrillJson "$Signal.outcome.json" $r } catch { }
}

# What of the run's evidence the run directory holds after an emergency restore: none, all or part of it.
function Get-DrillAbortEvidence([string]$RunDir) {
  $expected = @('first-install.log', 'stage-evidence.json', 'read-after-install.json', 'read-after-reboot.json', 'm5')
  $taken = @($expected | Where-Object { Test-Path -LiteralPath (Join-Path $RunDir $_) })
  [ordered]@{ evidence = $(if ($taken.Count -eq 0) { 'NOT_TAKEN' } elseif ($taken.Count -eq $expected.Count) { 'TAKEN' } else { 'PARTIAL' }); taken = $taken
    notTaken = @($expected | Where-Object { $taken -notcontains $_ }) }
}

# The host guard's emergency restore, as it ended (its host-guard.json, DRILL_ABORTED): restored, restore failed, or not known (a record
# from before its cleanup); and what evidence the run had taken by then.
function Get-DrillGuardOutcome([string]$RunDir) {
  $file = Join-Path $RunDir 'host-guard.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $g = try { Read-DrillJson $file } catch { $null }
  if ([string](Get-Prop $g 'status') -cne 'DRILL_ABORTED') { return $null }
  $restore = if ((Get-Prop $g 'restoredToCheckpoint') -eq $true) { 'RESTORED' } elseif ((Get-Prop $g 'cleanupDone') -eq $true) { 'RESTORE_FAILED' } else { 'UNKNOWN' }
  $ev = Get-DrillAbortEvidence $RunDir
  $head = @{ RESTORED = '由守护紧急还原'; RESTORE_FAILED = '守护紧急还原失败'; UNKNOWN = '守护紧急还原，结局未记下' }[$restore]
  $tail = @{ NOT_TAKEN = '证据未取'; TAKEN = '证据已取'; PARTIAL = '证据部分已取' }[$ev.evidence]
  [ordered]@{ note = ($head + '，' + $tail); code = (Get-Prop $g 'code'); restore = $restore; cleanupFailure = (Get-Prop $g 'cleanupFailure')
    evidence = $ev.evidence; taken = $ev.taken; notTaken = $ev.notTaken }
}

# Seconds from asking WMI for the watchdog until it must have signalled ready; the WMI calls count against it.
$script:DrillWatchdogReadySeconds = 15

function Get-DrillWatchdogTimeout([Diagnostics.Stopwatch]$Clock) {
  $left = [Math]::Ceiling($script:DrillWatchdogReadySeconds - $Clock.Elapsed.TotalSeconds)
  if ($left -lt 1) { throw (New-DrillError 'DRILL_WATCHDOG_READY_TIMEOUT') }
  return [uint32]$left
}

function Start-DrillDetachedWatchdog([string]$EncodedCommand, [Diagnostics.Stopwatch]$Clock) {
  if (-not ('CluedDrill.WatchdogJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CluedDrill {
  public static class WatchdogJob {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
  }
}
'@
  }
  # WMI creates the watchdog under its own provider host, so it inherits no job from the caller.
  # An agent session's job refuses breakaway, and that session is exactly what may be killed mid-drill.
  $image = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $EncodedCommand"
  try {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -OperationTimeoutSec (Get-DrillWatchdogTimeout $Clock) -ErrorAction Stop -Arguments @{
      CommandLine = "`"$image`" $arguments"; CurrentDirectory = "$env:SystemRoot\System32"; ProcessStartupInformation = $startup
    }
  } catch {
    if ((Get-DrillCode $_).code -ne 'DRILL_UNEXPECTED') { throw }
    throw (New-DrillError 'DRILL_WATCHDOG_WMI_CREATE_FAILED' (Get-DrillCode $_).detail)
  }
  $id = [int](Get-Prop $created 'ProcessId')
  if ((Get-Prop $created 'ReturnValue') -ne 0 -or $id -le 0) {
    throw (New-DrillError 'DRILL_WATCHDOG_WMI_CREATE_REFUSED' @{ returnValue = (Get-Prop $created 'ReturnValue'); processId = $id })
  }
  # The open handle pins the PID: while we hold it, no other process can take this PID. Only after the command line read
  # under that pin matches this launch is the handle known to be the watchdog; until then nothing is terminated.
  $worker = $null
  try {
    $worker = [Diagnostics.Process]::GetProcessById($id)
    [void]$worker.Handle
    $seen = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$id" -OperationTimeoutSec (Get-DrillWatchdogTimeout $Clock) -ErrorAction Stop
    $line = ([string](Get-Prop $seen 'CommandLine')).TrimEnd()
    if ($worker.HasExited -or -not $line.EndsWith($arguments, [StringComparison]::Ordinal)) { throw 'not this launch' }
  } catch {
    if ($worker) { $worker.Dispose() }
    if ((Get-DrillCode $_).code -eq 'DRILL_WATCHDOG_READY_TIMEOUT') { throw }
    throw (New-DrillError 'DRILL_WATCHDOG_IDENTITY_UNCONFIRMED' @{ processId = $id; reason = (Get-DrillCode $_).detail })
  }
  $inJob = $false
  $queried = [CluedDrill.WatchdogJob]::IsProcessInJob($worker.Handle, [IntPtr]::Zero, [ref]$inJob)
  if ($queried -and -not $inJob) { return $worker }
  # A watchdog inside a job dies with its launcher, so it protects nothing; it must be gone before the refusal stands,
  # or it would keep the boot mutex and block the next drill.
  $detail = [ordered]@{ processId = $id; inJob = $inJob; jobQueryError = $null; terminated = $false; killError = $null }
  if (-not $queried) { $detail.jobQueryError = [ComponentModel.Win32Exception]::new().Message }
  try { $worker.Kill() } catch { $detail.killError = $_.Exception.Message }
  try { $detail.terminated = $worker.WaitForExit(5000) } catch { $detail.killError = "$($detail.killError) $($_.Exception.Message)".Trim() }
  $worker.Dispose()
  throw (New-DrillError 'DRILL_WATCHDOG_IN_JOB' $detail)
}

# Returns the signal path and the watchdog's process, which stays open: Start-DrillGuardedVm re-checks it right before Start-VM.
function Start-DrillBootWatchdog([string]$RunDir, [guid]$VmId, [DateTimeOffset]$Deadline) {
  $signal = Join-Path $RunDir 'guest-shutdown'
  $parentStarted = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
  $file = $script:DrillScriptPath.Replace("'", "''")
  $escapedSignal = $signal.Replace("'", "''")
  $command = ". '$file'; Invoke-DrillBootWatchdog '$escapedSignal' $PID $parentStarted '$VmId' '$($Deadline.ToString('o'))'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try { $worker = Start-DrillDetachedWatchdog $encoded $clock }
  catch { throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY' (Get-DrillCode $_)) }
  $ready = $false
  try {
    while (-not $worker.HasExited -and $clock.Elapsed.TotalSeconds -lt $script:DrillWatchdogReadySeconds) {
      # Ready counts only while the watchdog is still alive after the signal was seen.
      if ((Test-Path -LiteralPath "$signal.ready") -and -not $worker.HasExited) { $ready = $true; return @{ signal = $signal; process = $worker } }
      Start-Sleep -Milliseconds 100
    }
    throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY' @{ exited = $worker.HasExited })
  } finally { if (-not $ready) { $worker.Dispose() } }
}

function Assert-DrillWatchdogAlive($Watchdog) {
  $process = Get-Prop $Watchdog 'process'
  if (-not $process -or $process.HasExited) {
    throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY' @{ code = 'DRILL_WATCHDOG_EXITED_BEFORE_BOOT' })
  }
}

$script:GuestShutdownTimer = {
  param($Deadline, $GuestName)
  if ($env:COMPUTERNAME -ine $GuestName) { throw 'DRILL_GUEST_IDENTITY_REFUSED' }
  $when = [DateTimeOffset]::ParseExact($Deadline, 'o', [Globalization.CultureInfo]::InvariantCulture)
  if ($when -le [DateTimeOffset]::UtcNow) { throw 'DRILL_RUN_TIMEOUT' }
  # The startup trigger re-arms from the same UTC deadline after any guest reboot, including A7.
  $shutdown = @'
    $when = [DateTimeOffset]::ParseExact('__UTC_DEADLINE__', 'o', [Globalization.CultureInfo]::InvariantCulture)
    $seconds = [Math]::Ceiling(($when - [DateTimeOffset]::UtcNow).TotalSeconds)
    if ($seconds -gt 0) { Start-Sleep -Seconds $seconds }
    & "$env:SystemRoot\System32\shutdown.exe" /s /f /t 0
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($shutdown.Replace('__UTC_DEADLINE__', $Deadline)))
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
  $triggers = @((New-ScheduledTaskTrigger -Once -At $when.LocalDateTime), (New-ScheduledTaskTrigger -AtStartup))
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'CluedDrillGuestShutdown' -Action $action -Trigger $triggers -Settings $settings -User 'SYSTEM' -ErrorAction Stop | Out-Null
  return $true
}

# Restore the clean checkpoint, start the VM behind the memory gate, run $Body with the guest credential, and always end Off
# and restored, whatever happened. Returns the outcome and guard observations.
function Invoke-DrillOnCheckpoint([scriptblock]$Body, [string]$RunDir, $Window) {
  $result = $null; $failure = $null; $restored = $false; $guard = $null; $cleanupNeeded = $false; $signal = $null; $watchdog = $null
  $executorStates = @()
  try {
    [void](Assert-DrillHostSafety -HoldUntil $Window.holdUntil)
    $info = Get-DrillVmInfo
    $decision = Get-DrillBaselineAction $info
    if ($decision.action -ne 'ready') { throw (New-DrillError $(if ($decision.code) { $decision.code } else { 'DRILL_CHECKPOINT_NOT_READY' })) }
    $Window.safeToResume = $false
    $cleanupNeeded = $true
    Restore-VMCheckpoint -VMName $script:Drill.VmName -Name $script:Drill.Checkpoint -Confirm:$false
    [void](Assert-DrillHost -HoldUntil $Window.holdUntil)
    $cred = Get-DrillCredential
    $guard = Start-DrillHostGuard $RunDir -RestoreCheckpoint -Window $Window
    $watchdog = Start-DrillBootWatchdog $RunDir $info.vm.Id $Window.deadline
    $signal = Get-Prop $watchdog 'signal'
    Start-DrillGuardedVm $watchdog
    [void](Wait-DrillGuest $cred 15)
    $armed = Invoke-DrillGuest $cred $script:GuestShutdownTimer -ArgumentList @($Window.deadline.ToString('o'), $script:Drill.ComputerName) -TimeoutMinutes 1 -Step 'guest-shutdown-timer'
    if ($armed -ne $true) { throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_TIMER_NOT_ARMED') }
    [IO.File]::WriteAllText("$signal.armed", '')
    $result = & $Body $cred
    Assert-DrillGuard
  } catch { $failure = Get-DrillCode $_ }
  finally {
    try {
      if ($cleanupNeeded) { $restored = Stop-DrillGuardedVm $guard -RestoreCheckpoint }
    } catch { $restored = $false }
    if ($restored -and $signal) { try { [IO.File]::WriteAllText("$signal.armed", '') } catch { } }
    if ($cleanupNeeded) { $Window.safeToResume = $restored }
    $watchdogProcess = Get-Prop $watchdog 'process'
    if ($watchdogProcess) { $watchdogProcess.Dispose() }
    Stop-DrillHostGuard $guard
    if ($guard) {
      $executorStates = @($guard.state.executorStates.Values)
      if ($guard.state.failure) { $failure = $guard.state.failure; $result = $null }
    }
  }
  return @{ result = $result; failure = $failure; restored = $restored; hostExecutorStates = $executorStates }
}

$script:GuestReinstall = {
  param($Node, $Tree, $From, $Work, $Version, $TarName, $AccName, $TarSha, $NativeText)
  $native = [scriptblock]::Create($NativeText)
  $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
  $last = { param($lines) $l = @($lines | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1; if ($l) { try { $l | ConvertFrom-Json } catch { $null } } }
  $upRun = & $native $Node @((Join-Path $fleet 'upgrade.mjs'), 'fetch', '--version', $Version, '--work', (Join-Path $Work 'a8-upgrade'), '--from', $From, '--no-request') 3600
  $p1Run = & $native $Node @((Join-Path $fleet 'install.mjs'), 'prepare', '--artifact', (Join-Path $From $TarName), '--artifact-sha', $TarSha, '--acceptance', (Join-Path $From $AccName), '--work', (Join-Path $Work 'a8-prepare')) 3600
  $up = @($upRun.stdout -split "`r?`n"); $p1 = @($p1Run.stdout -split "`r?`n")
  $upj = & $last $up; $p1j = & $last $p1
  $reinstall = [ordered]@{ skipped = $false;
    upgradeStatus = $(if ($upj -and $upj.PSObject.Properties['status']) { [string]$upj.status });
    prepareStatus = $(if ($p1j -and $p1j.PSObject.Properties['status']) { [string]$p1j.status });
    launcherVerdict = 'NOT_RUN_MISSING_RUN_COMMAND'; launcherStatus = $null; launcherExit = $null; launcherTail = @(); launcherStderr = $null;
    upgradeTail = @($up | Where-Object { $_ -ne '' } | Select-Object -Last 5); prepareTail = @($p1 | Where-Object { $_ -ne '' } | Select-Object -Last 5);
    upgradeExit = $upRun.exit; upgradeStderr = $upRun.stderr; prepareExit = $p1Run.exit; prepareStderr = $p1Run.stderr;
    reverifyPassed = $false; prepareAgainStatus = $null }
  $runCommand = if ($p1j) { $p1j.PSObject.Properties['runCommand'] }
  if ($runCommand -and $runCommand.Value -is [string] -and -not [string]::IsNullOrWhiteSpace($runCommand.Value)) {
    try {
      # Use the accepted package's parser and verdict for the launcher's indented terminal JSON.
      . (Join-Path $fleet 'bootstrap.ps1') -From $From
      $launch = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $runCommand.Value) 0
      $reinstall.launcherExit = $launch.exit
      $reinstall.launcherStatus = Get-Key $launch.last 'status'
      $reinstall.launcherVerdict = (Get-LauncherVerdict $false $launch.last).status
      $reinstall.launcherTail = @($launch.stdout -split "`r?`n" | Select-Object -Last 20)
      $reinstall.launcherStderr = $launch.stderr
    } catch {
      $reinstall.launcherVerdict = 'DRILL_LAUNCHER_ERROR'
      $reinstall.launcherStderr = $_.Exception.Message
    }
  }
  return $reinstall
}

# The public allowlist in docs/ci-connection.md (renewal package). Only the two profile SIDs leave the acceptance file.
$script:GuestM5Files = {
  param($Root)
  $files = [ordered]@{
    'profile.json' = $null
    'system.json' = (Join-Path $Root 'broker\renew-key.json')
    'resident.json' = (Join-Path $Root 'state\renew-key-resident.json')
    'controller.json' = (Join-Path (Split-Path -Parent $Root) 'state\v2\receipts\renew-key-controller.json')
    'companion.json' = (Join-Path $Root 'mailbox\responses\renew-key.json')
    'probe.json' = $null
  }
  $readSmall = {
    param($Path)
    try {
      if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
      $file = Get-Item -LiteralPath $Path
      if ($file.Length -gt 8192 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      if ($bytes.Length -le 8192) { [Convert]::ToBase64String($bytes) }
    } catch { }
  }
  $public = @{}
  foreach ($name in $files.Keys) {
    if ($files[$name]) { $public[$name] = & $readSmall $files[$name] }
  }
  $acceptance = Join-Path $Root 'record\acceptance.json'
  try {
    if (Test-Path -LiteralPath $acceptance -PathType Leaf) {
      $node = (Get-Content -LiteralPath $acceptance -Raw -Encoding UTF8 | ConvertFrom-Json).node
      if ($node -and $node.controllerSid -is [string] -and $node.ownerSid -is [string] -and
          $node.controllerSid -cmatch '^S-1-5-21-(\d+-){3}\d+$' -and $node.ownerSid -cmatch '^S-1-5-21-(\d+-){3}\d+$') {
        $profile = @{ controllerSid = $node.controllerSid; ownerSid = $node.ownerSid } | ConvertTo-Json -Compress
        $public['profile.json'] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($profile))
      }
    }
  } catch { }
  $latest = [DateTimeOffset]::MinValue
  foreach ($name in @('renew-ci.json', 'renew-upgrade.json')) {
    $data = & $readSmall (Join-Path $Root "broker\$name")
    if (-not $data) { continue }
    # Keep one observation, using the newer recorded probe when both kinds exist.
    if (-not $public.ContainsKey('probe.json')) { $public['probe.json'] = $data }
    try {
      $probe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data)) | ConvertFrom-Json
      $at = [DateTimeOffset]$probe.at
      if ($at -gt $latest) { $latest = $at; $public['probe.json'] = $data }
    } catch { }
  }
  # record.json: the connection record as this administrator reads it (Fable renew-key ruling, supplement "eight on the path", item 8).
  # Whether it is there, never its content: PRESENT, or ABSENT when the file or its directory is not found (install-resident.ps1's
  # baseline reads it the same way); any other answer leaves the observation missing, so M5 fails.
  try {
    [void][IO.File]::GetAttributes((Join-Path (Split-Path -Parent $Root) 'secrets\ci-admission.connection.json')); $record = 'PRESENT'
  } catch [IO.FileNotFoundException] { $record = 'ABSENT' } catch [IO.DirectoryNotFoundException] { $record = 'ABSENT' } catch { $record = $null }
  if ($record) { $public['record.json'] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"ci-admission.connection.json":"' + $record + '"}')) }
  return $public
}

function Copy-DrillM5([string]$RunDir, [pscredential]$Cred) {
  $dir = Join-Path $RunDir 'm5'
  New-Item -ItemType Directory -Path $dir | Out-Null
  $names = @('profile.json', 'system.json', 'resident.json', 'controller.json', 'companion.json', 'probe.json', 'record.json')
  $missing = @(); $code = $null
  try { $files = Invoke-DrillGuest $Cred $script:GuestM5Files -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 2 -Step 'm5-observations' }
  catch { $files = $null; $code = (Get-DrillCode $_).code }
  foreach ($name in $names) {
    $data = if ($files -is [System.Collections.IDictionary]) { $files[$name] }
    if (-not $data) { $missing += $name; continue }
    [IO.File]::WriteAllBytes((Join-Path $dir $name), [Convert]::FromBase64String($data))
  }
  return @{ directory = 'm5'; missing = $missing; collectionCode = $code }
}

function Get-DrillM5Verdict([string]$RunDir, $M5) {
  if (-not $M5) { return @{ result = 'FAIL'; detail = 'DRILL_M5_OBSERVATIONS_MISSING' } }
  $M5.result = 'FAIL'
  if ($M5.collectionCode -or $M5.missing.Count -ne 0) {
    $M5.detail = 'DRILL_M5_OBSERVATIONS_MISSING'
    return $M5
  }
  $resident = Split-Path -Parent (Split-Path -Parent $script:DrillScriptPath)
  $checker = Join-Path $resident 'test\renewal-drill.mjs'
  if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
    $M5.detail = 'DRILL_M5_HOST_CHECKER_MISSING'
    return $M5
  }
  try {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $run = Invoke-DrillNode $node @($checker, (Join-Path $RunDir $M5.directory)) 30
    $M5.verdict = ConvertFrom-Json -InputObject $run.stdout
    $M5.exit = $run.exit
    if ($run.exit -eq 0 -and (Get-Prop $M5.verdict 'result') -ceq 'PASS') {
      $M5.result = 'PASS'
    }
  } catch { $M5.detail = 'DRILL_M5_CHECKER_FAILED' }
  return $M5
}

# A7's read after the reboot: the status and the boot it was read in, from the same guest call. The read is restartable, so the guest may
# have restarted again since the boot the drill waited for (Codex review of 58136df61, high 1): every sample is judged against its own boot.
$script:GuestReadStatus = {
  param($Root) $p = Join-Path $Root 'state\status.json'
  $s = if (Test-Path $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  [ordered]@{ status = $s; readAt = [DateTimeOffset]::UtcNow.ToString('o'); boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o') }
}

# One A7 sample: the status rewritten after the boot it was read in, and a passing self-check observed after that same boot (never one an
# earlier boot left in the status). bootChanged: the guest restarted again after the boot the drill waited for.
function Get-DrillRebootSample($Sample, [DateTimeOffset]$WaitedBoot) {
  $boot = [string](Get-Prop $Sample 'boot')
  $known = $false; $changed = $false
  try { $b = [DateTimeOffset]::Parse($boot, [Globalization.CultureInfo]::InvariantCulture); $known = $b -ge $WaitedBoot; $changed = $b -gt $WaitedBoot } catch { $known = $false }
  $status = Get-Prop $Sample 'status'
  $ok = $known -and (Test-DrillAfterBoot ([string](Get-Prop $status 'writtenAt')) $boot)
  $done = $ok -and [string](Get-Prop $status 'versions.selfcheck.result') -ceq 'PASS' -and (Test-DrillAfterBoot ([string](Get-Prop $status 'versions.selfcheck.observedAt')) $boot)
  [ordered]@{ ok = $ok; status = $status; readAt = (Get-Prop $Sample 'readAt'); boot = $(if ($known) { $boot } else { $null }); waitedBoot = $WaitedBoot.ToString('o'); bootChanged = $changed; done = $done }
}

# Within the window of the boot the drill waited for ($Deadline), until a sample of the boot it was read in passes; the last sample otherwise.
function Wait-DrillRebootRefresh([pscredential]$Cred, [DateTimeOffset]$Boot, [DateTimeOffset]$Deadline) {
  $reboot = $null
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    $r = Invoke-DrillGuest $Cred $script:GuestReadStatus -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 2 -Step 'read-status' -Restartable
    $reboot = Get-DrillRebootSample $r $Boot
    if ($reboot.done) { break }
    Start-Sleep -Seconds 30
  }
  return $reboot
}

# A1's kit entry in the guest, once, bounded, read apart (Invoke-DrillNative): its last stdout line is the result, its stderr is kept.
$script:GuestEntry = {
  param($Entry, $EntryArgs, $Minutes, $NativeText)
  $native = [scriptblock]::Create($NativeText)
  $n = & $native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Entry) + @($EntryArgs)) ([int]$Minutes * 60)
  [ordered]@{ lines = @($n.stdout -split "`r?`n"); stderr = $n.stderr; exit = $n.exit }
}

# A8's second prepare after the reinstall, read the same way.
$script:GuestPrepareAgain = {
  param($Node, $Tree, $From, $Work, $TarName, $AccName, $TarSha, $NativeText)
  $native = [scriptblock]::Create($NativeText)
  $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
  $n = & $native $Node @((Join-Path $fleet 'install.mjs'), 'prepare', '--artifact', (Join-Path $From $TarName), '--artifact-sha', $TarSha, '--acceptance', (Join-Path $From $AccName), '--work', (Join-Path $Work 'a8-prepare-again')) 3600
  $l = @($n.stdout -split "`r?`n" | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
  # the status, with the exit code and stderr beside it for reinstall.json (Codex review of 58136df61, low 4)
  [ordered]@{ status = $(if ($l) { [string]($l | ConvertFrom-Json).status } else { 'UNPARSED' }); exit = $n.exit; stderr = $n.stderr }
}

function Invoke-DrillRun([string]$RunDir, $Package, $KitInfo, $Prereq, [pscredential]$Cred) {
  $g = $script:Drill.GuestWork
  $prereqFacts = if ($Interactive -or $KitInfo.prerequisiteMode -ceq 'first-install-host') { @{ mode = 'first-install-host'; preparedByEntry = (-not $Interactive) } } else { Invoke-DrillPrereqInGuest $RunDir $Prereq $Cred }
  $paths = @{ from = "$g\from"; kit = "$g\kit"; fake = "$g\fake"; work = "$g\work"; version = $Package.version }
  $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
  try {
    Invoke-Command -Session $session -ScriptBlock { param($p) foreach ($d in @($p.from, $p.kit, $p.work)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } -ArgumentList $paths
    foreach ($f in $Package.files) { Copy-Item -LiteralPath $f -Destination $paths.from -ToSession $session }
    Copy-Item -Path (Join-Path $KitInfo.dir '*') -Destination $paths.kit -ToSession $session -Recurse
    $tarInGuest = Invoke-Command -Session $session -ScriptBlock { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } -ArgumentList (Join-Path $paths.from ([IO.Path]::GetFileName($Package.tar)))
    if ($tarInGuest -cne $Package.tarSha256) { throw (New-DrillError 'DRILL_TAR_CHANGED_IN_COPY') }
    $fake = Invoke-Command -Session $session -ScriptBlock ([scriptblock]::Create(${function:New-DrillFakeCredentials}.ToString())) -ArgumentList $paths.fake
    Write-DrillJson (Join-Path $RunDir 'fake-credentials.public.json') $fake
  } finally { Remove-PSSession -Session $session }

  $timings = $null; $launcher = $null
  if ($Interactive) {
    $interactiveRun = Wait-DrillInteractive $RunDir $paths $Cred
    $entry = $interactiveRun.entry; $launcher = $interactiveRun.launcher; $Cred = $interactiveRun.credential
  } else {
  # A1: the kit entry, once, bounded. No retry.
  $entryArgs = Resolve-DrillKitArguments $KitInfo.arguments $paths
  $entryOut = Invoke-DrillGuest $Cred $script:GuestEntry -ArgumentList @((Join-Path $paths.kit $KitInfo.entryFile), $entryArgs, $KitInfo.timeoutMinutes, $script:DrillNativeText) -TimeoutMinutes $KitInfo.timeoutMinutes -Code 'DRILL_FIRST_INSTALL_TIMEOUT' -Step 'first-install'
  [IO.File]::WriteAllLines((Join-Path $RunDir 'first-install.log'), [string[]]@($entryOut.lines))
  [IO.File]::WriteAllText((Join-Path $RunDir 'first-install.stderr.log'), [string]$entryOut.stderr)
  $entry = Read-DrillEntryResult @($entryOut.lines) ([int]$entryOut.exit)
  $timings = Invoke-DrillGuest $Cred {
    $p = 'C:\drill\work\stage-timings.json'; if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json }
  } -TimeoutMinutes 2 -Step 'stage-timings'
  Write-DrillJson (Join-Path $RunDir 'stage-timings.json') $timings
  $stageEvidence = Invoke-DrillGuest $Cred {
    $r = [ordered]@{}
    foreach ($name in @('host-result.json', 'launcher-result.json')) {
      $p = Join-Path 'C:\drill\work' $name
      $r[$name] = if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    }
    $r
  } -TimeoutMinutes 2 -Step 'stage-evidence'
  Write-DrillJson (Join-Path $RunDir 'stage-evidence.json') $stageEvidence
  # the stages' complete stdout logs, as files of the run (the step record: Read-DrillFirstInstallSteps)
  $stageLogs = Invoke-DrillGuest $Cred {
    $r = [ordered]@{}
    foreach ($name in @('host.stdout.log', 'prepare.stdout.log', 'launcher.stdout.log')) { $p = Join-Path 'C:\drill\work' $name; $r[$name] = if (Test-Path -LiteralPath $p -PathType Leaf) { [IO.File]::ReadAllText($p) } else { $null } }
    $r
  } -TimeoutMinutes 2 -Step 'stage-logs'
  foreach ($name in @('host.stdout.log', 'prepare.stdout.log', 'launcher.stdout.log')) { $t = Get-DrillField $stageLogs $name; if ($t -is [string]) { [IO.File]::WriteAllText((Join-Path $RunDir $name), $t, (New-Object Text.UTF8Encoding($false))) } }
  # the launcher's terminal (what A6 reads the confirmed pause from), as the entry kept it in launcher-result.json
  $launcherResult = if ($stageEvidence -is [System.Collections.IDictionary]) { $stageEvidence['launcher-result.json'] } elseif ($stageEvidence) { $stageEvidence.PSObject.Properties['launcher-result.json'].Value }
  $launcher = Get-Prop $launcherResult 'terminal'
  }

  $first = Invoke-DrillGuest $Cred $script:GuestRead -ArgumentList @($script:Drill.GuestRoot, $script:DrillNativeText) -TimeoutMinutes 15 -Step 'read-after-install' -Restartable
  Write-DrillJson (Join-Path $RunDir 'read-after-install.json') $first

  # A7: reboot, nobody logs in; within 10 minutes the status is rewritten after the boot and the self-check still passes.
  $beforeReboot = [DateTimeOffset]::UtcNow
  try { Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { Restart-Computer -Force } -ErrorAction Stop } catch { }
  $boot = Wait-DrillGuest $Cred 15 $beforeReboot
  $reboot = Wait-DrillRebootRefresh $Cred $boot ($boot.AddMinutes($script:Drill.UnattendedRebootMinutes))
  Write-DrillJson (Join-Path $RunDir 'read-after-reboot.json') $reboot

  # A8: same package again: the generic upgrade answers "already at this package"; prepare -> launcher -> verify -> prepare.
  $reinstall = @{ skipped = $true }
  if (-not $SkipReinstall -and $entry.tree -and $entry.node) {
    $reinstall = Invoke-DrillGuest $Cred $script:GuestReinstall -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, $Package.version, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256, $script:DrillNativeText) -TimeoutMinutes 180 -Code 'DRILL_REINSTALL_TIMEOUT' -Step 'reinstall'
    Write-DrillJson (Join-Path $RunDir 'reinstall.json') $reinstall
  } elseif (-not $SkipReinstall) { $reinstall = @{ skipped = $false; upgradeStatus = 'NOT_RUN_ENTRY_GAVE_NO_TREE_OR_NODE'; prepareStatus = $null; reverifyPassed = $false; prepareAgainStatus = $null } }

  if (Test-DrillReinstallLauncher $reinstall) {
    $again = Invoke-DrillGuest $Cred $script:GuestRead -ArgumentList @($script:Drill.GuestRoot, $script:DrillNativeText) -TimeoutMinutes 15 -Step 'read-after-reinstall' -Restartable
    Write-DrillJson (Join-Path $RunDir 'read-after-reinstall.json') $again
    $reVerdict = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($again.readAt); entry = $entry; verify = $again.verify; status = $again.status; current = $again.current; facts = $again.facts; acceptanceSource = $Package.ciSourceManifestSha256; reboot = $null; reinstall = $null; kit = $KitInfo }
    $reinstall.reverifyPassed = @($reVerdict | Where-Object { $_.id -in @('A2', 'A3', 'A4') -and $_.pass -ne $true }).Count -eq 0 -and $null -eq (@($reVerdict | Where-Object { $_.id -eq 'A5' })[0].pass)
    $p2 = Invoke-DrillGuest $Cred $script:GuestPrepareAgain -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256, $script:DrillNativeText) -TimeoutMinutes 60 -Step 'prepare-again'
    $reinstall.prepareAgainStatus = [string](Get-Prop $p2 'status'); $reinstall.prepareAgainExit = $p2.exit; $reinstall.prepareAgainStderr = $p2.stderr
    Write-DrillJson (Join-Path $RunDir 'reinstall.json') $reinstall
  }

  $m5 = try { Copy-DrillM5 $RunDir $Cred } catch { @{ collectionCode = (Get-DrillCode $_).code } }
  return @{ entry = $entry; launcher = $launcher; first = $first; reboot = $reboot; reinstall = $reinstall; fake = $fake; prereq = $prereqFacts; timings = $timings; m5 = $m5 }
}

# ---------------------------------------------------------------- main
function Invoke-DrillMain {
  if ($Interactive -and ($BaselineOnly -or $PrereqOnly -or $Finalize)) { throw (New-DrillError 'DRILL_USAGE' '-Interactive is a full first-install run only') }
  # Fable renew-key ruling, supplements "interactive mode A1" and "branch two, two points" 2: A1's step record has one parser
  # (Read-DrillFirstInstallSteps); its source depends on the mode. In interactive mode the operator's window does not hold it: bootstrap.ps1
  # runs the host preparation and the launcher as elevated stages in their own window (Invoke-Elevated, Start-Process -Verb RunAs), their
  # output goes to the package's two stage output files (elevated-host-*.txt, elevated-launcher-*.txt) and only their verdict comes back.
  # Those two files are the source to connect (drill branch three); until then refused here, before anything is read, booted or held.
  if ($Interactive) { throw (New-DrillError 'DRILL_INTERACTIVE_STEP_RECORD_NOT_CONNECTED' 'the step record of an interactive first install has no source yet (逐步记录来源尚未接上)') }
  if ($Finalize) {
    if (-not $ProductionReadback) { throw (New-DrillError 'DRILL_USAGE' '-Finalize needs -ProductionReadback') }
    $receipt = Read-DrillJson $Finalize
    if ([string](Get-Prop $receipt 'contract') -cne $script:Drill.ReceiptContract) { throw (New-DrillError 'DRILL_RECEIPT_REFUSED') }
    $restored = Get-Prop $receipt 'restoredToCheckpoint'
    if ((Get-Prop $receipt 'failure') -or $restored -isnot [bool] -or -not $restored -or (Get-Prop $receipt 'conclusion') -ceq 'FAIL') {
      throw (New-DrillError 'DRILL_RECEIPT_NOT_FINALIZABLE' 'receipt failed or checkpoint restore was not confirmed')
    }
    $prod = Get-DrillProductionVerdict $receipt (Read-DrillJson $ProductionReadback)
    # every item but the ones the read-back judges stays as the run wrote it (A1 keeps its firstInstallSteps)
    $items = @($receipt.items | ForEach-Object { $i = $_; $p = @($prod | Where-Object { $_.id -eq $i.id }); if ($p.Count) { $p[0] } else { $i } })
    $receipt.items = $items
    $receipt.conclusion = Get-DrillConclusion $items (Get-Prop $receipt 'm5') ((Get-Prop $receipt 'candidate') -eq $true)
    $receipt | Add-Member -NotePropertyName finalizedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
    $receipt | Add-Member -NotePropertyName productionReadbackSha256 -NotePropertyValue (Get-Sha256Hex $ProductionReadback) -Force
    Write-DrillJson $Finalize $receipt
    return [ordered]@{ status = 'DRILL_FINALIZED'; conclusion = $receipt.conclusion; receipt = $Finalize }
  }

  $full = -not $BaselineOnly -and -not $PrereqOnly
  if ($full -and (-not $Version -or -not $From -or -not $Kit)) { throw (New-DrillError 'DRILL_USAGE' 'give -Version, -From and -Kit (or -BaselineOnly / -PrereqOnly / -Finalize)') }
  $package = $null; $kitInfo = $null; $prereq = $null
  if (-not $BaselineOnly) { $prereq = Read-DrillPrereq $script:Drill.PrereqDir }
  if ($full) {
    $kitInfo = Read-DrillKit $Kit; $package = Test-DrillPackageDir $From $Version $kitInfo
    if ($Interactive -and $kitInfo.prerequisiteMode -cne 'first-install-host') { throw (New-DrillError 'DRILL_INTERACTIVE_REQUIRES_RELEASE_KIT') }
    if ($kitInfo.prereqSha256 -cne $prereq.sha256) { throw (New-DrillError 'DRILL_KIT_PREREQ_NOT_THESE' @{ kit = $kitInfo.prereqSha256; prereq = $prereq.sha256 }) }
    $package.files = @(Get-DrillReleaseFiles $package $kitInfo)
    if ($kitInfo.executionBlocker) { throw (New-DrillError 'DRILL_FIRST_INSTALL_ENTRY_NOT_READY' $kitInfo.executionBlocker) }
  }
  Invoke-DrillWithHostHold $RunTimeoutMinutes {
    param($window)
    Invoke-DrillPreparedRun $window $package $kitInfo $prereq
  } -StandbyOnly:$BaselineOnly
}

function Invoke-DrillPreparedRun($Window, $Package, $KitInfo, $Prereq) {
  $mem = Assert-DrillHost -HoldUntil $Window.holdUntil
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $label = if ($Version) { $Version } elseif ($PrereqOnly) { 'prereq' } else { 'baseline' }
  $runDir = Join-Path $script:Drill.Runs "$stamp-$label-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null

  $baseline = Invoke-DrillBaseline $runDir -ExistingOnly:($Window.holdUntil -ne [DateTimeOffset]::MinValue)
  if ($BaselineOnly) {
    Write-DrillJson (Join-Path $runDir 'baseline.json') $baseline
    return [ordered]@{ status = 'DRILL_BASELINE_READY'; action = $baseline.action; checkpoint = $baseline.checkpoint; hostFreeGB = $mem.freeGB; evidence = (Join-Path $runDir 'baseline.json') }
  }
  if ($Window.deadline -eq [DateTimeOffset]::MinValue) { $Window.deadline = (Get-DrillTime).AddMinutes($RunTimeoutMinutes) }
  if ($PrereqOnly) {
    # The prerequisites alone, on a fresh copy of the baseline, then restored: WSL2 under nested virtualization, systemd, docker.
    $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillPrereqInGuest $runDir $prereq $cred } $runDir $Window
    $out = [ordered]@{ status = $(if ($o.failure) { 'DRILL_PREREQ_FAILED' } else { 'DRILL_PREREQ_READY' }); code = $(if ($o.failure) { $o.failure.code } else { $null });
      detail = $(if ($o.failure) { $o.failure.detail } else { $null }); restored = $o.restored; prereqSha256 = $prereq.sha256;
      evidence = (Join-Path $runDir 'prereq-facts.json'); hostExecutorStates = $o.hostExecutorStates }
    Write-DrillJson (Join-Path $runDir 'prereq-run.json') $out
    return $out
  }

  # M5 is collected for every package (Fable ruling 11-19 section 2.2); until the run reads it, it is not evaluated, which fails the receipt
  $m5 = @{ result = 'NOT_EVALUATED'; detail = 'DRILL_M5_RUN_INCOMPLETE' }
  $startedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillRun $runDir $Package $KitInfo $Prereq $cred } $runDir $Window
  $run = $o.result; $failure = $o.failure; $restored = $o.restored

  $evidence = [ordered]@{ localSource = $null; hostExecutorStates = $o.hostExecutorStates }
  $items = @()
  # The first install's step record, read first from what the run directory holds whatever the run's end: A1 needs it (Get-DrillVerdict),
  # and it is kept under A1, or in the evidence when the run ended before there was a verdict.
  $firstInstallSteps = Read-DrillFirstInstallSteps $runDir
  if ($run) {
    $evidence.localSource = [string](Get-Prop $run.first.current 'ciSourceManifestSha256')
    $evidence.stageTimingsSeconds = $run.timings
    $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; launcher = $run.launcher; pause = $run.first.pause; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = (Get-Prop $run 'reinstall'); skipReinstall = [bool]$SkipReinstall; kit = $kitInfo; candidate = [bool]$package['candidate']; firstInstallSteps = $firstInstallSteps }
  }
  $a1Item = @($items | Where-Object { $_.id -eq 'A1' }) | Select-Object -First 1
  if ($a1Item) { $a1Item.firstInstallSteps = $firstInstallSteps } else { $evidence.firstInstallSteps = $firstInstallSteps }
  # An emergency restore may come before the evidence was taken (Fable renew-key ruling, supplement "interactive mode A1", second point):
  # accepted, and written as it ended (Codex review of 1cedea9ef, medium 4) -- the host guard's, and the boot watchdog's record.
  $guardOutcome = Get-DrillGuardOutcome $runDir
  if ($guardOutcome) { $evidence.guardEmergencyRestore = $guardOutcome }
  $watchdogFile = Join-Path $runDir 'guest-shutdown.outcome.json'
  if (Test-Path -LiteralPath $watchdogFile -PathType Leaf) { $evidence.watchdogRestore = try { Read-DrillJson $watchdogFile } catch { [ordered]@{ unreadable = $true } } }
  $files = @(Get-ChildItem -LiteralPath $runDir -File | Where-Object { $_.Name -ne 'receipt.json' } | ForEach-Object { [ordered]@{ name = $_.Name; sha256 = (Get-Sha256Hex $_.FullName) } })
  try {
    if ($run) { $m5 = Get-DrillM5Verdict $runDir $run.m5 }
    $m5Dir = Join-Path $runDir 'm5'
    if (Test-Path -LiteralPath $m5Dir -PathType Container) {
      $files += @(Get-ChildItem -LiteralPath $m5Dir -File | ForEach-Object { [ordered]@{ name = "m5/$($_.Name)"; sha256 = (Get-Sha256Hex $_.FullName) } })
    }
  } catch {
    $m5.result = 'FAIL'
    $m5.detail = 'DRILL_M5_EVIDENCE_UNREADABLE'
  }
  $receipt = [ordered]@{
    contract = $script:Drill.ReceiptContract
    machine = 'Hyper-V VM on DESK (drill machine, not a node; phase A)'
    entryMode = $(if ($Interactive) { 'interactive-original-bootstrap' } else { 'adapted-unattended' })
    bootstrapException = $(if ($Interactive) { $null } else { 'README section 5: drill VM only exception to do not bypass bootstrap to run prepare; non-elevated check, RunAs and credential dialogs bypassed' })
    version = $package.version; tarSha256 = $package.tarSha256; ciSourceManifestSha256 = $package.ciSourceManifestSha256
    # the three hashes an acceptance names; candidate: the drill ran before the Owner's acceptance, on the kit's drill-only acceptance
    firstInstallKitSha256 = $package['firstInstallKitSha256']; candidate = [bool]$package['candidate']
    kitSha256 = $kitInfo.sha256; prereqSha256 = $prereq.sha256; baseline = [ordered]@{ checkpoint = $script:Drill.Checkpoint; build = $baseline }
    startedAt = $startedAt; endedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); hostFreeGBAtStart = $mem.freeGB
    failure = $failure; restoredToCheckpoint = $restored
    evidence = $evidence; files = $files; items = $items; m5 = $m5
    conclusion = $(if ($failure -or -not $restored) { 'FAIL' } else { Get-DrillConclusion $items $m5 ([bool]$package['candidate']) })
    productionReadbackSql = (Get-DrillReadbackSql $startedAt)
  }
  $receiptPath = Join-Path $runDir 'receipt.json'
  Write-DrillJson $receiptPath $receipt
  return [ordered]@{ status = 'DRILL_DONE'; conclusion = $receipt.conclusion; code = $(if ($failure) { $failure.code } else { $null }); restored = $restored; receipt = $receiptPath }
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by the offline tests: definitions only
# The one output line is UTF-8 whatever the console code page (a Chinese Windows defaults to GBK, which garbled the guest's
# localized messages in the first baseline run's detail).
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$WarningPreference = 'SilentlyContinue'   # one JSON line on stdout: warnings relayed from the guest would break it
try {
  $result = Invoke-DrillMain
  Write-Output (ConvertTo-DrillJson $result)
  exit 0
} catch {
  $c = Get-DrillCode $_
  Write-Output (ConvertTo-DrillJson ([ordered]@{ status = 'DRILL_STOPPED'; code = $c.code; detail = $c.detail }))
  exit 1
}
