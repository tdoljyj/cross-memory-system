#!/usr/bin/python3.12 -I
"""Source v2 Linux workspace preparation (DESIGN S9, §10.1). Parameterised successor of the reviewed
manual ws-prep-bNN/prepare-bNN-workspaces.py: run as root by clued-ci-wsprep@<batchId>.service, between
stage 1 (admitted) and stage 2. It never executes PR content and never uses the network.

    /usr/bin/python3.12 -I prepare-workspaces.py --batch <16hex-12hex>

Inputs (all data, all re-verified here):
  - the resident's public batch descriptor  /mnt/c/ProgramData/CluedIndependentCI/resident/outbox/<id>/descriptor.json
  - the companion's bundle + receipt         /mnt/c/ProgramData/CluedIndependentCI/resident/bundles/<id>/
  - the installed claim-free Source v2       /etc/clued-independent-ci/formal-source-manifest-v2.json, roles-v3/*.json,
                                             /opt/clued-independent-ci/source-v2 (trusted checkout)
Checks kept from b29: root + isolated pinned python + minimal environment; job ids recomputed from
content; installed manifest and role policies; trusted Source commit and clean tree; runs/ empty, no role
lock, empty spool, no worker process; bundle sealed by streaming copy and hash; bundle age <= 2 h;
header: v2, no prerequisites/capabilities, formal refs == the receipt's ls-remote list, main == base,
exact reviewed refs; mirror + candidates without hardlinks; git-dir audits; fsck --full --strict;
only 100644/100755 blobs; workspaces root:root 0700.
Changed against b29 (each a lesson): job ids are content + attempt, no claim (contract /2, now /3), so an
attempt 2 never collides with attempt 1's workspaces; the trusted Source is compared with the
installed Source commit, NOT with the PR head (b29 only worked because they were the same commit);
refusal codes report the caller's line; nothing is patched into this file per batch.
Quota phase 2 step 3b: job contract /3 and descriptor /3 name the tested commit S (testSha) next to the head
and the base; the trivy and placement candidates are checked out at S. Step 3c-2: S != H only for a train
front batch, where S is GitHub's test merge of [T, H] read live by stage 10. The bundle then carries S under
refs/clued-test/<S> (the receipt counts it), the candidates fetch that ref, and the mirror store checks that S's
parents are exactly [T, H]. Everywhere else S = H and every workspace is exactly what it was under /2.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
from datetime import datetime, timezone

STATE = '/var/lib/clued-independent-ci'
WS = f'{STATE}/workspaces'
RUNS = f'{STATE}/runs'
SPOOL = f'{STATE}/formal-spool'
ROLE_LOCK = f'{STATE}/formal-role.lock'
WINDOWS = '/mnt/c/ProgramData/CluedIndependentCI/resident'
SOURCE_MANIFEST = '/etc/clued-independent-ci/formal-source-manifest-v2.json'
ROLE_DIR = '/etc/clued-independent-ci/roles-v3'
TRUSTED = '/opt/clued-independent-ci/source-v2'
NODE = f'{STATE}/toolchain-build-legacy-v1/node'
GIT = '/usr/bin/git'
REPO = 'tdoljyj/cross-memory-system'
JOB_CONTRACT = 'clued.independent-ci.job/3'
DESCRIPTOR_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/3'
LINUX_ROLES = ('gitleaks', 'trivy', 'contract-placement')
BATCH_ID = re.compile(r'^[0-9a-f]{16}-[0-9a-f]{12}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
HEX40 = re.compile(r'^[0-9a-f]{40}$')
MAX_BUNDLE = 2 << 30
TEST_REF_PREFIX = 'refs/clued-test/'
BUNDLE_MAX_AGE_S = 7200
CLOCK_SKEW_S = 300
GIT_ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_TERMINAL_PROMPT': '0', 'GIT_ALLOW_PROTOCOL': 'file', 'GIT_NO_REPLACE_OBJECTS': '1'}
GIT_PREFIX = ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=/nonexistent-clued-hooks', '-c', 'init.templateDir=',
              '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.fsmonitor=false', '-c', 'advice.detachedHead=false',
              # Review MINOR-7: a checkout never materialises a symlink, and NTFS/HFS-special names are refused.
              '-c', 'core.symlinks=false', '-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true']


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code
        # The caller's line, not this helper's (lesson b29: every refusal reported line 123).
        self.line = sys._getframe(2).f_lineno if hasattr(sys, '_getframe') else None


def need(cond, code):
    if not cond:
        raise Refused(code)


# ---------- pure helpers (unit-tested on any OS) ----------

def job_id_v2(d, role):
    """Same formula as job-v2.mjs#jobIdV2 (JSON.stringify of the identity list, contract /3)."""
    ident = [JOB_CONTRACT, d['repo'], d['pr'], d['headSha'], d['baseSha'], d['testSha'], d['ciSourceManifestSha256'], role, d['attempt']]
    return hashlib.sha256(json.dumps(ident, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()


def validate_descriptor(d, batch_id):
    need(isinstance(d, dict) and d.get('contract') == DESCRIPTOR_CONTRACT and d.get('batchId') == batch_id, 'DESCRIPTOR_REFUSED')
    need(d.get('repo') == REPO and isinstance(d.get('pr'), int) and not isinstance(d.get('pr'), bool) and d['pr'] > 0, 'DESCRIPTOR_REFUSED')
    need(all(isinstance(d.get(k), str) and HEX40.fullmatch(d[k]) for k in ('headSha', 'baseSha', 'testSha', 'sourceCommit')), 'DESCRIPTOR_REFUSED')
    # Step 3c-2: S != H only for a train front batch (GitHub's test merge of [T, H]); the bundle then carries S under
    # refs/clued-test/<S> and prepare() checks its parents. S = H everywhere else, exactly as before.
    need(all(isinstance(d.get(k), str) and HEX64.fullmatch(d[k]) for k in ('batchKey', 'ciSourceManifestSha256', 'gitleaksTomlSha256')), 'DESCRIPTOR_REFUSED')
    need(d.get('attempt') in (1, 2) and d['batchKey'][:16] == batch_id[:16], 'DESCRIPTOR_REFUSED')
    ids = d.get('linuxJobIds')
    need(isinstance(ids, list) and len(ids) == 3 and all(isinstance(j, str) and HEX64.fullmatch(j) for j in ids), 'DESCRIPTOR_REFUSED')
    for role, jid in zip(LINUX_ROLES, ids):
        need(job_id_v2(d, role) == jid, 'EXACT_CONTENT_JOB_ID_REQUIRED')
    return dict(zip(LINUX_ROLES, ids))


FORMAL_REF = re.compile(r'^refs/(heads|tags)/')


def formal_ref_name_ok(name):
    return (FORMAL_REF.match(name) is not None and not re.search(r'[\\:\x00-\x20\x7f~^?*\[\]@{]', name) and not name.startswith('/')
            and not name.endswith('.') and not name.endswith('.lock') and '..' not in name and all(p not in ('', '.', '..') for p in name.split('/')))


def parse_bundle_header(data):
    """Python twin of build-bundle.ps1 Bundle-Header: v2, ASCII, no prerequisite/capability lines."""
    end = data.find(b'\n\n')
    need(end >= 0 and len(data) >= end + 6 and data[end + 2:end + 6] == b'PACK', 'COMPLETE_BUNDLE_HEADER_REQUIRED')
    head = data[:end]
    need(all(b == 10 or 32 <= b <= 126 for b in head), 'ASCII_BUNDLE_HEADER_REQUIRED')
    lines = head.decode('ascii').split('\n')
    need(lines[0] == '# v2 git bundle', 'V2_SHA1_BUNDLE_REQUIRED')
    formal, reviewed, test = {}, {}, {}
    for line in lines[1:]:
        need(not line.startswith('-') and not line.startswith('@'), 'BUNDLE_PREREQUISITE_OR_CAPABILITY_REFUSED')
        sha, sep, name = line.partition(' ')
        need(sep == ' ' and HEX40.fullmatch(sha), 'EXACT_REF_LINE_REQUIRED')
        if name.startswith('refs/reviewed/'):
            need(name == 'refs/reviewed/' + sha and name not in reviewed, 'EXACT_REVIEWED_REF_REQUIRED')
            reviewed[name] = sha
        elif name.startswith(TEST_REF_PREFIX):
            # Step 3c-2: the tested commit S of a train front batch (at most one, named by its own SHA).
            need(name == TEST_REF_PREFIX + sha and not test, 'EXACT_TEST_REF_REQUIRED')
            test[name] = sha
        else:
            need(formal_ref_name_ok(name) and name not in formal, 'REMOTE_REF_NAME_FAILS_FORMAL_VALIDATION')
            formal[name] = sha
    need(1 <= len(formal) <= 10000, 'REF_COUNT_BOUND')
    return formal, reviewed, test


def expected_test_refs(d):
    """The test ref the bundle must carry: none when S = H, exactly refs/clued-test/<S> for a train front batch."""
    return {} if d['testSha'] == d['headSha'] else {TEST_REF_PREFIX + d['testSha']: d['testSha']}


def test_parents_ok(rev_list_parents_line, d):
    """`git rev-list --parents -n 1 S` must be exactly 'S T H': GitHub's test merge of the batch base and the head."""
    return rev_list_parents_line.split() == [d['testSha'], d['baseSha'], d['headSha']]


def ref_list_sha(refs):
    """Shared with build-bundle.ps1 Ref-List-Sha: ordinal-sorted '<sha> <name>\\n'."""
    return hashlib.sha256(''.join(f'{refs[n]} {n}\n' for n in sorted(refs)).encode('utf-8')).hexdigest()


def iso_seconds(text):
    need(isinstance(text, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z', text), 'RECEIPT_TIME_REQUIRED')
    return datetime.strptime(text[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc).timestamp()


def validate_receipt(r, d, descriptor_sha, now):
    need(isinstance(r, dict) and r.get('contract') == 'clued.independent-ci.resident-bundle-receipt/1' and r.get('status') == 'EXACT_ALL_REFS_AND_REVIEWED_BUNDLE_CREATED', 'BUNDLE_RECEIPT_REFUSED')
    need(r.get('batchId') == d['batchId'] and r.get('descriptorSha256') == descriptor_sha and r.get('headSha') == d['headSha'] and r.get('mainSha') == d['baseSha']
         and r.get('sourceCommit') == d['sourceCommit'] and r.get('gitleaksTomlSha256') == d['gitleaksTomlSha256'] and r.get('prerequisites') == 0
         and r.get('bundleVersion') == 2 and r.get('headPresent') is True and r.get('basePresent') is True, 'BUNDLE_RECEIPT_REFUSED')
    need(all(isinstance(r.get(k), str) and HEX64.fullmatch(r[k]) for k in ('bundleSha256', 'refListSha256', 'reviewedRefListSha256', 'testRefListSha256')), 'BUNDLE_RECEIPT_REFUSED')
    need(r.get('testSha') == d['testSha'] and r.get('testRefCount') == len(expected_test_refs(d)), 'BUNDLE_RECEIPT_REFUSED')
    age = now - iso_seconds(r.get('lsRemoteCompletedAt'))
    need(-CLOCK_SKEW_S <= age <= BUNDLE_MAX_AGE_S, 'FRESH_BUNDLE_REQUIRED')
    return r


def bundle_generation(base, d, descriptor_sha, now):
    """Task 4012c1b9 (DESIGN §37): the newest complete bundle generation of the batch and its validated receipt. gen-2/ (the
    second bundle of a batch resumed from parking point A) when it exists: then its receipt must exist, name generation 2
    and the first generation's exact bundle, and the first one must be this batch's too. A gen-2/ without its receipt is
    refused, never skipped. Otherwise the first generation, whose receipt never names a generation."""
    gen2 = f'{base}/gen-2'
    try:
        gen2_stat = os.lstat(gen2)
    except FileNotFoundError:
        gen2_stat = None
    # Only a gen-2 that does not exist means the first generation; any other error of the lstat refuses (review m3).
    except OSError:
        raise Refused('BUNDLE_GENERATION_INCOMPLETE')
    if gen2_stat is None:
        r = validate_receipt(json.loads(read_public(f'{base}/all-refs.receipt.json', 1 << 20)), d, descriptor_sha, now)
        need('generation' not in r, 'BUNDLE_RECEIPT_REFUSED')
        return base, r
    need(stat.S_ISDIR(gen2_stat.st_mode) and os.path.isfile(f'{gen2}/all-refs.receipt.json'), 'BUNDLE_GENERATION_INCOMPLETE')
    r = validate_receipt(json.loads(read_public(f'{gen2}/all-refs.receipt.json', 1 << 20)), d, descriptor_sha, now)
    first = json.loads(read_public(f'{base}/all-refs.receipt.json', 1 << 20))
    need(isinstance(first, dict) and first.get('contract') == r['contract'] and first.get('batchId') == d['batchId'] and first.get('descriptorSha256') == descriptor_sha
         and 'generation' not in first and isinstance(first.get('bundleSha256'), str) and HEX64.fullmatch(first['bundleSha256']), 'BUNDLE_RECEIPT_REFUSED')
    need(r.get('generation') == 2 and r.get('previousBundleSha256') == first['bundleSha256'] and r.get('previousRefListSha256') == first.get('refListSha256'), 'BUNDLE_RECEIPT_REFUSED')
    return gen2, r


def tree_modes_regular(ls_tree_z):
    """Only regular blobs (100644/100755): no symlink (120000), submodule (160000) or other mode."""
    for row in filter(None, ls_tree_z.split('\0')):
        need(re.match(r'^(100644|100755) blob [0-9a-f]{40}\t', row) is not None, 'NONREGULAR_GIT_ENTRY')
    return True


def git_config_safe(text):
    return re.search(r'^\s*\[(include|includeIf|filter|extensions)\b', text, re.IGNORECASE | re.MULTILINE) is None


# ---------- host steps (Linux, root) ----------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def protected(path, directory=False, private=False):
    cur = '/'
    for part in [p for p in path.split('/') if p]:
        cur = os.path.join(cur, part)
        st = os.lstat(cur)
        need(not stat.S_ISLNK(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, 'UNPROTECTED_PATH')
    st = os.lstat(path)
    need(stat.S_ISDIR(st.st_mode) if directory else (stat.S_ISREG(st.st_mode) and st.st_nlink == 1), 'UNSAFE_FILE_TYPE')
    if private:
        need(not st.st_mode & 0o077, 'PRIVATE_FILE_PERMISSIONS')
    return st


def read_public(path, maximum):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and 0 < st.st_size <= maximum, 'PUBLIC_INPUT_BOUNDARY')
        data = b''
        while len(data) < st.st_size:
            chunk = os.read(fd, st.st_size - len(data))
            need(chunk, 'PUBLIC_INPUT_TRUNCATED')
            data += chunk
        need(os.read(fd, 1) == b'' and os.fstat(fd).st_ino == st.st_ino, 'PUBLIC_INPUT_CHANGED')
        return data
    finally:
        os.close(fd)


def git(args, cwd='/', timeout=300):
    r = subprocess.run([GIT, *GIT_PREFIX, *args], cwd=cwd, env=GIT_ENV, capture_output=True, text=True, timeout=timeout, check=False)
    need(r.returncode == 0, 'GIT_STEP_FAILED')
    return r.stdout


def live_preconditions(job_ids):
    need(os.path.isdir(RUNS) and not os.listdir(RUNS), 'RUNS_NOT_EMPTY')
    need(not os.path.lexists(ROLE_LOCK), 'FORMAL_ROLE_LOCK_PRESENT')
    for sub in ('incoming', 'outgoing'):
        need(not os.listdir(f'{SPOOL}/{sub}'), 'FORMAL_SPOOL_NOT_EMPTY')
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            cmd = open(f'/proc/{pid}/cmdline', 'rb').read().replace(b'\0', b' ')
        except OSError:
            continue
        need(b'linux-worker.mjs' not in cmd and f'{RUNS}/'.encode() not in cmd and not any(j.encode() in cmd for j in job_ids), 'WORKER_PROCESS_PRESENT')


def git_dir_audit(gd):
    for name in ('shallow', 'commondir', 'info/grafts', 'objects/info/alternates', 'objects/info/http-alternates'):
        need(not os.path.lexists(os.path.join(gd, name)), 'SOURCE_SHARED_OR_SHALLOW')
    with open(os.path.join(gd, 'config')) as f:
        need(git_config_safe(f.read()), 'UNSAFE_GIT_CONFIG')
    hooks = os.path.join(gd, 'hooks')
    if os.path.isdir(hooks):
        need(not any(files for _, _, files in os.walk(hooks)), 'GIT_HOOKS_PRESENT')
    for top, dirs, files in os.walk(gd):
        for n in dirs + files:
            st = os.lstat(os.path.join(top, n))
            need(not stat.S_ISLNK(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and (stat.S_ISDIR(st.st_mode) or st.st_nlink == 1), 'GIT_TREE_UNSAFE')


def new_dir(path):
    os.mkdir(path, 0o700)
    os.chown(path, 0, 0)
    fd = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, value):
    with open(path, 'x') as f:
        json.dump(value, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())


def prepare(batch_id):
    need(sys.platform.startswith('linux') and os.geteuid() == 0 and os.getuid() == 0, 'LINUX_ROOT_REQUIRED')
    need(sys.version_info[:2] == (3, 12) and sys.executable == '/usr/bin/python3.12' and sys.flags.isolated == 1, 'FIXED_ISOLATED_PYTHON_REQUIRED')
    need(set(os.environ) <= {'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID'}, 'MINIMAL_ENVIRONMENT_REQUIRED')
    os.umask(0o077)
    need(BATCH_ID.fullmatch(batch_id), 'BATCH_REFUSED')
    raw = read_public(f'{WINDOWS}/outbox/{batch_id}/descriptor.json', 65536)
    d = json.loads(raw)
    jobs = validate_descriptor(d, batch_id)
    descriptor_sha = hashlib.sha256(raw).hexdigest()
    # Installed claim-free Source v2 (root-protected).
    protected(SOURCE_MANIFEST)
    manifest_bytes = open(SOURCE_MANIFEST, 'rb').read()
    need(hashlib.sha256(manifest_bytes).hexdigest() == d['ciSourceManifestSha256'], 'INSTALLED_SOURCE_MANIFEST_CHANGED')
    m = json.loads(manifest_bytes)
    need(m.get('schema') == 'independent-ci.sources.v2' and m.get('repo') == REPO and m.get('sourceSha') == d['sourceCommit'], 'INSTALLED_SOURCE_MANIFEST_CHANGED')
    for role in LINUX_ROLES:
        p = f'{ROLE_DIR}/{role}.json'
        protected(p, private=True)
        pol = json.loads(open(p).read())
        need(pol.get('schema') == 'independent-ci.linux-policy.v3' and pol.get('role') == role and pol.get('formalEnabled') is True and 'currentClaim' not in pol
             and pol.get('workspaceRoot') == WS and pol.get('runsRoot') == RUNS and pol.get('trustedSourceDirectory') == TRUSTED
             and pol.get('sourceManifestSha256') == d['ciSourceManifestSha256'] and pol.get('nodeExecutable') == NODE, 'INSTALLED_ROLE_POLICY_CHANGED')
    for p in (WS, RUNS, SPOOL, f'{SPOOL}/incoming', f'{SPOOL}/outgoing', TRUSTED, f'{TRUSTED}/.git'):
        protected(p, directory=True)
    need(git(['--git-dir', f'{TRUSTED}/.git', '--work-tree', TRUSTED, 'rev-parse', '--verify', 'HEAD^{commit}']).strip() == d['sourceCommit'], 'TRUSTED_SOURCE_NOT_INSTALLED_COMMIT')
    need(git(['--git-dir', f'{TRUSTED}/.git', '--work-tree', TRUSTED, 'status', '--porcelain=v1', '--untracked-files=all'], cwd=TRUSTED).strip() == '', 'DIRTY_SOURCE_NOT_QUALIFIED')
    prep = f'{STATE}/ws-prep-{batch_id}'
    targets = {role: f'{WS}/{jid}' for role, jid in jobs.items()}
    need(not os.path.lexists(prep) and not any(os.path.lexists(t) for t in targets.values()), 'FIXED_TARGET_ALREADY_EXISTS')
    live_preconditions(list(jobs.values()))
    # Bundle: the receipt binds batch, descriptor, head, base, Source commit and freshness.
    src, receipt = bundle_generation(f'{WINDOWS}/bundles/{batch_id}', d, descriptor_sha, time.time())
    created = []
    new_dir(prep)
    created.append(prep)
    write_new(f'{prep}/intent.json', {'contract': 'clued.independent-ci.resident-wsprep-intent/1', 'batchId': batch_id, 'descriptorSha256': descriptor_sha,
                                      'bundleSha256': receipt['bundleSha256'], 'targets': targets, 'automaticRetryAllowed': False})
    sealed = f'{prep}/all-refs.bundle'
    fd = os.open(f'{src}/all-refs.bundle', os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        st = os.fstat(fd)
        need(stat.S_ISREG(st.st_mode) and 0 < st.st_size <= MAX_BUNDLE, 'BUNDLE_BOUNDARY')
        h = hashlib.sha256()
        with open(sealed, 'xb') as out:
            os.fchmod(out.fileno(), 0o600)
            while True:
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                h.update(chunk)
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
        after = os.fstat(fd)
        need(after.st_size == st.st_size and after.st_mtime_ns == st.st_mtime_ns and h.hexdigest() == receipt['bundleSha256'], 'BUNDLE_SEAL_CHANGED')
    finally:
        os.close(fd)
    created.append(sealed)
    need(sha256_file(sealed) == receipt['bundleSha256'], 'BUNDLE_SEAL_CHANGED')
    with open(sealed, 'rb') as f:
        header = f.read(8 << 20)
    formal, reviewed, test = parse_bundle_header(header)
    need(formal.get('refs/heads/main') == d['baseSha'], 'REMOTE_MAIN_BASE_CHANGED')
    need(ref_list_sha(formal) == receipt['refListSha256'] and ref_list_sha(reviewed) == receipt['reviewedRefListSha256']
         and ref_list_sha(test) == receipt['testRefListSha256'], 'BUNDLE_REFS_DIFFER_FROM_RECEIPT')
    need(test == expected_test_refs(d), 'EXACT_TEST_REF_REQUIRED')
    # Workspaces: mirror store for gitleaks, detached candidates for trivy and placement.
    for role, target in targets.items():
        new_dir(target)
        created.append(target)
        if role == 'gitleaks':
            git(['clone', '--mirror', '--no-local', '--no-hardlinks', '--template=', '--', sealed, f'{target}/.git'])
        else:
            git(['clone', '--no-local', '--no-hardlinks', '--no-checkout', '--template=', '--', sealed, f'{target}/candidate'])
            # A train front batch's S is reachable only from its test ref, which a plain clone does not map: give it that
            # ref, so the candidate holds S by name and not as an unreferenced object a gc may drop.
            for name in test:
                git(['-C', f'{target}/candidate', 'fetch', '--quiet', '--no-tags', '--', sealed, f'+{name}:{name}'])
            # Review MINOR-7: the head tree's modes are validated from the object store BEFORE anything is
            # materialised (only 100644/100755 blobs: no symlink, submodule or other entry is ever written).
            # The candidate is the tested commit S (job contract /3): the head, or a train front batch's test merge.
            tree_modes_regular(git(['-C', f'{target}/candidate', 'ls-tree', '-r', '-z', '--full-tree', d['testSha']]))
            git(['-C', f'{target}/candidate', 'checkout', '--quiet', '--detach', '--no-recurse-submodules', d['testSha']])
    facts = {}
    for role, target in targets.items():
        st = os.lstat(target)
        need(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and st.st_gid == 0 and stat.S_IMODE(st.st_mode) == 0o700, 'WORKSPACE_DIRECTORY_MODE')
        gd = f'{target}/.git' if role == 'gitleaks' else f'{target}/candidate/.git'
        git_dir_audit(gd)
        git(['--git-dir', gd, 'fsck', '--full', '--strict', '--no-reflogs'], timeout=600)
        if role == 'gitleaks':
            refs = {}
            for line in git(['--git-dir', gd, 'for-each-ref', '--format=%(objectname) %(refname)']).splitlines():
                sha, _, name = line.partition(' ')
                refs[name] = sha
            need(refs == {**formal, **reviewed, **test}, 'STORE_REFS_DIFFER_FROM_BUNDLE')
            for c in (d['headSha'], d['baseSha']):
                need(git(['--git-dir', gd, 'cat-file', '-t', c]).strip() == 'commit', 'HEAD_BASE_COMMIT_MISSING')
            if test:
                # S must be GitHub's merge of exactly [T, H] (design v0.5 §5.2): checked on the object itself.
                need(git(['--git-dir', gd, 'cat-file', '-t', d['testSha']]).strip() == 'commit', 'TEST_COMMIT_MISSING')
                need(test_parents_ok(git(['--git-dir', gd, 'rev-list', '--parents', '-n', '1', d['testSha']]).strip(), d), 'TEST_COMMIT_PARENTS_REQUIRED')
            git(['--git-dir', gd, 'rev-list', '--objects', '--quiet', '--all'], timeout=600)  # full closure of every sealed tip
        else:
            cand = f'{target}/candidate'
            need(git(['-C', cand, 'rev-parse', '--verify', 'HEAD^{commit}']).strip() == d['testSha'], 'CANDIDATE_HEAD_CHANGED')
            if test:
                # The same parents check as the mirror store's, on this candidate's own copy of S (review n1).
                need(test_parents_ok(git(['-C', cand, 'rev-list', '--parents', '-n', '1', d['testSha']]).strip(), d), 'TEST_COMMIT_PARENTS_REQUIRED')
            need(git(['-C', cand, 'status', '--porcelain=v1', '--untracked-files=all']).strip() == '', 'CANDIDATE_NOT_CLEAN')
            for c in (d['headSha'], d['baseSha']):
                need(git(['-C', cand, 'cat-file', '-t', c]).strip() == 'commit', 'HEAD_BASE_COMMIT_MISSING')
            tree_modes_regular(git(['-C', cand, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD']))
            facts[role] = {'treeSha': git(['-C', cand, 'rev-parse', 'HEAD^{tree}']).strip()}
    live_preconditions(list(jobs.values()))
    result = {'contract': 'clued.independent-ci.resident-wsprep-receipt/1', 'status': 'RESIDENT_WORKSPACES_PREPARED', 'batchId': batch_id, 'descriptorSha256': descriptor_sha,
              'bundleSha256': receipt['bundleSha256'], 'refListSha256': receipt['refListSha256'], 'jobIds': jobs, 'workspaces': targets, 'facts': facts,
              'runsTouched': False, 'formalSpoolTouched': False, 'dockerUsed': False, 'networkUsed': False, 'workerStarted': False, 'secretsRead': False,
              'checksWritten': False, 'automaticRetryAllowed': False}
    write_new(f'{prep}/receipt.json', result)
    return result


def main(argv):
    need(len(argv) == 2 and argv[0] == '--batch', 'FIXED_SCOPE_REQUIRED')
    return prepare(argv[1])


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1:]), sort_keys=True))
        sys.exit(0)
    except Refused as e:
        print(json.dumps({'status': 'REFUSED', 'code': e.code, 'sourceLine': e.line}))
        sys.exit(1)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        print(json.dumps({'status': 'REFUSED', 'code': 'WORKSPACE_PREPARATION_UNCONFIRMED', 'kind': type(e).__name__}))
        sys.exit(1)
