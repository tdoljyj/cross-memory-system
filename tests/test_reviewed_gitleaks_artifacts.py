import base64
import ast
import collections
import copy
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reviewed_gitleaks', ROOT / 'scripts/ci/reviewed_gitleaks.py')
reviewed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reviewed)


class ReviewedArtifactDigestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.text = reviewed.run([
            'git', 'cat-file', 'blob',
            f'{reviewed.REVIEW_DOCUMENT_COMMIT}:{reviewed.REVIEW_DOCUMENT_PATH}',
        ], cwd=ROOT).decode('utf-8')

    def test_both_actual_immutable_artifacts_match_review_digests(self):
        for line in reviewed.REVIEW_DOCUMENT_DIGEST_LINES:
            reviewed.verify_auth_review_digest(ROOT, self.text, line)

    def test_new_commit_is_not_the_reviewed_exception(self):
        text = self.config.replace(
            reviewed.REVIEW_DOCUMENT_COMMIT + ':' + reviewed.REVIEW_DOCUMENT_PATH,
            '0' * 40 + ':' + reviewed.REVIEW_DOCUMENT_PATH,
        )
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            reviewed.parse_records(text)

    def test_different_report_path_is_not_admitted(self):
        text = self.config.replace(reviewed.REVIEW_DOCUMENT_PATH, 'development/contracts/context-authorization/evidence/other.json')
        with self.assertRaisesRegex(ValueError, 'Non-exact finding location'):
            reviewed.parse_records(text)

    def test_unreviewed_line_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unreviewed authorization digest line'):
            reviewed.verify_auth_review_digest(ROOT, self.text, 151)

    def test_changed_report_bytes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'review bytes changed'):
            reviewed.verify_auth_review_digest(ROOT, self.text + '\n', 150)

    def test_changed_source_bytes_are_rejected(self):
        with patch.object(reviewed, 'run', return_value=b'changed artifact'):
            with self.assertRaisesRegex(ValueError, 'differs from immutable artifact'):
                reviewed.verify_auth_review_digest(ROOT, self.text, 150)

    def test_default_detection_cannot_be_disabled(self):
        with self.assertRaisesRegex(ValueError, 'Default detection rules'):
            reviewed.parse_records(self.config.replace('useDefault = true', 'useDefault = false'))

    def test_exact_record_count_and_artifact_reason(self):
        records = reviewed.parse_records(self.config)
        exact = [r for r in records if ':' + reviewed.REVIEW_DOCUMENT_PATH + ':' in r['fingerprint']]
        self.assertEqual(len(records), reviewed.EXPECTED_COUNT)
        legacy_digest = hashlib.sha256(json.dumps(records[:484], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(legacy_digest, 'b10a7c8542f886ccce1daec04057ad5a5873ef9d75eae1643ccc879289b39172')
        prior_digest = hashlib.sha256(json.dumps(records[:491], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(prior_digest, 'cbc68f48aab025a9f14f47e74b97dce48e7e6d23a9adf03ff67ecc13f6f3ab9e')
        self.assertEqual(len(exact), 2)
        self.assertTrue(all(r['kinds'] == ['ARTIFACT_DIGEST'] for r in exact))


class FinalEvidenceArtifactDigestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.blobs = {
            path: reviewed.run(['git', 'cat-file', 'blob', f'{reviewed.FINAL_EVIDENCE_COMMIT}:{path}'], cwd=ROOT)
            for path in [*reviewed.FINAL_EVIDENCE_DOCUMENTS, reviewed.FINAL_SOURCE_PATH]
        }
        cls.envelope = json.loads(cls.blobs[reviewed.FINAL_ENVELOPE_PATH])

    def verify(self, path, line, text=None):
        reviewed.verify_final_evidence_digest(ROOT, path, self.blobs[path].decode('utf-8') if text is None else text, line)

    def controlled_document(self, path, document):
        text = json.dumps(document, ensure_ascii=False, indent=2) + '\n'
        pin = copy.deepcopy(reviewed.FINAL_EVIDENCE_DOCUMENTS[path])
        pin['sha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()
        # Fault injection admits only the controlled document bytes. All other
        # immutable original/Source/sidecar pins stay live, so each branch runs.
        return text, patch.dict(reviewed.FINAL_EVIDENCE_DOCUMENTS, {path: pin})

    def reject_encoded_mutation(self, mutate, error):
        for line in [184, 192]:
            with self.subTest(line=line):
                document = copy.deepcopy(self.envelope)
                entry_index = reviewed.FINAL_EVIDENCE_DOCUMENTS[reviewed.FINAL_ENVELOPE_PATH]['lines'][line]['entry_index']
                mutate(document['entries'][entry_index])
                text, permit_controlled_document = self.controlled_document(reviewed.FINAL_ENVELOPE_PATH, document)
                with permit_controlled_document:
                    with self.assertRaisesRegex(ValueError, error):
                        self.verify(reviewed.FINAL_ENVELOPE_PATH, line, text)

    def targeted_bad_blob(self, path):
        real_run = reviewed.run
        def changed(args, *, cwd=None):
            if args == ['git', 'cat-file', 'blob', f'{reviewed.FINAL_EVIDENCE_COMMIT}:{path}']:
                return b'controlled different immutable blob'
            return real_run(args, cwd=cwd)
        return patch.object(reviewed, 'run', side_effect=changed)

    def test_all_seven_immutable_locations_have_actual_artifact_proof(self):
        locations = 0
        for path, document in reviewed.FINAL_EVIDENCE_DOCUMENTS.items():
            for line in document['lines']:
                with self.subTest(path=path, line=line):
                    self.verify(path, line)
                locations += 1
        self.assertEqual(locations, 7)

    def test_different_final_commit_is_rejected(self):
        changed = self.config.replace(reviewed.FINAL_EVIDENCE_COMMIT + ':', '0' * 40 + ':', 1)
        with self.assertRaisesRegex(ValueError, 'Final evidence exception identity changed'):
            reviewed.parse_records(changed)

    def test_different_final_path_is_rejected(self):
        changed = self.config.replace(reviewed.FINAL_DB_REPORT_PATH, reviewed.FINAL_EVIDENCE_ROOT + '/other.json', 1)
        with self.assertRaisesRegex(ValueError, 'Non-exact finding location'):
            reviewed.parse_records(changed)

    def test_different_final_line_is_rejected(self):
        original = f'{reviewed.FINAL_EVIDENCE_COMMIT}:{reviewed.FINAL_DB_REPORT_PATH}:generic-api-key:30'
        changed = self.config.replace(original, original[:-2] + '31', 1)
        with self.assertRaisesRegex(ValueError, 'Final evidence exception identity changed'):
            reviewed.parse_records(changed)

    def test_different_final_reason_is_rejected(self):
        row = next(line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)
                   and reviewed.FINAL_EVIDENCE_COMMIT in line)
        for substitute in [row.replace('ARTIFACT_DIGEST', 'API_BUNDLE_DIGEST'),
                           row.replace('generic-api-key', 'sourcegraph-access-token').replace('ARTIFACT_DIGEST', 'GIT_OBJECT_METADATA')]:
            with self.subTest(substitute=substitute):
                with self.assertRaisesRegex(ValueError, 'Final evidence exception identity changed'):
                    reviewed.parse_records(self.config.replace(row, substitute, 1))

    def test_changed_registry_count_is_rejected(self):
        row = next(line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)
                   and reviewed.FINAL_EVIDENCE_COMMIT in line)
        for changed in [self.config.replace('# clued-reviewed-count: 737', '# clued-reviewed-count: 736'),
                        self.config.replace(row + '\n', '', 1), self.config + row + '\n']:
            with self.subTest():
                with self.assertRaisesRegex(ValueError, 'Reviewed finding count changed'):
                    reviewed.parse_records(changed)

    def test_missing_final_identity_cannot_borrow_another_allowed_location(self):
        original = f'{reviewed.FINAL_EVIDENCE_COMMIT}:{reviewed.FINAL_DB_REPORT_PATH}:generic-api-key:30'
        substitute = f'{reviewed.FINAL_EVIDENCE_COMMIT}:apps/clued-cloud/tests/other.txt:generic-api-key:30'
        with self.assertRaisesRegex(ValueError, 'Final evidence exception set changed'):
            reviewed.parse_records(self.config.replace(original, substitute, 1))

    def test_changed_document_bytes_are_rejected(self):
        path = reviewed.FINAL_DB_REPORT_PATH
        with self.assertRaisesRegex(ValueError, 'Final evidence document bytes changed'):
            self.verify(path, 30, self.blobs[path].decode('utf-8') + '\n')

    def test_hex_shape_does_not_admit_a_false_direct_digest(self):
        for path, pin in reviewed.FINAL_EVIDENCE_DOCUMENTS.items():
            for line, spec in pin['lines'].items():
                if 'parent' not in spec:
                    continue
                with self.subTest(path=path, line=line):
                    document = json.loads(self.blobs[path])
                    document[spec['parent'].strip('/')][reviewed.FINAL_SOURCE_PATH] = '0' * 64
                    text, permit_controlled_document = self.controlled_document(path, document)
                    with permit_controlled_document:
                        with self.assertRaisesRegex(ValueError, 'differs from immutable artifact'):
                            self.verify(path, line, text)

    def test_changed_encoded_entry_path_is_rejected(self):
        self.reject_encoded_mutation(lambda entry: entry.update(path='ui-acceptance/other.json'), 'encoded location changed')

    def test_changed_original_size_metadata_is_rejected(self):
        self.reject_encoded_mutation(lambda entry: entry.update(original_bytes=entry['original_bytes'] + 1), 'original size changed')

    def test_changed_original_digest_metadata_is_rejected(self):
        self.reject_encoded_mutation(lambda entry: entry.update(original_sha256='0' * 64), 'original digest changed')

    def test_invalid_base64_is_rejected_before_any_source_proof(self):
        self.reject_encoded_mutation(lambda entry: entry.update(original_base64=entry['original_base64'] + '!'), 'Base64 invalid')

    def test_changed_decoded_original_bytes_are_rejected(self):
        for preserve_size in [False, True]:
            def changed(entry):
                raw = base64.b64decode(entry['original_base64'], validate=True)
                bad = raw[:-1] + b'\x00' if preserve_size else raw + b'\n'
                entry['original_base64'] = base64.b64encode(bad).decode('ascii')
            with self.subTest(preserve_size=preserve_size):
                self.reject_encoded_mutation(changed, 'decoded original bytes changed')

    def test_a_different_transform_is_rejected(self):
        self.reject_encoded_mutation(lambda entry: entry.update(git_text_transform='identity'), 'transform changed')

    def test_changed_readable_digest_metadata_is_rejected(self):
        self.reject_encoded_mutation(lambda entry: entry.update(git_text_sha256='0' * 64), 'readable artifact changed')

    def test_changed_same_commit_readable_blob_is_rejected(self):
        with self.targeted_bad_blob(reviewed.FINAL_DB_REPORT_PATH):
            with self.assertRaisesRegex(ValueError, 'readable artifact changed'):
                self.verify(reviewed.FINAL_ENVELOPE_PATH, 184)

    def test_changed_source_blob_is_rejected_for_direct_digest(self):
        for path, pin in reviewed.FINAL_EVIDENCE_DOCUMENTS.items():
            for line, spec in pin['lines'].items():
                if 'parent' in spec:
                    with self.subTest(path=path, line=line), self.targeted_bad_blob(reviewed.FINAL_SOURCE_PATH):
                        with self.assertRaisesRegex(ValueError, 'differs from immutable artifact'):
                            self.verify(path, line)

    def test_second_decoded_occurrence_cannot_skip_immutable_source_proof(self):
        real_run = reviewed.run
        for fail_at in [1, 2]:
            source_reads = []
            def changed_target(args, *, cwd=None):
                if args == ['git', 'cat-file', 'blob', f'{reviewed.FINAL_EVIDENCE_COMMIT}:{reviewed.FINAL_SOURCE_PATH}']:
                    source_reads.append(args)
                    if len(source_reads) == fail_at:
                        return b'controlled different source observation'
                return real_run(args, cwd=cwd)
            with self.subTest(fail_at=fail_at), patch.object(reviewed, 'run', side_effect=changed_target):
                with self.assertRaisesRegex(ValueError, 'differs from immutable artifact'):
                    self.verify(reviewed.FINAL_ENVELOPE_PATH, 184)
            self.assertEqual(len(source_reads), fail_at)

    def test_subject_decoded_occurrence_keeps_immutable_source_proof(self):
        with self.targeted_bad_blob(reviewed.FINAL_SOURCE_PATH):
            with self.assertRaisesRegex(ValueError, 'differs from immutable artifact'):
                self.verify(reviewed.FINAL_ENVELOPE_PATH, 192)


class ExactPathFindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.rows = {path: next(line for line in cls.config.splitlines()
                               if line.startswith(reviewed.PREFIX) and f':{path}:' in line)
                    for path in reviewed.EXACT_PATH_FINDINGS}

    def test_exact_paths_are_admitted_only_at_their_pinned_identity(self):
        records = reviewed.parse_records(self.config)
        exact = {r['fingerprint']: r['kinds'] for r in records
                 if r['fingerprint'].split(':')[1] in reviewed.EXACT_PATH_FINDINGS}
        self.assertEqual(len(exact), 10)
        for path, locations in reviewed.EXACT_PATH_FINDINGS.items():
            for (commit, line), kind in locations.items():
                self.assertEqual(exact[f'{commit}:{path}:generic-api-key:{line}'], [kind])

    def test_exact_path_identity_changes_are_rejected(self):
        for path, row in self.rows.items():
            (commit, line), kind = next(iter(reviewed.EXACT_PATH_FINDINGS[path].items()))
            for substitute in [row.replace(commit, '0' * 40),
                               row.replace(f':generic-api-key:{line}"', f':generic-api-key:{line + 1}"'),
                               row.replace(f'"kinds":["{kind}"]', '"kinds":["GA_RECORD_ID"]')]:
                with self.subTest(path=path, substitute=substitute):
                    with self.assertRaisesRegex(ValueError, 'Exact path exception identity changed'):
                        reviewed.parse_records(self.config.replace(row, substitute, 1))

    def test_exact_paths_are_not_prefixes(self):
        for path, row in self.rows.items():
            for other in [path + '.other', path.rsplit('/', 1)[0] + '/other' + Path(path).suffix]:
                with self.subTest(path=path, other=other):
                    with self.assertRaisesRegex(ValueError, 'Non-exact finding location'):
                        reviewed.parse_records(self.config.replace(row, row.replace(path, other), 1))

    def test_missing_exact_identity_cannot_borrow_another_allowed_location(self):
        path, row = next(iter(self.rows.items()))
        substitute = row.replace(path, 'apps/clued-cloud/tests/other.txt')
        with self.assertRaisesRegex(ValueError, 'Exact path exception set changed'):
            reviewed.parse_records(self.config.replace(row, substitute, 1))

    def test_new_exact_kinds_are_fixed_reasons(self):
        records = reviewed.parse_records(self.config)
        kinds = collections.Counter(kind for record in records for kind in record['kinds'])
        self.assertEqual(kinds['PUBLIC_KEY_FINGERPRINT'], 18)
        self.assertEqual(kinds['OAUTH_CLIENT_ID'], 2)
        row = next(line for line in self.config.splitlines() if '"kinds":["OAUTH_CLIENT_ID"]' in line)
        with self.assertRaisesRegex(ValueError, 'Unreviewed reason'):
            reviewed.parse_records(self.config.replace(row, row.replace('OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'), 1))


class PatchGitObjectMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.text = reviewed.run(['git', 'cat-file', 'blob',
                                 f'{reviewed.PATCH_DOCUMENT_COMMIT}:{reviewed.PATCH_DOCUMENT_PATH}'], cwd=ROOT).decode('utf-8')
        cls.helper = reviewed.run(['git', 'cat-file', 'blob',
                                   f'{reviewed.PATCH_DOCUMENT_COMMIT}:{reviewed.PATCH_HELPER_PATH}'], cwd=ROOT)

    def verify(self, line, text=None):
        reviewed.verify_patch_git_metadata(ROOT, self.text if text is None else text, line)

    def changed_patch_line(self, line, replacement):
        lines = self.text.splitlines()
        lines[line - 1] = replacement
        return '\n'.join(lines) + '\n'

    def reject_semantic_patch(self, line, text):
        # Reach the prefix/constant branch while all helper/object pins remain real.
        with patch.object(reviewed, 'PATCH_DOCUMENT_SHA256', hashlib.sha256(text.encode('utf-8')).hexdigest()):
            with self.assertRaisesRegex(ValueError, 'prefix or assignment changed'):
                self.verify(line, text)

    def routed_git_blob(self, command, result=None, error=None):
        real_run = reviewed.run
        def route(args, *, cwd=None):
            if args == command:
                if error is not None:
                    raise error
                return result
            return real_run(args, cwd=cwd)
        return patch.object(reviewed, 'run', side_effect=route)

    def test_actual_patch_objects_are_pinned_helper_ancestor_commits(self):
        for line in reviewed.PATCH_METADATA_LINES:
            with self.subTest(line=line):
                self.verify(line)

    def test_patch_registry_identity_is_exact(self):
        fingerprint = f'{reviewed.PATCH_DOCUMENT_COMMIT}:{reviewed.PATCH_DOCUMENT_PATH}:sourcegraph-access-token:46'
        row = next(line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX) and fingerprint in line)
        changes = [row.replace(reviewed.PATCH_DOCUMENT_COMMIT, '0' * 40),
                   row.replace(reviewed.PATCH_DOCUMENT_PATH, reviewed.PATCH_DOCUMENT_PATH + '.other'),
                   row.replace(reviewed.PATCH_DOCUMENT_PATH, 'work/other.patch'),
                   row.replace('sourcegraph-access-token:46', 'sourcegraph-access-token:47'),
                   row.replace('sourcegraph-access-token', 'generic-api-key'),
                   row.replace('GIT_OBJECT_METADATA', 'ARTIFACT_DIGEST')]
        for substitute in changes:
            with self.subTest(substitute=substitute):
                with self.assertRaises(ValueError):
                    reviewed.parse_records(self.config.replace(row, substitute, 1))

    def test_unreviewed_patch_line_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unreviewed patch metadata line'):
            self.verify(47)

    def test_changed_whole_patch_bytes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Patch document bytes changed'):
            self.verify(46, self.text + '\n')

    def test_diff_context_and_added_prefix_are_exact(self):
        for line, prefix in [(46, '+'), (52, ' ')]:
            with self.subTest(line=line):
                original = self.text.splitlines()[line - 1]
                self.reject_semantic_patch(line, self.changed_patch_line(line, prefix + original[1:]))

    def test_constant_name_and_commit_identity_are_exact(self):
        for line, spec in reviewed.PATCH_METADATA_LINES.items():
            original = self.text.splitlines()[line - 1]
            for replacement in [original.replace(spec['constant'], 'UNRELATED_COMMIT'),
                                original.replace(spec['object'], '0' * 40)]:
                with self.subTest(line=line, replacement=replacement):
                    self.reject_semantic_patch(line, self.changed_patch_line(line, replacement))

    def test_changed_helper_bytes_are_rejected(self):
        command = ['git', 'cat-file', 'blob', f'{reviewed.PATCH_DOCUMENT_COMMIT}:{reviewed.PATCH_HELPER_PATH}']
        with self.routed_git_blob(command, self.helper + b'\n'):
            with self.assertRaisesRegex(ValueError, 'Patch helper bytes changed'):
                self.verify(46)

    def test_helper_constant_correspondence_is_required(self):
        command = ['git', 'cat-file', 'blob', f'{reviewed.PATCH_DOCUMENT_COMMIT}:{reviewed.PATCH_HELPER_PATH}']
        for line, spec in reviewed.PATCH_METADATA_LINES.items():
            lines = self.helper.decode('utf-8').splitlines()
            lines[spec['helper_line'] - 1] = 'UNRELATED_COMMIT = "controlled metadata"'
            changed = ('\n'.join(lines) + '\n').encode('utf-8')
            with self.subTest(line=line), self.routed_git_blob(command, changed):
                with patch.object(reviewed, 'PATCH_HELPER_SHA256', hashlib.sha256(changed).hexdigest()):
                    with self.assertRaisesRegex(ValueError, 'helper constant identity changed'):
                        self.verify(line)

    def test_non_commit_object_types_are_rejected(self):
        for line, spec in reviewed.PATCH_METADATA_LINES.items():
            command = ['git', 'cat-file', '-t', spec['object']]
            for kind in [b'blob\n', b'tree\n']:
                with self.subTest(line=line, kind=kind), self.routed_git_blob(command, kind):
                    with self.assertRaisesRegex(ValueError, 'object is not a commit'):
                        self.verify(line)

    def test_unreadable_commit_object_is_rejected(self):
        for line, spec in reviewed.PATCH_METADATA_LINES.items():
            command = ['git', 'cat-file', '-t', spec['object']]
            with self.subTest(line=line), self.routed_git_blob(command, error=ValueError('Controlled object read failure')):
                with self.assertRaisesRegex(ValueError, 'Controlled object read failure'):
                    self.verify(line)

    def test_nonancestor_and_failed_git_ancestry_are_rejected(self):
        real_process = reviewed.subprocess.run
        for line, spec in reviewed.PATCH_METADATA_LINES.items():
            command = ['git', 'merge-base', '--is-ancestor', spec['object'], reviewed.PATCH_DOCUMENT_COMMIT]
            for code in [1, 128]:
                def route(args, **kwargs):
                    if args == command:
                        return subprocess.CompletedProcess(args, code, stdout=b'', stderr=b'')
                    return real_process(args, **kwargs)
                with self.subTest(line=line, code=code), patch.object(reviewed.subprocess, 'run', side_effect=route):
                    with self.assertRaisesRegex(ValueError, 'object is not an ancestor'):
                        self.verify(line)


class SchedulingExactFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.old_config = reviewed.run(['git', 'cat-file', 'blob',
                                      'f6ae29eda25c5ffa6131662e60251492e0878aa2:.gitleaks.toml'], cwd=ROOT).decode()
        cls.blobs = {path: reviewed.run(['git', 'cat-file', 'blob', f'{reviewed.SCHEDULING_COMMIT}:{path}'],
                                       cwd=ROOT).decode() for path in reviewed.SCHEDULING_BLOBS}

    def rows(self, text=None):
        return [line for line in (self.config if text is None else text).splitlines()
                if line.startswith(reviewed.PREFIX)]

    def test_only_three_exact_additions_preserve_every_legacy_record_byte(self):
        records = reviewed.parse_records(self.config)
        self.assertEqual(len(records), reviewed.EXPECTED_COUNT)
        self.assertEqual(self.rows()[:726], self.rows(self.old_config))
        self.assertEqual(hashlib.sha256(('\n'.join(self.rows()[:726]) + '\n').encode()).hexdigest(),
                         reviewed.LEGACY_RECORD_LINES_SHA256)
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.BASE_CONFIG)
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.tomllib.loads(self.old_config))
        self.assertEqual({r['fingerprint'] for r in records[726:729]}, set(reviewed.SCHEDULING_FINDINGS))
        self.assertEqual(sum(':private-key:' in r['fingerprint'] for r in records), 1)
        self.assertTrue(all(re.fullmatch(r'[a-f0-9]{40}:[^:]+:[^:]+:[1-9][0-9]*', r['fingerprint'])
                            for r in records))

    def test_commit_path_rule_line_and_classification_are_not_transferable(self):
        for row in self.rows()[726:729]:
            value = json.loads(row[len(reviewed.PREFIX):])
            commit, path, rule, line = value['fingerprint'].split(':')
            mutations = [dict(value, fingerprint=':'.join(['0' * 40, path, rule, line])),
                         dict(value, fingerprint=':'.join([commit, 'apps/clued-cloud/tests/other.mjs', rule, line])),
                         dict(value, fingerprint=':'.join([commit, path, rule, str(int(line) + 1)])),
                         dict(value, fingerprint=':'.join([commit, path, 'unreviewed-rule', line])),
                         dict(value, kinds=['ARTIFACT_DIGEST']), dict(value, kinds=['FAKE_MARKER_KIND'])]
            for changed in mutations:
                replacement = reviewed.PREFIX + json.dumps(changed, separators=(',', ':'))
                with self.subTest(fingerprint=value['fingerprint'], changed=changed), self.assertRaises(ValueError):
                    reviewed.parse_records(self.config.replace(row, replacement, 1))

    def test_duplicate_deleted_legacy_fourth_or_rewritten_legacy_record_is_rejected(self):
        rows = self.rows()
        fourth = reviewed.PREFIX + json.dumps({'fingerprint': '0' * 40 + ':work/other.txt:generic-api-key:1',
                                               'kinds': ['ARTIFACT_DIGEST']}, separators=(',', ':'))
        changes = [self.config.replace(rows[-1], rows[-2], 1),
                   self.config.replace(rows[0] + '\n', '', 1),
                   self.config.replace(rows[0], fourth, 1),
                   self.config.replace(rows[0], rows[0].replace(':', ': ', 1), 1),
                   self.config.replace('# clued-reviewed-count: 737', '# clued-reviewed-count: 738') + fourth + '\n']
        for changed in changes:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(changed)

    def test_actual_immutable_blob_and_span_proof(self):
        for fingerprint in reviewed.SCHEDULING_FINDINGS:
            path = fingerprint.split(':')[1]
            with self.subTest(fingerprint=fingerprint):
                reviewed.verify_scheduling_fixture(ROOT, fingerprint, self.blobs[path])

    def test_wrong_blob_bytes_or_git_binding_are_rejected(self):
        real_run = reviewed.run
        for fingerprint in reviewed.SCHEDULING_FINDINGS:
            path = fingerprint.split(':')[1]
            with self.subTest(fingerprint=fingerprint), self.assertRaisesRegex(ValueError, 'immutable blob changed'):
                reviewed.verify_scheduling_fixture(ROOT, fingerprint, self.blobs[path] + '\n')
            def route(args, *, cwd=None):
                if args[:2] == ['git', 'rev-parse']:
                    return b'0' * 40 + b'\n'
                return real_run(args, cwd=cwd)
            with self.subTest(fingerprint=fingerprint), patch.object(reviewed, 'run', side_effect=route):
                with self.assertRaisesRegex(ValueError, 'immutable blob changed'):
                    reviewed.verify_scheduling_fixture(ROOT, fingerprint, self.blobs[path])

    def test_new_commit_and_other_path_cannot_borrow_the_marker_proof(self):
        fingerprint = next(iter(reviewed.SCHEDULING_FINDINGS))
        text = self.blobs[reviewed.SCHEDULING_TEST_PATH]
        for changed in [fingerprint.replace(reviewed.SCHEDULING_COMMIT, '0' * 40),
                        fingerprint.replace(reviewed.SCHEDULING_TEST_PATH, 'apps/clued-cloud/tests/other.mjs')]:
            with self.subTest(fingerprint=changed), self.assertRaisesRegex(ValueError, 'Unreviewed scheduling fixture'):
                reviewed.verify_scheduling_fixture(ROOT, changed, text)

    def test_valid_private_pem_is_not_an_admitted_marker(self):
        pem = reviewed.synthetic_valid_private_pem()
        der = base64.b64decode(pem.splitlines()[1], validate=True)
        self.assertEqual(len(der), 48)
        self.assertEqual(der[:16].hex(), '302e020100300506032b657004220420')
        if shutil.which('node'):
            checked = subprocess.run(['node', '-e',
                "const fs=require('fs'),c=require('crypto');const k=c.createPrivateKey(fs.readFileSync(0));"
                "process.stdout.write(k.asymmetricKeyType==='ed25519'?'valid':'invalid');"],
                input=pem, capture_output=True, check=False)
            self.assertEqual(checked.returncode, 0, 'Controlled private fixture did not parse')
            self.assertEqual(checked.stdout, b'valid')
        fingerprint = next(iter(reviewed.SCHEDULING_FINDINGS))
        text = self.blobs[reviewed.SCHEDULING_TEST_PATH]
        lines = text.splitlines(keepends=True)
        lines[282] = re.sub(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"",
                            lambda _: json.dumps(pem.decode().rstrip('\n')), lines[282])
        with self.assertRaisesRegex(ValueError, 'immutable blob changed'):
            reviewed.verify_scheduling_fixture(ROOT, fingerprint, ''.join(lines))

    def test_candidate_evidence_contains_metadata_only_and_no_acceptance(self):
        path = ROOT / 'development/contracts/context-authorization/evidence/pr920-gitleaks-fixtures-20261023.json'
        text = path.read_text(encoding='utf-8')
        document = json.loads(text)
        self.assertEqual(document['status'], 'CANDIDATE_NOT_ACCEPTED')
        self.assertFalse(document['source_runtime_accepted'])
        self.assertEqual(document['legacy_record_lines_sha256'], reviewed.LEGACY_RECORD_LINES_SHA256)
        self.assertEqual({item['fingerprint'] for item in document['findings']}, set(reviewed.SCHEDULING_FINDINGS))
        self.assertNotIn('-----BEGIN ', text)
        self.assertNotIn('"Secret"', text)
        self.assertNotIn('"Match"', text)


