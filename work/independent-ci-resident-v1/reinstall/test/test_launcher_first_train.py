"""Exercise the real first-train template functions; all status, runner and time waits are isolated fixtures."""
import copy
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PS = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
SOURCE = '8860531ae1c4' + '0' * 52

DRIVER = r'''
param([string]$Template, [string]$Case, [string]$Directory)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$c = $Js.DeserializeObject([IO.File]::ReadAllText($Case))
$t = [IO.File]::ReadAllText($Template)
foreach ($name in @('Get-Key', 'Parse-Json', 'Test-FirstTrainNotApplicable', 'Step-WaitFirstTrain')) {
  $m = [regex]::Match($t, '(?ms)^function ' + [regex]::Escape($name) + '\b.*?^\}')
  if (-not $m.Success) { throw ('FUNCTION_MISSING:' + $name) }
  . ([scriptblock]::Create($m.Value))
}
$ResidentRoot = $Directory
[IO.Directory]::CreateDirectory((Join-Path $ResidentRoot 'state')) | Out-Null
$NodeName = 'desk-w-591'; $CiSourceManifestSha256 = ('8860531ae1c4' + ('0' * 52))
$FirstTrainWaitSeconds = 1500; $RunnerQuietWaitSeconds = 900
$Done = New-Object 'Collections.Generic.List[string]'
$script:waits = New-Object 'Collections.Generic.List[int]'
$script:sleeps = New-Object 'Collections.Generic.List[int]'
$script:firstIterations = 0; $script:runnerReads = 0; $script:written = $null
function Write-FixtureStatus($value) {
  # Model the producer's post-start refresh unless this case explicitly tests
  # carried/stale/malformed timestamps. Only the OS observation is substituted.
  if ($value -is [Collections.IDictionary]) {
    $preserve = $value.ContainsKey('_preserveWrittenAt') -and $value['_preserveWrittenAt']
    [void]$value.Remove('_preserveWrittenAt')
    if (-not $preserve -and $value.ContainsKey('writtenAt')) { $value['writtenAt'] = [DateTimeOffset]::UtcNow.ToString('o') }
  }
  [IO.File]::WriteAllText((Join-Path $ResidentRoot 'state\status.json'), $Js.Serialize($value))
}
function Start-Sleep { param([int]$Seconds) $script:sleeps.Add($Seconds) }
function Get-RunnerState {
  $script:runnerReads++
  [ordered]@{ flags = [ordered]@{ originalBinary = $c['originalBinary']; stoppedPid0 = $c['stoppedPid0'] } }
}
function Wait-Until($condition, [int]$seconds) {
  $script:waits.Add($seconds)
  if ($script:waits.Count -eq 1) {
    foreach ($s in $c['snapshots']) {
      Write-FixtureStatus $s
      $script:firstIterations++
      if (& $condition) { return $true }
    }
    return $false
  }
  if ($null -ne $c['quietStatus']) { Write-FixtureStatus $c['quietStatus'] }
  return [bool](& $condition)
}
function Write-Json($name, $value) {
  if ($name -cne 'first-train-report.json') { throw 'UNEXPECTED_WRITE' }
  $script:written = $value
}
$r = Step-WaitFirstTrain
[ordered]@{ report = $r; done = @($Done); waits = @($script:waits); sleeps = @($script:sleeps)
  firstIterations = $script:firstIterations; runnerReads = $script:runnerReads; recorded = $script:written } | ConvertTo-Json -Depth 12 -Compress
'''


def standby():
    now = datetime.datetime.now(datetime.timezone.utc)
    iso = lambda value: value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    # Actual DESK shape: its role probe runs every 15 minutes; fullPending does not confer a role.
    return {'contract': 'clued.independent-ci.resident-status/8', 'writtenAt': iso(now),
            'node': {'name': 'desk-w-591', 'source': SOURCE[:12], 'mode': 'STANDBY',
                     'probe': {'at': iso(now - datetime.timedelta(minutes=6, seconds=46)),
                               'result': 'not-held', 'failures': 0, 'failingSince': None}},
            'executor': {'state': 'IDLE', 'reason': None}, 'current': None, 'pending': [],
            'queue': {'depth': 100, 'generation': 'c3f0886bd193', 'hold': None, 'live': 0, 'parkingFull': False},
            'train': {'enabled': 'on', 'last': None, 'notOnDuty': True, 'fullPending': True,
                      'backgroundAllPending': False, 'frontReadyMode': 'blocked', 'sweepMode': 'audit'}, 'halt': None}


