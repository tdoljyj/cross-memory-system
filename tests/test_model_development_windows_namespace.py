"""Real native Windows metadata tests on new disposable Source fixtures only."""
import ctypes
from ctypes import wintypes as W
import importlib.util
import os
from pathlib import Path
import tempfile
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/model-program/development_windows_namespace.py"
spec = importlib.util.spec_from_file_location("development_namespace_test_subject", SCRIPT)
N = importlib.util.module_from_spec(spec)
spec.loader.exec_module(N)


def set_fixture_dacl(path, sddl):
    native = N.WindowsMetadata()
    native.a.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        W.LPCWSTR, W.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(W.DWORD)]
    native.a.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = W.BOOL
    native.a.SetFileSecurityW.argtypes = [W.LPCWSTR, W.DWORD, ctypes.c_void_p]
    native.a.SetFileSecurityW.restype = W.BOOL
    descriptor, size = ctypes.c_void_p(), W.DWORD()
    if not native.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1,
            ctypes.byref(descriptor), ctypes.byref(size)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not native.a.SetFileSecurityW(str(path), 0x80000004, descriptor):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        native.k.LocalFree(descriptor)


def opened(stream):
    import msvcrt
    info = os.fstat(stream.fileno())
    return {"handle": msvcrt.get_osfhandle(stream.fileno()), "device": info.st_dev,
            "inode": info.st_ino, "links": info.st_nlink, "size": info.st_size}


