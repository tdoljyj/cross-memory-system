# Isolated integration boundary: real production verifier readers and generation/chain predicates.
# SCM/task observations come from the isolated fixture, never from the host. This is not physical-host qualification.
param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$Verifier,
      [Parameter(Mandatory)][string]$ReceiptsVerifier,[Parameter(Mandatory)][string]$NodeExe,
      [Parameter(Mandatory)][long]$Now,[string]$ExpectPausedSha256='')
$ErrorActionPreference='Stop'
$fullRoot=[IO.Path]::GetFullPath($Root)
$tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if (-not $fullRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath (Join-Path $Root 'ISOLATED-UPGRADE-IO-FIXTURE'))) { throw 'ISOLATED_FIXTURE_ONLY' }
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Verifier,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'VERIFIER_PARSE_REFUSED'}
foreach($name in @('Get-Field','Sha256File','Sha256Text','Read-ReviewedPublicJson','Get-GenerationFilesSha256',
  'Test-GenerationCurrent','Test-VersionFacts','Test-TwoSidesConsistent','Get-VerifyVerdict')){
  $fun=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
  if($null -eq $fun){throw 'VERIFIER_FUNCTION_MISSING'}
  . ([scriptblock]::Create($fun.Extent.Text))
}
# Only these OS observations are substituted. Every public file, digest and receipt-chain check below is real I/O.
function Read-IsolatedSc {
  param([string]$verb,[string]$name,[int]$buffer)
  if($verb -cne 'qc'){throw 'UNEXPECTED_SCM_OBSERVATION'}
  $scm=Get-Content -LiteralPath (Join-Path $Root 'fake-scm.json') -Raw|ConvertFrom-Json
  $key=if($name -ceq 'CluedCIResident'){'resident'}elseif($name -ceq 'CluedCISwapBroker'){'broker'}else{throw 'UNEXPECTED_SERVICE'}
  'BINARY_PATH_NAME : '+$scm.$key.binPath
}
function Get-ScheduledTask {
  param([string]$TaskPath,[string]$TaskName,[string]$ErrorAction)
  if($TaskPath -cne '\Clued\' -or $TaskName -cne 'CluedCIResidentCompanion'){throw 'UNEXPECTED_TASK'}
  $scm=Get-Content -LiteralPath (Join-Path $Root 'fake-scm.json') -Raw|ConvertFrom-Json
  [pscustomobject]@{Actions=@([pscustomobject]@{Arguments=$scm.companionTask.arguments})}
}
$Sc='Read-IsolatedSc'
$checks=[ordered]@{}
function Add-Check([string]$name,$ok,$detail=$null){$checks[$name]=[ordered]@{ok=$ok;detail=$detail}}
$phase='install-receipt'
try{
  $cur=Get-Content -LiteralPath (Join-Path $Root 'upgrade\current.json') -Raw|ConvertFrom-Json
  $receipt=Read-ReviewedPublicJson (Join-Path $Root 'install\install-receipt.json') $cur.installReceiptSha256
  Add-Check $phase $true
  $phase='record-acceptance'
  $null=Read-ReviewedPublicJson (Join-Path $Root 'record\acceptance.json') $receipt.acceptanceSha256 4MB
  Add-Check $phase $true
  $phase='record-installation'
  $null=Read-ReviewedPublicJson (Join-Path $Root 'record\installation.json') $receipt.installationSha256 4MB
  Add-Check $phase $true
  $gc=Test-GenerationCurrent $Root $receipt $cur.installReceiptSha256
  Add-Check 'generation-current' $gc.ok $gc.detail
  $tc=Test-TwoSidesConsistent $Root '' ([DateTimeOffset]::FromUnixTimeMilliseconds($Now))
  Add-Check 'two-sides-consistent' $tc.ok $tc.detail
  $pause=Join-Path $Root 'state\PAUSED.json'
  if($ExpectPausedSha256){Add-Check 'paused-as-expected' ((Test-Path -LiteralPath $pause) -and (Sha256File $pause) -ceq $ExpectPausedSha256)}
  else{Add-Check 'not-paused' (-not(Test-Path -LiteralPath $pause))}
  $chain=& $NodeExe $ReceiptsVerifier (Join-Path $Root 'state\receipts')|Out-String
  Add-Check 'receipt-chain' ($LASTEXITCODE -eq 0)
}catch{
  $reason=if($_.Exception.Message -ceq 'INSTALL_RECEIPT_CHANGED'){'INSTALL_RECEIPT_CHANGED'}else{'ISOLATED_READER_REFUSED'}
  Add-Check $phase $false $reason
}
$verdict=Get-VerifyVerdict $checks
$failed=@($checks.Keys|Where-Object{$checks[$_].ok -ne $true})
[ordered]@{ok=($verdict.exit -eq 0);code=$(if($verdict.exit){'VERIFY_FAILED'}else{$null});
  at=$(if($failed.Count){$failed[0]}else{$null});status=$verdict.status;checks=$checks}|ConvertTo-Json -Depth 5 -Compress
exit $verdict.exit
