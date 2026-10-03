"""Candidate tests. Native cgroup/transport/identity fixtures are explicitly mocks.

SQLite, package hashing/framing and the fixed no-input launcher run for real.
No actual guest installation, cgroup creation, listener or registry operation.
"""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


entry = load("a_executor", "kernel/host/m2-restricted-entry-a-executor.py")
bridge = load("a_bridge", "kernel/host/m2-restricted-entry-a-bridge.py")
boundary = load("a_boundary", "kernel/host/m2-restricted-entry-python-candidate.py")
builder = load("a_builder", "scripts/model-program/build_m2_a_executor_package.py")
installer = load("a_installer", "scripts/model-program/install_m2_a_executor.py")

PROOF = {"scope": "entire_cgroup", "cgroup_empty": True, "leader_reaped": True, "identity_unchanged": True}


class FixtureRunner:
    def __init__(self):
        self.calls = []
        self.stops = []
        self.proof = dict(PROOF)
        self.behavior = None

    def run(self, tool, payload, deadline, interrupted):
        self.calls.append((tool, dict(payload)))
        if self.behavior:
            return self.behavior(tool, payload, deadline, interrupted)
        return "EMPTY_MARKER_OK" if tool == entry.TOOLS[2] else {"status": "ok"}

    def stop(self, timeout):
        self.stops.append(timeout)
        return self.proof


class BrokerCandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ledger.sqlite"
        db = sqlite3.connect(self.path)
        try:
            db.execute("CREATE TABLE burns(instance TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(instance,request))")
            db.commit()
        finally:
            db.close()
        self.ledger = boundary.ReplayLedger(self.path)
        self.runner = FixtureRunner()
        self.host = entry.Executor(self.ledger, self.runner, "fixed-a", {"marker.txt": "0" * 64})

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def probe(self, request="one"):
        return self.host.call(entry.TOOLS[2], {"request_id": request})

    def test_default_unconfigured_denies_all_three(self):
        default = entry.Executor()
        self.assertEqual(default.list_tools(), list(entry.TOOLS))
        for tool, args in ((entry.TOOLS[0], {"request_id": "x", "path": "marker.txt"}),
                           (entry.TOOLS[1], {"request_id": "x", "path": "out", "content_b64": ""}),
                           (entry.TOOLS[2], {"request_id": "x"})):
            self.assertEqual(default.call(tool, args)["error_code"], "NOT_CONFIGURED")

    def test_unknown_tools_and_authority_fields_never_dispatch(self):
        for tool in ("shell", "stop", "install", "m2_read_other_role", "activate", "registry"):
            self.assertEqual(self.host.call(tool, {"request_id": "x"})["error_code"], "TOOL_NOT_ALLOWED")
        for field in ("role", "uid", "root", "command", "launcher", "instance", "transport", "deadline"):
            self.assertEqual(self.host.call(entry.TOOLS[2], {"request_id": "x", field: "root"})["error_code"], "REQUEST_INVALID")
        self.assertEqual(self.runner.calls, [])

    def test_fixed_manifest_injected_only_by_host(self):
        self.assertEqual(self.host.call(entry.TOOLS[0], {"request_id": "x", "path": "marker.txt"})["status"], "ok")
        self.assertEqual(self.runner.calls[0][1]["digest"], "0" * 64)
        self.assertEqual(self.host.call(entry.TOOLS[0], {"request_id": "y", "path": "unfrozen"})["error_code"], "INPUT_NOT_FROZEN")
        self.assertEqual(len(self.runner.calls), 1)

    def test_invalid_path_is_burned_before_dispatch_and_restart(self):
        self.assertEqual(self.host.call(entry.TOOLS[0], {"request_id": "bad", "path": "../marker"})["error_code"], "PATH_INVALID")
        self.ledger.close()
        self.ledger = boundary.ReplayLedger(self.path)
        reopened = entry.Executor(self.ledger, self.runner, "fixed-a", {"marker.txt": "0" * 64})
        self.assertEqual(reopened.call(entry.TOOLS[2], {"request_id": "bad"})["error_code"], "REPLAY_REJECTED")
        self.assertEqual(self.runner.calls, [])

    def test_duplicate_rejected_with_real_sqlite(self):
        self.assertEqual(self.probe()["status"], "ok")
        self.assertEqual(self.probe()["error_code"], "REPLAY_REJECTED")
        self.assertEqual(len(self.runner.calls), 1)

    def test_write_content_bounded_and_invalid_base64_denied(self):
        for request, data, code in (("invalid", "!!!", "CONTENT_INVALID"),
                                    ("large", base64.b64encode(b"x" * (entry.MAX_BYTES + 1)).decode(), "CONTENT_TOO_LARGE")):
            result = self.host.call(entry.TOOLS[1], {"request_id": request, "path": "out", "content_b64": data})
            self.assertEqual(result["error_code"], code)
        self.assertEqual(self.runner.calls, [])
        result = self.host.call(entry.TOOLS[1], {"request_id": "ok", "path": "out", "content_b64": "eA=="})
        self.assertEqual(result["status"], "ok")

    def test_timeout_only_whole_cgroup_proof_allows_stopped_mock(self):
        def timeout(*_):
            raise TimeoutError()
        self.runner.behavior = timeout
        result = self.probe()
        self.assertEqual(result["execution_state"], "STOPPED")
        self.assertEqual(result["qualification"], "NOT_ISSUED")
        self.assertEqual(self.probe("after")["error_code"], "ENTRY_REVOKED_OR_EXPIRED")

    def test_partial_ack_missing_or_failed_stop_is_unknown_mock(self):
        for field in ("scope", "cgroup_empty", "leader_reaped", "identity_unchanged"):
            with self.subTest(field=field):
                runner = FixtureRunner()
                runner.proof.pop(field)
                host = entry.Executor(self.ledger, runner, "fixed-a", {"marker.txt": "0" * 64})
                self.assertEqual(host.revoke()["execution_state"], "UNKNOWN")
        self.runner.stop = mock.Mock(side_effect=OSError("not evidence"))
        self.assertEqual(self.host.revoke()["execution_state"], "UNKNOWN")

    def test_late_stop_proof_is_unknown_mock(self):
        ticks = iter((0, 0, 0.2))
        host = entry.Executor(self.ledger, self.runner, "fixed-a", clock=lambda: next(ticks))
        self.assertEqual(host.revoke()["execution_state"], "UNKNOWN")

    def test_disconnect_and_expired_lease_have_no_dispatch_mock(self):
        self.assertEqual(self.host.call(entry.TOOLS[2], {"request_id": "drop"}, lambda: True)["execution_state"], "STOPPED")
        self.assertEqual(self.runner.calls, [])
        host = entry.Executor(self.ledger, FixtureRunner(), "fixed-a", clock=lambda: 0)
        host.clock = lambda: 61
        self.assertEqual(host.call(entry.TOOLS[2], {"request_id": "expired"})["error_code"], "ENTRY_REVOKED_OR_EXPIRED")

    def test_revoke_during_call_prevents_late_success_mock(self):
        def late(*_):
            self.host.revoke()
            return "EMPTY_MARKER_OK"
        self.runner.behavior = late
        self.assertEqual(self.probe()["error_code"], "ENTRY_INTERRUPTED")


