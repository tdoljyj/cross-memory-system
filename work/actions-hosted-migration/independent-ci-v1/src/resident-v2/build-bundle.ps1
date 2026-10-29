<#
Source v2 per-batch all-refs bundle (DESIGN S9, §10.1). Parameterised successor of the reviewed manual
ws-prep-bNN\build-all-bundle.ps1: the same git hardening, ls-remote equality, main == base, reviewed
commits fetched by SHA, bundle header checks and create-only receipt, but every per-batch value comes
from the resident's public batch descriptor instead of being patched into the script by hand.

Run by the companion in the Owner's own logon session, NOT elevated, with the Owner's normal git
credential helper (read only; nothing is pushed or published):
  build-bundle.ps1 -BatchId <16hex-12hex>              build the bundle and receipt
  build-bundle.ps1 -BatchId <16hex-12hex> -CheckRefs   re-run ls-remote now and compare with the receipt

-CheckRefs is the deterministic "no push since the bundle" gate (lesson b29: the gitleaks preparation
needs every remote ref sealed; any push between bundle build and stage 2 is detected here and becomes
the clean transient failure REMOTE_REFS_CHANGED_SINCE_BUNDLE, eligible for the automatic attempt 2).

Differences to the b29 script (each a lesson): the reviewed set comes from the installed Source
commit's .gitleaks.toml (descriptor.sourceCommit, hash-pinned by the install record), not from the PR
head; the output directory is resident\bundles\<batchId>\ (Owner drop box, read by root through /mnt/c);
a receipt binds batchId, descriptor digest and Source commit.

Stalled transfers (lesson #916, 2026-10-23: a fetch stalled at 47 MB and held the resident until the companion's
35-minute deadline): an HTTP transfer slower than 1000 bytes/s for 60 s is aborted, and a failed network step gets one
more complete attempt in a second fresh bare repository (Fetch-Store), only while most of the companion's wait is left.

