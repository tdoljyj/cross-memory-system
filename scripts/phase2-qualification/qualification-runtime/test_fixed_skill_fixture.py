"""Pure predicates and blocked Windows boundary; never execute isolated action."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fixed_fixture_candidate', Path(__file__).with_name('fixed_skill_fixture.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FixedPrimitiveTests(unittest.TestCase):
    def test_only_exact_accepted_subject_bytes_match(self):
        root = Path(__file__).resolve().parents[3] / 'skills' / 'clued'
        blobs = {path: (root / path).read_bytes() for path in m.SUBJECT}
        self.assertTrue(m.subject_bytes_valid(blobs))
        self.assertFalse(m.subject_bytes_valid({**blobs, 'extra.md': b'extra'}))
        for path in blobs:
            self.assertFalse(m.subject_bytes_valid({**blobs, path: blobs[path] + b'\n'}))

    def test_environment_is_exact_no_credential_or_unreviewed_defaults(self):
        self.assertTrue(m.environment_valid(dict(m.PUBLIC_ENV)))
        self.assertFalse(m.environment_valid({**m.PUBLIC_ENV, 'CLUED_SYNTHETIC_CREDENTIAL_CANARY': 'synthetic-only'}))
        self.assertFalse(m.environment_valid({**m.PUBLIC_ENV, 'HOSTNAME': 'unreviewed'}))
        self.assertFalse(m.environment_valid({}))

    def test_process_isolation_cannot_be_shape_faked(self):
        token = {'NoNewPrivs': '1', 'CapEff': '0000000000000000', 'CapPrm': '0000000000000000', 'Seccomp': '2'}
        self.assertTrue(m.isolated_process_valid('linux', 10001, 1, token, ['lo']))
        for uid, pid, observed, interfaces in ((0, 1, token, ['lo']), (10001, True, token, ['lo']),
                (10001, 1, {**token, 'CapEff': '0000000000000001'}, ['lo']),
                (10001, 1, {**token, 'Seccomp': '0'}, ['lo']), (10001, 1, token, ['eth0', 'lo'])):
            self.assertFalse(m.isolated_process_valid('linux', uid, pid, observed, interfaces))

    def test_host_rejected_before_skill_read_or_fixture_write(self):
        with patch.object(m.sys, 'platform', 'win32'), patch.object(m, 'read_subject') as read, patch.object(m, 'persist_fixed_fixture') as write:
            with self.assertRaises(m.Denied):
                m.isolated_action_primitive()
            read.assert_not_called()
            write.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
