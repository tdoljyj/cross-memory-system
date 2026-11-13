"""History compatibility and actual accepted uninstaller moves under a temp prefix."""
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('history', ROOT / 'linux/tools/check-reinstall-history.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class History(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.opt = self.root / 'opt/clued-independent-ci'
        self.state = self.root / 'var/lib/clued-independent-ci/resident'
        self.windows = self.root / 'windows'
        self.groups = {k: (str(self.opt / Path(src).relative_to(h.OPT)) if src.startswith(h.OPT) else
                           str(self.state / Path(src).relative_to(h.STATE)), kept) for k, (src, kept) in h.GROUPS.items()}
        self.write(self.opt / 'upgrade-v1/tool', b'old tool')
        self.write(self.opt / 'generations/g1/resident-v1/old', b'old generation one')
        self.write(self.opt / 'generations/g2/source-v2/old', b'rolled back generation two')
        self.write(self.opt / 'archive/old-evidence', b'kept evidence')
        self.write(self.state / 'install-plan.json', b'{}')
        self.write(self.state / 'upgrade-v1-install-plan.json', b'{}')
        self.facts = {'contract': 'clued.independent-ci.linux-version-facts/1', 'generation': 1, 'staged': None,
                      'pinsOk': True, 'sourceCommit': 'a' * 40, 'ciSourceManifestSha256': 'b' * 64, 'manifestSha256': 'c' * 64}
        self.cur = {'contract': 'clued.independent-ci.linux-upgrade-current/1', 'generation': 1,
                    'opId': 'historical-completed-op', 'sourceCommit': 'a' * 40,
                    'ciSourceManifestSha256': 'b' * 64, 'linuxManifestSha256': 'c' * 64, 'packageManifestSha256': 'd' * 64}
        self.doc(self.state / 'upgrade/current.json', self.cur)
        self.doc(self.state / 'upgrade/g1.json', {**self.cur, 'contract': 'clued.independent-ci.linux-upgrade-generation/1'})
        self.doc(self.state / 'upgrade/g2.json', {'generation': 2, 'outcome': 'rolled-back'})
        self.doc(self.windows / 'status.json', {'contract': 'clued.independent-ci.resident-upgrade-status/1', 'op': None,
                                              'writtenAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        self.doc(self.windows / 'current.json', {'contract': 'clued.independent-ci.resident-generation/1',
                                               'linux': {'generation': 1, 'manifestSha256': 'c' * 64, 'ciSourceManifestSha256': 'b' * 64}})
        lines = ['active=', 'opt=yes', 'units=clued-ci-worker@.service', 'saved-wsl-conf=', 'upgrade-v1=yes',
                 'generations=g1 g2 ', 'archive=yes', 'staging=', 'upgrade-state=current.json g1.json g2.json ',
                 'saved-plans= install-plan.json upgrade-v1-install-plan.json']
        self.plan = '\n'.join(lines) + '\n' + json.dumps({'status': 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN',
                                                         'planSha256': hashlib.sha256('\n'.join(lines).encode()).hexdigest()})

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def doc(self, path, data):
        self.write(path, json.dumps(data).encode())

    def capture(self, facts=None, plan=None):
        return h.capture(plan or self.plan, facts or self.facts, self.groups, str(self.windows))

    def test_rolled_back_history_is_accepted_and_live_identity_is_bound(self):
        snap = self.capture()
        h.verify(snap, windows=str(self.windows))
        self.write(self.opt / 'archive/added', b'new')
        with self.assertRaisesRegex(ValueError, 'HISTORY_CHANGED_SINCE_PHASE_A'):
            h.verify(snap, windows=str(self.windows))

    def test_a_half_installed_node_is_judged_by_the_linux_sides_own_history(self):
        # DESIGN section 73, desk-w-591 on 2026-11-13 (package 45d41ebf, phase A): Linux is generation 1 of the package whose launch
        # stopped past phase B, its own current.json and g1.json say so, and the Windows record still names the Linux generation of
        # the install before it. Phase A refused HISTORY_WINDOWS_GENERATION_MISMATCH / UPGRADE_HISTORY_NOT_SETTLED with nothing written.
        self.doc(self.windows / 'current.json', {'contract': 'clued.independent-ci.resident-generation/1', 'ciSourceManifestSha256': '1' * 64,
                                               'linux': {'generation': 1, 'manifestSha256': 'c' * 64, 'ciSourceManifestSha256': '1' * 64}})
        snap = self.capture()                       # phase A
        h.verify(snap, windows=str(self.windows))   # phase B, before anything is moved
        self.assertEqual((snap['generation'], snap['facts']['ciSourceManifestSha256']), (1, 'b' * 64))
        # what the Windows side must still say is only that no upgrade operation is under way
        self.doc(self.windows / 'status.json', {'contract': 'clued.independent-ci.resident-upgrade-status/1', 'op': {'opId': 'x'},
                                              'writtenAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        with self.assertRaisesRegex(ValueError, 'WINDOWS_UPGRADE_OPERATION_PRESENT_OR_UNKNOWN'):
            self.capture()
        with self.assertRaisesRegex(ValueError, 'WINDOWS_UPGRADE_OPERATION_PRESENT_OR_UNKNOWN'):
            h.verify(snap, windows=str(self.windows))

    def test_pending_stage_and_mismatching_current_generation_are_refused(self):
        for change in ({'staged': {'generation': 2}}, {'generation': 2}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.capture({**self.facts, **change})
        self.doc(self.state / 'upgrade/g1.json', {**self.cur, 'contract': 'clued.independent-ci.linux-upgrade-generation/1', 'sourceCommit': 'e' * 40})
        with self.assertRaisesRegex(ValueError, 'HISTORY_CURRENT_RECORD_MISMATCH'):
            self.capture()

    def test_missing_staged_is_unknown_not_settled(self):
        missing = {k: v for k, v in self.facts.items() if k != 'staged'}
        with self.assertRaisesRegex(ValueError, 'HISTORY_FACTS_NOT_SETTLED'):
            self.capture(missing)

    @unittest.skipUnless(os.name == 'posix', 'real Linux flock boundary')
    def test_persistent_tool_lock_is_preserved_but_held_lock_is_refused(self):
        import fcntl
        path = self.state / 'upgrade/.tool.lock'
        self.write(path, b'')
        snap = self.capture()
        self.assertIn('.tool.lock', snap['groups']['upgrade-state']['entries'])
        h.verify(snap, windows=str(self.windows))
        with path.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'HISTORY_UPGRADE_TOOL_BUSY'):
                self.capture()
            with self.assertRaisesRegex(ValueError, 'HISTORY_UPGRADE_TOOL_BUSY'):
                h.verify(snap, windows=str(self.windows))
        h.verify(snap, windows=str(self.windows))

    def test_unknown_hidden_history_is_not_ignored(self):
        self.write(self.state / 'upgrade/.unexpected', b'unknown')
        with self.assertRaisesRegex(ValueError, 'HISTORY_PLAN_NOT_LIVE'):
            self.capture()

    def test_tool_lock_directory_is_refused(self):
        (self.state / 'upgrade/.tool.lock').mkdir()
        with self.assertRaisesRegex(ValueError, 'HISTORY_TOOL_LOCK_NOT_REGULAR'):
            self.capture()

    def test_active_unknown_or_stale_windows_operation_is_refused(self):
        for status in ({'op': {'id': 'active'}}, {'writtenAt': '2026-01-01T00:00:00Z'}, {}):
            self.doc(self.windows / 'status.json', status)
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.capture()

    def test_unreported_history_and_incorrect_plan_hash_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'UNINSTALL_PLAN_HASH_MISMATCH'):
            self.capture(plan=self.plan.replace('generations=g1 g2 ', 'generations='))
        self.write(self.opt / 'generations/unreported/file', b'x')
        with self.assertRaisesRegex(ValueError, 'HISTORY_PLAN_NOT_LIVE'):
            self.capture()

    def test_actual_keep_function_moves_complete_history_without_deleting(self):
        bash = os.environ.get('CLUED_TEST_BASH') or shutil.which('bash')
        if not bash or (os.name == 'nt' and 'git' not in bash.lower()):
            self.skipTest('needs non-WSL bash')
        if os.name == 'posix':
            self.write(self.state / 'upgrade/.tool.lock', b'')
        snap = self.capture()
        keep = self.root / 'kept'
        source = ROOT.parent / 'linux/uninstall-resident-linux.sh'
        code = ('source "$1"; CI_OPT="$2/opt/clued-independent-ci"; STATE="$2/var/lib/clued-independent-ci"; '
                'UPG="$CI_OPT/upgrade-v1"; GENS="$CI_OPT/generations"; ARCH="$CI_OPT/archive"; '
                'UPG_STATE="$STATE/resident/upgrade"; SAVED_PLANS="$STATE/resident/install-plan.json $STATE/resident/upgrade-v1-install-plan.json"; '
                'keep_upgrade_channel "$3"')
        result = subprocess.run([bash, '--noprofile', '--norc', '-c', code, 'x', source.as_posix(), self.root.as_posix(), keep.as_posix()],
                                capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        h.verify(snap, str(keep))
        self.assertTrue(all(not os.path.lexists(src) for src, _ in self.groups.values()))
        self.assertEqual((keep / 'generations/g2/source-v2/old').read_bytes(), b'rolled back generation two')
        (keep / 'opt-archive/old-evidence').unlink()
        with self.assertRaisesRegex(ValueError, 'KEPT_HISTORY_CHANGED_OR_INCOMPLETE'):
            h.verify(snap, str(keep))


if __name__ == '__main__':
    unittest.main()


class HistoryLimitsTest(unittest.TestCase):
    """DESK 2026-11-08: 29 upgraded generations kept about 300 000 history entries (archive g1-g26), over the old 200 000
    bound, and the snapshot of them is tens of MB, over the old 4 MB JSON bound; phase A refused HISTORY_TREE_TOO_LARGE."""

    def test_bounds_fit_a_long_upgrade_history(self):
        self.assertGreaterEqual(h.MAX_ENTRIES, 1000000)
        self.assertGreaterEqual(h.MAX_SNAPSHOT_BYTES, 128 << 20)

    def test_entry_bound_still_refuses(self):
        d = tempfile.mkdtemp()
        try:
            for i in range(3):
                Path(d, 'f%d' % i).write_bytes(b'x')
            old = h.MAX_ENTRIES
            h.MAX_ENTRIES = 3
            try:
                with self.assertRaisesRegex(ValueError, 'HISTORY_TREE_TOO_LARGE'):
                    h.tree(d)
            finally:
                h.MAX_ENTRIES = old
            self.assertEqual(len(h.tree(d)), 4)
        finally:
            shutil.rmtree(d)

    def test_large_snapshot_is_readable_small_json_still_bounded(self):
        d = tempfile.mkdtemp()
        try:
            p = Path(d, 'snap.json')
            p.write_text(json.dumps({'pad': 'x' * (5 << 20)}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'HISTORY_JSON_NOT_REGULAR'):
                h.read_json(str(p))
            self.assertEqual(len(h.read_json(str(p), h.MAX_SNAPSHOT_BYTES)['pad']), 5 << 20)
        finally:
            shutil.rmtree(d)
