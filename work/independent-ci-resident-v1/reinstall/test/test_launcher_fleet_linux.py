"""The generic node package's Linux steps inside the launcher (rollout/fleet/BATCH1-INTERFACES.md section 4): the template's own
functions run in Windows PowerShell 5.1 with fake Linux runs. Nothing is elevated, no registrar and no WSL runs, nothing outside a
temporary directory is written."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'launcher' / 'template.ps1'
GENERATE = ROOT / 'launcher' / 'generate.py'
POWERSHELL = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
SOURCE, LINUX_MANIFEST, PACKAGE = 'a' * 64, 'b' * 64, 'c' * 64
WSL_OUT = '/mnt/d/w/fleet/linux-out'
DRIVER = r'''
param([string]$Template, [string]$Case, [string]$Work)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'PARSE_FAILED' }
foreach ($name in @('Sha256Bytes', 'Write-New', 'Write-Json', 'Get-Key', 'Parse-Json', 'Parse-LastLine', 'Tail', 'Get-FileSha', 'Test-FleetLinuxOutput', 'Get-FleetOutFile',
    'ConvertFrom-FleetRootRunLine', 'Test-FleetRun', 'Get-FleetRunReport', 'Read-FleetFileChecked', 'Test-FleetRefusedBeforeAnyChange', 'Set-FleetW1PauseKept', 'Step-LinuxRoot')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw ('FUNCTION_MISSING_OR_DUPLICATED:' + $name) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$U8 = New-Object Text.UTF8Encoding($false); $Strict8 = New-Object Text.UTF8Encoding($false, $true)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Done = New-Object Collections.Generic.List[string]
$Out = Join-Path $Work 'launch'; $Stage = Join-Path $Work 'stage'; $FleetOutDir = Join-Path $Work 'out'
foreach ($d in @($Out, $Stage, $FleetOutDir)) { [void][IO.Directory]::CreateDirectory($d) }
$CiSourceManifestSha256 = $c.source; $PackageManifestSha256 = $c.package; $FleetLinuxManifestSha256 = $c.linuxManifest
$FleetWslOutDir = $c.wslOut; $FleetCompanionAccount = [bool]$c.companion; $FleetDistribution = 'D'; $FleetPlanSha256 = ('d' * 64)
if ($c.mode -ceq 'lines') { @($c.lines | ForEach-Object { ConvertFrom-FleetRootRunLine $_ }) | ConvertTo-Json -Compress -Depth 4; return }
if ($c.mode -ceq 'codes') { $o = [ordered]@{}; foreach ($x in $c.codes) { $o[$x] = (Test-FleetRefusedBeforeAnyChange $x) }; $o | ConvertTo-Json -Compress; return }
if ($c.mode -ceq 'rules') { $codes = Test-FleetLinuxOutput $c.evidence $c.facts; [ordered]@{ codes = @($codes) } | ConvertTo-Json -Compress; return }
foreach ($f in $c.files.PSObject.Properties) { [IO.File]::WriteAllBytes((Join-Path $FleetOutDir $f.Name), $U8.GetBytes([string]$f.Value)) }
$calls = New-Object Collections.Generic.List[string]
function Stop-Launch([string]$code, $detail) { $script:stopped = $code; throw $code }
function Set-FleetLinuxDirectories { $calls.Add('directories') }
function Step-LinuxOutAclProbe([string]$registrar) { $calls.Add('probe:' + $registrar); [ordered]@{ failed = @() } }
function Read-FleetOutFile([string]$leaf, $run, [string]$registrar, [int]$max) { $calls.Add('read:' + $run.name + ':' + $(if ($registrar) { 'captured' } else { 'direct' })); , (Read-FleetFileChecked $FleetOutDir $leaf $max) }
$W1Restore = [ordered]@{ armed = $true; result = $null }
function New-FleetRegistrar { $calls.Add('build'); [ordered]@{ directory = 'fake-build'; exe = 'fake-registrar.exe'; sha256 = ('e' * 64) } }
function Remove-FleetRegistrar($build) { $calls.Add('remove:' + $(if ($build) { $build.directory } else { 'none' })) }
function Invoke-FleetLinuxScript([string]$name, [string]$registrar) {
  $calls.Add('run:' + $name + ':' + $(if ($registrar) { $registrar } else { 'direct' }))
  $r = $c.runs.$name
  [ordered]@{ name = $name; directory = ('run-' + $name); outcome = [string]$r.outcome; exit = $r.exit; code = $(if ($r.PSObject.Properties['code']) { [string]$r.code } else { $null }); captureRefused = $(if ($r.PSObject.Properties['captureRefused']) { [string]$r.captureRefused } else { $null }); stdout = [string]$r.stdout; stderrTail = $null; registrarStderr = $null; seconds = 1 }
}
$script:stopped = $null; $result = $null
try { $result = Step-LinuxRoot } catch { if (-not $script:stopped) { throw } }
$staged = Join-Path $Stage 'linux-version-facts.phase-B.json'
[ordered]@{ stopped = $script:stopped; calls = @($calls); done = @($Done); result = $result; armed = $W1Restore.armed; w1 = $W1Restore.result; stagedSha256 = (Get-FileSha $staged)
  report = $(if ([IO.File]::Exists((Join-Path $Out 'linux-report.json'))) { Get-Content -LiteralPath (Join-Path $Out 'linux-report.json') -Raw | ConvertFrom-Json } else { $null }) } | ConvertTo-Json -Compress -Depth 8
'''
EVIDENCE = ('source: reinstall-linux-B (root, Owner)\npackage: %s\ncapturedAt: 2026-11-12T10:00:00Z\n'
            'command: /usr/bin/sha256sum /etc/clued-independent-ci/formal-source-manifest-v2.json\nexit: 0\nsha256: %s\n' % (PACKAGE, SOURCE))
FACTS = {'contract': 'clued.independent-ci.linux-version-facts/1', 'generation': 1, 'staged': None, 'ciSourceManifestSha256': SOURCE,
         'manifestSha256': LINUX_MANIFEST, 'pinsOk': True, 'sourceCommit': 'f' * 40}
E_NAME, F_NAME = 'linux-live-manifest.20261112T100000Z.txt', 'linux-version-facts.20261112T100000Z.json'
A_OK = {'outcome': 'EXITED', 'exit': 0, 'stdout': '{"status":"ROOT_STAGING_VERIFIED"}\n{"status":"PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED","phaseAManifestSha256":"%s"}\n' % ('1' * 64)}


def b_done(evidence=WSL_OUT + '/' + E_NAME, facts=WSL_OUT + '/' + F_NAME):
    return {'outcome': 'EXITED', 'exit': 0, 'stdout': 'moved x\n' + json.dumps({'status': 'LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1', 'evidence': evidence, 'versionFacts': facts}) + '\n'}


B_FAILED = {'outcome': 'EXITED', 'exit': 1, 'stdout': '{"status":"REFUSED","code":"RESIDENT_INSTALL_FAILED_SEE_RECOVERY"}\n'}
TIMEOUT = {'outcome': 'TIMEOUT', 'exit': None, 'stdout': ''}


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class FleetLinuxSteps(unittest.TestCase):
    def drive(self, **case):
        base = {'mode': 'step', 'source': SOURCE, 'package': PACKAGE, 'linuxManifest': LINUX_MANIFEST, 'wslOut': WSL_OUT, 'companion': True,
                'files': {E_NAME: EVIDENCE, F_NAME: json.dumps(FACTS)}, 'runs': {'A': A_OK, 'B': b_done()}}
        base.update(case)
        with tempfile.TemporaryDirectory(prefix='fleet-launch-') as directory:
            root = Path(directory)
            (root / 'driver.ps1').write_text(DRIVER, encoding='utf-8')
            (root / 'case.json').write_text(json.dumps(base), encoding='utf-8')
            result = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'), str(TEMPLATE), str(root / 'case.json'), str(root / 'work')],
                                    capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_a_then_b_then_the_output_by_rule_as_the_companion_account(self):
        r = self.drive()
        self.assertIsNone(r['stopped'])
        self.assertEqual(r['calls'], ['directories', 'build', 'probe:fake-registrar.exe', 'run:A:fake-registrar.exe', 'run:B:fake-registrar.exe', 'read:B:captured', 'read:B:captured', 'remove:fake-build'])
        self.assertFalse(r['armed'])   # phase A was started: a later stop no longer lifts the W1 pause
        self.assertEqual(r['done'], ['linux-A', 'linux-B', 'linux-output-checked'])
        facts_sha = hashlib.sha256(json.dumps(FACTS).encode()).hexdigest()
        self.assertEqual((r['result']['factsSha256'], r['stagedSha256']), (facts_sha, facts_sha))   # verify gets exactly the checked bytes, from the staging
        self.assertTrue(r['result']['factsSource'].endswith('\\stage\\linux-version-facts.phase-B.json'))
        self.assertEqual(r['report']['codes'], [])

    def test_a_node_without_a_companion_account_builds_no_registrar(self):
        r = self.drive(companion=False)
        self.assertIsNone(r['stopped'])
        self.assertEqual(r['calls'], ['directories', 'run:A:direct', 'run:B:direct', 'read:B:direct', 'read:B:direct', 'remove:none'])   # no probe: the elevated Owner runs the scripts itself

    def test_a_failed_b_is_resumed_exactly_once(self):
        r = self.drive(runs={'A': A_OK, 'B': B_FAILED, 'BResume': b_done()})
        self.assertIsNone(r['stopped'])
        self.assertEqual([c for c in r['calls'] if c.startswith('run:')], ['run:A:fake-registrar.exe', 'run:B:fake-registrar.exe', 'run:BResume:fake-registrar.exe'])
        r = self.drive(runs={'A': A_OK, 'B': B_FAILED, 'BResume': B_FAILED})
        self.assertEqual(r['stopped'], 'LINUX_PHASE_B_NOT_COMPLETED')
        self.assertEqual([c for c in r['calls'] if c.startswith('run:')].count('run:BResume:fake-registrar.exe'), 1)
        self.assertEqual(r['calls'][-1], 'remove:fake-build')   # the registrar build never stays behind
        refused = self.drive(runs={'A': {'outcome': 'REFUSED', 'exit': None, 'stdout': '', 'code': 'ROOT_RUN_SCRIPT_SHA256_MISMATCH'}, 'B': b_done()})
        self.assertEqual((refused['stopped'], refused['armed'], refused['w1']), ('LINUX_PHASE_A_NOT_COMPLETED', True, None))   # refused before any change: the pause will be lifted
        # refused AFTER the password change (the task left parked, an unreadable exit): the companion task is not known to be as reviewed; the pause stays
        for code in ('ROOT_RUN_TASK_NOT_UPDATED_PARKED', 'ROOT_RUN_TASK_NOT_UPDATED_PARK_FAILED', 'ROOT_RUN_EXIT_UNREADABLE', 'ROOT_RUN_NOT_STARTED', 'ACCOUNT_PASSWORD_NOT_SET', 'ROOT_RUN_READBACK_MISMATCH', 'REGISTRAR_UNEXPECTED'):
            parked = self.drive(runs={'A': {'outcome': 'REFUSED', 'exit': None, 'stdout': '', 'code': code}, 'B': b_done()})
            self.assertEqual((parked['stopped'], parked['armed'], parked['w1']['restored'], parked['w1']['reason']), ('LINUX_PHASE_A_NOT_COMPLETED', False, False, 'NOT_LIFTED:PHASE_A_' + code), code)
        self.assertFalse(self.drive(runs={'A': {'outcome': 'EXITED', 'exit': 1, 'stdout': '{"status":"REFUSED"}\n'}, 'B': b_done()})['armed'])
        self.assertIsNone(r['stagedSha256'])

    def test_exit_zero_without_the_final_status_is_not_done(self):
        quiet = {'outcome': 'EXITED', 'exit': 0, 'stdout': '{"status":"SOMETHING_ELSE"}\n'}
        self.assertEqual(self.drive(runs={'A': quiet, 'B': b_done()})['stopped'], 'LINUX_PHASE_A_NOT_COMPLETED')
        r = self.drive(runs={'A': A_OK, 'B': quiet, 'BResume': b_done()})
        self.assertEqual((r['stopped'], [c for c in r['calls'] if c.startswith('run:')]), ('LINUX_PHASE_B_NOT_COMPLETED', ['run:A:fake-registrar.exe', 'run:B:fake-registrar.exe']))
        # the resume only after a B that ran and exited non-zero: a refused or unreadable B is never resumed over
        for b in ({'outcome': 'REFUSED', 'exit': None, 'stdout': ''}, {'outcome': 'UNREADABLE', 'exit': None, 'stdout': ''}):
            r = self.drive(runs={'A': A_OK, 'B': b, 'BResume': b_done()})
            self.assertEqual((r['stopped'], [c for c in r['calls'] if c.startswith('run:')]), ('LINUX_PHASE_B_NOT_COMPLETED', ['run:A:fake-registrar.exe', 'run:B:fake-registrar.exe']))

    def test_output_that_could_not_be_captured_is_not_a_failed_phase(self):
        captured = lambda: {'outcome': 'EXITED', 'exit': 0, 'stdout': '', 'captureRefused': 'ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME'}
        r = self.drive(runs={'A': A_OK, 'B': captured(), 'BResume': b_done()})   # B ran and exited; whether it completed is for the continuation to capture and check
        self.assertEqual((r['stopped'], [c for c in r['calls'] if c.startswith('run:')], r['done']), ('LINUX_PHASE_B_OUTPUT_NOT_CAPTURED', ['run:A:fake-registrar.exe', 'run:B:fake-registrar.exe'], ['linux-A']))
        self.assertEqual((r['report']['runs'][-1]['name'], r['report']['runs'][-1]['outcome'], r['report']['runs'][-1]['captureRefused']), ('B', 'EXITED', 'ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME'))
        r = self.drive(runs={'A': A_OK, 'B': B_FAILED, 'BResume': captured()})
        self.assertEqual((r['stopped'], r['report']['runs'][-1]['name']), ('LINUX_PHASE_B_OUTPUT_NOT_CAPTURED', 'BResume'))
        r = self.drive(runs={'A': captured(), 'B': b_done()})
        self.assertEqual((r['stopped'], [c for c in r['calls'] if c.startswith('run:')], r['armed']), ('LINUX_PHASE_A_OUTPUT_NOT_CAPTURED', ['run:A:fake-registrar.exe'], False))

    def test_only_refusals_before_any_change_lift_the_pause(self):
        before = ['REGISTRAR_ARGS_REFUSED', 'REGISTRAR_ELEVATION_REQUIRED', 'NODE_PROFILE_UNREADABLE', 'COMPANION_ACCOUNT_MISSING', 'COMPANION_ACCOUNT_IS_ADMINISTRATOR', 'WSL_MACHINE_CLIENT_SIGNATURE_INVALID', 'ROOT_RUN_SCRIPT_SHA256_MISMATCH',
                  'ROOT_RUN_SCRIPT_MISSING', 'ROOT_RUN_DIRECTORY_MISSING', 'ROOT_RUN_PATH_REPARSE_REFUSED', 'TASK_FOLDER_MISSING', 'COMPANION_SWITCH_IN_PROGRESS', 'COMPANION_TASK_MISSING', 'COMPANION_TASK_NOT_PASSWORD', 'ROOT_RUN_TASK_DEFINITION_DIFFERS']
        after = ['ROOT_RUN_TASK_NOT_UPDATED_PARKED', 'ROOT_RUN_TASK_NOT_UPDATED_PARK_FAILED', 'ACCOUNT_PASSWORD_NOT_SET', 'REGISTER_FAILED', 'ROOT_RUN_READBACK_MISMATCH', 'ROOT_RUN_NOT_STARTED', 'ROOT_RUN_EXIT_UNREADABLE',
                 'ROOT_RUN_OUTPUT_IS_A_LINK', 'ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME', 'ROOT_RUN_CAPTURE_NOT_WRITTEN', 'REGISTRAR_UNEXPECTED', '', 'ROOT_RUN_SCRIPT_MISSING extra', 'xCOMPANION_TASK_MISSING']
        got = self.drive(mode='codes', codes=before + after)
        self.assertEqual(got, dict([(c, True) for c in before] + [(c, False) for c in after]))
        # every code the registrar prints before it sets a password is in that list, and none it prints after
        registrar = (ROOT.parent / 'windows' / 'CompanionTaskRegistrar.cs').read_text(encoding='utf-8')
        steps = registrar.split('static int RegisterAccountSteps', 1)[1]
        head, rest = steps.split('step = "random";', 1)
        printed = lambda text: set(re.findall(r'Print\("([A-Z_0-9]+)"', text))
        head_codes = printed(head) - {'IMPORT_ARGUMENTS_REFUSED'}   # (register-account's own argument check: root-run never takes that branch)
        self.assertTrue(head_codes and all(self.drive(mode='codes', codes=sorted(head_codes)).values()), head_codes)
        rest_codes = printed(rest.split('static int PrepareAccount', 1)[0])
        self.assertTrue({'ROOT_RUN_NOT_STARTED', 'ROOT_RUN_EXIT_UNREADABLE', 'ROOT_RUN_READBACK_MISMATCH'} <= rest_codes); self.assertFalse(any(self.drive(mode='codes', codes=sorted(rest_codes)).values()), rest_codes)

    def test_a_failed_a_never_reaches_b(self):
        for a in ({'outcome': 'EXITED', 'exit': 1, 'stdout': '{"status":"REFUSED","code":"LINUX_UNITS_ACTIVE"}\n'}, {'outcome': 'REFUSED', 'exit': None, 'stdout': ''}, {'outcome': 'UNREADABLE', 'exit': None, 'stdout': ''}):
            r = self.drive(runs={'A': a, 'B': b_done()})
            self.assertEqual(r['stopped'], 'LINUX_PHASE_A_NOT_COMPLETED')
            self.assertEqual([c for c in r['calls'] if c.startswith('run:')], ['run:A:fake-registrar.exe'])

    def test_a_timeout_stops_and_runs_nothing_more(self):
        r = self.drive(runs={'A': TIMEOUT, 'B': b_done()})
        self.assertEqual((r['stopped'], [c for c in r['calls'] if c.startswith('run:')]), ('LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', ['run:A:fake-registrar.exe']))
        r = self.drive(runs={'A': A_OK, 'B': TIMEOUT, 'BResume': b_done()})   # a B still running is never resumed over
        self.assertEqual((r['stopped'], [c for c in r['calls'] if c.startswith('run:')]), ('LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', ['run:A:fake-registrar.exe', 'run:B:fake-registrar.exe']))
        r = self.drive(runs={'A': A_OK, 'B': B_FAILED, 'BResume': TIMEOUT})
        self.assertEqual(r['stopped'], 'LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED')

    def test_b_output_must_be_named_files_directly_in_the_out_directory(self):
        for evidence, facts in (('/mnt/d/w/other/' + E_NAME, WSL_OUT + '/' + F_NAME), (WSL_OUT + '/../linux-out/' + E_NAME, WSL_OUT + '/' + F_NAME), (WSL_OUT + '/sub/' + E_NAME, WSL_OUT + '/' + F_NAME),
                                (WSL_OUT + '/' + E_NAME, WSL_OUT + '/facts.json'), (WSL_OUT + '/' + F_NAME, WSL_OUT + '/' + F_NAME), ('', '')):
            r = self.drive(runs={'A': A_OK, 'B': b_done(evidence, facts)})
            self.assertEqual(r['stopped'], 'LINUX_OUTPUT_PATHS_NOT_IN_THE_OUT_DIRECTORY', (evidence, facts))
        r = self.drive(files={E_NAME: EVIDENCE})   # the named facts file is not there
        self.assertEqual(r['stopped'], 'LINUX_OUTPUT_UNREADABLE')

    def test_output_that_breaks_a_rule_stops_before_the_windows_side(self):
        r = self.drive(files={E_NAME: EVIDENCE.replace(SOURCE, 'e' * 64), F_NAME: json.dumps(FACTS)})
        self.assertEqual((r['stopped'], r['report']['codes'], r['stagedSha256']), ('LIVE_LINUX_SOURCE_NOT_THIS_RECORD', ['LIVE_LINUX_SOURCE_NOT_THIS_RECORD'], None))
        self.assertNotIn('linux-output-checked', r['done'])

    def rules(self, evidence=EVIDENCE, facts=None, raw=None):
        return self.drive(mode='rules', evidence=evidence, facts=raw if raw is not None else json.dumps(FACTS if facts is None else facts))['codes']

    def test_the_rules_of_the_evidence(self):
        self.assertEqual(self.rules(), [])
        self.assertEqual(self.rules(evidence=EVIDENCE.replace('\n', '\r\n')), ['LINUX_EVIDENCE_UNPARSABLE', 'LINUX_ADOPTED_ANOTHER_PACKAGE'])   # bash writes LF; anything else is not B's file
        for bad, code in ((EVIDENCE + 'sha256: ' + SOURCE + '\n', 'LINUX_EVIDENCE_UNPARSABLE'), (EVIDENCE.replace('exit: 0', 'exit: 1'), 'LINUX_EVIDENCE_UNPARSABLE'),
                          (EVIDENCE.replace('sha256: ', 'sha256:  '), 'LINUX_EVIDENCE_UNPARSABLE'), (EVIDENCE.replace('exit: 0\n', ''), 'LINUX_EVIDENCE_UNPARSABLE'),
                          (EVIDENCE.replace(SOURCE, SOURCE.upper()), 'LINUX_EVIDENCE_UNPARSABLE'), (EVIDENCE.replace(SOURCE, 'e' * 64), 'LIVE_LINUX_SOURCE_NOT_THIS_RECORD'),
                          (EVIDENCE.replace(PACKAGE, 'e' * 64), 'LINUX_ADOPTED_ANOTHER_PACKAGE'), (EVIDENCE + 'package: ' + PACKAGE + '\n', 'LINUX_ADOPTED_ANOTHER_PACKAGE'),
                          (EVIDENCE.replace('package: ' + PACKAGE + '\n', ''), 'LINUX_ADOPTED_ANOTHER_PACKAGE'), ('', 'LINUX_EVIDENCE_UNPARSABLE')):
            self.assertIn(code, self.rules(evidence=bad), bad)

    def test_the_rules_of_the_version_facts(self):
        def changed(**kw):
            d = dict(FACTS); d.update(kw); return d
        without = lambda k: {x: v for x, v in FACTS.items() if x != k}
        for bad in (changed(generation=2), changed(generation='1'), changed(generation=True), changed(staged={'generation': 2}), changed(staged=False), without('staged'),
                    changed(ciSourceManifestSha256='e' * 64), changed(manifestSha256='e' * 64), changed(pinsOk=False), changed(pinsOk='true'), changed(pinsOk=1), without('pinsOk'),
                    changed(contract='clued.independent-ci.linux-version-facts/2'), without('contract'), without('generation')):
            self.assertEqual(self.rules(facts=bad), ['LINUX_VERSION_FACTS_NOT_THIS_PACKAGE'], bad)
        self.assertEqual(self.rules(raw=json.dumps(FACTS).replace('"generation": 1,', '"generation": 1.0,')), ['LINUX_VERSION_FACTS_NOT_THIS_PACKAGE'])
        for raw in ('', 'not json', '[]', '"x"', 'null'):
            self.assertEqual(self.rules(raw=raw), ['LINUX_VERSION_FACTS_UNREADABLE'], raw)

    def test_the_registrar_line_is_exactly_one_known_line(self):
        lines = ['ROOT_RUN_EXITED 0', 'ROOT_RUN_EXITED 1\r\n', 'ROOT_RUN_TIMEOUT', 'ROOT_RUN_REFUSED ROOT_RUN_SCRIPT_SHA256_MISMATCH', '', 'ROOT_RUN_EXITED 0\nROOT_RUN_EXITED 0', 'ROOT_RUN_EXITED -1',
                 'ROOT_RUN_EXITED', 'ROOT_RUN_REFUSED lower', 'x ROOT_RUN_EXITED 0', '{"code":"REGISTERED"}', 'ROOT_RUN_EXITED 4294967295']
        two = self.drive(mode='lines', lines=['ROOT_RUN_EXITED 0\r\nCAPTURE_REFUSED ROOT_RUN_OUTPUT_IS_A_LINK\r\n', 'ROOT_RUN_EXITED 3\nCAPTURE_REFUSED ROOT_RUN_OUTPUT_TOO_LARGE', 'ROOT_RUN_TIMEOUT\nCAPTURE_REFUSED X',
                                               'ROOT_RUN_EXITED 0\nCAPTURE_REFUSED lower', 'CAPTURE_REFUSED X\nROOT_RUN_EXITED 0', 'ROOT_RUN_EXITED 0\nCAPTURE_REFUSED X\nCAPTURE_REFUSED Y'])
        self.assertEqual([(g['outcome'], g['exit'], g['captureRefused']) for g in two], [('EXITED', 0, 'ROOT_RUN_OUTPUT_IS_A_LINK'), ('EXITED', 3, 'ROOT_RUN_OUTPUT_TOO_LARGE')] + [('UNREADABLE', None, None)] * 4)
        got = self.drive(mode='lines', lines=lines)
        self.assertEqual([(g['outcome'], g['exit'], g['code']) for g in got],
                         [('EXITED', 0, None), ('EXITED', 1, None), ('TIMEOUT', None, None), ('REFUSED', None, 'ROOT_RUN_SCRIPT_SHA256_MISMATCH')] + [('UNREADABLE', None, None)] * 7 + [('EXITED', 4294967295, None)])


class FleetPins(unittest.TestCase):
    def test_every_fleet_value_the_template_reads_is_a_generator_pin(self):
        template, generator = TEMPLATE.read_text(encoding='utf-8'), GENERATE.read_text(encoding='utf-8')
        pinned = set(re.findall(r"'\$(Fleet\w+) = ", generator))
        self.assertEqual(set(re.findall(r'\$(Fleet[A-Za-z0-9]+)', template)), pinned)
        self.assertIn('FleetPlanSha256', pinned)

    def test_the_linux_steps_come_after_the_staging_and_before_anything_of_the_windows_side(self):
        main = TEMPLATE.read_text(encoding='utf-8').split('#region main', 1)[1]
        order = [main.index(x) for x in ('$Stage = Step-Stage', 'if ($FleetPlanSha256) {', 'Step-WindowsPreflightBeforeLinux', '$fileLocks = Step-FileLocks', '$linux = Step-LinuxRoot',
                                         '$LinuxVersionFactsSource = $linux.factsSource; $LinuxVersionFactsSha256 = $linux.factsSha256', '  Step-UninstallPreflight', '$quiesce = Step-Quiesce', '$uninstall = Step-Uninstall',
                                         '$install = Step-Install', '$verify = ', 'Step-CompanionHeadless')]
        self.assertEqual(order, sorted(order))
        self.assertEqual(main.count('Step-LinuxRoot'), 1)

    def test_the_read_only_windows_preflight_runs_before_linux_and_again_in_full_after_it(self):
        template = TEMPLATE.read_text(encoding='utf-8')
        early = template.split('function Step-WindowsPreflightBeforeLinux', 1)[1].split('\nfunction ', 1)[0]
        late = template.split('function Step-UninstallPreflight', 1)[1].split('\nfunction ', 1)[0]
        for code in ('INSTALLED_RECEIPT_NOT_AS_REVIEWED', 'INSTALLED_UNINSTALL_NOT_AS_REVIEWED', 'INSTALLED_HALT_NOT_AS_REVIEWED', 'RUNNER_SERVICE_NOT_AS_REVIEWED', 'UNINSTALL_PLAN_REFUSED',
                     'PLAN_FIELDS_WOULD_DIFFER_AFTER_UNINSTALL', 'CARRY_FORWARD_PREVIEW_REFUSED', 'CONTROLLER_SERVICE_LOGON_RIGHT_NOT_CONFIRMED', 'Test-OldRootQuiet', 'Test-CurrentRootCarryShape', 'Test-SecretsAsVerify'):
            self.assertIn(code, early, code); self.assertIn(code, late, code)
        # read-only, and its files never take the names the full preflight (and resume.py) use
        for word in ('-Apply', 'Stop-Process', 'Stop-CompanionTask', '& $Sc stop', 'SetAccessControl', "'uninstall-preflight-report.json'", "'uninstall.dry-run.before-quiesce'", "'install.dry-run.carry-preview'", 'before-uninstall'):
            self.assertNotIn(word, early, word)
        self.assertIn("Get-InstallArgs -NoHeartbeat", early)   # the installer's -PreviewAfterUninstall dry run
        self.assertIn("'  Step-UninstallPreflight\n  $parentAcl = Step-ParentAcl   # r4.1 C2\n  $quiesce = Step-Quiesce\n  $uninstall = Step-Uninstall\n'".strip("'").encode().decode('unicode_escape'), template)

    def test_both_ways_run_the_script_with_the_registrars_command_line(self):
        template = TEMPLATE.read_text(encoding='utf-8')
        registrar = (ROOT.parent / 'windows' / 'CompanionTaskRegistrar.cs').read_text(encoding='utf-8')
        fixed = ' --user root --exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc '
        self.assertEqual((template.count(fixed), registrar.count('"' + fixed.rstrip() + ' "')), (1, 1))
        self.assertIn("'root-run ' + $ResidentRoot + ' ' + $run.script + ' ' + $run.sha256 + ' ' + $run.out + ' ' + $run.timeoutSeconds", template)
        # a timeout never kills, on either way
        body = template.split('function Invoke-FleetProcess', 1)[1].split('\nfunction ', 1)[0]
        self.assertNotIn('Kill', body); self.assertNotIn('Stop-Process', body)


@unittest.skipUnless(os.name == 'nt', 'generate.py reads Windows paths and the service control manager')
class FleetPlanChecks(unittest.TestCase):
    """generate.py --fleet-plan up to the point where it reads the host: the plan must be this package's and the scripts the planned
    package-run scripts. Run from a copy of reinstall/ whose LIVE_ROOT is a fixture directory (the real one is a constant); a plan that
    passes every check gets as far as the runner service of the fixture profile, which no host has."""
    OWNER, CONTROL, OPERATOR = 'S-1-5-21-1-2-3-1008', 'S-1-5-21-1-2-3-1007', 'S-1-5-21-1-2-3-1001'
    CI = 'source/work/actions-hosted-migration/independent-ci-v1/src/resident-v2/'

    def setUp(self):
        import shutil
        self.tmp = tempfile.TemporaryDirectory(prefix='fp'); self.addCleanup(self.tmp.cleanup)
        d = self.d = Path(self.tmp.name)
        shutil.copytree(ROOT, d / 'x' / 'R' / 'reinstall', ignore=shutil.ignore_patterns('test', '__pycache__'))
        self.generate = d / 'x' / 'R' / 'reinstall' / 'launcher' / 'generate.py'
        text = self.generate.read_text(encoding='utf-8')
        live = "LIVE_ROOT = BS.join(['C:', 'ProgramData', 'CluedIndependentCI', 'resident'])"
        self.assertEqual(text.count(live), 1)
        self.live = d / 'live'; (self.live / 'install').mkdir(parents=True)
        self.generate.write_text(text.replace(live, 'LIVE_ROOT = ' + repr(str(self.live))), encoding='utf-8')
        self.commit = '1' * 40
        self.pkg = d / 'pkg'
        self.node = {'nodeName': 'node-a', 'hostname': 'NODE-A', 'ownerSid': self.OWNER, 'controllerSid': self.CONTROL, 'runnerService': 'clued-fixture-no-such-service', 'wslDistribution': 'D'}
        self.files = {'resident/windows/install-resident.ps1': b"$OriginalBinary = '\"C:\\r\\RunnerService.exe\"'\n", 'resident/windows/verify-resident.ps1': b'v', self.CI + 'migrate-acl.ps1': b'm', self.CI + 'acl-model.json': b'{}',
                      'resident/windows/companion-headless.ps1': b'function New-CompanionBuildFromPackage([string]$root) { }\n', 'resident/windows/CompanionTaskRegistrar.cs': b'ParseRootRun(string[] args)\n',
                      'linux/manifest.json': b'{"contract":"x","files":[]}', 'record/source-manifest.json': json.dumps({'sourceSha': self.commit}).encode(), 'record/acceptance.json': json.dumps({'node': self.node}).encode()}
        self.ind, self.out = d / 'in', Path('C:/ProgramData/CluedIndependentCI') / ('reinstall-linux-out-' + '4' * 32)
        self.old_manifest = '6' * 64
        self.scripts = {k: self.script() for k in ('A', 'B', 'BResume')}

    def wsl(self, p):
        p = str(p); return '/mnt/' + p[0].lower() + p[2:].replace(chr(92), '/')

    def script(self, out=None, draft=0, extra=''):
        old = ('OLD_MANIFEST=%s\nOLD_LINUX_RES_MANIFEST=%s\nOLD_GENERATION=3\nrefuse INSTALLED_MANIFEST_NOT_SOURCE34\nrefuse LINUX_RESIDENT_MANIFEST_NOT_THE_INSTALLED_R5C2\n'
               'refuse OLD_VERSION_FACTS_NOT_THE_INSTALLED_GENERATION\n' % ('5' * 64, self.old_manifest))
        return ('#!/bin/bash\nDRAFT=%d\nW=%s\nO=%s\nBASE=/root/x\n%s%s' % (draft, self.wsl(self.ind), self.wsl(out or self.out), old, extra)).encode()

    def run_plan(self, change=None, argv=(), check=False):
        sha = lambda b: hashlib.sha256(b).hexdigest()
        for rel, data in self.files.items():
            (self.pkg / rel).parent.mkdir(parents=True, exist_ok=True); (self.pkg / rel).write_bytes(data)
        manifest = {'contract': 'clued.independent-ci.resident-package/4', 'ciSourceManifestSha256': sha(self.files['record/source-manifest.json']), 'linux': {'manifestSha256': sha(self.files['linux/manifest.json'])},
                    'files': [{'path': rel, 'sha256': sha(data), 'target': rel.replace('/', chr(92))} for rel, data in self.files.items()]}
        (self.pkg / 'package-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        pkg_sha = sha((self.pkg / 'package-manifest.json').read_bytes())
        (self.d / 'linux').mkdir(exist_ok=True)
        entries = {}
        for k, data in self.scripts.items():
            path = self.d / 'linux' / (k + '.sh'); path.write_bytes(data); entries[k] = {'path': str(path), 'sha256': sha(data)}
        plan = {'contract': 'clued.independent-ci.fleet-node-install-plan/1', 'node': 'node-a', 'version': '2026.11.12-11111111', 'archive_sha256': 'a' * 64, 'commit': self.commit,
                'packageDir': str(self.pkg), 'packageManifestSha256': pkg_sha, 'ciSourceManifestSha256': manifest['ciSourceManifestSha256'], 'linuxManifestSha256': manifest['linux']['manifestSha256'],
                'companionAccount': False, 'linux': {'distribution': 'D', 'inDir': str(self.ind), 'wslInDir': self.wsl(self.ind), 'outDir': str(self.out), 'scripts': entries, 'timeoutSeconds': {'A': 1800, 'B': 7200}},
                'secrets': {'source': 'installed', 'upgradeToken': {'target': str(self.live / 'secrets' / 'resident-upgrade.token'), 'fingerprint': '7' * 64}, 'heartbeatToken': None},
                'expectedInstalledLinux': {'generation': 3, 'manifestSha256': '6' * 64, 'ciSourceManifestSha256': '5' * 64},
                'reasons': {'pause': 'fleet-node-reinstall-x', 'rearm': 'fleet-node-reinstall-x', 'w1Pause': 'fleet-node-reinstall-x-w1'}, 'launcher': None,
                'w1Paused': None if check else {'sha256': '3' * 64, 'reason': 'fleet-node-reinstall-x-w1'},
                'expectedLinux': {'generation': 1, 'ciSourceManifestSha256': manifest['ciSourceManifestSha256'], 'manifestSha256': manifest['linux']['manifestSha256'], 'packageManifestSha256': pkg_sha}}
        if change:
            change(plan)
        (self.d / 'install-plan.json').write_text(json.dumps(plan), encoding='utf-8')
        p = subprocess.run([sys.executable, '-I', str(self.generate), '--fleet-plan', str(self.d / 'install-plan.json'), *(['--check'] if check else ['--out', str(self.d / 'launcher.ps1')]), *argv], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse((self.d / 'launcher.ps1').exists())
        return p.stderr

    def companion(self, account=None, wsl=None):
        (self.live / 'install' / 'companion-account.json').write_text(json.dumps(account or {'contract': 'clued.independent-ci.companion-account/1', 'companionSid': self.OWNER, 'operatorSid': self.OPERATOR}), encoding='utf-8')
        (self.live / 'install' / 'companion-wsl.json').write_text(json.dumps(wsl or {'contract': 'clued.independent-ci.companion-wsl/1', 'stage': 'qualified', 'distro': 'D', 'companionSid': self.OWNER,
                                                                                    'target': 'D:\\clued-resident\\wsl\\D\\ext4.vhdx'}), encoding='utf-8')
        return lambda plan: plan.update(companionAccount=True)

    def test_a_plan_of_this_package_passes_every_plan_check(self):
        self.assertIn('RUNNER_SERVICE_FACTS_UNREADABLE', self.run_plan())
        self.assertIn('RUNNER_SERVICE_FACTS_UNREADABLE', self.run_plan(self.companion()))

    def test_a_plan_that_is_not_this_package_or_node_is_refused(self):
        for change, code in ((lambda p: p.update(node='node-b'), 'FLEET_PLAN_NOT_THIS_PACKAGE_NODE'), (lambda p: p['linux'].update(distribution='E'), 'FLEET_PLAN_NOT_THIS_PACKAGE_NODE'),
                             (lambda p: p.update(linuxManifestSha256='e' * 64), 'FLEET_PLAN_NOT_THIS_PACKAGE'), (lambda p: p['expectedLinux'].update(generation=2), 'FLEET_PLAN_EXPECTED_LINUX_NOT_THIS_PACKAGE'),
                             (lambda p: p['expectedLinux'].update(packageManifestSha256='e' * 64), 'FLEET_PLAN_EXPECTED_LINUX_NOT_THIS_PACKAGE'), (lambda p: p.update(companionAccount='yes'), 'FLEET_PLAN_SHAPE'),
                             (lambda p: p['linux']['timeoutSeconds'].update(B=0), 'FLEET_PLAN_TIMEOUTS'), (lambda p: p['linux']['timeoutSeconds'].update(A=86401), 'FLEET_PLAN_TIMEOUTS'),
                             (lambda p: p['linux'].update(inDir=str(self.d / 'elsewhere')), 'FLEET_PLAN_IN_DIR_NOT_THE_SCRIPTS'), (lambda p: p['linux'].update(outDir=str(self.d / 'elsewhere')), 'FLEET_PLAN_OUT_DIR_NOT_THE_SCRIPTS'),
                             (lambda p: p['linux']['scripts']['B'].update(sha256='e' * 64), 'FLEET_SCRIPT_NOT_AS_PLANNED'), (lambda p: p.update(contract='x'), 'FLEET_PLAN_CONTRACT')):
            self.assertIn(code, self.run_plan(change), code)
        self.assertIn('FLEET_PLAN_USAGE', self.run_plan(argv=['--linux-version-facts', 'x']))
        self.assertIn('FLEET_PLAN_OUT_DIR_REQUIRED', self.run_plan(lambda p: p['linux'].pop('outDir')))
        # --check runs before W1 (w1Paused still null) and writes no launcher; the launcher is generated only for the plan's W1 pause
        self.assertIn('RUNNER_SERVICE_FACTS_UNREADABLE', self.run_plan(check=True))
        self.assertIn('FLEET_PLAN_W1_PAUSED', self.run_plan(lambda p: p.update(w1Paused={'sha256': '3' * 64, 'reason': 'fleet-node-reinstall-x-w1'}), check=True))
        for bad in (None, {'sha256': '3' * 64}, {'sha256': 'x', 'reason': 'fleet-node-reinstall-x-w1'}, {'sha256': '3' * 64, 'reason': 'another-reason'}):
            self.assertIn('FLEET_PLAN_W1_PAUSED', self.run_plan(lambda p: p.update(w1Paused=bad)), bad)
        self.assertIn('FLEET_PLAN_USAGE', self.run_plan(argv=['--check'])); self.assertIn('FLEET_PLAN_USAGE', self.run_plan(argv=['--out', 'x'], check=True))
        generator = GENERATE.read_text(encoding='utf-8')
        self.assertIn("if not (FLEET_PLAN and CHECK) and not paused_present and not halt_accepted: refusals.append('OLD_RESIDENT_NOT_PAUSED')", generator)
        self.assertIn("if FLEET_PLAN and not CHECK and paused_present and paused_sha != PLAN['w1Paused']['sha256']: refusals.append('OLD_RESIDENT_PAUSE_NOT_THE_PLANS')", generator)
        self.assertLess(generator.index("'status': 'FLEET_PLAN_CHECK_PASSED'"), generator.index('write_new(out, data)'))   # --check ends before any launcher is written
        # an out directory in the Owner's work directory (or anywhere but a new one under the CI root) is refused: the launcher makes it
        good = dict(self.scripts); self.out = self.d / 'linux-out'; self.scripts = {k: self.script() for k in ('A', 'B', 'BResume')}
        self.assertIn('FLEET_PLAN_OUT_DIR_NOT_A_NEW_ONE_UNDER_THE_CI_ROOT', self.run_plan())
        self.out = Path('C:/ProgramData/CluedIndependentCI') / ('reinstall-linux-out-' + '4' * 32); self.scripts = good

    def test_secrets_reasons_and_launcher_come_from_the_plan_only(self):
        uuid = '11111111-1111-4111-8111-111111111111'
        hb = lambda **kw: dict({'target': 'C:' + chr(92) + 'x', 'fingerprint': '8' * 64, 'bindingId': uuid}, **kw)
        for change, code in ((lambda p: p.pop('secrets'), 'FLEET_PLAN_SECRETS'), (lambda p: p['secrets'].pop('heartbeatToken'), 'FLEET_PLAN_SECRETS'),
                             (lambda p: p['secrets'].update(source='owner-file'), 'FLEET_PLAN_SECRETS'), (lambda p: p['secrets'].update(upgradeToken=None), 'FLEET_PLAN_SECRETS'),
                             (lambda p: p['secrets']['upgradeToken'].update(fingerprint=None), 'FLEET_PLAN_SECRETS'), (lambda p: p['secrets']['upgradeToken'].update(file='C:' + chr(92) + 'x.token'), 'FLEET_PLAN_SECRETS'),
                             (lambda p: p['secrets'].update(upgradeTokenFile='C:' + chr(92) + 'x.token'), 'FLEET_PLAN_SECRETS'),   # the old shape: no token file is ever named
                             (lambda p: p['secrets'].update(heartbeatToken=hb(bindingId='not-a-uuid')), 'FLEET_PLAN_SECRETS'), (lambda p: p['secrets'].update(heartbeatToken=hb(fingerprint='7' * 64)), 'FLEET_PLAN_SECRETS'),
                             (lambda p: p['secrets'].update(heartbeatToken={'target': 'x', 'fingerprint': '8' * 64}), 'FLEET_PLAN_SECRETS'),
                             (lambda p: p.pop('expectedInstalledLinux'), 'FLEET_SCRIPTS_NOT_FOR_THE_PLANS_INSTALLED_LINUX'), (lambda p: p['expectedInstalledLinux'].update(generation=4), 'FLEET_SCRIPTS_NOT_FOR_THE_PLANS_INSTALLED_LINUX'),
                             (lambda p: p['expectedInstalledLinux'].update(manifestSha256='e' * 64), 'FLEET_SCRIPTS_NOT_FOR_THE_PLANS_INSTALLED_LINUX'),
                             (lambda p: p['expectedInstalledLinux'].update(ciSourceManifestSha256='e' * 64), 'FLEET_SCRIPTS_NOT_FOR_THE_PLANS_INSTALLED_LINUX'),
                             (lambda p: p.pop('reasons'), 'FLEET_PLAN_REASONS'), (lambda p: p['reasons'].update(pause='Has Blanks'), 'FLEET_PLAN_REASONS'), (lambda p: p['reasons'].pop('w1Pause'), 'FLEET_PLAN_REASONS'),
                             (lambda p: p.update(launcher={'path': 'x', 'sha256': 'e' * 64}), 'FLEET_PLAN_LAUNCHER_ALREADY_SET')):
            self.assertIn(code, self.run_plan(change), code)
        for flag in ('--upgrade-token-file', '--heartbeat-token-file', '--heartbeat-binding-id'):   # the plan is the only source
            self.assertNotIn(flag, GENERATE.read_text(encoding='utf-8'), flag)

    def test_only_package_run_scripts_naming_one_in_and_one_out_directory(self):
        for key, data, code in (('B', self.script(draft=1), 'FLEET_SCRIPT_NOT_A_PACKAGE_RUN_SCRIPT'), ('B', self.script(extra='WANT_A="${1:?x}"\n'), 'FLEET_SCRIPT_NOT_A_PACKAGE_RUN_SCRIPT'),
                                ('A', self.script(extra='[ "${R4_CLEAN_ENV:-}" = 1 ]\n'), 'FLEET_SCRIPT_NOT_A_PACKAGE_RUN_SCRIPT'), ('A', b'#!/bin/bash\nDRAFT=0\nW=/mnt/d/in\n', 'FLEET_SCRIPT_NOT_A_PACKAGE_RUN_SCRIPT'),
                                ('BResume', self.script(out=self.d / 'other-out'), 'FLEET_SCRIPTS_NAME_DIFFERENT_DIRECTORIES')):
            good = dict(self.scripts); self.scripts[key] = data
            self.assertIn(code, self.run_plan(), (key, code))
            self.scripts = good

    def test_companion_account_exactly_as_the_node_records_it(self):
        self.assertIn('FLEET_PLAN_COMPANION_ACCOUNT_NOT_AS_INSTALLED', self.run_plan(lambda p: p.update(companionAccount=True)))
        yes = self.companion()
        self.assertIn('FLEET_PLAN_COMPANION_ACCOUNT_NOT_AS_INSTALLED', self.run_plan())   # the records are there, the plan says no
        self.assertIn('COMPANION_ACCOUNT_RECORD_REFUSED', self.run_plan(self.companion(account={'contract': 'clued.independent-ci.companion-account/1', 'companionSid': self.OPERATOR, 'operatorSid': self.OPERATOR})))
        self.assertIn('COMPANION_WSL_RECORD_REFUSED', self.run_plan(self.companion(wsl={'contract': 'clued.independent-ci.companion-wsl/1', 'stage': 'moved', 'distro': 'D', 'companionSid': self.OWNER, 'target': 'D:\\w\\ext4.vhdx'})))
        self.companion()
        self.files['resident/windows/CompanionTaskRegistrar.cs'] = b'// an older registrar\n'
        self.assertIn('PACKAGE_HAS_NO_ROOT_RUN_REGISTRAR', self.run_plan(yes))


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class ExpectedPlanEncoding(unittest.TestCase):
    """DESK 2026-11-12: the installer's dry run carried the Chinese system's access-denied message in carryForwardPreview; Windows
    PowerShell 5.1 wrote it to the redirected stdout in code page 936 and generate.py (UTF-8) stopped with UnicodeDecodeError."""
    MESSAGE = '\u5bf9\u8def\u5f84\u201cC:\\ProgramData\\CluedIndependentCI\\secrets\u201d\u7684\u8bbf\u95ee\u88ab\u62d2\u7edd\u3002'

    def test_localized_system_text_reaches_the_generator_as_utf8(self):
        self.assertNotEqual(self.MESSAGE.encode('gbk'), self.MESSAGE.encode('utf-8'))   # the message is one both code pages can write, differently
        with tempfile.TemporaryDirectory(prefix='ep') as directory:
            windows = Path(directory) / 'pkg' / 'resident' / 'windows'; windows.mkdir(parents=True)
            # a stand-in installer: the real parameters, and the dry run's shape with a localized refusal as the preview
            fake = ("param([string]$PackageRoot, [string]$ExpectedPackageManifestSha256, [string]$OwnerSid, [string]$ControllerSid, [string]$OperatorSid, [switch]$StartAfterInstall)\n"
                    "$m = -join ([char[]]@(" + ', '.join(str(ord(c)) for c in self.MESSAGE) + "))\n"
                    "[ordered]@{ status = 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN'; planSha256 = ('a' * 64); plan = [ordered]@{ rootExists = (Test-Path -LiteralPath 'C:\\ProgramData\\CluedIndependentCI\\resident') }; carryForwardPreview = $m } | ConvertTo-Json -Depth 4\n")
            (windows / 'install-resident.ps1').write_text(fake, encoding='ascii')
            sid = 'S-1-5-21-1-2-3-1001'
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'launcher' / 'expected-plan.ps1'), '-View', 'post-uninstall', '-PackageRoot', str(Path(directory) / 'pkg'),
                                '-PackageManifestSha256', 'b' * 64, '-AppKeyTargetExists', 'true', '-CiTokenTargetExists', 'true', '-OwnerSid', sid, '-ControllerSid', 'S-1-5-21-1-2-3-1002', '-OperatorSid', sid],
                               capture_output=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertFalse(p.stdout.startswith(b'\xef\xbb\xbf'))
            self.assertNotIn(self.MESSAGE.encode('gbk'), p.stdout)
            dry = json.loads(p.stdout.decode('utf-8-sig'))   # exactly what generate.py does
            self.assertEqual((dry['status'], dry['carryForwardPreview'], dry['plan']), ('DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', self.MESSAGE, {'rootExists': False}))

    def test_the_generator_pins_nothing_that_can_hold_system_text(self):
        generator = GENERATE.read_text(encoding='utf-8')
        self.assertNotIn('carryForwardPreview', generator.split('"""', 2)[2].replace("(carryForwardPreview, which can hold a localized one, is outside the plan and its hash and is never read here)", ''))
        self.assertIn("sys.exit('EXPECTED_PLAN_OUTPUT_NOT_UTF8_JSON ' + type(_error).__name__)", generator)
        installer = (ROOT.parent / 'windows' / 'install-resident.ps1').read_text(encoding='utf-8')
        self.assertIn("planSha256 = $planSha; plan = $plan; carryForwardPreview = $preview", installer)   # the preview is beside the plan, not in it



