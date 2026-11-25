"""Run the actual generated readiness function with a fake systemctl executable.

The fake sleep advances the test's boot clock (an uptime file the driver sets as UPTIME after the text; production sets it once
to /proc/uptime) and Bash's SECONDS alike, so the 180-second bound is exercised without delaying the test or touching
services. Bash's SECONDS is the wall clock (bash 5.2 get_seconds: gettimeofday), which a suspended guest steps: the bound is
kept on the boot clock, and a case steps SECONDS alone to hold that.

Fable ruling 0e418483 (r6 Linux phase A), section 1.2, as changed by the phase A systemd ruling (task 87d330d0, 1.1 and 1.2): one
read of ActiveState and Job decides. active passes; activating, or any other state with a queued job, is not settled yet and is
read again after a second; any other state with no job is final and refused at once. A query that fails (whatever the cause: the
bus not up yet on a cold boot, a timeout) is not settled either. One bound for all unsettled reads together; at the bound the
code is the last read's: SYSTEMCTL_FAILED after a failed query, else DOCKER_SERVICE_ACTIVATION_TIMEOUT. A refusal first writes the
scene to stderr: the long parts first, then the unit, job queue and boot state, then a short block (uptime, the manager's private
socket, PID 1's state, memory, pressure) and, last, the code: the launcher keeps only the last 2000 characters of stderr.

The fake systemctl answers the old query (ActiveState only, --value) as well as the new one, so an old function run against these
cases fails on its verdict, never on an unknown command. Each line of a case is "state|job" (job empty: no queued job), QUERY_ERROR
(exit 7) or BUS_DOWN (systemd's bus not there: its message on stderr, exit 1).
"""
import ast
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
LINUX = HERE.parent / 'linux'
RES = HERE.parents[1]
LIMIT = 180   # the one bound, in boot-clock seconds; the fake sleep advances the clock by 10
BOOT = 500    # the test's boot clock when docker_ready starts
PASS_LINE = re.compile(r'\{"dockerReady":"active","waitedSeconds":(\d+),"queryFailedSeconds":(\d+),"bootSeconds":(\d+|null)\}')
KEEP = 2000   # the launcher's stderrTail (reinstall/launcher/template.ps1 Tail)
BUS = 'Failed to connect to bus: No such file or directory'


def readiness(name):
    tree = ast.parse((LINUX / name).read_text(encoding='utf-8'))
    return ast.literal_eval(next(n.value for n in tree.body if isinstance(n, ast.Assign)
                                 and any(isinstance(t, ast.Name) and t.id == 'DOCKER_READY' for t in n.targets)))


def tens(n):
    return [str(10 * i) for i in range(1, n + 1)]


def bash_path():
    found = os.environ.get('CLUED_TEST_BASH')
    if not found:
        found = r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('bash')
    if not found or not pathlib.Path(found).is_file():
        raise RuntimeError('NON_WSL_BASH_REQUIRED_FOR_DOCKER_READINESS_TEST')
    return found


# Fakes for the scene's long parts: 50 lines of 100 characters each (5000), or a failure
def long_fake(word, fail=False):
    if fail:
        return '#!/bin/bash\necho "%s broke" >&2\nexit 5\n' % word
    return '#!/bin/bash\nfor i in $(seq 1 50); do printf "%%s_%%02d_%%s\\n" %s "$i" "$(printf "%%080d" 0)"; done\n' % word


