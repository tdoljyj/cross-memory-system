#requires -Version 7.2
# Trusted Owner management only. Dot-source defines functions; direct invocation denies.
# No Agent command/root/role surface. Installation and real window use need separate approval.
function Get-M2FaultConstants {
    [pscustomobject]@{
        VmId='9d775385-4546-4450-a77f-08cdf4f696b6'; VmName='m2-isolation-probe'; HostName='DESK-W-591'
        Root='C:\Clued\M2Isolation\host-a'; Python='C:\Users\Windows\AppData\Local\Programs\Python\Python312\python.exe'
        ServiceId='0000ac45-facb-11e6-bd58-64006a7986d3'
        RegistryParent='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'
        ElementName='Clued M2 A Empty Probe'; TimeoutMs=30000; MaxZipBytes=16777216
        Members=@('base-a.zip','fault_fixture.py','fault_observer.py','management.py','fault_bridge.py','host-helper.ps1','fault-installer.py','fault-plan.json','manifest.json')
        GuestRun='/usr/bin/python3 -B -I -S /usr/local/lib/clued-m2-a-fault-fixture/management.py --run-fixed-batch'
        GuestSummary='/usr/bin/python3 -B -I -S /usr/local/lib/clued-m2-a-fault-fixture/management.py --summarize-fixed-batch'
    }
}
function Get-M2FaultHash([byte[]]$Bytes) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Assert-M2FaultKeys($Value,[string[]]$Keys) {
    $actual=@($Value.Keys | Sort-Object); $expected=@($Keys | Sort-Object)
    if (($actual -join '|') -cne ($expected -join '|')) { throw 'CLOSED_KEYS_INVALID' }
}
function ConvertFrom-M2FaultJson([byte[]]$Bytes) {
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
    # JsonDocument retains duplicate properties, unlike ConvertFrom-Json.
    $doc=[System.Text.Json.JsonDocument]::Parse($text)
    try {
        function AssertUnique($node) {
            if ($node.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                foreach($property in $node.EnumerateObject()) {
                    if (!$seen.Add($property.Name)) { throw 'DUPLICATE_JSON_KEY' }
                    AssertUnique $property.Value
                }
            } elseif($node.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) { foreach($item in $node.EnumerateArray()) { AssertUnique $item } }
        }
        AssertUnique $doc.RootElement
        ConvertFrom-Json -InputObject $text -AsHashtable -Depth 30
    } finally { $doc.Dispose() }
}
function Read-M2FaultPackage([string]$ExactZip,[string]$ApprovedSha256) {
    $c=Get-M2FaultConstants
    if ($ApprovedSha256 -cnotmatch '^[0-9a-f]{64}$' -or ![IO.Path]::IsPathFullyQualified($ExactZip)) { throw 'PACKAGE_APPROVAL_REQUIRED' }
    Assert-M2FaultPrivatePath $ExactZip
    # One bounded immutable byte snapshot under a read-only sharing lease. No extraction from a second open.
    $stream=[IO.File]::Open($ExactZip,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if($stream.Length -le 0 -or $stream.Length -gt $c.MaxZipBytes) { throw 'ZIP_SIZE_INVALID' }
        $bytes=[byte[]]::new([int]$stream.Length); $offset=0
        while($offset -lt $bytes.Length) { $read=$stream.Read($bytes,$offset,$bytes.Length-$offset); if($read -le 0) { throw 'ZIP_TRUNCATED' }; $offset+=$read }
        if($stream.ReadByte() -ne -1) { throw 'ZIP_CHANGED' }
    } finally { $stream.Dispose() }
    if((Get-M2FaultHash $bytes) -cne $ApprovedSha256) { throw 'ZIP_HASH_INVALID' }
    $memory=[IO.MemoryStream]::new($bytes,$false)
    $archive=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Read,$false)
    try {
        $payload=@{}; $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal); [long]$totalLength=0
        foreach($entry in $archive.Entries) {
            $totalLength+=$entry.Length; if($totalLength -gt $c.MaxZipBytes) { throw 'ZIP_TOTAL_EXPANSION_DENIED' }
            if(!$names.Add($entry.FullName) -or $entry.FullName -cnotin $c.Members -or $entry.Length -gt $c.MaxZipBytes -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -ne 0x8000) { throw 'ZIP_MEMBER_INVALID' }
            $inputStream=$entry.Open(); $output=[IO.MemoryStream]::new()
            try {
                $buffer=[byte[]]::new(8192)
                while(($read=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
                    if($output.Length+$read -gt $c.MaxZipBytes) { throw 'ZIP_MEMBER_OVERSIZE' }
                    $output.Write($buffer,0,$read)
                }
                if($output.Length -ne $entry.Length) { throw 'ZIP_MEMBER_LENGTH_INVALID' }
                $payload[$entry.FullName]=$output.ToArray()
            } finally { $inputStream.Dispose(); $output.Dispose() }
        }
        if($names.Count -ne $c.Members.Count) { throw 'ZIP_MEMBER_MISSING' }
        $manifest=ConvertFrom-M2FaultJson $payload['manifest.json']
        Assert-M2FaultKeys $manifest @('schema','files')
        if($manifest.schema -cne 'm2-a-fault-package-v1') { throw 'MANIFEST_SCHEMA_INVALID' }
        Assert-M2FaultKeys $manifest.files @($c.Members | Where-Object { $_ -ne 'manifest.json' })
        foreach($name in $manifest.files.Keys) {
            if($manifest.files[$name] -cnotmatch '^[0-9a-f]{64}$' -or (Get-M2FaultHash $payload[$name]) -cne $manifest.files[$name]) { throw 'MEMBER_HASH_INVALID' }
        }
        [pscustomobject]@{Sha256=$ApprovedSha256; Payload=$payload; Manifest=$manifest; ExactZip=[IO.Path]::GetFullPath($ExactZip)}
    } finally { $archive.Dispose(); $memory.Dispose() }
}
function Assert-M2FaultPrivatePath([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_DENIED' }
        $acl=Get-Acl -LiteralPath $cursor -ErrorAction Stop
        if($acl.Owner -notin @('BUILTIN\Administrators','NT AUTHORITY\SYSTEM')) { throw 'UNTRUSTED_OWNER' }
        foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            $writeMask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            if($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $writeMask) -ne 0 -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'NON_MANAGEMENT_WRITE_DENIED' }
        }
        $parent=[IO.Directory]::GetParent($cursor); if(!$parent) { break }; $cursor=$parent.FullName
    }
}
function Set-M2FaultPrivateAcl([string]$Path,[switch]$Directory,[switch]$Registry) {
    $acl=if($Registry) { [Security.AccessControl.RegistrySecurity]::new() } elseif($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true,$false)
    $admins=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); $acl.SetOwner($admins)
    foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
        $identity=[Security.Principal.SecurityIdentifier]::new($sid)
        if($Registry) { $rule=[Security.AccessControl.RegistryAccessRule]::new($identity,'FullControl','Allow') }
        elseif($Directory) { $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
        else { $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow') }
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}
function Initialize-M2FaultNative {
    if('M2FaultNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class M2FaultNative {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,int length,out int needed);
 [StructLayout(LayoutKind.Sequential,Pack=4)] public struct FileInfo { public uint attributes; public long creation; public long access; public long write; public uint volume; public uint sizeHigh; public uint sizeLow; public uint links; public uint indexHigh; public uint indexLow; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] public static extern int RegQueryInfoKey(IntPtr key,IntPtr name,IntPtr length,IntPtr reserved,IntPtr subkeys,IntPtr maxSubkey,IntPtr maxClass,IntPtr values,IntPtr maxValueName,IntPtr maxValueLength,IntPtr securityLength,out long lastWrite);
}
'@
}
function Get-M2FaultFileIdentity([string]$Path) {
    Initialize-M2FaultNative
    $handle=[M2FaultNative]::CreateFile($Path,0,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
    try {
        $info=[M2FaultNative+FileInfo]::new()
        if($handle.IsInvalid -or ![M2FaultNative]::GetFileInformationByHandle($handle,[ref]$info) -or ($info.attributes -band 0x400) -ne 0) { throw 'FILE_IDENTITY_UNAVAILABLE' }
        '{0}:{1}:{2}' -f $info.volume,$info.indexHigh,$info.indexLow
    } finally { $handle.Dispose() }
}
function Get-M2FaultPathEvidence([string]$Path) {
    Assert-M2FaultPrivatePath $Path
    $item=Get-Item -LiteralPath $Path -Force
    @{path=$Path;identity=Get-M2FaultFileIdentity $Path;dacl=(Get-Acl -LiteralPath $Path).Sddl;sha256=if($item.PSIsContainer){$null}else{Get-M2FaultHash ([IO.File]::ReadAllBytes($Path))}}
}
function Assert-M2FaultOwner([switch]$OwnerApproved) {
    if(!$OwnerApproved -or $env:COMPUTERNAME -cne (Get-M2FaultConstants).HostName) { throw 'OWNER_FIXED_HOST_APPROVAL_REQUIRED' }
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_OWNER_REQUIRED' }
}
function Assert-M2FaultVm {
    $c=Get-M2FaultConstants; $vm=Get-VM -Id $c.VmId -ErrorAction Stop
    if($vm.Name -cne $c.VmName -or $vm.ProcessorCount -ne 1 -or $vm.MemoryStartup -ne 2147483648 -or $vm.DynamicMemoryEnabled) { throw 'FIXED_VM_CONFIGURATION_INVALID' }
    $nics=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
    if($nics.Count -ne 1 -or $nics[0].SwitchId -ne [Guid]::Empty) { throw 'NIC_MUST_BE_DISCONNECTED' }
    $vm
}
function Get-M2FaultRegistryEvidence {
    $c=Get-M2FaultConstants; $path=$c.RegistryParent+'\'+$c.ServiceId
    $key=Get-Item -LiteralPath $path -ErrorAction Stop
    if(@($key.GetSubKeyNames()).Count -ne 0 -or (@($key.GetValueNames()) -join '|') -cne 'ElementName' -or $key.GetValue('ElementName') -cne $c.ElementName -or $key.GetValueKind('ElementName') -ne 'String') { throw 'SERVICE_GUID_COLLISION' }
    $acl=Get-Acl -LiteralPath $path
    if(!$acl.AreAccessRulesProtected -or $acl.Owner -notin @('BUILTIN\Administrators','NT AUTHORITY\SYSTEM')) { throw 'GUID_ACL_INVALID' }
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'GUID_ACL_INVALID' }
    }
    Initialize-M2FaultNative; [long]$lastWrite=0
    if([M2FaultNative]::RegQueryInfoKey($key.Handle.DangerousGetHandle(),[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[ref]$lastWrite) -ne 0) { throw 'GUID_IDENTITY_UNAVAILABLE' }
    @{path=$path;service_id=$c.ServiceId;element_name=$c.ElementName;dacl=$acl.Sddl;last_write_identity=$lastWrite}
}
function New-M2FaultProfile([string]$BridgeSha256) {
    $c=Get-M2FaultConstants
    @{schema='m2-a-fault-bridge-v1';vm_id=$c.VmId;service_id=$c.ServiceId;bridge_sha256=$BridgeSha256;request_ids=@{timeout='m2-fault-20261004-timeout-01';revoke='m2-fault-20261004-revoke-01';disconnect='m2-fault-20261004-disconnect-01'}}
}
function Assert-M2FaultProfile($Profile,[string]$BridgeSha256) {
    $expected=New-M2FaultProfile $BridgeSha256
    Assert-M2FaultKeys $Profile @($expected.Keys)
    Assert-M2FaultKeys $Profile.request_ids @('timeout','revoke','disconnect')
    foreach($key in @('schema','vm_id','service_id','bridge_sha256')) { if($Profile[$key] -cne $expected[$key]) { throw 'PROFILE_INVALID' } }
    foreach($key in $expected.request_ids.Keys) { if($Profile.request_ids[$key] -cne $expected.request_ids[$key]) { throw 'PROFILE_INVALID' } }
}
function Write-M2FaultNewFile([string]$Path,[byte[]]$Bytes) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Set-M2FaultPrivateAcl $Path
}
function Add-M2FaultAudit([string]$Stage,[hashtable]$Record) {
    Assert-M2FaultPrivatePath $Stage
    $file=Join-Path $Stage 'host-audit.jsonl'
    if(!(Test-Path -LiteralPath $file)) { Write-M2FaultNewFile $file ([byte[]]@()) }
    Assert-M2FaultPrivatePath $file
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Record|ConvertTo-Json -Compress -Depth 20)+"`n")
    $stream=[IO.File]::Open($file,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Install-M2FaultHost {
    [CmdletBinding()]param([Parameter(Mandatory)][string]$ExactZip,[Parameter(Mandatory)][string]$ApprovedSha256,[switch]$OwnerApproved)
    Assert-M2FaultOwner -OwnerApproved:$OwnerApproved
    $null=Assert-M2FaultVm; $c=Get-M2FaultConstants
    $package=Read-M2FaultPackage $ExactZip $ApprovedSha256
    Assert-M2FaultPrivatePath $c.Root
    $bridge=Join-Path $c.Root 'fault_bridge.py'; $profile=Join-Path $c.Root 'fault-profile.json'
    $stage=Join-Path $c.Root ('fault-stage-'+$ApprovedSha256)
    $guid=$c.RegistryParent+'\'+$c.ServiceId
    foreach($path in @($bridge,$profile,$stage,$guid)) { if(Test-Path -LiteralPath $path) { throw 'INSTALL_TARGET_COLLISION' } }
    # The parent ACL is evidence only; never rewritten.
    $parentDacl=(Get-Acl -LiteralPath $c.RegistryParent).Sddl
    $parentAcl=Get-Acl -LiteralPath $c.RegistryParent
    if($parentAcl.Owner -notin @('BUILTIN\Administrators','NT AUTHORITY\SYSTEM')) { throw 'REGISTRY_PARENT_OWNER_DENIED' }
    foreach($rule in $parentAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        $mask=[Security.AccessControl.RegistryRights]::WriteKey -bor [Security.AccessControl.RegistryRights]::Delete -bor [Security.AccessControl.RegistryRights]::ChangePermissions -bor [Security.AccessControl.RegistryRights]::TakeOwnership
        if($rule.AccessControlType -eq 'Allow' -and ($rule.RegistryRights -band $mask) -ne 0 -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'REGISTRY_PARENT_WRITE_DENIED' }
    }
    $null=[IO.Directory]::CreateDirectory($stage); Set-M2FaultPrivateAcl $stage -Directory
    # Persist intent before mutation. Partial failures remain visible; never erase evidence or retry deletion.
    Add-M2FaultAudit $stage @{schema='m2-a-fault-host-audit-v1';event='install-intent';package_sha256=$ApprovedSha256;targets=@($bridge,$profile,$guid);utc=[DateTime]::UtcNow.ToString('o')}
    Write-M2FaultNewFile $bridge $package.Payload['fault_bridge.py']
    $profileBytes=[Text.UTF8Encoding]::new($false).GetBytes(((New-M2FaultProfile $package.Manifest.files['fault_bridge.py'])|ConvertTo-Json -Depth 5)+"`n")
    Write-M2FaultNewFile $profile $profileBytes
    $null=New-Item -Path $guid -ErrorAction Stop
    Set-M2FaultPrivateAcl $guid -Registry
    $null=New-ItemProperty -LiteralPath $guid -Name ElementName -Value $c.ElementName -PropertyType String -ErrorAction Stop
    $receipt=@{schema='m2-a-fault-host-receipt-v1';package_sha256=$ApprovedSha256;exact_zip=$package.ExactZip;stage=$stage;root=Get-M2FaultPathEvidence $c.Root;stage_identity=Get-M2FaultFileIdentity $stage;stage_evidence=Get-M2FaultPathEvidence $stage;files=@((Get-M2FaultPathEvidence $bridge),(Get-M2FaultPathEvidence $profile));guid=Get-M2FaultRegistryEvidence;registry_parent_dacl=$parentDacl;utc=[DateTime]::UtcNow.ToString('o')}
    if((Get-Acl -LiteralPath $c.RegistryParent).Sddl -cne $parentDacl) { throw 'REGISTRY_PARENT_CHANGED' }
    Write-M2FaultNewFile (Join-Path $stage 'host-receipt.json') ([Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 20)+"`n"))
    Add-M2FaultAudit $stage @{event='install-complete';receipt_sha256=Get-M2FaultHash ([IO.File]::ReadAllBytes((Join-Path $stage 'host-receipt.json')));utc=[DateTime]::UtcNow.ToString('o')}
    $receipt
}
function Read-M2FaultReceipt([string]$ApprovedSha256,[string]$ApprovedReceiptSha256) {
    if($ApprovedSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ApprovedReceiptSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'RECEIPT_APPROVAL_REQUIRED' }
    $c=Get-M2FaultConstants; $stage=Join-Path $c.Root ('fault-stage-'+$ApprovedSha256); $path=Join-Path $stage 'host-receipt.json'
    Assert-M2FaultPrivatePath $path
    if((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'RECEIPT_OVERSIZE' }
    $bytes=[IO.File]::ReadAllBytes($path)
    if((Get-M2FaultHash $bytes) -cne $ApprovedReceiptSha256) { throw 'RECEIPT_HASH_INVALID' }
    $receipt=ConvertFrom-M2FaultJson $bytes
    Assert-M2FaultKeys $receipt @('schema','package_sha256','exact_zip','stage','root','stage_identity','stage_evidence','files','guid','registry_parent_dacl','utc')
    if($receipt.schema -cne 'm2-a-fault-host-receipt-v1' -or $receipt.package_sha256 -cne $ApprovedSha256 -or $receipt.stage -cne $stage -or $receipt.root.path -cne $c.Root -or $receipt.stage_identity -cne (Get-M2FaultFileIdentity $stage)) { throw 'RECEIPT_IDENTITY_INVALID' }
    if($receipt.root.identity -cne (Get-M2FaultFileIdentity $c.Root) -or $receipt.root.dacl -cne (Get-Acl -LiteralPath $c.Root).Sddl) { throw 'ROOT_IDENTITY_CHANGED' }
    $stageActual=Get-M2FaultPathEvidence $stage
    foreach($key in @('path','identity','dacl','sha256')) { if($stageActual[$key] -cne $receipt.stage_evidence[$key]) { throw 'STAGE_IDENTITY_CHANGED' } }
    $expectedPaths=@((Join-Path $c.Root 'fault_bridge.py'),(Join-Path $c.Root 'fault-profile.json'))
    if(@($receipt.files).Count -ne 2 -or (@($receipt.files.path|Sort-Object)-join '|') -cne (@($expectedPaths|Sort-Object)-join '|')) { throw 'RECEIPT_TARGETS_INVALID' }
    foreach($evidence in $receipt.files) {
        $actual=Get-M2FaultPathEvidence $evidence.path
        foreach($key in @('path','identity','dacl','sha256')) { if($actual[$key] -cne $evidence[$key]) { throw 'FILE_IDENTITY_CHANGED' } }
    }
    $actualGuid=Get-M2FaultRegistryEvidence
    foreach($key in @('path','service_id','element_name','dacl','last_write_identity')) { if($actualGuid[$key] -cne $receipt.guid[$key]) { throw 'GUID_IDENTITY_CHANGED' } }
    if((Get-Acl -LiteralPath $c.RegistryParent).Sddl -cne $receipt.registry_parent_dacl) { throw 'REGISTRY_PARENT_CHANGED' }
    Assert-M2FaultProfile (ConvertFrom-M2FaultJson ([IO.File]::ReadAllBytes((Join-Path $c.Root 'fault-profile.json')))) ($receipt.files|Where-Object path -CEQ (Join-Path $c.Root 'fault_bridge.py')).sha256
    $receipt
}
function Wait-M2FaultProcess {
    [CmdletBinding()]param([Parameter(Mandatory)]$Process,[int]$TimeoutMs=30000)
    # Internal process lifecycle primitive: tests supply harmless processes/delegates, never the bridge.
    if($TimeoutMs -le 0 -or $TimeoutMs -gt 30000) { throw 'PROCESS_BOUND_INVALID' }
    $exitCode=$null; $stdout=''; $stderr=''; $status='UNKNOWN'; $handle=$null
    try {
        $handle=$Process.Handle # Materialize and retain before any wait/ExitCode access.
        if(!$handle -or $handle -eq [IntPtr]::Zero) { throw 'PROCESS_HANDLE_UNKNOWN' }
        $outTask=$Process.StandardOutput.ReadToEndAsync(); $errTask=$Process.StandardError.ReadToEndAsync()
        if(!$Process.WaitForExit($TimeoutMs)) { throw 'PROCESS_TIMEOUT' }
        $raw=$Process.ExitCode
        if($null -eq $raw -or $raw -isnot [int]) { throw 'EXIT_CODE_UNKNOWN' }
        $exitCode=$raw
        if(!$outTask.Wait(1000) -or !$errTask.Wait(1000)) { throw 'PROCESS_STREAM_UNKNOWN' }
        $stdout=$outTask.Result; $stderr=$errTask.Result
        if($stdout.Length -gt 98304 -or $stderr.Length -gt 98304) { throw 'PROCESS_OUTPUT_OVERSIZE' }
        $status=if($exitCode -eq 0){'BRIDGE_EXITED_ZERO'}else{'BRIDGE_FAILED'}
    } catch { $status='UNKNOWN'; $stderr=$_.Exception.Message }
    [pscustomobject]@{bridge_status=$status;bridge_exit_code=$exitCode;stdout=$stdout;stderr=$stderr;execution_state='UNKNOWN';handle_materialized=($null -ne $handle)}
}
function Assert-M2FaultBatchOutput($Result) {
    if($Result.bridge_status -cne 'BRIDGE_EXITED_ZERO' -or $Result.bridge_exit_code -isnot [int] -or $Result.bridge_exit_code -ne 0) { throw 'BRIDGE_RESULT_UNKNOWN' }
    if([string]::IsNullOrWhiteSpace($Result.stdout) -or [string]::IsNullOrWhiteSpace($Result.stderr)) { throw 'BRIDGE_SUMMARY_OR_AUDIT_MISSING' }
    # Parse the entire stream as one JSON document. No selecting a final line after arbitrary output.
    $summary=ConvertFrom-M2FaultJson ([Text.Encoding]::UTF8.GetBytes($Result.stdout))
    Assert-M2FaultKeys $summary @('schema','qualification','batch_status','cases')
    if($summary.schema -cne 'm2-a-fault-batch-observation-v1' -or $summary.batch_status -cne 'OBSERVATIONS_COMPLETE' -or $summary.qualification -cne 'NOT_ISSUED') { throw 'BRIDGE_SUMMARY_INVALID' }
    if($summary.cases -isnot [array] -or $summary.cases.Count -ne 3) { throw 'BRIDGE_CASES_INVALID' }
    $cases=@('timeout','revoke','disconnect')
    for($index=0;$index -lt 3;$index++) {
        $row=$summary.cases[$index]; $case=$cases[$index]
        Assert-M2FaultKeys $row @('schema','case','request_id','qualification','scenario_status','execution_state','trigger_actual','stop_elapsed_seconds','trigger_to_observation_seconds','before','after','native_proof')
        if($row.schema -cne 'm2-a-fault-case-observation-v1' -or $row.case -cne $case -or $row.request_id -cne ('m2-fault-20261004-'+$case+'-01') -or $row.qualification -cne 'NOT_ISSUED' -or $row.scenario_status -cne 'CONFIRMED_OBSERVATIONS' -or $row.execution_state -cne 'STOPPED' -or $row.trigger_actual -cne $case) { throw 'BRIDGE_CASE_OBSERVATION_INVALID' }
        foreach($key in @('stop_elapsed_seconds','trigger_to_observation_seconds')) { Assert-M2FaultFiniteNumber $row[$key] 0 0.1 }
        Assert-M2FaultKeys $row.native_proof @('scope','cgroup_empty','leader_reaped','identity_unchanged')
        if($row.native_proof.scope -cne 'entire_cgroup') { throw 'BRIDGE_NATIVE_PROOF_INVALID' }
        foreach($key in @('cgroup_empty','leader_reaped','identity_unchanged')) { if($row.native_proof[$key] -isnot [bool] -or $row.native_proof[$key] -ne $true) { throw 'BRIDGE_NATIVE_PROOF_INVALID' } }
        foreach($observation in @($row.before,$row.after)) {
            Assert-M2FaultKeys $observation @('binding','members','tracked','complete','reason')
            if($observation.complete -isnot [bool] -or !$observation.complete -or $observation.reason -cne '' -or $observation.members -isnot [array] -or $observation.tracked -isnot [array]) { throw 'BRIDGE_MEMBER_OBSERVATION_INVALID' }
        }
        if($row.before.members.Count -lt 2 -or $row.before.tracked.Count -ne 0 -or $row.after.tracked.Count -ne $row.before.members.Count) { throw 'BRIDGE_MEMBER_OBSERVATION_INVALID' }
    }
    $audit=ConvertFrom-M2FaultJson ([Text.Encoding]::UTF8.GetBytes($Result.stderr))
    Assert-M2FaultKeys $audit @('host_events','qualification')
    if($audit.qualification -cne 'NOT_ISSUED' -or $audit.host_events -isnot [array] -or $audit.host_events.Count -ne 2) { throw 'BRIDGE_HOST_AUDIT_INVALID' }
    $eventCases=@('revoke','disconnect'); $eventActions=@('revoke-sent','actual-socket-close'); $previous=-1.0
    for($index=0;$index -lt 2;$index++) {
        $event=$audit.host_events[$index]; Assert-M2FaultKeys $event @('case','host_monotonic','action')
        if($event.case -cne $eventCases[$index] -or $event.action -cne $eventActions[$index]) { throw 'BRIDGE_HOST_AUDIT_INVALID' }
        Assert-M2FaultFiniteNumber $event.host_monotonic 0 ([double]::PositiveInfinity)
        if([double]$event.host_monotonic -lt $previous) { throw 'BRIDGE_HOST_AUDIT_CLOCK_INVALID' }; $previous=[double]$event.host_monotonic
    }
    $Result|Add-Member -NotePropertyName host_audit -NotePropertyValue $audit -Force
    $summary
}
function Assert-M2FaultFiniteNumber($Value,[double]$Minimum,[double]$MaximumExclusive) {
    if($Value -isnot [int] -and $Value -isnot [long] -and $Value -isnot [double] -and $Value -isnot [decimal]) { throw 'BRIDGE_NUMBER_TYPE_INVALID' }
    $number=[double]$Value
    if([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $Minimum -or $number -ge $MaximumExclusive) { throw 'BRIDGE_NUMBER_BOUND_INVALID' }
}
function Invoke-M2FaultHost {
    [CmdletBinding()]param([Parameter(Mandatory)][string]$ApprovedSha256,[Parameter(Mandatory)][string]$ApprovedReceiptSha256,[switch]$OwnerApproved)
    Assert-M2FaultOwner -OwnerApproved:$OwnerApproved; $null=Assert-M2FaultVm
    $receipt=Read-M2FaultReceipt $ApprovedSha256 $ApprovedReceiptSha256; $c=Get-M2FaultConstants
    Assert-M2FaultPrivatePath $c.Python
    $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$c.Python
    foreach($flag in @('-B','-I','-S')) { $psi.ArgumentList.Add($flag) }
    $psi.ArgumentList.Add((Join-Path $c.Root 'fault_bridge.py')); $psi.ArgumentList.Add('--run-fixed-batch')
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$psi; $started=$false
    try {
        $started=$process.Start(); if(!$started) { throw 'BRIDGE_START_FAILED' }; $result=Wait-M2FaultProcess $process $c.TimeoutMs
        if($result.bridge_status -eq 'BRIDGE_EXITED_ZERO') {
            try { $summary=Assert-M2FaultBatchOutput $result; $result|Add-Member -NotePropertyName batch_observation -NotePropertyValue $summary }
            catch { $result.bridge_status='UNKNOWN'; $result|Add-Member -NotePropertyName validation_error -NotePropertyValue $_.Exception.Message }
        }
    } finally {
        if($started -and !$process.HasExited) { $process.Kill(); $null=$process.WaitForExit(1000) }
        $process.Dispose()
    }
    Add-M2FaultAudit $receipt.stage @{event='bridge-run';result=$result;utc=[DateTime]::UtcNow.ToString('o')}
    $result # Transport exit never establishes guest STOPPED; inspect independent guest summary.
}
function Remove-M2FaultHost {
    [CmdletBinding()]param([Parameter(Mandatory)][string]$ApprovedSha256,[Parameter(Mandatory)][string]$ApprovedReceiptSha256,[switch]$OwnerApproved)
    Assert-M2FaultOwner -OwnerApproved:$OwnerApproved; $null=Assert-M2FaultVm
    $receipt=Read-M2FaultReceipt $ApprovedSha256 $ApprovedReceiptSha256
    Add-M2FaultAudit $receipt.stage @{event='cleanup-intent';utc=[DateTime]::UtcNow.ToString('o')}
    # Validate every target before the first deletion. Retain stage, receipt/audit, ledger and parent ACL.
    foreach($file in $receipt.files) { Remove-Item -LiteralPath $file.path -Force -ErrorAction Stop }
    Remove-Item -LiteralPath $receipt.guid.path -ErrorAction Stop # no recursion: subkeys were forbidden
    $remaining=@($receipt.files.path)+@($receipt.guid.path)|Where-Object { Test-Path -LiteralPath $_ }
    if(@($remaining).Count -ne 0 -or (Get-Acl -LiteralPath (Get-M2FaultConstants).RegistryParent).Sddl -cne $receipt.registry_parent_dacl) { throw 'CLEANUP_POSTASSERT_FAILED_NO_RETRY' }
    Add-M2FaultAudit $receipt.stage @{event='cleanup-read-post-confirmed';utc=[DateTime]::UtcNow.ToString('o')}
    [pscustomobject]@{status='CLEANUP_READ_POST_CONFIRMED';stage_retained=$receipt.stage;dvd_changed=$false}
}
function Get-M2FaultWindowObservation([long]$WindowHandle) {
    Initialize-M2FaultNative
    $window=[IntPtr]$WindowHandle; [uint32]$windowPid=0; $thread=[M2FaultNative]::GetWindowThreadProcessId($window,[ref]$windowPid)
    if(!$thread -or !$windowPid) { throw 'WINDOW_MISSING' }
    $process=Get-Process -Id $windowPid -ErrorAction Stop
    $title=[Text.StringBuilder]::new(512); $null=[M2FaultNative]::GetWindowText($window,$title,$title.Capacity)
    $desktop=[Text.StringBuilder]::new(256); [int]$needed=0
    if(![M2FaultNative]::GetUserObjectInformation([M2FaultNative]::GetThreadDesktop($thread),2,$desktop,512,[ref]$needed)) { throw 'DESKTOP_UNKNOWN' }
    $foreground=[M2FaultNative]::GetForegroundWindow(); [uint32]$foregroundPid=0
    $null=[M2FaultNative]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid)
    @{hwnd=$WindowHandle;pid=[int]$windowPid;process_name=$process.ProcessName;process_start_utc=$process.StartTime.ToUniversalTime().Ticks;session_id=$process.SessionId;desktop=$desktop.ToString();title=$title.ToString();foreground_hwnd=$foreground.ToInt64();foreground_pid=[int]$foregroundPid}
}
function Assert-M2FaultWindowBinding($Binding,$Observation,[switch]$RequireForeground) {
    Assert-M2FaultKeys $Binding @('hwnd','pid','process_name','process_start_utc','session_id','desktop','title')
    if($Binding.process_name -cne 'vmconnect' -or $Binding.title -cne 'm2-isolation-probe on DESK-W-591 - Virtual Machine Connection' -or $Binding.hwnd -le 0 -or $Binding.pid -le 0 -or $Binding.process_start_utc -le 0 -or $Binding.session_id -lt 0 -or !$Binding.desktop) { throw 'FIXED_WINDOW_BINDING_INVALID' }
    foreach($key in $Binding.Keys) { if($Observation[$key] -cne $Binding[$key]) { throw 'WINDOW_IDENTITY_CHANGED' } }
    if($RequireForeground -and ($Observation.foreground_hwnd -ne $Binding.hwnd -or $Observation.foreground_pid -ne $Binding.pid)) { throw 'WINDOW_NOT_FOREGROUND' }
}
function Set-M2FaultBoundForeground {
    [CmdletBinding()]param([Parameter(Mandatory)]$Binding,[scriptblock]$Observe={param($hwnd) Get-M2FaultWindowObservation $hwnd},[scriptblock]$DirectSet={param($hwnd) Initialize-M2FaultNative; [M2FaultNative]::SetForegroundWindow([IntPtr]$hwnd)})
    $before=& $Observe $Binding.hwnd; Assert-M2FaultWindowBinding $Binding $before
    $called=$false; $returned=$null
    if($before.foreground_hwnd -ne $Binding.hwnd -or $before.foreground_pid -ne $Binding.pid) { $called=$true; $returned=& $DirectSet $Binding.hwnd }
    $after=& $Observe $Binding.hwnd; Assert-M2FaultWindowBinding $Binding $after -RequireForeground
    @{direct_set_called=$called;direct_set_return=$returned;before=$before;after=$after}
}
function Get-M2FaultUtcNow { [DateTimeOffset]::UtcNow }
function Assert-M2FaultRootConfirmation($Binding,$Observation,$Screenshot,$OwnerConfirmation) {
    Assert-M2FaultWindowBinding $Binding $Observation -RequireForeground
    # Screenshot bytes and capture metadata are actual capture output, never a title/root-name inference.
    Assert-M2FaultKeys $Screenshot @('bytes','captured_utc','binding')
    Assert-M2FaultKeys $OwnerConfirmation @('approved','screenshot_sha256','captured_utc','binding')
    $captured=[DateTimeOffset]::Parse($Screenshot.captured_utc,[Globalization.CultureInfo]::InvariantCulture)
    $age=((Get-M2FaultUtcNow)-$captured).TotalSeconds
    if($Screenshot.bytes -isnot [byte[]] -or $Screenshot.bytes.Length -eq 0 -or $age -lt 0 -or $age -gt 30 -or $OwnerConfirmation.approved -ne $true -or $OwnerConfirmation.screenshot_sha256 -cne (Get-M2FaultHash $Screenshot.bytes) -or $OwnerConfirmation.captured_utc -cne $Screenshot.captured_utc) { throw 'FRESH_OWNER_ROOT_CONFIRMATION_REQUIRED' }
    Assert-M2FaultKeys $Screenshot.binding @($Binding.Keys); Assert-M2FaultKeys $OwnerConfirmation.binding @($Binding.Keys)
    foreach($key in $Binding.Keys) { if($Screenshot.binding[$key] -cne $Binding[$key] -or $OwnerConfirmation.binding[$key] -cne $Binding[$key]) { throw 'ROOT_CONFIRMATION_BINDING_CHANGED' } }
}
function Get-M2FaultBoundScreenshot {
    [CmdletBinding()]param([Parameter(Mandatory)]$Binding)
    $before=Get-M2FaultWindowObservation $Binding.hwnd; Assert-M2FaultWindowBinding $Binding $before -RequireForeground
    Initialize-M2FaultNative; Add-Type -AssemblyName System.Drawing
    $rect=[M2FaultNative+Rect]::new()
    if(![M2FaultNative]::GetWindowRect([IntPtr]$Binding.hwnd,[ref]$rect) -or $rect.right -le $rect.left -or $rect.bottom -le $rect.top) { throw 'SCREENSHOT_RECT_INVALID' }
    $bitmap=[Drawing.Bitmap]::new($rect.right-$rect.left,$rect.bottom-$rect.top)
    $graphics=[Drawing.Graphics]::FromImage($bitmap); $stream=[IO.MemoryStream]::new()
    try {
        $graphics.CopyFromScreen($rect.left,$rect.top,0,0,$bitmap.Size)
        $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
        $after=Get-M2FaultWindowObservation $Binding.hwnd; Assert-M2FaultWindowBinding $Binding $after -RequireForeground
        @{bytes=$stream.ToArray();captured_utc=[DateTime]::UtcNow.ToString('o');binding=$Binding.Clone()}
    } finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
}
function Send-M2FaultFixedGuestCommand {
    [CmdletBinding()]param([Parameter(Mandatory)]$Binding,[Parameter(Mandatory)]$Screenshot,[Parameter(Mandatory)]$OwnerConfirmation,[switch]$Summarize,[scriptblock]$Observe={param($hwnd) Get-M2FaultWindowObservation $hwnd},[scriptblock]$SendKey={param($key) Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.SendKeys]::SendWait($key)})
    $observation=& $Observe $Binding.hwnd
    Assert-M2FaultRootConfirmation $Binding $observation $Screenshot $OwnerConfirmation
    $c=Get-M2FaultConstants; $command=if($Summarize){$c.GuestSummary}else{$c.GuestRun}
    foreach($character in $command.ToCharArray()) {
        $before=& $Observe $Binding.hwnd; Assert-M2FaultRootConfirmation $Binding $before $Screenshot $OwnerConfirmation
        $key=[string]$character; if($key -in @('+','^','%','~','(',')','[',']','{','}')) { $key='{'+$key+'}' }
        & $SendKey $key
        $after=& $Observe $Binding.hwnd; Assert-M2FaultWindowBinding $Binding $after -RequireForeground
    }
    $before=& $Observe $Binding.hwnd; Assert-M2FaultRootConfirmation $Binding $before $Screenshot $OwnerConfirmation
    & $SendKey '{ENTER}'
    $after=& $Observe $Binding.hwnd; Assert-M2FaultWindowBinding $Binding $after -RequireForeground
}
if($MyInvocation.InvocationName -ne '.') { throw 'DEFAULT_DENY: dot-source for trusted Owner fixed-management functions; no CLI or Agent mode.' }
