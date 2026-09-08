import importlib.util
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
import unittest
from unittest.mock import patch

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bridge600', BASE.parent / 'host-tool-bridge600' / 'bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
host = bridge.load_host()


class Window600(unittest.TestCase):
    def test_600_reaches_fixed_staging_but_601_is_rejected_before_any_write(self):
        now = datetime(2026, 9, 8, 17, 0, 0, tzinfo=timezone.utc)
        class Clock:
            @staticmethod
            def now(tz):
                return now
        with patch.object(host.sys, 'platform', 'win32'), patch.object(host.observation, 'digest', return_value=host.observation.DOCKER_SHA), patch.object(host, 'datetime', Clock), patch.object(host.parent, 'paths', side_effect=RuntimeError('fixed staging reached')) as paths:
            with self.assertRaisesRegex(RuntimeError, 'fixed staging reached'):
                host.prepare('a' * 32, json.dumps({'deadline': (now + timedelta(seconds=600)).isoformat()}))
            self.assertEqual(paths.call_count, 1)
            with self.assertRaisesRegex(ValueError, 'Current bounded deadline required'):
                host.prepare('a' * 32, json.dumps({'deadline': (now + timedelta(seconds=601)).isoformat()}))
            self.assertEqual(paths.call_count, 1)

    def test_bridge_binds_new_host_with_original_stop_reserve(self):
        self.assertEqual(host.MAX_GA_SECONDS, 600)
        self.assertEqual(host.STOP_RESERVE_SECONDS, 30)
        self.assertEqual(host.START_MAX_SECONDS, 6)
        self.assertEqual(bridge.HOST.parent.name, 'host-runtime600')

    def test_literal_program_flushes_fixture_before_bounded_wait_and_installs_stop_handler(self):
        import runpy
        import time
        import signal
        with patch.object(runpy, 'run_path', return_value={'isolated_action_primitive': lambda: {'synthetic': True}}), patch.object(time, 'sleep') as sleep, patch.object(signal, 'signal') as handler, patch('builtins.print') as output:
            exec(compile(host.parent.PROGRAM, '<fixed reviewed literal>', 'exec'), {})
        sleep.assert_called_once_with(600)
        self.assertTrue(output.call_args.kwargs['flush'])
        self.assertEqual(handler.call_args.args[0], signal.SIGTERM)


if __name__ == '__main__':
    unittest.main()
