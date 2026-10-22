<#
.SYNOPSIS
  One-time Owner install of the resident independent-CI executor (DRAFT, not yet reviewed).

.DESCRIPTION
  Default mode is a read-only dry run: it inspects the host, builds the complete install plan
  (every directory, ACL, service, scheduled task and pin, plus the exact before-state it expects)
  and prints the plan with its SHA-256. Nothing is written.

  -Apply performs exactly that plan and nothing else. It needs:
    * an elevated token of the Owner's own account (UAC: the one prompt of this install);
    * -ExpectedPlanSha256 equal to the plan computed now (any host or package change since the
      reviewed dry run refuses the install);
    * the runner service Stopped/Manual on its original binary under .\clued-control.

  Package handling (independent review M1): package-manifest.json is read ONCE; its bytes are hashed
  and parsed from that same buffer. Every file is read into memory, hashed, compared with the
  manifest and written from that same buffer with CreateNew, so nothing can change between check and
  use. Every target is validated against a fixed allow-list of relative shapes (no "..", no rooted or
  drive path, no ADS). Run this script only from a copy you verified by hash from the elevated
  prompt itself (the plan prints installScriptSha256); after install, every elevated script
  (verify, re-arm, uninstall) is run from its installed admin-only copy under resident\<sha>\windows\.

  Nothing existing is overwritten, deleted or re-ACLed. The runner service is NOT modified: its
  configuration is changed only by CluedCISwapBroker (LocalSystem), which can switch the binary path
  between the original and an installed, allow-listed helper and nothing else (review M2).
  The Linux half is linux/install-resident-linux.sh, run separately as root.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPackageManifestSha256,
  [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$OwnerSid,
  [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$ControllerSid, # .\clued-control
  [switch]$Apply,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPlanSha256,
  [switch]$StartAfterInstall
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)

$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$ServiceName = 'CluedCIResident'
$BrokerName = 'CluedCISwapBroker'
$RunnerService = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02'
$OriginalBinary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'
$Sc = 'C:\Windows\System32\sc.exe'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$TargetShape = '^(?:(?:resident|source)\\[0-9a-f]{64}(?:\\[A-Za-z0-9_.@-]+)+|(?:config|runtime|bin|helpers|record)\\[A-Za-z0-9_.@-]+)$'
# Source v2 (DESIGN S5, S12): the claim-free install record goes to record\ (admin-only; read by the
# resident's derivation and by the generic helper as clued-control), the CI Source to
# source\<ciSourceManifestSha256>\ (the directory the generic helper loads code from), and the ONE generic
# helper is compiled here from that installed Source and pinned in config\broker.json.
$GenericHelper = 'controller-formal-generic-v2.exe'
$SourceV2Windows = 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'

# ---- Privilege boundary (independent review of PR-A: MAJOR-1, MINOR-2, MINOR-4, MINOR-5) ----
# Required privileges cut the service tokens down to what the code needs; both hosts re-check the real
# token at start and refuse anything else (ResidentServiceHost.cs, SwapBroker.cs). The resident's outbound
# network is blocked by a firewall rule scoped to its service SID (it never needs the network: every GitHub
# read runs in the companion under the Owner's own login). Every sc.exe call is exit-code checked.
$ResidentPrivileges = @('SeChangeNotifyPrivilege')
$BrokerPrivileges = @('SeChangeNotifyPrivilege', 'SeCreateGlobalPrivilege')
$FirewallRuleName = 'CluedCIResident-BlockOutbound'
function Invoke-Sc([string]$failureCode, [string[]]$scArgs) {
  $out = & $Sc @scArgs | Out-String
  if ($LASTEXITCODE -ne 0) { throw ($failureCode + ':' + $LASTEXITCODE) }
  $out
}
# `sc qprivs` -> the sorted privilege names ("PRIVILEGES : SeX" then ": SeY" continuation lines).
function ConvertFrom-ScPrivs([string]$text) {
  $names = @(foreach ($line in ($text -split "`r?`n")) { if ($line -match '^\s*(?:PRIVILEGES\s*)?:\s*(Se[A-Za-z]+Privilege)\s*$') { $Matches[1] } })
  @($names | Sort-Object -CaseSensitive)
}
function Get-PrivilegePlan {
  [ordered]@{ residentPrivileges = $ResidentPrivileges; brokerPrivileges = $BrokerPrivileges
    brokerFailure = 'restart after 60 s, then after 300 s, reset daily, also on non-crash failure'
    firewall = [ordered]@{ name = $FirewallRuleName; direction = 'Outbound'; action = 'Block'; service = $ServiceName; profile = 'Any' } }
}

# The companion task action. The task runs with the Owner's interactive token, so a console program would get
# a console window on the Owner's desktop, and closing that window ends the companion (it did, 2026-10-21). The
# in-box conhost.exe --headless hosts node's console without any window. Ending the task ends conhost, not its
# node child, so uninstall-resident.ps1 stops every process of the installed node copy itself.
function Get-CompanionAction([string]$root, [string]$residentSha, [string]$configSha) {
  [ordered]@{ path = 'C:\Windows\System32\conhost.exe'
    arguments = '--headless "' + (Join-Path $root 'runtime\node.exe') + '" "' + (Join-Path $root ('resident\' + $residentSha + '\src\companion-main.mjs')) + '" --root "' + $root + '" --config-sha256 ' + $configSha }
}

function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Sha256Text([string]$t) { Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($t)) }
function Sha256File([string]$p) { Sha256Bytes ([IO.File]::ReadAllBytes($p)) }

# Virtual service account SID: S-1-5-80 + SHA-1 of the upper-case service name (UTF-16LE).
function Get-ServiceSid([string]$name) {
  $h = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($name.ToUpperInvariant()))
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($h, $_ * 4) }) -join '-')
}