SYSTEMCTL = '''#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CASE_DIR/calls"
case "$*" in
  'show --property=ActiveState --value docker.service') form=old ;;
  'show --property=ActiveState --property=Job docker.service') form=new ;;
  'show --property=Version') form=version ;;
  # the scene a refusal writes: fixed answers, never counted as a probe
  'show -p ActiveState,SubState,Result,Job docker.service') printf 'ActiveState=SCENE_UNIT\\nSubState=dead\\nResult=success\\nJob=\\n'; exit 0 ;;
  'list-jobs --no-legend') for i in $(seq 1 25); do printf 'SCENE_JOB_%s network-online.target start waiting\\n' "$i"; done; exit 0 ;;
  'is-system-running') printf 'SCENE_BOOT_starting\\n'; exit 1 ;;
  'enable docker.service'|'start docker.service'|'restart docker.service')
    [ ! -e "$CASE_DIR/bus_down_for_all" ] || { echo 'Failed to connect to bus: No such file or directory' >&2; exit 1; }; exit 0 ;;
  'is-active docker.service') echo active; exit 0 ;;
  *) exit 99 ;;
esac
n=$(cat "$CASE_DIR/count"); n=$((n+1)); printf '%s\\n' "$n" > "$CASE_DIR/count"
line=$(sed -n "${n}p" "$CASE_DIR/states")
[ -n "$line" ] || line=$(tail -n 1 "$CASE_DIR/states")
[ "$line" != QUERY_ERROR ] || exit 7
[ "$line" != BUS_DOWN ] || { echo 'Failed to connect to bus: No such file or directory' >&2; exit 1; }
state=${line%%|*}; job=; case "$line" in *'|'*) job=${line#*|} ;; esac
if [ "$form" = version ]; then printf 'Version=255.4-1ubuntu8\\n'; rm -f "$CASE_DIR/bus_down_for_all"
elif [ "$form" = old ]; then printf '%s\\n' "$state"; else printf 'ActiveState=%s\\nJob=%s\\n' "$state" "$job"; fi
'''

# once active, the gate reads the image store (r7 phase B ruling, 2.2 item 2): a containerd store here, so these cases are
# decided by the unit's state alone (the store's own cases: test_role_image_load.py)
DOCKER = '''#!/bin/bash
case "$*" in
  'info --format {{json .DriverStatus}}') printf '[["driver-type","io.containerd.snapshotter.v1"]]\\n' ;;
  'info --format {{.Driver}}') printf 'overlayfs\\n' ;;
  *) exit 99 ;;
esac
'''

# The fake sleep: one second of the boot clock is ten here; SECONDS (the wall clock) moves the same, plus a step once when the
# case asks for one (a suspended guest's wall clock jumps when it resumes).
CLOCK = '''unset SECONDS; SECONDS=0
UPF="$CASE_DIR/uptime"
sleep() {
  [ "$1" = 1 ] || exit 98
  SECONDS=$((SECONDS+10))
  if [ -e "$CASE_DIR/wall_step" ]; then SECONDS=$((SECONDS+$(cat "$CASE_DIR/wall_step"))); rm -f "$CASE_DIR/wall_step"; fi
  if [ -e "$UPF" ]; then local u; IFS=. read -r u _ < "$UPF"; printf '%s.37 9.00\\n' "$((u+10))" > "$UPF"; fi
  printf '%s\\n' "$((SECONDS - ${SECONDS_STEP:-0}))" >> "$CASE_DIR/sleeps"
}
'''


def make_case(root, states, *, uptime=True, wall_step=None, fakes=None):
    binary = root / 'bin'; binary.mkdir()
    (root / 'states').write_text('\n'.join(states) + '\n', newline='\n'); (root / 'count').write_text('0\n'); (root / 'calls').write_text('')
    if uptime:
        (root / 'uptime').write_text('%d.37 9.00\n' % BOOT, newline='\n')
    if wall_step is not None:
        (root / 'wall_step').write_text('%d\n' % wall_step, newline='\n')
    # Executables, not shell-function replacements: the real timeout utility launches each for every probe.
    for name, text in {'systemctl': SYSTEMCTL, 'docker': DOCKER, **(fakes or {})}.items():
        (binary / name).write_text(text, encoding='utf-8', newline='\n'); (binary / name).chmod(0o755)


def run_driver(bash, root, text):
    driver = root / 'driver.sh'
    driver.write_text(text, encoding='utf-8', newline='\n')
    result = subprocess.run([bash, '--noprofile', '--norc', driver.as_posix()], capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=120, env={**os.environ, 'CASE_DIR': root.as_posix()})
    count = int((root / 'count').read_text())
    result.calls = (root / 'calls').read_text().splitlines()
    sleeps = (root / 'sleeps').read_text().splitlines() if (root / 'sleeps').exists() else []
    return result, count, sleeps


