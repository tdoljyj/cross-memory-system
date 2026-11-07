<#
.SYNOPSIS
  Read-only probe of the M5 prerequisites (DESIGN.md section 65.6, Q1-Q4): for the Owner, whenever he wants it. It writes nothing,
  registers nothing, stores no credential and changes no setting. The Agent does not run it on the Owner's behalf.

.DESCRIPTION
  What has to hold for the companion to run under the password logon (session 0, no desktop):
    Q1  WSL works in that session: wsl --distribution <D> --user root --exec /bin/true; /mnt/c reads resident\bundles; the distribution's
        own docker.service (DESIGN section 9, not Docker Desktop) is active.
    Q2  the background session and the Owner's console reach the SAME instance of the distribution: the same boot_id, and the Owner's
        own `wsl -d <D> -u root` still works while the companion holds it (no "vhdx in use").
    Q3  the companion's gh login works (since the Owner decision: its own fine-grained token, companion-gh-login.ps1), and git fetches
        through it.
    Q4  the companion's token is not elevated.

  A read-only script cannot open a password-logon session itself (that needs the password). So the probe reads both sides:
    - this session (the Owner's console): Q1, Q2's boot_id, Q3 with the companion's own gh configuration;
    - the background session, as the companion recorded it there: %LOCALAPPDATA%\CluedIndependentCI\companion-session.json (written at
      every companion start: its boot_id, wsl's exit code, docker.service; src/companion-session.mjs) and supervisor.json (the
      supervisor's session id), plus the live processes (session id from Win32_Process; the real token only when this probe runs
      elevated, through bin\CluedCompanionTaskRegistrar.exe token-facts).
  Before the switch, the background half reads "not-yet" (the companion runs in the Owner's session); during and after
  rearm-resident.ps1 -CompanionHeadless it is filled in. That switch itself checks Q1/Q4 from the elevated side and falls back to the
  interactive token within 8 minutes when they do not hold, so running the switch is the field check; this probe shows the details.
  Q5 (log-off) and Q6 (fast startup) are the runbook's T2 and T7.

  powershell.exe -NoProfile -File probe-companion-headless.ps1 [-Distribution <name>]
#>
[CmdletBinding()]
param([ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$Distribution, [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repo = 'tdoljyj/cross-memory-system')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$Root = 'C:\ProgramData\CluedIndependentCI\resident'
$Wsl = 'C:\Windows\System32\wsl.exe'
$GhExe = 'C:\Program Files\GitHub CLI\gh.exe'
$Git = 'C:\Program Files\Git\cmd\git.exe'

function Read-JsonOrNull([string]$p) { try { if (Test-Path -LiteralPath $p -PathType Leaf) { Get-Content -LiteralPath $p -Raw | ConvertFrom-Json } else { $null } } catch { $null } }
# One child, its exit code and its first line (bounded); the environment overrides apply to the child only.
function Invoke-Read([string]$exe, [string[]]$arguments, [hashtable]$env = @{}, [int]$seconds = 120) {
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return [ordered]@{ exit = 'missing'; first = $null } }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  foreach ($k in @('GH_TOKEN', 'GITHUB_TOKEN')) { $psi.EnvironmentVariables.Remove($k) }
  foreach ($k in $env.Keys) { $psi.EnvironmentVariables[$k] = $env[$k] }
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $null = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($seconds * 1000)) { try { $p.Kill() } catch { }; return [ordered]@{ exit = 'timeout'; first = $null } }
  $first = @(($out.Result -replace "`0", '') -split "`r?`n" | Where-Object { $_.Trim() }) | Select-Object -First 1
  [ordered]@{ exit = $p.ExitCode; first = $(if ($first -and $first -notmatch 'github_pat_|gh[opsu]_') { ([string]$first).Trim().Substring(0, [Math]::Min(120, ([string]$first).Trim().Length)) } else { $null }) }
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$node = $null
$accepted = Read-JsonOrNull (Join-Path $Root 'record\acceptance.json')
if ($accepted -and ($accepted.PSObject.Properties.Name -ccontains 'node')) { $node = $accepted.node }
if (-not $Distribution) { $Distribution = if ($node) { [string]$node.wslDistribution } else { throw 'DISTRIBUTION_REQUIRED' } }
$profileDir = if ($node) { [string]$node.ownerProfileDirectory } else { [string]$env:USERPROFILE }
$local = Join-Path $profileDir 'AppData\Local\CluedIndependentCI'
$gh = [ordered]@{ gh = (Join-Path $local 'companion-gh\gh'); home = (Join-Path $local 'companion-gh\home') }
$here = [ordered]@{ user = $me.User.Value; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId; elevated = $elevated }
$rootCmd = { param([string[]]$linux) @('--distribution', $Distribution, '--user', 'root', '--exec') + $linux }

# Q1 (this session)
$q1 = [ordered]@{ wslTrue = (Invoke-Read $Wsl (& $rootCmd @('/bin/true'))).exit
  bundlesReadable = (Invoke-Read $Wsl (& $rootCmd @('/usr/bin/test', '-r', '/mnt/c/ProgramData/CluedIndependentCI/resident/bundles'))).exit
  docker = (Invoke-Read $Wsl (& $rootCmd @('/usr/bin/systemctl', 'is-active', 'docker.service'))).first }
# Q2: the boot_id here, and the background session's as the companion recorded it
$bootHere = (Invoke-Read $Wsl (& $rootCmd @('/usr/bin/cat', '/proc/sys/kernel/random/boot_id'))).first
$session = Read-JsonOrNull (Join-Path $local 'companion-session.json')
$supervisor = Read-JsonOrNull (Join-Path $local 'supervisor.json')
Import-Module 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules\CimCmdlets\CimCmdlets.psd1'
$sup = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='CluedCompanionSupervisor.exe'" | Where-Object { [string]::Equals([string]$_.ExecutablePath, (Join-Path $Root 'bin\CluedCompanionSupervisor.exe'), [StringComparison]::OrdinalIgnoreCase) })
$kids = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'" | Where-Object { ([string]$_.CommandLine).Contains('companion-main.mjs') -and [string]::Equals([string]$_.ExecutablePath, (Join-Path $Root 'runtime\node.exe'), [StringComparison]::OrdinalIgnoreCase) })
$background = [ordered]@{
  supervisorProcesses = @($sup | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; sessionId = [int]$_.SessionId } })
  companionProcesses = @($kids | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; sessionId = [int]$_.SessionId; parent = [int]$_.ParentProcessId } })
  supervisorRecord = $(if ($supervisor) { [ordered]@{ sessionId = $supervisor.sessionId; at = $supervisor.at; lastRefusal = $supervisor.lastRefusal; exits = @($supervisor.exits).Count } } else { $null })
  sessionRecord = $(if ($session) { [ordered]@{ at = $session.at; bootId = $session.bootId; wslExitCode = $session.wslExitCode; docker = $session.docker } } else { $null }) }