Train front batch (quota phase 2 step 3c-2, design v0.5 §5.2): the descriptor's tested commit S is GitHub's test merge of
[T, H] (S != H). Build-Store fetches it by SHA under refs/clued-test/<S> (no other name, at most one), checks that it is a
commit whose parents are exactly [T, H], and the bundle carries that one ref; the receipt counts it (testRefCount 0 when
S = H). Old test merges can disappear when GitHub recomputes: the fetch then fails like any network step, before the batch.
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{16}-[0-9a-f]{12}$')][string]$BatchId,[switch]$CheckRefs)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$Resident='C:\ProgramData\CluedIndependentCI\resident'
$Descriptor=Join-Path $Resident ('outbox\'+$BatchId+'\descriptor.json')
$Root=Join-Path $Resident ('bundles\'+$BatchId)
$Git='C:\Program Files\Git\cmd\git.exe'
$Url='https://github.com/tdoljyj/cross-memory-system.git'
$FetchDir=Join-Path $Root 'fetch.git';$FetchDir2=Join-Path $Root 'fetch-2.git';$Bundle=Join-Path $Root 'all-refs.bundle';$ReceiptPath=Join-Path $Root 'all-refs.receipt.json'
$ReviewedPrefix='refs/reviewed/';$TestPrefix='refs/clued-test/'
$Common=@('-c','core.hooksPath=C:/nonexistent-clued-hooks','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false',
  '-c','fetch.writeCommitGraph=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','init.templateDir=','-c','advice.defaultBranchName=false',
  '-c','http.lowSpeedLimit=1000','-c','http.lowSpeedTime=60')
# The steps that talk to GitHub. A full build takes 40-283 s (receipts of 2026-10-23); the companion waits 30 minutes
# (companion.mjs build-bundle). A retry starts only within the first 10 of them, so the second attempt has at least
# 20 minutes, twice what the first one can have used. A transfer that stays just above the low-speed limit is still
# not bounded: nothing here kills git.
$NetworkSteps=@('fetch','ls-remote','fetch-reviewed','fetch-test');$RetryWithinSeconds=600
$Clock=[Diagnostics.Stopwatch]::StartNew()
$stage='fixed-preflight';$created=@();$writesStarted=$false;$lastGit=$null;$attempts=1;$firstAttempt=$null
function Utc{return [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture)}
function Hash-Bytes([byte[]]$Bytes){$a=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($a.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$a.Dispose()}}
function Hash-File([string]$Path){$a=[Security.Cryptography.SHA256]::Create();$s=[IO.File]::Open($Path,'Open','Read','Read');try{return ([BitConverter]::ToString($a.ComputeHash($s))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose();$a.Dispose()}}
function Hash-Text([string]$Text){return Hash-Bytes ((New-Object Text.UTF8Encoding($false)).GetBytes($Text))}
function Absent([string]$Path){if(Test-Path -LiteralPath $Path){throw 'FIXED_TARGET_ALREADY_EXISTS'}}
function Quote-Arg([string]$A){
 if($A.Contains('"')){throw 'GIT_ARGUMENT_QUOTE_REFUSED'}
 if($A.Length -eq 0 -or $A -match '\s'){return '"'+($A -replace '(\\+)$','$1$1')+'"'}
 return $A
}
function Invoke-Git([string]$Label,[string[]]$GitArgs){
 $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=$Git;$psi.Arguments=((@($GitArgs)|ForEach-Object{Quote-Arg $_})-join ' ')
 $psi.UseShellExecute=$false;$psi.CreateNoWindow=$true;$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
 $psi.StandardOutputEncoding=New-Object Text.UTF8Encoding($false);$psi.StandardErrorEncoding=New-Object Text.UTF8Encoding($false);$psi.WorkingDirectory=$Root
 foreach($k in @($psi.EnvironmentVariables.Keys)){if($k -match '^(?i)GIT_'){$psi.EnvironmentVariables.Remove($k)}}
 $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT']='0';$psi.EnvironmentVariables['LANG']='C';$psi.EnvironmentVariables['LC_ALL']='C'
 $p=New-Object Diagnostics.Process;$p.StartInfo=$psi;if(-not $p.Start()){throw 'GIT_START_UNCONFIRMED'};$p.StandardInput.Close()
 $o=$p.StandardOutput.ReadToEndAsync();$e=$p.StandardError.ReadToEndAsync();$p.WaitForExit();$out=$o.Result;$err=$e.Result
 # Stderr is never printed: it is counted only, so no credential/URL text can leak.
 $script:lastGit=[ordered]@{label=$Label;exitCode=$p.ExitCode;stderrChars=$err.Length}
 if($p.ExitCode -ne 0){throw 'GIT_STEP_FAILED'}
 return $out
}
function Assert-FormalRefName([string]$Name){
 if($Name -cnotmatch '\Arefs/(heads|tags)/' -or $Name -match '[\\:\x00-\x20\x7f]' -or $Name.StartsWith('/') -or $Name -match '[~^?*\[\]@{]' -or
    $Name.EndsWith('.') -or $Name.EndsWith('.lock') -or $Name.Contains('..') -or @($Name.Split('/')|Where-Object{$_ -eq '' -or $_ -eq '.' -or $_ -eq '..'}).Count -ne 0){throw 'REMOTE_REF_NAME_FAILS_FORMAL_VALIDATION'}
}
function New-RefMap{return ,(New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal))}
function Split-Refs([string]$Text,[string]$Separator,[bool]$SkipPeeled,[bool]$AllowReviewed){
 $formal=New-RefMap;$reviewed=New-RefMap;$test=New-RefMap
 foreach($line in ($Text -split "`n")){
  $l=$line.TrimEnd("`r");if($l.Length -eq 0){continue}
  $parts=$l.Split([char[]]$Separator,2);if($parts.Count -ne 2 -or $parts[0] -cnotmatch '\A[0-9a-f]{40}\z'){throw 'EXACT_REF_LINE_REQUIRED'}
  if($SkipPeeled -and $parts[1].EndsWith('^{}')){continue}
  if($AllowReviewed -and $parts[1].StartsWith($ReviewedPrefix,[StringComparison]::Ordinal)){
   if($parts[1] -cne ($ReviewedPrefix+$parts[0])){throw 'EXACT_REVIEWED_REF_REQUIRED'}
   if($reviewed.ContainsKey($parts[1])){throw 'DUPLICATE_REF_REFUSED'};$reviewed[$parts[1]]=$parts[0];continue
  }
  if($AllowReviewed -and $parts[1].StartsWith($TestPrefix,[StringComparison]::Ordinal)){
   if($parts[1] -cne ($TestPrefix+$parts[0]) -or $test.Count -ne 0){throw 'EXACT_TEST_REF_REQUIRED'};$test[$parts[1]]=$parts[0];continue
  }
  Assert-FormalRefName $parts[1];if($formal.ContainsKey($parts[1])){throw 'DUPLICATE_REF_REFUSED'};$formal[$parts[1]]=$parts[0]
 }
 if($formal.Count -lt 1 -or $formal.Count -gt 10000){throw 'REF_COUNT_BOUND'}
 return [pscustomobject]@{formal=$formal;reviewed=$reviewed;test=$test}
}
function Ref-Map([string]$Text,[string]$Separator,[bool]$SkipPeeled){return ,((Split-Refs $Text $Separator $SkipPeeled $false).formal)}
function Same-Map($A,$B){if($A.Count -ne $B.Count){return $false};foreach($k in $A.Keys){if(-not $B.ContainsKey($k) -or $B[$k] -cne $A[$k]){return $false}};return $true}
function Ref-List-Sha($M){
 $names=[string[]]@($M.Keys);[Array]::Sort($names,[StringComparer]::Ordinal);$sb=New-Object Text.StringBuilder
 foreach($n in $names){$null=$sb.Append($M[$n]).Append(' ').Append($n).Append("`n")};return Hash-Text $sb.ToString()
}
function Reviewed-Map([string[]]$Commits){$m=New-RefMap;foreach($c in $Commits){$m[$ReviewedPrefix+$c]=$c};return ,$m}
# Deterministic extraction (prepare.mjs reviewedCommitsFromConfig). The toml itself is hash-pinned by the
# install record, so the derived count/digest need no separate constant here.
function Reviewed-Commits([string]$Text){
 if(-not $Text.EndsWith("`n") -or $Text -cmatch '[^\n\x20-\x7e]'){throw 'REVIEWED_RECORDS_AMBIGUOUS'}
 $lines=$Text.Substring(0,$Text.Length-1).Split([char]10)
 $counts=@($lines|Where-Object{$_.StartsWith('# clued-reviewed-count: ',[StringComparison]::Ordinal)})
 $fingerprints=New-Object 'Collections.Generic.List[string]'
 foreach($line in $lines){
  if(-not $line.StartsWith('# clued-reviewed-finding: ',[StringComparison]::Ordinal)){continue}
  try{$record=$line.Substring(26)|ConvertFrom-Json}catch{throw 'REVIEWED_RECORDS_AMBIGUOUS'}
  if($null -eq $record -or $record -isnot [pscustomobject]){throw 'REVIEWED_RECORDS_AMBIGUOUS'}
  $names=[string[]]@($record.PSObject.Properties|ForEach-Object{$_.Name});[Array]::Sort($names,[StringComparer]::Ordinal)
  if(($names -join '|') -cne 'fingerprint|kinds' -or $record.fingerprint -isnot [string]){throw 'REVIEWED_RECORDS_AMBIGUOUS'}
  $parts=$record.fingerprint.Split(':');if($parts.Count -ne 4 -or $parts[0] -cnotmatch '\A[0-9a-f]{40}\z'){throw 'REVIEWED_RECORDS_AMBIGUOUS'}
  $fingerprints.Add($record.fingerprint)
 }
 $distinct=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal);foreach($f in $fingerprints){$null=$distinct.Add($f)}
 if($counts.Count -ne 1 -or $counts[0] -cne ('# clued-reviewed-count: '+$fingerprints.Count) -or $distinct.Count -ne $fingerprints.Count){throw 'REVIEWED_RECORDS_AMBIGUOUS'}
 $set=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal);foreach($f in $fingerprints){$null=$set.Add($f.Substring(0,40))}
 $commits=[string[]]@($set);[Array]::Sort($commits,[StringComparer]::Ordinal)
 return [pscustomobject]@{commits=$commits;findings=$fingerprints.Count;sha256=(Hash-Text (($commits -join "`n")+"`n"))}
}
function Bundle-Header([string]$Path){
 $s=[IO.File]::Open($Path,'Open','Read','Read')
 try{$max=[int][Math]::Min($s.Length,8388608);$b=New-Object byte[] $max;$at=0;while($at -lt $max){$n=$s.Read($b,$at,$max-$at);if($n -lt 1){break};$at+=$n}}finally{$s.Dispose()}
 $end=-1;for($i=0;$i -lt $at-1;$i++){if($b[$i] -eq 10 -and $b[$i+1] -eq 10){$end=$i;break}}
 if($end -lt 0 -or $at -lt $end+6){throw 'COMPLETE_BUNDLE_HEADER_REQUIRED'}
 if(-not($b[$end+2] -eq 0x50 -and $b[$end+3] -eq 0x41 -and $b[$end+4] -eq 0x43 -and $b[$end+5] -eq 0x4b)){throw 'BUNDLE_PACK_SIGNATURE_REQUIRED'}
 for($i=0;$i -lt $end;$i++){if($b[$i] -ne 10 -and ($b[$i] -lt 32 -or $b[$i] -gt 126)){throw 'ASCII_BUNDLE_HEADER_REQUIRED'}}
 $lines=[Text.Encoding]::ASCII.GetString($b,0,$end).Split([char]10)
 if($lines[0] -cne '# v2 git bundle'){throw 'V2_SHA1_BUNDLE_REQUIRED'}
 $body=@($lines|Select-Object -Skip 1)
 if(@($body|Where-Object{$_.StartsWith('-') -or $_.StartsWith('@')}).Count -ne 0){throw 'BUNDLE_PREREQUISITE_OR_CAPABILITY_REFUSED'}
 return (Split-Refs ($body -join "`n") ' ' $false $true)
}
# The public batch descriptor written by the resident at derivation (engine-windows.mjs). Untrusted
# data for this script; it only selects the batch, head, base and Source commit.
function Read-Descriptor{
 $i=Get-Item -LiteralPath $Descriptor -Force;if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.Length -lt 1 -or $i.Length -gt 65536){throw 'DESCRIPTOR_REFUSED'}
 $raw=[IO.File]::ReadAllBytes($Descriptor);$d=(New-Object Text.UTF8Encoding($false,$true)).GetString($raw)|ConvertFrom-Json
 if($d.contract -cne 'clued.independent-ci.resident-batch-descriptor/3' -or $d.testSha -cnotmatch '\A[0-9a-f]{40}\z' -or $d.batchId -cne $BatchId -or $d.repo -cne 'tdoljyj/cross-memory-system' -or $d.headSha -cnotmatch '\A[0-9a-f]{40}\z' -or $d.baseSha -cnotmatch '\A[0-9a-f]{40}\z' -or $d.sourceCommit -cnotmatch '\A[0-9a-f]{40}\z' -or $d.gitleaksTomlSha256 -cnotmatch '\A[0-9a-f]{64}\z'){throw 'DESCRIPTOR_REFUSED'}
 # Step 3c-2: S != H only for a train front batch (GitHub's test merge of [T, H]); Build-Store fetches and checks it.
 return [pscustomobject]@{value=$d;sha256=(Hash-Bytes $raw)}
}
# One complete attempt at the fetched store, in a fresh bare repository of its own ($Dir must not exist yet): all heads
# and tags, ls-remote equality, main == base, then the reviewed commits fetched by SHA, each read back, then (train
# front batch only) the tested commit S by SHA with its parents [T, H].
function Build-Store([string]$Dir){
 $script:stage='fresh-bare-repository';Absent $Dir
 $null=Invoke-Git 'init-bare' (@('-c','init.templateDir=','init','--bare','--quiet','--template=',$Dir));$script:created+=$Dir
 if(Test-Path -LiteralPath (Join-Path $Dir 'hooks')){if(@(Get-ChildItem -LiteralPath (Join-Path $Dir 'hooks') -Force -Recurse -File).Count -ne 0){throw 'TEMPLATE_HOOKS_REFUSED'}}
 $gd='--git-dir='+$Dir
 $script:stage='fetch-all-heads-and-tags';$fetchStartedAt=Utc
 $null=Invoke-Git 'fetch' ($Common+@($gd,'fetch','--quiet','--no-tags','--no-write-fetch-head','--no-recurse-submodules',$Url,'+refs/heads/*:refs/heads/*','+refs/tags/*:refs/tags/*'))
 $fetchCompletedAt=Utc
 $script:stage='ls-remote-after-fetch'
 $remote=Ref-Map (Invoke-Git 'ls-remote' ($Common+@($gd,'ls-remote','--branches','--tags',$Url))) "`t" $true
 $lsRemoteCompletedAt=Utc
 $script:stage='fetched-store-readback'
 if((Invoke-Git 'is-shallow' ($Common+@($gd,'rev-parse','--is-shallow-repository'))).Trim() -cne 'false'){throw 'COMPLETE_HISTORY_REQUIRED'}
 foreach($f in @('shallow','info\grafts','objects\info\alternates','objects\info\http-alternates')){Absent (Join-Path $Dir $f)}
 $local=Ref-Map (Invoke-Git 'for-each-ref' ($Common+@($gd,'for-each-ref','--format=%(objectname) %(refname)'))) ' ' $false
 if(-not (Same-Map $local $remote)){throw 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE'}
 if(-not $local.ContainsKey('refs/heads/main') -or $local['refs/heads/main'] -cne $Base){throw 'REMOTE_MAIN_BASE_CHANGED'}
 foreach($s in @($Head,$Base,$desc.value.sourceCommit)){if((Invoke-Git 'cat-file' ($Common+@($gd,'cat-file','-t',$s))).Trim() -cne 'commit'){throw 'HEAD_BASE_SOURCE_COMMIT_MISSING'}}
 foreach($k in $local.Keys){$t=(Invoke-Git 'cat-file' ($Common+@($gd,'cat-file','-t',$local[$k]))).Trim()
  if(($k.StartsWith('refs/heads/') -and $t -cne 'commit') -or ($k.StartsWith('refs/tags/') -and $t -cne 'commit' -and $t -cne 'tag')){throw 'REMOTE_REF_TARGET_TYPE_UNSUPPORTED'}}
 $branchesAtHead=@($local.Keys|Where-Object{$_.StartsWith('refs/heads/') -and $local[$_] -ceq $Head}|Sort-Object)
 $script:stage='reviewed-commit-set'
 # From the INSTALLED Source commit's .gitleaks.toml (pinned by the record), never from the PR head.
 $toml=Invoke-Git 'source-gitleaks-toml' ($Common+@($gd,'cat-file','blob',($desc.value.sourceCommit+':.gitleaks.toml')))
 if((Hash-Text $toml) -cne $desc.value.gitleaksTomlSha256){throw 'TRUSTED_REVIEW_SOURCE_CHANGED'}
 $reviewed=Reviewed-Commits $toml;$expectedReviewed=Reviewed-Map $reviewed.commits
 $script:stage='fetch-reviewed-commits-by-sha';$reviewedFetchStartedAt=Utc
 $null=Invoke-Git 'fetch-reviewed' ($Common+@($gd,'fetch','--quiet','--no-tags','--no-write-fetch-head','--no-recurse-submodules',$Url)+@($reviewed.commits|ForEach-Object{'+'+$_+':'+$ReviewedPrefix+$_}))
 $reviewedFetchCompletedAt=Utc
 $script:stage='reviewed-store-readback'
 if((Invoke-Git 'is-shallow-2' ($Common+@($gd,'rev-parse','--is-shallow-repository'))).Trim() -cne 'false'){throw 'COMPLETE_HISTORY_REQUIRED'}
 foreach($f in @('shallow','info\grafts','objects\info\alternates','objects\info\http-alternates')){Absent (Join-Path $Dir $f)}
 $all=Split-Refs (Invoke-Git 'for-each-ref-2' ($Common+@($gd,'for-each-ref','--format=%(objectname) %(refname)'))) ' ' $false $true
 if(-not (Same-Map $all.formal $remote)){throw 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE'}
 if(-not (Same-Map $all.reviewed $expectedReviewed)){throw 'EXACT_REVIEWED_REF_SET_REQUIRED'}
 foreach($c in $reviewed.commits){if((Invoke-Git 'reviewed-cat-file' ($Common+@($gd,'cat-file','-t',$c))).Trim() -cne 'commit'){throw 'REVIEWED_COMMIT_NOT_IN_STORE'}}
 $null=Invoke-Git 'reviewed-closure' ($Common+@($gd,'rev-list','--objects','--quiet','--glob=refs/reviewed/*'))
 $expectedTest=New-RefMap
 if($Test -cne $Head){
  $script:stage='fetch-test-commit-by-sha'
  $null=Invoke-Git 'fetch-test' ($Common+@($gd,'fetch','--quiet','--no-tags','--no-write-fetch-head','--no-recurse-submodules',$Url,('+'+$Test+':'+$TestPrefix+$Test)))
  $script:stage='test-store-readback';$expectedTest[$TestPrefix+$Test]=$Test
  if((Invoke-Git 'is-shallow-3' ($Common+@($gd,'rev-parse','--is-shallow-repository'))).Trim() -cne 'false'){throw 'COMPLETE_HISTORY_REQUIRED'}
  foreach($f in @('shallow','info\grafts','objects\info\alternates','objects\info\http-alternates')){Absent (Join-Path $Dir $f)}
  if((Invoke-Git 'test-cat-file' ($Common+@($gd,'cat-file','-t',$Test))).Trim() -cne 'commit'){throw 'TEST_COMMIT_MISSING'}
  # Design v0.5 §5.2: S is GitHub's merge of exactly [T, H], checked on the object itself.
  if((Invoke-Git 'test-parents' ($Common+@($gd,'rev-list','--parents','-n','1',$Test))).Trim() -cne ($Test+' '+$Base+' '+$Head)){throw 'TEST_COMMIT_PARENTS_REQUIRED'}
 }
 $final=Split-Refs (Invoke-Git 'for-each-ref-3' ($Common+@($gd,'for-each-ref','--format=%(objectname) %(refname)'))) ' ' $false $true
 if(-not (Same-Map $final.formal $remote) -or -not (Same-Map $final.reviewed $expectedReviewed)){throw 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE'}
 if(-not (Same-Map $final.test $expectedTest)){throw 'EXACT_TEST_REF_REQUIRED'}
 return [pscustomobject]@{dir=$Dir;gd=$gd;remote=$remote;branchesAtHead=$branchesAtHead;reviewed=$reviewed;expectedReviewed=$expectedReviewed;expectedTest=$expectedTest
  fetchStartedAt=$fetchStartedAt;fetchCompletedAt=$fetchCompletedAt;lsRemoteCompletedAt=$lsRemoteCompletedAt;reviewedFetchStartedAt=$reviewedFetchStartedAt;reviewedFetchCompletedAt=$reviewedFetchCompletedAt}
}
# Only a network step that git itself failed is retried, and only early enough: never a refusal of this script
# (main moved, refs differ, a commit missing from the store), never a git that did not start. Stderr is not read, so
# a network failure that will repeat (credentials, a reviewed commit gone from GitHub) also costs one more attempt.
function Retry-Allowed([string]$Reason,$Step,[double]$ElapsedSeconds){
 return ($Reason -ceq 'GIT_STEP_FAILED' -and $null -ne $Step -and $NetworkSteps -ccontains $Step.label -and $Step.exitCode -ne 0 -and $ElapsedSeconds -lt $RetryWithinSeconds)
}
# The store with at most one retry. The second attempt runs every step and check again in its own new bare repository;
# whatever the first one left (a partial pack, refs) stays where it is and is never read again.
function Fetch-Store{
 try{return Build-Store $FetchDir}
 catch{
  if(-not (Retry-Allowed $_.Exception.Message $script:lastGit $Clock.Elapsed.TotalSeconds)){throw}
  $script:firstAttempt=[ordered]@{stage=$script:stage;git=$script:lastGit;failedAfterSeconds=[int]$Clock.Elapsed.TotalSeconds}
 }
 $script:attempts=2
 return Build-Store $FetchDir2
}
try{
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
 if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NON_ELEVATED_RUN_REQUIRED'}
 if(-not (Test-Path -LiteralPath $Git -PathType Leaf)){throw 'FIXED_GIT_FOR_WINDOWS_REQUIRED'}
 $desc=Read-Descriptor;$Head=$desc.value.headSha;$Base=$desc.value.baseSha;$Test=$desc.value.testSha
 if($CheckRefs){
  $stage='check-refs'
  $rec=[IO.File]::ReadAllText($ReceiptPath)|ConvertFrom-Json
  if($rec.contract -cne 'clued.independent-ci.resident-bundle-receipt/1' -or $rec.batchId -cne $BatchId -or $rec.descriptorSha256 -cne $desc.sha256){throw 'BUNDLE_RECEIPT_REFUSED'}
  $now=Ref-Map (Invoke-Git 'ls-remote-check' ($Common+@('ls-remote','--branches','--tags',$Url))) "`t" $true
  $sha=Ref-List-Sha $now;$same=$sha -ceq $rec.refListSha256
  [ordered]@{status=$(if($same){'REMOTE_REFS_UNCHANGED'}else{'REMOTE_REFS_CHANGED_SINCE_BUNDLE'});batchId=$BatchId;refListSha256=$sha;bundleRefListSha256=$rec.refListSha256;mainStillBase=($now.ContainsKey('refs/heads/main') -and $now['refs/heads/main'] -ceq $Base);checkedAt=(Utc);networkWrite=$false}|ConvertTo-Json -Compress
  exit 0
 }
 $ri=Get-Item -LiteralPath (Split-Path -Parent $Root) -Force;if(-not $ri.PSIsContainer -or ($ri.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'FIXED_REAL_BUNDLE_ROOT_REQUIRED'}
 Absent $Root
 $stage='batch-directory';$writesStarted=$true;[void][IO.Directory]::CreateDirectory($Root);$created+=$Root
 $gitVersion=(Invoke-Git 'version' @('--version')).Trim();$gitSha=Hash-File $Git
 $store=Fetch-Store
 $gd=$store.gd;$remote=$store.remote;$reviewed=$store.reviewed;$reviewedCommits=$reviewed.commits;$expectedReviewed=$store.expectedReviewed;$expectedTest=$store.expectedTest
 $stage='bundle-create'
 $null=Invoke-Git 'bundle-create' ($Common+@($gd,'bundle','create','--quiet','--version=2',$Bundle,'--branches','--tags','--glob=refs/reviewed/*','--glob=refs/clued-test/*'));$created+=$Bundle;$bundleCreatedAt=Utc
 $stage='bundle-verify'
 $null=Invoke-Git 'bundle-verify' ($Common+@($gd,'bundle','verify','--quiet',$Bundle))
 $header=Bundle-Header $Bundle
 if(-not (Same-Map $header.formal $remote)){throw 'BUNDLE_REFS_DIFFER_FROM_LS_REMOTE'}
 if(-not (Same-Map $header.reviewed $expectedReviewed)){throw 'BUNDLE_REVIEWED_REFS_CHANGED'}
 if(-not (Same-Map $header.test $expectedTest)){throw 'BUNDLE_TEST_REF_CHANGED'}
 $heads=Split-Refs (Invoke-Git 'bundle-list-heads' ($Common+@($gd,'bundle','list-heads',$Bundle))) ' ' $false $true
 if(-not (Same-Map $heads.formal $header.formal) -or -not (Same-Map $heads.reviewed $header.reviewed) -or -not (Same-Map $heads.test $header.test)){throw 'BUNDLE_LIST_HEADS_CHANGED'}
 $bytes=(Get-Item -LiteralPath $Bundle -Force).Length;$sha=Hash-File $Bundle
 $stage='receipt'
 $receipt=[ordered]@{contract='clued.independent-ci.resident-bundle-receipt/1';status='EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED';batchId=$BatchId;descriptorSha256=$desc.sha256
  repository='tdoljyj/cross-memory-system';url=$Url;bundleSha256=$sha;bundleBytes=$bytes;bundleVersion=2;prerequisites=0
  refCount=$header.formal.Count;refListSha256=(Ref-List-Sha $header.formal);refListCanonical='ordinal-sorted "<sha> <refname>\n", non-peeled tag objects, refs/heads and refs/tags only'
  reviewedRefPrefix=$ReviewedPrefix;reviewedRefCount=$header.reviewed.Count;reviewedRefListSha256=(Ref-List-Sha $header.reviewed)
  testSha=$Test;testRefPrefix=$TestPrefix;testRefCount=$header.test.Count;testRefListSha256=(Ref-List-Sha $header.test)
  reviewedCommitCount=$reviewedCommits.Count;reviewedFindingCount=$reviewed.findings;reviewedCommitsSha256=$reviewed.sha256;gitleaksTomlSha256=$desc.value.gitleaksTomlSha256;sourceCommit=$desc.value.sourceCommit
  mainSha=$Base;headSha=$Head;headPresent=$true;basePresent=$true;branchesAtHead=$store.branchesAtHead
  fetchStartedAt=$store.fetchStartedAt;fetchCompletedAt=$store.fetchCompletedAt;lsRemoteCompletedAt=$store.lsRemoteCompletedAt
  reviewedFetchStartedAt=$store.reviewedFetchStartedAt;reviewedFetchCompletedAt=$store.reviewedFetchCompletedAt;bundleCreatedAt=$bundleCreatedAt
  storeAttempts=$attempts;firstAttempt=$firstAttempt
  gitExecutableSha256=$gitSha;gitVersion=$gitVersion
  credentialsPrinted=$false;credentialsWrittenByScript=$false;existingCheckoutTouched=$false;wslTouched=$false;automaticRetryAllowed=$false}
 $json=($receipt|ConvertTo-Json -Depth 5 -Compress)
 $rb=(New-Object Text.UTF8Encoding($false)).GetBytes($json+[char]10);$f=[IO.File]::Open($ReceiptPath,'CreateNew','Write','None');try{$f.Write($rb,0,$rb.Length);$f.Flush($true)}finally{$f.Dispose()};$created+=$ReceiptPath
 [ordered]@{status='BUNDLE_WRITTEN';batchId=$BatchId;bundleSha256=$sha;bundleBytes=$bytes;receiptSha256=(Hash-Bytes $rb);refListSha256=$receipt.refListSha256;lsRemoteCompletedAt=$store.lsRemoteCompletedAt}|ConvertTo-Json -Compress
 exit 0
}catch{
 $code=if($_.Exception.Message -cmatch '\A[A-Z][A-Z0-9_]{1,90}\z'){$_.Exception.Message}else{'FIXED_BUNDLE_BUILD_UNCONFIRMED'}
 [ordered]@{status=$(if($writesStarted){'PARTIAL_STATE_PRESERVED_NO_RETRY'}else{'REFUSED_BEFORE_WRITE'});stage=$stage;reason=$code;git=$lastGit;created=$created
  storeAttempts=$attempts;firstAttempt=$firstAttempt;credentialsPrinted=$false;existingCheckoutTouched=$false;automaticRetryAllowed=$false}|ConvertTo-Json -Depth 5 -Compress;exit 2
}
