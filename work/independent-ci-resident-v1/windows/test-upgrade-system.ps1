<#
.SYNOPSIS
  The LocalSystem test of the in-place upgrade's Compile chain (Task 695d31cc; DRAFT). ONE UAC. Changes no installed file and no service.

.DESCRIPTION
  Why: windows\test-upgrade-windows.ps1 and the offline drill run as the Owner (elevated) or with stand-in ports. upgrade-apply.ps1's Compile
  runs as LocalSystem (S-1-5-18) with ONLY SystemRoot and PATHEXT in its environment (upgrader/src/windows-port.mjs APPLY_ENV). A refusal that
  is specific to that identity (op 4c256a7b: SwapBroker --stable-digest admitted only the Owner, FIXED_INSTALL_OWNER_REQUIRED) therefore showed
  up only on the real machine. This script runs the same Compile recipe, and the freshly compiled SwapBroker.exe --stable-digest, as LocalSystem
  with that exact environment, on the CANDIDATE code of this checkout, so it can run before an install or upgrade. It is the must-run item
  whenever the upgrade channel or the Source v2 Windows code (resident-v2\windows\*.cs) changes.

  What it does (-Apply, elevated Owner token, once):
    1. recomputes the plan (-PlanSha256 must be the plan hash of the dry run), creates -Scratch (new, empty, short path) with a protected DACL
       (SYSTEM and Administrators only), copies the candidate sources into it (create-only, hash-checked) and writes the worker, the inner
       script and the job file (create-only);
    2. registers ONE one-shot scheduled task, Principal SYSTEM (S-1-5-18), highest run level, runs it, waits (-TimeoutSeconds), and ALWAYS deletes
       the task in a finally block;
    3. the worker (SYSTEM) starts a child powershell.exe whose environment is CLEARED to SystemRoot and PATHEXT (ProcessStartInfo,
       UseShellExecute = false); the child runs Invoke-CompileRecipe (the text cut out of upgrade-apply.ps1 by its syntax tree, which must
       equal the copy in install-resident.ps1) into Scratch\out\{bin,helpers}, then Scratch\out\bin\SwapBroker.exe --stable-digest <InstalledRoot>
       <acceptance.json sha256> <node profile sha256> (read-only: it opens the runner service with query rights);
    4. the Owner side runs the SAME exe once under the Owner's token; the verdict is PASS only if the four compiles succeeded, the SYSTEM digest
       is 64 hex and it equals the Owner-token digest. Nothing is written to InstalledRoot, no service is touched; only Scratch is written.

  Run (dry run first: no elevation, writes nothing, prints the plan and its hash):
      powershell -NoProfile -ExecutionPolicy Bypass -File windows\test-upgrade-system.ps1 -Scratch C:\w\sys1
  then, from an elevated PowerShell (the one UAC), with the plan hash from the dry run:
      powershell -NoProfile -ExecutionPolicy Bypass -File windows\test-upgrade-system.ps1 -Scratch C:\w\sys1 -Apply -PlanSha256 <planSha256>
  A second run needs a new -Scratch. The verdict is one JSON line (also Scratch\verdict.json); exit 0 = PASS, 1 = failed, 2 = refused before anything was done.

  Expected results:
    - on Source whose ResidentScmV2.InstallTimeStableDigest admits LocalSystem (InstallTimeIdentityAllowed): PASS;
    - on Source that admits only the Owner (ResidentScmV2.cs before PR #976): FAIL with FIXED_INSTALL_OWNER_REQUIRED (the acceptance criterion).
  Failure codes (fixed shapes): SYSTEM_COMPILE_FAILED:<ResidentServiceHost|SwapBroker|GenericHelper|CompanionJobHost>, FIXED_INSTALL_OWNER_REQUIRED,
  RUNNER_STABLE_DIGEST_UNCONFIRMED, SYSTEM_DIGEST_DIFFERS_FROM_OWNER, SYSTEM_ENV_NOT_CLEARED, SYSTEM_NOT_RUNNING_AS_SYSTEM, SYSTEM_TEST_TIMEOUT,
  SYSTEM_TEST_NO_RESULT. No secret is read or written; environment VALUES are never recorded (names only).

  -ApplyScript, -InstallScript and -SourceV2Dir exist for the offline test only (defaults: the files next to this script and of this checkout).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateLength(3, 60)][string]$Scratch,
  [string]$InstalledRoot = 'C:\ProgramData\CluedIndependentCI\resident',
  [switch]$Apply,
  [ValidatePattern('^([0-9a-f]{64})?$')][string]$PlanSha256 = '',
  [ValidateRange(60, 1800)][int]$TimeoutSeconds = 600,
  [string]$ApplyScript = '', [string]$InstallScript = '', [string]$SourceV2Dir = ''
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $PSCommandPath
if (-not $ApplyScript) { $ApplyScript = Join-Path $Here 'upgrade-apply.ps1' }
if (-not $InstallScript) { $InstallScript = Join-Path $Here 'install-resident.ps1' }
if (-not $SourceV2Dir) { $SourceV2Dir = Join-Path (Split-Path -Parent (Split-Path -Parent $Here)) 'actions-hosted-migration\independent-ci-v1\src\resident-v2\windows' }
$PlanContract = 'clued.independent-ci.upgrade-system-test-plan/1'
$ResultContract = 'clued.independent-ci.upgrade-system-test-result/1'
$TaskName = 'CluedCIUpgradeSystemTest'
$PowerShellExe = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$CandidateFiles = [ordered]@{ resident = 'ResidentServiceHost.cs'; broker = 'SwapBroker.cs'; jobHost = 'CompanionJobHost.cs' }

