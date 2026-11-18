<#
.SYNOPSIS
  Verification of an installed resident executor (DRAFT). Writes nothing, with one exception: run as SYSTEM (the upgrade channel's
  VERIFY step), on a node whose companion runs as its own account, it first appends the companion's relay-parent ACE if it is missing
  (Invoke-CompanionRelayParentsEnsure, install-resident.ps1's own rule, hash-pinned by this generation's resident manifest).
  Run by hand, elevated or not, it never writes.

.DESCRIPTION
  Run the INSTALLED copy (C:\ProgramData\CluedIndependentCI\resident\resident\<sha>\windows\).
  Re-derives every pin of the install receipt (admin-only install\ directory) and compares it with
  the live host: package hashes, both services (account, start type, SID type, failure actions,
  DACL as recorded at install, required privileges via `sc qprivs`, the effective token privileges each host
  recorded at start, the broker's binary path with its config-hash argument and broker.json against that
  hash, the broker's failure actions, the resident's outbound firewall block and the firewall being on),
  the runner service byte-for-byte unchanged (SDDL, binary, account), the companion task
  (principal, LeastPrivilege, trigger), the receipt chain and the HALT / PAUSE latches.
  Node identity (resident active/standby design v0.4 section 9 C7, DESIGN.md section 30): the receipt's node identity (node name,
  App key id and fingerprint, token fingerprint, connection id, formal qualification refs) is re-derived from the installed record
  (record\installation.json and record\acceptance.json, both hash-pinned by the receipt, which must agree with each other) and
  compared; the receipt assumes no role. The node heartbeat (DESIGN.md section 41.6a): secrets\heartbeat\ and its token file have the
  install's ACL (heartbeat-token-acl), and heartbeat-binding reports the heartbeat connection id the receipt recorded (no network).
  The App key and the ci-admission token files are checked for existence and security (owner an administrator principal, readable by SYSTEM, Administrators and the pinned controller only, no write for the
  controller); so are the folders that hold them (CluedControl\trusted, CluedIndependentCI\secrets) and every ancestor up to the drive
  root, by the runtime's own rule (runtime/verify-install-acl.ps1): administrator owners and protected ancestors.
  自检读回 CI 令牌并核验当前指纹。安装时的身份与当前连接分别报告。
  First HALT of 2026-10-29 (DESIGN.md section 33): the companion's relay and bundle scripts (config\companion.json) lie under the installed
  CI Source, source\<SHA-256 of record\source-manifest.json>\, and exist there; and the CI root C:\ProgramData\CluedIndependentCI carries the
  resident service's one READ_CONTROL entry (0x120080, this folder only), read from the live ACL.
  Upgrade channel (018da927): receipts /5 and /6 are both accepted. A /6 receipt (written by install-resident.ps1 or by CluedCIUpgrader)
  adds upgrader-service (LocalSystem, delayed-auto, SeChangeNotify only, the receipt's DACL, running, its own token record minimal),
  upgrader-pin (host, node, config and entry pins of the command line, upgrade-apply.ps1 present, upgrader\ and the resident-upgrade token
  for SYSTEM and Administrators only), generation-current (upgrade\current.json and generations\g<N>\generation.json agree with the receipt,
  the live command lines, the companion task and the generation's files) and two-sides-consistent (the Linux version facts: -LinuxVersionFactsFile,
  or upgrade\mailbox\responses\version-facts.json no older than 15 minutes). -ExpectPausedSha256: the resident is expected paused by exactly
  that PAUSED.json (the upgrader verifies a paused resident): 'paused-as-expected' replaces 'not-paused'.
  Prints one JSON verdict; exit 0 only if every check passes. Elevated for the complete check
  (service DACLs need READ_CONTROL); a non-elevated run reports those as unreadable and exits 2.
#>
[CmdletBinding(DefaultParameterSetName='Verify')]
param([Parameter(Mandatory,ParameterSetName='Verify')][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedInstallReceiptSha256,
  [Parameter(Mandatory,ParameterSetName='Functions')][switch]$FunctionsOnly,
  [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectPausedSha256,
  [string]$LinuxVersionFactsFile)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Sc = 'C:\Windows\System32\sc.exe'
# This node's runner service and host: the installed record's node profile (record\acceptance.json `node`, admin-only,
# validated by the install; design section 9 C1). The name is still held to its fixed shape before it reaches sc.exe.
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

# 与 Source v2 的解析器使用同一组字节夹具。安装回执始终按安装时的身份核验。
function Get-EffectiveCiPrincipal($identity, [byte[]]$bytes) {
  if ($null -eq $bytes) {
    return [pscustomobject]@{ bindingId = $identity.ciPrincipalBindingId; tokenPinSha256 = $identity.ciTokenPinSha256; generation = $null; receiptId = $null }
  }
  try {
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 4096) { throw 'size' }
    $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
    $v = $text | ConvertFrom-Json
    $keys = @('activatedAt','baseNodeIdentitySha256','bindingGeneration','bindingId','contract','previousSha256','rebindReceiptId','tokenPinSha256')
    if ($v -isnot [pscustomobject] -or @($v.PSObject.Properties).Count -ne $keys.Length) { throw 'keys' }
    foreach ($key in $keys) { if (@($v.PSObject.Properties.Name) -cnotcontains $key) { throw 'keys' } }
    $uuid = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z'; $hash = '^[0-9a-f]{64}\z'
    foreach ($key in @('bindingId','rebindReceiptId')) {
      if ($v.$key -isnot [string] -or $v.$key -cnotmatch $uuid) { throw 'id' }
    }
    if ($v.contract -cne 'clued.independent-ci.ci-connection/1' -or $v.tokenPinSha256 -isnot [string] -or $v.tokenPinSha256 -cnotmatch $hash -or
        $v.baseNodeIdentitySha256 -cne (Sha256Text (ConvertTo-NodeIdentityCanonical $identity)) -or
        ($null -ne $v.previousSha256 -and ($v.previousSha256 -isnot [string] -or $v.previousSha256 -cnotmatch $hash)) -or
        ($v.bindingGeneration -isnot [int] -and $v.bindingGeneration -isnot [long]) -or $v.bindingGeneration -lt 1 -or $v.bindingGeneration -gt 9007199254740991) { throw 'fields' }
    $format = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'"
    $at = [DateTime]::ParseExact($v.activatedAt, $format, [Globalization.CultureInfo]::InvariantCulture)
    if ($at.ToString($format, [Globalization.CultureInfo]::InvariantCulture) -cne $v.activatedAt) { throw 'date' }
    $ordered = [ordered]@{}
    foreach ($key in $keys) { $ordered[$key] = $v.$key }
    if (($ordered | ConvertTo-Json -Compress) -cne $text) { throw 'canonical' }
    [pscustomobject]@{ bindingId = $v.bindingId; tokenPinSha256 = $v.tokenPinSha256; generation = $v.bindingGeneration; receiptId = $v.rebindReceiptId }
  } catch { throw 'CI_CONNECTION_RECORD_REFUSED' }
}

# ---- Verify-only helpers for the node identity and the two secret files (DESIGN.md section 30) ----
function Sha256Text([string]$t) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Get-Field($o, [string]$k) { if (($o -is [pscustomobject]) -and (@($o.PSObject.Properties.Name) -ccontains $k)) { $o.$k } else { $null } }
# Where the runtime reads the two controller secrets (the same literals as install-resident.ps1).
$SecretTargets = [ordered]@{ appKey = 'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem'; ciToken = 'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token' }
$SecretAdmins = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
# The runtime's rule for a private secret file (runtime/verify-install-acl.ps1, -ReadFile), plus: the pinned controller can read it.
# The owner is an administrator principal; only an administrator principal holds a write, delete or permission right; nobody but an
# administrator principal and the controller can read data; the controller holds no write right. $acl: the file's security object.
function Test-SecretFileSecurity($acl, [string]$controllerSid) {
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000
  if ($SecretAdmins -cnotcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
  $controllerReads = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ([string]$rule.AccessControlType -cne 'Allow' -or (([int]$rule.PropagationFlags -band 2) -ne 0)) { continue }
    $sid = $rule.IdentityReference.Value; $rights = [int]$rule.FileSystemRights; $admin = $SecretAdmins -ccontains $sid
    if ((($rights -band $write) -ne 0) -and -not $admin) { return $false }
    if ((($rights -band 0x1) -ne 0) -and -not $admin -and $sid -cne $controllerSid) { return $false }
    if ($sid -ceq $controllerSid -and (($rights -band 0x1) -ne 0)) { $controllerReads = $true }
  }
  return $controllerReads
}
# The runtime's rule (runtime/verify-install-acl.ps1, -ReadFile) for the folders that hold a secret and every ancestor up to the drive root.
# $items run from the drive root down: @{ acl = <security object>; protected = <at or under the protected root, the folder above the secret
# folder>; secret = <at or under the secret folder> }. Every owner is an administrator principal; no non-administrator holds a right to
# replace (delete, change permissions, take ownership, delete children) and, at or under the protected root, none to write; at or under the
# secret folder nobody but an administrator principal and the pinned controller can read. Returns 'ok' or the first reason.
function Test-SecretAclChain($items, [string]$controllerSid) {
  $replace = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000
  $write = 0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor $replace
  foreach ($item in $items) {
    if ($SecretAdmins -cnotcontains $item.acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return 'owner-refused' }
    $mask = if ($item.protected) { $write } else { $replace }
    foreach ($rule in $item.acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ([string]$rule.AccessControlType -cne 'Allow' -or (([int]$rule.PropagationFlags -band 2) -ne 0)) { continue }
      $sid = $rule.IdentityReference.Value; $rights = [int]$rule.FileSystemRights; $admin = $SecretAdmins -ccontains $sid
      if ((($rights -band $mask) -ne 0) -and -not $admin) { return 'writable-ancestor' }
      if ($item.secret -and (($rights -band 0x1) -ne 0) -and -not $admin -and $sid -cne $controllerSid) { return 'secret-reader' }
    }
  }
  return 'ok'
}
# The live folders above a secret file: the secret folder is its parent, the protected root the folder above that (as the runtime computes them).
function Get-SecretPathState([string]$target, [string]$controllerSid) {
  try {
    $secretRoot = Split-Path -Parent $target; $protectedRoot = Split-Path -Parent $secretRoot
    $items = New-Object System.Collections.ArrayList
    for ($c = $secretRoot; $c; $c = [IO.Path]::GetDirectoryName($c)) {
      if (-not (Test-Path -LiteralPath $c -PathType Container)) { return 'absent' }
      if (((Get-Item -LiteralPath $c -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link-refused' }
      $inProtected = ($c -ieq $protectedRoot) -or $c.StartsWith($protectedRoot + '\', [StringComparison]::OrdinalIgnoreCase)
      $inSecret = ($c -ieq $secretRoot) -or $c.StartsWith($secretRoot + '\', [StringComparison]::OrdinalIgnoreCase)
      [void]$items.Insert(0, @{ acl = (Get-Acl -LiteralPath $c); protected = $inProtected; secret = $inSecret })
    }
    return (Test-SecretAclChain $items $controllerSid)
  } catch { return 'unreadable' }
}
function Get-SecretFileState([string]$target, [string]$controllerSid) {
  try {
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { return 'absent' }
    if (((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link-refused' }
    if (Test-SecretFileSecurity (Get-Acl -LiteralPath $target) $controllerSid) { return 'ok' } else { return 'acl-refused' }
  } catch { return 'unreadable' }
}
# 先验证目录链，只有叶文件确实不存在才允许使用安装身份。共享读句柄禁止在读回期间替换文件。
function Read-CiPrivateBytes([string]$file, [string]$controllerSid, [switch]$Optional) {
  if ((Get-SecretPathState $file $controllerSid) -cne 'ok') { throw 'CI_PRIVATE_PATH_REFUSED' }
  try { $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop }
  catch [Management.Automation.ItemNotFoundException] { if ($Optional) { return $null }; throw }
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      $item.LinkType -eq 'HardLink' -or (Get-SecretFileState $file $controllerSid) -cne 'ok') { throw 'CI_PRIVATE_FILE_REFUSED' }
  $s = [IO.File]::Open($file, 'Open', 'Read', 'Read')
  try {
    if ($s.Length -lt 1 -or $s.Length -gt 4096) { throw 'CI_PRIVATE_FILE_REFUSED' }
    $b = New-Object byte[] ([int]$s.Length); $at = 0
    while ($at -lt $b.Length) {
      $n = $s.Read($b, $at, $b.Length - $at)
      if ($n -le 0) { throw 'CI_PRIVATE_FILE_REFUSED' }
      $at += $n
    }
    if ($s.ReadByte() -ne -1) { throw 'CI_PRIVATE_FILE_REFUSED' }
    return ,$b
  } catch { if ($null -ne (Get-Variable b -ErrorAction SilentlyContinue)) { [Array]::Clear($b, 0, $b.Length) }; throw }
  finally { $s.Dispose() }
}
function Get-CiAdmissionTokenPin([byte[]]$raw) {
  # 与控制入口相同的令牌前缀、字母表和域分隔串。避免为令牌创建不可清零的字符串。
  $start = 0; $end = $raw.Length
  while ($start -lt $end -and $raw[$start] -in @(9,10,11,12,13,32)) { $start++ }
  while ($end -gt $start -and $raw[$end-1] -in @(9,10,11,12,13,32)) { $end-- }
  $prefix = [Text.Encoding]::ASCII.GetBytes('clued_bnd_')
  $size = $end - $start
  if ($size -lt $prefix.Length + 8 -or $size -gt $prefix.Length + 480) { throw 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' }
  for ($i = 0; $i -lt $size; $i++) {
    $c = $raw[$start+$i]
    if ($i -lt $prefix.Length) { if ($c -ne $prefix[$i]) { throw 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' } }
    elseif (!(($c -ge 48 -and $c -le 57) -or ($c -ge 65 -and $c -le 90) -or ($c -ge 97 -and $c -le 122) -or $c -in @(45,95))) { throw 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' }
  }
  $domain = [Text.Encoding]::ASCII.GetBytes('clued.independent-ci.ci-binding-pin/1' + [char]0)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    [void]$sha.TransformBlock($domain,0,$domain.Length,$domain,0)
    $final = $sha.TransformFinalBlock($raw,$start,$size)
    [Array]::Clear($final,0,$final.Length)
    return ([BitConverter]::ToString($sha.Hash)).Replace('-','').ToLowerInvariant()
  } finally { $sha.Dispose() }
}
function Test-CurrentCiConnection($identity, [string]$tokenFile, [string]$controllerSid) {
  try {
    $file = Join-Path (Split-Path -Parent $tokenFile) 'ci-admission.connection.json'
    $connection = Read-CiPrivateBytes $file $controllerSid -Optional
    $current = Get-EffectiveCiPrincipal $identity $connection
  } catch { return @{ ok = $false; detail = 'CI_CONNECTION_RECORD_REFUSED' } }
  try {
    $token = Read-CiPrivateBytes $tokenFile $controllerSid
    try { $pin = Get-CiAdmissionTokenPin $token } finally { [Array]::Clear($token,0,$token.Length) }
    if ($pin -cne $current.tokenPinSha256) { throw 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' }
    return @{ ok = $true; detail = [ordered]@{ bindingId = $current.bindingId; generation = $current.generation; rebindReceiptId = $current.receiptId } }
  } catch { return @{ ok = $false; detail = 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' } }
}
# ---- DESIGN.md section 33 (first HALT of 2026-10-29): two things the install must leave right and nothing else checked ----
# Virtual service account SID: S-1-5-80 + SHA-1 of the upper-case service name (UTF-16LE); the same function as install-resident.ps1.
function Get-ServiceSid([string]$name) {
  $h = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($name.ToUpperInvariant()))
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($h, $_ * 4) }) -join '-')
}
# The CI root C:\ProgramData\CluedIndependentCI carries exactly one ACE for the resident service: allow, 0x120080 (READ_CONTROL,
# SYNCHRONIZE, READ_ATTRIBUTES), this folder only. The archive tool runs as the service and opens every ancestor of the node profile
# with that access (NodeProfileV2.LoadProtectedProfile); without it every batch close is refused. More than that is also refused.
function Test-ParentAclRule([string]$sddl, [string]$res) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  $mine = @(foreach ($a in $raw.DiscretionaryAcl) { if ($a.SecurityIdentifier.Value -ceq $res) { $a } })
  $mine.Count -eq 1 -and $mine[0] -is [Security.AccessControl.CommonAce] -and $mine[0].AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and $mine[0].AccessMask -eq 0x120080 -and [int]$mine[0].AceFlags -eq 0
}
# The companion's two Source scripts (config\companion.json relayScript and bundleScript) lie under the installed CI Source,
# <root>\source\<SHA-256 of record\source-manifest.json>\, as plain names, and the files are there. A config written for another
# Source runs nothing (stage 0 reported BUNDLE_UNAVAILABLE). Never throws: ok/detail; the detail is a fixed code and a key name.
function Test-CompanionSourceScripts($companion, [string]$root, [string]$ciSha) {
  $no = { param([string]$why) [pscustomobject]@{ ok = $false; detail = $why } }
  if ($ciSha -cnotmatch '^[0-9a-f]{64}\z') { return & $no 'COMPANION_SOURCE_HASH_INVALID' }
  $base = $root.TrimEnd('\') + '\source\' + $ciSha + '\'
  foreach ($key in @('relayScript', 'bundleScript')) {
    $p = Get-Field $companion $key
    if ($p -isnot [string] -or -not $p.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { return & $no ('COMPANION_SCRIPT_NOT_IN_SOURCE:' + $key) }
    $segments = @($p.Substring($base.Length).Split('\'))
    if (@($segments | Where-Object { $_ -cnotmatch '^[A-Za-z0-9_.@-]+\z' -or $_ -ceq '.' -or $_ -ceq '..' }).Count -ne 0) { return & $no ('COMPANION_SCRIPT_NOT_IN_SOURCE:' + $key) }
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return & $no ('COMPANION_SCRIPT_MISSING:' + $key) }
  }
  [pscustomobject]@{ ok = $true; detail = $null }
}
# The receipt's node identity against the identity re-derived from the installed record. Never throws: ok/detail/identity.
function Test-NodeIdentityReceipt($receipt, $installation, $accepted, [string]$acceptanceSha256) {
  $no = { param([string]$why) [pscustomobject]@{ ok = $false; detail = $why; identity = $null } }
  try { $have = Get-NodeIdentity $installation $accepted $acceptanceSha256 } catch { return & $no $_.Exception.Message }
  $canonical = ConvertTo-NodeIdentityCanonical $have
  if ((Get-Field $receipt 'roleAssumption') -cne 'NONE') { return & $no 'ROLE_ASSUMED_AT_INSTALL' }
  $want = try { ConvertTo-NodeIdentityCanonical (Get-Field $receipt 'nodeIdentity') } catch { $null }
  if ($null -eq $want -or $want -cne $canonical -or (Get-Field $receipt 'nodeIdentitySha256') -cne (Sha256Text $canonical)) { return & $no 'NODE_IDENTITY_CHANGED' }
  [pscustomobject]@{ ok = $true; detail = $have.nodeName; identity = $have }
}
# What the receipt says about the two files: placed with the record's pin as fingerprint, or nothing placed by this install.
function Test-SecretsReceipt($receipt, $identity) {
  if ($null -eq $identity) { return $false }
  foreach ($spec in @(@('appKey', 'appPublicKeySha256Base64'), @('ciToken', 'ciTokenPinSha256'))) {
    $r = Get-Field (Get-Field $receipt 'secrets') $spec[0]
    if ($null -eq $r -or (Get-Field $r 'target') -cne $SecretTargets[$spec[0]]) { return $false }
    $placed = Get-Field $r 'placed'; $fingerprint = Get-Field $r 'fingerprint'
    if (-not ((($placed -eq $false) -and ($null -eq $fingerprint)) -or (($placed -eq $true) -and ($fingerprint -ceq $identity.($spec[1]))))) { return $false }
  }
  return $true
}
# ---- PR-1 review M2: resident\<sha> and source\<sha> inherit exactly what their live parent passes down (no ACE kept from upgrade\staged).
# Shared with upgrade-apply.ps1 (one text, held identical by test-upgrade-windows.ps1). ----
function Get-InheritableAceKeys([string]$parentSddl, [int]$flag) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($parentSddl)
  (@(foreach ($a in $raw.DiscretionaryAcl) { if (([int]$a.AceFlags -band $flag) -ne 0) { $a.SecurityIdentifier.Value + '|' + $a.AccessMask } }) | Sort-Object -Unique) -join ','
}
function Test-ItemAcl($item, [string]$wantDir, [string]$wantFile) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link' }
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $item.FullName).Sddl)
  if (($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) { return 'protected' }
  if (@($raw.DiscretionaryAcl | Where-Object { ([int]$_.AceFlags -band 0x10) -eq 0 }).Count -ne 0) { return 'explicit' }
  $have = (@(foreach ($a in $raw.DiscretionaryAcl) { $a.SecurityIdentifier.Value + '|' + $a.AccessMask }) | Sort-Object -Unique) -join ','
  if ($have -cne $(if ($item.PSIsContainer) { $wantDir } else { $wantFile })) { return 'aces' }
  'ok'
}
function Test-ContentAcl([string]$dir) {
  $parent = (Get-Acl -LiteralPath (Split-Path -Parent $dir)).Sddl
  $wantDir = Get-InheritableAceKeys $parent 2; $wantFile = Get-InheritableAceKeys $parent 1
  foreach ($i in @(@(Get-Item -LiteralPath $dir -Force) + @(Get-ChildItem -LiteralPath $dir -Recurse -Force))) {
    $why = Test-ItemAcl $i $wantDir $wantFile
    if ($why -cne 'ok') { return ($why + ':' + $i.FullName.Substring($dir.Length).TrimStart('\')) }
  }
  'ok'
}
# ---- The upgrade channel (018da927). Shared with install-resident.ps1: Get-UpgraderBinPath, Get-GenerationFilesSha256 (one text in
# both, held identical by test-upgrade-windows.ps1). ----
function Get-UpgraderBinPath([string]$root, [string]$configSha, [string]$nodeSha, [string]$manifestSha, [string]$entrySha) {
  '"' + (Join-Path $root 'upgrader\bin\UpgraderServiceHost.exe') + '" "' + $root + '" ' + $configSha + ' "' + (Join-Path $root 'upgrader\runtime\node.exe') + '" ' + $nodeSha + ' "' + (Join-Path $root ('upgrader\' + $manifestSha + '\upgrader\src\upgrader-main.mjs')) + '" ' + $entrySha
}
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
# A security descriptor only SYSTEM and Administrators can use: an administrator owner and no ACE for anybody else.
function Test-AdminOnlySddl([string]$sddl) {
  $raw = New-Object Security.AccessControl.RawSecurityDescriptor($sddl)
  if (@('S-1-5-18', 'S-1-5-32-544') -cnotcontains $raw.Owner.Value) { return $false }
  @($raw.DiscretionaryAcl | Where-Object { -not ($_ -is [Security.AccessControl.CommonAce]) -or @('S-1-5-18', 'S-1-5-32-544') -cnotcontains $_.SecurityIdentifier.Value }).Count -eq 0
}
# upgrader-pin: the command line is the receipt's and the formula's over the live files; upgrade-apply.ps1 is there; upgrader\ and the token
# (when the install placed one) are SYSTEM and Administrators only. $qc: the `sc qc` text, or $null when unreadable. Detail in $script:upgraderPinDetail.
$script:upgraderPinDetail = $null
function Test-UpgraderPins([string]$root, $u, $qc) {
  try {
    $m = [string](Get-Field $u 'manifestSha256')
    if ($m -cnotmatch '^[0-9a-f]{64}\z') { $script:upgraderPinDetail = 'manifest'; return $false }
    foreach ($pin in @(@('upgrader\bin\UpgraderServiceHost.exe', 'hostSha256'), @('upgrader\runtime\node.exe', 'nodeSha256'), @('upgrader\config\upgrader.json', 'configSha256'))) {
      if ((Sha256File (Join-Path $root $pin[0])) -cne [string](Get-Field $u $pin[1])) { $script:upgraderPinDetail = $pin[1]; return $false }
    }
    $want = Get-UpgraderBinPath $root $u.configSha256 $u.nodeSha256 $m (Sha256File (Join-Path $root ('upgrader\' + $m + '\upgrader\src\upgrader-main.mjs')))
    if ($want -cne [string](Get-Field $u 'binaryPath')) { $script:upgraderPinDetail = 'receipt-binary-path'; return $false }
    if ($null -ne $qc -and ($qc -notmatch 'BINARY_PATH_NAME\s*:\s*(.+?)\s*(\r?\n|$)' -or $Matches[1] -cne $want)) { $script:upgraderPinDetail = 'scm-binary-path'; return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $root ('upgrader\' + $m + '\windows\upgrade-apply.ps1')) -PathType Leaf)) { $script:upgraderPinDetail = 'upgrade-apply'; return $false }
    if (-not (Test-AdminOnlySddl (Get-Acl -LiteralPath (Join-Path $root 'upgrader')).Sddl)) { $script:upgraderPinDetail = 'upgrader-acl'; return $false }
    if ($null -ne (Get-Field $u 'tokenFingerprint')) {
      $token = Join-Path $root 'secrets\resident-upgrade.token'
      if (-not (Test-Path -LiteralPath $token -PathType Leaf) -or (((Get-Item -LiteralPath $token -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        -not (Test-AdminOnlySddl (Get-Acl -LiteralPath $token).Sddl) -or -not (Test-AdminOnlySddl (Get-Acl -LiteralPath (Split-Path -Parent $token)).Sddl)) { $script:upgraderPinDetail = 'upgrade-token'; return $false }
    }
    $script:upgraderPinDetail = $m
    return $true
  } catch { $script:upgraderPinDetail = 'unreadable'; return 'unreadable' }
}
# heartbeat-token-acl (DESIGN.md section 41.6a; review R3 MINOR 8): when secrets\heartbeat\ is there, it and the token file in it have
# exactly install-resident.ps1's SDDL (Get-HeartbeatDirectorySddl, Get-HeartbeatFileSddl): no reparse point, owner Administrators,
# protected, SYSTEM and Administrators full control, the Owner read-only, nobody else. Not installed: nothing to check.
function Test-HeartbeatTokenAcl([string]$root, [string]$ownerSid) {
  try {
    $dir = Join-Path $root 'secrets\heartbeat'
    if (-not (Test-Path -LiteralPath $dir)) { return [pscustomobject]@{ ok = $true; detail = 'NOT_INSTALLED' } }
    $one = {
      param([string]$path, [bool]$container, [string]$sddl)
      $item = Get-Item -LiteralPath $path -Force
      if ($item.PSIsContainer -ne $container -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { return $false }
      $want = if ($container) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
      $want.SetSecurityDescriptorSddlForm($sddl)
      $back = Get-Acl -LiteralPath $path
      ($back.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544') -and ((Get-DaclPart $back.Sddl) -ceq (Get-DaclPart $want.GetSecurityDescriptorSddlForm('Access')))
    }
    if (-not (& $one $dir $true ('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;' + $ownerSid + ')'))) { return [pscustomobject]@{ ok = $false; detail = 'DIRECTORY_ACL' } }
    $file = Join-Path $dir 'ci-node-heartbeat.token'
    if (-not (Test-Path -LiteralPath $file)) { return [pscustomobject]@{ ok = $true; detail = 'NO_TOKEN' } }
    if (-not (& $one $file $false ('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x120089;;;' + $ownerSid + ')'))) { return [pscustomobject]@{ ok = $false; detail = 'FILE_ACL' } }
    [pscustomobject]@{ ok = $true; detail = 'OK' }
  } catch { [pscustomobject]@{ ok = 'unreadable'; detail = 'UNREADABLE' } }
}
# heartbeat-binding (merge train step 2b review): the heartbeat connection id the install recorded (-HeartbeatBindingId, informational;
# the Owner links it on KooYomi's /bindings/failover). Reported only, from the receipt; nothing is read over the network. A receipt
# without the field (an older install or an upgrade) or a token without an id is fine; an id that is not a UUID, or an id without a
# placed token, is not.
function Get-HeartbeatBindingState($receipt) {
  $hb = Get-Field $receipt 'heartbeatToken'
  if ($null -eq $hb) { return [pscustomobject]@{ ok = $true; detail = 'NOT_IN_RECEIPT' } }
  $id = Get-Field $hb 'bindingId'; $placed = (Get-Field $hb 'placed') -eq $true
  if ($null -eq $id) { return [pscustomobject]@{ ok = $true; detail = $(if ($placed) { 'TOKEN_WITHOUT_BINDING_ID' } else { 'NOT_INSTALLED' }) } }
  if ($id -isnot [string] -or $id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z' -or -not $placed) { return [pscustomobject]@{ ok = $false; detail = 'BINDING_ID_INVALID' } }
  [pscustomobject]@{ ok = $true; detail = ('bindingId=' + $id) }
}
# generation-current: upgrade\current.json names the receipt being verified and its generation; generations\g<N>\generation.json holds the
# receipt's command lines, which the SCM and the companion task hold now, and the hash of the generation's files where they are.
function Test-GenerationCurrent([string]$root, $receipt, [string]$receiptSha) {
  $no = { param([string]$why) [pscustomobject]@{ ok = $false; detail = $why } }
  try {
    $cur = Get-Content -LiteralPath (Join-Path $root 'upgrade\current.json') -Raw | ConvertFrom-Json
    $g = Get-Field $cur 'generation'
    if ((Get-Field $cur 'contract') -cne 'clued.independent-ci.resident-generation/1' -or -not (($g -is [int]) -or ($g -is [long])) -or $g -ne (Get-Field $receipt 'generation')) { return & $no 'CURRENT_GENERATION' }
    foreach ($k in @('packageManifestSha256', 'residentManifestSha256', 'policySha256')) { if ((Get-Field $cur $k) -cne (Get-Field $receipt $k)) { return & $no ('CURRENT_' + $k) } }
    if ((Get-Field $cur 'installReceiptSha256') -cne $receiptSha) { return & $no 'CURRENT_RECEIPT' }
    $gen = Get-Content -LiteralPath (Join-Path $root ('generations\g' + $g + '\generation.json')) -Raw | ConvertFrom-Json
    if ((Get-Field $gen 'generation') -ne $g -or (Get-Field $gen 'packageManifestSha256') -cne (Get-Field $receipt 'packageManifestSha256')) { return & $no 'GENERATION_RECORD' }
    if ((Get-Field $gen 'residentBinPath') -cne (Get-Field $receipt 'residentBinaryPath') -or (Get-Field $gen 'brokerBinPath') -cne (Get-Field $receipt 'brokerBinaryPath') -or
      (Get-Field $gen 'companionTaskArguments') -cne (Get-Field (Get-Field $receipt 'companionTaskAction') 'arguments')) { return & $no 'GENERATION_RECORD_NOT_THE_RECEIPT' }
    $live = { param([string]$name) $t = & $Sc qc $name 8192 | Out-String; if ($t -match 'BINARY_PATH_NAME\s*:\s*(.+?)\s*(\r?\n|$)') { $Matches[1] } else { $null } }
    if ((& $live 'CluedCIResident') -cne $gen.residentBinPath) { return & $no 'RESIDENT_BINARY_PATH' }
    if ((& $live 'CluedCISwapBroker') -cne $gen.brokerBinPath) { return & $no 'BROKER_BINARY_PATH' }
    # M5: what the supervisor starts is the launch file's generation (its entry and configuration), not the task's action.
    $launch = Get-Content -LiteralPath (Join-Path $root 'config\companion-launch.json') -Raw | ConvertFrom-Json
    $want = if ([string]$launch.entry -cmatch ('^' + [regex]::Escape($root) + '\\resident\\([0-9a-f]{64})\\src\\companion-main\.mjs\z')) { Get-CompanionLaunchArguments $root $Matches[1] ([string]$launch.configSha256) } else { $null }
    if ($launch.generation -ne $g -or $want -cne $gen.companionTaskArguments) { return & $no 'COMPANION_LAUNCH_NOT_THE_GENERATION' }
    if ((Get-GenerationFilesSha256 $root) -cne (Get-Field $gen 'filesSha256')) { return & $no 'GENERATION_FILES' }
    [pscustomobject]@{ ok = $true; detail = ('g' + $g) }
  } catch { [pscustomobject]@{ ok = 'unreadable'; detail = 'UNREADABLE' } }
}
# two-sides-consistent: the rule of src/upgrade-mailbox.mjs consistent(current, facts): the Linux side's own facts name the same generation
# as upgrade\current.json, the same CI Source, the Linux manifest current.json records, with its pins intact. The companion's file says
# nothing once older than 15 minutes or more than 5 minutes ahead (VERSION_FACTS_MAX_AGE_MS, VERSION_FACTS_FUTURE_MS); a file given by
# the caller is taken as it is.
function Test-VersionFacts($current, $facts, [DateTimeOffset]$now, [bool]$checkAge) {
  if ((Get-Field $facts 'contract') -cne 'clued.independent-ci.linux-version-facts/1') { return 'FACTS_CONTRACT' }
  if ($checkAge) {
    $at = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string](Get-Field $facts 'observedAt'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$at) -or ($now - $at).TotalMinutes -gt 15 -or ($at - $now).TotalMinutes -gt 5) { return 'FACTS_STALE' }
  }
  $linux = Get-Field $current 'linux'
  $fg = Get-Field $facts 'generation'
  if ($null -eq $fg -or $null -eq $linux -or $fg -ne (Get-Field $current 'generation')) { return 'GENERATION' }
  if ((Get-Field $facts 'ciSourceManifestSha256') -cne (Get-Field $current 'ciSourceManifestSha256')) { return 'CI_SOURCE' }
  if ((Get-Field $facts 'manifestSha256') -cne (Get-Field $linux 'manifestSha256')) { return 'LINUX_MANIFEST' }
  $pins = Get-Field $facts 'pinsOk'
  if (-not (($pins -is [bool]) -and $pins)) { return 'PINS' }
  'ok'
}
function Test-TwoSidesConsistent([string]$root, [string]$factsFile, [DateTimeOffset]$now) {
  try {
    $current = Get-Content -LiteralPath (Join-Path $root 'upgrade\current.json') -Raw | ConvertFrom-Json
    $file = if ($factsFile) { $factsFile } else { Join-Path $root 'upgrade\mailbox\responses\version-facts.json' }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return [pscustomobject]@{ ok = $false; detail = 'FACTS_MISSING' } }
    $why = Test-VersionFacts $current (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) $now (-not $factsFile)
    [pscustomobject]@{ ok = ($why -ceq 'ok'); detail = $why }
  } catch { [pscustomobject]@{ ok = $false; detail = 'FACTS_UNREADABLE' } }
}
$checks = [ordered]@{}
function Sha256File([string]$p) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash([IO.File]::ReadAllBytes($p)))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
function Read-ReviewedPublicJson([string]$file, [string]$expected, [ValidateRange(1,4194304)][int]$maximum=1048576) {
  if ($expected -cnotmatch '^[0-9a-f]{64}\z') { throw 'INSTALL_RECEIPT_PIN_REQUIRED' }
  $item=Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'INSTALL_RECEIPT_BOUNDARY_REFUSED' }
  $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    if($stream.Length -lt 1 -or $stream.Length -gt $maximum){throw 'INSTALL_RECEIPT_BOUNDARY_REFUSED'}
    $bytes=New-Object byte[] ([int]$stream.Length);$at=0
    while($at -lt $bytes.Length){$count=$stream.Read($bytes,$at,$bytes.Length-$at);if($count -lt 1){throw 'INSTALL_RECEIPT_CHANGED'};$at+=$count}
    if($stream.ReadByte() -ne -1 -or $stream.Length -ne $bytes.Length){throw 'INSTALL_RECEIPT_CHANGED'}
    $h=[Security.Cryptography.SHA256]::Create()
    try{$actual=([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}
    if($actual -cne $expected){throw 'INSTALL_RECEIPT_CHANGED'}
    return ((New-Object Text.UTF8Encoding($false,$true)).GetString($bytes)|ConvertFrom-Json)
  }finally{$stream.Dispose()}
}
function Record([string]$name, $ok, $detail = $null) { $script:checks[$name] = [ordered]@{ ok = $ok; detail = $detail } }
# M5-b relay parents (6c536c8c) in the generic install AND the generic in-place upgrade. install-resident.ps1's step
# 'companion-relay-parent-acl' adds (A;;0x120080;;;<companion SID>) to <CiRoot> and <CiRoot>\formal-spool on a fresh install only; a
# node installed before it, upgraded in place, never got it. So this verify, run as SYSTEM by the upgrade channel's VERIFY (and only
# then), ensures it first. The rule is not written here: the functions are install-resident.ps1's own (this generation's copy next to
# this file, its sha256 the one the resident manifest pins), loaded by exact name into a child scope and run as they are.
# Present: nothing written. Missing: only that ACE (owner, group, SACL and every other ACE kept; DACL compared with the plan before the
# write, read back after). A link on the way, an unprotected DACL or any other entry of the account: refused (thrown).
# Returns how many parents it wrote (0 or more).
# $installerSha256: the pinned hash; the bytes are read once, hashed, and parsed from that same read (never re-opened).
function Invoke-CompanionRelayParentsEnsure([string]$root, [string]$sid, [string]$installer, [string]$installerSha256) {
  & {
    param([string]$root, [string]$sid, [string]$installer, [string]$installerSha256)
    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
    if ($sid -cnotmatch '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z') { throw 'RELAY_PARENT_SID_REFUSED' }
    if ($installerSha256 -cnotmatch '^[0-9a-f]{64}\z') { throw 'RELAY_PARENT_RULE_NOT_PINNED' }
    $bytes = [IO.File]::ReadAllBytes($installer)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
    if ($actual -cne $installerSha256) { throw 'RELAY_PARENT_RULE_HASH_MISMATCH' }
    $text = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
    if (@($errors).Count -ne 0) { throw 'RELAY_PARENT_RULE_UNPARSEABLE' }
    foreach ($name in @('Get-DaclPart', 'Get-ParentAce', 'Get-AceKeys', 'Get-ParentAclState', 'Add-ParentAce', 'Get-RelayParentAclPresence',
        'Assert-CompanionRelayParentPlan', 'Add-CompanionRelayParentAce', 'Get-CompanionRelayParentsPlan')) {
      $found = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $true))
      if ($found.Count -ne 1) { throw ('RELAY_PARENT_RULE_MISSING:' + $name) }
      . ([scriptblock]::Create($found[0].Extent.Text))
    }
    # the installer's own names, read by Get-CompanionRelayParentsPlan
    $OwnerSid = $sid
    $CiRoot = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root).TrimEnd('\'))
    $assertNoLink = { param([string]$path) for ($p = $path; $p; $p = [IO.Path]::GetDirectoryName($p)) {
        $item = Get-Item -LiteralPath $p -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('RELAY_PARENT_LINK_OR_NOT_A_DIRECTORY:' + $p) } } }
    foreach ($p in @($CiRoot, (Join-Path $CiRoot 'formal-spool'))) { & $assertNoLink $p }
    # The resident service's own CiRoot entry is not this step's business: present = no projection (the plan's 'before' is the live DACL).
    $written = 0
    foreach ($plan in (Get-CompanionRelayParentsPlan ([ordered]@{ present = $true }))) {
      & $assertNoLink $plan.path
      if (Add-CompanionRelayParentAce $plan) { $written++ }
    }
    $written
  } $root $sid $installer $installerSha256
}
# The verdict (Task 018da927 b). Only a check whose ok is the STRING 'unreadable' asks for an elevated run: with -eq, a
# boolean on the left converts 'unreadable' to $true, so every passing check counted as unreadable and any failure was
# reported as RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED (exit 2) instead of RESIDENT_VERIFICATION_FAILED (exit 1).
function Get-VerifyVerdict($checks) {
  $allOk = -not ($checks.Values | Where-Object { $_.ok -ne $true })
  $unreadable = [bool]($checks.Values | Where-Object { $_.ok -is [string] -and $_.ok -ceq 'unreadable' })
  if ($allOk) { return @{ status = 'RESIDENT_VERIFIED'; exit = 0 } }
  if ($unreadable) { return @{ status = 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED'; exit = 2 } }
  return @{ status = 'RESIDENT_VERIFICATION_FAILED'; exit = 1 }
}

function Get-VerifyInputFailure([string]$check, [string]$message) {
  $name = if (@('install-receipt', 'record-acceptance', 'policy-input', 'companion-input', 'broker-input') -ccontains $check) { $check } else { 'verify-inputs' }
  $code = if ($message -cmatch '^(INSTALL_RECEIPT_(PIN_REQUIRED|BOUNDARY_REFUSED|CHANGED)|INSTALLED_NODE_(PROFILE_REFUSED|PROFILE_CHANGED|CONFIG_CHANGED))\z') { $message } else { 'VERIFY_INPUT_UNREADABLE' }
  [pscustomobject]@{ check = $name; detail = $code }
}
# A failed pinned input must still produce a bounded JSON verdict for the frozen upgrade-apply reader.
# Raw exceptions can contain paths or contents: only fixed check names and fixed failure codes leave this process.
if ($FunctionsOnly) {
  if ($MyInvocation.InvocationName -ne '.') { throw 'DOT_SOURCE_REQUIRED' }
  return
}
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
if (-not ([IO.Path]::GetFullPath($PSCommandPath)).StartsWith((Join-Path $Root 'resident\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'RUN_THE_INSTALLED_COPY' }
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'   # no user module directory (review M1)
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\ScheduledTasks\ScheduledTasks.psd1'
$script:VerifyInputCheck = 'install-receipt'
try {
$receiptFile = Join-Path $Root 'install\install-receipt.json'
$receipt = Read-ReviewedPublicJson $receiptFile $ExpectedInstallReceiptSha256
Record 'install-receipt' $true
$ReceiptContracts = @('clued.independent-ci.resident-install-receipt/5', 'clued.independent-ci.resident-install-receipt/6')
if ($ReceiptContracts -cnotcontains $receipt.contract -or $receipt.nodeProfileSha256 -cnotmatch '^[0-9a-f]{64}\z' -or $receipt.acceptanceSha256 -cnotmatch '^[0-9a-f]{64}\z') { throw 'INSTALLED_NODE_PROFILE_REFUSED' }
$acceptancePath=Join-Path $Root 'record\acceptance.json'
$script:VerifyInputCheck = 'record-acceptance'
$Accepted=Read-ReviewedPublicJson $acceptancePath $receipt.acceptanceSha256 4MB
$Node=$Accepted.node
$NodeCanonical=ConvertTo-NodeProfileCanonical $Node
$nh=[Security.Cryptography.SHA256]::Create();try{$NodeProfileSha256=([BitConverter]::ToString($nh.ComputeHash([Text.Encoding]::UTF8.GetBytes($NodeCanonical)))).Replace('-','').ToLowerInvariant()}finally{$nh.Dispose()}
if($NodeProfileSha256 -cne $receipt.nodeProfileSha256 -or (ConvertTo-NodeProfileCanonical $receipt.node) -cne $NodeCanonical){throw 'INSTALLED_NODE_PROFILE_CHANGED'}
$Runner=[string]$Node.runnerService
foreach($pair in @(@('config\policy.json',$receipt.policySha256),@('config\companion.json',$receipt.companionConfigSha256),@('config\broker.json',$receipt.brokerConfigSha256))){
  $script:VerifyInputCheck = @{'config\policy.json'='policy-input';'config\companion.json'='companion-input';'config\broker.json'='broker-input'}[$pair[0]]
  $file=Join-Path $Root $pair[0];$cfg=Read-ReviewedPublicJson $file $pair[1];if($pair[0] -ceq 'config\companion.json'){$cfg=$cfg.companion}
  if($cfg.nodeProfileSha256 -cne $NodeProfileSha256 -or (ConvertTo-NodeProfileCanonical $cfg.node) -cne $NodeCanonical){throw 'INSTALLED_NODE_CONFIG_CHANGED'}
}
$script:VerifyInputCheck = 'verify-inputs'

# DESIGN.md section 33: the companion's Source scripts are in the installed Source and exist; the CI root grants the resident service
# its READ_CONTROL entry (live ACL, not the receipt: an install by hand or an earlier install counts the same).
$ciSourceSha = Sha256File (Join-Path $Root 'record\source-manifest.json')
$companionScripts = try { $companionSection = (Read-ReviewedPublicJson (Join-Path $Root 'config\companion.json') $receipt.companionConfigSha256).companion; Test-CompanionSourceScripts $companionSection $Root $ciSourceSha } catch { [pscustomobject]@{ ok = $false; detail = 'COMPANION_CONFIG_UNREADABLE' } }
Record 'companion-source-scripts' $companionScripts.ok $companionScripts.detail
$ciRootSddl = try { (Get-Acl -LiteralPath 'C:\ProgramData\CluedIndependentCI').Sddl } catch { $null }
Record 'ci-root-resident-read-control' $(if ([string]::IsNullOrEmpty($ciRootSddl)) { 'unreadable' } else { try { Test-ParentAclRule $ciRootSddl (Get-ServiceSid 'CluedCIResident') } catch { $false } })
# The content-addressed trees of this generation (PR-1 review M2): an upgrade moves them in from upgrade\staged\, and a moved tree must have
# taken its live parent's ACL (source\ grants .\clued-control read; nothing of upgrade\ may stay).
$contentAcl = try { $ra = Test-ContentAcl (Join-Path $Root ('resident\' + $receipt.residentManifestSha256)); $sa = Test-ContentAcl (Join-Path $Root ('source\' + $ciSourceSha)); [pscustomobject]@{ ok = ($ra -ceq 'ok' -and $sa -ceq 'ok'); detail = ('resident:' + $ra + ' source:' + $sa) } } catch { [pscustomobject]@{ ok = 'unreadable'; detail = 'UNREADABLE' } }
Record 'content-addressed-acl' $contentAcl.ok $contentAcl.detail

# Node identity (C7): re-derived from the installed record and compared with the receipt; the receipt assumes no role.
$identityCheck = try { Test-NodeIdentityReceipt $receipt (Read-ReviewedPublicJson (Join-Path $Root 'record\installation.json') ([string](Get-Field $receipt 'installationSha256')) 4MB) $Accepted $receipt.acceptanceSha256 } catch { [pscustomobject]@{ ok = $false; detail = $_.Exception.Message; identity = $null } }
Record 'node-identity' $identityCheck.ok $identityCheck.detail
Record 'node-secrets-receipt' (Test-SecretsReceipt $receipt $identityCheck.identity)
if ($identityCheck.ok -eq $true) {
  $checks['node-identity']['installationIdentity'] = [ordered]@{ nodeName = $identityCheck.identity.nodeName
    bindingId = $identityCheck.identity.ciPrincipalBindingId; nodeIdentitySha256 = (Get-Field $receipt 'nodeIdentitySha256') }
  $currentCi = Test-CurrentCiConnection $identityCheck.identity $SecretTargets.ciToken $Node.controllerSid
  Record 'current-ci-connection' $currentCi.ok $currentCi.detail
}
foreach ($spec in @(@('app-key-file', 'appKey', 'app-key-directories'), @('ci-admission-token-file', 'ciToken', 'ci-admission-token-directories'))) {
  $state = Get-SecretFileState $SecretTargets[$spec[1]] $Node.controllerSid
  Record $spec[0] $(if ($state -ceq 'ok') { $true } elseif ($state -ceq 'unreadable') { 'unreadable' } else { $false }) $state
  # The folders holding the file and every ancestor: what the runtime's own check requires on the way to the file (MINOR-2 of the C7 review).
  $pathState = Get-SecretPathState $SecretTargets[$spec[1]] $Node.controllerSid
  Record $spec[2] $(if ($pathState -ceq 'ok') { $true } elseif ($pathState -ceq 'unreadable') { 'unreadable' } else { $false }) $pathState
}

foreach ($s in @($receipt.sourceManifestSha256, $receipt.residentManifestSha256)) { if ($s -cnotmatch '^[0-9a-f]{64}$') { throw 'INSTALL_RECEIPT_SHAPE_REFUSED' } }
# Resident quota redesign phase 1: the carried-forward executed heads the install listed, and the resident's backfill of
# them (no batch runs before it; state\executed-heads\BACKFILL-COMPLETE.json once done).
$backfillManifest = Join-Path $Root 'install\backfill-manifest.json'
Record 'backfill-manifest' ((Test-Path -LiteralPath $backfillManifest -PathType Leaf) -and ((Sha256File $backfillManifest) -ceq [string]$receipt.backfillManifestSha256))
$marker = Join-Path $Root 'state\executed-heads\BACKFILL-COMPLETE.json'
$until = [DateTime]::UtcNow.AddSeconds(90)   # right after an install the first tick may still be running it
while (-not (Test-Path -LiteralPath $marker -PathType Leaf) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Seconds 3 }
$markerDetail = if (Test-Path -LiteralPath $marker -PathType Leaf) { try { $m = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json; 'published ' + $m.published + ', unreadable ' + $m.unreadable } catch { 'marker unreadable' } } else { $null }
Record 'executed-heads-backfilled' (Test-Path -LiteralPath $marker -PathType Leaf) $markerDetail

# Service facts that sc.exe prints in the system language (DESK-W-591, 2026-10-30: `sc qfailure` printed 重新启动, not RESTART) are
# read from the SCM's own registry values and compared exactly with what install-resident.ps1 sets. sc.exe's field labels and the
# numbers (START_TYPE, STATE, PID, SERVICE_START_NAME, BINARY_PATH_NAME, Se*Privilege names, SDDL) are not translated.
$ServicesKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\'
function Get-ServiceValue([string]$name, [string]$value) {
  # the property is taken from the item, never through a pipeline (which would unroll a REG_BINARY into object[])
  $item = try { Get-ItemProperty -LiteralPath ($ServicesKey + $name) -Name $value -ErrorAction Stop } catch { $null }
  if ($null -eq $item) { return $null }
  $v = $item.$value
  if ($v -is [byte[]]) { ,$v } else { $v }
}
# SERVICE_FAILURE_ACTIONS as the SCM stores it (value FailureActions, REG_BINARY): reset period (s), two string placeholders, the
# action count, an array placeholder, then one (type, delay ms) pair per action; type 1 = SC_ACTION_RESTART, 0 = SC_ACTION_NONE.
function ConvertFrom-FailureActions($b) {
  if ($b -isnot [byte[]] -or $b.Length -lt 20) { return $null }
  $n = [BitConverter]::ToUInt32($b, 12)
  if ($n -gt 16 -or $b.Length -ne 20 + 8 * $n) { return $null }
  $actions = @(for ($i = 0; $i -lt $n; $i++) { [string][BitConverter]::ToUInt32($b, 20 + 8 * $i) + '/' + [BitConverter]::ToUInt32($b, 24 + 8 * $i) })
  [ordered]@{ reset = [BitConverter]::ToUInt32($b, 0); actions = ($actions -join ',') }
}
# install-resident.ps1: sc failure CluedCISwapBroker reset= 86400 actions= restart/60000/restart/300000//300000, failureflag 1.
function Test-BrokerFailureActions($bytes, $nonCrash) {
  $f = ConvertFrom-FailureActions $bytes
  ($null -ne $f) -and $f.reset -eq 86400 -and $f.actions -ceq '1/60000,1/300000,0/300000' -and $nonCrash -is [int] -and $nonCrash -eq 1
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

$qc = & $Sc qc CluedCIResident | Out-String
Record 'resident-account' ($qc -match 'SERVICE_START_NAME\s*:\s*NT SERVICE\\CluedCIResident')
Record 'resident-start-type' ($qc -match 'START_TYPE\s*:\s*2\s')
Record 'resident-sid-type' ((Get-ServiceValue 'CluedCIResident' 'ServiceSidType') -eq 1)   # SERVICE_SID_TYPE_UNRESTRICTED
$logonRight = if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Read-ServiceLogonRight $Node.controllerSid } else { $null }
Record 'controller-service-logon-right' $(if ($null -eq $logonRight) { 'unreadable' } else { [bool]$logonRight }) 'SeServiceLogonRight of the node profile''s controllerSid'
Record 'resident-host-pin' ((Sha256File (Join-Path $Root 'bin\ResidentServiceHost.exe')) -ceq $receipt.ResidentServiceHostSha256)
$bq = & $Sc qc CluedCISwapBroker | Out-String
Record 'broker-account' ($bq -match 'SERVICE_START_NAME\s*:\s*LocalSystem')
Record 'broker-host-pin' ((Sha256File (Join-Path $Root 'bin\SwapBroker.exe')) -ceq $receipt.SwapBrokerSha256)
# DESIGN §24: an install from before the job host has no pin and no exe; that is a false check, never a broken verify.
$jobHost = Join-Path $Root 'bin\CluedCompanionJobHost.exe'
Record 'companion-job-host-pin' (($receipt.PSObject.Properties.Name -ccontains 'companionJobHostSha256') -and (Test-Path -LiteralPath $jobHost -PathType Leaf) -and ((Sha256File $jobHost) -ceq [string]$receipt.companionJobHostSha256))
# ---- Privilege boundary (independent review of PR-A: MAJOR-1, MINOR-4, MINOR-5) ----
$ResidentPrivileges = @('SeChangeNotifyPrivilege')
$BrokerPrivileges = @('SeChangeNotifyPrivilege', 'SeCreateGlobalPrivilege')
function ConvertFrom-ScPrivs([string]$text) {
  $names = @(foreach ($line in ($text -split "`r?`n")) { if ($line -match '^\s*(?:PRIVILEGES\s*)?:\s*(Se[A-Za-z]+Privilege)\s*$') { $Matches[1] } })
  @($names | Sort-Object -CaseSensitive)
}
function Test-ExactPrivileges($have, $want) { (@($have | Sort-Object -CaseSensitive) -join '/') -ceq (@($want | Sort-Object -CaseSensitive) -join '/') }
# A host's own token record: the privileges it holds are a subset of the allow-list (SeChangeNotify at least).
function Test-TokenRecord([string]$json, $allowed) {
  try { $v = $json | ConvertFrom-Json } catch { return $false }
  if ($null -eq $v -or $v.contract -cne 'clued.independent-ci.service-token-privileges/1') { return $false }
  $have = @($v.privileges); ($have -ccontains 'SeChangeNotifyPrivilege') -and (@($have | Where-Object { $allowed -cnotcontains $_ }).Count -eq 0)
}
# `sc qc` of the broker: exactly "<Root>\bin\SwapBroker.exe" "<Root>" <broker.json SHA-256>.
function Test-BrokerBinaryPath([string]$qcText, [string]$root, [string]$configSha, [string]$nodeProfileSha) {
  if ($nodeProfileSha -cnotmatch '^[0-9a-f]{64}\z' -or $configSha -cnotmatch '^[0-9a-f]{64}$' -or $qcText -notmatch 'BINARY_PATH_NAME\s*:\s*(.+?)\s*(\r?\n|$)') { return $false }
  $Matches[1] -ceq ('"' + (Join-Path $root 'bin\SwapBroker.exe') + '" "' + $root + '" ' + $configSha + ' ' + $nodeProfileSha)
}
# sc.exe sdshow also prints the SACL ("S:...") when the caller may read it (elevated) and not otherwise;
# every service-descriptor comparison uses the DACL section alone, so both views agree.
function Get-DaclPart([string]$sd) { $t = ([string]$sd).Trim(); $i = $t.IndexOf('D:'); if ($i -lt 0) { return $t }; $t = $t.Substring($i); $j = $t.IndexOf('S:'); if ($j -ge 0) { $t = $t.Substring(0, $j) }; $t }
function Test-ScSddl([string]$sdshow, [string]$want) { -not [string]::IsNullOrEmpty($want) -and (Get-DaclPart $sdshow) -ceq $want }
function Get-ScText([string[]]$scArgs) { $t = & $Sc @scArgs | Out-String; if ($LASTEXITCODE -ne 0) { 'unreadable' } else { $t } }
foreach ($pair in @(@('CluedCIResident', 'resident', $ResidentPrivileges), @('CluedCISwapBroker', 'broker', $BrokerPrivileges))) {
  $p = Get-ScText @('qprivs', $pair[0], '8192')
  Record ($pair[1] + '-required-privileges') $(if ($p -eq 'unreadable') { 'unreadable' } else { Test-ExactPrivileges (ConvertFrom-ScPrivs $p) $pair[2] })
  $d = Get-ScText @('sdshow', $pair[0])
  Record ($pair[1] + '-service-dacl') $(if ($d -eq 'unreadable') { 'unreadable' } else { Test-ScSddl $d $receipt.($pair[1] + 'Sddl') })
}
Record 'broker-binary-path-and-config-pin' (Test-BrokerBinaryPath $bq $Root $receipt.brokerConfigSha256 $NodeProfileSha256)
Record 'broker-config-hash' ((Sha256File (Join-Path $Root 'config\broker.json')) -ceq $receipt.brokerConfigSha256)
Record 'broker-failure-actions' (Test-BrokerFailureActions (Get-ServiceValue 'CluedCISwapBroker' 'FailureActions') (Get-ServiceValue 'CluedCISwapBroker' 'FailureActionsOnNonCrashFailures'))
foreach ($pair in @(@('state\service-token.json', $ResidentPrivileges, 'resident'), @('broker\token.json', $BrokerPrivileges, 'broker'))) {
  $f = Join-Path $Root $pair[0]
  Record ($pair[2] + '-effective-token-privileges') $(if (Test-Path -LiteralPath $f) { Test-TokenRecord (Get-Content -LiteralPath $f -Raw) $pair[1] } else { 'unreadable' })
}
try {
  Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\NetSecurity\NetSecurity.psd1'
  $rule = Get-NetFirewallRule -Name 'CluedCIResident-BlockOutbound' -ErrorAction Stop; $filter = $rule | Get-NetFirewallServiceFilter
  Record 'resident-outbound-blocked' ([string]$rule.Direction -ceq 'Outbound' -and [string]$rule.Action -ceq 'Block' -and [string]$rule.Enabled -ceq 'True' -and $filter.Service -ceq 'CluedCIResident')
  Record 'firewall-enabled' (@(Get-NetFirewallProfile | Where-Object { [string]$_.Enabled -cne 'True' }).Count -eq 0)
} catch { Record 'resident-outbound-blocked' $false }

$runnerSddl = try { Get-DaclPart (& $Sc sdshow $Runner | Out-String) } catch { 'unreadable' }
Record 'runner-sddl-unchanged' $(if ($runnerSddl -eq 'unreadable') { 'unreadable' } else { $runnerSddl -ceq $receipt.runnerSddlUnchanged })
$rq = & $Sc qc $Runner | Out-String
Record 'runner-original-and-controller' (($rq -match 'C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe') -and ($rq -match ('SERVICE_START_NAME\s*:\s*(\.|' + [regex]::Escape($Node.hostname) + ')\\clued-control')))
# Receipt /3: the install pinned this node profile; the installed record still carries it, and this is that host.
Record 'node-profile' (($receipt.PSObject.Properties.Name -ccontains 'node') -and (($receipt.node | ConvertTo-Json -Compress) -ceq ($Node | ConvertTo-Json -Compress)) -and [Environment]::MachineName -ceq $Node.hostname) $Node.nodeName

foreach ($m in @('config\source-installed-manifest.json', 'config\resident-installed-manifest.json')) {
  $man = Get-Content -LiteralPath (Join-Path $Root $m) -Raw | ConvertFrom-Json
  # Source v2 installs the CI Source under source\<ciSourceManifestSha256>, the hash of the installed record's
  # source-manifest.json (the package's sourceManifestSha256 names the file list, not the directory).
  $base = if ($man.root -ceq 'source') { Join-Path $Root ('source\' + (Sha256File (Join-Path $Root 'record\source-manifest.json'))) } else { Join-Path $Root ('resident\' + $receipt.residentManifestSha256) }
  $bad = @($man.files | Where-Object { (Sha256File (Join-Path $base $_.path)) -cne $_.sha256 })
  Record ('package:' + $m) ($bad.Count -eq 0) $bad.Count
}

# ---- M5: the companion without the Owner's log-on (ADR 0022 section 4.4) ----
# The functions are the installed copy's companion-headless.ps1 next to this file (its bytes are among the package files checked above).
. (Join-Path $PSScriptRoot 'companion-headless.ps1')
$companionOwnerSid = [string]$Node.ownerSid
$verifyIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$verifyCanFix = ($verifyIdentity.User.Value -ceq 'S-1-5-18') -or (New-Object Security.Principal.WindowsPrincipal($verifyIdentity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# A switch cut off (window closed, restart) leaves its marker: older than 15 minutes it is rolled back here, before anything else is read.
$companionPending = Read-CompanionPending $Root
if ($null -eq $companionPending) { Record 'companion-headless-pending' $true }
elseif (Test-CompanionPendingAbandoned $companionPending ([DateTimeOffset]::UtcNow)) {
  if ($verifyIdentity.User.Value -ceq 'S-1-5-18') {
    # Run by the upgrade channel (SYSTEM): it never touches the companion task (ADR 0022 section 4.4); the SYSTEM fall-back task owns this.
    Record 'companion-headless-pending' (Test-CompanionFallbackTask) 'STALE_MARKER_LEFT_TO_THE_FALLBACK_TASK'
  } elseif ($verifyCanFix) {
    try { $null = Invoke-CompanionStopAndFallback $Root $companionOwnerSid; try { Start-CompanionTask } catch { }; Record 'companion-headless-pending' $true 'STALE_MARKER_FELL_BACK' }
    catch { Record 'companion-headless-pending' $false 'COMPANION_HEADLESS_FALLBACK_FAILED' }
  } else { Record 'companion-headless-pending' $false 'COMPANION_HEADLESS_PENDING_STALE_RUN_ELEVATED' }
} else { Record 'companion-headless-pending' $false 'COMPANION_HEADLESS_SWITCH_IN_PROGRESS' }
# The task: exactly the password definition (ADR 0022 section 4.1) or exactly the interactive one (before the switch, after a fall-back).
$companionTask = Get-CompanionTaskFacts $Root $companionOwnerSid
Record 'companion-task-present' ($companionTask.exists)
Record 'companion-task' (@('password', 'interactive') -ccontains $companionTask.mode) ([string]$companionTask.mode + $(if (@($companionTask.problems).Count) { ':' + (@($companionTask.problems) -join ',') } else { '' }))
Record 'companion-task-logon' (-not (Test-CompanionLogonFailure $companionTask.lastTaskResult)) $(if ($null -ne $companionTask.lastTaskResult) { '0x' + ('{0:X8}' -f [int64]$companionTask.lastTaskResult) } else { $null })
$lockout = Get-LockoutPolicy
Record 'companion-lockout-margin' $(if ($companionTask.mode -ceq 'password') { Test-LockoutMargin $lockout } else { $true }) $(if ($null -eq $lockout) { 'unreadable' } else { 'threshold=' + $lockout.threshold + ';window=' + $lockout.windowMinutes + ';mode=' + $companionTask.mode })
# The launch file: admin-only, no link, this generation's node, entry and configuration, the Owner's own gh login.
$launchProblem = try {
  $lf = Join-Path $Root 'config\companion-launch.json'
  $item = Get-Item -LiteralPath $lf -Force
  $acl = Get-Acl -LiteralPath $lf
  $writers = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and -not (($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) -and
    @('S-1-5-18', 'S-1-5-32-544') -cnotcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -and ((([int]$_.FileSystemRights) -band 0x500D0156) -ne 0) })
  $l = Get-Content -LiteralPath $lf -Raw | ConvertFrom-Json
  $gh = Get-CompanionGhDirs ([string]$Node.ownerProfileDirectory)
  $entry = Join-Path $Root ('resident\' + $receipt.residentManifestSha256 + '\src\companion-main.mjs')
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'LAUNCH_LINK' }
  elseif (@('S-1-5-18', 'S-1-5-32-544') -cnotcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -or $writers.Count) { 'LAUNCH_ACL' }
  elseif ((@($l.PSObject.Properties.Name) -join ',') -cne 'contract,generation,nodeExe,nodeExeSha256,entry,entrySha256,configSha256,ghConfigDir,homeDir,pathDirs' -or $l.contract -cne $CompanionLaunchContract) { 'LAUNCH_SHAPE' }
  elseif ((Get-Field $receipt 'generation') -and $l.generation -ne $receipt.generation) { 'LAUNCH_GENERATION' }
  elseif ([string]$l.nodeExe -cne (Join-Path $Root 'runtime\node.exe') -or [string]$l.nodeExeSha256 -cne (Sha256File (Join-Path $Root 'runtime\node.exe'))) { 'LAUNCH_NODE' }
  elseif ([string]$l.entry -cne $entry -or [string]$l.entrySha256 -cne (Sha256File $entry)) { 'LAUNCH_ENTRY' }
  elseif ([string]$l.configSha256 -cne [string]$receipt.companionConfigSha256) { 'LAUNCH_CONFIG' }
  elseif ([string]$l.ghConfigDir -cne $gh.gh -or [string]$l.homeDir -cne $gh.home) { 'LAUNCH_GH_CONFIG' }
  else { $null }
} catch { 'LAUNCH_UNREADABLE' }
Record 'companion-launch' ($null -eq $launchProblem) $launchProblem
foreach ($pair in @(@('bin\CluedCompanionSupervisor.exe', 'companionSupervisorSha256', 'companion-supervisor-pin'), @('bin\CluedCompanionTaskRegistrar.exe', 'companionRegistrarSha256', 'companion-registrar-pin'))) {
  $f = Join-Path $Root $pair[0]
  Record $pair[2] (($receipt.PSObject.Properties.Name -ccontains $pair[1]) -and (Test-Path -LiteralPath $f -PathType Leaf) -and ((Sha256File $f) -ceq [string]$receipt.($pair[1])))
}
$notifierTask = Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentNotifier' -ErrorAction SilentlyContinue
$notifierAction = Get-NotifierAction $Root $receipt.residentManifestSha256
Record 'notifier-task' ($null -ne $notifierTask -and [string]$notifierTask.Principal.RunLevel -ceq 'Limited' -and [string]$notifierTask.Principal.LogonType -ceq 'Interactive' -and @($notifierTask.Actions).Count -eq 1 -and
  [string]@($notifierTask.Actions)[0].Execute -ceq $notifierAction.path -and [string]@($notifierTask.Actions)[0].Arguments -ceq $notifierAction.arguments)
# The companion's own gh login (Owner decision): present, and its folder protected (SYSTEM, Administrators, the Owner; nothing inherited).
# Presence only: verify never reads the token. The companion checks the token's shape itself and does not start without it.
$ghProblem = try {
  $gh = Get-CompanionGhDirs ([string]$Node.ownerProfileDirectory)
  $base = Get-Item -LiteralPath $gh.base -Force
  $gacl = Get-Acl -LiteralPath $gh.base
  $others = @($gacl.Access | Where-Object { @('S-1-5-18', 'S-1-5-32-544', $companionOwnerSid) -cnotcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
  if (($base.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { 'GH_CONFIG_LINK' }
  elseif (-not $gacl.AreAccessRulesProtected -or $others.Count) { 'GH_CONFIG_ACL' }
  elseif (-not (Test-Path -LiteralPath (Join-Path $gh.gh 'hosts.yml') -PathType Leaf)) { 'GH_CONFIG_NO_LOGIN' }
  elseif (-not (Test-Path -LiteralPath (Join-Path $gh.home '.gitconfig') -PathType Leaf)) { 'GH_CONFIG_NO_GITCONFIG' }
  else { $null }
} catch { 'GH_CONFIG_MISSING' }
Record 'companion-gh-config' ($null -eq $ghProblem) $ghProblem
# Facts only (ADR 0022 section 4.4): the Owner's password expiry, and BitLocker on C: (elevated only).
$ownerUser = try { Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.LocalAccounts' -ErrorAction Stop; Get-LocalUser -SID $companionOwnerSid -ErrorAction Stop } catch { $null }
$bitlocker = if ($verifyCanFix) { try { [string](Get-BitLockerVolume -MountPoint 'C:' -ErrorAction Stop).ProtectionStatus } catch { 'unreadable' } } else { 'not-elevated' }
Record 'companion-facts' $true ('passwordExpires=' + $(if ($ownerUser -and $ownerUser.PasswordExpires) { ([DateTime]$ownerUser.PasswordExpires).ToString('yyyy-MM-dd') } elseif ($ownerUser) { 'never' } else { 'unreadable' }) + ';bitlocker=' + $bitlocker)
# M5-b (ADR 0023): on a node whose companion runs as its own account (install\companion-account.json; absent elsewhere).
$companionAccountRecord = try { Read-CompanionAccountRecord $Root $Node } catch { 'COMPANION_ACCOUNT_RECORD_REFUSED' }
if ($companionAccountRecord -is [string]) { Record 'companion-account' $false $companionAccountRecord }
elseif ($null -ne $companionAccountRecord) {
  $accountProblem = Get-CompanionAccountVerify $Root $Node $companionAccountRecord ([bool]$verifyCanFix); Record 'companion-account' ($null -eq $accountProblem) $accountProblem
  # SYSTEM only (the upgrade channel's VERIFY): first make the two parents carry the account's entry, with install-resident.ps1's own
  # rule (Invoke-CompanionRelayParentsEnsure), then check them as before. By hand (elevated or not): check only, never write.
  # The rule's bytes: this generation's install-resident.ps1, whose sha256 is the one this generation's resident manifest pins
  # (config\resident-installed-manifest.json, whose own hash is the receipt's residentManifestSha256 and this folder's name).
  $relayAdded = $null
  if ($verifyIdentity.User.Value -ceq 'S-1-5-18') {
    $relayAdded = try {
      $residentManifest = Join-Path $Root 'config\resident-installed-manifest.json'
      $residentManifestSha = Sha256File $residentManifest
      if ($residentManifestSha -cne [string]$receipt.residentManifestSha256 -or (Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)) -cne $residentManifestSha) { throw 'RELAY_PARENT_RULE_NOT_THIS_GENERATION' }
      $rulePin = @(@((Get-Content -LiteralPath $residentManifest -Raw | ConvertFrom-Json).files) | Where-Object { [string]$_.path -ceq 'windows/install-resident.ps1' })
      if ($rulePin.Count -ne 1 -or [string]$rulePin[0].sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'RELAY_PARENT_RULE_NOT_PINNED' }
      Invoke-CompanionRelayParentsEnsure $Root ([string]$Node.ownerSid) (Join-Path $PSScriptRoot 'install-resident.ps1') ([string]$rulePin[0].sha256)
    } catch { 'COMPANION_RELAY_PARENT_ENSURE_REFUSED:' + $_.Exception.Message }
  }
  $parentProblem = Get-CompanionRelayParentsProblem ([string]$Node.ownerSid)
  Record 'companion-relay-parents' ($null -eq $parentProblem -and $relayAdded -isnot [string]) $(if ($relayAdded -is [string]) { $relayAdded } elseif ($parentProblem) { $parentProblem } elseif ($relayAdded) { 'ADDED:' + $relayAdded } else { $null })
}
Record 'not-halted' (-not (Test-Path -LiteralPath (Join-Path $Root 'state\HALT.json')))
$pausedFile = Join-Path $Root 'state\PAUSED.json'
if ($ExpectPausedSha256) { Record 'paused-as-expected' ((Test-Path -LiteralPath $pausedFile -PathType Leaf) -and ((Sha256File $pausedFile) -ceq $ExpectPausedSha256)) }
else { Record 'not-paused' (-not (Test-Path -LiteralPath $pausedFile)) }
$hbAcl = Test-HeartbeatTokenAcl $Root ([string]$Node.ownerSid)
Record 'heartbeat-token-acl' $hbAcl.ok $hbAcl.detail
$hbBinding = Get-HeartbeatBindingState $receipt
Record 'heartbeat-binding' $hbBinding.ok $hbBinding.detail
$node = Join-Path $Root 'runtime\node.exe'
$verifier = Join-Path $Root ('resident\' + $receipt.residentManifestSha256 + '\tools\verify-receipts.mjs')
# node is started with a cleared, fixed environment (no NODE_OPTIONS or other user variables) so an
# elevated verify never hands the admin token to code chosen through the Owner's environment (review M1).
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $node; $psi.Arguments = '"' + $verifier + '" "' + (Join-Path $Root 'state\receipts') + '"'
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true; $psi.WorkingDirectory = $Root
$psi.EnvironmentVariables.Clear(); foreach ($kv in @(@('SystemRoot', 'C:\Windows'), @('WINDIR', 'C:\Windows'), @('PATH', 'C:\Windows\System32'))) { $psi.EnvironmentVariables[$kv[0]] = $kv[1] }
$proc = [Diagnostics.Process]::Start($psi); $chain = $proc.StandardOutput.ReadToEnd(); $proc.WaitForExit()
Record 'receipt-chain' ($proc.ExitCode -eq 0) ($chain.Trim())

# ---- Receipt /6: the upgrade channel (018da927) ----
if ($receipt.contract -ceq 'clued.independent-ci.resident-install-receipt/6') {
  $u = Get-Field $receipt 'upgrader'
  # upgrader-service: the SCM's view and the host's own token record.
  $uq = Get-ScText @('qc', 'CluedCIUpgrader', '8192')
  if ($uq -eq 'unreadable' -or $null -eq $u) { Record 'upgrader-service' $false 'UPGRADER_SERVICE_MISSING' }
  else {
    $bad = @()
    if ($uq -notmatch 'SERVICE_START_NAME\s*:\s*LocalSystem') { $bad += 'account' }
    if ($uq -notmatch 'START_TYPE\s*:\s*2\s+AUTO_START\s+\(DELAYED\)') { $bad += 'start-type' }
    if ((Get-ScText @('queryex', 'CluedCIUpgrader')) -notmatch 'STATE\s*:\s*4\s') { $bad += 'not-running' }
    $up = Get-ScText @('qprivs', 'CluedCIUpgrader', '8192'); $ud = Get-ScText @('sdshow', 'CluedCIUpgrader')
    if ($up -ne 'unreadable' -and -not ((Test-ExactPrivileges (ConvertFrom-ScPrivs $up) @('SeChangeNotifyPrivilege')) -and (Test-ExactPrivileges (ConvertFrom-ScPrivs $up) @(Get-Field $u 'requiredPrivileges')))) { $bad += 'required-privileges' }
    if ($ud -ne 'unreadable' -and -not (Test-ScSddl $ud (Get-Field $u 'sddl'))) { $bad += 'service-dacl' }
    $tokenRecord = Join-Path $Root 'upgrade\upgrader-token.json'
    if (-not ((Test-Path -LiteralPath $tokenRecord -PathType Leaf) -and (Test-TokenRecord (Get-Content -LiteralPath $tokenRecord -Raw) @('SeChangeNotifyPrivilege')))) { $bad += 'effective-token-privileges' }
    Record 'upgrader-service' $(if ($bad.Count) { $false } elseif ($up -eq 'unreadable' -or $ud -eq 'unreadable') { 'unreadable' } else { $true }) ($bad -join ',')
  }
  $pinOk = if ($null -eq $u) { $false } else { Test-UpgraderPins $Root $u $(if ($uq -eq 'unreadable') { $null } else { $uq }) }
  Record 'upgrader-pin' $pinOk $script:upgraderPinDetail
  $gc = Test-GenerationCurrent $Root $receipt $ExpectedInstallReceiptSha256
  Record 'generation-current' $gc.ok $gc.detail
  $tc = Test-TwoSidesConsistent $Root $LinuxVersionFactsFile ([DateTimeOffset]::UtcNow)
  Record 'two-sides-consistent' $tc.ok $tc.detail
}

$verdict = Get-VerifyVerdict $checks
[ordered]@{ status = $verdict.status; checks = $checks } | ConvertTo-Json -Depth 6
exit $verdict.exit
} catch {
  $failure = Get-VerifyInputFailure $script:VerifyInputCheck ([string]$_.Exception.Message)
  Record $failure.check $false $failure.detail
  [ordered]@{ status = 'RESIDENT_VERIFICATION_FAILED'; checks = $checks } | ConvertTo-Json -Depth 6
  exit 1
}
