"""Task 4a, the Linux half: `selfcheck` runs DESIGN 70.7's probe (the worker unit's view settings handed to systemd-run, view-check inside)
and counts the labelled containers, between batches only. Offline, any OS: systemd-run, systemctl and docker are fakes; the unit text is
the real unit file, so the probe's arguments are the real ones. The answer is always one JSON object (the failure is in it), and a probe
that could not run or a container list that could not be read is never reported as a pass."""
import importlib.machinery
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
R = HERE.parent
loader = importlib.machinery.SourceFileLoader('resident_linux_selfcheck', str(R / 'linux' / 'bin' / 'clued-ci-resident-linux'))
spec = importlib.util.spec_from_loader('resident_linux_selfcheck', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

WORKER_UNIT = (R / 'linux' / 'systemd' / 'clued-ci-worker@.service').read_text(encoding='utf8')
JOB = '0' * 64
NOW = lambda: '2026-11-15T10:00:00Z'
IDLE = 'clued-ci-worker@' + 'a' * 64 + '.service  loaded inactive dead worker\n'
ACTIVE = 'clued-ci-worker@' + 'a' * 64 + '.service  loaded active running worker\n'


class Docker:
    def __init__(self, rows='', fail=False):
        self.rows, self.fail = rows, fail

    def __call__(self, argv):
        assert argv == tool.NONCE_LIST, argv
        return (1, '') if self.fail else (0, self.rows)


class Probe:
    """systemd-run as a fake: records the argv; the view-check inside answers what the test says."""
    def __init__(self, code=0, out='', raises=None):
        self.code, self.out, self.raises, self.calls = code, out, raises, []

    def __call__(self, argv):
        self.calls.append(list(argv))
        if self.raises:
            raise self.raises
        return self.code, self.out


def check(units=lambda: IDLE, probe=None, docker=None):
    probe = probe or Probe()
    return tool.selfcheck(units, WORKER_UNIT, probe, docker or Docker(), NOW), probe


class SelfcheckAnswers(unittest.TestCase):
    def test_a_clean_node_passes_with_the_real_probe_arguments(self):
        out, probe = check()
        self.assertEqual(out, {'contract': tool.SELFCHECK_CONTRACT, 'at': NOW(), 'state': 'DONE', 'view': {'ok': True, 'code': None, 'failures': []},
                               'containers': {'count': 0, 'code': None}})
        (argv,) = probe.calls
        self.assertEqual(argv[:4], ['/usr/bin/systemd-run', '--wait', '--pipe', '--collect'])
        self.assertEqual(argv[-3:], ['view-check', '--instance', JOB])
        self.assertEqual(argv[-4], '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux')
        # exactly the unit's own view settings, with the instance filled in, and nothing else
        self.assertEqual(argv[4:-4], tool.namespace_properties(WORKER_UNIT, JOB))
        self.assertIn(f'--property=BindPaths=-{tool.STATE}/workspaces/{JOB}', argv)

    def test_a_probe_that_fails_reports_the_check_codes(self):
        refused = json.dumps({'status': 'REFUSED', 'code': 'WORKER_VIEW_CHECK_FAILED', 'details': ['EARLIER_ARCHIVES_VISIBLE', 'NOT_WRITABLE:/var/lib/x', 'free text with spaces']})
        out, _ = check(probe=Probe(code=1, out='noise\n' + refused + '\n'))
        self.assertFalse(out['view']['ok'])
        self.assertEqual(out['view']['code'], 'WORKER_VIEW_CHECK_FAILED')
        self.assertEqual(out['view']['failures'], ['EARLIER_ARCHIVES_VISIBLE', 'NOT_WRITABLE:/var/lib/x'])
        out, _ = check(probe=Probe(code=1, out='systemd-run: unit failed\n'))
        self.assertEqual((out['view']['ok'], out['view']['code'], out['view']['failures']), (False, 'VIEW_PROBE_FAILED', []))

    def test_a_probe_that_could_not_run_is_a_failure_never_a_pass(self):
        self.assertEqual(check(probe=Probe(raises=OSError('no systemd-run')))[0]['view'], {'ok': False, 'code': 'VIEW_PROBE_NOT_RUN', 'failures': []})
        self.assertEqual(check(probe=Probe(raises=subprocess.TimeoutExpired('systemd-run', 60)))[0]['view'], {'ok': False, 'code': 'VIEW_PROBE_TIMEOUT', 'failures': []})

    def test_a_leftover_container_is_counted_and_an_unreadable_list_is_not_zero(self):
        rows = f'{"a" * 64} exited\n{"b" * 64} running\n'
        self.assertEqual(check(docker=Docker(rows))[0]['containers'], {'count': 2, 'code': None})
        self.assertEqual(check(docker=Docker(fail=True))[0]['containers'], {'count': None, 'code': 'DOCKER_READ_UNCONFIRMED'})

    def test_while_a_unit_runs_nothing_is_judged_and_the_probe_does_not_start(self):
        out, probe = check(units=lambda: ACTIVE)
        self.assertEqual(out, {'contract': tool.SELFCHECK_CONTRACT, 'at': NOW(), 'state': 'BUSY'})
        self.assertEqual(probe.calls, [])
        # a batch that starts during the probe makes the answer BUSY too (its container is not a leftover)
        seen = iter([IDLE, ACTIVE])
        out, probe = check(units=lambda: next(seen), docker=Docker(f'{"a" * 64} running\n'))
        self.assertEqual(out['state'], 'BUSY')
        self.assertNotIn('containers', out)

    def test_the_command_is_wired_to_the_worker_unit_file_and_the_real_ports(self):
        with tempfile.TemporaryDirectory() as d:
            unit = pathlib.Path(d) / 'clued-ci-worker@.service'
            unit.write_text(WORKER_UNIT, encoding='utf8')
            seen = []

            def fake_run(argv, timeout=30):
                seen.append((argv, timeout))
                return 0, ''
            with mock.patch.object(tool, 'WORKER_UNIT_FILE', str(unit)), mock.patch.object(tool, 'list_units', lambda: IDLE), mock.patch.object(tool, 'run', fake_run), \
                    mock.patch.object(tool, 'docker_port', Docker()), mock.patch('os.geteuid', create=True, return_value=0):
                out = tool.main(['selfcheck'])
        self.assertEqual((out['state'], out['view']['ok'], out['containers']['count']), ('DONE', True, 0))
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0][0], '/usr/bin/systemd-run')
        self.assertLessEqual(seen[0][1], 60)

    def test_selfcheck_only_reads_and_removes_nothing(self):
        text = (R / 'linux' / 'bin' / 'clued-ci-resident-linux').read_text(encoding='utf8')
        body = text[text.index('def selfcheck('):text.index('def _entries(')]
        for forbidden in ("'rm'", "'inspect'", 'os.remove', 'shutil', 'os.rename', 'open(', "'start'", "'stop'"):
            self.assertNotIn(forbidden, body)


if __name__ == '__main__':
    unittest.main()
