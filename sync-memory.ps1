[CmdletBinding()]
param(
    [switch]$Pull,
    [switch]$AlignAndVerify,
    [switch]$Doctor,
    [switch]$Bootstrap,
    [switch]$CommitRepo,
    [ValidateSet("NONE", "IDENTITY", "PREFERENCE", "PROJECT", "HISTORY", "CONSTRAINT", "MULTI")]
    [string]$Access = "MULTI"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($repoRoot -match '[\/]\.(workbuddy|dsh)[\/]') {
    throw "Refusing to operate from a foreign consumer clone."
}

$MemoryDir = Join-Path $env:USERPROFILE "Documents\Codex\memory"
$configFile = Join-Path $repoRoot "sync.config.ps1"
if (Test-Path -LiteralPath $configFile) { . $configFile }
$env:CROSS_MEMORY_LOCAL_DIR = $MemoryDir

$pythonArgs = @((Join-Path $repoRoot "sync-memory.py"))
if ($Doctor) { $pythonArgs += "doctor" }
elseif ($Bootstrap) { $pythonArgs += "bootstrap" }
elseif ($CommitRepo) { $pythonArgs += "commit-repo" }
elseif ($Pull -or $AlignAndVerify) { $pythonArgs += @("align-and-verify", $Access) }
else { $pythonArgs += "push" }

& python @pythonArgs
exit $LASTEXITCODE
