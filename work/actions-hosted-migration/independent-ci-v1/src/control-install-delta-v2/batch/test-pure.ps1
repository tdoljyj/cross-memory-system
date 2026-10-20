# Pure Source tests: never invoke any candidate main, Host helper or production factory.
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$base=Split-Path -Parent $PSScriptRoot;$count=0
function Yes([bool]$v){if(-not $v){throw 'PURE_BATCH_ASSERTION_FAILED'};$script:count++}
function Refuse([scriptblock]$f){$no=$false;try{& $f}catch{$no=$true};Yes $no}
$stages=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'stages.json') -Raw|ConvertFrom-Json
Yes ($stages.stages.Count -eq 8);Yes (($stages.stages|Measure-Object runMilliseconds -Sum).Sum -eq 9600000)
Yes (@($stages.stages|Where-Object linuxWorker).Count -eq 3)
Yes (($stages.stages.entryRole -join '|') -ceq 'work-admission|scanner-issuer|check-publisher|scanner-issuer|check-publisher|scanner-issuer|check-publisher|control-checks')
$runner=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'run-batch.ps1') -Raw;$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($runner,[ref]$tokens,[ref]$errors);Yes ($errors.Count -eq 0)
foreach($name in @('Hash','Read-SealedWork','Assert-WorkerFact')){$f=@($ast.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});Yes ($f.Count -eq 1);. ([scriptblock]::Create($f[0].Extent.Text))}
$h='a'*64;$r='b'*64;$v=[ordered]@{status='ACTUAL_SIGNED_ROLE_RESULT_EMITTED';issueSha256=$h;resultSha256=$r;cleanupConfirmed=$true;checksWritten=$false;qualificationIssued=$false;automaticRetryAllowed=$false};Assert-WorkerFact ($v|ConvertTo-Json -Compress) $h $r;$count++
foreach($name in @('status','cleanupConfirmed','checksWritten','qualificationIssued','automaticRetryAllowed','issueSha256','resultSha256')){$bad=[ordered]@{};foreach($key in $v.Keys){$bad[$key]=$v[$key]};$bad[$name]=switch($name){'status'{'UNCERTAIN'};'issueSha256'{'c'*64};'resultSha256'{'c'*64};default{-not $v[$name]}};Refuse {Assert-WorkerFact ($bad|ConvertTo-Json -Compress) $h $r}}
$fixture=Join-Path $base ('offline-batch-fixture-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($fixture);$file=Join-Path $fixture 'public.txt';[IO.File]::WriteAllText($file,'fixture-public-source-only',(New-Object Text.UTF8Encoding($false)));$packageHeld=New-Object 'Collections.Generic.List[IDisposable]'
try{$raw=[IO.File]::ReadAllBytes($file);$pin=Hash $raw;$read=Read-SealedWork $file $pin 1024;Yes ($read.Length -eq $raw.Length);Refuse {Read-SealedWork $file ('d'*64) 1024};Refuse {[IO.File]::WriteAllText($file,'replacement')};Yes ($packageHeld.Count -eq 2)}finally{foreach($hold in $packageHeld){$hold.Dispose()}}
Yes ($runner.Contains("@('OS','Windows_NT')"));Yes ($runner.Contains("$"+'BridgeManifestSha256=''4c628b391810f05a6df694a2ad0395242c27124ffdddeae75190be3d2977b6cb'''))
Yes ($runner.IndexOf('$parts=Assert-SealedStage $r') -lt $runner.IndexOf('foreach($n in @(''invoke-io.ps1'''))
$invoke=Get-Content -LiteralPath (Join-Path $base 'invoker/invoke-control.ps1') -Raw
Yes ($invoke.Contains("'InstallOnly'"));Yes ($invoke.IndexOf("if($"+"Mode -ceq 'InstallOnly')") -lt $invoke.IndexOf("$"+"stage='ONE_BINARY_SWITCH'"))
Yes ($runner.Contains("$"+"mode='ActivateOnce'"));Yes (-not $runner.Contains("$"+"mode=if($"+"row.number -eq 1)"));Yes ($runner.Contains('Prepare-StageInputs $row'))
$continuation=Get-Content -LiteralPath (Join-Path $base 'invoker/continue-fixed.ps1') -Raw
Yes ($continuation.Contains("$"+'rows.Count -ne 150'));Yes ($continuation.Contains('canonicalReceiptIssued=$false'));Yes ($continuation.Contains('installationReceiptRef=$null'));Yes ($continuation.Contains('CONTINUATION_SIX_REFS_SOURCE_OR_IDENTITY_CHANGED'));Yes ($continuation.Contains('EXACT_POST_RECEIPT_BATCH_REQUIRED'))
$tt=$null;$ee=$null;$cc=[Management.Automation.Language.Parser]::ParseInput($continuation,[ref]$tt,[ref]$ee);Yes ($ee.Count -eq 0)
foreach($name in @('Equal-Public','Copy-Public')){$f=@($cc.EndBlock.Statements|Where-Object{$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name});. ([scriptblock]::Create($f[0].Extent.Text))}
$a=[pscustomobject]@{repo='fixture-only';head='a';fence=5;refs=[pscustomobject]@{source='source-fixture';installation=$null}};$b=Copy-Public $a;Yes (Equal-Public $a $b);$b.head='b';Yes (-not (Equal-Public $a $b));$b=Copy-Public $a;$b.fence=6;Yes (-not (Equal-Public $a $b));$b=Copy-Public $a;$b.refs.source='changed';Yes (-not (Equal-Public $a $b))
return $count
