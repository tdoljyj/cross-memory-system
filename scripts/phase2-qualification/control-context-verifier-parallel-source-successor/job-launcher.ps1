# Fixed production-candidate entry. Stdin is only the original bounded JSON batch.
$ErrorActionPreference='Stop'
if($args.Count -ne 0){throw 'FIXED_JOB_LAUNCHER_NO_ARGUMENTS'}
$taskDirectory='C:/Users/Windows/Documents/Codex/2026-09-08/ia/work/kernel-phase2-repo/scripts/phase2-qualification/control-context-verifier-parallel-source-successor'
$taskPins=@{
 'C:/Program Files/nodejs/node.exe'='3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'
 'blob-worker.mjs'='ef6286059294d7c6f256e7a2386395fc848f02b175ef08c465c72e731828a9a1'
 'ref-plan.mjs'='8f1d4f0f3033632d5a93e449495ebcda2774125ec2440abb1dd148da5d58ad63'
 'FixedJobLauncher.cs'='feef01a62576d2159e697c290be1a9b1e45f1432a65a1e17b8142afc80a1031c'
}
foreach($taskEntry in $taskPins.GetEnumerator()){
 $taskPath=if([System.IO.Path]::IsPathRooted($taskEntry.Key)){$taskEntry.Key}else{Join-Path $taskDirectory $taskEntry.Key}
 $taskHasher=[System.Security.Cryptography.SHA256]::Create()
 try {$taskDigest=[BitConverter]::ToString($taskHasher.ComputeHash([System.IO.File]::ReadAllBytes($taskPath))).Replace('-','').ToLowerInvariant()}
 finally {$taskHasher.Dispose()}
 if($taskDigest -ne $taskEntry.Value){throw 'FIXED_JOB_WORKER_SOURCE_DRIFT'}
}
$env:NODE_OPTIONS='';$env:NODE_PATH=''
Add-Type -Path (Join-Path $taskDirectory 'FixedJobLauncher.cs') -ErrorAction Stop
$taskNode='C:/Program Files/nodejs/node.exe'
$taskWorker=Join-Path $taskDirectory 'blob-worker.mjs'
$taskCommand='"'+$taskNode+'" "'+$taskWorker+'"'
try {$taskExit=[FixedJobLauncher]::Run($taskNode,$taskCommand,$taskDirectory);exit $taskExit}
catch {[Console]::Error.WriteLine($_.Exception.ToString());exit 1}
