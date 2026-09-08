"""One fixed synthetic engineering observation; formal/Skill/PQUAL execution denied.

Only the coordinator may invoke observe AFTER independent exact-plan review.
The code has no local acceptance/GA issuer or caller-supplied authorization bypass.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

BASE = Path(__file__).resolve().parent
PROBE = BASE.parent / 'docker-isolation' / 'probe.py'
PROBE_SHA = '2168145b42166b4de1ea470b4fd232549d661542761ffe279955d0ace5580523'
DOCKER = Path('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
DOCKER_SHA = '00ffff945b67c65aae98dd980621a80ee135ed4e0931b33ca03687caee019713'
ENDPOINT = 'npipe:////./pipe/dockerDesktopLinuxEngine'
MAX_SECONDS, STOP_AT_SECONDS = 90, 65
MAX_EVIDENCE, MAX_OUTPUT = 128 * 1024 * 1024, 128 * 1024
BOUNDARY = {'qualified': False, 'formal_ga_used': False, 'skill_loaded': False,
            'pqual_executed': False, 'model_actions': 0, 'paid_actions': 0}
spec = importlib.util.spec_from_file_location('observation_validation', BASE / 'validation.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class Unknown(RuntimeError):
    pass


def utc():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_bindings():
    return {name: digest(BASE / name) for name in ('observe.py', 'validation.py')}


def environment(folder):
    # No copy/update of os.environ: explicit public Windows infrastructure only.
    return {'SystemRoot': 'C:\\Windows', 'WINDIR': 'C:\\Windows',
            'TEMP': str(folder / 'temp'), 'TMP': str(folder / 'temp')}


def evidence_size(folder):
    total = 0
    for parent, directories, files in os.walk(folder, followlinks=False):
        for name in directories + files:
            p = Path(parent) / name
            v.model.unlinked(p)
        for name in files:
            total += (Path(parent) / name).stat().st_size
    return total


def persist(folder, name, value):
    if '/' in name or '\\' in name or name in {'.', '..'}:
        raise Unknown('Invalid fixed evidence name')
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
    if len(data) > MAX_OUTPUT or evidence_size(folder) + len(data) > MAX_EVIDENCE:
        raise Unknown('Evidence cap reached')
    path = v.model.unlinked(folder / name)
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if path.read_bytes() != data:
        raise Unknown('Evidence read-back mismatch')


def load_record(path):
    path = v.model.unlinked(path)
    if path.stat().st_size > MAX_OUTPUT:
        raise Unknown('Record too large')
    return json.loads(path.read_text(encoding='utf-8'))


def guard_ready(value, process, nonce, deadline):
    return (type(value) is dict and type(value.get('pid')) is int
            and value['pid'] == process.pid and value.get('nonce') == nonce
            and type(value.get('deadline_monotonic')) in (int, float)
            and value['deadline_monotonic'] == deadline and process.poll() is None)


def create_args(nonce, folder):
    config = {'image': v.IMAGE, 'run_key': nonce}
    args = v.model.create_argv(config)[1:]
    planned_driver, planned_allowed = v.model.paths(config)
    args = [item.replace(planned_driver, (folder / 'probe.py').as_posix())
            .replace(planned_allowed, (folder / 'allowed').as_posix()) for item in args]
    args.insert(2, '--label=clued.observation=' + nonce)
    return args


class Session:
    def __init__(self, folder, intent, prefix='main'):
        self.folder, self.intent, self.prefix = folder, intent, prefix
        self.nonce = intent['nonce']
        v.model.config({'image': v.IMAGE, 'run_key': self.nonce})
        if (intent.get('image') != v.IMAGE or intent.get('probe_sha256') != PROBE_SHA
                or intent.get('source_bindings') != source_bindings()
                or type(intent.get('started_monotonic')) not in (int, float)
                or type(intent.get('deadline_monotonic')) not in (int, float)
                or intent['deadline_monotonic'] - intent['started_monotonic'] != MAX_SECONDS):
            raise Unknown('Intent identity/deadline/source changed')
        self.deadline = intent['deadline_monotonic']
        self.identity = None

    def command(self, kind):
        commands = {
            'host': ['version', '--format', '{{json .Server}}'],
            'store': ['info', '--format', '{{json .DriverStatus}}'],
            'image': ['image', 'inspect', v.IMAGE],
            'create': create_args(self.nonce, self.folder),
            'discover': ['container', 'inspect', 'clued-synthetic-' + self.nonce],
        }
        if kind in commands:
            return commands[kind]
        identity = v.model.container_id(self.identity)
        return v.model.fixed_argv(kind, identity)[1:]

    def invoke(self, tag, kind, limit=6):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Unknown('Absolute 90-second deadline exhausted')
        argv = [str(DOCKER), '--host=' + ENDPOINT, '--config=' + str(self.folder / 'docker-config')]
        argv += self.command(kind)
        tag = self.prefix + '-' + tag
        started = time.monotonic()
        persist(self.folder, tag + '-request.json', {'argv': argv, 'kind': kind,
                'utc': utc(), 'monotonic': started, 'timeout_seconds': min(limit, remaining), **BOUNDARY})
        out, err = self.folder / (tag + '.stdout'), self.folder / (tag + '.stderr')
        process = None
        try:
            with out.open('xb') as stdout, err.open('xb') as stderr:
                # Persistence and file opens consume the same absolute budget.
                # Never launch a mutation after those operations cross its deadline.
                if time.monotonic() >= min(self.deadline, started + limit):
                    raise Unknown('Deadline exhausted before CLI launch')
                process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                        env=environment(self.folder), cwd=str(self.folder), shell=False,
                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                expires = min(self.deadline, started + limit)
                while process.poll() is None:
                    if time.monotonic() >= expires or max(out.stat().st_size, err.stat().st_size) > MAX_OUTPUT:
                        process.kill()
                        process.wait(timeout=1)
                        raise Unknown('CLI timeout/output cap; container outcome unknown')
                    time.sleep(0.02)
                stdout.flush(); stderr.flush()
                os.fsync(stdout.fileno()); os.fsync(stderr.fileno())
            if max(out.stat().st_size, err.stat().st_size) > MAX_OUTPUT:
                raise Unknown('CLI output cap exceeded')
            persist(self.folder, tag + '-response.json', {'exit_code': process.returncode,
                    'utc': utc(), 'monotonic': time.monotonic(),
                    'stdout_sha256': digest(out), 'stderr_sha256': digest(err)})
            if process.returncode != 0:
                raise Unknown('Docker returned a failure; no retry')
            return out.read_text(encoding='utf-8').strip()
        finally:
            if process is not None and process.poll() is None:
                process.kill()

    def inspect(self, tag, discover=False):
        values = json.loads(self.invoke(tag, 'discover' if discover else 'inspect'))
        if type(values) is not list or len(values) != 1:
            raise Unknown('Inspect must return exactly one object')
        observed = values[0]
        identity = v.model.container_id(observed.get('Id'))
        if not v.own_container(observed, identity, self.nonce):
            raise Unknown('Container name/image/nonce/ID ownership mismatch')
        if self.identity is not None and self.identity != identity:
            raise Unknown('Exact container identity changed')
        self.identity = identity
        return observed

    def stop(self):
        # Name lookup only recovers the full ID of this exact immutable-Intent
        # nonce/image. All mutations thereafter use the verified full ID.
        if self.identity is None:
            self.inspect('recover-id', discover=True)
        else:
            self.inspect('before-stop')
        persist(self.folder, self.prefix + '-stop-intent.json', {'container_id': self.identity,
                'nonce': self.nonce, 'utc': utc(), 'monotonic': time.monotonic()})
        self.invoke('stop', 'stop', limit=7)
        wait = self.invoke('wait', 'wait', limit=5)
        if not wait.isdigit() or not 0 <= int(wait) <= 255:
            raise Unknown('Invalid Docker wait result')
        final = self.inspect('after-stop')
        if (not v.model.stopped(final, self.identity)
                or type(final['State'].get('ExitCode')) is not int
                or final['State']['ExitCode'] != int(wait)):
            raise Unknown('STOP not independently observed')
        persist(self.folder, self.prefix + '-stopped.json', {'container_id': self.identity,
                'wait_exit_code': int(wait), 'inspection': final, 'utc': utc(),
                'monotonic': time.monotonic(), 'capacity_release_authorized': False})
        return True


def watchdog():
    folder = v.model.unlinked(BASE / 'work' / 'observation')
    intent = load_record(folder / 'intent.json')
    session = Session(folder, intent, 'watchdog')
    persist(folder, 'watchdog-ready.json', {'pid': os.getpid(), 'utc': utc(),
            'deadline_monotonic': session.deadline, 'nonce': session.nonce})
    while time.monotonic() < intent['started_monotonic'] + STOP_AT_SECONDS:
        # Only a complete matching STOP observation ends the guard early, never
        # result.json's success string or absence of the parent process.
        try:
            stop = load_record(folder / 'main-stopped.json')
            if (stop.get('container_id') and v.own_container(stop.get('inspection'), stop['container_id'], session.nonce)
                    and v.model.stopped(stop.get('inspection'), stop['container_id'])):
                persist(folder, 'watchdog-finished.json', {'status': 'MAIN_STOP_OBSERVATION_PRESENT',
                        'nonce': session.nonce, 'utc': utc()})
                return 0
        except (OSError, ValueError, Unknown):
            pass
        time.sleep(0.1)
    try:
        session.stop()
        persist(folder, 'watchdog-finished.json', {'status': 'GUARD_STOP_OBSERVED',
                'nonce': session.nonce, 'utc': utc(), 'parent_result_remains_unknown': True})
        return 0
    except Exception as exc:
        try:
            persist(folder, 'watchdog-failed.json', {'status': 'UNKNOWN', 'reason': type(exc).__name__,
                    'container_id': session.identity, 'capacity_release_authorized': False, 'utc': utc()})
        except Exception:
            pass
        return 2


def observe():
    if sys.platform != 'win32' or digest(DOCKER) != DOCKER_SHA or digest(PROBE) != PROBE_SHA:
        raise Unknown('Exact Windows CLI and frozen probe required')
    root = v.model.unlinked(BASE / 'work')
    root.mkdir(exist_ok=True)
    folder = v.model.unlinked(root / 'observation')
    try:
        folder.mkdir()
    except FileExistsError:
        return {'status': 'UNKNOWN', 'reason': 'Existing one-shot reservation; no redispatch', **BOUNDARY}
    started = time.monotonic()
    nonce = uuid.uuid4().hex
    for name in ('allowed', 'docker-config', 'temp'):
        (folder / name).mkdir()
    with (folder / 'probe.py').open('xb') as stream:
        stream.write(PROBE.read_bytes()); stream.flush(); os.fsync(stream.fileno())
    if digest(folder / 'probe.py') != PROBE_SHA:
        raise Unknown('Staged probe changed')
    intent = {'scope': 'FIXED_PRE_GA_SYNTHETIC_OS_STOP_ENGINEERING_OBSERVATION',
              'nonce': nonce, 'image': v.IMAGE, 'probe_sha256': PROBE_SHA,
              'source_bindings': source_bindings(), 'docker_cli_sha256': DOCKER_SHA,
              'python_host_sha256': digest(sys.executable), 'endpoint': ENDPOINT,
              'started_utc': utc(), 'started_monotonic': started,
              'deadline_monotonic': started + MAX_SECONDS,
              'prior_controlled_seconds_upper_bound_reserved': 1320,
              'this_reservation_seconds': 90, 'cumulative_upper_bound_seconds': 1410,
              'new_evidence_limit_bytes': MAX_EVIDENCE,
              'remote_formal_sink_satisfied': False, **BOUNDARY}
    persist(folder, 'intent.json', intent)
    session = Session(folder, load_record(folder / 'intent.json'))
    guard = None
    dispatched = False
    failed = None
    probe = None
    stopped = False
    old_canary = os.environ.get('CLUED_SYNTHETIC_CREDENTIAL_CANARY')
    os.environ['CLUED_SYNTHETIC_CREDENTIAL_CANARY'] = 'synthetic-parent-only-' + nonce
    try:
        persist(folder, 'host-canary.json', {'present_in_parent': True,
                'forwarded_to_docker_or_watchdog': False, 'public_environment': v.PUBLIC_ENV})
        host = json.loads(session.invoke('host', 'host'))
        store = json.loads(session.invoke('store', 'store'))
        images = json.loads(session.invoke('image', 'image'))
        if not v.host_valid(host) or store != [['driver-type', 'io.containerd.snapshotter.v1']]:
            raise Unknown('Host binding changed')
        if type(images) is not list or len(images) != 1 or not v.image_valid(images[0]):
            raise Unknown('Image binding changed')
        guard = subprocess.Popen([sys.executable, '-I', '-S', '-B', str(BASE / 'observe.py'), 'watchdog'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env=environment(folder), cwd=str(folder), shell=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        ready_deadline = min(started + 30, time.monotonic() + 3)
        ready = None
        while time.monotonic() < ready_deadline and guard.poll() is None:
            try:
                ready = load_record(folder / 'watchdog-ready.json')
                if guard_ready(ready, guard, nonce, session.deadline):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.02)
        if not guard_ready(ready, guard, nonce, session.deadline):
            raise Unknown('Independent fixed watchdog not ready')
        if time.monotonic() >= started + 35:
            raise Unknown('Startup budget exhausted before create')
        dispatched = True
        identity = session.invoke('create', 'create')
        session.identity = v.model.container_id(identity)
        persist(folder, 'container-id.json', {'container_id': identity, 'nonce': nonce, 'utc': utc()})
        before = session.inspect('before-start')
        if not v.prestart(before, identity, nonce, folder / 'probe.py', folder / 'allowed'):
            raise Unknown('Created container drift; do not start')
        if (digest(folder / 'probe.py') != PROBE_SHA or time.monotonic() >= started + 45
                or not guard_ready(ready, guard, nonce, session.deadline)):
            raise Unknown('Probe/start budget changed')
        session.invoke('start', 'start')
        while time.monotonic() < started + 55:
            if guard.poll() is not None:
                raise Unknown('Watchdog exited during observation')
            try:
                probe = load_record(folder / 'allowed' / 'probe-observation.json')
                break
            except (OSError, ValueError):
                time.sleep(0.05)
        if not v.probe_valid(probe):
            raise Unknown('Missing/failed actual fixed probe observation')
        running = session.inspect('running')
        if (type(running.get('State')) is not dict or running['State'].get('Running') is not True
                or type(running['State'].get('Pid')) is not int or running['State']['Pid'] <= 0):
            raise Unknown('No live container observation')
    except Exception as exc:
        failed = type(exc).__name__ + ': ' + str(exc)
    finally:
        if old_canary is None:
            os.environ.pop('CLUED_SYNTHETIC_CREDENTIAL_CANARY', None)
        else:
            os.environ['CLUED_SYNTHETIC_CREDENTIAL_CANARY'] = old_canary
        if dispatched:
            try:
                stopped = session.stop()
            except Exception as exc:
                failed = failed or (type(exc).__name__ + ': STOP outcome unknown')
        if guard is not None and not dispatched:
            guard.terminate()
            guard.wait(timeout=2)
        elif guard is not None and stopped:
            try:
                guard.wait(timeout=min(2, max(0.01, session.deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                failed = failed or 'Watchdog exit not observed; reservation retained'
    result = {'status': 'ENGINEERING_OBSERVATIONS_RECORDED' if stopped and not failed else 'UNKNOWN',
              'container_id': session.identity, 'probe_observation_valid': v.probe_valid(probe),
              'stop_observed': stopped, 'failure': failed, 'elapsed_seconds': time.monotonic() - started,
              'capacity_release_authorized': False, 'container_retained_for_review': dispatched,
              'evidence_retained': True, 'utc': utc(), **BOUNDARY}
    try:
        persist(folder, 'result.json', result)
    except Exception:
        result['status'] = 'UNKNOWN'
        result['failure'] = 'Result persistence failed; reservation retained'
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['observe', 'watchdog', 'formal'])
    args = parser.parse_args(argv)
    try:
        if args.operation == 'formal':
            raise Unknown('Formal/Skill/PQUAL/GA execution is not implemented or authorized by this harness')
        if args.operation == 'watchdog':
            return watchdog()
        result = observe()
    except Exception as exc:
        result = {'status': 'UNKNOWN', 'reason': type(exc).__name__, 'capacity_release_authorized': False, **BOUNDARY}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get('status') == 'ENGINEERING_OBSERVATIONS_RECORDED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
