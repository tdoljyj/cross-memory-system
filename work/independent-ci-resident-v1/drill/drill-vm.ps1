# drill-vm.ps1 -- the new-node first-install drill machine: one Hyper-V VM on this host (plan PLAN-drill-vm-20261116, phase A).
#
#   pwsh -NoProfile -File drill-vm.ps1 -BaselineOnly
#   pwsh -NoProfile -File drill-vm.ps1 -PrereqOnly      (baseline copy + the pinned prerequisites from D:\clued-drill\prereq, then restored)
#   pwsh -NoProfile -File drill-vm.ps1 -Version <v> -From <dir with tar/acceptance/SHA256SUMS> -Kit <first-install kit dir> [-SkipReinstall]
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
# production roots, services, scheduled tasks, the host's WSL distributions, or any process by name. No elevation: the account
# must be in Hyper-V Administrators. Every wait is bounded; nothing is retried; a failed drill still restores the checkpoint.
# The VM is Off whenever this script is not running, and it starts only when the host has >= 14 GB free memory.
[CmdletBinding()]
param(
  [string]$Version,
  [string]$From,
  [string]$Kit,
  [switch]$BaselineOnly,
  [switch]$PrereqOnly,
  [switch]$SkipReinstall,
  [string]$Finalize,
  [string]$ProductionReadback
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

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
  ProProductKey = 'VK7JG-NPHTM-C97JM-9MPGT-3V66T'
  MemoryBytes = 8GB
  MinHostFreeBytes = 14GB
  MinDiskFreeBytes = 100GB
  VhdBytes = 80GB
  Cpu = 4; CpuMaximum = 75; CpuWeight = 50; MaxIops = 2000
  Switch = 'Default Switch'
  InstallTimeoutMinutes = 90
  # Nothing logs on to the guest before Windows says setup and OOBE are over: the first two real baselines (2026-11-16) logged
  # on through PowerShell Direct while OOBE was still finishing (the account exists from the middle of OOBE) and both ended on
  # OOBE's "Why did my PC restart?" screen. SetupComplete.cmd runs once OOBE is done, before any logon; it publishes one Hyper-V
  # KVP item that the host reads without logging on (Msvm_KvpExchangeComponent).
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

# The host memory gate: an 8 GB static VM never starts unless the host keeps >= 14 GB free. No retry.
function Test-DrillHostMemory([long]$FreeBytes) {
  if ($FreeBytes -lt $script:Drill.MinHostFreeBytes) { return @{ ok = $false; code = 'DRILL_HOST_MEMORY_SHORT'; freeGB = [Math]::Round($FreeBytes / 1GB, 1) } }
  return @{ ok = $true; code = $null; freeGB = [Math]::Round($FreeBytes / 1GB, 1) }
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
    if ($rel -notmatch '^[A-Za-z0-9._\-\\]+$' -or $rel -match '(^|\\)\.\.(\\|$)' -or $want -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "file $rel") }
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
  return [ordered]@{ dir = $Dir; sha256 = (Get-Sha256Hex $file); entryFile = $entryFile; arguments = @($kitArgs | ForEach-Object { [string]$_ }); timeoutMinutes = [int]$timeout; perNodeSteps = $perNode; prereqSha256 = $prereqSha }
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
# Returns facts only. Never downloads: apt is pointed at the local files and told not to fetch.
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
  $root = { param([string]$cmd) $o = @(& $wslExe -d $Distro -u root -- /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C DEBIAN_FRONTEND=noninteractive /bin/bash -c $cmd 2>&1 | ForEach-Object { ([string]$_) -replace [char]0, '' }); [ordered]@{ exit = $LASTEXITCODE; out = $o } }
  $debDir = '/mnt/' + $Dir.Substring(0, 1).ToLowerInvariant() + ($Dir.Substring(2) -replace '\\', '/') + '/debs'
  $apt = & $root "apt-get install -y --no-download --no-install-recommends -o Dpkg::Options::=--force-confold $debDir/*.deb"
  if ($apt.exit -ne 0) { throw ("PREREQ_APT_EXIT_$($apt.exit): " + (@($apt.out | Select-Object -Last 5) -join ' | ')) }
  $facts = & $root "for i in `$(seq 1 30); do systemctl is-active --quiet docker.service && break; sleep 2; done; grep ^PRETTY_NAME /usr/lib/os-release; ps -p 1 -o comm=; systemctl is-active docker.service; dpkg-query -W -f='`${Package} `${Version}\n' docker.io containerd runc"
  [ordered]@{ wslVersion = $ver; distribution = $Distro; aptTail = @($apt.out | Select-Object -Last 3); facts = $facts.out; dockerActive = (@($facts.out) -contains 'active'); systemdPid1 = (@($facts.out) -contains 'systemd') }
}

