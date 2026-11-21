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
import signal
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
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
fault_observer = load("a_fault_observer", "kernel/host/m2-restricted-entry-a-fault-observer.py")
fault_fixture = load("a_fault_fixture", "kernel/host/m2-restricted-entry-a-fault-fixture.py")

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
        for field in ("role", "uid", "root", "command", "launcher", "instance", "transport", "deadline",
                      "fault_case", "fixture", "stop_timeout", "proc_root"):
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

    def test_real_boundary_loading_leaves_installed_directory_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boundary.py"
            path.write_bytes((ROOT / "kernel/host/m2-restricted-entry-python-candidate.py").read_bytes())
            before = {p.name: p.read_bytes() for p in path.parent.iterdir()}
            with mock.patch.object(sys, "dont_write_bytecode", False):
                loaded = entry.load_boundary(path)
            self.assertTrue(callable(loaded.ReplayLedger))
            self.assertEqual({p.name: p.read_bytes() for p in path.parent.iterdir()}, before)


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
            original_fstat = os.fstat
            def owned_fstat(fd):
                s = original_fstat(fd)
                return os.stat_result((s.st_mode, s.st_ino, s.st_dev, s.st_nlink, 0, 0, s.st_size, s.st_atime, s.st_mtime, s.st_ctime))
            stack.enter_context(mock.patch.object(os, "fstat", owned_fstat))
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

    def test_real_temp_install_load_run_and_rollback_without_bytecode_cache(self):
        with self.installed() as (_, paths, manifest):
            ledger_path = paths["DATA"] / "ledger.sqlite"
            receipt = (paths["DATA"] / "install-receipt.json").read_bytes()
            with mock.patch.object(sys, "dont_write_bytecode", False):
                loaded = entry.load_boundary(paths["CODE"] / "boundary.py")
            self.assertEqual(set(p.name for p in paths["CODE"].iterdir()), set(installer.INSTALLED_CODE))
            ledger = loaded.ReplayLedger(ledger_path)
            runner = FixtureRunner()
            def run_empty(tool, payload, deadline, interrupted):
                p = subprocess.run([sys.executable, "-I", "-S", str(paths["CODE"] / "empty_probe.py")], capture_output=True, timeout=2)
                self.assertEqual((p.returncode, p.stdout, p.stderr), (0, b"EMPTY_MARKER_OK\n", b""))
                return p.stdout.decode("ascii").strip()
            runner.behavior = run_empty
            host = entry.Executor(ledger, runner, "temp-installed-a", {})
            try:
                self.assertEqual(host.call(entry.TOOLS[2], {"request_id": "public-load-run-rollback"})["result"], "EMPTY_MARKER_OK")
                host.revoke()
            finally:
                ledger.close()
            before = ledger_path.read_bytes()
            installer.rollback(manifest)
            for name in ("CODE", "CONFIG", "CGROUP"):
                self.assertFalse(paths[name].exists())
            self.assertEqual(ledger_path.read_bytes(), before)
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

    def successor_args(self, paths, manifest):
        package = paths["DATA"].parent / "package.zip"
        content, _ = installer.verify_package(package, hashlib.sha256(package.read_bytes()).hexdigest())
        snapshot = installer.retained_snapshot()
        _, _, raw = installer.receipt_head(snapshot)
        return (content, manifest, manifest, installer.sha(raw), installer.sha(snapshot["files"]["ledger.sqlite"][1]))

    def reject_successor_without_writes(self, root, args):
        before = self.snapshot(root)
        directories = {str(p.relative_to(root)): p.lstat().st_ino for p in root.rglob("*") if p.is_dir()}
        with mock.patch.object(installer, "exclusive") as write, mock.patch.object(Path, "mkdir") as mkdir, mock.patch.object(os, "chmod") as chmod:
            with self.assertRaises((ValueError, sqlite3.DatabaseError)):
                installer.resume_after_rollback(*args)
            write.assert_not_called()
            mkdir.assert_not_called()
            chmod.assert_not_called()
        self.assertEqual(before, self.snapshot(root))
        self.assertEqual(directories, {str(p.relative_to(root)): p.lstat().st_ino for p in root.rglob("*") if p.is_dir()})

    def test_successor_twice_preserves_exact_ledger_and_all_receipts_and_replay(self):
        with self.installed() as (_, paths, manifest):
            ledger = paths["DATA"] / "ledger.sqlite"
            with sqlite3.connect(ledger) as db:
                db.execute("INSERT INTO burns VALUES (?,?)", (installer.INSTANCE, "burn-before-rollback"))
            installer.rollback(manifest)
            for index in range(2):
                old = {p.name: p.read_bytes() for p in paths["DATA"].iterdir()}
                identity = installer.identity(ledger, 0o600)
                installer.resume_after_rollback(*self.successor_args(paths, manifest))
                self.assertEqual(identity, installer.identity(ledger, 0o600))
                for name, raw in old.items():
                    self.assertEqual((paths["DATA"] / name).read_bytes(), raw)
                loaded = entry.load_boundary(paths["CODE"] / "boundary.py")
                replay = loaded.ReplayLedger(ledger)
                try:
                    with self.assertRaisesRegex(loaded.Denied, "REPLAY_REJECTED"):
                        replay.burn(installer.INSTANCE, "burn-before-rollback")
                    replay.burn(installer.INSTANCE, "new-burn-" + str(index))
                finally:
                    replay.close()
                installer.rollback(manifest)
            self.assertEqual(len(list(paths["DATA"].glob("install-receipt*.json"))), 3)

    def test_successor_ordinary_apply_still_rejects_retained_data(self):
        with self.installed() as (root, paths, manifest):
            installer.rollback(manifest)
            args = self.successor_args(paths, manifest)
            before = self.snapshot(root)
            with self.assertRaisesRegex(ValueError, "INSTALL_COLLISION"):
                installer.apply(args[0], manifest)
            self.assertEqual(before, self.snapshot(root))

    def test_successor_unknown_file_directory_journal_or_symlink_zero_write(self):
        for name in ("unknown", "ledger.sqlite-journal", "ledger.sqlite-wal", "directory", "symlink"):
            with self.subTest(name=name), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                args = self.successor_args(paths, manifest)
                extra = paths["DATA"] / name
                if name == "directory":
                    extra.mkdir()
                elif name == "symlink":
                    extra.symlink_to(paths["DATA"] / "ledger.sqlite")
                else:
                    extra.write_bytes(b"public fixture")
                self.reject_successor_without_writes(root, args)

    def test_successor_approval_hash_and_previous_manifest_mismatch_zero_write(self):
        for index in (2, 3, 4):
            with self.subTest(index=index), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                args = list(self.successor_args(paths, manifest))
                args[index] = {"schema": "m2-a-package-v1", "files": {}} if index == 2 else "0" * 64
                self.reject_successor_without_writes(root, args)

    def test_successor_changed_binding_receipt_permissions_and_ledger_inode_zero_write(self):
        for change in ("binding", "receipt", "permissions", "inode"):
            with self.subTest(change=change), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                args = self.successor_args(paths, manifest)
                ledger = paths["DATA"] / "ledger.sqlite"
                if change == "binding":
                    pwd = sys.modules["pwd"]
                    pwd.getpwnam.return_value.pw_uid = 43
                elif change == "receipt":
                    (paths["DATA"] / "install-receipt.json").write_bytes(b"{}\n")
                elif change == "permissions":
                    ledger.chmod(0o640)
                else:
                    replacement = root / "replacement"
                    replacement.write_bytes(ledger.read_bytes())
                    replacement.chmod(0o600)
                    os.replace(replacement, ledger)
                self.reject_successor_without_writes(root, args)

    def test_successor_conflicting_active_directory_zero_write(self):
        for name in ("CODE", "CONFIG", "CGROUP"):
            with self.subTest(name=name), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                args = self.successor_args(paths, manifest)
                paths[name].mkdir()
                self.reject_successor_without_writes(root, args)

    def test_successor_foreign_instance_extra_schema_and_malformed_ledger_zero_write(self):
        for change in ("foreign", "table", "trigger", "malformed"):
            with self.subTest(change=change), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                ledger = paths["DATA"] / "ledger.sqlite"
                if change == "malformed":
                    ledger.write_bytes(b"not sqlite")
                else:
                    with sqlite3.connect(ledger) as db:
                        if change == "foreign":
                            db.execute("INSERT INTO burns VALUES ('different-instance','request')")
                        elif change == "table":
                            db.execute("CREATE TABLE extra(x)")
                        else:
                            db.execute("CREATE TRIGGER extra AFTER INSERT ON burns BEGIN SELECT 1; END")
                self.reject_successor_without_writes(root, self.successor_args(paths, manifest))

    def test_successor_backup_requires_exact_pin_and_stays_unchanged(self):
        with self.installed() as (root, paths, manifest):
            installer.rollback(manifest)
            backup = paths["DATA"] / installer.BACKUP
            backup.write_bytes(b"public cleanup backup fixture")
            backup.chmod(0o600)
            args = self.successor_args(paths, manifest)
            self.reject_successor_without_writes(root, args)
            self.reject_successor_without_writes(root, (*args, "0" * 64))
            raw = backup.read_bytes()
            installer.resume_after_rollback(*args, installer.sha(raw))
            installer.rollback(manifest)
            self.assertEqual(backup.read_bytes(), raw)

    def test_successor_recorded_history_deletion_rejected_even_with_new_ledger_pin(self):
        with self.installed() as (root, paths, manifest):
            ledger = paths["DATA"] / "ledger.sqlite"
            with sqlite3.connect(ledger) as db:
                db.execute("INSERT INTO burns VALUES (?,?)", (installer.INSTANCE, "must-retain"))
            installer.rollback(manifest)
            installer.resume_after_rollback(*self.successor_args(paths, manifest))
            installer.rollback(manifest)
            with sqlite3.connect(ledger) as db:
                db.execute("DELETE FROM burns")
            self.reject_successor_without_writes(root, self.successor_args(paths, manifest))

    def test_successor_fork_orphan_and_missing_root_zero_write(self):
        for change in ("fork", "orphan", "missing-root"):
            with self.subTest(change=change), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                installer.resume_after_rollback(*self.successor_args(paths, manifest))
                installer.rollback(manifest)
                args = self.successor_args(paths, manifest)
                head_path = next(paths["DATA"].glob("install-receipt-*.json"))
                if change == "missing-root":
                    (paths["DATA"] / "install-receipt.json").unlink()
                else:
                    receipt = json.loads(head_path.read_bytes())
                    receipt.pop("installation_id")
                    if change == "fork":
                        receipt["manifest_sha256"] = "0" * 64
                    else:
                        receipt["predecessor"]["receipt"] = "install-receipt-" + "0" * 64 + ".json"
                        head_path.unlink()
                    receipt["installation_id"] = installer.sha(installer.encoded(receipt))
                    new = paths["DATA"] / ("install-receipt-" + receipt["installation_id"] + ".json")
                    installer.exclusive(new, installer.encoded(receipt), 0o600)
                self.reject_successor_without_writes(root, args)

    def test_successor_gid_drift_hardlink_and_snapshot_exchange_zero_write(self):
        for change in ("gid", "hardlink", "exchange"):
            with self.subTest(change=change), self.installed() as (root, paths, manifest):
                installer.rollback(manifest)
                args = self.successor_args(paths, manifest)
                ledger = paths["DATA"] / "ledger.sqlite"
                if change == "hardlink":
                    os.link(ledger, root / "hardlink")
                    self.reject_successor_without_writes(root, args)
                elif change == "gid":
                    original = Path.lstat
                    def drift(path, *a, **kw):
                        s = original(path, *a, **kw)
                        if path == ledger:
                            return os.stat_result((s.st_mode, s.st_ino, s.st_dev, s.st_nlink, s.st_uid, 42, s.st_size, s.st_atime, s.st_mtime, s.st_ctime))
                        return s
                    with mock.patch.object(Path, "lstat", drift):
                        self.reject_successor_without_writes(root, args)
                else:
                    original = installer.retained_snapshot
                    calls = []
                    def changed():
                        result = original()
                        calls.append(1)
                        if len(calls) == 2:
                            result["files"]["ledger.sqlite"] = (result["files"]["ledger.sqlite"][0], b"changed snapshot fixture")
                        return result
                    with mock.patch.object(installer, "retained_snapshot", side_effect=changed):
                        self.reject_successor_without_writes(root, args)


