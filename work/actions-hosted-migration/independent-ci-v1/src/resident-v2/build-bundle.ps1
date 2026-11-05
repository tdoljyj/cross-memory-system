<#
Source v2 per-batch all-refs bundle (DESIGN S9, §10.1). Parameterised successor of the reviewed manual
ws-prep-bNN\build-all-bundle.ps1: the same git hardening, ls-remote equality, main == base, reviewed
commits fetched by SHA, bundle header checks and create-only receipt, but every per-batch value comes
from the resident's public batch descriptor instead of being patched into the script by hand.

Run by the companion in the Owner's own logon session, NOT elevated, with the Owner's normal git
credential helper (read only; nothing is pushed or published):
  build-bundle.ps1 -BatchId <16hex-12hex>              build the bundle and receipt
  build-bundle.ps1 -BatchId <16hex-12hex> -CheckRefs   re-run ls-remote now and compare with the receipt
  build-bundle.ps1 -BatchId <16hex-12hex> -Rebundle    the batch's second (and last) bundle generation, under gen-2
-CheckRefs is the deterministic "no push since the bundle" gate (lesson b29: the gitleaks preparation
needs every remote ref sealed; any push between bundle build and stage 2 is detected here and becomes
the clean transient failure REMOTE_REFS_CHANGED_SINCE_BUNDLE, eligible for the automatic attempt 2).

Differences to the b29 script (each a lesson): the reviewed set comes from the installed Source
commit's .gitleaks.toml (descriptor.sourceCommit, hash-pinned by the install record), not from the PR
head; the output directory is resident\bundles\<batchId>\ (Owner drop box, read by root through /mnt/c);
a receipt binds batchId, descriptor digest and Source commit.

