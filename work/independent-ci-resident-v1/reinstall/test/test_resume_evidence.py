"""Half-uninstall evidence cannot authorize a different or already completed step."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('resume_evidence', Path(__file__).resolve().parents[1] / 'launcher/resume-evidence.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SOURCE, HEAD = 'a' * 40, 'b' * 40


def fixture():
    return {'contract': 'clued.independent-ci.source-v2-windows-launch-terminal/1',
            'status': 'STOPPED', 'code': 'UNINSTALL_NOT_COMPLETED', 'sourceSha': SOURCE, 'packageHead': HEAD,
            'completed': ['output', 'package', 'stage', 'uninstall-preflight', 'parent-acl-checked', 'quiesce'],
            'detail': {'dryRun': {'exit': 0, 'status': 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', 'planSha256': 'c' * 64,
                                  'plan': {'contract': 'clued.independent-ci.resident-uninstall-plan/3',
                                           'openBatches': 0, 'upgraderService': True, 'upgradeOpState': None,
                                           'executorAlive': False, 'runnerOriginalStopped': True,
                                           'runnerSddlUnchanged': True, 'deletesEvidence': False,
                                           'renameTo': 'resident-uninstalled-<UTC>-<hex>'}},
                       'apply': {'exit': 1, 'status': None, 'keptAt': ''},
                       'after': {'residentRootExists': True, 'processesUnderRoot': []}}}


def validated(value):
    raw = json.dumps(value).encode()
    return MODULE.validate_terminal(raw, hashlib.sha256(raw).hexdigest(), SOURCE, HEAD)


class ResumeEvidence(unittest.TestCase):
    def test_exact_failed_boundary_keeps_original_subject_and_plan(self):
        result = validated(fixture())
        self.assertEqual((result['sourceSha'], result['packageHead'], result['uninstallPlanSha256']), (SOURCE, HEAD, 'c' * 64))

    def test_modified_bytes_cannot_reuse_reviewed_digest(self):
        raw = json.dumps(fixture()).encode()
        with self.assertRaisesRegex(ValueError, 'PRIOR_TERMINAL_CHANGED'):
            MODULE.validate_terminal(raw + b' ', hashlib.sha256(raw).hexdigest(), SOURCE, HEAD)

    def test_other_subject_or_terminal_code_refused(self):
        for key, value in [('sourceSha', 'd' * 40), ('packageHead', 'e' * 40), ('code', 'LAUNCHER_EXCEPTION'), ('status', 'COMPLETED')]:
            with self.subTest(key=key):
                doc = fixture(); doc[key] = value
                with self.assertRaisesRegex(ValueError, 'PRIOR_TERMINAL_NOT_THE_FAILED_UNINSTALL'):
                    validated(doc)

    def test_manifest_digest_cannot_be_used_as_git_source_commit(self):
        doc = fixture(); doc['sourceSha'] = 'a' * 64
        raw = json.dumps(doc).encode()
        with self.assertRaisesRegex(ValueError, 'RESUME_SUBJECT_INVALID'):
            MODULE.validate_terminal(raw, hashlib.sha256(raw).hexdigest(), 'a' * 64, HEAD)

    def test_missing_reordered_or_later_steps_refused(self):
        done = fixture()['completed']
        for steps in [done[:-1], done + ['uninstall'], done + ['install'], done[::-1], done + ['quiesce']]:
            with self.subTest(steps=steps):
                doc = fixture(); doc['completed'] = steps
                with self.assertRaisesRegex(ValueError, 'PRIOR_UNINSTALL_STEP_BOUNDARY'):
                    validated(doc)

    def test_no_open_batch_or_running_upgrade_or_weakened_runner_proof(self):
        for key, value in [('openBatches', 1), ('openBatches', False), ('executorAlive', True),
                           ('runnerOriginalStopped', False), ('runnerSddlUnchanged', False),
                           ('deletesEvidence', True), ('upgraderService', False), ('upgradeOpState', 'RUNNING')]:
            with self.subTest(key=key, value=value):
                doc = fixture(); doc['detail']['dryRun']['plan'][key] = value
                with self.assertRaisesRegex(ValueError, 'PRIOR_UNINSTALL_PLAN_REFUSED'):
                    validated(doc)
        doc = fixture(); del doc['detail']['dryRun']['plan']['upgradeOpState']
        with self.assertRaisesRegex(ValueError, 'PRIOR_UNINSTALL_PLAN_REFUSED'):
            validated(doc)

    def test_completed_or_indeterminate_uninstall_never_repeated(self):
        for key, value in [('exit', 0), ('exit', True), ('exit', None), ('keptAt', r'C:\kept'),
                           ('status', 'RESIDENT_UNINSTALLED_EVIDENCE_KEPT')]:
            with self.subTest(key=key):
                doc = fixture(); doc['detail']['apply'][key] = value
                with self.assertRaisesRegex(ValueError, 'PRIOR_UNINSTALL_ALREADY_COMPLETED_OR_UNKNOWN'):
                    validated(doc)

    def test_no_root_or_process_still_running_is_not_finish_rename_evidence(self):
        for after in [{'residentRootExists': False, 'processesUnderRoot': []},
                      {'residentRootExists': True, 'processesUnderRoot': [{'pid': 123}]}]:
            doc = fixture(); doc['detail']['after'] = after
            with self.assertRaisesRegex(ValueError, 'PRIOR_UNINSTALL_ROOT_NOT_QUIET'):
                validated(doc)


if __name__ == '__main__':
    unittest.main()
