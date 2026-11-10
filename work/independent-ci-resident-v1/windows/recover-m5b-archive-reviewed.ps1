<#
TWO FIXED SCENES (DESK 31080 / TURING b2ea) preparation. Disabled without -Preflight or -Run. Production -Run is NOT authorized by an old M5-b grant.
The Owner must first review and approve the exact script, Source hashes and the explicit manual PAUSED operation and temporary disabling/restoring the three existing service start modes.
No account/password/task registration, WSL command, upgrade, Resume, HALT edit or ledger edit is performed.
The final success state is a real service-cleared HALT with the same honest Owner manual PAUSED bytes still present.
The quiet proof holds the qualified identity record, the already loaded HKU registration and the real VHDX exclusively.
#>
[CmdletBinding()]
param([ValidatePattern('^[A-Z]:\\[A-Za-z0-9._\\-]+$')][string]$SourceRoot,[ValidateSet('desk-31080','turing-b2ea')][string]$Scene,[switch]$Run,[switch]$Preflight)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
if(-not $Run -and -not $Preflight){'{"status":"DISABLED"}';return}
if($Run -and $Preflight){throw 'ONE_MODE_ONLY'}

function Get-RecoveryPins([ValidateSet('desk-31080','turing-b2ea')][string]$Scene){
 # No external scene document, path, SID or hash is accepted. The entry checks the selected host and operator before any installed read.
 if(-not $Scene){$Scene=switch -CaseSensitive ([Environment]::MachineName){'DESK-W-591'{'desk-31080'};'TURING'{'turing-b2ea'};default{throw 'RECOVERY_HOST_REFUSED'}}}
 $p=[ordered]@{
  sceneId=$Scene;resident='2a9f66f063ff2e71a1d7a12603b1545dd2c6d60368074b5383ff106f16d6728e'
  rearm='57e274e26abc3962104a233804a8ff7b5bd0b7db66ac93ffb45ea0ea5ad2774c';archiver='c4e556051f52cc57755443042b2eb7ae21ce52bcc3625f9225949bf96bfbf3a2';native='a6c771510b7fb819cd1ff54eb1cf9f5f1a5b3d5c420a217aafb25f5df8df2085'
  reason='owner-m5b-recovery';residentSid='S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
  root='C:\ProgramData\CluedIndependentCI\resident';spool='C:\ProgramData\CluedIndependentCI\formal-spool';stageParent='C:\ProgramData\CluedIndependentCI\resident-launch-m5b-recovery'
  ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';services=@('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker')
  leaves=@('outgoing/active.lock','outgoing/issue.json','outgoing/issue.ready.json')
 }
 $selected=switch -CaseSensitive ($Scene){
  'desk-31080'{[ordered]@{
   machine='DESK-W-591';operator='S-1-5-21-858977881-4031698862-3006450925-1000';companion='S-1-5-21-858977881-4031698862-3006450925-1008';controller='S-1-5-21-858977881-4031698862-3006450925-1007';operatorProfile='C:\Users\Windows';distribution='CluedResident-Linux'
   batch='31080af4ceb1122c31997aa41903b91f8445941ba168833be21609aa896c9178';batchId='31080af4ceb1122c-b28efd37b849';halt='1523b55a286b677a0d11bcbd1af1d8af6aa459eb4298871f0037dcda57e31a52'
   profile='560489f43eb1642047af6bda8754acd484740a8806797e8f6e7bbf0d9d8e2354';scene='238851d06434ec886448f1e8afa6926a91e36d3b117e5ab8ec36279d9671e7a0'
   wslRecord='65d40a0761107b3a187dc9e9d6c8632bd019a73fc34838a65d851c5286bc20e6';vhdx='D:\clued-resident\wsl\CluedResident-Linux\ext4.vhdx'
   serviceConfigs=@{CluedCIUpgrader='3c3d938e3045082d6da325555db74c33b5b23b81ded9cbc335e50e7d3ec1eb23';CluedCIResident='b6818732e4524a1ed1296d350c15ee28d62802aa6d1dca5b41f1a2197c52ee0d';CluedCISwapBroker='df9b094a7feabcd69978a18be5e34b5e382109a9bc65c79b217a730057bc2899'}
  }}
  'turing-b2ea'{[ordered]@{
   machine='TURING';operator='S-1-5-21-1173730660-3877291096-655431861-1001';companion='S-1-5-21-1173730660-3877291096-655431861-1017';controller='S-1-5-21-1173730660-3877291096-655431861-1015';operatorProfile='C:\Users\17531';distribution='Ubuntu-24.04'
   batch='b2ea162eddf7756234f0596beee9a479eb2c9aeb61a8c616e908de2febdfab03';batchId='b2ea162eddf77562-a9e5c4fb6827';halt='2108b842c2aa887737407cdc23becad934d6c05607bbad97843cf975647f5785'
   profile='67b6b61cf1048ecb775092c203c650795c419c039e9e25c05cd6901ea754c5ac';scene='bf998f595f7a8c3eaf55aceb188797798e9109ba68585de5ec7b68e3434fe162'
   wslRecord='cf35c68d978dba09483a1f3ccf19ab49ea71dec542ce9d00559a066cc8303467';vhdx='C:\clued-resident\wsl\Ubuntu-24.04\ext4.vhdx'
   serviceConfigs=@{CluedCIUpgrader='04e0be24aea6bfd41bfa0b4e24fc91ea80ef05c0b33f41075403777c0ad6aa8c';CluedCIResident='a77661629972cfe10c7750d2d69d1b732c99247893c80ef05fbd047ae84c6e70';CluedCISwapBroker='e986a58bdb60456ef41d9e8843242b97319453262ae81f664814074a6fcca81b'}
  }}
  default{throw 'RECOVERY_HOST_REFUSED'}
 }
 foreach($key in $selected.Keys){$p[$key]=$selected[$key]};return $p
}
function Assert-RecoverySceneIdentity($Pins,[string]$Machine,[string]$Sid){
 if($Machine -cne $Pins.machine -or $Sid -cne $Pins.operator){throw 'RECOVERY_HOST_REFUSED'}
}
function Recovery-Hash([byte[]]$Bytes){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Recovery-Bytes($Value){(New-Object Text.UTF8Encoding($false)).GetBytes(($Value|ConvertTo-Json -Depth 16 -Compress)+[char]10)}
function Write-RecoveryNew([string]$Path,[byte[]]$Bytes){$f=[IO.File]::Open($Path,'CreateNew','Write','None');try{$f.Write($Bytes,0,$Bytes.Length);$f.Flush($true)}finally{$f.Dispose()}}
function Get-RecoveryCode($ErrorRecord){
 $known=@('RECOVERY_HOST_REFUSED','RECOVERY_ENVIRONMENT_REFUSED','RECOVERY_SOURCE_REFUSED','RECOVERY_PROTECTION_REFUSED','RECOVERY_INSTALL_REFUSED','RECOVERY_HALT_REFUSED','RECOVERY_TASK_REFUSED','RECOVERY_SERVICE_REFUSED','RECOVERY_RUNNER_REFUSED','RECOVERY_PROCESS_UNKNOWN','RECOVERY_NOT_QUIET','RECOVERY_QUIET_PROOF_REFUSED','RECOVERY_REGISTRATION_REFUSED','RECOVERY_VHDX_LOCK_REFUSED','RECOVERY_PAUSE_REFUSED','RECOVERY_PAUSE_CHANGED','RECOVERY_SCENE_REFUSED','RECOVERY_ARCHIVE_UNCONFIRMED','RECOVERY_RECEIPT_REFUSED','RECOVERY_RESTORE_REFUSED','RECOVERY_REARM_REFUSED','RECOVERY_HALT_NOT_CLEARED')
 $id=$ErrorRecord.FullyQualifiedErrorId.Split(',')[0];if($known -ccontains $id){return $id};return 'RECOVERY_UNCONFIRMED'
}
function New-RecoveryState {
 [ordered]@{contract='clued.independent-ci.m5b-archive-recovery/2';status='PREPARING';phase='PREFLIGHT';code=$null;stage=$null;taskAttempted=$false;servicesAttempted=$false;servicesStopped=@();servicesDisableAttempted=@();pauseAttempted=$false;pauseCreated=$false;pauseSha256=$null;archiveAttempted=$false;archiveChildExit=$null;archiveObservedMoved=$null;archiveVerified=$false;restored=$false;rearmAttempted=$false;rearmRequested=$false;haltCleared=$false;manualRecoveryHeld=$false;at=[DateTimeOffset]::UtcNow.ToString('o')}
}
function Write-RecoveryJournal($Context,[string]$Kind){
 $Context.sequence++
 Write-RecoveryNew (Join-Path $Context.stage ($Context.sequence.ToString('000')+'-'+$Context.state.phase+'-'+$Kind+'.json')) (Recovery-Bytes $Context.state)
}
function Assert-RecoveryPause($Context){
 $path=Join-Path $Context.pins.root 'state\PAUSED.json'
 $bytes=Read-RecoveryProtected $Context $path 16384
 if((Recovery-Hash $bytes) -cne $Context.state.pauseSha256){throw 'RECOVERY_PAUSE_CHANGED'}
}
function New-RecoveryPause($Context){
 $value=[ordered]@{source=[ordered]@{reason='Owner manual recovery pause';by=$Context.pins.operator;recovery=[ordered]@{contract='clued.independent-ci.owner-manual-recovery-pause/1';batchKey=$Context.pins.batch;haltSha256=$Context.pins.halt;operation=$Context.operation}};at=[DateTimeOffset]::UtcNow.ToString('o')}
 $bytes=Recovery-Bytes $value;$Context.state.pauseAttempted=$true
 # CreateNew and existing state-directory inheritance only. No ACL change and no service receipt is fabricated.
 try{Write-RecoveryNew (Join-Path $Context.pins.root 'state\PAUSED.json') $bytes}catch{throw 'RECOVERY_PAUSE_REFUSED'}
 $Context.state.pauseCreated=$true;$Context.state.pauseSha256=Recovery-Hash $bytes
 Assert-RecoveryPause $Context
}
function Invoke-RecoveryCore($Context){
 $proof=$null;$snapshot=$null
 try{
  $Context.state.phase='SAVE';$snapshot=Save-RecoveryOriginal $Context;Write-RecoveryNew (Join-Path $Context.stage 'original-task-and-services.json') (Recovery-Bytes $snapshot);Write-RecoveryJournal $Context 'SAVED'
  $Context.state.phase='TASK';Write-RecoveryJournal $Context 'INTENT';$Context.state.taskAttempted=$true;Stop-RecoveryTask $Context $snapshot;Write-RecoveryJournal $Context 'STOPPED'
  $Context.state.phase='SERVICES';Write-RecoveryJournal $Context 'INTENT';$Context.state.servicesAttempted=$true;Stop-RecoveryServices $Context $snapshot;Write-RecoveryJournal $Context 'STOPPED'
  $Context.state.phase='QUIET';Assert-RecoveryQuiescent $Context $snapshot;$proof=Hold-RecoveryQuietProof $Context $snapshot;Assert-RecoveryQuietProof $Context $proof;Write-RecoveryJournal $Context 'PROVED'
  $Context.state.phase='PAUSE';Write-RecoveryJournal $Context 'INTENT';New-RecoveryPause $Context;Write-RecoveryJournal $Context 'CREATED_AND_READ_BACK'
  $Context.state.phase='ARCHIVE';Assert-RecoveryQuiescent $Context $snapshot;Assert-RecoveryQuietProof $Context $proof;Assert-RecoveryHalt $Context;Assert-RecoveryPause $Context
  $before=Read-RecoveryScene $Context;Write-RecoveryJournal $Context 'INTENT';Assert-RecoveryQuiescent $Context $snapshot;Assert-RecoveryQuietProof $Context $proof;Assert-RecoveryPause $Context;$Context.state.archiveAttempted=$true
  $archive=Invoke-RecoveryArchive $Context;$Context.state.archiveChildExit=$archive.exit;$Context.state.archiveObservedMoved=$archive.value.moved;Confirm-RecoveryArchive $Context $archive $before
  Write-RecoveryJournal $Context 'VERIFIED';$Context.state.archiveVerified=$true
  $proof.Dispose();$proof=$null
  $Context.state.phase='RESTORE';Assert-RecoveryPause $Context;Restore-RecoveryOriginal $Context $snapshot;$Context.state.restored=$true;Write-RecoveryJournal $Context 'RESTORED'
  $Context.state.phase='REARM';Assert-RecoveryHalt $Context;Assert-RecoveryPause $Context;Write-RecoveryJournal $Context 'INTENT';$Context.state.rearmAttempted=$true;Request-RecoveryRearm $Context;$Context.state.rearmRequested=$true;Write-RecoveryJournal $Context 'REQUESTED_ONLY'
  $Context.state.phase='WAIT';Wait-RecoveryRearm $Context;Assert-RecoveryPause $Context;$Context.state.haltCleared=$true
  $Context.state.status='RECOVERED_GLOBAL_PAUSED';$Context.state.phase='DONE';Write-RecoveryJournal $Context 'VERIFIED'
 }catch{
  $Context.state.code=Get-RecoveryCode $_
  $changed=$Context.state.taskAttempted -or $Context.state.servicesAttempted -or $Context.state.pauseAttempted -or $Context.state.archiveAttempted
  $Context.state.status=if($changed){'UNKNOWN_PRESERVED'}else{'REFUSED_BEFORE_MACHINE_ACTION'}
 }finally{
  if($null -ne $proof){try{$proof.Dispose()}catch{$Context.state.status='UNKNOWN_PRESERVED';$Context.state.code='RECOVERY_QUIET_PROOF_REFUSED'}}
  if($null -ne $snapshot -and -not $Context.state.restored -and -not $Context.state.archiveAttempted){
   try{Assert-RecoveryHalt $Context;Restore-RecoveryOriginal $Context $snapshot;$Context.state.restored=$true}catch{$Context.state.status='UNKNOWN_PRESERVED';$Context.state.code='RECOVERY_RESTORE_REFUSED'}
  }
  if(($Context.state.archiveAttempted -or $Context.state.taskAttempted -or $Context.state.servicesAttempted) -and -not $Context.state.restored){$Context.state.manualRecoveryHeld=$true}
  try{Write-RecoveryJournal $Context 'FINAL'}catch{$Context.state.status='UNKNOWN_PRESERVED';$Context.state.code='RECOVERY_JOURNAL_UNCONFIRMED'}
 }
 [pscustomobject]$Context.state
}

# The production entry never accepts a replacement host adapter. Tests load function ASTs into their TEMP-only harness.
function Initialize-RecoveryNative($Context){
 if('CluedSpoolArchiveV2' -as [type] -or 'NodeProfileV2' -as [type]){throw 'RECOVERY_SOURCE_REFUSED'}
 $u=New-Object Text.UTF8Encoding($false,$true);$errors=$null;$tokens=$null
 $ast=[Management.Automation.Language.Parser]::ParseInput($u.GetString($Context.buffers.archive),[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'RECOVERY_SOURCE_REFUSED'}
 $commands=@($ast.FindAll({param($a)$a -is [Management.Automation.Language.CommandAst] -and $a.GetCommandName() -ceq 'Add-Type' -and @($a.CommandElements|Where-Object{$_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -ceq 'TypeDefinition'}).Count -eq 1},$true))
 if($commands.Count -ne 1){throw 'RECOVERY_SOURCE_REFUSED'}
 $body=@($commands[0].CommandElements|Where-Object{$_ -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.StringConstantType -eq 'SingleQuotedHereString'})
 if($body.Count -ne 1 -or -not $body[0].Value.Contains('public static class CluedSpoolArchiveV2')){throw 'RECOVERY_SOURCE_REFUSED'}
 Add-Type -TypeDefinition ($u.GetString($Context.buffers.native)) -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll')
 # Same trusted compilation unit: the recovery-only GR hold uses the pinned archive metadata/path checks.
 Add-Type -TypeDefinition ($body[0].Value + @'
public static class RecoveryReadOnly {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributesW(string p);
 public static SafeFileHandle Open(string p,bool exclusive){var h=CreateFileW(p,exclusive?0xc0020080u:0x80020080u,exclusive?0u:1u,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);if(h.IsInvalid){h.Dispose();throw new IOException(exclusive?"RECOVERY_VHDX_LOCK_REFUSED":"RECOVERY_PROTECTION_REFUSED");}return h;}
 public static SafeFileHandle HoldDirectory(string p){var h=CreateFileW(p,0x80020080u,3u,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);try{if(h.IsInvalid)throw new IOException("RECOVERY_PROTECTION_REFUSED");var m=CluedSpoolArchiveV2.Metadata(h);if((m.Attributes&0x400)!=0||(m.Attributes&0x10)==0)throw new IOException("RECOVERY_PROTECTION_REFUSED");CluedSpoolArchiveV2.ExactPath(h,p);return h;}catch{h.Dispose();throw;}}
 [DllImport("kernel32.dll",SetLastError=true)] static extern RecoveryProcessHandle OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out RecoveryProcessHandle token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(RecoveryProcessHandle token,int info,IntPtr buffer,uint length,out uint required);
 internal static RecoveryProcessOwnerFact UnknownOwner(){return new RecoveryProcessOwnerFact("UNKNOWN",null);}
 internal static RecoveryProcessOwnerFact OpenFailure(uint pid,int error){return pid>0&&error==87?new RecoveryProcessOwnerFact("GONE",null):UnknownOwner();}
 internal static RecoveryProcessOwnerFact FailedOwnerWait(uint state){return state==0?new RecoveryProcessOwnerFact("GONE",null):UnknownOwner();}
 internal static string DecodeTokenUser(IntPtr buffer,uint length){
  if(buffer==IntPtr.Zero||length<(uint)(IntPtr.Size+4)||length>65536)return null;
  long start=buffer.ToInt64(),end;try{end=checked(start+length);}catch{return null;}
  long sid=Marshal.ReadIntPtr(buffer).ToInt64();if(sid<start+IntPtr.Size+4||sid>end-8)return null;
  if(Marshal.ReadByte(new IntPtr(sid),0)!=1)return null;int count=Marshal.ReadByte(new IntPtr(sid),1);if(count>15)return null;int bytes=8+4*count;if(sid>end-bytes)return null;
  var raw=new byte[bytes];Marshal.Copy(new IntPtr(sid),raw,0,bytes);
  try{return new System.Security.Principal.SecurityIdentifier(raw,0).Value;}catch{return null;}
 }
 public static RecoveryProcessHandle OpenProcessForOwner(uint pid,out int error){
  error=0;if(pid==0){error=87;return null;}
  var h=OpenProcess(0x00101000u,false,pid);if(h==null||h.IsInvalid){error=Marshal.GetLastWin32Error();if(h!=null)h.Dispose();return null;}return h;
 }
 public static RecoveryProcessOwnerFact ProcessOwner(uint pid){
  if(pid==0)return UnknownOwner();int error;using(var h=OpenProcessForOwner(pid,out error)){return h==null?OpenFailure(pid,error):ProcessOwnerFromHandle(h);}
 }
 public static RecoveryProcessOwnerFact ProcessOwnerFromHandle(RecoveryProcessHandle process){
  if(process==null||process.IsClosed||process.IsInvalid)return UnknownOwner();bool held=false;
  try{process.DangerousAddRef(ref held);IntPtr p=process.DangerousGetHandle();if(GetProcessId(p)==0)return UnknownOwner();
   uint state=WaitForSingleObject(p,0);if(state==0)return new RecoveryProcessOwnerFact("GONE",null);if(state!=258)return UnknownOwner();
   RecoveryProcessHandle token=null;IntPtr buffer=IntPtr.Zero;
   try{
    if(!OpenProcessToken(p,8u,out token))return FailedOwnerWait(WaitForSingleObject(p,0));
    uint size;if(GetTokenInformation(token,1,IntPtr.Zero,0,out size)||Marshal.GetLastWin32Error()!=122||size<(uint)(IntPtr.Size+4)||size>65536)return FailedOwnerWait(WaitForSingleObject(p,0));
    buffer=Marshal.AllocHGlobal((int)size);uint got;if(!GetTokenInformation(token,1,buffer,size,out got)||got>size)return FailedOwnerWait(WaitForSingleObject(p,0));
    string sid=DecodeTokenUser(buffer,got);if(sid==null)return FailedOwnerWait(WaitForSingleObject(p,0));
    state=WaitForSingleObject(p,0);if(state==0)return new RecoveryProcessOwnerFact("GONE",null);return state==258?new RecoveryProcessOwnerFact("OWNER",sid):UnknownOwner();
   }catch{return FailedOwnerWait(WaitForSingleObject(p,0));}
   finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=null)token.Dispose();}
  }catch{return UnknownOwner();}finally{if(held)process.DangerousRelease();}
 }
 public static bool Absent(string p){uint a=GetFileAttributesW(p);if(a!=0xffffffffu)return false;if(Marshal.GetLastWin32Error()==2)return true;throw new IOException("RECOVERY_PROTECTION_REFUSED");}
}
public sealed class RecoveryProcessHandle : Microsoft.Win32.SafeHandles.SafeHandleZeroOrMinusOneIsInvalid {
 public RecoveryProcessHandle():base(true){}
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 protected override bool ReleaseHandle(){return CloseHandle(handle);}
}
public sealed class RecoveryProcessOwnerFact {
 public readonly string Status,Sid;
 internal RecoveryProcessOwnerFact(string status,string sid){Status=status;Sid=sid;}
}
'@)
}
function Assert-RecoveryManagerAcl($Context,[byte[]]$Bytes,[string]$Path){
 $root=Join-Path $Context.pins.root 'state'
 $spool=$Context.pins.spool
 $mailbox=Join-Path $Context.pins.root 'mailbox'
 $archive='^'+[regex]::Escape($spool+'\failed-'+$Context.pins.batch.Substring(0,12)+'-')+'(?:owner-m5b-recovery|rearm-unknown-failure)-[0-9a-f]{12}(?:\\archive-receipt\.json)?$'
 if(-not ($Path -ieq $root -or $Path.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase) -or $Path -ieq $spool -or $Path -ieq ($spool+'\outgoing') -or $Path -ieq ($spool+'\incoming') -or $Path -ieq $mailbox -or $Path.StartsWith($mailbox+'\',[StringComparison]::OrdinalIgnoreCase) -or $Path -cmatch $archive)){[NodeProfilePublicFileV2]::ValidateBootstrapAcl($Bytes,$Path);return}
 $sd=New-Object Security.AccessControl.RawSecurityDescriptor($Bytes,0);$res='S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';$admins=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
 $comp=$Context.pins.companion;$response=$Path -ieq ($mailbox+'\responses') -or $Path.StartsWith($mailbox+'\responses\',[StringComparison]::OrdinalIgnoreCase)
 $owners=@($admins+$res);if($response){$owners+=,$comp};if($null -eq $sd.Owner -or $owners -notcontains $sd.Owner.Value -or $null -eq $sd.DiscretionaryAcl){throw 'RECOVERY_PROTECTION_REFUSED'}
 $resMask=if($Path -ieq $spool){0x1200a5}elseif($Path -ieq ($spool+'\outgoing') -or $Path -ieq ($spool+'\incoming')){0x1200e1}else{0x1301bf}
 foreach($a in $sd.DiscretionaryAcl){if($a -isnot [Security.AccessControl.CommonAce] -or $a.IsCallback){throw 'RECOVERY_PROTECTION_REFUSED'};if($a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$a.AceFlags -band 8) -ne 0){continue};$mask=[int]$a.AccessMask;$sid=$a.SecurityIdentifier.Value;if($sid -ceq $res -and ($mask -band (-bnot $resMask)) -eq 0){continue};if((($response -and ($sid -ceq $comp)) -or (($Path -ieq ($spool+'\outgoing')) -and ($sid -ceq $Context.pins.controller)) -or (($Path -ieq ($spool+'\incoming')) -and ($sid -ceq $comp))) -and ($mask -band (-bnot 0x1301bf)) -eq 0){continue};if($admins -notcontains $sid -and ($mask -band 0x500d0156) -ne 0){throw 'RECOVERY_PROTECTION_REFUSED'}}
}
function Hold-RecoveryPath($Context,[string]$Path){
 $parents=New-Object Collections.Generic.List[string];for($p=[IO.Path]::GetDirectoryName($Path);$p;$p=[IO.Path]::GetDirectoryName($p)){$parents.Insert(0,$p)}
 foreach($p in $parents){$h=[RecoveryReadOnly]::HoldDirectory($p);$Context.held.Add($h);Assert-RecoveryManagerAcl $Context ([CluedSpoolArchiveV2]::Security($h)) $p}
}
function Read-RecoveryProtected($Context,[string]$Path,[int]$Max){
 Hold-RecoveryPath $Context $Path;$h=[RecoveryReadOnly]::Open($Path,$false)
 try{
  $m=[CluedSpoolArchiveV2]::Metadata($h);[CluedSpoolArchiveV2]::ExactPath($h,$Path)
  if(($m.Attributes -band 0x410) -ne 0 -or $m.Links -ne 1 -or $m.SizeHigh -ne 0 -or $m.SizeLow -gt $Max){throw 'RECOVERY_PROTECTION_REFUSED'}
  $acl=[CluedSpoolArchiveV2]::Security($h);Assert-RecoveryManagerAcl $Context $acl $Path
  $f=New-Object IO.FileStream($h,[IO.FileAccess]::Read)
  try{$bytes=New-Object byte[] ([int]$m.SizeLow);$at=0;while($at -lt $bytes.Length){$n=$f.Read($bytes,$at,$bytes.Length-$at);if($n -lt 1){throw 'RECOVERY_PROTECTION_REFUSED'};$at+=$n}
   if(-not [CluedSpoolArchiveV2]::Stable($m,[CluedSpoolArchiveV2]::Metadata($h)) -or [Convert]::ToBase64String($acl) -cne [Convert]::ToBase64String([CluedSpoolArchiveV2]::Security($h))){throw 'RECOVERY_PROTECTION_REFUSED'}
   return ,$bytes
  }finally{$f.Dispose()}
 }finally{$h.Dispose()}
}
function Read-RecoveryJson($Context,[string]$Path,[int]$Max=4194304){$b=Read-RecoveryProtected $Context $Path $Max;(New-Object Text.UTF8Encoding($false,$true)).GetString($b)|ConvertFrom-Json}
function Assert-RecoveryHalt($Context){
 $b=Read-RecoveryProtected $Context (Join-Path $Context.pins.root 'state\HALT.json') 16384
 if((Recovery-Hash $b) -cne $Context.pins.halt){throw 'RECOVERY_HALT_REFUSED'}
 $h=(New-Object Text.UTF8Encoding($false,$true)).GetString($b)|ConvertFrom-Json
 if($h.code -cne 'FAILURE_ARCHIVE_UNCONFIRMED' -or $h.clearedOnlyBy -cne 'owner-rearm' -or $h.facts.key -cne $Context.pins.batch -or $h.facts.windowsArchiveCode -cne 'EXACT_FIXED_ACCESS_ACES_REQUIRED'){throw 'RECOVERY_HALT_REFUSED'}
}
function Read-RecoveryTask($Context){$svc=New-Object -ComObject Schedule.Service;$svc.Connect();$svc.GetFolder('\Clued').GetTask('CluedCIResidentCompanion')}
function Recovery-TaskFingerprint($Task){
 $xml=New-Object Xml.XmlDocument;$xml.XmlResolver=$null;$xml.LoadXml([string]$Task.Xml)
 $settings=$xml.SelectNodes("//*[local-name()='Settings']")
 if($settings.Count -ne 1){throw 'RECOVERY_TASK_REFUSED'}
 $nodes=$settings[0].SelectNodes("./*[local-name()='Enabled']")
 if($nodes.Count -gt 1){throw 'RECOVERY_TASK_REFUSED'}
 if($nodes.Count -eq 1){$null=$settings[0].RemoveChild($nodes[0])}
 # Normalize only the empty Settings serialization (<Settings/> versus <Settings></Settings>), without changing its contents.
 $settings[0].IsEmpty=$false
 Recovery-Hash ((New-Object Text.UTF8Encoding($false)).GetBytes($xml.OuterXml))
}
function Assert-RecoveryTask($Context,$Task){
 $def=$Task.Definition;$user=[string]$def.Principal.UserId
 if($user.StartsWith('S-1-')){$sid=$user}else{$sid=(New-Object Security.Principal.NTAccount($user)).Translate([Security.Principal.SecurityIdentifier]).Value}
 if($sid -cne $Context.pins.companion -or [int]$def.Principal.LogonType -ne 1 -or [int]$def.Principal.RunLevel -ne 0 -or $def.Actions.Count -ne 1){throw 'RECOVERY_TASK_REFUSED'}
 $a=$def.Actions.Item(1)
 if($a.Path -cne (Join-Path $Context.pins.root 'bin\CluedCompanionSupervisor.exe') -or $a.Arguments -cne ('"'+$Context.pins.root+'"')){throw 'RECOVERY_TASK_REFUSED'}
 $sd=New-Object Security.AccessControl.RawSecurityDescriptor([string]$Task.GetSecurityDescriptor(5));$admins=@('S-1-5-18','S-1-5-32-544')
 if($null -eq $sd.Owner -or $admins -notcontains $sd.Owner.Value -or $null -eq $sd.DiscretionaryAcl){throw 'RECOVERY_TASK_REFUSED'}
 foreach($ace in $sd.DiscretionaryAcl){if($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback){throw 'RECOVERY_TASK_REFUSED'};if($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $admins -notcontains $ace.SecurityIdentifier.Value -and ([int]$ace.AccessMask -band 0x500d0156) -ne 0){throw 'RECOVERY_TASK_REFUSED'}}
}
function Recovery-ServiceDacl([string]$Sddl){
 try{$sd=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)}catch{throw 'RECOVERY_SERVICE_REFUSED'}
 if($null -eq $sd.DiscretionaryAcl){throw 'RECOVERY_SERVICE_REFUSED'}
 $sd.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
}
function Read-RecoveryService([string]$Name){
 $rows=@(Get-CimInstance Win32_Service -Filter ("Name='"+$Name+"'") -ErrorAction Stop)
 if($rows.Count -ne 1){throw 'RECOVERY_SERVICE_REFUSED'}
 $s=$rows[0];$sddl=& 'C:\Windows\System32\sc.exe' sdshow $Name
 if($LASTEXITCODE -ne 0){throw 'RECOVERY_SERVICE_REFUSED'}
 $rk=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(('SYSTEM\CurrentControlSet\Services\'+$Name),$false);if($null -eq $rk){throw 'RECOVERY_SERVICE_REFUSED'};try{$delayed=$rk.GetValue('DelayedAutoStart',0,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($delayed -isnot [int] -or $delayed -notin @(0,1)){throw 'RECOVERY_SERVICE_REFUSED'}}finally{$rk.Dispose()}
 $d=@($sddl|Where-Object{$_ -match '^D:'});if($d.Count -ne 1){throw 'RECOVERY_SERVICE_REFUSED'}
 $full=[string]$d[0];$dacl=Recovery-ServiceDacl $full
 [pscustomobject]@{name=$Name;state=[string]$s.State;pid=[int]$s.ProcessId;config=(Recovery-Hash (Recovery-Bytes @([string]$s.PathName,[string]$s.StartName,[string]$s.StartMode,$dacl)));binary=[string]$s.PathName;account=[string]$s.StartName;startMode=[string]$s.StartMode;sddl=$full;delayedAutoStart=[bool]$delayed}
}
function Assert-RecoveryRunner($Context){
 $r=Read-RecoveryService $Context.node.runnerService
 if($r.state -cne 'Stopped' -or $r.pid -ne 0 -or $r.startMode -cne 'Manual' -or $r.binary -cne '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"' -or @('.\clued-control',($Context.pins.machine+'\clued-control')) -cnotcontains $r.account -or (Recovery-ServiceDacl $r.sddl) -cne (Recovery-ServiceDacl $Context.install.runnerSddlUnchanged)){throw 'RECOVERY_RUNNER_REFUSED'}
 if($null -ne $Context.runner -and ($r.config -cne $Context.runner.config -or $r.sddl -cne $Context.runner.sddl)){throw 'RECOVERY_RUNNER_REFUSED'};$r
}
function Save-RecoveryOriginal($Context){
 Assert-RecoveryHalt $Context;if(-not [RecoveryReadOnly]::Absent((Join-Path $Context.pins.root 'state\PAUSED.json'))){throw 'RECOVERY_PAUSE_REFUSED'};$task=Read-RecoveryTask $Context;Assert-RecoveryTask $Context $task
 if($task.Enabled -isnot [bool]){throw 'RECOVERY_TASK_REFUSED'}
 $running=$task.GetInstances(0).Count -gt 0;if($running -and -not $task.Enabled){throw 'RECOVERY_TASK_REFUSED'}
 $snap=[ordered]@{enabled=$task.Enabled;running=$running;taskHash=(Recovery-TaskFingerprint $task);services=@()}
 foreach($name in $Context.pins.services){$s=Read-RecoveryService $name
  $image=if($name -ceq 'CluedCIUpgrader'){'upgrader\bin\UpgraderServiceHost.exe'}elseif($name -ceq 'CluedCIResident'){'bin\ResidentServiceHost.exe'}else{'bin\SwapBroker.exe'}
  $account=if($name -ceq 'CluedCIResident'){'NT SERVICE\CluedCIResident'}else{'LocalSystem'}
  if(@('Running','Stopped') -cnotcontains $s.state -or $s.config -cne $Context.pins.serviceConfigs[$name] -or -not $s.binary.Contains((Join-Path $Context.pins.root $image)) -or $s.account -cne $account -or $s.startMode -cne 'Auto' -or ($name -ceq 'CluedCIResident' -and -not $s.binary.Contains((Join-Path $Context.pins.root ('resident\'+$Context.pins.resident+'\src\service-main.mjs'))))){throw 'RECOVERY_SERVICE_REFUSED'};$snap.services+=,$s
 }
 $Context.runner=Assert-RecoveryRunner $Context;$snap
}
function Stop-RecoveryTask($Context,$Snapshot){
 $t=Read-RecoveryTask $Context;if((Recovery-TaskFingerprint $t) -cne $Snapshot.taskHash){throw 'RECOVERY_TASK_REFUSED'}
 $t.Enabled=$false
 $t=Read-RecoveryTask $Context;if($t.Enabled -ne $false -or (Recovery-TaskFingerprint $t) -cne $Snapshot.taskHash){throw 'RECOVERY_TASK_REFUSED'}
 try{$t.Stop(0)}catch{$e=$_.Exception;while($null -ne $e.InnerException){$e=$e.InnerException};if($e.HResult -ne -2147216629 -or $t.GetInstances(0).Count -ne 0){throw 'RECOVERY_TASK_REFUSED'}}
 $until=[DateTime]::UtcNow.AddSeconds(60)
 do{$t=Read-RecoveryTask $Context;if($t.Enabled -ne $false){throw 'RECOVERY_TASK_REFUSED'};if($t.GetInstances(0).Count -eq 0){return};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $until)
 throw 'RECOVERY_TASK_REFUSED'
}
function Assert-RecoveryServiceConfig($Now,$Before,[bool]$Disabled){
 $mode=if($Disabled){'Disabled'}else{$Before.startMode}
 $expected=Recovery-Hash (Recovery-Bytes @($Before.binary,$Before.account,$mode,(Recovery-ServiceDacl $Before.sddl)))
 if($Now.binary -cne $Before.binary -or $Now.account -cne $Before.account -or $Now.sddl -cne $Before.sddl -or $Now.startMode -cne $mode -or $Now.delayedAutoStart -isnot [bool] -or $Now.delayedAutoStart -ne $Before.delayedAutoStart -or $Now.config -cne $expected){throw 'RECOVERY_SERVICE_REFUSED'}
}
function Set-RecoveryServiceStart($Before,[bool]$Disabled){
 # Fixed existing service only. sc config changes start mode, never credentials, failure actions, binary or ACL.
 $mode=if($Disabled){'disabled'}elseif($Before.startMode -ceq 'Auto' -and $Before.delayedAutoStart){'delayed-auto'}elseif($Before.startMode -ceq 'Auto'){'auto'}else{throw 'RECOVERY_SERVICE_REFUSED'}
 $null=& 'C:\Windows\System32\sc.exe' config $Before.name start= $mode
 if($LASTEXITCODE -ne 0){throw 'RECOVERY_SERVICE_REFUSED'}
 Assert-RecoveryServiceConfig (Read-RecoveryService $Before.name) $Before $Disabled
}
function Stop-RecoveryServices($Context,$Snapshot){
 # Disable all three before stopping any: SCM queued failure-restart actions survive an ordinary Stop.
 foreach($before in $Snapshot.services){Assert-RecoveryServiceConfig (Read-RecoveryService $before.name) $before $false;$Context.state.servicesDisableAttempted+=,$before.name;Set-RecoveryServiceStart $before $true}
 foreach($before in $Snapshot.services){$now=Read-RecoveryService $before.name;Assert-RecoveryServiceConfig $now $before $true
  $sent=$false;if($now.state -ceq 'Running'){if($now.pid -ne $before.pid){throw 'RECOVERY_SERVICE_REFUSED'};Stop-Service -Name $before.name -ErrorAction Stop;$sent=$true}
  $until=[DateTime]::UtcNow.AddSeconds(120)
  do{$now=Read-RecoveryService $before.name;Assert-RecoveryServiceConfig $now $before $true;if($now.state -ceq 'Stopped' -and $now.pid -eq 0){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $until)
  if($now.state -cne 'Stopped' -or $now.pid -ne 0 -or ($before.pid -gt 0 -and $null -ne (Get-Process -Id $before.pid -ErrorAction SilentlyContinue))){throw 'RECOVERY_SERVICE_REFUSED'}
  if($sent){$Context.state.servicesStopped+=,$before.name}
 }
}
function Read-RecoveryNativeProcessOwner([uint32]$ProcessId){[RecoveryReadOnly]::ProcessOwner($ProcessId)}
function Read-RecoveryProcessOwnerSids{
 $rows=@(Get-CimInstance Win32_Process -Property ProcessId -ErrorAction Stop);if($rows.Count -eq 0 -or @($rows|Where-Object{[int]$_.ProcessId -eq $PID}).Count -ne 1){throw 'RECOVERY_PROCESS_UNKNOWN'}
 $sids=@();foreach($p in $rows){
  if([int]$p.ProcessId -in @(0,4)){continue} # Original reserved kernel/idle exceptions only.
  $native=$null;try{$native=Read-RecoveryNativeProcessOwner ([uint32]$p.ProcessId)}catch{$native=$null}
  if($null -ne $native -and $native.Status -ceq 'GONE'){continue}
  if($null -ne $native -and $native.Status -ceq 'OWNER'){$sid=$native.Sid}
  elseif($null -eq $native -or $native.Status -ceq 'UNKNOWN'){
   try{$owner=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop}catch{throw 'RECOVERY_PROCESS_UNKNOWN'}
   if($owner.ReturnValue -ne 0 -or $owner.Sid -isnot [string]){throw 'RECOVERY_PROCESS_UNKNOWN'};$sid=$owner.Sid
  }else{throw 'RECOVERY_PROCESS_UNKNOWN'}
  if($sid -isnot [string]){throw 'RECOVERY_PROCESS_UNKNOWN'};try{$validSid=New-Object Security.Principal.SecurityIdentifier($sid);if($validSid.Value -cne $sid){throw 'RECOVERY_PROCESS_UNKNOWN'}}catch{throw 'RECOVERY_PROCESS_UNKNOWN'}
  $sids+=,$sid
 }
 return ,$sids
}
function Assert-RecoveryNoProducers($Context){
 foreach($sid in (Read-RecoveryProcessOwnerSids)){if(@($Context.pins.companion,$Context.pins.controller,$Context.pins.residentSid) -ccontains $sid){throw 'RECOVERY_NOT_QUIET'}}
}
function Assert-RecoveryQuiescent($Context,$Snapshot){
 $t=Read-RecoveryTask $Context;if($t.Enabled -ne $false -or $t.GetInstances(0).Count -ne 0 -or (Recovery-TaskFingerprint $t) -cne $Snapshot.taskHash){throw 'RECOVERY_NOT_QUIET'}
 foreach($s in $Snapshot.services){$now=Read-RecoveryService $s.name;if($now.state -cne 'Stopped' -or $now.pid -ne 0 -or $now.startMode -cne 'Disabled'){throw 'RECOVERY_NOT_QUIET'};Assert-RecoveryServiceConfig $now $s $true}
 $null=Assert-RecoveryRunner $Context;Assert-RecoveryNoProducers $Context
}
function Open-RecoveryUsersHive{[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::Users,[Microsoft.Win32.RegistryView]::Registry64)}
function Open-RecoveryRegistration($Context){
 $users=Open-RecoveryUsersHive;$Context.held.Add($users);$Context.registrationUsers=$users;$Context.registrationPath=$Context.pins.companion+'\Software\Microsoft\Windows\CurrentVersion\Lxss'
 $lxss=$users.OpenSubKey($Context.registrationPath,$false)
 if($null -eq $lxss){throw 'RECOVERY_REGISTRATION_REFUSED'};$Context.held.Add($lxss);$found=@()
 foreach($name in $lxss.GetSubKeyNames()){$key=$lxss.OpenSubKey($name,$false);if($null -eq $key){throw 'RECOVERY_REGISTRATION_REFUSED'}
  if($key.GetValue('DistributionName',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq $Context.node.WslDistribution){$guid=[guid]::Empty;if(-not [guid]::TryParse($name,[ref]$guid)){$key.Dispose();throw 'RECOVERY_REGISTRATION_REFUSED'};$found+=,[pscustomobject]@{key=$key;name=$name;parent=$lxss}}
  else{$key.Dispose()}
 }
 if($found.Count -ne 1){foreach($f in $found){$f.key.Dispose()};throw 'RECOVERY_REGISTRATION_REFUSED'}
 $Context.held.Add($found[0].key);$Context.registration=$found[0];Assert-RecoveryRegistration $Context
}
function Assert-RecoveryRegistration($Context){
 $r=$Context.registration;if($null -eq $r){throw 'RECOVERY_REGISTRATION_REFUSED'}
 # Reopen the current namespace as well as the held key: a held registry handle alone does not prevent key replacement.
 $fresh=$Context.registrationUsers.OpenSubKey($Context.registrationPath,$false);if($null -eq $fresh){throw 'RECOVERY_REGISTRATION_REFUSED'}
 try{
  $current=@();foreach($name in $fresh.GetSubKeyNames()){$k=$fresh.OpenSubKey($name,$false);if($null -eq $k){throw 'RECOVERY_REGISTRATION_REFUSED'};try{if($k.GetValue('DistributionName',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq $Context.node.WslDistribution){$current+=,$name}}finally{$k.Dispose()}}
  if($current.Count -ne 1 -or $current[0] -cne $r.name){throw 'RECOVERY_REGISTRATION_REFUSED'}
  $currentKey=$fresh.OpenSubKey($r.name,$false);if($null -eq $currentKey){throw 'RECOVERY_REGISTRATION_REFUSED'}
  try{foreach($value in @('DistributionName','BasePath','VhdFileName')){if($currentKey.GetValue($value,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $r.key.GetValue($value,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)){throw 'RECOVERY_REGISTRATION_REFUSED'}}}finally{$currentKey.Dispose()}
 }finally{$fresh.Dispose()}
 $names=@();foreach($name in $r.parent.GetSubKeyNames()){$k=$r.parent.OpenSubKey($name,$false);if($null -eq $k){throw 'RECOVERY_REGISTRATION_REFUSED'};try{if($k.GetValue('DistributionName',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -ceq $Context.node.WslDistribution){$names+=,$name}}finally{$k.Dispose()}}
 $d=$r.key.GetValue('DistributionName',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$base=$r.key.GetValue('BasePath',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$file=$r.key.GetValue('VhdFileName',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
 if($names.Count -ne 1 -or $names[0] -cne $r.name -or $d -cne $Context.node.WslDistribution -or $base -isnot [string] -or ($null -ne $file -and $file -cne 'ext4.vhdx')){throw 'RECOVERY_REGISTRATION_REFUSED'}
 if($base.StartsWith('\\?\')){$base=$base.Substring(4)}
 if(-not [string]::Equals([IO.Path]::GetFullPath((Join-Path $base 'ext4.vhdx')),$Context.pins.vhdx,[StringComparison]::OrdinalIgnoreCase)){throw 'RECOVERY_REGISTRATION_REFUSED'}
}
function Hold-RecoveryWslRecord($Context){
 $path=Join-Path $Context.pins.root 'install\companion-wsl.json';Hold-RecoveryPath $Context $path;$h=[RecoveryReadOnly]::Open($path,$false);$Context.held.Add($h)
 $m=[CluedSpoolArchiveV2]::Metadata($h);[CluedSpoolArchiveV2]::ExactPath($h,$path)
 if(($m.Attributes -band 0x410) -ne 0 -or $m.Links -ne 1 -or $m.SizeHigh -ne 0 -or $m.SizeLow -gt 65536){throw 'RECOVERY_QUIET_PROOF_REFUSED'}
 $acl=[CluedSpoolArchiveV2]::Security($h);Assert-RecoveryManagerAcl $Context $acl $path;$f=New-Object IO.FileStream($h,[IO.FileAccess]::Read);$Context.held.Add($f)
 $b=New-Object byte[] ([int]$m.SizeLow);$at=0;while($at -lt $b.Length){$n=$f.Read($b,$at,$b.Length-$at);if($n -lt 1){throw 'RECOVERY_QUIET_PROOF_REFUSED'};$at+=$n}
 if((Recovery-Hash $b) -cne $Context.pins.wslRecord){throw 'RECOVERY_QUIET_PROOF_REFUSED'}
 $w=(New-Object Text.UTF8Encoding($false,$true)).GetString($b)|ConvertFrom-Json
 if($w.contract -cne 'clued.independent-ci.companion-wsl/1' -or $w.stage -cne 'qualified' -or $w.companionSid -cne $Context.pins.companion -or $w.distro -cne $Context.node.WslDistribution -or $w.target -cne $Context.pins.vhdx){throw 'RECOVERY_QUIET_PROOF_REFUSED'}
 $Context.wslRecordLease=[pscustomobject]@{path=$path;handle=$h;meta=$m;acl=[Convert]::ToBase64String($acl)}
}
function Assert-RecoveryWslRecord($Context){$r=$Context.wslRecordLease;[CluedSpoolArchiveV2]::ExactPath($r.handle,$r.path);if(-not [CluedSpoolArchiveV2]::Stable($r.meta,[CluedSpoolArchiveV2]::Metadata($r.handle)) -or $r.acl -cne [Convert]::ToBase64String([CluedSpoolArchiveV2]::Security($r.handle))){throw 'RECOVERY_QUIET_PROOF_REFUSED'}}
function Assert-RecoveryVhdAcl($Context,[byte[]]$Bytes,[string]$Path){
 $sd=New-Object Security.AccessControl.RawSecurityDescriptor($Bytes,0);$admins=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
 if($null -eq $sd.Owner -or $admins -notcontains $sd.Owner.Value -or $null -eq $sd.DiscretionaryAcl){throw 'RECOVERY_PROTECTION_REFUSED'}
 $leaf=$Path -ieq $Context.pins.vhdx -or $Path -ieq [IO.Path]::GetDirectoryName($Context.pins.vhdx)
 # The accepted headless writer gives only ext4.vhdx Modify|WRITE_DAC; its parent stays Modify.
 $companionMask=if($Path -ieq $Context.pins.vhdx){0x1701bf}else{0x1301bf}
 $danger=if($Path -ieq [IO.Path]::GetPathRoot($Context.pins.vhdx)){0x100d0040}else{0x500d0156}
 foreach($a in $sd.DiscretionaryAcl){if($a -isnot [Security.AccessControl.CommonAce] -or $a.IsCallback){throw 'RECOVERY_PROTECTION_REFUSED'};if($a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$a.AceFlags -band 8) -ne 0){continue};$sid=$a.SecurityIdentifier.Value;$mask=[int]$a.AccessMask;if($leaf -and $sid -ceq $Context.pins.companion -and ($mask -band (-bnot $companionMask)) -eq 0){continue};if($admins -notcontains $sid -and ($mask -band $danger) -ne 0){throw 'RECOVERY_PROTECTION_REFUSED'}}
}
function Hold-RecoveryQuietProof($Context,$Snapshot){
 Assert-RecoveryRegistration $Context;Assert-RecoveryWslRecord $Context
 $parents=New-Object 'Collections.Generic.List[IDisposable]';$entries=@();$disk=$null
 try{
  $chain=New-Object Collections.Generic.List[string];for($p=[IO.Path]::GetDirectoryName($Context.pins.vhdx);$p;$p=[IO.Path]::GetDirectoryName($p)){$chain.Insert(0,$p)}
  foreach($p in $chain){$h=[RecoveryReadOnly]::HoldDirectory($p);$parents.Add($h);$acl=[CluedSpoolArchiveV2]::Security($h);Assert-RecoveryVhdAcl $Context $acl $p;$entries+=,[pscustomobject]@{path=$p;handle=$h;meta=[CluedSpoolArchiveV2]::Metadata($h);acl=[Convert]::ToBase64String($acl)}}
  $until=[DateTime]::UtcNow.AddSeconds(120)
  do{$h=$null;try{$h=[RecoveryReadOnly]::Open($Context.pins.vhdx,$true);$disk=New-Object IO.FileStream($h,[IO.FileAccess]::ReadWrite);break}catch{if($null -ne $h){$h.Dispose()};Start-Sleep -Milliseconds 250}}while([DateTime]::UtcNow -lt $until)
  if($null -eq $disk){throw 'RECOVERY_VHDX_LOCK_REFUSED'}
  $m=[CluedSpoolArchiveV2]::Metadata($disk.SafeFileHandle);[CluedSpoolArchiveV2]::ExactPath($disk.SafeFileHandle,$Context.pins.vhdx);if(($m.Attributes -band 0x410) -ne 0 -or $m.Links -ne 1){throw 'RECOVERY_QUIET_PROOF_REFUSED'};Assert-RecoveryVhdAcl $Context ([CluedSpoolArchiveV2]::Security($disk.SafeFileHandle)) $Context.pins.vhdx
  $proof=[pscustomobject]@{disk=$disk;meta=$m;parents=$parents;entries=$entries;path=$Context.pins.vhdx;acl=[Convert]::ToBase64String([CluedSpoolArchiveV2]::Security($disk.SafeFileHandle))}
  $proof|Add-Member ScriptMethod Dispose {if($null -ne $this.disk){$this.disk.Dispose();$this.disk=$null};for($i=$this.parents.Count-1;$i -ge 0;$i--){$this.parents[$i].Dispose()}}
  Assert-RecoveryQuietProof $Context $proof;return $proof
 }catch{if($null -ne $disk){$disk.Dispose()};for($i=$parents.Count-1;$i -ge 0;$i--){$parents[$i].Dispose()};throw}
}
function Assert-RecoveryQuietProof($Context,$Proof){
 if($null -eq $Proof -or $null -eq $Proof.disk -or $Proof.disk.SafeFileHandle.IsClosed){throw 'RECOVERY_QUIET_PROOF_REFUSED'}
 Assert-RecoveryRegistration $Context;Assert-RecoveryWslRecord $Context
 foreach($r in @($Proof.entries)+@([pscustomobject]@{path=$Proof.path;handle=$Proof.disk.SafeFileHandle;meta=$Proof.meta;acl=$Proof.acl})){
  [CluedSpoolArchiveV2]::ExactPath($r.handle,$r.path);if(-not [CluedSpoolArchiveV2]::Stable($r.meta,[CluedSpoolArchiveV2]::Metadata($r.handle)) -or $r.acl -cne [Convert]::ToBase64String([CluedSpoolArchiveV2]::Security($r.handle))){throw 'RECOVERY_QUIET_PROOF_REFUSED'}
 }
}
function Read-RecoveryLeafFact([string]$Path,[string]$Name){
 $h=[RecoveryReadOnly]::Open($Path,$false)
  try{$m=[CluedSpoolArchiveV2]::Metadata($h);[CluedSpoolArchiveV2]::ExactPath($h,$path);if(($m.Attributes -band 0x410) -ne 0 -or $m.Links -ne 1 -or $m.SizeHigh -ne 0 -or $m.SizeLow -gt 1048576){throw 'RECOVERY_SCENE_REFUSED'}
   $f=New-Object IO.FileStream($h,[IO.FileAccess]::Read);try{$b=New-Object byte[] ([int]$m.SizeLow);$n=0;while($n -lt $b.Length){$got=$f.Read($b,$n,$b.Length-$n);if($got -lt 1){throw 'RECOVERY_SCENE_REFUSED'};$n+=$got};$sd=New-Object Security.AccessControl.RawSecurityDescriptor([CluedSpoolArchiveV2]::Security($h),0)
    $aces=@($sd.DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value+'|'+$_.AccessMask+'|'+$_.AceQualifier+'|'+([int]$_.AceFlags -band -bnot 16)}|Sort-Object)
    [pscustomobject]@{from=$Name;bytes=$b.Length;sha256=(Recovery-Hash $b);volume=$m.Volume;idHigh=$m.IndexHigh;idLow=$m.IndexLow;owner=$sd.Owner.Value;group=$sd.Group.Value;aces=($aces -join ';')}
   }finally{$f.Dispose()}
  }finally{$h.Dispose()}
}
function Read-RecoveryScene($Context){
 foreach($d in @($Context.pins.spool,(Join-Path $Context.pins.spool 'incoming'),(Join-Path $Context.pins.spool 'outgoing'))){$h=[RecoveryReadOnly]::HoldDirectory($d);$Context.held.Add($h);Assert-RecoveryManagerAcl $Context ([CluedSpoolArchiveV2]::Security($h)) $d}
 $rows=@();foreach($name in $Context.pins.leaves){$rows+=,(Read-RecoveryLeafFact (Join-Path $Context.pins.spool $name.Replace('/','\')) $name)}
 $lines=@($rows|ForEach-Object{$_.from+'|'+$_.bytes+'|'+$_.sha256}|Sort-Object)
 if((Recovery-Hash ((New-Object Text.UTF8Encoding($false)).GetBytes(($lines -join [char]10)))) -cne $Context.pins.scene){throw 'RECOVERY_SCENE_REFUSED'};return ,$rows
}
function Recovery-ChildEnv($Context,[string]$Temp){
 [ordered]@{SystemRoot='C:\Windows';WINDIR='C:\Windows';SystemDrive='C:';ComSpec='C:\Windows\System32\cmd.exe';PATH='C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0';PATHEXT='.COM;.EXE;.BAT;.CMD';PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules';TEMP=$Temp;TMP=$Temp;ProgramData='C:\ProgramData';ALLUSERSPROFILE='C:\ProgramData';USERPROFILE=$Context.pins.operatorProfile;LOCALAPPDATA=(Join-Path $Temp 'localappdata');APPDATA=(Join-Path $Temp 'appdata');COMPUTERNAME=$Context.pins.machine;OS='Windows_NT';PROCESSOR_ARCHITECTURE='AMD64'}
}
function Invoke-RecoveryChild($Context,[string]$File,[string[]]$Arguments){
 foreach($v in @($File)+$Arguments){if($v -match '[\s"]'){throw 'RECOVERY_SOURCE_REFUSED'}}
 $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=$Context.pins.ps;$psi.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+$File+' '+($Arguments -join ' ');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.WorkingDirectory=$Context.stage;$psi.EnvironmentVariables.Clear()
 $envs=Recovery-ChildEnv $Context (Join-Path $Context.stage 'tmp');foreach($k in $envs.Keys){$psi.EnvironmentVariables[$k]=$envs[$k]}
 $p=[Diagnostics.Process]::Start($psi);try{$o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$p.WaitForExit();$stdout=[string]$o.Result;$stderr=[string]$e.Result
  if($stdout.Length -gt 1048576 -or $stderr.Length -ne 0){throw 'RECOVERY_ARCHIVE_UNCONFIRMED'}
  try{$v=$stdout.Trim()|ConvertFrom-Json}catch{throw 'RECOVERY_ARCHIVE_UNCONFIRMED'}
  [pscustomobject]@{exit=$p.ExitCode;value=$v}
 }finally{$p.Dispose()}
}
function Invoke-RecoveryArchive($Context){Invoke-RecoveryChild $Context (Join-Path $Context.stage 'archive-windows-spool.ps1') @('-BatchKey',$Context.pins.batch,'-Reason',$Context.pins.reason,'-ExpectedNodeProfileSha256',$Context.pins.profile,'-ExactSceneSha256',$Context.pins.scene)}
function Confirm-RecoveryArchive($Context,$Archive,$Before){
 $v=$Archive.value
 if($Archive.exit -ne 0 -or $v.verified -ne $true -or $v.moved -ne 3 -or $v.sceneSha256 -cne $Context.pins.scene -or $v.directory -cnotmatch ('^failed-'+$Context.pins.batch.Substring(0,12)+'-'+$Context.pins.reason+'-[0-9a-f]{12}$')){throw 'RECOVERY_ARCHIVE_UNCONFIRMED'}
 $dir=Join-Path $Context.pins.spool $v.directory;$receipt=Read-RecoveryJson $Context (Join-Path $dir 'archive-receipt.json') 1048576
 if($receipt.contract -cne 'clued.independent-ci.resident-windows-spool-archive-receipt/2' -or $receipt.batchKey -cne $Context.pins.batch -or $receipt.reason -cne $Context.pins.reason -or $receipt.deletesAnything -ne $false -or @($receipt.moved).Count -ne 3 -or $receipt.exactScene.expected -cne $Context.pins.scene -or $receipt.exactScene.moved -cne $Context.pins.scene -or @($receipt.exactScene.protocolLeavesLeft).Count -ne 0){throw 'RECOVERY_RECEIPT_REFUSED'}
 $names=@($receipt.moved|ForEach-Object{$_.from}|Sort-Object);if(($names -join '|') -cne (($Context.pins.leaves|Sort-Object)-join '|')){throw 'RECOVERY_RECEIPT_REFUSED'}
 $after=@();foreach($m in $receipt.moved){if($m.fileIdOwnerGroupAndEffectiveAccessPreserved -ne $true -or $m.to -cne [IO.Path]::GetFileName($m.from)){throw 'RECOVERY_RECEIPT_REFUSED'};$old=@($Before|Where-Object{$_.from -ceq $m.from});if($old.Count -ne 1 -or $old[0].sha256 -cne $m.sha256 -or $old[0].bytes -ne $m.bytes){throw 'RECOVERY_RECEIPT_REFUSED'}
  $now=Read-RecoveryLeafFact (Join-Path $dir $m.to) $m.from;foreach($key in @('bytes','sha256','volume','idHigh','idLow','owner','group','aces')){if($now.$key -cne $old[0].$key){throw 'RECOVERY_RECEIPT_REFUSED'}};$after+=,$now
 }
 # The child is pinned and proves same-handle identity/full ACL/bytes itself; preserve its exact receipt bytes as evidence.
 $raw=Read-RecoveryProtected $Context (Join-Path $dir 'archive-receipt.json') 1048576
 Write-RecoveryNew (Join-Path $Context.stage 'archive-receipt.json') $raw;Write-RecoveryNew (Join-Path $Context.stage 'scene-before.json') (Recovery-Bytes $Before);Write-RecoveryNew (Join-Path $Context.stage 'scene-after.json') (Recovery-Bytes $after);$Context.manualReceiptSha=Recovery-Hash $raw;$Context.manualDirectory=$v.directory
}
function Restore-RecoveryOriginal($Context,$Snapshot){
 Assert-RecoveryHalt $Context;if($Context.state.pauseCreated){Assert-RecoveryPause $Context}
 foreach($s in $Snapshot.services){Assert-RecoveryServiceConfig (Read-RecoveryService $s.name) $s ($Context.state.servicesDisableAttempted -ccontains $s.name)}
 $t=Read-RecoveryTask $Context;if((Recovery-TaskFingerprint $t) -cne $Snapshot.taskHash){throw 'RECOVERY_RESTORE_REFUSED'}
 foreach($name in @('CluedCISwapBroker','CluedCIResident','CluedCIUpgrader')){
  $old=@($Snapshot.services|Where-Object{$_.name -ceq $name})[0]
  if($Context.state.servicesDisableAttempted -ccontains $name){Set-RecoveryServiceStart $old $false}
  if($old.state -ceq 'Running' -and $Context.state.servicesStopped -ccontains $name){Start-Service -Name $name -ErrorAction Stop;$until=[DateTime]::UtcNow.AddSeconds(120);do{$now=Read-RecoveryService $name;Assert-RecoveryServiceConfig $now $old $false;if($now.state -ceq 'Running' -and $now.pid -gt 0){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $until);if($now.state -cne 'Running' -or $now.pid -le 0){throw 'RECOVERY_RESTORE_REFUSED'}}
  $now=Read-RecoveryService $name;Assert-RecoveryServiceConfig $now $old $false;if($now.state -cne $old.state){throw 'RECOVERY_RESTORE_REFUSED'}
 }
 $t.Enabled=$Snapshot.enabled;$t=Read-RecoveryTask $Context;if($t.Enabled -ne $Snapshot.enabled -or (Recovery-TaskFingerprint $t) -cne $Snapshot.taskHash){throw 'RECOVERY_RESTORE_REFUSED'}
 if($Snapshot.running -and $Snapshot.enabled -and $t.GetInstances(0).Count -eq 0){$null=$t.Run($null);$until=[DateTime]::UtcNow.AddSeconds(60);do{$t=Read-RecoveryTask $Context;if($t.Enabled -ne $Snapshot.enabled -or (Recovery-TaskFingerprint $t) -cne $Snapshot.taskHash){throw 'RECOVERY_RESTORE_REFUSED'};if($t.GetInstances(0).Count -gt 0){break};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $until);if($t.GetInstances(0).Count -eq 0){throw 'RECOVERY_RESTORE_REFUSED'}}
}
function Request-RecoveryRearm($Context){
 $bytes=Read-RecoveryProtected $Context $Context.rearm 1048576;if((Recovery-Hash $bytes) -cne $Context.pins.rearm){throw 'RECOVERY_REARM_REFUSED'}
 $Context.rearmAt=[DateTimeOffset]::UtcNow
 $Context.rearmReason='m5b-owner-manual-recovery-'+$Context.operation
 $r=Invoke-RecoveryChild $Context $Context.rearm @('-Request','Rearm','-ExpectedHaltSha256',$Context.pins.halt,'-Reason',$Context.rearmReason)
 if($r.exit -ne 0 -or $r.value.status -cne 'REARM_REQUESTED_SERVICE_WILL_VERIFY'){throw 'RECOVERY_REARM_REFUSED'}
 $request=[string]$r.value.file;$parent=Join-Path $Context.pins.root 'owner'
 if([IO.Path]::GetDirectoryName($request) -cne $parent -or [IO.Path]::GetFileName($request) -cnotmatch '^[0-9]{13}-[0-9a-f]{12}\.json$'){throw 'RECOVERY_REARM_REFUSED'}
 $raw=Read-RecoveryProtected $Context $request 2048;$q=(New-Object Text.UTF8Encoding($false,$true)).GetString($raw)|ConvertFrom-Json
 if($q.contract -cne 'clued.independent-ci.resident-owner-rearm/1' -or $q.by -cne $Context.pins.operator -or $q.haltSha256 -cne $Context.pins.halt -or $q.reason -cne $Context.rearmReason -or $q.nonce -cnotmatch '^[0-9a-f]{16}$' -or [DateTimeOffset]::Parse([string]$q.requestedAt) -lt $Context.rearmAt){throw 'RECOVERY_REARM_REFUSED'}
 $Context.rearmRequestSha=Recovery-Hash $raw;$Context.rearmNonce=$q.nonce;Write-RecoveryNew (Join-Path $Context.stage 'rearm-request.json') $raw
}
function Recovery-RecentFiles([string]$Directory,[string]$Pattern,[DateTimeOffset]$After,[int]$Max){
 $files=@([IO.Directory]::GetFiles($Directory,$Pattern)|Where-Object{([IO.FileInfo]$_).LastWriteTimeUtc -ge $After.UtcDateTime.AddSeconds(-2)})
 if($files.Count -gt $Max){throw 'RECOVERY_RECEIPT_REFUSED'};return ,$files
}
function Confirm-RecoveryRearmEvidence($Context){
 $state=Join-Path $Context.pins.root 'state';$owners=@()
 foreach($f in (Recovery-RecentFiles (Join-Path $state 'receipts') '????????-owner-request.json' $Context.rearmAt 64)){
  $v=Read-RecoveryJson $Context $f 65536
  if($v.contract -ceq 'clued.independent-ci.resident-receipt/1' -and $v.type -ceq 'owner-request' -and $v.body.requestSha256 -ceq $Context.rearmRequestSha -and $v.body.kind -ceq 'rearm' -and $v.body.haltSha256 -ceq $Context.pins.halt -and @($v.body.archived) -ccontains $Context.pins.batch -and [DateTimeOffset]::Parse([string]$v.at) -ge $Context.rearmAt){$owners+=,[pscustomobject]@{path=$f;value=$v}}
 }
 if($owners.Count -ne 1){return $false};$owner=$owners[0];$kept=[string]$owner.value.body.haltKeptAs
 if($kept -cnotmatch '^cleared-[A-Za-z0-9-]{1,100}\.json$'){throw 'RECOVERY_RECEIPT_REFUSED'}
 $haltPath=Join-Path (Join-Path $state 'halts') $kept;$halt=Read-RecoveryProtected $Context $haltPath 16384
 if((Recovery-Hash $halt) -cne $Context.pins.halt){throw 'RECOVERY_RECEIPT_REFUSED'}
 $rearmPath=$haltPath+'.rearm.json';$rearm=Read-RecoveryJson $Context $rearmPath 16384
 if($rearm.haltSha256 -cne $Context.pins.halt -or $rearm.rearm.by -cne $Context.pins.operator -or $rearm.rearm.reason -cne $Context.rearmReason -or @($rearm.rearm.archived) -cnotcontains $Context.pins.batch -or [DateTimeOffset]::Parse([string]$rearm.at) -lt $Context.rearmAt){throw 'RECOVERY_RECEIPT_REFUSED'}
 $markedPath=Join-Path $state ('ledger\'+$Context.pins.batch+'\95-archived.json');$marked=Read-RecoveryJson $Context $markedPath 16384
 if($marked.key -cne $Context.pins.batch -or $marked.facts.haltSha256 -cne $Context.pins.halt -or [DateTimeOffset]::Parse([string]$marked.at) -lt $Context.rearmAt -or $marked.facts.windows -cnotmatch ('^failed-'+$Context.pins.batch.Substring(0,12)+'-rearm-unknown-failure-[0-9a-f]{12}$')){throw 'RECOVERY_RECEIPT_REFUSED'}
 $emptyPath=Join-Path (Join-Path $Context.pins.spool $marked.facts.windows) 'archive-receipt.json';$empty=Read-RecoveryJson $Context $emptyPath 65536
 if($empty.contract -cne 'clued.independent-ci.resident-windows-spool-archive-receipt/2' -or $empty.batchKey -cne $Context.pins.batch -or $empty.reason -cne 'rearm-unknown-failure' -or @($empty.moved).Count -ne 0 -or $empty.deletesAnything -ne $false){throw 'RECOVERY_RECEIPT_REFUSED'}
 $transport=@();foreach($f in (Recovery-RecentFiles (Join-Path $Context.pins.root 'mailbox\requests') '????????-????-????-????-????????????.json' $Context.rearmAt 64)){
  $q=Read-RecoveryJson $Context $f 16384
  if($q.contract -ceq 'clued.independent-ci.resident-companion-request/1' -and $q.kind -ceq 'archive-linux' -and $q.batchId -ceq $Context.pins.batchId -and $q.reason -ceq 'rearm-unknown-failure' -and [DateTimeOffset]::Parse([string]$q.createdAt) -ge $Context.rearmAt){
   if($q.requestId -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or [IO.Path]::GetFileNameWithoutExtension($f) -cne $q.requestId){throw 'RECOVERY_RECEIPT_REFUSED'}
   $response=Join-Path (Join-Path $Context.pins.root 'mailbox\responses') ($q.requestId+'.json');$v=Read-RecoveryJson $Context $response 16384
   if($v.contract -ceq 'clued.independent-ci.resident-companion-response/4' -and $v.requestId -ceq $q.requestId -and $v.kind -ceq 'archive-linux' -and $v.ok -eq $true -and $v.verified -eq $true -and $v.directory -ceq $marked.facts.linux -and $null -eq $v.jobTree -and [DateTimeOffset]::Parse([string]$v.observedAt) -ge $Context.rearmAt){$transport+=,[pscustomobject]@{request=$f;response=$response}}
  }
 }
 if($transport.Count -ne 1){throw 'RECOVERY_RECEIPT_REFUSED'}
 $paths=[ordered]@{ownerReceipt=$owner.path;keptHalt=$haltPath;keptRearm=$rearmPath;ledger95=$markedPath;serviceEmptyWindows=$emptyPath;linuxTransportRequest=$transport[0].request;linuxTransportResponse=$transport[0].response}
 $proof=[ordered]@{contract='clued.independent-ci.manual-and-service-recovery-correlation/1';batchKey=$Context.pins.batch;haltSha256=$Context.pins.halt;operation=$Context.operation;requestSha256=$Context.rearmRequestSha;requestNonce=$Context.rearmNonce;manualNonemptyDirectory=$Context.manualDirectory;manualReceiptSha256=$Context.manualReceiptSha;pauseSha256=$Context.state.pauseSha256;linuxEvidence='existing service-accepted companion transport response; not Linux receipt file bytes';files=[ordered]@{}}
 foreach($key in $paths.Keys){$raw=Read-RecoveryProtected $Context $paths[$key] 65536;Write-RecoveryNew (Join-Path $Context.stage ('service-'+$key+'.json')) $raw;$proof.files[$key]=Recovery-Hash $raw}
 Write-RecoveryNew (Join-Path $Context.stage 'recovery-correlation.json') (Recovery-Bytes $proof);return $true
}
function Wait-RecoveryRearm($Context){
 $until=[DateTime]::UtcNow.AddSeconds(180)
 do{
  Assert-RecoveryPause $Context
  if([RecoveryReadOnly]::Absent((Join-Path $Context.pins.root 'state\HALT.json'))){
   $status=Read-RecoveryJson $Context (Join-Path $Context.pins.root 'state\status.json') 1048576
   if($null -eq $status.halt -and $status.paused -is [bool] -and $status.paused -eq $true -and [DateTimeOffset]::Parse([string]$status.writtenAt) -ge $Context.rearmAt -and (Confirm-RecoveryRearmEvidence $Context)){return}
  }else{Assert-RecoveryHalt $Context}
  Start-Sleep -Milliseconds 500
 }while([DateTime]::UtcNow -lt $until)
 throw 'RECOVERY_HALT_NOT_CLEARED'
}
function Prepare-RecoveryStage($Context){
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)',[Security.AccessControl.AccessControlSections]'Owner,Group,Access')
 $parent=$Context.pins.stageParent;Hold-RecoveryPath $Context $parent
 if(-not [IO.Directory]::Exists($parent)){[void][IO.Directory]::CreateDirectory($parent,$acl)}
 $h=[RecoveryReadOnly]::HoldDirectory($parent);$Context.held.Add($h)
 $sd=New-Object Security.AccessControl.RawSecurityDescriptor([CluedSpoolArchiveV2]::Security($h),0)
 if($sd.GetSddlForm('Owner,Access') -cne $acl.GetSecurityDescriptorSddlForm('Owner,Access')){throw 'RECOVERY_PROTECTION_REFUSED'}
 $Context.stage=Join-Path $parent $Context.operation;if([IO.Directory]::Exists($Context.stage)){throw 'RECOVERY_PROTECTION_REFUSED'}
 [void][IO.Directory]::CreateDirectory($Context.stage,$acl);$Context.state.stage=$Context.stage
 foreach($d in @('windows','tmp','tmp\appdata','tmp\localappdata')){[void][IO.Directory]::CreateDirectory((Join-Path $Context.stage $d))}
 foreach($pair in @(@('archive-windows-spool.ps1','archive'),@('windows\NodeProfileV2.cs','native'))){$f=Join-Path $Context.stage $pair[0];Write-RecoveryNew $f $Context.buffers[$pair[1]];if((Recovery-Hash (Read-RecoveryProtected $Context $f 1048576)) -cne $Context.pins[$(if($pair[1] -ceq 'archive'){'archiver'}else{'native'})]){throw 'RECOVERY_SOURCE_REFUSED'}}
}

# Entry: fixed host and identity are checked before reading any installed state or emitting any machine action.
$pins=if($Scene){Get-RecoveryPins $Scene}else{Get-RecoveryPins};$identity=[Security.Principal.WindowsIdentity]::GetCurrent();$admin=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$report=New-RecoveryState;$context=@{pins=$pins;state=$report;held=(New-Object 'Collections.Generic.List[IDisposable]');buffers=@{};stage=$null;sequence=0;runner=$null;operation=([Guid]::NewGuid().ToString('N'))}
try{
 Assert-RecoverySceneIdentity $pins ([Environment]::MachineName) $identity.User.Value
 if(-not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or ($Run -and -not $admin)){throw 'RECOVERY_HOST_REFUSED'}
 foreach($name in [Environment]::GetEnvironmentVariables().Keys){if([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)'){throw 'RECOVERY_ENVIRONMENT_REFUSED'}}
 $env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
 if(-not $SourceRoot){throw 'RECOVERY_SOURCE_REFUSED'}
 foreach($pair in @(@('archive','work\actions-hosted-migration\independent-ci-v1\src\resident-v2\archive-windows-spool.ps1','archiver'),@('native','work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows\NodeProfileV2.cs','native'))){$b=[IO.File]::ReadAllBytes((Join-Path $SourceRoot $pair[1]));if((Recovery-Hash $b) -cne $pins[$pair[2]]){throw 'RECOVERY_SOURCE_REFUSED'};$context.buffers[$pair[0]]=$b}
 Initialize-RecoveryNative $context
 $context.install=Read-RecoveryJson $context (Join-Path $pins.root 'install\install-receipt.json')
 if($context.install.residentManifestSha256 -cne $pins.resident){throw 'RECOVERY_INSTALL_REFUSED'}
 $lease=[NodeProfileV2]::LoadProtectedProfile($pins.root,$pins.profile);$context.held.Add($lease);$context.node=$lease.Profile
 if($context.node.OwnerSid -cne $pins.companion -or $context.node.ControllerSid -cne $pins.controller -or $context.node.Hostname -cne $pins.machine -or $context.node.WslDistribution -cne $pins.distribution){throw 'RECOVERY_INSTALL_REFUSED'}
 $account=Read-RecoveryJson $context (Join-Path $pins.root 'install\companion-account.json') 4096
 if($account.operatorSid -cne $pins.operator -or $account.companionSid -cne $pins.companion -or [IO.File]::Exists((Join-Path $pins.root 'install\companion-headless-pending.json'))){throw 'RECOVERY_INSTALL_REFUSED'}
 $context.rearm=Join-Path $pins.root ('resident\'+$pins.resident+'\windows\rearm-resident.ps1')
 if((Recovery-Hash (Read-RecoveryProtected $context $context.rearm 1048576)) -cne $pins.rearm){throw 'RECOVERY_SOURCE_REFUSED'}
 Assert-RecoveryHalt $context;Hold-RecoveryWslRecord $context;Open-RecoveryRegistration $context;$null=Save-RecoveryOriginal $context;$null=Read-RecoveryProcessOwnerSids
 if($Preflight){$report.status='PREFLIGHT_PASS'}else{Prepare-RecoveryStage $context;$report=Invoke-RecoveryCore $context}
}catch{$report.status='REFUSED_BEFORE_ARCHIVE';$report.code=Get-RecoveryCode $_}
finally{for($i=$context.held.Count-1;$i -ge 0;$i--){$context.held[$i].Dispose()}}
$report|ConvertTo-Json -Depth 12 -Compress
if(@('RECOVERED_GLOBAL_PAUSED','PREFLIGHT_PASS') -ccontains $report.status){exit 0}else{exit 1}
