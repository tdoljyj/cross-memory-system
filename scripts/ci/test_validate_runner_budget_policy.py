from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "runner_budget_policy", Path(__file__).with_name("validate_runner_budget_policy.py")
)
policy = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(policy)

SELF_HOSTED = "[self-hosted, Linux, X64, clued, pool-general, trust-internal]"
PREFIX = """name: fixture
on:
  pull_request:
permissions:
  contents: read
concurrency:
  group: fixture
  cancel-in-progress: true
jobs:
"""


def job(name="check", runner=SELF_HOSTED):
    return f"""  {name}:
    runs-on: {runner}
    timeout-minutes: 3
    steps:
      - run: echo bounded
"""


def frozen(text, name="legacy.yml"):
    control, jobs, _ = policy.split_workflow(text)
    return {name: {"control_sha256": policy.source_hash(control),
                   "jobs": {key: policy.source_hash(value) for key, value in jobs.items()
                            if policy.classify_route(name, key, policy.job_fields(value))[0] != "self-hosted"}}}


class RunnerBudgetPolicyTests(unittest.TestCase):
    def evaluate(self, texts, baseline=None):
        return policy.evaluate_workflows(texts, {} if baseline is None else baseline)

    def assert_pass(self, report):
        self.assertEqual(report["violations"], [], report["violations"])
        self.assertEqual(report["status"], "PASS")

    def assert_rejected(self, report, reason):
        self.assertEqual(report["status"], "FAIL")
        self.assertTrue(any(reason in row["reason"] for row in report["violations"]),
                        report["violations"])

    def test_new_hosted_is_rejected_including_old_documentation_names(self):
        for name in ["unapproved.yml", "clued-ci-health.yml"]:
            for runner in ["ubuntu-slim", "'ubuntu-slim'", '"ubuntu-latest"',
                           "ubuntu-24.04", "windows-2025", "macos-15"]:
                with self.subTest(name=name, runner=runner):
                    self.assert_rejected(self.evaluate({name: PREFIX + job(runner=runner)}),
                                         "new GitHub-hosted")
        self.assertIn("clued-ci-health.yml", policy.HOSTED_ONLY_ALLOWLIST)

    def test_new_hosted_cannot_hide_in_a_mixed_workflow(self):
        text = PREFIX + job("local") + job("paid", "ubuntu-latest")
        report = self.evaluate({"mixed.yml": text})
        self.assert_rejected(report, "new GitHub-hosted")
        self.assertEqual(report["violations"][0]["job"], "paid")

    def test_new_unknown_dynamic_and_fallback_routes_are_rejected(self):
        expression = "$" + "{{ vars.RUNNER }}"
        routes = [expression, "$" + "{{ matrix.runner }}",
                  "$" + "{{ vars.LOCAL && 'self-hosted' || 'ubuntu-latest' }}",
                  "[self-hosted, Linux, trust-internal, ubuntu-latest]",
                  "[self-hosted, Linux, trust-internal, '" + expression + "']",
                  "{group: trusted, labels: [self-hosted, trust-internal]}",
                  "custom-unknown-runner", "[]"]
        for runner in routes:
            with self.subTest(runner=runner):
                self.assert_rejected(self.evaluate({"dynamic.yml": PREFIX + job(runner=runner)}),
                                     "unknown, dynamic")

    def test_reusable_and_missing_routes_refuse(self):
        for text in [PREFIX + "  hidden:\n    uses: owner/repo/.github/workflows/ci.yml@main\n",
                     PREFIX + "  hidden:\n    steps:\n      - run: echo hidden\n"]:
            self.assert_rejected(self.evaluate({"hidden.yml": text}), "unknown, dynamic")

    def test_literal_self_hosted_new_job_and_multiline_labels_pass(self):
        self.assert_pass(self.evaluate({"new.yml": PREFIX + job()}))
        text = PREFIX + job(runner="\n      - self-hosted\n      - Linux\n      - trust-internal")
        self.assert_pass(self.evaluate({"new.yml": text}))

    def test_each_self_hosted_job_needs_its_own_trust_boundary(self):
        text = PREFIX + job("safe") + job("unsafe", "[self-hosted, Linux]")
        report = self.evaluate({"local.yml": text})
        self.assert_rejected(report, "literal trust-internal")
        self.assertEqual(report["violations"][0]["job"], "unsafe")

    def test_self_hosted_pr_requires_concurrency_and_cancel(self):
        for before, after, reason in [
            ("concurrency:\n  group: fixture\n  cancel-in-progress: true\n", "", "top-level concurrency"),
            ("  cancel-in-progress: true\n", "", "cancel-in-progress"),
        ]:
            text = (PREFIX + job()).replace(before, after)
            self.assert_rejected(self.evaluate({"new.yml": text}), reason)
        text = PREFIX.replace("on:\n  pull_request:", "on: [pull_request]") + job()
        self.assert_pass(self.evaluate({"new.yml": text}))
        self.assert_rejected(self.evaluate({"new.yml": text.replace("  cancel-in-progress: true\n", "")}),
                             "cancel-in-progress")

    def test_legacy_job_is_exact_debt_and_crlf_is_equivalent(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        for version in [text, text.replace("\n", "\r\n")]:
            self.assert_pass(self.evaluate({"legacy.yml": version}, debt))

    def test_new_job_cannot_borrow_an_old_legacy_workflow_entry(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        self.assert_rejected(self.evaluate({"legacy.yml": text + job("extra", "ubuntu-latest")}, debt),
                             "new GitHub-hosted")
        self.assert_pass(self.evaluate({"legacy.yml": text + job("extra")}, debt))

    def test_only_exact_legacy_state_change_expression_survives(self):
        text = PREFIX + job(runner=policy.STATE_CHANGE_RUNNER)
        debt = frozen(text)
        self.assert_pass(self.evaluate({"legacy.yml": text}, debt))
        self.assert_rejected(self.evaluate({"new.yml": text}), "new GitHub-hosted")
        changed = text.replace("'state_change'", "'any_reason'")
        self.assert_rejected(self.evaluate({"legacy.yml": changed}, debt), "unknown, dynamic")

    def test_legacy_job_work_timeout_route_or_matrix_cannot_expand(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        changes = [
            text.replace("echo bounded", "while true; do echo paid; done"),
            text.replace("timeout-minutes: 3", "timeout-minutes: 30"),
            text.replace("ubuntu-slim", "ubuntu-latest"),
            text.replace("    timeout-minutes: 3", "    strategy:\n      matrix:\n        shard: [1, 2, 3]\n    timeout-minutes: 3"),
        ]
        for changed in changes:
            with self.subTest(changed=changed):
                self.assert_rejected(self.evaluate({"legacy.yml": changed}, debt),
                                     "legacy hosted job changed")

    def test_legacy_trigger_permissions_concurrency_and_env_are_frozen(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        changes = [
            text.replace("  pull_request:", "  pull_request:\n  schedule:\n    - cron: '* * * * *'"),
            text.replace("contents: read", "contents: write"),
            text.replace("group: fixture", "group: unique-per-run"),
            text.replace("permissions:", "env:\n  MORE_WORK: true\npermissions:"),
        ]
        for changed in changes:
            with self.subTest(changed=changed):
                self.assert_rejected(self.evaluate({"legacy.yml": changed}, debt),
                                     "legacy hosted workflow controls changed")

    def test_migration_must_remove_debt_in_same_change(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        migrated = text.replace("ubuntu-slim", SELF_HOSTED)
        self.assert_rejected(self.evaluate({"legacy.yml": migrated}, debt),
                             "migrated hosted debt entry must be deleted")
        self.assert_pass(self.evaluate({"legacy.yml": migrated}, {}))
        self.assert_rejected(self.evaluate({"legacy.yml": text}, {}), "new GitHub-hosted")

    def test_deletion_must_remove_debt_and_restoration_is_not_grandfathered(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        self.assert_rejected(self.evaluate({}, debt), "removed hosted debt entry must be deleted")
        self.assert_pass(self.evaluate({}, {}))
        self.assert_rejected(self.evaluate({"legacy.yml": text}), "new GitHub-hosted")

    def test_malformed_or_empty_workflow_debt_fails_closed(self):
        text = PREFIX + job(runner="ubuntu-slim")
        debt = frozen(text)
        for invalid in [[], {"legacy.yml": {"control_sha256": "0" * 64, "jobs": {}}},
                        {"legacy.yml": {"control_sha256": "bad", "jobs": {"check": "0" * 64}}},
                        {"legacy.yml": {**debt["legacy.yml"], "extra": True}}]:
            with self.subTest(invalid=invalid):
                self.assert_rejected(self.evaluate({"legacy.yml": text}, invalid), "legacy")

    def test_ambiguous_yaml_cannot_hide_execution(self):
        variants = [
            PREFIX.replace("jobs:", '"jobs":') + job(),
            PREFIX + job() + job(),
            PREFIX + job().replace("    runs-on:", '    "runs-on":'),
            PREFIX + job().replace("    timeout-minutes: 3", "    runs-on: ubuntu-latest"),
            PREFIX + job() + "on:\n  schedule:\n    - cron: '* * * * *'\n",
            PREFIX + job().replace("    timeout-minutes: 3", "    <<: *hidden"),
            PREFIX + job().replace("    timeout-minutes: 3", "\t timeout-minutes: 3"),
            PREFIX + job().replace("    timeout-minutes: 3", "\u2028    runs-on: ubuntu-latest"),
            PREFIX.replace("name: fixture", "name: fixture\npermissions:\n  contents: write") + job(),
        ]
        for text in variants:
            with self.subTest(text=text):
                self.assertEqual(self.evaluate({"hidden.yml": text})["status"], "FAIL")

    def test_existing_matrix_route_does_not_authorize_a_new_dynamic_job(self):
        filename = "clued-ci-runner-heartbeat.yml"
        text = (policy.WORKFLOW_DIR / filename).read_text(encoding="utf-8")
        self.assert_pass(self.evaluate({filename: text}))
        changed = text.replace("matrix.site_label", "vars.NEW_ROUTE")
        self.assert_rejected(self.evaluate({filename: changed}), "unknown, dynamic")
        renamed = text.replace("  windows-route:", "  newly-dynamic-route:")
        self.assert_rejected(self.evaluate({filename: renamed}), "unknown, dynamic")

    def test_current_repository_workflows_and_embedded_schema_pass(self):
        self.assertEqual(policy.baseline_findings(policy.LEGACY_HOSTED_DEBT), [])
        texts = {p.name: p.read_text(encoding="utf-8")
                 for p in policy.WORKFLOW_DIR.glob("*.yml")}
        self.assertTrue(texts)
        report = policy.evaluate_workflows(texts)
        self.assert_pass(report)
        actual_debt = sum(row["legacy_migration_debt"]
                          for workflow in report["workflows"] for row in workflow["jobs"])
        self.assertEqual(actual_debt, report["legacy_debt_jobs"])

    def test_real_three_push_reuse_migrations_require_debt_retirement(self):
        texts = {p.name: p.read_text(encoding="utf-8")
                 for p in policy.WORKFLOW_DIR.glob("*.yml")}
        debt = copy.deepcopy(policy.LEGACY_HOSTED_DEBT)
        names = ["clued-connection-authorization.yml", "clued-g4-database.yml",
                 "information-flow-e2e.yml"]
        for filename in names:
            _, jobs, _ = policy.split_workflow(texts[filename])
            block = jobs["push-reuse"]
            fields = policy.job_fields(block)
            kind, _ = policy.classify_route(filename, "push-reuse", fields)
            if kind == "hosted":
                migrated = block.replace("    runs-on: ubuntu-slim",
                                         "    runs-on: " + SELF_HOSTED)
                texts[filename] = texts[filename].replace(block, migrated)
                del debt[filename]["jobs"]["push-reuse"]
                if not debt[filename]["jobs"]:
                    del debt[filename]
            else:
                self.assertEqual(kind, "self-hosted")
                self.assertNotIn("push-reuse", debt.get(filename, {}).get("jobs", {}))
        self.assert_pass(policy.evaluate_workflows(texts, debt))
        for filename in names:
            _, jobs, _ = policy.split_workflow(texts[filename])
            block = jobs["push-reuse"]
            restored = block.replace("    runs-on: " + SELF_HOSTED,
                                     "    runs-on: ubuntu-slim")
            reverted = {**texts, filename: texts[filename].replace(block, restored)}
            self.assert_rejected(policy.evaluate_workflows(reverted, debt),
                                 "new GitHub-hosted")

    def test_main_empty_directory_fails_closed(self):
        with patch.object(policy, "WORKFLOW_DIR", Path(__file__).with_name("absent-workflows")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = policy.main()
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(output.getvalue())["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
