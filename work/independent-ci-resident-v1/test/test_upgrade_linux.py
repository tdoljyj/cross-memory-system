"""Offline tests of linux/bin/clued-ci-upgrade-linux (task 018da927 B3). Every path constant is redirected into a temporary
directory that stands for '/'; nothing touches /opt, /etc, /var/lib or systemd, nothing runs as root, no real key is read.
Windows:  python -B -m unittest discover -s test -p "test_upgrade_linux.py"   (from work/independent-ci-resident-v1)
WSL user: python3 -B -m unittest discover -s test -p test_upgrade_linux.py     (renameat2 and POSIX modes are exercised there)
"""
import copy
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
R = HERE.parent
TOOL = R / 'linux' / 'bin' / 'clued-ci-upgrade-linux'
SIGNER = R / 'linux' / 'bin' / 'clued-ci-sign-qualification-v2.mjs'
loader = importlib.machinery.SourceFileLoader('upgrade_linux', str(TOOL))
spec = importlib.util.spec_from_loader('upgrade_linux', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)

GIT = shutil.which('git')
NODE = shutil.which('node')
BASH = shutil.which('bash')
CI = tool.CI
ROLES = tool.ROLES
UNITS = tool.UNITS
OP1 = '11111111-1111-4111-8111-111111111111'
OP2 = '22222222-2222-4222-8222-222222222222'
PKG1 = '1' * 64
HOST_REF = 'f6aafe6e-738a-4e9d-9448-04bdbc0f78bc'
REF = {'A': 'aaaaaaaa-0000-4000-8000-00000000000a', 'B': 'bbbbbbbb-0000-4000-8000-00000000000b'}
NOW = '2026-10-29T00:00:00.000Z'
GIT_ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@x',
           'GIT_AUTHOR_DATE': '2026-10-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2026-10-01T00:00:00Z', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
