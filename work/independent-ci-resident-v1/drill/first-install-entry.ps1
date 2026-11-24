# Guest-only entry. Dot sourcing loads pure helpers only; it never prepares this host.
[CmdletBinding()]
param([string]$From, [string]$Kit, [string]$Fake, [string]$Work, [string]$Version)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Get-EntryProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { return $Object[$Name] }
  $p = $Object.PSObject.Properties[$Name]; if ($null -ne $p) { return $p.Value }; return $null
}

# Bootstrap prints a compact terminal JSON object; tolerate the launcher's indented JSON too.
function Read-FirstInstallTerminal([string]$Text) {
  $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() })
  if (-not $lines.Count) { return $null }
  try { return ($lines[-1] | ConvertFrom-Json) } catch { }
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -ceq '{') { try { return (($lines[$i..($lines.Count - 1)] -join "`n") | ConvertFrom-Json) } catch { return $null } }
  }
  return $null
}

# Pure terminal conversion: a zero exit, missing verdict or partial companion switch never becomes success.
function ConvertTo-FirstInstallEntryResult($Terminal, [int]$ExitCode, [string]$Tree, [string]$Node) {
  $status = [string](Get-EntryProperty $Terminal 'status')
  $code = [string](Get-EntryProperty $Terminal 'code')
  $ok = $ExitCode -eq 0 -and $status -ceq 'BOOTSTRAP_DONE' -and $code -ceq '' -and $Tree -and $Node
  if (-not $ok -and -not $code) {
    $code = if ($null -eq $Terminal -or -not $status) { 'DRILL_BOOTSTRAP_NO_VERDICT' }
      elseif ($status -cne 'BOOTSTRAP_DONE') { $status }
      elseif ($ExitCode -ne 0) { 'DRILL_BOOTSTRAP_EXIT_NONZERO' } else { 'DRILL_BOOTSTRAP_TREE_OR_NODE_MISSING' }
  }
  return [ordered]@{ status = $(if ($ok) { 'FIRST_INSTALL_DONE' } else { 'FIRST_INSTALL_STOPPED' });
    stopCode = $(if ($ok) { $null } else { $code }); tree = $Tree; node = $Node }
}

# Fixed names expected by first-install-host.ps1. These refs are synthetic, registered nowhere.
function ConvertTo-FirstInstallPublic($Public) {
  if ([string](Get-EntryProperty $Public 'contract') -cne 'clued.drill.fake-credentials/1') { throw 'DRILL_FAKE_CONTRACT_REFUSED' }
  foreach ($key in @('ciPrincipalBindingId', 'ciPrincipalRoleRef', 'ciPrincipalQualificationRef')) {
    $g = [guid]::Empty
    if (-not [guid]::TryParse([string](Get-EntryProperty $Public $key), [ref]$g) -or $g -eq [guid]::Empty) { throw 'DRILL_FAKE_PUBLIC_REFUSED' }
  }
  return [ordered]@{ appKeyId = (Get-EntryProperty $Public 'appKeyId');
    ciPrincipalBindingId = (Get-EntryProperty $Public 'ciPrincipalBindingId');
    ciPrincipalRoleRef = (Get-EntryProperty $Public 'ciPrincipalRoleRef');
    ciPrincipalQualificationRef = (Get-EntryProperty $Public 'ciPrincipalQualificationRef'); heartbeatBindingId = '' }
}

