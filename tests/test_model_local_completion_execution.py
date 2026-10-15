"""Bounded process Source tests. All real children are Python fixtures, no model."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts/model-program/local_completion_execution.py"
spec = importlib.util.spec_from_file_location("completion_process_spec", PATH)
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


def pin(path):
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


class CompletionPlanTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ.get("CLUED_MODEL_SOURCE_TEST_TEMP_ROOT"))
        self.root = Path(self.temporary.name).resolve()
        for name in ("llama-completion.exe", "model.gguf", "prompt.txt", "schema.json"):
            (self.root / name).write_bytes(b"SOURCE_TEST_ONLY_NOT_MODEL")
        self.plan = {"executable": pin(self.root / "llama-completion.exe"),
            "working_directory": str(self.root), "model": pin(self.root / "model.gguf"),
            "prompt": pin(self.root / "prompt.txt"), "output_schema": pin(self.root / "schema.json"),
            "runtime_files": [pin(self.root / "llama-completion.exe")],
            "input_token_observation": {"count": 100, "prompt_sha256": pin(self.root / "prompt.txt")["sha256"],
                                        "reference": "SOURCE_UNIT_NOT_AUTHORITY"},
            "budget": {"input_tokens": 4096, "output_tokens": 512, "total_tokens": 4608,
                       "wall_seconds": 5, "stdout_bytes": 65536, "stderr_bytes": 65536},
            "deadline_monotonic": time.monotonic() + 30}

    def tearDown(self):
        self.temporary.cleanup()

    def test_four_b_only_model_role_gets_larger_identity_full_rehash_unchanged(self):
        row = dict(self.plan["model"], bytes=2147483649)
        with self.assertRaisesRegex(ValueError, "FILE_SIZE"):
            S.file_identity(row)
        self.assertEqual(S.file_identity(row, model_budget_class=S.FOUR_B_BUDGET_CLASS), Path(row["path"]))
        with self.assertRaisesRegex(ValueError, "FILE_SIZE"):
            S.file_identity(dict(row, bytes=10 * 1024**3 + 1), model_budget_class=S.FOUR_B_BUDGET_CLASS)
        with self.assertRaisesRegex(ValueError, "MODEL_BUDGET_CLASS"):
            S.file_identity(row, model_budget_class="unknown")
        self.assertEqual(S.verify_file(self.plan["model"], time.monotonic()+5,
                         model_budget_class=S.FOUR_B_BUDGET_CLASS), Path(row["path"]))
        with self.assertRaisesRegex(ValueError, "FILE_DRIFT"):
            S.verify_file(dict(self.plan["model"], sha256="0"*64), time.monotonic()+5,
                          model_budget_class=S.FOUR_B_BUDGET_CLASS)
        with self.assertRaisesRegex(ValueError, "DEADLINE"):
            S.verify_file(self.plan["model"], time.monotonic()-1, model_budget_class=S.FOUR_B_BUDGET_CLASS)

    def test_four_b_class_does_not_widen_legacy_unobserved_entry(self):
        plan = copy.deepcopy(self.plan)
        plan.update(cpu_threads=8, development_budget_class=S.FOUR_B_BUDGET_CLASS)
        self.assertEqual(S.development_budget_policy(plan)["model_seconds"],480)
        self.assertEqual(S.development_budget_policy({})["model_seconds"],120)
        with self.assertRaisesRegex(ValueError, "PLAN_FIELDS"):
            S.validate_plan(plan, time.monotonic())
        del plan["development_budget_class"]
        plan["budget"]["wall_seconds"] = 480
        with self.assertRaisesRegex(ValueError, "WALL_BOUND"):
            S.validate_plan(plan, time.monotonic())

    def test_fixed_command_has_no_arbitrary_options_or_server(self):
        S.validate_plan(self.plan, time.monotonic())
        argv = S.command(self.plan)
        self.assertEqual(argv[0], self.plan["executable"]["path"])
        self.assertIn("--no-conversation", argv)
        self.assertEqual(argv[argv.index("--device") + 1], "none")
        self.assertIn("--no-op-offload", argv)
        self.assertIn("--no-kv-offload", argv)
        self.assertEqual(argv[argv.index("--threads") + 1], "2")
        self.assertEqual(argv[argv.index("--threads-batch") + 1], "2")
        self.assertEqual(argv[argv.index("--predict") + 1], "512")
        self.assertNotIn("--server-base", argv)
        bad = copy.deepcopy(self.plan)
        bad["extra_argv"] = ["--model-url", "https://invalid"]
        with self.assertRaisesRegex(ValueError, "PLAN_FIELDS"):
            S.validate_plan(bad, time.monotonic())

    def test_cpu_threads_default_two_and_only_explicit_eight_changes_thread_argv(self):
        legacy = S.command(self.plan)
        for threads in (2, 8):
            with self.subTest(threads=threads):
                plan = copy.deepcopy(self.plan)
                plan["cpu_threads"] = threads
                S.validate_plan(plan, time.monotonic())
                expected = list(legacy)
                for flag in ("--threads", "--threads-batch"):
                    expected[expected.index(flag) + 1] = str(threads)
                self.assertEqual(S.command(plan), expected)
        self.assertNotIn("cpu_threads", self.plan)

    def test_cpu_threads_invalid_type_or_value_and_unknown_option_are_rejected(self):
        for value in (True, False, None, "8", 2.0, 8.0, 0, 1, 3, 4, 16, 2.5, 8.5):
            plan = copy.deepcopy(self.plan)
            plan["cpu_threads"] = value
            with self.subTest(value=value), mock.patch.object(S, "file_identity") as identity:
                with self.assertRaisesRegex(ValueError, "CPU_THREADS"):
                    S.validate_plan(plan, time.monotonic())
                identity.assert_not_called()
                with self.assertRaisesRegex(ValueError, "CPU_THREADS"):
                    S.command(plan)
        plan = copy.deepcopy(self.plan)
        plan.update(cpu_threads=8, threads_batch=8)
        with self.assertRaisesRegex(ValueError, "PLAN_FIELDS"):
            S.validate_plan(plan, time.monotonic())

    @unittest.skipUnless(os.name == "nt", "Windows dispatch is mocked, no runtime child")
    def test_cpu8_plan_digest_and_dispatch_remain_bound(self):
        self.plan["cpu_threads"] = 8
        self.plan["budget"]["wall_seconds"] = 30
        phases = []
        def boundary(phase, view, plan_digest):
            phases.append(phase)
            self.assertEqual(view["cpu_threads"], 8)
            self.assertEqual(plan_digest, S.digest(self.plan))
            self.assertEqual(plan_digest, S.digest(view))
        def transport(argv, *args):
            self.assertEqual(phases, ["preflight", "consume"])
            for flag in ("--threads", "--threads-batch"):
                self.assertEqual(argv[argv.index(flag) + 1], "8")
            return {"outcome": "PROCESS_EXIT", "stdout_raw": b"{}", "stderr_raw": b"",
                    "elapsed_seconds": 0.001, "usage": None, "model_output_validated": False}
        with mock.patch.object(S, "_run_owned", side_effect=transport) as dispatch:
            result = S.execute_fixed_completion(self.plan, boundary=boundary)
        dispatch.assert_called_once()
        self.assertEqual(result["plan_sha256"], S.digest(self.plan))
        def mutate(phase, view, plan_digest):
            view["cpu_threads"] = 2
        with mock.patch.object(S, "_run_owned") as dispatch:
            with self.assertRaisesRegex(ValueError, "BOUNDARY_RESULT_OR_MUTATION"):
                S.execute_fixed_completion(self.plan, boundary=mutate)
            dispatch.assert_not_called()

    def test_required_input_token_observation_matches_prompt_and_total_ceiling(self):
        for change in ({"count": True}, {"count": 0}, {"count": 4097}, {"prompt_sha256": "0" * 64}, {"reference": None}):
            bad = copy.deepcopy(self.plan)
            bad["input_token_observation"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                S.validate_plan(bad, time.monotonic())
        bad = copy.deepcopy(self.plan)
        bad["budget"]["total_tokens"] = 511
        with self.assertRaisesRegex(ValueError, "TOTAL_TOKEN_BOUND"):
            S.validate_plan(bad, time.monotonic())

    def test_invalid_wall_deadline_and_boolean_budget_are_rejected(self):
        for wall in (True, 0, -1, 121, float("inf"), float("nan")):
            bad = copy.deepcopy(self.plan)
            bad["budget"]["wall_seconds"] = wall
            with self.subTest(wall=wall), self.assertRaises(ValueError):
                S.validate_plan(bad, time.monotonic())
        for end in (True, time.monotonic() - 1, time.monotonic() + 1000):
            bad = copy.deepcopy(self.plan)
            bad["deadline_monotonic"] = end
            with self.subTest(end=end), self.assertRaises(ValueError):
                S.validate_plan(bad, time.monotonic())

    def test_mutated_runtime_and_duplicate_closure_are_rejected(self):
        (self.root / "llama-completion.exe").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "FILE_DRIFT|FILE_GROWTH"):
            S.verify_file(self.plan["executable"])
        bad = copy.deepcopy(self.plan)
        bad["runtime_files"] *= 2
        with self.assertRaisesRegex(ValueError, "RUNTIME_CLOSURE_IDS"):
            S.validate_plan(bad, time.monotonic())

    def test_verification_checks_deadline_before_and_after_each_block(self):
        original = Path.open
        class SlowReader:
            def __init__(self, stream):
                self.stream = stream
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.stream.close()
            def read(self, count):
                time.sleep(0.03)
                return self.stream.read(count)
        def opening(path, *args, **kwargs):
            return SlowReader(original(path, *args, **kwargs))
        with mock.patch.object(Path, "open", opening):
            with self.assertRaisesRegex(ValueError, "DEADLINE_DURING_VERIFICATION"):
                S.verify_file(self.plan["prompt"], time.monotonic() + 0.02)

    def test_no_boundary_no_file_reads_or_launch(self):
        with mock.patch.object(S, "verify_file") as verify, mock.patch.object(S.subprocess, "Popen") as launch:
            with self.assertRaisesRegex(ValueError, "TRUSTED_BOUNDARY_REQUIRED"):
                S.execute_fixed_completion(self.plan, boundary=None)
            verify.assert_not_called()
            launch.assert_not_called()

    def test_boolean_or_mutating_boundary_does_not_authorize(self):
        def mutate(phase, view, value):
            view["budget"]["output_tokens"] = 900
        for boundary in (lambda *args: True, mutate):
            with self.subTest(boundary=boundary), mock.patch.object(S.subprocess, "Popen") as launch:
                with self.assertRaisesRegex(ValueError, "BOUNDARY_RESULT_OR_MUTATION"):
                    S.execute_fixed_completion(self.plan, boundary=boundary)
                launch.assert_not_called()

    def test_stalled_boundary_fails_before_dispatch_at_wall_bound(self):
        self.plan["budget"]["wall_seconds"] = 0.1
        def stalled(*args):
            time.sleep(0.5)
        started = time.monotonic()
        with mock.patch.object(S.subprocess, "Popen") as launch:
            with self.assertRaises(TimeoutError):
                S.execute_fixed_completion(self.plan, boundary=stalled)
            launch.assert_not_called()
        self.assertLess(time.monotonic() - started, 0.4)

    @unittest.skipUnless(os.name == "nt", "Windows public primitive fixture only")
    def test_full_plan_checks_then_consumes_once_and_passes_reserved_deadline(self):
        self.plan["budget"]["wall_seconds"] = 30
        phases = []
        def boundary(phase, view, plan_digest):
            phases.append(phase)
            self.assertEqual(plan_digest, S.digest(view))
        def transport(argv, cwd, env, deadline, limits, check):
            self.assertEqual(phases, ["preflight", "consume"])
            self.assertLessEqual(deadline, self.plan["deadline_monotonic"] - S.CLEANUP_RESERVE_SECONDS)
            check("before_start")
            check("before_result")
            return {"outcome": "PROCESS_EXIT", "stdout_raw": b"{}", "stderr_raw": b"",
                    "elapsed_seconds": 0.001, "usage": None, "model_output_validated": False}
        with mock.patch.object(S, "_run_owned", side_effect=transport) as dispatch:
            result = S.execute_fixed_completion(self.plan, boundary=boundary)
        dispatch.assert_called_once()
        self.assertEqual(phases, ["preflight", "consume", "before_start", "before_result"])
        self.assertEqual(result["stdout_retained_sha256"], hashlib.sha256(b"{}").hexdigest())
        self.assertIsNone(result["usage"])

    @unittest.skipUnless(os.name == "nt", "Windows consumption stop fixture only")
    def test_unknown_consumption_never_dispatches_or_retries(self):
        self.plan["budget"]["wall_seconds"] = 30
        phases = []
        def boundary(phase, view, value):
            phases.append(phase)
            if phase == "consume":
                raise TimeoutError("SOURCE_UNIT_RESERVATION_UNKNOWN")
        with mock.patch.object(S, "_run_owned") as dispatch:
            with self.assertRaises(TimeoutError):
                S.execute_fixed_completion(self.plan, boundary=boundary)
            dispatch.assert_not_called()
        self.assertEqual(phases, ["preflight", "consume"])

    @unittest.skipUnless(os.name == "nt", "Windows delayed consumption fixture only")
    def test_late_consumption_reply_is_unknown_without_launch_or_retry(self):
        self.plan["budget"]["wall_seconds"] = 0.15
        phases = []
        def boundary(phase, view, value):
            phases.append(phase)
            if phase == "consume":
                time.sleep(0.4)
        with mock.patch.object(S, "CLEANUP_RESERVE_SECONDS", 0.01), mock.patch.object(S, "_run_owned") as dispatch:
            with self.assertRaises(TimeoutError):
                S.execute_fixed_completion(self.plan, boundary=boundary)
            dispatch.assert_not_called()
        self.assertEqual(phases, ["preflight", "consume"])

    def test_environment_does_not_forward_credentials_proxy_or_preload(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": "SOURCE_TEST", "HTTPS_PROXY": "SOURCE_TEST", "LD_PRELOAD": "SOURCE_TEST"}):
            env = S.clean_environment()
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotIn("LD_PRELOAD", env)


class OwnedProcessTests(unittest.TestCase):
    def execute(self, code, *, wall=2, limit=65536, check=lambda phase: None):
        return S._run_owned([sys.executable, "-c", code], str(ROOT), S.clean_environment(),
                            time.monotonic() + wall, {"stdout": limit, "stderr": limit}, check)

    def test_finite_child_preserves_original_streams_without_model_verdict(self):
        result = self.execute("import os;os.write(1,b'{\\\"ok\\\":1}\\n');os.write(2,b'diagnostic\\n')")
        self.assertEqual(result["outcome"], "PROCESS_EXIT")
        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["stdout_raw"], b'{"ok":1}\n')
        self.assertEqual(result["stderr_raw"], b"diagnostic\n")
        self.assertIsNone(result["usage"])
        self.assertFalse(result["model_output_validated"])
        self.assertTrue(result["capture"]["stdout"]["complete"])
        if os.name == "nt":
            self.assertTrue(result["owned_cleanup_verified"])

    def test_nonzero_exit_is_preserved(self):
        result = self.execute("import sys;sys.exit(7)")
        self.assertEqual(result["outcome"], "PROCESS_EXIT")
        self.assertEqual(result["returncode"], 7)

    def test_pipe_close_failure_preserves_captured_bytes_and_continues_cleanup(self):
        original = S.subprocess.Popen
        closed = []
        class FailingClose:
            def __init__(self, stream):
                self.stream = stream
            def fileno(self):
                return self.stream.fileno()
            def close(self):
                self.stream.close()
                closed.append(True)
                raise OSError("SOURCE_UNIT_CLOSE")
        def spawned(*args, **kwargs):
            process = original(*args, **kwargs)
            process.stdout = FailingClose(process.stdout)
            return process
        with mock.patch.object(S.subprocess, "Popen", spawned):
            result = self.execute("import os;os.write(1,b'original');os.write(2,b'diagnostic')")
        self.assertEqual(result["outcome"], "CLEANUP_UNVERIFIED")
        self.assertEqual(result["stdout_raw"], b"original")
        self.assertEqual(result["stderr_raw"], b"diagnostic")
        self.assertTrue(closed)
        self.assertFalse(result["owned_cleanup_verified"])

    def test_timeout_preserves_emitted_prefix_and_stops_owned_child(self):
        result = self.execute("import os,time;os.write(1,b'prefix');time.sleep(30)", wall=0.4)
        self.assertEqual(result["outcome"], "TIMEOUT")
        self.assertEqual(result["stdout_raw"], b"prefix")
        self.assertIsNotNone(result["final_returncode"])
        self.assertLess(result["elapsed_seconds"], 2)

    def test_output_flood_is_bounded_and_killed(self):
        result = self.execute("import os,time;os.write(1,b'x'*1000000);time.sleep(30)", limit=32)
        self.assertEqual(result["outcome"], "OUTPUT_LIMIT")
        self.assertEqual(result["detail"], "stdout")
        self.assertEqual(result["stdout_raw"], b"x" * 32)
        self.assertTrue(result["capture"]["stdout"]["truncated"])
        self.assertFalse(result["capture"]["stdout"]["complete"])
        self.assertIsNotNone(result["final_returncode"])

    def test_revocation_after_dispatch_stops_child(self):
        count = []
        def check(phase):
            count.append(phase)
            if phase == "running":
                raise ValueError("SOURCE_TEST_REVOCATION")
        result = self.execute("import time;time.sleep(30)", check=check)
        self.assertEqual(result["outcome"], "ADMISSION_LOST")
        self.assertIsNotNone(result["final_returncode"])
        self.assertIn("before_start", count)

    def test_output_chunks_do_not_trigger_one_admission_read_per_chunk(self):
        phases = []
        code = "import os,time;[(os.write(1,b'x'*256),time.sleep(.01)) for _ in range(100)]"
        result = self.execute(code, wall=4, check=phases.append)
        self.assertEqual(result["outcome"], "PROCESS_EXIT")
        self.assertEqual(result["stdout_raw"], b"x" * 25600)
        self.assertEqual(phases, ["before_start", "running", "before_result"])
        self.assertTrue(result["owned_cleanup_verified"] if os.name == "nt" else True)

    def test_quiet_running_child_is_rechecked_and_revocation_reaps_it(self):
        checks = []
        def check(phase):
            if phase == "running":
                checks.append(time.monotonic())
                if len(checks) == 2:
                    raise ValueError("SOURCE_TEST_LATER_REVOCATION")
        result = self.execute("import time;time.sleep(30)", wall=8, check=check)
        self.assertEqual(result["outcome"], "ADMISSION_LOST")
        self.assertEqual(len(checks), 2)
        self.assertGreaterEqual(checks[1] - checks[0], 5)
        self.assertLess(checks[1] - checks[0], 6)
        self.assertIsNotNone(result["final_returncode"])
        self.assertLess(result["elapsed_seconds"], 8)
        if os.name == "nt":
            self.assertTrue(result["owned_cleanup_verified"])

    def test_descendant_holding_pipes_is_owned_and_terminated(self):
        code = "import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);print('parent',flush=True)"
        result = self.execute(code, wall=0.5)
        self.assertEqual(result["outcome"], "TIMEOUT")
        self.assertIn(b"parent", result["stdout_raw"])
        self.assertLess(result["elapsed_seconds"], 2)

    @unittest.skipUnless(os.name == "nt", "Windows assignment failure only")
    def test_failed_job_assignment_kills_suspended_owned_child(self):
        with mock.patch.object(S.WindowsJob, "assign_and_resume", side_effect=ValueError("SOURCE_TEST_ASSIGN")):
            result = self.execute("import time;time.sleep(30)")
        self.assertEqual(result["outcome"], "LAUNCH_FAILURE")
        self.assertIsNotNone(result["final_returncode"])
        self.assertLess(result["elapsed_seconds"], 2)

    @unittest.skipUnless(os.name == "nt", "Windows Job accounting failure only")
    def test_unverified_descendant_cleanup_never_reports_clean_exit(self):
        with mock.patch.object(S.WindowsJob, "wait_empty", side_effect=OSError("SOURCE_TEST_QUERY")):
            result = self.execute("print('fixture')")
        self.assertEqual(result["outcome"], "CLEANUP_UNVERIFIED")
        self.assertFalse(result["owned_cleanup_verified"])

    @unittest.skipUnless(os.name == "nt", "Windows combined overflow/cleanup failure only")
    def test_overflow_capture_flags_survive_cleanup_failure(self):
        with mock.patch.object(S.WindowsJob, "wait_empty", side_effect=OSError("SOURCE_TEST_QUERY")):
            result = self.execute("import os,time;os.write(1,b'x'*1000000);time.sleep(30)", limit=32)
        self.assertEqual(result["outcome"], "CLEANUP_UNVERIFIED")
        self.assertEqual(result["execution_outcome"], "OUTPUT_LIMIT")
        self.assertTrue(result["capture"]["stdout"]["truncated"])
        self.assertFalse(result["capture"]["stdout"]["complete"])
        self.assertGreater(result["capture"]["stdout"]["observed_chunk_bytes"], 32)

    @unittest.skipUnless(os.name == "nt", "Suspended Windows launch deadline only")
    def test_delayed_spawn_is_not_resumed_after_deadline(self):
        original = S.subprocess.Popen
        def delayed(*args, **kwargs):
            process = original(*args, **kwargs)
            time.sleep(0.1)
            return process
        with mock.patch.object(S.subprocess, "Popen", delayed), mock.patch.object(S.WindowsJob, "assign_and_resume") as resume:
            result = self.execute("import time;time.sleep(30)", wall=0.05)
            resume.assert_not_called()
        self.assertEqual(result["outcome"], "LAUNCH_FAILURE")
        self.assertIsNotNone(result["final_returncode"])


if __name__ == "__main__":
    unittest.main()