class RoleProbeExactTokenTests(unittest.TestCase):
    FINGERPRINT = next(iter(reviewed.ROLE_PROBE_FINDINGS))

    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.old_config = reviewed.run(['git', 'cat-file', 'blob',
                                      '91288d285ab679ac731be5b03c8ae5f6dbf2d777:.gitleaks.toml'], cwd=ROOT).decode()
        cls.blob = reviewed.run(['git', 'cat-file', 'blob',
                                 f'{reviewed.ROLE_PROBE_COMMIT}:{reviewed.ROLE_PROBE_PATH}'], cwd=ROOT).decode()

    def rows(self, text=None):
        return [line for line in (self.config if text is None else text).splitlines()
                if line.startswith(reviewed.PREFIX)]

    def test_only_one_exact_addition_preserves_every_prior_record_byte(self):
        records = reviewed.parse_records(self.config)
        self.assertEqual(len(records), reviewed.EXPECTED_COUNT)
        self.assertEqual(self.rows()[:729], self.rows(self.old_config))
        self.assertEqual(hashlib.sha256(('\n'.join(self.rows()[:729]) + '\n').encode()).hexdigest(),
                         reviewed.PRIOR_RECORD_LINES_SHA256)
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.tomllib.loads(self.old_config))
        self.assertEqual([r['fingerprint'] for r in records[729:730]], [self.FINGERPRINT])
        self.assertEqual(records[729]['kinds'], ['SYNTHETIC_ROLE_PROBE_TOKEN'])

    def test_commit_path_rule_line_and_classification_are_not_transferable(self):
        row = self.rows()[729]
        value = json.loads(row[len(reviewed.PREFIX):])
        commit, path, rule, line = value['fingerprint'].split(':')
        mutations = [dict(value, fingerprint=':'.join(['0' * 40, path, rule, line])),
                     dict(value, fingerprint=':'.join([commit, 'work/independent-ci-resident-v1/test/other.test.mjs', rule, line])),
                     dict(value, fingerprint=':'.join([commit, path, rule, '74'])),
                     dict(value, fingerprint=':'.join([commit, path, 'private-key', line])),
                     dict(value, kinds=['SYNTHETIC_TEST_TOKEN']), dict(value, kinds=['ARTIFACT_DIGEST'])]
        for changed in mutations:
            replacement = reviewed.PREFIX + json.dumps(changed, separators=(',', ':'))
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                reviewed.parse_records(self.config.replace(row, replacement, 1))
        borrowed = self.rows()[0].replace('"kinds":["', '"kinds":["SYNTHETIC_ROLE_PROBE_TOKEN","', 1)
        with self.assertRaisesRegex(ValueError, 'Role-probe token exception identity changed'):
            reviewed.parse_records(self.config.replace(self.rows()[0], borrowed, 1))

    def test_deleted_duplicate_or_extra_record_is_rejected(self):
        row = self.rows()[729]
        second = row.replace(':generic-api-key:73', ':generic-api-key:74')
        for changed in [self.config.replace(row + '\n', '', 1).replace('count: 737', 'count: 736'),
                        self.config.replace(row, self.rows()[728], 1),
                        self.config.replace('count: 737', 'count: 738') + second + '\n']:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(changed)

    def test_actual_immutable_blob_span_and_use_proof(self):
        reviewed.verify_role_probe_token(ROOT, self.FINGERPRINT, self.blob)

    def test_wrong_blob_bytes_git_binding_or_identity_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'immutable blob changed'):
            reviewed.verify_role_probe_token(ROOT, self.FINGERPRINT, self.blob + '\n')
        real_run = reviewed.run
        def route(args, *, cwd=None):
            if args[:2] == ['git', 'rev-parse']:
                return b'0' * 40 + b'\n'
            return real_run(args, cwd=cwd)
        with patch.object(reviewed, 'run', side_effect=route), self.assertRaisesRegex(ValueError, 'immutable blob changed'):
            reviewed.verify_role_probe_token(ROOT, self.FINGERPRINT, self.blob)
        for changed in [self.FINGERPRINT.replace(reviewed.ROLE_PROBE_COMMIT, '0' * 40),
                        self.FINGERPRINT.replace(':73', ':74')]:
            with self.subTest(fingerprint=changed), self.assertRaisesRegex(ValueError, 'Unreviewed role-probe token'):
                reviewed.verify_role_probe_token(ROOT, changed, self.blob)

    def test_use_checks_reject_a_changed_span_or_extra_use(self):
        pin = dict(reviewed.ROLE_PROBE_BLOB)
        def repinned(text):
            data = text.encode()
            return {'blob': hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest(),
                    'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        def route_for(text):
            real_run = reviewed.run
            def route(args, *, cwd=None):
                if args[:2] == ['git', 'rev-parse']:
                    return repinned(text)['blob'].encode() + b'\n'
                return real_run(args, cwd=cwd)
            return route
        lines = self.blob.splitlines(keepends=True)
        extra_use = lines[:81] + ['  console.log(token);\n'] + lines[81:]
        sent = lines[:76] + [lines[76].replace('native.push(v);', 'native.push(v, token);')] + lines[77:]
        self.assertNotEqual(''.join(sent), self.blob)
        for text, reason in [(''.join(extra_use), 'test boundary changed|use changed'), (''.join(sent), 'use changed')]:
            with self.subTest(reason=reason), patch.dict(reviewed.ROLE_PROBE_BLOB, repinned(text)), \
                    patch.object(reviewed, 'run', side_effect=route_for(text)), self.assertRaisesRegex(ValueError, reason):
                reviewed.verify_role_probe_token(ROOT, self.FINGERPRINT, text)
        self.assertEqual(reviewed.ROLE_PROBE_BLOB, pin)

    def test_candidate_evidence_contains_metadata_only_and_no_acceptance(self):
        path = ROOT / 'development/contracts/context-authorization/evidence/pr937-gitleaks-role-probe-20261029.json'
        text = path.read_text(encoding='utf-8')
        document = json.loads(text)
        self.assertEqual(document['schema'], 'clued.reviewed-gitleaks-exact-fixtures-candidate/1')
        self.assertEqual(document['status'], 'CANDIDATE_NOT_ACCEPTED')
        self.assertFalse(document['source_runtime_accepted'])
        self.assertEqual(document['legacy_record_lines_sha256'], reviewed.LEGACY_RECORD_LINES_SHA256)
        self.assertEqual(document['prior_record_lines_sha256'], reviewed.PRIOR_RECORD_LINES_SHA256)
        self.assertEqual([item['fingerprint'] for item in document['findings']], [self.FINGERPRINT])
        finding = document['findings'][0]
        self.assertEqual((finding['blob_id'], finding['blob_sha256'], finding['blob_bytes']),
                         (reviewed.ROLE_PROBE_BLOB['blob'], reviewed.ROLE_PROBE_BLOB['sha256'], reviewed.ROLE_PROBE_BLOB['bytes']))
        spec = reviewed.ROLE_PROBE_FINDINGS[self.FINGERPRINT]
        self.assertEqual((finding['span_bytes_lf'], finding['span_sha256_lf']), (spec['span_bytes'], spec['span_sha256']))
        self.assertIsNone(re.search(r'clued_bnd_fixture[0-9]', text))
        self.assertNotIn('"Secret"', text)
        self.assertNotIn('"Match"', text)


class RoleProbeSelfTestRegressionTests(unittest.TestCase):
    """Drive the helper's real Git setup; only the detector is a wire-level mock.

    The one reviewed fingerprint must grant no suppression to a new commit, another
    path or another (Git-added) line; each of the three detections is required.
    """

    @classmethod
    def setUpClass(cls):
        cls.blob = reviewed.run(['git', 'cat-file', 'blob',
                                 f'{reviewed.ROLE_PROBE_COMMIT}:{reviewed.ROLE_PROBE_PATH}'], cwd=ROOT).decode()

    def run_self_test(self, suppress=None, missing_integrity=None, integrity_rules=None,
                      omitted_integrity_field=None, wrong_integrity_commit=False, spanning_integrity=False,
                      use_oid_rule=False):
        actual_run = reviewed.subprocess.run
        scans = []
        docker = 'controlled-detector-wire-mock'

        def result(args, code, findings):
            return subprocess.CompletedProcess(args, code, json.dumps(findings).encode(), b'')

        def finding(path, rule, line=1, commit='0' * 40):
            return {'File': path, 'RuleID': rule, 'StartLine': line, 'EndLine': line, 'Commit': commit,
                    'Fingerprint': commit + ':' + path + ':' + rule + ':' + str(line)}

        def route(args, **options):
            if args[0] != docker:
                return actual_run(args, **options)
            index = len(scans)
            mount = next(value for value in args if str(value).endswith('target=/test,readonly'))
            repo = Path(mount.split('source=', 1)[1].split(',target=', 1)[0])
            scans.append(repo)
            if index == suppress:
                return result(args, 0, [])
            rules = ['sourcegraph-access-token', 'generic-api-key']
            scheduling = [(reviewed.SCHEDULING_TEST_PATH, 'private-key'),
                          (reviewed.SCHEDULING_TEST_PATH, 'generic-api-key'),
                          (reviewed.SCHEDULING_README_PATH, 'generic-api-key')]
            if index == 0:
                return result(args, 1, [finding('probe.txt', rule) for rule in rules])
            if index == 1:
                return result(args, 0, [])
            if index == 2:
                return result(args, 1, [finding(path, rule) for path in ['probe.txt', 'other-path.txt'] for rule in rules])
            if index in [3, 4]:
                prefix = '' if index == 3 else 'other-path/'
                return result(args, 1, [finding(prefix + path, rule) for path, rule in scheduling])
            if index in [5, 6]:
                prefix = '' if index == 5 else 'other-path/'
                self.assertEqual((repo / prefix / reviewed.ROLE_PROBE_PATH).read_bytes(), self.blob.encode())
                return result(args, 1, [finding(prefix + reviewed.ROLE_PROBE_PATH, 'generic-api-key', 73)])
            if index == 7:
                previous = actual_run(['git', 'cat-file', '-e', 'HEAD^:' + reviewed.ROLE_PROBE_PATH],
                                      cwd=repo, capture_output=True, check=False)
                self.assertNotEqual(previous.returncode, 0, 'The shifted token must follow an absent parent blob')
                diff = actual_run(['git', 'diff', '--no-ext-diff', '--unified=0', 'HEAD^', 'HEAD', '--',
                                   reviewed.ROLE_PROBE_PATH], cwd=repo, capture_output=True, check=True).stdout
                added, number = {}, None
                for line in diff.splitlines():
                    if line.startswith(b'@@'):
                        number = int(re.search(rb'\+(\d+)', line).group(1))
                    elif number is not None and line.startswith(b'+'):
                        added[number] = line[1:]
                        number += 1
                    elif number is not None and line.startswith(b' '):
                        number += 1
                self.assertEqual(added.get(74), self.blob.splitlines()[72].encode(),
                                 'The shifted token must be an actual Git-added line at 74')
                return result(args, 1, [finding(reviewed.ROLE_PROBE_PATH, 'generic-api-key', 74)])
            if index == 8:
                return result(args, 1, [finding('controlled-valid-private.pem', 'private-key')])
            catalog = reviewed._candidate_policy.CATALOG
            specs = reviewed._candidate_policy.SPECS
            if index in [9, 10, 11]:
                prefix, shift = [('', 0), ('other-path/', 0), ('', 1)][index - 9]
                return result(args, 1, [finding(prefix + catalog, 'curl-auth-user', spec['line'] + shift) for spec in specs])
            if index == 12:
                head = actual_run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, check=True).stdout.decode().strip()
                self.assertEqual(actual_run(['git', 'cat-file', '-p', 'HEAD:' + catalog], cwd=repo, capture_output=True,
                                            check=True).stdout, reviewed._candidate_policy.load(ROOT)[reviewed._candidate_policy.H2]['catalog'])
                return result(args, 1, [finding(catalog, 'curl-auth-user', spec['line'], head)
                                        for spec in reviewed._candidate_policy.SPECS_D94])
            if index == 13:
                return result(args, 1, [finding('curl-credential-probe.txt', 'curl-auth-user')])
            if index in [14, 15, 16]:
                prefix, line = [('','40'), ('other-path/','40'), ('','41')][index - 14]
                path = prefix + reviewed.PUBLIC_BATCH_PATH
                self.assertTrue((repo / path).exists())
                if index == 16:
                    previous = actual_run(['git', 'cat-file', '-e', 'HEAD^:' + path],
                                          cwd=repo, capture_output=True, check=False)
                    self.assertNotEqual(previous.returncode, 0)
                return result(args, 1, [finding(path, 'generic-api-key', int(line))])
            if index in [17, 18, 19]:
                prefix, shift = [('', 0), ('other-path/', 0), ('', 1)][index - 17]
                path = prefix + reviewed.INTEGRITY_PATH
                expected = actual_run(['git', 'cat-file', 'blob', reviewed.INTEGRITY_COMMIT + ':' + reviewed.INTEGRITY_PATH],
                                      cwd=ROOT, capture_output=True, check=True).stdout
                self.assertEqual((repo / path).read_bytes(), (b'\n' if shift else b'') + expected)
                head = actual_run(['git', 'rev-parse', 'HEAD'], cwd=repo, capture_output=True, check=True).stdout.decode().strip()
                selected = {line:(integrity_rules or {}).get(line, rules[0] if use_oid_rule and line == 76 else 'generic-api-key')
                            for line in reviewed.INTEGRITY_SPECS}
                selected = {line:rules[0] if value == 'oid_default' else value for line,value in selected.items()}
                values = [finding(path, selected[line], line + shift,
                                  '0' * 40 if wrong_integrity_commit else head)
                          for line in reviewed.INTEGRITY_SPECS if missing_integrity != (index, line)]
                if omitted_integrity_field is not None:
                    values[0].pop(omitted_integrity_field, None)
                if spanning_integrity:
                    values[0]['EndLine'] += 1
                return result(args, 1, values)
            self.fail('Unexpected extra detector call')

        with tempfile.TemporaryDirectory(prefix='clued-role-probe-self-test-') as temporary:
            fake_root = Path(temporary) / 'helper-temp'
            with patch.object(reviewed.shutil, 'which', return_value=docker), \
                    patch.object(reviewed.tempfile, 'mkdtemp', side_effect=lambda **kwargs: str(fake_root.mkdir() or fake_root)), \
                    patch.object(reviewed.subprocess, 'run', side_effect=route), \
                    patch.object(reviewed, '_self_test_handover_acceptance', return_value={}):
                try:
                    return reviewed.self_test(ROOT / '.gitleaks.toml', ''), scans
                finally:
                    shutil.rmtree(fake_root, ignore_errors=True)

    def test_new_commit_other_path_and_added_line_are_all_detected(self):
        report, scans = self.run_self_test()
        self.assertEqual(len(scans), 20)
        for key in ['role_probe_new_commit_detection', 'role_probe_different_path_detection',
                    'role_probe_different_line_detection', 'historical_json_new_commit_detection',
                    'historical_json_different_path_detection', 'historical_json_different_line_detection',
                    'genuine_curl_credential_detection', 'public_batch_key_new_commit_detection',
                    'public_batch_key_different_path_detection', 'public_batch_key_different_line_detection',
                    'integrity_metadata_new_commit_detection', 'integrity_metadata_different_path_detection',
                    'integrity_metadata_different_line_detection']:
            self.assertIs(report[key], True, key)

    def test_each_suppressed_role_probe_regression_fails_the_self_test(self):
        for index, reason in [(5, 'suppressed in a new commit'), (6, 'suppressed at another path'),
                              (7, 'suppressed at another line')]:
            with self.subTest(scan=index), self.assertRaisesRegex(ValueError, 'Role-probe marker was ' + reason):
                self.run_self_test(suppress=index)

    def test_each_suppressed_historical_json_regression_fails_the_self_test(self):
        for index, reason in [(9, 'Historical JSON metadata was suppressed at a new commit'),
                              (10, 'Historical JSON metadata was suppressed at another path'),
                              (11, 'Historical JSON metadata was suppressed at another line'),
                              (12, 'Historical d94cd486 JSON metadata was suppressed at a new commit'),
                              (13, 'Genuine credential-shaped curl fixture was suppressed')]:
            with self.subTest(scan=index), self.assertRaisesRegex(ValueError, reason):
                self.run_self_test(suppress=index)

    def test_each_suppressed_public_batch_key_regression_fails_the_self_test(self):
        for index, reason in [(14, 'in a new commit'), (15, 'at another path'), (16, 'at another line')]:
            with self.subTest(scan=index), self.assertRaisesRegex(ValueError, 'Public batch key was suppressed ' + reason):
                self.run_self_test(suppress=index)

    def test_each_suppressed_integrity_metadata_regression_fails_the_self_test(self):
        for index, reason in [(17, 'in a new commit'), (18, 'at another path'), (19, 'at another line')]:
            with self.subTest(scan=index), self.assertRaisesRegex(ValueError, 'Integrity metadata was suppressed ' + reason):
                self.run_self_test(suppress=index)

    def test_a_single_missing_integrity_location_cannot_pass_a_canary(self):
        for index, line in [(17, 76), (18, 82), (19, 83)]:
            with self.subTest(scan=index, line=line), self.assertRaisesRegex(ValueError, 'Integrity metadata was suppressed'):
                self.run_self_test(missing_integrity=(index, line))

    def test_actual_whole_file_default_rule_for_public_oid_is_accepted(self):
        report, scans = self.run_self_test(use_oid_rule=True)
        self.assertEqual(len(scans), 20)
        self.assertIs(report['integrity_metadata_new_commit_detection'], True)
        self.assertIs(report['integrity_metadata_different_path_detection'], True)
        self.assertIs(report['integrity_metadata_different_line_detection'], True)

    def test_unreviewed_rules_cannot_replace_any_integrity_location(self):
        for rules in [{76:'private-key'}, {82:'oid_default'}, {83:'oid_default'}]:
            with self.subTest(), self.assertRaisesRegex(ValueError,'Integrity metadata was suppressed'):
                self.run_self_test(integrity_rules=rules)

    def test_missing_fields_prior_commit_or_spanning_match_cannot_prove_all_locations(self):
        variants = [{'omitted_integrity_field':field} for field in ['File','RuleID','StartLine','EndLine','Commit']]
        variants += [{'wrong_integrity_commit':True}, {'spanning_integrity':True}]
        for variant in variants:
            with self.subTest(), self.assertRaisesRegex(ValueError,'Integrity metadata was suppressed'):
                self.run_self_test(**variant)


