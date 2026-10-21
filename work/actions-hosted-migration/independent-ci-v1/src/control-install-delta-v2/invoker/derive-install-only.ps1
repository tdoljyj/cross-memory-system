
# Fixed WORK-only compilation after concrete public acceptance inputs exist.
# No Host identity, installation, service or private-file access.
Set-StrictMode -Version 2.0;$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot;$inputRoot=Join-Path $root 'bound-install-payload';$dest=Join-Path $root 'bound-install'
if(Test-Path -LiteralPath $dest){throw 'BOUND_INVOKER_EXISTS_PRESERVE_NO_RETRY'}
$compiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe';$compilerPin='eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3'
function Sha([byte[]]$b){$s=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-','').ToLowerInvariant()}finally{$s.Dispose()}}
function Bytes([string]$p){if($p.Length -gt 240 -and -not $p.StartsWith('\\?\')){$p='\\?\'+[IO.Path]::GetFullPath($p)};$i=Get-Item -LiteralPath $p -Force;while($null -ne $i){if(($i.Attributes -band 1024) -ne 0){throw 'WORK_REPARSE_REFUSED'};$i=if($i -is [IO.DirectoryInfo]){$i.Parent}else{$i.Directory}};return ,[IO.File]::ReadAllBytes($p)}
$mBytes=Bytes (Join-Path $root 'manifest.json');$m=[Text.Encoding]::UTF8.GetString($mBytes)|ConvertFrom-Json
foreach($name in $m.files.PSObject.Properties.Name){$b=Bytes (Join-Path $root $name);if($b.Length -ne $m.files.$name.bytes -or (Sha $b) -cne $m.files.$name.sha256){throw 'CLOSED_SOURCE_PIN_CHANGED'}}
$pBytes=Bytes (Join-Path $inputRoot 'payload-manifest.json');$pm=[Text.Encoding]::UTF8.GetString($pBytes)|ConvertFrom-Json
foreach($name in $pm.files.PSObject.Properties.Name){$b=Bytes (Join-Path $inputRoot $name);if($b.Length -ne $pm.files.$name.bytes -or (Sha $b) -cne $pm.files.$name.sha256){throw 'PUBLIC_PAYLOAD_CHANGED'}}
foreach($r in $pm.sourceFiles){$b=Bytes (Join-Path $inputRoot ('source/'+$r.path));if($b.Length -ne $r.bytes -or (Sha $b) -cne $r.sha256){throw 'PUBLIC_SOURCE_PAYLOAD_CHANGED'}}
$plan=Get-Content -LiteralPath (Join-Path $inputRoot 'formal-service-entry.json') -Raw|ConvertFrom-Json;$a=Get-Content -LiteralPath (Join-Path $inputRoot 'acceptance.json') -Raw|ConvertFrom-Json
if($plan.entryRole -cne 'control-checks' -or $plan.enabled -ne $false -or $a.accepted -ne $false -or $null -ne $a.installationReceiptRef -or $a.domain -cne 'production' -or [DateTimeOffset]::Parse($a.expiresAt) -le [DateTimeOffset]::UtcNow){throw 'ACTUAL_DISABLED_INSTALL_ONLY_ACCEPTANCE_REQUIRED'}
if($a.ownerDecisionRef -cin @('368c16d4-97c9-42aa-a7be-87edbc6966c3','fbec6cad-4fe5-4d52-9bb9-3b133fc2a4f0')){throw 'FINITE_ACCEPTANCE_CANNOT_AUTHORIZE_CONTROL_INSTALL'}
[void][IO.Directory]::CreateDirectory($dest);[void][IO.Directory]::CreateDirectory((Join-Path $dest 'inputs'));$utf8=New-Object Text.UTF8Encoding($false)
$binding=[ordered]@{contract='clued.independent-ci.control-install-binding/1';bound=$true;role='control-checks';validUntil=$a.expiresAt;ownerDecisionRef=$a.ownerDecisionRef;ownerReceiptRef=$a.ownerReceiptRef;originalStableDigest='1f3595231dad355084f441e8b84b978e2204346f6b294009ff004aa5f07f59e0';payloadManifestSha256=(Sha $pBytes);helperSha256=$null;successorSourceManifestSha256=(Sha $mBytes)}
$bindingBytes=$utf8.GetBytes(($binding|ConvertTo-Json -Depth 8)+[char]10);[IO.File]::WriteAllBytes((Join-Path $dest 'binding.json'),$bindingBytes)
$files=[ordered]@{};$names=@('invoke-control.ps1','continue-fixed.ps1','ContinuationFiles.cs','invoke-functions.ps1','invoke-io.ps1','FixedScm.cs','ScmPidHandshake.cs','HostFiles.cs','FormalRepairFiles.cs','host-baseline.ps1','restore-functions.ps1')
foreach($n in $names){$b=Bytes (Join-Path $PSScriptRoot $n);if($n -ceq 'invoke-control.ps1'){$text=$utf8.GetString($b);$needle='$ExpectedBindingSha256=$null';if($text.Split(@($needle),[StringSplitOptions]::None).Count -ne 2){throw 'EXACT_UNBOUND_INVOKER_REQUIRED'};$b=$utf8.GetBytes($text.Replace($needle,('$ExpectedBindingSha256='''+(Sha $bindingBytes)+'''')))};[IO.File]::WriteAllBytes((Join-Path $dest $n),$b);$files[$n]=Sha $b}
foreach($n in @('runtime-pins.json','deployment-pins.json','prior-installed.json')){$b=Bytes (Join-Path $root $n);[IO.File]::WriteAllBytes((Join-Path $dest $n),$b);$files[$n]=Sha $b};$files['binding.json']=Sha $bindingBytes
foreach($name in @($pm.files.PSObject.Properties.Name)+@('payload-manifest.json')){$b=Bytes (Join-Path $inputRoot $name);[IO.File]::WriteAllBytes((Join-Path $dest ('inputs/'+$name)),$b)}
foreach($r in $pm.sourceFiles){$target=Join-Path $dest ('inputs/source/'+$r.sha256+'.bin');[void][IO.Directory]::CreateDirectory((Split-Path -Parent $target));[IO.File]::WriteAllBytes($target,(Bytes (Join-Path $inputRoot ('source/'+$r.path))))}
$wm=[ordered]@{contract='clued.independent-ci.formal-fixed-invocation-work/1';effectsAuthorized=$false;bindingSha256=(Sha $bindingBytes);files=$files};[IO.File]::WriteAllText((Join-Path $dest 'work-manifest.json'),($wm|ConvertTo-Json -Depth 8)+[char]10,$utf8)
[pscustomobject]@{state='BOUND_WORK_REQUIRES_NONAUTHOR_REVIEW_AND_EXACT_OWNER_APPROVAL';manifestSha256=(Sha (Bytes (Join-Path $dest 'work-manifest.json')));hostRead=$false;hostWrite=$false;qualificationIssued=$false}|ConvertTo-Json