ENTRY = CI + 'worker/protected-job-bridge-v4/linux-worker.mjs'
SOURCE = {
    'A': {CI + 'worker/qualification-v2.mjs': b'// qualification A\n', CI + 'src/worker-v2.mjs': b'// worker A\n', CI + 'src/proof.mjs': b'// proof\n',
          CI + 'src/job-v2.mjs': b'// job\n', ENTRY: b'// entry A\n', 'scripts/ci/clued-work-admission.mjs': b'// evaluator\n'},
}
SOURCE['B'] = {**SOURCE['A'], CI + 'worker/qualification-v2.mjs': b'// qualification B\n', CI + 'src/worker-v2.mjs': b'// worker B\n', ENTRY: b'// entry B\n'}
HOST_FILES = {'/usr/bin/docker': b'docker', '/usr/bin/git': b'git', tool.PRODUCTION['node']: b'pinned node'}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def write(path, data, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    if mode is not None:
        os.chmod(path, mode)


def rmtree(path):
    def onexc(func, p, _exc):
        os.chmod(p, stat.S_IWRITE)
        func(p)
    if os.path.lexists(path):
        shutil.rmtree(path, onexc=onexc) if sys.version_info >= (3, 12) else shutil.rmtree(path, onerror=lambda f, p, e: onexc(f, p, e))


def git(*args, cwd=None):
    return subprocess.run([GIT, *args], cwd=cwd, env=GIT_ENV, check=True, capture_output=True, text=True).stdout.strip()


def source_manifest(commit, version):
    pins = [{'path': p, 'sha256': sha(d)} for p, d in sorted(SOURCE[version].items())]
    relay = {'contract': 'clued.independent-ci.protected-os-relay/2', 'sourceAcceptanceRef': REF[version], 'hostQualificationRef': HOST_REF}
    roles = {r: {'sourceFiles': pins, 'controllerRelay': relay} for r in ROLES + ('work-admission',)}
    return tool.canonical_bytes({'schema': 'independent-ci.sources.v2', 'repo': 'tdoljyj/cross-memory-system', 'sourceSha': commit, 'roles': roles})


def policy_of(role, version, manifest_sha):
    node_entry = role == 'contract-placement'
    files = SOURCE[version]
    p = {'schema': 'independent-ci.linux-policy.v3', 'role': role, 'formalEnabled': True, 'runtimeIdentity': 'TEST-ubuntu24-independent-ci-v1', 'keyId': 'test-key-1',
         'image': 'sha256:' + sha(b'img-' + role.encode()), 'executionMode': 'node-entry' if node_entry else 'scanner',
         'dockerExecutable': '/usr/bin/docker', 'dockerEndpoint': 'unix:///run/docker.sock', 'dockerExecutableSha256': sha(HOST_FILES['/usr/bin/docker']),
         'dockerRootDirectory': '/var/lib/docker', 'containerUser': '65532:65532', 'memoryBytes': 2147483648, 'cpus': 2, 'pids': 128,
         'nodeExecutable': tool.PRODUCTION['node'], 'nodeExecutableSha256': sha(HOST_FILES[tool.PRODUCTION['node']]),
         'gitExecutable': '/usr/bin/git', 'gitExecutableSha256': sha(HOST_FILES['/usr/bin/git']),
         'entryFile': tool.PRODUCTION['source'] + '/' + ENTRY, 'sourceManifestFile': tool.PRODUCTION['manifest'],
         'publicKeyFile': '/etc/clued-independent-ci/verify-result-public.pem', 'signingKeyFile': '/etc/clued-independent-ci/verify-result-key.pem',
         'qualificationFile': f"{tool.PRODUCTION['roles']}/{role}.qualification.json", 'workspaceRoot': '/var/lib/clued-independent-ci/workspaces',
         'runsRoot': '/var/lib/clued-independent-ci/runs', 'trustedSourceDirectory': tool.PRODUCTION['source'],
         'hostAcceptanceRef': HOST_REF, 'sourceAcceptanceRef': REF[version], 'sourceManifestSha256': manifest_sha,
         'entrySha256': sha(files[ENTRY]), **{k: sha(files[rel]) for k, rel in tool.PIN_FILES.items()}}
    if node_entry:
        p.update({'containerNodeExecutable': '/usr/local/bin/node', 'containerNodeSha256': sha(b'container-node')})
    return p


def payload_of(policy, pub_sha, qualified_at=None):
    p = {'schema': 'independent-ci.runtime-qualification.v2', 'fixture': False, 'role': policy['role'], 'qualifiedAt': qualified_at, 'expiresAt': None,
         'resultPublicKeySha256': pub_sha, 'isolation': 'root-managed-single-job-container', 'prCannotReadSignerKey': True, 'noControllerMounts': True,
         'noCredentials': True, 'networkDisabled': True, 'cleanupQualified': True, **{k: policy[k] for k in tool.BIND}}
    if policy['executionMode'] == 'node-entry':
        p.update({'containerNodeExecutable': policy['containerNodeExecutable'], 'containerNodeSha256': policy['containerNodeSha256']})
    return p


class Crash(Exception):
    """Stands for the process dying in the middle of a step."""


class FakeHost:
    as_root = False

    def __init__(self):
        self.quiet = {'linuxUnitsInactive': True, 'containersZero': True, 'details': {}}
        self.reloads = 0
        self.ready = {r: True for r in ROLES}
        self.sign_impl = None

    def now(self):
        return NOW

    def quiescence(self):
        return self.quiet

    def daemon_reload(self):
        self.reloads += 1
        return True

    def readiness(self):
        return self.ready

    def sign(self, in_dir, out_dir, policy_sha256):
        if self.sign_impl:
            return self.sign_impl(in_dir, out_dir, policy_sha256)
        os.mkdir(out_dir, 0o700)
        roles = {}
        for role in ROLES:
            policy = pathlib.Path(f'{in_dir}/{role}.json').read_bytes()
            assert sha(policy) == policy_sha256[role]
            payload = json.loads(pathlib.Path(f'{in_dir}/{role}.qualification.payload.json').read_bytes())
            write(f'{out_dir}/{role}.json', policy, 0o600)
            q = tool.canonical_bytes({'payload': {**payload, 'qualifiedAt': NOW}, 'signature': 'c2lnbmVk'})
            write(f'{out_dir}/{role}.qualification.json', q, 0o600)
            roles[role] = {'policySha256': sha(policy)}
        return {'status': 'QUALIFICATIONS_V2_SIGNED', 'roles': roles}


def counting(limit=None, log=None):
    """A rename that counts calls and dies (before renaming) at call number `limit`."""
    state = {'n': 0}

    def rename(src, dst):
        if limit is not None and state['n'] == limit:
            raise Crash(state['n'])
        state['n'] += 1
        if log is not None:
            log.append((os.path.basename(src), os.path.basename(dst)))
        return tool.rename_noreplace(src, dst)
    rename.state = state
    return rename


def snapshot(root):
    """Everything under the fake '/', comparable across two worlds: file bytes (state JSON without dev/ino), directory
    names; .git internals only by presence (their config names the absolute bundle path)."""
    out = {}

    def strip(v):
        if isinstance(v, dict):
            return {k: strip(x) for k, x in v.items() if k not in ('dev', 'ino')}
        if isinstance(v, list):
            return [strip(x) for x in v]
        return v
    for base, dirs, files in os.walk(root):
        rel = os.path.relpath(base, root).replace(os.sep, '/')
        if '.git' in dirs:
            out[f'{rel}/.git'] = 'git'
            dirs.remove('.git')
        dirs.sort()
        for d in dirs:
            out[f'{rel}/{d}'] = 'dir'
        for f in files:
            if f == '.tool.lock':
                continue
            data = pathlib.Path(os.path.join(base, f)).read_bytes()
            if f.endswith('.json') and '/var/lib/clued-independent-ci/resident/upgrade' in f'/{rel}':
                data = json.dumps(strip(json.loads(data)), sort_keys=True).encode()
            out[f'{rel}/{f}'] = sha(data)
    return out


@unittest.skipIf(GIT is None, 'git not available')
class World(unittest.TestCase):
    """A template '/' with generation 1 live (Source A), built once; every test works on its own copy."""

    @classmethod
    def setUpClass(cls):
        cls.tmpl = tempfile.mkdtemp(prefix='clued-upg-tmpl-')
        repo = os.path.join(cls.tmpl, 'repo')
        os.makedirs(repo)
        git('init', '-q', cwd=repo)
        cls.commit = {}
        for v in ('A', 'B'):
            for rel, data in SOURCE[v].items():
                write(os.path.join(repo, *rel.split('/')), data)
            git('add', '-A', cwd=repo)
            git('commit', '-q', '-m', v, cwd=repo)
            cls.commit[v] = git('rev-parse', 'HEAD', cwd=repo)
        cls.bundle = os.path.join(cls.tmpl, 'source.bundle')
        git('bundle', 'create', cls.bundle, 'HEAD', cwd=repo)
        cls.manifest = {v: source_manifest(cls.commit[v], v) for v in ('A', 'B')}
        root = os.path.join(cls.tmpl, 'root')
        P = tool.paths(root)
        cls.pub_sha = sha(b'test public key')
        # live generation 1
        src = P['source']
        git('clone', '-q', '--no-checkout', repo, src)
        git('-C', src, 'checkout', '-q', '--detach', cls.commit['A'])
        write(P['manifest'], cls.manifest['A'])
        for role in ROLES:
            pol = policy_of(role, 'A', sha(cls.manifest['A']))
            write(f"{P['roles']}/{role}.json", tool.canonical_bytes(pol), 0o600)
            write(f"{P['roles']}/{role}.qualification.json", tool.canonical_bytes({'payload': payload_of(pol, cls.pub_sha, '2026-10-26T06:01:53.209Z'),
                                                                                   'signature': 'c2lnbmVk'}), 0o600)
        for p, data in HOST_FILES.items():
            write(root + p, data)
        cls.resident_files(P, 'resident v1', 'A', lambda rel: P['prefix'] + rel)
        write(P['tool'], TOOL.read_bytes(), 0o755)
        write(P['signer'], SIGNER.read_bytes(), 0o644)
        write(P['upgrade'] + '/manifest.json', cls.upgrade_manifest())

    @classmethod
    def tearDownClass(cls):
        rmtree(cls.tmpl)

    @staticmethod
    def upgrade_manifest():
        return tool.canonical_bytes({'contract': tool.UPGRADE_TOOL_MANIFEST_CONTRACT, 'files': [
            {'installedPath': tool.PRODUCTION['upgrade'] + '/bin/' + tool.TOOL_NAME, 'sha256': sha(TOOL.read_bytes())},
            {'installedPath': tool.PRODUCTION['upgrade'] + '/bin/' + tool.SIGNER_NAME, 'sha256': sha(SIGNER.read_bytes())}]})

    @classmethod
    def resident_texts(cls, text, version):
        """The resident-linux files of one package: the tool, three units, and the manifest pinning them plus the external entries."""
        files = {'linux/bin/clued-ci-resident-linux': f'#!/usr/bin/python3.12 -I\n# {text}\n'.encode()}
        for u in UNITS:
            files[f'linux/systemd/{u}'] = f'[Unit]\nDescription={u} {text}\n'.encode()
        pins = [{'installedPath': tool.PRODUCTION['resident'] + '/bin/clued-ci-resident-linux', 'sha256': sha(files['linux/bin/clued-ci-resident-linux'])}]
        pins += [{'installedPath': f"{tool.PRODUCTION['units']}/{u}", 'sha256': sha(files[f'linux/systemd/{u}'])} for u in UNITS]
        pins += [{'installedPath': tool.PRODUCTION['node'], 'sha256': sha(HOST_FILES[tool.PRODUCTION['node']])},
                 {'installedPath': tool.PRODUCTION['source'] + '/' + ENTRY, 'sha256': sha(SOURCE[version][ENTRY])}]
        files['linux/manifest.json'] = tool.canonical_bytes({'contract': tool.LINUX_MANIFEST_CONTRACT, 'files': pins})
        return files

    @classmethod
    def resident_files(cls, P, text, version, at):
        for rel, data in cls.resident_texts(text, version).items():
            item = tool.RESIDENT_FILES[rel][0]
            write(tool.live_item(P, item) if item.startswith('units/') else P['resident'] + item[len('resident-v1'):], data)

    # ---- per test ----
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='clued-upg-')
        self.addCleanup(rmtree, self.tmp)
        self.root = os.path.join(self.tmp, 'root')
        shutil.copytree(os.path.join(self.tmpl, 'root'), self.root, symlinks=True)
        self.P = tool.paths(self.root)
        self.P['git'] = GIT
        self.host = FakeHost()
        r = tool.adopt(self.P, self.host, 1, PKG1)
        self.assertEqual(r['status'], 'LINUX_GENERATION_ADOPTED')

    def derived_sha(self, role, version='B'):
        """Independent of the tool: the installed policy with only the seven Source binding values replaced."""
        pol = json.loads(pathlib.Path(f"{self.P['roles']}/{role}.json").read_bytes())
        files = SOURCE[version]
        pol.update({'sourceManifestSha256': sha(self.manifest[version]), 'entrySha256': sha(files[ENTRY]), 'sourceAcceptanceRef': REF[version],
                    **{k: sha(files[rel]) for k, rel in tool.PIN_FILES.items()}})
        return sha(tool.canonical_bytes(pol))

    def package(self, text='resident v2', source='B', derived=None, extra=None, mutate=None, corrupt=None):
        """Write a package /4 under the staged prefix; returns (packageManifestSha256, linuxManifestSha256)."""
        work = os.path.join(self.tmp, 'pkg-work')
        rmtree(work)
        files = self.resident_texts(text, source or 'A')
        files.update(extra or {})
        lx_files = [{'path': p, 'sha256': sha(d), 'bytes': len(d)} for p, d in sorted(files.items())]
        for p, d in files.items():
            write(os.path.join(work, *p.split('/')), d)
        m = {'contract': tool.PACKAGE_CONTRACT, 'ciSourceManifestSha256': sha(self.manifest[source or 'A']), 'files': [],
             'acceptance': {'decisionRef': REF['B']}, 'windowsLayout': 'clued.independent-ci.resident-layout/1',
             'linux': {'manifestSha256': sha(files['linux/manifest.json']), 'sourceV2': None, 'files': lx_files}}
        if source:
            bundle = pathlib.Path(self.bundle).read_bytes()
            write(os.path.join(work, 'linux', 'source-v2.bundle'), bundle)
            write(os.path.join(work, 'record', 'source-manifest.json'), self.manifest[source])
            m['files'] = [{'path': 'record/source-manifest.json', 'target': 'record\\source-manifest.json', 'sha256': sha(self.manifest[source])}]
            m['linux']['sourceV2'] = {'commit': self.commit[source], 'bundlePath': 'linux/source-v2.bundle', 'bundleSha256': sha(bundle),
                                      'rolesDerivedSha256': derived or {r: self.derived_sha(r, source) for r in ROLES}}
        if mutate:
            mutate(m)
        raw = tool.canonical_bytes(m)
        write(os.path.join(work, 'package-manifest.json'), raw)
        if corrupt:
            corrupt(work)
        dst = f"{self.P['packages']}/{sha(raw)}"
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        rmtree(dst)
        shutil.move(work, dst)
        return sha(raw), m['linux']['manifestSha256']

    def staged(self, op=OP2, gen=2, **kw):
        pkg, lm = self.package(**kw)
        return tool.stage(self.P, self.host, op, pkg, gen, lm), pkg, lm

    def live_idents(self):
        return {n: tool.ident(tool.live_item(self.P, n)) for n, _, _ in tool.ITEMS}

    def refused(self, code, fn, *a, **kw):
        with self.assertRaises(tool.Refused) as cm:
            fn(*a, **kw)
        self.assertEqual(cm.exception.code, code, cm.exception.detail)
        return cm.exception


