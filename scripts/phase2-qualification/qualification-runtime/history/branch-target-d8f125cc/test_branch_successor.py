"""New branch transport checks only; no GitHub, Docker or qualification run."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('remote_evidence.py')
spec = importlib.util.spec_from_file_location('branch_evidence_candidate', SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PARENT, OLD_TREE, NEW_TREE, COMMIT, OTHER = (c * 40 for c in '12345')
RAW = b'{"synthetic":true}\n'


class FakeGitData(m.GitHubEvidence):
    def __init__(self):
        self.publication_objects = {}
        self.repository = {'full_name': m.REPOSITORY, 'private': True}
        self.head = PARENT
        self.leaves = {'existing.txt': ('100644', 'blob', 'a' * 40)}
        self.new_leaves = None
        self.writes = []
        self.corrupt_tree = False
        self.race = False
        self.lose_ref_reply = False
        self.readbacks = 0

    def get(self, suffix):
        if suffix == '':
            return self.repository
        if suffix == '/git/ref/heads/' + m.BRANCH:
            return {'ref': m.REF, 'object': {'type': 'commit', 'sha': self.head}}
        if suffix == '/git/commits/' + PARENT:
            return {'sha': PARENT, 'tree': {'sha': OLD_TREE}}
        if suffix == '/git/commits/' + COMMIT:
            return self.commit
        for identity, leaves in ((OLD_TREE, self.leaves), (NEW_TREE, self.new_leaves)):
            if suffix == '/git/trees/' + identity + '?recursive=1':
                return {'sha': identity, 'truncated': False, 'tree': [
                    {'path': path, 'mode': row[0], 'type': row[1], 'sha': row[2]}
                    for path, row in leaves.items()]}
        raise AssertionError('Unapproved GET: ' + suffix)

    def _write(self, stage, body):
        self.writes.append((stage, body))
        if stage == 'blob':
            assert body == {'encoding': 'base64', 'content': base64.b64encode(RAW).decode()}
            return {'sha': m.git_blob(RAW)}
        if stage == 'tree':
            assert body['base_tree'] == OLD_TREE and len(body['tree']) == 1
            row = body['tree'][0]
            self.new_leaves = {**self.leaves, row['path']: (row['mode'], row['type'], row['sha'])}
            if self.corrupt_tree:
                self.new_leaves['unrelated.txt'] = ('100644', 'blob', OTHER)
            return {'sha': NEW_TREE}
        if stage == 'commit':
            assert body['tree'] == NEW_TREE and body['parents'] == [PARENT]
            self.commit = {'sha': COMMIT, 'tree': {'sha': NEW_TREE}, 'parents': [{'sha': PARENT}]}
            if self.race:
                self.head = OTHER
            return self.commit
        if stage == 'ref':
            assert body == {'sha': COMMIT, 'force': False}
            self.head = COMMIT
            if self.lose_ref_reply:
                raise TimeoutError('Synthetic lost response')
            return {'ref': m.REF, 'object': {'sha': COMMIT}}
        raise AssertionError('Unapproved mutation')

    def bound_json(self, item, commit):
        assert commit == COMMIT and item['sha256'] == m.sha(RAW)
        self.readbacks += 1
        return json.loads(RAW)


class BranchSuccessorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = patch.object(m, 'BASE', Path(self.temp.name))
        self.base.start()
        self.addCleanup(self.base.stop)
        self.api = FakeGitData()

    def publish(self, attempt='case'):
        return m.publish_once(self.api, attempt, 'intent', RAW, PARENT)

    def test_private_repository_strictly_required_before_any_mutation(self):
        variants = [None, {}, *[
                        {'full_name': m.REPOSITORY, 'private': value}
                        for value in (False, 'true', 1, None)],
                        {'full_name': 'other/repo', 'private': True}]
        for index, value in enumerate(variants):
            with self.subTest(value=value):
                self.api.repository = value
                self.assertEqual(self.publish('private-' + str(index))['status'], 'UNKNOWN')
                self.assertEqual(self.api.writes, [])

    def test_missing_or_moved_branch_never_created(self):
        for index, head in enumerate((None, OTHER)):
            self.api.head = head
            self.assertEqual(self.publish('head-' + str(index))['status'], 'UNKNOWN')
            self.assertEqual(self.api.writes, [])

    def test_existing_target_is_never_overwritten(self):
        self.api.leaves[m.path_for('case', 'intent')] = ('100644', 'blob', m.git_blob(RAW))
        self.assertEqual(self.publish()['status'], 'UNKNOWN')
        self.assertEqual(self.api.writes, [])

    def test_exact_single_blob_successor_reads_back_without_authority(self):
        result = self.publish()
        self.assertEqual(result['status'], 'IMMUTABLE_REMOTE_BYTES_READ_BACK')
        self.assertEqual([stage for stage, _ in self.api.writes], ['blob', 'tree', 'commit', 'ref'])
        self.assertEqual(self.api.readbacks, 1)
        self.assertEqual(result['reference'], m.reference('case', 'intent', COMMIT, RAW))
        self.assertTrue(all(result[key] == value for key, value in m.BOUNDARY.items()))
        self.assertEqual(len(list((m.BASE / 'work' / 'case').glob('*.json'))), 4)

    def test_unrelated_tree_change_blocks_commit_and_ref(self):
        self.api.corrupt_tree = True
        result = self.publish()
        self.assertEqual(result['status'], 'UNKNOWN')
        self.assertEqual([stage for stage, _ in self.api.writes], ['blob', 'tree'])
        self.assertEqual(result['known_immutable_objects'], {'blob': m.git_blob(RAW), 'tree': NEW_TREE})

    def test_concurrent_branch_advance_retains_objects_without_ref_write(self):
        self.api.race = True
        result = self.publish()
        self.assertEqual(result['status'], 'UNKNOWN')
        self.assertEqual([stage for stage, _ in self.api.writes], ['blob', 'tree', 'commit'])
        self.assertEqual(result['known_immutable_objects']['commit'], COMMIT)
        self.assertEqual(self.api.head, OTHER)

    def test_lost_ref_response_is_unknown_and_never_blindly_republished(self):
        self.api.lose_ref_reply = True
        result = self.publish()
        self.assertEqual(result['status'], 'UNKNOWN')
        self.assertEqual(result['known_immutable_objects']['commit'], COMMIT)
        writes = list(self.api.writes)
        self.assertEqual(self.publish()['status'], 'UNKNOWN')
        self.assertEqual(self.api.writes, writes)
        self.assertFalse(result['automatic_retry_allowed'])

    def test_real_transport_only_uses_fixed_ref_nonforce_body(self):
        api = m.GitHubEvidence()
        body = {'sha': COMMIT, 'force': False}
        response = type('Response', (), {'returncode': 0, 'stdout': b'HTTP/2.0 200 OK\r\n\r\n{}'})()
        with patch.object(api, 'get', return_value=self.api.repository), patch.object(m.subprocess, 'run', return_value=response) as run:
            api._write('ref', body)
        argv = run.call_args.args[0]
        self.assertEqual(argv[1:], ['api', '--method', 'PATCH', '--include',
            'repos/' + m.REPOSITORY + '/git/refs/heads/' + m.BRANCH, '--input', '-'])
        self.assertEqual(json.loads(run.call_args.kwargs['input']), body)
        with patch.object(api, 'get', return_value={'full_name': m.REPOSITORY, 'private': 1}), patch.object(m.subprocess, 'run') as run:
            with self.assertRaises(m.Unknown):
                api._write('ref', body)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
