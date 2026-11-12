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

    def test_retry_stage_keeps_the_workspaces_and_moves_protocol_role_lock_and_runs(self):
        # Generation 11 (DESIGN 54; stage 2: DESIGN 59): an execution stage run again in the same batch keeps what the run again needs.
        r = pathlib.Path(self.root)
        (r / 'formal-spool' / 'outgoing' / 'challenge-01.json').write_text('{}')  # a half pair: a failure scope takes it as found
        (r / 'workspaces').mkdir(exist_ok=True)
        (r / 'workspaces' / JOB).mkdir(exist_ok=True)
        (r / f'ws-prep-{BATCH}').mkdir(exist_ok=True)
        for reason in ('retry-stage-2-1', 'retry-stage-2-2', 'retry-stage-4-1', 'retry-stage-4-2', 'retry-stage-6-1', 'retry-stage-6-2'):
            plan = tool.plan_archive(self.root, BATCH, reason, [JOB], 'a' * 12)
            self.assertEqual((plan['scope'], plan['completed']), ('stage-retry', False))
            self.assertTrue(plan['target'].startswith(f'formal-spool/failed-{BATCH[:12]}-{reason}-'))
            froms = [m['from'] for m in plan['moves']]
            self.assertIn('formal-role.lock', froms)
            self.assertIn(f'runs/gitleaks-{JOB}', froms)
            self.assertIn('formal-spool/outgoing/challenge-01.json', froms)
            self.assertFalse(any(f.startswith('workspaces/') or f.startswith('ws-prep-') for f in froms), froms)
        plan = tool.plan_archive(self.root, BATCH, 'retry-stage-4-1', [JOB], 'a' * 12)
        tool.apply_archive(self.root, plan)
        self.assertTrue((r / 'workspaces' / JOB).is_dir())
        self.assertTrue((r / f'ws-prep-{BATCH}').is_dir())
        self.assertFalse((r / 'formal-role.lock').exists())
        self.assertEqual(os.listdir(r / 'formal-spool' / 'outgoing'), [])
        # only the six exact reasons keep the workspaces
        for reason in ('retry-stage-4', 'retry-stage-3-1', 'retry-stage-2-3', 'retry-stage-46-1', 'retry-stage-4-x', 'retry-stage-4-3', 'retry-stage-4-12'):
            self.assertEqual(tool.plan_archive(self.root, BATCH, reason, [JOB], 'b' * 12)['scope'], 'batch', reason)

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