class NativeContractMockTests(unittest.TestCase):
    def test_identity_drift_rejects_before_cgroup_access_mock(self):
        account = mock.Mock(pw_uid=1001, pw_gid=1001)
        pwd = mock.Mock()
        pwd.getpwnam.return_value = account
        with mock.patch.dict(sys.modules, {"pwd": pwd}), mock.patch.object(entry.sys, "platform", "linux"), mock.patch.object(entry.os, "geteuid", return_value=0, create=True), mock.patch.object(entry, "protected") as protected:
            with self.assertRaisesRegex(entry.Rejected, "IDENTITY_DRIFT"):
                entry.CgroupRunner({"uid": 1002, "gid": 1001, "input": [1, 2], "output": [1, 3]})
            protected.assert_not_called()

    def test_root_drift_rejects_before_child_or_fd_creation_mock(self):
        runner = object.__new__(entry.CgroupRunner)
        runner.cancelled = False
        runner.empty = mock.Mock(return_value=True)
        runner.binding = {"input": [1, 2], "output": [1, 3]}
        with mock.patch.dict(sys.modules, {"resource": mock.Mock()}), mock.patch.object(entry.threading, "active_count", return_value=1), mock.patch.object(entry.os, "stat", return_value=mock.Mock(st_dev=9, st_ino=9)), mock.patch.object(entry.os, "open") as opened, mock.patch.object(entry.subprocess, "Popen") as child:
            for tool in entry.TOOLS[:2]:
                with self.assertRaisesRegex(entry.Rejected, "ROOT_IDENTITY_DRIFT"):
                    runner.run(tool, {}, 1, lambda: False)
            opened.assert_not_called()
            child.assert_not_called()

    def test_only_fixed_launcher_and_workers_can_be_selected(self):
        runner = object.__new__(entry.CgroupRunner)
        self.assertEqual(runner.command(entry.TOOLS[2]), ("/usr/bin/python3", "-I", "-S", "/usr/local/lib/clued-m2-a/empty_probe.py"))
        self.assertEqual(runner.command(entry.TOOLS[0])[-1], "--worker-read")
        self.assertEqual(runner.command(entry.TOOLS[1])[-1], "--worker-write")
        for tool in ("sh", "../../launcher", "m2-r", "stop"):
            with self.assertRaises(entry.Rejected):
                runner.command(tool)

    def test_native_stop_checks_entire_group_and_reaper_mock(self):
        # A temp regular file models cgroup.kill. No kernel cgroup is touched.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / "cgroup.kill").write_text("")
            runner = object.__new__(entry.CgroupRunner)
            runner.identity = (1, 2)
            runner.process = mock.Mock()
            runner.process.poll.return_value = 0
            runner.empty = mock.Mock(return_value=True)
            with mock.patch.object(entry, "CGROUP", path), mock.patch.object(entry, "protected", return_value=(1, 2)):
                self.assertEqual(runner.stop(0.1), PROOF)
                runner.process.wait.assert_called_once_with(timeout=0)
                self.assertEqual((path / "cgroup.kill").read_text(), "1")
                runner.process.poll.return_value = None
                self.assertEqual(runner.stop(0.002), {})
                runner.process.poll.return_value = 0
                runner.empty.return_value = False
                self.assertEqual(runner.stop(0.002), {})
                runner.empty.return_value = True
                with mock.patch.object(entry, "protected", return_value=(9, 9)):
                    self.assertEqual(runner.stop(0.1), {})


