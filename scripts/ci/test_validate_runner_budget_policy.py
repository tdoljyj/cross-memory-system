from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import hashlib
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


# The final step of each hosted executor (design 4.3): only after every step
# before it succeeded, a GitHub OIDC identity for the App 5368905 relay.
RELAY_STEP = """      - name: Emit relay identity
        run: |
          set -eu
          jwt="$(curl -fsS --max-time 30 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=clued-hosted-relay-v1" \\
            | python3 -I -B -c 'import json,sys; print(json.load(sys.stdin)["value"])')"
          echo "::notice title=clued-hosted-relay-v1::$jwt"
"""
HOSTED_EXECUTOR_ROUTE = "    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:"


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


def publisher_qualification_text(filename):
    installed = policy.WORKFLOW_DIR / filename
    if installed.exists():
        return installed.read_text(encoding="utf-8")
    # The Guest workflow is installed only after a trusted runner can take it.
    # Keep all route negatives on its exact full, registered Source in the meantime.
    if filename != "clued-production-publisher-guest-qualification.yml":
        raise AssertionError("Only the uninstalled Guest Source may use the catalogue")
    registry = json.loads(Path(__file__).with_name("clued-publisher-qualification-sources.json").read_text(encoding="utf-8"))
    entry = registry["workflows"][".github/workflows/" + filename]
    assert entry["registration_status"] == "registered"
    expected = "2c96918d9a14bbadca4a5e247bafcf741290a3ee2c75d13e2acacc800b04ad44"
    source = next(row for row in entry["sources"] if row["source_sha256"] == expected)
    assert source["registration_status"] == "registered"
    assert source["proof_classification"] == "qualification_only"
    text = source["source_yaml"]
    assert hashlib.sha256(text.encode("utf-8")).hexdigest() == expected
    return text