function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Sha256File([string]$p) { Sha256Bytes ([IO.File]::ReadAllBytes($p)) }
function Sha256Text([string]$t) { Sha256Bytes ((New-Object Text.UTF8Encoding($false)).GetBytes($t)) }
function Write-New([string]$path, [string]$text) {
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($text)
  $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}
function Copy-New([string]$from, [string]$to) {
  $bytes = [IO.File]::ReadAllBytes($from)
  $f = [IO.File]::Open($to, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
  if ((Sha256File $to) -cne (Sha256Bytes $bytes)) { throw 'COPY_HASH_MISMATCH' }
}
function Test-Ascii([string]$t) { -not [regex]::IsMatch($t, '[^\x00-\x7F]') }

# The text of one function, cut out of a script by its syntax tree (line ends normalised to LF).
function Get-FunctionText([string]$path, [string]$name) {
  $errors = $null; $tokens = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) { throw 'SCRIPT_DOES_NOT_PARSE' }
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
  if ($nodes.Count -ne 1) { throw ('FUNCTION_MISSING_OR_DUPLICATED:' + $name) }
  $nodes[0].Extent.Text.Replace("`r`n", "`n")
}
function Get-SourceV2Names([string]$applyScript) {
  $t = [IO.File]::ReadAllText($applyScript)
  $m = [regex]::Match($t, '\$SourceV2Files\s*=\s*@\(([^)]*)\)')
  if (-not $m.Success) { throw 'SOURCE_V2_FILE_LIST_MISSING' }
  $names = @([regex]::Matches($m.Groups[1].Value, "'([A-Za-z0-9]+\.cs)'") | ForEach-Object { $_.Groups[1].Value })
  if ($names.Count -lt 3) { throw 'SOURCE_V2_FILE_LIST_MISSING' }
  $names
}

