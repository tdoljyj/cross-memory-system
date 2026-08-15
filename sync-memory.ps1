# Codex cross-session memory sync script.
# Usage: powershell -ExecutionPolicy Bypass -File sync-memory.ps1
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$memorySrc = Join-Path $env:USERPROFILE "Documents\Codex\memory"
$memoryDst = Join-Path $repoRoot "memory"
$proxy = "http://127.0.0.1:7897"   # Local proxy fallback used only when direct github.com connection fails.

if (-not (Test-Path $memorySrc)) {
    Write-Error "Memory directory not found: $memorySrc"
}

# Direct first; retry once via local proxy on failure.
function Invoke-GitWithFallback {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    git -C $repoRoot @GitArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Output "Direct git failed; retrying via local proxy ($proxy)..."
        git -C $repoRoot -c http.proxy=$proxy @GitArgs
    }
}

# Set local git identity only if missing.
if (-not (git -C $repoRoot config user.name)) {
    git -C $repoRoot config user.name "tdoljyj"
}
if (-not (git -C $repoRoot config user.email)) {
    git -C $repoRoot config user.email "tdoljyj@users.noreply.github.com"
}

# Copy the four memory files.
Copy-Item -LiteralPath `
    (Join-Path $memorySrc "画像.md"), `
    (Join-Path $memorySrc "状态.md"), `
    (Join-Path $memorySrc "决策.md"), `
    (Join-Path $memorySrc "待办.md") `
    -Destination $memoryDst -Force

# Commit only when something changed.
git -C $repoRoot add -A
$changed = git -C $repoRoot status --porcelain
if (-not $changed) {
    Write-Output "No memory changes; skip commit."
    exit 0
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
git -C $repoRoot commit -m "memory sync: $stamp"

# Push; pull --rebase first if remote has new commits.
Invoke-GitWithFallback push origin main
if ($LASTEXITCODE -ne 0) {
    Invoke-GitWithFallback pull --rebase origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Sync failed: pull from origin failed."
        exit 1
    }
    Invoke-GitWithFallback push origin main
}
if ($LASTEXITCODE -ne 0) {
    Write-Error "Sync failed: push to origin failed."
    exit 1
}

Write-Output "Memory synced to GitHub."
