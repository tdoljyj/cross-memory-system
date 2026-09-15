"""Fixed Docker tool port; authority belongs to the accepted trusted supervisor.

No GA issuer, SQL credential, network API or arbitrary command interface.
Only the safety watchdog has a CLI. Normal effects require the host supervisor.
"""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
QUALIFICATION = BASE.parent


def load(name, relative, expected):
    path = QUALIFICATION / relative
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('Frozen dependency drift: ' + relative)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


parent = load('accepted_fixed_parent', str(BASE / 'parent600.py'),
              '1b5ae3f95abf24ecf5219b596eca1bc7f99af1279a9d621ea058caefd9be7e52')
observation = load('accepted_observation', 'docker-engineering-observation/observe.py',
                   'cc3498e6dc5eed1f13fb0b84c4dd4df75f5ee76fb5d24d4167852cb92588ef5a')
MAX_OUTPUT = 128 * 1024
STOP_RESERVE_SECONDS = 30  # 6 inspect + 7 stop + 5 wait + 6 inspect + 6 scheduling/I/O.
START_MAX_SECONDS = 6
MAX_GA_SECONDS = 600  # Proposed explicit Profile successor; not implicitly active.
PYTHON = Path('/usr/bin/python3.11')
PYTHON_SHA = 'f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e'


def identity(value):
    if type(value) is not str or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('Exact container identity required')
    return value


