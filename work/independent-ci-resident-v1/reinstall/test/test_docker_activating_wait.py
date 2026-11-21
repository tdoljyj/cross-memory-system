"""Run the actual generated readiness function with a fake systemctl executable.

The fake sleep advances Bash's monotonic SECONDS clock, so the 180-second bound on
the unsettled states is exercised without delaying the test or touching services.

Fable ruling 0e418483 (r6 Linux phase A), section 1.2: one read of ActiveState and
Job decides. active passes; activating, or any other state with a queued job, is
not settled yet and is read again after a second; any other state with no job is
final and refused at once; one bound for all unsettled reads together. A refusal
first writes the scene (unit, job queue, boot state) to stderr.

The fake systemctl answers the old query (ActiveState only, --value) as well as the
new one, so the old function run against these cases fails on its verdict, never on
an unknown command. Each line of a case is "state|job" (job empty: no queued job).
"""
import ast
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
LINUX = HERE.parent / 'linux'
LIMIT = 180   # the one bound, in clock seconds; the fake sleep advances the clock by 10


def readiness(name):
    tree = ast.parse((LINUX / name).read_text(encoding='utf-8'))
    return ast.literal_eval(next(n.value for n in tree.body if isinstance(n, ast.Assign)
                                 and any(isinstance(t, ast.Name) and t.id == 'DOCKER_READY' for t in n.targets)))


def tens(n):
    return [str(10 * i) for i in range(1, n + 1)]