# The kit entry's arguments with the fixed guest paths in place.
function Resolve-DrillKitArguments([string[]]$Arguments, [hashtable]$Paths) {
  @($Arguments | ForEach-Object { $a = $_; if ($a -match '^\{(\w+)\}$') { [string]$Paths[$Matches[1]] } else { $a } })
}

# The kit entry's last stdout line: { status, stopCode, tree, node } (A1 reads stopCode; A8 needs tree and node).
function Read-DrillEntryResult([string[]]$Lines, [int]$ExitCode) {
  $last = @($Lines | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
  $doc = $null; if ($last) { try { $doc = $last | ConvertFrom-Json } catch { $doc = $null } }
  return [ordered]@{ exitCode = $ExitCode; status = [string](Get-Prop $doc 'status'); stopCode = (Get-Prop $doc 'stopCode'); tree = [string](Get-Prop $doc 'tree'); node = [string](Get-Prop $doc 'node'); parsed = ($null -ne $doc) }
}

function New-DrillItem([string]$Id, $Pass, [string]$Detail) { [ordered]@{ id = $Id; pass = $Pass; detail = $Detail } }

# The phase-A verdict (plan section 3) from what the drill read in the guest. pass: $true, $false, or $null (not judged here:
# A5's production half and A9 are judged by -Finalize from the production read-back).
#   $E: entry (Read-DrillEntryResult), verify (@{status}), status (status.json), current (upgrade\current.json),
#       facts (version-facts.json), acceptanceSource, now (DateTimeOffset), reboot (@{ok, status}), reinstall (@{skipped, ...}), kit
function Get-DrillVerdict($E) {
  $items = New-Object System.Collections.ArrayList
  $now = [DateTimeOffset]$E.now
  $entry = $E.entry
  $a1 = ($null -ne $entry) -and $entry.parsed -and $entry.exitCode -eq 0 -and $null -eq $entry.stopCode
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
      -and [bool]$ri.reverifyPassed -and ([string]$ri.prepareAgainStatus -ceq 'FLEET_NODE_INSTALL_PREPARED')
    [void]$items.Add((New-DrillItem 'A8' $a8 "upgrade=$($ri.upgradeStatus) prepare=$($ri.prepareStatus) reverify=$($ri.reverifyPassed) prepareAgain=$($ri.prepareAgainStatus)"))
  }
  [void]$items.Add((New-DrillItem 'A9' $null 'production read-back by -Finalize'))
  $steps = @($E.kit.perNodeSteps)
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

# Overall: FAIL if any item failed; PASS_A when A1-A9 hold (A10 may not); otherwise PENDING (items left to -Finalize).
function Get-DrillConclusion($Items) {
  $byId = @{}; foreach ($i in $Items) { $byId[$i.id] = $i }
  $core = @('A1','A2','A3','A4','A5','A6','A7','A8','A9')
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
  $pem = "-----BEGIN RSA PRIVATE KEY-----`n" + (($b64 -split '(.{64})' | Where-Object { $_ }) -join "`n") + "`n-----END RSA PRIVATE KEY-----`n"
  $ci = & $token; $up = & $token
  $enc = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText((Join-Path $OutDir 'ci-admission.token'), $ci, $enc)
  [IO.File]::WriteAllText((Join-Path $OutDir 'resident-upgrade.token'), $up, $enc)
  [IO.File]::WriteAllText((Join-Path $OutDir 'app-key.pem'), $pem, $enc)
  $public = [ordered]@{
    contract = 'clued.drill.fake-credentials/1'
    note = 'generated inside the drill VM; registered nowhere; the service refuses them'
    ciPrincipalBindingId = [guid]::NewGuid().ToString()
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

function Assert-DrillHost {
  $groups = [Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object { $_.Value }
  if (@($groups) -notcontains 'S-1-5-32-578') { throw (New-DrillError 'DRILL_NOT_IN_HYPERV_ADMINISTRATORS') }
  $free = [long](Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1KB
  $mem = Test-DrillHostMemory $free
  if (-not $mem.ok) { throw (New-DrillError $mem.code @{ freeGB = $mem.freeGB }) }
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

# Waits, logging on nowhere, until SetupComplete.cmd has published the setup signal (setup and OOBE are over).
function Wait-DrillSetupSignal([int]$Minutes) {
  $until = [DateTime]::UtcNow.AddMinutes($Minutes)
  while ([DateTime]::UtcNow -lt $until) {
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
      try { $after = (Wait-DrillGuest $Credential 30).ToString('o') } catch { $after = '' }
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
function Invoke-DrillBaseline([string]$RunDir) {
  $info = Get-DrillVmInfo
  $decision = Get-DrillBaselineAction $(if ($info) { @{ notes = $info.notes; state = $info.state; checkpoints = $info.checkpoints } } else { $null })
  if ($decision.action -eq 'refuse') { throw (New-DrillError $decision.code) }
  if ($decision.action -eq 'ready') { return [ordered]@{ action = 'ready'; checkpoint = $script:Drill.Checkpoint } }

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
  try {
    Start-VM -VM $vm
    & $note 'started; sending boot keys'
    $keys = Send-DrillBootKeys $script:Drill.VmName $script:Drill.BootKeySeconds
    & $note "boot keys sent: $keys; waiting for setup and OOBE to finish"
    Wait-DrillSetupSignal $script:Drill.InstallTimeoutMinutes   # no logon before this: see SetupSignalName
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
  } catch {
    [void](Save-DrillScreen $script:Drill.VmName (Join-Path $RunDir 'baseline-failure.bmp'))
    $c = Get-DrillCode $_
    & $note "stopped: $($c.code)"
    if ((Get-VM -Name $script:Drill.VmName).State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
    throw
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
  if (-not $facts.dockerActive -or -not $facts.systemdPid1) { throw (New-DrillError 'DRILL_PREREQ_NOT_READY' @{ docker = $facts.dockerActive; systemd = $facts.systemdPid1 }) }
  return $facts
}

# Restore the clean checkpoint, start the VM behind the memory gate, run $Body with the guest credential, and always end Off
# and restored, whatever happened. Returns @{ result; failure; restored }.
function Invoke-DrillOnCheckpoint([scriptblock]$Body) {
  $result = $null; $failure = $null; $restored = $false
  try {
    Restore-VMCheckpoint -VMName $script:Drill.VmName -Name $script:Drill.Checkpoint -Confirm:$false
    [void](Assert-DrillHost)   # the gate again right before the VM takes its 8 GB
    Start-VM -Name $script:Drill.VmName
    $cred = Get-DrillCredential
    [void](Wait-DrillGuest $cred 15)
    $result = & $Body $cred
  } catch { $failure = Get-DrillCode $_ }
  finally {
    try {
      if ((Get-VM -Name $script:Drill.VmName).State -ne 'Off') { Stop-VM -Name $script:Drill.VmName -TurnOff -Force }
      Restore-VMCheckpoint -VMName $script:Drill.VmName -Name $script:Drill.Checkpoint -Confirm:$false
      $restored = (Get-VM -Name $script:Drill.VmName).State -eq 'Off'
    } catch { $restored = $false }
  }
  return @{ result = $result; failure = $failure; restored = $restored }
}

function Invoke-DrillRun([string]$RunDir, $Package, $KitInfo, $Prereq, [pscredential]$Cred) {
  $g = $script:Drill.GuestWork
  $prereqFacts = Invoke-DrillPrereqInGuest $RunDir $Prereq $Cred
  $paths = @{ from = "$g\from"; kit = "$g\kit"; fake = "$g\fake"; work = "$g\work"; version = $Package.version }
  $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
  try {
    Invoke-Command -Session $session -ScriptBlock { param($p) foreach ($d in @($p.from, $p.kit, $p.work)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } -ArgumentList $paths
    foreach ($f in @($Package.tar, $Package.acceptance, $Package.sums)) { Copy-Item -LiteralPath $f -Destination $paths.from -ToSession $session }
    Copy-Item -Path (Join-Path $KitInfo.dir '*') -Destination $paths.kit -ToSession $session -Recurse
    $tarInGuest = Invoke-Command -Session $session -ScriptBlock { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } -ArgumentList (Join-Path $paths.from ([IO.Path]::GetFileName($Package.tar)))
    if ($tarInGuest -cne $Package.tarSha256) { throw (New-DrillError 'DRILL_TAR_CHANGED_IN_COPY') }
    $fake = Invoke-Command -Session $session -ScriptBlock ([scriptblock]::Create(${function:New-DrillFakeCredentials}.ToString())) -ArgumentList $paths.fake
    Write-DrillJson (Join-Path $RunDir 'fake-credentials.public.json') $fake
  } finally { Remove-PSSession -Session $session }

  # A1: the kit entry, once, bounded. No retry.
  $entryArgs = Resolve-DrillKitArguments $KitInfo.arguments $paths
  $entryOut = Invoke-DrillGuest $Cred {
    param($Entry, $EntryArgs)
    $out = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Entry @EntryArgs 2>&1 | ForEach-Object { [string]$_ })
    [ordered]@{ lines = $out; exit = $LASTEXITCODE }
  } -ArgumentList @((Join-Path $paths.kit $KitInfo.entryFile), $entryArgs) -TimeoutMinutes $KitInfo.timeoutMinutes -Code 'DRILL_FIRST_INSTALL_TIMEOUT' -Step 'first-install'
  [IO.File]::WriteAllLines((Join-Path $RunDir 'first-install.log'), [string[]]@($entryOut.lines))
  $entry = Read-DrillEntryResult @($entryOut.lines) ([int]$entryOut.exit)

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
    $reinstall = Invoke-DrillGuest $Cred {
      param($Node, $Tree, $From, $Work, $Version, $TarName, $AccName, $TarSha)
      $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
      $last = { param($lines) $l = @($lines | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1; if ($l) { try { $l | ConvertFrom-Json } catch { $null } } else { $null } }
      $up = @(& $Node (Join-Path $fleet 'upgrade.mjs') fetch --version $Version --work (Join-Path $Work 'a8-upgrade') --from $From --no-request 2>&1 | ForEach-Object { [string]$_ })
      $prep = { param($dir) @(& $Node (Join-Path $fleet 'install.mjs') prepare --artifact (Join-Path $From $TarName) --artifact-sha $TarSha --acceptance (Join-Path $From $AccName) --work (Join-Path $Work $dir) 2>&1 | ForEach-Object { [string]$_ }) }
      $p1 = & $prep 'a8-prepare'; $p1j = & $last $p1
      $launch = @()
      if ($p1j -and $p1j.runCommand) { $launch = @(& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $p1j.runCommand 2>&1 | ForEach-Object { [string]$_ }) }
      [ordered]@{ skipped = $false; upgradeStatus = [string](& $last $up).status; prepareStatus = [string]$p1j.status; launcherTail = @($launch | Select-Object -Last 20); upgradeTail = @($up | Select-Object -Last 5); prepareTail = @($p1 | Select-Object -Last 5) }
    } -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, $Package.version, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256) -TimeoutMinutes 180 -Code 'DRILL_REINSTALL_TIMEOUT' -Step 'reinstall'
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
  } elseif (-not $SkipReinstall) { $reinstall = @{ skipped = $false; upgradeStatus = 'NOT_RUN_ENTRY_GAVE_NO_TREE_OR_NODE'; prepareStatus = $null; reverifyPassed = $false; prepareAgainStatus = $null } }

  return @{ entry = $entry; first = $first; reboot = $reboot; reinstall = $reinstall; fake = $fake; prereq = $prereqFacts }
}

# ---------------------------------------------------------------- main
function Invoke-DrillMain {
  if ($Finalize) {
    if (-not $ProductionReadback) { throw (New-DrillError 'DRILL_USAGE' '-Finalize needs -ProductionReadback') }
    $receipt = Read-DrillJson $Finalize
    if ([string](Get-Prop $receipt 'contract') -cne $script:Drill.ReceiptContract) { throw (New-DrillError 'DRILL_RECEIPT_REFUSED') }
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
    if ($kitInfo.prereqSha256 -cne $prereq.sha256) { throw (New-DrillError 'DRILL_KIT_PREREQ_NOT_THESE' @{ kit = $kitInfo.prereqSha256; prereq = $prereq.sha256 }) }
  }
  $mem = Assert-DrillHost
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $label = if ($Version) { $Version } elseif ($PrereqOnly) { 'prereq' } else { 'baseline' }
  $runDir = Join-Path $script:Drill.Runs "$stamp-$label"
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null

  $baseline = Invoke-DrillBaseline $runDir
  if ($BaselineOnly) {
    Write-DrillJson (Join-Path $runDir 'baseline.json') $baseline
    return [ordered]@{ status = 'DRILL_BASELINE_READY'; action = $baseline.action; checkpoint = $baseline.checkpoint; hostFreeGB = $mem.freeGB; evidence = (Join-Path $runDir 'baseline.json') }
  }
  if ($PrereqOnly) {
    # The prerequisites alone, on a fresh copy of the baseline, then restored: WSL2 under nested virtualization, systemd, docker.
    $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillPrereqInGuest $runDir $prereq $cred }
    $out = [ordered]@{ status = $(if ($o.failure) { 'DRILL_PREREQ_FAILED' } else { 'DRILL_PREREQ_READY' }); code = $(if ($o.failure) { $o.failure.code } else { $null });
      detail = $(if ($o.failure) { $o.failure.detail } else { $null }); restored = $o.restored; prereqSha256 = $prereq.sha256; evidence = (Join-Path $runDir 'prereq-facts.json') }
    Write-DrillJson (Join-Path $runDir 'prereq-run.json') $out
    return $out
  }

  $startedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillRun $runDir $package $kitInfo $prereq $cred }
  $run = $o.result; $failure = $o.failure; $restored = $o.restored

  $evidence = [ordered]@{ localSource = $null }
  $items = @()
  if ($run) {
    $evidence.localSource = [string](Get-Prop $run.first.current 'ciSourceManifestSha256')
    $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = $run.reinstall; kit = $kitInfo }
  }
  $files = @(Get-ChildItem -LiteralPath $runDir -File | Where-Object { $_.Name -ne 'receipt.json' } | ForEach-Object { [ordered]@{ name = $_.Name; sha256 = (Get-Sha256Hex $_.FullName) } })
  $receipt = [ordered]@{
    contract = $script:Drill.ReceiptContract
    machine = 'Hyper-V VM on DESK (drill machine, not a node; phase A)'
    version = $package.version; tarSha256 = $package.tarSha256; ciSourceManifestSha256 = $package.ciSourceManifestSha256
    kitSha256 = $kitInfo.sha256; prereqSha256 = $prereq.sha256; baseline = [ordered]@{ checkpoint = $script:Drill.Checkpoint; build = $baseline }
    startedAt = $startedAt; endedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); hostFreeGBAtStart = $mem.freeGB
    failure = $failure; restoredToCheckpoint = $restored
    evidence = $evidence; files = $files; items = $items
    conclusion = $(if ($failure -or -not $restored) { 'FAIL' } else { Get-DrillConclusion $items })
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
