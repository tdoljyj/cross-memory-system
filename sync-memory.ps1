# Codex cross-session memory sync.
# ENCODING: keep this file UTF-8 WITH BOM. Windows PowerShell 5.1 parses BOM-less
# UTF-8 as ANSI (GBK on zh-CN), garbling CJK comments and swallowing newlines,
# which breaks the whole script. tests/test_acceptance.py asserts the BOM; do not
# strip it when saving.

# Module role (per 架构基线文档-vNext-1.3.md vNext-1.3): Codex-side AI Adapter Sync Layer.
# Syncs only with the Canonical Memory Store (this git repo); never with other adapters.
# Trigger policy (AGENTS.md v3): pull/push are invoked on demand — pull only when the
# Memory Router (T1-T4) matches, push only when the current turn produced memory writes
# (staged empty check below = Memory Change Detector: NO_CHANGE -> NO_SYNC).
# Default (push): copy local memory -> repo, commit if changed, reconcile with remote, push.
# -Pull: on-demand alignment (self-healing): pull newer remote memory, write
#        pulled changes back to the working memory directory when possible
#        (otherwise flag .pending-writeback for a manual apply_patch), and push
#        any local commits left behind by a failed sync.
# Usage:
#   powershell -ExecutionPolicy Bypass -File sync-memory.ps1
#   powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Pull
#   powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Doctor
#   powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Bootstrap
[CmdletBinding()]
param(
    [switch]$Pull,
    [switch]$Doctor,
    [switch]$Bootstrap,
    [switch]$CommitRepo,
    [ValidateSet("NONE", "IDENTITY", "PREFERENCE", "PROJECT", "HISTORY", "CONSTRAINT", "MULTI")][string]$Access = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# 部署位置护栏：本脚本只应在 Codex 侧克隆（~/.codex/projects/codex-memory-system）运行。
# 仓库是共享的，sync-memory.ps1 也会出现在 WorkBuddy 镜像（~/.workbuddy/codex-memory-system）
# 与 DSH 镜像（~/.dsh/projects/cross-memory-system）里；若在他端镜像内执行，$repoRoot 解析为
# 他端镜像、$MemoryDir 仍指向 Codex 工作区，会把 Codex 工作区内容推入他端镜像并触发删除传播
# （跨端污染 + 身份伪造）。此处硬阻断（P0-3：补 .dsh 单元格，对齐 py 侧 deploy-guard 拒 .codex）。
if ($repoRoot -match '[\\/]\.(workbuddy|dsh)[\\/]') {
    Write-Output "[deploy-guard] refusing to run inside a foreign-end mirror (.workbuddy/.dsh)"
    throw "禁止在非 Codex 端镜像（.workbuddy/.dsh）内运行本脚本（跨端污染风险）：请从 ~/.codex/projects/codex-memory-system 执行。"
}

# Per-machine / per-agent config (gitignored; falls back to this machine's defaults).
$configFile = Join-Path $repoRoot "sync.config.ps1"
$AgentName = "Codex"
$HostName  = $env:COMPUTERNAME
$ProxyUrl  = "http://127.0.0.1:7897"
$MemoryDir = Join-Path $env:USERPROFILE "Documents\Codex\memory"
$GitEmail  = "tdoljyj@users.noreply.github.com"
$ConsumerHookFile = Join-Path $env:USERPROFILE ".codex\AGENTS.md"
if (Test-Path -LiteralPath $configFile) { . $configFile }

$identity    = "$AgentName@$HostName"
$memorySrc   = $MemoryDir
$memoryDst   = Join-Path $repoRoot "memory"
$proxy       = $ProxyUrl
$flagFile    = Join-Path $repoRoot ".sync-failed"
$pendingFile = Join-Path $repoRoot ".pending-writeback"
$lockFile    = Join-Path $repoRoot ".sync.lock"
$needsPushFile = Join-Path $repoRoot ".needs-push"
$script:lockHeld = $false

# P2-4：-Pull -Access NONE 纯短路——必须在任何写副作用之前退出：不写 git 身份配置、
# 不写 .sync-failed、不清理 TEMP 备份、不取锁、不读 git/index、不访问远端
# （对齐 sync-memory.py cmd_pull 的 NONE 纯短路语义；原实现把 NONE 判断放在
# Invoke-PullMode 的五步 preflight 之后，T0 场景仍产生写副作用）。
if ($Pull -and $Access -eq "NONE") {
    Write-Output "Memory Access = NONE; skipping pull (no recall scope)."
    exit 0
}

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
    throw ("git failed: git " + ($GitArgs -join ' ') + "`n" + (Redact-Text $errText))
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

function Test-MemoryRequiredEqual {
    # 只比对 index.json 声明的必需文件。非 index 的 .md 属用户自有：不同步、不删除、
    # 不参与同步判定（防越界提交与静默丢失）。
    param([string]$DirA, [string]$DirB, [string[]]$RequiredFiles)
    if ($null -eq $RequiredFiles -or $RequiredFiles.Count -eq 0) { return $false }
    foreach ($name in $RequiredFiles) {
        $fa = Join-Path $DirA $name
        $fb = Join-Path $DirB $name
        if (-not (Test-Path -LiteralPath $fa -PathType Leaf) -or -not (Test-Path -LiteralPath $fb -PathType Leaf)) { return $false }
        $ha = (Get-FileHash -LiteralPath $fa -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
        $hb = (Get-FileHash -LiteralPath $fb -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
        if (-not $ha -or -not $hb -or $ha -ne $hb) { return $false }
    }
    return $true
}

function Get-MemoryIndex {
    # Single source of truth for the memory file set and L1-L6 recall mapping
    # (memory/index.json). Returns $null when the index is missing or unparsable,
    # which the guard treats as a corrupted canonical store.
    param([string]$MemoryRepoDir)
    $indexPath = Join-Path $MemoryRepoDir "index.json"
    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-MemoryFileList {
    param([string]$MemoryRepoDir)
    $idx = Get-MemoryIndex $MemoryRepoDir
    if ($null -eq $idx -or $null -eq $idx.files) { return $null }
    $list = @($idx.files | ForEach-Object { [string]$_ })
    if ($list.Count -eq 0) { return $null }
    # GAP-3-10：路径净化——files 项必须是 memory 目录内的 .md 基名，
    # 含目录分隔符/相对路径/非 .md 后缀一律按索引非法 fail-closed（防 ../ 逃逸）。
    foreach ($f in $list) {
        if (-not $f.EndsWith('.md') -or $f.Contains('/') -or $f.Contains('\') -or
            [System.IO.Path]::GetFileName($f) -ne $f) {
            return $null
        }
    }
    return $list
}

function Test-MemoryFilesHealthy {
    # Delete-propagation guard, now driven by memory/index.json instead of a
    # hard-coded count of five. Every required file must exist and be non-empty;
    # a missing file is treated as accidental mass deletion and never synced.
    param([string]$Dir, [string[]]$RequiredFiles)
    if ($null -eq $RequiredFiles -or $RequiredFiles.Count -eq 0) { return $false }
    foreach ($name in $RequiredFiles) {
        $f = Join-Path $Dir $name
        if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return $false }
        if ((Get-Item -LiteralPath $f).Length -eq 0) { return $false }
    }
    return $true
}

function Redact-Text {
    # Mask credential-like values before they reach stdout, error text, or
    # .sync-failed markers (baseline 附录 C「日志脱敏」).
    # 覆盖范围须与 guards.json 的 secret_patterns 保持一致（AKIA / 私钥头同样掩码）。
    param([AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $s = $Text
    $s = $s -replace 'ghp_[A-Za-z0-9]+', 'ghp_***'
    $s = $s -replace 'gho_[A-Za-z0-9]+', 'gho_***'
    $s = $s -replace 'github_pat_[A-Za-z0-9_]+', 'github_pat_***'
    $s = $s -replace '(?i)(bearer\s+)[A-Za-z0-9._-]+', '${1}***'
    $s = $s -replace 'AKIA[0-9A-Z]{16}', 'AKIA***'
    # 掩码输出刻意不含「-----BEGIN ... PRIVATE KEY-----」字面（防自命中扫描模式）
    $s = $s -replace '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----', '-----BEGIN PRIVATE KEY HEADER-----'
    return $s
}

function Test-ConsumerConformed {
    # Codex 端消费端 conform 探针（对齐 sync-memory.py 的 consumer_conformed，P1-4 补齐）：
    # 本端消费记忆（~/.codex/AGENTS.md）须声明「版本真值核对/触发式/禁自动化」三要素，
    # 且任一否定词前后窗口内出现三要素即视为语义反转、未 conform。只检本端，不越界互检。
    param([AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    $markers = @('版本真值核对', '触发式', '禁自动化')
    foreach ($m in $markers) {
        if (-not $Text.Contains($m)) { return $false }
    }
    $negations = @('不执行', '不启用', '已废除', '废除', '作废', '取消', '停止', '移除', '不再', '无需')
    foreach ($n in $negations) {
        $start = 0
        while (($idx = $Text.IndexOf($n, $start)) -ge 0) {
            $lo = [Math]::Max(0, $idx - 16)
            $window = $Text.Substring($lo, [Math]::Min($Text.Length - $lo, $n.Length + 32))
            foreach ($m in $markers) {
                if ($window.Contains($m)) { return $false }
            }
            $start = $idx + $n.Length
        }
    }
    return $true
}

function Test-ConsumerConformedFile {
    # fail-closed 版探针（对齐 py consumer_conformed_file）：文件缺失/不可读即 False。
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        return Test-ConsumerConformed (Get-Content -LiteralPath $Path -Raw -Encoding UTF8)
    } catch {
        return $false
    }
}

function Test-AcquireSyncLock {
    # Cross-process advisory lock so concurrent pull/push on the same clone cannot
    # interleave the multi-step copy->commit->fetch->merge->push transaction. Atomic
    # create (FileMode.CreateNew) + PID-liveness stale detection; no held-open handle.
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            $fs = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$PID)
                $fs.Write($bytes, 0, $bytes.Length)
                $fs.Flush()
            } finally {
                $fs.Dispose()
            }
            return $true
        } catch [System.IO.IOException] {
            $holderPid = $null
            try { $holderPid = [int]((Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop).Trim()) } catch { }
            if ($holderPid -gt 0 -and (Get-Process -Id $holderPid -ErrorAction SilentlyContinue)) {
                return $false
            }
            Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
        } catch {
            return $false
        }
    }
    return $false
}

function Release-SyncLock {
    if (-not $script:lockHeld) { return }
    Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
    $script:lockHeld = $false
}

function Get-Guards {
    # Read guards.json (single source of truth for guard params, measure 9).
    # Returns $null on any failure; callers fall back to built-in defaults.
    $p = Join-Path $repoRoot "guards.json"
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try {
        return (Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-SecretPatterns {
    # Secret patterns from guards.json (single source of truth); fall back to
    # built-in defaults only if the contract file is missing or unreadable.
    $g = Get-Guards
    if ($g -and $g.secret_patterns) { return @($g.secret_patterns) }
    return @(
        'gh[op]_[A-Za-z0-9]{20,}',
        'github_pat_[A-Za-z0-9_]{20,}',
        'AKIA[0-9A-Z]{16}',
        '-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
        '(?i)bearer\s+[A-Za-z0-9._-]{20,}'
    )
}

function Find-SecretLeak {
    # Pre-commit secret scan: refuse to sync memory files carrying a credential-like
    # value so a token/private key never enters the git history (baseline 附录 C).
    param([string]$Dir)
    $patterns = Get-SecretPatterns
    foreach ($f in @(Get-ChildItem -Path (Join-Path $Dir "*.md") -File -ErrorAction SilentlyContinue)) {
        $text = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8
        foreach ($p in $patterns) {
            if ($text -match $p) { return $f.Name }
        }
    }
    return $null
}

function Find-SecretLeakStaged {
    # Scan the content of currently staged files by reading the index blob
    # (`git show :<path>`), not the working tree: closes the TOCTOU where a token
    # was staged and then reverted in the working tree before the scan ran
    # (P0-1/P2-1). Covers the -CommitRepo full-repo commit path and the push path,
    # where pre-staged non-memory files would otherwise bypass scanning.
    param([string]$RepoRoot)
    $patterns = Get-SecretPatterns
    $stagedFiles = @(git -C $RepoRoot -c core.quotepath=false diff --cached --name-only 2>$null)
    if ($LASTEXITCODE -ne 0) { return $null }
    foreach ($rel in $stagedFiles) {
        $blobLines = @(git -C $RepoRoot show ":$rel" 2>$null)
        if ($LASTEXITCODE -ne 0) { continue }
        $text = ($blobLines -join "`n")
        foreach ($p in $patterns) {
            if ($text -match $p) { return $rel }
        }
    }
    return $null
}

function Copy-MemoryToWorkingDir {
    # repo -> working memory directory. Returns $true only when the copy is verified.
    try {
        $required = Get-MemoryFileList $memoryDst
        if ($null -eq $required -or -not (Test-MemoryFilesHealthy $memoryDst $required)) { return $false }
        if (-not (Test-Path -LiteralPath $memorySrc)) {
            New-Item -ItemType Directory -Path $memorySrc -Force -ErrorAction Stop | Out-Null
        }
        # 只复制 index.json 声明的必需文件；工作区/仓库中的非 index .md 保留不动。
        foreach ($name in $required) {
            Copy-Item -LiteralPath (Join-Path $memoryDst $name) -Destination (Join-Path $memorySrc $name) -Force -ErrorAction Stop
        }
        return (Test-MemoryRequiredEqual $memoryDst $memorySrc $required)
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
    Set-Content -LiteralPath $flagFile -Value @("Failed: $stamp", (Redact-Text $Message)) -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Test-RepoMemoryDirty {
    $dirty = @(git -C $repoRoot -c core.quotepath=false status --porcelain -- memory 2>$null)
    return ($dirty.Count -gt 0)
}

function Test-GitClientSafe {
    $gitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
    if (-not $gitPath) { return $false }
    return ($gitPath -notmatch "PortableGit|\.workbuddy")
}

function Get-NonMemoryDirtyCount {
    $all = @(git -C $repoRoot -c core.quotepath=false status --porcelain 2>$null)
    $mem = @(git -C $repoRoot -c core.quotepath=false status --porcelain -- memory 2>$null)
    return ($all.Count - $mem.Count)
}

function Clear-StaleTempBackups {
    # codex-memory-backup-* / conflict-* / writeback-* only ever accumulate;
    # drop anything older than the retention window so TEMP does not grow forever.
    param([int]$RetentionDays = 0)
    if ($RetentionDays -le 0) {
        $g = Get-Guards
        # 回落默认与 guards.json 一致（7 天，GAP-2-1 机器口径统一）；
        # guards.json 缺失时不得回落为 2 天旧口径。
        $RetentionDays = if ($g -and $g.backup_retention_days) { [int]$g.backup_retention_days } else { 7 }
    }
    try {
        $cutoff = (Get-Date).AddDays(-$RetentionDays)
        $snapDir = Join-Path $repoRoot ".conflict-snapshots"
        foreach ($base in @($env:TEMP, $snapDir)) {
            if (-not (Test-Path -LiteralPath $base)) { continue }
            Get-ChildItem -Path $base -Directory -Filter "codex-memory-*" -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt $cutoff } |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch { }
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

function Find-SecretLeakUnpushed {
    # Scan files changed in commits not yet on the remote (origin/main..HEAD), reading
    # the HEAD blob of each (git show HEAD:<path>): closes the gap where a token was
    # committed into a non-memory file and a later memory sync push carries it to the
    # remote (P2-2; behavior-aligned with sync-memory.py find_secret_leak_unpushed).
    param([string]$RepoRoot)
    $remoteHash = Get-RemoteMainHash
    if (-not $remoteHash) { return $null }
    # 分词器陷阱：必须用 ${remoteHash} 花括号，否则 "..HEAD" 被拆成独立参数
    $changed = @(git -C $RepoRoot -c core.quotepath=false diff --name-only -z "${remoteHash}..HEAD" 2>$null)
    if ($LASTEXITCODE -ne 0) { return $null }
    $patterns = Get-SecretPatterns
    foreach ($rel in (($changed -join "`0") -split "`0")) {
        if ([string]::IsNullOrEmpty($rel)) { continue }
        $blobLines = @(git -C $RepoRoot show "HEAD:$rel" 2>$null)
        if ($LASTEXITCODE -ne 0) { continue }
        $text = ($blobLines -join "`n")
        foreach ($p in $patterns) {
            if ($text -match $p) { return $rel }
        }
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
    $trapMsg = "Unhandled error during sync: " + $_.Exception.Message
    if ($trapMsg -match "dubious ownership|Permission denied|Access is denied") {
        $trapMsg += "`n提示：疑似在沙盒内运行（沙箱用户 vs 真实用户所有权差异）；请以非沙盒方式执行（批准放行 / 系统 PowerShell）后重试。"
    }
    # GAP-3-8：deploy-guard 拒绝发生在函数定义之前，trap 触发时 Set-SyncFailed /
    # Release-SyncLock 尚未定义——先探测再调用：消除「术语未识别」噪音，且不写
    # .sync-failed（与 protocol-manifest 契约一致：deploy 拒绝不写 marker）。
    if (Get-Command Set-SyncFailed -ErrorAction SilentlyContinue) {
        Set-SyncFailed -Message $trapMsg
    }
    if (Get-Command Release-SyncLock -ErrorAction SilentlyContinue) {
        Release-SyncLock
    }
    try { git -C $repoRoot merge --abort 2>&1 | Out-Null } catch { }
    Write-Error -ErrorAction Continue $trapMsg
    exit 1
}

$ErrorActionPreference = "Continue"
try {
    $idOut1 = git -C $repoRoot config user.name $identity 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("git config user.name failed: " + (($idOut1 | Out-String).Trim())) }
    $idOut2 = git -C $repoRoot config user.email $GitEmail 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("git config user.email failed: " + (($idOut2 | Out-String).Trim())) }
} catch {
    $idErr = $_.Exception.Message
    Write-Warning "git identity could not be set: $idErr"
    if ($idErr -match "dubious ownership|Permission denied|denied|Access is denied") {
        Write-Warning "常见原因：沙盒内 git 无法写仓库配置（沙箱用户 vs 真实用户所有权差异）。请以非沙盒方式运行（批准放行 / 系统 PowerShell）后重试。"
    }
    if (-not $Pull -and -not $Doctor) {
        Set-SyncFailed -Message "git identity could not be set: $idErr"
        Write-Error -ErrorAction Continue "git identity could not be set: $idErr"
        exit 1
    }
} finally {
    $ErrorActionPreference = "Stop"
}

$script:exitCode = 0

function Invoke-DoctorMode {
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
    Clear-StaleTempBackups

    if ($null -eq (Get-Guards)) {
        Write-Output "[WARN] guards.json 缺失或不可解析：护栏契约回落内置默认（密钥模式/保留期 7 天）；请从远端恢复该文件防口径漂移（GAP-3-4）"
    }

    $gitVersion = (& git --version 2>&1 | Out-String).Trim()
    Report "git available" ($LASTEXITCODE -eq 0) $gitVersion

    $gitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
    Write-Output ("git path : " + $(if ($gitPath) { $gitPath } else { "(not found)" }))

    $isPortableGit = ($gitPath -match "PortableGit|\.workbuddy")
    Report "git client safe (path guard)" (-not $isPortableGit) $(if ($isPortableGit) { $gitPath + " -> 非本端标准 git（部署护栏拒绝）；注：ref 写入失效真因为沙盒 overlay，非 PortableGit 缺陷（2026-08-16 实证）" } else { $gitPath })

    $sslDefault = (git config --show-origin --get http.sslbackend 2>&1 | Out-String).Trim()
    Write-Output ("git http.sslbackend default : " + $(if ($sslDefault) { $sslDefault } else { "(unset)" }))

    $remoteOut = git -C $repoRoot -c http.proxy=$proxy -c http.sslBackend=openssl ls-remote origin main 2>&1
    if ($LASTEXITCODE -ne 0) { $remoteOut = git -C $repoRoot ls-remote origin main 2>&1 }
    $remote = ($remoteOut | Out-String).Trim()
    Report "remote reachable + credential" ($remote -match "[0-9a-f]{40}") (Redact-Text $remote)
    $remoteHashDoc = if ($remote -match '^([0-9a-f]{40})') { $Matches[1] } else { $null }
    $trackedRef = (git -C $repoRoot rev-parse origin/main 2>&1 | Out-String).Trim()
    Report "tracking ref matches remote" ($remoteHashDoc -and $trackedRef -eq $remoteHashDoc) ("origin/main=" + $trackedRef + " remote=" + $remoteHashDoc)

    # GAP-2-3（对齐 py doctor）：本地与远端版本对齐阻挡态——线性领先报 AHEAD、
    # 线性落后报 BEHIND、双方各有提交才报 DIVERGED（R3 P0-3 文案修正，2026-08-20）。
    $localHead = (git -C $repoRoot rev-parse HEAD 2>&1 | Out-String).Trim()
    if ($remoteHashDoc -and $localHead) {
        if ($localHead -eq $remoteHashDoc) {
            Report "local == remote" $true "一致（SYNCED）"
        } else {
            git -C $repoRoot -c http.proxy=$proxy -c http.sslBackend=openssl -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 fetch --quiet origin main 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { git -C $repoRoot -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 fetch --quiet origin main 2>&1 | Out-Null }
            git -C $repoRoot merge-base --is-ancestor $localHead $remoteHashDoc 2>$null | Out-Null
            $behind = ($LASTEXITCODE -eq 0)
            git -C $repoRoot merge-base --is-ancestor $remoteHashDoc $localHead 2>$null | Out-Null
            $ahead = ($LASTEXITCODE -eq 0)
            if ($behind -and -not $ahead) {
                $n = (git -C $repoRoot rev-list --count ("{0}..{1}" -f $localHead, $remoteHashDoc) 2>$null | Out-String).Trim()
                Report "local == remote" $false ("本地落后远端（BEHIND {0} 提交，{1}..{2}），读前必须 re-pull，否则结论不可信" -f $n, $localHead.Substring(0, 12), $remoteHashDoc.Substring(0, 12))
            } elseif ($ahead -and -not $behind) {
                $n = (git -C $repoRoot rev-list --count ("{0}..{1}" -f $remoteHashDoc, $localHead) 2>$null | Out-String).Trim()
                Report "local == remote" $false ("本地领先远端（AHEAD {0} 提交，{1}..{2}），未 push（Push 授权单独裁决）" -f $n, $remoteHashDoc.Substring(0, 12), $localHead.Substring(0, 12))
            } else {
                Report "local == remote" $false "本地与远端分叉（DIVERGED，双方各有提交），需手动语义合并"
            }
        }
    } else {
        Report "local == remote" $false "无法判定（本地或远端不可读）"
    }

    $testRef = "refs/remotes/origin/doctor-test"
    $head = (git -C $repoRoot rev-parse HEAD).Trim()
    git -C $repoRoot update-ref $testRef $head 2>&1 | Out-Null
    $readBack = (git -C $repoRoot rev-parse $testRef 2>&1 | Out-String).Trim()
    git -C $repoRoot update-ref -d $testRef 2>&1 | Out-Null
    Report "ref write persists (behavior probe)" ($readBack -eq $head) ("read back: " + $readBack)

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

    if (Test-Path -LiteralPath $needsPushFile) {
        Write-Output "[INFO] .needs-push 存在：本地有未推送的已提交记忆，需显式同步推送（不视为失败）"
    }

    if (Test-Path -LiteralPath $lockFile) {
        Write-Output "[INFO] .sync.lock 存在：持有进程已退出时下次同步自动清理；PID 复用可能楔住时手工删除 .sync.lock 解除（GAP-3-5）"
    }

    # 消费端 conform 触发式禁令探针（P1-4，2026-08-16 补齐）：只检本端 ~/.codex/AGENTS.md
    # （路径可经 sync.config.ps1 的 $ConsumerHookFile 参数化）。FAIL = 阻断态红旗。
    $conformOk = Test-ConsumerConformedFile $consumerHookFile
    if ($conformOk) { $conformDetail = $consumerHookFile }
    elseif (Test-Path -LiteralPath $consumerHookFile -PathType Leaf) {
        $conformDetail = "文件存在但未声明「版本真值核对/触发式/禁自动化」或语义反转，未对齐 vNext-1.3 显式化加固"
    } else { $conformDetail = "文件缺失: $consumerHookFile" }
    Report "consumer hook conform (触发式禁令)" $conformOk $conformDetail

    $credHelper = (git -C $repoRoot config --get-all credential.helper 2>&1 | Out-String).Trim()
    $urlHelper = (git -C $repoRoot config --show-origin --get credential.https://github.com.helper 2>&1 | Out-String).Trim()
    Write-Output ("git credential.helper : " + $(if ($credHelper) { (Redact-Text $credHelper) } else { "(unset)" }))
    if ($urlHelper) { Write-Output ("credential.https://github.com.helper : " + (Redact-Text $urlHelper)) }
    if (-not (($credHelper + $urlHelper) -match "gh")) {
        Write-Output ("[WARN] 未检测到 gh 凭据助手（当前 helper：" + $(if ($credHelper) { (Redact-Text $credHelper) } else { "(unset)" }) + "）；README 建议 gh auth login 生成 git credential helper，避免长期令牌 setx 常驻。")
    }
    $credEnvVars = @('GITHUB_PAT_TOKEN', 'GH_TOKEN') | Where-Object { [Environment]::GetEnvironmentVariable($_) }
    if ($credEnvVars.Count -gt 0) {
        Write-Output ("[WARN] 检测到长期令牌环境变量：{0}。建议改用 gh auth login + git credential helper，避免令牌常驻用户环境变量。" -f ($credEnvVars -join ', '))
    }

    Report "memory dir exists" (Test-Path -LiteralPath $memorySrc)

    # GAP-2-3（对齐 py doctor）：仓库侧 memory 文件集健康（按 index.json files 清单），
    # 缺失/为空即 FAIL——删除传播护栏状态必须在 doctor 可见。
    $reqFiles = Get-MemoryFileList $memoryDst
    Report "memory dir healthy (files per memory/index.json)" (Test-MemoryFilesHealthy $memoryDst $reqFiles)

    # index.json 召回段名有效性：标题改写会静默失效，doctor 做运行时校验（与测试同口径）。
    $idx = Get-MemoryIndex $memoryDst
    if ($null -eq $idx -or $null -eq $idx.recall) {
        Report "index.json recall 段名有效" $false "index.json 缺失或 recall 不可解析"
    } else {
        $badSections = @()
        foreach ($type in @('L1','L2','L3','L4','L5','L6')) {
            foreach ($entry in @($idx.recall.$type)) {
                if ($null -eq $entry) { continue }
                $mf = Join-Path $memoryDst ([string]$entry.file)
                foreach ($sec in @($entry.sections)) {
                    if ($null -eq $sec -or [string]::IsNullOrWhiteSpace([string]$sec)) { continue }
                    $found = (Test-Path -LiteralPath $mf -PathType Leaf) -and
                             (Select-String -LiteralPath $mf -Pattern ("^## " + [regex]::Escape([string]$sec)) -Quiet -ErrorAction SilentlyContinue)
                    if (-not $found) { $badSections += ($type + " " + $entry.file + "「" + $sec + "」") }
                }
            }
        }
        Report "index.json recall 段名有效" ($badSections.Count -eq 0) ($badSections -join ', ')
    }

    $allDirty = @(git -C $repoRoot -c core.quotepath=false status --porcelain 2>$null)
    if ($allDirty.Count -eq 0) {
        Write-Output "[INFO] repo working tree clean (all paths)"
    } else {
        Write-Output ("[WARN] 全仓有 " + $allDirty.Count + " 项未提交变更（含脚本/文档），需自行 commit；memory 同步脚本不会提交这些")
    }

    $archivePath = Join-Path $memoryDst "归档.md"
    if (Test-Path -LiteralPath $archivePath) {
        $archiveSize = (Get-Item -LiteralPath $archivePath).Length
        $archiveLines = @(Get-Content -LiteralPath $archivePath -ErrorAction SilentlyContinue).Count
        if ($archiveSize -gt 120000 -or $archiveLines -gt 1200) {
            Write-Output ("[INFO] 归档.md 已超瘦身阈值（" + $archiveSize + " bytes / " + $archiveLines + " lines），建议压缩为结论 + 唯一事实")
        }
    }

    if ($script:failCount -eq 0) {
        Write-Output "doctor: ALL PASS"
        $script:exitCode = 0
    } else {
        Write-Output ("doctor: {0} FAILURE(S)" -f $script:failCount)
        $script:exitCode = 1
    }
}

function Invoke-BootstrapMode {
    Write-Output "== 一次性接入配置（bootstrap） =="
    $bootstrapSettings = @(
        @("core.autocrlf", "false"),
        @("merge.union.driver", "git merge-file --union %A %O %B"),
        @("maintenance.auto", "false"),
        @("gc.pruneExpire", "2.weeks"),
        @("fetch.autoMaintenance", "false")
    )
    foreach ($s in $bootstrapSettings) {
        git -C $repoRoot config $s[0] $s[1]
        $ok = ($LASTEXITCODE -eq 0)
        Write-Output ("[config] {0}={1} -> {2}" -f $s[0], $s[1], $(if ($ok) { "OK" } else { "FAIL" }))
    }
    Write-Output "bootstrap 完成；再跑 -Doctor 自检"
    $script:exitCode = 0
    return
}

function Invoke-PullMode {
    # Session-start alignment is self-healing in both directions: pull any newer
    # remote memory, write it back to the working directory when possible, and
    # push any local commits left behind by a failed sync.
    if (-not (Test-GitClientSafe)) {
        Set-SyncFailed -Message "Unsafe git client detected (PortableGit / .workbuddy); refusing to sync."
        Write-Error -ErrorAction Continue "Unsafe git client detected (PortableGit / .workbuddy); refusing to sync."
        $script:exitCode = 1; return
    }
    Clear-StaleTempBackups
    $requiredMemoryFiles = Get-MemoryFileList $memoryDst
    if ($null -eq $requiredMemoryFiles) {
        Set-SyncFailed -Message "Refusing to pull: memory/index.json missing or invalid (canonical file set unknown)."
        Write-Error -ErrorAction Continue "Refusing to pull: memory/index.json missing or invalid."
        $script:exitCode = 1; return
    }
    $nonMemoryDirty = Get-NonMemoryDirtyCount
    if ($nonMemoryDirty -gt 0) {
        Write-Warning "$nonMemoryDirty uncommitted non-memory change(s) in repo (scripts/docs) will NOT be committed or pushed by this sync; commit them separately if intended."
    }
    if (Test-RepoMemoryDirty) {
        Set-SyncFailed -Message "Repo working tree has uncommitted memory changes; resolve them before running -Pull."
        Write-Error -ErrorAction Continue "Repo working tree has uncommitted memory changes; resolve them before running -Pull."
        $script:exitCode = 1; return
    }
    if (-not (Test-Path $pendingFile) -and -not (Test-MemoryRequiredEqual $memorySrc $memoryDst $requiredMemoryFiles)) {
        Set-SyncFailed -Message "Working memory directory has local changes not yet synced to the repo; run a normal sync or resolve before -Pull."
        Write-Error -ErrorAction Continue "Working memory directory has local changes not yet synced to the repo; run a normal sync or resolve before -Pull."
        $script:exitCode = 1; return
    }

    if (-not (Test-AcquireSyncLock)) {
        Set-SyncFailed -Message "Another sync is already running (lock held); refusing concurrent -Pull."
        Write-Error -ErrorAction Continue "Another sync is already running (lock held); refusing concurrent -Pull."
        $script:exitCode = 1; return
    }
    $script:lockHeld = $true

    $conflictBackupDir = Join-Path (Join-Path $repoRoot ".conflict-snapshots") ("codex-memory-conflict-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        Invoke-Git fetch origin main
        $local = git -C $repoRoot rev-parse HEAD
        $remoteHash = (git -C $repoRoot rev-parse FETCH_HEAD 2>$null | Out-String).Trim()
        if (-not ($remoteHash -match '^[0-9a-f]{40}$')) {
            Set-SyncFailed -Message "fetch 未返回可用的 main hash（FETCH_HEAD）；拒绝把本地缓存当作已对齐。"
            Write-Error -ErrorAction Continue "远端 hash 不可用，-Pull 以失败退出（fail-closed）。"
            $script:exitCode = 1; return
        }
        # 注意：PowerShell 分词器会把 $remoteHash..HEAD 拆成两个参数（Variable + ..HEAD），
        # 使 rev-list 收到 "..HEAD" 非法参数 → stdout 空 → [int]@() = 0 → 领先检测恒假
        # （措施8 的 .needs-push 路径因此从未生效，2026-08-16 回归测试实锤）。
        # 必须用 ${remoteHash} 花括号把变量与 .. 并为一个参数。
        $behind = [int](git -C $repoRoot rev-list --count "HEAD..${remoteHash}")
        $ahead  = [int](git -C $repoRoot rev-list --count "${remoteHash}..HEAD")

        $changed = @()
        if ($behind -gt 0) {
            Invoke-Git merge --no-edit FETCH_HEAD
            $changed = @(git -C $repoRoot -c core.quotepath=false diff --name-only "$local..HEAD" -- memory)
            Write-Output "Memory repo updated from remote. Changed memory files:"
            $changed | ForEach-Object { Write-Output $_ }
            $ahead = [int](git -C $repoRoot rev-list --count "${remoteHash}..HEAD")
            $behind = [int](git -C $repoRoot rev-list --count "HEAD..${remoteHash}")
        }

        # Reconcile repo -> working memory directory. The preflight above ensures
        # the working copy is not carrying unsynced local edits in the normal case;
        # when a previous write-back is still pending we back up before overwriting.
        if (($changed.Count -gt 0) -or (Test-Path $pendingFile)) {
            if (Test-MemoryRequiredEqual $memoryDst $memorySrc $requiredMemoryFiles) {
                Clear-PendingWriteback
                Write-Output "Working memory directory already matches repo; cleared pending write-back flag."
            } else {
                $backupDir = Join-Path (Join-Path $repoRoot ".conflict-snapshots") ("codex-memory-writeback-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
                Backup-WorkingMemory $backupDir
                if (Copy-MemoryToWorkingDir) {
                    Clear-PendingWriteback
                    Write-Output "Pulled changes written back to working memory directory. Previous working copy backed up to $backupDir（备份保留至保留期清理，供恢复）"
                } else {
                    Set-PendingWriteback $changed
                    Write-Output "WARNING: could not auto-write repo changes to the working memory directory (likely read-only for shell)."
                    Write-Output "         Apply repo memory files to $memorySrc via apply_patch, then re-run -Pull (or delete .pending-writeback) before pushing."
                    Write-Output "         Previous working copy backed up to $backupDir"
                }
            }
        }

        if ($ahead -gt 0) {
            # 措施8：pull=读，不在此 push（读路径不得有写副作用，沙盒内 push 会假成功）。
            # 写 .needs-push 标记，由使用方在非沙盒显式同步推送（对齐 AGENTS:72）。
            $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Set-Content -LiteralPath (Join-Path $repoRoot ".needs-push") -Value @("Pending: $stamp", "本地领先远端，待非沙盒显式 push（sync-memory.ps1 默认模式）") -Encoding UTF8
            Write-Output "本地领先远端 $ahead 提交；pull=读不在此 push，已写 .needs-push 标记，请在非沙盒环境显式同步推送。"
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
        Release-SyncLock
        $script:exitCode = 1; return
    }
    Release-SyncLock
    $script:exitCode = 0; return
}

function Invoke-CommitRepoMode {
    # Commit every tracked change (scripts/docs/tests + memory) in one repo-maintenance
    # commit. This is the code path for persisting script/doc changes, which the normal
    # memory sync intentionally does not commit (it stages only memory/*.md).
    if (-not (Test-GitClientSafe)) {
        Set-SyncFailed -Message "Unsafe git client detected (PortableGit / .workbuddy); refusing to commit repo."
        Write-Error -ErrorAction Continue "Unsafe git client detected (PortableGit / .workbuddy); refusing to commit repo."
        $script:exitCode = 1; return
    }
    Clear-StaleTempBackups
    if (-not (Test-AcquireSyncLock)) {
        Set-SyncFailed -Message "Another sync is already running (lock held); refusing concurrent -CommitRepo."
        Write-Error -ErrorAction Continue "Another sync is already running (lock held); refusing concurrent -CommitRepo."
        $script:exitCode = 1; return
    }
    $script:lockHeld = $true
    git -C $repoRoot add -A
    if ($LASTEXITCODE -ne 0) { throw "git add -A failed (repo maintenance staging)" }
    $staged = @(git -C $repoRoot -c core.quotepath=false diff --cached --name-only)
    if ($LASTEXITCODE -ne 0) { throw "git diff --cached --name-only failed" }
    if (-not $staged) {
        Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
        Write-Output "No repo changes; nothing to commit."
        Release-SyncLock
        $script:exitCode = 0; return
    }
    $secretHit = Find-SecretLeakStaged $repoRoot
    if ($secretHit) {
        Set-SyncFailed -Message "Secret-like value detected in staged file: $secretHit; refusing repo commit."
        Write-Error -ErrorAction Continue "Secret-like value detected in staged file: $secretHit; refusing repo commit."
        git -C $repoRoot reset -q
        Release-SyncLock
        $script:exitCode = 1; return
    }
    $changed = (($staged | ForEach-Object { $_ -replace '^memory/', '' }) -join ', ')
    $conflictBackupDir = Join-Path (Join-Path $repoRoot ".conflict-snapshots") ("codex-memory-conflict-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try {
        Invoke-Git fetch origin
        $remoteHash = Get-RemoteMainHash
        $behind = [int](git -C $repoRoot rev-list --count "HEAD..${remoteHash}")
        git -C $repoRoot commit -m "repo sync [$identity]: $changed"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed (repo maintenance commit)" }
        if ($behind -gt 0) {
            Invoke-Git merge --no-edit FETCH_HEAD
        }
        Invoke-Git push origin main
        if (-not (Confirm-RemotePushed)) {
            Invoke-Git fetch origin
            $remoteHash = Get-RemoteMainHash
            $behind = [int](git -C $repoRoot rev-list --count "HEAD..${remoteHash}")
            if ($behind -gt 0) {
                Invoke-Git merge --no-edit FETCH_HEAD
            }
            Invoke-Git push origin main
            if (-not (Confirm-RemotePushed)) {
                throw "Push succeeded but remote verification failed (local HEAD is not an ancestor of origin/main) after retry."
            }
        }
        Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $needsPushFile -Force -ErrorAction SilentlyContinue
        Write-Output "Repo synced to GitHub."
        Release-SyncLock
        $script:exitCode = 0; return
    } catch {
        Backup-MergeConflict $conflictBackupDir
        Set-SyncFailed $_.Exception.Message
        try { git -C $repoRoot merge --abort 2>&1 | Out-Null } catch { }
        Write-Error -ErrorAction Continue ($_.Exception.Message + "`nConflict snapshots (if any): $conflictBackupDir")
        Release-SyncLock
        $script:exitCode = 1; return
    }
}

function Invoke-PushMode {
if (-not (Test-GitClientSafe)) {
    Set-SyncFailed -Message "Unsafe git client detected (PortableGit / .workbuddy); refusing to sync."
    Write-Error -ErrorAction Continue "Unsafe git client detected (PortableGit / .workbuddy); refusing to sync."
    $script:exitCode = 1; return
}
Clear-StaleTempBackups
$nonMemoryDirty = Get-NonMemoryDirtyCount
if ($nonMemoryDirty -gt 0) {
    Write-Warning "$nonMemoryDirty uncommitted non-memory change(s) in repo (scripts/docs) will NOT be committed or pushed by this sync; commit them separately if intended."
}

if (-not (Test-Path $memorySrc)) {
    Set-SyncFailed -Message "Memory directory not found: $memorySrc"
    Write-Error -ErrorAction Continue "Memory directory not found: $memorySrc"
    $script:exitCode = 1; return
}

$requiredMemoryFiles = Get-MemoryFileList $memoryDst
if ($null -eq $requiredMemoryFiles) {
    Set-SyncFailed -Message "Refusing to sync: memory/index.json missing or invalid (canonical file set unknown)."
    Write-Error -ErrorAction Continue "Refusing to sync: memory/index.json missing or invalid (canonical file set unknown)."
    $script:exitCode = 1; return
}
if (-not (Test-MemoryFilesHealthy $memorySrc $requiredMemoryFiles)) {
    Set-SyncFailed -Message "Refusing to sync: working memory directory is missing required files listed in memory/index.json (delete-propagation guard)."
    Write-Error -ErrorAction Continue "Refusing to sync: working memory directory is missing required files listed in memory/index.json (delete-propagation guard)."
    $script:exitCode = 1; return
}

if (Test-RepoMemoryDirty) {
    Set-SyncFailed -Message "Repo working tree has uncommitted memory changes; resolve them before syncing."
    Write-Error -ErrorAction Continue "Repo working tree has uncommitted memory changes; resolve them before syncing."
    $script:exitCode = 1; return
}

# Refuse to overwrite pulled-but-not-written-back remote changes with the
# (possibly stale) working copy. If the working copy already matches the repo,
# clear the flag and continue.
if (Test-Path $pendingFile) {
    if (Test-MemoryRequiredEqual $memoryDst $memorySrc $requiredMemoryFiles) {
        Clear-PendingWriteback
        Write-Output "Pending write-back flag cleared: working memory directory now matches repo."
    } else {
        Write-Error -ErrorAction Continue "Pending write-back detected (.pending-writeback): remote changes pulled into the repo have not been written back to $memorySrc. Refusing to push to avoid reverting them. Apply repo memory files to the working directory via apply_patch, then re-run."
        $script:exitCode = 1; return
    }
}

$secretLeak = Find-SecretLeak $memorySrc
if ($secretLeak) {
    Set-SyncFailed -Message "Refusing to sync: secret-like value detected in $secretLeak (pre-commit secret scan)."
    Write-Error -ErrorAction Continue "Refusing to sync: secret-like value detected in $secretLeak (pre-commit secret scan)."
    $script:exitCode = 1; return
}
if (-not (Test-AcquireSyncLock)) {
    Set-SyncFailed -Message "Another sync is already running (lock held); refusing concurrent sync."
    Write-Error -ErrorAction Continue "Another sync is already running (lock held); refusing concurrent sync."
    $script:exitCode = 1; return
}
$script:lockHeld = $true

# Sprint 2（对齐 py find_secret_leak_unpushed）：扫本地领先远端的未推送提交
# （origin/main..HEAD 的 HEAD blob）——令牌已 commit 进非 memory 文件时，
# memory sync push 不得把它带上远端（P2-2）。
$secretHit = Find-SecretLeakUnpushed $repoRoot
if ($secretHit) {
    Set-SyncFailed -Message "Secret-like value detected in unpushed commit file: $secretHit; refusing to sync."
    Write-Error -ErrorAction Continue "Secret-like value detected in unpushed commit file: $secretHit; refusing to sync."
    Release-SyncLock
    $script:exitCode = 1; return
}

# 只复制 index.json 声明的必需文件；工作区/仓库中的非 index .md 不复制、不删除、
# 不提交（防越界提交与静默丢失；如仓库存在多余 .md 需人工对齐）。
foreach ($name in $requiredMemoryFiles) {
    Copy-Item -LiteralPath (Join-Path $memorySrc $name) -Destination (Join-Path $memoryDst $name) -Force
}

if (-not (Test-MemoryRequiredEqual $memorySrc $memoryDst $requiredMemoryFiles)) {
    Set-SyncFailed -Message "Copy verification failed: working memory and repo memory differ after copy."
    Write-Error -ErrorAction Continue "Copy verification failed: working memory and repo memory differ after copy."
    Release-SyncLock
    $script:exitCode = 1; return
}

$memoryPaths = @($requiredMemoryFiles | ForEach-Object { "memory/" + $_ })
git -C $repoRoot add -A -- $memoryPaths
if ($LASTEXITCODE -ne 0) { throw "git add -A -- memory (index files) failed (staging memory changes)" }
# P0-1：staged 名单只取 index.json 声明的 memory 文件——预 staged 的非 memory 文件
# （脚本/文档/新文件）既不算「有变化」也不进入 memory sync 提交，恢复
# NO_CHANGE → NO_SYNC 契约并保持用户 index 状态不被触碰。
$staged = @(git -C $repoRoot -c core.quotepath=false diff --cached --name-only | Where-Object { $_ -in $memoryPaths })
if ($LASTEXITCODE -ne 0) { throw "git diff --cached --name-only failed" }
if (-not $staged) {
    Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    Write-Output "No memory changes; skip commit."
    Release-SyncLock
    $script:exitCode = 0; return
}

# P0-1：push 路径补 staged 密钥扫描（读 index blob）。即便上述收窄被未来改动破坏，
# 预 staged 文件携带令牌也会在此被拒绝，令牌不进入提交。
$secretHit = Find-SecretLeakStaged $repoRoot
if ($secretHit) {
    Set-SyncFailed -Message "Secret-like value detected in staged file: $secretHit; refusing to sync."
    Write-Error -ErrorAction Continue "Secret-like value detected in staged file: $secretHit; refusing to sync."
    Release-SyncLock
    $script:exitCode = 1; return
}

$conflictBackupDir = Join-Path (Join-Path $repoRoot ".conflict-snapshots") ("codex-memory-conflict-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
try {
    Invoke-Git fetch origin main
    $remoteHash = (git -C $repoRoot rev-parse FETCH_HEAD 2>$null | Out-String).Trim()
    $behind = [int](git -C $repoRoot rev-list --count "HEAD..${remoteHash}")
    $changed = (($staged -replace '^memory/','') -join ', ')
    # P0-1：commit 限定 index.json 声明的 memory 文件（pathspec 提交），预 staged 的
    # 非 memory 文件不被卷入；其 index 状态原样保留，由 -CommitRepo 或使用方处理。
    git -C $repoRoot commit -m "memory sync [$identity]: $changed" -- $memoryPaths
    if ($LASTEXITCODE -ne 0) { throw "git commit failed (memory sync commit)" }

    if ($behind -gt 0) {
        Invoke-Git merge --no-edit FETCH_HEAD
    }

    Invoke-Git push origin main
    if (-not (Confirm-RemotePushed)) {
        Invoke-Git fetch origin main
        $remoteHash = (git -C $repoRoot rev-parse FETCH_HEAD 2>$null | Out-String).Trim()
        $behind = [int](git -C $repoRoot rev-list --count "HEAD..${remoteHash}")
        if ($behind -gt 0) {
            Invoke-Git merge --no-edit FETCH_HEAD
        }
        Invoke-Git push origin main
        if (-not (Confirm-RemotePushed)) {
            throw "Push succeeded but remote verification failed (local HEAD is not an ancestor of origin/main) after retry."
        }
    }
    Remove-Item -LiteralPath $flagFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $needsPushFile -Force -ErrorAction SilentlyContinue
    Write-Output "Memory synced to GitHub."
} catch {
    Backup-MergeConflict $conflictBackupDir
    Set-SyncFailed $_.Exception.Message
    # Best-effort cleanup; must never prevent the failure flag from being written.
    try { git -C $repoRoot merge --abort 2>&1 | Out-Null } catch { }
    Write-Error -ErrorAction Continue ($_.Exception.Message + "`nConflict snapshots (if any): $conflictBackupDir")
    Release-SyncLock
    $script:exitCode = 1; return
}
Release-SyncLock

}

# ---- mode dispatch (措施10：5 模式函数化) ----
if ($Doctor) { Invoke-DoctorMode; exit $script:exitCode }
if ($Bootstrap) { Invoke-BootstrapMode; exit $script:exitCode }
if ($Pull) { Invoke-PullMode; exit $script:exitCode }
if ($CommitRepo) { Invoke-CommitRepoMode; exit $script:exitCode }
Invoke-PushMode; exit $script:exitCode
