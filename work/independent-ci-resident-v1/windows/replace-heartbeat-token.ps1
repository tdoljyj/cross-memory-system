<#
.SYNOPSIS
  Owner-elevated tool (Task 1abde401): put in or replace this node's heartbeat token, and nothing else, without a reinstall.

.DESCRIPTION
  install-resident.ps1 places the heartbeat token (DESIGN.md section 41.6a) only on a fresh install and refuses an existing
  target; the upgrade channel never touches secrets\. So adding a token to an installed node, or renewing an expired one, used
  to mean a full reinstall. This tool changes exactly one file, <Root>\secrets\heartbeat\ci-node-heartbeat.token (plus the
  folder, when it is not there yet, and one receipt of its own). It reads no other secret and touches no service, task, other
  secret, install receipt or generation record.

  Default mode is a read-only dry run: it checks everything, prints the plan and the plan's SHA-256, writes nothing.
    -Apply -ExpectedPlanSha256 <sha>   performs exactly that plan. It needs the Owner's own account in an elevated token (UAC) on
                                        this node, and a plan equal to the one reviewed.
    -TokenFile <path>                   a file holding the new token, read once (a regular file, no link, 1..4096 bytes): exactly
                                        clued_hbt_ + 43 base64url characters, with at most ONE trailing line end (LF or CRLF). Any
                                        other whitespace, a BOM, another prefix (the ci-admission and the resident-upgrade tokens are
                                        clued_bnd_ tokens) or another length is refused. Same as the installed token: refused as a
                                        no-op unless -AllowSameToken. The downloaded copy is the Owner's to delete; this tool never
                                        deletes the source.
    -ConnectionId <uuid>                optional, informational: the heartbeat connection's id (KooYomi /bindings/failover). It is
                                        recorded in THIS tool's receipt only. The install receipt (install\install-receipt.json) is
                                        NOT updated: upgrade\current.json and the generation records pin its SHA-256, so editing it
                                        would break the in-place upgrade channel and verify-resident.ps1's generation-current check.
                                        verify-resident.ps1's heartbeat-binding therefore keeps reporting the id of the install.

  What it does with -Apply (nothing is deleted, as in the installer):
    1. Re-derives the plan; PLAN_CHANGED_SINCE_REVIEW unless it equals -ExpectedPlanSha256.
    2. Writes the new token create-only to a temporary file in secrets\heartbeat\ with the install's final file descriptor from the
       first moment (owner Administrators, protected DACL: SYSTEM and Administrators full, the Owner read-only), flushes through,
       reads the descriptor and the bytes back.
    3. Existing token: it is renamed to ci-node-heartbeat.token.replaced-<UTC> (kept, with its own unchanged descriptor, the way
       the installer keeps whatever it renames; the Owner deletes it when the old connection is revoked) and the new file is
       renamed onto the target; if that second rename fails the first is undone. Two renames, not [IO.File]::Replace: Replace
       re-labels the target's DACL auto-inherited (D:PAI), which verify-resident.ps1 would report as a wrong descriptor. For the
       microseconds between the renames the target is absent; the companion reads per beat and skips a beat without a token. No
       token yet: [IO.File]::Move (which cannot overwrite). Then the target's descriptor and bytes are read back again.
    4. Writes the receipt create-only at install\heartbeat-token-replace-<opId>.json: contract, opId, time, plan SHA-256, whether a
       token existed, the name of the kept copy, the token's length (53), the descriptor and the connection id. It holds no token
       bytes and no hash or fingerprint of the token.
  Every refusal and every failure zeroes every secret buffer it held (Clear-HeldBytes, in the finally of the one function that reads
  the token); the output, the plan and the receipt never contain token bytes.

  Refused (codes): link or reparse point anywhere from <Root> down to the token file, a missing <Root>\secrets or <Root>\install, a
  heartbeat folder that is not exactly the install's folder descriptor (HEARTBEAT_TOKEN_DIRECTORY_ACL_MISMATCH), a token file that
  is not the install's file descriptor when one exists, a source file inside <Root>\secrets\, a stray temporary file, a missing or
  unreadable node profile (record\acceptance.json).

  The companion (src/companion-heartbeat.mjs readHeartbeatToken, called by CompanionHeartbeat.step on EVERY beat) reads the file fresh
  each time, so a RENEWED token is used by the next beat with no restart. A FIRST token is different: src/companion-main.mjs builds
  the heartbeat lane only if a token can be read when the companion starts, so after adding the first token the companion must be
  restarted (Owner: end and start the CluedCIResidentCompanion task, or log off and on). The result says so (companionRestartNeeded).
  The Owner still links the connection on /bindings/failover (two-step confirmation); this tool makes no network call.

  The functions are dot-sourceable for the offline tests (test\test_replace_heartbeat_token.py): their path, owner and descriptor
  parameters exist only for those tests; the script body below never passes them.
