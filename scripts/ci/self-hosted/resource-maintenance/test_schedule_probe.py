from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock
import io
import xml.etree.ElementTree as ET

import maintenance as m
import probe
import schedule
import enroll
from test_maintenance import Fixture, HERE


class ScheduleProbeTests(Fixture):
    def test_foreign_writable_parent_rejected_before_registration(self):
        parent = self.root / "replaceable-parent"
        if os.name == "nt":
            m.security.create_directory(parent, "S-1-1-0")  # new disposable Everyone-writable fixture only
        else:
            parent.mkdir(mode=0o777)
            parent.chmod(0o777)
        child = parent / "private-child"
        with self.assertRaisesRegex(m.Refused, "ANCESTOR_PERMISSIONS"):
            m.private_dir(child)
        self.assertFalse(child.exists())

    def test_enrollment_supports_any_node_and_refuses_reuse(self):
        root = self.root / "new-node"
        manager, binding = enroll.enroll(self.registry, "company-node-9999", root)
        self.assertEqual(manager.node, "company-node-9999")
        self.assertEqual(set(m.load_json(binding)["caches"]), {"npm", "pip", "generic", "job-temp"})
        self.assertEqual(manager.cycle()["removed_bytes"], 0)
        with self.assertRaisesRegex(m.Refused, "ENROLL_ROOT_MUST_BE_NEW"):
            enroll.enroll(self.registry, "company-node-9999", root)

    def test_report_stale_foreign_pin_and_no_payload_disclosure(self):
        self.generation("payload.bin", b"secret-fixture-never-in-report")
        self.manager.cycle()
        report = probe.summary(self.manager, self.now)
        self.assertEqual(report["status"], "ok")
        self.assertNotIn("secret-fixture", json.dumps(report))
        self.assertEqual(probe.summary(self.manager, self.now + 100000)["status"], "stale")
        path = self.manager.state / "report.json"
        row = m.load_json(path)
        row["binding_sha256"] = "0" * 64
        m.write_json(path, row)
        with self.assertRaisesRegex(m.Refused, "REPORT_PIN"):
            probe.summary(self.manager, self.now)

    def test_extreme_json_integer_is_refused_without_float_overflow(self):
        self.manager.cycle()
        path = self.manager.state / "report.json"
        row = m.load_json(path)
        row["at"] = 10 ** 400
        m.write_json(path, row)
        with self.assertRaisesRegex(m.Refused, "REPORT_TIME"):
            probe.summary(self.manager, self.now)
        self.registry["policy"]["free_trigger_fraction"] = 10 ** 400
        with self.assertRaisesRegex(m.Refused, "DISK_FRACTION"):
            m.Manager(self.registry, self.binding)

    def test_mountinfo_decodes_all_kernel_escaped_path_characters(self):
        self.assertEqual(m.mount_paths([r'1 2 0:1 / /a\040b\011c\012d\134e rw - x x rw']), ['/' + 'a b\tc\nd\\e'])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux mountinfo boundary")
    def test_escaped_same_device_mount_rejected_before_any_deletion(self):
        root = self.root / 'space and\\backslash'
        m.private_dir(root)
        victim = root / 'payload.bin'
        victim.write_bytes(b'preserve')
        encoded = str(root).replace('\\', r'\134').replace(' ', r'\040')
        original = open
        def fake_open(path, *args, **kwargs):
            return io.StringIO(f'1 2 0:1 / {encoded} rw - ext4 x rw\n') if str(path) == '/proc/self/mountinfo' else original(path, *args, **kwargs)
        with mock.patch('builtins.open', side_effect=fake_open), self.assertRaisesRegex(m.Refused, 'MOUNT_BOUNDARY'):
            m.inspect_tree(root, 100, time.monotonic() + 5)
        self.assertEqual(victim.read_bytes(), b'preserve')

    def test_probe_without_registration_explicitly_reports_not_registered(self):
        env = os.environ.copy()
        env.pop("CLUED_CACHE_NODE_BINDING", None)
        result = subprocess.run([sys.executable, "-I", "-B", str(HERE / "probe.py")],
            env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout.split("CACHE_MAINTENANCE_PROBE ")[1]), {"status": "not-registered"})

    def test_catalog_bound_stops_without_deleting_and_releases_drain(self):
        path = self.generation()
        self.registry["policy"]["max_entries"] = 1
        # Same binding; changing policy is an exact separately pinned registry.
        self.manager = m.Manager(self.registry, self.binding, clock=lambda: self.now)
        m.write_json(self.manager.state / "writers" / "active" / "unknown1", {})
        result = self.manager.cycle()
        self.assertEqual(result["status"], "deferred")
        self.assertEqual(result["code"], "CATALOG_UNKNOWN_ENTRY")
        self.assertTrue(path.exists())
        self.assertFalse((self.manager.state / "drain.json").exists())

    @unittest.skipUnless(os.name == "nt", "Windows task XML")
    def test_windows_schedule_least_privilege_s4u_no_desktop_and_one_instance(self):
        rows = schedule.render(self.manager, self.root / "policy & 1.json", self.root / "node & 1.json", "windows")
        task = ET.fromstring(next(iter(rows.values())))
        ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
        value = lambda name: task.find(".//t:" + name, ns).text
        self.assertEqual(value("RunLevel"), "LeastPrivilege")
        self.assertEqual(value("LogonType"), "S4U")
        self.assertEqual(value("MultipleInstancesPolicy"), "IgnoreNew")
        self.assertEqual(value("UserId"), m.owner_identity())
        self.assertIsNone(task.find('.//t:BootTrigger', ns))
        self.assertEqual(value('Interval'), 'PT5M')
        self.assertTrue(value("Command").endswith("pythonw.exe"))
        self.assertIn("node & 1.json", value("Arguments"))
        self.assertNotIn("ExecutionPolicy", value("Arguments"))

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux systemd definition")
    def test_linux_user_service_has_no_root_and_literal_specifiers(self):
        rows = schedule.render(self.manager, self.root / 'policy%u $NAME".json', self.root / "node.json", "linux")
        unit = next(iter(rows.values()))
        self.assertNotIn("User=root", unit)
        self.assertIn("NoNewPrivileges=true", unit)
        self.assertIn('policy%%u $$NAME\\".json', unit)
        self.assertIn("Restart=on-failure", unit)


if __name__ == "__main__":
    unittest.main()