TOKEN_DRIVER = r"""
param([string]$Template, [string]$Case, [string]$Work)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
foreach ($name in @('Sha256Bytes', 'Write-New', 'Get-FleetTokenFingerprint', 'Remove-FleetCarry', 'Step-CarryTokens')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw ('FUNCTION_MISSING_OR_DUPLICATED:' + $name) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$U8 = New-Object Text.UTF8Encoding($false); $Strict8 = New-Object Text.UTF8Encoding($false, $true)
$Done = New-Object Collections.Generic.List[string]
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
# not elevated: the test's own account instead of an Administrators owner; protected, nothing inherited
$StageSddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $me + ')'
$CarryParent = Join-Path $Work 'ci-root'; [void][IO.Directory]::CreateDirectory($CarryParent)
$CarriedTokens = [ordered]@{ directory = $null; tokens = @(); removed = $null }
$UpgradeTokenTarget = $c.upgradeTarget; $HeartbeatTokenTarget = $c.heartbeatTarget
$FleetUpgradeTokenFingerprint = $c.upgradeFingerprint; $FleetHeartbeatTokenFingerprint = $c.heartbeatFingerprint
function Stop-Launch([string]$code, $detail) { $script:stopped = [ordered]@{ code = $code; detail = $detail }; throw $code }
$script:stopped = $null; $got = $null
try { $got = Step-CarryTokens } catch { if (-not $script:stopped) { throw } }
$left = @([IO.Directory]::GetFileSystemEntries($CarryParent) | ForEach-Object { [IO.Path]::GetFileName($_) })
$copies = [ordered]@{}; if ($got) { foreach ($k in @($got.Keys)) { $copies[$k] = [ordered]@{ leaf = [IO.Path]::GetFileName($got[$k]); parent = (Split-Path -Parent $got[$k]); sha256 = (Sha256Bytes ([IO.File]::ReadAllBytes($got[$k]))) } } }
$acl = $(if ($got) { [IO.Directory]::GetAccessControl($CarriedTokens.directory).GetSecurityDescriptorSddlForm('Access') } else { $null })
$before = [ordered]@{ directory = $CarriedTokens.directory; tokens = @($CarriedTokens.tokens); removed = $CarriedTokens.removed }
if ($got -and $c.remove) { Remove-FleetCarry }
[ordered]@{ stopped = $script:stopped; copies = $copies; carry = $before; acl = $acl; me = $me; left = $left; done = @($Done)
  removedAfter = $CarriedTokens.removed; leftAfter = @([IO.Directory]::GetFileSystemEntries($CarryParent)).Count } | ConvertTo-Json -Compress -Depth 6
"""


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class CarriedTokens(unittest.TestCase):
    """The installed tokens carried into the reinstall (BATCH1-INTERFACES.md section 8): the template's own functions on stand-in
    token files in a temporary directory. No real secret, no elevation, nothing outside the temporary directory."""
    # fixtures only, assembled here so that no scanner reads a literal token; the shapes are secret-fingerprint.mjs's
    UPGRADE = 'clued' + '_bnd_' + 'Abc123_-' * 5
    HEARTBEAT = 'clued' + '_hbt_' + 'h' * 43

    @staticmethod
    def fingerprint(kind, token):
        domain = {'ci-token': 'clued.independent-ci.ci-binding-pin/1\0', 'heartbeat-token': 'clued.independent-ci.heartbeat-token-pin/1\0'}[kind]
        return hashlib.sha256((domain + token.strip()).encode()).hexdigest()

    def carry(self, upgrade=None, heartbeat=None, pins=None, with_heartbeat=True, remove=False):
        upgrade = (self.UPGRADE + '\n').encode() if upgrade is None else upgrade
        heartbeat = self.HEARTBEAT.encode() if heartbeat is None else heartbeat
        with tempfile.TemporaryDirectory(prefix='carry-') as directory:
            root = Path(directory); secrets = root / 'installed' / 'secrets'; (secrets / 'heartbeat').mkdir(parents=True)
            if upgrade is not False:
                (secrets / 'resident-upgrade.token').write_bytes(upgrade)
            if heartbeat is not False:
                (secrets / 'heartbeat' / 'ci-node-heartbeat.token').write_bytes(heartbeat)
            case = {'upgradeTarget': str(secrets / 'resident-upgrade.token'), 'heartbeatTarget': str(secrets / 'heartbeat' / 'ci-node-heartbeat.token'),
                    'upgradeFingerprint': self.fingerprint('ci-token', self.UPGRADE), 'heartbeatFingerprint': self.fingerprint('heartbeat-token', self.HEARTBEAT) if with_heartbeat else None, 'remove': remove}
            case.update(pins or {})
            (root / 'driver.ps1').write_text(TOKEN_DRIVER, encoding='utf-8')
            (root / 'case.json').write_text(json.dumps(case), encoding='utf-8')
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'), str(TEMPLATE), str(root / 'case.json'), str(root / 'work')], capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            for secret in (self.UPGRADE, self.HEARTBEAT):   # a token never reaches the output
                self.assertNotIn(secret, p.stdout); self.assertNotIn(secret, p.stderr)
            return json.loads(p.stdout), upgrade, heartbeat

    def test_both_tokens_are_copied_checked_and_removed_afterwards(self):
        r, upgrade, heartbeat = self.carry(remove=True)
        self.assertIsNone(r['stopped'])
        self.assertEqual({k: (v['leaf'], v['sha256']) for k, v in r['copies'].items()}, {'upgradeToken': ('resident-upgrade.token', hashlib.sha256(upgrade).hexdigest()),
                                                                                          'heartbeatToken': ('ci-node-heartbeat.token', hashlib.sha256(heartbeat).hexdigest())})   # the installed bytes, as they are
        self.assertRegex(os.path.basename(r['carry']['directory']), r'^reinstall-carry-[0-9a-f]{32}$')
        self.assertEqual({v['parent'] for v in r['copies'].values()}, {r['carry']['directory']})
        self.assertEqual((r['carry']['tokens'], r['carry']['removed'], r['done']), (['upgradeToken', 'heartbeatToken'], None, ['tokens-carried']))
        self.assertEqual(r['acl'], 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + r['me'] + ')')   # protected: the directory's own DACL only
        self.assertEqual((r['removedAfter'], r['leftAfter']), (True, 0))

    def test_a_node_without_a_heartbeat_token_carries_only_the_upgrade_token(self):
        r, _, _ = self.carry(with_heartbeat=False, heartbeat=False)
        self.assertIsNone(r['stopped']); self.assertEqual(list(r['copies']), ['upgradeToken'])

    def test_a_token_that_is_not_the_receipts_stops_and_leaves_no_copy(self):
        other = ('clued' + '_bnd_' + 'Z' * 40).encode()
        for kw, token in ((dict(upgrade=other), 'upgradeToken'), (dict(pins={'heartbeatFingerprint': 'e' * 64}), 'heartbeatToken'), (dict(upgrade=self.HEARTBEAT.encode()), 'upgradeToken'),
                          (dict(heartbeat=(self.HEARTBEAT + 'x').encode()), 'heartbeatToken'), (dict(upgrade=b'\xff\xfe not text'), 'upgradeToken'), (dict(upgrade=b''), 'upgradeToken'),
                          (dict(upgrade=self.UPGRADE.encode() + b' ' * 5000), 'upgradeToken')):
            r, _, _ = self.carry(**kw)
            self.assertIn(r['stopped']['code'], ('CARRIED_TOKEN_FINGERPRINT_MISMATCH', 'INSTALLED_TOKEN_NOT_A_PLAIN_FILE'), kw)
            self.assertEqual((r['stopped']['detail']['token'], r['stopped']['detail']['carryRemoved'], r['left'], r['copies'], r['done']), (token, True, [], {}, []), kw)
        r, _, _ = self.carry(upgrade=other)
        self.assertEqual(r['stopped']['code'], 'CARRIED_TOKEN_FINGERPRINT_MISMATCH')

    def test_an_installed_token_that_is_not_there_stops(self):
        r, _, _ = self.carry(heartbeat=False)
        self.assertEqual((r['stopped']['code'], r['stopped']['detail']['token'], r['left']), ('INSTALLED_TOKEN_NOT_A_PLAIN_FILE', 'heartbeatToken', []))

    def test_the_fingerprint_rule_and_the_wiring_are_the_installers(self):
        template = TEMPLATE.read_text(encoding='utf-8')
        tool = (ROOT.parent / 'tools' / 'secret-fingerprint.mjs').read_text(encoding='utf-8')
        for domain, shape in (('clued.independent-ci.ci-binding-pin/1', 'clued_bnd_[A-Za-z0-9_-]{8,480}'), ('clued.independent-ci.heartbeat-token-pin/1', 'clued_hbt_[A-Za-z0-9_-]{43}')):
            self.assertIn("'" + domain + "\\0'", tool); self.assertIn('/^' + shape + '$/', tool)
            self.assertIn('"' + domain + '`0", \'^' + shape + "\\z'", template)
        main = template.split('#region main', 1)[1]
        order = [main.index(x) for x in ('Step-WindowsPreflightBeforeLinux', '$carried = Step-CarryTokens', "$UpgradeTokenFile = $carried['upgradeToken']", '$fileLocks = Step-FileLocks', '$linux = Step-LinuxRoot',
                                         '  Step-UninstallPreflight', '$uninstall = Step-Uninstall', '$install = Step-Install', 'if ($FleetPlanSha256) { Remove-FleetCarry }', '$train = Step-WaitFirstTrain')]
        self.assertEqual(order, sorted(order))   # copied before the uninstall, removed only once the installer has run
        self.assertEqual(template.count('carriedTokens = $CarriedTokens'), 3)   # every terminal says where the copies are and whether they were removed
        self.assertIn("-cne $FleetUpgradeTokenFingerprint -or ($HeartbeatTokenFile -and [string](Get-Key $b.heartbeat 'fingerprint') -cne $FleetHeartbeatTokenFingerprint))) { $r.codes += 'CARRIED_TOKEN_FINGERPRINT_MISMATCH' }", template)
        generator = GENERATE.read_text(encoding='utf-8')
        self.assertIn("'$UpgradeTokenFile = ' + ('$null' if FLEET_PLAN else q(TOKEN_FILE))", generator)
        self.assertIn("('FLEET_PLAN_SECRETS_NOT_THE_INSTALLERS_TARGET', 'upgradeToken')", generator); self.assertIn("('FLEET_PLAN_SECRETS_NOT_THE_INSTALLERS_TARGET', 'heartbeatToken')", generator)



