# Codex cross-session memory sync.
# Default (push): copy local memory -> repo, commit if changed, reconcile with remote, push.
# -Pull: session-start alignment (self-healing): pull newer remote memory and
#        push any local commits left behind by a failed sync, then report changes.
# Usage:
#   powershell -ExecutionPolicy Bypass -File sync-memory.ps1
#   powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Pull
[CmdletBinding()]
param([switch]$Pull)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$memorySrc = Join-Path $env:USERPROFILE "Documents\Codex\memory"
$memoryDst = Join-Path $repoRoot "memory"
$proxy = "http://127.0.0.1:7897"
$flagFile = Join-Path $repoRoot ".sync-failed"

# Fast direct-connectivity probe so a dead github.com connection fails in ~3s instead of ~20s.
function Test-DirectGitHub {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("github.com", 443, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(3000, $false)) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    # Native git stderr must not throw: PowerShell 5.1 + $ErrorActionPreference='Stop'
    # turns it into a terminating NativeCommandError (redirection cannot stop it).
    # Scope a local Continue and rely on exit codes instead.
    $ErrorActionPreference = "Continue"
    # Prefer direct; fall back to the local proxy at the actual git-op level.
    # A raw TCP probe is not a reliable reachability check: TCP can succeed
    # while the HTTPS transfer is reset, so retry through the proxy on failure.
    if (Test-DirectGitHub) {
        git -C $repoRoot @GitArgs 2>$null
        if ($LASTEXITCODE -eq 0) { return }
    }
    git -C $repoRoot -c http.proxy=$proxy @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git failed: git $($GitArgs -join ' ')"
    }
}

function Set-SyncFailed {
    Set-Content -LiteralPath $flagFile -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -ErrorAction SilentlyContinue
}

if (-not (git -C $repoRoot config user.name)) { git -C $repoRoot config user.name "tdoljyj" | Out-Null }
if (-not (git -C $repoRoot config user.email)) { git -C $repoRoot config user.email "tdoljyj@users.noreply.github.com" | Out-Null }

if ($Pull) {
    # Session-start alignment is self-healing in both directions: pull any newer
    # remote memory, and push any local commits left behind by a failed sync.
    try {
        Invoke-Git fetch origin
        $local = git -C $repoRoot rev-parse HEAD
        $behind = [int](git -C $repoRoot rev-list --count HEAD..origin/main)
        $ahead  = [int](git -C $repoRoot rev-list --count origin/main..HEAD)

        if ($behind -gt 0) {
            Invoke-Git pull --rebase origin main
            Write-Output "Memory repo updated from remote. Changed memory files:"
            git -C $repoRoot diff --name-only "$local..HEAD" -- memory
            $ahead = [int](git -C $repoRoot rev-list --count origin/main..HEAD)
        }
        if ($ahead -gt 0) {
            Invoke-Git push origin main
            Write-Output "Pushed $ahead local commit(s) to GitHub."
        }
        if ($behind -eq 0 -and $ahead -eq 0) {
            Write-Output "Memory repo already up to date."
        }
        Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    } catch {
        Set-SyncFailed
        Write-Error $_.Exception.Message
        exit 1
    }
    exit 0
}

if (-not (Test-Path $memorySrc)) {
    Set-SyncFailed
    Write-Error "Memory directory not found: $memorySrc"
    exit 1
}

Copy-Item -Path (Join-Path $memorySrc "*.md") -Destination $memoryDst -Force

git -C $repoRoot add -- memory
$staged = git -C $repoRoot diff --cached --name-only
if (-not $staged) {
    Write-Output "No memory changes; skip commit."
    exit 0
}

try {
    Invoke-Git fetch origin
    $behind = [int](git -C $repoRoot rev-list --count HEAD..origin/main)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    git -C $repoRoot commit -m "memory sync: $stamp"

    if ($behind -gt 0) {
        Invoke-Git pull --rebase origin main
    }

    Invoke-Git push origin main
    Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    Write-Output "Memory synced to GitHub."
} catch {
    Set-SyncFailed
    # Best-effort cleanup; must never prevent the failure flag from being written.
    try { git -C $repoRoot rebase --abort 2>&1 | Out-Null } catch { }
    Write-Error $_.Exception.Message
    exit 1
}
