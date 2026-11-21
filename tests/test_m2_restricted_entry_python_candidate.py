import hashlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / "kernel/host/m2-restricted-entry-python-candidate.py"
spec = importlib.util.spec_from_file_location("m2_python", MODULE)
m2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m2)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ledger.db"
        db = sqlite3.connect(self.path)
        try:
            db.execute("CREATE TABLE burns(instance TEXT NOT NULL, request TEXT NOT NULL, PRIMARY KEY(instance,request))")
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_restart_rejects_burned_request(self):
        first = m2.ReplayLedger(self.path)
        first.burn("host1", "request1")
        first.close()
        second = m2.ReplayLedger(self.path)
        try:
            with self.assertRaisesRegex(m2.Denied, "REPLAY_REJECTED"):
                second.burn("host1", "request1")
        finally:
            second.close()

    def test_two_connections_cannot_admit_same_request(self):
        a, b = m2.ReplayLedger(self.path), m2.ReplayLedger(self.path)
        try:
            a.burn("host1", "one")
            with self.assertRaisesRegex(m2.Denied, "REPLAY_REJECTED"):
                b.burn("host1", "one")
        finally:
            a.close()
            b.close()

    def test_missing_database_is_not_created(self):
        missing = Path(self.tmp.name) / "missing.db"
        with self.assertRaises(sqlite3.OperationalError):
            m2.ReplayLedger(missing)
        self.assertFalse(missing.exists())

    def test_extra_delete_profile_on_independent_open_and_reopen(self):
        first, second = m2.ReplayLedger(self.path), m2.ReplayLedger(self.path)
        try:
            for ledger in (first, second):
                self.assertEqual(ledger.db.execute("PRAGMA synchronous").fetchone()[0], 3)
                self.assertEqual(ledger.db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        finally:
            first.close()
            second.close()
        reopened = m2.ReplayLedger(self.path)
        try:
            self.assertEqual(reopened.db.execute("PRAGMA synchronous").fetchone()[0], 3)
            self.assertEqual(reopened.db.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        finally:
            reopened.close()

    def test_preprovisioned_wal_profile_is_denied(self):
        db = sqlite3.connect(self.path)
        try:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
        finally:
            db.close()
        with self.assertRaisesRegex(m2.Denied, "LEDGER_PROFILE_INVALID"):
            m2.ReplayLedger(self.path)

    def assert_conflict_policy_replay_denied(self, policy):
        # Both table policies pass the structural PK check. Per-statement ABORT
        # must override them, including on a distinct connection and after reopen.
        db = sqlite3.connect(self.path)
        try:
            db.execute("DROP TABLE burns")
            db.execute("CREATE TABLE burns(instance TEXT NOT NULL, request TEXT NOT NULL, "
                       f"PRIMARY KEY(instance,request) ON CONFLICT {policy})")
            db.commit()
        finally:
            db.close()
        first, second = m2.ReplayLedger(self.path), m2.ReplayLedger(self.path)
        try:
            first.burn("host1", "once")
            original = first.db.execute("SELECT rowid,instance,request FROM burns ORDER BY rowid").fetchall()
            with self.assertRaisesRegex(m2.Denied, "REPLAY_REJECTED"):
                second.burn("host1", "once")
            self.assertEqual(second.db.execute("SELECT rowid,instance,request FROM burns ORDER BY rowid").fetchall(), original)
        finally:
            first.close()
            second.close()
        reopened = m2.ReplayLedger(self.path)
        try:
            with self.assertRaisesRegex(m2.Denied, "REPLAY_REJECTED"):
                reopened.burn("host1", "once")
            self.assertEqual(reopened.db.execute("SELECT rowid,instance,request FROM burns ORDER BY rowid").fetchall(), original)
        finally:
            reopened.close()

    def test_ignore_policy_replay_denied_across_connections_and_reopen(self):
        self.assert_conflict_policy_replay_denied("IGNORE")

    def test_replace_policy_replay_denied_across_connections_and_reopen(self):
        self.assert_conflict_policy_replay_denied("REPLACE")

    def test_ledger_without_unique_key_is_denied(self):
        db = sqlite3.connect(self.path)
        try:
            db.execute("DROP TABLE burns")
            db.execute("CREATE TABLE burns(instance TEXT, request TEXT)")
            db.commit()
        finally:
            db.close()
        with self.assertRaisesRegex(m2.Denied, "LEDGER_PROFILE_INVALID"):
            m2.ReplayLedger(self.path)

    def test_limit_persists(self):
        ledger = m2.ReplayLedger(self.path)
        try:
            for n in range(256):
                ledger.burn("host1", str(n))
            with self.assertRaisesRegex(m2.Denied, "ENTRY_REQUEST_LIMIT"):
                ledger.burn("host1", "overflow")
        finally:
            ledger.close()

    def test_unsafe_arguments_rejected(self):
        for name in ("../file", "a/b", "", ".", "..", "a\\b", "��", "/absolute"):
            with self.subTest(name=name), self.assertRaises(m2.Denied):
                m2.leaf(name)
        with self.assertRaisesRegex(m2.Denied, "LAUNCHER_NOT_CONFIGURED"):
            m2.run_empty_probe()
        with self.assertRaises(m2.Denied):
            m2.fixed_role_handles("H")


@unittest.skipUnless(sys.platform == "linux", "Linux handle IO requires actual Linux execution")
class HandleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "private"
        self.root.mkdir(mode=0o700)
        self.handle = m2.DirectoryHandle(str(self.root), os.geteuid())

    def tearDown(self):
        self.handle.close()
        self.tmp.cleanup()

    def frozen(self, name, data):
        p = self.root / name
        p.write_bytes(data)
        p.chmod(0o400)
        return hashlib.sha256(data).hexdigest()

    def test_frozen_read_and_digest_drift(self):
        digest = self.frozen("input", b"public empty fixture")
        self.assertEqual(self.handle.read_frozen("input", digest), b"public empty fixture")
        with self.assertRaisesRegex(m2.Denied, "INPUT_IDENTITY_DRIFT"):
            self.handle.read_frozen("input", "0" * 64)

    def test_writable_and_hardlinked_input_denied(self):
        digest = self.frozen("input", b"x")
        (self.root / "input").chmod(0o600)
        with self.assertRaisesRegex(m2.Denied, "INPUT_PROFILE_INVALID"):
            self.handle.read_frozen("input", digest)
        (self.root / "input").chmod(0o400)
        os.link(self.root / "input", self.root / "alias")
        with self.assertRaisesRegex(m2.Denied, "INPUT_PROFILE_INVALID"):
            self.handle.read_frozen("input", digest)

    def test_symlink_and_fifo_are_not_read(self):
        (self.root / "link").symlink_to("/etc/passwd")
        with self.assertRaises(OSError):
            self.handle.read_frozen("link", "0" * 64)
        os.mkfifo(self.root / "fifo", 0o400)
        with self.assertRaisesRegex(m2.Denied, "INPUT_PROFILE_INVALID"):
            self.handle.read_frozen("fifo", "0" * 64)

    def test_size_bound(self):
        digest = self.frozen("big", b"a" * (m2.MAX_BYTES + 1))
        with self.assertRaisesRegex(m2.Denied, "CONTENT_TOO_LARGE"):
            self.handle.read_frozen("big", digest)

    def test_atomic_create_only_and_symlink_target(self):
        self.handle.create_only("output", b"complete", lambda: False)
        with self.assertRaises(FileExistsError):
            self.handle.create_only("output", b"replace", lambda: False)
        self.assertEqual((self.root / "output").read_bytes(), b"complete")
        (self.root / "link").symlink_to(self.root / "output")
        with self.assertRaises(FileExistsError):
            self.handle.create_only("link", b"replace", lambda: False)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["link", "output"])

    def test_cancel_has_no_visible_output_or_temporary(self):
        with self.assertRaisesRegex(m2.Denied, "ENTRY_REVOKED_OR_EXPIRED"):
            self.handle.create_only("output", b"x", lambda: True)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_renamed_root_fails_closed(self):
        self.root.rename(self.root.with_name("moved"))
        self.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(m2.Denied, "ROOT_IDENTITY_DRIFT"):
            self.handle.create_only("output", b"x", lambda: False)
        self.assertFalse((self.root / "output").exists())

    def test_fixed_input_profile_rejects_role_owned_output_root(self):
        with self.assertRaisesRegex(m2.Denied, "ROOT_PROFILE_INVALID"):
            m2.DirectoryHandle(str(self.root), os.geteuid(), read_only=True, gid=os.getegid())


if __name__ == "__main__":
    unittest.main()
