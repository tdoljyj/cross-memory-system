#requires -Version 7.2
# Trusted Owner management only. Dot-source defines functions; direct invocation denies.
# No Agent command/root/role surface. Installation and real window use need separate approval.
function Get-M2FaultConstants {
    [pscustomobject]@{
        VmId='9d775385-4546-4450-a77f-08cdf4f696b6'; VmName='m2-isolation-probe'; HostName='DESK-W-591'
        Anchor='C:\Program Files\CluedM2Fault'; Root='C:\Program Files\CluedM2Fault\host-a'
        Runtime='C:\Program Files\CluedM2Fault\python-3.14.8-amd64'; Python='C:\Program Files\CluedM2Fault\python-3.14.8-amd64\python.exe'
        RuntimeSha256='a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310'
        RuntimeArchive='python-3.14.8-embed-amd64.zip'; RuntimeDirectory='python-3.14.8-amd64'
        ServiceId='0000ac45-facb-11e6-bd58-64006a7986d3'
        RegistryParent='HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices'
        ElementName='Clued M2 A Empty Probe'; TimeoutMs=30000; MaxZipBytes=2097152
        Members=@('base-a.zip','fault_fixture.py','fault_observer.py','management.py','fault_bridge.py','host-helper.ps1','fault-installer.py','fault-plan.json','manifest.json')
        GuestRun='/usr/bin/python3 -B -I -S /usr/local/lib/clued-m2-a-fault-fixture/management.py --run-fixed-batch'
        GuestSummary='/usr/bin/python3 -B -I -S /usr/local/lib/clued-m2-a-fault-fixture/management.py --summarize-fixed-batch'
    }
}
function Get-M2FaultHash([byte[]]$Bytes) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Get-M2FaultRuntimeMembers {
    @('python.exe','pythonw.exe','python314.dll','python3.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt','pyexpat.pyd','select.pyd','unicodedata.pyd','winsound.pyd','_asyncio.pyd','_bz2.pyd','_ctypes.pyd','_decimal.pyd','_elementtree.pyd','_hashlib.pyd','_lzma.pyd','_multiprocessing.pyd','_overlapped.pyd','_queue.pyd','_remote_debugging.pyd','_socket.pyd','_sqlite3.pyd','_ssl.pyd','_uuid.pyd','_wmi.pyd','_zoneinfo.pyd','_zstd.pyd','libcrypto-3.dll','libffi-8.dll','libssl-3.dll','libtommath.dll','sqlite3.dll','python314.zip','python314._pth','python.cat')
}
function Read-M2FaultImmutableSnapshot([string]$Path,[string]$Sha256,[int]$MaximumBytes) {
    if($Sha256 -cnotmatch '^[0-9a-f]{64}$' -or ![IO.Path]::IsPathFullyQualified($Path)) { throw 'SOURCE_APPROVAL_REQUIRED' }
    if(((Get-Item -LiteralPath $Path -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SOURCE_REPARSE_DENIED' }
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if($stream.Length -le 0 -or $stream.Length -gt $MaximumBytes) { throw 'SOURCE_SIZE_INVALID' }
        $bytes=[byte[]]::new([int]$stream.Length); $offset=0
        while($offset -lt $bytes.Length) { $read=$stream.Read($bytes,$offset,$bytes.Length-$offset); if($read -le 0) { throw 'SOURCE_TRUNCATED' }; $offset+=$read }
        if($stream.ReadByte() -ne -1 -or (Get-M2FaultHash $bytes) -cne $Sha256) { throw 'SOURCE_HASH_INVALID' }
        return ,$bytes
    } finally { $stream.Dispose() }
}
function Expand-M2FaultClosedZip([byte[]]$Bytes,[string[]]$Members,[int]$MaximumExpandedBytes) {
    $memory=[IO.MemoryStream]::new($Bytes,$false); $archive=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Read,$false)
    try {
        $payload=@{}; $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal); [long]$total=0
        foreach($entry in $archive.Entries) {
            $total+=$entry.Length
            $mode=($entry.ExternalAttributes -shr 16) -band 0xF000
            # Official Windows archive regular entries have Unix regular modes. No directories, symlinks or extras.
            if(!$seen.Add($entry.FullName) -or $entry.FullName -cnotin $Members -or $entry.Length -lt 0 -or $total -gt $MaximumExpandedBytes -or $mode -ne 0x8000) { throw 'RUNTIME_ZIP_MEMBER_INVALID' }
            $inputStream=$entry.Open(); $output=[IO.MemoryStream]::new()
            try {
                $buffer=[byte[]]::new(8192)
                while(($read=$inputStream.Read($buffer,0,$buffer.Length)) -gt 0) { if($output.Length+$read -gt $entry.Length) { throw 'RUNTIME_ZIP_MEMBER_LENGTH_INVALID' }; $output.Write($buffer,0,$read) }
                if($output.Length -ne $entry.Length) { throw 'RUNTIME_ZIP_MEMBER_LENGTH_INVALID' }
                $payload[$entry.FullName]=$output.ToArray()
            } finally { $inputStream.Dispose(); $output.Dispose() }
        }
        if($seen.Count -ne $Members.Count) { throw 'RUNTIME_ZIP_MEMBER_MISSING' }
        $payload
    } finally { $archive.Dispose(); $memory.Dispose() }
}
function Assert-M2FaultRuntimeManifest($Manifest) {
    $c=Get-M2FaultConstants
    Assert-M2FaultKeys $Manifest @('schema','archive_sha256','runtime_directory','files')
    if($Manifest.schema -cne 'm2-a-fault-runtime-v1' -or $Manifest.archive_sha256 -cne $c.RuntimeSha256 -or $Manifest.runtime_directory -cne $c.RuntimeDirectory) { throw 'RUNTIME_MANIFEST_INVALID' }
    Assert-M2FaultKeys $Manifest.files (Get-M2FaultRuntimeMembers)
    foreach($name in $Manifest.files.Keys) { if($Manifest.files[$name] -isnot [string] -or $Manifest.files[$name] -cnotmatch '^[0-9a-f]{64}$') { throw 'RUNTIME_MANIFEST_HASH_INVALID' } }
}
function Read-M2FaultRuntimePackage([string]$RuntimePackage,[string]$ApprovedRuntimePackageSha256) {
    $c=Get-M2FaultConstants
    $bytes=Read-M2FaultImmutableSnapshot $RuntimePackage $ApprovedRuntimePackageSha256 18874368
    $outer=Expand-M2FaultClosedZip $bytes @($c.RuntimeArchive,'runtime-manifest.json') 18874368
    $manifest=ConvertFrom-M2FaultJson $outer['runtime-manifest.json']; Assert-M2FaultRuntimeManifest $manifest
    if((Get-M2FaultHash $outer[$c.RuntimeArchive]) -cne $c.RuntimeSha256) { throw 'OFFICIAL_RUNTIME_ARCHIVE_HASH_INVALID' }
    $files=Expand-M2FaultClosedZip $outer[$c.RuntimeArchive] (Get-M2FaultRuntimeMembers) 67108864
    foreach($name in $files.Keys) { if((Get-M2FaultHash $files[$name]) -cne $manifest.files[$name]) { throw 'RUNTIME_MEMBER_HASH_INVALID' } }
    [pscustomobject]@{sha256=$ApprovedRuntimePackageSha256;manifest=$manifest;manifest_bytes=$outer['runtime-manifest.json'];files=$files}
}
function Assert-M2FaultInstalledRuntime($Manifest) {
    Assert-M2FaultRuntimeManifest $Manifest
    $c=Get-M2FaultConstants; Assert-M2FaultPrivatePath $c.Runtime
    $children=@(Get-ChildItem -LiteralPath $c.Runtime -Force -ErrorAction Stop)
    if((@($children.Name|Sort-Object)-join '|') -cne (@((Get-M2FaultRuntimeMembers)|Sort-Object)-join '|')) { throw 'RUNTIME_INSTALLED_CLOSED_MEMBERS_INVALID' }
    foreach($item in $children) {
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RUNTIME_INSTALLED_REPARSE_OR_DIRECTORY' }
        $actual=Get-M2FaultPathEvidence $item.FullName
        if($actual.sha256 -cne $Manifest.files[$item.Name]) { throw 'RUNTIME_INSTALLED_HASH_INVALID' }
    }
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
    if(((Get-Item -LiteralPath $ExactZip -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SOURCE_REPARSE_DENIED' }
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
function Get-M2FaultManagementSids { @('S-1-5-18','S-1-5-32-544') }
function Get-M2FaultServicingSid { 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' }
function Assert-M2FaultPathAcl([string]$Path,$Acl) {
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\'); if($full -ceq 'C:') { $full='C:\' }
    $c=Get-M2FaultConstants; $osAncestor=$full -cin @('C:\','C:\Program Files','C:\Windows','C:\Windows\System32')
    $protectedTarget=$full -ceq $c.Anchor -or $full.StartsWith($c.Anchor+'\',[StringComparison]::Ordinal)
    if(!$osAncestor -and !$protectedTarget) { throw 'PATH_OUTSIDE_FIXED_ANCHOR' }
    $management=@(Get-M2FaultManagementSids); $trusted=@($management)
    if($osAncestor) { $trusted+=Get-M2FaultServicingSid }
    $owner=$Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if($owner -cnotin $trusted -or (!$osAncestor -and !$Acl.AreAccessRulesProtected)) { throw 'UNTRUSTED_OWNER_OR_INHERITED_TARGET_DACL' }
    foreach($rule in $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        # An inherit-only ACE is not effective on this object. Descendants are checked independently.
        if($rule.AccessControlType -ne 'Allow' -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -or $rule.IdentityReference.Value -cin $trusted) { continue }
        $mask=[long]$rule.FileSystemRights
        # Raw generic access bits may not intersect the enum's low write/delete mask.
        if(($mask -band 0x50000000L) -ne 0) { throw 'NON_MANAGEMENT_GENERIC_MUTATION_DENIED' }
        $forbidden=[long]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
        if($full -ceq 'C:\') { $forbidden=$forbidden -band (-bnot [long][Security.AccessControl.FileSystemRights]::CreateDirectories) }
        if(($mask -band $forbidden) -ne 0) { throw 'NON_MANAGEMENT_EFFECTIVE_PATH_MUTATION_DENIED' }
    }
}
function Assert-M2FaultPrivatePath([string]$Path) {
    $cursor=[IO.Path]::GetFullPath($Path)
    while($cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_PATH_DENIED' }
        $acl=Get-Acl -LiteralPath $cursor -ErrorAction Stop
        Assert-M2FaultPathAcl $cursor $acl
        $parent=[IO.Directory]::GetParent($cursor); if(!$parent) { break }; $cursor=$parent.FullName
    }
}
function Initialize-M2FaultNative {
    if('M2FaultNative' -as [type]) { if([M2FaultNative]::RuntimeSecurityVersion -cne 'm2-atomic-runtime-v1') { throw 'NATIVE_HELPER_TYPE_COLLISION' }; return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class M2FaultNative {
 public const string RuntimeSecurityVersion="m2-atomic-runtime-v1";
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
 [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inheritHandle; }
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool CreateDirectory(string path,ref SecurityAttributes security);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool RemoveDirectory(string path);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,ref SecurityAttributes security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetDllDirectory(uint size,StringBuilder path);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] private static extern int RegCreateKeyEx(IntPtr root,string subkey,uint reserved,string cls,uint options,uint access,ref SecurityAttributes security,out IntPtr key,out uint disposition);
 [DllImport("advapi32.dll")] private static extern int RegCloseKey(IntPtr key);
 private static SecurityAttributes Security(string sddl) { IntPtr descriptor; uint size; if(!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1,out descriptor,out size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)),descriptor=descriptor,inheritHandle=false }; }
 public static void CreateProtectedDirectory(string path) { var security=Security("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"); try { if(!CreateDirectory(path,ref security)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); } finally { LocalFree(security.descriptor); } }
 public static void RemoveEmptyDirectory(string path) { if(!RemoveDirectory(path)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static SafeFileHandle CreateProtectedFile(string path) { var security=Security("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"); try { var handle=CreateFile(path,0x40000000,0,ref security,1,0x00200080,IntPtr.Zero); if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new System.ComponentModel.Win32Exception(error); } return handle; } finally { LocalFree(security.descriptor); } }
 public static void CreateProtectedServiceKey() { var security=Security("O:BAG:BAD:P(A;;KA;;;SY)(A;;KA;;;BA)"); IntPtr key=IntPtr.Zero; try { uint disposition; int error=RegCreateKeyEx(new IntPtr(unchecked((int)0x80000002)),"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Virtualization\\GuestCommunicationServices\\0000ac45-facb-11e6-bd58-64006a7986d3",0,null,0,0xF003F,ref security,out key,out disposition); if(error!=0) throw new System.ComponentModel.Win32Exception(error); if(disposition!=1) throw new InvalidOperationException("SERVICE_GUID_COLLISION"); } finally { if(key!=IntPtr.Zero) RegCloseKey(key); LocalFree(security.descriptor); } }
 public static string InheritedDllDirectory() { var path=new StringBuilder(32768); uint count=GetDllDirectory((uint)path.Capacity,path); if(count>=path.Capacity) throw new InvalidOperationException("DLL_DIRECTORY_UNBOUNDED"); if(count==0 && Marshal.GetLastWin32Error()!=0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); return path.ToString(); }
}
'@
}
function Get-M2FaultFileIdentity([string]$Path) {
    Initialize-M2FaultNative
    $handle=[M2FaultNative]::CreateFile($Path,0,1,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
    try {
        $info=[M2FaultNative+FileInfo]::new()
        if($handle.IsInvalid -or ![M2FaultNative]::GetFileInformationByHandle($handle,[ref]$info) -or ($info.attributes -band 0x400) -ne 0 -or (($info.attributes -band 0x10) -eq 0 -and $info.links -ne 1)) { throw 'FILE_IDENTITY_UNAVAILABLE_OR_HARDLINK' }
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
    if(!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin (Get-M2FaultManagementSids)) { throw 'GUID_ACL_INVALID' }
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and $rule.IdentityReference.Value -cnotin (Get-M2FaultManagementSids)) { throw 'GUID_ACL_INVALID' }
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
    Assert-M2FaultPrivatePath ([IO.Path]::GetDirectoryName($Path))
    Initialize-M2FaultNative; $handle=[M2FaultNative]::CreateProtectedFile($Path)
    $stream=[IO.FileStream]::new($handle,[IO.FileAccess]::Write)
    try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Assert-M2FaultPrivatePath $Path; $null=Get-M2FaultFileIdentity $Path
}
function New-M2FaultPrivateDirectory([string]$Path) {
    $c=Get-M2FaultConstants
    if($Path -cne $c.Anchor -and !$Path.StartsWith($c.Anchor+'\',[StringComparison]::Ordinal)) { throw 'DIRECTORY_OUTSIDE_FIXED_ANCHOR' }
    Assert-M2FaultPrivatePath ([IO.Path]::GetDirectoryName($Path))
    Initialize-M2FaultNative; [M2FaultNative]::CreateProtectedDirectory($Path)
    Assert-M2FaultPrivatePath $Path
}
function Remove-M2FaultRuntimeDirectory {
    $c=Get-M2FaultConstants; Assert-M2FaultPrivatePath $c.Runtime
    Initialize-M2FaultNative; [M2FaultNative]::RemoveEmptyDirectory($c.Runtime)
}
function Add-M2FaultAudit([string]$Stage,[hashtable]$Record) {
    Assert-M2FaultPrivatePath $Stage
    $file=Join-Path $Stage 'host-audit.jsonl'
    if(!(Test-Path -LiteralPath $file)) { Write-M2FaultNewFile $file ([byte[]]@()) }
    Assert-M2FaultPrivatePath $file
    $null=Get-M2FaultFileIdentity $file
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Record|ConvertTo-Json -Compress -Depth 20)+"`n")
    $stream=[IO.File]::Open($file,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Install-M2FaultHost {
    [CmdletBinding()]param([Parameter(Mandatory)][Alias('SourceFaultPackage')][string]$ExactZip,[Parameter(Mandatory)][string]$ApprovedSha256,[Parameter(Mandatory)][string]$RuntimePackage,[Parameter(Mandatory)][string]$ApprovedRuntimePackageSha256,[switch]$OwnerApproved)
    Assert-M2FaultOwner -OwnerApproved:$OwnerApproved
    $null=Assert-M2FaultVm; $c=Get-M2FaultConstants
    $package=Read-M2FaultPackage $ExactZip $ApprovedSha256
    $runtime=Read-M2FaultRuntimePackage $RuntimePackage $ApprovedRuntimePackageSha256
    foreach($path in @('C:\Program Files','C:\Windows','C:\Windows\System32')) { Assert-M2FaultPrivatePath $path }
    $bridge=Join-Path $c.Root 'fault_bridge.py'; $profile=Join-Path $c.Root 'fault-profile.json'
    $stage=Join-Path $c.Root ('fault-stage-'+$ApprovedSha256)
    $guid=$c.RegistryParent+'\'+$c.ServiceId
    foreach($path in @($c.Anchor,$guid)) { if(Test-Path -LiteralPath $path) { throw 'INSTALL_TARGET_COLLISION' } }
    # The parent ACL is evidence only; never rewritten.
    $parentDacl=(Get-Acl -LiteralPath $c.RegistryParent).Sddl
    $parentAcl=Get-Acl -LiteralPath $c.RegistryParent
    if($parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cnotin (Get-M2FaultManagementSids)) { throw 'REGISTRY_PARENT_OWNER_DENIED' }
    foreach($rule in $parentAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        $mask=[Security.AccessControl.RegistryRights]::WriteKey -bor [Security.AccessControl.RegistryRights]::Delete -bor [Security.AccessControl.RegistryRights]::ChangePermissions -bor [Security.AccessControl.RegistryRights]::TakeOwnership
        if($rule.AccessControlType -eq 'Allow' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.RegistryRights -band $mask) -ne 0 -and $rule.IdentityReference.Value -cnotin (Get-M2FaultManagementSids)) { throw 'REGISTRY_PARENT_WRITE_DENIED' }
    }
    foreach($directory in @($c.Anchor,$c.Root,$stage,$c.Runtime,(Join-Path $c.Anchor 'temp'))) { New-M2FaultPrivateDirectory $directory }
    # Persist intent before mutation. Partial failures remain visible; never erase evidence or retry deletion.
    Add-M2FaultAudit $stage @{schema='m2-a-fault-host-audit-v1';event='install-intent';package_sha256=$ApprovedSha256;runtime_package_sha256=$ApprovedRuntimePackageSha256;targets=@($bridge,$profile,$guid,$c.Runtime);utc=[DateTime]::UtcNow.ToString('o')}
    foreach($name in Get-M2FaultRuntimeMembers) { Write-M2FaultNewFile (Join-Path $c.Runtime $name) $runtime.files[$name] }
    Write-M2FaultNewFile (Join-Path $c.Root 'runtime-manifest.json') $runtime.manifest_bytes
    Assert-M2FaultInstalledRuntime $runtime.manifest
    Write-M2FaultNewFile $bridge $package.Payload['fault_bridge.py']
    $profileBytes=[Text.UTF8Encoding]::new($false).GetBytes(((New-M2FaultProfile $package.Manifest.files['fault_bridge.py'])|ConvertTo-Json -Depth 5)+"`n")
    Write-M2FaultNewFile $profile $profileBytes
    Initialize-M2FaultNative; [M2FaultNative]::CreateProtectedServiceKey()
    $null=New-ItemProperty -LiteralPath $guid -Name ElementName -Value $c.ElementName -PropertyType String -ErrorAction Stop
    $receipt=@{schema='m2-a-fault-host-receipt-v2';package_sha256=$ApprovedSha256;runtime_package_sha256=$ApprovedRuntimePackageSha256;exact_zip=$package.ExactZip;stage=$stage;anchor=Get-M2FaultPathEvidence $c.Anchor;root=Get-M2FaultPathEvidence $c.Root;temp=Get-M2FaultPathEvidence (Join-Path $c.Anchor 'temp');runtime_directory=Get-M2FaultPathEvidence $c.Runtime;runtime_files=@(foreach($name in Get-M2FaultRuntimeMembers){Get-M2FaultPathEvidence (Join-Path $c.Runtime $name)});os_dependencies=@((Get-M2FaultPathEvidence 'C:\Windows'),(Get-M2FaultPathEvidence 'C:\Windows\System32'));stage_identity=Get-M2FaultFileIdentity $stage;stage_evidence=Get-M2FaultPathEvidence $stage;files=@((Get-M2FaultPathEvidence $bridge),(Get-M2FaultPathEvidence $profile),(Get-M2FaultPathEvidence (Join-Path $c.Root 'runtime-manifest.json')));guid=Get-M2FaultRegistryEvidence;registry_parent_dacl=$parentDacl;utc=[DateTime]::UtcNow.ToString('o')}
    if((Get-Acl -LiteralPath $c.RegistryParent).Sddl -cne $parentDacl) { throw 'REGISTRY_PARENT_CHANGED' }
    Write-M2FaultNewFile (Join-Path $stage 'host-receipt.json') ([Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 20)+"`n"))
    Add-M2FaultAudit $stage @{event='install-complete';receipt_sha256=Get-M2FaultHash ([IO.File]::ReadAllBytes((Join-Path $stage 'host-receipt.json')));utc=[DateTime]::UtcNow.ToString('o')}
    $receipt
}
function Read-M2FaultReceipt([string]$ApprovedSha256,[string]$ApprovedReceiptSha256,[string]$ApprovedRuntimePackageSha256) {
    if($ApprovedSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ApprovedReceiptSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ApprovedRuntimePackageSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'RECEIPT_APPROVAL_REQUIRED' }
    $c=Get-M2FaultConstants; $stage=Join-Path $c.Root ('fault-stage-'+$ApprovedSha256); $path=Join-Path $stage 'host-receipt.json'
    Assert-M2FaultPrivatePath $path
    $null=Get-M2FaultFileIdentity $path
    if((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'RECEIPT_OVERSIZE' }
    $bytes=[IO.File]::ReadAllBytes($path)
    if((Get-M2FaultHash $bytes) -cne $ApprovedReceiptSha256) { throw 'RECEIPT_HASH_INVALID' }
    $receipt=ConvertFrom-M2FaultJson $bytes
    Assert-M2FaultKeys $receipt @('schema','package_sha256','runtime_package_sha256','exact_zip','stage','anchor','root','temp','runtime_directory','runtime_files','os_dependencies','stage_identity','stage_evidence','files','guid','registry_parent_dacl','utc')
    if($receipt.schema -cne 'm2-a-fault-host-receipt-v2' -or $receipt.package_sha256 -cne $ApprovedSha256 -or $receipt.runtime_package_sha256 -cne $ApprovedRuntimePackageSha256 -or $receipt.stage -cne $stage -or $receipt.root.path -cne $c.Root -or $receipt.stage_identity -cne (Get-M2FaultFileIdentity $stage)) { throw 'RECEIPT_IDENTITY_INVALID' }
    if($receipt.root.identity -cne (Get-M2FaultFileIdentity $c.Root) -or $receipt.root.dacl -cne (Get-Acl -LiteralPath $c.Root).Sddl) { throw 'ROOT_IDENTITY_CHANGED' }
    $stageActual=Get-M2FaultPathEvidence $stage
    foreach($key in @('path','identity','dacl','sha256')) { if($stageActual[$key] -cne $receipt.stage_evidence[$key]) { throw 'STAGE_IDENTITY_CHANGED' } }
    foreach($pair in @(@('anchor',$c.Anchor),@('temp',(Join-Path $c.Anchor 'temp')),@('runtime_directory',$c.Runtime))) {
        $evidence=$receipt[$pair[0]]
        if($evidence.path -cne $pair[1]) { throw 'RECEIPT_DIRECTORY_PATH_INVALID' }
        $actual=Get-M2FaultPathEvidence $pair[1]
        foreach($key in @('path','identity','dacl','sha256')) { if($actual[$key] -cne $evidence[$key]) { throw 'RECEIPT_DIRECTORY_IDENTITY_CHANGED' } }
    }
    Assert-M2FaultOsDependencies $receipt.os_dependencies
    $expectedPaths=@((Join-Path $c.Root 'fault_bridge.py'),(Join-Path $c.Root 'fault-profile.json'),(Join-Path $c.Root 'runtime-manifest.json'))
    if(@($receipt.files).Count -ne 3 -or (@($receipt.files.path|Sort-Object)-join '|') -cne (@($expectedPaths|Sort-Object)-join '|')) { throw 'RECEIPT_TARGETS_INVALID' }
    foreach($evidence in $receipt.files) {
        $actual=Get-M2FaultPathEvidence $evidence.path
        foreach($key in @('path','identity','dacl','sha256')) { if($actual[$key] -cne $evidence[$key]) { throw 'FILE_IDENTITY_CHANGED' } }
    }
    $runtimePaths=@(foreach($name in Get-M2FaultRuntimeMembers){Join-Path $c.Runtime $name})
    if(@($receipt.runtime_files).Count -ne $runtimePaths.Count -or (@($receipt.runtime_files.path|Sort-Object)-join '|') -cne (@($runtimePaths|Sort-Object)-join '|')) { throw 'RECEIPT_RUNTIME_TARGETS_INVALID' }
    foreach($evidence in $receipt.runtime_files) {
        $actual=Get-M2FaultPathEvidence $evidence.path
        foreach($key in @('path','identity','dacl','sha256')) { if($actual[$key] -cne $evidence[$key]) { throw 'RUNTIME_IDENTITY_CHANGED' } }
    }
    Assert-M2FaultInstalledRuntime (ConvertFrom-M2FaultJson ([IO.File]::ReadAllBytes((Join-Path $c.Root 'runtime-manifest.json'))))
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
function Get-M2FaultInheritedDllDirectory { Initialize-M2FaultNative; [M2FaultNative]::InheritedDllDirectory() }
function Assert-M2FaultOsDependencies($Evidence) {
    $paths=@('C:\Windows','C:\Windows\System32')
    if($Evidence -isnot [array] -or $Evidence.Count -ne 2 -or (@($Evidence.path|Sort-Object)-join '|') -cne (@($paths|Sort-Object)-join '|')) { throw 'OS_DEPENDENCY_BOUNDARY_INVALID' }
    foreach($expected in $Evidence) {
        Assert-M2FaultKeys $expected @('path','identity','dacl','sha256')
        $actual=Get-M2FaultPathEvidence $expected.path
        foreach($key in @('path','identity','dacl','sha256')) { if($actual[$key] -cne $expected[$key]) { throw 'OS_DEPENDENCY_IDENTITY_OR_DACL_CHANGED' } }
    }
}
function New-M2FaultProcessStartInfo {
    $c=Get-M2FaultConstants
    if((Get-M2FaultInheritedDllDirectory) -cne '') { throw 'INHERITED_DLL_DIRECTORY_DENIED' }
    foreach($path in @($c.Python,$c.Root,(Join-Path $c.Anchor 'temp'),'C:\Windows','C:\Windows\System32')) { Assert-M2FaultPrivatePath $path }
    $psi=[Diagnostics.ProcessStartInfo]::new(); $psi.FileName=$c.Python
    foreach($flag in @('-B','-I','-S')) { $psi.ArgumentList.Add($flag) }
    $psi.ArgumentList.Add((Join-Path $c.Root 'fault_bridge.py')); $psi.ArgumentList.Add('--run-fixed-batch')
    $psi.Environment.Clear()
    $psi.Environment['SystemRoot']='C:\Windows'; $psi.Environment['WINDIR']='C:\Windows'; $psi.Environment['PATH']='C:\Windows\System32'
    $psi.Environment['TEMP']=Join-Path $c.Anchor 'temp'; $psi.Environment['TMP']=Join-Path $c.Anchor 'temp'
    $psi.WorkingDirectory=$c.Root
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $psi
}
function Invoke-M2FaultHost {
    [CmdletBinding()]param([Parameter(Mandatory)][string]$ApprovedSha256,[Parameter(Mandatory)][string]$ApprovedReceiptSha256,[Parameter(Mandatory)][string]$ApprovedRuntimePackageSha256,[switch]$OwnerApproved)
    Assert-M2FaultOwner -OwnerApproved:$OwnerApproved; $null=Assert-M2FaultVm
    $receipt=Read-M2FaultReceipt $ApprovedSha256 $ApprovedReceiptSha256 $ApprovedRuntimePackageSha256; $c=Get-M2FaultConstants
    $psi=New-M2FaultProcessStartInfo
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$psi; $started=$false
    try {
        if((Get-M2FaultInheritedDllDirectory) -cne '') { throw 'INHERITED_DLL_DIRECTORY_DENIED' }
        Assert-M2FaultOsDependencies $receipt.os_dependencies
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
    [CmdletBinding()]param([Parameter(Mandatory)][string]$ApprovedSha256,[Parameter(Mandatory)][string]$ApprovedReceiptSha256,[Parameter(Mandatory)][string]$ApprovedRuntimePackageSha256,[switch]$OwnerApproved)
    Assert-M2FaultOwner -OwnerApproved:$OwnerApproved; $null=Assert-M2FaultVm
    $receipt=Read-M2FaultReceipt $ApprovedSha256 $ApprovedReceiptSha256 $ApprovedRuntimePackageSha256
    Add-M2FaultAudit $receipt.stage @{event='cleanup-intent';utc=[DateTime]::UtcNow.ToString('o')}
    # Validate every target before the first deletion. Retain stage, receipt/audit, ledger and parent ACL.
    foreach($file in @($receipt.files)+@($receipt.runtime_files)) { Remove-Item -LiteralPath $file.path -Force -ErrorAction Stop }
    Remove-M2FaultRuntimeDirectory # native empty-directory removal; no recursive PowerShell prompt or fallback
    Remove-Item -LiteralPath $receipt.guid.path -ErrorAction Stop # no recursion: subkeys were forbidden
    $remaining=@($receipt.files.path)+@($receipt.runtime_files.path)+@($receipt.runtime_directory.path)+@($receipt.guid.path)|Where-Object { Test-Path -LiteralPath $_ }
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
