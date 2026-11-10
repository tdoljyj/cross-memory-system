# Two closed incident scenes; one repair implementation. Disabled by default; production use needs the exact reviewed exception.
[CmdletBinding()]param([ValidateSet('turing-b2ea','desk-31080')][string]$Scene,[switch]$Preflight,[switch]$Run)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
if(-not $Preflight -and -not $Run){'{"status":"DISABLED"}';return}
if($Preflight -and $Run){throw 'FIXED_MODE_REQUIRED'}
$phase='HOST';$held=New-Object 'Collections.Generic.List[IDisposable]'
function Get-ParentRepairScene([ValidateSet('turing-b2ea','desk-31080')][string]$Scene) {
 if(-not $Scene){$Scene=switch -CaseSensitive ([Environment]::MachineName){'TURING'{'turing-b2ea'};'DESK-W-591'{'desk-31080'};default{throw 'REFUSED'}}}
 switch -CaseSensitive ($Scene){
  'turing-b2ea'{[ordered]@{sceneId=$Scene;host='TURING';operator='S-1-5-21-1173730660-3877291096-655431861-1001';companion='S-1-5-21-1173730660-3877291096-655431861-1017';controller='S-1-5-21-1173730660-3877291096-655431861-1015';group='S-1-5-21-1173730660-3877291096-655431861-513';haltSha='2108b842c2aa887737407cdc23becad934d6c05607bbad97843cf975647f5785'}}
  'desk-31080'{[ordered]@{sceneId=$Scene;host='DESK-W-591';operator='S-1-5-21-858977881-4031698862-3006450925-1000';companion='S-1-5-21-858977881-4031698862-3006450925-1008';controller='S-1-5-21-858977881-4031698862-3006450925-1007';group='S-1-5-32-544';haltSha='1523b55a286b677a0d11bcbd1af1d8af6aa459eb4298871f0037dcda57e31a52'}}
  default{throw 'REFUSED'}
 }
}
function Test-ParentRepairActor($pins,[string]$hostName,[string]$actorSid){$pins.host -ceq $hostName -and $pins.operator -ceq $actorSid}
function Get-ParentRepairTargets($pins){
 $groupToken=if($pins.group -ceq 'S-1-5-32-544'){'BA'}else{$pins.group}
 $base='O:BAG:'+$groupToken+'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x120080;;;'+$pins.operator+')(A;OICI;0x1200a9;;;'+$pins.controller+')'
 $resident='S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
 @([ordered]@{path='C:\ProgramData\CluedIndependentCI';before=$base+'(A;;0x120080;;;'+$resident+')'},[ordered]@{path='C:\ProgramData\CluedIndependentCI\formal-spool';before=$base+'(A;;0x1200a5;;;'+$resident+')'})
}
$evidence='C:\w\m5b-r4-native-env-recovery-evidence-20261110\turing-b2ea-root-cause'
$installer='C:\w\m5b-r4-native-env-recovery-20261110\work\independent-ci-resident-v1\windows\install-resident.ps1'
$installerSha='bc08bdbf0f7d8067b6242f3832694845225bbc8654e21f5f3e41b406146b9c33'
$halt='C:\ProgramData\CluedIndependentCI\resident\state\HALT.json'
try {
 $pins=Get-ParentRepairScene $Scene;$Scene=$pins.sceneId
 $who=[Security.Principal.WindowsIdentity]::GetCurrent()
 if(-not (Test-ParentRepairActor $pins ([Environment]::MachineName) $who.User.Value) -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'){throw 'REFUSED'}
 if($Run -and -not (New-Object Security.Principal.WindowsPrincipal($who)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'REFUSED'}
 $sid=$pins.companion;$operator=$pins.operator;$haltSha=$pins.haltSha;$targets=Get-ParentRepairTargets $pins
 $intentPath=$evidence+'\parent-repair-'+$Scene+'-intent.1.json';$resultPath=$evidence+'\parent-repair-'+$Scene+'-result.1.json'
 foreach($name in [Environment]::GetEnvironmentVariables().Keys){if([string]$name -imatch '^(COR_|CORECLR_|COMPlus_|DOTNET|APPDOMAIN_MANAGER_|DEVPATH$)'){throw 'REFUSED'}}
 $env:PSModulePath='C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
 foreach($m in (Microsoft.PowerShell.Core\Get-Module)){if($m.ModuleBase -and $m.ModuleBase -ine 'C:\Windows\System32\WindowsPowerShell\v1.0' -and -not $m.ModuleBase.StartsWith('C:\Windows\System32\WindowsPowerShell\v1.0\',[StringComparison]::OrdinalIgnoreCase)){throw 'REFUSED'}}
 Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public static class TuringParentRepairRead {
 [StructLayout(LayoutKind.Sequential)] public struct Info{public uint Attr,CTLo,CTHi,ATLo,ATHi,WTLo,WTHi,Volume,SizeHi,SizeLo,Links,IdHi,IdLo;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint n,uint f);
 public static Info Meta(SafeFileHandle h){Info i;if(!GetFileInformationByHandle(h,out i))throw new IOException("REFUSED");return i;}
 public static SafeFileHandle Open(string p,bool dir){var h=CreateFileW(p,0x80020080u,dir?3u:1u,IntPtr.Zero,3,dir?0x02200000u:0x00200000u,IntPtr.Zero);
  try{if(h.IsInvalid)throw new IOException("REFUSED");var i=Meta(h);if((i.Attr&0x400)!=0||dir!=((i.Attr&0x10)!=0)||!dir&&(i.Links!=1||i.SizeHi!=0))throw new IOException("REFUSED");var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);if(n==0||n>=b.Capacity||!b.ToString().StartsWith(@"\\?\",StringComparison.Ordinal)||!String.Equals(Path.GetFullPath(p).TrimEnd('\\'),b.ToString().Substring(4).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new IOException("REFUSED");return h;}catch{h.Dispose();throw;}}
 public static bool Same(Info a,Info b){return a.Attr==b.Attr&&a.Volume==b.Volume&&a.SizeHi==b.SizeHi&&a.SizeLo==b.SizeLo&&a.Links==b.Links&&a.IdHi==b.IdHi&&a.IdLo==b.IdLo&&a.WTLo==b.WTLo&&a.WTHi==b.WTHi;}
}
'@
 function Hash([byte[]]$bytes){$h=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
 function HoldParents([string]$p){$dirs=New-Object 'Collections.Generic.List[string]';for($d=[IO.Path]::GetDirectoryName($p);$d;$d=[IO.Path]::GetDirectoryName($d)){$dirs.Insert(0,$d)};foreach($d in $dirs){$held.Add([TuringParentRepairRead]::Open($d,$true))}}
 function ReadFixed([string]$p,[int]$max){HoldParents $p;$h=[TuringParentRepairRead]::Open($p,$false);$held.Add($h);$before=[TuringParentRepairRead]::Meta($h);if($before.SizeLo -gt $max){throw 'REFUSED'};$f=New-Object IO.FileStream($h,[IO.FileAccess]::Read);$held.Add($f);$bytes=New-Object byte[] ([int]$before.SizeLo);$pos=0;while($pos -lt $bytes.Length){$n=$f.Read($bytes,$pos,$bytes.Length-$pos);if($n -lt 1){throw 'REFUSED'};$pos+=$n};if(-not [TuringParentRepairRead]::Same($before,[TuringParentRepairRead]::Meta($h))){throw 'REFUSED'};return ,$bytes}
 function WriteNew([string]$p,$v){HoldParents $p;$bytes=(New-Object Text.UTF8Encoding($false)).GetBytes(($v|ConvertTo-Json -Depth 8 -Compress)+[char]10);$f=[IO.File]::Open($p,'CreateNew','Write','None');try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()};return (Hash $bytes)}
 $phase='HALT';$haltBytes=ReadFixed $halt 65536;if((Hash $haltBytes) -cne $haltSha){throw 'REFUSED'}
 $phase='SOURCE';$source=ReadFixed $installer 262144;if((Hash $source) -cne $installerSha){throw 'REFUSED'}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput((New-Object Text.UTF8Encoding($false,$true)).GetString($source),[ref]$tokens,[ref]$errors);if(@($errors).Count -ne 0){throw 'REFUSED'}
 foreach($functionName in @('Get-RelayParentAclPresence','Get-ParentAce','Get-AceKeys','Get-DaclPart','Get-ParentAclState','Add-ParentAce')){
  $defs=@($ast.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -ceq $functionName},$true));if($defs.Count -ne 1){throw 'REFUSED'}
  . ([scriptblock]::Create($defs[0].Extent.Text))
 }
 $phase='PRECONDITIONS';$plans=@()
 foreach($t in $targets){HoldParents ($t.path+'\fixed-leaf-not-opened');if((Get-Acl -LiteralPath $t.path).Sddl -cne $t.before){throw 'REFUSED'};if((Get-RelayParentAclPresence $t.before $sid) -cne 'missing'){throw 'REFUSED'};$plans+=,(Get-ParentAclState $t.path $sid)}
 if(Test-Path -LiteralPath $intentPath){throw 'REFUSED'};if(Test-Path -LiteralPath $resultPath){throw 'REFUSED'}
 # The original TURING once-marker is also a permanent refusal: changing filenames never retries an old unknown operation.
 if($Scene -ceq 'turing-b2ea' -and ((Test-Path -LiteralPath ($evidence+'\parent-repair-intent.1.json')) -or (Test-Path -LiteralPath ($evidence+'\parent-repair-result.1.json')))){throw 'REFUSED'}
 if($Preflight){[ordered]@{status='PREFLIGHT_ONLY';sceneId=$Scene;targets=2;haltSha256=$haltSha;installerSha256=$installerSha;productionChanges=$false}|ConvertTo-Json -Compress;return}
 $phase='INTENT';$intent=[ordered]@{contract='clued.m5b.parent-repair/1';sceneId=$Scene;host=$pins.host;status='INTENT';haltSha256=$haltSha;installerSha256=$installerSha;companionSid=$sid;rights='0x120080';inheritance='none';targets=$targets}
 $intentSha=WriteNew $intentPath $intent
 $phase='APPEND';$applied=@()
 foreach($plan in $plans){if((Hash $haltBytes) -cne $haltSha){throw 'REFUSED'};if((Add-ParentAce $plan) -ne $true){throw 'REFUSED'};if((Get-RelayParentAclPresence ((Get-Acl -LiteralPath $plan.path).Sddl) $sid) -cne 'present'){throw 'REFUSED'};$applied+=,[ordered]@{path=$plan.path;afterSddl=(Get-Acl -LiteralPath $plan.path).Sddl}}
 $phase='RESULT';$result=[ordered]@{contract='clued.m5b.parent-repair/1';sceneId=$Scene;host=$pins.host;status='PARENTS_REPAIRED_HALT_RETAINED';intentSha256=$intentSha;haltSha256=$haltSha;installerSha256=$installerSha;applied=$applied;taskActions=$false;serviceActions=$false;wslActions=$false;sourceDeployment=$false}
 $resultSha=WriteNew $resultPath $result
 [ordered]@{status=$result.status;resultSha256=$resultSha}|ConvertTo-Json -Compress
}catch{[ordered]@{status='REFUSED_OR_PARTIAL_UNKNOWN';phase=$phase;code='FIXED_M5B_PARENT_REPAIR_REFUSED';automaticRetryAllowed=$false}|ConvertTo-Json -Compress;exit 1}
finally{for($i=$held.Count-1;$i -ge 0;$i--){$held[$i].Dispose()}}