class StageTests(World):
    def test_out_of_bounds_paths_and_arguments_are_refused(self):
        for bad in ('linux/../../etc/shadow', '/etc/shadow', 'linux/bin/other-tool', 'linux/systemd/evil@.service'):
            pkg, lm = self.package(extra={}, mutate=lambda m, bad=bad: m['linux']['files'].append({'path': bad, 'sha256': '0' * 64, 'bytes': 1}))
            self.refused('TARGET_OUTSIDE_WHITELIST', tool.stage, self.P, self.host, OP2, pkg, 2, lm)
        pkg, lm = self.package(mutate=lambda m: m['linux']['sourceV2'].update(bundlePath='../source.bundle'))
        self.refused('TARGET_OUTSIDE_WHITELIST', tool.stage, self.P, self.host, OP2, pkg, 2, lm)
        for argv in (['stage', '--op', OP2, '--package', '../' + '0' * 61, '--generation', '2', '--linux-manifest', '0' * 64],
                     ['stage', '--op', 'x', '--package', '0' * 64, '--generation', '2', '--linux-manifest', '0' * 64],
                     ['switch', '--op', OP2, '--from', '1', '--to', '2'], ['verify', '--generation', '0'], ['shell'], []):
            code, out = tool.main(argv, P=self.P, host=self.host, root_check=lambda: True)
            self.assertEqual((code, out['code']), (1, 'USAGE_REFUSED'), argv)
        self.assertFalse(os.path.lexists(tool.gen_record_path(self.P, 2)))

    def test_staged_bytes_that_do_not_match_their_hash_are_refused(self):
        pkg, lm = self.package(corrupt=lambda w: write(os.path.join(w, 'linux', 'systemd', UNITS[0]), b'changed after review'))
        self.refused('PACKAGE_CHANGED', tool.stage, self.P, self.host, OP2, pkg, 2, lm)
        pkg, lm = self.package(corrupt=lambda w: write(os.path.join(w, 'linux', 'source-v2.bundle'), b'not the bundle'))
        self.refused('PACKAGE_CHANGED', tool.stage, self.P, self.host, OP2, pkg, 2, lm)
        pkg, lm = self.package()
        with open(f"{self.P['packages']}/{pkg}/package-manifest.json", 'ab') as f:
            f.write(b' ')
        self.refused('PACKAGE_CHANGED', tool.stage, self.P, self.host, OP2, pkg, 2, lm)
        pkg, lm = self.package()
        self.refused('LINUX_MANIFEST_NOT_THE_REQUESTED_ONE', tool.stage, self.P, self.host, OP2, pkg, 2, '0' * 64)
        self.assertFalse(os.path.lexists(tool.gen_record_path(self.P, 2)), 'no commit point')

    def test_derived_roles_must_equal_the_package_declaration(self):
        wrong = {r: self.derived_sha(r) for r in ROLES}
        wrong['trivy'] = '0' * 64
        e = self.refused('ROLES_DERIVED_MISMATCH', self.staged, derived=wrong)
        self.assertEqual(e.detail['derived'], self.derived_sha('trivy'))
        self.assertFalse(os.path.lexists(tool.gen_record_path(self.P, 2)))

    def test_derivation_changes_only_the_source_binding_and_signs_what_was_derived(self):
        r, _, _ = self.staged()
        self.assertEqual(r['status'], 'LINUX_STAGED')
        nd = tool.next_dir(self.P, OP2)
        for role in ROLES:
            old = json.loads(pathlib.Path(f"{self.P['roles']}/{role}.json").read_bytes())
            new = json.loads(pathlib.Path(f'{nd}/roles-v3/{role}.json').read_bytes())
            # proof.mjs and job-v2.mjs are the same bytes in both commits: only five of the seven binding values move
            self.assertEqual(sorted(k for k in old if old[k] != new[k]),
                             sorted(['sourceManifestSha256', 'entrySha256', 'qualificationSha256', 'workerSha256', 'sourceAcceptanceRef']))
            self.assertEqual(r['roles'][role]['policySha256'], self.derived_sha(role))
            q = json.loads(pathlib.Path(f'{nd}/roles-v3/{role}.qualification.json').read_bytes())['payload']
            self.assertEqual({k: q[k] for k in tool.BIND}, {k: new[k] for k in tool.BIND})
        self.assertEqual(tool.head_commit(f'{nd}/source-v2'), self.commit['B'])
        self.assertEqual(pathlib.Path(f'{nd}/formal-source-manifest-v2.json').read_bytes(), self.manifest['B'])
        rec = tool.read_gen(self.P, 2)
        self.assertEqual(rec['fromGeneration'], 1)
        self.assertTrue(all(rec['items'][n]['switched'] for n, _, _ in tool.ITEMS))
        if os.name == 'posix':
            self.assertEqual(os.stat(f'{nd}/roles-v3').st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(f'{nd}/roles-v3/gitleaks.json').st_mode & 0o777, 0o600)

    def test_host_facts_and_the_frozen_channel_are_not_changed_by_an_upgrade(self):
        write(self.root + '/usr/bin/docker', b'another docker')
        self.refused('LINUX_HOST_FACTS_CHANGED', self.staged)
        write(self.root + '/usr/bin/docker', HOST_FILES['/usr/bin/docker'])
        self.refused('CHANNEL_CHANGE_NEEDS_REINSTALL', self.staged, extra={'linux/upgrade-v1/bin/clued-ci-upgrade-linux': b'# a newer tool\n'})
        r, _, _ = self.staged(extra={'linux/upgrade-v1/bin/clued-ci-upgrade-linux': TOOL.read_bytes(), 'linux/upgrade-v1/manifest.json': self.upgrade_manifest()})
        self.assertEqual(r['status'], 'LINUX_STAGED')

    def test_stage_resumes_by_re_observation(self):
        def broken(*_a):
            raise Crash('signer died')
        self.host.sign_impl = broken
        with self.assertRaises(Crash):
            self.staged()
        self.assertTrue(os.path.isdir(tool.next_dir(self.P, OP2)))
        self.assertFalse(os.path.lexists(tool.gen_record_path(self.P, 2)))
        self.host.sign_impl = None
        r, pkg, lm = self.staged()
        self.assertTrue(r['movedAsidePartial'])
        self.assertTrue(os.path.isdir(f"{self.P['archive']}/next-{OP2}-partial"), 'kept, not deleted')
        again = tool.stage(self.P, self.host, OP2, pkg, 2, lm)
        self.assertTrue(again['replayed'])
        self.refused('GENERATION_ALREADY_USED', tool.stage, self.P, self.host, OP2, pkg, 2, '0' * 64)
        self.refused('GENERATION_NOT_NEXT', tool.stage, self.P, self.host, OP1, pkg, 3, lm)


