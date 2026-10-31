#!/usr/bin/python3.12 -I
"""r4, root on Linux, read-only, NO key (review M-2; the 10-23 HOST_PINS_CHANGED_SINCE_PHASE1 gate): before anything of the
installed Source34 is touched, every host binary the derived role policies pin (docker, node, git) must hash to its pin, be a
root-owned regular file not writable by group/other, the pinned node must be the node's toolchain node, the docker
socket must be a root socket without other-access, and the public result key must be the node's known one. The two pins are the
node's own (reinstall config linux.host, review 1-1), passed by the generated scripts.
Exit 0 and HOST_PINS_AS_DERIVED, else REFUSED with the differing values.
  python3.12 -I check-host-r4.py <roles-in dir> <toolchain node sha256> <verify-result public key sha256>
"""
import hashlib, json, os, re, stat, sys

ROLES_IN, NODE_SHA, PUB_SHA = sys.argv[1:4]
NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node'
PUB = '/etc/clued-independent-ci/verify-result-public.pem'


def refuse(code, **d):
    print(json.dumps({'status': 'REFUSED', 'code': code, **d}, sort_keys=True))
    sys.exit(1)


def pinned_file(p):
    st = os.lstat(p)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
        refuse('HOST_BINARY_NOT_ROOT_PROTECTED', path=p, mode=oct(st.st_mode), uid=st.st_uid)
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


if not (re.fullmatch(r'[0-9a-f]{64}', NODE_SHA) and re.fullmatch(r'[0-9a-f]{64}', PUB_SHA)):
    refuse('HOST_PIN_ARGUMENTS')
if os.geteuid() != 0:
    refuse('ROOT_REQUIRED')
seen = {}
for role in ('gitleaks', 'trivy', 'contract-placement'):
    pol = json.load(open(os.path.join(ROLES_IN, role + '.json'), encoding='utf-8'))
    for exe, pin in (('dockerExecutable', 'dockerExecutableSha256'), ('nodeExecutable', 'nodeExecutableSha256'), ('gitExecutable', 'gitExecutableSha256')):
        p, want = pol.get(exe), pol.get(pin)
        if not isinstance(p, str) or not isinstance(want, str):
            refuse('POLICY_HOST_PIN_MISSING', role=role, key=pin)
        got = seen.setdefault(p, pinned_file(p))
        if got != want:
            refuse('HOST_PIN_CHANGED', role=role, path=p, pinned=want, now=got)
    if pol.get('nodeExecutable') != NODE:
        refuse('POLICY_NODE_NOT_THE_TOOLCHAIN_NODE', role=role)
if seen.get(NODE) != NODE_SHA:
    refuse('TOOLCHAIN_NODE_CHANGED', now=seen.get(NODE))
s = os.lstat('/run/docker.sock')
if not stat.S_ISSOCK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o007:
    refuse('DOCKER_SOCKET_UNQUALIFIED', mode=oct(s.st_mode), uid=s.st_uid)
pub = pinned_file(PUB)
if pub != PUB_SHA:
    refuse('PUBLIC_RESULT_KEY_CHANGED', now=pub)
print(json.dumps({'status': 'HOST_PINS_AS_DERIVED', 'files': seen, 'publicKeySha256': pub}, sort_keys=True))