class SuccessorLedgerSnapshotTests(unittest.TestCase):
    def snapshot(self, rows=(), sql=None):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ledger.sqlite"
            with sqlite3.connect(path) as db:
                db.execute(installer.BURNS_SQL)
                db.executemany("INSERT INTO burns VALUES (?,?)", rows)
                if sql:
                    db.execute(sql)
            db.close()
            return path.read_bytes()

    def test_exact_schema_and_fixed_instance_snapshot(self):
        self.assertEqual(installer.ledger_burns(self.snapshot([(installer.INSTANCE, "b"), (installer.INSTANCE, "a")])), ["a", "b"])

    def test_no_disk_connection_during_validation(self):
        raw = self.snapshot()
        connect = sqlite3.connect
        calls = []
        def memory_only(path, *args, **kwargs):
            calls.append(path)
            self.assertEqual(path, ":memory:")
            return connect(path, *args, **kwargs)
        with mock.patch.object(sqlite3, "connect", side_effect=memory_only):
            self.assertEqual(installer.ledger_burns(raw), [])
        self.assertEqual(calls, [":memory:"])

    def test_foreign_instance_invalid_request_extra_schema_and_quota_rejected(self):
        for rows, sql in (([("other", "a")], None), ([(installer.INSTANCE, "bad/request")], None), ([], "CREATE TABLE extra(x)"), ([], "CREATE VIEW extra AS SELECT * FROM burns"), ([(installer.INSTANCE, str(x)) for x in range(257)], None)):
            with self.subTest(sql=sql, count=len(rows)):
                with self.assertRaises(ValueError):
                    installer.ledger_burns(self.snapshot(rows, sql))

    def test_corrupt_and_wal_header_rejected(self):
        raw = self.snapshot()
        for candidate in (b"bad", raw[:18] + b"\x02\x02" + raw[20:]):
            with self.assertRaises(ValueError):
                installer.ledger_burns(candidate)