class SwitchTests(World):
    def switched(self):
        r, pkg, lm = self.staged()
        return tool.switch(self.P, self.host, OP2, 1, 2, lm), pkg, lm

    def test_parse_accepts_every_subcommand_shape(self):
        # Each argv the upgrader sends (upgrade-mailbox.mjs#upgradeToolArgs) goes through the real parser; version-facts
        # takes no argument at all (an empty SPEC entry once made it refuse every call).
        op, sha = '0' * 8 + '-0000-4000-8000-' + '0' * 12, 'a' * 64
        cases = [['version-facts'], ['stage', '--op', op, '--package', sha, '--generation', '2', '--linux-manifest', sha],
                 ['switch', '--op', op, '--from', '1', '--to', '2', '--linux-manifest', sha], ['rollback', '--op', op, '--from', '2', '--to', '1'],
                 ['verify', '--generation', '2', '--op', op], ['retain', '--op', op, '--keep', '3', '--generation', '2']]
        for argv in cases:
            self.assertEqual(tool.parse(argv)[0], argv[0], argv)
        with self.assertRaises(tool.Refused):
            tool.parse(['version-facts', '--op', op])

    def test_switch_verify_and_version_facts(self):
        before = self.live_idents()
        r, pkg, lm = self.switched()
        self.assertEqual((r['status'], r['replayed']), ('LINUX_SWITCHED', False))
        if sys.platform.startswith('linux'):
            self.assertEqual(r['renameMode'], ['renameat2'])
        rec2 = tool.read_gen(self.P, 2)
        for n, _, _ in tool.ITEMS:
            self.assertTrue(tool.same(tool.ident(tool.live_item(self.P, n)), rec2['items'][n]), n)
            self.assertTrue(tool.same(tool.ident(f'{tool.gen_dir(self.P, 1)}/{n}'), before[n]), 'the old item is parked, same inode')
        self.assertEqual(tool.read_current(self.P)['generation'], 2)
        self.assertFalse(os.path.lexists(tool.next_dir(self.P, OP2)))
        self.assertTrue(os.path.isdir(f"{self.P['archive']}/next-{OP2}"))
        self.assertEqual(self.host.reloads, 1)
        v = tool.verify(self.P, self.host, 2)
        self.assertTrue(all(v['checks'].values()))
        f = tool.version_facts(self.P, self.host)
        self.assertEqual(sorted(f), sorted(['contract', 'generation', 'ciSourceManifestSha256', 'sourceCommit', 'manifestSha256', 'roles', 'pinsOk', 'staged',
                                            'upgradeToolSha256', 'observedAt']))
        self.assertEqual((f['generation'], f['sourceCommit'], f['ciSourceManifestSha256'], f['manifestSha256'], f['pinsOk'], f['staged']),
                         (2, self.commit['B'], sha(self.manifest['B']), lm, True, None))
        self.assertEqual(f['upgradeToolSha256'], sha(TOOL.read_bytes()))
        again = tool.switch(self.P, self.host, OP2, 1, 2, lm)
        self.assertTrue(again['replayed'])

    def test_version_facts_reports_a_pending_stage(self):
        self.staged()
        f = tool.version_facts(self.P, self.host)
        self.assertEqual((f['generation'], f['staged']), (1, {'opId': OP2, 'generation': 2}))

    def test_switch_refuses_without_quiescence_and_moves_nothing(self):
        _, pkg, lm = self.staged()
        before = snapshot(self.root)
        self.host.quiet = {'linuxUnitsInactive': False, 'containersZero': True, 'details': {'busyUnits': ['clued-ci-worker@x.service']}}
        code, out = tool.main(['switch', '--op', OP2, '--from', '1', '--to', '2', '--linux-manifest', lm], P=self.P, host=self.host, root_check=lambda: True)
        self.assertEqual((code, out['code'], out['upgradeCode']), (1, 'LINUX_QUIESCENCE_UNCONFIRMED', 'UPGRADE_LINUX_QUIESCENCE_UNCONFIRMED'))
        self.assertEqual(snapshot(self.root), before)
        self.host.quiet = {'linuxUnitsInactive': True, 'containersZero': False, 'details': {}}
        self.refused('LINUX_QUIESCENCE_UNCONFIRMED', tool.switch, self.P, self.host, OP2, 1, 2, lm)
        self.assertEqual(self.host.reloads, 0)

    def test_an_unexplainable_layout_is_inconsistent_and_nothing_moves(self):
        _, pkg, lm = self.staged()
        os.makedirs(f'{tool.gen_dir(self.P, 1)}/units', exist_ok=True)
        write(f'{tool.gen_dir(self.P, 1)}/units/{UNITS[1]}', b'someone else')
        before = snapshot(self.root)
        e = self.refused('JOURNAL_INCONSISTENT', tool.switch, self.P, self.host, OP2, 1, 2, lm)
        self.assertEqual(e.detail['items'], [f'units/{UNITS[1]}'])
        self.assertEqual(snapshot(self.root), before)

    def test_a_crash_at_every_rename_resumes_to_the_uninterrupted_result(self):
        reference = None
        log = []
        _, pkg, lm = self.staged()
        tool.switch(self.P, self.host, OP2, 1, 2, lm, rename=counting(log=log))
        reference = snapshot(self.root)
        self.assertEqual(len(log), 2 * len(tool.ITEMS) + 1, log)
        for k in range(len(log)):
            with self.subTest(crash_at=k):
                self.setUp()
                _, pkg, lm = self.staged()
                with self.assertRaises(Crash):
                    tool.switch(self.P, self.host, OP2, 1, 2, lm, rename=counting(limit=k))
                r = tool.switch(self.P, self.host, OP2, 1, 2, lm)
                self.assertEqual(r['status'], 'LINUX_SWITCHED')
                self.assertEqual(snapshot(self.root), reference)


