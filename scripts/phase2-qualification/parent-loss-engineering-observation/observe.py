"""One fixed parent-exit engineering observation, never GA/Skill/PQUAL execution."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent
NONCE = 'bce1e6dc03104d59b068854a8c12d540'
SECONDS = 90
SOURCES = {
    'preentry-parent/runtime-successor/host-binding/fixed_host.py': '430445f80986ba99a6f9b149a5a73cffe88182b26b0574b9f83fcdcbf64e69b2',
    'preentry-parent/parent.py': 'a4bff96f76d6ed5598833cbd6f73efec547eaaf9cd039f47f8eef6e925efe79e',
    'docker-engineering-observation/observe.py': 'cc3498e6dc5eed1f13fb0b84c4dd4df75f5ee76fb5d24d4167852cb92588ef5a',
    'docker-engineering-observation/validation.py': '3ac10b11456ddc2de9155fb2b9f8f8c8c20ac0da51957e587d3081339767ac2e',
    'linux-docker-driver/candidate.py': '7eed6b480010c5aebba39e109356a9a499f8ecc96ced184d3ee926fa52346457',
    'qualification-runtime/remote_evidence.py': 'a7373982ee405890fc7f260b96987d69d8133a0f5c318fc6e85c44d7fbb28969',
    'qualification-runtime/fixed_skill_fixture.py': '98c4d0165144a4ebfbd4889a98da65a8c6d3a71fbf082af393c15b9d00a3c18a',
    'control-root-registration/verify.py': '040ef7b7a8536d6b210ada9a15a26af6749e58c5da10cd401b98c36155373093',
    'docker-isolation/probe.py': '2168145b42166b4de1ea470b4fd232549d661542761ffe279955d0ace5580523',
}
BOUNDARY = {'authority_effect': 'NONE', 'qualified': False, 'formal_ga_used': False,
            'skill_loaded': False, 'pqual_executed': False, 'capacity_release_authorized': False,
            'model_actions': 0, 'paid_actions': 0}


def runtime():
    for relative, digest in SOURCES.items():
        if hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() != digest:
            raise ValueError('Exact dependency changed: ' + relative)
    path = ROOT / next(iter(SOURCES))
    spec = importlib.util.spec_from_file_location('reviewed_fixed_host', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def request(started, now):
    if now < datetime(2026, 9, 8, 9, 28, 59, tzinfo=timezone.utc) or now + timedelta(seconds=SECONDS) > datetime(2026, 9, 9, 9, 28, 59, tzinfo=timezone.utc):
        raise ValueError('Engineering observation outside actual Owner window')
    return {'object_type': 'EngineeringObservationRequest', 'operation': 'FIXED_PARENT_EXIT_AND_GUARD_STOP',
            'nonce': NONCE, 'deadline': (now + timedelta(seconds=SECONDS)).isoformat(),
            'started_monotonic': started, 'deadline_monotonic': started + SECONDS,
            'prior_reserved_seconds_upper_bound': 1410, 'reservation_seconds': SECONDS,
            'cumulative_reserved_seconds_upper_bound': 1500,
            'new_evidence_limit_bytes': 134217728, 'sources': SOURCES, **BOUNDARY}


def exact_request(h):
    folder, _, _ = h.parent.paths(NONCE)
    raw = (folder / 'ga.raw').read_bytes()
    value = json.loads(raw)
    if (value.get('object_type') != 'EngineeringObservationRequest'
            or value.get('operation') != 'FIXED_PARENT_EXIT_AND_GUARD_STOP'
            or value.get('nonce') != NONCE or value.get('sources') != SOURCES
            or any(value.get(k) != v for k, v in BOUNDARY.items())
            or value.get('deadline_monotonic') - value.get('started_monotonic') != SECONDS):
        raise ValueError('Exact engineering request required')
    return folder, value, hashlib.sha256(raw).hexdigest()


def parent_process(h):
    o = h.observation
    folder, req, digest = exact_request(h)
    launch = o.load_record(folder / 'parent-launch-intent.json')
    if launch.get('harness_sha256') != o.digest(Path(__file__)) or launch.get('request_sha256') != digest:
        raise ValueError('Prepared parent source/request changed')
    o.persist(folder, 'parent-dispatch-once.json', {'pid': os.getpid(), 'request_sha256': digest, **BOUNDARY})
    intent = o.load_record(folder / 'probe-intent.json')
    session = o.Session(folder, intent, 'probe-parent')
    port = h.FixedHost(NONCE, digest)
    host = json.loads(session.invoke('host', 'host'))
    images = json.loads(session.invoke('image', 'image'))
    if (not o.v.host_valid(host) or type(images) is not list or len(images) != 1
            or not o.v.image_valid(images[0])):
        raise ValueError('Host/image binding changed')
    session.identity = h.identity(session.invoke('create', 'create'))
    o.persist(folder, 'created-container.json', {'container_id': session.identity})
    before = session.inspect('before-start')
    if not o.v.prestart(before, session.identity, NONCE, folder / 'probe.py', folder / 'allowed'):
        raise ValueError('Fixed probe configuration rejected')
    port.container = session.identity
    guard = port.arm_watchdog(session.identity)
    # The exact old probe was inspected above. This fixed START invokes no Skill.
    port._invoke('start', 'start', guard=guard)
    until = min(req['deadline_monotonic'] - 36, time.monotonic() + 8)
    probe = None
    while time.monotonic() < until and guard.poll() is None:
        try:
            probe = o.load_record(folder / 'allowed' / 'probe-observation.json')
            if o.v.probe_valid(probe):
                break
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    running = session.inspect('running')
    if (not o.v.probe_valid(probe) or running.get('State', {}).get('Running') is not True
            or guard.poll() is not None or time.monotonic() >= req['deadline_monotonic'] - 36):
        raise ValueError('Live probe/guard before parent loss not proven')
    o.persist(folder, 'parent-exit-intent.json', {'pid': os.getpid(), 'guard_pid': guard.pid,
        'container_id': session.identity, 'exit_code': 77, 'utc': o.utc(),
        'monotonic': time.monotonic(), 'probe_valid': True, 'running_inspection': running, **BOUNDARY})
    os._exit(77)  # Deliberately bypass finally/normal parent cleanup; guard is independent.


def observe(h):
    o = h.observation
    if sys.platform != 'win32' or o.digest(h.PYTHON) != h.PYTHON_SHA or o.digest(o.DOCKER) != o.DOCKER_SHA:
        raise ValueError('Exact existing Windows executables required')
    folder, _, _ = h.parent.paths(NONCE)
    # Existing reservation, even damaged/UNKNOWN, never dispatches again.
    folder.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    req = request(started, datetime.now(timezone.utc))
    for name in ('allowed', 'docker-config', 'temp'):
        (folder / name).mkdir()
    for name, data in [('probe.py', o.PROBE.read_bytes()),
                       ('ga.raw', (json.dumps(req, sort_keys=True) + '\n').encode())]:
        with (folder / name).open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    digest = o.digest(folder / 'ga.raw')
    o.persist(folder, 'host-intent.json', {'nonce': NONCE, 'ga_sha256': digest,
        'legacy_ga_field_contains': 'EngineeringObservationRequest, not a GateAuthorization',
        'host_source_sha256': h.source_sha(), 'started_monotonic': started,
        'deadline_monotonic': req['deadline_monotonic'], 'deadline_utc': req['deadline'], **BOUNDARY})
    o.persist(folder, 'probe-intent.json', {'nonce': NONCE, 'image': o.v.IMAGE,
        'probe_sha256': o.PROBE_SHA, 'source_bindings': o.source_bindings(),
        'started_monotonic': started, 'deadline_monotonic': req['deadline_monotonic'], **BOUNDARY})
    argv = [str(h.PYTHON), '-I', '-S', '-B', '-X', 'utf8', str(Path(__file__).resolve()), '--parent']
    o.persist(folder, 'parent-launch-intent.json', {'argv': argv, 'utc': o.utc(),
        'harness_sha256': o.digest(Path(__file__)), 'request_sha256': digest, **BOUNDARY})
    if time.monotonic() >= req['deadline_monotonic'] - 36:
        raise ValueError('No launch window remains')
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, env=o.environment(folder), cwd=str(folder), shell=False,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    o.persist(folder, 'parent-launched.json', {'pid': proc.pid, 'monotonic': time.monotonic()})
    result = {'status': 'UNKNOWN', 'evidence_retained': True, 'container_retained': True, **BOUNDARY}
    try:
        code = proc.wait(timeout=max(0.01, req['deadline_monotonic'] - 30 - time.monotonic()))
        o.persist(folder, 'parent-exit-observed.json', {'pid': proc.pid, 'exit_code': code,
            'utc': o.utc(), 'monotonic': time.monotonic(), 'observer_pid': os.getpid()})
        exit_intent = o.load_record(folder / 'parent-exit-intent.json')
        if code != 77 or exit_intent.get('pid') != proc.pid:
            raise ValueError('Exact deliberate parent exit not observed')
        stop = None
        while time.monotonic() < req['deadline_monotonic'] - 6:
            try:
                stop = o.load_record(folder / 'watchdog-stopped.json')
                break
            except (OSError, ValueError):
                time.sleep(0.05)
        exact_id = h.identity(exit_intent['container_id'])
        ready = o.load_record(folder / 'watchdog-ready.json')
        if (type(ready.get('pid')) is not int or ready['pid'] != exit_intent['guard_pid']
                or ready.get('container_id') != exact_id or ready.get('nonce') != NONCE
                or ready.get('deadline_monotonic') != req['deadline_monotonic']):
            raise ValueError('Exact independent guard evidence changed')
        if (not stop or stop.get('container_id') != exact_id
                or not o.v.model.stopped(stop.get('inspection'), exact_id)):
            raise ValueError('Independent guard STOP not observed')
        port = h.FixedHost(NONCE, digest)
        final = port.inspect(exact_id, 'observer-final-inspect')
        if not o.v.model.stopped(final, exact_id):
            raise ValueError('Final exact STOP readback rejected')
        result.update(status='PARENT_EXIT_AND_GUARD_STOP_OBSERVED', container_id=exact_id,
            parent_pid=proc.pid, parent_exit_code=code, guard_pid=exit_intent['guard_pid'],
            stop_observed=True, parent_result_remains_unknown=True)
    except Exception as exc:
        result['reason'] = type(exc).__name__
        # Do not terminate the independent guard or re-send uncertain Docker actions.
    result.update(elapsed_seconds=time.monotonic() - started, utc=o.utc())
    o.persist(folder, 'engineering-result.json', result)
    return result


def main():
    if sys.argv[1:] not in (['observe'], ['--parent']):
        raise SystemExit('Only fixed engineering observe/internal parent; formal denied')
    h = runtime()
    if sys.argv[1:] == ['--parent']:
        parent_process(h)
        return 2
    try:
        result = observe(h)
    except Exception as exc:
        result = {'status': 'UNKNOWN', 'reason': type(exc).__name__, **BOUNDARY}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'PARENT_EXIT_AND_GUARD_STOP_OBSERVED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
