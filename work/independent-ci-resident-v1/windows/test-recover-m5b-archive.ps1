# Real PowerShell 5 TEMP/NTFS tests. Production entry, registry, Task Scheduler, SCM and WSL are never invoked.
param([string]$Powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',[switch]$IncludeSlowLockTest)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$source=Join-Path $PSScriptRoot 'recover-m5b-archive-reviewed.ps1';$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$errors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'RECOVERY_TEST_PARSE_FAILED'}
foreach($f in @($ast.FindAll({param($a)$a -is [Management.Automation.Language.FunctionDefinitionAst]},$true))){. ([scriptblock]::Create($f.Extent.Text))}
$count=0;function Yes([bool]$Value,[string]$Label){if(-not $Value){throw ('RECOVERY_TEST_FAILED:'+ $Label)};$script:count++}
$native=Get-RecoveryPins desk-31080;$archivePath=Join-Path $repo 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\archive-windows-spool.ps1';$profilePath=Join-Path $repo 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows\NodeProfileV2.cs'
$buffers=@{archive=[IO.File]::ReadAllBytes($archivePath);native=[IO.File]::ReadAllBytes($profilePath)}
Yes ((Recovery-Hash $buffers.archive) -ceq $native.archiver) 'exact-archiver-pin';Yes ((Recovery-Hash $buffers.native) -ceq $native.native) 'exact-native-pin'
Initialize-RecoveryNative @{buffers=$buffers}
$ActualManagerAcl=${function:Assert-RecoveryManagerAcl};$ActualRunner=${function:Assert-RecoveryRunner};$ActualVhdAcl=${function:Assert-RecoveryVhdAcl};$ActualNewPause=${function:New-RecoveryPause};$ActualRequest=${function:Request-RecoveryRearm};$ActualNoProducers=${function:Assert-RecoveryNoProducers};$ActualOwners=${function:Read-RecoveryProcessOwnerSids};$ActualPause=${function:New-RecoveryPause};$ActualRead=${function:Read-RecoveryProtected};$ActualJournal=${function:Write-RecoveryJournal};$ActualWait=${function:Wait-RecoveryRearm};$ActualConfirm=${function:Confirm-RecoveryArchive};$ActualHold=${function:Hold-RecoveryQuietProof}
$testRoots=New-Object Collections.Generic.List[string];$script:active=$null
function Assert-RecoveryManagerAcl($Context,[byte[]]$Bytes,[string]$Path){
 if(-not $Path.StartsWith(([IO.Path]::GetTempPath().TrimEnd('\')+'\m5b-recovery-'),[StringComparison]::OrdinalIgnoreCase)){return}
 $sd=New-Object Security.AccessControl.RawSecurityDescriptor($Bytes,0);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 foreach($a in $sd.DiscretionaryAcl){if($a -is [Security.AccessControl.CommonAce] -and $a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and ([int]$a.AceFlags -band 8) -eq 0 -and @($sid,'S-1-5-18','S-1-5-32-544') -notcontains $a.SecurityIdentifier.Value -and ([int]$a.AccessMask -band 0x500d0156) -ne 0){throw 'RECOVERY_PROTECTION_REFUSED'}}
}
function Assert-RecoveryVhdAcl($Context,[byte[]]$Bytes,[string]$Path){Assert-RecoveryManagerAcl $Context $Bytes $Path}
function New-FakeRegistryHandle($Node){
 $Node.leases++;$o=[pscustomobject]@{node=$Node;names=$Node.names;values=$Node.values;children=$Node.children;closed=$false}
 $o|Add-Member ScriptMethod GetSubKeyNames {if($this.closed){throw 'FIXTURE_KEY_CLOSED'};return ,$this.node.names}
 $o|Add-Member ScriptMethod GetValue {param($name,$fallback,$options);if($this.closed){throw 'FIXTURE_KEY_CLOSED'};return $this.node.values[$name]}
 $o|Add-Member ScriptMethod OpenSubKey {param($name,$write);if($this.closed){throw 'FIXTURE_KEY_CLOSED'};$child=$this.node.children[$name];if($null -eq $child){return $null};return (New-FakeRegistryHandle $child.node)}
 $o|Add-Member ScriptMethod Dispose {if(-not $this.closed){$this.closed=$true;$this.node.leases--}}
 return $o
}
function Fake-Key([string[]]$Names,$Values){New-FakeRegistryHandle ([pscustomobject]@{names=$Names;values=$Values;children=@{};leases=0})}
function Open-RecoveryUsersHive{New-FakeRegistryHandle $script:active.registryRoot.node}
function New-TestContext([string]$Fail='',[ValidateSet('desk-31080','turing-b2ea')][string]$Scene='desk-31080'){
 $root=Join-Path ([IO.Path]::GetTempPath()) ('m5b-recovery-'+[guid]::NewGuid().ToString('N'));$testRoots.Add($root)
 [void][IO.Directory]::CreateDirectory($root);$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 [IO.Directory]::SetAccessControl($root,$acl)
 foreach($d in @('state','install','owner','stage','spool\outgoing','spool\incoming','disk','state\receipts','state\halts','state\ledger','mailbox\requests','mailbox\responses')){[void][IO.Directory]::CreateDirectory((Join-Path $root $d))}
 $p=Get-RecoveryPins $Scene;$p.root=$root;$p.spool=Join-Path $root 'spool';$p.vhdx=Join-Path $root 'disk\ext4.vhdx'
 [IO.File]::WriteAllBytes($p.vhdx,(New-Object byte[] 4096))
 $halt=[ordered]@{code='FAILURE_ARCHIVE_UNCONFIRMED';clearedOnlyBy='owner-rearm';facts=@{key=$p.batch;windowsArchiveCode='EXACT_FIXED_ACCESS_ACES_REQUIRED'}};$hb=Recovery-Bytes $halt;$p.halt=Recovery-Hash $hb;[IO.File]::WriteAllBytes((Join-Path $root 'state\HALT.json'),$hb)
 $w=[ordered]@{contract='clued.independent-ci.companion-wsl/1';stage='qualified';companionSid=$p.companion;distro=$p.distribution;target=$p.vhdx};$wb=Recovery-Bytes $w;$p.wslRecord=Recovery-Hash $wb;[IO.File]::WriteAllBytes((Join-Path $root 'install\companion-wsl.json'),$wb)
 foreach($n in $p.leaves){[IO.File]::WriteAllBytes((Join-Path $p.spool $n.Replace('/','\')),([Text.Encoding]::UTF8.GetBytes($n)))}
 $lines=@($p.leaves|ForEach-Object{$b=[IO.File]::ReadAllBytes((Join-Path $p.spool $_.Replace('/','\')));$_+'|'+$b.Length+'|'+(Recovery-Hash $b)}|Sort-Object);$p.scene=Recovery-Hash ([Text.Encoding]::UTF8.GetBytes(($lines -join [char]10)))
 $task=[pscustomobject]@{Enabled=$true;Xml='<Task><Settings><Enabled>true</Enabled></Settings><CredentialReference>opaque-scheduler-owned</CredentialReference></Task>';instances=1;stops=0;runs=0;credential='opaque-scheduler-owned';operatorSid=$p.operator}
 $actions=[pscustomobject]@{Count=1;action=[pscustomobject]@{Path=(Join-Path $root 'bin\CluedCompanionSupervisor.exe');Arguments=('"'+$root+'"')}};$actions|Add-Member ScriptMethod Item {param($index);return $this.action}
 $task|Add-Member NoteProperty Definition ([pscustomobject]@{Principal=[pscustomobject]@{UserId=$p.companion;LogonType=1;RunLevel=0};Actions=$actions})
 $task|Add-Member ScriptMethod GetSecurityDescriptor {param($flags);return ('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;'+$this.operatorSid+')')}
 $task|Add-Member ScriptMethod GetInstances {param($flags);[pscustomobject]@{Count=$this.instances}}
 $task|Add-Member ScriptMethod Stop {param($flags);$this.stops++;if($script:active.fail -ceq 'task-stop'){throw 'RECOVERY_TASK_REFUSED'};$this.instances=0}
 $task|Add-Member ScriptMethod Run {param($args);$this.runs++;$this.instances=1;return [pscustomobject]@{}}
 $services=@{};$pidSeed=40000;foreach($n in $p.services){
 $image=if($n -ceq 'CluedCIUpgrader'){'upgrader\bin\UpgraderServiceHost.exe'}elseif($n -ceq 'CluedCIResident'){'bin\ResidentServiceHost.exe'}else{'bin\SwapBroker.exe'}
 $binary='"'+(Join-Path $root $image)+'"';if($n -ceq 'CluedCIResident'){$binary+=' "'+(Join-Path $root ('resident\'+$p.resident+'\src\service-main.mjs'))+'"'}
 $serviceDacl='D:(A;;GA;;;SY)(A;;GA;;;BA)'
 $services[$n]=[pscustomobject]@{name=$n;state='Running';pid=$pidSeed;config='';binary=$binary;account=$(if($n -ceq 'CluedCIResident'){'NT SERVICE\CluedCIResident'}else{'LocalSystem'});startMode='Auto';sddl=$serviceDacl;delayedAutoStart=($n -ceq 'CluedCIUpgrader')};$p.serviceConfigs[$n]=Recovery-Hash (Recovery-Bytes @($binary,$services[$n].account,'Auto',$serviceDacl));$pidSeed++
 }
 $guid='{11111111-1111-1111-1111-111111111111}';$key=Fake-Key @() @{DistributionName=$p.distribution;BasePath=(Split-Path -Parent $p.vhdx);VhdFileName='ext4.vhdx'};$parent=Fake-Key @($guid) @{};$parent.children[$guid]=$key
 $c=@{pins=$p;state=(New-RecoveryState);held=(New-Object 'Collections.Generic.List[object]');buffers=$buffers;stage=(Join-Path $root 'stage');sequence=0;operation=[guid]::NewGuid().ToString('N');runner=$null;node=[pscustomobject]@{WslDistribution=$p.distribution};install=[pscustomobject]@{};registration=[pscustomobject]@{key=$key;parent=$parent;name=$guid};fail=$Fail;task=$task;services=$services;calls=(New-Object Collections.Generic.List[string]);archiveCalls=0;quietCalls=0;diskBlocked=0;rearmAt=[DateTimeOffset]::UtcNow}
 $users=Fake-Key @() @{};$c.registrationPath=$p.companion+'\Software\Microsoft\Windows\CurrentVersion\Lxss';$users.children[$c.registrationPath]=$parent;$c.registrationUsers=$users;$c.held.Add($users);$c.held.Add($parent);$c.held.Add($key);$c.registryRoot=$users;$script:active=$c;Open-RecoveryRegistration $c
 $c.rearm=Join-Path $root 'installed-rearm.ps1';$rb=[Text.Encoding]::UTF8.GetBytes('# pinned fixture original rearm');[IO.File]::WriteAllBytes($c.rearm,$rb);$p.rearm=Recovery-Hash $rb
 $c.state.stage=$c.stage;return $c
}
function Read-RecoveryTask($Context){if($Context.fail -ceq 'task-disable'){$Context.task.Enabled=$true};return $Context.task}
function Read-RecoveryService([string]$Name){$v=$script:active.services[$Name]|Select-Object *;$v.config=Recovery-Hash (Recovery-Bytes @($v.binary,$v.account,$v.startMode,(Recovery-ServiceDacl $v.sddl)));return $v}
function Set-RecoveryServiceStart($Before,[bool]$Disabled){
 $c=$script:active;$c.calls.Add($(if($Disabled){'disable-'}else{'enable-'})+$Before.name)
 if($c.fail -ceq 'disable-service' -and $Disabled -and $Before.name -ceq 'CluedCIResident'){throw 'RECOVERY_SERVICE_REFUSED'}
 if($c.fail -ceq 'restore-type' -and -not $Disabled){throw 'RECOVERY_RESTORE_REFUSED'}
 $c.services[$Before.name].startMode=if($Disabled){'Disabled'}else{$Before.startMode}
 if($c.fail -ceq 'delayed-drift' -and $Disabled){$c.services[$Before.name].delayedAutoStart=-not $Before.delayedAutoStart}
 if($c.fail -ceq 'disable-readback' -and $Disabled){$c.services[$Before.name].startMode='Auto'}
 Assert-RecoveryServiceConfig (Read-RecoveryService $Before.name) $Before $Disabled
}
function Stop-Service{[CmdletBinding()]param([string]$Name);$script:active.calls.Add('stop-'+$Name);if($script:active.fail -ceq 'service-stop' -and $Name -ceq 'CluedCIResident'){throw 'RECOVERY_SERVICE_REFUSED'};$script:active.services[$Name].state='Stopped';$script:active.services[$Name].pid=0}
function Start-Service{[CmdletBinding()]param([string]$Name);if($script:active.fail -ceq 'restore'){throw 'RECOVERY_RESTORE_REFUSED'};$script:active.calls.Add('start-'+$Name);$script:active.services[$Name].state='Running';$script:active.services[$Name].pid=50000}
function Start-Sleep{[CmdletBinding()]param([int]$Milliseconds);if($null -ne $script:active){$script:active.calls.Add('wait')};[Threading.Thread]::Sleep($Milliseconds)}
function Get-Process{[CmdletBinding()]param([int]$Id);return $null}
function Assert-RecoveryRunner($Context){if($Context.fail -ceq 'runner'){throw 'RECOVERY_RUNNER_REFUSED'};return [pscustomobject]@{config='original-runner'}}
function Assert-RecoveryNoProducers($Context){$Context.quietCalls++;if($Context.fail -ceq 'process'){throw 'RECOVERY_NOT_QUIET'};if($Context.fail -ceq 'restart' -and $Context.quietCalls -ge 2){$Context.services.CluedCIResident.state='Running';throw 'RECOVERY_NOT_QUIET'}}
function New-RecoveryPause($Context){if($Context.fail -ceq 'pause-create-race'){Write-RecoveryNew (Join-Path $Context.pins.root 'state\PAUSED.json') ([Text.Encoding]::UTF8.GetBytes('prior-owner-marker'))};& $ActualNewPause $Context}
function Read-RecoveryProtected($Context,[string]$Path,[int]$Max){if($Context.fail -ceq 'pause-read' -and $Path -like '*\PAUSED.json'){return ,([Text.Encoding]::UTF8.GetBytes('changed'))};& $ActualRead $Context $Path $Max}
function Write-RecoveryJournal($Context,[string]$Kind){if($Context.fail -ceq 'journal-after' -and $Context.state.archiveAttempted -and $Kind -ceq 'VERIFIED'){throw 'CONTROLLED_JOURNAL_FAILURE'};& $ActualJournal $Context $Kind}
function Invoke-RecoveryArchive($Context){
 $Context.archiveCalls++;$Context.calls.Add('archive')
 # A queued SCM restart cannot start the existing disabled service (adapter models SCM rule).
 foreach($svc in $Context.services.Values){if($svc.startMode -cne 'Disabled'){throw 'QUEUED_RESTART_NOT_BLOCKED'}}
 # Simulated late Linux/Windows producer cannot open this actual NTFS disk while the production proof holds it.
 try{$f=[IO.File]::Open($Context.pins.vhdx,'Open','ReadWrite','ReadWrite');$f.Dispose();throw 'DISK_NOT_EXCLUSIVE'}catch{if($_.Exception.Message -eq 'DISK_NOT_EXCLUSIVE'){throw};$Context.diskBlocked++}
 $name='failed-'+$Context.pins.batch.Substring(0,12)+'-'+$Context.pins.reason+'-111111111111';$dir=Join-Path $Context.pins.spool $name;[void][IO.Directory]::CreateDirectory($dir);$moved=@()
 foreach($leaf in $Context.pins.leaves){$from=Join-Path $Context.pins.spool $leaf.Replace('/','\');$to=[IO.Path]::GetFileName($leaf);$b=[IO.File]::ReadAllBytes($from);[IO.File]::Move($from,(Join-Path $dir $to));$moved+=,[ordered]@{from=$leaf;to=$to;bytes=$b.Length;sha256=(Recovery-Hash $b);fileIdOwnerGroupAndEffectiveAccessPreserved=$true};if($Context.fail -ceq 'partial'){break}}
 $r=[ordered]@{contract='clued.independent-ci.resident-windows-spool-archive-receipt/2';batchKey=$Context.pins.batch;reason=$Context.pins.reason;deletesAnything=$false;moved=$moved;exactScene=@{expected=$Context.pins.scene;moved=$Context.pins.scene;protocolLeavesLeft=@()}}
 [IO.File]::WriteAllBytes((Join-Path $dir 'archive-receipt.json'),(Recovery-Bytes $r))
 return [pscustomobject]@{exit=$(if($Context.fail -ceq 'partial'){2}else{0});value=[pscustomobject]@{verified=($Context.fail -cne 'partial');moved=$moved.Count;sceneSha256=$Context.pins.scene;directory=$name}}
}
function Confirm-RecoveryArchive($Context,$Archive,$Before){if($Context.fail -ceq 'receipt'){throw 'RECOVERY_RECEIPT_REFUSED'};& $ActualConfirm $Context $Archive $Before}
function Invoke-RecoveryChild($Context,[string]$File,[string[]]$Arguments){
 $Context.calls.Add('rearm');if($Context.fail -ceq 'rearm'){throw 'RECOVERY_REARM_REFUSED'}
 $now=[DateTimeOffset]::UtcNow;$nonce='1111111111111111';$path=Join-Path $Context.pins.root ('owner\'+$now.ToUnixTimeMilliseconds()+'-'+$nonce.Substring(0,12)+'.json')
 $q=@{contract='clued.independent-ci.resident-owner-rearm/1';by=$Context.pins.operator;haltSha256=$Context.pins.halt;reason=$Context.rearmReason;nonce=$nonce;requestedAt=$now.ToString('o')}
 if($Context.fail -ceq 'request-wrong-halt'){$q.haltSha256='0'*64}
 Write-RecoveryNew $path (Recovery-Bytes $q)
 return [pscustomobject]@{exit=0;value=[pscustomobject]@{status='REARM_REQUESTED_SERVICE_WILL_VERIFY';file=$path}}
}
function Request-RecoveryRearm($Context){& $ActualRequest $Context}
function New-TestServiceEvidence($Context){
 $state=Join-Path $Context.pins.root 'state';$now=[DateTimeOffset]::UtcNow.ToString('o');$kept='cleared-fixture.json';$halt=Join-Path $state 'HALT.json'
 [IO.File]::Move($halt,(Join-Path $state ('halts\'+$kept)))
 if($Context.fail -ceq 'kept-halt'){[IO.File]::WriteAllText((Join-Path $state ('halts\'+$kept)),'changed')}
 $rearm=@{haltSha256=$Context.pins.halt;rearm=@{by=$Context.pins.operator;reason=$Context.rearmReason;archived=@($Context.pins.batch)};at=$now}
 Write-RecoveryNew (Join-Path $state ('halts\'+$kept+'.rearm.json')) (Recovery-Bytes $rearm)
 $empty='failed-'+$Context.pins.batch.Substring(0,12)+'-rearm-unknown-failure-222222222222';$emptyDir=Join-Path $Context.pins.spool $empty;[void][IO.Directory]::CreateDirectory($emptyDir)
 Write-RecoveryNew (Join-Path $emptyDir 'archive-receipt.json') (Recovery-Bytes @{contract='clued.independent-ci.resident-windows-spool-archive-receipt/2';batchKey=$Context.pins.batch;reason='rearm-unknown-failure';deletesAnything=$false;moved=@()})
 $ledger=Join-Path $state ('ledger\'+$Context.pins.batch);[void][IO.Directory]::CreateDirectory($ledger)
 $mark=@{key=$Context.pins.batch;facts=@{windows=$empty;linux='failed-fixture-linux';haltSha256=$Context.pins.halt};at=$now};if($Context.fail -ceq 'ledger-halt'){$mark.facts.haltSha256='0'*64}
 Write-RecoveryNew (Join-Path $ledger '95-archived.json') (Recovery-Bytes $mark)
 $receipt=@{contract='clued.independent-ci.resident-receipt/1';type='owner-request';at=$now;body=@{kind='rearm';requestSha256=$Context.rearmRequestSha;haltSha256=$Context.pins.halt;haltKeptAs=$kept;archived=@($Context.pins.batch)}}
 if($Context.fail -ceq 'owner-request-sha'){$receipt.body.requestSha256='0'*64}
 Write-RecoveryNew (Join-Path $state 'receipts\00000001-owner-request.json') (Recovery-Bytes $receipt)
 $id='11111111-1111-1111-1111-111111111111'
 $transportBatchId=if($Context.fail -ceq 'transport-cross-scene'){'31080af4ceb1122c-b28efd37b849'}else{$Context.pins.batchId}
 Write-RecoveryNew (Join-Path $Context.pins.root ('mailbox\requests\'+$id+'.json')) (Recovery-Bytes @{contract='clued.independent-ci.resident-companion-request/1';requestId=$id;kind='archive-linux';batchId=$transportBatchId;reason='rearm-unknown-failure';createdAt=$now})
 $response=@{contract='clued.independent-ci.resident-companion-response/4';requestId=$id;kind='archive-linux';ok=$true;verified=$true;directory='failed-fixture-linux';jobTree=$null;observedAt=$now}
 if($Context.fail -ceq 'linux-wrong-directory'){$response.directory='failed-unrelated'}
 Write-RecoveryNew (Join-Path $Context.pins.root ('mailbox\responses\'+$id+'.json')) (Recovery-Bytes $response)
 Write-RecoveryNew (Join-Path $state 'status.json') (Recovery-Bytes @{halt=$null;paused=$true;writtenAt=$now})
}
function Wait-RecoveryRearm($Context){
 if($Context.fail -ceq 'no-clear'){throw 'RECOVERY_HALT_NOT_CLEARED'};New-TestServiceEvidence $Context
 if(@('kept-halt','ledger-halt','owner-request-sha','linux-wrong-directory') -ccontains $Context.fail){if(-not (Confirm-RecoveryRearmEvidence $Context)){throw 'RECOVERY_RECEIPT_REFUSED'};throw 'INCORRECT_CORRELATION_ACCEPTED'}
 & $ActualWait $Context
}
function Finish-Test($c){for($i=$c.held.Count-1;$i -ge 0;$i--){$c.held[$i].Dispose()}}
$disabled=& $Powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $source
Yes ($LASTEXITCODE -eq 0 -and $disabled -ceq '{"status":"DISABLED"}') 'real-entry-default-disabled'
$wrongScene=if([Environment]::MachineName -ceq 'DESK-W-591'){'turing-b2ea'}else{'desk-31080'}
$refused=& $Powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $source -Preflight -Scene $wrongScene -SourceRoot $repo;$raw=$LASTEXITCODE;$v=$refused|ConvertFrom-Json;Yes ($raw -eq 1 -and $v.code -ceq 'RECOVERY_HOST_REFUSED' -and -not $v.taskAttempted -and -not $v.servicesAttempted -and -not $v.pauseAttempted) 'real-entry-wrong-host-zero-actions'
try{
 # Scheduler may omit Enabled=true. Fingerprint only the rest; actual Task.Enabled remains separately authoritative.
 $fpDefault=Recovery-TaskFingerprint ([pscustomobject]@{Xml='<Task><Settings/><Actions>fixed</Actions></Task>'})
 foreach($value in @('true','false')){$fp=Recovery-TaskFingerprint ([pscustomobject]@{Xml=('<Task><Settings><Enabled>'+$value+'</Enabled></Settings><Actions>fixed</Actions></Task>')});Yes ($fp -ceq $fpDefault) 'default-or-explicit-enabled-has-same-definition-fingerprint'}
 $fpRest=Recovery-TaskFingerprint ([pscustomobject]@{Xml='<Task><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions>fixed</Actions></Task>'})
 foreach($xml in @('<Task><Settings><Enabled>true</Enabled><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions>fixed</Actions></Task>','<Task><Settings><StartWhenAvailable>true</StartWhenAvailable><Enabled>false</Enabled></Settings><Actions>fixed</Actions></Task>')){Yes ((Recovery-TaskFingerprint ([pscustomobject]@{Xml=$xml})) -ceq $fpRest) 'enabled-node-position-does-not-change-fingerprint'}
 Yes ((Recovery-TaskFingerprint ([pscustomobject]@{Xml='<Task><Settings/><Actions>changed</Actions></Task>'})) -cne $fpDefault) 'other-task-field-change-is-not-hidden'
 Yes ((Recovery-TaskFingerprint ([pscustomobject]@{Xml='<Task><Settings><StartWhenAvailable>false</StartWhenAvailable></Settings><Actions>fixed</Actions></Task>'})) -cne $fpRest) 'other-setting-change-is-not-hidden'
 foreach($xml in @('<Task><Settings><Enabled>true</Enabled><Enabled>false</Enabled></Settings></Task>','<Task><Actions>fixed</Actions></Task>','<Task><Settings/><Settings/></Task>')){$blocked=$false;try{Recovery-TaskFingerprint ([pscustomobject]@{Xml=$xml})|Out-Null}catch{$blocked=$true};Yes $blocked 'duplicate-enabled-or-missing-duplicate-settings-refused'}
 $fakeTask=[pscustomobject]@{Enabled=$false;Xml='<Task><Settings><Enabled>true</Enabled></Settings></Task>'};Recovery-TaskFingerprint $fakeTask|Out-Null;Yes ($fakeTask.Enabled -eq $false) 'fingerprint-does-not-assign-real-enabled-state'
 # Actual old metadata-only primitive is the RED control; only the recovery GR primitive must deny rename.
 $c=New-TestContext;$script:active=$c;$dir=Join-Path $c.pins.root 'rename-proof';[void][IO.Directory]::CreateDirectory($dir)
 $h=[CluedSpoolArchiveV2]::HoldDirectory($dir)
 try{[IO.Directory]::Move($dir,($dir+'.moved'));Yes ([IO.Directory]::Exists($dir+'.moved')) 'actual-metadata-only-hold-is-not-a-delete-barrier'}finally{$h.Dispose()}
 [IO.Directory]::Move(($dir+'.moved'),$dir)
 $h=[RecoveryReadOnly]::HoldDirectory($dir)
 try{
  $meta=[CluedSpoolArchiveV2]::Metadata($h);Yes (($meta.Attributes -band 0x410) -eq 0x10) 'actual-recovery-gr-hold-is-a-plain-directory'
  $renamed=$false;try{[IO.Directory]::Move($dir,($dir+'.moved'));$renamed=$true}catch{}
  Yes (-not $renamed -and [IO.Directory]::Exists($dir)) 'actual-recovery-gr-hold-denies-directory-rename'
  [CluedSpoolArchiveV2]::ExactPath($h,$dir);Yes ([CluedSpoolArchiveV2]::Stable($meta,[CluedSpoolArchiveV2]::Metadata($h))) 'actual-recovery-gr-directory-identity-stable'
 }finally{$h.Dispose()}
 [IO.Directory]::Move($dir,($dir+'.moved'));Yes ([IO.Directory]::Exists($dir+'.moved')) 'actual-recovery-gr-release-allows-rename'
 $bad=Join-Path $c.pins.root 'not-a-directory.txt';[IO.File]::WriteAllText($bad,'fixture');$refused=$false;$h=$null;try{$h=[RecoveryReadOnly]::HoldDirectory($bad)}catch{$refused=$true}finally{if($null -ne $h){$h.Dispose()}};Yes $refused 'actual-recovery-gr-hold-refuses-file-type'
 Finish-Test $c
 # Fixed selector and exact identity are pure; an unrecognized host never inherits the DESK default.
 $desk=Get-RecoveryPins desk-31080;$turing=Get-RecoveryPins turing-b2ea
 Yes ($desk.machine -ceq 'DESK-W-591' -and $desk.batchId -ceq '31080af4ceb1122c-b28efd37b849' -and $desk.scene -ceq '238851d06434ec886448f1e8afa6926a91e36d3b117e5ab8ec36279d9671e7a0') 'desk-fixed-scene-preserved'
 Yes ($turing.machine -ceq 'TURING' -and $turing.batch -ceq 'b2ea162eddf7756234f0596beee9a479eb2c9aeb61a8c616e908de2febdfab03' -and $turing.batchId -ceq 'b2ea162eddf77562-a9e5c4fb6827' -and $turing.halt -ceq '2108b842c2aa887737407cdc23becad934d6c05607bbad97843cf975647f5785') 'turing-fixed-batch-and-halt'
 Yes ($turing.profile -ceq '67b6b61cf1048ecb775092c203c650795c419c039e9e25c05cd6901ea754c5ac' -and $turing.wslRecord -ceq 'cf35c68d978dba09483a1f3ccf19ab49ea71dec542ce9d00559a066cc8303467' -and $turing.scene -ceq 'bf998f595f7a8c3eaf55aceb188797798e9109ba68585de5ec7b68e3434fe162') 'turing-public-evidence-sha-pins'
 Yes ($turing.vhdx -ceq 'C:\clued-resident\wsl\Ubuntu-24.04\ext4.vhdx' -and $turing.distribution -ceq 'Ubuntu-24.04' -and $turing.operator.EndsWith('-1001') -and $turing.companion.EndsWith('-1017') -and $turing.controller.EndsWith('-1015')) 'turing-fixed-account-and-disk-identity'
 Yes ($turing.serviceConfigs.CluedCIUpgrader -ceq '04e0be24aea6bfd41bfa0b4e24fc91ea80ef05c0b33f41075403777c0ad6aa8c' -and $turing.serviceConfigs.CluedCIResident -ceq 'a77661629972cfe10c7750d2d69d1b732c99247893c80ef05fbd047ae84c6e70' -and $turing.serviceConfigs.CluedCISwapBroker -ceq 'e986a58bdb60456ef41d9e8843242b97319453262ae81f664814074a6fcca81b') 'turing-original-service-configuration-pins'
 $blocked=$false;try{Get-RecoveryPins arbitrary-scene|Out-Null}catch{$blocked=$true};Yes $blocked 'no-arbitrary-scene'
 foreach($pins in @($desk,$turing)){
  Assert-RecoverySceneIdentity $pins $pins.machine $pins.operator;Yes $true 'exact-scene-host-operator-accepted'
  $other=if($pins.sceneId -ceq 'desk-31080'){$turing}else{$desk}
  $blocked=$false;try{Assert-RecoverySceneIdentity $pins $other.machine $pins.operator}catch{$blocked=$true};Yes $blocked 'cross-machine-scene-refused'
  $blocked=$false;try{Assert-RecoverySceneIdentity $pins $pins.machine $other.operator}catch{$blocked=$true};Yes $blocked 'cross-operator-scene-refused'
  $envs=Recovery-ChildEnv @{pins=$pins} ([IO.Path]::GetTempPath());Yes ($envs.COMPUTERNAME -ceq $pins.machine -and $envs.USERPROFILE -ceq $pins.operatorProfile -and $envs.PSModulePath -ceq 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules') 'selected-clean-child-environment'
 }
 function Memory-Acl([string]$Owner,[string]$Role,[int]$Mask){$sd=New-Object Security.AccessControl.RawSecurityDescriptor(('O:'+ $Owner+'G:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x'+$Mask.ToString('x')+';;;'+$Role+')'));$b=New-Object byte[] $sd.BinaryLength;$sd.GetBinaryForm($b,0);return ,$b}
 foreach($pins in @($desk,$turing)){
  $ctx=@{pins=$pins};$outgoing=Join-Path $pins.spool 'outgoing';$incoming=Join-Path $pins.spool 'incoming'
  & $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.controller 0x1301bf) $outgoing;Yes $true 'selected-controller-only-outgoing-modify'
  & $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.companion 0x1301bf) $incoming;Yes $true 'selected-companion-only-incoming-modify'
  $other=if($pins.sceneId -ceq 'desk-31080'){$turing}else{$desk}
  $blocked=$false;try{& $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $other.controller 0x1301bf) $outgoing}catch{$blocked=$true};Yes $blocked 'other-scene-controller-write-refused'
  $blocked=$false;try{& $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.companion 0x1301bf) $outgoing}catch{$blocked=$true};Yes $blocked 'wrong-direction-companion-write-refused'
  $response=Join-Path $pins.root 'mailbox\responses';& $ActualManagerAcl $ctx (Memory-Acl $pins.companion $pins.companion 0x1301bf) $response;Yes $true 'selected-response-owner-and-writer'
  $archive=Join-Path $pins.spool ('failed-'+$pins.batch.Substring(0,12)+'-owner-m5b-recovery-111111111111');& $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.residentSid 0x1301bf) $archive;Yes $true 'selected-archive-prefix-role-accepted'
  $wrong=Join-Path $pins.spool ('failed-'+$other.batch.Substring(0,12)+'-owner-m5b-recovery-111111111111');$blocked=$false;try{& $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.residentSid 0x1301bf) $wrong}catch{$blocked=$true};Yes $blocked 'other-scene-archive-prefix-refused'
  foreach($path in @([IO.Path]::GetDirectoryName($pins.root),$pins.spool)){
   & $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.companion 0x120080) $path;Yes $true 'parent-self-metadata-ace-accepted-without-acl-write'
   foreach($mask in @(0x160080,0x120180)){$blocked=$false;try{& $ActualManagerAcl $ctx (Memory-Acl 'S-1-5-32-544' $pins.companion $mask) $path}catch{$blocked=$true};Yes $blocked 'parent-metadata-write-dac-or-write-attributes-refused'}
  }
 }
 # The original runner guard accepts the selected host's fixed account, not the other scene's domain spelling.
 $c=New-TestContext -Scene turing-b2ea;$script:active=$c;$c.node|Add-Member NoteProperty runnerService 'CluedControlRunner';$c.install|Add-Member NoteProperty runnerSddlUnchanged 'D:(A;;GA;;;SY)(A;;GA;;;BA)'
 $c.services['CluedControlRunner']=[pscustomobject]@{name='CluedControlRunner';state='Stopped';pid=0;config='';binary='"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"';account='TURING\clued-control';startMode='Manual';sddl='D:(A;;GA;;;SY)(A;;GA;;;BA)';delayedAutoStart=$false}
 & $ActualRunner $c|Out-Null;Yes $true 'turing-fixed-runner-account-accepted'
 $c.services.CluedControlRunner.account='DESK-W-591\clued-control';$blocked=$false;try{& $ActualRunner $c|Out-Null}catch{$blocked=$true};Yes $blocked 'other-scene-runner-account-refused';Finish-Test $c
 # The same production core and original correlation predicate now run a complete TURING fixture.
 $c=New-TestContext -Scene turing-b2ea;$script:active=$c;Hold-RecoveryWslRecord $c;$r=Invoke-RecoveryCore $c
 Yes ($r.status -ceq 'RECOVERED_GLOBAL_PAUSED' -and $r.haltCleared -and $r.pauseCreated -and $c.archiveCalls -eq 1 -and $c.task.runs -eq 1 -and $c.task.credential -ceq 'opaque-scheduler-owned') 'turing-core-one-archive-original-credential-restored'
 $corr=Get-Content -LiteralPath (Join-Path $c.stage 'recovery-correlation.json') -Raw|ConvertFrom-Json;Yes ($corr.batchKey -ceq $turing.batch -and $corr.haltSha256 -ceq $c.pins.halt) 'turing-correlation-is-not-desk';Finish-Test $c
 foreach($fail in @('partial','transport-cross-scene')){$c=New-TestContext -Fail $fail -Scene turing-b2ea;$script:active=$c;Hold-RecoveryWslRecord $c;$r=Invoke-RecoveryCore $c;Yes ($r.status -ceq 'UNKNOWN_PRESERVED' -and -not $r.haltCleared -and $r.pauseCreated) ('turing-partial-or-cross-transport-preserved:'+ $fail);Finish-Test $c}
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;Assert-RecoveryRegistration $c;$r=Invoke-RecoveryCore $c
 Yes ($r.status -ceq 'RECOVERED_GLOBAL_PAUSED' -and $r.haltCleared -and $r.pauseCreated -and $r.archiveVerified -and $r.restored -and $r.rearmRequested) ('full-core-success:'+($r|ConvertTo-Json -Compress))
 Yes ($c.archiveCalls -eq 1 -and $c.diskBlocked -eq 1 -and $c.task.Enabled -and $c.task.instances -eq 1 -and $c.task.runs -eq 1 -and $c.task.credential -ceq 'opaque-scheduler-owned') 'original-task-credentials-preserved'
 Yes ((($c.calls|Where-Object{$_ -like 'start-*'}) -join '|') -ceq 'start-CluedCISwapBroker|start-CluedCIResident|start-CluedCIUpgrader') 'original-service-restore-order'
 $pause=Get-Content -LiteralPath (Join-Path $c.pins.root 'state\PAUSED.json') -Raw|ConvertFrom-Json
 Yes ($pause.source.reason -ceq 'Owner manual recovery pause' -and $pause.source.by -ceq $c.pins.operator -and $pause.source.recovery.batchKey -ceq $c.pins.batch -and (Recovery-Hash ([IO.File]::ReadAllBytes((Join-Path $c.pins.root 'state\PAUSED.json')))) -ceq $r.pauseSha256) 'honest-pause-retained'
 Yes ([IO.File]::Exists((Join-Path $c.stage 'archive-receipt.json')) -and [IO.File]::Exists((Join-Path $c.stage 'scene-after.json'))) 'full-receipt-and-identity-evidence';Yes ([IO.File]::Exists((Join-Path $c.stage 'recovery-correlation.json'))) 'durable-kept-halt-ledger-mailbox-correlation';Finish-Test $c
 foreach($fail in @('task-disable','task-stop','service-stop','runner','process','restart','pause-read','scene','disable-service','disable-readback','delayed-drift','pause-create-race','service-source')){
  $c=New-TestContext $fail;$script:active=$c;Hold-RecoveryWslRecord $c;if($fail -ceq 'scene'){$c.pins.scene='0'*64};if($fail -ceq 'service-source'){$c.services.CluedCIResident.binary='C:\untrusted.exe'}
  $r=Invoke-RecoveryCore $c;Yes ($r.status -cne 'RECOVERED_GLOBAL_PAUSED' -and $c.archiveCalls -eq 0 -and -not $r.rearmAttempted -and @($c.pins.leaves|Where-Object{[IO.File]::Exists((Join-Path $c.pins.spool $_.Replace('/','\')))}).Count -eq 3) ('precondition-zero-move:'+ $fail);Finish-Test $c
 }
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$existing=[Text.Encoding]::UTF8.GetBytes('{"source":"preexisting","at":"old"}');[IO.File]::WriteAllBytes((Join-Path $c.pins.root 'state\PAUSED.json'),$existing);$r=Invoke-RecoveryCore $c
 Yes ($c.archiveCalls -eq 0 -and -not $r.pauseCreated -and (Recovery-Hash $existing) -ceq (Recovery-Hash ([IO.File]::ReadAllBytes((Join-Path $c.pins.root 'state\PAUSED.json'))))) 'pause-create-new-never-overwrites';Finish-Test $c
 foreach($fail in @('partial','receipt','journal-after','restore','rearm','no-clear')){
  $c=New-TestContext $fail;$script:active=$c;Hold-RecoveryWslRecord $c;$r=Invoke-RecoveryCore $c
  Yes ($r.status -ceq 'UNKNOWN_PRESERVED' -and $r.pauseCreated -and -not $r.haltCleared -and [IO.File]::Exists((Join-Path $c.pins.root 'state\HALT.json'))) ('unknown-not-success:'+ $fail)
  if(@('partial','receipt','journal-after','restore') -ccontains $fail){Yes (-not $r.rearmAttempted -and $r.manualRecoveryHeld) ('no-rearm-after-unproved-result:'+ $fail)}
  if($fail -ceq 'no-clear'){Yes ($r.rearmRequested -and $r.restored -and -not $r.haltCleared) 'request-is-not-halt-clear'}
  Finish-Test $c
 }
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$c.registration.key.values.BasePath='C:\wrong';$r=Invoke-RecoveryCore $c;Yes ($c.archiveCalls -eq 0 -and -not $r.pauseCreated) 'actual-registration-binding-refuses-wrong-disk';Finish-Test $c
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$proof=& $ActualHold $c @{}
 try{Yes ($null -ne $proof.disk -and -not $proof.disk.SafeFileHandle.IsClosed) 'real-vhdx-lock-is-held';$blocked=$false;try{$f=[IO.File]::Open($c.pins.vhdx,'Open','Read','ReadWrite');$f.Dispose()}catch{$blocked=$true};Yes $blocked 'real-lock-blocks-new-reader-and-writer';$moved=$false;try{[IO.File]::Move($c.pins.vhdx,($c.pins.vhdx+'.other'));$moved=$true}catch{};Yes (-not $moved) 'real-lock-blocks-replacement';Assert-RecoveryQuietProof $c $proof}finally{$proof.Dispose()}
 $f=[IO.File]::Open($c.pins.vhdx,'Open','ReadWrite','None');$f.Dispose();Yes $true 'lock-released-after-proof-dispose';Finish-Test $c
 if($IncludeSlowLockTest){$c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$lock=[IO.File]::Open($c.pins.vhdx,'Open','ReadWrite','None');try{$r=Invoke-RecoveryCore $c;Yes ($c.archiveCalls -eq 0 -and -not $r.pauseCreated -and -not $r.rearmAttempted) 'actual-busy-disk-timeout-zero-move'}finally{$lock.Dispose();Finish-Test $c}}
 # Exact original task states: do not start an original non-running task or change opaque credentials.
 foreach($enabled in @($false,$true)){$c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$c.task.Enabled=$enabled;$c.task.instances=0;$r=Invoke-RecoveryCore $c;Yes ($r.status -ceq 'RECOVERED_GLOBAL_PAUSED' -and $c.task.Enabled -eq $enabled -and $c.task.runs -eq 0 -and $c.task.credential -ceq 'opaque-scheduler-owned') 'original-not-running-task-not-started';Finish-Test $c}
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$c.task.Enabled=$false;$r=Invoke-RecoveryCore $c;Yes ($c.archiveCalls -eq 0 -and -not $r.taskAttempted) 'running-disabled-original-refused';Finish-Test $c
 foreach($fail in @('kept-halt','ledger-halt','owner-request-sha','linux-wrong-directory','request-wrong-halt','restore-type')){
  $c=New-TestContext $fail;$script:active=$c;Hold-RecoveryWslRecord $c;$r=Invoke-RecoveryCore $c;Yes ($r.status -ceq 'UNKNOWN_PRESERVED' -and -not $r.haltCleared -and $r.pauseCreated) ('durable-correlation-or-restore-refusal:'+ $fail);Finish-Test $c
 }
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$snapshot=Save-RecoveryOriginal $c;Stop-RecoveryTask $c $snapshot;Stop-RecoveryServices $c $snapshot
 Yes (@($c.services.Values|Where-Object{$_.startMode -cne 'Disabled'}).Count -eq 0) 'all-three-disabled-before-archive'
 Yes ((($c.calls|Select-Object -First 3) -join '|') -ceq 'disable-CluedCIUpgrader|disable-CluedCIResident|disable-CluedCISwapBroker') 'disable-all-before-first-stop'
 Restore-RecoveryOriginal $c $snapshot;Yes ($c.services.CluedCIUpgrader.delayedAutoStart -and @($c.services.Values|Where-Object{$_.startMode -cne 'Auto'}).Count -eq 0) 'restore-exact-auto-and-delayed-flag';Finish-Test $c
 # The real no-producer predicate includes an orphan Resident service child, not only the two user accounts.
 function Read-RecoveryProcessOwnerSids{return ,@($script:ownerSid)}
 $script:ownerSid=$native.residentSid;$blocked=$false;try{& $ActualNoProducers @{pins=$native}}catch{$blocked=$true};Yes $blocked 'orphan-resident-service-child-refused'
 $script:ownerSid='S-1-5-18';& $ActualNoProducers @{pins=$native};Yes $true 'known-other-owner-not-in-producer-set'
 # Fresh registry namespace replacement cannot hide behind an old held key.
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$replacement=Fake-Key @($c.registration.name) @{};$replacement.children[$c.registration.name]=Fake-Key @() @{DistributionName='CluedResident-Linux';BasePath='C:\wrong';VhdFileName='ext4.vhdx'};$c.registrationUsers.children[$c.registrationPath]=$replacement
 $r=Invoke-RecoveryCore $c;Yes ($c.archiveCalls -eq 0 -and -not $r.pauseCreated) 'fresh-registry-namespace-replacement-refused';Finish-Test $c
 # Original CIM failure cases explicitly exercise the fallback lane; the independent test executes the real Native owner lane.
 & {
 function Read-RecoveryNativeProcessOwner { [pscustomobject]@{Status='UNKNOWN';Sid=$null} }
 function Get-CimInstance{[CmdletBinding()]param([string]$ClassName,[string[]]$Property);return $script:ownerRows}
 function Invoke-CimMethod{[CmdletBinding()]param($InputObject,[string]$MethodName);return $script:ownerResult}
 $script:ownerRows=@([pscustomobject]@{ProcessId=$PID},[pscustomobject]@{ProcessId=65530});$script:ownerResult=[pscustomobject]@{ReturnValue=2;Sid=$null}
 $blocked=$false;try{& $ActualOwners}catch{$blocked=$true};Yes $blocked 'unreadable-owner-refuses-instead-of-quiet'
 $script:ownerResult=[pscustomobject]@{ReturnValue=0;Sid='unknown'};$blocked=$false;try{& $ActualOwners}catch{$blocked=$true};Yes $blocked 'malformed-owner-refuses'
 $script:ownerRows=@();$blocked=$false;try{& $ActualOwners}catch{$blocked=$true};Yes $blocked 'empty-process-inventory-refuses'
 }
 # An original stopped service regains its precise start mode without an explicit Start call.
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$c.services.CluedCIUpgrader.state='Stopped';$c.services.CluedCIUpgrader.pid=0;$r=Invoke-RecoveryCore $c
 Yes ($r.status -ceq 'RECOVERED_GLOBAL_PAUSED' -and $c.services.CluedCIUpgrader.state -ceq 'Stopped' -and $c.services.CluedCIUpgrader.startMode -ceq 'Auto' -and $c.services.CluedCIUpgrader.delayedAutoStart -and $c.calls -cnotcontains 'start-CluedCIUpgrader') 'original-stopped-service-not-started'
 Yes ([IO.File]::Exists((Join-Path $c.stage 'original-task-and-services.json'))) 'original-safe-config-journal-before-effects';Finish-Test $c
 # A queued restart in the host adapter has an observable difference between Stop-only and Disabled+Stop.
 $c=New-TestContext;$script:active=$c;$svc=$c.services.CluedCIResident;Stop-Service -Name $svc.name;if($svc.startMode -cne 'Disabled'){$svc.state='Running';$svc.pid=60000};Yes ($svc.state -ceq 'Running') 'queued-restart-defeats-stop-only-control'
 $before=Read-RecoveryService $svc.name;Set-RecoveryServiceStart $before $true;Stop-Service -Name $svc.name;if($svc.startMode -cne 'Disabled'){$svc.state='Running'};Yes ($svc.state -ceq 'Stopped' -and $svc.startMode -ceq 'Disabled') 'queued-restart-blocked-by-disabled-adapter';Finish-Test $c
 # Registry handle protocol model: a stop/logoff cannot unload the hive while the real guard retains child handles.
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$node=$c.registration.key.node;$heldBefore=$node.leases
 Stop-RecoveryTask $c (Save-RecoveryOriginal $c);Yes ($heldBefore -gt 1 -and $node.leases -eq $heldBefore) 'hive-unload-model-blocked-by-held-registration-handles';Assert-RecoveryRegistration $c
 Finish-Test $c;Yes ($node.leases -eq 0) 'registry-adapter-all-handles-disposed'
 # Use the actual production AST predicate on ACL bytes read from real owned TEMP NTFS leaves.
 # A non-elevated test cannot assign BA owner. Only the in-memory descriptor owner is projected to BA;
 # real NTFS ACEs, masks, nofollow security reads and the production validator are unchanged.
 $c=New-TestContext;$script:active=$c;$testSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$c.pins.companion=$testSid
 function Get-TestNativeRoleAcl([string]$Path,[int]$Mask,[string]$OtherSid=''){
  if(-not [IO.Path]::GetFullPath($Path).StartsWith($script:active.pins.root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'TEST_PATH_REFUSED'}
  $directory=[IO.Directory]::Exists($Path);$acl=if($directory){New-Object Security.AccessControl.DirectorySecurity}else{New-Object Security.AccessControl.FileSecurity}
  $acl.SetAccessRuleProtection($true,$false)
  foreach($id in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($id)),[Security.AccessControl.FileSystemRights]0x1f01ff,'Allow')))}
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($script:active.pins.companion)),[Security.AccessControl.FileSystemRights]$Mask,'Allow')))
  if($OtherSid){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($OtherSid)),[Security.AccessControl.FileSystemRights]0x40000,'Allow')))}
  if($directory){[IO.Directory]::SetAccessControl($Path,$acl);$h=[CluedSpoolArchiveV2]::HoldDirectory($Path)}else{[IO.File]::SetAccessControl($Path,$acl);$h=[RecoveryReadOnly]::Open($Path,$false)}
  try{$bytes=[CluedSpoolArchiveV2]::Security($h);$sd=New-Object Security.AccessControl.RawSecurityDescriptor($bytes,0)
   $sd.Owner=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544');$projected=New-Object byte[] $sd.BinaryLength;$sd.GetBinaryForm($projected,0);return ,$projected
  }finally{$h.Dispose()}
 }
 $acl=Get-TestNativeRoleAcl $c.pins.vhdx 0x1701bf;& $ActualVhdAcl $c $acl $c.pins.vhdx;Yes $true 'real-ntfs-role-acl-exact-vhdx-modify-plus-write-dac-accepted'
 $dir=[IO.Path]::GetDirectoryName($c.pins.vhdx);$acl=Get-TestNativeRoleAcl $dir 0x1301bf;& $ActualVhdAcl $c $acl $dir;Yes $true 'real-ntfs-role-acl-parent-modify-accepted'
 $acl=Get-TestNativeRoleAcl $dir 0x1701bf;$blocked=$false;try{& $ActualVhdAcl $c $acl $dir}catch{$blocked=$true};Yes $blocked 'real-ntfs-parent-write-dac-refused'
 $acl=Get-TestNativeRoleAcl $c.pins.vhdx 0x1701bf 'S-1-5-21-858977881-4031698862-3006450925-9999';$blocked=$false;try{& $ActualVhdAcl $c $acl $c.pins.vhdx}catch{$blocked=$true};Yes $blocked 'real-ntfs-other-sid-write-dac-refused'
 $acl=Get-TestNativeRoleAcl $c.pins.vhdx 0x1f01bf;$blocked=$false;try{& $ActualVhdAcl $c $acl $c.pins.vhdx}catch{$blocked=$true};Yes $blocked 'real-ntfs-vhdx-write-owner-refused'
 # Exact-path authority: a sibling file with identical approved role rights is not the registered VHDX.
 $acl=Get-TestNativeRoleAcl $c.pins.vhdx 0x1701bf;$blocked=$false;try{& $ActualVhdAcl $c $acl ($c.pins.vhdx+'.other')}catch{$blocked=$true};Yes $blocked 'role-acl-approval-bound-to-exact-registered-leaf';Finish-Test $c
 # Read-only identity records retain their own handle and refuse atomic replacement while proof exists.
 $c=New-TestContext;$script:active=$c;Hold-RecoveryWslRecord $c;$blocked=$false;try{[IO.File]::Move((Join-Path $c.pins.root 'install\companion-wsl.json'),(Join-Path $c.pins.root 'install\swapped.json'))}catch{$blocked=$true};Yes $blocked 'record-namespace-held';Finish-Test $c
 # sc.exe exposes SACL audit rules to an elevated caller. Match the installed DACL-only pin, retain full security for restoration checks.
 $serviceDacl='D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)'
 $serviceAudit='S:(AU;FA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)'
 Yes ((Recovery-ServiceDacl $serviceDacl) -ceq $serviceDacl) 'service-original-dacl-only-projection-stable'
 Yes ((Recovery-ServiceDacl ($serviceDacl+$serviceAudit)) -ceq $serviceDacl) 'admin-audit-visibility-does-not-change-dacl-pin'
 $blocked=$false;try{Recovery-ServiceDacl 'invalid'|Out-Null}catch{$blocked=$true};Yes $blocked 'malformed-service-descriptor-refused'
 $before=[pscustomobject]@{binary='fixed-test-image';account='LocalSystem';startMode='Auto';sddl=($serviceDacl+$serviceAudit);delayedAutoStart=$true}
 $now=$before|Select-Object *;$now|Add-Member NoteProperty config (Recovery-Hash (Recovery-Bytes @($now.binary,$now.account,$now.startMode,$serviceDacl)))
 Assert-RecoveryServiceConfig $now $before $false;Yes $true 'full-service-audit-preserved-with-dacl-only-config-pin'
 $now.startMode='Disabled';$now.config=Recovery-Hash (Recovery-Bytes @($now.binary,$now.account,$now.startMode,$serviceDacl));Assert-RecoveryServiceConfig $now $before $true;Yes $true 'disabled-mode-retains-complete-service-security'
 $now.sddl=$serviceDacl+'S:(AU;SA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)';$blocked=$false;try{Assert-RecoveryServiceConfig $now $before $true}catch{$blocked=$true};Yes $blocked 'audit-only-change-refused-even-with-same-dacl-pin'
 $c=New-TestContext -Scene turing-b2ea;$script:active=$c;$c.node|Add-Member NoteProperty runnerService 'CluedControlRunner';$c.install|Add-Member NoteProperty runnerSddlUnchanged $serviceDacl
 $c.services['CluedControlRunner']=[pscustomobject]@{name='CluedControlRunner';state='Stopped';pid=0;config='';binary='"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"';account='TURING\clued-control';startMode='Manual';sddl=($serviceDacl+$serviceAudit);delayedAutoStart=$false}
 $c.runner=& $ActualRunner $c;Yes $true 'runner-original-dacl-receipt-compatible-with-admin-audit-read'
 $c.services['CluedControlRunner'].sddl=$serviceDacl+'S:(AU;SA;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;WD)';$blocked=$false;try{& $ActualRunner $c|Out-Null}catch{$blocked=$true};Yes $blocked 'runner-audit-change-still-refused';Finish-Test $c
 [pscustomobject]@{status='RECOVERY_TEMP_FIXTURE_PASS';cases=$count;slowLockIncluded=[bool]$IncludeSlowLockTest;machineEffects=$false;taskRegistration=$false;wslCommands=$false}|ConvertTo-Json -Compress
}catch{Write-Output ('RECOVERY_FIXTURE_ASSERTIONS_BEFORE_FAILURE='+$count);throw}finally{foreach($path in $testRoots){if([IO.Path]::GetFullPath($path).StartsWith(([IO.Path]::GetTempPath().TrimEnd('\')+'\m5b-recovery-'),[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue;if([IO.Directory]::Exists($path)){throw 'RECOVERY_TEST_OWN_TEMP_CLEANUP_REFUSED'}}}}
