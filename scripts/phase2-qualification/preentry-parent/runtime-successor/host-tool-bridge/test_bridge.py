"""New pure input rejection and mocked dispatch checks; no host effects."""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('fixed_host_bridge', Path(__file__).with_name('bridge.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class BridgeChecks(unittest.TestCase):
    def value(self):
        raw = json.dumps({'gate_authorization_id': 'ga_synthetic'})
        return {'operation': 'CREATE', 'nonce': 'a' * 32, 'ga_raw': raw,
                'ga_sha256': hashlib.sha256(raw.encode()).hexdigest(), 'container_id': None}

    def test_fixed_fields_and_complete_bytes(self):
        value = self.value()
        self.assertEqual(m.parse(json.dumps(value).encode()), value)
        for change in [{'operation': 'RUN'}, {'command': 'x'}, {'authorized': True},
                       {'nonce': '../outside'}, {'ga_sha256': 'b' * 64}, {'container_id': 'c' * 64}]:
            with self.assertRaises(ValueError):
                m.parse(json.dumps({**value, **change}).encode())

    def test_duplicate_input_and_ga_keys_rejected(self):
        with self.assertRaises(ValueError):
            m.parse(b'{"operation":"CREATE","operation":"START"}')
        value = self.value()
        value['ga_raw'] = '{"gate_authorization_id":"ga_a","gate_authorization_id":"ga_b"}'
        value['ga_sha256'] = hashlib.sha256(value['ga_raw'].encode()).hexdigest()
        with self.assertRaises(ValueError):
            m.parse(json.dumps(value).encode())

    def test_unknown_existing_reservation_never_dispatches(self):
        h = Mock()
        h.prepare.side_effect = FileExistsError('prior UNKNOWN reservation')
        with self.assertRaises(FileExistsError):
            m.dispatch(self.value(), h)
        h.FixedHost.assert_not_called()

    def test_start_arms_guard_then_single_start_and_observes_running(self):
        h = Mock()
        port = h.FixedHost.return_value
        port.folder = Path('unused-synthetic')
        port.inspect.return_value = {'Id': 'c' * 64, 'State': {'Running': True}}
        value = {**self.value(), 'operation': 'START', 'container_id': 'c' * 64}
        result = m.dispatch(value, h)
        self.assertEqual([c[0] for c in port.method_calls], ['arm_watchdog', 'start_exact', 'inspect'])
        self.assertFalse(result['remote_result_persisted'])
        self.assertFalse(result['capacity_released'])
        h.prepare.assert_not_called()

    def test_missing_running_state_never_becomes_success(self):
        h = Mock()
        h.FixedHost.return_value.folder = Path('unused-synthetic')
        h.FixedHost.return_value.inspect.return_value = {'State': {'Running': False}}
        with self.assertRaises(ValueError):
            m.dispatch({**self.value(), 'operation': 'START', 'container_id': 'c' * 64}, h)
        h.FixedHost.return_value.start_exact.assert_called_once()
        h.FixedHost.return_value.stop_exact.assert_not_called()


if __name__ == '__main__':
    unittest.main()
