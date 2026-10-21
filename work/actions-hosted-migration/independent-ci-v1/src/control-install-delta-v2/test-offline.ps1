$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$base=$PSScriptRoot
foreach($f in @((Get-Item -LiteralPath $PSCommandPath)) + @(Get-ChildItem -LiteralPath (Join-Path $base 'invoker') -Filter *.ps1) + @(Get-ChildItem -LiteralPath (Join-Path $base 'batch') -Filter *.ps1)){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e);if($e.Count){throw 'PS51_SOURCE_PARSE_FAILED'}}
$prior=Split-Path -Parent (Split-Path -Parent $base);$prior=Join-Path $prior 'host\formal-fixed-invoke-v1'
foreach($n in @('FixedScm.cs','ScmPidHandshake.cs','HostFiles.cs','host-baseline.ps1','restore-functions.ps1','invoke-io.ps1')){if((Get-FileHash -LiteralPath (Join-Path $base ('invoker\'+$n))).Hash -cne (Get-FileHash -LiteralPath (Join-Path $prior $n)).Hash){throw 'UNCHANGED_PRIMITIVE_BYTES_REQUIRED'}}
$fixture=Join-Path $base ('offline-fixture-'+[Guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($fixture)
$pins=Get-Content -LiteralPath (Join-Path $base 'runtime-pins.json') -Raw|ConvertFrom-Json
$rows=@($pins.runtimeFiles|ForEach-Object{'new Dictionary<string,object>{{"path","'+$_.path+'"},{"sha256","'+$_.sha256+'"}}'}) -join ','
$test=@'
using System;using System.Linq;using System.Collections.Generic;using System.Web.Script.Serialization;
public static class ControlInstallPureTests{
 static int n;static void Yes(bool v){if(!v)throw new Exception("PURE_ASSERTION_FAILED");n++;}static void Refuse(Action f){bool no=false;try{f();}catch(InvalidOperationException){no=true;}Yes(no);}
 public static int Run(){
  Yes(FormalPublicBoundary.RelativeEntryForRole("control-checks")=="work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v1/startup.mjs");
  Yes(FormalPublicBoundary.RelativeEntryForRole("check-publisher")=="work/actions-hosted-migration/independent-ci-v1/runtime/one-shot.mjs");
  Yes(FormalPublicBoundary.JobRelativeForRole("control-checks")=="control-check-jobs.json");Yes(FormalPublicBoundary.JobRelativeForRole("check-publisher")=="inbox/job.json");
  Yes(FormalPublicBoundary.JobRelativeForRole("scanner-issuer")=="formal-job.json");Yes(FormalPublicBoundary.JobRelativeForRole("work-admission")=="work-admission-job.json");
  foreach(string r in new[]{"",null,"control-admission","control-checks --eval=1","CONTROL-CHECKS","../startup.mjs"})Refuse(delegate{FormalPublicBoundary.RelativeEntryForRole(r);});
  foreach(string r in new[]{"control-checks","check-publisher","work-admission"}){Yes(FormalPublicBoundary.RoleRunMilliseconds(r)==900000);Yes(!FormalPublicBoundary.CommandForRole(r).Contains("use-env-proxy"));Yes(FormalPublicBoundary.CommandForRole(r).EndsWith("\" --run"));}
  var now=DateTimeOffset.UtcNow;Yes(FormalPublicBoundary.BoundedDeadline("control-checks",now,now.AddMinutes(20),now.AddMinutes(20))==now.AddMinutes(15));Refuse(delegate{FormalPublicBoundary.BoundedDeadline("control-checks",now,now.AddMinutes(17),now.AddMinutes(20));});
  string env=CluedWindowsFormalEntry.ChildEnvironment();Yes(!env.Contains("PROXY=")&&!env.Contains("NODE_OPTIONS")&&env.Contains("CLUED_EXECUTION_PROVIDER=independent-control-checks-v1")&&env.EndsWith("\0\0"));Yes(env.Split(new[]{'\0'},StringSplitOptions.RemoveEmptyEntries).Length==8);
  var pins=new Dictionary<string,object>{{"sourceFiles",new object[]{__ROWS__}}};var expected="__ENTRYHASH__";Yes(FormalPublicBoundary.SourcePins(pins,expected,"control-checks").Count==60);Refuse(delegate{FormalPublicBoundary.SourcePins(pins,new string('a',64),"control-checks");});
  var missing=new Dictionary<string,object>{{"sourceFiles",new object[]{__ROWS__}.Skip(1).ToArray()}};Refuse(delegate{FormalPublicBoundary.SourcePins(missing,expected,"control-checks");});
  foreach(string p in new[]{"source-manifest.json","source/scripts/ci/clued-work-admission.mjs","source/work/actions-hosted-migration/independent-ci-v1/src/full-admission.mjs"})Yes(FormalRepairFiles.Fixed(p).EndsWith(p.Replace('/','\\')));
  foreach(string p in new[]{"installation.json","acceptance.json","verify-once.json","source/arbitrary.mjs","../source-manifest.json","source-manifest.json:stream"}){bool denied=false;try{FormalRepairFiles.Fixed(p);}catch(System.IO.IOException){denied=true;}Yes(denied);}
  foreach(string p in new[]{"installation.json","acceptance.json","formal-service-entry.json","formal-job.json","inbox/job.json","inbox/result.json"})Yes(FormalStageFiles.Fixed(p).EndsWith(p.Replace('/','\\')));
  foreach(string p in new[]{"source-manifest.json","source/scripts/ci/clued-work-admission.mjs","../formal-job.json","formal-job.json:stream"}){bool denied=false;try{FormalStageFiles.Fixed(p);}catch(System.IO.IOException){denied=true;}Yes(denied);}
  return n;
 }
}
'@
$entry=@($pins.runtimeFiles|Where-Object{$_.path -ceq 'work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v1/startup.mjs'})[0].sha256
$test=$test.Replace('__ROWS__',$rows).Replace('__ENTRYHASH__',$entry)
$utf8=New-Object Text.UTF8Encoding($false);[IO.File]::WriteAllText((Join-Path $fixture 'PureTests.cs'),$test,$utf8)
$hostCs=[IO.File]::ReadAllText((Join-Path $base 'invoker/HostFiles.cs'))+[char]10+[IO.File]::ReadAllText((Join-Path $base 'invoker/FormalRepairFiles.cs'))+[char]10+[IO.File]::ReadAllText((Join-Path $base 'batch/FormalStageFiles.cs'));[IO.File]::WriteAllText((Join-Path $fixture 'CombinedFiles.cs'),$hostCs,$utf8)
$assembly=Join-Path $fixture 'ControlInstallPure.dll'
Add-Type -Path @((Join-Path $base 'launcher/FormalPublicBoundary.cs'),(Join-Path $base 'launcher/FormalSession0.cs'),(Join-Path $base 'launcher/ScmPidHandshake.cs'),(Join-Path $fixture 'CombinedFiles.cs'),(Join-Path $fixture 'PureTests.cs')) -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll' -OutputAssembly $assembly -OutputType Library
$null=[Reflection.Assembly]::LoadFrom($assembly);$count=[ControlInstallPureTests]::Run();if($count -lt 35){throw 'PURE_ASSERTION_COUNT_LOW'}
$batchCount=& (Join-Path $base 'batch/test-pure.ps1');[pscustomobject]@{batchAssertions=$batchCount;status='OFFLINE_SOURCE_ONLY_PASS';pureAssertions=$count;ps51Parse=$true;unchangedPrimitives=6;hostRead=$false;hostWrite=$false;productionEntryCalled=$false;fixture=$fixture}|ConvertTo-Json
