<#
.SYNOPSIS
  New-node preparation for the resident independent CI (design v0.4 section 10 P2; resident DESIGN.md section 30.8).

.DESCRIPTION
  Brings a fresh Windows + WSL machine to the preconditions of install-resident.ps1 and Source v2's migrate-acl.ps1:
    * the local controller account .\clued-control;
    * the controller install C:\ProgramData\CluedControl: trusted\ (the App key's folder and its ACL chain), temp\, and a
      SEPARATE controller runner: the official runner package extracted to runner\ (original binary runner\bin\RunnerService.exe),
      registered by the Owner with the controller label, and its service <runnerService> created Stopped/Manual under
      .\clued-control (never started);
    * the CI base C:\ProgramData\CluedIndependentCI with formal-spool\{outgoing,incoming} and state\{temp}, with the DACLs
      migrate-acl.ps1 and the runtime ACL checks expect.
  The Linux half is linux/prepare-node-linux.sh, run separately as root in the distribution the Owner chose.
  Every host value comes from the node-prep profile (-ProfilePath); nothing names a machine.

  Default mode is a read-only dry run: it reads the host, prints the complete plan and its SHA-256, and writes nothing.
  -Apply performs exactly that plan. It needs the Owner's own elevated token (UAC) and -ExpectedPlanSha256 equal to the
  plan computed again at that moment; any host, profile, package or script change since the reviewed dry run refuses.

  Create-only: nothing existing is overwritten, re-ACLed or deleted. An existing item is accepted only when it already is
  exactly what the plan would create (then its step is skipped); anything else refuses with a code. Existing runners and
  services other than <runnerService> are never touched; the plan lists them and the apply checks afterwards that they
  are unchanged. One case changes an existing object: when .\clued-control exists, has never logged on and its runner
  service is still missing (an earlier apply stopped after creating the account), the plan names a password reset of
  that account, because the service needs a password and none is ever stored.

  Secrets: the runner registration token is typed by the Owner into the elevated window (Read-Host -AsSecureString),
  only when the plan has a registration step, and only after every check passed. It reaches the runner's configure
  process through that child's environment only (ACTIONS_RUNNER_INPUT_TOKEN), never a command line, and is never printed
  or stored; afterwards the runner's _diag logs are checked for it. The controller password is random, generated in
  memory for the account and the service (New-Service -Credential: API, not a command line), and never shown or stored.
  Both live as managed strings until the process ends; nothing here claims to wipe them. No App key or token is handled.

  Where it runs (review r1 MAJOR-1): the elevated run (-Apply, or a dry run with an elevated token) refuses unless this
  script sits in a folder only administrators can change (TOOL_LOCATION_NOT_ADMIN_ONLY); the field guide copies it there
  and checks its sha256 against the value recorded in KooYomi before running it. Module autoloading is limited to the
  Windows directory and nothing is compiled at run time.

  WSL: the dry run (not elevated) lists the distributions and, for each RUNNING one, reads whether it hosts GitHub
  runners (units, runner directories, listener processes, docker socket). Stopped distributions are not started. These
  observations are not part of the plan hash and are reported by the distribution itself, so the field guide also
  checks GitHub's runner list. The elevated run never enters any distribution.

  Usage (from an admin-only copy of this script whose sha256 was checked):
    prepare-node.ps1 -ProfilePath <node-prep.json> [-RunnerPackageZip <actions-runner-win-x64-*.zip>]
    prepare-node.ps1 -ProfilePath <...> [-RunnerPackageZip <...>] -Apply -ExpectedPlanSha256 <sha256>
#>
[CmdletBinding()]
param(
  [string]$ProfilePath,
  [string]$RunnerPackageZip,
  [switch]$Apply,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPlanSha256,
  [switch]$SkipWslProbe,
  [string]$OfflineHostFacts,     # offline tests only: host facts from a JSON file instead of this host
  [string]$OfflineFixtureRoot,   # offline tests only: C:\ProgramData is mapped to this directory under TEMP; effects are stubbed
  [switch]$DefinitionsOnly       # offline tests only: define the functions and return
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (as install-resident.ps1, review M1)

$ProgramData = 'C:\ProgramData'
$ControlRoot = 'C:\ProgramData\CluedControl'
$RunnerRoot = 'C:\ProgramData\CluedControl\runner'
$PackageCopy = 'C:\ProgramData\CluedControl\runner-package.zip'
$CiRoot = 'C:\ProgramData\CluedIndependentCI'
$AccountName = 'clued-control'
$AccountDescription = 'Dedicated trusted-main CI control'
$ServiceDisplayName = 'Clued dedicated trusted-main controller'
$RepositoryUrl = 'https://github.com/tdoljyj/cross-memory-system'
$RunnerServicePrefix = 'actions.runner.tdoljyj-cross-memory-system.'
# scripts/ci/clued-control-workflow-source.mjs MAIN_SECRET_CONTROLLER_ROUTE: the runner's default labels plus this one.
$ControllerLabel = 'clued-controller-windows-v1'
# resident-v2/layout.mjs ORIGINAL_BINARY and install-resident.ps1 $OriginalBinary.
$OriginalBinary = '"C:\ProgramData\CluedControl\runner\bin\RunnerService.exe"'
# NT SERVICE\CluedCIResident: the only extra ACEs accepted on an existing CI directory are the ones install-resident.ps1
# (parent-acl) and migrate-acl.ps1 append for it, so an already installed node reads as "nothing to do".
$ResidentSid = 'S-1-5-80-692288205-3332018704-1695520346-2980220175-3625982629'
$AdminSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$RunnerConfigFiles = @('.runner', '.credentials', '.credentials_rsaparams', '.service', '.env', '.path')
$MaxPackageBytes = 512MB

$PlanContract = 'clued.independent-ci.node-prep-plan/1'
$ReceiptContract = 'clued.independent-ci.node-prep-receipt/1'
$ProfileContract = 'clued.independent-ci.node-prep-profile/1'
$ProfileKeys = @('contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'controllerSid', 'runnerService', 'wslDistribution', 'runnerPackage')
$NodeProfileKeys = @('contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'controllerSid', 'runnerService', 'mutationMutex', 'wslDistribution')

# Directories, in creation order. {CTRL} = .\clued-control, {OWNER} = the Owner. Owner Administrators, protected DACL.
# Masks: 0x1200a9 read+execute, 0x1301bf modify, 0x120080 READ_CONTROL+read attributes (this folder only). Values follow
# TURING's installed tree (DESIGN.md section 30.8 names the requirement; migrate-acl.ps1 requires the spool and state DACLs
# protected; the runtime's secret chain rule requires no non-admin write right at or under CluedControl except the runner's
# own work folders, which are not on the key's chain).
$BaseSddl = 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
function Get-DirectoryModel {
  @(
    [ordered]@{ path = 'C:\ProgramData\CluedControl'; sddl = $BaseSddl + '(A;OICI;0x1200a9;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedControl\trusted'; sddl = $BaseSddl + '(A;OICI;0x1200a9;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedControl\temp'; sddl = $BaseSddl + '(A;OICI;0x1301bf;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedControl\runner'; sddl = $BaseSddl + '(A;OICI;0x1200a9;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedControl\runner\_diag'; sddl = $BaseSddl + '(A;OICI;0x1301bf;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedControl\runner\_work'; sddl = $BaseSddl + '(A;OICI;0x1301bf;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedIndependentCI'; sddl = $BaseSddl + '(A;;0x120080;;;{OWNER})(A;OICI;0x1200a9;;;{CTRL})'; extra = @('(A;;0x120080;;;{RES})') }
    [ordered]@{ path = 'C:\ProgramData\CluedIndependentCI\formal-spool'; sddl = $BaseSddl + '(A;;0x120080;;;{OWNER})(A;OICI;0x1200a9;;;{CTRL})'; extra = @('(A;;0x1200a5;;;{RES})') }
    [ordered]@{ path = 'C:\ProgramData\CluedIndependentCI\formal-spool\outgoing'; sddl = $BaseSddl + '(A;OICI;0x1200a9;;;{OWNER})(A;OICI;0x1301bf;;;{CTRL})'; extra = @('(A;;0x1200e1;;;{RES})', '(A;OIIO;0x120089;;;{RES})') }
    [ordered]@{ path = 'C:\ProgramData\CluedIndependentCI\formal-spool\incoming'; sddl = $BaseSddl + '(A;OICI;0x1301bf;;;{OWNER})(A;OICI;0x1200a9;;;{CTRL})'; extra = @('(A;;0x1200e1;;;{RES})', '(A;OIIO;0x120089;;;{RES})') }
    [ordered]@{ path = 'C:\ProgramData\CluedIndependentCI\state'; sddl = $BaseSddl + '(A;OICIIO;0x1301bf;;;{CTRL})(A;;0x1200a9;;;{CTRL})'; extra = @() }
    [ordered]@{ path = 'C:\ProgramData\CluedIndependentCI\state\temp'; sddl = $BaseSddl + '(A;OICI;0x1301bf;;;{CTRL})'; extra = @() }
  )
}
$ControlDirectoryCount = 6   # the first six belong to the controller install, before the runner steps
# migrate-acl.ps1 (ACL_TARGET_NOT_PROTECTED) and install-resident.ps1 (PARENT_ACL_NOT_PROTECTED) append to these, so an existing one must
# also be protected; the others only need the same grants (TURING's trusted\ and runner\ inherit theirs).
$MustBeProtected = @('C:\ProgramData\CluedIndependentCI', 'C:\ProgramData\CluedIndependentCI\formal-spool', 'C:\ProgramData\CluedIndependentCI\formal-spool\outgoing', 'C:\ProgramData\CluedIndependentCI\formal-spool\incoming')

function Get-Field($o, [string]$k) {
  if ($null -eq $o) { return $null }
  if ($o -is [Collections.IDictionary]) { if ($o.Contains($k)) { return $o[$k] } else { return $null } }
  if (@($o.PSObject.Properties.Name) -ccontains $k) { return $o.$k }
  $null
}
function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Sha256Text([string]$t) { Sha256Bytes ((New-Object Text.UTF8Encoding($false)).GetBytes($t)) }
function Read-StrictUtf8([byte[]]$b) { (New-Object Text.UTF8Encoding($false, $true)).GetString($b) }
# `-is [pscustomobject]` is true for any PowerShell-wrapped value (arrays included); test the real type.
function Test-JsonObject($o) { $null -ne $o -and $o.GetType().FullName -ceq 'System.Management.Automation.PSCustomObject' }

# ---- Profile ----
$SidPattern = '^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-(\d{1,10})\z'
function Get-Rid([string]$sid) { if ($sid -cmatch $SidPattern) { [long]$Matches[1] } else { $null } }
function ConvertFrom-PrepProfile([byte[]]$bytes) {
  if ($bytes.Length -lt 2 -or $bytes.Length -gt 16384 -or ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB)) { throw 'NODE_PREP_PROFILE_REFUSED' }
  $p = try { Read-StrictUtf8 $bytes | ConvertFrom-Json } catch { throw 'NODE_PREP_PROFILE_REFUSED' }
  if (-not (Test-JsonObject $p)) { throw 'NODE_PREP_PROFILE_REFUSED' }
  $keys = @($p.PSObject.Properties.Name)
  if ((@($keys | Sort-Object) -join '|') -cne (@($ProfileKeys | Sort-Object) -join '|')) { throw 'NODE_PREP_PROFILE_FIELDS_REQUIRED' }
  foreach ($k in @('contract', 'nodeName', 'hostname', 'ownerSid', 'ownerProfileDirectory', 'runnerService')) { if ($p.$k -isnot [string]) { throw 'NODE_PREP_PROFILE_FIELDS_REQUIRED' } }
  foreach ($k in @('controllerSid', 'wslDistribution')) { if ($null -ne $p.$k -and $p.$k -isnot [string]) { throw 'NODE_PREP_PROFILE_FIELDS_REQUIRED' } }
  if ($p.contract -cne $ProfileContract) { throw 'NODE_PREP_PROFILE_CONTRACT_REFUSED' }
  $pkg = $p.runnerPackage
  if (-not (Test-JsonObject $pkg) -or (@($pkg.PSObject.Properties.Name | Sort-Object) -join '|') -cne 'fileName|sha256|version' -or
    @($pkg.version, $pkg.fileName, $pkg.sha256 | Where-Object { $_ -isnot [string] }).Count) { throw 'NODE_PREP_PROFILE_FIELDS_REQUIRED' }
  $ownerRid = Get-Rid $p.ownerSid
  if ($p.nodeName -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\z' -or $p.hostname -cnotmatch '^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?\z' -or
    $null -eq $ownerRid -or $p.ownerProfileDirectory -cnotmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z' -or
    $p.runnerService -cnotmatch '^actions\.runner\.tdoljyj-cross-memory-system\.clued-ci-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\z' -or
    ($null -ne $p.wslDistribution -and $p.wslDistribution -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z') -or
    $pkg.version -cnotmatch '^\d{1,3}\.\d{1,4}\.\d{1,4}\z' -or $pkg.fileName -cne ('actions-runner-win-x64-' + $pkg.version + '.zip') -or $pkg.sha256 -cnotmatch '^[0-9a-f]{64}\z') { throw 'NODE_PREP_PROFILE_INVALID' }
  if ($null -ne $p.controllerSid) {
    $rid = Get-Rid $p.controllerSid
    if ($null -eq $rid -or $rid -lt 1000 -or $p.controllerSid -ceq $p.ownerSid) { throw 'NODE_PREP_PROFILE_INVALID' }
  }
  $p
}
function Get-RunnerName($profile) { $profile.runnerService.Substring($RunnerServicePrefix.Length) }

# The resident's node profile (resident-v1 src/node-profile.mjs, contract node-profile/1) for this node, once the controller SID and
# the WSL distribution are known; canonical bytes = sorted keys, compact JSON (src/canonical.mjs digest).
function Get-DerivedNodeProfile($profile, [string]$controllerSid) {
  if (-not $controllerSid -or -not $profile.wslDistribution) { return $null }
  [ordered]@{ contract = 'clued.independent-ci.node-profile/1'; nodeName = $profile.nodeName; hostname = $profile.hostname; ownerSid = $profile.ownerSid
    ownerProfileDirectory = $profile.ownerProfileDirectory; controllerSid = $controllerSid; runnerService = $profile.runnerService
    mutationMutex = ('Global\CluedControlControllerMutationV1-' + $profile.hostname + '-' + (Get-Rid $controllerSid)); wslDistribution = $profile.wslDistribution }
}
function ConvertTo-CanonicalJson($map) {
  [string[]]$keys = @($map.Keys); [Array]::Sort($keys, [StringComparer]::Ordinal)
  '{' + ((@(foreach ($k in $keys) { ($k | ConvertTo-Json -Compress) + ':' + ($map[$k] | ConvertTo-Json -Compress) })) -join ',') + '}'
}

# ---- ACE comparison ----
function Resolve-Sddl([string]$t, [string]$ctrl, [string]$owner) { $t.Replace('{CTRL}', $ctrl).Replace('{OWNER}', $owner).Replace('{RES}', $ResidentSid) }
# sid|mask|flags|type, with the INHERITED flag cleared: an inherited and an explicit ACE grant the same thing.
function Get-AceKeys([string]$sddl) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  if ($null -eq $raw.DiscretionaryAcl) { return @('null-dacl') }
  @(foreach ($a in $raw.DiscretionaryAcl) {
      if ($a -is [Security.AccessControl.CommonAce]) { $a.SecurityIdentifier.Value + '|' + [string]$a.AccessMask + '|' + ([int]$a.AceFlags -band (-bnot 0x10)) + '|' + [string]$a.AceQualifier }
      else { 'other|' + $a.GetType().Name } }) | Sort-Object -CaseSensitive
}
function Get-SddlOwner([string]$sddl) { $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl); if ($raw.Owner) { $raw.Owner.Value } else { $null } }
# 'same' when the existing descriptor grants exactly the planned ACEs (plus only the allowed resident ACEs) and is owned by an admin.
function Test-SddlProtected([string]$sddl) { ((New-Object Security.AccessControl.RawSecurityDescriptor($sddl)).ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0 }
function Compare-DirectoryAcl([string]$have, [string]$want, [string[]]$extra, [bool]$mustProtect = $false) {
  if ($AdminSids -cnotcontains (Get-SddlOwner $have)) { return 'owner-refused' }
  if ($mustProtect -and -not (Test-SddlProtected $have)) { return 'not-protected' }
  $h = @(Get-AceKeys $have); $w = @(Get-AceKeys $want); $x = @(foreach ($e in $extra) { Get-AceKeys ('D:' + $e) })
  $rest = New-Object System.Collections.ArrayList; foreach ($k in $h) { [void]$rest.Add($k) }
  foreach ($k in $w) { if ($rest -ccontains $k) { $rest.Remove($k) } else { return 'missing-ace' } }
  foreach ($k in @($rest)) { if ($x -ccontains $k) { $rest.Remove($k) } }
  if ($rest.Count) { return 'extra-ace' }
  'same'
}
# A directory this script just created, read back: exactly the planned ACEs, protected, and (on the real host) owned by Administrators,
# so a folder a user created first under C:\ProgramData (BU may create folders there) is never accepted. Returns 'ok' or the reason.
function Test-CreatedSddl([string]$after, [string]$expect, [bool]$requireAdminsOwner) {
  if ((@(Get-AceKeys $after) -join ';') -cne (@(Get-AceKeys $expect) -join ';')) { return 'ace-mismatch' }
  if (-not (Test-SddlProtected $after)) { return 'not-protected' }
  if ($requireAdminsOwner -and (Get-SddlOwner $after) -cne 'S-1-5-32-544') { return 'owner' }
  'ok'
}
# Review r1 MAJOR-1: the elevated run must not execute a script a non-administrator can change. Allowed: the script file and every folder
# from it up to the drive root are owned by an administrator principal and grant no non-administrator a right to write, append, delete,
# replace or re-ACL them (inherit-only entries apply to children, not to the item, and are checked on the children themselves).
function Get-AdminOnlyState($items) {
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
  $replace = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000
  foreach ($it in $items) {
    if ($AdminSids -cnotcontains $it.acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return ('owner:' + $it.path) }
    # The script and its own folder: no write at all. Folders above: no replace right (C:\ and C:\ProgramData let users add siblings).
    $mask = if ($it.strict) { $write } else { $replace }
    foreach ($rule in $it.acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ([string]$rule.AccessControlType -cne 'Allow' -or (([int]$rule.PropagationFlags -band 2) -ne 0)) { continue }
      if ((([int]$rule.FileSystemRights -band $mask) -ne 0) -and $AdminSids -cnotcontains $rule.IdentityReference.Value) { return ('writable:' + $it.path) }
    }
  }
  'ok'
}
function Assert-ToolLocation([string]$scriptPath) {
  $items = New-Object System.Collections.ArrayList
  $leaf = Get-Item -LiteralPath $scriptPath -Force
  if (($leaf.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'TOOL_LOCATION_NOT_ADMIN_ONLY:link' }
  [void]$items.Add(@{ path = $scriptPath; acl = (Get-Acl -LiteralPath $scriptPath); strict = $true })
  $dir = [IO.Path]::GetDirectoryName($scriptPath); $first = $true
  for ($c = $dir; $c; $c = [IO.Path]::GetDirectoryName($c)) {
    $it = Get-Item -LiteralPath $c -Force
    if (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('TOOL_LOCATION_NOT_ADMIN_ONLY:link:' + $c) }
    [void]$items.Add(@{ path = $c; acl = (Get-Acl -LiteralPath $c); strict = $first }); $first = $false
  }
  $s = Get-AdminOnlyState $items
  if ($s -cne 'ok') { throw ('TOOL_LOCATION_NOT_ADMIN_ONLY:' + $s) }
}

# ---- Host facts (live) ----
function Test-Elevated { (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Get-PathFact([string]$p) {
  $item = try { Get-Item -LiteralPath $p -Force -ErrorAction Stop } catch [Management.Automation.ItemNotFoundException] { $null } catch { return [ordered]@{ exists = $true; kind = 'unreadable'; sddl = $null } }
  if ($null -eq $item) { return [ordered]@{ exists = $false; kind = 'absent'; sddl = $null } }
  $kind = if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'reparse' } elseif ($item.PSIsContainer) { 'directory' } else { 'file' }
  $sddl = try { (Get-Acl -LiteralPath $p -ErrorAction Stop).Sddl } catch { $null }
  if ($null -eq $sddl -and $kind -ceq 'directory') { $kind = 'unreadable' }
  [ordered]@{ exists = $true; kind = $kind; sddl = $sddl }
}
function Get-AccountFact {
  $u = try { Get-LocalUser -Name $AccountName -ErrorAction Stop } catch { $null }
  if ($null -eq $u) { return $null }
  # ADSI lists the account's own groups; Get-LocalGroupMember fails on groups holding orphaned SIDs and would hide a membership.
  $groups = try { @(([ADSI]('WinNT://' + [Environment]::MachineName + '/' + $AccountName + ',user')).psbase.Invoke('Groups') | ForEach-Object { $_.GetType().InvokeMember('Name', 'GetProperty', $null, $_, $null) }) } catch { throw 'CONTROLLER_ACCOUNT_GROUPS_UNREADABLE' }
  [ordered]@{ sid = $u.SID.Value; enabled = [bool]$u.Enabled; description = [string]$u.Description; fullName = [string]$u.FullName
    passwordNeverExpires = ($null -eq $u.PasswordExpires); userMayChangePassword = [bool]$u.UserMayChangePassword; groups = @($groups); neverLoggedOn = ($null -eq $u.LastLogon) }
}
function Get-RunnerServiceFacts {
  @(Get-CimInstance -ClassName Win32_Service -Filter "Name LIKE 'actions.runner.%'" | Sort-Object Name | ForEach-Object {
      [ordered]@{ name = $_.Name; binary = $_.PathName; account = $_.StartName; startMode = $_.StartMode; state = $_.State; displayName = $_.DisplayName } })
}
# Zip entries of the runner package: relative Windows path -> sha256 (files only), refusing any unsafe name.
function Get-ZipEntries([byte[]]$zip) {
  Add-Type -AssemblyName System.IO.Compression
  $ms = New-Object IO.MemoryStream(, $zip); $za = New-Object IO.Compression.ZipArchive($ms, [IO.Compression.ZipArchiveMode]::Read)
  try {
    $map = [ordered]@{}
    foreach ($e in @($za.Entries | Sort-Object FullName)) {
      $name = $e.FullName.Replace('/', '\')
      if ($name.EndsWith('\')) { continue }
      if ($name -cnotmatch '^[A-Za-z0-9_.+@ -]+(\\[A-Za-z0-9_.+@ -]+)*\z' -or $name.Contains(':') -or @($name.Split('\') | Where-Object { $_ -ceq '..' -or $_ -ceq '.' }).Count -or
        $RunnerConfigFiles -contains $name -or $name -match '^(_diag|_work)(\\|\z)') { throw 'RUNNER_PACKAGE_ENTRY_REFUSED' }
      if ($map.Contains($name)) { throw 'RUNNER_PACKAGE_ENTRY_REFUSED' }
      $s = $e.Open(); $buf = New-Object IO.MemoryStream; try { $s.CopyTo($buf) } finally { $s.Dispose() }
      $map[$name] = Sha256Bytes $buf.ToArray()
    }
    if (-not $map.Contains('bin\RunnerService.exe') -or -not $map.Contains('bin\Runner.Listener.exe')) { throw 'RUNNER_PACKAGE_ENTRY_REFUSED' }
    $map
  } finally { $za.Dispose(); $ms.Dispose() }
}
# absent | empty (only the work folders) | extracted (exactly the package, not registered) | registered | unexpected | unreadable
# Every item of the tree must also be owned by an administrator principal ($requireAdminOwner; the offline tests run on a user-owned temp
# tree): an owner keeps WRITE_DAC, so a runner file owned by the Owner's account could be re-ACLed and replaced from a non-elevated process.
function Get-RunnerRootFact($entries, [bool]$requireAdminOwner = $true) {
  $kind = (Get-PathFact $RunnerRoot).kind
  if ($kind -ceq 'absent') { return 'absent' }
  if ($kind -cne 'directory') { return $(if ($kind -ceq 'unreadable') { 'unreadable' } else { 'unexpected' }) }
  try {
    $files = @(Get-ChildItem -LiteralPath $RunnerRoot -Recurse -Force -ErrorAction Stop | Where-Object {
        $rel = $_.FullName.Substring($RunnerRoot.Length + 1); $rel -notmatch '^(_diag|_work)(\\|\z)' })
  } catch { return 'unreadable' }
  $link = @($files | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1)
  if ($link.Count) { return ('unexpected:link:' + $link[0].FullName.Substring($RunnerRoot.Length + 1)) }
  if ($requireAdminOwner) {
    foreach ($f in $files) {
      $o = try { (Get-Acl -LiteralPath $f.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { return 'unreadable' }
      if ($AdminSids -cnotcontains $o) { return ('unexpected:owner:' + $f.FullName.Substring($RunnerRoot.Length + 1)) }
    }
  }
  $plain = @($files | Where-Object { -not $_.PSIsContainer })
  if ($plain.Count -eq 0) { return 'empty' }
  if ($null -eq $entries) { return 'package-required' }
  $seen = 0; $registered = $false; $bad = New-Object System.Collections.ArrayList
  foreach ($f in $plain) {
    $rel = $f.FullName.Substring($RunnerRoot.Length + 1)
    if ($entries.Contains($rel)) { if ((Sha256Bytes ([IO.File]::ReadAllBytes($f.FullName))) -cne $entries[$rel]) { [void]$bad.Add('changed:' + $rel) } else { $seen++ } }
    elseif ($RunnerConfigFiles -ccontains $rel) { if ($rel -ceq '.runner') { $registered = $true } }
    else { [void]$bad.Add('extra:' + $rel) }
  }
  if ($seen + @($bad | Where-Object { $_.StartsWith('changed:') }).Count -ne $entries.Count) { [void]$bad.Add('missing:' + ($entries.Count - $seen)) }
  # Names only (never contents), at most five, so the refusal says what differs.
  if ($bad.Count) { return ('unexpected:' + ((@($bad) | Select-Object -First 5) -join ',')) }
  if ($registered) { 'registered' } else { 'extracted' }
}
function Get-LiveHostFacts($profile, $entries) {
  $paths = [ordered]@{}
  foreach ($p in @($ProgramData) + @(Get-DirectoryModel | ForEach-Object { $_.path })) { $paths[$p] = Get-PathFact $p }
  $copy = Get-PathFact $PackageCopy
  $copySha = if ($copy.kind -ceq 'file') { try { Sha256Bytes ([IO.File]::ReadAllBytes($PackageCopy)) } catch { 'unreadable' } } else { $null }
  $svcFile = Join-Path $RunnerRoot '.service'
  $svc = Get-PathFact $svcFile
  $svcText = switch -CaseSensitive ($svc.kind) { 'absent' { $null } 'file' { try { [IO.File]::ReadAllText($svcFile) } catch { 'unreadable' } } 'unreadable' { 'unreadable' } default { 'refused' } }
  [ordered]@{
    hostname = [Environment]::MachineName; currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    userProfile = [Environment]::GetFolderPath('UserProfile'); elevated = (Test-Elevated)
    account = (Get-AccountFact); services = @(Get-RunnerServiceFacts); paths = $paths
    runnerRoot = (Get-RunnerRootFact $entries); packageCopySha256 = $copySha; packageCopyKind = $copy.kind; serviceFile = $svcText
  }
}

# ---- Plan ----
function Test-ServiceAccountIsController([string]$account, [string]$hostname) { $account -match ('^(\.|' + [regex]::Escape($hostname) + ')\\' + [regex]::Escape($AccountName) + '\z') }
function Get-NodePrepPlan($profile, $facts, [hashtable]$meta) {
  if ((Get-Field $facts 'hostname') -cne $profile.hostname) { throw 'NODE_HOST_REQUIRED' }
  if ((Get-Field $facts 'currentUserSid') -cne $profile.ownerSid) { throw 'OWNER_ACCOUNT_REQUIRED' }
  if ((Get-Field $facts 'userProfile') -ine $profile.ownerProfileDirectory) { throw 'OWNER_PROFILE_DIRECTORY_MISMATCH' }
  $paths = Get-Field $facts 'paths'
  $pd = Get-Field $paths $ProgramData
  if ($null -eq $pd -or (Get-Field $pd 'kind') -cne 'directory') { throw 'PROGRAMDATA_REFUSED' }
  foreach ($k in @(Get-DirectoryModel | ForEach-Object { $_.path })) {
    $f = Get-Field $paths $k; if ($null -eq $f) { throw 'HOST_FACTS_INCOMPLETE' }
    if ((Get-Field $f 'kind') -ceq 'unreadable') { throw 'ELEVATED_DRY_RUN_REQUIRED' }
  }
  if ((Get-Field $facts 'runnerRoot') -ceq 'unreadable' -or (Get-Field $facts 'packageCopySha256') -ceq 'unreadable' -or (Get-Field $facts 'packageCopyKind') -ceq 'unreadable' -or
    (Get-Field $facts 'serviceFile') -ceq 'unreadable') { throw 'ELEVATED_DRY_RUN_REQUIRED' }

  # Account
  $acct = Get-Field $facts 'account'; $ctrl = $null; $accountStep = 'create'
  if ($null -ne $acct) {
    $ctrl = Get-Field $acct 'sid'; $rid = Get-Rid $ctrl
    if ($null -eq $rid -or $rid -lt 1000 -or $ctrl -ceq $profile.ownerSid) { throw 'CONTROLLER_ACCOUNT_REFUSED' }
    if ($null -ne $profile.controllerSid -and $ctrl -cne $profile.controllerSid) { throw 'CONTROLLER_SID_MISMATCH' }
    if (-not (Get-Field $acct 'enabled') -or (Get-Field $acct 'description') -cne $AccountDescription -or (Get-Field $acct 'fullName') -cne '' -or
      -not (Get-Field $acct 'passwordNeverExpires') -or (Get-Field $acct 'userMayChangePassword') -or @(Get-Field $acct 'groups').Count) { throw 'CONTROLLER_ACCOUNT_EXISTS_DIFFERENT' }
    $accountStep = 'present'
  } elseif ($null -ne $profile.controllerSid) { throw 'CONTROLLER_ACCOUNT_MISSING' }
  $ctrlRef = if ($ctrl) { $ctrl } else { '{CTRL}' }

  # Services: ours, and every other runner (listed, never touched; none may live in the controller root).
  $ours = $null; $others = @()
  foreach ($s in @(Get-Field $facts 'services')) {
    $bin = [string](Get-Field $s 'binary')
    if ((Get-Field $s 'name') -ceq $profile.runnerService) { $ours = $s; continue }
    if ($bin.Trim('"').StartsWith($ControlRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'FOREIGN_RUNNER_SERVICE_IN_CONTROL_ROOT' }
    $others += , [ordered]@{ name = (Get-Field $s 'name'); binary = $bin; account = (Get-Field $s 'account'); startMode = (Get-Field $s 'startMode') }
  }
  $serviceStep = 'create'
  if ($null -ne $ours) {
    if ($null -eq $acct) { throw 'RUNNER_SERVICE_WITHOUT_ACCOUNT' }
    if ((Get-Field $ours 'binary') -cne $OriginalBinary -or -not (Test-ServiceAccountIsController (Get-Field $ours 'account') $profile.hostname) -or
      (Get-Field $ours 'startMode') -cne 'Manual' -or (Get-Field $ours 'state') -cne 'Stopped' -or (Get-Field $ours 'displayName') -cne $ServiceDisplayName) { throw 'RUNNER_SERVICE_EXISTS_DIFFERENT' }
    $serviceStep = 'present'
  } elseif ($null -ne $acct) {
    if (-not (Get-Field $acct 'neverLoggedOn')) { throw 'CONTROLLER_ACCOUNT_IN_USE_WITHOUT_SERVICE' }
    $accountStep = 'password-reset'
  }

  $steps = New-Object System.Collections.ArrayList
  [void]$steps.Add([ordered]@{ id = 'account'; kind = $(if ($accountStep -ceq 'create') { 'account-create' } elseif ($accountStep -ceq 'password-reset') { 'account-password-reset' } else { 'account-present' })
      name = $AccountName; description = $AccountDescription; groups = @(); passwordNeverExpires = $true; userMayChangePassword = $false; skip = ($accountStep -ceq 'present') })
  $model = @(Get-DirectoryModel)
  $dirSteps = @(for ($i = 0; $i -lt $model.Count; $i++) {
      $d = $model[$i]; $f = Get-Field $paths $d.path; $kind = Get-Field $f 'kind'
      $want = Resolve-Sddl $d.sddl $ctrlRef $profile.ownerSid
      if ($kind -ceq 'absent') { $skip = $false }
      elseif ($kind -cne 'directory') { throw ('DIRECTORY_TARGET_REFUSED:' + $d.path) }
      elseif ($null -eq $ctrl) { throw ('DIRECTORY_EXISTS_BEFORE_ACCOUNT:' + $d.path) }
      else { $c = Compare-DirectoryAcl (Get-Field $f 'sddl') $want @($d.extra | ForEach-Object { Resolve-Sddl $_ $ctrlRef $profile.ownerSid }) ($MustBeProtected -ccontains $d.path); if ($c -cne 'same') { throw ('DIRECTORY_EXISTS_DIFFERENT:' + $d.path + ':' + $c) }; $skip = $true }
      [ordered]@{ id = ('dir:' + $d.path); kind = 'directory'; path = $d.path; sddl = $want; skip = $skip }
    })
  for ($i = 0; $i -lt $ControlDirectoryCount; $i++) { [void]$steps.Add($dirSteps[$i]) }

  # Runner root, package copy, registration, .service file
  $root = Get-Field $facts 'runnerRoot'
  if ($root -cmatch '^unexpected(:|\z)') { throw ('RUNNER_ROOT_UNEXPECTED' + $root.Substring(10)) }
  if ($root -ceq 'package-required') { throw 'RUNNER_PACKAGE_REQUIRED' }
  if (@('absent', 'empty', 'extracted', 'registered') -cnotcontains $root) { throw 'HOST_FACTS_INCOMPLETE' }
  $copyKind = Get-Field $facts 'packageCopyKind'
  $copySkip = $false
  if ($copyKind -ceq 'file') { if ((Get-Field $facts 'packageCopySha256') -cne $profile.runnerPackage.sha256) { throw 'RUNNER_PACKAGE_COPY_EXISTS_DIFFERENT' }; $copySkip = $true }
  elseif ($copyKind -cne 'absent') { throw 'RUNNER_PACKAGE_COPY_REFUSED' }
  $svcText = Get-Field $facts 'serviceFile'
  $svcFileSkip = $false
  if ($null -ne $svcText) { if ($svcText -cne $profile.runnerService) { throw 'RUNNER_SERVICE_FILE_EXISTS_DIFFERENT' }; $svcFileSkip = $true }
  $extractSkip = @('extracted', 'registered') -ccontains $root
  $registerSkip = ($root -ceq 'registered')
  if ($registerSkip -and $null -eq $acct) { throw 'RUNNER_REGISTERED_BEFORE_ACCOUNT' }
  $needPackage = (-not $extractSkip) -or (-not $copySkip)
  $pkgMeta = Get-Field $meta 'package'
  if ($needPackage -and $null -eq $pkgMeta) { throw 'RUNNER_PACKAGE_REQUIRED' }
  [void]$steps.Add([ordered]@{ id = 'runner-extract'; kind = 'runner-extract'; path = $RunnerRoot; packageSha256 = $profile.runnerPackage.sha256; skip = $extractSkip })
  [void]$steps.Add([ordered]@{ id = 'runner-package-copy'; kind = 'file-create'; path = $PackageCopy; sha256 = $profile.runnerPackage.sha256; skip = $copySkip })
  [void]$steps.Add([ordered]@{ id = 'runner-register'; kind = 'runner-register'; url = $RepositoryUrl; name = (Get-RunnerName $profile); labels = @('self-hosted', 'Windows', 'X64', $ControllerLabel)
      work = '_work'; disableUpdate = $true; asService = $false; tokenFromOwnerPrompt = (-not $registerSkip); skip = $registerSkip })
  [void]$steps.Add([ordered]@{ id = 'runner-service-file'; kind = 'file-create'; path = (Join-Path $RunnerRoot '.service'); text = $profile.runnerService; skip = $svcFileSkip })
  [void]$steps.Add([ordered]@{ id = 'service'; kind = $(if ($serviceStep -ceq 'create') { 'service-create' } else { 'service-present' }); name = $profile.runnerService
      displayName = $ServiceDisplayName; binary = $OriginalBinary; account = ('.\' + $AccountName); startMode = 'Manual'; started = $false; skip = ($serviceStep -ceq 'present') })
  for ($i = $ControlDirectoryCount; $i -lt $dirSteps.Count; $i++) { [void]$steps.Add($dirSteps[$i]) }

  $derived = Get-DerivedNodeProfile $profile $ctrl
  $todo = @($steps | Where-Object { -not $_.skip }).Count
  [ordered]@{
    contract = $PlanContract
    status = $(if ($todo) { 'PLAN' } else { 'NOTHING_TO_DO' })
    toolSha256 = $meta.toolSha256; profileSha256 = $meta.profileSha256
    profile = [ordered]@{ nodeName = $profile.nodeName; hostname = $profile.hostname; ownerSid = $profile.ownerSid; ownerProfileDirectory = $profile.ownerProfileDirectory
      controllerSid = $profile.controllerSid; runnerService = $profile.runnerService; wslDistribution = $profile.wslDistribution
      runnerPackage = [ordered]@{ version = $profile.runnerPackage.version; fileName = $profile.runnerPackage.fileName; sha256 = $profile.runnerPackage.sha256 } }
    package = $pkgMeta
    controllerSid = $ctrl
    runnerRootBefore = $root
    untouchedServices = @($others)
    steps = @($steps)
    derivedNodeProfile = $derived
    derivedNodeProfileSha256 = $(if ($derived) { Sha256Text (ConvertTo-CanonicalJson $derived) } else { $null })
  }
}
function ConvertTo-PlanJson($plan) { $plan | ConvertTo-Json -Depth 10 -Compress }
function Get-PlanSha256($plan) { Sha256Text (ConvertTo-PlanJson $plan) }

# ---- Effects (all create-only; each stubbed in the offline fixture) ----
$script:Fixture = $null          # the fixture root when -OfflineFixtureRoot is used
$script:EffectLog = New-Object System.Collections.ArrayList
$script:Partial = $null          # set when an apply stops after its first step (review r1 MAJOR-4)
function Get-MappedPath([string]$p) {
  if ($null -eq $script:Fixture) { return $p }
  if (-not $p.StartsWith($ProgramData, [StringComparison]::OrdinalIgnoreCase)) { throw 'FIXTURE_PATH_REFUSED' }
  $script:Fixture + $p.Substring($ProgramData.Length)
}
function New-DirectoryExact([string]$path, [string]$sddl) {
  $p = Get-MappedPath $path
  if ([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)) { throw ('DIRECTORY_APPEARED_SINCE_PLAN:' + $path) }
  $parent = [IO.Path]::GetDirectoryName($p)
  if (-not [IO.Directory]::Exists($parent) -or (((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw ('DIRECTORY_PARENT_REFUSED:' + $path) }
  # Offline fixture only: a test user cannot set owner BA and needs its own entry to continue (as migrate-acl.ps1 -OfflineFixtureRoot).
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $effective = if ($script:Fixture) { ($sddl -replace '^O:BAG:BA', '') + '(A;OICI;FA;;;' + $me + ')' } else { $sddl }
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm($effective)
  [void][IO.Directory]::CreateDirectory($p, $ds)
  $after = (Get-Acl -LiteralPath $p).Sddl
  $expect = if ($script:Fixture) { $effective } else { $sddl }
  $c = Test-CreatedSddl $after $expect (-not $script:Fixture)
  if ($c -cne 'ok') { throw ('DIRECTORY_READBACK_MISMATCH:' + $path + ':' + $c) }
  $after
}
function Write-NewFile([string]$path, [byte[]]$bytes) {
  $p = Get-MappedPath $path
  $fs = [IO.File]::Open($p, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
  if ((Sha256Bytes ([IO.File]::ReadAllBytes($p))) -cne (Sha256Bytes $bytes)) { throw ('FILE_READBACK_MISMATCH:' + $path) }
}
function Expand-RunnerPackage([byte[]]$zip) {
  Add-Type -AssemblyName System.IO.Compression
  $root = Get-MappedPath $RunnerRoot
  $entries = Get-ZipEntries $zip
  $ms = New-Object IO.MemoryStream(, $zip); $za = New-Object IO.Compression.ZipArchive($ms, [IO.Compression.ZipArchiveMode]::Read)
  try {
    $n = 0
    foreach ($e in @($za.Entries | Sort-Object FullName)) {
      $name = $e.FullName.Replace('/', '\'); if ($name.EndsWith('\')) { continue }
      $target = Join-Path $root $name
      $dir = [IO.Path]::GetDirectoryName($target); if (-not [IO.Directory]::Exists($dir)) { [void][IO.Directory]::CreateDirectory($dir) }   # inherits the runner folder's DACL
      $s = $e.Open(); $buf = New-Object IO.MemoryStream; try { $s.CopyTo($buf) } finally { $s.Dispose() }
      $bytes = $buf.ToArray(); if ((Sha256Bytes $bytes) -cne $entries[$name]) { throw 'RUNNER_PACKAGE_CHANGED' }
      $fs = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
      $n++
    }
    $n
  } finally { $za.Dispose(); $ms.Dispose() }
}
function New-ControllerPassword {
  $b = New-Object byte[] 36; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  'Cc9!' + [Convert]::ToBase64String($b)
}
function New-ControllerAccount([string]$password) {
  if ($script:Fixture) { [void]$script:EffectLog.Add('account-create'); return 'S-1-5-21-1-2-3-1015' }
  $sec = ConvertTo-SecureString -String $password -AsPlainText -Force
  [void](New-LocalUser -Name $AccountName -Password $sec -Description $AccountDescription -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires)
  $sec.Dispose()
  $f = Get-AccountFact
  if ($null -eq $f -or -not $f.enabled -or $f.description -cne $AccountDescription -or -not $f.passwordNeverExpires -or $f.userMayChangePassword -or @($f.groups).Count) { throw 'CONTROLLER_ACCOUNT_READBACK_MISMATCH' }
  $f.sid
}
function Reset-ControllerPassword([string]$password) {
  if ($script:Fixture) { [void]$script:EffectLog.Add('account-password-reset'); return }
  $sec = ConvertTo-SecureString -String $password -AsPlainText -Force
  Set-LocalUser -Name $AccountName -Password $sec; $sec.Dispose()
}
function New-ControllerService([string]$name, [string]$password) {
  if ($script:Fixture) { [void]$script:EffectLog.Add('service-create:' + $name); return }
  # New-Service hands the credential to CreateService through the API (no command line, nothing compiled). It does not start the service.
  $sec = ConvertTo-SecureString -String $password -AsPlainText -Force
  $cred = New-Object Management.Automation.PSCredential(('.\' + $AccountName), $sec)
  [void](New-Service -Name $name -BinaryPathName $OriginalBinary -DisplayName $ServiceDisplayName -StartupType Manual -Credential $cred)
  $sec.Dispose()
}
# The runner's configure reads ACTIONS_RUNNER_INPUT_<ARG> from its environment (Runner.Listener CommandSettings; the prefix is present in
# the pinned 2.337.0 Runner.Listener.dll). Only that child gets the token, so it is on no command line (review r1 MAJOR-3). If a runner
# ever ignored it, the unattended configure would fail for want of a token: a clean RUNNER_REGISTRATION_FAILED.
function Invoke-RunnerRegistration($step, [string]$token) {
  if ($script:Fixture) { [void]$script:EffectLog.Add('runner-register:' + $step.name + ':' + ($step.labels -join ',')); return }
  $labels = ($step.labels | Where-Object { @('self-hosted', 'Windows', 'X64') -cnotcontains $_ }) -join ','
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $RunnerRoot 'bin\Runner.Listener.exe'
  $psi.Arguments = 'configure --unattended --url ' + $step.url + ' --name ' + $step.name + ' --labels ' + $labels + ' --work ' + $step.work + ' --disableupdate'
  $psi.WorkingDirectory = $RunnerRoot; $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables['ACTIONS_RUNNER_INPUT_TOKEN'] = $token
  $proc = [Diagnostics.Process]::Start($psi)
  $stderr = $proc.StandardError.ReadToEndAsync(); $stdout = $proc.StandardOutput.ReadToEnd(); $proc.WaitForExit()
  $psi.EnvironmentVariables.Remove('ACTIONS_RUNNER_INPUT_TOKEN')
  Write-Host (($stdout + $stderr.Result).Replace($token, '<token>'))
  # The token must not have reached the runner's own logs.
  $leak = @(Get-ChildItem -LiteralPath (Join-Path $RunnerRoot '_diag') -File -Force -ErrorAction SilentlyContinue | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($token) })
  if ($leak.Count) { throw ('RUNNER_LOG_CONTAINS_TOKEN:' + $leak[0].Name) }
  if ($proc.ExitCode -ne 0) { throw ('RUNNER_REGISTRATION_FAILED:' + $proc.ExitCode) }
  $r = try { [IO.File]::ReadAllText((Join-Path $RunnerRoot '.runner')) | ConvertFrom-Json } catch { $null }
  if ($null -eq $r -or (Get-Field $r 'agentName') -cne $step.name -or (Get-Field $r 'gitHubUrl') -cne $step.url) { throw 'RUNNER_REGISTRATION_READBACK_MISMATCH' }
}
function Read-RegistrationToken {
  if ($script:Fixture) { return 'FIXTURETOKENAAAAAAAAAAAAAAAA' }
  $sec = Read-Host -AsSecureString 'GitHub runner registration token (typed by the Owner; not shown, not stored)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $t = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $sec.Dispose() }
  if ($t -cnotmatch '^[A-Z0-9]{20,100}\z') { throw 'REGISTRATION_TOKEN_SHAPE_REFUSED' }
  $t
}

function Invoke-NodePrepApply($plan, [byte[]]$zip) {
  $results = New-Object System.Collections.ArrayList
  $todo = @($plan.steps | Where-Object { -not $_.skip })
  $register = @($todo | Where-Object { $_.kind -ceq 'runner-register' })
  $needPassword = @($todo | Where-Object { @('account-create', 'account-password-reset') -ccontains $_.kind }).Count -gt 0
  # Everything that can fail on input is asked before the first write.
  $token = if ($register.Count) { Read-RegistrationToken } else { $null }
  $password = if ($needPassword) { New-ControllerPassword } else { $null }
  $ctrl = $plan.controllerSid
  $current = $null
  try {
    foreach ($s in $plan.steps) {
      $current = $s.id
      $r = [ordered]@{ id = $s.id; skipped = [bool]$s.skip; result = $null }
      if (-not $s.skip) {
        switch -CaseSensitive ($s.kind) {
          'account-create' { $ctrl = New-ControllerAccount $password; $r.result = $ctrl }
          'account-password-reset' { Reset-ControllerPassword $password; $r.result = 'reset' }
          'directory' { $r.result = New-DirectoryExact $s.path ($s.sddl.Replace('{CTRL}', $ctrl)) }
          'runner-extract' { $r.result = Expand-RunnerPackage $zip }
          'file-create' {
            $bytes = if ($s.id -ceq 'runner-package-copy') { $zip } else { (New-Object Text.UTF8Encoding($false)).GetBytes($s.text) }
            Write-NewFile $s.path $bytes; $r.result = Sha256Bytes $bytes }
          'runner-register' { Invoke-RunnerRegistration $s $token; $r.result = 'registered' }
          'service-create' { New-ControllerService $s.name $password; $r.result = 'created' }
          default { throw 'PLAN_STEP_UNKNOWN' }
        }
      }
      [void]$results.Add($r)
    }
  } catch {
    # Review r1 MAJOR-4: a stop part-way says what was done, where it stopped and which account exists, so the field can re-plan.
    $script:Partial = [ordered]@{ controllerSid = $ctrl; completedSteps = @($results); failedStep = $current }
    throw
  } finally { $token = $null; $password = $null }   # drops the references; the strings themselves stay in memory until the process ends
  [ordered]@{ controllerSid = $ctrl; steps = @($results) }
}

# Post-apply checks on the live host: the six paths of the field step 1, the account, our service, every other runner unchanged, and the
# plan computed again from the host as it now is: it must be NOTHING_TO_DO, which re-checks every folder's owner and DACL, the account's
# groups and flags, the runner tree against the package, the package copy, .service and the service configuration (review r1 NIT-5).
function Get-Postconditions($plan, [string]$ctrl, $profile, $entries, [hashtable]$meta) {
  $replan = try { (Get-NodePrepPlan $profile (Get-LiveHostFacts $profile $entries) $meta).status } catch { [string]$_.Exception.Message }
  $svc = @(Get-RunnerServiceFacts)
  $ours = @($svc | Where-Object { $_.name -ceq $plan.profile.runnerService })
  $others = @(foreach ($s in $svc) { if ($s.name -cne $plan.profile.runnerService) { [ordered]@{ name = $s.name; binary = $s.binary; account = $s.account; startMode = $s.startMode } } })
  $q = (& 'C:\Windows\System32\sc.exe' queryex $plan.profile.runnerService | Out-String)
  $acct = Get-AccountFact
  [ordered]@{
    account = ($null -ne $acct -and $acct.sid -ceq $ctrl)
    controlRoot = (Test-Path -LiteralPath $ControlRoot -PathType Container)
    trusted = (Test-Path -LiteralPath (Join-Path $ControlRoot 'trusted') -PathType Container)
    runnerServiceExe = (Test-Path -LiteralPath (Join-Path $RunnerRoot 'bin\RunnerService.exe') -PathType Leaf)
    ciRoot = (Test-Path -LiteralPath $CiRoot -PathType Container)
    formalSpool = (Test-Path -LiteralPath (Join-Path $CiRoot 'formal-spool') -PathType Container)
    state = (Test-Path -LiteralPath (Join-Path $CiRoot 'state') -PathType Container)
    service = ($ours.Count -eq 1 -and $ours[0].binary -ceq $OriginalBinary -and (Test-ServiceAccountIsController $ours[0].account $plan.profile.hostname) -and $ours[0].startMode -ceq 'Manual' -and $ours[0].state -ceq 'Stopped' -and $q -match 'PID\s*:\s*0\b')
    otherServicesUnchanged = ((ConvertTo-Json @($others) -Compress -Depth 4) -ceq (ConvertTo-Json @($plan.untouchedServices) -Compress -Depth 4))
    replanNothingToDo = ($replan -ceq 'NOTHING_TO_DO')
    replanStatus = $replan
  }
}

# ---- WSL observations (dry run, not elevated, never hashed) ----
$WslProbe = @'
echo "user=$(id -un) groups=$(id -Gn | tr ' ' ',')"
systemctl list-units --all --no-legend --plain 'actions.runner.*' 2>/dev/null | awk '{print "unit="$1"/"$3"/"$4}'
systemctl list-unit-files --no-legend 'actions.runner.*' 2>/dev/null | awk '{print "unit="$1"/"$2}'
find /home /opt /srv /root /usr/local /var/lib -maxdepth 4 -name .runner -type f 2>/dev/null | sed 's/^/runnerdir=/'
echo "listeners=$(ps -eo comm= 2>/dev/null | grep -c '^Runner.Listener')"
[ -S /var/run/docker.sock ] && echo "dockersock=yes"
[ -e /run/WSL ] && echo "run_wsl=present"
grep -iA3 '^\[interop\]' /etc/wsl.conf 2>/dev/null | tr '\n' ' ' | sed 's/^/interopconf=/'; echo
'@
# `wsl -l -q` / `wsl -l --running -q` print bare names (UTF-16 with NULs), whatever the display language (review r1 MINOR-4).
function ConvertFrom-WslNames([string]$raw) { @(($raw -replace "`0", '') -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
function Get-WslObservations {
  if (Test-Elevated) { return [ordered]@{ probed = $false; reason = 'elevated: the apply never enters a distribution' } }
  $all = try { ConvertFrom-WslNames (& wsl.exe --list --quiet 2>$null | Out-String) } catch { @() }
  if (-not $all.Count) { return [ordered]@{ probed = $false; reason = 'wsl.exe unavailable or no distribution' } }
  $running = try { ConvertFrom-WslNames (& wsl.exe --list --running --quiet 2>$null | Out-String) } catch { @() }
  $rows = @(foreach ($name in $all) {
      $row = [ordered]@{ name = $name; state = $(if ($running -ccontains $name) { 'Running' } else { 'Stopped' }); probe = $null; hostsRunners = $null }
      if ($row.state -ceq 'Running' -and $row.name -cmatch '^[A-Za-z0-9._-]{1,64}\z') {
        # The probe travels base64-encoded: Windows PowerShell 5.1 does not escape embedded quotes in native arguments.
        $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($WslProbe.Replace("`r`n", "`n")))
        $out = try { (& wsl.exe -d $row.name --exec /bin/sh -c ('echo ' + $b64 + ' | base64 -d | /bin/sh') 2>$null | Out-String) -replace "`0", '' } catch { 'probe-failed' }
        $row.probe = @($out -split "`r?`n" | Where-Object { $_ })
        $row.hostsRunners = [bool]($out -match '(?m)^(unit=|runnerdir=)' -or $out -match '(?m)^listeners=[1-9]')
      } else { $row.probe = @('not probed: distribution not running (not started by this tool)') }
      $row })
  # The answer comes from inside each distribution and may be forged by what runs there: cross-check GitHub's runner list (field guide 0.4).
  [ordered]@{ probed = $true; selfReported = $true; distributions = $rows }
}

if ($DefinitionsOnly) { return }

# ---- Main ----
$out = [ordered]@{ contract = $ReceiptContract; status = 'REFUSED'; apply = [bool]$Apply; code = $null }
$exit = 2
try {
  if (-not $ProfilePath) { throw 'PROFILE_PATH_REQUIRED' }
  if ($OfflineFixtureRoot) {
    if (-not $OfflineHostFacts) { throw 'OFFLINE_FIXTURE_NEEDS_FACTS' }
    $t = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\'); $f = [IO.Path]::GetFullPath($OfflineFixtureRoot).TrimEnd('\')
    if (-not $f.StartsWith($t + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OFFLINE_FIXTURE_OUTSIDE_TEMP_REFUSED' }
    $script:Fixture = $f
  } elseif ($Apply -and $OfflineHostFacts) { throw 'OFFLINE_FACTS_APPLY_REFUSED' }
  $toolBytes = [IO.File]::ReadAllBytes($PSCommandPath)
  $profileBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ProfilePath).ProviderPath)
  $profile = ConvertFrom-PrepProfile $profileBytes
  $zip = $null; $entries = $null; $pkgMeta = $null
  if ($RunnerPackageZip) {
    $zi = Get-Item -LiteralPath $RunnerPackageZip -Force
    if ($zi.PSIsContainer -or (($zi.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $zi.Length -le 0 -or $zi.Length -gt $MaxPackageBytes) { throw 'RUNNER_PACKAGE_FILE_REFUSED' }
    $zip = [IO.File]::ReadAllBytes($zi.FullName)
    if ($zip.Length -ne $zi.Length) { throw 'RUNNER_PACKAGE_FILE_REFUSED' }
    $zsha = Sha256Bytes $zip
    if ($zsha -cne $profile.runnerPackage.sha256) { throw 'RUNNER_PACKAGE_SHA256_MISMATCH' }
    $entries = Get-ZipEntries $zip
    $pkgMeta = [ordered]@{ sha256 = $zsha; bytes = $zip.Length; entries = $entries.Count }
  }
  $meta = @{ toolSha256 = (Sha256Bytes $toolBytes); profileSha256 = (Sha256Bytes $profileBytes); package = $pkgMeta }
  $out.toolSha256 = $meta.toolSha256
  # Any elevated run executes from an admin-only copy (review r1 MAJOR-1); the field guide checks that copy's sha256 against KooYomi first.
  if (-not $script:Fixture -and -not $OfflineHostFacts -and (Test-Elevated)) { Assert-ToolLocation $PSCommandPath }
  if ($Apply) {
    if (-not $ExpectedPlanSha256) { throw 'EXPECTED_PLAN_SHA256_REQUIRED' }
    if (-not $script:Fixture) {
      if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $profile.ownerSid) { throw 'OWNER_ACCOUNT_REQUIRED' }
      if (-not (Test-Elevated)) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
    }
  }
  $facts = if ($OfflineHostFacts) { [IO.File]::ReadAllText($OfflineHostFacts) | ConvertFrom-Json } else { Get-LiveHostFacts $profile $entries }
  $plan = Get-NodePrepPlan $profile $facts $meta
  $planSha = Get-PlanSha256 $plan
  $out.planSha256 = $planSha; $out.plan = $plan
  if (-not $Apply) {
    $out.status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'
    $out.wsl = if ($SkipWslProbe -or $OfflineHostFacts) { [ordered]@{ probed = $false; reason = 'skipped' } } else { Get-WslObservations }
    $exit = 0
  } else {
    if ($planSha -cne $ExpectedPlanSha256) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
    $out.status = 'APPLY_STARTED'
    $done = Invoke-NodePrepApply $plan $zip
    $out.steps = $done.steps; $out.controllerSid = $done.controllerSid
    $derived = Get-DerivedNodeProfile $profile $done.controllerSid
    $out.derivedNodeProfile = $derived
    $out.derivedNodeProfileSha256 = if ($derived) { Sha256Text (ConvertTo-CanonicalJson $derived) } else { $null }
    if ($script:Fixture) { $out.effects = @($script:EffectLog); $out.status = 'NODE_PREPARED_FIXTURE'; $exit = 0 }
    else {
      $post = Get-Postconditions $plan $done.controllerSid $profile $entries $meta; $out.postconditions = $post
      if (@($post.Values | Where-Object { -not $_ }).Count) { $out.status = 'NODE_PREP_POSTCONDITION_FAILED'; $out.code = 'NODE_PREP_POSTCONDITION_FAILED' }
      else { $out.status = 'NODE_PREPARED'; $exit = 0 }
    }
    $out.reminder = 'Nothing was started. The runner service stays Stopped/Manual. Run linux/prepare-node-linux.sh in the distribution the Owner chose.'
  }
} catch {
  $m = [string]$_.Exception.Message
  $out.code = if ($m -cmatch '^[A-Z][A-Z0-9_]{1,79}(:[^\r\n]{0,300})?\z') { $m } else { 'NODE_PREP_UNCONFIRMED' }
  $out.exceptionType = $_.Exception.GetType().Name
  if ($null -ne $script:Partial) {
    # Stopped part-way: what is done is on the host now. Re-plan with an elevated dry run (field guide 0.7) before anything else.
    $out.status = 'APPLY_PARTIAL'; $out.controllerSid = $script:Partial.controllerSid
    $out.completedSteps = $script:Partial.completedSteps; $out.failedStep = $script:Partial.failedStep
  } elseif ($out.status -ceq 'APPLY_STARTED') { $out.status = 'REFUSED' }
}
$out | ConvertTo-Json -Depth 12
if ($out.Contains('planSha256')) { 'PLAN_SHA256=' + $out.planSha256 }
exit $exit
