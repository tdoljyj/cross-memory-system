"""Fixed synthetic Linux probe. No Skill loading, shell, model or host commands."""
import errno
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

ALLOWED = Path('/allowed')
BOUNDARY = {'qualified': False, 'authorization_effect': 'NONE'}


def status():
    values = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in {'CapEff', 'CapPrm', 'NoNewPrivs', 'Seccomp', 'NSpid'}:
            values[key] = value.strip()
    return values


def save(name, value):
    with (ALLOWED / name).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def network_denial(error):
    # Timeouts, ECONNREFUSED and a missing external server are not isolation proof.
    return getattr(error, 'errno', None) in {errno.ENETUNREACH, errno.EPERM, errno.EACCES}


def descendant_ready(value, expected_pid, expected_ppid):
    if not isinstance(value, dict):
        return False
    return (type(value.get('pid')) is int and value['pid'] == expected_pid
            and type(value.get('ppid')) is int and value['ppid'] == expected_ppid
            and type(value.get('uid')) is int and value['uid'] == 10001
            and value.get('sigterm_ignored') is True)


def read_descendant_ready(path, expected_pid, expected_ppid):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        # Existence alone is not readiness: a CreateNew writer may be midway
        # through its record. The caller waits only within its fixed deadline.
        return None
    return value if descendant_ready(value, expected_pid, expected_ppid) else None


def main():
    if sys.platform != 'linux' or os.geteuid() != 10001:
        raise RuntimeError('Fixed Linux non-root uid 10001 required')
    token = status()
    if token.get('NoNewPrivs') != '1' or int(token.get('CapEff', '1'), 16) or int(token.get('CapPrm', '1'), 16):
        raise RuntimeError('No-new-privileges and zero capabilities required')
    if sys.argv[1:] == ['--descendant']:
        # Exercise actual container tree shutdown, including a child resisting TERM.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        save('descendant.json', {'pid': os.getpid(), 'ppid': os.getppid(), 'uid': os.geteuid(), 'status': token,
                                'sigterm_ignored': signal.getsignal(signal.SIGTERM) == signal.SIG_IGN, **BOUNDARY})
        while True:
            time.sleep(1)
    if sys.argv[1:]:
        raise RuntimeError('Unknown probe operation')
    interfaces = sorted(item.name for item in Path('/sys/class/net').iterdir())
    if interfaces != ['lo']:
        raise RuntimeError('Only loopback may exist before synthetic network probe')
    observation = {'uid': os.geteuid(), 'pid': os.getpid(), 'status': token, 'interfaces': interfaces, **BOUNDARY}
    observation['credential_canary_inherited'] = 'CLUED_SYNTHETIC_CREDENTIAL_CANARY' in os.environ
    save('allowed-write.json', {'synthetic': True})
    observation['allowed_write'] = True
    try:
        Path('/etc/clued-synthetic-denied').write_text('synthetic only')
        observation['rootfs_write_denied'] = False
    except OSError as exc:
        observation['rootfs_write_errno'] = exc.errno
        observation['rootfs_write_denied'] = exc.errno in {errno.EROFS, errno.EACCES, errno.EPERM}
    private = Path('/tmp/private-synthetic-canary')
    private.write_text('synthetic only')
    private.chmod(0)
    try:
        private.read_text()
        observation['private_canary_read_denied'] = False
    except OSError as exc:
        observation['private_canary_errno'] = exc.errno
        observation['private_canary_read_denied'] = exc.errno in {errno.EACCES, errno.EPERM}
    finally:
        private.chmod(0o600)
    # Loopback positive control proves the TCP operation works in this namespace.
    with socket.socket() as server:
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        with socket.create_connection(server.getsockname(), timeout=1):
            accepted, _ = server.accept()
            accepted.close()
        observation['loopback_positive_control'] = True
    try:
        # Documentation-only TEST-NET address; no real service or payload.
        with socket.create_connection(('192.0.2.1', 9), timeout=1):
            observation['network_denied'] = False
            observation['network_result'] = 'UNEXPECTED_CONNECTION'
    except OSError as exc:
        observation['network_errno'] = exc.errno
        observation['network_denied'] = network_denial(exc)
        observation['network_result'] = type(exc).__name__
    child = subprocess.Popen(['/usr/local/bin/python3', '-I', '-S', '-B', '/driver/probe.py', '--descendant'], env={})
    deadline = time.monotonic() + 3
    ready = None
    while time.monotonic() < deadline and child.poll() is None:
        ready = read_descendant_ready(ALLOWED / 'descendant.json', child.pid, os.getpid())
        if ready is not None:
            break
        time.sleep(0.01)
    if ready is None:
        raise RuntimeError('Complete matching fixed descendant readiness missing')
    observation['descendant_pid'] = child.pid
    observation['descendant_readiness'] = ready
    observation['tree_active'] = ready is not None and child.poll() is None
    observation['checks_observed'] = all(observation.get(k) is True for k in (
        'allowed_write', 'rootfs_write_denied', 'private_canary_read_denied',
        'loopback_positive_control', 'network_denied', 'tree_active')) and not observation['credential_canary_inherited']
    save('probe-observation.json', observation)
    print(json.dumps(observation, sort_keys=True), flush=True)
    # Fixed supervisor will STOP the whole container; this driver never exits
    # normally and never calls back into a host endpoint or credential store.
    while True:
        time.sleep(1)


if __name__ == '__main__':
    main()
