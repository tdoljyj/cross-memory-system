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

function Read-RunnerState {
  $qc = & $Sc qc $RunnerService | Out-String
  $q = & $Sc queryex $RunnerService | Out-String
  $bin = if ($qc -match 'BINARY_PATH_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  $acct = if ($qc -match 'SERVICE_START_NAME\s*:\s*(.+)') { $Matches[1].Trim() } else { $null }
  [ordered]@{ binary = $bin; originalBinary = ($bin -ceq $OriginalBinary); account = $acct; accountIsController = ($acct -match '^(\.|TURING)\\clued-control$')
    stoppedPid0 = ($q -match 'STATE\s*:\s*1\s' -and $q -match 'PID\s*:\s*0\b'); manual = ($qc -match 'START_TYPE\s*:\s*3\s'); sddl = (& $Sc sdshow $RunnerService | Out-String).Trim() }
}

# Directory ACLs (owner BUILTIN\Administrators, protected DACL). Masks: 0x1200a9 read+execute,
# 0x1301bf modify, 0x1000a2 add-file+traverse (drop box), FA full. To be validated on a test host.
function Get-AclPlan([string]$res) {
  $base = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
  $rx = '0x1200a9'; $mod = '0x1301bf'; $drop = '0x1000a2'
  [ordered]@{
    ''                  = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)"
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

$pkgBytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot 'package-manifest.json'))  # read ONCE
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
    companionTask = [ordered]@{ path = '\Clued\'; name = 'CluedCIResidentCompanion'; principal = $OwnerSid; runLevel = 'LeastPrivilege'; trigger = 'AtLogOn'; sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$OwnerSid)" }
    startAfterInstall = [bool]$StartAfterInstall
    privilegeBoundary = Get-PrivilegePlan
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
  $back = (Get-Acl -LiteralPath $path).Sddl
  if ($back -cne $sddl) { throw ('ACL_READBACK_MISMATCH:' + $path) }  # canonical-form differences are a review item
}

function Write-New([string]$path, [byte[]]$bytes) {
  $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}

$elevated = Assert-Owner
$plan = Build-Plan
$planSha = Sha256Text ($plan | ConvertTo-Json -Depth 8)
if (-not $Apply) { [ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = $planSha; plan = $plan } | ConvertTo-Json -Depth 10; exit 0 }

if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
if ($ExpectedPlanSha256 -cne $planSha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
if ($plan.rootExists -or $plan.servicesExist) { throw 'FRESH_INSTALL_REQUIRED_USE_UPGRADE_PATH' }
$r = $plan.runnerBefore
if (-not ($r.originalBinary -and $r.stoppedPid0 -and $r.manual -and $r.accountIsController)) { throw 'RUNNER_SERVICE_NOT_ORIGINAL_STOPPED_MANUAL_CONTROLLER' }

$receipt = [ordered]@{ contract = 'clued.independent-ci.resident-install-receipt/2'; planSha256 = $planSha; sourceManifestSha256 = $plan.sourceManifestSha256; residentManifestSha256 = $plan.residentManifestSha256; runnerSddlUnchanged = $r.sddl; steps = @(); startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
function Step([string]$name, [scriptblock]$body) { & $body; $script:receipt.steps += $name }

# 1. Directories, created new with their final ACLs.
Step 'directories' {
  foreach ($rel in $plan.acl.Keys) { New-DirectoryWithAcl $(if ($rel) { Join-Path $Root $rel } else { $Root }) $plan.acl[$rel] }
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
  $null = Invoke-Sc 'RESIDENT_SERVICE_CREATE_FAILED' @('create', $ServiceName, 'binPath=', $bin, 'start=', 'delayed-auto', 'obj=', "NT SERVICE\$ServiceName", 'type=', 'own')
  $null = Invoke-Sc 'RESIDENT_SERVICE_SIDTYPE_FAILED' @('sidtype', $ServiceName, 'unrestricted')
  $null = Invoke-Sc 'RESIDENT_SERVICE_PRIVS_FAILED' @('privs', $ServiceName, ($ResidentPrivileges -join '/'))
  $null = Invoke-Sc 'RESIDENT_SERVICE_FAILURE_FAILED' @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/60000//')
  $null = Invoke-Sc 'RESIDENT_SERVICE_FAILUREFLAG_FAILED' @('failureflag', $ServiceName, '1')
  $null = Invoke-Sc 'RESIDENT_SERVICE_SDSET_FAILED' @('sdset', $ServiceName, $plan.services.resident.sddl)
  $bbin = '"' + (Join-Path $Root 'bin\SwapBroker.exe') + '" "' + $Root + '" ' + $script:receipt.brokerConfigSha256
  $null = Invoke-Sc 'BROKER_SERVICE_CREATE_FAILED' @('create', $BrokerName, 'binPath=', $bbin, 'start=', 'auto', 'type=', 'own')
  $null = Invoke-Sc 'BROKER_SERVICE_PRIVS_FAILED' @('privs', $BrokerName, ($BrokerPrivileges -join '/'))
  # A crashed broker comes back (review MINOR-2); a restart never repeats an interrupted swap (taken markers).
  $null = Invoke-Sc 'BROKER_SERVICE_FAILURE_FAILED' @('failure', $BrokerName, 'reset=', '86400', 'actions=', 'restart/60000/restart/300000//')
  $null = Invoke-Sc 'BROKER_SERVICE_FAILUREFLAG_FAILED' @('failureflag', $BrokerName, '1')
  $null = Invoke-Sc 'BROKER_SERVICE_SDSET_FAILED' @('sdset', $BrokerName, $plan.services.broker.sddl)
  # Read back what the SCM now holds; the receipt records it and verify-resident.ps1 compares it.
  foreach ($pair in @(@($ServiceName, $ResidentPrivileges, 'resident'), @($BrokerName, $BrokerPrivileges, 'broker'))) {
    $have = ConvertFrom-ScPrivs (Invoke-Sc 'SERVICE_QPRIVS_FAILED' @('qprivs', $pair[0], '8192'))
    if (($have -join '/') -cne ((@($pair[1]) | Sort-Object -CaseSensitive) -join '/')) { throw ('SERVICE_PRIVILEGES_READBACK_MISMATCH:' + $pair[0]) }
    $script:receipt[($pair[2] + 'RequiredPrivileges')] = $have
    $script:receipt[($pair[2] + 'Sddl')] = (Invoke-Sc 'SERVICE_SDSHOW_FAILED' @('sdshow', $pair[0])).Trim()
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
  $a = $def.Actions.Create(0); $a.Path = (Join-Path $Root 'runtime\node.exe')
  $a.Arguments = '"' + (Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\src\companion-main.mjs')) + '" --root "' + $Root + '" --config-sha256 ' + $plan.companionConfigSha256
  # 6 = TASK_CREATE_OR_UPDATE (1 would only validate; review M7). Read back what was registered.
  $null = $folder.RegisterTaskDefinition('CluedCIResidentCompanion', $def, 6, $null, $null, 3, $plan.companionTask.sddl)
  $t = $folder.GetTask('CluedCIResidentCompanion')
  $uid = $t.Definition.Principal.UserId
  $uidSid = if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if (($t.Definition.Principal.RunLevel -ne 0) -or ($uidSid -cne $OwnerSid)) { throw 'COMPANION_TASK_READBACK_MISMATCH' }
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
