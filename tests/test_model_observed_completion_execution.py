"""Observed caller Source tests: finite Python children and hypothetical pins only."""
import ast
import builtins
from datetime import datetime, timezone
import json
import math
import queue
import threading
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/model-program"
L_PATH = SCRIPTS / "local_completion_execution.py"
l_spec = importlib.util.spec_from_file_location("observed_legacy_spec", L_PATH)
L = importlib.util.module_from_spec(l_spec); l_spec.loader.exec_module(L)
S_PATH = SCRIPTS / "observed_completion_execution.py"
S = types.ModuleType("observed_caller_spec")
S.__file__ = str(S_PATH)
names = dict(vars(builtins))
def private_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "local_completion_execution" and level == 0:
        return L
    return builtins.__import__(name, globals, locals, fromlist, level)
names["__import__"] = private_import
S.__dict__["__builtins__"] = names
exec(compile(S_PATH.read_bytes(), str(S_PATH), "exec"), S.__dict__)

def pin(path):
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


class ObservedCallerSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("CLUED_MODEL_SOURCE_TEST_TEMP_ROOT"))
        self.root = Path(self.tmp.name).resolve()
        rows = []
        for name in S.RUNTIME_FILES:
            path = self.root / name
            path.write_bytes(b"SOURCE_FIXTURE_NOT_RUNTIME")
            rows.append(pin(path))
        for name in ("model.gguf", "prompt.txt", "schema.json"):
            (self.root / name).write_bytes(b"NONMODEL_SOURCE_FIXTURE")
        self.plan = {"executable": next(r for r in rows if Path(r["path"]).name == "llama-completion.exe"),
            "working_directory": str(self.root), "runtime_files": rows,
            **{k: pin(self.root / v) for k,v in (("model","model.gguf"),("prompt","prompt.txt"),("output_schema","schema.json"))},
            "observation_path": str(self.root / "new-observation.jsonl"), "patch_sha256": S.PATCH_SHA256,
            "budget": {"input_tokens": 4096, "output_tokens": 512, "total_tokens": 4608,
                       "wall_seconds": 20, "stdout_bytes": 65536, "stderr_bytes": 65536,
                       "observation_bytes": 131072}, "deadline_monotonic": time.monotonic()+60}
        self.fixture_pins = {Path(r["path"]).name:(r["bytes"],r["sha256"]) for r in rows}

    def tearDown(self):
        self.tmp.cleanup()

    def four_b_plan(self):
        plan = copy.deepcopy(self.plan)
        plan.update(cpu_threads=8, development_budget_class=L.FOUR_B_BUDGET_CLASS, patch_sha256=S.FOUR_B_PATCH_SHA256)
        plan["budget"].update(control_wall_seconds=585, wall_seconds=480, output_tokens=1024,
                              total_tokens=5120, observation_bytes=147456)
        plan["deadline_monotonic"] = time.monotonic()+580
        return plan

    def test_four_b_unknown_class_or_wrong_patch_fails_before_file_io(self):
        plan = self.four_b_plan()
        with mock.patch.object(L,"file_identity") as identity, mock.patch.object(S,"_transport") as transport:
            boundary = mock.Mock()
            unknown=copy.deepcopy(plan);unknown["development_budget_class"]="unknown"
            with self.assertRaisesRegex(ValueError,"DEVELOPMENT_BUDGET_CLASS"):
                S.execute_observed_completion(unknown,boundary=boundary)
            plan["patch_sha256"]=S.PATCH_SHA256
            with self.assertRaisesRegex(ValueError,"PATCH_PIN"):
                S.validate_plan(plan,time.monotonic())
            identity.assert_not_called();transport.assert_not_called();boundary.assert_not_called()

    def test_actual_new_runtime_table_accepts_exact_and_rejects_mixed_or_legacy(self):
        plan=self.four_b_plan()
        for row in plan["runtime_files"]:
            row["bytes"],row["sha256"]=S.FOUR_B_RUNTIME_FILES[Path(row["path"]).name]
        plan["executable"]=next(r for r in plan["runtime_files"] if Path(r["path"]).name=="llama-completion.exe")
        # Only the pure plan/closure boundary is exercised; no artifact is loaded.
        self.assertEqual(S.validate_plan(plan,time.monotonic()),plan["deadline_monotonic"])
        for name in ("ggml-base.dll","llama-completion.exe"):
            bad=copy.deepcopy(plan)
            row=next(r for r in bad["runtime_files"] if Path(r["path"]).name==name)
            row["bytes"],row["sha256"]=S.RUNTIME_FILES[name]
            if name=="llama-completion.exe":bad["executable"]=row
            with self.assertRaisesRegex(ValueError,"RUNTIME_PIN"):S.validate_plan(bad,time.monotonic())
        legacy=copy.deepcopy(plan);del legacy["development_budget_class"]
        legacy["budget"].update(output_tokens=512,total_tokens=4608,wall_seconds=120,
                                control_wall_seconds=225,observation_bytes=131072)
        legacy["deadline_monotonic"]=time.monotonic()+200;legacy["patch_sha256"]=S.PATCH_SHA256
        with self.assertRaisesRegex(ValueError,"RUNTIME_PIN"):S.validate_plan(legacy,time.monotonic())

    def test_four_b_fixture_caps_role_identity_and_legacy_runtime_are_separate(self):
        plan = self.four_b_plan()
        plan["patch_sha256"]="f"*64
        plan["model"]["bytes"] = 2147483649  # Metadata fixture only; no giant file/read.
        with mock.patch.object(S,"FOUR_B_RUNTIME_FILES",self.fixture_pins), \
                mock.patch.object(S,"FOUR_B_PATCH_SHA256","f"*64), \
                mock.patch.object(L,"file_identity",wraps=L.file_identity) as identity:
            self.assertEqual(S.validate_plan(plan,time.monotonic()),plan["deadline_monotonic"])
            calls=[c for c in identity.call_args_list if c.kwargs]
            self.assertEqual(len(calls),1)
            self.assertEqual(calls[0].args[0],plan["model"])
            self.assertEqual(calls[0].kwargs,{"model_budget_class":L.FOUR_B_BUDGET_CLASS})
            argv=S.command(plan,123)
            self.assertEqual(argv[argv.index("--predict")+1],"1024")
            self.assertEqual(argv[argv.index("--threads")+1],"8")
            for name, limit in (("wall_seconds",481),("control_wall_seconds",586),("output_tokens",1025),
                                ("total_tokens",5121),("observation_bytes",147457)):
                bad=copy.deepcopy(plan);bad["budget"][name]=limit
                with self.assertRaises(ValueError):S.validate_plan(bad,time.monotonic())
            bad=copy.deepcopy(plan);bad["deadline_monotonic"]=time.monotonic()+586
            with self.assertRaisesRegex(ValueError,"DEADLINE"):S.validate_plan(bad,time.monotonic())
            bad=copy.deepcopy(plan);bad["patch_sha256"]=S.PATCH_SHA256
            with self.assertRaisesRegex(ValueError,"PATCH_PIN"):S.validate_plan(bad,time.monotonic())
        old=copy.deepcopy(plan);del old["development_budget_class"]
        old["patch_sha256"]=S.PATCH_SHA256
        with self.assertRaisesRegex(ValueError,"BUDGET_OUTPUT_TOKENS"):
            S.validate_plan(old,time.monotonic())

    @unittest.skipUnless(os.name == "nt", "Windows observed control flow with mocked transport")
    def test_control_budget_cannot_silently_expand_model_runtime(self):
        clock = [time.monotonic()]
        self.plan["budget"].update(control_wall_seconds=225, wall_seconds=20)
        self.plan["deadline_monotonic"] = clock[0] + 210
        def boundary(phase, view, seal, opened):
            if phase in ("preflight", "before_observation_open", "observation_opened", "consume"):
                clock[0] += 16  # Replay slow control reads without sleeping or a model.
        def transport(argv, cwd, env, deadline, limits, check, stream):
            self.assertEqual(deadline, clock[0] + 20,
                "Actual spawn/Job/pipe primitive must receive the model cutoff")
            check("before_start")
            clock[0] += 19
            check("before_resume")
            clock[0] += 2
            with self.assertRaisesRegex(ValueError, "BOUNDARY_DEADLINE"):
                check("running")
            return {"outcome": "TIMEOUT", "returncode": None, "owned_cleanup_verified": True,
                    "stdout_raw": b"", "stderr_raw": b"", "elapsed_seconds": 21}
        with mock.patch.object(S, "RUNTIME_FILES", self.fixture_pins), \
                mock.patch.object(L.time, "monotonic", side_effect=lambda: clock[0]), \
                mock.patch.object(S, "_transport", side_effect=transport):
            got = S.execute_observed_completion(self.plan, boundary=boundary)
        self.assertEqual(got["outcome"], "TIMEOUT")
        self.assertFalse(got["model_output_validated"])

    @unittest.skipUnless(os.name == "nt", "Windows observed control flow with mocked transport")
    def test_control_deadline_remains_shorter_than_model_budget_when_needed(self):
        clock = [time.monotonic()]
        self.plan["budget"].update(control_wall_seconds=60, wall_seconds=120)
        self.plan["deadline_monotonic"] = clock[0] + 60
        def transport(argv, cwd, env, deadline, limits, check, stream):
            check("before_start")
            clock[0] += 61
            with self.assertRaisesRegex(ValueError, "BOUNDARY_DEADLINE"):
                check("before_resume")
            return {"outcome": "TIMEOUT", "returncode": None, "owned_cleanup_verified": True,
                    "stdout_raw": b"", "stderr_raw": b"", "elapsed_seconds": 61}
        with mock.patch.object(S, "RUNTIME_FILES", self.fixture_pins), \
                mock.patch.object(L.time, "monotonic", side_effect=lambda: clock[0]), \
                mock.patch.object(S, "_transport", side_effect=transport):
            got = S.execute_observed_completion(self.plan, boundary=lambda *args: None)
        self.assertEqual(got["outcome"], "OBSERVATION_UNVERIFIED")

    def test_control_budget_invalid_values_reject_before_file_effects(self):
        for value in (True, 0, 226, float("nan")):
            self.plan["budget"]["control_wall_seconds"] = value
            with mock.patch.object(Path, "open") as opening, mock.patch.object(S, "_transport") as run:
                with self.assertRaises(ValueError):
                    S.execute_observed_completion(self.plan, boundary=lambda *args: None)
                opening.assert_not_called()
                run.assert_not_called()

    def test_fixed_successor_command_and_runtime_pins_fail_closed(self):
        argv = S.command(self.plan, 123)
        self.assertEqual(argv[argv.index("--clued-observation-handle")+1],"123")
        self.assertEqual(argv[argv.index("--clued-input-token-limit")+1],"4096")
        self.assertIn("--no-warmup",argv)
        with self.assertRaisesRegex(ValueError,"RUNTIME_PIN"):
            S.validate_plan(self.plan,time.monotonic())
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins):
            S.validate_plan(self.plan,time.monotonic())
            bad=copy.deepcopy(self.plan);bad["extra_argv"]=["--model-url","https://invalid"]
            with self.assertRaisesRegex(ValueError,"PLAN_FIELDS"):
                S.validate_plan(bad,time.monotonic())

    def test_cpu_threads_optional_selection_preserves_legacy_argv_and_closure(self):
        legacy = S.command(self.plan, 123)
        self.assertEqual(legacy[legacy.index("--threads") + 1], "2")
        self.assertEqual(legacy[legacy.index("--threads-batch") + 1], "2")
        with mock.patch.object(S, "RUNTIME_FILES", self.fixture_pins):
            S.validate_plan(self.plan, time.monotonic())
            for threads in (2, 8):
                with self.subTest(threads=threads):
                    plan = copy.deepcopy(self.plan)
                    plan["cpu_threads"] = threads
                    S.validate_plan(plan, time.monotonic())
                    expected = list(legacy)
                    for flag in ("--threads", "--threads-batch"):
                        expected[expected.index(flag) + 1] = str(threads)
                    self.assertEqual(S.command(plan, 123), expected)
        self.assertNotIn("cpu_threads", self.plan)

    def test_cpu_threads_invalid_values_or_unknown_options_have_no_file_io_or_transport(self):
        for value in (True, False, None, "8", 2.0, 8.0, 0, 1, 3, 4, 16, 2.5, 8.5):
            plan = copy.deepcopy(self.plan)
            plan["cpu_threads"] = value
            with self.subTest(value=value), mock.patch.object(Path, "open") as opening, \
                    mock.patch.object(S, "_transport") as run:
                with self.assertRaisesRegex(ValueError, "CPU_THREADS"):
                    S.validate_plan(plan, time.monotonic())
                opening.assert_not_called(); run.assert_not_called()
        plan = copy.deepcopy(self.plan)
        plan.update(cpu_threads=8, threads_batch=8)
        with mock.patch.object(Path, "open") as opening, mock.patch.object(S, "_transport") as run:
            with self.assertRaisesRegex(ValueError, "PLAN_FIELDS"):
                S.validate_plan(plan, time.monotonic())
            opening.assert_not_called(); run.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows observed dispatch is mocked, no runtime child")
    def test_cpu8_observed_caller_binds_frozen_plan_and_both_flags_to_mock_transport(self):
        self.plan["cpu_threads"] = 8
        phases = []
        def boundary(phase, view, seal, opened):
            phases.append(phase)
            self.assertEqual(view["cpu_threads"], 8)
            self.assertEqual(seal, L.digest(self.plan))
            self.assertEqual(seal, L.digest(view))
        def transport(argv, cwd, env, deadline, limits, check, stream):
            self.assertEqual(phases[:4], ["preflight", "before_observation_open", "observation_opened", "consume"])
            for flag in ("--threads", "--threads-batch"):
                self.assertEqual(argv[argv.index(flag) + 1], "8")
            self.assertIn("--clued-observation-handle", argv)
            check("before_resume"); check("before_result")
            stream.write(b'{"fixture":true}\n'); stream.flush()
            return {"outcome": "PROCESS_EXIT", "returncode": 0, "owned_cleanup_verified": True,
                    "stdout_raw": b"{}", "stderr_raw": b"", "usage": None, "elapsed_seconds": 0.01}
        with mock.patch.object(S, "RUNTIME_FILES", self.fixture_pins), \
                mock.patch.object(S, "_transport", side_effect=transport) as run:
            result = S.execute_observed_completion(self.plan, boundary=boundary)
        run.assert_called_once()
        self.assertEqual(result["plan_sha256"], L.digest(self.plan))
        self.assertIn("before_resume", phases); self.assertIn("before_result", phases)
        self.assertEqual(result["observation_capture"]["raw"], b'{"fixture":true}\n')
        self.assertIsNone(result["usage"]); self.assertFalse(result["model_output_validated"])
        def mutate(phase, view, seal, opened):
            view["cpu_threads"] = 2
        with mock.patch.object(Path, "open") as opening, mock.patch.object(S, "_transport") as run:
            with self.assertRaisesRegex(ValueError, "BOUNDARY_RESULT_OR_MUTATION"):
                S.execute_observed_completion(self.plan, boundary=mutate)
            opening.assert_not_called(); run.assert_not_called()

    def test_no_boundary_and_mutating_boundary_have_no_io_or_launch(self):
        with mock.patch.object(Path,"open") as opening, mock.patch.object(S,"_transport") as run:
            with self.assertRaisesRegex(ValueError,"TRUSTED_BOUNDARY"):
                S.execute_observed_completion(self.plan,boundary=None)
            opening.assert_not_called();run.assert_not_called()
        def mutate(phase,view,seal,opened):view["budget"]["output_tokens"]=900
        with mock.patch.object(S,"_transport") as run:
            with self.assertRaisesRegex(ValueError,"BOUNDARY_RESULT_OR_MUTATION"):
                S.execute_observed_completion(self.plan,boundary=mutate)
            run.assert_not_called()
        self.assertFalse(Path(self.plan["observation_path"]).exists())

    def test_budget_unknown_fields_existing_output_and_alias_rejected(self):
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins):
            for value in (True,0,131073):
                bad=copy.deepcopy(self.plan);bad["budget"]["observation_bytes"]=value
                with self.subTest(value=value),self.assertRaises(ValueError):S.validate_plan(bad,time.monotonic())
            Path(self.plan["observation_path"]).write_bytes(b"keep")
            with self.assertRaisesRegex(ValueError,"NEW_OBSERVATION"):
                S.validate_plan(self.plan,time.monotonic())
            self.assertEqual(Path(self.plan["observation_path"]).read_bytes(),b"keep")

    def test_observation_capture_retains_prefix_and_marks_incomplete(self):
        path=self.root/"capture"
        path.write_bytes(b"abcdef")
        with path.open("r+b") as stream:
            got=S._capture_observation(stream,3,time.monotonic()+1)
        self.assertEqual(got["raw"],b"abc");self.assertTrue(got["truncated"])
        self.assertFalse(got["complete"]);self.assertEqual(got["observed_bytes"],4)

    def test_late_capture_return_keeps_already_read_bytes(self):
        class LateRead:
            def seek(self,value):pass
            def read(self,maximum):return b"already-read"
        with mock.patch.object(L.time,"monotonic",side_effect=[0.0,2.0]):
            got=S._capture_observation(LateRead(),100,1.0)
        self.assertEqual(got["raw"],b"already-read")
        self.assertTrue(got["late"]);self.assertFalse(got["complete"])

    @unittest.skipUnless(os.name=="nt","Windows inherited-handle Source child only")
    def test_only_designated_handle_reaches_finite_child_and_parent_reset(self):
        import msvcrt
        output=self.root/"child-observation";foreign=self.root/"foreign"
        with output.open("x+b") as stream,foreign.open("x+b") as extra:
            extra.write(b"PRIVATE_SOURCE_SENTINEL");extra.flush();extra.seek(0)
            handle=msvcrt.get_osfhandle(stream.fileno())
            other=msvcrt.get_osfhandle(extra.fileno())
            os.set_handle_inheritable(other,True)
            child="""import ctypes,sys
k=ctypes.WinDLL('kernel32')
k.ReadFile.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_void_p]
buf=ctypes.create_string_buffer(64);read=ctypes.c_ulong()
try:
    k.ReadFile(int(sys.argv[2]),buf,64,ctypes.byref(read),None)
except OSError:
    pass
assert buf.raw[:read.value] != b'PRIVATE_SOURCE_SENTINEL'
k.WriteFile.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_void_p]
n=ctypes.c_ulong()
assert k.WriteFile(int(sys.argv[1]),b'fixture',7,ctypes.byref(n),None)
print('ok')
"""
            try:
                got=S._transport([sys.executable,"-c",child,str(handle),str(other)],
                    str(self.root),L.clean_environment(),time.monotonic()+3,
                    {"stdout":1024,"stderr":1024},lambda phase:None,stream)
            finally:os.set_handle_inheritable(other,False)
            self.assertEqual(got["returncode"],0,got["stderr_raw"].decode(errors="replace"));self.assertTrue(got["owned_cleanup_verified"])
            self.assertFalse(os.get_handle_inheritable(handle))
            stream.seek(0);self.assertEqual(stream.read(),b"fixture")
            extra.seek(0);self.assertEqual(extra.read(),b"PRIVATE_SOURCE_SENTINEL")

    @unittest.skipUnless(os.name=="nt","Windows successor public Source fixture only")
    def test_full_verified_plan_consumes_before_nonmodel_transport_and_preserves_raw(self):
        phases=[]
        def boundary(phase,view,seal,opened):
            phases.append(phase)
            if phase in ("preflight","before_observation_open"):self.assertIsNone(opened)
            else:self.assertEqual(opened["size"],0);self.assertEqual(opened["links"],1)
        def transport(argv,cwd,env,deadline,limits,check,stream):
            self.assertIn("consume",phases)
            stream.write(b'{"fixture":true}\n');stream.flush()
            return {"outcome":"PROCESS_EXIT","returncode":0,"owned_cleanup_verified":True,
                    "stdout_raw":b"{}", "stderr_raw":b"", "usage":None, "elapsed_seconds":0.01}
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins),mock.patch.object(S,"_transport",transport):
            got=S.execute_observed_completion(self.plan,boundary=boundary)
        self.assertEqual(phases[:4],["preflight","before_observation_open","observation_opened","consume"])
        self.assertEqual(got["observation_capture"]["raw"],b'{"fixture":true}\n')
        self.assertIsNone(got["usage"]);self.assertFalse(got["model_output_validated"])

    @unittest.skipUnless(os.name=="nt","Windows handle reset stop Source fixture only")
    def test_reset_failure_never_resumes_owned_child(self):
        path=self.root/"reset-failure";marker=self.root/"must-not-exist"
        real=os.set_handle_inheritable
        def setting(handle,enabled):
            real(handle,enabled)
            if not enabled:raise OSError("Hypothetical reset failure after effective reset")
        with path.open("x+b") as stream,mock.patch.object(S.os,"set_handle_inheritable",setting):
            got=S._transport([sys.executable,"-c","from pathlib import Path;Path(__import__('sys').argv[1]).write_text('ran')",str(marker)],
                str(self.root),L.clean_environment(),time.monotonic()+3,
                {"stdout":1024,"stderr":1024},lambda phase:None,stream)
        self.assertFalse(marker.exists());self.assertEqual(got["outcome"],"CLEANUP_UNVERIFIED")
        self.assertFalse(got["owned_cleanup_verified"])

    @unittest.skipUnless(os.name=="nt","Windows revocation before resume Source child only")
    def test_revocation_before_resume_never_runs_child(self):
        marker=self.root/"revoked-child-marker"
        def current(phase):
            if phase=="before_resume":raise ValueError("HYPOTHETICAL_REVOKED")
        with (self.root/"revoked-output").open("x+b") as stream:
            got=S._transport([sys.executable,"-c","from pathlib import Path;Path(__import__('sys').argv[1]).write_text('ran')",str(marker)],
                str(self.root),L.clean_environment(),time.monotonic()+3,
                {"stdout":1024,"stderr":1024},current,stream)
        self.assertFalse(marker.exists());self.assertEqual(got["outcome"],"LAUNCH_FAILURE")
        self.assertTrue(got["owned_cleanup_verified"])

    @unittest.skipUnless(os.name=="nt","Windows capture close failure Source fixture only")
    def test_close_failure_preserves_capture_and_marks_unverified(self):
        original=Path.open
        class ClosingFailure:
            def __init__(self,stream):self.stream=stream
            def __getattr__(self,key):return getattr(self.stream,key)
            def close(self):self.stream.close();raise OSError("Hypothetical close failure")
        def opening(path,*args,**kwargs):
            stream=original(path,*args,**kwargs)
            return ClosingFailure(stream) if args and args[0]=="x+b" else stream
        def transport(argv,cwd,env,deadline,limits,check,stream):
            stream.write(b"retained");stream.flush()
            return {"outcome":"PROCESS_EXIT","returncode":0,"owned_cleanup_verified":True,
                    "stdout_raw":b"{}","stderr_raw":b"","elapsed_seconds":0.01}
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins),mock.patch.object(S,"_transport",transport),mock.patch.object(Path,"open",opening):
            got=S.execute_observed_completion(self.plan,boundary=lambda *args:None)
        self.assertEqual(got["observation_capture"]["raw"],b"retained")
        self.assertEqual(got["outcome"],"CLEANUP_UNVERIFIED");self.assertFalse(got["owned_cleanup_verified"])

    @unittest.skipUnless(os.name=="nt","Windows consume stop Source fixture only")
    def test_lost_or_unknown_consume_never_dispatches_or_retries(self):
        def reject(phase,view,seal,opened):
            if phase=="consume":raise ValueError("HYPOTHETICAL_REVOKED")
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins),mock.patch.object(S,"_transport") as run:
            with self.assertRaisesRegex(ValueError,"HYPOTHETICAL_REVOKED"):
                S.execute_observed_completion(self.plan,boundary=reject)
            run.assert_not_called()
        self.assertTrue(Path(self.plan["observation_path"]).exists())
        self.assertEqual(Path(self.plan["observation_path"]).read_bytes(),b"")

    @unittest.skipUnless(os.name=="nt","Windows late object validation Source fixture only")
    def test_late_object_validation_never_issues_new_consume(self):
        phases=[];clock=[time.monotonic()]
        self.plan["deadline_monotonic"]=clock[0]+20
        def boundary(phase,view,seal,opened):
            phases.append(phase)
            if phase=="observation_opened":clock[0]+=8
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins),mock.patch.object(L.time,"monotonic",side_effect=lambda:clock[0]),mock.patch.object(S,"_transport") as run:
            with self.assertRaisesRegex(ValueError,"DEADLINE_BEFORE_CONSUME"):
                S.execute_observed_completion(self.plan,boundary=boundary)
            run.assert_not_called()
        self.assertEqual(phases,["preflight","before_observation_open","observation_opened"])

    @unittest.skipUnless(os.name=="nt","Windows pre-open namespace Source fixture only")
    def test_last_namespace_check_is_after_file_hashes_and_before_open(self):
        order=[]
        original=L.verify_file
        def verify(*args,**kwargs):
            order.append("hash")
            return original(*args,**kwargs)
        def boundary(phase,view,seal,opened):
            order.append(phase)
            if phase=="before_observation_open":
                self.assertEqual(order.count("hash"),len(self.plan["runtime_files"])+3)
                self.assertFalse(Path(self.plan["observation_path"]).exists())
                raise ValueError("NAMESPACE_DRIFT")
        with mock.patch.object(S,"RUNTIME_FILES",self.fixture_pins),mock.patch.object(L,"verify_file",side_effect=verify),mock.patch.object(S,"_transport") as run:
            with self.assertRaisesRegex(ValueError,"NAMESPACE_DRIFT"):
                S.execute_observed_completion(self.plan,boundary=boundary)
            run.assert_not_called()
        self.assertFalse(Path(self.plan["observation_path"]).exists())