class Retention(unittest.TestCase):
    """DESIGN S35: the same rule as src/retention.mjs (shared cases), the keep list, a pass, and success-archive slimming."""
    CASES = json.loads((HERE / 'fixtures' / 'retention-cases.json').read_text(encoding='utf-8'))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_plan_matches_every_shared_case(self):
        for c in self.CASES['cases']:
            entries = [{'name': e[0], 'mtimeMs': e[1], 'bytes': e[2], 'complete': True, 'isDir': True, 'links': 0, **(e[3] if len(e) > 3 else {})} for e in c['entries']]
            p = tool.plan_retention(entries, set(c.get('keep', [])), c.get('rule', self.CASES['rule']))
            self.assertEqual([d['name'] for d in p['deletes']], c['deletes'], c['name'])
            self.assertEqual({'success': p['classes']['success']['refused'], 'failure': p['classes']['failure']['refused']}, c['refused'], c['name'])
            self.assertEqual(p['deferred'], c['deferred'], c['name'])
            self.assertEqual(p['protected']['directories'], c['protected'], c['name'])

    def test_keep_list_is_exact_and_fails_closed(self):
        owner = self.root / 'owner'
        owner.mkdir()
        f = owner / 'retention-keep.json'
        # a missing file refuses (review M2); only the Owner's file, even with an empty list, allows deletion
        self.assertEqual(tool.read_keep_list(str(f), 'linux'), {'ok': False, 'code': 'RETENTION_KEEP_LIST_MISSING'})
        self.assertEqual(tool.read_keep_list(str(self.root / 'nowhere' / 'k.json'), 'linux')['code'], 'RETENTION_KEEP_LIST_MISSING')
        f.write_text(json.dumps({'contract': tool.KEEP_CONTRACT, 'keep': []}))
        self.assertEqual(tool.read_keep_list(str(f), 'linux'), {'ok': True, 'names': set(), 'entries': 0})
        f.unlink()
        f.write_text(json.dumps({'contract': tool.KEEP_CONTRACT, 'keep': [{'name': 'failed-a-1', 'spool': 'linux', 'ref': 'Task 4aedda54'},
                                                                          {'name': 'archive-b', 'spool': 'windows', 'ref': 'owner'}, {'name': 'failed-c', 'spool': 'any', 'ref': 'Bug x'}]}))
        self.assertEqual(tool.read_keep_list(str(f), 'linux')['names'], {'failed-a-1', 'failed-c'})
        f.write_text(json.dumps({'contract': tool.KEEP_CONTRACT, 'keep': [{'name': '../etc', 'spool': 'linux', 'ref': 'x'}]}))
        self.assertEqual(tool.read_keep_list(str(f), 'linux'), {'ok': False, 'code': 'RETENTION_KEEP_LIST_INVALID'})

    def _spool(self, dirs):
        spool = self.root / 'formal-spool'
        (spool / 'incoming').mkdir(parents=True)
        for i, (name, size) in enumerate(dirs):
            (spool / name / 'sub').mkdir(parents=True)
            (spool / name / 'sub' / 'f.bin').write_bytes(b'x' * size)
            os.utime(spool / name, ns=(1_700_000_000_000_000_000 + i * 60_000_000_000,) * 2)
        return spool

    def test_owner_settings_apply_per_class_budgets_and_invalid_settings_delete_nothing(self):
        spool = self._spool([('archive-a', 10), ('archive-b', 10), ('failed-a', 10), ('failed-b', 10), ('failed-c', 10)])
        keep = self.root / 'keep.json'
        settings = self.root / 'settings.json'
        keep.write_text(json.dumps({'contract': tool.KEEP_CONTRACT, 'keep': []}))
        settings.write_text('{')
        self.assertEqual(tool.configured_prune(str(spool), str(keep), str(settings))['refused'], 'RETENTION_SETTINGS_INVALID')
        self.assertTrue((spool / 'archive-a').exists())
        s = {'contract': 'clued.independent-ci.retention-settings/1', 'emptyKeep': 'refuse',
             'linux': {'success': {'classBudgetBytes': 0, 'minKeepPerClass': 1}, 'failure': {'classBudgetBytes': 0, 'minKeepPerClass': 2}}}
        settings.write_text(json.dumps(s))
        self.assertEqual(tool.configured_prune(str(spool), str(keep), str(settings))['refused'], 'RETENTION_EMPTY_KEEP_UNCONFIRMED')
        s['emptyKeep'] = 'allow'
        settings.write_text(json.dumps(s))
        result = tool.configured_prune(str(spool), str(keep), str(settings))
        self.assertEqual(len(result['deleted']), 2)
        self.assertEqual(len([n for n in spool.iterdir() if tool.archive_class(n.name)]), 3)

    def test_settings_parser_refuses_unsafe_numbers_and_unconfirmed_empty_warns(self):
        for bad in (-1, 1.2, True, '1', 9007199254740992):
            with self.assertRaises(tool.Refused):
                tool.parse_retention_settings(json.dumps({'contract': 'clued.independent-ci.retention-settings/1',
                    'linux': {'failure': {'classBudgetBytes': bad, 'minKeepPerClass': 1}}}).encode())
        spool = self._spool([('archive-a', 1)])
        keep = self.root / 'keep.json'
        keep.write_text(json.dumps({'contract': tool.KEEP_CONTRACT, 'keep': []}))
        result = tool.configured_prune(str(spool), str(keep), str(self.root / 'missing-settings'))
        self.assertEqual(result['warnings'], ['RETENTION_EMPTY_KEEP_UNCONFIRMED'])
        self.assertEqual(result['deleted'], [])

    def test_a_pass_deletes_oldest_over_budget_and_keeps_protected_newest_and_everything_else(self):
        spool = self._spool([('failed-a-1', 800), ('failed-a-2', 800), ('failed-a-3', 300), ('failed-a-4', 300), ('archive-b-1', 600), ('archive-b-2', 600), ('completed-b-3', 10)])
        rule = {'classBudgetBytes': 1000, 'minKeepPerClass': 2, 'maxDeletesPerPass': 16}
        r = tool.prune_spool(str(spool), {'ok': True, 'names': {'failed-a-1'}}, rule)
        self.assertEqual((r['refused'], r['stopped']), (None, None))
        self.assertEqual([d['name'] for d in r['deleted']], ['failed-a-2', 'archive-b-1'])
        self.assertEqual(sorted(os.listdir(spool)), ['archive-b-2', 'completed-b-3', 'failed-a-1', 'failed-a-3', 'failed-a-4', 'incoming'])
        pub = tool.public_prune(r)
        self.assertEqual(sorted(pub['protected']), ['bytes', 'complete', 'directories'])
        self.assertEqual(tool.prune_spool(str(spool), {'ok': False, 'code': 'RETENTION_KEEP_LIST_INVALID'}, rule)['refused'], 'RETENTION_KEEP_LIST_INVALID')

    @unittest.skipUnless(hasattr(os, 'symlink') and os.name != 'nt', 'symbolic links (POSIX)')
    def test_a_link_in_a_class_refuses_that_class_and_is_never_followed(self):
        spool = self._spool([('failed-a-1', 800), ('failed-a-2', 800), ('failed-a-3', 800)])
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'precious').write_text('keep')
        os.symlink(outside, spool / 'failed-a-1' / 'sub' / 'escape')
        r = tool.prune_spool(str(spool), {'ok': True, 'names': set()}, {'classBudgetBytes': 1000, 'minKeepPerClass': 1, 'maxDeletesPerPass': 16})
        self.assertEqual((r['classes']['failure']['refused'], r['deleted']), ('RETENTION_LINK_REFUSED', []))
        with self.assertRaises(tool.Refused):
            tool.remove_tree(str(spool / 'failed-a-1'))
        self.assertEqual((outside / 'precious').read_text(), 'keep')

    def test_a_directory_that_changed_after_planning_stops_the_pass(self):
        spool = self._spool([('failed-a-1', 800), ('failed-a-2', 800), ('failed-a-3', 800)])

        def remove(path):
            (spool / 'failed-a-2' / 'sub' / 'late.bin').write_bytes(b'y')  # grows while the pass runs
            tool.remove_tree(path)
        r = tool.prune_spool(str(spool), {'ok': True, 'names': set()}, {'classBudgetBytes': 1000, 'minKeepPerClass': 1, 'maxDeletesPerPass': 16}, remove=remove)
        self.assertEqual([d['name'] for d in r['deleted']], ['failed-a-1'])
        self.assertEqual(r['stopped'], {'name': 'failed-a-2', 'code': 'RETENTION_CHANGED_SINCE_PLAN', 'partial': False})
        self.assertTrue((spool / 'failed-a-2').is_dir())

    def _batch_scene(self, with_git=True):
        r = self.root
        for sub in ('incoming', 'outgoing'):
            (r / 'formal-spool' / sub).mkdir(parents=True, exist_ok=True)
        for job in (JOB, 'd' * 64):
            cand = r / 'workspaces' / job / 'candidate'
            (cand / 'src').mkdir(parents=True)
            (cand / 'src' / 'big.txt').write_bytes(b'z' * 4096)
            if with_git:
                (cand / '.git').mkdir()
                (cand / '.git' / 'HEAD').write_text('a' * 40 + '\n')
        run = r / 'runs' / f'placement-{JOB}'
        (run / 'candidate').mkdir(parents=True)
        (run / 'candidate' / 'f.txt').write_text('c')
        (run / 'job.json').write_text('{}')
        return r

    def test_success_close_keeps_commit_and_manifest_instead_of_candidate_trees(self):
        r = self._batch_scene()
        manifest_before = tool.candidate_manifest(str(r / 'workspaces' / JOB / 'candidate'))
        plan = tool.plan_archive(str(r), BATCH, 'success-close', [JOB, 'd' * 64], 'a' * 12)
        self.assertTrue(plan['slimCandidates'])
        result = tool.apply_archive(str(r), plan)
        target = r / plan['target']
        self.assertEqual(result['verified'], True)
        self.assertEqual(result['slimKept'], [])
        self.assertEqual(sorted(s['path'] for s in result['slimmed']), sorted([f'workspace-{JOB}/candidate', f'workspace-{"d" * 64}/candidate', f'run-placement-{JOB}/candidate']))
        self.assertEqual(result['deleted'], 3)
        self.assertFalse((target / f'workspace-{JOB}' / 'candidate').exists())
        slim = json.loads((target / f'workspace-{JOB}' / 'candidate.slim.json').read_text())
        self.assertEqual((slim['commitSha'], slim['manifestSha256'], slim['restoreFrom']), ('a' * 40, manifest_before['manifestSha256'], 'git'))
        # the placement run takes its job's workspace commit; the rest of the run stays
        run_slim = json.loads((target / f'run-placement-{JOB}' / 'candidate.slim.json').read_text())
        self.assertEqual(run_slim['commitSha'], 'a' * 40)
        self.assertTrue((target / f'run-placement-{JOB}' / 'job.json').exists())

    def test_failure_archives_stay_complete_and_an_unknown_commit_keeps_the_tree(self):
        r = self._batch_scene()
        plan = tool.plan_archive(str(r), BATCH, 'formal-bridge-stage-deadline', [JOB, 'd' * 64], 'b' * 12)
        self.assertFalse(plan['slimCandidates'] or plan['deletesAnything'])
        result = tool.apply_archive(str(r), plan)
        self.assertEqual((result['deleted'], result['slimmed']), (0, []))
        self.assertTrue((r / plan['target'] / f'workspace-{JOB}' / 'candidate' / 'src' / 'big.txt').exists())
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        self.root = pathlib.Path(other.name)
        r2 = self._batch_scene(with_git=False)
        plan2 = tool.plan_archive(str(r2), BATCH, 'success-close', [JOB, 'd' * 64], 'c' * 12)
        result2 = tool.apply_archive(str(r2), plan2)
        self.assertEqual(result2['slimmed'], [])
        self.assertEqual(sorted(k['code'] for k in result2['slimKept']), ['SLIM_COMMIT_UNKNOWN'] * 3)
        self.assertTrue((r2 / plan2['target'] / f'workspace-{JOB}' / 'candidate' / 'src' / 'big.txt').exists())


if __name__ == '__main__':
    unittest.main()
