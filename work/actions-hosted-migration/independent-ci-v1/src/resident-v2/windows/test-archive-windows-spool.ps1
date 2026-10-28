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
 [pscustomobject]@{status='WINDOWS_SPOOL_ARCHIVE_OFFLINE_PASS';cases=$cases;hostRead=$false;hostWrite=$false}|ConvertTo-Json -Compress
}finally{foreach($r in $roots){try{$p=Split-Path -Parent $r;$j=Join-Path $r 'incoming';if((Get-Item -LiteralPath $j -Force -ErrorAction SilentlyContinue).Attributes -band [IO.FileAttributes]::ReparsePoint){[IO.Directory]::Delete($j)};Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue}catch{}}}
