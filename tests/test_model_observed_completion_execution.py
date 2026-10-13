"""Observed caller Source tests: finite Python children and hypothetical pins only."""
import builtins
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

