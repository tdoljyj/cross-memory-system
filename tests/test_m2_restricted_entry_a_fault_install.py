"""Repository candidate tests; temp POSIX fixtures, never an actual guest install."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
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


fault = load("fault_installer_candidate", "scripts/model-program/install_m2_a_fault_package.py")
builder = load("fault_builder_candidate", "scripts/model-program/build_m2_a_fault_package.py")
legacy = load("base_a_fixture_tests", "tests/test_m2_restricted_entry_a_executor.py")


class FaultPackageTests(unittest.TestCase):
    def test_default_and_unprivileged_cli_deny(self):
        self.assertEqual(fault.main([]), 2)
        with mock.patch.object(fault.os, "geteuid", return_value=1, create=True), mock.patch.object(fault.sys, "platform", "linux"), mock.patch.object(fault, "verify_package") as verify:
            self.assertEqual(fault.main(["--install-approved", "--package", "absent", "--approved-sha256", "0" * 64]), 2)
            verify.assert_not_called()

    def test_deterministic_companion_embeds_exact_original_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            first, second, original = (Path(tmp) / name for name in ("one.zip", "two.zip", "original.zip"))
            digest = builder.build(first)
            self.assertEqual(builder.build(second), digest)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            original_digest = legacy.builder.build(original)
            content, manifest = fault.verify_package(first, digest)
            self.assertEqual(content["base-a.zip"], original.read_bytes())
            self.assertNotEqual(digest, original_digest)
            base, base_content, base_manifest = fault.load_base(content, manifest)
            self.assertEqual(base.INSTANCE, fault.INSTANCE)
            self.assertEqual(base_content["installer.py"], fault.new_content(content, base_content)["base_installer.py"])
            self.assertEqual(base_manifest["schema"], "m2-a-package-v1")
            with self.assertRaisesRegex(ValueError, "PACKAGE_HASH_MISMATCH"):
                fault.verify_package(first, original_digest)

    def test_extra_duplicate_member_and_bad_manifest_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fault.zip"
            digest = builder.build(path)
            content, manifest = fault.verify_package(path, digest)
            for change in ("extra", "duplicate", "manifest", "nested"):
                payload = dict(content)
                edited = json.loads(json.dumps(manifest))
                if change == "extra":
                    payload["../escape"] = b"public fixture"
                elif change == "manifest":
                    edited["files"]["management.py"] = "0" * 64
                elif change == "nested":
                    payload["base-a.zip"] = b"invalid nested archive"
                    edited["files"]["base-a.zip"] = fault.sha(payload["base-a.zip"])
                payload["manifest.json"] = fault.encoded(edited)
                raw = builder.archive_bytes(payload)
                if change == "duplicate":
                    out = io.BytesIO(raw)
                    with zipfile.ZipFile(out, "a") as archive:
                        archive.writestr("management.py", b"duplicate")
                    raw = out.getvalue()
                path.write_bytes(raw)
                with self.subTest(change=change), self.assertRaises((ValueError, zipfile.BadZipFile)):
                    checked, checked_manifest = fault.verify_package(path, fault.sha(raw))
                    fault.load_base(checked, checked_manifest)


@unittest.skipUnless(sys.platform == "linux", "POSIX identity/mode/temp-file fixtures run in Linux CI; Windows is explicitly skipped, no guest installation")
class FaultInstallTemporaryTests(unittest.TestCase):
    snapshot = staticmethod(legacy.InstallerTemporaryFixtureTests.snapshot)

    @contextlib.contextmanager
    def prepared(self, install=False):
        with legacy.InstallerTemporaryFixtureTests.installed(self) as (root, paths, base_manifest), contextlib.ExitStack() as stack:
            # Reuse original real SQLite/exclusive writes and mock only root
            # metadata, account, safe parents and virtual cgroup filesystem.
            base = legacy.installer
            for name in ("CODE", "CONFIG", "LOG"):
                stack.enter_context(mock.patch.object(fault, name, root / ("fault-" + name.lower())))
            ledger = paths["DATA"] / "ledger.sqlite"
            with sqlite3.connect(ledger) as db:
                for index in range(6):
                    db.execute("INSERT INTO burns VALUES (?,?)", (base.INSTANCE, "previous-public-burn-" + str(index)))
            backup = paths["DATA"] / base.BACKUP
            backup.write_bytes(b"public cleanup backup fixture\n")
            backup.chmod(0o600)
            base.rollback(base_manifest)
            package = root / "fault.zip"
            digest = builder.build(package)
            content, manifest = fault.verify_package(package, digest)
            snapshot = base.retained_snapshot()
            _, _, raw = base.receipt_head(snapshot)
            args = (content, manifest, base, base_manifest, fault.sha(raw), fault.sha(snapshot["files"]["ledger.sqlite"][1]), fault.sha(backup.read_bytes()))
            if install:
                fault.install(*args)
            yield root, paths, args

    def rejected_without_write(self, root, action):
        before = self.snapshot(root)
        directories = {str(p.relative_to(root)): p.lstat().st_ino for p in root.rglob("*") if p.is_dir()}
        with mock.patch.object(legacy.installer, "exclusive") as write, mock.patch.object(Path, "mkdir") as mkdir, mock.patch.object(Path, "unlink") as unlink:
            with self.assertRaises((ValueError, OSError, sqlite3.DatabaseError)):
                action()
            write.assert_not_called()
            mkdir.assert_not_called()
            unlink.assert_not_called()
        self.assertEqual(before, self.snapshot(root))
        self.assertEqual(directories, {str(p.relative_to(root)): p.lstat().st_ino for p in root.rglob("*") if p.is_dir()})

    @contextlib.contextmanager
    def management_reader(self, paths):
        """Real installed validator/imports; only fixture ownership/paths differ."""
        with contextlib.ExitStack() as stack:
            name = "fault_temp_management_reader"
            spec = importlib.util.spec_from_file_location(name, fault.CODE / "management.py")
            management = importlib.util.module_from_spec(spec)
            stack.enter_context(mock.patch.dict(sys.modules, {name: management}))
            exec(compile((fault.CODE / "management.py").read_bytes(), str(fault.CODE / "management.py"), "exec"), management.__dict__)
            for key, value in {"CODE": fault.CODE, "CONFIG": fault.CONFIG, "LOG": fault.LOG, "BASE": paths["CODE"]}.items():
                stack.enter_context(mock.patch.object(management, key, value))
            stack.enter_context(mock.patch.object(management, "__file__", str(fault.CODE / "management.py")))
            stack.enter_context(mock.patch.object(management.sys, "platform", "linux"))
            stack.enter_context(mock.patch.object(management.os, "geteuid", return_value=0))
            # legacy.identity delegates its parent check to the existing fixture
            # containment validator; open/fstat/read are the actual implementation.
            stack.enter_context(mock.patch.object(management, "owned", side_effect=legacy.installer.identity))
            real_load = management.load
            calls = []
            def pinned_load(module_name, path, source):
                calls.append((module_name, path))
                if module_name == "fault_base_installer":
                    self.assertEqual(path, fault.CODE / "base_installer.py")
                    return legacy.installer
                return real_load(module_name, path, source)
            stack.enter_context(mock.patch.object(management, "load", side_effect=pinned_load))
            yield management, calls

    def test_real_installed_management_reads_complete_bound_history_without_bytecache(self):
        with self.prepared(install=True) as (_, paths, _), self.management_reader(paths) as (management, calls):
            with mock.patch.object(sys, "dont_write_bytecode", False), \
                    mock.patch.object(legacy.installer, "retained_snapshot", wraps=legacy.installer.retained_snapshot) as snapshot, \
                    mock.patch.object(legacy.installer, "receipt_head", wraps=legacy.installer.receipt_head) as head, \
                    mock.patch.object(legacy.installer, "check_history", wraps=legacy.installer.check_history) as history:
                executor, observer, strict, profile = management.installed()
                self.assertFalse(sys.dont_write_bytecode)
                snapshot.assert_called_once()
                head.assert_called_once()
                history.assert_called_once()
            self.assertIs(strict, legacy.installer)
            self.assertEqual(profile["request_ids"], fault.REQUEST_IDS)
            self.assertTrue(hasattr(executor, "Executor"))
            self.assertTrue(hasattr(observer, "observe"))
            self.assertEqual([name for name, _ in calls], ["fault_base_installer", "fault_base_executor", "fault_installed_observer"])
            self.assertEqual({p.name for p in fault.CODE.iterdir()}, set(fault.INSTALLED))
            self.assertEqual({p.name for p in paths["CODE"].iterdir()}, set(legacy.installer.INSTALLED_CODE))

    def test_real_installed_management_drift_denied_before_executor_import(self):
        for change in ("source", "identity", "head", "binding", "ledger-history"):
            with self.subTest(change=change), self.prepared(install=True) as (_, paths, _), self.management_reader(paths) as (management, calls):
                if change == "source":
                    path = fault.CODE / "fault_observer.py"
                    path.chmod(0o600)
                    path.write_bytes(b"changed public observer fixture\n")
                    path.chmod(0o555)
                elif change == "identity":
                    path = fault.CODE / "fault_fixture.py"
                    other = paths["CODE"].parent / "replacement-code"
                    other.write_bytes(path.read_bytes())
                    other.chmod(0o555)
                    os.replace(other, path)
                elif change == "head":
                    snapshot = legacy.installer.retained_snapshot()
                    head_name, _, _ = legacy.installer.receipt_head(snapshot)
                    (paths["DATA"] / head_name).write_bytes(b"{}")
                elif change == "binding":
                    path = paths["CONFIG"] / "profile.json"
                    profile = json.loads(path.read_bytes())
                    profile["binding"]["uid"] += 1
                    path.write_bytes(fault.encoded(profile))
                else:
                    with sqlite3.connect(paths["DATA"] / "ledger.sqlite") as db:
                        db.execute("DELETE FROM burns WHERE request=?", ("previous-public-burn-0",))
                before = self.snapshot(paths["CODE"].parent)
                with mock.patch.object(sys, "dont_write_bytecode", False), self.assertRaises(ValueError):
                    management.installed()
                self.assertNotIn("fault_base_executor", [name for name, _ in calls])
                self.assertNotIn("fault_installed_observer", [name for name, _ in calls])
                self.assertEqual(before, self.snapshot(paths["CODE"].parent))

    def test_same_instance_successor_and_rollback_retain_all_history(self):
        with self.prepared() as (root, paths, args):
            before = {p.name: (p.read_bytes(), p.lstat().st_ino) for p in paths["DATA"].iterdir()}
            fault.install(*args)
            for name, (raw, inode) in before.items():
                self.assertEqual((paths["DATA"] / name).read_bytes(), raw)
                self.assertEqual((paths["DATA"] / name).lstat().st_ino, inode)
            self.assertEqual(len(list(paths["DATA"].glob("install-receipt*.json"))), 2)
            profile = json.loads((fault.CONFIG / "profile.json").read_bytes())
            self.assertEqual(set(profile), {"schema", "instance", "vm_id", "files", "base_receipt_sha256", "request_ids", "binding", "log_directory_identity"})
            self.assertEqual(profile["instance"], legacy.installer.INSTANCE)
            self.assertEqual(set(profile["files"]), set(fault.INSTALLED))
            with sqlite3.connect(paths["DATA"] / "ledger.sqlite") as db:
                for request in fault.REQUEST_IDS.values():
                    db.execute("INSERT INTO burns VALUES (?,?)", (fault.INSTANCE, request))
                    legacy.installer.exclusive(fault.LOG / (request + ".json"), fault.encoded({"public_fixture": request}), 0o600)
            audit_logs = {p.name: (p.read_bytes(), p.lstat().st_ino) for p in fault.LOG.iterdir()}
            retained = {p.name: (p.read_bytes(), p.lstat().st_ino) for p in paths["DATA"].iterdir()}
            receipt = (fault.LOG / "install-receipt.json").read_bytes()
            fault.rollback(*args[:3])
            self.assertFalse(fault.CODE.exists())
            self.assertFalse(fault.CONFIG.exists())
            self.assertFalse(paths["CODE"].exists())
            self.assertTrue(fault.LOG.exists())
            self.assertEqual((fault.LOG / "install-receipt.json").read_bytes(), receipt)
            self.assertEqual(audit_logs, {p.name: (p.read_bytes(), p.lstat().st_ino) for p in fault.LOG.iterdir()})
            self.assertEqual(retained, {p.name: (p.read_bytes(), p.lstat().st_ino) for p in paths["DATA"].iterdir()})

    def test_install_collision_approval_unknown_data_and_burned_request_zero_write(self):
        for change in ("code", "config", "log", "receipt", "ledger", "backup", "unknown", "burned", "controllers", "marker", "symlink"):
            with self.subTest(change=change), self.prepared() as (root, paths, args):
                args = list(args)
                if change in ("code", "config", "log"):
                    getattr(fault, change.upper()).mkdir()
                elif change == "receipt":
                    args[4] = "0" * 64
                elif change == "ledger":
                    args[5] = "0" * 64
                elif change == "backup":
                    args[6] = "0" * 64
                elif change == "symlink":
                    fault.CODE.symlink_to(paths["DATA"], target_is_directory=True)
                elif change == "unknown":
                    (paths["DATA"] / "unknown").write_bytes(b"public fixture")
                elif change == "burned":
                    with sqlite3.connect(paths["DATA"] / "ledger.sqlite") as db:
                        db.execute("INSERT INTO burns VALUES (?,?)", (fault.INSTANCE, fault.REQUEST_IDS["timeout"]))
                    args[5] = fault.sha((paths["DATA"] / "ledger.sqlite").read_bytes())
                elif change == "controllers":
                    paths["CONTROLLERS"].write_text("memory cpu")
                else:
                    (paths["INPUT"] / "marker.txt").write_bytes(b"changed public fixture")
                self.rejected_without_write(root, lambda: fault.install(*args))

    def test_rollback_any_target_history_or_cgroup_drift_zero_unlink(self):
        changes = ("code-hash", "base-hash", "profile", "extra-code", "extra-config", "extra-log", "base-history", "populated", "limits", "ledger-inode", "receipt", "backup", "hardlink", "symlink")
        for change in changes:
            with self.subTest(change=change), self.prepared(install=True) as (root, paths, args):
                if change in ("code-hash", "base-hash"):
                    path = fault.CODE / "management.py" if change == "code-hash" else paths["CODE"] / "executor.py"
                    path.chmod(0o600)
                    path.write_bytes(b"changed public code fixture")
                    path.chmod(0o555)
                elif change == "profile":
                    (fault.CONFIG / "profile.json").write_bytes(b"{}")
                elif change.startswith("extra-"):
                    target = {"extra-code": fault.CODE, "extra-config": fault.CONFIG, "extra-log": fault.LOG}[change]
                    (target / "unexpected").write_bytes(b"public fixture")
                elif change == "base-history":
                    (paths["DATA"] / "install-receipt.json").write_bytes(b"{}")
                elif change == "populated":
                    (paths["CGROUP"] / "cgroup.events").write_text("populated 1\n")
                elif change == "limits":
                    (paths["CGROUP"] / "pids.max").write_text("9")
                elif change == "ledger-inode":
                    path = paths["DATA"] / "ledger.sqlite"
                    other = root / "replacement"
                    other.write_bytes(path.read_bytes())
                    other.chmod(0o600)
                    os.replace(other, path)
                elif change == "backup":
                    (paths["DATA"] / legacy.installer.BACKUP).write_bytes(b"changed public backup")
                elif change == "hardlink":
                    os.link(fault.CODE / "management.py", root / "hardlinked-management")
                elif change == "symlink":
                    path = fault.CODE / "management.py"
                    raw = path.read_bytes()
                    other = root / "symlink-target"
                    other.write_bytes(raw)
                    other.chmod(0o555)
                    path.unlink()
                    path.symlink_to(other)
                else:
                    (fault.LOG / "install-receipt.json").write_bytes(b"{}")
                self.rejected_without_write(root, lambda: fault.rollback(*args[:3]))

    def test_failure_preserves_partial_paths_and_retry_collides(self):
        with self.prepared() as (_, paths, args):
            original = legacy.installer.exclusive
            def fail(path, raw, mode):
                if path == fault.CODE / "fault_observer.py":
                    raise OSError("public fixture failure")
                return original(path, raw, mode)
            with mock.patch.object(legacy.installer, "exclusive", side_effect=fail):
                with self.assertRaises(OSError):
                    fault.install(*args)
            self.assertTrue((fault.CODE / "fault_fixture.py").exists())
            self.assertTrue(paths["CODE"].exists())
            with self.assertRaisesRegex(ValueError, "FAULT_INSTALL_COLLISION"):
                fault.install(*args)


if __name__ == "__main__":
    unittest.main()