function Assert-Owner {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($id.User.Value -cne $OwnerSid) { throw 'OWNER_ACCOUNT_REQUIRED' }
  if ($env:COMPUTERNAME -cne 'TURING') { throw 'TURING_HOST_REQUIRED' }
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# sc.exe sdshow also prints the SACL ("S:...") when the caller may read it (elevated) and not otherwise;
# every service-descriptor comparison uses the DACL section alone, so both views agree.
function Get-DaclPart([string]$sd) { $t = ([string]$sd).Trim(); $i = $t.IndexOf('D:'); if ($i -lt 0) { return $t }; $t = $t.Substring($i); $j = $t.IndexOf('S:'); if ($j -ge 0) { $t = $t.Substring(0, $j) }; $t }
function Read-RunnerState {
  $qc = & $Sc qc $RunnerService | Out-String
  $q = & $Sc queryex $RunnerService | Out-String
  $bin = if ($qc -match 'BINARY_PATH_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  $acct = if ($qc -match 'SERVICE_START_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  [ordered]@{ binary = $bin; originalBinary = ($bin -ceq $OriginalBinary); account = $acct; accountIsController = ($acct -match '^(\.|TURING)\\clued-control$')
    stoppedPid0 = ($q -match 'STATE\s*:\s*1\s' -and $q -match 'PID\s*:\s*0\b'); manual = ($qc -match 'START_TYPE\s*:\s*3\s'); sddl = (Get-DaclPart (& $Sc sdshow $RunnerService | Out-String)) }
}

# Directory ACLs (owner BUILTIN\Administrators, protected DACL). Masks: 0x1200a9 read+execute,
# 0x1301bf modify, 0x1000a2 add-file+traverse (drop box), FA full. To be validated on a test host.
function Get-AclPlan([string]$res) {
  $base = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
  $rx = '0x1200a9'; $mod = '0x1301bf'; $drop = '0x1000a2'
  [ordered]@{
    # The generic helper (as clued-control) opens every parent of its inputs with READ_CONTROL before it reads
    # them (FormalPublicBoundaryV2.Parents); this folder only, no inheritance, no access to any content.
    ''                  = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)(A;;0x120080;;;$ControllerSid)"
    'bin'               = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'config'            = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'install'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"                 # install records: only admins write
    'owner'             = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"                 # Owner requests: only the elevated Owner (BA) creates
    'source'            = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)(A;OICI;$rx;;;$ControllerSid)"
    'helpers'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$ControllerSid)"           # the installed generic helper (broker config pin)
    'record'            = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$ControllerSid)(A;OICI;$rx;;;$OwnerSid)"   # claim-free install record: only admins write
    'stage'             = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$ControllerSid)"           # sealed per-stage inputs (resident writes, helper reads)
    'bundles'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$mod;;;$OwnerSid)"               # companion bundles (Owner's git credential), read by ws-prep
    'resident'          = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'runtime'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'state'             = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'work'              = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$ControllerSid)(A;OICI;$rx;;;$OwnerSid)"
    'outbox'            = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'broker'            = "$base(A;OICI;$rx;;;$res)"
    # Review MINOR-2: the resident may only add request files (list, add-file, traverse, read), never delete or
    # rename anything here; files are read-only for it, and OWNER RIGHTS (OW) removes the creator's implicit
    # WRITE_DAC, so a request can not be rewritten after the broker may have read it.
    'broker\requests'   = "$base(A;;0x1200a3;;;$res)(A;OIIO;0x120089;;;$res)(A;OIIO;0x120089;;;OW)"
    'broker\responses'  = "$base(A;OICI;$rx;;;$res)"
    # Review MINOR-9: create-only for the Owner. The folder ACE allows adding a file (the creating handle keeps
    # the access it asked for); existing files are read-only for the Owner, and OW removes the owner's implicit
    # WRITE_DAC, so a trigger or request cannot be rewritten after the resident read it.
    'inbox'             = "$base(A;OICI;$mod;;;$res)(A;;$drop;;;$OwnerSid)(A;OIIO;0x120089;;;$OwnerSid)(A;OIIO;0x120089;;;OW)"
    'requests'          = "$base(A;OICI;$mod;;;$res)(A;;$drop;;;$OwnerSid)(A;OIIO;0x120089;;;$OwnerSid)(A;OIIO;0x120089;;;OW)"
    'mailbox'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'mailbox\requests'  = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$OwnerSid)"
    'mailbox\responses' = "$base(A;OICI;$rx;;;$res)(A;OICI;$mod;;;$OwnerSid)"            # responses + companion heartbeat
  }
}

