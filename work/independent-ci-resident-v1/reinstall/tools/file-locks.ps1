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
  if (-not $expected.Contains([uint32]$item.Process.Pid)) { return $false }
  try {
    $actual = [Diagnostics.Process]::GetProcessById([int]$item.Process.Pid)
    return ($actual.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [CluedRehearsalLocks.Query]::Start($item))
  } catch { return $false }
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
$processes = @(Get-CimInstance -ClassName Win32_Process)
$expected = New-Object 'Collections.Generic.HashSet[uint32]'
foreach ($service in @(Get-CimInstance -ClassName Win32_Service | Where-Object { @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader') -ccontains $_.Name })) {
  if ($service.ProcessId) { [void]$expected.Add([uint32]$service.ProcessId) }
}
$taskHost = Join-Path $Root 'bin\CluedCompanionJobHost.exe'
foreach ($process in $processes) {
  if ([string]::Equals([string]$process.ExecutablePath, $taskHost, [StringComparison]::OrdinalIgnoreCase)) { [void]$expected.Add([uint32]$process.ProcessId) }
}
do {
  $changed = $false
  foreach ($process in $processes) {
    if ($expected.Contains([uint32]$process.ParentProcessId) -and $expected.Add([uint32]$process.ProcessId)) { $changed = $true }
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
