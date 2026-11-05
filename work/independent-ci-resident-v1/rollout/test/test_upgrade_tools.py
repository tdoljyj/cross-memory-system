"""Offline tests of rollout/tools (DESIGN §42.3.1): upgrade-config.py carries the installed package, roles-derived.py derives the role
hashes with the frozen Linux tool's own code. No host access, no WSL, no root, no key.
  python -I -m unittest discover -s test -p "test_*.py"     (from rollout/)
"""
import datetime, hashlib, importlib.machinery, importlib.util, json, os, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RO = os.path.dirname(HERE)
RES = os.path.dirname(RO)
TOOLS = os.path.join(RO, 'tools')
TOOL = os.path.join(RES, 'linux', 'bin', 'clued-ci-upgrade-linux')
sha = lambda b: hashlib.sha256(b).hexdigest()


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    m = importlib.util.module_from_spec(spec); loader.exec_module(m)
    return m


# the Linux tool's own offline fixtures (policy and payload shapes, the two Source versions)
fx = load('test_upgrade_linux', os.path.join(RES, 'test', 'test_upgrade_linux.py'))
tool = fx.tool
rconfig = load('rconfig', os.path.join(RES, 'reinstall', 'tools', 'rconfig.py'))


def run(script, *args):
    p = subprocess.run([sys.executable, '-I', os.path.join(TOOLS, script), *args], capture_output=True, text=True)
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    return p.returncode, (json.loads(lines[-1]) if lines else None), p.stderr


class UpgradeConfig(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='upgcfg-')
        self.addCleanup(shutil.rmtree, self.d, True)
        self.pkg = os.path.join(self.d, 'installed-package')
        os.makedirs(os.path.join(self.pkg, 'record'))
        self.manifest = b'{"contract":"clued.independent-ci.resident-package/4","x":1}\n'
        open(os.path.join(self.pkg, 'package-manifest.json'), 'wb').write(self.manifest)
        self.refs = {k: '1' * 8 + '-1111-4111-8111-' + '1' * 12 for k in ('sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef',
                                                                             'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef',
                                                                             'ownerDecisionRef', 'ownerReceiptRef')}
        json.dump({'node': {'nodeName': 'turing'}, 'acceptedAt': '2026-10-31T10:00:00Z', **self.refs}, open(os.path.join(self.pkg, 'record', 'acceptance.json'), 'w'))
        self.root = os.path.join(self.d, 'root')
        os.makedirs(os.path.join(self.root, 'upgrade'))
        self.current(sha(self.manifest))
        w = os.path.join(self.d, 'work'); os.makedirs(w)
        doc = {'contract': rconfig.CONTRACT, 'node': 'turing', 'nodeProfile': 'config/node-profile.turing.json', 'workDir': w, 'repo': 'C:\\repo',
               'basePackage': 'C:\\base', 'nodeRecord': {}, 'nodeExe': 'C:\\node.exe', 'policyInput': 'C:\\p.json', 'companionInput': 'C:\\c.json',
               'upgradeTokenFile': 'C:\\t\\resident-upgrade.token', 'runner': {'binary': '"C:\\r\\RunnerService.exe"', 'sddl': 'D:(A;;;;;SY)'},
               'launcher': {'pauseReason': 'p', 'rearmReason': 'r', 'w1PauseReason': 'w'},
               'linux': {'distribution': 'Ubuntu-24.04', 'installedManifest': 'C:\\i\\m.json', 'installedRoles': 'C:\\i\\roles-v3',
                         'host': {'toolchainNodeSha256': 'b' * 64, 'resultPublicKeySha256': 'c' * 64, 'v1SourceHead': 'f' * 40}}}
        self.cfg = os.path.join(self.d, 'config.json')
        json.dump(doc, open(self.cfg, 'w'))
        self.out = os.path.join(self.d, 'upgrade-config.json')

    def current(self, pkg_sha):
        json.dump({'generation': 1, 'packageManifestSha256': pkg_sha}, open(os.path.join(self.root, 'upgrade', 'current.json'), 'w'))

    def test_carries_the_installed_package(self):
        code, out, err = run('upgrade-config.py', self.cfg, self.pkg, self.root, self.out)
        self.assertEqual(code, 0, err)
        self.assertEqual(out['status'], 'UPGRADE_CONFIG_WRITTEN')
        self.assertEqual(rconfig.load(self.out)['basePackage'], os.path.abspath(self.pkg))
        self.assertEqual({k: v for k, v in out['carriedReferences'].items() if k != 'acceptedAt'}, self.refs)
        self.assertEqual(out['carriedReferences']['acceptedAt'], '2026-10-31T10:00:00Z')
        # create-only
        code, out, _ = run('upgrade-config.py', self.cfg, self.pkg, self.root, self.out)
        self.assertEqual([code, out['code']], [1, 'OUTPUT_EXISTS_NEVER_OVERWRITTEN'])

    def test_the_package_must_be_the_current_generation(self):
        self.current('9' * 64)
        code, out, _ = run('upgrade-config.py', self.cfg, self.pkg, self.root, self.out)
        self.assertEqual([code, out['code']], [1, 'INSTALLED_PACKAGE_IS_NOT_THE_CURRENT_GENERATION'])
        self.assertFalse(os.path.exists(self.out))

    def test_the_package_must_be_this_nodes(self):
        json.dump({'node': {'nodeName': 'desk-w-591'}, **self.refs}, open(os.path.join(self.pkg, 'record', 'acceptance.json'), 'w'))
        code, out, _ = run('upgrade-config.py', self.cfg, self.pkg, self.root, self.out)
        self.assertEqual([code, out['code']], [1, 'INSTALLED_PACKAGE_IS_FOR_ANOTHER_NODE'])


