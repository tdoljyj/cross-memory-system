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
& $csc /nologo /noconfig /target:winexe /platform:x64 /main:CluedWindowsFormalEntryV2 $refs ("/out:"+(Join-Path $Scratch 'controller-formal-generic-v2.exe')) (Join-Path $here 'FormalPublicBoundaryV2.cs') (Join-Path $here 'FormalSession0V2.cs') (Join-Path $here 'ScmPidHandshakeV2.cs') (Join-Path $here 'NodeProfileV2.cs') | Out-Null
if($LASTEXITCODE -ne 0){throw 'GENERIC_HELPER_COMPILE_FAILED'}
& $csc /nologo /noconfig /target:exe /platform:x64 /main:PureTestsV2 $refs ("/out:"+(Join-Path $Scratch 'pure-v2.exe')) (Join-Path $here 'FormalPublicBoundaryV2.cs') (Join-Path $here 'FormalSession0V2.cs') (Join-Path $here 'ScmPidHandshakeV2.cs') (Join-Path $here 'NodeProfileV2.cs') (Join-Path $here 'ResidentScmV2.cs') (Join-Path $here 'PureTestsV2.cs') | Out-Null
if($LASTEXITCODE -ne 0){throw 'PURE_HARNESS_COMPILE_FAILED'}
$fixture=Join-Path $Scratch 'fixture.json'
$fixtures=([Uri](Join-Path $ci 'test\resident-v2-fixtures.mjs')).AbsoluteUri;$derive=([Uri](Join-Path $src 'derive-batch.mjs')).AbsoluteUri;$trainRun=([Uri](Join-Path $src 'train-run.mjs')).AbsoluteUri
$casesPath=([Uri](Join-Path $ci 'test\fixtures\node-profile-cases.json')).AbsoluteUri;$trainCases=([Uri](Join-Path $ci 'test\train-run-cases.mjs')).AbsoluteUri;$turingPath=([Uri]([IO.Path]::GetFullPath((Join-Path $ci '..\..\independent-ci-resident-v1\test\fixtures\node-profile.json')))).AbsoluteUri;$prepare=([Uri](Join-Path $src 'prepare-record.mjs')).AbsoluteUri;$proof=([Uri](Join-Path $ci 'src\proof.mjs')).AbsoluteUri
$script="import {hash,validateNodeProfile} from '$prepare';import {canonical} from '$proof';import {fixtureRecord,subject,NOW,hex} from '$fixtures';import {deriveBatch,deriveRelayStage,deriveTrainRun,residentBatchKey} from '$derive';import {trainRunKey} from '$trainRun';import {trainRunCases} from '$trainCases';import fs from 'node:fs';const r=fixtureRecord();const s=subject({createdAt:'2026-01-01T00:00:00.000Z'});const k=residentBatchKey(s);const id=k.slice(0,16)+'-'+hex(6);const d=deriveBatch({recordDocs:r.docs,subject:s,batchKey:k,batchId:id,now:NOW});const rs=deriveRelayStage({recordDocs:r.docs,batchJson:d.files['batch.json'],roles:['gitleaks','trivy'],batchKey:k,batchId:id,now:NOW});Object.assign(d.files,rs.files);const plans=[],jobs=new Map();for(let i=1;i<=9;i++){const dir='stage-'+String(i).padStart(2,'0');plans.push(JSON.parse(d.files[dir+'/formal-service-entry.json']));for(const j of JSON.parse(d.files[dir+'/jobs.json']))jobs.set(j.id,j);}const tk=trainRunKey({repo:'tdoljyj/cross-memory-system',seed:'a'.repeat(64)});const tr=deriveTrainRun({recordDocs:r.docs,runId:tk.slice(0,16)+'-'+hex(6),runKey:tk,mode:'shadow',now:NOW});plans.push(JSON.parse(tr.files['stage-10/formal-service-entry.json']));const node=JSON.parse(r.docs['acceptance.json']).node;const vectors=JSON.parse(fs.readFileSync(new URL('$casesPath'),'utf8'));const apply=c=>{const n={...vectors.base,...(c.set??{}),...(c.add??{})};if(c.remove)delete n[c.remove];return n;};const positive=[...vectors.accepted.map(apply),JSON.parse(fs.readFileSync(new URL('$turingPath'),'utf8'))];const nodeProfileVectors=[...positive.map(n=>{validateNodeProfile(n);return {node:n,accepted:true,canonicalJson:canonical(n),sha256:hash(n)};}),...vectors.refused.map(c=>{const n=apply(c);let code=null;try{validateNodeProfile(n)}catch(e){code=e.code}if(code!==c.code)throw new Error('SHARED_NODE_VECTOR_CHANGED');return {node:n,accepted:false,code};})];fs.writeFileSync(process.argv[1],JSON.stringify({node,nodeProfileSha256:hash(node),nodeProfileVectors,plans,jobs:[...jobs.values()],trainRuns:JSON.parse(tr.files['stage-10/jobs.json']),trainRunCases:trainRunCases()}));"
$relayRun=([Uri](Join-Path $src 'relay-qualification-run.mjs')).AbsoluteUri
# Add the dedicated Stage13 jobs to the same freshly generated offline fixture.
# Both phases, safe-integer edges and canonical year-zero ISO are generated by
# the actual JS maker, then read by PureTestsV2's C# ID/binding validator.
$relayScript=@"
import {makeRelayQualificationRun} from '$relayRun';
const relayInput={repo:s.repo,runId:id,pr:s.pr,headSha:s.headSha,baseSha:s.baseSha,testSha:s.headSha,
sourceManifestSha256:JSON.parse(r.docs['installation.json']).sourceManifestSha256,nodeProfileSha256:hash(node),
claimId:'11111111-2222-4333-8444-555555555555',fence:1,executionEpoch:1,
stage1JobId:[...jobs.values()].find(j=>j.role==='work-admission').id,stage1OutcomeNonce:'a'.repeat(32),stage1OutcomeSha256:'b'.repeat(64),
phase:'initial',priorObservationNonce:null,priorObservationSha256:null,createdAt:new Date(NOW).toISOString()};
const relayQualificationRuns=[{},{phase:'after-ref-move',priorObservationNonce:'c'.repeat(32),priorObservationSha256:'d'.repeat(64)},
{pr:Number.MAX_SAFE_INTEGER,fence:Number.MAX_SAFE_INTEGER,executionEpoch:Number.MAX_SAFE_INTEGER},
{createdAt:'0000-02-29T00:00:00.000Z'}].map(changes=>makeRelayQualificationRun({...relayInput,...changes}));
"@
# Keep all previous fixture generation and fields unchanged; insert before its
# single file write rather than reopening or replacing an earlier test artifact.
$writeMarker='fs.writeFileSync(process.argv[1],JSON.stringify({node,'
if($script.IndexOf($writeMarker) -lt 0 -or $script.IndexOf($writeMarker) -ne $script.LastIndexOf($writeMarker)){throw 'ONE_FIXTURE_WRITE_REQUIRED'}
$script=$script.Replace($writeMarker,$relayScript+"`n"+'fs.writeFileSync(process.argv[1],JSON.stringify({relayQualificationRuns,node,')
& $Node --input-type=module -e $script $fixture
if($LASTEXITCODE -ne 0){throw 'NODE_FIXTURE_FAILED'}
$out=& (Join-Path $Scratch 'pure-v2.exe') $fixture
if($LASTEXITCODE -ne 0){throw ('PURE_V2_FAILED:'+$out)}
$v=$out|ConvertFrom-Json;if($v.status -cne 'PURE_V2_PASS' -or $v.assertions -lt 60){throw 'PURE_V2_ASSERTION_COUNT_LOW'}
[pscustomobject]@{status='SOURCE_V2_CSHARP_OFFLINE_PASS';assertions=$v.assertions;helperCompiled=$true;ps51Parse=$true;hostRead=$false;hostWrite=$false}|ConvertTo-Json -Compress
