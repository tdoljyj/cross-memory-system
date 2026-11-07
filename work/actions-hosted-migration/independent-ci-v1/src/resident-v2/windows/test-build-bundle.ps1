# Offline test of resident-v2/build-bundle.ps1 functions (no network beyond loopback, no ProgramData). The script's
# main block is never run: functions are taken from its AST, exactly like batch/test-pure.ps1 does.
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$tool=Join-Path (Split-Path -Parent $PSScriptRoot) 'build-bundle.ps1';$cases=0
function Yes([bool]$v,[string]$what){if(-not $v){throw ('BUNDLE_TEST_FAILED:'+$what)};$script:cases++}
function Refuse([scriptblock]$f,[string]$what){$no=$false;try{& $f}catch{$no=$true};Yes $no $what}
function Refused-With([scriptblock]$f,[string]$code,[string]$what){$got=$null;try{& $f}catch{$got=$_.Exception.Message};Yes ($got -ceq $code) ($what+':'+$got)}
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($tool,[ref]$t,[ref]$e);if($e.Count){throw 'BUILD_BUNDLE_PARSE_FAILED'}
$ReviewedPrefix='refs/reviewed/';$TestPrefix='refs/clued-test/'
foreach($name in @('Utc','Hash-Bytes','Hash-Text','Absent','Quote-Arg','Invoke-Git','Assert-FormalRefName','New-RefMap','Split-Refs','Ref-Map','Same-Map','Ref-List-Sha','Reviewed-Map','Reviewed-Commits','Bundle-Header',
  'Ref-Diff','Ref-Target-Types','Ref-Type-Allowed','Build-Store','Retry-Allowed','Race-Retry-Allowed','Fetch-Store','Branch-Only-Hint','Move-FailedGen2',
  'Remove-Tree','Test-RealDir','Seed-Lock','Seed-Unlock','Seed-Shape-Problem','Seed-Discard','Seed-Meta-Read','Unix-Now','Seed-Wanted','Seed-Begin','Seed-Prime','Seed-Drop-Refs','Seed-Failure','Seed-Error-Text','Seed-Bytes','Seed-Update',
  'Seed-Meta-Object','Seed-Meta-Failure-At','Seed-Note-Network-Failure','Seed-After-Network-Failure','Network-Step-Failed','Chain-Of','Chain-Ok','Split-Pull-Heads','Read-Descriptor')){
 $f=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});if($f.Count -ne 1){throw ('FUNCTION_MISSING:'+$name)};. ([scriptblock]::Create($f[0].Extent.Text))
}
# The fixed values exactly as the script assigns them.
foreach($name in @('Common','NetworkSteps','RetryWithinSeconds','MaxStoreAttempts','ChainContract','ChainMembersMax','SeedNs','SeedMetaContract','SeedMinFullFetchSeconds','SeedConfigKeys','seedUse','seedAttempt','seedBusy','seedLockHeld','seedAvailable','seedReport','SeedAfterNetworkFailureSeconds')){
 $s=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq ('$'+$name)});if($s.Count -ne 1){throw ('ASSIGNMENT_MISSING:'+$name)};. ([scriptblock]::Create($s[0].Extent.Text))
}
$FixedCommon=[string[]]$Common
$a='a'*40;$b='b'*40
# ls-remote text (tab separated, peeled lines skipped) and for-each-ref text (space separated) give one map
$ls="$a`trefs/heads/main`n$b`trefs/tags/v1`n$a`trefs/tags/v1^{}`n"
$m=Ref-Map $ls "`t" $true;Yes ($m.Count -eq 2 -and $m['refs/heads/main'] -ceq $a) 'ls-remote-map'
$fe=Ref-Map "$a refs/heads/main`n$b refs/tags/v1`n" ' ' $false;Yes (Same-Map $m $fe) 'same-map'
# the canonical list hash shared with prepare-workspaces.py#ref_list_sha
Yes ((Ref-List-Sha $m) -ceq (Hash-Text "$a refs/heads/main`n$b refs/tags/v1`n")) 'ref-list-sha'
Refuse {Ref-Map "$a`trefs/pull/1/head`n" "`t" $true} 'non-formal-ref'
Refuse {Ref-Map "$a`trefs/heads/x.lock`n" "`t" $true} 'lock-ref'
Refuse {Split-Refs "$a refs/reviewed/$b`n$a refs/heads/main`n" ' ' $false $true} 'reviewed-ref-must-name-its-sha'
# step 3c-2: the tested commit S of a train front batch, at most one ref, named by its own SHA, only where reviewed refs are
$sp=Split-Refs "$a refs/heads/main`n$b refs/clued-test/$b`n" ' ' $false $true;Yes ($sp.test.Count -eq 1 -and $sp.test["refs/clued-test/$b"] -ceq $b -and $sp.formal.Count -eq 1) 'test-ref'
Refused-With {Split-Refs "$a refs/heads/main`n$a refs/clued-test/$b`n" ' ' $false $true} 'EXACT_TEST_REF_REQUIRED' 'test-ref-must-name-its-sha'
Refused-With {Split-Refs "$a refs/heads/main`n$a refs/clued-test/$a`n$b refs/clued-test/$b`n" ' ' $false $true} 'EXACT_TEST_REF_REQUIRED' 'one-test-ref'
Refuse {Ref-Map "$b`trefs/clued-test/$b`n$a`trefs/heads/main`n" "`t" $true} 'test-ref-never-from-ls-remote'
# the receipt's test-ref list hash is prepare-workspaces.py#ref_list_sha's: sha256 of '' for S = H
Yes ((Ref-List-Sha (New-RefMap)) -ceq 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') 'empty-test-ref-list-sha'
# reviewed records: exact count line, unique fingerprints, commits derived and sorted
$toml="# clued-reviewed-count: 2`n# clued-reviewed-finding: {`"fingerprint`":`"$($b):x:rule:1`",`"kinds`":[`"K`"]}`n# clued-reviewed-finding: {`"fingerprint`":`"$($a):y:rule:2`",`"kinds`":[`"K`"]}`n[allowlist]`n"
$r=Reviewed-Commits $toml;Yes ($r.findings -eq 2 -and @($r.commits).Count -eq 2 -and $r.commits[0] -ceq $a -and $r.sha256 -ceq (Hash-Text "$a`n$b`n")) 'reviewed-commits'
Refuse {Reviewed-Commits ($toml.Replace('count: 2','count: 3'))} 'reviewed-count-mismatch'
Refuse {Reviewed-Commits ($toml+"# clued-reviewed-finding: {`"fingerprint`":`"$($b):x:rule:1`",`"kinds`":[`"K`"]}`n")} 'reviewed-duplicate'
# DESIGN §67: descriptor /4's own shape (the twin of prepare-workspaces.py#chain_members_ok) and the chain walk over a reader
$h1='1'*40;$h2='2'*40;$h3='3'*40;$tS='4'*40;$tT='5'*40;$tTree='6'*40
function Desc4($o){$d=[ordered]@{contract=$ChainContract;pr=901;headSha=$h1;baseSha=$tT;testSha=$tS;testTree=$tTree;members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$h2},[ordered]@{pr=903;headSha=$h3})};foreach($k in $o.Keys){$d[$k]=$o[$k]};return (($d|ConvertTo-Json -Depth 5 -Compress)|ConvertFrom-Json)}
$ch=Chain-Of (Desc4 @{});Yes ($ch.members.Count -eq 3 -and $ch.members[2].pr -eq 903 -and $ch.members[0].headSha -ceq $h1 -and $ch.testTree -ceq $tTree) 'chain-of'
Yes ($ChainContract -ceq 'clued.independent-ci.resident-batch-descriptor/4' -and $ChainMembersMax -eq 4) 'chain-contract'
foreach($bad in @(@{members=@([ordered]@{pr=901;headSha=$h1})},@{members=@([ordered]@{pr=902;headSha=$h2},[ordered]@{pr=901;headSha=$h1})},@{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=901;headSha=$h2})},
  @{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$h1})},@{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$tS})},@{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$tT})},
  @{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$h2;claimId='x'})},@{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=$true;headSha=$h2})},@{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr='902';headSha=$h2})},
  @{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$h2},[ordered]@{pr=903;headSha=$h3},[ordered]@{pr=904;headSha=('7'*40)},[ordered]@{pr=905;headSha=('8'*40)})},
  @{testTree='z'*40},@{testTree=$null},@{members=$null},@{testSha=$tT})){Refused-With {Chain-Of (Desc4 $bad)} 'BATCH_CHAIN_DESCRIPTOR_REFUSED' ('chain-of-refused:'+(($bad|ConvertTo-Json -Compress -Depth 4)))}
