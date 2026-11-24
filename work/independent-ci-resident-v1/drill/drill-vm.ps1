# drill-vm.ps1 -- the new-node first-install drill machine: one Hyper-V VM on this host (plan PLAN-drill-vm-20261116, phase A).
#
#   pwsh -NoProfile -File drill-vm.ps1 -BaselineOnly
#   pwsh -NoProfile -File drill-vm.ps1 -PrereqOnly      (baseline copy + the pinned prerequisites from D:\clued-drill\prereq, then restored)
#   pwsh -NoProfile -File drill-vm.ps1 -Version <v> -From <dir with tar/acceptance/SHA256SUMS> -Kit <first-install kit dir> [-SkipReinstall] [-RunTimeoutMinutes 70 | -Ladder]
#     (a candidate: -From without an acceptance; the kit carries a drill-only one, see Test-DrillPackageDir and FIRST-INSTALL-KIT.md)
#   pwsh -NoProfile -File drill-vm.ps1 -Finalize <receipt.json> -ProductionReadback <readback.json>
#   pwsh -NoProfile -File drill-vm.ps1 -ServerKey <key>     (DESK stores the test project's public key on the host once the project answers it)
#   pwsh -NoProfile -File drill-vm.ps1 -BindingCredential   (the Owner hands over the drill binding once, in the Windows credential dialog)
#   pwsh -NoProfile -File drill-vm.ps1 -ServerDatabaseCredential   (the Owner hands over the test project's database password once, the same way)
#   pwsh -NoProfile -File drill-vm.ps1 -SyncServer [-Rebuild] -From <Release dir> -Version <v>   (the test project brought to production's
#     applied list on its own, as before every drill; -Rebuild: from empty, the first time and after DRILL_SERVER_DIVERGED only)
#
# Inputs on the host: D:\clued-drill\iso (the Windows 11 ISO and expected-sha256.txt), D:\clued-drill\prereq\prereq.json (the
# pinned WSL package, Ubuntu image and docker .debs, see Read-DrillPrereq), and the kit's kit.json:
#   { contract: clued.drill.first-install-kit/1, files: [{path, sha256}], entry: {file: <.ps1>, arguments: [-Name | {from} {kit}
#     {fake} {work} {version}]}, timeoutMinutes: 5..240, perNodeSteps: [..], prereqSha256: <sha256 of prereq.json> }
# The entry's last stdout line is { status, stopCode, tree, node } (tree: the unpacked package; node: a node.exe to run it).
# No node parameter. Every state is read from the scene (does the VM exist, is the checkpoint there); there is no state file.
# Prints one JSON line: { status, code, receipt, ... }.
#
# The drill machine is NOT a node to the service: it holds no production credential and never reaches production. Its kit names the
# drill's server (the test project, drill/drill-server.json) in place of production in the first-install kit's two public fields, and
# its entry cuts the production host off in the guest (FABLE-drill-role-probe-20261124.md, PR-3). The upgrade token and App key are made
# inside the VM at every drill and die with the checkpoint restore; the CI token is the Owner's drill binding in the test project, one
# with no ci-admission role, kept beside the guest credential (Get-DrillCredential -Binding) and handed to the guest for the run only.
# The machine is never registered, has no heartbeat link and is never in the failover list. Its role probe is answered "holds no role":
# it rests STANDBY, which starts nothing, and its first train is not applicable (A6).
#
# Host boundary: writes only under D:\clued-drill\; touches only the VM whose name AND notes are ours; never touches the
# host services, scheduled tasks, switches, or any process by name. Read the public host status and installed generation pointer.
# In the WSL distribution this host's Linux Actions runners live in (scripts/ci/self-hosted/node-profiles.json), and only while it is
# already running: a read-only process listing and memory reading, and a release of its file cache -- before a boot only while idle (no
# job on either side), and from the running guard while the drill VM is on and the host is below 10 GB free, a job there or not
# (Decision f572ac5b; its "the earlier permission while idle stands" is 21db5a9c's; Get-DrillWslRunnerState, Get-DrillWslMemory,
# Invoke-DrillWslCacheRelease). No other WSL distribution is touched. The installed Owner request CLI is the sole production request path. No elevation: the account
# must be in Hyper-V Administrators. Every wait is bounded; nothing is retried; a failed drill still restores the checkpoint.
# Host duty, CI activity and memory are checked before start and independently every 30 seconds while running.
[CmdletBinding()]
param(
  [string]$Version,
  [string]$From,
  [string]$Kit,
  [switch]$BaselineOnly,
  [switch]$PrereqOnly,
  [switch]$SkipReinstall,
  [switch]$Interactive,
  [ValidateRange(5, 240)][int]$InteractiveTimeoutMinutes = 120,
  [ValidateRange(5, 240)][int]$RunTimeoutMinutes = 70,
  [switch]$Ladder,
  [string]$Finalize,
  [string]$ProductionReadback,
  [switch]$BindingCredential,
  [string]$BindingConnection,   # with -BindingCredential: the connection id, filled in so only the token is pasted
  [string]$ServerKey,
  [switch]$ServerDatabaseCredential,
  [switch]$SyncServer,
  [switch]$Rebuild
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$script:DrillScriptPath = $PSCommandPath
$script:HostGuard = $null
# ladder mode derives the limit only when none was given (Get-DrillLadderStep); the step it took goes into the receipt
$script:DrillRunTimeoutGiven = $PSBoundParameters.ContainsKey('RunTimeoutMinutes')
$script:DrillLadder = $null
# The cache release: two fixed commands, run by sh in the runner distribution as root, through the one function
# (Invoke-DrillWslCacheRelease). Each a single-quoted string with no double quote or backslash: PowerShell puts nothing into it and the
# Windows command line passes it whole (Assert-DrillWslReleaseCommandLiteral, which also holds the idle one to be the running one behind
# the job question). Nothing is read from their output.
# - The running guard's (Decision f572ac5b; Fable ruling 0e418483 "drill memory root" 2.3): the drill VM on and the host below 10 GB
#   free, a job there or not, so no job question: sync first (dirty pages written), then the page cache only (1, not dentries and inodes):
#   exit 5 the sync or the release failed, 0 released.
# - Before a boot, only while idle (Decision 21db5a9c, which f572ac5b keeps: "the earlier permission while idle stands"; Fable renew-key
#   ruling, supplements "WSL gate race" item 1 and "branch one, round four" item 2): it asks the probe's question first -- pgrep -ix with
#   WslJobPattern, by its exit alone -- and releases only on "none": exit 3 a job (skipped), 4 the lookup failed, then as above.
$script:DrillWslReleaseCommand = 'sync || exit 5; echo 1 > /proc/sys/vm/drop_caches || exit 5; exit 0'
$script:DrillWslIdleReleaseCommand = 'pgrep -ix ''Runner[.]Worker'' >/dev/null; found=$?; if [ $found -eq 0 ]; then exit 3; fi; if [ $found -ne 1 ]; then exit 4; fi; sync || exit 5; echo 1 > /proc/sys/vm/drop_caches || exit 5; exit 0'
# The three stages before a boot, each with its own sample (Invoke-DrillPreBootRelease, Start-DrillGuardedVm), for the receipt.
$script:DrillPreBoot = $null
# The guest password an interactive run set (Wait-DrillInteractive), for the evidence collection after it.
$script:DrillInteractiveCredential = $null
# The wait for memory before the hold (Wait-DrillBootMemory), carried into the pre-boot record (hostPreBoot.wait).
$script:DrillBootWait = $null

# ---------------------------------------------------------------- constants (the one place each fact lives)
$script:Drill = [ordered]@{
  Root = 'D:\clued-drill'
  VmName = 'clued-drill-win11'
  Marker = 'clued.drill-vm/1'
  Checkpoint = 'S0-clean-os'
  Iso = 'D:\clued-drill\iso\Win11_zh-cn_x64.iso'
  IsoExpectedSha = 'D:\clued-drill\iso\expected-sha256.txt'
  VmDir = 'D:\clued-drill\vm'
  Vhd = 'D:\clued-drill\vm\os.vhdx'
  AnswerDir = 'D:\clued-drill\vm\answer'
  AnswerIso = 'D:\clued-drill\vm\answer.iso'
  Credential = 'D:\clued-drill\guest-admin.clixml'
  # the Owner's drill binding in the test project (connection id, token), beside the guest credential and read by the same function
  BindingCredential = 'D:\clued-drill\drill-binding.clixml'
  # the host's copy of the drill server's public key: where drill-server-check.mjs keeps it (make-drill-kit.mjs HOST_KEY_FILE) unless a
  # test names its own
  ServerKeyFile = ''
  # the test project's database password (user postgres.<the project's ref>), handed over by the Owner once (-ServerDatabaseCredential):
  # beside the binding, read by the same function; given to the sync script on its standard input only (Sync-DrillServer)
  ServerDatabaseCredential = 'D:\clued-drill\drill-server-database.clixml'
  # production's applied list as the newest successful release run on main exported it, one run's copy (drill-server-check.mjs --production-list)
  ProductionListCache = 'D:\clued-drill\production-applied'
  # the sync script: this checkout's own (apps/clued-cloud/scripts/drill-test-sync.mjs) unless a test names its own
  SyncTool = ''
  # a rebuild replays production's ~330 rows (6-10 minutes by the design's estimate, not yet measured on the hosted project); a sync
  # already in step is a list comparison
  SyncTimeoutSeconds = 1800
  ProductionListTimeoutSeconds = 900
  Runs = 'D:\clued-drill\runs'
  GuestUser = 'drill'
  ComputerName = 'CLUED-DRILL'
  # Microsoft's published generic install key for Windows 11 Pro: it only selects the edition; the VM is never activated.
  ProProductKey = @('VK7JG', 'NPHTM', 'C97JM', '9MPGT', '3V66T') -join '-'
  MemoryBytes = 8GB
  # Keep production's workstation low-memory margin (Runner Runbook 2.2: 6 GiB) plus any VM memory still to allocate.
  ProductionReserveBytes = 6GB
  # The boot gate's margin over the guest and the running gate: passing the boot gate means the running gate still passes once the
  # guest is up, as long as the host's other usage grows by no more than this margin meanwhile (Fable renew-key ruling, supplement
  # "drill host memory" item 2). The boot gate is guest + running gate + this margin; nothing else holds the value. PROVISIONAL, to be recalibrated from the first receipt taken
  # under clean conditions (Fable, 2026-11-20). The receipts' "free at start - free after boot - guest 8 GB" (5.9 GB in run
  # 20261119T172257Z, 3.3 GB in run 20261119T030253Z) is not counted: it was the production WSL growing under a CI job of the host's
  # Actions runners, which no boot gate can foresee (below).
  BootMarginBytes = 1GB
  # The boot gate is memory only (Fable plan 0e418483 "drill boot gate: memory only", 2026-11-23): guest + BootMarginBytes +
  # ProductionReserveBytes, 15 GB, whatever runs on the host, plus what the runner distribution still has free, which the production WSL
  # can take after the boot (Fable plan 87d330d0: Test-DrillHostMemory). A runner job at boot -- on either side, or a side that could not be read --
  # is recorded (busyWith, runnerJob, wslJobs), never judged: what took the host short in the receipts was usage that came after the
  # boot, with or without a job at boot, which no boot gate sees; the running gate (ProductionReserveBytes abort, CacheReleaseBelowBytes
  # release) covers it. The job tier this replaces (10.4 GB more, from one receipt) only made the boot wait for an idle moment.
  # Before the host hold (Wait-DrillBootMemory: no intake requested, no watchdog, no VM touched) free memory is read every
  # BootWaitPollSeconds against that gate, for at most BootWaitMinutes; past it DRILL_HOST_MEMORY_SHORT and no boot. The boot gate in
  # Start-DrillGuardedVm still judges once, as before. No dispatch carries a memory figure: the script computes it.
  BootWaitMinutes = 60
  BootWaitPollSeconds = 120
  HostGuardSeconds = 30
  # The running guard's cache release (Fable ruling 0e418483 "drill memory root" 2.3, G1): below production's own resume line on a
  # workstation host (docs/maintenance/runner-configuration-and-operations.md 2.2: resume at >= 10 GiB free; its pause line, < 6 GiB, is
  # ProductionReserveBytes, the running gate's abort, which this does not change) the armed guard releases the runner distribution's file
  # cache (Invoke-DrillWslCacheRelease): at most once every CacheReleaseEverySeconds, each release bounded by CacheReleaseSeconds -- less
  # than one HostGuardSeconds tick, so the 6 GiB check is never held up. A release that fails or times out is only recorded.
  CacheReleaseBelowBytes = 10GB
  CacheReleaseEverySeconds = 120
  CacheReleaseSeconds = 20
  # Which WSL distribution this host's Linux Actions runners live in: the host's entry (by host name) in the self-hosted node registry of
  # this checkout. Not the installed node profile's wslDistribution: that is the resident's own distribution, registered for its
  # companion account, while the runners' jobs run in the operator's distribution (Fable renew-key ruling, supplement "WSL runner jobs").
  NodeProfiles = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\scripts\ci\self-hosted\node-profiles.json'))
  # The Owner's WSL settings (Fable plan 87d330d0 4.1): [wsl2] memory= there is the cap the runners' WSL VM gets when it next starts, which
  # the boot gate counts for a runner distribution that is not running (Read-DrillWslConfigMemory). The drill runs as the Owner, and the
  # runner distributions are registered in the Owner's account.
  WslConfig = (Join-Path $env:USERPROFILE '.wslconfig')
  WslTimeoutSeconds = 30
  # The one pattern pgrep looks for, in the probe, in the idle release command (which carries it verbatim:
  # Assert-DrillWslReleaseCommandLiteral) and in the Runner.Worker count of wslMemory (Get-DrillWslMemory):
  # an extended regular expression matched whole (-x) in any case (-i), its dot a literal dot (Codex review of addf1ffa5, low 1).
  WslJobPattern = 'Runner[.]Worker'
  HostStatusStaleSeconds = 300 # resident src/status.mjs: STATUS_STALE_MS
  HostStatus = 'C:\ProgramData\CluedIndependentCI\resident\state\status.json'
  IntakeHolder = 'drill'
  IntakeWaitMinutes = 40
  IntakeMarginMinutes = 10
  IntakeMaxMinutes = 120 # resident src/intake-pause.mjs: INTAKE_PAUSE_MAX_MS
  LadderFirstMinutes = 10 # ladder mode's first rung (coordinator, Owner 11-23: the first real round after 甲 is 10 minutes)
  IntakePollSeconds = 5
  HostMutex = 'Global\CluedFirstInstallDrill'
  BootMutex = 'Global\CluedFirstInstallDrillBoot'
  MinDiskFreeBytes = 100GB
  VhdBytes = 80GB
  Cpu = 4; CpuMaximum = 75; CpuWeight = 50; MaxIops = 2000
  Switch = 'Default Switch'
  InstallTimeoutMinutes = 90
  # No logon attempt while Windows setup is still copying and rebooting: SetupComplete.cmd (written in specialize) runs when
  # setup hands over to OOBE and publishes one Hyper-V KVP item, read on the host without logging on (Msvm_KvpExchangeComponent).
  # From there Wait-DrillGuest's probes take over (ImageState IMAGE_STATE_COMPLETE, OOBEInProgress 0, the same boot twice).
  SetupSignalName = 'CluedDrillSetup'
  SetupSignalCommand = 'cmd.exe /c "if not exist %WINDIR%\Setup\Scripts mkdir %WINDIR%\Setup\Scripts & echo reg add "HKLM\SOFTWARE\Microsoft\Virtual Machine\Guest" /v CluedDrillSetup /t REG_SZ /d complete /f>%WINDIR%\Setup\Scripts\SetupComplete.cmd"'
  BootKeySeconds = 30
  GuestRoot = 'C:\ProgramData\CluedIndependentCI\resident'
  GuestWork = 'C:\drill'
  # Every line the kit entry prints also goes here (under the guest work directory) as it comes, so a first install cut off by its
  # timeout still leaves what it printed (Save-DrillGuestEvidence).
  GuestEntryLog = 'first-install.stdout.log'
  SelfcheckFreshMinutes = 30
  UnattendedRebootMinutes = 10
  KitContract = 'clued.drill.first-install-kit/1'
  PrereqDir = 'D:\clued-drill\prereq'
  PrereqContract = 'clued.drill.prereq/1'
  PrereqTimeoutMinutes = 40
  ReceiptContract = 'clued.independent-ci.drill-receipt/1'
  ReadbackContract = 'clued.drill.production-readback/1'
  # The read-only guest probe (4.3 of Fable ruling 0e418483): the distribution the first install makes (windows/first-install-host.ps1 $Distribution,
  # checked by test/drill-guest-probe.test.mjs) and the one file inventory it reads.
  ProbeDistribution = 'CluedResident-Linux'
  ProbeFiles = (Join-Path (Split-Path -Parent $script:DrillScriptPath) 'guest-probe-files.json')
  # ---- Early stop and evidence while the first install runs (Fable plan 87d330d0, D:/w/tmp/PLAN-drill-loop-root-20261123.md 2.2 A1-A4,
  # 2.4, section 3 block A). The one place these values live.
  # A1: the foreground waits on a guest step one tick at a time; on each tick of the first install it pulls the guest's progress files
  # (DrillProgressFiles) back into the run directory, so an abort of any kind (guard deadline, short memory, crash) leaves the last tick's
  # copy. One pull is bounded by GuestPullSeconds, less than a tick.
  GuestTickSeconds = 30
  GuestPullSeconds = 20
  # A2: the foreground's own stop comes this many minutes before the guard's deadline, so the evidence is taken before any restore:
  # min(EvidenceWindowMinutes, EvidenceWindowShare x -RunTimeoutMinutes), never below EvidenceWindowMinMinutes (Get-DrillEvidenceWindowMinutes).
  # A short run keeps most of its time for the guest (10 minutes: 3), and the window is never zero, negative or the whole run (5..240 allowed).
  EvidenceWindowMinutes = 5
  EvidenceWindowShare = 0.3
  EvidenceWindowMinMinutes = 1
  # A3: the no-progress gates, per stage (Get-DrillProgressStop). Progress: any of the guest's progress files grew (plan 2.4). The stage is
  # the latest whose log is there: entry (none yet), host, prepare, launcher. Basis (plan 2.4, receipts under D:\clued-drill\runs):
  # - entry: the entry's front part (assets, prereq, unpack, check) writes no stage log; it took 464 s in 20261122T142427Z-...-cbecb80d-a97892ae
  #   (r13, the one run timed by segment): host.stdout.log must appear within EntryHostLogMinutes of the entry's start.
  # - host: 392-1467 s over 10 runs (1467 s in 20261121T061228Z-...-998ab86a-39d3d3b3); r13's largest gap between two steps 137 s:
  #   stalled 10 minutes, or 30 minutes in the stage.
  # - prepare: 112-130 s over 8 runs: 6 minutes in the stage.
  # - launcher (task 87d330d0 PR-2, plan FABLE-drill-role-probe-20261124 section 4.2): stalled 10 minutes, or 25 minutes in the stage. Both
  #   hold for a launcher that writes no step-start line: the longest silent step seen is linux-B, 221.75 s (20261123T193713Z-...-ad98eac7
  #   and 20261123T201433Z-...-74bc5ef0-52d496e7), the companion account step at most 8 minutes, the stage after the fix about 17 minutes
  #   (8.6 before first-train, 0.5 first-train, 0.2 verify and pause, 8 companion). Before, none: generation 16's first-train wait was
  #   silent for 1505 s and the run ended on its 70-minute deadline; now a launcher that waits silently stops within ten minutes.
  # A gate never fires past the foreground's stop: the deadline is judged first, so a short run (-RunTimeoutMinutes 10) ends on it.
  EntryHostLogMinutes = 15
  ProgressGates = [ordered]@{
    host = @{ stallMinutes = 10; maxMinutes = 30 }
    prepare = @{ stallMinutes = $null; maxMinutes = 6 }
    launcher = @{ stallMinutes = 10; maxMinutes = 25 }
  }
  # After the entry returned: read-after-install, A7 and A8 within this many minutes (13.1-13.8 observed in r13 and
  # 20261122T002532Z-...-ed827708-a456e0cf), or DRILL_AFTER_ENTRY_TIMEOUT; never past the foreground's stop.
  AfterEntryMaxMinutes = 20
}

# A stop carries its code in the message so every catch reports one code (no free text from the guest reaches it).
function New-DrillError([string]$Code, $Detail = $null) {
  $e = [System.InvalidOperationException]::new("DRILL:$Code")
  $e.Data['drillCode'] = $Code; $e.Data['drillDetail'] = $Detail
  return $e
}
function Get-DrillCode($err) {
  $ex = $err; if ($err -is [System.Management.Automation.ErrorRecord]) { $ex = $err.Exception }
  while ($ex) { if ($ex.Data -and $ex.Data.Contains('drillCode')) { return @{ code = $ex.Data['drillCode']; detail = $ex.Data['drillDetail'] } }; $ex = $ex.InnerException }
  $m = if ($err -is [System.Management.Automation.ErrorRecord]) { $err.Exception.Message } else { [string]$err }
  return @{ code = 'DRILL_UNEXPECTED'; detail = ([string]$m).Substring(0, [Math]::Min(300, ([string]$m).Length)) }
}

function Get-Sha256Hex([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-TextSha256Hex([string]$Text) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function ConvertTo-DrillJson($Value) { $Value | ConvertTo-Json -Depth 12 -Compress }
function Read-DrillJson([string]$Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-DrillJson([string]$Path, $Value) {
  $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($tmp, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}
function Get-Prop($Object, [string]$Path) {
  $cur = $Object
  foreach ($k in $Path.Split('.')) {
    if ($null -eq $cur) { return $null }
    if ($cur -is [System.Collections.IDictionary]) { if ($cur.Contains($k)) { $cur = $cur[$k] } else { return $null } }
    else { $p = $cur.PSObject.Properties[$k]; if ($null -eq $p) { return $null }; $cur = $p.Value }
  }
  return $cur
}

# ---------------------------------------------------------------- pure decisions (unit-tested offline)

# Memory only, before boot and while running: no runner job enters it (BootWaitMinutes' note). requiredBasis: what requiredFreeBytes is
# made of, in GB.
# Before boot the production WSL's headroom is counted as taken (Fable plan 87d330d0, FABLE-drill-memory-short-20261124 2.1 and 4, PR-A):
# what a running runner distribution still has free (/proc/meminfo MemFree) it can take after the boot, as it did in every
# DRILL_HOST_MEMORY_SHORT receipt; one registered but not running can be started and take the whole cap of the Owner's WSL VM (.wslconfig
# memory=, read by Get-DrillWslMemory -IdleCap). The highest of them: they share one VM. $WslMemory: Get-DrillWslMemory -IdleCap's
# readings (none: this host has no runner distribution, nothing to count); $null, a running one without MemFree or one not running
# without a cap: not read -- no boot (DRILL_HOST_RESOURCE_UNREADABLE), as for any host reading the boot gate rests on.
# requiredBasis.wslHeadroomSource: memfree, wslconfig-cap or none. Running, nothing is counted: the running gate is unchanged.
# The default (@(): nothing to count) is for the tests that call the gate directly. A boot is judged only through the two entries that
# read the WSL first and hand the reading over: Get-DrillHostSafety (the boot gate in Start-DrillGuardedVm) and Wait-DrillBootMemory
# (held by a test over this script's syntax tree).
function Test-DrillHostMemory([long]$FreeBytes, [long]$VmMemoryBytes = $script:Drill.MemoryBytes, [switch]$Running, [long]$MemoryAssigned = 0,
  $WslMemory = @()) {
  $target = [Math]::Max($script:Drill.MemoryBytes, $VmMemoryBytes)
  $guest = $margin = $headroom = 0L; $unread = $false; $source = $null
  if ($Running) {
    # Hyper-V's assigned memory has already been deducted from the host's free memory.
    $guest = [Math]::Max(0L, $target - $MemoryAssigned)
  } else {
    $guest = [Math]::Max($target, $MemoryAssigned); $margin = $script:Drill.BootMarginBytes
    if ($null -eq $WslMemory) { $unread = $true }
    else {
      foreach ($w in @($WslMemory)) {
        $f = Get-Prop $w 'memFreeGB'; $from = 'memfree'
        if ($null -eq $f -and (Get-Prop $w 'running') -eq $false) { $f = Get-Prop $w 'capGB'; $from = 'wslconfig-cap' }
        if ($null -eq $f) { $unread = $true; break }
        # the reading is in GB rounded to two places (up to ~5 MB under; the 1 GB boot margin covers it); bytes rounded up
        $b = [long][Math]::Ceiling([double]$f * 1GB); if ($null -eq $source -or $b -gt $headroom) { $headroom = $b; $source = $from }
      }
    }
  }
  if (-not $unread -and $null -eq $source) { $source = 'none' }
  $required = $guest + $margin + $script:Drill.ProductionReserveBytes + $headroom
  $gb = { param([long]$b) [Math]::Round($b / 1GB, 1) }
  $code = if ($unread) { 'DRILL_HOST_RESOURCE_UNREADABLE' } elseif ($FreeBytes -lt $required) { 'DRILL_HOST_MEMORY_SHORT' } else { $null }
  return @{ ok = ($null -eq $code); code = $code;
    freeGB = (& $gb $FreeBytes); requiredFreeBytes = $required
    requiredBasis = [ordered]@{ guestGB = (& $gb $guest); bootMarginGB = (& $gb $margin); productionReserveGB = (& $gb $script:Drill.ProductionReserveBytes)
      wslHeadroomGB = $(if ($unread) { $null } else { [Math]::Round($headroom / 1GB, 2) })
      wslHeadroomSource = $(if ($unread) { $null } else { $source }) } }
}

# An Actions self-hosted runner executes each job in a Runner.Worker process (its Runner.Listener only waits for work). Judged from the
# host's process list, not from runner names: how many runners the host has and what they are called is read from the machine.
function Test-DrillHostRunnerJob([string[]]$ProcessNames) {
  return @($ProcessNames | Where-Object { $_ -ieq 'Runner.Worker' }).Count -gt 0
}

# Both sides (Fable renew-key ruling, supplements "WSL runner jobs" and "branch one, round four"): the Windows process list ($null: it could
# not be read), and the runner distribution's answer -- $WslJob $true (a Runner.Worker there), $false (none, or no runner distribution
# running), or $null (that side could not be read). A job confirmed on either side comes first: ACTIONS_RUNNER_JOB, WSL_ACTIONS_RUNNER_JOB;
# then a side that could not be read: WINDOWS_UNREADABLE, WSL_UNREADABLE; $null only when both sides were read and neither has a job.
# None of these refuses the boot or raises its memory gate (Fable plan 0e418483 "drill boot gate: memory only"): recorded only.
function Get-DrillRunnerJob($ProcessNames, $WslJob) {
  if ($null -ne $ProcessNames -and (Test-DrillHostRunnerJob $ProcessNames)) { return 'ACTIONS_RUNNER_JOB' }
  if ($WslJob -eq $true) { return 'WSL_ACTIONS_RUNNER_JOB' }
  if ($null -eq $ProcessNames) { return 'WINDOWS_UNREADABLE' }
  if ($null -eq $WslJob) { return 'WSL_UNREADABLE' }
  return $null
}
# What a reading of Get-DrillRunnerJob says about a job at boot: yes (confirmed), no (both sides read, none), unknown (a side not read).
function Get-DrillRunnerJobState($BusyWith) {
  if ($null -eq $BusyWith) { return 'no' }
  if ([string]$BusyWith -cin @('ACTIONS_RUNNER_JOB', 'WSL_ACTIONS_RUNNER_JOB')) { return 'yes' }
  return 'unknown'
}

function ConvertTo-DrillTimestamp($Value) {
  # ConvertFrom-Json can supply a DateTime in PowerShell 7.
  if ($Value -is [DateTime]) {
    if ($Value.Kind -ne [DateTimeKind]::Unspecified) { return [DateTimeOffset]$Value }
    return
  }
  $timestamp = [DateTimeOffset]::MinValue
  if ($Value -is [string] -and $Value -cmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$' -and
    [DateTimeOffset]::TryParse($Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$timestamp)) { return $timestamp }
}

function Test-DrillHostStatusFresh($WrittenAt, [DateTimeOffset]$Now) {
  $timestamp = ConvertTo-DrillTimestamp $WrittenAt
  if ($null -eq $timestamp) { return $false }
  $ageSeconds = ($Now - $timestamp).TotalSeconds
  return $ageSeconds -le $script:Drill.HostStatusStaleSeconds -and $ageSeconds -ge -60
}

# An absolute deadline keeps the required hold from moving forward at each poll.
# Without a deadline this is the standby-only gate (baseline installation and runs that did not request a hold).
# A drill hold leaves the parked stage-8 tries and revoke-only train maintenance on the Windows side.
function Test-DrillHostSafety([string]$StatusJson, [long]$FreeBytes, [switch]$Running, [long]$VmMemoryBytes = $script:Drill.MemoryBytes,
  [long]$MemoryAssigned = 0, [DateTimeOffset]$Now = (Get-DrillTime),
  [DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue, $ProcessNames = @(), $WslJob = $false, $WslMemory = @()) {
  # Before boot only: a runner job on either side (or a side that could not be read) is recorded and judged by nothing -- neither a
  # refusal nor a higher memory gate (Fable plan 0e418483 "drill boot gate: memory only"). A job picked up after the boot is left to the
  # running memory gate, as before.
  $busyWith = if ($Running) { $null } else { Get-DrillRunnerJob $ProcessNames $WslJob }
  $memory = Test-DrillHostMemory $FreeBytes $VmMemoryBytes -Running:$Running -MemoryAssigned $MemoryAssigned -WslMemory $WslMemory
  $code = 'DRILL_HOST_STATUS_UNREADABLE'
  $mode = $null; $since = $null; $until = $null
  $executorObservation = $null
  try {
    if (-not $StatusJson.TrimStart().StartsWith('{')) { throw 'expected a status object' }
    $s = ConvertFrom-Json -InputObject $StatusJson -ErrorAction Stop
    $reportedMode = $s.node.mode; $executor = $s.executor.state
    if ($reportedMode -is [string] -and $reportedMode -cin @('ACTIVE', 'STANDBY') -and
        $null -ne $s.PSObject.Properties['current'] -and $executor -is [string]) {
      $code = 'DRILL_HOST_STATUS_STALE'
      $writtenAt = $s.PSObject.Properties['writtenAt']
      if ($writtenAt -and (Test-DrillHostStatusFresh $writtenAt.Value $Now)) {
        $mode = $reportedMode
        $reason = $s.executor.PSObject.Properties['reason']
        $executorObservation = [ordered]@{
          state = $executor
          reason = $(if ($reason -and $reason.Value -is [string]) { $reason.Value } else { $null })
          current = $null
        }
        if ($null -ne $s.current) {
          $stageProperty = $s.current.PSObject.Properties['stage']
          $phaseProperty = $s.current.PSObject.Properties['phase']
          $executorObservation.current = [ordered]@{
            stage = $(if ($stageProperty -and ($stageProperty.Value -is [int] -or $stageProperty.Value -is [long])) { $stageProperty.Value } else { $null })
            phase = $(if ($phaseProperty -and $phaseProperty.Value -is [string]) { $phaseProperty.Value } else { $null })
          }
        }
        $pause = $s.PSObject.Properties['intakePause']
        $holders = if ($pause -and $pause.Value -is [pscustomobject]) { $pause.Value.PSObject.Properties['holders'] }
        $drillHolds = @()
        if ($holders -and $holders.Value -is [array]) {
          $drillHolds = @($holders.Value | Where-Object {
            $_ -and $_.PSObject.Properties['holder'] -and $_.holder -is [string] -and $_.holder -ceq $script:Drill.IntakeHolder
          })
        }
        if ($drillHolds.Count -eq 1) {
          $h = $drillHolds[0]
          if ($h.PSObject.Properties['since']) { $since = ConvertTo-DrillTimestamp $h.since }
          if ($h.PSObject.Properties['until']) { $until = ConvertTo-DrillTimestamp $h.until }
        }
        $quiet = $executor -cin @('IDLE', 'WAITING', 'DEFERRED', 'HALTED', 'PAUSED', 'BACKFILL_PENDING', 'STOPPED',
          'COMPLETED', 'FAILED_CLEAN', 'NOT_ADMITTED', 'NOT_EXECUTED', 'IGNORED')
        $stage8 = $false
        if ($mode -ceq 'ACTIVE' -and $s.executor -is [pscustomobject]) {
          $maintenance = $executor -ceq 'RUNNING' -and $null -ne $reason -and
            $reason.Value -is [string] -and $reason.Value -ceq 'TRAIN_MAINTENANCE'
          $quiet = $quiet -or $executor -ceq 'PARKED' -or $maintenance

          # resumeParkedB's start checks leave the status board alone. atStage publishes stage and phase together.
          $runningBatch = $executor -ceq 'RUNNING' -and $null -ne $reason -and $null -eq $reason.Value
          if ($Running -and $s.current -is [pscustomobject] -and ($quiet -or $runningBatch) -and
              $s.current.PSObject.Properties['stage'] -and $s.current.PSObject.Properties['phase']) {
            $stage = $s.current.stage
            $phase = $s.current.phase
            $stage8 = ($stage -is [int] -or $stage -is [long]) -and $stage -eq 8 -and
              $phase -is [string] -and $phase -ceq 'stage'
          }
        }
        if (-not (($quiet -and $null -eq $s.current) -or $stage8)) {
          $code = if ($executor -cin @('RUNNING', 'PARKED') -or $null -ne $s.current) { 'DRILL_HOST_CI_BUSY' }
            else { 'DRILL_HOST_STATUS_UNREADABLE' }
        }
        elseif ($mode -ceq 'ACTIVE' -and ($HoldUntil -le $Now -or $null -eq $since -or $since -gt $Now -or
          $null -eq $until -or $until -lt $HoldUntil -or $until -gt $Now.AddMinutes($script:Drill.IntakeMaxMinutes))) {
          $code = 'DRILL_HOST_IS_ON_DUTY'
        }
        else { $code = $memory.code }
      }
    }
  } catch { $code = 'DRILL_HOST_STATUS_UNREADABLE' }
  $out = @{ ok = ($null -eq $code); code = $code; mode = $mode; holdSince = $since; holdUntil = $until;
    freeGB = $memory.freeGB; requiredFreeBytes = $memory.requiredFreeBytes; requiredBasis = $memory.requiredBasis;
    executorObservation = $executorObservation; observedAt = $Now.ToUniversalTime().ToString('o');
    action = $(if ($code) { if ($Running) { 'abort' } else { 'refuse' } } else { if ($Running) { 'continue' } else { 'start' } }) }
  # the running gate reads no runner job: no job reading at all, rather than one that says "none" (Fable ruling 0e418483 "drill memory
  # root" 2.4, G2: r11's abort record said runnerJob null, wslJobs [])
  if (-not $Running) { $out.busyWith = $busyWith; $out.runnerJob = Get-DrillRunnerJobState $busyWith }
  return $out
}

# What to do with the VM named ours. $Vm: $null or @{ notes; state; checkpoints = @(names) }.
#   ready    the VM is ours, Off, and has the clean-OS checkpoint
#   build    no VM by that name: build the baseline
#   rebuild  ours but without the checkpoint (a baseline build that did not finish): remove it and build again
#   refuse   a VM by that name that is not ours (DRILL_VM_NAME_TAKEN_NOT_OURS), or ours and not Off (DRILL_VM_NOT_OFF)
function Get-DrillBaselineAction($Vm) {
  if ($null -eq $Vm) { return @{ action = 'build'; code = $null } }
  if ([string]$Vm.notes -cne $script:Drill.Marker) { return @{ action = 'refuse'; code = 'DRILL_VM_NAME_TAKEN_NOT_OURS' } }
  if ([string]$Vm.state -ne 'Off') { return @{ action = 'refuse'; code = 'DRILL_VM_NOT_OFF' } }
  if (@($Vm.checkpoints) -contains $script:Drill.Checkpoint) { return @{ action = 'ready'; code = $null } }
  return @{ action = 'rebuild'; code = $null }
}

# Guest readiness from successive probes (@{ boot; imageState; oobe }, $null when PowerShell Direct does not answer).
# Ready = Windows setup and OOBE are finished (ImageState IMAGE_STATE_COMPLETE, OOBEInProgress 0), the boot is after $After, and
# the same boot answers ready on two probes in a row. The local account, and so PowerShell Direct, works from the middle of OOBE
# on, and OOBE still restarts the machine after that: the first real baseline (2026-11-16 10:29) took that answer for "installed"
# and its next step died with "the system is shutting down".
function Step-DrillReadiness($Previous, $Probe, [DateTimeOffset]$After) {
  if ($null -eq $Probe) { return @{ ready = $false; candidate = $null } }
  $boot = [DateTimeOffset]::Parse([string]$Probe.boot, [Globalization.CultureInfo]::InvariantCulture)
  $settled = ([string]$Probe.imageState -ceq 'IMAGE_STATE_COMPLETE') -and ([int]$Probe.oobe -eq 0) -and ($boot -gt $After)
  if (-not $settled) { return @{ ready = $false; candidate = $null } }
  $id = $boot.ToUniversalTime().ToString('o')
  return @{ ready = ($null -ne $Previous -and [string]$Previous -ceq $id); candidate = $id }
}

# The value of KVP item $Name among Msvm_KvpExchangeComponent.GuestExchangeItems (each an Msvm_KvpExchangeDataItem as XML).
function Get-DrillKvpValue([string[]]$Items, [string]$Name) {
  foreach ($item in @($Items)) {
    try { $x = [xml]$item } catch { continue }
    $props = @($x.SelectNodes('/INSTANCE/PROPERTY'))
    $n = @($props | Where-Object { $_.GetAttribute('NAME') -ceq 'Name' })
    $d = @($props | Where-Object { $_.GetAttribute('NAME') -ceq 'Data' })
    if ($n.Count -eq 1 -and $d.Count -eq 1 -and [string]$n[0].InnerText -ceq $Name) { return [string]$d[0].InnerText }
  }
  return $null
}

# Why a guest step failed, from the boot time before it and the boot time once the guest is ready again ('' = never ready).
function Get-DrillStepFailureKind([string]$BootBefore, [string]$BootAfter) {
  if ([string]::IsNullOrEmpty($BootAfter)) { return 'unreachable' }
  if ([string]::IsNullOrEmpty($BootBefore)) { return 'restarted' }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  if ([DateTimeOffset]::Parse($BootAfter, $inv) -ne [DateTimeOffset]::Parse($BootBefore, $inv)) { return 'restarted' }
  return 'failed'
}

# The ISO is used only when its sha256 equals the expected value written next to it (the download's single source of truth).
function Test-DrillIsoHash([string]$Actual, [string]$ExpectedText) {
  $expected = ([string]$ExpectedText).Trim().Split()[0].ToLowerInvariant()
  if ($expected -notmatch '^[0-9a-f]{64}$') { return @{ ok = $false; code = 'DRILL_ISO_EXPECTED_SHA_UNREADABLE' } }
  if ($Actual -cne $expected) { return @{ ok = $false; code = 'DRILL_ISO_HASH_MISMATCH'; expected = $expected; actual = $Actual } }
  return @{ ok = $true; code = $null; sha256 = $expected }
}

function ConvertTo-XmlText([string]$s) { [Security.SecurityElement]::Escape($s) }

# The answer file: GPT disk, Windows 11 Pro chosen by the generic key, zh-CN, local admin, no online account, no auto-logon.
function New-DrillAutounattend([string]$Password) {
  if ([string]::IsNullOrEmpty($Password)) { throw (New-DrillError 'DRILL_ANSWER_PASSWORD_EMPTY') }
  $amd = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"'
  $locale = '<InputLocale>0804:00000804</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale>'
  $pw = ConvertTo-XmlText $Password
  @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" $amd>
      <SetupUILanguage><UILanguage>zh-CN</UILanguage></SetupUILanguage>
      $locale
    </component>
    <component name="Microsoft-Windows-Setup" $amd>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><Key>$($script:Drill.ProProductKey)</Key><WillShowUI>OnError</WillShowUI></ProductKey>
      </UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" $amd>
      <ComputerName>$($script:Drill.ComputerName)</ComputerName>
      <TimeZone>China Standard Time</TimeZone>
    </component>
    <component name="Microsoft-Windows-Deployment" $amd>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>setup-complete signal to the host (Hyper-V KVP), written by SetupComplete.cmd once OOBE is over</Description>
          <Path>$(ConvertTo-XmlText $script:Drill.SetupSignalCommand)</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" $amd>
      $locale
    </component>
    <component name="Microsoft-Windows-Shell-Setup" $amd>
      <OOBE>
        <HideEULAPage>true</HideEULAPage><HideLocalAccountScreen>true</HideLocalAccountScreen><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$($script:Drill.GuestUser)</Name><Group>Administrators</Group>
            <Password><Value>$pw</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
    </component>
  </settings>
</unattend>
"@
}

# A small ISO holding only autounattend.xml, built with Windows' own IMAPI2 (no ADK, no elevation). Windows Setup reads the
# Joliet name from any removable drive. Never overwrites: the target must not exist.
function New-DrillAnswerIso([string]$SourceDir, [string]$IsoPath) {
  if (-not ('DrillIsoWriter' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class DrillIsoWriter {
  public static long Write(object stream, string path) {
    IStream s = (IStream)stream; long total = 0;
    using (FileStream f = new FileStream(path, FileMode.CreateNew, FileAccess.Write)) {
      byte[] buf = new byte[65536]; IntPtr p = Marshal.AllocHGlobal(4);
      try { while (true) { s.Read(buf, buf.Length, p); int n = Marshal.ReadInt32(p); if (n <= 0) break; f.Write(buf, 0, n); total += n; } }
      finally { Marshal.FreeHGlobal(p); }
    }
    return total;
  }
}
'@
  }
  $fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $fsi.FileSystemsToCreate = 3   # ISO9660 + Joliet
  $fsi.VolumeName = 'CLUEDANSWER'
  $fsi.Root.AddTree($SourceDir, $false)
  [void][DrillIsoWriter]::Write($fsi.CreateResultImage().ImageStream, $IsoPath)
  return $IsoPath
}

# The release triple (fetch.mjs names): the tar is accepted only when its sha256 equals SHA256SUMS and the acceptance file.
# A candidate (Fable ruling 11-19 section 2.3: the drill runs BEFORE the Owner accepts): the From directory has no acceptance and the
# kit carries the candidate's own (make-drill-kit.mjs candidateAcceptance, for the guest only); the run is held to the three hashes the
# kit names and the receipt says candidate: true with them. A candidate kit with an Owner's acceptance in From is refused (which one?).
function Test-DrillPackageDir([string]$Dir, [string]$Version, $KitInfo = $null) {
  if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.\-]{0,63}$') { throw (New-DrillError 'DRILL_VERSION_REFUSED') }
  $tag = "fleet-node-$Version"
  $tar = Join-Path $Dir "$tag.tar"; $acc = Join-Path $Dir "$tag.acceptance.json"; $sums = Join-Path $Dir 'SHA256SUMS'
  $candidate = Get-Prop $KitInfo 'candidate'; $server = Get-Prop $KitInfo 'server'
  if ($null -ne $candidate) {
    if (Test-Path -LiteralPath $acc) { throw (New-DrillError 'DRILL_CANDIDATE_KIT_BUT_FROM_HAS_AN_ACCEPTANCE' ([IO.Path]::GetFileName($acc))) }
    $acc = [string](Get-Prop $candidate 'acceptance')
  }
  # A kit with the server stand-in (make-drill-kit.mjs serverStandIn) carries the acceptance the guest installs on, for an accepted
  # version too: it names the drill's first-install kit. The Owner's own in From is still read first and held to the Release's kit.
  $ownersKitSha = $null
  if ($null -ne $server -and $null -eq $candidate) {
    if (-not (Test-Path -LiteralPath $acc -PathType Leaf)) { throw (New-DrillError 'DRILL_PACKAGE_FILE_MISSING' ([IO.Path]::GetFileName($acc))) }
    $owners = Read-DrillJson $acc
    if ([string](Get-Prop $owners 'contract') -cne 'clued.independent-ci.fleet-node-acceptance/1' -or [string](Get-Prop $owners 'version') -cne $Version) { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED') }
    if ([string](Get-Prop $owners 'archive_sha256') -cne (Get-Sha256Hex $tar)) { throw (New-DrillError 'DRILL_TAR_NOT_THE_ACCEPTED_ONE') }
    $ownersKitSha = [string](Get-Prop $owners 'firstInstallKitSha256'); $ownersSource = [string](Get-Prop $owners 'ciSourceManifestSha256')
    if ($ownersKitSha -cne [string]$server.releaseFirstInstallKitSha256) { throw (New-DrillError 'DRILL_KIT_SERVER_NOT_THIS_RELEASE' 'acceptance') }
    $acc = [string]$server.overrides[[IO.Path]::GetFileName($acc)]
  }
  foreach ($f in @($tar, $acc, $sums)) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw (New-DrillError 'DRILL_PACKAGE_FILE_MISSING' ([IO.Path]::GetFileName($f))) } }
  $sha = Get-Sha256Hex $tar
  $acceptance = Read-DrillJson $acc
  if ([string](Get-Prop $acceptance 'contract') -cne 'clued.independent-ci.fleet-node-acceptance/1' -or [string](Get-Prop $acceptance 'version') -cne $Version) { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED') }
  if ([string](Get-Prop $acceptance 'archive_sha256') -cne $sha) { throw (New-DrillError 'DRILL_TAR_NOT_THE_ACCEPTED_ONE' @{ actual = $sha }) }
  $line = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match "^[0-9a-f]{64}\s+\*?$([regex]::Escape("$tag.tar"))$" })
  if ($line.Count -ne 1 -or $line[0].Substring(0, 64) -cne $sha) { throw (New-DrillError 'DRILL_TAR_NOT_IN_SHA256SUMS') }
  $source = [string](Get-Prop $acceptance 'ciSourceManifestSha256')
  if ($source -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_ACCEPTANCE_REFUSED' 'ciSourceManifestSha256') }
  $kitSha = [string](Get-Prop $acceptance 'firstInstallKitSha256')
  # with the server stand-in the kit's acceptance names the drill's first-install kit; the hash this run is held to and its receipt
  # carries (what the Owner accepts, what seal compares) stays the Release's
  $drillKitSha = $null
  if ($null -ne $server) {
    if ($kitSha -cne [string]$server.firstInstallKitSha256) { throw (New-DrillError 'DRILL_KIT_SERVER_STAND_IN_REFUSED' 'acceptance') }
    if ($null -ne $ownersKitSha -and $source -cne $ownersSource) { throw (New-DrillError 'DRILL_KIT_SERVER_STAND_IN_REFUSED' 'acceptance source') }
    $drillKitSha = $kitSha; $kitSha = [string]$server.releaseFirstInstallKitSha256
  }
  if ($null -ne $candidate -and ($sha -cne [string](Get-Prop $candidate 'tarSha256') -or $source -cne [string](Get-Prop $candidate 'ciSourceManifestSha256') -or
      $kitSha -cne [string](Get-Prop $candidate 'firstInstallKitSha256'))) { throw (New-DrillError 'DRILL_CANDIDATE_NOT_THE_KITS') }
  return [ordered]@{ version = $Version; tar = $tar; acceptance = $acc; sums = $sums; tarSha256 = $sha; ciSourceManifestSha256 = $source
    firstInstallKitSha256 = $kitSha; drillFirstInstallKitSha256 = $drillKitSha; candidate = ($null -ne $candidate) }
}

# The first-install kit (kit.json, contract clued.drill.first-install-kit/1): every file pinned by sha256; one entry run in the
# guest with only the fixed placeholders {from} {kit} {fake} {work} {version} (no node value can be passed); perNodeSteps names
# the manual per-node steps the kit still stands in for (A10 passes only when it is empty, i.e. after the universal first install).
function Read-DrillKit([string]$Dir) {
  $file = Join-Path $Dir 'kit.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw (New-DrillError 'DRILL_FIRST_INSTALL_KIT_MISSING') }
  $kit = Read-DrillJson $file
  if ([string](Get-Prop $kit 'contract') -cne $script:Drill.KitContract) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'contract') }
  $files = @(Get-Prop $kit 'files')
  if ($files.Count -lt 1) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'files') }
  $root = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
  $seen = @{}
  foreach ($f in $files) {
    $rel = [string](Get-Prop $f 'path'); $want = [string](Get-Prop $f 'sha256')
    if ($rel -notmatch '^[A-Za-z0-9._+~\-\\]+$' -or $rel -match '(^|\\)\.\.(\\|$)' -or $want -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "file $rel") }
    $full = [IO.Path]::GetFullPath((Join-Path $Dir $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw (New-DrillError 'DRILL_KIT_REFUSED' "file $rel") }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw (New-DrillError 'DRILL_KIT_FILE_MISSING' $rel) }
    if ((Get-Sha256Hex $full) -cne $want) { throw (New-DrillError 'DRILL_KIT_FILE_CHANGED' $rel) }
    $seen[$rel.ToLowerInvariant()] = $true
  }
  $entry = Get-Prop $kit 'entry'
  $entryFile = [string](Get-Prop $entry 'file')
  if (-not $seen.ContainsKey($entryFile.ToLowerInvariant()) -or $entryFile -notmatch '\.ps1$') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'entry.file') }
  $kitArgs = @(Get-Prop $entry 'arguments')
  foreach ($a in $kitArgs) {
    $s = [string]$a
    if ($s -notmatch '^(-[A-Za-z][A-Za-z0-9]*|\{(from|kit|fake|work|version)\})$') { throw (New-DrillError 'DRILL_KIT_ARGUMENT_REFUSED' $s) }
  }
  $timeout = Get-Prop $kit 'timeoutMinutes'
  if (-not ($timeout -is [int] -or $timeout -is [long]) -or $timeout -lt 5 -or $timeout -gt 240) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'timeoutMinutes') }
  if ($null -eq $kit.PSObject.Properties['perNodeSteps']) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'perNodeSteps') }
  $perNode = @($kit.perNodeSteps | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  $prereqSha = [string](Get-Prop $kit 'prereqSha256')
  if ($prereqSha -notmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'prereqSha256') }
  $mode = [string](Get-Prop $kit 'prerequisiteMode')
  if ($mode -and $mode -cne 'first-install-host') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'prerequisiteMode') }
  if ($mode -and -not $seen.ContainsKey('release-pins.json')) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'release-pins.json') }
  $blocker = [string](Get-Prop $kit 'executionBlocker')
  # a candidate's kit (make-drill-kit.mjs): its acceptance is one of the kit's pinned files, and the three hashes it names
  $candidate = $null; $c = Get-Prop $kit 'candidate'
  if ($null -ne $c) {
    $accName = [string](Get-Prop $c 'acceptance')
    if ($accName -cnotmatch '^fleet-node-[0-9A-Za-z][0-9A-Za-z.\-]{0,63}\.acceptance\.json$' -or -not $seen.ContainsKey($accName.ToLowerInvariant())) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'candidate.acceptance') }
    $candidate = [ordered]@{ acceptance = (Join-Path $Dir $accName) }
    foreach ($k in @('tarSha256', 'ciSourceManifestSha256', 'firstInstallKitSha256')) {
      $v = [string](Get-Prop $c $k); if ($v -cnotmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "candidate.$k") }
      $candidate[$k] = $v
    }
  }
  # the server stand-in (make-drill-kit.mjs serverStandIn): the drill's server, the two hashes of the first-install kit (the Release's and
  # the drill's) and the three files the kit carries in place of the Release's, each one of the kit's pinned files
  $server = $null; $sv = Get-Prop $kit 'server'
  if ($null -ne $sv) {
    if ([string](Get-Prop $sv 'contract') -cne 'clued.drill.server-stand-in/1') { throw (New-DrillError 'DRILL_KIT_REFUSED' 'server.contract') }
    $server = [ordered]@{ project = [string](Get-Prop $sv 'project'); supabaseUrl = [string](Get-Prop $sv 'supabaseUrl'); replaced = @(Get-Prop $sv 'replaced' | ForEach-Object { [string]$_ })
      blackholeHosts = @(Get-Prop $sv 'blackholeHosts' | ForEach-Object { [string]$_ }); overrides = @{} }
    if ($server.supabaseUrl -cnotmatch '^https://[a-z0-9]+\.supabase\.co$' -or $server.blackholeHosts.Count -lt 1) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'server') }
    foreach ($k in @('releaseFirstInstallKitSha256', 'firstInstallKitSha256')) {
      $v = [string](Get-Prop $sv $k); if ($v -cnotmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "server.$k") }
      $server[$k] = $v
    }
    foreach ($k in @('firstInstallKit', 'firstInstallSums', 'acceptance')) {
      $name = [string](Get-Prop $sv "files.$k")
      if ($name -cnotmatch '^fleet-node-[0-9A-Za-z][0-9A-Za-z.\-]{0,63}\.(first-install-kit\.json|first-install\.SHA256SUMS|acceptance\.json)$' -or -not $seen.ContainsKey($name.ToLowerInvariant())) { throw (New-DrillError 'DRILL_KIT_REFUSED' "server.files.$k") }
      $server.overrides[$name] = (Join-Path $Dir $name)
    }
    if ($server.overrides.Count -ne 3) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'server.files') }
  }
  return [ordered]@{ server = $server; dir = $Dir; sha256 = (Get-Sha256Hex $file); entryFile = $entryFile; arguments = @($kitArgs | ForEach-Object { [string]$_ }); timeoutMinutes = [int]$timeout; perNodeSteps = $perNode; prereqSha256 = $prereqSha; prerequisiteMode = $mode; executionBlocker = $blocker; candidate = $candidate; credentials = (Get-Prop $kit 'credentials'); credentialFilesSha256 = (Get-Prop $kit 'credentialFilesSha256') }
}

# The drill's decision for each credential file name a package may declare (Fable renew-key ruling, supplements "merge order" and
# "heartbeat token and restart code"): give it -- New-DrillFakeCredentials makes the file under `fake`, the entry's copy table hands it
# over under the package's name -- or withhold it by design, with the reason. Neither side has a default: a required name the drill
# cannot give, or an optional name with no decision here, refuses the drill before any boot (Get-DrillCredentialPlan). Registered in
# FIRST-INSTALL-KIT.md (stand-in register); the receipt lists the optional ones withheld. The table is drill/credential-decisions.json, the
# one source make-drill-kit.mjs reads too: a name given there with a perNodeStep is registered in the kit's per-node steps whenever the
# package names it, required or optional, exactly as the run makes and hands it over (Codex review of f33fc33e5, medium 4).
# Looked up by file name ordinally and case-sensitively (6th review round, low 1), as make-drill-kit.mjs looks it up (an object's own key)
# and as the package's names are bound (Assert-DrillKitCredentialsBound compares with -cne): a name the table
# spells otherwise is no decision at either end.
function Read-DrillCredentialDecisions([string]$File) {
  $t = [IO.File]::ReadAllText($File, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  if ([string]$t.contract -cne 'clued.drill.credential-decisions/1') { throw (New-DrillError 'DRILL_CREDENTIAL_DECISIONS_REFUSED' $File) }
  $o = New-Object System.Collections.Specialized.OrderedDictionary -ArgumentList ([StringComparer]::Ordinal)
  foreach ($p in $t.decisions.PSObject.Properties) { $d = [ordered]@{}; foreach ($f in $p.Value.PSObject.Properties) { $d[$f.Name] = $f.Value }; $o[$p.Name] = $d }
  $o
}
$script:DrillCredentialDecisions = Read-DrillCredentialDecisions (Join-Path $PSScriptRoot 'credential-decisions.json')

# The kit's credential names bound again to the package being drilled (Codex review of e0a3cded5, high 2): the package's
# credential-files.json read from the verified tar by the one reader (make-drill-kit.mjs --credentials-of); the hash of its bytes and its
# two groups, name by name, must be the kit's record; any difference refuses the drill before any boot.
function Assert-DrillKitCredentialsBound($KitInfo, [string]$Tar) {
  $reader = Join-Path (Split-Path -Parent $script:DrillScriptPath) 'make-drill-kit.mjs'
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $run = Invoke-DrillNode $node @($reader, '--credentials-of', $Tar) 60
  $derived = $null
  if ($run.exit -eq 0) { try { $derived = $run.stdout | ConvertFrom-Json } catch { $derived = $null } }
  if ($null -eq $derived -or [string](Get-Prop $derived 'sha256') -cnotmatch '^[0-9a-f]{64}$') { throw (New-DrillError 'DRILL_PACKAGE_CREDENTIALS_UNREADABLE' $Tar) }
  # the list's bytes by their hash, and the two groups member by member (8th review round, medium 1: never through a joined text)
  $bytes = [string](Get-Prop $derived 'sha256'); $recorded = [string](Get-Prop $KitInfo 'credentialFilesSha256')
  $same = Test-DrillCredentialGroupsEqual (Get-Prop $derived 'credentials') (Get-Prop $KitInfo 'credentials')
  # the recorded hash a lowercase hex digest, compared ordinally (9th review round, low 2: -cne is culture-aware and ignores some characters)
  $hashSame = ($recorded -cmatch '^[0-9a-f]{64}$') -and [string]::Equals($bytes, $recorded, [StringComparison]::Ordinal)
  if (-not $same -or -not $hashSame) { throw (New-DrillError 'DRILL_KIT_CREDENTIALS_NOT_THE_PACKAGES' @{ groupsEqual = $same; packageSha256 = $bytes; kitSha256 = $recorded }) }
}

# The drill's server and binding, before the host gate, the hold or any boot (FABLE-drill-role-probe-20261124.md, PR-3). A kit without
# the server stand-in would install against the Release's own address, production: refused, nothing falls back to it. The stand-in is
# held again to the Release directory by its one reader (make-drill-kit.mjs --server-of: the Release's first-install kit is the one the
# kit was made from, the drill's differs in the two server fields only and is not production's, the production host is in the list the
# guest cuts off). And the Owner's drill binding must be there, in its shape: without it the drill does not start.
# Then the test project is brought to production's applied list (Sync-DrillServer; FABLE-drill-test-project-sync-20261124.md, the
# ruling on the PR-A report, section 1: the host does it, no workflow), and the server itself is asked (section 2.2;
# drill-server-check.mjs --ready): the role probe the guest is about to send, sent from here with the binding's token, must be answered
# "holds no role". No list, no password or a refused one, a project that is not a prefix of production, a rotated key, an expired token,
# a binding the server would let through: each stops the drill here with its own code (Sync-DrillServer's, then DRILL_SERVER_KEY_REFUSED,
# DRILL_SERVER_UNREACHABLE, DRILL_SERVER_PROBE_FUNCTION_MISSING, DRILL_BINDING_REFUSED_BY_SERVER, DRILL_BINDING_ON_DUTY). What the sync
# followed (the release run, production's last row and row count, the rows applied now) is kept for the drill's receipt (server.sync).
function Assert-DrillServerReady($KitInfo, $Package) {
  $server = Get-Prop $KitInfo 'server'
  if ($null -eq $server) { throw (New-DrillError 'DRILL_KIT_SERVER_STAND_IN_MISSING' 'the kit names no drill server: make it again with make-drill-kit.mjs') }
  $binding = Get-DrillCredential -Binding
  # never a rebuild here: that is DESK's, once (-SyncServer -Rebuild)
  $sync = Sync-DrillServer ([string](Split-Path -Parent ([string]$Package.tar))) ([string]$Package.version)
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $run = Invoke-DrillServerReadyNode $node ([string]$KitInfo.dir) ([string](Split-Path -Parent ([string]$Package.tar))) ([string]$Package.version) $binding
  $derived = $null
  if ($run.exit -eq 0) { try { $derived = $run.stdout | ConvertFrom-Json } catch { $derived = $null } }
  if ($null -eq $derived) { throw (New-DrillServerError $run 'DRILL_KIT_SERVER_STAND_IN_REFUSED') }
  foreach ($k in @('supabaseUrl', 'releaseFirstInstallKitSha256', 'firstInstallKitSha256')) {
    if (-not [string]::Equals([string](Get-Prop $derived $k), [string]$server[$k], [StringComparison]::Ordinal)) { throw (New-DrillError 'DRILL_KIT_SERVER_STAND_IN_REFUSED' $k) }
  }
  $server['sync'] = $sync
}

# The test project brought to production's applied list (the ruling on the PR-A report, sections 1 and 5): the database password first
# (none: nothing is asked of anyone), the sync script there (a checkout without it cannot sync), production's list from the newest
# successful release run on main (drill-server-check.mjs --production-list), then the sync script with the list, the Release's
# first-install kit (its record.scope: the project the drill's token is issued for) and drill-server.json (the pooler host) as arguments
# and the password on its standard input only. Its last line is its result (clued.drill-test-sync.result/1). Anything but in-sync stops
# here with the script's code (DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED, DRILL_SERVER_DIVERGED, DRILL_SERVER_SYNC_FAILED:<file or stage>,
# DRILL_SERVER_SYNC_TOOL_MISSING, DRILL_SERVER_UNREACHABLE, DRILL_SERVER_POOLER_HOST_NOT_SET, ...); stale (the test project holds rows the
# newest production list does not: written past the sync) is DRILL_SERVER_DIVERGED:stale. Nothing the script prints is shown with the
# password in it. Returns what the drill's receipt keeps (server.sync).
function Sync-DrillServer([string]$From, [string]$Version, [switch]$Rebuild) {
  $credential = Get-DrillCredential -ServerDatabase
  $tool = Get-DrillSyncTool
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw (New-DrillError 'DRILL_SERVER_SYNC_TOOL_MISSING' $tool) }
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  $listRun = Invoke-DrillProductionListNode $node
  $list = $null
  if ($listRun.exit -eq 0) { try { $list = $listRun.stdout | ConvertFrom-Json } catch { $list = $null } }
  if ($null -eq $list -or [string](Get-Prop $list 'file') -eq '' -or -not ((Get-Prop $list 'run') -is [ValueType])) { throw (New-DrillServerError $listRun 'DRILL_SERVER_PRODUCTION_LIST_MISSING') }
  $arguments = @($tool, '--applied', [string]$list.file, '--kit', (Join-Path $From "fleet-node-$Version.first-install-kit.json"),
    '--server', (Join-Path (Split-Path -Parent $script:DrillScriptPath) 'drill-server.json'))
  if ($Rebuild) { $arguments += '--rebuild' }
  $run = Invoke-DrillSyncNode $node $arguments $credential
  $secret = $credential.GetNetworkCredential().Password
  $clean = { param($t) ([string]$t).Replace($secret, '***') }
  $last = @(@(([string]$run.stdout) -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
  $result = $null
  if ($last.Count -eq 1) { try { $result = (& $clean $last[0]) | ConvertFrom-Json } catch { $result = $null } }
  $why = { param($t) $c = & $clean $t; $c.Substring(0, [Math]::Min(1500, $c.Length)) }
  if ($null -eq $result -or [string](Get-Prop $result 'contract') -cne 'clued.drill-test-sync.result/1') {
    throw (New-DrillError 'DRILL_SERVER_SYNC_FAILED' "no-result (exit $($run.exit)): $(& $why $run.stderr)")
  }
  $state = [string](Get-Prop $result 'state')
  if ($state -ceq 'failed') {
    if ([string](Get-Prop $result 'code') -cmatch '^(DRILL_SERVER_[A-Z_]+)(?::(.{1,400}))?$') {
      # The database's own message is on the script's standard error after its code (password masked): without it a failed row
      # names no cause. Only what follows the code is added, so a code alone stays exactly the script's code.
      $where = & $clean $Matches[2]; $echo = 'drill-test-sync: ' + [string](Get-Prop $result 'code'); $err = [string]$run.stderr; $pos = $err.IndexOf($echo)
      $cause = if ($pos -ge 0) { (& $why $err.Substring($pos + $echo.Length)).Trim() } else { '' }
      throw (New-DrillError $Matches[1] "$where $cause".Trim())
    }
    throw (New-DrillError 'DRILL_SERVER_SYNC_FAILED' "no-result: $(& $why $run.stderr)")
  }
  if ($state -ceq 'stale') { throw (New-DrillError 'DRILL_SERVER_DIVERGED' 'stale') }
  if ($state -cne 'in-sync' -or $run.exit -ne 0) { throw (New-DrillError 'DRILL_SERVER_SYNC_FAILED' "no-result: state $(& $why $state), exit $($run.exit)") }
  $at = Get-Prop $result 'production_last'
  return [ordered]@{ state = 'in-sync'; releaseRun = (Get-Prop $list 'run'); productionLast = "$(Get-Prop $at 'version')_$(Get-Prop $at 'name')"
    productionRows = (Get-Prop $result 'production_rows'); applied = (Get-Prop $result 'applied'); projectAccount = (Get-Prop $result 'fixtures.project_account') }
}
function Get-DrillSyncTool {
  if ($script:Drill.SyncTool) { return [string]$script:Drill.SyncTool }
  [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $script:DrillScriptPath) '..\..\..\apps\clued-cloud\scripts\drill-test-sync.mjs'))
}
# The two calls Sync-DrillServer makes, each its own function (a test answers in their place): production's list (gh, three tries a
# call, the host's copy for the same run), and the sync script with the password on its standard input (in no argument, no environment
# variable, no file).
function Invoke-DrillProductionListNode([string]$Node) {
  $tool = Join-Path (Split-Path -Parent $script:DrillScriptPath) 'drill-server-check.mjs'
  Invoke-DrillNode $Node @($tool, '--production-list', '--cache', [string]$script:Drill.ProductionListCache) $script:Drill.ProductionListTimeoutSeconds
}
function Invoke-DrillSyncNode([string]$Node, [string[]]$Arguments, $Credential) {
  Invoke-DrillProcess $Node $Arguments $script:Drill.SyncTimeoutSeconds @{} @('NODE_OPTIONS', 'NODE_PATH') $Credential.GetNetworkCredential().Password
}

# The one call of the server tool for a run: the kit, its Release and version as arguments, the binding's token on the tool's standard
# input (in no argument, no environment variable, no file).
function Invoke-DrillServerReadyNode([string]$Node, [string]$KitDir, [string]$From, [string]$Version, $Binding) {
  $tool = Join-Path (Split-Path -Parent $script:DrillScriptPath) 'drill-server-check.mjs'
  Invoke-DrillProcess $Node @($tool, '--ready', $KitDir, '--from', $From, '--version', $Version) 120 @{} @('NODE_OPTIONS', 'NODE_PATH') $Binding.GetNetworkCredential().Password
}

# A credential group's members as written: each key with its value (a dictionary or a parsed JSON object).
function Get-DrillCredentialMembers($Group) {
  $list = New-Object 'System.Collections.Generic.List[object]'
  if ($Group -is [Collections.IDictionary]) { foreach ($k in @($Group.Keys)) { $list.Add(@{ key = [string]$k; value = $Group[$k] }) } }
  elseif ($null -ne $Group) { foreach ($p in $Group.PSObject.Properties) { $list.Add(@{ key = [string]$p.Name; value = $p.Value }) } }
  , $list
}
# The two groups of two lists the same: in each group the same number of members, and for every member of one the member of the other with
# the same key (ordinal) holds the same string value (ordinal).
function Test-DrillCredentialGroupsEqual($A, $B) {
  foreach ($g in @('required', 'optional')) {
    $ga = Get-Prop $A $g; $gb = Get-Prop $B $g
    if ($null -eq $ga -or $null -eq $gb) { return $false }
    $x = Get-DrillCredentialMembers $ga; $y = Get-DrillCredentialMembers $gb
    if ($x.Count -ne $y.Count) { return $false }
    foreach ($m in $x) {
      $match = @($y | Where-Object { [string]::Equals($_.key, $m.key, [StringComparison]::Ordinal) })
      if ($match.Count -ne 1 -or $m.value -isnot [string] -or $match[0].value -isnot [string] -or -not [string]::Equals($match[0].value, $m.value, [StringComparison]::Ordinal)) { return $false }
    }
  }
  return $true
}

# The package's gh and Git for Windows installers in the kit, each with the hash the package's prerequisite manifest pins (Codex review of
# e0a3cded5, high 3; make-drill-kit.mjs INJECTED_TOOLS): one missing refuses the drill before any boot, by name. Both are prerequisites
# the package's bootstrap requires: the manifest declaring either not exactly once refuses too, never "nothing to check" (Codex review
# of f33fc33e5, medium 3).
function Assert-DrillKitToolsBound($KitInfo, [string]$ManifestFile) {
  $pm = Read-DrillJson $ManifestFile
  $kit = Read-DrillJson (Join-Path $KitInfo.dir 'kit.json')
  foreach ($name in @('gh', 'git-for-windows')) {
    $declared = @(@(Get-Prop $pm 'items') | Where-Object { $null -ne $_ -and [string](Get-Prop $_ 'name') -ceq $name })
    if ($declared.Count -ne 1) { throw (New-DrillError 'DRILL_PACKAGE_TOOL_NOT_DECLARED' $name) }
    $item = $declared[0]
    $in = @(@(Get-Prop $kit 'files') | Where-Object { [string](Get-Prop $_ 'path') -ceq [string](Get-Prop $item 'fileName') -and [string](Get-Prop $_ 'sha256') -ceq [string](Get-Prop $item 'sha256') })
    if ($in.Count -ne 1) { throw (New-DrillError 'DRILL_KIT_TOOL_NOT_INJECTED' $name) }
  }
}

# The kit's credential names (make-drill-kit.mjs, from the package) against the drill's decisions: what is given (and the fake file each
# is made as), what is withheld and why. Throws by name for a required name the drill cannot give or an optional one it has no decision for.
function Get-DrillCredentialPlan($Kit) {
  $c = Get-Prop $Kit 'credentials'
  $req = Get-Prop $c 'required'; $opt = Get-Prop $c 'optional'
  if ($null -eq $req -or $null -eq $opt) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'credentials') }
  $names = { param($g) @(if ($g -is [Collections.IDictionary]) { $g.Values } else { $g.PSObject.Properties | ForEach-Object { $_.Value } }) | ForEach-Object { [string]$_ } }
  # the shape (Codex review of e0a3cded5, high 2): a non-empty required group; every name a plain file name
  if (@(& $names $req).Count -eq 0) { throw (New-DrillError 'DRILL_KIT_REFUSED' 'credentials.required') }
  foreach ($n in @(@(& $names $req) + @(& $names $opt))) { if ($n -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$') { throw (New-DrillError 'DRILL_KIT_REFUSED' "credentials $n") } }
  $give = @(); $withheld = @()
  foreach ($n in @(& $names $req)) {
    $d = $script:DrillCredentialDecisions[$n]
    if ($null -eq $d -or $d.give -ne $true) { throw (New-DrillError 'DRILL_CREDENTIAL_REQUIRED_NOT_MADE' $n) }
    $give += $n
  }
  foreach ($n in @(& $names $opt)) {
    $d = $script:DrillCredentialDecisions[$n]
    if ($null -eq $d) { throw (New-DrillError 'DRILL_CREDENTIAL_OPTIONAL_UNDECIDED' $n) }
    if ($d.give -eq $true) { $give += $n } else { $withheld += [ordered]@{ name = $n; reason = $d.reason } }
  }
  [ordered]@{ given = $give; fake = @($give | ForEach-Object { $script:DrillCredentialDecisions[$_].fake }); withheld = $withheld }
}

# A generated kit binds the complete Release directory, not just the old package triple.
# Validate before touching Hyper-V; entry validates these pins again after PowerShell Direct copy.
function Get-DrillReleaseFiles($Package, $KitInfo) {
  if ($KitInfo.prerequisiteMode -cne 'first-install-host') { return @($Package.tar, $Package.acceptance, $Package.sums) }
  $pins = Read-DrillJson (Join-Path $KitInfo.dir 'release-pins.json')
  if ([string](Get-Prop $pins 'version') -cne $Package.version) { throw (New-DrillError 'DRILL_RELEASE_VERSION_MISMATCH') }
  $root = Split-Path -Parent $Package.tar; $seen = @{}; $files = @(); $inRoot = 0
  # a candidate's acceptance is the kit's (Test-DrillPackageDir), every other asset is From's
  $candidateAcceptance = if ($Package['candidate']) { [IO.Path]::GetFileName($Package.acceptance) } else { $null }
  # the server stand-in's three files are the kit's too (Read-DrillKit .server.overrides); From's own of those names stay where they are
  $overrides = Get-Prop (Get-Prop $KitInfo 'server') 'overrides'
  foreach ($f in @(Get-Prop $pins 'files')) {
    $name = [string](Get-Prop $f 'path'); $hash = [string](Get-Prop $f 'sha256')
    if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$' -or $hash -cnotmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($name)) { throw (New-DrillError 'DRILL_RELEASE_PINS_REFUSED') }
    $seen[$name] = $true
    $file = if ($null -ne $overrides -and $overrides.ContainsKey($name)) { if (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf) { $inRoot++ }; [string]$overrides[$name] }
      elseif ($name -ceq $candidateAcceptance) { $Package.acceptance } else { $inRoot++; Join-Path $root $name }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Sha256Hex $file) -cne $hash) { throw (New-DrillError 'DRILL_RELEASE_ASSET_CHANGED' $name) }
    $files += $file
  }
  foreach ($file in @($Package.tar, $Package.acceptance, $Package.sums)) {
    if (-not $seen.ContainsKey([IO.Path]::GetFileName($file))) { throw (New-DrillError 'DRILL_RELEASE_PINS_REFUSED') }
  }
  if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne $inRoot) { throw (New-DrillError 'DRILL_RELEASE_UNLISTED_ASSET') }
  return $files
}

# The prerequisites a new node needs before the first install (plan 1.2; Owner approved 11-16): the WSL package, the Ubuntu
# 24.04 WSL image and the .deb closure of docker.io, all downloaded once from their official sources into D:\clued-drill\prereq
# and pinned in prereq.json (contract clued.drill.prereq/1, one place for these pins; the kit names it by sha256). The drill
# injects them into the VM: nothing is downloaded inside the VM, so every drill starts from the same bytes.
function Read-DrillPrereq([string]$Dir) {
  $file = Join-Path $Dir 'prereq.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw (New-DrillError 'DRILL_PREREQ_MISSING') }
  $p = Read-DrillJson $file
  if ([string](Get-Prop $p 'contract') -cne $script:Drill.PrereqContract) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'contract') }
  $distro = [string](Get-Prop $p 'distribution')
  if ($distro -notmatch '^[A-Za-z][A-Za-z0-9._-]{0,63}$') { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'distribution') }
  $root = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
  $check = {
    param($f, [string]$what, [string]$suffix, [string]$urlPattern = '^https?://(github\.com/microsoft/WSL/|releases\.ubuntu\.com/|archive\.ubuntu\.com/ubuntu/|security\.ubuntu\.com/ubuntu/)')
    $rel = [string](Get-Prop $f 'path'); $want = [string](Get-Prop $f 'sha256'); $url = [string](Get-Prop $f 'url')
    if ($rel -notmatch '^[A-Za-z0-9._+~\-\\]+$' -or $rel -match '(^|\\)\.\.(\\|$)' -or -not $rel.EndsWith($suffix) -or $want -notmatch '^[0-9a-f]{64}$' -or $url -notmatch $urlPattern) {
      throw (New-DrillError 'DRILL_PREREQ_REFUSED' "$what $rel") }
    $full = [IO.Path]::GetFullPath((Join-Path $Dir $rel))
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' "$what $rel") }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw (New-DrillError 'DRILL_PREREQ_FILE_MISSING' $rel) }
    if ((Get-Sha256Hex $full) -cne $want) { throw (New-DrillError 'DRILL_PREREQ_FILE_CHANGED' $rel) }
    return $rel
  }
  $wsl = & $check (Get-Prop $p 'wsl') 'wsl' '.msi'
  $rootfs = & $check (Get-Prop $p 'rootfs') 'rootfs' '.wsl'
  $debs = @(Get-Prop $p 'debs')
  if ($debs.Count -lt 1) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'debs') }
  $debPaths = @($debs | ForEach-Object { & $check $_ 'deb' '.deb' })
  if (@($debPaths | Where-Object { $_ -notmatch '^debs\\[^\\]+$' }).Count) { throw (New-DrillError 'DRILL_PREREQ_REFUSED' 'debs live in debs\') }
  # the host's pinned installers of gh and Git for Windows (Fable renew-key ruling, supplement "after the package branch" 3, 1): injected
  # into the guest like WSL and the rootfs (make-drill-kit.mjs puts each into the kit when the Release's prerequisite manifest pins it),
  # never downloaded there; from their official releases only
  $toolPaths = @(@(Get-Prop $p 'tools') | Where-Object { $null -ne $_ } | ForEach-Object {
    $suffix = if ([string](Get-Prop $_ 'path') -like '*.msi') { '.msi' } else { '.exe' }
    & $check $_ 'tool' $suffix '^https://github\.com/(cli/cli|git-for-windows/git)/releases/download/' })
  return [ordered]@{ dir = $Dir; sha256 = (Get-Sha256Hex $file); distribution = $distro; wsl = $wsl; rootfs = $rootfs; debs = $debPaths; tools = $toolPaths; wslVersion = [string](Get-Prop $p 'wsl.version') }
}

# Inside the VM (elevated PowerShell Direct session): install the pinned WSL package, register the pinned Ubuntu image under the
# prerequisite distribution name, install the pinned .deb closure offline and confirm docker.service runs under systemd.
# Returns facts only; the host judges them. Never downloads: dpkg installs exactly the pinned files. (apt-get, even with
# --no-download, resolved against the apt lists the Ubuntu image ships and wanted archives from the network: 2026-11-16 12:58.)
$script:GuestPrereq = {
  param($Dir, $Wsl, $Rootfs, $Distro, $WslVersion, $NativeText)
  $ErrorActionPreference = 'Stop'
  $native = [scriptblock]::Create($NativeText)
  $wslExe = "$env:SystemRoot\System32\wsl.exe"
  # Every child here is read apart (Invoke-DrillNative) and kept in the facts, a refusal included: a refusal returns the facts with its
  # code in `failure` (the host writes them, then stops by that code), never a bare exception (Codex review of 58136df61, medium 3).
  # wsl's own output is UTF-16LE (the package reads wsl --version so: first-install-host.ps1); the MSI writes its log to wsl-msi.log.
  $f = [ordered]@{ failure = $null; distribution = $Distro }
  $msiLog = Join-Path $Dir 'wsl-msi.log'
  $mi = & $native "$env:SystemRoot\System32\msiexec.exe" @('/i', (Join-Path $Dir $Wsl), '/qn', '/norestart', '/L*v', $msiLog) 1800
  $f.msi = [ordered]@{ exit = $mi.exit; stdout = $mi.stdout; stderr = $mi.stderr; logTail = @(if (Test-Path -LiteralPath $msiLog -PathType Leaf) { Get-Content -LiteralPath $msiLog -Tail 40 | ForEach-Object { [string]$_ } }) }
  if ($mi.exit -notin @(0, 3010)) { $f.failure = "PREREQ_WSL_MSI_EXIT_$($mi.exit)"; return $f }
  $vr = & $native $wslExe @('--version') 120 'utf-16'
  $ver = (@($vr.stdout -split "`r?`n" | Where-Object { $_ -ne '' }) -join ' ')
  $f.wslVersion = $ver; $f.wslVersionRun = [ordered]@{ exit = $vr.exit; stderr = $vr.stderr }
  if ($WslVersion -and $ver -notmatch [regex]::Escape($WslVersion)) { $f.failure = 'PREREQ_WSL_VERSION_NOT_PINNED'; return $f }
  $ir = & $native $wslExe @('--install', '--from-file', (Join-Path $Dir $Rootfs), '--name', $Distro, '--no-launch') 1800 'utf-16'
  $f.install = [ordered]@{ exit = $ir.exit; stdout = $ir.stdout; stderr = $ir.stderr }
  if ($ir.exit -ne 0) { $f.failure = "PREREQ_DISTRO_INSTALL_EXIT_$($ir.exit)"; return $f }
  # --exec: the arguments go to env as they are (with `--` WSL runs the command line through root's shell, which split the
  # bash -c text at its | and ; - 2026-11-16 13:07). stdout and stderr apart (Invoke-DrillNative): the stdout lines are judged as data,
  # stderr is kept beside them.
  $root = { param([string]$cmd) $n = & $native $wslExe @('-d', $Distro, '-u', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C', 'LC_ALL=C', 'DEBIAN_FRONTEND=noninteractive', '/bin/bash', '-c', $cmd) 3600
    [ordered]@{ exit = $n.exit; out = @($n.stdout -split "`r?`n" | Where-Object { $_ -ne '' }); err = $n.stderr } }
  $debDir = '/mnt/' + $Dir.Substring(0, 1).ToLowerInvariant() + ($Dir.Substring(2) -replace '\\', '/') + '/debs'
  $dpkg = & $root "dpkg -i --force-confold $debDir/*.deb 2>&1 | tail -n 25; echo DPKG_EXIT=`${PIPESTATUS[0]}; echo AUDIT=`$(dpkg --audit | wc -l)"
  $dpkgExit = @($dpkg.out | Where-Object { $_ -match '^DPKG_EXIT=(\d+)$' } | ForEach-Object { [int]$Matches[1] }) | Select-Object -Last 1
  $audit = @($dpkg.out | Where-Object { $_ -match '^AUDIT=(\d+)$' } | ForEach-Object { [int]$Matches[1] }) | Select-Object -Last 1
  $facts = & $root "for i in `$(seq 1 30); do systemctl is-active --quiet docker.service && break; sleep 2; done; grep ^PRETTY_NAME /usr/lib/os-release; ps -p 1 -o comm=; systemctl is-active docker.service; dpkg-query -W -f='`${Package} `${Version}\n' docker.io containerd runc"
  $f.dpkgExit = $dpkgExit; $f.dpkgAuditLines = $audit; $f.dpkgTail = @($dpkg.out); $f.dpkgStderr = $dpkg.err; $f.facts = $facts.out; $f.factsStderr = $facts.err
  $f.dockerActive = (@($facts.out) -contains 'active'); $f.systemdPid1 = (@($facts.out) -contains 'systemd')
  $f
}

# The kit entry's arguments with the fixed guest paths in place.
function Resolve-DrillKitArguments([string[]]$Arguments, [hashtable]$Paths) {
  @($Arguments | ForEach-Object { $a = $_; if ($a -match '^\{(\w+)\}$') { [string]$Paths[$Matches[1]] } else { $a } })
}

# The kit entry's last stdout line: { status, stopCode, tree, node } (A1 reads stopCode; A8 needs tree and node).
function Read-DrillEntryResult([string[]]$Lines, [int]$ExitCode) {
  $last = @($Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -Last 1
  $doc = $null; if ($last) { try { $doc = $last | ConvertFrom-Json } catch { $doc = $null } }
  return [ordered]@{ exitCode = $ExitCode; status = [string](Get-Prop $doc 'status'); stopCode = (Get-Prop $doc 'stopCode'); tree = [string](Get-Prop $doc 'tree'); node = [string](Get-Prop $doc 'node'); parsed = ($null -ne $doc) }
}

# A property by its exact name (Get-Prop splits a path on '.', and these names are file names).
function Get-DrillField($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] }; return $null }
  $p = $Object.PSObject.Properties[$Name]; if ($null -eq $p) { return $null }; return $p.Value
}

# The first install's step record (Fable renew-key ruling, supplements "companion account and evidence" section 2.3 and "package branch,
# two points"): steps come from COMPLETE stdout logs only -- the entry's (first-install.log), the host preparation's (host.stdout.log) and
# the launcher stage's (launcher.stdout.log). A stage result file (host-result.json keeps only the last 6000 characters of the output)
# gives its verdict line and never steps, so a long record cut at its head is not read as "the earlier steps did not run": a stage that
# ran (its result file is there) without its complete log is "incomplete". A step line is one JSON object with a name (older lines: step)
# and a result, and a rejectCode when refused. Nothing parsed is "missing", never a pass; no verdict line (a run cut off) is said so.
# A stage's verdict: an object whose status is a non-empty string and not one of the package's own "no verdict" codes (bootstrap.ps1:
# STAGE_CHILD_PRINTED_NO_VERDICT -- the stage shell speaks, its child printed none -- and STAGE_GAVE_NO_VERDICT). The entry holds the
# same rule (first-install-entry.ps1 Test-EntryStageVerdict).
$script:DrillStageNoVerdictCodes = @('STAGE_CHILD_PRINTED_NO_VERDICT', 'STAGE_GAVE_NO_VERDICT')
function Test-DrillStageVerdict($Doc) {
  $s = Get-DrillField $Doc 'status'
  return ($s -is [string]) -and ($s.Length -gt 0) -and ($script:DrillStageNoVerdictCodes -cnotcontains $s)
}

function ConvertFrom-DrillFirstInstallSteps($Logs, $StageEvidence) {
  $steps = New-Object System.Collections.ArrayList
  $read = {
    param([string]$Stage, [string]$Text)
    $n = 0
    foreach ($line in @($Text -split "`r?`n")) {
      $t = $line.Trim()
      if (-not $t.StartsWith('{')) { continue }
      $o = $null
      try { $o = $t | ConvertFrom-Json } catch { continue }
      if ($o -isnot [pscustomobject]) { continue }
      $name = Get-DrillField $o 'name'
      if ($name -isnot [string]) { $name = Get-DrillField $o 'step' }
      if ($name -isnot [string] -or -not $name -or $null -eq $o.PSObject.Properties['result']) { continue }
      $reject = Get-DrillField $o 'rejectCode'
      if ($reject -isnot [string] -or -not $reject) { $reject = $null }
      # at: when the step ended, as the line itself says (the host stage's lines carry it); null when it does not. pwsh 7 reads a time
      # string as a date (Windows PowerShell 5.1 leaves it a string): then the text is taken from the line itself, the "at" string
      # of the line that reads as that same date, never the date formatted again.
      $at = Get-DrillField $o 'at'
      if ($at -is [datetime] -or $at -is [DateTimeOffset]) {
        $asRead = $at; $at = $null
        foreach ($m in [regex]::Matches($t, '"at"\s*:\s*("(?:[^"\\]|\\.)*")')) {
          $again = $null; try { $again = $m.Groups[1].Value | ConvertFrom-Json } catch { $again = $null }
          if ($null -ne $again -and $again.GetType() -eq $asRead.GetType() -and $again -eq $asRead) { $at = $m.Groups[1].Value.Substring(1, $m.Groups[1].Value.Length - 2); break }
        }
      }
      if ($at -isnot [string] -or -not $at) { $at = $null }
      [void]$steps.Add([ordered]@{ stage = $Stage; name = $name; result = $o.result; rejectCode = $reject; detail = (Get-DrillField $o 'detail'); at = $at })
      $n++
    }
    $n
  }
  $stages = [ordered]@{ entry = $null; host = $null; prepare = $null; launcher = $null }
  foreach ($stage in @('entry', 'host', 'prepare', 'launcher')) { $text = Get-DrillField $Logs $stage; if ($text -is [string]) { $stages[$stage] = & $read $stage $text } }
  # A stage ran when its result file or its log is there. It is incomplete (Codex review of 1cedea9ef, medium 2) when its log is missing
  # or empty, holds no step line (only its verdict), or ends without its verdict line -- the stage gave no verdict (cut off, a timeout):
  # what that log holds is read all the same, never taken for the whole record.
  # "The stage gave no verdict" means one thing here and in the entry (Codex review of c1497e0a1, medium 4; Test-DrillStageVerdict): a
  # missing or empty log, a last object that is no verdict, a package "no verdict" code, or the entry's own stageGaveNoVerdict.
  # prepare prints only its verdict (no step lines): it is complete when its log ends with one.
  $stageVerdicts = [ordered]@{ host = $null; launcher = $null }; $incomplete = @(); $reasons = [ordered]@{}; $noStageVerdict = @()
  foreach ($pair in @(@('host', 'host-result.json', $true), @('prepare', $null, $false), @('launcher', 'launcher-result.json', $true))) {
    $stage = $pair[0]
    $result = if ($pair[1]) { Get-DrillField $StageEvidence $pair[1] } else { $null }
    $text = Get-DrillField $Logs $stage
    if ($null -eq $result -and $text -isnot [string]) { continue }
    $why = @()
    $s = Get-DrillField (Get-DrillField $result 'terminal') 'status'
    if ($s -is [string] -and $s) { $stageVerdicts[$stage] = $s }
    if ((Get-DrillField $result 'stageGaveNoVerdict') -eq $true) { $why += 'entry-saw-no-verdict' }
    if ($text -isnot [string]) { $why += 'log-missing' }
    elseif ([string]::IsNullOrWhiteSpace($text)) { $why += 'log-empty' }
    else {
      if ($pair[2] -and $stages[$stage] -eq 0) { $why += 'no-step-lines' }
      $tail = @($text -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -Last 1
      $doc = $null; try { $doc = $tail | ConvertFrom-Json } catch { $doc = $null }
      $logVerdict = Get-DrillField $doc 'status'
      if (Test-DrillStageVerdict $doc) { }
      elseif ($logVerdict -is [string] -and $script:DrillStageNoVerdictCodes -ccontains $logVerdict) { $why += ('stage-reported-no-verdict:' + $logVerdict) }
      else { $why += 'no-verdict' }
    }
    if (@($why | Where-Object { $_ -cne 'no-step-lines' }).Count -and $noStageVerdict -notcontains $stage) { $noStageVerdict += $stage }
    if ($why.Count) { $incomplete += $stage; $reasons[$stage] = $why }
  }
  $verdict = $null
  $entryText = Get-DrillField $Logs 'entry'
  $last = if ($entryText -is [string]) { @($entryText -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -Last 1 }
  if ($last) {
    $doc = $null
    try { $doc = $last | ConvertFrom-Json } catch { $doc = $null }
    $status = Get-DrillField $doc 'status'
    if ($status -is [string] -and $status) { $verdict = [ordered]@{ status = $status; stopCode = (Get-DrillField $doc 'stopCode') } }
  }
  # Codex review of c1497e0a1, high 1: a later stage reached, or an entry that says done, says the earlier stages ran (host preparation,
  # then prepare, then the launcher stage). An earlier stage with neither its log nor its result is then incomplete too (no-evidence).
  $order = @('host', 'prepare', 'launcher')
  $ranStage = @{}
  foreach ($st in $order) { $ranStage[$st] = ($null -ne (Get-DrillField $StageEvidence ($st + '-result.json'))) -or ((Get-DrillField $Logs $st) -is [string]) }
  $entryDone = ($null -ne $verdict) -and ([string]$verdict.status -ceq 'FIRST_INSTALL_DONE')
  for ($i = 0; $i -lt $order.Count; $i++) {
    $laterRan = $entryDone
    for ($j = $i + 1; $j -lt $order.Count; $j++) { if ($ranStage[$order[$j]]) { $laterRan = $true } }
    if ($laterRan -and -not $ranStage[$order[$i]] -and $incomplete -notcontains $order[$i]) {
      $incomplete += $order[$i]; $reasons[$order[$i]] = @('no-evidence')
      # no evidence is no verdict either (Codex review of e0a3cded5, low 1)
      if ($noStageVerdict -notcontains $order[$i]) { $noStageVerdict += $order[$i] }
    }
  }
  $incomplete = @($order | Where-Object { $incomplete -contains $_ })
  $all = @($steps)
  $completed = @($all | Where-Object { $null -eq $_.rejectCode })
  $rejected = @($all | Where-Object { $null -ne $_.rejectCode })
  $lastStep = $null; $lastCompleted = $null; $firstRejected = $null
  if ($all.Count) { $lastStep = $all[$all.Count - 1].name }
  if ($completed.Count) { $lastCompleted = $completed[$completed.Count - 1].name }
  if ($rejected.Count) { $firstRejected = $rejected[0].name }
  return [ordered]@{ missing = ($all.Count -eq 0); incomplete = ($incomplete.Count -gt 0); incompleteStages = $incomplete; incompleteReasons = $reasons; noStageVerdict = $noStageVerdict; stages = $stages; steps = $all
    lastStep = $lastStep; lastCompletedStep = $lastCompleted; firstRejected = $firstRejected; verdict = $verdict; stageVerdicts = $stageVerdicts; noVerdict = ($null -eq $verdict) }
}

function Read-DrillFirstInstallSteps([string]$RunDir) {
  $text = { param($n) $p = Join-Path $RunDir $n; if (Test-Path -LiteralPath $p -PathType Leaf) { [IO.File]::ReadAllText($p) } else { $null } }
  $logs = [ordered]@{ entry = (& $text 'first-install.log'); host = (& $text 'host.stdout.log'); prepare = (& $text 'prepare.stdout.log'); launcher = (& $text 'launcher.stdout.log') }
  $stage = $null
  $evidence = Join-Path $RunDir 'stage-evidence.json'
  if (Test-Path -LiteralPath $evidence -PathType Leaf) { try { $stage = Read-DrillJson $evidence } catch { $stage = $null } }
  return ConvertFrom-DrillFirstInstallSteps $logs $stage
}

# Pure conversion. A1 is the launcher's terminal object, never an Owner-supplied success string.
function ConvertFrom-DrillInteractiveEvidence($Evidence) {
  $ok = (Get-Prop $Evidence 'fileCount') -eq 1 -and (Get-Prop $Evidence 'qualified') -eq $true -and
    (Get-Prop $Evidence 'screenshot') -eq $true -and (Get-Prop $Evidence 'tree') -and (Get-Prop $Evidence 'node')
  [ordered]@{ exitCode = $(if ($ok) { 0 } else { 1 }); status = $(if ($ok) { 'FIRST_INSTALL_DONE' } else { 'FIRST_INSTALL_STOPPED' });
    stopCode = $(if ($ok) { $null } else { 'DRILL_INTERACTIVE_EVIDENCE_NOT_COMPLETE' }); tree = [string](Get-Prop $Evidence 'tree'); node = [string](Get-Prop $Evidence 'node'); parsed = $true }
}

function Wait-DrillInteractive([string]$RunDir, $Paths, [pscredential]$Cred) {
  # Owner chooses a temporary password via secure input; it is sent as SecureString, never printed or saved.
  $password = Read-Host '为本次 VM 的 drill 交互登录设置临时口令（不记录）' -AsSecureString
  if ($password.Length -eq 0) { throw (New-DrillError 'DRILL_INTERACTIVE_PASSWORD_EMPTY') }
  Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { param($p) Set-LocalUser -Name 'drill' -Password $p } -ArgumentList $password | Out-Null
  $Cred = New-Object pscredential ('drill', $password); $password = $null
  $script:DrillInteractiveCredential = $Cred
  $command = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\drill\from\fleet-node-$($Paths.version).bootstrap.ps1 -From C:\drill\from"
  [Console]::Error.WriteLine("请在 VM 内以 drill 登录，打开普通 PowerShell，运行：$command")
  [Console]::Error.WriteLine('凭据仅在 VM 内读取 C:\drill\fake：app-key.pem、ci-admission.token、resident-upgrade.token、public.json；心跳留空点确定。关闭凭据窗口后，保存结局截图 C:\drill\work\interactive-screen.png。')
  [Console]::Error.WriteLine("全部结束（包含需要重启后重跑）再执行：New-Item C:\drill\work\interactive.done -ItemType File；等待上限 $InteractiveTimeoutMinutes 分钟，超时或取消会还原 S0。")
  Start-Process -FilePath "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList @('localhost', $script:Drill.VmName) -WindowStyle Normal | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddMinutes($InteractiveTimeoutMinutes)
  $done = $false
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Assert-DrillGuard
    # Reboot during the genuine bootstrap is expected. Do not restart/bootstrap through Direct.
    $job = $null
    try {
      $job = Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { Test-Path -LiteralPath 'C:\drill\work\interactive.done' } -AsJob -ErrorAction Stop
      $remaining = [Math]::Max(1, [Math]::Min(15, [int]($deadline - [DateTimeOffset]::UtcNow).TotalSeconds))
      if (Wait-Job -Job $job -Timeout $remaining) { $done = (Receive-Job -Job $job -ErrorAction Stop) -eq $true }
    } catch { $done = $false }
    finally { if ($job) { Stop-Job -Job $job -ErrorAction SilentlyContinue; Remove-Job -Job $job -Force -ErrorAction SilentlyContinue } }
    if ($done) { break }
    Start-Sleep -Seconds 5
  }
  if (-not $done) { throw (New-DrillError 'DRILL_INTERACTIVE_TIMEOUT') }
  $observed = Invoke-DrillGuest $Cred {
    param($assets, $version)
    . (Join-Path $assets "fleet-node-$version.bootstrap.ps1") -From $assets
    $files = @(Get-ChildItem -Path 'C:\ProgramData\CluedBootstrap\*\elevated-launcher-*.txt' -File)
    $treePath = ''; $nodePath = ''; $terminal = $null; $qualified = $false; $source = ''; $text = ''
    if ($files.Count -eq 1) {
      $source = $files[0].FullName; $text = [IO.File]::ReadAllText($source); $terminal = Get-LastJsonLine $text
      $qualified = (Get-LauncherVerdict $true $terminal).status -ceq 'BOOTSTRAP_DONE'
      $treePath = Join-Path $files[0].DirectoryName 'x\tree'
      $js = New-Object Web.Script.Serialization.JavaScriptSerializer
      $pm = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path $assets "fleet-node-$version.prereq-manifest.json")))
      $nodePin = @($pm['items'] | Where-Object { $_['name'] -ceq 'node' })
      if ($nodePin.Count -eq 1) {
        $nodes = @(Get-ChildItem -Path (Join-Path $WorkParent ('tools\node-' + $nodePin[0]['sha256'])) -Recurse -Filter node.exe)
        if ($nodes.Count -eq 1) { $nodePath = $nodes[0].FullName }
      }
      if (-not (Test-Path -LiteralPath (Join-Path $treePath 'work\independent-ci-resident-v1\rollout\fleet\install.mjs'))) { $treePath = '' }
    }
    $screen = 'C:\drill\work\interactive-screen.png'; $png = $false
    if (Test-Path -LiteralPath $screen -PathType Leaf) {
      $stream = [IO.File]::OpenRead($screen)
      try { $header = New-Object byte[] 8; $png = $stream.Read($header, 0, 8) -eq 8 -and [BitConverter]::ToString($header) -ceq '89-50-4E-47-0D-0A-1A-0A' } finally { $stream.Dispose() }
    }
    [ordered]@{ fileCount = $files.Count; source = $source; text = $text; terminal = $terminal; qualified = $qualified;
      tree = $treePath; node = $nodePath; screenshot = $png }
  } -ArgumentList @($Paths.from, $Paths.version) -TimeoutMinutes 2 -Step 'interactive-evidence'
  Write-DrillJson (Join-Path $RunDir 'interactive-launcher.json') $observed
  if ($observed.screenshot) {
    $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
    try { Copy-Item -LiteralPath 'C:\drill\work\interactive-screen.png' -Destination (Join-Path $RunDir 'interactive-screen.png') -FromSession $session }
    finally { Remove-PSSession -Session $session }
  }
  return @{ entry = (ConvertFrom-DrillInteractiveEvidence $observed); launcher = $observed.terminal; credential = $Cred }
}

function New-DrillItem([string]$Id, $Pass, [string]$Detail) { [ordered]@{ id = $Id; pass = $Pass; detail = $Detail } }

function Test-DrillReinstallLauncher($Reinstall) {
  $exitCode = Get-Prop $Reinstall 'launcherExit'
  return ($exitCode -is [int]) -and ($exitCode -eq 0) -and ((Get-Prop $Reinstall 'launcherVerdict') -ceq 'BOOTSTRAP_DONE')
}

# The phase-A verdict (plan section 3) from what the drill read in the guest. pass: $true, $false, or $null (not judged here:
# A5's production half and A9 are judged by -Finalize from the production read-back).
#   $E: entry (Read-DrillEntryResult), launcher (the launcher's terminal), pause (state\PAUSED.json: sha256, requestSha256),
#       verify (@{status}), status (status.json), current (upgrade\current.json), facts (version-facts.json), acceptanceSource,
#       now (DateTimeOffset), reboot (@{ok, status, readAt, boot}), reinstall (@{skipped, ...}), skipReinstall (the option given), kit,
#       firstInstallSteps (Read-DrillFirstInstallSteps)
function Get-DrillVerdict($E) {
  $items = New-Object System.Collections.ArrayList
  $now = [DateTimeOffset]$E.now
  $entry = $E.entry
  # A1 needs the step record (Read-DrillFirstInstallSteps, read before this verdict): a first install whose steps cannot be shown -- none
  # parsed, or a stage that ran without its complete log -- does not pass, and the detail says why (Codex review of 1cedea9ef, high 1;
  # branch one 74e7a65e7 holds the same).
  [void]$items.Add((Get-DrillA1Item $entry (Get-Prop $E 'firstInstallSteps') (Get-Prop $E 'failureSnapshot')))
  $vs = [string](Get-Prop $E.verify 'status')
  [void]$items.Add((New-DrillItem 'A2' ($vs -ceq 'RESIDENT_VERIFIED') "verify=$vs"))
  [void]$items.Add((Test-DrillSelfcheck 'A3' $E.status $now))
  # A4: both halves on the same package (upgrade-mailbox.mjs#consistent) and a settled first generation.
  $c = $E.current; $f = $E.facts
  $a4 = ($null -ne $c) -and ($null -ne $f) -and (Get-Prop $f 'generation') -eq 1 -and (Get-Prop $c 'generation') -eq 1 -and $null -eq (Get-Prop $f 'staged') -and (Get-Prop $f 'pinsOk') -eq $true `
    -and [string](Get-Prop $f 'ciSourceManifestSha256') -ceq [string](Get-Prop $c 'ciSourceManifestSha256') -and [string](Get-Prop $f 'manifestSha256') -ceq [string](Get-Prop $c 'linux.manifestSha256') `
    -and (Get-Prop $f 'manifestSha256') -match '^[0-9a-f]{64}$'
  [void]$items.Add((New-DrillItem 'A4' $a4 "facts.generation=$(Get-Prop $f 'generation') staged=$(Get-Prop $f 'staged') pinsOk=$(Get-Prop $f 'pinsOk')"))
  $local = [string](Get-Prop $c 'ciSourceManifestSha256')
  $a5 = ($local -match '^[0-9a-f]{64}$') -and $local -ceq [string]$E.acceptanceSource
  # a candidate (Fable ruling 11-19 renew-key section 4.3) has no production half: A5 is the guest's Source against the request's, here
  if ((Get-Prop $E 'candidate') -eq $true) { [void]$items.Add((New-DrillItem 'A5' $a5 "local=$local acceptance=$($E.acceptanceSource); candidate: no production half")) }
  else { [void]$items.Add((New-DrillItem 'A5' $(if ($a5) { $null } else { $false }) "local=$local acceptance=$($E.acceptanceSource); production half by -Finalize")) }
  # A6 (Fable renew-key ruling, supplement "eight on the path", item 5): a successful launcher ends with its own pause confirmed, so the
  # node holds THAT pause: the request the launcher's terminal confirmed (pause.requestSha256, the one source) is the one state\PAUSED.json
  # names, the status says paused and the executor rests PAUSED, with no current batch, live 0 and no HALT. Idle is no pass.
  $s = $E.status
  $want = [string](Get-Prop $E.launcher 'pause.requestSha256'); $held = [string](Get-Prop $E.pause 'requestSha256')
  $ownPause = ((Get-Prop $E.launcher 'pause.confirmed') -eq $true) -and ($want -cmatch '^[0-9a-f]{64}$') -and ($held -ceq $want)
  # The role is a confirmed one (FABLE-drill-role-probe-20261124.md, PR-3): the drill binding holds no role in the drill's server, so the
  # launcher's probe is answered not-held, its first train is not applicable, and the node rests STANDBY. UNCERTAIN (the probe refused or
  # unanswered: the drill would be talking to a server that does not know its token) is no pass, and neither is holding the slot.
  $role = [string](Get-Prop $E.launcher 'role'); $done = @(Get-Prop $E.launcher 'completed' | ForEach-Object { [string]$_ })
  $noRole = ($role -ceq 'not-held') -and ($done -ccontains 'first-train-not-applicable') -and ([string](Get-Prop $s 'node.mode') -ceq 'STANDBY')
  $a6 = $ownPause -and $noRole -and ((Get-Prop $s 'paused') -eq $true) -and ([string](Get-Prop $s 'executor.state') -ceq 'PAUSED') `
    -and ($null -eq (Get-Prop $s 'current')) -and ((Get-Prop $s 'queue.live') -eq 0) -and ($null -eq (Get-Prop $s 'halt'))
  [void]$items.Add((New-DrillItem 'A6' $a6 "pause=$held confirmedByLauncher=$want paused=$(Get-Prop $s 'paused') executor=$(Get-Prop $s 'executor.state') mode=$(Get-Prop $s 'node.mode') role=$role firstTrainNotApplicable=$($done -ccontains 'first-train-not-applicable') current=$($null -ne (Get-Prop $s 'current')) live=$(Get-Prop $s 'queue.live') halt=$(Get-Prop $s 'halt.code')"))
  # A7: the status rewritten after this boot, and a self-check that passed, is fresh AND was observed after this boot (never the boot before's).
  $r = $E.reboot
  if ($null -eq $r) { [void]$items.Add((New-DrillItem 'A7' $false 'not run')) }
  elseif ((Get-Prop $r 'skipped') -eq $true) { [void]$items.Add((New-DrillItem 'A7' $false ([string](Get-Prop $r 'reason')))) }
  else {
    $sc = Test-DrillSelfcheck 'A7' $r.status ([DateTimeOffset]$r.readAt)
    $scAfter = Test-DrillAfterBoot ([string](Get-Prop $r.status 'versions.selfcheck.observedAt')) ([string](Get-Prop $r 'boot'))
    $cab = Test-DrillCompanionAfterBoot (Get-Prop $r 'companionAfterBoot') ([string](Get-Prop $r 'boot'))   # K3: the companion up by itself
    [void]$items.Add((New-DrillItem 'A7' ([bool]$r.ok -and $sc.pass -and $scAfter -and $cab.pass) "refreshedAfterBoot=$($r.ok) selfcheckAfterBoot=$scAfter boot=$(Get-Prop $r 'boot') $($sc.detail) $($cab.detail)"))
  }
  # A8: the operator's choice (-SkipReinstall, $E.skipReinstall) and the run's A8 result reach here apart (Codex review of 58136df61,
  # medium 2). Only the choice, with a result that says skipped, is "skipped"; no result, or a skip nobody chose, is FAIL.
  $ri = $E.reinstall
  $chosen = (Get-Prop $E 'skipReinstall') -eq $true
  $saysSkipped = (Get-Prop $ri 'skipped') -eq $true
  if ($chosen -and $saysSkipped) { [void]$items.Add((New-DrillItem 'A8' $null 'skipped (-SkipReinstall): same-package reinstall not drilled (同包重装未演练)')) }
  elseif ($null -eq $ri) { [void]$items.Add((New-DrillItem 'A8' $false 'no A8 result: the run handed none over')) }
  elseif ($saysSkipped) { [void]$items.Add((New-DrillItem 'A8' $false 'the A8 result says skipped, but the run was not started with the skip option')) }
  elseif ($chosen) { [void]$items.Add((New-DrillItem 'A8' $false 'started with the skip option, but an A8 result came back')) }
  else {
    $a8 = ([string]$ri.upgradeStatus -ceq 'FLEET_NODE_ALREADY_AT_THIS_PACKAGE') -and ([string]$ri.prepareStatus -ceq 'FLEET_NODE_INSTALL_PREPARED') `
      -and (Test-DrillReinstallLauncher $ri) -and [bool]$ri.reverifyPassed -and ([string]$ri.prepareAgainStatus -ceq 'FLEET_NODE_INSTALL_PREPARED')
    [void]$items.Add((New-DrillItem 'A8' $a8 "upgrade=$($ri.upgradeStatus) prepare=$($ri.prepareStatus) launcher=$(Get-Prop $ri 'launcherVerdict') launcherStatus=$(Get-Prop $ri 'launcherStatus') launcherExit=$(Get-Prop $ri 'launcherExit') reverify=$($ri.reverifyPassed) prepareAgain=$($ri.prepareAgainStatus)"))
  }
  [void]$items.Add((New-DrillItem 'A9' $null 'production read-back by -Finalize'))
  $steps = @($E.kit.perNodeSteps)
  # A malformed/edited adapted kit cannot erase the shell exception by clearing perNodeSteps.
  if ([string](Get-Prop $E.kit 'prerequisiteMode') -ceq 'first-install-host') {
    $steps = @($steps) + @('adapted drill: non-elevated check, RunAs and credential dialogs not validated')
  }
  [void]$items.Add((New-DrillItem 'A10' ($steps.Count -eq 0) $(if ($steps.Count) { 'per-node steps: ' + ($steps -join ' | ') } else { 'one command, no node value' })))
  return ,$items.ToArray()
}

# $At (a status or self-check time) later than $Boot (this boot); either missing or unreadable is not later.
function Test-DrillAfterBoot([string]$At, [string]$Boot) {
  if (-not $At -or -not $Boot) { return $false }
  try { return [DateTimeOffset]::Parse($At, [Globalization.CultureInfo]::InvariantCulture) -gt [DateTimeOffset]::Parse($Boot, [Globalization.CultureInfo]::InvariantCulture) } catch { return $false }
}

# A1 on its own: the entry's result and the step record. Also formed when the run stops after the first install (Codex review of
# e0a3cded5, medium 1), so a verdict the first install gave is never lost with the run.
# $Snapshot: the entry's failure snapshot when the run brought one home (Read-DrillFailureSnapshot): the detail then names what halted
# the resident (HALT.json's code, its facts' failureCode and engineError), or says the snapshot holds no HALT.json.
function Get-DrillA1Item($Entry, $Steps, $Snapshot = $null) {
  $stepsWhy = if ($null -eq $Steps -or (Get-Prop $Steps 'missing') -ne $false) { 'steps=missing' } elseif ((Get-Prop $Steps 'incomplete') -ne $false) { 'steps=incomplete:' + (@(Get-Prop $Steps 'incompleteStages') -join ',') } else { 'steps=complete' }
  $a1 = ($null -ne $Entry) -and (Get-Prop $Entry 'parsed') -eq $true -and (Get-Prop $Entry 'exitCode') -eq 0 -and $null -eq (Get-Prop $Entry 'stopCode') -and [string](Get-Prop $Entry 'status') -ceq 'FIRST_INSTALL_DONE' -and $stepsWhy -ceq 'steps=complete'
  $detail = if ($null -eq $Entry) { "no entry result $stepsWhy" } else { "exit=$(Get-Prop $Entry 'exitCode') status=$(Get-Prop $Entry 'status') stopCode=$(Get-Prop $Entry 'stopCode') $stepsWhy" }
  if ($null -ne $Snapshot) { $detail += ' ' + (Get-DrillSnapshotHaltSummary $Snapshot) }
  New-DrillItem 'A1' $a1 $detail
}

# The resident's HALT as the failure snapshot holds it, in one line. Only code-shaped values are repeated; anything else is named "other".
function Get-DrillSnapshotHaltSummary($Snapshot) {
  $file = @(@(Get-DrillField $Snapshot 'files') | Where-Object { [string](Get-DrillField $_ 'pattern') -ceq 'resident\state\HALT.json' -and [string](Get-DrillField $_ 'state') -ceq 'read' }) | Select-Object -First 1
  if ($null -eq $file) { return 'halt=none' }
  $halt = $null
  try { $halt = [string](Get-DrillField $file 'text') | ConvertFrom-Json } catch { $halt = $null }
  if ($null -eq $halt) { return 'halt=unreadable' }
  $word = { param($v) if ($null -eq $v) { 'null' } elseif ($v -is [string] -and $v -cmatch '^[A-Z][A-Z0-9_:]{0,119}$') { $v } else { 'other' } }
  $facts = Get-DrillField $halt 'facts'
  "halt=$(& $word (Get-DrillField $halt 'code')) failureCode=$(& $word (Get-DrillField $facts 'failureCode')) engineError=$(& $word (Get-DrillField $facts 'engineError'))"
}
function Read-DrillFailureSnapshot([string]$RunDir) {
  $file = Join-Path $RunDir 'resident-failure-snapshot.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  try { return Read-DrillJson $file } catch { return $null }
}

function Test-DrillSelfcheck([string]$Id, $Status, [DateTimeOffset]$Now) {
  $sc = Get-Prop $Status 'versions.selfcheck'
  $result = [string](Get-Prop $sc 'result'); $at = [string](Get-Prop $sc 'observedAt')
  $fresh = $false
  if ($at) { try { $age = $Now - [DateTimeOffset]::Parse($at, [Globalization.CultureInfo]::InvariantCulture); $fresh = $age.TotalMinutes -le $script:Drill.SelfcheckFreshMinutes -and $age.TotalSeconds -ge -30 } catch { $fresh = $false } }
  return (New-DrillItem $Id (($result -ceq 'PASS') -and $fresh) "selfcheck=$result observedAt=$at")
}

# Overall: FAIL if any required item is missing or a core item failed, or M5 (the renewal observations) is not PASS; PASS_A when
# A1-A9 hold and M5 passed; PENDING_PRODUCTION_READBACK while the read-back (-Finalize) has not been judged. The three PASS values are the
# set publish.mjs seal --drill-receipt takes (test/drill-vm-part1.test.mjs holds them equal); a candidate is shown to the Owner only after its
# -Finalize (Fable renew-key ruling section 4.3: drill -> -Finalize -> accept -> seal). M5 has no "not evaluated" exit (section 2.2): a package
# without the renewal leaves its observations missing and fails here; NOT_EVALUATED only marks a run that stopped before M5 was read.
# A candidate (its receipt is what the Owner's acceptance and seal rest on): each of A1-A7 must be true, and A8 true unless the run chose
# to skip it (-SkipReinstall, an explicit option, never the default; Fable renew-key ruling, supplement "candidate skips A8"). A candidate
# that skipped A8 ends in its own value, PASS_A_REINSTALL_NOT_DRILLED, never in the two others (Codex review of PR-甲, blocking 1: a skipped
# candidate must not look like a full one; the value tells them apart, in the receipt and in the index seal writes). It is reported even
# when per-node steps remain too (the larger gap; A10's detail still names them). An accepted version's re-drill keeps "skipped" as the
# diagnosis it was.
# The items that make the conclusion FAIL, in order (A1..A10, then M5): a missing item, a core item that failed, for a candidate any of
# A1-A8 not true (A8 skipped by choice excepted), and M5 not PASS. Empty: no item fails. Get-DrillConclusion's FAIL is exactly "not empty",
# and the run's summary line names them (Get-DrillRunSummary): one rule for both.
function Get-DrillFailedItems($Items, $M5, [bool]$Candidate = $false) {
  $byId = @{}; foreach ($i in $Items) { $byId[[string]$i.id] = $i }
  $core = @('A1','A2','A3','A4','A5','A6','A7','A8','A9')
  $a8Skipped = $byId.ContainsKey('A8') -and $null -eq $byId['A8'].pass -and [string]$byId['A8'].detail -match '^skipped'
  $failed = @()
  foreach ($id in ($core + 'A10')) {
    if (-not $byId.ContainsKey($id)) { $failed += $id; continue }
    if ($core -ccontains $id -and $byId[$id].pass -eq $false) { $failed += $id; continue }
    if ($Candidate -and $id -cne 'A9' -and $id -cne 'A10' -and $byId[$id].pass -ne $true -and -not ($id -eq 'A8' -and $a8Skipped)) { $failed += $id }
  }
  if ([string](Get-Prop $M5 'result') -cne 'PASS') { $failed += 'M5' }
  $failed   # unrolled: the callers collect it with @()
}

function Get-DrillConclusion($Items, $M5, [bool]$Candidate = $false) {
  if (@(Get-DrillFailedItems $Items $M5 $Candidate).Count) { return 'FAIL' }
  $byId = @{}; foreach ($i in $Items) { $byId[$i.id] = $i }
  $core = @('A1','A2','A3','A4','A5','A6','A7','A8','A9')
  $a8Skipped = $null -eq $byId['A8'].pass -and [string]$byId['A8'].detail -match '^skipped'
  if (@($core | Where-Object { $null -eq $byId[$_].pass -and $byId[$_].detail -notmatch '^skipped' }).Count) { return 'PENDING_PRODUCTION_READBACK' }
  if ($Candidate -and $a8Skipped) { return 'PASS_A_REINSTALL_NOT_DRILLED' }
  if ($byId['A10'].pass) { return 'PASS_A_FULL' }
  return 'PASS_A_PER_NODE_STEPS_REMAIN'
}

# Fable ruling 11-20 "first install r4" section 5(b) (E5): the summary line of a run says why it failed, from the receipt just written
# (nothing judged again). failedItems: Get-DrillFailedItems of its items and m5; reason: the first one as <id>:<code> -- A1 from its step
# record (<first rejected step>:<its rejectCode>; without a rejected step its detail), M5 from its detail, any other item from its detail.
# Both empty for a conclusion that is not FAIL. The reason names product items only; the run's code keeps its meaning (the drill machine's
# own failure only), and a checkpoint restore not confirmed is one: DRILL_RESTORE_NOT_CONFIRMED is the run's code, never a reason (Fable
# ruling 11-20 "r4 E2-E5 ambiguities" item 3; read code first, then reason). A FAIL always has a code or a reason.
function Get-DrillRunSummary($Receipt) {
  if ([string](Get-Prop $Receipt 'conclusion') -cne 'FAIL') { return [ordered]@{ failedItems = @(); reason = $null } }
  $items = @(Get-Prop $Receipt 'items'); $m5 = Get-Prop $Receipt 'm5'
  $failed = @(Get-DrillFailedItems $items $m5 ((Get-Prop $Receipt 'candidate') -eq $true))
  $reason = $null
  if ($failed.Count) {
    $id = $failed[0]
    $item = @($items | Where-Object { [string]$_.id -ceq $id }) | Select-Object -First 1
    if ($id -ceq 'M5') { $reason = 'M5:' + [string](Get-Prop $m5 'detail') }
    elseif ($null -eq $item) { $reason = $id + ':missing' }
    elseif ($id -ceq 'A1') {
      $steps = Get-Prop $item 'firstInstallSteps'
      $rejected = @(@(Get-Prop $steps 'steps') | Where-Object { $null -ne $_ -and $null -ne (Get-Prop $_ 'rejectCode') }) | Select-Object -First 1
      $reason = if ($rejected) { 'A1:' + [string](Get-Prop $rejected 'name') + ':' + [string](Get-Prop $rejected 'rejectCode') } else { 'A1:' + [string](Get-Prop $item 'detail') }
    } else { $reason = $id + ':' + [string](Get-Prop $item 'detail') }
  }
  [ordered]@{ failedItems = $failed; reason = $reason }
}

# The production read-back (one read-only query after the drill, by DESK; plan 2.3/A9). The SQL is carried in the receipt.
function Get-DrillReadbackSql([string]$StartedAt) {
  if ($StartedAt -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$') { throw (New-DrillError 'DRILL_STARTED_AT_REFUSED') }
  @"
select
 (select count(*) from clued_private.ci_nodes_v1 where created_at >= '$StartedAt' or updated_at >= '$StartedAt') as nodes_changed,
 (select count(*) from clued_private.ci_failover_members_v1 where marked_at >= '$StartedAt') as failover_marked,
 (select count(*) from clued_private.binding_roles_v1 where granted_at >= '$StartedAt' or revoked_at >= '$StartedAt') as roles_changed,
 (select count(*) from public.clued_agent_bindings where created_at >= '$StartedAt') as bindings_created,
 (select count(*) from clued_private.ci_node_liveness_v1 l join clued_private.ci_nodes_v1 n using (node_id) where n.name ilike '%drill%') as drill_liveness,
 (select coalesce(jsonb_agg(distinct l.reported_source_sha256), '[]'::jsonb) from clued_private.ci_node_liveness_v1 l where l.last_heartbeat_at >= now() - interval '24 hours') as live_sources;
"@
}

# A5's production half and A9 from the read-back row. nodes_changed counts every touch of ci_nodes_v1 (heartbeats of the
# in-service nodes do not write it: they write ci_node_liveness_v1), so any non-zero count is looked at, never ignored.
# A candidate's receipt (candidate: true) is read back right after its drill, before the Owner accepts, and judged on A9 alone: what
# A5's production half guarded against (the drilled package is not the one the fleet runs) is held by seal (the receipt's three hashes
# are the acceptance's) and by every node recomputing the Source of the accepted Release it installs (Fable renew-key section 4.3).
function Get-DrillProductionVerdict($Receipt, $Readback) {
  if ([string](Get-Prop $Readback 'contract') -cne $script:Drill.ReadbackContract) { throw (New-DrillError 'DRILL_READBACK_REFUSED' 'contract') }
  if ([string](Get-Prop $Readback 'startedAt') -cne [string](Get-Prop $Receipt 'startedAt')) { throw (New-DrillError 'DRILL_READBACK_NOT_THIS_DRILL') }
  $row = Get-Prop $Readback 'row'
  $counts = [ordered]@{}
  foreach ($k in @('nodes_changed','failover_marked','roles_changed','bindings_created','drill_liveness')) {
    $v = Get-Prop $row $k
    if (-not ($v -is [int] -or $v -is [long])) { throw (New-DrillError 'DRILL_READBACK_REFUSED' $k) }
    $counts[$k] = [long]$v
  }
  $a9 = @($counts.Values | Where-Object { $_ -ne 0 }).Count -eq 0
  if ((Get-Prop $Receipt 'candidate') -eq $true) { return @((New-DrillItem 'A9' $a9 (($counts.Keys | ForEach-Object { "$_=$($counts[$_])" }) -join ' '))) }
  $sources = @(Get-Prop $row 'live_sources' | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
  $local = [string](Get-Prop $Receipt 'evidence.localSource')
  $a5 = $sources.Count -ge 1 -and @($sources | Where-Object { $_ -cne $local }).Count -eq 0
  return @(
    (New-DrillItem 'A5' $a5 "local=$local production=$($sources -join ',')"),
    (New-DrillItem 'A9' $a9 (($counts.Keys | ForEach-Object { "$_=$($counts[$_])" }) -join ' '))
  )
}

# ---------------------------------------------------------------- guest-side fake credentials (Windows PowerShell 5.1 in the VM)
# Generates, inside the VM, the upgrade token and an RSA App key nobody registered, and prints only public values. The CI token is not
# made up: it is the Owner's drill binding in the drill's server ($Binding, a PSCredential: the connection id and the token, from
# Get-DrillCredential -Binding over the PowerShell Direct session), written as it is; asked for without one, nothing is written in its
# place (a made-up token is one no server knows: the 17th candidate's drill).
# Fingerprints use the package's formulas (tools/secret-fingerprint.mjs; the offline test cross-checks them).
function New-DrillFakeCredentials {
  # $Make: the fake files to write (Get-DrillCredentialPlan .fake): none other is made
  param([string]$OutDir, [string[]]$Make, $Binding)   # in the body: the guest receives this function as a script block, which keeps only the body
  $ErrorActionPreference = 'Stop'
  if ($null -eq $Make) { throw 'FAKE_CREDENTIALS_NAMES_REQUIRED' }
  if ($Make -contains 'ci-admission.token' -and $Binding -isnot [System.Management.Automation.PSCredential]) { throw 'FAKE_CREDENTIALS_BINDING_REQUIRED' }
  if (Test-Path -LiteralPath $OutDir) { throw 'FAKE_CREDENTIALS_DIR_EXISTS' }
  New-Item -ItemType Directory -Path $OutDir | Out-Null
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $b64url = { param([byte[]]$b) [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  $sha = { param([byte[]]$b) $h = [System.Security.Cryptography.SHA256]::Create(); try { $h.ComputeHash($b) } finally { $h.Dispose() } }
  $hex = { param([byte[]]$b) -join ($b | ForEach-Object { $_.ToString('x2') }) }
  $token = { $r = New-Object byte[] 32; $rng.GetBytes($r); 'clued_bnd_' + (& $b64url $r) }
  $pin = { param([string]$t) & $hex (& $sha ([Text.Encoding]::UTF8.GetBytes("clued.independent-ci.ci-binding-pin/1`0" + $t))) }
  $derLen = { param([int]$n) if ($n -lt 128) { ,([byte[]]@($n)) } else { $l = New-Object System.Collections.Generic.List[byte]; while ($n -gt 0) { $l.Insert(0, [byte]($n -band 0xff)); $n = $n -shr 8 }; $l.Insert(0, [byte](0x80 + $l.Count)); ,($l.ToArray()) } }
  $tlv = { param([byte]$tag, [byte[]]$v) $o = New-Object System.Collections.Generic.List[byte]; $o.Add($tag); $o.AddRange([byte[]](& $derLen $v.Length)); $o.AddRange($v); ,($o.ToArray()) }
  $int = { param([byte[]]$v) $i = 0; while ($i -lt $v.Length - 1 -and $v[$i] -eq 0) { $i++ }; $v = [byte[]]$v[$i..($v.Length - 1)]; if ($v[0] -band 0x80) { $v = [byte[]](@([byte]0) + $v) }; & $tlv 0x02 $v }
  $seq = { param($parts) $o = New-Object System.Collections.Generic.List[byte]; foreach ($p in $parts) { $o.AddRange([byte[]]$p) }; & $tlv 0x30 $o.ToArray() }
  $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 2048
  try { $k = $rsa.ExportParameters($true) } finally { $rsa.Dispose() }
  $pkcs1 = & $seq @((& $int ([byte[]]@(0))), (& $int $k.Modulus), (& $int $k.Exponent), (& $int $k.D), (& $int $k.P), (& $int $k.Q), (& $int $k.DP), (& $int $k.DQ), (& $int $k.InverseQ))
  $rsaPub = & $seq @((& $int $k.Modulus), (& $int $k.Exponent))
  $algo = & $seq @(([byte[]](0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01)), ([byte[]](0x05, 0x00)))
  $spki = & $seq @($algo, (& $tlv 0x03 ([byte[]](@([byte]0) + $rsaPub))))
  $b64 = [Convert]::ToBase64String($pkcs1)
  $pemFence = '-----'
  $pemLabel = 'RSA PRIVATE KEY'
  $pemBody = ($b64 -split '(.{64})' | Where-Object { $_ }) -join "`n"
  $pem = "{0}BEGIN {1}{0}`n{2}`n{0}END {1}{0}`n" -f $pemFence, $pemLabel, $pemBody
  $up = & $token
  # with no binding (a package that names no CI token) the public record's pin and id are of a token written nowhere
  $ci = if ($null -ne $Binding) { $Binding.GetNetworkCredential().Password } else { & $token }
  $enc = New-Object System.Text.UTF8Encoding $false
  if ($Make -contains 'ci-admission.token') { [IO.File]::WriteAllText((Join-Path $OutDir 'ci-admission.token'), $ci, $enc) }
  if ($Make -contains 'resident-upgrade.token') { [IO.File]::WriteAllText((Join-Path $OutDir 'resident-upgrade.token'), $up, $enc) }
  if ($Make -contains 'app-key.pem') { [IO.File]::WriteAllText((Join-Path $OutDir 'app-key.pem'), $pem, $enc) }
  # The companion GitHub classic token stand-in (Fable renew-key ruling, supplement "token pending" 1C), made only when the drilled package
  # requires it ($Make, Get-DrillCredentialPlan): the shape of a classic token (ghp_ and 36 letters or digits), fake at a glance
  # (CLUEDDRILLFAKE), made and read in the guest only; GitHub refuses it.
  $gh = $null
  if ($Make -contains 'companion-github.token') {
    $alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $r22 = New-Object byte[] 22; $rng.GetBytes($r22)
    $gh = 'ghp_CLUEDDRILLFAKE' + (-join ($r22 | ForEach-Object { $alnum[$_ % 62] }))
    [IO.File]::WriteAllText((Join-Path $OutDir 'companion-github.token'), $gh, $enc)
  }
  $public = [ordered]@{
    contract = 'clued.drill.fake-credentials/1'
    note = 'the upgrade token and the App key are generated inside the drill VM and registered nowhere; the CI token is the drill binding of the drill server (no role there)'
    ciPrincipalBindingId = $(if ($null -ne $Binding) { [string]$Binding.UserName } else { [guid]::NewGuid().ToString() })
    ciPrincipalRoleRef = [guid]::NewGuid().ToString()
    ciPrincipalQualificationRef = [guid]::NewGuid().ToString()
    ciTokenPinSha256 = (& $pin $ci)
    upgradeTokenFingerprint = (& $pin $up)
    appKeyId = 1
    appPublicKeySha256Base64 = [Convert]::ToBase64String((& $sha $spki))
    files = [ordered]@{}
  }
  # the files this run made, and only they
  foreach ($pair in @(@('ciToken', 'ci-admission.token'), @('upgradeToken', 'resident-upgrade.token'), @('appKey', 'app-key.pem'), @('companionGithubToken', 'companion-github.token'))) {
    if ($Make -contains $pair[1]) { $public.files[$pair[0]] = $pair[1] }
  }
  if ($Make -contains 'public.json') { [IO.File]::WriteAllText((Join-Path $OutDir 'public.json'), ($public | ConvertTo-Json -Depth 4), $enc) }
  $ci = $null; $up = $null; $pem = $null; $gh = $null
  return $public
}

# The receipt's record of the host's memory and runner jobs, raw facts only (Fable renew-key ruling, supplements "drill boot gate and the
# train both want DESK" and "contention label stop-loss"): free before boot (the boot gate's reading) and the tier it required; the runner
# jobs at boot on both sides, yes, no or unknown (a side not read, no job confirmed), and what the gate saw; free once the guest
# was up (the running guard's first reading), the lowest while running, and the lowest of the whole run (the boot gate and every running
# reading). No classification: what a time-out with a job at boot means is the operator's call (drill/FIRST-INSTALL-KIT.md).
function Get-DrillHostMemoryEvidence($PreBoot, $RunningMemory) {
  $before = Get-Prop $PreBoot 'bootGate.freeGB'; $after = Get-Prop $RunningMemory 'afterBootFreeGB'; $minRunning = Get-Prop $RunningMemory 'minRunningFreeGB'
  $all = @(@($before, $minRunning) | Where-Object { $null -ne $_ })
  [ordered]@{ beforeBootFreeGB = $before; requiredFreeGB = (Get-Prop $PreBoot 'bootGate.requiredFreeGB')
    runnerJobAtBoot = (Get-Prop $PreBoot 'bootGate.runnerJob'); runnerJobBefore = (Get-Prop $PreBoot 'bootGate.busyWith')
    afterBootFreeGB = $after; minRunningFreeGB = $minRunning
    lowestFreeGB = $(if ($all.Count) { ($all | Measure-Object -Minimum).Minimum } else { $null }) }
}

# A8's upgrade, as it came back (exit, stdout, stderr), with the status and code of its last JSON line beside it: raw facts, kept by the host
# in reinstall-upgrade.json before the prepare starts, and carried by the receipt (evidence.reinstallUpgrade) whatever the run's end.
function ConvertTo-DrillReinstallUpgradeRecord($UpRun) {
  $stdout = [string](Get-Prop $UpRun 'stdout')
  $line = @($stdout -split "`r?`n" | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
  $doc = $null; if ($line) { try { $doc = $line | ConvertFrom-Json } catch { $doc = $null } }
  [ordered]@{ exit = (Get-Prop $UpRun 'exit'); status = (Get-Prop $doc 'status'); code = (Get-Prop $doc 'code')
    stdout = $(if ($stdout.Length -gt 8000) { $stdout.Substring($stdout.Length - 8000) } else { $stdout }); stderr = (Get-Prop $UpRun 'stderr') }
}
function Read-DrillReinstallUpgradeEvidence([string]$RunDir) {
  $file = Join-Path $RunDir 'reinstall-upgrade.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  try { Read-DrillJson $file } catch { [ordered]@{ unreadable = $true } }
}

# ---------------------------------------------------------------- Hyper-V side (needs the host; not unit-tested)

function Get-DrillVmInfo {
  $vm = Get-VM -Name $script:Drill.VmName -ErrorAction SilentlyContinue
  if ($null -eq $vm) { return $null }
  return @{ vm = $vm; notes = $vm.Notes; state = [string]$vm.State; checkpoints = @(Get-VMSnapshot -VM $vm -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) }
}

function Get-DrillTime { [DateTimeOffset]::UtcNow }
# Seconds on a monotonic clock (no wall clock step moves it), for spacing (Step-DrillCacheRelease), never for a time of day: the one
# other clock, read only here, as Get-DrillTime is the one wall clock.
function Get-DrillMonotonicSeconds { [Diagnostics.Stopwatch]::GetTimestamp() / [double][Diagnostics.Stopwatch]::Frequency }

function Read-DrillHostStatus {
  try { Get-Content -LiteralPath $script:Drill.HostStatus -Raw -Encoding UTF8 -ErrorAction Stop } catch { $null }
}

# The host's free memory and the drill VM's memory (startup, assigned): the one reading the gates and the wait before the hold judge.
# Throws when either cannot be read, or when the VM named ours is not.
function Read-DrillHostMemory {
  $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 5 -ErrorAction Stop
  if ($null -eq $os.FreePhysicalMemory) { throw 'missing memory reading' }
  $out = @{ free = [long]$os.FreePhysicalMemory * 1KB; target = [long]$script:Drill.MemoryBytes; assigned = 0L }
  $vm = Get-VM -ErrorAction Stop | Where-Object { $_.Name -eq $script:Drill.VmName }
  if ($vm) {
    if ($vm.Notes -cne $script:Drill.Marker) { throw (New-DrillError 'DRILL_VM_NAME_TAKEN_NOT_OURS') }
    $out.target = [Math]::Max($out.target, [long]$vm.MemoryStartup)
    $out.assigned = [long]$vm.MemoryAssigned
  }
  return $out
}

# -JobsOnly: the duty, hold and runner-job checks without any memory reading: the early refusal before the WSL cache release (memory is
# judged once, by the boot gate after the release: Fable renew-key ruling, supplement "WSL gate race" item 3).
# $WslMemory: the runner distribution's memory the boot gate counts (Get-DrillWslMemory, read by Start-DrillGuardedVm); not given, it was
# not read, and a boot gate refuses (Test-DrillHostMemory). Not used running or with -JobsOnly: no boot gate is judged there.
function Get-DrillHostSafety([switch]$Running, [DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue, [switch]$StatusOnly, [switch]$JobsOnly,
  $WslMemory = $null) {
  $json = Read-DrillHostStatus
  $duty = Test-DrillHostSafety $json ([long]::MaxValue) -Running:$Running -Now (Get-DrillTime) -HoldUntil $HoldUntil
  if (-not $duty.ok -or $StatusOnly) {   # no memory and no job was read
    $duty.freeGB = $null; $duty.requiredFreeBytes = $null; if (-not $Running) { $duty.busyWith = $null; $duty.runnerJob = $null }; return $duty }
  try {
    $free = [long]::MaxValue
    $target = $script:Drill.MemoryBytes
    $assigned = 0L
    # both sides' processes first, memory after: the reading a boot rests on is the latest one (Codex review of 74e7a65e7, high 2)
    $processes = @(); $wsl = @{ ok = $true; running = @(); jobs = @(); reason = $null; listCall = $null }; $windowsUnreadable = $null
    if (-not $Running) {
      # a Windows process list that cannot be read is a job query that failed, as on the WSL side: recorded, never a refusal by itself
      # (Codex review of f9ab1bb26, medium 1); memory and the VM are still read, and their failures still refuse below
      try { $processes = @(Get-Process -ErrorAction Stop | ForEach-Object { [string]$_.ProcessName }) }
      catch { $processes = $null; $windowsUnreadable = (Get-DrillCode $_).detail }
      $wsl = Get-DrillWslRunnerState
    }
    if (-not $JobsOnly) { $m = Read-DrillHostMemory; $free = $m.free; $target = $m.target; $assigned = $m.assigned }
    $wslJob = $null
    if (@($wsl.jobs).Count -gt 0) { $wslJob = $true } elseif ($wsl.ok) { $wslJob = $false }   # a confirmed job stays one beside an unread distribution
    $gateWsl = $WslMemory; if ($Running -or $JobsOnly) { $gateWsl = @() }
    $safety = Test-DrillHostSafety $json $free -VmMemoryBytes $target -MemoryAssigned $assigned -Running:$Running -Now (Get-DrillTime) -HoldUntil $HoldUntil -ProcessNames $processes -WslJob $wslJob -WslMemory $gateWsl
    if ($JobsOnly) { $safety.freeGB = $null; $safety.requiredFreeBytes = $null; $safety.requiredBasis = $null }   # nothing was read
    if (-not $Running) {   # running, neither side's jobs were read (G2): no reading of them
      $safety.wslRunnerDistributions = $wsl.running
      $safety.wslJobs = $wsl.jobs
      $safety.wslUnreadable = $wsl.reason
      $safety.wslListCall = Get-Prop $wsl 'listCall'   # a state without it (a stand-in) has none
      $safety.windowsUnreadable = $windowsUnreadable
    }
  } catch {
    $c = Get-DrillCode $_
    $safety = @{ ok = $false; code = $(if ($c.code -eq 'DRILL_VM_NAME_TAKEN_NOT_OURS') { $c.code } else { 'DRILL_HOST_RESOURCE_UNREADABLE' }); action = $(if ($Running) { 'abort' } else { 'refuse' }) }
  }
  # The resource checks can take time. Keep the observation from the original status read.
  $safety.executorObservation = $duty.executorObservation
  $safety.observedAt = $duty.observedAt
  return $safety
}

# The duty and the hold only: runner jobs are sampled in the three recorded pre-boot stages and memory by the boot gate alone, so no
# sample is taken that the receipt does not keep (Codex review of 74e7a65e7, medium 1).
function Assert-DrillHostSafety([DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  Assert-DrillGuard
  $safety = Get-DrillHostSafety -HoldUntil $HoldUntil -StatusOnly
  if (-not $safety.ok) { throw (New-DrillError $safety.code $safety) }
  return $safety
}

# What the receipt keeps of one stage's sample.
function ConvertTo-DrillGateTrace($Safety) {
  $required = Get-Prop $Safety 'requiredFreeBytes'
  [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); ok = [bool](Get-Prop $Safety 'ok'); code = (Get-Prop $Safety 'code'); busyWith = (Get-Prop $Safety 'busyWith')
    runnerJob = (Get-Prop $Safety 'runnerJob'); requiredFreeGB = $(if ($null -ne $required) { [Math]::Round([long]$required / 1GB, 1) } else { $null })
    requiredBasis = $(if ($null -ne $required) { Get-Prop $Safety 'requiredBasis' } else { $null })
    freeGB = (Get-Prop $Safety 'freeGB'); wslRunning = @(Get-Prop $Safety 'wslRunnerDistributions'); wslJobs = @(Get-Prop $Safety 'wslJobs')
    wslUnreadable = (Get-Prop $Safety 'wslUnreadable'); wslListCall = (Get-Prop $Safety 'wslListCall'); windowsUnreadable = (Get-Prop $Safety 'windowsUnreadable') }
}

# Fable renew-key ruling, supplements "WSL runner jobs" item 3 and "WSL gate race" item 3: before every boot, three stages, each sampling for
# itself -- the early sample (here: the duty and the hold refuse; the jobs are sampled, never refused on), the release (here, only when
# neither side has a job or an unread side), the boot gate (Start-DrillGuardedVm: both sides again, recorded only, then memory once, the
# boot). Each is kept in $script:DrillPreBoot for the receipt, beside the wait for memory before the hold (wait: Wait-DrillBootMemory's
# record, null without one). A release skipped for a job is no failure: the boot gate judges what is free. Only while idle (Decision
# 21db5a9c): Decision f572ac5b's "a job there or not" is the running guard's alone,
# with the drill VM on -- before the boot it is off, and "the earlier permission while idle stands" (independent review of a643c4b42, block 1).
function Invoke-DrillPreBootRelease([DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  $script:DrillPreBoot = [ordered]@{ wait = $script:DrillBootWait; early = $null; release = $null; bootGate = $null }
  $early = Get-DrillHostSafety -HoldUntil $HoldUntil -JobsOnly
  $script:DrillPreBoot.early = ConvertTo-DrillGateTrace $early
  if (-not $early.ok) { throw (New-DrillError $early.code $early) }
  # the release only when neither side has a job (while idle); with one -- or a side that could not be read -- the boot gate decides alone
  $earlyJob = Get-Prop $early 'busyWith'
  if ($null -ne $earlyJob) {
    $script:DrillPreBoot.release = [ordered]@{ at = (Get-DrillTime).ToString('o'); distributions = @(); results = @(); released = @()
      skipped = [ordered]@{ where = 'early'; reason = $earlyJob }; failed = $null }
    return
  }
  $script:DrillPreBoot.release = Invoke-DrillWslCacheRelease
}

# ---------------------------------------------------------------- the runners' WSL distribution (Fable renew-key ruling, supplement "WSL runner jobs")
# The distributions this host's Linux Actions runners are registered in: its entry by host name in scripts/ci/self-hosted/node-profiles.json
# (linux_runner and additional_linux_runners); none for an entry without a Linux runner. A host with no entry throws (Fable renew-key
# ruling, supplement "WSL distribution source": a drill host must be a registered one, and "not found" is not "found empty"), as do an
# unreadable registry and an invalid name.
function Get-DrillRunnerDistributions([string]$HostName = $env:COMPUTERNAME) {
  $profiles = Read-DrillJson $script:Drill.NodeProfiles
  $entries = @($profiles.hosts | Where-Object { $_ -and [string](Get-Prop $_ 'hostname') -ieq $HostName })
  if ($entries.Count -gt 1) { throw (New-DrillError 'HOST_IN_NODE_PROFILES_TWICE' $HostName) }
  if ($entries.Count -eq 0) { throw (New-DrillError 'HOST_NOT_IN_NODE_PROFILES' $HostName) }
  # Only an entry with no Linux runner entry at all has none. A runner entry is an object whose distro is a name; anything else -- a
  # missing or null distro, a null entry, a list that is not one -- fails like an unreadable registry (the job query failed: the high memory
  # tier), never reads as "no runner"
  # (Codex review of addf1ffa5, medium 1). Names are taken whole (\z: nothing after them, not even a line end) and merged ordinally.
  $runners = @()
  $single = $entries[0].PSObject.Properties['linux_runner']
  if ($null -ne $single) { $runners += , $single.Value }
  $more = $entries[0].PSObject.Properties['additional_linux_runners']
  if ($null -ne $more) {
    if ($more.Value -isnot [array]) { throw (New-DrillError 'NODE_PROFILES_RUNNER_DISTRIBUTION_INVALID' $HostName) }
    foreach ($r in $more.Value) { $runners += , $r }
  }
  $names = @()
  foreach ($r in $runners) {
    $distro = $null
    if ($r -is [pscustomobject] -and $null -ne $r.PSObject.Properties['distro']) { $distro = $r.PSObject.Properties['distro'].Value }
    if ($distro -isnot [string] -or $distro -cnotmatch '\A[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z') { throw (New-DrillError 'NODE_PROFILES_RUNNER_DISTRIBUTION_INVALID' $HostName) }
    if (-not (Test-DrillNameIn $distro $names)) { $names += $distro }
  }
  return $names
}

# The one way the drill reaches WSL: wsl.exe with fixed literals and a validated distribution name, bounded (on a time out only the client
# this call started is ended, by its handle). Like the intake request: under a test marker (NODE_TEST_CONTEXT or CLUED_UNDER_TEST) wsl.exe
# is never executed, only an injected runner ($script:DrillWslRunner: { param($Arguments, $TimeoutSeconds) ... returns @{ exit; stdout;
# stderr } }); without a marker an injected runner is refused.
$script:DrillWslRunner = $null
function Invoke-DrillWsl([string[]]$Arguments, [int]$TimeoutSeconds = $script:Drill.WslTimeoutSeconds) {
  $marked = [bool]($env:NODE_TEST_CONTEXT -or $env:CLUED_UNDER_TEST)
  if ($marked -and $null -eq $script:DrillWslRunner) { throw (New-DrillError 'DRILL_HOST_ACCESS_UNDER_TEST' "wsl $($Arguments -join ' ')") }
  if (-not $marked -and $null -ne $script:DrillWslRunner) { throw (New-DrillError 'DRILL_WSL_RUNNER_WITHOUT_TEST_MARKER') }
  if ($marked) { return & $script:DrillWslRunner $Arguments $TimeoutSeconds }
  # WSL_UTF8: wsl.exe's own output (the distribution list) in UTF-8 rather than UTF-16.
  return Invoke-DrillProcess (Join-Path $env:SystemRoot 'System32\wsl.exe') $Arguments $TimeoutSeconds @{ WSL_UTF8 = '1' }
}

# The distributions registered for this (the operator's) account: the DistributionName of each key under HKCU\...\Lxss, read only.
# Host state: under a test marker it is not read (tests define this function), as wsl.exe is not run.
function Get-DrillWslRegisteredNames {
  if ($env:NODE_TEST_CONTEXT -or $env:CLUED_UNDER_TEST) { throw (New-DrillError 'DRILL_HOST_ACCESS_UNDER_TEST' 'HKCU Lxss') }
  @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction Stop |
    ForEach-Object { [string](Get-ItemProperty -LiteralPath $_.PSPath -Name DistributionName -ErrorAction Stop).DistributionName })
}

# Names are compared exactly, ordinal: PowerShell's -ceq and -ccontains compare linguistically and pass over characters such as NUL.
function Test-DrillNameIn([string]$Name, [string[]]$Set) {
  foreach ($s in @($Set)) { if ([string]::Equals($Name, $s, [StringComparison]::Ordinal)) { return $true } }
  return $false
}

# This account's registered names, and every runner distribution among them (else nothing said about them can be read).
function Get-DrillWslRegisteredRunners($Distributions) {
  $registered = @(try { Get-DrillWslRegisteredNames } catch { $c = Get-DrillCode $_; if ($c.code -ne 'DRILL_UNEXPECTED') { throw }; throw (New-DrillError 'WSL_REGISTRY_UNREADABLE') })
  foreach ($d in @($Distributions)) { if (-not (Test-DrillNameIn $d $registered)) { throw (New-DrillError 'WSL_RUNNER_DISTRIBUTION_NOT_REGISTERED' $d) } }
  return $registered
}

# `wsl --list --running --quiet`: the one WSL answer whose output is read, by one fixed rule (Fable renew-key ruling, supplement "branch
# one, round four", item 4): a zero exit with nothing on stderr; stdout (UTF-8: WSL_UTF8) cut at its line ends (CRLF or LF); only lines of
# length zero dropped; every other line, whole and untrimmed, the name of a distribution registered for this account -- or the whole
# answer is refused. Names are compared as they are, ordinal (Test-DrillNameIn).
function ConvertFrom-DrillWslRunningList($Result, [string[]]$Registered) {
  $exit = Get-DrillField $Result 'exit'; $err = Get-DrillField $Result 'stderr'; $text = Get-DrillField $Result 'stdout'
  if (-not ($exit -is [int] -and $exit -eq 0) -or ($null -ne $err -and ([string]$err).Length -ne 0)) { throw (New-DrillError 'WSL_RUNNING_LIST_FAILED') }
  foreach ($line in @(([string]$text) -split "`r?`n")) {
    if ($line.Length -eq 0) { continue }
    if (-not (Test-DrillNameIn $line $Registered)) { throw (New-DrillError 'WSL_RUNNING_LIST_UNREADABLE') }
    $line
  }
}

# The probe's closed table (Fable renew-key ruling, supplement "branch one, round four", item 1): `pgrep -ix Runner[.]Worker` in the
# distribution, the exact name in any case, as on the Windows side. Its stdout is never read.
#   exit 0, nothing on stderr -> JOB       exit 1, nothing on stderr -> NO_JOB
#   anything else -- another exit, anything on stderr, a time out (Invoke-DrillProcess throws) -> the query failed: the high memory tier
function Get-DrillWslJobVerdict($Result) {
  $exit = Get-DrillField $Result 'exit'; $err = Get-DrillField $Result 'stderr'
  if ($null -ne $err -and ([string]$err).Length -ne 0) { throw (New-DrillError 'WSL_PROCESS_QUERY_FAILED' 'stderr') }
  if ($exit -is [int] -and $exit -eq 0) { return 'JOB' }
  if ($exit -is [int] -and $exit -eq 1) { return 'NO_JOB' }
  throw (New-DrillError 'WSL_PROCESS_QUERY_FAILED' @{ exit = $exit })
}

# Read-only. A distribution that is not running is "no job" without any command against it: a command would start it.
# Returns @{ ok; distributions; running; jobs; reason }: ok false (reason set) when any step fails; the caller takes the high memory tier.
function Get-DrillWslRunnerState([string]$HostName = $env:COMPUTERNAME) {
  # listCall: the list call's raw answer -- its exit and the bytes of its stdout -- so the exit wsl.exe gives when nothing runs (never
  # measured: Fable ruling 11-20 "first install r4" section 2) is calibrated from the receipt the first time it happens
  $state = @{ ok = $false; distributions = @(); running = @(); jobs = @(); reason = 'NODE_PROFILES_UNREADABLE'; listCall = $null }
  try {
    $state.distributions = @(Get-DrillRunnerDistributions $HostName)
    if ($state.distributions.Count -gt 0) {
      $state.reason = 'WSL_REGISTRY_UNREADABLE'
      $registered = Get-DrillWslRegisteredRunners $state.distributions
      $state.reason = 'WSL_RUNNING_LIST_FAILED'
      $list = Invoke-DrillWsl @('--list', '--running', '--quiet')
      $state.listCall = [ordered]@{ exit = (Get-DrillField $list 'exit'); stdoutBytes = [Text.Encoding]::UTF8.GetByteCount([string](Get-DrillField $list 'stdout')) }
      $runningNow = @(ConvertFrom-DrillWslRunningList $list $registered)
      $state.running = @($state.distributions | Where-Object { Test-DrillNameIn $_ $runningNow })
      foreach ($d in $state.running) {
        $state.reason = 'WSL_PROCESS_QUERY_FAILED'
        if ((Get-DrillWslJobVerdict (Invoke-DrillWsl @('--distribution', $d, '--exec', 'pgrep', '-ix', $script:Drill.WslJobPattern))) -ceq 'JOB') { $state.jobs += $d }
      }
    }
    $state.ok = $true; $state.reason = $null
  } catch {
    $state.ok = $false
    $c = Get-DrillCode $_
    if ($c.code -ne 'DRILL_UNEXPECTED') { $state.reason = $c.code }
  }
  return $state
}

# Fable ruling 0e418483 "drill memory root" 2.4 (G2) and its supplement "three questions after the implementation" 1: what each runner
# distribution holds, for the boot gate (its sample, and its MemFree counted as taken: Test-DrillHostMemory) and when the guard aborted
# for memory (one reader, one shape) -- MemTotal,
# MemFree, Cached and AnonPages from its /proc/meminfo, in GB, and how many Runner.Worker processes ran in it (pgrep -c with
# WslJobPattern: exit 0 or 1, the count on stdout). Read-only, like the probe: only a distribution already running is asked (a command
# would start it), every call sharing one budget (CacheReleaseSeconds, on the drill's clock). The count is evidence only (the boot gate
# needs MemFree; independent review of 29ed7255c, medium C): any other answer leaves it out (runnerWorkers null), nothing thrown. A
# meminfo not read whole, or the budget run out, throws, and the caller records nothing; nothing is returned when no runner
# distribution runs. -IdleCap (the boot gate's two entries, Fable plan 87d330d0 4.1): also one record per runner distribution of this
# host that is not running -- distribution, running $false, and capGB, the cap of the Owner's WSL VM (Read-DrillWslConfigMemory, rounded
# up to two places; null when not read), which it can take once started.
function Get-DrillWslMemory([string]$HostName = $env:COMPUTERNAME, [int]$WithinSeconds = $script:Drill.CacheReleaseSeconds, [switch]$IdleCap) {
  $until = (Get-DrillTime).AddSeconds($WithinSeconds)
  $left = { $s = [int][Math]::Floor(($until - (Get-DrillTime)).TotalSeconds); if ($s -lt 1) { throw (New-DrillError 'DRILL_WSL_MEMORY_TIMEOUT') }; $s }
  $clean = { param($r) $e = Get-DrillField $r 'exit'; $err = Get-DrillField $r 'stderr'; ($e -is [int]) -and ($null -eq $err -or ([string]$err).Length -eq 0) }
  $distributions = @(Get-DrillRunnerDistributions $HostName)
  if ($distributions.Count -eq 0) { return }
  $registered = Get-DrillWslRegisteredRunners $distributions
  $runningNow = @(ConvertFrom-DrillWslRunningList (Invoke-DrillWsl @('--list', '--running', '--quiet') (& $left)) $registered)
  foreach ($d in @($distributions | Where-Object { Test-DrillNameIn $_ $runningNow })) {
    $mi = Invoke-DrillWsl @('--distribution', $d, '--exec', 'cat', '/proc/meminfo') (& $left)
    if (-not (& $clean $mi) -or (Get-DrillField $mi 'exit') -ne 0) { throw (New-DrillError 'WSL_MEMINFO_UNREADABLE' $d) }
    $kb = @{}
    foreach ($line in @(([string](Get-DrillField $mi 'stdout')) -split "`r?`n")) {
      if ($line -cmatch '^(MemTotal|MemFree|Cached|AnonPages):\s+(\d+) kB$') {
        if ($kb.ContainsKey($Matches[1])) { throw (New-DrillError 'WSL_MEMINFO_UNREADABLE' $d) }
        $kb[$Matches[1]] = [long]$Matches[2]
      }
    }
    if ($kb.Count -ne 4) { throw (New-DrillError 'WSL_MEMINFO_UNREADABLE' $d) }
    $pc = Invoke-DrillWsl @('--distribution', $d, '--exec', 'pgrep', '-cix', $script:Drill.WslJobPattern) (& $left)
    $workers = $null
    if ((& $clean $pc) -and (Get-DrillField $pc 'exit') -in @(0, 1) -and [string](Get-DrillField $pc 'stdout') -cmatch '\A(\d+)\r?\n?\z') { $workers = [int]$Matches[1] }
    $gb = { param([long]$k) [Math]::Round($k * 1KB / 1GB, 2) }
    [ordered]@{ distribution = $d; memTotalGB = (& $gb $kb['MemTotal']); memFreeGB = (& $gb $kb['MemFree']); cachedGB = (& $gb $kb['Cached'])
      anonPagesGB = (& $gb $kb['AnonPages']); runnerWorkers = $workers }
  }
  if ($IdleCap) {
    $idle = @($distributions | Where-Object { -not (Test-DrillNameIn $_ $runningNow) })
    if ($idle.Count) {
      $cap = Read-DrillWslConfigMemory
      $capGB = if ($null -ne $cap) { [Math]::Ceiling($cap / 1GB * 100) / 100 } else { $null }
      foreach ($d in $idle) { [ordered]@{ distribution = $d; running = $false; capGB = $capGB } }
    }
  }
}

# The cap of the Owner's WSL VM (Fable plan 87d330d0 4.1): in the [wsl2] section of $script:Drill.WslConfig, memory=<number>GB or
# <number>MB (the unit in any case), once, in bytes rounded up. No file, no such key, the key twice, or anything else in the value: $null
# (not read) -- WSL's own default is never guessed. Never the Owner's real file under test.
function Read-DrillWslConfigMemory([string]$Path = $script:Drill.WslConfig) {
  if (($env:NODE_TEST_CONTEXT -or $env:CLUED_UNDER_TEST) -and [string]::Equals([IO.Path]::GetFullPath($Path),
      [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.wslconfig')), [StringComparison]::OrdinalIgnoreCase)) {
    throw (New-DrillError 'DRILL_HOST_ACCESS_UNDER_TEST' '.wslconfig')
  }
  $text = $null
  try { $text = [IO.File]::ReadAllText($Path) } catch { return $null }
  $section = $null; $values = @()
  foreach ($line in @($text -split "`r?`n")) {
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith('#') -or $t.StartsWith(';')) { continue }
    if ($t -match '^\[([^\]]*)\]$') { $section = $Matches[1].Trim(); continue }
    if ($section -ieq 'wsl2' -and $t -imatch '^memory\s*=') { $values += $t }
  }
  if ($values.Count -ne 1 -or -not ($values[0] -imatch '^memory\s*=\s*(\d+(?:\.\d+)?)(GB|MB)$')) { return $null }
  $unit = if ($Matches[2] -ieq 'GB') { 1GB } else { 1MB }
  $bytes = [long][Math]::Ceiling([double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture) * $unit)
  if ($bytes -le 0) { return $null }
  return $bytes
}

# Each release command is the single-quoted string this file assigns, unchanged, with nothing the Windows command line could split or
# escape: read back from the file's own syntax tree, never from anything given at run time. Both are held at every release, whichever is
# sent; the idle one is the probe's pgrep question, then exactly the running one.
function Assert-DrillWslReleaseCommandLiteral {
  $ast = [Management.Automation.Language.Parser]::ParseFile($script:DrillScriptPath, [ref]$null, [ref]$null)
  $read = { param([string]$name, $now)
    $assignments = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.AssignmentStatementAst] -and
      $a.Left.Extent.Text -ceq ('$script:' + $name) }, $false))
    $value = if ($assignments.Count -eq 1) { $assignments[0].Right.Expression } else { $null }
    if ($value -isnot [Management.Automation.Language.StringConstantExpressionAst] -or
        $value.StringConstantType -ne [Management.Automation.Language.StringConstantType]::SingleQuoted -or
        -not [string]::Equals($value.Value, [string]$now, [StringComparison]::Ordinal) -or $value.Value -match '["\\\r\n]') {
      throw (New-DrillError 'DRILL_WSL_RELEASE_COMMAND_NOT_LITERAL')
    }
    $value.Value
  }
  $running = & $read 'DrillWslReleaseCommand' $script:DrillWslReleaseCommand
  $idle = & $read 'DrillWslIdleReleaseCommand' $script:DrillWslIdleReleaseCommand
  if (-not $idle.StartsWith("pgrep -ix '$($script:Drill.WslJobPattern)' >/dev/null;", [StringComparison]::Ordinal) -or
      -not $idle.EndsWith("; $running", [StringComparison]::Ordinal) -or $running.Contains('pgrep')) {
    throw (New-DrillError 'DRILL_WSL_RELEASE_COMMAND_NOT_LITERAL')
  }
}

# The one release function, for each of this host's runner distributions, right before it and taken from no earlier sample: the running
# list read again (a distribution that is not running gets no command: it would start it), then:
# - before a boot, the default, only while idle (Decision 21db5a9c, kept by f572ac5b; the renew-key ruling, supplements "WSL runner jobs"
#   item 3, "WSL gate race" item 1 and "branch one, round four" item 2), after the early refusal: the Windows side read again (a job there
#   stops the release), then DrillWslIdleReleaseCommand, which decides inside the distribution. Its exit alone: 0 released; 3 a job,
#   skipped -- not a failure, the boot gate judges memory alone; anything else a failed release.
# - -WhileRunning, the running guard's (Decision f572ac5b; Fable ruling 0e418483 "drill memory root" 2.3): the drill VM on and the host
#   below 10 GB free, a job on either side or not: the Windows side is not read, DrillWslReleaseCommand is sent. Its exit alone: 0 released;
#   anything else, 3 included, a failed release.
# A failed release is recorded and does not stop the drill (the boot gate, or the running gate, judges what is free). Under a test marker
# without an injected runner nothing is executed (Invoke-DrillWsl refuses), which is recorded as a failed release. -WithinSeconds (the
# running guard: CacheReleaseSeconds): every WSL call of this release shares that one budget, and one that would start with less than a
# second of it left fails the release instead. Its timeout ends wsl.exe on the Windows side only: the sync and the write inside the
# distribution may still finish, so a failed row does not prove nothing was released (independent review of a643c4b42, suggestion 3).
function Invoke-DrillWslCacheRelease([string]$HostName = $env:COMPUTERNAME, [int]$WithinSeconds = 0, [switch]$WhileRunning) {
  $out = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); distributions = @(); results = @(); released = @(); skipped = $null; failed = $null }
  $until = if ($WithinSeconds -gt 0) { (Get-DrillTime).AddSeconds($WithinSeconds) } else { $null }
  $left = { if ($null -eq $until) { return $script:Drill.WslTimeoutSeconds }
    $s = [int][Math]::Floor(($until - (Get-DrillTime)).TotalSeconds); if ($s -lt 1) { throw (New-DrillError 'DRILL_WSL_CACHE_RELEASE_TIMEOUT') }; $s }
  try {
    Assert-DrillWslReleaseCommandLiteral
    $out.distributions = @(Get-DrillRunnerDistributions $HostName)
    $registered = @()
    if ($out.distributions.Count -gt 0) { $registered = Get-DrillWslRegisteredRunners $out.distributions }
    foreach ($d in $out.distributions) {
      $runningNow = @(ConvertFrom-DrillWslRunningList (Invoke-DrillWsl @('--list', '--running', '--quiet') (& $left)) $registered)
      if (-not (Test-DrillNameIn $d $runningNow)) { $out.results += [ordered]@{ distribution = $d; running = $false; exit = $null }; continue }
      # before a boot, the Windows side last, right before the call: the running list may have taken its time (Codex review of f734afe7e,
      # medium 2)
      if (-not $WhileRunning -and (Test-DrillHostRunnerJob @(Get-Process -ErrorAction Stop | ForEach-Object { [string]$_.ProcessName }))) {
        $out.skipped = [ordered]@{ where = 'windows'; reason = 'ACTIONS_RUNNER_JOB' }
        break
      }
      $exit = Get-DrillField (Invoke-DrillWsl @('--distribution', $d, '--user', 'root', '--exec', 'sh', '-c', $(if ($WhileRunning) { $script:DrillWslReleaseCommand } else { $script:DrillWslIdleReleaseCommand })) (& $left)) 'exit'
      $out.results += [ordered]@{ distribution = $d; running = $true; exit = $exit }
      if ($exit -is [int] -and $exit -eq 0) { $out.released += $d }
      elseif (-not $WhileRunning -and $exit -is [int] -and $exit -eq 3) { $out.skipped = [ordered]@{ where = $d; reason = 'WSL_ACTIONS_RUNNER_JOB' }; break }
      else { throw (New-DrillError 'DRILL_WSL_CACHE_RELEASE_FAILED' @{ distribution = $d; exit = $exit }) }
    }
  } catch {
    $c = Get-DrillCode $_
    $out.failed = [ordered]@{ code = $c.code; detail = $c.detail }
  }
  return $out
}

function Get-DrillIntakeTool {
  # Follow the same installed generation and runtime as windows/rearm-resident.ps1's unprivileged inspect.
  $root = Split-Path -Parent (Split-Path -Parent $script:Drill.HostStatus)
  try {
    $receipt = Read-DrillJson (Join-Path $root 'install\install-receipt.json')
    $manifest = $receipt.residentManifestSha256
    if ($manifest -isnot [string] -or $manifest -cnotmatch '^[0-9a-f]{64}$') { throw 'invalid resident generation' }
    $tool = Join-Path $root "resident\$manifest\tools\rearm-tool.mjs"
    $node = Join-Path $root 'runtime\node.exe'
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'installed CLI unavailable' }
    return @{ root = $root; node = $node; tool = $tool }
  } catch { throw (New-DrillError 'DRILL_HOST_INTAKE_TOOL_UNAVAILABLE') }
}

# Every child the drill starts in the guest (the kit entry, verify, the A8 tools, root in the prerequisite distribution) runs here, by the
# package's rule (Invoke-Native, windows/first-install-host.ps1): stdout and stderr read apart, so a line a tool writes on stderr is text,
# never a PowerShell error that ends the step under Stop (the merged 2>&1 reads did that: Fable renew-key ruling, supplement "eight on
# the path", risks taken in). A child still running at $Seconds is left running (nothing is killed) and the step stops by name.
# Self-contained: the guest receives it as text ($script:DrillNativeText) and makes it a script block there.
function Invoke-DrillNative {
  # $Log: every stdout line is also written there as it comes (the kit entry's guest log: a run cut off still leaves what it printed)
  param([string]$Exe, [string[]]$Arguments, [int]$Seconds = 3600, [string]$Encoding = 'utf-8', [string]$Log = '')
  $quote = { param([string]$a) if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { $a } else { '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' } }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe; $psi.Arguments = (@($Arguments | ForEach-Object { & $quote $_ }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  # 'utf-16': a child that writes UTF-16LE (wsl.exe's own messages); UTF-8 otherwise
  $enc = if ($Encoding -ceq 'utf-16') { [Text.Encoding]::Unicode } else { New-Object Text.UTF8Encoding($false) }
  $psi.StandardOutputEncoding = $enc; $psi.StandardErrorEncoding = $enc
  $p = [Diagnostics.Process]::Start($psi)
  $e = $p.StandardError.ReadToEndAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  $left = { [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds) }
  $out = New-Object Text.StringBuilder
  $w = $null
  if ($Log) { $w = New-Object IO.StreamWriter -ArgumentList $Log, $false, (New-Object Text.UTF8Encoding($false)); $w.AutoFlush = $true }
  try {
    while ($true) {
      $next = $p.StandardOutput.ReadLineAsync()
      if (-not $next.Wait((& $left))) { throw ('COMMAND_TIMEOUT_NOTHING_KILLED: ' + [IO.Path]::GetFileName($Exe)) }
      if ($null -eq $next.Result) { break }
      [void]$out.AppendLine($next.Result); if ($w) { $w.WriteLine($next.Result) }
    }
  } finally { if ($w) { $w.Dispose() } }
  if (-not $p.WaitForExit((& $left))) { throw ('COMMAND_TIMEOUT_NOTHING_KILLED: ' + [IO.Path]::GetFileName($Exe)) }
  $p.WaitForExit()   # the asynchronous stderr read ends with the child
  $err = ([string]$e.Result) -replace "`0", ''
  [ordered]@{ exit = $p.ExitCode; stdout = ($out.ToString() -replace "`0", ''); stderr = $(if ($err.Length -gt 4000) { $err.Substring($err.Length - 4000) } else { $err }) }
}
$script:DrillNativeText = ${function:Invoke-DrillNative}.ToString()
# The one quoting rule for every child the drill starts (Fable ruling 11-20 "first install r4" section 2, E2): an argument is quoted only
# when it is empty or holds white space or a quote. It is written once, inside Invoke-DrillNative (which the guest receives as text), and
# taken from there for the host's children (Invoke-DrillProcess): wsl.exe reads its raw command line and takes a quoted "--list" for a
# command to run in the default distribution, so an unconditional quote made every WSL query fail.
$script:DrillArgumentQuote = @(${function:Invoke-DrillNative}.Ast.FindAll({ param($a) $a -is [Management.Automation.Language.AssignmentStatementAst] -and
  $a.Left.Extent.Text -ceq '$quote' }, $true))[0].Right.Expression.ScriptBlock.GetScriptBlock()
function Get-DrillArgumentLine([string[]]$Arguments) { (@($Arguments | ForEach-Object { & $script:DrillArgumentQuote $_ }) -join ' ') }

function Invoke-DrillNode([string]$Node, [string[]]$Arguments, [int]$TimeoutSeconds) {
  Invoke-DrillProcess $Node $Arguments $TimeoutSeconds @{} @('NODE_OPTIONS', 'NODE_PATH')
}

# One bounded child process, no shell; on a timeout it kills only the child it started.
# $StandardInput: text the child reads from its standard input (a secret that must be in no argument and no environment variable).
function Invoke-DrillProcess([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds, [hashtable]$Environment = @{}, [string[]]$RemoveEnvironment = @(), $StandardInput = $null) {
  $child = [Diagnostics.Process]::new()
  try {
    $child.StartInfo.FileName = $File
    # All arguments are fixed literals, Windows file paths or validated names; quoted by the one rule, only where needed.
    $child.StartInfo.Arguments = Get-DrillArgumentLine $Arguments
    $child.StartInfo.UseShellExecute = $false
    $child.StartInfo.CreateNoWindow = $true
    $child.StartInfo.RedirectStandardOutput = $true
    $child.StartInfo.RedirectStandardError = $true
    $child.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    foreach ($name in $RemoveEnvironment) { $child.StartInfo.EnvironmentVariables.Remove($name) }
    foreach ($name in $Environment.Keys) { $child.StartInfo.EnvironmentVariables[$name] = $Environment[$name] }
    # Standard input as UTF-8 without a byte order mark: Windows PowerShell's .NET writes it in the console's input encoding, which on a
    # UTF-8 console (hosted runners) starts with a BOM, and the child would read the BOM as the password's first character.
    $inputWas = $null
    if ($null -ne $StandardInput) {
      $child.StartInfo.RedirectStandardInput = $true
      $plain = New-Object Text.UTF8Encoding $false
      if ($child.StartInfo.PSObject.Properties['StandardInputEncoding']) { $child.StartInfo.StandardInputEncoding = $plain }
      elseif ([Console]::InputEncoding.GetPreamble().Length -gt 0) { $inputWas = [Console]::InputEncoding; [Console]::InputEncoding = $plain }
    }
    try { [void]$child.Start() } finally { if ($null -ne $inputWas) { [Console]::InputEncoding = $inputWas } }
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    # a child that ends before it reads its standard input (it refused first) closes the pipe: its exit and output say why
    if ($null -ne $StandardInput) { try { $child.StandardInput.Write([string]$StandardInput); $child.StandardInput.Close() } catch [IO.IOException] { } }
    if (-not $child.WaitForExit($TimeoutSeconds * 1000)) {
      if (-not $child.HasExited) { $child.Kill() }
      throw "$([IO.Path]::GetFileName($File)) timed out"
    }
    return @{ exit = $child.ExitCode; stdout = $stdout.GetAwaiter().GetResult(); stderr = $stderr.GetAwaiter().GetResult() }
  } finally { $child.Dispose() }
}

# Clued Task fe8a2cbf (Fable renew-key ruling, supplements "test touching production" and "the test guard criterion"): the one act of
# the drill that changes the host is executing the installed intake tool (it writes a request the service on duty acts on). Under a test
# marker -- NODE_TEST_CONTEXT, which the node test runner gives every test process and its children inherit, or CLUED_UNDER_TEST,
# honoured here as well (the one test entry is to set it for every suite: PR-丁, not yet) -- no tool is executed, whatever its paths:
# nothing about a path is judged, so no spelling of a root can slip through. A test that needs the hold logic injects the sender
# ($script:DrillIntakeSender: { param($Tool, $Verb, $Minutes, $Arguments) ... returns @{ exit; stdout } }), used only under a marker (without one an injected sender is refused, DRILL_INTAKE_SENDER_WITHOUT_TEST_MARKER). Reading the host status and
# locating the tool are read-only and not fenced. The boot watchdog (started through WMI, so it inherits no environment) never executes
# the intake tool: it only stops and restores the drill VM (Stop-DrillOwnedVm), so it needs no marker of its own. Cooperative: the marker
# stops a mistake, not code that clears it on purpose.
$script:DrillIntakeSender = $null
function Get-DrillIntakeArguments($Tool, [ValidateSet('pause', 'resume')][string]$Verb, [int]$Minutes = 0) {
  $a = @($Tool.tool, "request-intake-$Verb", '--root', $Tool.root, '--holder', $script:Drill.IntakeHolder, '--reason', 'first-install drill')
  if ($Verb -ceq 'pause') { $a += @('--minutes', [string]$Minutes) }
  , $a
}
function Request-DrillIntake($Tool, [ValidateSet('pause', 'resume')][string]$Verb, [int]$Minutes = 0) {
  # first, before the tool record is read: under a marker only an injected sender is used; without one an injected sender is refused
  # (production never takes a request from a stand-in: Codex review r5), so neither it nor the real tool runs
  $marked = [bool]($env:NODE_TEST_CONTEXT -or $env:CLUED_UNDER_TEST)
  if ($marked -and $null -eq $script:DrillIntakeSender) { throw (New-DrillError 'DRILL_HOST_ACCESS_UNDER_TEST' "request-intake-$Verb") }
  if (-not $marked -and $null -ne $script:DrillIntakeSender) { throw (New-DrillError 'DRILL_INTAKE_SENDER_WITHOUT_TEST_MARKER' "request-intake-$Verb") }
  $argsForTool = Get-DrillIntakeArguments $Tool $Verb $Minutes
  $expected = if ($Verb -ceq 'pause') { 'INTAKE_PAUSE_REQUESTED_SERVICE_WILL_HOLD_NEW_BATCHES' } else { 'INTAKE_RESUME_REQUESTED' }
  try {
    $run = if ($marked) { & $script:DrillIntakeSender $Tool $Verb $Minutes $argsForTool } else { Invoke-DrillNode $Tool.node $argsForTool 15 }
    $status = Get-Prop (ConvertFrom-Json -InputObject $run.stdout) 'status'
    if ($run.exit -ne 0 -or $status -cne $expected) { throw 'request refused' }
  } catch { throw (New-DrillError "DRILL_HOST_INTAKE_$($Verb.ToUpperInvariant())_FAILED") }
}
# The wait for memory before the host hold (Fable plan 0e418483 "drill boot gate: memory only", section 2.2; BootWaitMinutes' note):
# nothing is requested or started yet. Reads free memory (Read-DrillHostMemory) and the runner distribution's (Get-DrillWslMemory) against
# the boot gate's memory (Test-DrillHostMemory, which Start-DrillGuardedVm judges again) every BootWaitPollSeconds on the monotonic
# clock; returns once it is there; past BootWaitMinutes stops with DRILL_HOST_MEMORY_SHORT and the record. The host's reading failing
# ends the wait and goes on (unreadable): the wait only delays, and the boot gate reads again and refuses on its own. The runner
# distribution's reading failing (three wsl.exe calls under production load; independent review of 29ed7255c, medium A) is that sample
# not passing: the wait goes on, counting it (wslUnreadSamples; wslUnreadable, the last code), and past BootWaitMinutes with the last
# sample unread stops with DRILL_HOST_RESOURCE_UNREADABLE, as the boot gate would. Every reading is counted in $script:DrillBootWait
# (hostPreBoot.wait); requiredFreeGB is the last read sample's.
function Wait-DrillBootMemory {
  $wait = [ordered]@{ samples = 0; firstAt = $null; lastAt = $null; firstFreeGB = $null; lastFreeGB = $null; requiredFreeGB = $null
    ok = $false; unreadable = $null; wslUnreadSamples = 0; wslUnreadable = $null }
  $script:DrillBootWait = $wait
  $limit = [double]$script:Drill.BootWaitMinutes * 60
  $start = Get-DrillMonotonicSeconds
  while ($true) {
    try { $m = Read-DrillHostMemory } catch { $wait.unreadable = (Get-DrillCode $_).code; return $wait }
    $wm = $null; $wslCode = $null
    try { $wm = @(Get-DrillWslMemory -IdleCap) } catch {
      $wslCode = (Get-DrillCode $_).code
      if ($wslCode -ceq 'DRILL_HOST_ACCESS_UNDER_TEST') { throw }   # a test that left the WSL unanswered stops here, not after an hour
    }
    $gate = Test-DrillHostMemory $m.free $m.target -MemoryAssigned $m.assigned -WslMemory $wm
    $at = (Get-DrillTime).ToUniversalTime().ToString('o')
    $wait.samples++
    if ($wait.samples -eq 1) { $wait.firstAt = $at; $wait.firstFreeGB = $gate.freeGB }
    $wait.lastAt = $at; $wait.lastFreeGB = $gate.freeGB
    if ($null -ne $wslCode) { $wait.wslUnreadSamples++; $wait.wslUnreadable = $wslCode }
    else { $wait.requiredFreeGB = [Math]::Round($gate.requiredFreeBytes / 1GB, 1) }
    if ($gate.ok) { $wait.ok = $true; return $wait }
    $left = $limit - ((Get-DrillMonotonicSeconds) - $start)
    if ($left -le 0) {
      $code = if ($null -ne $wslCode) { 'DRILL_HOST_RESOURCE_UNREADABLE' } else { 'DRILL_HOST_MEMORY_SHORT' }
      throw (New-DrillError $code ([ordered]@{ wait = $wait }))
    }
    Start-Sleep -Seconds ([int][Math]::Ceiling([Math]::Min([double]$script:Drill.BootWaitPollSeconds, $left)))
  }
}

# -BootWait: a run that boots the drill VM from its checkpoint waits for memory first (Wait-DrillBootMemory), inside the drill's own mutex
# (one drill waits at a time) and before the host status is read or any hold requested.
function Invoke-DrillWithHostHold([int]$Minutes, [scriptblock]$Body, [switch]$StandbyOnly, [switch]$BootWait) {
  # Serialize all invocations using the same VM and the fixed public holder, across logon sessions.
  $mutex = [Threading.Mutex]::new($false, $script:Drill.HostMutex)
  $locked = $false; $resume = $false; $tool = $null; $failure = $null; $resumeFailure = $null
  $window = @{ safeToResume = $true; deadline = [DateTimeOffset]::MinValue; holdUntil = [DateTimeOffset]::MinValue }
  try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw (New-DrillError 'DRILL_HOST_CI_BUSY') }
    # An orphaned boot watchdog may still be waiting for an in-flight Hyper-V start to become visible.
    $bootMutex = [Threading.Mutex]::new($false, $script:Drill.BootMutex)
    try {
      try { $bootFree = $bootMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $bootFree = $true }
      if (-not $bootFree) { throw (New-DrillError 'DRILL_HOST_CI_BUSY' 'previous drill boot cleanup in progress') }
      $bootMutex.ReleaseMutex()
    } finally { $bootMutex.Dispose() }
    $script:DrillBootWait = $null
    if ($BootWait) { [void](Wait-DrillBootMemory) }
    $now = Get-DrillTime
    $initial = Test-DrillHostSafety (Read-DrillHostStatus) ([long]::MaxValue) -Now $now
    if ($initial.mode -ceq 'ACTIVE' -and $initial.code -cin @('DRILL_HOST_IS_ON_DUTY', 'DRILL_HOST_CI_BUSY') -and -not $StandbyOnly) {
      $holdMinutes = $script:Drill.IntakeWaitMinutes + $Minutes + $script:Drill.IntakeMarginMinutes
      if ($holdMinutes -gt $script:Drill.IntakeMaxMinutes) { throw (New-DrillError 'DRILL_HOST_INTAKE_BUDGET_EXCEEDED' @{ minutes = $holdMinutes }) }
      if ($initial.holdUntil -gt $now) { throw (New-DrillError 'DRILL_HOST_CI_BUSY' 'a previous drill hold is still in force') }
      $tool = Get-DrillIntakeTool
      $clock = [Diagnostics.Stopwatch]::StartNew()
      $requestedAt = Get-DrillTime
      $wait = [TimeSpan]::FromMinutes($script:Drill.IntakeWaitMinutes)
      $resume = $true  # The CLI may have written the request before losing its reply.
      Request-DrillIntake $tool pause $holdMinutes
      while ($clock.Elapsed -lt $wait) {
        $deadline = (Get-DrillTime).AddMinutes($Minutes)
        $holdUntil = $deadline.AddMinutes($script:Drill.IntakeMarginMinutes)
        $safety = Get-DrillHostSafety -HoldUntil $holdUntil -StatusOnly
        if ($safety.ok -and $safety.holdSince -ge $requestedAt.AddMilliseconds(-1) -and
            $safety.holdUntil -ge $holdUntil -and $clock.Elapsed -lt $wait) {
          $window.deadline = $deadline
          $window.holdUntil = $holdUntil
          break
        }
        $remainingMs = ($wait - $clock.Elapsed).TotalMilliseconds
        if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min($remainingMs, $script:Drill.IntakePollSeconds * 1000)) }
      }
      if ($window.deadline -eq [DateTimeOffset]::MinValue) { throw (New-DrillError 'DRILL_HOST_CI_BUSY') }
    } elseif (-not $initial.ok) { throw (New-DrillError $initial.code $initial) }
    $result = & $Body $window
  } catch { $failure = Get-DrillCode $_ }
  finally {
    try {
      if ($resume -and $window.safeToResume) {
        try { Request-DrillIntake (Get-DrillIntakeTool) resume 0 } catch { $resumeFailure = Get-DrillCode $_ }
      }
    } finally {
      if ($locked) { $mutex.ReleaseMutex() }
      $mutex.Dispose()
    }
  }
  if ($failure) {
    if ($resumeFailure) { throw (New-DrillError $failure.code @{ failure = $failure.detail; resumeFailure = $resumeFailure }) }
    throw (New-DrillError $failure.code $failure.detail)
  }
  if ($resumeFailure) { throw (New-DrillError $resumeFailure.code @{ receipt = (Get-Prop $result 'receipt') }) }
  return $result
}

# Always revalidate name + notes before destructive Hyper-V operations. Never touch a VM we do not own.
function Stop-DrillOwnedVm([switch]$RestoreCheckpoint) {
  $info = Get-DrillVmInfo
  if ($null -eq $info) { throw (New-DrillError 'DRILL_VM_MISSING') }
  if ($info.notes -cne $script:Drill.Marker) { throw (New-DrillError 'DRILL_VM_NAME_TAKEN_NOT_OURS') }
  if ($info.state -ne 'Off') { Stop-VM -VM $info.vm -TurnOff -Force -ErrorAction Stop }
  if ($RestoreCheckpoint) {
    Restore-VMCheckpoint -VMName $script:Drill.VmName -Name $script:Drill.Checkpoint -Confirm:$false -ErrorAction Stop
  }
  return (Get-VM -Name $script:Drill.VmName -ErrorAction Stop).State -eq 'Off'
}

function Stop-DrillGuardedVm($Guard, [switch]$RestoreCheckpoint) {
  if (-not $Guard) { return (Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint) }
  $state = $Guard.state
  # The foreground and the aborting guard can both reach cleanup.
  [Threading.Monitor]::Enter($state.SyncRoot)
  try {
    $stopped = Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint
    if ($stopped) { $state.armed = $false; $state.stop = $true }
    return $stopped
  } finally { [Threading.Monitor]::Exit($state.SyncRoot) }
}

function Add-DrillExecutorObservation($State, $Safety) {
  $sample = Get-Prop $Safety 'executorObservation'
  if ($null -eq $sample) { return }
  $key = ConvertTo-DrillJson $sample
  if (-not $State.executorStates.Contains($key)) {
    $State.executorStates.Add($key, [ordered]@{
      state = $sample.state; reason = $sample.reason; current = $sample.current; firstSeenAt = $Safety.observedAt
    })
  }
}

# The receipt's free memory once the guest is up: the running gate's first reading and its lowest (Fable renew-key ruling, supplement
# "drill boot gate and the train both want DESK": what the host's usage did once the guest was up).
function Add-DrillRunningMemory($State, $Safety) {
  $free = Get-Prop $Safety 'freeGB'
  if ($null -eq $free -or $State -isnot [Collections.IDictionary]) { return }
  if ($null -eq $State['afterBootFreeGB']) { $State['afterBootFreeGB'] = $free }
  if ($null -eq $State['minRunningFreeGB'] -or $free -lt $State['minRunningFreeGB']) { $State['minRunningFreeGB'] = $free }
}

# The processes with the largest working sets (r9 follow-up 2.3: what to look at when the host ran short of memory under the drill).
function Get-DrillTopProcesses([int]$Count = 10) {
  @(Get-Process -ErrorAction Stop | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First $Count | ForEach-Object {
    $started = $null
    try { $started = ([DateTimeOffset]$_.StartTime).ToUniversalTime().ToString('o') } catch { $started = $null }   # a protected process does not say
    [ordered]@{ name = [string]$_.ProcessName; pid = [int]$_.Id; workingSetGB = [Math]::Round($_.WorkingSet64 / 1GB, 2); startedAt = $started }
  })
}

# Fable ruling 0e418483 "drill memory root" 2.3 (G1): the armed guard's cache release. Below CacheReleaseBelowBytes free, on a tick the
# running gate passed (below 6 GiB it aborts instead), at most once every CacheReleaseEverySeconds on the monotonic clock (Decision
# f572ac5b's "at most every 2 minutes": a wall clock step cannot shorten it; independent review of a643c4b42, suggestion 2) -- a release
# that failed counts too: no retry before the next window -- the one release function in its running use (-WhileRunning: a job there or
# not), bounded by CacheReleaseSeconds. Each release is a row of
# cacheReleases -- at, freeBeforeGB, exit (the release command's, per distribution it reached: one, a list, or null when none was
# reached), freeAfterGB (the next tick's reading, null if that tick read none), failed (the release's failure, or null) -- written to
# host-guard.json as it happens and again when the next tick fills freeAfterGB, in a run that ends well too; an abort record carries them.
# Nothing here aborts: a release that fails, times out or cannot be written is only recorded, or left out.
function Get-DrillCacheReleases($State) { @(if ($null -ne $State['cacheReleases']) { $State['cacheReleases'] }) }
function Write-DrillCacheReleases($State, [string]$RunDir) {
  try { Write-DrillJson (Join-Path $RunDir 'host-guard.json') ([ordered]@{ cacheReleases = @(Get-DrillCacheReleases $State) }) } catch { }
}
function Complete-DrillCacheRelease($State, $Safety) {
  $row = $State['releasePending']
  if ($null -eq $row) { return $false }
  $row.freeAfterGB = Get-Prop $Safety 'freeGB'; $State['releasePending'] = $null
  return $true
}
function Step-DrillCacheRelease($State, $Safety, [string]$RunDir) {
  $free = Get-Prop $Safety 'freeGB'
  if (-not $State.armed -or $State.stop -or (Get-Prop $Safety 'ok') -ne $true -or $null -eq $free -or
      [double]$free * 1GB -ge $script:Drill.CacheReleaseBelowBytes) { return }
  $since = Get-DrillMonotonicSeconds; $last = $State['lastReleaseSeconds']
  if ($null -ne $last -and $since - [double]$last -lt $script:Drill.CacheReleaseEverySeconds) { return }
  $State['lastReleaseSeconds'] = $since
  $row = [ordered]@{ at = (Get-DrillTime).ToUniversalTime().ToString('o'); freeBeforeGB = $free; exit = $null; freeAfterGB = $null; failed = $null }
  try {
    $out = Invoke-DrillWslCacheRelease -WhileRunning -WithinSeconds $script:Drill.CacheReleaseSeconds
    $exits = [Collections.ArrayList]::new()
    foreach ($r in @($out.results)) { if ((Get-Prop $r 'running') -eq $true) { [void]$exits.Add((Get-Prop $r 'exit')) } }
    $row.exit = if ($exits.Count -eq 1) { $exits[0] } elseif ($exits.Count -gt 1) { @($exits) } else { $null }
    $row.failed = $out.failed
  } catch { $c = Get-DrillCode $_; $row.failed = [ordered]@{ code = $c.code; detail = $c.detail } }
  if ($null -eq $State['cacheReleases']) { $State['cacheReleases'] = [Collections.ArrayList]::new() }
  [void]$State['cacheReleases'].Add($row); $State['releasePending'] = $row
  Write-DrillCacheReleases $State $RunDir
}

# A separate runspace owns this loop: guest jobs, Copy-Item, Read-Host and long waits cannot delay host protection.
# The start and abort share a lock, so an abort can never be followed by a late Start-VM.
function Invoke-DrillHostGuardLoop($State, [string]$RunDir, [switch]$RestoreCheckpoint) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    while (-not $State.stop) {
      if (-not $State.ready -or $clock.Elapsed.TotalSeconds -ge $script:Drill.HostGuardSeconds) {
        $clock.Restart()
        [Threading.Monitor]::Enter($State.SyncRoot)
        try {
          if ($State.stop) { return }
          $safety = Get-DrillGuardSafety $State
          $completed = $false
          if ($State.armed) { Add-DrillExecutorObservation $State $safety; Add-DrillRunningMemory $State $safety; $completed = Complete-DrillCacheRelease $State $safety }
          if (-not $safety.ok) { $State.failure = @{ code = $safety.code; detail = $safety } }
          elseif ($completed) { Write-DrillCacheReleases $State $RunDir }   # an abort writes its own record, with them
          $State.ready = $true
        } finally { [Threading.Monitor]::Exit($State.SyncRoot) }
        if ($State.failure) { break }
        # outside the lock: a release (up to CacheReleaseSeconds) never holds up the foreground's start or stop
        Step-DrillCacheRelease $State $safety $RunDir
      }
      Start-Sleep -Milliseconds 200
    }
  } catch { $State.failure = @{ code = 'DRILL_HOST_GUARD_FAILED'; detail = (Get-DrillCode $_) } }
  finally {
    $State.ready = $true
    [Threading.Monitor]::Enter($State.SyncRoot)
    try {
      if ($State.failure -and $State.armed) {
        $receipt = [ordered]@{ status = 'DRILL_ABORTED'; code = $State.failure.code; detail = $State.failure.detail;
          hostExecutorStates = @($State.executorStates.Values); cacheReleases = @(Get-DrillCacheReleases $State);
          abortedAt = [DateTimeOffset]::UtcNow.ToString('o'); restoredToCheckpoint = $false; stopped = $false; cleanupFailure = $null; cleanupDone = $false }
        # short of memory: who held it, read before the shutdown changes the picture -- the host's largest processes; one that cannot be
        # read is left out. What the runner distribution holds (G2) is read after the shutdown (below)
        $short = [string]$State.failure.code -ceq 'DRILL_HOST_MEMORY_SHORT'
        if ($short) {
          try { $top = @(Get-DrillTopProcesses); if ($top.Count) { $receipt['topProcesses'] = $top } } catch { }
        }
        # Persist the reason before cleanup, then its outcome. A receipt write failure must never prevent shutdown.
        try { Write-DrillJson (Join-Path $RunDir 'host-guard.json') $receipt } catch { }
        try {
          $receipt.stopped = Stop-DrillOwnedVm -RestoreCheckpoint:$RestoreCheckpoint
          $receipt.restoredToCheckpoint = $RestoreCheckpoint -and $receipt.stopped
        } catch { $receipt.cleanupFailure = Get-DrillCode $_ }
        # the runner distribution's memory (G2), after the shutdown: the guest's stop changes nothing in WSL's meminfo, and a slow WSL
        # (up to CacheReleaseSeconds) never holds up the stop of a host already short (independent review of a643c4b42, suggestion 1)
        if ($short) { try { $wm = @(Get-DrillWslMemory); if ($wm.Count) { $receipt['wslMemory'] = $wm } } catch { } }
        # the record says the cleanup ran (Get-DrillGuardOutcome): one left from before it says "not known", never "restored"
        $receipt.cleanupDone = $true
        $State.cleanup = $receipt
        try { Write-DrillJson (Join-Path $RunDir 'host-guard.json') $receipt } catch { $State.receiptFailure = $true }
      }
    } finally { [Threading.Monitor]::Exit($State.SyncRoot) }
  }
}

# Before the boot (not armed) the guard watches the duty and the hold only: runner jobs and memory are the boot gate's, judged once, in
# Start-DrillGuardedVm (-BootGate). Armed, it is the running gate. (Codex review of 74e7a65e7, high 2.)
function Get-DrillGuardSafety($State, [switch]$BootGate, $WslMemory = $null) {
  $deadline = Get-Prop $State 'deadline'
  if ($deadline -and $deadline -ne [DateTimeOffset]::MinValue -and (Get-DrillTime) -ge $deadline) {
    return @{ ok = $false; code = 'DRILL_RUN_TIMEOUT'; deadline = $deadline }
  }
  $holdUntil = Get-Prop $State 'holdUntil'
  if ($null -eq $holdUntil) { $holdUntil = [DateTimeOffset]::MinValue }
  if (-not $State.armed -and -not $BootGate) { return Get-DrillHostSafety -HoldUntil $holdUntil -StatusOnly }
  return Get-DrillHostSafety -Running:$State.armed -HoldUntil $holdUntil -WslMemory $WslMemory
}

function Start-DrillHostGuard([string]$RunDir, [switch]$RestoreCheckpoint, $Window) {
  $state = [hashtable]::Synchronized(@{ stop = $false; ready = $false; armed = $false; failure = $null; cleanup = $null; afterBootFreeGB = $null; minRunningFreeGB = $null;
    cacheReleases = [Collections.ArrayList]::new(); releasePending = $null; lastReleaseSeconds = $null;
    executorStates = [Collections.Specialized.OrderedDictionary]::new([StringComparer]::Ordinal);
    deadline = (Get-Prop $Window 'deadline'); holdUntil = (Get-Prop $Window 'holdUntil') })
  $worker = [PowerShell]::Create()
  # The guard reads the time as the run that started it does: one clock for the gate and the guard (task ce2e5c1a step 2). Loading the
  # script afresh gives the same Get-DrillTime in production; a run whose Get-DrillTime differs hands its own over, as text.
  [void]$worker.AddScript({ param($file, $config, $state, $dir, $restore, $clock)
    . $file
    $script:Drill = $config
    if ([string]${function:Get-DrillTime} -cne $clock) { Set-Item -LiteralPath function:Get-DrillTime -Value ([scriptblock]::Create($clock)) }
    Invoke-DrillHostGuardLoop $state $dir -RestoreCheckpoint:$restore
  }).AddArgument($script:DrillScriptPath).AddArgument($script:Drill).AddArgument($state).AddArgument($RunDir).AddArgument([bool]$RestoreCheckpoint).AddArgument([string]${function:Get-DrillTime})
  $guard = @{ worker = $worker; pending = $worker.BeginInvoke(); state = $state }
  $script:HostGuard = $guard
  $until = [DateTime]::UtcNow.AddSeconds(15)
  while (-not $state.ready -and -not $guard.pending.IsCompleted -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 50 }
  if (-not $state.ready) { $state.failure = @{ code = 'DRILL_HOST_GUARD_FAILED'; detail = 'guard did not become ready' } }
  return $guard
}

function Assert-DrillGuard {
  if ($script:HostGuard) {
    $guard = $script:HostGuard
    if ($guard.state.failure) { throw (New-DrillError $guard.state.failure.code $guard.state.failure.detail) }
    if (-not $guard.state.ready -or $guard.pending.IsCompleted) { throw (New-DrillError 'DRILL_HOST_GUARD_FAILED') }
  }
}

# $Watchdog (from Start-DrillBootWatchdog) is checked alive after the starting signal and right before Start-VM.
function Start-DrillGuardedVm($Watchdog) {
  if (-not $script:HostGuard) { throw (New-DrillError 'DRILL_HOST_GUARD_FAILED') }
  $state = $script:HostGuard.state
  # the boot gate's sample carries what the runner distribution holds (Fable ruling 0e418483 supplement "three questions after the
  # implementation" 1): the abort's reader and shape, read right before the gate and outside the lock (the guard is not held up), so a
  # refusal has it too. The gate counts its MemFree as taken, or the cap of one not running (Test-DrillHostMemory; Fable plan 87d330d0):
  # one not read is left out of the sample and refuses the boot, its reason in bootGate.wslMemoryUnreadable (the reader's code).
  $wslMemory = $null; $wslUnread = $null
  try { $wslMemory = @(Get-DrillWslMemory -IdleCap) } catch { $wslMemory = $null; $wslUnread = (Get-DrillCode $_).code }
  [Threading.Monitor]::Enter($state.SyncRoot)
  try {
    Assert-DrillGuard
    # the boot gate: both sides' runner jobs again, then memory, judged here once
    $safety = Get-DrillGuardSafety $state -BootGate -WslMemory $wslMemory
    if ($script:DrillPreBoot) {
      $script:DrillPreBoot.bootGate = ConvertTo-DrillGateTrace $safety
      if ($null -ne $wslMemory -and $wslMemory.Count) { $script:DrillPreBoot.bootGate['wslMemory'] = $wslMemory }
      if ($null -ne $wslUnread) { $script:DrillPreBoot.bootGate['wslMemoryUnreadable'] = $wslUnread }
    }
    if ($null -ne $wslUnread) { $safety['wslMemoryUnreadable'] = $wslUnread }
    if (-not $safety.ok) { throw (New-DrillError $safety.code $safety) }
    if ($Watchdog) {
      [IO.File]::WriteAllText("$(Get-Prop $Watchdog 'signal').starting", 'starting')
      Assert-DrillWatchdogAlive $Watchdog
    }
    Start-VM -Name $script:Drill.VmName -ErrorAction Stop
    $state.armed = $true
    Add-DrillExecutorObservation $state $safety
  } finally { [Threading.Monitor]::Exit($state.SyncRoot) }
}

function Stop-DrillHostGuard($Guard) {
  if (-not $Guard) { return }
  $Guard.state.stop = $true
  try { [void]$Guard.worker.EndInvoke($Guard.pending) }
  catch {
    $Guard.state.failure = @{ code = 'DRILL_HOST_GUARD_FAILED'; detail = @{ endInvoke = (Get-DrillCode $_); priorFailure = $Guard.state.failure } }
  } finally {
    try { $Guard.worker.Dispose() }
    finally { $script:HostGuard = $null }
  }
}

function Test-DrillHyperVAdministrator {
  @([Security.Principal.WindowsIdentity]::GetCurrent().Groups | ForEach-Object { $_.Value }) -contains 'S-1-5-32-578'
}

function Assert-DrillHost([DateTimeOffset]$HoldUntil = [DateTimeOffset]::MinValue) {
  $mem = Assert-DrillHostSafety -HoldUntil $HoldUntil
  if (-not (Test-DrillHyperVAdministrator)) { throw (New-DrillError 'DRILL_NOT_IN_HYPERV_ADMINISTRATORS') }
  $d = Get-PSDrive -Name D
  if ($d.Free -lt $script:Drill.MinDiskFreeBytes) { throw (New-DrillError 'DRILL_DISK_SHORT' @{ freeGB = [Math]::Round($d.Free / 1GB) }) }
  if (-not (Get-VMSwitch -Name $script:Drill.Switch -ErrorAction SilentlyContinue)) { throw (New-DrillError 'DRILL_SWITCH_MISSING') }
  return $mem
}

# The drill's two credentials, one place (D:\clued-drill, DPAPI, this Windows user only) and one reader: the guest's administrator (made
# by the baseline) and, with -Binding, the Owner's drill binding in the drill's server (handed over once: Save-DrillBindingCredential).
# The binding: user name = the connection id, password = the clued_bnd_ token (the shape first-install-host.ps1 takes). Missing or of
# another shape, the drill refuses before any boot; nothing is made in its place.
function Test-DrillBindingCredential($Credential) {
  if ($Credential -isnot [System.Management.Automation.PSCredential]) { return $false }
  $g = [guid]::Empty
  if ([string]$Credential.UserName -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or -not [guid]::TryParse([string]$Credential.UserName, [ref]$g) -or $g -eq [guid]::Empty) { return $false }
  return ($Credential.GetNetworkCredential().Password -cmatch '^clued_bnd_[A-Za-z0-9_-]{8,480}\z')
}
# The test project's database password (-ServerDatabaseCredential; the ruling on the PR-A report, section 1: the sync runs on this host
# and its password is kept where the binding is). User name: postgres.<the project's ref>, the one the session pooler routes by, from
# drill-server.json's address (its one place); password: printable ASCII on one line (standard input carries it as it is in any code
# page). Another user name -- another project's, production's -- is not this credential.
function Get-DrillServerDatabaseUser {
  $url = [string](Get-Prop (Read-DrillJson (Join-Path (Split-Path -Parent $script:DrillScriptPath) 'drill-server.json')) 'supabaseUrl')
  if ($url -cnotmatch '^https://([a-z0-9]{20})\.supabase\.co$') { throw (New-DrillError 'DRILL_SERVER_REFUSED' 'drill-server.json supabaseUrl') }
  "postgres.$($Matches[1])"
}
function Test-DrillServerDatabaseCredential($Credential) {
  if ($Credential -isnot [System.Management.Automation.PSCredential]) { return $false }
  if (-not [string]::Equals([string]$Credential.UserName, (Get-DrillServerDatabaseUser), [StringComparison]::Ordinal)) { return $false }
  return ($Credential.GetNetworkCredential().Password -cmatch '^[\x21-\x7e](?:[\x20-\x7e]{0,510}[\x21-\x7e])?\z')
}
function Get-DrillCredential([switch]$Binding, [switch]$ServerDatabase) {
  if ($ServerDatabase) {
    if (-not (Test-Path -LiteralPath $script:Drill.ServerDatabaseCredential -PathType Leaf)) { throw (New-DrillError 'DRILL_SERVER_DATABASE_CREDENTIAL_MISSING' 'hand the test project''s database password over once: drill-vm.ps1 -ServerDatabaseCredential') }
    $d = try { Import-Clixml -LiteralPath $script:Drill.ServerDatabaseCredential } catch { $null }
    if (-not (Test-DrillServerDatabaseCredential $d)) { throw (New-DrillError 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED' 'not the test project''s database user with a password, or not readable by this Windows user: hand it over again') }
    return $d
  }
  if ($Binding) {
    if (-not (Test-Path -LiteralPath $script:Drill.BindingCredential -PathType Leaf)) { throw (New-DrillError 'DRILL_BINDING_CREDENTIAL_MISSING' 'hand the drill binding over once: drill-vm.ps1 -BindingCredential') }
    $b = try { Import-Clixml -LiteralPath $script:Drill.BindingCredential } catch { $null }
    if (-not (Test-DrillBindingCredential $b)) { throw (New-DrillError 'DRILL_BINDING_CREDENTIAL_REFUSED' 'not a connection id with a clued_bnd_ token, or not readable by this Windows user') }
    return $b
  }
  if (-not (Test-Path -LiteralPath $script:Drill.Credential)) { throw (New-DrillError 'DRILL_GUEST_CREDENTIAL_MISSING') }
  Import-Clixml -LiteralPath $script:Drill.Credential   # DPAPI, this Windows user only
}

# The Owner hands the drill binding over, once (-BindingCredential): the Windows credential dialog itself (credui.dll
# CredUIPromptForCredentialsW, as first-install-host.ps1 Read-TokenFromDialog: generic credentials, always shown, never saved by Windows),
# never the console's prompt. User name: the connection id; password: the token. Held to its shape, then written where the guest
# credential is (DPAPI, this Windows user only). The token is never printed, logged or passed on a command line.
function Read-DrillBindingFromDialog {
  Read-DrillCredentialFromDialog 'Clued drill binding' 'Clued drill binding (clued-auth-test)' 'User name: the connection id of the drill binding in the TEST project (no ci-admission role). Password: its clued_bnd_ token. Stored for this Windows user only; never shown.' ([string]$BindingConnection).Trim().ToLowerInvariant() 'DRILL_BINDING_DIALOG'
}
# The test project's database password, the same dialog: the user name is filled in (an emptied box falls back to it),
# the Owner pastes the password reset in the Supabase dashboard (clued-auth-test, Database, reset password).
function Read-DrillServerDatabaseFromDialog {
  Read-DrillCredentialFromDialog 'Clued drill test database' 'Clued drill test database (clued-auth-test)' 'User name: leave it as it is (empty is fine). Password: the database password of the TEST project clued-auth-test (Supabase dashboard, Database, reset password). Never production. Stored for this Windows user only; never shown.' (Get-DrillServerDatabaseUser) 'DRILL_SERVER_DATABASE_DIALOG'
}
# $User: filled in (editable; an emptied box falls back to it); empty: the person types it. $Codes: the prefix of the two stops (_CANCELLED, _FAILED).
function Read-DrillCredentialFromDialog([string]$Target, [string]$Caption, [string]$Message, [string]$User, [string]$Codes) {
  if (-not ('CluedDrillCredUiV2' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class CluedDrillCredUiV2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Info { public int cbSize; public IntPtr hwndParent; public string pszMessageText; public string pszCaptionText; public IntPtr hbmBanner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)]
  static extern int CredUIPromptForCredentialsW(ref Info info, string target, IntPtr reserved, int authError, StringBuilder user, int userMax, IntPtr password, int passwordMax, ref bool save, int flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  public const int PasswordChars = 513;
  // GENERIC_CREDENTIALS 0x40000 | ALWAYS_SHOW_UI 0x80 | EXCLUDE_CERTIFICATES 0x8 | DO_NOT_PERSIST 0x2
  public const int Flags = 0x40000 | 0x80 | 0x8 | 0x2;
  // No KEEP_USERNAME (0x100000): with it CredUIPromptForCredentialsW answered 87 (ERROR_INVALID_PARAMETER) on the Owner's
  // DESK 11-24. The user name is filled in and stays editable; the caller checks it is exactly the expected one.
  public static int Prompt(StringBuilder user, string target, string caption, string message, IntPtr password, bool keepUser) {
    Info i = new Info(); i.cbSize = Marshal.SizeOf(typeof(Info)); i.hwndParent = GetConsoleWindow(); i.pszCaptionText = caption; i.pszMessageText = message;
    bool save = false;
    return CredUIPromptForCredentialsW(ref i, target, IntPtr.Zero, 0, user, user.Capacity, password, PasswordChars, ref save, Flags);
  }
}
'@
  }
  $size = [CluedDrillCredUiV2]::PasswordChars * 2; $zero = New-Object byte[] $size
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    [Runtime.InteropServices.Marshal]::Copy($zero, 0, $buf, $size)
    # Not $user: PowerShell names are case-insensitive, and it would overwrite the parameter $User.
    $nameBuf = New-Object Text.StringBuilder 514
    if ($User) { [void]$nameBuf.Append($User) }
    $rc = [CluedDrillCredUiV2]::Prompt($nameBuf, $Target, $Caption, $Message, $buf, [bool]$User)
    if ($rc -eq 1223) { throw (New-DrillError "$($Codes)_CANCELLED") }
    if ($rc -ne 0) { throw (New-DrillError "$($Codes)_FAILED" $rc) }
    $secure = New-Object Security.SecureString
    for ($n = 0; $n -lt [CluedDrillCredUiV2]::PasswordChars; $n++) {
      $c = [Runtime.InteropServices.Marshal]::ReadInt16($buf, $n * 2); if ($c -eq 0) { break }
      $secure.AppendChar([char]$c)
    }
    $secure.MakeReadOnly()
    # An emptied field means the expected name.
    $name = $nameBuf.ToString().Trim(); if (-not $name) { $name = $User }
    New-Object System.Management.Automation.PSCredential ($name.ToLowerInvariant()), $secure
  } finally { [Runtime.InteropServices.Marshal]::Copy($zero, 0, $buf, $size); [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
}
# $Read: where the credential comes from (the dialog; a test gives its own).
function Save-DrillBindingCredential([scriptblock]$Read = { Read-DrillBindingFromDialog }) {
  $b = & $Read
  if (-not (Test-DrillBindingCredential $b)) { throw (New-DrillError 'DRILL_BINDING_CREDENTIAL_REFUSED' 'not a connection id with a clued_bnd_ token; nothing was stored') }
  $dir = Split-Path -Parent $script:Drill.BindingCredential
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw (New-DrillError 'DRILL_BINDING_DIRECTORY_MISSING' $dir) }
  $b | Export-Clixml -LiteralPath $script:Drill.BindingCredential -Force
  [void](Get-DrillCredential -Binding)   # read back through the one reader
  return [ordered]@{ status = 'DRILL_BINDING_STORED'; connection = [string]$b.UserName; file = $script:Drill.BindingCredential }
}

# -ServerDatabaseCredential: the Owner hands over the test project's database password, once (and again only after another reset).
# $Read: where the credential comes from (the dialog; a test gives its own). Held to its shape, written where the binding is (DPAPI, this
# Windows user only) and read back through the one reader; what is printed carries the user name and the file, never the password.
function Save-DrillServerDatabaseCredential([scriptblock]$Read = { Read-DrillServerDatabaseFromDialog }) {
  $d = & $Read
  if (-not (Test-DrillServerDatabaseCredential $d)) { throw (New-DrillError 'DRILL_SERVER_DATABASE_CREDENTIAL_REFUSED' 'not the test project''s database user with a one-line printable password; nothing was stored') }
  $dir = Split-Path -Parent $script:Drill.ServerDatabaseCredential
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw (New-DrillError 'DRILL_SERVER_DATABASE_DIRECTORY_MISSING' $dir) }
  $d | Export-Clixml -LiteralPath $script:Drill.ServerDatabaseCredential -Force
  [void](Get-DrillCredential -ServerDatabase)   # read back through the one reader
  return [ordered]@{ status = 'DRILL_SERVER_DATABASE_CREDENTIAL_STORED'; user = [string]$d.UserName; file = $script:Drill.ServerDatabaseCredential }
}

# Send Enter through the VM's synthetic keyboard for a few seconds: "Press any key to boot from CD or DVD".
function Send-DrillBootKeys([string]$VmName, [int]$Seconds) {
  $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$VmName'"
  $kb = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_Keyboard
  $until = [DateTime]::UtcNow.AddSeconds($Seconds); $sent = 0
  while ([DateTime]::UtcNow -lt $until) {
    Assert-DrillGuard
    $r = Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = [uint32]13 }
    if ($r.ReturnValue -eq 0) { $sent++ }
    Start-Sleep -Milliseconds 400
  }
  return $sent
}

# The VM's screen as a BMP (evidence when an unattended step times out).
function Save-DrillScreen([string]$VmName, [string]$Path) {
  try {
    $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$VmName'"
    $svc = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
    $sd = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_VirtualSystemSettingData | Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
    $w = 1024; $h = 768
    $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $sd; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h }
    if ($r.ReturnValue -ne 0 -or $null -eq $r.ImageData) { return $null }
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    [Runtime.InteropServices.Marshal]::Copy([byte[]]$r.ImageData, 0, $data.Scan0, [Math]::Min($r.ImageData.Length, $data.Stride * $h))
    $bmp.UnlockBits($data); $bmp.Save($Path); $bmp.Dispose()
    return $Path
  } catch { return $null }
}

# The guest's KVP item $Name, read on the host (no logon in the guest); $null when the guest has not published it.
function Get-DrillGuestKvp([string]$Name) {
  try {
    $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$($script:Drill.VmName)'"
    $kvp = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_KvpExchangeComponent
    return Get-DrillKvpValue @($kvp.GuestExchangeItems) $Name
  } catch { return $null }
}

# Waits, logging on nowhere, until SetupComplete.cmd has published the setup signal (setup is over; OOBE starts).
function Wait-DrillSetupSignal([int]$Minutes) {
  $until = [DateTime]::UtcNow.AddMinutes($Minutes)
  while ([DateTime]::UtcNow -lt $until) {
    Assert-DrillGuard
    if ((Get-DrillGuestKvp $script:Drill.SetupSignalName) -ceq 'complete') { return }
    Start-Sleep -Seconds 20
  }
  throw (New-DrillError 'DRILL_BASELINE_INSTALL_TIMEOUT' @{ minutes = $Minutes; signal = 'no setup-complete KVP item' })
}

# One readiness probe inside the guest (read-only): this boot's time and how far Windows setup is.
$script:GuestProbe = {
  $setup = Get-ItemProperty -Path 'HKLM:\SYSTEM\Setup'
  $state = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State' -ErrorAction SilentlyContinue
  @{ boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
     imageState = $(if ($state) { [string]$state.ImageState } else { '' })
     oobe = $(if ($setup.PSObject.Properties['OOBEInProgress']) { [int]$setup.OOBEInProgress } else { 0 }) }
}
function Get-DrillGuestProbe([pscredential]$Credential) {
  Assert-DrillGuard
  try { return Invoke-Command -VMName $script:Drill.VmName -Credential $Credential -ErrorAction Stop -ScriptBlock $script:GuestProbe } catch { return $null }
}

function Wait-DrillGuest([pscredential]$Credential, [int]$Minutes, [DateTimeOffset]$After = [DateTimeOffset]::MinValue) {
  $until = [DateTime]::UtcNow.AddMinutes($Minutes); $candidate = $null; $last = $null
  while ([DateTime]::UtcNow -lt $until) {
    $probe = Get-DrillGuestProbe $Credential
    if ($probe) { $last = $probe }
    $step = Step-DrillReadiness $candidate $probe $After
    if ($step.ready) { return [DateTimeOffset]::Parse($step.candidate, [Globalization.CultureInfo]::InvariantCulture) }
    $candidate = $step.candidate
    Start-Sleep -Seconds 20
  }
  throw (New-DrillError 'DRILL_GUEST_NOT_READY_IN_TIME' @{ minutes = $Minutes; lastProbe = $last })
}

# Fable plan 87d330d0 section 2.2 (甲1-甲3) and 2.4 (D:/w/tmp/PLAN-drill-loop-root-20261123.md): a long guest step is waited on in ticks
# (GuestTickSeconds), never in one blocking wait. Each tick asks the host guard first, then the step's $Until (an @{ at; code; detail } the
# run gives: the foreground deadline, or the after-entry limit) and, for the first install, pulls the progress files back ($Progress).
# The step's own limit is counted on the monotonic clock.
function Get-DrillEvidenceWindowMinutes([double]$RunMinutes) {
  # the foreground stops this long before the guard's deadline so the evidence is taken first: 30 % of the run, at most
  # EvidenceWindowMinutes, never under EvidenceWindowMinMinutes (a 10-minute run: 3 minutes; coordinator, Owner 11-23)
  $w = [Math]::Min([double]$script:Drill.EvidenceWindowMinutes, $RunMinutes * [double]$script:Drill.EvidenceWindowShare)
  return [Math]::Round([Math]::Max([double]$script:Drill.EvidenceWindowMinMinutes, $w), 2)
}
function Assert-DrillUntil($Until) {
  if ($null -ne $Until -and (Get-DrillTime) -ge $Until.at) { throw (New-DrillError $Until.code $Until.detail) }
}
# The earlier of two limits (either may be $null).
function Get-DrillEarlierUntil($A, $B) { if ($null -eq $A) { return $B }; if ($null -eq $B) { return $A }; if ($B.at -lt $A.at) { return $B }; return $A }

# 甲1: the files pulled back each tick while the first install runs (guest name -> run directory name). Written only when their length
# changed; the evidence collection after the step overwrites them with its own copies. stage-progress.jsonl is the entry's own record of
# each stage it entered and ended (first-install-entry.ps1 Write-EntryStageProgress).
$script:DrillProgressFiles = [ordered]@{ 'first-install.stdout.log' = 'first-install.log'; 'stage-progress.jsonl' = 'stage-progress.jsonl'
  'host.stdout.log' = 'host.stdout.log'; 'prepare.stdout.log' = 'prepare.stdout.log'; 'launcher.stdout.log' = 'launcher.stdout.log' }
# 2.4: the stage the first install is in is the latest one whose log has appeared, in this order (entry: none yet)
$script:DrillProgressStageLogs = [ordered]@{ host = 'host.stdout.log'; prepare = 'prepare.stdout.log'; launcher = 'launcher.stdout.log' }

# Review low 5 (fix round 1 of 87d330d0): Remove-Job -Force on a PowerShell Direct job still running is a synchronous StopJob, which a busy
# guest can hold for minutes -- the foreground stalled past its own stop. A job that ended is removed; one still running is stopped without
# waiting (its own StopJobAsync, else StopJob on a runspace of its own) and removed by a later call once it has ended.
$script:DrillStoppingJobs = New-Object Collections.Generic.List[object]
function Stop-DrillJob($Job, [bool]$Ended) {
  if ($null -eq $Job) { return }
  if ($Ended) { Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue }
  else {
    $stopper = $null
    try {
      if ($null -ne $Job.PSObject.Methods['StopJobAsync']) { $Job.StopJobAsync() }
      else {
        $stopper = [PowerShell]::Create()
        [void]$stopper.AddScript('param($j) try { $j.StopJob() } catch { }').AddArgument($Job)
        $stopper = @{ ps = $stopper; handle = $stopper.BeginInvoke() }
      }
    } catch { }
    $script:DrillStoppingJobs.Add(@{ job = $Job; stopper = $stopper })
  }
  # the ones stopped earlier that have ended since: removed now (never waited on)
  foreach ($s in @($script:DrillStoppingJobs.ToArray())) {
    $state = [string](Get-DrillField $s.job 'State')
    if (@('Completed', 'Failed', 'Stopped') -cnotcontains $state) { continue }
    if ($null -ne $s.stopper -and -not $s.stopper.handle.IsCompleted) { continue }
    Remove-Job -Job $s.job -Force -ErrorAction SilentlyContinue
    if ($null -ne $s.stopper) { try { $s.stopper.ps.Dispose() } catch { } }
    [void]$script:DrillStoppingJobs.Remove($s)
  }
}

# One pull, bounded (GuestPullSeconds), never through Invoke-DrillGuest (no readiness wait of its own); $null when it did not answer.
function Read-DrillGuestProgressFiles([pscredential]$Credential) {
  Assert-DrillGuard
  $job = $null; $ended = $false
  try {
    $job = Invoke-Command -VMName $script:Drill.VmName -Credential $Credential -ScriptBlock $script:GuestStageFiles -ArgumentList @(($script:Drill.GuestWork + '\work'), [string[]]@($script:DrillProgressFiles.Keys)) -AsJob
    if (-not (Wait-Job -Job $job -Timeout $script:Drill.GuestPullSeconds)) { return $null }
    $ended = $true
    return Receive-Job -Job $job -ErrorAction Stop
  } catch { return $null }
  finally { Stop-DrillJob $job $ended }
}

function New-DrillGuestProgress([string]$RunDir) {
  $now = Get-DrillTime; $t = Get-DrillMonotonicSeconds
  return [ordered]@{ runDir = $RunDir; startedAt = $now.ToString('o'); startMono = $t; at = $null; ticks = 0; failedPulls = 0; consecutiveFailedPulls = 0
    pullFailingSince = $null; stage = 'entry'; stageSince = $now.ToString('o'); stageMono = $t; lastGrowthAt = $now.ToString('o'); growthMono = $t; files = [ordered]@{}; stop = $null }
}

# 2.4: the no-progress gate of the stage the first install is in; $null while it is within it.
function Get-DrillProgressStop($P, [double]$Now) {
  $stageSeconds = [Math]::Round($Now - $P.stageMono); $sinceGrowth = [Math]::Round($Now - $P.growthMono)
  $at = { param($reason, $limit) [ordered]@{ stage = $P.stage; reason = $reason; limitMinutes = $limit; stageSeconds = $stageSeconds; sinceGrowthSeconds = $sinceGrowth; lastGrowthAt = $P.lastGrowthAt
    failedPulls = $P.failedPulls; progress = 'guest-progress.json' } }
  if ($P.stage -ceq 'entry') {
    if ($stageSeconds -ge $script:Drill.EntryHostLogMinutes * 60) { return (& $at 'host-log-not-started' $script:Drill.EntryHostLogMinutes) }
    return $null
  }
  $gate = $script:Drill.ProgressGates[$P.stage]
  if ($null -eq $gate) { return $null }
  if ($null -ne $gate.stallMinutes -and $sinceGrowth -ge $gate.stallMinutes * 60) { return (& $at 'stalled' $gate.stallMinutes) }
  if ($null -ne $gate.maxMinutes -and $stageSeconds -ge $gate.maxMinutes * 60) { return (& $at 'stage-over-limit' $gate.maxMinutes) }
  return $null
}

# One tick of the first install's progress: pull, write what grew, find the stage, judge its gate, record guest-progress.json; a gate
# reached stops the step with DRILL_GUEST_NO_PROGRESS (the run then takes the evidence and restores, as on any end of the first install).
# Review medium 3: a pull that did not answer says nothing about the guest, so it is never "no growth": the gate is judged only on a tick
# whose pull answered. Failed pulls are counted on their own (failedPulls, consecutiveFailedPulls, pullFailingSince) and never stop the
# run by themselves -- the progress pull is an aid; the run's own deadline bounds a guest that does not answer.
function Step-DrillGuestProgress([Collections.IDictionary]$P, [pscredential]$Credential) {
  $got = Read-DrillGuestProgressFiles $Credential
  $now = Get-DrillTime; $t = Get-DrillMonotonicSeconds
  $P.ticks = [int]$P.ticks + 1; $P.at = $now.ToString('o')
  if ($null -eq $got) {
    $P.failedPulls = [int]$P.failedPulls + 1; $P.consecutiveFailedPulls = [int]$P.consecutiveFailedPulls + 1
    if ($null -eq $P.pullFailingSince) { $P.pullFailingSince = $now.ToString('o') }
  } else {
    $P.consecutiveFailedPulls = 0; $P.pullFailingSince = $null
    foreach ($name in @($script:DrillProgressFiles.Keys)) {
      $f = Get-DrillField $got $name
      if ((Get-DrillField $f 'present') -ne $true -or (Get-DrillField $f 'error')) { continue }
      $text = [string](Get-DrillField $f 'text')
      $prev = $P.files[$name]
      if ($null -ne $prev -and $prev.bytes -eq $text.Length) { continue }
      $saved = $true
      try { [IO.File]::WriteAllText((Join-Path $P.runDir $script:DrillProgressFiles[$name]), $text, (New-Object Text.UTF8Encoding($false))) } catch { $saved = $false }
      $P.files[$name] = [ordered]@{ bytes = $text.Length; changedAt = $now.ToString('o'); changedMono = $t; saved = $saved }
    }
  }
  $stage = 'entry'
  foreach ($s in @($script:DrillProgressStageLogs.Keys)) { if ($P.files.Contains($script:DrillProgressStageLogs[$s])) { $stage = $s } }
  if ($stage -cne $P.stage) { $P.stage = $stage; $P.stageSince = $now.ToString('o'); $P.stageMono = $t }
  if ($stage -cne 'entry') {
    $log = $P.files[$script:DrillProgressStageLogs[$stage]]
    $P.growthMono = $log.changedMono; $P.lastGrowthAt = $log.changedAt
  }
  if ($null -ne $got) { $P.stop = Get-DrillProgressStop $P $t }
  $record = [ordered]@{}
  foreach ($k in @('startedAt', 'at', 'ticks', 'failedPulls', 'consecutiveFailedPulls', 'pullFailingSince', 'stage', 'stageSince', 'lastGrowthAt')) { $record[$k] = $P[$k] }
  $record.files = [ordered]@{}
  foreach ($k in @($P.files.Keys)) { $record.files[$k] = [ordered]@{ bytes = $P.files[$k].bytes; changedAt = $P.files[$k].changedAt; saved = $P.files[$k].saved } }
  $record.gates = [ordered]@{ entryHostLogMinutes = $script:Drill.EntryHostLogMinutes; stages = $script:Drill.ProgressGates }
  $record.stop = $P.stop
  try { Write-DrillJson (Join-Path $P.runDir 'guest-progress.json') $record } catch { }
  if ($null -ne $P.stop) { throw (New-DrillError 'DRILL_GUEST_NO_PROGRESS' $P.stop) }
}

# Run one step in the guest, bounded. A failure is classified by the guest's boot time, never by the (localized) message:
#   the guest restarted under the step -> a restartable (idempotent) step waits for the guest to be ready and runs again, at
#   most twice; any other step stops with DRILL_GUEST_RESTARTED_DURING_STEP; the same boot -> DRILL_GUEST_STEP_FAILED.
function Invoke-DrillGuest([pscredential]$Credential, [scriptblock]$Script, [object[]]$ArgumentList = @(), [int]$TimeoutMinutes = 10,
    [string]$Code = 'DRILL_GUEST_STEP_TIMEOUT', [string]$Step = 'guest-step', [switch]$Restartable, $Until = $null, [Collections.IDictionary]$Progress = $null) {
  for ($restarts = 0; ; $restarts++) {
    $probe = Get-DrillGuestProbe $Credential
    if ($null -eq $probe) { [void](Wait-DrillGuest $Credential 20); $probe = Get-DrillGuestProbe $Credential }
    $before = if ($probe) { [string]$probe.boot } else { '' }
    $job = Invoke-Command -VMName $script:Drill.VmName -Credential $Credential -ScriptBlock $Script -ArgumentList $ArgumentList -AsJob
    $ended = $false
    try {
      $limit = $TimeoutMinutes * 60; $started = Get-DrillMonotonicSeconds
      while ($true) {
        Assert-DrillGuard
        Assert-DrillUntil $Until
        $left = $limit - ((Get-DrillMonotonicSeconds) - $started)
        if ($left -le 0) { throw (New-DrillError $Code @{ step = $Step; minutes = $TimeoutMinutes }) }
        $tick = [Math]::Min($left, [double]$script:Drill.GuestTickSeconds)
        if ($null -ne $Until) { $tick = [Math]::Min($tick, ($Until.at - (Get-DrillTime)).TotalSeconds) }
        if (Wait-Job -Job $job -Timeout ([int][Math]::Max(1, [Math]::Ceiling($tick)))) { $ended = $true; break }
        if ($null -ne $Progress) { Step-DrillGuestProgress $Progress $Credential }
      }
      return Receive-Job -Job $job -ErrorAction Stop
    } catch {
      $c = Get-DrillCode $_
      if ($c.code -ne 'DRILL_UNEXPECTED') { throw }
      $after = ''
      try { $after = (Wait-DrillGuest $Credential 30).ToString('o') } catch { Assert-DrillGuard; $after = '' }
      $kind = Get-DrillStepFailureKind $before $after
      if ($kind -eq 'restarted' -and $Restartable -and $restarts -lt 2) { continue }
      $codeOut = @{ restarted = 'DRILL_GUEST_RESTARTED_DURING_STEP'; unreachable = 'DRILL_GUEST_NOT_READY_IN_TIME'; failed = 'DRILL_GUEST_STEP_FAILED' }[$kind]
      throw (New-DrillError $codeOut @{ step = $Step; message = $c.detail; bootBefore = $before; bootAfter = $after })
    } finally { Stop-DrillJob $job $ended }   # cut off (deadline, guard, its own limit): stopped without waiting
  }
}

function Remove-DrillVm {
  $info = Get-DrillVmInfo
  if ($null -ne $info) {
    if ($info.notes -cne $script:Drill.Marker) { throw (New-DrillError 'DRILL_VM_NAME_TAKEN_NOT_OURS') }
    if ($info.state -ne 'Off') { Stop-VM -VM $info.vm -TurnOff -Force }
    Get-VMSnapshot -VM $info.vm -ErrorAction SilentlyContinue | Remove-VMSnapshot -ErrorAction SilentlyContinue
    Remove-VM -VM $info.vm -Force
  }
  if (Test-Path -LiteralPath $script:Drill.VmDir) { Remove-Item -LiteralPath $script:Drill.VmDir -Recurse -Force }
}

function New-DrillPassword {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $b = New-Object byte[] 24; $rng.GetBytes($b)
  'Dr-' + (-join ($b | ForEach-Object { $chars[$_ % $chars.Length] }))
}

# Baseline: build the VM, install Windows 11 Pro unattended, settle it, shut it down, take S0-clean-os. Returns evidence.
function Invoke-DrillBaseline([string]$RunDir, [switch]$ExistingOnly) {
  $info = Get-DrillVmInfo
  $decision = Get-DrillBaselineAction $(if ($info) { @{ notes = $info.notes; state = $info.state; checkpoints = $info.checkpoints } } else { $null })
  if ($decision.action -eq 'refuse') { throw (New-DrillError $decision.code) }
  if ($decision.action -eq 'ready') { return [ordered]@{ action = 'ready'; checkpoint = $script:Drill.Checkpoint } }
  if ($ExistingOnly) { throw (New-DrillError 'DRILL_CHECKPOINT_NOT_READY') }

  if (-not (Test-Path -LiteralPath $script:Drill.Iso -PathType Leaf)) { throw (New-DrillError 'DRILL_ISO_MISSING') }
  $isoCheck = Test-DrillIsoHash (Get-Sha256Hex $script:Drill.Iso) (Get-Content -LiteralPath $script:Drill.IsoExpectedSha -Raw)
  if (-not $isoCheck.ok) { throw (New-DrillError $isoCheck.code $isoCheck) }
  if ($decision.action -eq 'rebuild') { Remove-DrillVm }
  Invoke-DrillPreBootRelease
  [void](Assert-DrillHost)

  New-Item -ItemType Directory -Force -Path $script:Drill.VmDir, $script:Drill.AnswerDir | Out-Null
  $password = New-DrillPassword
  $cred = New-Object pscredential ($script:Drill.GuestUser, (ConvertTo-SecureString $password -AsPlainText -Force))
  $cred | Export-Clixml -LiteralPath $script:Drill.Credential -Force
  [IO.File]::WriteAllText((Join-Path $script:Drill.AnswerDir 'autounattend.xml'), (New-DrillAutounattend $password), [Text.UTF8Encoding]::new($false))
  $password = $null
  [void](New-DrillAnswerIso $script:Drill.AnswerDir $script:Drill.AnswerIso)
  Remove-Item -LiteralPath $script:Drill.AnswerDir -Recurse -Force

  $vm = New-VM -Name $script:Drill.VmName -Generation 2 -MemoryStartupBytes $script:Drill.MemoryBytes -NewVHDPath $script:Drill.Vhd -NewVHDSizeBytes $script:Drill.VhdBytes -Path $script:Drill.VmDir
  # The network adapter stays unplugged until the checkpoint: offline, OOBE skips its update step (OOBEZDP), which on the
  # 2026-11-16 runs failed ("Something went wrong OOBEZDP") and sent OOBE to its "Why did my PC restart?" screen.
  Set-VM -VM $vm -Notes $script:Drill.Marker -StaticMemory -AutomaticStartAction Nothing -AutomaticStopAction TurnOff -CheckpointType Standard -AutomaticCheckpointsEnabled $false
  Set-VMProcessor -VM $vm -Count $script:Drill.Cpu -Maximum $script:Drill.CpuMaximum -RelativeWeight $script:Drill.CpuWeight -ExposeVirtualizationExtensions $true
  Set-VMHardDiskDrive -VMHardDiskDrive (Get-VMHardDiskDrive -VM $vm)[0] -MaximumIOPS $script:Drill.MaxIops
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
  try { Set-VMKeyProtector -VM $vm -NewLocalKeyProtector; Enable-VMTPM -VM $vm }
  catch { throw (New-DrillError 'DRILL_BASELINE_NEEDS_ONE_UAC' @{ step = 'vTPM local key protector'; elevatedCommand = "Set-VMKeyProtector -VMName $($script:Drill.VmName) -NewLocalKeyProtector"; message = $_.Exception.Message }) }
  Add-VMDvdDrive -VM $vm -Path $script:Drill.Iso
  Add-VMDvdDrive -VM $vm -Path $script:Drill.AnswerIso
  Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMDvdDrive -VM $vm)[0]

  # Everything after Start-VM: any stop turns the VM off (it never stays running) and leaves the screen and the step log as
  # evidence; the VM keeps no checkpoint, so the next run rebuilds it.
  $log = Join-Path $RunDir 'baseline-steps.log'
  $note = { param([string]$m) Add-Content -LiteralPath $log -Value ("{0} {1}" -f [DateTimeOffset]::UtcNow.ToString('o'), $m) -Encoding UTF8 }
  $started = [DateTimeOffset]::UtcNow
  $guard = $null
  $off = $false
  try {
    $guard = Start-DrillHostGuard $RunDir
    Start-DrillGuardedVm
    & $note 'started; sending boot keys'
    $keys = Send-DrillBootKeys $script:Drill.VmName $script:Drill.BootKeySeconds
    & $note "boot keys sent: $keys; waiting for setup and OOBE to finish"
    Wait-DrillSetupSignal $script:Drill.InstallTimeoutMinutes   # no logon attempt before this: see SetupSignalName
    & $note 'setup-complete signal read (KVP); waiting for PowerShell Direct'
    [void](Wait-DrillGuest $cred 15)
    $installMinutes = [Math]::Round(([DateTimeOffset]::UtcNow - $started).TotalMinutes, 1)
    & $note "setup and OOBE finished after $installMinutes min"

    # Settle (idempotent, so it survives a guest restart): never-expiring local password (a restored checkpoint must still log in
    # months later), no sleep/hibernate, no automatic updates (every drill starts from the same bits), WSL and VMP enabled.
    $settle = Invoke-DrillGuest $cred {
      $ErrorActionPreference = 'Stop'
      Set-LocalUser -Name $args[0] -PasswordNeverExpires $true
      & powercfg.exe /hibernate off | Out-Null
      & powercfg.exe /change standby-timeout-ac 0 | Out-Null
      & powercfg.exe /change monitor-timeout-ac 0 | Out-Null
      $au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
      New-Item -Path $au -Force | Out-Null
      Set-ItemProperty -Path $au -Name NoAutoUpdate -Value 1 -Type DWord
      $f = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux, VirtualMachinePlatform -All -NoRestart -WarningAction SilentlyContinue
      $os = Get-CimInstance Win32_OperatingSystem
      [ordered]@{ caption = $os.Caption; build = $os.BuildNumber; edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID; host = $env:COMPUTERNAME; restartNeeded = [bool]$f.RestartNeeded }
    } -ArgumentList @($script:Drill.GuestUser) -TimeoutMinutes 20 -Step 'settle' -Restartable
    & $note "settled: $($settle.caption) $($settle.build) $($settle.edition)"
    if ([string]$settle.edition -cne 'Professional') { throw (New-DrillError 'DRILL_BASELINE_NOT_PRO' @{ edition = [string]$settle.edition }) }

    $beforeReboot = [DateTimeOffset]::UtcNow
    try { Invoke-Command -VMName $script:Drill.VmName -Credential $cred -ScriptBlock { Restart-Computer -Force } -ErrorAction Stop } catch { }
    [void](Wait-DrillGuest $cred 20 $beforeReboot)
    & $note 'restarted for the features'
    $nested = Invoke-DrillGuest $cred {
      $feat = @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') | ForEach-Object { [ordered]@{ name = $_; state = [string](Get-WindowsOptionalFeature -Online -FeatureName $_).State } }
      $hv = @(Get-WinEvent -LogName 'Microsoft-Windows-Hyper-V-Hypervisor-Operational' -MaxEvents 20 -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { "$($_.Id):$($_.Message.Split([Environment]::NewLine)[0])" })
      [ordered]@{ features = @($feat); hypervisorEvents = $hv; vbs = [string](Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue).VirtualizationBasedSecurityStatus }
    } -TimeoutMinutes 5 -Step 'features' -Restartable
    if (@($nested.features | Where-Object { [string]$_.state -ne 'Enabled' }).Count) { throw (New-DrillError 'DRILL_BASELINE_FEATURES_NOT_ENABLED' $nested.features) }
    Stop-VM -VM $vm -Force   # graceful shutdown
    if ((Get-VM -Name $script:Drill.VmName).State -ne 'Off') { throw (New-DrillError 'DRILL_BASELINE_NOT_OFF') }
    $off = $true
  } catch {
    [void](Save-DrillScreen $script:Drill.VmName (Join-Path $RunDir 'baseline-failure.bmp'))
    $c = Get-DrillCode $_
    & $note "stopped: $($c.code)"
    throw
  } finally {
    try {
      if (-not $off -and -not (Stop-DrillGuardedVm $guard)) { throw (New-DrillError 'DRILL_BASELINE_NOT_OFF') }
    } finally {
      Stop-DrillHostGuard $guard
      if ($guard -and $guard.state.failure) { throw (New-DrillError $guard.state.failure.code $guard.state.failure.detail) }
    }
  }
  # Both DVD drives go (removing a drive takes its medium with it; ejecting first made the removal fail: 2026-11-16 12:18),
  # and only now is the network plugged in.
  foreach ($d in @(Get-VMDvdDrive -VM $vm)) { Remove-VMDvdDrive -VMDvdDrive $d }
  Connect-VMNetworkAdapter -VMName $script:Drill.VmName -SwitchName $script:Drill.Switch
  Remove-Item -LiteralPath $script:Drill.AnswerIso -Force
  Checkpoint-VM -VM $vm -SnapshotName $script:Drill.Checkpoint
  & $note "checkpoint $($script:Drill.Checkpoint) taken (Off)"
  return [ordered]@{ action = $decision.action; checkpoint = $script:Drill.Checkpoint; isoSha256 = $isoCheck.sha256; bootKeysSent = $keys; installMinutes = $installMinutes; guest = $settle; nested = $nested }
}

# The guest reads of one verdict pass: status, current, facts, verify. Inside the VM only.
$script:GuestRead = {
  param($Root, $NativeText)
  $ErrorActionPreference = 'Stop'
  $native = [scriptblock]::Create($NativeText)
  $read = { param($p) if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
  $status = & $read (Join-Path $Root 'state\status.json')
  $current = & $read (Join-Path $Root 'upgrade\current.json')
  $factsFile = Join-Path $Root 'upgrade\mailbox\responses\version-facts.json'
  $facts = & $read $factsFile
  # the pause the node holds (A6 holds it to the one the launcher confirmed): the file's sha256 and the request it names
  $pausedFile = Join-Path $Root 'state\PAUSED.json'
  $pause = $null
  if (Test-Path -LiteralPath $pausedFile -PathType Leaf) {
    $pausedSource = try { (Get-Content -LiteralPath $pausedFile -Raw -Encoding UTF8 | ConvertFrom-Json).source } catch { $null }
    $pause = [ordered]@{ sha256 = (Get-FileHash -LiteralPath $pausedFile -Algorithm SHA256).Hash.ToLowerInvariant()
      requestSha256 = $(if ($pausedSource -and $pausedSource.PSObject.Properties['requestSha256']) { [string]$pausedSource.requestSha256 } else { $null }) }
  }
  $verify = [ordered]@{ status = 'NOT_RUN'; exit = $null; tail = @(); stderr = $null }
  $receipt = Join-Path $Root 'install\install-receipt.json'
  if ($current -and (Test-Path -LiteralPath $receipt)) {
    $script = Join-Path $Root ("resident\" + $current.residentManifestSha256 + "\windows\verify-resident.ps1")
    $rs = (Get-FileHash -LiteralPath $receipt -Algorithm SHA256).Hash.ToLowerInvariant()
    $n = & $native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-ExpectedInstallReceiptSha256', $rs, '-LinuxVersionFactsFile', $factsFile) 840
    $out = @($n.stdout -split "`r?`n")
    $verdict = @($out | Where-Object { $_ -match 'RESIDENT_VERIF' }) | Select-Object -Last 1
    $verify = [ordered]@{ status = $(if ($verdict -match '(RESIDENT_[A-Z_]+)') { $Matches[1] } else { 'UNPARSED' }); exit = $n.exit; tail = @($out | Select-Object -Last 40); stderr = $n.stderr }
  }
  [ordered]@{ status = $status; current = $current; facts = $facts; pause = $pause; verify = $verify; readAt = [DateTimeOffset]::UtcNow.ToString('o') }
}

# Copy the pinned prerequisites into the VM, re-check their hashes there, install them (GuestPrereq). Stops on any miss.
function Invoke-DrillPrereqInGuest([string]$RunDir, $Prereq, [pscredential]$Cred) {
  $dest = "$($script:Drill.GuestWork)\prereq"
  $files = @($Prereq.wsl, $Prereq.rootfs) + @($Prereq.debs)
  $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
  try {
    Invoke-Command -Session $session -ScriptBlock { param($d) New-Item -ItemType Directory -Force -Path $d, (Join-Path $d 'debs') | Out-Null } -ArgumentList $dest
    foreach ($rel in $files) { Copy-Item -LiteralPath (Join-Path $Prereq.dir $rel) -Destination (Join-Path $dest $rel) -ToSession $session }
    $want = @{}; foreach ($rel in $files) { $want[$rel] = Get-Sha256Hex (Join-Path $Prereq.dir $rel) }
    $bad = Invoke-Command -Session $session -ScriptBlock { param($d, $w) @($w.Keys | Where-Object { (Get-FileHash -LiteralPath (Join-Path $d $_) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $w[$_] }) } -ArgumentList $dest, $want
    if (@($bad).Count) { throw (New-DrillError 'DRILL_PREREQ_CHANGED_IN_COPY' @($bad)) }
  } finally { Remove-PSSession -Session $session }
  try { $facts = Invoke-DrillGuest $Cred $script:GuestPrereq -ArgumentList @($dest, $Prereq.wsl, $Prereq.rootfs, $Prereq.distribution, $Prereq.wslVersion, $script:DrillNativeText) -TimeoutMinutes $script:Drill.PrereqTimeoutMinutes -Code 'DRILL_PREREQ_TIMEOUT' -Step 'prereq' }
  catch { $c = Get-DrillCode $_; if ($c.code -ne 'DRILL_GUEST_STEP_FAILED') { throw }; throw (New-DrillError 'DRILL_PREREQ_FAILED' $c.detail) }
  Write-DrillJson (Join-Path $RunDir 'prereq-facts.json') $facts
  if (Get-Prop $facts 'failure') { throw (New-DrillError 'DRILL_PREREQ_FAILED' (Get-Prop $facts 'failure')) }
  if ($facts.dpkgExit -ne 0 -or $facts.dpkgAuditLines -ne 0 -or -not $facts.dockerActive -or -not $facts.systemdPid1) {
    throw (New-DrillError 'DRILL_PREREQ_NOT_READY' @{ dpkgExit = $facts.dpkgExit; audit = $facts.dpkgAuditLines; docker = $facts.dockerActive; systemd = $facts.systemdPid1 }) }
  return $facts
}

# Until PowerShell Direct can arm the guest's own timer, a detached copy of this script covers loss of the host process.
# It never starts a VM or releases a hold. The parent signals completion once the timer is installed or the VM is restored.
function Invoke-DrillBootWatchdog([string]$Signal, [int]$ParentId, [long]$ParentStarted, [guid]$VmId, [DateTimeOffset]$Deadline) {
  $mutex = [Threading.Mutex]::new($false, $script:Drill.BootMutex)
  $locked = $false; $parent = $null
  try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    $parent = [Diagnostics.Process]::GetProcessById($ParentId)
    if ($parent.StartTime.ToUniversalTime().Ticks -ne $ParentStarted) { return }
    [IO.File]::WriteAllText("$Signal.ready", '')
    while (-not (Test-Path -LiteralPath "$Signal.armed") -and (Get-DrillTime) -lt $Deadline) {
      if ($parent.WaitForExit(500)) {
        if (-not (Test-Path -LiteralPath "$Signal.starting")) { return }
        # A Start-VM request submitted before the process died can still become visible asynchronously.
        try {
          $info = Get-DrillVmInfo
          if ($info -and $info.vm.Id -eq $VmId -and $info.notes -ceq $script:Drill.Marker -and $info.state -ne 'Off') {
            $stopped = Stop-DrillOwnedVm -RestoreCheckpoint
            Write-DrillWatchdogOutcome $Signal 'PARENT_GONE' $stopped
            if ($stopped) { return }
          }
        } catch { Write-DrillWatchdogOutcome $Signal 'PARENT_GONE' $false }
        Start-Sleep -Milliseconds 500
      }
    }
    # A final cleanup at the boundary also covers a foreground stuck before timer registration.
    if (-not (Test-Path -LiteralPath "$Signal.armed")) {
      $info = Get-DrillVmInfo
      if ($info -and $info.vm.Id -eq $VmId -and $info.notes -ceq $script:Drill.Marker) {
        $stopped = $false
        try { $stopped = Stop-DrillOwnedVm -RestoreCheckpoint } finally { Write-DrillWatchdogOutcome $Signal 'TIMER_NOT_ARMED_BY_DEADLINE' $stopped }
      }
    }
  } finally {
    if ($parent) { $parent.Dispose() }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

# The boot watchdog's record of a restore it made (Codex review of 1cedea9ef, medium 4): its parent is gone, so there is no receipt; the
# record sits beside the run as <signal>.outcome.json. It acts only before the guest's own timer is armed, that is before the run's first
# step, so no evidence was taken.
function Write-DrillWatchdogOutcome([string]$Signal, [string]$Why, $Stopped) {
  $restore = if ($Stopped -eq $true) { 'RESTORED' } else { 'RESTORE_FAILED' }
  $r = [ordered]@{ status = 'DRILL_WATCHDOG_RESTORE'; why = $Why; restore = $restore; evidence = 'NOT_TAKEN'
    note = $(if ($restore -ceq 'RESTORED') { '由开机看门进程紧急还原，证据未取' } else { '开机看门进程紧急还原失败，证据未取' }); at = [DateTimeOffset]::UtcNow.ToString('o') }
  try { Write-DrillJson "$Signal.outcome.json" $r } catch { }
}

# What of the run's evidence the run directory holds after an emergency restore: none, all or part of it, from the files really there
# (Codex review of c1497e0a1, medium 3). M5 counts when its seven observations are there (a directory made before any was read is not
# evidence; some of them is part of it); the stage logs taken back are listed, and any of them is evidence too.
$script:DrillM5Names = @('profile.json', 'system.json', 'resident.json', 'controller.json', 'companion.json', 'probe.json', 'record.json')
function Get-DrillAbortEvidence([string]$RunDir) {
  $expected = @('first-install.log', 'stage-evidence.json', 'read-after-install.json', 'read-after-reboot.json', 'm5')
  $m5 = @($script:DrillM5Names | Where-Object { Test-Path -LiteralPath (Join-Path (Join-Path $RunDir 'm5') $_) -PathType Leaf })
  $taken = @($expected | Where-Object { if ($_ -ceq 'm5') { $m5.Count -eq $script:DrillM5Names.Count } else { Test-Path -LiteralPath (Join-Path $RunDir $_) -PathType Leaf } })
  $stageLogs = @('host.stdout.log', 'prepare.stdout.log', 'launcher.stdout.log') | Where-Object { Test-Path -LiteralPath (Join-Path $RunDir $_) -PathType Leaf }
  # the stage timings saved on their own are evidence taken too (Codex review of f33fc33e5, low 1)
  $stageTimings = Test-Path -LiteralPath (Join-Path $RunDir 'stage-timings.json') -PathType Leaf
  $any = $taken.Count + $m5.Count + @($stageLogs).Count + [int]$stageTimings
  # all of it only with the step record complete too (Codex review of e0a3cded5, medium 2): the stage logs this run needed are there
  $steps = try { Read-DrillFirstInstallSteps $RunDir } catch { $null }
  $stepsComplete = ($null -ne $steps) -and ((Get-Prop $steps 'missing') -eq $false) -and ((Get-Prop $steps 'incomplete') -eq $false)
  [ordered]@{ evidence = $(if ($any -eq 0) { 'NOT_TAKEN' } elseif ($taken.Count -eq $expected.Count -and $stepsComplete) { 'TAKEN' } else { 'PARTIAL' }); taken = $taken
    notTaken = @($expected | Where-Object { $taken -notcontains $_ }); m5Observations = $m5; stageLogs = @($stageLogs); stageTimings = $stageTimings; stepsComplete = $stepsComplete }
}

# The host guard's emergency restore, as it ended (its host-guard.json, DRILL_ABORTED): restored, restore failed, or not known (a record
# from before its cleanup); and what evidence the run had taken by then.
function Get-DrillGuardOutcome([string]$RunDir) {
  $file = Join-Path $RunDir 'host-guard.json'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $g = try { Read-DrillJson $file } catch { $null }
  if ([string](Get-Prop $g 'status') -cne 'DRILL_ABORTED') { return $null }
  $restore = if ((Get-Prop $g 'restoredToCheckpoint') -eq $true) { 'RESTORED' } elseif ((Get-Prop $g 'cleanupDone') -eq $true) { 'RESTORE_FAILED' } else { 'UNKNOWN' }
  $ev = Get-DrillAbortEvidence $RunDir
  $head = @{ RESTORED = '由守护紧急还原'; RESTORE_FAILED = '守护紧急还原失败'; UNKNOWN = '守护紧急还原，结局未记下' }[$restore]
  $tail = @{ NOT_TAKEN = '证据未取'; TAKEN = '证据已取'; PARTIAL = '证据部分已取' }[$ev.evidence]
  [ordered]@{ note = ($head + '，' + $tail); code = (Get-Prop $g 'code'); restore = $restore; cleanupFailure = (Get-Prop $g 'cleanupFailure')
    evidence = $ev.evidence; taken = $ev.taken; notTaken = $ev.notTaken; m5Observations = $ev.m5Observations; stageLogs = $ev.stageLogs; stepsComplete = $ev.stepsComplete }
}

# Seconds from asking WMI for the watchdog until it must have signalled ready; the WMI calls count against it.
$script:DrillWatchdogReadySeconds = 15

function Get-DrillWatchdogTimeout([DateTimeOffset]$ReadyBy) {
  $left = [Math]::Ceiling(($ReadyBy - (Get-DrillTime)).TotalSeconds)
  if ($left -lt 1) { throw (New-DrillError 'DRILL_WATCHDOG_READY_TIMEOUT') }
  return [uint32]$left
}

function Start-DrillDetachedWatchdog([string]$EncodedCommand, [DateTimeOffset]$ReadyBy) {
  if (-not ('CluedDrill.WatchdogJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CluedDrill {
  public static class WatchdogJob {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
  }
}
'@
  }
  # WMI creates the watchdog under its own provider host, so it inherits no job from the caller.
  # An agent session's job refuses breakaway, and that session is exactly what may be killed mid-drill.
  $image = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $EncodedCommand"
  try {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -OperationTimeoutSec (Get-DrillWatchdogTimeout $ReadyBy) -ErrorAction Stop -Arguments @{
      CommandLine = "`"$image`" $arguments"; CurrentDirectory = "$env:SystemRoot\System32"; ProcessStartupInformation = $startup
    }
  } catch {
    if ((Get-DrillCode $_).code -ne 'DRILL_UNEXPECTED') { throw }
    throw (New-DrillError 'DRILL_WATCHDOG_WMI_CREATE_FAILED' (Get-DrillCode $_).detail)
  }
  $id = [int](Get-Prop $created 'ProcessId')
  if ((Get-Prop $created 'ReturnValue') -ne 0 -or $id -le 0) {
    throw (New-DrillError 'DRILL_WATCHDOG_WMI_CREATE_REFUSED' @{ returnValue = (Get-Prop $created 'ReturnValue'); processId = $id })
  }
  # The open handle pins the PID: while we hold it, no other process can take this PID. Only after the command line read
  # under that pin matches this launch is the handle known to be the watchdog; until then nothing is terminated.
  $worker = $null
  try {
    $worker = [Diagnostics.Process]::GetProcessById($id)
    [void]$worker.Handle
    $seen = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$id" -OperationTimeoutSec (Get-DrillWatchdogTimeout $ReadyBy) -ErrorAction Stop
    $line = ([string](Get-Prop $seen 'CommandLine')).TrimEnd()
    if ($worker.HasExited -or -not $line.EndsWith($arguments, [StringComparison]::Ordinal)) { throw 'not this launch' }
  } catch {
    if ($worker) { $worker.Dispose() }
    if ((Get-DrillCode $_).code -eq 'DRILL_WATCHDOG_READY_TIMEOUT') { throw }
    throw (New-DrillError 'DRILL_WATCHDOG_IDENTITY_UNCONFIRMED' @{ processId = $id; reason = (Get-DrillCode $_).detail })
  }
  $inJob = $false
  $queried = [CluedDrill.WatchdogJob]::IsProcessInJob($worker.Handle, [IntPtr]::Zero, [ref]$inJob)
  if ($queried -and -not $inJob) { return $worker }
  # A watchdog inside a job dies with its launcher, so it protects nothing; it must be gone before the refusal stands,
  # or it would keep the boot mutex and block the next drill.
  $detail = [ordered]@{ processId = $id; inJob = $inJob; jobQueryError = $null; terminated = $false; killError = $null }
  if (-not $queried) { $detail.jobQueryError = [ComponentModel.Win32Exception]::new().Message }
  try { $worker.Kill() } catch { $detail.killError = $_.Exception.Message }
  try { $detail.terminated = $worker.WaitForExit(5000) } catch { $detail.killError = "$($detail.killError) $($_.Exception.Message)".Trim() }
  $worker.Dispose()
  throw (New-DrillError 'DRILL_WATCHDOG_IN_JOB' $detail)
}

# Returns the signal path and the watchdog's process, which stays open: Start-DrillGuardedVm re-checks it right before Start-VM.
function Start-DrillBootWatchdog([string]$RunDir, [guid]$VmId, [DateTimeOffset]$Deadline) {
  $signal = Join-Path $RunDir 'guest-shutdown'
  $parentStarted = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
  $file = $script:DrillScriptPath.Replace("'", "''")
  $escapedSignal = $signal.Replace("'", "''")
  $command = ". '$file'; Invoke-DrillBootWatchdog '$escapedSignal' $PID $parentStarted '$VmId' '$($Deadline.ToString('o'))'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $readyBy = (Get-DrillTime).AddSeconds($script:DrillWatchdogReadySeconds)
  try { $worker = Start-DrillDetachedWatchdog $encoded $readyBy }
  catch { throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY' (Get-DrillCode $_)) }
  $ready = $false
  try {
    while (-not $worker.HasExited -and (Get-DrillTime) -lt $readyBy) {
      # Ready counts only while the watchdog is still alive after the signal was seen.
      if ((Test-Path -LiteralPath "$signal.ready") -and -not $worker.HasExited) { $ready = $true; return @{ signal = $signal; process = $worker } }
      Start-Sleep -Milliseconds 100
    }
    throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY' @{ exited = $worker.HasExited })
  } finally { if (-not $ready) { $worker.Dispose() } }
}

function Assert-DrillWatchdogAlive($Watchdog) {
  $process = Get-Prop $Watchdog 'process'
  if (-not $process -or $process.HasExited) {
    throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_WATCHDOG_NOT_READY' @{ code = 'DRILL_WATCHDOG_EXITED_BEFORE_BOOT' })
  }
}

$script:GuestShutdownTimer = {
  param($Deadline, $GuestName)
  if ($env:COMPUTERNAME -ine $GuestName) { throw 'DRILL_GUEST_IDENTITY_REFUSED' }
  $when = [DateTimeOffset]::ParseExact($Deadline, 'o', [Globalization.CultureInfo]::InvariantCulture)
  if ($when -le [DateTimeOffset]::UtcNow) { throw 'DRILL_RUN_TIMEOUT' }
  # The startup trigger re-arms from the same UTC deadline after any guest reboot, including A7.
  $shutdown = @'
    $when = [DateTimeOffset]::ParseExact('__UTC_DEADLINE__', 'o', [Globalization.CultureInfo]::InvariantCulture)
    $seconds = [Math]::Ceiling(($when - [DateTimeOffset]::UtcNow).TotalSeconds)
    if ($seconds -gt 0) { Start-Sleep -Seconds $seconds }
    & "$env:SystemRoot\System32\shutdown.exe" /s /f /t 0
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($shutdown.Replace('__UTC_DEADLINE__', $Deadline)))
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -NonInteractive -EncodedCommand $encoded"
  $triggers = @((New-ScheduledTaskTrigger -Once -At $when.LocalDateTime), (New-ScheduledTaskTrigger -AtStartup))
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName 'CluedDrillGuestShutdown' -Action $action -Trigger $triggers -Settings $settings -User 'SYSTEM' -ErrorAction Stop | Out-Null
  return $true
}

# Restore the clean checkpoint, start the VM behind the memory gate, run $Body with the guest credential, and always end Off
# and restored, whatever happened. Returns the outcome and guard observations.
function Invoke-DrillOnCheckpoint([scriptblock]$Body, [string]$RunDir, $Window) {
  $result = $null; $failure = $null; $restored = $false; $guard = $null; $cleanupNeeded = $false; $signal = $null; $watchdog = $null
  $executorStates = @(); $script:DrillPreBoot = $null; $running = [ordered]@{ afterBootFreeGB = $null; minRunningFreeGB = $null }
  try {
    # hold in force -> resident idle -> runner jobs on either side sampled (early) -> release the runners' WSL page cache when neither side
    # has one -> the boot gate in Start-DrillGuardedVm (both sides again, then memory against the tier they select, once, boot).
    Invoke-DrillPreBootRelease $Window.holdUntil
    $info = Get-DrillVmInfo
    $decision = Get-DrillBaselineAction $info
    if ($decision.action -ne 'ready') { throw (New-DrillError $(if ($decision.code) { $decision.code } else { 'DRILL_CHECKPOINT_NOT_READY' })) }
    $Window.safeToResume = $false
    $cleanupNeeded = $true
    Restore-VMCheckpoint -VMName $script:Drill.VmName -Name $script:Drill.Checkpoint -Confirm:$false
    [void](Assert-DrillHost -HoldUntil $Window.holdUntil)
    $cred = Get-DrillCredential
    $guard = Start-DrillHostGuard $RunDir -RestoreCheckpoint -Window $Window
    $watchdog = Start-DrillBootWatchdog $RunDir $info.vm.Id $Window.deadline
    $signal = Get-Prop $watchdog 'signal'
    Start-DrillGuardedVm $watchdog
    [void](Wait-DrillGuest $cred 15)
    $armed = Invoke-DrillGuest $cred $script:GuestShutdownTimer -ArgumentList @($Window.deadline.ToString('o'), $script:Drill.ComputerName) -TimeoutMinutes 1 -Step 'guest-shutdown-timer'
    if ($armed -ne $true) { throw (New-DrillError 'DRILL_GUEST_SHUTDOWN_TIMER_NOT_ARMED') }
    [IO.File]::WriteAllText("$signal.armed", '')
    $result = & $Body $cred
    Assert-DrillGuard
  } catch { $failure = Get-DrillCode $_ }
  finally {
    try {
      if ($cleanupNeeded) { $restored = Stop-DrillGuardedVm $guard -RestoreCheckpoint }
    } catch { $restored = $false }
    if ($restored -and $signal) { try { [IO.File]::WriteAllText("$signal.armed", '') } catch { } }
    if ($cleanupNeeded) { $Window.safeToResume = $restored }
    $watchdogProcess = Get-Prop $watchdog 'process'
    if ($watchdogProcess) { $watchdogProcess.Dispose() }
    Stop-DrillHostGuard $guard
    if ($guard) {
      $executorStates = @($guard.state.executorStates.Values)
      $running = [ordered]@{ afterBootFreeGB = (Get-Prop $guard.state 'afterBootFreeGB'); minRunningFreeGB = (Get-Prop $guard.state 'minRunningFreeGB') }
      if ($guard.state.failure) { $failure = $guard.state.failure; $result = $null }
    }
  }
  return @{ result = $result; failure = $failure; restored = $restored; hostExecutorStates = $executorStates; preBoot = $script:DrillPreBoot; runningMemory = $running }
}

# A8's generic upgrade, a guest step of its own (Codex narrow review of 4190b0f8e, medium): its raw result comes back to the host, which keeps
# it (reinstall-upgrade.json) before the next command starts -- a refusal stays on record even when the prepare after it fails or times out.
$script:GuestReinstallUpgrade = {
  param($Node, $Tree, $From, $Work, $Version, $NativeText)
  $native = [scriptblock]::Create($NativeText)
  $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
  & $native $Node @((Join-Path $fleet 'upgrade.mjs'), 'fetch', '--version', $Version, '--work', (Join-Path $Work 'a8-upgrade'), '--from', $From, '--no-request') 3600
}

# $UpRun: the upgrade's raw result (GuestReinstallUpgrade), handed over by the host.
$script:GuestReinstall = {
  param($Node, $Tree, $From, $Work, $Version, $TarName, $AccName, $TarSha, $NativeText, $UpRun)
  $native = [scriptblock]::Create($NativeText)
  $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
  $last = { param($lines) $l = @($lines | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1; if ($l) { try { $l | ConvertFrom-Json } catch { $null } } }
  $upRun = $UpRun
  $p1Run = & $native $Node @((Join-Path $fleet 'install.mjs'), 'prepare', '--artifact', (Join-Path $From $TarName), '--artifact-sha', $TarSha, '--acceptance', (Join-Path $From $AccName), '--work', (Join-Path $Work 'a8-prepare')) 3600
  $up = @($upRun.stdout -split "`r?`n"); $p1 = @($p1Run.stdout -split "`r?`n")
  $upj = & $last $up; $p1j = & $last $p1
  $reinstall = [ordered]@{ skipped = $false;
    upgradeStatus = $(if ($upj -and $upj.PSObject.Properties['status']) { [string]$upj.status });
    prepareStatus = $(if ($p1j -and $p1j.PSObject.Properties['status']) { [string]$p1j.status });
    launcherVerdict = 'NOT_RUN_MISSING_RUN_COMMAND'; launcherStatus = $null; launcherExit = $null; launcherTail = @(); launcherStderr = $null;
    upgradeTail = @($up | Where-Object { $_ -ne '' } | Select-Object -Last 5); prepareTail = @($p1 | Where-Object { $_ -ne '' } | Select-Object -Last 5);
    upgradeExit = $upRun.exit; upgradeStderr = $upRun.stderr; prepareExit = $p1Run.exit; prepareStderr = $p1Run.stderr;
    reverifyPassed = $false; prepareAgainStatus = $null }
  $runCommand = if ($p1j) { $p1j.PSObject.Properties['runCommand'] }
  if ($runCommand -and $runCommand.Value -is [string] -and -not [string]::IsNullOrWhiteSpace($runCommand.Value)) {
    try {
      # Use the accepted package's parser and verdict for the launcher's indented terminal JSON.
      . (Join-Path $fleet 'bootstrap.ps1') -From $From
      $launch = Invoke-StageChild $PowerShellExe @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $runCommand.Value) 0
      $reinstall.launcherExit = $launch.exit
      $reinstall.launcherStatus = Get-Key $launch.last 'status'
      $reinstall.launcherVerdict = (Get-LauncherVerdict $false $launch.last).status
      $reinstall.launcherTail = @($launch.stdout -split "`r?`n" | Select-Object -Last 20)
      $reinstall.launcherStderr = $launch.stderr
    } catch {
      $reinstall.launcherVerdict = 'DRILL_LAUNCHER_ERROR'
      $reinstall.launcherStderr = $_.Exception.Message
    }
  }
  return $reinstall
}

# The public allowlist in docs/ci-connection.md (renewal package). Only the two profile SIDs leave the acceptance file.
$script:GuestM5Files = {
  param($Root)
  $files = [ordered]@{
    'profile.json' = $null
    'system.json' = (Join-Path $Root 'broker\renew-key.json')
    'resident.json' = (Join-Path $Root 'state\renew-key-resident.json')
    'controller.json' = (Join-Path (Split-Path -Parent $Root) 'state\v2\receipts\renew-key-controller.json')
    'companion.json' = (Join-Path $Root 'mailbox\responses\renew-key.json')
    'probe.json' = $null
  }
  $readSmall = {
    param($Path)
    try {
      if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
      $file = Get-Item -LiteralPath $Path
      if ($file.Length -gt 8192 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      if ($bytes.Length -le 8192) { [Convert]::ToBase64String($bytes) }
    } catch { }
  }
  $public = @{}
  foreach ($name in $files.Keys) {
    if ($files[$name]) { $public[$name] = & $readSmall $files[$name] }
  }
  $acceptance = Join-Path $Root 'record\acceptance.json'
  try {
    if (Test-Path -LiteralPath $acceptance -PathType Leaf) {
      $node = (Get-Content -LiteralPath $acceptance -Raw -Encoding UTF8 | ConvertFrom-Json).node
      if ($node -and $node.controllerSid -is [string] -and $node.ownerSid -is [string] -and
          $node.controllerSid -cmatch '^S-1-5-21-(\d+-){3}\d+$' -and $node.ownerSid -cmatch '^S-1-5-21-(\d+-){3}\d+$') {
        $profile = @{ controllerSid = $node.controllerSid; ownerSid = $node.ownerSid } | ConvertTo-Json -Compress
        $public['profile.json'] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($profile))
      }
    }
  } catch { }
  $latest = [DateTimeOffset]::MinValue
  foreach ($name in @('renew-ci.json', 'renew-upgrade.json')) {
    $data = & $readSmall (Join-Path $Root "broker\$name")
    if (-not $data) { continue }
    # Keep one observation, using the newer recorded probe when both kinds exist.
    if (-not $public.ContainsKey('probe.json')) { $public['probe.json'] = $data }
    try {
      $probe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data)) | ConvertFrom-Json
      $at = [DateTimeOffset]$probe.at
      if ($at -gt $latest) { $latest = $at; $public['probe.json'] = $data }
    } catch { }
  }
  # record.json: the connection record as this administrator reads it (Fable renew-key ruling, supplement "eight on the path", item 8).
  # Whether it is there, never its content: PRESENT, or ABSENT when the file or its directory is not found (install-resident.ps1's
  # baseline reads it the same way); any other answer leaves the observation missing, so M5 fails.
  try {
    [void][IO.File]::GetAttributes((Join-Path (Split-Path -Parent $Root) 'secrets\ci-admission.connection.json')); $record = 'PRESENT'
  } catch [IO.FileNotFoundException] { $record = 'ABSENT' } catch [IO.DirectoryNotFoundException] { $record = 'ABSENT' } catch { $record = $null }
  if ($record) { $public['record.json'] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"ci-admission.connection.json":"' + $record + '"}')) }
  return $public
}

function Copy-DrillM5([string]$RunDir, [pscredential]$Cred) {
  $dir = Join-Path $RunDir 'm5'
  New-Item -ItemType Directory -Path $dir | Out-Null
  $names = $script:DrillM5Names
  $missing = @(); $code = $null
  try { $files = Invoke-DrillGuest $Cred $script:GuestM5Files -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 2 -Step 'm5-observations' }
  catch { $files = $null; $code = (Get-DrillCode $_).code }
  foreach ($name in $names) {
    $data = if ($files -is [System.Collections.IDictionary]) { $files[$name] }
    # Fable ruling 11-20 "first install r4" section 3 (E3): an observation is a non-empty string, nothing else. What the guest did not
    # read comes back through remoting as an empty object, not $null; a file it read empty is an empty string: both are missing, never a
    # file written here (an empty file would send M5 to the checker with the cause named wrong).
    if ($data -isnot [string] -or $data.Length -eq 0) { $missing += $name; continue }
    [IO.File]::WriteAllBytes((Join-Path $dir $name), [Convert]::FromBase64String($data))
  }
  return @{ directory = 'm5'; missing = $missing; collectionCode = $code }
}

function Get-DrillM5Verdict([string]$RunDir, $M5) {
  if (-not $M5) { return @{ result = 'FAIL'; detail = 'DRILL_M5_OBSERVATIONS_MISSING' } }
  $M5.result = 'FAIL'
  if ($M5.collectionCode -or $M5.missing.Count -ne 0) {
    $M5.detail = $(if ((Get-DrillField $M5 'blocked') -eq $true) { [string]$M5.collectionCode } else { 'DRILL_M5_OBSERVATIONS_MISSING' })
    return $M5
  }
  $resident = Split-Path -Parent (Split-Path -Parent $script:DrillScriptPath)
  $checker = Join-Path $resident 'test\renewal-drill.mjs'
  if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) {
    $M5.detail = 'DRILL_M5_HOST_CHECKER_MISSING'
    return $M5
  }
  try {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $run = Invoke-DrillNode $node @($checker, (Join-Path $RunDir $M5.directory)) 30
    $M5.verdict = ConvertFrom-Json -InputObject $run.stdout
    $M5.exit = $run.exit
    if ($run.exit -eq 0 -and (Get-Prop $M5.verdict 'result') -ceq 'PASS') {
      $M5.result = 'PASS'
    }
  } catch { $M5.detail = 'DRILL_M5_CHECKER_FAILED' }
  return $M5
}

# A7's read after the reboot: the status and the boot it was read in, from the same guest call. The read is restartable, so the guest may
# have restarted again since the boot the drill waited for (Codex review of 58136df61, high 1): every sample is judged against its own boot.
$script:GuestReadStatus = {
  param($Root) $p = Join-Path $Root 'state\status.json'
  $s = if (Test-Path $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  # Task 87d330d0 K3 (FABLE-drill-companion-k3-20261124 section 4): whether the companion came up by itself after a reboot nobody logged on
  # to -- the companion task's definition (its logon type), the interactive logon sessions (2, 10; Window Manager and Font Driver Host
  # sessions are the system's own), the SYSTEM start task's last run and result, the companion task's state, the companion account's
  # supervisor processes with their start. Each part read on its own: one that cannot be read is named in errors, never thrown.
  $cab = [ordered]@{ boot = $boot; definition = $null; interactiveSessions = $null; startTask = $null; companionState = $null; supervisors = @(); errors = [ordered]@{} }
  $folder = $null
  try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $folder = $svc.GetFolder('\Clued') } catch { $cab.errors['scheduler'] = [string]$_.Exception.Message }
  if ($null -ne $folder) {
    try {
      $t = $folder.GetTask('CluedCIResidentCompanion'); $cab.companionState = [int]$t.State; $lt = [int]$t.Definition.Principal.LogonType
      $cab.definition = $(if ($lt -eq 1) { 'password' } elseif ($lt -eq 3) { 'interactive' } else { 'logon-type-' + $lt })
    } catch { $cab.errors['companionTask'] = [string]$_.Exception.Message }
    try {
      $st = $folder.GetTask('CluedCIResidentCompanionStart'); $last = [DateTime]$st.LastRunTime
      $cab.startTask = [ordered]@{ lastRun = $(if ($last.Year -lt 2000) { $null } else { ([DateTimeOffset]$last).ToUniversalTime().ToString('o') }); lastResult = ([int64]$st.LastTaskResult -band 0xFFFFFFFFL) }
    } catch { $cab.errors['startTask'] = [string]$_.Exception.Message }
  }
  try {
    $sessions = @(Get-CimInstance -ClassName Win32_LogonSession -ErrorAction Stop | Where-Object { @(2, 10) -contains [int]$_.LogonType } | ForEach-Object { [string]$_.LogonId })
    $system = @(Get-CimInstance -ClassName Win32_LoggedOnUser -ErrorAction Stop | Where-Object { @('Window Manager', 'Font Driver Host') -contains [string]$_.Antecedent.Domain } | ForEach-Object { [string]$_.Dependent.LogonId })
    $cab.interactiveSessions = @($sessions | Where-Object { $system -notcontains $_ }).Count
  } catch { $cab.errors['sessions'] = [string]$_.Exception.Message }
  try {
    $cab.supervisors = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='CluedCompanionSupervisor.exe'" -ErrorAction Stop | ForEach-Object {
      $owner = $null; try { $owner = [string](Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction Stop).User } catch { }
      [ordered]@{ pid = [int]$_.ProcessId; owner = $owner; created = $(if ($_.CreationDate) { ([DateTimeOffset][DateTime]$_.CreationDate).ToUniversalTime().ToString('o') } else { $null }) } })
  } catch { $cab.errors['supervisors'] = [string]$_.Exception.Message }
  [ordered]@{ status = $s; readAt = [DateTimeOffset]::UtcNow.ToString('o'); boot = $boot; companionAfterBoot = $cab }
}

# A7's added condition (K3 section 4): under the companion's password definition the companion came up by itself after this boot, nobody
# logged on -- all five: this boot's time; no interactive logon session; the start task ran after the boot and returned 0; the companion
# task running (4); a supervisor of the companion account started after the boot. Any one missing: no pass, named in the detail. Under the
# interactive definition (a person logs on; -Interactive) it adds nothing. No read, or a definition that cannot be told: no pass.
$script:DrillCompanionAccount = 'clued-companion'
function Test-DrillCompanionAfterBoot($Cab, [string]$Boot) {
  if ($null -eq $Cab) { return @{ pass = $false; detail = 'companionAfterBoot=missing' } }
  $definition = [string](Get-Prop $Cab 'definition')
  if ($definition -ceq 'interactive') { return @{ pass = $true; detail = 'companionAfterBoot=interactive-definition' } }
  if ($definition -cne 'password') { return @{ pass = $false; detail = "companionAfterBoot definition=$(if ($definition) { $definition } else { 'unknown' })" } }
  $missing = New-Object Collections.Generic.List[string]
  $bootOk = $false; try { $bootOk = [bool]$Boot -and ($null -ne [DateTimeOffset]::Parse($Boot, [Globalization.CultureInfo]::InvariantCulture)) } catch { $bootOk = $false }
  if (-not $bootOk) { $missing.Add('boot') }
  $sessions = Get-Prop $Cab 'interactiveSessions'
  if ($null -eq $sessions -or [int]$sessions -ne 0) { $missing.Add("interactiveSessions=$(if ($null -eq $sessions) { 'unread' } else { $sessions })") }
  $start = Get-Prop $Cab 'startTask'
  if (-not (Test-DrillAfterBoot ([string](Get-Prop $start 'lastRun')) $Boot)) { $missing.Add('startTaskRanAfterBoot') }
  $result = Get-Prop $start 'lastResult'
  if ($null -eq $result -or [int64]$result -ne 0) { $missing.Add("startTaskResult=$(if ($null -eq $result) { 'unread' } else { $result })") }
  $state = Get-Prop $Cab 'companionState'
  if ($null -eq $state -or [int]$state -ne 4) { $missing.Add("companionState=$(if ($null -eq $state) { 'unread' } else { $state })") }
  $mine = @(@(Get-Prop $Cab 'supervisors') | Where-Object { $null -ne $_ -and [string]::Equals([string](Get-Prop $_ 'owner'), $script:DrillCompanionAccount, [StringComparison]::OrdinalIgnoreCase) -and (Test-DrillAfterBoot ([string](Get-Prop $_ 'created')) $Boot) })
  if (-not $mine.Count) { $missing.Add('supervisorAfterBoot') }
  if ($missing.Count) { return @{ pass = $false; detail = ('companionAfterBoot missing=' + ($missing -join ',')) } }
  @{ pass = $true; detail = 'companionAfterBoot=complete' }
}

# One A7 sample: the status rewritten after the boot it was read in, and a passing self-check observed after that same boot (never one an
# earlier boot left in the status). bootChanged: the guest restarted again after the boot the drill waited for.
function Get-DrillRebootSample($Sample, [DateTimeOffset]$WaitedBoot) {
  $boot = [string](Get-Prop $Sample 'boot')
  $known = $false; $changed = $false
  try { $b = [DateTimeOffset]::Parse($boot, [Globalization.CultureInfo]::InvariantCulture); $known = $b -ge $WaitedBoot; $changed = $b -gt $WaitedBoot } catch { $known = $false }
  $status = Get-Prop $Sample 'status'
  $ok = $known -and (Test-DrillAfterBoot ([string](Get-Prop $status 'writtenAt')) $boot)
  $cab = Get-Prop $Sample 'companionAfterBoot'
  # K3: the wait goes on until the companion is up as well (it may come after the self-check), within the same window
  $done = $ok -and [string](Get-Prop $status 'versions.selfcheck.result') -ceq 'PASS' -and (Test-DrillAfterBoot ([string](Get-Prop $status 'versions.selfcheck.observedAt')) $boot) -and (Test-DrillCompanionAfterBoot $cab $boot).pass
  [ordered]@{ ok = $ok; status = $status; readAt = (Get-Prop $Sample 'readAt'); boot = $(if ($known) { $boot } else { $null }); waitedBoot = $WaitedBoot.ToString('o'); bootChanged = $changed; done = $done; companionAfterBoot = $cab }
}

# Fable ruling 11-20 "first install r4" section 4 (E4): whether the first install left anything a reboot could expose, from the guest's raw
# read after it (GuestRead), never from A1's verdict: the status (state\status.json) or the installed pointer (upgrade\current.json) is there.
# Both absent: nothing was installed, A7 is not run. Either one there (a half install too): A7 runs, its reboot is what is to be seen.
function Test-DrillInstallProduced($Read) { ($null -ne (Get-Prop $Read 'status')) -or ($null -ne (Get-Prop $Read 'current')) }

# Within the window of the boot the drill waited for ($Deadline), until a sample of the boot it was read in passes; the last sample otherwise.
function Wait-DrillRebootRefresh([pscredential]$Cred, [DateTimeOffset]$Boot, [DateTimeOffset]$Deadline) {
  $reboot = $null
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    $r = Invoke-DrillGuest $Cred $script:GuestReadStatus -ArgumentList $script:Drill.GuestRoot -TimeoutMinutes 2 -Step 'read-status' -Restartable
    $reboot = Get-DrillRebootSample $r $Boot
    if ($reboot.done) { break }
    Start-Sleep -Seconds 30
  }
  return $reboot
}

# ---- The read-only guest probe (Fable ruling 0e418483, phase B image id, 4.3) ----------------------------------------------------------
# After every required piece of the first install's evidence is taken (the stage files, the guest's first-install.log, the launcher read-back;
# Save-DrillGuestEvidence) and before the checkpoint is restored, whether the first install passed or failed, one read-only pass over the
# guest's WSL distribution: the docker storage (Driver, DriverStatus), the image list, each kit image's .Id and RepoDigests, the sha256 and
# package version of every file the inventory names, systemctl --failed. The answers are kept raw in stage-evidence.json ('guest-probe'),
# never judged, and the probe is no part of the candidate's behaviour: a probe that cannot be built, cannot reach the guest, or answers
# nonsense is recorded as "not run" (stage-files.json) and changes nothing else.
#
# Where the file inventory comes from: drill/guest-probe-files.json, the one list (the files the offline inventory marks "needs a guest
# reading"; it always holds /usr/bin/python3.12). The drill reads it from beside this script; adding a file is one line there. Where the image
# references come from: the first-install kit among the release files the drill already holds (images.local[].id, referenced as sha256:<id>,
# the form the role policies use for a local image).
$script:ProbeFilesContract = 'clued.drill.guest-probe-files/1'
$script:ProbeImageRef = '^sha256:[0-9a-f]{64}$'
$script:ProbePath = '^/[A-Za-z0-9._+@/-]+$'
$script:DrillProbeImageIds = @()

function Test-DrillProbePath([string]$Path) { ($Path -cmatch $script:ProbePath) -and ($Path -cnotmatch '(^|/)\.\.(/|$)') }

# The inventory's paths, or a refusal by name (never an empty list read as "nothing to read").
function Read-DrillProbeFiles([string]$File = $script:Drill.ProbeFiles) {
  $doc = $null
  try { $doc = Read-DrillJson $File } catch { throw (New-DrillError 'DRILL_PROBE_FILES_REFUSED' 'unreadable') }
  if ([string](Get-Prop $doc 'contract') -cne $script:ProbeFilesContract) { throw (New-DrillError 'DRILL_PROBE_FILES_REFUSED' 'contract') }
  $paths = @(Get-Prop $doc 'paths' | Where-Object { $null -ne $_ })
  if ($paths.Count -lt 1) { throw (New-DrillError 'DRILL_PROBE_FILES_REFUSED' 'empty') }
  foreach ($p in $paths) { if ($p -isnot [string] -or -not (Test-DrillProbePath $p)) { throw (New-DrillError 'DRILL_PROBE_FILES_REFUSED' 'path') } }
  return @($paths | Sort-Object -Unique -CaseSensitive)
}

# The kit's local image references (sha256:<id>), sorted, once each, from the first-install kit among the release files. Anything that is not
# a readable kit gives no references: the rest of the probe does not depend on them.
function Get-DrillKitImageIds([string[]]$Files) {
  $ids = @{}
  foreach ($f in @($Files | Where-Object { $_ -and ([IO.Path]::GetFileName($_) -cmatch '\.first-install-kit\.json$') })) {
    try {
      $kit = Read-DrillJson $f
      foreach ($i in @(Get-Prop $kit 'images.local')) { $id = [string](Get-Prop $i 'id'); if ($id -cmatch '^[0-9a-f]{64}$') { $ids['sha256:' + $id] = $true } }
    } catch { }
  }
  return @($ids.Keys | Sort-Object -CaseSensitive)
}

# The commands, as data: an id, a bash script that only reads, and the arguments the script reads as $1. A reference or a path is an argument,
# never part of the script, and is of an exact shape or refused. Readings: ruling 0e418483 4.3 and the two offline inventories'
# "needs a guest reading" sections (D:/w/tmp/claude-r8-inventory.result.md 5, claude-r8-inventory2.result.md 6).
function Get-DrillProbeCommands([string[]]$ImageIds = @(), [string[]]$Files = @()) {
  foreach ($r in @($ImageIds)) { if ($r -cnotmatch $script:ProbeImageRef) { throw (New-DrillError 'DRILL_PROBE_PLAN_REFUSED' 'image') } }
  foreach ($p in @($Files)) { if (-not (Test-DrillProbePath $p)) { throw (New-DrillError 'DRILL_PROBE_PLAN_REFUSED' 'path') } }
  $one = { param([string]$Id, [string]$Script, [string[]]$Arguments = @()) [ordered]@{ id = $Id; script = $Script; args = [string[]]@($Arguments) } }
  # sha256 (a directory, a socket or a missing file answers with its error, kept raw), owner:group:mode:type, then the owning package and its version
  $fileScript = @'
p="$1"; sha256sum -- "$p"; stat -c '%U:%G:%a:%F' -- "$p"; dpkg-query -S -- "$p"; pkg=$(dpkg-query -S -- "$p" | head -n 1 | cut -d: -f1); [ -n "$pkg" ] && dpkg-query -W -f='${Package} ${Version}\n' "$pkg"
'@.Trim()
  $inspectScript = @'
docker image inspect --format '{{.Id}} {{json .RepoDigests}}' "$1"
'@.Trim()
  # every image the guest holds: Id, RepoDigests, Os and the config the trivy and gitleaks adapters check (Env, Volumes)
  $inspectAll = @'
ids=$(docker image ls -aq --no-trunc | sort -u); [ -z "$ids" ] || docker image inspect --format '{{.Id}} {{json .RepoDigests}} os={{.Os}} env={{json .Config.Env}} volumes={{json .Config.Volumes}}' $ids
'@.Trim()
  $verifyScript = 'systemd-analyze verify "$1"; echo "verify-exit=$?"'
  # first, with its own 120-second bound (plan 87d330d0 1.3): the instance's boot as read without systemctl -- the compact block (uptime,
  # systemd's private socket, PID 1's state, available memory, pressure), the last boots, then the journal of the previous boot and of this
  # one. Taken by boot, never --since a time: the guest's wall clock jumps across a suspend, its monotonic clock does not. Each journal
  # reading is bounded apart, so one that fails or hangs leaves the next its turn, and killed when it ignores TERM (-k). Together, kill
  # grace included, they end by 89 s: the 120-second wsl bound throws away all the command printed, so it must never be the one to cut.
  $bootScript = (@'
echo "uptime=$(cat /proc/uptime)"
if [ -S /run/systemd/private ]; then echo private=socket; elif [ -e /run/systemd/private ]; then echo private=not-socket; else echo private=absent; fi
echo "pid1=$(sed -n 's/^State:[[:space:]]*//p' /proc/1/status)"
echo "mem=$(free -m | awk '/^Mem:/{print $7}')"
p=; for r in cpu memory io; do p="$p $r=$(sed -n 's/^some .*avg10=\([0-9.]*\).*/\1/p' /proc/pressure/$r)"; done; echo "psi=${p# }"
echo '--- list-boots'; timeout -k 3s 10s journalctl --list-boots --no-pager | tail -n 3; s=${PIPESTATUS[0]}; [ "$s" = 0 ] || echo "(list-boots: exit $s)"
echo '--- boot -1'; timeout -k 3s 35s journalctl -b -1 -o short-monotonic --no-pager -n 300; s=$?; [ "$s" = 0 ] || echo "(boot -1: exit $s)"
echo '--- boot 0'; timeout -k 3s 35s journalctl -b 0 -o short-monotonic --no-pager -n 300; s=$?; [ "$s" = 0 ] || echo "(boot 0: exit $s)"
'@.Trim() -split '\r?\n') -join '; '
  # every docker command last: a docker.service stuck in activating holds each docker call to its bound, and must not take the readings
  # that do not need docker with it (r8 fixup review F2)
  $c = New-Object Collections.Generic.List[object]
  $boot = & $one 'guest-boot' $bootScript; $boot['seconds'] = 120; $c.Add($boot)
  foreach ($p in @($Files)) { $c.Add((& $one "file:$p" $fileScript @($p))) }
  $c.Add((& $one 'systemd-failed' 'systemctl --failed --no-pager --plain'))
  $c.Add((& $one 'systemd-is-system-running' 'systemctl is-system-running'))
  $c.Add((& $one 'systemd-version' 'systemctl --version'))
  $c.Add((& $one 'runner-service-enabled' 'systemctl is-enabled --quiet actions.runner.tdoljyj-cross-memory-system.clued-ci-home-linux-01.service; echo "is-enabled-exit=$?"'))
  $c.Add((& $one 'guest-nproc' 'nproc'))
  $c.Add((& $one 'guest-meminfo' "grep -E 'MemTotal|SwapTotal' /proc/meminfo"))
  $c.Add((& $one 'guest-uname' 'uname -r'))
  foreach ($u in $script:ProbeUnits) { $c.Add((& $one "systemd-verify:$u" $verifyScript @("/etc/systemd/system/$u"))) }
  $c.Add((& $one 'docker-driver' "docker info --format '{{json .Driver}}'"))
  $c.Add((& $one 'docker-driver-status' "docker info --format '{{json .DriverStatus}}'"))
  $c.Add((& $one 'docker-info-json' "docker info --format '{{json .}}'"))
  $c.Add((& $one 'docker-image-ls' 'docker image ls --no-trunc --digests'))
  $c.Add((& $one 'docker-image-inspect-all' $inspectAll))
  foreach ($r in @($ImageIds)) { $c.Add((& $one "image:$r" $inspectScript @($r))) }
  return $c.ToArray()
}
$script:ProbeUnits = @('clued-ci-worker@.service', 'clued-ci-wsprep@.service', 'clued-ci-archive@.service')

# The one command that is not a pure reading (Fable ruling 0e418483 addendum, r8 trivy cache A): after everything else has been decided,
# start a worker instance the worker's own guard rejects; systemd creates the unit's StateDirectory before ExecStartPre, so the trivy cache
# root must exist afterwards, owned by root with mode 700. The directory is read before the start and after it, the failed unit is reset.
# Never part of a verdict; a failure is only recorded.
$script:ProbeLateInstance = 'r8-probe-rejected'
function Get-DrillLateProbeCommands {
  $s = @'
n="$1"; d=/var/lib/clued-independent-ci-trivy-cache; stat -c '%U:%G:%a:%F' -- "$d"; echo "stat-before-exit=$?"; timeout 60 systemctl start "clued-ci-worker@${n}.service"; echo "start-exit=$?"; stat -c '%U:%G:%a:%F' -- "$d"; echo "stat-after-exit=$?"; systemctl reset-failed "clued-ci-worker@${n}.service"; echo "reset-failed-exit=$?"
'@.Trim()
  return @([ordered]@{ id = 'trivy-cache-by-rejected-worker'; script = $s; args = [string[]]@($script:ProbeLateInstance) })
}

# The bounds (r8 fixup review F2), without reading a clock in the guest: one command at most its own seconds when it names them (guest-boot,
# 120), else CommandSeconds; once MaxTimeouts commands
# have run into that bound (a docker stuck in activating, say), no further command is started, so the guest answers well inside
# Invoke-DrillGuestProbe's 5-minute outer bound with what it read. Spool: the guest file each command's result is appended to as it
# completes (one JSON line each), read back by the host when the outer bound cuts the probe all the same.
function New-DrillProbePlan($Commands, [string]$WslExe = '', [switch]$Windows, [string]$Spool = '', [int]$CommandSeconds = 30, [int]$MaxTimeouts = 2) {
  [ordered]@{ distribution = $script:Drill.ProbeDistribution; wslExe = $WslExe; commands = @($Commands); windows = [bool]$Windows
    spool = $Spool; commandSeconds = $CommandSeconds; maxTimeouts = $MaxTimeouts }
}

# In the guest (a script block). Each command runs apart as root in a clean environment (the form GuestPrereq uses), bounded, and its answer
# is kept raw; one that cannot answer is kept with the reason, and one not started after the timeouts says PROBE_STOPPED_AFTER_TIMEOUTS.
# Each result is appended to plan.spool as it completes (a spool that cannot be written stops nothing). With plan.windows, the drill
# machine's own readings follow (logical processors, physical memory, wsl --version, every profile's .wslconfig), each kept the same way.
# Without a plan it does nothing. No clock is read here (the host stamps the record).
$script:GuestInspect = {
  param($Plan, $NativeText)
  if ($Plan -isnot [Collections.IDictionary] -or $Plan['commands'] -isnot [Collections.IList]) { return $null }
  $native = [scriptblock]::Create($NativeText)
  $wslExe = if ([string]$Plan['wslExe']) { [string]$Plan['wslExe'] } else { "$env:SystemRoot\System32\wsl.exe" }
  $each = if ([int]$Plan['commandSeconds'] -gt 0) { [int]$Plan['commandSeconds'] } else { 30 }
  $maxTimeouts = if ([int]$Plan['maxTimeouts'] -gt 0) { [int]$Plan['maxTimeouts'] } else { 2 }
  $timeouts = 0
  $spool = [string]$Plan['spool']
  if ($spool) { try { [IO.File]::Delete($spool) } catch { } }
  $utf8 = New-Object Text.UTF8Encoding($false)
  $list = New-Object Collections.Generic.List[object]
  foreach ($c in @($Plan['commands'])) {
    $r = [ordered]@{ id = [string]$c['id']; script = [string]$c['script']; args = @(@($c['args']) | ForEach-Object { [string]$_ }); exit = $null; error = $null; stdout = ''; stderr = '' }
    if ($timeouts -ge $maxTimeouts) { $r.error = 'PROBE_STOPPED_AFTER_TIMEOUTS' }
    else {
      try {
        $argv = @('-d', [string]$Plan['distribution'], '-u', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C', 'LC_ALL=C', '/bin/bash', '-c', $r.script, '_') + @($r.args)
        $secs = if ([int]$c['seconds'] -gt 0) { [int]$c['seconds'] } else { $each }
        $n = & $native $wslExe $argv $secs 'utf-8'
        $out = [string]$n.stdout
        $r.exit = [int]$n.exit; $r.stdout = $(if ($out.Length -gt 200000) { $out.Substring(0, 200000) } else { $out }); $r.stderr = [string]$n.stderr
      } catch { $r.error = [string]$_.Exception.Message; if ($r.error -like 'COMMAND_TIMEOUT*') { $timeouts++ } }
    }
    $list.Add($r)
    if ($spool) { try { [IO.File]::AppendAllText($spool, (ConvertTo-Json -Compress -Depth 5 -InputObject $r) + "`n", $utf8) } catch { } }
  }
  $res = [ordered]@{ schema = 'clued.drill.guest-probe/1'; distribution = [string]$Plan['distribution']; commands = $list.ToArray() }
  if ($Plan['windows'] -eq $true) {
    $w = [ordered]@{ computerSystem = $null; wslVersion = $null; wslconfig = @(); errors = @() }
    $errs = New-Object Collections.Generic.List[string]
    try { $cs = Get-CimInstance Win32_ComputerSystem; $w.computerSystem = [ordered]@{ NumberOfLogicalProcessors = $cs.NumberOfLogicalProcessors; TotalPhysicalMemory = $cs.TotalPhysicalMemory } } catch { $errs.Add('computerSystem: ' + $_.Exception.Message) }
    try { $v = & $native $wslExe @('--version') $each 'utf-16'; $w.wslVersion = [ordered]@{ exit = [int]$v.exit; stdout = [string]$v.stdout; stderr = [string]$v.stderr } } catch { $errs.Add('wslVersion: ' + $_.Exception.Message) }
    try {
      $cfg = New-Object Collections.Generic.List[object]
      foreach ($f in @(Get-ChildItem -Path 'C:\Users\*\.wslconfig' -Force -ErrorAction SilentlyContinue)) {
        try { $cfg.Add([ordered]@{ path = $f.FullName; text = [IO.File]::ReadAllText($f.FullName) }) } catch { $cfg.Add([ordered]@{ path = $f.FullName; error = [string]$_.Exception.Message }) }
      }
      $w.wslconfig = $cfg.ToArray()
    } catch { $errs.Add('wslconfig: ' + $_.Exception.Message) }
    $w.errors = $errs.ToArray()
    $res.windows = $w
  }
  $res
}

# The host's side, once per phase. Phase 'main': after every required piece of the first install's evidence (Save-DrillGuestEvidence, last;
# 4.3 readings); phase 'late': the one worker-instance start. Returns @{ result; state; code; partial }: the result only when the guest
# answered with a probe of the expected shape, or -- when the outer bound cut it (DRILL_GUEST_STEP_TIMEOUT: the guest was answering) --
# the commands it had spooled by then (partial, state 'read-partial', the cut named in code). Never throws.
function Get-DrillProbeSpool([ValidateSet('main', 'late')][string]$Phase) { @{ dir = ($script:Drill.GuestWork + '\work'); name = "guest-probe-$Phase.jsonl" } }
function Read-DrillProbeSpool([pscredential]$Cred, $Spool, [string]$Step) {
  $got = Invoke-DrillGuest $Cred $script:GuestStageFiles -ArgumentList @($Spool.dir, @($Spool.name)) -TimeoutMinutes 1 -Step "$Step-partial"
  $f = Get-DrillField $got $Spool.name
  if ((Get-DrillField $f 'present') -ne $true -or (Get-DrillField $f 'error')) { return $null }
  $commands = New-Object Collections.Generic.List[object]; $cut = 0
  foreach ($line in @([string](Get-DrillField $f 'text') -split "`n" | Where-Object { $_.Trim() -ne '' })) {
    $x = $null; try { $x = $line | ConvertFrom-Json } catch { $x = $null }
    if ($null -ne $x -and (Get-DrillField $x 'id')) { $commands.Add($x) } else { $cut++ }
  }
  if ($commands.Count -eq 0) { return $null }
  [ordered]@{ schema = 'clued.drill.guest-probe/1'; distribution = $script:Drill.ProbeDistribution; partial = $true; cutLines = $cut; commands = $commands.ToArray() }
}
function Invoke-DrillGuestProbe([pscredential]$Cred, [ValidateSet('main', 'late')][string]$Phase = 'main') {
  $step = if ($Phase -ceq 'late') { 'guest-probe-late' } else { 'guest-probe' }
  $spool = Get-DrillProbeSpool $Phase
  try {
    $commands = if ($Phase -ceq 'late') { Get-DrillLateProbeCommands } else { Get-DrillProbeCommands -ImageIds @($script:DrillProbeImageIds) -Files @(Read-DrillProbeFiles) }
    $plan = New-DrillProbePlan $commands -Windows:($Phase -cne 'late') -Spool ($spool.dir + '\' + $spool.name)
  } catch { return @{ result = $null; state = 'not-run'; code = [string](Get-DrillCode $_).code; partial = $false } }
  try {
    $got = Invoke-DrillGuest $Cred $script:GuestInspect -ArgumentList @($plan, $script:DrillNativeText) -TimeoutMinutes 5 -Step $step
    if ([string](Get-DrillField $got 'schema') -cne 'clued.drill.guest-probe/1' -or $null -eq (Get-DrillField $got 'commands')) { return @{ result = $null; state = 'not-run'; code = 'DRILL_PROBE_NO_ANSWER'; partial = $false } }
    return @{ result = $got; state = 'read'; code = $null; partial = $false }
  } catch {
    $code = [string](Get-DrillCode $_).code
    if ($code -ceq 'DRILL_GUEST_STEP_TIMEOUT') {
      $part = try { Read-DrillProbeSpool $Cred $spool $step } catch { $null }
      if ($null -ne $part) { return @{ result = $part; state = 'read-partial'; code = $code; partial = $true } }
    }
    return @{ result = $null; state = 'not-run'; code = $code; partial = $false }
  }
}

# One probe phase, saved: merged into stage-evidence.json (main as 'guest-probe', late as 'guest-probe-late') when that file exists, else
# kept apart (guest-probe.json, guest-probe-late.json: the probe alone never makes stage-evidence.json, whose presence the abort evidence
# reads); its outcome beside it in stage-files.json ('probe', 'probeLate'). $SkipCode: not run, the guest is not asked. Not part of any
# verdict; every failure is swallowed after being recorded.
function Save-DrillProbe([string]$RunDir, [pscredential]$Cred, [ValidateSet('main', 'late')][string]$Phase, [string]$SkipCode = '') {
  $key = if ($Phase -ceq 'late') { 'guest-probe-late' } else { 'guest-probe' }
  $recordKey = if ($Phase -ceq 'late') { 'probeLate' } else { 'probe' }
  $state = $null
  try {
    $p = if ($SkipCode) { @{ result = $null; state = 'not-run'; code = $SkipCode; partial = $false } } else { Invoke-DrillGuestProbe $Cred $Phase }
    $state = [ordered]@{ state = $p.state; code = $p.code; partial = [bool]$p.partial; at = (Get-DrillTime).ToString('o') }
    if ($null -ne $p.result) {
      $evFile = Join-Path $RunDir 'stage-evidence.json'
      if (Test-Path -LiteralPath $evFile -PathType Leaf) {
        $ev = Read-DrillJson $evFile
        $ev | Add-Member -NotePropertyName $key -NotePropertyValue $p.result -Force
        Write-DrillJson $evFile $ev
        $state.state = 'saved'
      } else { Write-DrillJson (Join-Path $RunDir "$key.json") $p.result; $state.state = 'saved-apart' }
    }
  } catch { $state = [ordered]@{ state = 'not-saved'; code = [string](Get-DrillCode $_).code } }
  try {
    $sf = Join-Path $RunDir 'stage-files.json'
    $rec = if (Test-Path -LiteralPath $sf -PathType Leaf) { Read-DrillJson $sf } else { [pscustomobject]@{} }
    $rec | Add-Member -NotePropertyName $recordKey -NotePropertyValue $state -Force
    Write-DrillJson $sf $rec
  } catch { }
  return $state
}

# After the first install, the reboot and the reinstall have all been decided (the end of Invoke-DrillRun): the late probe.
function Save-DrillLateProbe([string]$RunDir, [pscredential]$Cred) { Save-DrillProbe $RunDir $Cred 'late' }

# The stage files the entry writes under the guest's work directory, read in the guest file by file with read-write sharing (a stage still
# writing holds its log open: the entry's line-by-line writer, the package's appending one; Read-StageResult in bootstrap.ps1 reads them
# the same way). One that cannot be read is named with its error, never taking the others with it.
# wsl-cold-start.json: what the entry found right after shutting the guest's WSL down before the launcher stage (Fable ruling 0e418483 4.2).
# resident-failure-snapshot.json: what the entry read of the guest when the first install did not end done (the resident's HALT, the
# launcher's progress records; r9 follow-up 1.3 B). Kept in the run directory as the guest wrote it. Only a first install that ended
# done writes none: after any other end its absence is a missing piece of evidence (Save-DrillGuestEvidence).
$script:DrillStageFiles = @('host.stdout.log', 'prepare.stdout.log', 'launcher.stdout.log', 'host-result.json', 'launcher-result.json', 'wsl-cold-start.json', 'stage-timings.json', 'resident-failure-snapshot.json')
$script:DrillFailureStageFiles = @('resident-failure-snapshot.json')
$script:GuestStageFiles = {
  param($Work, $Names)
  $r = [ordered]@{}
  foreach ($name in @($Names)) {
    $p = Join-Path $Work $name
    try {
      if (-not [IO.File]::Exists($p)) { $r[$name] = [ordered]@{ present = $false; text = $null; error = $null }; continue }
      $fs = New-Object IO.FileStream -ArgumentList $p, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::ReadWrite)
      try { $text = (New-Object IO.StreamReader -ArgumentList $fs, (New-Object Text.UTF8Encoding($false))).ReadToEnd() } finally { $fs.Dispose() }
      $r[$name] = [ordered]@{ present = $true; text = $text; error = $null }
    } catch { $r[$name] = [ordered]@{ present = $true; text = $null; error = [string]$_.Exception.Message } }
  }
  $r
}

# Takes the stage files back into the run directory, each on its own (the logs under their names, the two stage results as
# stage-evidence.json, the timings as stage-timings.json), and records each one's outcome in stage-files.json: saved, absent, unreadable
# in the guest, or not saved here. A failed collection is recorded and never replaces the run's own outcome.
function Save-DrillStageEvidence([string]$RunDir, [pscredential]$Cred) {
  $record = [ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); collection = $null; files = [ordered]@{} }
  $got = $null
  try { $got = Invoke-DrillGuest $Cred $script:GuestStageFiles -ArgumentList @(($script:Drill.GuestWork + '\work'), $script:DrillStageFiles) -TimeoutMinutes 2 -Step 'stage-files' }
  catch { $record.collection = (Get-DrillCode $_) }
  $json = [ordered]@{}
  foreach ($name in $script:DrillStageFiles) {
    $f = Get-DrillField $got $name
    if ($null -eq $f) { $record.files[$name] = [ordered]@{ state = 'not-collected' }; continue }
    if ((Get-DrillField $f 'present') -ne $true) { $record.files[$name] = [ordered]@{ state = 'absent' }; continue }
    $err = Get-DrillField $f 'error'
    if ($err) { $record.files[$name] = [ordered]@{ state = 'unreadable'; error = [string]$err }; continue }
    $text = [string](Get-DrillField $f 'text')
    # a stage JSON is evidence only when it reads as JSON (a cut one is named so, never "saved"); it is written below with the others
    if ($name.EndsWith('.json')) {
      $parsed = $null; try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null }
      if ($null -eq $parsed) { $record.files[$name] = [ordered]@{ state = 'unreadable-json'; bytes = $text.Length }; continue }
      if ($script:DrillFailureStageFiles -cnotcontains $name) { $json[$name] = $parsed; $record.files[$name] = [ordered]@{ state = 'read'; bytes = $text.Length }; continue }
    }
    try {
      [IO.File]::WriteAllText((Join-Path $RunDir $name), $text, (New-Object Text.UTF8Encoding($false)))
      $record.files[$name] = [ordered]@{ state = 'saved'; bytes = $text.Length }
    } catch { $record.files[$name] = [ordered]@{ state = 'not-saved'; error = [string]$_.Exception.Message } }
  }
  $stageEvidence = [ordered]@{ 'host-result.json' = $json['host-result.json']; 'launcher-result.json' = $json['launcher-result.json']; 'wsl-cold-start.json' = $json['wsl-cold-start.json'] }
  $timings = $json['stage-timings.json']
  $results = @(@('host-result.json', 'launcher-result.json', 'wsl-cold-start.json') | Where-Object { $json.Contains($_) })
  # Written only from what was really read (Codex review of e0a3cded5, medium 2): no stage-evidence.json or stage-timings.json from nothing,
  # and every file's state says whether it reached the run directory.
  if ($results.Count) {
    try { Write-DrillJson (Join-Path $RunDir 'stage-evidence.json') $stageEvidence; foreach ($n in $results) { $record.files[$n].state = 'saved' } }
    catch { foreach ($n in $results) { $record.files[$n] = [ordered]@{ state = 'not-saved'; error = [string]$_.Exception.Message } } }
  }
  if ($json.Contains('stage-timings.json')) {
    try { Write-DrillJson (Join-Path $RunDir 'stage-timings.json') $timings; $record.files['stage-timings.json'].state = 'saved' }
    catch { $record.files['stage-timings.json'] = [ordered]@{ state = 'not-saved'; error = [string]$_.Exception.Message } }
  }
  try { Write-DrillJson (Join-Path $RunDir 'stage-files.json') $record } catch { }
  return @{ stageEvidence = $stageEvidence; timings = $timings; record = $record }
}

# A1's kit entry in the guest, once, bounded, read apart (Invoke-DrillNative): its last stdout line is the result, its stderr is kept.
$script:GuestEntry = {
  param($Entry, $EntryArgs, $Minutes, $NativeText, $Log)
  $native = [scriptblock]::Create($NativeText)
  $n = & $native "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Entry) + @($EntryArgs)) ([int]$Minutes * 60) 'utf-8' $Log
  [ordered]@{ lines = @($n.stdout -split "`r?`n"); stderr = $n.stderr; exit = $n.exit }
}

# A8's second prepare after the reinstall, read the same way.
$script:GuestPrepareAgain = {
  param($Node, $Tree, $From, $Work, $TarName, $AccName, $TarSha, $NativeText)
  $native = [scriptblock]::Create($NativeText)
  $fleet = Join-Path $Tree 'work\independent-ci-resident-v1\rollout\fleet'
  $n = & $native $Node @((Join-Path $fleet 'install.mjs'), 'prepare', '--artifact', (Join-Path $From $TarName), '--artifact-sha', $TarSha, '--acceptance', (Join-Path $From $AccName), '--work', (Join-Path $Work 'a8-prepare-again')) 3600
  $l = @($n.stdout -split "`r?`n" | Where-Object { $_ -match '^\s*\{' }) | Select-Object -Last 1
  # the status, with the exit code and stderr beside it for reinstall.json (Codex review of 58136df61, low 4)
  [ordered]@{ status = $(if ($l) { [string]($l | ConvertFrom-Json).status } else { 'UNPARSED' }); exit = $n.exit; stderr = $n.stderr }
}

# 甲4: the first install ended done -- the only end after which A7, A8 and M5 have anything to drill.
function Test-DrillEntryDone($Entry) {
  return ($Entry.parsed -eq $true) -and ($Entry.exitCode -eq 0) -and ($null -eq $Entry.stopCode) -and ([string]$Entry.status -ceq 'FIRST_INSTALL_DONE')
}

# $Deadline: the guard's deadline for the run (Invoke-DrillPreparedRun gives $Window.deadline). 甲2: the foreground stops
# Get-DrillEvidenceWindowMinutes before it (DRILL_RUN_TIMEOUT, by = foreground), so the evidence is taken and the run's own cleanup
# restores before the guard would; without a deadline (MinValue) there is no foreground limit.
# The host's own steps of a run, around the entry's stages (fix round 1 of 87d330d0, review high 1): copy-in before the entry, the read
# after it, A7's reboot and A8 -- one line in host-steps.jsonl as each starts and one as it ends, so the receipt's stage timeline says
# where a run that was cut off was, outside the entry as well (Get-DrillStageTimeline). An aid: a line that cannot be written is not.
function Write-DrillHostStep([string]$RunDir, [string]$Stage, [string]$Event, [string]$Result = 'running', $Code = $null) {
  try {
    $line = [ordered]@{ stage = $Stage; event = $Event; at = (Get-DrillTime).ToString('o'); result = $Result; code = $Code }
    [IO.File]::AppendAllText((Join-Path $RunDir 'host-steps.jsonl'), (ConvertTo-Json -InputObject $line -Compress) + "`n", (New-Object Text.UTF8Encoding($false)))
  } catch { }
}

function Invoke-DrillRun([string]$RunDir, $Package, $KitInfo, $Prereq, [pscredential]$Cred, [DateTimeOffset]$Deadline = [DateTimeOffset]::MinValue) {
  $g = $script:Drill.GuestWork
  $foreground = $null
  if ($Deadline -ne [DateTimeOffset]::MinValue) {
    $window = Get-DrillEvidenceWindowMinutes $RunTimeoutMinutes
    $foreground = @{ at = $Deadline.AddMinutes(-$window); code = 'DRILL_RUN_TIMEOUT'
      detail = [ordered]@{ by = 'foreground'; deadline = $Deadline.ToString('o'); evidenceWindowMinutes = $window } }
  }
  $prereqFacts = if ($Interactive -or $KitInfo.prerequisiteMode -ceq 'first-install-host') { @{ mode = 'first-install-host'; preparedByEntry = (-not $Interactive) } } else { Invoke-DrillPrereqInGuest $RunDir $Prereq $Cred }
  $paths = @{ from = "$g\from"; kit = "$g\kit"; fake = "$g\fake"; work = "$g\work"; version = $Package.version }
  Write-DrillHostStep $RunDir 'copy-in' 'start'
  try {
  $session = New-PSSession -VMName $script:Drill.VmName -Credential $Cred
  try {
    Invoke-Command -Session $session -ScriptBlock { param($p) foreach ($d in @($p.from, $p.kit, $p.work)) { New-Item -ItemType Directory -Force -Path $d | Out-Null } } -ArgumentList $paths
    foreach ($f in $Package.files) { Copy-Item -LiteralPath $f -Destination $paths.from -ToSession $session }
    Copy-Item -Path (Join-Path $KitInfo.dir '*') -Destination $paths.kit -ToSession $session -Recurse
    $tarInGuest = Invoke-Command -Session $session -ScriptBlock { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } -ArgumentList (Join-Path $paths.from ([IO.Path]::GetFileName($Package.tar)))
    if ($tarInGuest -cne $Package.tarSha256) { throw (New-DrillError 'DRILL_TAR_CHANGED_IN_COPY') }
    # only the files of the names this package declares and the drill gives (Get-DrillCredentialPlan)
    # the CI token is the Owner's drill binding (read here, handed over the PowerShell Direct session, written in the guest only)
    $fakeNames = [string[]]@((Get-DrillCredentialPlan $KitInfo).fake)
    $binding = if ($fakeNames -ccontains 'ci-admission.token') { Get-DrillCredential -Binding } else { $null }
    $fake = Invoke-Command -Session $session -ScriptBlock ([scriptblock]::Create(${function:New-DrillFakeCredentials}.ToString())) -ArgumentList $paths.fake, $fakeNames, $binding
    Write-DrillJson (Join-Path $RunDir 'fake-credentials.public.json') $fake
  } finally { Remove-PSSession -Session $session }
  } catch { Write-DrillHostStep $RunDir 'copy-in' 'end' 'failed' (Get-DrillCode $_).code; throw }
  Write-DrillHostStep $RunDir 'copy-in' 'end' 'ok'

  # the kit's image references for the guest probe, which runs on every end of the first install (Save-DrillGuestEvidence, last)
  $script:DrillProbeImageIds = @(try { Get-DrillKitImageIds @($Package.files) } catch { })
  $timings = $null; $launcher = $null
  if ($Interactive) {
    # the guest evidence on a timeout or a cancel as well (Codex review of ced480363, medium 8)
    try { $interactiveRun = Wait-DrillInteractive $RunDir $paths $Cred }
    finally { $collected = Save-DrillGuestEvidence $RunDir $Cred $null }
    $entry = $interactiveRun.entry; $launcher = $interactiveRun.launcher; $Cred = $interactiveRun.credential
  } else {
  # A1: the kit entry, once, bounded. No retry. Read apart (Invoke-DrillNative), its printed lines also written to the guest's
  # first-install.stdout.log as they come (a first install cut off still leaves them).
  $entryArgs = Resolve-DrillKitArguments $KitInfo.arguments $paths
  # The guest evidence -- the entry's printed lines and the stage files -- is taken back on every end of this call: done, stopped, timed
  # out (Save-DrillGuestEvidence; Codex reviews of ced480363 and c1497e0a1); the original error is thrown on after.
  $entryOut = $null
  # 甲1/2.4: the progress files pulled each tick into the run directory and the stage's no-progress gate (guest-progress.json)
  $progress = New-DrillGuestProgress $RunDir
  try {
    $entryOut = Invoke-DrillGuest $Cred $script:GuestEntry -ArgumentList @((Join-Path $paths.kit $KitInfo.entryFile), $entryArgs, $KitInfo.timeoutMinutes, $script:DrillNativeText, (Join-Path $paths.work $script:Drill.GuestEntryLog)) -TimeoutMinutes $KitInfo.timeoutMinutes -Code 'DRILL_FIRST_INSTALL_TIMEOUT' -Step 'first-install' -Until $foreground -Progress $progress
  } finally {
    # on every end of the first install, before anything else happens to the guest
    $collected = Save-DrillGuestEvidence $RunDir $Cred $entryOut
  }
  # first-install.log is written by Save-DrillGuestEvidence (the returned lines, or the guest's copy)
  [IO.File]::WriteAllText((Join-Path $RunDir 'first-install.stderr.log'), [string]$entryOut.stderr)
  $entry = Read-DrillEntryResult @($entryOut.lines) ([int]$entryOut.exit)
  # the launcher's terminal (what A6 reads the confirmed pause from), as the entry kept it in launcher-result.json, saved here and read back
  $launcher = $collected.launcher
  }
  $timings = $collected.timings
  # the first install's own result, kept on its own: A1 stands even when a later step stops the run (Get-DrillA1Item)
  Write-DrillJson (Join-Path $RunDir 'entry-result.json') $entry
  # 甲3: the steps after the first install (the read, A7's reboot, A8) share one limit, AfterEntryMaxMinutes from now or the foreground
  # deadline, whichever is earlier; the evidence collection, the late probe and M5 are not under it.
  $afterEntry = Get-DrillEarlierUntil $foreground @{ at = (Get-DrillTime).AddMinutes($script:Drill.AfterEntryMaxMinutes); code = 'DRILL_AFTER_ENTRY_TIMEOUT'
    detail = [ordered]@{ minutes = $script:Drill.AfterEntryMaxMinutes; since = (Get-DrillTime).ToString('o') } }
  $entryDone = Test-DrillEntryDone $entry

  Write-DrillHostStep $RunDir 'read-after-install' 'start'
  $first = Invoke-DrillGuest $Cred $script:GuestRead -ArgumentList @($script:Drill.GuestRoot, $script:DrillNativeText) -TimeoutMinutes 15 -Step 'read-after-install' -Restartable -Until $afterEntry
  Write-DrillJson (Join-Path $RunDir 'read-after-install.json') $first

  # A7: reboot, nobody logs in; within 10 minutes the status is rewritten after the boot and the self-check still passes. Only when the
  # install left something (Test-DrillInstallProduced): with nothing installed a reboot exposes nothing, and A7 says why it did not run.
  # 甲4: a first install that did not end done blocks A7 (recorded, not run)
  if (-not (Test-DrillInstallProduced $first)) { $reboot = [ordered]@{ skipped = $true; reason = 'DRILL_A7_BLOCKED_NOTHING_INSTALLED' } }
  elseif (-not $entryDone) { $reboot = [ordered]@{ skipped = $true; reason = 'DRILL_A7_BLOCKED_BY_A1' } }
  else {
    Assert-DrillUntil $afterEntry
    Write-DrillHostStep $RunDir 'A7-reboot' 'start'
    $beforeReboot = [DateTimeOffset]::UtcNow
    try { Invoke-Command -VMName $script:Drill.VmName -Credential $Cred -ScriptBlock { Restart-Computer -Force } -ErrorAction Stop } catch { }
    $left = [int][Math]::Ceiling(($afterEntry.at - (Get-DrillTime)).TotalMinutes)
    try { $boot = Wait-DrillGuest $Cred ([Math]::Max(1, [Math]::Min(15, $left))) $beforeReboot } catch { Assert-DrillUntil $afterEntry; throw }
    $refreshBy = $boot.AddMinutes($script:Drill.UnattendedRebootMinutes)
    if ($afterEntry.at -lt $refreshBy) { $refreshBy = $afterEntry.at }
    $reboot = Wait-DrillRebootRefresh $Cred $boot $refreshBy
  }
  Write-DrillJson (Join-Path $RunDir 'read-after-reboot.json') $reboot

  # A8: same package again: the generic upgrade answers "already at this package"; prepare -> launcher -> verify -> prepare.
  $reinstall = @{ skipped = $true }
  if (-not $SkipReinstall -and -not $entryDone) {
    # 甲4: blocked by A1 (recorded, not run)
    $reinstall = @{ skipped = $false; upgradeStatus = 'DRILL_A8_BLOCKED_BY_A1'; prepareStatus = $null; reverifyPassed = $false; prepareAgainStatus = $null }
  } elseif (-not $SkipReinstall -and $entry.tree -and $entry.node) {
    # the upgrade first, on its own; its raw result is on the host before the prepare starts (Codex narrow review of 4190b0f8e, medium)
    Write-DrillHostStep $RunDir 'A8-reinstall' 'start'
    $upRun = Invoke-DrillGuest $Cred $script:GuestReinstallUpgrade -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, $Package.version, $script:DrillNativeText) -TimeoutMinutes 65 -Code 'DRILL_REINSTALL_TIMEOUT' -Step 'reinstall-upgrade' -Until $afterEntry
    Write-DrillJson (Join-Path $RunDir 'reinstall-upgrade.json') (ConvertTo-DrillReinstallUpgradeRecord $upRun)
    $reinstall = Invoke-DrillGuest $Cred $script:GuestReinstall -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, $Package.version, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256, $script:DrillNativeText, $upRun) -TimeoutMinutes 180 -Code 'DRILL_REINSTALL_TIMEOUT' -Step 'reinstall' -Until $afterEntry
    Write-DrillJson (Join-Path $RunDir 'reinstall.json') $reinstall
  } elseif (-not $SkipReinstall) { $reinstall = @{ skipped = $false; upgradeStatus = 'NOT_RUN_ENTRY_GAVE_NO_TREE_OR_NODE'; prepareStatus = $null; reverifyPassed = $false; prepareAgainStatus = $null } }

  if (Test-DrillReinstallLauncher $reinstall) {
    # the re-verify runs the whole verdict: its input carries the launcher verdict and the pause, the same sources as the first install's A6
    # (Codex review of f33fc33e5, medium 5: without them strict mode stopped it before prepare-again)
    $again = Invoke-DrillGuest $Cred $script:GuestRead -ArgumentList @($script:Drill.GuestRoot, $script:DrillNativeText) -TimeoutMinutes 15 -Step 'read-after-reinstall' -Restartable -Until $afterEntry
    Write-DrillJson (Join-Path $RunDir 'read-after-reinstall.json') $again
    $reVerdict = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($again.readAt); entry = $entry; launcher = $launcher; pause = $again.pause; verify = $again.verify; status = $again.status; current = $again.current; facts = $again.facts; acceptanceSource = $Package.ciSourceManifestSha256; reboot = $null; reinstall = $null; kit = $KitInfo }
    $reinstall.reverifyPassed = @($reVerdict | Where-Object { $_.id -in @('A2', 'A3', 'A4') -and $_.pass -ne $true }).Count -eq 0 -and $null -eq (@($reVerdict | Where-Object { $_.id -eq 'A5' })[0].pass)
    $p2 = Invoke-DrillGuest $Cred $script:GuestPrepareAgain -ArgumentList @($entry.node, $entry.tree, $paths.from, $paths.work, [IO.Path]::GetFileName($Package.tar), [IO.Path]::GetFileName($Package.acceptance), $Package.tarSha256, $script:DrillNativeText) -TimeoutMinutes 60 -Step 'prepare-again' -Until $afterEntry
    $reinstall.prepareAgainStatus = [string](Get-Prop $p2 'status'); $reinstall.prepareAgainExit = $p2.exit; $reinstall.prepareAgainStderr = $p2.stderr
    Write-DrillJson (Join-Path $RunDir 'reinstall.json') $reinstall
  }

  # the one worker-instance start (r8 trivy cache): after everything the verdict reads has been collected; never part of a verdict
  [void](Save-DrillLateProbe $RunDir $Cred)

  # 甲4: M5 is read only after a first install that ended done; otherwise blocked by A1 (recorded, not read)
  $m5 = if (-not $entryDone) { @{ directory = 'm5'; missing = @($script:DrillM5Names); collectionCode = 'DRILL_M5_BLOCKED_BY_A1'; blocked = $true } }
    else { try { Copy-DrillM5 $RunDir $Cred } catch { @{ collectionCode = (Get-DrillCode $_).code } } }
  return @{ entry = $entry; launcher = $launcher; first = $first; reboot = $reboot; reinstall = $reinstall; fake = $fake; prereq = $prereqFacts; timings = $timings; m5 = $m5 }
}

# Fable renew-key ruling, supplement "companion account and evidence" section 2 (defect 0de212cb, the drill's half): the guest's evidence of
# the first install is taken on every end of it -- done, stopped, timed out -- before anything else happens to the guest, so always before
# the checkpoint restore. Only what the entry wrote under the guest work directory: its printed lines, the stage timings and the two stage
# result files (no credential file). A failed collection is recorded (guest-evidence.json) and never replaces the run's own outcome.
function Write-DrillLines([string]$Path, [string[]]$Lines) { [IO.File]::WriteAllLines($Path, $Lines) }

function Save-DrillGuestEvidence([string]$RunDir, [pscredential]$Cred, $EntryOut) {
  # the entry's guest log here; the stage files (three complete stage logs, two stage results, the timings) by Save-DrillStageEvidence:
  # each read with read-write sharing and saved on its own, its state in stage-files.json (this branch's reading, branch two)
  $names = @($script:Drill.GuestEntryLog)
  # entryLog: which copy of the entry's lines first-install.log holds -- 'returned' (what the entry gave back), 'guest-log' (the guest's
  # copy, fetched below), or $null (none written). ok only when everything was written, the returned lines included.
  $record = [ordered]@{ ok = $false; code = $null; detail = $null; missing = @(); entryLog = $null; entryLogError = $null; launcherReadback = $null; at = [DateTimeOffset]::UtcNow.ToString('o') }
  $timings = $null
  $logFile = Join-Path $RunDir 'first-install.log'
  # what the entry already returned is kept first: a failed collection below loses the stage files only (Codex review of ced480363, medium 6);
  # a failed write is not swallowed: recorded, and the guest's copy written in its place once fetched (review of 74e7a65e7, medium 2)
  if ($null -ne $EntryOut) {
    try { Write-DrillLines $logFile @($EntryOut.lines); $record.entryLog = 'returned' }
    catch { $record.entryLogError = [string]$_.Exception.Message }
  }
  # an interactive run sets its own password for the guest account (Wait-DrillInteractive); the collection logs on with it
  if ($script:DrillInteractiveCredential) { $Cred = $script:DrillInteractiveCredential }
  $stage = Save-DrillStageEvidence $RunDir $Cred
  $timings = $stage.timings
  try {
    # 明盒: the entry's own stage record comes with its log (an extra: a kit whose entry does not write it misses nothing)
    $got = Invoke-DrillGuest $Cred $script:GuestStageFiles -ArgumentList @(($script:Drill.GuestWork + '\work'), @($names + 'stage-progress.jsonl')) -TimeoutMinutes 2 -Step 'guest-evidence'
    $text = { param($n) $f = Get-DrillField $got $n; if ((Get-DrillField $f 'present') -eq $true -and -not (Get-DrillField $f 'error')) { [string](Get-DrillField $f 'text') } else { $null } }
    $record.missing = @($names | Where-Object { $null -eq (& $text $_) })
    $log = & $text $script:Drill.GuestEntryLog
    $stageRecord = & $text 'stage-progress.jsonl'
    if ($null -ne $stageRecord) { try { [IO.File]::WriteAllText((Join-Path $RunDir 'stage-progress.jsonl'), $stageRecord, (New-Object Text.UTF8Encoding($false))) } catch { } }
    # the guest's copy only when there is one: no empty file and no 'guest-log' without it (Codex review of f734afe7e, low 1)
    if ($null -eq $record.entryLog -and $null -ne $log) {
      Write-DrillLines $logFile @($log -split "`r?`n" | Where-Object { $_ -ne '' })
      $record.entryLog = 'guest-log'
    }
  } catch {
    $c = Get-DrillCode $_
    $record.code = $c.code; $record.detail = $c.detail
  }
  # 甲1: no copy written above, but the progress pulls left the entry's log in the run directory (the last tick before the end)
  if ($null -eq $record.entryLog -and (Test-Path -LiteralPath $logFile -PathType Leaf)) { $record.entryLog = 'progress-pull' }
  # the stage files that did not reach the run directory are missing too (their states: stage-files.json). The failure snapshot is
  # written only when the first install did not end done, so its absence is nothing missing only when the entry itself said
  # FIRST_INSTALL_DONE: stopped, cut off, or no result returned at all, it is missing (FABLE-r9-lineB-points R2: the entry swallows a
  # snapshot it could not write, and r9 lost the resident's HALT without anything saying so).
  $entryDone = $false
  if ($null -ne $EntryOut) { try { $entryDone = ([string](Read-DrillEntryResult @($EntryOut.lines) 0).status -ceq 'FIRST_INSTALL_DONE') } catch { $entryDone = $false } }
  $record.missing = @(@($record.missing) + @(@($stage.record.files.Keys) | Where-Object { $state = [string]$stage.record.files[$_].state; $state -cne 'saved' -and -not ($state -ceq 'absent' -and $entryDone -and $script:DrillFailureStageFiles -ccontains $_) }))
  $record.stageFiles = $stage.record.files
  # the launcher's verdict for A6 only as saved in the run directory and read back from there (same review): never the collected object.
  # A read-back that fails is recorded with its detail (6th review round, low 2).
  $launcher = $null
  if ([string](Get-DrillField (Get-DrillField $stage.record.files 'launcher-result.json') 'state') -ceq 'saved') {
    try {
      $back = Get-DrillField (Read-DrillJson (Join-Path $RunDir 'stage-evidence.json')) 'launcher-result.json'
      if ($null -eq $back) { throw 'launcher-result.json is not in the saved stage-evidence.json' }
      # the field itself must be there (the entry writes terminal: null when the stage gave no verdict; 7th review round, low 2)
      $hasTerminal = if ($back -is [Collections.IDictionary]) { $back.Contains('terminal') } else { $null -ne $back.PSObject.Properties['terminal'] }
      if (-not $hasTerminal) { throw 'launcher-result.json read back has no terminal field' }
      $launcher = Get-Prop $back 'terminal'
      $record.launcherReadback = [ordered]@{ ok = $true; error = $null }
    } catch { $launcher = $null; $record.launcherReadback = [ordered]@{ ok = $false; error = [string]$_.Exception.Message } }
  }
  # ok only after every file's state is summed and the launcher's verdict read back (Codex review of f33fc33e5, medium 2; 6th round, low 2):
  # anything absent, unreadable or not saved, or a failed read-back, makes it false
  $record.ok = ($null -eq $record.code) -and ($null -eq $record.entryLogError) -and ($null -ne $record.entryLog) -and ($null -eq $stage.record.collection) -and (@($record.missing).Count -eq 0) `
    -and ((Get-DrillField (Get-DrillField $record 'launcherReadback') 'ok') -ne $false)
  try { Write-DrillJson (Join-Path $RunDir 'guest-evidence.json') $record } catch { }
  # The read-only guest probe (4.3), an extra: only now, after every required piece -- the stage files, the guest's first-install.log, the
  # launcher read-back -- has been taken and written (r8 fixup review F1: a first install that hung is a guest whose WSL or docker is the
  # likeliest to hang, and the probe must not eat the time of the evidence the verdict reads). Still before the checkpoint restore. A guest
  # that could not be reached for that evidence is not asked again (no second readiness wait); either way only recorded (stage-files.json).
  $skip = if ($null -ne $stage.record.collection -or $null -ne $record.code) { 'DRILL_PROBE_SKIPPED_COLLECTION_FAILED' } else { '' }
  [void](Save-DrillProbe $RunDir $Cred 'main' $skip)
  return @{ record = $record; timings = $timings; stageEvidence = $stage.stageEvidence; launcher = $launcher }
}

# 明盒 (coordinator, Owner 11-23): the receipt's stage timeline, on every end -- PASS, FAIL, the foreground deadline, a guard abort, a
# no-progress stop. Read from the run directory only: the entry's stage-progress.jsonl (one line as each stage starts, one as it ends;
# pulled each tick and taken again with the evidence), else -- a kit whose entry does not write it -- the stage logs that reached the run
# directory. A stage that started and never ended is 'aborted-in-progress' (进行中被中止); the host's own steps after the first install
# follow, from the records they wrote.
# A step line inside a stage (the entry's prereq: item, step, bytes): on the stage of that name still running, else the last of that name.
function Add-DrillTimelineStep($Stages, [string]$Name, $E) {
  $owner = $null
  for ($i = $Stages.Count - 1; $i -ge 0; $i--) { if ($Stages[$i].stage -ceq $Name -and $Stages[$i].result -ceq 'running') { $owner = $Stages[$i]; break } }
  if ($null -eq $owner) { for ($i = $Stages.Count - 1; $i -ge 0; $i--) { if ($Stages[$i].stage -ceq $Name) { $owner = $Stages[$i]; break } } }
  if ($null -eq $owner) { return }
  if (-not $owner.Contains('steps')) { $owner.steps = New-Object Collections.Generic.List[object] }
  $item = [string](Get-DrillField $E 'item'); $stepName = [string](Get-DrillField $E 'step')
  $st = $null
  for ($i = $owner.steps.Count - 1; $i -ge 0; $i--) { if ($owner.steps[$i].item -ceq $item -and $owner.steps[$i].step -ceq $stepName -and $owner.steps[$i].result -ceq 'running') { $st = $owner.steps[$i]; break } }
  if ([string](Get-DrillField $E 'event') -ceq 'step-start' -or $null -eq $st) {
    $st = [ordered]@{ item = $item; step = $stepName; bytes = (Get-DrillField $E 'bytes'); startedAt = (Get-DrillField $E 'startedAt'); endedAt = $null; result = 'running'; code = $null }
    $owner.steps.Add($st)
  }
  if ([string](Get-DrillField $E 'event') -ceq 'step-end') { $st.endedAt = Get-DrillField $E 'endedAt'; $st.result = [string](Get-DrillField $E 'result'); $st.code = Get-DrillField $E 'code' }
}
# The last step line ({name, result, at}) of a stage log in the run directory; $null when it has none.
function Get-DrillLastStepLine([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
  $lines = @(try { [IO.File]::ReadAllLines($File) } catch { @() })
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $t = $lines[$i].Trim()
    if (-not $t.StartsWith('{')) { continue }
    $o = $null; try { $o = $t | ConvertFrom-Json } catch { continue }
    $name = Get-DrillField $o 'name'; $result = Get-DrillField $o 'result'
    if ($name -and $result) { return [ordered]@{ name = [string]$name; result = [string]$result; at = (Get-DrillField $o 'at') } }
  }
  return $null
}
# The host's own steps of a run (host-steps.jsonl, Write-DrillHostStep) by name: startedAt, endedAt, result (running until it ended), code.
function Read-DrillHostSteps([string]$RunDir) {
  $steps = [ordered]@{}
  $file = Join-Path $RunDir 'host-steps.jsonl'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $steps }
  foreach ($line in @([IO.File]::ReadAllLines($file))) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $e = $null; try { $e = $line | ConvertFrom-Json } catch { continue }
    $name = [string](Get-DrillField $e 'stage'); if (-not $name) { continue }
    if ([string](Get-DrillField $e 'event') -ceq 'start' -or -not $steps.Contains($name)) {
      $steps[$name] = [ordered]@{ stage = $name; startedAt = (Get-DrillField $e 'at'); endedAt = $null; result = 'running'; code = $null; tail = $null }
    }
    if ([string](Get-DrillField $e 'event') -ceq 'end') { $steps[$name].endedAt = Get-DrillField $e 'at'; $steps[$name].result = [string](Get-DrillField $e 'result'); $steps[$name].code = Get-DrillField $e 'code' }
  }
  return $steps
}

function Get-DrillStageTimeline([string]$RunDir) {
  $stages = New-Object Collections.Generic.List[object]
  $source = $null
  $file = Join-Path $RunDir 'stage-progress.jsonl'
  if (Test-Path -LiteralPath $file -PathType Leaf) {
    $source = 'stage-progress'
    foreach ($line in @([IO.File]::ReadAllLines($file))) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $e = $null; try { $e = $line | ConvertFrom-Json } catch { continue }   # a line cut by the pull is not a record
      $name = [string](Get-DrillField $e 'stage'); if (-not $name) { continue }
      $event = [string](Get-DrillField $e 'event')
      if ($event -clike 'step-*') { Add-DrillTimelineStep $stages $name $e; continue }
      $open = $null
      for ($i = $stages.Count - 1; $i -ge 0; $i--) { if ($stages[$i].stage -ceq $name -and $stages[$i].result -ceq 'running') { $open = $stages[$i]; break } }
      if ([string](Get-DrillField $e 'event') -ceq 'start' -or $null -eq $open) {
        $open = [ordered]@{ stage = $name; startedAt = (Get-DrillField $e 'startedAt'); endedAt = $null; result = 'running'; code = $null; tail = $null }
        $stages.Add($open)
      }
      if ([string](Get-DrillField $e 'event') -ceq 'end') {
        $open.endedAt = Get-DrillField $e 'endedAt'; $open.result = [string](Get-DrillField $e 'result'); $open.code = Get-DrillField $e 'code'
        $t = Get-DrillField $e 'tail'; if ($null -ne $t) { $open.tail = [object[]]@($t) }   # a list even of one line
      }
    }
  } else {
    # no record of its own: the stages whose logs reached the run directory, in order; a stage the next one followed was left, its verdict unknown
    $present = @(@(@('entry', 'first-install.log'), @('host', 'host.stdout.log'), @('prepare', 'prepare.stdout.log'), @('launcher', 'launcher.stdout.log')) |
      Where-Object { Test-Path -LiteralPath (Join-Path $RunDir $_[1]) -PathType Leaf })
    if ($present.Count) { $source = 'stage-logs' }
    foreach ($p in $present) { $stages.Add([ordered]@{ stage = $p[0]; startedAt = $null; endedAt = $null; result = 'left'; code = $null; tail = $null }) }
    if ($stages.Count -and -not (Test-Path -LiteralPath (Join-Path $RunDir 'entry-result.json') -PathType Leaf)) { $stages[$stages.Count - 1].result = 'running' }
    elseif ($stages.Count) { $stages[$stages.Count - 1].result = 'ended' }
  }
  # the host's own steps (host-steps.jsonl): copy-in before the entry's stages; the ones after it below
  $hostSteps = Read-DrillHostSteps $RunDir
  if ($hostSteps.Contains('copy-in')) { $stages.Insert(0, $hostSteps['copy-in']) }
  # the run is over: a stage still running was cut off, and the step it was in (prereq: which item, which step)
  foreach ($s in $stages) {
    if ($s.result -ceq 'running') { $s.result = 'aborted-in-progress'; $s.label = '进行中被中止' }
    if (-not $s.Contains('steps')) { continue }
    foreach ($st in $s.steps) { if ($st.result -ceq 'running') { $st.result = 'aborted-in-progress'; if ($s.result -ceq 'aborted-in-progress') { $s.inProgressStep = $st } } }
  }
  # item 7: a cut-off stage with a log of step lines and no step in progress recorded (a host preparation that does not write its steps'
  # starts, the candidate 2026.11.23-d5da6825's): the last step line its log printed and when -- the step after it is the one it was in
  foreach ($s in $stages) {
    if ($s.result -cne 'aborted-in-progress' -or $s.Contains('inProgressStep')) { continue }
    $log = @{ host = 'host.stdout.log'; prepare = 'prepare.stdout.log'; launcher = 'launcher.stdout.log' }[[string]$s.stage]
    if (-not $log) { continue }
    $last = Get-DrillLastStepLine (Join-Path $RunDir $log)
    if ($null -ne $last) { $s.lastStepLine = $last }
  }
  # the host's steps after the first install, each from the record it wrote; one that started and wrote none was cut off (absent: not reached)
  $entryFile = Join-Path $RunDir 'entry-result.json'
  if (Test-Path -LiteralPath $entryFile -PathType Leaf) {
    $er = try { Read-DrillJson $entryFile } catch { $null }
    $stages.Add([ordered]@{ stage = 'A1-entry-result'; result = $(if ($er -and (Test-DrillEntryDone $er)) { 'ok' } else { 'failed' }); code = $(if ($er) { $(if ($er.stopCode) { $er.stopCode } else { $er.status }) } else { 'unreadable' }) })
  }
  foreach ($pair in @(@('read-after-install', 'read-after-install.json'), @('A7-reboot', 'read-after-reboot.json'), @('A8-reinstall', 'reinstall.json'))) {
    $f = Join-Path $RunDir $pair[1]
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
      $started = $hostSteps[$pair[0]]
      if ($null -ne $started) { $stages.Add([ordered]@{ stage = $pair[0]; startedAt = $started.startedAt; result = 'aborted-in-progress'; code = $null; label = '进行中被中止' }) }
      continue
    }
    $doc = try { Read-DrillJson $f } catch { $null }
    $skip = if ((Get-Prop $doc 'skipped') -eq $true) { [string](Get-Prop $doc 'reason') } elseif ([string](Get-Prop $doc 'upgradeStatus') -like 'DRILL_*BLOCKED*') { [string](Get-Prop $doc 'upgradeStatus') } else { $null }
    $stages.Add([ordered]@{ stage = $pair[0]; result = $(if ($null -eq $doc) { 'unreadable' } elseif ($null -ne $skip) { 'skipped' } else { 'recorded' }); code = $skip })
  }
  $n = 0; foreach ($s in $stages) { $n++; $s.n = $n; if ($s.Contains('steps')) { $s.steps = $s.steps.ToArray() } }
  $abortedIn = $null
  foreach ($s in $stages) { if ($s.result -ceq 'aborted-in-progress') { $abortedIn = $s.stage } }
  return [ordered]@{ source = $source; reached = $stages.Count; abortedIn = $abortedIn; stages = $stages.ToArray() }
}

# ---------------------------------------------------------------- main
# Ladder mode (-Ladder; coordinator, Owner 11-23: "先把每段结论传回来，再慢慢梯度测试"): the run's limit is derived, never remembered.
# Without -RunTimeoutMinutes it comes from the latest receipt of the same package and kit (version and kit sha256) under the runs
# directory, read from its stage timeline:
#   none                                          -> LadderFirstMinutes (10)
#   it passed (conclusion not FAIL, no failure)   -> the same limit again, never longer
#   it stopped on a no-progress gate              -> refused: DRILL_LADDER_PREVIOUS_NO_PROGRESS, the stage it was stuck in
#   a stage in its timeline failed                -> refused: DRILL_LADDER_PREVIOUS_STAGE_FAILED, the stage and its code (fix first)
#   it ran out of its time (DRILL_RUN_TIMEOUT, whoever reported it: the foreground's own stop or the host guard's deadline) with no
#   stage failed and every stage in a known state -- wherever the time ran out: in a stage, between two, after the entry (A7, A8), on a
#   kit whose entry wrote only stage logs                                          (fix round 1 of 87d330d0, review high 1)
#                                                 -> twice its limit, at most the run's own ceiling (the intake budget less the wait
#                                                    and the margin: Invoke-DrillWithHostHold refuses more)
#   any other end (a guard abort, a step's own timeout ...) -> the same limit again, never longer
# except that a run already at the ceiling which ran out of its time (DRILL_RUN_TIMEOUT, either clock) is not run again: the next rung
# would be the same limit and the same end (generation 16, 2026.11.24-74bc5ef0: 70 minutes, out of time in the launcher, and the next
# rung 70 minutes again) -> refused: DRILL_LADDER_CEILING_EXHAUSTED, the stage it stopped in (task 87d330d0 PR-2, plan section 4.2)
# The same limit again is held to the ceiling as well. The newest run directory of this version decides: a receipt.json there that cannot
# be read, or has no version or kit, refuses (DRILL_LADDER_PREVIOUS_RECEIPT_UNREADABLE, its path; review medium 4) -- never an older one.
# The limit, the receipt it was derived from and how far that run got are written into this run's receipt (ladder).
function Get-DrillLadderCeilingMinutes { [int]($script:Drill.IntakeMaxMinutes - $script:Drill.IntakeWaitMinutes - $script:Drill.IntakeMarginMinutes) }

# The latest receipt of this version and kit; $null when none. Run directories are named <UTC start>-<version>-<id>
# (Invoke-DrillPreparedRun), so newest first by name, and only this version's: a directory without receipt.json (a run that stopped before
# it had one) is passed over; one that cannot be read, or carries no version or kit, refuses -- it may be the newest of this kit.
function Find-DrillLadderReceipt([string]$RunsDir, [string]$Version, [string]$KitSha256) {
  if (-not (Test-Path -LiteralPath $RunsDir -PathType Container)) { return $null }
  $ours = '^\d{8}T\d{6}Z-' + [regex]::Escape($Version) + '-[0-9a-z]+$'
  foreach ($dir in @(Get-ChildItem -LiteralPath $RunsDir -Directory | Where-Object { $_.Name -cmatch $ours } | Sort-Object Name -Descending)) {
    $file = Join-Path $dir.FullName 'receipt.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    $r = $null; $why = $null
    try { $r = Read-DrillJson $file } catch { $why = [string]$_.Exception.Message }
    if ($null -eq $r -and $null -eq $why) { $why = 'empty' }
    if ($null -eq $why -and (-not [string](Get-DrillField $r 'version') -or -not [string](Get-DrillField $r 'kitSha256'))) { $why = 'no version or kitSha256' }
    if ($null -ne $why) { throw (New-DrillError 'DRILL_LADDER_PREVIOUS_RECEIPT_UNREADABLE' ([ordered]@{ receipt = $file; reason = $why })) }
    if ([string](Get-DrillField $r 'version') -ceq $Version -and [string](Get-DrillField $r 'kitSha256') -ceq $KitSha256) { return @{ path = $file; receipt = $r } }
  }
  return $null
}
# The stage results a timeline is written with (Get-DrillStageTimeline); a receipt with any other is not lengthened from.
$script:DrillLadderKnownResults = @('ok', 'aborted-in-progress', 'left', 'ended', 'recorded', 'skipped')

function Get-DrillLadderStep([string]$RunsDir, [string]$Version, [string]$KitSha256) {
  $ceiling = Get-DrillLadderCeilingMinutes
  $found = Find-DrillLadderReceipt $RunsDir $Version $KitSha256
  if ($null -eq $found) { return [ordered]@{ minutes = [int]$script:Drill.LadderFirstMinutes; rule = 'first'; basis = $null; previousMinutes = $null; reached = $null; ceiling = $ceiling } }
  $r = $found.receipt
  $timeline = Get-DrillField (Get-DrillField $r 'evidence') 'stageTimeline'
  $stages = @(Get-DrillField $timeline 'stages' | Where-Object { $null -ne $_ })
  $last = if ($stages.Count) { $stages[$stages.Count - 1] } else { $null }
  $reached = if ($last) { [ordered]@{ n = (Get-DrillField $last 'n'); stage = (Get-DrillField $last 'stage'); result = (Get-DrillField $last 'result') } } else { $null }
  $previous = Get-DrillField $r 'runTimeoutMinutes'
  if ($null -eq $previous) { $previous = Get-DrillField (Get-DrillField $r 'ladder') 'minutes' }
  if ($null -eq $previous) { $previous = [int]$script:Drill.LadderFirstMinutes }   # a receipt from before the ladder: counted as the first rung
  $previous = [int]$previous
  $step = { param($minutes, $rule) [ordered]@{ minutes = [int]$minutes; rule = $rule; basis = $found.path; previousMinutes = $previous; reached = $reached; ceiling = $ceiling } }
  $failure = Get-DrillField $r 'failure'
  $code = [string](Get-DrillField $failure 'code')
  if ($null -eq $failure -and [string](Get-DrillField $r 'conclusion') -cne 'FAIL') { return (& $step ([Math]::Min($previous, $ceiling)) 'passed-not-longer') }
  if ($code -ceq 'DRILL_GUEST_NO_PROGRESS') {
    throw (New-DrillError 'DRILL_LADDER_PREVIOUS_NO_PROGRESS' ([ordered]@{ stage = (Get-DrillField (Get-DrillField $failure 'detail') 'stage'); reason = (Get-DrillField (Get-DrillField $failure 'detail') 'reason'); receipt = $found.path }))
  }
  $failed = @($stages | Where-Object { [string](Get-DrillField $_ 'result') -ceq 'failed' }) | Select-Object -First 1
  if ($failed) { throw (New-DrillError 'DRILL_LADDER_PREVIOUS_STAGE_FAILED' ([ordered]@{ stage = (Get-DrillField $failed 'stage'); code = (Get-DrillField $failed 'code'); receipt = $found.path })) }
  # out of time at the ceiling (an earlier limit given past it by hand included): the next rung could only be the same run again
  if ($code -ceq 'DRILL_RUN_TIMEOUT' -and $previous -ge $ceiling) {
    $stoppedIn = [string](Get-DrillField $timeline 'abortedIn')
    if (-not $stoppedIn -and $reached) { $stoppedIn = [string]$reached.stage }
    throw (New-DrillError 'DRILL_LADDER_CEILING_EXHAUSTED' ([ordered]@{ stage = $(if ($stoppedIn) { $stoppedIn } else { $null }); reached = $reached
      previousMinutes = $previous; ceiling = $ceiling; receipt = $found.path }))
  }
  # out of time, by either clock (the guard's failure replaces the foreground's: Invoke-DrillOnCheckpoint), nothing failed, nothing unknown
  $known = @($stages | Where-Object { $script:DrillLadderKnownResults -cnotcontains [string](Get-DrillField $_ 'result') }).Count -eq 0
  if ($code -ceq 'DRILL_RUN_TIMEOUT' -and $known) {
    return (& $step ([Math]::Min($previous * 2, $ceiling)) $(if ($previous * 2 -ge $ceiling) { 'doubled-at-ceiling' } else { 'doubled' }))
  }
  return (& $step ([Math]::Min($previous, $ceiling)) 'not-longer')
}

# -ServerKey <key>: the test project's public key, as DESK read it from the project (it is in no repository file:
# FABLE-drill-test-project-sync-20261124.md section 3). The one checker (drill-server-check.mjs --store-key) holds its shape, asks the
# project with it and stores it on the host only when the project answers; make-drill-kit.mjs reads that copy.
function Save-DrillServerKey([string]$Key) {
  $tool = Join-Path (Split-Path -Parent $script:DrillScriptPath) 'drill-server-check.mjs'
  $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  if ($Key -cnotmatch '^[A-Za-z0-9_-]{1,200}$') { throw (New-DrillError 'DRILL_SERVER_KEY_REFUSED' 'not a public key') }
  $arguments = @($tool, '--store-key', $Key)
  if ($script:Drill.ServerKeyFile) { $arguments += @('--key-file', [string]$script:Drill.ServerKeyFile) }
  $run = Invoke-DrillNode $node $arguments 90
  $stored = $null
  if ($run.exit -eq 0) { try { $stored = $run.stdout | ConvertFrom-Json } catch { $stored = $null } }
  if ($null -eq $stored) { throw (New-DrillServerError $run 'DRILL_SERVER_KEY_REFUSED') }
  return [ordered]@{ status = [string]$stored.status; project = [string]$stored.project; file = [string]$stored.file }
}

# The code a server tool ended on (its first stderr line that is one: DRILL_X or DRILL_X:detail), as this script's error.
function New-DrillServerError($Run, [string]$Otherwise) {
  $code = [string](@(([string]$Run.stderr) -split "`r?`n" | Where-Object { $_ -cmatch '^DRILL_[A-Z0-9_]+' }) | Select-Object -First 1)
  if ($code -cmatch '^(DRILL_[A-Z0-9_]+)(?::(.*))?$') { return (New-DrillError $Matches[1] $Matches[2]) }
  return (New-DrillError $Otherwise ([string]$Run.stderr))
}

function Invoke-DrillMain {
  if ($Rebuild -and -not $SyncServer) { throw (New-DrillError 'DRILL_USAGE' '-Rebuild goes with -SyncServer only') }
  if ($ServerKey) {
    if ($Version -or $From -or $Kit -or $BaselineOnly -or $PrereqOnly -or $Finalize -or $Interactive -or $BindingCredential -or $ServerDatabaseCredential -or $SyncServer) { throw (New-DrillError 'DRILL_USAGE' '-ServerKey is given alone') }
    return (Save-DrillServerKey $ServerKey)
  }
  if ($BindingCredential) {
    if ($Version -or $From -or $Kit -or $BaselineOnly -or $PrereqOnly -or $Finalize -or $Interactive -or $ServerDatabaseCredential -or $SyncServer) { throw (New-DrillError 'DRILL_USAGE' '-BindingCredential is given alone') }
    return (Save-DrillBindingCredential)
  }
  if ($ServerDatabaseCredential) {
    if ($Version -or $From -or $Kit -or $BaselineOnly -or $PrereqOnly -or $Finalize -or $Interactive -or $SyncServer) { throw (New-DrillError 'DRILL_USAGE' '-ServerDatabaseCredential is given alone') }
    return (Save-DrillServerDatabaseCredential)
  }
  # -SyncServer [-Rebuild] -From <Release dir> -Version <v>: the sync a drill runs before its boot, on its own (the first rebuild, a
  # rebuild after DRILL_SERVER_DIVERGED, or a check). The Release gives the scope the fixtures follow; no VM, no host hold.
  if ($SyncServer) {
    if ($Kit -or $BaselineOnly -or $PrereqOnly -or $Finalize -or $Interactive) { throw (New-DrillError 'DRILL_USAGE' '-SyncServer takes -From, -Version and -Rebuild only') }
    if (-not $From -or -not $Version) { throw (New-DrillError 'DRILL_USAGE' 'give -SyncServer -From <Release dir> -Version <v>') }
    if (-not (Test-Path -LiteralPath (Join-Path $From "fleet-node-$Version.first-install-kit.json") -PathType Leaf)) { throw (New-DrillError 'DRILL_USAGE' "no fleet-node-$Version.first-install-kit.json in -From") }
    $synced = Sync-DrillServer $From $Version -Rebuild:$Rebuild
    $out = [ordered]@{ status = 'DRILL_SERVER_SYNCED'; rebuilt = [bool]$Rebuild }
    foreach ($k in $synced.Keys) { $out[$k] = $synced[$k] }
    return $out
  }
  if ($Interactive -and ($BaselineOnly -or $PrereqOnly -or $Finalize)) { throw (New-DrillError 'DRILL_USAGE' '-Interactive is a full first-install run only') }
  # Fable renew-key ruling, supplements "interactive mode A1" and "branch two, two points" 2: A1's step record has one parser
  # (Read-DrillFirstInstallSteps); its source depends on the mode. In interactive mode the operator's window does not hold it: bootstrap.ps1
  # runs the host preparation and the launcher as elevated stages in their own window (Invoke-Elevated, Start-Process -Verb RunAs), their
  # output goes to the package's two stage output files (elevated-host-*.txt, elevated-launcher-*.txt) and only their verdict comes back.
  # Those two files are the source to connect (drill branch three); until then refused here, before anything is read, booted or held.
  if ($Interactive) { throw (New-DrillError 'DRILL_INTERACTIVE_STEP_RECORD_NOT_CONNECTED' 'the step record of an interactive first install has no source yet (逐步记录来源尚未接上)') }
  if ($Finalize) {
    if (-not $ProductionReadback) { throw (New-DrillError 'DRILL_USAGE' '-Finalize needs -ProductionReadback') }
    $receipt = Read-DrillJson $Finalize
    if ([string](Get-Prop $receipt 'contract') -cne $script:Drill.ReceiptContract) { throw (New-DrillError 'DRILL_RECEIPT_REFUSED') }
    $restored = Get-Prop $receipt 'restoredToCheckpoint'
    if ((Get-Prop $receipt 'failure') -or $restored -isnot [bool] -or -not $restored -or (Get-Prop $receipt 'conclusion') -ceq 'FAIL') {
      throw (New-DrillError 'DRILL_RECEIPT_NOT_FINALIZABLE' 'receipt failed or checkpoint restore was not confirmed')
    }
    $prod = Get-DrillProductionVerdict $receipt (Read-DrillJson $ProductionReadback)
    # every item but the ones the read-back judges stays as the run wrote it (A1 keeps its firstInstallSteps)
    $items = @($receipt.items | ForEach-Object { $i = $_; $p = @($prod | Where-Object { $_.id -eq $i.id }); if ($p.Count) { $p[0] } else { $i } })
    $receipt.items = $items
    $receipt.conclusion = Get-DrillConclusion $items (Get-Prop $receipt 'm5') ((Get-Prop $receipt 'candidate') -eq $true)
    $receipt | Add-Member -NotePropertyName finalizedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
    $receipt | Add-Member -NotePropertyName productionReadbackSha256 -NotePropertyValue (Get-Sha256Hex $ProductionReadback) -Force
    Write-DrillJson $Finalize $receipt
    $summary = Get-DrillRunSummary $receipt
    return [ordered]@{ status = 'DRILL_FINALIZED'; conclusion = $receipt.conclusion; failedItems = $summary.failedItems; reason = $summary.reason; receipt = $Finalize }
  }

  $full = -not $BaselineOnly -and -not $PrereqOnly
  if ($full -and (-not $Version -or -not $From -or -not $Kit)) { throw (New-DrillError 'DRILL_USAGE' 'give -Version, -From and -Kit (or -BaselineOnly / -PrereqOnly / -Finalize)') }
  $package = $null; $kitInfo = $null; $prereq = $null
  if (-not $BaselineOnly) { $prereq = Read-DrillPrereq $script:Drill.PrereqDir }
  if ($full) {
    $kitInfo = Read-DrillKit $Kit; $package = Test-DrillPackageDir $From $Version $kitInfo
    if ($Interactive -and $kitInfo.prerequisiteMode -cne 'first-install-host') { throw (New-DrillError 'DRILL_INTERACTIVE_REQUIRES_RELEASE_KIT') }
    if ($kitInfo.prereqSha256 -cne $prereq.sha256) { throw (New-DrillError 'DRILL_KIT_PREREQ_NOT_THESE' @{ kit = $kitInfo.prereqSha256; prereq = $prereq.sha256 }) }
    $package.files = @(Get-DrillReleaseFiles $package $kitInfo)
    if ($kitInfo.executionBlocker) { throw (New-DrillError 'DRILL_FIRST_INSTALL_ENTRY_NOT_READY' $kitInfo.executionBlocker) }
    # the drill's server (never production) and the Owner's drill binding, before the host gate, the hold or any boot
    Assert-DrillServerReady $kitInfo $package
    # the package's credential names against the drill's decisions, before the host gate, the hold or any boot; the kit's names first bound
    # again to the package's verified tar
    Assert-DrillKitCredentialsBound $kitInfo (Get-Prop $package 'tar')
    Assert-DrillKitToolsBound $kitInfo (Join-Path $From "fleet-node-$Version.prereq-manifest.json")
    $kitInfo['credentialPlan'] = Get-DrillCredentialPlan $kitInfo
    # ladder mode: the limit from the latest receipt of this version and kit, before the host hold is asked for it
    if ($Ladder -and -not $script:DrillRunTimeoutGiven) {
      $script:DrillLadder = Get-DrillLadderStep $script:Drill.Runs $Version ([string]$kitInfo.sha256)
      $script:RunTimeoutMinutes = [int]$script:DrillLadder.minutes
    }
  }
  Invoke-DrillWithHostHold $RunTimeoutMinutes {
    param($window)
    Invoke-DrillPreparedRun $window $package $kitInfo $prereq
  } -StandbyOnly:$BaselineOnly -BootWait:(-not $BaselineOnly)
}

function Invoke-DrillPreparedRun($Window, $Package, $KitInfo, $Prereq) {
  $script:DrillPreBoot = $null
  [void](Assert-DrillHost -HoldUntil $Window.holdUntil)
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  $label = if ($Version) { $Version } elseif ($PrereqOnly) { 'prereq' } else { 'baseline' }
  $runDir = Join-Path $script:Drill.Runs "$stamp-$label-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null

  try { $baseline = Invoke-DrillBaseline $runDir -ExistingOnly:($Window.holdUntil -ne [DateTimeOffset]::MinValue) }
  catch {
    # a failed baseline keeps what was sampled before its boot -- the three stages (Codex review of f734afe7e, medium 3); the failure that
    # goes on says whether that record was saved, and a record that could not be written is reported on stderr (round four, low 1)
    $failed = Get-DrillCode $_
    $file = Join-Path $runDir 'baseline.json'
    $saveError = $null
    try { Write-DrillJson $file ([ordered]@{ action = 'failed'; failure = $failed; hostPreBoot = $script:DrillPreBoot }) }
    catch { $saveError = [string]$_.Exception.Message; [Console]::Error.WriteLine("drill: baseline.json not written ($file): $saveError") }
    $savedTo = $null
    if ($null -eq $saveError) { $savedTo = $file }
    throw (New-DrillError $failed.code ([ordered]@{ failure = $failed.detail; baselineSaved = ($null -eq $saveError); baselineEvidence = $savedTo; baselineSaveError = $saveError }))
  }
  if ($baseline -is [Collections.IDictionary]) { $baseline.hostPreBoot = $script:DrillPreBoot }   # a built baseline's three stages
  if ($BaselineOnly) {
    Write-DrillJson (Join-Path $runDir 'baseline.json') $baseline
    return [ordered]@{ status = 'DRILL_BASELINE_READY'; action = $baseline.action; checkpoint = $baseline.checkpoint; hostFreeGB = (Get-Prop $script:DrillPreBoot 'bootGate.freeGB'); evidence = (Join-Path $runDir 'baseline.json') }
  }
  if ($Window.deadline -eq [DateTimeOffset]::MinValue) { $Window.deadline = (Get-DrillTime).AddMinutes($RunTimeoutMinutes) }
  if ($PrereqOnly) {
    # The prerequisites alone, on a fresh copy of the baseline, then restored: WSL2 under nested virtualization, systemd, docker.
    $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillPrereqInGuest $runDir $prereq $cred } $runDir $Window
    $out = [ordered]@{ status = $(if ($o.failure) { 'DRILL_PREREQ_FAILED' } else { 'DRILL_PREREQ_READY' }); code = $(if ($o.failure) { $o.failure.code } else { $null });
      detail = $(if ($o.failure) { $o.failure.detail } else { $null }); restored = $o.restored; prereqSha256 = $prereq.sha256;
      evidence = (Join-Path $runDir 'prereq-facts.json'); hostExecutorStates = $o.hostExecutorStates; hostPreBoot = (Get-Prop $o 'preBoot') }
    Write-DrillJson (Join-Path $runDir 'prereq-run.json') $out
    return $out
  }

  # M5 is collected for every package (Fable ruling 11-19 section 2.2); until the run reads it, it is not evaluated, which fails the receipt
  $m5 = @{ result = 'NOT_EVALUATED'; detail = 'DRILL_M5_RUN_INCOMPLETE' }
  $startedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  $o = Invoke-DrillOnCheckpoint { param($cred) Invoke-DrillRun $runDir $Package $KitInfo $Prereq $cred $Window.deadline } $runDir $Window
  $run = $o.result; $failure = $o.failure; $restored = $o.restored

  $evidence = [ordered]@{ localSource = $null; hostExecutorStates = $o.hostExecutorStates; hostPreBoot = (Get-Prop $o 'preBoot') }
  $items = @()
  # The first install's step record, read first from what the run directory holds whatever the run's end: A1 needs it (Get-DrillVerdict;
  # branch one's rule and this branch's: present, not missing, not incomplete), and it is kept under A1, or in the evidence when the run
  # ended before there was a verdict.
  $firstInstallSteps = Read-DrillFirstInstallSteps $runDir
  $failureSnapshot = Read-DrillFailureSnapshot $runDir   # the entry's, when the first install did not end done
  $evidence.reinstallUpgrade = Read-DrillReinstallUpgradeEvidence $runDir
  $guestEvidence = Join-Path $runDir 'guest-evidence.json'
  if (Test-Path -LiteralPath $guestEvidence -PathType Leaf) { try { $evidence.guestEvidence = Read-DrillJson $guestEvidence } catch { $evidence.guestEvidence = @{ unreadable = $true } } }
  # 甲1 and 明盒: the first install's last progress tick and the stage timeline, whatever the end
  $guestProgress = Join-Path $runDir 'guest-progress.json'
  if (Test-Path -LiteralPath $guestProgress -PathType Leaf) { $evidence.guestProgress = try { Read-DrillJson $guestProgress } catch { @{ unreadable = $true } } }
  $evidence.stageTimeline = try { Get-DrillStageTimeline $runDir } catch { [ordered]@{ unreadable = [string]$_.Exception.Message } }
  if ($run) {
    $evidence.localSource = [string](Get-Prop $run.first.current 'ciSourceManifestSha256')
    $evidence.stageTimingsSeconds = $run.timings
    $items = Get-DrillVerdict @{ now = [DateTimeOffset]::Parse($run.first.readAt); entry = $run.entry; launcher = $run.launcher; pause = $run.first.pause; verify = $run.first.verify; status = $run.first.status; current = $run.first.current; facts = $run.first.facts; acceptanceSource = $package.ciSourceManifestSha256; reboot = $run.reboot; reinstall = (Get-Prop $run 'reinstall'); skipReinstall = [bool]$SkipReinstall; kit = $kitInfo; candidate = [bool]$package['candidate']; firstInstallSteps = $firstInstallSteps; failureSnapshot = $failureSnapshot }
  }
  # the run stopped after the first install gave its result: A1 from that result alone (the other items are missing, so the receipt fails)
  $entryResultFile = Join-Path $runDir 'entry-result.json'
  if (-not $run -and (Test-Path -LiteralPath $entryResultFile -PathType Leaf)) {
    $items = @(Get-DrillA1Item $(try { Read-DrillJson $entryResultFile } catch { $null }) $firstInstallSteps $failureSnapshot)
  }
  $a1Item = @($items | Where-Object { $_.id -eq 'A1' }) | Select-Object -First 1
  if ($a1Item) { $a1Item.firstInstallSteps = $firstInstallSteps } else { $evidence.firstInstallSteps = $firstInstallSteps }
  $evidence.hostMemory = Get-DrillHostMemoryEvidence (Get-Prop $o 'preBoot') (Get-Prop $o 'runningMemory')
  # An emergency restore may come before the evidence was taken (Fable renew-key ruling, supplement "interactive mode A1", second point):
  # accepted, and written as it ended (Codex review of 1cedea9ef, medium 4) -- the host guard's, and the boot watchdog's record.
  $guardOutcome = Get-DrillGuardOutcome $runDir
  if ($guardOutcome) { $evidence.guardEmergencyRestore = $guardOutcome }
  $watchdogFile = Join-Path $runDir 'guest-shutdown.outcome.json'
  if (Test-Path -LiteralPath $watchdogFile -PathType Leaf) { $evidence.watchdogRestore = try { Read-DrillJson $watchdogFile } catch { [ordered]@{ unreadable = $true } } }
  $files = @(Get-ChildItem -LiteralPath $runDir -File | Where-Object { $_.Name -ne 'receipt.json' } | ForEach-Object { [ordered]@{ name = $_.Name; sha256 = (Get-Sha256Hex $_.FullName) } })
  try {
    if ($run) { $m5 = Get-DrillM5Verdict $runDir $run.m5 }
    $m5Dir = Join-Path $runDir 'm5'
    if (Test-Path -LiteralPath $m5Dir -PathType Container) {
      $files += @(Get-ChildItem -LiteralPath $m5Dir -File | ForEach-Object { [ordered]@{ name = "m5/$($_.Name)"; sha256 = (Get-Sha256Hex $_.FullName) } })
    }
  } catch {
    $m5.result = 'FAIL'
    $m5.detail = 'DRILL_M5_EVIDENCE_UNREADABLE'
  }
  $receipt = [ordered]@{
    contract = $script:Drill.ReceiptContract
    machine = 'Hyper-V VM on DESK (drill machine, not a node; phase A)'
    entryMode = $(if ($Interactive) { 'interactive-original-bootstrap' } else { 'adapted-unattended' })
    bootstrapException = $(if ($Interactive) { $null } else { 'README section 5: drill VM only exception to do not bypass bootstrap to run prepare; non-elevated check, RunAs and credential dialogs bypassed' })
    version = $package.version; tarSha256 = $package.tarSha256; ciSourceManifestSha256 = $package.ciSourceManifestSha256
    # the three hashes an acceptance names; candidate: the drill ran before the Owner's acceptance, on the kit's drill-only acceptance
    firstInstallKitSha256 = $package['firstInstallKitSha256']; candidate = [bool]$package['candidate']
    # the server the guest installed against (never production) and the first-install kit it read: the Release's with the two fields replaced
    server = $(if ($null -ne (Get-Prop $kitInfo 'server')) { [ordered]@{ project = $kitInfo.server.project; supabaseUrl = $kitInfo.server.supabaseUrl; replaced = @($kitInfo.server.replaced)
        drillFirstInstallKitSha256 = $kitInfo.server.firstInstallKitSha256; blackholeHosts = @($kitInfo.server.blackholeHosts)
        # the test project's sync receipt read before the boot: which production state this drill's server stood in for
        sync = $kitInfo.server['sync'] } } else { $null })
    kitSha256 = $kitInfo.sha256; prereqSha256 = $prereq.sha256; baseline = [ordered]@{ checkpoint = $script:Drill.Checkpoint; build = $baseline }
    startedAt = $startedAt; endedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'); hostFreeGBAtStart = (Get-Prop (Get-Prop $o 'preBoot') 'bootGate.freeGB')
    failure = $failure; restoredToCheckpoint = $restored
    # this run's limit, and in ladder mode the step it was derived from (the receipt, how far that run got, the rule)
    runTimeoutMinutes = $RunTimeoutMinutes; ladder = $script:DrillLadder
    evidence = $evidence; files = $files; items = $items; m5 = $m5
    conclusion = $(if ($failure -or -not $restored) { 'FAIL' } else { Get-DrillConclusion $items $m5 ([bool]$package['candidate']) })
    # the package's credential names as given or withheld by design (the optional ones not given this run, with why)
    credentials = $(try { Get-DrillCredentialPlan $kitInfo } catch { $null })
    productionReadbackSql = (Get-DrillReadbackSql $startedAt)
  }
  $receiptPath = Join-Path $runDir 'receipt.json'
  Write-DrillJson $receiptPath $receipt
  $summary = Get-DrillRunSummary $receipt
  return [ordered]@{ status = 'DRILL_DONE'; conclusion = $receipt.conclusion; code = $(if ($failure) { $failure.code } elseif (-not $restored) { 'DRILL_RESTORE_NOT_CONFIRMED' } else { $null }); failedItems = $summary.failedItems; reason = $summary.reason; restored = $restored; receipt = $receiptPath }
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by the offline tests: definitions only
# The one output line is UTF-8 whatever the console code page (a Chinese Windows defaults to GBK, which garbled the guest's
# localized messages in the first baseline run's detail).
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }
$WarningPreference = 'SilentlyContinue'   # one JSON line on stdout: warnings relayed from the guest would break it
try {
  $result = Invoke-DrillMain
  Write-Output (ConvertTo-DrillJson $result)
  exit 0
} catch {
  $c = Get-DrillCode $_
  Write-Output (ConvertTo-DrillJson ([ordered]@{ status = 'DRILL_STOPPED'; code = $c.code; detail = $c.detail }))
  exit 1
}
