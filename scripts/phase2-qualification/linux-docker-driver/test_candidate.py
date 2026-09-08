"""Pure model and temporary local evidence checks; never invoke Docker/probe/CI."""
import ast
from contextlib import redirect_stdout
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('linux_candidate', HERE / 'candidate.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
# Deliberately synthetic hex values for pure tests; these are not real images/IDs.
CFG = {'image': 'docker.io/library/python@sha256:' + 'a' * 64, 'run_key': 'b' * 32}
CID = 'c' * 64


def inspect_fixture():
    driver, allowed = m.paths(CFG)
    return {
        'Id': CID,
        'State': {'Status': 'created', 'Running': False, 'Pid': 0},
        'Config': {'Image': CFG['image'], 'User': '10001:10001',
                   'Entrypoint': ['/usr/local/bin/python3'],
                   'Cmd': ['-I', '-S', '-B', '/driver/probe.py'],
                   'WorkingDir': '/allowed', 'Env': [], 'StopTimeout': 2,
                   'Volumes': None, 'Healthcheck': {'Test': ['NONE']}},
        'HostConfig': {
            'ReadonlyRootfs': True, 'Privileged': False, 'NetworkMode': 'none',
            'CapDrop': ['ALL'], 'CapAdd': None, 'SecurityOpt': ['no-new-privileges:true'],
            'NanoCpus': 500000000, 'Memory': 134217728, 'MemorySwap': 134217728,
            'PidsLimit': 16, 'IpcMode': 'private', 'PidMode': '', 'Binds': None,
            'Devices': [], 'DeviceRequests': None, 'VolumesFrom': None,
            'PortBindings': {}, 'PublishAllPorts': False,
            'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
            'Tmpfs': {'/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777'},
            'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '1m', 'max-file': '1'}}},
        'Mounts': [
            {'Type': 'bind', 'Source': driver, 'Destination': '/driver/probe.py', 'RW': False, 'Propagation': 'rprivate'},
            {'Type': 'bind', 'Source': allowed, 'Destination': '/allowed', 'RW': True, 'Propagation': 'rprivate'}]}


def finished_fixture():
    return {'wait_exit_code': 137, 'inspection': {'Id': CID, 'State': {
        'Status': 'exited', 'Running': False, 'Pid': 0, 'ExitCode': 137,
        'FinishedAt': '2026-09-08T11:00:00.123456789Z'}}}


class CandidateChecks(unittest.TestCase):
    def created(self):
        state = m.simulate(m.initial(CFG), 'send_create')['state']
        return m.simulate(state, 'created', CID)['state']

    def test_frozen_probe_digest_and_no_execution_imports(self):
        self.assertEqual(hashlib.sha256(m.PROBE.read_bytes()).hexdigest(), m.PROBE_SHA256)
        tree = ast.parse((HERE / 'candidate.py').read_text(encoding='utf-8'))
        modules = {n.names[0].name for n in ast.walk(tree) if isinstance(n, ast.Import)}
        self.assertFalse(modules & {'subprocess', 'socket', 'requests', 'ctypes'})
        calls = {ast.unparse(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
        self.assertFalse(calls & {'eval', 'exec', 'os.system', 'os.popen', 'os.execv', 'os.spawnv'})

    def test_config_rejects_injected_command_mount_env_tag_and_path(self):
        for key in ('command', 'docker', 'mount', 'env', 'budget', 'qualified'):
            with self.subTest(key=key), self.assertRaises(m.Denied):
                m.config({**CFG, key: 'untrusted'})
        for key, value in [('image', 'python:latest'), ('run_key', '../other'), ('run_key', True)]:
            with self.subTest(key=key, value=value), self.assertRaises(m.Denied):
                m.config({**CFG, key: value})

    def test_argv_limits_two_mounts_no_environment_and_exact_id(self):
        argv = m.create_argv(CFG)
        self.assertEqual(argv[0], '/usr/bin/docker')
        self.assertEqual(argv.count('--mount'), 2)
        for expected in ('--pull=never', '--read-only', '--network=none', '--cap-drop=ALL',
                         '--user=10001:10001', '--memory=128m', '--memory-swap=128m',
                         '--pids-limit=16', '--no-healthcheck', '--security-opt=no-new-privileges:true'):
            self.assertIn(expected, argv)
        self.assertFalse(any(x.startswith(('--env', '--privileged', '--volume')) for x in argv))
        for operation in ('inspect', 'start', 'stop', 'wait'):
            self.assertEqual(m.fixed_argv(operation, CID)[-1], CID)
        for operation, identity in [('exec', CID), ('rm', CID), ('start', 'name'), ('stop', CID[:12])]:
            with self.assertRaises(m.Denied):
                m.fixed_argv(operation, identity)

    def test_create_record_precedes_start_and_inspection_is_mandatory(self):
        state = self.created()
        with self.assertRaises(m.Denied):
            m.simulate(state, 'send_start')
        state = m.simulate(state, 'inspected', inspect_fixture())['state']
        sent = m.simulate(state, 'send_start')
        self.assertEqual(sent['state']['phase'], 'START_SENT')
        self.assertEqual(sent['planned_argv'][-1], CID)
        self.assertFalse(sent['executed'])
        with self.assertRaises(m.Denied):
            m.simulate(sent['state'], 'send_start')

    def test_prestart_security_and_container_identity_drift(self):
        self.assertTrue(m.prestart(CFG, CID, inspect_fixture()))
        changes = [('HostConfig', 'Privileged', True), ('HostConfig', 'NetworkMode', 'host'),
                   ('HostConfig', 'ReadonlyRootfs', False), ('HostConfig', 'Memory', True),
                   ('HostConfig', 'CapAdd', ['SYS_ADMIN']), ('HostConfig', 'PidMode', 'host'),
                   ('Config', 'Cmd', ['/bin/sh']), ('Config', 'Env', ['CANARY=synthetic']),
                   ('Config', 'Healthcheck', {'Test': ['CMD', '/bin/sh']}),
                   ('State', 'Pid', False), ('Config', 'User', '0')]
        for section, key, value in changes:
            v = inspect_fixture()
            v[section][key] = value
            with self.subTest(section=section, key=key):
                self.assertFalse(m.prestart(CFG, CID, v))
                self.assertEqual(m.simulate(self.created(), 'inspected', v)['state']['phase'], 'UNKNOWN')
        for change in ('id', 'mount_source', 'mount_rw', 'extra_mount'):
            v = inspect_fixture()
            if change == 'id': v['Id'] = 'd' * 64
            if change == 'mount_source': v['Mounts'][0]['Source'] = '/var/run/docker.sock'
            if change == 'mount_rw': v['Mounts'][0]['RW'] = True
            if change == 'extra_mount': v['Mounts'].append(copy.deepcopy(v['Mounts'][0]))
            with self.subTest(change=change):
                self.assertFalse(m.prestart(CFG, CID, v))

    def test_unknown_is_sticky_across_create_timeout_and_reconcile_claim(self):
        sent = m.simulate(m.initial(CFG), 'send_create')['state']
        for error in ('timeout', 'interrupted', 'persistence_failure', 'revoked'):
            state = m.simulate(sent, error)['state']
            for event in ('send_create', 'created', 'reconcile'):
                output = m.simulate(state, event, CID)
                self.assertEqual(output['state']['phase'], 'UNKNOWN')
                self.assertIsNone(output['planned_argv'])
        self.assertEqual(m.simulate(sent, 'created', 'short-id')['state']['phase'], 'UNKNOWN')

    def test_stop_requires_separate_intent_and_wait_inspect_agreement(self):
        state = self.created()
        with self.assertRaises(m.Denied):
            m.simulate(state, 'send_stop')
        state = m.simulate(state, 'record_stop_intent')['state']
        stop = m.simulate(state, 'send_stop')
        self.assertEqual(stop['planned_argv'], ['/usr/bin/docker', 'container', 'stop', '--time=2', CID])
        wait = m.simulate(stop['state'], 'send_wait')
        result = m.simulate(wait['state'], 'finished', finished_fixture())
        self.assertEqual(result['state']['phase'], 'STOPPED')
        self.assertFalse(result['qualified'])
        for field, value in [('Pid', False), ('Running', 0), ('FinishedAt', ''),
                             ('FinishedAt', 'garbage'), ('FinishedAt', '0001-01-01T00:00:00Z'),
                             ('FinishedAt', '2026-02-30T11:00:00Z'), ('ExitCode', 0)]:
            observed = finished_fixture()
            observed['inspection']['State'][field] = value
            with self.subTest(field=field, value=value):
                self.assertEqual(m.simulate(wait['state'], 'finished', observed)['state']['phase'], 'UNKNOWN')
        observed = finished_fixture()
        observed['wait_exit_code'] = True
        self.assertEqual(m.simulate(wait['state'], 'finished', observed)['state']['phase'], 'UNKNOWN')

    def test_started_requires_live_typed_matching_observation(self):
        state = m.simulate(self.created(), 'inspected', inspect_fixture())['state']
        state = m.simulate(state, 'send_start')['state']
        self.assertEqual(m.simulate(state, 'started', CID)['state']['phase'], 'UNKNOWN')
        live = {'Id': CID, 'State': {'Running': True, 'Status': 'running', 'Pid': 42}}
        self.assertEqual(m.simulate(state, 'started', live)['state']['phase'], 'RUNNING')
        live['State']['Pid'] = True
        self.assertEqual(m.simulate(state, 'started', live)['state']['phase'], 'UNKNOWN')

    def test_local_intent_reentry_changed_parameters_and_damage_never_overwrite(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'BASE', Path(directory)):
            result = m.prepare(CFG)
            self.assertEqual(result['status'], 'PREPARED_NOT_EXECUTED')
            target = Path(directory) / 'work' / CFG['run_key'] / 'intent.json'
            original = target.read_bytes()
            self.assertEqual(m.prepare(CFG)['status'], 'UNKNOWN')
            self.assertEqual(m.prepare({**CFG, 'image': CFG['image'].replace('a' * 64, 'e' * 64)})['status'], 'UNKNOWN')
            self.assertEqual(target.read_bytes(), original)
            target.write_text('{', encoding='utf-8')
            self.assertEqual(m.prepare(CFG)['status'], 'UNKNOWN')
            self.assertEqual(target.read_text(encoding='utf-8'), '{')

    def test_intent_failure_retains_reservation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(m, 'BASE', Path(directory)):
            with patch.object(m.os, 'fsync', side_effect=OSError('synthetic sink failure')):
                self.assertEqual(m.prepare(CFG)['status'], 'UNKNOWN')
            self.assertTrue((Path(directory) / 'work' / CFG['run_key']).is_dir())
            self.assertEqual(m.prepare(CFG)['status'], 'UNKNOWN')

    def test_formal_and_run_block_before_config_or_any_preparation(self):
        for operation in ('formal', 'run'):
            output = io.StringIO()
            with redirect_stdout(output), patch.object(m, 'prepare', side_effect=AssertionError('must not prepare')):
                self.assertEqual(m.main([operation, '--config', '/missing-file']), 2)
            value = json.loads(output.getvalue())
            self.assertEqual(value['status'], 'BLOCKED')
            self.assertFalse(value['executed'])
            self.assertFalse(value['qualified'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
