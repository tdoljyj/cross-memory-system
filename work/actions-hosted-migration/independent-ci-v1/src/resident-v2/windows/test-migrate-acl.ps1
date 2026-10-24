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
 foreach($d in 'formal-spool','formal-spool\outgoing','formal-spool\incoming','state'){[void][IO.Directory]::CreateDirectory((Join-Path $root $d))}
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($p in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($me,'FullControl'))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p[0])),$p[1],'ContainerInherit,ObjectInherit','None','Allow')))}
 foreach($d in 'formal-spool','formal-spool\outgoing','formal-spool\incoming'){[IO.Directory]::SetAccessControl((Join-Path $root $d),$acl)}
 $before=(Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl
 $plan=Run @();Yes ($plan.status -ceq 'SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN' -and @($plan.steps).Count -eq 14) 'plan-only'
 Yes ((Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl -ceq $before -and -not (Test-Path (Join-Path $root 'state\v2'))) 'plan-wrote-nothing'
 $v=Run @('-Apply');Yes ($v.status -ceq 'SOURCE_V2_ACL_MIGRATED') ('apply:'+$v.code)
 $after=(Get-Acl -LiteralPath (Join-Path $root 'formal-spool\outgoing')).Sddl
 $resAces=@((New-Object Security.AccessControl.RawSecurityDescriptor($after)).DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -ceq $res}|ForEach-Object{('0x{0:x}' -f $_.AccessMask)+'|'+[int]$_.AceFlags})
 Yes ((($resAces|Sort-Object) -join ';') -ceq ((@('0x1200e1|0','0x120089|9')|Sort-Object) -join ';')) ('resident-aces-added:'+($resAces -join ';'))
 $afterSids=@((New-Object Security.AccessControl.RawSecurityDescriptor($after)).DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value+'|'+$_.AccessMask})
 foreach($a in (New-Object Security.AccessControl.RawSecurityDescriptor($before)).DiscretionaryAcl){Yes ($afterSids -ccontains ($a.SecurityIdentifier.Value+'|'+$a.AccessMask)) 'old-ace-kept'}
 $sids={param($p)@((New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $p).Sddl)).DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value})}
 Yes ((& $sids (Join-Path $root 'state\v2\receipts')) -ccontains $res -and (& $sids (Join-Path $root 'state\v2\batch-claims')) -cnotcontains $res) 'state-v2-created'
 Yes ((& $sids (Join-Path $root 'state\relay\jwks')) -ccontains $ctrl -and (& $sids (Join-Path $root 'state\relay\jwks')) -cnotcontains $res) 'relay-jwks-created'
 # stage 8's green ledger (step 3a) and stage 10's shadow records (step 3c-1): clued-control only
 foreach($d in 'state\v2\green-ledger','state\v2\train-shadow'){Yes ((& $sids (Join-Path $root $d)) -ccontains $ctrl -and (& $sids (Join-Path $root $d)) -cnotcontains $res) ($d+'-created')}
 $again=Run @('-Apply');Yes ($again.status -ceq 'SOURCE_V2_ACL_MIGRATED' -and @($again.steps|Where-Object{-not $_.skipped}).Count -eq 0) 'idempotent'
 # A different resident ACE already present is refused, not merged.
 $odd=Join-Path $root 'formal-spool\incoming';$x=Get-Acl -LiteralPath $odd;$x.SetSecurityDescriptorSddlForm(($x.Sddl -replace [regex]::Escape('(A;;0x1200e1;;;'+$res+')'),('(A;;0x1301bf;;;'+$res+')')),[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $odd -AclObject $x
 $bad=Run @('-Apply');Yes ($bad.code -ceq 'ACL_TARGET_HAS_OTHER_RESIDENT_ACES') ('other-resident-ace:'+$bad.code)
 $outside=& $Powershell -NoProfile -NonInteractive -File $tool -ResidentSid $res -OwnerSid $owner -ControllerSid $ctrl -OfflineFixtureRoot 'C:\Windows';Yes ((($outside|Select-Object -Last 1)|ConvertFrom-Json).code -ceq 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED') 'fixture-outside-temp'
 [pscustomobject]@{status='ACL_MIGRATION_OFFLINE_PASS';cases=$cases;hostRead=$false;hostWrite=$false}|ConvertTo-Json -Compress
}finally{
 # The created directories carry protected DACLs without this user; as owner we may rewrite them to delete.
 if(Test-Path -LiteralPath $root){Get-ChildItem -LiteralPath $root -Recurse -Directory -Force|Sort-Object {$_.FullName.Length} -Descending|ForEach-Object{try{$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($me)),'FullControl','ContainerInherit,ObjectInherit','None','Allow')));[IO.Directory]::SetAccessControl($_.FullName,$a)}catch{}};Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue}
}