class Clock:
    now = 100.0
    def monotonic(self):
        return self.now


class Stream:
    closed = False
    def fileno(self):
        return 1
    def close(self):
        self.closed = True


def isolated_candidate(transport):
    # Only compile the timing helpers and execution function. All process/file/
    # validation boundaries are explicit in-memory technical stubs; no provider.
    tree = ast.parse((S_PATH).read_bytes())
    names = {"require", "_capture_provider_timepoint", "_provider_timing_observation", "execute_observed_completion"}
    selected = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
    clock, stream = Clock(), Stream()
    phases = []
    legacy = types.SimpleNamespace(time=clock, CLEANUP_RESERVE_SECONDS=15,
        digest=lambda value: json.dumps(value, sort_keys=True), verify_file=lambda *_, **__: None,
        clean_environment=lambda: {})
    importer = builtins.__import__
    def local_import(name, *args, **kwargs):
        if name == "msvcrt":
            return types.SimpleNamespace(get_osfhandle=lambda _: 1)
        return importer(name, *args, **kwargs)
    ns = {"__builtins__": dict(vars(builtins), __import__=local_import), "copy": copy, "datetime": datetime,
          "timezone": timezone, "math": math, "queue": queue, "threading": threading,
          "os": types.SimpleNamespace(name="nt"), "legacy": legacy, "_CLOCK_NOT_READ": object(),
          "Path": lambda _: types.SimpleNamespace(open=lambda _: stream),
          "validate_plan": lambda *_: None, "_opened_identity": lambda _: {"size": 0, "links": 1},
           "runtime_policy": lambda plan: (L.development_budget_policy(plan), None, None),
          "command": lambda *_: ["technical-in-memory-transport"],
          "_capture_observation": lambda *_: {"complete": True}}
    ns["_transport"] = lambda *args: transport(clock, *args)
    exec(compile(selected, "isolated_timing_candidate", "exec"), ns)
    def boundary(phase, *_):
        phases.append(phase)
        clock.now += 7 if phase == "before_start" else 1
    plan = {"deadline_monotonic": 300.0, "budget": {"control_wall_seconds": 225, "wall_seconds": 120,
            "stdout_bytes": 32, "stderr_bytes": 32, "observation_bytes": 32}, "runtime_files": [],
            "model": {}, "prompt": {}, "output_schema": {}, "observation_path": "technical-only",
            "working_directory": "technical-only"}
    return ns, plan, boundary, phases, stream


