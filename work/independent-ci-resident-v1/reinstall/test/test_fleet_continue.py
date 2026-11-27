"""Continuing a package reinstall that stopped or was cut off part of the way (generate.py --fleet-continue, launcher/continue.py,
launcher/continue-install.ps1). Offline: a prior launcher made from the template with fixture pins, a prior launch directory of fixture
reports and progress records, a stand-in CI root with a kept root and stand-in tokens. Nothing is elevated, no real root, secret or
service is touched."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / 'launcher'
POWERSHELL = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
_spec = importlib.util.spec_from_file_location('fleet_continue', LAUNCHER / 'continue.py')
CONTINUE = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(CONTINUE)
sha = lambda b: hashlib.sha256(b).hexdigest()
SOURCE, LINUX_MANIFEST, PACKAGE, RECEIPT, UNINSTALL_RECEIPT = 'a' * 64, 'b' * 64, 'c' * 64, 'd' * 64, 'e' * 64
KEPT_NAME = 'resident-uninstalled-20261112T100000Z-0123456789ab'
EVIDENCE = 'source: reinstall-linux-B (root, Owner)\npackage: %s\ncapturedAt: 2026-11-12T10:00:00Z\nexit: 0\nsha256: %s\n' % (PACKAGE, SOURCE)
FACTS = {'contract': 'clued.independent-ci.linux-version-facts/1', 'generation': 1, 'staged': None, 'ciSourceManifestSha256': SOURCE, 'manifestSha256': LINUX_MANIFEST, 'pinsOk': True}
LINUX_DONE = ['output', 'package', 'stage', 'windows-preflight-before-linux', 'tokens-carried', 'file-locks', 'linux-A', 'linux-B', 'linux-output-checked']
UNINSTALLED = LINUX_DONE + ['uninstall-preflight', 'parent-acl-checked', 'quiesce', 'uninstall', 'preflight']
# stand-ins, assembled here so that no scanner reads a literal token
UPGRADE = 'clued' + '_bnd_' + 'Kept123_-' * 5
HEARTBEAT = 'clued' + '_hbt_' + 'k' * 43


def run_process_pids(produced, launch='launch'):
    """The pids continue-report.json records as the prior run's processes (Get-FleetRunProcesses' entries, each one process)."""
    found = json.loads(produced[os.path.join(launch, 'continue-report.json')].decode('utf-8'))['state']['runProcesses']
    return [x.get('pid') if isinstance(x, dict) else x for x in found]


def fingerprint(kind, token):
    domain = {'ci-token': 'clued.independent-ci.ci-binding-pin/1\0', 'heartbeat-token': 'clued.independent-ci.heartbeat-token-pin/1\0'}[kind]
    return hashlib.sha256((domain + token.strip()).encode()).hexdigest()


class Scene:
    """A work directory with the prior launcher and its launch directory, and a stand-in CI root."""
    def __init__(self, directory, completed=UNINSTALLED):
        self.root = Path(directory)
        self.work = self.root / 'work'; self.prior = self.work / 'launch-20261112T090000Z'; self.prior.mkdir(parents=True)
        self.ci = self.root / 'ci'; self.kept = self.ci / KEPT_NAME; (self.kept / 'install').mkdir(parents=True)
        names = set(re.findall(r"'\$(\w+) = ", (LAUNCHER / 'generate.py').read_text(encoding='utf-8'))) - {'Staged', 'Leftovers', 'R5c'}
        self.pins = {name: "'fixture'" for name in names}
        self.pins.update(DraftOnly='$false', SourceSha="'" + '1' * 40 + "'", PackageHead="'" + '2' * 40 + "'", W="'" + str(self.work) + "'", LaunchOutPin="'" + str(self.prior) + "'",
                         InstalledReceiptSha256="'" + RECEIPT + "'", FleetPlanSha256="'" + '9' * 64 + "'", CiSourceManifestSha256="'" + SOURCE + "'", PackageManifestSha256="'" + PACKAGE + "'",
                         FleetLinuxManifestSha256="'" + LINUX_MANIFEST + "'", NodeName="'node-a'", FleetFirstInstall='$null', FleetFirstInstallDirectory='$null')
        self.terminal = {'contract': 'clued.independent-ci.source-v2-windows-launch-terminal/1', 'status': 'STOPPED', 'code': 'INSTALL_NOT_COMPLETED', 'detail': {'exit': 1, 'residentRootExists': False},
                         'completed': list(completed), 'sourceSha': '1' * 40, 'packageHead': '2' * 40, 'carriedTokens': {'removed': True}}
        self.progress = None   # None: one record per completed step
        self.uninstall = {'apply': {'exit': 0, 'status': 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT', 'keptAt': str(self.kept)}, 'deletedAndRenamed': True,
                          'evidence': {'keptAt': str(self.kept), 'installReceiptSha256': RECEIPT, 'uninstallReceiptSha256': UNINSTALL_RECEIPT, 'terminalEvidenceMatches': True}}
        self.evidence, self.facts = EVIDENCE.encode(), json.dumps(FACTS).encode()
        self.linux = None
        self.extra = {}   # further prior launch files (name -> bytes)
        self.launcher = self.work / 'launcher.ps1'

    def progress_names(self):
        steps = self.terminal['completed'] if self.progress is None else self.progress
        return ['%03d-%s.json' % (i + 1, s) for i, s in enumerate(steps)], steps

    def elevated_progress(self):
        return self.ci / ('reinstall-progress-' + sha(str(self.prior).lower().encode())[:32])

    def write(self, terminal=True, elevated=True):
        block = '\n'.join('$' + name + ' = ' + value for name, value in sorted(self.pins.items()))
        block += '\n$Staged = [ordered]@{\n' + ''.join("  '" + n + "' = @('fixture/" + n + "', '" + 'f' * 64 + "')\n" for n in ['install-resident.ps1', 'verify-resident.ps1', 'migrate-acl.ps1', 'acl-model.json'])
        block += '}\n$Leftovers = [ordered]@{\n}\n$R5c = @{ applyPlanSha256 = $null; factsStaged = $null }   # r5c: set by Test-TokenPlan / Get-VerifyFactsArgs'
        self.launcher.write_bytes((LAUNCHER / 'template.ps1').read_text(encoding='utf-8').replace('#PINS#', block).encode('utf-8'))
        linux = self.linux or {'codes': [], 'planSha256': '9' * 64, 'versionFactsSha256': sha(self.facts), 'evidenceSha256': sha(self.evidence)}
        files = {'intent.json': b'{}', 'uninstall-report.json': json.dumps(self.uninstall).encode(), 'linux-report.json': json.dumps(linux).encode(),
                 'linux-version-facts.json': self.facts, 'linux-live-manifest.txt': self.evidence, 'migrate-acl.dry-run.before-uninstall.stdout.json': b'{"status":"SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN"}'}
        files.update(self.extra)
        if terminal:
            files['terminal.json'] = json.dumps(self.terminal).encode()
        for name, data in files.items():
            (self.prior / name).write_bytes(data)
        names, steps = self.progress_names()
        for directory in [self.prior / 'progress'] + ([self.elevated_progress()] if elevated else []):
            directory.mkdir(parents=True, exist_ok=True)
            for stale in directory.iterdir():
                stale.unlink()
            for i, (name, step) in enumerate(zip(names, steps)):
                (directory / name).write_text(json.dumps({'contract': 'clued.independent-ci.reinstall-launch-progress/1', 'index': i + 1, 'step': step, 'at': '2026-11-12T09:00:00Z', 'pid': 99999999,
                                                          'processStart': '2026-11-12T09:00:00.0000000Z', 'pins': {'sourceSha': '1' * 40, 'packageHead': '2' * 40}}), encoding='utf-8')
        return self


@unittest.skipUnless(os.name == 'nt', 'Windows paths are the source contract')
class ContinueGenerator(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fleet-continue-'); self.addCleanup(self.tmp.cleanup)
        self.s = Scene(self.tmp.name)

    def build(self, **kw):
        self.s.write(**kw)
        return CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=datetime.datetime(2026, 11, 12, 11, 0, 0, tzinfo=datetime.timezone.utc))

    def refused(self, code, **kw):
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(**kw)
        self.assertEqual(caught.exception.code, code, caught.exception.detail)
        return caught.exception

    def parses(self, data):
        if POWERSHELL.is_file():
            out = self.s.root / ('continuation-%d.ps1' % len(data)); out.write_bytes(data)
            p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-Command', '$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile($env:CONTINUATION,[ref]$t,[ref]$e); $e.Count'],
                               capture_output=True, text=True, env=dict(os.environ, CONTINUATION=str(out)), timeout=60)
            self.assertEqual(p.stdout.strip(), '0', p.stderr)

    def test_the_reviewed_template_and_fragment_only(self):
        fragment = (LAUNCHER / 'continue-install.ps1').read_bytes().replace(b'\r\n', b'\n')
        self.assertEqual(CONTINUE.CONTINUE_FRAGMENT_SHA, sha(fragment))   # a changed fragment must change its pin in the same delivery
        source = (LAUNCHER / 'continue.py').read_text(encoding='utf-8')
        self.assertIn("need(len(pins) == 1 and sha(template.encode('utf-8')) == pins[0], 'TEMPLATE_NOT_THE_REVIEWED_ONE')", source)
        self.assertIn("== CONTINUE_FRAGMENT_SHA, 'CONTINUE_FRAGMENT_NOT_THE_REVIEWED_ONE')", source)
        self.assertLess(source.index('fragment, finish = reviewed_sources()'), source.index('raw = RESUME.read_plain(prior_launcher)'))   # before anything is read
        self.assertEqual(CONTINUE.FINISH_FRAGMENT_SHA, sha((LAUNCHER / 'finish-uninstall.ps1').read_bytes().replace(b'\r\n', b'\n')))   # resume.py's fragment with the cut-off evidence branch: a changed one changes its pin
        self.assertIn("== FINISH_FRAGMENT_SHA, 'FINISH_FRAGMENT_NOT_THE_REVIEWED_ONE')", source)

    def test_after_the_uninstall_the_continuation_starts_at_the_install_preflight(self):
        data, facts = self.build()
        text = data.decode('utf-8')
        original = self.s.launcher.read_text(encoding='utf-8')
        launch = str(self.s.work / 'launch-continue-20261112T110000Z')
        self.assertEqual((facts['mode'], facts['launchDir'], facts['keptRoot'], facts['priorLaunchDir'], facts['priorStopCode'], facts['priorHadTerminal'], facts['priorLastStep'], facts['originalLauncherSha256']),
                         ('after-uninstall', launch, str(self.s.kept), str(self.s.prior), 'INSTALL_NOT_COMPLETED', True, 'preflight', sha(self.s.launcher.read_bytes())))
        self.assertIn("\n$LaunchOutPin = '" + launch + "'", text); self.assertNotIn("$LaunchOutPin = '" + str(self.s.prior) + "'", text)
        self.assertIn("\n$ContinuePriorRoot = '" + str(self.s.prior) + "'\n$ContinuePriorPins = [ordered]@{\n", text)
        self.assertEqual(sorted(facts['priorFileSha256']), ['linux-live-manifest.txt', 'linux-report.json', 'linux-version-facts.json', 'migrate-acl.dry-run.before-uninstall.stdout.json', 'terminal.json', 'uninstall-report.json'])
        for name, digest in facts['priorFileSha256'].items():
            self.assertEqual(digest, sha((self.s.prior / name).read_bytes())); self.assertIn("  '" + name + "' = '" + digest + "'\n", text)
        self.assertIn("\n$ContinuePriorProgress = '" + '|'.join(self.s.progress_names()[0]) + "'\n$ContinuePriorPid = 99999999\n$ContinuePriorProcessStart = '2026-11-12T09:00:00.0000000Z'\n", text)
        self.assertIn("\n$ContinueKeptRoot = '" + str(self.s.kept) + "'\n$ContinueUninstallReceiptSha256 = '" + UNINSTALL_RECEIPT + "'\n", text)
        main = text.split('#region main', 1)[1]
        for gone in ('Step-LinuxRoot', 'Step-FileLocks', 'Step-WindowsPreflightBeforeLinux', 'Step-UninstallPreflight', 'Step-Quiesce', '$uninstall = Step-Uninstall', '$parentAcl = Step-ParentAcl'):
            self.assertNotIn(gone, main, gone)   # nothing of Linux or of the uninstall runs again
        tail = '  $archiveNeeded = Step-Preflight\n'
        self.assertIn(CONTINUE.NEW_AFTER + tail, main)
        self.assertEqual(main.split(tail, 1)[1], original.split('#region main', 1)[1].split(tail, 1)[1])   # from the install preflight on: the prior launcher's own text
        self.assertEqual(main.split('try {', 1)[0], original.split('#region main', 1)[1].split('try {', 1)[0])   # identity, hygiene, the sweep, output
        fragment = (LAUNCHER / 'continue-install.ps1').read_text(encoding='utf-8')
        self.assertIn(fragment + '#endregion generic', text)
        self.assertEqual(text.replace(fragment, '').split('#region main', 1)[0].split('#endregion pins', 1)[1], original.split('#region main', 1)[0].split('#endregion pins', 1)[1])   # no other function changed
        self.parses(data)

    def test_before_the_uninstall_the_continuation_starts_at_the_uninstall_preflight(self):
        self.s = Scene(self.tmp.name + '-b', completed=LINUX_DONE); self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp.name + '-b', ignore_errors=True))
        self.s.terminal.update(code='UNINSTALL_PLAN_REFUSED', detail={})
        (self.s.ci / 'resident').mkdir()   # still installed
        data, facts = self.build()
        text = data.decode('utf-8'); original = self.s.launcher.read_text(encoding='utf-8')
        self.assertEqual((facts['mode'], facts['keptRoot'], facts['priorStopCode']), ('before-uninstall', None, 'UNINSTALL_PLAN_REFUSED'))
        self.assertEqual(sorted(facts['priorFileSha256']), ['linux-live-manifest.txt', 'linux-report.json', 'linux-version-facts.json', 'terminal.json'])
        self.assertIn("\n$ContinueLinuxFrom = 'prior-launch'\n$ContinueLastRunDirectory = $null\n", text)
        main = text.split('#region main', 1)[1]
        tail = '  Step-UninstallPreflight\n'
        self.assertIn(CONTINUE.NEW_BEFORE + tail, main)
        self.assertEqual(main.split(tail, 1)[1], original.split('#region main', 1)[1].split(tail, 1)[1])   # the uninstall preflight, the uninstall and all after: the launcher's own
        for gone in ('Step-LinuxRoot', 'Step-WindowsPreflightBeforeLinux', '$carried = Step-CarryTokens'):
            self.assertNotIn(gone, main, gone)
        self.parses(data)
        # cut off there without a terminal: the progress records say the same
        (self.s.prior / 'terminal.json').unlink()
        data, facts = CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual((facts['mode'], facts['priorHadTerminal'], facts['priorStopCode'], facts['priorLastStep']), ('before-uninstall', False, None, 'linux-output-checked'))
        self.assertNotIn('terminal.json', facts['priorFileSha256'])
        (self.s.ci / 'resident').rmdir()
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual(caught.exception.code, 'RESIDENT_ROOT_MISSING_NOT_CONTINUED')

    def test_the_field_stop_after_linux_b_is_continued_even_after_its_w1_pause_was_lifted(self):
        # DESIGN section 73, desk-w-591 on 2026-11-13: Linux A and B done, the launch stopped at its uninstall preflight
        # (RUNNER_SERVICE_NOT_AS_REVIEWED: the paused resident's own maintenance swap was under way), and afterwards a person lifted the W1
        # pause. The launcher requires state\PAUSED.json to be the pinned bytes, so that node could not be continued at all.
        self.s = Scene(self.tmp.name + '-w1', completed=LINUX_DONE); self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp.name + '-w1', ignore_errors=True))
        reason, first = 'fleet-node-reinstall-2026-11-13-8238bbf2-w1-before-linux-switch', b'{"at":"2026-11-13T09:09:58Z","source":{"reason":"w1"}}'
        self.s.pins.update(InstalledPausedSha256="'" + sha(first) + "'", FleetW1PauseReason="'" + reason + "'", InstalledHaltSha256='$null', InstalledHaltCode='$null')
        self.s.terminal.update(code='RUNNER_SERVICE_NOT_AS_REVIEWED', detail={'codes': ['RUNNER_SERVICE_NOT_AS_REVIEWED', 'UNINSTALL_PLAN_REFUSED']})
        live = self.s.ci / 'resident'
        for d in ('state/ledger', 'requests'):
            (live / d).mkdir(parents=True)
        status = {'contract': 'clued.independent-ci.resident-status/8', 'writtenAt': 'x', 'executor': {'state': 'IDLE'}, 'paused': False, 'halt': None, 'current': None}
        (live / 'state/status.json').write_text(json.dumps(status), encoding='utf-8')
        spec = importlib.util.spec_from_file_location('pause_old_resident', ROOT / 'tools' / 'pause-old-resident.py')
        tool = importlib.util.module_from_spec(spec); spec.loader.exec_module(tool)
        asked = []

        def resident(_seconds):   # the installed resident: it takes the request and acknowledges the pause between batches
            (name,) = os.listdir(live / 'requests')
            request = (live / 'requests' / name).read_bytes()
            (live / 'state/PAUSED.json').write_text(json.dumps({'at': '2026-11-13T10:02:11Z', 'source': {'reason': json.loads(request)['reason'], 'requestSha256': sha(request)}}), encoding='utf-8')
            (live / 'state/status.json').write_text(json.dumps(dict(status, executor={'state': 'PAUSED'}, paused=True)), encoding='utf-8')

        def w1(pause_reason, pause_root):
            asked.append((pause_reason, pause_root))
            return tool.run_pause(pause_reason, root=pause_root, sleep=resident)['pausedSha256']
        self.s.write()
        now = datetime.datetime(2026, 11, 13, 10, 5, 0, tzinfo=datetime.timezone.utc)
        data, facts = CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=now, pause=w1)
        again = sha((live / 'state/PAUSED.json').read_bytes())
        self.assertEqual((facts['mode'], facts['priorStopCode'], facts['w1PausedAgainSha256'], asked), ('before-uninstall', 'RUNNER_SERVICE_NOT_AS_REVIEWED', again, [(reason, str(live))]))
        self.assertNotEqual(again, sha(first))
        self.assertEqual(json.loads((live / 'requests' / os.listdir(live / 'requests')[0]).read_bytes()), {'contract': 'clued.independent-ci.resident-pause/1', 'reason': reason})
        text = data.decode('utf-8')
        self.assertIn("\n$InstalledPausedSha256 = '" + again + "'", text); self.assertNotIn(sha(first), text)
        self.assertIn(CONTINUE.NEW_BEFORE + '  Step-UninstallPreflight\n', text.split('#region main', 1)[1])
        self.parses(data)
        # the launcher's own rule (Test-OldRootQuiet), run from each text against that root: the stopped launcher refuses the node for
        # ever, the continuation accepts it
        if POWERSHELL.is_file():
            driver = self.s.root / 'quiet.ps1'
            driver.write_text(r'''param([string]$Launcher, [string]$Root)
$ErrorActionPreference = 'Stop'
$t = [IO.File]::ReadAllText($Launcher)
$U8 = New-Object Text.UTF8Encoding($false)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($t, [ref]$tokens, [ref]$errors)
foreach ($name in @('Read-StatusBytes', 'Sha256Bytes', 'Get-FileSha', 'Get-Key', 'Parse-Json', 'Test-OldRootQuiet')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw 'FUNCTION_MISSING_OR_DUPLICATED' }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
$InstalledPausedSha256 = [regex]::Match($t, "(?m)^\`$InstalledPausedSha256 = '([0-9a-f]{64})'").Groups[1].Value
$InstalledHaltSha256 = $null; $InstalledHaltCode = $null; $ResidentRoot = $Root
ConvertTo-Json -Compress @((Test-OldRootQuiet).codes)
''', encoding='utf-8')
            def quiet(launcher):
                p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(driver), str(launcher), str(live)], capture_output=True, text=True, timeout=60)
                self.assertEqual(p.returncode, 0, p.stderr)
                return json.loads(p.stdout or '[]')
            continuation = self.s.work / 'launcher-continue.ps1'; continuation.write_bytes(data)
            self.assertEqual(quiet(self.s.launcher), ['OLD_RESIDENT_PAUSE_NOT_THE_W1_ONE'])
            self.assertEqual(quiet(continuation), [])
        # the same command again: the pause it requested is in force, so no second request is written and the same pause is pinned
        data2, facts2 = CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=now + datetime.timedelta(minutes=5), pause=w1)
        self.assertEqual((facts2['w1PausedAgainSha256'], len(os.listdir(live / 'requests'))), (again, 1))
        # the pause of the stopped launch still in force (nobody lifted it): nothing is asked and the pin stays
        (live / 'state/PAUSED.json').write_bytes(first)
        data3, facts3 = CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=now, pause=lambda *a: self.fail('the pinned pause is in force'))
        self.assertIsNone(facts3['w1PausedAgainSha256']); self.assertIn("\n$InstalledPausedSha256 = '" + sha(first) + "'", data3.decode('utf-8'))
        # a pause that is another request's is never taken for W1: refused with the tool's own report
        (live / 'state/PAUSED.json').write_text(json.dumps({'source': {'reason': 'owner-maintenance', 'requestSha256': 'a' * 64}}), encoding='utf-8')
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=now)   # W1 itself, on this root
        self.assertEqual((caught.exception.code, caught.exception.detail['status']), ('W1_PAUSE_NOT_CONFIRMED', 'OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED'))

    def test_a_phase_b_timeout_is_decided_when_the_continuation_runs(self):
        self.s = Scene(self.tmp.name + '-t', completed=LINUX_DONE[:7]); self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp.name + '-t', ignore_errors=True))
        run = str(self.s.ci / 'resident' / 'install' / ('linux-run-' + '7' * 32))
        self.s.terminal.update(code='LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', detail={})
        self.s.linux = {'codes': ['LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED'], 'runs': [{'name': 'A', 'outcome': 'EXITED', 'directory': 'x'}, {'name': 'B', 'outcome': 'TIMEOUT', 'directory': run}]}
        (self.s.ci / 'resident').mkdir()
        data, facts = self.build()
        text = data.decode('utf-8')
        self.assertEqual((facts['mode'], sorted(facts['priorFileSha256'])), ('b-timeout', ['linux-report.json', 'terminal.json']))
        self.assertIn("\n$ContinueLinuxFrom = 'out-directory'\n$ContinueLastRunDirectory = '" + run + "'\n", text)
        self.assertIn(CONTINUE.NEW_BEFORE + '  Step-UninstallPreflight\n', text.split('#region main', 1)[1])
        self.parses(data)
        self.s.linux['runs'][-1]['name'] = 'A'   # phase A's timeout: B never ran (continued as a-timeout: test_fleet_continue_resume_points.py)
        self.s.terminal['completed'] = LINUX_DONE[:6]
        for f in (self.s.prior / 'progress').iterdir():
            f.unlink()
        self.assertEqual(self.build()[1]['mode'], 'a-timeout')
        self.s.terminal.update(completed=LINUX_DONE[:5], code='LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED')   # before the file locks: no Linux phase ran
        for f in (self.s.prior / 'progress').iterdir():
            f.unlink()
        self.refused('PRIOR_LAUNCH_STOPPED_BEFORE_LINUX_PHASE_A_COMPLETED_PREPARE_AGAIN')

    def test_what_this_version_does_not_continue_is_named(self):
        (self.s.ci / 'resident').mkdir()
        for completed, code, stop in ((LINUX_DONE + ['uninstall-preflight', 'parent-acl-checked', 'quiesce'], 'PRIOR_LAUNCH_STOPPED_INSIDE_THE_UNINSTALL_NOT_A_FAILED_APPLY', 'UNINSTALL_PLAN_REFUSED'),
                                      (LINUX_DONE + ['uninstall-preflight', 'parent-acl-checked', 'quiesce'], 'PRIOR_LAUNCH_STOPPED_INSIDE_THE_UNINSTALL_NOT_A_FAILED_APPLY', 'UNINSTALL_EVIDENCE_OR_DELETION_UNCONFIRMED'),
                                      (LINUX_DONE[:7], 'PRIOR_LINUX_PHASE_B_DID_NOT_COMPLETE_NODE_STAYS_PAUSED', 'LINUX_PHASE_B_NOT_COMPLETED'), (LINUX_DONE[:6], 'PRIOR_LAUNCH_STOPPED_BEFORE_LINUX_PHASE_A_COMPLETED_PREPARE_AGAIN', 'LINUX_PHASE_A_NOT_COMPLETED'),
                                      (LINUX_DONE[:3], 'PRIOR_LAUNCH_STOPPED_BEFORE_LINUX_PHASE_A_COMPLETED_PREPARE_AGAIN', 'INSTALLED_RECEIPT_NOT_AS_REVIEWED')):
            for f in list((self.s.prior / 'progress').iterdir()) if (self.s.prior / 'progress').is_dir() else []:
                f.unlink()
            self.s.terminal.update(completed=list(completed), code=stop, detail={})
            self.assertEqual(self.refused(code).detail, stop)
        source = (LAUNCHER / 'continue.py').read_text(encoding='utf-8')
        self.assertNotIn('simply run again', source); self.assertNotIn('重跑即可', (ROOT / 'README.md').read_text(encoding='utf-8')); self.assertNotIn('重跑或重新 prepare 即可', (ROOT / 'README.md').read_text(encoding='utf-8'))

    def test_the_state_of_the_prior_launch_must_be_unambiguous(self):
        keep = dict(self.s.terminal)
        for change, code in ((dict(status='R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED'), 'PRIOR_LAUNCH_DID_NOT_STOP_NOTHING_TO_CONTINUE'), (dict(detail={'residentRootExists': True}), 'PRIOR_INSTALL_LEFT_A_ROOT_NOT_CONTINUED'),
                             (dict(detail={}), 'PRIOR_INSTALL_LEFT_A_ROOT_NOT_CONTINUED'), (dict(sourceSha='3' * 40), 'PRIOR_TERMINAL_NOT_THIS_LAUNCHERS'), (dict(contract='x'), 'PRIOR_TERMINAL_NOT_THIS_LAUNCHERS')):
            self.s.terminal = dict(keep); self.s.terminal.update(change)
            self.refused(code)
        self.s.terminal = dict(keep)
        self.s.progress = UNINSTALLED[:-2]   # the progress records and the terminal of one launch disagree
        self.refused('PRIOR_PROGRESS_NOT_THE_TERMINALS')
        self.s.progress = None
        self.s.terminal.update(code='PLAN_CHANGED_SINCE_REVIEW', detail={'anything': 1})   # a stop of the install's own preflight is continued
        for f in (self.s.prior / 'progress').iterdir():
            f.unlink()
        self.build()

    def test_a_cut_off_launch_is_known_by_its_progress_records(self):
        data, facts = self.build(terminal=False)
        self.assertEqual((facts['mode'], facts['priorHadTerminal'], facts['priorStopCode'], facts['priorLastStep']), ('after-uninstall', False, None, 'preflight'))
        for f in (self.s.prior / 'progress').iterdir():
            f.unlink()
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual(caught.exception.code, 'PRIOR_LAUNCH_HAS_NO_PROGRESS_RECORDS')
        (self.s.prior / 'progress' / '001-output.json').write_text('{"contract":"x"}', encoding='utf-8')
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual(caught.exception.code, 'PRIOR_PROGRESS_REFUSED')

    def test_missing_prior_evidence_is_named_not_guessed(self):
        self.s.write()
        (self.s.prior / 'uninstall-report.json').unlink()
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual((caught.exception.code, caught.exception.detail), ('PRIOR_EVIDENCE_MISSING', 'uninstall-report.json'))
        (self.s.prior / 'intent.json').unlink()
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual(caught.exception.code, 'PRIOR_LAUNCH_NEVER_STARTED')

    def test_the_kept_root_must_be_the_prior_uninstalls_and_the_newest(self):
        (self.s.ci / 'resident-uninstalled-20261001T000000Z-aaaaaaaaaaaa').mkdir()   # older kept roots are normal
        self.build()
        newer = self.s.ci / 'resident-uninstalled-20261112T100001Z-bbbbbbbbbbbb'; newer.mkdir()
        self.refused('KEPT_ROOT_NOT_THE_NEWEST_SOMETHING_WAS_UNINSTALLED_SINCE')
        newer.rmdir()
        (self.s.ci / 'resident').mkdir()
        self.refused('RESIDENT_ROOT_PRESENT_NOT_CONTINUED')
        (self.s.ci / 'resident').rmdir()
        for change, code in ((lambda u: u['evidence'].update(installReceiptSha256='0' * 64), 'PRIOR_UNINSTALL_NOT_OF_THE_PINNED_INSTALL'), (lambda u: u['evidence'].update(terminalEvidenceMatches=False), 'PRIOR_UNINSTALL_NOT_OF_THE_PINNED_INSTALL'),
                             (lambda u: u['apply'].update(keptAt=str(self.s.root / 'elsewhere' / KEPT_NAME)), 'PRIOR_UNINSTALL_REPORT_REFUSED'), (lambda u: u.update(deletedAndRenamed=False), 'PRIOR_UNINSTALL_REPORT_REFUSED'),
                             (lambda u: u['apply'].update(keptAt=str(self.s.ci / 'resident-kept')), 'PRIOR_UNINSTALL_REPORT_REFUSED')):
            keep = json.loads(json.dumps(self.s.uninstall)); change(self.s.uninstall)
            self.refused(code)
            self.s.uninstall = keep
        (self.s.kept / 'install').rmdir(); self.s.kept.rmdir()
        self.refused('KEPT_ROOT_MISSING')

    def test_phase_b_output_is_the_reported_bytes_and_passes_the_rules_again(self):
        self.s.linux = {'codes': [], 'planSha256': '9' * 64, 'versionFactsSha256': '0' * 64, 'evidenceSha256': sha(self.s.evidence)}
        self.refused('PRIOR_LINUX_OUTPUT_NOT_THE_REPORTED_BYTES')   # a facts file changed after the launch wrote its report
        self.s.linux = None
        self.s.facts = json.dumps(dict(FACTS, generation=2)).encode()   # consistent with its report, but not this package's generation 1
        self.refused('PRIOR_LINUX_OUTPUT_NOT_AS_EXPECTED')
        self.s.facts = json.dumps(FACTS).encode(); self.s.evidence = EVIDENCE.replace(PACKAGE, '0' * 64).encode()
        self.refused('PRIOR_LINUX_OUTPUT_NOT_AS_EXPECTED')

    def test_only_this_templates_unchanged_package_launcher(self):
        self.s.pins['FleetPlanSha256'] = '$null'
        self.refused('PRIOR_LAUNCHER_NOT_A_PACKAGE_LAUNCHER')
        self.s.pins['FleetPlanSha256'] = "'" + '9' * 64 + "'"
        # a first install's launch (the first-install plan) is not continued by this version, named
        self.s.pins['FleetFirstInstall'] = '$true'
        self.refused('PRIOR_LAUNCHER_IS_A_FIRST_INSTALL_NOT_CONTINUED')
        self.s.pins['FleetFirstInstall'] = '$null'
        self.s.write()
        (self.s.work / 'install-plan.json').write_text(json.dumps({'launcher': {'path': 'x', 'sha256': '0' * 64}}), encoding='utf-8')
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual(caught.exception.code, 'PRIOR_LAUNCHER_NOT_THE_PLANS')
        (self.s.work / 'install-plan.json').write_text(json.dumps({'launcher': {'path': 'x', 'sha256': sha(self.s.launcher.read_bytes())}}), encoding='utf-8')
        data, _ = CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        (self.s.work / 'install-plan.json').unlink()
        original = self.s.launcher.read_bytes()
        self.s.launcher.write_bytes(original.replace(b'function Step-Install {', b'function Step-Install { #'))
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual(caught.exception.code, 'PRIOR_LAUNCHER_REFUSED')
        self.s.launcher.write_bytes(data)   # a continuation is read back as one: its own launch directory (not there yet) is the prior launch
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual((caught.exception.code, os.path.dirname(caught.exception.detail), os.path.basename(caught.exception.detail)[:16]), ('PRIOR_LAUNCH_NEVER_STARTED', str(self.s.work), 'launch-continue-'))
        self.s.launcher.write_bytes(data.replace(b'function Step-Install {', b'function Step-Install { #'))   # changed: not a continuation of this template
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci))
        self.assertEqual((caught.exception.code, caught.exception.detail), ('PRIOR_LAUNCHER_REFUSED', 'NOT_A_CONTINUATION_OF_THIS_TEMPLATE'))

    def test_the_command_is_generate_py_with_two_paths_and_no_node_value(self):
        generate = str(LAUNCHER / 'generate.py')
        missing = str(self.s.root / 'no-such-launcher.ps1')
        p = subprocess.run([sys.executable, '-I', generate, '--fleet-continue', missing, '--out', str(self.s.root / 'new.ps1')], capture_output=True, text=True)
        self.assertEqual((p.returncode, json.loads(p.stdout)['status'], json.loads(p.stdout)['code']), (3, 'REFUSED', 'PRIOR_LAUNCHER_REFUSED'))
        p = subprocess.run([sys.executable, '-I', generate, '--fleet-continue', missing, '--out', str(self.s.root / 'new.ps1'), '--node', 'x'], capture_output=True, text=True)
        self.assertEqual((p.returncode, json.loads(p.stdout)['code'][:5]), (3, 'USAGE'))
        self.assertFalse((self.s.root / 'new.ps1').exists())


DRIVER = r"""
param([string]$Template, [string]$Fragment, [string]$Case, [string]$Work)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$FleetFirstInstall = $null; $FleetFirstInstallDirectory = $null   # a reinstall launcher's pins (generate.py)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$c = Get-Content -LiteralPath $Case -Raw -Encoding UTF8 | ConvertFrom-Json
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Template, [ref]$tokens, [ref]$errors)
foreach ($name in @('Sha256Bytes', 'Write-New', 'Write-Json', 'Get-Key', 'Parse-Json', 'Parse-LastLine', 'Get-FileSha', 'Stop-Launch', 'Test-FleetLinuxOutput', 'Get-FleetOutFile', 'Read-FleetFileChecked', 'Get-FleetTokenFingerprint', 'Remove-FleetCarry', 'Step-CarryTokens', 'Tail', 'Test-FleetRun', 'Get-FleetRunReport', 'Step-LinuxRoot', 'Remove-FleetRegistrar', 'Restore-W1Pause', 'Read-FleetOutFile', 'Get-FleetRunOutputDirectory', 'Get-FleetRunProcesses')) {
  $nodes = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name }, $false))
  if ($nodes.Count -ne 1) { throw ('FUNCTION_MISSING_OR_DUPLICATED:' + $name) }
  . ([scriptblock]::Create($nodes[0].Extent.Text))
}
. ([scriptblock]::Create([IO.File]::ReadAllText($Fragment)))
$U8 = New-Object Text.UTF8Encoding($false); $Strict8 = New-Object Text.UTF8Encoding($false, $true)
$null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$Js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Done = New-Object Collections.Generic.List[string]
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$OwnerSid = $me   # the companion account (a launcher pin): this test's own, so a process the test starts is the companion's
$StageSddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + $me + ')'
$Out = Join-Path $Work 'launch'; $Stage = Join-Path $Work 'stage'; foreach ($d in @($Out, $Stage)) { [void][IO.Directory]::CreateDirectory($d) }
$ResidentRoot = Join-Path $c.ci 'resident'; $CarryParent = $c.ci
$CarriedTokens = [ordered]@{ directory = $null; tokens = @(); removed = $null; removeError = $null }
$SourceSha = '1' * 40; $PackageHead = '2' * 40
$FleetPlanSha256 = '9' * 64; $CiSourceManifestSha256 = $c.source; $PackageManifestSha256 = $c.package; $FleetLinuxManifestSha256 = $c.linuxManifest
$FleetOutDir = $c.outDir; $FleetWslOutDir = '/mnt/x/out'
$InstalledReceiptSha256 = $c.receiptPin; $UpgradeTokenTarget = Join-Path $ResidentRoot 'secrets\resident-upgrade.token'; $HeartbeatTokenTarget = Join-Path $ResidentRoot 'secrets\heartbeat\ci-node-heartbeat.token'
$FleetUpgradeTokenFingerprint = $c.upgradeFingerprint; $FleetHeartbeatTokenFingerprint = $c.heartbeatFingerprint
$ContinueOriginalLauncherSha256 = '8' * 64; $ContinuePriorRoot = $c.prior; $ContinueKeptRoot = $c.kept; $ContinueUninstallReceiptSha256 = $c.uninstallReceiptPin; $ContinueUninstallPlanSha256 = $c.uninstallPlanPin
$W1Restore = [ordered]@{ armed = ($c.mode -ceq 'atimeout'); result = $null }; $FleetCompanionAccount = [bool]$c.companion; $FleetDistribution = 'stand-in'; $FleetInDir = $c.ci; $script:linuxRuns = @()
function Test-ContinueLinuxOutDirectory { if (-not $c.outDirOk) { Stop-Launch 'CONTINUE_LINUX_OUT_DIRECTORY_NOT_THE_PRIOR_LAUNCHS' $null } }
function Invoke-FleetLinuxScript([string]$name, [string]$registrar) { $script:linuxRuns += ,$name; [ordered]@{ name = $name; directory = ('run-' + $name); outcome = 'EXITED'; exit = 0; code = $null; captureRefused = $null; stdout = $c.bStdout; stderrTail = $null; registrarStderr = $null; seconds = 1 } }
$ContinuePriorProgress = $c.progress; $ContinuePriorPid = $(if ($c.priorIsThisProcess) { $PID } else { 99999999 })
$ContinuePriorProcessStart = $(if ($c.priorIsThisProcess) { [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToString('o') } else { '2026-11-12T09:00:00.0000000Z' })
$ContinueLinuxFrom = $c.linuxFrom; $ContinueLastRunDirectory = $c.lastRun
$ContinuePriorPins = [ordered]@{}; foreach ($p in $c.priorPins.PSObject.Properties) { $ContinuePriorPins[$p.Name] = [string]$p.Value }
function Get-ScState([string]$name) { [ordered]@{ name = $name; gone = ($c.servicesPresent -notcontains $name); state = $(if ($name -ceq 'CluedCIResident') { $script:residentState } else { 4 }) } }
if ($c.mode -ceq 'inside') { $ResumePriorRoot = $c.resumePrior; $ResumeOriginalLauncherSha256 = '8' * 64; $ResumeUninstallPlanSha256 = '6' * 64 }   # resume.py's pins: an inside-uninstall continuation's only
$ContinueAfterInstallFrom = $c.from
$PauseReason = 'reinstall pause'; $Sc = 'Invoke-FakeSc'; $script:residentState = [int]$c.residentState; $script:scCalls = @(); $script:finish = $null; $script:originalPause = 0
function Invoke-FakeSc { $script:scCalls += ,($args -join ' '); if ($args[0] -ceq 'start' -and $c.startWorks) { $script:residentState = 4 }; 'fake sc' }
function Wait-Until([scriptblock]$cond, [int]$seconds) { [bool](& $cond) }
function Step-StartCompanion { $Done.Add('companion'); [ordered]@{ started = $true; standIn = $true } }
function Step-PauseAfterInstall([bool]$verified) { $script:originalPause++; $Done.Add('pause-stand-in'); [ordered]@{ verified = $verified; confirmed = $verified; standIn = $true } }
# resume.py's Step-FinishUninstall is tested by test_resume_launcher.py; here: what it is called with, and that a stop of it leaves no token copy
function Step-FinishUninstall {
  $script:finish = [ordered]@{ carryPresent = [bool]($CarriedTokens.directory -and [IO.Directory]::Exists($CarriedTokens.directory)); factsSha256 = $LinuxVersionFactsSha256; rootThere = [IO.Directory]::Exists($ResidentRoot) }
  if ($c.finishStops) { Stop-Launch 'RESUME_SERVICES_NOT_ABSENT' $null }
  $target = Join-Path $c.ci 'resident-uninstalled-20261112T120000Z-abcdefabcdef'; [IO.Directory]::Move($ResidentRoot, $target)
  $Done.Add('uninstall-finish-only')
  [ordered]@{ uninstall = [ordered]@{ keptAt = $target; planSha256 = $ResumeUninstallPlanSha256; uninstallReceiptSha256 = ('5' * 64) }; parentAcl = [ordered]@{ prior = 1 }; quiesce = [ordered]@{ prior = 1 } }
}
function Get-ContinueUninstallProcesses { @($c.uninstallProcesses) }
function Test-TerminalEvidence([string]$root) { $script:evidenceRoot = $root; [bool]$c.terminalEvidence }
function Read-VerifiedResidentLocks([string]$phase) { @{ external=@(); unknownProcesses=@(); rootProcesses=@() } }
function Step-FileLocks { if ($script:failLocks) { $script:failLocks = $false; Stop-Launch 'EXTERNAL_RESIDENT_BINARY_LOCK' $null }; $Done.Add('file-locks'); [ordered]@{ fileCount = 3; external = 0 } }
# a companion node's registrar and its capture-file (create-only, the announced source and target shapes), this continuation's capture
# directory (its ACL is the launcher's; a non-elevated test cannot make an Administrators-owned directory). Get-FleetRunProcesses is the
# template's own (one read-only process query): a run's process is a real one the test starts (live_process); a failed query is
# Get-CimInstance throwing, so the real function reports it itself.
$script:failLocks = [bool]$c.failLocksOnce; $script:captures = @(); $script:captureDirs = @()
function New-FleetRegistrar { [ordered]@{ exe = 'registrar-stand-in'; directory = (Join-Path $Work 'companion-build-stand-in') } }
function New-FleetCaptureDirectory([string]$runDirectory) { $d = Join-Path $runDirectory ('captured-' + [Guid]::NewGuid().ToString('N')); [void][IO.Directory]::CreateDirectory($d); $script:captureDirs += ,$d; $d }
if ($c.processQueryFails) { function Get-CimInstance { throw 'stand-in: the process query fails' } }
function Invoke-FleetProcess([string]$file, [string]$arguments, [int]$seconds) {
  $p = $arguments -split ' '
  $refuse = { param($code) [ordered]@{ timedOut = $false; exit = 1; stdout = ('{"code":"' + $code + '"}'); stderr = '' } }
  $m = [regex]::Match($p[2], '\\install\\(linux-run-[0-9a-f]{32})\\captured(?:-[0-9a-f]{32})?\\([^\\]+)$')
  if ($p[0] -cne 'capture-file' -or -not $m.Success -or [IO.Path]::GetFileName($p[1]) -cne $m.Groups[2].Value) { return (& $refuse 'REGISTRAR_ARGS_REFUSED') }
  if ($p[1] -match '\\(linux-run-[0-9a-f]{32})\\out\\' -and $Matches[1] -cne $m.Groups[1].Value) { return (& $refuse 'REGISTRAR_ARGS_REFUSED') }
  if ($c.refuseCapture -and [IO.Path]::GetFileName($p[1]) -ceq 'stdout.txt') { return (& $refuse $c.refuseCapture) }
  if (-not [IO.File]::Exists($p[1])) { return (& $refuse 'ROOT_RUN_OUTPUT_UNREADABLE') }
  if ([IO.File]::Exists($p[2])) { return (& $refuse 'ROOT_RUN_CAPTURE_NOT_WRITTEN') }
  [IO.File]::Copy($p[1], $p[2]); $script:captures += ,$p[2]; [ordered]@{ timedOut = $false; exit = 0; stdout = '{"code":"FILE_CAPTURED"}'; stderr = '' }
}
$script:evidenceRoot = $null; $stopped = $null; $r = $null
try { $r = $(switch ($c.mode) { 'before' { Step-ContinueBeforeUninstall } 'inside' { Step-ContinueInsideUninstall } 'install' { Step-ContinueAfterInstall } 'pause' { Step-ContinuePauseAfterInstall ([bool]$c.verified) } 'twice' { $first = try { $null = Step-ContinueBeforeUninstall; 'NOT_STOPPED' } catch { [string]$_.Exception.Message }   # stopped after its capture
    $script:firstStop = $first; $Out = Join-Path $Work 'launch-2'; $Stage = Join-Path $Work 'stage-2'; foreach ($d in @($Out, $Stage)) { [void][IO.Directory]::CreateDirectory($d) }
    $CarriedTokens = [ordered]@{ directory = $null; tokens = @(); removed = $null; removeError = $null }; $Done.Clear()
    Step-ContinueBeforeUninstall } 'atimeout' { $aRun = Step-ContinueAfterATimeout; [ordered]@{ linux = (Step-ContinueLinuxRoot $aRun) } } default { Step-ContinueAfterUninstall } }) } catch { $stopped = [string]$_.Exception.Message }
$copies = [ordered]@{}; if ($r -and $r.Contains('carried')) { foreach ($k in @($r.carried.Keys)) { $copies[$k] = Sha256Bytes ([IO.File]::ReadAllBytes($r.carried[$k])) } }
$during = $(if ($CarriedTokens.directory) { [IO.Directory]::Exists($CarriedTokens.directory) } else { $null })
Remove-FleetCarry
[ordered]@{ stopped = $stopped; copies = $copies; carryDuring = $during; carried = $CarriedTokens; done = @($Done); evidenceRoot = $script:evidenceRoot
  uninstall = $(if ($r -and $r.Contains('uninstall')) { $r.uninstall } else { $null }); linux = $(if ($r -and $r.Contains('linux')) { $r.linux } else { $null })
  step = $(if ($c.mode -ceq 'install' -or $c.mode -ceq 'pause') { $r } else { $null }); finish = $script:finish; sc = @($script:scCalls); originalPause = $script:originalPause; linuxRuns = @($script:linuxRuns); w1Armed = $W1Restore.armed; firstStop = $(if ($c.mode -ceq 'twice') { $script:firstStop } else { $null }); captures = @($script:captures); captureDirs = @($script:captureDirs)
  carryLeft = @([IO.Directory]::GetDirectories($c.ci, 'reinstall-carry-*')).Count } | ConvertTo-Json -Compress -Depth 6
"""


@unittest.skipUnless(POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class ContinueStep(unittest.TestCase):
    """The two steps of the fragment, with the template's real token, rule, read and stop functions."""
    def run_step(self, change=None, mode='after', completed=UNINSTALLED, extra=None, pinned=None, scene=None, **case):
        with tempfile.TemporaryDirectory(prefix='fleet-continue-step-') as directory:
            s = Scene(directory, completed=completed)
            s.extra = dict(extra or {})
            if scene:
                scene(s)
            s.write()
            root = s.kept if mode == 'after' else s.ci / 'resident'
            (root / 'install').mkdir(parents=True, exist_ok=True)
            (root / 'install' / 'install-receipt.json').write_bytes(b'{"receipt":1}')
            (s.kept / 'install' / 'uninstall-receipt.json').write_bytes(b'{"uninstall":1}')
            (root / 'secrets' / 'heartbeat').mkdir(parents=True)
            (root / 'secrets' / 'resident-upgrade.token').write_bytes((UPGRADE + '\n').encode())
            (root / 'secrets' / 'heartbeat' / 'ci-node-heartbeat.token').write_bytes(HEARTBEAT.encode())
            out_dir = s.ci / ('reinstall-linux-out-' + '5' * 32); out_dir.mkdir()
            run = s.ci / 'resident' / 'install' / ('linux-run-' + '7' * 32)
            files = pinned or ['terminal.json', 'linux-report.json', 'linux-version-facts.json', 'linux-live-manifest.txt'] + (['uninstall-report.json', 'migrate-acl.dry-run.before-uninstall.stdout.json'] if mode == 'after' else [])
            base = {'mode': mode, 'ci': str(s.ci), 'prior': str(s.prior), 'kept': str(s.kept), 'outDir': str(out_dir), 'source': SOURCE, 'package': PACKAGE, 'linuxManifest': LINUX_MANIFEST, 'servicesPresent': [],
                    'terminalEvidence': True, 'receiptPin': sha(b'{"receipt":1}'), 'uninstallReceiptPin': sha(b'{"uninstall":1}'), 'upgradeFingerprint': fingerprint('ci-token', UPGRADE),
                    'heartbeatFingerprint': fingerprint('heartbeat-token', HEARTBEAT), 'progress': '|'.join(s.progress_names()[0]), 'priorIsThisProcess': False, 'linuxFrom': 'prior-launch', 'lastRun': str(run),
                    'priorPins': {name: sha((s.prior / name).read_bytes()) for name in files},
                    'resumePrior': str(s.prior), 'from': None, 'residentState': 4, 'startWorks': False, 'finishStops': False, 'verified': False, 'uninstallProcesses': [], 'uninstallPlanPin': None, 'outDirOk': True, 'bStdout': '', 'failLocksOnce': False, 'companion': False, 'processQueryFails': False, 'refuseCapture': None}
            live = case.pop('live_process', False)
            base['priorPins'].update(case.pop('priorPinsOverride', {}))
            base.update(case)
            if change:
                change(s)
            (s.root / 'driver.ps1').write_text(DRIVER, encoding='utf-8'); (s.root / 'case.json').write_text(json.dumps(base), encoding='utf-8')
            work = s.root / 'run'
            holder = None   # live_process: a real process of the prior run, its command line naming the run directory as a Linux step's does
            try:
                if live:
                    holder = subprocess.Popen([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120 # ' + str(run)],
                                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    s.live_pid = holder.pid
                p = subprocess.run([str(POWERSHELL), '-NoProfile', '-NonInteractive', '-File', str(s.root / 'driver.ps1'), str(LAUNCHER / 'template.ps1'), str(LAUNCHER / 'continue-install.ps1'), str(s.root / 'case.json'), str(work)],
                                   capture_output=True, text=True, encoding='utf-8', timeout=60)
            finally:
                if holder:   # by its handle: only the process this test started
                    holder.kill(); holder.wait()
            self.assertEqual(p.returncode, 0, p.stderr)
            produced = {}
            for at, _, names in os.walk(work):
                for n in names:
                    with open(os.path.join(at, n), 'rb') as stream:
                        produced[os.path.relpath(os.path.join(at, n), work)] = stream.read()
            for marker in (UPGRADE, HEARTBEAT, UPGRADE[10:], HEARTBEAT[10:]):   # the tokens are in nothing the run printed or left
                self.assertNotIn(marker, p.stdout); self.assertNotIn(marker, p.stderr)
                for rel, data in produced.items():
                    self.assertNotIn(marker.encode(), data, rel); self.assertNotIn(marker.encode('utf-16-le'), data, rel)
            return json.loads(p.stdout), produced, s

    def test_after_the_uninstall_tokens_from_the_kept_root_facts_staged_and_the_state_proven(self):
        r, produced, s = self.run_step()
        self.assertIsNone(r['stopped'])
        self.assertEqual(r['copies'], {'upgradeToken': sha((UPGRADE + '\n').encode()), 'heartbeatToken': sha(HEARTBEAT.encode())})   # the kept root's bytes
        self.assertEqual((r['carryDuring'], r['carried']['removed'], r['carryLeft']), (True, True, 0))
        self.assertEqual(r['done'], ['tokens-carried', 'continued-after-uninstall'])
        self.assertEqual((r['evidenceRoot'], r['uninstall']['keptAt'], r['uninstall']['uninstallReceiptSha256']), (str(s.kept), str(s.kept), sha(b'{"uninstall":1}')))
        facts = json.dumps(FACTS).encode()
        self.assertEqual((r['linux']['factsSha256'], sha(produced[os.path.join('stage', 'linux-version-facts.phase-B.json')])), (sha(facts), sha(facts)))
        self.assertEqual(produced[os.path.join('launch', 'migrate-acl.dry-run.before-uninstall.stdout.json')], b'{"status":"SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN"}')   # where Step-Preflight reads it
        report = json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))
        self.assertEqual((report['mode'], report['codes'], report['keptRoots'], report['state']['residentRootExists'], report['priorLaunchStillRunning']), ('after-uninstall', [], [KEPT_NAME], False, False))

    def stops(self, code, change=None, **case):
        r, produced, _ = self.run_step(change, **case)
        self.assertEqual(r['stopped'], code)
        self.assertEqual((r['copies'], r['carryLeft']), ({}, 0))   # no token copy is left by a stop
        return r, produced

    def test_any_doubt_about_the_state_stops_before_a_token_is_touched(self):
        for code, change, case in (
                ('CONTINUE_PRIOR_LAUNCH_STILL_RUNNING', None, {'priorIsThisProcess': True}),
                ('CONTINUE_PRIOR_PROGRESS_NOT_THE_ELEVATED_RECORD', lambda s: (s.elevated_progress() / '014-preflight.json').unlink(), {}),
                ('CONTINUE_PRIOR_PROGRESS_NOT_THE_ELEVATED_RECORD', lambda s: (s.elevated_progress() / '015-install.json').write_text('{}'), {}),
                ('CONTINUE_PRIOR_EVIDENCE_CHANGED', lambda s: (s.prior / 'linux-version-facts.json').write_bytes(json.dumps(dict(FACTS, x=1)).encode()), {}),
                ('CONTINUE_PRIOR_EVIDENCE_CHANGED', lambda s: (s.prior / 'terminal.json').unlink(), {}),
                ('CONTINUE_NODE_NOT_UNINSTALLED', lambda s: (s.ci / 'resident').mkdir(), {}),
                ('CONTINUE_NODE_NOT_UNINSTALLED', None, {'servicesPresent': ['CluedCIUpgrader']}),
                ('CONTINUE_KEPT_ROOT_NOT_THE_NEWEST', lambda s: (s.ci / 'resident-uninstalled-20261112T100001Z-bbbbbbbbbbbb').mkdir(), {}),
                ('CONTINUE_KEPT_ROOT_NOT_THE_PRIOR_UNINSTALLS', lambda s: (s.kept / 'install' / 'install-receipt.json').write_bytes(b'{"receipt":2}'), {}),
                ('CONTINUE_KEPT_ROOT_NOT_THE_PRIOR_UNINSTALLS', lambda s: (s.kept / 'install' / 'uninstall-receipt.json').unlink(), {}),
                ('CONTINUE_KEPT_ROOT_NOT_THE_PRIOR_UNINSTALLS', None, {'terminalEvidence': False}),
                ('CONTINUE_PINS_REFUSED', None, {'kept': 'C:' + chr(92) + 'elsewhere' + chr(92) + KEPT_NAME})):
            r, _ = self.stops(code, change, **case)
            self.assertNotIn('tokens-carried', r['done'], code); self.assertIsNone(r['carried']['directory'], code)

    def test_older_kept_roots_are_not_a_doubt(self):
        r, _, _ = self.run_step(lambda s: (s.ci / 'resident-uninstalled-20261001T000000Z-aaaaaaaaaaaa').mkdir())
        self.assertIsNone(r['stopped'])

    def test_facts_that_no_longer_pass_the_rules_stop(self):
        bad = json.dumps(dict(FACTS, pinsOk=False)).encode()
        r, _, _ = self.run_step(lambda s: (s.prior / 'linux-version-facts.json').write_bytes(bad))
        self.assertEqual(r['stopped'], 'CONTINUE_PRIOR_EVIDENCE_CHANGED')   # changed bytes are refused by their pin before any rule is asked
        r, produced, _ = self.run_step(lambda s: (s.prior / 'linux-version-facts.json').write_bytes(bad), priorPinsOverride={'linux-version-facts.json': sha(bad)})
        self.assertEqual((r['stopped'], r['carried']['directory']), ('LINUX_VERSION_FACTS_NOT_THIS_PACKAGE', None))
        self.assertNotIn(os.path.join('stage', 'linux-version-facts.phase-B.json'), produced)

    def test_a_kept_token_that_is_not_the_receipts_stops_and_leaves_no_copy(self):
        other = 'clued' + '_bnd_' + 'Z' * 40
        r, _ = self.stops('CARRIED_TOKEN_FINGERPRINT_MISMATCH', lambda s: (s.kept / 'secrets' / 'resident-upgrade.token').write_text(other, encoding='ascii'))
        self.assertEqual(r['carried']['removed'], True)
        r, _ = self.stops('INSTALLED_TOKEN_NOT_A_PLAIN_FILE', lambda s: (s.kept / 'secrets' / 'heartbeat' / 'ci-node-heartbeat.token').unlink())

    def test_before_the_uninstall_the_live_root_and_the_prior_launchs_checked_output(self):
        r, produced, s = self.run_step(mode='before', completed=LINUX_DONE)
        self.assertIsNone(r['stopped'])
        self.assertEqual(r['copies'], {'upgradeToken': sha((UPGRADE + '\n').encode()), 'heartbeatToken': sha(HEARTBEAT.encode())})   # from the live root
        self.assertEqual(r['done'], ['file-locks', 'tokens-carried', 'continued-before-uninstall'])   # the elevated lock observation again
        self.assertEqual((r['linux']['factsSha256'], r['uninstall']), (sha(json.dumps(FACTS).encode()), None))
        self.assertEqual(json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))['mode'], 'before-uninstall')
        r, _ = self.stops('CONTINUE_INSTALLED_RECEIPT_NOT_AS_REVIEWED', lambda s: (s.ci / 'resident' / 'install' / 'install-receipt.json').write_bytes(b'{"receipt":2}'), mode='before', completed=LINUX_DONE)
        self.assertEqual(r['done'], [])
        r, _ = self.stops('CONTINUE_NODE_ALREADY_UNINSTALLED', lambda s: __import__('shutil').rmtree(s.ci / 'resident'), mode='before', completed=LINUX_DONE)

    def b_timeout(self, stdout, evidence=EVIDENCE.encode(), facts=json.dumps(FACTS).encode(), out_files=True, **case):
        e_name, f_name = 'linux-live-manifest.20261112T100000Z.txt', 'linux-version-facts.20261112T100000Z.json'

        def lay(s):
            run = s.ci / 'resident' / 'install' / ('linux-run-' + '7' * 32); (run / 'out').mkdir(parents=True)
            if stdout is not None:
                (run / 'out' / 'stdout.txt').write_text(stdout.replace('E_PATH', '/mnt/x/out/' + e_name).replace('F_PATH', '/mnt/x/out/' + f_name), encoding='utf-8')
            if out_files:
                out = s.ci / ('reinstall-linux-out-' + '5' * 32)
                (out / e_name).write_bytes(evidence); (out / f_name).write_bytes(facts)
        return self.run_step(lay, mode='before', completed=LINUX_DONE[:7], linuxFrom='out-directory', priorPinsOverride={}, **case)

    def test_a_timed_out_phase_b_continues_only_once_it_has_finished_and_passes(self):
        done = 'moved x\n' + json.dumps({'status': 'LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1', 'evidence': 'E_PATH', 'versionFacts': 'F_PATH'}) + '\n'
        r, produced, _ = self.b_timeout(done)
        self.assertIsNone(r['stopped'])
        self.assertEqual((r['linux']['factsSha256'], r['done']), (sha(json.dumps(FACTS).encode()), ['file-locks', 'tokens-carried', 'continued-before-uninstall']))
        for stdout in ('{"status":"ROOT_STAGING_VERIFIED"}\nmoved a -> b\n', '', None):
            r, produced, s = self.b_timeout(stdout, live_process=True)   # still running: the same command again later
            self.assertEqual((r['stopped'], r['done'], r['carried']['directory']), ('LINUX_PHASE_STILL_RUNNING_RETRY', [], None), stdout)
            self.assertEqual(run_process_pids(produced), [s.live_pid], stdout)
            r, _, _ = self.b_timeout(stdout)   # ended without its final line: it never will have one
            self.assertEqual((r['stopped'], r['done'], r['carried']['directory']), ('LINUX_PHASE_ENDED_WITHOUT_STATUS', [], None), stdout)
        r, produced, _ = self.b_timeout('{"status":"REFUSED","code":"RESIDENT_INSTALL_FAILED_SEE_RECOVERY"}\n')
        self.assertEqual((r['stopped'], r['done']), ('LINUX_PHASE_B_FAILED_AFTER_ITS_TIMEOUT', []))
        self.assertEqual(json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))['state']['phaseBCode'], 'RESIDENT_INSTALL_FAILED_SEE_RECOVERY')
        r, _, _ = self.b_timeout(done, facts=json.dumps(dict(FACTS, staged={'generation': 2})).encode())
        self.assertEqual((r['stopped'], r['done']), ('LINUX_VERSION_FACTS_NOT_THIS_PACKAGE', []))
        r, _, _ = self.b_timeout(done, out_files=False)
        self.assertEqual(r['stopped'], 'LINUX_OUTPUT_UNREADABLE')
        r, _, _ = self.b_timeout(done.replace('E_PATH', '/mnt/x/elsewhere/linux-live-manifest.20261112T100000Z.txt'))
        self.assertEqual(r['stopped'], 'LINUX_OUTPUT_PATHS_NOT_IN_THE_OUT_DIRECTORY')


if __name__ == '__main__':
    unittest.main()
