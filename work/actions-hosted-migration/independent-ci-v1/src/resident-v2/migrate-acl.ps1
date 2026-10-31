<#
Source v2 ProgramData ACL migration (DESIGN S3, §8.3). Called once by the Owner's elevated
install-resident.ps1 (step 'source-v2-acl') from the installed admin-only Source copy, with fixed
arguments. Default mode is a read-only plan; -Apply performs exactly that plan.

  migrate-acl.ps1 -ResidentSid <S-1-5-80-...> -OwnerSid <S-1-5-21-...> -ControllerSid <S-1-5-21-...> [-Apply]

What it does (acl-model.json, next to this script):
  - APPENDS the resident ACEs to the existing protected DACLs of formal-spool, formal-spool\outgoing and
    formal-spool\incoming (this-folder list/traverse/add-subdirectory/delete-child, plus inherit-only read
    on files) so the resident can rename protocol records into a new archive directory and read the
    signed scanner result; it removes, re-orders by hand or re-owns nothing;
  - CREATES the Source v2 controller state directories state\v2\* with their final protected DACLs
    (clued-control modify; the resident may only read state\v2\receipts);
  - APPENDS a separate read-only controller ACE on resident\broker and first-level file-only read ACEs
    on its requests/responses directories. Existing broker writers, owners and all other ACEs remain;
    this grants no controller write/delete/ownership/DACL right and does not inherit from broker root;
  - never touches secrets\, state\effects or CluedControl, and never reads or changes file contents.