@unittest.skipUnless(shutil.which('git'), 'git is required')
class RolesDerived(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='roles-')
        self.addCleanup(fx.rmtree, self.d)
        self.repo = os.path.join(self.d, 'repo'); os.makedirs(self.repo)
        fx.git('init', '-q', cwd=self.repo)
        self.commit = {}
        for v in ('A', 'B'):
            for rel, data in fx.SOURCE[v].items():
                fx.write(os.path.join(self.repo, *rel.split('/')), data)
            fx.git('add', '-A', cwd=self.repo); fx.git('commit', '-q', '-m', v, cwd=self.repo)
            self.commit[v] = fx.git('rev-parse', 'HEAD', cwd=self.repo)
        # the commit's tree holds the frozen tool where the package build takes it from
        self.tree = os.path.join(self.d, 'tree')
        fx.write(os.path.join(self.tree, 'work', 'independent-ci-resident-v1', 'linux', 'bin', 'clued-ci-upgrade-linux'), open(TOOL, 'rb').read())
        # root's copy of the installed roles-v3 (Source A) and the node's version facts
        self.roles = os.path.join(self.d, 'roles-v3'); os.makedirs(self.roles)
        manifest_a = fx.source_manifest(self.commit['A'], 'A')
        self.installed = {}
        facts_roles = {}
        for role in fx.ROLES:
            pol = fx.policy_of(role, 'A', sha(manifest_a))
            pay = fx.payload_of(pol, sha(b'pub'), '2026-10-26T06:01:53.209Z')
            pb, qb = tool.canonical_bytes(pol), tool.canonical_bytes({'payload': pay, 'signature': 'c2lnbmVk'})
            open(os.path.join(self.roles, role + '.json'), 'wb').write(pb)
            open(os.path.join(self.roles, role + '.qualification.json'), 'wb').write(qb)
            self.installed[role] = (pol, pay)
            facts_roles[role] = {'policySha256': sha(pb), 'qualificationSha256': sha(qb)}
        self.facts = {'contract': 'clued.independent-ci.linux-version-facts/1', 'generation': 1, 'ciSourceManifestSha256': sha(manifest_a), 'sourceCommit': self.commit['A'],
                      'manifestSha256': 'e' * 64, 'roles': facts_roles, 'pinsOk': True, 'staged': None, 'upgradeToolSha256': sha(open(TOOL, 'rb').read()),
                      'observedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')}
        self.facts_file = os.path.join(self.d, 'version-facts.json')
        json.dump(self.facts, open(self.facts_file, 'w'))
        self.new_manifest = fx.source_manifest(self.commit['B'], 'B')
        self.manifest_file = os.path.join(self.d, 'source-manifest.json')
        open(self.manifest_file, 'wb').write(self.new_manifest)

    def derive(self, ci=None, facts=None):
        if facts is not None:
            json.dump(facts, open(self.facts_file, 'w'))
        return run('roles-derived.py', self.tree, self.repo, self.commit['B'], self.roles, self.manifest_file, ci or sha(self.new_manifest), self.facts_file)

    def test_the_hashes_the_linux_stage_will_derive(self):
        code, out, err = self.derive()
        self.assertEqual(code, 0, (out, err))
        want = {}
        for role in fx.ROLES:
            pol, pay = self.installed[role]
            new_pol, _ = tool.derive_role(role, pol, pay, sha(self.new_manifest), json.loads(self.new_manifest), lambda rel: sha(fx.SOURCE['B'][rel]))
            want[role] = sha(tool.canonical_bytes(new_pol))
        self.assertEqual(out['rolesDerivedSha256'], want)
        # the Source binding moved: entry, qualification and worker are B's
        self.assertNotEqual(out['rolesDerivedSha256']['trivy'], self.facts['roles']['trivy']['policySha256'])

    def test_roles_copy_missing(self):
        # Generation 13: the root export of this generation has not run yet (an empty public-six directory) -> a coded refusal, no traceback
        empty = os.path.join(self.d, 'public-six-empty'); os.mkdir(empty)
        code, out, _ = run('roles-derived.py', self.tree, self.repo, self.commit['B'], empty, self.manifest_file, sha(self.new_manifest), self.facts_file)
        self.assertEqual([code, out['code'], out['role'], out['file']], [1, 'INSTALLED_ROLES_COPY_MISSING', 'gitleaks', 'gitleaks.json'])
        os.remove(os.path.join(self.roles, 'trivy.qualification.json'))
        code, out, _ = self.derive(facts=self.facts)
        self.assertEqual([code, out['code'], out['role'], out['file']], [1, 'INSTALLED_ROLES_COPY_MISSING', 'trivy', 'trivy.qualification.json'])
        for bad in (None, b'not json'):   # facts missing, or not JSON
            f = os.path.join(self.d, 'facts-bad.json')
            if bad is not None:
                open(f, 'wb').write(bad)
            code, out, _ = run('roles-derived.py', self.tree, self.repo, self.commit['B'], self.roles, self.manifest_file, sha(self.new_manifest), f)
            self.assertEqual([code, out['code']], [1, 'LINUX_VERSION_FACTS_REFUSED'])

    def test_refusals(self):
        code, out, _ = self.derive(facts={**self.facts, 'upgradeToolSha256': 'a' * 64})
        self.assertEqual([code, out['code']], [1, 'LINUX_UPGRADE_TOOL_IS_NOT_THE_INSTALLED_ONE'])
        stale = json.loads(json.dumps(self.facts)); stale['roles']['gitleaks']['policySha256'] = 'a' * 64
        code, out, _ = self.derive(facts=stale)
        self.assertEqual([code, out['code'], out['role']], [1, 'INSTALLED_ROLES_COPY_NOT_CURRENT', 'gitleaks'])
        code, out, _ = self.derive(ci='a' * 64, facts=self.facts)
        self.assertEqual([code, out['code']], [1, 'NEW_SOURCE_MANIFEST_IS_NOT_THE_PACKAGES'])
        # a pinned file the new commit does not have
        fx.git('rm', '-q', fx.CI + 'src/proof.mjs', cwd=self.repo); fx.git('commit', '-q', '-m', 'C', cwd=self.repo)
        c = fx.git('rev-parse', 'HEAD', cwd=self.repo)
        code, out, _ = run('roles-derived.py', self.tree, self.repo, c, self.roles, self.manifest_file, sha(self.new_manifest), self.facts_file)
        self.assertEqual([code, out['code']], [1, 'PINNED_FILE_MISSING_IN_NEW_COMMIT'])

    def test_facts_must_be_fresh_and_name_the_qualifications(self):
        code, out, _ = self.derive(facts={**self.facts, 'observedAt': '2026-01-01T00:00:00.000Z'})
        self.assertEqual([code, out['code']], [1, 'LINUX_VERSION_FACTS_NOT_FRESH'])
        code, out, _ = self.derive(facts={**self.facts, 'observedAt': '2026-11-01T08:00:00'})   # no zone
        self.assertEqual([code, out['code']], [1, 'LINUX_VERSION_FACTS_REFUSED'])
        code, out, _ = self.derive(facts={**self.facts, 'contract': 'something-else/1'})
        self.assertEqual([code, out['code']], [1, 'LINUX_VERSION_FACTS_REFUSED'])
        stale = json.loads(json.dumps(self.facts)); stale['roles']['trivy']['qualificationSha256'] = 'a' * 64
        code, out, _ = self.derive(facts=stale)
        self.assertEqual([code, out['code'], out['file']], [1, 'INSTALLED_ROLES_COPY_NOT_CURRENT', 'qualification'])

    def test_pinned_files_must_be_regular_and_not_empty(self):
        # the stage's read_regular refuses an empty file and a link in the checkout: so does the derivation
        fx.write(os.path.join(self.repo, *(fx.CI + 'src/proof.mjs').split('/')), b'')
        fx.git('add', '-A', cwd=self.repo); fx.git('commit', '-q', '-m', 'empty', cwd=self.repo)
        c = fx.git('rev-parse', 'HEAD', cwd=self.repo)
        code, out, _ = run('roles-derived.py', self.tree, self.repo, c, self.roles, self.manifest_file, sha(self.new_manifest), self.facts_file)
        self.assertEqual([code, out['code']], [1, 'PINNED_FILE_EMPTY'])
        blob = subprocess.run(['git', '-C', self.repo, 'hash-object', '-w', '--stdin'], input=b'elsewhere', capture_output=True, check=True).stdout.decode().strip()
        fx.git('update-index', '--add', '--cacheinfo', f'120000,{blob},{fx.CI}src/proof.mjs', cwd=self.repo)
        fx.git('commit', '-q', '-m', 'link', cwd=self.repo)
        c = fx.git('rev-parse', 'HEAD', cwd=self.repo)
        code, out, _ = run('roles-derived.py', self.tree, self.repo, c, self.roles, self.manifest_file, sha(self.new_manifest), self.facts_file)
        self.assertEqual([code, out['code'], out['mode']], [1, 'PINNED_FILE_NOT_A_REGULAR_FILE', '120000'])


