"""Isolated launcher tests; synthetic local bootstrap/core, real post-migration guard.

Uses actual 45 payloads/39 immutable sources to make an installed fixture.
The fake publication core only invokes gh --version and records safe selectors.
No live API, real trust installation, activation, Step15 or Step18 is claimed.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "scripts/naming-governance/trusted_launcher.py"
POST = REPO / "scripts/naming-governance/post_migration.py"
helper_spec = importlib.util.spec_from_file_location("post_fixture_helper", REPO / "tests/test_naming_governance_post_migration.py")
helper = importlib.util.module_from_spec(helper_spec)
helper_spec.loader.exec_module(helper)
OUTPUT_ROOT = None
CASES = []
FIXTURE_CORE = b'''import json, os, pathlib, subprocess, sys
args = sys.argv[1:]
gh = subprocess.run(["gh", "--version"], capture_output=True, text=True, check=True)
pathlib.Path(os.environ["FIXTURE_CORE_MARKER"]).write_text("fixture core only", encoding="utf-8")
print(json.dumps({"validation":"PASS", "step18_pass":False, "fixture_only":True,
                  "args":args, "isolated":sys.flags.isolated,
                  "pythonpath_present":"PYTHONPATH" in os.environ,
                  "cwd":str(pathlib.Path.cwd()), "path":os.environ["PATH"],
                  "gh_version":gh.stdout.splitlines()[0]}))
'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data):
    return (json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


class TrustedLauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        helper.PostMigrationTests.setUpClass()
        cls.files = helper.PostMigrationTests.files
        cls.input_raw = helper.PostMigrationTests.input_raw
        cls.inputs = helper.PostMigrationTests.inputs
        cls.launcher_raw = LAUNCHER.read_bytes()
        cls.post_raw = POST.read_bytes()
        cls.python = Path(sys.executable).resolve()
        cls.gh = Path(shutil.which("gh") or "")
        if not cls.gh.is_file():
            raise AssertionError("these bounded tests need the already installed gh CLI for --version only")
        cls.gh = cls.gh.resolve()
        cls.python_sha = sha(cls.python.read_bytes())
        cls.gh_sha = sha(cls.gh.read_bytes())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="trusted-launcher-fixture-", dir=OUTPUT_ROOT)
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        for name, data in self.files.items():
            write(self.root / name, data)
        write(self.root / helper.INPUTS, self.input_raw)
        self.freeze_rel = (helper.INPUTS.parent.parent / "FixtureOnlyFreeze.json").as_posix()
        self.freeze_raw = canonical({
            "type":"Phase2StructureFreezeDecision", "state":"FROZEN", "fixture_only":True,
            "authority_effect":"NONE",
            "migration_execution_inputs_ref":{
                "path":helper.INPUTS.relative_to(helper.INPUTS.parent.parent).as_posix(),
                "sha256":sha(self.input_raw)},
        })
        write(self.root / self.freeze_rel, self.freeze_raw)
        self.trust_dir = self.root / ".git/clued-phase2"
        self.entry = self.trust_dir / "trusted_launcher.py"
        write(self.entry, self.launcher_raw)
        write(self.trust_dir / "publication.py", FIXTURE_CORE)
        write(self.trust_dir / "post_migration.py", self.post_raw)
        self.policy = canonical({"publication_validator_sha256":sha(FIXTURE_CORE), "fixture_only":True})
        write(self.trust_dir / "policy.json", self.policy)
        self.pins = {
            "repository_root":str(self.root), "launcher_sha256":sha(self.launcher_raw),
            "publication_sha256":sha(FIXTURE_CORE), "post_migration_sha256":sha(self.post_raw),
            "policy_sha256":sha(self.policy),
            "python":{"path":str(self.python), "sha256":self.python_sha},
            "gh":{"path":str(self.gh), "sha256":self.gh_sha},
            "freeze":{"path":self.freeze_rel, "sha256":sha(self.freeze_raw)},
        }
        self.authority_path = "docs/execution-plans/phase2-structure-governance/ExecutionDelegation_20260907.json"
        self.rebind_fixture_bootstrap()
        self.marker = self.root / "fixture-core-executed"
        self.env = os.environ.copy()
        self.env["FIXTURE_CORE_MARKER"] = str(self.marker)

    def rebind_fixture_bootstrap(self):
        # Test setup only. Production launcher has no equivalent bootstrap command.
        bootstrap = {
            "type":"Phase2TrustedLauncherBootstrap", "state":"AUTHORIZED",
            "scope":"TM19_GOVERNANCE_READ_PUBLISH", "actor":"SYNTHETIC_TEST_INSTALLER",
            "fixture_only":True, "pins_sha256":sha(canonical(self.pins)),
            "authorization_ref":{"path":self.authority_path, "sha256":sha((self.root / self.authority_path).read_bytes())},
        }
        raw = canonical(bootstrap)
        write(self.trust_dir / "Bootstrap.json", raw)
        write(self.trust_dir / "trust-config.json", canonical({
            "contract":"clued.phase2.local-trust-config/v1", "pins":self.pins, "bootstrap_sha256":sha(raw)}))

    def run_launcher(self, arguments=(), isolated=True, env=None, entry=None, cwd=None):
        command = [str(self.python)]
        if isolated:
            command.append("-I")
        command.extend([str(entry or self.entry), *arguments])
        result = subprocess.run(command, cwd=cwd or self.root, env=env or self.env,
                                capture_output=True, text=True, encoding="utf-8", timeout=45)
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError:
            report = None
        CASES.append({"test":self.id(), "fixture_only":True, "exit_code":result.returncode,
                      "report":report, "stderr":result.stderr})
        return result, report

    def rejected(self, arguments=(), **kwargs):
        result, report = self.run_launcher(arguments, **kwargs)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.marker.exists(), "publication core ran before rejected prerequisite")
        return report

    def test_template_not_installed_is_fail_closed(self):
        report = self.rejected(entry=LAUNCHER)
        self.assertIn("not independently installed", report["error"])

    def test_read_checks_real_local_fixture_before_core(self):
        result, report = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(report["fixture_only"])
        self.assertFalse(report["step18_pass"])
        self.assertEqual(report["local_post_migration_guard"]["checked_changed_paths"], 64)
        self.assertEqual(report["local_post_migration_guard"]["checked_immutable_inputs"], 39)
        self.assertEqual(report["core"]["args"][0], "read")
        self.assertEqual(report["core"]["isolated"], 1)
        self.assertTrue(report["core"]["gh_version"].startswith("gh version "))

    def test_validate_allows_only_actual_selectors(self):
        result, report = self.run_launcher(["validate", "--attestation-commit", "a"*40, "--publication-pr", "17"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["core"]["args"][-4:], ["--attestation-commit", "a"*40, "--publication-pr", "17"])

    def test_publish_requires_explicit_cas_and_uses_fixed_repo(self):
        result, report = self.run_launcher(["publish", "--attestation-commit", "a"*40,
                                            "--publication-pr", "17", "--expected-current", "NONE"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        args = report["core"]["args"]
        self.assertEqual(args[args.index("--repo-root")+1], str(self.root))
        self.assertEqual(args[-2:], ["--expected-current", "NONE"])
        self.assertFalse((self.root / "development/authority-index/phase2/Activation.json").exists())

    def test_no_policy_pin_source_or_repo_overrides(self):
        for option in ("--policy", "--policy-sha256", "--repo-root", "--source-commit", "--gh"):
            with self.subTest(option=option):
                self.rejected([option, "candidate-provided"])

    def test_publish_without_explicit_cas_rejected(self):
        self.rejected(["publish", "--attestation-commit", "a"*40, "--publication-pr", "17"])

    def test_read_rejects_caller_activation_selector(self):
        self.rejected(["read", "--attestation-commit", "a"*40, "--publication-pr", "17"])

    def test_python_isolation_required_before_shadowable_imports(self):
        write(self.root / "json.py", b'raise RuntimeError("CANDIDATE JSON EXECUTED")\n')
        result, report = self.run_launcher(isolated=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires Python -I", result.stderr)
        self.assertNotIn("CANDIDATE JSON EXECUTED", result.stderr)
        self.assertFalse(self.marker.exists())

    def test_cwd_pythonpath_modules_and_fake_gh_cannot_hijack(self):
        hijack = self.root / "candidate-module-executed"
        malicious = ("from pathlib import Path\nPath(" + repr(str(hijack)) + ").write_text('bad')\nraise RuntimeError('module hijack')\n").encode()
        for name in ("json.py", "subprocess.py", "sitecustomize.py", "pathlib.py"):
            write(self.root / name, malicious)
        write(self.root / ("gh.exe" if os.name == "nt" else "gh"), b"not the trusted gh executable")
        env = self.env.copy()
        env["PYTHONPATH"] = str(self.root)
        env["PATH"] = str(self.root) + os.pathsep + env.get("PATH", "")
        result, report = self.run_launcher(env=env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(hijack.exists())
        self.assertFalse(report["core"]["pythonpath_present"])
        self.assertEqual(report["core"]["path"], str(self.gh.parent))
        self.assertNotEqual(report["core"]["cwd"], str(self.root))
        self.assertTrue(report["core"]["gh_version"].startswith("gh version "))

    def test_publication_header_drift(self):
        write(self.trust_dir / "publication.py", b"# altered candidate header\n" + FIXTURE_CORE)
        self.assertIn("publication.py", self.rejected()["error"])

    def test_launcher_header_drift(self):
        write(self.entry, b"# altered installed header\n" + self.launcher_raw)
        self.assertIn("trusted_launcher.py", self.rejected()["error"])

    def test_post_migration_module_drift(self):
        write(self.trust_dir / "post_migration.py", self.post_raw + b"\n# changed module\n")
        self.assertIn("post_migration.py", self.rejected()["error"])

    def test_policy_bytes_drift(self):
        write(self.trust_dir / "policy.json", self.policy + b"\n")
        self.assertIn("policy.json", self.rejected()["error"])

    def test_bootstrap_bytes_drift(self):
        path = self.trust_dir / "Bootstrap.json"
        path.write_bytes(path.read_bytes() + b"\n")
        self.assertIn("Bootstrap.json", self.rejected()["error"])

    def test_changed_pin_without_reauthorized_bootstrap(self):
        path = self.trust_dir / "trust-config.json"
        config = json.loads(path.read_bytes())
        config["pins"]["freeze"]["path"] = self.freeze_rel.replace("FixtureOnlyFreeze.json", "AlternateFreeze.json")
        write(self.root / config["pins"]["freeze"]["path"], self.freeze_raw)
        write(path, canonical(config))
        self.assertIn("bootstrap does not bind", self.rejected()["error"])

    def test_runtime_path_drift(self):
        self.pins["python"]["path"] = str(self.root / "other-python.exe")
        self.rebind_fixture_bootstrap()
        self.rejected()

    def test_gh_byte_drift(self):
        fake = self.trust_dir / "toolbox" / self.gh.name
        write(fake, b"changed gh binary")
        self.pins["gh"]["path"] = str(fake)
        self.rebind_fixture_bootstrap()
        self.assertIn(self.gh.name, self.rejected()["error"])

    def test_linked_trust_store_rejected(self):
        real = self.root / ".git/retained-fixture-trust"
        self.trust_dir.rename(real)
        helper.directory_link(self.trust_dir, real)
        self.addCleanup(helper.remove_link_only, self.trust_dir)
        self.assertIn("linked trusted path", self.rejected()["error"])

    def test_local_source_index_tamper_blocks_every_mode_before_core(self):
        path = self.root / "development/authority-index/phase2/SourceIndex.json"
        path.write_bytes(path.read_bytes() + b"\n")
        for mode in ("read", "validate", "publish"):
            arguments = [mode]
            if mode != "read":
                arguments += ["--attestation-commit", "a"*40, "--publication-pr", "17"]
            if mode == "publish":
                arguments += ["--expected-current", "NONE"]
            with self.subTest(mode=mode):
                self.assertIn("local post-migration guard rejected", self.rejected(arguments)["error"])

    def test_locked_source_tamper_blocks_core(self):
        path = self.root / self.inputs["immutable_input_locks"][0]["path"]
        path.write_bytes(path.read_bytes() + b"\n")
        report = self.rejected()
        self.assertIn("local post-migration guard rejected", report["error"])
        self.assertIn("ACCEPTED_SOURCE_DRIFT", {row["code"] for row in report["evidence"]["local_post_migration_guard"]["errors"]})

    def test_additional_governance_write_blocks_core(self):
        write(self.root / "development/projections/phase2/Unchecked.json", b"{}")
        self.assertIn("local post-migration guard rejected", self.rejected()["error"])

    def test_no_bootstrap_record_fails_closed(self):
        (self.trust_dir / "Bootstrap.json").unlink()
        self.rejected()


def main():
    global OUTPUT_ROOT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path)
    args, remaining = parser.parse_known_args()
    if args.output_root:
        args.output_root.mkdir(parents=True, exist_ok=True)
        OUTPUT_ROOT = str(args.output_root.resolve())
    program = unittest.main(argv=[sys.argv[0]] + remaining, exit=False, verbosity=2)
    result = program.result
    report = {
        "type":"FixtureOnlyTrustedLauncherTests", "fixture_only":True,
        "actual_installation":False, "actual_github_api_calls":0,
        "actual_publication":False, "step15_pass":False, "step18_pass":False,
        "launcher_sha256":sha(LAUNCHER.read_bytes()), "post_migration_sha256":sha(POST.read_bytes()),
        "test_sha256":sha(Path(__file__).read_bytes()),
        "test_count":result.testsRun, "failures":[{"test":case.id(), "traceback":detail} for case,detail in result.failures],
        "errors":[{"test":case.id(), "traceback":detail} for case,detail in result.errors],
        "skipped":[{"test":case.id(), "reason":detail} for case,detail in result.skipped],
        "status":"PASS" if result.wasSuccessful() else "FAIL",
        "local_fixture_sources":helper.SOURCE_RECORD, "cases":CASES,
        "limitations":["Publication core is an explicit stub; actual core has its own independent tests.",
                       "The installed post_migration copy is real and checks actual frozen fixture payloads.",
                       "gh --version validates executable routing only, never GitHub permissions.",
                       "Same-UID administrator replacement of trust files is outside this local boundary."],
    }
    if args.output_root:
        write(args.output_root / "FixtureTestReport.json", json.dumps(report, ensure_ascii=False, indent=2).encode()+b"\n")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