# ---- The worker (runs as SYSTEM from the task): verifies its inputs, starts the child with a CLEARED environment, waits, reports. ----
$WorkerText = @'
param([Parameter(Mandatory)][string]$JobFile, [Parameter(Mandatory)][string]$JobSha256)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
$scratch = Split-Path -Parent $JobFile
$note = Join-Path $scratch 'worker.json'
function Note([string]$code) { $f = [IO.File]::Open($note, 'Create', 'Write', 'None'); try { $b = [Text.Encoding]::ASCII.GetBytes('{"worker":"' + $code + '"}'); $f.Write($b, 0, $b.Length) } finally { $f.Dispose() } }
try {
  if ((Sha256File $JobFile) -cne $JobSha256) { Note 'JOB_FILE_CHANGED'; exit 2 }
  $job = [IO.File]::ReadAllText($JobFile) | ConvertFrom-Json
  $inner = Join-Path $scratch 'inner.ps1'
  if ((Sha256File $inner) -cne [string]$job.innerSha256) { Note 'INNER_SCRIPT_CHANGED'; exit 2 }
  $root = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $inner + '" -JobFile "' + $JobFile + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # The environment the upgrader gives upgrade-apply.ps1 (windows-port.mjs APPLY_ENV): these two variables and nothing else.
  $psi.EnvironmentVariables.Clear()
  $psi.EnvironmentVariables['SystemRoot'] = $root
  $psi.EnvironmentVariables['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
  $p = [Diagnostics.Process]::Start($psi)
  try {
    if (-not $p.WaitForExit([int]$job.timeoutSeconds * 1000)) { $p.Kill(); Note 'TIMEOUT'; exit 1 }
    Note ('CHILD_EXIT_' + $p.ExitCode)
  } finally { $p.Dispose() }
} catch { Note 'WORKER_FAILED'; exit 1 }
'@

# ---- The inner script (the child, SYSTEM, cleared environment): the Compile recipe, then --stable-digest. Header and body around the recipe. ----
$InnerHead = @'
param([Parameter(Mandatory)][string]$JobFile)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$envNames = @(Get-ChildItem Env: | ForEach-Object { $_.Name } | Sort-Object)
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$GenericHelper = 'controller-formal-generic-v2.exe'
$CompanionJobHost = 'CluedCompanionJobHost.exe'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$Fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
'@
$InnerBody = @'
$job = [IO.File]::ReadAllText($JobFile) | ConvertFrom-Json
$res = [ordered]@{ contract = 'clued.independent-ci.upgrade-system-test-result/1'; ok = $false; code = $null; identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  environmentNames = $envNames; hashes = $null; digest = $null; digestExit = $null }
try {
  if ($res.identity -cne 'S-1-5-18') { $res.code = 'SYSTEM_NOT_RUNNING_AS_SYSTEM'; throw 'STOP' }
  if (@($envNames | Where-Object { $_ -ieq 'Path' }).Count -ne 0) { $res.code = 'SYSTEM_ENV_NOT_CLEARED'; throw 'STOP' }
  $out = Join-Path $job.scratch 'out'
  $src = Join-Path $job.scratch 'src'
  $bin = Join-Path $out 'bin'; $helpers = Join-Path $out 'helpers'
  [void][IO.Directory]::CreateDirectory($bin); [void][IO.Directory]::CreateDirectory($helpers)
  try {
    $hashes = Invoke-CompileRecipe $Csc $Fw $bin $helpers (Join-Path $src $job.files.resident) (Join-Path $src $job.files.broker) (Join-Path $src 'v2') (Join-Path $src $job.files.jobHost)
    $res.hashes = $hashes
  } catch {
    $m = [string]$_.Exception.Message
    $which = if ($m -cmatch '^SERVICE_HOST_COMPILE_FAILED:(ResidentServiceHost|SwapBroker)\z') { $Matches[1] } elseif ($m -ceq 'GENERIC_HELPER_COMPILE_FAILED') { 'GenericHelper' } elseif ($m -ceq 'COMPANION_JOB_HOST_COMPILE_FAILED') { 'CompanionJobHost' } else { 'Unknown' }
    $res.code = 'SYSTEM_COMPILE_FAILED:' + $which; throw 'STOP'
  }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $bin 'SwapBroker.exe'
  $psi.Arguments = '--stable-digest "' + $job.installedRoot + '" ' + $job.acceptanceSha256 + ' ' + $job.nodeProfileSha256
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  try {
    $stdout = $p.StandardOutput.ReadToEnd(); $stderr = $p.StandardError.ReadToEnd()
    if (-not $p.WaitForExit(120000)) { $p.Kill(); $res.code = 'RUNNER_STABLE_DIGEST_UNCONFIRMED'; throw 'STOP' }
    $res.digestExit = $p.ExitCode
  } finally { $p.Dispose() }
  $digest = $stdout.Trim()
  if (($stdout + $stderr).Contains('FIXED_INSTALL_OWNER_REQUIRED')) { $res.code = 'FIXED_INSTALL_OWNER_REQUIRED'; throw 'STOP' }
  if ($res.digestExit -ne 0 -or $digest -cnotmatch '^[0-9a-f]{64}$') { $res.code = 'RUNNER_STABLE_DIGEST_UNCONFIRMED'; throw 'STOP' }
  $res.digest = $digest; $res.ok = $true
} catch { if ([string]$_.Exception.Message -cne 'STOP') { $res.code = 'SYSTEM_TEST_UNEXPECTED' } }
$f = [IO.File]::Open((Join-Path $job.scratch 'result.json'), 'CreateNew', 'Write', 'None')
try { $b = (New-Object Text.UTF8Encoding($false)).GetBytes(($res | ConvertTo-Json -Depth 5 -Compress)); $f.Write($b, 0, $b.Length); $f.Flush($true) } finally { $f.Dispose() }
exit $(if ($res.ok) { 0 } else { 1 })
'@

function Get-Plan {
  $root = [IO.Path]::GetFullPath($InstalledRoot).TrimEnd('\')
  $scratchFull = [IO.Path]::GetFullPath($Scratch).TrimEnd('\')
  if (-not [IO.Path]::IsPathRooted($Scratch) -or $scratchFull.Length -lt 4) { throw 'SCRATCH_PATH_REFUSED' }
  if (Test-Path -LiteralPath $scratchFull) {
    if (-not (Test-Path -LiteralPath $scratchFull -PathType Container) -or @(Get-ChildItem -LiteralPath $scratchFull -Force).Count -ne 0) { throw 'SCRATCH_NOT_EMPTY' }
  }
  # The recipe both scripts carry must be one text.
  $a = Get-FunctionText $ApplyScript 'Invoke-CompileRecipe'
  $b = Get-FunctionText $InstallScript 'Invoke-CompileRecipe'
  if ($a -cne $b) { throw 'RECIPE_COPIES_DIFFER' }
  $acceptance = Join-Path $root 'record\acceptance.json'
  $receiptFile = Join-Path $root 'install\install-receipt.json'
  if (-not (Test-Path -LiteralPath $acceptance -PathType Leaf)) { throw 'ACCEPTANCE_MISSING' }
  if (-not (Test-Path -LiteralPath $receiptFile -PathType Leaf)) { throw 'INSTALL_RECEIPT_MISSING' }
  $receipt = try { [IO.File]::ReadAllText($receiptFile) | ConvertFrom-Json } catch { throw 'INSTALL_RECEIPT_UNREADABLE' }
  $nodeSha = if ($receipt.PSObject.Properties.Name -ccontains 'nodeProfileSha256') { [string]$receipt.nodeProfileSha256 } else { '' }
  if ($nodeSha -cnotmatch '^[0-9a-f]{64}\z') { throw 'NODE_PROFILE_SHA_MISSING' }
  $inputs = @()
  foreach ($k in $CandidateFiles.Keys) {
    $p = Join-Path $Here $CandidateFiles[$k]
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw ('CANDIDATE_SOURCE_MISSING:' + $CandidateFiles[$k]) }
    $inputs += [ordered]@{ name = $CandidateFiles[$k]; sha256 = (Sha256File $p) }
  }
  foreach ($n in (Get-SourceV2Names $ApplyScript)) {
    $p = Join-Path $SourceV2Dir $n
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw ('CANDIDATE_SOURCE_MISSING:' + $n) }
    $inputs += [ordered]@{ name = 'v2/' + $n; sha256 = (Sha256File $p) }
  }
  if (-not (Test-Ascii $InnerHead) -or -not (Test-Ascii $InnerBody) -or -not (Test-Ascii $WorkerText)) { throw 'SCRIPT_TEXT_NOT_ASCII' }
  # Both scripts start with a BOM (the recipe carries one non-ASCII character in a comment; Windows PowerShell 5.1 reads a BOM-less file as ANSI).
  $bom = [string][char]0xFEFF
  $inner = $bom + $InnerHead.Replace("`r`n", "`n") + "`n" + $a + "`n" + $InnerBody.Replace("`r`n", "`n") + "`n"
  $worker = $bom + $WorkerText.Replace("`r`n", "`n") + "`n"
  $plan = [ordered]@{ contract = $PlanContract; taskName = $TaskName; principal = 'S-1-5-18'; environment = @('PATHEXT', 'SystemRoot'); scratch = $scratchFull; installedRoot = $root
    acceptanceSha256 = (Sha256File $acceptance); nodeProfileSha256 = $nodeSha; inputs = $inputs; recipeCopiesIdentical = $true; recipeSha256 = (Sha256Text $a)
    cscPresent = (Test-Path -LiteralPath $Csc -PathType Leaf); workerSha256 = (Sha256Text $worker); innerSha256 = (Sha256Text $inner); timeoutSeconds = $TimeoutSeconds }
  [pscustomobject]@{ plan = $plan; planSha256 = (Sha256Text ($plan | ConvertTo-Json -Depth 6 -Compress)); worker = $worker; inner = $inner; recipe = $a }
}

function New-RunnerProcessInfo([string]$exe, [string[]]$arguments) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = ($arguments -join ' ')
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi
}