$inSession0 = @($kids | Where-Object { [int]$_.SessionId -eq 0 }).Count -gt 0
$q2 = [ordered]@{ bootIdHere = $bootHere; bootIdBackground = $(if ($session) { $session.bootId } else { $null })
  sameInstance = $(if (-not $inSession0) { 'not-yet' } elseif ($session -and $bootHere -and $session.bootId -ceq $bootHere) { $true } else { $false })
  ownersRootShellWorks = ($q1.wslTrue -eq 0) }
# Q3: the companion's own gh login, from this session (the companion itself refuses to start without it)
$ghEnv = @{ GH_CONFIG_DIR = $gh.gh; HOME = $gh.home; GIT_TERMINAL_PROMPT = '0'; GH_PROMPT_DISABLED = '1' }
$q3 = [ordered]@{ ghAuthStatus = (Invoke-Read $GhExe @('auth', 'status', '--hostname', 'github.com') $ghEnv 60).exit
  gitLsRemote = (Invoke-Read $Git @('ls-remote', "https://github.com/$Repo", 'HEAD') $ghEnv 120).exit
  backgroundStarted = ($inSession0 -and $null -eq $(if ($supervisor) { $supervisor.lastRefusal } else { $null })) }
# Q4: session 0 for both; the real tokens only when elevated (through the registrar's read-only token-facts)
$q4 = [ordered]@{ supervisorSession0 = (@($sup | Where-Object { [int]$_.SessionId -eq 0 }).Count -eq @($sup).Count -and @($sup).Count -gt 0); companionSession0 = $inSession0; tokens = 'run-elevated-to-read' }
$registrar = Join-Path $Root 'bin\CluedCompanionTaskRegistrar.exe'
if ($elevated -and (Test-Path -LiteralPath $registrar -PathType Leaf)) {
  $q4.tokens = @(foreach ($p in @($sup) + @($kids)) { try { (& $registrar token-facts ([int]$p.ProcessId) | Out-String) | ConvertFrom-Json } catch { $null } })
}
# The task as it is (read-only; the Owner may read it)
$task = Get-ScheduledTask -TaskPath '\Clued\' -TaskName 'CluedCIResidentCompanion' -ErrorAction SilentlyContinue
$taskView = if ($task) { [ordered]@{ logonType = [string]$task.Principal.LogonType; runLevel = [string]$task.Principal.RunLevel; action = [string]@($task.Actions)[0].Execute
    lastTaskResult = $(try { '0x' + ('{0:X8}' -f ([int64](Get-ScheduledTaskInfo -InputObject $task).LastTaskResult -band 0xFFFFFFFFL)) } catch { $null }) } } else { $null }
[ordered]@{ contract = 'clued.independent-ci.companion-headless-probe/1'; at = [DateTimeOffset]::UtcNow.ToString('o'); distribution = $Distribution; here = $here; task = $taskView
  q1 = $q1; q2 = $q2; q3 = $q3; q4 = $q4; background = $background; writesAnything = $false } | ConvertTo-Json -Depth 6