#>
[CmdletBinding()]
param(
  [string]$TokenFile,
  [switch]$Apply,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedPlanSha256,
  [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z')][string]$ConnectionId,
  [switch]$AllowSameToken
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$DefaultRoot = 'C:\ProgramData\CluedIndependentCI\resident'
$ReceiptContract = 'clued.independent-ci.heartbeat-token-replace/1'
$TokenLength = 53   # 'clued_hbt_' + 43
# ---- Shared with install-resident.ps1 (test_replace_heartbeat_token.py holds the copies identical) ----
function Get-HeartbeatDirectorySddl([string]$owner) { 'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $owner + ')' }
function Get-HeartbeatFileSddl([string]$owner) { 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x120089;;;' + $owner + ')' }
function Get-DaclPart([string]$sd) { $t = ([string]$sd).Trim(); $i = $t.IndexOf('D:'); if ($i -lt 0) { return $t }; $t = $t.Substring($i); $j = $t.IndexOf('S:'); if ($j -ge 0) { $t = $t.Substring(0, $j) }; $t }
function Sha256Bytes([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Sha256Text([string]$t) { Sha256Bytes ([Text.Encoding]::UTF8.GetBytes($t)) }
function Test-HeartbeatDirectoryAcl([string]$path, [string]$sddl, [string]$ownerSid = 'S-1-5-32-544') {
  $item = Get-Item -LiteralPath $path -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
  $want = New-Object Security.AccessControl.DirectorySecurity
  $want.SetSecurityDescriptorSddlForm($sddl)
  $back = Get-Acl -LiteralPath $path
  ($back.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $ownerSid) -and ((Get-DaclPart $back.Sddl) -ceq (Get-DaclPart $want.GetSecurityDescriptorSddlForm('Access')))
}
function Test-HeartbeatFileAcl([string]$path, [string]$sddl, [string]$ownerSid = 'S-1-5-32-544') {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
  $want = New-Object Security.AccessControl.FileSecurity
  $want.SetSecurityDescriptorSddlForm($sddl)
  $back = Get-Acl -LiteralPath $path
  ($back.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $ownerSid) -and ((Get-DaclPart $back.Sddl) -ceq (Get-DaclPart $want.GetSecurityDescriptorSddlForm('Access')))
}

# ---- Secret buffers: every array that may hold token bytes is registered here and zeroed by the one finally that owns it ----
$script:Held = New-Object Collections.ArrayList
function Hold-Bytes([byte[]]$bytes) { [void]$script:Held.Add($bytes); ,$bytes }
function Clear-HeldBytes {
  foreach ($b in @($script:Held)) { if ($null -ne $b) { [Array]::Clear($b, 0, $b.Length) } }
  # Test hook: the offline tests look at the arrays that were cleared.
  if (Test-Path variable:script:ClearedForTest) { foreach ($b in @($script:Held)) { [void]$script:ClearedForTest.Add($b) } }
  $script:Held.Clear()
}

# One supplied file, read once: a regular file (no directory, no link), 1..$maximum bytes, unchanged while read.
function Read-SecretSource([string]$path, [int]$maximum, [string]$code) {
  $full = try { [IO.Path]::GetFullPath($path) } catch { throw ($code + '_SOURCE_REFUSED') }
  if ($full -cnotmatch '^[A-Za-z]:\\') { throw ($code + '_SOURCE_REFUSED') }
  $item = try { Get-Item -LiteralPath $full -Force -ErrorAction Stop } catch { throw ($code + '_SOURCE_REFUSED') }
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw ($code + '_SOURCE_REFUSED') }
  $s = [IO.File]::Open($full, 'Open', 'Read', 'Read')
  try {
    if ($s.Length -lt 1 -or $s.Length -gt $maximum) { throw ($code + '_SOURCE_REFUSED') }
    $bytes = Hold-Bytes (New-Object byte[] ([int]$s.Length)); $at = 0
    while ($at -lt $bytes.Length) { $n = $s.Read($bytes, $at, $bytes.Length - $at); if ($n -lt 1) { throw ($code + '_SOURCE_REFUSED') }; $at += $n }
    if ($s.ReadByte() -ne -1) { throw ($code + '_SOURCE_REFUSED') }
  } finally { $s.Dispose() }
  return ,$bytes
}

# The token bytes from the raw file bytes: at most ONE trailing line end removed, then exactly clued_hbt_ + 43 [A-Za-z0-9_-].
# Checked byte by byte (no string of the token is ever made). Returns a new held array; throws a code and never a byte.
function ConvertTo-HeartbeatTokenBytes([byte[]]$raw) {
  $n = $raw.Length
  if ($n -ge 2 -and $raw[$n - 2] -eq 13 -and $raw[$n - 1] -eq 10) { $n -= 2 } elseif ($n -ge 1 -and $raw[$n - 1] -eq 10) { $n -= 1 }
  $prefix = [Text.Encoding]::ASCII.GetBytes('clued_hbt_')
  $other = [Text.Encoding]::ASCII.GetBytes('clued_bnd_')
  $isOther = $n -ge $other.Length
  if ($isOther) { for ($i = 0; $i -lt $other.Length; $i++) { if ($raw[$i] -ne $other[$i]) { $isOther = $false; break } } }
  # The ci-admission token and the resident-upgrade token are both clued_bnd_ tokens: never a heartbeat token.
  if ($isOther) { throw 'HEARTBEAT_TOKEN_IS_NOT_A_HEARTBEAT_TOKEN' }
  if ($n -ne $TokenLength) { throw 'HEARTBEAT_TOKEN_SHAPE_REFUSED' }
  for ($i = 0; $i -lt $prefix.Length; $i++) { if ($raw[$i] -ne $prefix[$i]) { throw 'HEARTBEAT_TOKEN_SHAPE_REFUSED' } }
  for ($i = $prefix.Length; $i -lt $n; $i++) {
    $c = $raw[$i]
    $ok = ($c -ge 48 -and $c -le 57) -or ($c -ge 65 -and $c -le 90) -or ($c -ge 97 -and $c -le 122) -or $c -eq 45 -or $c -eq 95
    if (-not $ok) { throw 'HEARTBEAT_TOKEN_SHAPE_REFUSED' }
  }
  $token = Hold-Bytes (New-Object byte[] $n)
  [Array]::Copy($raw, 0, $token, 0, $n)
  return ,$token
}
# Whether two token files hold the same token (the runtime trims ASCII whitespace at both ends; so does this).
function Test-SameToken([byte[]]$a, [byte[]]$b) {
  $trim = { param([byte[]]$x) $s = 0; $e = $x.Length; while ($s -lt $e -and ($x[$s] -le 32)) { $s++ }; while ($e -gt $s -and ($x[$e - 1] -le 32)) { $e-- }; ,@($s, $e) }
  $ra = & $trim $a; $rb = & $trim $b
  $la = $ra[1] - $ra[0]; $lb = $rb[1] - $rb[0]
  if ($la -ne $lb) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $la; $i++) { $diff = $diff -bor ($a[$ra[0] + $i] -bxor $b[$rb[0] + $i]) }
  $diff -eq 0
}

# Every directory from $root (inclusive) down to $path (inclusive) that exists is a real directory, no link. A missing
# directory ends the walk (returns the number that exist). $path itself must be a descendant of $root.
function Get-ExistingChainLength([string]$root, [string]$path) {
  if ($path -cne $root -and -not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'PATH_OUTSIDE_ROOT' }
  $dirs = New-Object Collections.ArrayList
  [void]$dirs.Add($root)
  if ($path.Length -gt $root.Length) { $c = $root; foreach ($seg in $path.Substring($root.Length + 1).Split('\')) { $c = Join-Path $c $seg; [void]$dirs.Add($c) } }
  $count = 0
  foreach ($d in $dirs) {
    $item = try { Get-Item -LiteralPath $d -Force -ErrorAction Stop } catch { $null }
    if ($null -eq $item) { break }
    if (-not $item.PSIsContainer) { throw ('DIRECTORY_EXPECTED:' + (Split-Path -Leaf $d)) }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('LINK_REFUSED:' + (Split-Path -Leaf $d)) }
    $count++
  }
  $count
}

# The node's accounts, from the installed record (record\acceptance.json, node), the same source upgrade-apply.ps1 uses.
function Get-InstalledNode([string]$root) {
  $file = Join-Path $root 'record\acceptance.json'
  $item = try { Get-Item -LiteralPath $file -Force -ErrorAction Stop } catch { $null }
  if ($null -eq $item -or $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $item.Length -gt 4194304) { throw 'NODE_PROFILE_UNREADABLE' }
  $accepted = try { (New-Object Text.UTF8Encoding($false, $true)).GetString([IO.File]::ReadAllBytes($file)) | ConvertFrom-Json } catch { throw 'NODE_PROFILE_UNREADABLE' }
  $node = if (@($accepted.PSObject.Properties.Name) -ccontains 'node') { $accepted.node } else { $null }
  $sid = '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z'
  if ($null -eq $node -or [string]$node.ownerSid -cnotmatch $sid -or [string]$node.hostname -cnotmatch '^[A-Z0-9](?:[A-Z0-9-]{0,13}[A-Z0-9])?\z') { throw 'NODE_PROFILE_UNREADABLE' }
  $node
}

# The plan: read-only. Nothing in it is, or is derived from, the token except its (fixed) length and two booleans.
# $tokenBytes: the new token (held); $existing: the installed token's bytes (held) or $null.
function Get-HeartbeatReplacePlan([string]$root, [string]$tokenFile, [string]$connectionId, [bool]$allowSame, [bool]$tokenFileGiven,
    [string]$directorySddl, [string]$fileSddl, [string]$directoryOwnerSid, [byte[]]$tokenBytes, [byte[]]$existing) {
  $node = Get-InstalledNode $root
  $dir = Join-Path $root 'secrets\heartbeat'
  $target = Join-Path $dir 'ci-node-heartbeat.token'
  $secrets = Join-Path $root 'secrets'
  # n counts the existing directories of the chain root, secrets, heartbeat (the token itself is a file).
  $n = Get-ExistingChainLength $root $dir
  if ($n -lt 2) { throw 'HEARTBEAT_TOKEN_SECRETS_DIRECTORY_MISSING' }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'install') -PathType Container)) { throw 'INSTALL_DIRECTORY_MISSING' }
  $dirExists = ($n -ge 3)
  if ($dirExists -and -not (Test-HeartbeatDirectoryAcl $dir $directorySddl $directoryOwnerSid)) { throw 'HEARTBEAT_TOKEN_DIRECTORY_ACL_MISMATCH' }
  $targetExists = $false
  if ($dirExists) {
    $ti = try { Get-Item -LiteralPath $target -Force -ErrorAction Stop } catch { $null }
    if ($null -ne $ti) {
      if ($ti.PSIsContainer -or (($ti.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'HEARTBEAT_TOKEN_TARGET_REFUSED' }
      if (-not (Test-HeartbeatFileAcl $target $fileSddl $directoryOwnerSid)) { throw 'HEARTBEAT_TOKEN_FILE_ACL_MISMATCH' }
      $targetExists = $true
    }
    if (@(Get-ChildItem -LiteralPath $dir -Force -Filter 'ci-node-heartbeat.token.new-*').Count -ne 0) { throw 'HEARTBEAT_TOKEN_STRAY_TEMPORARY_FILE' }
  }
  $same = $false
  if ($tokenFileGiven) {
    $src = [IO.Path]::GetFullPath($tokenFile)
    if ($src.StartsWith($secrets + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'HEARTBEAT_TOKEN_SOURCE_INSIDE_SECRETS' }
    if ($targetExists) {
      if ($null -eq $existing) { throw 'HEARTBEAT_TOKEN_TARGET_REFUSED' }
      $same = Test-SameToken $tokenBytes $existing
      if ($same -and -not $allowSame) { throw 'HEARTBEAT_TOKEN_SAME_AS_INSTALLED_NOTHING_TO_DO' }
    }
  }
  [ordered]@{ contract = 'clued.independent-ci.heartbeat-token-replace-plan/1'; root = $root; target = $target; directory = $dir
    nodeOwnerSid = [string]$node.ownerSid; nodeHostname = [string]$node.hostname
    tokenSupplied = $tokenFileGiven; tokenLength = $(if ($tokenFileGiven) { $TokenLength } else { $null })
    directoryExists = $dirExists; createsDirectory = ($tokenFileGiven -and -not $dirExists); directorySddl = $directorySddl; fileSddl = $fileSddl
    targetExists = $targetExists; replacesExisting = ($tokenFileGiven -and $targetExists); sameAsInstalled = $same
    keepsOldCopyAs = $(if ($tokenFileGiven -and $targetExists) { 'ci-node-heartbeat.token.replaced-<UTC>' } else { $null })
    connectionId = $(if ($connectionId) { $connectionId.ToLowerInvariant() } else { $null }); installReceiptUpdated = $false
    companionRestartNeeded = ($tokenFileGiven -and -not $targetExists); touchesOnly = @($target, 'install\heartbeat-token-replace-<opId>.json'); deletesAnything = $false }
}

function New-DirectoryWithAcl([string]$path, [string]$sddl) {
  if (Test-Path -LiteralPath $path) { throw ('DIRECTORY_EXISTS:' + (Split-Path -Leaf $path)) }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm($sddl)
  $null = [IO.Directory]::CreateDirectory($path, $acl)
  $back = (Get-Acl -LiteralPath $path).Sddl
  if ($back -cne $acl.GetSecurityDescriptorSddlForm('All')) { throw ('ACL_READBACK_MISMATCH:' + (Split-Path -Leaf $path)) }
}
# Create-only, with the final descriptor from the first moment, flushed through, then read back (descriptor and bytes).
function Write-NewSecret([string]$path, [byte[]]$bytes, [string]$sddl, [string]$ownerSid) {
  $sec = New-Object Security.AccessControl.FileSecurity
  $sec.SetSecurityDescriptorSddlForm($sddl)
  $f = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough, $sec)
  try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
  Assert-SecretFile $path $bytes $sddl $ownerSid
}
function Assert-SecretFile([string]$path, [byte[]]$bytes, [string]$sddl, [string]$ownerSid) {
  if (-not (Test-HeartbeatFileAcl $path $sddl $ownerSid)) { throw 'HEARTBEAT_TOKEN_ACL_READBACK_MISMATCH' }
  $back = Hold-Bytes ([IO.File]::ReadAllBytes($path))
  if ($back.Length -ne $bytes.Length -or -not (Test-SameToken $back $bytes)) { throw 'HEARTBEAT_TOKEN_READBACK_MISMATCH' }
  [Array]::Clear($back, 0, $back.Length)
}
function Write-NewFile([string]$path, [byte[]]$bytes) {
  $f = [IO.File]::Open($path, 'CreateNew', 'Write', 'None'); try { $f.Write($bytes, 0, $bytes.Length); $f.Flush($true) } finally { $f.Dispose() }
}

# The one function that reads the token. Dry run (no -Apply): returns the plan view. -Apply: performs it. Throws a code.
# $Elevated, $CurrentSid, $Machine, $DirectorySddl, $FileSddl, $DirectoryOwnerSid: defaults are the real ones; only the tests pass them.
function Invoke-HeartbeatTokenReplace {
  [CmdletBinding()]
  param([string]$Root = $DefaultRoot, [string]$TokenFile, [switch]$Apply, [string]$ExpectedPlanSha256, [string]$ConnectionId, [switch]$AllowSameToken,
    $Elevated = $null, [string]$CurrentSid = $null, [string]$Machine = $null, [string]$DirectorySddl = $null, [string]$FileSddl = $null, [string]$DirectoryOwnerSid = 'S-1-5-32-544')
  $tmp = $null
  try {
    if ($Root -cnotmatch '^[A-Za-z]:\\' -or $Root.EndsWith('\')) { throw 'ROOT_REFUSED' }
    if ($ExpectedPlanSha256 -and $ExpectedPlanSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'EXPECTED_PLAN_SHA256_REFUSED' }
    if ($ConnectionId -and $ConnectionId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z') { throw 'CONNECTION_ID_REFUSED' }
    if ($Apply -and -not $TokenFile) { throw 'TOKEN_FILE_REQUIRED_FOR_APPLY' }
    if ($ConnectionId -and -not $TokenFile) { throw 'CONNECTION_ID_REQUIRES_TOKEN_FILE' }
    if ($null -eq $CurrentSid) { $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    if ($null -eq $Machine) { $Machine = [Environment]::MachineName }
    if ($null -eq $Elevated) { $Elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
    if ((Get-ExistingChainLength $Root $Root) -ne 1) { throw 'ROOT_MISSING' }
    $node = Get-InstalledNode $Root
    if (-not $DirectorySddl) { $DirectorySddl = Get-HeartbeatDirectorySddl $node.ownerSid }
    if (-not $FileSddl) { $FileSddl = Get-HeartbeatFileSddl $node.ownerSid }
    $tokenBytes = $null; $existing = $null
    if ($TokenFile) {
      if (-not $Elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED_FOR_SECRETS' }
      $raw = Read-SecretSource $TokenFile 4096 'HEARTBEAT_TOKEN'
      $tokenBytes = ConvertTo-HeartbeatTokenBytes $raw
      $target = Join-Path $Root 'secrets\heartbeat\ci-node-heartbeat.token'
      if ((Get-ExistingChainLength $Root (Split-Path -Parent $target)) -ge 3 -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        $existing = Read-SecretSource $target 4096 'HEARTBEAT_TOKEN_INSTALLED'
      }
    }
    $plan = Get-HeartbeatReplacePlan $Root $TokenFile $ConnectionId ([bool]$AllowSameToken) ([bool]$TokenFile) $DirectorySddl $FileSddl $DirectoryOwnerSid $tokenBytes $existing
    $planSha = Sha256Text ($plan | ConvertTo-Json -Depth 8)
    if (-not $Apply) { return [ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = $planSha; plan = $plan } }

    # ---- Apply ----
    if (-not $Elevated) { throw 'ELEVATED_OWNER_TOKEN_REQUIRED' }
    if ($CurrentSid -cne $plan.nodeOwnerSid) { throw 'OWNER_ACCOUNT_REQUIRED' }
    if ($Machine -cne $plan.nodeHostname) { throw 'NODE_HOST_REQUIRED' }
    if ($ExpectedPlanSha256 -cne $planSha) { throw 'PLAN_CHANGED_SINCE_REVIEW' }
    $dir = $plan.directory; $target = $plan.target
    $opId = [guid]::NewGuid().ToString()
    $stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $receiptPath = Join-Path $Root ('install\heartbeat-token-replace-' + $opId + '.json')
    if (Test-Path -LiteralPath $receiptPath) { throw 'RECEIPT_EXISTS' }
    if ($plan.createsDirectory) { New-DirectoryWithAcl $dir $DirectorySddl }
    $tmp = Join-Path $dir ('ci-node-heartbeat.token.new-' + [guid]::NewGuid().ToString('N'))
    Write-NewSecret $tmp $tokenBytes $FileSddl $DirectoryOwnerSid
    $kept = $null
    if ($plan.targetExists) {
      # Two renames, not [IO.File]::Replace: Replace re-labels the target's DACL as auto-inherited (D:PAI instead of D:P), which
      # verify-resident.ps1's heartbeat-token-acl would report as FILE_ACL. A rename keeps each file's descriptor exactly. The
      # target is absent for the time between the two renames (microseconds); the companion reads per beat and treats an absent
      # file as "no token" for that beat. If the second rename fails the first is undone.
      $kept = 'ci-node-heartbeat.token.replaced-' + $stamp
      $keptPath = Join-Path $dir $kept
      [IO.File]::Move($target, $keptPath)
      try { [IO.File]::Move($tmp, $target) } catch { [IO.File]::Move($keptPath, $target); throw }
    } else {
      [IO.File]::Move($tmp, $target)
    }
    $tmp = $null
    Assert-SecretFile $target $tokenBytes $FileSddl $DirectoryOwnerSid
    $receipt = [ordered]@{ contract = $ReceiptContract; opId = $opId; at = [DateTimeOffset]::UtcNow.ToString('o'); planSha256 = $planSha
      target = $target; hadToken = [bool]$plan.targetExists; keptOldCopyAs = $kept; tokenLength = $TokenLength
      fileSddl = $FileSddl; directoryCreated = [bool]$plan.createsDirectory; connectionId = $plan.connectionId; installReceiptUpdated = $false }
    Write-NewFile $receiptPath ((New-Object Text.UTF8Encoding($false)).GetBytes(($receipt | ConvertTo-Json -Depth 5 -Compress)))
    return [ordered]@{ status = 'HEARTBEAT_TOKEN_PLACED'; opId = $opId; planSha256 = $planSha; replaced = [bool]$plan.targetExists; keptOldCopyAs = $kept
      receipt = $receiptPath; connectionId = $plan.connectionId; companionRestartNeeded = [bool]$plan.companionRestartNeeded; installReceiptUpdated = $false }
  } finally {
    if ($tmp -and (Test-Path -LiteralPath $tmp)) {
      # Our own half-made copy of the NEW token (never an installed file): zero it, then remove it.
      try { $f = [IO.File]::Open($tmp, 'Open', 'Write', 'None'); try { $z = New-Object byte[] ([int]$f.Length); $f.Write($z, 0, $z.Length); $f.Flush($true) } finally { $f.Dispose() } } catch { }
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
    Clear-HeldBytes
  }
}

# Dot-sourced (the offline tests): only the functions above.
if ($MyInvocation.InvocationName -eq '.') { return }
try {
  $args2 = @{ TokenFile = $TokenFile; ExpectedPlanSha256 = $ExpectedPlanSha256; ConnectionId = $ConnectionId }
  $r = Invoke-HeartbeatTokenReplace @args2 -Apply:$Apply -AllowSameToken:$AllowSameToken
  $r | ConvertTo-Json -Depth 10
  exit 0
} catch {
  # A fixed code, never a message that could carry bytes.
  $m = [string]$_.Exception.Message
  $code = if ($m -cmatch '^([A-Z][A-Z0-9_]{2,80})(?::[A-Za-z0-9_.-]{1,200})?\z') { $m } else { 'HEARTBEAT_TOKEN_REPLACE_FAILED' }
  [ordered]@{ status = 'REFUSED'; code = $code } | ConvertTo-Json -Compress
  exit 1
}
