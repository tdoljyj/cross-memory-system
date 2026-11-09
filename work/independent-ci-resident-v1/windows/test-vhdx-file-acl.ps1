param([Parameter(Mandatory)][string]$Scratch)
$ErrorActionPreference='Stop'
$Scratch=[IO.Path]::GetFullPath($Scratch)
if(Test-Path -LiteralPath $Scratch){throw 'NEW_SCRATCH_REQUIRED'}
[void][IO.Directory]::CreateDirectory($Scratch)
$source=Join-Path $PSScriptRoot 'companion-headless.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'AST_ERRORS'}
foreach($name in @('Get-CompanionVhdxSddl','Get-CompanionVhdxFileSddl','Get-CompanionVhdxAclNative','Invoke-CompanionVhdxAclNative','Open-CompanionVhdxAclEntry','Set-CompanionVhdxAcl')){
 $definition=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -CEQ $name)
 if($definition.Count -ne 1){throw 'FUNCTION_COUNT'}
 . ([scriptblock]::Create($definition[0].Extent.Text))
}
$count=0
function Pass([bool]$condition,[string]$label){if(-not $condition){throw $label};$script:count++}
function Reject([scriptblock]$action,[string]$code){$caught=$false;try{&$action}catch{$caught=$_.Exception.Message -ceq $code};Pass $caught $code}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$directory=Join-Path $Scratch 'data';[void][IO.Directory]::CreateDirectory($directory)
$file=Join-Path $directory 'ext4.vhdx'
[IO.File]::WriteAllText($file,'DISPOSABLE ACL FIXTURE; NOT A VIRTUAL DISK',[Text.Encoding]::UTF8)
$beforeHash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
$beforeOwner=(Get-Acl -LiteralPath $file).GetOwner([Security.Principal.SecurityIdentifier]).Value
Set-CompanionVhdxAcl $directory $file $sid
$folderAcl=[Security.AccessControl.RawSecurityDescriptor]::new((Get-Acl -LiteralPath $directory).Sddl)
$fileAcl=[Security.AccessControl.RawSecurityDescriptor]::new((Get-Acl -LiteralPath $file).Sddl)
Pass ($folderAcl.DiscretionaryAcl.Count -eq 3 -and $fileAcl.DiscretionaryAcl.Count -eq 3) 'EXACT_THREE_ACES'
$folderUser=@($folderAcl.DiscretionaryAcl|Where-Object {$_.SecurityIdentifier.Value -ceq $sid})
$fileUser=@($fileAcl.DiscretionaryAcl|Where-Object {$_.SecurityIdentifier.Value -ceq $sid})
Pass ($folderUser.Count -eq 1 -and $folderUser[0].AccessMask -eq 0x1301bf) 'DIRECTORY_STAYS_MODIFY'
Pass ($fileUser.Count -eq 1 -and $fileUser[0].AccessMask -eq 0x1701bf) 'ONLY_FILE_GAINS_WRITE_DAC'
Pass ($fileAcl.Owner.Value -ceq $beforeOwner) 'OWNER_PRESERVED'
Pass ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ceq $beforeHash) 'DATA_UNCHANGED'
$held=Open-CompanionVhdxAclEntry $file $false
try{
 $denied=$false;try{[IO.File]::Delete($file)}catch{$denied=$true}
 Pass $denied 'HELD_FILE_CANNOT_BE_REPLACED'
}finally{$held.Dispose()}
Reject {Set-CompanionVhdxAcl $directory (Join-Path $directory 'program.exe') $sid} 'WSL_VHDX_ACL_LEAF_REFUSED'
Reject {Set-CompanionVhdxAcl $directory $file 'S-1-1-0'} 'WSL_VHDX_ACL_SID_REFUSED'
Reject {Open-CompanionVhdxAclEntry $file $true} 'WSL_VHDX_ACL_LINK_OR_KIND_REFUSED'
$alias=Join-Path $directory 'alias.vhdx'
New-Item -ItemType HardLink -Path $alias -Target $file -ErrorAction Stop|Out-Null
try{Reject {Open-CompanionVhdxAclEntry $file $false} 'WSL_VHDX_ACL_LINK_OR_KIND_REFUSED'}finally{[IO.File]::Delete($alias)}
Pass ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ceq $beforeHash) 'REJECTED_HARDLINK_PRESERVES_DATA'
[ordered]@{status='VHDX_FILE_ACL_FIXTURE_PASS';assertions=$count;scope=$Scratch;wslExecuted=$false;accountTaskServiceEffects=0}|ConvertTo-Json -Compress