class ProviderTimingChecks(unittest.TestCase):
    def test_four_b_model_deadline_never_resets_and_control_cutoff_is_preserved(self):
        deadlines=[]
        def transport(clock,argv,cwd,env,deadline,limits,check,stream):
            deadlines.append(deadline)
            before=clock.now
            check("before_start")
            self.assertEqual(deadlines[-1],deadline)
            clock.now=deadline
            with self.assertRaisesRegex(ValueError,"BOUNDARY_DEADLINE"):
                check("running")
            self.assertGreaterEqual(clock.now,before)
            return {"outcome":"TIMEOUT","owned_cleanup_verified":True}
        ns,plan,boundary,phases,stream=isolated_candidate(transport)
        plan.update(cpu_threads=8,development_budget_class=L.FOUR_B_BUDGET_CLASS,deadline_monotonic=685.0)
        plan["budget"].update(wall_seconds=480,control_wall_seconds=585)
        result=ns["execute_observed_completion"](plan,boundary=boundary)
        self.assertEqual(result["outcome"],"TIMEOUT")
        self.assertEqual(len(deadlines),1)
        self.assertLessEqual(deadlines[0],670.0)  # Original 585-second stop minus cleanup.
        self.assertTrue(stream.closed)

    def test_before_start_cost_is_included_repeated_check_does_not_reset_deadline(self):
        captured = []
        def transport(clock, argv, cwd, env, deadline, limits, check, stream):
            captured.append(deadline)
            check("before_start")
            check("before_resume")
            clock.now += 40
            check("before_start")
            return {"outcome": "PROCESS_EXIT", "returncode": 0, "owned_cleanup_verified": True}
        ns, plan, boundary, phases, stream = isolated_candidate(transport)
        result = ns["execute_observed_completion"](plan, boundary=boundary)
        self.assertEqual(captured, [224.0])  #104+120, excludes no control time.
        self.assertEqual(phases.count("before_start"), 1)
        timing = result["provider_timing_observation"]
        self.assertEqual(timing["started"]["monotonic_seconds"], 104.0)
        self.assertEqual(timing["transport_settled"]["monotonic_seconds"], 152.0)
        self.assertEqual(timing["monotonic_elapsed_ms"], 48000.0)
        self.assertEqual(result["elapsed_seconds"], 52.0)
        self.assertEqual(result["elapsed_seconds_scope"], "WHOLE_OBSERVED_EXECUTION_ENTRY")
        self.assertIsNone(result["usage"])
        self.assertFalse(result["model_output_validated"])
        self.assertIsNone(timing["adopted_v2_usage"])
        self.assertEqual(timing["authority_effect"], "NONE")
        self.assertTrue(stream.closed)

    def test_expired_repeated_before_start_is_not_renewed_by_timing_capture(self):
        def transport(clock, argv, cwd, env, deadline, limits, check, stream):
            self.assertEqual(deadline, 224.0)
            clock.now = deadline
            check("before_start")
            self.fail("expired original deadline was renewed")
        ns, plan, boundary, phases, stream = isolated_candidate(transport)
        with self.assertRaisesRegex(ValueError, "BOUNDARY_DEADLINE"):
            ns["execute_observed_completion"](plan, boundary=boundary)
        self.assertEqual(phases.count("before_start"), 1)
        self.assertTrue(stream.closed)

    def test_clock_failures_regressions_and_invalid_utc_stay_explicit(self):
        ns, _, _, _, _ = isolated_candidate(lambda *_: None)
        class BrokenDatetime(datetime):
            @classmethod
            def now(cls, _):
                raise OSError("technical clock failure")
        def fail_monotonic():
            raise RuntimeError("technical clock failure")
        ns["datetime"] = BrokenDatetime
        ns["legacy"].time = types.SimpleNamespace(monotonic=fail_monotonic)
        point = ns["_capture_provider_timepoint"]()
        self.assertIsNone(point["monotonic_seconds"])
        self.assertIsNone(point["utc_rfc3339"])
        self.assertEqual(point["clock_errors"], ["MONOTONIC_READ_FAILED:RuntimeError", "UTC_READ_FAILED:OSError"])
        timing = ns["_provider_timing_observation"](point, point)
        self.assertFalse(timing["measurement_complete"])
        self.assertIsNone(timing["monotonic_elapsed_ms"])
        self.assertIsNone(timing["adopted_v2_usage"])
        ns["datetime"] = datetime
        for first, last in [
            ({"monotonic_seconds": 10, "utc_rfc3339": "2031-01-01T00:00:02Z", "clock_errors": []},
             {"monotonic_seconds": 9, "utc_rfc3339": "2031-01-01T00:00:01Z", "clock_errors": []}),
            ({"monotonic_seconds": 10, "utc_rfc3339": "invalid", "clock_errors": []},
             {"monotonic_seconds": 11, "utc_rfc3339": "invalid", "clock_errors": []})]:
            timing = ns["_provider_timing_observation"](first, last)
            self.assertFalse(timing["measurement_complete"])
            self.assertTrue(timing["clock_errors"])
            self.assertIsNone(timing["adopted_v2_usage"])
        for value in (float("nan"), float("inf"), True):
            self.assertIsNone(ns["_capture_provider_timepoint"](value)["monotonic_seconds"])

    def test_runtime_guard_command_transport_and_capture_source_pins_remain_fixed(self):
        # The reviewed guard adds explicit class ceilings, its exact runtime
        # closure, and the model-only size role. Legacy defaults are preserved;
        # command/transport/capture helpers retain their prior exact text pins.
        expected = {
            "require": "208b5b2b2b4054dae0ef9fc405dff7e09333a576dd4b9bc7adbf3bd0b2638046",
            "validate_plan": "34a45c682362d3a64048b04c5b881de01e3406bbf0b0633a7df612e814fa0770",
            "command": "c51017f8b60dd6956d52ac92dd9de5ee0127ee7f5de196d4e30e14904ad04fd2",
            "_opened_identity": "e36f5ab2ace0d7722af6a56e9ad0ac2b311718d96c5dc7a43d75d97cb983288c",
            "_transport": "6e58afa18b7321e05dbabf2ae75c039d8590ce956c5df342ed3f09a0987b0342",
            "_capture_observation": "464536a25f0cf13fdff584fa99fa27155bed67d4972e509d1cfa51e59b617b2e"}
        source = S_PATH.read_text()
        tree = ast.parse(source)
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256(ast.get_source_segment(source, functions[name]).encode()).hexdigest(), digest, name)