@unittest.skipUnless(shutil.which('powershell.exe'), 'Windows PowerShell 5.1 is required')
class BuildUpgradeScript(unittest.TestCase):
    def test_it_parses_in_windows_powershell(self):
        target = os.path.join(RO, 'build-upgrade.ps1').replace("'", "''")
        script = (f"$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('{target}',[ref]$null,[ref]$e); "
                  "if ($e) { $e | ForEach-Object { $_.Message }; exit 1 } else { 'PARSE_OK' }")
        p = subprocess.run(['powershell.exe', '-NoProfile', '-Command', script], capture_output=True, text=True)
        self.assertEqual((p.returncode, p.stdout.strip()), (0, 'PARSE_OK'), p.stdout + p.stderr)


class SourceOnGithub(unittest.TestCase):
    """Generation 13 (DESIGN §57.6, Task 3edfc598): a final package's Source commit must be reachable from a branch of the remote."""

    def git(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith('GIT_')}
        env.update({'GIT_AUTHOR_NAME': 'a', 'GIT_AUTHOR_EMAIL': 'a@b', 'GIT_COMMITTER_NAME': 'a', 'GIT_COMMITTER_EMAIL': 'a@b'})
        p = subprocess.run(['git', '-C', self.src, *args], capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='srcgh-')
        self.addCleanup(shutil.rmtree, self.d, True)
        self.src = os.path.join(self.d, 'src')
        subprocess.run(['git', 'init', '-q', '-b', 'main', self.src], check=True)
        self.git('config', 'uploadpack.allowFilter', 'true')
        self.git('commit', '-q', '--allow-empty', '-m', 'one'); self.main = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '-b', 'feature'); self.git('commit', '-q', '--allow-empty', '-m', 'two'); self.feature = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', '-b', 'local-only'); self.git('commit', '-q', '--allow-empty', '-m', 'three'); self.local = self.git('rev-parse', 'HEAD')
        self.git('checkout', '-q', 'main'); self.git('branch', '-q', '-D', 'local-only')   # the commit stays in the object store, no branch reaches it
        self.url = 'file://' + self.src.replace(os.sep, '/')

    def test_reachable_from_a_branch(self):
        for c in (self.main, self.feature):
            code, out, _ = run('source-on-github.py', self.url, c)
            self.assertEqual((code, out['status']), (0, 'ON_REMOTE'))

    def test_a_commit_no_branch_reaches_is_refused_even_if_the_remote_keeps_it(self):
        code, out, _ = run('source-on-github.py', self.url, self.local)
        self.assertEqual((code, out['status']), (3, 'NOT_ON_REMOTE'))
        code, out, _ = run('source-on-github.py', self.url, '0' * 40)
        self.assertEqual((code, out['status']), (3, 'NOT_ON_REMOTE'))

    def test_a_hanging_fetch_ends_with_its_whole_process_tree(self):
        """Review round 2 (NIT): a git that hangs is ended at its timeout together with what it started (git-remote-https), so the
        scratch directory can go. A stand-in for git starts a child and both sleep; the child must be gone after the timeout."""
        sog = load('source_on_github', os.path.join(TOOLS, 'source-on-github.py'))
        pidfile = os.path.join(self.d, 'child.pid')
        script = ('import subprocess, sys, time; c = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"]); '
                  f'open({pidfile!r}, "w").write(str(c.pid)); time.sleep(120)')
        sog.GIT, sog.LOW_SPEED = sys.executable, []
        started = datetime.datetime.now()
        r = sog.git(['-c', script], timeout=5)
        self.assertEqual(r.returncode, 124)
        self.assertLess((datetime.datetime.now() - started).total_seconds(), 60)
        pid = int(open(pidfile).read())
        if os.name == 'nt':
            alive = str(pid) in subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH'], capture_output=True, text=True).stdout
        else:
            try:
                os.kill(pid, 0); alive = True
            except OSError:
                alive = False
        self.assertFalse(alive, 'the child of the hanging git was ended too')

    def test_an_unreachable_remote_and_bad_arguments(self):
        code, out, _ = run('source-on-github.py', 'file://' + os.path.join(self.d, 'missing').replace(os.sep, '/'), self.main)
        self.assertEqual((code, out['status']), (4, 'REMOTE_UNREACHABLE'))
        for args in ((self.url,), (self.url, 'x' * 40), ('ssh://x', self.main), (self.url, self.main.upper())):
            code, out, _ = run('source-on-github.py', *args)
            self.assertEqual((code, out['status']), (1, 'USAGE'), args)


if __name__ == '__main__':
    unittest.main()
