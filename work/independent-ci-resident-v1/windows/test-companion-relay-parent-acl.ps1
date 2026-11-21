# Actual PS5/TEMP NTFS checks. Only helper ASTs and the installer's two step bodies (parent-acl, companion-relay-parent-acl) execute; no
# installer, task, service or WSL entry executes. The CI root and formal-spool are made the way the first install makes them
# (first-install-host.ps1: one CreateDirectory with the final DACL, which Windows reads back as D:P, no AI); not elevated, TEMP only.
param([Parameter(Mandatory)][string]$Scratch)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
if([IO.Directory]::Exists($Scratch)){throw 'NEW_SCRATCH_REQUIRED'}
[void][IO.Directory]::CreateDirectory($Scratch)
$here=$PSScriptRoot;$defs=@{};$asts=@{};$count=0
function Yes([bool]$ok,[string]$why){if(-not $ok){throw ('FAILED:'+ $why)};$script:count++}
foreach($name in @('install-resident.ps1','companion-headless.ps1','verify-resident.ps1','first-install-host.ps1')){
 $t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile((Join-Path $here $name),[ref]$t,[ref]$e);Yes ($e.Count -eq 0) ('parse-'+$name);$asts[$name]=$a
 foreach($f in $a.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){$defs[$name+':'+$f.Name]=$f.Extent.Text}
}
# The mechanism guard (Fable ruling 0e418483, section 2): a plan's `before` is compared as a DACL shape (Get-DaclShape), never as SDDL
# text. No equality operator in these three scripts has a `.before` member as an operand.
foreach($name in @('install-resident.ps1','companion-headless.ps1','verify-resident.ps1')){
 $textCompare=@($asts[$name].FindAll({param($n)$n -is [Management.Automation.Language.BinaryExpressionAst] -and @('Ieq','Ine','Ceq','Cne') -contains [string]$n.Operator -and
   @(@($n.Left,$n.Right)|Where-Object{$_ -is [Management.Automation.Language.MemberExpressionAst] -and $_.Member -is [Management.Automation.Language.StringConstantExpressionAst] -and $_.Member.Value -ceq 'before'}).Count -gt 0},$true))
 Yes ($textCompare.Count -eq 0) ('no-text-compare-on-before-'+$name+':'+(@($textCompare|ForEach-Object{$_.Extent.StartLineNumber}) -join ','))
}
Yes ($defs['install-resident.ps1:Get-RelayParentAclPresence'] -ceq $defs['companion-headless.ps1:Get-RelayParentAclPresence']) 'one-byte-identical-pure-rule'
foreach($n in @('Get-DaclPart','Get-DaclShape','Get-ParentAce','Get-AceKeys','Get-ParentAclState','Add-ParentAce','Get-RelayParentAclPresence','Assert-CompanionRelayParentPlan','Add-CompanionRelayParentAce','Get-CompanionRelayParentsPlan')){Yes ($defs.ContainsKey('install-resident.ps1:'+$n)) ('installer-defines-'+$n);. ([scriptblock]::Create($defs['install-resident.ps1:'+$n]))}
foreach($n in @('Get-CompanionRelayParentPaths','Get-CompanionRelayParentsProblem','Invoke-CompanionAccountSwitch')){. ([scriptblock]::Create($defs['companion-headless.ps1:'+$n]))}
. ([scriptblock]::Create($defs['first-install-host.ps1:Get-CiRootSddl']))
function Get-StepBody([string]$step){
 $s=@($asts['install-resident.ps1'].FindAll({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Step' -and $n.CommandElements.Count -gt 2 -and $n.CommandElements[1].Extent.Text -ceq ("'"+$step+"'")},$true))
 Yes ($s.Count -eq 1) ('actual-install-step-found-'+$step)
 @($s[0].CommandElements|Where-Object{$_ -is [Management.Automation.Language.ScriptBlockExpressionAst]})[0].ScriptBlock.GetScriptBlock()
}
$parentBody=Get-StepBody 'parent-acl';$body=Get-StepBody 'companion-relay-parent-acl'
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$OwnerSid='S-1-5-21-1-2-3-1008';$operator='S-1-5-21-1-2-3-1001';$controller='S-1-5-21-1-2-3-1007';$resident='S-1-5-80-1-2-3-4-5'
# The first install's DACL for both folders, with this user as owner and group and one FA entry for this user (unelevated, removable).
$ciRootSddl=Get-CiRootSddl $operator $controller
Yes ($ciRootSddl.StartsWith('O:BAG:BAD:PAI(')) 'first-install-ci-root-sddl-has-owner-and-group-to-replace'
function Get-ParentSddl([string]$extra){'O:'+$me+'G:'+$me+$ciRootSddl.Substring(8)+'(A;OICI;FA;;;'+$me+')'+$extra}
function Get-DaclFlags([string]$path){$d=Get-DaclPart ((Get-Acl -LiteralPath $path).Sddl);$d.Substring(2,$d.IndexOf('(')-2)}
function New-Parent([string]$p,[string]$extra=''){
 if(-not [IO.Directory]::Exists($p)){
  $ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetSecurityDescriptorSddlForm((Get-ParentSddl $extra));[void][IO.Directory]::CreateDirectory($p,$ds)
  Yes ((Get-DaclFlags $p) -ceq 'P') ('made-as-the-first-install-makes-it-D:P-no-AI:'+(Get-DaclFlags $p));return
 }
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm((Get-ParentSddl $extra),[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($p,$acl)
}
function New-Scene([string]$name,[string]$rootExtra=''){$script:CiRoot=Join-Path $Scratch $name;New-Parent $CiRoot $rootExtra;New-Parent (Join-Path $CiRoot 'formal-spool')}
function Get-CompanionRelayParentPaths { @($script:CiRoot,(Join-Path $script:CiRoot 'formal-spool')) }
# The install plan's two entries as install-resident.ps1 builds them (parentAcl, companionAccount.relayParents).
function New-InstallPlan { $r=Get-ParentAclState $script:CiRoot $resident;$c=Get-CompanionRelayParentsPlan $r;[pscustomobject]@{parentAcl=$r;companionAccount=[pscustomobject]@{relayParents=$c}} }
function Get-StepCode([scriptblock]$step){try{& $step;$null}catch{$_.Exception.Message}}

New-Scene 'missing-resident'
$old=(Get-Acl -LiteralPath $CiRoot);$oldOwner=$old.Owner;$oldGroup=$old.Group;$oldKeys=@(Get-AceKeys $old.Sddl)
$plan=New-InstallPlan;$resPlan=$plan.parentAcl;$parentPlan=@($plan.companionAccount.relayParents)
Yes (-not $resPlan.present -and $parentPlan.Count -eq 2 -and -not $parentPlan[0].present) 'plan-real-missing-resident-and-companion'
Yes ((Get-DaclShape $parentPlan[0].before) -cne (Get-DaclShape $old.Sddl) -and (Get-DaclShape $parentPlan[1].before) -ceq (Get-DaclShape ((Get-Acl -LiteralPath (Join-Path $CiRoot 'formal-spool')).Sddl))) 'only-ciroot-projects-preceding-service-ace'
# The first install's two steps in their order, their real bodies: parent-acl writes the service entry, Windows writes the DACL back in
# its own form (AI set), and companion-relay-parent-acl must still find the CI root as planned (r8: COMPANION_RELAY_PARENT_CHANGED_SINCE_PLAN).
$script:receipt=@{};& $parentBody
Yes ($receipt.parentAcl.wrote -eq $true) 'actual-parent-acl-step-writes-the-service-entry'
Yes ((Get-DaclShape ((Get-Acl -LiteralPath $CiRoot).Sddl)) -ceq (Get-DaclShape $parentPlan[0].before)) 'actual-resident-write-matches-plan-projection-shape'
& $body
Yes ($receipt.companionRelayParents.Count -eq 2 -and @($receipt.companionRelayParents|Where-Object{$_.wrote}).Count -eq 2) 'actual-install-step-adds-both-exact-entries'
Yes ($null -eq (Get-CompanionRelayParentsProblem $OwnerSid)) 'real-parent-verification-passes-after-install-step'
$back=Get-Acl -LiteralPath $CiRoot;$newKeys=@(Get-AceKeys $back.Sddl)
Yes ($back.Owner -ceq $oldOwner -and $back.Group -ceq $oldGroup -and $back.AreAccessRulesProtected -and $newKeys.Count -eq $oldKeys.Count+2 -and @($oldKeys|Where-Object{$newKeys -cnotcontains $_}).Count -eq 0) 'all-original-role-aces-owner-group-kept'
Yes (($newKeys -ccontains ($OwnerSid+'|'+0x120080+'|0|AccessAllowed')) -and ($newKeys -ccontains ($resident+'|'+0x120080+'|0|AccessAllowed'))) 'exact-no-inheritance-metadata-only-role-rights'
$child=Join-Path $CiRoot 'child';[void][IO.Directory]::CreateDirectory($child)
Yes (@((Get-Acl -LiteralPath $child).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -ceq $OwnerSid}).Count -eq 0) 'companion-parent-ace-never-inherits'
$resPlan=Get-ParentAclState $CiRoot $resident;$again=Get-CompanionRelayParentsPlan $resPlan;$before=(Get-Acl -LiteralPath $CiRoot).Sddl
Yes (-not (Add-CompanionRelayParentAce $again[0]) -and -not (Add-CompanionRelayParentAce $again[1]) -and (Get-Acl -LiteralPath $CiRoot).Sddl -ceq $before) 'idempotent-present-state-no-duplicate-no-write'

# Order is not compared: an entry that sorts after the service SID (S-1-15-2-1) on the CI root. Windows writes the service entry before
# it, the plan's projection after it; both steps pass. (A projection that also predicted the AI flag would still fail here.)
New-Scene 'reorder' '(A;;0x120080;;;S-1-15-2-1)';$plan=New-InstallPlan;$projected=@($plan.companionAccount.relayParents)[0].before
$script:receipt=@{};& $parentBody;$written=Get-DaclPart ((Get-Acl -LiteralPath $CiRoot).Sddl)
$rawProjected=New-Object Security.AccessControl.RawSecurityDescriptor($projected);$rawWritten=New-Object Security.AccessControl.RawSecurityDescriptor($written)
$at={param($raw,[string]$sid)for($k=0;$k -lt $raw.DiscretionaryAcl.Count;$k++){if($raw.DiscretionaryAcl[$k].SecurityIdentifier.Value -ceq $sid){return $k}};-1}
Yes ((& $at $rawProjected $resident) -gt (& $at $rawProjected 'S-1-15-2-1') -and (& $at $rawWritten $resident) -lt (& $at $rawWritten 'S-1-15-2-1')) ('reorder-scene-really-reorders:'+$written)
Yes ($null -eq (Get-StepCode $body) -and $null -eq (Get-CompanionRelayParentsProblem $OwnerSid)) 'reordered-dacl-passes-both-steps'

# Only control flags change after the plan: both folders' DACLs written back unchanged (Windows sets AI); both steps pass.
New-Scene 'flags-only';$plan=New-InstallPlan
foreach($d in @($CiRoot,(Join-Path $CiRoot 'formal-spool'))){
 $was=(Get-Acl -LiteralPath $d).Sddl;$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($was,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($d,$acl)
 Yes ((Get-DaclFlags $d) -ceq 'PAI' -and (Get-DaclShape ((Get-Acl -LiteralPath $d).Sddl)) -ceq (Get-DaclShape $was)) ('flags-only-rewrite-sets-AI-same-shape:'+(Get-DaclFlags $d))
}
$script:receipt=@{};Yes ($null -eq (Get-StepCode $parentBody) -and $null -eq (Get-StepCode $body) -and $null -eq (Get-CompanionRelayParentsProblem $OwnerSid)) 'flags-only-change-passes-both-steps'

# What must still be refused: after the plan, one entry more; one entry replaced by another (same count); one mask bit; one inheritance
# bit. On the CI root before parent-acl, on the CI root before companion-relay-parent-acl, on formal-spool: refused, nothing written.
function Set-Mutated([string]$dir,[string]$how){
 $raw=New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $dir).Sddl);$dacl=$raw.DiscretionaryAcl;$was=Get-DaclShape ((Get-Acl -LiteralPath $dir).Sddl);$n=$dacl.Count
 $i=-1;for($k=0;$k -lt $dacl.Count;$k++){if($dacl[$k].SecurityIdentifier.Value -ceq $operator){$i=$k}};Yes ($i -ge 0) ('mutation-target-found-'+$how)
 $other={param([string]$sid)New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,0x120080,(New-Object Security.Principal.SecurityIdentifier($sid)),$false,$null)}
 switch($how){
  'one-more' {$dacl.InsertAce($dacl.Count,(& $other 'S-1-5-21-1-2-3-1010'));$n++}
  'one-replaced' {$dacl.RemoveAce($i);$dacl.InsertAce($i,(& $other 'S-1-5-21-1-2-3-1011'))}
  'mask-bit' {$dacl[$i].AccessMask=$dacl[$i].AccessMask -bxor 1}
  'inherit-bit' {$dacl[$i].AceFlags=$dacl[$i].AceFlags -bxor [Security.AccessControl.AceFlags]::ObjectInherit}
 }
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($dir,$acl)
 $now=(Get-Acl -LiteralPath $dir).Sddl
 Yes ((Get-DaclShape $now) -cne $was -and (New-Object Security.AccessControl.RawSecurityDescriptor($now)).DiscretionaryAcl.Count -eq $n) ('mutation-took-effect-'+$how)
}
foreach($where in @('root-before-parent-acl','root-before-companion','spool-before-companion')){
 foreach($how in @('one-more','one-replaced','mask-bit','inherit-bit')){
  New-Scene ('refuse-'+$where+'-'+$how);$spool=Join-Path $CiRoot 'formal-spool';$plan=New-InstallPlan;$script:receipt=@{}
  if($where -ceq 'root-before-parent-acl'){$step=$parentBody;$code='PARENT_ACL_CHANGED_SINCE_PLAN';Set-Mutated $CiRoot $how}
  else{Yes ($null -eq (Get-StepCode $parentBody)) ('parent-acl-before-'+$where+'-'+$how);$step=$body;$code='COMPANION_RELAY_PARENT_CHANGED_SINCE_PLAN';Set-Mutated $(if($where -ceq 'root-before-companion'){$CiRoot}else{$spool}) $how}
  $beforeRoot=(Get-Acl -LiteralPath $CiRoot).Sddl;$beforeSpool=(Get-Acl -LiteralPath $spool).Sddl;$got=Get-StepCode $step
  Yes ($got -ceq $code -and (Get-Acl -LiteralPath $CiRoot).Sddl -ceq $beforeRoot -and (Get-Acl -LiteralPath $spool).Sddl -ceq $beforeSpool) ('changed-since-plan-refused-zero-write-'+$where+'-'+$how+':'+$got)
 }
}

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
