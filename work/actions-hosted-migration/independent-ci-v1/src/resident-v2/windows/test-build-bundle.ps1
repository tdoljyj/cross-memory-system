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
  'Ref-Diff','Build-Store','Retry-Allowed','Race-Retry-Allowed','Fetch-Store','Branch-Only-Hint',
  'Remove-Tree','Test-RealDir','Seed-Lock','Seed-Unlock','Seed-Shape-Problem','Seed-Discard','Seed-Meta-Read','Unix-Now','Seed-Wanted','Seed-Begin','Seed-Prime','Seed-Drop-Refs','Seed-Failure','Seed-Error-Text','Seed-Bytes','Seed-Update')){
 $f=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});if($f.Count -ne 1){throw ('FUNCTION_MISSING:'+$name)};. ([scriptblock]::Create($f[0].Extent.Text))
}
# The fixed values exactly as the script assigns them.
foreach($name in @('Common','NetworkSteps','RetryWithinSeconds','MaxStoreAttempts','SeedNs','SeedMetaContract','SeedMinFullFetchSeconds','SeedConfigKeys','seedUse','seedAttempt','seedBusy','seedLockHeld','seedReport')){
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
# The branch-only hint (Decision 98fec682): only at the reviewed-commit steps, only for the listed reasons, only when the set holds d94cd486.
$d94='d94cd486e29a7362888fc32cd807ceb38890acb6'
$h=Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'GIT_STEP_FAILED' @($a,$d94,$b)
Yes ($h -cmatch 'd94cd486' -and $h -cmatch 'claude/gitleaks-midgen-reviewed-hold' -and $h -cmatch 'restore it' -and $h -cnotmatch 'https?:') 'branch-only-hint-names-the-branch'
Yes ($null -ne (Branch-Only-Hint 'reviewed-store-readback' 'REVIEWED_COMMIT_NOT_IN_STORE' @($d94))) 'branch-only-hint-readback'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'GIT_STEP_FAILED' @($a,$b))) 'no-hint-without-the-commit'
Yes ($null -eq (Branch-Only-Hint 'fetch-all-heads-and-tags' 'GIT_STEP_FAILED' @($d94))) 'no-hint-at-another-stage'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'REMOTE_MAIN_BASE_CHANGED' @($d94))) 'no-hint-for-another-reason'
Yes ($null -eq (Branch-Only-Hint 'fetch-reviewed-commits-by-sha' 'GIT_STEP_FAILED' @())) 'no-hint-for-an-empty-set'
# Stalled transfers (lesson #916): every git call carries the low-speed abort, and only an early network failure is retried.
$i=[Array]::IndexOf($FixedCommon,'http.lowSpeedLimit=1000');Yes ($i -gt 0 -and $FixedCommon[$i-1] -ceq '-c') 'common-low-speed-limit'
$i=[Array]::IndexOf($FixedCommon,'http.lowSpeedTime=300');Yes ($i -gt 0 -and $FixedCommon[$i-1] -ceq '-c') 'common-low-speed-time'
Yes ((@($NetworkSteps)-join '|') -ceq 'fetch|ls-remote|fetch-reviewed|fetch-test' -and $RetryWithinSeconds -eq 900 -and $MaxStoreAttempts -eq 3) 'retry-constants'
function Step([string]$l,[int]$x){return [ordered]@{label=$l;exitCode=$x;stderrChars=1}}
foreach($l in @('fetch','ls-remote','fetch-reviewed','fetch-test')){Yes (Retry-Allowed 'GIT_STEP_FAILED' (Step $l 128) 61) ('retry-'+$l)}
Yes (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 128) 899.9) 'retry-just-in-time'
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 128) 900)) 'no-retry-too-late'
foreach($l in @('init-bare','cat-file','source-gitleaks-toml','reviewed-closure','for-each-ref','test-cat-file','test-parents','for-each-ref-3')){Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step $l 128) 61)) ('no-retry-'+$l)}
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
  function Invoke-Git([string]$Label,[string[]]$GitArgs){
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
   return (& $realGit $Label $GitArgs)
  }
  function New-Case([hashtable]$Stalls,$Elapsed){
   $script:races=0;$script:lateRaces=0;$script:refsDiffer=$null;$script:FetchDir3=$null
   $script:Root=Join-Path $tmp ('bundles\'+[Guid]::NewGuid().ToString('N').Substring(0,8));[void][IO.Directory]::CreateDirectory($script:Root)
   $script:FetchDir=Join-Path $script:Root 'fetch.git';$script:FetchDir2=Join-Path $script:Root 'fetch-2.git';$script:FetchDir3=Join-Path $script:Root 'fetch-3.git'
   $script:stalls=$Stalls;$script:calls=@();$script:created=@();$script:lastGit=$null;$script:stage='x';$script:attempts=1;$script:firstAttempt=$null;$script:failedAttempts=@()
   $script:Head=$c2;$script:Base=$c1;$script:Test=$c2
   $script:seedUse=$false;$script:seedAttempt=$false;$script:seedBusy=$false;$script:seedLockHeld=$false;$script:seedReport=[ordered]@{enabled=$true;used=$false;reason=$null;discarded=$false;primeSeconds=$null;updated=$false;updateSkipped=$null;seedBytes=$null;error=$null}
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
   $script:seedUse=$false;$script:seedAttempt=$false;$script:seedBusy=$false;$script:seedLockHeld=$false
   $script:seedReport=[ordered]@{enabled=$true;used=$false;reason=$null;discarded=$false;primeSeconds=$null;updated=$false;updateSkipped=$null;seedBytes=$null;error=$null}
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

  # S6. the retry rules with a seed. A stalled GitHub fetch of a seeded attempt: the retry is unseeded, the seed stays.
  Reset-Seed;New-Case @{} $null;$st=Fetch-Store;Seed-Update $st;Slow-Meta
  New-Case @{fetch=1} $null;Seed-Begin;$s=Fetch-Store
  Yes ($s.dir -ceq $FetchDir2 -and $attempts -eq 2 -and $s.unseeded -eq $true -and @($calls|Where-Object{$_ -ceq 'seed-fetch'}).Count -eq 1 -and (Test-Path -LiteralPath $SeedDir) -and $firstAttempt.git.label -ceq 'fetch') 'stall-then-unseeded-retry'
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
  }
 }finally{if($listener){$listener.Stop()};Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item Env:\GIT_CONFIG_GLOBAL,Env:\GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue}
}
$mainBlock=if(-not $git){'no-git'}elseif($mainBlockRun){'run'}else{'skipped-elevated'}
[pscustomobject]@{status='BUILD_BUNDLE_OFFLINE_PASS';cases=$cases;mainBlock=$mainBlock;networkUsed='loopback-only';hostWrite=$false}|ConvertTo-Json -Compress
