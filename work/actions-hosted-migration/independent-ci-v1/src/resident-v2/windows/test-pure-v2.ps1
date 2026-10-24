# Source v2 C# offline checks. Compiles the generic helper, the broker primitive and the pure test
# harness with the in-box csc into a NEW scratch directory given by the caller, derives a fixture batch
# with Node (no host path), and runs the pure assertions. Never starts a service, never touches
# ProgramData, never elevates.
#   powershell -NoProfile -File test-pure-v2.ps1 -Scratch <new empty directory> [-Node <node.exe>]
param([Parameter(Mandatory=$true)][string]$Scratch,[string]$Node='node')
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
if(Test-Path -LiteralPath $Scratch){if(@(Get-ChildItem -LiteralPath $Scratch -Force).Count){throw 'EMPTY_SCRATCH_REQUIRED'}}else{[void][IO.Directory]::CreateDirectory($Scratch)}
$here=$PSScriptRoot;$src=Split-Path -Parent $here;$ci=Split-Path -Parent (Split-Path -Parent $src)
$fw='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\';$csc=Join-Path $fw 'csc.exe'
foreach($f in @(@(Get-ChildItem -LiteralPath $here -Filter *.ps1)+@(Get-ChildItem -LiteralPath $src -Filter *.ps1))){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e);if($e.Count){throw ('PS51_SOURCE_PARSE_FAILED:'+$f.Name)}}
$refs=@("/reference:$($fw)System.dll","/reference:$($fw)System.Core.dll","/reference:$($fw)System.Web.Extensions.dll")
& $csc /nologo /noconfig /target:winexe /platform:x64 /main:CluedWindowsFormalEntryV2 $refs ("/out:"+(Join-Path $Scratch 'controller-formal-generic-v2.exe')) (Join-Path $here 'FormalPublicBoundaryV2.cs') (Join-Path $here 'FormalSession0V2.cs') (Join-Path $here 'ScmPidHandshakeV2.cs') | Out-Null
if($LASTEXITCODE -ne 0){throw 'GENERIC_HELPER_COMPILE_FAILED'}
& $csc /nologo /noconfig /target:exe /platform:x64 /main:PureTestsV2 $refs ("/out:"+(Join-Path $Scratch 'pure-v2.exe')) (Join-Path $here 'FormalPublicBoundaryV2.cs') (Join-Path $here 'FormalSession0V2.cs') (Join-Path $here 'ScmPidHandshakeV2.cs') (Join-Path $here 'ResidentScmV2.cs') (Join-Path $here 'PureTestsV2.cs') | Out-Null
if($LASTEXITCODE -ne 0){throw 'PURE_HARNESS_COMPILE_FAILED'}
$fixture=Join-Path $Scratch 'fixture.json'
$fixtures=([Uri](Join-Path $ci 'test\resident-v2-fixtures.mjs')).AbsoluteUri;$derive=([Uri](Join-Path $src 'derive-batch.mjs')).AbsoluteUri;$trainRun=([Uri](Join-Path $src 'train-run.mjs')).AbsoluteUri
$script="import {fixtureRecord,subject,NOW,hex} from '$fixtures';import {deriveBatch,deriveRelayStage,deriveTrainRun,residentBatchKey} from '$derive';import {trainRunKey} from '$trainRun';import fs from 'node:fs';const r=fixtureRecord();const s=subject({createdAt:'2026-01-01T00:00:00.000Z'});const k=residentBatchKey(s);const id=k.slice(0,16)+'-'+hex(6);const d=deriveBatch({recordDocs:r.docs,subject:s,batchKey:k,batchId:id,now:NOW});const rs=deriveRelayStage({recordDocs:r.docs,batchJson:d.files['batch.json'],roles:['gitleaks','trivy'],batchKey:k,batchId:id,now:NOW});Object.assign(d.files,rs.files);const plans=[],jobs=new Map();for(let i=1;i<=9;i++){const dir='stage-'+String(i).padStart(2,'0');plans.push(JSON.parse(d.files[dir+'/formal-service-entry.json']));for(const j of JSON.parse(d.files[dir+'/jobs.json']))jobs.set(j.id,j);}const tk=trainRunKey({repo:'tdoljyj/cross-memory-system',seed:'a'.repeat(64)});const tr=deriveTrainRun({recordDocs:r.docs,runId:tk.slice(0,16)+'-'+hex(6),runKey:tk,mode:'shadow',now:NOW});plans.push(JSON.parse(tr.files['stage-10/formal-service-entry.json']));fs.writeFileSync(process.argv[1],JSON.stringify({plans,jobs:[...jobs.values()],trainRuns:JSON.parse(tr.files['stage-10/jobs.json'])}));"
& $Node --input-type=module -e $script $fixture
if($LASTEXITCODE -ne 0){throw 'NODE_FIXTURE_FAILED'}
$out=& (Join-Path $Scratch 'pure-v2.exe') $fixture
if($LASTEXITCODE -ne 0){throw ('PURE_V2_FAILED:'+$out)}
$v=$out|ConvertFrom-Json;if($v.status -cne 'PURE_V2_PASS' -or $v.assertions -lt 60){throw 'PURE_V2_ASSERTION_COUNT_LOW'}
[pscustomobject]@{status='SOURCE_V2_CSHARP_OFFLINE_PASS';assertions=$v.assertions;helperCompiled=$true;ps51Parse=$true;hostRead=$false;hostWrite=$false}|ConvertTo-Json -Compress
