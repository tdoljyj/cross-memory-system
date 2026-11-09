# Shared with RegistrarCore.MachineWslClientScript; tests hold the resolver identical.
# Definitions only. No WSL command, installation or account change occurs here.
function Get-CluedMachineWslClient {
  try { foreach ($m in @('Management', 'Security', 'Utility')) { Import-Module ('C:\Windows\System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.' + $m + '\Microsoft.PowerShell.' + $m + '.psd1') -ErrorAction Stop } } catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  $p = 'C:\Program Files\WSL\wsl.exe'
  foreach ($v in @('C:\', 'C:\Program Files', 'C:\Program Files\WSL', $p)) {
    try { $i = Microsoft.PowerShell.Management\Get-Item -LiteralPath $v -Force -ErrorAction Stop }
    catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { throw 'WSL_MACHINE_CLIENT_MISSING' }; throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
    if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($v -ceq $p -and $i.PSIsContainer) -or ($v -cne $p -and -not $i.PSIsContainer)) { throw 'WSL_MACHINE_CLIENT_NOT_PLAIN' }
  }
  try { $s = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $p -ErrorAction Stop }
  catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  if ([string]$s.Status -cne 'Valid') { throw 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID' }
  $c = $s.SignerCertificate
  if ($null -eq $c -or $c.Subject -cnotmatch '(?:^|,\s*)CN=Microsoft Corporation(?:,|$)' -or
      $c.Subject -cnotmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)' -or
      $c.Thumbprint -cnotmatch '^[0-9A-Fa-f]{40}$') { throw 'WSL_MACHINE_CLIENT_PUBLISHER_INVALID' }
  try { $h = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash }
  catch { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  if ($h -cnotmatch '^[0-9A-Fa-f]{64}$') { throw 'WSL_MACHINE_CLIENT_UNREADABLE' }
  [pscustomobject]@{ contract = 'clued.independent-ci.wsl-client/1'; path = $p; sha256 = $h.ToLowerInvariant(); signerThumbprint = $c.Thumbprint.ToUpperInvariant() }
}
