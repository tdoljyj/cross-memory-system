import importlib.util
from datetime import datetime, timezone
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('parent_candidate', Path(__file__).with_name('parent.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = datetime(2026, 9, 8, 13, 0, tzinfo=timezone.utc)


def inputs():
    profile = {'profile_id': 'DP-PREENTRY-SKILL-QUALIFICATION', 'required_stages': sorted(m.STAGES),
               'candidate_must_differ_from_controller': True, 'max_lifetime_seconds': 90}
    ga = {'authorization_status': 'AUTHORIZED', 'environment': 'ISOLATED_TEST',
          'purpose': 'SKILL_COEXISTENCE_QUALIFICATION', 'candidate_skill_digest': 'a'*64,
          'controller_digest': 'b'*64, 'issued_at': '2026-09-08T13:00:00Z',
          'expires_at': '2026-09-08T13:01:30Z', 'deadline': '2026-09-08T13:01:30Z',
          'revocation_epoch_vector': {'vector_schema_version': 'SYNTHETIC_NOT_ACCEPTED'}}
    for key in ('control_trust_root_generation', 'runner_generation', 'credential_generation', 'session_generation'):
        ga[key] = 'SYNTHETIC_UNRESOLVED_' + key
    for layer in m.LAYERS:
        ga['revocation_epoch_vector'][layer+'_scope_ref'] = 'synthetic-not-real-'+layer
        ga['revocation_epoch_vector'][layer+'_epoch'] = 1
    return ga, profile


class ParentChecks(unittest.TestCase):
    def test_plausible_ga_or_accepted_boolean_never_opens_admission(self):
        ga, profile = inputs()
        m.reject_constraints(ga, profile, NOW)
        ga.update(accepted=True, qualified=True, signature='NOT_A_SIGNATURE')
        result = m.admission(ga, profile, NOW)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['side_effects_dispatched'], 0)
        self.assertIn('adapter_not_connected', result['reason'])

    def test_expiry_lifetime_and_controller_independence_reject(self):
        for key, value in [('deadline', '2026-09-08T13:00:00Z'), ('expires_at', '2026-09-08T13:11:00Z'),
                           ('expires_at', '2026-09-08T13:01:31Z'),
                           ('controller_digest', 'a'*64), ('environment', 'POST_ENTRY_SLICE_A')]:
            ga, profile = inputs()
            ga[key] = value
            with self.assertRaises(m.Blocked):
                m.reject_constraints(ga, profile, NOW)

    def test_na_never_omits_business_layers_or_control_generations(self):
        ga, profile = inputs()
        ga['revocation_epoch_vector']['account_epoch'] = 'not_applicable'
        with self.assertRaises(m.Blocked):
            m.reject_constraints(ga, profile, NOW)
        ga['revocation_epoch_vector']['account_scope_ref'] = 'not_applicable'
        with self.assertRaises(m.Blocked):
            m.reject_constraints(ga, profile, NOW)
        ga, profile = inputs()
        ga['credential_generation'] = 'not_applicable'
        with self.assertRaises(m.Blocked):
            m.reject_constraints(ga, profile, NOW)

    def test_no_remote_side_effect_on_closed_admission(self):
        ga, profile = inputs()
        with patch.object(m.remote, 'read_back') as read:
            result = m.intent_before_action(object(), {}, b'{}', ga, profile, NOW)
            read.assert_not_called()
            self.assertEqual(result['status'], 'BLOCKED')

    def test_fixed_docker_plan_two_mounts_no_shell_or_target_override(self):
        args = m.fixed_argv('a'*32, 'create')
        self.assertEqual(args[0], m.DOCKER)
        self.assertEqual(args[1], '--host='+m.ENDPOINT)
        self.assertEqual(args.count('--mount'), 2)
        self.assertIn('--network=none', args)
        self.assertIn('--pull=never', args)
        self.assertEqual(args[-len(m.CMD):], m.CMD)
        self.assertTrue(any('target=/driver,readonly' in arg for arg in args))
        for operation in ('exec', 'run', 'rm', 'prune'):
            with self.assertRaises(ValueError):
                m.fixed_argv('a'*32, operation, 'b'*64)
        with self.assertRaises(ValueError):
            m.fixed_argv('../outside', 'create')
        self.assertEqual(m.fixed_argv('a'*32, 'stop', 'b'*64)[-4:], ['container','stop','--time=2','b'*64])

    def test_prestart_bad_identity_mount_and_command_rejected(self):
        self.assertFalse(m.prestart({}, 'a'*32, 'b'*64))
        self.assertFalse(m.prestart({'Id': 'b'*64, 'Image': m.v.IMAGE_DIGEST, 'Name': '/clued-synthetic-'+ 'a'*32,
            'Config': {'Labels': {'clued.scope': 'synthetic-engineering-only'}, 'Cmd': ['arbitrary'], 'Env': m.v.PUBLIC_ENV}}, 'a'*32, 'b'*64))


if __name__ == '__main__':
    unittest.main(verbosity=2)
