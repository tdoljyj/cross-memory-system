# Offline checks of recover-m5b-archive-reviewed.ps1: never elevated, never reads or writes ProgramData.
# Its pinned Source files are exactly this tree's bytes; it does nothing without a mode; -Run refuses before any read
# unless it is the elevated DESK Owner. One JSON line; exit 0 only when every case passes.
param([string]$Powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
$ErrorActionPreference = 'Stop'; Set-StrictMode -Version 2.0
$script = Join-Path $PSScriptRoot 'recover-m5b-archive-reviewed.ps1'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$cases = 0
function Yes([bool]$v, [string]$what) { if (-not $v) { throw ('RECOVERY_TEST_FAILED:' + $what) }; $script:cases++ }
function Hash([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($s.ComputeHash($b))).Replace('-', '').ToLowerInvariant() } finally { $s.Dispose() } }
$errors = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($script, [ref]$null, [ref]$errors)
Yes ($errors.Count -eq 0) 'parses'
$bytes = [IO.File]::ReadAllBytes($script); Yes (@($bytes | Where-Object { $_ -gt 127 }).Count -eq 0) 'ascii-only'
$text = [Text.Encoding]::ASCII.GetString($bytes)
$pins = [regex]::Matches($text, "'(?<name>[^']+)'\s*=\s*@\('(?<path>[^']+)',\s*'(?<sha>[0-9a-f]{64})'\)")
Yes ($pins.Count -eq 2) 'two-staged-pins'
foreach ($m in $pins) { Yes ((Hash ([IO.File]::ReadAllBytes((Join-Path $repo $m.Groups['path'].Value)))) -ceq $m.Groups['sha'].Value) ('pin-matches-tree:' + $m.Groups['name'].Value) }
# The archive runs only from the admin-only staged copy and the re-arm only from the installed copy; no deletion verb anywhere.
Yes (-not ($text -match '(?i)Remove-Item|::Delete\(|Set-Acl|SetAccessControl|icacls|takeown')) 'no-delete-or-reacl'
Yes ($text.Contains("Invoke-Child 'archive' (Join-Path `$dir 'archive-windows-spool.ps1')") -and $text.Contains("Invoke-Child 'rearm' `$rearm")) 'staged-archiver-installed-rearm'
function Launch([string[]]$a) {
  $cmd = "& ([ScriptBlock]::Create([IO.File]::ReadAllText('" + $script + "'))) " + ($a -join ' ')
  $ErrorActionPreference = 'Continue'   # the child's stderr (a refusal) is data here, not a test error
  $out = & $Powershell -NoProfile -NonInteractive -Command $cmd 2>&1
  [pscustomobject]@{ exit = $LASTEXITCODE; text = (($out | ForEach-Object { [string]$_ }) -join "`n") }
}
$r = Launch @("-SourceRoot 'C:\x'"); Yes ($r.exit -eq 0 -and $r.text.Trim() -ceq '{"status":"DISABLED"}') 'disabled-without-mode'
$r = Launch @("-SourceRoot 'C:\x'", '-Run', '-Preflight'); Yes ($r.exit -ne 0 -and $r.text.Contains('ONE_MODE_ONLY')) 'one-mode-only'
$elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $elevated) {
  $r = Launch @("-SourceRoot 'C:\x'", '-Run')
  $j = $r.text | ConvertFrom-Json
  Yes ($r.exit -eq 1 -and $j.status -ceq 'STOPPED' -and @('ELEVATED_OWNER_TOKEN_REQUIRED', 'EXACT_DESK_OWNER_WINDOWS_POWERSHELL_5_REQUIRED') -ccontains $j.code -and $null -eq $j.stage -and $j.rollback -ceq 'NOTHING_CHANGED') ('run-refused-before-any-read:' + $j.code)
}
[pscustomobject]@{ status = 'RECOVERY_SCRIPT_OFFLINE_PASS'; cases = $cases; hostRead = $false; hostWrite = $false } | ConvertTo-Json -Compress
