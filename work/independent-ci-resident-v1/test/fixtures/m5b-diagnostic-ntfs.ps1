# Scratch-only NTFS regression; invoked by the node test with actual generated
# production ImportArguments and the real reviewed entry's directory helper.
param([Parameter(Mandatory=$true)][string]$ActionPath,
      [Parameter(Mandatory=$true)][string]$EntryPath,
      [Parameter(Mandatory=$true)][string]$ScratchRoot,
      [Parameter(Mandatory=$true)][string]$RegistrarSha256)
$ErrorActionPreference='Stop'
$env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$scratch=[IO.Path]::GetFullPath($ScratchRoot)
if($scratch -cne $ScratchRoot -or [IO.Path]::GetFileName($scratch) -notmatch '^clued-m5b-diagnostic-ntfs-[A-Za-z0-9_-]+$'){throw 'ISOLATED_SCRATCH_REQUIRED'}
$item=Get-Item -LiteralPath $scratch -Force
if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'SCRATCH_NOT_PLAIN'}
foreach($name in @('batch','results','bin')){[void][IO.Directory]::CreateDirectory($scratch+'\'+$name)}
function Hash-Bytes([byte[]]$Bytes){$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
$dir=$scratch+'\batch'
$dp=$dir+'\companion-wsl-import-result.json'
$arguments=[IO.File]::ReadAllText($ActionPath)
$generated=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(($arguments -split ' ')[-1]))
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($generated,[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
$definitions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false))
$functionHashes=[ordered]@{}
foreach($name in @('Get-DiagAcl','Assert-DiagAcl','Protect-Diag','Write-Diag')){
 $match=@($definitions|Where-Object Name -CEQ $name);if($match.Count -ne 1){throw 'FUNCTION_MISSING'}
 $functionHashes[$name]=Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($match[0].Extent.Text))
 . ([scriptblock]::Create($match[0].Extent.Text))
}
$entry=[IO.File]::ReadAllText($EntryPath)
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($entry,[ref]$t,[ref]$e)
$definitions=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false))
foreach($name in @('Assert-Plain','Open-VerifiedEntry')){
 $match=@($definitions|Where-Object Name -CEQ $name);if($match.Count -ne 1){throw 'NATIVE_HELPER_MISSING'}
 . ([scriptblock]::Create($match[0].Extent.Text))
}
$start=$entry.IndexOf('$assemblyName =');$end=$entry.IndexOf('function Assert-ExactDirectoryDacl')
. ([scriptblock]::Create($entry.Substring($start,$end-$start)))
$script:ds=$identity.User.Value
$observations=New-Object 'Collections.Generic.List[object]'
function Observe-Write([string]$Label,[int]$Attempt){
 $script:r=[ordered]@{contract='clued.ntfs-fixture/1';attempt=$Attempt;label=$Label}
 $before=if([IO.File]::Exists($dp)){[ordered]@{sha256=(Hash-Bytes ([IO.File]::ReadAllBytes($dp)));sddl=(Get-Acl -LiteralPath $dp).Sddl}}else{$null}
 $success=$false;$failure=$null
 try{Write-Diag;$success=$true}catch{
  $exception=$_.Exception;while($null -ne $exception.InnerException){$exception=$exception.InnerException}
  $failure=[ordered]@{type=$exception.GetType().FullName;hresult=('0x{0:X8}' -f $exception.HResult);message=$exception.Message;line=$_.InvocationInfo.ScriptLineNumber;statement=$_.InvocationInfo.Line;scriptStackTrace=$_.ScriptStackTrace}
 }
 $after=if([IO.File]::Exists($dp)){[ordered]@{sha256=(Hash-Bytes ([IO.File]::ReadAllBytes($dp)));sddl=(Get-Acl -LiteralPath $dp).Sddl;json=([IO.File]::ReadAllText($dp)|ConvertFrom-Json)}}else{$null}
 $observations.Add([ordered]@{label=$Label;success=$success;failure=$failure;before=$before;after=$after;temporaryFiles=@([IO.Directory]::EnumerateFiles($dir,'*.tmp'))})
}
Observe-Write 'seed-no-lock' 1
Observe-Write 'replace-no-lock' 2
$locks=New-Object 'Collections.Generic.List[IDisposable]'
try{
  foreach($path in @($scratch,($scratch+'\bin'),($scratch+'\batch'),($scratch+'\results'))){
  $pointer=Native 'CreateFileW' @($path,[uint32]2147483648,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]0x02200000,[IntPtr]::Zero)
  if($pointer -eq [IntPtr](-1)){throw 'LEGACY_LOCK_FAILED'}
  $locks.Add((New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($pointer,$true)))
 }
 Observe-Write 'replace-with-c1-directory-locks' 3
}finally{for($i=$locks.Count-1;$i -ge 0;$i--){$locks[$i].Dispose()}}
Observe-Write 'replace-after-directory-locks-released' 4
$actualEntryLocks=New-Object 'Collections.Generic.List[IDisposable]'
$actualEntryRenameBlocked=$false
try{
 foreach($path in @($scratch,($scratch+'\bin'),($scratch+'\batch'),($scratch+'\results'))){$actualEntryLocks.Add((Open-VerifiedEntry $path $true))}
 Observe-Write 'replace-under-actual-new-entry-helper' 99
 $moved=$dir+'.actual-helper-rename-probe';$renamed=$false
 try{[IO.Directory]::Move($dir,$moved);$renamed=$true}catch{
  $ex=$_.Exception;while($null -ne $ex.InnerException){$ex=$ex.InnerException}
  $actualEntryRenameBlocked=$ex.HResult -eq -2147024864
 }
}finally{
 for($i=$actualEntryLocks.Count-1;$i -ge 0;$i--){$actualEntryLocks[$i].Dispose()}
 if($renamed){[IO.Directory]::Move($moved,$dir)}
}
$actualEntryWriteSucceeded=$observations[$observations.Count-1].success
$actualFileWriteBlocked=$false;$actualFileRenameBlocked=$false
$filePin=Open-VerifiedEntry $dp $false
try{
 try{$writer=[IO.File]::Open($dp,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$writer.Dispose()}catch{
  $ex=$_.Exception;while($null -ne $ex.InnerException){$ex=$ex.InnerException};$actualFileWriteBlocked=$ex.HResult -eq -2147024864
 }
 $renamedFile=$dp+'.rename-probe';$fileMoved=$false
 try{[IO.File]::Move($dp,$renamedFile);$fileMoved=$true}catch{
  $ex=$_.Exception;while($null -ne $ex.InnerException){$ex=$ex.InnerException};$actualFileRenameBlocked=$ex.HResult -eq -2147024864
 }
}finally{$filePin.Dispose();if($fileMoved){[IO.File]::Move($renamedFile,$dp)}}
$variants=@(
 @{name='root-only-generic-read-shareR';path=$scratch;access=[uint32]2147483648;share=[uint32]1},
 @{name='bin-only-generic-read-shareR';path=($scratch+'\bin');access=[uint32]2147483648;share=[uint32]1},
 @{name='results-only-generic-read-shareR';path=($scratch+'\results');access=[uint32]2147483648;share=[uint32]1},
 @{name='batch-only-generic-read-shareR';path=$dir;access=[uint32]2147483648;share=[uint32]1},
 @{name='batch-generic-read-shareRW';path=$dir;access=[uint32]2147483648;share=[uint32]3},
 @{name='batch-generic-read-shareRD';path=$dir;access=[uint32]2147483648;share=[uint32]5},
 @{name='batch-generic-read-shareRWD';path=$dir;access=[uint32]2147483648;share=[uint32]7},
 @{name='batch-readcontrol-shareR';path=$dir;access=[uint32]0x20000;share=[uint32]1},
 @{name='batch-readcontrol-attributes-shareR';path=$dir;access=[uint32]0x20080;share=[uint32]1},
 @{name='batch-readcontrol-delete-shareRW';path=$dir;access=[uint32]0x30000;share=[uint32]3},
 @{name='batch-attributes-delete-shareRW';path=$dir;access=[uint32]0x10080;share=[uint32]3}
)
$variantResults=New-Object 'Collections.Generic.List[object]'
$attempt=5
foreach($variant in $variants){
 $pointer=Native 'CreateFileW' @($variant.path,$variant.access,$variant.share,[IntPtr]::Zero,[uint32]3,[uint32]0x02200000,[IntPtr]::Zero)
 if($pointer -eq [IntPtr](-1)){throw ('VARIANT_OPEN_FAILED_'+$variant.name)}
 $handle=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($pointer,$true)
 $renameSucceeded=$false;$renameHresult=$null;$renamed=$null
 try{
  Observe-Write $variant.name $attempt;$attempt++
  if($variant.path -ceq $dir){
   $renamed=$dir+'.rename-probe'
   try{[IO.Directory]::Move($dir,$renamed);$renameSucceeded=$true}catch{$ex=$_.Exception;while($null -ne $ex.InnerException){$ex=$ex.InnerException};$renameHresult=('0x{0:X8}' -f $ex.HResult)}
  }
 }finally{
  $handle.Dispose()
  if($renameSucceeded){[IO.Directory]::Move($renamed,$dir)}
 }
 $variantResults.Add([ordered]@{name=$variant.name;path=$variant.path;access=('0x{0:X8}' -f $variant.access);share=$variant.share;writeSucceeded=$observations[$observations.Count-1].success;writeFailure=$observations[$observations.Count-1].failure;renameSucceededWhileHeld=$renameSucceeded;renameHresult=$renameHresult})
}
function Assert-Fixture([bool]$Condition,[string]$Name){if(-not $Condition){throw ('ASSERT_'+$Name)}}
Assert-Fixture $observations[0].success 'SEED'
Assert-Fixture $observations[1].success 'UNLOCKED_REPLACE'
Assert-Fixture (-not $observations[2].success -and $observations[2].failure.hresult -ceq '0x80070497') 'OLD_DIRECTORY_LOCK_REPRODUCES'
Assert-Fixture ($observations[2].before.sha256 -ceq $observations[2].after.sha256 -and $observations[2].before.sddl -ceq $observations[2].after.sddl) 'FAILED_REPLACE_PRESERVES_BYTES_AND_OWNER'
Assert-Fixture $observations[3].success 'RELEASE_RESTORES_REPLACE'
foreach($name in @('root-only-generic-read-shareR','bin-only-generic-read-shareR','results-only-generic-read-shareR')){
 Assert-Fixture (@($variantResults|Where-Object name -CEQ $name)[0].writeSucceeded) ('NON_BATCH_'+$name)
}
$batchOld=@($variantResults|Where-Object name -CEQ 'batch-only-generic-read-shareR')[0]
Assert-Fixture (-not $batchOld.writeSucceeded -and -not $batchOld.renameSucceededWhileHeld) 'OLD_BATCH_LOCK'
$batchNew=@($variantResults|Where-Object name -CEQ 'batch-generic-read-shareRW')[0]
Assert-Fixture ($batchNew.writeSucceeded -and -not $batchNew.renameSucceededWhileHeld -and $batchNew.renameHresult -ceq '0x80070020') 'MINIMAL_RW_SHARING_PUBLISHES_AND_PINS_NAMESPACE'
$metadata=@($variantResults|Where-Object name -CEQ 'batch-readcontrol-shareR')[0]
Assert-Fixture ($metadata.writeSucceeded -and $metadata.renameSucceededWhileHeld) 'READCONTROL_ONLY_DOES_NOT_PIN_NAMESPACE'
$deleteShare=@($variantResults|Where-Object name -CEQ 'batch-generic-read-shareRWD')[0]
Assert-Fixture ($deleteShare.writeSucceeded -and $deleteShare.renameSucceededWhileHeld) 'SHAREDELETE_WEAKENS_NAMESPACE'
Assert-Fixture $actualEntryWriteSucceeded 'ACTUAL_ENTRY_HELPER_PUBLISHES'
Assert-Fixture $actualEntryRenameBlocked 'ACTUAL_ENTRY_HELPER_PINS_NAMESPACE'
Assert-Fixture $actualFileWriteBlocked 'ACTUAL_ENTRY_FILE_HELPER_BLOCKS_WRITE'
Assert-Fixture $actualFileRenameBlocked 'ACTUAL_ENTRY_FILE_HELPER_BLOCKS_RENAME'
'ASSERTIONS_PASS=16; exact production generated functions; scratch NTFS; actual-root/Task/WSL effects=0'
$report=[ordered]@{contract='clued.m5b.actual-import-diagnostic-ntfs-fixture/1';at=[DateTimeOffset]::UtcNow.ToString('o');elevated=((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator));sid=$identity.User.Value;scratch=$scratch;registrarSha256=$RegistrarSha256;actualEntryWriteSucceeded=$actualEntryWriteSucceeded;actualEntryRenameBlocked=$actualEntryRenameBlocked;actualFileWriteBlocked=$actualFileWriteBlocked;actualFileRenameBlocked=$actualFileRenameBlocked;generatedArgumentsSha256=(Hash-Bytes ([Text.Encoding]::Unicode.GetBytes($arguments)));functionHashes=$functionHashes;variantResults=$variantResults;observations=$observations;taskWslActualRootEffects=0}
[IO.File]::WriteAllText($scratch+'\fixture-result.json',($report|ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
$variantResults|ForEach-Object{[pscustomobject]$_}|Select-Object name,access,share,writeSucceeded,renameSucceededWhileHeld,renameHresult|ConvertTo-Json -Compress
'FIXTURE_RESULT='+$scratch+'\fixture-result.json'
