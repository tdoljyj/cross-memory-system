"""Offline tests of the reinstall rehearsal and configuration (no host access: a fake Host answers for the node).

Regression cases (README.md section 5): the three refusals of the r7 TURING reinstall must each be a rehearsal finding before any final:
  1. the Linux resident manifest kept the INSTALLED external pins although the new commit changed those Source files (Linux A/B);
  2. the role derivation refused a Source file the new commit changed (PINNED_FILE_CHANGED_IN_NEW_COMMIT_REPIN_NEEDED, Linux A);
  3. the launcher accepted only uninstall plan /2 while the installed uninstall writes /3 (UNINSTALL_PLAN_REFUSED, launcher f3).
  python -I -m unittest discover -s test -p "test_*.py"     (from reinstall/)
"""
import hashlib, importlib.util, json, os, shutil, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RE = os.path.dirname(HERE)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


rehearse = load('rehearse', os.path.join(RE, 'rehearse.py'))
rconfig = rehearse.rconfig
sha = lambda b: hashlib.sha256(b).hexdigest()
COMMIT = 'a' * 40
SV2 = '/opt/clued-independent-ci/source-v2/'
WORKER = 'work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/linux-worker.mjs'
NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node'
OWN = ['/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux', '/etc/systemd/system/clued-ci-worker@.service',
       '/etc/systemd/system/clued-ci-wsprep@.service', '/etc/systemd/system/clued-ci-archive@.service']