Compare-and-swap: each target's security descriptor is re-read immediately before it is changed and
must equal the one the plan was computed from; the result is read back. Idempotent: a target that
already carries exactly the planned ACEs (or a created directory with the planned DACL) is skipped.
#>
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^S-1-5-80(-\d+){5}$')][string]$ResidentSid,
  [Parameter(Mandatory=$true)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$OwnerSid,
  [Parameter(Mandatory=$true)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$ControllerSid,
  [switch]$Apply,
  [string]$OfflineFixtureRoot
)
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$Real='C:\ProgramData\CluedIndependentCI'
$out=[ordered]@{contract='clued.independent-ci.resident-acl-migration/1';status='REFUSED';apply=[bool]$Apply;steps=@();code=$null}
function Sddl([string]$p){(Get-Acl -LiteralPath $p).Sddl}
function Sub([string]$s){$s.Replace('{RES}',$ResidentSid).Replace('{CTRL}',$ControllerSid).Replace('{OWNER}',$OwnerSid)}
function Map([string]$p){if($script:Root -ceq $Real){return $p};if(-not $p.StartsWith($Real,[StringComparison]::OrdinalIgnoreCase)){throw 'ACL_MODEL_PATH_REFUSED'};return $script:Root+$p.Substring($Real.Length)}
function Aces([string]$text){
 $d=New-Object Security.AccessControl.RawSecurityDescriptor($text);$r=@()
 foreach($a in $d.DiscretionaryAcl){if($a -is [Security.AccessControl.CommonAce]){$r+=($a.SecurityIdentifier.Value+'|'+[string]$a.AccessMask+'|'+[int]$a.AceFlags+'|'+[string]$a.AceQualifier)}}
 return ,$r
}
function Wanted([string]$ace){
 # (A;FLAGS;MASK;;;SID) -> SID|mask|flags|AccessAllowed, as RawSecurityDescriptor reports it
 $d=New-Object Security.AccessControl.RawSecurityDescriptor('D:'+$ace);$a=$d.DiscretionaryAcl[0]
 return $a.SecurityIdentifier.Value+'|'+[string]$a.AccessMask+'|'+[int]$a.AceFlags+'|'+[string]$a.AceQualifier
}
try{
 $script:Root=$Real
 if($OfflineFixtureRoot){$t=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\');$f=[IO.Path]::GetFullPath($OfflineFixtureRoot).TrimEnd('\');if(-not $f.StartsWith($t+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED'};$script:Root=$f}
 elseif($Apply){$id=[Security.Principal.WindowsIdentity]::GetCurrent();if($id.User.Value -cne $OwnerSid -or -not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ELEVATED_OWNER_REQUIRED'}}
 $mb=[IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'acl-model.json'));$model=(New-Object Text.UTF8Encoding($false,$true)).GetString($mb)|ConvertFrom-Json
 if($model.contract -cne 'clued.independent-ci.resident-acl-model/1'){throw 'ACL_MODEL_CONTRACT_REFUSED'}
 $plan=@()
 foreach($a in $model.add){
  $p=Map $a.path;if(-not [IO.Directory]::Exists($p)){throw 'ACL_TARGET_MISSING'};if(((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ACL_TARGET_REPARSE_REFUSED'}
  $before=Sddl $p;$raw=New-Object Security.AccessControl.RawSecurityDescriptor($before)
  if(($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -and -not $OfflineFixtureRoot){throw 'ACL_TARGET_NOT_PROTECTED'}
  $have=Aces $before;$want=@($a.aces|ForEach-Object{Wanted (Sub $_)})
  $resident=@($have|Where-Object{$_.StartsWith($ResidentSid+'|')})
  if($resident.Count -and (@($resident|Sort-Object) -join ';') -cne (@($want|Sort-Object) -join ';')){throw 'ACL_TARGET_HAS_OTHER_RESIDENT_ACES'}
  $plan+=[ordered]@{kind='add';path=$p;before=$before;aces=@($a.aces|ForEach-Object{Sub $_});skip=($resident.Count -gt 0)}
 }
 # A separate principal and fixed path allowlist keeps the original resident
 # add rules exact. File-only inheritance grants public broker records read
 # access with NoPropagateInherit, never unrelated root files or nested subtrees.
 $readPaths=@(($Real+'\resident\broker'),($Real+'\resident\broker\requests'),($Real+'\resident\broker\responses'))
 if(@($model.addControllerRead).Count -ne 3 -or $ControllerSid -ceq $OwnerSid){throw 'ACL_CONTROLLER_READ_MODEL_REFUSED'}
 $seenRead=@{}
 foreach($a in $model.addControllerRead){
  if($readPaths -cnotcontains $a.path -or $seenRead.ContainsKey($a.path)){throw 'ACL_CONTROLLER_READ_MODEL_REFUSED'};$seenRead[$a.path]=$true
  $expected=if($a.path -ceq $readPaths[0]){@('(A;;0x1200a9;;;{CTRL})')}else{@('(A;;0x1200a9;;;{CTRL})','(A;OINPIO;0x120089;;;{CTRL})')}
  if((@($a.aces|Sort-Object) -join ';') -cne (@($expected|Sort-Object) -join ';')){throw 'ACL_CONTROLLER_READ_MODEL_REFUSED'}
  $p=Map $a.path;if(-not [IO.Directory]::Exists($p)){throw 'ACL_TARGET_MISSING'}
  if(((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ACL_TARGET_REPARSE_REFUSED'}
  $before=Sddl $p;$raw=New-Object Security.AccessControl.RawSecurityDescriptor($before)
  if(($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -and -not $OfflineFixtureRoot){throw 'ACL_TARGET_NOT_PROTECTED'}
  $have=Aces $before;$want=@($a.aces|ForEach-Object{Wanted (Sub $_)})
  $controller=@($have|Where-Object{$_.StartsWith($ControllerSid+'|')})
  if($controller.Count -and (@($controller|Sort-Object) -join ';') -cne (@($want|Sort-Object) -join ';')){throw 'ACL_TARGET_HAS_OTHER_CONTROLLER_ACES'}
  $plan+=[ordered]@{kind='add-controller-read';path=$p;before=$before;aces=@($a.aces|ForEach-Object{Sub $_});skip=($controller.Count -gt 0)}
 }
 foreach($c in $model.create){
  $p=Map $c.path;$sddl=Sub $c.sddl;$compare=if($OfflineFixtureRoot){$sddl+'(A;OICI;FA;;;'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+')'}else{$sddl}
  if([IO.Directory]::Exists($p)){$now=Sddl $p;$same=(@(Aces $now|Sort-Object) -join ';') -ceq (@(Aces $compare|Sort-Object) -join ';');if(-not $same){throw 'ACL_CREATE_TARGET_EXISTS_DIFFERENT'};$plan+=[ordered]@{kind='create';path=$p;sddl=$sddl;skip=$true}}
  elseif([IO.File]::Exists($p)){throw 'ACL_CREATE_TARGET_IS_A_FILE'}else{$plan+=[ordered]@{kind='create';path=$p;sddl=$sddl;skip=$false}}
 }
 $out.planSha256=(([Security.Cryptography.SHA256]::Create()).ComputeHash((New-Object Text.UTF8Encoding($false)).GetBytes(($plan|ConvertTo-Json -Depth 6 -Compress)))|ForEach-Object{$_.ToString('x2')}) -join ''
 foreach($s in $plan){
  $step=[ordered]@{kind=$s.kind;path=$s.path;skipped=$s.skip;after=$null}
  if($Apply -and -not $s.skip){
   if($s.kind -ceq 'add' -or $s.kind -ceq 'add-controller-read'){
    if((Sddl $s.path) -cne $s.before){throw 'ACL_CHANGED_SINCE_PLAN'}
    # Only the DACL is written (no owner, group or SACL section), so no privilege beyond WRITE_DAC is used.
    $text=$s.before;foreach($ace in $s.aces){$text+=$ace}
    $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($text,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($s.path,$acl)
    $after=Sddl $s.path;$have=Aces $after;foreach($ace in $s.aces){if($have -cnotcontains (Wanted $ace)){throw 'ACL_READBACK_MISSING_ACE'}}
    foreach($old in (Aces $s.before)){if($have -cnotcontains $old){throw 'ACL_READBACK_LOST_ACE'}};$step.after=$after
   }else{
    # Offline fixture only: a non-admin test user cannot set owner BA and needs its own ACE to continue.
    $effective=if($OfflineFixtureRoot){($s.sddl -replace '^O:BAG:BA','')+'(A;OICI;FA;;;'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+')'}else{$s.sddl}
    $ds=New-Object Security.AccessControl.DirectorySecurity;$ds.SetSecurityDescriptorSddlForm($effective)
    [void][IO.Directory]::CreateDirectory($s.path,$ds);$after=Sddl $s.path
    if((@(Aces $after|Sort-Object) -join ';') -cne (@(Aces $(if($OfflineFixtureRoot){'O:BAG:BA'+$effective}else{$s.sddl})|Sort-Object) -join ';')){throw 'ACL_CREATE_READBACK_MISMATCH'};$step.after=$after
   }
  }
  $out.steps+=$step
 }
 $out.status=if($Apply){'SOURCE_V2_ACL_MIGRATED'}else{'SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN'};$code=0
}catch{$id=$_.FullyQualifiedErrorId.Split(',')[0];$out.code=if($id -cmatch '^[A-Z][A-Z0-9_]{1,79}$'){$id}else{'ACL_MIGRATION_UNCONFIRMED'};$out['exceptionType']=$_.Exception.GetType().Name;$code=2}
$out|ConvertTo-Json -Depth 6 -Compress
exit $code
