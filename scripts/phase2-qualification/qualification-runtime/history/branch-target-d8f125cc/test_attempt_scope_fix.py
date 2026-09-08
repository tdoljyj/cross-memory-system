"""One targeted successor check; no previous suite or live transport rerun."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('branch_test_helpers', Path(__file__).with_name('test_branch_successor.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


class AttemptScopeFix(unittest.TestCase):
    def test_prior_success_objects_are_not_attributed_to_new_failed_attempt(self):
        fixture = helpers.BranchSuccessorTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.assertEqual(fixture.publish('attempt-a')['status'], 'IMMUTABLE_REMOTE_BYTES_READ_BACK')
        previous_tickets = {item.name: item.read_bytes() for item in (helpers.m.BASE / 'work' / 'attempt-a').glob('*.json')}
        self.assertEqual(fixture.api.publication_objects['commit'], helpers.COMMIT)
        writes = list(fixture.api.writes)
        fixture.api.repository = {'full_name': helpers.m.REPOSITORY, 'private': False}
        failed = fixture.publish('attempt-b')
        self.assertEqual(failed['status'], 'UNKNOWN')
        self.assertEqual(failed['known_immutable_objects'], {})
        self.assertEqual(fixture.api.writes, writes)
        self.assertEqual(previous_tickets, {item.name: item.read_bytes() for item in (helpers.m.BASE / 'work' / 'attempt-a').glob('*.json')})


if __name__ == '__main__':
    unittest.main(verbosity=2)
