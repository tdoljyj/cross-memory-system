#!/usr/bin/python3.12 -I
"""First install of a node's Linux half (Z1, Owner Decision: DESK-W-591 Linux host qualification derived from TURING's reviewed
roles-v3), root on Linux, NO private key. derive-roles-r7.py has already turned the template node's reviewed role policies v3 and
signed payloads into this record's (sourceManifestSha256 and the two refs; every Source pin checked in the commit). This step puts
in the facts that belong to THIS node and nothing else:
  policy and payload: keyId, runtimeIdentity (the node's result signer, as its record's signers.json names it)
  payload:            resultPublicKeySha256 = SHA-256 of this node's /etc/clued-independent-ci/verify-result-public.pem
  policy:             dockerExecutableSha256, gitExecutableSha256, nodeExecutableSha256 = the live root-protected files the policy names
Any other difference is refused. Writes create-only into --out (0400).
  python3.12 -I first-node-facts.py --in <derived roles dir> --key-id <id> --runtime-id <id> --out <new dir>
"""
import hashlib, json, os, re, stat, sys

A = sys.argv[1:]
ROLES = ('gitleaks', 'trivy', 'contract-placement')
PUB = '/etc/clued-independent-ci/verify-result-public.pem'
POLICY_KEYS = ('keyId', 'runtimeIdentity', 'dockerExecutableSha256', 'gitExecutableSha256', 'nodeExecutableSha256')
PAYLOAD_KEYS = ('keyId', 'runtimeIdentity', 'resultPublicKeySha256')
EXES = (('dockerExecutable', 'dockerExecutableSha256'), ('gitExecutable', 'gitExecutableSha256'), ('nodeExecutable', 'nodeExecutableSha256'))


def refuse(code, **detail):
    print(json.dumps({'status': 'REFUSED', 'code': code, **detail}, sort_keys=True))
    sys.exit(1)


def opt(n):
    if n not in A or A.index(n) + 1 >= len(A):
        refuse('ARGUMENT_REQUIRED', name=n)
    return A[A.index(n) + 1]


def protected_sha(p):
    """check-host.py's rule: a root-owned regular file, not group/other-writable, no link on its path."""
    cur = '/'
    for part in [x for x in p.split('/') if x]:
        cur = os.path.join(cur, part)
        s = os.lstat(cur)
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            refuse('HOST_FILE_NOT_ROOT_PROTECTED', path=cur)
    s = os.lstat(p)
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        refuse('HOST_FILE_NOT_A_REGULAR_FILE', path=p)
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


IN, KEY_ID, RUNTIME_ID, OUT = opt('--in'), opt('--key-id'), opt('--runtime-id'), opt('--out')
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{6,78}[a-z0-9]', KEY_ID) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{6,78}[A-Za-z0-9]', RUNTIME_ID):
    refuse('ARGUMENT_SHAPE')
if os.geteuid() != 0:
    refuse('ROOT_REQUIRED')
if os.path.lexists(OUT):
    refuse('OUTPUT_EXISTS_PRESERVE')
pub_sha = protected_sha(PUB)
os.makedirs(OUT, mode=0o700)
report = {'status': None, 'contract': 'clued.independent-ci.linux-first-node-facts/1', 'keyId': KEY_ID, 'runtimeIdentity': RUNTIME_ID,
          'resultPublicKeySha256': pub_sha, 'roles': {}}
for role in ROLES:
    pol = json.load(open(os.path.join(IN, role + '.json'), encoding='utf-8'))
    pay = json.load(open(os.path.join(IN, role + '.qualification.payload.json'), encoding='utf-8'))
    if pol.get('role') != role or pay.get('role') != role or pay.get('qualifiedAt') is not None:
        refuse('DERIVED_ROLE_SHAPE', role=role)
    new_pol, new_pay = dict(pol), dict(pay)
    for d in (new_pol, new_pay):
        d['keyId'] = KEY_ID
        d['runtimeIdentity'] = RUNTIME_ID
    new_pay['resultPublicKeySha256'] = pub_sha
    for exe, pin in EXES:
        if not isinstance(pol.get(exe), str) or not pol[exe].startswith('/'):
            refuse('POLICY_EXECUTABLE_PATH', role=role, key=exe)
        new_pol[pin] = protected_sha(pol[exe])
    changed_pol = sorted(k for k in set(pol) | set(new_pol) if pol.get(k) != new_pol.get(k))
    changed_pay = sorted(k for k in set(pay) | set(new_pay) if pay.get(k) != new_pay.get(k))
    if not set(changed_pol) <= set(POLICY_KEYS) or not set(changed_pay) <= set(PAYLOAD_KEYS) or set(new_pol) != set(pol) or set(new_pay) != set(pay):
        refuse('NODE_FACTS_OUTSIDE_THE_NODE_KEYS', role=role, policy=changed_pol, payload=changed_pay)
    out = {}
    for name, value in ((role + '.json', new_pol), (role + '.qualification.payload.json', new_pay)):
        data = (canonical(value) + '\n').encode('utf-8')
        fd = os.open(os.path.join(OUT, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
        try:
            if os.write(fd, data) != len(data):
                refuse('WRITE_UNCONFIRMED', file=name)
            os.fsync(fd)
        finally:
            os.close(fd)
        out[name] = hashlib.sha256(data).hexdigest()
    report['roles'][role] = {'policySha256': out[role + '.json'], 'payloadSha256': out[role + '.qualification.payload.json'],
                             'policyChanged': changed_pol, 'payloadChanged': changed_pay,
                             'hostPins': {k: new_pol.get(k) for k, _ in EXES} | {p: new_pol.get(p) for _, p in EXES},
                             'templateNodeFacts': {k: pol.get(k) for k in POLICY_KEYS} | {'resultPublicKeySha256': pay.get('resultPublicKeySha256')}}
report['status'] = 'NODE_FACTS_WRITTEN'
print(json.dumps(report, sort_keys=True))