class RollbackTests(World):
    def test_rollback_after_a_complete_switch(self):
        before = self.live_idents()
        _, pkg, lm = self.staged()
        tool.switch(self.P, self.host, OP2, 1, 2, lm)
        r = tool.rollback(self.P, self.host, OP2, 2, 1)
        self.assertEqual((r['status'], r['replayed']), ('LINUX_ROLLED_BACK', False))
        self.assertEqual(self.live_idents(), before)
        cur = tool.read_current(self.P)
        self.assertEqual((cur['generation'], cur['rolledBackFrom'], cur['opId']), (1, 2, OP2))
        rec2 = tool.read_gen(self.P, 2)
        for n, _, _ in tool.ITEMS:
            self.assertTrue(tool.same(tool.ident(f'{tool.gen_dir(self.P, 2)}/{n}'), rec2['items'][n]), 'the given-up generation is kept')
        self.assertTrue(all(tool.verify(self.P, self.host, 1)['checks'].values()))
        self.assertTrue(tool.rollback(self.P, self.host, OP2, 2, 1)['replayed'])
        self.assertIsNone(tool.version_facts(self.P, self.host)['staged'])
        # The given-up number is staged again by the next op; the old one is renamed into the archive first.
        op3 = '33333333-3333-4333-8333-333333333333'
        pkg3, lm3 = self.package(text='resident v2 bis')
        r3 = tool.stage(self.P, self.host, op3, pkg3, 2, lm3)
        self.assertEqual(sorted(r3['givenUpKeptAs']), sorted([f'g2-given-up-{OP2}']))
        self.assertTrue(os.path.isfile(f"{self.P['state']}/given-up/g2-{OP2}.json"))
        self.assertEqual(tool.switch(self.P, self.host, op3, 1, 2, lm3)['status'], 'LINUX_SWITCHED')

    def test_rollback_after_a_switch_interrupted_anywhere(self):
        for k in (0, 1, 2, 5, 9, 14):
            with self.subTest(crash_at=k):
                self.setUp()
                before = self.live_idents()
                _, pkg, lm = self.staged()
                with self.assertRaises(Crash):
                    tool.switch(self.P, self.host, OP2, 1, 2, lm, rename=counting(limit=k))
                r = tool.rollback(self.P, self.host, OP2, 2, 1)
                self.assertEqual(r['status'], 'LINUX_ROLLED_BACK')
                self.assertEqual(self.live_idents(), before)
                self.assertTrue(all(tool.verify(self.P, self.host, 1)['checks'].values()))

    def test_a_crash_at_every_rollback_rename_resumes_to_the_uninterrupted_result(self):
        log = []
        _, pkg, lm = self.staged()
        tool.switch(self.P, self.host, OP2, 1, 2, lm)
        tool.rollback(self.P, self.host, OP2, 2, 1, rename=counting(log=log))
        reference = snapshot(self.root)
        self.assertEqual(len(log), 2 * len(tool.ITEMS))
        for k in range(len(log)):
            with self.subTest(crash_at=k):
                self.setUp()
                _, pkg, lm = self.staged()
                tool.switch(self.P, self.host, OP2, 1, 2, lm)
                with self.assertRaises(Crash):
                    tool.rollback(self.P, self.host, OP2, 2, 1, rename=counting(limit=k))
                tool.rollback(self.P, self.host, OP2, 2, 1)
                self.assertEqual(snapshot(self.root), reference)

    def test_verify_fails_on_a_changed_live_file(self):
        _, pkg, lm = self.staged()
        tool.switch(self.P, self.host, OP2, 1, 2, lm)
        with open(f"{self.P['roles']}/trivy.json", 'ab') as f:
            f.write(b' ')
        e = self.refused('LINUX_GENERATION_NOT_VERIFIED', tool.verify, self.P, self.host, 2)
        self.assertIn('roles', e.detail['failed'])
        code, out = tool.main(['verify', '--op', OP2, '--generation', '2'], P=self.P, host=self.host, root_check=lambda: True)
        self.assertEqual((code, out['upgradeCode']), (1, 'UPGRADE_VERIFY_FAILED'))