class FramingPackageTests(unittest.TestCase):
    def test_bounded_duplicate_and_nonfinite_frames_rejected(self):
        for frame in (b'{"tool":"x","tool":"y","arguments":{}}\n', b'{"tool":"x","arguments":{"n":NaN}}\n', b"x" * (entry.MAX_FRAME + 1), b'{}\n'):
            with self.assertRaises(entry.Rejected):
                entry.decode_frame(frame)
        obj = {"tool": entry.TOOLS[2], "arguments": {"request_id": "x"}}
        self.assertEqual(entry.decode_frame(entry.encode_frame(obj)), obj)

    def test_no_activation_or_installation_by_default(self):
        with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(entry, "serve_installed") as serve, mock.patch.object(bridge, "connect_installed") as connect, mock.patch.object(installer, "apply") as apply:
            self.assertEqual(entry.main([]), 2)
            self.assertEqual(bridge.main([]), 2)
            self.assertEqual(installer.main([]), 2)
            serve.assert_not_called()
            connect.assert_not_called()
            apply.assert_not_called()

    def test_real_fixed_empty_launcher_has_only_public_output(self):
        p = subprocess.run([sys.executable, "-I", "-S", str(ROOT / "kernel/host/m2-restricted-entry-a-empty-probe.py")], input=b"ignored\n", capture_output=True, timeout=2)
        self.assertEqual((p.returncode, p.stdout.replace(b"\r\n", b"\n"), p.stderr), (0, b"EMPTY_MARKER_OK\n", b""))

    def test_real_deterministic_package_and_hash_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            first, second = Path(tmp) / "a.zip", Path(tmp) / "b.zip"
            digest = builder.build(first)
            self.assertEqual(builder.build(second), digest)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            content, manifest = installer.verify_package(first, digest)
            self.assertEqual(set(content), installer.FILES)
            self.assertEqual(manifest["schema"], "m2-a-package-v1")
            with self.assertRaisesRegex(ValueError, "PACKAGE_HASH_MISMATCH"):
                installer.verify_package(first, "0" * 64)
            with zipfile.ZipFile(first, "a") as archive:
                archive.writestr("../outside", b"not installed")
            new_digest = hashlib.sha256(first.read_bytes()).hexdigest()
            with self.assertRaisesRegex(ValueError, "PACKAGE_SHAPE_INVALID"):
                installer.verify_package(first, new_digest)
            self.assertFalse((Path(tmp).parent / "outside").exists())


if __name__ == "__main__":
    unittest.main()
