# Offline test of resident-v2/migrate-acl.ps1 on a fixture tree in TEMP (never ProgramData, never elevated).
param([string]$Powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$tool=Join-Path (Split-Path -Parent $PSScriptRoot) 'migrate-acl.ps1';$cases=0
function Yes([bool]$v,[string]$what){if(-not $v){throw ('ACL_TEST_FAILED:'+$what)};$script:cases++}
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$res='S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629';$ctrl='S-1-5-21-1-2-3-1015';$owner='S-1-5-21-1-2-3-1001'
$root=Join-Path ([IO.Path]::GetTempPath()) ('clued-acl-'+[Guid]::NewGuid().ToString('N').Substring(0,10))
function Run([string[]]$extra){$o=& $Powershell -NoProfile -NonInteractive -File $tool -ResidentSid $res -OwnerSid $owner -ControllerSid $ctrl -OfflineFixtureRoot $root @extra;return ($o|Select-Object -Last 1)|ConvertFrom-Json}
try{
 foreach($d in 'formal-spool','formal-spool\outgoing','formal-spool\incoming','state','resident\broker','resident\broker\requests','resident\broker\responses'){[void][IO.Directory]::CreateDirectory((Join-Path $root $d))}
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($p in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($me,'FullControl'))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p[0])),$p[1],'ContainerInherit,ObjectInherit','None','Allow')))}
 foreach($d in 'formal-spool','formal-spool\outgoing','formal-spool\incoming','resident\broker','resident\broker\requests','resident\broker\responses'){[IO.Directory]::SetAccessControl((Join-Path $root $d),$acl)}
 $requestFile=Join-Path $root 'resident\broker\requests\11111111-2222-4333-8444-555555555555.json'
 $responseFile=Join-Path $root 'resident\broker\responses\11111111-2222-4333-8444-555555555555.json'
 $unrelatedFile=Join-Path $root 'resident\broker\token.json'
 $unrelatedSubtree=Join-Path $root 'resident\broker\responses\unrelated-subtree';[void][IO.Directory]::CreateDirectory($unrelatedSubtree)
 $nestedFile=Join-Path $unrelatedSubtree 'other.json';[IO.File]::WriteAllText($nestedFile,'{"unrelated":true}')
 foreach($file in @($requestFile,$responseFile,$unrelatedFile)){[IO.File]::WriteAllText($file,'{"public":true}')}
 $brokerBefore=@{};foreach($d in 'resident\broker','resident\broker\requests','resident\broker\responses'){$brokerBefore[$d]=(Get-Acl -LiteralPath (Join-Path $root $d)).Sddl}
 $before=(Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl
 $plan=Run @();Yes ($plan.status -ceq 'SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN' -and @($plan.steps).Count -eq 18) ('plan-only:'+ $plan.code)
 Yes ((Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl -ceq $before -and -not (Test-Path (Join-Path $root 'state\v2'))) 'plan-wrote-nothing'
 foreach($d in $brokerBefore.Keys){Yes ((Get-Acl -LiteralPath (Join-Path $root $d)).Sddl -ceq $brokerBefore[$d]) ('broker-plan-wrote-nothing:'+ $d)}
 $v=Run @('-Apply');Yes ($v.status -ceq 'SOURCE_V2_ACL_MIGRATED') ('apply:'+$v.code)
 $after=(Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl
 $resAces=@((New-Object Security.AccessControl.RawSecurityDescriptor($after)).DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -ceq $res}|ForEach-Object{('0x{0:x}' -f $_.AccessMask)+'|'+[int]$_.AceFlags})
 Yes ((($resAces|Sort-Object) -join ';') -ceq ((@('0x1200e1|0','0x120089|9')|Sort-Object) -join ';')) ('resident-aces-added:'+($resAces -join ';'))
 $afterSids=@((New-Object Security.AccessControl.RawSecurityDescriptor($after)).DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value+'|'+$_.AccessMask})
 foreach($a in (New-Object Security.AccessControl.RawSecurityDescriptor($before)).DiscretionaryAcl){Yes ($afterSids -ccontains ($a.SecurityIdentifier.Value+'|'+$a.AccessMask)) 'old-ace-kept'}
 $sids={param($p)@((New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $p).Sddl)).DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value})}
 $mutation=[long]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)
 foreach($d in 'resident\broker','resident\broker\requests','resident\broker\responses'){
  $raw=New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath (Join-Path $root $d)).Sddl)
  $old=New-Object Security.AccessControl.RawSecurityDescriptor($brokerBefore[$d]);Yes ($raw.Owner.Value -ceq $old.Owner.Value -and $raw.Group.Value -ceq $old.Group.Value) ('broker-owner-group-kept:'+ $d)
  $controller=@($raw.DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -ceq $ctrl})
  Yes ($controller.Count -gt 0 -and @($controller|Where-Object{($_.AccessMask -band $mutation) -ne 0}).Count -eq 0) ('controller-broker-read-without-mutation:'+ $d)
  foreach($prior in $old.DiscretionaryAcl){Yes (@($raw.DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -ceq $prior.SecurityIdentifier.Value -and $_.AccessMask -eq $prior.AccessMask -and $_.AceFlags -eq $prior.AceFlags}).Count -gt 0) ('broker-prior-ace-kept:'+ $d)}
 }
 foreach($file in @($requestFile,$responseFile)){
  $raw=New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $file).Sddl)
  $controller=@($raw.DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -ceq $ctrl})
  Yes ($controller.Count -gt 0 -and @($controller|Where-Object{($_.AccessMask -band $mutation) -ne 0}).Count -eq 0) 'existing-public-json-inherits-read-only'
  Yes ([IO.File]::ReadAllText($file) -ceq '{"public":true}') 'public-json-bytes-kept'
 }
 Yes ((& $sids $unrelatedFile) -cnotcontains $ctrl) 'broker-root-read-does-not-inherit-to-unrelated-file'
 Yes ((& $sids $nestedFile) -cnotcontains $ctrl) 'controller-public-read-does-not-propagate-to-nested-files'
 Yes ((& $sids (Join-Path $root 'state\v2\receipts')) -ccontains $res -and (& $sids (Join-Path $root 'state\v2\batch-claims')) -cnotcontains $res) 'state-v2-created'
 # stage 10's outcome month segments, their seals and its retention pass records (step 3c-2b, state-retention.mjs) inherit the
 # receipts ACL: clued-control modify (with DELETE, for link + unlink and pruning), the resident read, nothing more for it
 $masks={param($p,$sid)@((New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $p).Sddl)).DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -ceq $sid}|ForEach-Object{'0x{0:x}' -f $_.AccessMask})}
 foreach($d in 'state\v2\receipts\2026-10','state\v2\receipts\index','state\v2\receipts\retention'){
  $p=Join-Path $root $d;[void][IO.Directory]::CreateDirectory($p);$f=Join-Path $p 'outcome-0.json';[IO.File]::WriteAllText($f,'{}')
  foreach($x in @($p,$f)){Yes ((((& $masks $x $res)|Sort-Object -Unique) -join ';') -ceq '0x1200a9' -and (((& $masks $x $ctrl)|Sort-Object -Unique) -join ';') -ceq '0x1301bf') ($d+'-inherits-receipts-acl')}
 }
 Yes ((& $sids (Join-Path $root 'state\relay\jwks')) -ccontains $ctrl -and (& $sids (Join-Path $root 'state\relay\jwks')) -cnotcontains $res) 'relay-jwks-created'
 # stage 8's green ledger (step 3a) and stage 10's shadow records (step 3c-1): clued-control only
 foreach($d in 'state\v2\green-ledger','state\v2\train-shadow','state\v2\train-sweep'){Yes ((& $sids (Join-Path $root $d)) -ccontains $ctrl -and (& $sids (Join-Path $root $d)) -cnotcontains $res) ($d+'-created')}
 $again=Run @('-Apply');Yes ($again.status -ceq 'SOURCE_V2_ACL_MIGRATED' -and @($again.steps|Where-Object{-not $_.skipped}).Count -eq 0) 'idempotent'
 # A controller write ACE on the new public-read boundary is refused during
 # planning, before any target is rewritten. It is never normalized away.
 $responseDir=Join-Path $root 'resident\broker\responses';$good=Get-Acl -LiteralPath $responseDir;$x=Get-Acl -LiteralPath $responseDir
 $x.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($ctrl)),'Write','None','None','Allow')));Set-Acl -LiteralPath $responseDir -AclObject $x
 $badBefore=(Get-Acl -LiteralPath $responseDir).Sddl;$spoolBefore=(Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl
 $bad=Run @('-Apply');Yes ($bad.code -ceq 'ACL_TARGET_HAS_OTHER_CONTROLLER_ACES') ('other-controller-ace:'+ $bad.code)
 Yes ((Get-Acl -LiteralPath $responseDir).Sddl -ceq $badBefore -and (Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl -ceq $spoolBefore) 'controller-refusal-wrote-nothing'
 Set-Acl -LiteralPath $responseDir -AclObject $good
 # A different resident ACE already present is refused, not merged.
 $odd=Join-Path $root 'formal-spool\incoming';$x=Get-Acl -LiteralPath $odd;$x.SetSecurityDescriptorSddlForm(($x.Sddl -replace [regex]::Escape('(A;;0x1200e1;;;'+$res+')'),('(A;;0x1301bf;;;'+$res+')')),[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $odd -AclObject $x
 $bad=Run @('-Apply');Yes ($bad.code -ceq 'ACL_TARGET_HAS_OTHER_RESIDENT_ACES') ('other-resident-ace:'+$bad.code)
 $outside=& $Powershell -NoProfile -NonInteractive -File $tool -ResidentSid $res -OwnerSid $owner -ControllerSid $ctrl -OfflineFixtureRoot 'C:\Windows';Yes ((($outside|Select-Object -Last 1)|ConvertFrom-Json).code -ceq 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED') 'fixture-outside-temp'
 [pscustomobject]@{status='ACL_MIGRATION_OFFLINE_PASS';cases=$cases;hostRead=$false;hostWrite=$false}|ConvertTo-Json -Compress
}finally{
 # The created directories carry protected DACLs without this user; as owner we may rewrite them to delete.
 if(Test-Path -LiteralPath $root){Get-ChildItem -LiteralPath $root -Recurse -Directory -Force|Sort-Object {$_.FullName.Length} -Descending|ForEach-Object{try{$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($me)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')));[IO.Directory]::SetAccessControl($_.FullName,$a)}catch{}};Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
}
