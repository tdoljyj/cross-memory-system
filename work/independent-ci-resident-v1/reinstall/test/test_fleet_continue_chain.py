"""Continuing a continuation (generate.py --fleet-continue <the prior continuation>), a Linux phase A that ran into the launcher's timeout,
and a launch cut off inside the uninstall (no terminal) told apart by the node's state. Offline stand-ins only (test_fleet_continue.py's
scene and PowerShell driver): nothing is elevated, no real root, secret, task, service or distribution is touched."""
import datetime
import json
import os
from pathlib import Path
import tempfile
import unittest

import test_fleet_continue as base
import test_fleet_continue_resume_points as points
from test_resume_evidence import fixture as resume_terminal

CONTINUE, sha, LAUNCHER = base.CONTINUE, base.sha, base.LAUNCHER
at = lambda hour: datetime.datetime(2026, 11, 12, hour, 0, 0, tzinfo=datetime.timezone.utc)
RUN_NAME = 'linux-run-' + '7' * 32
PLAN = resume_terminal()['detail']['dryRun']['plan']
DRY_RUN = json.dumps({'status': 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', 'planSha256': 'c' * 64, 'plan': PLAN}).encode()
ALL = {name: True for name in CONTINUE.SERVICES}
NONE = {name: False for name in CONTINUE.SERVICES}


def lay_launch(s, launch, steps, terminal=None, files=None):
    """A launch directory as a launcher run leaves it: its files, a progress record per step, the elevated copies, the terminal."""
    launch.mkdir(parents=True)
    for name, data in dict({'intent.json': b'{}'}, **(files or {})).items():
        (launch / name).write_bytes(data)
    if terminal is not None:
        (launch / 'terminal.json').write_text(json.dumps(dict({'contract': 'clued.independent-ci.source-v2-windows-launch-terminal/1', 'sourceSha': '1' * 40, 'packageHead': '2' * 40,
                                                                'completed': list(steps)}, **terminal)), encoding='utf-8')
    for directory in (launch / 'progress', s.ci / ('reinstall-progress-' + sha(str(launch).lower().encode())[:32])):
        directory.mkdir(parents=True)
        for i, step in enumerate(steps):
            (directory / ('%03d-%s.json' % (i + 1, step))).write_text(json.dumps({'contract': 'clued.independent-ci.reinstall-launch-progress/1', 'index': i + 1, 'step': step, 'at': '2026-11-12T12:00:00Z',
                                                                                 'pid': 99999998, 'processStart': '2026-11-12T12:00:00.0000000Z', 'pins': {'sourceSha': '1' * 40, 'packageHead': '2' * 40}}), encoding='utf-8')


def linux_files(s):
    """What Set-ContinueLinuxOutput leaves in a continuation's launch directory."""
    return {'linux-live-manifest.txt': s.evidence, 'linux-version-facts.json': s.facts,
            'linux-report.json': json.dumps({'codes': [], 'planSha256': '9' * 64, 'versionFactsSha256': sha(s.facts), 'evidenceSha256': sha(s.evidence), 'continuedFrom': 'x'}).encode()}


@unittest.skipUnless(os.name == 'nt', 'Windows paths are the source contract')
class Chain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fleet-continue-chain-'); self.addCleanup(self.tmp.cleanup)
        self.s = base.Scene(self.tmp.name)
        (self.s.ci / 'resident').mkdir()

    def build(self, launcher, hour, **kw):
        return CONTINUE.build(str(launcher), ci_root=str(self.s.ci), now=at(hour), **kw)

    def test_a_continuation_whose_verify_fails_again_is_continued_from_verify(self):
        s = self.s
        points.installed_scene(s, ['first-train', 'verify', 'pause-not-confirmed-resident-stopped'], status='R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED', verify='RESIDENT_NOT_VERIFIED', companion=False)
        s.write()
        root = sha(s.launcher.read_bytes())
        (s.work / 'install-plan.json').write_text(json.dumps({'launcher': {'path': str(s.launcher), 'sha256': root}}), encoding='utf-8')   # the plan names the root launcher
        data1, f1 = self.build(s.launcher, 11)
        self.assertEqual((f1['mode'], f1['afterInstallFrom'], f1['rootLauncherSha256'], f1['priorIsAContinuation']), ('after-install', 'verify', root, False))
        c1 = s.work / 'continuation-1.ps1'; c1.write_bytes(data1)
        # the continuation ran: the first-train wait it carried is on its own record, verify failed again, the resident was stopped
        l1 = Path(f1['launchDir'])
        steps1 = ['output', 'package', 'stage', 'first-train-not-observed', 'continued-after-install', 'verify', 'pause-not-confirmed-resident-stopped']
        lay_launch(s, l1, steps1, {'status': 'R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED', 'code': None, 'companion': {'started': False}},
                   dict(linux_files(s), **{'install-receipt.json': points.RECEIPT_BYTES, 'first-train-report.json': b'{"runnerQuiet":true}', 'verify.stdout.json': b'{"status":"RESIDENT_NOT_VERIFIED"}',
                                           'pause-report.json': b'{"verified":false,"confirmed":false}'}))
        data2, f2 = self.build(c1, 12)
        self.assertEqual((f2['mode'], f2['afterInstallFrom'], f2['priorLaunchDir'], f2['priorIsAContinuation'], f2['skippedContinuationLaunchDir'], f2['rootLauncherSha256'], f2['originalLauncherSha256']),
                         ('after-install', 'verify', str(l1), True, None, root, sha(data1)))
        text2 = data2.decode('utf-8')
        self.assertIn("\n$ContinueOriginalLauncherSha256 = '" + sha(data1) + "'\n$ContinueRootLauncherSha256 = '" + root + "'\n$ContinuePriorRoot = '" + str(l1) + "'\n", text2)
        self.assertEqual(set(f2['priorFileSha256']), {'terminal.json', 'install-receipt.json', 'first-train-report.json'} | set(CONTINUE.LINUX_FILES))
        self.assertEqual(data2.count(b'function Step-ContinueAfterInstall {'), 1)   # the fragment once, not once per generation
        base.ContinueGenerator.parses(self, data2)
        # the second continuation stopped before its own step completed: nothing it did is relied on, the first one's launch is continued again
        c2 = s.work / 'continuation-2.ps1'; c2.write_bytes(data2)
        l2 = Path(f2['launchDir'])
        lay_launch(s, l2, ['output', 'package', 'stage'], {'status': 'STOPPED', 'code': 'CONTINUE_PRIOR_LAUNCH_STILL_RUNNING'})
        data3, f3 = self.build(c2, 13)
        self.assertEqual((f3['mode'], f3['afterInstallFrom'], f3['priorLaunchDir'], f3['skippedContinuationLaunchDir'], f3['originalLauncherSha256'], f3['rootLauncherSha256']),
                         ('after-install', 'verify', str(l1), str(l2), sha(data1), root))
        self.assert_no_node_value(c2, 14)
        (s.work / 'install-plan.json').write_text(json.dumps({'launcher': {'path': 'x', 'sha256': sha(data1)}}), encoding='utf-8')   # a plan names the root launcher only
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(c2, 15)
        self.assertEqual(caught.exception.code, 'PRIOR_LAUNCHER_NOT_THE_PLANS')

    def assert_no_node_value(self, launcher, hour):
        out = self.s.root / ('chained-%d.ps1' % hour)
        real = CONTINUE.build
        try:
            CONTINUE.build = lambda path: real(path, ci_root=str(self.s.ci), now=at(hour))
            import contextlib, io
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                self.assertEqual(CONTINUE.main(['--fleet-continue', str(launcher), '--out', str(out)]), 0)
        finally:
            CONTINUE.build = real
        line = json.loads(printed.getvalue())
        self.assertNotIn('node-a', line['elevatedCommand']); self.assertEqual(sha(out.read_bytes()), line['launcher']['sha256'])

    def test_an_after_uninstall_continuation_whose_install_failed_is_continued_after_the_uninstall_again(self):
        s = self.s
        (s.ci / 'resident').rmdir()
        s.write()
        data1, f1 = self.build(s.launcher, 11)
        self.assertEqual(f1['mode'], 'after-uninstall')
        c1 = s.work / 'continuation-1.ps1'; c1.write_bytes(data1)
        l1 = Path(f1['launchDir'])
        report = {'apply': {'status': 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT', 'keptAt': str(s.kept)}, 'deletedAndRenamed': True,   # Write-ContinueUninstallReport's shape
                  'evidence': {'keptAt': str(s.kept), 'installReceiptSha256': base.RECEIPT, 'uninstallReceiptSha256': base.UNINSTALL_RECEIPT, 'terminalEvidenceMatches': True}}
        lay_launch(s, l1, ['output', 'package', 'stage', 'tokens-carried', 'continued-after-uninstall', 'preflight'], {'status': 'STOPPED', 'code': 'INSTALL_NOT_COMPLETED', 'detail': {'residentRootExists': False}},
                   dict(linux_files(s), **{'uninstall-report.json': json.dumps(report).encode(), 'migrate-acl.dry-run.before-uninstall.stdout.json': b'{"status":"SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN"}'}))
        data2, f2 = self.build(c1, 12)
        self.assertEqual((f2['mode'], f2['priorLaunchDir'], f2['keptRoot']), ('after-uninstall', str(l1), str(s.kept)))
        base.ContinueGenerator.parses(self, data2)

    # ---- phase A ran into the timeout ----
    def a_timeout_scene(self):
        s = self.s
        run = str(s.ci / 'resident' / 'install' / RUN_NAME)
        s.terminal = dict(s.terminal, completed=base.LINUX_DONE[:6], code='LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED', detail={})
        s.linux = {'codes': ['LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED'], 'runs': [{'name': 'A', 'outcome': 'TIMEOUT', 'directory': run}]}
        s.write()
        return run

    def test_a_phase_a_timeout_continues_with_b_and_everything_else_as_the_launchers(self):
        run = self.a_timeout_scene()
        data, facts = self.build(self.s.launcher, 11)
        text, original = data.decode('utf-8'), self.s.launcher.read_text(encoding='utf-8')
        self.assertEqual((facts['mode'], sorted(facts['priorFileSha256'])), ('a-timeout', ['linux-report.json', 'terminal.json']))
        self.assertIn("\n$ContinueLastRunDirectory = '" + run + "'\n", text); self.assertNotIn('\n$ContinueLinuxFrom = ', text)
        main, own = text.split('#region main', 1)[1], original.split('#region main', 1)[1]
        self.assertIn(CONTINUE.NEW_A_TIMEOUT + '    Step-WindowsPreflightBeforeLinux', main)
        self.assertEqual(main.replace(CONTINUE.NEW_A_TIMEOUT, '').replace('$linux = Step-ContinueLinuxRoot $continue', '$linux = Step-LinuxRoot'), own)   # nothing else of main changed
        base.ContinueGenerator.parses(self, data)
        # its continuation stopped before B (the Windows preflight refused): the original launch is continued again
        c1 = self.s.work / 'continuation-1.ps1'; c1.write_bytes(data)
        l1 = Path(facts['launchDir'])
        lay_launch(self.s, l1, ['output', 'package', 'stage', 'continued-a-timeout'], {'status': 'STOPPED', 'code': 'INSTALLED_RECEIPT_NOT_AS_REVIEWED'})
        _, f2 = self.build(c1, 12)
        self.assertEqual((f2['mode'], f2['priorLaunchDir'], f2['skippedContinuationLaunchDir']), ('a-timeout', str(self.s.prior), str(l1)))
        # its continuation ran B and B ran into the timeout: phase B's own continuation, from the continuation's launch directory
        b_run = str(self.s.ci / 'resident' / 'install' / ('linux-run-' + '8' * 32))
        for f in list(l1.rglob('*'))[::-1]:
            f.unlink() if f.is_file() else f.rmdir()
        l1.rmdir()
        for f in (self.s.ci / ('reinstall-progress-' + sha(str(l1).lower().encode())[:32])).iterdir():
            f.unlink()
        (self.s.ci / ('reinstall-progress-' + sha(str(l1).lower().encode())[:32])).rmdir()
        steps = ['output', 'package', 'stage', 'continued-a-timeout', 'windows-preflight-before-linux', 'tokens-carried', 'file-locks', 'linux-A']
        lay_launch(self.s, l1, steps, {'status': 'STOPPED', 'code': 'LINUX_ROOT_RUN_TIMEOUT_NOTHING_KILLED'},
                   {'linux-report.json': json.dumps({'runs': [{'name': 'A', 'outcome': 'EXITED', 'directory': run}, {'name': 'B', 'outcome': 'TIMEOUT', 'directory': b_run}]}).encode()})
        _, f3 = self.build(c1, 13)
        self.assertEqual((f3['mode'], f3['priorLaunchDir'], f3['skippedContinuationLaunchDir']), ('b-timeout', str(l1), None))

    def test_an_a_output_the_registrar_refused_to_capture_is_looked_at_again_like_a_timeout(self):
        run = self.a_timeout_scene()
        self.s.terminal['code'] = 'LINUX_PHASE_A_OUTPUT_NOT_CAPTURED'
        self.s.linux['runs'][-1].update(outcome='EXITED', captureRefused='ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME'); self.s.write()
        data, facts = self.build(self.s.launcher, 11)
        self.assertEqual((facts['mode'], facts['priorStopCode']), ('a-timeout', 'LINUX_PHASE_A_OUTPUT_NOT_CAPTURED'))
        self.assertIn("\n$ContinueLastRunDirectory = '" + run + "'\n", data.decode('utf-8'))
        del self.s.linux['runs'][-1]['captureRefused']; self.s.write()
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(self.s.launcher, 11)
        self.assertEqual(caught.exception.code, 'PRIOR_LINUX_TIMEOUT_NOT_PHASE_AS')

    def test_a_phase_a_timeout_names_its_refusals(self):
        self.a_timeout_scene()
        self.s.linux['runs'][-1]['name'] = 'B'   # a B run without phase A completed: not this case
        self.s.write()
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(self.s.launcher, 11)
        self.assertEqual(caught.exception.code, 'PRIOR_LINUX_TIMEOUT_NOT_PHASE_AS')
        self.s.linux['runs'][-1]['name'] = 'A'
        self.s.write()
        os.rmdir(self.s.ci / 'resident')
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(self.s.launcher, 11)
        self.assertEqual(caught.exception.code, 'RESIDENT_ROOT_MISSING_NOT_CONTINUED')

    # ---- cut off inside the uninstall (no terminal) ----
    def cut_off(self, services, root=True, dry_run=DRY_RUN, kept_name=None):
        s = self.s
        points.inside_scene(s)   # the prior launch's uninstall preflight, ACL, quiesce reports (resume.py's evidence, less its terminal)
        s.terminal['completed'] = list(points.INSIDE)
        s.extra['uninstall.dry-run.stdout.json'] = dry_run
        s.write(terminal=False)
        if (s.prior / 'terminal.json').exists():
            (s.prior / 'terminal.json').unlink()
        if not root and (s.ci / 'resident').exists():
            (s.ci / 'resident').rmdir()
        if kept_name:
            for d in s.kept.iterdir():
                d.rmdir()
            s.kept.rmdir(); (s.ci / kept_name).mkdir()
        return self.build(s.launcher, 11, services=lambda name: services[name])

    def test_a_b_output_the_registrar_refused_to_capture_is_looked_at_again_like_a_timeout(self):
        s = self.s
        run = str(s.ci / 'resident' / 'install' / RUN_NAME)
        s.terminal = dict(s.terminal, completed=base.LINUX_DONE[:7], code='LINUX_PHASE_B_OUTPUT_NOT_CAPTURED', detail={})
        s.linux = {'codes': ['LINUX_PHASE_B_OUTPUT_NOT_CAPTURED'], 'runs': [{'name': 'A', 'outcome': 'EXITED', 'directory': 'x'}, {'name': 'B', 'outcome': 'EXITED', 'captureRefused': 'ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME', 'directory': run}]}
        s.write()
        data, facts = self.build(s.launcher, 11)
        self.assertEqual((facts['mode'], facts['priorStopCode']), ('b-timeout', 'LINUX_PHASE_B_OUTPUT_NOT_CAPTURED'))
        self.assertIn("\n$ContinueLinuxFrom = 'out-directory'\n$ContinueLastRunDirectory = '" + run + "'\n", data.decode('utf-8'))
        del s.linux['runs'][-1]['captureRefused']; s.write()   # an EXITED B without a refused capture is not this case
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(s.launcher, 11)
        self.assertEqual(caught.exception.code, 'PRIOR_LINUX_TIMEOUT_NOT_PHASE_BS')

    def test_cut_off_inside_the_uninstall_with_nothing_uninstalled_runs_the_uninstall_again(self):
        data, facts = self.cut_off(ALL)
        self.assertEqual((facts['mode'], facts['priorCutOff'], facts['priorLastStep']), ('before-uninstall', True, 'quiesce'))
        self.assertIn(CONTINUE.NEW_BEFORE + '  Step-UninstallPreflight\n', data.decode('utf-8').split('#region main', 1)[1])

    def test_cut_off_inside_the_uninstall_after_its_rename_continues_after_the_uninstall(self):
        data, facts = self.cut_off(NONE, root=False)
        text = data.decode('utf-8')
        self.assertEqual((facts['mode'], facts['priorCutOff'], facts['keptRoot'], facts['uninstallPlanSha256']), ('after-uninstall', True, str(self.s.kept), 'c' * 64))
        self.assertIn("\n$ContinueKeptRoot = '" + str(self.s.kept) + "'\n$ContinueUninstallReceiptSha256 = $null\n$ContinueUninstallPlanSha256 = '" + 'c' * 64 + "'\n", text)
        self.assertEqual(set(facts['priorFileSha256']), {'uninstall.dry-run.stdout.json', 'migrate-acl.dry-run.before-uninstall.stdout.json'} | set(CONTINUE.LINUX_FILES))
        self.assertIn(CONTINUE.NEW_AFTER + '  $archiveNeeded = Step-Preflight\n', text.split('#region main', 1)[1])
        base.ContinueGenerator.parses(self, data)

    def test_cut_off_inside_the_uninstall_with_services_deleted_and_no_rename_is_resume_pys_finish(self):
        for services in (NONE, dict(ALL, CluedCIUpgrader=False)):   # all deleted: finished elevated; some still there: Step-FinishUninstall stops on them
            with self.subTest(services=services):
                self.tearDown_scene()
                data, facts = self.cut_off(services)
                text = data.decode('utf-8')
                self.assertEqual((facts['mode'], facts['priorCutOff'], facts['uninstallPlanSha256']), ('inside-uninstall', True, 'c' * 64))
                names = ['uninstall.dry-run.stdout.json', 'uninstall-preflight-report.json', 'migrate-acl.dry-run.before-uninstall.stdout.json', 'parent-acl-report.json', 'quiesce-report.json']
                self.assertIn(CONTINUE.RESUME.finish_pins(sha(self.s.launcher.read_bytes()), str(self.s.prior), {n: sha((self.s.prior / n).read_bytes()) for n in names}, 'c' * 64), text)
                self.assertNotIn("  'terminal.json' = ", text)   # no terminal: the finish proves the plan by the prior dry run
                self.assertIn(CONTINUE.NEW_INSIDE + '  $archiveNeeded = Step-Preflight\n', text.split('#region main', 1)[1])
                base.ContinueGenerator.parses(self, data)
        self.tearDown_scene()
        with self.assertRaises(CONTINUE.Refused) as caught:
            s = self.s; points.inside_scene(s); s.extra['uninstall-preflight-report.json'] = b'{"codes":["X"]}'
            s.terminal['completed'] = list(points.INSIDE); s.extra['uninstall.dry-run.stdout.json'] = DRY_RUN; s.write(terminal=False)
            self.build(s.launcher, 11, services=lambda name: False)
        self.assertEqual((caught.exception.code, caught.exception.detail), ('PRIOR_UNINSTALL_NOT_RESUMES_CASE', 'PRIOR_PREFLIGHT_NOT_THE_ORIGINAL_PINS'))

    def test_cut_off_inside_the_uninstall_in_any_other_state_is_refused_with_what_was_seen(self):
        for services, root, kw, code in ((dict(ALL, CluedCIResident=None), True, {}, 'PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN'),   # not known
                                         (dict(NONE, CluedCIUpgrader=True), False, {}, 'PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN'),   # renamed, a service still there
                                         (NONE, False, {'kept_name': 'resident-uninstalled-20261112T080000Z-0123456789ab'}, 'PRIOR_LAUNCH_CUT_OFF_INSIDE_THE_UNINSTALL_STATE_UNKNOWN'),   # renamed before this launch
                                         (NONE, False, {'dry_run': DRY_RUN.replace(b'"executorAlive": false', b'"executorAlive": true')}, 'PRIOR_UNINSTALL_DRY_RUN_REFUSED')):
            with self.subTest(code=code, root=root, kw=sorted(kw)):
                self.tearDown_scene()
                with self.assertRaises(CONTINUE.Refused) as caught:
                    self.cut_off(services, root=root, **kw)
                self.assertEqual(caught.exception.code, code, caught.exception.detail)
                if code.endswith('STATE_UNKNOWN') and 'kept_name' not in kw:
                    self.assertEqual(caught.exception.detail, {'residentRootExists': root, 'services': services})

    def test_an_inside_uninstall_continuation_cut_off_after_its_rename_is_continued_after_the_uninstall(self):
        s = self.s
        points.inside_scene(s); s.write()
        data1, f1 = self.build(s.launcher, 11)
        self.assertEqual(f1['mode'], 'inside-uninstall')
        c1 = s.work / 'continuation-1.ps1'; c1.write_bytes(data1)
        l1 = Path(f1['launchDir'])
        kept = s.ci / 'resident-uninstalled-20261112T130000Z-abcdefabcdef'   # what its finish renamed the root to (after its last record)
        (kept / 'install').mkdir(parents=True); (s.ci / 'resident').rmdir()
        common = dict(linux_files(s), **{'migrate-acl.dry-run.before-uninstall.stdout.json': b'{"status":"SOURCE_V2_ACL_PLAN_ONLY_NOTHING_WRITTEN"}'})
        # cut off right after the rename: no record of the finish, no report of it
        lay_launch(s, l1, ['output', 'package', 'stage', 'tokens-carried'], None, common)
        data2, f2 = self.build(c1, 14)
        self.assertEqual((f2['mode'], f2['priorLaunchDir'], f2['continuationRenamedTheRoot'], f2['skippedContinuationLaunchDir'], f2['keptRoot'], f2['priorCutOff']),
                         ('after-uninstall', str(l1), True, None, str(kept), True))
        self.assertIn("\n$ContinueUninstallReceiptSha256 = $null\n$ContinueUninstallPlanSha256 = '" + 'c' * 64 + "'\n", data2.decode('utf-8'))   # its receipt, by resume.py's plan pin
        base.ContinueGenerator.parses(self, data2)
        # cut off after the finish recorded itself, before the continuation's own record: the finish's report names the kept root and receipt
        import shutil
        shutil.rmtree(l1); shutil.rmtree(s.ci / ('reinstall-progress-' + sha(str(l1).lower().encode())[:32]))
        lay_launch(s, l1, ['output', 'package', 'stage', 'tokens-carried', 'uninstall-finish-only'], None,
                   dict(common, **{'finish-uninstall-report.json': json.dumps({'status': 'PRIOR_UNINSTALL_RENAME_FINISHED_NO_SERVICE_OPERATION_REPEATED',
                                                                               'uninstall': {'keptAt': str(kept), 'planSha256': 'c' * 64, 'uninstallReceiptSha256': '4' * 64}}).encode()}))
        data3, f3 = self.build(c1, 15)
        self.assertEqual((f3['mode'], f3['priorLaunchDir'], f3['keptRoot']), ('after-uninstall', str(l1), str(kept)))
        self.assertIn("\n$ContinueUninstallReceiptSha256 = '" + '4' * 64 + "'\n$ContinueUninstallPlanSha256 = $null\n", data3.decode('utf-8'))
        # stopped before its rename (the root still there): nothing changed, the original launch is continued again
        shutil.rmtree(l1); shutil.rmtree(s.ci / ('reinstall-progress-' + sha(str(l1).lower().encode())[:32]))
        (s.ci / 'resident').mkdir(); shutil.rmtree(kept)
        lay_launch(s, l1, ['output', 'package', 'stage', 'tokens-carried'], {'status': 'STOPPED', 'code': 'RESUME_SERVICES_NOT_ABSENT'}, common)
        _, f4 = self.build(c1, 16)
        self.assertEqual((f4['mode'], f4['priorLaunchDir'], f4['skippedContinuationLaunchDir']), ('inside-uninstall', str(s.prior), str(l1)))

    def tearDown_scene(self):
        import shutil
        shutil.rmtree(self.s.root, ignore_errors=True)
        self.s = base.Scene(self.tmp.name)
        (self.s.ci / 'resident').mkdir()


ATIMEOUT_EXTRA = ('linux-live-manifest.20261112T100000Z.txt', 'linux-version-facts.20261112T100000Z.json')


@unittest.skipUnless(base.POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class Steps(unittest.TestCase):
    run_step = base.ContinueStep.run_step
    stops = base.ContinueStep.stops

    def a_timeout(self, a_stdout, **case):
        done = json.dumps({'status': 'LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1', 'evidence': '/mnt/x/out/' + ATIMEOUT_EXTRA[0], 'versionFacts': '/mnt/x/out/' + ATIMEOUT_EXTRA[1]})

        def lay(s):
            out = s.ci / 'resident' / 'install' / RUN_NAME / 'out'; out.mkdir(parents=True)
            if a_stdout is not None:
                (out / 'stdout.txt').write_bytes(a_stdout.encode('utf-8'))
            o = s.ci / ('reinstall-linux-out-' + '5' * 32)
            (o / ATIMEOUT_EXTRA[0]).write_bytes(base.EVIDENCE.encode()); (o / ATIMEOUT_EXTRA[1]).write_bytes(json.dumps(base.FACTS).encode())
        return self.run_step(lay, mode='atimeout', completed=base.LINUX_DONE[:6], bStdout='moved x\n' + done + '\n', **case)

    def test_a_finished_phase_a_is_taken_and_b_runs_in_the_launchers_own_step(self):
        a_done = 'staged\n{"status":"PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED","phaseAManifestSha256":"' + 'a' * 64 + '"}\n'
        r, produced, s = self.a_timeout(a_done)
        self.assertIsNone(r['stopped'])
        self.assertEqual((r['done'], r['linuxRuns']), (['continued-a-timeout', 'linux-A', 'linux-B', 'linux-output-checked'], ['B']))   # A is not run again
        report = json.loads(produced[os.path.join('launch', 'linux-report.json')].decode('utf-8'))
        self.assertEqual([(x['name'], x['outcome'], x['directory']) for x in report['runs']], [('A', 'EXITED', str(s.ci / 'resident' / 'install' / RUN_NAME)), ('B', 'EXITED', 'run-B')])
        self.assertEqual(produced[os.path.join('launch', 'linux-A.stdout.txt')].decode('utf-8'), a_done)
        self.assertEqual(sha(produced[os.path.join('stage', 'linux-version-facts.phase-B.json')]), sha(json.dumps(base.FACTS).encode()))
        r, _, _ = self.a_timeout(a_done, outDirOk=False)
        self.assertEqual((r['stopped'], r['linuxRuns'], r['done']), ('CONTINUE_LINUX_OUT_DIRECTORY_NOT_THE_PRIOR_LAUNCHS', [], ['continued-a-timeout']))

    def test_an_unfinished_or_refused_phase_a_runs_nothing(self):
        for stdout, code in (('staging x\n', 'LINUX_PHASE_ENDED_WITHOUT_STATUS'), ('', 'LINUX_PHASE_ENDED_WITHOUT_STATUS'), (None, 'LINUX_PHASE_ENDED_WITHOUT_STATUS'),
                             ('{"status":"REFUSED","code":"OLD_LINUX_NOT_AS_PLANNED"}\n', 'LINUX_PHASE_A_FAILED_AFTER_ITS_TIMEOUT')):
            with self.subTest(code=code, stdout=stdout):
                r, produced, _ = self.a_timeout(stdout)
                self.assertEqual((r['stopped'], r['linuxRuns'], r['done'], r['w1Armed']), (code, [], [], False))   # A ran before: the W1 pause stays
        r, _, _ = self.a_timeout('x\n', lastRun='C:' + chr(92) + 'elsewhere' + chr(92) + RUN_NAME)
        self.assertEqual(r['stopped'], 'CONTINUE_PINS_REFUSED')

    def companion_b(self, b_stdout, out_files=True, **case):
        e_name, f_name = 'linux-live-manifest.20261112T100000Z.txt', 'linux-version-facts.20261112T100000Z.json'

        def lay(s):
            run = s.ci / 'resident' / 'install' / RUN_NAME
            (run / 'out').mkdir(parents=True)   # no captured\ of it: the registrar never captured a run the launcher stopped waiting for
            if b_stdout is not None:
                (run / 'out' / 'stdout.txt').write_bytes(b_stdout.replace('E_PATH', '/mnt/x/out/' + e_name).replace('F_PATH', '/mnt/x/out/' + f_name).encode())
            if out_files:
                o = s.ci / ('reinstall-linux-out-' + '5' * 32)
                (o / e_name).write_bytes(base.EVIDENCE.encode()); (o / f_name).write_bytes(json.dumps(base.FACTS).encode())
        return self.run_step(lay, completed=base.LINUX_DONE[:7], linuxFrom='out-directory', priorPinsOverride={}, companion=True, **dict({'mode': 'before'}, **case))

    def test_a_b_timeout_continuation_stopped_after_its_capture_is_continued_again_on_a_companion_node(self):
        done = 'moved x\n' + json.dumps({'status': 'LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1', 'evidence': 'E_PATH', 'versionFacts': 'F_PATH'}) + '\n'
        r, produced, s = self.companion_b(done, mode='twice', failLocksOnce=True)
        self.assertEqual((r['firstStop'], r['stopped']), ('EXTERNAL_RESIDENT_BINARY_LOCK', None))   # the first run stopped after its captures, the second passed
        self.assertEqual(r['done'], ['file-locks', 'tokens-carried', 'continued-before-uninstall'])
        self.assertEqual(len(r['captureDirs']), 2)   # each run its own captured-<32hex>\ in the prior run directory
        for d in r['captureDirs']:
            self.assertRegex(d, r'\\install\\' + RUN_NAME + r'\\captured-[0-9a-f]{32}$')
            self.assertEqual(sorted(os.path.basename(x) for x in r['captures'] if os.path.dirname(x) == d),
                             ['linux-live-manifest.20261112T100000Z.txt', 'linux-version-facts.20261112T100000Z.json', 'stdout.txt'])   # out\stdout.txt (stderr.txt: not there) and B's two files
        self.assertEqual(r['linux']['factsSha256'], sha(json.dumps(base.FACTS).encode()))
        report = json.loads(produced[os.path.join('launch-2', 'continue-report.json')].decode('utf-8'))
        self.assertEqual(report['state']['captureDirectory'], r['captureDirs'][1])

    def test_a_prior_run_without_its_final_line_is_retried_only_while_one_of_its_processes_is_there(self):
        for companion in (True, False):
            for live, fails, code in ((True, False, 'LINUX_PHASE_STILL_RUNNING_RETRY'), (False, False, 'LINUX_PHASE_ENDED_WITHOUT_STATUS'), (False, True, 'RUN_PROCESS_QUERY_FAILED')):
                with self.subTest(companion=companion, code=code):
                    r, produced, s = (self.companion_b('{"status":"ROOT_STAGING_VERIFIED"}\n', live_process=live, processQueryFails=fails) if companion else
                                      self.a_timeout('staging x\n', live_process=live, processQueryFails=fails))
                    self.assertEqual((r['stopped'], r['done'], r['carried']['directory'], r['linuxRuns']), (code, [], None, []))
                    state = json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))['state']
                    if fails:   # the real function's own refusal, not taken for "none"
                        self.assertEqual((state.get('runProcesses'), state.get('runProcessQuery')), (None, 'RUN_PROCESS_QUERY_FAILED'))
                    else:
                        self.assertEqual(base.run_process_pids(produced), [s.live_pid] if live else [])

    def test_a_run_with_a_process_is_not_read_even_when_its_last_line_looks_final(self):
        done = 'moved x\n' + json.dumps({'status': 'LINUX_REINSTALLED_RESIDENT_UPGRADE_TOOL_GENERATION_1', 'evidence': 'E_PATH', 'versionFacts': 'F_PATH'}) + '\n'
        for companion in (True, False):
            with self.subTest(companion=companion):
                if companion:
                    r, produced, s = self.companion_b(done, live_process=True)
                else:
                    r, produced, s = self.a_timeout('{"status":"PHASE_A_DONE_NOTHING_SIGNED_NOTHING_INSTALLED"}\n', live_process=True)
                self.assertEqual((r['stopped'], r['captures'], r['done']), ('LINUX_PHASE_STILL_RUNNING_RETRY', [], []))   # the process is asked first: nothing captured or read
                self.assertEqual(base.run_process_pids(produced), [s.live_pid])
                self.assertNotIn('phaseBStatus', json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))['state'])
        r, _, _ = self.companion_b(done)   # no process any more: read, and on
        self.assertIsNone(r['stopped'])

    def test_a_refused_capture_is_named_with_the_registrars_code(self):
        r, produced, _ = self.companion_b('x\n', refuseCapture='ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME')
        self.assertEqual((r['stopped'], r['done'], r['carried']['directory']), ('LINUX_PHASE_OUTPUT_NOT_CAPTURED', [], None))
        state = json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))['state']
        self.assertEqual(state['phaseBCaptureRefused'], 'ROOT_RUN_OUTPUT_HAS_ANOTHER_NAME')   # not ENDED_WITHOUT_STATUS: a person looks at the capture

    def test_after_a_cut_off_uninstall_the_kept_receipt_must_name_the_prior_dry_runs_plan(self):
        written = {}

        def receipt(plan):
            def change(s):
                written['bytes'] = json.dumps({'contract': 'clued.independent-ci.resident-uninstall-receipt/3', 'planSha256': plan, 'keptAt': str(s.kept)}).encode()
                (s.kept / 'install' / 'uninstall-receipt.json').write_bytes(written['bytes'])
            return change
        r, produced, s = self.run_step(receipt('c' * 64), uninstallReceiptPin=None, uninstallPlanPin='c' * 64)
        self.assertIsNone(r['stopped'])
        u = json.loads(produced[os.path.join('launch', 'uninstall-report.json')].decode('utf-8'))   # what a continuation of this run reads
        self.assertEqual((u['apply']['keptAt'], u['deletedAndRenamed'], u['evidence']['installReceiptSha256'], u['evidence']['terminalEvidenceMatches'], u['evidence']['uninstallReceiptSha256']),
                         (str(s.kept), True, sha(b'{"receipt":1}'), True, sha(written['bytes'])))
        lr = json.loads(produced[os.path.join('launch', 'linux-report.json')].decode('utf-8'))
        self.assertEqual((lr['codes'], lr['planSha256'], lr['versionFactsSha256']), ([], '9' * 64, sha(json.dumps(base.FACTS).encode())))
        r, _ = self.stops('CONTINUE_KEPT_ROOT_NOT_THE_PRIOR_UNINSTALLS', receipt('d' * 64), uninstallReceiptPin=None, uninstallPlanPin='c' * 64)

    def test_an_uninstall_still_running_stops_every_continuation(self):
        for mode, completed, case in (('after', base.UNINSTALLED, {}), ('before', base.LINUX_DONE, {}), ('inside', points.INSIDE, {'scene': points.inside_scene, 'pinned': points.PRIOR_BASICS})):
            with self.subTest(mode=mode):
                r, _ = self.stops('CONTINUE_UNINSTALL_STILL_RUNNING', None, mode=mode, completed=completed, uninstallProcesses=[{'pid': 4242, 'name': 'powershell.exe'}], **case)
                self.assertEqual(r['done'], [])


if __name__ == '__main__':
    unittest.main()
