param([Parameter(Mandatory=$true)][string]$CommandBase64)

$ErrorActionPreference = 'Stop'
$bytes = [Convert]::FromBase64String($CommandBase64)
if ($bytes.Length -gt 4096) { throw 'CI_TRAIN_SIGN_INPUT_REFUSED' }
$command = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
if ($command.protocol -cne 'clued.ci-node-command/1' -or $command.operation -cne 'merge_train_v2') {
  throw 'CI_TRAIN_SIGN_INPUT_REFUSED'
}
$keyName = 'Clued-CI-Node-Identity-v1'
$options = [Security.Cryptography.CngKeyOpenOptions]::MachineKey -bor [Security.Cryptography.CngKeyOpenOptions]::Silent
$key = $null
foreach ($name in @('Microsoft Platform Crypto Provider', 'Microsoft Software Key Storage Provider')) {
  $provider = New-Object Security.Cryptography.CngProvider $name
  try {
    $key = [Security.Cryptography.CngKey]::Open($keyName, $provider, $options)
    break
  } catch {
    # Only an absent key permits another provider. Access failures stop here.
    $errorCode = $_.Exception.GetBaseException().HResult
    if ($errorCode -notin @(-2146893802, -2146893807)) { throw }
  }
}
if ($null -eq $key) { throw 'CI_TRAIN_SIGN_KEY_REFUSED' }
try {
  if (-not $key.IsMachineKey -or $key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None) {
    throw 'CI_TRAIN_SIGN_KEY_REFUSED'
  }
  $signer = New-Object Security.Cryptography.ECDsaCng $key
  try {
    if ($signer.KeySize -ne 256) { throw 'CI_TRAIN_SIGN_KEY_REFUSED' }
    $signer.HashAlgorithm = [Security.Cryptography.CngAlgorithm]::Sha256
    [Convert]::ToBase64String($signer.SignData($bytes)).TrimEnd('=').Replace('+','-').Replace('/','_')
  } finally { $signer.Dispose() }
} finally { $key.Dispose() }
