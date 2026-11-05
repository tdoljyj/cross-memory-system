# Sets up CluedDev-Linux, the WSL distribution used only for local verification
# on Linux (defect 66b7bf56, Owner Decision ecef33d5): Ubuntu 24.04 with the
# Node version the required checks use, Python 3 and Git. It is separate from
# CluedCI-Linux (the self-hosted runners) and CluedResident-Linux (the resident
# CI), so a local run never competes with or touches them.
#
#   pwsh -NoProfile -File scripts/ci/setup-clued-dev-linux.ps1
#
# Needs PowerShell 7.3 or later: Windows PowerShell 5.1 strips quotes from
# arguments to native programs and stops on their stderr output.
#
# Downloads only fixed releases from the official sources: the dated Ubuntu
# WSL root filesystem from cloud-images.ubuntu.com and the Node tarball from
# nodejs.org. Each file must match the SHA-256 pinned below (reviewed with this
# file, so a changed file on the server is refused) and the one the source
# publishes next to it. The pinned values were taken on 2026-11-05 from
# checksum files whose signatures verified (gpg --verify):
#   Ubuntu SHA256SUMS.gpg: "UEC Image Automatic Signing Key <cdimage@ubuntu.com>",
#     D2EB 4462 6FDD C30B 513D 5BB7 1A5D 6C4C 7DB8 7C81
#   Node SHASUMS256.txt.asc: Antoine du Hamel, a Node releaser listed in
#     nodejs/node's README, 5BE8 A3F6 C8A5 C01D 106C 0AD8 20B1 A390 B168 D356
# The root filesystem is pinned to 24.04's first build (20240423, the only one
# the cloud-images WSL channel has; current/ points to it) so every machine
# gets the same packages; nothing is upgraded here. Later 24.04 point releases
# exist only as .wsl images on releases.ubuntu.com, and the runners update
# their packages, so this is not their exact package set.
#
# Runs as the current user (wsl --import needs no elevation). Safe to run
# again: each step checks what is already there, and verified downloads are
# reused.
#Requires -Version 7.3
param(
    [string]$Name = 'CluedDev-Linux',
    # Under the profile, not %LOCALAPPDATA%: a packaged app (such as the one an
    # agent runs in) sees AppData redirected into its package.
    [string]$InstallDir = (Join-Path $env:USERPROFILE 'WSL\CluedDev-Linux'),
    [string]$DownloadDir = (Join-Path $env:USERPROFILE '.cache\clued-dev-linux-download')
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

$UbuntuBase = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/20240423'
$RootfsName = 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
$RootfsSha256 = '8251e27ffff381a4af5f41dcb94d867de3e0d9774a9241908ab34555d99315ea'
# The version clued-required-tests.yml sets up (actions/setup-node).
$NodeVersion = '24.19.0'
$NodeBase = "https://nodejs.org/dist/v$NodeVersion"
$NodeName = "node-v$NodeVersion-linux-x64.tar.xz"
$NodeSha256 = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647'

function Get-Text([string]$Url) {
    for ($attempt = 1; ; $attempt++) {
        try {
            $content = (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 60).Content
            # A checksum file may come as bytes (no text content type); returned
            # as is, PowerShell would unroll the array.
            if ($content -is [byte[]]) { $content = [Text.Encoding]::ASCII.GetString($content) }
            return [string]$content
        }
        catch { if ($attempt -ge 3) { throw }; Start-Sleep -Seconds (5 * $attempt) }
    }
}

# The pinned SHA-256 of $File, after checking that the source still publishes
# the same one ("<hex>  <name>" lines).
function Get-CheckedSha256([string]$SumsUrl, [string]$File, [string]$Pinned) {
    foreach ($line in ((Get-Text $SumsUrl) -split "`n")) {
        $parts = $line.Trim() -split '\s+\*?'
        if ($parts.Count -eq 2 -and $parts[1] -ceq $File -and $parts[0] -cmatch '^[0-9a-f]{64}$') {
            if ($parts[0] -cne $Pinned) { throw "$SumsUrl lists $($parts[0]) for $File, not the pinned $Pinned" }
            return $Pinned
        }
    }
    throw "No published SHA-256 for $File in $SumsUrl"
}

# Downloads $Url to $DownloadDir unless a copy with the expected digest is
# already there; a partial or wrong file is replaced, never used.
function Get-VerifiedFile([string]$Url, [string]$File, [string]$Expected) {
    New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
    $target = Join-Path $DownloadDir $File
    if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Expected) {
        Write-Host "Reusing verified $File"
        return $target
    }
    $partial = "$target.partial"
    for ($attempt = 1; ; $attempt++) {
        try {
            Write-Host "Downloading $Url"
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $partial -TimeoutSec 1800
            break
        } catch {
            Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
            if ($attempt -ge 3) { throw }
            Start-Sleep -Seconds (10 * $attempt)
        }
    }
    $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $Expected) {
        Remove-Item -LiteralPath $partial -Force
        throw "SHA-256 mismatch for ${File}: expected $Expected, got $actual"
    }
    Move-Item -LiteralPath $partial -Destination $target -Force
    return $target
}

