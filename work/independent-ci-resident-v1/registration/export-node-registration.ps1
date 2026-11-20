# Node registration export for Windows nodes (Task c9673047). Windows PowerShell 5.1 or PowerShell 7, run elevated.
#
#   -Mode export (default)  read-only. Opens the node's two persisted CNG machine keys, exports ONLY their public part
#                           (EccPublicBlob), observes the host (OS, memory, Hyper-V, Windows Sandbox, TPM, local Docker) and hands
#                           these public facts to export-node-registration.mjs, which writes the /ci-nodes registration document and
#                           its qualification report. A missing key is KEY_MISSING; nothing is created.
#   -Mode init-keys         only with -ConfirmCreateKeys: creates the identity key (ECDSA P-256, signing) and the encryption key
#                           (ECDH P-256, key agreement) as non-exportable machine keys. -KeyProvider says where the IDENTITY key
#                           goes: the TPM (Microsoft Platform Crypto Provider) when one is usable, else the Microsoft Software Key
#                           Storage Provider (auto, with a warning that carries the TPM error); tpm refuses instead of falling back;
#                           software. The ENCRYPTION key is always made in the software provider: the TPM provider refuses an ECDH
#                           key with key-agreement usage (NTE_NOT_SUPPORTED 0x80090029, seen on Intel PTT and on a Hyper-V vTPM),
#                           and only the identity key is required in the TPM (M5 checks it; the renewal signs with it). Both nodes in
#                           service have this layout since their keys were made (Fable 11-21 "r5 node key"). Refuses (KEY_EXISTS)
#                           when either key already exists in either provider. A key whose public coordinates the registration RPC
#                           would refuse is deleted and created again; any failure deletes the keys this run created, so the node is
#                           never left with one key. It is a key operation: run it only in an install wave the Owner approved.
#   -SelfTest               creates the two keys the way init-keys does (Get-KeyProviders, New-NodeKey; -KeyProvider as there,
#                           software when not given) but in the current user's store (no elevation) under names only this run uses
#                           (Clued-SelfTest-<role>-<guid>), deletes them again before it exits, and prints their public JWKs and
#                           origins, one signature and the parsed list parameters, so the tests check the real providers, the blob
#                           conversion and the argument handling. The node's keys and the machine store are never touched.
#
# The private keys never leave CNG: the script never asks for a private export (software keys are created with ExportPolicy None;
# TPM keys cannot be exported at all). Every refusal prints one CODE: detail line and exits 2.
param(
  [ValidateSet('export', 'init-keys')] [string]$Mode = 'export',
  [switch]$ConfirmCreateKeys,
  [ValidateSet('auto', 'tpm', 'software')] [string]$KeyProvider = 'auto',
  [string]$BindingId,
  [string]$Name,
  [int]$SlotCount = 0,
  [string]$SiteId,
  [string[]]$EnvironmentKind = @(),
  [string[]]$Role = @(),
  [string[]]$Exclusion = @(),
  [int]$MemoryLimitMb = -1,
  [switch]$PublisherRequested,
  [switch]$ScanSigningRequested,
  [string]$SourceManifest = 'C:\ProgramData\CluedIndependentCI\resident\record\source-manifest.json',
  [string]$SourceCommit,
  [string]$Out = 'clued-node-registration.json',
  [string]$ReportOut,
  [string]$Node = 'node',
  [switch]$FactsOnly,
  [switch]$SelfTest
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Fail([string]$Code, [string]$Detail) { [Console]::Error.WriteLine("${Code}: $Detail"); exit 2 }
trap { Fail 'INTERNAL' $_.Exception.Message }
Add-Type -AssemblyName System.Core

$KeyNames = [ordered]@{ identity = 'Clued-CI-Node-Identity-v1'; encryption = 'Clued-CI-Node-Encryption-v1' }
$TpmProviderName = 'Microsoft Platform Crypto Provider'
# BCRYPT_ECCKEY_BLOB magics (bcrypt.h): ECDSA public P-256 'ECS1', ECDH public P-256 'ECK1'.
$Magic = @{ identity = [uint32]0x31534345; encryption = [uint32]0x314B4345 }
# The registration RPC's own filter (registration-core.mjs#databaseRefuses): no word boundary, case-insensitive.
$DatabaseRefused = '(-----BEGIN[^-]*PRIVATE KEY-----|Bearer\s|ghp_|gho_|github_pat_|postgres(ql)?://[^/@:]+:[^/@]+@)'

# powershell -File passes "-Role scan,publish" as ONE string; accept comma lists (and repeated elements from -Command).
function Split-List([string[]]$Values) { , @($Values | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$EnvironmentKind = Split-List $EnvironmentKind
$Role = Split-List $Role
$Exclusion = Split-List $Exclusion

function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }

# BCRYPT_ECCKEY_BLOB { ULONG dwMagic; ULONG cbKey; X[cbKey]; Y[cbKey] } -> { kty, crv, x, y }.
function ConvertFrom-EccPublicBlob([byte[]]$Blob, [uint32]$ExpectedMagic) {
  if ($Blob.Length -ne 72) { throw "PUBLIC_KEY_INVALID: blob length $($Blob.Length)" }
  $magic = [BitConverter]::ToUInt32($Blob, 0); $size = [BitConverter]::ToUInt32($Blob, 4)
  if ($magic -ne $ExpectedMagic -or $size -ne 32) { throw ('PUBLIC_KEY_INVALID: magic 0x{0:X8} size {1}' -f $magic, $size) }
  $x = New-Object byte[] 32; $y = New-Object byte[] 32
  [Array]::Copy($Blob, 8, $x, 0, 32); [Array]::Copy($Blob, 40, $y, 0, 32)
  [ordered]@{ kty = 'EC'; crv = 'P-256'; x = (ConvertTo-Base64Url $x); y = (ConvertTo-Base64Url $y) }
}
function Test-Registrable($Jwk) { -not ("$($Jwk.x) $($Jwk.y)" -match $DatabaseRefused) }

function Get-Providers {
  $list = @()
  $list += , @((New-Object System.Security.Cryptography.CngProvider $TpmProviderName), 'tpm')
  $list += , @([System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider, 'software')
  $list
}

# Where a named machine key exists: @{ key = CngKey; origin = 'tpm'|'software' } or $null. An unusable TPM provider is skipped.
function Find-MachineKey([string]$KeyName) {
  foreach ($entry in Get-Providers) {
    $exists = $false
    try { $exists = [System.Security.Cryptography.CngKey]::Exists($KeyName, $entry[0], [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey) } catch { continue }
    if ($exists) {
      try { $key = [System.Security.Cryptography.CngKey]::Open($KeyName, $entry[0], [System.Security.Cryptography.CngKeyOpenOptions]::MachineKey) }
      catch { Fail 'KEY_ACCESS_DENIED' "$KeyName exists but cannot be opened ($($_.Exception.Message)); run elevated" }
      return @{ key = $key; origin = $entry[1] }
    }
  }
  $null
}

# The providers a key of $KeyRole may be made in, in order (entries of Get-Providers). The identity key: where $Wanted says (auto: the
# TPM, then software; tpm; software). The encryption key: the software provider only, whatever $Wanted says (see init-keys above).
function Get-KeyProviders([string]$KeyRole, [string]$Wanted) {
  if ($KeyRole -ceq 'encryption') { Get-Providers | Where-Object { $_[1] -ceq 'software' } }
  else { Get-Providers | Where-Object { $Wanted -ceq 'auto' -or $_[1] -ceq $Wanted } }
}

# The one place a key is created (init-keys and -SelfTest): $KeyRole's algorithm and usage (identity: ECDSA P-256, signing; encryption:
# ECDH P-256, key agreement), in the provider of $Entry (an entry of Get-Providers), named $KeyName, with $Options (MachineKey for
# init-keys, None for the self-test). A software key gets ExportPolicy None; a TPM key is non-exportable by construction, and the platform
# provider may refuse an export-policy property. An empty name is refused (KEY_NAME_REQUIRED): Windows PowerShell passes $null to a
# [string] as '', which the software provider persists as a key named '' (not an ephemeral key), so no caller can make one.
function New-NodeKey([string]$KeyRole, $Entry, [string]$KeyName, [System.Security.Cryptography.CngKeyCreationOptions]$Options) {
  if ([string]::IsNullOrEmpty($KeyName)) { throw 'KEY_NAME_REQUIRED: New-NodeKey creates named keys only' }
  $identity = $KeyRole -ceq 'identity'
  $parameters = New-Object System.Security.Cryptography.CngKeyCreationParameters
  $parameters.Provider = $Entry[0]
  $parameters.KeyCreationOptions = $Options
  if ($Entry[1] -cne 'tpm') { $parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None }
  $parameters.KeyUsage = if ($identity) { [System.Security.Cryptography.CngKeyUsages]::Signing } else { [System.Security.Cryptography.CngKeyUsages]::KeyAgreement }
  $algorithm = if ($identity) { [System.Security.Cryptography.CngAlgorithm]::ECDsaP256 } else { [System.Security.Cryptography.CngAlgorithm]::ECDiffieHellmanP256 }
  [System.Security.Cryptography.CngKey]::Create($algorithm, $KeyName, $parameters)
}

function Test-Elevated {
  $principal = New-Object System.Security.Principal.WindowsPrincipal ([System.Security.Principal.WindowsIdentity]::GetCurrent())
  $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The local Docker daemon only: DOCKER_HOST is dropped and the context forced to "default", so no remote endpoint is contacted.
function Get-LocalDockerVersion {
  try {
    $info = New-Object System.Diagnostics.ProcessStartInfo 'docker'
    $info.Arguments = 'version --format "{{.Server.Version}}"'
    $info.UseShellExecute = $false; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.CreateNoWindow = $true
    $info.EnvironmentVariables.Remove('DOCKER_HOST'); $info.EnvironmentVariables['DOCKER_CONTEXT'] = 'default'
    $process = [System.Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(15000)) { try { $process.Kill() } catch { }; return $null }
    $null = $stderr.Result
    if ($process.ExitCode -ne 0) { return $null }
    $text = $stdout.Result.Trim()
    if ($text -match '^[0-9A-Za-z.+_-]{1,64}$') { return $text }
    return $null
  } catch { return $null }
}

# An optional feature is enabled when any of its names (client and Server SKUs differ) has InstallState 1; null when unreadable.
function Get-FeatureEnabled([string[]]$FeatureNames) {
  try {
    foreach ($featureName in $FeatureNames) {
      $feature = Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='$featureName'" -ErrorAction Stop
      if ($null -ne $feature -and [int]$feature.InstallState -eq 1) { return $true }
    }
    return $false
  } catch { return $null }
}

if ($SelfTest) {
  # Keys of the current user under names only this run uses (a null name is no way out: Windows PowerShell passes it as an empty name, a
  # persisted software key; and the TPM provider refuses .NET's ephemeral-key property, NTE_BAD_FLAGS). Deleted again in finally.
  $selfProvider = if ($PSBoundParameters.ContainsKey('KeyProvider')) { $KeyProvider } else { 'software' }
  $selfKeys = @(); $made = @{}; $origins = @{}; $names = @(); $failure = $null; $answer = $null
  try {
    foreach ($keyRole in $KeyNames.Keys) {
      $errors = @()
      foreach ($entry in @(Get-KeyProviders $keyRole $selfProvider)) {
        $selfName = 'Clued-SelfTest-' + $keyRole + '-' + [Guid]::NewGuid().ToString('N')
        try { $key = New-NodeKey $keyRole $entry $selfName ([System.Security.Cryptography.CngKeyCreationOptions]::None) }
        catch { $errors += "$($entry[1]): $($_.Exception.Message)"; continue }
        $selfKeys += $key; $names += $selfName; $made[$keyRole] = $key; $origins[$keyRole] = $entry[1]; break
      }
      if (-not $made.ContainsKey($keyRole)) { throw "KEY_CREATE_FAILED: $($keyRole): $($errors -join '; ')" }
    }
    $message = [Text.Encoding]::UTF8.GetBytes('clued-ci-node-registration self-test')
    $ecdsa = New-Object System.Security.Cryptography.ECDsaCng $made.identity
    $ecdsa.HashAlgorithm = [System.Security.Cryptography.CngAlgorithm]::Sha256
    $answer = [ordered]@{
      identity_public_jwk = (ConvertFrom-EccPublicBlob ($made.identity.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) $Magic.identity)
      encryption_public_jwk = (ConvertFrom-EccPublicBlob ($made.encryption.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) $Magic.encryption)
      identity_origin = $origins.identity; encryption_origin = $origins.encryption; self_test_key_names = @($names)
      message = [Convert]::ToBase64String($message)
      signature_p1363 = [Convert]::ToBase64String($ecdsa.SignData($message))
      roles = @($Role); environment_kinds = @($EnvironmentKind); exclusions = @($Exclusion)
      database_refuses = @('xxghp_yy', 'GHO_', 'plain') | ForEach-Object { -not (Test-Registrable @{ x = $_; y = '' }) }
    } | ConvertTo-Json -Compress -Depth 4
  } catch { $failure = $_.Exception.Message }
  finally { foreach ($selfKey in $selfKeys) { try { $selfKey.Delete() } catch { } } }
  if ($null -ne $failure) {
    if ($failure -match '^(KEY_CREATE_FAILED|PUBLIC_KEY_INVALID): ') { Fail $Matches[1] ($failure -replace '^[A-Z_]+: ', '') }
    Fail 'KEY_CREATE_FAILED' $failure
  }
  $answer
  exit 0
}

if (-not (Test-Elevated)) { Fail 'ELEVATION_REQUIRED' 'machine keys and the TPM state are readable only from an elevated PowerShell (Run as administrator)' }

if ($Mode -eq 'init-keys') {
  if (-not $ConfirmCreateKeys) { Fail 'CONFIRMATION_REQUIRED' 'init-keys creates node keys; pass -ConfirmCreateKeys, and only in an install wave the Owner approved' }
  foreach ($keyRole in $KeyNames.Keys) {
    $found = Find-MachineKey $KeyNames[$keyRole]
    if ($null -ne $found) { Fail 'KEY_EXISTS' "$($KeyNames[$keyRole]) already exists ($($found.origin)); init-keys never replaces a key" }
  }
  $createdKeys = @()
  $created = [ordered]@{}
  try {
    foreach ($keyRole in $KeyNames.Keys) {
      $key = $null; $origin = $null; $jwk = $null; $errors = @()
      foreach ($entry in @(Get-KeyProviders $keyRole $KeyProvider)) {
        for ($attempt = 0; $attempt -lt 16 -and $null -eq $jwk; $attempt++) {
          try { $key = New-NodeKey $keyRole $entry $KeyNames[$keyRole] ([System.Security.Cryptography.CngKeyCreationOptions]::MachineKey) }
          catch {
            # NTE_EXISTS (0x8009000F): the name exists in this provider after all (a concurrent run, or a key Find-MachineKey could
            # not see). Stop rather than create a second key of the same name in the other provider.
            if ($_.Exception.HResult -eq -2146893809 -or $_.Exception.Message -match 'already exists') { throw "KEY_EXISTS: $($KeyNames[$keyRole]) ($($entry[1]))" }
            $errors += "$($entry[1]): $($_.Exception.Message)"; break
          }
          # From here the new key is ours to delete: an export or conversion failure must not leave it behind.
          try { $candidate = ConvertFrom-EccPublicBlob ($key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) $Magic[$keyRole] }
          catch { try { $key.Delete() } catch { }; throw "PUBLIC_KEY_INVALID: $($KeyNames[$keyRole]) ($($entry[1])): $($_.Exception.Message)" }
          if (Test-Registrable $candidate) { $jwk = $candidate; $origin = $entry[1] }
          else { $key.Delete(); $key = $null }
        }
        if ($null -ne $jwk) { break }
      }
      if ($null -eq $jwk) { throw "KEY_CREATE_FAILED: $($KeyNames[$keyRole]): $($errors -join '; ')" }
      $createdKeys += $key
      if ($origin -eq 'software' -and $KeyProvider -eq 'auto' -and $errors.Count -gt 0) {
        [Console]::Error.WriteLine("WARNING: $($KeyNames[$keyRole]) was created in software because the TPM refused: $($errors -join '; ')")
      }
      $created[$keyRole] = [ordered]@{ name = $KeyNames[$keyRole]; origin = $origin; public_jwk = $jwk }
    }
  } catch {
    # Never leave the node with one key: delete exactly what this run created.
    foreach ($createdKey in $createdKeys) { try { $createdKey.Delete() } catch { } }
    $message = $_.Exception.Message
    if ($message -match '^(KEY_CREATE_FAILED|PUBLIC_KEY_INVALID|KEY_EXISTS): ') { Fail $Matches[1] ($message -replace '^[A-Z_]+: ', '') }
    Fail 'KEY_CREATE_FAILED' $message
  }
  [ordered]@{ status = 'created'; keys = $created } | ConvertTo-Json -Depth 5
  exit 0
}

# export: read-only.
$keys = @{}
foreach ($keyRole in $KeyNames.Keys) {
  $found = Find-MachineKey $KeyNames[$keyRole]
  if ($null -eq $found) { Fail 'KEY_MISSING' "$($KeyNames[$keyRole]) does not exist (run -Mode init-keys only in an approved install wave)" }
  try { $jwk = ConvertFrom-EccPublicBlob ($found.key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)) $Magic[$keyRole] }
  catch { Fail 'PUBLIC_KEY_INVALID' "$($KeyNames[$keyRole]): $($_.Exception.Message)" }
  $keys[$keyRole] = @{ jwk = $jwk; origin = $found.origin }
}

$system = Get-CimInstance -ClassName Win32_ComputerSystem
$osInfo = Get-CimInstance -ClassName Win32_OperatingSystem
$tpm = $null
try {
  $state = Get-CimInstance -Namespace 'root/cimv2/Security/MicrosoftTpm' -ClassName Win32_Tpm -ErrorAction Stop
  $tpm = ($null -ne $state -and [bool]$state.IsEnabled_InitialValue -and [bool]$state.IsActivated_InitialValue)
} catch { $tpm = $null }
$facts = [ordered]@{
  os = 'windows'
  os_version = ("$($osInfo.Caption) $($osInfo.Version)").Trim()
  hostname = $env:COMPUTERNAME
  memory_mb = [int64][math]::Floor([double]$system.TotalPhysicalMemory / 1048576)
  docker_server_version = (Get-LocalDockerVersion)
  hyperv_enabled = (Get-FeatureEnabled @('Microsoft-Hyper-V-All', 'Microsoft-Hyper-V'))
  windows_sandbox_enabled = (Get-FeatureEnabled @('Containers-DisposableClientVM'))
  tpm_present = $tpm
  identity_public_jwk = $keys.identity.jwk
  encryption_public_jwk = $keys.encryption.jwk
  identity_key_origin = $keys.identity.origin
  encryption_key_origin = $keys.encryption.origin
}
$factsJson = $facts | ConvertTo-Json -Depth 5 -Compress
if ($FactsOnly) { $factsJson; exit 0 }

if ([string]::IsNullOrEmpty($BindingId)) { Fail 'USAGE' '-BindingId is required (the connection id of the node''s BeamingFace connection)' }
if ($SlotCount -lt 1) { Fail 'USAGE' '-SlotCount is required (1..64)' }
$nodeCommand = Get-Command $Node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) { Fail 'NODE_MISSING' "Node.js not found as '$Node'; pass -Node <path to node.exe>" }
$arguments = @((Join-Path $PSScriptRoot 'export-node-registration.mjs'), 'export', '--binding-id', $BindingId, '--slot-count', [string]$SlotCount, '--out', $Out)
if ($ReportOut) { $arguments += @('--report-out', $ReportOut) }
if ($Name) { $arguments += @('--name', $Name) }
if ($SiteId) { $arguments += @('--site-id', $SiteId) }
foreach ($item in $EnvironmentKind) { $arguments += @('--environment-kind', $item) }
foreach ($item in $Role) { $arguments += @('--role', $item) }
foreach ($item in $Exclusion) { $arguments += @('--exclusion', $item) }
if ($MemoryLimitMb -ge 0) { $arguments += @('--memory-limit-mb', [string]$MemoryLimitMb) }
if ($PublisherRequested) { $arguments += '--publisher-requested' }
if ($ScanSigningRequested) { $arguments += '--scan-signing-requested' }
if ($SourceCommit) { $arguments += @('--source-commit', $SourceCommit) } else { $arguments += @('--source-manifest', $SourceManifest) }
# Windows PowerShell 5.1 drops embedded double quotes and mangles a trailing backslash when it builds node's command line.
foreach ($argument in $arguments) {
  if ($argument -match '"' -or $argument -match '\\$') { Fail 'USAGE' "a value may not contain a double quote or end with a backslash: $argument" }
}
$code = 2
$factsFile = Join-Path ([IO.Path]::GetTempPath()) ("clued-node-facts-" + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($factsFile, $factsJson, (New-Object System.Text.UTF8Encoding $false))
try {
  & $nodeCommand.Source @arguments --facts $factsFile
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $factsFile -Force -ErrorAction SilentlyContinue
}
exit $code
