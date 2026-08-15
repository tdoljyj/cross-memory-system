# Codex cross-session memory sync.
# Default (push): copy local memory -> repo, commit if changed, reconcile with remote, push.
# -Pull: session-start alignment (self-healing): pull newer remote memory, write
#        pulled changes back to the working memory directory when possible
#        (otherwise flag .pending-writeback for a manual apply_patch), and push
#        any local commits left behind by a failed sync.
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
$pendingFile = Join-Path $repoRoot ".pending-writeback"

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
    # Proxy first: local and reliable on this machine. Fall back to direct only
    # when the proxy is down; skip the slow direct attempt entirely when direct
    # TCP is also unreachable (Test-DirectGitHub probes in ~3s instead of ~20s).
    git -C $repoRoot -c http.proxy=$proxy @GitArgs 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    if (Test-DirectGitHub) {
        git -C $repoRoot @GitArgs
    }
    if ($LASTEXITCODE -ne 0) {
        throw "git failed: git $($GitArgs -join ' ')"
    }
}

function Get-MemoryFileHashes {
    param([string]$Dir)
    $map = @{}
    Get-ChildItem -Path (Join-Path $Dir "*.md") -File -ErrorAction SilentlyContinue | ForEach-Object {
        $map[$_.Name] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
    return $map
}

function Test-MemoryDirsEqual {
    param([string]$DirA, [string]$DirB)
    $a = Get-MemoryFileHashes $DirA
    $b = Get-MemoryFileHashes $DirB
    if ($a.Count -ne $b.Count) { return $false }
    foreach ($name in $a.Keys) {
        if (-not $b.ContainsKey($name) -or $a[$name] -ne $b[$name]) { return $false }
    }
    return $true
}

function Copy-MemoryToWorkingDir {
    # repo -> working memory directory. Returns $true only when the copy is verified.
    try {
        if (-not (Test-Path -LiteralPath $memorySrc)) {
            New-Item -ItemType Directory -Path $memorySrc -Force -ErrorAction Stop | Out-Null
        }
        Copy-Item -Path (Join-Path $memoryDst "*.md") -Destination $memorySrc -Force -ErrorAction Stop
        return (Test-MemoryDirsEqual $memoryDst $memorySrc)
    } catch {
        return $false
    }
}

function Set-PendingWriteback {
    param([string[]]$ChangedFiles)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Set-Content -LiteralPath $pendingFile -Value (@("Created: $stamp") + $ChangedFiles) -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Clear-PendingWriteback {
    Remove-Item -LiteralPath $pendingFile -Force -ErrorAction SilentlyContinue
}

function Set-SyncFailed {
    Set-Content -LiteralPath $flagFile -Value (Get-Date -Format "yyyy-MM-dd HH:mm:ss") -ErrorAction SilentlyContinue
}

if (-not (git -C $repoRoot config user.name)) { git -C $repoRoot config user.name "tdoljyj" | Out-Null }
if (-not (git -C $repoRoot config user.email)) { git -C $repoRoot config user.email "tdoljyj@users.noreply.github.com" | Out-Null }

if ($Pull) {
    # Session-start alignment is self-healing in both directions: pull any newer
    # remote memory, write it back to the working directory when possible, and
    # push any local commits left behind by a failed sync.
    try {
        Invoke-Git fetch origin
        $local = git -C $repoRoot rev-parse HEAD
        $behind = [int](git -C $repoRoot rev-list --count HEAD..origin/main)
        $ahead  = [int](git -C $repoRoot rev-list --count origin/main..HEAD)

        $changed = @()
        if ($behind -gt 0) {
            Invoke-Git pull --rebase origin main
            $changed = @(git -C $repoRoot diff --name-only "$local..HEAD" -- memory)
            Write-Output "Memory repo updated from remote. Changed memory files:"
            $changed | ForEach-Object { Write-Output $_ }
            $ahead = [int](git -C $repoRoot rev-list --count origin/main..HEAD)
        }

        # Reconcile repo -> working memory directory. Safe to write back only when
        # the repo is the newer side: we just pulled remote commits, or a previous
        # write-back is still pending. Never overwrite newer local edits.
        if (($changed.Count -gt 0) -or (Test-Path $pendingFile)) {
            if (Test-MemoryDirsEqual $memoryDst $memorySrc) {
                Clear-PendingWriteback
                Write-Output "Working memory directory already matches repo; cleared pending write-back flag."
            } elseif (Copy-MemoryToWorkingDir) {
                Clear-PendingWriteback
                Write-Output "Pulled changes written back to working memory directory."
            } else {
                Set-PendingWriteback $changed
                Write-Output "WARNING: could not auto-write repo changes to the working memory directory (likely read-only for shell)."
                Write-Output "         Apply repo memory files to $memorySrc via apply_patch, then re-run -Pull (or delete .pending-writeback) before pushing."
            }
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
        # Clear any in-progress rebase left by a conflicted pull so the next
        # -Pull can retry cleanly instead of failing forever (multi-writer).
        try { git -C $repoRoot rebase --abort 2>&1 | Out-Null } catch { }
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

# Refuse to overwrite pulled-but-not-written-back remote changes with the
# (possibly stale) working copy. If the working copy already matches the repo,
# clear the flag and continue.
if (Test-Path $pendingFile) {
    if (Test-MemoryDirsEqual $memoryDst $memorySrc) {
        Clear-PendingWriteback
        Write-Output "Pending write-back flag cleared: working memory directory now matches repo."
    } else {
        Write-Error "Pending write-back detected (.pending-writeback): remote changes pulled into the repo have not been written back to $memorySrc. Refusing to push to avoid reverting them. Apply repo memory files to the working directory via apply_patch, then re-run."
        exit 1
    }
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