def source_sha():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def prepare(nonce, ga_raw, temporal=None):
    """Prepare only exact synthetic inputs. This does not accept/authorize a GA."""
    # R17-F1: this is the Linux successor. The platform test and the binary identity both move
    # to the already-ported parent600, leaving observe.py -- shared with the predecessors that
    # pin its bytes -- untouched.
    # Two gates, two messages (R20-N2). Sharing one meant neither could be proven live on its
    # own: mutating the platform check and mutating the docker pin raised the same string, so a
    # self-test could not tell which had fired -- or whether both were dead and a third thing
    # raised it.
    if sys.platform != 'linux':
        raise ValueError('Exact Linux host required')
    if observation.digest(Path(parent.DOCKER)) != parent.DOCKER_SHA:
        raise ValueError('Exact Docker binary bytes required')
    if type(ga_raw) is not str or len(ga_raw.encode()) > 65536:
        raise ValueError('Bounded exact GA bytes required')
    ga = json.loads(ga_raw)
    effective_start, effective_deadline, _ = parent.effective_window(ga_raw, temporal)
    now = datetime.now(timezone.utc)
    remaining = (effective_deadline - now).total_seconds()
    started = time.monotonic()
    if not effective_start <= now or not 0 < remaining <= MAX_GA_SECONDS:
        raise ValueError('Current bounded deadline required')
    folder, driver, allowed = parent.paths(nonce)
    folder.mkdir(parents=True, exist_ok=False)
    for item in (driver, allowed, folder / 'docker-config', folder / 'temp'):
        item.mkdir()
    # Fixed existing installed inputs; every byte validated before copying.
    # Resolved from this file's own location, not from a hardcoded absolute path (R19-F3). The
    # absolute form pointed at whatever checkout happened to live at that path, which on a live
    # run is the right one but in any sandbox is a THIRD tree: round 19 altered the SKILL.md of
    # the tree under test and the self-test still reported the Skill bytes fine, because it had
    # read a different checkout's copy. Resolving relatively makes the check follow the tree it
    # is checking, which is also what lets the self-test prove it live by mutation.
    source = Path(__file__).resolve().parents[3] / 'skills' / 'clued'
    blobs = {name: (source / name).read_bytes() for name in parent.child.SUBJECT}
    if not parent.child.subject_bytes_valid(blobs):
        raise ValueError('Exact accepted Skill input bytes changed')
    for name, data in blobs.items():
        dest = driver / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open('xb') as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
    primitive = parent.CHILD_PATH
    if observation.digest(primitive) != parent.CHILD_SHA:
        raise ValueError('Fixed child drift')
    with (driver / 'fixed_skill_fixture.py').open('xb') as output:
        output.write(primitive.read_bytes()); output.flush(); os.fsync(output.fileno())
    with (folder / 'ga.raw').open('xb') as output:
        output.write(ga_raw.encode()); output.flush(); os.fsync(output.fileno())
    temporal_raw = None if temporal is None else json.dumps(temporal, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n'
    record = {'nonce': nonce, 'ga_sha256': hashlib.sha256(ga_raw.encode()).hexdigest(),
              'host_source_sha256': source_sha(), 'started_monotonic': started,
              'deadline_monotonic': started + remaining, 'deadline_utc': effective_deadline.isoformat().replace('+00:00', 'Z'),
              'temporal_sha256': None if temporal_raw is None else hashlib.sha256(temporal_raw.encode('utf-8')).hexdigest(),
              'temporal_continuation': temporal,
              'authority_effect': 'NONE'}
    observation.persist(folder, 'host-intent.json', record)
    return record


class FixedHost:
    def __init__(self, nonce, expected_ga_sha256, prefix='main'):
        if prefix not in ('main', 'watchdog'):
            raise ValueError('Fixed evidence prefix required')
        self.folder, _, _ = parent.paths(nonce)
        self.record = observation.load_record(self.folder / 'host-intent.json')
        if (self.record.get('nonce') != nonce or self.record.get('ga_sha256') != expected_ga_sha256
                or observation.digest(self.folder / 'ga.raw') != expected_ga_sha256
                or self.record.get('host_source_sha256') != source_sha()):
            raise ValueError('Exact prepared host input mismatch')
        self.nonce, self.prefix = nonce, prefix
        ga = json.loads((self.folder / 'ga.raw').read_text(encoding='utf-8'))
        self.temporal = None
        temporal_sha = self.record.get('temporal_sha256')
        if temporal_sha is not None:
            self.temporal = self.record.get('temporal_continuation')
            temporal_raw = json.dumps(self.temporal, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n'
            if hashlib.sha256(temporal_raw.encode('utf-8')).hexdigest() != temporal_sha:
                raise ValueError('Exact temporal host bytes changed')
        elif self.record.get('temporal_continuation') is not None:
            raise ValueError('Unbound temporal host material')
        _, effective_deadline, _ = parent.effective_window((self.folder / 'ga.raw').read_text(encoding='utf-8'), self.temporal)
        if parent.timestamp(self.record.get('deadline_utc')) != effective_deadline:
            raise ValueError('Intent deadline differs from exact original authority pair')
        self.deadline = self.record['deadline_monotonic']
        if type(self.deadline) not in (int, float) or not math.isfinite(self.deadline):
            raise ValueError('Actual host deadline required')
        self.container = None

    def _invoke(self, tag, operation, timeout=6, guard=None):
        if operation not in ('create', 'start', 'inspect', 'stop', 'wait'):
            raise ValueError('Fixed operation required')
        # Same split as prepare()'s, for the same reason (R20-N2): one message over two gates
        # means neither can be shown to have fired on its own.
        if sys.platform != 'linux':
            raise ValueError('Exact Linux host required at invoke')
        if observation.digest(Path(parent.DOCKER)) != parent.DOCKER_SHA:
            raise ValueError('Exact Docker executable bytes required at invoke')
        argv = parent.fixed_argv(self.nonce, operation, None if operation == 'create' else identity(self.container))
        started = time.monotonic()
        utc_remaining = (parent.timestamp(self.record['deadline_utc']) - datetime.now(timezone.utc)).total_seconds()
        expires = min(self.deadline, started + timeout, started + utc_remaining)
        if operation == 'start':
            expires = min(expires, started + START_MAX_SECONDS, self.deadline - STOP_RESERVE_SECONDS,
                          started + utc_remaining - STOP_RESERVE_SECONDS)
        name = self.prefix + '-' + tag
        observation.persist(self.folder, name + '-request.json', {'argv': argv, 'ga_sha256': self.record['ga_sha256'],
            'started_monotonic': started, 'expires_monotonic': expires, 'authority_effect': 'NONE'})
        out, err = self.folder / (name + '.stdout'), self.folder / (name + '.stderr')
        process = None
        try:
            with out.open('xb') as stdout, err.open('xb') as stderr:
                if time.monotonic() >= expires:
                    raise observation.Unknown('Deadline reached before dispatch')
                if operation == 'start':
                    if min(self.deadline - time.monotonic(), utc_remaining) <= STOP_RESERVE_SECONDS + START_MAX_SECONDS:
                        raise observation.Unknown('Safety STOP window reached; START forbidden')
                    ready = observation.load_record(self.folder / 'watchdog-ready.json')
                    if (guard is None or ready.get('container_id') != self.container
                            or not observation.guard_ready(ready, guard, self.nonce, self.deadline)):
                        raise observation.Unknown('Watchdog lost before dispatch')
                    if (time.monotonic() >= expires or self.deadline - time.monotonic() <= STOP_RESERVE_SECONDS + START_MAX_SECONDS
                            or (parent.timestamp(self.record['deadline_utc']) - datetime.now(timezone.utc)).total_seconds() <= STOP_RESERVE_SECONDS + START_MAX_SECONDS):
                        raise observation.Unknown('Deadline reached after guard check')
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                    env=observation.environment(self.folder), cwd=str(self.folder), shell=False,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                while process.poll() is None:
                    if time.monotonic() >= expires or max(out.stat().st_size, err.stat().st_size) > MAX_OUTPUT:
                        process.kill(); process.wait(timeout=1)
                        raise observation.Unknown('Outcome unknown; never resend')
                    time.sleep(0.02)
                stdout.flush(); stderr.flush(); os.fsync(stdout.fileno()); os.fsync(stderr.fileno())
            if max(out.stat().st_size, err.stat().st_size) > MAX_OUTPUT:
                raise observation.Unknown('Output cap reached')
            observation.persist(self.folder, name + '-response.json', {'exit_code': process.returncode,
                'stdout_sha256': observation.digest(out), 'stderr_sha256': observation.digest(err)})
            if process.returncode != 0:
                raise observation.Unknown('CLI failure; no automatic retry')
            return out.read_text(encoding='utf-8').strip()
        finally:
            if process is not None and process.poll() is None:
                process.kill()

    def inspect(self, exact_id, tag):
        self.container = identity(exact_id)
        values = json.loads(self._invoke(tag, 'inspect'))
        if type(values) is not list or len(values) != 1 or values[0].get('Id') != self.container:
            raise observation.Unknown('Exact inspection identity missing')
        value = values[0]
        if value.get('Image') != parent.v.IMAGE_DIGEST or value.get('Name') != '/clued-synthetic-' + self.nonce:
            raise observation.Unknown('Owned synthetic subject mismatch')
        return value

    def create_fixed(self):
        self.container = identity(self._invoke('create', 'create'))
        value = self.inspect(self.container, 'created-inspect')
        if not parent.prestart(value, self.nonce, self.container):
            raise observation.Unknown('Exact created configuration rejected')
        observation.persist(self.folder, 'created-container.json', {'container_id': self.container})
        return self.container

    def start_exact(self, exact_id, guard):
        if self.deadline - time.monotonic() <= STOP_RESERVE_SECONDS + START_MAX_SECONDS:
            raise observation.Unknown('Safety STOP window reached; START forbidden')
        value = self.inspect(exact_id, 'before-start')
        if not parent.prestart(value, self.nonce, exact_id):
            raise observation.Unknown('Prestart configuration drift')
        ready = observation.load_record(self.folder / 'watchdog-ready.json')
        if ready.get('container_id') != exact_id or not observation.guard_ready(ready, guard, self.nonce, self.deadline):
            raise observation.Unknown('Live exact watchdog required')
        return self._invoke('start', 'start', guard=guard)

    def arm_watchdog(self, exact_id):
        identity(exact_id)
        if observation.digest(PYTHON) != PYTHON_SHA:
            raise observation.Unknown('Fixed watchdog interpreter drift')
        created = observation.load_record(self.folder / 'created-container.json')
        if created.get('container_id') != exact_id:
            raise observation.Unknown('Watchdog must bind observed created container')
        argv = [str(PYTHON), '-I', '-S', '-B', '-X', 'utf8', str(Path(__file__).resolve()),
                '--watch', self.nonce, self.record['ga_sha256'], exact_id]
        observation.persist(self.folder, 'watchdog-launch.json', {'argv': argv,
            'python_sha256': observation.digest(PYTHON), 'host_source_sha256': source_sha()})
        if time.monotonic() >= self.deadline:
            raise observation.Unknown('Watchdog deadline expired')
        guard = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=observation.environment(self.folder), cwd=str(self.folder),
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        until = min(self.deadline, time.monotonic() + 5)
        while time.monotonic() < until and guard.poll() is None:
            try:
                ready = observation.load_record(self.folder / 'watchdog-ready.json')
                if (ready.get('container_id') == exact_id
                        and observation.guard_ready(ready, guard, self.nonce, self.deadline)):
                    return guard
            except (OSError, ValueError):
                pass
            time.sleep(0.02)
        raise observation.Unknown('Watchdog readiness not proven; do not start')

    def stop_exact(self, exact_id):
        self.inspect(exact_id, 'before-stop')
        self._invoke('stop', 'stop', 7)
        code = self._invoke('wait', 'wait', 5)
        value = self.inspect(exact_id, 'after-stop')
        if not code.isdigit() or not parent.v.model.stopped(value, exact_id) or value['State'].get('ExitCode') != int(code):
            raise observation.Unknown('Exact STOP not observed')
        observation.persist(self.folder, self.prefix + '-stopped.json', {'container_id': exact_id, 'inspection': value,
            'capacity_release_authorized': False})
        return value


def watchdog(nonce, ga_sha, exact_id):
    session = FixedHost(nonce, ga_sha, 'watchdog')
    identity(exact_id)
    observation.persist(session.folder, 'watchdog-ready.json', {'pid': os.getpid(), 'nonce': nonce,
        'deadline_monotonic': session.deadline, 'container_id': exact_id})
    while time.monotonic() < session.deadline - STOP_RESERVE_SECONDS:
        try:
            stop = observation.load_record(session.folder / 'main-stopped.json')
            if stop.get('container_id') == exact_id and parent.v.model.stopped(stop.get('inspection'), exact_id):
                return 0
        except (OSError, ValueError, TypeError):
            pass
        time.sleep(0.1)
    try:
        session.stop_exact(exact_id)
        return 0
    except Exception as error:
        observation.persist(session.folder, 'watchdog-unknown.json', {'reason': type(error).__name__,
            'container_id': exact_id, 'capacity_release_authorized': False})
        return 2


if __name__ == '__main__':
    if len(sys.argv) != 5 or sys.argv[1] != '--watch':
        raise SystemExit('Only fixed safety watchdog CLI; normal effects use trusted supervisor')
    raise SystemExit(watchdog(*sys.argv[2:]))
