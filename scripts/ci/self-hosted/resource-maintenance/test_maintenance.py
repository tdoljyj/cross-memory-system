"""Disposable fixture tests only; never point this suite at registered real caches."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

import maintenance as m

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
REGISTRY = REPO / "config" / "ci-resource-maintenance.json"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="managed-cache-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.registry = json.loads(REGISTRY.read_text())
        self.registry["policy"].update(drain_wait_seconds=0, max_seconds=5, free_trigger_fraction=0.000001)
        self.registry["profiles"]["generic"].update(idle_seconds=10, pressure_idle_seconds=0,
                                                    rotate_seconds=0, keep_generations=0)
        self.binding = {"schema": "clued.cache-node/1", "node_id": "fixture-node",
                        "state_root": str(self.root / "state"),
                        "caches": {"packages": {"profile": "generic", "root": str(self.root / "cache")}}}
        self.now = time.time() + 1000
        self.manager = m.Manager(self.registry, self.binding, clock=lambda: self.now)
        self.manager.initialize()

    def generation(self, name="payload.bin", content=b"disposable"):
        with self.manager.writer("packages") as (path, _):
            (path / name).write_bytes(content)
        self.now += 20
        return path

    def child(self, code, *args):
        return subprocess.run([sys.executable, "-c", "import sys;sys.path.insert(0,sys.argv[1]);" + code,
                               str(HERE), *map(str, args)], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)


class MaintenanceTests(Fixture):
    def test_expired_generation_removed_receipts_and_lock_inode_retained(self):
        target = self.generation()
        with m.Lease(self.manager.state / "jobs.lock", False):
            pass
        inode = (self.manager.state / "jobs.lock").stat().st_ino
        result = self.manager.cycle()
        self.assertEqual(result["removed_bytes"], len(b"disposable"))
        self.assertFalse(target.exists())
        self.assertTrue((self.manager.state / "receipts" / result["receipt"]).is_file())
        self.assertEqual((self.manager.state / "jobs.lock").stat().st_ino, inode)
        self.assertFalse((self.manager.state / "drain.json").exists())
        self.assertEqual(self.manager.cycle()["removed_bytes"], 0)

    def test_never_adopts_old_nonempty_cache(self):
        other = self.root / "old-cache"
        other.mkdir()
        victim = other / "irreplaceable.bin"
        victim.write_bytes(b"keep")
        binding = copy.deepcopy(self.binding)
        binding["state_root"] = str(self.root / "other-state")
        binding["caches"]["packages"]["root"] = str(other)
        with self.assertRaisesRegex(m.Refused, "CACHE_NOT_EMPTY|DIRECTORY_PERMISSIONS"):
            m.Manager(self.registry, binding).initialize()
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_unregistered_data_preserved_and_visible(self):
        unknown = self.root / "cache" / "data" / "old-unregistered"
        unknown.mkdir()
        (unknown / "keep.bin").write_bytes(b"unique")
        self.generation()
        result = self.manager.cycle()
        self.assertEqual((unknown / "keep.bin").read_bytes(), b"unique")
        self.assertEqual(result["observations"][0]["unregistered_entries"], 1)

    def test_secret_log_and_receipt_names_preserve_generation(self):
        for name in ("private.pem", "ci.token", "debug.log", "receipt"):
            with self.subTest(name=name):
                target = self.generation(name)
                result = self.manager.cycle()
                self.assertTrue(target.exists())
                self.assertIn("PROTECTED_CONTENT", [r["reason"] for r in result["deferred"]])

    def test_symlink_cannot_escape_to_victim(self):
        target = self.generation()
        victim = self.root / "victim"
        victim.mkdir()
        (victim / "keep.bin").write_bytes(b"keep")
        try:
            (target / "escape").symlink_to(victim, target_is_directory=True)
        except OSError:
            self.skipTest("symlink creation unavailable for this standard account")
        result = self.manager.cycle()
        self.assertTrue(target.exists())
        self.assertEqual((victim / "keep.bin").read_bytes(), b"keep")
        self.assertIn("LINK_OR_DEVICE_BOUNDARY", [r["reason"] for r in result["deferred"]])

    def test_hardlink_cannot_retire_foreign_content(self):
        target = self.generation()
        victim = self.root / "keep.bin"
        victim.write_bytes(b"keep")
        os.link(victim, target / "linked.bin")
        result = self.manager.cycle()
        self.assertTrue(target.exists())
        self.assertIn("HARDLINK_BOUNDARY", [r["reason"] for r in result["deferred"]])
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_real_shared_lease_blocks_exclusive_in_another_process(self):
        path = self.manager.state / "jobs.lock"
        with m.Lease(path, False):
            result = self.child("import maintenance as m;from pathlib import Path;\ntry:\n with m.Lease(Path(sys.argv[2]),True):pass\nexcept m.Refused:sys.exit(7)", path)
        self.assertEqual(result.returncode, 7, result.stderr)

    def test_shared_readers_coexist_across_processes(self):
        path = self.manager.state / "jobs.lock"
        with m.Lease(path, False):
            result = self.child("import maintenance as m;from pathlib import Path;\nwith m.Lease(Path(sys.argv[2]),False):pass", path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_busy_generation_not_deleted(self):
        target = self.generation()
        with m.Lease(self.manager.state / "jobs.lock", False):
            result = self.manager.cycle()
        self.assertEqual(result["code"], "LEASE_BUSY")
        self.assertEqual(result["removed_bytes"], 0)
        self.assertTrue(target.exists())
        self.assertFalse((self.manager.state / "drain.json").exists())

    def test_writer_exception_leaves_uncertain_generation_protected(self):
        target = None
        with self.assertRaises(RuntimeError):
            with self.manager.writer("packages") as (target, _):
                (target / "payload.bin").write_bytes(b"keep")
                raise RuntimeError("simulate missing terminal")
        self.now += 10000
        result = self.manager.cycle()
        self.assertTrue(target.exists())
        self.assertIn("UNSETTLED_WRITER", [r["reason"] for r in result["deferred"]])

    def test_modified_reviewed_plan_never_deletes(self):
        target = self.generation()
        plan = self.manager.plan()
        (target / "new.bin").write_bytes(b"changed")
        result = self.manager.cycle(plan)
        self.assertEqual(result["code"], "PLAN_CHANGED")
        self.assertTrue(target.exists())

    def test_expired_or_cross_node_plan_refused(self):
        target = self.generation()
        for change in ({"expires_at": 0}, {"node_id": "some-other-node"}, {"registry_sha256": "0" * 64}):
            plan = self.manager.plan()
            plan.update(change)
            with self.subTest(change=change):
                self.assertEqual(self.manager.cycle(plan)["code"], "PLAN_BINDING_OR_EXPIRY")
                self.assertTrue(target.exists())

    def test_scan_budget_preserves_oversized_generation(self):
        target = self.generation()
        (target / "second.bin").write_bytes(b"two")
        self.registry["policy"]["max_entries"] = 1
        manager = m.Manager(self.registry, self.binding, clock=lambda: self.now)
        result = manager.cycle()
        self.assertTrue(target.exists())
        self.assertIn("INVENTORY_ENTRY_BUDGET", [r["reason"] for r in result["deferred"]])

    def test_byte_budget_prevents_partial_generation_deletion(self):
        target = self.generation(content=b"x" * 100)
        self.registry["policy"]["max_remove_bytes"] = 99
        manager = m.Manager(self.registry, self.binding, clock=lambda: self.now)
        result = manager.cycle()
        self.assertTrue(target.exists())
        self.assertEqual(result["removed_bytes"], 0)

    def test_overlapping_bindings_and_unknown_profiles_refused(self):
        for spec in ({"profile": "generic", "root": str(self.root / "state" / "nested")},
                     {"profile": "not-registered", "root": str(self.root / "new")}):
            binding = copy.deepcopy(self.binding)
            binding["caches"]["packages"] = spec
            with self.subTest(spec=spec), self.assertRaises(m.Refused):
                m.Manager(self.registry, binding)

    def test_report_does_not_contain_cache_payload(self):
        secret = b"fixture-sensitive-payload-never-log-this"
        self.generation(content=secret)
        result = self.manager.cycle()
        self.assertNotIn(secret.decode(), json.dumps(result))
        for receipt in (self.manager.state / "receipts").iterdir():
            self.assertNotIn(secret, receipt.read_bytes())

    def test_stagger_is_deterministic_for_ten_thousand_nodes(self):
        values = [m.stable_stagger(f"node-{n}", 600) for n in range(10000)]
        self.assertTrue(all(0 <= n <= 600 for n in values))
        self.assertGreater(len(set(values)), 550)
        self.assertEqual(m.stable_stagger("node-9999", 600), values[-1])

    def test_hyphenated_cache_ids_do_not_share_catalogs(self):
        binding = {"schema": "clued.cache-node/1", "node_id": "fixture-node",
                   "state_root": str(self.root / "state-ab"), "caches": {
                       "p": {"profile": "generic", "root": str(self.root / "cache-a")},
                       "p-long": {"profile": "generic", "root": str(self.root / "cache-b")}}}
        manager = m.Manager(self.registry, binding, clock=lambda: self.now)
        manager.initialize()
        for cache_id in binding["caches"]:
            with manager.writer(cache_id) as (path, _):
                (path / "payload.bin").write_bytes(cache_id.encode())
        self.now += 20
        self.assertEqual({c["cache_id"] for c in manager.plan()["candidates"]}, {"p", "p-long"})

    def test_nonfinite_or_inverted_disk_policy_refused(self):
        for trigger, target in ((float("nan"), .3), (.8, .2), (False, .3), (-.1, .2)):
            registry = copy.deepcopy(self.registry)
            registry["policy"].update(free_trigger_fraction=trigger, free_target_fraction=target)
            with self.subTest(trigger=trigger), self.assertRaises(m.Refused):
                m.Manager(registry, self.binding)

    @unittest.skipUnless(os.name == "nt", "Windows junction regression")
    def test_windows_junction_preserves_victim(self):
        target = self.generation()
        victim = self.root / "junction-victim"
        victim.mkdir()
        (victim / "keep.bin").write_bytes(b"keep")
        created = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(target / "escape"), str(victim)],
                                 capture_output=True, text=True)
        self.assertEqual(created.returncode, 0, created.stderr)
        result = self.manager.cycle()
        self.assertTrue(target.exists())
        self.assertEqual((victim / "keep.bin").read_bytes(), b"keep")
        self.assertIn("LINK_OR_DEVICE_BOUNDARY", [r["reason"] for r in result["deferred"]])


if __name__ == "__main__":
    unittest.main()