class RunnerBudgetPolicyTests(unittest.TestCase):
    def evaluate(self, texts, baseline=None, owner_hosted=None):
        return policy.evaluate_workflows(texts, {} if baseline is None else baseline,
                                         {} if owner_hosted is None else owner_hosted)

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

    def test_actual_disposable_publisher_qualification_route_passes(self):
        filename = "clued-production-publisher-guest-qualification.yml"
        text = publisher_qualification_text(filename)
        self.assert_pass(self.evaluate({filename: text}))
        _, jobs, _ = policy.split_workflow(text)
        kind, labels = policy.classify_route(filename, "qualify", policy.job_fields(jobs["qualify"]))
        self.assertEqual(kind, "self-hosted")
        self.assertEqual(labels, ["self-hosted", "Linux", "X64", "clued-production-publisher-v1",
                                 "${{ format('clued-publisher-{0}-{1}', github.run_id, github.run_attempt) }}"])
        self.assertNotIn("trust-internal", labels)

    def test_disposable_publisher_route_cannot_move_workflow_or_job(self):
        filename = "clued-production-publisher-guest-qualification.yml"
        text = publisher_qualification_text(filename)
        for other in ["other.yml", "clued-production-publisher-qualification.yml",
                      "clued-production-publisher-guest-qualification.yaml"]:
            with self.subTest(workflow=other):
                self.assert_rejected(self.evaluate({other: text}), "unknown, dynamic")
        for other in ["qualify-shadow", "host-principal-probe-renamed"]:
            with self.subTest(job=other):
                changed = text.replace("  qualify:\n", f"  {other}:\n")
                self.assert_rejected(self.evaluate({filename: changed}), "unknown, dynamic")

    def test_disposable_publisher_route_requires_exact_labels_and_expression(self):
        filename = "clued-production-publisher-guest-qualification.yml"
        text = publisher_qualification_text(filename)
        original = policy.job_fields(policy.split_workflow(text)[1]["qualify"])["runs-on"]
        changes = [
            original.replace("self-hosted, ", ""),
            original.replace("Linux", "Windows"),
            original.replace("X64", "ARM64"),
            original.replace("clued-production-publisher-v1", "clued-production-publisher-v2"),
            original.replace("clued-production-publisher-v1, ", "clued-production-publisher-v1, trust-internal, "),
            original.replace("clued-production-publisher-v1, ", "clued-production-publisher-v1, ubuntu-latest, "),
            original.replace("github.run_id", "github.run_number"),
            original.replace("github.run_attempt", "inputs.run_attempt"),
            original.replace("clued-publisher-{0}-{1}", "clued-publisher-{1}-{0}"),
            original.replace("github.run_attempt)", "github.run_attempt )"),
            original.replace("${{ format('clued-publisher-{0}-{1}', github.run_id, github.run_attempt) }}",
                             "${{ vars.LOCAL && 'self-hosted' || 'ubuntu-latest' }}"),
            "[self-hosted, Linux, X64, clued-production-publisher-v1, trust-internal]",
        ]
        for changed in changes:
            with self.subTest(route=changed):
                self.assertNotEqual(changed, original)
                self.assert_rejected(self.evaluate({filename: text.replace(original, changed)}), "unknown, dynamic")

    def test_disposable_publisher_route_does_not_authorize_reusable_or_hosted_jobs(self):
        filename = "clued-production-publisher-guest-qualification.yml"
        text = publisher_qualification_text(filename)
        original = policy.job_fields(policy.split_workflow(text)[1]["qualify"])["runs-on"]
        self.assert_rejected(self.evaluate({filename: text.replace(original, "ubuntu-latest")}),
                             "new GitHub-hosted")
        self.assert_rejected(self.evaluate({filename: text.replace(
            "  qualify:\n", "  qualify:\n    uses: owner/repo/.github/workflows/ci.yml@main\n")}),
            "unknown, dynamic")
        added = text + job("unrelated", "[self-hosted, Linux, X64, clued-production-publisher-v1]")
        self.assert_rejected(self.evaluate({filename: added}), "literal trust-internal")

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
        actual_owner = sum(row["owner_decision_hosted"]
                           for workflow in report["workflows"] for row in workflow["jobs"])
        self.assertEqual(actual_owner, report["owner_decision_hosted_jobs"])

    def test_owner_decision_325717a6_names_exactly_the_hosted_executor_jobs(self):
        self.assertEqual(policy.OWNER_DECISION_HOSTED_SOURCE, "325717a6")
        self.assertEqual(policy.owner_decision_findings(policy.OWNER_DECISION_HOSTED_JOBS,
                                                        policy.LEGACY_HOSTED_DEBT), [])
        pairs = {(file, job) for file, entry in policy.OWNER_DECISION_HOSTED_JOBS.items()
                 for job in entry["jobs"]}
        self.assertEqual(pairs, {
            ("gitleaks.yml", "admission-gate"), ("gitleaks.yml", "gitleaks-trusted-self-hosted"),
            ("trivy.yml", "admission-gate"), ("trivy.yml", "trivy-trusted-self-hosted"),
            ("contract-placement.yml", "admission-gate"), ("contract-placement.yml", "contract-placement"),
        })
        # The jobs it replaced left the debt baseline in the same change.
        for file, job in [("gitleaks.yml", "gitleaks-untrusted-hosted"), ("trivy.yml", "trivy-untrusted-hosted"),
                          ("contract-placement.yml", "contract-placement")]:
            self.assertNotIn(job, policy.LEGACY_HOSTED_DEBT.get(file, {}).get("jobs", {}))
        texts = {p.name: p.read_text(encoding="utf-8") for p in policy.WORKFLOW_DIR.glob("*.yml")}
        report = policy.evaluate_workflows(texts)
        self.assert_pass(report)
        routes = {(w["workflow"], row["job"]): row for w in report["workflows"] for row in w["jobs"]}
        for pair in pairs:
            self.assertEqual(routes[pair]["kind"], "hosted", pair)
            self.assertTrue(routes[pair]["owner_decision_hosted"], pair)
            self.assertFalse(routes[pair]["legacy_migration_debt"], pair)
        self.assertEqual(sum(row["owner_decision_hosted"] for row in routes.values()), 6)

    def test_hosted_executors_never_carry_a_required_check_name(self):
        # Owner Decision bc6fdad1: a same-name hosted check run counts as the
        # required check even though the ruleset pins App 5368905.
        self.assertEqual(policy.REQUIRED_CHECK_NAMES, {
            "gitleaks", "trivy", "kooyumi-work-admission", "kooyumi-admission-verified",
            "kooyumi-merge-slot", "contract-placement"})
        expected = {
            ("gitleaks.yml", "gitleaks-trusted-self-hosted"): {"gitleaks-hosted-executor", "gitleaks-hosted-executor-skipped"},
            ("trivy.yml", "trivy-trusted-self-hosted"): {"trivy-hosted-executor", "trivy-hosted-executor-skipped"},
            ("contract-placement.yml", "contract-placement"): {"contract-placement-hosted-executor"},
        }
        for file, entry in policy.OWNER_DECISION_HOSTED_JOBS.items():
            _, jobs, _ = policy.split_workflow((policy.WORKFLOW_DIR / file).read_text(encoding="utf-8"))
            self.assertEqual(set(jobs), set(entry["jobs"]), file)
            for job_id, block in jobs.items():
                names = policy.job_check_names(job_id, policy.job_fields(block))
                with self.subTest(file=file, job=job_id):
                    self.assertFalse(names & policy.REQUIRED_CHECK_NAMES, names)
                    if (file, job_id) in expected:
                        self.assertTrue(expected[(file, job_id)] <= names, names)
                        fields = policy.job_fields(block)
                        self.assertEqual(fields["permissions"].split(), ["contents:", "read", "id-token:", "write"])
                        self.assertTrue(block.endswith(RELAY_STEP), file)
                        self.assertEqual(block.count("id-token"), 1)
                        # A PR-provided module can never shadow the stdlib of a step that holds id-token.
                        self.assertIn("python3 -I -B ", block)
                        self.assertNotRegex(block, r"python3? (?!-I -B )")
                        if file == "gitleaks.yml":
                            # The local role's input only: the trusted base checkout, a fresh history
                            # directory, the pinned config; never the PR working tree or .gitleaksignore.
                            self.assertIn("          ref: ${{ github.event.pull_request.base.sha || github.sha }}\n", block)
                            self.assertIn('--mount "type=bind,src=$scan/repo,dst=/repo,readonly,bind-propagation=rprivate"', block)
                            self.assertIn("git init --quiet --template=", block)
                            code = "\n".join(line for line in block.splitlines() if not line.lstrip().startswith("#"))
                            self.assertNotIn("$PWD", code)
                            self.assertNotIn(".gitleaksignore", code)
                            self.assertNotIn("fetch-depth", code)
                        if file == "trivy.yml":
                            self.assertIn("      - name: Refuse symlinks, submodules and other non-regular tree entries\n", block)
                            # The installed checks generation by digest; the mutable tag never downloads.
                            self.assertIn("CHECKS_DIGEST: sha256:b0e12d009b01dcc8ca2ebbc199b9caf3922491978d21c17b61c1d7f6dc75220b\n", block)
                            self.assertIn('--checks-bundle-repository "ghcr.io/aquasecurity/trivy-checks@$CHECKS_DIGEST"', block)
                            self.assertIn("grep -qziE '\\.(jar|war|ear|par)$'", block)
                            # Every scan mirrors the local role's container: offline, read-only, uid
                            # 65532, cwd /scratch, a read-only snapshot, prepared DB and checks only.
                            steps = {chunk.split("\n", 1)[0]: chunk for chunk in block.split("      - name: ")[1:]}
                            code = "\n".join(line for line in block.splitlines() if not line.lstrip().startswith("#"))
                            self.assertNotIn("$PWD", code)
                            self.assertNotIn("TRIVY_CACHE_DIR", code)
                            for scan, args in [
                                ("Vulnerabilities (HIGH/CRITICAL)", "fs --skip-db-update --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1"),
                                ("Secrets", "fs --scanners secret --exit-code 1"),
                                ("Misconfiguration (HIGH/CRITICAL)", "fs --checks-bundle-repository ghcr.io/aquasecurity/trivy-checks:2 --scanners misconfig --severity HIGH,CRITICAL --exit-code 1"),
                            ]:
                                step = " ".join(steps[scan].replace("\\\n", " ").split())
                                with self.subTest(scan=scan):
                                    for flag in ["--network=none", "--read-only", "--user=65532:65532", "--workdir=/scratch",
                                                 "dst=/repo,readonly", "dst=/scratch/db,readonly", "dst=/scratch/policy,readonly",
                                                 args + " --cache-dir /scratch --skip-check-update --skip-version-check --disable-telemetry /repo"]:
                                        self.assertIn(flag, step)
                            prepare = steps["Prepare the vulnerability DB and the pinned checks bundle"]
                            self.assertIn("for repository in ghcr.io/aquasecurity/trivy-db:2 mirror.gcr.io/aquasec/trivy-db:2; do", prepare)
                            self.assertNotIn("$GITHUB_WORKSPACE", prepare)
                    else:
                        self.assertEqual(names, {"admission-gate"})
                        self.assertNotIn("id-token", block)
                        # The hosted gate admits on App 5368905's own admission check, bounded wait.
                        self.assertIn("          CLUED_ADMISSION_GATE_SOURCE: independent-ci-native-work-admission\n", block)
                        self.assertIn('          CLUED_ADMISSION_GATE_WAIT_SECONDS: "600"\n', block)
                        self.assertIn("    timeout-minutes: 15\n", block)
                        self.assertIn("      checks: read\n", block)
        texts = {p.name: p.read_text(encoding="utf-8") for p in policy.WORKFLOW_DIR.glob("*.yml")}
        # Every branch of a dynamic name counts, and so does a job ID without a name.
        for file, old, new in [
            ("gitleaks.yml", "'gitleaks-hosted-executor' ||", "'gitleaks' ||"),
            ("trivy.yml", "|| 'trivy-hosted-executor-skipped' }}", "|| 'trivy' }}"),
            ("contract-placement.yml", "    name: contract-placement-hosted-executor\n", "    name: contract-placement\n"),
            ("contract-placement.yml", "    name: contract-placement-hosted-executor\n", ""),
        ]:
            with self.subTest(file=file, new=new):
                changed = texts[file].replace(old, new, 1)
                self.assertNotEqual(changed, texts[file])
                _, jobs, _ = policy.split_workflow(changed)
                # Re-pinned exact bytes still refuse the hazardous name.
                pinned = copy.deepcopy(policy.OWNER_DECISION_HOSTED_JOBS)
                pinned[file]["jobs"] = {job_id: policy.source_hash(block) for job_id, block in jobs.items()}
                report = policy.evaluate_workflows({**texts, file: changed}, None, pinned)
                self.assert_rejected(report, "carries a required check name")
                self.assertEqual({row["workflow"] for row in report["violations"]}, {file})
                self.assert_rejected(policy.evaluate_workflows({**texts, file: changed}), "Owner-decision hosted job changed")

    def test_owner_decision_exception_cannot_extend_change_or_outlive_its_jobs(self):
        texts = {p.name: p.read_text(encoding="utf-8") for p in policy.WORKFLOW_DIR.glob("*.yml")}
        gitleaks = texts["gitleaks.yml"]
        # Another hosted job, even in an excepted workflow, is new hosted execution.
        self.assert_rejected(policy.evaluate_workflows({**texts, "gitleaks.yml": gitleaks + job("extra", "ubuntu-latest")}),
                             "new GitHub-hosted")
        # The exact admission-gate bytes in any other workflow are not admitted.
        _, jobs, _ = policy.split_workflow(gitleaks)
        copied = PREFIX + jobs["admission-gate"]
        report = policy.evaluate_workflows({**texts, "copied-gate.yml": copied})
        self.assert_rejected(report, "new GitHub-hosted")
        self.assertEqual({row["workflow"] for row in report["violations"]}, {"copied-gate.yml"})
        # Work, timeout, trigger and permission changes of an excepted workflow refuse.
        for changed, reason in [
            (gitleaks.replace("    timeout-minutes: 25\n", "    timeout-minutes: 60\n", 1), "Owner-decision hosted job changed"),
            (gitleaks.replace("--redact --exit-code 1", "--redact --exit-code 0"), "Owner-decision hosted job changed"),
            (gitleaks.replace("  push:\n", "  schedule:\n    - cron: '0 * * * *'\n  push:\n"), "Owner-decision hosted workflow controls changed"),
            (gitleaks.replace("permissions:\n  contents: read\n", "permissions:\n  contents: write\n", 1), "Owner-decision hosted workflow controls changed"),
            (gitleaks.replace(HOSTED_EXECUTOR_ROUTE, HOSTED_EXECUTOR_ROUTE.replace("ubuntu-latest", "ubuntu-24.04")), "Owner-decision hosted job changed"),
            # The relay identity: its permission, audience, condition and position are exact.
            (gitleaks.replace("      id-token: write\n", "      id-token: write\n      checks: write\n", 1), "Owner-decision hosted job changed"),
            (gitleaks.replace("      id-token: write\n", "", 1), "Owner-decision hosted job changed"),
            (gitleaks.replace("audience=clued-hosted-relay-v1", "audience=sts.amazonaws.com"), "Owner-decision hosted job changed"),
            (gitleaks.replace("      - name: Emit relay identity\n", "      - name: Emit relay identity\n        if: always()\n"), "Owner-decision hosted job changed"),
            (gitleaks.replace(RELAY_STEP, ""), "Owner-decision hosted job changed"),
        ]:
            with self.subTest(reason=reason, changed=changed[-300:]):
                self.assertNotEqual(changed, gitleaks)
                self.assert_rejected(policy.evaluate_workflows({**texts, "gitleaks.yml": changed}), reason)
        # A job moved back to self-hosted or removed must drop its exception.
        back = gitleaks.replace(HOSTED_EXECUTOR_ROUTE, HOSTED_EXECUTOR_ROUTE.replace(
            "ubuntu-latest", "[self-hosted, Linux, X64, clued, pool-general, trust-internal, cap-docker-linux]"))
        self.assertNotEqual(back, gitleaks)
        self.assert_rejected(policy.evaluate_workflows({**texts, "gitleaks.yml": back}),
                             "hosted exception must be deleted once its job leaves")
        removed = {name: text for name, text in texts.items() if name != "trivy.yml"}
        self.assert_rejected(policy.evaluate_workflows(removed), "removed Owner-decision hosted job must be deleted")

    def test_owner_decision_exception_schema_fails_closed(self):
        text = PREFIX + job(runner="ubuntu-latest")
        exact = frozen(text)
        self.assert_pass(self.evaluate({"legacy.yml": text}, owner_hosted=exact))
        for invalid in [[], {"legacy.yml": {"control_sha256": "0" * 64, "jobs": {}}},
                        {"legacy.yml": {"control_sha256": "bad", "jobs": {"check": "0" * 64}}},
                        {"legacy.yml": {**exact["legacy.yml"], "extra": True}},
                        {"*.yml": exact["legacy.yml"]}, {"legacy.yml": {**exact["legacy.yml"], "jobs": {"*": "0" * 64}}}]:
            with self.subTest(invalid=invalid):
                self.assert_rejected(self.evaluate({"legacy.yml": text}, owner_hosted=invalid), "Owner-decision")
        self.assert_rejected(self.evaluate({"legacy.yml": text}, exact, exact), "never both")

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