CLEANUP_DRIVER = r"""
param([string]$Template, [string]$Case, [string]$Work)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
foreach ($name in @('Sha256Bytes', 'Write-New', 'Write-Json', 'Stop-Launch', 'Restore-W1Pause', 'Get-FleetTokenFingerprint', 'Remove-FleetCarry', 'Step-CarryTokens', 'Step-SweepCarry')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw ('FUNCTION_MISSING_OR_DUPLICATED:' + $name) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
# the launcher's own catch and finally (the text between its main try and its final terminal)
$text = [IO.File]::ReadAllText($Template)
$m = [regex]::Match($text, '(?s)\n(\} catch \{\r?\n  Remove-FleetCarry\r?\n.*?\r?\n\} finally \{.*?\r?\n\})\r?\n\$terminal = \[ordered\]@\{')
if (-not $m.Success) { throw 'MAIN_HANDLERS_NOT_FOUND' }
$U8 = New-Object Text.UTF8Encoding($false); $Strict8 = New-Object Text.UTF8Encoding($false, $true)
$Done = New-Object Collections.Generic.List[string]
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$StageSddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $me + ')'
$Out = Join-Path $Work 'launch'; [void][IO.Directory]::CreateDirectory($Out)
$CarryParent = Join-Path $Work 'ci-root'; [void][IO.Directory]::CreateDirectory($CarryParent)
$CarriedTokens = [ordered]@{ directory = $null; tokens = @(); removed = $null; removeError = $null }
$SourceSha = 'a' * 40; $PackageHead = 'b' * 40
$UpgradeTokenTarget = $c.upgradeTarget; $HeartbeatTokenTarget = $c.heartbeatTarget
$FleetUpgradeTokenFingerprint = $c.upgradeFingerprint; $FleetHeartbeatTokenFingerprint = $c.heartbeatFingerprint
$W1Restore = [ordered]@{ armed = $false; result = $null }; $FleetOutDir = $(if ($c.ownOut) { Join-Path $CarryParent $c.ownOut } else { $null })
$thrown = $null; $sweep = $null; $during = $null
if ($c.mode -ceq 'sweep') {
  foreach ($d in $c.leftovers) {
    $dir = Join-Path $CarryParent $d.name; [void][IO.Directory]::CreateDirectory($dir)
    foreach ($f in $d.files.PSObject.Properties) { [IO.File]::WriteAllBytes((Join-Path $dir $f.Name), $U8.GetBytes([string]$f.Value)) }
  }
  if ($c.ownProgress) { $own = Join-Path $CarryParent ('reinstall-progress-' + (Sha256Bytes ($U8.GetBytes($Out.ToLowerInvariant()))).Substring(0, 32)); [void][IO.Directory]::CreateDirectory($own); [IO.File]::WriteAllText((Join-Path $own '001-output.json'), '{}') }
  $sweep = Step-SweepCarry
} else {
  $body = 'try { $carried = Step-CarryTokens; $script:during = @([IO.Directory]::GetFiles($CarriedTokens.directory)).Count; if ($c.mode -ceq ''throw'') { throw ''BOOM'' }; if ($c.mode -ceq ''stop'') { Stop-Launch ''FIXTURE_STOP'' ([ordered]@{ why = ''fixture'' }) }; if ($c.mode -ceq ''installed'') { Remove-FleetCarry } ' + $m.Groups[1].Value
  try { $null = . ([scriptblock]::Create($body)) } catch { $thrown = [string]$_.Exception.Message }
}
[ordered]@{ thrown = $thrown; during = $script:during; carried = $CarriedTokens; done = @($Done); sweep = $sweep
  left = @([IO.Directory]::GetFileSystemEntries($CarryParent) | ForEach-Object { [IO.Path]::GetFileName($_) }) } | ConvertTo-Json -Compress -Depth 6
"""


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class CarriedTokensNeverStay(unittest.TestCase):
    """No copy of a token outlives the run that made it, and a cut-off run's copies are removed by the next run: the template's own
    Stop-Launch, catch, finally and sweep on stand-in tokens. Afterwards every file the run produced and everything it printed is searched
    for the stand-in tokens."""
    UPGRADE, HEARTBEAT = CarriedTokens.UPGRADE, CarriedTokens.HEARTBEAT

    def run_case(self, mode, leftovers=(), pins=None):
        with tempfile.TemporaryDirectory(prefix='carry-end-') as directory:
            root = Path(directory); secrets = root / 'installed' / 'secrets'; (secrets / 'heartbeat').mkdir(parents=True)
            (secrets / 'resident-upgrade.token').write_text(self.UPGRADE + '\n', encoding='ascii')
            (secrets / 'heartbeat' / 'ci-node-heartbeat.token').write_text(self.HEARTBEAT, encoding='ascii')
            case = {'mode': mode, 'leftovers': list(leftovers), 'upgradeTarget': str(secrets / 'resident-upgrade.token'), 'heartbeatTarget': str(secrets / 'heartbeat' / 'ci-node-heartbeat.token'),
                    'upgradeFingerprint': CarriedTokens.fingerprint('ci-token', self.UPGRADE), 'heartbeatFingerprint': CarriedTokens.fingerprint('heartbeat-token', self.HEARTBEAT), 'ownOut': None, 'ownProgress': False}
            case.update(pins or {})
            (root / 'driver.ps1').write_text(CLEANUP_DRIVER, encoding='utf-8')
            work = root / 'work'
            (root / 'case.json').write_text(json.dumps(case), encoding='utf-8')
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'), str(TEMPLATE), str(root / 'case.json'), str(work)],
                               capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            # the marker search: everything printed and every byte of every file the run left (the stand-in "installed" originals are not its product)
            produced = {}
            for at, _, names in os.walk(work):
                for n in names:
                    with open(os.path.join(at, n), 'rb') as stream:
                        produced[os.path.relpath(os.path.join(at, n), work)] = stream.read()
            for marker in (self.UPGRADE, self.HEARTBEAT, self.UPGRADE[10:], self.HEARTBEAT[10:]):
                self.assertNotIn(marker, p.stdout); self.assertNotIn(marker, p.stderr)
                for rel, data in produced.items():
                    self.assertNotIn(marker.encode(), data, rel); self.assertNotIn(marker.encode('utf-16-le'), data, rel)
            return json.loads(p.stdout), {rel: data for rel, data in produced.items()}

    def terminal(self, produced):
        return json.loads(produced[os.path.join('launch', 'terminal.json')].decode('utf-8'))

    def test_removed_once_the_installer_has_run_and_on_the_way_out(self):
        r, produced = self.run_case('installed')
        self.assertEqual((r['thrown'], r['during'], r['left'], r['carried']['removed'], r['carried']['removeError']), (None, 2, [], True, None))
        report = json.loads(produced[os.path.join('launch', 'carried-tokens-report.json')].decode('utf-8'))
        self.assertEqual((report['removed'], report['tokens'], sorted(report)), (True, ['upgradeToken', 'heartbeatToken'], ['directory', 'removeError', 'removed', 'tokens']))
        r, produced = self.run_case('ok')   # nothing removed them before: the finally does
        self.assertEqual((r['during'], r['left'], r['carried']['removed']), (2, [], True))
        self.assertTrue(json.loads(produced[os.path.join('launch', 'carried-tokens-report.json')].decode('utf-8'))['removed'])

    def test_a_stop_removes_them_before_its_terminal_is_written(self):
        r, produced = self.run_case('stop')
        self.assertEqual((r['thrown'], r['during'], r['left']), ('FIXTURE_STOP', 2, []))
        t = self.terminal(produced)
        self.assertEqual((t['status'], t['code'], t['carriedTokens']['removed'], t['carriedTokens']['removeError'], t['completed']), ('STOPPED', 'FIXTURE_STOP', True, None, ['tokens-carried']))
        self.assertRegex(os.path.basename(t['carriedTokens']['directory']), r'^reinstall-carry-[0-9a-f]{32}$')

    def test_a_token_that_is_not_the_receipts_stops_through_the_real_stop(self):
        # (regression: a local named $out in Step-CarryTokens hid the launch directory $Out from the Stop-Launch it calls)
        r, produced = self.run_case('ok', pins={'heartbeatFingerprint': 'e' * 64})
        self.assertEqual((r['thrown'], r['left'], r['done']), ('CARRIED_TOKEN_FINGERPRINT_MISMATCH', [], []))
        t = self.terminal(produced)
        self.assertEqual((t['code'], t['detail'], t['carriedTokens']['removed']), ('CARRIED_TOKEN_FINGERPRINT_MISMATCH', {'token': 'heartbeatToken', 'carryRemoved': True}, True))
        template = TEMPLATE.read_text(encoding='utf-8')
        for fn in ('Step-CarryTokens', 'Step-SweepCarry', 'Step-LinuxRoot', 'Step-FileLocks', 'Step-WindowsPreflightBeforeLinux', 'Invoke-FleetLinuxScript', 'New-FleetRunDirectory', 'New-FleetRegistrar'):
            body = template.split('function ' + fn, 1)[1].split('\nfunction ', 1)[0].split('#endregion generic', 1)[0]
            for name in ('out', 'stage', 'done', 'residentroot', 'packageroot'):   # PowerShell names are case-insensitive: none of the launcher's own may be assigned locally
                self.assertNotRegex(body, r'(?i)(?<![\w:])\$' + name + r'\s*=[^=]', (fn, name))

    def test_an_exception_anywhere_removes_them(self):
        r, produced = self.run_case('throw')
        self.assertEqual((r['thrown'], r['during'], r['left']), ('BOOM', 2, []))
        t = self.terminal(produced)
        self.assertEqual((t['code'], t['detail'], t['carriedTokens']['removed']), ('LAUNCHER_EXCEPTION', 'BOOM', True))
        self.assertIn(os.path.join('launch', 'carried-tokens-report.json'), produced)

    def test_the_next_run_removes_what_a_cut_off_run_left_and_records_it(self):
        a, b, c = 'reinstall-carry-' + '1' * 32, 'reinstall-carry-' + '2' * 32, 'reinstall-carry-' + '3' * 32
        r, produced = self.run_case('sweep', leftovers=[{'name': a, 'files': {'resident-upgrade.token': self.UPGRADE, 'ci-node-heartbeat.token': self.HEARTBEAT + '\n'}},
                                                         {'name': b, 'files': {'resident-upgrade.token': self.UPGRADE, 'notes.txt': 'not a token'}}, {'name': c, 'files': {}},
                                                         {'name': 'reinstall-carry-someone-elses', 'files': {'x.txt': 'x'}}])
        records = [n for n in r['left'] if n != 'reinstall-carry-someone-elses']
        self.assertEqual(len(records), 1); self.assertRegex(records[0], r'^reinstall-carry-sweep-\d{8}T\d{6}Z-[0-9a-f]{8}\.json$')   # only a launcher's own directories are touched
        self.assertEqual([rel for rel in produced if rel.startswith('launch')], [])   # nothing in the launch directory: the sweep runs before it exists
        report = json.loads(produced[os.path.join('ci-root', records[0])].decode('utf-8'))
        rows = {d['name']: d for d in report['directories']}
        self.assertEqual({n: (d['ours'], d['entries'], d['filesTokenShaped'], d['removed'], d['error']) for n, d in rows.items()},
                         {a: (True, 2, True, True, None), b: (True, 2, False, True, None), c: (True, 0, True, True, None), 'reinstall-carry-someone-elses': (False, None, None, False, None)})
        # not elevated, these stand-ins are owned by the test's account with an inherited ACL: recorded as not SYSTEM/Administrators only, deleted all the same
        self.assertEqual({rows[n]['aclSystemAndAdministratorsOnly'] for n in (a, b, c)}, {False})
        self.assertEqual(sorted(rows[a]), ['aclSystemAndAdministratorsOnly', 'entries', 'error', 'filesTokenShaped', 'name', 'ours', 'removed', 'reparse'])   # no field can hold content
        self.assertEqual(r['done'], ['carry-swept'])
        # out directories of earlier launches go too (public data), by name and entry count; never this launcher's own pinned one
        mine, old = 'reinstall-linux-out-' + '5' * 32, 'reinstall-linux-out-' + '6' * 32
        r, produced = self.run_case('sweep', leftovers=[{'name': mine, 'files': {'linux-live-manifest.20261112T100000Z.txt': 'kept'}}, {'name': old, 'files': {'a.txt': 'a', 'b.txt': 'b'}}, {'name': 'reinstall-linux-out-other', 'files': {}}], pins={'ownOut': mine})
        self.assertEqual(sorted(n for n in r['left'] if not n.startswith('reinstall-carry-sweep-')), [mine, 'reinstall-linux-out-other'])
        rows = {d['name']: d for d in json.loads(next(v for k, v in produced.items() if 'reinstall-carry-sweep-' in k).decode('utf-8'))['directories']}
        self.assertEqual({n: (d['kind'], d['ours'], d['entries'], d['removed']) for n, d in rows.items()}, {old: ('linux-out', True, 2, True), 'reinstall-linux-out-other': ('linux-out', False, None, False)})
        # progress records of earlier launches go too (completed or superseded by this run), never this launcher's own
        done, cut = 'reinstall-progress-' + 'a' * 32, 'reinstall-progress-' + 'b' * 32
        r, produced = self.run_case('sweep', leftovers=[{'name': done, 'files': {'001-output.json': '{}', '020-companion-headless.json': '{}'}}, {'name': cut, 'files': {'001-output.json': '{}'}}, {'name': 'reinstall-progress-x', 'files': {}}], pins={'ownProgress': True})
        rows = {d['name']: d for d in json.loads(next(v for k, v in produced.items() if 'reinstall-carry-sweep-' in k).decode('utf-8'))['directories']}
        self.assertEqual({n: (d['kind'], d['ours'], d['entries'], d['completed'], d['removed']) for n, d in rows.items()},
                         {done: ('progress', True, 2, True, True), cut: ('progress', True, 1, False, True), 'reinstall-progress-x': ('progress', False, None, None, False)})
        own = [n for n in r['left'] if n.startswith('reinstall-progress-') and n not in ('reinstall-progress-x',)]
        self.assertEqual(len(own), 1)   # the records of this launcher's own launch directory survive a second start of the same launcher
        r, produced = self.run_case('sweep')   # nothing there: no record, nothing done
        self.assertEqual((r['sweep'], r['done'], list(produced)), ([], [], []))

    def test_every_way_out_of_the_launcher_goes_through_the_removal(self):
        template = TEMPLATE.read_text(encoding='utf-8')
        main = template.split('#region main', 1)[1]
        self.assertLess(main.index('Step-HostHygiene'), main.index('$null = Step-SweepCarry')); self.assertLess(main.index('$null = Step-SweepCarry'), main.index('Step-Output\n'))
        self.assertIn('} catch {\n  Remove-FleetCarry\n  Restore-W1Pause\n  if (-not [IO.File]::Exists((Join-Path $Out \'terminal.json\')))', main)
        self.assertRegex(main, r'(?s)\} finally \{.*?\n  Remove-FleetCarry\n')
        stop = template.split('function Stop-Launch', 1)[1].split('\n}', 1)[0]
        self.assertLess(stop.index('Remove-FleetCarry'), stop.index("Write-Json 'terminal.json'"))
        self.assertLess(main.index('$install = Step-Install'), main.index('if ($FleetPlanSha256) { Remove-FleetCarry }'))
        # the token bytes are only ever handed to the fingerprint and the copy; no report, json or output call sees them
        for fn in ('Step-CarryTokens', 'Step-SweepCarry', 'Get-FleetTokenFingerprint'):
            body = template.split('function ' + fn, 1)[1].split('\nfunction ', 1)[0]
            for line in body.split('\n'):
                if any(v in line for v in ('$bytes', '$again', '$token', '$b)', '$b ')):
                    for sink in ('Write-Json', 'ConvertTo-Json', 'Stop-Launch', 'Write-Host', 'Write-Output', '$report', '$r.', '$Done'):
                        self.assertFalse(sink in line and ('$bytes' in line.split(sink, 1)[1] or '$token' in line.split(sink, 1)[1] or '$again' in line.split(sink, 1)[1]), (fn, line.strip()[:120]))