Stalled transfers (lesson #916, 2026-10-23: a fetch stalled at 47 MB and held the resident until the companion's
35-minute deadline): an HTTP transfer slower than 1000 bytes/s for 300 s is aborted (60 s until 2026-11-04, when the
resident's egress was throttled to ~2.5 Mbit/s: 120-300 KB/s with stalls, a 64 MB repository took 213-533 s plus stalls, and a stall
of over 60 s at 58 MB aborted two attempts in a row, PR #992), and a failed network step gets one
more complete attempt in a second fresh bare repository (Fetch-Store), only while most of the companion's wait is left.

Refs pushed between the fetch and the ls-remote (a push to any branch of the repository in that window made the fetched refs
differ from ls-remote: FETCHED_REFS_DIFFER_FROM_LS_REMOTE, 2026-11-04 PR #990): that one inconsistency, found right after the
full fetch, gets up to two more complete attempts, each in its own new bare repository, in the same time window. Nothing
else changes: the later FETCHED_REFS_DIFFER_FROM_LS_REMOTE checks, main == base and every other refusal are final.

Train front batch (quota phase 2 step 3c-2, design v0.5 §5.2): the descriptor's tested commit S is GitHub's test merge of
[T, H] (S != H). Build-Store fetches it by SHA under refs/clued-test/<S> (no other name, at most one), checks that it is a
commit whose parents are exactly [T, H], and the bundle carries that one ref; the receipt counts it (testRefCount 0 when
S = H). Old test merges can disappear when GitHub recomputes: the fetch then fails like any network step, before the batch.

Persistent seed (DESIGN §10.1, tier 2): behind a slow egress the full fetch of the repository is most of the build, so a verified
copy of the last build's objects is kept in bundles\_seed\seed.git (same ACL as bundles\: the Owner's session writes, the
resident and root only read; no new install step). A seeded attempt fetches the seed's refs into a fresh bare repository under
refs/clued-seed/* (local fetch: every object is hashed again), fetches GitHub into the same repository (git then transfers only
what the seed lacks), deletes refs/clued-seed/* and then runs every check of an unseeded attempt unchanged: the repository is
still a new bare one without alternates or shallow, its refs are exactly ls-remote's, and only reachable objects go into the
bundle. The seed is advisory: any doubt about it (shape, config, local fetch, connectivity) discards it and the next attempt is
the unseeded one; a seed can add an attempt, never a refusal. It is updated only from a store that passed all checks and
produced the bundle. The receipt is unchanged; the script's answer carries a `seed` object. Unseeded runs are unchanged.

Second generation (Task 4012c1b9, DESIGN §37): a batch resumed from parking point A after a long hosted wait gets one more
bundle, right before its workspace, in bundles\<batchId>\gen-2\ with the same checks and a receipt that also names the
generation and the first bundle. The batch's refs must still be its own: main still the base T and some branch still at
the head H (REMOTE_HEAD_MOVED otherwise). Only with a complete first generation (REBUNDLE_REQUIRES_FIRST_GENERATION), never
twice (gen-2\ must not exist). -CheckRefs and prepare-workspaces.py use the newest complete generation; a gen-2\ without its
receipt is refused, never skipped (BUNDLE_GENERATION_INCOMPLETE).
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{16}-[0-9a-f]{12}$')][string]$BatchId,[switch]$CheckRefs,[switch]$Rebundle)
Set-StrictMode -Version 2
$ErrorActionPreference='Stop'
$Resident='C:\ProgramData\CluedIndependentCI\resident'
$Descriptor=Join-Path $Resident ('outbox\'+$BatchId+'\descriptor.json')
$Root=Join-Path $Resident ('bundles\'+$BatchId)
$Git='C:\Program Files\Git\cmd\git.exe'
$Url='https://github.com/tdoljyj/cross-memory-system.git'
$FetchDir=Join-Path $Root 'fetch.git';$FetchDir2=Join-Path $Root 'fetch-2.git';$FetchDir3=Join-Path $Root 'fetch-3.git';$Bundle=Join-Path $Root 'all-refs.bundle';$ReceiptPath=Join-Path $Root 'all-refs.receipt.json'
$Gen2Name='gen-2';$Gen1Root=$Root;$Gen1Receipt=$ReceiptPath;$Gen2Root=Join-Path $Root $Gen2Name;$Gen2Receipt=Join-Path $Gen2Root 'all-refs.receipt.json'
$ReviewedPrefix='refs/reviewed/';$TestPrefix='refs/clued-test/'
$Common=@('-c','core.hooksPath=C:/nonexistent-clued-hooks','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false',
  '-c','fetch.writeCommitGraph=false','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','init.templateDir=','-c','advice.defaultBranchName=false',
  '-c','http.lowSpeedLimit=1000','-c','http.lowSpeedTime=300')
# The steps that talk to GitHub. A full build takes 40-283 s (receipts of 2026-10-23); the companion waits 30 minutes
# (companion.mjs build-bundle). A retry starts only within the first 15 of them, so the second attempt has at least
# 15 minutes. A transfer that stays just above the low-speed limit is still not bounded: nothing here kills git. Under
# the 2026-11-04 throttle (120-300 KB/s, 64 MB: one transfer is 213-533 s) a dead connection is given up after the
# 300 s low-speed window. A first attempt that stalls as late as the end of the slowest complete transfer (533 s) therefore
# fails at about 833 s, still inside the 900 s retry window (it was 600 s, which that stall missed: no retry at all),
# and the second attempt has the rest of the 30 minutes: one complete transfer at the slowest rate plus one stall.
$NetworkSteps=@('fetch','ls-remote','fetch-reviewed','fetch-test');$RetryWithinSeconds=900;$MaxStoreAttempts=3
$Clock=[Diagnostics.Stopwatch]::StartNew()
# The persistent seed. Under bundles\ so that it inherits bundles\'s ACL (Owner modify, resident read): installing it needs no ACL change.
$SeedRoot=Join-Path $Resident 'bundles\_seed';$SeedDir=Join-Path $SeedRoot 'seed.git';$SeedNew=Join-Path $SeedRoot 'seed-new.git';$SeedLock=Join-Path $SeedRoot 'seed.lock';$SeedMeta=Join-Path $SeedRoot 'seed-meta.json'
$SeedNs='refs/clued-seed/';$SeedMetaContract='clued.independent-ci.bundle-seed-meta/1'
# Used only while the last full (unseeded) fetch took at least this long; after a day it is measured again with one unseeded fetch.
$SeedMinFullFetchSeconds=90;$SeedMetaMaxAgeSeconds=86400;$SeedLockStaleSeconds=1800;$SeedMaxPacks=12;$SeedMaxBytes=1073741824
# Generation 10 (DESIGN 53.2): a GitHub step that failed on the network is noted in seed-meta.json; for this long after it every build
# uses the seed (whatever the measurement says), and a network retry in the same build uses it too. Advisory like the rest of the meta.
$SeedAfterNetworkFailureSeconds=21600
$SeedConfigKeys=@('core.repositoryformatversion','core.filemode','core.bare','core.symlinks','core.ignorecase','core.logallrefupdates')
$seedUse=$false;$seedAttempt=$false;$seedBusy=$false;$seedLockHeld=$false;$seedAvailable=$false
$seedReport=[ordered]@{enabled=$true;used=$false;reason=$null;discarded=$false;primeSeconds=$null;updated=$false;updateSkipped=$null;seedBytes=$null;error=$null;networkFailureNoted=$false}
$stage='fixed-preflight';$created=@();$writesStarted=$false;$lastGit=$null;$attempts=1;$firstAttempt=$null;$failedAttempts=@();$refsDiffer=$null;$reviewedCommits=@()
# Reviewed commits that GitHub serves only because a branch still carries them (Decision 98fec682). Git stderr is never read,
# so the hint cannot say which commit is missing: it is given when the reviewed set contains such a commit and the step that
# fetches or reads the reviewed commits failed. It names public facts only (a short commit id and a branch name).
function Branch-Only-Hint([string]$Stage,[string]$Reason,$Commits){
 # One fixed text per commit: the companion logs a hint only when it equals this text byte for byte (companion.mjs BUNDLE_BRANCH_ONLY_HINT).
 # Empty since PR #991 brought d94cd486 into main (DESIGN 52): no reviewed commit is kept alive by a branch only.
 $branchOnly=@{}
 if(@('fetch-reviewed-commits-by-sha','reviewed-store-readback') -cnotcontains $Stage){return $null}
 if(@('GIT_STEP_FAILED','REVIEWED_COMMIT_NOT_IN_STORE','EXACT_REVIEWED_REF_SET_REQUIRED') -cnotcontains $Reason){return $null}
 $hit=@(@($Commits)|Where-Object{$branchOnly.ContainsKey($_)})
 if($hit.Count -eq 0){return $null}
 return $branchOnly[$hit[0]]
}
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
# The refs on which two maps disagree (missing on one side, or another object), ordinal-sorted, with their number.
function Ref-Diff($A,$B){
 $names=New-Object 'Collections.Generic.List[string]'
 foreach($k in $A.Keys){if(-not $B.ContainsKey($k) -or $B[$k] -cne $A[$k]){$names.Add($k)}}
 foreach($k in $B.Keys){if(-not $A.ContainsKey($k)){$names.Add($k)}}
 $s=[string[]]@($names);[Array]::Sort($s,[StringComparer]::Ordinal)
 return [ordered]@{count=$s.Count;refs=@($s|Select-Object -First 8)}
}
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
# A bundle receipt of this batch and descriptor (either generation).
function Read-BundleReceipt([string]$Path,[string]$DescriptorSha){
 $i=Get-Item -LiteralPath $Path -Force;if($i.PSIsContainer -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.Length -lt 1 -or $i.Length -gt 1048576){throw 'BUNDLE_RECEIPT_REFUSED'}
 $r=[IO.File]::ReadAllText($Path)|ConvertFrom-Json
 if($r.contract -cne 'clued.independent-ci.resident-bundle-receipt/1' -or $r.batchId -cne $BatchId -or $r.descriptorSha256 -cne $DescriptorSha -or $r.bundleSha256 -cnotmatch '\A[0-9a-f]{64}\z' -or $r.refListSha256 -cnotmatch '\A[0-9a-f]{64}\z'){throw 'BUNDLE_RECEIPT_REFUSED'}
 return $r
}
# The receipt of the newest complete generation: gen-2\ when it exists (its receipt then must exist too), else the first.
function Current-Receipt{
 if(Test-Path -LiteralPath $Gen2Root){if(-not (Test-Path -LiteralPath $Gen2Receipt -PathType Leaf)){throw 'BUNDLE_GENERATION_INCOMPLETE'};return $Gen2Receipt}
 return $Gen1Receipt
}
# ---- The persistent seed. Everything here is best effort: an exception in any of it ends in Seed-Discard, never in a refusal. ----
# Removes a tree without ever following a link (a junction or symlink is removed itself); git's object files are read-only.
function Remove-Tree([string]$P){
 if(([IO.File]::GetAttributes($P) -band [IO.FileAttributes]::ReparsePoint) -ne 0){[IO.Directory]::Delete($P);return}
 foreach($c in [IO.Directory]::GetFileSystemEntries($P)){
  $a=[IO.File]::GetAttributes($c);$dir=(($a -band [IO.FileAttributes]::Directory) -ne 0)
  if(($a -band [IO.FileAttributes]::ReparsePoint) -ne 0){if($dir){[IO.Directory]::Delete($c)}else{[IO.File]::Delete($c)}}
  elseif($dir){Remove-Tree $c}
  else{[IO.File]::SetAttributes($c,[IO.FileAttributes]::Normal);[IO.File]::Delete($c)}
 }
 [IO.File]::SetAttributes($P,[IO.FileAttributes]::Directory);[IO.Directory]::Delete($P)
}
function Test-RealDir([string]$P){if(-not (Test-Path -LiteralPath $P -PathType Container)){return $false};return (((Get-Item -LiteralPath $P -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)}
# One writer at a time, never waited for: a lock held by someone else (or younger than half an hour) means "no seed this time".
function Seed-Lock{
 $f=$null
 try{$f=[IO.File]::Open($SeedLock,'CreateNew','Write','None')}
 catch [IO.IOException]{
  # The take-over of a stale lock is as best-effort as the rest: whatever goes wrong in it (the lock vanished, is held open, could not be
  # removed, or someone else created it in between) means "busy", never an exception out of here.
  try{
   $age=((Get-Date).ToUniversalTime()-(Get-Item -LiteralPath $SeedLock -Force).LastWriteTimeUtc).TotalSeconds
   if($age -lt $SeedLockStaleSeconds){return $false}
   Remove-Item -LiteralPath $SeedLock -Force
   $f=[IO.File]::Open($SeedLock,'CreateNew','Write','None')
  }catch{return $false}
 }
 try{$b=(New-Object Text.UTF8Encoding($false)).GetBytes((Utc)+' pid='+$PID);$f.Write($b,0,$b.Length)}finally{$f.Dispose()}
 $script:seedLockHeld=$true
 return $true
}
function Seed-Unlock{$script:seedLockHeld=$false;Remove-Item -LiteralPath $SeedLock -Force -ErrorAction SilentlyContinue}
# $null when the seed has exactly the shape this script gives it: a real directory tree, no alternates, shallow file, grafts, gitfile
# redirection, hooks, and a config of the plain bare-repository keys only (a seed's own config is read by git when it serves a fetch).
function Seed-Shape-Problem{
 if(-not (Test-RealDir $SeedRoot) -or -not (Test-RealDir $SeedDir)){return 'SEED_PATH_NOT_REAL_DIRECTORY'}
 foreach($f in @('objects\info\alternates','objects\info\http-alternates','shallow','info\grafts','commondir','gitdir','worktrees','modules')){if(Test-Path -LiteralPath (Join-Path $SeedDir $f)){return 'SEED_UNEXPECTED_ENTRY'}}
 foreach($d in @('objects','refs')){if(-not (Test-RealDir (Join-Path $SeedDir $d))){return 'SEED_LAYOUT_REFUSED'}}
 if(-not (Test-Path -LiteralPath (Join-Path $SeedDir 'HEAD') -PathType Leaf)){return 'SEED_LAYOUT_REFUSED'}
 $h=Join-Path $SeedDir 'hooks';if((Test-Path -LiteralPath $h) -and @(Get-ChildItem -LiteralPath $h -Force -Recurse -File).Count -ne 0){return 'SEED_HOOKS_PRESENT'}
 $cfg=Join-Path $SeedDir 'config';if(-not (Test-Path -LiteralPath $cfg -PathType Leaf) -or (Get-Item -LiteralPath $cfg -Force).Length -gt 4096){return 'SEED_CONFIG_REFUSED'}
 $kept=0
 foreach($line in ((Invoke-Git 'seed-config' @('config','--file',$cfg,'--list')) -split "`n")){
  $l=$line.TrimEnd("`r");if($l.Length -eq 0){continue}
  $eq=$l.IndexOf('=');if($eq -lt 1){return 'SEED_CONFIG_REFUSED'}
  $k=$l.Substring(0,$eq);$v=$l.Substring($eq+1)
  if($SeedConfigKeys -cnotcontains $k){return 'SEED_CONFIG_REFUSED'}
  if(($k -ceq 'core.bare' -and $v -cne 'true') -or ($k -ceq 'core.repositoryformatversion' -and $v -cne '0')){return 'SEED_CONFIG_REFUSED'}
  $kept++
 }
 if($kept -lt 1){return 'SEED_CONFIG_REFUSED'}
 return $null
}
# Removes the seed. Only with the seed lock: a lock held by someone else (a build that is priming from or updating the seed right now) means
# the seed is left alone ("discarded" stays false, the answer's error says why); this run does not use it either way.
function Seed-Discard([string]$Why){
 $script:seedUse=$false;$script:seedAvailable=$false;$script:seedReport.reason=$Why
 $took=$false
 try{
  if(-not $script:seedLockHeld){
   try{$took=Seed-Lock}catch{$took=$false}
   if(-not $took){$script:seedReport.error='SEED_DISCARD_SKIPPED_LOCK_HELD_BY_ANOTHER';return}
  }
  $script:seedReport.discarded=$true
  # The network-failure note (generation 10) is about the network, not about this seed: it outlives the seed.
  $failedAt=Seed-Meta-Failure-At
  try{
   if(Test-Path -LiteralPath $SeedDir){
    if(Test-RealDir $SeedDir){Remove-Tree $SeedDir}
    elseif(Test-Path -LiteralPath $SeedDir -PathType Container){[IO.Directory]::Delete($SeedDir)}
    else{[IO.File]::Delete($SeedDir)}
   }
  }catch{try{[IO.Directory]::Move($SeedDir,(Join-Path $SeedRoot ('dead-'+[Guid]::NewGuid().ToString('N').Substring(0,8))))}catch{}}
  Remove-Item -LiteralPath $SeedMeta -Force -ErrorAction SilentlyContinue
  if($null -ne $failedAt){try{[IO.File]::WriteAllText($SeedMeta,(([ordered]@{contract=$SeedMetaContract;updatedAt=(Utc);lastNetworkFailureAtUnix=$failedAt}|ConvertTo-Json -Compress)+"`n"),(New-Object Text.UTF8Encoding($false)))}catch{}}
 }finally{if($took){Seed-Unlock}}
}
# Advisory facts about the last unseeded fetch; unreadable or odd is "no measurement", never an error.
function Seed-Meta-Read{
 try{
  $m=Seed-Meta-Object
  if($null -eq $m){return $null}
  if(($m.lastFullFetchSeconds -isnot [int] -and $m.lastFullFetchSeconds -isnot [long] -and $m.lastFullFetchSeconds -isnot [double]) -or ($m.lastFullFetchAtUnix -isnot [int] -and $m.lastFullFetchAtUnix -isnot [long] -and $m.lastFullFetchAtUnix -isnot [double])){return $null}
  return $m
 }catch{return $null}
}
# The meta file as an object when it is small and of this contract, else null (never an error).
function Seed-Meta-Object{
 try{
  if(-not (Test-Path -LiteralPath $SeedMeta -PathType Leaf)){return $null}
  if((Get-Item -LiteralPath $SeedMeta -Force).Length -gt 4096){return $null}
  $m=[IO.File]::ReadAllText($SeedMeta)|ConvertFrom-Json
  if($null -eq $m -or $m.contract -cne $SeedMetaContract){return $null}
  return $m
 }catch{return $null}
}
# Generation 10: when a GitHub step of a build last failed on the network (unix seconds), or null. Read on its own, so a meta that
# holds only this (no measurement yet) still says it.
function Seed-Meta-Failure-At{
 try{
  $m=Seed-Meta-Object
  if($null -eq $m -or $null -eq $m.PSObject.Properties['lastNetworkFailureAtUnix']){return $null}
  $v=$m.lastNetworkFailureAtUnix
  if($v -isnot [int] -and $v -isnot [long] -and $v -isnot [double]){return $null}
  return [long]$v
 }catch{return $null}
}
function Unix-Now([DateTime]$NowUtc){return [long][Math]::Floor(($NowUtc-(New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc))).TotalSeconds)}
# $FailureAtUnix (generation 10): a network failure noted in the last $SeedAfterNetworkFailureSeconds turns the seed on whatever the
# measurement says (a time in the future is ignored: the meta is advisory and a wrong clock must not keep the seed on).
function Seed-Wanted($Meta,[DateTime]$NowUtc,$FailureAtUnix=$null){
 if($null -ne $FailureAtUnix){$age=(Unix-Now $NowUtc)-[long]$FailureAtUnix;if($age -ge 0 -and $age -le $SeedAfterNetworkFailureSeconds){return [pscustomobject]@{use=$true;reason='RECENT_NETWORK_FAILURE'}}}
 if($null -eq $Meta){return [pscustomobject]@{use=$true;reason='NO_MEASUREMENT'}}
 if(((Unix-Now $NowUtc)-[long]$Meta.lastFullFetchAtUnix) -gt $SeedMetaMaxAgeSeconds){return [pscustomobject]@{use=$false;reason='REMEASURE_DUE'}}
 if([double]$Meta.lastFullFetchSeconds -lt $SeedMinFullFetchSeconds){return [pscustomobject]@{use=$false;reason='NETWORK_FAST'}}
 return [pscustomobject]@{use=$true;reason='NETWORK_SLOW'}
}
function Seed-Begin{
 $r=$script:seedReport
 try{
  if(-not (Test-Path -LiteralPath $SeedDir)){$r.reason='NO_SEED';return}
  $problem=Seed-Shape-Problem
  if($null -ne $problem){Seed-Discard $problem;return}
  # A seed that passed its shape check: a network retry of this build may use it even when the measurement does not (generation 10).
  $script:seedAvailable=$true
  $w=Seed-Wanted (Seed-Meta-Read) ([DateTime]::UtcNow) (Seed-Meta-Failure-At);$r.reason=$w.reason
  if($w.use){$script:seedUse=$true}
 }catch{Seed-Discard 'SEED_CHECK_FAILED'}
}
# Generation 10 (DESIGN 53.2): a GitHub step failed on the network. Noted in seed-meta.json (the measurement fields are kept as they
# were), so the next builds use the seed for $SeedAfterNetworkFailureSeconds. Best effort: a busy lock, a meta that cannot be written or
# a seed root that is not a real directory only leave networkFailureNoted false; nothing here ever fails the build.
function Seed-Note-Network-Failure{
 $locked=$false
 try{
  [void][IO.Directory]::CreateDirectory($SeedRoot);if(-not (Test-RealDir $SeedRoot)){return}
  $locked=Seed-Lock;if(-not $locked){return}
  $prev=Seed-Meta-Read
  $meta=[ordered]@{contract=$SeedMetaContract;updatedAt=(Utc)}
  if($null -ne $prev){$meta['lastFullFetchSeconds']=$prev.lastFullFetchSeconds;$meta['lastFullFetchAtUnix']=$prev.lastFullFetchAtUnix}
  $meta['lastNetworkFailureAtUnix']=Unix-Now ([DateTime]::UtcNow)
  [IO.File]::WriteAllText($SeedMeta,(($meta|ConvertTo-Json -Compress)+"`n"),(New-Object Text.UTF8Encoding($false)))
  $script:seedReport.networkFailureNoted=$true
 }catch{}finally{if($locked){Seed-Unlock}}
}
# Generation 10: the network retry of this build uses the seed when one passed its shape check at the start (and was not discarded or
# found busy since), also when the measurement had left it off. The seed stays advisory: a seed that fails in the retry is SEED_UNUSABLE
# and an unseeded attempt follows, like any seeded attempt (a seeded attempt is never the last one).
function Seed-After-Network-Failure{
 if($script:seedUse -or -not $script:seedAvailable -or $script:seedBusy -or -not (Test-Path -LiteralPath $SeedDir)){return}
 $script:seedUse=$true;$script:seedReport.reason='SEEDED_AFTER_NETWORK_FAILURE'
}
# Inside a seeded attempt, right after init-bare: the seed's refs/heads, tags and reviewed refs under refs/clued-seed/ by a local fetch
# (every object is hashed again by index-pack; its own connectivity check runs). Any trouble is SEED_UNUSABLE.
function Seed-Prime([string]$Gd){
 $script:stage='seed-prime';$sw=[Diagnostics.Stopwatch]::StartNew();$locked=$false
 try{
  $locked=Seed-Lock;if(-not $locked){$script:seedBusy=$true;throw 'SEED_BUSY'}
  $p=Seed-Shape-Problem;if($null -ne $p){throw $p}
  $null=Invoke-Git 'seed-fetch' ($Common+@('-c','protocol.file.allow=always',$Gd,'fetch','--quiet','--no-tags','--no-write-fetch-head','--no-recurse-submodules',$SeedDir,('+refs/heads/*:'+$SeedNs+'heads/*'),('+refs/tags/*:'+$SeedNs+'tags/*'),('+refs/reviewed/*:'+$SeedNs+'reviewed/*')))
 }catch{if($script:seedReport.reason -cnotmatch '\ASEED_'){$script:seedReport.reason='SEED_PRIME_FAILED'};throw 'SEED_UNUSABLE'}
 finally{if($locked){Seed-Unlock}}
 $script:seedReport.used=$true;$script:seedReport.primeSeconds=[int]$sw.Elapsed.TotalSeconds
}
# After the GitHub fetch of a seeded attempt: the seed's refs go (the loose ref files under refs\clued-seed, then a check through git
# that no such ref is left, packed or not), and what the checks will compare is reachable from heads and tags in full.
function Seed-Drop-Refs([string]$Dir,[string]$Gd){
 try{
  $ns=Join-Path $Dir 'refs\clued-seed';if(Test-Path -LiteralPath $ns){Remove-Tree $ns}
  if(-not [string]::IsNullOrWhiteSpace((Invoke-Git 'seed-refs-left' ($Common+@($Gd,'for-each-ref','--format=%(refname)',$SeedNs))))){throw 'SEED_REFS_REMAIN'}
  $null=Invoke-Git 'seed-connectivity' ($Common+@($Gd,'rev-list','--objects','--quiet','--branches','--tags'))
 }catch{$script:seedReport.reason='SEED_DROP_FAILED';throw 'SEED_UNUSABLE'}
}
# Called from Fetch-Store's catch with the failed attempt's reason: true = the seed was the problem and an unseeded attempt may follow.
function Seed-Failure([string]$Reason){
 if(-not $script:seedAttempt){return $false}
 if($Reason -ceq 'SEED_UNUSABLE'){
  if($script:seedBusy){$script:seedUse=$false;$script:seedReport.reason='SEED_BUSY'}else{Seed-Discard $script:seedReport.reason}
  return $true
 }
 # A git step of a seeded attempt failed. Generation 10 (DESIGN 53.2): a network retry (when the window allows it) uses the seed again:
 # what failed is GitHub's transfer, not the seed, and the seeded retry asks GitHub for the increment only. (Before generation 10 the
 # retry ran unseeded and fetched the whole repository again over the same failing line.) Nothing else is retried for it.
 return $false
}
# What failed, for the answer only: a code, or the exception's first 80 characters of plain text, and the last git step.
function Seed-Error-Text($ErrorRecord){
 $m=[string]$ErrorRecord.Exception.Message;$m=($m -replace '[^A-Za-z0-9_ .:\-]','');if($m.Length -gt 80){$m=$m.Substring(0,80)}
 $g=if($null -ne $script:lastGit){$script:lastGit.label+' '+$script:lastGit.exitCode}else{''}
 return ($m+' | '+$g)
}
function Seed-Bytes{
 $co=Invoke-Git 'seed-count' ($Common+@(('--git-dir='+$SeedDir),'count-objects','-v'));$kib=0;$packs=0
 foreach($l in ($co -split "`n")){$m=[regex]::Match($l.TrimEnd("`r"),'\A(size|size-pack|packs): (\d+)\z');if($m.Success){if($m.Groups[1].Value -ceq 'packs'){$packs=[int]$m.Groups[2].Value}else{$kib+=[long]$m.Groups[2].Value}}}
 return [pscustomobject]@{bytes=($kib*1024);packs=$packs}
}
# After the bundle and receipt are written: bring the seed to the state of this verified store (heads, tags and reviewed refs, pruned).
# A missing seed, a seed that fails its shape check or one that outgrew $SeedMaxBytes after a repack is made again from this store.
function Seed-Update($Store){
 $r=$script:seedReport;$locked=$false
 try{
  [void][IO.Directory]::CreateDirectory($SeedRoot);if(-not (Test-RealDir $SeedRoot)){$r.updateSkipped='SEED_ROOT_NOT_REAL_DIRECTORY';return}
  $locked=Seed-Lock;if(-not $locked){$r.updateSkipped='SEED_BUSY';return}
  $prev=Seed-Meta-Read
  for($pass=1;$pass -le 2;$pass++){
   $made=$false
   if(Test-Path -LiteralPath $SeedDir){$p=Seed-Shape-Problem;if($null -ne $p){Seed-Discard $p}}
   $target=$SeedDir
   if(-not (Test-Path -LiteralPath $SeedDir)){
    if(Test-Path -LiteralPath $SeedNew){Remove-Tree $SeedNew}
    $null=Invoke-Git 'seed-init' @('-c','init.templateDir=','init','--bare','--quiet','--template=',$SeedNew);$target=$SeedNew;$made=$true
   }
   $null=Invoke-Git 'seed-update' ($Common+@('-c','protocol.file.allow=always','-c','fetch.unpackLimit=1',('--git-dir='+$target),'fetch','--quiet','--no-tags','--no-write-fetch-head','--prune','--no-recurse-submodules',$Store.dir,'+refs/heads/*:refs/heads/*','+refs/tags/*:refs/tags/*','+refs/reviewed/*:refs/reviewed/*'))
   if($made){[IO.Directory]::Move($SeedNew,$SeedDir)}
   $sz=Seed-Bytes
   if($sz.packs -gt $SeedMaxPacks){$null=Invoke-Git 'seed-repack' ($Common+@(('--git-dir='+$SeedDir),'repack','-a','-d','-q'));$sz=Seed-Bytes}
   if($sz.bytes -le $SeedMaxBytes){$r.seedBytes=$sz.bytes;break}
   if($pass -eq 2){throw 'SEED_TOO_LARGE'}
   Seed-Discard 'SEED_OUTGREW_LIMIT'
  }
  $secs=$null;$at=$null
  if($Store.unseeded){$secs=[int][Math]::Ceiling($Store.fetchSeconds);$at=Unix-Now ([DateTime]::UtcNow)}
  elseif($null -ne $prev){$secs=$prev.lastFullFetchSeconds;$at=$prev.lastFullFetchAtUnix}
  $meta=[ordered]@{contract=$SeedMetaContract;updatedAt=(Utc)}
  if($null -ne $secs){$meta['lastFullFetchSeconds']=$secs;$meta['lastFullFetchAtUnix']=$at}
  # The network-failure note (generation 10) is kept until it ages out: a build that got through once does not mean the line is good.
  $failedAt=Seed-Meta-Failure-At;if($null -ne $failedAt){$meta['lastNetworkFailureAtUnix']=$failedAt}
  [IO.File]::WriteAllText($SeedMeta,(($meta|ConvertTo-Json -Compress)+"`n"),(New-Object Text.UTF8Encoding($false)))
  $r.updated=$true
 }catch{$r.updated=$false;$r.error=Seed-Error-Text $_;Seed-Discard 'SEED_UPDATE_FAILED'}
 finally{if($locked){Seed-Unlock}}
}
# One complete attempt at the fetched store, in a fresh bare repository of its own ($Dir must not exist yet): all heads
# and tags, ls-remote equality, main == base, then the reviewed commits fetched by SHA, each read back, then (train
# front batch only) the tested commit S by SHA with its parents [T, H].
function Build-Store([string]$Dir){
 $script:stage='fresh-bare-repository';$script:refsDiffer=$null;Absent $Dir
 $null=Invoke-Git 'init-bare' (@('-c','init.templateDir=','init','--bare','--quiet','--template=',$Dir));$script:created+=$Dir
 if(Test-Path -LiteralPath (Join-Path $Dir 'hooks')){if(@(Get-ChildItem -LiteralPath (Join-Path $Dir 'hooks') -Force -Recurse -File).Count -ne 0){throw 'TEMPLATE_HOOKS_REFUSED'}}
 $gd='--git-dir='+$Dir
 if($script:seedAttempt){Seed-Prime $gd}
 $script:stage='fetch-all-heads-and-tags';$fetchStartedAt=Utc;$fetchWatch=[Diagnostics.Stopwatch]::StartNew()
 $null=Invoke-Git 'fetch' ($Common+@($gd,'fetch','--quiet','--no-tags','--no-write-fetch-head','--no-recurse-submodules',$Url,'+refs/heads/*:refs/heads/*','+refs/tags/*:refs/tags/*'))
 $fetchCompletedAt=Utc
 if($script:seedAttempt){Seed-Drop-Refs $Dir $gd}
 $script:stage='ls-remote-after-fetch'
 $remote=Ref-Map (Invoke-Git 'ls-remote' ($Common+@($gd,'ls-remote','--branches','--tags',$Url))) "`t" $true
 $lsRemoteCompletedAt=Utc
 $script:stage='fetched-store-readback'
 if((Invoke-Git 'is-shallow' ($Common+@($gd,'rev-parse','--is-shallow-repository'))).Trim() -cne 'false'){throw 'COMPLETE_HISTORY_REQUIRED'}
 foreach($f in @('shallow','info\grafts','objects\info\alternates','objects\info\http-alternates')){Absent (Join-Path $Dir $f)}
 $local=Ref-Map (Invoke-Git 'for-each-ref' ($Common+@($gd,'for-each-ref','--format=%(objectname) %(refname)'))) ' ' $false
 # The one inconsistency a push between the fetch and the ls-remote makes; Fetch-Store retries only this one.
 if(-not (Same-Map $local $remote)){$script:refsDiffer=Ref-Diff $local $remote;throw 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE'}
 if(-not $local.ContainsKey('refs/heads/main') -or $local['refs/heads/main'] -cne $Base){throw 'REMOTE_MAIN_BASE_CHANGED'}
 foreach($s in @($Head,$Base,$desc.value.sourceCommit)){if((Invoke-Git 'cat-file' ($Common+@($gd,'cat-file','-t',$s))).Trim() -cne 'commit'){throw 'HEAD_BASE_SOURCE_COMMIT_MISSING'}}
 foreach($k in $local.Keys){$t=(Invoke-Git 'cat-file' ($Common+@($gd,'cat-file','-t',$local[$k]))).Trim()
  if(($k.StartsWith('refs/heads/') -and $t -cne 'commit') -or ($k.StartsWith('refs/tags/') -and $t -cne 'commit' -and $t -cne 'tag')){throw 'REMOTE_REF_TARGET_TYPE_UNSUPPORTED'}}
 $branchesAtHead=@($local.Keys|Where-Object{$_.StartsWith('refs/heads/') -and $local[$_] -ceq $Head}|Sort-Object)
 $script:stage='reviewed-commit-set'
 # From the INSTALLED Source commit's .gitleaks.toml (pinned by the record), never from the PR head.
 $toml=Invoke-Git 'source-gitleaks-toml' ($Common+@($gd,'cat-file','blob',($desc.value.sourceCommit+':.gitleaks.toml')))
 if((Hash-Text $toml) -cne $desc.value.gitleaksTomlSha256){throw 'TRUSTED_REVIEW_SOURCE_CHANGED'}
 $reviewed=Reviewed-Commits $toml;$expectedReviewed=Reviewed-Map $reviewed.commits;$script:reviewedCommits=@($reviewed.commits)
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
  unseeded=(-not $script:seedAttempt);fetchSeconds=$fetchWatch.Elapsed.TotalSeconds
  fetchStartedAt=$fetchStartedAt;fetchCompletedAt=$fetchCompletedAt;lsRemoteCompletedAt=$lsRemoteCompletedAt;reviewedFetchStartedAt=$reviewedFetchStartedAt;reviewedFetchCompletedAt=$reviewedFetchCompletedAt}
}
# Only a network step that git itself failed is retried, and only early enough: never a refusal of this script
# (main moved, refs differ, a commit missing from the store), never a git that did not start. Stderr is not read, so
# a network failure that will repeat (credentials, a reviewed commit gone from GitHub) also costs one more attempt.
function Retry-Allowed([string]$Reason,$Step,[double]$ElapsedSeconds){
 return ((Network-Step-Failed $Reason $Step) -and $ElapsedSeconds -lt $RetryWithinSeconds)
}
# A step that talks to GitHub failed in git itself (what a network failure looks like here: stderr is never read).
function Network-Step-Failed([string]$Reason,$Step){
 return ($Reason -ceq 'GIT_STEP_FAILED' -and $null -ne $Step -and $NetworkSteps -ccontains $Step.label -and $Step.exitCode -ne 0)
}
# The refs moved between the fetch and the ls-remote: only the first FETCHED_REFS_DIFFER_FROM_LS_REMOTE of a store (Build-Store
# sets $refsDiffer there and nowhere else), and only early enough, like a network step.
function Race-Retry-Allowed([string]$Reason,$Differ,[double]$ElapsedSeconds){
 return ($Reason -ceq 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' -and $null -ne $Differ -and $ElapsedSeconds -lt $RetryWithinSeconds)
}
# The store with at most $MaxStoreAttempts attempts, of which at most one is a retry of a failed network step. Every further
# attempt runs every step and check again in its own new bare repository; whatever an earlier one left (a partial pack,
# refs) stays where it is and is never read again. The receipt's storeAttempts counts the attempts, firstAttempt describes
# the first one that was given up on (its refsDiffer: how many refs and which ones, at most 8, were not equal), and
# failedAttempts lists every one that was given up on and retried, each with its attempt number, reason, stage, git step and
# refsDiffer, so the reason of a second failure is not lost (the attempt that ends the run is the answer's own reason).
function Fetch-Store{
 $dirs=@($FetchDir,$FetchDir2,$FetchDir3);$networkRetried=$false
 for($n=0;$n -lt $MaxStoreAttempts;$n++){
  $script:attempts=$n+1
  # A seeded attempt is never the last one: a seed that fails always leaves an unseeded attempt behind it.
  $script:seedAttempt=($script:seedUse -and $n -le ($MaxStoreAttempts-2))
  try{return Build-Store $dirs[$n]}
  catch{
   $reason=$_.Exception.Message;$elapsed=$Clock.Elapsed.TotalSeconds
   # Generation 10: every network failure of a GitHub step is noted for the next builds, retried here or not (the last one too).
   if(Network-Step-Failed $reason $script:lastGit){Seed-Note-Network-Failure}
   $race=Race-Retry-Allowed $reason $script:refsDiffer $elapsed
   $network=(-not $networkRetried) -and (Retry-Allowed $reason $script:lastGit $elapsed)
   # Generation 10: a SEEDED attempt whose GitHub step failed after the network retry was used up still leaves one unseeded attempt
   # behind it (inside the same window), so the invariant holds that a seeded attempt is never the last one, whatever failed in it.
   $seededNetwork=$networkRetried -and $script:seedAttempt -and (Retry-Allowed $reason $script:lastGit $elapsed)
   if($seededNetwork){$script:seedUse=$false;$script:seedReport.reason='UNSEEDED_AFTER_SEEDED_NETWORK_FAILURE'}
   $seedFell=Seed-Failure $reason
   if($n -ge ($MaxStoreAttempts-1) -or -not ($race -or $network -or $seedFell -or $seededNetwork)){throw}
   if($network){$networkRetried=$true;Seed-After-Network-Failure}
   $given=[ordered]@{attempt=($n+1);reason=$reason;stage=$script:stage;git=$script:lastGit;failedAfterSeconds=[int]$elapsed}
   if($race){$given['refsDiffer']=$script:refsDiffer}
   $script:failedAttempts=@($script:failedAttempts)+,$given
   if($null -eq $script:firstAttempt){
    $script:firstAttempt=[ordered]@{stage=$script:stage;git=$script:lastGit;failedAfterSeconds=[int]$elapsed}
    if($race){$script:firstAttempt['refsDiffer']=$script:refsDiffer}
   }
  }
 }
}
try{
 $id=[Security.Principal.WindowsIdentity]::GetCurrent();$principal=New-Object Security.Principal.WindowsPrincipal($id)
 if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'NON_ELEVATED_RUN_REQUIRED'}
 if(-not (Test-Path -LiteralPath $Git -PathType Leaf)){throw 'FIXED_GIT_FOR_WINDOWS_REQUIRED'}
 if($CheckRefs -and $Rebundle){throw 'ONE_MODE_REQUIRED'}
 $desc=Read-Descriptor;$Head=$desc.value.headSha;$Base=$desc.value.baseSha;$Test=$desc.value.testSha
 if($CheckRefs){
  $stage='check-refs'
  $rec=Read-BundleReceipt (Current-Receipt) $desc.sha256
  $now=Ref-Map (Invoke-Git 'ls-remote-check' ($Common+@('ls-remote','--branches','--tags',$Url))) "`t" $true
  $sha=Ref-List-Sha $now;$same=$sha -ceq $rec.refListSha256
  [ordered]@{status=$(if($same){'REMOTE_REFS_UNCHANGED'}else{'REMOTE_REFS_CHANGED_SINCE_BUNDLE'});batchId=$BatchId;refListSha256=$sha;bundleRefListSha256=$rec.refListSha256;mainStillBase=($now.ContainsKey('refs/heads/main') -and $now['refs/heads/main'] -ceq $Base);checkedAt=(Utc);networkWrite=$false}|ConvertTo-Json -Compress
  exit 0
 }
 $previous=$null
 if($Rebundle){
  $stage='first-generation'
  if(-not (Test-Path -LiteralPath $Gen1Receipt -PathType Leaf)){throw 'REBUNDLE_REQUIRES_FIRST_GENERATION'}
  $previous=Read-BundleReceipt $Gen1Receipt $desc.sha256
  if($null -ne $previous.PSObject.Properties['generation']){throw 'REBUNDLE_REQUIRES_FIRST_GENERATION'}
  $Root=$Gen2Root;$FetchDir=Join-Path $Root 'fetch.git';$FetchDir2=Join-Path $Root 'fetch-2.git';$FetchDir3=Join-Path $Root 'fetch-3.git';$Bundle=Join-Path $Root 'all-refs.bundle';$ReceiptPath=$Gen2Receipt
 }
 $ri=Get-Item -LiteralPath (Split-Path -Parent $Root) -Force;if(-not $ri.PSIsContainer -or ($ri.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'FIXED_REAL_BUNDLE_ROOT_REQUIRED'}
 Absent $Root
 $stage='batch-directory';$writesStarted=$true;[void][IO.Directory]::CreateDirectory($Root);$created+=$Root
 $gitVersion=(Invoke-Git 'version' @('--version')).Trim();$gitSha=Hash-File $Git
 Seed-Begin
 $store=Fetch-Store
 $gd=$store.gd;$remote=$store.remote;$reviewed=$store.reviewed;$reviewedCommits=$reviewed.commits;$expectedReviewed=$store.expectedReviewed;$expectedTest=$store.expectedTest
 # The second generation is still this batch's: some branch is still at the head (main == base is Build-Store's own check).
 if($Rebundle -and @($store.branchesAtHead).Count -eq 0){throw 'REMOTE_HEAD_MOVED'}
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
  storeAttempts=$attempts;firstAttempt=$firstAttempt;failedAttempts=@($failedAttempts)
  gitExecutableSha256=$gitSha;gitVersion=$gitVersion
  credentialsPrinted=$false;credentialsWrittenByScript=$false;existingCheckoutTouched=$false;wslTouched=$false;automaticRetryAllowed=$false}
 if($Rebundle){$receipt['generation']=2;$receipt['previousBundleSha256']=$previous.bundleSha256;$receipt['previousRefListSha256']=$previous.refListSha256}
 $json=($receipt|ConvertTo-Json -Depth 5 -Compress)
 $rb=(New-Object Text.UTF8Encoding($false)).GetBytes($json+[char]10);$f=[IO.File]::Open($ReceiptPath,'CreateNew','Write','None');try{$f.Write($rb,0,$rb.Length);$f.Flush($true)}finally{$f.Dispose()};$created+=$ReceiptPath
 Seed-Update $store
 [ordered]@{status='BUNDLE_WRITTEN';batchId=$BatchId;generation=$(if($Rebundle){2}else{1});bundleSha256=$sha;bundleBytes=$bytes;receiptSha256=(Hash-Bytes $rb);refListSha256=$receipt.refListSha256;lsRemoteCompletedAt=$store.lsRemoteCompletedAt;seed=$seedReport}|ConvertTo-Json -Depth 4 -Compress
 exit 0
}catch{
 $code=if($_.Exception.Message -cmatch '\A[A-Z][A-Z0-9_]{1,90}\z'){$_.Exception.Message}else{'FIXED_BUNDLE_BUILD_UNCONFIRMED'}
 [ordered]@{status=$(if($writesStarted){'PARTIAL_STATE_PRESERVED_NO_RETRY'}else{'REFUSED_BEFORE_WRITE'});stage=$stage;reason=$code;hint=(Branch-Only-Hint $stage $code $reviewedCommits);git=$lastGit;created=$created
  storeAttempts=$attempts;firstAttempt=$firstAttempt;failedAttempts=@($failedAttempts);seed=$seedReport;credentialsPrinted=$false;existingCheckoutTouched=$false;automaticRetryAllowed=$false}|ConvertTo-Json -Depth 5 -Compress;exit 2
}
