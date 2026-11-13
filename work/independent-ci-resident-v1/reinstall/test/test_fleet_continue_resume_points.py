"""The two later continuation points of a package reinstall (launcher/continue.py, launcher/continue-install.ps1): a launch stopped INSIDE
the uninstall (resume.py's reviewed half-uninstall, finished by its own Step-FinishUninstall) and a launch whose install completed and a
later step did not pass. Offline stand-ins only (test_fleet_continue.py's scene and PowerShell driver): nothing is elevated, no real root,
secret, task or service is touched."""
import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest

import test_fleet_continue as base
from test_resume_evidence import fixture as resume_terminal

CONTINUE, RESUME, LAUNCHER = base.CONTINUE, base.CONTINUE.RESUME, base.LAUNCHER
sha = base.sha
NOW = datetime.datetime(2026, 11, 12, 11, 0, 0, tzinfo=datetime.timezone.utc)
INSIDE = base.LINUX_DONE + ['uninstall-preflight', 'parent-acl-checked', 'quiesce']
INSTALLED = base.UNINSTALLED + ['install']
UNINSTALL_SHA = 'e' * 64
RECEIPT_BYTES = b'{"receipt":1}'
PAUSE_SHA = sha(b'{"contract":"clued.independent-ci.resident-pause/1","reason":"reinstall pause"}')   # the driver's $PauseReason
MAIN_TAIL_INSIDE = '  $archiveNeeded = Step-Preflight\n'


def inside_scene(s):
    """The prior launch stopped as resume.py's evidence describes it, with this launcher's completed steps."""
    t = resume_terminal()
    t.update(sourceSha='1' * 40, packageHead='2' * 40, completed=list(INSIDE))
    s.terminal = t
    s.pins['InstalledUninstallSha256'] = "'" + UNINSTALL_SHA + "'"
    s.extra.update({'uninstall-preflight-report.json': json.dumps({'codes': [], 'installedReceiptSha256': base.RECEIPT, 'installedUninstallSha256': UNINSTALL_SHA}).encode(),
                    'parent-acl-report.json': b'{"now":"fixture","error":null}', 'quiesce-report.json': b'{"residentStopped":true,"brokerStopped":true,"noProcessUnderRoot":true}'})


def installed_scene(s, post, status='R4_WINDOWS_REINSTALLED_VERIFIED_PAUSED', verify='RESIDENT_VERIFIED', confirmed=True, companion=True, cleared=True,
                    headless='COMPANION_HEADLESS_FELL_BACK', maintenance=False):
    """The prior launch completed the install; post: its steps after it (as the launcher names them)."""
    s.terminal.update(completed=INSTALLED + list(post), status=status, code=None, detail=None, companion={'started': companion, 'maintenanceDeferred': maintenance})
    s.extra.update({'install-receipt.json': RECEIPT_BYTES, 'first-train-report.json': json.dumps({'runnerQuiet': not post or post[0] != 'runner-not-quiet-verify-skipped'}).encode(),
                    'verify.stdout.json': ('starting\n' + json.dumps({'status': verify}, indent=2)).encode(),
                    'pause-report.json': json.dumps({'verified': verify == 'RESIDENT_VERIFIED', 'confirmed': confirmed, 'requestSha256': PAUSE_SHA}).encode(),
                    'rearm-report.json': json.dumps({'notNeeded': False, 'cleared': cleared}).encode(),
                    'companion-headless-report.json': json.dumps({'ran': True, 'status': headless}).encode()})


