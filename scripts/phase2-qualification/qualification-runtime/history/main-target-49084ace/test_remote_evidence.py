"""Synthetic transport responses only; no Git writes/network/processes."""
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_candidate', Path(__file__).with_name('remote_evidence.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PARENT, COMMIT = 'a' * 40, 'b' * 40
RAW = b'{"synthetic":true,"operation":"fixed-probe-not-executed"}\n'


class FakeAPI(m.existing.GitHub):
    def __init__(self):
        self.created = 0
        self.requests = []
        self.records = {}
        self.parent = PARENT
        self.fail_create = False
        self.fail_read = False
        self.bad_parent = False
        self.bad_tree = None
        self.read_commit = None

    def get(self, suffix):
        self.requests.append(suffix)
        if suffix == '/git/ref/heads/main': return {'object': {'sha': self.parent}}
        if suffix.startswith('/git/commits/'):
            self.read_commit = suffix.rsplit('/', 1)[1]
            return {'sha': self.read_commit, 'tree': {'sha': 'e' * 40}}
        if suffix.startswith('/git/trees/'):
            return {'sha': 'e' * 40, 'truncated': self.bad_tree == 'truncated', 'tree': [
                {'path': path, 'type': 'blob', 'mode': '120000' if self.bad_tree == 'symlink' else '100644',
                 'sha': m.git_blob(raw)} for (path, commit), raw in self.records.items() if commit == self.read_commit]}
        if suffix.startswith('/contents/'):
            if self.fail_read: raise OSError('synthetic unavailable')
            path, commit = suffix[len('/contents/'):].split('?ref=')
            raw = self.records[(path, commit)]
            return {'path': path, 'type': 'file', 'encoding': 'base64', 'size': len(raw),
                    'sha': m.git_blob(raw), 'content': base64.b64encode(raw).decode()}
        raise AssertionError(suffix)

    def create_file(self, path, raw, parent):
        self.created += 1
        self.records[(path, COMMIT)] = raw
        if self.fail_create: raise TimeoutError('synthetic reply lost after write')
        return {'content': {'path': path, 'sha': m.git_blob(raw), 'size': len(raw)},
                'commit': {'sha': COMMIT, 'parents': [{'sha': 'c' * 40 if self.bad_parent else parent}]}}