# ---- Carry-forward of the executed heads (resident quota redesign v0.6 + section 9, phase 1, item 7) ----
# uninstall-resident.ps1 renames the whole resident directory to resident-uninstalled-<UTC>-<hex>, so a reinstall starts
# with an empty state. The resident's Source-independent executed heads (src/executed-heads.mjs) must survive that: this
# install copies, from EVERY earlier resident-uninstalled-* state, the ledger-heads records, the ledger records the
# backfill reads and any executed-heads records into state\backfill\<n>\ (read once, hashed, CreateNew), and lists
# each file with its SHA-256 in install\backfill-manifest.json (admin-only). On its first start the resident backfills from
# exactly those files and runs no batch before that is done. Only fixed name shapes are taken; a link anywhere refuses the
# install before anything is written. Nothing in an earlier state is changed.
$CarryParent = Split-Path -Parent $Root
$CarryLedgerRecords = @('00-reserved.json', '10-started.json', '25-plan.json', '80-owner-abort.json', '90-terminal.json')
function Test-NoLink([IO.FileSystemInfo]$item) { if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('CARRY_FORWARD_LINK_REFUSED:' + $item.FullName) } }
function Get-CarryForwardPlan([string]$parent) {
  $sources = @()
  foreach ($dir in @(Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction Stop | Where-Object { $_.Name -cmatch '^resident-uninstalled-[0-9A-Za-z-]{1,80}$' } | Sort-Object Name)) {
    Test-NoLink $dir
    $state = Join-Path $dir.FullName 'state'
    $files = New-Object System.Collections.ArrayList
    $keys = New-Object System.Collections.ArrayList   # executed-heads\<key> directories: the key alone names a head that may have published
    if (Test-Path -LiteralPath $state -PathType Container) {
      Test-NoLink (Get-Item -LiteralPath $state -Force)
      $take = {
        param([string]$rel)
        $item = Get-Item -LiteralPath (Join-Path $state $rel) -Force
        Test-NoLink $item
        # An empty record (a write interrupted before its bytes) is carried as it is; the backfill counts it unreadable.
        if ($item.Length -lt 0 -or $item.Length -gt 4MB) { throw ('CARRY_FORWARD_FILE_SIZE_REFUSED:' + $rel) }
        [void]$files.Add([ordered]@{ rel = $rel.Replace('\', '/'); full = $item.FullName })
      }
      $heads = Join-Path $state 'ledger-heads'
      if (Test-Path -LiteralPath $heads -PathType Container) {
        Test-NoLink (Get-Item -LiteralPath $heads -Force)
        foreach ($f in @(Get-ChildItem -LiteralPath $heads -Force | Sort-Object Name)) { Test-NoLink $f; if (-not $f.PSIsContainer -and $f.Name -cmatch '^[0-9a-f]{64}\.json$') { & $take ('ledger-heads\' + $f.Name) } }
      }
      $ledger = Join-Path $state 'ledger'
      if (Test-Path -LiteralPath $ledger -PathType Container) {
        Test-NoLink (Get-Item -LiteralPath $ledger -Force)
        foreach ($k in @(Get-ChildItem -LiteralPath $ledger -Directory -Force | Where-Object { $_.Name -cmatch '^[0-9a-f]{64}$' } | Sort-Object Name)) {
          Test-NoLink $k
          foreach ($n in $CarryLedgerRecords) { if (Test-Path -LiteralPath (Join-Path $k.FullName $n) -PathType Leaf) { & $take ('ledger\' + $k.Name + '\' + $n) } }
        }
      }
      $executed = Join-Path $state 'executed-heads'
      if (Test-Path -LiteralPath $executed -PathType Container) {
        Test-NoLink (Get-Item -LiteralPath $executed -Force)
        foreach ($k in @(Get-ChildItem -LiteralPath $executed -Directory -Force | Where-Object { $_.Name -cmatch '^[0-9a-f]{32}$' } | Sort-Object Name)) {
          Test-NoLink $k
          [void]$keys.Add($k.Name)
          foreach ($f in @(Get-ChildItem -LiteralPath $k.FullName -Force | Sort-Object Name)) { Test-NoLink $f; if (-not $f.PSIsContainer -and $f.Name -cmatch '^(publication|backfill)-[0-9a-f]{16}\.json$') { & $take ('executed-heads\' + $k.Name + '\' + $f.Name) } }
        }
      }
    }
    if ($files.Count -gt 200000) { throw ('CARRY_FORWARD_TOO_MANY_FILES:' + $dir.Name) }
    $sources += ,([ordered]@{ name = $dir.Name; files = @($files); heads = @($keys) })
  }
  # The resident's backfill reads at most 256 earlier states (src/executed-heads.mjs): refuse here, before anything is
  # written, rather than install a state that HALTs on its first start.
  if ($sources.Count -gt 256) { throw ('CARRY_FORWARD_TOO_MANY_STATES:' + $sources.Count) }
  ,$sources
}
# Copies the planned files (each read once, hashed, written from that same buffer with CreateNew) and returns the
# manifest the resident's backfill reads. Each earlier state goes to state\backfill\<n>\ (n = its place in the list, so
# every path stays short); the manifest names it. The new state\backfill\ inherits the state directory's ACL.
function Copy-CarryForward($sources, [string]$stateRoot) {
  $out = @()
  $index = 0
  foreach ($s in @($sources)) {
    $index += 1
    $listed = New-Object System.Collections.ArrayList
    foreach ($f in @($s.files)) {
      $bytes = [IO.File]::ReadAllBytes($f.full)
      $to = Join-Path (Join-Path (Join-Path $stateRoot 'backfill') ([string]$index)) ($f.rel.Replace('/', '\'))
      [void][IO.Directory]::CreateDirectory((Split-Path -Parent $to))
      $w = [IO.File]::Open($to, 'CreateNew', 'Write', 'None'); try { $w.Write($bytes, 0, $bytes.Length); $w.Flush($true) } finally { $w.Dispose() }
      [void]$listed.Add([ordered]@{ path = $f.rel; sha256 = (Sha256Bytes $bytes); bytes = $bytes.Length })
    }
    $out += ,([ordered]@{ name = $s.name; dir = [string]$index; files = @($listed); heads = @($s.heads) })
  }
  [ordered]@{ contract = 'clued.independent-ci.resident-backfill-manifest/1'; sources = @($out) }
}

$pkgBytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot 'package-manifest.json'))  # read ONCE
function Get-OpenBatchCount {
  $ledger = Join-Path $Root 'state\ledger'
  if (-not (Test-Path -LiteralPath $ledger)) { return 0 }
  return @(Get-ChildItem -LiteralPath $ledger -Directory | Where-Object { -not (Test-Path -LiteralPath (Join-Path $_.FullName '90-terminal.json')) }).Count
}

function Build-Plan {
  $res = Get-ServiceSid $ServiceName
  if ((Sha256Bytes $pkgBytes) -cne $ExpectedPackageManifestSha256) { throw 'REVIEWED_PACKAGE_CHANGED' }
  $pkg = [Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json            # parsed from the hashed bytes
  foreach ($f in $pkg.files) {
    if ($f.target -cnotmatch $TargetShape -or $f.target.Contains('..') -or $f.target.Contains(':')) { throw ('PACKAGE_TARGET_REFUSED:' + $f.target) }
    if ($f.path -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($f.path)) { throw 'PACKAGE_SOURCE_PATH_REFUSED' }
  }
  $find = { param($t) @($pkg.files | Where-Object { $_.target -ceq $t })[0].sha256 }
  if ($pkg.contract -cne 'clued.independent-ci.resident-package/3' -or $pkg.ciSourceManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or (& $find 'record\source-manifest.json') -cne $pkg.ciSourceManifestSha256) { throw 'SOURCE_V2_RECORD_PACKAGE_REQUIRED' }
  [ordered]@{
    contract = 'clued.independent-ci.resident-install-plan/3'
    root = $Root; rootExists = (Test-Path -LiteralPath $Root)
    # PR-A review MAJOR 3: never install over a resident with an open batch (also one that waits for hosted
    # signals); like uninstall-resident.ps1, the Owner re-arms or lets it finish first.
    openBatches = (Get-OpenBatchCount)
    servicesExist = [bool](Get-Service -Name $ServiceName, $BrokerName -ErrorAction SilentlyContinue)
    residentSid = $res; ownerSid = $OwnerSid; controllerSid = $ControllerSid
    installScriptSha256 = (Sha256File $PSCommandPath)
    packageManifestSha256 = $ExpectedPackageManifestSha256
    sourceManifestSha256 = $pkg.sourceManifestSha256; residentManifestSha256 = $pkg.residentManifestSha256
    policySha256 = (& $find 'config\policy.json'); companionConfigSha256 = (& $find 'config\companion.json')
    nodeSha256 = (& $find 'runtime\node.exe')
    ciSourceManifestSha256 = $pkg.ciSourceManifestSha256; bridgeManifestSha256 = $pkg.bridgeManifestSha256
    recordSourceManifestSha256 = (& $find 'record\source-manifest.json'); genericHelper = $GenericHelper
    files = @($pkg.files).Count
    acl = Get-AclPlan $res
    runnerBefore = Read-RunnerState
    runnerModified = $false
    services = [ordered]@{
      resident = [ordered]@{ name = $ServiceName; account = "NT SERVICE\$ServiceName"; start = 'delayed-auto'; sidType = 'unrestricted'; failure = 'restart once per day after 60 s, also on non-crash failure'; sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)' }
      broker = [ordered]@{ name = $BrokerName; account = 'LocalSystem'; start = 'auto'; sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)' }
    }
    companionTask = [ordered]@{ path = '\Clued\'; name = 'CluedCIResidentCompanion'; principal = $OwnerSid; runLevel = 'LeastPrivilege'; trigger = 'AtLogOn'; sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$OwnerSid)"
      action = (Get-CompanionAction $Root $pkg.residentManifestSha256 (& $find 'config\companion.json')) }
    startAfterInstall = [bool]$StartAfterInstall
    privilegeBoundary = Get-PrivilegePlan
    # The earlier states are only known after the uninstall renamed the current one, so the plan names the rule, and the
    # install receipt and install\backfill-manifest.json name the files.
    carryForward = 'every resident-uninstalled-* state under the parent directory: ledger-heads, ledger records 00/10/25/80/90, executed-heads -> state\backfill\<n>\, listed with SHA-256 in install\backfill-manifest.json'
    deletesAnything = $false
  }
}

# Each directory is CREATED with its final security descriptor (no window in which it carries the
# parent's inherited ACL), then read back.
function New-DirectoryWithAcl([string]$path, [string]$sddl) {
  if (Test-Path -LiteralPath $path) { throw ('DIRECTORY_EXISTS:' + $path) }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm($sddl)
  $null = [IO.Directory]::CreateDirectory($path, $acl)
  # Windows returns the descriptor in canonical form (the explicit ACEs reordered), so the read-back is
  # compared with the canonical form of the planned descriptor, never with the plan string itself.
  $back = (Get-Acl -LiteralPath $path).Sddl
  if ($back -cne $acl.GetSecurityDescriptorSddlForm('All')) { throw ('ACL_READBACK_MISMATCH:' + $path) }
}

# The SCM's stored image path must be exactly the planned command line (quotes included).
function Assert-ServiceBinary([string]$name, [string]$want) {
  $qc = Invoke-Sc 'SERVICE_QC_FAILED' @('qc', $name, '8192')
  $have = if ($qc -match 'BINARY_PATH_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  if ($have -cne $want) { throw ('SERVICE_BINARY_PATH_READBACK_MISMATCH:' + $name) }
}

function Write-New([string]$path, [byte[]]$bytes) {
  $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}

$elevated = Assert-Owner
$plan = Build-Plan
$planSha = Sha256Text ($plan | ConvertTo-Json -Depth 8)
if (-not $Apply) {
  # Not part of the plan (the state being replaced is renamed only by the uninstall that runs after this dry run): what
  # would be carried forward if the install ran now, or why it would be refused.
  # Get-CarryForwardPlan returns its list as ONE pipeline object (,$sources): assigned first, then walked with foreach.
  $preview = try { $all = Get-CarryForwardPlan $CarryParent; $p = @(); foreach ($s in $all) { $p += ,([ordered]@{ name = $s.name; files = @($s.files).Count }) }; ,$p } catch { $_.Exception.Message }
  [ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = $planSha; plan = $plan; carryForwardPreview = $preview } | ConvertTo-Json -Depth 10; exit 0
}

if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
if ($ExpectedPlanSha256 -cne $planSha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
if ($plan.openBatches -ne 0) { throw 'INSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST' }
if ($plan.rootExists -or $plan.servicesExist) { throw 'FRESH_INSTALL_REQUIRED_USE_UPGRADE_PATH' }
$r = $plan.runnerBefore
if (-not ($r.originalBinary -and $r.stoppedPid0 -and $r.manual -and $r.accountIsController)) { throw 'RUNNER_SERVICE_NOT_ORIGINAL_STOPPED_MANUAL_CONTROLLER' }
# Before anything is written: every earlier state to carry, every file shape, no link anywhere.
$carry = Get-CarryForwardPlan $CarryParent

$receipt = [ordered]@{ contract = 'clued.independent-ci.resident-install-receipt/2'; planSha256 = $planSha; sourceManifestSha256 = $plan.sourceManifestSha256; residentManifestSha256 = $plan.residentManifestSha256; runnerSddlUnchanged = $r.sddl; steps = @(); startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
function Step([string]$name, [scriptblock]$body) { & $body; $script:receipt.steps += $name }

# 1. Directories, created new with their final ACLs.
Step 'directories' {
  foreach ($rel in $plan.acl.Keys) { New-DirectoryWithAcl $(if ($rel) { Join-Path $Root $rel } else { $Root }) $plan.acl[$rel] }
}
# 1b. Carry the earlier states' executed heads forward (the resident backfills from them before its first batch).
Step 'carry-forward' {
  $manifest = Copy-CarryForward $carry (Join-Path $Root 'state')
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((ConvertTo-Json -InputObject $manifest -Depth 6 -Compress))
  Write-New (Join-Path $Root 'install\backfill-manifest.json') $bytes
  $script:receipt.backfillManifestSha256 = Sha256Bytes $bytes
  $script:receipt.carriedSources = @($manifest.sources | ForEach-Object { [ordered]@{ name = $_.name; files = @($_.files).Count; empty = @($_.files | Where-Object { $_.bytes -eq 0 }).Count } })
}
# 2. Package files: read once, hash, compare, write those same bytes (CreateNew).
Step 'package-copy' {
  $pkg = [Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json
  foreach ($f in $pkg.files) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot $f.path))
    if ((Sha256Bytes $bytes) -cne $f.sha256) { throw ('PACKAGE_FILE_CHANGED:' + $f.path) }
    $to = Join-Path $Root $f.target
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Write-New $to $bytes
  }
}
# 3. Compile the two service hosts and the ONE generic helper once with the in-box compiler and pin them.
#    The broker and the helper include the installed Source v2 C# files (S1, S2, S12), never a copy
#    from the package directory.
Step 'service-hosts' {
  # csc runs from the admin-only bin directory with full reference paths, so nothing is resolved
  # from the caller's current directory (review M1).
  $fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
  $v2 = Join-Path $Root ('source\' + $plan.ciSourceManifestSha256 + '\' + $SourceV2Windows)
  Push-Location (Join-Path $Root 'bin')
  try {
  foreach ($pair in @(@('ResidentServiceHost', @("/reference:$($fw)System.dll", "/reference:$($fw)System.ServiceProcess.dll"), @()),
                      @('SwapBroker', @("/reference:$($fw)System.dll", "/reference:$($fw)System.Core.dll", "/reference:$($fw)System.ServiceProcess.dll", "/reference:$($fw)System.Web.Extensions.dll"),
                        @((Join-Path $v2 'ResidentScmV2.cs'), (Join-Path $v2 'ScmPidHandshakeV2.cs'))))) {
    $exe = Join-Path $Root ('bin\' + $pair[0] + '.exe')
    & $Csc /nologo /noconfig /target:exe /optimize+ ("/out:" + $exe) $pair[1] (Join-Path $Root ('bin\' + $pair[0] + '.cs')) $pair[2] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('SERVICE_HOST_COMPILE_FAILED:' + $pair[0]) }
    $script:receipt[($pair[0] + 'Sha256')] = Sha256File $exe
  }
  $helper = Join-Path $Root ('helpers\' + $GenericHelper)
  & $Csc /nologo /noconfig /target:winexe /platform:x64 /optimize+ /main:CluedWindowsFormalEntryV2 "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $helper) (Join-Path $v2 'FormalPublicBoundaryV2.cs') (Join-Path $v2 'FormalSession0V2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GENERIC_HELPER_COMPILE_FAILED' }
  $script:receipt.genericHelperSha256 = Sha256File $helper
  } finally { Pop-Location }
}
# 3b. Broker configuration: the Owner SID of the v1 mutation mutex, the original binary, the runner's
#     stable configuration digest (read-only, with the just-compiled broker) and the helper pin. Written
#     once, CreateNew; its SHA-256 is the broker's second command-line argument.
Step 'broker-config' {
  $stable = (& (Join-Path $Root 'bin\SwapBroker.exe') --stable-digest | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $stable -cnotmatch '^[0-9a-f]{64}$') { throw 'RUNNER_STABLE_DIGEST_UNCONFIRMED' }
  if ((Read-RunnerState).sddl -cne $r.sddl) { throw 'RUNNER_SDDL_CHANGED_DURING_INSTALL' }
  # Config /2 (review MINOR-3): no Owner SID; mutex and runner-DACL managers are SYSTEM and Administrators only.
  $json = '{"contract":"clued.independent-ci.swap-broker-config/2","helper":{"name":"' + $GenericHelper + '","sha256":"' + $script:receipt.genericHelperSha256 + '"},"originalBinary":' + ($OriginalBinary | ConvertTo-Json -Compress) + ',"stableDigest":"' + $stable + '"}'
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
  Write-New (Join-Path $Root 'config\broker.json') $bytes
  $script:receipt.brokerConfigSha256 = Sha256Bytes $bytes; $script:receipt.runnerStableDigest = $stable
}
# 4. The resident service (virtual account, Session 0, no right on the runner service) and the
#    broker (LocalSystem, binary-path-only swaps between the original and allow-listed helpers).
Step 'services' {
  $node = Join-Path $Root 'runtime\node.exe'
  $entry = Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\src\service-main.mjs')
  $bin = '"' + (Join-Path $Root 'bin\ResidentServiceHost.exe') + '" "' + $Root + '" ' + $plan.policySha256 + ' "' + $node + '" ' + $plan.nodeSha256 + ' "' + $entry + '" ' + (Sha256File $entry)
  # Windows PowerShell 5.1 does not escape embedded quotes when it builds a native command line, so the
  # binPath= argument carries them as \" (sc.exe's C runtime turns them back into quotes); read back below.
  $null = Invoke-Sc 'RESIDENT_SERVICE_CREATE_FAILED' @('create', $ServiceName, 'binPath=', $bin.Replace('"', '\"'), 'start=', 'delayed-auto', 'obj=', "NT SERVICE\$ServiceName", 'type=', 'own')
  Assert-ServiceBinary $ServiceName $bin
  $null = Invoke-Sc 'RESIDENT_SERVICE_SIDTYPE_FAILED' @('sidtype', $ServiceName, 'unrestricted')
  $null = Invoke-Sc 'RESIDENT_SERVICE_PRIVS_FAILED' @('privs', $ServiceName, ($ResidentPrivileges -join '/'))
  # The trailing empty action is 'none' (cmd's  restart/60000/""/60000  reaches sc.exe as exactly this argv), so the
  # SCM does not repeat the restart for later failures within the reset period; every pair carries its delay.
  $null = Invoke-Sc 'RESIDENT_SERVICE_FAILURE_FAILED' @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/60000//60000')
  $null = Invoke-Sc 'RESIDENT_SERVICE_FAILUREFLAG_FAILED' @('failureflag', $ServiceName, '1')
  $null = Invoke-Sc 'RESIDENT_SERVICE_SDSET_FAILED' @('sdset', $ServiceName, $plan.services.resident.sddl)
  $bbin = '"' + (Join-Path $Root 'bin\SwapBroker.exe') + '" "' + $Root + '" ' + $script:receipt.brokerConfigSha256
  $null = Invoke-Sc 'BROKER_SERVICE_CREATE_FAILED' @('create', $BrokerName, 'binPath=', $bbin.Replace('"', '\"'), 'start=', 'auto', 'type=', 'own')
  Assert-ServiceBinary $BrokerName $bbin
  $null = Invoke-Sc 'BROKER_SERVICE_PRIVS_FAILED' @('privs', $BrokerName, ($BrokerPrivileges -join '/'))
  # A crashed broker comes back (review MINOR-2); a restart never repeats an interrupted swap (taken markers).
  $null = Invoke-Sc 'BROKER_SERVICE_FAILURE_FAILED' @('failure', $BrokerName, 'reset=', '86400', 'actions=', 'restart/60000/restart/300000//300000')
  $null = Invoke-Sc 'BROKER_SERVICE_FAILUREFLAG_FAILED' @('failureflag', $BrokerName, '1')
  $null = Invoke-Sc 'BROKER_SERVICE_SDSET_FAILED' @('sdset', $BrokerName, $plan.services.broker.sddl)
  # Read back what the SCM now holds; the receipt records it and verify-resident.ps1 compares it.
  foreach ($pair in @(@($ServiceName, $ResidentPrivileges, 'resident'), @($BrokerName, $BrokerPrivileges, 'broker'))) {
    $have = ConvertFrom-ScPrivs (Invoke-Sc 'SERVICE_QPRIVS_FAILED' @('qprivs', $pair[0], '8192'))
    if (($have -join '/') -cne ((@($pair[1]) | Sort-Object -CaseSensitive) -join '/')) { throw ('SERVICE_PRIVILEGES_READBACK_MISMATCH:' + $pair[0]) }
    $script:receipt[($pair[2] + 'RequiredPrivileges')] = $have
    $script:receipt[($pair[2] + 'Sddl')] = Get-DaclPart (Invoke-Sc 'SERVICE_SDSHOW_FAILED' @('sdshow', $pair[0]))
  }
  $script:receipt.brokerBinaryPath = $bbin
}
# 4b. Outbound network block scoped to the resident's service SID (review MINOR-5). It covers the service's
#     node processes (they carry the service SID); the companion (Owner) and the runner (clued-control) are
#     not affected. It is enforced only while Windows Firewall is on; verify-resident.ps1 checks both.
Step 'resident-firewall' {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'
  if (Get-NetFirewallRule -Name $FirewallRuleName -ErrorAction SilentlyContinue) { throw 'FIREWALL_RULE_EXISTS' }
  $null = New-NetFirewallRule -Name $FirewallRuleName -DisplayName 'Clued CI resident: no outbound network' -Direction Outbound -Action Block -Service $ServiceName -Profile Any -Enabled True
  $rule = Get-NetFirewallRule -Name $FirewallRuleName; $filter = $rule | Get-NetFirewallServiceFilter
  if ([string]$rule.Direction -cne 'Outbound' -or [string]$rule.Action -cne 'Block' -or [string]$rule.Enabled -cne 'True' -or $filter.Service -cne $ServiceName) { throw 'FIREWALL_RULE_READBACK_MISMATCH' }
  $script:receipt.firewallRule = $FirewallRuleName
}
# 5. Source v2's own reviewed ACL migration of the one-shot install (formal-spool, state) so the
#    resident SID can do what the elevated Owner did per batch. Fixed args, installed copy only.
Step 'source-v2-acl' {
  $tool = Join-Path $Root ('source\' + $plan.ciSourceManifestSha256 + '\work\actions-hosted-migration\independent-ci-v1\src\resident-v2\migrate-acl.ps1')
  if (-not (Test-Path -LiteralPath $tool)) { throw 'SOURCE_V2_REQUIRED' }
  $out = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -File $tool -Apply -ResidentSid $plan.residentSid -OwnerSid $OwnerSid -ControllerSid $ControllerSid | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'SOURCE_V2_ACL_MIGRATION_REFUSED' }
  $script:receipt.sourceV2Acl = ($out | ConvertFrom-Json)
}
# 6. Companion task in the Owner's session, not elevated, protected from modification.
Step 'companion-task' {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = try { $svc.GetFolder('\Clued') } catch { $svc.GetFolder('\').CreateFolder('Clued') }
  $def = $svc.NewTask(0)
  $def.Principal.UserId = $OwnerSid; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $t = $def.Triggers.Create(9); $t.UserId = $OwnerSid
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT0S'; $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $def.Settings.RestartCount = 3; $def.Settings.RestartInterval = 'PT1M'
  $ca = $plan.companionTask.action
  $a = $def.Actions.Create(0); $a.Path = $ca.path; $a.Arguments = $ca.arguments
  # 6 = TASK_CREATE_OR_UPDATE (1 would only validate; review M7). Read back what was registered.
  $null = $folder.RegisterTaskDefinition('CluedCIResidentCompanion', $def, 6, $null, $null, 3, $plan.companionTask.sddl)
  $t = $folder.GetTask('CluedCIResidentCompanion')
  $uid = $t.Definition.Principal.UserId
  $uidSid = if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value }
  $act = if ($t.Definition.Actions.Count -eq 1) { $t.Definition.Actions.Item(1) } else { $null }
  if (($t.Definition.Principal.RunLevel -ne 0) -or ($uidSid -cne $OwnerSid) -or $null -eq $act -or $act.Path -cne $ca.path -or $act.Arguments -cne $ca.arguments) { throw 'COMPANION_TASK_READBACK_MISMATCH' }
  $script:receipt.companionTaskXmlSha256 = Sha256Text $t.Xml
}
# 7. The runner service must be byte-for-byte what it was (this install never touches it).
Step 'runner-unchanged' { if ((Read-RunnerState).sddl -cne $r.sddl) { throw 'RUNNER_SDDL_CHANGED_DURING_INSTALL' } }
$receipt.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
$receipt.started = $false
if ($StartAfterInstall) {
  $null = Invoke-Sc 'BROKER_SERVICE_START_FAILED' @('start', $BrokerName)
  $null = Invoke-Sc 'RESIDENT_SERVICE_START_FAILED' @('start', $ServiceName)
  $receipt.started = $true
  # The effective token privileges, as each host recorded them from its own token (MAJOR-1).
  foreach ($pair in @(@('state\service-token.json', $ResidentPrivileges, 'residentTokenPrivileges'), @('broker\token.json', $BrokerPrivileges, 'brokerTokenPrivileges'))) {
    $file = Join-Path $Root $pair[0]; $until = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path -LiteralPath $file) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 500 }
    $have = @((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).privileges)
    if (@($have | Where-Object { $pair[1] -cnotcontains $_ }).Count -gt 0) { throw ('EFFECTIVE_TOKEN_PRIVILEGES_NOT_MINIMAL:' + $pair[0]) }
    $receipt[$pair[2]] = $have
  }
}
$out = Join-Path $Root 'install\install-receipt.json'                    # admin-only directory
Write-New $out ((New-Object Text.UTF8Encoding($false)).GetBytes(($receipt | ConvertTo-Json -Depth 6)))
[ordered]@{ status = 'RESIDENT_INSTALLED'; receipt = $out; receiptSha256 = (Sha256File $out); started = $receipt.started } | ConvertTo-Json