class DockerReadiness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = bash_path()

    def run_case(self, states, *, first='prep.py', fragment=None, uptime=True, wall_step=None, fakes=None):
        with tempfile.TemporaryDirectory(prefix='docker-ready-') as tmp:
            root = pathlib.Path(tmp)
            make_case(root, states, uptime=uptime, wall_step=wall_step, fakes=fakes)
            text = '''set -euo pipefail
CASE_DIR=$(cd "$CASE_DIR" && pwd); export CASE_DIR
export PATH="$CASE_DIR/bin:/usr/bin:/bin"
refuse() { printf 'REFUSED:%s\\n' "$1"; exit 3; }
''' + CLOCK + (fragment if fragment is not None else readiness(first)) + '''UPTIME=$UPF
docker_ready
printf 'READY:%s\\n' "$SECONDS"
'''
            return run_driver(self.bash, root, text)

    def assert_ready(self, result, waited, failed=0, boot=BOOT):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('READY:', result.stdout)
        # the seconds waited, the seconds the query itself failed and the boot clock at the start, in the script's own output:
        # the receipt carries the real numbers, a passing run's too
        self.assertIn('{"dockerReady":"active","waitedSeconds":%d,"queryFailedSeconds":%d,"bootSeconds":%s}'
                      % (waited, failed, 'null' if boot is None else boot), result.stdout.splitlines())

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

    def test_final_states_without_a_job_are_not_retried(self):
        for line in ('inactive|', 'failed|', 'deactivating|', 'reloading|', 'unknown|', 'no-such-state|', '|'):
            with self.subTest(line=line):
                result, count, sleeps = self.run_case([line, 'active|'])
                self.assert_refused(result, 'DOCKER_SERVICE_NOT_ACTIVE')
                self.assertEqual(count, 1); self.assertEqual(sleeps, [])

    def test_any_other_state_with_a_queued_job_is_unsettled(self):
        for state in ('inactive', 'failed', 'deactivating', 'reloading', 'unknown', ''):
            with self.subTest(state=state):
                result, count, sleeps = self.run_case([state + '|77', 'active|'])
                self.assert_ready(result, 10); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))

    # ---- a query that fails is not settled (ruling 87d330d0, 1.1)

    # the main case: a cold boot, systemd's bus not there for the first reads, then docker's start job, then active
    def test_cold_boot_bus_late_is_waited_for(self):
        result, count, sleeps = self.run_case(['BUS_DOWN'] * 3 + ['inactive|77', 'active|'])
        self.assert_ready(result, 40, failed=30); self.assertEqual(count, 5); self.assertEqual(sleeps, tens(4))

    def test_bus_never_up_is_bounded_and_says_systemctl_failed(self):
        result, count, sleeps = self.run_case(['BUS_DOWN'])
        self.assert_refused(result, 'SYSTEMCTL_FAILED')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    def test_failed_queries_and_unsettled_states_share_one_bound(self):
        result, count, sleeps = self.run_case(['BUS_DOWN'] * 9 + ['activating|77'])
        self.assert_refused(result, 'DOCKER_SERVICE_ACTIVATION_TIMEOUT')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    def test_at_the_bound_the_last_read_gives_the_code(self):
        result, count, sleeps = self.run_case(['activating|77', 'BUS_DOWN'])
        self.assert_refused(result, 'SYSTEMCTL_FAILED')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    def test_bus_back_then_a_failed_job_refuses_at_that_read(self):
        result, count, sleeps = self.run_case(['BUS_DOWN', 'failed|', 'active|'])
        self.assert_refused(result, 'DOCKER_SERVICE_NOT_ACTIVE'); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))

    def test_any_query_error_is_read_again(self):
        result, count, sleeps = self.run_case(['QUERY_ERROR', 'active|'])
        self.assert_ready(result, 10, failed=10); self.assertEqual(count, 2); self.assertEqual(sleeps, tens(1))

    def test_the_pass_line_carries_the_readings(self):
        result, _, _ = self.run_case(['BUS_DOWN'] * 3 + ['inactive|77', 'active|'])
        lines = [l for l in result.stdout.splitlines() if l.startswith('{"dockerReady"')]
        self.assertEqual(len(lines), 1, result.stdout)
        self.assertRegex(lines[0], '^' + PASS_LINE.pattern + '$')

    # ---- the clock: the boot clock, never the wall clock (bash's SECONDS)

    def test_a_wall_clock_step_does_not_end_the_wait(self):
        result, count, sleeps = self.run_case(['inactive|77'] * 3 + ['active|'], wall_step=100000)
        self.assert_ready(result, 30); self.assertEqual(count, 4)

    def test_without_a_readable_boot_clock_the_wait_is_still_bounded_and_says_null(self):
        result, count, _ = self.run_case(['inactive|77', 'active|'], uptime=False)
        self.assert_ready(result, 10, boot=None); self.assertEqual(count, 2)
        result, count, sleeps = self.run_case(['BUS_DOWN'], uptime=False)
        self.assert_refused(result, 'SYSTEMCTL_FAILED'); self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))

    # ---- the scene

    def test_a_refusal_writes_the_scene_to_stderr(self):
        for states, code in ((['inactive|'], 'DOCKER_SERVICE_NOT_ACTIVE'), (['inactive|77'], 'DOCKER_SERVICE_ACTIVATION_TIMEOUT'),
                             (['QUERY_ERROR'], 'SYSTEMCTL_FAILED'), (['BUS_DOWN'], 'SYSTEMCTL_FAILED')):
            with self.subTest(states=states):
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
                self.assertRegex(err.splitlines()[-1], r'^docker_ready: %s after \d+s$' % code)

    def test_the_scene_keeps_its_short_block_and_the_code_in_the_kept_tail(self):
        fakes = {'journalctl': long_fake('JOURNAL'), 'dmesg': long_fake('DMESG'), 'ps': long_fake('PS')}
        result, _, _ = self.run_case(['BUS_DOWN'], fakes=fakes)
        self.assert_refused(result, 'SYSTEMCTL_FAILED')
        err = result.stderr
        for part in ('JOURNAL_', 'PS_', 'DMESG_'):
            self.assertIn(part, err)   # the long parts are there, before
        tail = err[-KEEP:]
        for key in ('uptime=', 'private=', 'pid1=', 'mem=', 'psi='):
            self.assertRegex(tail, r'(?m)^' + key, key)
        self.assertEqual(err.splitlines()[-1], 'docker_ready: SYSTEMCTL_FAILED after %ds' % LIMIT)
        # the boot clock in the short block is the one the bound was kept on
        self.assertRegex(tail, r'(?m)^uptime=%d\.37 9\.00$' % (BOOT + LIMIT))
        # the long parts cut to their lines: the journal's last 40, ps' first 25, dmesg's last 15
        self.assertIn('JOURNAL_11_', err); self.assertNotIn('JOURNAL_10_', err)
        self.assertIn('PS_25_', err); self.assertNotIn('PS_26_', err)
        self.assertIn('DMESG_36_', err); self.assertNotIn('DMESG_35_', err)

    def test_a_scene_query_that_fails_changes_no_code(self):
        fakes = {'journalctl': long_fake('JOURNAL', fail=True), 'dmesg': long_fake('DMESG', fail=True), 'ps': long_fake('PS', fail=True),
                 'free': '#!/bin/bash\nexit 4\n'}
        for states, code in ((['BUS_DOWN'], 'SYSTEMCTL_FAILED'), (['inactive|'], 'DOCKER_SERVICE_NOT_ACTIVE')):
            with self.subTest(code=code):
                result, _, _ = self.run_case(states, fakes=fakes)
                self.assert_refused(result, code)
                self.assertEqual(result.stdout.splitlines()[-1], 'REFUSED:' + code)
                for name in ('journalctl', 'ps', 'dmesg'):
                    self.assertIn('(%s: exit 5)' % name, result.stderr)
                self.assertRegex(result.stderr.splitlines()[-1], r'^docker_ready: %s after \d+s$' % code)

    def test_the_bound_is_written_once(self):
        text = readiness('prep.py')
        self.assertEqual(re.findall(r'\blimit=(\d+)', text), [str(LIMIT)])
        self.assertNotIn('60 -', text)
        # observe only: nothing is started, restarted or reset
        self.assertIsNone(re.search(r'systemctl\s+(start|restart|reset-failed|enable)\b', text))
        # the boot clock is /proc/uptime, set once outside the function; bash's SECONDS never decides the bound
        self.assertEqual(re.findall(r'(?m)^UPTIME=(.*)$', text), ['/proc/uptime'])
        self.assertIn(' up=$UPTIME ', text)
        self.assertNotIn('started=$SECONDS', text)

    def test_actual_generated_reinstall_a_b_and_resume_keep_the_same_bounded_gate(self):
        for name, text in generated_reinstall_scripts().items():
            with self.subTest(script=name):
                start = text.index('docker_ready() {'); end = text.index('\n}\n', start) + 3
                actual = text[start:end]
                self.assertIn(actual, readiness('prep.py'))
                self.assertGreater(text.count('\ndocker_ready\n') + text.count('\n  docker_ready\n'), 0)
                result, count, sleeps = self.run_case(['BUS_DOWN', 'inactive|77', 'active|'], fragment=actual)
                self.assert_ready(result, 20, failed=10); self.assertEqual(count, 3); self.assertEqual(sleeps, tens(2))


