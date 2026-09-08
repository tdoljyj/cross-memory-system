"""Synthetic logic checks only; no service, root registration or signed proof."""
import copy
import datetime as dt
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import verify as v


class RegistrationVerifierTests(unittest.TestCase):
    def setUp(self):
        self.candidate = v.strict_json((Path(__file__).resolve().parents[3] / v.CANDIDATE).read_bytes())
        self.subject = self.candidate['subject']
        self.digest = self.candidate['subject_sha256']

    def test_exact_new_candidate_identity_and_missing_actual_bindings(self):
        v.validate_candidate(self.candidate, self.digest)
        class NoCalls:
            def __getattr__(self, _):
                raise AssertionError('Missing bindings must reject before network reads')
        with self.assertRaises(v.Blocked):
            v.verify_remote(self.candidate, self.digest, NoCalls(), dt.datetime.now(dt.timezone.utc), self.subject['generation_id'])

    def test_scope_expansion_rejects_even_with_recomputed_candidate_digest(self):
        for field, value in [('environment', 'PRODUCTION'), ('purpose', 'MODEL_ACTION'), ('old_pins_modified', True)]:
            x = copy.deepcopy(self.candidate)
            x['subject'][field] = value
            x['subject_sha256'] = v.sha(v.canonical(x['subject']))
            with self.assertRaises(v.Blocked):
                v.validate_candidate(x, x['subject_sha256'])

    def test_signature_identity_tree_and_owner_are_all_required(self):
        commit_id, tree, parent1, parent2 = 'a' * 40, 'b' * 40, 'c' * 40, 'd' * 40
        commit = {'sha': commit_id, 'committer': {'login': 'web-flow'},
            'parents': [{'sha': parent1}, {'sha': parent2}], 'commit': {'tree': {'sha': tree},
            'verification': {'verified': True, 'reason': 'valid',
            'signature': '-----BEGIN PGP SIGNATURE-----\nSYNTHETIC_LOGIC_ONLY\n-----END PGP SIGNATURE-----',
            'payload': f'tree {tree}\nparent {parent1}\nparent {parent2}\n\nsynthetic'}}}
        pr = {'merged': True, 'merged_by': {'login': 'tdoljyj'}, 'merge_commit_sha': commit_id,
              'base': {'ref': 'main', 'repo': {'full_name': v.REPOSITORY}},
              'head': {'repo': {'full_name': v.REPOSITORY}}}
        v.verify_merge(commit, pr, commit_id)  # Parser logic, NOT actual cryptographic evidence.
        for change in ['bad_signature', 'missing_signature', 'wrong_signer', 'wrong_tree', 'wrong_owner']:
            c, p = copy.deepcopy(commit), copy.deepcopy(pr)
            if change == 'bad_signature': c['commit']['verification']['verified'] = False
            if change == 'missing_signature': c['commit']['verification']['signature'] = ''
            if change == 'wrong_signer': c['committer']['login'] = 'unknown'
            if change == 'wrong_tree': c['commit']['tree']['sha'] = 'e' * 40
            if change == 'wrong_owner': p['merged_by']['login'] = 'unknown'
            with self.assertRaises(v.Blocked): v.verify_merge(c, p, commit_id)

    def test_expiry_and_expanded_deadline_reject(self):
        now = dt.datetime(2026, 9, 8, 12, tzinfo=dt.timezone.utc)
        v.within_window('2026-09-08T11:00:00Z', v.OWNER_EXPIRES, now)
        for start, end in [('2026-09-08T10:00:00Z', '2026-09-08T11:00:00Z'),
                           ('2026-09-08T13:00:00Z', v.OWNER_EXPIRES),
                           ('2026-09-08T11:00:00Z', '2026-09-10T00:00:00Z')]:
            with self.assertRaises(v.Blocked): v.within_window(start, end, now)

    def test_predecessor_chain_and_trusted_minimum_reject_rollback(self):
        first = {'root_set_id': self.subject['root_set_id'], 'generation_id': self.subject['generation_id'],
            'generation_ordinal': 1, 'predecessor': None, 'status': 'REGISTERED', 'subject_sha256': self.digest}
        ref1 = {'sha256': 'a' * 64}
        second = {**first, 'generation_id': 'ctrgen_' + 'b' * 32, 'generation_ordinal': 2,
                  'predecessor': {'generation_id': first['generation_id'], 'sha256': ref1['sha256']}}
        records = [(ref1, first), ({'sha256': 'c' * 64}, second)]
        v.verify_chain(records, second['generation_id'], self.subject, first['generation_id'])
        with self.assertRaises(v.Blocked): v.verify_chain(records, first['generation_id'], self.subject)
        with self.assertRaises(v.Blocked): v.verify_chain(records[:1], first['generation_id'], self.subject, second['generation_id'])
        broken = copy.deepcopy(records); broken[1][1]['predecessor']['sha256'] = 'd' * 64
        with self.assertRaises(v.Blocked): v.verify_chain(broken, second['generation_id'], self.subject)

    def test_unknown_revocation_source_and_actual_revocation_reject(self):
        root, generation = self.subject['root_set_id'], self.subject['generation_id']
        v.verify_revocations({'owner_delegation_status': 'CURRENT_UNREVOKED'}, [], root, generation)
        with self.assertRaises(v.Blocked): v.verify_revocations({}, [], root, generation)
        for kind, target in [('root_set', root), ('generation', generation), ('owner_delegation', 'original-owner')]:
            with self.assertRaises(v.Blocked):
                v.verify_revocations({'owner_delegation_status': 'CURRENT_UNREVOKED'},
                    [{'status': 'REVOKED', 'authority': 'tdoljyj', 'target_kind': kind, 'target_id': target}], root, generation)

    def test_strict_encoding_and_path_boundaries(self):
        for raw in [b'{"a":1,"a":2}', b'{"a":1.2}', b'{"a":NaN}']:
            with self.assertRaises(v.Blocked): v.strict_json(raw)
        for path in ['../secret', '/absolute', 'safe/../escape', 'C:/secret']:
            with self.assertRaises(v.Blocked): v.safe_path(path)

    def test_ancestor_and_complete_tree_require_actual_consistent_api_results(self):
        class SyntheticAPI(v.GitHub):
            def __init__(self, value): self.value = value
            def get(self, _): return self.value
        ancestor, head = 'a' * 40, 'b' * 40
        SyntheticAPI({'status': 'ahead', 'merge_base_commit': {'sha': ancestor}}).require_ancestor(ancestor, head)
        for value in [{'status': 'behind', 'merge_base_commit': {'sha': head}},
                      {'status': 'ahead', 'merge_base_commit': {'sha': head}}]:
            with self.assertRaises(v.Blocked): SyntheticAPI(value).require_ancestor(ancestor, head)
        with self.assertRaises(v.Blocked): SyntheticAPI({'truncated': True, 'tree': []}).tree_paths(head)
        self.assertEqual(SyntheticAPI({'truncated': False, 'tree': []}).tree_paths(head), set())

    def test_review_fix_each_publication_requires_current_head_ancestry(self):
        class API:
            def __init__(self, allowed): self.allowed, self.reads = allowed, []
            def merge(self, commit, pr): self.reads.append(('merge', commit, pr))
            def require_ancestor(self, commit, head):
                self.reads.append(('ancestor', commit, head))
                v.need(self.allowed, 'Publication is outside current accepted history')
            def bound_json(self, ref, commit): self.reads.append(('blob', commit))
        reference = {'publication_commit': 'a' * 40, 'publication_pr': 26}
        allowed = API(True)
        v.verify_publication_source(allowed, reference, 'b' * 40)
        self.assertEqual([r[0] for r in allowed.reads], ['merge', 'ancestor', 'blob'])
        rejected = API(False)
        with self.assertRaises(v.Blocked): v.verify_publication_source(rejected, reference, 'b' * 40)
        self.assertEqual([r[0] for r in rejected.reads], ['merge', 'ancestor'])

    def test_review_fix_first_registration_requires_all_parent_history_empty(self):
        class API(v.GitHub):
            def __init__(self, populated=False, truncated=False):
                super().__init__(); self.populated, self.truncated = populated, truncated
            def get(self, suffix):
                if suffix.startswith('/git/commits/'):
                    ident = suffix.rsplit('/', 1)[1]
                    parents = [{'sha': 'a' * 40}, {'sha': 'c' * 40}] if ident == 'b' * 40 else []
                    return {'sha': ident, 'tree': {'sha': ident}, 'parents': parents}
                ident = suffix.split('/git/trees/')[1].split('?')[0]
                rows = [{'path': v.DOMAIN + 'old/event.json', 'sha': 'd' * 40,
                         'mode': '100644', 'type': 'blob'}] if self.populated and ident == 'c' * 40 else []
                return {'sha': ident, 'truncated': self.truncated, 'tree': rows}
        self.assertEqual(v.verify_empty_domain_history(API(), 'b' * 40), {'a' * 40, 'b' * 40, 'c' * 40})
        # Tip and first parent are empty; the other reachable parent proves prior registration.
        with self.assertRaises(v.Blocked): v.verify_empty_domain_history(API(populated=True), 'b' * 40)
        with self.assertRaises(v.Blocked): v.verify_empty_domain_history(API(truncated=True), 'b' * 40)
        with patch.object(v, 'MAX_HISTORY_COMMITS', 1):
            with self.assertRaises(v.Blocked): v.verify_empty_domain_history(API(), 'b' * 40)

    def test_review_fix_deleted_or_modified_revocations_cannot_be_hidden_by_tip(self):
        namespace = self.subject['storage_candidate']['evidence_namespace']
        event, index = namespace + 'revocation.json', namespace + 'index.json'
        original = ('a' * 40, '100644')
        class API:
            def __init__(self, graph): self.graph = graph
            def history_snapshot(self, commit): return self.graph[commit]
        graph = {'empty': ([], {}), 'registered': (['empty'], {event: original, index: ('b' * 40, '100644')}),
                 'tip': (['registered'], {event: original, index: ('c' * 40, '100644')})}
        v.verify_immutable_history(API(graph), 'tip', {'empty'}, namespace)
        # Endpoints agree, but an intermediate delete (or rewrite) still fails.
        for changed in [{}, {event: ('d' * 40, '100644')}]:
            corrupt = copy.deepcopy(graph)
            corrupt['intermediate'] = (['registered'], changed)
            corrupt['tip'] = (['intermediate'], graph['tip'][1])
            with self.assertRaises(v.Blocked): v.verify_immutable_history(API(corrupt), 'tip', {'empty'}, namespace)
        # A merge must inspect both parents, not just the direct first-parent chain.
        corrupt = copy.deepcopy(graph)
        corrupt['deleted_branch'] = (['registered'], {})
        corrupt['tip'] = (['registered', 'deleted_branch'], graph['tip'][1])
        with self.assertRaises(v.Blocked): v.verify_immutable_history(API(corrupt), 'tip', {'empty'}, namespace)


if __name__ == '__main__':
    unittest.main()
