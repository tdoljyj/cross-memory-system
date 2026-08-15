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
param([switch]$Pull, [switch]$Doctor)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# Per-machine / per-agent config (gitignored; falls back to this machine's defaults).
$configFile = Join-Path $repoRoot "sync.config.ps1"
$AgentName = "Codex"
$HostName  = $env:COMPUTERNAME
$ProxyUrl  = "http://127.0.0.1:7897"
$MemoryDir = Join-Path $env:USERPROFILE "Documents\Codex\memory"
$GitEmail  = "tdoljyj@users.noreply.github.com"
if (Test-Path -LiteralPath $configFile) { . $configFile }

$identity    = "$AgentName@$HostName"
$memorySrc   = $MemoryDir
$memoryDst   = Join-Path $repoRoot "memory"
$proxy       = $ProxyUrl
$flagFile    = Join-Path $repoRoot ".sync-failed"
$pendingFile = Join-Path $repoRoot ".pending-writeback"

# Fast direct-connectivity probe so a dead github.com connection fails in ~3s instead of ~20s.
function Test-DirectGitHub {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("github.com", 443, $null, $null)
        try {
            if ($async.AsyncWaitHandle.WaitOne(3000, $false)) {
                $client.EndConnect($async)
                return $true
            }
            # Abort the in-flight connect instead of leaving a half-open socket
            # behind (resource is short-lived here, but this keeps it explicit).
            $client.Close()
            return $false
        } finally {
            if ($async -and $async.AsyncWaitHandle) {
                $async.AsyncWaitHandle.Dispose()
            }
        }
    } catch {
        return $false
    } finally {
        try { $client.Dispose() } catch { }
    }
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    # Native git stderr must not throw: PowerShell 5.1 + $ErrorActionPreference='Stop'
    # turns it into a terminating NativeCommandError (redirection cannot stop it).
    # Scope a local Continue and rely on exit codes instead; capture stderr via
    # 2>&1 so real failures keep the git error text for diagnostics.
    $ErrorActionPreference = "Continue"
    # Proxy first: local and reliable on this machine. Fall back to direct only
    # when the failure looks like connectivity (not merge conflicts / non-FF) and
    # direct TCP is reachable (Test-DirectGitHub probes in ~3s instead of ~20s).
    # http.lowSpeed* bounds a stalled HTTP transfer so a half-dead proxy cannot
    # hang the script indefinitely.
    $errText = ""
    $out = @(git -C $repoRoot -c http.proxy=$proxy -c http.sslBackend=openssl -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 @GitArgs 2>&1)
    $errText = @($out | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
    if ($LASTEXITCODE -eq 0) { return }
    if (($errText -match 'Could not connect|unable to access|Failed to connect|Connection (timed out|refused|was reset)|Could not resolve host|OpenSSL SSL_connect') -and (Test-DirectGitHub)) {
        $out = @(git -C $repoRoot -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 @GitArgs 2>&1)
        $errText = @($out | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { $_.ToString() }) -join "`n"
        if ($LASTEXITCODE -eq 0) { return }
    }
    throw "git failed: git $($GitArgs -join ' ')`n$errText"
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
        # 删除工作区中仓库已不存在的 .md（删除传播）
        $repoNames = @(Get-ChildItem -Path (Join-Path $memoryDst "*.md") -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
        Get-ChildItem -Path (Join-Path $memorySrc "*.md") -File -ErrorAction SilentlyContinue | Where-Object { $repoNames -notcontains $_.Name } | Remove-Item -Force -ErrorAction SilentlyContinue
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
    param([string]$Message)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Set-Content -LiteralPath $flagFile -Value @("Failed: $stamp", $Message) -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Test-RepoMemoryDirty {
    $dirty = @(git -C $repoRoot -c core.quotepath=false status --porcelain -- memory 2>$null)
    return ($dirty.Count -gt 0)
}

function Backup-WorkingMemory {
    param([string]$DestDir)
    try {
        if (-not (Test-Path -LiteralPath $memorySrc)) { return }
        New-Item -ItemType Directory -Path $DestDir -Force -ErrorAction Stop | Out-Null
        Copy-Item -Path (Join-Path $memorySrc "*.md") -Destination $DestDir -Force -ErrorAction SilentlyContinue
    } catch { }
}

function Backup-MergeConflict {
    param([string]$DestDir)
    try {
        $conflicted = @(git -C $repoRoot -c core.quotepath=false diff --name-only --diff-filter=U -- memory)
        if ($conflicted.Count -eq 0) { return }
        New-Item -ItemType Directory -Path $DestDir -Force -ErrorAction Stop | Out-Null
        foreach ($f in $conflicted) {
            $rel = $f -replace '^memory[\\/]', ''
            $safe = $rel -replace '[\\/:*?"<>|]', '_'
            foreach ($stage in @('base', 'ours', 'theirs')) {
                $spec = switch ($stage) { 'base' { ':1' } 'ours' { ':2' } 'theirs' { ':3' } }
                $content = @(git -C $repoRoot show "$spec`:$f" 2>$null)
                if ($LASTEXITCODE -eq 0) {
                    Set-Content -LiteralPath (Join-Path $DestDir "$safe.$stage.md") -Value $content -Encoding UTF8 -ErrorAction SilentlyContinue
                }
            }
            $src = Join-Path $repoRoot $f
            if (Test-Path -LiteralPath $src) {
                Copy-Item -LiteralPath $src -Destination (Join-Path $DestDir "$safe.conflict.md") -Force -ErrorAction SilentlyContinue
            }
        }
    } catch { }
}

function Get-RemoteMainHash {
    $out = @(git -C $repoRoot -c http.proxy=$proxy -c http.sslBackend=openssl -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 ls-remote origin main 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $out = @(git -C $repoRoot -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 ls-remote origin main 2>&1)
    }
    $text = ($out | ForEach-Object { $_.ToString() }) -join "`n"
    if ($text -match '(?m)^([0-9a-f]{40})\s+refs/heads/main\s*$') {
        return $Matches[1]
    }
    return $null
}

function Confirm-RemotePushed {
    $localHead = (git -C $repoRoot rev-parse HEAD 2>$null | Out-String).Trim()
    $remoteHash = Get-RemoteMainHash
    if (-not $localHead -or -not $remoteHash) { return $false }
    if ($localHead -eq $remoteHash) { return $true }
    # Remote may have advanced past us (concurrent push). Ensure the remote
    # object is present locally, then treat "our HEAD is an ancestor of remote
    # main" as pushed. This avoids a spurious merge commit from a == comparison.
    git -C $repoRoot -c http.proxy=$proxy -c http.sslBackend=openssl -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 fetch --quiet origin main 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        git -C $repoRoot -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 fetch --quiet origin main 2>$null | Out-Null
    }
    git -C $repoRoot merge-base --is-ancestor $localHead $remoteHash 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# Final safety net: any unhandled terminating error must still leave a failure
# marker and clean up an in-progress merge, instead of dying silently.
trap {
    Set-SyncFailed -Message ("Unhandled error during sync: " + $_.Exception.Message)
    try { git -C $repoRoot merge --abort 2>&1 | Out-Null } catch { }
    Write-Error -ErrorAction Continue ("Unhandled error during sync: " + $_.Exception.Message)
    exit 1
}

$ErrorActionPreference = "Continue"
try {
    git -C $repoRoot config user.name $identity
    if ($LASTEXITCODE -ne 0) { throw "git config user.name failed" }
    git -C $repoRoot config user.email $GitEmail
    if ($LASTEXITCODE -ne 0) { throw "git config user.email failed" }
} catch {
    Write-Warning "git identity could not be set: $($_.Exception.Message)"
    if (-not $Pull -and -not $Doctor) {
        Set-SyncFailed -Message "git identity could not be set: $($_.Exception.Message)"
        Write-Error -ErrorAction Continue "git identity could not be set: $($_.Exception.Message)"
        exit 1
    }
} finally {
    $ErrorActionPreference = "Stop"
}

if ($Doctor) {
    $script:failCount = 0
    function Report($Name, $Pass, $Detail) {
        Write-Output ("[{0}] {1}" -f ($(if ($Pass) { "PASS" } else { "FAIL" }), $Name))
        if ($Detail) { Write-Output ("       {0}" -f $Detail) }
        if (-not $Pass) { $script:failCount++ }
    }

    Write-Output "== cross-memory-system doctor =="
    Write-Output "identity : $identity"
    Write-Output "repo     : $repoRoot"
    Write-Output "memory   : $memorySrc"

    $gitVersion = (& git --version 2>&1 | Out-String).Trim()
    Report "git available" ($LASTEXITCODE -eq 0) $gitVersion

    $gitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
    Write-Output ("git path : " + $(if ($gitPath) { $gitPath } else { "(not found)" }))

    $isPortableGit = ($gitPath -match "PortableGit|\.workbuddy")
    Report "git client safe (not PortableGit)" (-not $isPortableGit) $(if ($isPortableGit) { $gitPath + " -> 有 loose-ref 写入缺陷，请换 Git Bash 自带 git" } else { $gitPath })

    $sslDefault = (git config --show-origin --get http.sslbackend 2>&1 | Out-String).Trim()
    Write-Output ("git http.sslbackend default : " + $(if ($sslDefault) { $sslDefault } else { "(unset)" }))

    $remoteOut = git -C $repoRoot -c http.proxy=$proxy -c http.sslBackend=openssl ls-remote origin main 2>&1
    if ($LASTEXITCODE -ne 0) { $remoteOut = git -C $repoRoot ls-remote origin main 2>&1 }
    $remote = ($remoteOut | Out-String).Trim()
    Report "remote reachable + credential" ($remote -match "[0-9a-f]{40}") $remote
    $remoteHashDoc = if ($remote -match '^([0-9a-f]{40})') { $Matches[1] } else { $null }
    $trackedRef = (git -C $repoRoot rev-parse origin/main 2>&1 | Out-String).Trim()
    Report "tracking ref matches remote" ($remoteHashDoc -and $trackedRef -eq $remoteHashDoc) ("origin/main=" + $trackedRef + " remote=" + $remoteHashDoc)

    $testRef = "refs/remotes/origin/doctor-test"
    $head = (git -C $repoRoot rev-parse HEAD).Trim()
    git -C $repoRoot update-ref $testRef $head 2>&1 | Out-Null
    $readBack = (git -C $repoRoot rev-parse $testRef 2>&1 | Out-String).Trim()
    git -C $repoRoot update-ref -d $testRef 2>&1 | Out-Null
    Report "ref write persists (PortableGit defect)" ($readBack -eq $head) ("read back: " + $readBack)

    $crlf = (git -C $repoRoot config --get core.autocrlf 2>&1 | Out-String).Trim()
    Report "core.autocrlf=false" ($crlf -eq "" -or $crlf -eq "false") ("value: " + $(if ($crlf) { $crlf } else { "(unset)" }))

    $ga = Join-Path $repoRoot ".gitattributes"
    $gaText = if (Test-Path $ga) { Get-Content $ga -Raw } else { "" }
    Report ".gitattributes eol=lf" ($gaText -match "eol=lf")

    $unionDriver = (git -C $repoRoot config --get merge.union.driver 2>&1 | Out-String).Trim()
    Report "merge.union.driver configured" ($unionDriver -match "git merge-file --union") $unionDriver

    $staleMarkers = @('.sync-failed', '.pending-writeback') | ForEach-Object {
        if (Test-Path -LiteralPath (Join-Path $repoRoot $_)) { $_ }
    }
    Report "no stale sync markers" ($staleMarkers.Count -eq 0) ($staleMarkers -join ', ')

    Report "memory dir exists" (Test-Path -LiteralPath $memorySrc)

    if ($script:failCount -eq 0) {
        Write-Output "doctor: ALL PASS"
        exit 0
    } else {
        Write-Output ("doctor: {0} FAILURE(S)" -f $script:failCount)
        exit 1
    }
}

if ($Pull) {
    # Session-start alignment is self-healing in both directions: pull any newer
    # remote memory, write it back to the working directory when possible, and
    # push any local commits left behind by a failed sync.
    if (Test-RepoMemoryDirty) {
        Set-SyncFailed -Message "Repo working tree has uncommitted memory changes; resolve them before running -Pull."
        Write-Error -ErrorAction Continue "Repo working tree has uncommitted memory changes; resolve them before running -Pull."
        exit 1
    }
    if (-not (Test-Path $pendingFile) -and -not (Test-MemoryDirsEqual $memorySrc $memoryDst)) {
        Set-SyncFailed -Message "Working memory directory has local changes not yet synced to the repo; run a normal sync or resolve before -Pull."
        Write-Error -ErrorAction Continue "Working memory directory has local changes not yet synced to the repo; run a normal sync or resolve before -Pull."
        exit 1
    }

    $conflictBackupDir = Join-Path $env:TEMP ("codex-memory-conflict-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        Invoke-Git fetch origin
        $local = git -C $repoRoot rev-parse HEAD
        $remoteHash = Get-RemoteMainHash
        $behind = [int](git -C $repoRoot rev-list --count HEAD..$remoteHash)
        $ahead  = [int](git -C $repoRoot rev-list --count $remoteHash..HEAD)

        $changed = @()
        if ($behind -gt 0) {
            Invoke-Git merge --no-edit FETCH_HEAD
            $changed = @(git -C $repoRoot -c core.quotepath=false diff --name-only "$local..HEAD" -- memory)
            Write-Output "Memory repo updated from remote. Changed memory files:"
            $changed | ForEach-Object { Write-Output $_ }
            $ahead = [int](git -C $repoRoot rev-list --count $remoteHash..HEAD)
            $behind = [int](git -C $repoRoot rev-list --count HEAD..$remoteHash)
        }

        # Reconcile repo -> working memory directory. The preflight above ensures
        # the working copy is not carrying unsynced local edits in the normal case;
        # when a previous write-back is still pending we back up before overwriting.
        if (($changed.Count -gt 0) -or (Test-Path $pendingFile)) {
            if (Test-MemoryDirsEqual $memoryDst $memorySrc) {
                Clear-PendingWriteback
                Write-Output "Working memory directory already matches repo; cleared pending write-back flag."
            } else {
                $backupDir = Join-Path $env:TEMP ("codex-memory-writeback-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
                Backup-WorkingMemory $backupDir
                if (Copy-MemoryToWorkingDir) {
                    Clear-PendingWriteback
                    Write-Output "Pulled changes written back to working memory directory. Previous working copy backed up to $backupDir"
                } else {
                    Set-PendingWriteback $changed
                    Write-Output "WARNING: could not auto-write repo changes to the working memory directory (likely read-only for shell)."
                    Write-Output "         Apply repo memory files to $memorySrc via apply_patch, then re-run -Pull (or delete .pending-writeback) before pushing."
                    Write-Output "         Previous working copy backed up to $backupDir"
                }
            }
        }

        if ($ahead -gt 0) {
            Invoke-Git push origin main
            if (-not (Confirm-RemotePushed)) {
                throw "Push succeeded but remote verification failed (local HEAD is not an ancestor of origin/main) during -Pull."
            }
            Write-Output "Pushed $ahead local commit(s) to GitHub."
        }
        if ($behind -eq 0 -and $ahead -eq 0) {
            Write-Output "Memory repo already up to date."
        }
        Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    } catch {
        Backup-MergeConflict $conflictBackupDir
        Set-SyncFailed $_.Exception.Message
        # Clear any in-progress merge left by a conflicted pull so the next
        # -Pull can retry cleanly instead of failing forever (multi-writer).
        try { git -C $repoRoot merge --abort 2>&1 | Out-Null } catch { }
        Write-Error -ErrorAction Continue ($_.Exception.Message + "`nConflict snapshots (if any): $conflictBackupDir")
        exit 1
    }
    exit 0
}

if (-not (Test-Path $memorySrc)) {
    Set-SyncFailed -Message "Memory directory not found: $memorySrc"
    Write-Error -ErrorAction Continue "Memory directory not found: $memorySrc"
    exit 1
}

if (Test-RepoMemoryDirty) {
    Set-SyncFailed -Message "Repo working tree has uncommitted memory changes; resolve them before syncing."
    Write-Error -ErrorAction Continue "Repo working tree has uncommitted memory changes; resolve them before syncing."
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
        Write-Error -ErrorAction Continue "Pending write-back detected (.pending-writeback): remote changes pulled into the repo have not been written back to $memorySrc. Refusing to push to avoid reverting them. Apply repo memory files to the working directory via apply_patch, then re-run."
        exit 1
    }
}

Copy-Item -Path (Join-Path $memorySrc "*.md") -Destination $memoryDst -Force
# 删除仓库中工作区已删除的 .md（删除传播）
$srcNames = @(Get-ChildItem -Path (Join-Path $memorySrc "*.md") -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
Get-ChildItem -Path (Join-Path $memoryDst "*.md") -File -ErrorAction SilentlyContinue | Where-Object { $srcNames -notcontains $_.Name } | Remove-Item -Force -ErrorAction SilentlyContinue

if (-not (Test-MemoryDirsEqual $memorySrc $memoryDst)) {
    Set-SyncFailed -Message "Copy verification failed: working memory and repo memory differ after copy."
    Write-Error -ErrorAction Continue "Copy verification failed: working memory and repo memory differ after copy."
    exit 1
}

git -C $repoRoot add -A -- memory
if ($LASTEXITCODE -ne 0) { throw "git add -A -- memory failed (staging memory changes)" }
$staged = @(git -C $repoRoot -c core.quotepath=false diff --cached --name-only)
if ($LASTEXITCODE -ne 0) { throw "git diff --cached --name-only failed" }
if (-not $staged) {
    Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    Write-Output "No memory changes; skip commit."
    exit 0
}

$conflictBackupDir = Join-Path $env:TEMP ("codex-memory-conflict-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
try {
    Invoke-Git fetch origin
    $remoteHash = Get-RemoteMainHash
    $behind = [int](git -C $repoRoot rev-list --count HEAD..$remoteHash)
    $changed = (($staged -replace '^memory/','') -join ', ')
    git -C $repoRoot commit -m "memory sync [$identity]: $changed"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed (memory sync commit)" }

    if ($behind -gt 0) {
        Invoke-Git merge --no-edit FETCH_HEAD
    }

    Invoke-Git push origin main
    if (-not (Confirm-RemotePushed)) {
        Invoke-Git fetch origin
        $remoteHash = Get-RemoteMainHash
        $behind = [int](git -C $repoRoot rev-list --count HEAD..$remoteHash)
        if ($behind -gt 0) {
            Invoke-Git merge --no-edit FETCH_HEAD
        }
        Invoke-Git push origin main
        if (-not (Confirm-RemotePushed)) {
            throw "Push succeeded but remote verification failed (local HEAD is not an ancestor of origin/main) after retry."
        }
    }
    Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    Write-Output "Memory synced to GitHub."
} catch {
    Backup-MergeConflict $conflictBackupDir
    Set-SyncFailed $_.Exception.Message
    # Best-effort cleanup; must never prevent the failure flag from being written.
    try { git -C $repoRoot merge --abort 2>&1 | Out-Null } catch { }
    Write-Error -ErrorAction Continue ($_.Exception.Message + "`nConflict snapshots (if any): $conflictBackupDir")
    exit 1
}