def generated_reinstall_scripts():
    spec = importlib.util.spec_from_file_location('docker_test_prep_fixture', HERE / 'test_reinstall_kit.py')
    fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
    case = fixture.Prep(); case.setUp()
    try:
        argv, work, _ = case.source_v2_inputs()
        generated = fixture.run_prep(argv)
        assert generated.returncode == 0, generated.stderr
        scripts = json.loads(generated.stdout)['scripts']; assert len(scripts) == 3, scripts
        return {name: (pathlib.Path(work) / 'linux' / name).read_text(encoding='utf-8') for name in scripts}
    finally:
        case.tearDown()


def generated_first_install_scripts():
    sys.path.insert(0, str(HERE))
    try:
        import first_install_text
    finally:
        sys.path.remove(str(HERE))
    ns = first_install_text.names()
    return {'first-install A': ns['A'], 'first-install B': ns['B']}


# ---- the first systemctl of every generated script is docker_ready's (ruling 87d330d0, 1.1 item 2)
# The generated scripts run as root on a Linux host (a cleared PATH, the staged files): they are read here, not run. Each top-level
# function definition is set aside; the script's own lines are read in order, and a call of a function that reaches systemctl
# counts at the place of the call, by what that function reaches first (through the functions it calls).
FUNC = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\(\) \{\s*$')


def first_systemd_touch(text):
    funcs, top, lines, i = {}, [], text.split('\n'), 0
    while i < len(lines):
        m = FUNC.match(lines[i])
        if m:
            j = lines.index('}', i + 1)
            funcs[m.group(1)] = lines[i + 1:j]; i = j + 1
            continue
        top.append(lines[i]); i += 1
    token = re.compile(r'\b(' + '|'.join(['systemctl', 'docker_ready'] + sorted(funcs, key=len, reverse=True)) + r')\b')

    def scan(body, seen):
        for line in body:
            code = re.sub(r'(^|\s)#.*$', '', line)
            for m in token.finditer(code):
                name = m.group(1)
                if name in ('systemctl', 'docker_ready'):
                    return name
                if name in seen:
                    continue
                got = scan(funcs[name], seen | {name})
                if got:
                    return got
        return None
    return scan(top, frozenset())


class FirstSystemctlIsTheGate(unittest.TestCase):
    def test_every_generated_script_reaches_systemd_first_through_docker_ready(self):
        scripts = {**generated_reinstall_scripts(), **generated_first_install_scripts()}
        self.assertEqual(len(scripts), 5)
        for name, text in scripts.items():
            with self.subTest(script=name):
                self.assertEqual(first_systemd_touch(text), 'docker_ready')
                # production never hands docker_ready anything: every call is bare, the clock is /proc/uptime
                self.assertEqual(re.findall(r'(?m)^[ \t]*docker_ready[ \t]+\S', text), [])
                self.assertEqual(re.findall(r'(?m)^UPTIME=(.*)$', text), ['/proc/uptime'])

    def test_the_reader_sees_a_systemctl_before_the_gate(self):
        # the reader itself: a function that queries systemctl first, called before the gate, is found
        text = 'f() {\n  u=$(systemctl list-units)\n}\ng() {\n  f\n}\ndocker_ready() {\n  :\n}\n# docker_ready\ng\ndocker_ready\n'
        self.assertEqual(first_systemd_touch(text), 'systemctl')
        self.assertEqual(first_systemd_touch(text.replace('\ng\ndocker_ready\n', '\ndocker_ready\ng\n')), 'docker_ready')


# ---- linux/first-host-prep.sh: step 4 waits, read only, for systemd's manager before its first systemctl (ruling 87d330d0, 1.1 item 3)
def host_prep_step4():
    """Step 4 of the real host preparation: from its '# 4. ' line up to the '# 5. ' line."""
    lines = (RES / 'linux/first-host-prep.sh').read_text(encoding='utf-8').splitlines(keepends=True)
    start = next(i for i, l in enumerate(lines) if l.startswith('# 4. '))
    end = next(i for i, l in enumerate(lines) if l.startswith('# 5. '))
    return ''.join(lines[start:end])


class HostPrepWaitsForSystemd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bash = bash_path()

    def run_step4(self, states, *, fakes=None):
        with tempfile.TemporaryDirectory(prefix='host-prep-wait-') as tmp:
            root = pathlib.Path(tmp)
            make_case(root, states, fakes=fakes)
            (root / 'etc' / 'docker').mkdir(parents=True)
            # until the manager answers, every other systemctl fails on the bus as well (the fake's Version answer removes this)
            (root / 'bus_down_for_all').write_text('')
            text = '''set -euo pipefail
CASE_DIR=$(cd "$CASE_DIR" && pwd); export CASE_DIR
export PATH="$CASE_DIR/bin:/usr/bin:/bin"
DAEMON=$CASE_DIR/etc/docker/daemon.json; LOG=$CASE_DIR/log
refuse() { printf 'REFUSED:%s\\n' "$1"; exit 3; }
refuse_tail() { printf 'REFUSED:%s\\n' "$1"; exit 3; }
install() { :; }   # the host preparation's `install -d ... /etc/docker`: DAEMON's directory is made by the test
''' + CLOCK + 'UPTIME=$UPF\n' + host_prep_step4() + '\nprintf "STEP4_DONE\\n"\n'
            return run_driver(self.bash, root, text)

    def test_a_manager_that_answers_late_is_waited_for(self):
        result, count, sleeps = self.run_step4(['BUS_DOWN'] * 3 + ['up'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('STEP4_DONE', result.stdout)
        self.assertEqual(count, 4); self.assertEqual(sleeps, tens(3))
        # the manager first, read only; step 4's own systemctl only after it answered
        self.assertEqual(result.calls[:4], ['show --property=Version'] * 4, result.calls)
        self.assertIn('enable docker.service', result.calls[4:])

    def test_a_manager_that_never_answers_is_bounded_and_says_systemctl_failed(self):
        fakes = {'journalctl': long_fake('JOURNAL'), 'dmesg': long_fake('DMESG'), 'ps': long_fake('PS')}
        result, count, sleeps = self.run_step4(['BUS_DOWN'], fakes=fakes)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[-1], 'REFUSED:SYSTEMCTL_FAILED')
        self.assertEqual(count, LIMIT // 10); self.assertEqual(sleeps, tens(LIMIT // 10))
        tail = result.stderr[-KEEP:]
        for key in ('uptime=', 'private=', 'pid1=', 'mem=', 'psi='):
            self.assertRegex(tail, r'(?m)^' + key, key)
        self.assertIn(BUS, result.stderr)   # the last query's own message
        self.assertEqual(result.stderr.splitlines()[-1], 'systemd_wait: SYSTEMCTL_FAILED after %ds' % LIMIT)

    def test_the_wait_reads_only(self):
        step4 = host_prep_step4()
        wait = step4[:step4.index('want_daemon=')]
        self.assertIn('systemctl show --property=Version', wait)
        self.assertIsNone(re.search(r'systemctl\s+(start|restart|reset-failed|enable)\b', wait))
        self.assertEqual(re.findall(r'\b\w*limit=(\d+)', wait), [str(LIMIT)])
        # the boot clock is fixed in the script (UPTIME=/proc/uptime at its top), outside the step a test cuts out
        text = (RES / 'linux/first-host-prep.sh').read_text(encoding='utf-8')
        self.assertEqual(re.findall(r'(?m)^UPTIME=(.*)$', text), ['/proc/uptime'])
        self.assertNotIn('UPTIME=', step4)


if __name__ == '__main__':
    unittest.main()