class RetainTests(World):
    def test_the_fourth_generation_is_moved_never_deleted(self):
        files_before = None
        ops = [f'{d * 8}-{d * 4}-4{d * 3}-8{d * 3}-{d * 12}' for d in '23456']
        parked = {}
        for gen, op in zip(range(2, 6), ops):
            pkg, lm = self.package(text=f'resident r{gen}', source=None)
            self.assertEqual(tool.stage(self.P, self.host, op, pkg, gen, lm)['switched'], ['resident-v1'] + [f'units/{u}' for u in UNITS])
            tool.switch(self.P, self.host, op, gen - 1, gen, lm)
            parked[gen - 1] = tool.ident(f'{tool.gen_dir(self.P, gen - 1)}/resident-v1')
            self.assertTrue(all(tool.verify(self.P, self.host, gen)['checks'].values()))
            if gen == 4:
                files_before = sorted(v for k, v in snapshot(self.root).items() if v not in ('dir', 'git'))
                r = tool.retain(self.P, self.host, 3, 4, op)
                self.assertEqual((r['kept'], r['archived'], r['deleted']), ([2, 3], [{'from': 'generations/g1', 'to': 'archive/g1'}], 0))
                self.assertTrue(tool.same(tool.ident(f"{self.P['archive']}/g1/resident-v1"), parked[1]), 'renamed, same inode')
                self.assertEqual(sorted(v for k, v in snapshot(self.root).items() if v not in ('dir', 'git')), files_before, 'no byte lost')
        # the mailbox kind linux-upgrade-retain {keep} runs exactly: retain --op <opId> --keep <keep>
        self.assertEqual(tool.main(['retain', '--op', ops[3], '--keep', '1'], P=self.P, host=self.host, root_check=lambda: True)[1]['code'], 'USAGE_REFUSED')
        code, r = tool.main(['retain', '--op', ops[3], '--keep', '3'], P=self.P, host=self.host, root_check=lambda: True)
        self.assertEqual((code, r['status'], r['generation'], r['keep'], r['kept']), (0, 'LINUX_RETAINED', 5, 3, [3, 4]))
        self.assertEqual(sorted(os.listdir(self.P['archive'])), sorted(['g1', 'g2'] + [f'next-{op}' for op in ops[:4]]))


