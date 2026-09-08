"""Pure validation and temporary-local-evidence tests. All process launch denied."""
from contextlib import redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fixed_observer', HERE / 'observe.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
v = m.v
NONCE, CID = 'b' * 32, 'c' * 64  # Synthetic values, not real resources.


def intent():
    start = time.monotonic()
    return {'nonce': NONCE, 'image': v.IMAGE, 'probe_sha256': m.PROBE_SHA,
            'source_bindings': m.source_bindings(), 'started_monotonic': start,
            'deadline_monotonic': start + 90}


def image_fixture():
    return {'Id': v.IMAGE_DIGEST, 'Architecture': 'amd64', 'Os': 'linux',
            'Descriptor': {'digest': v.IMAGE_DIGEST}, 'RepoDigests': ['python@' + v.IMAGE_DIGEST],
            'RootFS': {'Type': 'layers', 'Layers': v.DIFF_IDS},
            'Config': {'Env': list(v.PUBLIC_ENV), 'Cmd': ['python3'], 'WorkingDir': '/'}}


def container_fixture(folder):
    # Reuse the independently prepared pure test's synthetic Docker shape. No
    # subprocess or actual observation is imported/executed by this fixture load.
    spec = importlib.util.spec_from_file_location('synthetic_model_fixture', v.MODEL_PATH.parent / 'test_candidate.py')
    fixture_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture_module)
    value = fixture_module.inspect_fixture()
    value.update({'Id': CID, 'Image': v.IMAGE_DIGEST, 'Name': '/clued-synthetic-' + NONCE})
    value['Config'].update({'Image': v.IMAGE, 'Env': list(v.PUBLIC_ENV),
        'Labels': {'clued.observation': NONCE, 'clued.scope': 'synthetic-engineering-only'}})
    value['Mounts'][0]['Source'] = str(folder / 'probe.py')
    value['Mounts'][1]['Source'] = str(folder / 'allowed')
    return value


