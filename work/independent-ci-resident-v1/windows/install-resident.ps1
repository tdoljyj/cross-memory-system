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

  Node identity and secrets (resident active/standby design v0.4 sections 7 and 9 C7, DESIGN.md section 30): the plan and the
  receipt carry this node's identity, derived from the package's record\installation.json and record\acceptance.json (the same hashed
  bytes; the two must agree): node name, App key id and public-key fingerprint, ci-admission token fingerprint and connection id,
  the formal qualification refs. No role is assumed: a new connection is not marked with ci-admission, so a node installed on one
  is STANDBY until the role probe says otherwise. -AppPrivateKeyFile and -CiAdmissionTokenFile are optional. A given file is read
  once and its fingerprint computed with the package's pinned runtime\node.exe; it must equal the record's pin (a mismatch refuses
  the install before anything is written), and exactly those bytes are placed, create-only, readable by .\clued-control only.
  The package directory is usually writable by non-admins and node.exe loads DLLs from its own directory first, so the elevated
  process never runs anything from it: node.exe and the reviewed tool are read once, hash-checked against the manifest, and the
  SAME bytes are written into a directory this script creates itself (random name under C:\Windows\Temp, owner Administrators,
  protected DACL, SYSTEM and Administrators only) and run from there; the directory is removed when the check ends. Only a
  supplied key or token file makes the script do that, and it then needs the elevated token even for the dry run.
  An existing target is never overwritten. Neither value is printed or kept: the plan and the receipt hold fingerprints only.
  This script never deletes the file you downloaded; delete it yourself afterwards.

  Nothing existing is overwritten, deleted or re-ACLed, with two exceptions: one read-only ACE is APPENDED to the existing CI root
  C:\ProgramData\CluedIndependentCI (step parent-acl, DESIGN.md section 33; the plan shows the DACL it expects), and the DACL of
  C:\ProgramData\CluedIndependentCI\state is this install's rule (step state-parent-acl, r13): made when missing, the controller's write on
  state itself made inherit-only, any other writer refused. The runner service is NOT modified: its
  configuration is changed only by CluedCISwapBroker (LocalSystem), which can switch the binary path
  between the original and an installed, allow-listed helper and nothing else (review M2).
  The Linux half is linux/install-resident-linux.sh, run separately as root.

  In-place upgrade channel (Task 018da927): the package is /4 and carries the upgrader (package section `upgrader`, targets under
  upgrader\, accepted ONLY by this fresh install). The plan (/8) adds the upgrader and generation 1; the steps add upgrader-files,
  upgrader-host (UpgraderServiceHost.cs compiled into upgrader\bin), upgrader-service (CluedCIUpgrader: LocalSystem, delayed-auto,
  SeChangeNotifyPrivilege only, the services' DACL) and, after the receipt (/6) is written, generation-1 (generations\g1\generation.json
  and upgrade\current.json; nothing is moved). The directories of the channel (upgrader\, upgrade\ with its inbox and mailbox,
  generations\, archive\, secrets\) are created with their final ACLs like every other. -UpgradeTokenFile (optional) is this node's own
  resident-upgrade connection token (never the ci-admission token): read once, fingerprinted like the ci-admission token, placed
  create-only at secrets\resident-upgrade.token readable by SYSTEM and Administrators only. Every later version comes through
  CluedCIUpgrader (windows\request-upgrade.ps1); a reinstall is needed only when the channel itself changes.

  Node heartbeat (merge train step 3c-2b, DESIGN.md section 41.6a): -HeartbeatTokenFile (optional) is this node's heartbeat-only
  connection token from /bindings (it can call the heartbeat function and nothing else; never the ci-admission or the
  resident-upgrade token): read once, fingerprinted like the ci-admission token, placed create-only at
  resident\secrets\heartbeat\ci-node-heartbeat.token in a folder made only then, SYSTEM and Administrators full control, the Owner
  read-only (the companion in the Owner's session reads it), nobody else. Without it nothing about the companion changes.
  -HeartbeatBindingId (optional, a UUID, only together with -HeartbeatTokenFile) is that heartbeat connection's id (KooYomi page
  /bindings/failover, its connection id section), for information only: the plan and the receipt record it and the result prints the
  Owner's next step (heartbeatNextStep): link that connection to this node on /bindings/failover, two-step confirmation. The install
  makes no network call for it and uses no token for it (merge train step 2b review).

  M5, the companion without the Owner's log-on (ADR 0022 section 4): the companion task's action is the fixed supervisor
  bin\CluedCompanionSupervisor.exe "<root>" (compiled here with the task registrar bin\CluedCompanionTaskRegistrar.exe, step
  companion-supervisor); which generation it starts is config\companion-launch.json (step companion-launch, generation 1). The task is
  registered here with the Owner's interactive token and no password (step companion-task: the node works as before even if nothing
  more is done); the notifier task shows the companion's queued notifications at log-on (step notifier-task). The switch to the password
  logon is the reinstall launcher's last step, rearm-resident.ps1 -CompanionHeadless (the password is typed only into the Windows
  credential box on the secure desktop; it never reaches this script). The companion needs its own gh login first
  (windows\companion-gh-login.ps1, run by the Owner, not elevated).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPackageManifestSha256,
  [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$OwnerSid,
  [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$ControllerSid, # .\clued-control
  # M5-b (ADR 0023): the Owner who runs this install when the node profile's ownerSid is the companion's own non-administrator account;
  # omitted, the Owner is ownerSid (the companion runs as the Owner).
  [ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$OperatorSid,
  [switch]$Apply,
  # Reinstall carry preview only: the old root will be retired before install creates its heartbeat directory.
  # It cannot be used to apply a plan or to inspect/supply the heartbeat secret.
  [switch]$PreviewAfterUninstall,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPlanSha256,
  [ValidateLength(1,2048)][string]$InstalledPackageB64,
  [ValidateLength(1,1024)][string]$CiConnectionPlanB64,
  [string]$CiReinstallProof,
  [switch]$StartAfterInstall,
  [string]$AppPrivateKeyFile,        # optional: this node's App private key, downloaded by the Owner on this machine (design 7.1)
  [string]$CiAdmissionTokenFile,     # optional: this node's ci-admission connection token (design 7.2)
  [string]$UpgradeTokenFile,         # optional: this node's resident-upgrade connection token (018da927; its own connection, Owner decision 3ce5200c)
  [string]$HeartbeatTokenFile,       # optional: this node's heartbeat-only connection token (DESIGN.md section 41.6a)
  [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z')][string]$HeartbeatBindingId   # optional, only with -HeartbeatTokenFile: informational
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)
if ($PreviewAfterUninstall -and ($Apply -or $HeartbeatTokenFile -or $HeartbeatBindingId)) { throw 'AFTER_UNINSTALL_PREVIEW_READ_ONLY_WITHOUT_HEARTBEAT_INPUT' }

if (-not $OperatorSid) { $OperatorSid = $OwnerSid }
# M5-b (ADR 0023): the companion runs as its own account ($OwnerSid, the node profile's ownerSid); the Owner ($OperatorSid) keeps what he
# reads and the requests he drops; what only the companion writes (bundles, responses) and reads (the heartbeat secret) is the account's.
$AccountNode = $OperatorSid -cne $OwnerSid
$CiRoot = 'C:\ProgramData\CluedIndependentCI'   # the parent of $Root; it exists before this install (the v1 one-shot install made it)
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$ServiceName = 'CluedCIResident'
$BrokerName = 'CluedCISwapBroker'
$RunnerService = $null   # the node profile's runnerService (Get-PackageNodeProfile, below)
$OriginalBinary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'
$Sc = 'C:\Windows\System32\sc.exe'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
# upgrader\<64 hex>\... and upgrader\{config,runtime,bin}\<name>: the upgrader's own files, accepted only by this fresh install (018da927).
$TargetShape = '^(?:(?:resident|source|upgrader)\\[0-9a-f]{64}(?:\\[A-Za-z0-9_.@-]+)+|(?:config|runtime|bin|helpers|record)\\[A-Za-z0-9_.@-]+|upgrader\\(?:config|runtime|bin)\\[A-Za-z0-9_.@-]+)$'
# Source v2 (DESIGN S5, S12): the claim-free install record goes to record\ (admin-only; read by the
# resident's derivation and by the generic helper as clued-control), the CI Source to
# source\<ciSourceManifestSha256>\ (the directory the generic helper loads code from), and the ONE generic
# helper is compiled here from that installed Source and pinned in config\broker.json.
$GenericHelper = 'controller-formal-generic-v2.exe'
# DESIGN §24 (Task 8e1f07d3): the companion's job host, compiled here from the installed resident copy into bin\ (admin-only,
# read and run by the Owner). The companion starts every child through it and refuses to start without it.
$CompanionJobHost = 'CluedCompanionJobHost.exe'
$SourceV2Windows = 'work\actions-hosted-migration\independent-ci-v1\src\resident-v2\windows'
# Where the runtime reads the two controller secrets (runtime/protected-files.mjs APP_KEY_FILE; resident-v2/entry-runtime.mjs).
$SecretTargets = [ordered]@{ appKey = 'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem'; ciToken = 'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token' }
function Assert-CiInstallBaseline([string]$ciRoot) {
  $file = Join-Path $ciRoot 'secrets\ci-admission.connection.json'
  try { [void][IO.File]::GetAttributes($file) }
  catch [IO.FileNotFoundException] { return }
  catch [IO.DirectoryNotFoundException] { return }
  catch { throw 'CI_CONNECTION_RECORD_REFUSED' }
  throw 'CI_CONNECTION_REINSTALL_BASELINE_REQUIRED'
}
$CarriedCiPlan = $null
if ($CiConnectionPlanB64) {
  try {
    $CarriedCiPlan = (New-Object Text.UTF8Encoding($false,$true)).GetString([Convert]::FromBase64String($CiConnectionPlanB64)) | ConvertFrom-Json
    $keys = @('bindingId','receiptSha256','state')
    if ($CarriedCiPlan.state -ceq 'observed') { $keys += 'observationSha256' }
    elseif ($CarriedCiPlan.state -ceq 'current') { $keys += @('bindingGeneration','rebindReceiptId','recordSha256') }
    else { throw 'state' }
    if (@($CarriedCiPlan.PSObject.Properties).Count -ne $keys.Count -or
        @($keys | Where-Object { $CarriedCiPlan.PSObject.Properties.Name -cnotcontains $_ }).Count -ne 0 -or
        $CarriedCiPlan.receiptSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $CarriedCiPlan.bindingId -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$') { throw 'fields' }
    if ($CarriedCiPlan.state -ceq 'observed' -and $CarriedCiPlan.observationSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'digest' }
    if ($CarriedCiPlan.state -ceq 'current' -and ($CarriedCiPlan.recordSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $CarriedCiPlan.rebindReceiptId -cnotmatch '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
        ($CarriedCiPlan.bindingGeneration -isnot [int] -and $CarriedCiPlan.bindingGeneration -isnot [long]) -or
        $CarriedCiPlan.bindingGeneration -lt 1 -or $CarriedCiPlan.bindingGeneration -gt 9007199254740991)) { throw 'record' }
  } catch { throw 'FLEET_CI_CONNECTION_PLAN_REFUSED' }
  if ($CiAdmissionTokenFile -or ($Apply -and (-not $CiReinstallProof -or -not $StartAfterInstall))) { throw 'CI_CONNECTION_PROTECTED_PROOF_REQUIRED' }
} else {
  if ($CiReinstallProof) { throw 'FLEET_CI_CONNECTION_PLAN_REFUSED' }
  Assert-CiInstallBaseline $CiRoot
}
$script:SecretBytes = @{}   # the verified secret bytes, in memory only, between the plan and the 'node-secrets' step
# Where the fingerprint check runs the package's node.exe and tool (DESIGN.md section 30.5): a directory this script creates, never the package directory.
$SecretWorkParent = 'C:\Windows\Temp'
$SecretWorkSddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
# ---- The in-place upgrade channel (Task 018da927) ----
$UpgraderName = 'CluedCIUpgrader'
$UpgraderPrivileges = @('SeChangeNotifyPrivilege')   # LocalSystem cut to SeChangeNotify; UpgraderServiceHost.cs refuses any other at start
$UpgradeTokenTarget = 'C:\ProgramData\CluedIndependentCI\resident\secrets\resident-upgrade.token'
$UpgradeTokenSddl = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'   # SYSTEM and Administrators only: the upgrader reads it, nobody else
# The node heartbeat token (DESIGN.md section 41.6a): its own folder, SYSTEM and Administrators full control, the Owner read-only.
$HeartbeatTokenDirectory = 'C:\ProgramData\CluedIndependentCI\resident\secrets\heartbeat'
$HeartbeatTokenTarget = $HeartbeatTokenDirectory + '\ci-node-heartbeat.token'
function Get-HeartbeatDirectorySddl([string]$owner) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $owner + ')' }
function Get-HeartbeatFileSddl([string]$owner) { 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x120089;;;' + $owner + ')' }
# An existing heartbeat folder (an earlier install made it) is used only with exactly the folder SDDL above: a real folder (no reparse
# point), owner Administrators, the protected DACL (review R3 MINOR 8; verify-resident.ps1 checks the same).
function Test-HeartbeatDirectoryAcl([string]$path, [string]$sddl) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
  $want = New-Object Security.AccessControl.DirectorySecurity
  $want.SetSecurityDescriptorSddlForm($sddl)
  $back = Get-Acl -LiteralPath $path
  ($back.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544') -and ((Get-DaclPart $back.Sddl) -ceq (Get-DaclPart $want.GetSecurityDescriptorSddlForm('Access')))
}
$WindowsLayout = 'clued.independent-ci.resident-layout/1'
$ServiceSddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)'

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

# ---- Shared with windows/upgrade-apply.ps1 (018da927): one text in both, held identical by test-upgrade-windows.ps1 ----
# The two service command lines (the generation records hold exactly these strings; the upgrader switches between them).
function Get-ResidentBinPath([string]$root, [string]$policySha, [string]$nodeSha, [string]$residentSha, [string]$entrySha) {
  '"' + (Join-Path $root 'bin\ResidentServiceHost.exe') + '" "' + $root + '" ' + $policySha + ' "' + (Join-Path $root 'runtime\node.exe') + '" ' + $nodeSha + ' "' + (Join-Path $root ('resident\' + $residentSha + '\src\service-main.mjs')) + '" ' + $entrySha
}
function Get-BrokerBinPath([string]$root, [string]$brokerConfigSha, [string]$nodeProfileSha) {
  '"' + (Join-Path $root 'bin\SwapBroker.exe') + '" "' + $root + '" ' + $brokerConfigSha + ' ' + $nodeProfileSha
}
# Config /3 of the broker (install-resident.ps1 step 'broker-config').
function Get-BrokerConfigJson([string]$helperSha, [string]$stable, [string]$nodeCanonical, [string]$nodeProfileSha, [string]$acceptanceSha) {
  '{"contract":"clued.independent-ci.swap-broker-config/3","helper":{"name":"' + $GenericHelper + '","sha256":"' + $helperSha + '"},"originalBinary":' + ($OriginalBinary | ConvertTo-Json -Compress) + ',"stableDigest":"' + $stable + '","node":' + $nodeCanonical + ',"nodeProfileSha256":"' + $nodeProfileSha + '","acceptanceSha256":"' + $acceptanceSha + '"}'
}
# The compile recipe (install-resident.ps1 step 'service-hosts'): the two service hosts and the companion job host into $binOut, the ONE
# generic helper into $helpersOut, with the in-box compiler, full reference paths and the caller's directory never used. Returns the hashes.
function Invoke-CompileRecipe([string]$compiler, [string]$fw, [string]$binOut, [string]$helpersOut, [string]$residentHostCs, [string]$brokerCs, [string]$v2, [string]$jobHostCs) {
  $hashes = [ordered]@{}
  Push-Location $binOut
  try {
    foreach ($pair in @(@('ResidentServiceHost', @("/reference:$($fw)System.dll", "/reference:$($fw)System.ServiceProcess.dll"), $residentHostCs, @()),
                        @('SwapBroker', @("/reference:$($fw)System.dll", "/reference:$($fw)System.Core.dll", "/reference:$($fw)System.ServiceProcess.dll", "/reference:$($fw)System.Web.Extensions.dll"), $brokerCs,
                          @((Join-Path $v2 'ResidentScmV2.cs'), (Join-Path $v2 'ScmPidHandshakeV2.cs'), (Join-Path $v2 'NodeProfileV2.cs'))))) {
      $exe = Join-Path $binOut ($pair[0] + '.exe')
      & $compiler /nologo /noconfig /target:exe /optimize+ ("/out:" + $exe) $pair[1] $pair[2] $pair[3] | Out-Null
      if ($LASTEXITCODE -ne 0) { throw ('SERVICE_HOST_COMPILE_FAILED:' + $pair[0]) }
      $hashes[($pair[0] + 'Sha256')] = Sha256File $exe
    }
    $helper = Join-Path $helpersOut $GenericHelper
    & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ /main:CluedWindowsFormalEntryV2 "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $helper) (Join-Path $v2 'FormalPublicBoundaryV2.cs') (Join-Path $v2 'FormalSession0V2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') (Join-Path $v2 'NodeProfileV2.cs') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'GENERIC_HELPER_COMPILE_FAILED' }
    $hashes.genericHelperSha256 = Sha256File $helper
    # The companion's job host (DESIGN §24), with the generic helper's flags (winexe: never a console window of its own).
    $jobHost = Join-Path $binOut $CompanionJobHost
    & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" ("/out:" + $jobHost) $jobHostCs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'COMPANION_JOB_HOST_COMPILE_FAILED' }
    $hashes.companionJobHostSha256 = Sha256File $jobHost
  } finally { Pop-Location }
  $hashes
}
# ---- Shared with install-resident.ps1 and upgrade-apply.ps1 (test-companion-headless.ps1 holds the copies identical) ----
# The companion task's fixed action (ADR 0022 section 4.2): the supervisor, with the root and nothing else.
function Get-SupervisorAction([string]$root) { [ordered]@{ path = (Join-Path $root 'bin\CluedCompanionSupervisor.exe'); arguments = ('"' + $root + '"') } }
# The task's protection: SYSTEM and Administrators full, the Owner read only (ADR 0022 section 4.1).
function Get-CompanionTaskSddl([string]$ownerSid) { "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;$ownerSid)" }
# The task's DACL as read back is Get-CompanionTaskSddl's, compared as a security descriptor, not as text: protected (P), and the same
# ACEs in the same order (type, flags, rights, SID; each ACE's binary form). Other control bits (AI, AR) are ignored: 2026-11-08, the
# 29th DESK reinstall failed verify on companion-task because the Task Scheduler reads a protected DACL back as D:PAI(...) and a
# D:P(...) cannot be stored at all (flag 0x10 keeps P and adds AI; flag 0 drops P and adds a principal ACE).
# The frozen upgrade channel's copy of Get-CompanionTaskFacts (upgrade-apply.ps1) still compares the text; there it only notes
# COMPANION_TASK_NEEDS_OWNER and never blocks an upgrade.
function Test-CompanionTaskDacl([string]$dacl, [string]$ownerSid) {
  if (-not $dacl) { return $false }
  try {
    $want = [Security.AccessControl.RawSecurityDescriptor]::new((Get-CompanionTaskSddl $ownerSid))
    $have = [Security.AccessControl.RawSecurityDescriptor]::new($dacl)
  } catch { return $false }
  if (([int]$have.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { return $false }
  $a = $want.DiscretionaryAcl; $b = $have.DiscretionaryAcl
  if ($null -eq $b -or $b.Count -ne $a.Count) { return $false }
  for ($i = 0; $i -lt $a.Count; $i++) {
    $x = [byte[]]::new($a[$i].BinaryLength); $a[$i].GetBinaryForm($x, 0)
    $y = [byte[]]::new($b[$i].BinaryLength); $b[$i].GetBinaryForm($y, 0)
    if ([Convert]::ToBase64String($x) -cne [Convert]::ToBase64String($y)) { return $false }
  }
  $true
}
# The companion child's arguments after node.exe, as the supervisor builds them (CompanionSupervisor.cs CommandLine); the generation
# records keep this string as companionTaskArguments.
function Get-CompanionLaunchArguments([string]$root, [string]$residentSha, [string]$configSha) {
  '"' + (Join-Path $root ('resident\' + $residentSha + '\src\companion-main.mjs')) + '" --root "' + $root + '" --config-sha256 ' + $configSha
}
# The companion's own gh login (Owner decision): <profile>\AppData\Local\CluedIndependentCI\companion-gh\{gh,home}.
function Get-CompanionGhDirs([string]$profileDir) {
  $base = Join-Path $profileDir 'AppData\Local\CluedIndependentCI\companion-gh'
  [ordered]@{ base = $base; gh = (Join-Path $base 'gh'); home = (Join-Path $base 'home') }
}
# The directories the child's PATH adds to the system ones: gh's (companion.json ghExe) and Git for Windows' cmd (build-bundle.ps1 $Git).
function Get-CompanionPathDirs([string]$ghExe) { @((Split-Path -Parent $ghExe), 'C:\Program Files\Git\cmd') }
# config\companion-launch.json, the one input of the supervisor (contract clued.independent-ci.companion-launch/1), keys in this order.
function Get-CompanionLaunchJson([string]$root, [int]$generation, [string]$nodeSha, [string]$residentSha, [string]$entrySha, [string]$configSha, [string]$profileDir, [string[]]$pathDirs) {
  foreach ($h in @($nodeSha, $residentSha, $entrySha, $configSha)) { if ($h -cnotmatch '^[0-9a-f]{64}\z') { throw 'COMPANION_LAUNCH_HASH_REFUSED' } }
  if ($generation -lt 1) { throw 'COMPANION_LAUNCH_GENERATION_REFUSED' }
  $gh = Get-CompanionGhDirs $profileDir
  $q = { param([string]$s) ConvertTo-Json -InputObject $s -Compress }
  '{"contract":' + (& $q 'clued.independent-ci.companion-launch/1') + ',"generation":' + $generation + ',"nodeExe":' + (& $q (Join-Path $root 'runtime\node.exe')) +
  ',"nodeExeSha256":"' + $nodeSha + '","entry":' + (& $q (Join-Path $root ('resident\' + $residentSha + '\src\companion-main.mjs'))) + ',"entrySha256":"' + $entrySha +
  '","configSha256":"' + $configSha + '","ghConfigDir":' + (& $q $gh.gh) + ',"homeDir":' + (& $q $gh.home) + ',"pathDirs":[' + ((@($pathDirs) | ForEach-Object { & $q $_ }) -join ',') + ']}'
}
# Atomic replace in config\ (the temporary file inherits config\'s DACL; ReplaceFile keeps the replaced file's): a reader sees the old
# file or the new one, never a part. Returns the SHA-256 of the bytes written.
function Write-CompanionLaunch([string]$root, [string]$json) {
  $dest = Join-Path $root 'config\companion-launch.json'
  $tmp = $dest + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
  $f = New-Object IO.FileStream($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
  if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($tmp, $dest, [NullString]::Value) } else { [IO.File]::Move($tmp, $dest) }
  $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
}
# The companion task with the Owner's interactive token (the install's first registration, and the fall-back that needs no password):
# at log-on, not elevated, the supervisor's fixed action, IgnoreNew, no time limit, no restart on failure. Read back; returns the XML hash.
function Register-CompanionTaskInteractive([string]$root, [string]$ownerSid) {
  $ca = Get-SupervisorAction $root
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = try { $svc.GetFolder('\Clued') } catch { $svc.GetFolder('\').CreateFolder('Clued') }
  $def = $svc.NewTask(0)
  $def.Principal.UserId = $ownerSid; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $t = $def.Triggers.Create(9); $t.UserId = $ownerSid
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT0S'; $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $a = $def.Actions.Create(0); $a.Path = $ca.path; $a.Arguments = $ca.arguments
  $null = $folder.RegisterTaskDefinition('CluedCIResidentCompanion', $def, 6, $null, $null, 3, (Get-CompanionTaskSddl $ownerSid))
  $t = $folder.GetTask('CluedCIResidentCompanion')
  $uid = $t.Definition.Principal.UserId
  $uidSid = if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value }
  $act = if ($t.Definition.Actions.Count -eq 1) { $t.Definition.Actions.Item(1) } else { $null }
  if (($t.Definition.Principal.RunLevel -ne 0) -or ($t.Definition.Principal.LogonType -ne 3) -or ($uidSid -cne $ownerSid) -or $null -eq $act -or $act.Path -cne $ca.path -or $act.Arguments -cne $ca.arguments) { throw 'COMPANION_TASK_READBACK_MISMATCH' }
  $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t.Xml)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
}
# The notifier task (ADR 0022 section 4.3): the Owner's interactive token, not elevated, at log-on, one instance; no password, so the upgrade
# channel registers it again for every generation.
function Get-NotifierAction([string]$root, [string]$residentSha) {
  [ordered]@{ path = 'C:\Windows\System32\conhost.exe'
    arguments = '--headless "' + (Join-Path $root 'runtime\node.exe') + '" "' + (Join-Path $root ('resident\' + $residentSha + '\src\notifier-main.mjs')) + '" --root "' + $root + '"' }
}
function Register-NotifierTask([string]$root, [string]$ownerSid, [string]$residentSha) {
  $ca = Get-NotifierAction $root $residentSha
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = try { $svc.GetFolder('\Clued') } catch { $svc.GetFolder('\').CreateFolder('Clued') }
  $def = $svc.NewTask(0)
  $def.Principal.UserId = $ownerSid; $def.Principal.LogonType = 3; $def.Principal.RunLevel = 0
  $t = $def.Triggers.Create(9); $t.UserId = $ownerSid
  $def.Settings.MultipleInstances = 2; $def.Settings.ExecutionTimeLimit = 'PT0S'; $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
  $def.Settings.RestartCount = 3; $def.Settings.RestartInterval = 'PT1M'
  $a = $def.Actions.Create(0); $a.Path = $ca.path; $a.Arguments = $ca.arguments
  $null = $folder.RegisterTaskDefinition('CluedCIResidentNotifier', $def, 6, $null, $null, 3, "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;$ownerSid)")
  $t = $folder.GetTask('CluedCIResidentNotifier')
  $act = if ($t.Definition.Actions.Count -eq 1) { $t.Definition.Actions.Item(1) } else { $null }
  if (($t.Definition.Principal.RunLevel -ne 0) -or $null -eq $act -or $act.Path -cne $ca.path -or $act.Arguments -cne $ca.arguments) { throw 'NOTIFIER_TASK_READBACK_MISMATCH' }
  $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t.Xml)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
}
# What the companion task is now: mode 'password' (ADR 0022 section 4.1, exactly), 'interactive' (the install's first registration or the
# fall-back, exactly), 'other' (anything else: problems names what differs), or absent. Read-only; the Owner can read it (FR).
function Get-CompanionTaskFacts([string]$root, [string]$ownerSid) {
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $task = try { $svc.GetFolder('\Clued').GetTask('CluedCIResidentCompanion') } catch { $null }
  if ($null -eq $task) { return [ordered]@{ exists = $false; mode = 'absent'; problems = @('absent'); state = $null; lastTaskResult = $null; logonType = $null; xmlSha256 = $null } }
  $d = $task.Definition; $p = @()
  $uid = [string]$d.Principal.UserId
  $uidSid = try { if ($uid -match '^S-1-') { $uid } else { (New-Object Security.Principal.NTAccount($uid)).Translate([Security.Principal.SecurityIdentifier]).Value } } catch { $null }
  if ($uidSid -cne $ownerSid) { $p += 'principal' }
  if ($d.Principal.RunLevel -ne 0) { $p += 'run-level' }
  $ca = Get-SupervisorAction $root
  $act = if ($d.Actions.Count -eq 1) { $d.Actions.Item(1) } else { $null }
  if ($null -eq $act -or [string]$act.Path -cne $ca.path -or [string]$act.Arguments -cne $ca.arguments) { $p += 'action' }
  $sd = try { [string]$task.GetSecurityDescriptor(4) } catch { $null }   # DACL_SECURITY_INFORMATION
  $dacl = if ($sd) { $i = $sd.IndexOf('D:'); if ($i -ge 0) { $sd.Substring($i) } else { $sd } } else { $null }
  if (-not (Test-CompanionTaskDacl $dacl $ownerSid)) { $p += 'sddl' }
  $sdOwner = try { $o = [string]$task.GetSecurityDescriptor(1); if ($o -match '^O:([A-Z]{2}|S-1-[0-9-]+)') { $Matches[1] } else { $null } } catch { $null }   # OWNER_SECURITY_INFORMATION: a fact
  if ($d.Settings.MultipleInstances -ne 2) { $p += 'multiple-instances' }
  if ([string]$d.Settings.ExecutionTimeLimit -cne 'PT0S') { $p += 'time-limit' }
  if ($d.Settings.DisallowStartIfOnBatteries -or $d.Settings.StopIfGoingOnBatteries) { $p += 'batteries' }
  if ($d.Settings.RestartCount -ne 0) { $p += 'restart-on-failure' }
  $triggers = @(foreach ($t in $d.Triggers) { $t })
  $types = @($triggers | ForEach-Object { [int]$_.Type }) | Sort-Object
  $mode = 'other'
  if ($d.Principal.LogonType -eq 1) {
    $boot = @($triggers | Where-Object { $_.Type -eq 8 }); $time = @($triggers | Where-Object { $_.Type -eq 1 })
    $ok = ($types -join ',') -ceq '1,8' -and [string]$boot[0].Delay -ceq 'PT30S' -and [string]$time[0].Repetition.Interval -ceq 'PT15M' -and [string]$time[0].Repetition.Duration -ceq '' -and $d.Settings.StartWhenAvailable
    if (-not $ok) { $p += 'triggers' }
    if ($p.Count -eq 0) { $mode = 'password' }
  } elseif ($d.Principal.LogonType -eq 3) {
    if (($types -join ',') -cne '9') { $p += 'triggers' }
    if ($p.Count -eq 0) { $mode = 'interactive' }
  } else { $p += 'logon-type' }
  $s = [Security.Cryptography.SHA256]::Create()
  $xmlSha = try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$task.Xml)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() }
  [ordered]@{ exists = $true; mode = $mode; problems = $p; state = [int]$task.State; lastTaskResult = ([int64]$task.LastTaskResult -band 0xFFFFFFFFL); logonType = [int]$d.Principal.LogonType; xmlSha256 = $xmlSha; sdOwner = $sdOwner }
}
# The supervisor and the task registrar (ADR 0022 section 4.2, 4.4), compiled like the job host: /noconfig, full reference paths, winexe,
# into the admin-only bin\. Install only: they carry no generation, and the upgrade channel never replaces them. Returns the hashes.
function Invoke-CompanionSupervisorCompile([string]$compiler, [string]$fw, [string]$binOut, [string]$supervisorCs, [string]$registrarCs) {
  $hashes = [ordered]@{}
  Push-Location $binOut
  try {
    foreach ($pair in @(@('CluedCompanionSupervisor.exe', $supervisorCs, 'companionSupervisorSha256'), @('CluedCompanionTaskRegistrar.exe', $registrarCs, 'companionRegistrarSha256'))) {
      $exe = Join-Path $binOut $pair[0]
      & $compiler /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $exe) $pair[1] | Out-Null
      if ($LASTEXITCODE -ne 0) { throw ('COMPANION_SUPERVISOR_COMPILE_FAILED:' + $pair[0]) }
      $hashes[$pair[2]] = Sha256File $exe
    }
  } finally { Pop-Location }
  $hashes
}

# ---- The upgrader (018da927; shared with verify-resident.ps1) ----
# CluedCIUpgrader's command line: UpgraderServiceHost.exe ROOT CONFIG_SHA NODE NODE_SHA ENTRY ENTRY_SHA (UpgraderServiceHost.cs UpgraderArgs).
function Get-UpgraderBinPath([string]$root, [string]$configSha, [string]$nodeSha, [string]$manifestSha, [string]$entrySha) {
  '"' + (Join-Path $root 'upgrader\bin\UpgraderServiceHost.exe') + '" "' + $root + '" ' + $configSha + ' "' + (Join-Path $root 'upgrader\runtime\node.exe') + '" ' + $nodeSha + ' "' + (Join-Path $root ('upgrader\' + $manifestSha + '\upgrader\src\upgrader-main.mjs')) + '" ' + $entrySha
}
# The files of a generation (A6): everything under config\, record\, bin\ and helpers\, and install\install-receipt.json. The hash is the
# SHA-256 of [{"path":"<relative, backslashes>","sha256":"<hex>"},...] sorted by path (ordinal), compact, UTF-8: generation.json filesSha256.
function Get-GenerationFilesSha256([string]$root) {
  [string[]]$slots = @('config\policy.json', 'config\companion.json', 'config\resident-installed-manifest.json', 'config\source-installed-manifest.json',
    'record\installation.json', 'record\acceptance.json', 'record\source-manifest.json', 'record\signers.json', 'record\record-manifest.json',
    'bin\ResidentServiceHost.cs', 'bin\SwapBroker.cs', 'runtime\node.exe',
    'bin\ResidentServiceHost.exe', 'bin\SwapBroker.exe', 'bin\CluedCompanionJobHost.exe', 'helpers\controller-formal-generic-v2.exe', 'config\broker.json')
  [Array]::Sort($slots, [StringComparer]::Ordinal)
  $rows = @(foreach ($s in $slots) {
      $f = Join-Path $root $s
      $item = Get-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
      if ($null -ne $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw ('GENERATION_FILE_LINK_REFUSED:' + $s) }
      ($s | ConvertTo-Json -Compress) + ':' + $(if ($null -ne $item -and -not $item.PSIsContainer) { '"' + (Sha256File $f) + '"' } else { 'null' }) })
  Sha256Text ('{' + ($rows -join ',') + '}')
}
# The upgrader's service host, compiled like the resident's (target exe, System and System.ServiceProcess only). Returns its hash.
function Invoke-UpgraderHostCompile([string]$compiler, [string]$fw, [string]$binOut, [string]$hostCs) {
  Push-Location $binOut
  try {
    $exe = Join-Path $binOut 'UpgraderServiceHost.exe'
    & $compiler /nologo /noconfig /target:exe /optimize+ ("/out:" + $exe) "/reference:$($fw)System.dll" "/reference:$($fw)System.ServiceProcess.dll" $hostCs | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'UPGRADER_HOST_COMPILE_FAILED' }
    Sha256File $exe
  } finally { Pop-Location }
}

function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Sha256Text([string]$t) { Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($t)) }
function Sha256File([string]$p) { Sha256Bytes ([IO.File]::ReadAllBytes($p)) }

# Virtual service account SID: S-1-5-80 + SHA-1 of the upper-case service name (UTF-16LE).
function Get-ServiceSid([string]$name) {
  $h = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($name.ToUpperInvariant()))
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($h, $_ * 4) }) -join '-')
}

# ---- Node profile (resident active/standby design v0.4, section 9 C1) ----
# The host this package is pinned to is the install record's node profile: record\acceptance.json `node`, read from
# the package, hashed against the reviewed manifest and parsed from those same bytes. Every host identity this
# script needs (computer name, runner service, Owner and controller accounts) comes from it; the repository holds no
# node's profile. The shape rules are those of
# resident-v2/prepare-record.mjs#validateNodeProfile; -OwnerSid and -ControllerSid must name the same accounts.
$NodeProfileKeys = @('contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'controllerSid', 'runnerService', 'mutationMutex', 'wslDistribution')
# .NET regex differs from JS here: `$` also matches before a final newline and `\d` matches any Unicode digit, so every
# pattern is anchored with \z and spells digits [0-9]. The shared cases (independent-ci-v1/test/fixtures/
# node-profile-cases.json) hold both validators to the same answers and refusal codes.
function Assert-NodeProfile($n) {
  $names = @(if ($n -is [pscustomobject]) { $n.PSObject.Properties.Name })
  if ($names.Count -ne $NodeProfileKeys.Count -or @($NodeProfileKeys | Where-Object { $names -cnotcontains $_ -or $n.$_ -isnot [string] }).Count -ne 0 -or
    $n.contract -cne 'clued.independent-ci.node-profile/1') { throw 'NODE_PROFILE_FIELDS_REQUIRED' }
  $sid = '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-([0-9]{1,10})\z'
  $rid = if ($n.controllerSid -cmatch $sid) { $Matches[1] } else { $null }
  if ($n.nodeName -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z' -or
    $n.hostname -cnotmatch '^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?\z' -or $n.ownerSid -cnotmatch $sid -or $null -eq $rid -or [long]$rid -lt 1000 -or $n.ownerSid -ceq $n.controllerSid -or
    $n.ownerProfileDirectory -cnotmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z' -or
    $n.runnerService -cnotmatch '^actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\z' -or
    $n.mutationMutex -cne ('Global\CluedControlControllerMutationV1-' + $n.hostname + '-' + $rid) -or
    $n.wslDistribution -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z') { throw 'NODE_PROFILE_INVALID' }
}
function ConvertTo-NodeProfileCanonical($n) {
  Assert-NodeProfile $n
  [string[]]$keys=$NodeProfileKeys.Clone();[Array]::Sort($keys,[StringComparer]::Ordinal)
  $rows=@(foreach($key in $keys) { ($key | ConvertTo-Json -Compress)+':'+($n.$key | ConvertTo-Json -Compress) })
  return '{'+($rows -join ',')+'}'
}
function Get-PackageNodeProfile {
  if ((Sha256Bytes $pkgBytes) -cne $ExpectedPackageManifestSha256) { throw 'REVIEWED_PACKAGE_CHANGED' }
  $entry = @(([Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json).files | Where-Object { $_.target -ceq 'record\acceptance.json' })
  if ($entry.Count -ne 1 -or $entry[0].path -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($entry[0].path)) { throw 'PACKAGE_NODE_PROFILE_REQUIRED' }
  $bytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot $entry[0].path))
  if ((Sha256Bytes $bytes) -cne $entry[0].sha256) { throw 'PACKAGE_FILE_CHANGED:record\acceptance.json' }
  $accepted = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) | ConvertFrom-Json
  if (-not ($accepted.PSObject.Properties.Name -ccontains 'node')) { throw 'PACKAGE_NODE_PROFILE_REQUIRED' }
  Assert-NodeProfile $accepted.node
  if ($accepted.hostname -cne $accepted.node.hostname) { throw 'NODE_PROFILE_INVALID' }
  $accepted.node
}

# ---- Node identity (resident active/standby design v0.4 sections 7.1, 7.2, 7.4 and 9 C7; DESIGN.md section 30) ----
# Who this node is to the services it talks to, as the install pins it in its receipt: the node name, this node's GitHub App key
# (appKeyId and the public-key fingerprint), its ci-admission connection (connection id and token fingerprint), the formal
# qualification refs of the install record and the Owner decision that accepted it. Public ids and fingerprints only: never a key
# or a token. ciPrincipalRoleRef is the Owner decision that this connection MAY hold ci-admission (design 7.2); whether it holds
# it now is only ever the role probe's answer, so no role is assumed here. The identity is derived from the two install-record
# files the package carries, read from the same hashed bytes; the two files state the connection, the token pin, the key
# fingerprint and the principal qualification twice and must agree. src/node-identity.mjs is the JavaScript twin;
# test/fixtures/node-identity-cases.json holds the three to the same answers and refusal codes.
$NodeIdentityRefs = @('sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef')
$NodeIdentityKeys = @('contract', 'nodeName', 'appKeyId', 'appPublicKeySha256Base64', 'ciTokenPinSha256', 'ciPrincipalBindingId', 'ciPrincipalRoleRef', 'sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef', 'ownerDecisionRef', 'ownerReceiptRef')
# .NET regex notes as for the node profile: \z anchors, [0-9a-f] digits. A property that is absent reads as $null (StrictMode).
function Get-NodeIdentity($installation, $accepted, [string]$acceptanceSha256) {
  $get = { param($o, [string]$k) if (($o -is [pscustomobject]) -and (@($o.PSObject.Properties.Name) -ccontains $k)) { $o.$k } else { $null } }
  $is = { param($v, [string]$re) ($v -is [string]) -and ($v -cmatch $re) }
  $uuid = '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z'; $hex = '^[a-f0-9]{64}\z'; $key = '^[A-Za-z0-9+/]{43}=\z'
  $node = & $get $accepted 'node'; $keyId = & $get $installation 'appKeyId'
  $fields = ($installation -is [pscustomobject]) -and ($accepted -is [pscustomobject]) -and ($acceptanceSha256 -cmatch $hex) -and ($node -is [pscustomobject]) -and
    (& $is (& $get $node 'nodeName') '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z') -and (($keyId -is [int]) -or ($keyId -is [long])) -and ([long]$keyId -ge 1) -and ([long]$keyId -le 9007199254740991) -and
    (& $is (& $get $installation 'appPublicKeySha256Base64') $key) -and (& $is (& $get $installation 'ciTokenPinSha256') $hex) -and
    (& $is (& $get $installation 'ciPrincipalBindingId') $uuid) -and (& $is (& $get $installation 'ciPrincipalRoleRef') $uuid) -and (& $is (& $get $installation 'acceptanceSha256') $hex) -and
    (& $is (& $get $accepted 'ownerDecisionRef') $uuid) -and (& $is (& $get $accepted 'ownerReceiptRef') $uuid) -and
    (@($NodeIdentityRefs | Where-Object { -not ((& $is (& $get $accepted $_) $uuid) -and ((& $get $accepted $_) -cnotmatch '^0{8}-')) }).Count -eq 0)
  if (-not $fields) { throw 'NODE_IDENTITY_FIELDS_REQUIRED' }
  if ((& $get $installation 'acceptanceSha256') -cne $acceptanceSha256) { throw 'NODE_IDENTITY_ACCEPTANCE_PIN_MISMATCH' }
  foreach ($k in @('ciPrincipalBindingId', 'ciTokenPinSha256', 'appPublicKeySha256Base64', 'ciPrincipalQualificationRef')) {
    if ((& $get $accepted $k) -cne (& $get $installation $k)) { throw 'NODE_IDENTITY_RECORDS_DISAGREE' }
  }
  $id = [ordered]@{ contract = 'clued.independent-ci.node-identity/1'; nodeName = $node.nodeName; appKeyId = [long]$keyId
    appPublicKeySha256Base64 = $installation.appPublicKeySha256Base64; ciTokenPinSha256 = $installation.ciTokenPinSha256
    ciPrincipalBindingId = $installation.ciPrincipalBindingId; ciPrincipalRoleRef = $installation.ciPrincipalRoleRef }
  foreach ($k in $NodeIdentityRefs) { $id[$k] = $accepted.$k }
  $id.ownerDecisionRef = $accepted.ownerDecisionRef; $id.ownerReceiptRef = $accepted.ownerReceiptRef
  $id
}
# Sorted keys, compact JSON: the bytes the JavaScript twin hashes (src/node-identity.mjs, canonicalJson).
function ConvertTo-NodeIdentityCanonical($id) {
  [string[]]$keys = $NodeIdentityKeys.Clone(); [Array]::Sort($keys, [StringComparer]::Ordinal)
  $rows = @(foreach ($key in $keys) { ($key | ConvertTo-Json -Compress) + ':' + ($id.$key | ConvertTo-Json -Compress) })
  return '{' + ($rows -join ',') + '}'
}
# One file of the package by its install target: found in the reviewed manifest, read ONCE, hashed and compared; those bytes are returned.
function Read-PackageRecordFile([string]$target) {
  if ((Sha256Bytes $pkgBytes) -cne $ExpectedPackageManifestSha256) { throw 'REVIEWED_PACKAGE_CHANGED' }
  $entry = @(([Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json).files | Where-Object { $_.target -ceq $target })
  if ($entry.Count -ne 1 -or $entry[0].path -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($entry[0].path)) { throw ('PACKAGE_RECORD_FILE_REQUIRED:' + $target) }
  $bytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot $entry[0].path))
  if ((Sha256Bytes $bytes) -cne $entry[0].sha256) { throw ('PACKAGE_FILE_CHANGED:' + $target) }
  return ,$bytes
}
function Get-PackageNodeIdentity {
  $installationBytes = Read-PackageRecordFile 'record\installation.json'
  $acceptanceBytes = Read-PackageRecordFile 'record\acceptance.json'
  $strict = New-Object Text.UTF8Encoding($false, $true)
  $id = Get-NodeIdentity ($strict.GetString($installationBytes) | ConvertFrom-Json) ($strict.GetString($acceptanceBytes) | ConvertFrom-Json) (Sha256Bytes $acceptanceBytes)
  # build-package.mjs derived it too, from the same files, and pinned its hash in the reviewed package manifest.
  $pkg = [Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json
  if (-not (@($pkg.PSObject.Properties.Name) -ccontains 'nodeIdentitySha256')) { throw 'PACKAGE_NODE_IDENTITY_REQUIRED' }
  if ((Sha256Text (ConvertTo-NodeIdentityCanonical $id)) -cne $pkg.nodeIdentitySha256) { throw 'PACKAGE_NODE_IDENTITY_CHANGED' }
  return $id
}

# ---- The App private key and the ci-admission token (design v0.4 sections 7.1, 7.2; DESIGN.md section 30) ----
# Both are optional install parameters: the Owner downloaded the key on THIS machine and made the connection here; neither value
# ever passes through an Agent, chat, KooYomi, the repository or a drive, and the plan and receipt keep fingerprints only. A supplied
# file is read ONCE into memory (a regular file, no link, bounded), its fingerprint is computed by the package's pinned
# runtime\node.exe running the package's reviewed tools\secret-fingerprint.mjs (both hash-checked and HELD OPEN, so neither can change
# before or while it runs; the secret goes to it on stdin), and it must equal the record's pin: a mismatch refuses the install before
# anything is written. Exactly the fingerprinted bytes are then placed, create-only, with their final security descriptor: owner
# Administrators, protected DACL, SYSTEM and Administrators full, .\clued-control read only. An existing target is never
# overwritten and nothing is deleted (the downloaded copy is the Owner's to delete). The formulas are the runtime's own
# (resident-v2/entry-runtime.mjs#controllerPrincipal), so what matches here is what the runtime accepts.
function Get-SecretFileSddl([string]$controllerSid) { 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;' + $controllerSid + ')' }
function Get-SecretDirectorySddl([string]$controllerSid) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $controllerSid + ')' }

# A directory this script creates for the fingerprint check: random name, owner Administrators, protected DACL (SYSTEM and Administrators
# only, inherited by what is put in it). Nobody else can create, enter, rename or delete it, so what is copied into it is what runs.
# $leaf is only for tests; the production name is random. Returns the path.
function New-SecretWorkDirectory([string]$parent, [string]$sddl, [string]$leaf = ('clued-secret-check-' + [guid]::NewGuid().ToString('N'))) {
  $path = Join-Path $parent $leaf
  if (Test-Path -LiteralPath $path) { throw 'SECRET_WORK_DIRECTORY_EXISTS' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm($sddl)
  $null = [IO.Directory]::CreateDirectory($path, $acl)
  $back = Get-Acl -LiteralPath $path
  if ((Get-DaclPart $back.Sddl) -cne (Get-DaclPart $acl.GetSecurityDescriptorSddlForm('Access'))) { throw 'SECRET_WORK_DIRECTORY_ACL_MISMATCH' }
  if ($sddl.StartsWith('O:BA', [StringComparison]::Ordinal) -and $back.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') { throw 'SECRET_WORK_DIRECTORY_ACL_MISMATCH' }
  $path
}
# kind 'app-key' | 'ci-token'. Returns the tool's fingerprint, or $null when the tool refused the secret (not a private RSA key / not a token).
# node.exe and the tool are read from the package ONCE and hash-checked against the reviewed manifest; those same bytes are written into a
# fresh admin-only directory and run from there (never from the package directory: it is usually writable by non-admins, and node.exe loads
# DLLs such as WINMM, IPHLPAPI, USERENV and dbghelp from its own directory before System32). The directory is removed afterwards.
function Get-SecretFingerprint([string]$kind, [byte[]]$secret) {
  $pkg = [Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json
  $tool = @($pkg.files | Where-Object { $_.target -cmatch '^resident\\[0-9a-f]{64}\\tools\\secret-fingerprint\.mjs\z' })
  if ($tool.Count -ne 1) { throw 'PACKAGE_SECRET_TOOL_REQUIRED' }
  $nodeBytes = Read-PackageRecordFile 'runtime\node.exe'
  $toolBytes = Read-PackageRecordFile $tool[0].target
  $work = New-SecretWorkDirectory $SecretWorkParent $SecretWorkSddl
  try {
    $nodePath = Join-Path $work 'node.exe'; $toolPath = Join-Path $work 'secret-fingerprint.mjs'
    Write-New $nodePath $nodeBytes
    Write-New $toolPath $toolBytes
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $nodePath; $psi.Arguments = '"' + $toolPath + '" ' + $kind
    $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = 'C:\Windows\System32'
    # A cleared, fixed environment (no NODE_OPTIONS or other variable of the Owner's session), as verify-resident.ps1 runs node.
    $psi.EnvironmentVariables.Clear(); foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('WINDIR', 'C:\Windows'), @('PATH', 'C:\Windows\System32'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
    # No BOM before the secret on a UTF-8 console: the guard every start with a redirected stdin carries (see Invoke-NativeChild, test/native-child.test.mjs).
    $cie = if ($psi.RedirectStandardInput) { [Console].GetField('_inputEncoding', [Reflection.BindingFlags]'NonPublic, Static') } else { $null }
    $was = if ($null -ne $cie) { $cie.GetValue($null) } else { $null }
    if ($null -ne $cie) { $cie.SetValue($null, (New-Object Text.UTF8Encoding($false))) }
    try { $p = [Diagnostics.Process]::Start($psi) } finally { if ($null -ne $cie) { $cie.SetValue($null, $was) } }
    try {
      try { $p.StandardInput.BaseStream.Write($secret, 0, $secret.Length); $p.StandardInput.Close() } catch { }   # a refusing tool may have exited already
      $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
      if (-not $p.WaitForExit(30000)) { try { $p.Kill() } catch { }; throw 'SECRET_FINGERPRINT_TIMEOUT' }
      $text = $out.Result; [void]$err.Result
      if ($p.ExitCode -ne 0) { return $null }
      $v = $text | ConvertFrom-Json
      if ($v.kind -cne $kind -or $v.fingerprint -isnot [string]) { return $null }
      return $v.fingerprint
    } finally { $p.Dispose() }
  } finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
# One supplied secret file, read once: a regular file (no directory, no link), 1..$maximum bytes, unchanged while read.
function Read-SecretSource([string]$path, [int]$maximum, [string]$code) {
  $full = try { [IO.Path]::GetFullPath($path) } catch { throw ($code + '_SOURCE_REFUSED') }
  if ($full -cnotmatch '^[A-Za-z]:\\') { throw ($code + '_SOURCE_REFUSED') }
  $item = try { Get-Item -LiteralPath $full -Force -ErrorAction Stop } catch { throw ($code + '_SOURCE_REFUSED') }
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw ($code + '_SOURCE_REFUSED') }
  $s = [IO.File]::Open($full, 'Open', 'Read', 'Read')
  try {
    if ($s.Length -lt 1 -or $s.Length -gt $maximum) { throw ($code + '_SOURCE_REFUSED') }
    $bytes = New-Object byte[] ([int]$s.Length); $at = 0
    while ($at -lt $bytes.Length) { $n = $s.Read($bytes, $at, $bytes.Length - $at); if ($n -lt 1) { throw ($code + '_SOURCE_REFUSED') }; $at += $n }
    if ($s.ReadByte() -ne -1) { throw ($code + '_SOURCE_REFUSED') }
  } finally { $s.Dispose() }
  return ,$bytes
}
# The secrets part of the plan; verifies every supplied file against its pin. Nothing is written. The verified bytes wait in
# $script:SecretBytes (memory) for the 'node-secrets' step, so what is placed is exactly what was fingerprinted.
function Get-SecretsPlan {
  $out = [ordered]@{}
  foreach ($spec in @(@('appKey', $AppPrivateKeyFile, 'APP_KEY', 'app-key', $Identity.appPublicKeySha256Base64, 16384), @('ciToken', $CiAdmissionTokenFile, 'CI_TOKEN', 'ci-token', $Identity.ciTokenPinSha256, 4096))) {
    $name = $spec[0]; $source = $spec[1]; $prefix = $spec[2]; $target = $SecretTargets[$name]; $dir = Split-Path -Parent $target
    $dirExists = Test-Path -LiteralPath $dir -PathType Container
    $entry = [ordered]@{ target = $target; supplied = [bool]$source; targetExists = (Test-Path -LiteralPath $target); createsDirectory = $false; directorySddl = $null; pin = $spec[4]; verified = $false; sddl = (Get-SecretFileSddl $ControllerSid) }
    if ($name -ceq 'ciToken' -and (Get-Variable CarriedCiPlan -ValueOnly -ErrorAction SilentlyContinue) -and
        (-not $entry.targetExists -or -not $dirExists)) { throw 'CI_CONNECTION_TOKEN_TARGET_MISSING' }
    if ($source) {
      # The fingerprint check needs the admin-only work directory (owner Administrators), so it needs the elevated token, also in a dry run.
      if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED_FOR_SECRETS' }
      if ($entry.targetExists) { throw ($prefix + '_TARGET_EXISTS_NOT_OVERWRITTEN') }
      if ($dirExists -and (((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw ($prefix + '_TARGET_DIRECTORY_REFUSED') }
      if (-not $dirExists) {
        # Only the secrets folder of the CI install is made here (create-only, admin write, controller read); the controller's own
        # tree (CluedControl\trusted) belongs to the controller install and must already be there.
        if ($name -cne 'ciToken' -or -not (Test-Path -LiteralPath (Split-Path -Parent $dir) -PathType Container)) { throw ($prefix + '_TARGET_DIRECTORY_MISSING') }
        $entry.createsDirectory = $true; $entry.directorySddl = (Get-SecretDirectorySddl $ControllerSid)
      }
      $bytes = Read-SecretSource $source $spec[5] $prefix
      try {
        $fp = Get-SecretFingerprint $spec[3] $bytes
        if ($null -eq $fp) { throw ($prefix + '_UNREADABLE') }
        if ($fp -cne $spec[4]) { throw ($prefix + '_FINGERPRINT_MISMATCH') }
      } catch { [Array]::Clear($bytes, 0, $bytes.Length); Clear-SecretBytes; throw }
      $entry.verified = $true
      $script:SecretBytes[$name] = $bytes
    }
    $out[$name] = $entry
  }
  $out
}
function Read-InstallCiVerifyHelpers {
  $manifest = [Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json
  $b = Read-PackageRecordFile ('resident\' + $manifest.residentManifestSha256 + '\windows\verify-resident.ps1')
  $tk = $null; $er = $null
  $ast = [Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xfeff), [ref]$tk, [ref]$er)
  $want = @('Get-EffectiveCiPrincipal','Test-SecretFileSecurity','Test-SecretAclChain','Get-SecretPathState','Get-SecretFileState',
    'Read-CiPrivateBytes','Get-CiAdmissionTokenPin','Read-CiReinstallSnapshot','Confirm-CiReinstallServer','Read-CiReinstallProof')
  $defs = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $want -ccontains $n.Name }, $false))
  $admin = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$SecretAdmins' }, $false))
  if ($er.Count -or $defs.Count -ne $want.Length -or $admin.Count -ne 1) { throw 'VERIFY_CI_HELPERS_NOT_AS_REVIEWED' }
  foreach ($fn in @($admin) + @($defs)) { $fn.Extent.Text }
}
function Assert-ProtectedCiReinstall([switch]$Commit) {
  foreach ($source in Read-InstallCiVerifyHelpers) { . ([scriptblock]::Create($source)) }
  $proof = Read-CiReinstallProof $CiReinstallProof $CiRoot $CarriedCiPlan $ExpectedPackageManifestSha256
  if ($proof.newIdentitySha256 -cne $IdentitySha256) { throw 'CI_CONNECTION_CANDIDATE_IDENTITY_REFUSED' }
  $connection = $proof.connection
  $record = Read-CiReinstallSnapshot $CiRoot $ControllerSid $proof.oldIdentitySha256 $connection
  $installation = [Text.Encoding]::UTF8.GetString((Read-PackageRecordFile 'record\installation.json')) | ConvertFrom-Json
  $remote = Confirm-CiReinstallServer $CiRoot $ControllerSid $installation $connection $Identity.nodeName $record
  if ($remote.node_id -cne $proof.nodeId -or $remote.identity_fingerprint -cne $proof.identityFingerprint) { throw 'CI_CONNECTION_SERVER_NODE_CHANGED' }
  if (-not $Commit) { return }
  $newRecord = [ordered]@{}
  foreach ($entry in $record.record.PSObject.Properties) { $newRecord[$entry.Name] = $entry.Value }
  $newRecord['baseNodeIdentitySha256'] = $IdentitySha256
  $text = $newRecord | ConvertTo-Json -Compress
  if ((Sha256Text $text) -cne $proof.newRecordSha256) { throw 'CI_CONNECTION_PROOF_CHANGED' }
  $target = $record.file
  $dacl = (Get-Acl -LiteralPath $target).GetSecurityDescriptorSddlForm('Access')
  $temp = $target + '.reinstall-' + [Guid]::NewGuid().ToString('N')
  $wrote = $false
  try {
    Write-NewSecret $temp ([Text.Encoding]::UTF8.GetBytes($text)) ('O:BAG:BA' + $dacl)
    $wrote = $true
    # No old Broker or renew intent can still write here. Compare again just before ReplaceFile.
    $null = Read-CiReinstallSnapshot $CiRoot $ControllerSid $proof.oldIdentitySha256 $connection
    [IO.File]::Replace($temp, $target, $null, $false)
    $back = Read-CiReinstallSnapshot $CiRoot $ControllerSid $IdentitySha256 $connection -AfterReanchor
    if ($back.digest -cne $proof.newRecordSha256 -or (Get-Acl -LiteralPath $target).GetSecurityDescriptorSddlForm('Access') -cne $dacl) {
      throw 'CI_CONNECTION_INSTALL_READBACK_CHANGED'
    }
  } finally { if ($wrote -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
  [ordered]@{ previousRecordSha256 = $connection.recordSha256; recordSha256 = $proof.newRecordSha256; previousInstallReceiptSha256 = $connection.receiptSha256
    bindingId = $connection.bindingId; bindingGeneration = $connection.bindingGeneration; rebindReceiptId = $connection.rebindReceiptId }
}
function Clear-SecretBytes { foreach ($k in @($script:SecretBytes.Keys)) { [Array]::Clear($script:SecretBytes[$k], 0, $script:SecretBytes[$k].Length) }; $script:SecretBytes.Clear() }
# Create-only, with the final security descriptor from the first moment (no window with an inherited ACL), then read back.
function Write-NewSecret([string]$path, [byte[]]$bytes, [string]$sddl) {
  $sec = New-Object Security.AccessControl.FileSecurity
  $sec.SetSecurityDescriptorSddlForm($sddl)
  $f = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $sec)
  try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
  $back = Get-Acl -LiteralPath $path
  if ((Get-DaclPart $back.Sddl) -cne (Get-DaclPart $sec.GetSecurityDescriptorSddlForm('Access'))) { throw ('ACL_READBACK_MISMATCH:' + $path) }
  if ($sddl.StartsWith('O:BA', [StringComparison]::Ordinal) -and $back.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544') { throw ('ACL_READBACK_MISMATCH:' + $path) }
  if (-not (Test-BytesEqualClear ([IO.File]::ReadAllBytes($path)) $bytes)) { throw ('SECRET_WRITE_READBACK_MISMATCH:' + $path) }
}
# Compares a secret read back from disk with the expected bytes, then zeroes the read-back copy (the caller keeps no reference to it).
function Test-BytesEqualClear([byte[]]$copy, [byte[]]$expected) {
  try { return ((Sha256Bytes $copy) -ceq (Sha256Bytes $expected)) } finally { [Array]::Clear($copy, 0, $copy.Length) }
}

# Review r1 m6: the members of a local group as SIDs, read through ADSI (WinNT provider) member by member; Get-LocalGroupMember throws on
# an orphaned or Entra ID member. $null when the group or any member cannot be read (the callers refuse, never guess).
# Shared with install-resident.ps1 and verify-resident.ps1 (test-companion-headless.ps1 holds the copies identical).
function Get-GroupMemberSids([string]$groupSid) {
  try {
    $name = (New-Object Security.Principal.SecurityIdentifier($groupSid)).Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    $group = [ADSI]('WinNT://' + [Environment]::MachineName + '/' + $name + ',group')
    $out = New-Object Collections.ArrayList
    foreach ($m in @($group.psbase.Invoke('Members'))) {
      $bytes = $m.GetType().InvokeMember('objectSid', 'GetProperty', $null, $m, $null)
      [void]$out.Add((New-Object Security.Principal.SecurityIdentifier([byte[]]$bytes, 0)).Value)
    }
    ,([string[]]$out.ToArray())
  } catch { $null }
}
function Get-AdministratorSids { Get-GroupMemberSids 'S-1-5-32-544' }
function Assert-Owner {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $operator = if ((Test-Path variable:OperatorSid) -and $OperatorSid) { $OperatorSid } else { $OwnerSid }
  if ($id.User.Value -cne $operator) { throw 'OWNER_ACCOUNT_REQUIRED' }
  if ([Environment]::MachineName -cne $Node.hostname) { throw 'NODE_HOST_REQUIRED' }
  # M5-b (ADR 0023): the companion's account is a local account of this host and not an administrator (the switch's registrar checks
  # groups too, indirect ones included); the operator is not the controller.
  if ($operator -cne $OwnerSid) {
    if ($operator -ceq $ControllerSid) { throw 'OPERATOR_IS_THE_CONTROLLER' }
    Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts'
    $acct = try { Get-LocalUser -SID $OwnerSid -ErrorAction Stop } catch { $null }
    if ($null -eq $acct) { throw 'COMPANION_ACCOUNT_NOT_LOCAL' }
    $admins = Get-AdministratorSids
    if ($null -eq $admins) { throw 'ADMINISTRATORS_UNREADABLE' }
    if (@($admins) -ccontains $OwnerSid) { throw 'COMPANION_ACCOUNT_IS_ADMINISTRATOR' }
  }
  if ($OwnerSid -cne $Node.ownerSid -or $ControllerSid -cne $Node.controllerSid) { throw 'NODE_PROFILE_ACCOUNTS_MISMATCH' }
  # The ACL plan grants the record, source, stage and work directories to this SID and every runtime reader trusts the
  # record's value, so it must be the real local .\clued-control of this host, not only the value the profile names.
  $controllerActual = try { (New-Object Security.Principal.NTAccount([Environment]::MachineName, 'clued-control')).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $null }
  if ($controllerActual -cne $Node.controllerSid) { throw 'NODE_CONTROLLER_ACCOUNT_MISMATCH' }
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
  [ordered]@{ binary = $bin; originalBinary = ($bin -ceq $OriginalBinary); account = $acct; accountIsController = ($acct -match ('^(\.|' + [regex]::Escape($Node.hostname) + ')\\clued-control$'))
    stoppedPid0 = ($q -match 'STATE\s*:\s*1\s' -and $q -match 'PID\s*:\s*0\b'); manual = ($qc -match 'START_TYPE\s*:\s*3\s'); sddl = (Get-DaclPart (& $Sc sdshow $RunnerService | Out-String)) }
}

# The controller account runs the node's runner service (swapped and started by the broker for every stage): it needs the right to
# log on as a service, granted directly or through a local group (DESK-W-591, 2026-10-30: SCM 7041, then the role probe HALTed with
# ROLE_PROBE_CLEANUP_OR_FACT_UNCONFIRMED). SeDenyServiceLogonRight overrides it (review 2). $inf: `secedit /export /areas USER_RIGHTS`;
# $groupMembers: group SID -> member SIDs. secedit writes a local account or group by name (TURING, 2026-10-31:
# `SeServiceLogonRight = clued-runner,clued-control,*S-1-5-80-0,*S-1-5-83-0`); $nameSids: name -> SID, $null when it did not
# resolve. An unresolved name never grants the right, and in the deny line it counts as a deny (fail closed).
function Test-ServiceLogonRight([string]$inf, [string]$sid, $groupMembers, $nameSids) {
  $holds = {
    param([string]$right, [bool]$unresolvedHolds)
    foreach ($line in ($inf -split "`r?`n")) {
      if ($line -notmatch ('^\s*' + $right + '\s*=\s*(.*)$')) { continue }
      foreach ($entry in @($Matches[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        $entrySid = if ($entry.StartsWith('*')) { $entry.Substring(1) } elseif ($null -ne $nameSids -and $nameSids.ContainsKey($entry)) { $nameSids[$entry] } else { $null }
        if ($null -eq $entrySid) { if ($unresolvedHolds) { return $true } else { continue } }
        if ($entrySid -ceq $sid) { return $true }
        if ($null -ne $groupMembers -and $groupMembers.ContainsKey($entrySid) -and @($groupMembers[$entrySid]) -ccontains $sid) { return $true }
      }
    }
    $false
  }
  (& $holds 'SeServiceLogonRight' $false) -and -not (& $holds 'SeDenyServiceLogonRight' $true)
}
# Elevated only (secedit needs it): the user-rights assignment and the members of every local group it names; $null when unreadable.
# The export goes to a new directory that only SYSTEM and Administrators can touch (review 2: not one the Owner's medium-integrity
# processes could swap or rewrite).
function Read-ServiceLogonRight([string]$sid) {
  $dir = Join-Path 'C:\Windows\Temp' ('clued-rights-' + [Guid]::NewGuid().ToString('N'))
  try {
    $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    [void][IO.Directory]::CreateDirectory($dir, $ds)
    $cfg = Join-Path $dir 'rights.inf'
    $null = & 'C:\Windows\System32\SecEdit.exe' /export /areas USER_RIGHTS /cfg $cfg /quiet
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $cfg -PathType Leaf)) { return $null }
    $inf = [IO.File]::ReadAllText($cfg)
    $groups = @{}; $names = @{}
    foreach ($line in ($inf -split "`r?`n")) {
      if ($line -notmatch '^\s*Se(?:Deny)?ServiceLogonRight\s*=\s*(.*)$') { continue }
      foreach ($e in @($Matches[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        $s = if ($e.StartsWith('*')) { $e.Substring(1) } else {
          $names[$e] = try { (New-Object Security.Principal.NTAccount($e)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $null }
          $names[$e]
        }
        if ($s -cmatch '^S-1-5-32-\d+$|^S-1-5-21-[\d-]+$' -and -not $groups.ContainsKey($s)) {
          $members = Get-GroupMemberSids $s; $groups[$s] = $(if ($null -eq $members) { @() } else { @($members) })
        }
      }
    }
    Test-ServiceLogonRight $inf $sid $groups $names
  } catch { $null } finally { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

# Directory ACLs (owner BUILTIN\Administrators, protected DACL). Masks: 0x1200a9 read+execute,
# 0x1301bf modify, 0x1000a2 add-file+traverse (drop box), FA full. To be validated on a test host.
function Get-AclPlan([string]$res) {
  $base = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
  $rx = '0x1200a9'; $mod = '0x1301bf'; $drop = '0x1000a2'
  # M5-b (ADR 0023): $op reads where the companion's account reads ($OwnerSid); the Owner's own requests ($drop, train-review) are his.
  # Without a companion account $op is empty and every rule is the one before M5-b.
  # (Read through Test-Path: the offline tests load this function alone, where -OperatorSid does not exist.)
  $operator = if ((Test-Path variable:OperatorSid) -and $OperatorSid) { $OperatorSid } else { $OwnerSid }
  $op = if ($operator -cne $OwnerSid) { "(A;OICI;$rx;;;$operator)" } else { '' }
  $opDrop = if ($operator -cne $OwnerSid) { "(A;;$drop;;;$operator)(A;OIIO;0x120089;;;$operator)" } else { '' }
  [ordered]@{
    # The generic helper (as clued-control) opens every parent of its inputs with READ_CONTROL before it reads
    # them (FormalPublicBoundaryV2.Parents); this folder only, no inheritance, no access to any content.
    ''                  = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)(A;;0x120080;;;$ControllerSid)$op"
    'bin'               = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'config'            = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'install'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"                 # install records: only admins write
    'owner'             = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"                 # Owner requests: only the elevated Owner (BA) creates
    # DESIGN.md section 41.7/41.9 step 3: the Owner's train-shadow review mark (rearm-tool mark-train-shadow-reviewed). Stage 10 prunes
    # train-shadow only after it (Source v2 state-retention.mjs, as clued-control), so clued-control reads this folder, and only this one.
    # Accepted residual (review R3 MINOR 7): unlike owner\, the unelevated Owner may write here, so any process of the Owner's session
    # (an Agent too) could write the mark; the worst it does is start the 90-day pruning of train-shadow records early (none is older
    # than 90 days at step 9), never a green, a revocation or a batch.
    'owner\train-review' = "$base(A;OICI;$rx;;;$res)(A;OICI;$mod;;;$operator)(A;OICI;$rx;;;$ControllerSid)"   # M5-b: the Owner's mark, not the companion's
    'source'            = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)(A;OICI;$rx;;;$ControllerSid)$op"
    'helpers'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$ControllerSid)"           # the installed generic helper (broker config pin)
    'record'            = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$ControllerSid)(A;OICI;$rx;;;$OwnerSid)$op"   # claim-free install record: only admins write
    'stage'             = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$ControllerSid)"           # sealed per-stage inputs (resident writes, helper reads)
    'bundles'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$mod;;;$OwnerSid)$op"               # companion bundles (Owner's git credential), read by ws-prep
    'resident'          = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'runtime'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)(A;OICI;$rx;;;$ControllerSid)$op"   # the generic helper (clued-control) runs this node (FormalPublicBoundaryV2.Node)
    'state'             = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'work'              = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$ControllerSid)(A;OICI;$rx;;;$OwnerSid)$op"
    'outbox'            = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'broker'            = "$base(A;OICI;$rx;;;$res)"
    # Review MINOR-2: the resident may only add request files (list, add-file, traverse, read), never delete or
    # rename anything here; files are read-only for it, and OWNER RIGHTS (OW) removes the creator's implicit
    # WRITE_DAC, so a request can not be rewritten after the broker may have read it.
    'broker\requests'   = "$base(A;;0x1200a3;;;$res)(A;OIIO;0x120089;;;$res)(A;OIIO;0x120089;;;OW)"
    'broker\responses'  = "$base(A;OICI;$rx;;;$res)"
    # Review MINOR-9: create-only for the Owner. The folder ACE allows adding a file (the creating handle keeps
    # the access it asked for); existing files are read-only for the Owner, and OW removes the owner's implicit
    # WRITE_DAC, so a trigger or request cannot be rewritten after the resident read it.
    'inbox'             = "$base(A;OICI;$mod;;;$res)(A;;$drop;;;$OwnerSid)(A;OIIO;0x120089;;;$OwnerSid)(A;OIIO;0x120089;;;OW)$opDrop"
    'requests'          = "$base(A;OICI;$mod;;;$res)(A;;$drop;;;$OwnerSid)(A;OIIO;0x120089;;;$OwnerSid)(A;OIIO;0x120089;;;OW)$opDrop"
    'mailbox'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'mailbox\requests'  = "$base(A;OICI;$mod;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'mailbox\responses' = "$base(A;OICI;$rx;;;$res)(A;OICI;$mod;;;$OwnerSid)$op"            # responses + companion heartbeat
    # ---- The in-place upgrade channel (018da927, A6). CluedCIUpgrader runs as LocalSystem: SY full (base) is its only write. ----
    'upgrader'                  = "$base"                                                 # its code, node, host and config: SYSTEM and Administrators only
    'secrets'                   = "$base"                                                 # resident-upgrade.token: SYSTEM and Administrators only
    'upgrade'                   = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"      # current.json, status.json, ops, staged (the Owner's WSL reads staged)
    'upgrade\inbox'             = "$base(A;;$drop;;;$operator)(A;OIIO;0x120089;;;$operator)(A;OIIO;0x120089;;;OW)"   # the 'inbox' rule: Owner create-only
    'upgrade\mailbox'           = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"
    'upgrade\mailbox\requests'  = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"      # the upgrader writes, the companion reads
    'upgrade\mailbox\responses' = "$base(A;OICI;$rx;;;$res)(A;OICI;$mod;;;$OwnerSid)$op"     # the companion answers (and version-facts.json)
    'generations'               = "$base(A;OICI;$rx;;;$res)(A;OICI;$rx;;;$OwnerSid)$op"      # as config
    'archive'                   = "$base(A;OICI;$rx;;;$OwnerSid)$op"
  }
}

# ---- M5-b (ADR 0023): the companion's own account ----
$CompanionAccountFile = 'install\companion-account.json'
$CompanionAccountContract = 'clued.independent-ci.companion-account/1'
# The formal spool's folders (under $CiRoot, made by the one-shot install, outside $Root) the companion relays through.
$CompanionSpoolFolders = @('formal-spool\incoming', 'formal-spool\outgoing')
# Pure: the DACL of one spool folder with the companion's account in the operator's place. Source v2 lets only the node profile's
# ownerSid write formal-spool\incoming (FormalPublicBoundaryV2.WriterAllowed; any other writer is refused), and that is now the account:
# so every explicit allow entry of the operator that can change something moves to the account; one that only reads stays and the account
# gets the same. Inherited entries, other SIDs and the order of the rest are kept; an account entry already there is not added twice.
function Get-CompanionSpoolSddl([string]$sddl, [string]$operator, [string]$account) {
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  $acl = $raw.DiscretionaryAcl
  $have = @{}
  foreach ($a in $acl) { if ($a -is [Security.AccessControl.CommonAce] -and $a.SecurityIdentifier.Value -ceq $account) { $have[[string]$a.AceFlags + '|' + $a.AccessMask] = $true } }
  $add = @()
  for ($i = $acl.Count - 1; $i -ge 0; $i--) {
    $a = $acl[$i]
    if (-not ($a -is [Security.AccessControl.CommonAce]) -or $a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $a.IsInherited -or $a.SecurityIdentifier.Value -cne $operator) { continue }
    if (($a.AccessMask -band $write) -ne 0) { $acl.RemoveAce($i) }
    if (-not $have.ContainsKey([string]$a.AceFlags + '|' + $a.AccessMask)) { $add += ,@($a.AceFlags, $a.AccessMask) }
  }
  $at = 0; while ($at -lt $acl.Count -and -not $acl[$at].IsInherited) { $at++ }   # after the explicit entries, before the inherited ones
  foreach ($x in $add) { $acl.InsertAce($at, (New-Object Security.AccessControl.CommonAce($x[0], [Security.AccessControl.AceQualifier]::AccessAllowed, $x[1], (New-Object Security.Principal.SecurityIdentifier($account)), $false, $null))); $at++ }
  $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
}
function Set-CompanionSpoolAcl([string]$path, [string]$operator, [string]$account) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('COMPANION_SPOOL_FOLDER_REFUSED:' + $path) }
  $before = (Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $want = Get-CompanionSpoolSddl $before $operator $account
  if ($want -ceq $before) { return }
  $sec = New-Object Security.AccessControl.DirectorySecurity
  $sec.SetSecurityDescriptorSddlForm($want, [Security.AccessControl.AccessControlSections]::Access)
  $item.SetAccessControl($sec)
  $back = (Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  if ((Get-CompanionSpoolSddl $back $operator $account) -cne $back) { throw ('COMPANION_SPOOL_ACL_READBACK_MISMATCH:' + $path) }
}
# One program run as LocalSystem through a one-shot task (SYSTEM, highest; no password), its stdout into a new folder that only SYSTEM
# and Administrators can touch; the task and the folder are removed. Returns exit (the task's last result) and stdout.
function Invoke-AsSystemOnce([string]$exe, [string[]]$arguments) {
  $dir = Join-Path 'C:\Windows\Temp' ('clued-system-' + [Guid]::NewGuid().ToString('N'))
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($dir, $ds)
  $name = 'CluedCIInstallSystemOnce-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
  $t = $null
  $svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
  $folder = $svc.GetFolder('\')
  try {
    $out = Join-Path $dir 'stdout.txt'
    $def = $svc.NewTask(0)
    $def.Principal.UserId = 'S-1-5-18'; $def.Principal.LogonType = 5; $def.Principal.RunLevel = 1
    $def.Settings.ExecutionTimeLimit = 'PT5M'; $def.Settings.DisallowStartIfOnBatteries = $false; $def.Settings.StopIfGoingOnBatteries = $false
    $a = $def.Actions.Create(0); $a.Path = 'C:\Windows\System32\cmd.exe'
    $a.Arguments = '/d /c ""' + $exe + '" ' + ((@($arguments) | ForEach-Object { '"' + $_ + '"' }) -join ' ') + ' > "' + $out + '""'
    $t = $folder.RegisterTaskDefinition($name, $def, 6, $null, $null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)')
    $before = $t.LastRunTime
    $null = $t.Run($null)
    $until = [DateTime]::UtcNow.AddMinutes(5)
    do { Start-Sleep -Milliseconds 500; $t = $folder.GetTask($name) } while ([DateTime]::UtcNow -lt $until -and ([int]$t.State -eq 4 -or $t.LastRunTime -eq $before))
    # Review r1 m9: still running after 5 minutes: its instance is stopped before the task is deleted, and the install stops here.
    if ([int]$t.State -eq 4 -or $t.LastRunTime -eq $before) { try { $t.Stop(0) } catch { }; throw 'INSTALL_SYSTEM_ONCE_TIMEOUT' }
    [ordered]@{ exit = ([int64]$t.LastTaskResult -band 0xFFFFFFFFL); stdout = $(if (Test-Path -LiteralPath $out -PathType Leaf) { [IO.File]::ReadAllText($out) } else { '' }) }
  } finally {
    if ($null -ne $t -and [int]$t.State -eq 4) { try { $t.Stop(0) } catch { } }
    try { $folder.DeleteTask($name, 0) } catch { }; Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ---- The CI root's READ_CONTROL entry for the resident service (DESIGN.md section 33, first HALT of 2026-10-29) ----
# The resident service runs the Windows spool archive (resident-v2/archive-windows-spool.ps1), which loads the node profile through
# NodeProfileV2.LoadProtectedProfile: that opens EVERY ancestor directory of the profile with CreateFileW access 0x20080
# (READ_CONTROL | FILE_READ_ATTRIBUTES), C:\ProgramData\CluedIndependentCI included. The v1 one-shot install gave that folder to SYSTEM,
# Administrators, clued-control and (by hand, DESIGN.md section 8.3) the Owner, and nothing to the service SID, so the archive refused and
# the first batch close HALTed. The service gets exactly the Owner's entry: 0x120080 on this folder only (no inheritance), no data
# right and no write right. It is the one ACE this script appends to an existing directory; the plan shows the DACL it expects, the
# step refuses if the DACL changed since the plan, and the result is read back with every earlier ACE kept.
# Shared pure rule with install-resident.ps1; tests require identical function text.
function Get-RelayParentAclPresence([string]$sddl, [string]$sid) {
  try { $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl) } catch { return 'refused' }
  if ($null -eq $raw.DiscretionaryAcl -or ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { return 'refused' }
  foreach ($a in $raw.DiscretionaryAcl) {
    if ($a -isnot [Security.AccessControl.CommonAce] -or $a.IsCallback) { return 'refused' }
    if (([int]$a.AceFlags -band 8) -eq 0 -and
        $a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied -and ($a.AccessMask -band (0x120080 -bor 0x80000000 -bor 0x10000000)) -ne 0) { return 'refused' }
  }
  $mine = @(foreach ($a in $raw.DiscretionaryAcl) { if ($a.SecurityIdentifier.Value -ceq $sid) { $a } })
  if ($mine.Count -eq 0) { return 'missing' }
  if ($mine.Count -ne 1 -or $mine[0] -isnot [Security.AccessControl.CommonAce] -or $mine[0].IsCallback -or
      $mine[0].AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $mine[0].AccessMask -ne 0x120080 -or [int]$mine[0].AceFlags -ne 0) { return 'refused' }
  'present'
}
function Get-ParentAce([string]$res) { '(A;;0x120080;;;' + $res + ')' }
function Get-AceKeys([string]$sddl) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  @(foreach ($a in $raw.DiscretionaryAcl) { if ($a -is [Security.AccessControl.CommonAce]) { $a.SecurityIdentifier.Value + '|' + [string]$a.AccessMask + '|' + [int]$a.AceFlags + '|' + [string]$a.AceQualifier } else { 'other|' + $a.GetType().Name } })
}
# The DACL's shape, what the two compare-before-write checks compare (Fable ruling 0e418483): the protected bit and the set of every ACE
# in its binary form (type, flags, mask, SID, all of it), sorted ordinally. Not the SDDL text: Windows writes a DACL back with AI set, its
# ACEs reordered and its masks spelled its own way (FA or 0x1f01ff), none of which changes what the DACL grants. A null DACL is refused.
function Get-DaclShape([string]$sddl) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'DACL_SHAPE_NULL_DACL' }
  $aces = New-Object 'Collections.Generic.List[string]'
  foreach ($a in $raw.DiscretionaryAcl) { $b = New-Object byte[] $a.BinaryLength; $a.GetBinaryForm($b, 0); $aces.Add([BitConverter]::ToString($b).Replace('-', '')) }
  $aces.Sort([StringComparer]::Ordinal)
  $(if (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) { 'P' } else { '-' }) + '|' + ($aces -join '|')
}
# The state of the folder for the service SID: refuses a missing or linked folder, a DACL that is not protected, and any ACE of the
# service SID that is not exactly the planned one. present: that ACE is already there (an earlier install or the Owner's own icacls).
function Get-ParentAclState([string]$path, [string]$res) {
  $item = try { Get-Item -LiteralPath $path -Force -ErrorAction Stop } catch { $null }
  if ($null -eq $item) { throw 'PARENT_ACL_TARGET_MISSING' }
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'PARENT_ACL_TARGET_REFUSED' }
  $sddl = try { (Get-Acl -LiteralPath $path).Sddl } catch { $null }
  if ([string]::IsNullOrEmpty($sddl)) { throw 'PARENT_ACL_UNREADABLE' }   # READ_CONTROL on this folder is the Owner's own entry (DESIGN.md section 8.3)
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  if (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { throw 'PARENT_ACL_NOT_PROTECTED' }
  $mine = @(foreach ($a in $raw.DiscretionaryAcl) { if ($a.SecurityIdentifier.Value -ceq $res) { $a } })
  $present = $false
  if ($mine.Count -gt 0) {
    $exact = $mine.Count -eq 1 -and $mine[0] -is [Security.AccessControl.CommonAce] -and $mine[0].AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $mine[0].AccessMask -eq 0x120080 -and [int]$mine[0].AceFlags -eq 0
    if (-not $exact) { throw 'PARENT_ACL_HAS_OTHER_RESIDENT_ACES' }
    $present = $true
  }
  [ordered]@{ path = $path; sid = $res; ace = (Get-ParentAce $res); mask = '0x120080'; inheritance = 'none (this folder only)'; present = $present; before = (Get-DaclPart $sddl) }
}
# Appends the ACE (nothing else is written: no owner, group or SACL section), then reads the folder back: the ACE is there and every
# earlier ACE is kept. A no-op ($false) when the exact ACE is already there.
function Add-ParentAce($p) {
  if ($p.present -eq $true) { return $false }
  $now = (Get-Acl -LiteralPath $p.path).Sddl
  if ((Get-DaclShape $now) -cne (Get-DaclShape $p.before)) { throw 'PARENT_ACL_CHANGED_SINCE_PLAN' }
  $oldKeys = @(Get-AceKeys $now)
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm($now + $p.ace, [Security.AccessControl.AccessControlSections]::Access)
  [IO.Directory]::SetAccessControl($p.path, $acl)
  $back = Get-ParentAclState $p.path $p.sid
  $newKeys = @(Get-AceKeys (Get-Acl -LiteralPath $p.path).Sddl)
  if (-not $back.present -or $newKeys.Count -ne $oldKeys.Count + 1 -or @($oldKeys | Where-Object { $newKeys -cnotcontains $_ }).Count -ne 0) { throw ('PARENT_ACL_READBACK_MISMATCH:' + $p.path) }
  return $true
}

# The existing service append stays unchanged; this wrapper binds the companion's stricter rule and the complete expected DACL.
function Assert-CompanionRelayParentPlan($p) {
  $now = Get-ParentAclState $p.path $p.sid
  if ((Get-DaclShape $now.before) -cne (Get-DaclShape $p.before) -or (Get-RelayParentAclPresence ((Get-Acl -LiteralPath $p.path).Sddl) $p.sid) -ceq 'refused') { throw 'COMPANION_RELAY_PARENT_CHANGED_SINCE_PLAN' }
}
function Add-CompanionRelayParentAce($p) {
  Assert-CompanionRelayParentPlan $p
  $wrote = Add-ParentAce $p
  if ((Get-RelayParentAclPresence ((Get-Acl -LiteralPath $p.path).Sddl) $p.sid) -cne 'present') { throw 'COMPANION_RELAY_PARENT_READBACK_REFUSED' }
  $wrote
}
function Get-CompanionRelayParentsPlan($residentParent) {
  $parents = @()
  foreach ($parent in @($CiRoot, (Join-Path $CiRoot 'formal-spool'))) {
    $entry = Get-ParentAclState $parent $OwnerSid
    if ((Get-RelayParentAclPresence ((Get-Acl -LiteralPath $parent).Sddl) $OwnerSid) -ceq 'refused') { throw 'COMPANION_RELAY_PARENT_ACL_REFUSED' }
    if ($parent -ceq $CiRoot -and -not $residentParent.present) {
      $projected = New-Object Security.AccessControl.RawSecurityDescriptor($entry.before + $residentParent.ace)
      $entry.before = $projected.GetSddlForm([Security.AccessControl.AccessControlSections]::Access)
    }
    $parents += ,$entry
  }
  return ,$parents
}

# ---- <CiRoot>\state, the parent of Source v2's state\v2 (Fable ruling 0e418483 r13, option wu; DESIGN.md section 8) ----
# The generic helper opens state (FormalPublicBoundaryV2.Parents of StateV2) and refuses any "allow, not inherit-only" ACE on it that can
# write, delete, delete a child, change permissions or take ownership, of anyone but SYSTEM, Administrators and TrustedInstaller
# (DangerFor and WriterAllowed: clued-control may write only below state\v2). When this install did not make state, migrate-acl.ps1's
# CreateDirectory(state\v2) did, and Windows PowerShell 5.1 gives that intermediate folder the same DACL, the controller's modify entry
# included: the r13 HALT. So this rule owns state's DACL: the install's step state-parent-acl (before source-v2-acl) and
# verify-resident.ps1 run as SYSTEM by an upgrade (Invoke-StateParentEnsure, these functions by name) run it; nothing else makes state.
#   missing                         -> made with Get-StateParentSddl (the production DACL, TURING 2026-10-21)
#   passes the helper's rule        -> nothing written
#   only the controller fails it    -> its failing entries of state itself become inherit-only (what the children inherit is unchanged;
#                                      one that is not inheritable is dropped) and it gets (A;;0x1200a9;;;CTRL) on state itself
#   anyone else fails it            -> STATE_PARENT_ACL_REFUSED:<why> (nothing is guessed, nothing written)
function Get-StateParentSddl([string]$controllerSid) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;0x1301bf;;;' + $controllerSid + ')(A;;0x1200a9;;;' + $controllerSid + ')' }
# Pure: what the rule does to a DACL (SDDL): [ordered]@{ action = 'none'|'converge'; sddl = the DACL wanted (Access section) }, or throws.
# Danger: DangerFor's rights under the CI root (0xD0156) and GENERIC_ALL, GENERIC_WRITE (0x50000000), as verify-resident.ps1 reads them.
function Get-StateParentTarget([string]$sddl, [string]$controllerSid) {
  $danger = 0x500D0156
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  $acl = $raw.DiscretionaryAcl
  if ($null -eq $acl) { throw 'STATE_PARENT_ACL_REFUSED:NULL_DACL' }
  $fix = @()
  for ($i = 0; $i -lt $acl.Count; $i++) {
    $a = $acl[$i]
    if ($a -isnot [Security.AccessControl.CommonAce]) { if ($a.AceType -match 'Allowed') { throw 'STATE_PARENT_ACL_REFUSED:OTHER_ACE_TYPE' }; continue }
    if ($a.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$a.AceFlags -band 8) -ne 0) { continue }   # 8: INHERIT_ONLY
    if (([int64]$a.AccessMask -band $danger) -eq 0 -or $trusted -ccontains $a.SecurityIdentifier.Value) { continue }
    if ($a.SecurityIdentifier.Value -cne $controllerSid) { throw ('STATE_PARENT_ACL_REFUSED:OTHER_WRITER:' + $a.SecurityIdentifier.Value) }
    if ($a.IsInherited) { throw 'STATE_PARENT_ACL_REFUSED:INHERITED_CONTROLLER_WRITE' }
    $fix += $i
  }
  if ($fix.Count -eq 0) { return [ordered]@{ action = 'none'; sddl = $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access) } }
  $sid = New-Object Security.Principal.SecurityIdentifier($controllerSid)
  [array]::Reverse($fix)
  foreach ($i in $fix) {
    $a = $acl[$i]; $acl.RemoveAce($i)
    if (([int]$a.AceFlags -band 3) -ne 0) {   # 3: OBJECT_INHERIT, CONTAINER_INHERIT
      $acl.InsertAce($i, (New-Object Security.AccessControl.CommonAce(([Security.AccessControl.AceFlags][byte]([int]$a.AceFlags -bor 8)), [Security.AccessControl.AceQualifier]::AccessAllowed, $a.AccessMask, $sid, $false, $null)))
    }
  }
  $read = $false
  foreach ($a in $acl) { if ($a -is [Security.AccessControl.CommonAce] -and -not $a.IsInherited -and [int]$a.AceFlags -eq 0 -and $a.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $a.SecurityIdentifier.Value -ceq $controllerSid -and [int64]$a.AccessMask -eq 0x1200a9) { $read = $true } }
  if (-not $read) {
    $at = 0; while ($at -lt $acl.Count -and -not $acl[$at].IsInherited) { $at++ }   # after the explicit entries, before the inherited ones
    $acl.InsertAce($at, (New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, 0x1200a9, $sid, $false, $null)))
  }
  [ordered]@{ action = 'converge'; sddl = $raw.GetSddlForm([Security.AccessControl.AccessControlSections]::Access) }
}
# The folder as it is now and what the rule will do: [ordered]@{ path; action = 'create'|'none'|'converge'; before (null when missing); sddl }.
function Get-StateParentState([string]$path, [string]$controllerSid) {
  if (-not [IO.Directory]::Exists($path)) {
    if ([IO.File]::Exists($path)) { throw 'STATE_PARENT_ACL_REFUSED:NOT_A_DIRECTORY' }
    if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($path))) { throw 'STATE_PARENT_ACL_REFUSED:CI_ROOT_MISSING' }
    return [ordered]@{ path = $path; action = 'create'; before = $null; sddl = (Get-StateParentSddl $controllerSid) }
  }
  if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'STATE_PARENT_ACL_REFUSED:LINK' }
  $before = (Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $t = Get-StateParentTarget $before $controllerSid
  [ordered]@{ path = $path; action = $t.action; before = $before; sddl = $t.sddl }
}
# Writes what Get-StateParentState planned: compared before the write (the DACL's shape, or still missing), read back after it (the planned
# shape, and the rule finds nothing more to do). Only the DACL is written to an existing folder. Returns path, action, before, after, wrote.
function Invoke-StateParentAcl($p, [string]$controllerSid) {
  if ($p.action -ceq 'none') { return [ordered]@{ path = $p.path; action = 'none'; before = $p.before; after = $p.before; wrote = $false } }
  $ds = New-Object Security.AccessControl.DirectorySecurity
  if ($p.action -ceq 'create') {
    if ([IO.Directory]::Exists($p.path) -or [IO.File]::Exists($p.path)) { throw 'STATE_PARENT_ACL_CHANGED_SINCE_PLAN' }
    $ds.SetSecurityDescriptorSddlForm($p.sddl)
    [void][IO.Directory]::CreateDirectory($p.path, $ds)
  } elseif ($p.action -ceq 'converge') {
    $now = (Get-Acl -LiteralPath $p.path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ((Get-DaclShape $now) -cne (Get-DaclShape $p.before)) { throw 'STATE_PARENT_ACL_CHANGED_SINCE_PLAN' }
    $ds.SetSecurityDescriptorSddlForm($p.sddl, [Security.AccessControl.AccessControlSections]::Access)
    [IO.Directory]::SetAccessControl($p.path, $ds)
  } else { throw 'STATE_PARENT_ACL_REFUSED:PLAN' }
  $after = (Get-Acl -LiteralPath $p.path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  if ((Get-DaclShape $after) -cne (Get-DaclShape $p.sddl) -or (Get-StateParentTarget $after $controllerSid).action -cne 'none') { throw ('STATE_PARENT_ACL_READBACK_MISMATCH:' + $p.path) }
  [ordered]@{ path = $p.path; action = $p.action; before = $p.before; after = $after; wrote = $true }
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
$Node = Get-PackageNodeProfile
$NodeCanonical = ConvertTo-NodeProfileCanonical $Node
$NodeProfileSha256 = Sha256Text $NodeCanonical
$RunnerService = $Node.runnerService
$Identity = Get-PackageNodeIdentity
$IdentitySha256 = Sha256Text (ConvertTo-NodeIdentityCanonical $Identity)
function Get-OpenBatchCount {
  $ledger = Join-Path $Root 'state\ledger'
  if (-not (Test-Path -LiteralPath $ledger)) { return 0 }
  return @(Get-ChildItem -LiteralPath $ledger -Directory | Where-Object { -not (Test-Path -LiteralPath (Join-Path $_.FullName '90-terminal.json')) }).Count
}

# ---- The upgrader and its token (018da927) ----
function Get-JsonField($o, [string]$k) { if (($o -is [pscustomobject]) -and (@($o.PSObject.Properties.Name) -ccontains $k)) { $o.$k } else { $null } }
# The resident-upgrade token: optional; read once, fingerprinted like the ci-admission token (the same binding-token formula), and it must
# NOT be the ci-admission token (each node has its own resident-upgrade connection). The bytes wait in $script:SecretBytes.
function Get-UpgradeTokenPlan {
  $entry = [ordered]@{ target = $UpgradeTokenTarget; supplied = [bool]$UpgradeTokenFile; targetExists = (Test-Path -LiteralPath $UpgradeTokenTarget); sddl = $UpgradeTokenSddl; fingerprint = $null; verified = $false }
  if ($UpgradeTokenFile) {
    if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED_FOR_SECRETS' }
    $bytes = Read-SecretSource $UpgradeTokenFile 4096 'UPGRADE_TOKEN'
    try {
      $fp = Get-SecretFingerprint 'ci-token' $bytes
      if ($null -eq $fp) { throw 'UPGRADE_TOKEN_UNREADABLE' }
      if ($fp -ceq $Identity.ciTokenPinSha256) { throw 'UPGRADE_TOKEN_IS_THE_CI_ADMISSION_TOKEN' }
    } catch { [Array]::Clear($bytes, 0, $bytes.Length); Clear-SecretBytes; throw }
    $entry.fingerprint = $fp; $entry.verified = $true
    $script:SecretBytes['upgradeToken'] = $bytes
  }
  $entry
}
# The node heartbeat token (DESIGN.md section 41.6a): optional; read once, fingerprinted like the ci-admission token, and it must be
# neither the ci-admission token nor the resident-upgrade token (each is its own connection). The bytes wait in $script:SecretBytes.
# -HeartbeatBindingId only with -HeartbeatTokenFile (informational: recorded, never sent anywhere).
function Get-HeartbeatTokenPlan([switch]$PreviewAfterUninstall) {
  if ($PreviewAfterUninstall -and ($HeartbeatTokenFile -or $HeartbeatBindingId)) { Clear-SecretBytes; throw 'AFTER_UNINSTALL_PREVIEW_READ_ONLY_WITHOUT_HEARTBEAT_INPUT' }
  if ($HeartbeatBindingId -and -not $HeartbeatTokenFile) { Clear-SecretBytes; throw 'HEARTBEAT_BINDING_ID_REQUIRES_HEARTBEAT_TOKEN_FILE' }
  $entry = [ordered]@{ target = $HeartbeatTokenTarget; supplied = [bool]$HeartbeatTokenFile; targetExists = (-not $PreviewAfterUninstall -and (Test-Path -LiteralPath $HeartbeatTokenTarget))
    directory = $HeartbeatTokenDirectory; directorySddl = (Get-HeartbeatDirectorySddl $OwnerSid); sddl = (Get-HeartbeatFileSddl $OwnerSid); fingerprint = $null; verified = $false
    bindingId = $(if ($HeartbeatBindingId) { $HeartbeatBindingId.ToLowerInvariant() } else { $null }) }
  # Ordinary plans and apply inspect the actual folder, supplied or not. Only the explicit readonly carry preview models the
  # future root: uninstall retires the old tree, so that folder and its old Owner ACL are not reused or re-ACLed.
  if (-not $PreviewAfterUninstall -and (Test-Path -LiteralPath $HeartbeatTokenDirectory) -and -not (Test-HeartbeatDirectoryAcl $HeartbeatTokenDirectory $entry.directorySddl)) { throw 'HEARTBEAT_TOKEN_DIRECTORY_ACL_MISMATCH' }
  if ($HeartbeatTokenFile) {
    if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED_FOR_SECRETS' }
    if ($entry.targetExists) { throw 'HEARTBEAT_TOKEN_TARGET_EXISTS_NOT_OVERWRITTEN' }
    if ((Test-Path -LiteralPath $HeartbeatTokenDirectory) -and (((Get-Item -LiteralPath $HeartbeatTokenDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'HEARTBEAT_TOKEN_TARGET_DIRECTORY_REFUSED' }
    $bytes = Read-SecretSource $HeartbeatTokenFile 4096 'HEARTBEAT_TOKEN'
    try {
      # A heartbeat token is a clued_hbt_ token (its own kind); the CI connection's own token is named before anything else.
      $ciFp = Get-SecretFingerprint 'ci-token' $bytes
      if ($null -ne $ciFp -and $ciFp -ceq $Identity.ciTokenPinSha256) { throw 'HEARTBEAT_TOKEN_IS_THE_CI_ADMISSION_TOKEN' }
      $fp = Get-SecretFingerprint 'heartbeat-token' $bytes
      if ($null -eq $fp) { throw 'HEARTBEAT_TOKEN_UNREADABLE' }
      if ($script:SecretBytes.ContainsKey('upgradeToken') -and (Sha256Bytes $bytes) -ceq (Sha256Bytes $script:SecretBytes['upgradeToken'])) { throw 'HEARTBEAT_TOKEN_IS_THE_UPGRADE_TOKEN' }
    } catch { [Array]::Clear($bytes, 0, $bytes.Length); Clear-SecretBytes; throw }
    $entry.fingerprint = $fp; $entry.verified = $true
    $script:SecretBytes['heartbeatToken'] = $bytes
  }
  $entry
}
# The Owner's next step for the heartbeat connection (merge train step 2b review: the Owner links it on /bindings/failover, two-step
# confirmation; the install never does): "please, Owner, on KooYomi's /bindings/failover link heartbeat connection <id> to this node
# <node> (two-step confirmation)", in Chinese. Kept as \u escapes: this file has no BOM and Windows PowerShell 5.1 reads it in the
# system code page.
function Get-HeartbeatNextStep([string]$nodeName, [string]$bindingId) {
  $t = [regex]::Unescape('\u8bf7 Owner \u5728 KooYomi \u7684 /bindings/failover \u628a\u5fc3\u8df3\u8fde\u63a5{id}\u6302\u5230\u672c\u8282\u70b9 {node}\uff08\u4e24\u6b65\u786e\u8ba4\uff09')
  $t.Replace('{id}', $(if ($bindingId) { ' ' + $bindingId + ' ' } else { '' })).Replace('{node}', $nodeName)
}
# The package's upgrader section (A1) and files: one copy, under upgrader\<manifestSha256>\, with its host source, node, entry, the frozen
# upgrade-apply.ps1 and its configuration; the configuration names this root, this Owner, this node profile and the token target.
function Get-UpgraderPlan($pkg) {
  $find = { param($t) $hit = @($pkg.files | Where-Object { $_.target -ceq $t }); if ($hit.Count -ne 1) { throw ('PACKAGE_UPGRADER_FILE_REQUIRED:' + $t) }; $hit[0].sha256 }
  $u = Get-JsonField $pkg 'upgrader'
  if ([string](Get-JsonField $u 'manifestSha256') -cnotmatch '^[0-9a-f]{64}\z') { throw 'PACKAGE_UPGRADER_SECTION_REQUIRED' }
  $m = $u.manifestSha256
  foreach ($f in @($pkg.files | Where-Object { $_.target -cmatch '^upgrader\\[0-9a-f]{64}\\' })) { if ($f.target.Substring(9, 64) -cne $m) { throw 'PACKAGE_UPGRADER_COPY_REFUSED' } }
  $config = 'upgrader\config\upgrader.json'; $entry = 'upgrader\' + $m + '\upgrader\src\upgrader-main.mjs'
  $sha = [ordered]@{ hostSource = (& $find 'upgrader\bin\UpgraderServiceHost.cs'); node = (& $find 'upgrader\runtime\node.exe'); config = (& $find $config); entry = (& $find $entry)
    apply = (& $find ('upgrader\' + $m + '\windows\upgrade-apply.ps1')) }
  $cfg = (New-Object Text.UTF8Encoding($false, $true)).GetString((Read-PackageRecordFile $config)) | ConvertFrom-Json
  $cfgNode = Get-JsonField $cfg 'node'
  if ((Get-JsonField $cfg 'contract') -cne 'clued.independent-ci.resident-upgrader-config/1' -or (Get-JsonField $cfg 'root') -cne $Root -or (Get-JsonField $cfg 'ownerSid') -cne $OwnerSid -or
    (Get-JsonField $cfg 'nodeProfileSha256') -cne $NodeProfileSha256 -or (Get-JsonField $cfg 'tokenFile') -cne $UpgradeTokenTarget -or ($cfgNode -is [string] -and $cfgNode -cne $Node.nodeName)) { throw 'PACKAGE_UPGRADER_CONFIG_REFUSED' }
  [ordered]@{ service = $UpgraderName; account = 'LocalSystem'; start = 'delayed-auto'; requiredPrivileges = $UpgraderPrivileges; sddl = $ServiceSddl
    failure = 'restart after 60 s, then after 300 s, reset daily, also on non-crash failure'
    manifestSha256 = $m; hostSourceSha256 = $sha.hostSource; nodeSha256 = $sha.node; configSha256 = $sha.config; entrySha256 = $sha.entry; applySha256 = $sha.apply
    binaryPath = (Get-UpgraderBinPath $Root $sha.config $sha.node $m $sha.entry)
    files = @($pkg.files | Where-Object { $_.target -cmatch '^upgrader\\' }).Count
    stopFile = 'upgrade\STOP-REQUESTED'; tokenRecord = 'upgrade\upgrader-token.json'
    token = (Get-UpgradeTokenPlan) }
}
# Package /4 (A1): the layout, the state compatibility, the acceptance (= the policy's), the Linux manifest.
function Assert-Package4($pkg) {
  if ($pkg.contract -cne 'clued.independent-ci.resident-package/4') { throw 'RESIDENT_PACKAGE_4_REQUIRED' }
  if ((Get-JsonField $pkg 'windowsLayout') -cne $WindowsLayout) { throw 'PACKAGE_WINDOWS_LAYOUT_REFUSED' }
  $sc = Get-JsonField $pkg 'stateCompat'; $schema = Get-JsonField $sc 'schema'; $readable = @(Get-JsonField $sc 'readableBySchemas')   # @(): a one-element array comes back unrolled
  if (-not (($schema -is [int]) -or ($schema -is [long])) -or $schema -lt 1 -or $readable.Count -lt 1 -or @($readable | Where-Object { -not (($_ -is [int]) -or ($_ -is [long])) -or $_ -lt 1 }).Count -ne 0) { throw 'PACKAGE_STATE_COMPAT_REFUSED' }
  $decision = Get-JsonField (Get-JsonField $pkg 'acceptance') 'decisionRef'
  $policy = (New-Object Text.UTF8Encoding($false, $true)).GetString((Read-PackageRecordFile 'config\policy.json')) | ConvertFrom-Json
  if ($decision -isnot [string] -or $decision -cnotmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\z' -or $decision -cne (Get-JsonField (Get-JsonField $policy 'ownerAcceptance') 'decisionRef')) { throw 'PACKAGE_ACCEPTANCE_REFUSED' }
  if ([string](Get-JsonField (Get-JsonField $pkg 'linux') 'manifestSha256') -cnotmatch '^[0-9a-f]{64}\z') { throw 'PACKAGE_LINUX_MANIFEST_REQUIRED' }
}

function Read-InstalledPackageIdentity([string]$encoded, $pkg) {
  if (-not $encoded) { return $null }
  try {
    $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
    $keys = @($p.PSObject.Properties.Name | Sort-Object) -join ','
    if ($keys -cne 'archiveSha256,ciSourceManifestSha256,commit,packageGeneration,releaseTag,version' -or
        $p.version -isnot [string] -or $p.version -cnotmatch '^g([0-9]{6})\z' -or
        ($p.packageGeneration -isnot [int] -and $p.packageGeneration -isnot [long]) -or
        $p.packageGeneration -lt 23 -or $p.packageGeneration -ne [int]$p.version.Substring(1) -or
        $p.releaseTag -cne ('fleet-node-' + $p.version) -or $p.archiveSha256 -cnotmatch '^[0-9a-f]{64}\z' -or
        $p.commit -cnotmatch '^[0-9a-f]{40}\z' -or $p.commit -cne $pkg.linux.sourceV2.commit -or
        $p.ciSourceManifestSha256 -cne $pkg.ciSourceManifestSha256) { throw 'identity' }
    return $p
  } catch { throw 'INSTALLED_PACKAGE_IDENTITY_REFUSED' }
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
  if ($pkg.ciSourceManifestSha256 -cnotmatch '^[0-9a-f]{64}$' -or (& $find 'record\source-manifest.json') -cne $pkg.ciSourceManifestSha256) { throw 'SOURCE_V2_RECORD_PACKAGE_REQUIRED' }
  Assert-Package4 $pkg
  $installedPackage = Read-InstalledPackageIdentity $InstalledPackageB64 $pkg
  $p = [ordered]@{
    contract = 'clued.independent-ci.resident-install-plan/8'   # /7 (DESIGN.md section 33): parentAcl; /8 (018da927): package /4, upgrader, generation
    root = $Root; rootExists = (Test-Path -LiteralPath $Root)
    # PR-A review MAJOR 3: never install over a resident with an open batch (also one that waits for hosted
    # signals); like uninstall-resident.ps1, the Owner re-arms or lets it finish first.
    openBatches = (Get-OpenBatchCount)
    servicesExist = [bool](Get-Service -Name $ServiceName, $BrokerName, $UpgraderName -ErrorAction SilentlyContinue)
    residentSid = $res; ownerSid = $OwnerSid; controllerSid = $ControllerSid
    node = $Node; nodeProfileSha256 = $NodeProfileSha256   # plan /5: the node profile this install is pinned to (design section 9 C1)
    # plan /6 (design section 9 C7): who this node is (public ids and fingerprints), the role it assumes (none: the role probe decides),
    # and the two optional secret files with their pins. A supplied file is verified against its pin while the plan is built.
    nodeIdentity = $Identity; nodeIdentitySha256 = $IdentitySha256; installationSha256 = (& $find 'record\installation.json')
    roleAssumption = 'NONE'
    secrets = (Get-SecretsPlan)
    # Only when a key or token file is supplied: the fingerprint check runs the package's node.exe from a directory this script creates, admin-only, and removes it afterwards (DESIGN.md section 30.5).
    secretsFingerprintDirectory = $(if ($AppPrivateKeyFile -or $CiAdmissionTokenFile -or $UpgradeTokenFile -or $HeartbeatTokenFile) { [ordered]@{ parent = $SecretWorkParent; sddl = $SecretWorkSddl; removedAfterwards = $true } } else { $null })
    installScriptSha256 = (Sha256File $PSCommandPath)
    packageManifestSha256 = $ExpectedPackageManifestSha256
    sourceManifestSha256 = $pkg.sourceManifestSha256; residentManifestSha256 = $pkg.residentManifestSha256
    policySha256 = (& $find 'config\policy.json'); companionConfigSha256 = (& $find 'config\companion.json')
    nodeSha256 = (& $find 'runtime\node.exe')
    ciSourceManifestSha256 = $pkg.ciSourceManifestSha256; bridgeManifestSha256 = $pkg.bridgeManifestSha256
    recordSourceManifestSha256 = (& $find 'record\source-manifest.json'); acceptanceSha256 = (& $find 'record\acceptance.json'); genericHelper = $GenericHelper; companionJobHost = ('bin\' + $CompanionJobHost)
    files = @($pkg.files).Count
    acl = Get-AclPlan $res
    parentAcl = Get-ParentAclState $CiRoot $res   # the one ACE appended to an existing folder, with the DACL it expects (DESIGN.md section 33)
    # r13 (Fable ruling 0e418483): <CiRoot>\state is made or brought to the helper's rule by step state-parent-acl, before source-v2-acl.
    # The plan names the rule only: what it finds is read by the elevated step (state is admin-only) and recorded in the receipt.
    stateParent = [ordered]@{ path = (Join-Path $CiRoot 'state'); sddl = (Get-StateParentSddl $ControllerSid); rule = 'missing: made with sddl; passes the helper''s rule: not written; only the controller can write state itself: its entries become inherit-only plus (A;;0x1200a9;;;controller); any other writer: refused' }
    runnerBefore = Read-RunnerState
    runnerModified = $false
    services = [ordered]@{
      resident = [ordered]@{ name = $ServiceName; account = "NT SERVICE\$ServiceName"; start = 'delayed-auto'; sidType = 'unrestricted'; failure = 'restart once per day after 60 s, also on non-crash failure'; sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)' }
      broker = [ordered]@{ name = $BrokerName; account = 'LocalSystem'; start = 'auto'; sddl = 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)' }
    }
    # M5 (ADR 0022 section 4): the fixed supervisor action, first with the interactive token (no password); the password logon is
    # rearm-resident.ps1 -CompanionHeadless, the reinstall launcher's last step. The Owner may read the task, not run it.
    companionTask = [ordered]@{ path = '\Clued\'; name = 'CluedCIResidentCompanion'; principal = $OwnerSid; runLevel = 'LeastPrivilege'; trigger = 'AtLogOn'; logonType = 'InteractiveToken'
      sddl = (Get-CompanionTaskSddl $OwnerSid); action = (Get-SupervisorAction $Root); passwordLogon = 'rearm-resident.ps1 -CompanionHeadless (the launcher''s last step)' }
    companionLaunch = [ordered]@{ file = 'config\companion-launch.json'; contract = 'clued.independent-ci.companion-launch/1'; generation = 1
      arguments = (Get-CompanionLaunchArguments $Root $pkg.residentManifestSha256 (& $find 'config\companion.json'))
      ghConfig = (Get-CompanionGhDirs $Node.ownerProfileDirectory) }
    notifierTask = [ordered]@{ path = '\Clued\'; name = 'CluedCIResidentNotifier'; principal = $OwnerSid; logonType = 'InteractiveToken'; trigger = 'AtLogOn'; action = (Get-NotifierAction $Root $pkg.residentManifestSha256) }
    startAfterInstall = [bool]$StartAfterInstall
    privilegeBoundary = Get-PrivilegePlan
    # The earlier states are only known after the uninstall renamed the current one, so the plan names the rule, and the
    # install receipt and install\backfill-manifest.json name the files.
    carryForward = 'every resident-uninstalled-* state under the parent directory: ledger-heads, ledger records 00/10/25/80/90, executed-heads -> state\backfill\<n>\, listed with SHA-256 in install\backfill-manifest.json'
    # plan /8 (018da927): the frozen upgrade channel and the first generation. generation-1 runs after the receipt is written (current.json
    # pins the receipt's hash) and moves nothing: it only writes generations\g1\generation.json and upgrade\current.json, create-only.
    windowsLayout = $WindowsLayout; stateCompat = $pkg.stateCompat; acceptanceDecisionRef = $pkg.acceptance.decisionRef
    upgrader = (Get-UpgraderPlan $pkg)
    # DESIGN.md section 41.6a: the node heartbeat token (after the upgrader's, which it must not equal).
    heartbeatToken = (Get-HeartbeatTokenPlan -PreviewAfterUninstall:$PreviewAfterUninstall)
    generation = [ordered]@{ number = 1; record = 'generations\g1\generation.json'; current = 'upgrade\current.json'; movesFiles = $false; afterReceipt = $true
      files = 'config\*, record\*, bin\*, helpers\*, install\install-receipt.json (Get-GenerationFilesSha256)'
      linux = [ordered]@{ generation = 1; manifestSha256 = $pkg.linux.manifestSha256; ciSourceManifestSha256 = $pkg.ciSourceManifestSha256 } }
    deletesAnything = $false
  }
  if (Get-Variable CarriedCiPlan -ValueOnly -ErrorAction SilentlyContinue) { $p['ciConnection'] = $CarriedCiPlan }
  # M5-b (ADR 0023): only on a node whose companion runs as its own account (so every other node's plan is the one it was).
  if ((Test-Path variable:AccountNode) -and $AccountNode) {
    $p.companionAccount = [ordered]@{ companionSid = $OwnerSid; operatorSid = $OperatorSid; record = $CompanionAccountFile
      spool = [ordered]@{ folders = $CompanionSpoolFolders; rule = 'the operator''s write entries move to the companion account; its read entries are kept and copied' }
      brokerStableDigest = 'read as LocalSystem (Source v2 admits LocalSystem or the elevated node-profile owner)'; passwordLogon = 'rearm-resident.ps1 -CompanionAccount (random password, never typed)' }
    $p.companionAccount.relayParents = Get-CompanionRelayParentsPlan $p.parentAcl

  }
  if ($PreviewAfterUninstall) { $p.afterUninstallPreview = [ordered]@{ heartbeatDirectoryRecreated = $true; applyAllowed = $false } }
  if ($installedPackage) { $p['installedPackage'] = $installedPackage }
  $p
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
  Clear-SecretBytes
  # Not part of the plan either: the controller account's right to log on as a service (needs the elevated token to read).
  $logon = if ($elevated) { $l = Read-ServiceLogonRight $ControllerSid; if ($null -eq $l) { 'unreadable' } else { [bool]$l } } else { 'unreadable-not-elevated' }
  [ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = $planSha; plan = $plan; carryForwardPreview = $preview
    preflight = [ordered]@{ controllerServiceLogonRight = $logon } } | ConvertTo-Json -Depth 10; exit 0
}

if (-not $elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
if ($ExpectedPlanSha256 -cne $planSha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
if ($plan.openBatches -ne 0) { throw 'INSTALL_REQUIRES_NO_OPEN_BATCH_REARM_FIRST' }
# An installed resident is upgraded in place by CluedCIUpgrader (windows\request-upgrade.ps1, one Owner approval on the Grant page);
# this script installs only a fresh one (the uninstall comes first when the upgrade channel itself changes).
if ($plan.rootExists -or $plan.servicesExist) { throw 'FRESH_INSTALL_REQUIRED_UPGRADE_THROUGH_CLUEDCIUPGRADER_REQUEST_UPGRADE' }
if ($CarriedCiPlan) { Assert-ProtectedCiReinstall }
if ($plan.upgrader.token.targetExists) { throw 'UPGRADE_TOKEN_TARGET_EXISTS_NOT_OVERWRITTEN' }
$r = $plan.runnerBefore
if (-not ($r.originalBinary -and $r.stoppedPid0 -and $r.manual -and $r.accountIsController)) { throw 'RUNNER_SERVICE_NOT_ORIGINAL_STOPPED_MANUAL_CONTROLLER' }
# The runner service runs as the controller account for every stage; without the right to log on as a service SCM refuses to start
# it (event 7041) and the first role probe HALTs. Refused here, before anything is written (DESIGN.md section 30.8).
$logon = Read-ServiceLogonRight $ControllerSid
if ($null -eq $logon) { Clear-SecretBytes; throw 'USER_RIGHTS_UNREADABLE' }
if (-not $logon) { Clear-SecretBytes; throw 'CONTROLLER_SERVICE_LOGON_RIGHT_MISSING' }
# Before anything is written: every earlier state to carry, every file shape, no link anywhere.
$carry = Get-CarryForwardPlan $CarryParent

# Receipt /6 (018da927, A6) = /5 and: generation, package, layout, state compatibility, the three command lines, the Linux generation, the
# upgrader, who wrote it, what it inherits from (null: a fresh install) and the upgrade that wrote it (null: this install).
$receipt = [ordered]@{ contract = 'clued.independent-ci.resident-install-receipt/6'; generation = 1; packageManifestSha256 = $ExpectedPackageManifestSha256; windowsLayout = $plan.windowsLayout; stateCompat = $plan.stateCompat
  residentBinaryPath = $null; brokerBinaryPath = $null; companionTaskAction = $null
  linux = [ordered]@{ generation = 1; manifestSha256 = $plan.generation.linux.manifestSha256; ciSourceManifestSha256 = $plan.ciSourceManifestSha256; qualificationsSha256 = $null }
  upgrader = $null; writtenBy = 'install-resident.ps1'; inheritedFrom = $null; upgrade = $null
  planSha256 = $planSha; node = $Node; nodeProfileSha256 = $plan.nodeProfileSha256; nodeIdentity = $plan.nodeIdentity; nodeIdentitySha256 = $plan.nodeIdentitySha256; roleAssumption = $plan.roleAssumption; installationSha256 = $plan.installationSha256; acceptanceSha256 = $plan.acceptanceSha256; policySha256 = $plan.policySha256; companionConfigSha256 = $plan.companionConfigSha256; sourceManifestSha256 = $plan.sourceManifestSha256; residentManifestSha256 = $plan.residentManifestSha256; runnerSddlUnchanged = $r.sddl; steps = @(); startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
function Step([string]$name, [scriptblock]$body) { & $body; $script:receipt.steps += $name }

# 1. Directories, created new with their final ACLs.
Step 'directories' {
  foreach ($rel in $plan.acl.Keys) { New-DirectoryWithAcl $(if ($rel) { Join-Path $Root $rel } else { $Root }) $plan.acl[$rel] }
}
# 1a. The CI root's READ_CONTROL entry for the resident service (DESIGN.md section 33): the one ACE appended to an existing folder.
Step 'parent-acl' {
  $wrote = Add-ParentAce $plan.parentAcl
  $script:receipt.parentAcl = [ordered]@{ path = $plan.parentAcl.path; sid = $plan.parentAcl.sid; ace = $plan.parentAcl.ace; wrote = $wrote }
}
# M5-b relay preconditions: same append/CAS core as parent-acl, on exactly the two standard ancestors.
# Before the Source ACL migration and companion launch; the plan includes the preceding service ACE where necessary.
if ($AccountNode) {
  Step 'companion-relay-parent-acl' {
    $script:receipt.companionRelayParents = @()
    foreach ($p in $plan.companionAccount.relayParents) { Assert-CompanionRelayParentPlan $p }
    foreach ($p in $plan.companionAccount.relayParents) {
      $wrote = Add-CompanionRelayParentAce $p
      $script:receipt.companionRelayParents += ,[ordered]@{ path = $p.path; sid = $p.sid; ace = $p.ace; wrote = $wrote }
    }
  }
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
  foreach ($f in @($pkg.files | Where-Object { $_.target -cnotmatch '^upgrader\\' })) {   # the upgrader's files: step upgrader-files
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
  # from the caller's current directory (review M1). The recipe is Invoke-CompileRecipe, the one the upgrader uses (upgrade-apply.ps1 Compile).
  $fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\'
  $v2 = Join-Path $Root ('source\' + $plan.ciSourceManifestSha256 + '\' + $SourceV2Windows)
  $hashes = Invoke-CompileRecipe $Csc $fw (Join-Path $Root 'bin') (Join-Path $Root 'helpers') (Join-Path $Root 'bin\ResidentServiceHost.cs') (Join-Path $Root 'bin\SwapBroker.cs') $v2 (Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\windows\CompanionJobHost.cs'))
  foreach ($k in @($hashes.Keys)) { $script:receipt[$k] = $hashes[$k] }
}
# 3a. M5: the companion's supervisor and task registrar, from the installed resident copy (ADR 0022 section 4.2, 4.4).
Step 'companion-supervisor' {
  $w = Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\windows')
  Write-NewSecret (Join-Path $Root 'bin\companion-supervisor.lock') ([byte[]]@(0)) (Get-SecretFileSddl $OwnerSid)
  $script:receipt['companionSupervisorSourceSha256'] = Sha256File (Join-Path $w 'CompanionSupervisor.cs')
  $hashes = Invoke-CompanionSupervisorCompile $Csc 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\' (Join-Path $Root 'bin') (Join-Path $w 'CompanionSupervisor.cs') (Join-Path $w 'CompanionTaskRegistrar.cs')
  foreach ($k in @($hashes.Keys)) { $script:receipt[$k] = $hashes[$k] }
}
# 3b. Broker configuration: the Owner SID of the v1 mutation mutex, the original binary, the runner's
#     stable configuration digest (read-only, with the just-compiled broker) and the helper pin. Written
#     once, CreateNew; its SHA-256 is the broker's second command-line argument.
Step 'broker-config' {
  # M5-b (ADR 0023): Source v2 (ResidentScmV2.InstallTimeIdentityAllowed) admits only LocalSystem or the elevated node-profile owner, and
  # with a companion account the node-profile owner is that account: the read then runs as LocalSystem (Invoke-AsSystemOnce).
  if ($AccountNode) {
    $sys = Invoke-AsSystemOnce (Join-Path $Root 'bin\SwapBroker.exe') @('--stable-digest', $Root, $plan.acceptanceSha256, $plan.nodeProfileSha256)
    $stable = ([string]$sys.stdout).Trim()
    if ($sys.exit -ne 0 -or $stable -cnotmatch '^[0-9a-f]{64}$') { throw 'RUNNER_STABLE_DIGEST_UNCONFIRMED' }
  } else {
    $stable = (& (Join-Path $Root 'bin\SwapBroker.exe') --stable-digest $Root $plan.acceptanceSha256 $plan.nodeProfileSha256 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $stable -cnotmatch '^[0-9a-f]{64}$') { throw 'RUNNER_STABLE_DIGEST_UNCONFIRMED' }
  }
  if ((Read-RunnerState).sddl -cne $r.sddl) { throw 'RUNNER_SDDL_CHANGED_DURING_INSTALL' }
  # Config /2 (review MINOR-3): no Owner SID; mutex and runner-DACL managers are SYSTEM and Administrators only.
  $json = Get-BrokerConfigJson $script:receipt.genericHelperSha256 $stable $NodeCanonical $plan.nodeProfileSha256 $plan.acceptanceSha256
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
  Write-New (Join-Path $Root 'config\broker.json') $bytes
  $script:receipt.brokerConfigSha256 = Sha256Bytes $bytes; $script:receipt.runnerStableDigest = $stable
}
# 4. The resident service (virtual account, Session 0, no right on the runner service) and the
#    broker (LocalSystem, binary-path-only swaps between the original and allow-listed helpers).
Step 'services' {
  $entry = Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\src\service-main.mjs')
  $bin = Get-ResidentBinPath $Root $plan.policySha256 $plan.nodeSha256 $plan.residentManifestSha256 (Sha256File $entry)
  # Windows PowerShell 5.1 does not escape embedded quotes when it builds a native command line, so the
  # binPath= argument carries them as \" (sc.exe's C runtime turns them back into quotes); read back below.
  $null = Invoke-Sc 'RESIDENT_SERVICE_CREATE_FAILED' @('create', $ServiceName, 'binPath=', $bin.Replace('"', '\"'), 'start=',
    $(if ($CarriedCiPlan) { 'demand' } else { 'delayed-auto' }), 'obj=', "NT SERVICE\$ServiceName", 'type=', 'own')
  Assert-ServiceBinary $ServiceName $bin
  $null = Invoke-Sc 'RESIDENT_SERVICE_SIDTYPE_FAILED' @('sidtype', $ServiceName, 'unrestricted')
  $null = Invoke-Sc 'RESIDENT_SERVICE_PRIVS_FAILED' @('privs', $ServiceName, ($ResidentPrivileges -join '/'))
  # The trailing empty action is 'none' (cmd's  restart/60000/""/60000  reaches sc.exe as exactly this argv), so the
  # SCM does not repeat the restart for later failures within the reset period; every pair carries its delay.
  $null = Invoke-Sc 'RESIDENT_SERVICE_FAILURE_FAILED' @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/60000//60000')
  $null = Invoke-Sc 'RESIDENT_SERVICE_FAILUREFLAG_FAILED' @('failureflag', $ServiceName, '1')
  $null = Invoke-Sc 'RESIDENT_SERVICE_SDSET_FAILED' @('sdset', $ServiceName, $plan.services.resident.sddl)
  $bbin = Get-BrokerBinPath $Root $script:receipt.brokerConfigSha256 $plan.nodeProfileSha256
  $null = Invoke-Sc 'BROKER_SERVICE_CREATE_FAILED' @('create', $BrokerName, 'binPath=', $bbin.Replace('"', '\"'), 'start=',
    $(if ($CarriedCiPlan) { 'demand' } else { 'auto' }), 'type=', 'own')
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
  $script:receipt.brokerBinaryPath = $bbin; $script:receipt.residentBinaryPath = $bin
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
# 4c. r13 (Fable ruling 0e418483): <CiRoot>\state by this install's rule (Get-StateParentState, Invoke-StateParentAcl), before
#     source-v2-acl: migrate-acl.ps1 then only makes state\v2 under it and never makes state itself.
Step 'state-parent-acl' {
  $sp = Get-StateParentState $plan.stateParent.path $ControllerSid
  $script:receipt.stateParentAcl = Invoke-StateParentAcl $sp $ControllerSid
}
# 5. Source v2's own reviewed ACL migration of the one-shot install (formal-spool, state) so the
#    resident SID can do what the elevated Owner did per batch. Fixed args, installed copy only.
Step 'source-v2-acl' {
  $tool = Join-Path $Root ('source\' + $plan.ciSourceManifestSha256 + '\work\actions-hosted-migration\independent-ci-v1\src\resident-v2\migrate-acl.ps1')
  if (-not (Test-Path -LiteralPath $tool)) { throw 'SOURCE_V2_REQUIRED' }
  # its own -ExecutionPolicy Bypass (r5, Fable 11-21 section 1.2): never the policy of whoever started the install (a new machine's is Restricted)
  $out = & 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tool -Apply -ResidentSid $plan.residentSid -OwnerSid $(if ((Test-Path variable:OperatorSid) -and $OperatorSid) { $OperatorSid } else { $OwnerSid }) -ControllerSid $ControllerSid | Out-String
  # X3 (Fable 11-21 r5 section 2.5): a refusal carries migrate-acl.ps1's own code (its one JSON line), after the unchanged prefix
  if ($LASTEXITCODE -ne 0) {
    $refused = try { [string]((@(($out -split "`r?`n") | Where-Object { $_.Trim() }) | Select-Object -Last 1) | ConvertFrom-Json).code } catch { '' }
    throw ('SOURCE_V2_ACL_MIGRATION_REFUSED' + $(if ($refused -cmatch '^[A-Z][A-Z0-9_]{1,79}$') { ':' + $refused } else { '' }))
  }
  $script:receipt.sourceV2Acl = ($out | ConvertFrom-Json)
}
# 5a. M5-b (ADR 0023): the record of who is who (install\companion-account.json: rearm-resident.ps1, request-upgrade.ps1 and
#     verify-resident.ps1 read the Owner from it), then the formal spool follows the companion's account (Set-CompanionSpoolAcl).
if ($AccountNode) {
  Step 'companion-account' {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(([ordered]@{ contract = $CompanionAccountContract; companionSid = $OwnerSid; operatorSid = $OperatorSid } | ConvertTo-Json -Compress))
    Write-New (Join-Path $Root $CompanionAccountFile) $bytes
    foreach ($rel in $CompanionSpoolFolders) { Set-CompanionSpoolAcl (Join-Path $CiRoot $rel) $OperatorSid $OwnerSid }
  }
}
# 6. M5: the launch file of generation 1 (the supervisor's one input), the notifier task, then the companion task with the interactive
#    token and the supervisor's fixed action (ADR 0022 section 4.4). The receipt's companionTaskAction is what the supervisor starts:
#    node.exe and the companion's arguments (the generation record keeps the same string).
Step 'companion-launch' {
  $entrySha = Sha256File (Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\src\companion-main.mjs'))
  $ghExe = [string]((Get-Content -LiteralPath (Join-Path $Root 'config\companion.json') -Raw | ConvertFrom-Json).ghExe)
  if ($ghExe -cnotmatch '^[A-Z]:\\[^"''\r\n;]+\\gh\.exe\z') { throw 'COMPANION_CONFIG_GH_EXE_REFUSED' }
  if (Test-Path -LiteralPath (Join-Path $Root 'config\companion-launch.json')) { throw 'COMPANION_LAUNCH_EXISTS' }
  $json = Get-CompanionLaunchJson $Root 1 $plan.nodeSha256 $plan.residentManifestSha256 $entrySha $plan.companionConfigSha256 $Node.ownerProfileDirectory (Get-CompanionPathDirs $ghExe)
  $script:receipt.companionLaunchSha256 = Write-CompanionLaunch $Root $json
  $script:receipt.companionTaskAction = [ordered]@{ path = (Join-Path $Root 'runtime\node.exe'); arguments = $plan.companionLaunch.arguments }
}
Step 'notifier-task' {
  $script:receipt.notifierTaskXmlSha256 = Register-NotifierTask $Root $OwnerSid $plan.residentManifestSha256
}
Step 'companion-task' {
  # 6 = TASK_CREATE_OR_UPDATE, read back (Register-CompanionTaskInteractive). The upgrade channel never registers this task again.
  if ($plan.companionTask.sddl -cne (Get-CompanionTaskSddl $OwnerSid)) { throw 'COMPANION_TASK_SDDL_REFUSED' }
  $script:receipt.companionTaskXmlSha256 = Register-CompanionTaskInteractive $Root $OwnerSid
  $script:receipt.companionTaskMode = 'interactive'
}
# 6a. The upgrader (018da927): its files (read once, hashed, CreateNew, into the admin-only upgrader\), its host compiled there, its
#     service. LocalSystem, delayed-auto, required privileges SeChangeNotify only, the services' DACL, restarted after a failure.
Step 'upgrader-files' {
  $pkg = [Text.Encoding]::UTF8.GetString($pkgBytes) | ConvertFrom-Json
  foreach ($f in @($pkg.files | Where-Object { $_.target -cmatch '^upgrader\\' })) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $PackageRoot $f.path))
    if ((Sha256Bytes $bytes) -cne $f.sha256) { throw ('PACKAGE_FILE_CHANGED:' + $f.path) }
    $to = Join-Path $Root $f.target
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $to) | Out-Null
    Write-New $to $bytes
  }
}
Step 'upgrader-host' {
  $hostCs = Join-Path $Root 'upgrader\bin\UpgraderServiceHost.cs'
  if ((Sha256File $hostCs) -cne $plan.upgrader.hostSourceSha256) { throw 'UPGRADER_HOST_SOURCE_CHANGED' }
  $script:upgraderHostSha256 = Invoke-UpgraderHostCompile $Csc 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\' (Join-Path $Root 'upgrader\bin') $hostCs
}
Step 'upgrader-service' {
  $u = $plan.upgrader
  $null = Invoke-Sc 'UPGRADER_SERVICE_CREATE_FAILED' @('create', $UpgraderName, 'binPath=', $u.binaryPath.Replace('"', '\"'), 'start=',
    $(if ($CarriedCiPlan) { 'demand' } else { 'delayed-auto' }), 'type=', 'own')
  Assert-ServiceBinary $UpgraderName $u.binaryPath
  $null = Invoke-Sc 'UPGRADER_SERVICE_PRIVS_FAILED' @('privs', $UpgraderName, ($UpgraderPrivileges -join '/'))
  $null = Invoke-Sc 'UPGRADER_SERVICE_FAILURE_FAILED' @('failure', $UpgraderName, 'reset=', '86400', 'actions=', 'restart/60000/restart/300000//300000')
  $null = Invoke-Sc 'UPGRADER_SERVICE_FAILUREFLAG_FAILED' @('failureflag', $UpgraderName, '1')
  $null = Invoke-Sc 'UPGRADER_SERVICE_SDSET_FAILED' @('sdset', $UpgraderName, $u.sddl)
  $have = ConvertFrom-ScPrivs (Invoke-Sc 'SERVICE_QPRIVS_FAILED' @('qprivs', $UpgraderName, '8192'))
  if (($have -join '/') -cne ((@($UpgraderPrivileges) | Sort-Object -CaseSensitive) -join '/')) { throw ('SERVICE_PRIVILEGES_READBACK_MISMATCH:' + $UpgraderName) }
  $script:receipt.upgrader = [ordered]@{ service = $UpgraderName; binaryPath = $u.binaryPath; hostSha256 = $script:upgraderHostSha256; manifestSha256 = $u.manifestSha256; nodeSha256 = $u.nodeSha256
    configSha256 = $u.configSha256; sddl = (Get-DaclPart (Invoke-Sc 'SERVICE_SDSHOW_FAILED' @('sdshow', $UpgraderName))); requiredPrivileges = $have; tokenFingerprint = $null }
}
# 6b. The two controller secrets, when the Owner supplied them: exactly the bytes whose fingerprints equal the record's pins, create-only,
#     with their final security descriptor. Nothing is placed that was not supplied, and the receipt keeps fingerprints only.
Step 'node-secrets' {
  try {
    $placed = [ordered]@{}
    foreach ($name in @('appKey', 'ciToken')) {
      $s = $plan.secrets[$name]; $did = $false
      if ($s.supplied) {
        if ($s.createsDirectory) { New-DirectoryWithAcl (Split-Path -Parent $s.target) $s.directorySddl }
        Write-NewSecret $s.target $script:SecretBytes[$name] $s.sddl
        $did = $true
      }
      $placed[$name] = [ordered]@{ target = $s.target; placed = $did; fingerprint = $(if ($did) { $s.pin } else { $null }) }
    }
    $script:receipt.secrets = $placed
    # The resident-upgrade token (018da927): SYSTEM and Administrators only, into the secrets\ folder made by step 'directories'.
    $ut = $plan.upgrader.token; $did = $false
    if ($ut.supplied) { Write-NewSecret $ut.target $script:SecretBytes['upgradeToken'] $ut.sddl; $did = $true }
    $script:receipt.upgradeToken = [ordered]@{ target = $ut.target; placed = $did; fingerprint = $(if ($did) { $ut.fingerprint } else { $null }) }
    $script:receipt.upgrader.tokenFingerprint = $(if ($did) { $ut.fingerprint } else { $null })
    # The node heartbeat token (DESIGN.md section 41.6a): its folder is made only now, only when the token was supplied.
    $ht = $plan.heartbeatToken; $did = $false
    if ($ht.supplied) {
      if (-not (Test-Path -LiteralPath $ht.directory)) { New-DirectoryWithAcl $ht.directory $ht.directorySddl }
      Write-NewSecret $ht.target $script:SecretBytes['heartbeatToken'] $ht.sddl; $did = $true
    }
    $script:receipt.heartbeatToken = [ordered]@{ target = $ht.target; placed = $did; fingerprint = $(if ($did) { $ht.fingerprint } else { $null }); bindingId = $(if ($did) { $ht.bindingId } else { $null }) }
  } finally { Clear-SecretBytes }
}
# 7. The runner service must be byte-for-byte what it was (this install never touches it).
Step 'runner-unchanged' { if ((Read-RunnerState).sddl -cne $r.sddl) { throw 'RUNNER_SDDL_CHANGED_DURING_INSTALL' } }
$receipt.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
$receipt.started = $false
if ($CarriedCiPlan) { $receipt['ciConnectionReinstall'] = Assert-ProtectedCiReinstall -Commit }
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
function Write-ResidentInstallReceipt([string]$root, $receipt, $identity, [string]$packageManifestSha) {
  $file = Join-Path $root 'install\install-receipt.json'   # admin-only directory
  $encoding = New-Object Text.UTF8Encoding($false)
  if ($null -ne $identity) { $receipt['installedPackage'] = $identity }
  Write-New $file ($encoding.GetBytes(($receipt | ConvertTo-Json -Depth 6)))
  $digest = Sha256File $file
  if ($null -ne $identity) {
    # The service can read config but cannot write it or read the administrator-only receipt.
    $packageEvidence = [ordered]@{ installedPackage = $identity; packageManifestSha256 = $packageManifestSha; installReceiptSha256 = $digest }
    Write-New (Join-Path $root 'config\installed-package.json') ($encoding.GetBytes(($packageEvidence | ConvertTo-Json -Compress)))
  }
  $digest
}
$out = Join-Path $Root 'install\install-receipt.json'
$receiptSha256 = Write-ResidentInstallReceipt $Root $receipt $plan['installedPackage'] $ExpectedPackageManifestSha256
# 8. generation-1 (018da927): after the receipt, because upgrade\current.json pins its hash. Nothing is moved: the record of generation 1 is
#    the command lines just registered and the hash of its files where they are; current.json names it. Both create-only.
$genDir = Join-Path $Root 'generations\g1'
[void][IO.Directory]::CreateDirectory($genDir)   # inherits generations\ (as config)
$genRecord = [ordered]@{ generation = 1; packageManifestSha256 = $ExpectedPackageManifestSha256; residentBinPath = $receipt.residentBinaryPath; brokerBinPath = $receipt.brokerBinaryPath
  companionTaskArguments = $receipt.companionTaskAction.arguments; filesSha256 = (Get-GenerationFilesSha256 $Root) }
Write-New (Join-Path $genDir 'generation.json') ((New-Object Text.UTF8Encoding($false)).GetBytes(($genRecord | ConvertTo-Json -Compress)))
$current = [ordered]@{ contract = 'clued.independent-ci.resident-generation/1'; generation = 1; packageManifestSha256 = $ExpectedPackageManifestSha256; residentManifestSha256 = $plan.residentManifestSha256
  ciSourceManifestSha256 = $plan.ciSourceManifestSha256; policySha256 = $plan.policySha256; installReceiptSha256 = $receiptSha256; stateCompat = $plan.stateCompat
  linux = $plan.generation.linux; opId = $null; at = [DateTimeOffset]::UtcNow.ToString('o') }
Write-New (Join-Path $Root 'upgrade\current.json') ((New-Object Text.UTF8Encoding($false)).GetBytes(($current | ConvertTo-Json -Depth 5 -Compress)))
# 9. The upgrader starts last, once generation 1 is recorded; it records its own token like the two hosts.
$upgraderTokenPrivileges = $null
if ($StartAfterInstall) {
  if ($CarriedCiPlan) {
    $null = Invoke-Sc 'BROKER_SERVICE_START_MODE_FAILED' @('config', $BrokerName, 'start=', 'auto')
    $null = Invoke-Sc 'RESIDENT_SERVICE_START_MODE_FAILED' @('config', $ServiceName, 'start=', 'delayed-auto')
    $null = Invoke-Sc 'UPGRADER_SERVICE_START_MODE_FAILED' @('config', $UpgraderName, 'start=', 'delayed-auto')
  }
  $null = Invoke-Sc 'UPGRADER_SERVICE_START_FAILED' @('start', $UpgraderName)
  $file = Join-Path $Root $plan.upgrader.tokenRecord; $until = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $file) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 500 }
  $upgraderTokenPrivileges = @((Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).privileges)
  if (@($upgraderTokenPrivileges | Where-Object { $UpgraderPrivileges -cnotcontains $_ }).Count -gt 0) { throw ('EFFECTIVE_TOKEN_PRIVILEGES_NOT_MINIMAL:' + $plan.upgrader.tokenRecord) }
}
$placedSecrets = @(@($receipt.secrets.Keys | Where-Object { $receipt.secrets[$_].placed }) + @(if ($receipt.upgradeToken.placed) { 'upgradeToken' }) + @(if ($receipt.heartbeatToken.placed) { 'heartbeatToken' }))
[ordered]@{ status = 'RESIDENT_INSTALLED'; receipt = $out; receiptSha256 = $receiptSha256; started = $receipt.started; nodeName = $Identity.nodeName; nodeIdentitySha256 = $IdentitySha256
  generation = 1; afterReceipt = @('generation-1') + @(if ($StartAfterInstall) { 'upgrader-start' }); upgraderTokenPrivileges = $upgraderTokenPrivileges
  secretsPlaced = $placedSecrets
  heartbeatBindingId = $receipt.heartbeatToken.bindingId
  heartbeatNextStep = $(if ($receipt.heartbeatToken.placed) { Get-HeartbeatNextStep $Identity.nodeName $receipt.heartbeatToken.bindingId } else { $null })
  ownerNextStep = $(if ($placedSecrets.Count) { 'Delete the downloaded App key / token file(s) yourself: this install never deletes anything.' } else { $null }) } | ConvertTo-Json
