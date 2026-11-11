# Real Windows PowerShell 5 / NTFS boundaries of the repair entry's own native reader.
# No Preflight/Run, production ACL, registry, SCM, task, WSL or UAC call. New random TEMP fixtures are retained.
param([string]$Powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
if($PSVersionTable.PSVersion.Major -ne 5){throw 'WINDOWS_POWERSHELL_5_REQUIRED'}
$who=[Security.Principal.WindowsIdentity]::GetCurrent()
if((New-Object Security.Principal.WindowsPrincipal($who)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NON_ELEVATED_TEST_REQUIRED'}
$source=Join-Path $PSScriptRoot 'repair-m5b-turing-relay-parents-reviewed.ps1'
$errors=$null;$tokens=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if(@($errors).Count -ne 0){throw 'REPAIR_NATIVE_TEST_PARSE_REFUSED'}
$types=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value.Contains('public static class TuringParentRepairRead')},$true))
if($types.Count -ne 1){throw 'EXACT_REPAIR_NATIVE_TYPE_REQUIRED'}
Add-Type -TypeDefinition $types[0].Value|Out-Null
$count=0;function Yes([bool]$v,[string]$label){if(-not $v){throw ('REPAIR_NATIVE_TEST_FAILED:'+ $label)};$script:count++}
function Refuses-Open([string]$path,[bool]$directory){$h=$null;try{$h=[TuringParentRepairRead]::Open($path,$directory);return $false}catch{return $true}finally{if($null -ne $h){$h.Dispose()}}}
$temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$scratch=Join-Path $temp ('m5b-parent-native-'+[guid]::NewGuid().ToString('N'))
if(-not [IO.Path]::GetFullPath($scratch).StartsWith($temp+'\',[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $scratch)){throw 'OWN_NEW_TEMP_REQUIRED'}
[void][IO.Directory]::CreateDirectory($scratch)
try{
 # Execute only the entry's actual module-path predicate, never its host/preflight/run body.
 $moduleLoops=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.ForEachStatementAst] -and $n.Condition.Extent.Text.Contains('Microsoft.PowerShell.Core\Get-Module')},$true))
 if($moduleLoops.Count -ne 1 -or $moduleLoops[0].Body.Statements.Count -ne 1){throw 'EXACT_MODULE_GUARD_REQUIRED'}
 $guard=[ScriptBlock]::Create($moduleLoops[0].Body.Statements[0].Extent.Text)
 Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
 $m=Microsoft.PowerShell.Core\Get-Module Microsoft.PowerShell.Utility
 if($null -eq $m){throw 'STOCK_UTILITY_NOT_LOADED'}
 & $guard;Yes $true 'actual-stock-utility-module-path-accepted'
 foreach($outside in @('C:\outside\Modules','C:\Windows\System32\WindowsPowerShell\v1.0-evil')){
  $m=[pscustomobject]@{ModuleBase=$outside};$rejected=$false;try{& $guard}catch{$rejected=$true}
  Yes $rejected 'outside-or-sibling-module-base-refused'
 }
 # Pure closed-scene functions only: no production Preflight, installed read or account impersonation.
 foreach($fn in @('Get-ParentRepairScene','Test-ParentRepairActor','Get-ParentRepairTargets')){
  $def=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $fn},$true));if($def.Count -ne 1){throw 'EXACT_SCENE_FUNCTION_REQUIRED'};. ([scriptblock]::Create($def[0].Extent.Text))
 }
 $nativeCasesBeforeScenes=$count;$sceneCases=0
 foreach($scene in @('turing-b2ea','desk-31080')){
  $pins=Get-ParentRepairScene $scene;$paths=@(Get-ParentRepairTargets $pins)
  Yes ($pins.sceneId -ceq $scene -and $paths.Count -eq 2 -and $paths[0].path -ceq 'C:\ProgramData\CluedIndependentCI' -and $paths[1].path -ceq 'C:\ProgramData\CluedIndependentCI\formal-spool') 'closed-scene-exact-two-fixed-paths'
  Yes ($paths[0].before.StartsWith($(if($scene -ceq 'desk-31080'){'O:BAG:BAD:PAI'}else{'O:BAG:'+$pins.group+'D:PAI'}),[StringComparison]::Ordinal)) 'exact-stored-sddl-owner-group-spelling-for-string-cas'
  Yes (Test-ParentRepairActor $pins $pins.host $pins.operator) 'closed-scene-own-host-and-operator'
  Yes (-not (Test-ParentRepairActor $pins $(if($pins.host -ceq 'TURING'){'DESK-W-591'}else{'TURING'}) $pins.operator)) 'cross-host-refused'
  Yes (-not (Test-ParentRepairActor $pins $pins.host $pins.companion)) 'companion-cannot-approve-or-run-as-operator'
  Yes (-not (Test-ParentRepairActor $pins $pins.host $pins.controller)) 'controller-cannot-approve-or-run-as-operator'
  foreach($target in $paths){$sd=New-Object Security.AccessControl.RawSecurityDescriptor($target.before);$aces=@($sd.DiscretionaryAcl)
   Yes ($sd.Owner.Value -ceq 'S-1-5-32-544' -and $sd.Group.Value -ceq $pins.group -and $aces.Count -eq 5 -and @($aces|Where-Object{$_.SecurityIdentifier.Value -ceq $pins.companion}).Count -eq 0) 'scene-exact-owner-group-and-five-legacy-roles'
   $own=@($aces|Where-Object{$_.SecurityIdentifier.Value -ceq $pins.operator});$ctl=@($aces|Where-Object{$_.SecurityIdentifier.Value -ceq $pins.controller});$res=@($aces|Where-Object{$_.SecurityIdentifier.Value -ceq 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'})
   Yes ($own.Count -eq 1 -and $own[0].AccessMask -eq 0x120080 -and [int]$own[0].AceFlags -eq 0 -and $ctl.Count -eq 1 -and $ctl[0].AccessMask -eq 0x1200a9 -and [int]$ctl[0].AceFlags -eq 3 -and $res.Count -eq 1 -and $res[0].AccessMask -eq $(if($target.path -ceq $paths[0].path){0x120080}else{0x1200a5}) -and [int]$res[0].AceFlags -eq 0) 'scene-retains-exact-operator-controller-resident-rights'
  }
  if($scene -ceq 'turing-b2ea'){Yes ($pins.host -ceq 'TURING' -and $pins.operator -clike '*-1001' -and $pins.companion -clike '*-1017' -and $pins.controller -clike '*-1015' -and $pins.haltSha -ceq '2108b842c2aa887737407cdc23becad934d6c05607bbad97843cf975647f5785' -and $pins.group -clike '*-513') 'turing-original-halt-and-account-pins-preserved'}
  else{Yes ($pins.host -ceq 'DESK-W-591' -and $pins.operator -clike '*-1000' -and $pins.companion -clike '*-1008' -and $pins.controller -clike '*-1007' -and $pins.haltSha -ceq '1523b55a286b677a0d11bcbd1af1d8af6aa459eb4298871f0037dcda57e31a52' -and $pins.group -ceq 'S-1-5-32-544') 'desk-exact-halt-and-account-pins'}
 }
 $denied=$false;try{Get-ParentRepairScene 'unknown-scene'|Out-Null}catch{$denied=$true};Yes $denied 'unknown-scene-refused'
 $sceneCases=$count-$nativeCasesBeforeScenes
 $file=Join-Path $scratch 'ordinary.txt';[IO.File]::WriteAllText($file,'fixture-only')
 $h=[TuringParentRepairRead]::Open($file,$false)
 try{
  $m=[TuringParentRepairRead]::Meta($h)
  Yes (-not $h.IsInvalid -and -not $h.IsClosed -and $m.SizeLo -eq 12 -and $m.Links -eq 1 -and ($m.Attr -band 0x410) -eq 0) 'ordinary-file-opens-with-real-metadata'
  Yes ([TuringParentRepairRead]::Same($m,[TuringParentRepairRead]::Meta($h))) 'same-held-file-identity-stable'
  $opened=$false;$w=$null;try{$w=[IO.File]::Open($file,'Open','Write','ReadWrite');$opened=$true}catch{}finally{if($null -ne $w){$w.Dispose()}}
  Yes (-not $opened) 'held-file-refuses-new-writer'
  $deleted=$false;try{[IO.File]::Delete($file);$deleted=-not [IO.File]::Exists($file)}catch{}
  Yes (-not $deleted -and [IO.File]::Exists($file)) 'held-file-refuses-delete'
 }finally{$h.Dispose()}
 [IO.File]::WriteAllText($file,'after-release');Yes ([IO.File]::ReadAllText($file) -ceq 'after-release') 'writer-works-after-handle-release'
 [IO.File]::Delete($file);Yes (-not [IO.File]::Exists($file)) 'delete-works-after-handle-release'
 $dir=Join-Path $scratch 'ordinary-directory';[void][IO.Directory]::CreateDirectory($dir)
 $h=[TuringParentRepairRead]::Open($dir,$true)
 try{
  $m=[TuringParentRepairRead]::Meta($h);Yes (($m.Attr -band 0x10) -ne 0 -and ($m.Attr -band 0x400) -eq 0) 'ordinary-directory-opens'
  $moved=$false;try{[IO.Directory]::Move($dir,($dir+'.moved'));$moved=$true}catch{}
  Yes (-not $moved -and [IO.Directory]::Exists($dir)) 'held-directory-refuses-rename'
 }finally{$h.Dispose()}
 [IO.Directory]::Move($dir,($dir+'.moved'));Yes ([IO.Directory]::Exists($dir+'.moved')) 'directory-rename-works-after-release'
 [IO.Directory]::Move(($dir+'.moved'),$dir)
 $ordinary=Join-Path $scratch 'type-check.txt';[IO.File]::WriteAllText($ordinary,'type')
 Yes (Refuses-Open $ordinary $true) 'file-refused-when-directory-required'
 Yes (Refuses-Open $dir $false) 'directory-refused-when-file-required'
 $hardSource=Join-Path $scratch 'hard-source.txt';$hard=Join-Path $scratch 'hard-link.txt';[IO.File]::WriteAllText($hardSource,'hardlink')
 New-Item -ItemType HardLink -Path $hard -Value $hardSource -ErrorAction Stop|Out-Null
 $f=[IO.File]::Open($hardSource,'Open','Read','ReadWrite,Delete')
 try{$m=[TuringParentRepairRead]::Meta($f.SafeFileHandle);Yes ($m.Links -eq 2) 'real-ntfs-hardlink-count-two'}finally{$f.Dispose()}
 Yes (Refuses-Open $hardSource $false) 'hardlinked-source-refused'
 Yes (Refuses-Open $hard $false) 'hardlink-alias-refused'
 $target=Join-Path $scratch 'junction-target';$junction=Join-Path $scratch 'junction';[void][IO.Directory]::CreateDirectory($target)
 New-Item -ItemType Junction -Path $junction -Value $target -ErrorAction Stop|Out-Null
 Yes (([IO.File]::GetAttributes($junction) -band [IO.FileAttributes]::ReparsePoint) -ne 0) 'real-ntfs-junction-created'
 Yes (Refuses-Open $junction $true) 'junction-directory-refused'
 Yes (Refuses-Open $junction $false) 'junction-file-refused'
 # The only whole-entry invocation has no mode switches; its early return precedes every production read/action.
 $disabled=& $Powershell -NoProfile -NonInteractive -File $source;$raw=$LASTEXITCODE
 Yes ($raw -eq 0 -and $disabled -ceq '{"status":"DISABLED"}') 'default-disabled-zero-entry-actions'
 [pscustomobject]@{status='M5B_PARENT_NATIVE_TEMP_PASS';cases=$count;sceneCases=$sceneCases;nativeBoundaryCases=($count-$sceneCases);engine=$PSVersionTable.PSVersion.ToString();scratch=$scratch;retained=$true;entrySha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant();productionPreflight=$false;productionRun=$false;productionAclChanges=$false;taskScmWslUac=$false}|ConvertTo-Json -Compress
}catch{Write-Output ('REPAIR_NATIVE_ASSERTIONS_BEFORE_FAILURE='+$count);Write-Output ('RETAINED_TEMP='+$scratch);throw}