class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(m, 'BASE', Path(self.tmp.name)); p.start(); self.addCleanup(p.stop)
        p = patch.object(m.subprocess, 'run', side_effect=AssertionError('No real processes')); p.start(); self.addCleanup(p.stop)

    def test_exact_commit_blob_read_back_after_create(self):
        api = FakeAPI()
        value = m.publish_once(api, 'attempt-one', 'intent', RAW, PARENT)
        self.assertEqual(value['status'], 'IMMUTABLE_REMOTE_BYTES_READ_BACK')
        self.assertEqual(api.created, 1)
        self.assertEqual(value['reference']['sha256'], m.sha(RAW))
        self.assertFalse(value['execution_enabled'])
        self.assertTrue(any('?ref=' + COMMIT in call for call in api.requests))

    def test_replay_or_changed_parameters_never_republishes(self):
        api = FakeAPI()
        m.publish_once(api, 'same', 'intent', RAW, PARENT)
        for raw in (RAW, b'{"synthetic":"changed"}'):
            self.assertEqual(m.publish_once(api, 'same', 'intent', raw, PARENT)['status'], 'UNKNOWN')
        self.assertEqual(api.created, 1)

    def test_lost_reply_and_readback_failure_keep_unknown(self):
        for mode in ('fail_create', 'fail_read', 'bad_parent'):
            api = FakeAPI(); setattr(api, mode, True)
            result = m.publish_once(api, mode, 'intent', RAW, PARENT)
            self.assertEqual(result['status'], 'UNKNOWN')
            self.assertFalse(result['automatic_retry_allowed'])
            self.assertEqual(m.publish_once(api, mode, 'intent', RAW, PARENT)['status'], 'UNKNOWN')
            self.assertEqual(api.created, 1)

    def test_changed_current_head_prevents_write(self):
        api = FakeAPI(); api.parent = 'f' * 40
        self.assertEqual(m.publish_once(api, 'different-head', 'intent', RAW, PARENT)['status'], 'UNKNOWN')
        self.assertEqual(api.created, 0)

    def test_remote_byte_change_and_reference_tamper_rejected(self):
        api = FakeAPI()
        ref = m.reference('tamper', 'intent', COMMIT, RAW)
        api.records[(ref['path'], COMMIT)] = b'{"synthetic":false}'
        with self.assertRaises((m.Unknown, m.existing.Blocked)): m.read_back(api, ref, RAW)
        for field, value in [('repository', 'other/repo'), ('sha256', '0' * 64),
                             ('git_blob_sha', '0' * 40), ('size', True), ('commit', 'main')]:
            with self.subTest(field=field), self.assertRaises((m.Unknown, m.existing.Blocked)):
                m.validate_reference({**ref, field: value}, RAW)

    def test_no_unsafe_path_or_duplicate_json(self):
        for attempt, kind in [('../escape', 'intent'), ('valid', 'ga'), ('a/b', 'result')]:
            with self.assertRaises(m.Unknown): m.path_for(attempt, kind)
        with self.assertRaises(m.existing.Blocked): m.raw_record(b'{"x":1,"x":2}')
        with self.assertRaises(m.Unknown): m.raw_record(b'[]')
        with self.assertRaises(m.Unknown): m.GitHubEvidence().create_file('outside.json', RAW, PARENT)

    def test_original_intent_result_chain_exact_and_cross_attempt_denial(self):
        api = FakeAPI()
        intent = m.reference('chain', 'intent', COMMIT, RAW)
        result_raw = m.encode_result(intent, RAW, {'synthetic_observation_only': True})
        result = m.reference('chain', 'result', 'd' * 40, result_raw)
        api.records[(intent['path'], COMMIT)] = RAW
        api.records[(result['path'], 'd' * 40)] = result_raw
        self.assertEqual(m.read_result_chain(api, result, result_raw, intent, RAW)['status'],
                         'IMMUTABLE_INTENT_RESULT_CHAIN_READ_BACK')
        wrong = m.reference('other', 'result', 'd' * 40, result_raw)
        with self.assertRaises(m.Unknown): m.read_result_chain(api, wrong, result_raw, intent, RAW)
        changed = json.loads(result_raw); changed['intent_evidence_ref']['sha256'] = 'e' * 64
        changed_raw = json.dumps(changed).encode()
        changed_ref = m.reference('chain', 'result', 'd' * 40, changed_raw)
        with self.assertRaises(m.Unknown): m.read_result_chain(api, changed_ref, changed_raw, intent, RAW)

    def test_formal_stays_blocked_even_with_fake_acceptance(self):
        result = m.formal_run(accepted=True, current_root=True, remote_sink=True, qualified=True)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['side_effects_dispatched'], 0)
        self.assertFalse(result['current_authority_verified'])

    def test_symlink_or_incomplete_tree_does_not_verify_remote_evidence(self):
        for bad_tree in ('symlink', 'truncated'):
            api = FakeAPI(); api.bad_tree = bad_tree
            ref = m.reference('tree', 'intent', COMMIT, RAW)
            api.records[(ref['path'], COMMIT)] = RAW
            with self.subTest(bad_tree=bad_tree), self.assertRaises(m.Unknown):
                m.read_back(api, ref, RAW)

    def test_contents_transport_is_create_only_exact_path_and_requires_201(self):
        api = m.GitHubEvidence()
        path = m.path_for('transport', 'intent')
        for status in (201, 200):
            response = SimpleNamespace(returncode=0, stdout=(f'HTTP/2.0 {status} Response\r\nX-Test: synthetic\r\n\r\n{{}}').encode())
            with patch.object(m.subprocess, 'run', return_value=response) as call:
                if status == 201: self.assertEqual(api.create_file(path, RAW, PARENT), {})
                else:
                    with self.assertRaises(m.Unknown): api.create_file(path, RAW, PARENT)
                args, kwargs = call.call_args
                body = json.loads(kwargs['input'])
                self.assertNotIn('sha', body)
                self.assertEqual(body['branch'], 'main')
                self.assertEqual(base64.b64decode(body['content']), RAW)
                self.assertEqual(args[0][0], 'C:/Program Files/GitHub CLI/gh.exe')
                self.assertIn('repos/' + m.REPOSITORY + '/contents/' + path, args[0])

    def test_auxiliary_result_authority_forgery_rejected(self):
        api = FakeAPI()
        intent = m.reference('authority', 'intent', COMMIT, RAW)
        value = json.loads(m.encode_result(intent, RAW, {}))
        value['execution_enabled'] = True
        forged = json.dumps(value).encode()
        result = m.reference('authority', 'result', 'd' * 40, forged)
        with self.assertRaises(m.Unknown): m.read_result_chain(api, result, forged, intent, RAW)


if __name__ == '__main__':
    unittest.main(verbosity=2)