function Test-Distribution {
    $names = (& wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    return [bool]($names | Where-Object { $_ -ceq $Name })
}

function Invoke-InDistribution([string]$User, [string[]]$Command) {
    & wsl.exe -d $Name -u $User --exec @Command
    if ($LASTEXITCODE -ne 0) { throw "Command in $Name failed ($LASTEXITCODE): $($Command -join ' ')" }
}

# Whether the distribution must restart for wsl.conf or new tools to apply.
$restart = $false

if (-not (Test-Distribution)) {
    $rootfs = Get-VerifiedFile "$UbuntuBase/$RootfsName" $RootfsName (Get-CheckedSha256 "$UbuntuBase/SHA256SUMS" $RootfsName $RootfsSha256)
    if ((Test-Path -LiteralPath $InstallDir) -and (Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1)) {
        throw "$InstallDir is not empty; remove it or pass -InstallDir"
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Output "Importing $Name into $InstallDir"
    & wsl.exe --import $Name $InstallDir $rootfs --version 2
    if ($LASTEXITCODE -ne 0) { throw "wsl --import failed ($LASTEXITCODE)" }
    $restart = $true
}

# A plain user for the runs; Windows' PATH stays out so only the
# distribution's own node, npm and python are found. Checked every time, so a
# run that stopped half way is completed. /etc/wsl.conf is this distribution's
# own and is written whole: these settings are all it needs.
$wslConf = "[user]`ndefault=dev`n[interop]`nappendWindowsPath=false`n"
& wsl.exe -d $Name -u root --exec id -u dev 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Invoke-InDistribution root @('useradd', '--create-home', '--shell', '/bin/bash', 'dev') }
$current = (& wsl.exe -d $Name -u root --exec cat /etc/wsl.conf 2>$null) -join "`n"
if ("$current`n" -cne $wslConf) {
    Invoke-InDistribution root @('/bin/sh', '-c', "printf '%s' `"`$1`" > /etc/wsl.conf", 'sh', $wslConf)
    $restart = $true
}

$nodeDir = "/opt/node-v$NodeVersion-linux-x64"
& wsl.exe -d $Name -u root --exec test -x "$nodeDir/bin/node"
if ($LASTEXITCODE -ne 0) {
    $tarball = Get-VerifiedFile "$NodeBase/$NodeName" $NodeName (Get-CheckedSha256 "$NodeBase/SHASUMS256.txt" $NodeName $NodeSha256)
    $linuxTarball = (& wsl.exe -d $Name -u root --exec wslpath -a $tarball).Trim()
    Invoke-InDistribution root @('tar', '--no-same-owner', '-xJf', $linuxTarball, '-C', '/opt')
    $restart = $true
}
foreach ($tool in 'node', 'npm', 'npx') {
    Invoke-InDistribution root @('ln', '-sfn', "$nodeDir/bin/$tool", "/usr/local/bin/$tool")
}
# The runners have `python` as Python 3 (/usr/local/bin/python), and some tests start it by that name.
Invoke-InDistribution root @('ln', '-sfn', '/usr/bin/python3', '/usr/local/bin/python')

if ($restart) { & wsl.exe --terminate $Name | Out-Null }
$check = (& wsl.exe -d $Name --exec /bin/bash -lc 'echo "user=$(id -un) node=$(node -v) npm=$(npm -v) python=$(python --version 2>&1) git=$(git --version)"; command -v node python3 python git') -join "`n"
Write-Output $check
if ($check -cnotmatch "user=dev node=v$([regex]::Escape($NodeVersion)) npm=\S+ python=Python 3\.\d+\.\d+ git=git version " -or
    $check -cnotmatch '(?m)^/usr/local/bin/node$' -or $check -cnotmatch '(?m)^/usr/bin/python3$' -or $check -cnotmatch '(?m)^/usr/local/bin/python$' -or
    $check -cnotmatch '(?m)^/usr/bin/git$') {
    throw "$Name is not set up as expected"
}
Write-Output "CLUED_DEV_LINUX_READY $Name"
