"""One targeted author/committer check, no old suite or live publication."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('branch_identity_helpers', Path(__file__).with_name('test_branch_successor.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class IdentityFix(unittest.TestCase):
    def test_fixed_author_committer_payload_and_readback(self):
        fixture = h.BranchSuccessorTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        original_write = fixture.api._write
        def write(stage, body):
            result = original_write(stage, body)
            if stage == 'commit':
                self.assertEqual(body['author'], {'name': 'Codex@DESK-W-591', 'email': 'codex@local'})
                self.assertEqual(body['committer'], body['author'])
                result.update(author=dict(body['author']), committer=dict(body['committer']))
            return result
        fixture.api._write = write
        success = fixture.publish()
        self.assertEqual(success['status'], 'IMMUTABLE_REMOTE_BYTES_READ_BACK')
        for role in ('author', 'committer'):
            saved = fixture.api.commit[role]
            fixture.api.commit[role] = {'name': 'tdoljyj', 'email': 'codex@local'}
            with self.assertRaises(h.m.Unknown):
                h.m.read_back(fixture.api, success['reference'], h.RAW)
            fixture.api.commit[role] = saved


if __name__ == '__main__':
    unittest.main(verbosity=2)
