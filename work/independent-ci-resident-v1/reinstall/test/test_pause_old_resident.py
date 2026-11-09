"""W1 actual temp-directory protocol tests; no installed node is read or changed."""
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('pause_old_resident', HERE.parent / 'tools' / 'pause-old-resident.py')
pause = importlib.util.module_from_spec(spec); spec.loader.exec_module(pause)
REASON = 'new-exact-reinstall-request'
WANT = hashlib.sha256(json.dumps({'contract': pause.PAUSE_CONTRACT, 'reason': REASON}, separators=(',', ':')).encode()).hexdigest()


class PauseProtocol(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = pathlib.Path(self.tmp.name)
        for name in ('requests', 'state/ledger'):
            (self.root / name).mkdir(parents=True)
        self.now = 0; self.sleeps = []; self.events = []
        self.status()

    def tearDown(self):
        self.tmp.cleanup()

    def doc(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def status(self, *, executor='IDLE', current=None, paused=False, halt=None):
        self.doc('state/status.json', {'contract': 'clued.independent-ci.resident-status/8', 'executor': {'state': executor},
                                      'current': current, 'paused': paused, 'halt': halt})

    def record(self, sha=WANT, reason=REASON):
        self.doc('state/PAUSED.json', {'source': {'requestSha256': sha, 'reason': reason}, 'at': '2026-11-09T00:00:00Z'})

    def run_pause(self, *, emit=None, sleep=None, wait=20):
        def tick(seconds):
            self.sleeps.append(seconds); self.now += seconds
            if sleep:
                sleep(seconds)
        return pause.run_pause(REASON, root=str(self.root), wait_seconds=wait, clock=lambda: self.now,
                               wall_clock=lambda: 1, sleep=tick, token=lambda n: 'a' * (n * 2),
                               emit=emit or self.events.append)

    def refused(self, code, **kwargs):
        with self.assertRaises(pause.PauseRefused) as caught:
            self.run_pause(**kwargs)
        self.assertEqual(caught.exception.report['status'], code)
        return caught.exception.report

    def test_other_pause_before_drop_refuses_immediately_with_exact_resume_digest_and_no_write(self):
        self.record('b' * 64, 'another-stage'); self.status(executor='PAUSED', paused=True)
        before = (self.root / 'state/PAUSED.json').read_bytes()
        result = self.refused('OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED')
        self.assertEqual(result['pausedSha256'], hashlib.sha256(before).hexdigest())
        self.assertIn('-Request Resume -ExpectedPausedSha256 ' + result['pausedSha256'], result['advice'])
        self.assertEqual(list((self.root / 'requests').iterdir()), []); self.assertEqual(self.sleeps, [])
        self.assertEqual((self.root / 'state/PAUSED.json').read_bytes(), before)

    def test_other_pause_racing_after_drop_refuses_without_waiting_or_replacing_either_request(self):
        def raced(event):
            self.events.append(event); self.record('b' * 64, 'raced'); self.status(executor='PAUSED', paused=True)
        self.refused('OLD_RESIDENT_PAUSED_BY_OTHER_REQUEST_RESUME_REQUIRED', emit=raced)
        files = list((self.root / 'requests').iterdir())
        self.assertEqual(len(files), 1); self.assertEqual(hashlib.sha256(files[0].read_bytes()).hexdigest(), WANT)
        self.assertEqual(self.sleeps, [])

    def test_exact_existing_pause_reuses_only_after_current_and_ledger_guards(self):
        self.record(); self.status(executor='PAUSED', paused=True)
        result = self.run_pause()
        self.assertTrue(result['reusedExistingRequest']); self.assertEqual(result['status'], 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH')
        self.assertEqual(list((self.root / 'requests').iterdir()), [])
        entry = self.root / 'state/ledger/open'; entry.mkdir()
        self.refused('PAUSE_NOT_CONFIRMED_OR_BATCH_STILL_OPEN_DO_NOT_START_LINUX')
        self.assertEqual(self.now, 20); self.assertEqual(list((self.root / 'requests').iterdir()), [])

    def test_exact_pause_with_open_batch_waits_until_both_current_and_ledger_are_closed(self):
        self.record(); self.status(executor='PAUSED', paused=True, current={'batch': 'still-running'})
        entry = self.root / 'state/ledger/open'; entry.mkdir()
        def close(_):
            self.status(executor='PAUSED', paused=True); self.doc('state/ledger/open/90-terminal.json', {'closed': True})
        result = self.run_pause(sleep=close)
        self.assertIsNone(result['current']); self.assertEqual(result['openLedgerEntries'], []); self.assertEqual(self.sleeps, [10])
        self.assertTrue(result['reusedExistingRequest'])
        self.assertEqual(list((self.root / 'requests').iterdir()), [])

    def test_new_request_acceptance_and_status_lag_do_not_skip_closed_ledger_check(self):
        entry = self.root / 'state/ledger/open'; entry.mkdir()
        def accepted(event):
            self.events.append(event); self.record(); self.status(executor='PAUSED', paused=True)
        def close(_):
            self.doc('state/ledger/open/90-terminal.json', {'closed': True})
        result = self.run_pause(emit=accepted, sleep=close)
        self.assertEqual(result['status'], 'OLD_RESIDENT_PAUSED_NO_OPEN_BATCH'); self.assertEqual(self.sleeps, [10])
        self.assertFalse(result['reusedExistingRequest'])
        self.assertEqual(len(list((self.root / 'requests').iterdir())), 1)

    def test_halt_initial_and_raced_never_report_success(self):
        self.doc('state/HALT.json', {'halt': True})
        self.refused('OLD_RESIDENT_HALTED_GET_A_REVIEW'); self.assertEqual(list((self.root / 'requests').iterdir()), [])
        (self.root / 'state/HALT.json').unlink()
        def raced(_):
            self.record(); self.status(executor='PAUSED', paused=True); self.doc('state/HALT.json', {'halt': True})
        self.refused('OLD_RESIDENT_HALTED_GET_A_REVIEW', emit=raced); self.assertEqual(self.sleeps, [])

    def test_bad_json_unknown_executor_or_missing_current_refuses_before_drop(self):
        for raw in ('{broken', '[]', json.dumps({'contract': 'clued.independent-ci.resident-status/8', 'executor': {'state': 'NEW_UNKNOWN'},
                                                'current': None, 'paused': False, 'halt': None}),
                    json.dumps({'contract': 'clued.independent-ci.resident-status/8', 'executor': {'state': 'IDLE'}, 'paused': False, 'halt': None})):
            with self.subTest(raw=raw):
                (self.root / 'state/status.json').write_text(raw)
                self.refused('OLD_RESIDENT_STATE_UNREADABLE_DO_NOT_START_LINUX')
                self.assertEqual(list((self.root / 'requests').iterdir()), []); self.assertEqual(self.sleeps, [])

    def test_bad_pause_or_paused_status_without_record_refuses_before_drop(self):
        (self.root / 'state/PAUSED.json').write_text('{broken')
        self.refused('OLD_RESIDENT_PAUSE_STATE_UNREADABLE_RESUME_REQUIRED')
        (self.root / 'state/PAUSED.json').unlink(); self.status(executor='PAUSED', paused=True)
        self.refused('OLD_RESIDENT_PAUSE_RECORD_MISSING_DO_NOT_START_LINUX')
        self.assertEqual(list((self.root / 'requests').iterdir()), [])

    def test_matching_digest_with_a_different_reason_is_not_a_reusable_acknowledgement(self):
        self.record(reason='a different request'); self.status(executor='PAUSED', paused=True)
        self.refused('OLD_RESIDENT_PAUSE_STATE_UNREADABLE_RESUME_REQUIRED')
        self.assertEqual(list((self.root / 'requests').iterdir()), []); self.assertEqual(self.sleeps, [])


if __name__ == '__main__':
    unittest.main()
