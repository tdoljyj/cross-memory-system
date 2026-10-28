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

  Nothing existing is overwritten, deleted or re-ACLed, with one exception: one read-only ACE is APPENDED to the existing CI root
  C:\ProgramData\CluedIndependentCI (step parent-acl, DESIGN.md section 33; the plan shows the DACL it expects). The runner service is NOT modified: its
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
  [switch]$StartAfterInstall,
  [string]$AppPrivateKeyFile,        # optional: this node's App private key, downloaded by the Owner on this machine (design 7.1)
  [string]$CiAdmissionTokenFile      # optional: this node's ci-admission connection token (design 7.2)
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)

$CiRoot = 'C:\ProgramData\CluedIndependentCI'   # the parent of $Root; it exists before this install (the v1 one-shot install made it)
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$ServiceName = 'CluedCIResident'
$BrokerName = 'CluedCISwapBroker'
$RunnerService = $null   # the node profile's runnerService (Get-PackageNodeProfile, below)
$OriginalBinary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'
$Sc = 'C:\Windows\System32\sc.exe'
$Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$TargetShape = '^(?:(?:resident|source)\\[0-9a-f]{64}(?:\\[A-Za-z0-9_.@-]+)+|(?:config|runtime|bin|helpers|record)\\[A-Za-z0-9_.@-]+)$'
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
$script:SecretBytes = @{}   # the verified secret bytes, in memory only, between the plan and the 'node-secrets' step
# Where the fingerprint check runs the package's node.exe and tool (DESIGN.md section 30.5): a directory this script creates, never the package directory.
$SecretWorkParent = 'C:\Windows\Temp'
$SecretWorkSddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'

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

# ---- Node profile (resident active/standby design v0.4, section 9 C1) ----
# The host this package is pinned to is the install record's node profile: record\acceptance.json `node`, read from
# the package, hashed against the reviewed manifest and parsed from those same bytes. Every host identity this
# script used to carry as a TURING constant (computer name, runner service, Owner and controller accounts) comes
# from it; TURING's profile is config\node-profile.turing.json, today's values. The shape rules are those of
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
    $p = [Diagnostics.Process]::Start($psi)
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

