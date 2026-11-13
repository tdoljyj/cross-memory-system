"""First install (README section 8c), field step 2, root in the new node's CI distribution, READ-ONLY, no private key read: the facts
the Windows side needs to build the node's package and first-install scripts. Prints one JSON document (public values only); the
Owner returns it as a file, tools/first-install-config.py turns it and the node's config into the build configuration.
  wsl -d <distribution> -u root -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/python3.12 -I first-install-facts.py
"""
import hashlib, json, os, stat, subprocess

CONTRACT = 'clued.independent-ci.linux-first-install-facts/1'
NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node'
PUB = '/etc/clued-independent-ci/verify-result-public.pem'
KEY = '/etc/clued-independent-ci/verify-result-key.pem'
EXES = {'docker': '/usr/bin/docker', 'git': '/usr/bin/git'}
# what a node with a Linux CI already has; a first install needs every one absent (first-install.py phase A checks it again)
CI_PATHS = ['/opt/clued-independent-ci/source-v2', '/opt/clued-independent-ci/resident-v1', '/opt/clued-independent-ci/upgrade-v1',
            '/etc/clued-independent-ci/roles-v3',
            '/etc/clued-independent-ci/formal-source-manifest-v2.json', '/var/lib/clued-independent-ci/resident/source-v2-install-receipt.json',
            '/var/lib/clued-independent-ci/resident/upgrade/current.json']


def protected(p):
    """check-host.py's rule: root-owned, not group/other-writable, no link anywhere on the path, a single-link regular file."""
    cur = '/'
    for part in [x for x in p.split('/') if x]:
        cur = os.path.join(cur, part)
        s = os.lstat(cur)
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            return False
    s = os.lstat(p)
    return stat.S_ISREG(s.st_mode) and s.st_nlink == 1


def file_fact(p):
    if not os.path.lexists(p):
        return {'path': p, 'present': False}
    with open(p, 'rb') as f:
        data = f.read()
    return {'path': p, 'present': True, 'protected': protected(p), 'sha256': hashlib.sha256(data).hexdigest()}


def run(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return None


facts = {'contract': CONTRACT, 'root': os.geteuid() == 0, 'toolchainNode': file_fact(NODE), 'resultPublicKey': file_fact(PUB),
         'executables': {k: file_fact(p) for k, p in EXES.items()}, 'linuxCiPresent': [p for p in CI_PATHS if os.path.lexists(p)]}
if facts['resultPublicKey']['present']:
    with open(PUB, 'rb') as f:
        facts['resultPublicKey']['pem'] = f.read().decode('ascii', 'replace')
k = os.lstat(KEY) if os.path.lexists(KEY) else None   # the private key: only its metadata, never its bytes
facts['resultKey'] = {'present': k is not None, 'protected': k is not None and protected(KEY) and (k.st_mode & 0o777) == 0o600}
facts['systemdPid1'] = (run('/usr/bin/cat', '/proc/1/comm') == 'systemd')
facts['cgroupV2'] = os.path.exists('/sys/fs/cgroup/cgroup.controllers')
facts['dockerActive'] = (run('/usr/bin/systemctl', 'is-active', 'docker.service') == 'active')
facts['python312'] = os.path.exists('/usr/bin/python3.12')
print(json.dumps(facts, indent=1, sort_keys=True))