$lines=@{};$lines[$tS]="$tS $('9'*40) $h3";$lines['9'*40]="$('9'*40) $('a'*40) $h2";$lines['a'*40]="$('a'*40) $tT $h1"
$reader={param($c) $lines[$c]}
Yes (Chain-Ok $reader $ch $tS $tT) 'chain-ok'
Yes (-not (Chain-Ok $reader $ch $tS ('b'*40))) 'chain-other-base'
$sw=@{};foreach($k in $lines.Keys){$sw[$k]=$lines[$k]};$sw['9'*40]="$('9'*40) $h2 $('a'*40)";Yes (-not (Chain-Ok {param($c) $sw[$c]} $ch $tS $tT)) 'chain-swapped-parents'
$oc=@{};foreach($k in $lines.Keys){$oc[$k]=$lines[$k]};$oc[$tS]="$tS $('9'*40) $h3 $('c'*40)";Yes (-not (Chain-Ok {param($c) $oc[$c]} $ch $tS $tT)) 'chain-octopus'
$two=Chain-Of (Desc4 @{members=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=903;headSha=$h3})});Yes (-not (Chain-Ok $reader $two $tS $tT)) 'chain-fewer-members'
$want=[string[]]@('refs/pull/901/head','refs/pull/902/head')
$pl=Split-Pull-Heads "$h1`trefs/pull/901/head`n$h2`trefs/pull/902/head`n" $want;Yes ($pl.Count -eq 2 -and $pl['refs/pull/902/head'] -ceq $h2) 'pull-heads'
# a branch whose name ends like a pull ref (ls-remote matches from the tail) and refs not asked for are skipped, never taken
$pl=Split-Pull-Heads "$h3`trefs/heads/refs/pull/901/head`n$h1`trefs/pull/901/head`n$h3`trefs/pull/901/merge`n$h3`trefs/pull/903/head`n" $want
Yes ($pl.Count -eq 1 -and $pl['refs/pull/901/head'] -ceq $h1) 'pull-heads-only-the-names-asked-for'
foreach($bad in @("$h1`trefs/pull/901/head`n$h2`trefs/pull/901/head`n","x`trefs/pull/901/head`n","$h1 refs/pull/901/head`n")){Refused-With {Split-Pull-Heads $bad $want} 'EXACT_REF_LINE_REQUIRED' ('pull-heads-refused:'+$bad)}
# Read-Descriptor: /3 unchanged (and never with members or a tree), /4 only with its shape
$rdDir=Join-Path ([IO.Path]::GetTempPath()) ('rd4-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($rdDir)
try{
 $BatchId='0123456789abcdef-0123456789ab';$Descriptor=Join-Path $rdDir 'descriptor.json'
 $base3=[ordered]@{contract='clued.independent-ci.resident-batch-descriptor/3';batchId=$BatchId;repo='tdoljyj/cross-memory-system';pr=901;headSha=$h1;testSha=$tS;baseSha=$tT;sourceCommit=$tT;gitleaksTomlSha256=('e'*64)}
 function Put-Desc($o){$d=[ordered]@{};foreach($k in $base3.Keys){$d[$k]=$base3[$k]};foreach($k in $o.Keys){$d[$k]=$o[$k]};[IO.File]::WriteAllText($Descriptor,($d|ConvertTo-Json -Depth 5 -Compress))}
 Put-Desc @{};$rd=Read-Descriptor;Yes ($null -eq $rd.chain -and $rd.value.testSha -ceq $tS) 'read-descriptor-3'
 $m4=@([ordered]@{pr=901;headSha=$h1},[ordered]@{pr=902;headSha=$h2})
 Put-Desc @{contract=$ChainContract;testTree=$tTree;members=$m4};$rd=Read-Descriptor;Yes ($rd.chain.members.Count -eq 2 -and $rd.chain.testTree -ceq $tTree) 'read-descriptor-4'
 Put-Desc @{members=$m4};Refused-With {Read-Descriptor} 'DESCRIPTOR_REFUSED' 'descriptor-3-never-with-members'
 Put-Desc @{testTree=$tTree};Refused-With {Read-Descriptor} 'DESCRIPTOR_REFUSED' 'descriptor-3-never-with-tree'
 Put-Desc @{contract=$ChainContract;members=$m4};Refused-With {Read-Descriptor} 'BATCH_CHAIN_DESCRIPTOR_REFUSED' 'descriptor-4-needs-tree'
 Put-Desc @{contract='clued.independent-ci.resident-batch-descriptor/5';testTree=$tTree;members=$m4};Refused-With {Read-Descriptor} 'DESCRIPTOR_REFUSED' 'descriptor-5-refused'
}finally{[IO.Directory]::Delete($rdDir,$true)}
# The branch-only hint (Decision 98fec682): its table is empty since PR #991 brought d94cd486 into main, so no step gives one.
$d94='d94cd486e29a7362888fc32cd807ceb38890acb6'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'GIT_STEP_FAILED' @($a,$d94,$b))) 'no-hint-after-991-fetch'
Yes ($null -eq (Branch-Only-Hint 'reviewed-store-readback' 'REVIEWED_COMMIT_NOT_IN_STORE' @($d94))) 'no-hint-after-991-readback'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'GIT_STEP_FAILED' @($a,$b))) 'no-hint-without-the-commit'
Yes ($null -eq (Branch-Only-Hint 'fetch-all-heads-and-tags' 'GIT_STEP_FAILED' @($d94))) 'no-hint-at-another-stage'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'REMOTE_MAIN_BASE_CHANGED' @($d94))) 'no-hint-for-another-reason'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'GIT_STEP_FAILED' @())) 'no-hint-for-an-empty-set'
# Generation 13 (DESIGN 57.3): a gen-2\ without its receipt is renamed to the first free gen-2-failed-<n>\ (at most 3); a complete
# gen-2\ or none is left alone; a link in its place is refused.
$mf=Join-Path ([IO.Path]::GetTempPath()) ('mfg2-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($mf)
try{
 $Gen1Root=$mf;$Gen2Name='gen-2';$Gen2FailedMax=3;$Gen2Root=Join-Path $mf 'gen-2';$Gen2Receipt=Join-Path $Gen2Root 'all-refs.receipt.json'
 Yes ($null -eq (Move-FailedGen2)) 'no-gen-2-nothing-moved'
 foreach($n in 1..3){[void][IO.Directory]::CreateDirectory($Gen2Root);Yes ((Move-FailedGen2) -ceq "gen-2-failed-$n") "failed-gen-2-moved-$n";Yes (-not (Test-Path -LiteralPath $Gen2Root)) "gen-2-gone-$n"}
 [void][IO.Directory]::CreateDirectory($Gen2Root);Refused-With {Move-FailedGen2} 'REBUNDLE_FAILED_GENERATIONS_EXHAUSTED' 'failed-generations-bounded'
 [IO.File]::WriteAllText($Gen2Receipt,'{}');Yes ($null -eq (Move-FailedGen2)) 'complete-gen-2-left-alone';Yes (Test-Path -LiteralPath $Gen2Receipt) 'complete-gen-2-kept'
 # a link (junction) or a file where gen-2\ belongs is refused, never renamed or followed (review round 1, MINOR 5)
 $lk=Join-Path $mf 'links';[void][IO.Directory]::CreateDirectory($lk);$Gen1Root=$lk;$Gen2Root=Join-Path $lk 'gen-2';$Gen2Receipt=Join-Path $Gen2Root 'all-refs.receipt.json'
 $target=Join-Path $mf 'elsewhere';[void][IO.Directory]::CreateDirectory($target)
 [void](New-Item -ItemType Junction -Path $Gen2Root -Target $target)
 Refused-With {Move-FailedGen2} 'FIXED_REAL_BUNDLE_ROOT_REQUIRED' 'junction-gen-2-refused';Yes ((Test-Path -LiteralPath $Gen2Root) -and -not (Test-Path -LiteralPath (Join-Path $lk 'gen-2-failed-1'))) 'junction-gen-2-left-in-place'
 [IO.Directory]::Delete($Gen2Root);[IO.File]::WriteAllText($Gen2Root,'x')
 Refused-With {Move-FailedGen2} 'FIXED_REAL_BUNDLE_ROOT_REQUIRED' 'file-gen-2-refused'
}finally{[IO.Directory]::Delete($mf,$true)}
# Stalled transfers (lesson #916): every git call carries the low-speed abort, and only an early network failure is retried.
$i=[Array]::IndexOf($FixedCommon,'http.lowSpeedLimit=1000');Yes ($i -gt 0 -and $FixedCommon[$i-1] -ceq '-c') 'common-low-speed-limit'
$i=[Array]::IndexOf($FixedCommon,'http.lowSpeedTime=300');Yes ($i -gt 0 -and $FixedCommon[$i-1] -ceq '-c') 'common-low-speed-time'
Yes ((@($NetworkSteps)-join '|') -ceq 'fetch|ls-remote|fetch-reviewed|fetch-test|ls-remote-members' -and $RetryWithinSeconds -eq 900 -and $MaxStoreAttempts -eq 3) 'retry-constants'
function Step([string]$l,[int]$x){return [ordered]@{label=$l;exitCode=$x;stderrChars=1}}
foreach($l in @('fetch','ls-remote','fetch-reviewed','fetch-test','ls-remote-members')){Yes (Retry-Allowed 'GIT_STEP_FAILED' (Step $l 128) 61) ('retry-'+$l)}
Yes (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 128) 899.9) 'retry-just-in-time'
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 128) 900)) 'no-retry-too-late'
foreach($l in @('init-bare','cat-file','source-gitleaks-toml','reviewed-closure','for-each-ref','test-cat-file','test-parents','test-tree','member-cat-file','for-each-ref-3')){Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step $l 128) 61)) ('no-retry-'+$l)}
foreach($r in @('REMOTE_MAIN_BASE_CHANGED','FETCHED_REFS_DIFFER_FROM_LS_REMOTE','GIT_START_UNCONFIRMED','FIXED_BUNDLE_BUILD_UNCONFIRMED')){Yes (-not (Retry-Allowed $r (Step 'fetch' 128) 61)) ('no-retry-'+$r)}
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' $null 61)) 'no-retry-without-step'
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 0) 61)) 'no-retry-exit-0'
# Refs pushed between the fetch and the ls-remote: only that inconsistency (recorded by Build-Store), only in the window
$d0=Ref-Diff (Ref-Map "$a`trefs/heads/main`n$b`trefs/tags/v1`n" "`t" $true) (Ref-Map "$a`trefs/heads/main`n$a`trefs/tags/v1`n$b`trefs/heads/new`n" "`t" $true)
Yes ($d0.count -eq 2 -and (@($d0.refs)-join '|') -ceq 'refs/heads/new|refs/tags/v1') 'ref-diff-changed-and-added'
Yes ((Ref-Diff (Ref-Map "$a`trefs/heads/main`n" "`t" $true) (New-RefMap)).count -eq 1) 'ref-diff-removed'
$many=New-RefMap;foreach($x in 1..12){$many['refs/heads/b'+('{0:d2}' -f $x)]=$a};$d1=Ref-Diff $many (New-RefMap);Yes ($d1.count -eq 12 -and @($d1.refs).Count -eq 8 -and $d1.refs[0] -ceq 'refs/heads/b01') 'ref-diff-capped'
Yes ((Ref-Diff $m $m).count -eq 0) 'ref-diff-equal'
Yes (Race-Retry-Allowed 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' $d0 61) 'race-retry'
Yes (Race-Retry-Allowed 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' $d0 899.9) 'race-retry-just-in-time'
Yes (-not (Race-Retry-Allowed 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' $d0 900)) 'no-race-retry-too-late'
Yes (-not (Race-Retry-Allowed 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' $null 61)) 'no-race-retry-unrecorded'
foreach($r in @('REMOTE_MAIN_BASE_CHANGED','GIT_STEP_FAILED','EXACT_REVIEWED_REF_SET_REQUIRED','HEAD_BASE_SOURCE_COMMIT_MISSING')){Yes (-not (Race-Retry-Allowed $r $d0 61)) ('no-race-retry-'+$r)}
# a real v2 bundle from a throwaway local repository
$git=(Get-Command git -ErrorAction SilentlyContinue)
if($git){
 $tmp=Join-Path ([IO.Path]::GetTempPath()) ('clued-bundle-'+[Guid]::NewGuid().ToString('N').Substring(0,8));[void][IO.Directory]::CreateDirectory($tmp)
 $listener=$null
 try{
  $env:GIT_CONFIG_GLOBAL='NUL';$env:GIT_CONFIG_NOSYSTEM='1'
  & git -C $tmp init -q -b main;[IO.File]::WriteAllText((Join-Path $tmp 'a.txt'),"a`n");& git -C $tmp add a.txt;& git -C $tmp -c user.name=f -c user.email=f@f commit -q -m a
  $h=(& git -C $tmp rev-parse HEAD).Trim();& git -C $tmp tag v1;& git -C $tmp update-ref ("refs/reviewed/"+$h) $h
  $bundle=Join-Path $tmp 'all.bundle';& git -C $tmp bundle create --quiet --version=2 $bundle --branches --tags '--glob=refs/reviewed/*'
  $hdr=Bundle-Header $bundle;Yes ($hdr.formal.Count -eq 2 -and $hdr.reviewed.Count -eq 1 -and $hdr.reviewed[("refs/reviewed/"+$h)] -ceq $h) 'bundle-header'

  # The store end to end with the script's own Invoke-Git, Build-Store and Fetch-Store against a local "remote":
  # c0 <- c1 (main, the Source commit) <- c2 (feature, the head), tag v1 -> c0. c1's .gitleaks.toml names cR as reviewed:
  # a commit no ref reaches any more, like the rewritten history it stands for (a reachable one would already be in the
  # store after the first fetch, and git does not contact the remote for an object it has).
  $src=Join-Path $tmp 'src';& git init -q -b main $src
  $g={& git -C $src -c user.name=f -c user.email=f@f @args}
  [IO.File]::WriteAllText((Join-Path $src 'a.txt'),"a`n");& $g add a.txt;& $g commit -q -m c0;$c0=(& $g rev-parse HEAD).Trim()
  & $g checkout -q -b old;[IO.File]::WriteAllText((Join-Path $src 'r.txt'),"r`n");& $g add r.txt;& $g commit -q -m cR;$cR=(& $g rev-parse HEAD).Trim();& $g checkout -q main;& $g branch -q -D old
  $toml="# clued-reviewed-count: 1`n# clued-reviewed-finding: {`"fingerprint`":`"$($cR):r.txt:rule:1`",`"kinds`":[`"K`"]}`n"
  [IO.File]::WriteAllText((Join-Path $src '.gitleaks.toml'),$toml);& $g add .gitleaks.toml;& $g commit -q -m c1;$c1=(& $g rev-parse HEAD).Trim()
  & $g checkout -q -b feature;[IO.File]::WriteAllText((Join-Path $src 'b.txt'),"b`n");& $g add b.txt;& $g commit -q -m c2;$c2=(& $g rev-parse HEAD).Trim();& $g checkout -q main
  & $g tag -a v1 -m v1 $c0
  # step 3c-2: S, the test merge of [main c1, head c2] (GitHub keeps it under refs/pull/<n>/merge), and a merge of the same
  # two commits in the other order; no branch or tag reaches either, so only a fetch by SHA brings them
  & $g checkout -q --detach $c1;& $g merge -q --no-ff -m S $c2;$cS=(& $g rev-parse HEAD).Trim();& $g update-ref refs/pull/1/merge $cS
  # W: S's tree with the parents swapped, [H, T] (c1 is an ancestor of c2, so a merge would only fast-forward)
  $cW=(& $g commit-tree -p $c2 -p $c1 -m W ((& $g rev-parse "$cS^{tree}").Trim())).Trim();& $g checkout -q main
  $expected=Ref-Map ((& git ls-remote --branches --tags $src)-join "`n") "`t" $true
  Yes ($expected.Count -eq 3) 'store-fixture'
  # A listener that accepts connections (the kernel completes them) and never answers: a transfer that makes no progress.
  $listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0);$listener.Start();$stallUrl='http://127.0.0.1:'+$listener.LocalEndpoint.Port+'/stalled.git'
  $Git=$git.Source;$Url='file:///'+($src -replace '\\','/');$desc=[pscustomobject]@{value=[pscustomobject]@{sourceCommit=$c1;gitleaksTomlSha256=(Hash-Text $toml)}}
  # The fixed options, plus what the fixture needs: a file:// remote, the plain-http listener without the host's proxy,
  # and a 2-second low-speed window so a stall costs 2 s here instead of 60.
  $Common=$FixedCommon+@('-c','protocol.file.allow=always','-c','protocol.http.allow=always','-c','http.proxy=','-c','http.lowSpeedTime=2')
  $realGit=${function:Invoke-Git}
  # Sends the next $stalls[label] calls of that step to the silent listener; before a stalled fetch it leaves what a
  # broken transfer could: a partial pack and a stray ref in that attempt's repository.
  function Invoke-Git([string]$Label,[string[]]$GitArgs,[string]$InputText=''){
   $script:calls+=$Label
   if($script:stalls.ContainsKey($Label) -and $script:stalls[$Label] -gt 0){
    $script:stalls[$Label]--
    $dir=@($GitArgs|Where-Object{$_.StartsWith('--git-dir=')})[0].Substring(10)
    [IO.File]::WriteAllBytes((Join-Path $dir 'objects\pack\tmp_pack_planted'),[byte[]](1,2,3));[IO.File]::WriteAllText((Join-Path $dir 'refs\heads\zz-planted'),$c0+"`n")
    $GitArgs=@($GitArgs|ForEach-Object{if($_ -ceq $Url){$stallUrl}else{$_}})
   }
   if($Label -ceq 'ls-remote' -and $script:races -gt 0){
    # a push between the fetch and the ls-remote: GitHub answers with a branch the fetch did not see
    $script:races--;return ((& $realGit $Label $GitArgs)+"`n$c0`trefs/heads/raced`n")
   }
   if($Label -ceq 'fetch-reviewed' -and $script:lateRaces -gt 0){
    # the same push, after the first check: a branch appears in the store while the reviewed commits are fetched
    $script:lateRaces--;$dir=@($GitArgs|Where-Object{$_.StartsWith('--git-dir=')})[0].Substring(10)
    [IO.File]::WriteAllText((Join-Path $dir 'refs\heads\zz-late'),$c0+"`n")
   }
   return (& $realGit $Label $GitArgs $InputText)
  }
  function New-Case([hashtable]$Stalls,$Elapsed){
   $script:races=0;$script:lateRaces=0;$script:refsDiffer=$null;$script:FetchDir3=$null
   $script:Root=Join-Path $tmp ('bundles\'+[Guid]::NewGuid().ToString('N').Substring(0,8));[void][IO.Directory]::CreateDirectory($script:Root)
   $script:FetchDir=Join-Path $script:Root 'fetch.git';$script:FetchDir2=Join-Path $script:Root 'fetch-2.git';$script:FetchDir3=Join-Path $script:Root 'fetch-3.git'
   $script:stalls=$Stalls;$script:calls=@();$script:created=@();$script:lastGit=$null;$script:stage='x';$script:attempts=1;$script:firstAttempt=$null;$script:failedAttempts=@()
   $script:Head=$c2;$script:Base=$c1;$script:Test=$c2;$script:Chain=$null
   $script:seedUse=$false;$script:seedAttempt=$false;$script:seedBusy=$false;$script:seedLockHeld=$false;$script:seedAvailable=$false;$script:seedReport=[ordered]@{enabled=$true;used=$false;reason=$null;discarded=$false;primeSeconds=$null;updated=$false;updateSkipped=$null;seedBytes=$null;error=$null;networkFailureNoted=$false}
   $script:Clock=if($null -eq $Elapsed){[Diagnostics.Stopwatch]::StartNew()}else{[pscustomobject]@{Elapsed=[TimeSpan]::FromSeconds($Elapsed)}}
  }
  function Fetches{return @($script:calls|Where-Object{$_ -ceq 'fetch'}).Count}

  # 1. the full fetch stalls: git itself gives up after the low-speed window, the second attempt builds a fresh store
  New-Case @{fetch=1} $null;$sw=[Diagnostics.Stopwatch]::StartNew();$s=Fetch-Store;$took=$sw.Elapsed.TotalSeconds
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and (Fetches) -eq 2) 'retry-fresh-store'
  Yes ($firstAttempt.stage -ceq 'fetch-all-heads-and-tags' -and $firstAttempt.git.label -ceq 'fetch' -and $firstAttempt.git.exitCode -ne 0) 'retry-first-attempt-recorded'
  Yes ($took -lt 30) ('stall-ends-in-seconds:'+[int]$took)
  Yes ((Test-Path -LiteralPath (Join-Path $FetchDir 'refs\heads\zz-planted')) -and (Test-Path -LiteralPath (Join-Path $FetchDir 'objects\pack\tmp_pack_planted'))) 'first-attempt-left-as-is'
  Yes (-not (Test-Path -LiteralPath (Join-Path $FetchDir2 'refs\heads\zz-planted'))) 'second-attempt-never-reads-first'
  Yes ((Same-Map $s.remote $expected) -and $s.expectedReviewed.Count -eq 1 -and $s.expectedReviewed[$ReviewedPrefix+$cR] -ceq $cR -and (@($s.branchesAtHead)-join '|') -ceq 'refs/heads/feature') 'retry-store-checked'
  Yes ((@($created)-join '|') -ceq ($FetchDir+'|'+$FetchDir2)) 'retry-created'
  # the main block's next steps work on the second store: bundle, header == ls-remote, reviewed refs exact
  $null=Invoke-Git 'bundle-create' ($Common+@($s.gd,'bundle','create','--quiet','--version=2',(Join-Path $Root 'all-refs.bundle'),'--branches','--tags','--glob=refs/reviewed/*'))
  $hdr=Bundle-Header (Join-Path $Root 'all-refs.bundle');Yes ((Same-Map $hdr.formal $expected) -and (Same-Map $hdr.reviewed $s.expectedReviewed)) 'retry-bundle'
  # 2. the reviewed fetch stalls: the whole store is built again, not just that step
  New-Case @{'fetch-reviewed'=1} $null;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and (Fetches) -eq 2 -and $firstAttempt.stage -ceq 'fetch-reviewed-commits-by-sha') 'retry-reviewed-fetch'
  # 3. no stall: one attempt, nothing else created
  New-Case @{} $null;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir -and $attempts -eq 1 -and $null -eq $firstAttempt -and @($failedAttempts).Count -eq 0 -and -not (Test-Path -LiteralPath $FetchDir2) -and (Same-Map $s.remote $expected)) 'no-stall-one-attempt'
  # 3b. CI Source round-trip trim (PR #1029 batches: 405 refs, one cat-file -t process each, 12-17 s): the ref target types come
  # from one cat-file --batch-check; head and base keep their own two checks. Same store, same verdicts.
  function Cat-Files{return @($script:calls|Where-Object{$_ -ceq 'cat-file'}).Count}
  function Ref-Types{return @($script:calls|Where-Object{$_ -ceq 'ref-types'}).Count}
  Yes ((Ref-Types) -eq 1 -and (Cat-Files) -eq 2) ('ref-types-one-process:'+(Ref-Types)+'/'+(Cat-Files))
  $extra=@();foreach($n in 1..40){$extra+="refs/heads/many-$n"};foreach($n in 1..20){$extra+="refs/tags/many-$n"}
  try{
   foreach($r in $extra){& $g update-ref $r $c0}
   $many=Ref-Map ((& git ls-remote --branches --tags $src)-join "`n") "`t" $true;Yes ($many.Count -eq 63) 'many-refs-fixture'
   New-Case @{} $null;$s=Fetch-Store
   Yes ((Same-Map $s.remote $many) -and $attempts -eq 1 -and (Ref-Types) -eq 1 -and (Cat-Files) -eq 2) ('many-refs-one-process:'+(Ref-Types)+'/'+(Cat-Files))
   # the batch answer itself: one type per distinct target; a missing object (or an empty map) gives no answer at all
   $tm=Ref-Target-Types $s.gd $s.remote;Yes ($null -ne $tm -and $tm.Count -eq 4 -and $tm[$c0] -ceq 'commit' -and $tm[$c1] -ceq 'commit' -and $tm[$c2] -ceq 'commit') 'ref-types-answer'
   $miss=New-RefMap;$miss['refs/heads/main']=$c1;$miss['refs/heads/gone']='f'*40;Yes ($null -eq (Ref-Target-Types $s.gd $miss)) 'ref-types-missing-no-answer'
   Yes ($null -eq (Ref-Target-Types $s.gd (New-RefMap))) 'ref-types-empty-no-answer'
   Yes ((Ref-Type-Allowed 'refs/heads/x' 'commit') -and -not (Ref-Type-Allowed 'refs/heads/x' 'tag') -and (Ref-Type-Allowed 'refs/tags/x' 'tag') -and -not (Ref-Type-Allowed 'refs/tags/x' 'blob')) 'ref-type-allowed'
   # a ref the store must refuse: the per-ref loop decides, so the code and the failed step are exactly the old ones
   $blob=(& $g rev-parse "$($c0):a.txt").Trim();& $g update-ref refs/tags/many-blob $blob
   New-Case @{} $null
   Refused-With {Fetch-Store} 'REMOTE_REF_TARGET_TYPE_UNSUPPORTED' 'blob-tag-refused'
   Yes ($attempts -eq 1 -and (Ref-Types) -eq 1 -and (Cat-Files) -gt 2 -and $lastGit.label -ceq 'cat-file' -and $stage -ceq 'fetched-store-readback') ('blob-tag-old-loop-decides:'+(Cat-Files))
  }finally{foreach($r in $extra+@('refs/tags/many-blob')){& $g show-ref --verify --quiet $r;if($LASTEXITCODE -eq 0){& $g update-ref -d $r}}}
  Yes ((Ref-Map ((& git ls-remote --branches --tags $src)-join "`n") "`t" $true).Count -eq 3) 'many-refs-removed'
  # 4. both attempts stall: the second failure is the answer, never a third attempt
  New-Case @{fetch=2} $null
  Refused-With {Fetch-Store} 'GIT_STEP_FAILED' 'second-failure-final'
  Yes ($attempts -eq 2 -and (Fetches) -eq 2 -and $stage -ceq 'fetch-all-heads-and-tags' -and $lastGit.label -ceq 'fetch') 'never-a-third-attempt'
  # 5. a stall after the retry window: no second attempt
  New-Case @{fetch=1} 900
  Refused-With {Fetch-Store} 'GIT_STEP_FAILED' 'late-failure-final'
  Yes ($attempts -eq 1 -and $null -eq $firstAttempt -and -not (Test-Path -LiteralPath $FetchDir2)) 'late-failure-not-retried'
  # 6. a refusal of the script's own checks is never retried (here: main is not the descriptor's base)
  New-Case @{} $null;$Base=$c2
  Refused-With {Fetch-Store} 'REMOTE_MAIN_BASE_CHANGED' 'refusal-final'
  Yes ($attempts -eq 1 -and -not (Test-Path -LiteralPath $FetchDir2)) 'refusal-not-retried'
  # 6b. step 3c-2, a train front batch: S fetched by SHA under refs/clued-test/<S>, its parents exactly [T, H]
  New-Case @{} $null;$Test=$cS;$s=Fetch-Store
  Yes ($attempts -eq 1 -and $s.expectedTest.Count -eq 1 -and $s.expectedTest[$TestPrefix+$cS] -ceq $cS -and (Same-Map $s.remote $expected)) 'front-store'
  Yes (@($calls|Where-Object{$_ -ceq 'fetch-test'}).Count -eq 1 -and (@($s.branchesAtHead)-join '|') -ceq 'refs/heads/feature') 'front-fetch-test'
  $fb=Join-Path $Root 'all-refs.bundle';$null=Invoke-Git 'bundle-create' ($Common+@($s.gd,'bundle','create','--quiet','--version=2',$fb,'--branches','--tags','--glob=refs/reviewed/*','--glob=refs/clued-test/*'))
  $hdr=Bundle-Header $fb;Yes ((Same-Map $hdr.formal $expected) -and (Same-Map $hdr.reviewed $s.expectedReviewed) -and (Same-Map $hdr.test $s.expectedTest)) 'front-bundle'
  # S = H: no test ref anywhere, the same glob adds nothing
  New-Case @{} $null;$s=Fetch-Store
  Yes ($s.expectedTest.Count -eq 0 -and @($calls|Where-Object{$_ -ceq 'fetch-test'}).Count -eq 0) 'head-batch-no-test-ref'
  # parents in the other order, or S that is the head's own parent chain: refused, never retried
  New-Case @{} $null;$Test=$cW
  Refused-With {Fetch-Store} 'TEST_COMMIT_PARENTS_REQUIRED' 'front-parents-order';Yes ($attempts -eq 1) 'front-parents-not-retried'
  New-Case @{} $null;$Test=$c0
  Refused-With {Fetch-Store} 'TEST_COMMIT_PARENTS_REQUIRED' 'front-not-a-merge'
  # the S fetch stalls: the whole store is built again
  New-Case @{'fetch-test'=1} $null;$Test=$cS;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and $firstAttempt.stage -ceq 'fetch-test-commit-by-sha' -and $s.expectedTest.Count -eq 1) 'front-retry'
  # 6b2. DESIGN §67, a batch of three PRs (descriptor /4): S = merge(merge(merge(T, H1), H2), H3) on T = main c1; H1 = c2 (feature),
  # H2 and H3 on their own branches; GitHub's refs/pull/<n>/head name each member's head. The chain is checked on the store's objects.
  function Make-Chain{
   & $g checkout -q -b topic-2 $c1;[IO.File]::WriteAllText((Join-Path $src 'm2.txt'),"m2`n");& $g add m2.txt;& $g commit -q -m H2;$x2=(& $g rev-parse HEAD).Trim()
   & $g checkout -q -b topic-3 $c1;[IO.File]::WriteAllText((Join-Path $src 'm3.txt'),"m3`n");& $g add m3.txt;& $g commit -q -m H3;$x3=(& $g rev-parse HEAD).Trim()
   & $g checkout -q -b topic-o $c1;[IO.File]::WriteAllText((Join-Path $src 'mo.txt'),"mo`n");& $g add mo.txt;& $g commit -q -m O;$xo=(& $g rev-parse HEAD).Trim()
   & $g checkout -q --detach $c1;& $g merge -q --no-ff -m S1 $c2;$s1=(& $g rev-parse HEAD).Trim();& $g merge -q --no-ff -m S2 $x2;$s2=(& $g rev-parse HEAD).Trim();& $g merge -q --no-ff -m S3 $x3;$s3=(& $g rev-parse HEAD).Trim()
   $tree3=(& $g rev-parse "$s3^{tree}").Trim()
   $sw2=(& $g commit-tree -p $x2 -p $s1 -m sw2 ((& $g rev-parse "$s2^{tree}").Trim())).Trim();$sw3=(& $g commit-tree -p $sw2 -p $x3 -m sw3 $tree3).Trim()
   & $g checkout -q main
   foreach($pair in @(@('refs/pull/101/head',$c2),@('refs/pull/102/head',$x2),@('refs/pull/103/head',$x3),@('refs/pull/109/merge',$s3),@('refs/pull/110/merge',$sw3))){& $g update-ref $pair[0] $pair[1]}
   return @{s1=$s1;s2=$s2;s3=$s3;x2=$x2;x3=$x3;xo=$xo;tree=$tree3;sw3=$sw3}
  }
  function Drop-Chain{foreach($r in @('refs/heads/topic-2','refs/heads/topic-3','refs/heads/topic-o','refs/pull/101/head','refs/pull/102/head','refs/pull/103/head','refs/pull/109/merge','refs/pull/110/merge')){& $g show-ref --verify --quiet $r;if($LASTEXITCODE -eq 0){& $g update-ref -d $r}}}
  function Chain-Case($k,$o){
   New-Case @{} $null;$script:Test=$k.s3
   $d=[ordered]@{contract=$ChainContract;pr=101;headSha=$c2;baseSha=$c1;testSha=$k.s3;testTree=$k.tree;members=@([ordered]@{pr=101;headSha=$c2},[ordered]@{pr=102;headSha=$k.x2},[ordered]@{pr=103;headSha=$k.x3})}
   foreach($n in $o.Keys){$d[$n]=$o[$n]};if($o.ContainsKey('testSha')){$script:Test=$o['testSha']}
   $script:Chain=Chain-Of (($d|ConvertTo-Json -Depth 5 -Compress)|ConvertFrom-Json)
  }
  $k=Make-Chain
  try{
   $chainRefs=Ref-Map ((& git ls-remote --branches --tags $src)-join "`n") "`t" $true;Yes ($chainRefs.Count -eq 6) 'chain-fixture'
   Chain-Case $k @{};$s=Fetch-Store
   Yes ($attempts -eq 1 -and $s.expectedTest.Count -eq 1 -and $s.expectedTest[$TestPrefix+$k.s3] -ceq $k.s3 -and (Same-Map $s.remote $chainRefs)) 'chain-store'
   Yes (@($calls|Where-Object{$_ -ceq 'test-parents'}).Count -eq 3 -and @($calls|Where-Object{$_ -ceq 'ls-remote-members'}).Count -eq 1 -and @($calls|Where-Object{$_ -ceq 'test-tree'}).Count -eq 1 -and @($calls|Where-Object{$_ -ceq 'member-cat-file'}).Count -eq 3) 'chain-store-steps'
   $cb=Join-Path $Root 'all-refs.bundle';$null=Invoke-Git 'bundle-create' ($Common+@($s.gd,'bundle','create','--quiet','--version=2',$cb,'--branches','--tags','--glob=refs/reviewed/*','--glob=refs/clued-test/*'))
   $hdr=Bundle-Header $cb;Yes ((Same-Map $hdr.formal $chainRefs) -and (Same-Map $hdr.test $s.expectedTest)) 'chain-bundle'
   # a wrong parent (S2's parents swapped), a head that is not a member's, members in another order, one member fewer: refused, never retried
   Chain-Case $k @{testSha=$k.sw3};Refused-With {Fetch-Store} 'BATCH_CHAIN_REQUIRED' 'chain-swapped';Yes ($attempts -eq 1 -and $stage -ceq 'test-chain-readback') 'chain-swapped-not-retried'
   Chain-Case $k @{members=@([ordered]@{pr=101;headSha=$c2},[ordered]@{pr=102;headSha=$k.xo},[ordered]@{pr=103;headSha=$k.x3})};Refused-With {Fetch-Store} 'BATCH_CHAIN_REQUIRED' 'chain-head-not-member'
   Chain-Case $k @{members=@([ordered]@{pr=101;headSha=$c2},[ordered]@{pr=103;headSha=$k.x3},[ordered]@{pr=102;headSha=$k.x2})};Refused-With {Fetch-Store} 'BATCH_CHAIN_REQUIRED' 'chain-members-order'
   Chain-Case $k @{members=@([ordered]@{pr=101;headSha=$c2},[ordered]@{pr=103;headSha=$k.x3})};Refused-With {Fetch-Store} 'BATCH_CHAIN_REQUIRED' 'chain-member-missing'
   # S's tree is not the descriptor's
   Chain-Case $k @{testTree=(& $g rev-parse "$c1^{tree}").Trim()};Refused-With {Fetch-Store} 'BATCH_TEST_TREE_CHANGED' 'chain-tree'
   # GitHub's PR head of a member is another commit (the PR moved on, or the member names another PR)
   & $g update-ref refs/pull/103/head $c0
   try{Chain-Case $k @{};Refused-With {Fetch-Store} 'BATCH_MEMBER_NOT_PR_HEAD' 'chain-pull-head-moved';Yes ($attempts -eq 1 -and $lastGit.label -ceq 'ls-remote-members') 'chain-pull-head-not-retried'}finally{& $g update-ref refs/pull/103/head $k.x3}
   Chain-Case $k @{members=@([ordered]@{pr=101;headSha=$c2},[ordered]@{pr=102;headSha=$k.x2},[ordered]@{pr=104;headSha=$k.x3})};Refused-With {Fetch-Store} 'BATCH_MEMBER_NOT_PR_HEAD' 'chain-pull-head-missing'
   # a branch named like a member's pull ref (ls-remote lists it for that pattern) changes nothing: the pull head itself decides
   & $g update-ref refs/heads/refs/pull/103/head $c0
   try{Chain-Case $k @{};$s=Fetch-Store;Yes ($attempts -eq 1 -and $s.expectedTest.Count -eq 1) 'chain-tail-named-branch-skipped'}finally{& $g update-ref -d refs/heads/refs/pull/103/head}
   # a member head no branch carries any more (its branch deleted): not a live tip of the ls-remote list
   & $g update-ref -d refs/heads/topic-3
   try{Chain-Case $k @{};Refused-With {Fetch-Store} 'BATCH_MEMBER_NOT_BRANCH_TIP' 'chain-member-not-tip'}finally{& $g update-ref refs/heads/topic-3 $k.x3}
   # the pull-head read is a network step: a stall there builds the whole store again
   Chain-Case $k @{};$script:stalls=@{'ls-remote-members'=1};$s=Fetch-Store
   Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and $firstAttempt.stage -ceq 'ls-remote-member-pull-heads') 'chain-pull-heads-retry'
   # /3 on the same S: the one-PR parents check refuses it, as before
   New-Case @{} $null;$Test=$k.s3;Refused-With {Fetch-Store} 'TEST_COMMIT_PARENTS_REQUIRED' 'chain-s-is-not-a-front-merge'
  }finally{Drop-Chain}
  Yes ((Ref-Map ((& git ls-remote --branches --tags $src)-join "`n") "`t" $true).Count -eq 3) 'chain-fixture-removed'
  # 6c. refs pushed between the fetch and the ls-remote: the first inconsistency gets a complete new attempt in a new store
  New-Case @{} $null;$races=1;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and (Fetches) -eq 2 -and (@($calls|Where-Object{$_ -ceq 'ls-remote'}).Count) -eq 2 -and -not (Test-Path -LiteralPath $FetchDir3)) 'race-retry-fresh-store'
  Yes ($firstAttempt.stage -ceq 'fetched-store-readback' -and $firstAttempt.refsDiffer.count -eq 1 -and (@($firstAttempt.refsDiffer.refs)-join '|') -ceq 'refs/heads/raced') 'race-first-attempt-recorded'
  Yes ((Same-Map $s.remote $expected) -and $s.expectedReviewed.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $FetchDir 'HEAD')) -and (@($created)-join '|') -ceq ($FetchDir+'|'+$FetchDir2)) 'race-retry-store-checked'
  # the third attempt is the last one
  New-Case @{} $null;$races=2;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir3 -and $attempts -eq 3 -and (Fetches) -eq 3 -and $firstAttempt.refsDiffer.count -eq 1 -and (Same-Map $s.remote $expected) -and (@($created)-join '|') -ceq ($FetchDir+'|'+$FetchDir2+'|'+$FetchDir3)) 'race-retry-third-attempt'
  # three inconsistent attempts: the original refusal, never a fourth
  New-Case @{} $null;$races=3
  Refused-With {Fetch-Store} 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' 'race-three-times-final'
  Yes ($attempts -eq 3 -and (Fetches) -eq 3 -and (@($calls|Where-Object{$_ -ceq 'ls-remote'}).Count) -eq 3 -and $stage -ceq 'fetched-store-readback' -and $refsDiffer.count -eq 1) 'race-never-a-fourth-attempt'
  # after the window: no new attempt
  New-Case @{} 900;$races=1
  Refused-With {Fetch-Store} 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' 'race-late-final'
  Yes ($attempts -eq 1 -and $null -eq $firstAttempt -and -not (Test-Path -LiteralPath $FetchDir2)) 'race-late-not-retried'
  # every other check is unchanged: after the race, the new attempt still refuses a main that is not the base
  New-Case @{} $null;$races=1;$Base=$c2
  Refused-With {Fetch-Store} 'REMOTE_MAIN_BASE_CHANGED' 'race-then-main-changed'
  Yes ($attempts -eq 2 -and (Fetches) -eq 2 -and -not (Test-Path -LiteralPath $FetchDir3)) 'race-then-main-changed-final'
  # the later FETCHED_REFS_DIFFER_FROM_LS_REMOTE check (a branch appearing while the reviewed commits are fetched) is not retried
  New-Case @{} $null;$lateRaces=1
  Refused-With {Fetch-Store} 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' 'late-refs-differ-final'
  Yes ($attempts -eq 1 -and $null -eq $refsDiffer -and $null -eq $firstAttempt -and -not (Test-Path -LiteralPath $FetchDir2)) 'late-refs-differ-not-retried'
  # network retries and race retries share the three attempts, with one network retry at most
  New-Case @{fetch=1} $null;$races=1;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir3 -and $attempts -eq 3 -and $firstAttempt.git.label -ceq 'fetch' -and -not $firstAttempt.Contains('refsDiffer')) 'stall-then-race-then-success'
  # every attempt that was retried is listed with its own reason, the second failure's too (observation of the generation 6 review)
  Yes (@($failedAttempts).Count -eq 2 -and $failedAttempts[0].attempt -eq 1 -and $failedAttempts[0].reason -ceq 'GIT_STEP_FAILED' -and $failedAttempts[0].git.label -ceq 'fetch' -and -not $failedAttempts[0].Contains('refsDiffer') -and
    $failedAttempts[1].attempt -eq 2 -and $failedAttempts[1].reason -ceq 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' -and $failedAttempts[1].refsDiffer.count -eq 1 -and $failedAttempts[1].stage -ceq 'fetched-store-readback') 'failed-attempts-list-both'
  New-Case @{'fetch-reviewed'=2} $null;$races=1
  Refused-With {Fetch-Store} 'GIT_STEP_FAILED' 'race-then-two-stalls-final'
  Yes ($attempts -eq 3 -and (Fetches) -eq 3 -and $firstAttempt.refsDiffer.count -eq 1 -and $lastGit.label -ceq 'fetch-reviewed') 'race-then-one-network-retry-only'

  # ---- The persistent seed (DESIGN 10.1): placed like production, under bundles\_seed next to the batch directories ----
  $SeedRoot=Join-Path $tmp 'bundles\_seed';$SeedDir=Join-Path $SeedRoot 'seed.git';$SeedNew=Join-Path $SeedRoot 'seed-new.git';$SeedLock=Join-Path $SeedRoot 'seed.lock';$SeedMeta=Join-Path $SeedRoot 'seed-meta.json'
  $SeedLockStaleSeconds=1800;$SeedMaxPacks=12;$SeedMaxBytes=1073741824
  $consts=@{};foreach($name in @('SeedMinFullFetchSeconds','SeedMetaMaxAgeSeconds','SeedLockStaleSeconds','SeedMaxPacks','SeedMaxBytes')){
   $st=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -ceq ('$'+$name)});if($st.Count -ne 1){throw ('ASSIGNMENT_MISSING:'+$name)};$consts[$name]=$st[0].Right.Extent.Text}
  $SeedMetaMaxAgeSeconds=86400
  function Reset-Seed{
   $script:seedUse=$false;$script:seedAttempt=$false;$script:seedBusy=$false;$script:seedLockHeld=$false;$script:seedAvailable=$false
   $script:seedReport=[ordered]@{enabled=$true;used=$false;reason=$null;discarded=$false;primeSeconds=$null;updated=$false;updateSkipped=$null;seedBytes=$null;error=$null;networkFailureNoted=$false}
   if(Test-Path -LiteralPath $SeedRoot){Remove-Tree $SeedRoot}
  }
  function Write-Meta([int]$Seconds,[long]$At){[void][IO.Directory]::CreateDirectory($SeedRoot);[IO.File]::WriteAllText($SeedMeta,(([ordered]@{contract=$SeedMetaContract;updatedAt=(Utc);lastFullFetchSeconds=$Seconds;lastFullFetchAtUnix=$At}|ConvertTo-Json -Compress)+"`n"))}
  function Slow-Meta{Write-Meta 500 (Unix-Now ([DateTime]::UtcNow))}
  function Store-Refs($s){return (Split-Refs ((& git ('--git-dir='+$s.dir) for-each-ref '--format=%(objectname) %(refname)') -join "`n") ' ' $false $true)}
  function Git-Ok([string[]]$GitArgs){try{$null=& $realGit 'probe' $GitArgs;return $true}catch{return $false}}
  $pins=@{};foreach($name in $consts.Keys){$pins[$name]=$consts[$name]}
  Yes ($pins['SeedMinFullFetchSeconds'] -ceq '90' -and $pins['SeedMetaMaxAgeSeconds'] -ceq '86400' -and $pins['SeedMaxBytes'] -ceq '1073741824' -and $pins['SeedMaxPacks'] -ceq '12') 'seed-constants'

  # S1. gating: only a slow measured fetch turns the seed on; none, an old one or a fast one are decided and said
  $now=[DateTime]::UtcNow;$u=Unix-Now $now
  $mk={param($sec,$at)[pscustomobject]@{lastFullFetchSeconds=$sec;lastFullFetchAtUnix=$at}}
  Yes ((Seed-Wanted $null $now).use -and (Seed-Wanted $null $now).reason -ceq 'NO_MEASUREMENT') 'seed-wanted-no-measurement'
  Yes ((Seed-Wanted (& $mk 300 $u) $now).use -and (Seed-Wanted (& $mk 90 $u) $now).use) 'seed-wanted-slow'
  Yes ((-not (Seed-Wanted (& $mk 89 $u) $now).use) -and (Seed-Wanted (& $mk 89 $u) $now).reason -ceq 'NETWORK_FAST') 'seed-not-wanted-fast'
  Yes ((-not (Seed-Wanted (& $mk 500 ($u-86401)) $now).use) -and (Seed-Wanted (& $mk 500 ($u-86401)) $now).reason -ceq 'REMEASURE_DUE') 'seed-not-wanted-stale'
  Yes ((Seed-Wanted (& $mk 500 ($u-86399)) $now).use) 'seed-wanted-just-fresh'
  # generation 10: a network failure noted in the last 6 hours turns the seed on over a fast or an old measurement; an older or a future one does not
  Yes ($SeedAfterNetworkFailureSeconds -eq 21600) 'seed-after-network-failure-window'
  $w=Seed-Wanted (& $mk 30 $u) $now ($u-60);Yes ($w.use -and $w.reason -ceq 'RECENT_NETWORK_FAILURE') 'seed-wanted-after-network-failure-over-fast'
  $w=Seed-Wanted (& $mk 30 ($u-86401)) $now ($u-21600);Yes ($w.use -and $w.reason -ceq 'RECENT_NETWORK_FAILURE') 'seed-wanted-after-network-failure-over-remeasure'
  $w=Seed-Wanted $null $now ($u-1);Yes ($w.use -and $w.reason -ceq 'RECENT_NETWORK_FAILURE') 'seed-wanted-after-network-failure-without-measurement'
  $w=Seed-Wanted (& $mk 30 $u) $now ($u-21601);Yes ((-not $w.use) -and $w.reason -ceq 'NETWORK_FAST') 'seed-network-failure-aged-out'
  $w=Seed-Wanted (& $mk 30 $u) $now ($u+600);Yes ((-not $w.use) -and $w.reason -ceq 'NETWORK_FAST') 'seed-network-failure-in-the-future-ignored'
  $w=Seed-Wanted (& $mk 30 $u) $now;Yes ((-not $w.use) -and $w.reason -ceq 'NETWORK_FAST') 'seed-wanted-two-argument-form-unchanged'

  # S2. no seed: nothing changes (unseeded store, no seed call), then the verified store makes the seed and its measurement
  Reset-Seed;New-Case @{} $null;Seed-Begin
  Yes ((-not $seedUse) -and $seedReport.reason -ceq 'NO_SEED') 'seed-none-at-begin'
  $s=Fetch-Store;Yes ($s.unseeded -eq $true -and @($calls|Where-Object{$_ -like 'seed-*'}).Count -eq 0 -and (Same-Map $s.remote $expected)) 'seed-none-unseeded-store'
  Seed-Update $s
  Yes ($seedReport.updated -and -not (Test-Path -LiteralPath $SeedNew) -and (Test-Path -LiteralPath $SeedDir) -and $null -eq (Seed-Shape-Problem)) ('seed-created-from-store:'+($seedReport|ConvertTo-Json -Compress))
  $meta=Seed-Meta-Read;Yes ($null -ne $meta -and $meta.lastFullFetchAtUnix -ge $u -and $meta.lastFullFetchSeconds -lt 90) 'seed-meta-measures-unseeded-fetch'
  $sr=Split-Refs ((& git --git-dir=$SeedDir for-each-ref '--format=%(objectname) %(refname)') -join "`n") ' ' $false $true
  Yes ((Same-Map $sr.formal $expected) -and $sr.reviewed.Count -eq 1 -and (-not (Test-Path -LiteralPath (Join-Path $SeedDir 'objects\info\alternates')))) 'seed-holds-heads-tags-reviewed'
  Yes (Git-Ok @(('--git-dir='+$SeedDir),'fsck','--full','--strict')) 'seed-fsck'
  # a fast measured network leaves the (maintained) seed unused
  Seed-Begin;Yes ((-not $seedUse) -and $seedReport.reason -ceq 'NETWORK_FAST') 'seed-fast-network-not-used'

  # S3. a seeded build: the seed's refs are primed, GitHub is fetched, the seed's refs are gone, every check ran as before
  Slow-Meta;New-Case @{} $null;$seedReport.reason=$null;Seed-Begin
  Yes ($seedUse -and $seedReport.reason -ceq 'NETWORK_SLOW') 'seed-wanted-after-slow-measurement'
  $s=Fetch-Store
  Yes ($s.unseeded -eq $false -and $attempts -eq 1 -and $seedReport.used -and (Fetches) -eq 1 -and (Same-Map $s.remote $expected) -and $s.expectedReviewed.Count -eq 1) 'seeded-store'
  Yes ((@($calls|Where-Object{$_ -like 'seed-*'})-join '|') -ceq 'seed-config|seed-config|seed-fetch|seed-refs-left|seed-connectivity') ('seeded-calls:'+(@($calls)-join ','))
  $all=Store-Refs $s;Yes ((Same-Map $all.formal $expected) -and $all.reviewed.Count -eq 1 -and $all.test.Count -eq 0) 'seeded-store-no-seed-refs'
  Yes (Git-Ok @(('--git-dir='+$s.dir),'fsck','--full','--strict')) 'seeded-store-fsck'
  foreach($f in @('shallow','info\grafts','objects\info\alternates','objects\info\http-alternates')){Yes (-not (Test-Path -LiteralPath (Join-Path $s.dir $f))) ('seeded-store-no-'+$f)}
  $fb=Join-Path $Root 'all-refs.bundle';$null=Invoke-Git 'bundle-create' ($Common+@($s.gd,'bundle','create','--quiet','--version=2',$fb,'--branches','--tags','--glob=refs/reviewed/*','--glob=refs/clued-test/*'))
  $hdr=Bundle-Header $fb;Yes ((Same-Map $hdr.formal $expected) -and (Same-Map $hdr.reviewed $s.expectedReviewed)) 'seeded-bundle'
  $metaBefore=[IO.File]::ReadAllText($SeedMeta);Seed-Update $s
  Yes ($seedReport.updated -and ([IO.File]::ReadAllText($SeedMeta) | ConvertFrom-Json).lastFullFetchSeconds -eq 500) 'seeded-update-keeps-the-unseeded-measurement'

  # S4. what a seed must never do. A commit that exists only in the seed, under a branch of its own and a tag, and a hostile config
  $evil=(& git --git-dir=$SeedDir -c user.name=f -c user.email=f@f commit-tree -m evil ((& git --git-dir=$SeedDir rev-parse ($c2+'^{tree}')).Trim())).Trim()
  & git --git-dir=$SeedDir update-ref refs/heads/evil $evil;& git --git-dir=$SeedDir update-ref refs/tags/evil-tag $evil;& git --git-dir=$SeedDir update-ref refs/reviewed/evil $evil
  Slow-Meta;New-Case @{} $null;Seed-Begin;$s=Fetch-Store
  $all=Store-Refs $s
  Yes ($s.unseeded -eq $false -and (Same-Map $all.formal $expected) -and $all.reviewed.Count -eq 1 -and -not $all.formal.ContainsKey('refs/heads/evil')) 'seed-refs-never-survive'
  # the seed's object may sit unreachable in the store, but a ref is only what GitHub says, and the bundle carries reachable objects only
  $fb=Join-Path $Root 'all-refs.bundle';$null=Invoke-Git 'bundle-create' ($Common+@($s.gd,'bundle','create','--quiet','--version=2',$fb,'--branches','--tags','--glob=refs/reviewed/*','--glob=refs/clued-test/*'))
  $hdr=Bundle-Header $fb;Yes ((Same-Map $hdr.formal $expected) -and (Same-Map $hdr.reviewed $s.expectedReviewed)) 'seed-evil-bundle-refs'
  $clone=Join-Path $tmp 'bundle-clone.git';Yes (Git-Ok @('clone','-q','--bare',$fb,$clone)) 'bundle-clones'
  Yes (-not (Git-Ok @(('--git-dir='+$clone),'cat-file','-e',$evil))) 'seed-evil-object-not-in-bundle'
  # seed update prunes what the verified store does not have (here: the planted refs)
  Seed-Update $s;$sr=Split-Refs ((& git --git-dir=$SeedDir for-each-ref '--format=%(objectname) %(refname)') -join "`n") ' ' $false $true
  Yes ((Same-Map $sr.formal $expected) -and $sr.reviewed.Count -eq 1) 'seed-update-prunes-foreign-refs'
  # shape: each of these is discarded at the start and the build is the unseeded one
  $shape={param($mutate,$code,$what)
   Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Slow-Meta;& $mutate
   New-Case @{} $null;$script:seedReport.reason=$null;Seed-Begin
   Yes ((-not $seedUse) -and $seedReport.discarded -and $seedReport.reason -ceq $code -and -not (Test-Path -LiteralPath $SeedDir)) ('seed-shape-'+$what)
   $st=Fetch-Store;Yes ($st.unseeded -eq $true -and $attempts -eq 1 -and (Same-Map $st.remote $expected)) ('seed-shape-build-unseeded-'+$what)}
  & $shape {[IO.File]::WriteAllText((Join-Path $SeedDir 'objects\info\alternates'),"C:/elsewhere/objects`n")} 'SEED_UNEXPECTED_ENTRY' 'alternates'
  & $shape {[IO.File]::WriteAllText((Join-Path $SeedDir 'shallow'),"$c1`n")} 'SEED_UNEXPECTED_ENTRY' 'shallow'
  & $shape {[void][IO.Directory]::CreateDirectory((Join-Path $SeedDir 'info'));[IO.File]::WriteAllText((Join-Path $SeedDir 'info\grafts'),"$c2 $c0`n")} 'SEED_UNEXPECTED_ENTRY' 'grafts'
  & $shape {[IO.File]::WriteAllText((Join-Path $SeedDir 'commondir'),"..\..`n")} 'SEED_UNEXPECTED_ENTRY' 'commondir'
  & $shape {[void][IO.Directory]::CreateDirectory((Join-Path $SeedDir 'hooks'));[IO.File]::WriteAllText((Join-Path $SeedDir 'hooks\pre-upload-pack'),"#!/bin/sh`n")} 'SEED_HOOKS_PRESENT' 'hook'
  & $shape {& git config --file (Join-Path $SeedDir 'config') core.fsmonitor 'C:/evil.exe'} 'SEED_CONFIG_REFUSED' 'config-fsmonitor'
  & $shape {& git config --file (Join-Path $SeedDir 'config') uploadpack.packObjectsHook 'C:/evil.exe'} 'SEED_CONFIG_REFUSED' 'config-pack-hook'
  & $shape {& git config --file (Join-Path $SeedDir 'config') include.path 'C:/evil.cfg'} 'SEED_CONFIG_REFUSED' 'config-include'
  & $shape {& git config --file (Join-Path $SeedDir 'config') core.bare false} 'SEED_CONFIG_REFUSED' 'config-not-bare'
  & $shape {Remove-Item -LiteralPath (Join-Path $SeedDir 'HEAD') -Force} 'SEED_LAYOUT_REFUSED' 'no-head'
  & $shape {$real=Join-Path $tmp 'junction-target';[void][IO.Directory]::CreateDirectory($real);[IO.File]::WriteAllText((Join-Path $real 'keep.txt'),'keep');Remove-Item -LiteralPath (Join-Path $SeedDir 'objects') -Recurse -Force;$null=cmd /c mklink /J ("$SeedDir\objects") $real} 'SEED_LAYOUT_REFUSED' 'objects-is-a-junction'
  Yes (Test-Path -LiteralPath (Join-Path $tmp 'junction-target\keep.txt')) 'junction-target-untouched'

  # S5. a seed that looks right and is not: its packs are damaged. The local fetch fails before GitHub is asked for anything,
  #     the seed is discarded, and the next attempt (unseeded) builds the same store: the seed cost an attempt, not the bundle.
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Slow-Meta
  $pack=@(Get-ChildItem -LiteralPath (Join-Path $SeedDir 'objects\pack') -Filter '*.pack')[0];$bytes=[IO.File]::ReadAllBytes($pack.FullName);for($i=40;$i -lt [Math]::Min(200,$bytes.Length);$i++){$bytes[$i]=$bytes[$i] -bxor 0xff};[IO.File]::SetAttributes($pack.FullName,[IO.FileAttributes]::Normal);[IO.File]::WriteAllBytes($pack.FullName,$bytes)
  New-Case @{} $null;$seedReport.reason=$null;Seed-Begin;Yes $seedUse 'damaged-seed-passes-shape'
  $s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and $s.unseeded -eq $true -and (Fetches) -eq 1 -and -not (Test-Path -LiteralPath $SeedDir) -and $seedReport.discarded -and (Same-Map $s.remote $expected)) ('damaged-seed-falls-back:'+(@($calls)-join ','))
  Yes ($firstAttempt.stage -ceq 'seed-prime' -and $s.expectedReviewed.Count -eq 1) 'damaged-seed-first-attempt-recorded'
  # a seed that cannot even take part (the lock is held by someone else): unseeded attempt, the seed stays
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Slow-Meta;[IO.File]::WriteAllText($SeedLock,'held')
  New-Case @{} $null;Seed-Begin;$s=Fetch-Store
  Yes ($attempts -eq 2 -and $s.unseeded -eq $true -and (Test-Path -LiteralPath $SeedDir) -and -not $seedReport.discarded -and $seedReport.reason -ceq 'SEED_BUSY' -and (Same-Map $s.remote $expected)) 'busy-seed-left-alone'
  Remove-Item -LiteralPath $SeedLock -Force
  # a lock that is older than half an hour is a crashed run's: taken over
  [IO.File]::WriteAllText($SeedLock,'old');(Get-Item -LiteralPath $SeedLock).LastWriteTimeUtc=[DateTime]::UtcNow.AddSeconds(-($SeedLockStaleSeconds+60))
  Yes ((Seed-Lock) -and (Test-Path -LiteralPath $SeedLock)) 'stale-lock-taken-over';Seed-Unlock;Yes (-not (Test-Path -LiteralPath $SeedLock)) 'lock-released'
  [IO.File]::WriteAllText($SeedLock,'young');Yes (-not (Seed-Lock)) 'young-lock-respected';Remove-Item -LiteralPath $SeedLock -Force
  # review of gen8, finding 3: a stale lock that cannot be taken over (here: held open by someone) is "busy", not an exception; and a discard
  # needs the lock: a seed whose lock another build holds is left alone, one nobody holds is removed (and the lock is released again)
  [IO.File]::WriteAllText($SeedLock,'old');(Get-Item -LiteralPath $SeedLock).LastWriteTimeUtc=[DateTime]::UtcNow.AddSeconds(-($SeedLockStaleSeconds+60))
  $hold=[IO.File]::Open($SeedLock,'Open','Read','None')
  try{$got=$null;$threw=$false;try{$got=Seed-Lock}catch{$threw=$true};Yes ((-not $threw) -and ($got -eq $false) -and -not $seedLockHeld) 'stale-lock-not-removable-is-busy'}finally{$hold.Dispose()}
  Remove-Item -LiteralPath $SeedLock -Force
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st
  [IO.File]::WriteAllText($SeedLock,'young');$seedReport.discarded=$false
  Seed-Discard 'SEED_TEST';Yes ((Test-Path -LiteralPath $SeedDir) -and -not $seedReport.discarded -and $seedReport.error -ceq 'SEED_DISCARD_SKIPPED_LOCK_HELD_BY_ANOTHER' -and (Test-Path -LiteralPath $SeedLock) -and -not $seedUse) 'discard-needs-the-lock'
  Remove-Item -LiteralPath $SeedLock -Force
  Seed-Discard 'SEED_TEST';Yes ($seedReport.discarded -and -not (Test-Path -LiteralPath $SeedDir) -and -not (Test-Path -LiteralPath $SeedLock) -and -not $seedLockHeld) 'discard-takes-and-releases-the-lock'

  # S6. the retry rules with a seed. Generation 10 (DESIGN 53.2): a stalled GitHub fetch of a seeded attempt is retried WITH the seed
  # (before: unseeded, the whole repository again over the same failing line); the failure is noted in the meta for the next builds.
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Slow-Meta
  New-Case @{fetch=1} $null;Seed-Begin;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and $s.unseeded -eq $false -and @($calls|Where-Object{$_ -ceq 'seed-fetch'}).Count -eq 2 -and (Test-Path -LiteralPath $SeedDir) -and $firstAttempt.git.label -ceq 'fetch' -and (Same-Map $s.remote $expected) -and $s.expectedReviewed.Count -eq 1) ('stall-then-seeded-retry:'+(@($calls)-join ','))
  $nm=Seed-Meta-Object;Yes ($seedReport.networkFailureNoted -and $null -ne $nm -and [long]$nm.lastNetworkFailureAtUnix -ge (Unix-Now ([DateTime]::UtcNow))-60 -and $nm.lastFullFetchSeconds -eq 500) 'stall-noted-in-meta-measurement-kept'
  Yes (Git-Ok @(('--git-dir='+$s.dir),'fsck','--full','--strict')) 'seeded-retry-store-fsck'
  # N1. a fast measured network (seed off) whose fetch fails: the retry turns the seed on; the next build uses it too
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st
  New-Case @{fetch=1} $null;Seed-Begin;Yes ((-not $seedUse) -and $seedAvailable -and $seedReport.reason -ceq 'NETWORK_FAST') 'fast-network-seed-available-not-used'
  $s=Fetch-Store
  Yes ($attempts -eq 2 -and $s.unseeded -eq $false -and $seedReport.used -and $seedReport.reason -ceq 'SEEDED_AFTER_NETWORK_FAILURE' -and @($calls|Where-Object{$_ -ceq 'seed-fetch'}).Count -eq 1 -and $failedAttempts[0].git.label -ceq 'fetch' -and (Same-Map $s.remote $expected)) ('network-failure-turns-seed-on:'+(@($calls)-join ','))
  Seed-Update $s;Yes ($seedReport.updated -and $null -ne (Seed-Meta-Failure-At)) 'seed-update-keeps-network-failure-note'
  New-Case @{} $null;Seed-Begin;Yes ($seedUse -and $seedReport.reason -ceq 'RECENT_NETWORK_FAILURE') 'next-build-seeded-after-network-failure'
  $s=Fetch-Store;Yes ($attempts -eq 1 -and $s.unseeded -eq $false -and (Same-Map $s.remote $expected)) 'next-build-seeded-store'
  # N2. no seed at all: the retry is unseeded as before; the failure is still noted (the seed root is made), and the seed the
  #     successful build makes is used by the next build
  Reset-Seed;New-Case @{fetch=1} $null;Seed-Begin;$s=Fetch-Store
  Yes ($attempts -eq 2 -and $s.unseeded -eq $true -and -not $seedReport.used -and $seedReport.networkFailureNoted -and $null -ne (Seed-Meta-Failure-At) -and $null -eq (Seed-Meta-Read)) 'no-seed-network-failure-noted'
  Seed-Update $s;$nm=Seed-Meta-Object;Yes ($seedReport.updated -and $nm.lastFullFetchSeconds -ge 0 -and $null -ne $nm.lastNetworkFailureAtUnix) 'first-seed-keeps-note'
  New-Case @{} $null;Seed-Begin;Yes ($seedUse -and $seedReport.reason -ceq 'RECENT_NETWORK_FAILURE') 'first-seed-used-after-network-failure'
  # N3. the seeded network retry fails on the network too: a seeded attempt is never the last one, so a third, unseeded attempt follows
  #     (inside the same window) and builds the store; three failures in a row are the answer, never a fourth attempt
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st
  New-Case @{fetch=2} $null;Seed-Begin;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir3 -and $attempts -eq 3 -and $s.unseeded -eq $true -and (Fetches) -eq 3 -and @($calls|Where-Object{$_ -ceq 'seed-fetch'}).Count -eq 1 -and @($failedAttempts).Count -eq 2 -and $seedReport.reason -ceq 'UNSEEDED_AFTER_SEEDED_NETWORK_FAILURE' -and $seedReport.networkFailureNoted -and (Test-Path -LiteralPath $SeedDir) -and (Same-Map $s.remote $expected)) ('seeded-retry-fails-then-unseeded:'+(@($calls)-join ','))
  New-Case @{fetch=3} $null;Seed-Begin
  Refused-With {Fetch-Store} 'GIT_STEP_FAILED' 'network-three-times-final'
  Yes ($attempts -eq 3 -and (Fetches) -eq 3 -and @($failedAttempts).Count -eq 2 -and (Test-Path -LiteralPath $SeedDir)) 'never-a-fourth-attempt-after-network'
  # an unseeded build (no seed) keeps its single network retry: two failures are the answer
  Reset-Seed;New-Case @{fetch=2} $null;Seed-Begin
  Refused-With {Fetch-Store} 'GIT_STEP_FAILED' 'unseeded-network-twice-final';Yes ($attempts -eq 2 -and (Fetches) -eq 2) 'unseeded-one-network-retry'
  # N4. the seed of the network retry is damaged: SEED_UNUSABLE, the seed is discarded, an unseeded third attempt builds the store;
  #     the network-failure note outlives the discarded seed
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st
  $pack=@(Get-ChildItem -LiteralPath (Join-Path $SeedDir 'objects\pack') -Filter '*.pack')[0];$bytes=[IO.File]::ReadAllBytes($pack.FullName);for($i=40;$i -lt [Math]::Min(200,$bytes.Length);$i++){$bytes[$i]=$bytes[$i] -bxor 0xff};[IO.File]::SetAttributes($pack.FullName,[IO.FileAttributes]::Normal);[IO.File]::WriteAllBytes($pack.FullName,$bytes)
  New-Case @{fetch=1} $null;Seed-Begin;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir3 -and $attempts -eq 3 -and $s.unseeded -eq $true -and $seedReport.discarded -and -not (Test-Path -LiteralPath $SeedDir) -and (Same-Map $s.remote $expected) -and $failedAttempts[1].stage -ceq 'seed-prime') ('damaged-seed-in-network-retry:'+(@($calls)-join ','))
  Yes ($null -ne (Seed-Meta-Failure-At) -and $null -eq (Seed-Meta-Read)) 'network-note-outlives-discarded-seed'
  # N5. the seed lock is held by another build when the failure happens: no note (no error), the retry's seed is busy, the third attempt is unseeded
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;[IO.File]::WriteAllText($SeedLock,'held')
  New-Case @{fetch=1} $null;Seed-Begin;$s=Fetch-Store
  Yes ($attempts -eq 3 -and $s.unseeded -eq $true -and -not $seedReport.networkFailureNoted -and $seedReport.reason -ceq 'SEED_BUSY' -and (Test-Path -LiteralPath $SeedDir) -and (Same-Map $s.remote $expected)) ('busy-seed-in-network-retry:'+(@($calls)-join ','))
  Remove-Item -LiteralPath $SeedLock -Force
  # N6. a failure that is not a network step (the script's own refusal) is never noted
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;New-Case @{} $null;$Base=$c2;Seed-Begin
  Refused-With {Fetch-Store} 'REMOTE_MAIN_BASE_CHANGED' 'refusal-not-noted-final';Yes ((-not $seedReport.networkFailureNoted) -and $null -eq (Seed-Meta-Failure-At)) 'refusal-not-noted'
  Yes ((Network-Step-Failed 'GIT_STEP_FAILED' (Step 'fetch-reviewed' 128)) -and -not (Network-Step-Failed 'GIT_STEP_FAILED' (Step 'cat-file' 128)) -and -not (Network-Step-Failed 'GIT_STEP_FAILED' (Step 'fetch' 0)) -and -not (Network-Step-Failed 'REMOTE_MAIN_BASE_CHANGED' (Step 'fetch' 128))) 'network-step-failed'
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Slow-Meta
  # refs pushed meanwhile: the retry is seeded again (the seed is not what failed), the third attempt never is
  New-Case @{} $null;$races=1;$seedReport.reason=$null;Seed-Begin;$s=Fetch-Store
  Yes ($attempts -eq 2 -and $s.unseeded -eq $false -and @($calls|Where-Object{$_ -ceq 'seed-fetch'}).Count -eq 2 -and (Same-Map $s.remote $expected)) 'race-retry-seeded-again'
  New-Case @{} $null;$races=2;Seed-Begin;$s=Fetch-Store
  Yes ($attempts -eq 3 -and $s.unseeded -eq $true -and @($calls|Where-Object{$_ -ceq 'seed-fetch'}).Count -eq 2) 'third-attempt-never-seeded'
  # a refusal of the script's own checks stays final and is not retried because of the seed
  New-Case @{} $null;$Base=$c2;Seed-Begin
  Refused-With {Fetch-Store} 'REMOTE_MAIN_BASE_CHANGED' 'seeded-refusal-final';Yes ($attempts -eq 1 -and (Test-Path -LiteralPath $SeedDir)) 'seeded-refusal-not-retried'

  # S7. the seed update never fails a build: a store that is gone, a seed that outgrows the limit, a repack on demand
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Yes $seedReport.updated 'update-ok'
  $gone=[pscustomobject]@{dir=(Join-Path $tmp 'no-such-store.git');unseeded=$true;fetchSeconds=1.0}
  $seedReport.updated=$false;$seedReport.discarded=$false;Seed-Update $gone
  Yes ((-not $seedReport.updated) -and $seedReport.discarded -and -not (Test-Path -LiteralPath $SeedDir) -and -not (Test-Path -LiteralPath $SeedLock)) 'update-failure-discards-and-unlocks'
  $SeedMaxBytes=1;Seed-Update $st
  Yes ((-not $seedReport.updated) -and -not (Test-Path -LiteralPath $SeedDir) -and -not (Test-Path -LiteralPath $SeedNew) -and -not (Test-Path -LiteralPath $SeedLock)) 'oversized-seed-not-kept'
  $SeedMaxBytes=1073741824;$seedReport.discarded=$false;Seed-Update $st;Yes ($seedReport.updated -and (Test-Path -LiteralPath $SeedDir)) 'seed-made-again'
  $SeedMaxPacks=0;$calls=@();Seed-Update $st
  Yes ($seedReport.updated -and @($calls|Where-Object{$_ -ceq 'seed-repack'}).Count -eq 1 -and $null -eq (Seed-Shape-Problem)) 'seed-repacked-when-many-packs'
  Yes (Git-Ok @(('--git-dir='+$SeedDir),'fsck','--full','--strict')) 'repacked-seed-fsck'
  $SeedMaxPacks=12
  Reset-Seed
  # 7. The whole script, main block included, as its own process, on a copy that changes only its fixed places: the
  #    resident directory, the remote (the file:// fixture, allowed for this copy only) and git's path. The answer and
  #    the receipt, then -CheckRefs, then a second run of the same batch (create-only). The script refuses elevation.
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $mainBlockRun=-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if($mainBlockRun){
   $res=Join-Path $tmp 'resident';$batch='0123456789abcdef-0123456789ab';$ob=Join-Path $res ('outbox\'+$batch)
   [void][IO.Directory]::CreateDirectory($ob);[void][IO.Directory]::CreateDirectory((Join-Path $res 'bundles'))
   $descriptor=[ordered]@{contract='clued.independent-ci.resident-batch-descriptor/3';batchId=$batch;repo='tdoljyj/cross-memory-system';headSha=$c2;testSha=$c2;baseSha=$c1;sourceCommit=$c1;gitleaksTomlSha256=(Hash-Text $toml)}
   [IO.File]::WriteAllText((Join-Path $ob 'descriptor.json'),($descriptor|ConvertTo-Json -Compress))
   $text=[IO.File]::ReadAllText($tool)
   foreach($pair in @(@("`$Resident='C:\ProgramData\CluedIndependentCI\resident'","`$Resident='$res'"),@("`$Url='https://github.com/tdoljyj/cross-memory-system.git'","`$Url='$Url'"),
     @("'-c','protocol.https.allow=always'","'-c','protocol.https.allow=always','-c','protocol.file.allow=always'"),@("`$Git='C:\Program Files\Git\cmd\git.exe'","`$Git='$Git'"))){
    if(-not $text.Contains($pair[0])){throw ('FIXED_PLACE_MISSING:'+$pair[0])};$text=$text.Replace($pair[0],$pair[1])
   }
   $copy=Join-Path $tmp 'build-bundle-copy.ps1';[IO.File]::WriteAllText($copy,$text)
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'BUNDLE_WRITTEN' -and $v.lsRemoteCompletedAt -cmatch '\A\d{4}-\d\d-\d\dT') ('main-block-answer:'+$out)
   Yes ($v.seed.enabled -eq $true -and $v.seed.used -eq $false -and $v.seed.updated -eq $true -and $v.seed.reason -ceq 'NO_SEED') ('main-block-seed-created:'+$out)
   Yes ((Test-Path -LiteralPath (Join-Path $res 'bundles\_seed\seed.git\HEAD')) -and (Test-Path -LiteralPath (Join-Path $res 'bundles\_seed\seed-meta.json')) -and -not (Test-Path -LiteralPath (Join-Path $res 'bundles\_seed\seed.lock'))) 'main-block-seed-files'
   $rc=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$batch+'\all-refs.receipt.json')))|ConvertFrom-Json
   Yes ($rc.status -ceq 'EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED' -and $rc.storeAttempts -eq 1 -and $null -eq $rc.firstAttempt -and @($rc.failedAttempts).Count -eq 0 -and $rc.refListSha256 -ceq (Ref-List-Sha $expected) -and
     $rc.reviewedCommitCount -eq 1 -and $rc.headSha -ceq $c2 -and $rc.mainSha -ceq $c1 -and $rc.bundleSha256 -ceq $v.bundleSha256 -and $rc.lsRemoteCompletedAt -ceq $v.lsRemoteCompletedAt -and
     (@($rc.branchesAtHead)-join '|') -ceq 'refs/heads/feature') 'main-block-receipt'
   Yes ($rc.testSha -ceq $c2 -and $rc.testRefPrefix -ceq $TestPrefix -and $rc.testRefCount -eq 0 -and $rc.testRefListSha256 -ceq (Hash-Text '')) 'main-block-receipt-no-test-ref'
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch -CheckRefs)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'REMOTE_REFS_UNCHANGED' -and $v.mainStillBase -eq $true) ('check-refs:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.status -ceq 'REFUSED_BEFORE_WRITE' -and $v.reason -ceq 'FIXED_TARGET_ALREADY_EXISTS') ('create-only:'+$out)
   # Task 4012c1b9: the second generation of the same batch, under gen-2\; -CheckRefs then reads it; never a third
   $gen1=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$batch+'\all-refs.receipt.json')))|ConvertFrom-Json
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'BUNDLE_WRITTEN' -and $v.generation -eq 2) ('rebundle-answer:'+$out)
   Yes ($v.seed.used -eq $false -and $v.seed.reason -ceq 'NETWORK_FAST') ('rebundle-fast-network-no-seed:'+$out)
   $rc2=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$batch+'\gen-2\all-refs.receipt.json')))|ConvertFrom-Json
   Yes ($rc2.generation -eq 2 -and $rc2.previousBundleSha256 -ceq $gen1.bundleSha256 -and $rc2.previousRefListSha256 -ceq $gen1.refListSha256 -and $rc2.bundleSha256 -ceq $v.bundleSha256 -and
     $rc2.descriptorSha256 -ceq $gen1.descriptorSha256 -and $rc2.refListSha256 -ceq (Ref-List-Sha $expected) -and (Test-Path -LiteralPath (Join-Path $res ('bundles\'+$batch+'\gen-2\all-refs.bundle')))) 'rebundle-receipt'
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch -CheckRefs)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'REMOTE_REFS_UNCHANGED' -and $v.bundleRefListSha256 -ceq $rc2.refListSha256) ('check-refs-gen-2:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.status -ceq 'REFUSED_BEFORE_WRITE' -and $v.reason -ceq 'FIXED_TARGET_ALREADY_EXISTS') ('rebundle-once:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $batch -Rebundle -CheckRefs)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.reason -ceq 'ONE_MODE_REQUIRED') ('one-mode:'+$out)
   # no first generation: refused before any write; a gen-2\ without its receipt: -CheckRefs refuses, never falls back
   $nbatch='0123456789abcdef-111111111111';$nob=Join-Path $res ('outbox\'+$nbatch);[void][IO.Directory]::CreateDirectory($nob)
   $nd=[ordered]@{};foreach($k in $descriptor.Keys){$nd[$k]=$descriptor[$k]};$nd['batchId']=$nbatch;[IO.File]::WriteAllText((Join-Path $nob 'descriptor.json'),($nd|ConvertTo-Json -Compress))
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $nbatch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.status -ceq 'REFUSED_BEFORE_WRITE' -and $v.reason -ceq 'REBUNDLE_REQUIRES_FIRST_GENERATION' -and -not (Test-Path -LiteralPath (Join-Path $res ('bundles\'+$nbatch)))) ('rebundle-needs-gen-1:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $nbatch)-join '';Yes ($LASTEXITCODE -eq 0) ('gen-1-of-n:'+$out)
   [void][IO.Directory]::CreateDirectory((Join-Path $res ('bundles\'+$nbatch+'\gen-2')))
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $nbatch -CheckRefs)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.reason -ceq 'BUNDLE_GENERATION_INCOMPLETE') ('gen-2-incomplete:'+$out)
   # Generation 13 (DESIGN 57.3, Task 3e2e12d7): that gen-2\ is what a second generation cut off by the network leaves. The next -Rebundle
   # moves it to gen-2-failed-1\ and builds the second generation; -CheckRefs then reads the complete one.
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $nbatch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'BUNDLE_WRITTEN' -and $v.generation -eq 2 -and $v.setAside -ceq 'gen-2-failed-1') ('rebundle-after-failed-gen-2:'+$out)
   Yes ((Test-Path -LiteralPath (Join-Path $res ('bundles\'+$nbatch+'\gen-2-failed-1'))) -and (Test-Path -LiteralPath (Join-Path $res ('bundles\'+$nbatch+'\gen-2\all-refs.receipt.json')))) 'failed-gen-2-moved-aside'
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $nbatch -CheckRefs)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'REMOTE_REFS_UNCHANGED') ('check-refs-after-moved-aside:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $nbatch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.reason -ceq 'FIXED_TARGET_ALREADY_EXISTS' -and $v.status -ceq 'REFUSED_BEFORE_WRITE' -and $null -eq $v.setAside -and $v.automaticRetryAllowed -eq $false) ('complete-gen-2-never-moved:'+$out)
   # Generation 13 (DESIGN 57.6, Task 3edfc598): an installed Source commit GitHub does not have (an unpushed branch) is named, not a git step
   $ubatch='0123456789abcdef-222222222222';$uob=Join-Path $res ('outbox\'+$ubatch);[void][IO.Directory]::CreateDirectory($uob)
   $ud=[ordered]@{};foreach($k in $descriptor.Keys){$ud[$k]=$descriptor[$k]};$ud['batchId']=$ubatch;$ud['sourceCommit']='c'*40;[IO.File]::WriteAllText((Join-Path $uob 'descriptor.json'),($ud|ConvertTo-Json -Compress))
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $ubatch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.reason -ceq 'SOURCE_COMMIT_NOT_ON_REMOTE') ('source-commit-not-on-remote:'+$out)
   # step 3c-2: a train front batch's whole run carries S in the bundle and the receipt
   $fbatch='0123456789abcdef-abcdef012345';$fob=Join-Path $res ('outbox\'+$fbatch);[void][IO.Directory]::CreateDirectory($fob)
   $fd=[ordered]@{contract='clued.independent-ci.resident-batch-descriptor/3';batchId=$fbatch;repo='tdoljyj/cross-memory-system';headSha=$c2;testSha=$cS;baseSha=$c1;sourceCommit=$c1;gitleaksTomlSha256=(Hash-Text $toml)}
   [IO.File]::WriteAllText((Join-Path $fob 'descriptor.json'),($fd|ConvertTo-Json -Compress))
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $fbatch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'BUNDLE_WRITTEN') ('front-main-block-answer:'+$out)
   $rc=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$fbatch+'\all-refs.receipt.json')))|ConvertFrom-Json
   $tm=New-RefMap;$tm[$TestPrefix+$cS]=$cS
   Yes ($rc.testSha -ceq $cS -and $rc.testRefCount -eq 1 -and $rc.testRefListSha256 -ceq (Ref-List-Sha $tm) -and $rc.refListSha256 -ceq (Ref-List-Sha $expected)) 'front-main-block-receipt'
   $fh=Bundle-Header (Join-Path $res ('bundles\'+$fbatch+'\all-refs.bundle'));Yes ((Same-Map $fh.test $tm) -and (Same-Map $fh.formal $expected)) 'front-main-block-bundle'
   # the same batch shape on a measured-slow network: the seed is used, the receipt keeps its fields and says the same things
   $sbatch='0123456789abcdef-5eed5eed5eed';$sob=Join-Path $res ('outbox\'+$sbatch);[void][IO.Directory]::CreateDirectory($sob)
   $sd=[ordered]@{};foreach($k in $fd.Keys){$sd[$k]=$fd[$k]};$sd['batchId']=$sbatch;[IO.File]::WriteAllText((Join-Path $sob 'descriptor.json'),($sd|ConvertTo-Json -Compress))
   $smeta=Join-Path $res 'bundles\_seed\seed-meta.json';[IO.File]::WriteAllText($smeta,((([ordered]@{contract=$SeedMetaContract;updatedAt=(Utc);lastFullFetchSeconds=500;lastFullFetchAtUnix=(Unix-Now ([DateTime]::UtcNow))})|ConvertTo-Json -Compress)+"`n"))
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $sbatch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 0 -and $v.status -ceq 'BUNDLE_WRITTEN' -and $v.seed.used -eq $true -and $v.seed.reason -ceq 'NETWORK_SLOW' -and $v.seed.updated -eq $true -and $v.seed.discarded -eq $false) ('main-block-seeded:'+$out)
   $rs=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$sbatch+'\all-refs.receipt.json')))|ConvertFrom-Json
   $rf=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$fbatch+'\all-refs.receipt.json')))|ConvertFrom-Json
   Yes ($rs.storeAttempts -eq 1 -and $null -eq $rs.firstAttempt -and $rs.refListSha256 -ceq $rf.refListSha256 -and $rs.testRefListSha256 -ceq $rf.testRefListSha256 -and $rs.reviewedRefListSha256 -ceq $rf.reviewedRefListSha256 -and (@($rs.PSObject.Properties.Name)-join '|') -ceq (@($rf.PSObject.Properties.Name)-join '|')) 'main-block-seeded-receipt-same-shape'
   $sh=Bundle-Header (Join-Path $res ('bundles\'+$sbatch+'\all-refs.bundle'));Yes ((Same-Map $sh.test $tm) -and (Same-Map $sh.formal $expected) -and (Same-Map $sh.reviewed $fh.reviewed)) 'main-block-seeded-bundle'
   # Task 4012c1b9: a push to the head's branch since the first bundle (a new commit on top of the head): the second generation
   # is refused (REMOTE_HEAD_MOVED). A force-push that drops the head fails earlier, at the head's object (a git step).
   $c3=(& $g commit-tree -p $c2 -m c3 ((& $g rev-parse "$c2^{tree}").Trim())).Trim();& $g update-ref refs/heads/feature $c3
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $fbatch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.reason -ceq 'REMOTE_HEAD_MOVED') ('rebundle-head-moved:'+$out)
   & $g update-ref refs/heads/feature $c2
   # Generation 10 (DESIGN 53.1, 53.2): GitHub unreachable (a closed loopback port, connection refused at once). The refusal the
   # companion logs carries the codes and counts: reason, stage, the git step, both attempts; the retry used the seed; the meta notes it.
   $dbatch='0123456789abcdef-dead0000beef';$dob=Join-Path $res ('outbox\'+$dbatch);[void][IO.Directory]::CreateDirectory($dob)
   $dd=[ordered]@{};foreach($k in $descriptor.Keys){$dd[$k]=$descriptor[$k]};$dd['batchId']=$dbatch;[IO.File]::WriteAllText((Join-Path $dob 'descriptor.json'),($dd|ConvertTo-Json -Compress))
   $text=[IO.File]::ReadAllText($tool)
   foreach($pair in @(@("`$Resident='C:\ProgramData\CluedIndependentCI\resident'","`$Resident='$res'"),@("`$Url='https://github.com/tdoljyj/cross-memory-system.git'","`$Url='https://127.0.0.1:1/unreachable.git'"),
     @("'-c','protocol.https.allow=always'","'-c','protocol.https.allow=always','-c','http.proxy='"),@("`$Git='C:\Program Files\Git\cmd\git.exe'","`$Git='$Git'"))){
    if(-not $text.Contains($pair[0])){throw ('FIXED_PLACE_MISSING:'+$pair[0])};$text=$text.Replace($pair[0],$pair[1])
   }
   $down=Join-Path $tmp 'build-bundle-down.ps1';[IO.File]::WriteAllText($down,$text)
   $out=(& powershell -NoProfile -NonInteractive -File $down -BatchId $dbatch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.status -ceq 'PARTIAL_STATE_PRESERVED_NO_RETRY' -and $v.reason -ceq 'GIT_STEP_FAILED' -and $v.stage -ceq 'fetch-all-heads-and-tags' -and $v.git.label -ceq 'fetch' -and $v.git.exitCode -ne 0 -and $v.automaticRetryAllowed -eq $false) ('network-down-refusal:'+$out)
   Yes ($v.storeAttempts -eq 3 -and @($v.failedAttempts).Count -eq 2 -and $v.failedAttempts[0].attempt -eq 1 -and $v.failedAttempts[0].reason -ceq 'GIT_STEP_FAILED' -and $v.failedAttempts[0].git.label -ceq 'fetch' -and $v.failedAttempts[0].stage -ceq 'fetch-all-heads-and-tags' -and $v.failedAttempts[1].attempt -eq 2 -and $v.failedAttempts[1].git.label -ceq 'fetch') ('network-down-attempts:'+$out)
   Yes ($v.seed.used -eq $true -and $v.seed.networkFailureNoted -eq $true -and $null -eq $v.hint -and $out -cnotmatch '127\.0\.0\.1') ('network-down-seeded-retry-noted-no-url:'+$out)
   $dm=[IO.File]::ReadAllText((Join-Path $res 'bundles\_seed\seed-meta.json'))|ConvertFrom-Json;Yes ($null -ne $dm.lastNetworkFailureAtUnix -and $dm.lastFullFetchSeconds -eq 500) 'network-down-meta'
   # Generation 13 (DESIGN 57.3; review round 2): a second generation cut off by the line leaves partial state the next -Rebundle sets
   # aside, and the resident may run it again (automaticRetryAllowed, only for the whole fetch or the ls-remote); that next run says
   # what it set aside.
   $rbatch='0123456789abcdef-a00000000013';$rob=Join-Path $res ('outbox\'+$rbatch);[void][IO.Directory]::CreateDirectory($rob)
   $rd=[ordered]@{};foreach($k in $descriptor.Keys){$rd[$k]=$descriptor[$k]};$rd['batchId']=$rbatch;[IO.File]::WriteAllText((Join-Path $rob 'descriptor.json'),($rd|ConvertTo-Json -Compress))
   $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $rbatch)-join '';Yes ($LASTEXITCODE -eq 0) ('gen-1-before-line-down:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $down -BatchId $rbatch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.status -ceq 'PARTIAL_STATE_SET_ASIDE_BY_NEXT_REBUNDLE' -and $v.reason -ceq 'GIT_STEP_FAILED' -and $v.git.label -ceq 'fetch' -and $v.automaticRetryAllowed -eq $true -and $null -eq $v.setAside) ('rebundle-line-down:'+$out)
   $out=(& powershell -NoProfile -NonInteractive -File $down -BatchId $rbatch -Rebundle)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
   Yes ($code -eq 2 -and $v.status -ceq 'PARTIAL_STATE_SET_ASIDE_BY_NEXT_REBUNDLE' -and $v.setAside -ceq 'gen-2-failed-1' -and $v.automaticRetryAllowed -eq $true) ('rebundle-line-down-again-sets-aside:'+$out)
   # DESIGN §67: a batch of three PRs (descriptor /4), the whole script: the bundle carries S, the receipt names the members and S's tree
   $k=Make-Chain
   try{
    $cbatch='0123456789abcdef-c4a1c4a1c4a1';$cob=Join-Path $res ('outbox\'+$cbatch);[void][IO.Directory]::CreateDirectory($cob)
    $members=@([ordered]@{pr=101;headSha=$c2},[ordered]@{pr=102;headSha=$k.x2},[ordered]@{pr=103;headSha=$k.x3})
    $cd=[ordered]@{contract=$ChainContract;batchId=$cbatch;repo='tdoljyj/cross-memory-system';pr=101;headSha=$c2;testSha=$k.s3;baseSha=$c1;testTree=$k.tree;members=$members;sourceCommit=$c1;gitleaksTomlSha256=(Hash-Text $toml)}
    [IO.File]::WriteAllText((Join-Path $cob 'descriptor.json'),($cd|ConvertTo-Json -Depth 5 -Compress))
    $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $cbatch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
    Yes ($code -eq 0 -and $v.status -ceq 'BUNDLE_WRITTEN') ('chain-main-block-answer:'+$out)
    $rc=[IO.File]::ReadAllText((Join-Path $res ('bundles\'+$cbatch+'\all-refs.receipt.json')))|ConvertFrom-Json
    $tm=New-RefMap;$tm[$TestPrefix+$k.s3]=$k.s3
    Yes ($rc.testSha -ceq $k.s3 -and $rc.testRefCount -eq 1 -and $rc.testRefListSha256 -ceq (Ref-List-Sha $tm) -and $rc.testTree -ceq $k.tree -and @($rc.chainMembers).Count -eq 3 -and
      $rc.chainMembers[0].pr -eq 101 -and $rc.chainMembers[1].headSha -ceq $k.x2 -and $rc.chainMembers[2].pr -eq 103 -and (@($rc.chainMembers[0].PSObject.Properties.Name)-join '|') -ceq 'pr|headSha') 'chain-main-block-receipt'
    $chh=Bundle-Header (Join-Path $res ('bundles\'+$cbatch+'\all-refs.bundle'));Yes (Same-Map $chh.test $tm) 'chain-main-block-bundle'
    # a /3 receipt never names a chain
    Yes ($null -eq $rf.PSObject.Properties['chainMembers'] -and $null -eq $rf.PSObject.Properties['testTree']) 'front-receipt-no-chain'
    # a /4 descriptor whose S is not that chain (its tree differs): refused by the script, nothing kept as a bundle
    $xbatch='0123456789abcdef-c4a1c4a1c4a2';$xob=Join-Path $res ('outbox\'+$xbatch);[void][IO.Directory]::CreateDirectory($xob)
    $xd=[ordered]@{};foreach($n in $cd.Keys){$xd[$n]=$cd[$n]};$xd['batchId']=$xbatch;$xd['testTree']=(& $g rev-parse "$c1^{tree}").Trim();[IO.File]::WriteAllText((Join-Path $xob 'descriptor.json'),($xd|ConvertTo-Json -Depth 5 -Compress))
    $out=(& powershell -NoProfile -NonInteractive -File $copy -BatchId $xbatch)-join '';$code=$LASTEXITCODE;$v=$out|ConvertFrom-Json
    Yes ($code -eq 2 -and $v.reason -ceq 'BATCH_TEST_TREE_CHANGED' -and -not (Test-Path -LiteralPath (Join-Path $res ('bundles\'+$xbatch+'\all-refs.receipt.json')))) ('chain-main-block-tree-refused:'+$out)
   }finally{Drop-Chain}
  }
 }finally{if($listener){$listener.Stop()};Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item Env:\GIT_CONFIG_GLOBAL,Env:\GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue}
}
$mainBlock=if(-not $git){'no-git'}elseif($mainBlockRun){'run'}else{'skipped-elevated'}
[pscustomobject]@{status='BUILD_BUNDLE_OFFLINE_PASS';cases=$cases;mainBlock=$mainBlock;networkUsed='loopback-only';hostWrite=$false}|ConvertTo-Json -Compress
