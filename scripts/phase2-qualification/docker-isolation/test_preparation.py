"""Preparation/denial tests only. No Docker, Linux probe or network is executed."""
import ast
import contextlib
import errno
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location('docker_probe_' + name, BASE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


p = module('prepare')
probe = module('probe')
# Deliberately synthetic syntax fixture; never reported as a real image digest.
VALUE = {'image': 'docker.io/library/python@sha256:' + 'f' * 64, 'run_key': 'e' * 32}


class PreparationTests(unittest.TestCase):
    def test_null_and_floating_images_are_denied(self):
        for image in (None, 'python:3.12', 'python:latest', '--privileged'):
            with self.assertRaises(p.Denied):
                p.config({**VALUE, 'image': image})

    def test_config_cannot_add_command_environment_or_permissions(self):
        for key, value in [('command', 'arbitrary'), ('env', {'SECRET': 'synthetic'}), ('network', 'host'), ('user', '0')]:
            with self.assertRaises(p.Denied):
                p.config({**VALUE, key: value})
        with self.assertRaises(p.Denied):
            p.config({**VALUE, 'run_key': '../outside'})

    def test_planned_argv_contains_fixed_limits_and_only_two_scoped_mounts(self):
        argv = p.create_argv(VALUE['image'], 'clued-synthetic-' + VALUE['run_key'], BASE / 'work' / 'allowed', BASE / 'probe.py')
        for flag in ['--pull=never', '--user=10001:10001', '--read-only', '--network=none', '--cap-drop=ALL',
                     '--security-opt=no-new-privileges:true', '--cpus=0.5', '--memory=128m', '--memory-swap=128m', '--pids-limit=16']:
            self.assertIn(flag, argv)
        mounts = [argv[i + 1] for i, part in enumerate(argv) if part == '--mount']
        self.assertEqual(len(mounts), 2)
        self.assertTrue(mounts[0].endswith('target=/driver/probe.py,readonly'))
        self.assertTrue(mounts[1].endswith('target=/allowed'))
        self.assertFalse(any(part.startswith(('--env', '--privileged', '--device', '--volumes-from')) for part in argv))
        self.assertEqual(argv[-4:], ['-I', '-S', '-B', '/driver/probe.py'])

    def test_mount_delimiters_cannot_inject_a_second_docker_option(self):
        with self.assertRaises(p.Denied):
            p.create_argv(VALUE['image'], 'fixed', '/tmp/a,target=/host', BASE / 'probe.py')

    def test_both_execution_entries_deny_before_any_preparation(self):
        for operation in ('run', 'formal'):
            with mock.patch('sys.argv', ['prepare.py', operation]), mock.patch.object(p, 'prepare', side_effect=AssertionError('Must not prepare/run')):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    self.assertEqual(p.main(), 2)
                result = json.loads(output.getvalue())
                self.assertEqual(result['status'], 'BLOCKED')
                self.assertFalse(result['executed'])

    def test_existing_truncated_intent_remains_unknown_without_overwrite(self):
        work = BASE / 'work'
        work.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='static-check-', dir=work) as temporary:
            root = Path(temporary)
            run = root / VALUE['run_key']
            run.mkdir()
            intent = run / 'intent.json'
            intent.write_bytes(b'{truncated')
            with mock.patch.object(p, 'WORK', root):
                result = p.prepare(VALUE)
            self.assertEqual(result['status'], 'UNKNOWN')
            self.assertFalse(result['executed'])
            self.assertEqual(intent.read_bytes(), b'{truncated')
            self.assertEqual([x.name for x in run.iterdir()], ['intent.json'])

    def test_stop_requires_exact_container_and_observed_terminal_state(self):
        cid = 'd' * 64
        state = {'Id': cid, 'State': {'Running': False, 'Pid': 0, 'Status': 'exited', 'FinishedAt': '2026-09-08T00:00:00Z'}}
        self.assertTrue(p.stopped(state, cid))
        for changed in [{'Running': True}, {'Pid': 123}, {'Status': 'running'}, {'FinishedAt': '0001-01-01T00:00:00Z'}]:
            self.assertFalse(p.stopped({**state, 'State': {**state['State'], **changed}}, cid))
        self.assertFalse(p.stopped({**state, 'Id': 'a' * 64}, cid))

    def test_timeout_and_refused_connection_are_not_network_denial_proof(self):
        for number in (errno.ENETUNREACH, errno.EPERM, errno.EACCES):
            self.assertTrue(probe.network_denial(OSError(number, 'synthetic')))
        for error in (TimeoutError(), OSError(errno.ECONNREFUSED, 'synthetic'), OSError(errno.ETIMEDOUT, 'synthetic')):
            self.assertFalse(probe.network_denial(error))

    def test_preparer_has_no_process_execution_api(self):
        source = (BASE / 'prepare.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        imported = {node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)}
        self.assertFalse(imported & {'subprocess', 'socket', 'ctypes'})
        self.assertNotIn('os.system', source)


if __name__ == '__main__':
    unittest.main(verbosity=2)