class FaultObservationCandidateTests(unittest.TestCase):
    """Deterministic evidence reducers; no native cgroup or VM qualification."""
    def setUp(self):
        self.leader = fault_observer.ProcessIdentity(101, 111, 101, 101, 1001, 1001, "S")
        self.child = fault_observer.ProcessIdentity(102, 112, 101, 101, 1001, 1001, "S")
        self.binding = fault_observer.GroupBinding("00000000-0000-0000-0000-000000000001", self.leader)
        self.before = fault_observer.Observation(self.binding, (self.leader, self.child), (), True)
        self.after = fault_observer.Observation(self.binding, (), (None, None), True)
        self.runner = mock.Mock()
        self.runner.stop.return_value = dict(PROOF)

    def check(self, after=None, end=0.01, timeout=None):
        ticks = iter((0, end))
        with mock.patch.object(fault_observer, "observe", return_value=after or self.after):
            return fault_observer.stop_and_observe(self.runner, self.before,
                entry.STOP_TIMEOUT if timeout is None else timeout, clock=lambda: next(ticks))

    def test_bound_matches_existing_supervisor_and_fixed_command_is_management_only(self):
        self.assertEqual(fault_observer.STOP_TIMEOUT, entry.STOP_TIMEOUT)
        self.assertEqual(fault_observer.FIXED_COMMAND, ("/usr/bin/python3", "-B", "-I", "-S",
            "/usr/local/lib/clued-m2-a-fault-fixture/fault_fixture.py", "--fixed-management-fixture"))
        with contextlib.redirect_stdout(io.StringIO()):
            for args in ([], ["--fixed-management-fixture", "root"], ["--command", "sh"]):
                self.assertEqual(fault_fixture.main(args), 2)
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / "a.zip"
            builder.build(package)
            with zipfile.ZipFile(package) as z:
                self.assertFalse(any("fault" in n for n in z.namelist()))

    def test_complete_mock_evidence_requires_all_native_fields(self):
        self.assertEqual(self.check()["execution_state"], "STOPPED")
        self.assertEqual(self.check()["qualification"], "NOT_ISSUED")
        for field in PROOF:
            with self.subTest(field=field):
                self.runner.stop.return_value = {k: v for k, v in PROOF.items() if k != field}
                self.assertEqual(self.check()["execution_state"], "UNKNOWN")

    def test_live_or_escaped_descendant_unknown_even_with_mock_native_ack(self):
        after = fault_observer.Observation(self.binding, (self.child,), (None, self.child), True)
        self.assertEqual(self.check(after)["execution_state"], "UNKNOWN")
        # No group members is insufficient when a tracked child remains alive.
        after = fault_observer.Observation(self.binding, (), (None, self.child), True)
        self.assertEqual(self.check(after)["execution_state"], "UNKNOWN")

    def test_missing_incomplete_wrong_binding_and_no_live_descendant_unknown(self):
        other = fault_observer.GroupBinding("00000000-0000-0000-0000-000000000002", self.leader)
        for after in (fault_observer.Observation(self.binding, (), (), True),
                      fault_observer.Observation(self.binding, (), (None, None), False),
                      fault_observer.Observation(other, (), (None, None), True)):
            self.assertEqual(self.check(after)["execution_state"], "UNKNOWN")
        self.before = fault_observer.Observation(self.binding, (self.leader,), (), True)
        self.runner.reset_mock()
        self.assertEqual(self.check()["execution_state"], "UNKNOWN")
        self.runner.stop.assert_not_called()

    def test_late_negative_clock_and_changed_acceptance_bound_unknown(self):
        for end in (entry.STOP_TIMEOUT, 0.2, -0.01, float("nan")):
            self.assertEqual(self.check(end=end)["execution_state"], "UNKNOWN")
        self.runner.reset_mock()
        for timeout in (1.0, 0.0, True, float("nan")):
            self.assertEqual(self.check(timeout=timeout)["execution_state"], "UNKNOWN")
        self.runner.stop.assert_not_called()

    def test_pid_reuse_boot_drift_group_churn_and_unreadable_scan_unknown(self):
        reused = fault_observer.ProcessIdentity(101, 999, 101, 101, 1001, 1001, "S")
        with mock.patch.object(fault_observer, "boot_id", return_value=self.binding.boot_id), \
             mock.patch.object(fault_observer, "read_process", return_value=reused):
            self.assertFalse(fault_observer.observe(self.binding).complete)
        with mock.patch.object(fault_observer, "boot_id", return_value="changed"):
            self.assertFalse(fault_observer.observe(self.binding).complete)
        for scans in ((self.before.members, (self.leader,)), PermissionError("fixture")):
            with mock.patch.object(fault_observer, "boot_id", return_value=self.binding.boot_id), \
                 mock.patch.object(fault_observer, "read_process", return_value=self.leader), \
                 mock.patch.object(fault_observer, "scan_group", side_effect=scans):
                self.assertFalse(fault_observer.observe(self.binding).complete)

    def test_tracked_generation_change_unknown_after_group_empty(self):
        escaped = fault_observer.ProcessIdentity(102, 112, 999, 999, 1001, 1001, "S")
        with mock.patch.object(fault_observer, "boot_id", return_value=self.binding.boot_id), \
             mock.patch.object(fault_observer, "scan_group", return_value=()), \
             mock.patch.object(fault_observer, "read_process", side_effect=[FileNotFoundError(), escaped]):
            self.assertFalse(fault_observer.observe(self.binding, (self.child,)).complete)

    def test_stop_exception_unknown(self):
        self.runner.stop.side_effect = OSError("fixture")
        self.assertEqual(self.check()["execution_state"], "UNKNOWN")

    def test_readiness_requires_bound_session_and_role(self):
        for child in (fault_observer.ProcessIdentity(102, 112, 101, 999, 1001, 1001, "S"),
                      fault_observer.ProcessIdentity(102, 112, 101, 101, 0, 0, "S")):
            self.before = fault_observer.Observation(self.binding, (self.leader, child), (), True)
            self.assertEqual(self.check()["execution_state"], "UNKNOWN")
        self.runner.stop.assert_not_called()

    def test_proc_parser_binds_start_time_and_handles_parentheses_in_comm(self):
        raw = b"101 (odd ) name) " + b" ".join([b"S", b"1", b"101", b"101"] +
            [b"0"] * 15 + [b"111"] + [b"0"] * 30) + b"\n"
        s = mock.Mock(st_mode=0o100400, st_uid=1001, st_gid=1001)
        with mock.patch.object(fault_observer.os, "O_NOFOLLOW", 0x20000, create=True), \
             mock.patch.object(fault_observer.os, "open", return_value=10), \
             mock.patch.object(fault_observer.os, "fstat", return_value=s), \
             mock.patch.object(fault_observer.os, "read", return_value=raw), \
             mock.patch.object(fault_observer.os, "close") as closed:
            self.assertEqual(fault_observer.read_process(101), self.leader)
            closed.assert_called_once_with(10)
        for raw in (b"101 (x) broken", b"102 (x) S 1", b"x" * (fault_observer.MAX_STAT_BYTES + 1)):
            with mock.patch.object(fault_observer.os, "O_NOFOLLOW", 0x20000, create=True), \
                 mock.patch.object(fault_observer.os, "open", return_value=10), \
                 mock.patch.object(fault_observer.os, "fstat", return_value=s), \
                 mock.patch.object(fault_observer.os, "read", return_value=raw), \
                 mock.patch.object(fault_observer.os, "close"):
                with self.assertRaises(fault_observer.Uncertain):
                    fault_observer.read_process(101)