function Assert-FirstInstallGuest {
  $me = [Security.Principal.WindowsIdentity]::GetCurrent()
  $machine = Get-CimInstance Win32_ComputerSystem
  if ($env:COMPUTERNAME -cne 'CLUED-DRILL' -or $machine.Model -cne 'Virtual Machine' -or $machine.Manufacturer -cne 'Microsoft Corporation' -or
      $me.Name.Split('\')[-1] -cne 'drill' -or -not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'DRILL_ENTRY_NOT_THE_ELEVATED_GUEST' }
  if ($From -cne 'C:\drill\from' -or $Kit -cne 'C:\drill\kit' -or $Fake -cne 'C:\drill\fake' -or $Work -cne 'C:\drill\work') { throw 'DRILL_ENTRY_GUEST_PATH_REFUSED' }
}

function Assert-FirstInstallRelease {
  $pins = Get-Content -LiteralPath (Join-Path $Kit 'release-pins.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pins.version -cne $Version) { throw 'DRILL_RELEASE_VERSION_MISMATCH' }
  $seen = @{}
  foreach ($f in $pins.files) {
    if ($f.path -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$' -or $f.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($f.path)) { throw 'DRILL_RELEASE_PINS_REFUSED' }
    $seen[$f.path] = $true
    if ((Get-FileHash -LiteralPath (Join-Path $From $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $f.sha256) { throw 'DRILL_RELEASE_CHANGED_IN_COPY' }
  }
  if (@(Get-ChildItem -LiteralPath $From -Force).Count -ne $seen.Count) { throw 'DRILL_RELEASE_UNLISTED_ASSET' }
}

# Fable renew-key ruling, supplement "branch two, two points" 1 (the drill's side): a stage child's stdout goes to its log line by line as
# it comes, so a stage cut off at its limit still leaves what it printed. Otherwise as the package's Invoke-StageChild (the same argument
# quoting; stdout and stderr apart; nothing killed at the limit) and, with -NoWindow and $EnvAdd, as its Invoke-NonElevated. A limit of 0
# waits for the end.
# The drill installs against the drill's server, never production (FABLE-drill-role-probe-20261124.md, PR-3). The kit names the server
# stand-in (kit.json server, make-drill-kit.mjs): the first-install kit in From must name that server -- the Release's own, with the
# production address, is refused before anything is installed -- and every production host the kit lists is cut off in this guest's hosts
# file (0.0.0.0 and ::), so nothing the package starts can reach it whatever it reads; the checkpoint restore takes the lines away.
# Each name is then resolved: an answer that is not the black hole means the guest is not cut off, and the install does not start.
# $HostsFile, $Resolve: the guest's own by default, and then only on the drill guest; a test gives its own.
function Set-EntryServerBlackhole([string]$HostsFile = '', [scriptblock]$Resolve = $null) {
  $manifest = Get-Content -LiteralPath (Join-Path $Kit 'kit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $server = Get-EntryProperty $manifest 'server'
  $hosts = @(Get-EntryProperty $server 'blackholeHosts' | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  $address = [string](Get-EntryProperty $server 'supabaseUrl')
  if ($null -eq $server -or [string](Get-EntryProperty $server 'contract') -cne 'clued.drill.server-stand-in/1' -or $hosts.Count -lt 1 -or
      $address -cnotmatch '^https://([a-z0-9]+\.supabase\.co)$') { throw 'DRILL_ENTRY_SERVER_STAND_IN_MISSING' }
  $drillHost = $Matches[1]
  foreach ($h in $hosts) { if ($h -cnotmatch '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' -or $h -ceq $drillHost) { throw 'DRILL_ENTRY_SERVER_STAND_IN_MISSING' } }
  $firstKit = Get-Content -LiteralPath (Join-Path $From "fleet-node-$Version.first-install-kit.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $named = [string](Get-EntryProperty (Get-EntryProperty $firstKit 'record') 'supabaseUrl')
  if ($named -cne $address) { throw 'DRILL_ENTRY_SERVER_IS_PRODUCTION' }
  if (-not $HostsFile) {
    if ($env:COMPUTERNAME -cne 'CLUED-DRILL') { throw 'DRILL_ENTRY_NOT_THE_ELEVATED_GUEST' }   # never another machine's hosts file
    $HostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  }
  if ($null -eq $Resolve) { $Resolve = { param($n) try { @([Net.Dns]::GetHostAddresses($n) | ForEach-Object { $_.IPAddressToString }) } catch { @() } } }
  $have = @(Get-Content -LiteralPath $HostsFile -Encoding ASCII -ErrorAction SilentlyContinue | ForEach-Object { ([string]$_).Trim() })
  $add = @()
  foreach ($h in $hosts) { foreach ($line in @("0.0.0.0 $h", ":: $h")) { if ($have -cnotcontains $line) { $add += $line } } }
  if ($add.Count) { [IO.File]::AppendAllText($HostsFile, "`r`n" + ($add -join "`r`n") + "`r`n", [Text.Encoding]::ASCII) }
  foreach ($h in $hosts) {
    # no answer at all is cut off too; any address but the black hole is not
    foreach ($a in @(& $Resolve $h)) { if (@('0.0.0.0', '::') -cnotcontains [string]$a) { throw 'DRILL_ENTRY_PRODUCTION_NOT_CUT_OFF' } }
  }
  return [ordered]@{ hosts = $hosts; server = $drillHost; added = $add.Count }
}

function Invoke-EntryStreamedChild([string]$Exe, [string[]]$Arguments, [int]$LimitSeconds, [string]$Log, [hashtable]$EnvAdd = @{}, [switch]$NoWindow) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = (($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = [bool]$NoWindow
  foreach ($k in @($EnvAdd.Keys)) { $psi.EnvironmentVariables[$k] = $EnvAdd[$k] }
  $writer = New-Object IO.StreamWriter -ArgumentList $Log, $false, (New-Object Text.UTF8Encoding($false))
  $writer.AutoFlush = $true
  $out = New-Object Text.StringBuilder
  $lastOf = { param($t) if (Test-Path -LiteralPath 'function:Get-LastJsonLine') { Get-LastJsonLine $t } else { $null } }
  try {
    $proc = [Diagnostics.Process]::Start($psi)
    $err = $proc.StandardError.ReadToEndAsync()
    # One deadline for every wait (Codex review of c1497e0a1, medium 1): the next line, the child's exit and the end of its stderr. Past
    # it the result is a timeout at once, even while lines keep coming.
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $LimitSeconds))
    $left = { if ($LimitSeconds -gt 0) { [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds) } else { -1 } }
    $timeout = { [ordered]@{ exit = $null; timedOut = $true; pid = $proc.Id; stdout = $out.ToString(); stderr = $null; last = [ordered]@{ status = 'STAGE_CHILD_STILL_RUNNING'; pid = $proc.Id; note = 'nothing was killed' } } }
    while ($true) {
      if ($LimitSeconds -gt 0 -and [DateTime]::UtcNow -ge $deadline) { return (& $timeout) }
      $next = $proc.StandardOutput.ReadLineAsync()
      if (-not $next.Wait((& $left))) { return (& $timeout) }
      if ($null -eq $next.Result) { break }
      $writer.WriteLine($next.Result); [void]$out.AppendLine($next.Result)
    }
    if (-not $proc.WaitForExit((& $left))) { return (& $timeout) }
    if (-not $err.Wait((& $left))) { return (& $timeout) }
    $e = [string]$err.Result
    $text = $out.ToString()
    [ordered]@{ exit = $proc.ExitCode; timedOut = $false; pid = $proc.Id; stdout = $text; stderr = $(if ($e.Length -gt 4000) { $e.Substring($e.Length - 4000) } else { $e }); last = (& $lastOf $text) }
  } finally { $writer.Dispose() }
}

# Whether the package's host preparation takes -Kit (package 0a4abc6f2 on): read from the script's own parameters.
function Test-EntryHostTakesKit([string]$HostScript) {
  return (Get-Command -Name $HostScript -ErrorAction Stop).Parameters.ContainsKey('Kit')
}
# A host preparation that takes -StepProgress writes each of its steps' start and end into the entry's stage record (item 7 of the fix
# round of 87d330d0); an older one is called as before and its stage says only the last step it printed (drill-vm.ps1 timeline).
function Test-EntryHostTakesStepProgress([string]$HostScript) {
  return (Get-Command -Name $HostScript -ErrorAction Stop).Parameters.ContainsKey('StepProgress')
}

# The host preparation's own verdict carried as it is (Fable renew-key ruling, supplement "after the package branch" 3): a restart
# Windows asks for, or a refusal, stops the entry with the package's code and the verdict's fields after ':', never a blanket failure.
function Get-EntryHostStopCode($HostRun) {
  $last = Get-EntryField $HostRun 'last'
  $status = Get-EntryField $last 'status'
  if ((Get-EntryField $HostRun 'exit') -eq 0 -and $status -ceq 'FIRST_INSTALL_HOST_READY') { return $null }
  $raw = if ($null -ne $last) { ConvertTo-Json -InputObject $last -Compress -Depth 6 } else { 'exit=' + (Get-EntryField $HostRun 'exit') }
  if ($status -ceq 'RESTART_THEN_RUN_THE_SAME_COMMAND') { return ('RESTART_THEN_RUN_THE_SAME_COMMAND:' + $raw) }
  return ('HOST_PREPARATION_NOT_DONE:' + $raw)
}
# One field of an object the package's parser gave (Get-LastJsonLine: a JavaScriptSerializer Dictionary, whose IDictionary.Contains is an
# explicit interface member) or of a PowerShell object: read as the package's own Get-Key reads it, through IDictionary (Codex review of
# e0a3cded5, high 1).
function Get-EntryField($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { if (([Collections.IDictionary]$Object).Contains($Name)) { return $Object[$Name] }; return $null }
  $p = $Object.PSObject.Properties[$Name]; if ($p) { return $p.Value }; return $null
}

# A stage's output file is this run's alone: one left from an earlier run is removed before the stage starts, and still there is a refusal
# (the stage would then be read for another run's verdict).
function Clear-EntryStageOutput([string]$Path) {
  if ([IO.File]::Exists($Path)) { try { [IO.File]::Delete($Path) } catch { } }
  if ([IO.File]::Exists($Path)) { throw ('DRILL_STAGE_OUTPUT_NOT_CLEARED:' + [IO.Path]::GetFileName($Path)) }
}

# A stage file read while its writer may still hold it open (read-write sharing, as bootstrap.ps1 Read-StageResult reads it).
function Read-EntrySharedText([string]$Path) {
  $fs = New-Object IO.FileStream -ArgumentList $Path, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::ReadWrite)
  try { (New-Object IO.StreamReader -ArgumentList $fs, (New-Object Text.UTF8Encoding($false))).ReadToEnd() } finally { $fs.Dispose() }
}

# A launcher stage's verdict, by the drill's rule (drill-vm.ps1 Test-DrillStageVerdict): a status that is a non-empty string and not one
# of the package's "no verdict" codes.
function Test-EntryStageVerdict($Terminal) {
  if ($null -eq $Terminal) { return $false }
  $s = Get-EntryField $Terminal 'status'
  return ($s -is [string]) -and ($s.Length -gt 0) -and (@('STAGE_CHILD_PRINTED_NO_VERDICT', 'STAGE_GAVE_NO_VERDICT') -cnotcontains $s)
}

# Fable ruling 0e418483 (r6 Linux phase A) 4.2: the launcher stage always meets a cold WSL, the worst case a new machine can give (how long
# lies between its host preparation and its launcher is not ours to choose). Right before that stage the guest's WSL is shut down and what
# still runs is listed (it should be nothing); both answers, raw (exit, stdout, stderr), are wsl-cold-start.json, which drill-vm.ps1 takes
# into stage-evidence.json. The list is recorded, never judged: what wsl.exe prints and exits with when nothing runs was never measured. A
# shutdown that fails or does not end stops the entry by name: the launcher would not run cold.
function Invoke-EntryWslColdStart([string]$Output, [string]$LogDir, [string]$WslExe = 'C:\Program Files\WSL\wsl.exe') {
  $answer = { param($r) [ordered]@{ exit = $r.exit; timedOut = $r.timedOut; stdout = $r.stdout; stderr = $r.stderr } }
  $record = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); shutdown = $null; runningAfter = $null }
  try {
    $record.shutdown = & $answer (Invoke-EntryStreamedChild $WslExe @('--shutdown') 120 (Join-Path $LogDir 'wsl-shutdown.stdout.log') @{ WSL_UTF8 = '1' } -NoWindow)
    $record.runningAfter = & $answer (Invoke-EntryStreamedChild $WslExe @('--list', '--running') 60 (Join-Path $LogDir 'wsl-list-running.stdout.log') @{ WSL_UTF8 = '1' } -NoWindow)
  } finally {
    [IO.File]::WriteAllText((Join-Path $Output 'wsl-cold-start.json'), ($record | ConvertTo-Json -Compress -Depth 4), (New-Object Text.UTF8Encoding($false)))
  }
  if ($record.shutdown.timedOut -or $record.shutdown.exit -ne 0) { throw ('DRILL_WSL_SHUTDOWN_FAILED:' + $(if ($record.shutdown.timedOut) { 'timedOut' } else { 'exit=' + $record.shutdown.exit })) }
}

# r9 follow-up (task 0e418483, FABLE-drill-r9-followup 3.2 (3)): the 683 s the entry spent before the host stage had no parts. The phases
# before it are timed by name into the same stage-timings.json: assets (the asset set and its hashes), prereq (copying and expanding the
# tools), unpack (the two tar extractions, added up), check (first-install-check). A phase not reached stays null; one cut off by a stop
# keeps the time it ran.
function New-EntryMeasurements {
  [ordered]@{ assets = $null; prereq = $null; unpack = $null; check = $null; host = $null; prepare = $null; launcher = $null }
}
function New-EntryPhaseClock { @{ name = $null; watch = (New-Object Diagnostics.Stopwatch) } }
# Ends the phase that is open (its seconds are added to its name) and opens $Name; an empty $Name only ends. Timing only: the stage
# record (stage-progress.jsonl) is written by the entry itself, each stage ended after its own verdict (Start-EntryStage, Stop-EntryStage).
function Enter-EntryPhase($Measurements, $Clock, [string]$Name) {
  if ($Clock.name) { $Measurements[$Clock.name] = [double]$Measurements[$Clock.name] + $Clock.watch.Elapsed.TotalSeconds }
  $Clock.name = $(if ($Name) { $Name } else { $null })
  $Clock.watch.Restart()
}
# Glass box (coordinator, Owner 11-23; Fable plan 87d330d0): each stage, as it starts and as it ends, is one line in stage-progress.jsonl in the
# output directory, written there and then -- stage, startedAt, endedAt, result (running, ok, failed), code, and the last lines of the
# stage's log when it has one. The drill host pulls the file every tick (drill-vm.ps1 Step-DrillGuestProgress), so a first install cut
# off anywhere still says how far it got and what each stage concluded. An aid only: a line that cannot be written is not written.
$script:EntryStageOutput = $null
$script:EntryStageOpen = $null
$script:EntryStageTailLines = 5
$script:EntryStageTailChars = 300
function Get-EntryStageTail([string]$Log) {
  if (-not $Log) { return $null }
  try {
    if (-not [IO.File]::Exists($Log)) { return $null }
    $lines = @((Read-EntrySharedText $Log) -split "`r?`n" | Where-Object { $_ -ne '' } | Select-Object -Last $script:EntryStageTailLines)
    return @($lines | ForEach-Object { if ($_.Length -gt $script:EntryStageTailChars) { $_.Substring(0, $script:EntryStageTailChars) } else { $_ } })
  } catch { return $null }
}
function Write-EntryStageLine($Line) {
  if (-not $script:EntryStageOutput) { return }
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((ConvertTo-Json -InputObject $Line -Compress -Depth 4) + "`n")
    $fs = New-Object IO.FileStream -ArgumentList (Join-Path $script:EntryStageOutput 'stage-progress.jsonl'), ([IO.FileMode]::Append), ([IO.FileAccess]::Write), ([IO.FileShare]::ReadWrite)
    try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
  } catch { }
}
# The steps inside a stage (the prereq stage: each item's sha, copy, get, expand; the tools found last): one line as a step starts and one
# as it ends -- stage, item, step, bytes (the item's size from the manifest), startedAt, endedAt, result, code -- so a stage cut off says
# which item and which step it was in (coordinator, item 6 of the fix round of 87d330d0).
$script:EntryStepOpen = $null
function Start-EntryStep([string]$Item, [string]$Step, $Bytes = $null) {
  Stop-EntryStep 'ok'
  $stage = $(if ($null -ne $script:EntryStageOpen) { $script:EntryStageOpen.stage } else { $null })
  $script:EntryStepOpen = @{ stage = $stage; item = $Item; step = $Step; bytes = $Bytes; startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
  Write-EntryStageLine ([ordered]@{ stage = $stage; event = 'step-start'; item = $Item; step = $Step; bytes = $Bytes; startedAt = $script:EntryStepOpen.startedAt
    endedAt = $null; result = 'running'; code = $null })
}
# Ends the open step (nothing open: nothing written).
function Stop-EntryStep([string]$Result, [string]$Code = $null) {
  $open = $script:EntryStepOpen; $script:EntryStepOpen = $null
  if ($null -eq $open) { return }
  if ($Code -and $Code.Length -gt $script:EntryStageTailChars) { $Code = $Code.Substring(0, $script:EntryStageTailChars) }
  Write-EntryStageLine ([ordered]@{ stage = $open.stage; event = 'step-end'; item = $open.item; step = $open.step; bytes = $open.bytes; startedAt = $open.startedAt
    endedAt = [DateTimeOffset]::UtcNow.ToString('o'); result = $Result; code = $(if ($Code) { $Code } else { $null }) })
}
# Ends the open stage with $Result and $Code, its open step first with the same. Nothing open and a stop ($Result failed): the stop is
# written on its own as 'between-stages', never lost; nothing open otherwise: nothing written.
function Stop-EntryStage([string]$Result, [string]$Code = $null) {
  Stop-EntryStep $Result $Code
  $open = $script:EntryStageOpen; $script:EntryStageOpen = $null
  if ($Code -and $Code.Length -gt $script:EntryStageTailChars) { $Code = $Code.Substring(0, $script:EntryStageTailChars) }
  if ($null -eq $open) {
    if ($Result -ceq 'failed') {
      $at = [DateTimeOffset]::UtcNow.ToString('o')
      Write-EntryStageLine ([ordered]@{ stage = 'between-stages'; event = 'end'; startedAt = $at; endedAt = $at; result = 'failed'; code = $(if ($Code) { $Code } else { $null }); tail = $null })
    }
    return
  }
  $lines = Get-EntryStageTail $open.log; $tail = $null
  if ($null -ne $lines) { $tail = [string[]]@($lines) }   # a list even of one line
  Write-EntryStageLine ([ordered]@{ stage = $open.stage; event = 'end'; startedAt = $open.startedAt; endedAt = [DateTimeOffset]::UtcNow.ToString('o')
    result = $Result; code = $(if ($Code) { $Code } else { $null }); tail = $tail })
}
# Ends the open stage as ok (the next one started: it got through) and starts $Stage; $Log is the stage's own log, if it has one.
function Start-EntryStage([string]$Stage, [string]$Log = $null) {
  Stop-EntryStage 'ok'
  $script:EntryStageOpen = @{ stage = $Stage; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); log = $Log }
  Write-EntryStageLine ([ordered]@{ stage = $Stage; event = 'start'; startedAt = $script:EntryStageOpen.startedAt; endedAt = $null; result = 'running'; code = $null; tail = $null })
}

function Write-EntryStageTimings([string]$Output, $Measurements) {
  [IO.File]::WriteAllText((Join-Path $Output 'stage-timings.json'), ($Measurements | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
}

# r9 follow-up (FABLE-drill-r9-followup 1.3 B): a first install that did not end FIRST_INSTALL_DONE leaves resident-failure-snapshot.json
# in the entry's output directory, beside launcher-result.json, so it goes back with the stage files before any restore (r9's HALT.json
# never left the guest). What it reads is one fixed list, drill/guest-failure-files.json (in the kit, beside this script): the resident's
# HALT, PAUSED and status records, the launcher's progress records and verify's full answer. Plus the generic helper's refusal events
# (Application log, its service name as source) and the Service Control Manager's System events since the entry started. Bounded:
# 64 KiB of each file, 1 MiB for the whole snapshot. Never a secret: a list that names a
# secrets or credentials directory, or a file that is not .json, is refused whole, and a wildcard that reaches one reads nothing there.
$script:EntryFailureFilesContract = 'clued.drill.guest-failure-files/1'
$script:EntryFailureSnapshotContract = 'clued.drill.resident-failure-snapshot/1'
$script:EntryFailureFileBytes = 64KB
$script:EntryFailureTotalBytes = 1MB
$script:EntryFailureEventMax = 50
$script:EntryFailureEventChars = 300
$script:EntryFailureMatchMax = 200
$script:EntryFailureSiblingMax = 50
$script:EntryFailureSiblingChars = 120
# users: the profiles, for the companion account's own supervisor.json (first-install-host.ps1 names the account clued-companion; a profile
# directory may carry a suffix, so the list names it with a *).
$script:EntryFailureRoots = @{ ci = 'C:\ProgramData\CluedIndependentCI'; work = $null; users = 'C:\Users' }   # work: the bootstrap's work directory, known once it is made

function Test-EntryFailureSecretSegment([string]$Segment) { $Segment -match '^(secrets|credentials)$' }

# The list's entries ({ root, path }), or a refusal by name. A path is relative, backslash separated, of plain segments in which * stands
# for any run of characters within one segment; its leaf ends in .json.
function Read-EntryFailureFiles([string]$File) {
  $doc = $null
  try { $doc = [IO.File]::ReadAllText($File) | ConvertFrom-Json } catch { throw 'DRILL_FAILURE_FILES_REFUSED:unreadable' }
  if ([string](Get-EntryProperty $doc 'contract') -cne $script:EntryFailureFilesContract) { throw 'DRILL_FAILURE_FILES_REFUSED:contract' }
  $files = @(Get-EntryProperty $doc 'files' | Where-Object { $null -ne $_ })
  if ($files.Count -lt 1 -or $files.Count -gt 32) { throw 'DRILL_FAILURE_FILES_REFUSED:count' }
  $out = @()
  foreach ($f in $files) {
    $root = Get-EntryProperty $f 'root'; $path = Get-EntryProperty $f 'path'
    if ($root -isnot [string] -or @('ci', 'work', 'users') -cnotcontains $root) { throw 'DRILL_FAILURE_FILES_REFUSED:root' }
    if ($path -isnot [string] -or $path -cnotmatch '^[A-Za-z0-9._*-]+(\\[A-Za-z0-9._*-]+)*$') { throw 'DRILL_FAILURE_FILES_REFUSED:path' }
    $segments = @($path.Split('\'))
    foreach ($segment in $segments) {
      if ($segment -match '^\.+$') { throw 'DRILL_FAILURE_FILES_REFUSED:path' }
      if (Test-EntryFailureSecretSegment $segment) { throw 'DRILL_FAILURE_FILES_REFUSED:secret-path' }
    }
    if ($segments[-1] -notmatch '\.json$') { throw 'DRILL_FAILURE_FILES_REFUSED:not-json' }
    $out += , ([ordered]@{ root = $root; path = $path })
  }
  return , $out
}

# The files one entry names under its root, sorted: each * segment is listed, nothing is followed out of the root, and a secrets or
# credentials directory a wildcard reaches is passed over.
# $Trace (optional): when the walk finds nothing, where it stopped -- stoppedAt, the segment of the list's path nothing matched, and
# dir, the last directory that is there ($null when not even the root is).
function Resolve-EntryFailurePath([string]$Root, [string]$Path, [hashtable]$Trace = $null) {
  $segments = @($Path.Split('\'))
  $at = @($Root)
  for ($i = 0; $i -lt $segments.Count; $i++) {
    $segment = $segments[$i]; $last = ($i -eq $segments.Count - 1); $next = @()
    if ($null -ne $Trace) { $Trace['stoppedAt'] = $segment; $Trace['dir'] = (@($at | Where-Object { [IO.Directory]::Exists($_) }) | Select-Object -First 1) }
    foreach ($dir in $at) {
      if (-not [IO.Directory]::Exists($dir)) { continue }
      if ($segment.Contains('*')) {
        $found = if ($last) { [IO.Directory]::GetFiles($dir, $segment) } else { [IO.Directory]::GetDirectories($dir, $segment) }
        foreach ($x in @($found | Sort-Object)) { if (-not (Test-EntryFailureSecretSegment ([IO.Path]::GetFileName($x)))) { $next += $x } }
      } else {
        $x = Join-Path $dir $segment
        if ($(if ($last) { [IO.File]::Exists($x) } else { [IO.Directory]::Exists($x) })) { $next += $x }
      }
    }
    $at = @($next | Select-Object -First $script:EntryFailureMatchMax)
    if (-not $at.Count) { break }
  }
  return , @($at | Where-Object { $_ -match '\.json$' })
}

# What a directory holds, by name only: files and directories, sorted, at most $script:EntryFailureSiblingMax names of
# $script:EntryFailureSiblingChars characters; a secrets or credentials name is passed over. A directory that is not there holds nothing.
function Get-EntryFailureSiblings([string]$Dir) {
  if (-not $Dir -or -not [IO.Directory]::Exists($Dir)) { return , @() }
  $names = New-Object Collections.Generic.List[string]
  foreach ($x in [IO.Directory]::GetFileSystemEntries($Dir)) {
    $name = [IO.Path]::GetFileName($x)
    if (Test-EntryFailureSecretSegment $name) { continue }
    if ($name.Length -gt $script:EntryFailureSiblingChars) { $name = $name.Substring(0, $script:EntryFailureSiblingChars) }
    $names.Add($name)
  }
  $names.Sort([StringComparer]::Ordinal)
  return , @($names | Select-Object -First $script:EntryFailureSiblingMax)
}

# One file's record: its first $script:EntryFailureFileBytes bytes as UTF-8 text, read while its writer may hold it open.
function Read-EntryFailureFile([string]$File) {
  $fs = New-Object IO.FileStream -ArgumentList $File, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  try {
    $length = $fs.Length; $want = [int][Math]::Min($length, [long]$script:EntryFailureFileBytes)
    $buffer = New-Object byte[] $want; $got = 0
    while ($got -lt $want) { $n = $fs.Read($buffer, $got, $want - $got); if ($n -le 0) { break }; $got += $n }
    [ordered]@{ bytes = $length; truncated = ($length -gt $got); text = (New-Object Text.UTF8Encoding($false)).GetString($buffer, 0, $got) }
  } finally { $fs.Dispose() }
}

# The Service Control Manager's System events since $Since, newest first, at most $Max.
function Read-EntryScmEvents([DateTimeOffset]$Since, [int]$Max) {
  try { @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = $Since.LocalDateTime } -MaxEvents $Max -ErrorAction Stop) }
  catch { if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { @() } else { throw } }
}

# The generic helper's refusal events since $Since (r13 PR-2, FABLE-r13-state-acl-fix section 3): a refusal before ready leaves no receipt,
# only the SCM exit code, so the helper writes one Application event: the code, the path being opened, the stage. Its source is the
# service name (first-install-host.ps1: the runner service, this prefix and the node's name), unregistered, so the event's text is its
# insertion string, not a rendered message; it is named by its source. Newest first, at most $Max. Never throws: an Application log that
# cannot be read is one record saying so, and the SCM events are read all the same.
$script:EntryHelperEventSourcePrefix = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-'
function Read-EntryHelperEvents([DateTimeOffset]$Since, [int]$Max, [scriptblock]$Query = { param($xpath) Get-WinEvent -LogName Application -FilterXPath $xpath -ErrorAction Stop }) {
  $xpath = "*[System[TimeCreated[@SystemTime>='" + $Since.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture) + "']]]"
  try {
    @(& $Query $xpath | Where-Object { ([string]$_.ProviderName).StartsWith($script:EntryHelperEventSourcePrefix, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First $Max | ForEach-Object {
      [pscustomobject]@{ TimeCreated = $_.TimeCreated; Id = $_.Id; LevelDisplayName = $(if ([string]$_.LevelDisplayName) { [string]$_.LevelDisplayName } else { (@{ 1 = 'Critical'; 2 = 'Error'; 3 = 'Warning'; 4 = 'Information' })[[int]$_.Level] }); Message = ([string]$_.ProviderName + ': ' + (@($_.Properties | ForEach-Object { [string]$_.Value }) -join ' ')) } })
  } catch {
    if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { @() }
    else { [pscustomobject]@{ TimeCreated = [datetime]::UtcNow; Id = 0; LevelDisplayName = 'Error'; Message = ('Application log unreadable: ' + $_.Exception.Message) } }
  }
}

# The snapshot's events: the helper's first (few, and the one that names a refusal), then the SCM's, at most $Max together.
$script:EntryFailureEventReader = {
  param([DateTimeOffset]$Since, [int]$Max)
  @(@(Read-EntryHelperEvents $Since $Max) + @(Read-EntryScmEvents $Since $Max) | Select-Object -First $Max)
}

# 2026-11-24 (drill r10, companion-headless): the companion's password task stayed queued (state 2) for the whole qualification and the
# snapshot could not say why. Beside the events, the snapshot now carries what the guest itself says about that, each part on its own
# (one that cannot be read is named with its error, never taking the others with it), at most $Max items, texts of
# $script:EntryFailureEventChars characters:
#   taskSchedulerLog  whether the entry switched the Task Scheduler's Operational log on at its start (it is off on a clean Windows)
#   taskEvents        that log's events for the companion's tasks since the entry started, newest first
#   engineEvents      that log's task engine events since then, newest first: a logon that failed for a task (104), a task engine
#                     that did not start (311), started (317) or stopped idle (314). They name no task (review of 36a20badc, M1), so
#                     they are asked for by their ids, every account's, on their own 50.
#   logons            the Security log's logons (4624) and refused logons (4625) of the companion account since then, newest first
#   memory            the guest's memory now (KiB)
#   processes         the WSL, Hyper-V worker, task host (taskhostw: the task engine), supervisor and node processes now: id, parent,
#                     session, start, working set
#   wslService        the WslService service's status now
$script:EntryTaskSchedulerLogName = 'Microsoft-Windows-TaskScheduler/Operational'
$script:EntryCompanionTaskNames = @('\Clued\CluedCIResidentCompanion', '\Clued\CluedCIResidentCompanionWslImport', '\Clued\CluedCIResidentCompanionFallback', '\Clued\CluedCIResidentNotifier')
$script:EntryCompanionAccount = 'clued-companion'
$script:EntryLogonFields = @('TargetUserSid', 'TargetUserName', 'TargetLogonId', 'LogonType', 'LogonProcessName', 'AuthenticationPackageName', 'ProcessName', 'Status', 'SubStatus', 'FailureReason')
$script:EntryGuestProcessNames = @('wsl.exe', 'wslhost.exe', 'wslservice.exe', 'wslrelay.exe', 'vmmem', 'vmmemWSL', 'vmwp.exe', 'taskhostw.exe', 'CluedCompanionSupervisor.exe', 'node.exe')
$script:EntryTaskEngineEventIds = @(104, 311, 314, 317)
$script:EntryTaskLog = [ordered]@{ state = 'not-asked'; enabledBefore = $null; error = $null }

# Switches the Task Scheduler's Operational log on, before the first install (the guest only). Never throws: the outcome is recorded.
function Enable-EntryTaskSchedulerLog([scriptblock]$Config = { New-Object Diagnostics.Eventing.Reader.EventLogConfiguration $script:EntryTaskSchedulerLogName }) {
  try {
    $c = & $Config
    $before = [bool]$c.IsEnabled
    if (-not $before) { $c.IsEnabled = $true; $c.SaveChanges() }
    [ordered]@{ state = 'enabled'; enabledBefore = $before; error = $null }
  } catch { [ordered]@{ state = 'not-enabled'; enabledBefore = $null; error = (Get-EntryEventText $_.Exception.Message) } }
}
function Get-EntryEventSinceXPath([DateTimeOffset]$Since) { "TimeCreated[@SystemTime>='" + $Since.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture) + "']" }
function Get-EntryEventText($Value) { $t = ([string]$Value -replace '\s+', ' ').Trim(); if ($t.Length -gt $script:EntryFailureEventChars) { $t.Substring(0, $script:EntryFailureEventChars) } else { $t } }
function Get-EntryEventAt($Event) { try { ([DateTimeOffset]$Event.TimeCreated).ToUniversalTime().ToString('o') } catch { $null } }
# A part of the guest's account: read, or the error that kept it from being read. NoMatchingEventsFound is an empty read.
function Read-EntryGuestPart([scriptblock]$Read) {
  try { [ordered]@{ state = 'read'; error = $null; items = @(& $Read) } }
  catch {
    if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { [ordered]@{ state = 'read'; error = $null; items = @() } }
    else { [ordered]@{ state = 'unreadable'; error = (Get-EntryEventText $_.Exception.Message); items = @() } }
  }
}
function Get-EntryTaskEventsXPath([DateTimeOffset]$Since) {
  "*[System[" + (Get-EntryEventSinceXPath $Since) + "]] and *[EventData[" + ((@($script:EntryCompanionTaskNames) | ForEach-Object { "Data[@Name='TaskName']='" + $_ + "'" }) -join ' or ') + "]]"
}
# XPath: another query of the same log (the task engine's events); by default the companion's tasks'.
function Read-EntryTaskEvents([DateTimeOffset]$Since, [int]$Max, [scriptblock]$Query = { param($xpath) Get-WinEvent -LogName $script:EntryTaskSchedulerLogName -FilterXPath $xpath -ErrorAction Stop }, [string]$XPath = '') {
  $xpath = if ($XPath) { $XPath } else { Get-EntryTaskEventsXPath $Since }
  Read-EntryGuestPart { @(& $Query $xpath | Select-Object -First $Max | ForEach-Object {
    [ordered]@{ at = (Get-EntryEventAt $_); id = [int]$_.Id; activityId = $(if ($null -ne $_.ActivityId) { [string]$_.ActivityId } else { $null }); message = (Get-EntryEventText $_.Message) } }) }
}
function Get-EntryTaskEngineEventsXPath([DateTimeOffset]$Since) {
  "*[System[(" + ((@($script:EntryTaskEngineEventIds) | ForEach-Object { 'EventID=' + $_ }) -join ' or ') + ") and " + (Get-EntryEventSinceXPath $Since) + "]]"
}
function Read-EntryTaskEngineEvents([DateTimeOffset]$Since, [int]$Max, [scriptblock]$Query = { param($xpath) Get-WinEvent -LogName $script:EntryTaskSchedulerLogName -FilterXPath $xpath -ErrorAction Stop }) {
  Read-EntryTaskEvents $Since $Max $Query (Get-EntryTaskEngineEventsXPath $Since)
}
function Get-EntryLogonEventsXPath([DateTimeOffset]$Since) {
  "*[System[(EventID=4624 or EventID=4625) and " + (Get-EntryEventSinceXPath $Since) + "]] and *[EventData[Data[@Name='TargetUserName']='" + $script:EntryCompanionAccount + "']]"
}
# The named fields of one logon event (its EventData, by name), nothing else of it.
function ConvertFrom-EntryLogonEvent($Event) {
  $x = [xml]$Event.ToXml()
  $item = [ordered]@{ at = (Get-EntryEventAt $Event); id = [int]$Event.Id }
  foreach ($d in @($x.GetElementsByTagName('Data'))) {
    $name = [string]$d.GetAttribute('Name')
    if (@($script:EntryLogonFields) -ccontains $name) { $item[$name] = Get-EntryEventText $d.InnerText }
  }
  $item
}
function Read-EntryLogonEvents([DateTimeOffset]$Since, [int]$Max, [scriptblock]$Query = { param($xpath) Get-WinEvent -LogName Security -FilterXPath $xpath -ErrorAction Stop }) {
  $xpath = Get-EntryLogonEventsXPath $Since
  Read-EntryGuestPart { @(& $Query $xpath | Select-Object -First $Max | ForEach-Object { ConvertFrom-EntryLogonEvent $_ }) }
}
function Read-EntryGuestMemory([scriptblock]$Query = { Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop }) {
  try {
    $os = & $Query
    [ordered]@{ state = 'read'; error = $null; totalVisibleKb = [int64]$os.TotalVisibleMemorySize; freePhysicalKb = [int64]$os.FreePhysicalMemory; totalVirtualKb = [int64]$os.TotalVirtualMemorySize; freeVirtualKb = [int64]$os.FreeVirtualMemory }
  } catch { [ordered]@{ state = 'unreadable'; error = (Get-EntryEventText $_.Exception.Message) } }
}
function Get-EntryGuestProcessFilter { (@($script:EntryGuestProcessNames) | ForEach-Object { "Name='" + $_ + "'" }) -join ' OR ' }
function Read-EntryGuestProcesses([int]$Max, [scriptblock]$Query = { param($filter) Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction Stop }) {
  $filter = Get-EntryGuestProcessFilter
  Read-EntryGuestPart { @(& $Query $filter | Sort-Object { [string]$_.Name }, { [int]$_.ProcessId } | Select-Object -First $Max | ForEach-Object {
    [ordered]@{ name = [string]$_.Name; pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; sessionId = [int]$_.SessionId
      created = $(try { ([DateTimeOffset][DateTime]$_.CreationDate).ToUniversalTime().ToString('o') } catch { $null }); workingSetKb = [int64]([int64]$_.WorkingSetSize / 1024) } }) }
}
function Read-EntryWslService([scriptblock]$Query = { Get-Service -Name WslService -ErrorAction Stop }) {
  try { $s = & $Query; [ordered]@{ state = 'read'; error = $null; status = [string]$s.Status; startType = [string]$s.StartType } }
  catch { [ordered]@{ state = 'unreadable'; error = (Get-EntryEventText $_.Exception.Message) } }
}
$script:EntryFailureGuestReader = {
  param([DateTimeOffset]$Since, [int]$Max)
  [ordered]@{ taskSchedulerLog = $script:EntryTaskLog; taskEvents = (Read-EntryTaskEvents $Since $Max); engineEvents = (Read-EntryTaskEngineEvents $Since $Max)
    logons = (Read-EntryLogonEvents $Since $Max)
    memory = (Read-EntryGuestMemory); processes = (Read-EntryGuestProcesses $Max); wslService = (Read-EntryWslService) }
}

# Writes the snapshot and returns it. Never throws and never changes the entry's result: what could not be read is named in its place.
function Write-EntryFailureSnapshot([string]$Output, [string]$ListFile, [hashtable]$Roots, [DateTimeOffset]$Since, $Result, [scriptblock]$EventReader = $script:EntryFailureEventReader, [scriptblock]$GuestReader = $script:EntryFailureGuestReader) {
  $utf8 = New-Object Text.UTF8Encoding($false)
  $cost = { param($v) $utf8.GetByteCount((ConvertTo-Json -InputObject $v -Compress -Depth 6)) }
  $snapshot = [ordered]@{ contract = $script:EntryFailureSnapshotContract; at = [DateTimeOffset]::UtcNow.ToString('o'); since = $Since.ToString('o')
    entry = [ordered]@{ status = (Get-EntryProperty $Result 'status'); stopCode = (Get-EntryProperty $Result 'stopCode') }
    limits = [ordered]@{ fileBytes = [int]$script:EntryFailureFileBytes; totalBytes = [int]$script:EntryFailureTotalBytes; events = $script:EntryFailureEventMax; eventChars = $script:EntryFailureEventChars }
    list = [ordered]@{ state = 'read'; code = $null }; files = @(); events = [ordered]@{ state = 'not-read'; error = $null; items = @() }
    guest = [ordered]@{ state = 'not-read'; error = $null } }
  try {
    $left = [long]$script:EntryFailureTotalBytes - 4KB   # the frame around the records
    $records = New-Object Collections.ArrayList
    # the events first: they are small and bounded, and no file can take their room
    try {
      $items = @()
      foreach ($e in @(& $EventReader $Since $script:EntryFailureEventMax | Select-Object -First $script:EntryFailureEventMax)) {
        $message = ([string]$e.Message -replace '\s+', ' ').Trim()
        if ($message.Length -gt $script:EntryFailureEventChars) { $message = $message.Substring(0, $script:EntryFailureEventChars) }
        $items += , ([ordered]@{ at = $(try { ([DateTimeOffset]$e.TimeCreated).ToUniversalTime().ToString('o') } catch { $null }); id = $e.Id; level = [string]$e.LevelDisplayName; message = $message })
      }
      $snapshot.events = [ordered]@{ state = 'read'; error = $null; items = $items }
    } catch { $snapshot.events = [ordered]@{ state = 'unreadable'; error = [string]$_.Exception.Message; items = @() } }
    $left -= (& $cost $snapshot.events)
    # then the guest's own account (bounded the same way), before any file
    try { $snapshot.guest = & $GuestReader $Since $script:EntryFailureEventMax } catch { $snapshot.guest = [ordered]@{ state = 'unreadable'; error = [string]$_.Exception.Message } }
    $left -= (& $cost $snapshot.guest)
    $list = @()
    try { $list = Read-EntryFailureFiles $ListFile } catch { $snapshot.list = [ordered]@{ state = 'refused'; code = [string]$_.Exception.Message } }
    foreach ($entry in @($list)) {
      $root = $Roots[$entry.root]
      if (-not $root) { [void]$records.Add([ordered]@{ root = $entry.root; pattern = $entry.path; state = 'root-unknown' }); continue }
      $found = @(); $trace = @{}
      try { $found = Resolve-EntryFailurePath $root $entry.path $trace }
      catch { [void]$records.Add([ordered]@{ root = $entry.root; pattern = $entry.path; state = 'unreadable'; error = [string]$_.Exception.Message }); continue }
      if (-not $found.Count) {
        # absent: where the walk stopped and what is there instead, so a path of the list that is wrong can be put right from one run
        # (FABLE-r9-lineB-points R3); a directory that cannot be listed leaves the record without the two
        $record = [ordered]@{ root = $entry.root; pattern = $entry.path; state = 'absent' }
        try {
          $siblings = Get-EntryFailureSiblings $trace['dir']
          $with = [ordered]@{ root = $entry.root; pattern = $entry.path; state = 'absent'; stoppedAt = [string]$trace['stoppedAt']; siblings = @($siblings) }
          $size = & $cost $with
          if ($size -le $left) { $record = $with; $left -= $size }
        } catch { }
        [void]$records.Add($record); continue
      }
      foreach ($file in $found) {
        $record = [ordered]@{ root = $entry.root; pattern = $entry.path; path = $file; state = 'read'; bytes = $null; truncated = $null; text = $null }
        try { $read = Read-EntryFailureFile $file; $record.bytes = $read.bytes; $record.truncated = $read.truncated; $record.text = $read.text }
        catch { $record.state = 'unreadable'; $record['error'] = [string]$_.Exception.Message }
        $size = & $cost $record
        if ($size -gt $left) { $record.state = 'over-total-limit'; $record.text = $null; $size = & $cost $record }
        $left -= $size
        [void]$records.Add($record)
      }
    }
    $snapshot.files = @($records)
  } catch { $snapshot['error'] = [string]$_.Exception.Message }
  try { [IO.File]::WriteAllText((Join-Path $Output 'resident-failure-snapshot.json'), (ConvertTo-Json -InputObject $snapshot -Compress -Depth 6), $utf8) } catch { }
  return $snapshot
}

# The one loader of the release's bootstrap: dot-source it (helpers only: its main runs only when it is not dot-sourced), then the entry's
# own Stop-Bootstrap over the package's. Called dot-sourced (". Import-EntryBootstrap"), so everything lands in the caller's scope; a
# test loads the repository's real bootstrap.ps1 through it (test/drill-r4-defects.test.mjs).
function Import-EntryBootstrap([string]$Assets, [string]$ReleaseVersion) {
  $bootstrap = Join-Path $Assets "fleet-node-$ReleaseVersion.bootstrap.ps1"
  . $bootstrap -From $Assets
  # Helpers normally terminate the bootstrap process. Here the entry owns the single terminal result and cleanup.
  function Stop-Bootstrap([string]$step, [string]$code, $detail) { throw ($code + $(if ($null -ne $detail) { ':' + (@($detail) -join ',') } else { '' })) }
}

# This is the README section 5 exception for CLUED-DRILL only. No accepted file is rewritten.
# Load the accepted bootstrap's helpers, keeping its asset/prerequisite/check/prepare/launcher order.
function Invoke-FirstInstallAccepted([string]$Assets, [string]$Payload, [string]$FakeInputs, [string]$Output, [string]$ReleaseVersion) {
  . Import-EntryBootstrap $Assets $ReleaseVersion
  # No package function is shadowed here: the package's own Expand-Cached runs (#1154 fixed its MAX_PATH defect; the drill-only stand-in
  # that kept covering it was removed, Fable renew-key ruling, supplement "companion account and evidence" section 3).
  $script:From = $Assets
  $measurements = New-EntryMeasurements; $phase = New-EntryPhaseClock
  $inputCredentials = Join-Path $Output 'credentials'
  $entryTree = ''; $entryNode = ''; $hostStage = $null
  $script:EntryStageOutput = $Output; $script:EntryStageOpen = $null; $script:EntryStepOpen = $null
  try {
    # Each stage is ended by the next one's start, after its own verdict; a stop ends the open one failed with its code (catch below).
    Start-EntryStage 'assets'
    if ([IO.File]::Exists($ReceiptFile)) { throw 'DRILL_ENTRY_REQUIRES_FIRST_INSTALL' }
    Enter-EntryPhase $measurements $phase 'assets'
    $prefix = 'fleet-node-' + $ReleaseVersion
    $present = @(Get-ChildItem -LiteralPath $Assets -File -Force | ForEach-Object { $_.Name })
    if ((Get-ReleaseVersion $present) -cne $ReleaseVersion) { throw 'DRILL_RELEASE_VERSION_MISMATCH' }
    $sums = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $Assets 'SHA256SUMS')))
    $firstSums = Read-Sha256Sums ([IO.File]::ReadAllText((Join-Path $Assets "$prefix.first-install.SHA256SUMS")))
    $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = 16777216
    $manifestFile = Join-Path $Assets "$prefix.prereq-manifest.json"
    $manifest = $js.DeserializeObject([IO.File]::ReadAllText($manifestFile))
    $drillPrereqFileNames = @(@($manifest['items']) + @($manifest['debs']) | ForEach-Object { [string]$_['fileName'] })
    $ac = Test-AssetSet $present $sums $firstSums $ReleaseVersion $true $drillPrereqFileNames; $ac = @($ac | ForEach-Object { $_ }); if ($ac.Count) { throw ('ASSET_SET_REFUSED:' + ($ac -join ',')) }
    foreach ($set in @($sums, $firstSums)) {
      foreach ($name in @($set.Keys)) { if ((Sha256File (Join-Path $Assets $name)) -cne $set[$name]) { throw 'ASSET_HASH_MISMATCH' } }
    }
    $pc = Test-PrereqManifest $manifest (Get-NeededPrereqs $true) $true; $pc = @($pc | ForEach-Object { $_ }); if ($pc.Count) { throw ('PREREQ_MANIFEST_REFUSED:' + ($pc -join ',')) }
    Enter-EntryPhase $measurements $phase 'prereq'
    Start-EntryStage 'prereq'
    $script:Work = Join-Path $WorkParent ([guid]::NewGuid().ToString('N'))
    $script:EntryFailureRoots.work = $script:Work
    [void][IO.Directory]::CreateDirectory($script:Work)
    $pre = Join-Path $script:Work 'prereq'; [void][IO.Directory]::CreateDirectory($pre)
    $tools = @{}
    foreach ($item in $manifest['items']) {
      # Prefer the injected, release-pinned WSL/rootfs. Get-Prereq still verifies size and sha256.
      $injected = Join-Path $Payload $item['fileName']
      $itemName = [string]$item['name']
      # a download (not injected, and not one that must be): its own step
      if (-not [IO.File]::Exists($injected) -and @('gh', 'git-for-windows') -cnotcontains $itemName) { Start-EntryStep $itemName 'get' $item['bytes'] }
      if ([IO.File]::Exists($injected)) {
        Start-EntryStep $itemName 'sha' $item['bytes']
        if ((Sha256File $injected) -cne $item['sha256'] -or (Get-Item -LiteralPath $injected).Length -ne $item['bytes']) { throw 'DRILL_PREREQ_CHANGED' }
        Start-EntryStep $itemName 'copy' $item['bytes']
        $file = Join-Path $pre $item['fileName']; [IO.File]::Copy($injected, $file, $false)
      } elseif (@('gh', 'git-for-windows') -ccontains [string]$item['name']) { throw ('DRILL_PREREQ_NOT_INJECTED:' + $item['name']) }
      else { $file = Get-Prereq $item $pre }
      # the package's own Expand-Cached, called as its bootstrap calls it (rollout/fleet/bootstrap.ps1): the zip's longest entry path from the
      # pinned manifest is its fourth argument, without which it refuses (PREREQ_ZIP_MAX_ENTRY_PATH_LENGTH)
      if (@('node', 'python', 'git') -ccontains $itemName) {
        Start-EntryStep $itemName 'expand' $item['bytes']
        $tools[$item['name']] = Expand-Cached $file $itemName ([string]$item['sha256']) (Get-Key $item 'maxEntryPathLength')
      }
      Stop-EntryStep 'ok'
    }
    $debDir = Join-Path $pre 'debs'; [void][IO.Directory]::CreateDirectory($debDir)
    foreach ($item in $manifest['debs']) {
      $file = Join-Path $Payload $item['fileName']
      Start-EntryStep ([string]$item['fileName']) 'sha' $item['bytes']
      if ((Sha256File $file) -cne $item['sha256'] -or (Get-Item -LiteralPath $file).Length -ne $item['bytes']) { throw 'DRILL_PREREQ_CHANGED' }
      Start-EntryStep ([string]$item['fileName']) 'copy' $item['bytes']
      [IO.File]::Copy($file, (Join-Path $debDir $item['fileName']), $false)
      Stop-EntryStep 'ok'
    }
    Start-EntryStep 'tools' 'find'
    $nodeFiles = @(Get-ChildItem -LiteralPath $tools['node'] -Recurse -Filter node.exe)
    $pyFiles = @(Get-ChildItem -LiteralPath $tools['python'] -Recurse -Filter python.exe)
    $gitFiles = @(Get-ChildItem -LiteralPath $tools['git'] -Recurse -Filter git.exe | Where-Object { $_.Directory.Name -ceq 'cmd' })
    if ($nodeFiles.Count -ne 1 -or $pyFiles.Count -ne 1 -or $gitFiles.Count -ne 1) { throw 'PREREQ_TOOL_NOT_ONE' }
    Stop-EntryStep 'ok'
    $entryNode = $nodeFiles[0].FullName
    $childEnv = @{ PATH = $pyFiles[0].DirectoryName + ';' + $gitFiles[0].DirectoryName + ';' + $nodeFiles[0].DirectoryName + ';C:\Windows\System32;C:\Windows'; PSModulePath = $env:PSModulePath }
    Enter-EntryPhase $measurements $phase 'unpack'
    Start-EntryStage 'unpack'
    $archive = Join-Path $Assets "$prefix.tar"; $archiveHash = $sums["$prefix.tar"]
    $unpack = Join-Path $script:Work 'x'; [void][IO.Directory]::CreateDirectory($unpack)
    & $TarExe -x -f $archive -C $unpack 'tree' 'universal-manifest.json' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'ARCHIVE_EXTRACT_FAILED' }
    $entryTree = Join-Path $unpack 'tree'
    $fleet = Join-Path $entryTree 'work\independent-ci-resident-v1\rollout\fleet'
    $install = Join-Path $fleet 'install.mjs'; $acceptance = Join-Path $Assets "$prefix.acceptance.json"
    Enter-EntryPhase $measurements $phase 'check'
    Start-EntryStage 'check'
    $check = Invoke-NonElevated $entryNode @($install, 'first-install-check', '--artifact', $archive, '--artifact-sha', $archiveHash, '--acceptance', $acceptance, '--from', $Assets) $childEnv
    Enter-EntryPhase $measurements $phase ''
    $pins = $check.last
    if ($check.exit -ne 0 -or (Test-FirstInstallCheck $pins $archiveHash $firstSums["$prefix.first-install-kit.json"] (Sha256File $entryNode)).Count) { throw 'FIRST_INSTALL_INPUTS_NOT_ACCEPTED' }
    # the host stage's inputs (local copies, the credential directory, the host's own extraction of the accepted archive): a stage of its
    # own, ended by the host stage's start after its last verdict, so a stop here is on it and a run cut off here says so
    Start-EntryStage 'host-inputs'
    # Same local-copy boundary as bootstrap; host gets the accepted archive tree, never a repository tree.
    $hostDir = Join-Path $script:Work 'host-inputs'
    $localArchive = Copy-ToWork $archive $hostDir $archiveHash
    $localManifest = Copy-ToWork $manifestFile $hostDir $sums["$prefix.prereq-manifest.json"]
    foreach ($p in @($localArchive, $pre, $localManifest)) { if (-not (Test-UnderDirectory $p $script:Work)) { throw 'ELEVATED_INPUT_NOT_LOCAL' } }
    $swept = Clear-CredentialDirectory $CredentialDirectory
    if (-not $swept.cleared) { throw 'DRILL_CREDENTIAL_CLEANUP_FAILED' }
    $ds = New-Object Security.AccessControl.DirectorySecurity
    $credentialSddl = 'O:BAG:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
    $ds.SetSecurityDescriptorSddlForm($credentialSddl)
    $hostStage = Join-Path 'C:\Windows\Temp' ('clued-drill-host-' + [guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($hostStage, $ds)
    $hostArchive = Copy-ToWork $localArchive $hostStage $archiveHash
    Enter-EntryPhase $measurements $phase 'unpack'
    & $TarExe -x -f $hostArchive -C $hostStage 'tree' | Out-Null
    $hostTarExit = $LASTEXITCODE
    Enter-EntryPhase $measurements $phase ''
    if ($hostTarExit -ne 0) { throw 'ARCHIVE_EXTRACT_FAILED' }
    $hostTree = Join-Path $hostStage 'tree'
    if ([IO.Directory]::Exists($inputCredentials)) { throw 'DRILL_CREDENTIAL_INPUT_ALREADY_EXISTS' }
    [void][IO.Directory]::CreateDirectory($inputCredentials, $ds)
    # Compare as the host preparation does (first-install-host.ps1 Test-SddlIs): owner, protected DACL and the same ACE set; the
    # text form Windows returns is normalized and may differ from the string that set it.
    $actualSddl = [IO.Directory]::GetAccessControl($inputCredentials).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')
    $sameAcl = $false
    try {
      $a = New-Object Security.AccessControl.RawSecurityDescriptor($actualSddl); $w = New-Object Security.AccessControl.RawSecurityDescriptor($credentialSddl)
      $key = { param($ace) ([string]$ace.AceQualifier) + '|' + $ace.SecurityIdentifier.Value + '|' + $ace.AccessMask + '|' + ([int]$ace.AceFlags -band 0x0F) }
      $ak = @(foreach ($x in $a.DiscretionaryAcl) { & $key $x }) | Sort-Object; $wk = @(foreach ($x in $w.DiscretionaryAcl) { & $key $x }) | Sort-Object
      $sameAcl = ($a.Owner.Value -ceq $w.Owner.Value) -and (($a.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) -and ((@($ak) -join ';') -ceq (@($wk) -join ';'))
    } catch { $sameAcl = $false }
    if (-not $sameAcl) { throw ('DRILL_CREDENTIAL_INPUT_ACL_REFUSED:' + $actualSddl) }
    # companion-github.token: the stand-in for the companion GitHub classic token (drill-vm.ps1 New-DrillFakeCredentials), made only when the
    # drilled package requires it (Get-DrillCredentialPlan); handed over under the package's name.
    foreach ($pair in @(@('app-key.pem', 'app-private-key.pem'), @('ci-admission.token', 'ci-admission.token'), @('resident-upgrade.token', 'resident-upgrade.token'),
        @('companion-github.token', 'companion-github.token'))) {
      # only what the drill made for this package (drill-vm.ps1 Get-DrillCredentialPlan): a name it withholds has no file to hand over
      $source = Join-Path $FakeInputs $pair[0]
      if ([IO.File]::Exists($source)) { [IO.File]::Copy($source, (Join-Path $inputCredentials $pair[1]), $false) }
    }
    if ([IO.File]::Exists((Join-Path $FakeInputs 'public.json'))) {
      $public = ConvertTo-FirstInstallPublic (Get-Content -LiteralPath (Join-Path $FakeInputs 'public.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
      [IO.File]::WriteAllText((Join-Path $inputCredentials 'public.json'), ($public | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    }
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hostScript = Join-Path $hostTree 'work\independent-ci-resident-v1\windows\first-install-host.ps1'
    # A host preparation that takes -Kit (package 0a4abc6f2 on: it reads the companion's gh path from it) gets the Release's first-install
    # kit, copied locally and held to its pinned hash like the archive; an older one is called as before (Codex review of c1497e0a1, high 3).
    $kitArgs = @()
    if (Test-EntryHostTakesKit $hostScript) {
      $localKit = Copy-ToWork (Join-Path $Assets "$prefix.first-install-kit.json") $hostDir $firstSums["$prefix.first-install-kit.json"]
      if (-not (Test-UnderDirectory $localKit $script:Work)) { throw 'ELEVATED_INPUT_NOT_LOCAL' }
      $kitArgs = @('-Kit', $localKit)
    }
    if (Test-EntryHostTakesStepProgress $hostScript) { $kitArgs += @('-StepProgress', (Join-Path $Output 'stage-progress.jsonl')) }
    Start-EntryStage 'host' (Join-Path $Output 'host.stdout.log')
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
      # its stdout line by line into host.stdout.log: the step record (drill-vm.ps1 Read-DrillFirstInstallSteps reads steps from the
      # complete stdout logs only; host-result.json below keeps only the tail and is read for its verdict line)
      $hostRun = Invoke-EntryStreamedChild $PowerShellExe (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $hostScript, '-Tree', $hostTree,
        '-PrereqDirectory', $pre, '-PrereqManifest', $localManifest, '-PrereqManifestSha256', $sums["$prefix.prereq-manifest.json"],
        '-KitSha256', $pins['kitSha256'], '-ToolchainNodeSha256', $pins['toolchainNodeSha256'], '-RegistrarSha256', $pins['registrarSha256'],
        '-ExpectedOperatorSid', $operatorSid, '-CredentialDirectory', $inputCredentials) + $kitArgs) $HostLimitSeconds (Join-Path $Output 'host.stdout.log')
    } finally { $measurements.host = $watch.Elapsed.TotalSeconds }
    [IO.File]::WriteAllText((Join-Path $Output 'host-result.json'), (ConvertTo-JsonLine ([ordered]@{ exit = $hostRun.exit; terminal = $hostRun.last; stdoutTail = $(if ($hostRun.stdout) { $t = [string]$hostRun.stdout; $t.Substring([Math]::Max(0, $t.Length - 6000)) } else { $null }); stderrTail = $(if ($hostRun.stderr) { $t = [string]$hostRun.stderr; $t.Substring([Math]::Max(0, $t.Length - 3000)) } else { $null }) })), (New-Object Text.UTF8Encoding($false)))
    $hostStop = Get-EntryHostStopCode $hostRun
    if ($hostStop) { throw $hostStop }
    Start-EntryStage 'prepare' (Join-Path $Output 'prepare.stdout.log')
    $watch.Restart()
    try { $prepared = Invoke-EntryStreamedChild $entryNode @($install, 'prepare', '--artifact', $archive, '--artifact-sha', $archiveHash, '--acceptance', $acceptance, '--work', (Join-Path $script:Work 'prepare'), '--from', $Assets) 0 (Join-Path $Output 'prepare.stdout.log') $childEnv -NoWindow }
    finally { $measurements.prepare = $watch.Elapsed.TotalSeconds }
    $drillLauncher = Get-Key $prepared.last 'launcher'
    if ($prepared.exit -ne 0 -or @('FLEET_NODE_INSTALL_PREPARED', 'FLEET_NODE_FIRST_INSTALL_PREPARED') -cnotcontains [string](Get-Key $prepared.last 'status') -or
        -not (Test-SafePath ([string](Get-Key $drillLauncher 'path'))) -or [string](Get-Key $drillLauncher 'sha256') -cnotmatch '^[0-9a-f]{64}$') { throw 'PREPARE_REFUSED' }
    # the launcher stage meets a cold WSL, every run (Fable ruling 0e418483 4.2)
    Start-EntryStage 'wsl-cold-start'
    Invoke-EntryWslColdStart $Output $script:Work
    # The launcher stage's output file (bootstrap.ps1 -Stage launcher -Result) is its whole printed output, and here it is launcher.stdout.log
    # itself: whatever it holds when the stage ends or is cut off is what the drill reads (Fable renew-key ruling, supplement "branch two,
    # two points" 1; the package will write it line by line).
    $launcherResult = Join-Path $Output 'launcher.stdout.log'
    # this run's file only (Codex review of c1497e0a1, medium 2): an earlier run's output is cleared before the stage and must be gone
    Start-EntryStage 'launcher' $launcherResult
    Clear-EntryStageOutput $launcherResult
    $watch.Restart()
    try { $launch = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Stage', 'launcher', '-Result', $launcherResult,
      '-Launcher', $drillLauncher['path'], '-LauncherSha256', $drillLauncher['sha256'], '-ExpectedOperatorSid', $operatorSid) $LauncherLimitSeconds }
    finally { $measurements.launcher = $watch.Elapsed.TotalSeconds }
    # no output file, or one whose last object is not a verdict (a stage cut off): the stage gave no verdict
    $terminal = if ([IO.File]::Exists($launcherResult)) { Get-LastJsonLine (Read-EntrySharedText $launcherResult) } else { $null }
    $stageGaveNoVerdict = -not (Test-EntryStageVerdict $terminal)
    if ($stageGaveNoVerdict) { $terminal = $null }
    [IO.File]::WriteAllText((Join-Path $Output 'launcher-result.json'), (ConvertTo-JsonLine ([ordered]@{ source = $launcherResult; exit = $launch.exit; terminal = $terminal; stageGaveNoVerdict = $stageGaveNoVerdict })), (New-Object Text.UTF8Encoding($false)))
    $verdict = Get-LauncherVerdict $true $terminal
    $launchExit = $(if ($launch.timedOut -or $null -eq $launch.exit) { 1 } else { [int]$launch.exit })
    $ended = ConvertTo-FirstInstallEntryResult $verdict $launchExit $entryTree $entryNode
    Stop-EntryStage $(if ($ended.status -ceq 'FIRST_INSTALL_DONE') { 'ok' } else { 'failed' }) ([string]$ended.stopCode)
    return (ConvertTo-FirstInstallEntryResult $verdict $launchExit $entryTree $entryNode)
  } catch {
    Stop-EntryStage 'failed' ([string]$_.Exception.Message)   # the stage it stopped in, with the code it stopped on
    throw
  } finally {
    Enter-EntryPhase $measurements $phase ''   # a phase a stop cut off keeps the time it ran
    Write-EntryStageTimings $Output $measurements
    # Both the injected input and the host's transient token directory die on every end.
    foreach ($directory in @($inputCredentials, $CredentialDirectory)) {
      if (-not (Clear-CredentialDirectory $directory).cleared) { throw 'DRILL_CREDENTIAL_CLEANUP_FAILED' }
    }
    if ($hostStage) {
      $resolved = [IO.Path]::GetFullPath($hostStage)
      if (-not $resolved.StartsWith('C:\Windows\Temp\clued-drill-host-', [StringComparison]::OrdinalIgnoreCase)) { throw 'DRILL_HOST_STAGE_PATH_REFUSED' }
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
  }
}

# The entry's result. Anything but FIRST_INSTALL_DONE on the drill guest also leaves the failure snapshot (never on another machine: a
# refusal before the guest is known reads nothing).
function Get-FirstInstallEntryResult {
  $tree = ''; $node = ''; $result = $null; $guest = $false
  $output = $Work; $kitDirectory = $Kit   # $Work is the bootstrap's own work directory once its helpers are loaded
  $since = [DateTimeOffset]::UtcNow
  try {
    Assert-FirstInstallGuest
    $guest = $true
    # the Task Scheduler's own account of the companion's tasks, for the failure snapshot (off on a clean Windows; drill r10)
    $script:EntryTaskLog = Enable-EntryTaskSchedulerLog
    Assert-FirstInstallRelease
    [void](Set-EntryServerBlackhole)
    $result = Invoke-FirstInstallAccepted $From $Kit $Fake $Work $Version
  } catch {
    $code = [string]$_.Exception.Message
    # A code may carry its detail after ':' (the accepted helpers' codes); anything else is an exception whose text is kept, cut short.
    if ($code -cnotmatch '^[A-Z][A-Z0-9_]+(:.*)?$') {
      $text = ($code -replace '\s+', ' ').Trim(); if ($text.Length -gt 400) { $text = $text.Substring(0, 400) }
      $code = 'DRILL_FIRST_INSTALL_ENTRY_EXCEPTION:' + $text + ' @' + [string]$_.InvocationInfo.ScriptLineNumber
    }
    $result = [ordered]@{ status = 'FIRST_INSTALL_STOPPED'; stopCode = $code; tree = $tree; node = $node }
  }
  if ($guest -and [string](Get-EntryProperty $result 'status') -cne 'FIRST_INSTALL_DONE') {
    try { [void](Write-EntryFailureSnapshot $output (Join-Path $kitDirectory 'guest-failure-files.json') $script:EntryFailureRoots $since $result) } catch { }
  }
  return $result
}

function Invoke-FirstInstallEntry {
  $result = Get-FirstInstallEntryResult
  $result | ConvertTo-Json -Depth 8 -Compress
  if ($result.stopCode) { exit 1 }
}
if ($MyInvocation.InvocationName -ne '.') {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  Invoke-FirstInstallEntry
}
