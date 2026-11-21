# Read-only and in-memory mocks only: no runtime execution, installs, ACL/registry writes or VM/window calls.
# pwsh -NoProfile -File tests/test_m2_restricted_entry_a_runtime_host.ps1 [-RuntimePackage path -ApprovedRuntimePackageSha256 sha]
param([string]$RuntimePackage,[string]$ApprovedRuntimePackageSha256)
$ErrorActionPreference='Stop'
trap { Write-Host $_.ScriptStackTrace; throw $_ }
. (Join-Path $PSScriptRoot '../kernel/host/m2-restricted-entry-a-fault-host.ps1')
Set-StrictMode -Version Latest
$script:checks=0
function Assert($Condition,[string]$Message) { if(!$Condition){throw "ASSERT: $Message"}; $script:checks++ }
function Denies([scriptblock]$Action,[string]$Message) { $denied=$false; try{& $Action|Out-Null}catch{$denied=$true}; Assert $denied $Message }
function Save-Functions([string[]]$Names) {
    $saved=@{}; foreach($name in $Names){$command=Get-Command $name; $saved[$name]=if($command.CommandType -eq 'Function'){$command.ScriptBlock}else{$null}}; $saved
}
function Restore-Functions($Saved) { foreach($name in $Saved.Keys){if($Saved[$name]){Set-Item ('Function:script:'+$name) $Saved[$name]}else{Microsoft.PowerShell.Management\Remove-Item ('Function:script:'+$name)}} }
function New-Rule([string]$Sid,$Rights,[switch]$InheritOnly) {
    if($Rights -is [string]){$Rights=[Security.AccessControl.FileSystemRights]$Rights}
    [pscustomobject]@{IdentityReference=[pscustomobject]@{Value=$Sid};FileSystemRights=$Rights;AccessControlType='Allow';PropagationFlags=$(if($InheritOnly){[Security.AccessControl.PropagationFlags]::InheritOnly}else{[Security.AccessControl.PropagationFlags]::None})}
}
function New-MockAcl([string]$OwnerSid,[object[]]$Rules=@(),[bool]$Protected=$true) {
    $acl=[pscustomobject]@{OwnerSid=$OwnerSid;Rules=$Rules;AreAccessRulesProtected=$Protected}
    $acl|Add-Member ScriptMethod GetOwner {param($type) [pscustomobject]@{Value=$this.OwnerSid}}
    $acl|Add-Member ScriptMethod GetAccessRules {param($explicit,$inherited,$type) $this.Rules}
    $acl
}
$c=Get-M2FaultConstants; $ba='S-1-5-32-544'; $sy='S-1-5-18'; $ti=Get-M2FaultServicingSid; $user='S-1-5-32-545'
Assert ($c.Anchor -ceq 'C:\Program Files\CluedM2Fault') 'fixed protected anchor'
Assert ($c.Root -ceq 'C:\Program Files\CluedM2Fault\host-a' -and $c.Python -ceq 'C:\Program Files\CluedM2Fault\python-3.14.8-amd64\python.exe') 'fixed runtime and bridge directories'
Assert ($c.Members.Count -eq 9 -and $c.MaxZipBytes -eq 2097152) 'guest companion remains nine members/two MiB'
Assert ((Get-M2FaultRuntimeMembers).Count -eq 37) 'exact closed official runtime members'
Assert ($c.RuntimeSha256 -ceq 'a93abe456ab01bd96d7a085b3cdb6566b3063f4241360d114142fbdb07f0a310') 'official archive independently pinned'
$adminRules=@((New-Rule $ba 'FullControl'),(New-Rule $sy 'FullControl'))
foreach($owner in @($ba,$sy)) { Assert-M2FaultPathAcl $c.Anchor (New-MockAcl $owner $adminRules); $script:checks++ }
foreach($path in @('C:\','C:\Program Files','C:\Windows','C:\Windows\System32')) { Assert-M2FaultPathAcl $path (New-MockAcl $ti @((New-Rule $ti 'FullControl')) -Protected:$false); $script:checks++ }
Denies { Assert-M2FaultPathAcl $c.Anchor (New-MockAcl $ti $adminRules) } 'TI owner denied on new anchor'
Denies { Assert-M2FaultPathAcl $c.Root (New-MockAcl $user $adminRules) } 'user owner denied on protected child'
Denies { Assert-M2FaultPathAcl $c.Anchor (New-MockAcl $ba $adminRules -Protected:$false) } 'inherited target DACL denied'
Assert-M2FaultPathAcl 'C:\' (New-MockAcl $ti @((New-Rule $user 'CreateDirectories')) -Protected:$false); $script:checks++
Assert-M2FaultPathAcl 'C:\Program Files' (New-MockAcl $ti @((New-Rule $user 'FullControl' -InheritOnly)) -Protected:$false); $script:checks++
foreach($right in @('WriteData','WriteAttributes','WriteExtendedAttributes','Delete','DeleteSubdirectoriesAndFiles','ChangePermissions','TakeOwnership')) {
    Denies { Assert-M2FaultPathAcl 'C:\' (New-MockAcl $ti @((New-Rule $user $right))) } "C root effective $right denied"
}
foreach($path in @('C:\Program Files',$c.Anchor,$c.Root,$c.Python)) {
    foreach($right in @('Write','Delete','DeleteSubdirectoriesAndFiles','ChangePermissions','TakeOwnership')) { Denies { Assert-M2FaultPathAcl $path (New-MockAcl $ba @((New-Rule $user $right))) } "effective $right on $path denied" }
}
Denies { Assert-M2FaultPathAcl 'C:\Clued' (New-MockAcl $ba $adminRules) } 'old Clued path not admitted'
Denies { Assert-M2FaultPathAcl 'C:\Program Files\CluedM2FaultElsewhere' (New-MockAcl $ba $adminRules) } 'prefix sibling not admitted'
Denies { Assert-M2FaultPathAcl 'C:\Windows\OtherDirectory' (New-MockAcl $ti $adminRules) } 'TI trust does not extend to arbitrary Windows descendants'
foreach($generic in @(0x10000000L,0x40000000L)) {
    foreach($path in @('C:\','C:\Program Files','C:\Windows','C:\Windows\System32',$c.Anchor,$c.Root)) {
        Denies { Assert-M2FaultPathAcl $path (New-MockAcl $ba @((New-Rule $user $generic))) } "nonmanagement raw generic mask $generic denied on $path"
        Assert-M2FaultPathAcl $path (New-MockAcl $ba @((New-Rule $ba $generic))); $script:checks++
    }
    Assert-M2FaultPathAcl 'C:\' (New-MockAcl $ti @((New-Rule $user $generic -InheritOnly)) -Protected:$false); $script:checks++
}
# Real read-only OS ancestors demonstrate normal Windows ACLs are accepted without remediation.
foreach($path in @('C:\','C:\Program Files','C:\Windows','C:\Windows\System32')) { Assert-M2FaultPathAcl $path (Get-Acl -LiteralPath $path); $script:checks++ }

# Compile declarations only; do not call native filesystem/security mutation or GetDllDirectory.
Initialize-M2FaultNative
Assert ([M2FaultNative]::RuntimeSecurityVersion -ceq 'm2-atomic-runtime-v1') 'atomic native implementation marker'
$sa=[M2FaultNative].GetNestedType('SecurityAttributes',[Reflection.BindingFlags]::NonPublic)
Assert ([Runtime.InteropServices.Marshal]::SizeOf([type]$sa) -eq $(if([IntPtr]::Size -eq 8){24}else{12})) 'SECURITY_ATTRIBUTES ABI alignment'
Assert ([Runtime.InteropServices.Marshal]::SizeOf([type][M2FaultNative+FileInfo]) -eq 52) 'file identity ABI alignment'
foreach($method in @('CreateProtectedDirectory','CreateProtectedFile','CreateProtectedServiceKey','RemoveEmptyDirectory')) { Assert ($null -ne [M2FaultNative].GetMethod($method)) "native $method declared" }
Assert ($null -eq (Get-Command Set-M2FaultPrivateAcl -ErrorAction SilentlyContinue)) 'no create-then-ACL API remains'

$hashes=@{}; foreach($name in Get-M2FaultRuntimeMembers){$hashes[$name]='a'*64}
$manifest=@{schema='m2-a-fault-runtime-v1';archive_sha256=$c.RuntimeSha256;runtime_directory=$c.RuntimeDirectory;files=$hashes}
Assert-M2FaultRuntimeManifest $manifest; $script:checks++
foreach($kind in @('schema','archive','directory','extra','missing','hash')) {
    $candidate=ConvertFrom-M2FaultJson ([Text.Encoding]::UTF8.GetBytes(($manifest|ConvertTo-Json -Depth 5)))
    switch($kind){'schema'{$candidate.schema='other'};'archive'{$candidate.archive_sha256='b'*64};'directory'{$candidate.runtime_directory='../python'};'extra'{$candidate.files['injected.dll']='a'*64};'missing'{$candidate.files.Remove('python314._pth')};'hash'{$candidate.files['python314.zip']='not-a-hash'}}
    Denies { Assert-M2FaultRuntimeManifest $candidate } "runtime manifest $kind rejected"
}
function New-MemoryZip([string]$Mutation='') {
    $memory=[IO.MemoryStream]::new(); $zip=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        $names=@('runtime-manifest.json','python-3.14.8-embed-amd64.zip')
        if($Mutation -eq 'extra'){$names+='injected.dll'}; if($Mutation -eq 'missing'){$names=@('runtime-manifest.json')}; if($Mutation -eq 'duplicate'){$names+='runtime-manifest.json'}
        foreach($name in $names){$entry=$zip.CreateEntry($name); $entry.ExternalAttributes=[int]0x81240000; if($Mutation -eq 'symlink'){$entry.ExternalAttributes=[int]0xA1FF0000}; $writer=$entry.Open(); try{$writer.WriteByte(1)}finally{$writer.Dispose()}}
    } finally {$zip.Dispose()}
    $bytes=$memory.ToArray(); $memory.Dispose(); return ,$bytes
}
Assert ((Expand-M2FaultClosedZip (New-MemoryZip) @($c.RuntimeArchive,'runtime-manifest.json') 100).Count -eq 2) 'closed outer ZIP parses in memory'
foreach($mutation in @('extra','missing','duplicate','symlink')) { Denies { Expand-M2FaultClosedZip (New-MemoryZip $mutation) @($c.RuntimeArchive,'runtime-manifest.json') 100 } "runtime ZIP $mutation rejected" }
Denies { Expand-M2FaultClosedZip (New-MemoryZip) @($c.RuntimeArchive,'runtime-manifest.json') 1 } 'runtime ZIP expansion bound enforced'
if($RuntimePackage) {
    Assert ($ApprovedRuntimePackageSha256 -match '^[0-9a-f]{64}$') 'explicit readonly package approved hash supplied'
    $runtime=Read-M2FaultRuntimePackage $RuntimePackage $ApprovedRuntimePackageSha256
    Assert ($runtime.files.Count -eq 37) 'actual approved archive yields exact 37 files'
    Assert ((Get-M2FaultHash $runtime.files['python314.zip']) -ceq $runtime.manifest.files['python314.zip']) 'actual stdlib independently hashed'
    Assert ((Get-M2FaultHash $runtime.files['python314._pth']) -ceq $runtime.manifest.files['python314._pth']) 'actual _pth independently hashed'
    Denies { Read-M2FaultRuntimePackage $RuntimePackage ('0'*64) } 'actual immutable package approval mismatch denied'
}

# Process construction mocks only: poisoned inherited environment is dropped, no Process.Start call.
$saved=Save-Functions @('Get-M2FaultInheritedDllDirectory','Assert-M2FaultPrivatePath')
$script:dllDirectory=''; $script:poisonedSystemPath=''; $script:checkedPaths=[Collections.Generic.List[string]]::new()
function Get-M2FaultInheritedDllDirectory { $script:dllDirectory }
function Assert-M2FaultPrivatePath([string]$Path) { $script:checkedPaths.Add($Path); if($Path -ceq $script:poisonedSystemPath){throw 'OS_DEPENDENCY_REPARSE_OR_ACL_INVALID'} }
try {
    $psi=New-M2FaultProcessStartInfo
    Assert ($psi.FileName -ceq $c.Python -and $psi.WorkingDirectory -ceq $c.Root) 'pinned executable/protected fixed cwd'
    Assert (($psi.ArgumentList -join '|') -ceq ('-B|-I|-S|'+(Join-Path $c.Root 'fault_bridge.py')+'|--run-fixed-batch')) 'only isolated fixed bridge arguments'
    Assert (($psi.Environment.Keys|Sort-Object)-join '|' -ceq 'PATH|SystemRoot|TEMP|TMP|WINDIR') 'entire inherited environment cleared'
    Assert ($psi.Environment['PATH'] -ceq 'C:\Windows\System32' -and $psi.Environment['SystemRoot'] -ceq 'C:\Windows' -and $psi.Environment['TEMP'] -ceq (Join-Path $c.Anchor 'temp')) 'exact system and protected temp environment'
    Assert (!$psi.UseShellExecute -and $psi.RedirectStandardOutput -and $psi.RedirectStandardError) 'no shell, both streams captured'
    Assert ($script:checkedPaths.Contains($c.Python) -and $script:checkedPaths.Contains($c.Root) -and $script:checkedPaths.Contains((Join-Path $c.Anchor 'temp'))) 'runtime/cwd/temp checked before process construction'
    Assert ($script:checkedPaths.Contains('C:\Windows') -and $script:checkedPaths.Contains('C:\Windows\System32')) 'Windows/System32 active DLL and PATH dependencies checked'
    foreach($path in @('C:\Windows','C:\Windows\System32')) {
        $script:poisonedSystemPath=$path; Denies { New-M2FaultProcessStartInfo } 'poisoned active OS dependency denies process construction'
    }
    $script:poisonedSystemPath=''
    $script:dllDirectory='C:\Users\attacker'; Denies { New-M2FaultProcessStartInfo } 'inherited DLL directory denies process construction'
} finally { Restore-Functions $saved }

$saved=Save-Functions @('Get-M2FaultPathEvidence')
$script:osEvidenceMutation=''
function Get-M2FaultPathEvidence([string]$Path) {
    @{path=$Path;identity=$(if($script:osEvidenceMutation -eq 'identity'){'replacement'}else{'stable-id'});dacl=$(if($script:osEvidenceMutation -eq 'dacl'){'changed'}else{'trusted-dacl'});sha256=$null}
}
try {
    $osEvidence=@(@{path='C:\Windows';identity='stable-id';dacl='trusted-dacl';sha256=$null},@{path='C:\Windows\System32';identity='stable-id';dacl='trusted-dacl';sha256=$null})
    Assert-M2FaultOsDependencies $osEvidence; $script:checks++
    foreach($mutation in @('identity','dacl')){$script:osEvidenceMutation=$mutation; Denies { Assert-M2FaultOsDependencies $osEvidence } 'OS dependency identity/DACL differs from approved receipt'}
    $script:osEvidenceMutation=''
    Denies { Assert-M2FaultOsDependencies @($osEvidence[0]) } 'missing OS dependency denied'
    Denies { Assert-M2FaultOsDependencies @($osEvidence[0],@{path='C:\Users\attacker';identity='stable-id';dacl='trusted-dacl';sha256=$null}) } 'OS dependency receipt cannot select arbitrary path'
} finally { Restore-Functions $saved }

# Installed membership/hash checks are deterministic mocked read-only evidence; no actual runtime required.
$saved=Save-Functions @('Assert-M2FaultPrivatePath','Get-ChildItem','Get-M2FaultPathEvidence')
$script:installedMutation=''
function Assert-M2FaultPrivatePath([string]$Path) {}
function Get-ChildItem { param($LiteralPath,[switch]$Force,$ErrorAction)
    $names=@(Get-M2FaultRuntimeMembers); if($script:installedMutation -eq 'extra'){$names+='injected.dll'}; if($script:installedMutation -eq 'missing'){$names=$names|Where-Object {$_ -ne 'python.exe'}}
    foreach($name in $names){[pscustomobject]@{Name=$name;FullName=(Join-Path (Get-M2FaultConstants).Runtime $name);PSIsContainer=($script:installedMutation -eq 'directory');Attributes=$(if($script:installedMutation -eq 'reparse'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal})}}
}
function Get-M2FaultPathEvidence([string]$Path) { if($script:installedMutation -eq 'hardlink'){throw 'FILE_IDENTITY_UNAVAILABLE_OR_HARDLINK'}; @{path=$Path;identity='one-link-identity';dacl='protected';sha256=$(if($script:installedMutation -eq 'hash'){'b'*64}else{'a'*64})} }
try {
    Assert-M2FaultInstalledRuntime $manifest; $script:checks++
    foreach($mutation in @('extra','missing','directory','reparse','hash','hardlink')) {$script:installedMutation=$mutation; Denies { Assert-M2FaultInstalledRuntime $manifest } "installed runtime $mutation rejected"}
} finally { Restore-Functions $saved }

# Existing process exit fail-closed contract stays intact with simulated processes.
function New-FakeProcess($Code,[switch]$GetterError) {
    $process=[pscustomobject]@{events=[Collections.Generic.List[string]]::new();code=$Code;getter_error=[bool]$GetterError;StandardOutput=[IO.StringReader]::new('');StandardError=[IO.StringReader]::new('audit')}
    $process|Add-Member ScriptProperty Handle {$this.events.Add('handle');[IntPtr]123}
    $process|Add-Member ScriptMethod WaitForExit {param($milliseconds)$this.events.Add('wait');$true}
    $process|Add-Member ScriptProperty ExitCode {$this.events.Add('exit');if($this.getter_error){throw 'getter-error'};$this.code}
    $process
}
foreach($code in @(0,7,$null)) {
    $fake=New-FakeProcess $code; $result=Wait-M2FaultProcess $fake
    Assert (($fake.events -join '|') -ceq 'handle|wait|exit') 'handle-before-wait exit order preserved'
    Assert ($result.bridge_status -ceq $(if($null -eq $code){'UNKNOWN'}elseif($code -eq 0){'BRIDGE_EXITED_ZERO'}else{'BRIDGE_FAILED'})) 'numeric/null exit classification preserved with stderr audit'
    Assert ($result.execution_state -ceq 'UNKNOWN') 'exit never qualifies guest STOPPED'
}
$fake=New-FakeProcess 0 -GetterError; Assert ((Wait-M2FaultProcess $fake).bridge_status -ceq 'UNKNOWN') 'getter exception remains unknown'
foreach($name in @('Install-M2FaultHost','Invoke-M2FaultHost','Remove-M2FaultHost')) {
    $parameters=(Get-Command $name).Parameters
    Assert ($parameters['ApprovedRuntimePackageSha256'].Attributes.Where({$_ -is [Management.Automation.ParameterAttribute]})[0].Mandatory) "$name requires exact runtime package pin"
    foreach($forbidden in @('Root','Python','Command','Role','AgentMode')){Assert (!$parameters.ContainsKey($forbidden)) "$name excludes arbitrary $forbidden"}
}

# Exact cleanup paths are mocked; failed post assertion never repeats deletions or erases evidence.
$saved=Save-Functions @('Assert-M2FaultOwner','Assert-M2FaultVm','Read-M2FaultReceipt','Add-M2FaultAudit','Remove-Item','Remove-M2FaultRuntimeDirectory','Test-Path','Get-Acl')
$script:deletes=[Collections.Generic.List[string]]::new(); $script:receiptFailure=$true; $script:postPresent=$false
$script:receipt=@{stage='retained-stage';files=@(@{path=(Join-Path $c.Root 'fault_bridge.py')},@{path=(Join-Path $c.Root 'fault-profile.json')},@{path=(Join-Path $c.Root 'runtime-manifest.json')});runtime_files=@(foreach($name in Get-M2FaultRuntimeMembers){@{path=(Join-Path $c.Runtime $name)}});runtime_directory=@{path=$c.Runtime};guid=@{path=$c.RegistryParent+'\'+$c.ServiceId};registry_parent_dacl='unchanged'}
function Assert-M2FaultOwner {param([switch]$OwnerApproved)}
function Assert-M2FaultVm {}
function Read-M2FaultReceipt {param($ApprovedSha256,$ApprovedReceiptSha256,$ApprovedRuntimePackageSha256)if($script:receiptFailure){throw 'RUNTIME_IDENTITY_CHANGED'};$script:receipt}
function Add-M2FaultAudit {param($Stage,$Record)}
function Remove-Item {param($LiteralPath,[switch]$Force,$ErrorAction)$script:deletes.Add($LiteralPath)}
function Remove-M2FaultRuntimeDirectory {$script:deletes.Add((Get-M2FaultConstants).Runtime)}
function Test-Path {param($LiteralPath)$script:postPresent}
function Get-Acl {param($LiteralPath)[pscustomobject]@{Sddl='unchanged'}}
try {
    $cleanupArguments=@{ApprovedSha256=('a'*64);ApprovedReceiptSha256=('b'*64);ApprovedRuntimePackageSha256=('c'*64);OwnerApproved=$true}
    Denies { Remove-M2FaultHost @cleanupArguments } 'runtime identity failure prevents every deletion'
    Assert ($script:deletes.Count -eq 0) 'all runtime members prevalidated before cleanup'
    $script:receiptFailure=$false; $script:postPresent=$true
    Denies { Remove-M2FaultHost @cleanupArguments } 'cleanup read post failure reported'
    Assert ($script:deletes.Count -eq 42) 'exact 3 hostfiles +37 runtimefiles +1 empty runtime dir +1 GUID; no retry'
    Assert (!$script:deletes.Contains('retained-stage') -and !$script:deletes.Contains($c.Anchor) -and !$script:deletes.Contains($c.Root) -and !$script:deletes.Contains((Join-Path $c.Anchor 'temp'))) 'anchor/root/temp/stage retained with all receipts'
} finally { Restore-Functions $saved }
"PASS: $script:checks checks; read-only/mocked runtime integration; no executable/VM/window/registry/ACL mutation."
