<#
.SYNOPSIS
  The companion's own GitHub login (Owner decision on M5, 2026-11-08: a classic token with the repo scope; a fine-grained token
  cannot read check runs, GitHub offers it no Checks permission). Run by the Owner himself,
  in his own PowerShell window, NOT elevated. The Agent never runs -Login and never sees the token.

.DESCRIPTION
  The companion used to share the Owner's gh login (a full-scope token in the Windows credential store, also used by the Agent to
  push, open and merge PRs). Replacing that login would break the Agent; so the companion gets a gh configuration of its own:
    %LOCALAPPDATA%\CluedIndependentCI\companion-gh\gh     GH_CONFIG_DIR of the companion (hosts.yml holds its token)
    %LOCALAPPDATA%\CluedIndependentCI\companion-gh\home   HOME of the companion: home\.gitconfig points git's credential helper at that
                                                          gh configuration (build-bundle.ps1 strips every GIT_* variable, not HOME)
  The supervisor (bin\CluedCompanionSupervisor.exe) sets exactly these two variables for the companion and drops GH_TOKEN and every
  other GH_* variable; the companion refuses to start unless both are set, hosts.yml holds a classic token (ghp_...) and
  .gitconfig is exactly the text below (src/companion-session.mjs assertGhIsolation: fail closed).

  Why the token is written into hosts.yml (gh's "insecure storage") and not with `gh auth login`: gh keys its credential-store entries by
  host and account (service "gh:github.com"), not by GH_CONFIG_DIR. The companion's token belongs to the same GitHub account as the
  Owner's, so a second `gh auth login` would touch the Owner's own entry in the shared credential store even with another
  GH_CONFIG_DIR (gh moves the active-account entry when it logs in; with --insecure-storage it still clears that entry first). Writing
  hosts.yml directly keeps the Owner's and the Agent's login exactly as it is. The file is protected instead: the folder is created
  with a protected ACL, SYSTEM, Administrators and the Owner only (the Owner's profile is that already; nothing is inherited from it).
  The Agent runs as the Owner and could read it, exactly as it can use the Owner's own gh login today (resident constraint 4fedfc84);
  what changes is that this token can only touch this repository, with the permissions the Owner chose.

    -Login   reads the token from the clipboard (copy it from the GitHub page first), checks its shape (ghp_ and 36 characters), writes
             hosts.yml and home\.gitconfig, and empties the clipboard. Prints no part of the token.
    -CopyFromOwner  (elevated, with -ProfileDirectory and -AccountSid) takes the github.com classic token of the Owner's existing companion hosts.yml and writes a new
             hosts.yml (-Login's format) into the account's profile at the same relative place, with the same folder ACL as -Login; only when it holds a classic token. The token
             is never printed and never in a variable here. Prints JSON with a status: COMPANION_GH_LOGIN_COPIED, or
             COMPANION_GH_ plus OWNER_TOKEN_MISSING, OWNER_TOKEN_NOT_CLASSIC, OWNER_TOKEN_PATH_IS_A_LINK, OWNER_TOKEN_FILE_HARDLINKED, OWNER_SID_MISMATCH or OWNER_PROFILE_REFUSED (exit 1, nothing copied).
    -Check   read-only: the folder and its ACL, the token's shape (prefix and length only), the .gitconfig text, then with the companion's
             own configuration: gh auth status, the read-only GitHub reads the companion makes, and git ls-remote through the helper;
             finally that the Owner's own gh login still works. Prints exit codes and gh's own masked lines only.

  powershell.exe -NoProfile -File companion-gh-login.ps1 -Login
  powershell.exe -NoProfile -File companion-gh-login.ps1 -Check
#>
[CmdletBinding()]
param([switch]$Login, [switch]$Check, [switch]$CopyFromOwner, [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repo = 'tdoljyj/cross-memory-system',
  [ValidatePattern('^[A-Z]:\\[^"''\r\n;]+\\gh\.exe$')][string]$GhExe = 'C:\Program Files\GitHub CLI\gh.exe',
  # M5-b (ADR 0023): for the companion's own account, elevated (by the Owner): its profile directory and SID (prepare-account prints both).
  [string]$ProfileDirectory, [string]$AccountSid)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$env:PSModulePath = 'C:\Windows\System32\WindowsPowerShell\v1.0\Modules'
$Git = 'C:\Program Files\Git\cmd\git.exe'

# Shared with companion-headless.ps1 (test-companion-headless.ps1 holds the copies identical).
function Get-CompanionGhDirs([string]$profileDir) {
  $base = Join-Path $profileDir 'AppData\Local\CluedIndependentCI\companion-gh'
  [ordered]@{ base = $base; gh = (Join-Path $base 'gh'); home = (Join-Path $base 'home') }
}
# home\.gitconfig, exactly as src/companion-session.mjs companionGitConfig builds it (test-companion-headless.ps1 compares the two).
function Get-CompanionGitConfig([string]$profileDir, [string]$ghExe) {
  $fwd = { param([string]$p) $p.Replace('\', '/') }
  $helper = "!'" + (& $fwd $ghExe) + "' auth git-credential"
  (@('[include]', ("`tpath = " + (& $fwd (Join-Path $profileDir '.gitconfig'))), '[credential]', "`thelper =", ("`thelper = " + $helper),
    '[credential "https://github.com"]', "`thelper =", ("`thelper = " + $helper), '') -join "`n")
}
function Get-CompanionGhSddl([string]$ownerSid) { 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $ownerSid + ')' }
function Write-Utf8([string]$path, [string]$text) {
  $tmp = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
}
# The github.com block of a hosts.yml and its first oauth_token (indented lines belong to the block; another host starts at column 0).
$GithubTokenRx = '(?ms)^github\.com:[ \t]*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+oauth_token:[ \t]*(\S+)[ \t]*\r?$'
function Get-LinkCount([string]$path) {
  if (-not ('CompanionLinkCount' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices;
public static class CompanionLinkCount {
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct Info { public uint Attr; public long C, A, W; public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr h, out Info i);
  public static uint Of(string path) {
    using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
      Info i; if (!GetFileInformationByHandle(fs.SafeFileHandle.DangerousGetHandle(), out i)) throw new IOException("GetFileInformationByHandle");
      return i.Links;
    }
  }
}
'@
  }
  [int][CompanionLinkCount]::Of($path)
}
# 'ok' or a code. The Owner's token store is trusted only when: the profile is C:\Users\<name> (profileRoot, for tests), the process
# user is the Owner (SID), and neither the file nor any folder from it up to the profile is a link / reparse point, and the file has one link.
function Get-OwnerTokenState([string]$ownerProfile, [string]$ownerSid, [string]$profileRoot = 'C:\Users') {
  if ($ownerProfile -cnotmatch ('^' + [regex]::Escape($profileRoot) + '\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z')) { return 'OWNER_PROFILE_REFUSED' }
  if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $ownerSid) { return 'OWNER_SID_MISMATCH' }
  $file = Join-Path (Get-CompanionGhDirs $ownerProfile).gh 'hosts.yml'
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return 'OWNER_TOKEN_MISSING' }
  for ($p = $file; $p -and $p.Length -ge $ownerProfile.Length; $p = Split-Path -Parent $p) {
    if (((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'OWNER_TOKEN_PATH_IS_A_LINK' }
  }
  if ((Get-LinkCount $file) -ne 1) { return 'OWNER_TOKEN_FILE_HARDLINKED' }
  $m = [regex]::Match([IO.File]::ReadAllText($file), $GithubTokenRx)
  if (-not $m.Success) { return 'OWNER_TOKEN_MISSING' }
  if ($m.Groups[1].Value -cnotmatch '^ghp_[A-Za-z0-9]{36}\z') { return 'OWNER_TOKEN_NOT_CLASSIC' }
  'ok'
}
# Owner's github.com classic token -> a NEW hosts.yml in -Login's format (no other host, nothing else). Paths only in, the token stays in here.
function Copy-OwnerToken([string]$ownerProfile, [string]$ownerSid, [string]$targetHosts, [string]$profileRoot = 'C:\Users') {
  $state = Get-OwnerTokenState $ownerProfile $ownerSid $profileRoot
  if ($state -cne 'ok') { return $state }
  $m = [regex]::Match([IO.File]::ReadAllText((Join-Path (Get-CompanionGhDirs $ownerProfile).gh 'hosts.yml')), $GithubTokenRx)
  $tmp = $targetHosts + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($tmp, ("github.com:`n    oauth_token: " + $m.Groups[1].Value + "`n    git_protocol: https`n"), (New-Object Text.UTF8Encoding($false)))
  $m = $null
  if (Test-Path -LiteralPath $targetHosts) { [IO.File]::Replace($tmp, $targetHosts, [NullString]::Value) } else { [IO.File]::Move($tmp, $targetHosts) }
  'copied'
}
# The folder with its own protected ACL, then gh\, home\ and home\.gitconfig (shared by -Login and -CopyFromOwner).
function Initialize-CompanionGhFolder($dirs, [string]$ownerSid, [string]$profileDir, [string]$ghExe) {
  # The folder first, with its own protected ACL (an existing one must be a real folder; its ACL is set again).
  if (Test-Path -LiteralPath $dirs.base) {
    if (((Get-Item -LiteralPath $dirs.base -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'COMPANION_GH_FOLDER_IS_A_LINK' }
    # Only the DACL section: Get-Acl/Set-Acl writes every section, and the audit (SACL) part needs SeSecurityPrivilege, which a
    # non-elevated window does not hold (PrivilegeNotHeldException on the Owner's second run, 2026-11-08).
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetSecurityDescriptorSddlForm((Get-CompanionGhSddl $ownerSid), [Security.AccessControl.AccessControlSections]::Access)
    (Get-Item -LiteralPath $dirs.base -Force).SetAccessControl($sec)
  } else {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $dirs.base))
    $sec = New-Object Security.AccessControl.DirectorySecurity; $sec.SetSecurityDescriptorSddlForm((Get-CompanionGhSddl $ownerSid))
    [void][IO.Directory]::CreateDirectory($dirs.base, $sec)
  }
  foreach ($d in @($dirs.gh, $dirs.home)) { [void][IO.Directory]::CreateDirectory($d) }
  Write-Utf8 (Join-Path $dirs.home '.gitconfig') (Get-CompanionGitConfig $profileDir $ghExe)
}
# One child with the companion's own gh configuration (or the Owner's when $own): exit code and, for gh auth status, gh's own lines
# without the token line (gh masks it anyway).
function Invoke-WithConfig([string]$exe, [string[]]$arguments, $dirs, [bool]$own = $false) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } }) -join ' ')
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
  foreach ($k in @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR')) { $psi.EnvironmentVariables.Remove($k) }
  if (-not $own) { $psi.EnvironmentVariables['GH_CONFIG_DIR'] = $dirs.gh; $psi.EnvironmentVariables['HOME'] = $dirs.home }
  $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'; $psi.EnvironmentVariables['GH_PROMPT_DISABLED'] = '1'; $psi.EnvironmentVariables['GH_NO_UPDATE_NOTIFIER'] = '1'
  $p = [Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync(); $err = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit(60000)) { try { $p.Kill() } catch { }; return [ordered]@{ exit = 'timeout'; lines = @() } }
  $lines = @((($out.Result + "`n" + $err.Result) -split "`r?`n") | Where-Object { $_.Trim() -and $_ -notmatch '(?i)token' -and $_ -notmatch 'github_pat_|gh[opsu]_' } | Select-Object -First 8)
  [ordered]@{ exit = $p.ExitCode; lines = $lines }
}

if (@($Login, $Check, $CopyFromOwner | Where-Object { $_.IsPresent }).Count -ne 1) { throw 'ONE_OF_LOGIN_OR_CHECK_OR_COPYFROMOWNER' }
if ($CopyFromOwner -and -not $AccountSid) { throw 'COPYFROMOWNER_NEEDS_THE_ACCOUNT' }
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevatedNow = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ([bool]$ProfileDirectory -ne [bool]$AccountSid) { throw 'PROFILE_DIRECTORY_AND_ACCOUNT_SID_TOGETHER' }
if ($AccountSid) {
  # M5-b: the folder of another account (the companion's), so elevated; never this account, and the profile directory must be the one
  # Windows has for that SID. The folder's ACL then gives that account (not the Owner) full control.
  if (-not $elevatedNow) { throw 'RUN_ELEVATED_FOR_THE_COMPANION_ACCOUNT' }
  if ($AccountSid -cnotmatch '^S-1-5-21-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}-[0-9]{1,10}\z' -or $AccountSid -ceq $me.User.Value) { throw 'ACCOUNT_SID_REFUSED' }
  $registered = try { [string](Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $AccountSid) -Name 'ProfileImagePath' -ErrorAction Stop).ProfileImagePath } catch { $null }
  if (-not $registered -or -not [string]::Equals([Environment]::ExpandEnvironmentVariables($registered), $ProfileDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw 'PROFILE_DIRECTORY_NOT_THE_ACCOUNTS' }
  $profileDir = $ProfileDirectory
  $ownerSid = $AccountSid
} else {
  if ($elevatedNow) { throw 'RUN_NOT_ELEVATED_IN_YOUR_OWN_WINDOW' }
  $profileDir = [string]$env:USERPROFILE
  $ownerSid = $me.User.Value
}
if ($profileDir -cnotmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?\z') { throw 'PROFILE_DIRECTORY_REFUSED' }
$dirs = Get-CompanionGhDirs $profileDir

if ($CopyFromOwner) {
  if (-not (Test-Path -LiteralPath $GhExe -PathType Leaf)) { throw 'GH_EXE_MISSING' }
  # The Owner is this elevated window's user; the profile is the one Windows registers for that SID (not just $env:USERPROFILE).
  $ownerProfile = try { [string][Environment]::ExpandEnvironmentVariables([string](Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $me.User.Value) -Name 'ProfileImagePath' -ErrorAction Stop).ProfileImagePath) } catch { '' }
  $state = Get-OwnerTokenState $ownerProfile $me.User.Value
  if ($state -ceq 'ok') {
    Initialize-CompanionGhFolder $dirs $ownerSid $profileDir $GhExe
    $state = Copy-OwnerToken $ownerProfile $me.User.Value (Join-Path $dirs.gh 'hosts.yml')
  }
  [ordered]@{ status = $(if ($state -ceq 'copied') { 'COMPANION_GH_LOGIN_COPIED' } else { 'COMPANION_GH_' + $state }); ghConfigDir = $dirs.gh; tokenKind = 'classic' } | ConvertTo-Json
  exit $(if ($state -ceq 'copied') { 0 } else { 1 })
}

if ($Login) {
  if (-not (Test-Path -LiteralPath $GhExe -PathType Leaf)) { throw 'GH_EXE_MISSING' }
  Initialize-CompanionGhFolder $dirs $ownerSid $profileDir $GhExe
  # The token: from the clipboard straight into hosts.yml; never printed, never in a variable longer than these lines, and never passed
  # as an argument to a PowerShell function or cmdlet (review MINOR 13: module logging records those), only to .NET methods.
  $token = ([string](Get-Clipboard -Raw)).Trim()
  if ($token -cnotmatch '^ghp_[A-Za-z0-9]{36}\z') { $token = $null; throw 'CLIPBOARD_IS_NOT_A_CLASSIC_TOKEN' }
  $hostsPath = Join-Path $dirs.gh 'hosts.yml'; $hostsTmp = $hostsPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($hostsTmp, ("github.com:`n    oauth_token: " + $token + "`n    git_protocol: https`n"), (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $hostsPath) { [IO.File]::Replace($hostsTmp, $hostsPath, [NullString]::Value) } else { [IO.File]::Move($hostsTmp, $hostsPath) }
  $length = $token.Length; $token = $null
  # The clipboard, and (review MINOR 5) its history (Win+V) and cloud copy where Windows keeps them.
  try { Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear() } catch { Set-Clipboard -Value ' ' }
  $historyCleared = try { [void][Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType = WindowsRuntime]; [Windows.ApplicationModel.DataTransfer.Clipboard]::ClearHistory() } catch { $false }
  [GC]::Collect()
  [ordered]@{ status = 'COMPANION_GH_LOGIN_STORED'; ghConfigDir = $dirs.gh; home = $dirs.home; tokenKind = 'classic'; tokenLength = $length; clipboardCleared = $true; clipboardHistoryCleared = [bool]$historyCleared
    next = 'powershell.exe -NoProfile -File companion-gh-login.ps1 -Check' } | ConvertTo-Json
  exit 0
}

# -Check: read-only.
$r = [ordered]@{ status = $null; folder = $null; token = $null; gitconfig = $null; ghAuthStatus = $null; reads = [ordered]@{}; gitLsRemote = $null; ownersOwnGhLogin = $null }
$bad = @()
if (-not (Test-Path -LiteralPath $dirs.base -PathType Container)) { $r.folder = 'missing'; $bad += 'folder' }
else {
  $acl = Get-Acl -LiteralPath $dirs.base
  $others = @($acl.Access | Where-Object { @('S-1-5-18', 'S-1-5-32-544', $ownerSid) -cnotcontains $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })
  $link = ((Get-Item -LiteralPath $dirs.base -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  $r.folder = if ($link) { 'link' } elseif (-not $acl.AreAccessRulesProtected -or $others.Count) { 'acl-not-protected' } else { 'ok' }
  if ($r.folder -cne 'ok') { $bad += 'folder' }
}
$hosts = Join-Path $dirs.gh 'hosts.yml'
if (Test-Path -LiteralPath $hosts -PathType Leaf) {
  $m = [regex]::Match([IO.File]::ReadAllText($hosts), '(?m)^\s+oauth_token:\s*(\S+)\s*$')
  $r.token = if (-not $m.Success) { 'none' } elseif ($m.Groups[1].Value -cmatch '^ghp_[A-Za-z0-9]{36}\z') { 'ghp_ (classic, length ' + $m.Groups[1].Value.Length + ')' } else { 'not-classic' }
  $m = $null
  if ($r.token -notlike 'ghp_ *') { $bad += 'token' }
} else { $r.token = 'missing'; $bad += 'token' }
$gc = Join-Path $dirs.home '.gitconfig'
$r.gitconfig = if (-not (Test-Path -LiteralPath $gc -PathType Leaf)) { 'missing' } elseif (([IO.File]::ReadAllText($gc)).Replace("`r`n", "`n") -ceq (Get-CompanionGitConfig $profileDir $GhExe)) { 'ok' } else { 'differs' }
if ($r.gitconfig -cne 'ok') { $bad += 'gitconfig' }
if (-not $bad.Count) {
  $r.ghAuthStatus = Invoke-WithConfig $GhExe @('auth', 'status', '--hostname', 'github.com') $dirs
  # The reads the companion makes (permissions the Owner chose: metadata, contents, pull requests, checks, statuses, actions, issues).
  foreach ($pair in @(@('metadata', "repos/$Repo"), @('pulls', "repos/$Repo/pulls?per_page=1"), @('statuses', "repos/$Repo/commits/main/status"),
      @('checks', "repos/$Repo/commits/main/check-runs?per_page=1"), @('actions', "repos/$Repo/actions/runs?per_page=1"), @('issues', "repos/$Repo/issues?per_page=1"),
      @('rules', "repos/$Repo/rules/branches/main"))) {
    $r.reads[$pair[0]] = (Invoke-WithConfig $GhExe @('api', '--method', 'GET', $pair[1], '--silent') $dirs).exit
  }
  $r.gitLsRemote = (Invoke-WithConfig $Git @('ls-remote', "https://github.com/$Repo", 'HEAD') $dirs).exit
  foreach ($k in @($r.reads.Keys)) { if ($r.reads[$k] -ne 0) { $bad += ('read:' + $k) } }
  if ($r.ghAuthStatus.exit -ne 0) { $bad += 'gh-auth-status' }
  if ($r.gitLsRemote -ne 0) { $bad += 'git-ls-remote' }
}
$own = Invoke-WithConfig $GhExe @('auth', 'status', '--hostname', 'github.com') $dirs $true
$r.ownersOwnGhLogin = [ordered]@{ exit = $own.exit; lines = $own.lines }
if ($own.exit -ne 0) { $bad += 'owners-own-gh-login' }
$r.status = if ($bad.Count) { 'COMPANION_GH_LOGIN_NOT_READY:' + ($bad -join ',') } else { 'COMPANION_GH_LOGIN_READY' }
$r | ConvertTo-Json -Depth 5
exit $(if ($bad.Count) { 1 } else { 0 })
