"""Local engineering checks, not PQUAL execution or controller qualification."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/phase2-qualification/controller.py"
SPEC = importlib.util.spec_from_file_location("controller_candidate", SCRIPT)
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class ControllerCandidateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = {
            "schema": controller.SCHEMA, "mode": controller.MODE,
            "idempotency_key": "probe-1", "operation": "fixture_write",
            "parameters": {"fixture_id": "synthetic-v1"}, "timeout_seconds": 5,
            "expected_runner_sha256": controller.sha(SCRIPT.read_bytes()),
            "expected_control_generation": 1,
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_probe(self):
        return controller.run(self.config, self.root)

    def test_credentials_not_inherited_and_exact_fixture_persisted(self):
        with patch.dict(os.environ, {"CLUED_TEST_SECRET": "synthetic-secret-canary",
                                     "HTTP_PROXY": "synthetic-proxy-canary"}):
            result = self.run_probe()
        self.assertEqual(result["status"], "COMPLETED", result)
        self.assertNotIn("CLUED_TEST_SECRET", result["worker"]["environment_keys"])
        self.assertNotIn("HTTP_PROXY", result["worker"]["environment_keys"])
        folder = self.root / "runs/probe-1"
        self.assertEqual((folder / "fixture.json").read_bytes(), controller.FIXTURE)
        self.assertEqual(result["intent_sha256"], controller.sha((folder / "intent.json").read_bytes()))
        all_evidence = b"".join(p.read_bytes() for p in folder.iterdir())
        self.assertNotIn(b"synthetic-secret-canary", all_evidence)
        self.assertFalse(result["qualified"])
        self.assertIn("OS_NETWORK_ISOLATION_NOT_PROVEN", result["limitations"])

    def test_unknown_fields_arbitrary_actions_and_formal_mode_denied_before_effects(self):
        for changes in ({"command": "whoami"}, {"operation": "model_action"},
                        {"mode": "PRE_ENTRY_SKILL_QUALIFICATION"},
                        {"parameters": {"fixture_id": "real-payload"}},
                        {"timeout_seconds": float("nan")},
                        {"idempotency_key": "../escape"},
                        {"expected_runner_sha256": "0" * 64}):
            with self.subTest(changes=changes):
                outcome = controller.run({**self.config, **changes}, self.root)
                self.assertEqual(outcome["status"], "BLOCKED", outcome)
                self.assertEqual(list(self.root.iterdir()), [])

    def test_same_key_replays_evidence_without_new_execution(self):
        first = self.run_probe()
        with patch.object(controller, "execute_worker", side_effect=AssertionError("must not execute")):
            repeated = self.run_probe()
        self.assertTrue(repeated["replayed_evidence_only"])
        self.assertEqual(repeated["intent_sha256"], first["intent_sha256"])
        self.config["timeout_seconds"] = 6
        self.assertIn("same_key_changed_parameters", self.run_probe()["reason"])

    def test_sink_failure_before_intent_prevents_worker(self):
        original = controller.persist
        def failing(path, value):
            if path.name == "intent.json":
                raise OSError("synthetic sink failure")
            original(path, value)
        with patch.object(controller, "persist", side_effect=failing), patch.object(
                controller, "execute_worker", side_effect=AssertionError("must not execute")):
            self.assertEqual(self.run_probe()["status"], "BLOCKED")
        self.assertFalse((self.root / "runs/probe-1/fixture.json").exists())

    def test_post_effect_sink_failure_stays_unknown_and_reconcile_does_not_retry(self):
        original = controller.persist
        def failing(path, value):
            if path.name == "result.json":
                raise OSError("synthetic result sink failure")
            original(path, value)
        with patch.object(controller, "persist", side_effect=failing):
            self.assertEqual(self.run_probe()["status"], "UNKNOWN")
        with patch.object(controller, "execute_worker", side_effect=AssertionError("must not execute")):
            self.assertEqual(self.run_probe()["status"], "UNKNOWN")
            observed = controller.reconcile(self.root, "probe-1")
        self.assertTrue(observed["target_matches"])
        self.assertEqual(observed["status"], "UNKNOWN")
        self.assertFalse(observed["new_action_allowed"])
        self.assertFalse((self.root / "runs/probe-1/result.json").exists())

    def test_timeout_kills_worker_and_records_actual_exit(self):
        self.config.update(operation="wait", parameters={"seconds": 5}, timeout_seconds=0.1)
        outcome = self.run_probe()
        self.assertEqual(outcome["status"], "STOPPED", outcome)
        self.assertTrue(outcome["worker"]["termination_observed"])
        self.assertIsNotNone(outcome["worker"]["exit_code"])
        self.assertTrue((self.root / "runs/probe-1/result.json").exists())

    def test_stop_during_worker_and_generation_change_block_effect(self):
        self.config.update(operation="wait", parameters={"seconds": 5})
        def request_stop():
            deadline = time.monotonic() + 5
            while not (self.root / "runs/probe-1/intent.json").exists():
                if time.monotonic() > deadline:
                    return
                time.sleep(0.01)
            (self.root / "STOP").touch()
        thread = threading.Thread(target=request_stop)
        thread.start()
        outcome = self.run_probe()
        thread.join()
        self.assertEqual(outcome["status"], "STOPPED", outcome)
        (self.root / "STOP").unlink()
        (self.root / "control.json").write_text(json.dumps({"generation": 2, "revoked": False}))
        self.config["idempotency_key"] = "probe-2"
        self.assertEqual(self.run_probe()["status"], "BLOCKED")
        self.assertFalse((self.root / "runs/probe-2").exists())

    def test_preexisting_lock_is_preserved_and_blocks(self):
        lock = self.root / ".controller.lock"
        lock.write_text("unreconciled")
        self.assertEqual(self.run_probe()["status"], "BLOCKED")
        self.assertEqual(lock.read_text(), "unreconciled")

    def test_replay_rejects_authority_forgery_and_target_drift(self):
        self.assertEqual(self.run_probe()["status"], "COMPLETED")
        path = self.root / "runs/probe-1/result.json"
        original = path.read_bytes()
        value = json.loads(original)
        value["qualified"] = True
        path.write_text(json.dumps(value))
        self.assertEqual(self.run_probe()["status"], "BLOCKED")
        path.write_bytes(original)
        (self.root / "runs/probe-1/fixture.json").write_bytes(b"changed")
        self.assertIn("completed_target_drift", self.run_probe()["reason"])

    def test_reconcile_rejects_mutated_intent(self):
        self.assertEqual(self.run_probe()["status"], "COMPLETED")
        path = self.root / "runs/probe-1/intent.json"
        value = json.loads(path.read_bytes())
        value["expected_target_sha256"] = "0" * 64
        path.write_text(json.dumps(value))
        self.assertEqual(controller.reconcile(self.root, "probe-1")["status"], "BLOCKED")

    def test_corrupt_persisted_result_remains_unknown_without_execution(self):
        self.assertEqual(self.run_probe()["status"], "COMPLETED")
        path = self.root / "runs/probe-1/result.json"
        path.write_text('{"status":')
        with patch.object(controller, "execute_worker", side_effect=AssertionError("must not execute")):
            self.assertEqual(self.run_probe()["status"], "UNKNOWN")
        self.assertEqual(path.read_text(), '{"status":')

    def test_linked_evidence_target_denied(self):
        # Windows junctions require no symlink developer privilege.
        with patch.object(Path, "is_symlink", return_value=True):
            self.assertEqual(self.run_probe()["status"], "BLOCKED")
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
