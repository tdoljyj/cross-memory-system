[CmdletBinding()]
param(
    [switch]$Pull,
    [switch]$AlignAndVerify,
    [switch]$Doctor,
    [switch]$Bootstrap,
    [ValidateSet("NONE", "IDENTITY", "PREFERENCE", "PROJECT", "HISTORY", "CONSTRAINT", "MULTI")]
    [string]$Access = "MULTI"
)

$ErrorActionPreference = "Stop"
& (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "scripts/sync-memory.ps1") @PSBoundParameters
exit $LASTEXITCODE
