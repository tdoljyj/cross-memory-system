#!/usr/bin/python3.12 -I
"""r7 (Task a3701d3d, patch-r7-linux.py r3): derive-roles-r4.py with the five pinned Source files (entry, qualification-v2.mjs,
worker-v2.mjs, proof.mjs, job-v2.mjs) REPINNED to the new commit's blobs, as clued-ci-upgrade-linux derive_role does (SOURCE_KEYS),
instead of refusing a changed one; each repin is listed in the report. Everything else below is unchanged.

r4 (Owner Decision f6aafe6e), root on Linux, NO key: derive the three role policies v3 and the three UNSIGNED
qualification v2 payloads for the new Source from the INSTALLED Source34 ones, changing only the Source-specific values.
Replaces the out-of-repo derive-linux-v2.mjs (ad68d20f; its Windows copies no longer exist) for this reinstall only.

  policy  <role>.json:                       sourceManifestSha256, sourceAcceptanceRef, hostAcceptanceRef      (nothing else)
  payload <role>.qualification.payload.json: the same three; qualifiedAt := null (the signer sets it, as on 10-21/10-22);
                                             every other field = the installed signed payload
The two refs are taken from the NEW manifest's controllerRelay (review B-1: boundary.mjs:66 validates the relay descriptor
with {sourceAcceptanceRef: policy.sourceAcceptanceRef, hostQualificationRef: policy.hostAcceptanceRef}; mailbox.mjs:28,
linux-worker.mjs:40, signed-result.mjs:55 compare them with the issue) and must equal --source-acceptance-ref /
--host-acceptance-ref. The installed values must equal the OLD manifest's controllerRelay refs.
Before writing: the installed policies/payloads name the OLD manifest; each installed payload binds its policy; every pinned
source file of the policy (entry, qualification-v2.mjs, worker-v2.mjs, proof.mjs, job-v2.mjs) has, in the NEW commit, exactly
the pinned sha256 (git cat-file with GIT_NO_REPLACE_OBJECTS=1, review B-2). Every refusal is explicit (review minor 6).
Writes create-only into --out (0400). Reads /etc/clued-independent-ci/roles-v3 (root 0600), the installed manifest, the new
record's source-manifest.json and the bare repo.

  python3.12 -I derive-roles-r4.py --installed <roles-v3 dir> --old-manifest-file <file> --new-manifest-file <file>
       --src <bare.git> --commit <40hex> --source-acceptance-ref <uuid> --host-acceptance-ref <uuid> --out <new dir>
"""
import hashlib, json, os, re, subprocess, sys

A = sys.argv[1:]


def refuse(code, **detail):
    print(json.dumps({'status': 'REFUSED', 'code': code, **detail}, sort_keys=True))
    sys.exit(1)


def opt(n):
    if n not in A or A.index(n) + 1 >= len(A):
        refuse('ARGUMENT_REQUIRED', name=n)
    return A[A.index(n) + 1]


INST, OLDF, NEWF, SRC, COMMIT, REF, HREF, OUT = (opt('--installed'), opt('--old-manifest-file'), opt('--new-manifest-file'), opt('--src'), opt('--commit'),
                                                 opt('--source-acceptance-ref'), opt('--host-acceptance-ref'), opt('--out'))
