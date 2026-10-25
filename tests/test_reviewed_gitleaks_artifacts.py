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
        self.assertEqual(len(records), 730)
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
        for changed in [self.config.replace('# clued-reviewed-count: 730', '# clued-reviewed-count: 729'),
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
        self.assertEqual(len(records), 730)
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
        for row in self.rows()[726:]:
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
                   self.config.replace('# clued-reviewed-count: 730', '# clued-reviewed-count: 731') + fourth + '\n']
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


class RoleProbeExactFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.source33 = reviewed.run(['git', 'cat-file', 'blob',
                                    '4f45323938e5a6f9d775ac2958b743e739c7464d:.gitleaks.toml'], cwd=ROOT).decode()
        cls.fingerprint = next(iter(reviewed.ROLE_PROBE_FINDINGS))
        cls.text = reviewed.run(['git', 'cat-file', 'blob',
                                f'{reviewed.ROLE_PROBE_COMMIT}:{reviewed.ROLE_PROBE_PATH}'], cwd=ROOT).decode()

    def test_all_729_original_record_bytes_and_default_policy_are_preserved(self):
        rows = lambda text: [line for line in text.splitlines(keepends=True) if line.startswith(reviewed.PREFIX)]
        self.assertEqual(rows(self.config)[:729], rows(self.source33))
        self.assertEqual(hashlib.sha256(''.join(rows(self.config)[:729]).encode()).hexdigest(),
                         reviewed.SOURCE33_RECORD_LINES_SHA256)
        self.assertEqual(reviewed.tomllib.loads(self.config), reviewed.tomllib.loads(self.source33))
        records = reviewed.parse_records(self.config)
        self.assertEqual(len(records), 730)
        self.assertEqual({r['fingerprint'] for r in records[729:]}, {self.fingerprint})
        self.assertEqual(records[729]['kinds'], ['SYNTHETIC_ROLE_PROBE_TOKEN'])

    def test_source33_record_format_and_order_cannot_change(self):
        rows = [line for line in self.config.splitlines() if line.startswith(reviewed.PREFIX)]
        formatted = rows[726].replace('{"fingerprint":', '{"fingerprint": ', 1)
        for changed in [self.config.replace(rows[726], formatted, 1),
                        self.config.replace(rows[726] + '\n' + rows[727], rows[727] + '\n' + rows[726], 1)]:
            with self.subTest(), self.assertRaisesRegex(ValueError, 'Source33 reviewed finding bytes changed'):
                reviewed.parse_records(changed)

    def test_new_identity_and_kind_are_exact_and_cannot_be_borrowed(self):
        row = next(line for line in self.config.splitlines() if self.fingerprint in line)
        record = json.loads(row[len(reviewed.PREFIX):])
        commit, path, rule, line = self.fingerprint.split(':')
        changes = [dict(record, fingerprint=':'.join([commit, path, rule, '74'])),
                   dict(record, fingerprint=':'.join(['0' * 40, path, rule, line])),
                   dict(record, fingerprint=':'.join([commit, 'work/other.test.mjs', rule, line])),
                   dict(record, fingerprint=':'.join([commit, path, 'sourcegraph-access-token', line])),
                   dict(record, kinds=['SYNTHETIC_TEST_TOKEN']), dict(record, kinds=['ARTIFACT_DIGEST'])]
        for value in changes:
            with self.subTest(), self.assertRaises(ValueError):
                reviewed.parse_records(self.config.replace(row, reviewed.PREFIX + json.dumps(value, separators=(',', ':')), 1))

    def test_actual_immutable_blob_line_and_mocked_use_are_verified(self):
        reviewed.verify_role_probe_fixture(ROOT, self.fingerprint, self.text)

    def test_new_commit_other_path_and_other_line_cannot_use_the_proof(self):
        for changed in [self.fingerprint.replace(reviewed.ROLE_PROBE_COMMIT, '0' * 40),
                        self.fingerprint.replace(reviewed.ROLE_PROBE_PATH, 'work/other.test.mjs'),
                        self.fingerprint[:-2] + '74']:
            with self.subTest(), self.assertRaisesRegex(ValueError, 'Unreviewed role-probe fixture identity'):
                reviewed.verify_role_probe_fixture(ROOT, changed, self.text)

    def test_modified_blob_or_git_binding_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'immutable blob changed'):
            reviewed.verify_role_probe_fixture(ROOT, self.fingerprint, self.text + '\n')
        with patch.object(reviewed, 'run', return_value=b'0' * 40 + b'\n'):
            with self.assertRaisesRegex(ValueError, 'immutable blob changed'):
                reviewed.verify_role_probe_fixture(ROOT, self.fingerprint, self.text)

    def test_end_line_span_and_use_span_pins_are_enforced(self):
        spec = reviewed.ROLE_PROBE_FINDINGS[self.fingerprint]
        for changed in [dict(spec, end_line=74), dict(spec, span_bytes=spec['span_bytes'] + 1),
                        dict(spec, span_sha256='0' * 64)]:
            with self.subTest(), patch.dict(reviewed.ROLE_PROBE_FINDINGS, {self.fingerprint: changed}):
                with self.assertRaisesRegex(ValueError, 'exact span changed'):
                    reviewed.verify_role_probe_fixture(ROOT, self.fingerprint, self.text)
        with patch.dict(reviewed.ROLE_PROBE_USE, {'sha256': '0' * 64}):
            with self.assertRaisesRegex(ValueError, 'use span changed'):
                reviewed.verify_role_probe_fixture(ROOT, self.fingerprint, self.text)

    def test_mocked_fetch_and_same_token_pin_are_independent_use_requirements(self):
        # Rebind the immutable test pins only in this negative unit fixture to reach
        # the semantic use check: neither real fetch nor a different pin expression qualifies.
        variants = [self.text.replace('fetchImpl: async (...v) => { native.push(v);',
                                      'fetchImpl: async (...v) => { await fetch(...v); native.push(v);', 1),
                    self.text.replace("\\0' + token)", "\\0' + digest(token))", 1)]
        for text in variants:
            self.assertNotEqual(text, self.text)
            raw = text.encode(); blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            pin = {'blob': blob, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
            use = ''.join(text.splitlines(keepends=True)[71:82]).encode()
            with self.subTest(), patch.dict(reviewed.ROLE_PROBE_BLOB, pin), \
                    patch.dict(reviewed.ROLE_PROBE_USE, {'bytes': len(use), 'sha256': hashlib.sha256(use).hexdigest()}), \
                    patch.object(reviewed, 'run', return_value=(blob + '\n').encode()):
                with self.assertRaisesRegex(ValueError, 'mocked token use changed'):
                    reviewed.verify_role_probe_fixture(ROOT, self.fingerprint, text)


if __name__ == '__main__':
    unittest.main()
