"""Run the actual generated readiness function with a fake systemctl executable.

The fake sleep advances Bash's monotonic SECONDS clock, so a sixty-second
activation timeout is exercised without delaying the test or touching services.
"""
import ast
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
LINUX = HERE.parent / 'linux'


def readiness(name):
    tree = ast.parse((LINUX / name).read_text(encoding='utf-8'))
    return ast.literal_eval(next(n.value for n in tree.body if isinstance(n, ast.Assign)
                                 and any(isinstance(t, ast.Name) and t.id == 'DOCKER_READY' for t in n.targets)))


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
            (root / 'states').write_text('\n'.join(states) + '\n'); (root / 'count').write_text('0\n')
            # An executable, not a shell-function replacement for systemctl:
            # the real timeout utility launches this child for every probe.
            fake = binary / 'systemctl'
            fake.write_text('''#!/bin/bash
set -euo pipefail
[ "$*" = 'show --property=ActiveState --value docker.service' ] || exit 99
n=$(cat "$CASE_DIR/count"); n=$((n+1)); printf '%s\\n' "$n" > "$CASE_DIR/count"
state=$(sed -n "${n}p" "$CASE_DIR/states")
[ -n "$state" ] || state=$(tail -n 1 "$CASE_DIR/states")
[ "$state" != QUERY_ERROR ] || exit 7
printf '%s\\n' "$state"
''', encoding='utf-8', newline='\n')
            fake.chmod(0o755)
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
                                    encoding='utf-8', errors='replace', timeout=15,
                                    env={**os.environ, 'CASE_DIR': root.as_posix()})
            count = int((root / 'count').read_text())
            sleeps = (root / 'sleeps').read_text().splitlines() if (root / 'sleeps').exists() else []
            return result, count, sleeps

    def test_all_kit_generators_embed_identical_fixed_observer(self):
        self.assertEqual(readiness('prep.py'), readiness('first-install.py'))
        for name in ('prep.py', 'first-install.py'):
            result, count, sleeps = self.run_case(['activating', 'active'], first=name)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('READY:10', result.stdout); self.assertEqual(count, 2); self.assertEqual(sleeps, ['10'])

    def test_already_active_never_waits(self):
        result, count, sleeps = self.run_case(['active'])
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(count, 1); self.assertEqual(sleeps, [])

    def test_activating_only_is_bounded_at_sixty_clock_seconds(self):
        result, count, sleeps = self.run_case(['activating'])
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('REFUSED:DOCKER_SERVICE_ACTIVATION_TIMEOUT', result.stdout)
        self.assertEqual(count, 6); self.assertEqual(sleeps, ['10', '20', '30', '40', '50', '60'])

    def test_failed_inactive_unknown_empty_or_query_error_is_not_retried(self):
        for state in ('failed', 'inactive', 'deactivating', 'reloading', 'unknown', '', 'QUERY_ERROR'):
            with self.subTest(state=state):
                result, count, sleeps = self.run_case([state])
                self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
                self.assertIn('REFUSED:' + ('SYSTEMCTL_FAILED' if state == 'QUERY_ERROR' else 'DOCKER_SERVICE_NOT_ACTIVE'), result.stdout)
                self.assertEqual(count, 1); self.assertEqual(sleeps, [])

    def test_activation_becoming_failed_refuses_at_first_failure(self):
        result, count, sleeps = self.run_case(['activating', 'failed', 'active'])
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('REFUSED:DOCKER_SERVICE_NOT_ACTIVE', result.stdout); self.assertEqual(count, 2); self.assertEqual(sleeps, ['10'])

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
                result, count, sleeps = self.run_case(['activating', 'active'], fragment=actual)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(count, 2); self.assertEqual(sleeps, ['10'])
        finally:
            case.tearDown()


if __name__ == '__main__':
    unittest.main()
