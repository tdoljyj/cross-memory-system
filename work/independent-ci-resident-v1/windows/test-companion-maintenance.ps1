# Offline fixtures only. All live SCM/WSL/registry/file-effect adapters are
# replaced before exercising orchestration. Never stop/start a real service.
$ErrorActionPreference='Stop';Set-StrictMode -Version 2
$helper=Join-Path $PSScriptRoot 'companion-maintenance.ps1'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($helper,[ref]$tokens,[ref]$errors)
if($errors.Count -or @($ast.EndBlock.Statements|Where-Object{$_ -isnot [Management.Automation.Language.FunctionDefinitionAst]}).Count){throw 'HELPER_HAS_PARSE_ERROR_OR_TOP_LEVEL_EFFECT'}
. $helper
$passed=0
function Check([string]$Name,[scriptblock]$Body){& $Body;$script:passed++;'PASS '+$Name}
function Refuses([scriptblock]$Body,[string]$Code){try{& $Body}catch{if($_.Exception.Message -ceq $Code){return};throw};throw ('NO_REFUSAL:'+ $Code)}
function Clone($Value){ConvertFrom-CompanionMaintenanceJson (ConvertTo-CompanionMaintenanceBytes $Value)}
$now=[DateTimeOffset]::UtcNow
function Fixture {
  $subject=@{node='NODE-B';packageManifestSha256=('1'*64);ciSourceManifestSha256=('2'*64);residentManifestSha256=('3'*64);installReceiptSha256=('4'*64);rearmSha256=('5'*64);operatorSid='S-1-5-21-1-2-3-1001';companionSid='S-1-5-21-1-2-3-1002';vhdxPath='C:\Owned\ext4.vhdx';targetVhdxPath='C:\Target\ext4.vhdx';runnerService='FixtureRunner';runnerBinary='C:\runner\RunnerService.exe';runnerSddl='D:P(A;;FA;;;SY)';wslDistribution='CluedLinux'}
  $challenge=@{operationId=('a'*64);nonce=('b'*64);pid=123;processStartedAt=$now.AddMinutes(-5).ToString('o');phase='after-stop';subject=$subject;pausedSha256=('c'*64);coveredWsl=@('CluedLinux')}
  $grant=@{current=$true;status='granted';id='actual-grant';version='7';receiptRef='canonical:receipt:7';createdAt=$now.AddSeconds(-1).ToString('o');expiresAt=$now.AddSeconds(110).ToString('o');subject=$subject;coveredWsl=@('CluedLinux');services=@('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker');actions=@('service.stop','service.start','wsl.shutdown','companion.account-switch')}
  $github=@{complete=$true;paginationComplete=$true;allAffectedRepositoriesCovered=$true;wholeVmAllUsersCovered=$true;runnerInventoryComplete=$true;nonterminalRuns=@();coveredWsl=@('CluedLinux');createdAt=$now.AddSeconds(-1).ToString('o');expiresAt=$now.AddSeconds(110).ToString('o');repositories=@('owner/repo');repositoryInventories=@(@{repository='owner/repo';paginationComplete=$true;nonterminalRuns=@();pagesRead=2;totalCount=150;evidenceRef='host:github-query:7'});affectedRunnerIds=@('runner-1');runnerHolds=@(@{runnerId='runner-1';evidenceRef='host:runner-disabled:7';holdMechanism='registration disabled and process stopped';acceptsNewJobs=$false;activeJobs=@();holdActive=$true;wsl='CluedLinux'})}
  $hostEvidence=@{contract='clued.companion-maintenance.host/1';trust='OWNER_ROOT_HOST_ATTESTATION';operationId=$challenge.operationId;nonce=$challenge.nonce;pid=$challenge.pid;processStartedAt=$challenge.processStartedAt;phase=$challenge.phase;subject=$subject;pausedSha256=$challenge.pausedSha256;coveredWsl=@('CluedLinux');createdAt=$now.AddSeconds(-1).ToString('o');expiresAt=$now.AddSeconds(110).ToString('o');grant=$grant;github=$github}
  return (Clone @{challenge=$challenge;hostEvidence=$hostEvidence;subject=$subject})
}
Check 'full nonce-bound current Grant and Host inventory accepted' {$f=Fixture;Assert-CompanionMaintenanceSubject $f.subject;Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory}
foreach($field in @('operationId','nonce','processStartedAt','phase','pausedSha256')){
  Check ('cross-operation '+$field+' refused') {$f=Fixture;$f.hostEvidence[$field]='wrong';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_HOST_SUBJECT_MISMATCH'}
}
Check 'cross-process pid refused' {$f=Fixture;$f.hostEvidence.pid=999;Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_HOST_SUBJECT_MISMATCH'}
foreach($field in @('packageManifestSha256','ciSourceManifestSha256','residentManifestSha256','installReceiptSha256','rearmSha256','node','operatorSid','vhdxPath')){
  Check ('Host subject '+$field+' drift refused') {$f=Fixture;$f.hostEvidence.subject[$field]='wrong';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_HOST_SUBJECT_MISMATCH'}
}
Check 'independent proof label impersonation refused' {$f=Fixture;$f.hostEvidence.trust='INDEPENDENT_MACHINE_PROOF';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_HOST_SUBJECT_MISMATCH'}
Check 'expired evidence refused' {$f=Fixture;$f.hostEvidence.expiresAt=$now.AddSeconds(-1).ToString('o');Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_AUTHORITY_EXPIRED'}
Check 'long TTL refused' {$f=Fixture;$f.hostEvidence.expiresAt=$now.AddSeconds(500).ToString('o');Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_AUTHORITY_EXPIRED'}
Check 'future evidence refused' {$f=Fixture;$f.hostEvidence.createdAt=$now.AddSeconds(1).ToString('o');Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_AUTHORITY_EXPIRED'}
Check 'old Grant current false refused' {$f=Fixture;$f.hostEvidence.grant.current=$false;Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_CURRENT_GRANT_REQUIRED'}
Check 'Grant bool coercion refused' {$f=Fixture;$f.hostEvidence.grant.current='true';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_CURRENT_GRANT_REQUIRED'}
Check 'bare UUID is not a Grant' {$f=Fixture;$f.hostEvidence.grant='d34d7ace-0000-0000-0000-000000000001';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_FIELD_REQUIRED:current'}
Check 'service start permission omitted refused' {$f=Fixture;$f.hostEvidence.grant.actions=@('service.stop','wsl.shutdown','companion.account-switch');Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now} 'MAINTENANCE_CURRENT_GRANT_REQUIRED'}
foreach($field in @('complete','paginationComplete','allAffectedRepositoriesCovered','wholeVmAllUsersCovered','runnerInventoryComplete')){
  Check ('incomplete '+$field+' refused') {$f=Fixture;$f.hostEvidence.github[$field]=$false;Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_GITHUB_UNKNOWN_OR_ACTIVE'}
}
foreach($state in @('queued','in_progress','waiting','requested','pending','unknown')){
  Check ('GitHub '+$state+' run refused') {$f=Fixture;$f.hostEvidence.github.nonterminalRuns=@(@{id=88;status=$state});Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_GITHUB_UNKNOWN_OR_ACTIVE'}
}
Check 'per-repository hidden nonterminal refused' {$f=Fixture;$f.hostEvidence.github.repositoryInventories[0].nonterminalRuns=@(@{id=9});Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_GITHUB_UNKNOWN_OR_ACTIVE'}
Check 'per-repository pagination missing refused' {$f=Fixture;$f.hostEvidence.github.repositoryInventories=@();Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_GITHUB_READ_EVIDENCE_REQUIRED'}
Check 'API zero without runner hold refused' {$f=Fixture;$f.hostEvidence.github.runnerHolds=@();Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_RUNNER_HOLDS_REQUIRED'}
Check 'runner still accepts jobs refused' {$f=Fixture;$f.hostEvidence.github.runnerHolds[0].acceptsNewJobs=$true;Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_RUNNER_NOT_HELD'}
Check 'runner active job refused' {$f=Fixture;$f.hostEvidence.github.runnerHolds[0].activeJobs=@('job');Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_RUNNER_NOT_HELD'}
Check 'uncovered affected runner refused' {$f=Fixture;$f.hostEvidence.github.affectedRunnerIds+=,'runner-2';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_RUNNER_HOLDS_INCOMPLETE'}
Check 'runner WSL mismatch refused' {$f=Fixture;$f.hostEvidence.github.runnerHolds[0].wsl='OtherDistro';Refuses {Assert-CompanionMaintenanceHost $f.hostEvidence $f.challenge $now -RequireInventory} 'MAINTENANCE_RUNNER_WSL_UNCOVERED'}
Check 'WSL duplicate refused case insensitive' {Refuses {Assert-CompanionMaintenanceNames @('Distro','distro') 'WSL'} 'WSL'}
Check 'WSL unknown name refused' {Refuses {Assert-CompanionMaintenanceNames @('Distro --exec') 'WSL'} 'WSL'}
Check 'singleton JSON array refused' {Refuses {ConvertFrom-CompanionMaintenanceJson ([Text.Encoding]::UTF8.GetBytes('[{"current":null}]'))} 'MAINTENANCE_JSON_OBJECT_REQUIRED'}
$owner='S-1-5-21-1-2-3-1001';$adminAcl='O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$owner+')'
Check 'admin evidence Owner read admitted' {Assert-CompanionMaintenanceAcl $adminAcl $owner}
Check 'Owner writable evidence refused' {Refuses {Assert-CompanionMaintenanceAcl ($adminAcl.Replace('0x1200a9','FA')) $owner} 'MAINTENANCE_PATH_EXTERNAL_WRITE_REFUSED'}
Check 'Owner owned evidence refused' {Refuses {Assert-CompanionMaintenanceAcl ($adminAcl.Replace('O:BA',('O:'+$owner))) $owner} 'MAINTENANCE_PATH_OWNER_REFUSED'}
Check 'Owner-private drop admitted' {Assert-CompanionMaintenanceAcl ($adminAcl.Replace('O:BA',('O:'+$owner)).Replace('0x1200a9','FA')) $owner -PrivateDrop}
Check 'other user write drop refused' {Refuses {Assert-CompanionMaintenanceAcl ($adminAcl+'(A;;FA;;;BU)') $owner -PrivateDrop} 'MAINTENANCE_PATH_EXTERNAL_WRITE_REFUSED'}
Check 'other user read drop refused' {Refuses {Assert-CompanionMaintenanceAcl ($adminAcl+'(A;;GR;;;BU)') $owner -PrivateDrop} 'MAINTENANCE_PATH_EXTERNAL_READER_REFUSED'}
function QuietFixture {return @{status=@{contract='clued.independent-ci.resident-status/8';current=$null;halt=$null;paused=$true;executor=@{state='PAUSED'};train=@{enabled='on'}};upgrade=@{contract='clued.independent-ci.resident-upgrade-status/1';op=$null};runner=@{state='Stopped';pid=0}}}
Check 'paused idle original runner quiet admitted' {$f=QuietFixture;Assert-CompanionMaintenanceQuietValue $f.status $f.upgrade $f.runner ('a'*64) ('a'*64)}
Check 'current batch despite pause refused' {$f=QuietFixture;$f.status.current=@{batch='x'};Refuses {Assert-CompanionMaintenanceQuietValue $f.status $f.upgrade $f.runner ('a'*64) ('a'*64)} 'MAINTENANCE_CURRENT_OR_HALT_ACTIVE'}
Check 'running executor despite current null refused' {$f=QuietFixture;$f.status.executor.state='RUNNING';Refuses {Assert-CompanionMaintenanceQuietValue $f.status $f.upgrade $f.runner ('a'*64) ('a'*64)} 'MAINTENANCE_EXECUTOR_NOT_IDLE'}
Check 'upgrade operation despite pause refused' {$f=QuietFixture;$f.upgrade.op=@{state='WAITING_DRAIN'};Refuses {Assert-CompanionMaintenanceQuietValue $f.status $f.upgrade $f.runner ('a'*64) ('a'*64)} 'MAINTENANCE_UPGRADE_ACTIVE_OR_UNKNOWN'}
Check 'runner running despite current null refused' {$f=QuietFixture;$f.runner.state='Running';$f.runner.pid=777;Refuses {Assert-CompanionMaintenanceQuietValue $f.status $f.upgrade $f.runner ('a'*64) ('a'*64)} 'MAINTENANCE_RUNNER_NOT_STOPPED'}
Check 'pause changed refused' {$f=QuietFixture;Refuses {Assert-CompanionMaintenanceQuietValue $f.status $f.upgrade $f.runner ('a'*64) ('b'*64)} 'MAINTENANCE_PAUSED_CHANGED'}
function ServicesFixture {
  $services=@();foreach($name in @('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker')){$services+=,@{name=$name;configSha256=('a'*64);state='Running';pid=123;originallyRunning=$true;stoppedByOperation=$true}}
  return ,$services
}
Check 'restore order Broker Resident Upgrader' {$before=ServicesFixture;$current=ServicesFixture;foreach($s in $current){$s.state='Stopped';$s.pid=0};$plan=Get-CompanionMaintenanceRestorePlan $before $current;if(($plan -join ',') -cne 'CluedCISwapBroker,CluedCIResident,CluedCIUpgrader'){throw 'RESTORE_ORDER'}}
Check 'never restore originally stopped service' {$before=ServicesFixture;$before[1].originallyRunning=$false;$before[1].stoppedByOperation=$false;$before[1].state='Stopped';$before[1].pid=0;$current=ServicesFixture;foreach($s in $current){$s.state='Stopped';$s.pid=0};$plan=Get-CompanionMaintenanceRestorePlan $before $current;if($plan -contains 'CluedCIResident'){throw 'RESTORED_ORIGINALLY_STOPPED'}}
Check 'never restore a service not stopped by operation' {$before=ServicesFixture;$before[0].stoppedByOperation=$false;$current=ServicesFixture;foreach($s in $current){$s.state='Stopped';$s.pid=0};$current[0].state='Running';$current[0].pid=123;$plan=Get-CompanionMaintenanceRestorePlan $before $current;if($plan -contains 'CluedCIUpgrader'){throw 'RESTORED_UNOWNED_STOP'}}
Check 'restore config change refuses all starts' {$before=ServicesFixture;$current=ServicesFixture;foreach($s in $current){$s.state='Stopped';$s.pid=0};$current[0].configSha256='changed';Refuses {Get-CompanionMaintenanceRestorePlan $before $current} 'MAINTENANCE_RESTORE_CONFIG_CHANGED'}
Check 'real locked fixture VHD reports busy then free without WSL' {
  $file=Join-Path ([IO.Path]::GetTempPath()) ('clued-maintenance-fixture-'+[guid]::NewGuid().ToString('N')+'.vhdx')
  $created=[IO.File]::Open($file,'CreateNew','Write','None');try{$created.WriteByte(1)}finally{$created.Dispose()}
  try{
    $busy=[IO.File]::Open($file,'Open','ReadWrite','ReadWrite')
    try{if(Test-CompanionMaintenanceVhdFree $file){throw 'BUSY_FILE_WAS_FREE'}}finally{$busy.Dispose()}
    if(-not (Test-CompanionMaintenanceVhdFree $file)){throw 'CLOSED_FILE_WAS_BUSY'}
  }finally{[IO.File]::Delete($file)}
}
# Real NTFS sharing/publication controls. These use only new temporary files.
Check 'directory share3 permits File.Replace and denies Directory.Move' {
  $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-publish-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($directory)
  $held=$null
  try{
    $old=Join-Path $directory 'status.json';$next=Join-Path $directory 'next.json';[IO.File]::WriteAllText($old,'old');[IO.File]::WriteAllText($next,'new')
    $held=Open-CompanionMaintenanceEntry $directory $true
    [IO.File]::Replace($next,$old,[NullString]::Value)
    if([IO.File]::ReadAllText($old) -cne 'new'){throw 'PUBLISH_BLOCKED'}
    try{[IO.Directory]::Move($directory,($directory+'-moved'));throw 'DIRECTORY_MOVE_ALLOWED'}catch [IO.IOException]{}
  }finally{if($held){$held.Dispose()};if([IO.Directory]::Exists($directory)){[IO.Directory]::Delete($directory,$true)}}
}
Check 'old directory share1 reproduces blocked atomic publication' {
  $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-old-share-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($directory);$held=$null
  try{
    $old=Join-Path $directory 'status.json';$next=Join-Path $directory 'next.json';[IO.File]::WriteAllText($old,'old');[IO.File]::WriteAllText($next,'new')
    $raw=Invoke-CompanionMaintenanceNative 'CreateFileW' @($directory,[uint32]2147483648,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]0x02200000,[IntPtr]::Zero)
    $held=New-Object Microsoft.Win32.SafeHandles.SafeFileHandle($raw,$true)
    if($held.IsInvalid){throw 'OLD_SHARE_FIXTURE_NOT_OPENED'}
    try{[IO.File]::Replace($next,$old,[NullString]::Value);throw 'OLD_DIR_SHARE_DID_NOT_BLOCK'}catch [IO.IOException]{}
  }finally{if($held){$held.Dispose()};[IO.Directory]::Delete($directory,$true)}
}
Check 'static Source share1 still blocks replacement but live share7 permits it' {
  $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-live-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($directory);$held=$null
  try{
    $old=Join-Path $directory 'status.json';$next=Join-Path $directory 'next.json';[IO.File]::WriteAllText($old,'old');[IO.File]::WriteAllText($next,'new')
    $held=Open-CompanionMaintenanceEntry $old $false
    try{[IO.File]::Replace($next,$old,[NullString]::Value);throw 'STATIC_SOURCE_NOT_LOCKED'}catch [IO.IOException]{}
    $held.Dispose();$held=Open-CompanionMaintenanceEntry $old $false -Live
    [IO.File]::Replace($next,$old,[NullString]::Value);$held.Dispose();$held=$null
    if([Text.Encoding]::UTF8.GetString((Read-CompanionMaintenanceBytes $old -Live)) -cne 'new'){throw 'LIVE_READ_FAILED'}
  }finally{if($held){$held.Dispose()};[IO.Directory]::Delete($directory,$true)}
}
Check 'live read refuses a real atomic replacement during observation' {
  $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-race-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($directory)
  $old=Join-Path $directory 'status.json';$script:publishNext=Join-Path $directory 'next.json';$script:publishOld=$old
  [IO.File]::WriteAllText($old,'old');[IO.File]::WriteAllText($script:publishNext,'new')
  $script:realStreamReader=(Get-Item Function:Read-CompanionMaintenanceStreamBytes).ScriptBlock;$script:reads=0
  function Read-CompanionMaintenanceStreamBytes($Stream,[int]$Maximum){$bytes=& $script:realStreamReader $Stream $Maximum;$script:reads++;if($script:reads -eq 1){[IO.File]::Replace($script:publishNext,$script:publishOld,[NullString]::Value)};return ,$bytes}
  try{Refuses {Read-CompanionMaintenanceBytes $old -Live} 'MAINTENANCE_LIVE_READ_CHANGED'}finally{Set-Item Function:Read-CompanionMaintenanceStreamBytes $script:realStreamReader;[IO.Directory]::Delete($directory,$true)}
}
Check 'registered VHD lookup uses metadata while a writer holds the file' {
  $script:registryFixture=Join-Path ([IO.Path]::GetTempPath()) ('clued-registry-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($script:registryFixture)
  $path=Join-Path $script:registryFixture 'ext4.vhdx';[IO.File]::WriteAllText($path,'fixture');$busy=[IO.File]::Open($path,'Open','ReadWrite','ReadWrite')
  function Get-ChildItem {return @{PSPath='fixture-registry-key'}}
  function Get-ItemProperty {return @{DistributionName='CluedLinux';BasePath=$script:registryFixture}}
  try{if((Get-CompanionMaintenanceRegisteredVhd 'CluedLinux') -cne $path){throw 'REGISTERED_VHD_METADATA_FAILED'}}finally{$busy.Dispose();Remove-Item Function:Get-ChildItem;Remove-Item Function:Get-ItemProperty;[IO.Directory]::Delete($script:registryFixture,$true)}
}
foreach($configIndex in @(0,1,2,3)){
  Check ('actual replaceable config slot '+$configIndex+' permits publication and refuses changed read') {
    $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-config-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory((Join-Path $directory 'config'));[void][IO.Directory]::CreateDirectory((Join-Path $directory 'upgrader\config'))
    $paths=@('config\policy.json','config\companion.json','config\broker.json','upgrader\config\upgrader.json');$hashes=@()
    foreach($path in $paths){$file=Join-Path $directory $path;[IO.File]::WriteAllText($file,('{"kind":"'+$path.Replace('\','-')+'"}'));$hashes+=,(Get-CompanionMaintenanceHash ([IO.File]::ReadAllBytes($file)))}
    $receipt=@{policySha256=$hashes[0];companionConfigSha256=$hashes[1];brokerConfigSha256=$hashes[2];upgrader=@{configSha256=$hashes[3]}}
    Assert-CompanionMaintenanceRegisteredConfigs $directory $receipt
    $script:configReadCount=0;$script:configPublishAt=$configIndex*2+1;$script:configPublished=$false;$script:configOld=Join-Path $directory $paths[$configIndex];$script:configNext=$script:configOld+'.next';[IO.File]::WriteAllText($script:configNext,'{"kind":"new-publication"}')
    $script:configRealReader=(Get-Item Function:Read-CompanionMaintenanceStreamBytes).ScriptBlock
    function Read-CompanionMaintenanceStreamBytes($Stream,[int]$Maximum){$bytes=& $script:configRealReader $Stream $Maximum;$script:configReadCount++;if($script:configReadCount -eq $script:configPublishAt){[IO.File]::Replace($script:configNext,$script:configOld,[NullString]::Value);$script:configPublished=$true};return ,$bytes}
    try{Refuses {Assert-CompanionMaintenanceRegisteredConfigs $directory $receipt} 'MAINTENANCE_LIVE_READ_CHANGED';if(-not $script:configPublished){throw 'CONFIG_PUBLICATION_WAS_BLOCKED'}}finally{Set-Item Function:Read-CompanionMaintenanceStreamBytes $script:configRealReader;[IO.Directory]::Delete($directory,$true)}
  }
}
foreach($slot in @('record\source-manifest.json','config\source-installed-manifest.json','config\resident-installed-manifest.json','record\acceptance.json')){
  Check ('actual metadata slot '+$slot+' permits publication and refuses changed read') {
    $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-metadata-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory((Join-Path $directory ([IO.Path]::GetDirectoryName($slot))))
    $script:metadataOld=Join-Path $directory $slot;$script:metadataNext=$script:metadataOld+'.next';[IO.File]::WriteAllText($script:metadataOld,'{"snapshot":"old"}');[IO.File]::WriteAllText($script:metadataNext,'{"snapshot":"new"}')
    $hash=Get-CompanionMaintenanceHash ([IO.File]::ReadAllBytes($script:metadataOld));$null=Read-CompanionMaintenancePublishedSlot $directory $slot $hash
    $script:metadataReader=(Get-Item Function:Read-CompanionMaintenanceStreamBytes).ScriptBlock;$script:metadataRead=0;$script:metadataPublished=$false
    function Read-CompanionMaintenanceStreamBytes($Stream,[int]$Maximum){$bytes=& $script:metadataReader $Stream $Maximum;$script:metadataRead++;if($script:metadataRead -eq 1){[IO.File]::Replace($script:metadataNext,$script:metadataOld,[NullString]::Value);$script:metadataPublished=$true};return ,$bytes}
    try{Refuses {Read-CompanionMaintenancePublishedSlot $directory $slot $hash} 'MAINTENANCE_LIVE_READ_CHANGED';if(-not $script:metadataPublished){throw 'METADATA_PUBLICATION_BLOCKED'}}finally{Set-Item Function:Read-CompanionMaintenanceStreamBytes $script:metadataReader;[IO.Directory]::Delete($directory,$true)}
  }
}
Check 'system console hardlink exception rejects other paths' {Refuses {Open-CompanionMaintenanceEntry $helper $false -SystemConsoleImage} 'MAINTENANCE_SYSTEM_IMAGE_PATH_REFUSED'}
Check 'machine image rejects a non-system owner' {Refuses {Assert-CompanionMaintenanceMachineImageAcl ('O:'+$owner+'D:P(A;;FA;;;SY)(A;;FA;;;BA)')} 'MAINTENANCE_MACHINE_IMAGE_OWNER_REFUSED'}
Check 'machine image rejects an outsider writer' {Refuses {Assert-CompanionMaintenanceMachineImageAcl 'O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;GW;;;BU)'} 'MAINTENANCE_MACHINE_IMAGE_ACL_REFUSED'}
Check 'actual Windows console system aliases remain read-only signature/hash inputs' {$image=Get-CompanionMaintenanceMachineImage 'console';if($image.path -cne 'C:\Windows\System32\conhost.exe' -or $image.sha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'SYSTEM_CONSOLE_IMAGE_UNKNOWN'}}
Check 'console special path still rejects a real NTFS reparse object' {
  $directory=Join-Path ([IO.Path]::GetTempPath()) ('clued-console-link-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory((Join-Path $directory 'target'));$script:consoleJunction=Join-Path $directory 'link';$null=New-Item -ItemType Junction -Path $script:consoleJunction -Target (Join-Path $directory 'target')
  $script:consoleRealNative=${function:Invoke-CompanionMaintenanceNative}
  function Invoke-CompanionMaintenanceNative([string]$Name,[object[]]$Arguments){if($Name -ceq 'CreateFileW' -and $Arguments[0] -ceq 'C:\Windows\System32\conhost.exe'){$Arguments=$Arguments.Clone();$Arguments[0]=$script:consoleJunction;$Arguments[5]=[uint32]0x02200000;$script:reparseRawHandle=& $script:consoleRealNative $Name $Arguments;return $script:reparseRawHandle};return (& $script:consoleRealNative $Name $Arguments)}
  try{Refuses {Open-CompanionMaintenanceEntry 'C:\Windows\System32\conhost.exe' $false -SystemConsoleImage} 'MAINTENANCE_LINK_OR_KIND_REFUSED';$info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52);try{if(& $script:consoleRealNative 'GetFileInformationByHandle' @($script:reparseRawHandle,$info)){throw 'REPARSE_REFUSAL_LEAKED_HANDLE'}}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}}finally{Set-Item Function:Invoke-CompanionMaintenanceNative $script:consoleRealNative;[IO.Directory]::Delete($script:consoleJunction,$false);[IO.Directory]::Delete($directory,$true)}
}
Check 'wrong console signature is refused before hashing any candidate bytes' {
  function Get-AuthenticodeSignature {return @{Status='HashMismatch';SignerCertificate=$null}}
  try{Refuses {Get-CompanionMaintenanceMachineImage 'console'} 'MAINTENANCE_MACHINE_WSL_PUBLISHER_REFUSED'}finally{Remove-Item Function:Get-AuthenticodeSignature}
}
Check 'wslhost protocol rejects unbounded or duplicate handles' {$registration=@{distroId='{11111111-1111-1111-1111-111111111111}'};Refuses {Assert-CompanionMaintenanceHostCommand ' --distro-id {11111111-1111-1111-1111-111111111111} --vm-id {22222222-2222-2222-2222-222222222222} --handle 760 --event 760 --parent 800' $registration} 'MAINTENANCE_WSLHOST_HANDLES_UNKNOWN';Refuses {Assert-CompanionMaintenanceHostCommand ' --distro-id {11111111-1111-1111-1111-111111111111} --vm-id {22222222-2222-2222-2222-222222222222} --handle 9999999999 --event 796 --parent 800' $registration} 'MAINTENANCE_WSLHOST_HANDLES_UNKNOWN'}
# Runtime stop decision, with transport adapters replaced by spies.
$script:stopCalls=@();$script:waitCalls=@();$script:liveService=@{}
function Get-CompanionMaintenanceService([string]$Name){return $script:liveService}
function Send-CompanionMaintenanceServiceStop([string]$Name){$script:stopCalls+=,$Name}
function Wait-CompanionMaintenanceServiceStopped($Baseline,[int]$Seconds){$script:waitCalls+=,$Seconds}
Check 'natural stop sends once then waits without force' {$b=(ServicesFixture)[0];$b.stoppedByOperation=$false;$script:liveService=$b.Clone();Stop-CompanionMaintenanceService $b 180;if($script:stopCalls.Count -ne 1 -or $script:waitCalls[0] -ne 180 -or -not $b.stoppedByOperation){throw 'STOP_SEQUENCE'}}
Check 'service PID race stops nothing' {$b=(ServicesFixture)[0];$script:liveService=$b.Clone();$script:liveService.pid=999;$before=$script:stopCalls.Count;Refuses {Stop-CompanionMaintenanceService $b 180} 'MAINTENANCE_SERVICE_CHANGED_BEFORE_STOP';if($script:stopCalls.Count -ne $before){throw 'STOPPED_RACING_PID'}}
Check 'already stopped service remains unowned' {$b=(ServicesFixture)[0];$b.state='Stopped';$b.pid=0;$b.originallyRunning=$false;$b.stoppedByOperation=$false;$script:liveService=$b.Clone();$before=$script:stopCalls.Count;Stop-CompanionMaintenanceService $b 180;if($script:stopCalls.Count -ne $before -or $b.stoppedByOperation){throw 'STOPPED_ALREADY_STOPPED'}}
# Exercise the real guard with local transports replaced. Writes are an
# in-memory create-only ledger; no file, registry, service or WSL is touched.
$script:writes=@{};$script:free=$true;$script:quietFailure=$false;$script:running=@('CluedLinux')
function Read-CompanionMaintenanceContext([string]$ContextFile,[string]$ExpectedContextSha256){return $script:context}
function Get-CompanionMaintenanceRegisteredVhd([string]$Distribution){return 'C:\Owned\ext4.vhdx'}
function Get-CompanionMaintenanceLocal {if($script:quietFailure){throw 'LOCAL_BUSY'};return @{}}
function Assert-CompanionMaintenanceServices {}
function Get-CompanionMaintenanceWsl {return ,$script:running}
function Test-CompanionMaintenanceVhdFree {return $script:free}
function Write-CompanionMaintenanceNew([string]$Path,$Value){if($script:writes.ContainsKey($Path)){throw 'CREATE_ONLY_EXISTS'};$script:writes[$Path]=$Value}
function GuardFixture {$f=Fixture;$script:context=@{root='C:\ProgramData\CluedIndependentCI\resident';subject=$f.subject;operationId=$f.challenge.operationId;challenge=$f.challenge;host=$f.hostEvidence;pausedSha256=$f.challenge.pausedSha256;trackedProcesses=@();services=@();coveredWsl=@('CluedLinux');evidenceDirectory='C:\Protected\operation'};$script:writes=@{};$script:free=$true;$script:quietFailure=$false;$script:running=@('CluedLinux')}
Check 'free VHD still requires current authorization and marks once' {GuardFixture;$r=Assert-CompanionMaintenanceShutdownGuard -Path 'C:\Owned\ext4.vhdx' -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 ('e'*64);if($r.vmShutdownRequired -isnot [bool] -or $r.vmShutdownRequired -or $script:writes.Count -ne 1){throw 'FREE_GUARD'}}
Check 'free VHD cannot reuse same context' {Refuses {Assert-CompanionMaintenanceShutdownGuard -Path 'C:\Owned\ext4.vhdx' -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 ('e'*64)} 'CREATE_ONLY_EXISTS'}
Check 'busy VHD creates release then shutdown intent once' {GuardFixture;$script:free=$false;$r=Assert-CompanionMaintenanceShutdownGuard -Path 'C:\Owned\ext4.vhdx' -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 ('e'*64);if(-not $r.vmShutdownRequired -or $r.intentFile -cne 'C:\Protected\operation\shutdown.intent.json' -or $script:writes.Count -ne 2){throw 'NO_SHUTDOWN_INTENT'}}
Check 'local busy denies even free VHD writes zero' {GuardFixture;$script:quietFailure=$true;Refuses {Assert-CompanionMaintenanceShutdownGuard -Path 'C:\Owned\ext4.vhdx' -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 ('e'*64)} 'LOCAL_BUSY';if($script:writes.Count){throw 'WROTE_ON_LOCAL_DENIAL'}}
Check 'new WSL distribution denies writes zero' {GuardFixture;$script:running=@('CluedLinux','Other');Refuses {Assert-CompanionMaintenanceShutdownGuard -Path 'C:\Owned\ext4.vhdx' -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 ('e'*64)} 'MAINTENANCE_WSL_SCOPE_CHANGED';if($script:writes.Count){throw 'WROTE_ON_SCOPE_DENIAL'}}
Check 'expired authorization denies even free VHD writes zero' {GuardFixture;$script:context.host.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');Refuses {Assert-CompanionMaintenanceShutdownGuard -Path 'C:\Owned\ext4.vhdx' -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 ('e'*64)} 'MAINTENANCE_AUTHORITY_EXPIRED';if($script:writes.Count){throw 'WROTE_ON_EXPIRED'}}
# Completion is separately tested against fixed command results. All storage
# operations remain in memory and all actual machine transports stay replaced.
function Get-Acl {return @{Sddl='fixture'}}
function Assert-CompanionMaintenanceAcl {}
function Assert-CompanionMaintenanceIdentity {}
function Read-CompanionMaintenanceBytes {return ,$script:completionBytes}
function Read-CompanionMaintenanceJson {return @{contract='clued.companion-maintenance.shutdown-intent/1';operationId=$script:context.operationId;contextSha256=$script:completionSha;path='C:\Owned\ext4.vhdx';command='wsl.exe --shutdown'}}
function CompletionFixture {GuardFixture;$script:completionBytes=ConvertTo-CompanionMaintenanceBytes $script:context;$script:completionSha=Get-CompanionMaintenanceHash $script:completionBytes;$script:running=@();$script:free=$true}
Check 'actual completion returns two explicit postconditions' {CompletionFixture;$r=Complete-CompanionMaintenanceShutdown -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 $script:completionSha -Result @{completed=$true;exitCode=0};if($r.completed -isnot [bool] -or -not $r.completed -or -not $r.exclusiveFileConfirmed -or $script:writes.Count -ne 2){throw 'COMPLETION_POSTCONDITION'}}
Check 'unknown shutdown result preserved and refused' {CompletionFixture;Refuses {Complete-CompanionMaintenanceShutdown -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 $script:completionSha -Result @{completed=$false;exitCode=$null}} 'MAINTENANCE_SHUTDOWN_FAILED_OR_UNKNOWN';if($script:writes.Count -ne 1){throw 'UNKNOWN_RESULT_NOT_PRESERVED'}}
Check 'nonzero shutdown result preserved and refused' {CompletionFixture;Refuses {Complete-CompanionMaintenanceShutdown -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 $script:completionSha -Result @{completed=$true;exitCode=1}} 'MAINTENANCE_SHUTDOWN_FAILED_OR_UNKNOWN'}
Check 'WSL remains running after success exit refused' {CompletionFixture;$script:running=@('CluedLinux');Refuses {Complete-CompanionMaintenanceShutdown -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 $script:completionSha -Result @{completed=$true;exitCode=0}} 'MAINTENANCE_WSL_STILL_RUNNING'}
Check 'completion cannot overwrite previous unknown result' {Refuses {Complete-CompanionMaintenanceShutdown -ContextFile 'C:\Protected\operation\accepted.json' -ExpectedContextSha256 $script:completionSha -Result @{completed=$true;exitCode=0}} 'CREATE_ONLY_EXISTS'}
# Full Core serial fixture: only I/O/SCM/Task/token-facts transports are
# replaced. Source/config hashing, local journal/runner/process checks,
# nonce-bound authority, action outcome, recovery plan and durable latch run
# as production code. Nothing reaches the real service manager or WSL.
. $helper
$script:fs=@{};$script:directories=@{};$script:services=@{};$script:trace=@();$script:coreMode='success';$script:companionProcesses=@()
function Put-Core([string]$Path,$Value){$script:fs[$Path]=ConvertTo-CompanionMaintenanceBytes $Value}
function Core-Json([string]$Path){ConvertFrom-CompanionMaintenanceJson $script:fs[$Path]}
function Test-Path([string]$LiteralPath){return ($script:fs.ContainsKey($LiteralPath) -or $script:directories.ContainsKey($LiteralPath))}
function Read-CompanionMaintenanceBytes([string]$Path,[int]$Maximum=1048576,[switch]$Live,[string]$OwnerSid,[switch]$PrivateDrop,[switch]$AllowReadOnlyOthers,[switch]$MachineImage,[switch]$SystemConsoleImage){if(-not $script:fs.ContainsKey($Path)){throw ('FIXTURE_FILE_MISSING:'+ $Path)};return ,$script:fs[$Path]}
function Write-CompanionMaintenanceNew([string]$Path,$Value){if($script:fs.ContainsKey($Path)){throw 'FIXTURE_CREATE_NEW_EXISTS'};Put-Core $Path $Value}
function Open-CompanionMaintenanceEntry {return ,(New-Object IO.MemoryStream)}
function New-CompanionMaintenanceDirectory([string]$Path,[string]$Sddl){if($script:directories.ContainsKey($Path)){throw 'FIXTURE_DIRECTORY_EXISTS'};$script:directories[$Path]=$true}
function Get-Acl {return @{Sddl=('O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;'+$script:subject.operatorSid+')')}}
function Assert-CompanionMaintenanceIdentity {}
function Get-CompanionMaintenanceLatchDirectory {return 'C:\ProgramData\CluedCompanionMaintenance'}
function Get-CompanionMaintenanceDirectoryEntries([string]$Directory){return ,@('C:\ProgramData\CluedCompanionMaintenance')}
function Move-CompanionMaintenanceLatch([string]$Source,[string]$Destination){if($script:fs.ContainsKey($Destination)){throw 'FIXTURE_MOVE_DEST_EXISTS'};$script:fs[$Destination]=$script:fs[$Source];$script:fs.Remove($Source)}
function Get-ChildItem([string]$LiteralPath){
  $seen=@{};$prefix=$LiteralPath.TrimEnd('\')+'\'
  foreach($path in @($script:fs.Keys)+@($script:directories.Keys)){if($path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$relative=$path.Substring($prefix.Length);$name=($relative -split '\\')[0];if($name -and -not $seen.ContainsKey($name)){$seen[$name]=$true;[pscustomobject]@{Name=$name;FullName=($prefix+$name);PSIsContainer=($relative.Contains('\') -or $script:directories.ContainsKey($prefix+$name));Attributes=[IO.FileAttributes]::Normal}}}}
}
function Get-CompanionMaintenanceService([string]$Name){if($script:services.ContainsKey($Name)){return (Clone $script:services[$Name])};throw 'FIXTURE_UNKNOWN_SERVICE'}
function Send-CompanionMaintenanceServiceStop([string]$Name){$script:trace+=,('stop:'+ $Name);$script:services[$Name].state='Stopped';$script:services[$Name].pid=0}
function Wait-CompanionMaintenanceServiceStopped {}
function Start-CompanionMaintenanceService([string]$Name){$script:trace+=,('start:'+ $Name);$script:services[$Name].state='Running';$script:services[$Name].pid=901}
function Get-CompanionMaintenanceFallback {return @{present=($script:coreMode -ceq 'old-fallback')}}
function Get-CompanionMaintenanceWsl {return ,@('CluedLinux')}
function Get-CompanionMaintenanceRegisteredVhd {return $script:subject.vhdxPath}
function Get-CompanionMaintenanceWslClient {return @{path='C:\Program Files\WSL\wsl.exe';sha256=(Get-CompanionMaintenanceHash $script:fs['C:\Program Files\WSL\wsl.exe']);signerThumbprint=('A'*40);host=@{path='C:\Program Files\WSL\wslhost.exe';sha256=(Get-CompanionMaintenanceHash $script:fs['C:\Program Files\WSL\wslhost.exe']);signerThumbprint=('A'*40)};console=@{path='C:\Windows\System32\conhost.exe';sha256=(Get-CompanionMaintenanceHash $script:fs['C:\Windows\System32\conhost.exe']);signerThumbprint=('B'*40)}}}
function Get-CompanionMaintenanceTargetRegistration($Subject){return @{distroId='{11111111-1111-1111-1111-111111111111}';companionSid=$Subject.companionSid;distribution=$Subject.wslDistribution;vhdxPath=$Subject.targetVhdxPath}}
function Get-CompanionMaintenanceProcessCommand($Process){if($Process.image -ceq 'C:\Program Files\WSL\wslhost.exe'){return ' --distro-id {11111111-1111-1111-1111-111111111111} --vm-id {22222222-2222-2222-2222-222222222222} --handle 760 --event 796 --parent 800'};if($Process.image -ieq 'C:\Windows\System32\conhost.exe'){return '\??\C:\WINDOWS\system32\conhost.exe 0x4'};return '"C:\Program Files\WSL\wsl.exe" --distribution CluedLinux --exec /bin/sleep infinity'}
function Get-CompanionMaintenanceProcesses {
  $rows=@();foreach($s in $script:services.Values){if($s.name -cne 'FixtureRunner' -and $s.state -ceq 'Running'){$rows+=,@{pid=$s.pid;parent=0;image=($script:root+'\bin\'+$s.name+'.exe');createdAt=$now.AddMinutes(-5).ToString('o')}}}
  $rows+= $script:companionProcesses
  if($script:coreMode -ceq 'orphan-after-action' -and $script:companionProcesses.Count){$rows+=,@{pid=999;parent=0;image=($script:root+'\runtime\node.exe');createdAt=$now.ToString('o')}}
  return ,$rows
}
function Get-CompanionMaintenanceTokenFacts([string]$Root,[long]$ProcessId,$Receipt){$row=@($script:companionProcesses|Where-Object{$_.pid -eq $ProcessId})[0];$token=@{code='TOKEN_FACTS';pid=$ProcessId;userSid=$script:subject.companionSid;sessionId=0;imagePath=$row.image;elevationType=3;adminsPresent=$false;adminsDenyOnly=$false};if($script:coreMode -ceq 'elevated-companion'){$token.elevationType=2};if($script:coreMode -ceq 'wrong-companion-sid'){$token.userSid='S-1-5-18'};if($script:coreMode -ceq 'console-token' -and $row.image -ieq 'C:\Windows\System32\conhost.exe'){$token.sessionId=1};if($script:coreMode -ceq 'host-token' -and $row.image -ceq 'C:\Program Files\WSL\wslhost.exe'){$token.userSid='S-1-5-18'};return $token}
function Wait-CompanionMaintenanceHost([string]$HostDrop,[string]$Name,$Challenge,[switch]$RequireInventory){
  $f=Fixture;$value=$f.hostEvidence
  foreach($key in @('operationId','nonce','pid','processStartedAt','phase','subject','pausedSha256','coveredWsl')){$value[$key]=$Challenge[$key]}
  $value.grant.subject=$Challenge.subject;$value.grant.coveredWsl=$Challenge.coveredWsl;$value.github.coveredWsl=$Challenge.coveredWsl
  $value.createdAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o');$value.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(110).ToString('o');$value.grant.createdAt=$value.createdAt;$value.grant.expiresAt=$value.expiresAt;$value.github.createdAt=$value.createdAt;$value.github.expiresAt=$value.expiresAt
  if($script:coreMode -ceq 'pre-action-authority-expired' -and $Challenge.phase -ceq 'after-stop'){$value.grant.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o')}
  if($Challenge.phase -ceq 'before-restore'){$script:trace+=,'restore-authority';if($script:coreMode -ceq 'restore-expired'){$value.grant.expiresAt=[DateTimeOffset]::UtcNow.AddSeconds(-1).ToString('o')};if($script:coreMode -ceq 'restore-revoked'){$value.grant.current=$false}}
  Assert-CompanionMaintenanceHost $value $Challenge ([DateTimeOffset]::UtcNow) -RequireInventory:$RequireInventory
  return @{value=$value;sha256=(Get-CompanionMaintenanceHash (ConvertTo-CompanionMaintenanceBytes $value))}
}
function CoreFixture([string]$Mode='success',[switch]$KeepLatch){
  $oldLatch=if($KeepLatch -and $script:fs.ContainsKey('C:\ProgramData\CluedCompanionMaintenance\active.json')){$script:fs['C:\ProgramData\CluedCompanionMaintenance\active.json']}else{$null}
  $script:coreMode=$Mode;$script:root='C:\ProgramData\CluedIndependentCI\resident';$r=$script:root;$script:fs=@{};$script:directories=@{};$script:trace=@();$script:companionProcesses=@();$script:subject=(Fixture).subject;$script:subject.operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach($dir in @('C:\ProgramData\CluedCompanionMaintenance','C:\Stage','C:\PrivateDrop',($r+'\state\ledger'),($r+'\upgrade\ops'),($r+'\broker\requests'))){$script:directories[$dir]=$true}
  if($null -ne $oldLatch){$script:fs['C:\ProgramData\CluedCompanionMaintenance\active.json']=$oldLatch}
  $script:fs[$r+'\record\source-manifest.json']=[Text.Encoding]::UTF8.GetBytes('{"sourceSha":"fixture"}');$script:subject.ciSourceManifestSha256=Get-CompanionMaintenanceHash $script:fs[$r+'\record\source-manifest.json']
  $sourceBytes=[Text.Encoding]::UTF8.GetBytes('actual-source');$sourcePath='work/unit.mjs';$script:fs[$r+'\source\'+$script:subject.ciSourceManifestSha256+'\work\unit.mjs']=$sourceBytes
  Put-Core ($r+'\config\source-installed-manifest.json') @{contract='clued.independent-ci.resident-installed-manifest/1';root='source';files=@(@{path=$sourcePath;bytes=$sourceBytes.Length;sha256=(Get-CompanionMaintenanceHash $sourceBytes)})}
  $residentFiles=@();foreach($name in @('windows/companion-maintenance.ps1','windows/rearm-resident.ps1')){$bytes=[Text.Encoding]::UTF8.GetBytes($name);$residentFiles+=,@{path=$name;bytes=$bytes.Length;sha256=(Get-CompanionMaintenanceHash $bytes)}}
  Put-Core ($r+'\config\resident-installed-manifest.json') @{contract='clued.independent-ci.resident-installed-manifest/1';root='resident';files=$residentFiles}
  $script:subject.residentManifestSha256=Get-CompanionMaintenanceHash $script:fs[$r+'\config\resident-installed-manifest.json']
  foreach($entry in $residentFiles){$script:fs[$r+'\resident\'+$script:subject.residentManifestSha256+'\'+$entry.path.Replace('/','\')]=[Text.Encoding]::UTF8.GetBytes($entry.path);if($entry.path -ceq 'windows/rearm-resident.ps1'){$script:subject.rearmSha256=$entry.sha256}}
  Put-Core ($r+'\record\acceptance.json') @{node=@{nodeName=$script:subject.node;hostname=[Environment]::MachineName;runnerService='FixtureRunner';ownerSid=$script:subject.companionSid;wslDistribution='CluedLinux'}}
  Put-Core ($r+'\install\companion-account.json') @{contract='clued.independent-ci.companion-account/1';operatorSid=$script:subject.operatorSid;companionSid=$script:subject.companionSid}
  $configHashes=@{};foreach($path in @('config\policy.json','config\companion.json','config\broker.json','upgrader\config\upgrader.json')){Put-Core ($r+'\'+$path) @{kind=$path};$configHashes[$path]=Get-CompanionMaintenanceHash $script:fs[$r+'\'+$path]}
  foreach($file in @('bin\CluedCompanionSupervisor.exe','bin\CluedCompanionTaskRegistrar.exe','runtime\node.exe')){$script:fs[$r+'\'+$file]=[Text.Encoding]::UTF8.GetBytes($file)}
  foreach($image in @('C:\Program Files\WSL\wsl.exe','C:\Program Files\WSL\wslhost.exe','C:\Windows\System32\conhost.exe')){$script:fs[$image]=[Text.Encoding]::UTF8.GetBytes($image)}
  $receipt=@{packageManifestSha256=$script:subject.packageManifestSha256;residentManifestSha256=$script:subject.residentManifestSha256;sourceManifestSha256=(Get-CompanionMaintenanceHash $script:fs[$r+'\config\source-installed-manifest.json']);policySha256=$configHashes['config\policy.json'];companionConfigSha256=$configHashes['config\companion.json'];brokerConfigSha256=$configHashes['config\broker.json'];companionSupervisorSha256=(Get-CompanionMaintenanceHash $script:fs[$r+'\bin\CluedCompanionSupervisor.exe']);companionRegistrarSha256=(Get-CompanionMaintenanceHash $script:fs[$r+'\bin\CluedCompanionTaskRegistrar.exe']);residentBinaryPath='binary-CluedCIResident';brokerBinaryPath='binary-CluedCISwapBroker';upgrader=@{binaryPath='binary-CluedCIUpgrader';configSha256=$configHashes['upgrader\config\upgrader.json'];nodeSha256=(Get-CompanionMaintenanceHash $script:fs[$r+'\runtime\node.exe'])}}
  $receipt.acceptanceSha256=Get-CompanionMaintenanceHash $script:fs[$r+'\record\acceptance.json']
  Put-Core ($r+'\install\install-receipt.json') $receipt;$script:subject.installReceiptSha256=Get-CompanionMaintenanceHash $script:fs[$r+'\install\install-receipt.json']
  Put-Core ($r+'\upgrade\current.json') @{contract='clued.independent-ci.resident-generation/1';packageManifestSha256=$script:subject.packageManifestSha256;residentManifestSha256=$script:subject.residentManifestSha256;ciSourceManifestSha256=$script:subject.ciSourceManifestSha256;installReceiptSha256=$script:subject.installReceiptSha256}
  Put-Core ($r+'\state\PAUSED.json') @{request='original-pause'}
  Put-Core ($r+'\state\status.json') @{contract='clued.independent-ci.resident-status/8';writtenAt=[DateTimeOffset]::UtcNow.ToString('o');current=$null;halt=$null;paused=$true;executor=@{state='PAUSED'};train=@{enabled='on'}}
  Put-Core ($r+'\upgrade\status.json') @{contract='clued.independent-ci.resident-upgrade-status/1';op=$null}
  $script:services=@{};$pidValue=100;foreach($name in @('CluedCIUpgrader','CluedCIResident','CluedCISwapBroker')){$pidValue++;$script:services[$name]=@{name=$name;state='Running';pid=$pidValue;originallyRunning=$true;stoppedByOperation=$false;configSha256=('e'*64);config=@{binary=('binary-'+$name)}}}
  $script:services['FixtureRunner']=@{name='FixtureRunner';state='Stopped';pid=0;config=@{binary=$script:subject.runnerBinary;sc=@($script:subject.runnerSddl)}}
  if($Mode -ceq 'old-pending'){Put-Core ($r+'\install\companion-headless-pending.json') @{status='old'}}
}
function CoreAction([string]$ContextFile,[string]$ContextSha){
  $ctx=Core-Json $ContextFile;$script:trace+=,'action';$r=$ctx.root
  $target=if($script:coreMode -ceq 'entry-target-mismatch'){'C:\Other\ext4.vhdx'}else{$ctx.subject.targetVhdxPath};$sid=if($script:coreMode -ceq 'entry-sid-mismatch'){'S-1-5-18'}else{$ctx.subject.companionSid}
  $null=Assert-CompanionMaintenanceEntry -Root $r -TargetVhdxPath $target -CompanionSid $sid -ContextFile $ContextFile -ExpectedContextSha256 $ContextSha
  if($script:coreMode -ceq 'action-exception'){Write-CompanionMaintenanceNew (Join-Path $ctx.evidenceDirectory 'shutdown.intent.json') @{operationId=$ctx.operationId};throw 'FIXTURE_ACTION_INTERRUPTED'}
  if($script:coreMode -ceq 'exit0-no-proof'){return @{exit=0;stdout='{"status":"COMPANION_HEADLESS_QUALIFIED","result":{"qualified":true,"failed":null,"fellBack":false}}'}}
  $record=@{contract='clued.independent-ci.companion-wsl/1';distro=$ctx.subject.wslDistribution;source=$ctx.subject.vhdxPath;target=$ctx.subject.targetVhdxPath;companionSid=$ctx.subject.companionSid;stage='qualified';imported=$true;qualifiedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  Put-Core ($r+'\install\companion-wsl.json') $record
  $script:companionProcesses=@(@{pid=501;parent=500;image=($r+'\bin\CluedCompanionSupervisor.exe');createdAt=[DateTimeOffset]::UtcNow.ToString('o')},@{pid=502;parent=501;image=($r+'\runtime\node.exe');createdAt=[DateTimeOffset]::UtcNow.ToString('o')},@{pid=503;parent=502;image='C:\Program Files\WSL\wsl.exe';createdAt=[DateTimeOffset]::UtcNow.ToString('o')},@{pid=504;parent=503;image='C:\Program Files\WSL\wslhost.exe';createdAt=[DateTimeOffset]::UtcNow.ToString('o')},@{pid=505;parent=502;image='C:\Windows\System32\conhost.exe';createdAt=[DateTimeOffset]::UtcNow.ToString('o')},@{pid=506;parent=503;image='C:\Windows\System32\conhost.exe';createdAt=[DateTimeOffset]::UtcNow.ToString('o')},@{pid=507;parent=504;image='C:\Windows\System32\conhost.exe';createdAt=[DateTimeOffset]::UtcNow.ToString('o')})
  $qualified=Get-CompanionMaintenanceVerifiedCompanionTree $r $ctx.subject ([DateTimeOffset]::MinValue)
  Write-CompanionMaintenanceNew (Join-Path $ctx.evidenceDirectory 'qualification.result.json') @{contract='clued.companion-maintenance.qualification/1';operationId=$ctx.operationId;contextSha256=$ContextSha;qualified=$true;recordSha256=(Get-CompanionMaintenanceHash $script:fs[$r+'\install\companion-wsl.json']);qualifiedProcesses=$qualified}
  Write-CompanionMaintenanceNew (Join-Path $ctx.evidenceDirectory 'release.accepted.json') @{operationId=$ctx.operationId;contextSha256=$ContextSha;path=$ctx.subject.vhdxPath;vhdAlreadyFree=($script:coreMode -cne 'shutdown-unknown')}
  if($script:coreMode -ceq 'shutdown-unknown'){Write-CompanionMaintenanceNew (Join-Path $ctx.evidenceDirectory 'shutdown.intent.json') @{operationId=$ctx.operationId;contextSha256=$ContextSha;path=$ctx.subject.vhdxPath}}
  if($script:coreMode -ceq 'config-changed'){Put-Core ($r+'\config\broker.json') @{changed=$true}}
  if($script:coreMode -ceq 'source-changed'){$script:fs[$r+'\source\'+$ctx.subject.ciSourceManifestSha256+'\work\unit.mjs']=[Text.Encoding]::UTF8.GetBytes('changed')}
  return @{exit=0;stdout=([Text.Encoding]::UTF8.GetString((ConvertTo-CompanionMaintenanceBytes @{status='COMPANION_HEADLESS_QUALIFIED';result=@{qualified=$true;failed=$null;fellBack=$false;wsl=$record}})))}
}
function RunCore([string]$Evidence='C:\Stage\operation'){Invoke-CompanionMaintenanceCore -Root $script:root -ExpectedSubject $script:subject -HostDrop 'C:\PrivateDrop' -EvidenceDirectory $Evidence -Action ${function:CoreAction}}
Check 'whole Core qualified restores Broker Resident Upgrader and closes fixed latch' {CoreFixture;$null=RunCore;$expected='stop:CluedCIUpgrader,stop:CluedCIResident,stop:CluedCISwapBroker,action,restore-authority,start:CluedCISwapBroker,start:CluedCIResident,start:CluedCIUpgrader';if(($script:trace -join ',') -cne $expected){throw ('CORE_ORDER:'+($script:trace -join ','))};if(Test-Path 'C:\ProgramData\CluedCompanionMaintenance\active.json'){throw 'LATCH_NOT_CLOSED'};if(Test-CompanionMaintenanceRecoveryHold $script:root){throw 'COMPLETED_OPERATION_HELD'}}
Check 'whole Core failure before Action can restore only with new current authority' {CoreFixture 'pre-action-authority-expired';try{$null=RunCore;throw 'STALE_AUTH_ACCEPTED'}catch{if($_.Exception.Message -ceq 'STALE_AUTH_ACCEPTED'){throw}};if(($script:trace -join ',') -cne 'stop:CluedCIUpgrader,stop:CluedCIResident,stop:CluedCISwapBroker,restore-authority,start:CluedCISwapBroker,start:CluedCIResident,start:CluedCIUpgrader'){throw ('PRE_ACTION_RESTORE_ORDER:'+($script:trace -join ','))};if(Test-Path 'C:\ProgramData\CluedCompanionMaintenance\active.json'){throw 'SAFE_ABORT_LATCH_UNCLOSED'}}
foreach($mode in @('exit0-no-proof','action-exception','shutdown-unknown','restore-expired','restore-revoked','config-changed','source-changed','orphan-after-action','elevated-companion','wrong-companion-sid','console-token','host-token','entry-target-mismatch','entry-sid-mismatch')){
  Check ('whole Core '+$mode+' preserves stop and unresolved latch') {CoreFixture $mode;try{$null=RunCore;throw 'CORE_BAD_CASE_ACCEPTED'}catch{if($_.Exception.Message -ceq 'CORE_BAD_CASE_ACCEPTED'){throw}};if(@($script:trace|Where-Object{$_.StartsWith('start:')}).Count){throw 'UNSAFE_SERVICE_RESTART'};if(-not (Test-Path 'C:\ProgramData\CluedCompanionMaintenance\active.json')){throw 'UNKNOWN_LATCH_LOST'};if(-not (Test-CompanionMaintenanceRecoveryHold $script:root)){throw 'SYSTEM_FALLBACK_NOT_HELD'}}
}
Check 'unknown operation blocks new evidence directory and nonce across process state' {CoreFixture 'action-exception';try{$null=RunCore}catch{};CoreFixture 'success' -KeepLatch;Refuses {RunCore 'C:\Stage\different-operation'} 'MAINTENANCE_PREVIOUS_OPERATION_UNRESOLVED';if($script:trace.Count){throw 'SECOND_OPERATION_EFFECT'}}
foreach($mode in @('old-pending','old-fallback')){Check ('initial '+$mode+' stops nothing') {CoreFixture $mode;try{$null=RunCore;throw 'OLD_OPERATION_ACCEPTED'}catch{if($_.Exception.Message -ceq 'OLD_OPERATION_ACCEPTED'){throw}};if($script:trace.Count){throw 'STOPPED_WITH_PREVIOUS_PENDING'}}}
Check 'unreadable active latch holds SYSTEM without reading its JSON' {CoreFixture;$script:fs['C:\ProgramData\CluedCompanionMaintenance\active.json']=[Text.Encoding]::UTF8.GetBytes('{');if(-not (Test-CompanionMaintenanceRecoveryHold $script:root)){throw 'CORRUPT_LATCH_IGNORED'}}
Check 'actual Source entry tamper with unchanged manifest stops nothing' {CoreFixture;$script:fs[$script:root+'\source\'+$script:subject.ciSourceManifestSha256+'\work\unit.mjs']=[Text.Encoding]::UTF8.GetBytes('tamper');Refuses {RunCore} 'MAINTENANCE_ACTUAL_SOURCE_CHANGED';if($script:trace.Count){throw 'SOURCE_TAMPER_EFFECT'}}
Check 'extra unregistered Source entry stops nothing' {CoreFixture;$script:fs[$script:root+'\source\'+$script:subject.ciSourceManifestSha256+'\work\extra.mjs']=[Text.Encoding]::UTF8.GetBytes('extra');Refuses {RunCore} 'MAINTENANCE_UNREGISTERED_SOURCE_ENTRY';if($script:trace.Count){throw 'EXTRA_SOURCE_EFFECT'}}
foreach($path in @('config\policy.json','config\companion.json','config\broker.json','upgrader\config\upgrader.json')){Check ('actual '+$path+' tamper stops nothing') {CoreFixture;Put-Core ($script:root+'\'+$path) @{changed=$true};Refuses {RunCore} 'MAINTENANCE_REGISTERED_CONFIG_CHANGED';if($script:trace.Count){throw 'CONFIG_TAMPER_EFFECT'}}}
Check 'unmatched history completion keeps SYSTEM held' {CoreFixture;Put-Core 'C:\ProgramData\CluedCompanionMaintenance\completed.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json' @{finalized=$true};if(-not (Test-CompanionMaintenanceRecoveryHold $script:root)){throw 'HISTORY_PARTIAL_IGNORED'}}
'TOTAL_PASS='+$passed
'HELPER_SHA256='+(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
