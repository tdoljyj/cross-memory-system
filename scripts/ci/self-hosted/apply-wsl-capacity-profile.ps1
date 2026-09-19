#requires -Version 5.1

param(
    [string]$HostId,
    [string]$Profile,
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.wslconfig'),
    [switch]$RestartWsl
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (($HostId -and $Profile) -or (-not $HostId -and -not $Profile)) {
    throw 'Provide exactly one of -HostId or -Profile.'
}

$manifestPath = Join-Path $PSScriptRoot 'node-profiles.json'
$data = Get-Content $manifestPath -Raw | ConvertFrom-Json

if ($HostId) {
    $hostRecord = @($data.hosts | Where-Object { $_.host_id -eq $HostId })
    if ($hostRecord.Count -ne 1) {
        throw "Unknown or duplicate HostId: $HostId"
    }
    $Profile = $hostRecord[0].capacity_profile
}

$profileProperty = $data.capacity_profiles.PSObject.Properties | Where-Object { $_.Name -eq $Profile }
if (-not $profileProperty) {
    throw "Unknown capacity profile: $Profile"
}
$capacity = $profileProperty.Value

$updates = [ordered]@{
    memory = "$($capacity.wsl_memory_gb)GB"
    processors = [string]$capacity.wsl_processors
    swap = "$($capacity.wsl_swap_gb)GB"
}

$sections = [ordered]@{}
$sections[''] = New-Object System.Collections.Generic.List[string]
$current = ''

if (Test-Path $ConfigPath) {
    foreach ($line in Get-Content $ConfigPath) {
        if ($line -match '^\s*\[([^\]]+)\]\s*$') {
            $current = $Matches[1]
            if (-not $sections.Contains($current)) {
                $sections[$current] = New-Object System.Collections.Generic.List[string]
            }
        } else {
            $sections[$current].Add($line)
        }
    }
}

if (-not $sections.Contains('wsl2')) {
    $sections['wsl2'] = New-Object System.Collections.Generic.List[string]
}

$newBody = New-Object System.Collections.Generic.List[string]
$seen = @{}
foreach ($line in $sections['wsl2']) {
    $replaced = $false
    foreach ($key in $updates.Keys) {
        $escaped = [regex]::Escape($key)
        if ($line -match "^\s*$escaped\s*=") {
            $newBody.Add("$key=$($updates[$key])")
            $seen[$key] = $true
            $replaced = $true
            break
        }
    }
    if (-not $replaced) {
        $newBody.Add($line)
    }
}
foreach ($key in $updates.Keys) {
    if (-not $seen.ContainsKey($key)) {
        $newBody.Add("$key=$($updates[$key])")
    }
}
$sections['wsl2'] = $newBody

$out = New-Object System.Collections.Generic.List[string]
foreach ($section in $sections.Keys) {
    if ($section -ne '') {
        if ($out.Count -gt 0 -and $out[$out.Count - 1] -ne '') {
            $out.Add('')
        }
        $out.Add("[$section]")
    }
    foreach ($line in $sections[$section]) {
        $out.Add($line)
    }
}

if (Test-Path $ConfigPath) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $ConfigPath "$ConfigPath.clued-backup-$stamp" -Force
}
$parent = Split-Path -Parent $ConfigPath
if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}
[IO.File]::WriteAllText($ConfigPath, (($out -join [Environment]::NewLine) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))

Write-Host "Applied capacity profile: $Profile"
Write-Host "WSL memory:     $($updates.memory)"
Write-Host "WSL processors: $($updates.processors)"
Write-Host "WSL swap:       $($updates.swap)"
Write-Host "Config:         $ConfigPath"
Write-Host 'Existing non-capacity WSL settings were preserved.'

if ($RestartWsl) {
    Write-Host 'Restarting all WSL distributions so the new capacity budget takes effect...'
    & wsl.exe --shutdown
    if ($LASTEXITCODE -ne 0) {
        throw "wsl --shutdown failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host 'Run wsl --shutdown later, after all CI jobs on this host are drained, to activate the new limits.'
}
