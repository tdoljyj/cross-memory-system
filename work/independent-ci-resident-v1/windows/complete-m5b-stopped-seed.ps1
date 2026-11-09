# Finish only the known disposable test seed after WSL's VHD export reported a
# sharing violation. This is a stable-byte test-image copy, not a backup method
# or a claim that a live filesystem snapshot is transactionally consistent.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
if ([Environment]::MachineName -cne 'TURING') { throw 'TURING_ONLY' }
$root = 'C:\ProgramData\CluedM5bSeed1109'
$source = Join-Path $root 'owner-seed\ext4.vhdx'
$target = Join-Path $root 'ext4.vhdx'
$client = 'C:\Program Files\WSL\wsl.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
function Plain([string]$path) {
  for ($part = $path; $part; $part = Split-Path -Parent $part) {
    if (((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SEED_LINK_REFUSED' }
  }
}
foreach ($path in @($root, $source, $client)) { Plain $path }
foreach ($path in @('C:\', 'C:\ProgramData', 'C:\Program Files', 'C:\Program Files\WSL', $client, $root, (Split-Path -Parent $source))) {
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor((Get-Acl -LiteralPath $path).Sddl)
  $allowed = if ($path -ceq $root -or $path -ceq (Split-Path -Parent $source)) { @($trusted + $sid) } else { $trusted }
  if ($allowed -cnotcontains $descriptor.Owner.Value -or $null -eq $descriptor.DiscretionaryAcl) { throw 'SEED_PARENT_OWNER_REFUSED' }
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'SEED_PARENT_ACE_UNKNOWN' }
    if ([int]$ace.AceQualifier -ne [int][Security.AccessControl.AceQualifier]::AccessAllowed -or ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
    $danger = 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
    if ($path -cne 'C:\') { $danger = $danger -bor 0x10000 }
    if ($path -ceq $client) { $danger = $danger -bor 0x2 -bor 0x4 -bor 0x10 -bor 0x100 }
    if ($allowed -cnotcontains $ace.SecurityIdentifier.Value -and ($ace.AccessMask -band $danger) -ne 0) { throw 'SEED_PARENT_RENAME_OR_WRITE_UNSAFE' }
  }
}
$created = Get-Content -LiteralPath (Join-Path $root 'created.json') -Raw | ConvertFrom-Json
$export = Get-Content -LiteralPath (Join-Path $root 'export.json') -Raw | ConvertFrom-Json
if ($created.contract -cne 'clued.m5b.physical-seed/1' -or $created.root -cne $root -or $created.distro -cne 'CluedM5bSeed1109' -or
    $created.inputSha256 -cne '56e2810205c17a5dff78cdd7b2c2af4ccdef16f18d765d5bb0f527438b136676' -or
    $export.exitCode -ne -1 -or [string]$export.stdout -notmatch 'ERROR_SHARING_VIOLATION') { throw 'NOT_THE_OBSERVED_SEED_EXPORT_FAILURE' }
$registration = @(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DistributionName -ceq 'CluedM5bSeed1109' })
if ($registration.Count -ne 1 -or [string]$registration[0].BasePath -cne (Join-Path $root 'owner-seed')) { throw 'TEST_SEED_REGISTRATION_CHANGED' }
if (Test-Path -LiteralPath $target) { throw 'EXPORTED_SEED_ALREADY_EXISTS' }
$clientHandle = [IO.File]::Open($client, 'Open', 'Read', 'Read')
try {
  $signature = Get-AuthenticodeSignature -LiteralPath $client
  if ([string]$signature.Status -cne 'Valid' -or $signature.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)' -or
      $signature.SignerCertificate.Subject -cnotmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'WSL_CLIENT_REFUSED' }
  function Assert-SeedStopped {
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = $client; $process.StartInfo.Arguments = '--list --running --quiet'
    $process.StartInfo.UseShellExecute = $false; $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true; $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.EnvironmentVariables['WSL_UTF8'] = '1'
    try {
      [void]$process.Start(); $output = $process.StandardOutput.ReadToEndAsync(); $errorOutput = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'SEED_STATE_UNKNOWN' }
      if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errorOutput), 2000) -or $process.ExitCode -ne 0 -or $errorOutput.Result) { throw 'SEED_STATE_UNKNOWN' }
      $names = @($output.Result.Replace([string][char]0, '') -split "`r?`n" | ForEach-Object { $_.Trim([char]0xFEFF).Trim() } | Where-Object { $_ })
      foreach ($name in $names) { if ($name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$') { throw 'SEED_STATE_UNKNOWN' } }
      if ($names -icontains 'CluedM5bSeed1109') { throw 'TEST_SEED_STILL_RUNNING' }
      $names
    } finally { $process.Dispose() }
  }
  $before = @(Assert-SeedStopped)
  $incoming = [IO.File]::Open($source, 'Open', 'Read', 'ReadWrite')
  try {
    if ($incoming.Length -lt 1048576 -or $incoming.Length -gt 2147483648) { throw 'SEED_SIZE_REFUSED' }
    function Hash-Stream($stream) { $hash = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() } }
    $pre = Hash-Stream $incoming; $incoming.Position = 0
    $partial = $target + '.stable-copy.partial'
    $copy = [IO.File]::Open($partial, 'CreateNew', 'ReadWrite', 'None')
    try {
      $incoming.CopyTo($copy); $copy.Flush($true); $copy.Position = 0
      $copied = Hash-Stream $copy
    } finally { $copy.Dispose() }
    $incoming.Position = 0; $post = Hash-Stream $incoming
    if ($pre -cne $post -or $pre -cne $copied) { throw 'TEST_SEED_BYTES_CHANGED_PRESERVED' }
    $after = @(Assert-SeedStopped)
    [IO.File]::Move($partial, $target)
    $result = [ordered]@{ contract = 'clued.m5b.physical-seed/1'; status = 'STOPPED_TEST_SEED_STABLE_COPY'; method = 'stopped-test-image-stable-byte-copy'; source = $source; path = $target; sha256 = $copied; preSha256 = $pre; postSha256 = $post; length = $incoming.Length; beforeRunning = $before; afterRunning = $after; at = [DateTimeOffset]::UtcNow.ToString('o'); requiresRealImportProbe = $true; productionBackupQualification = $false }
    $record = [IO.File]::Open((Join-Path $root 'stable-copy-result.json'), 'CreateNew', 'Write', 'None')
    try { $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($result | ConvertTo-Json -Compress)); $record.Write($bytes, 0, $bytes.Length); $record.Flush($true) } finally { $record.Dispose() }
    $result | ConvertTo-Json -Compress
  } finally { $incoming.Dispose() }
} finally { $clientHandle.Dispose() }