@unittest.skipUnless(os.name == 'nt', 'Windows paths are the source contract')
class Generation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fleet-continue-points-'); self.addCleanup(self.tmp.cleanup)
        self.s = base.Scene(self.tmp.name)
        (self.s.ci / 'resident').mkdir()

    def build(self, **kw):
        self.s.write(**kw)
        return CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=NOW)

    def refused(self, code, **kw):
        with self.assertRaises(CONTINUE.Refused) as caught:
            self.build(**kw)
        self.assertEqual(caught.exception.code, code, caught.exception.detail)
        return caught.exception

    def parses(self, data):
        base.ContinueGenerator.parses(self, data)

    def assert_no_node_value_in_the_command(self):
        out = self.s.root / ('continuation-%d.ps1' % len(os.listdir(self.s.root)))
        real = CONTINUE.build
        printed = io.StringIO()
        try:
            CONTINUE.build = lambda launcher: real(launcher, ci_root=str(self.s.ci), now=NOW)
            with contextlib.redirect_stdout(printed):
                self.assertEqual(CONTINUE.main(['--fleet-continue', str(self.s.launcher), '--out', str(out)]), 0)
        finally:
            CONTINUE.build = real
        line = json.loads(printed.getvalue())
        self.assertEqual(line['status'], 'FLEET_CONTINUATION_GENERATED')
        self.assertNotIn('node-a', line['elevatedCommand'])   # the node's name is a pin of the launcher, never part of the command
        self.assertEqual(line['elevatedCommand'].count(' -RunApprovedInstall'), 1)
        self.assertNotIn('-Companion', line['elevatedCommand'])
        self.assertEqual(sha(out.read_bytes()), line['launcher']['sha256'])

    # ---- inside the uninstall ----
    def test_inside_the_uninstall_resume_py_finishes_it_and_the_install_preflight_follows(self):
        inside_scene(self.s)
        data, facts = self.build()
        text, original = data.decode('utf-8'), self.s.launcher.read_text(encoding='utf-8')
        self.assertEqual((facts['mode'], facts['priorStopCode'], facts['uninstallPlanSha256'], facts['afterInstallFrom']), ('inside-uninstall', 'UNINSTALL_NOT_COMPLETED', 'c' * 64, None))
        self.assertEqual(sorted(facts['priorFileSha256']), sorted(set(RESUME.FILES) | set(base.CONTINUE.LINUX_FILES)))
        hashes = {name: sha((self.s.prior / name).read_bytes()) for name in RESUME.FILES}
        self.assertIn(RESUME.finish_pins(sha(self.s.launcher.read_bytes()), str(self.s.prior), hashes, 'c' * 64), text)   # resume.py's pins, its own code
        finish = (LAUNCHER / 'finish-uninstall.ps1').read_text(encoding='utf-8')
        self.assertEqual(text.count('function Step-FinishUninstall {'), 1); self.assertIn(finish, text)   # its reviewed fragment, unchanged
        main = text.split('#region main', 1)[1]
        self.assertIn(CONTINUE.NEW_INSIDE + MAIN_TAIL_INSIDE, main)
        self.assertEqual(main.split(MAIN_TAIL_INSIDE, 1)[1], original.split('#region main', 1)[1].split(MAIN_TAIL_INSIDE, 1)[1])   # the install preflight on: the launcher's own
        for gone in ('Step-LinuxRoot', 'Step-UninstallPreflight', 'Step-Quiesce', '$uninstall = Step-Uninstall', '$parentAcl = Step-ParentAcl', 'Step-WindowsPreflightBeforeLinux'):
            self.assertNotIn(gone, main, gone)
        self.parses(data)
        self.assert_no_node_value_in_the_command()
        self.s.terminal['completed'] = ['carry-swept'] + INSIDE   # a sweep before the launch directory existed: no progress record, the same case
        self.assertEqual(self.build()[1]['mode'], 'inside-uninstall')

    def test_inside_the_uninstall_only_resume_pys_case(self):
        inside_scene(self.s)
        keep = json.loads(json.dumps(self.s.terminal))
        for change, code in ((lambda t: t['detail']['apply'].update(exit=0, status='RESIDENT_UNINSTALLED_EVIDENCE_KEPT'), 'PRIOR_UNINSTALL_ALREADY_COMPLETED_OR_UNKNOWN'),
                             (lambda t: t['detail']['after'].update(residentRootExists=False), 'PRIOR_UNINSTALL_ROOT_NOT_QUIET'),
                             (lambda t: t['detail']['dryRun']['plan'].update(executorAlive=True), 'PRIOR_UNINSTALL_PLAN_REFUSED'),
                             (lambda t: t.update(completed=base.LINUX_DONE[:3] + ['uninstall-preflight', 'parent-acl-checked', 'quiesce']), None)):
            self.s.terminal = json.loads(json.dumps(keep)); change(self.s.terminal)
            for f in list((self.s.prior / 'progress').iterdir()) if (self.s.prior / 'progress').is_dir() else []:
                f.unlink()
            refusal = self.refused('PRIOR_UNINSTALL_NOT_RESUMES_CASE')
            if code:
                self.assertEqual(refusal.detail, code)
        self.s.terminal = json.loads(json.dumps(keep))
        self.s.extra['uninstall-preflight-report.json'] = json.dumps({'codes': ['OLD_RESIDENT_OPEN_BATCH'], 'installedReceiptSha256': base.RECEIPT, 'installedUninstallSha256': UNINSTALL_SHA}).encode()
        self.assertEqual(self.refused('PRIOR_UNINSTALL_NOT_RESUMES_CASE').detail, 'PRIOR_PREFLIGHT_NOT_THE_ORIGINAL_PINS')
        inside_scene(self.s)
        self.s.write()
        (self.s.ci / 'resident').rmdir()
        self.refused('RESIDENT_ROOT_MISSING_NOT_CONTINUED')

    # ---- after the install ----
    def start_of(self, post, **kw):
        installed_scene(self.s, post, **kw)
        for f in list((self.s.prior / 'progress').iterdir()) if (self.s.prior / 'progress').is_dir() else []:
            f.unlink()
        return self.build()

    def test_after_the_install_the_continuation_starts_after_the_last_step_that_passed(self):
        original = None
        cases = (
            (['runner-not-quiet-verify-skipped', 'pause-not-confirmed-resident-stopped'], dict(status='R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED', verify='NOT_RUN', companion=False), 'first-train'),
            (['first-train', 'verify', 'pause-not-confirmed-resident-stopped'], dict(status='R4_WINDOWS_REINSTALLED_VERIFY_NOT_PASSED_RESIDENT_STOPPED', verify='RESIDENT_NOT_VERIFIED', companion=False), 'verify'),
            (['first-train-not-applicable', 'verify', 'pause-not-confirmed-resident-stopped'], dict(status='PAUSE_NOT_CONFIRMED', confirmed=False, companion=False), 'pause'),
            (['first-train', 'verify', 'pause', 'companion'], dict(companion=False), 'companion'),
            (['first-train', 'verify', 'pause', 'companion', 'rearm'], dict(cleared=False), 'rearm'),
            (['first-train-not-observed', 'verify', 'pause', 'companion', 'rearm-not-needed', 'companion-headless'], {}, 'companion-headless'),
            (['first-train', 'verify', 'pause', 'companion', 'rearm', 'companion-headless'], dict(status='STOPPED', headless='COMPANION_HEADLESS_QUALIFICATION_FAILED'), 'companion-headless'))
        for post, kw, start in cases:
            with self.subTest(start=start, post=post[-1]):
                data, facts = self.start_of(post, **kw)
                text = data.decode('utf-8'); original = original or self.s.launcher.read_text(encoding='utf-8')
                self.assertEqual((facts['mode'], facts['afterInstallFrom']), ('after-install', start))
                at = CONTINUE.POST_INSTALL.index(start)
                pinned = ['install-receipt.json', 'first-train-report.json', 'verify.stdout.json', 'pause-report.json', 'rearm-report.json']
                want = set(CONTINUE.LINUX_FILES) | {'terminal.json'} | {pinned[0]} | {n for i, n in ((1, pinned[1]), (2, pinned[2]), (3, pinned[3]), (5, pinned[4])) if at >= i}
                self.assertEqual(set(facts['priorFileSha256']), want)
                self.assertIn("\n$ContinueAfterInstallFrom = '" + start + "'\n", text + '\n')
                main = text.split('#region main', 1)[1]
                self.assertIn(CONTINUE.NEW_INSTALLED, main)
                for gone in ('Step-LinuxRoot', 'Step-UninstallPreflight', 'Step-Quiesce', 'Step-Uninstall', 'Step-Preflight', 'Step-Install', '$carried = Step-CarryTokens', 'Remove-FleetCarry }   # the installer'):
                    self.assertNotIn(gone, main, gone)   # nothing up to and including the install runs again, no token is carried
                for i, step in enumerate(CONTINUE.POST_INSTALL[:-1]):
                    carried = CONTINUE.POST_LINES[step] + '$continue.' + CONTINUE.POST_LINES[step].strip()[1:-2] + CONTINUE.CARRIED_LINE
                    self.assertEqual(carried in main, i < at, step)
                first = CONTINUE.POST_LINES.get(start, '  $companionHeadless = ')
                tail = first + main.split('\n' + first, 1)[1]
                own = original.split('#region main', 1)[1]
                self.assertEqual(tail.replace('Step-ContinuePauseAfterInstall (', 'Step-PauseAfterInstall ('), first + own.split('\n' + first, 1)[1])   # from the start on: the launcher's own lines
                self.assertEqual('Step-ContinuePauseAfterInstall (' in main, at <= 2)   # a pause that is to run is checked first
                self.parses(data)
        self.assert_no_node_value_in_the_command()

    def test_after_the_install_what_is_not_continued_is_named(self):
        done = ['first-train', 'verify', 'pause', 'companion', 'rearm-not-needed', 'companion-headless']
        for post, kw, code in ((done, dict(headless='COMPANION_HEADLESS_QUALIFIED'), 'PRIOR_LAUNCH_COMPLETED_NOTHING_TO_CONTINUE'),
                               (['first-train', 'verify', 'pause', 'companion-headless'], dict(companion=False), 'PRIOR_LAUNCH_RAN_COMPANION_MAINTENANCE_NOT_CONTINUED'),
                               (done[:4], dict(companion=False, maintenance=True), 'PRIOR_LAUNCH_RAN_COMPANION_MAINTENANCE_NOT_CONTINUED'),
                               (['first-train', 'verify', 'pause'], dict(verify='RESIDENT_NOT_VERIFIED'), 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT'),
                               (['first-train', 'verify', 'pause'], dict(confirmed=False), 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT'),
                               (['runner-not-quiet-verify-skipped', 'verify'], {}, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT'),
                               (['first-train', 'verify', 'companion'], {}, 'PRIOR_POST_INSTALL_RECORDS_INCONSISTENT')):
            with self.subTest(code=code, post=post):
                with self.assertRaises(CONTINUE.Refused) as caught:
                    self.start_of(post, **kw)
                self.assertEqual(caught.exception.code, code, caught.exception.detail)
        # cut off after the last step: whether the companion task started is unknown, so the continuation starts there (it is repeatable)
        installed_scene(self.s, done, headless='COMPANION_HEADLESS_QUALIFIED')
        self.s.write(terminal=False)
        (self.s.prior / 'terminal.json').unlink()
        _, facts = CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=NOW)
        self.assertEqual((facts['mode'], facts['afterInstallFrom'], facts['priorHadTerminal']), ('after-install', 'companion', False))
        (self.s.prior / 'verify.stdout.json').unlink()
        with self.assertRaises(CONTINUE.Refused) as caught:
            CONTINUE.build(str(self.s.launcher), ci_root=str(self.s.ci), now=NOW)
        self.assertEqual((caught.exception.code, caught.exception.detail), ('PRIOR_EVIDENCE_MISSING', 'verify.stdout.json'))
        shutil.rmtree(self.s.ci / 'resident')
        self.refused('RESIDENT_ROOT_MISSING_NOT_CONTINUED')

    def test_the_pause_body_is_the_launchers(self):
        template = (LAUNCHER / 'template.ps1').read_text(encoding='utf-8')
        fragment = (LAUNCHER / 'continue-install.ps1').read_text(encoding='utf-8')
        body = """$U8.GetBytes('{"contract":"clued.independent-ci.resident-pause/1","reason":"' + $PauseReason + '"}')"""
        self.assertIn(body, template); self.assertIn(body, fragment)


SCENE_KEYS = ('verify', 'confirmed', 'companion', 'cleared', 'headless', 'status')
PRIOR_BASICS = ['terminal.json', 'linux-report.json', 'linux-version-facts.json', 'linux-live-manifest.txt']


@unittest.skipUnless(base.POWERSHELL.is_file(), 'Windows PowerShell 5.1 required')
class Steps(unittest.TestCase):
    """The two new steps with the template's real token, rule, read and stop functions; resume.py's Step-FinishUninstall, the companion
    task, the pause step and sc.exe are stand-ins (test_fleet_continue.py's driver)."""
    run_step = base.ContinueStep.run_step   # the same driver and token checks (no token text in any output or file it leaves)
    stops = base.ContinueStep.stops

    def inside_case(self, change=None, **case):
        return dict(case, change=change, mode='inside', completed=INSIDE, scene=inside_scene, pinned=PRIOR_BASICS)

    def test_inside_the_uninstall_tokens_from_the_live_root_before_the_finish(self):
        r, produced, s = self.run_step(**self.inside_case())
        self.assertIsNone(r['stopped'])
        self.assertEqual(r['copies'], {'upgradeToken': sha((base.UPGRADE + '\n').encode()), 'heartbeatToken': sha(base.HEARTBEAT.encode())})   # the live root's bytes
        self.assertEqual((r['finish']['carryPresent'], r['finish']['rootThere'], r['finish']['factsSha256']), (True, True, sha(json.dumps(base.FACTS).encode())))   # carried before the rename
        self.assertEqual(r['done'], ['tokens-carried', 'uninstall-finish-only', 'continued-inside-uninstall'])
        self.assertEqual((r['uninstall']['planSha256'], r['carryDuring'], r['carried']['removed'], r['carryLeft']), ('6' * 64, True, True, 0))
        self.assertEqual(json.loads(produced[os.path.join('launch', 'continue-report.json')].decode('utf-8'))['mode'], 'inside-uninstall')

    def test_inside_the_uninstall_any_doubt_stops_and_leaves_no_token_copy(self):
        r, _ = self.stops('RESUME_SERVICES_NOT_ABSENT', **self.inside_case(finishStops=True))
        self.assertEqual((r['finish']['carryPresent'], r['carried']['removed']), (True, True))   # the finish's own stop removes the copies
        for code, change, case in (('CONTINUE_PINS_REFUSED', None, {'resumePrior': 'C:' + chr(92) + 'other'}),
                                   ('CONTINUE_ROOT_RENAMED_OR_RECEIPTED_NOT_THIS_STATE', lambda s: (s.ci / 'resident' / 'install' / 'uninstall-receipt.json').write_bytes(b'{}'), {}),
                                   ('CONTINUE_ROOT_RENAMED_OR_RECEIPTED_NOT_THIS_STATE', lambda s: shutil.rmtree(s.ci / 'resident'), {}),
                                   ('CONTINUE_PRIOR_LAUNCH_STILL_RUNNING', None, {'priorIsThisProcess': True}),
                                   ('CONTINUE_PRIOR_EVIDENCE_CHANGED', lambda s: (s.prior / 'terminal.json').write_bytes(b'{}'), {}),
                                   ('CARRIED_TOKEN_FINGERPRINT_MISMATCH', lambda s: (s.ci / 'resident' / 'secrets' / 'resident-upgrade.token').write_text('clued' + '_bnd_' + 'Z' * 40, encoding='ascii'), {})):
            with self.subTest(code=code):
                r, _ = self.stops(code, **self.inside_case(change, **case))
                self.assertIsNone(r['finish'], code)   # never reached resume.py's finish

    def installed_case(self, post, start, change=None, pinned=(), **case):
        """run_step keywords: the prior launch installed (post: its later steps), the node with the install's receipt and the pause in force."""
        scene_kw = {k: case.pop(k) for k in list(case) if k in SCENE_KEYS}
        case.setdefault('servicesPresent', ['CluedCIResident', 'CluedCISwapBroker', 'CluedCIUpgrader'])   # installed

        def lay(s):
            (s.ci / 'resident' / 'state').mkdir(parents=True, exist_ok=True)
            (s.ci / 'resident' / 'state' / 'PAUSED.json').write_text(json.dumps({'source': {'requestSha256': PAUSE_SHA}}), encoding='utf-8')
            if change:
                change(s)
        return dict(case, change=lay, mode='install', completed=INSTALLED + list(post), scene=lambda s: installed_scene(s, post, **scene_kw),
                    pinned=PRIOR_BASICS + ['install-receipt.json'] + list(pinned), receiptPin=sha(RECEIPT_BYTES), **{'from': start})

    def test_after_the_install_the_passed_steps_are_proven_and_no_token_is_touched(self):
        post = ['first-train', 'verify', 'pause', 'companion', 'rearm-not-needed', 'companion-headless']
        r, produced, _ = self.run_step(**self.installed_case(post, 'companion-headless', pinned=['first-train-report.json', 'verify.stdout.json', 'pause-report.json', 'rearm-report.json']))
        self.assertIsNone(r['stopped'])
        step = r['step']
        self.assertEqual((step['verify']['status'], step['pause']['requestSha256'], step['companion']['started'], step['rearm']['notNeeded'], step['install']['receiptSha256']),
                         ('RESIDENT_VERIFIED', PAUSE_SHA, True, False, sha(RECEIPT_BYTES)))
        self.assertEqual((r['done'], r['copies'], r['carried']['directory'], r['sc']), (['first-train-not-observed', 'verify', 'pause', 'companion', 'rearm', 'continued-after-install'], {}, None, []))
        for name in ('install-receipt.json', 'first-train-report.json', 'verify.stdout.json', 'pause-report.json', 'rearm-report.json', 'linux-report.json'):
            self.assertIn(os.path.join('launch', name), produced, name)   # what a continuation of this run reads from its launch directory
        self.assertIn(os.path.join('stage', 'linux-version-facts.phase-B.json'), produced)   # verify's facts staged again
        # a stopped resident at the start is started again only when the prior launch stopped it itself
        stopped = ['first-train', 'verify', 'pause-not-confirmed-resident-stopped']
        r, _, _ = self.run_step(**self.installed_case(stopped, 'verify', pinned=['first-train-report.json'], residentState=1, startWorks=True))
        self.assertEqual((r['stopped'], r['sc'], r['done']), (None, ['start CluedCIResident'], ['first-train-not-observed', 'continued-after-install']))
        r, _ = self.stops('CONTINUE_RESIDENT_NOT_STARTED', **self.installed_case(stopped, 'verify', pinned=['first-train-report.json'], residentState=1))
        r, _ = self.stops('CONTINUE_RESIDENT_STOPPED_NOT_BY_THE_PRIOR_LAUNCH', **self.installed_case(['first-train', 'verify'], 'pause', pinned=['first-train-report.json', 'verify.stdout.json'], residentState=1))
        self.assertEqual(r['sc'], [])

    def test_after_the_install_any_doubt_stops(self):
        post, later = ['first-train', 'verify', 'pause', 'companion', 'rearm'], ['first-train-report.json', 'verify.stdout.json', 'pause-report.json']
        for code, change in (('CONTINUE_INSTALL_NOT_THE_PRIOR_LAUNCHS', lambda s: (s.ci / 'resident' / 'install' / 'install-receipt.json').write_bytes(b'{"receipt":2}')),   # installed again since
                             ('CONTINUE_INSTALL_NOT_THE_PRIOR_LAUNCHS', lambda s: shutil.rmtree(s.ci / 'resident')),
                             ('CONTINUE_PRIOR_PAUSE_NO_LONGER_IN_FORCE', lambda s: (s.ci / 'resident' / 'state' / 'PAUSED.json').unlink()),
                             ('CONTINUE_PRIOR_PAUSE_NO_LONGER_IN_FORCE', lambda s: (s.ci / 'resident' / 'state' / 'PAUSED.json').write_text(json.dumps({'source': {'requestSha256': '0' * 64}}), encoding='utf-8')),
                             ('CONTINUE_PRIOR_EVIDENCE_CHANGED', lambda s: (s.prior / 'verify.stdout.json').write_bytes(b'{"status":"RESIDENT_VERIFIED"}'))):
            with self.subTest(code=code):
                r, _ = self.stops(code, **self.installed_case(post, 'rearm', change, pinned=later, cleared=False))
                self.assertEqual((r['done'], r['sc']), ([], []))
        r, _ = self.stops('CONTINUE_PRIOR_STEP_DID_NOT_PASS', **self.installed_case(['first-train', 'verify', 'pause'], 'companion', pinned=later, verify='RESIDENT_NOT_VERIFIED'))   # proven again elevated
        r, _ = self.stops('CONTINUE_PINS_REFUSED', **self.installed_case(['first-train'], 'bogus', pinned=['first-train-report.json']))

    def test_the_pause_already_in_force_is_not_requested_again(self):
        def run(state, verified):
            def lay(s):
                (s.ci / 'resident' / 'state').mkdir(parents=True, exist_ok=True)
                if state:
                    (s.ci / 'resident' / 'state' / 'PAUSED.json').write_text(json.dumps({'source': {'requestSha256': state}}), encoding='utf-8')
            r, produced, _ = self.run_step(lay, mode='pause', completed=INSTALLED, verified=verified)
            return r, produced
        r, produced = run(PAUSE_SHA, True)
        self.assertEqual((r['stopped'], r['originalPause'], r['step']['confirmed'], r['step']['alreadyInForce'], r['done']), (None, 0, True, True, ['pause']))
        self.assertEqual(json.loads(produced[os.path.join('launch', 'pause-report.json')].decode('utf-8'))['requestSha256'], PAUSE_SHA)
        for state, verified in ((PAUSE_SHA, False), ('0' * 64, True), (None, True)):
            r, _ = run(state, verified)
            self.assertEqual((r['originalPause'], r['done']), (1, ['pause-stand-in']), (state, verified))   # the launcher's own step


if __name__ == '__main__':
    unittest.main()