class DockerReadiness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = os.environ.get('CLUED_TEST_BASH')
        if not cls.bash:
            cls.bash = r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash')
        if not cls.bash or not pathlib.Path(cls.bash).is_file():
            raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_DOCKER_READINESS_TEST')

    def run_case(self, states, *, first='prep.py', fragment=None):
        with tempfile.TemporaryDirectory(prefix='docker-ready-') as tmp:
            root = pathlib.Path(tmp); binary = root / 'bin'; binary.mkdir()
            (root / 'states').write_text('\n'.join(states) + '\n', newline='\n'); (root / 'count').write_text('0\n')
            # An executable, not a shell-function replacement for systemctl:
            # the real timeout utility launches this child for every probe.
            fake = binary / 'systemctl'
            fake.write_text('''#!/bin/bash
set -euo pipefail
case "$*" in
  'show --property=ActiveState --value docker.service') form=old ;;
  'show --property=ActiveState --property=Job docker.service') form=new ;;
  # the scene a refusal writes: fixed answers, never counted as a probe
  'show -p ActiveState,SubState,Result,Job docker.service') printf 'ActiveState=SCENE_UNIT\\nSubState=dead\\nResult=success\\nJob=\\n'; exit 0 ;;
  'list-jobs --no-legend') for i in $(seq 1 25); do printf 'SCENE_JOB_%s network-online.target start waiting\\n' "$i"; done; exit 0 ;;
  'is-system-running') printf 'SCENE_BOOT_starting\\n'; exit 1 ;;
  *) exit 99 ;;
esac
n=$(cat "$CASE_DIR/count"); n=$((n+1)); printf '%s\\n' "$n" > "$CASE_DIR/count"
line=$(sed -n "${n}p" "$CASE_DIR/states")
[ -n "$line" ] || line=$(tail -n 1 "$CASE_DIR/states")
[ "$line" != QUERY_ERROR ] || exit 7
state=${line%%|*}; job=; case "$line" in *'|'*) job=${line#*|} ;; esac
if [ "$form" = old ]; then printf '%s\\n' "$state"; else printf 'ActiveState=%s\\nJob=%s\\n' "$state" "$job"; fi
''', encoding='utf-8', newline='\n')
            fake.chmod(0o755)
            # once active, the gate reads the image store (r7 phase B ruling, 2.2 item 2): a containerd store here, so these cases are
            # decided by the unit's state alone (the store's own cases: test_role_image_load.py)
            docker = binary / 'docker'
            docker.write_text('''#!/bin/bash
case "$*" in
  'info --format {{json .DriverStatus}}') printf '[["driver-type","io.containerd.snapshotter.v1"]]\\n' ;;
  'info --format {{.Driver}}') printf 'overlayfs\\n' ;;
  *) exit 99 ;;
esac
''', encoding='utf-8', newline='\n')
            docker.chmod(0o755)
            driver = root / 'driver.sh'
            driver.write_text('''set -euo pipefail
CASE_DIR=$(cd "$CASE_DIR" && pwd); export CASE_DIR
export PATH="$CASE_DIR/bin:/usr/bin:/bin"
# Unsetting Bash's special clock makes the test clock a controlled scalar.
# Production never unsets it and retains Bash's monotonic elapsed-time clock.
unset SECONDS; SECONDS=0
refuse() { printf 'REFUSED:%s\\n' "$1"; exit 3; }
sleep() { [ "$1" = 1 ] || exit 98; SECONDS=$((SECONDS+10)); printf '%s\\n' "$SECONDS" >> "$CASE_DIR/sleeps"; }
''' + (fragment if fragment is not None else readiness(first)) + '''docker_ready
printf 'READY:%s\\n' "$SECONDS"
''', encoding='utf-8', newline='\n')
            result = subprocess.run([self.bash, '--noprofile', '--norc', driver.as_posix()], capture_output=True, text=True,
                                    encoding='utf-8', errors='replace', timeout=60,
                                    env={**os.environ, 'CASE_DIR': root.as_posix()})
            count = int((root / 'count').read_text())
            sleeps = (root / 'sleeps').read_text().splitlines() if (root / 'sleeps').exists() else []
            return result, count, sleeps

    def assert_ready(self, result, waited):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('READY:%d' % waited, result.stdout)
        # the seconds waited, in the script's own output: the receipt carries the real number
        self.assertIn('{"dockerReady":"active","waitedSeconds":%d}' % waited, result.stdout.splitlines())

    def assert_refused(self, result, code):
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn('REFUSED:' + code, result.stdout)
        self.assertNotIn('READY:', result.stdout)

    def test_all_kit_generators_embed_identical_fixed_observer(self):
        self.assertEqual(readiness('prep.py'), readiness('first-install.py'))
        for name in ('prep.py', 'first-install.py'):
            result, count, sleeps = self.run_case(['inactive|77', 'inactive|77', 'activating|77', 'active|'], first=name)
            self.assert_ready(result, 30); self.assertEqual(count, 4); self.assertEqual(sleeps, tens(3))

    # the main case: a cold boot, docker's start job queued behind network-online.target and containerd
    def test_cold_boot_queued_start_job_is_waited_for(self):
        result, count, sleeps = self.run_case(['inactive|77', 'inactive|77', 'activating|77', 'active|'])
        self.assert_ready(result, 30); self.assertEqual(count, 4); self.assertEqual(sleeps, tens(3))

    def test_already_active_never_waits(self):
        for job in ('', '77'):
            with self.subTest(job=job):
                result, count, sleeps = self.run_case(['active|' + job])
                self.assert_ready(result, 0); self.assertEqual(count, 1); self.assertEqual(sleeps, [])

    def test_queued_job_that_never_starts_is_bounded(self):
        result, count, sleeps = self.run_case(['inactive|77'])
        self.assert_refused(result, 'DOCKER_SERVICE_ACTIVATION_TIMEOUT')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    def test_activating_only_is_bounded_by_the_same_limit(self):
        result, count, sleeps = self.run_case(['activating|'])
        self.assert_refused(result, 'DOCKER_SERVICE_ACTIVATION_TIMEOUT')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    def test_queued_then_activating_share_one_total_bound(self):
        result, count, sleeps = self.run_case(['inactive|77'] * 5 + ['activating|77'])
        self.assert_refused(result, 'DOCKER_SERVICE_ACTIVATION_TIMEOUT')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    def test_queued_job_that_fails_refuses_at_the_next_read(self):
        result, count, sleeps = self.run_case(['inactive|77', 'failed|', 'active|'])
        self.assert_refused(result, 'DOCKER_SERVICE_NOT_ACTIVE'); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))

    def test_activation_becoming_failed_refuses_at_first_failure(self):
        result, count, sleeps = self.run_case(['activating|', 'failed|', 'active|'])
        self.assert_refused(result, 'DOCKER_SERVICE_NOT_ACTIVE'); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))

    def test_final_states_without_a_job_or_a_query_error_are_not_retried(self):
        for line in ('inactive|', 'failed|', 'deactivating|', 'reloading|', 'unknown|', 'no-such-state|', '|', 'QUERY_ERROR'):
            with self.subTest(line=line):
                result, count, sleeps = self.run_case([line, 'active|'])
                self.assert_refused(result, 'SYSTEMCTL_FAILED' if line == 'QUERY_ERROR' else 'DOCKER_SERVICE_NOT_ACTIVE')
                self.assertEqual(count, 1); self.assertEqual(sleeps, [])

    def test_any_other_state_with_a_queued_job_is_unsettled(self):
        for state in ('inactive', 'failed', 'deactivating', 'reloading', 'unknown', ''):
            with self.subTest(state=state):
                result, count, sleeps = self.run_case([state + '|77', 'active|'])
                self.assert_ready(result, 10); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))

    def test_a_refusal_writes_the_scene_to_stderr(self):
        for states, code in ((['inactive|'], 'DOCKER_SERVICE_NOT_ACTIVE'), (['inactive|77'], 'DOCKER_SERVICE_ACTIVATION_TIMEOUT'),
                             (['QUERY_ERROR'], 'SYSTEMCTL_FAILED')):
            with self.subTest(code=code):
                result, _, _ = self.run_case(states)
                self.assert_refused(result, code)
                err = result.stderr
                self.assertIn('ActiveState=SCENE_UNIT', err)
                self.assertIn('SubState=dead', err)
                # the job queue, its first 20 lines only
                self.assertIn('SCENE_JOB_20 ', err); self.assertNotIn('SCENE_JOB_21 ', err)
                self.assertIn('SCENE_BOOT_starting', err)
                # the scene goes to stderr only: stdout keeps the refusal as its last line
                self.assertNotIn('SCENE_', result.stdout)
                self.assertEqual(result.stdout.splitlines()[-1], 'REFUSED:' + code)

    def test_the_bound_is_written_once(self):
        text = readiness('prep.py')
        self.assertEqual(re.findall(r'\blimit=(\d+)', text), [str(LIMIT)])
        self.assertNotIn('60 -', text)
        # observe only: nothing is started, restarted or reset
        self.assertIsNone(re.search(r'systemctl\s+(start|restart|reset-failed|enable)\b', text))

    def test_actual_generated_reinstall_a_b_and_resume_keep_the_same_bounded_gate(self):
        spec = importlib.util.spec_from_file_location('docker_test_prep_fixture', HERE / 'test_reinstall_kit.py')
        fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
        case = fixture.Prep(); case.setUp()
        try:
            argv, work, _ = case.source_v2_inputs()
            generated = fixture.run_prep(argv)
            self.assertEqual(generated.returncode, 0, generated.stderr)
            scripts = json.loads(generated.stdout)['scripts']; self.assertEqual(len(scripts), 3)
            for name in scripts:
                text = (pathlib.Path(work) / 'linux' / name).read_text(encoding='utf-8')
                start = text.index('docker_ready() {'); end = text.index('\n}\n', start) + 3
                actual = text[start:end]
                self.assertIn(actual, readiness('prep.py'))
                self.assertGreater(text.count('\ndocker_ready\n') + text.count('\n  docker_ready\n'), 0)
                result, count, sleeps = self.run_case(['inactive|77', 'active|'], fragment=actual)
                self.assert_ready(result, 10); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))
        finally:
            case.tearDown()


if __name__ == '__main__':
    unittest.main()