class HistoricalD94ExactTwinTests(unittest.TestCase):
    """Owner Decision 98fec682: one appended fingerprint, the d94cd486 twin of the cc353e29 gitleaks.yml line."""
    D94 = 'd94cd486e29a7362888fc32cd807ceb38890acb6'
    FINGERPRINT = D94 + ':scripts/ci/clued-gated-proof-profiles.json:curl-auth-user:3829'
    # The last main commit with the prior 732-record reviewed set (full id: reachable from main, never an unpublished local commit).
    PRIOR_732_COMMIT = '94d70bc1654607160416daba60685f9e8bd4fca3'

    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.old_config = reviewed.run(['git', 'cat-file', 'blob', cls.PRIOR_732_COMMIT + ':.gitleaks.toml'], cwd=ROOT).decode()
        cls.policy = reviewed._candidate_policy
        cls.data = cls.policy.load(ROOT)

    def rows(self, text=None):
        return [line for line in (self.config if text is None else text).splitlines() if line.startswith(reviewed.PREFIX)]

    def test_exactly_one_record_is_appended_and_the_732_bytes_are_preserved(self):
        records = reviewed.parse_records(self.config)
        self.assertEqual(len(records), reviewed.EXPECTED_COUNT)
        self.assertEqual(self.rows()[:732], self.rows(self.old_config))
        self.assertEqual(len(self.rows(self.old_config)), 732)
        self.assertEqual(hashlib.sha256(('\n'.join(self.rows()[:732]) + '\n').encode()).hexdigest(),
                         reviewed.PRIOR_732_RECORD_LINES_SHA256)
        self.assertEqual([r['fingerprint'] for r in records[732:733]], [self.FINGERPRINT])
        self.assertEqual(records[732]['kinds'], [self.policy.KIND])
        self.assertEqual(set(self.policy.FINDINGS), set(self.policy.FINDINGS_CC353) | {self.FINGERPRINT})
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.tomllib.loads(self.old_config))
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.BASE_CONFIG)

    def test_the_twin_line_is_byte_identical_and_the_pinned_history_proof_passes(self):
        for fingerprint in self.policy.FINDINGS:
            self.assertEqual(self.policy.verify(fingerprint, self.data)['fixed_historical_subject_verified'], True)
        lines = {commit: self.data[commit]['catalog'].decode().split('\n')[3828] for commit in (self.policy.H, self.D94)}
        self.assertEqual(lines[self.policy.H], lines[self.D94])
        self.assertEqual(hashlib.sha256(lines[self.D94].encode() + b'\n').hexdigest()[:16], '1d46d7f51f8c0d32')

    def test_commit_path_rule_line_and_kind_are_not_transferable(self):
        row = self.rows()[732]
        value = json.loads(row[len(reviewed.PREFIX):])
        commit, path, rule, line = value['fingerprint'].split(':')
        mutations = [dict(value, fingerprint=':'.join(['0' * 40, path, rule, line])),
                     dict(value, fingerprint=':'.join([commit, 'other/' + path, rule, line])),
                     dict(value, fingerprint=':'.join([commit, path, rule, '3830'])),
                     dict(value, fingerprint=':'.join([commit, path, 'generic-api-key', line])),
                     dict(value, kinds=['SYNTHETIC_TEST_TOKEN']), dict(value, kinds=['ARTIFACT_DIGEST'])]
        for changed in mutations:
            replacement = reviewed.PREFIX + json.dumps(changed, separators=(',', ':'))
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                reviewed.parse_records(self.config.replace(row, replacement, 1))

    def test_other_d94cd486_lines_and_other_commits_cannot_borrow_the_kind(self):
        row = self.rows()[732]
        for fingerprint in [self.D94 + ':scripts/ci/clued-gated-proof-profiles.json:curl-auth-user:5538',
                            '8ea4da401cf09bbb4b98244e9a69f57ab2db32e3:scripts/ci/clued-gated-proof-profiles.json:curl-auth-user:3829',
                            'e14db5764a67a927b27371fa3b568287671de4a3:scripts/ci/clued-gated-proof-profiles.json:curl-auth-user:3829',
                            '59fff5419bcfe83be00a091e96d49e4186cb4bad:scripts/ci/clued-gated-proof-profiles.json:curl-auth-user:3829']:
            replacement = reviewed.PREFIX + json.dumps({'fingerprint': fingerprint, 'kinds': [self.policy.KIND]}, separators=(',', ':'))
            with self.subTest(fingerprint=fingerprint), self.assertRaises(ValueError):
                reviewed.parse_records(self.config.replace(row, replacement, 1))
            with self.subTest(extra=fingerprint), self.assertRaises(ValueError):
                reviewed.parse_records(self.config.replace('count: 737', 'count: 738') + replacement + '\n')

    def test_deleted_or_replaced_records_are_rejected(self):
        row = self.rows()[732]
        for changed in [self.config.replace(row + '\n', '', 1).replace('count: 737', 'count: 736'),
                        self.config.replace(row, self.rows()[731], 1)]:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(changed)

    def test_whole_line_digest_is_enforced_for_every_spec(self):
        for fingerprint, spec in self.policy.FINDINGS.items():
            with self.subTest(fingerprint=fingerprint), patch.dict(spec, line_sha256='0' * 64), self.assertRaises(ValueError):
                self.policy.verify(fingerprint, self.data)
        self.assertEqual(self.policy.SPECS_D94[0]['line_sha256'], self.policy.SPECS[0]['line_sha256'])

    def test_the_prior_732_bytes_are_enforced_even_when_the_record_set_is_unchanged(self):
        rows = self.rows()
        swapped = self.config.replace(rows[730] + chr(10) + rows[731], rows[731] + chr(10) + rows[730], 1)
        keys = json.loads(rows[731][len(reviewed.PREFIX):])
        reordered = self.config.replace(rows[731], reviewed.PREFIX + json.dumps({'kinds': keys['kinds'], 'fingerprint': keys['fingerprint']}, separators=(',', ':')), 1)
        for changed in (swapped, reordered):
            self.assertNotEqual(changed, self.config)
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(changed)

    def test_changed_catalog_bytes_or_line_are_rejected(self):
        for mutate in [lambda d: d.update(catalog=d['catalog'] + b' '),
                       lambda d: d.update(catalog=d['catalog'].replace(b'--user=65532:65532', b'--user=65533:65533', 1)),
                       lambda d: d.update(roles=d['roles'] + b' '), lambda d: d.update(patch=d['patch'] + b' ')]:
            data = copy.deepcopy(self.data)
            mutate(data[self.D94])
            with self.subTest(), self.assertRaises(ValueError):
                self.policy.verify(self.FINGERPRINT, data)


class PublicRecoveryBatchKeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.blob = reviewed.run(['git', 'cat-file', 'blob',
                                reviewed.PUBLIC_BATCH_COMMIT + ':' + reviewed.PUBLIC_BATCH_PATH], cwd=ROOT).decode()

    def test_one_exact_addition_preserves_original733_record_bytes_and_default_rules(self):
        rows = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)]
        records = reviewed.parse_records(self.config)
        self.assertEqual(len(records), reviewed.EXPECTED_COUNT)
        self.assertEqual(hashlib.sha256(('\n'.join(rows[:733]) + '\n').encode()).hexdigest(),
                         reviewed.ORIGINAL_733_RECORD_LINES_SHA256)
        self.assertEqual(records[733:734], [{'fingerprint': reviewed.PUBLIC_BATCH_FINGERPRINT,
                                          'kinds': [reviewed.PUBLIC_BATCH_KIND]}])
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.BASE_CONFIG)

    def test_commit_path_rule_line_kind_and_borrowed_kind_are_not_transferable(self):
        row = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)][733]
        record = json.loads(row[len(reviewed.PREFIX):])
        commit, path, rule, line = reviewed.PUBLIC_BATCH_FINGERPRINT.split(':')
        for fp in [':'.join(['0' * 40, path, rule, line]), ':'.join([commit, path + '.other', rule, line]),
                   ':'.join([commit, path, rule, '41']), ':'.join([commit, path, 'private-key', line])]:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(self.config.replace(row, reviewed.PREFIX + json.dumps(dict(record, fingerprint=fp))))
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.verify_public_batch_key(ROOT, fp, self.blob)
        changed = dict(record, kinds=['ARTIFACT_DIGEST'])
        with self.assertRaises(ValueError):
            reviewed.parse_records(self.config.replace(row, reviewed.PREFIX + json.dumps(changed)))
        old = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)][0]
        value = json.loads(old[len(reviewed.PREFIX):]); value['kinds'] = [reviewed.PUBLIC_BATCH_KIND]
        with self.assertRaises(ValueError):
            reviewed.parse_records(self.config.replace(old, reviewed.PREFIX + json.dumps(value)))

    def test_deleted_duplicate_extra_reordered_or_rewritten_record_is_rejected(self):
        rows = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)]
        for text in [self.config.replace(rows[733] + '\n', '').replace('count: 737', 'count: 736'),
                     self.config.replace(rows[733], rows[732]),
                     self.config.replace('count: 737', 'count: 738') + rows[733] + '\n',
                     self.config.replace(rows[0] + '\n' + rows[1], rows[1] + '\n' + rows[0]),
                     self.config.replace(rows[0], rows[0].replace(': {', ': { ', 1))]:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(text)

    def test_actual_immutable_blob_line_context_and_public_usage_pass(self):
        reviewed.verify_public_batch_key(ROOT, reviewed.PUBLIC_BATCH_FINGERPRINT, self.blob)

    def test_changed_blob_git_binding_line_or_context_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'immutable blob changed'):
            reviewed.verify_public_batch_key(ROOT, reviewed.PUBLIC_BATCH_FINGERPRINT, self.blob + '\n')
        with patch.object(reviewed, 'run', return_value=b'0' * 40 + b'\n'), self.assertRaisesRegex(ValueError, 'immutable blob changed'):
            reviewed.verify_public_batch_key(ROOT, reviewed.PUBLIC_BATCH_FINGERPRINT, self.blob)
        for name in ['PUBLIC_BATCH_LINE_SHA256', 'PUBLIC_BATCH_CONTEXT_SHA256']:
            with self.subTest(), patch.object(reviewed, name, '0' * 64), self.assertRaisesRegex(ValueError, 'exact line or context'):
                reviewed.verify_public_batch_key(ROOT, reviewed.PUBLIC_BATCH_FINGERPRINT, self.blob)

    def test_repinning_blob_cannot_admit_authentication_or_extra_use(self):
        mutations = [self.blob + '\n$headers = @{ Authorization = $BatchKey }\n',
                     self.blob.replace("'-BatchKey', $BatchKey", "'-Token', $BatchKey")]
        for text in mutations:
            self.assertNotEqual(text, self.blob)
            raw = text.encode()
            pin = {'blob': hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest(),
                   'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
            with self.subTest(), patch.dict(reviewed.PUBLIC_BATCH_BLOB, pin), \
                    patch.object(reviewed, 'run', return_value=pin['blob'].encode() + b'\n'), \
                    self.assertRaisesRegex(ValueError, 'metadata/archive use changed'):
                reviewed.verify_public_batch_key(ROOT, reviewed.PUBLIC_BATCH_FINGERPRINT, text)

    def test_genuine_credential_variants_do_not_gain_the_public_kind(self):
        original = re.search(r"\$BatchKey = '([^']+)'", self.blob).group(1)
        for replacement in ['clued_bnd_' + 'A' * 40, 'sk_live_' + 'A' * 32, 'A' * 64]:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.verify_public_batch_key(ROOT, reviewed.PUBLIC_BATCH_FINGERPRINT,
                                                 self.blob.replace(original, replacement))


class ExactIntegrityMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.text = reviewed.run(['git', 'cat-file', 'blob',
                                reviewed.INTEGRITY_COMMIT + ':' + reviewed.INTEGRITY_PATH], cwd=ROOT).decode()

    def test_only_three_exact_additions_preserve_all734_record_lines_and_detection(self):
        records = reviewed.parse_records(self.config)
        rows = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)]
        self.assertEqual(len(records), 737)
        self.assertEqual(hashlib.sha256(('\n'.join(rows[:734]) + '\n').encode()).hexdigest(),
                         reviewed.ORIGINAL_734_RECORD_LINES_SHA256)
        self.assertEqual([record['fingerprint'] for record in records[734:]], list(reviewed.INTEGRITY_FINDINGS))
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.BASE_CONFIG)

    def test_current_metadata_names_do_not_mislabel_digests_as_credentials(self):
        tree = ast.parse((ROOT / 'scripts/ci/reviewed_gitleaks.py').read_text(encoding='utf-8'))
        names = [target.id for node in tree.body if isinstance(node, ast.Assign) for target in node.targets
                 if isinstance(target, ast.Name) and target.id.startswith(('PUBLIC_BATCH_', 'INTEGRITY_'))]
        self.assertGreater(len(names), 10)
        self.assertTrue(all(re.search(r'key|token|secret', name, re.I) is None for name in names))

    def test_actual_old_blob_spans_derivations_and_uses_pass(self):
        for fingerprint in reviewed.INTEGRITY_FINDINGS:
            reviewed.verify_integrity_metadata(ROOT, fingerprint, self.text)

    def test_exact_identity_and_kind_cannot_transfer_or_be_borrowed(self):
        rows = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)]
        for row in rows[734:]:
            original = json.loads(row[len(reviewed.PREFIX):]); commit, path, rule, line = original['fingerprint'].split(':')
            alternatives = [dict(original, fingerprint=':'.join(['0' * 40, path, rule, line])),
                            dict(original, fingerprint=':'.join([commit, 'other/' + path, rule, line])),
                            dict(original, fingerprint=':'.join([commit, path, rule, str(int(line)+1)])),
                            dict(original, fingerprint=':'.join([commit, path, 'private-key', line])),
                            dict(original, kinds=['ARTIFACT_DIGEST'])]
            for value in alternatives:
                with self.subTest(), self.assertRaises(ValueError):
                    reviewed.parse_records(self.config.replace(row, reviewed.PREFIX + json.dumps(value)))
            changed = original['fingerprint'].replace(commit, '0' * 40)
            with self.assertRaises(ValueError): reviewed.verify_integrity_metadata(ROOT, changed, self.text)
        first = json.loads(rows[0][len(reviewed.PREFIX):]); first['kinds'] = [reviewed.INTEGRITY_KIND]
        with self.assertRaises(ValueError):
            reviewed.parse_records(self.config.replace(rows[0], reviewed.PREFIX + json.dumps(first)))

    def test_removed_duplicate_extra_or_reordered_records_are_rejected(self):
        rows = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)]
        for text in [self.config.replace(rows[734] + '\n', '').replace('count: 737','count: 736'),
                     self.config.replace(rows[734], rows[735]),
                     self.config.replace('count: 737','count: 738') + rows[734] + '\n',
                     self.config.replace(rows[733] + '\n', rows[733] + ' \n')]:
            with self.subTest(), self.assertRaises(ValueError): reviewed.parse_records(text)

    def test_changed_artifact_git_binding_line_context_or_origin_is_rejected(self):
        fingerprint = next(iter(reviewed.INTEGRITY_FINDINGS))
        with self.assertRaises(ValueError): reviewed.verify_integrity_metadata(ROOT, fingerprint, self.text + '\n')
        with patch.object(reviewed, 'run', return_value=b'0' * 40 + b'\n'), self.assertRaises(ValueError):
            reviewed.verify_integrity_metadata(ROOT, fingerprint, self.text)
        with patch.object(reviewed, 'INTEGRITY_CONTEXT_SHA256', '0' * 64), self.assertRaises(ValueError):
            reviewed.verify_integrity_metadata(ROOT, fingerprint, self.text)
        for fp, spec in reviewed.INTEGRITY_FINDINGS.items():
            with self.subTest(), patch.dict(spec, sha256='0' * 64), self.assertRaises(ValueError):
                reviewed.verify_integrity_metadata(ROOT, fp, self.text)
        real_run = reviewed.run
        def altered_origin(args, **options):
            value = real_run(args, **options)
            return value + b' ' if args[:3] == ['git','cat-file','blob'] else value
        with patch.object(reviewed, 'run', side_effect=altered_origin), self.assertRaises(ValueError):
            reviewed.verify_integrity_metadata(ROOT, fingerprint, self.text)

    def test_even_repinning_cannot_admit_an_authentication_use_or_wrong_digest(self):
        tree = ast.parse(self.text)
        for fp, spec in reviewed.INTEGRITY_FINDINGS.items():
            number = int(fp.rsplit(':',1)[1])
            assignment = next(node for node in tree.body if isinstance(node,ast.Assign) and node.lineno == number)
            symbol = assignment.targets[0].id
            text = self.text + '\nheaders = {"Authorization": ' + symbol + '}\n'
            raw = text.encode(); pin = {'blob':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest(),
                                       'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
            real_run = reviewed.run
            def route(args, **options):
                if args[:2] == ['git','rev-parse'] and args[-1] == reviewed.INTEGRITY_COMMIT+':'+reviewed.INTEGRITY_PATH:
                    return pin['blob'].encode()+b'\n'
                return real_run(args, **options)
            with self.subTest(), patch.dict(reviewed.INTEGRITY_BLOB,pin), patch.object(reviewed,'run',side_effect=route), \
                    self.assertRaisesRegex(ValueError,'usage changed'):
                reviewed.verify_integrity_metadata(ROOT,fp,text)
            lines = self.text.splitlines(keepends=True)
            value = assignment.value.value
            lines[number - 1] = symbol + ' = ' + json.dumps('0' * len(value)) + '\n'
            text = ''.join(lines); raw = text.encode()
            pin = {'blob':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest(),
                   'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
            row_sha = hashlib.sha256(lines[number-1].encode()).hexdigest()
            context_sha = hashlib.sha256(''.join(lines[73:83]).encode()).hexdigest()
            with self.subTest(derivation=number), patch.dict(reviewed.INTEGRITY_BLOB,pin), \
                    patch.dict(spec,sha256=row_sha), patch.object(reviewed,'INTEGRITY_CONTEXT_SHA256',context_sha), \
                    patch.object(reviewed,'run',side_effect=route), self.assertRaisesRegex(ValueError,'derivation changed'):
                reviewed.verify_integrity_metadata(ROOT,fp,text)


if __name__ == '__main__':
    unittest.main()