@unittest.skipUnless(PS.is_file(), 'Windows PowerShell 5.1 required')
class FirstTrain(unittest.TestCase):
    def run_case(self, snapshots=None, original_binary=True, stopped_pid0=True, quiet_status=None):
        with tempfile.TemporaryDirectory(prefix='first-train-') as directory:
            p = Path(directory)
            (p / 'driver.ps1').write_text(DRIVER, encoding='utf-8')
            case = {'snapshots': snapshots or [standby()], 'originalBinary': original_binary,
                    'stoppedPid0': stopped_pid0, 'quietStatus': quiet_status}
            (p / 'case.json').write_text(json.dumps(case), encoding='utf-8')
            result = subprocess.run([str(PS), '-NoProfile', '-NonInteractive', '-File', str(p / 'driver.ps1'),
                                     str(ROOT / 'launcher/template.ps1'), str(p / 'case.json'), directory],
                                    capture_output=True, text=True, encoding='utf-8', timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_actual_non_duty_empty_node_does_not_wait_for_a_train(self):
        r = self.run_case()
        self.assertTrue(r['report']['notApplicable'])
        self.assertFalse(r['report']['observed'], 'inapplicable is not a witnessed train')
        self.assertEqual(r['firstIterations'], 1)
        self.assertEqual(r['done'], ['first-train-not-applicable'])
        self.assertEqual(r['report']['notApplicableObservation']['nodeName'], 'desk-w-591')
        self.assertEqual(r['report']['notApplicableObservation']['mode'], 'STANDBY')
        self.assertEqual(r['report']['notApplicableObservation']['probeResult'], 'not-held')
        self.assertEqual(r['report']['notApplicableObservation']['queueLive'], 0)
        self.assertEqual(r['report']['notApplicableObservation']['pendingCount'], 0)
        self.assertEqual(r['recorded'], r['report'])
        self.assertTrue(r['report']['runnerQuiet'])
        self.assertEqual(r['waits'], [1500, 900])
        self.assertEqual(r['sleeps'], [5], 'both runner-quiet polls remain, five seconds apart')
        self.assertEqual(r['runnerReads'], 3)  # two quiet polls and final observation

    def test_active_role_and_existing_train_keep_the_original_observation_path(self):
        s = standby(); s['node']['mode'] = 'ACTIVE'; s['node']['probe']['result'] = 'held'
        r = self.run_case([s])
        self.assertFalse(r['report']['notApplicable'])
        self.assertFalse(r['report']['observed'])
        self.assertEqual(r['done'], ['first-train-not-observed'])
        s['train']['last'] = {'outcome': 'DONE'}
        r = self.run_case([s])
        self.assertFalse(r['report']['notApplicable'])
        self.assertTrue(r['report']['observed'])
        self.assertEqual(r['done'], ['first-train'])

    def test_terminal_history_is_not_live_queued_work(self):
        row = {'pr': 1057, 'headSha': 'a' * 40, 'baseSha': 'b' * 40, 'state': 'DONE'}
        s = standby(); s['pending'] = [row, dict(row, pr=1058, state='STOPPED')]
        r = self.run_case([s])
        self.assertTrue(r['report']['notApplicable'])
        self.assertEqual(r['report']['notApplicableObservation']['pendingCount'], 2)
        self.assertEqual(r['done'], ['first-train-not-applicable'])
        for patch in ({'state': 'QUEUED'}, {'state': 'RUNNING'}, {'state': 'PARKED'}, {'state': 'WAITING'},
                      {'state': 'BACKOFF'}, {'state': 'unknown'}, {'state': None}, {'pr': True},
                      {'pr': 0}, {'headSha': 'bad'}, {'baseSha': None}):
            with self.subTest(patch=patch):
                s = standby(); s['pending'] = [row, dict(row, **patch)]
                r = self.run_case([s])
                self.assertFalse(r['report']['notApplicable'])
                self.assertIsNone(r['report']['error'])
        for pending in ([None], [{}], [row] * 101):
            with self.subTest(pending=pending):
                s = standby(); s['pending'] = pending
                self.assertFalse(self.run_case([s])['report']['notApplicable'])

    def test_nonempty_work_and_nonidle_executor_never_use_not_applicable(self):
        for patch in ({'current': {'pr': 1}}, {'pending': [{'state': 'QUEUED'}]},
                      {'queue': {'generation': 'c3f0886bd193', 'live': 1}},
                      {'executor': {'state': 'RUNNING'}}, {'executor': {'state': 'STARTING'}},
                      {'executor': {'state': 'WAITING'}}):
            with self.subTest(patch=patch):
                s = standby(); s.update(patch)
                r = self.run_case([s])
                self.assertFalse(r['report']['notApplicable'])

    def test_unknown_stale_wrong_node_and_malformed_observations_keep_waiting(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        cases = []
        for key in ('node', 'queue', 'pending', 'current', 'halt', 'writtenAt'):
            s = standby(); del s[key]; cases.append(s)
        for patch in ({'contract': 'unknown'}, {'pending': None}, {'pending': {}},
                      {'writtenAt': (now - datetime.timedelta(minutes=6)).isoformat()},
                      {'writtenAt': (now + datetime.timedelta(minutes=2)).isoformat()},
                      {'writtenAt': now.replace(tzinfo=None).isoformat()},
                      {'writtenAt': now.strftime('%H:%MZ')}, {'writtenAt': now.strftime('%Y-%m-%dZ')},
                      {'writtenAt': now.strftime('%m/%d/%Y %H:%M:%SZ')},
                      {'writtenAt': now.strftime('%Y-%m-%d %H:%M:%SZ')}):
            s = standby(); s.update(patch)
            if 'writtenAt' in patch:
                s['_preserveWrittenAt'] = True
            cases.append(s)
        for patch in ({'name': 'turing'}, {'source': '0' * 12}, {'mode': 'UNCERTAIN'}, {'probe': None}):
            s = standby(); s['node'].update(patch); cases.append(s)
        for patch in ({'result': 'uncertain'}, {'failures': 1}, {'failingSince': now.isoformat()},
                      {'at': (now - datetime.timedelta(minutes=16)).isoformat()},
                      {'at': (now + datetime.timedelta(minutes=2)).isoformat()}, {'at': 'bad'},
                      {'at': now.strftime('%H:%MZ')}):
            s = standby(); s['node']['probe'].update(patch); cases.append(s)
        for patch in ({'live': '0'}, {'live': False}, {'live': None}, {'generation': 'wrong'}):
            s = standby(); s['queue'].update(patch); cases.append(s)
        for s in cases:
            with self.subTest(status=s):
                r = self.run_case([s])
                self.assertFalse(r['report']['notApplicable'])
                self.assertIsNone(r['report']['error'], 'unknown advisory input must not terminate the first wait')

    def test_singleton_arrays_cannot_masquerade_as_objects_or_scalars(self):
        cases = [[standby()]]
        for key in ('node', 'executor', 'queue'):
            s = standby(); s[key] = [s[key]]; cases.append(s)
        s = standby(); s['node']['probe'] = [s['node']['probe']]; cases.append(s)
        for path in (('contract',), ('writtenAt',), ('node', 'name'), ('node', 'source'), ('node', 'mode'),
                     ('node', 'probe', 'at'), ('node', 'probe', 'result'), ('node', 'probe', 'failures'),
                     ('node', 'probe', 'failingSince'), ('queue', 'generation'), ('queue', 'live'),
                     ('executor', 'state'), ('halt',), ('current',)):
            s = standby(); target = s
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = [target[path[-1]]]
            if path == ('writtenAt',):
                s['_preserveWrittenAt'] = True
            cases.append(s)
        row = {'pr': 1057, 'headSha': 'a' * 40, 'baseSha': 'b' * 40, 'state': 'DONE'}
        for key in ('pr', 'headSha', 'baseSha', 'state'):
            s = standby(); malformed = dict(row); malformed[key] = [malformed[key]]
            s['pending'] = [malformed]; cases.append(s)
        s = standby(); s['pending'] = [[row]]; cases.append(s)
        for s in cases:
            with self.subTest(status=s):
                r = self.run_case([s])
                self.assertFalse(r['report']['notApplicable'])
                self.assertIsNone(r['report']['error'])

    def test_role_and_work_are_rechecked_on_each_poll(self):
        first = standby(); first['node']['mode'] = 'UNCERTAIN'
        r = self.run_case([first, standby()])
        self.assertEqual(r['firstIterations'], 2)
        self.assertTrue(r['report']['notApplicable'])
        held = standby(); held['node']['mode'] = 'ACTIVE'; held['node']['probe']['result'] = 'held'
        r = self.run_case([first, held])
        self.assertEqual(r['firstIterations'], 2)
        self.assertFalse(r['report']['notApplicable'])

    def test_carried_fresh_same_source_view_requires_a_new_post_start_refresh(self):
        carried = standby(); carried['_preserveWrittenAt'] = True
        r = self.run_case([carried])
        self.assertFalse(r['report']['notApplicable'])
        self.assertIsNone(r['report']['error'])
        r = self.run_case([carried, standby()])
        self.assertEqual(r['firstIterations'], 2)
        self.assertTrue(r['report']['notApplicable'])

    def test_halt_has_priority_and_still_runs_runner_quiet(self):
        s = standby(); s['halt'] = {'code': 'FIXTURE_HALT'}
        r = self.run_case([s])
        self.assertFalse(r['report']['notApplicable'])
        self.assertTrue(r['report']['halted'])
        self.assertTrue(r['report']['observed'])
        self.assertTrue(r['report']['runnerQuiet'])
        self.assertEqual(r['waits'], [1500, 900])
        self.assertEqual(r['sleeps'], [5])

    def test_not_applicable_never_bypasses_either_runner_safety_condition(self):
        for kwargs in ({'original_binary': False}, {'stopped_pid0': False},
                       {'quiet_status': dict(standby(), executor={'state': 'RUNNING'})}):
            with self.subTest(kwargs=kwargs):
                r = self.run_case(**kwargs)
                self.assertTrue(r['report']['notApplicable'])
                self.assertFalse(r['report']['runnerQuiet'])
                self.assertEqual(r['done'], ['runner-not-quiet-verify-skipped'])
                self.assertEqual(r['waits'], [1500, 900])


if __name__ == '__main__':
    unittest.main()
