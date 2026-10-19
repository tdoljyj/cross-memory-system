
# Fixed per-stage input transitions. Existing installation and SCM primitives are reused.
function Stage-Bytes([string]$Path,[int]$Max=4MB){return ,(Read-PublicWork $Path $Max)}
function Stage-Write([string]$Name,[byte[]]$Bytes){
 $target=Join-Path $Root $Name;$expected=Public-Hash $Bytes
 try{$null=[IO.File]::GetAttributes($target);$exists=$true}catch [IO.FileNotFoundException]{$exists=$false}catch [IO.DirectoryNotFoundException]{$exists=$false}
 if(-not $exists){$AllowedCreatePaths[$target]=$expected;New-FixedPublicFile $target $Bytes $expected;return}
 $oldHash=Get-Sha256 $target;$old=Hold-ExistingPublic $Name $oldHash -SwapDelete;$oldHash=Public-Hash (Read-HeldPublic $old $oldHash);if($oldHash -ceq $expected){return}
 $meta=Capture-PublicRow $old $oldHash;$backup=$target+'.clued-stage-old-'+$oldHash+'.bak';$temp=$target+'.clued-stage-new-'+$expected+'.tmp';Assert-PathAbsent $backup;Assert-PathAbsent $temp;$AllowedCreatePaths[$backup]=$oldHash;$AllowedCreatePaths[$temp]=$expected
 New-FixedPublicFile $backup (Read-HeldPublic $old $oldHash) $oldHash;$receipt.protected_backups+=$backup;New-FixedPublicFile $temp $Bytes $expected -AllowSwapDelete;$new=$held[$held.Count-1];$newId=[VerifyInstallFiles]::Metadata($new.SafeFileHandle);Assert-HeldDescriptor $old $meta
 $null=Assert-CurrentOriginalHost $originalManifest;[FormalStageFiles]::ReplaceFixed($Name,$temp,$old,$new);$actual=Hold-ExistingPublic $Name $expected;if(-not [FormalStageFiles]::Same($newId,[VerifyInstallFiles]::Metadata($actual.SafeFileHandle))){throw 'STAGE_REPLACEMENT_ID_UNCONFIRMED'};$receipt.replaced_public_files+=$Name;Save-Progress
}
function Read-ReadyPair([string]$Folder,[string]$Name){
 $root=Join-Path $Root ('formal-spool/'+$Folder);$p=Join-Path $root ($Name+'.json');$ready=Join-Path $root ($Name+'.ready.json')
 $raw=Read-LockedBytes $p 1MB;$marker=Parse-Public (Read-LockedBytes $ready 4096)
 if($marker.contract -cne 'clued.independent-ci.complete-public-file/1' -or $marker.bytes -ne $raw.Length -or $marker.sha256 -cne (Public-Hash $raw)){throw 'ACTUAL_COMPLETE_PUBLIC_RECORD_REQUIRED'};return ,$raw
}
function Prepare-StageInputs($Row){
 foreach($h in $held){$h.Dispose()};$script:held=New-Object 'Collections.Generic.List[IDisposable]';$script:lockedDirectories=@{};$script:AllowedCreatePaths=@{}
 try{
  [CluedSession0ScmV2]::BeginFixedSession($false);$script:originalManifest=Assert-ReviewedBundle;$null=Assert-CurrentOriginalHost $originalManifest
  Hold-Directory 'C:\' 'OS';Hold-Directory 'C:\ProgramData' 'OS';Hold-Directory $Root 'Public';Hold-Directory (Join-Path $Root 'inbox') 'Public'
  $dir=Join-Path $CandidateRoot $Row.directory;$binding=Parse-Public (Stage-Bytes (Join-Path $dir 'binding.json'));$pm=Parse-Public (Stage-Bytes (Join-Path $dir 'inputs/payload-manifest.json'))
  if($binding.role -cne $Row.entryRole -or $binding.helperSha256 -cne $Row.helperSha256 -or (Public-Hash (Stage-Bytes (Join-Path $dir 'work-manifest.json'))) -cne $Row.workManifestSha256){throw 'EXACT_NEXT_STAGE_PACKAGE_REQUIRED'}
  $helper=Stage-Bytes (Join-Path $dir ('inputs/'+$Row.helper));if((Public-Hash $helper) -cne $Row.helperSha256){throw 'STAGE_HELPER_CHANGED'};$hp=Join-Path $Root $Row.helper;Assert-PathAbsent $hp;$AllowedCreatePaths[$hp]=$Row.helperSha256;New-FixedPublicFile $hp $helper $Row.helperSha256
  # Only this package's two new public selector leaves are changed. Old77 and
  # all authority/config/Source bytes remain sealed and are rechecked by child.
  Stage-Write 'formal-job.json' (Stage-Bytes (Join-Path $dir 'inputs/formal-job.json'))
  if($Row.entryRole -ceq 'check-publisher'){
   $job=Parse-Public (Stage-Bytes (Join-Path $dir 'inputs/inbox/job.json'));$wrapper=Parse-Public (Read-ReadyPair 'incoming' 'result');$subject=$wrapper.envelope.payload.subject
   if($wrapper.contract -cne 'clued.independent-ci.protected-job-result/1' -or $wrapper.domain -cne 'production' -or $wrapper.envelope.contract -cne 'independent-ci.signed-result.v1' -or $wrapper.envelope.payload.domain -cne 'production'){throw 'ACTUAL_SIGNED_BRIDGE_ENVELOPE_REQUIRED'}
   foreach($k in @('id','repo','pr','headSha','baseSha','claimId','fence','epoch','role','sourceManifestSha256','attempt')){if($subject.$k -cne $job.$k){throw 'ACTUAL_SCANNER_RESULT_SUBJECT_CHANGED'}}
   # This copies the real envelope only. Original one-shot verifies its accepted
   # signer/signature/Source and complete fresh Native before/after any Check.
   Stage-Write 'inbox/job.json' (Stage-Bytes (Join-Path $dir 'inputs/inbox/job.json'));$envelope=(New-Object Text.UTF8Encoding($false)).GetBytes(($wrapper.envelope|ConvertTo-Json -Depth 30 -Compress));Stage-Write 'inbox/result.json' $envelope
  }
  Stage-Write 'formal-service-entry.json' (Stage-Bytes (Join-Path $dir 'inputs/formal-service-entry.json'))
  $null=Assert-CurrentOriginalHost $originalManifest
 }finally{try{[CluedSession0ScmV2]::EndFixedSession()}finally{for($i=$held.Count-1;$i -ge 0;$i--){$held[$i].Dispose()}}}
}
function Archive-WindowsProtocol([string]$JobId){
 if($JobId -cnotmatch '\A[a-f0-9]{64}\z'){throw 'EXACT_PREVIOUS_JOB_REQUIRED'}
 foreach($h in $held){$h.Dispose()};$script:held=New-Object 'Collections.Generic.List[IDisposable]';$script:lockedDirectories=@{};$records=@();$spool=Join-Path $Root 'formal-spool'
 try{
  [CluedSession0ScmV2]::BeginFixedSession($false);$null=Assert-CurrentOriginalHost $originalManifest;Hold-Directory $spool 'Public';Hold-Directory (Join-Path $spool 'incoming') 'Results';Hold-Directory (Join-Path $spool 'outgoing') 'Spool'
  $issue=Parse-Public (Read-ReadyPair 'outgoing' 'issue');$result=Parse-Public (Read-ReadyPair 'incoming' 'result');if($issue.job.id -cne $JobId -or $result.envelope.payload.subject.id -cne $JobId){throw 'EXACT_COMPLETED_PROTOCOL_JOB_REQUIRED'}
  foreach($folder in @('incoming','outgoing')){$names=if($folder -ceq 'incoming'){@('result')+@(1..32|ForEach-Object{'challenge-'+$_.ToString('00')})}else{@('issue')+@(1..32|ForEach-Object{'response-'+$_.ToString('00')})};foreach($n in $names){$data=Join-Path $spool ($folder+'/'+$n+'.json');$marker=Join-Path $spool ($folder+'/'+$n+'.ready.json');$a=[IO.File]::Exists($data);$b=[IO.File]::Exists($marker);if($a -ne $b){throw 'HALF_PROTOCOL_PAIR_PRESERVED'};if($a){$null=Read-ReadyPair $folder $n;$records+= $data;$records+=$marker}}}
  $records+=Join-Path $spool 'outgoing/active.lock';$archive=Join-Path $spool ('archive-'+$JobId);Assert-PathAbsent $archive;$acl=New-FixedSecurity $true 'Public';[VerifyInstallFiles]::NewDirectory($archive,$acl.GetSecurityDescriptorBinaryForm());foreach($f in @('incoming','outgoing')){$a=New-FixedSecurity $true 'Public';[VerifyInstallFiles]::NewDirectory((Join-Path $archive $f),$a.GetSecurityDescriptorBinaryForm())}
  foreach($src in $records){$f=[IO.File]::Open($src,'Open','Read',([IO.FileShare]::Read -bor [IO.FileShare]::Delete));$held.Add($f);$before=[VerifyInstallFiles]::Metadata($f.SafeFileHandle);[VerifyInstallFiles]::ExactPath($f.SafeFileHandle,$src);if(($before.Attributes -band 0x410) -ne 0 -or $before.Links -ne 1){throw 'PUBLIC_ARCHIVE_TYPE_REFUSED'};$sd=[Convert]::ToBase64String([VerifyInstallFiles]::Security($f.SafeFileHandle));$relative=$src.Substring($spool.Length+1);$dst=Join-Path $archive $relative;Assert-PathAbsent $dst;[IO.File]::Move($src,$dst);$after=[VerifyInstallFiles]::Metadata($f.SafeFileHandle);[VerifyInstallFiles]::ExactPath($f.SafeFileHandle,$dst);if(-not [FormalStageFiles]::Same($before,$after) -or $sd -cne [Convert]::ToBase64String([VerifyInstallFiles]::Security($f.SafeFileHandle))){throw 'ARCHIVE_IDENTITY_CHANGED'}}
 }finally{try{[CluedSession0ScmV2]::EndFixedSession()}finally{for($i=$held.Count-1;$i -ge 0;$i--){$held[$i].Dispose()}}}
}
