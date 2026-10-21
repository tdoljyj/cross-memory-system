"""Offline tests of linux/bin/clued-ci-install-source-v2 (run on any OS, temp directories only, never as root):
python -I -B -m unittest discover -s test -p "test_*.py" (from work/independent-ci-resident-v1)."""
import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = pathlib.Path(__file__).resolve().parent
loader = importlib.machinery.SourceFileLoader('install_source_v2', str(HERE.parent / 'linux' / 'bin' / 'clued-ci-install-source-v2'))
spec = importlib.util.spec_from_loader('install_source_v2', loader)
tool = importlib.util.module_from_spec(spec)
loader.exec_module(tool)
GIT = shutil.which('git')


def sha(b):
    return hashlib.sha256(b).hexdigest()


@unittest.skipIf(GIT is None, 'git not available')
class Package(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='clued-src-v2-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # A throwaway fixture repository, isolated from the user's git configuration (no hooks, no global config).
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@x', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@x',
               'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}
        self.src = os.path.join(self.tmp, 'checkout')
        os.makedirs(os.path.join(self.src, *tool.CI.rstrip('/').split('/'), 'worker'))
        files = {f'{tool.CI}worker/qualification-v2.mjs': b'export const x = 1;\n', 'scripts/ci/clued-work-admission.mjs': b'// evaluator\n'}
        for rel, data in files.items():
            os.makedirs(os.path.dirname(os.path.join(self.src, *rel.split('/'))), exist_ok=True)
            with open(os.path.join(self.src, *rel.split('/')), 'wb') as f:
                f.write(data)
        for args in (['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']):
            subprocess.run([GIT, '-C', self.src, *args], check=True, env=env, capture_output=True)
        self.commit = subprocess.run([GIT, '-C', self.src, 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
        pins = [{'path': p, 'sha256': sha(d)} for p, d in sorted(files.items())]
        manifest = {'schema': 'independent-ci.sources.v2', 'repo': 'tdoljyj/cross-memory-system', 'sourceSha': self.commit,
                    'roles': {r: {'sourceFiles': pins} for r in ('gitleaks', 'trivy', 'contract-placement', 'work-admission', 'control-admission', 'control-merge-slot')}}
        self.manifest_bytes = tool.canonical(manifest).encode()
        self.record = os.path.join(self.tmp, 'record')
        os.makedirs(self.record)
        with open(os.path.join(self.record, 'source-manifest.json'), 'wb') as f:
            f.write(self.manifest_bytes)
        self.roles = os.path.join(self.tmp, 'roles')
        os.makedirs(self.roles)
        for role in tool.ROLES:
            self.write_role(role)

    def write_role(self, role, **override):
        policy = {'schema': 'independent-ci.linux-policy.v3', 'role': role, 'formalEnabled': True, 'trustedSourceDirectory': tool.FIXED['trusted'],
                  'sourceManifestFile': tool.FIXED['manifest'], 'sourceManifestSha256': sha(self.manifest_bytes),
                  'qualificationFile': f"{tool.FIXED['roles']}/{role}.qualification.json", 'nodeExecutable': tool.FIXED['node'],
                  'entryFile': f"{tool.FIXED['trusted']}/{tool.CI}worker/protected-job-bridge-v4/linux-worker.mjs", **override}
        q = {'payload': {'schema': 'independent-ci.runtime-qualification.v2', 'role': role}, 'signature': 'AAAA'}
        with open(os.path.join(self.roles, f'{role}.json'), 'w') as f:
            f.write(json.dumps(policy))
        with open(os.path.join(self.roles, f'{role}.qualification.json'), 'w') as f:
            f.write(json.dumps(q))

    def build(self, name='pkg'):
        out = os.path.join(self.tmp, name)
        r = tool.build_package(self.record, self.src, self.roles, out, git_exe=GIT)
        self.assertEqual(r['status'], 'LINUX_SOURCE_V2_PACKAGE_WRITTEN')
        return out

    def host(self):
        h = os.path.join(self.tmp, 'host')
        paths = {'trusted': f'{h}/opt/source-v2', 'etc': f'{h}/etc', 'manifest': f'{h}/etc/formal-source-manifest-v2.json', 'roles': f'{h}/etc/roles-v3',
                 'state': f'{h}/var', 'receipt': f'{h}/var/resident/source-v2-install-receipt.json', 'node': f'{h}/node', 'git': GIT}
        for d in (f'{h}/opt', f'{h}/etc', f'{h}/var'):
            os.makedirs(d, exist_ok=True)
        with open(paths['node'], 'wb') as f:
            f.write(b'node binary')
        return paths

    def test_package_pins_every_file_and_targets_only_the_allow_list(self):
        pkg = self.build()
        v = tool.validate_package(pkg)
        self.assertEqual(v['manifest']['sourceCommit'], self.commit)
        self.assertEqual(sorted(v['data']), sorted(tool.allowed_targets()))
        # a changed byte, an extra target and a claim-bound policy are each refused
        with open(os.path.join(pkg, 'roles-v3', 'trivy.json'), 'ab') as f:
            f.write(b' ')
        with self.assertRaises(tool.Refused) as e:
            tool.validate_package(pkg)
        self.assertEqual(e.exception.code, 'PACKAGE_BYTES_CHANGED')
        pkg2 = self.build('pkg2')
        with open(os.path.join(pkg2, 'package-manifest.json'), encoding='utf-8') as f:
            m = json.loads(f.read())
        m['files'][0]['target'] = '/etc/cron.d/evil'
        os.remove(os.path.join(pkg2, 'package-manifest.json'))
        with open(os.path.join(pkg2, 'package-manifest.json'), 'w') as f:
            f.write(json.dumps(m))
        with self.assertRaises(tool.Refused) as e:
            tool.validate_package(pkg2)
        self.assertEqual(e.exception.code, 'PACKAGE_TARGETS_REFUSED')
        self.write_role('gitleaks', currentClaim='x')
        with self.assertRaises(tool.Refused) as e:
            tool.validate_package(self.build('pkg3'))
        self.assertEqual(e.exception.code, 'ROLE_POLICY_V3_REQUIRED')
        self.write_role('gitleaks', trustedSourceDirectory='/tmp/x')
        with self.assertRaises(tool.Refused) as e:
            tool.validate_package(self.build('pkg4'))
        self.assertEqual(e.exception.code, 'ROLE_POLICY_BINDING_REFUSED')

    def test_install_is_create_only_bound_to_the_reviewed_plan_and_checks_readiness(self):
        pkg = self.build()
        paths = self.host()
        body, plan_sha = tool.plan(pkg, paths)
        self.assertTrue(all(body['host']['targetsAbsent'].values()))
        with self.assertRaises(tool.Refused) as e:
            tool.install(pkg, '0' * 64, paths, as_root=False, readiness=lambda p: {r: True for r in tool.ROLES})
        self.assertEqual(e.exception.code, 'PLAN_CHANGED_SINCE_REVIEW')
        # readiness refused: nothing is reported installed, what was created is listed, nothing is deleted
        with self.assertRaises(tool.Refused) as e:
            tool.install(pkg, plan_sha, paths, as_root=False, readiness=lambda p: {'gitleaks': True, 'trivy': 'QUALIFICATION_SIGNATURE_REFUSED', 'contract-placement': True})
        self.assertEqual(e.exception.code, 'ROLE_READINESS_UNCONFIRMED')
        self.assertIn(paths['trusted'], e.exception.created)
        self.assertTrue(os.path.isdir(os.path.join(paths['trusted'], '.git')))
        # the targets now exist: the plan changes and a second apply is refused (fresh install only)
        _, again = tool.plan(pkg, paths)
        self.assertNotEqual(again, plan_sha)
        with self.assertRaises(tool.Refused) as e:
            tool.install(pkg, again, paths, as_root=False, readiness=lambda p: {r: True for r in tool.ROLES})
        self.assertEqual(e.exception.code, 'FRESH_INSTALL_REQUIRED')

    def test_install_happy_path_writes_checkout_manifest_roles_and_receipt(self):
        pkg = self.build()
        paths = self.host()
        _, plan_sha = tool.plan(pkg, paths)
        r = tool.install(pkg, plan_sha, paths, as_root=False, readiness=lambda p: {r: True for r in tool.ROLES})
        self.assertEqual(r['status'], 'INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED')
        self.assertFalse(r['privateKeyRead'] or r['qualificationIssued'] or r['containerExecuted'])
        with open(paths['manifest'], 'rb') as f:
            self.assertEqual(f.read(), self.manifest_bytes)
        head = subprocess.run([GIT, '-C', paths['trusted'], 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        self.assertEqual(head, self.commit)
        for role in tool.ROLES:
            self.assertTrue(os.path.isfile(f"{paths['roles']}/{role}.json") and os.path.isfile(f"{paths['roles']}/{role}.qualification.json"))
        self.assertTrue(os.path.isfile(paths['receipt']))


class Invocation(unittest.TestCase):
    def run_main(self, argv, root=False):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = tool.main(argv, root_check=lambda: root)
        return code, json.loads(buf.getvalue())

    def test_refuses_without_an_explicit_sub_command_or_without_root(self):
        self.assertEqual(self.run_main([]), (1, {'status': 'REFUSED', 'code': 'EXPLICIT_INVOCATION_REQUIRED', 'created': [], 'automaticRetryAllowed': False}))
        self.assertEqual(self.run_main(['--apply', '/tmp/x'])[1]['code'], 'EXPLICIT_INVOCATION_REQUIRED')
        self.assertEqual(self.run_main(['--apply', '/tmp/x', 'a' * 64])[1]['code'], 'ROOT_LINUX_REQUIRED')
        self.assertEqual(self.run_main(['--plan', '/tmp/x'])[1]['code'], 'ROOT_LINUX_REQUIRED')


if __name__ == '__main__':
    unittest.main()