class Checks(unittest.TestCase):
    def setUp(self):
        self.no_launch = patch.object(m.subprocess, 'Popen', side_effect=AssertionError('No process allowed in pure tests'))
        self.no_launch.start()
        self.addCleanup(self.no_launch.stop)

    def test_frozen_inputs_and_literal_environment_only(self):
        self.assertEqual(m.digest(m.PROBE), m.PROBE_SHA)
        self.assertEqual(m.digest(v.MODEL_PATH), v.MODEL_SHA)
        with patch.dict(m.os.environ, {'DOCKER_HOST': 'tcp://untrusted', 'SECRET': 'synthetic',
                                     'CLUED_SYNTHETIC_CREDENTIAL_CANARY': 'synthetic'}):
            env = m.environment(Path('C:/fixed'))
            self.assertEqual(set(env), {'SystemRoot', 'WINDIR', 'TEMP', 'TMP'})
            self.assertNotIn('SECRET', env)
            self.assertNotIn('DOCKER_HOST', env)

    def test_create_has_two_fixed_mounts_exact_image_and_no_override_interface(self):
        with tempfile.TemporaryDirectory() as folder:
            args = m.create_args(NONCE, Path(folder))
            self.assertEqual(args[:2], ['container', 'create'])
            self.assertEqual(args.count('--mount'), 2)
            for item in ('--network=none', '--read-only', '--cap-drop=ALL', '--no-healthcheck',
                         '--memory=128m', '--memory-swap=128m', '--cpus=0.5', '--pids-limit=16',
                         '--pull=never', '--user=10001:10001', v.IMAGE):
                self.assertIn(item, args)
            self.assertNotIn('--env', args)
            self.assertFalse(any('docker.sock' in item or item.startswith('--privileged') for item in args))

    def test_image_public_environment_digest_layers_and_entrypoint_drift(self):
        self.assertTrue(v.image_valid(image_fixture()))
        for mutation in ('env', 'image', 'layers', 'entrypoint', 'healthcheck', 'volumes'):
            value = image_fixture()
            if mutation == 'env': value['Config']['Env'].append('SECRET=synthetic')
            if mutation == 'image': value['Id'] = v.CONFIG_DIGEST
            if mutation == 'layers': value['RootFS']['Layers'] = []
            if mutation == 'entrypoint': value['Config']['Entrypoint'] = ['/bin/sh']
            if mutation == 'healthcheck': value['Config']['Healthcheck'] = {'Test': ['CMD', '/bin/sh']}
            if mutation == 'volumes': value['Config']['Volumes'] = {'/host': {}}
            with self.subTest(mutation=mutation): self.assertFalse(v.image_valid(value))

    def test_host_version_drift(self):
        value = {'Version': '29.7.2', 'GitCommit': '6a43e3d', 'Os': 'linux', 'Arch': 'amd64',
                 'ApiVersion': '1.55', 'KernelVersion': '6.18.33.2-microsoft-standard-WSL2'}
        self.assertTrue(v.host_valid(value))
        value['Version'] = 'other'
        self.assertFalse(v.host_valid(value))

    def test_exact_container_ownership_and_prestart_narrow_env_adapter(self):
        with tempfile.TemporaryDirectory() as path:
            folder = Path(path)
            value = container_fixture(folder)
            self.assertTrue(v.prestart(value, CID, NONCE, folder / 'probe.py', folder / 'allowed'))
            for mutation in ('nonce', 'env', 'socket', 'rw', 'privileged', 'command'):
                changed = copy.deepcopy(value)
                if mutation == 'nonce': changed['Config']['Labels']['clued.observation'] = 'other'
                if mutation == 'env': changed['Config']['Env'].append('CANARY=synthetic')
                if mutation == 'socket': changed['Mounts'][0]['Source'] = '/var/run/docker.sock'
                if mutation == 'rw': changed['Mounts'][0]['RW'] = True
                if mutation == 'privileged': changed['HostConfig']['Privileged'] = True
                if mutation == 'command': changed['Config']['Cmd'] = ['/bin/sh']
                with self.subTest(mutation=mutation):
                    self.assertFalse(v.prestart(changed, CID, NONCE, folder / 'probe.py', folder / 'allowed'))

    def test_windows_mount_alias_is_exact(self):
        p = 'C:/Users/Windows/fixed/probe.py'
        self.assertTrue(v.source_matches('/run/desktop/mnt/host/c/Users/Windows/fixed/probe.py', p))
        self.assertFalse(v.source_matches('/run/desktop/mnt/host/c/Users/Windows/other/probe.py', p))
        self.assertFalse(v.source_matches(p + '/../../secret', p))

    def test_cli_allowlist_and_deadline_precede_launch(self):
        with tempfile.TemporaryDirectory() as path:
            s = m.Session(Path(path), intent())
            with self.assertRaises(v.model.Denied): s.command('exec')
            with self.assertRaises(v.model.Denied): s.command('stop')
            s.identity = CID
            self.assertEqual(s.command('stop')[-1], CID)
            s.deadline = time.monotonic() - 1
            with self.assertRaises(m.Unknown): s.invoke('never', 'create')
            self.assertFalse(list(Path(path).iterdir()))

    def test_stop_verifies_ownership_before_mutation(self):
        with tempfile.TemporaryDirectory() as path:
            s = m.Session(Path(path), intent())
            s.identity = CID
            with patch.object(s, 'inspect', side_effect=m.Unknown('wrong owner')), patch.object(s, 'invoke') as call:
                with self.assertRaises(m.Unknown): s.stop()
                call.assert_not_called()

    def test_intent_deadline_and_source_tampering_rejected(self):
        for key, value in [('source_bindings', {}), ('image', 'python:latest'), ('deadline_monotonic', 0),
                           ('nonce', '../outside'), ('started_monotonic', True)]:
            changed = intent(); changed[key] = value
            with self.subTest(key=key), self.assertRaises((m.Unknown, v.model.Denied)):
                m.Session(Path('.'), changed)

    def test_create_new_evidence_and_no_overwrite_after_truncation(self):
        with tempfile.TemporaryDirectory() as path:
            folder = Path(path)
            m.persist(folder, 'intent.json', {'synthetic': True})
            original = (folder / 'intent.json').read_bytes()
            with self.assertRaises(FileExistsError): m.persist(folder, 'intent.json', {'synthetic': False})
            self.assertEqual((folder / 'intent.json').read_bytes(), original)
            (folder / 'intent.json').write_bytes(b'{')
            with self.assertRaises(ValueError): m.load_record(folder / 'intent.json')
            with self.assertRaises(FileExistsError): m.persist(folder, 'intent.json', {'synthetic': True})

    def test_sink_cap_and_failure_do_not_launch_any_process(self):
        with tempfile.TemporaryDirectory() as path:
            folder = Path(path)
            with patch.object(m, 'MAX_EVIDENCE', 2), self.assertRaises(m.Unknown):
                m.persist(folder, 'intent.json', {'test': True})
            self.assertFalse(list(folder.iterdir()))
            with patch.object(m.os, 'fsync', side_effect=OSError('synthetic failure')):
                with self.assertRaises(OSError): m.persist(folder, 'intent.json', {'test': True})
            self.assertTrue((folder / 'intent.json').exists())

    def test_formal_rejected_before_observation(self):
        out = io.StringIO()
        with redirect_stdout(out), patch.object(m, 'observe', side_effect=AssertionError('must not observe')):
            self.assertEqual(m.main(['formal']), 2)
        value = json.loads(out.getvalue())
        self.assertFalse(value['qualified'])
        self.assertFalse(value['pqual_executed'])

    def test_probe_requires_real_fields_not_success_string_or_timeout(self):
        self.assertFalse(v.probe_valid({'checks_observed': True}))
        value = {'pid': 1, 'uid': 10001, 'interfaces': ['lo'], 'status': {
            'NoNewPrivs': '1', 'CapEff': '0000000000000000', 'CapPrm': '0000000000000000'},
            'credential_canary_inherited': False, 'network_errno': 101,
            'descendant_pid': 7, 'descendant_readiness': {'pid': 7, 'ppid': 1, 'uid': 10001, 'sigterm_ignored': True}}
        for key in ('allowed_write', 'rootfs_write_denied', 'private_canary_read_denied',
                    'loopback_positive_control', 'network_denied', 'tree_active', 'checks_observed'):
            value[key] = True
        self.assertTrue(v.probe_valid(value))
        value['network_errno'] = 110
        self.assertFalse(v.probe_valid(value))


if __name__ == '__main__':
    unittest.main(verbosity=2)
