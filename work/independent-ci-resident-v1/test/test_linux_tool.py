"""Offline tests for the pure parts of linux/bin/clued-ci-resident-linux (run on any OS):
python -I -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1)."""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader('resident_linux', str(HERE.parent / 'linux' / 'bin' / 'clued-ci-resident-linux'))
spec = importlib.util.spec_from_loader('resident_linux', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

BATCH = '0123456789abcdef-0123456789ab'
JOB = 'e' * 64


class Instances(unittest.TestCase):
    def test_instances_are_strict(self):
        self.assertEqual(tool.parse_instance('worker', JOB), {'jobId': JOB})
        self.assertEqual(tool.parse_instance('archive', f'{BATCH}_formal-bridge-stage-deadline'), {'batchId': BATCH, 'reason': 'formal-bridge-stage-deadline'})
        for unit, inst in [('worker', 'x'), ('wsprep', '../etc'), ('archive', BATCH), ('archive', f'{BATCH}_Bad'), ('shell', BATCH)]:
            with self.assertRaises(tool.Refused):
                tool.parse_instance(unit, inst)

    def test_cgroup_and_container_facts_fail_closed(self):
        self.assertTrue(tool.cgroup_unpopulated('populated 0\nfrozen 0\n'))
        self.assertFalse(tool.cgroup_unpopulated('populated 1\nfrozen 0\n'))
        self.assertFalse(tool.cgroup_unpopulated(None), 'unreadable is not proven')
        self.assertFalse(tool.cgroup_unpopulated('garbage'))
        self.assertEqual(tool.containers_quiet(['abc exited', 'def dead'])[0], True)
        for state in ('running', 'paused', 'restarting', 'created'):
            self.assertFalse(tool.containers_quiet(['abc exited', f'def {state}'])[0], state)

    def test_other_units_must_be_inactive(self):
        out = '\n'.join([
            f'clued-ci-worker@{JOB}.service loaded inactive dead Clued job',
            f'clued-ci-archive@{BATCH}_x.service loaded activating start Clued archive',
            f'clued-ci-wsprep@{BATCH}.service loaded failed failed Clued prep',
        ])
        self.assertEqual(tool.other_units_quiet(out, f'clued-ci-archive@{BATCH}_x.service'), [])
        self.assertEqual(tool.other_units_quiet(out, None), [f'clued-ci-archive@{BATCH}_x.service'])


class Archive(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        r = pathlib.Path(self.tmp.name)
        (r / 'formal-spool' / 'incoming').mkdir(parents=True)
        (r / 'formal-spool' / 'outgoing').mkdir(parents=True)
        (r / 'formal-spool' / 'failed-b22-history-source-3eb5ae18959b').mkdir()
        (r / 'formal-spool' / 'failed-b22-history-source-3eb5ae18959b' / 'old.json').write_text('old')
        (r / 'formal-spool' / 'incoming' / 'issue.json').write_text('{"job":{"id":"x"}}')
        (r / 'formal-spool' / 'incoming' / 'issue.ready.json').write_text('{}')
        (r / 'formal-spool' / 'outgoing' / 'active.lock').write_text('{"pid":1}')
        (r / 'formal-role.lock').write_text('lock')
        (r / 'runs' / f'gitleaks-{JOB}').mkdir(parents=True)
        (r / 'runs' / f'gitleaks-{JOB}' / 'uncertain.json').write_text('{}')
        (r / 'workspaces' / JOB / '.git').mkdir(parents=True)
        self.root = str(r)

    def tearDown(self):
        self.tmp.cleanup()

    def test_plan_and_apply_move_everything_once_to_flat_names_and_delete_nothing(self):
        plan = tool.plan_archive(self.root, BATCH, 'formal-bridge-stage-deadline', [JOB], 'a' * 12)
        self.assertFalse(plan['deletesAnything'])
        self.assertEqual([m['from'] for m in plan['moves']], [
            'formal-spool/incoming/issue.json', 'formal-spool/incoming/issue.ready.json', 'formal-spool/outgoing/active.lock', 'formal-role.lock',
            f'runs/gitleaks-{JOB}', f'workspaces/{JOB}'])
        # b28: every destination is a flat name directly inside the archive directory
        self.assertTrue(all(m['to'].count('/') == 2 and m['to'].startswith(plan['target'] + '/') for m in plan['moves']))
        result = tool.apply_archive(self.root, plan)
        self.assertEqual(result['moved'], 6)
        self.assertEqual(result['deleted'], 0)
        target = pathlib.Path(self.root) / plan['target']
        self.assertEqual((target / 'incoming-issue.json').read_text(), '{"job":{"id":"x"}}')
        self.assertTrue((target / f'run-gitleaks-{JOB}' / 'uncertain.json').exists())
        self.assertTrue((target / f'workspace-{JOB}' / '.git').is_dir())
        self.assertFalse((target / 'runs').exists() or (target / 'workspaces').exists() or (target / 'formal-spool').exists())
        self.assertTrue((target / 'intent.json').exists() and (target / 'receipt.json').exists())
        self.assertEqual((pathlib.Path(self.root) / 'formal-spool' / 'failed-b22-history-source-3eb5ae18959b' / 'old.json').read_text(), 'old')
        self.assertFalse((pathlib.Path(self.root) / 'formal-role.lock').exists())
        # A second plan finds nothing left except earlier archives, which are never touched.
        again = tool.plan_archive(self.root, BATCH, 'success-close', [JOB], 'b' * 12)
        self.assertEqual(again['moves'], [])
        self.assertTrue(again['target'].startswith('formal-spool/archive-'))
        self.assertEqual(result['scope'], 'batch')

    def test_between_roles_moves_only_protocol_records_and_requires_the_role_slot_released(self):
        with self.assertRaises(tool.Refused) as held:
            tool.plan_archive(self.root, BATCH, 'between-roles-4', [JOB], 'd' * 12)
        self.assertEqual(held.exception.code, 'ROLE_LOCK_HELD_PRESERVED')
        os.unlink(os.path.join(self.root, 'formal-role.lock'))
        plan = tool.plan_archive(self.root, BATCH, 'between-roles-4', [JOB], 'd' * 12)
        self.assertEqual(plan['scope'], 'protocol')
        self.assertEqual([m['from'] for m in plan['moves']], ['formal-spool/incoming/issue.json', 'formal-spool/incoming/issue.ready.json', 'formal-spool/outgoing/active.lock'])
        self.assertTrue(plan['target'].startswith('formal-spool/archive-'))
        tool.apply_archive(self.root, plan)
        self.assertEqual(os.listdir(os.path.join(self.root, 'formal-spool', 'incoming')), [])
        # A failure-derived reason that merely starts with "between-roles" is a full batch archive.
        full = tool.plan_archive(self.root, BATCH, 'between-roles-archive-unconfirmed', [JOB], 'f' * 12)
        self.assertEqual(full['scope'], 'batch')
        self.assertIn(f'runs/gitleaks-{JOB}', [m['from'] for m in full['moves']])

    def test_completed_scopes_refuse_unknown_leaves_and_half_pairs_failure_scopes_report_them(self):
        r = pathlib.Path(self.root)
        os.unlink(r / 'formal-role.lock')
        (r / 'formal-spool' / 'incoming' / 'evil.json').write_text('x')
        with self.assertRaises(tool.Refused) as unknown:
            tool.plan_archive(self.root, BATCH, 'between-roles-6', [JOB], 'e' * 12)
        self.assertEqual(unknown.exception.code, 'UNKNOWN_SPOOL_LEAF_PRESERVED')
        os.unlink(r / 'formal-spool' / 'incoming' / 'evil.json')
        (r / 'formal-spool' / 'outgoing' / 'challenge-01.json').write_text('{}')  # no ready marker
        with self.assertRaises(tool.Refused) as half:
            tool.plan_archive(self.root, BATCH, 'success-close', [JOB], 'e' * 12)
        self.assertEqual(half.exception.code, 'HALF_PROTOCOL_PAIR_PRESERVED')
        (r / 'formal-spool' / 'incoming' / 'evil.json').write_text('x')
        failed = tool.plan_archive(self.root, BATCH, 'bridge-transport-timeout', [JOB], 'e' * 12)
        self.assertEqual(failed['remainderLeftInPlace'], ['incoming/evil.json'])
        self.assertEqual(failed['halfPairs'], ['outgoing/challenge-01'])
        self.assertNotIn('formal-spool/incoming/evil.json', [m['from'] for m in failed['moves']])
        result = tool.apply_archive(self.root, failed)
        self.assertEqual(result['remainderLeftInPlace'], ['incoming/evil.json'])
        self.assertTrue((r / 'formal-spool' / 'incoming' / 'evil.json').exists(), 'unknown leaves stay in place')

    def test_multi_link_files_and_redirected_parents_are_refused(self):
        r = pathlib.Path(self.root)
        os.link(r / 'formal-role.lock', r / 'formal-spool' / 'outgoing' / 'result.json')
        with self.assertRaises(tool.Refused):
            tool.plan_archive(self.root, BATCH, 'x', [JOB], 'e' * 12)

    def test_a_leaf_or_tree_that_changes_after_planning_stops_the_archive_with_a_partial_status(self):
        plan = tool.plan_archive(self.root, BATCH, 'x', [JOB], 'c' * 12)
        # a byte change inside the tree (the directory's own entry is unchanged)
        (pathlib.Path(self.root) / 'runs' / f'gitleaks-{JOB}' / 'uncertain.json').write_text('{"changed": true}')
        with self.assertRaises(tool.Refused) as changed:
            tool.apply_archive(self.root, plan)
        self.assertEqual(changed.exception.code, 'ARCHIVE_TREE_CHANGED_BEFORE_MOVE')
        partial = json.loads((pathlib.Path(self.root) / plan['target'] / 'partial.json').read_text())
        self.assertEqual(partial, {'verified': False, 'moved': 4, 'code': 'ARCHIVE_TREE_CHANGED_BEFORE_MOVE'})
        self.assertTrue((pathlib.Path(self.root) / 'runs' / f'gitleaks-{JOB}').exists(), 'the changed tree stays where it is')
        # a new entry changes the directory itself: refused before the move as well
        plan2 = tool.plan_archive(self.root, BATCH, 'y', [JOB], 'd' * 12)
        (pathlib.Path(self.root) / 'runs' / f'gitleaks-{JOB}' / 'late.json').write_text('{}')
        with self.assertRaises(tool.Refused):
            tool.apply_archive(self.root, plan2)

    def test_a_repeated_archive_instance_returns_the_earlier_result_including_a_partial_one(self):
        self.assertIsNone(tool.earlier_result(os.path.join(self.root, 'none.json')))
        done = os.path.join(self.root, 'done.json')
        with open(done, 'w') as f:
            json.dump({'verified': True, 'moved': 5, 'deleted': 0, 'directory': 'failed-x', 'scope': 'batch', 'quiescence': {}}, f)
        self.assertEqual(tool.earlier_result(done), {'verified': True, 'moved': 5, 'deleted': 0, 'directory': 'failed-x', 'scope': 'batch', 'replayed': True})
        part = os.path.join(self.root, 'part.json')
        with open(part, 'w') as f:
            json.dump({'verified': False, 'partial': True, 'code': 'ARCHIVE_TREE_CHANGED_AFTER_MOVE', 'directory': 'failed-y', 'quiescence': {}}, f)
        self.assertEqual(tool.earlier_result(part)['verified'], False)

    def test_archive_usage_counts_only_earlier_archive_directories(self):
        r = pathlib.Path(self.root)
        (r / 'formal-spool' / 'archive-0123456789ab-success-close-aaaaaaaaaaaa').mkdir()
        (r / 'formal-spool' / 'archive-0123456789ab-success-close-aaaaaaaaaaaa' / 'x.json').write_bytes(b'1234567890')
        u = tool.archive_usage(self.root)
        self.assertEqual(u, {'contract': 'clued.independent-ci.linux-archive-usage/1', 'bytes': 13, 'directories': 2})

    def test_plan_refuses_bad_ids(self):
        with self.assertRaises(tool.Refused):
            tool.plan_archive(self.root, BATCH, 'x', ['nothex'], 'a' * 12)
        with self.assertRaises(tool.Refused):
            tool.plan_archive(self.root, '../../x', 'x', [JOB], 'a' * 12)


if __name__ == '__main__':
    unittest.main()
