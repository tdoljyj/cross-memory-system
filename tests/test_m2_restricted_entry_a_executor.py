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
import os
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
    def snapshot_exchange(self, replace):
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "approved.zip"
            expected = builder.build(package)
            approved_bytes = package.read_bytes()
            approved, _ = installer.verify_package(package, expected)
            changed = dict(approved)
            changed["bridge.py"] = b"UNAPPROVED_PUBLIC_FIXTURE\n"
            manifest = {"schema": "m2-a-package-v1", "files": {name: hashlib.sha256(changed[name]).hexdigest() for name in installer.FILES}}
            other = Path(tmp) / "unapproved.zip"
            with zipfile.ZipFile(other, "w") as archive:
                for name, data in changed.items():
                    archive.writestr(name, data)
                archive.writestr("manifest.json", json.dumps(manifest))
            real_sha256 = hashlib.sha256
            exchanged = []
            def hash_then_exchange(data):
                digest = real_sha256(data)
                if data == approved_bytes and not exchanged:
                    def approved_digest():
                        if replace:
                            os.replace(other, package)
                        else:
                            package.write_bytes(other.read_bytes())
                        exchanged.append(True)
                        return digest.hexdigest()
                    return mock.Mock(hexdigest=approved_digest)
                return digest
            with mock.patch.object(installer.hashlib, "sha256", side_effect=hash_then_exchange):
                actual, _ = installer.verify_package(package, expected)
            self.assertEqual(exchanged, [True])
            self.assertEqual(actual, approved)
            self.assertNotEqual(package.read_bytes(), approved_bytes)

    def test_real_hash_then_staging_path_exchange_uses_approved_snapshot(self):
        self.snapshot_exchange(True)

    def test_real_hash_then_inplace_change_uses_approved_snapshot(self):
        self.snapshot_exchange(False)

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


