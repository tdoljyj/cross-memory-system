# drill-vm.ps1 -- the new-node first-install drill machine: one Hyper-V VM on this host (plan PLAN-drill-vm-20261116, phase A).
#
#   pwsh -NoProfile -File drill-vm.ps1 -BaselineOnly
#   pwsh -NoProfile -File drill-vm.ps1 -PrereqOnly      (baseline copy + the pinned prerequisites from D:\clued-drill\prereq, then restored)
#   pwsh -NoProfile -File drill-vm.ps1 -Version <v> -From <dir with tar/acceptance/SHA256SUMS> -Kit <first-install kit dir> [-SkipReinstall] [-RunTimeoutMinutes 70]
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
    [Math]::Max($target, $MemoryAssigned)
  }
  $required = $vmFreeRequired + $script:Drill.ProductionReserveBytes
  return @{ ok = ($FreeBytes -ge $required); code = $(if ($FreeBytes -lt $required) { 'DRILL_HOST_MEMORY_SHORT' } else { $null });
    freeGB = [Math]::Round($FreeBytes / 1GB, 1); requiredFreeBytes = $required }
}

function ConvertTo-DrillTimestamp($Value) {
  # ConvertFrom-Json can supply a DateTime in PowerShell 7.
  if ($Value -is [DateTime]) { return [DateTimeOffset]$Value }
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
# Any current batch (including WAITING/PARKED) still owns resources, even when executor.state is not RUNNING.
function Test-DrillHostSafety([string]$StatusJson, [long]$FreeBytes, [switch]$Running, [long]$VmMemoryBytes = $script:Drill.MemoryBytes,
  [long]$MemoryAssigned = 0, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
  [DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  $memory = Test-DrillHostMemory $FreeBytes $VmMemoryBytes -Running:$Running -MemoryAssigned $MemoryAssigned
  $code = 'DRILL_HOST_STATUS_UNREADABLE'
  $mode = $null; $since = $null; $until = $null
  try {
    $s = ConvertFrom-Json -InputObject $StatusJson -ErrorAction Stop
    $reportedMode = $s.node.mode; $executor = $s.executor.state
    if ($reportedMode -is [string] -and $reportedMode -cin @('ACTIVE', 'STANDBY') -and
        $null -ne $s.PSObject.Properties['current'] -and $executor -is [string]) {
      $code = 'DRILL_HOST_STATUS_STALE'
      if (Test-DrillHostStatusFresh (Get-Prop $s 'writtenAt') $Now) {
        $mode = $reportedMode
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
        if ($executor -cin @('RUNNING', 'PARKED') -or $null -ne $s.current) { $code = 'DRILL_HOST_CI_BUSY' }
        elseif ($executor -cnotin @('IDLE', 'WAITING', 'DEFERRED', 'HALTED', 'PAUSED', 'BACKFILL_PENDING', 'STOPPED',
          'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED')) { $code = 'DRILL_HOST_STATUS_UNREADABLE' }
        elseif ($mode -ceq 'ACTIVE' -and ($HoldUntil -le $Now -or $null -eq $since -or $since -gt $Now -or
          $null -eq $until -or $until -lt $HoldUntil -or $until -gt $Now.AddMinutes($script:Drill.IntakeMaxMinutes))) {
          $code = 'DRILL_HOST_IS_ON_DUTY'
        } else { $code = $memory.code }
      }
    }
  } catch { $code = 'DRILL_HOST_STATUS_UNREADABLE' }
  return @{ ok = ($null -eq $code); code = $code; mode = $mode; holdSince = $since; holdUntil = $until;
    freeGB = $memory.freeGB; requiredFreeBytes = $memory.requiredFreeBytes;
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
function Test-DrillPackageDir([string]$Dir, [string]$Version) {
  if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.\-]{0,63}$') { throw (New-DrillError 'DRILL_VERSION_REFUSED') }
  $tag = "fleet-node-$Version"
  $tar = Join-Path $Dir "$tag.tar"; $acc = Join-Path $Dir "$tag.acceptance.json"; $sums = Join-Path $Dir 'SHA256SUMS'
  foreach ($f in @($tar, $acc, $sums)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw (New-DrillError 'DRILL_PACKAGE_FILE_MISSING' ([IO.Path]::GetFileName($f))) } }
  $sha = Get-Sha256Hex $tar
  $acceptance = Read-DrillJson $acc
  if ([string](Get-Prop $acceptance 'contract') -cne 'clued.independent-ci.fleet-node-acceptance/1' -or [string](Get-Prop $acceptance 'version') -cne $Version) { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED') }
  if ([string](Get-Prop $acceptance 'archive_sha256') -cne $sha) { throw (New-DrillError 'DRILL_TAR_NOT_THE_ACCEPTED_ONE' @{ actual = $sha }) }
  $line = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match "^[0-9a-f]{64}\s+\*?$([regex]::Escape("$tag.tar"))$" })
  if ($line.Count -ne 1 -or $line[0].Substring(0, 64) -cne $sha) { throw (New-DrillError 'DRILL_TAR_NOT_IN_SHA256SUMS') }
  $source = [string](Get-Prop $acceptance 'ciSourceManifestSha256')
  if ($source -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED' 'ciSourceManifestSha256') }
  return [ordered]@{ version = $Version; tar = $tar; acceptance = $acc; sums = $sums; tarSha256 = $sha; ciSourceManifestSha256 = $source }
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
  return [ordered]@{ dir = $Dir; sha256 = (Get-Sha256Hex $file); entryFile = $entryFile; arguments = @($kitArgs | ForEach-Object { [string]$_ }); timeoutMinutes = [int]$timeout; perNodeSteps = $perNode; prereqSha256 = $prereqSha; prerequisiteMode = $mode; executionBlocker = $blocker }
}

# A generated kit binds the complete Release directory, not just the old package triple.
# Validate before touching Hyper-V; entry validates these pins again after PowerShell Direct copy.
function Get-DrillReleaseFiles($Package, $KitInfo) {
  if ($KitInfo.prerequisiteMode -cne 'first-install-host') { return @($Package.tar, $Package.acceptance, $Package.sums) }
  $pins = Read-DrillJson (Join-Path $KitInfo.dir 'release-pins.json')
  if ([string](Get-Prop $pins 'version') -cne $Package.version) { throw (New-DrillError 'DRILL_RELEASE_VERSION_MISMATCH') }
  $root = Split-Path -Parent $Package.tar; $seen = @{}; $files = @()
  foreach ($f in @(Get-Prop $pins 'files')) {
    $name = [string](Get-Prop $f 'path'); $hash = [string](Get-Prop $f 'sha256')
    if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$' -or $hash -cnotmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($name)) { throw (New-DrillError 'DRILL_RELEASE_PINS_REFUSED') }
    $seen[$name] = $true; $file = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Sha256Hex $file) -cne $hash) { throw (New-DrillError 'DRILL_RELEASE_ASSET_CHANGED' $name) }
    $files += $file
  }
  foreach ($file in @($Package.tar, $Package.acceptance, $Package.sums)) {
    if (-not $seen.ContainsKey([IO.Path]::GetFileName($file))) { throw (New-DrillError 'DRILL_RELEASE_PINS_REFUSED') }
  }
  if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne $files.Count) { throw (New-DrillError 'DRILL_RELEASE_UNLISTED_ASSET') }
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
  param($Dir, $Wsl, $Rootfs, $Distro, $WslVersion)
  $ErrorActionPreference = 'Stop'
  $wslExe = "$env:SystemRoot\System32\wsl.exe"
  $p = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @('/i', (Join-Path $Dir $Wsl), '/qn', '/norestart') -Wait -PassThru
  if ($p.ExitCode -notin @(0, 3010)) { throw "PREREQ_WSL_MSI_EXIT_$($p.ExitCode)" }
  $ver = ((& $wslExe --version) -join ' ') -replace [char]0, ''
  if ($WslVersion -and $ver -notmatch [regex]::Escape($WslVersion)) { throw "PREREQ_WSL_VERSION_NOT_PINNED" }
  & $wslExe --install --from-file (Join-Path $Dir $Rootfs) --name $Distro --no-launch | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "PREREQ_DISTRO_INSTALL_EXIT_$LASTEXITCODE" }
  # --exec: the arguments go to env as they are (with `--` WSL runs the command line through root's shell, which split the
  # bash -c text at its | and ; - 2026-11-16 13:07). Continue: in Windows PowerShell a native stderr line under 2>&1 would
  # otherwise become a terminating error; the output is judged as data.
  $root = { param([string]$cmd) $ErrorActionPreference = 'Continue'; $o = @(& $wslExe -d $Distro -u root --exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C DEBIAN_FRONTEND=noninteractive /bin/bash -c $cmd 2>&1 | ForEach-Object { ([string]$_) -replace [char]0, '' }); [ordered]@{ exit = $LASTEXITCODE; out = $o } }
  $debDir = '/mnt/' + $Dir.Substring(0, 1).ToLowerInvariant() + ($Dir.Substring(2) -replace '\\', '/') + '/debs'
  $dpkg = & $root "dpkg -i --force-confold $debDir/*.deb 2>&1 | tail -n 25; echo DPKG_EXIT=`${PIPESTATUS[0]}; echo AUDIT=`$(dpkg --audit | wc -l)"
  $dpkgExit = @($dpkg.out | Where-Object { $_ -match '^DPKG_EXIT=(\d+)$' } | ForEach-Object { [int]$Matches[1] }) | Select-Object -Last 1
  $audit = @($dpkg.out | Where-Object { $_ -match '^AUDIT=(\d+)$' } | ForEach-Object { [int]$Matches[1] }) | Select-Object -Last 1
  $facts = & $root "for i in `$(seq 1 30); do systemctl is-active --quiet docker.service && break; sleep 2; done; grep ^PRETTY_NAME /usr/lib/os-release; ps -p 1 -o comm=; systemctl is-active docker.service; dpkg-query -W -f='`${Package} `${Version}\n' docker.io containerd runc"
  [ordered]@{ wslVersion = $ver; distribution = $Distro; dpkgExit = $dpkgExit; dpkgAuditLines = $audit; dpkgTail = @($dpkg.out); facts = $facts.out
    dockerActive = (@($facts.out) -contains 'active'); systemdPid1 = (@($facts.out) -contains 'systemd') }
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
  return @{ entry = (ConvertFrom-DrillInteractiveEvidence $observed); credential = $Cred }
}