RECORDS_DRIVER = r"""
param([string]$Template, [string]$Work)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$text = [IO.File]::ReadAllText($Template)
$m = [regex]::Match($text, '(?s)\n(\$Progress = @\{.*?\.GetNewClosure\(\)\))\r?\n')
if (-not $m.Success) { throw 'PROGRESS_STATEMENTS_NOT_FOUND' }
. ([scriptblock]::Create($m.Groups[1].Value))
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
$node = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Read-FleetFileChecked' }, $false))[0]
. ([scriptblock]::Create($node.Extent.Text))
$out = Join-Path $Work 'launch'; $elevated = Join-Path $Work 'ci\reinstall-progress-x'; [void][IO.Directory]::CreateDirectory($out)
$Done.Add('carry-swept')   # before the launch directory exists: counted, not written
$Progress.pins = [ordered]@{ sourceSha = ('1' * 40); packageHead = ('2' * 40) }; $Progress.out = $out; $Progress.elevated = $elevated
$Done.Add('output'); $Done.Add('first-train-not-observed')
[IO.File]::WriteAllText((Join-Path $elevated '004-install.json'), 'someone else')   # a record is never overwritten: the step's record cannot be written, the launch stops
$again = try { $Done.Add('install'); 'added' } catch { 'refused' }
# files a Linux step wrote: read only as plain files in plain directories
$dir = Join-Path $Work 'out'; [void][IO.Directory]::CreateDirectory($dir); [IO.File]::WriteAllText((Join-Path $dir 'plain.txt'), 'hello')
[void][IO.Directory]::CreateDirectory((Join-Path $dir 'a-directory.txt')); [IO.File]::WriteAllBytes((Join-Path $dir 'big.txt'), (New-Object byte[] 200))
$target = Join-Path $Work 'elsewhere'; [void][IO.Directory]::CreateDirectory($target); [IO.File]::WriteAllText((Join-Path $target 'plain.txt'), 'other')
$link = Join-Path $Work 'linked'; $null = & 'C:\Windows\System32\cmd.exe' /d /c ('mklink /J "' + $link + '" "' + $target + '"') 2>&1
$len = { param($b) if ($null -eq $b) { $null } else { $b.Length } }
[ordered]@{ done = @($Done); contains = $Done.Contains('output'); count = $Progress.count; again = $again
  launch = @([IO.Directory]::GetFiles((Join-Path $out 'progress')) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
  elevated = @([IO.Directory]::GetFiles($elevated) | ForEach-Object { [IO.Path]::GetFileName($_) } | Sort-Object)
  record = (Get-Content -LiteralPath (Join-Path $elevated '002-output.json') -Raw | ConvertFrom-Json); same = ((Get-Content -LiteralPath (Join-Path $elevated '002-output.json') -Raw) -ceq (Get-Content -LiteralPath (Join-Path $out 'progress\002-output.json') -Raw))
  pid = $PID; junction = [IO.Directory]::Exists($link)
  read = [ordered]@{ plain = (& $len (Read-FleetFileChecked $dir 'plain.txt' 100)); missing = (& $len (Read-FleetFileChecked $dir 'none.txt' 100)); directory = (& $len (Read-FleetFileChecked $dir 'a-directory.txt' 100))
    tooLarge = (& $len (Read-FleetFileChecked $dir 'big.txt' 100)); throughALink = (& $len (Read-FleetFileChecked $link 'plain.txt' 100)); badLeaf = (& $len (Read-FleetFileChecked $dir '..\elsewhere\plain.txt' 100)) } } | ConvertTo-Json -Compress -Depth 5
"""


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class ProgressRecordsAndCheckedReads(unittest.TestCase):
    def test_every_completed_step_is_on_disk_twice_create_only_and_files_are_read_only_as_plain_files(self):
        with tempfile.TemporaryDirectory(prefix='progress-') as directory:
            root = Path(directory); (root / 'driver.ps1').write_text(RECORDS_DRIVER, encoding='utf-8')
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'), str(TEMPLATE), str(root / 'work')], capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            r = json.loads(p.stdout)
        self.assertEqual((r['done'][:3], r['contains'], r['again']), (['carry-swept', 'output', 'first-train-not-observed'], True, 'refused'))
        self.assertEqual(r['launch'][:2], ['002-output.json', '003-first-train-not-observed.json'])   # numbered by completion; the step before the launch directory has no record
        self.assertEqual(r['elevated'], ['002-output.json', '003-first-train-not-observed.json', '004-install.json'])
        rec = r['record']
        self.assertEqual((rec['contract'], rec['index'], rec['step'], rec['pid'], rec['pins']['sourceSha'], r['same']), ('clued.independent-ci.reinstall-launch-progress/1', 2, 'output', r['pid'], '1' * 40, True))
        self.assertRegex(rec['processStart'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$')
        self.assertTrue(r['junction'])
        self.assertEqual(r['read'], {'plain': 5, 'missing': None, 'directory': None, 'tooLarge': None, 'throughALink': None, 'badLeaf': None})

    def test_the_launcher_sets_the_records_up_and_reads_step_output_only_through_the_checked_read(self):
        template, generator = TEMPLATE.read_text(encoding='utf-8'), GENERATE.read_text(encoding='utf-8')
        output = template.split('function Step-Output', 1)[1].split('\nfunction ', 1)[0]
        self.assertLess(output.index("$Progress.out = $Out; $Progress.elevated = Join-Path $CarryParent ('reinstall-progress-' + $id)"), output.index("Write-Json 'intent.json'"))
        run = template.split('function New-FleetRunDirectory', 1)[1].split('\nfunction ', 1)[0]
        # out\: the account may list it, nothing more; the two redirection targets are made here, the account may only write and append
        self.assertIn("'(A;;0x1200a9;;;' + $OwnerSid + ')'", run); self.assertNotIn('0x1301bf', run)
        self.assertIn("'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)' + $(if ($FleetCompanionAccount) { '(A;;0x120116;;;' + $OwnerSid + ')' }", run)
        self.assertEqual(0x120116 & (0x10000 | 0x40000 | 0x80000 | 0x40), 0)   # no DELETE, WRITE_DAC, WRITE_OWNER or delete-child in what the account gets
        self.assertIn("foreach ($leaf in @('stdout.txt', 'stderr.txt'))", run); self.assertIn('LINUX_RUN_OUTPUT_FILE_ACL_UNCONFIRMED', run)
        for fn in ('Invoke-FleetLinuxScript', 'Step-LinuxRoot'):
            body = template.split('function ' + fn, 1)[1].split('\nfunction ', 1)[0].split('#endregion generic', 1)[0]
            self.assertIn('Read-FleetFileChecked' if fn == 'Invoke-FleetLinuxScript' else 'Read-FleetOutFile', body, fn)
            self.assertNotRegex(body, r'ReadAll(Bytes|Text)\((?!\$pin)', fn)   # (the pinned script itself aside) nothing a Linux step wrote is read any other way
        dirs = template.split('function Set-FleetLinuxDirectories', 1)[1].split('\nfunction ', 1)[0]
        self.assertIn("-cnotmatch '^reinstall-linux-out-[0-9a-f]{32}$') { Stop-Launch 'LINUX_OUT_DIRECTORY_NOT_UNDER_THE_CI_ROOT'", dirs); self.assertIn("Stop-Launch 'LINUX_OUT_DIRECTORY_EXISTS'", dirs)
        # the reviewed dry run: only its pinned bytes
        self.assertIn("'$ReviewedDryRunSha256 = ' + q(sha(dry_file))", generator)
        self.assertEqual(template.count('[IO.File]::ReadAllText($ReviewedDryRunPath)'), 0)
        self.assertEqual(template.count("$rp = Get-ReviewedPlan; $s1 = [ordered]@{}; if ($null -eq $rp) { $codes.Add('REVIEWED_DRY_RUN_MISSING_OR_CHANGED') }"), 2)
        self.assertIn("if ((Sha256Bytes $b) -cne $ReviewedDryRunSha256) { return $null }", template)



PROBE_DRIVER = r"""
param([string]$Template, [string]$Case, [string]$Work)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$fx = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
foreach ($name in @('Sha256Bytes', 'Write-New', 'Write-Json', 'Get-Key', 'Parse-Json', 'Tail', 'Get-FileSha', 'Wait-Until', 'Remove-FleetCarry', 'Restore-W1Pause', 'Stop-Launch', 'ConvertFrom-FleetRootRunLine', 'Read-FleetFileChecked', 'Test-FleetRefusedBeforeAnyChange', 'Set-FleetW1PauseKept', 'Step-LinuxOutAclProbe')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw ('FUNCTION_MISSING_OR_DUPLICATED:' + $name) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$U8 = New-Object Text.UTF8Encoding($false)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Done = New-Object Collections.Generic.List[string]
$Out = Join-Path $Work 'launch'; [void][IO.Directory]::CreateDirectory($Out)
$ResidentRoot = Join-Path $Work 'resident'; foreach ($d in @('install', 'state', ('resident\' + ('a' * 64) + '\windows'))) { [void][IO.Directory]::CreateDirectory((Join-Path $ResidentRoot $d)) }
$SourceSha = '1' * 40; $PackageHead = '2' * 40; $CarryParent = $Work
$CarriedTokens = [ordered]@{ directory = $null; tokens = @(); removed = $null; removeError = $null }
$W1Restore = [ordered]@{ armed = [bool]$fx.armed; result = $null }
$InstalledResidentManifestSha256 = 'a' * 64; $FleetW1PauseReason = 'fleet-w1'; $FleetW1ResumeWaitSeconds = 3
$door = Join-Path $ResidentRoot ('resident\' + ('a' * 64) + '\windows\rearm-resident.ps1'); [IO.File]::WriteAllText($door, 'the installed door')
$FleetInstalledRearmSha256 = $(if ($fx.doorChanged) { 'f' * 64 } else { Get-FileSha $door })
$pausedFile = Join-Path $ResidentRoot 'state\PAUSED.json'
if ($fx.paused) { [IO.File]::WriteAllText($pausedFile, ('{"source":{"reason":"' + $fx.pausedReason + '"}}')) }
$InstalledPausedSha256 = $(if ($fx.pausedIsPinned -and $fx.paused) { Get-FileSha $pausedFile } else { 'e' * 64 })
$script:children = @()
function Invoke-Child([string]$name, [string]$file, [string[]]$argList) {
  $script:children += ,([ordered]@{ name = $name; file = $file; args = @($argList) })
  if ($fx.serviceResumes) { [IO.File]::Delete($pausedFile) }
  [pscustomobject]@{ exit = $(if ($fx.doorRefuses) { 1 } else { 0 }); stdout = $(if ($fx.doorRefuses) { 'REFUSED' } else { '{"status":"RESUME_REQUESTED_SERVICE_WILL_VERIFY"}' }); stderr = '' }
}
# a run directory as New-FleetRunDirectory lays it out, without the Administrators owner a test cannot set
function New-FleetRunDirectory([string]$name, [switch]$Probe) {
  $dir = Join-Path $ResidentRoot ('install\linux-run-' + ('7' * 32) + '-probe'); foreach ($d in @('out', 'captured')) { [void][IO.Directory]::CreateDirectory((Join-Path $dir $d)) }
  foreach ($leaf in @('stdout.txt', 'stderr.txt')) { [IO.File]::WriteAllBytes((Join-Path $dir ('out\' + $leaf)), (New-Object byte[] 0)) }
  $script:probeRequested = [bool]$Probe
  [ordered]@{ directory = $dir; script = $null; out = (Join-Path $dir 'out'); captured = (Join-Path $dir 'captured'); sha256 = $null; timeoutSeconds = $null }
}
# the registrar's write-probe, as a stand-in: what it would have captured, and its one line
function Invoke-FleetProcess([string]$file, [string]$arguments, [int]$seconds) {
  $script:registrarArguments = $arguments
  $dir = ($arguments -split ' ')[2]
  if ($null -ne $fx.capturedStdout) { [IO.File]::WriteAllBytes((Join-Path $dir 'captured\stdout.txt'), $U8.GetBytes([string]$fx.capturedStdout)) }
  if ($null -ne $fx.capturedStderr) { [IO.File]::WriteAllBytes((Join-Path $dir 'captured\stderr.txt'), $U8.GetBytes([string]$fx.capturedStderr)) }
  if ($fx.aclChanges) { $f = Join-Path $dir 'out\stdout.txt'; $a = [IO.File]::GetAccessControl($f); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-1-0')), 'Read', 'Allow'))); [IO.File]::SetAccessControl($f, $a) }
  [ordered]@{ timedOut = [bool]$fx.timedOut; exit = 0; stdout = [string]$fx.line; stderr = ''; pid = 1 }
}
$stopped = $null; $r = $null
try { $r = Step-LinuxOutAclProbe 'fake-registrar.exe' } catch { $stopped = [string]$_.Exception.Message }
$terminal = $(if ([IO.File]::Exists((Join-Path $Out 'terminal.json'))) { Get-Content -LiteralPath (Join-Path $Out 'terminal.json') -Raw | ConvertFrom-Json } else { $null })
[ordered]@{ stopped = $stopped; result = $r; done = @($Done); probeRequested = $script:probeRequested; registrarArguments = $script:registrarArguments; children = $script:children
  probeDirectoryLeft = [IO.Directory]::Exists((Join-Path $ResidentRoot ('install\linux-run-' + ('7' * 32) + '-probe'))); pausedStill = [IO.File]::Exists($pausedFile); armedAfter = $W1Restore.armed; terminal = $terminal
  report = (Get-Content -LiteralPath (Join-Path $Out 'linux-out-acl-probe-report.json') -Raw | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 7
"""


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class OutAclProbeAndW1Restore(unittest.TestCase):
    """Before anything changes on a companion node the launcher proves, as the real account, that the pre-made output files can be
    written (Step-LinuxOutAclProbe); a launch that stops before it changed anything lifts its own W1 pause again (Restore-W1Pause).
    The template's own functions; the registrar and the installed Resume door are stand-ins."""
    def probe(self, **case):
        base = {'line': 'ROOT_RUN_EXITED 0', 'capturedStdout': 'x\r\n', 'capturedStderr': '', 'aclChanges': False, 'timedOut': False, 'armed': True, 'paused': True, 'pausedReason': 'fleet-w1',
                'pausedIsPinned': True, 'serviceResumes': True, 'doorRefuses': False, 'doorChanged': False}
        base.update(case)
        with tempfile.TemporaryDirectory(prefix='probe-') as directory:
            root = Path(directory); (root / 'driver.ps1').write_text(PROBE_DRIVER, encoding='utf-8'); (root / 'case.json').write_text(json.dumps(base), encoding='utf-8')
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(root / 'driver.ps1'), str(TEMPLATE), str(root / 'case.json'), str(root / 'work')], capture_output=True, text=True, encoding='utf-8', timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)

    def test_the_probe_passes_and_leaves_only_its_record(self):
        r = self.probe()
        self.assertIsNone(r['stopped'])
        self.assertEqual((r['done'], r['probeRequested'], r['probeDirectoryLeft'], r['report']['failed'], r['report']['removed']), (['linux-out-acl-probe'], True, False, [], True))
        self.assertRegex(r['registrarArguments'], r'^write-probe \S+\\resident \S+\\install\\linux-run-7{32}-probe 120$')
        self.assertEqual((r['children'], r['pausedStill'], r['armedAfter']), ([], True, True))   # nothing stopped: the pause is not touched

    def test_a_failed_probe_stops_names_what_failed_and_lifts_the_w1_pause_again(self):
        for case, failed in (({'line': 'ROOT_RUN_EXITED 1'}, ['exit']), ({'capturedStdout': 'y\r\n'}, ['stdout']), ({'capturedStdout': 'x\r\nx\r\n'}, ['stdout']), ({'capturedStdout': None}, ['stdout']),
                             ({'capturedStderr': 'Access is denied.\r\n'}, ['stderr']), ({'aclChanges': True}, ['acl']), ({'line': 'ROOT_RUN_REFUSED COMPANION_TASK_NOT_PASSWORD', 'capturedStdout': None, 'capturedStderr': None}, ['exit', 'stdout', 'stderr']),
                             ({'line': 'ROOT_RUN_EXITED 0\nCAPTURE_REFUSED ROOT_RUN_OUTPUT_IS_A_LINK', 'capturedStdout': None, 'capturedStderr': None}, ['stdout', 'stderr'])):
            r = self.probe(**case)
            self.assertEqual((r['stopped'], r['report']['failed'], r['probeDirectoryLeft'], r['done']), ('LINUX_OUT_ACL_PROBE_FAILED', failed, False, []), case)
            t = r['terminal']
            self.assertEqual((t['code'], t['detail']['failed'], t['w1Pause']['restored'], t['w1Pause']['reason'], r['pausedStill'], r['armedAfter']), ('LINUX_OUT_ACL_PROBE_FAILED', failed, True, None, False, False), case)
            self.assertEqual([(c['name'], c['args'][:3]) for c in r['children']], [('w1-resume', ['-Request', 'Resume', '-ExpectedPausedSha256'])], case)   # the installed, reviewed door, once
            self.assertRegex(r['children'][0]['file'], r'\\resident\\a{64}\\windows\\rearm-resident\.ps1$'); self.assertEqual(r['children'][0]['args'][3], t['w1Pause']['pausedSha256'])

    def test_a_probe_that_left_the_companion_task_in_an_unknown_state_keeps_the_pause(self):
        nothing = {'capturedStdout': None, 'capturedStderr': None}
        for case, why in ((dict(nothing, line='ROOT_RUN_REFUSED ROOT_RUN_TASK_NOT_UPDATED_PARKED'), 'WRITE_PROBE_ROOT_RUN_TASK_NOT_UPDATED_PARKED'), (dict(nothing, line='ROOT_RUN_REFUSED ROOT_RUN_EXIT_UNREADABLE'), 'WRITE_PROBE_ROOT_RUN_EXIT_UNREADABLE'),
                          (dict(nothing, line='ROOT_RUN_REFUSED ACCOUNT_PASSWORD_NOT_SET'), 'WRITE_PROBE_ACCOUNT_PASSWORD_NOT_SET'), (dict(nothing, timedOut=True), 'WRITE_PROBE_TIMEOUT'), (dict(nothing, line='garbage'), 'WRITE_PROBE_UNREADABLE')):
            r = self.probe(**case)
            t = r['terminal']
            self.assertEqual((r['stopped'], t['w1Pause']['restored'], t['w1Pause']['reason'], r['children'], r['pausedStill'], r['armedAfter']), ('LINUX_OUT_ACL_PROBE_FAILED', False, 'NOT_LIFTED:' + why, [], True, False), case)

    def test_a_pause_that_is_not_this_launchs_is_never_touched(self):
        for case, reason in (({'pausedIsPinned': False}, 'PAUSE_NOT_THIS_LAUNCHS_LEFT_AS_IT_IS'), ({'pausedReason': 'someone-elses-maintenance'}, 'PAUSE_NOT_THIS_LAUNCHS_LEFT_AS_IT_IS'),
                             ({'doorChanged': True}, 'INSTALLED_RESUME_DOOR_NOT_AS_REVIEWED')):
            r = self.probe(line='ROOT_RUN_EXITED 1', **case)
            self.assertEqual((r['terminal']['w1Pause']['restored'], r['terminal']['w1Pause']['reason'], r['children'], r['pausedStill']), (False, reason, [], True), case)
        r = self.probe(line='ROOT_RUN_EXITED 1', paused=False)
        self.assertEqual((r['terminal']['w1Pause']['reason'], r['children']), ('NOT_PAUSED', []))

    def test_a_resume_that_is_refused_or_not_confirmed_is_said_so(self):
        r = self.probe(line='ROOT_RUN_EXITED 1', doorRefuses=True, serviceResumes=False)
        self.assertEqual((r['terminal']['w1Pause']['restored'], r['terminal']['w1Pause']['reason'], r['pausedStill']), (False, 'RESUME_REQUEST_REFUSED', True))
        r = self.probe(line='ROOT_RUN_EXITED 1', serviceResumes=False)
        self.assertEqual((r['terminal']['w1Pause']['restored'], r['terminal']['w1Pause']['reason'], r['pausedStill']), (False, 'RESUME_REQUESTED_NOT_CONFIRMED_IN_TIME', True))

    def test_a_stop_after_phase_a_was_started_leaves_the_pause(self):
        r = self.probe(line='ROOT_RUN_EXITED 1', armed=False)   # not armed: the launch is past the point where nothing has changed
        self.assertEqual((r['stopped'], r['terminal']['w1Pause'], r['children'], r['pausedStill']), ('LINUX_OUT_ACL_PROBE_FAILED', None, [], True))
        template = TEMPLATE.read_text(encoding='utf-8')
        main = template.split('#region main', 1)[1]
        self.assertLess(main.index('if ($FleetPlanSha256) {'), main.index('$W1Restore.armed = $true')); self.assertLess(main.index('$W1Restore.armed = $true'), main.index('Step-WindowsPreflightBeforeLinux'))
        root = template.split('function Step-LinuxRoot', 1)[1].split('#endregion generic', 1)[0]
        order = [root.index(x) for x in ('New-FleetRegistrar', "Step-LinuxOutAclProbe $exe", '$W1Restore.armed = $false', "$a = Invoke-FleetLinuxScript 'A' $exe", "if ($a.outcome -ceq 'REFUSED') { if (Test-FleetRefusedBeforeAnyChange $a.code) { $W1Restore.armed = $true }", "Invoke-FleetLinuxScript 'B'")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(root.count('$W1Restore.armed = $true'), 1)   # re-armed only when the registrar refused phase A before running anything
        self.assertRegex(main, r'\} catch \{\n  Remove-FleetCarry\n  Restore-W1Pause\n')

    def test_the_probe_is_the_real_run_layout_and_the_capture_is_what_is_read(self):
        template = TEMPLATE.read_text(encoding='utf-8')
        probe = template.split('function Step-LinuxOutAclProbe', 1)[1].split('\nfunction ', 1)[0]
        self.assertIn("$run = New-FleetRunDirectory 'probe' -Probe", probe)   # the same function as a real run: one layout, one set of ACLs
        self.assertIn("('write-probe ' + $ResidentRoot + ' ' + $run.directory + ' 120')", probe)
        self.assertNotIn("Read-FleetFileChecked $run.out", probe); self.assertIn("Read-FleetFileChecked $run.captured 'stdout.txt'", probe)
        run = template.split('function New-FleetRunDirectory', 1)[1].split('\nfunction ', 1)[0]
        self.assertIn("$captured = New-FleetCaptureDirectory $dir 'captured'", run)   # the one function that makes a capture directory
        capture = template.split('function New-FleetCaptureDirectory', 1)[1].split('\nfunction ', 1)[0]
        self.assertIn("[string]$leaf = ('captured-' + [Guid]::NewGuid().ToString('N'))", capture); self.assertIn("$leaf -cnotmatch '^captured(?:-[0-9a-f]{32})?$'", capture)
        self.assertIn("$cs.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')", capture)   # SYSTEM and Administrators only, as the registrar requires of a destination
        self.assertIn("-or -not $back.AreAccessRulesProtected -or $back.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544'", capture)
        self.assertEqual(template.count("Join-Path $dir 'captured'"), 0); self.assertIn('function Get-FleetRunProcesses([string]$runDirectory)', template)
        self.assertEqual(run.count("$(if ($Probe) { '-probe' } else { '' })"), 1)
        # on a companion node nothing the account can still write is read: stdout and stderr from captured\, B's files through capture-file
        self.assertIn("function Get-FleetRunOutputDirectory($run) { if ($FleetCompanionAccount) { $run.captured } else { $run.out } }", template)
        out_file = template.split('function Read-FleetOutFile', 1)[1].split('\nfunction ', 1)[0]
        self.assertIn("('capture-file ' + (Join-Path $FleetOutDir $leaf) + ' ' + (Join-Path $run.captured $leaf))", out_file); self.assertIn(", (Read-FleetFileChecked $run.captured $leaf $max)", out_file)
        self.assertIn("if (-not $FleetCompanionAccount) { return , (Read-FleetFileChecked $FleetOutDir $leaf $max) }", out_file)
        registrar = (ROOT.parent / 'windows' / 'CompanionTaskRegistrar.cs').read_text(encoding='utf-8')
        self.assertIn('OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000', registrar); self.assertIn('GetFileInformationByHandle(h, out info)', registrar)
        self.assertIn('System.IO.FileMode.CreateNew', registrar.split('static string CaptureOne', 1)[1].split('static string RootRunScriptRefusal', 1)[0])


if __name__ == '__main__':
    unittest.main()
