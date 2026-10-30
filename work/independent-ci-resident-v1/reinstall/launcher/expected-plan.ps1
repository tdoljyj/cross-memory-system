# r5c (018da927): the post-uninstall view also hides CluedCIUpgrader (plan /8 servicesExist names three services). Never passes
# -UpgradeTokenFile: this is the reviewed no-token plan (the launcher compares the elevated with-token plan to it).
# r5: expected-plan-r4.ps1 plus the two secret targets of the 91288d28 installer (plan /7 `secrets`, Get-SecretsPlan). Read-only.
# Runs the REAL package installer in its default dry-run mode (never -Apply), either as is ('current') or with Test-Path answering
# $false for the resident root and Get-Service returning nothing for the two resident services ('post-uninstall').
# The Owner's non-elevated token cannot see C:\ProgramData\CluedControl\trusted or ...\CluedIndependentCI\secrets (Access denied, which
# the installer's Stop preference turns into a failure), so Test-Path answers for those two targets and their folders from
# -AppKeyTargetExists / -CiTokenTargetExists. The launcher checks, ELEVATED and before the uninstall, that the installer's own answers
# equal these (r5 S1); a wrong guess therefore stops the run before anything changes. Writes only to stdout.
param([Parameter(Mandatory)][ValidateSet('current', 'post-uninstall')][string]$View,
      [Parameter(Mandatory)][string]$PackageRoot,
      [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$PackageManifestSha256,
      [Parameter(Mandatory)][ValidateSet('true', 'false')][string]$AppKeyTargetExists,
      [Parameter(Mandatory)][ValidateSet('true', 'false')][string]$CiTokenTargetExists,
      [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$OwnerSid,       # the node profile's
      [Parameter(Mandatory)][ValidatePattern('^S-1-5-21-\d+-\d+-\d+-\d+$')][string]$ControllerSid)
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\CluedIndependentCI\resident'
$global:R5Secret = @{
  'C:\ProgramData\CluedControl\trusted\controller-checks-app.pem' = ($AppKeyTargetExists -ceq 'true')
  'C:\ProgramData\CluedControl\trusted' = $true   # the controller install's folder (node preparation creates it on every node)
  'C:\ProgramData\CluedIndependentCI\secrets\ci-admission.token' = ($CiTokenTargetExists -ceq 'true')
  'C:\ProgramData\CluedIndependentCI\secrets' = ($CiTokenTargetExists -ceq 'true')
}
$global:R5Root = $root; $global:R5PostUninstall = ($View -ceq 'post-uninstall')
function global:Test-Path {
  [CmdletBinding()] param([Parameter(Position = 0)][string[]]$Path, [string[]]$LiteralPath, [string]$PathType)
  $p = @(@($LiteralPath) + @($Path) | Where-Object { $_ })[0]
  foreach ($k in @($global:R5Secret.Keys)) { if ($p -and [string]::Equals($p, $k, [StringComparison]::OrdinalIgnoreCase)) { return $global:R5Secret[$k] } }
  if ($global:R5PostUninstall -and $p -and ([string]::Equals($p, $global:R5Root, [StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($global:R5Root + '\', [StringComparison]::OrdinalIgnoreCase))) { return $false }
  $a = @{}; if ($LiteralPath) { $a.LiteralPath = $LiteralPath } else { $a.Path = $Path }; if ($PathType) { $a.PathType = $PathType }
  Microsoft.PowerShell.Management\Test-Path @a
}
if ($View -ceq 'post-uninstall') {
  function global:Get-Service {
    [CmdletBinding()] param([Parameter(Position = 0)][string[]]$Name)
    @($Name | Where-Object { @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader') -notcontains $_ } | ForEach-Object { Microsoft.PowerShell.Management\Get-Service -Name $_ -ErrorAction SilentlyContinue })
  }
}
& (Join-Path $PackageRoot 'resident\windows\install-resident.ps1') -PackageRoot $PackageRoot -ExpectedPackageManifestSha256 $PackageManifestSha256 -OwnerSid $OwnerSid -ControllerSid $ControllerSid -StartAfterInstall
