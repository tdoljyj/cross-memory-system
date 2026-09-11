"""Pure rejection regression: no Docker, network, budget, or authority operation."""
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('root5_parent', HERE / 'control-context-verifier-root5-window5-forward11-successor' / 'parent600.py')
parent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parent)
profile = json.loads((HERE / 'preentry-parent/profile-runtime600/ProfileDefinition.json').read_text(encoding='utf-8'))
runtime = json.loads((HERE.parents[1] / 'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v15/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json').read_text(encoding='utf-8'))

class Root5ParentReadiness(unittest.TestCase):
    def ga(self, start, end):
        ga = dict(runtime['accepted_subject']['expected_ga'])
        ga.update(authorization_status='AUTHORIZED', issued_at=start, expires_at=end, deadline=end)
        ga.update(runner_generation='test_runner', credential_generation='test_credential', session_generation='test_session')
        return ga

    def test_root5_original_window_is_not_rejected_by_expired_root3_cutoff(self):
        ga = self.ga('2026-09-11T05:00:00Z', '2026-09-11T05:10:00Z')
        parent.reject_constraints(ga, profile, datetime(2026, 9, 11, 5, 1, tzinfo=timezone.utc))

    def test_root5_cutoff_still_rejects_one_second_excess(self):
        ga = self.ga('2026-09-11T10:11:06Z', '2026-09-11T10:21:06Z')
        with self.assertRaisesRegex(parent.Blocked, 'owner_window_exceeded'):
            parent.reject_constraints(ga, profile, datetime(2026, 9, 11, 10, 12, tzinfo=timezone.utc))

    def test_lifetime_and_phase_rejections_are_preserved(self):
        ga = self.ga('2026-09-11T05:00:00Z', '2026-09-11T05:10:01Z')
        with self.assertRaisesRegex(parent.Blocked, 'expired_or_unbounded_ga'):
            parent.reject_constraints(ga, profile, datetime(2026, 9, 11, 5, 1, tzinfo=timezone.utc))
        ga['environment'] = 'PRODUCTION'
        with self.assertRaisesRegex(parent.Blocked, 'wrong_phase_or_purpose'):
            parent.reject_constraints(ga, profile, datetime(2026, 9, 11, 5, 1, tzinfo=timezone.utc))

if __name__ == '__main__':
    unittest.main()
