import base64
import copy
import hashlib
import importlib.util
import json
import subprocess
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
        self.assertEqual(len(records), 533)
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
        for changed in [self.config.replace('# clued-reviewed-count: 533', '# clued-reviewed-count: 532'),
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


if __name__ == '__main__':
    unittest.main()
