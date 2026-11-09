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
    // Query-only handles work for standard-user observations of service processes;
    // System.Diagnostics.Process on .NET Framework can ask for broader rights.
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle,
      out System.Runtime.InteropServices.ComTypes.FILETIME created, out System.Runtime.InteropServices.ComTypes.FILETIME exited,
      out System.Runtime.InteropServices.ComTypes.FILETIME kernel, out System.Runtime.InteropServices.ComTypes.FILETIME user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static long LiveStarted(uint pid) {
      IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION only
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        System.Runtime.InteropServices.ComTypes.FILETIME created, exited, kernel, user;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return ((long)(uint)created.dwHighDateTime << 32) | (uint)created.dwLowDateTime;
      } finally { CloseHandle(handle); }
    }
    public static string LiveImage(uint pid) {
      IntPtr handle = OpenProcess(0x1000, false, pid);
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        StringBuilder path = new StringBuilder(32768); uint size = 32768;
        if (!QueryFullProcessImageName(handle, 0, path, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return path.ToString();
      } finally { CloseHandle(handle); }
    }
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
function Get-LiveProcessStarted([uint32]$pidValue) { return [CluedRehearsalLocks.Query]::LiveStarted($pidValue) }
function Get-LiveProcessImage([uint32]$pidValue) { return [CluedRehearsalLocks.Query]::LiveImage($pidValue) }
function Test-CurrentProcessIdentity([uint32]$pidValue, [long]$started, [int]$precisionTicks = 1) {
  if ($started -le 0 -or $precisionTicks -notin @(1, 10)) { return $false }
  try {
    $actual = Get-LiveProcessStarted $pidValue
    return (($actual - ($actual % $precisionTicks)) -eq $started)
  } catch {
    # Hardened service process DACLs can deny even QUERY_LIMITED_INFORMATION.
    # CIM's system provider exposes immutable creation time at microsecond
    # precision; re-query that exact PID, never infer identity from PID alone.
    if ($precisionTicks -ne 10) { return $false }
    try {
      $current = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $pidValue))
      return ($current.Count -eq 1 -and [uint32]$current[0].ProcessId -eq $pidValue -and $null -ne $current[0].CreationDate -and
        $current[0].CreationDate.ToUniversalTime().ToFileTimeUtc() -eq $started)
    } catch { return $false }
  }
}
function Test-ExpectedLocker($item, $expected, $precisions = $null) {
  $pidValue = [uint32]$item.Process.Pid
  $precision = 1
  if ($null -ne $precisions -and $precisions.ContainsKey($pidValue)) { $precision = $precisions[$pidValue] }
  $rmStart = [CluedRehearsalLocks.Query]::Start($item)
  if ($precision -notin @(1, 10) -or -not $expected.ContainsKey($pidValue) -or
      $expected[$pidValue] -ne ($rmStart - ($rmStart % $precision))) { return $false }
  return (Test-CurrentProcessIdentity $pidValue $expected[$pidValue] $precision)
}
function Test-CurrentProcessSnapshot($snapshot) {
  $precision = 1
  if ($snapshot.PSObject.Properties['precisionTicks']) { $precision = $snapshot.precisionTicks }
  return (Test-CurrentProcessIdentity ([uint32]$snapshot.pid) $snapshot.startedFileTime $precision)
}
function Test-ExpectedChildIdentity($parent, $child, $expected) {
  return ($expected.ContainsKey([uint32]$parent.pid) -and $expected[[uint32]$parent.pid] -eq $parent.startedFileTime -and
    $child.parentPid -eq $parent.pid -and $child.startedFileTime -ge $parent.startedFileTime)
}
function New-ProcessSnapshot($process) {
  try {
    if ($null -eq $process.CreationDate) { return $null }
    $cimStarted = $process.CreationDate.ToUniversalTime().ToFileTimeUtc()
    $precision = 1
    try { $started = Get-LiveProcessStarted ([uint32]$process.ProcessId) }
    catch { $started = $cimStarted; $precision = 10 }
    # WMI exposes microseconds, while RM/GetProcessById preserve FILETIME's
    # 100 ns ticks. Correlate the WMI row before retaining the full identity.
    if ($cimStarted -le 0 -or $cimStarted -ne ($started - ($started % 10))) { return $null }
    $image = [string]$process.ExecutablePath
    if (-not $image) { try { $image = Get-LiveProcessImage ([uint32]$process.ProcessId) } catch { $image = '' } }
    return [pscustomobject]@{ pid = [uint32]$process.ProcessId; parentPid = [uint32]$process.ParentProcessId
      startedFileTime = $started; precisionTicks = $precision; executablePath = $image }
  } catch { return $null } # Missing creation identity never exempts a locker.
}
function Test-ServiceAnchorPair($before, $after, $snapshot) {
  # SCM is the authority for these exact service PIDs. A WMI image path is not
  # required; creation identity (native or explicitly microsecond CIM) and
  # two SCM observations are. RM must match that identity as well.
  return ($null -ne $snapshot -and $before.Name -ceq $after.Name -and
    @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader') -ccontains $before.Name -and
    $before.State -ceq 'Running' -and $after.State -ceq 'Running' -and
    [uint32]$before.ProcessId -gt 0 -and $before.ProcessId -eq $after.ProcessId -and
    [uint32]$before.ProcessId -eq $snapshot.pid)
}
function Get-CompanionTaskObservations {
  # Bind the actual registered task instance, not every conhost/JobHost process.
  # EnginePID is the running instance's process (taskschd IRunningTask).
  $schedule = New-Object -ComObject Schedule.Service
  try {
    $schedule.Connect()
    $task = $schedule.GetFolder('\Clued').GetTask('CluedCIResidentCompanion')
    $actions = @($task.Definition.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Type -ne 0) { return }
    foreach ($instance in @($task.GetInstances(0))) {
      [pscustomobject]@{ path = [string]$instance.Path; instance = [string]$instance.InstanceGuid
        pid = [uint32]$instance.EnginePID; state = [int]$instance.State
        action = [string]$actions[0].Path; currentAction = [string]$instance.CurrentAction }
    }
  } finally { if ($null -ne $schedule) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($schedule) } }
}
function Test-CompanionTaskAnchorPair($before, $after, $snapshot, [string]$residentRoot) {
  if ($null -eq $snapshot -or $before.path -cne '\Clued\CluedCIResidentCompanion' -or
      $before.path -cne $after.path -or $before.instance -cne $after.instance -or
      $before.instance -notmatch '^\{[0-9a-fA-F-]{36}\}$' -or
      $before.state -ne 4 -or $after.state -ne 4 -or $before.pid -le 0 -or
      $before.pid -ne $after.pid -or $before.pid -ne $snapshot.pid) { return $false }
  $allowed = @((Join-Path $env:SystemRoot 'System32\conhost.exe'),
    (Join-Path $residentRoot 'runtime\node.exe'), (Join-Path $residentRoot 'bin\CluedCompanionJobHost.exe'),
    (Join-Path $residentRoot 'bin\CluedCompanionSupervisor.exe'))
  $action = [string]$before.action
  if (-not @($allowed | Where-Object { [string]::Equals($_, $action, [StringComparison]::OrdinalIgnoreCase) }).Count) { return $false }
  foreach ($value in @($after.action, $before.currentAction, $after.currentAction, $snapshot.executablePath)) {
    if (-not [string]::Equals([string]$value, $action, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
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
$servicesBefore = @(Get-CimInstance -ClassName Win32_Service | Where-Object { @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader') -ccontains $_.Name })
$taskBefore = @(Get-CompanionTaskObservations)
$observed = @([CluedRehearsalLocks.Query]::Files($files.ToArray()))
$servicesAfter = @(Get-CimInstance -ClassName Win32_Service | Where-Object { @('CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader') -ccontains $_.Name })
$taskAfter = @(Get-CompanionTaskObservations)
$expected = New-Object 'Collections.Generic.Dictionary[uint32,long]'
$precisions = New-Object 'Collections.Generic.Dictionary[uint32,int]'
foreach ($service in $servicesBefore) {
  $pidValue = [uint32]$service.ProcessId
  foreach ($after in @($servicesAfter | Where-Object { $_.Name -ceq $service.Name })) {
    if ($processes.ContainsKey($pidValue) -and (Test-ServiceAnchorPair $service $after $processes[$pidValue]) -and
        (Test-CurrentProcessSnapshot $processes[$pidValue])) {
      $expected[$pidValue] = $processes[$pidValue].startedFileTime; $precisions[$pidValue] = $processes[$pidValue].precisionTicks
    }
  }
}
foreach ($instance in $taskBefore) {
  foreach ($after in @($taskAfter | Where-Object { $_.instance -ceq $instance.instance })) {
    if ($processes.ContainsKey($instance.pid) -and (Test-CompanionTaskAnchorPair $instance $after $processes[$instance.pid] $Root) -and
        (Test-CurrentProcessSnapshot $processes[$instance.pid])) {
      $expected[$instance.pid] = $processes[$instance.pid].startedFileTime; $precisions[$instance.pid] = $processes[$instance.pid].precisionTicks
    }
  }
}
do {
  $changed = $false
  foreach ($process in $processes.Values) {
    if ($expected.ContainsKey($process.pid) -or -not $processes.ContainsKey($process.parentPid)) { continue }
    $parent = $processes[$process.parentPid]
    if ((Test-ExpectedChildIdentity $parent $process $expected) -and (Test-CurrentProcessSnapshot $parent) -and (Test-CurrentProcessSnapshot $process)) {
      $expected[$process.pid] = $process.startedFileTime; $precisions[$process.pid] = $process.precisionTicks; $changed = $true
    }
  }
} while ($changed)
$lockers = @(); $external = @()
foreach ($item in $observed) {
  $identity = [ordered]@{ pid = $item.Process.Pid; startedFileTime = [CluedRehearsalLocks.Query]::Start($item); application = $item.Application; service = $item.Service; expected = $false }
  $identity.expected = Test-ExpectedLocker $item $expected $precisions
  $identity['identityPrecisionTicks'] = $(if ($identity.expected) { $precisions[[uint32]$item.Process.Pid] } else { $null })
  $lockers += $identity
  if (-not $identity.expected) { $external += $identity }
}
[ordered]@{ contract = 'clued.independent-ci.rehearsal-file-locks/1'; status = 'OBSERVED'; coverage = 'installed-public-binaries-only'
  directoryHandlesCovered = $false; secretsEnumerated = $false; fileCount = $files.Count; lockers = $lockers; external = $external } | ConvertTo-Json -Depth 5 -Compress
