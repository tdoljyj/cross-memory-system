# Offline test of resident-v2/archive-windows-spool.ps1 against a fixture spool in the caller's TEMP.
# Never touches ProgramData, never elevates. Prints one JSON summary; exit 0 only when all cases pass.
param([string]$Powershell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$tool=Join-Path (Split-Path -Parent $PSScriptRoot) 'archive-windows-spool.ps1'
$utf8=New-Object Text.UTF8Encoding($false);$cases=0
$FixtureNodeProfile=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\..\..\..\..\independent-ci-resident-v1\config\node-profile.turing.json'))
function Hash([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Yes([bool]$v,[string]$what){if(-not $v){throw ('ARCHIVE_TEST_FAILED:'+$what)};$script:cases++}
function New-Fixture{
 $root=Join-Path ([IO.Path]::GetTempPath()) ('clued-spool-'+[Guid]::NewGuid().ToString('N').Substring(0,10));$spool=Join-Path $root 'formal-spool'
 [void][IO.Directory]::CreateDirectory($spool)
 # A fixed four-ACE protected DACL, inherited by every leaf (the shape of the real spool).
 $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false)
 foreach($p in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($me,'FullControl'),@('S-1-5-32-545','ReadAndExecute'))){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($p[0])),$p[1],'ContainerInherit,ObjectInherit','None','Allow')))}
 [IO.Directory]::SetAccessControl($spool,$acl)
 foreach($d in 'incoming','outgoing'){[void][IO.Directory]::CreateDirectory((Join-Path $spool $d))}
 return $spool
}
function Pair([string]$spool,[string]$folder,[string]$name,[string]$text,[switch]$NoReady,[switch]$BadReady){
 $b=$utf8.GetBytes($text);[IO.File]::WriteAllBytes((Join-Path $spool ($folder+'\'+$name+'.json')),$b)
 if(-not $NoReady){$sha=if($BadReady){'0'*64}else{Hash $b};[IO.File]::WriteAllText((Join-Path $spool ($folder+'\'+$name+'.ready.json')),('{"bytes":'+$b.Length+',"contract":"clued.independent-ci.complete-public-file/1","sha256":"'+$sha+'"}'),$utf8)}
}
function Run([string]$spool,[string]$reason){$key='a'*64;$out=& $Powershell -NoProfile -NonInteractive -File $tool -BatchKey $key -Reason $reason -OfflineFixtureSpool $spool -OfflineFixtureNodeProfileBase64 ([Convert]::ToBase64String($utf8.GetBytes($FixtureNodeProfile)));return ($out|Select-Object -Last 1)|ConvertFrom-Json}
# FileSecurity normalizes duplicate ACEs before SetAccessControl. Use the raw native DACL setter so
# malformed-ACL tests really reach the archiver with six entries; only this test's own TEMP leaves.
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Runtime.InteropServices;
public static class ArchiveFixtureAcl {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool SetFileSecurityW(string p,uint f,byte[] s);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetFileSecurityW(string p,uint f,byte[] s,uint n,out uint needed);
 public static void Set(string p,byte[] s){if(!SetFileSecurityW(p,0x80000004u,s))throw new IOException("FIXTURE_DACL_SET_FAILED:"+Marshal.GetLastWin32Error());}
 public static byte[] Read(string p){uint n;GetFileSecurityW(p,7,null,0,out n);if(n<20||n>65536)throw new IOException("FIXTURE_DACL_READ_BOUND");var b=new byte[n];if(!GetFileSecurityW(p,7,b,n,out n))throw new IOException("FIXTURE_DACL_READ_FAILED");return b;}
}
'@ | Out-Null
function Set-LeafAcl([string]$file,[string]$sddl){
 $full=[IO.Path]::GetFullPath($file);if(-not $full.StartsWith(([IO.Path]::GetTempPath().TrimEnd('\')+'\clued-spool-'),[StringComparison]::OrdinalIgnoreCase)){throw 'FIXTURE_DACL_OUTSIDE_TEMP'}
 $a=New-Object Security.AccessControl.RawSecurityDescriptor($sddl);$b=New-Object byte[] $a.BinaryLength;$a.GetBinaryForm($b,0);[ArchiveFixtureAcl]::Set($full,$b)
}
function Leaf-Acl([string]$file){$r=New-Object Security.AccessControl.RawSecurityDescriptor([ArchiveFixtureAcl]::Read($file),0);$r.GetSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')}
function Canonical-Acl([string]$sddl){$r=New-Object Security.AccessControl.RawSecurityDescriptor($sddl);$a=@($r.DiscretionaryAcl|ForEach-Object{$_.SecurityIdentifier.Value+'|'+$_.AccessMask+'|'+$_.AceQualifier+'|'+([int]$_.AceFlags -band -bnot 16)}|Sort-Object);$r.Owner.Value+'|'+$r.Group.Value+'|'+($a -join ';')}
function New-M5bFixture{
 $s=New-Fixture
 $root=Split-Path -Parent $s;$install=Join-Path $root 'resident\install';[void][IO.Directory]::CreateDirectory($install)
 $script:controller=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $prefix=$script:controller.Substring(0,$script:controller.LastIndexOf('-'))
 $script:companion=$prefix+'-424242';$script:operator=$prefix+'-424243';$script:resident='S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
 $profile=$FixtureNodeProfile|ConvertFrom-Json;$profile.controllerSid=$controller;$profile.ownerSid=$companion;$profile.hostname=[Environment]::MachineName;$profile.mutationMutex='Global\CluedControlControllerMutationV1-'+$profile.hostname+'-'+$controller.Split('-')[-1]
 $script:FixtureNodeProfile=$profile|ConvertTo-Json -Compress
 $safe='O:'+ $controller+'G:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;'+$controller+')'
 foreach($p in @($root,(Join-Path $root 'resident'),$install)){$acl=New-Object Security.AccessControl.DirectorySecurity;$acl.SetSecurityDescriptorSddlForm($safe,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($p,$acl)}
 [IO.File]::WriteAllText((Join-Path $install 'companion-account.json'),('{"contract":"clued.independent-ci.companion-account/1","companionSid":"'+$companion+'","operatorSid":"'+$operator+'"}'),$utf8)
 Pair $s 'outgoing' 'issue' '{"m5b":1}';Pair $s 'incoming' 'result' '{"m5b":2}';[IO.File]::WriteAllText((Join-Path $s 'outgoing\active.lock'),'m5b-lock',$utf8)
 $script:outAcl='O:'+ $controller+'G:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1301bf;;;'+$controller+')(A;;0x1200a9;;;'+$companion+')(A;;0x1200a9;;;'+$operator+')(A;;0x120089;;;'+$resident+')'
 $script:inAcl='O:'+ $controller+'G:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;'+$controller+')(A;;0x1301bf;;;'+$companion+')(A;;0x120089;;;'+$resident+')'
 foreach($file in [IO.Directory]::GetFiles((Join-Path $s 'outgoing'))){Set-LeafAcl $file $outAcl}
 foreach($file in [IO.Directory]::GetFiles((Join-Path $s 'incoming'))){Set-LeafAcl $file $inAcl}
 return $s
}
function Refuses-M5b([string]$spool,[string]$name){$v=Run $spool 'success-close';Yes ($v.verified -eq $false -and [IO.File]::Exists((Join-Path $spool 'outgoing\issue.json')) -and [IO.File]::Exists((Join-Path $spool 'incoming\result.json')) -and @(Get-ChildItem -LiteralPath $spool -Directory|Where-Object{$_.Name -like 'archive-*'}).Count -eq 0) ($name+':'+$v.code)}
$roots=@()
try{
 # 1. completed protocol (between-roles-4): every record moves flat; journals and archives stay
 $s=New-Fixture;$roots+=$s
 Pair $s 'outgoing' 'issue' '{"issue":1}';Pair $s 'incoming' 'result' '{"result":1}';Pair $s 'incoming' 'challenge-01' '{"c":1}';Pair $s 'outgoing' 'response-01' '{"r":1}'
 # bridge v4: the worker's clean 'blocked' record is a protocol record too (PR #889 stage 2, 2026-10-21)
 Pair $s 'incoming' 'blocked' '{"b":1}'
 [IO.File]::WriteAllText((Join-Path $s 'outgoing\active.lock'),'lock',$utf8);$journal=('b'*64)+'.json';[IO.File]::WriteAllText((Join-Path $s ('outgoing\'+$journal)),'{"journal":1}',$utf8)
 [IO.File]::WriteAllText((Join-Path $s 'outgoing\observations.jsonl'),'{}',$utf8);[void][IO.Directory]::CreateDirectory((Join-Path $s ('archive-'+('c'*64))))
 $v=Run $s 'between-roles-4'
 Yes ($v.verified -eq $true -and $v.moved -eq 11) ('completed-moves-all:'+($v|ConvertTo-Json -Compress))
 Yes (-not [IO.File]::Exists((Join-Path $s 'incoming\blocked.json')) -and -not [IO.File]::Exists((Join-Path $s 'incoming\blocked.ready.json'))) 'blocked-archived'
 $dir=Join-Path $s $v.directory;Yes ($v.directory -cmatch '^archive-aaaaaaaaaaaa-between-roles-4-[0-9a-f]{12}$') 'archive-name'
 Yes (@(Get-ChildItem -LiteralPath $dir -Directory).Count -eq 0) 'flat-destination'
 Yes ([IO.File]::Exists((Join-Path $s ('outgoing\'+$journal))) -and [IO.File]::Exists((Join-Path $s 'outgoing\observations.jsonl'))) 'journal-kept'
 Yes (@(Get-ChildItem -LiteralPath (Join-Path $s 'incoming')).Count -eq 0) 'incoming-empty'
 $r=Get-Content -LiteralPath (Join-Path $dir 'archive-receipt.json') -Raw|ConvertFrom-Json;Yes ($r.deletesAnything -eq $false -and @($r.moved).Count -eq 11) 'receipt'
 # 2. completed scope refuses a half pair, an unbound ready marker and an unknown leaf (nothing moved)
 $s=New-Fixture;$roots+=$s;Pair $s 'outgoing' 'issue' '{"issue":2}' -NoReady
 $v=Run $s 'success-close';Yes ($v.verified -eq $false -and $v.code -ceq 'HALF_PROTOCOL_PAIR_PRESERVED' -and [IO.File]::Exists((Join-Path $s 'outgoing\issue.json'))) 'half-pair-refused'
 $s=New-Fixture;$roots+=$s;Pair $s 'incoming' 'result' '{"result":2}' -BadReady
 $v=Run $s 'between-roles-6';Yes ($v.verified -eq $false -and $v.code -ceq 'READY_MARKER_BINDING_PRESERVED') 'unbound-ready-refused'
 $s=New-Fixture;$roots+=$s;Pair $s 'incoming' 'result' '{"result":3}';[IO.File]::WriteAllText((Join-Path $s 'incoming\planted.json'),'x',$utf8)
 $v=Run $s 'success-close';Yes ($v.verified -eq $false -and $v.code -ceq 'UNKNOWN_SPOOL_LEAF_PRESERVED' -and [IO.File]::Exists((Join-Path $s 'incoming\result.json'))) 'unknown-leaf-refused'
 # 3. failure scope archives the scene as found (half pair included) and reports what it left
 $s=New-Fixture;$roots+=$s;Pair $s 'outgoing' 'issue' '{"issue":3}' -NoReady;Pair $s 'incoming' 'challenge-02' '{"c":2}';[IO.File]::WriteAllText((Join-Path $s 'incoming\planted.json'),'x',$utf8)
 $v=Run $s 'rearm-unknown-failure';Yes ($v.verified -eq $true -and $v.moved -eq 3 -and $v.halfPairs -eq 1 -and $v.remainderLeftInPlace -eq 1 -and $v.directory -like 'failed-*') 'failure-scene'
 Yes ([IO.File]::Exists((Join-Path $s 'incoming\planted.json'))) 'planted-left-in-place'
 # 4. a junction planted as incoming is refused before anything moves
 $s=New-Fixture;$roots+=$s;Pair $s 'outgoing' 'issue' '{"issue":4}';$elsewhere=Join-Path (Split-Path -Parent $s) 'elsewhere';[void][IO.Directory]::CreateDirectory($elsewhere)
 [IO.Directory]::Delete((Join-Path $s 'incoming'));& cmd.exe /c mklink /J (Join-Path $s 'incoming') $elsewhere | Out-Null
 $v=Run $s 'success-close';Yes ($v.verified -eq $false -and $v.code -ceq 'SPOOL_PARENT_NOT_A_REAL_DIRECTORY' -and [IO.File]::Exists((Join-Path $s 'outgoing\issue.json'))) ('junction-refused:'+$v.code)
 # 5. the fixture override is refused outside TEMP
 $v=Run 'C:\Windows' 'success-close';Yes ($v.verified -eq $false -and $v.code -ceq 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED') 'fixture-outside-temp'
 # 6. Actual NTFS six-role M5-b outgoing leaves; legacy incoming five roles remains supported.
 $s=New-M5bFixture;$roots+=$s;$before=@{}
 foreach($folder in @('outgoing','incoming')){foreach($f in [IO.Directory]::GetFiles((Join-Path $s $folder))){$before[[IO.Path]::GetFileName($f)]=@{hash=Hash ([IO.File]::ReadAllBytes($f));acl=Canonical-Acl (Leaf-Acl $f)}}}
 $v=Run $s 'success-close';Yes ($v.verified -eq $true -and $v.moved -eq 5) ('m5b-six-and-five:'+($v|ConvertTo-Json -Compress))
 foreach($name in $before.Keys){$f=Join-Path (Join-Path $s $v.directory) $name;Yes ((Hash ([IO.File]::ReadAllBytes($f))) -ceq $before[$name].hash -and (Canonical-Acl (Leaf-Acl $f)) -ceq $before[$name].acl) ('m5b-full-acl-bytes-preserved:'+$name)}
 $receipt=Get-Content -LiteralPath (Join-Path (Join-Path $s $v.directory) 'archive-receipt.json') -Raw|ConvertFrom-Json;Yes (@($receipt.moved|Where-Object{$_.fileIdOwnerGroupAndEffectiveAccessPreserved -ne $true}).Count -eq 0) 'm5b-same-handle-identity-proved'
 # Every malformed six-entry role set refuses before the destination exists (zero moves).
 foreach($kind in @('unknown','operator-write','direction','resident-write','duplicate','deny','object','callback','flags')){
  $s=New-M5bFixture;$roots+=$s;$bad=$outAcl
  switch($kind){
   'unknown'{$bad=$bad.Replace($operator,$operator+'0')}
   'operator-write'{$bad=$bad.Replace('(A;;0x1200a9;;;'+$operator+')','(A;;0x1301bf;;;'+$operator+')')}
   'direction'{$bad=$bad.Replace('(A;;0x1301bf;;;'+$controller+')','(A;;0x1200a9;;;'+$controller+')').Replace('(A;;0x1200a9;;;'+$companion+')','(A;;0x1301bf;;;'+$companion+')')}
   'resident-write'{$bad=$bad.Replace('(A;;0x120089;;;'+$resident+')','(A;;0x1301bf;;;'+$resident+')')}
   'duplicate'{$bad=$bad.Replace('(A;;0x1200a9;;;'+$operator+')','(A;ID;0x1200a9;;;'+$companion+')')}
   'deny'{$bad=$bad.Replace('(A;;0x1200a9;;;'+$operator+')','(D;;0x1200a9;;;'+$operator+')')}
   'object'{$bad=$bad.Replace('(A;;0x1200a9;;;'+$operator+')','(OA;;0x1200a9;11111111-1111-1111-1111-111111111111;;'+$operator+')')}
   'callback'{$bad=$bad.Replace('(A;;0x1200a9;;;'+$operator+')','(XA;;0x1200a9;;;'+$operator+';(TRUE))')}
   'flags'{$bad=$bad.Replace('(A;;0x1200a9;;;'+$operator+')','(A;OI;0x1200a9;;;'+$operator+')')}
  }
  Set-LeafAcl (Join-Path $s 'outgoing\issue.json') $bad
  $actual=New-Object Security.AccessControl.RawSecurityDescriptor((Leaf-Acl (Join-Path $s 'outgoing\issue.json')));Yes ($actual.DiscretionaryAcl.Count -eq 6) ('six-role-fixture-retained:'+ $kind)
  Refuses-M5b $s ('m5b-'+$kind)
 }
 $s=New-M5bFixture;$roots+=$s;Set-LeafAcl (Join-Path $s 'incoming\result.json') ($inAcl.Replace('D:P','D:P(A;;0x1200a9;;;'+$operator+')'));Refuses-M5b $s 'incoming-six-not-added'
 foreach($kind in @('missing','bad-json','wrong-companion','array-companion','duplicate-key','escaped-duplicate-key','extra-field','record-write','record-link','parent-link')){
  $s=New-M5bFixture;$roots+=$s;$install=Join-Path (Split-Path -Parent $s) 'resident\install';$record=Join-Path $install 'companion-account.json'
  switch($kind){
   'missing'{[IO.File]::Delete($record)}
   'bad-json'{[IO.File]::WriteAllText($record,'{',$utf8)}
   'wrong-companion'{[IO.File]::WriteAllText($record,('{"contract":"clued.independent-ci.companion-account/1","companionSid":"'+$operator+'","operatorSid":"'+$companion+'"}'),$utf8)}
   'array-companion'{[IO.File]::WriteAllText($record,('{"contract":"clued.independent-ci.companion-account/1","companionSid":["'+$companion+'"],"operatorSid":"'+$operator+'"}'),$utf8)}
   'duplicate-key'{[IO.File]::WriteAllText($record,('{"contract":"clued.independent-ci.companion-account/1","companionSid":"'+$companion+'","operatorSid":"'+$operator+'","operatorSid":"'+$operator+'"}'),$utf8)}
   'escaped-duplicate-key'{[IO.File]::WriteAllText($record,('{"contract":"clued.independent-ci.companion-account/1","companionSid":"'+$companion+'","operatorSid":"'+$operator+'","operatorS\u0069d":"'+$operator+'"}'),$utf8)}
   'extra-field'{[IO.File]::WriteAllText($record,('{"contract":"clued.independent-ci.companion-account/1","companionSid":"'+$companion+'","operatorSid":"'+$operator+'","other":true}'),$utf8)}
   'record-write'{$acl=Get-Acl -LiteralPath $record;$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),'Write','Allow')));[IO.File]::SetAccessControl($record,$acl)}
   'record-link'{$copy=Join-Path $install 'copy.json';[IO.File]::Move($record,$copy);& cmd.exe /c mklink /H $record $copy|Out-Null}
   'parent-link'{$outside=Join-Path (Split-Path -Parent $s) 'metadata-elsewhere';[IO.Directory]::Move($install,$outside);& cmd.exe /c mklink /J $install $outside|Out-Null}
  }
  Refuses-M5b $s ('m5b-identity-'+$kind)
  if($kind -ceq 'parent-link'){[IO.Directory]::Delete($install)}
 }
 [pscustomobject]@{status='WINDOWS_SPOOL_ARCHIVE_OFFLINE_PASS';cases=$cases;hostRead=$false;hostWrite=$false}|ConvertTo-Json -Compress
}finally{foreach($r in $roots){try{$p=Split-Path -Parent $r;$j=Join-Path $r 'incoming';if((Get-Item -LiteralPath $j -Force -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($j)};Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue}catch{}}}