function New-DrillItem([string]$Id, $Pass, [string]$Detail) { [ordered]@{ id = $Id; pass = $Pass; detail = $Detail } }

function Test-DrillReinstallLauncher($Reinstall) {
  $exitCode = Get-Prop $Reinstall 'launcherExit'
  return ($exitCode -is [int]) -and ($exitCode -eq 0) -and ((Get-Prop $Reinstall 'launcherVerdict') -ceq 'BOOTSTRAP_DONE')
}

# The phase-A verdict (plan section 3) from what the drill read in the guest. pass: $true, $false, or $null (not judged here:
# A5's production half and A9 are judged by -Finalize from the production read-back).
#   $E: entry (Read-DrillEntryResult), verify (@{status}), status (status.json), current (upgrade\current.json),
#       facts (version-facts.json), acceptanceSource, now (DateTimeOffset), reboot (@{ok, status}), reinstall (@{skipped, ...}), kit
function Get-DrillVerdict($E) {
  $items = New-Object System.Collections.ArrayList
  $now = [DateTimeOffset]$E.now
  $entry = $E.entry
  $a1 = ($null -ne $entry) -and $entry.parsed -and $entry.exitCode -eq 0 -and $null -eq $entry.stopCode -and $entry.status -ceq 'FIRST_INSTALL_DONE'
  [void]$items.Add((New-DrillItem 'A1' $a1 $(if ($null -eq $entry) { 'no entry result' } else { "exit=$($entry.exitCode) status=$($entry.status) stopCode=$($entry.stopCode)" })))
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
  [void]$items.Add((New-DrillItem 'A5' $(if ($a5) { $null } else { $false }) "local=$local acceptance=$($E.acceptanceSource); production half by -Finalize"))
  $s = $E.status
  $a6 = ([string](Get-Prop $s 'node.mode') -ceq 'UNCERTAIN') -and ([string](Get-Prop $s 'executor.state') -ceq 'IDLE') -and ((Get-Prop $s 'queue.live') -eq 0) -and ($null -eq (Get-Prop $s 'halt'))
  [void]$items.Add((New-DrillItem 'A6' $a6 "mode=$(Get-Prop $s 'node.mode') executor=$(Get-Prop $s 'executor.state') live=$(Get-Prop $s 'queue.live') halt=$(Get-Prop $s 'halt.code')"))
  $r = $E.reboot
  if ($null -eq $r) { [void]$items.Add((New-DrillItem 'A7' $false 'not run')) }
  else { $sc = Test-DrillSelfcheck 'A7' $r.status ([DateTimeOffset]$r.readAt); [void]$items.Add((New-DrillItem 'A7' ([bool]$r.ok -and $sc.pass) "refreshedAfterBoot=$($r.ok) $($sc.detail)")) }
  $ri = $E.reinstall
  if ($null -eq $ri -or $ri.skipped) { [void]$items.Add((New-DrillItem 'A8' $null 'skipped (-SkipReinstall)')) }
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

function Test-DrillSelfcheck([string]$Id, $Status, [DateTimeOffset]$Now) {
  $sc = Get-Prop $Status 'versions.selfcheck'
  $result = [string](Get-Prop $sc 'result'); $at = [string](Get-Prop $sc 'observedAt')
  $fresh = $false
  if ($at) { try { $age = $Now - [DateTimeOffset]::Parse($at, [Globalization.CultureInfo]::InvariantCulture); $fresh = $age.TotalMinutes -le $script:Drill.SelfcheckFreshMinutes -and $age.TotalSeconds -ge -30 } catch { $fresh = $false } }
  return (New-DrillItem $Id (($result -ceq 'PASS') -and $fresh) "selfcheck=$result observedAt=$at")
}

# Overall: FAIL if any required item is missing or a core item failed; PASS_A when A1-A9 hold; otherwise PENDING.
function Get-DrillConclusion($Items) {
  $byId = @{}; foreach ($i in $Items) { $byId[$i.id] = $i }
  $core = @('A1','A2','A3','A4','A5','A6','A7','A8','A9')
  foreach ($id in ($core + 'A10')) {
    if (-not $byId.ContainsKey($id)) { return 'FAIL' }
  }
  if (@($core | Where-Object { $byId[$_].pass -eq $false }).Count) { return 'FAIL' }
  if (@($core | Where-Object { $null -eq $byId[$_].pass -and $byId[$_].detail -notmatch '^skipped' }).Count) { return 'PENDING_PRODUCTION_READBACK' }
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

function Get-DrillHostSafety([switch]$Running, [DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  $json = Read-DrillHostStatus
  $duty = Test-DrillHostSafety $json ([long]::MaxValue) -Running:$Running -Now (Get-DrillTime) -HoldUntil $HoldUntil
  if (-not $duty.ok) { return $duty }
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
    return Test-DrillHostSafety $json $free -VmMemoryBytes $target -MemoryAssigned $assigned -Running:$Running -Now (Get-DrillTime) -HoldUntil $HoldUntil
  } catch {
    $c = Get-DrillCode $_
    return @{ ok = $false; code = $(if ($c.code -eq 'DRILL_VM_NAME_TAKEN_NOT_OURS') { $c.code } else { 'DRILL_HOST_RESOURCE_UNREADABLE' }); action = $(if ($Running) { 'abort' } else { 'refuse' }) }
  }
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

function Request-DrillIntake($Tool, [ValidateSet('pause', 'resume')][string]$Verb, [int]$Minutes = 0) {
  $argsForTool = @($Tool.tool, "request-intake-$Verb", '--root', $Tool.root, '--holder', $script:Drill.IntakeHolder, '--reason', 'first-install drill')
  $expected = 'INTAKE_RESUME_REQUESTED'
  if ($Verb -ceq 'pause') {
    $argsForTool += @('--minutes', [string]$Minutes)
    $expected = 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES'
  }
  try {
    $run = Invoke-DrillNode $Tool.node $argsForTool 15
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
    if ($initial.mode -ceq 'ACTIVE' -and -not $StandbyOnly) {
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
        $safety = Get-DrillHostSafety -HoldUntil $holdUntil
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
          abortedAt = [DateTimeOffset]::UtcNow.ToString('o'); restoredToCheckpoint = $false; stopped = $false; cleanupFailure = $null }
        # Persist the reason before cleanup, then its outcome. A receipt write failure must never prevent shutdown.
        try { Write-DrillJson (Join-Path $RunDir 'host-guard.json') $receipt } catch { }
        try {
          $receipt.stopped = Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint
          $receipt.restoredToCheckpoint = $RestoreCheckpoint -and $receipt.stopped
        } catch { $receipt.cleanupFailure = Get-DrillCode $_ }
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

function Start-DrillGuardedVm([string]$BootSignal) {
  if (-not $script:HostGuard) { throw (New-DrillError 'DRILL_HOST_GUARD_FAILED') }
  $state = $script:HostGuard.state
  [Threading.Monitor]::Enter($state.SyncRoot)
  try {
    Assert-DrillGuard
    $safety = Get-DrillGuardSafety $state
    if (-not $safety.ok) { throw (New-DrillError $safety.code $safety) }
    if ($BootSignal) { [IO.File]::WriteAllText($BootSignal, 'starting') }
    Start-VM -Name $script:Drill.VmName -ErrorAction Stop
    $state.armed = $true
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
  param($Root)
  $ErrorActionPreference = 'Stop'
  $read = { param($p) if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
  $status = & $read (Join-Path $Root 'state\status.json')
  $current = & $read (Join-Path $Root 'upgrade\current.json')
  $factsFile = Join-Path $Root 'upgrade\mailbox\responses\version-facts.json'
  $facts = & $read $factsFile
  $verify = [ordered]@{ status = 'NOT_RUN'; exit = $null; tail = @() }
  $receipt = Join-Path $Root 'install\install-receipt.json'
  if ($current -and (Test-Path -LiteralPath $receipt)) {
    $script = Join-Path $Root ("resident\" + $current.residentManifestSha256 + "\windows\verify-resident.ps1")
    $rs = (Get-FileHash -LiteralPath $receipt -Algorithm SHA256).Hash.ToLowerInvariant()
    $out = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -ExpectedInstallReceiptSha256 $rs -LinuxVersionFactsFile $factsFile 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    $verdict = @($out | Where-Object { $_ -match 'RESIDENT_VERIF' }) | Select-Object -Last 1
    $verify = [ordered]@{ status = $(if ($verdict -match '(RESIDENT_[A-Z_]+)') { $Matches[1] } else { 'UNPARSED' }); exit = $code; tail = @($out | Select-Object -Last 40) }
  }
  [ordered]@{ status = $status; current = $current; facts = $facts; verify = $verify; readAt = [DateTimeOffset]::UtcNow.ToString('o') }
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
  try { $facts = Invoke-DrillGuest $Cred $script:GuestPrereq -ArgumentList @($dest, $Prereq.wsl, $Prereq.rootfs, $Prereq.distribution, $Prereq.wslVersion) -TimeoutMinutes $script:Drill.PrereqTimeoutMinutes -Code 'DRILL_PREREQ_TIMEOUT' -Step 'prereq' }
  catch { $c = Get-DrillCode $_; if ($c.code -ne 'DRILL_GUEST_STEP_FAILED') { throw }; throw (New-DrillError 'DRILL_PREREQ_FAILED' $c.detail) }
  Write-DrillJson (Join-Path $RunDir 'prereq-facts.json') $facts
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
            if (Stop-DrillOwnedVm -RestoreCheckpoint) { return }
          }
        } catch { }
        Start-Sleep -Milliseconds 500
      }
    }
    # A final cleanup at the boundary also covers a foreground stuck before timer registration.
    if (-not (Test-Path -LiteralPath "$Signal.armed")) {
      $info = Get-DrillVmInfo
      if ($info -and $info.vm.Id -eq $VmId -and $info.notes -ceq $script:Drill.Marker) {
        [void](Stop-DrillOwnedVm -RestoreCheckpoint)
      }
    }
  } finally {
    if ($parent) { $parent.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

function Start-DrillBootWatchdog([string]$RunDir, [guid]$VmId, [DateTimeOffset]$Deadline) {
  $signal = Join-Path $RunDir 'guest-shutdown'
  $parentStarted = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
  $file = $script:DrillScriptPath.Replace("'", "''")
  $escapedSignal = $signal.Replace("'", "''")
  $command = ". '$file'; Invoke-DrillBootWatchdog '$escapedSignal' $PID $parentStarted '$VmId' '$($Deadline.ToString('o'))'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $worker = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
  try {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not $worker.HasExited -and $clock.Elapsed.TotalSeconds -lt 15) {
      if (Test-Path -LiteralPath "$signal.ready") { return $signal }
      Start-Sleep -Milliseconds 100
    }
    throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY')
  } finally { $worker.Dispose() }
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
# and restored, whatever happened. Returns @{ result; failure; restored }.
function Invoke-DrillOnCheckpoint([scriptblock]$Body, [string]$RunDir, $Window) {
  $result = $null; $failure = $null; $restored = $false; $guard = $null; $cleanupNeeded = $false; $signal = $null
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
    $signal = Start-DrillBootWatchdog $RunDir $info.vm.Id $Window.deadline
    Start-DrillGuardedVm "$signal.starting"
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
    Stop-DrillHostGuard $guard
    if ($guard -and $guard.state.failure) { $failure = $guard.state.failure; $result = $null }
  }
  return @{ result = $result; failure = $failure; restored = $restored }
}

$script:GuestReinstall = {
  param($Node, $Tree, $From, $Work, $Version, $TarName, $AccName, $TarSha)
  $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
  $last = { param($lines) $l = @($lines | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1; if ($l) { try { $l | ConvertFrom-Json } catch { $null } } }
  $up = @(& $Node (Join-Path $fleet 'upgrade.mjs') fetch --version $Version --work (Join-Path $Work 'a8-upgrade') --from $From --no-request 2>&1 | ForEach-Object { [string]$_ })
  $p1 = @(& $Node (Join-Path $fleet 'install.mjs') prepare --artifact (Join-Path $From $TarName) --artifact-sha $TarSha --acceptance (Join-Path $From $AccName) --work (Join-Path $Work 'a8-prepare') 2>&1 | ForEach-Object { [string]$_ })
  $upj = & $last $up; $p1j = & $last $p1
  $reinstall = [ordered]@{ skipped = $false;
    upgradeStatus = $(if ($upj -and $upj.PSObject.Properties['status']) { [string]$upj.status });
    prepareStatus = $(if ($p1j -and $p1j.PSObject.Properties['status']) { [string]$p1j.status });
    launcherVerdict = 'NOT_RUN_MISSING_RUN_COMMAND'; launcherStatus = $null; launcherExit = $null; launcherTail = @(); launcherStderr = $null;
    upgradeTail = @($up | Select-Object -Last 5); prepareTail = @($p1 | Select-Object -Last 5);
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
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $file = Get-Item -LiteralPath $Path
    if ($file.Length -gt 8192 -or $file.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -le 8192) { [Convert]::ToBase64String($bytes) }
  }
  $public = @{}
  foreach ($name in $files.Keys) {
    if ($files[$name]) { $public[$name] = & $readSmall $files[$name] }
  }
  $acceptance = Join-Path $Root 'record\acceptance.json'
  if (Test-Path -LiteralPath $acceptance -PathType Leaf) {
    $node = (Get-Content -LiteralPath $acceptance -Raw -Encoding UTF8 | ConvertFrom-Json).node
    if ($node -and $node.controllerSid -cmatch '^S-1-5-21-(\d+-){3}\d+$' -and $node.ownerSid -cmatch '^S-1-5-21-(\d+-){3}\d+$') {
      $profile = @{ controllerSid = $node.controllerSid; ownerSid = $node.ownerSid } | ConvertTo-Json -Compress
      $public['profile.json'] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($profile))
    }
  }
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
  return $public
}

function Copy-DrillM5([string]$RunDir, [pscredential]$Cred) {
  $dir = Join-Path $RunDir 'm5'
  New-Item -ItemType Directory -Path $dir | Out-Null
  $names = @('profile.json', 'system.json', 'resident.json', 'controller.json', 'companion.json', 'probe.json')
  $missing = @(); $code = $null
  try { $files = Invoke-DrillGuest $Cred $script:GuestM5Files -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 2 -Step 'm5-observations' }
  catch { $files = $null; $code = (Get-DrillCode $_).code }
  foreach ($name in $names) {
    $data = Get-Prop $files $name
    if (-not $data) { $missing += $name; continue }
    [IO.File]::WriteAllBytes((Join-Path $dir $name), [Convert]::FromBase64String($data))
  }
  return @{ directory = 'm5'; missing = $missing; collectionCode = $code }
}

function Get-DrillM5Verdict([string]$RunDir, $M5) {
  $resident = Split-Path -Parent (Split-Path -Parent $script:DrillScriptPath)
  $checker = Join-Path $resident 'test\renewal-drill.mjs'
  if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
    $M5.result = 'NOT_EVALUATED'
    $M5.detail = 'M5 未评估（renewal-drill 未随包）'
    return $M5
  }
  $M5.result = 'FAIL'
  try {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $run = Invoke-DrillNode $node @($checker, (Join-Path $RunDir $M5.directory)) 30
    $M5.verdict = ConvertFrom-Json -InputObject $run.stdout
    $M5.exit = $run.exit
    if ($run.exit -eq 0 -and (Get-Prop $M5.verdict 'result') -ceq 'PASS' -and $M5.missing.Count -eq 0 -and -not $M5.collectionCode) {
      $M5.result = 'PASS'
    }
  } catch { $M5.detail = 'DRILL_M5_CHECKER_FAILED' }
  return $M5
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

  $timings = $null
  if ($Interactive) {
    $interactiveRun = Wait-DrillInteractive $RunDir $paths $Cred
    $entry = $interactiveRun.entry; $Cred = $interactiveRun.credential
  } else {
  # A1: the kit entry, once, bounded. No retry.
  $entryArgs = Resolve-DrillKitArguments $KitInfo.arguments $paths
  $entryOut = Invoke-DrillGuest $Cred {
    param($Entry, $EntryArgs)
    $out = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Entry @EntryArgs 2>&1 | ForEach-Object { [string]$_ })
    [ordered]@{ lines = $out; exit = $LASTEXITCODE }
  } -ArgumentList @((Join-Path $paths.kit $KitInfo.entryFile), $entryArgs) -TimeoutMinutes $KitInfo.timeoutMinutes -Code 'DRILL_FIRST_INSTALL_TIMEOUT' -Step 'first-install'
  [IO.File]::WriteAllLines((Join-Path $RunDir 'first-install.log'), [string[]]@($entryOut.lines))
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
  }

  $first = Invoke-DrillGuest $Cred $script:GuestRead -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 15 -Step 'read-after-install' -Restartable
  Write-DrillJson (Join-Path $RunDir 'read-after-install.json') $first

  # A7: reboot, nobody logs in; within 10 minutes the status is rewritten after the boot and the self-check still passes.
  $beforeReboot = [DateTimeOffset]::UtcNow
  try { Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { Restart-Computer -Force } -ErrorAction Stop } catch { }
  $boot = Wait-DrillGuest $Cred 15 $beforeReboot
  $deadline = $boot.AddMinutes($script:Drill.UnattendedRebootMinutes); $reboot = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $r = Invoke-DrillGuest $Cred {
      param($Root) $p = Join-Path $Root 'state\status.json'
      $s = if (Test-Path $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
      [ordered]@{ status = $s; readAt = [DateTimeOffset]::UtcNow.ToString('o') }
    } -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 2 -Step 'read-status' -Restartable
    $written = Get-Prop $r.status 'writtenAt'
    $ok = $false; if ($written) { try { $ok = [DateTimeOffset]::Parse([string]$written) -gt $boot } catch { $ok = $false } }
    $reboot = @{ ok = $ok; status = $r.status; readAt = $r.readAt }
    if ($ok -and [string](Get-Prop $r.status 'versions.selfcheck.result') -ceq 'PASS') { break }
    Start-Sleep -Seconds 30
  }
  Write-DrillJson (Join-Path $RunDir 'read-after-reboot.json') $reboot

  # A8: same package again: the generic upgrade answers "already at this package"; prepare -> launcher -> verify -> prepare.
  $reinstall = @{ skipped = $true }
  if (-not $SkipReinstall -and $entry.tree -and $entry.node) {
    $reinstall = Invoke-DrillGuest $Cred $script:GuestReinstall -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, $Package.version, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256) -TimeoutMinutes 180 -Code 'DRILL_REINSTALL_TIMEOUT' -Step 'reinstall'
    Write-DrillJson (Join-Path $RunDir 'reinstall.json') $reinstall
  } elseif (-not $SkipReinstall) { $reinstall = @{ skipped = $false; upgradeStatus = 'NOT_RUN_ENTRY_GAVE_NO_TREE_OR_NODE'; prepareStatus = $null; reverifyPassed = $false; prepareAgainStatus = $null } }

  if (Test-DrillReinstallLauncher $reinstall) {
    $again = Invoke-DrillGuest $Cred $script:GuestRead -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 15 -Step 'read-after-reinstall' -Restartable
    Write-DrillJson (Join-Path $RunDir 'read-after-reinstall.json') $again
    $reVerdict = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($again.readAt); entry = $entry; verify = $again.verify; status = $again.status; current = $again.current; facts = $again.facts; acceptanceSource = $Package.ciSourceManifestSha256; reboot = $null; reinstall = $null; kit = $KitInfo }
    $reinstall.reverifyPassed = @($reVerdict | Where-Object { $_.id -in @('A2', 'A3', 'A4') -and $_.pass -ne $true }).Count -eq 0 -and $null -eq (@($reVerdict | Where-Object { $_.id -eq 'A5' })[0].pass)
    $p2 = Invoke-DrillGuest $Cred {
      param($Node, $Tree, $From, $Work, $TarName, $AccName, $TarSha)
      $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
      $o = @(& $Node (Join-Path $fleet 'install.mjs') prepare --artifact (Join-Path $From $TarName) --artifact-sha $TarSha --acceptance (Join-Path $From $AccName) --work (Join-Path $Work 'a8-prepare-again') 2>&1 | ForEach-Object { [string]$_ })
      $l = @($o | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1; if ($l) { [string]($l | ConvertFrom-Json).status } else { 'UNPARSED' }
    } -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256) -TimeoutMinutes 60 -Step 'prepare-again'
    $reinstall.prepareAgainStatus = [string]$p2
    Write-DrillJson (Join-Path $RunDir 'reinstall.json') $reinstall
  }

  $m5 = Copy-DrillM5 $RunDir $Cred
  return @{ entry = $entry; first = $first; reboot = $reboot; reinstall = $reinstall; fake = $fake; prereq = $prereqFacts; timings = $timings; m5 = $m5 }
}

# ---------------------------------------------------------------- main
function Invoke-DrillMain {
  if ($Interactive -and ($BaselineOnly -or $PrereqOnly -or $Finalize)) { throw (New-DrillError 'DRILL_USAGE' '-Interactive is a full first-install run only') }
  if ($Finalize) {
    if (-not $ProductionReadback) { throw (New-DrillError 'DRILL_USAGE' '-Finalize needs -ProductionReadback') }
    $receipt = Read-DrillJson $Finalize
    if ([string](Get-Prop $receipt 'contract') -cne $script:Drill.ReceiptContract) { throw (New-DrillError 'DRILL_RECEIPT_REFUSED') }
    $restored = Get-Prop $receipt 'restoredToCheckpoint'
    if ((Get-Prop $receipt 'failure') -or $restored -isnot [bool] -or -not $restored -or (Get-Prop $receipt 'conclusion') -ceq 'FAIL') {
      throw (New-DrillError 'DRILL_RECEIPT_NOT_FINALIZABLE' 'receipt failed or checkpoint restore was not confirmed')
    }
    $prod = Get-DrillProductionVerdict $receipt (Read-DrillJson $ProductionReadback)
    $items = @($receipt.items | ForEach-Object { $i = $_; $p = @($prod | Where-Object { $_.id -eq $i.id }); if ($p.Count) { $p[0] } else { [ordered]@{ id = $i.id; pass = $i.pass; detail = $i.detail } } })
    $receipt.items = $items
    $receipt.conclusion = Get-DrillConclusion $items
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
    $package = Test-DrillPackageDir $From $Version; $kitInfo = Read-DrillKit $Kit
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
      detail = $(if ($o.failure) { $o.failure.detail } else { $null }); restored = $o.restored; prereqSha256 = $prereq.sha256; evidence = (Join-Path $runDir 'prereq-facts.json') }
    Write-DrillJson (Join-Path $runDir 'prereq-run.json') $out
    return $out
  }

  $startedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillRun $runDir $package $kitInfo $prereq $cred } $runDir $Window
  $run = $o.result; $failure = $o.failure; $restored = $o.restored

  $evidence = [ordered]@{ localSource = $null }
  $items = @()
  $m5 = $null
  if ($run) {
    $evidence.localSource = [string](Get-Prop $run.first.current 'ciSourceManifestSha256')
    $evidence.stageTimingsSeconds = $run.timings
    $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = $run.reinstall; kit = $kitInfo }
    $m5 = Get-DrillM5Verdict $runDir $run.m5
  }
  $files = @(Get-ChildItem -LiteralPath $runDir -File | Where-Object { $_.Name -ne 'receipt.json' } | ForEach-Object { [ordered]@{ name = $_.Name; sha256 = (Get-Sha256Hex $_.FullName) } })
  $m5Dir = Join-Path $runDir 'm5'
  if (Test-Path -LiteralPath $m5Dir -PathType Container) {
    $files += @(Get-ChildItem -LiteralPath $m5Dir -File | ForEach-Object { [ordered]@{ name = "m5/$($_.Name)"; sha256 = (Get-Sha256Hex $_.FullName) } })
  }
  $receipt = [ordered]@{
    contract = $script:Drill.ReceiptContract
    machine = 'Hyper-V VM on DESK (drill machine, not a node; phase A)'
    entryMode = $(if ($Interactive) { 'interactive-original-bootstrap' } else { 'adapted-unattended' })
    bootstrapException = $(if ($Interactive) { $null } else { 'README section 5: drill VM only exception to do not bypass bootstrap to run prepare; non-elevated check, RunAs and credential dialogs bypassed' })
    version = $package.version; tarSha256 = $package.tarSha256; ciSourceManifestSha256 = $package.ciSourceManifestSha256
    kitSha256 = $kitInfo.sha256; prereqSha256 = $prereq.sha256; baseline = [ordered]@{ checkpoint = $script:Drill.Checkpoint; build = $baseline }
    startedAt = $startedAt; endedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); hostFreeGBAtStart = $mem.freeGB
    failure = $failure; restoredToCheckpoint = $restored
    evidence = $evidence; files = $files; items = $items; m5 = $m5
    conclusion = $(if ($failure -or -not $restored -or ($m5 -and $m5.result -ceq 'FAIL')) { 'FAIL' } else { Get-DrillConclusion $items })
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
