from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'runner_budget_policy', Path(__file__).with_name('validate_runner_budget_policy.py')
)
policy = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(policy)


class RunnerBudgetPolicyTests(unittest.TestCase):
    def evaluate(self, filename: str, runner: str):
        with tempfile.TemporaryDirectory() as directory:
            workflows = Path(directory)
            (workflows / filename).write_text(
                f'name: fixture\non:\n  workflow_dispatch:\njobs:\n  check:\n    runs-on: {runner}\n',
                encoding='utf-8',
            )
            output = io.StringIO()
            with patch.object(policy, 'WORKFLOW_DIR', workflows), contextlib.redirect_stdout(output):
                exit_code = policy.main()
            return exit_code, json.loads(output.getvalue())

    def test_slim_cannot_bypass_hosted_only_allowlist(self):
        for runner in ['ubuntu-slim', "'ubuntu-slim'", '"ubuntu-slim"']:
            with self.subTest(runner=runner):
                code, report = self.evaluate('unapproved.yml', runner)
                self.assertEqual(code, 1)
                self.assertEqual(report['status'], 'FAIL')
                self.assertTrue(report['workflows'][0]['hosted'])
                self.assertIn('explicit allowlist', report['violations'][0]['reason'])

    def test_slim_is_classified_and_admitted_for_existing_exception(self):
        code, report = self.evaluate('clued-ci-health.yml', 'ubuntu-slim')
        self.assertEqual(code, 0)
        self.assertEqual(report['status'], 'PASS')
        row = report['workflows'][0]
        self.assertTrue(row['hosted'])
        self.assertTrue(row['hosted_only_allowlisted'])
        self.assertFalse(row['self_hosted'])

    def test_conditional_state_change_runner_is_still_hosted(self):
        runner = "${{ inputs.reason == 'state_change' && 'ubuntu-latest' || 'ubuntu-slim' }}"
        code, report = self.evaluate('clued-work-admission-reverify.yml', runner)
        self.assertEqual(code, 0)
        self.assertTrue(report['workflows'][0]['hosted_only_allowlisted'])
        code, report = self.evaluate('unapproved.yml', runner)
        self.assertEqual(code, 1)
        self.assertEqual(len(report['violations']), 1)

    def test_existing_runner_labels_remain_classified(self):
        for runner in ['ubuntu-latest', 'ubuntu-24.04', 'windows-2025', 'macos-15']:
            with self.subTest(runner=runner):
                code, report = self.evaluate('unapproved.yml', runner)
                self.assertEqual(code, 1)
                self.assertTrue(report['workflows'][0]['hosted'])
        code, report = self.evaluate('trusted.yml', '[self-hosted, Linux, X64, trust-internal]')
        self.assertEqual(code, 0)
        self.assertTrue(report['workflows'][0]['self_hosted'])
        self.assertFalse(report['workflows'][0]['hosted'])


if __name__ == '__main__':
    unittest.main()