class SandboxCleanupRegressionTests(unittest.TestCase):
    setUp = FaultObservationCandidateTests.setUp
    def test_cleanup_reaped_leader_still_kills_bound_live_child(self):
        process = mock.Mock()
        process.poll.return_value = -9
        after = fault_observer.Observation(self.binding, (self.child,), (None, self.child), True)
        with mock.patch.object(signal, "SIGKILL", 9, create=True), \
             mock.patch.object(fault_observer, "observe", return_value=after), \
             mock.patch.object(os, "killpg", create=True) as killed:
            FaultSameUserSandboxTests.cleanup(process, [self.binding, self.before])
        killed.assert_called_once_with(self.leader.pgid, 9)
        process.communicate.assert_called_once_with(timeout=3)

    def test_cleanup_unknown_identity_does_not_signal(self):
        after = fault_observer.Observation(self.binding, (), (), False)
        with mock.patch.object(fault_observer, "observe", return_value=after), \
             mock.patch.object(os, "killpg", create=True) as killed:
            with self.assertRaisesRegex(AssertionError, "identity is unknown"):
                FaultSameUserSandboxTests.cleanup(mock.Mock(), [self.binding, self.before])
        killed.assert_not_called()


@unittest.skipUnless(sys.platform == "linux", "Linux /proc and same-user fork sandbox only; no VM evidence")
class FaultSameUserSandboxTests(unittest.TestCase):
    """Actual subprocess identity/stop; simulated fault triggers, no native cgroup."""
    def launch(self):
        process = subprocess.Popen((sys.executable, "-B", "-I", "-S",
            str(ROOT / "kernel/host/m2-restricted-entry-a-fault-fixture.py"),
            fault_fixture.FIXED_ARG), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
        cleanup_identity = []
        self.addCleanup(self.cleanup, process, cleanup_identity)
        binding = fault_observer.bind_started_group(process.pid)
        cleanup_identity.append(binding)
        end = time.monotonic() + 3  # Sandbox readiness watchdog, not acceptance.
        while time.monotonic() < end:
            before = fault_observer.observe(binding)
            if fault_observer.ready(before):
                cleanup_identity.append(before)
                return process, before
            time.sleep(0.005)
        self.fail("Fixed sandbox descendant did not become observable")

    @staticmethod
    def cleanup(process, identity):
        if not identity:
            # An unreaped Popen child cannot have its PID reused. This fallback
            # is only for a failed initial identity read of our new session.
            if process.poll() is None and os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGKILL)
        else:
            binding = identity[0]
            tracked = identity[1].members if len(identity) == 2 else ()
            after = fault_observer.observe(binding, tracked)
            leader = binding.leader
            if not after.complete or any(
                    (x.pgid, x.session, x.uid, x.gid) !=
                    (leader.pgid, leader.session, leader.uid, leader.gid)
                    for x in after.members):
                raise AssertionError("Sandbox cleanup identity is unknown")
            # A reaped leader can leave live descendants holding output pipes.
            if any(x.state not in "ZXx" for x in after.members):
                try:
                    os.killpg(leader.pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass  # The verified group exited before the signal.
        process.communicate(timeout=3)

    def test_actual_group_stop_has_no_native_cgroup_qualification_for_each_simulated_fault(self):
        for trigger in ("timeout", "revoke", "disconnect"):
            with self.subTest(simulated_trigger=trigger):
                owner = self
                closed = [False]
                class SameUserSandboxRunner:
                    def run(self, tool, payload, deadline, interrupted):
                        self.process, self.before = owner.launch()
                        if trigger == "timeout":
                            while time.monotonic() < deadline:
                                time.sleep(0.005)
                            raise TimeoutError()
                        if trigger == "revoke":
                            self.host.revoke()
                        else:
                            closed[0] = True  # Simulated transport interruption.
                        return "EMPTY_MARKER_OK"

                    def stop(self, timeout):
                        if self.process.poll() is None:
                            os.killpg(self.process.pid, signal.SIGKILL)
                        self.process.communicate(timeout=3)
                        return {}  # Actual sandbox group kill is no cgroup proof.
                runner = SameUserSandboxRunner()
                runner.host = entry.Executor(mock.Mock(), runner, "fixed-a")
                result = runner.host.call(entry.TOOLS[2], {"request_id": "sandbox"}, lambda: closed[0])
                self.assertEqual(result["execution_state"], "UNKNOWN")
                self.assertEqual(result["error_code"], "EXECUTION_STOP_UNCONFIRMED")
                before = runner.before
                after = fault_observer.observe(before.binding, before.members)
                self.assertTrue(fault_observer.terminated(before, after))
                observed_runner = mock.Mock()
                observed_runner.stop.return_value = {}
                with mock.patch.object(fault_observer, "observe", return_value=after):
                    result = fault_observer.stop_and_observe(observed_runner, before, entry.STOP_TIMEOUT)
                self.assertEqual(result["execution_state"], "UNKNOWN")
                self.assertEqual(result["qualification"], "NOT_ISSUED")

    def test_leader_only_kill_leaves_observed_descendant_and_cannot_confirm_stop(self):
        process, before = self.launch()
        os.kill(process.pid, signal.SIGKILL)
        process.wait(timeout=3)
        after = fault_observer.observe(before.binding, before.members)
        self.assertFalse(fault_observer.terminated(before, after))
        self.assertTrue(any(x is not None and x.pid != process.pid and x.state not in "ZXx"
                            for x in after.tracked))
        # Leader has been reaped, but its same-user group is still ours and was
        # bound before the fault. Terminate that known sandbox descendant group.
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate(timeout=3)


def load_tests(loader, tests, pattern):
    # Keep the existing Linux workflow entry; add only the companion regressions.
    for filename in ("test_m2_restricted_entry_a_fault_management.py",
                     "test_m2_restricted_entry_a_fault_install.py"):
        spec = importlib.util.spec_from_file_location("integrated_" + filename[:-3], Path(__file__).with_name(filename))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        tests.addTests(loader.loadTestsFromModule(module))
    return tests


if __name__ == "__main__":
    unittest.main()
