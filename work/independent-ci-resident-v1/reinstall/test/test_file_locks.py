"""Native read-only Restart Manager against a disposable held file, never installed state."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
PS = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
HOLDER = r'''
param([string]$File, [string]$Ready)
$h = [IO.File]::Open($File, 'Open', 'Read', 'Read')
try { [IO.File]::WriteAllText($Ready, 'ready'); $null = [Console]::ReadLine() } finally { $h.Dispose() }
'''
PROBE = r'''
param([string]$Library, [string]$File, [string]$Directory, [uint32]$Holder)
$ErrorActionPreference = 'Stop'
. $Library -LibraryOnly
$items = @([CluedRehearsalLocks.Query]::Files(@($File)))
$item = @($items | Where-Object { $_.Process.Pid -eq $Holder })
if ($item.Count -ne 1) { throw 'DISPOSABLE_HOLDER_NOT_OBSERVED' }
$expected = New-Object 'Collections.Generic.Dictionary[uint32,long]'
$externalBefore = -not (Test-ExpectedLocker $item[0] $expected)
# The actual production classifier, with a genuinely held disposable file and
# inaccessible task observations, must keep that unknown holder external.
function Get-CompanionTaskObservations { throw [UnauthorizedAccessException]::new('fixture task read denied') }
$taskSnapshotBefore = Get-CompanionTaskSnapshot
$taskSnapshotAfter = Get-CompanionTaskSnapshot
$taskBefore = @($taskSnapshotBefore.instances); $taskAfter = @($taskSnapshotAfter.instances)
$processes = New-Object 'Collections.Generic.Dictionary[uint32,object]'
$servicesBefore = @(); $servicesAfter = @(); $observed = $items
$source = [IO.File]::ReadAllText($Library)
$classification = [regex]::Match($source, '(?ms)^\$expected = New-Object .*?(?=^\[ordered\]@\{ contract)').Value
if (-not $classification) { throw 'PRODUCTION_CLASSIFIER_NOT_FOUND' }
. ([scriptblock]::Create($classification))
$deniedTaskHolderExternal = @($external | Where-Object { $_.pid -eq $Holder -and $_.expected -eq $false }).Count -eq 1
$deniedTaskNoAnchors = $taskBefore.Count -eq 0 -and $taskAfter.Count -eq 0 -and $expected.Count -eq 0
$expected[$Holder] = [CluedRehearsalLocks.Query]::Start($item[0])
$cim = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $Holder)
$snapshot = New-ProcessSnapshot $cim
$liveSnapshotMatches = $null -ne $snapshot -and (Test-CurrentProcessSnapshot $snapshot) -and $snapshot.startedFileTime -eq $expected[$Holder]
$staleRow = [pscustomobject]@{ ProcessId=$Holder; ParentProcessId=$cim.ParentProcessId; ExecutablePath=$cim.ExecutablePath; CreationDate=$cim.CreationDate.AddSeconds(-1) }
$staleRowRefused = $null -eq (New-ProcessSnapshot $staleRow)
$sameIdentityAccepted = Test-ExpectedLocker $item[0] $expected
$expected[$Holder] = $expected[$Holder] -bxor 1
$staleExpectedRefused = -not (Test-ExpectedLocker $item[0] $expected)
$expected[$Holder] = [CluedRehearsalLocks.Query]::Start($item[0])
$changed = $item[0]; $identity = $changed.Process; $started = $identity.Started
$started.dwLowDateTime = $started.dwLowDateTime -bxor 1
$identity.Started = $started; $changed.Process = $identity
$wrongIdentityRefused = -not (Test-ExpectedLocker $changed $expected)
$parent = [pscustomobject]@{pid=[uint32]100; startedFileTime=[long]200}
$child = [pscustomobject]@{pid=[uint32]101; parentPid=[uint32]100; startedFileTime=[long]300}
$treeExpected = New-Object 'Collections.Generic.Dictionary[uint32,long]'
$treeExpected[[uint32]100] = 200
$childIdentityAccepted = Test-ExpectedChildIdentity $parent $child $treeExpected
$child.startedFileTime = 150
$reusedParentRefused = -not (Test-ExpectedChildIdentity $parent $child $treeExpected)
$child.startedFileTime = 300; $treeExpected[[uint32]100] = 199
$staleParentSnapshotRefused = -not (Test-ExpectedChildIdentity $parent $child $treeExpected)
$directoryRefused = $false
try { $null = [CluedRehearsalLocks.Query]::Files(@($Directory)) } catch { $directoryRefused = $true }
[ordered]@{ externalObserved = $externalBefore; expectedIdentityAccepted = $sameIdentityAccepted; wrongIdentityRefused = $wrongIdentityRefused
  deniedTaskHolderExternal = $deniedTaskHolderExternal; deniedTaskNoAnchors = $deniedTaskNoAnchors
  staleExpectedRefused = $staleExpectedRefused; childIdentityAccepted = $childIdentityAccepted
  liveSnapshotMatches = $liveSnapshotMatches; staleRowRefused = $staleRowRefused
  reusedParentRefused = $reusedParentRefused; staleParentSnapshotRefused = $staleParentSnapshotRefused
  directoryRefused = $directoryRefused; infoSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CluedRehearsalLocks.Info])
  identitySize = [Runtime.InteropServices.Marshal]::SizeOf([type][CluedRehearsalLocks.Identity])
  emptyCount = @([CluedRehearsalLocks.Query]::Files(@())).Count } | ConvertTo-Json -Compress
'''

TASK_ACCESS_PROBE = r'''
param([string]$Library)
$ErrorActionPreference = 'Stop'
. $Library -LibraryOnly
Add-Type 'public static class FixtureTaskAccess { public static void Read() { throw new System.Runtime.InteropServices.COMException("fixture COM denial", -2147024891); } }'
$source = [IO.File]::ReadAllText($Library)
$classification = [regex]::Match($source, '(?ms)^\$expected = New-Object .*?(?=^\[ordered\]@\{ contract)').Value
if (-not $classification) { throw 'PRODUCTION_CLASSIFIER_NOT_FOUND' }
$root = 'C:\ProgramData\CluedIndependentCI\resident'
$task = [pscustomobject]@{path='\Clued\CluedCIResidentCompanion';instance='{12345678-1234-1234-1234-123456789abc}';pid=1234;state=4
  action=(Join-Path $env:SystemRoot 'System32\conhost.exe');currentAction=(Join-Path $env:SystemRoot 'System32\conhost.exe')}
$script:mode = 'readable'
function Get-CompanionTaskObservations {
  switch ($script:mode) {
    'readable' { $task }
    'denied' { throw [UnauthorizedAccessException]::new('fixture direct denial') }
    'wrapped' { [FixtureTaskAccess]::Read() }
    'partial' { $task; throw [UnauthorizedAccessException]::new('fixture denial after one row') }
    'other' { throw [Runtime.InteropServices.COMException]::new('fixture other failure', -2147467259) }
    'message' { throw [InvalidOperationException]::new('E_ACCESSDENIED is only message text') }
  }
}
$processes = New-Object 'Collections.Generic.Dictionary[uint32,object]'
$processes[[uint32]1234] = [pscustomobject]@{pid=[uint32]1234;parentPid=[uint32]1;startedFileTime=[long]100;precisionTicks=1;executablePath=$task.action}
$processes[[uint32]1235] = [pscustomobject]@{pid=[uint32]1235;parentPid=[uint32]1234;startedFileTime=[long]110;precisionTicks=1;executablePath=($root+'\runtime\node.exe')}
$processes[[uint32]2000] = [pscustomobject]@{pid=[uint32]2000;parentPid=[uint32]1;startedFileTime=[long]200;precisionTicks=1;executablePath=''}
$script:liveStarts = @{[uint32]1234=[long]100;[uint32]1235=[long]110;[uint32]2000=[long]200}
function Get-LiveProcessStarted([uint32]$pidValue) {
  if (-not $script:liveStarts.ContainsKey($pidValue)) { throw 'fixture missing live PID' }
  return $script:liveStarts[$pidValue]
}
function New-Item([uint32]$id, [long]$start) {
  $item = New-Object CluedRehearsalLocks.Info
  $identity = New-Object CluedRehearsalLocks.Identity; $identity.Pid = $id
  $ft = New-Object Runtime.InteropServices.ComTypes.FILETIME
  $bytes = [BitConverter]::GetBytes($start)
  $ft.dwLowDateTime = [BitConverter]::ToInt32($bytes,0); $ft.dwHighDateTime = [BitConverter]::ToInt32($bytes,4)
  $identity.Started = $ft; $item.Process = $identity
  return $item
}
function Classify($before, $after, $observed, $services = @()) {
  $taskBefore = @($before.instances); $taskAfter = @($after.instances)
  $servicesBefore = @($services); $servicesAfter = @($services)
  . ([scriptblock]::Create($classification))
  return [pscustomobject]@{lockers=@($lockers);external=@($external);expectedCount=$expected.Count}
}
$result = [ordered]@{}
$readable = Get-CompanionTaskSnapshot
$script:mode = 'denied'; $denied = Get-CompanionTaskSnapshot
$result.directDeniedIsExplicit = $denied.status -ceq 'UNREADABLE' -and $denied.code -ceq 'COMPANION_TASK_ACCESS_DENIED' -and $denied.instances.Count -eq 0
$script:mode = 'wrapped'; $wrapped = Get-CompanionTaskSnapshot
$result.wrappedComDeniedIsExplicit = $wrapped.status -ceq 'UNREADABLE' -and $wrapped.instances.Count -eq 0
$script:mode = 'partial'; $partial = Get-CompanionTaskSnapshot
$result.partialAnchorDiscarded = $partial.status -ceq 'UNREADABLE' -and $partial.instances.Count -eq 0
foreach ($mode in @('other','message')) {
  $script:mode = $mode; $thrown = $false
  try { $null = Get-CompanionTaskSnapshot } catch { $thrown = $true }
  $result[$mode+'StillFails'] = $thrown
}
$normal = Classify $readable $readable @((New-Item 1234 100), (New-Item 1235 110))
$result.readableTaskAndChildVerified = $normal.external.Count -eq 0 -and $normal.lockers.Count -eq 2
$empty = Classify $denied $denied @()
$result.noLockersIsObservedWithoutTaskAuthority = $empty.lockers.Count -eq 0 -and $empty.external.Count -eq 0 -and $empty.expectedCount -eq 0
$unknown = Classify $denied $denied @((New-Item 1234 100), (New-Item 1235 110))
$result.deniedTaskAndChildStayExternal = $unknown.external.Count -eq 2 -and $unknown.expectedCount -eq 0
$fromReadable = Classify $readable $denied @((New-Item 1234 100), (New-Item 1235 110))
$toReadable = Classify $denied $readable @((New-Item 1234 100), (New-Item 1235 110))
$result.eitherUnreadableObservationRemovesTaskAnchor = $fromReadable.external.Count -eq 2 -and $toReadable.external.Count -eq 2
$fromPartial = Classify $partial $readable @((New-Item 1234 100))
$result.partialFailureCannotAuthorizeLaterObservation = $fromPartial.external.Count -eq 1
$service = [pscustomobject]@{Name='CluedCIResident';State='Running';ProcessId=[uint32]2000}
$serviceResult = Classify $denied $denied @((New-Item 2000 200), (New-Item 1234 100)) @($service)
$result.independentScmAnchorStillRequired = $serviceResult.external.Count -eq 1 -and $serviceResult.external[0].pid -eq 1234
$script:liveStarts[[uint32]1234] = 101
$reused = Classify $readable $readable @((New-Item 1234 100), (New-Item 1235 110))
$result.reusedTaskPidAndChildStayExternal = $reused.external.Count -eq 2
$result|ConvertTo-Json -Compress
'''

IDENTITY_PROBE = r'''
param([string]$Library)
$ErrorActionPreference='Stop'
. $Library -LibraryOnly
# The actual NODE-B failure shape: service native query denied, WMI path empty,
# immutable CIM creation time available. These functions substitute only OS reads.
function Get-LiveProcessStarted([uint32]$pidValue) { throw 'fixture native query denied' }
function Get-LiveProcessImage([uint32]$pidValue) { throw 'fixture native query denied' }
function Get-CimInstance { param($ClassName,$Filter)
  if($ClassName -cne 'Win32_Process'){throw 'UNEXPECTED_QUERY'}
  $wanted=[uint32]($Filter -replace '^ProcessId=','')
  if($script:rows.ContainsKey($wanted)){return $script:rows[$wanted]}
}
$base=[DateTime]::UtcNow.AddMinutes(-1).ToFileTimeUtc()
$base=$base-($base%10)
$row=[pscustomobject]@{ProcessId=[uint32]79596;ParentProcessId=[uint32]1;CreationDate=[DateTime]::FromFileTimeUtc($base);ExecutablePath=$null}
$script:rows=@{[uint32]79596=$row}
$s=New-ProcessSnapshot $row
$before=[pscustomobject]@{Name='CluedCIResident';State='Running';ProcessId=[uint32]79596}
$after=[pscustomobject]@{Name='CluedCIResident';State='Running';ProcessId=[uint32]79596}
$result=[ordered]@{}
$result.cimOnlySnapshot=($s.precisionTicks -eq 10 -and $s.executablePath -ceq '' -and $s.startedFileTime -eq $base)
$result.serviceIdentity=(Test-ServiceAnchorPair $before $after $s) -and (Test-CurrentProcessSnapshot $s)
$after.ProcessId=77152;$result.changedScmPidRefused=-not(Test-ServiceAnchorPair $before $after $s)
$after.ProcessId=79596;$after.State='Stopped';$result.stoppedServiceRefused=-not(Test-ServiceAnchorPair $before $after $s)
$after.State='Running';$after.Name='OtherService';$result.otherServiceRefused=-not(Test-ServiceAnchorPair $before $after $s)
$item=New-Object CluedRehearsalLocks.Info
$identity=New-Object CluedRehearsalLocks.Identity
$identity.Pid=79596
$ft=New-Object Runtime.InteropServices.ComTypes.FILETIME
$bytes=[BitConverter]::GetBytes([long]($base+3))
$ft.dwLowDateTime=[BitConverter]::ToInt32($bytes,0);$ft.dwHighDateTime=[BitConverter]::ToInt32($bytes,4)
$identity.Started=$ft;$item.Process=$identity
$expected=New-Object 'Collections.Generic.Dictionary[uint32,long]'
$precisions=New-Object 'Collections.Generic.Dictionary[uint32,int]'
$expected[[uint32]79596]=$s.startedFileTime;$precisions[[uint32]79596]=10
$result.rmMicrosecondIdentity=(Test-ExpectedLocker $item $expected $precisions)
$expected[[uint32]79596]=$base-10;$result.changedRmStartRefused=-not(Test-ExpectedLocker $item $expected $precisions)
$expected[[uint32]79596]=$base
$script:rows[[uint32]79596]=[pscustomobject]@{ProcessId=79596;CreationDate=$row.CreationDate.AddSeconds(1)}
$result.reusedPidRefused=-not(Test-ExpectedLocker $item $expected $precisions)
$script:rows.Clear();$result.gonePidRefused=-not(Test-ExpectedLocker $item $expected $precisions)
$result.nativePrecisionNotInvented=-not(Test-CurrentProcessIdentity 79596 ($base+3) 1)
$missing=[pscustomobject]@{ProcessId=79596;ParentProcessId=1;CreationDate=$null;ExecutablePath=$null}
$result.missingCreationRefused=$null -eq (New-ProcessSnapshot $missing)
$task=[pscustomobject]@{path='\Clued\CluedCIResidentCompanion';instance='{12345678-1234-1234-1234-123456789abc}';pid=82664;state=4;action=(Join-Path $env:SystemRoot 'System32\conhost.exe');currentAction=(Join-Path $env:SystemRoot 'System32\conhost.exe')}
$taskAfter=$task.PSObject.Copy()
$taskProcess=[pscustomobject]@{pid=82664;startedFileTime=$base;executablePath=$task.action}
$result.registeredConhostAccepted=Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident'
$taskAfter.instance='{23456789-1234-1234-1234-123456789abc}';$result.changedTaskInstanceRefused=-not(Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident')
$taskAfter=$task.PSObject.Copy();$taskAfter.pid=1234;$result.changedTaskPidRefused=-not(Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident')
$taskAfter=$task.PSObject.Copy();$taskAfter.action='C:\other.exe';$result.changedTaskActionRefused=-not(Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident')
$taskAfter=$task.PSObject.Copy();$taskAfter.path='\Other\SameConhost';$result.otherTaskRefused=-not(Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident')
$taskAfter=$task.PSObject.Copy();$taskProcess.executablePath='C:\unrelated\conhost.exe';$result.otherConhostRefused=-not(Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident')
$taskProcess.executablePath=$task.action;$taskAfter.state=3;$result.stoppedTaskRefused=-not(Test-CompanionTaskAnchorPair $task $taskAfter $taskProcess 'C:\ProgramData\CluedIndependentCI\resident')
$sup='C:\ProgramData\CluedIndependentCI\resident\bin\CluedCompanionSupervisor.exe'
$supTask=[pscustomobject]@{path='\Clued\CluedCIResidentCompanion';instance='{12345678-1234-1234-1234-123456789abc}';pid=26080;state=4;action=$sup;currentAction=$sup}
$supProcess=[pscustomobject]@{pid=26080;startedFileTime=$base;executablePath=$sup}
$action=[pscustomobject]@{pid=26081;parentPid=26080;startedFileTime=$base+10;executablePath=$sup}
$engine=[pscustomobject]@{pid=26080;startedFileTime=$base;precisionTicks=10}
$script:rows[[uint32]26080]=[pscustomobject]@{ProcessId=[uint32]26080;CreationDate=[DateTime]::FromFileTimeUtc($base)}
$snapshot=[pscustomobject]@{pid=[uint32]26080;executablePath=$sup;startedFileTime=$base;precisionTicks=10}
$oldRoot='C:\ProgramData\CluedIndependentCI\resident'; $sid='S-1-5-21-1-2-3-1001'
$old=[pscustomobject]@{ProcessId=26080;CommandLine=('"'+$sup+'" "'+$oldRoot+'"')}
function Invoke-CimMethod { param($InputObject,$MethodName,$ErrorAction) @{ReturnValue=0;Sid='S-1-5-21-1-2-3-1001'} }
$result.orphanWithPinnedImageAccountAndArgs=Test-InstalledSupervisor $snapshot $old $sup $sid $oldRoot
$result.otherAccountRefused=-not(Test-InstalledSupervisor $snapshot $old $sup ($sid+'0') $oldRoot)
$old.CommandLine=$sup+' '+$oldRoot
$result.sameUnquotedArgumentsAccepted=Test-InstalledSupervisor $snapshot $old $sup $sid $oldRoot
$old.CommandLine+=' extra'
$result.extraArgumentRefused=-not(Test-InstalledSupervisor $snapshot $old $sup $sid $oldRoot)
$result.engineCanHostSeparateAction=Test-CompanionTaskAnchorPair $supTask $supTask.PSObject.Copy() $action 'C:\ProgramData\CluedIndependentCI\resident' $engine
$engine.startedFileTime=$base+20
$result.recycledEngineRefused=-not(Test-CompanionTaskAnchorPair $supTask $supTask.PSObject.Copy() $action 'C:\ProgramData\CluedIndependentCI\resident' $engine)
$result.registeredSupervisorAccepted=Test-CompanionTaskAnchorPair $supTask $supTask.PSObject.Copy() $supProcess 'C:\ProgramData\CluedIndependentCI\resident'
$other='C:\elsewhere\bin\CluedCompanionSupervisor.exe';$supTask.action=$other;$supTask.currentAction=$other;$supProcess.executablePath=$other
$result.otherSupervisorPathRefused=-not(Test-CompanionTaskAnchorPair $supTask $supTask.PSObject.Copy() $supProcess 'C:\ProgramData\CluedIndependentCI\resident')
$result|ConvertTo-Json -Compress
'''


RM_RETRY_PROBE = r'''
param([string]$Library)
$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText($Library)
$cs = [regex]::Match($source, '(?ms)^using System;.*?(?=^''@)').Value
$imports = '(?ms)^    \[DllImport\("rstrtmgr.dll"[^\]]*\)\] static extern uint Rm.*?;(?=\r?$)'
if ([regex]::Matches($cs, $imports).Count -ne 4) { throw 'RM_IMPORTS_NOT_FOUND' }
$stubs = @'
    public static uint Sessions, Closed, Registered;
    public static bool PersistentFailure;
    public static int FirstCapacity, GrownCapacity, CallDuration;
    static uint RmStartSession(out uint handle, uint flags, StringBuilder key) { handle = ++Sessions; return 0; }
    static uint RmRegisterResources(uint handle, uint count, string[] paths, uint apps, Identity[] processes, uint services, string[] names) {
      Registered += count; return 0;
    }
    static uint RmGetList(uint handle, out uint needed, ref uint count, Info[] list, ref uint reasons) {
      RetryClock.Now += CallDuration;
      needed = 181;
      if (PersistentFailure) return 6;
      if (handle == 1 && count < needed) { FirstCapacity = (int)count; return 234; }
      if (handle == 1) { GrownCapacity = (int)count; return 6; }
      if (count < needed) throw new InvalidOperationException("RETRY_LOST_BUFFER_CAPACITY");
      list[0].Process.Pid = 123;
      count = 1;
      return 0;
    }
    static uint RmEndSession(uint handle) { Closed++; return 0; }
'@
$match = [regex]::Match($cs, $imports)
$cs = ([regex]::Replace($cs, $imports, '')).Insert($match.Index, $stubs)
$cs = $cs.Replace('using System.Diagnostics;', 'using Stopwatch = CluedRehearsalLocks.RetryClock;')
$cs = $cs.Replace('using System.Threading;', 'using Thread = CluedRehearsalLocks.RetryClock;')
$cs += @'

namespace CluedRehearsalLocks {
  public sealed class RetryClock {
    public static long Now;
    readonly long started = Now;
    public long ElapsedMilliseconds { get { return Now - started; } }
    public static RetryClock StartNew() { return new RetryClock(); }
    public static void Sleep(int ms) { Now += ms; }
  }
}
'@
Add-Type -TypeDefinition $cs
$items = @([CluedRehearsalLocks.Query]::Files(@('fixture.exe')))
if ($items.Count -ne 1 -or $items[0].Process.Pid -ne 123 -or
    [CluedRehearsalLocks.Query]::FirstCapacity -le 0 -or [CluedRehearsalLocks.Query]::GrownCapacity -le 181 -or
    [CluedRehearsalLocks.Query]::Sessions -ne 2 -or [CluedRehearsalLocks.Query]::Closed -ne 2 -or
    [CluedRehearsalLocks.Query]::Registered -ne 2) { throw 'RM_RETRY_DID_NOT_RECOVER_COMPLETE_LIST' }
[CluedRehearsalLocks.Query]::PersistentFailure = $true
function Assert-PersistentFailure($expectedSessions) {
  try { $null = [CluedRehearsalLocks.Query]::Files(@('fixture.exe')); throw 'RM_ERROR_RETURNED_AS_LIST' }
  catch {
    $cause = $_.Exception.InnerException
    if ($cause -isnot [ComponentModel.Win32Exception] -or $cause.NativeErrorCode -ne 6) { throw }
  }
  if ([CluedRehearsalLocks.Query]::Sessions -ne $expectedSessions -or
      [CluedRehearsalLocks.Query]::Closed -ne $expectedSessions) { throw 'RM_RETRY_NOT_BOUNDED' }
}
Assert-PersistentFailure 8
[CluedRehearsalLocks.Query]::CallDuration = 12000
Assert-PersistentFailure 9
'''


WINDOW_PROBE = r'''
param([string]$Library, [string]$FixtureRoot, [string]$Scenario)
. $Library -LibraryOnly
$Root = $FixtureRoot
$ExpectedInstallReceiptSha256 = (Get-FileHash (Join-Path $Root 'install\install-receipt.json')).Hash.ToLowerInvariant()
$CompanionSid = 'S-1-5-21-1-2-3-1001'
$image = Join-Path $Root 'bin\CluedCompanionSupervisor.exe'
function New-Row([uint32]$id, [uint32]$parent, [long]$start, [string]$path) {
  [pscustomobject]@{ ProcessId=$id; ParentProcessId=$parent; CreationDate=[DateTime]::FromFileTimeUtc($start)
    ExecutablePath=$path; CommandLine=('"'+$path+'" "'+$Root+'"') }
}
$supervisor = New-Row 100 1 100 $image
$childParent = if ($Scenario -eq 'unowned') { 1 } else { 100 }
$child = New-Row 101 $childParent 200 (Join-Path $Root 'runtime\node.exe')
$script:live = @{ [uint32]100=$supervisor }
if ($Scenario -ne 'born') { $script:live[$child.ProcessId] = $child }
function Get-CimInstance($ClassName, $Filter) {
  if ($ClassName -eq 'Win32_Service') { return }
  if ($ClassName -ne 'Win32_Process') { throw 'UNEXPECTED_QUERY' }
  if (!$Filter) { return $script:live.Values }
  if ($Filter -notmatch '^ProcessId=(\d+)$') { throw 'UNEXPECTED_FILTER' }
  $id = [uint32]$Matches[1]
  if ($script:live.ContainsKey($id)) { return $script:live[$id] }
}
function Get-LiveProcessStarted([uint32]$pidValue) {
  return $script:live[$pidValue].CreationDate.ToFileTimeUtc()
}
function Invoke-CimMethod($InputObject, $MethodName) {
  if ($MethodName -ne 'GetOwnerSid' -or $InputObject.ProcessId -ne 100) { throw 'UNEXPECTED_OWNER_QUERY' }
  return @{ ReturnValue=0; Sid=$CompanionSid }
}
function Get-CompanionTaskObservations { }
function Get-WindowLockers {
  if ($Scenario -eq 'exited') { $script:live.Remove($child.ProcessId); return }
  $locker = $child
  if ($Scenario -eq 'reused') { $locker = New-Row 101 100 300 $child.ExecutablePath }
  $script:live[$locker.ProcessId] = $locker
  $started = New-Object Runtime.InteropServices.ComTypes.FILETIME
  $started.dwLowDateTime = [int]$locker.CreationDate.ToFileTimeUtc()
  $identity = New-Object CluedRehearsalLocks.Identity
  $identity.Pid = $locker.ProcessId; $identity.Started = $started
  $item = New-Object CluedRehearsalLocks.Info
  $item.Process = $identity
  return $item
}
# Run production receipt verification, sampling and classification on disposable inputs.
# Change the live table at the RM call itself, independently of the number of CIM reads.
$source = [IO.File]::ReadAllText($Library)
$body = $source.Substring($source.IndexOf('$processes = New-Object'))
$rm = '[CluedRehearsalLocks.Query]::Files($files.ToArray())'
if (!$body.Contains($rm)) { throw 'PRODUCTION_RM_CALL_NOT_FOUND' }
. ([scriptblock]::Create($body.Replace($rm, 'Get-WindowLockers')))
'''


@unittest.skipUnless(PS.is_file(), 'Windows PowerShell 5.1 required')
class FileLocks(unittest.TestCase):
    def test_rm_grows_list_and_restarts_invalid_sessions_with_a_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'rm-retry.ps1'
            script.write_text(RM_RETRY_PROBE, encoding='ascii')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script),
                                     str(ROOT / 'tools/file-locks.ps1')], capture_output=True,
                                    text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stderr)

    def classify_window(self, scenario):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            image = b'fixture supervisor'
            (root / 'bin/CluedCompanionSupervisor.exe').write_bytes(image)
            (root / 'install').mkdir()
            receipt = {'companionSupervisorSha256': hashlib.sha256(image).hexdigest()}
            (root / 'install/install-receipt.json').write_text(json.dumps(receipt), encoding='ascii')
            script = root / 'window.ps1'
            script.write_text(WINDOW_PROBE, encoding='ascii')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script),
                                     str(ROOT / 'tools/file-locks.ps1'), directory, scenario],
                                    capture_output=True, text=True, encoding='utf-8')
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_child_born_during_lock_query_is_expected(self):
        report = self.classify_window('born')
        self.assertEqual(report['external'], [])
        self.assertEqual(report['unknownProcesses'], [])
        self.assertEqual([(p['pid'], p['expected']) for p in report['lockers']], [(101, True)])
        self.assertCountEqual([p['pid'] for p in report['rootProcesses']], [100, 101])

    def test_child_exited_during_lock_query_is_omitted(self):
        report = self.classify_window('exited')
        self.assertEqual(report['unknownProcesses'], [])
        self.assertEqual(report['external'], [])
        self.assertEqual([p['pid'] for p in report['rootProcesses']], [100])

    def test_pid_reused_during_lock_query_is_refused(self):
        report = self.classify_window('reused')
        self.assertIn(101, report['unknownProcesses'])
        self.assertEqual([(p['pid'], p['startedFileTime']) for p in report['external']], [(101, 300)])
        self.assertEqual([p['pid'] for p in report['rootProcesses']], [100])

    def test_live_unowned_locker_is_refused(self):
        report = self.classify_window('unowned')
        self.assertIn(101, report['unknownProcesses'])
        self.assertEqual([p['pid'] for p in report['external']], [101])
        self.assertEqual([p['pid'] for p in report['rootProcesses']], [100])

    def test_task_access_denied_has_no_partial_or_unverified_exemptions(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'task-access.ps1'
            script.write_text(TASK_ACCESS_PROBE, encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script),
                                     str(ROOT / 'tools/file-locks.ps1')], capture_output=True,
                                    text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(len(data), 12)
            self.assertTrue(all(value is True for value in data.values()), data)

    def test_hardened_service_cim_identity_and_registered_conhost_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'identities.ps1'
            script.write_text(IDENTITY_PROBE, encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(script),
                                     str(ROOT / 'tools/file-locks.ps1')], capture_output=True,
                                    text=True, encoding='utf-8', timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual(len(data), 26)
            self.assertTrue(all(value is True for value in data.values()), data)

    def test_native_observation_is_read_only_and_binds_pid_start_time(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'held.bin'
            original = b'disposable fixture, no secret'
            target.write_bytes(original)
            (root / 'holder.ps1').write_text(HOLDER, encoding='utf-8')
            (root / 'probe.ps1').write_text(PROBE, encoding='utf-8')
            child = subprocess.Popen([str(PS), '-NoProfile', '-NonInteractive', '-File', str(root / 'holder.ps1'),
                                      str(target), str(root / 'ready')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                until = time.monotonic() + 10
                while not (root / 'ready').exists() and time.monotonic() < until:
                    if child.poll() is not None:
                        self.fail('fixture holder exited: ' + child.stderr.read().decode('utf-8', 'replace'))
                    time.sleep(0.05)
                self.assertTrue((root / 'ready').exists())
                result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(root / 'probe.ps1'),
                                         str(ROOT / 'tools/file-locks.ps1'), str(target), directory, str(child.pid)],
                                        capture_output=True, text=True, encoding='utf-8', timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(result.stdout)
                self.assertEqual(data, {'externalObserved': True, 'expectedIdentityAccepted': True, 'wrongIdentityRefused': True,
                                       'deniedTaskHolderExternal': True, 'deniedTaskNoAnchors': True,
                                       'staleExpectedRefused': True, 'childIdentityAccepted': True,
                                       'liveSnapshotMatches': True, 'staleRowRefused': True,
                                       'reusedParentRefused': True, 'staleParentSnapshotRefused': True,
                                       'directoryRefused': True, 'infoSize': 668, 'identitySize': 12, 'emptyCount': 0})
                self.assertIsNone(child.poll(), 'observation must not stop the holder')
                self.assertEqual(target.read_bytes(), original)
            finally:
                child.communicate(b'\n', timeout=10)


if __name__ == '__main__':
    unittest.main()
