# Offline test of resident-v2/build-bundle.ps1 functions (no network beyond loopback, no ProgramData). The script's
# main block is never run: functions are taken from its AST, exactly like batch/test-pure.ps1 does.
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$tool=Join-Path (Split-Path -Parent $PSScriptRoot) 'build-bundle.ps1';$cases=0
function Yes([bool]$v,[string]$what){if(-not $v){throw ('BUNDLE_TEST_FAILED:'+$what)};$script:cases++}
function Refuse([scriptblock]$f,[string]$what){$no=$false;try{& $f}catch{$no=$true};Yes $no $what}
function Refused-With([scriptblock]$f,[string]$code,[string]$what){$got=$null;try{& $f}catch{$got=$_.Exception.Message};Yes ($got -ceq $code) ($what+':'+$got)}
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($tool,[ref]$t,[ref]$e);if($e.Count){throw 'BUILD_BUNDLE_PARSE_FAILED'}
$ReviewedPrefix='refs/reviewed/'
foreach($name in @('Utc','Hash-Bytes','Hash-Text','Absent','Quote-Arg','Invoke-Git','Assert-FormalRefName','New-RefMap','Split-Refs','Ref-Map','Same-Map','Ref-List-Sha','Reviewed-Map','Reviewed-Commits','Bundle-Header',
  'Build-Store','Retry-Allowed','Fetch-Store')){
 $f=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});if($f.Count -ne 1){throw ('FUNCTION_MISSING:'+$name)};. ([scriptblock]::Create($f[0].Extent.Text))
}
# The fixed values exactly as the script assigns them.
foreach($name in @('Common','NetworkSteps','RetryWithinSeconds')){
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
# reviewed records: exact count line, unique fingerprints, commits derived and sorted
$toml="# clued-reviewed-count: 2`n# clued-reviewed-finding: {`"fingerprint`":`"$($b):x:rule:1`",`"kinds`":[`"K`"]}`n# clued-reviewed-finding: {`"fingerprint`":`"$($a):y:rule:2`",`"kinds`":[`"K`"]}`n[allowlist]`n"
$r=Reviewed-Commits $toml;Yes ($r.findings -eq 2 -and @($r.commits).Count -eq 2 -and $r.commits[0] -ceq $a -and $r.sha256 -ceq (Hash-Text "$a`n$b`n")) 'reviewed-commits'
Refuse {Reviewed-Commits ($toml.Replace('count: 2','count: 3'))} 'reviewed-count-mismatch'
Refuse {Reviewed-Commits ($toml+"# clued-reviewed-finding: {`"fingerprint`":`"$($b):x:rule:1`",`"kinds`":[`"K`"]}`n")} 'reviewed-duplicate'
# Stalled transfers (lesson #916): every git call carries the low-speed abort, and only an early network failure is retried.
$i=[Array]::IndexOf($FixedCommon,'http.lowSpeedLimit=1000');Yes ($i -gt 0 -and $FixedCommon[$i-1] -ceq '-c') 'common-low-speed-limit'
$i=[Array]::IndexOf($FixedCommon,'http.lowSpeedTime=60');Yes ($i -gt 0 -and $FixedCommon[$i-1] -ceq '-c') 'common-low-speed-time'
Yes ((@($NetworkSteps)-join '|') -ceq 'fetch|ls-remote|fetch-reviewed' -and $RetryWithinSeconds -eq 900) 'retry-constants'
function Step([string]$l,[int]$x){return [ordered]@{label=$l;exitCode=$x;stderrChars=1}}
foreach($l in @('fetch','ls-remote','fetch-reviewed')){Yes (Retry-Allowed 'GIT_STEP_FAILED' (Step $l 128) 61) ('retry-'+$l)}
Yes (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 128) 899.9) 'retry-just-in-time'
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 128) 900)) 'no-retry-too-late'
foreach($l in @('init-bare','cat-file','source-gitleaks-toml','reviewed-closure','for-each-ref')){Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step $l 128) 61)) ('no-retry-'+$l)}
foreach($r in @('REMOTE_MAIN_BASE_CHANGED','FETCHED_REFS_DIFFER_FROM_LS_REMOTE','GIT_START_UNCONFIRMED','FIXED_BUNDLE_BUILD_UNCONFIRMED')){Yes (-not (Retry-Allowed $r (Step 'fetch' 128) 61)) ('no-retry-'+$r)}
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' $null 61)) 'no-retry-without-step'
Yes (-not (Retry-Allowed 'GIT_STEP_FAILED' (Step 'fetch' 0) 61)) 'no-retry-exit-0'
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
   return (& $realGit $Label $GitArgs)
  }
  function New-Case([hashtable]$Stalls,$Elapsed){
   $script:Root=Join-Path $tmp ('bundles\'+[Guid]::NewGuid().ToString('N').Substring(0,8));[void][IO.Directory]::CreateDirectory($script:Root)
   $script:FetchDir=Join-Path $script:Root 'fetch.git';$script:FetchDir2=Join-Path $script:Root 'fetch-2.git'
   $script:stalls=$Stalls;$script:calls=@();$script:created=@();$script:lastGit=$null;$script:stage='x';$script:attempts=1;$script:firstAttempt=$null
   $script:Head=$c2;$script:Base=$c1
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
  Yes ($s.dir -ceq $FetchDir -and $attempts -eq 1 -and $null -eq $firstAttempt -and -not (Test-Path -LiteralPath $FetchDir2) -and (Same-Map $s.remote $expected)) 'no-stall-one-attempt'
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
 }finally{if($listener){$listener.Stop()};Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item Env:\GIT_CONFIG_GLOBAL,Env:\GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue}
}
[pscustomobject]@{status='BUILD_BUNDLE_OFFLINE_PASS';cases=$cases;networkUsed='loopback-only';hostWrite=$false}|ConvertTo-Json -Compress
