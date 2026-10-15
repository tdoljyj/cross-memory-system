"""New accounting/integration tests; no weights, model, network or old experiments."""
import concurrent.futures
import copy
import json
import multiprocessing
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import io
import subprocess
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts/model-program"
sys.path.insert(0, str(SCRIPTS))
import development_attempt_ledger as ledger
import development_completion_entry as entry
import development_currentness_channel  # Bootstrap imports it after this local path is removed.
sys.path.remove(str(SCRIPTS))


def identity(root):
    return {"profile_id": "DEV-OBSERVED-001", "profile_sha256": "1" * 64,
            "request_sha256": "2" * 64, "approval_record_id": "approval-source-test",
            "approval_version": 1, "approval_receipt_id": "receipt-source-test",
            "task_id": ledger.TASK_ID, "ledger_directory": str(root)}


def reservation(root):
    return {**{k: v for k, v in identity(root).items() if k != "ledger_directory"},
            "plan_sha256": "3" * 64, "reserved_at": "2026-10-13T04:00:00Z"}


def process_reserve(root, started):
    started.wait(10)
    try:
        ledger.reserve_once(root, reservation(Path(root)), before_create=lambda: None, verify_created=lambda *args: None)
        return (os.getpid(), "reserved")
    except ledger.AttemptLedgerError:
        return (os.getpid(), "spent")


class DevelopmentEntryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("CLUED_MODEL_SOURCE_TEST_TEMP_ROOT"))
        self.root = Path(self.tmp.name).resolve()
        self.plan = {"observation_path": str(self.root / "observation.jsonl"),
                     "deadline_monotonic": time.monotonic() + 60,
                     "budget": {"wall_seconds": 60}}

    def tearDown(self):
        self.tmp.cleanup()

    def bootstrap(self, **changes):
        value = {"schema": entry.BOOTSTRAP_SCHEMA, "identity": identity(self.root),
                 "plan": {"budget": {"wall_seconds": 60}},
                 "live_pins": {"task_version": 1, "claim_id": "SOURCE ONLY", "claim_fence": 1},
                 "output_directory": str(self.root), "output_name": "SOURCE-ONLY.jsonl",
                 "remaining_seconds": 60}
        value.update(changes)
        return io.BytesIO((json.dumps(value) + "\n").encode())

    def test_four_b_bootstrap_uses_explicit_class_and_original_remaining_deadline(self):
        plan = {"cpu_threads": 8, "development_budget_class": entry.observed.legacy.FOUR_B_BUDGET_CLASS,
                "budget": {"wall_seconds": 480, "control_wall_seconds": 585}}
        clock = time.monotonic()
        with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
            factory.return_value.__enter__.return_value.execute.return_value = {"owned_cleanup_verified": True}
            entry.run_captured_stdio_bootstrap(self.bootstrap(plan=plan, remaining_seconds=500), io.BytesIO())
            passed = factory.return_value.__enter__.return_value.execute.call_args.args[1]
            self.assertGreaterEqual(passed["deadline_monotonic"], clock + 500)
            self.assertLess(passed["deadline_monotonic"], clock + 501)
            self.assertEqual(factory.call_args.kwargs["timeout_seconds"], 30)
        for bad in ({"budget": {"control_wall_seconds": 585}},
                    {**plan, "cpu_threads": 2}, {**plan, "development_budget_class": "unknown"}):
            with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                    mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
                with self.assertRaises(ValueError):
                    entry.run_captured_stdio_bootstrap(self.bootstrap(plan=bad, remaining_seconds=500), io.BytesIO())
                factory.assert_not_called()

    def test_fixed_bootstrap_encodes_nested_bytes_after_cleanup(self):
        result = {"owned_cleanup_verified": True, "stdout": b"\xff\x00",
                  "observation_capture": {"raw": b"\xe4\xb8\xad"},
                  "elapsed_seconds": 1.0, "authority_effect": "NONE"}
        writer = io.BytesIO()
        with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
            host = factory.return_value.__enter__.return_value
            host.execute.return_value = result
            entry.run_captured_stdio_bootstrap(self.bootstrap(), writer)
            self.assertGreater(host.execute.call_args.args[1]["deadline_monotonic"], time.monotonic())
            self.assertEqual(factory.call_args.kwargs["timeout_seconds"], 30)
            self.assertEqual(factory.call_args.kwargs["deadline_monotonic"],
                host.execute.call_args.args[1]["deadline_monotonic"] - entry.observed.legacy.CLEANUP_RESERVE_SECONDS)
        ready, terminal = [json.loads(line) for line in writer.getvalue().splitlines()]
        self.assertEqual(ready["kind"], "host_ready")
        self.assertEqual(terminal["result"]["stdout"], {"encoding": "base64", "data": "/wA="})
        self.assertEqual(terminal["result"]["observation_capture"]["raw"]["data"], "5Lit")
        self.assertEqual(float.fromhex(terminal["result"]["elapsed_seconds"]["data"]), 1.0)

    def test_fixed_bootstrap_rejects_bad_window_and_unverified_cleanup(self):
        for remaining in (True, 0, 121, float("nan")):
            with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                    mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
                with self.assertRaises(ValueError):
                    entry.run_captured_stdio_bootstrap(self.bootstrap(remaining_seconds=remaining), io.BytesIO())
                factory.assert_not_called()
        with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
            factory.return_value.__enter__.return_value.execute.return_value = {"owned_cleanup_verified": False}
            writer = io.BytesIO()
            with self.assertRaisesRegex(ValueError, "CLEANUP_UNVERIFIED"):
                entry.run_captured_stdio_bootstrap(self.bootstrap(), writer)
            self.assertEqual(len(writer.getvalue().splitlines()), 1)

    def test_extended_control_bootstrap_requires_explicit_bound_budget(self):
        for control in (None, True, 0, 226):
            plan = {"budget": {"wall_seconds": 120}}
            if control is not None: plan["budget"]["control_wall_seconds"] = control
            with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                    mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
                with self.assertRaises(ValueError):
                    entry.run_captured_stdio_bootstrap(self.bootstrap(plan=plan, remaining_seconds=210), io.BytesIO())
                factory.assert_not_called()
        with mock.patch.object(entry, "_capture_child_job", return_value=object()), \
                mock.patch.object(entry.FixedDevelopmentEntry, "for_clued_stdio") as factory:
            factory.return_value.__enter__.return_value.execute.return_value = {
                "owned_cleanup_verified": True, "authority_effect": "NONE"}
            entry.run_captured_stdio_bootstrap(self.bootstrap(
                plan={"budget": {"wall_seconds": 120, "control_wall_seconds": 225}},
                remaining_seconds=210), io.BytesIO())
            self.assertEqual(factory.call_args.kwargs["timeout_seconds"], 30)

    def test_actual_windows_parent_kill_closes_job_and_descendant(self):
        self.assertEqual(os.name, "nt", "native Windows proof required; no skip")
        script = ('import sys,subprocess,time;sys.path.insert(0,sys.argv[1]);'
                  'import development_completion_entry as e;j=e._capture_child_job();'
                  'p=subprocess.Popen([sys.executable,"-I","-c","import time;time.sleep(30)"],'
                  'stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);'
                  'print(p.pid,flush=True);time.sleep(30)')
        parent = subprocess.Popen([sys.executable, "-I", "-u", "-c", script, str(SCRIPTS)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        handle = None
        try:
            pid = int(parent.stdout.readline())
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.WaitForSingleObject.restype = wintypes.DWORD
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.restype = wintypes.BOOL
            handle = kernel.OpenProcess(0x100000, False, pid)
            self.assertTrue(handle)
            self.assertEqual(kernel.WaitForSingleObject(handle, 0), 258)
            parent.kill()
            parent.wait(5)
            self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0,
                             "kill-on-close Job must stop the actual non-model descendant")
        finally:
            if parent.poll() is None:
                parent.kill()
            parent.wait(5)
            parent.stdout.close()
            parent.stderr.close()
            if handle:
                kernel.CloseHandle(handle)

    def test_stdio_factory_captures_channel_and_exact_windows_namespace(self):
        import io
        from development_currentness_channel import PrivateCurrentnessChannel
        with mock.patch.object(entry.FixedDevelopmentEntry, "for_windows_namespace") as native:
            entry.FixedDevelopmentEntry.for_clued_stdio(reader=io.BytesIO(), writer=io.BytesIO(),
                live_pins={"task_version": 2, "claim_id": "SOURCE ONLY CLAIM", "claim_fence": 3},
                ledger_directory=str(self.root), output_directory=str(self.root / "outputs"),
                output_name="observations.jsonl")
            captured = native.call_args.kwargs
            self.assertIsInstance(captured["live_check"], PrivateCurrentnessChannel)
            self.assertEqual(captured["ledger_directory"], str(self.root))
            self.assertEqual(captured["output_name"], "observations.jsonl")

    def test_concurrent_processes_get_one_durable_attempt(self):
        # Separate processes exercise the actual OS exclusive-create boundary.
        context = multiprocessing.get_context("spawn")
        with context.Manager() as manager:
            start = manager.Barrier(4)
            with concurrent.futures.ProcessPoolExecutor(4, mp_context=context) as pool:
                work = [pool.submit(process_reserve, str(self.root), start) for _ in range(4)]
                results = [job.result(timeout=30) for job in work]
        self.assertEqual(len({pid for pid, status in results}), 4)
        self.assertEqual([status for pid, status in results].count("reserved"), 1)
        self.assertEqual([status for pid, status in results].count("spent"), 3)
        saved = json.loads(next(self.root.glob("*.spent.json")).read_text())
        self.assertEqual(saved["status"], "SPENT_BEFORE_MODEL_LOAD")
        self.assertFalse(saved["retries_allowed"])

    def test_write_or_fsync_failure_does_not_restore_attempt(self):
        for failure in ("write", "fsync"):
            folder = self.root / failure
            folder.mkdir()
            with mock.patch.object(ledger.os, failure, side_effect=OSError("source failure")):
                with self.assertRaises(OSError):
                    ledger.reserve_once(folder, reservation(folder), before_create=lambda: None, verify_created=lambda *args: None)
            with self.assertRaisesRegex(ValueError, "ALREADY_SPENT_OR_UNCERTAIN"):
                ledger.reserve_once(folder, reservation(folder), before_create=lambda: None, verify_created=lambda *args: None)
            self.assertEqual(len(list(folder.glob("*.spent.json"))), 1)

    def test_changed_request_and_empty_existing_file_cannot_reset_profile(self):
        ledger.reserve_once(self.root, reservation(self.root), before_create=lambda: None, verify_created=lambda *args: None)
        changed = reservation(self.root)
        changed["request_sha256"] = "9" * 64
        with self.assertRaisesRegex(ValueError, "ALREADY_SPENT"):
            ledger.reserve_once(self.root, changed, before_create=lambda: None, verify_created=lambda *args: None)
        # A partial/crashed prior reservation is also permanently unavailable.
        next(self.root.glob("*.spent.json")).write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "ALREADY_SPENT"):
            ledger.reserve_once(self.root, changed, before_create=lambda: None, verify_created=lambda *args: None)

    def test_old_m1_and_unbound_boolean_version_reject_before_write(self):
        for field, value in (("profile_id", "M1-REF-OLD"), ("approval_version", True)):
            bad = reservation(self.root)
            bad[field] = value
            with self.assertRaises(ValueError):
                ledger.reserve_once(self.root, bad, before_create=lambda: None, verify_created=lambda *args: None)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_live_denial_never_spends_or_invokes_process(self):
        def deny(*args):
            raise ValueError("REVOKED")
        host = entry.FixedDevelopmentEntry(live_check=deny, namespace_check=lambda *args: None, reservation_check=lambda *args: None)
        def process(plan, *, boundary):
            boundary("preflight", copy.deepcopy(plan), entry.observed.legacy.digest(plan), None)
            self.fail("denied preflight returned")
        with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
            with self.assertRaisesRegex(ValueError, "REVOKED"):
                host.execute(identity(self.root), self.plan)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_spend_precedes_resume_and_survives_runtime_failure(self):
        events = []
        def live(phase, bound):
            events.append(phase)
        host = entry.FixedDevelopmentEntry(live_check=live, namespace_check=lambda *args: None, reservation_check=lambda *args: None)
        def process(plan, *, boundary):
            seal = entry.observed.legacy.digest(plan)
            for phase in ("preflight", "observation_opened", "consume", "before_start", "before_resume", "running"):
                boundary(phase, copy.deepcopy(plan), seal, None)
                if phase == "before_resume":
                    self.assertEqual(len(list(self.root.glob("*.spent.json"))), 1)
            raise RuntimeError("child failed")
        with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
            with self.assertRaises(RuntimeError):
                host.execute(identity(self.root), self.plan)
            with self.assertRaisesRegex(ValueError, "ALREADY_SPENT"):
                host.execute(identity(self.root), self.plan)
        self.assertLess(events.index("consume"), events.index("before_resume"))

    def test_revocation_between_spend_and_resume_stops_without_refund(self):
        def live(phase, bound):
            if phase == "before_resume":
                raise ValueError("REVOKED")
        host = entry.FixedDevelopmentEntry(live_check=live, namespace_check=lambda *args: None, reservation_check=lambda *args: None)
        def process(plan, *, boundary):
            for phase in ("consume", "before_resume"):
                boundary(phase, copy.deepcopy(plan), entry.observed.legacy.digest(plan), None)
            self.fail("revoked child resumed")
        with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
            with self.assertRaisesRegex(ValueError, "REVOKED"):
                host.execute(identity(self.root), self.plan)
        self.assertEqual(len(list(self.root.glob("*.spent.json"))), 1)

    def test_reader_cannot_widen_binding_and_unspent_resume_refuses(self):
        def mutate(phase, bound):
            bound["identity"]["request_sha256"] = "9" * 64
        for reader, phase, code in ((mutate, "consume", "MUTATED_BINDING"),
                                    (lambda *args: None, "before_resume", "NOT_CONSUMED")):
            host = entry.FixedDevelopmentEntry(live_check=reader, namespace_check=lambda *args: None, reservation_check=lambda *args: None)
            def process(plan, *, boundary):
                boundary(phase, copy.deepcopy(plan), entry.observed.legacy.digest(plan), None)
            with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
                with self.assertRaisesRegex(ValueError, code):
                    host.execute(identity(self.root), self.plan)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_late_admission_callback_cannot_spend_after_execute_returns(self):
        waiting, finish = threading.Event(), threading.Event()
        errors, workers = [], []
        def live(phase, bound):
            waiting.set()
            finish.wait(5)
        host = entry.FixedDevelopmentEntry(live_check=live, namespace_check=lambda *args: None, reservation_check=lambda *args: None)
        def process(plan, *, boundary):
            def callback():
                try:
                    boundary("consume", copy.deepcopy(plan), entry.observed.legacy.digest(plan), None)
                except BaseException as exc:
                    errors.append(exc)
            worker = threading.Thread(target=callback)
            workers.append(worker)
            worker.start()
            self.assertTrue(waiting.wait(5))
            raise TimeoutError("process callback timeout")
        with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
            with self.assertRaises(TimeoutError):
                host.execute(identity(self.root), self.plan)
        finish.set()
        workers[0].join(5)
        self.assertFalse(workers[0].is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], TimeoutError)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_namespace_check_cannot_spend_after_deadline(self):
        host = entry.FixedDevelopmentEntry(live_check=lambda *args: None, namespace_check=lambda *args: None, reservation_check=lambda *args: None)
        # Advance the actual monotonic clock after the namespace verifier.
        def process(plan, *, boundary):
            clock = entry.observed.legacy.time.monotonic()
            with mock.patch.object(entry.observed.legacy.time, "monotonic",
                                   side_effect=[clock, clock, clock + 120]):
                boundary("consume", copy.deepcopy(plan), entry.observed.legacy.digest(plan), None)
        with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
            with self.assertRaises(TimeoutError):
                host.execute(identity(self.root), self.plan)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_stop_guard_is_after_metadata_and_before_exclusive_create(self):
        events = []
        def metadata(directory):
            events.append("metadata")
            return original(directory)
        def stop():
            events.append("stop")
            raise TimeoutError("late metadata")
        original = ledger._root
        with mock.patch.object(ledger, "_root", side_effect=metadata), mock.patch.object(ledger.os, "open") as opening:
            with self.assertRaises(TimeoutError):
                ledger.reserve_once(self.root, reservation(self.root), before_create=stop, verify_created=lambda *args: None)
            opening.assert_not_called()
        self.assertEqual(events, ["metadata", "stop"])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_malformed_budget_does_not_permanently_lock_host(self):
        host = entry.FixedDevelopmentEntry(live_check=lambda *args: None,
                                           namespace_check=lambda *args: None,
                                           reservation_check=lambda *args: None)
        for bad in (None, [], True):
            plan = copy.deepcopy(self.plan)
            plan["budget"] = bad
            with self.assertRaisesRegex(ValueError, "ADMITTED_BUDGET"):
                host.execute(identity(self.root), plan)
        def process(plan, *, boundary):
            boundary("consume", copy.deepcopy(plan), entry.observed.legacy.digest(plan), None)
            return {"authority_effect": "NONE"}
        with mock.patch.object(entry.observed, "execute_observed_completion", side_effect=process):
            result = host.execute(identity(self.root), self.plan)
        self.assertEqual(result["budget_reservation"]["status"], "SPENT_BEFORE_MODEL_LOAD")


if __name__ == "__main__":
    unittest.main()
