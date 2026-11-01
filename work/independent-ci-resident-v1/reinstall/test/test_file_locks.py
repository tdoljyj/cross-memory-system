"""Native read-only Restart Manager against a disposable held file, never installed state."""
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
  staleExpectedRefused = $staleExpectedRefused; childIdentityAccepted = $childIdentityAccepted
  liveSnapshotMatches = $liveSnapshotMatches; staleRowRefused = $staleRowRefused
  reusedParentRefused = $reusedParentRefused; staleParentSnapshotRefused = $staleParentSnapshotRefused
  directoryRefused = $directoryRefused; infoSize = [Runtime.InteropServices.Marshal]::SizeOf([type][CluedRehearsalLocks.Info])
  identitySize = [Runtime.InteropServices.Marshal]::SizeOf([type][CluedRehearsalLocks.Identity])
  emptyCount = @([CluedRehearsalLocks.Query]::Files(@())).Count } | ConvertTo-Json -Compress
'''


@unittest.skipUnless(PS.is_file(), 'Windows PowerShell 5.1 required')
class FileLocks(unittest.TestCase):
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
