# Fixed definitions derived from reviewed predecessor; no main block.
function Work-NoReparse([string]$Path){$item=Get-Item -LiteralPath $Path -Force;while($null -ne $item){if(($item.Attributes -band 1024) -ne 0){throw 'WORK_REPARSE_REFUSED'};if($item -is [IO.DirectoryInfo]){$item=$item.Parent}else{$item=$item.Directory}}}
function Read-PublicWork([string]$Path,[int]$Maximum=1MB,[switch]$KeepLock){
 Work-NoReparse $Path;$s=[IO.File]::Open($Path,'Open','Read','Read');$keep=$false
 try{if($s.Length -lt 1 -or $s.Length -gt $Maximum){throw 'PUBLIC_WORK_SIZE_REFUSED'};$b=New-Object byte[] ([int]$s.Length);$at=0;while($at -lt $b.Length){$n=$s.Read($b,$at,$b.Length-$at);if($n -lt 1){throw 'PUBLIC_WORK_TRUNCATED'};$at+=$n};if($KeepLock){$held.Add($s);$keep=$true};return ,$b}finally{if(-not $keep){$s.Dispose()}}
}
function Public-Hash([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
function Parse-Public([byte[]]$Bytes){return ((New-Object Text.UTF8Encoding($false,$true)).GetString($Bytes)|ConvertFrom-Json)}
function Safe-Code($ErrorRecord){$id=$ErrorRecord.FullyQualifiedErrorId.Split(',')[0];if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){return $id};$inner=$ErrorRecord.Exception.InnerException;if($null -ne $inner -and $inner -is [InvalidOperationException] -and $inner.Message -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){return $inner.Message};return 'FINITE_STEP_UNCONFIRMED'}
function Save-Progress{
 if($null -eq $workStream){throw 'WORK_RECEIPT_UNAVAILABLE'};$receipt.current_stage=$stage;$json=$receipt|ConvertTo-Json -Depth 6;$b=(New-Object Text.UTF8Encoding($false)).GetBytes($json+[char]10);$workStream.Position=0;$workStream.Write($b,0,$b.Length);$workStream.SetLength($b.Length);$workStream.Flush($true)
}
function Assert-Relative([string]$Name){
 if([string]::IsNullOrEmpty($Name) -or $Name.Length -gt 512 -or $Name -cmatch '[\\:\x00-\x1f\x7f]' -or $Name.StartsWith('/')){throw 'PUBLIC_RELATIVE_PATH_REFUSED'}
 foreach($part in $Name.Split('/')){if($part -cin @('','.','..','memory','.git','.env','credentials','node_modules') -or $part.EndsWith('.') -or $part.EndsWith(' ')){throw 'PUBLIC_RELATIVE_PATH_REFUSED'}}
}
function New-FixedSecurity([bool]$Directory,[ValidateSet('Public','State','Spool','Results')][string]$Kind){
 if($Directory){$acl=New-Object Security.AccessControl.DirectorySecurity}else{$acl=New-Object Security.AccessControl.FileSecurity}
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')));$acl.SetAccessRuleProtection($true,$false)
 $sids=@('S-1-5-18','S-1-5-32-544',$ExpectedControllerSid);if($Kind -cin @('Spool','Results')){$sids+= $OwnerSid}
 foreach($sid in $sids){$rights=[Security.AccessControl.FileSystemRights]::FullControl
  if($sid -ceq $ExpectedControllerSid){$rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute;if($Kind -cin @('State','Spool')){$rights=[Security.AccessControl.FileSystemRights]::Modify}}
  if($sid -ceq $OwnerSid){$rights=[Security.AccessControl.FileSystemRights]::ReadAndExecute;if($Kind -ceq 'Results'){$rights=[Security.AccessControl.FileSystemRights]::Modify}}
  if($Directory){$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),$rights,'ContainerInherit,ObjectInherit','None','Allow')}else{$rule=New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),$rights,'Allow')};[void]$acl.AddAccessRule($rule)
 };return $acl
}
function Assert-ExactAcl($Acl,[bool]$Directory,[string]$Kind){
 $wanted=New-FixedSecurity $Directory $Kind
 if(-not $Acl.AreAccessRulesProtected -or $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544'){throw 'EXACT_PROTECTED_MANAGEMENT_OWNER_REQUIRED'}
 $a=@($Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value+'|'+[int]$_.FileSystemRights+'|'+[int]$_.InheritanceFlags+'|'+[int]$_.PropagationFlags+'|'+$_.AccessControlType+'|'+$_.IsInherited}|Sort-Object)
 $b=@($wanted.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{$_.IdentityReference.Value+'|'+[int]$_.FileSystemRights+'|'+[int]$_.InheritanceFlags+'|'+[int]$_.PropagationFlags+'|'+$_.AccessControlType+'|'+$_.IsInherited}|Sort-Object)
 if(@(Compare-Object $a $b -CaseSensitive).Count){throw 'EXACT_FIXED_DIRECTORY_FILE_ACL_REQUIRED'}
}
function Hold-Directory([string]$Path,[string]$Kind){
 if($lockedDirectories.ContainsKey($Path)){return};$h=[VerifyInstallFiles]::HoldMetadata($Path,$true);$held.Add($h);$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorBinaryForm([VerifyInstallFiles]::Security($h))
 if($Kind -ceq 'OS'){Assert-ParentAcl $acl}else{Assert-ExactAcl $acl $true $Kind};$lockedDirectories[$Path]=$h
}
function New-FixedPublicFile([string]$Path,[byte[]]$Bytes,[string]$Expected,[switch]$AllowSwapDelete){
 if(-not $AllowedCreatePaths.ContainsKey($Path) -or $AllowedCreatePaths[$Path] -cne $Expected){throw 'FIXED_CLOSED_CREATE_DESTINATION_REQUIRED'}
 if((Public-Hash $Bytes) -cne $Expected){throw 'EXACT_NEW_FILE_BYTES_REQUIRED'}
 $receipt.creation_attempted_path=$Path;$receipt.effects_started=$true;Save-Progress;$acl=New-FixedSecurity $false 'Public'
 $rights=[Security.AccessControl.FileSystemRights]::Read -bor [Security.AccessControl.FileSystemRights]::Write
 $file=New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,$rights,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough,$acl)
 try{
 $meta=[VerifyInstallFiles]::Metadata($file.SafeFileHandle);[VerifyInstallFiles]::ExactPath($file.SafeFileHandle,$Path)
 if(($meta.Attributes -band 0x410) -ne 0 -or $meta.Links -ne 1){throw 'NEW_FILE_HANDLE_TYPE_LINK_REFUSED'}
 $receipt.created_files+= $Path;Save-Progress;$file.Write($Bytes,0,$Bytes.Length);$file.Flush($true);$file.Position=0;$sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($file))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
 if($actual -cne $Expected){throw 'NEW_FILE_SAME_HANDLE_HASH_REFUSED'}
 $observed=New-Object Security.AccessControl.FileSecurity;$observed.SetSecurityDescriptorBinaryForm([VerifyInstallFiles]::Security($file.SafeFileHandle));Assert-ExactAcl $observed $false 'Public';Save-Progress
 }finally{$file.Dispose()}
 # A retained write handle conflicts with a new Read/ShareRead opener (and an
 # image loader). Close it first; protected ACL + held ancestors guard the gap.
 $readShare=[IO.FileShare]::Read;if($AllowSwapDelete){$readShare=$readShare -bor [IO.FileShare]::Delete};$read=[IO.File]::Open($Path,'Open','Read',$readShare);$keep=$false
 try{
  $again=[VerifyInstallFiles]::Metadata($read.SafeFileHandle);[VerifyInstallFiles]::ExactPath($read.SafeFileHandle,$Path)
  if(($again.Attributes -band 0x410) -ne 0 -or $again.Links -ne 1 -or $again.Volume -ne $meta.Volume -or $again.IndexHigh -ne $meta.IndexHigh -or $again.IndexLow -ne $meta.IndexLow -or $again.SizeHigh -ne 0 -or $again.SizeLow -ne $Bytes.Length){throw 'REOPENED_PUBLIC_FILE_ID_TYPE_LINK_SIZE_REFUSED'}
  $security=New-Object Security.AccessControl.FileSecurity;$security.SetSecurityDescriptorBinaryForm([VerifyInstallFiles]::Security($read.SafeFileHandle));Assert-ExactAcl $security $false 'Public'
  $sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($read))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  if($actual -cne $Expected){throw 'REOPENED_PUBLIC_FILE_HASH_REFUSED'};$held.Add($read);$keep=$true
 }finally{if(-not $keep){$read.Dispose()}}
 Save-Progress
}
