"""Explicit fixture tests of the frozen post-migration file boundary.

Copies only the actual frozen execution payloads and 39 locked governance inputs
into isolated installations. The synthetic Freeze is never an acceptance.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPOSITORY = Path(__file__).resolve().parents[1]
MODULE = REPOSITORY / "scripts/naming-governance/post_migration.py"
INPUTS = Path("docs/execution-plans/phase2-structure-governance/step12-migration-20260907/ExecutionInputs.candidate.json")
spec = importlib.util.spec_from_file_location("post_migration_under_test", MODULE)
post = importlib.util.module_from_spec(spec)
spec.loader.exec_module(post)
OUTPUT_ROOT = None
RECORDS = []
SOURCE_RECORD = {}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)


def directory_link(link, target):
    """Create only a test-owned symlink or Windows junction, never a repository link."""
    if os.name == "nt":
        # Native cmdlet receives literal quoted paths; no file deletion or cross-shell path lists.
        script = "New-Item -ItemType Junction -Path '" + str(link).replace("'", "''") + "' -Target '" + str(target).replace("'", "''") + "' | Out-Null"
        result = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("fixture junction unavailable: " + result.stderr)
    else:
        link.symlink_to(target, target_is_directory=True)


def remove_link_only(path):
    if hasattr(path, "is_junction") and path.is_junction():
        path.rmdir()
    elif path.is_symlink():
        path.unlink()


class PostMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global SOURCE_RECORD
        cls.input_raw = (REPOSITORY / INPUTS).read_bytes()
        cls.inputs = json.loads(cls.input_raw)
        if len(cls.inputs["changes"]) != 64 or len(cls.inputs["immutable_input_locks"]) != 39:
            raise AssertionError("this review fixture requires the actual 64-path / 39-lock contract")
        cls.files = {}
        payloads = []
        for item in cls.inputs["changes"]:
            if item["after_sha256"] is None:
                continue
            ref = item["payload"]
            original = (REPOSITORY / INPUTS).parent / ref["path"]
            raw = original.read_bytes()
            if sha(raw) != ref["sha256"] or sha(raw) != item["after_sha256"] or len(raw) != ref["bytes"]:
                raise AssertionError("actual execution payload mismatch: " + item["path"])
            cls.files[item["path"]] = raw
            payloads.append({"path": item["path"], "source": original.relative_to(REPOSITORY).as_posix(),
                             "bytes": len(raw), "sha256": sha(raw)})
        if len(payloads) != 45:
            raise AssertionError("expected the actual 45 retained payloads")
        locks = []
        for lock in cls.inputs["immutable_input_locks"]:
            raw = (REPOSITORY / lock["path"]).read_bytes()
            if sha(raw) != lock["sha256"]:
                raise AssertionError("actual locked source changed: " + lock["path"])
            if lock["path"] in cls.files and cls.files[lock["path"]] != raw:
                raise AssertionError("fixture target/lock conflict")
            cls.files[lock["path"]] = raw
            locks.append({"path": lock["path"], "bytes": len(raw), "sha256": sha(raw)})
        SOURCE_RECORD = {
            "fixture_only": True, "authority_effect": "NONE", "actual_migration_claim": False,
            "execution_inputs": {"path": INPUTS.as_posix(), "sha256": sha(cls.input_raw)},
            "payload_count": 45, "changed_path_count": 64, "immutable_lock_count": 39,
            "payloads": payloads, "immutable_locks": locks,
        }

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="step15-fixture-", dir=OUTPUT_ROOT)
        self.root = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        for name, raw in self.files.items():
            write(self.root / name, raw)
        write(self.root / INPUTS, self.input_raw)
        self.freeze_path = self.root / INPUTS.parent.parent / "FixtureOnlyFreeze.json"
        self.freeze = {
            "type": "Phase2StructureFreezeDecision", "state": "FROZEN",
            "fixture_only": True, "authority_effect": "NONE",
            "note": "Synthetic fixture selector; does not issue real Freeze or acceptance.",
            "migration_execution_inputs_ref": {
                "path": INPUTS.relative_to(INPUTS.parent.parent).as_posix(), "sha256": sha(self.input_raw)},
        }
        self.freeze_raw = (json.dumps(self.freeze, ensure_ascii=False, sort_keys=True) + "\n").encode()
        write(self.freeze_path, self.freeze_raw)

    def inspect(self, freeze_path=None):
        try:
            result = post.inspect_installation(self.root, freeze_path or self.freeze_path, sha(self.freeze_raw))
            RECORDS.append({"test": self.id(), "fixture_only": True, "outcome": result,
                            "synthetic_freeze_sha256": sha(self.freeze_raw)})
            return result
        except (ValueError, OSError, KeyError, TypeError) as error:
            RECORDS.append({"test": self.id(), "fixture_only": True,
                            "rejected": type(error).__name__, "detail": str(error),
                            "synthetic_freeze_sha256": sha(self.freeze_raw)})
            raise

    def assert_code(self, code):
        result = self.inspect()
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["exit_code"], 1)
        self.assertIn(code, {error["code"] for error in result["errors"]})

    def test_actual_payload_installation_64_paths_39_locks(self):
        result = self.inspect()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["checked_changed_paths"], 64)
        self.assertEqual(result["checked_immutable_inputs"], 39)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["authority_effect"], "NONE")
        self.assertEqual(sum(row["expected"] is not None for row in result["installed_paths"]), 45)

    def test_target_byte_tamper(self):
        name = next(row["path"] for row in self.inputs["changes"] if row["after_sha256"] is not None)
        path = self.root / name
        path.write_bytes(path.read_bytes() + b"\nfixture target tamper\n")
        self.assert_code("FROZEN_TARGET_DRIFT")

    def test_accepted_source_byte_tamper(self):
        name = self.inputs["immutable_input_locks"][0]["path"]
        path = self.root / name
        path.write_bytes(path.read_bytes() + b"\n# fixture accepted-source tamper\n")
        self.assert_code("ACCEPTED_SOURCE_DRIFT")

    def test_extra_governance_write_in_each_frozen_namespace(self):
        for prefix in ("development/contracts/phase2", "development/projections/phase2",
                       "development/authority-index/phase2"):
            path = self.root / prefix / "UnregisteredFixture.json"
            write(path, b'{"fixture_only":true}\n')
            self.assert_code("UNREGISTERED_GOVERNANCE_WRITE")
            path.unlink()

    def test_sealed_old_entry_reopened(self):
        name = next(row["path"] for row in self.inputs["changes"] if row["after_sha256"] is None)
        write(self.root / name, b"fixture reopened old entry\n")
        self.assert_code("SEALED_OLD_PATH_REOPENED")

    def test_target_replaced_with_directory(self):
        name = next(row["path"] for row in self.inputs["changes"] if row["after_sha256"] is not None)
        path = self.root / name
        path.unlink()
        path.mkdir()
        self.assert_code("INSTALLED_PATH_TYPE")

    def test_governance_directory_link_rejected_even_for_equal_bytes(self):
        path = self.root / "development/contracts/phase2"
        retained = self.root / "fixture-retained-contracts"
        path.rename(retained)
        directory_link(path, retained)
        self.addCleanup(remove_link_only, path)
        with self.assertRaisesRegex(ValueError, "linked path"):
            self.inspect()

    def test_freeze_directory_link_rejected_before_resolve(self):
        alias = self.root / "fixture-freeze-link"
        directory_link(alias, self.freeze_path.parent)
        self.addCleanup(remove_link_only, alias)
        with self.assertRaisesRegex(ValueError, "linked path"):
            self.inspect(alias / self.freeze_path.name)

    def test_execution_inputs_changed_without_freeze_rebinding(self):
        path = self.root / INPUTS
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "execution inputs drift"):
            self.inspect()

    def test_freeze_digest_drift(self):
        self.freeze_path.write_bytes(self.freeze_raw + b"\n")
        with self.assertRaisesRegex(ValueError, "Freeze digest drift"):
            self.inspect()

    def test_missing_locked_source(self):
        (self.root / self.inputs["immutable_input_locks"][0]["path"]).unlink()
        self.assert_code("ACCEPTED_SOURCE_DRIFT")

    def test_activation_exception_has_no_publication_acceptance(self):
        write(self.root / "development/authority-index/phase2/Activation.json",
              b'{"fixture_only":true,"unverified_pointer":true}\n')
        result = self.inspect()
        self.assertEqual(result["status"], "PASS")
        self.assertTrue(any("Activation is not accepted" in note for note in result["limits"]))
        self.assertEqual(result["authority_effect"], "NONE")


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
        "type": "FixtureOnlyPostMigrationBoundaryTests", "fixture_only": True,
        "step15_pass": False, "step18_pass": False, "actual_freeze_issued": False,
        "actual_migration_performed": False, "post_migration_sha256": sha(MODULE.read_bytes()),
        "test_sha256": sha(Path(__file__).read_bytes()), "tests_run": result.testsRun,
        "failures": [{"test": item.id(), "traceback": detail} for item, detail in result.failures],
        "errors": [{"test": item.id(), "traceback": detail} for item, detail in result.errors],
        "skipped": [{"test": item.id(), "reason": reason} for item, reason in result.skipped],
        "status": "PASS" if result.wasSuccessful() else "FAIL",
        "sources": SOURCE_RECORD, "cases": RECORDS,
    }
    if args.output_root:
        write(args.output_root / "FixtureTestReport.json",
              (json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode())
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())

