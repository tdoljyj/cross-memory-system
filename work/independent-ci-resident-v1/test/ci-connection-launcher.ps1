param([Parameter(Mandatory=$true)][string]$FixtureRoot,[switch]$ForeignPause)
# 只装入恢复和记录所需的函数。在夹具目录运行模板的 main，宿主操作由替身接管。
$ErrorActionPreference='Stop'
$template=Join-Path $PSScriptRoot '../reinstall/launcher/template.ps1'
$source=[IO.File]::ReadAllText($template)
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
foreach ($name in @('Assert-CiInstallBaseline','Restore-W1Pause','Get-FileSha','Sha256Bytes','Get-Key','Parse-Json','Wait-Until','Stop-Launch','Write-Json','Write-New')) {
  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true)
  if ($null -eq $fn) { throw "FIXTURE_MISSING_FUNCTION $name" }
  . ([scriptblock]::Create($fn.Extent.Text))
}
Add-Type -AssemblyName System.Web.Extensions
$Js=New-Object Web.Script.Serialization.JavaScriptSerializer
$U8=New-Object Text.UTF8Encoding($false)
$ResidentRoot=Join-Path $FixtureRoot 'resident'
$Out=Join-Path $FixtureRoot 'output'
$pause=Join-Path $ResidentRoot 'state/PAUSED.json'
$InstalledResidentManifestSha256='a'*64
$door=Join-Path $ResidentRoot ('resident/'+$InstalledResidentManifestSha256+'/windows/rearm-resident.ps1')
$connection=Join-Path $FixtureRoot 'secrets/ci-admission.connection.json'
foreach ($p in @($pause,$door,$connection)) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)) }
[IO.File]::WriteAllText($door,'fixture door')
$FleetInstalledRearmSha256=Get-FileSha $door
$FleetPlanSha256='b'*64; $FleetFirstInstall=$false; $FleetW1PauseReason='fixture-w1'; $FleetW1ResumeWaitSeconds=0
[IO.File]::WriteAllText($pause,'{"source":{"reason":"fixture-w1"}}')
$InstalledPausedSha256=Get-FileSha $pause
if ($ForeignPause) { [IO.File]::WriteAllText($pause,'{"source":{"reason":"other"}}') }
[IO.File]::WriteAllText($connection,'{}')
$W1Restore=@{armed=$false;result=$null}; $Done=@(); $CarriedTokens=@{}; $calls=New-Object Collections.ArrayList
function Step-Identity {}
function Step-HostHygiene {}
function Step-SweepCarry {}
function Step-Output { [void][IO.Directory]::CreateDirectory($Out) }
function Step-Package {}
function Step-Stage { $script:staged=$true }
function Step-WindowsPreflightBeforeLinux { throw 'FIXTURE_INSTALL_CONTINUED' }
function Remove-FleetCarry {}
function Invoke-Child($name,$path,$arguments) {
  if (!$staged -or $name -cne 'w1-resume' -or $path -ine $door -or
      ($arguments -join ' ') -cne ('-Request Resume -ExpectedPausedSha256 '+$InstalledPausedSha256)) { throw 'FIXTURE_WRONG_RESUME' }
  [void]$calls.Add($name)
  [IO.File]::Delete($pause)
  @{exit=0;stdout='RESUME_REQUESTED_SERVICE_WILL_VERIFY'}
}
$main=($source -split '(?m)^#region main\s*$',2)[1]
try { $null=& ([scriptblock]::Create($main)); throw 'FIXTURE_LAUNCH_CONTINUED' } catch { $reason=$_.Exception.Message }
$terminal=Parse-Json ([IO.File]::ReadAllText((Join-Path $Out 'terminal.json')))
[Console]::Out.Write((@{code=$reason;paused=[IO.File]::Exists($pause);calls=@($calls);terminal=$terminal} | ConvertTo-Json -Compress -Depth 5))