@unittest.skipUnless(sys.platform == "linux", "Real POSIX temp apply/rollback runs in Linux CI; no guest installation")
class InstallerTemporaryFixtureTests(unittest.TestCase):
    """Real files, exclusive writes, hashes, SQLite and apply/rollback control flow.

    Only root ownership/account metadata and virtual cgroup files are fixtures.
    No chown, account changes, kernel cgroup, listener or privileged effect.
    """
    @contextlib.contextmanager
    def installed(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as stack:
            root = Path(tmp)
            paths = {name: root / name.lower() for name in ("CODE", "CONFIG", "DATA", "CGROUP", "INPUT", "OUTPUT", "CONTROLLERS")}
            for name, path in paths.items():
                stack.enter_context(mock.patch.object(installer, name, path))
            paths["INPUT"].mkdir(mode=0o750)
            paths["OUTPUT"].mkdir(mode=0o700)
            paths["INPUT"].chmod(0o750)
            paths["OUTPUT"].chmod(0o700)
            marker = paths["INPUT"] / "marker.txt"
            marker.write_bytes(installer.PUBLIC_INPUT)
            marker.chmod(0o640)
            paths["CONTROLLERS"].write_text("memory pids cpu")
            pwd = mock.Mock()
            pwd.getpwnam.return_value = mock.Mock(pw_uid=42, pw_gid=42, pw_shell="/usr/sbin/nologin")
            stack.enter_context(mock.patch.dict(sys.modules, {"pwd": pwd}))
            original_stat, original_mkdir, original_rmdir = Path.lstat, Path.mkdir, Path.rmdir
            def owned_stat(path, *args, **kwargs):
                s = original_stat(path, *args, **kwargs)
                uid = 42 if path == paths["OUTPUT"] else 0
                gid = 42 if path == paths["INPUT"] or path == marker or path == paths["OUTPUT"] else 0
                return os.stat_result((s.st_mode, s.st_ino, s.st_dev, s.st_nlink, uid, gid, s.st_size, s.st_atime, s.st_mtime, s.st_ctime))
            def mkdir(path, *args, **kwargs):
                original_mkdir(path, *args, **kwargs)
                if path == paths["CGROUP"]:
                    (path / "cgroup.kill").write_text("")
                    (path / "cgroup.events").write_text("populated 0\n")
            def rmdir(path, *args, **kwargs):
                if path == paths["CGROUP"]:
                    virtual = set(installer.LIMITS) | {"cgroup.kill", "cgroup.events"}
                    self.assertEqual(set(p.name for p in path.iterdir()), virtual)
                    for name in virtual:
                        (path / name).unlink()
                original_rmdir(path, *args, **kwargs)
            def fixture_parent(path):
                self.assertTrue(path.resolve().is_relative_to(root))
            stack.enter_context(mock.patch.object(Path, "lstat", owned_stat))
            stack.enter_context(mock.patch.object(Path, "mkdir", mkdir))
            stack.enter_context(mock.patch.object(Path, "rmdir", rmdir))
            stack.enter_context(mock.patch.object(installer, "safe_parent", side_effect=fixture_parent))
            package = root / "package.zip"
            digest = builder.build(package)
            content, manifest = installer.verify_package(package, digest)
            installer.apply(content, manifest)
            yield root, paths, manifest

    @staticmethod
    def snapshot(root):
        return {str(path.relative_to(root)): (path.read_bytes(), path.lstat().st_ino, path.lstat().st_mode) for path in root.rglob("*") if path.is_file()}

    def rejected_unchanged(self, root, manifest):
        before = self.snapshot(root)
        with self.assertRaisesRegex(ValueError, "ROLLBACK_IDENTITY_DRIFT"):
            installer.rollback(manifest)
        self.assertEqual(self.snapshot(root), before)

    def test_real_temp_apply_and_unchanged_rollback_retains_burns_and_receipt(self):
        with self.installed() as (_, paths, manifest):
            ledger = paths["DATA"] / "ledger.sqlite"
            with sqlite3.connect(ledger) as db:
                db.execute("INSERT INTO burns VALUES (?, ?)", ("fixed-a", "public-burn"))
            before = ledger.read_bytes()
            receipt = (paths["DATA"] / "install-receipt.json").read_bytes()
            installer.rollback(manifest)
            for name in ("CODE", "CONFIG", "CGROUP"):
                self.assertFalse(paths[name].exists())
            self.assertEqual(ledger.read_bytes(), before)
            self.assertEqual((paths["DATA"] / "install-receipt.json").read_bytes(), receipt)

    def test_real_temp_changed_instance_binding_or_filehash_fails_before_delete(self):
        for change in ("instance", "binding", "files"):
            with self.subTest(change=change), self.installed() as (root, paths, manifest):
                path = paths["CONFIG"] / "profile.json"
                profile = json.loads(path.read_bytes())
                if change == "instance":
                    profile["instance"] = "changed-public-fixture"
                elif change == "binding":
                    profile["binding"]["uid"] += 1
                else:
                    profile["files"]["executor.py"] = "0" * 64
                path.write_bytes(installer.encoded(profile))
                self.rejected_unchanged(root, manifest)

    def test_real_temp_same_profile_bytes_new_identity_fails_before_delete(self):
        with self.installed() as (root, paths, manifest):
            profile = paths["CONFIG"] / "profile.json"
            other = root / "replacement.json"
            other.write_bytes(profile.read_bytes())
            other.chmod(0o600)
            os.replace(other, profile)
            self.rejected_unchanged(root, manifest)

    def test_real_temp_installation_id_change_fails_before_delete(self):
        with self.installed() as (root, paths, manifest):
            path = paths["DATA"] / "install-receipt.json"
            receipt = json.loads(path.read_bytes())
            receipt["installation_id"] = "0" * 64
            path.write_bytes(installer.encoded(receipt))
            self.rejected_unchanged(root, manifest)

    def test_real_temp_other_target_identity_drift_fails_before_delete(self):
        for name in (*installer.INSTALLED_CODE, "ledger.sqlite"):
            with self.subTest(target=name), self.installed() as (root, paths, manifest):
                target = paths["DATA"] / name if name == "ledger.sqlite" else paths["CODE"] / name
                other = root / "replacement"
                other.write_bytes(target.read_bytes())
                other.chmod(0o600 if name == "ledger.sqlite" else 0o555)
                os.replace(other, target)
                self.rejected_unchanged(root, manifest)

    def test_real_temp_changed_code_hash_fails_before_delete(self):
        with self.installed() as (root, paths, manifest):
            target = paths["CODE"] / "executor.py"
            target.chmod(0o600)
            target.write_bytes(b"CHANGED_PUBLIC_FIXTURE\n")
            target.chmod(0o555)
            self.rejected_unchanged(root, manifest)


if __name__ == "__main__":
    unittest.main()
