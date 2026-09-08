"""Pure fixed-port checks; subprocess is always mocked, no Docker execution."""
from datetime import datetime, timezone, timedelta
import importlib.util
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fixed_host', Path(__file__).with_name('fixed_host.py'))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class Checks(unittest.TestCase):
    def fixture(self, folder):
        value = object.__new__(host.FixedHost)
        value.folder = Path(folder)
        value.prefix = 'main'
        value.nonce = 'a' * 32
        value.container = 'b' * 64
        value.deadline = time.monotonic() + 60
        value.record = {'ga_sha256': 'c' * 64, 'deadline_utc': (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()}
        return value

    def test_unknown_operation_never_reaches_process(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(host.subprocess, 'Popen') as process:
            with self.assertRaises(ValueError):
                self.fixture(folder)._invoke('not-used', 'rm')
            process.assert_not_called()

    def test_persistence_deadline_recheck_prevents_process(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(host.sys, 'platform', 'win32'), patch.object(host.observation, 'digest', return_value=host.observation.DOCKER_SHA), patch.object(host.subprocess, 'Popen') as process:
            session = self.fixture(folder)
            clock = [0]
            def persist(*args): clock[0] = 7
            with patch.object(host.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(host.observation, 'persist', side_effect=persist):
                with self.assertRaises(host.observation.Unknown): session._invoke('create', 'create')
            process.assert_not_called()

    def test_dead_guard_rechecked_after_log_open_prevents_start(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(host.sys, 'platform', 'win32'), patch.object(host.observation, 'digest', return_value=host.observation.DOCKER_SHA), patch.object(host.subprocess, 'Popen') as process:
            session = self.fixture(folder)
            ready = {'container_id': session.container, 'pid': 123, 'nonce': session.nonce, 'deadline_monotonic': session.deadline}
            class Guard:
                pid = 123
                def poll(self): return 1
            with patch.object(host.observation, 'load_record', return_value=ready):
                with self.assertRaises(host.observation.Unknown): session._invoke('start', 'start', guard=Guard())
            process.assert_not_called()

    def test_fixed_cli_never_inherits_host_environment(self):
        captured = {}
        def fake(argv, **kwargs):
            captured.update(argv=argv, **kwargs)
            kwargs['stdout'].write(b'synthetic-only')
            class Process:
                returncode = 0
                def poll(self): return 0
            return Process()
        with tempfile.TemporaryDirectory() as folder, patch.object(host.sys, 'platform', 'win32'), patch.object(host.observation, 'digest', return_value=host.observation.DOCKER_SHA), patch.object(host.subprocess, 'Popen', side_effect=fake), patch.dict(os.environ, {'HOST_SECRET_CANARY': 'SYNTHETIC_ONLY'}):
            self.assertEqual(self.fixture(folder)._invoke('inspect', 'inspect'), 'synthetic-only')
            self.assertEqual(set(captured['env']), {'SystemRoot', 'WINDIR', 'TEMP', 'TMP'})
            self.assertFalse(captured['shell'])
            self.assertEqual(captured['argv'][0], host.parent.DOCKER)
            self.assertIn('--host=' + host.parent.ENDPOINT, captured['argv'])


if __name__ == '__main__':
    unittest.main()
