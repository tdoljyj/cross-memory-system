"""New pure control-flow checks only; no Docker, process launch, Skill or network."""
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('parent_loss_observe', Path(__file__).with_name('observe.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ParentLossChecks(unittest.TestCase):
    def fake(self):
        h = Mock()
        o = h.observation
        folder = Path('synthetic-unused')
        req = {'deadline_monotonic': 190}
        o.digest.return_value = 'source'
        o.load_record.side_effect = [
            {'harness_sha256': 'source', 'request_sha256': 'digest'}, {}, {'probe': True}]
        o.v.host_valid.return_value = True
        o.v.image_valid.return_value = True
        o.v.prestart.return_value = True
        o.v.probe_valid.return_value = True
        session = o.Session.return_value
        session.invoke.side_effect = ['{}', '[{}]', 'a' * 64]
        session.inspect.side_effect = [{}, {'State': {'Running': True}}]
        h.identity.side_effect = lambda x: x
        guard = h.FixedHost.return_value.arm_watchdog.return_value
        guard.pid = 123
        guard.poll.return_value = None
        return h, folder, req

    def test_actual_exit_only_after_live_probe_and_guard(self):
        h, folder, req = self.fake()
        with patch.object(m, 'exact_request', return_value=(folder, req, 'digest')), \
             patch.object(m.time, 'monotonic', return_value=100), \
             patch.object(m.os, '_exit', side_effect=SystemExit(77)) as abrupt:
            with self.assertRaises(SystemExit) as caught:
                m.parent_process(h)
            self.assertEqual(caught.exception.code, 77)
            abrupt.assert_called_once_with(77)
            h.FixedHost.return_value._invoke.assert_called_once()
            h.FixedHost.return_value.stop_exact.assert_not_called()
            records = [call.args[1] for call in h.observation.persist.call_args_list]
            self.assertEqual(records[-1], 'parent-exit-intent.json')

    def test_config_drift_prevents_start_and_abrupt_exit(self):
        h, folder, req = self.fake()
        h.observation.v.prestart.return_value = False
        with patch.object(m, 'exact_request', return_value=(folder, req, 'digest')), \
             patch.object(m.os, '_exit') as abrupt:
            with self.assertRaises(ValueError):
                m.parent_process(h)
            h.FixedHost.return_value._invoke.assert_not_called()
            abrupt.assert_not_called()

    def test_dead_guard_cannot_claim_parent_loss_observation(self):
        h, folder, req = self.fake()
        h.FixedHost.return_value.arm_watchdog.return_value.poll.return_value = 2
        h.observation.v.probe_valid.return_value = False
        with patch.object(m, 'exact_request', return_value=(folder, req, 'digest')), \
             patch.object(m.time, 'monotonic', return_value=100), \
             patch.object(m.os, '_exit') as abrupt:
            with self.assertRaises(ValueError):
                m.parent_process(h)
            abrupt.assert_not_called()

    def test_request_has_no_ga_or_signature_and_reserves_nonzero_history(self):
        value = m.request(100, datetime(2026, 9, 8, 12, tzinfo=timezone.utc))
        self.assertEqual(value['deadline_monotonic'], 190)
        self.assertEqual(value['cumulative_reserved_seconds_upper_bound'], 1500)
        self.assertEqual(value['authority_effect'], 'NONE')
        self.assertFalse(value['formal_ga_used'])
        self.assertNotIn('gate_authorization_id', value)
        self.assertNotIn('signature_binding', value)

    def test_exact_transitive_dependencies_can_load_without_actions(self):
        with patch.object(m.subprocess, 'Popen', side_effect=AssertionError('No process allowed')):
            h = m.runtime()
            self.assertEqual(h.STOP_RESERVE_SECONDS, 30)
            self.assertEqual(h.observation.PROBE_SHA, m.SOURCES['docker-isolation/probe.py'])


if __name__ == '__main__':
    unittest.main()
