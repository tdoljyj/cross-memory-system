param([string]$FixtureRoot, [string]$Launcher, [string]$Scene)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($Launcher)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$pins = [regex]::Match($source, '(?s)#region pins\s+(.+?)#endregion pins').Groups[1].Value
. ([scriptblock]::Create($pins))
foreach ($name in @('Test-PreparedW1','Assert-CiInstallBaseline','Restore-W1Pause','Get-FileSha','Sha256Bytes','Get-Key','Parse-Json',
    'Wait-Until','Stop-Launch','Write-Json','Write-New','Invoke-Child','Step-SweepCarry','Step-Output')) {
  $fn = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name}, $true)
  if ($fn) { . ([scriptblock]::Create($fn.Extent.Text)) }
}
Add-Type -AssemblyName System.Web.Extensions
$Js = New-Object Web.Script.Serialization.JavaScriptSerializer
$U8 = New-Object Text.UTF8Encoding($false)
$CarryParent = $FixtureRoot
$ResidentRoot = Join-Path $FixtureRoot 'resident'
$Out = Join-Path $FixtureRoot 'output'
$pause = Join-Path $ResidentRoot 'state/PAUSED.json'
$InstalledResidentManifestSha256 = 'a'*64
$door = Join-Path $ResidentRoot ('resident/'+$InstalledResidentManifestSha256+'/windows/rearm-resident.ps1')
$connection = Join-Path $FixtureRoot 'secrets/ci-admission.connection.json'
foreach ($p in @($pause,$door,$connection)) { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)) }
$FleetW1PauseReason = 'fixture-w1'; $FleetW1ResumeWaitSeconds = 0
[IO.File]::WriteAllText($pause,'{"source":{"reason":"fixture-w1"}}')
$InstalledPausedSha256 = Get-FileSha $pause
if ($Scene -eq 'foreign') { [IO.File]::WriteAllText($pause,'{"source":{"reason":"other"}}') }
if ($Scene -notin @('clear','during-stage')) { [IO.File]::WriteAllText($connection,'{}') }
$priorId = (Sha256Bytes ($U8.GetBytes($Out.ToLowerInvariant()))).Substring(0,32)
if ($Scene -eq 'replay') { [void][IO.Directory]::CreateDirectory($Out) }
if ($Scene -eq 'progress') { [void][IO.Directory]::CreateDirectory((Join-Path $CarryParent ('reinstall-progress-'+$priorId))) }
$evidence = @(foreach ($prefix in @('reinstall-progress-','reinstall-linux-out-')) {
  $d = Join-Path $CarryParent ($prefix + ('1'*32))
  [void][IO.Directory]::CreateDirectory($d)
  $f = Join-Path $d 'prior.json'; [IO.File]::WriteAllText($f,'prior evidence'); $f
})
# 真实子进程执行器只启动此夹具脚本，核对请求参数并记录每次调用。
[IO.File]::WriteAllText($door,@'
param([string]$Request,[string]$ExpectedPausedSha256)
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$pause = Join-Path $root 'state\PAUSED.json'
[IO.File]::AppendAllText((Join-Path $root 'calls.txt'),"$Request`n")
if ($Request -cne 'Resume' -or (Get-FileHash -LiteralPath $pause).Hash -ine $ExpectedPausedSha256) { exit 7 }
[IO.File]::Delete($pause)
'RESUME_REQUESTED_SERVICE_WILL_VERIFY'
'@)
$FleetInstalledRearmSha256 = Get-FileSha $door
if ($Scene -eq 'changed-door') { [IO.File]::AppendAllText($door,"`n#changed") }
$PS = Join-Path $PSHOME 'powershell.exe'
$ChildEnv = @{ SystemRoot=$env:SystemRoot; PSModulePath=(Join-Path $PSHOME 'Modules'); TEMP=''; TMP='' }
$W1Restore = @{armed=$false;result=$null}; $Done = New-Object 'Collections.Generic.List[string]'
$CarriedTokens = @{}; $calls = New-Object Collections.ArrayList
$Progress = @{}
function Step-Identity {}
function Step-HostHygiene {}
$sweep = (Get-Command Step-SweepCarry).ScriptBlock
function Step-SweepCarry { [void]$calls.Add('sweep'); & $sweep }
$outputStep = (Get-Command Step-Output).ScriptBlock
function Step-Output {
  param([switch]$ForBaselineRefusal)
  $result = & $outputStep @PSBoundParameters
  if ($Done.Contains('output')) { [void]$calls.Add('output') }
  $result
}
function Step-Package { [void]$calls.Add('package') }
function Step-Stage {
  [void]$calls.Add('stage'); $ChildEnv.TEMP=$FixtureRoot
  if ($Scene -eq 'during-stage') { [IO.File]::WriteAllText($connection,'{}') }
}
function Remove-FleetCarry {}
foreach ($name in @('Step-CarryTokens','Step-WindowsPreflightBeforeLinux','Step-ContinueBeforeUninstall','Step-ContinueAfterATimeout',
    'Step-ContinueInsideUninstall','Step-ContinueAfterUninstall','Step-ContinueAfterInstall','Step-UninstallPreflight','Step-Uninstall','Step-Install')) {
  Set-Item "Function:$name" { [void]$calls.Add($MyInvocation.MyCommand.Name); throw 'FIXTURE_REINSTALL_STEP_REACHED' }
}
$main = ($source -split '(?m)^#region main\s*$',2)[1]
try { $null = & ([scriptblock]::Create($main)); throw 'FIXTURE_LAUNCH_CONTINUED' } catch { $reason = $_.Exception.Message }
$log = Join-Path $ResidentRoot 'calls.txt'
$resumeCalls = @(if ([IO.File]::Exists($log)) { [IO.File]::ReadAllLines($log) })
$terminalFile = Join-Path $Out 'terminal.json'
$terminal = if ([IO.File]::Exists($terminalFile)) { Parse-Json ([IO.File]::ReadAllText($terminalFile)) }
[Console]::Out.Write((@{code=$reason; pauseSha=(Get-FileSha $pause); calls=@($calls); resumeCalls=$resumeCalls; terminal=$terminal
  prior=@(foreach ($f in $evidence) { if ([IO.File]::Exists($f)) { [IO.File]::ReadAllText($f) } })} | ConvertTo-Json -Compress -Depth 5))
