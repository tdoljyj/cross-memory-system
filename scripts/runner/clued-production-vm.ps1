#requires -Version 5.1
<#
Dedicated Hyper-V lifecycle. Plan is read-only. This script neither registers a
GitHub runner nor accepts, copies, or grants production credentials. A label,
guest manifest, or seal observation does not qualify a production publisher.
#>
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'CreateBuild', 'PrepareBuildVM', 'AttachBase', 'AttachSeed', 'SealBase', 'NewJob', 'ReadStatus', 'Start', 'Stop', 'RetireJob', 'RetireBuild', 'Quarantine')]
    [string]$Action = 'Plan',
    [guid]$InstanceId = [guid]::Empty,
    [guid]$BaseId = [guid]::Empty,
    [ValidateSet('qualification', 'production')]
    [string]$Purpose = 'qualification',
    [string]$ArtifactPath,
    [ValidatePattern('^$|^[a-fA-F0-9]{64}$')]
    [string]$ArtifactSha256,
    [string]$GuestManifestPath,
    [string]$ObservationPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This publisher lifecycle and its plan support Windows hosts only.' }
function Initialize-ProductionHostModules {
    if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -ne 1 -or -not [Environment]::Is64BitProcess) {
        throw 'Execution requires a fresh 64-bit Windows PowerShell Desktop 5.1 process; PowerShell 7 is not supported.'
    }
    $systemPowerShell = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::System), 'WindowsPowerShell\v1.0')
    if ([IO.Path]::GetFullPath($PSHOME) -ine $systemPowerShell) { throw 'Execution requires the system Windows PowerShell 5.1 host.' }
    $systemModules = [IO.Path]::Combine($systemPowerShell, 'Modules')
    $moduleManifests = [ordered]@{
        'Microsoft.PowerShell.Utility' = 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
        'Microsoft.PowerShell.Management' = 'Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1'
        'Microsoft.PowerShell.Security' = 'Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
        'CimCmdlets' = 'CimCmdlets\CimCmdlets.psd1'
        'Hyper-V' = 'Hyper-V\2.0.0.0\Hyper-V.psd1'
    }
    foreach ($name in $moduleManifests.Keys) {
        $manifest = [IO.Path]::Combine($systemModules, $moduleManifests[$name])
        if (-not [IO.File]::Exists($manifest)) { throw 'A required system module manifest is missing.' }
        $allowedModulePaths = @($manifest)
        # These system manifests resolve their binary RootModule through the
        # Windows GAC. ModuleInfo.Path is consequently the official GAC DLL,
        # rather than the manifest used for the explicit import.
        $windowsRoot = [IO.Path]::GetDirectoryName([Environment]::GetFolderPath([Environment+SpecialFolder]::System))
        if ($name -ceq 'CimCmdlets') {
            $allowedModulePaths += [IO.Path]::Combine($windowsRoot, 'Microsoft.NET\assembly\GAC_MSIL\Microsoft.Management.Infrastructure.CimCmdlets\v4.0_1.0.0.0__31bf3856ad364e35\Microsoft.Management.Infrastructure.CimCmdlets.dll')
        } elseif ($name -ceq 'Hyper-V') {
            $allowedModulePaths += [IO.Path]::Combine($windowsRoot, 'Microsoft.NET\assembly\GAC_MSIL\Microsoft.HyperV.PowerShell.Cmdlets\v4.0_10.0.0.0__31bf3856ad364e35\Microsoft.HyperV.PowerShell.Cmdlets.dll')
        }
        foreach ($loaded in @(Get-Module -Name $name)) {
            if ([string]::IsNullOrWhiteSpace($loaded.Path) -or $allowedModulePaths -inotcontains [IO.Path]::GetFullPath($loaded.Path)) {
                throw 'An incompatible dependency is already loaded; start a fresh Windows PowerShell 5.1 process.'
            }
        }
        # Absolute imports avoid inherited Node/PowerShell 7 or user module
        # search paths. Global here means this process only, never host settings.
        Import-Module -Name $manifest -Scope Global -ErrorAction Stop
        $verified = @(Get-Module -Name $name)
        if ($verified.Count -ne 1 -or $allowedModulePaths -inotcontains [IO.Path]::GetFullPath($verified[0].Path)) {
            throw ('A required system module could not be uniquely verified: ' + $name)
        }
    }
    # Every lifecycle dependency is explicitly loaded above. Environment search
    # paths (including automatic ProgramFiles additions) grant no qualification.
    $script:PSModuleAutoloadingPreference = 'None'
}
if ($Action -ne 'Plan') { Initialize-ProductionHostModules }
$profilePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../ci/self-hosted/production-publisher-profile.json'))
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
if ($profile.schema -ne 'clued.production-publisher.host-profile/1' -or $profile.version -ne '1.0.0') { throw 'Unsupported publisher profile.' }
if ($profile.root -cne 'D:\CluedProductionPublisher' -or $profile.host_name -cne 'DESK-W-591' -or
    $profile.owner -cne 'clued-production-publisher-v1' -or $profile.vm_name_prefix -cne 'clued-publisher-' -or
    $profile.generation -ne 2 -or $profile.processor_count -ne 4 -or $profile.memory_bytes -ne 8589934592 -or
    $profile.disk_bytes -ne 68719476736 -or $profile.switch_name -cne 'Default Switch') {
    throw 'The reviewed, dedicated host boundary has changed.'
}
$rootPath = [IO.Path]::GetFullPath($profile.root).TrimEnd('\')
function Write-Result($value) { $value | ConvertTo-Json -Depth 12 -Compress }
if ($Action -eq 'Plan') {
    Write-Result ([ordered]@{
        schema = 'clued.production-vm.plan/1'; action = $Action; side_effects = $false
        profile = $profile; host_matches = ($env:COMPUTERNAME -ceq $profile.host_name)
        prerequisites = @('Hyper-V create/read permission', 'dedicated root ACL', 'pinned base image and guest checks',
            'actual host-device and network isolation tests', 'independent production qualification',
            'one-shot runner registration and cleanup verification')
        production_authorized = $false
    })
    return
}
if ($env:COMPUTERNAME -cne $profile.host_name) { throw 'Wrong publisher host.' }
$actorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($actorSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique

# Query link count without relying on PowerShell-version-specific LinkType.
if (-not ('CluedProductionFileIdentity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CluedProductionFileIdentity {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint attrs; public System.Runtime.InteropServices.ComTypes.FILETIME created;
    public System.Runtime.InteropServices.ComTypes.FILETIME accessed;
    public System.Runtime.InteropServices.ComTypes.FILETIME written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint desiredAccess, uint shareMode,
    IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  public static uint Links(string path) {
    // Metadata-only access, shared with Hyper-V's live disk handle. Open the
    // reparse point itself so a raced replacement cannot silently redirect us.
    using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open file metadata handle.");
      Info info; if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot verify file identity.");
      if ((info.attrs & 0x00000400) != 0) throw new IOException("Reparse-point file identity is forbidden.");
      if (info.links == 0) throw new IOException("File identity returned an invalid link count.");
      return info.links;
    }
  }
}
'@
}

function Assert-SafePath([string]$Path, [switch]$AllowRoot, [switch]$MustExist) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) { throw 'An absolute managed path is required.' }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($full -ine $rootPath -and -not $full.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path leaves the dedicated publisher root.' }
    if ($full -ieq $rootPath -and -not $AllowRoot) { throw 'Operation on the publisher root is forbidden.' }
    if ($full.IndexOf(':', 2) -ge 0) { throw 'Alternate data streams are forbidden.' }
    $cursor = $full
    while ($cursor.Length -ge 3) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are forbidden.' }
            if (-not $item.PSIsContainer -and [CluedProductionFileIdentity]::Links($cursor) -ne 1) { throw 'Hard-linked managed files are forbidden.' }
        }
        if ($cursor -ieq $rootPath -or $cursor -ieq 'D:\') { break }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrEmpty($cursor)) { break }
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $full)) { throw 'Required managed path does not exist.' }
    return $full
}
function Set-PrivateAcl([string]$Path) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($actorSid)))
    foreach ($sid in $allowedSids) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl',
            'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-PrivateAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { throw 'Publisher root ACL inherits access.' }
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $actorSid) { throw 'Publisher root belongs to a different host identity.' }
    $seen = @{}
    foreach ($ace in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($ace.AccessControlType -ne 'Allow' -or $allowedSids -notcontains $ace.IdentityReference.Value) { throw 'Publisher root has an unapproved ACL entry.' }
        $seen[$ace.IdentityReference.Value] = $true
    }
    foreach ($sid in $allowedSids) { if (-not $seen.ContainsKey($sid)) { throw 'Publisher root ACL is incomplete.' } }
}
function Initialize-Root {
    Assert-SafePath $rootPath -AllowRoot | Out-Null
    if (-not (Test-Path -LiteralPath $rootPath)) {
        New-Item -ItemType Directory -Path $rootPath | Out-Null
        Set-PrivateAcl $rootPath
    }
    Assert-PrivateAcl $rootPath
    foreach ($name in @('instances', 'bases', 'artifacts', 'evidence')) {
        $path = Assert-SafePath (Join-Path $rootPath $name)
        if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
    }
}
function Assert-Root {
    Assert-SafePath $rootPath -AllowRoot -MustExist | Out-Null
    Assert-PrivateAcl $rootPath
}
function Get-InstanceFolder([guid]$Id) {
    if ($Id -eq [guid]::Empty) { throw 'InstanceId is required.' }
    return Assert-SafePath (Join-Path $rootPath ('instances\' + $Id.ToString('D')))
}
function Save-Manifest($Manifest, [string]$Folder) {
    $path = Assert-SafePath (Join-Path $Folder 'manifest.json')
    $temp = Assert-SafePath (Join-Path $Folder ('manifest-' + [guid]::NewGuid().ToString('N') + '.tmp'))
    $Manifest.updated_utc = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($temp, ($Manifest | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
    # Windows PowerShell 5.1 binds ordinary $null to an empty string here,
    # which File.Replace rejects as an illegal backup path. Typed NullString
    # produces the actual CLR null required by this overload.
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temp, $path, [System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temp, $path) }
}
function Read-ManagedInstance([guid]$Id) {
    Assert-Root
    $folder = Get-InstanceFolder $Id
    $path = Assert-SafePath (Join-Path $folder 'manifest.json') -MustExist
    $m = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($m.schema -ne 'clued.production-vm.instance/1' -or $m.instance_id -cne $Id.ToString('D') -or
        $m.owner -cne $profile.owner -or $m.host_name -cne $profile.host_name -or $m.host_sid -cne $actorSid -or
        $m.vm_name -cne ($profile.vm_name_prefix + $Id.ToString('N')) -or $m.folder -ine $folder) { throw 'Instance manifest identity mismatch.' }
    return $m
}
function Get-ManagedVm($Manifest) {
    $vms = @(Get-VM -Id ([guid]$Manifest.vm_id) -ErrorAction Stop)
    if ($vms.Count -ne 1 -or $vms[0].Name -cne $Manifest.vm_name -or $vms[0].Notes -cne $Manifest.owner_note) { throw 'VM identity or owner note mismatch.' }
    return $vms[0]
}
function Assert-NoUnexpectedDevices($Manifest, $Vm) {
    $folder = Get-InstanceFolder ([guid]$Manifest.instance_id)
    foreach ($disk in @(Get-VMHardDiskDrive -VM $Vm)) {
        $path = Assert-SafePath $disk.Path -MustExist
        if ($Manifest.disk_path -ine $path -or [IO.Path]::GetDirectoryName($path) -ine $folder) { throw 'VM has an unowned disk.' }
    }
    foreach ($dvd in @(Get-VMDvdDrive -VM $Vm)) {
        if ($dvd.Path) {
            $dvdPath = Assert-SafePath $dvd.Path -MustExist
            if ($Manifest.install_iso_path -ine $dvdPath -and $Manifest.seed_iso_path -ine $dvdPath) { throw 'VM has an unowned DVD.' }
        }
    }
    $adapters = @(Get-VMNetworkAdapter -VM $Vm)
    if ($adapters.Count -ne 1 -or $adapters[0].SwitchName -cne $profile.switch_name) { throw 'VM network device differs from the reviewed profile.' }
    if (@(Get-VMFibreChannelHba -VM $Vm).Count -ne 0 -or @(Get-VMAssignableDevice -VM $Vm).Count -ne 0) { throw 'Passthrough devices are forbidden.' }
    return $true
}
function Mark-Quarantined($Manifest, [string]$ReasonCode, [switch]$BestEffort) {
    $Manifest.status = 'quarantined'
    $Manifest.quarantine_reason = $ReasonCode
    try { Save-Manifest $Manifest $Manifest.folder }
    catch {
        if (-not $BestEffort) { throw }
        # Keep the caller's original error. Never report quarantine as durably
        # saved when the persistence operation itself is what failed.
        Write-Warning 'Quarantine persistence failed; inspect the original failure and reserved instance before any reuse.' -WarningAction Continue
    }
}
function Save-ProviderRetirementEvidence($Report, [string]$Folder) {
    $folderPath = Assert-SafePath $Folder -MustExist
    $path = Assert-SafePath (Join-Path $folderPath ('provider-retirement-' + [guid]::NewGuid().ToString('N') + '.json'))
    [IO.File]::WriteAllText($path, ($Report | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
    return $path
}
function Test-ExactVmAbsent([guid]$VmId) {
    try {
        $remaining = @(Get-VM -Id $VmId -ErrorAction Stop)
        return ($remaining.Count -eq 0)
    } catch {
        if ($_.FullyQualifiedErrorId -ceq 'ObjectNotFound,Microsoft.HyperV.PowerShell.Commands.GetVM' -and
            $_.CategoryInfo.Category.ToString() -ceq 'ObjectNotFound') { return $true }
        throw
    }
}
function Get-ExactVmConfigurationAbsence($Manifest) {
    $id = [guid]$Manifest.vm_id
    if ($id -eq [guid]::Empty) { throw 'A concrete VM ID is required for configuration verification.' }
    $folder = Get-InstanceFolder ([guid]$Manifest.instance_id)
    $configDirectory = Assert-SafePath (Join-Path (Join-Path $folder $Manifest.vm_name) 'Virtual Machines')
    $residualPaths = @()
    if (Test-Path -LiteralPath $configDirectory) {
        if (-not (Get-Item -LiteralPath $configDirectory -Force).PSIsContainer) { throw 'VM configuration boundary is not a directory.' }
        foreach ($entry in @(Get-ChildItem -LiteralPath $configDirectory -Force -ErrorAction Stop)) {
            # Match this complete GUID only, including unknown extensions or a
            # GUID directory. Keep logs, disks, seed files, and other GUIDs.
            if ($entry.Name -ieq $id.ToString('D') -or $entry.Name.StartsWith($id.ToString('D') + '.', [StringComparison]::OrdinalIgnoreCase)) {
                $residualPaths += Assert-SafePath $entry.FullName -MustExist
            }
        }
    }
    return [pscustomobject][ordered]@{
        vm_id = $id.ToString('D'); checked_directory = $configDirectory
        observed_utc = [DateTime]::UtcNow.ToString('o'); absent = ($residualPaths.Count -eq 0); residual_paths = $residualPaths
    }
}
function Remove-ManagedVmProvider($Manifest, [ValidateRange(1, 60)][int]$ObservationTimeoutSeconds = 60) {
    # The standard local provider is the chosen implementation, not a fallback
    # that changes principal, bypasses a denial, or repairs the host service.
    $namespace = 'root/virtualization/v2'
    $id = [guid]$Manifest.vm_id
    if ($id -eq [guid]::Empty) { throw 'A concrete managed VM ID is required.' }
    $report = [pscustomobject][ordered]@{
        schema = 'clued.production-vm.provider-retirement/1'; instance_id = $Manifest.instance_id
        vm_id = $id.ToString('D'); vm_name = $Manifest.vm_name; host_sid = $actorSid
        observed_utc = [DateTime]::UtcNow.ToString('o'); namespace = $namespace
        method = 'Msvm_VirtualSystemManagementService.DestroySystem'; return_value = $null
        job_instance_id = $null; job_observations = @(); cim_absent = $false; vm_absent = $false
        configuration_absent = $false; configuration_footprint = $null
        result = 'UNKNOWN'; failure_stage = $null; evidence_path = $null
    }
    $stage = 'managed_identity'
    try {
        $vm = Get-ManagedVm $Manifest
        Assert-Off $vm
        Assert-NoUnexpectedDevices $Manifest $vm | Out-Null
        $folder = Get-InstanceFolder ([guid]$Manifest.instance_id)
        $configPath = Assert-SafePath $vm.ConfigurationLocation -MustExist
        if ($configPath -ine (Join-Path $folder $Manifest.vm_name)) { throw 'VM configuration is outside its exact reserved directory.' }
        $stage = 'provider_identity'
        $target = @(Get-CimInstance -Namespace $namespace -ClassName Msvm_ComputerSystem -Filter "Name='$($id.ToString('D'))'" -ErrorAction Stop)
        $service = @(Get-CimInstance -Namespace $namespace -ClassName Msvm_VirtualSystemManagementService -Filter "Name='vmms'" -ErrorAction Stop)
        if ($target.Count -ne 1 -or $service.Count -ne 1 -or $target[0].Name -ine $id.ToString('D') -or
            $target[0].ElementName -cne $Manifest.vm_name -or $target[0].EnabledState -ne 3 -or
            $service[0].Name -cne 'vmms' -or $service[0].SystemName -ine $profile.host_name -or
            $service[0].Started -ne $true -or $service[0].EnabledState -ne 2) { throw 'Exact CIM target or local management service did not match.' }
        $stage = 'provider_destroy'
        $result = Invoke-CimMethod -InputObject $service[0] -MethodName DestroySystem -Arguments @{ AffectedSystem = $target[0] } -ErrorAction Stop
        if ($null -eq $result -or $null -eq $result.PSObject.Properties['ReturnValue'] -or $null -eq $result.ReturnValue) { throw 'Provider returned no result code.' }
        $report.return_value = [uint32]$result.ReturnValue
        if ($report.return_value -eq 4096) {
            $stage = 'provider_job'
            if ($null -eq $result.PSObject.Properties['Job'] -or -not ($result.Job -is [Microsoft.Management.Infrastructure.CimInstance])) { throw 'Asynchronous destruction returned no typed Job reference.' }
            $jobRef = $result.Job
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $completed = $false
            do {
                $remainingSeconds = $ObservationTimeoutSeconds - $watch.Elapsed.TotalSeconds
                if ($remainingSeconds -lt 1) { throw 'Provider job observation timed out.' }
                $jobs = @(Get-CimInstance -InputObject $jobRef -OperationTimeoutSec ([uint32][Math]::Floor($remainingSeconds)) -ErrorAction Stop)
                if ($jobs.Count -ne 1 -or [string]::IsNullOrWhiteSpace($jobs[0].InstanceID)) { throw 'Provider job could not be uniquely observed.' }
                $job = $jobs[0]
                if ($null -eq $report.job_instance_id) { $report.job_instance_id = $job.InstanceID }
                if ($job.InstanceID -cne $report.job_instance_id) { throw 'Provider job identity changed.' }
                $report.job_observations += [ordered]@{
                    observed_utc = [DateTime]::UtcNow.ToString('o'); instance_id = $job.InstanceID
                    state = [int]$job.JobState; percent = $job.PercentComplete; error_code = $job.ErrorCode
                }
                if ($job.JobState -eq 7) {
                    if ($null -eq $job.ErrorCode -or $job.ErrorCode -ne 0) { throw 'Completed provider job has an error or missing error code.' }
                    $completed = $true
                    break
                }
                if ($job.JobState -in @(8, 9, 10) -or $job.JobState -notin @(2, 3, 4, 5, 6, 11)) { throw 'Provider job failed or entered an unknown state.' }
                if ($watch.Elapsed.TotalSeconds + 0.5 -ge $ObservationTimeoutSeconds) { throw 'Provider job observation timed out.' }
                Start-Sleep -Milliseconds 500
            } while ($watch.Elapsed.TotalSeconds -lt $ObservationTimeoutSeconds)
            if (-not $completed) { throw 'Provider job completion was not observed.' }
        } elseif ($report.return_value -ne 0) { throw 'Provider refused or failed the destruction operation.' }
        $stage = 'independent_absence'
        $remainingCim = @(Get-CimInstance -Namespace $namespace -ClassName Msvm_ComputerSystem -Filter "Name='$($id.ToString('D'))'" -ErrorAction Stop)
        $report.cim_absent = ($remainingCim.Count -eq 0)
        $report.vm_absent = Test-ExactVmAbsent $id
        $stage = 'configuration_absence'
        $report.configuration_footprint = Get-ExactVmConfigurationAbsence $Manifest
        $report.configuration_absent = $report.configuration_footprint.absent
        if (-not $report.cim_absent -or -not $report.vm_absent -or -not $report.configuration_absent) { throw 'VM removal and exact configuration absence were not independently verified.' }
        $report.result = 'VERIFIED_REMOVED'
        $stage = 'evidence_persistence'
        $report.evidence_path = Save-ProviderRetirementEvidence $report $Manifest.folder
        return $report
    } catch {
        $report.result = 'FAILED_OR_UNKNOWN'
        $report.failure_stage = $stage
        try { Save-ProviderRetirementEvidence $report $Manifest.folder | Out-Null }
        catch { Write-Warning 'Provider retirement evidence persistence failed; the original operation error is retained.' -WarningAction Continue }
        throw
    }
}
function New-ManagedVm([string]$Kind, [string]$JobPurpose) {
    Initialize-Root
    $switch = @(Get-VMSwitch -Name $profile.switch_name -ErrorAction Stop)
    if ($switch.Count -ne 1) { throw 'The pre-existing switch is not uniquely present.' }
    $id = [guid]::NewGuid()
    $folder = Get-InstanceFolder $id
    $name = $profile.vm_name_prefix + $id.ToString('N')
    if ((Test-Path -LiteralPath $folder) -or @(Get-VM -Name $name -ErrorAction SilentlyContinue).Count -ne 0) { throw 'A fresh VM identity is required.' }
    New-Item -ItemType Directory -Path $folder | Out-Null
    $m = [pscustomobject][ordered]@{
        schema = 'clued.production-vm.instance/1'; instance_id = $id.ToString('D'); owner = $profile.owner
        host_name = $profile.host_name; host_sid = $actorSid; vm_name = $name; vm_id = $null
        owner_note = ('clued.production-vm/1;owner=' + $profile.owner + ';instance=' + $id.ToString('D'))
        folder = $folder; kind = $Kind; purpose = $JobPurpose; status = 'creating'; disk_path = $null
        install_iso_path = $null; seed_iso_path = $null; base_id = $null; base_sha256 = $null
        guest_manifest_sha256 = $null; observation_sha256 = $null; quarantine_reason = $null
        production_qualified = $false; created_utc = [DateTime]::UtcNow.ToString('o'); updated_utc = $null
    }
    Save-Manifest $m $folder
    try {
        $vm = New-VM -Name $name -Generation $profile.generation -MemoryStartupBytes $profile.memory_bytes -NoVHD -Path $folder -SwitchName $profile.switch_name
        $m.vm_id = $vm.Id.ToString('D')
        Set-VM -VM $vm -Notes $m.owner_note
        Save-Manifest $m $folder
        Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType Disabled
        Set-VMProcessor -VM $vm -Count $profile.processor_count
        Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
        $guestServiceId = '6C09BB55-D683-4DA0-8931-C9BF705F6480'
        $guestServices = @(Get-VMIntegrationService -VM $vm | Where-Object { $_.Id.ToString().EndsWith('\' + $guestServiceId, [StringComparison]::OrdinalIgnoreCase) })
        if ($guestServices.Count -ne 1) { throw 'Cannot uniquely identify the Guest Service Interface.' }
        Disable-VMIntegrationService -VMIntegrationService $guestServices[0] -ErrorAction Stop
        $guestServiceAfter = @(Get-VMIntegrationService -VM $vm | Where-Object { $_.Id.ToString() -ieq $guestServices[0].Id.ToString() })
        if ($guestServiceAfter.Count -ne 1 -or $guestServiceAfter[0].Enabled) { throw 'Guest Service Interface disable was not verified.' }
        $m.status = 'prepared'
        Save-Manifest $m $folder
        return $m
    } catch {
        Mark-Quarantined $m 'vm_creation_incomplete' -BestEffort
        throw
    }
}
function Assert-Off($Vm) { if ($Vm.State.ToString() -cne 'Off') { throw 'The VM must be fully Off.' } }
function Assert-Usable($Manifest) {
    if ($Manifest.status -in @('quarantined', 'retired', 'sealed', 'creating')) { throw 'This instance cannot accept another lifecycle action.' }
}
function Get-Artifact([string]$Path, [string]$Sha, [string]$Extension) {
    if ($Sha -notmatch '^[a-fA-F0-9]{64}$') { throw 'An independently verified artifact SHA-256 is required.' }
    $p = Assert-SafePath $Path -MustExist
    $artifactRoot = Join-Path $rootPath 'artifacts'
    if (-not $p.StartsWith($artifactRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($p) -ine $Extension) { throw 'Only a pinned artifact inside the dedicated artifacts directory is accepted.' }
    if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ine $Sha) { throw 'Artifact SHA-256 mismatch.' }
    return $p
}
function Assert-QualificationStart($Manifest, [string]$RequestedPurpose) {
    if ($RequestedPurpose -ine 'qualification' -or $null -eq $Manifest.PSObject.Properties['purpose'] -or
        $Manifest.purpose -ine 'qualification' -or $null -eq $Manifest.PSObject.Properties['production_qualified'] -or
        $Manifest.production_qualified -isnot [bool] -or $Manifest.production_qualified -ne $false) {
        throw 'Start requires qualification purpose in both request and saved manifest, with an explicit unqualified boolean.'
    }
}
function Enter-HostLifecycleLock(
    [ValidatePattern('^Global\\CluedProductionPublisherLifecycle\.DESK-W-591(?:\.test\.[a-f0-9]{32})?$')]
    [string]$LockName = 'Global\CluedProductionPublisherLifecycle.DESK-W-591'
) {
    $security = New-Object Security.AccessControl.MutexSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner((New-Object Security.Principal.SecurityIdentifier($actorSid)))
    foreach ($sid in $allowedSids) {
        $rule = New-Object Security.AccessControl.MutexAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'Allow')
        $security.AddAccessRule($rule)
    }
    $created = $false
    $mutex = New-Object Threading.Mutex($false, $LockName, [ref]$created, $security)
    $owned = $false
    try {
        # A constructor does not replace the ACL of an existing named mutex.
        # Verify it before waiting; never adopt an object with a different owner.
        $actual = $mutex.GetAccessControl()
        if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $actorSid) { throw 'Host lifecycle lock ownership or ACL protection did not match.' }
        $seen = @{}
        foreach ($ace in $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($ace.AccessControlType -ne 'Allow' -or $allowedSids -notcontains $ace.IdentityReference.Value -or
                $ace.MutexRights -ne [Security.AccessControl.MutexRights]::FullControl) { throw 'Host lifecycle lock contains an unapproved ACL entry.' }
            $seen[$ace.IdentityReference.Value] = $true
        }
        foreach ($sid in $allowedSids) { if (-not $seen.ContainsKey($sid)) { throw 'Host lifecycle lock ACL is incomplete.' } }
        try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Another host lifecycle operation is in progress.' }
        return $mutex
    } catch {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
        throw
    }
}
function Exit-HostLifecycleLock([System.Threading.Mutex]$Mutex) {
    try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
}

$lifecycleMutex = Enter-HostLifecycleLock
try {

if ($Action -eq 'CreateBuild') { Write-Result (New-ManagedVm 'build' 'qualification'); return }
if ($Action -eq 'NewJob') {
    # Production remains closed in this revision. Removing this guard requires a
    # separately reviewed qualification implementation and exact evidence binding.
    if ($Purpose -eq 'production') { throw 'Production publisher qualification is not implemented or granted by this profile.' }
    Assert-Root
    foreach ($candidate in @(Get-ChildItem -LiteralPath (Join-Path $rootPath 'instances') -Directory)) {
        $candidatePath = Assert-SafePath $candidate.FullName -MustExist
        $candidateId = [guid]::Empty
        if (-not [guid]::TryParse($candidate.Name, [ref]$candidateId)) { throw 'Unexpected instance directory requires inspection.' }
        $existing = Read-ManagedInstance $candidateId
        if ($existing.status -eq 'quarantined' -or ($existing.kind -eq 'job' -and $existing.status -ne 'retired')) { throw 'A previous job or quarantine must be resolved before another job is created.' }
    }
    if ($BaseId -eq [guid]::Empty) { throw 'BaseId is required.' }
    $baseFolder = Assert-SafePath (Join-Path $rootPath ('bases\' + $BaseId.ToString('D'))) -MustExist
    $baseManifestPath = Assert-SafePath (Join-Path $baseFolder 'base-manifest.json') -MustExist
    $base = Get-Content -LiteralPath $baseManifestPath -Raw | ConvertFrom-Json
    $baseDisk = Assert-SafePath (Join-Path $baseFolder 'base.vhdx') -MustExist
    if ($base.schema -ne 'clued.production-vm.sealed-base/1' -or $base.base_id -cne $BaseId.ToString('D') -or
        $base.owner -cne $profile.owner -or $base.host_sid -cne $actorSid -or $base.disk_path -ine $baseDisk -or
        (Get-FileHash -LiteralPath $baseDisk -Algorithm SHA256).Hash -ine $base.disk_sha256 -or
        ((Get-Item -LiteralPath $baseDisk).Attributes -band [IO.FileAttributes]::ReadOnly) -eq 0) { throw 'Sealed base identity or hash verification failed.' }
    $m = New-ManagedVm 'job' $Purpose
    try {
        $vm = Get-ManagedVm $m
        $disk = Assert-SafePath (Join-Path $m.folder 'job.vhdx')
        if (Test-Path -LiteralPath $disk) { throw 'A job disk must never be reused.' }
        New-VHD -Path $disk -ParentPath $baseDisk -Differencing | Out-Null
        $m.disk_path = $disk; $m.base_id = $base.base_id; $m.base_sha256 = $base.disk_sha256
        Add-VMHardDiskDrive -VM $vm -Path $disk
        $m.status = 'prepared'; Save-Manifest $m $m.folder
        Write-Result $m
    } catch { Mark-Quarantined $m 'job_preparation_incomplete' -BestEffort; throw }
    return
}

$m = Read-ManagedInstance $InstanceId
if ($Action -eq 'ReadStatus') {
    if ($m.status -eq 'retired') { Write-Result $m; return }
    $vm = Get-ManagedVm $m
    $deviceCheck = Assert-NoUnexpectedDevices $m $vm
    Write-Result ([ordered]@{ schema = 'clued.production-vm.status/1'; instance = $m; vm_state = $vm.State.ToString(); devices_match = $deviceCheck; production_qualified = $false })
    return
}
$vm = Get-ManagedVm $m
if ($Action -eq 'Quarantine') { Mark-Quarantined $m 'operator_requested'; Write-Result $m; return }
if ($Action -eq 'Stop') {
    # Shutdown is intentionally graceful. An unresponsive guest is quarantined,
    # not forcibly powered off and silently reused.
    if ($vm.State.ToString() -ne 'Off') {
        try { Stop-VM -VM $vm -ErrorAction Stop } catch { Mark-Quarantined $m 'graceful_stop_failed' -BestEffort; throw }
    }
    $vm = Get-ManagedVm $m
    if ($vm.State.ToString() -ne 'Off') { Mark-Quarantined $m 'shutdown_not_off'; throw 'Shutdown did not finish; instance is quarantined.' }
    Write-Result $m; return
}
if ($Action -notin @('RetireJob', 'RetireBuild')) { Assert-Usable $m }
Assert-Off $vm
Assert-NoUnexpectedDevices $m $vm | Out-Null
if ($Action -eq 'AttachSeed') {
    if ($m.seed_iso_path -or @(Get-VMDvdDrive -VM $vm).Count -gt 0) { throw 'A seed must only be attached once to a VM without an existing DVD.' }
    $iso = Get-Artifact $ArtifactPath $ArtifactSha256 '.iso'
    try {
        Add-VMDvdDrive -VM $vm -Path $iso
        $m.seed_iso_path = $iso
        Save-Manifest $m $m.folder
        Write-Result $m
    } catch { Mark-Quarantined $m 'seed_attachment_incomplete' -BestEffort; throw }
    return
}
if ($Action -in @('PrepareBuildVM', 'AttachBase')) {
    if ($m.kind -ne 'build' -or $m.disk_path -or @(Get-VMHardDiskDrive -VM $vm).Count -ne 0) { throw 'Only an empty, freshly created build VM can receive its initial disk.' }
    $disk = Assert-SafePath (Join-Path $m.folder 'build.vhdx')
    if (Test-Path -LiteralPath $disk) { throw 'Build disk already exists.' }
    try {
        if ($Action -eq 'AttachBase') {
            $source = Get-Artifact $ArtifactPath $ArtifactSha256 '.vhdx'
            $vhd = Get-VHD -Path $source
            if ($vhd.VhdType.ToString() -eq 'Differencing' -or $vhd.ParentPath -or $vhd.Size -gt $profile.disk_bytes) { throw 'An imported artifact cannot have a parent disk or exceed the reviewed disk size.' }
            Copy-Item -LiteralPath $source -Destination $disk
            (Get-Item -LiteralPath $disk).IsReadOnly = $false
            if ((Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash -ine $ArtifactSha256) { throw 'Copied artifact hash mismatch.' }
            if ($vhd.Size -lt $profile.disk_bytes) { Resize-VHD -Path $disk -SizeBytes $profile.disk_bytes }
        } else {
            New-VHD -Path $disk -Dynamic -SizeBytes $profile.disk_bytes | Out-Null
            if ($ArtifactPath) {
                $iso = Get-Artifact $ArtifactPath $ArtifactSha256 '.iso'
                Add-VMDvdDrive -VM $vm -Path $iso
                $m.install_iso_path = $iso
            }
        }
        $m.disk_path = $disk
        Add-VMHardDiskDrive -VM $vm -Path $disk
        Save-Manifest $m $m.folder
        Write-Result $m
    } catch { Mark-Quarantined $m 'build_disk_preparation_incomplete' -BestEffort; throw }
    return
}
if ($Action -eq 'Start') {
    Assert-QualificationStart $m $Purpose
    if (-not $m.disk_path -or @(Get-VMHardDiskDrive -VM $vm).Count -ne 1) { throw 'One owned boot disk is required.' }
    try { Start-VM -VM $vm | Out-Null; $m.status = 'started'; Save-Manifest $m $m.folder; Write-Result $m }
    catch { Mark-Quarantined $m 'start_failed' -BestEffort; throw }
    return
}
if ($Action -eq 'SealBase') {
    if ($m.kind -ne 'build' -or -not $m.disk_path -or @(Get-VMHardDiskDrive -VM $vm).Count -ne 1) { throw 'One owned build disk is required.' }
    $guestPath = Assert-SafePath $GuestManifestPath -MustExist
    $obsPath = Assert-SafePath $ObservationPath -MustExist
    $evidenceRoot = Join-Path $rootPath 'evidence'
    foreach ($path in @($guestPath, $obsPath)) { if (-not $path.StartsWith($evidenceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Seal evidence must be inside the dedicated evidence directory.' } }
    $guest = Get-Content -LiteralPath $guestPath -Raw | ConvertFrom-Json
    $obs = Get-Content -LiteralPath $obsPath -Raw | ConvertFrom-Json
    $guestSha = (Get-FileHash -LiteralPath $guestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($guest.schema -cne $profile.guest_manifest_schema -or $guest.production_qualified -ne $false -or
        $guest.template_sealed -ne $false -or $guest.runner_configured -ne $false -or
        $guest.script_provisioned_credentials -ne $false -or $guest.state -cne 'nonproduction/unqualified') {
        throw 'Guest base manifest is missing or claims unsupported qualification.'
    }
    foreach ($name in @('ubuntu-24.04-amd64-hyper-v', 'signed-official-ubuntu-apt-sources', 'no-known-host-share-filesystem',
        'runner-pinned-archive-and-extracted-content', 'runner-locked-no-sudo-exact-groups',
        'runner-unregistered-no-service-no-process-no-credential-paths', 'guest-local-docker-socket-and-root', 'required-dpkg-packages-installed')) {
        if (@($guest.checks | Where-Object { $_.name -ceq $name -and $_.status -ceq 'PASS' }).Count -ne 1) { throw 'Required guest inspection did not pass.' }
    }
    if ($obs.schema -ne 'clued.production-vm-seal-observation/1' -or $obs.instance_id -cne $m.instance_id -or
        $obs.vm_id -cne $m.vm_id -or $obs.guest_manifest_sha256 -ine $guestSha -or $obs.host_sid -cne $actorSid) { throw 'Host observation does not bind this VM and exact guest manifest.' }
    $observed = [DateTimeOffset]::Parse($obs.observed_utc)
    if ($observed.UtcDateTime -lt [DateTime]::UtcNow.AddHours(-2) -or $observed.UtcDateTime -gt [DateTime]::UtcNow.AddMinutes(1)) { throw 'Seal observation is stale or in the future.' }
    foreach ($name in @('guest_manifest_readback', 'guest_check_only', 'no_runner_registration', 'no_credential_residue', 'no_host_mount_or_socket', 'guest_shutdown')) {
        $matches = @($obs.checks | Where-Object { $_.name -ceq $name -and $_.status -ceq 'PASS' -and -not [string]::IsNullOrWhiteSpace($_.evidence_sha256) -and $_.evidence_sha256 -match '^[a-fA-F0-9]{64}$' })
        if ($matches.Count -ne 1) { throw 'A required observed seal check is missing, ambiguous, or unsuccessful.' }
    }
    $buildDisk = Assert-SafePath $m.disk_path -MustExist
    if ($obs.disk_sha256 -ine (Get-FileHash -LiteralPath $buildDisk -Algorithm SHA256).Hash) { throw 'Host observation does not bind the stopped build disk.' }
    $id = [guid]::NewGuid()
    $folder = Assert-SafePath (Join-Path $rootPath ('bases\' + $id.ToString('D')))
    if (Test-Path -LiteralPath $folder) { throw 'A base generation is immutable.' }
    try {
        New-Item -ItemType Directory -Path $folder | Out-Null
        $baseDisk = Assert-SafePath (Join-Path $folder 'base.vhdx')
        Copy-Item -LiteralPath $buildDisk -Destination $baseDisk
        $digest = (Get-FileHash -LiteralPath $baseDisk -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($digest -ine $obs.disk_sha256) { throw 'Sealed base copy differs from the stopped disk.' }
        (Get-Item -LiteralPath $baseDisk).IsReadOnly = $true
        $base = [ordered]@{
            schema = 'clued.production-vm.sealed-base/1'; base_id = $id.ToString('D'); owner = $profile.owner
            host_name = $profile.host_name; host_sid = $actorSid; source_instance_id = $m.instance_id; source_vm_id = $m.vm_id
            disk_path = $baseDisk; disk_sha256 = $digest; guest_manifest_sha256 = $guestSha
            observation_sha256 = (Get-FileHash -LiteralPath $obsPath -Algorithm SHA256).Hash.ToLowerInvariant()
            production_qualified = $false; sealed_utc = [DateTime]::UtcNow.ToString('o')
        }
        [IO.File]::WriteAllText((Join-Path $folder 'base-manifest.json'), ($base | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        $m.guest_manifest_sha256 = $guestSha; $m.observation_sha256 = $base.observation_sha256; $m.status = 'sealed'
        Save-Manifest $m $m.folder
        Write-Result $base
    } catch { Mark-Quarantined $m 'seal_incomplete' -BestEffort; throw }
    return
}
if ($Action -eq 'RetireBuild') {
    if ($m.kind -ne 'build') { throw 'RetireBuild is restricted to owned build instances.' }
    try {
        $retained = @()
        $attachedDisks = @(Get-VMHardDiskDrive -VM $vm)
        if ($m.disk_path) {
            $disk = Assert-SafePath $m.disk_path -MustExist
            if ($attachedDisks.Count -ne 1 -or [IO.Path]::GetDirectoryName($disk) -ine $m.folder -or
                [IO.Path]::GetFileName($disk) -cne 'build.vhdx') { throw 'Unexpected build disk preservation boundary.' }
            $retained += [pscustomobject]@{kind='build_disk';path=$disk;sha256=(Get-FileHash -LiteralPath $disk -Algorithm SHA256).Hash.ToLowerInvariant();read_only=$true}
            (Get-Item -LiteralPath $disk).IsReadOnly = $true
        } elseif ($attachedDisks.Count -ne 0) { throw 'An unrecorded build disk cannot be retired.' }
        foreach ($isoPath in @($m.install_iso_path, $m.seed_iso_path)) {
            if ($isoPath) {
                $iso = Assert-SafePath $isoPath -MustExist
                if (@($retained | Where-Object { $_.path -ieq $iso }).Count -eq 0) {
                    # Shared pinned artifacts are retained and hashed, never
                    # deleted or modified merely because this build is retired.
                    $retained += [pscustomobject]@{kind='attached_iso';path=$iso;sha256=(Get-FileHash -LiteralPath $iso -Algorithm SHA256).Hash.ToLowerInvariant();read_only=((Get-Item -LiteralPath $iso).Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0}
                }
            }
        }
        $m | Add-Member -NotePropertyName retained_build_artifacts -NotePropertyValue $retained -Force
        Save-Manifest $m $m.folder
        $providerRetirement = Remove-ManagedVmProvider $m
        $m | Add-Member -NotePropertyName provider_retirement -NotePropertyValue $providerRetirement -Force
        Save-Manifest $m $m.folder
        foreach ($artifact in $retained) {
            $path = Assert-SafePath $artifact.path -MustExist
            if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $artifact.sha256 -or
                ($artifact.kind -ceq 'build_disk' -and -not (Get-Item -LiteralPath $path).IsReadOnly)) {
                throw 'Build retirement did not verify preservation of every retained artifact.'
            }
        }
        $configurationAfterRetention = Get-ExactVmConfigurationAbsence $m
        if (-not $configurationAfterRetention.absent) { throw 'Build retirement left the exact VM configuration footprint behind.' }
        $m | Add-Member -NotePropertyName configuration_after_retention -NotePropertyValue $configurationAfterRetention -Force
        $m.status = 'retired'; Save-Manifest $m $m.folder
        Write-Result $m
    } catch { Mark-Quarantined $m 'build_retirement_not_verified' -BestEffort; throw }
    return
}
if ($Action -eq 'RetireJob') {
    if ($m.kind -ne 'job') { throw 'RetireJob is restricted to disposable job instances.' }
    # Off, exact VM identity, no unexpected devices, and every resolved file path
    # are checked before deletion. Evidence and manifests are retained.
    $disk = Assert-SafePath $m.disk_path -MustExist
    if ([IO.Path]::GetDirectoryName($disk) -ine $m.folder -or [IO.Path]::GetFileName($disk) -cne 'job.vhdx') { throw 'Unexpected disposable disk path.' }
    try {
        $providerRetirement = Remove-ManagedVmProvider $m
        $m | Add-Member -NotePropertyName provider_retirement -NotePropertyValue $providerRetirement -Force
        Save-Manifest $m $m.folder
        Assert-SafePath $disk -MustExist | Out-Null
        Remove-Item -LiteralPath $disk
        if (Test-Path -LiteralPath $disk) { throw 'Disposable disk removal was not verified.' }
        $m.status = 'retired'; Save-Manifest $m $m.folder
        Write-Result $m
    } catch { Mark-Quarantined $m 'retirement_not_verified' -BestEffort; throw }
    return
}
throw 'Unsupported lifecycle transition.'
} finally {
    Exit-HostLifecycleLock $lifecycleMutex
}
