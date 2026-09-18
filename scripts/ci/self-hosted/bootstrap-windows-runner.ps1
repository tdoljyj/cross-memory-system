#requires -Version 5.1

param(
    [Parameter(Mandatory = $false)]
    [ValidateSet('home', 'company', 'other')]
    [string]$Site = 'home',

    [Parameter(Mandatory = $false)]
    [string]$RunnerName,

    [Parameter(Mandatory = $false)]
    [string]$RepositoryUrl = 'https://github.com/tdoljyj/cross-memory-system',

    [Parameter(Mandatory = $false)]
    [string]$Root = 'C:\clued-ci',

    [Parameter(Mandatory = $false)]
    [string]$RunnerVersion = '2.337.0',

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$RunnerSha256 = '1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc',

    [switch]$RunAsService,
    [switch]$ReplaceExisting
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $RunnerName) {
    $RunnerName = "clued-ci-$Site-win-01"
}

if ($RunAsService -and -not (Assert-Admin)) {
    throw 'RunAsService requires an elevated PowerShell session. Re-run as Administrator or omit -RunAsService.'
}

Write-Host 'Clued self-hosted runner bootstrap'
Write-Host "Runner: $RunnerName"
Write-Host "Site:   $Site"
Write-Host "Repo:   $RepositoryUrl"

$pythonVersion = (& python --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $pythonVersion -notmatch '^Python 3\.12\.') {
    throw "Python 3.12 must already be installed and on PATH. Found: $pythonVersion"
}
Write-Host "Python capability OK: $pythonVersion"

$assetName = "actions-runner-win-x64-$RunnerVersion.zip"
$downloadUrl = "https://github.com/actions/runner/releases/download/v$RunnerVersion/$assetName"

$downloads = Join-Path $Root 'downloads'
$runnerSuffix = $RunnerName
if ($runnerSuffix.StartsWith('clued-ci-', [System.StringComparison]::OrdinalIgnoreCase)) {
    $runnerSuffix = $runnerSuffix.Substring(9)
}
$runnerDir = Join-Path $Root ("runner-" + $runnerSuffix)
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

if (Test-Path (Join-Path $runnerDir '.runner')) {
    throw "Runner is already configured at $runnerDir. Remove the existing runner configuration explicitly before reusing this directory."
}
New-Item -ItemType Directory -Force -Path $runnerDir | Out-Null

$zip = Join-Path $downloads $assetName
Write-Host "Downloading pinned GitHub Actions runner v$RunnerVersion..."
Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zip

$actualDigest = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedDigest = $RunnerSha256.ToLowerInvariant()
if ($actualDigest -ne $expectedDigest) {
    throw "Runner package digest mismatch. Expected $expectedDigest, got $actualDigest"
}
Write-Host 'Runner package SHA-256 verified.'

Expand-Archive -Path $zip -DestinationPath $runnerDir -Force
$config = Join-Path $runnerDir 'config.cmd'
if (-not (Test-Path $config)) {
    throw "Runner configuration command missing after extraction: $config"
}

$secureToken = Read-Host 'Paste the one-time GitHub runner registration token' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Registration token was empty.'
}

$labels = "clued,pool-general,trust-internal,site-$Site,cap-python312"
$args = @(
    '--unattended',
    '--url', $RepositoryUrl,
    '--token', $token,
    '--name', $RunnerName,
    '--labels', $labels,
    '--work', '_work'
)
if ($ReplaceExisting) {
    $args += '--replace'
}
if ($RunAsService) {
    $args += '--runasservice'
}

Push-Location $runnerDir
try {
    & $config @args
    if ($LASTEXITCODE -ne 0) {
        throw "Runner configuration failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
    $token = $null
    $secureToken = $null
}

if (-not $RunAsService) {
    $launcher = Join-Path $Root ("start-" + $RunnerName + '.cmd')
    @(
        '@echo off',
        "cd /d $runnerDir",
        'if not exist .runner exit /b 0',
        'start "Clued CI Runner" /min run.cmd'
    ) | Set-Content -Path $launcher -Encoding ASCII

    $startup = [Environment]::GetFolderPath('Startup')
    $startupLauncher = Join-Path $startup ("Clued-" + $RunnerName + '.cmd')
    @(
        '@echo off',
        "call $launcher"
    ) | Set-Content -Path $startupLauncher -Encoding ASCII

    & $launcher
    Start-Sleep -Seconds 3

    $listener = Get-Process Runner.Listener -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($runnerDir, [System.StringComparison]::OrdinalIgnoreCase) } |
        Select-Object -First 1

    if (-not $listener) {
        throw 'Runner configured, but Runner.Listener was not detected after startup.'
    }

    Write-Host "Runner listener started: PID $($listener.Id)"
    Write-Host 'Startup launcher installed for the current Windows user.'
}

Write-Host ''
Write-Host 'Bootstrap complete.'
Write-Host "Expected custom labels: $labels"
Write-Host 'The runner remains on GitHub automatic updates after registration.'
Write-Host 'No Python installation or machine-wide registry modification was performed.'