@unittest.skipIf(BASH is None, 'no bash')
class ReinstallTests(World):
    """Review M3: a full reinstall (the only way the frozen channel changes) numbers both halves from 1 again."""

    def uninstall(self, keep):
        """What uninstall-resident-linux.sh main() does, under the test prefix: units and resident-v1 by its own mv -n, then the
        script's keep_upgrade_channel function itself."""
        os.makedirs(f'{keep}/units')
        for u in UNITS:
            os.rename(tool.live_item(self.P, f'units/{u}'), f'{keep}/units/{u}')
        os.rename(self.P['resident'], f'{keep}/resident-v1')
        root = pathlib.Path(self.root).as_posix()
        call = ('source "$1"; CI_OPT="$2/opt/clued-independent-ci"; STATE="$2/var/lib/clued-independent-ci"; UPG="$CI_OPT/upgrade-v1"; '
                'GENS="$CI_OPT/generations"; ARCH="$CI_OPT/archive"; UPG_STATE="$STATE/resident/upgrade"; '
                'SAVED_PLANS="$STATE/resident/install-plan.json $STATE/resident/upgrade-v1-install-plan.json"; '
                'upgrade_channel_text; keep_upgrade_channel "$3"')
        return subprocess.run([BASH, '-c', call, 'x', (R / 'linux' / 'uninstall-resident-linux.sh').as_posix(), root, pathlib.Path(keep).as_posix()],
                              capture_output=True, text=True, timeout=120)

    def test_upgrade_to_g3_uninstall_reinstall_adopt_numbers_both_halves_from_1(self):
        for gen, op in ((2, OP1), (3, OP2)):
            pkg, lm = self.package(text=f'resident r{gen}', source=None)
            tool.stage(self.P, self.host, op, pkg, gen, lm)
            tool.switch(self.P, self.host, op, gen - 1, gen, lm)
        self.assertEqual(tool.read_current(self.P)['generation'], 3)
        pkg_re = '9' * 64
        e = self.refused('ALREADY_ADOPTED', tool.adopt, self.P, self.host, 1, pkg_re)
        self.assertEqual(e.detail['current'], 3)
        state_resident = f"{self.root}/var/lib/clued-independent-ci/resident"
        for name in ('install-plan.json', 'upgrade-v1-install-plan.json'):
            write(f'{state_resident}/{name}', b'{"planSha256":"x"}\n')
        keep = f"{self.root}/var/lib/clued-independent-ci/resident-uninstalled-T"
        r = self.uninstall(keep)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('generations=g1 g2', r.stdout)
        for p in (self.P['upgrade'], self.P['generations'], self.P['archive'], self.P['state'], f'{state_resident}/install-plan.json'):
            self.assertFalse(os.path.lexists(p), p)
        for p in ('upgrade-v1/manifest.json', 'generations/g1/resident-v1', 'generations/g2/resident-v1', f'opt-archive/next-{OP2}',
                  'upgrade-state/current.json', 'upgrade-state/g3.json', 'install-plan.json', 'upgrade-v1-install-plan.json'):
            self.assertTrue(os.path.lexists(f'{keep}/{p}'), f'kept, not deleted: {p}')
        # reinstall: fresh resident-linux files, units and the (frozen) upgrade tool, then --adopt-generation 1
        self.resident_files(self.P, 'resident reinstall', 'A', None)
        write(self.P['tool'], TOOL.read_bytes(), 0o755)
        write(self.P['signer'], SIGNER.read_bytes(), 0o644)
        write(self.P['upgrade'] + '/manifest.json', self.upgrade_manifest())
        os.makedirs(self.P['state'])
        write(f"{self.P['state']}/g2.json", b'{}')  # an old record that the uninstall did not move
        self.assertEqual(self.refused('STALE_UPGRADE_STATE_ARCHIVE_FIRST', tool.adopt, self.P, self.host, 1, pkg_re).detail['stale'], ['g2.json'])
        os.unlink(f"{self.P['state']}/g2.json")
        a = tool.adopt(self.P, self.host, 1, pkg_re)
        lm_re = sha(self.resident_texts('resident reinstall', 'A')['linux/manifest.json'])
        self.assertEqual((a['status'], a['replayed'], a['linuxManifestSha256']), ('LINUX_GENERATION_ADOPTED', False, lm_re))
        facts = tool.version_facts(self.P, self.host)
        self.assertEqual((facts['generation'], facts['manifestSha256'], facts['pinsOk'], facts['staged']), (1, lm_re, True, None))
        if NODE:  # the resident's own consistency function, with the reinstalled Windows half at g1
            current = {'contract': 'clued.independent-ci.resident-generation/1', 'generation': 1, 'packageManifestSha256': pkg_re, 'residentManifestSha256': '2' * 64,
                       'ciSourceManifestSha256': facts['ciSourceManifestSha256'], 'policySha256': '3' * 64, 'installReceiptSha256': '4' * 64,
                       'stateCompat': {'schema': 1, 'readableBySchemas': [1]}, 'opId': None, 'at': NOW,
                       'linux': {'generation': 1, 'manifestSha256': lm_re, 'ciSourceManifestSha256': facts['ciSourceManifestSha256']}}
            js = (f"import {{consistent}} from {json.dumps((R / 'src' / 'upgrade-mailbox.mjs').as_uri())};"
                  "const [c,f,n]=process.argv.slice(1);process.stdout.write(JSON.stringify(consistent(JSON.parse(c),JSON.parse(f),Date.parse(n))));")
            out = subprocess.run([NODE, '--input-type=module', '-e', js, json.dumps(current), json.dumps(facts), NOW], capture_output=True, text=True, timeout=60)
            self.assertEqual(out.stdout, 'true', out.stderr)
        # the renumbered channel upgrades again: g1 -> g2 parks into a fresh generations/g1
        op3 = '33333333-3333-4333-8333-333333333333'
        pkg, lm = self.package(text='after reinstall', source=None)
        tool.stage(self.P, self.host, op3, pkg, 2, lm)
        self.assertEqual(tool.switch(self.P, self.host, op3, 1, 2, lm)['generation'], 2)
        self.assertTrue(all(tool.verify(self.P, self.host, 2)['checks'].values()))