PROFILE = {'contract': 'clued.independent-ci.node-profile/1', 'controllerSid': 'S-1-5-21-1-2-3-1015', 'hostname': 'TURING',
           'mutationMutex': 'Global\\CluedControlControllerMutationV1-TURING-1015', 'nodeName': 'turing', 'ownerProfileDirectory': 'C:\\Users\\o',
           'ownerSid': 'S-1-5-21-1-2-3-1001', 'runnerService': 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02', 'wslDistribution': 'Ubuntu-24.04'}
HOST_FACTS = {'toolchainNodeSha256': 'b' * 64, 'resultPublicKeySha256': 'c' * 64, 'v1SourceHead': 'f' * 40}


VERIFY_TAIL ='''  if ($allOk) { return @{ status = 'RESIDENT_VERIFIED'; exit = 0 } }
  if ($unreadable) { return @{ status = 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED'; exit = 2 } }
  return @{ status = 'RESIDENT_VERIFICATION_FAILED'; exit = 1 }
$verdict = Get-VerifyVerdict $checks
[ordered]@{ status = $verdict.status; checks = $checks } | ConvertTo-Json -Depth 6
'''


def manifest(entries):
    return {'contract': 'clued.independent-ci.resident-linux-manifest/2', 'files': [{'installedPath': p, 'sha256': s} for p, s in entries]}


class Fixture:
    """A work directory with the commit's tree, a package and the installed-state copies; a fake Host for the node."""
    def __init__(self, new_worker=b'new worker', package_pins_follow_new=True):
        self.dir = tempfile.mkdtemp(prefix='rehearse-')
        w = self.w = os.path.join(self.dir, 'work')
        tree = os.path.join(w, 'tree-' + COMMIT[:8])
        os.makedirs(os.path.join(tree, 'work', 'independent-ci-resident-v1', 'config'))
        with open(os.path.join(tree, 'work', 'independent-ci-resident-v1', 'config', 'node-profile.turing.json'), 'w', encoding='utf-8') as f:
            json.dump(PROFILE, f)
        os.makedirs(os.path.dirname(os.path.join(tree, *WORKER.split('/'))))
        with open(os.path.join(tree, *WORKER.split('/')), 'wb') as f:
            f.write(new_worker)
        own = [(p, sha(p.encode())) for p in OWN]
        installed = manifest(own + [(NODE, 'b' * 64), (SV2 + WORKER, sha(b'old worker'))])
        inst_dir = os.path.join(w, 'installed'); os.makedirs(os.path.join(inst_dir, 'roles-v3'))
        self.installed_manifest = os.path.join(inst_dir, 'resident-v1-manifest.json')
        im = json.dumps(installed).encode()
        open(self.installed_manifest, 'wb').write(im)
        self.facts_roles = {}
        for role in ('gitleaks', 'trivy', 'contract-placement'):
            for suffix, body in (('.json', b'policy ' + role.encode()), ('.qualification.json', b'q ' + role.encode())):
                open(os.path.join(inst_dir, 'roles-v3', role + suffix), 'wb').write(body)
            self.facts_roles[role] = {'policySha256': sha(b'policy ' + role.encode()), 'qualificationSha256': sha(b'q ' + role.encode())}
        src_manifest = b'{"installed":"source manifest"}'
        open(os.path.join(inst_dir, 'roles-v3', 'formal-source-manifest-v2.json'), 'wb').write(src_manifest)
        self.facts = {'contract': 'clued.independent-ci.linux-version-facts/1', 'generation': 1, 'staged': None, 'pinsOk': True, 'sourceCommit': 'c' * 40,
                      'ciSourceManifestSha256': sha(src_manifest), 'manifestSha256': sha(im), 'roles': self.facts_roles, 'upgradeToolSha256': 'd' * 64}
        pkg = self.pkg = os.path.join(w, 'package')
        os.makedirs(os.path.join(pkg, 'record')); os.makedirs(os.path.join(pkg, 'linux'))
        pins = [(NODE, 'b' * 64), (SV2 + WORKER, sha(new_worker) if package_pins_follow_new else sha(b'old worker'))]
        open(os.path.join(pkg, 'linux', 'manifest.json'), 'w').write(json.dumps(manifest([(OWN[0], 'e' * 64)] + own[1:] + pins)))
        json.dump({'node': PROFILE, 'sourceAcceptanceRef': '1' * 8 + '-1111-4111-8111-' + '1' * 12, 'hostQualificationRef': '1' * 8 + '-1111-4111-8111-' + '1' * 12},
                  open(os.path.join(pkg, 'record', 'acceptance.json'), 'w'))
        open(os.path.join(pkg, 'record', 'source-manifest.json'), 'w').write('{}')
        open(os.path.join(pkg, 'package-manifest.json'), 'w').write('{"contract":"clued.independent-ci.resident-package/4"}')
        os.makedirs(os.path.join(pkg, 'resident', 'windows'))
        open(os.path.join(pkg, 'resident', 'windows', 'verify-resident.ps1'), 'w').write(VERIFY_TAIL)
        cfg_doc = {'contract': rconfig.CONTRACT, 'node': 'turing', 'nodeProfile': 'config/node-profile.turing.json', 'workDir': w, 'repo': 'C:\\repo',
                   'basePackage': 'C:\\base', 'nodeRecord': {}, 'nodeExe': 'C:\\node.exe', 'policyInput': 'C:\\p.json', 'companionInput': 'C:\\c.json',
                   'upgradeTokenFile': 'C:\\t\\resident-upgrade.token', 'runner': {'binary': '"C:\\r\\RunnerService.exe"', 'sddl': 'D:(A;;;;;SY)'},
                   'launcher': {'pauseReason': 'p', 'rearmReason': 'r', 'w1PauseReason': 'w'},
                   'linux': {'distribution': 'Ubuntu-24.04', 'installedManifest': self.installed_manifest, 'installedRoles': os.path.join(inst_dir, 'roles-v3'),
                             'host': HOST_FACTS}}
        self.cfg_path = os.path.join(self.dir, 'config.json')
        json.dump(cfg_doc, open(self.cfg_path, 'w'))
        self.cfg = rconfig.load(self.cfg_path)

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class FakeHost:
    """The installed node as the rehearsal sees it. uninstall_contract / upgrader / derive answer what the r7 TURING host answered."""
    def __init__(self, fx, uninstall_contract=3, upgrader=True, derive=None, verify='partial', probe=None):
        self.fx, self.files, self.verify = fx, {}, verify
        self.probe = {'checkHostExit': 0, 'checkHost': '{"status":"HOST_PINS_AS_DERIVED"}', 'v1Head': HOST_FACTS['v1SourceHead'],
                      'v1Qualifications': {'gitleaks': True, 'trivy': True, 'contract-placement': True}, **(probe or {})}
        self.probe_argv = None
        self.upgrader = upgrader
        plan = {'contract': 'clued.independent-ci.resident-uninstall-plan/%d' % uninstall_contract, 'openBatches': 0, 'runnerOriginalStopped': True,
                'runnerSddlUnchanged': True, 'renameTo': 'resident-uninstalled-<UTC>-<hex>', 'deletesEvidence': False}
        if uninstall_contract == 3:
            plan.update({'upgraderService': upgrader, 'upgradeOpState': None, 'executorAlive': True})
        self.uninstall = {'status': 'DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN', 'planSha256': 'f' * 64, 'plan': plan}
        self.derive = derive or {'status': 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN', 'roles': {'gitleaks': {'repinned': {'entrySha256': {'old': 'o', 'new': 'n'}}}}}
        gen_linux = {'generation': 1, 'manifestSha256': fx.facts['manifestSha256'], 'ciSourceManifestSha256': fx.facts['ciSourceManifestSha256']}
        self.json = {
            ('install', 'install-receipt.json'): {'residentManifestSha256': '9' * 64},
            ('state', 'status.json'): {'writtenAt': 'x', 'executor': {'state': 'PAUSED'}, 'current': None, 'halt': None},
            ('upgrade', 'status.json'): {'op': None},
            ('upgrade', 'current.json'): {'contract': 'clued.independent-ci.resident-generation/1', 'generation': 1, 'packageManifestSha256': '8' * 64, 'linux': gen_linux},
            ('upgrade', 'mailbox', 'responses', 'version-facts.json'): fx.facts,
        }

    def path(self, *rel):
        return rel

    def exists(self, p):
        return p in self.json

    def read_json(self, p):
        return json.loads(json.dumps(self.json[p]))

    def sha(self, p):
        return '7' * 64

    def powershell(self, script, args):
        if script[-1] == 'uninstall-resident.ps1':
            return 0, json.dumps(self.uninstall), ''
        if script[-1] == 'verify-resident.ps1' and self.verify == 'denied':
            return 1, '', 'Test-Path : Access is denied (+ FullyQualifiedErrorId : ItemExistsUnauthorizedAccessError)'
        if script[-1] == 'verify-resident.ps1' and self.verify == 'failed':
            return 1, json.dumps({'status': 'RESIDENT_VERIFICATION_FAILED', 'checks': {'a': {'ok': False}}}), ''
        if script[-1] == 'verify-resident.ps1':
            return 2, json.dumps({'status': 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED', 'checks': {'a': {'ok': True}, 'b': {'ok': 'unreadable'}}}), ''
        raise AssertionError(script)

    def service_present(self, name):
        return self.upgrader

    def wsl_python(self, distribution, argv, user=None):
        if user == 'root':   # the read-only host probe
            self.probe_argv = argv
            return 0, json.dumps(self.probe), ''
        assert user is None, user
        return (0 if self.derive.get('status') == 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN' else 1), json.dumps(self.derive), ''


def codes(report):
    return [f['code'] for f in report['findings']]


class Rehearsal(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.close)
        self.bare = os.path.join(self.fx.w, 'rehearsal', 'src-' + COMMIT[:8] + '.git')
        os.makedirs(self.bare)   # an existing bare repository: the roles step does not fetch

    def run_with(self, host, **kw):
        return rehearse.rehearse(self.fx.cfg, COMMIT, self.fx.pkg, host, **kw)

    def test_pass_on_a_consistent_node(self):
        r = self.run_with(FakeHost(self.fx))
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings'])
        self.assertEqual(r['checks']['roles']['repinned'], {'gitleaks': {'entrySha256': {'old': 'o', 'new': 'n'}}})
        self.assertEqual(r['checks']['uninstall']['templateAcceptsContract'], '3')

    # regression 3: the f3 launcher accepted /2 only
    def test_uninstall_contract_the_launcher_does_not_accept(self):
        old = os.path.join(self.fx.dir, 'template-f3.ps1')
        text = open(os.path.join(RE, 'launcher', 'template.ps1'), encoding='utf-8').read()
        f3 = text.replace("'clued.independent-ci.resident-uninstall-plan/3'", "'clued.independent-ci.resident-uninstall-plan/2'")
        self.assertNotEqual(f3, text)
        open(old, 'w', encoding='utf-8').write(f3)
        r = self.run_with(FakeHost(self.fx, uninstall_contract=3), template_path=old)
        self.assertIn('UNINSTALL_PLAN_CONTRACT_NOT_ACCEPTED_BY_LAUNCHER', codes(r))
        self.assertEqual(r['status'], 'REHEARSAL_FAILED')

    def test_uninstall_plan_older_than_the_launcher(self):
        self.assertIn('UNINSTALL_PLAN_CONTRACT_NOT_ACCEPTED_BY_LAUNCHER', codes(self.run_with(FakeHost(self.fx, uninstall_contract=2, upgrader=False))))

    def test_installed_upgrade_op_and_upgrader_presence(self):
        h = FakeHost(self.fx); h.uninstall['plan']['upgradeOpState'] = 'WAITING_GRANT'; h.json[('upgrade', 'status.json')] = {'op': {'state': 'WAITING_GRANT'}}
        self.assertTrue({'INSTALLED_UPGRADE_OP_RECORDED', 'UPGRADE_OP_IN_PROGRESS'} <= set(codes(self.run_with(h))))
        h = FakeHost(self.fx); h.uninstall['plan']['upgraderService'] = False
        self.assertIn('UNINSTALL_PLAN_UPGRADER_NOT_THE_SERVICE', codes(self.run_with(h)))

    def test_a_template_that_would_kill_the_upgrader(self):
        old = os.path.join(self.fx.dir, 'template-noupg.ps1')
        text = open(os.path.join(RE, 'launcher', 'template.ps1'), encoding='utf-8').read()
        open(old, 'w', encoding='utf-8').write(text.replace('& $Sc stop CluedCIUpgrader', '# removed'))
        self.assertIn('LAUNCHER_DOES_NOT_STOP_THE_INSTALLED_UPGRADER', codes(self.run_with(FakeHost(self.fx), template_path=old)))

    # regression 1: the package kept the installed source-v2 pin while the commit changed the file
    def test_external_pins_not_the_new_source(self):
        fx = Fixture(package_pins_follow_new=False); self.addCleanup(fx.close)
        os.makedirs(os.path.join(fx.w, 'rehearsal', 'src-' + COMMIT[:8] + '.git'))
        r = rehearse.rehearse(fx.cfg, COMMIT, fx.pkg, FakeHost(fx))
        self.assertIn('LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE', codes(r))

    # regression 2: the strict r4 derivation refused the changed entry file
    def test_role_derivation_refused(self):
        refusal = {'status': 'REFUSED', 'code': 'PINNED_FILE_CHANGED_IN_NEW_COMMIT_REPIN_NEEDED', 'role': 'gitleaks', 'key': 'entrySha256'}
        r = self.run_with(FakeHost(self.fx, derive=refusal))
        self.assertIn('ROLE_DERIVATION_REFUSED', codes(r))
        self.assertEqual([f for f in r['findings'] if f['code'] == 'ROLE_DERIVATION_REFUSED'][0]['key'], 'entrySha256')

    def test_roles_not_rehearsed_is_a_finding(self):
        self.assertIn('ROLE_DERIVATION_NOT_REHEARSED', codes(self.run_with(FakeHost(self.fx), skip_roles=True)))

    def test_stale_installed_copies(self):
        open(os.path.join(self.fx.cfg['linux']['installedRoles'], 'trivy.json'), 'wb').write(b'older policy')
        open(self.fx.installed_manifest, 'ab').write(b' ')
        c = codes(self.run_with(FakeHost(self.fx)))
        self.assertIn('INSTALLED_ROLES_COPY_STALE', c)
        self.assertIn('INSTALLED_LINUX_MANIFEST_COPY_STALE', c)

    def test_facts_not_the_generation_record(self):
        h = FakeHost(self.fx); h.json[('upgrade', 'current.json')]['linux']['generation'] = 2
        self.assertIn('LINUX_FACTS_NOT_THE_GENERATION_RECORD', codes(self.run_with(h)))

    def test_installed_verify(self):
        r = self.run_with(FakeHost(self.fx, verify='denied'))
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings']); self.assertTrue(r['checks']['verify']['notRunnableUnelevated'])
        self.assertIn('INSTALLED_VERIFY_NOT_PASSING', codes(self.run_with(FakeHost(self.fx, verify='failed'))))

    def test_package_verify_output_the_launcher_cannot_read(self):
        open(os.path.join(self.fx.pkg, 'resident', 'windows', 'verify-resident.ps1'), 'w').write(VERIFY_TAIL.replace('checks = $checks', 'results = $checks'))
        self.assertIn('PACKAGE_VERIFY_OUTPUT_NOT_WHAT_THE_LAUNCHER_READS', codes(self.run_with(FakeHost(self.fx))))

    def test_package_for_another_node(self):
        acc = os.path.join(self.fx.pkg, 'record', 'acceptance.json')
        d = json.load(open(acc)); d['node'] = dict(PROFILE, hostname='OTHER'); json.dump(d, open(acc, 'w'))
        self.assertIn('PACKAGE_NODE_NOT_THE_CONFIGURED_PROFILE', codes(self.run_with(FakeHost(self.fx))))

    # review 1-1: the root scripts pinned TURING's toolchain node, result key and Source v1; on another node phase A would refuse
    def test_linux_host_facts_not_the_nodes(self):
        h = FakeHost(self.fx)
        self.assertEqual(self.run_with(h)['status'], 'REHEARSAL_PASS')
        self.assertEqual(h.probe_argv[-2:], [HOST_FACTS['toolchainNodeSha256'], HOST_FACTS['resultPublicKeySha256']])
        c = codes(self.run_with(FakeHost(self.fx, probe={'checkHostExit': 1, 'checkHost': '{"status":"REFUSED","code":"PUBLIC_RESULT_KEY_CHANGED"}',
                                                          'v1Head': '0' * 40, 'v1Qualifications': {'gitleaks': False}})))
        self.assertTrue({'LINUX_HOST_PINS_NOT_THE_CONFIGURED', 'LINUX_V1_SOURCE_HEAD_NOT_THE_CONFIGURED', 'LINUX_V1_QUALIFICATIONS_MISSING'} <= set(c), c)

    # record-only reinstall (README 8b): same CI Source and Linux half as installed, so no Linux phase and nothing to derive
    def test_record_only_package_needs_no_role_derivation(self):
        pm = os.path.join(self.fx.pkg, 'package-manifest.json')
        json.dump({'contract': 'clued.independent-ci.resident-package/4', 'ciSourceManifestSha256': self.fx.facts['ciSourceManifestSha256'],
                   'linux': {'manifestSha256': self.fx.facts['manifestSha256']}}, open(pm, 'w'))
        r = self.run_with(FakeHost(self.fx, derive={'status': 'REFUSED', 'code': 'MANIFESTS_NOT_OLD_AND_NEW'}))
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings'])
        self.assertEqual(r['checks']['roles'], {'notApplicable': 'SAME_SOURCE_AND_LINUX_HALF_NO_LINUX_PHASE'})

    # review 1-7: Test-UninstallPlan requires upgraderService = $true, whatever the service's presence
    def test_uninstall_plan_without_the_upgrader(self):
        h = FakeHost(self.fx, upgrader=False)
        self.assertIn('UNINSTALL_PLAN_UPGRADER_SERVICE_NOT_TRUE', codes(self.run_with(h)))

    # review 1-9: a distribution whose default user is root never runs the derivation
    def test_role_derivation_as_root_is_refused(self):
        r = self.run_with(FakeHost(self.fx, derive={'status': 'REFUSED', 'code': 'REHEARSAL_DEFAULT_USER_IS_ROOT'}))
        self.assertEqual([f.get('refusal') for f in r['findings'] if f['code'] == 'ROLE_DERIVATION_REFUSED'], ['REHEARSAL_DEFAULT_USER_IS_ROOT'])


class TemplateContract(unittest.TestCase):
    def test_the_committed_template(self):
        text = open(os.path.join(RE, 'launcher', 'template.ps1'), encoding='utf-8').read()
        contract, fields = rehearse.template_contract(text)
        self.assertEqual(contract, '3')
        self.assertTrue({'openBatches', 'upgraderService', 'upgradeOpState', 'runnerOriginalStopped', 'runnerSddlUnchanged', 'deletesEvidence'} <= set(fields))
        self.assertNotIn("'TURING'", text)   # the host comes from the node profile ($NodeHostname)


class Config(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.close)
        self.doc = json.load(open(self.fx.cfg_path))

    def load(self, doc):
        p = os.path.join(self.fx.dir, 'c2.json')
        json.dump(doc, open(p, 'w'))
        return rconfig.load(p)

    def test_secret_shaped_values_and_keys_are_refused(self):
        for bad in ({'nodeExe': 'C:\\x\\-----BEGIN RSA PRIVATE KEY-----'}, {'repo': 'C:\\ghp_' + 'A' * 36}):
            with self.assertRaises(rconfig.ConfigError) as e:
                self.load(dict(self.doc, **bad))
            self.assertIn(e.exception.code, ('CONFIG_SECRET_SHAPED_VALUE', 'CONFIG_PATH_SHAPE'))
        with self.assertRaises(rconfig.ConfigError) as e:
            self.load(dict(self.doc, runner=dict(self.doc['runner'], password='x')))
        self.assertIn(e.exception.code, ('CONFIG_SECRET_SHAPED_KEY', 'CONFIG_RUNNER'))

    def test_node_record_placeholders_and_shapes(self):
        with self.assertRaises(rconfig.ConfigError):
            self.load(dict(self.doc, nodeRecord={'ciTokenPinSha256': 'REPLACE_WITH_THE_NODE_VALUE'}))
        with self.assertRaises(rconfig.ConfigError):
            self.load(dict(self.doc, nodeRecord={'appKeyId': '123'}))
        c = self.load(dict(self.doc, nodeRecord={'appKeyId': 123, 'ciTokenPinSha256': '0' * 64}))
        self.assertEqual(c['nodeRecord']['appKeyId'], 123)

    def test_unknown_keys_and_profile_of_another_node(self):
        with self.assertRaises(rconfig.ConfigError):
            self.load(dict(self.doc, extra=1))
        c = self.load(dict(self.doc, node='desk-w-591'))
        with self.assertRaises(rconfig.ConfigError):
            rconfig.node_profile(c, os.path.join(self.fx.w, 'tree-' + COMMIT[:8]))

    # review 1-3: values that reach the root shell or the elevated PowerShell
    def test_values_unsafe_in_a_shell_or_powershell_are_refused(self):
        for bad in ({'workDir': 'C:\\w$(id)'}, {'workDir': 'C:\\w;x'}, {'repo': 'C:\\r`x'}, {'repo': 'C:\\r\u2019x'},
                    {'runner': dict(self.doc['runner'], binary='"C:\\r\\x.exe" & calc')}, {'runner': dict(self.doc['runner'], sddl="D:(A;;;;;SY)'")}):
            with self.assertRaises(rconfig.ConfigError, msg=bad):
                self.load(dict(self.doc, **bad))

    def test_linux_host_facts_and_distribution(self):
        with self.assertRaises(rconfig.ConfigError) as e:
            self.load(dict(self.doc, linux={k: v for k, v in self.doc['linux'].items() if k != 'host'}))
        self.assertEqual(e.exception.code, 'CONFIG_LINUX')
        with self.assertRaises(rconfig.ConfigError) as e:
            self.load(dict(self.doc, linux=dict(self.doc['linux'], host=dict(HOST_FACTS, v1SourceHead='REPLACE_ME'))))
        self.assertEqual(e.exception.code, 'CONFIG_LINUX_HOST')
        c = self.load(dict(self.doc, linux=dict(self.doc['linux'], distribution='CluedResident-Linux')))
        with self.assertRaises(rconfig.ConfigError) as e:
            rconfig.node_profile(c, os.path.join(self.fx.w, 'tree-' + COMMIT[:8]))
        self.assertEqual(e.exception.code, 'CONFIG_DISTRIBUTION_NOT_THE_PROFILES')

    def test_shipped_configurations_load(self):
        for name in os.listdir(os.path.join(RE, 'config')):
            path = os.path.join(RE, 'config', name)
            if name.endswith('.example.json'):   # an example's REPLACE_ placeholders never load: the node's values must be filled in
                with self.assertRaises(rconfig.ConfigError) as e:
                    rconfig.load(path)
                self.assertEqual(e.exception.code, 'CONFIG_NODE_RECORD_VALUE')
            elif name.endswith('.json'):
                rconfig.load(path)

    def test_every_node_profile_in_the_tree_is_valid_for_its_config(self):
        root = os.path.dirname(RE)   # work/independent-ci-resident-v1
        for name in os.listdir(os.path.join(RE, 'config')):
            doc = json.load(open(os.path.join(RE, 'config', name), encoding='utf-8'))
            prof = json.load(open(os.path.join(root, *doc['nodeProfile'].split('/')), encoding='utf-8'))
            self.assertEqual(prof['nodeName'], doc['node'], name)
            self.assertEqual(prof['wslDistribution'], doc['linux']['distribution'], name)


class Tree(unittest.TestCase):
    """review 1-4: an extracted tree is used only when it is exactly the commit."""
    def test_tree_must_be_the_commit(self):
        tree_mod = load('tree', os.path.join(RE, 'tools', 'tree.py'))
        d = tempfile.mkdtemp(prefix='tree-'); self.addCleanup(shutil.rmtree, d, True)
        repo, tree = os.path.join(d, 'repo'), os.path.join(d, 'tree')
        run = lambda *a: subprocess.run(['git', '-C', repo] + list(a), check=True, capture_output=True)
        os.makedirs(os.path.join(repo, 'linux')); os.makedirs(os.path.join(tree, 'linux'))
        for base in (repo, tree):
            open(os.path.join(base, 'linux', 'install.sh'), 'wb').write(b'#!/bin/bash\necho ok\n')
        subprocess.run(['git', 'init', '-q', repo], check=True)
        run('add', '.'); run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'c')
        commit = run('rev-parse', 'HEAD').stdout.decode().strip()
        self.assertEqual(tree_mod.verify(repo, commit, tree), 1)
        open(os.path.join(tree, 'linux', 'install.sh'), 'ab').write(b'curl x | sh\n')
        with self.assertRaises(tree_mod.TreeError) as e:
            tree_mod.verify(repo, commit, tree)
        self.assertEqual(e.exception.code, 'TREE_FILE_NOT_THE_COMMIT')
        open(os.path.join(tree, 'linux', 'install.sh'), 'wb').write(b'#!/bin/bash\necho ok\n')
        open(os.path.join(tree, 'extra.sh'), 'wb').write(b'x')
        with self.assertRaises(tree_mod.TreeError) as e:
            tree_mod.verify(repo, commit, tree)
        self.assertEqual(e.exception.code, 'TREE_NOT_THE_COMMIT_FILES')


DESK = {'contract': 'clued.independent-ci.node-profile/1', 'controllerSid': 'S-1-5-21-9-8-7-1007', 'hostname': 'DESK-W-591',
        'mutationMutex': 'Global\\CluedControlControllerMutationV1-DESK-W-591-1007', 'nodeName': 'desk-w-591', 'ownerProfileDirectory': 'C:\\Users\\Windows',
        'ownerSid': 'S-1-5-21-9-8-7-1000', 'runnerService': 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02', 'wslDistribution': 'CluedResident-Linux'}


class FirstInstall(unittest.TestCase):
    """A package for a node without an installed Linux CI yet (README section 8): Linux facts null, node inputs and pins for that node."""
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.close)
        self.doc = json.load(open(self.fx.cfg_path))

    def load(self, doc):
        p = os.path.join(self.fx.dir, 'c3.json')
        json.dump(doc, open(p, 'w'))
        return rconfig.load(p)

    def test_null_linux_facts_load_and_the_reinstall_tools_refuse_them(self):
        first = dict(self.doc, linux=dict(self.doc['linux'], installedRoles=None, host={k: None for k in HOST_FACTS}))
        c = self.load(first)
        with self.assertRaises(rconfig.ConfigError) as e:
            rconfig.need_installed_linux(c)
        self.assertEqual(e.exception.code, 'NODE_HAS_NO_INSTALLED_LINUX_CI')
        with self.assertRaises(rconfig.ConfigError):
            rehearse.rehearse(c, COMMIT, self.fx.pkg, FakeHost(self.fx))
        c = self.load(dict(first, linux=dict(first['linux'], host=dict(first['linux']['host'], toolchainNodeSha256='e' * 64))))
        with self.assertRaises(rconfig.ConfigError):   # one known fact is not an installed Linux CI
            rconfig.need_installed_linux(c)
        with self.assertRaises(rconfig.ConfigError) as e:   # a value that is there keeps its shape
            self.load(dict(first, linux=dict(first['linux'], host=dict(first['linux']['host'], v1SourceHead='REPLACE_ME'))))
        self.assertEqual(e.exception.code, 'CONFIG_LINUX_HOST')
        rconfig.need_installed_linux(self.fx.cfg)   # the installed node's configuration still passes

    def test_linux_pins_take_the_nodes_own_toolchain_node(self):
        tree = os.path.join(self.fx.w, 'tree-' + COMMIT[:8])
        bp = os.path.join(tree, 'work', 'independent-ci-resident-v1', 'tools', 'build-package.mjs')
        os.makedirs(os.path.dirname(bp))
        names = ['bin/clued-ci-resident-linux', 'systemd/clued-ci-worker@.service', 'systemd/clued-ci-wsprep@.service', 'systemd/clued-ci-archive@.service']
        open(bp, 'w').write('const LINUX_FILES = [\n' + ''.join("  ['%s', '%s'],\n" % (n, p) for n, p in zip(names, OWN)) + '];\n')
        tool = os.path.join(RE, 'tools', 'linux-pins.py')
        run = lambda *a: subprocess.run([__import__('sys').executable, '-I', tool] + list(a), capture_output=True, text=True)
        own_pin = 'c' * 64
        for extra, node_pin in (([], 'b' * 64), (['--toolchain-node', own_pin], own_pin)):
            out = os.path.join(self.fx.dir, 'pins-%s.json' % len(extra))
            r = run('pins', self.fx.installed_manifest, out, tree, *extra)
            self.assertEqual(r.returncode, 0, r.stderr)
            pins = {p['installedPath']: p['sha256'] for p in json.load(open(out))}
            self.assertEqual(pins[NODE], node_pin)
            self.assertEqual(pins[SV2 + WORKER], sha(b'new worker'))
        pkgm = os.path.join(self.fx.dir, 'pkg-manifest.json')
        json.dump(manifest([(p, sha(p.encode())) for p in OWN] + [(NODE, own_pin), (SV2 + WORKER, sha(b'new worker'))]), open(pkgm, 'w'))
        self.assertEqual(run('check', pkgm, self.fx.installed_manifest, tree, '--toolchain-node', own_pin).returncode, 0)
        self.assertNotEqual(run('check', pkgm, self.fx.installed_manifest, tree).returncode, 0)   # the copy's node is not this package's
        self.assertNotEqual(run('pins', self.fx.installed_manifest, os.path.join(self.fx.dir, 'x.json'), tree, '--toolchain-node', 'nope').returncode, 0)

    def test_a_commit_without_the_nodes_profile_uses_the_toolchains_copy(self):
        tree = os.path.join(self.fx.w, 'tree-' + COMMIT[:8])   # the fixture tree carries only TURING's profile, like a0e15a91
        c = self.load(dict(self.doc, node='desk-w-591', nodeProfile='config/node-profile.desk-w-591.json',
                           linux=dict(self.doc['linux'], distribution='CluedResident-Linux')))
        prof, prof_sha = rconfig.node_profile(c, tree)
        self.assertEqual(prof['nodeName'], 'desk-w-591')
        self.assertEqual(prof_sha, hashlib.sha256(rconfig.canonical(prof).encode()).hexdigest())
        self.assertEqual(rconfig.node_profile(self.fx.cfg, tree)[0], PROFILE)   # a profile in the commit's tree still wins

    def test_node_inputs_carry_the_configured_node_only(self):
        ni = load('node_inputs', os.path.join(RE, 'tools', 'node-inputs.py'))
        policy = {'node': PROFILE, 'nodeProfileSha256': 'old', 'companion': {'userSid': PROFILE['ownerSid'], 'enabled': True},
                  'linux': {'distribution': PROFILE['wslDistribution'], 'stage': 1}, 'train': {'max': 3}}
        companion = {'companion': {'node': PROFILE, 'nodeProfileSha256': 'old', 'distribution': PROFILE['wslDistribution'], 'relayScript': 'r'},
                     'status': {'node': 'turing'}, 'repo': 'tdoljyj/cross-memory-system'}
        p, c = ni.derive(policy, companion, DESK, 'new', '1' * 8 + '-1111-4111-8111-' + '1' * 12, '2' * 8 + '-2222-4222-8222-' + '2' * 12)
        self.assertEqual((p['node'], p['nodeProfileSha256'], p['companion']['userSid'], p['linux']['distribution']), (DESK, 'new', DESK['ownerSid'], 'CluedResident-Linux'))
        self.assertEqual((c['companion']['node'], c['companion']['distribution'], c['status']['node']), (DESK, 'CluedResident-Linux', 'desk-w-591'))
        self.assertEqual((p['train'], p['linux']['stage'], c['repo'], c['companion']['relayScript']), ({'max': 3}, 1, 'tdoljyj/cross-memory-system', 'r'))
        self.assertEqual(p['ownerAcceptance']['decisionRef'][:8], '1' * 8)
        with self.assertRaises(SystemExit) as e:   # a base-node value left in another field (a path under its profile directory)
            ni.derive(dict(policy, spool=PROFILE['ownerProfileDirectory'] + '\\spool'), companion, DESK, 'new', '1' * 8 + '-1111-4111-8111-' + '1' * 12, '2' * 8 + '-2222-4222-8222-' + '2' * 12)
        self.assertIn('NODE_INPUT_KEEPS_THE_BASE_NODE', str(e.exception))
        with self.assertRaises(SystemExit) as e:   # the base inputs disagree about their own node
            ni.derive(dict(policy, companion={'userSid': 'S-1-5-21-0-0-0-0'}), companion, DESK, 'new', '1' * 8 + '-1111-4111-8111-' + '1' * 12, '2' * 8 + '-2222-4222-8222-' + '2' * 12)
        self.assertIn('BASE_POLICY_USER_SID_NOT_ITS_OWNER', str(e.exception))


if __name__ == '__main__':
    unittest.main()