function Invoke-Apply($view) {
  $plan = $view.plan
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
  if (-not $PlanSha256 -or $PlanSha256 -cne $view.planSha256) { throw 'PLAN_SHA256_REQUIRED' }
  if (-not $plan.cscPresent) { throw 'CSC_MISSING' }
  # Scratch: new, with a protected DACL (SYSTEM and Administrators only) before anything is put into it.
  $sec = New-Object Security.AccessControl.DirectorySecurity
  $sec.SetSecurityDescriptorSddlForm('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($plan.scratch, $sec)
  $src = Join-Path $plan.scratch 'src'; [void][IO.Directory]::CreateDirectory((Join-Path $src 'v2'))
  foreach ($k in $CandidateFiles.Keys) { Copy-New (Join-Path $Here $CandidateFiles[$k]) (Join-Path $src $CandidateFiles[$k]) }
  foreach ($n in (Get-SourceV2Names $ApplyScript)) { Copy-New (Join-Path $SourceV2Dir $n) (Join-Path (Join-Path $src 'v2') $n) }
  foreach ($i in $plan.inputs) {
    $p = Join-Path $src ($i.name.Replace('/', '\'))
    if ((Sha256File $p) -cne $i.sha256) { throw 'COPIED_SOURCE_CHANGED' }
  }
  $workerFile = Join-Path $plan.scratch 'worker.ps1'; $innerFile = Join-Path $plan.scratch 'inner.ps1'; $jobFile = Join-Path $plan.scratch 'job.json'
  Write-New $workerFile $view.worker; Write-New $innerFile $view.inner
  if ((Sha256File $workerFile) -cne $plan.workerSha256 -or (Sha256File $innerFile) -cne $plan.innerSha256) { throw 'SCRIPT_WRITE_HASH_MISMATCH' }
  $job = [ordered]@{ scratch = $plan.scratch; installedRoot = $plan.installedRoot; acceptanceSha256 = $plan.acceptanceSha256; nodeProfileSha256 = $plan.nodeProfileSha256
    innerSha256 = $plan.innerSha256; timeoutSeconds = $plan.timeoutSeconds; files = [ordered]@{ resident = $CandidateFiles.resident; broker = $CandidateFiles.broker; jobHost = $CandidateFiles.jobHost } }
  Write-New $jobFile ($job | ConvertTo-Json -Depth 5 -Compress)
  $jobSha = Sha256File $jobFile
  # The one-shot task: SYSTEM, highest; registered, run, and ALWAYS deleted.
  $name = $TaskName + '-' + $jobSha.Substring(0, 8)
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = try { $svc.GetFolder('\Clued') } catch { $svc.GetFolder('\').CreateFolder('Clued') }
  $result = $null; $workerNote = $null; $timedOut = $false
  try {
    $def = $svc.NewTask(0)
    $def.Principal.UserId = 'S-1-5-18'; $def.Principal.LogonType = 5; $def.Principal.RunLevel = 1
    $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT' + [string]($TimeoutSeconds + 120) + 'S'
    $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
    $a = $def.Actions.Create(0); $a.Path = $PowerShellExe
    $a.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $workerFile + '" -JobFile "' + $jobFile + '" -JobSha256 ' + $jobSha
    $null = $folder.RegisterTaskDefinition($name, $def, 6, 'S-1-5-18', $null, 5)
    $task = $folder.GetTask($name)
    $null = $task.Run($null)
    $until = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds + 30)
    $resultFile = Join-Path $plan.scratch 'result.json'; $noteFile = Join-Path $plan.scratch 'worker.json'
    while (-not (Test-Path -LiteralPath $resultFile)) {
      if ([DateTime]::UtcNow -gt $until) { $timedOut = $true; break }
      if ((Test-Path -LiteralPath $noteFile) -and [int]$folder.GetTask($name).State -ne 4) { Start-Sleep -Seconds 1; break }
      Start-Sleep -Seconds 2
    }
    if (Test-Path -LiteralPath $resultFile) { $result = [IO.File]::ReadAllText($resultFile) | ConvertFrom-Json }
    if (Test-Path -LiteralPath $noteFile) { $workerNote = ([IO.File]::ReadAllText($noteFile) | ConvertFrom-Json).worker }
  } finally {
    try { $folder.GetTask($name).Stop(0) } catch { }
    try { $folder.DeleteTask($name, 0) } catch { }
  }
  # The verdict.
  $code = $null; $systemDigest = $null; $ownerDigest = $null
  if ($null -eq $result) { $code = $(if ($timedOut -or $workerNote -ceq 'TIMEOUT') { 'SYSTEM_TEST_TIMEOUT' } else { 'SYSTEM_TEST_NO_RESULT' }) }
  elseif ($result.ok -ne $true) { $code = [string]$result.code }
  else {
    $systemDigest = [string]$result.digest
    # The same freshly compiled exe under the Owner's token (read-only).
    $exe = Join-Path $plan.scratch 'out\bin\SwapBroker.exe'
    $psi = New-RunnerProcessInfo $exe @('--stable-digest', ('"' + $plan.installedRoot + '"'), $plan.acceptanceSha256, $plan.nodeProfileSha256)
    $p = [Diagnostics.Process]::Start($psi)
    try { $o = $p.StandardOutput.ReadToEnd(); $null = $p.StandardError.ReadToEnd(); $null = $p.WaitForExit(120000); $ownerDigest = $o.Trim() } finally { $p.Dispose() }
    if ($ownerDigest -cnotmatch '^[0-9a-f]{64}\z') { $code = 'RUNNER_STABLE_DIGEST_UNCONFIRMED' }
    elseif ($ownerDigest -cne $systemDigest) { $code = 'SYSTEM_DIGEST_DIFFERS_FROM_OWNER' }
  }
  $verdict = [ordered]@{ contract = $ResultContract; verdict = $(if ($null -eq $code) { 'PASS' } else { 'FAIL' }); code = $code; scratch = $plan.scratch; planSha256 = $view.planSha256
    systemIdentity = $(if ($null -ne $result) { [string]$result.identity } else { $null }); environmentNames = $(if ($null -ne $result) { @($result.environmentNames) } else { $null })
    systemDigestPrefix = $(if ($systemDigest) { $systemDigest.Substring(0, 12) } else { $null }); ownerDigestPrefix = $(if ($ownerDigest -cmatch '^[0-9a-f]{64}\z') { $ownerDigest.Substring(0, 12) } else { $null })
    taskDeleted = $true; at = [DateTimeOffset]::UtcNow.ToString('o') }
  $json = $verdict | ConvertTo-Json -Depth 5 -Compress
  Write-New (Join-Path $plan.scratch 'verdict.json') $json
  $json
  if ($null -eq $code) { exit 0 } else { exit 1 }
}

try {
  $view = Get-Plan
  if (-not $Apply) {
    # Dry run: no elevation, nothing written. The plan, its hash and the next command.
    $out = [ordered]@{ mode = 'dry-run'; plan = $view.plan; planSha256 = $view.planSha256 }
    $out | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }
  Invoke-Apply $view
} catch {
  $m = [string]$_.Exception.Message
  $code = if ($m -cmatch '^([A-Z][A-Z0-9_]{2,80})(?::([A-Za-z0-9_.-]{1,80}))?\z') { $m } else { 'UPGRADE_SYSTEM_TEST_UNEXPECTED' }
  [ordered]@{ mode = $(if ($Apply) { 'apply' } else { 'dry-run' }); verdict = 'REFUSED'; code = $code } | ConvertTo-Json -Compress
  exit 2
}
