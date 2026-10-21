# Offline test of resident-v2/build-bundle.ps1 pure functions (no network, no ProgramData). The script's
# main block is never run: functions are taken from its AST, exactly like batch/test-pure.ps1 does.
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$tool=Join-Path (Split-Path -Parent $PSScriptRoot) 'build-bundle.ps1';$cases=0
function Yes([bool]$v,[string]$what){if(-not $v){throw ('BUNDLE_TEST_FAILED:'+$what)};$script:cases++}
function Refuse([scriptblock]$f,[string]$what){$no=$false;try{& $f}catch{$no=$true};Yes $no $what}
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($tool,[ref]$t,[ref]$e);if($e.Count){throw 'BUILD_BUNDLE_PARSE_FAILED'}
$ReviewedPrefix='refs/reviewed/'
foreach($name in @('Hash-Bytes','Hash-Text','Assert-FormalRefName','New-RefMap','Split-Refs','Ref-Map','Same-Map','Ref-List-Sha','Reviewed-Map','Reviewed-Commits','Bundle-Header')){
 $f=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});if($f.Count -ne 1){throw ('FUNCTION_MISSING:'+$name)};. ([scriptblock]::Create($f[0].Extent.Text))
}
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
# a real v2 bundle from a throwaway local repository
$git=(Get-Command git -ErrorAction SilentlyContinue)
if($git){
 $tmp=Join-Path ([IO.Path]::GetTempPath()) ('clued-bundle-'+[Guid]::NewGuid().ToString('N').Substring(0,8));[void][IO.Directory]::CreateDirectory($tmp)
 try{
  $env:GIT_CONFIG_GLOBAL='NUL';$env:GIT_CONFIG_NOSYSTEM='1'
  & git -C $tmp init -q -b main;[IO.File]::WriteAllText((Join-Path $tmp 'a.txt'),"a`n");& git -C $tmp add a.txt;& git -C $tmp -c user.name=f -c user.email=f@f commit -q -m a
  $h=(& git -C $tmp rev-parse HEAD).Trim();& git -C $tmp tag v1;& git -C $tmp update-ref ("refs/reviewed/"+$h) $h
  $bundle=Join-Path $tmp 'all.bundle';& git -C $tmp bundle create --quiet --version=2 $bundle --branches --tags '--glob=refs/reviewed/*'
  $hdr=Bundle-Header $bundle;Yes ($hdr.formal.Count -eq 2 -and $hdr.reviewed.Count -eq 1 -and $hdr.reviewed[("refs/reviewed/"+$h)] -ceq $h) 'bundle-header'
 }finally{Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item Env:\GIT_CONFIG_GLOBAL,Env:\GIT_CONFIG_NOSYSTEM -ErrorAction SilentlyContinue}
}
[pscustomobject]@{status='BUILD_BUNDLE_OFFLINE_PASS';cases=$cases;networkUsed=$false;hostWrite=$false}|ConvertTo-Json -Compress
