# Actual PS5/TEMP NTFS checks. Only helper ASTs and the one installer step body execute; no installer, task, service or WSL entry executes.
param([Parameter(Mandatory)][string]$Scratch)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
if([IO.Directory]::Exists($Scratch)){throw 'NEW_SCRATCH_REQUIRED'}
[void][IO.Directory]::CreateDirectory($Scratch)
$here=$PSScriptRoot;$defs=@{};$asts=@{};$count=0
function Yes([bool]$ok,[string]$why){if(-not $ok){throw ('FAILED:'+ $why)};$script:count++}
foreach($name in @('install-resident.ps1','companion-headless.ps1','verify-resident.ps1')){
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $here $name),[ref]$t,[ref]$e);Yes ($e.Count -eq 0) ('parse-'+$name);$asts[$name]=$a
 foreach($f in $a.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){$defs[$name+':'+$f.Name]=$f.Extent.Text}
}
Yes ($defs['install-resident.ps1:Get-RelayParentAclPresence'] -ceq $defs['companion-headless.ps1:Get-RelayParentAclPresence']) 'one-byte-identical-pure-rule'
foreach($n in @('Get-DaclPart','Get-ParentAce','Get-AceKeys','Get-ParentAclState','Add-ParentAce','Get-RelayParentAclPresence','Assert-CompanionRelayParentPlan','Add-CompanionRelayParentAce','Get-CompanionRelayParentsPlan')){. ([scriptblock]::Create($defs['install-resident.ps1:'+$n]))}
foreach($n in @('Get-CompanionRelayParentPaths','Get-CompanionRelayParentsProblem','Invoke-CompanionAccountSwitch')){. ([scriptblock]::Create($defs['companion-headless.ps1:'+$n]))}
$steps=@($asts['install-resident.ps1'].FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -gt 2 -and $n.CommandElements[1].Extent.Text -ceq "'companion-relay-parent-acl'"},$true))
Yes ($steps.Count -eq 1) 'actual-install-step-found'
$body=@($steps[0].CommandElements|Where-Object{$_ -is [Management.Automation.Language.ScriptBlockExpressionAst]})[0].ScriptBlock.GetScriptBlock()
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$OwnerSid='S-1-5-21-1-2-3-1008';$operator='S-1-5-21-1-2-3-1001';$controller='S-1-5-21-1-2-3-1007';$resident='S-1-5-80-1-2-3-4-5'
function New-Parent([string]$p,[string]$extra=''){
 [void][IO.Directory]::CreateDirectory($p);$acl=New-Object Security.AccessControl.DirectorySecurity
 $s='D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;'+$me+')(A;;0x120080;;;'+$operator+')(A;OICI;0x1200a9;;;'+$controller+')'+$extra
 $acl.SetSecurityDescriptorSddlForm($s,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($p,$acl)
}
function New-Scene([string]$name){$script:CiRoot=Join-Path $Scratch $name;New-Parent $CiRoot;New-Parent (Join-Path $CiRoot 'formal-spool')}
function Get-CompanionRelayParentPaths { @($script:CiRoot,(Join-Path $script:CiRoot 'formal-spool')) }
New-Scene 'missing-resident'
$old=(Get-Acl -LiteralPath $CiRoot);$oldOwner=$old.Owner;$oldGroup=$old.Group;$oldKeys=@(Get-AceKeys $old.Sddl)
$resPlan=Get-ParentAclState $CiRoot $resident;$parentPlan=Get-CompanionRelayParentsPlan $resPlan
Yes (-not $resPlan.present -and $parentPlan.Count -eq 2 -and -not $parentPlan[0].present) 'plan-real-missing-resident-and-companion'
Yes ($parentPlan[0].before -cne (Get-DaclPart $old.Sddl) -and $parentPlan[1].before -ceq (Get-DaclPart ((Get-Acl -LiteralPath (Join-Path $CiRoot 'formal-spool')).Sddl))) 'only-ciroot-projects-preceding-service-ace'
$null=Add-ParentAce $resPlan
Yes ((Get-DaclPart ((Get-Acl -LiteralPath $CiRoot).Sddl)) -ceq $parentPlan[0].before) 'actual-resident-write-matches-normalized-plan-projection'
$plan=[pscustomobject]@{companionAccount=[pscustomobject]@{relayParents=$parentPlan}};$script:receipt=@{};& $body
Yes ($receipt.companionRelayParents.Count -eq 2 -and @($receipt.companionRelayParents|Where-Object{$_.wrote}).Count -eq 2) 'actual-install-step-adds-both-exact-entries'
Yes ($null -eq (Get-CompanionRelayParentsProblem $OwnerSid)) 'real-parent-verification-passes-after-install-step'
$back=Get-Acl -LiteralPath $CiRoot;$newKeys=@(Get-AceKeys $back.Sddl)
Yes ($back.Owner -ceq $oldOwner -and $back.Group -ceq $oldGroup -and $back.AreAccessRulesProtected -and $newKeys.Count -eq $oldKeys.Count+2 -and @($oldKeys|Where-Object{$newKeys -cnotcontains $_}).Count -eq 0) 'all-original-role-aces-owner-group-kept'
Yes (($newKeys -ccontains ($OwnerSid+'|'+0x120080+'|0|AccessAllowed')) -and ($newKeys -ccontains ($resident+'|'+0x120080+'|0|AccessAllowed'))) 'exact-no-inheritance-metadata-only-role-rights'
$child=Join-Path $CiRoot 'child';[void][IO.Directory]::CreateDirectory($child)
Yes (@((Get-Acl -LiteralPath $child).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -ceq $OwnerSid}).Count -eq 0) 'companion-parent-ace-never-inherits'
$resPlan=Get-ParentAclState $CiRoot $resident;$again=Get-CompanionRelayParentsPlan $resPlan;$before=(Get-Acl -LiteralPath $CiRoot).Sddl
Yes (-not (Add-CompanionRelayParentAce $again[0]) -and -not (Add-CompanionRelayParentAce $again[1]) -and (Get-Acl -LiteralPath $CiRoot).Sddl -ceq $before) 'idempotent-present-state-no-duplicate-no-write'
foreach($case in @('missing-one','changed-before-step','group-deny','user-deny','inherit','extra-write','duplicate')){
 New-Scene $case;$resPlan=Get-ParentAclState $CiRoot $resident;$parentPlan=Get-CompanionRelayParentsPlan $resPlan;$null=Add-ParentAce $resPlan
 $spool=Join-Path $CiRoot 'formal-spool';$extra=''
 switch($case){
  'missing-one' { $null=Add-CompanionRelayParentAce $parentPlan[0];Yes ($null -ne (Get-CompanionRelayParentsProblem $OwnerSid)) 'one-parent-missing-refuses';continue }
  'changed-before-step' {$extra='(A;;0x120080;;;S-1-5-21-1-2-3-1010)'}
  'group-deny' {$extra='(D;;0x20000;;;BU)(A;;0x120080;;;'+$OwnerSid+')'}
  'user-deny' {$extra='(D;;0x20000;;;'+$OwnerSid+')(A;;0x120080;;;'+$OwnerSid+')'}
  'inherit' {$extra='(A;OICI;0x120080;;;'+$OwnerSid+')'}
  'extra-write' {$extra='(A;;0x1301bf;;;'+$OwnerSid+')'}
  'duplicate' {$extra='(A;;0x120080;;;'+$OwnerSid+')(A;;0x120080;;;'+$OwnerSid+')'}
 }
 if($case -ceq 'missing-one'){continue}
 New-Parent $spool $extra;$beforeRoot=(Get-Acl -LiteralPath $CiRoot).Sddl;$beforeSpool=(Get-Acl -LiteralPath $spool).Sddl
 $plan=[pscustomobject]@{companionAccount=[pscustomobject]@{relayParents=$parentPlan}};$script:receipt=@{};$refused=$false;try{& $body}catch{$refused=$true}
 Yes ($refused -and (Get-Acl -LiteralPath $CiRoot).Sddl -ceq $beforeRoot -and (Get-Acl -LiteralPath $spool).Sddl -ceq $beforeSpool) ('actual-step-preconditions-zero-write-'+$case)
 if($case -cne 'changed-before-step'){Yes ($null -ne (Get-CompanionRelayParentsProblem $OwnerSid)) ('actual-readonly-validator-refuses-'+$case)}
}
# Deny known group metadata cannot be overridden by an exact user allow. Object/callback ACEs stay unknown/refused.
foreach($deny in @('BU','AU','WD')){Yes ((Get-RelayParentAclPresence ('D:P(D;;RC;;;'+$deny+')(A;;0x120080;;;'+$OwnerSid+')') $OwnerSid) -ceq 'refused') ('metadata-deny-not-overridden-'+$deny)}
Yes ((Get-RelayParentAclPresence ('D:P(OA;;RC;;'+[guid]::NewGuid().ToString()+';'+$OwnerSid+')') $OwnerSid) -ceq 'refused') 'object-ace-unknown-refused'
# Execute the real account-switch flow with TEMP-only host ports. Parent ACL reading/validation remains real.
function Read-CompanionPending { $null };function Read-CompanionWslRecord { [ordered]@{stage='qualified';target=(Join-Path $CiRoot 'data\ext4.vhdx');ownerRegistration=$null} }
function New-CompanionBuild { $script:effects++;[ordered]@{directory='fixture';generation=('a'*64);registrar=@{exe='fixture';sourceSha256=('b'*64);sha256=('c'*64)}} };function Remove-CompanionBuild {}
function Get-CompanionAccountFacts { @{} };function Get-CompanionDomainCredsDisabled { 0 };function Get-LockoutPolicy { @{} };function Get-CompanionAccountPreflight { @{refusals=@()} }
function Register-CompanionFallbackTask { $script:effects++ };function Write-CompanionPending { $script:effects++ };function Stop-CompanionTask { $script:effects++ };function Get-CompanionProcessTree { @{supervisors=@()} };function Wait-CompanionTaskNotRunning {}
function Invoke-CompanionWslMove { [ordered]@{stage='qualified';target=(Join-Path $CiRoot 'data\ext4.vhdx');ownerRegistration=$null} };function Invoke-CompanionRegistrar { '{"code":"REGISTERED"}' }
function Start-CompanionTask { $script:effects++ };function Wait-CompanionQualified { if($script:lateDeny){New-Parent (Join-Path $CiRoot 'formal-spool')};$null };function Get-CompanionTaskFacts { @{mode='password'} }
function ConvertTo-CompanionOrdered($value) { $value };function Write-CompanionWslRecord { $script:qualifiedWrites++ };function Remove-CompanionFallbackTask {};function Invoke-CompanionStopAndFallback { $script:fallbacks++ };function Invoke-CompanionFallback { $script:fallbacks++ }
$CompanionPendingFile='install\companion-headless-pending.json';$node=[pscustomobject]@{ownerSid=$OwnerSid;wslDistribution='fixture'}
New-Scene 'switch-missing';$effects=0;$qualifiedWrites=0;$fallbacks=0;$lateDeny=$false
$r=Invoke-CompanionAccountSwitch $CiRoot $node (Join-Path $CiRoot 'data') 'account'
Yes (-not $r.qualified -and $r.failed -ceq 'COMPANION_RELAY_PARENT_ACL_REFUSED' -and $effects -eq 0 -and $qualifiedWrites -eq 0) 'switch-missing-parent-before-all-effects'
foreach($late in @($false,$true)){
 New-Scene ('switch-'+$late);$resPlan=Get-ParentAclState $CiRoot $resident;$parentPlan=Get-CompanionRelayParentsPlan $resPlan;$null=Add-ParentAce $resPlan;foreach($p in $parentPlan){$null=Add-CompanionRelayParentAce $p}
 [void][IO.Directory]::CreateDirectory((Join-Path $CiRoot 'install'));[IO.File]::WriteAllText((Join-Path $CiRoot 'install\install-receipt.json'),'{"residentManifestSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')
 $effects=0;$qualifiedWrites=0;$fallbacks=0;$lateDeny=$late;$r=Invoke-CompanionAccountSwitch $CiRoot $node (Join-Path $CiRoot 'data') 'account'
 if($late){Yes (-not $r.qualified -and $qualifiedWrites -eq 0 -and $fallbacks -eq 1) 'switch-final-parent-recheck-prevents-false-qualification'}else{Yes ($r.qualified -and $qualifiedWrites -eq 1) 'switch-qualifies-with-real-two-parent-proof'}
}
[ordered]@{status='COMPANION_RELAY_PARENT_TEMP_PASS';assertions=$count;taskServiceWslEffects=$false;productionAclWrites=$false}|ConvertTo-Json -Compress