class Primitives(unittest.TestCase):
    def test_rename_never_replaces(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = os.path.join(d, 'a'), os.path.join(d, 'b')
            write(a, b'a')
            write(b, b'b')
            with self.assertRaises(tool.Refused):
                tool.rename_noreplace(a, b)
            self.assertEqual(pathlib.Path(b).read_bytes(), b'b')
            mode = tool.rename_noreplace(a, os.path.join(d, 'c'))
            self.assertEqual(mode, 'renameat2' if sys.platform.startswith('linux') else 'checked-rename')

    def test_the_command_line_requires_root_and_prints_one_json_line(self):
        r = subprocess.run([sys.executable, '-I', str(TOOL), 'version-facts'], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(len(r.stdout.splitlines()), 1)
        self.assertEqual(json.loads(r.stdout)['code'], 'ROOT_LINUX_REQUIRED')

    def test_quiescence_is_the_resident_tool_copy(self):
        res = (R / 'linux' / 'bin' / 'clued-ci-resident-linux').read_text(encoding='utf-8')
        up = TOOL.read_text(encoding='utf-8')
        body = re.search(r'def quiescence\(self_unit=None\):\n(?:    .*\n)+', res).group(0)
        self.assertIn(body, up)
        for fn in ('other_units_quiet', 'cgroup_unpopulated', 'containers_quiet', 'cgroup_events', 'nonce_containers', 'worker_processes'):
            self.assertIn(f'def {fn}(', up)


@unittest.skipIf(BASH is None, 'no bash')
class LinuxScripts(unittest.TestCase):
    def test_scripts_parse_and_the_upgrade_plan_binds_the_script_and_every_tool_file(self):
        for s in ('install-resident-linux.sh', 'verify-resident-linux.sh', 'uninstall-resident-linux.sh'):
            r = subprocess.run([BASH, '-n', (R / 'linux' / s).as_posix()], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
        with tempfile.TemporaryDirectory() as d:
            pkg = pathlib.Path(d)
            names = ['upgrade-v1/bin/clued-ci-upgrade-linux', 'upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs', 'upgrade-v1/manifest.json']
            for n in names:
                write(str(pkg / n), 'content of ' + n)
            script = (R / 'linux' / 'install-resident-linux.sh')
            r = subprocess.run([BASH, '-c', 'source "$1"; plan_upgrade_text "$2"', 'x', script.as_posix(), pkg.as_posix()], capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('install-script.sha256=' + sha(script.read_bytes()), r.stdout)
            for n in names:
                self.assertRegex(r.stdout, re.escape(sha(('content of ' + n).encode())) + r' [ *]' + re.escape(n))
        text = script.read_text(encoding='utf-8')
        apply = text[text.index('    --apply-upgrade-v1)'):text.index('    --adopt-generation)')]
        self.assertNotIn('$pkg/', apply.split('st=$(stage_copy_upgrade')[1], 'nothing is read from the package after staging')
        self.assertIn('adopt --generation 1 --package', text)


@unittest.skipIf(GIT is None or NODE is None, 'git or node not available')
class RealSigner(World):
    """The derivation of this tool and the signer's upgrade mode agree (the signer is run by node with a key generated for the test)."""

    def test_the_derived_roles_pass_the_signer_against_the_installed_v2_qualification(self):
        keys = json.loads(subprocess.run([NODE, '--input-type=module', '-e',
                                          "import {generateKeyPairSync} from 'node:crypto';const k=generateKeyPairSync('ed25519');"
                                          "process.stdout.write(JSON.stringify({key:k.privateKey.export({type:'pkcs8',format:'pem'}),"
                                          "pub:k.publicKey.export({type:'spki',format:'pem'})}))"], capture_output=True, text=True, check=True).stdout)
        kdir = os.path.join(self.tmp, 'keys')
        write(f'{kdir}/key.pem', keys['key'])
        write(f'{kdir}/pub.pem', keys['pub'])
        pub_sha = sha(keys['pub'].encode())
        sign_payload = ("import fs from 'node:fs';import {sign} from 'node:crypto';"
                        f"import {{canonicalJson}} from {json.dumps(SIGNER.as_uri())};"
                        "const [k,f]=process.argv.slice(1);const q=JSON.parse(fs.readFileSync(f));"
                        "q.signature=sign(null,Buffer.from(canonicalJson(q.payload)),fs.readFileSync(k)).toString('base64');"
                        "fs.writeFileSync(f,canonicalJson(q)+'\\n');")
        for role in ROLES:  # the installed v2 qualifications, signed by the test key
            f = f"{self.P['roles']}/{role}.qualification.json"
            q = json.loads(pathlib.Path(f).read_bytes())
            q['payload']['resultPublicKeySha256'] = pub_sha
            os.chmod(f, 0o600)
            write(f, tool.canonical_bytes(q))
            subprocess.run([NODE, '--input-type=module', '-e', sign_payload, f'{kdir}/key.pem', f], check=True, capture_output=True)
        # generation 1 was adopted before the re-signing: adopt again on a fresh state
        rmtree(self.P['state'])
        tool.adopt(self.P, self.host, 1, PKG1)
        sign_all = ("import fs from 'node:fs';"
                    f"import {{signAll}} from {json.dumps(SIGNER.as_uri())};"
                    "const [k,p,v2,i,o,s]=process.argv.slice(1);const shas=JSON.parse(s);"
                    "const r=signAll({keyPem:fs.readFileSync(k),pubPem:fs.readFileSync(p),v1Dir:'/nonexistent',inDir:i,outDir:o,against:{v2Dir:v2,policySha256:shas}});"
                    "process.stdout.write(JSON.stringify(r));")

        def real_sign(in_dir, out_dir, shas):
            p = subprocess.run([NODE, '--input-type=module', '-e', sign_all, f'{kdir}/key.pem', f'{kdir}/pub.pem', self.P['roles'], in_dir, out_dir, json.dumps(shas)],
                               capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)
        self.host.sign_impl = real_sign
        r, _, _ = self.staged()
        self.assertEqual(r['status'], 'LINUX_STAGED')
        for role in ROLES:
            self.assertEqual(r['roles'][role]['policySha256'], self.derived_sha(role))


if __name__ == '__main__':
    unittest.main()
