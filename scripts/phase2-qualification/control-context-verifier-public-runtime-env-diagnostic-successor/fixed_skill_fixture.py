"""Fixed isolated synthetic action primitive; no qualification/authority issuer.

The three accepted Skill files are immutable input data, never executable code.
Only a later independently accepted supervisor may connect this primitive to GA.
Direct CLI entry remains blocked while that parent integration is unavailable.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

DRIVER = Path('/driver')
ALLOWED = Path('/allowed')
SUBJECT = {
    'SKILL.md': ('8a5e6d9548731874b94ebe3edc046f7393c96fd75531f22231228e055206096f', 3913),
    'references/engineering.md': ('ffff299ea0a1793f9b0b4963fc5bf099762fabce96ed96086cfc5494acbb8d29', 5780),
    'references/memory-operations.md': ('a05feabc8ad4ccac535bb059fbf35179f79884dfb1113abdd18b21281bfda538', 5166),
}
PUBLIC_ENV = {
    'PATH': '/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'LANG': 'C.UTF-8',
    'GPG_KEY': '7169605F62C751356D054A26A821E680E5FA6305',
    'PYTHON_VERSION': '3.12.14',
    'PYTHON_SHA256': '5c8462af5790baf43a321a1559dbe0db06d1be4300fb85fb53c40060668e548a',
    'HOME': '/tmp',
    'HOSTNAME': 'clued-synthetic-runtime',
}
FIXTURE = b'{"fixture":"synthetic-v1","real_user_payload":false}\n'


class Denied(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise Denied(reason)


def subject_bytes_valid(blobs):
    return (type(blobs) is dict and set(blobs) == set(SUBJECT)
            and all(type(blobs[path]) is bytes and len(blobs[path]) == size
                    and hashlib.sha256(blobs[path]).hexdigest() == digest
                    for path, (digest, size) in SUBJECT.items()))


def environment_valid(environment):
    # Exact public runtime proposal: all seven values are explicit create argv.
    # No clearing, wildcard, inferred host value or unknown runtime key is allowed.
    return type(environment) is dict and environment == PUBLIC_ENV


def public_environment_denial_summary(environment):
    """Names are drawn only from fixed PUBLIC_ENV; unknown names/values are never emitted."""
    if type(environment) is not dict:
        return {'invalid_mapping': True}
    return {
        'missing_public_keys': sorted(key for key in PUBLIC_ENV if key not in environment),
        'mismatched_public_keys': sorted(key for key in PUBLIC_ENV if key in environment and environment[key] != PUBLIC_ENV[key]),
        'unknown_key_count': sum(1 for key in environment if key not in PUBLIC_ENV),
    }


def check_environment(environment):
    if not environment_valid(environment):
        raise Denied('unaccepted_environment:' + json.dumps(public_environment_denial_summary(environment), sort_keys=True, separators=(',', ':')))


def isolated_process_valid(platform, uid, pid, token, interfaces):
    return (platform == 'linux' and type(uid) is int and uid == 10001
            and type(pid) is int and pid == 1 and type(token) is dict
            and token.get('NoNewPrivs') == '1'
            and token.get('CapEff') == '0000000000000000'
            and token.get('CapPrm') == '0000000000000000'
            and token.get('Seccomp') == '2' and interfaces == ['lo'])


def check_process():
    require(sys.platform == 'linux', 'fixed_linux_only')
    values = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        key, _, value = line.partition(':')
        values[key] = value.strip()
    interfaces = sorted(item.name for item in Path('/sys/class/net').iterdir())
    require(isolated_process_valid(sys.platform, os.geteuid(), os.getpid(), values, interfaces), 'isolation_process_mismatch')
    check_environment(dict(os.environ))
    # These local observations cannot replace parent inspect for mounts,
    # resource limits, current revocation, remote Intent or accepted authority.


def read_subject():
    expected_files = set(SUBJECT) | {'fixed_skill_fixture.py'}
    entries = list(DRIVER.rglob('*'))
    require(all(not item.is_symlink() for item in entries), 'linked_driver_input')
    actual_files = {item.relative_to(DRIVER).as_posix() for item in entries if item.is_file()}
    require(actual_files == expected_files, 'unexpected_driver_input')
    blobs = {}
    for path, (_, size) in SUBJECT.items():
        with (DRIVER / path).open('rb') as stream:
            blobs[path] = stream.read(size + 1)
    require(subject_bytes_valid(blobs), 'exact_skill_bytes_changed')
    return {path: digest for path, (digest, _) in SUBJECT.items()}


def persist_fixed_fixture():
    # A single exact existing fixture, one CreateNew target, no caller path or
    # payload. An interrupted or existing write is not silently repeated.
    require(not ALLOWED.is_symlink() and ALLOWED.is_dir(), 'allowed_directory_invalid')
    target = ALLOWED / 'fixture.json'
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'target_not_regular')
        stream.write(FIXTURE)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(FIXTURE).hexdigest()


def isolated_action_primitive():
    """Library primitive only, NOT a GA validator or controller entry point."""
    check_process()
    subject = read_subject()
    check_process()
    digest = persist_fixed_fixture()
    return {'observation': 'FIXED_SYNTHETIC_FIXTURE_WRITTEN', 'fixture_sha256': digest,
            'skill_input_sha256': subject, 'skill_behavior_evaluated': False,
            'model_calls': 0, 'authorization_effect': 'NONE', 'qualified': False}


if __name__ == '__main__':
    print(json.dumps({'status': 'BLOCKED', 'reason': 'Accepted parent GA/Profile/current-state supervision is not connected',
                      'side_effects_dispatched': 0, 'authorization_effect': 'NONE', 'qualified': False}))
    raise SystemExit(2)
