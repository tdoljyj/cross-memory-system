# Read-only Restart Manager observation of installed public binaries. No shutdown/restart API is imported.
# API contracts: https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
# Directories cannot be registered; this does not prove that a directory has no open handles.
[CmdletBinding()]
param([string]$Root = 'C:\ProgramData\CluedIndependentCI\resident', [switch]$LibraryOnly)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (-not ('CluedRehearsalLocks.Query' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
namespace CluedRehearsalLocks {
  [StructLayout(LayoutKind.Sequential)] public struct Identity { public uint Pid; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct Info {
    public Identity Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Application;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Service;
    public uint Type, Status, Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public static class Query {
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern uint RmStartSession(out uint handle, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern uint RmRegisterResources(uint handle, uint count,
      [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] files, uint apps, Identity[] processes, uint services, string[] names);
    [DllImport("rstrtmgr.dll")] static extern uint RmGetList(uint handle, out uint needed, ref uint count, [In, Out] Info[] list, ref uint reasons);
    [DllImport("rstrtmgr.dll")] static extern uint RmEndSession(uint handle);
    public static long Start(Info value) { return ((long)(uint)value.Process.Started.dwHighDateTime << 32) | (uint)value.Process.Started.dwLowDateTime; }
    public static Info[] Files(string[] files) {
      if (files == null || files.Length > 200000) throw new ArgumentException("RESOURCE_LIST_INVALID");
      if (files.Length == 0) return new Info[0];
      uint handle; uint code = RmStartSession(out handle, 0, new StringBuilder(33));
      if (code != 0) throw new Win32Exception((int)code);
      try {
        for (int offset = 0; offset < files.Length; offset += 512) {
          int length = Math.Min(512, files.Length - offset); string[] batch = new string[length]; Array.Copy(files, offset, batch, 0, length);
          code = RmRegisterResources(handle, (uint)length, batch, 0, null, 0, null);
          if (code != 0) throw new Win32Exception((int)code);
        }
        uint needed = 0, count = 0, reasons = 0;
        code = RmGetList(handle, out needed, ref count, null, ref reasons);
        for (int attempt = 0; code == 234 && attempt < 3; attempt++) {
          if (needed > 10000) throw new InvalidOperationException("LOCKER_LIST_TOO_LARGE");
          Info[] list = new Info[needed]; count = needed;
          code = RmGetList(handle, out needed, ref count, list, ref reasons);
          if (code == 0) { Array.Resize(ref list, checked((int)count)); return list; }
        }
        if (code != 0) throw new Win32Exception((int)code);
        return new Info[0];
      } finally { RmEndSession(handle); }
    }
  }
}
'@
}
function Test-ExpectedLocker($item, $expected) {
  $pidValue = [uint32]$item.Process.Pid
  if (-not $expected.ContainsKey($pidValue) -or $expected[$pidValue] -ne [CluedRehearsalLocks.Query]::Start($item)) { return $false }
  try {
    $actual = [Diagnostics.Process]::GetProcessById([int]$item.Process.Pid)
    return ($actual.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [CluedRehearsalLocks.Query]::Start($item))
  } catch { return $false }
}
function Test-CurrentProcessSnapshot($snapshot) {
  try {
    $actual = [Diagnostics.Process]::GetProcessById([int]$snapshot.pid)
    return ($actual.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $snapshot.startedFileTime)
  } catch { return $false }
}
function Test-ExpectedChildIdentity($parent, $child, $expected) {
  return ($expected.ContainsKey([uint32]$parent.pid) -and $expected[[uint32]$parent.pid] -eq $parent.startedFileTime -and
    $child.parentPid -eq $parent.pid -and $child.startedFileTime -ge $parent.startedFileTime)
}
function New-ProcessSnapshot($process) {
  try {
    $started = [Diagnostics.Process]::GetProcessById([int]$process.ProcessId).StartTime.ToUniversalTime().ToFileTimeUtc()
    # WMI exposes microseconds, while RM/GetProcessById preserve FILETIME's
    # 100 ns ticks. Correlate the WMI row before retaining the full identity.
    if ($process.CreationDate.ToUniversalTime().ToFileTimeUtc() -ne ($started - ($started % 10))) { return $null }
    return [pscustomobject]@{ pid = [uint32]$process.ProcessId; parentPid = [uint32]$process.ParentProcessId
      startedFileTime = $started; executablePath = [string]$process.ExecutablePath }
  } catch { return $null } # Missing creation identity never exempts a locker.
}
if ($LibraryOnly) { return }
if ($Root -cne 'C:\ProgramData\CluedIndependentCI\resident') { throw 'RESIDENT_ROOT_NOT_THE_FIXED_TARGET' }
$ancestors = @('C:\ProgramData', 'C:\ProgramData\CluedIndependentCI', $Root)
foreach ($directory in $ancestors) {
  if (-not [IO.Directory]::Exists($directory) -or (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'RESIDENT_PARENT_NOT_PLAIN' }
}
$files = New-Object 'Collections.Generic.List[string]'
# Never enumerate the protected secrets, trusted, journal, work or archive directories.
foreach ($relative in @('bin', 'runtime', 'broker\bin', 'upgrader\runtime')) {
  $directory = Join-Path $Root $relative
  if (-not [IO.Directory]::Exists($directory)) { continue }
  $ancestor = $Root
  foreach ($part in $relative.Split('\')) {
    $ancestor = Join-Path $ancestor $part
    if (([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PUBLIC_BINARY_DIRECTORY_REPARSE' }
  }
  foreach ($path in [IO.Directory]::GetFiles($directory)) {
    if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PUBLIC_BINARY_REPARSE' }
    if ([IO.Path]::GetExtension($path) -in @('.exe', '.dll')) { $files.Add($path) }
  }
}
if ($files.Count -eq 0) { throw 'INSTALLED_PUBLIC_BINARIES_NOT_FOUND' }
$processes = New-Object 'Collections.Generic.Dictionary[uint32,object]'
foreach ($process in @(Get-CimInstance -ClassName Win32_Process)) {
  $snapshot = New-ProcessSnapshot $process
  if ($null -ne $snapshot) { $processes[$snapshot.pid] = $snapshot }
}
$expected = New-Object 'Collections.Generic.Dictionary[uint32,long]'
foreach ($service in @(Get-CimInstance -ClassName Win32_Service | Where-Object { @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader') -ccontains $_.Name })) {
  $pidValue = [uint32]$service.ProcessId
  if ($processes.ContainsKey($pidValue) -and (Test-CurrentProcessSnapshot $processes[$pidValue])) { $expected[$pidValue] = $processes[$pidValue].startedFileTime }
}
$taskHost = Join-Path $Root 'bin\CluedCompanionJobHost.exe'
foreach ($process in $processes.Values) {
  if ([string]::Equals($process.executablePath, $taskHost, [StringComparison]::OrdinalIgnoreCase) -and (Test-CurrentProcessSnapshot $process)) { $expected[$process.pid] = $process.startedFileTime }
}
do {
  $changed = $false
  foreach ($process in $processes.Values) {
    if ($expected.ContainsKey($process.pid) -or -not $processes.ContainsKey($process.parentPid)) { continue }
    $parent = $processes[$process.parentPid]
    if ((Test-ExpectedChildIdentity $parent $process $expected) -and (Test-CurrentProcessSnapshot $parent) -and (Test-CurrentProcessSnapshot $process)) {
      $expected[$process.pid] = $process.startedFileTime; $changed = $true
    }
  }
} while ($changed)
$observed = @([CluedRehearsalLocks.Query]::Files($files.ToArray()))
$lockers = @(); $external = @()
foreach ($item in $observed) {
  $identity = [ordered]@{ pid = $item.Process.Pid; startedFileTime = [CluedRehearsalLocks.Query]::Start($item); application = $item.Application; service = $item.Service; expected = $false }
  $identity.expected = Test-ExpectedLocker $item $expected
  $lockers += $identity
  if (-not $identity.expected) { $external += $identity }
}
[ordered]@{ contract = 'clued.independent-ci.rehearsal-file-locks/1'; status = 'OBSERVED'; coverage = 'installed-public-binaries-only'
  directoryHandlesCovered = $false; secretsEnumerated = $false; fileCount = $files.Count; lockers = $lockers; external = $external } | ConvertTo-Json -Depth 5 -Compress