ROLES = ('gitleaks', 'trivy', 'contract-placement')
TRUSTED = '/opt/clued-independent-ci/source-v2/'
CI = 'work/actions-hosted-migration/independent-ci-v1/'
UUID = re.compile(r'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
if not re.fullmatch(r'[0-9a-f]{40}', COMMIT) or not UUID.match(REF) or not UUID.match(HREF):
    refuse('ARGUMENT_SHAPE')
if os.geteuid() != 0:
    refuse('ROOT_REQUIRED')
if os.path.lexists(OUT):
    refuse('OUTPUT_EXISTS_PRESERVE')
GIT = ['/usr/bin/git', '--git-dir=' + SRC, '-c', 'core.hooksPath=/nonexistent']
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_OPTIONAL_LOCKS': '0'}
head = subprocess.run(GIT + ['rev-parse', '--verify', 'HEAD^{commit}'], capture_output=True, text=True, env=ENV).stdout.strip()
if head != COMMIT:
    refuse('SOURCE_REPOSITORY_NOT_THE_ACCEPTED_COMMIT', head=head)


def blob_sha(rel):
    p = subprocess.run(GIT + ['cat-file', 'blob', COMMIT + ':' + rel], capture_output=True, env=ENV)
    if p.returncode != 0:
        refuse('PINNED_FILE_MISSING_IN_NEW_COMMIT', path=rel)
    return hashlib.sha256(p.stdout).hexdigest()


def canonical(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def sha_file(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


old_m, new_m = json.load(open(OLDF, encoding='utf-8')), json.load(open(NEWF, encoding='utf-8'))
OLD, NEW = sha_file(OLDF), sha_file(NEWF)
if OLD == NEW or new_m.get('sourceSha') != COMMIT:
    refuse('MANIFESTS_NOT_OLD_AND_NEW', old=OLD, new=NEW)
os.makedirs(OUT, mode=0o700)
report = {'status': None, 'contract': 'clued.independent-ci.linux-source-v2-derivation-r7/1', 'sourceCommit': COMMIT, 'oldManifestSha256': OLD,
          'ciSourceManifestSha256': NEW, 'sourceAcceptanceRef': REF, 'hostAcceptanceRef': HREF, 'roles': {}}
PINS = {'qualificationSha256': CI + 'worker/qualification-v2.mjs', 'workerSha256': CI + 'src/worker-v2.mjs', 'proofSha256': CI + 'src/proof.mjs', 'jobSha256': CI + 'src/job-v2.mjs'}
CHANGED = ('sourceManifestSha256', 'sourceAcceptanceRef', 'hostAcceptanceRef')
for role in ROLES:
    orel, nrel = old_m['roles'][role]['controllerRelay'], new_m['roles'][role]['controllerRelay']
    if nrel['sourceAcceptanceRef'] != REF or nrel['hostQualificationRef'] != HREF:
        refuse('NEW_RELAY_REFS_NOT_THE_ARGUMENTS', role=role, relay=nrel)
    pol = json.load(open(os.path.join(INST, role + '.json'), encoding='utf-8'))
    q = json.load(open(os.path.join(INST, role + '.qualification.json'), encoding='utf-8'))
    if set(q) != {'payload', 'signature'}:
        refuse('INSTALLED_QUALIFICATION_SHAPE', role=role)
    pay = q['payload']
    if pol.get('sourceManifestSha256') != OLD or pay.get('sourceManifestSha256') != OLD:
        refuse('INSTALLED_NOT_THE_OLD_MANIFEST', role=role)
    if pol.get('sourceAcceptanceRef') != orel['sourceAcceptanceRef'] or pol.get('hostAcceptanceRef') != orel['hostQualificationRef']:
        refuse('INSTALLED_REFS_NOT_THE_OLD_RELAY', role=role, policy=[pol.get('sourceAcceptanceRef'), pol.get('hostAcceptanceRef')], relay=orel)
    for k in ('sourceAcceptanceRef', 'hostAcceptanceRef', 'runtimeIdentity', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256',
              'proofSha256', 'jobSha256', 'nodeExecutable', 'keyId'):
        if pay.get(k) != pol.get(k):
            refuse('INSTALLED_PAYLOAD_NOT_ITS_POLICY', role=role, key=k)
    if not str(pol.get('entryFile', '')).startswith(TRUSTED):
        refuse('ENTRY_OUTSIDE_TRUSTED', role=role)
    pins = {'entrySha256': blob_sha(pol['entryFile'][len(TRUSTED):])}
    pins.update({k: blob_sha(rel) for k, rel in PINS.items()})
    # r7: the installed policy carries every pin as a sha256; a pinned file the new commit changed takes the new commit's value
    for k, v in pins.items():
        if not re.fullmatch(r'[0-9a-f]{64}', str(pol.get(k))):
            refuse('INSTALLED_PIN_NOT_A_SHA256', role=role, key=k, pinned=pol.get(k))
    repinned = {k: {'old': pol.get(k), 'new': v} for k, v in sorted(pins.items()) if pol.get(k) != v}
    new_pol = dict(pol); new_pay = dict(pay)
    for k, v in (('sourceManifestSha256', NEW), ('sourceAcceptanceRef', REF), ('hostAcceptanceRef', HREF)) + tuple(pins.items()):
        new_pol[k] = v; new_pay[k] = v
    new_pay['qualifiedAt'] = None
    changed_pol = sorted(k for k in set(pol) | set(new_pol) if pol.get(k) != new_pol.get(k))
    if not set(changed_pol) <= set(CHANGED) | set(pins) or set(new_pol) != set(pol):   # r7: + the repinned Source files
        refuse('POLICY_DIFF_OUTSIDE_SOURCE_VALUES', role=role, changed=changed_pol)
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
                             'policyChanged': changed_pol, 'old': {k: pol.get(k) for k in CHANGED}, 'oldQualifiedAt': pay.get('qualifiedAt'),
                             'policyKeysCarried': sorted(k for k in pol if k not in CHANGED),
                             'payloadKeysCarried': sorted(k for k in pay if k not in CHANGED + ('qualifiedAt',)),
                             'carriedForReview': {k: pay.get(k) for k in ('keyId', 'resultPublicKeySha256', 'expiresAt', 'runtimeIdentity', 'image', 'isolation')},
                             'hostPins': {k: pol.get(k) for k in ('dockerExecutable', 'dockerExecutableSha256', 'nodeExecutable', 'nodeExecutableSha256', 'gitExecutable', 'gitExecutableSha256')},
                             'pinsCheckedInNewCommit': sorted(pins), 'repinned': repinned}
report['status'] = 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN'
print(json.dumps(report, sort_keys=True))