function Assert-Owner {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($id.User.Value -cne $OwnerSid) { throw 'OWNER_ACCOUNT_REQUIRED' }
  if ([Environment]::MachineName -cne $Node.hostname) { throw 'NODE_HOST_REQUIRED' }
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

# ---- The CI root's READ_CONTROL entry for the resident service (DESIGN.md section 33, first HALT of 2026-10-29) ----
# The resident service runs the Windows spool archive (resident-v2/archive-windows-spool.ps1), which loads the node profile through
# NodeProfileV2.LoadProtectedProfile: that opens EVERY ancestor directory of the profile with CreateFileW access 0x20080
# (READ_CONTROL | FILE_READ_ATTRIBUTES), C:\ProgramData\CluedIndependentCI included. The v1 one-shot install gave that folder to SYSTEM,
# Administrators, clued-control and (by hand, DESIGN.md section 8.3) the Owner, and nothing to the service SID, so the archive refused and
# the first batch close HALTed. The service gets exactly the Owner's entry: 0x120080 on this folder only (no inheritance), no data
# right and no write right. It is the one ACE this script appends to an existing directory; the plan shows the DACL it expects, the
# step refuses if the DACL changed since the plan, and the result is read back with every earlier ACE kept.
function Get-ParentAce([string]$res) { '(A;;0x120080;;;' + $res + ')' }
function Get-AceKeys([string]$sddl) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  @(foreach ($a in $raw.DiscretionaryAcl) { if ($a -is [Security.AccessControl.CommonAce]) { $a.SecurityIdentifier.Value + '|' + [string]$a.AccessMask + '|' + [int]$a.AceFlags + '|' + [string]$a.AceQualifier } else { 'other|' + $a.GetType().Name } })
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
  if ((Get-DaclPart $now) -cne $p.before) { throw 'PARENT_ACL_CHANGED_SINCE_PLAN' }
  $oldKeys = @(Get-AceKeys $now)
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm($now + $p.ace, [Security.AccessControl.AccessControlSections]::Access)
  [IO.Directory]::SetAccessControl($p.path, $acl)
  $back = Get-ParentAclState $p.path $p.sid
  $newKeys = @(Get-AceKeys (Get-Acl -LiteralPath $p.path).Sddl)
  if (-not $back.present -or $newKeys.Count -ne $oldKeys.Count + 1 -or @($oldKeys | Where-Object { $newKeys -cnotcontains $_ }).Count -ne 0) { throw ('PARENT_ACL_READBACK_MISMATCH:' + $p.path) }
  return $true
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
    contract = 'clued.independent-ci.resident-install-plan/7'   # /7 (DESIGN.md section 33): parentAcl
    root = $Root; rootExists = (Test-Path -LiteralPath $Root)
    # PR-A review MAJOR 3: never install over a resident with an open batch (also one that waits for hosted
    # signals); like uninstall-resident.ps1, the Owner re-arms or lets it finish first.
    openBatches = (Get-OpenBatchCount)
    servicesExist = [bool](Get-Service -Name $ServiceName, $BrokerName -ErrorAction SilentlyContinue)
    residentSid = $res; ownerSid = $OwnerSid; controllerSid = $ControllerSid
    node = $Node; nodeProfileSha256 = $NodeProfileSha256   # plan /5: the node profile this install is pinned to (design section 9 C1)
    # plan /6 (design section 9 C7): who this node is (public ids and fingerprints), the role it assumes (none: the role probe decides),
    # and the two optional secret files with their pins. A supplied file is verified against its pin while the plan is built.
    nodeIdentity = $Identity; nodeIdentitySha256 = $IdentitySha256; installationSha256 = (& $find 'record\installation.json')
    roleAssumption = 'NONE'
    secrets = (Get-SecretsPlan)
    # Only when a key or token file is supplied: the fingerprint check runs the package's node.exe from a directory this script creates, admin-only, and removes it afterwards (DESIGN.md section 30.5).
    secretsFingerprintDirectory = $(if ($AppPrivateKeyFile -or $CiAdmissionTokenFile) { [ordered]@{ parent = $SecretWorkParent; sddl = $SecretWorkSddl; removedAfterwards = $true } } else { $null })
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
  Clear-SecretBytes
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

$receipt = [ordered]@{ contract = 'clued.independent-ci.resident-install-receipt/5'; planSha256 = $planSha; node = $Node; nodeProfileSha256 = $plan.nodeProfileSha256; nodeIdentity = $plan.nodeIdentity; nodeIdentitySha256 = $plan.nodeIdentitySha256; roleAssumption = $plan.roleAssumption; installationSha256 = $plan.installationSha256; acceptanceSha256 = $plan.acceptanceSha256; policySha256 = $plan.policySha256; companionConfigSha256 = $plan.companionConfigSha256; sourceManifestSha256 = $plan.sourceManifestSha256; residentManifestSha256 = $plan.residentManifestSha256; runnerSddlUnchanged = $r.sddl; steps = @(); startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
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
                        @((Join-Path $v2 'ResidentScmV2.cs'), (Join-Path $v2 'ScmPidHandshakeV2.cs'), (Join-Path $v2 'NodeProfileV2.cs'))))) {
    $exe = Join-Path $Root ('bin\' + $pair[0] + '.exe')
    & $Csc /nologo /noconfig /target:exe /optimize+ ("/out:" + $exe) $pair[1] (Join-Path $Root ('bin\' + $pair[0] + '.cs')) $pair[2] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('SERVICE_HOST_COMPILE_FAILED:' + $pair[0]) }
    $script:receipt[($pair[0] + 'Sha256')] = Sha256File $exe
  }
  $helper = Join-Path $Root ('helpers\' + $GenericHelper)
  & $Csc /nologo /noconfig /target:winexe /platform:x64 /optimize+ /main:CluedWindowsFormalEntryV2 "/reference:$($fw)System.dll" "/reference:$($fw)System.Core.dll" "/reference:$($fw)System.Web.Extensions.dll" ("/out:" + $helper) (Join-Path $v2 'FormalPublicBoundaryV2.cs') (Join-Path $v2 'FormalSession0V2.cs') (Join-Path $v2 'ScmPidHandshakeV2.cs') (Join-Path $v2 'NodeProfileV2.cs') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'GENERIC_HELPER_COMPILE_FAILED' }
  $script:receipt.genericHelperSha256 = Sha256File $helper
  # The companion's job host (DESIGN §24), with the generic helper's flags (winexe: never a console window of its own).
  $jobHost = Join-Path $Root ('bin\' + $CompanionJobHost)
  & $Csc /nologo /noconfig /target:winexe /platform:x64 /optimize+ "/reference:$($fw)System.dll" ("/out:" + $jobHost) (Join-Path $Root ('resident\' + $plan.residentManifestSha256 + '\windows\CompanionJobHost.cs')) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'COMPANION_JOB_HOST_COMPILE_FAILED' }
  $script:receipt.companionJobHostSha256 = Sha256File $jobHost
  } finally { Pop-Location }
}
# 3b. Broker configuration: the Owner SID of the v1 mutation mutex, the original binary, the runner's
#     stable configuration digest (read-only, with the just-compiled broker) and the helper pin. Written
#     once, CreateNew; its SHA-256 is the broker's second command-line argument.
Step 'broker-config' {
  $stable = (& (Join-Path $Root 'bin\SwapBroker.exe') --stable-digest $Root $plan.acceptanceSha256 $plan.nodeProfileSha256 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $stable -cnotmatch '^[0-9a-f]{64}$') { throw 'RUNNER_STABLE_DIGEST_UNCONFIRMED' }
  if ((Read-RunnerState).sddl -cne $r.sddl) { throw 'RUNNER_SDDL_CHANGED_DURING_INSTALL' }
  # Config /2 (review MINOR-3): no Owner SID; mutex and runner-DACL managers are SYSTEM and Administrators only.
  $json = '{"contract":"clued.independent-ci.swap-broker-config/3","helper":{"name":"' + $GenericHelper + '","sha256":"' + $script:receipt.genericHelperSha256 + '"},"originalBinary":' + ($OriginalBinary | ConvertTo-Json -Compress) + ',"stableDigest":"' + $stable + '","node":' + $NodeCanonical + ',"nodeProfileSha256":"' + $plan.nodeProfileSha256 + '","acceptanceSha256":"' + $plan.acceptanceSha256 + '"}'
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
  $bbin = '"' + (Join-Path $Root 'bin\SwapBroker.exe') + '" "' + $Root + '" ' + $script:receipt.brokerConfigSha256 + ' ' + $plan.nodeProfileSha256
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
  } finally { Clear-SecretBytes }
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
[ordered]@{ status = 'RESIDENT_INSTALLED'; receipt = $out; receiptSha256 = (Sha256File $out); started = $receipt.started; nodeName = $Identity.nodeName; nodeIdentitySha256 = $IdentitySha256
  secretsPlaced = @($receipt.secrets.Keys | Where-Object { $receipt.secrets[$_].placed })
  ownerNextStep = $(if (@($receipt.secrets.Keys | Where-Object { $receipt.secrets[$_].placed }).Count) { 'Delete the downloaded App key / token file(s) yourself: this install never deletes anything.' } else { $null }) } | ConvertTo-Json