@unittest.skipUnless(os.name == "nt", "Actual Windows ABI qualification requires Windows")
class NativeNamespaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("CLUED_MODEL_SOURCE_TEST_TEMP_ROOT"))
        self.root = Path(self.tmp.name).resolve()
        sid = N.WindowsMetadata().operator_sid()
        self.private = "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        self.ledger, self.output = self.root / "ledger", self.root / "output"
        for path in (self.ledger, self.output):
            path.mkdir()
            set_fixture_dacl(path, self.private)
        self.observation = self.output / "observation.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_actual_handle_identity_and_private_acl_before_consume(self):
        with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
            space.check("preflight", str(self.ledger), str(self.observation), None)
            with self.observation.open("x+b") as stream:
                actual = opened(stream)
                space.check("observation_opened", str(self.ledger), str(self.observation), actual)
                space.check("consume", str(self.ledger), str(self.observation), actual)
                stream.write(b"SOURCE_FIXTURE_NOT_MODEL_OUTPUT")
                stream.flush()
                space.check("running", str(self.ledger), str(self.observation), actual)

    def test_broad_writer_acl_refuses_real_directory(self):
        set_fixture_dacl(self.output, self.private + "(A;OICI;GW;;;WD)")
        with self.assertRaisesRegex(ValueError, "UNEXPECTED_WRITER"):
            N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name)

    def test_pinned_directory_acl_change_refuses_next_phase(self):
        with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
            # A safe read ACE still changes the exact pinned ACL fingerprint.
            set_fixture_dacl(self.output, self.private + "(A;OICI;GR;;;WD)")
            with self.assertRaisesRegex(ValueError, "DIRECTORY_ACL_DRIFT"):
                space.check("preflight", str(self.ledger), str(self.observation), None)

    def test_existing_output_and_wrong_captured_target_refuse(self):
        with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
            with self.assertRaisesRegex(ValueError, "CAPTURED_PATH_DRIFT"):
                space.check("preflight", str(self.ledger), str(self.output / "other.jsonl"), None)
            self.observation.write_bytes(b"retain source fixture")
            with self.assertRaisesRegex(ValueError, "NEW_OUTPUT_REQUIRED"):
                space.check("preflight", str(self.ledger), str(self.observation), None)
            self.assertEqual(self.observation.read_bytes(), b"retain source fixture")

    def test_hard_link_and_forged_opened_inode_refuse(self):
        with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
            with self.observation.open("x+b") as stream:
                actual = opened(stream)
                bad = {**actual, "inode": actual["inode"] + 1}
                with self.assertRaisesRegex(ValueError, "OUTPUT_OBJECT_DRIFT"):
                    space.check("observation_opened", str(self.ledger), str(self.observation), bad)
                os.link(self.observation, self.output / "alias.jsonl")
                with self.assertRaisesRegex(ValueError, "OUTPUT_OBJECT_DRIFT"):
                    space.check("observation_opened", str(self.ledger), str(self.observation), actual)

    def test_actual_directory_rename_is_detected_and_handles_close(self):
        space = N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name)
        try:
            # Windows metadata handles are not an asserted physical rename lock.
            self.output.rename(self.root / "renamed")
            with self.assertRaisesRegex(ValueError, "DIRECTORY_IDENTITY_DRIFT"):
                space.check("preflight", str(self.ledger), str(self.observation), None)
        finally:
            space.close()
        (self.root / "renamed").rename(self.output)
        with self.assertRaisesRegex(ValueError, "NAMESPACE_CLOSED"):
            space.check("preflight", str(self.ledger), str(self.observation), None)

    def test_actual_file_acl_drift_refuses_before_resume(self):
        with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
            with self.observation.open("x+b") as stream:
                actual = opened(stream)
                space.check("observation_opened", str(self.ledger), str(self.observation), actual)
                set_fixture_dacl(self.observation, self.private + "(A;;GR;;;WD)")
                with self.assertRaisesRegex(ValueError, "OUTPUT_IDENTITY_OR_ACL_DRIFT"):
                    space.check("before_resume", str(self.ledger), str(self.observation), actual)

    def test_fixed_entry_factory_uses_actual_native_directory_checker(self):
        sys.path.insert(0, str(ROOT / "scripts/model-program"))
        try:
            import development_completion_entry as E
            with E.FixedDevelopmentEntry.for_windows_namespace(live_check=lambda *args: None,
                    ledger_directory=self.ledger, output_directory=self.output,
                    output_name=self.observation.name) as host:
                host._namespace_check("preflight", str(self.ledger), str(self.observation), None)
                with self.assertRaisesRegex(ValueError, "CAPTURED_PATH_DRIFT"):
                    host._namespace_check("preflight", str(self.output), str(self.observation), None)
            with self.assertRaisesRegex(ValueError, "NAMESPACE_CLOSED"):
                host._namespace_check("preflight", str(self.ledger), str(self.observation), None)
        finally:
            sys.path.remove(str(ROOT / "scripts/model-program"))

    def test_actual_spent_file_acl_is_checked_before_body_write(self):
        sys.path.insert(0, str(ROOT / "scripts/model-program"))
        try:
            import development_attempt_ledger as L
            request = {"profile_id": "DEV-NS-SOURCE-001", "profile_sha256": "1"*64,
                "request_sha256": "2"*64, "plan_sha256": "3"*64,
                "approval_record_id": "source-test", "approval_version": 1,
                "approval_receipt_id": "source-test", "task_id": L.TASK_ID,
                "reserved_at": "2026-10-13T04:00:00Z"}
            with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
                result = L.reserve_once(self.ledger, request, before_create=lambda: None,
                                         verify_created=space.check_reservation)
                self.assertGreater(Path(result["path"]).stat().st_size, 0)
        finally:
            sys.path.remove(str(ROOT / "scripts/model-program"))

    def test_bad_actual_spent_acl_refuses_body_but_keeps_attempt_spent(self):
        sys.path.insert(0, str(ROOT / "scripts/model-program"))
        try:
            import development_attempt_ledger as L
            request = {"profile_id": "DEV-NS-SOURCE-002", "profile_sha256": "1"*64,
                "request_sha256": "2"*64, "plan_sha256": "3"*64,
                "approval_record_id": "source-test", "approval_version": 1,
                "approval_receipt_id": "source-test", "task_id": L.TASK_ID,
                "reserved_at": "2026-10-13T04:00:00Z"}
            with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
                def poison(descriptor, path):
                    set_fixture_dacl(path, self.private + "(A;;GW;;;WD)")
                    space.check_reservation(descriptor, path)
                with self.assertRaisesRegex(ValueError, "UNEXPECTED_WRITER"):
                    L.reserve_once(self.ledger, request, before_create=lambda: None,
                                   verify_created=poison)
                spent = list(self.ledger.glob("*.spent.json"))
                self.assertEqual(len(spent), 1)
                self.assertEqual(spent[0].stat().st_size, 0)
                with self.assertRaisesRegex(ValueError, "ALREADY_SPENT_OR_UNCERTAIN"):
                    L.reserve_once(self.ledger, request, before_create=lambda: None,
                                   verify_created=space.check_reservation)
        finally:
            sys.path.remove(str(ROOT / "scripts/model-program"))

    def test_case_only_caller_path_changes_refuse(self):
        with N.WindowsPrivateNamespace(self.ledger, self.output, self.observation.name) as space:
            wrong = str(self.ledger).replace("ledger", "LEDGER")
            with self.assertRaisesRegex(ValueError, "CAPTURED_PATH_DRIFT"):
                space.check("preflight", wrong, str(self.observation), None)


if __name__ == "__main__":
    unittest.main()
