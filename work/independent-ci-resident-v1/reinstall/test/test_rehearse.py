"""Offline tests of the reinstall rehearsal and configuration (no host access: a fake Host answers for the node).

Regression cases (README.md section 5): the three refusals of the r7 TURING reinstall must each be a rehearsal finding before any final:
  1. the Linux resident manifest kept the INSTALLED external pins although the new commit changed those Source files (Linux A/B);
  2. the role derivation refused a Source file the new commit changed (PINNED_FILE_CHANGED_IN_NEW_COMMIT_REPIN_NEEDED, Linux A);
  3. the launcher accepted only uninstall plan /2 while the installed uninstall writes /3 (UNINSTALL_PLAN_REFUSED, launcher f3).
  python -I -m unittest discover -s test -p "test_*.py"     (from reinstall/)
"""
import base64, datetime, hashlib, importlib.util, json, os, shutil, subprocess, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
RE = os.path.dirname(HERE)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


rehearse = load('rehearse', os.path.join(RE, 'rehearse.py'))
rconfig = rehearse.rconfig
fixture_paths = load('fixture_paths', os.path.join(HERE, 'fixture_paths.py'))
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
                      'ciSourceManifestSha256': sha(src_manifest), 'manifestSha256': sha(im), 'roles': self.facts_roles,
                      'upgradeToolSha256': 'd' * 64,
                      'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
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
        self.cfg_path = os.path.join(self.dir, 'config.json')
        win = lambda p: fixture_paths.win(self.cfg_path, p)   # the configuration names Windows paths on every host
        cfg_doc = {'contract': rconfig.CONTRACT, 'node': 'turing', 'nodeProfile': 'config/node-profile.turing.json', 'workDir': win(w), 'repo': 'C:\\repo',
                   'basePackage': 'C:\\base', 'nodeRecord': {}, 'nodeExe': 'C:\\node.exe', 'policyInput': 'C:\\p.json', 'companionInput': 'C:\\c.json',
                   'upgradeTokenFile': 'C:\\t\\resident-upgrade.token', 'runner': {'binary': '"C:\\r\\RunnerService.exe"', 'sddl': 'D:(A;;;;;SY)'},
                   'launcher': {'pauseReason': 'p', 'rearmReason': 'r', 'w1PauseReason': 'w'},
                   'linux': {'distribution': 'Ubuntu-24.04', 'installedManifest': win(self.installed_manifest), 'installedRoles': win(os.path.join(inst_dir, 'roles-v3')),
                             'host': HOST_FACTS}}
        json.dump(cfg_doc, open(self.cfg_path, 'w'))
        self.cfg = self.load(self.cfg_path)

    def load(self, path):
        """rconfig.load (its Windows-path checks, as on the node), then this fixture's local paths for the C:\\fixture stand-ins."""
        return fixture_paths.localize(rconfig.load(path), path)

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class FakeHost:
    """The installed node as the rehearsal sees it. uninstall_contract / upgrader / derive answer what the r7 TURING host answered."""
    def __init__(self, fx, uninstall_contract=3, upgrader=True, derive=None, verify='partial', probe=None, file_locks=None):
        self.fx, self.files, self.verify = fx, {}, verify
        self.probe = {'checkHostExit': 0, 'checkHost': '{"status":"HOST_PINS_AS_DERIVED"}', 'v1Head': HOST_FACTS['v1SourceHead'],
                      'v1Qualifications': {'gitleaks': True, 'trivy': True, 'contract-placement': True}, **(probe or {})}
        self.probe_argv = None
        self.locks = {'contract': 'clued.independent-ci.rehearsal-file-locks/1', 'status': 'OBSERVED',
                      'coverage': 'installed-public-binaries-only', 'fileCount': 3, 'secretsEnumerated': False,
                      'directoryHandlesCovered': False, 'lockers': (file_locks or {}).get('external', []),
                      'external': [], **(file_locks or {})}
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
        self.live_facts = json.loads(json.dumps(fx.facts))
        self.live_exit = 0
        self.live_exception = None

    def path(self, *rel):
        return rel

    def exists(self, p):
        return p in self.json

    def read_json(self, p):
        return json.loads(json.dumps(self.json[p]))

    def read_facts(self, p):
        if isinstance(p, tuple):
            if p not in self.json:
                raise FileNotFoundError()
            return json.dumps(self.json[p]).encode('utf-8')
        return rehearse.Host().read_facts(p)

    def live_version_facts(self, distribution):
        self.live_distribution = distribution
        if self.live_exception is not None:
            raise self.live_exception
        return self.live_exit, json.dumps(self.live_facts).encode('utf-8')

    def sha(self, p):
        return '7' * 64

    def file_locks(self):
        return self.locks

    def powershell(self, script, args):
        if script[-1] == 'uninstall-resident.ps1':
            return 0, json.dumps(self.uninstall), ''
        if script[-1] == 'verify-resident.ps1' and self.verify == 'denied':
            return 1, '', 'Test-Path : Access is denied (+ FullyQualifiedErrorId : ItemExistsUnauthorizedAccessError)'
        if script[-1] == 'verify-resident.ps1' and self.verify == 'failed':
            return 1, json.dumps({'status': 'RESIDENT_VERIFICATION_FAILED', 'checks': {'a': {'ok': False}}}), ''
        if script[-1] == 'verify-resident.ps1' and self.verify == 'input-unreadable':
            return 1, json.dumps({'status': 'RESIDENT_VERIFICATION_FAILED', 'checks': {'install-receipt': {'ok': True, 'detail': None},
                                  'verify-inputs': {'ok': False, 'detail': 'VERIFY_INPUT_UNREADABLE'}}}), ''
        if script[-1] == 'verify-resident.ps1' and self.verify == 'input-unreadable-and-failed':
            return 1, json.dumps({'status': 'RESIDENT_VERIFICATION_FAILED', 'checks': {'a': {'ok': False},
                                  'verify-inputs': {'ok': False, 'detail': 'VERIFY_INPUT_UNREADABLE'}}}), ''
        if script[-1] == 'verify-resident.ps1' and self.verify == 'receipt-changed':
            return 1, json.dumps({'status': 'RESIDENT_VERIFICATION_FAILED', 'checks': {'install-receipt': {'ok': False, 'detail': 'INSTALL_RECEIPT_CHANGED'}}}), ''
        if script[-1] == 'verify-resident.ps1':
            return 2, json.dumps({'status': 'RESIDENT_PARTIALLY_VERIFIED_RUN_ELEVATED', 'checks': {'a': {'ok': True}, 'b': {'ok': 'unreadable'}}}), ''
        raise AssertionError(script)

    def service_present(self, name):
        return self.upgrader

    def wsl_python(self, distribution, argv, user=None):
        if user == 'root':   # the read-only host probe
            self.probe_argv = argv
            return 0, json.dumps(self.probe), ''
        self.derive_user = user
        self.derive_argv = argv
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

    def snapshot(self, facts=None, raw=None):
        path = os.path.join(self.fx.dir, 'snapshot.json')
        with open(path, 'wb') as f:
            f.write(raw if raw is not None else json.dumps(facts if facts is not None else self.fx.facts).encode('utf-8'))
        return path

    def test_explicit_snapshot_recovers_missing_mailbox_without_writing_it(self):
        host = FakeHost(self.fx)
        key = ('upgrade', 'mailbox', 'responses', 'version-facts.json')
        del host.json[key]
        path = self.snapshot()
        before = open(path, 'rb').read()
        report = self.run_with(host, linux_version_facts=path)
        self.assertEqual(report['status'], 'REHEARSAL_PASS', report['findings'])
        self.assertEqual(report['checks']['linuxFactsInput']['source'], 'explicit-snapshot')
        self.assertEqual(report['checks']['linuxFactsInput']['sha256'], sha(before))
        self.assertEqual(host.live_distribution, self.fx.cfg['linux']['distribution'])
        self.assertIsNotNone(host.probe_argv)   # the real-root host probe is still required
        self.assertIsNotNone(host.derive_argv)  # the normal-user role derivation is still required
        self.assertNotIn(key, host.json)
        self.assertEqual(open(path, 'rb').read(), before)

    def test_live_reader_uses_only_the_existing_fixed_read_command(self):
        expected = ['wsl.exe', '-d', 'configured-distro', '-u', 'root', '--exec', '/usr/bin/env', '-i',
                    'PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C', 'LC_ALL=C', 'GIT_NO_REPLACE_OBJECTS=1',
                    '/usr/bin/python3.12', '-I', '/opt/clued-independent-ci/upgrade-v1/bin/clued-ci-upgrade-linux', 'version-facts']
        with mock.patch.object(rehearse.subprocess, 'run', return_value=mock.Mock(returncode=0, stdout=b'original stdout')) as run:
            self.assertEqual(rehearse.Host().live_version_facts('configured-distro'), (0, b'original stdout'))
        run.assert_called_once_with(expected, capture_output=True, timeout=90)

    def test_snapshot_and_live_observation_can_have_different_fresh_timestamps(self):
        host = FakeHost(self.fx)
        host.live_facts['observedAt'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=1)).isoformat()
        self.assertNotEqual(host.live_facts['observedAt'], self.fx.facts['observedAt'])
        self.assertEqual(self.run_with(host, linux_version_facts=self.snapshot())['status'], 'REHEARSAL_PASS')

    def test_missing_mailbox_or_explicit_snapshot_is_a_finding(self):
        for explicit in (False, True):
            host = FakeHost(self.fx)
            del host.json[('upgrade', 'mailbox', 'responses', 'version-facts.json')]
            kw = {'linux_version_facts': os.path.join(self.fx.dir, 'missing.json')} if explicit else {}
            report = self.run_with(host, **kw)
            self.assertEqual(report['status'], 'REHEARSAL_FAILED')
            self.assertIn('LINUX_FACTS_MISSING', codes(report))
            self.assertIsNotNone(host.probe_argv)

    def test_unreadable_mailbox_is_a_finding(self):
        host = FakeHost(self.fx)
        host.read_facts = lambda p: (_ for _ in ()).throw(PermissionError())
        self.assertIn('LINUX_FACTS_UNREADABLE', codes(self.run_with(host)))

    def test_bad_json_and_oversized_facts_are_findings(self):
        for raw in (b'{', b'[]', b'null', b'\xff', b' ' * (rehearse.FACTS_MAX_BYTES + 1),
                    b'{"contract":"x","contract":"y"}', b'[' * 2000 + b']' * 2000):
            with self.subTest(raw=raw[:30]):
                report = self.run_with(FakeHost(self.fx), linux_version_facts=self.snapshot(raw=raw))
                self.assertEqual(report['status'], 'REHEARSAL_FAILED')
                self.assertIn('LINUX_FACTS_INVALID', codes(report))

    def test_malformed_default_mailbox_is_a_finding(self):
        for value in (None, [], {}, {'contract': 'wrong'}):
            with self.subTest(value=value):
                host = FakeHost(self.fx)
                host.json[('upgrade', 'mailbox', 'responses', 'version-facts.json')] = value
                self.assertIn('LINUX_FACTS_INVALID', codes(self.run_with(host)))

    def test_fact_shape_rejects_role_path_injection_missing_roles_and_bad_hashes(self):
        for change in ({'generation': True}, {'contract': 'wrong'}, {'roles': {'../outside': self.fx.facts_roles['gitleaks']}},
                       {'roles': {'gitleaks': self.fx.facts_roles['gitleaks']}}, {'sourceCommit': 'wrong'}, {'manifestSha256': None}):
            with self.subTest(change=change):
                report = self.run_with(FakeHost(self.fx), linux_version_facts=self.snapshot(dict(self.fx.facts, **change)))
                self.assertIn('LINUX_FACTS_INVALID', codes(report))

    def test_stale_naive_and_future_facts_fail_closed(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        for timestamp, code in (((now - datetime.timedelta(hours=2)).isoformat(), 'LINUX_FACTS_NOT_FRESH'),
                                ((now + datetime.timedelta(minutes=2)).isoformat(), 'LINUX_FACTS_OBSERVED_IN_FUTURE'),
                                (now.replace(tzinfo=None).isoformat(), 'LINUX_FACTS_OBSERVATION_INVALID'),
                                ('bad', 'LINUX_FACTS_OBSERVATION_INVALID'), (None, 'LINUX_FACTS_OBSERVATION_INVALID')):
            with self.subTest(timestamp=timestamp):
                report = self.run_with(FakeHost(self.fx), linux_version_facts=self.snapshot(dict(self.fx.facts, observedAt=timestamp)))
                self.assertIn(code, codes(report))

    def test_staged_or_failed_pins_facts_fail_closed(self):
        for change in ({'pinsOk': False}, {'staged': {'generation': 2}}):
            with self.subTest(change=change):
                report = self.run_with(FakeHost(self.fx), linux_version_facts=self.snapshot(dict(self.fx.facts, **change)))
                self.assertIn('LINUX_FACTS_NOT_A_SETTLED_GENERATION', codes(report))

    def test_snapshot_wrong_tool_and_generation_still_fail(self):
        for change, code in (({'upgradeToolSha256': '0' * 64}, 'LINUX_FACTS_SNAPSHOT_NOT_THE_LIVE_NODE'),
                             ({'generation': 2}, 'LINUX_FACTS_NOT_THE_GENERATION_RECORD')):
            with self.subTest(change=change):
                report = self.run_with(FakeHost(self.fx), linux_version_facts=self.snapshot(dict(self.fx.facts, **change)))
                self.assertIn(code, codes(report))
                self.assertIn('LINUX_FACTS_SNAPSHOT_NOT_THE_LIVE_NODE', codes(report))

    def test_full_reinstall_can_replace_the_frozen_tool(self):
        tool = os.path.join(self.fx.w, 'tree-' + COMMIT[:8], 'work', 'independent-ci-resident-v1', 'linux', 'bin', 'clued-ci-upgrade-linux')
        os.makedirs(os.path.dirname(tool), exist_ok=True)
        with open(tool, 'wb') as f:
            f.write(b'new frozen tool installed only by this full reinstall')
        self.assertNotEqual(rehearse.sha_file(tool), self.fx.facts['upgradeToolSha256'])
        report = self.run_with(FakeHost(self.fx), linux_version_facts=self.snapshot())
        self.assertEqual(report['status'], 'REHEARSAL_PASS', report['findings'])

    def test_snapshot_needs_live_confirmation_and_all_original_gates(self):
        host = FakeHost(self.fx)
        host.live_facts['sourceCommit'] = 'e' * 40
        self.assertIn('LINUX_FACTS_SNAPSHOT_NOT_THE_LIVE_NODE', codes(self.run_with(host, linux_version_facts=self.snapshot())))
        for kwargs, code in (({'probe': {'checkHostExit': 1}}, 'LINUX_HOST_PINS_NOT_THE_CONFIGURED'),
                             ({'derive': {'status': 'REFUSED', 'code': 'fixture_refusal'}}, 'ROLE_DERIVATION_REFUSED')):
            with self.subTest(code=code):
                self.assertIn(code, codes(self.run_with(FakeHost(self.fx, **kwargs), linux_version_facts=self.snapshot())))

    def test_refused_unavailable_and_stale_live_observations_do_not_accept_snapshot(self):
        path = self.snapshot()
        host = FakeHost(self.fx); host.live_exit = 1
        self.assertIn('LINUX_FACTS_LIVE_OBSERVATION_REFUSED', codes(self.run_with(host, linux_version_facts=path)))
        for error in (OSError(), subprocess.TimeoutExpired('frozen public read', 90)):
            host = FakeHost(self.fx); host.live_exception = error
            self.assertIn('LINUX_FACTS_LIVE_OBSERVATION_UNAVAILABLE', codes(self.run_with(host, linux_version_facts=path)))
        host = FakeHost(self.fx)
        host.live_facts['observedAt'] = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)).isoformat()
        self.assertIn('LINUX_FACTS_LIVE_OBSERVATION_INVALID', codes(self.run_with(host, linux_version_facts=path)))

    def test_explicit_ordinary_user_does_not_change_the_root_host_probe(self):
        self.fx.cfg['linux']['rehearsalUser'] = 'nobody'
        host = FakeHost(self.fx)
        report = self.run_with(host)
        self.assertEqual(report['status'], 'REHEARSAL_PASS', report['findings'])
        self.assertEqual(host.derive_user, 'nobody')
        self.assertEqual(report['checks']['roles']['runAsUser'], 'nobody')
        self.assertIn('/etc/clued-independent-ci/roles-v3', host.probe_argv)

    def test_real_uid_root_refusal_remains_a_finding(self):
        self.fx.cfg['linux']['rehearsalUser'] = 'uid_zero_alias'
        host = FakeHost(self.fx, derive={'status': 'REFUSED', 'code': 'REHEARSAL_DEFAULT_USER_IS_ROOT'})
        report = self.run_with(host)
        self.assertEqual(report['status'], 'REHEARSAL_FAILED')
        self.assertIn('ROLE_DERIVATION_REFUSED', codes(report))

    def test_actual_runner_refuses_real_or_effective_root_before_simulation(self):
        host = FakeHost(self.fx)
        self.run_with(host)
        runner = host.derive_argv[1]
        for uid, euid in ((0, 1000), (1000, 0), (0, 0)):
            with self.subTest(uid=uid, euid=euid):
                prefix = 'import os; os.getuid=lambda:%d; os.geteuid=lambda:%d\n' % (uid, euid)
                result = subprocess.run([__import__('sys').executable, '-I', '-c', prefix + runner], capture_output=True, text=True)
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertEqual(json.loads(result.stdout)['code'], 'REHEARSAL_DEFAULT_USER_IS_ROOT')

    def test_external_binary_lock_is_a_finding_without_stopping_anything(self):
        locker = {'pid': 1234, 'application': 'external fixture', 'startedFileTime': 1, 'expected': False}
        report = self.run_with(FakeHost(self.fx, file_locks={'external': [locker]}))
        self.assertEqual(report['status'], 'REHEARSAL_FAILED')
        self.assertIn('EXTERNAL_RESIDENT_BINARY_LOCK', [row['code'] for row in report['findings']])
        self.assertEqual(report['checks']['fileLocks']['external'], [locker])

    def test_unavailable_file_lock_observation_is_not_a_clean_result(self):
        report = self.run_with(FakeHost(self.fx, file_locks={'status': 'UNAVAILABLE'}))
        self.assertEqual(report['status'], 'REHEARSAL_FAILED')
        self.assertIn('RESIDENT_FILE_LOCK_OBSERVATION_INVALID', [row['code'] for row in report['findings']])

    def test_unknown_locker_cannot_disappear_from_external_list(self):
        locker = {'pid': 1234, 'startedFileTime': 1, 'expected': False}
        report = self.run_with(FakeHost(self.fx, file_locks={'lockers': [locker], 'external': []}))
        self.assertEqual(report['status'], 'REHEARSAL_FAILED')
        self.assertIn('RESIDENT_FILE_LOCK_OBSERVATION_INVALID', codes(report))

    def test_missing_creation_identity_is_not_expected(self):
        locker = {'pid': 1234, 'expected': True}
        report = self.run_with(FakeHost(self.fx, file_locks={'lockers': [locker]}))
        self.assertIn('RESIDENT_FILE_LOCK_OBSERVATION_INVALID', codes(report))

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

    def test_the_package_run_leaves_the_installed_linux_manifest_to_phase_a(self):
        open(self.fx.installed_manifest, 'ab').write(b' ')   # the configuration's file is not a copy of the installed manifest
        self.assertIn('INSTALLED_LINUX_MANIFEST_COPY_STALE', codes(self.run_with(FakeHost(self.fx))))
        os.remove(self.fx.installed_manifest)   # the package run names a file that is not there, on purpose
        with self.assertRaises(OSError):
            self.run_with(FakeHost(self.fx))    # without --fleet a missing copy is never a clean result
        r = self.run_with(FakeHost(self.fx), installed_linux_in_phase_a=True)
        self.assertEqual((r['status'], r['findings']), ('REHEARSAL_PASS', []))
        self.assertEqual(r['checks']['linux']['installedManifestCopy'], {'deferredTo': 'linux-phase-a', 'reason': 'INSTALLED_MANIFEST_BYTES_NOT_ON_WINDOWS', 'expectedSha256': self.fx.facts['manifestSha256']})
        self.assertNotIn('installedManifestCopySha256', r['checks']['linux'])
        self.assertEqual((r['checks']['pins']['notTheNewSource'], r['checks']['pins']['installedShape']['deferredTo']), ([], 'linux-phase-a'))
        self.assertGreaterEqual(r['checks']['pins']['externalPins'], 1)
        with self.assertRaises(AssertionError) as usage:
            rehearse.main(['no-config-is-read', '--commit', COMMIT, '--package', self.fx.pkg, '--fleet'])
        self.assertIn('--fleet goes with --file-locks-in-launcher', str(usage.exception))
        # an external pin that is not the new commit's file is still found here
        fx = Fixture(package_pins_follow_new=False); self.addCleanup(fx.close)
        os.remove(fx.installed_manifest)
        self.assertIn('LINUX_EXTERNAL_PINS_NOT_THE_NEW_SOURCE', codes(rehearse.rehearse(fx.cfg, COMMIT, fx.pkg, FakeHost(fx), skip_roles=True, installed_linux_in_phase_a=True)))
        # everything else about the installed Linux is still checked here
        open(os.path.join(self.fx.cfg['linux']['installedRoles'], 'trivy.json'), 'wb').write(b'older policy')
        self.assertIn('INSTALLED_ROLES_COPY_STALE', codes(self.run_with(FakeHost(self.fx), installed_linux_in_phase_a=True)))

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

    def test_installed_verify_bounded_unreadable_input(self):
        # DESK 2026-11-08: non-elevated, the installed verify cannot open broker\token.json and answers with its bounded JSON
        # (verify-inputs = VERIFY_INPUT_UNREADABLE) instead of failing without JSON; that is "not runnable unelevated" too.
        r = self.run_with(FakeHost(self.fx, verify='input-unreadable'))
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings']); self.assertTrue(r['checks']['verify']['notRunnableUnelevated'])
        # another failed check beside it, or a fixed code other than the unreadable one, is still a finding
        self.assertIn('INSTALLED_VERIFY_NOT_PASSING', codes(self.run_with(FakeHost(self.fx, verify='input-unreadable-and-failed'))))
        self.assertIn('INSTALLED_VERIFY_NOT_PASSING', codes(self.run_with(FakeHost(self.fx, verify='receipt-changed'))))

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

    # a node without Source v1 (Z1 first install, README section 6): rehearses to PASS on its roles-v3 lineage; fails closed otherwise
    def test_a_node_without_source_v1(self):
        doc = json.load(open(self.fx.cfg_path))
        doc['linux']['host'] = dict(HOST_FACTS, v1SourceHead=None)
        p = os.path.join(self.fx.dir, 'no-v1.json'); json.dump(doc, open(p, 'w'))
        cfg = self.fx.load(p)
        z1 = {'v1Head': None, 'v1Qualifications': {r: False for r in ('gitleaks', 'trivy', 'contract-placement')}, 'v1Present': [],
              'v2Qualifications': {r: True for r in ('gitleaks', 'trivy', 'contract-placement')}}
        run = lambda probe: rehearse.rehearse(cfg, COMMIT, self.fx.pkg, FakeHost(self.fx, probe=dict(z1, **probe)))
        r = run({})
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings'])
        self.assertEqual(codes(run({'v1Present': ['/etc/clued-independent-ci/roles']})), ['LINUX_NODE_HAS_A_SOURCE_V1_NOT_CONFIGURED'])
        self.assertEqual(codes(run({'v1Head': 'f' * 40, 'v1Present': ['/opt/clued-independent-ci/source-first-formal-v1']})),
                         ['LINUX_V1_SOURCE_HEAD_NOT_THE_CONFIGURED', 'LINUX_NODE_HAS_A_SOURCE_V1_NOT_CONFIGURED'])
        self.assertEqual(codes(run({'v2Qualifications': {'gitleaks': True, 'trivy': False, 'contract-placement': True}})), ['LINUX_INSTALLED_V2_QUALIFICATIONS_MISSING'])
        self.assertEqual(codes(run({'v2Qualifications': None})), ['LINUX_INSTALLED_V2_QUALIFICATIONS_MISSING'])   # an older probe answer: neither form
        # a v1 node's configuration with a node that has no v1: the v1 lineage is missing, refused as before
        self.assertTrue({'LINUX_V1_SOURCE_HEAD_NOT_THE_CONFIGURED', 'LINUX_V1_QUALIFICATIONS_MISSING'} <= set(codes(self.run_with(FakeHost(self.fx, probe=z1)))))

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


OPERATOR = 'S-1-5-21-1-2-3-1000'   # the Owner who runs the rehearsal; PROFILE['ownerSid'] is the companion account (M5-b)
ACCOUNT_KEY, WSL_KEY = ('install', 'companion-account.json'), ('install', 'companion-wsl.json')
ROLES_PUBLIC_KEY = ('upgrade', 'mailbox', 'responses', 'roles-public.json')


class CompanionHost(FakeHost):
    """A node whose resident distribution is registered to the companion account: the Owner's WSL cannot see it, so any wsl call fails
    the test. The role derivation runs through windows_python."""
    def __init__(self, fx, **kw):
        super().__init__(fx, **kw)
        self.json[ACCOUNT_KEY] = {'contract': 'clued.independent-ci.companion-account/1', 'companionSid': PROFILE['ownerSid'], 'operatorSid': OPERATOR}
        self.json[WSL_KEY] = {'contract': 'clued.independent-ci.companion-wsl/1', 'distro': fx.cfg['linux']['distribution'], 'target': 'D:\\w\\ext4.vhdx',
                              'companionSid': PROFILE['ownerSid'], 'stage': 'qualified', 'imported': True, 'qualifiedAt': '2026-11-10T10:30:00Z'}
        self.json[ROLES_PUBLIC_KEY] = self.roles_public()
        self.windows_argv = self.windows_installed = None

    def roles_public(self, generation=1, files=None):
        files = files or {name: (b'q ' if name.endswith('.qualification.json') else b'policy ') + name.split('.')[0].encode() for name in rehearse.ROLES_PUBLIC_NAMES}
        return {'contract': 'clued.independent-ci.linux-roles-public/1', 'generation': generation, 'factsObservedAt': self.fx.facts['observedAt'],
                'observedAt': '2026-11-12T12:00:00.123Z', 'files': {n: {'sha256': sha(b), 'base64': base64.b64encode(b).decode()} for n, b in files.items()}}

    def read_bounded(self, p, limit):
        if p not in self.json:
            raise FileNotFoundError()
        v = self.json[p]
        return v if isinstance(v, bytes) else json.dumps(v).encode('utf-8')

    def wsl_python(self, distribution, argv, user=None):
        raise AssertionError('wsl called on a companion node')

    def live_version_facts(self, distribution):
        raise AssertionError('wsl called on a companion node')

    def windows_python(self, argv):
        self.windows_argv = argv
        installed = argv[argv.index('--installed') + 1]
        self.windows_installed = (installed, {n: open(os.path.join(installed, n), 'rb').read() for n in os.listdir(installed)})
        return (0 if self.derive.get('status') == 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN' else 1), json.dumps(self.derive), ''


class CompanionNode(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()
        self.addCleanup(self.fx.close)
        os.makedirs(os.path.join(self.fx.w, 'rehearsal', 'src-' + COMMIT[:8] + '.git'))
        self.fx.cfg['operatorSid'] = OPERATOR
        self.fx.cfg['companionAccount'] = {'wslVhdxDirectory': 'D:\\w'}
        which = mock.patch.object(rehearse.shutil, 'which', return_value='C:\\Program Files\\Git\\cmd\\git.exe')
        which.start(); self.addCleanup(which.stop)

    def run_with(self, host, **kw):
        return rehearse.rehearse(self.fx.cfg, COMMIT, self.fx.pkg, host, **kw)

    def test_happy_path_calls_no_wsl_and_derives_on_windows(self):
        host = CompanionHost(self.fx)
        r = self.run_with(host)
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings'])
        self.assertEqual(r['checks']['linuxHost'], {'deferredTo': 'launch-phase-A', 'reason': 'COMPANION_ACCOUNT_DISTRIBUTION'})
        self.assertEqual(r['checks']['companionAccount'], {'records': True, 'companionSid': PROFILE['ownerSid'], 'operatorSid': OPERATOR, 'wslStage': 'qualified'})
        self.assertEqual(r['checks']['linux']['rolesCopySource'], 'companion-roles-public')
        self.assertEqual(r['checks']['linux']['rolesCopy'], self.fx.facts_roles)
        self.assertEqual(r['checks']['roles']['runAsUser'], 'windows-non-elevated-operator')
        self.assertEqual(r['checks']['roles']['repinned'], {'gitleaks': {'entrySha256': {'old': 'o', 'new': 'n'}}})
        argv = host.windows_argv
        self.assertEqual(argv[:4], ['-c', rehearse.WINDOWS_ROLE_RUNNER, os.path.join(RE, 'linux', 'tools', 'derive-roles.py'), 'C:\\Program Files\\Git\\cmd\\git.exe'])
        self.assertEqual(argv[argv.index('--old-manifest-file') + 1], os.path.join(self.fx.cfg['linux']['installedRoles'], 'formal-source-manifest-v2.json'))
        self.assertEqual(argv[argv.index('--commit') + 1], COMMIT)
        installed, files = host.windows_installed
        self.assertEqual(files, {n: open(os.path.join(self.fx.cfg['linux']['installedRoles'], n), 'rb').read() for n in rehearse.ROLES_PUBLIC_NAMES})   # = the copy
        self.assertFalse(os.path.exists(os.path.dirname(installed)))   # the private temporary directory is gone
        self.assertIsNone(host.probe_argv)

    def test_config_copy_may_be_absent_but_never_different(self):
        rd = self.fx.cfg['linux']['installedRoles']
        for name in rehearse.ROLES_PUBLIC_NAMES:
            os.remove(os.path.join(rd, name))
        r = self.run_with(CompanionHost(self.fx))
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings'])
        open(os.path.join(rd, 'trivy.json'), 'wb').write(b'older policy')
        self.assertEqual([(f['code'], f.get('file')) for f in self.run_with(CompanionHost(self.fx))['findings']],
                         [('INSTALLED_ROLES_COPY_NOT_THE_COMPANION_COPY', 'trivy.json')])

    def test_roles_public_that_does_not_check_out_is_a_finding(self):
        def changed(host, edit):
            doc = host.roles_public(); edit(doc); return doc
        other = {n: b'other ' + n.encode() for n in rehearse.ROLES_PUBLIC_NAMES}
        cases = (
            (lambda h: changed(h, lambda d: d['files']['trivy.json'].update(sha256='0' * 64)), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: changed(h, lambda d: d['files']['trivy.json'].update(base64=d['files']['trivy.json']['base64'] + '\n')), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: changed(h, lambda d: d['files'].pop('trivy.json')), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: changed(h, lambda d: d.update(extra=1)), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: changed(h, lambda d: d.update(contract='x')), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: changed(h, lambda d: d.update(observedAt='yesterday')), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: json.dumps(h.roles_public()).replace('"generation"', '"generation": 1, "generation"', 1).encode(), 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: b'\xff', 'ROLES_PUBLIC_COPY_INVALID'),
            (lambda h: h.roles_public(generation=2), 'ROLES_PUBLIC_COPY_OTHER_GENERATION'),
            (lambda h: h.roles_public(files=other), 'ROLES_PUBLIC_COPY_NOT_THE_FACTS'),
            (lambda h: None, 'ROLES_PUBLIC_COPY_MISSING'),
        )
        for make, code in cases:
            with self.subTest(code=code):
                host = CompanionHost(self.fx)
                value = make(host)
                if value is None:
                    del host.json[ROLES_PUBLIC_KEY]
                else:
                    host.json[ROLES_PUBLIC_KEY] = value
                r = self.run_with(host)
                self.assertEqual(codes(r), [code, 'ROLE_DERIVATION_NOT_REHEARSED'])
                self.assertIsNone(host.windows_argv)
        host = CompanionHost(self.fx)
        host.read_bounded = lambda p, limit: (_ for _ in ()).throw(PermissionError()) if p == ROLES_PUBLIC_KEY else CompanionHost.read_bounded(host, p, limit)
        self.assertEqual(codes(self.run_with(host)), ['ROLES_PUBLIC_COPY_UNREADABLE', 'ROLE_DERIVATION_NOT_REHEARSED'])

    def test_derivation_refusal_keeps_its_semantics(self):
        refusal = {'status': 'REFUSED', 'code': 'PINNED_FILE_CHANGED_IN_NEW_COMMIT_REPIN_NEEDED', 'role': 'gitleaks', 'key': 'entrySha256'}
        r = self.run_with(CompanionHost(self.fx, derive=refusal))
        self.assertEqual(r['findings'], [{'code': 'ROLE_DERIVATION_REFUSED', 'refusal': refusal['code'], 'role': 'gitleaks', 'key': 'entrySha256'}])
        with mock.patch.object(rehearse.shutil, 'which', return_value=None):
            host = CompanionHost(self.fx)
            r = self.run_with(host)
        self.assertEqual([f.get('refusal') for f in r['findings']], ['WINDOWS_GIT_NOT_FOUND'])
        self.assertIsNone(host.windows_argv)

    def test_malformed_or_inconsistent_companion_records_fail_closed(self):
        account = CompanionHost(self.fx).json[ACCOUNT_KEY]
        wsl = CompanionHost(self.fx).json[WSL_KEY]
        cases = (
            ({ACCOUNT_KEY: None}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'MISSING'),
            ({ACCOUNT_KEY: dict(account, extra=1)}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'SHAPE'),
            ({ACCOUNT_KEY: dict(account, operatorSid=PROFILE['ownerSid'])}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'SHAPE'),
            ({ACCOUNT_KEY: dict(account, operatorSid='S-1-5-18')}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'SHAPE'),
            ({ACCOUNT_KEY: dict(account, contract='clued.independent-ci.companion-account/2')}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'SHAPE'),
            ({ACCOUNT_KEY: json.dumps(account).replace('"operatorSid"', '"operatorSid": "%s", "operatorSid"' % OPERATOR, 1).encode()}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'SHAPE'),
            ({ACCOUNT_KEY: b'{'}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'SHAPE'),
            ({ACCOUNT_KEY: dict(account, companionSid='S-1-5-21-1-2-3-1009')}, 'COMPANION_ACCOUNT_RECORD_REFUSED', 'COMPANION_NOT_THE_PROFILE_OWNER'),
            ({WSL_KEY: None}, 'COMPANION_WSL_RECORD_REFUSED', 'MISSING'),
            ({WSL_KEY: []}, 'COMPANION_WSL_RECORD_REFUSED', 'SHAPE'),
            ({WSL_KEY: dict(wsl, contract='x')}, 'COMPANION_WSL_RECORD_REFUSED', 'SHAPE'),
            ({WSL_KEY: {k: v for k, v in wsl.items() if k != 'target'}}, 'COMPANION_WSL_RECORD_REFUSED', 'SHAPE'),
            ({WSL_KEY: dict(wsl, stage='moved')}, 'COMPANION_WSL_RECORD_REFUSED', 'NOT_QUALIFIED'),
            ({WSL_KEY: dict(wsl, stage='restored')}, 'COMPANION_WSL_RECORD_REFUSED', 'NOT_QUALIFIED'),
            ({WSL_KEY: dict(wsl, distro='Ubuntu')}, 'COMPANION_WSL_RECORD_REFUSED', 'NOT_THIS_DISTRIBUTION_AND_ACCOUNT'),
            ({WSL_KEY: dict(wsl, companionSid=OPERATOR)}, 'COMPANION_WSL_RECORD_REFUSED', 'NOT_THIS_DISTRIBUTION_AND_ACCOUNT'),
        )
        for change, code, reason in cases:
            with self.subTest(code=code, reason=reason, change=str(change)[:80]):
                host = CompanionHost(self.fx)
                for key, value in change.items():
                    if value is None:
                        del host.json[key]
                    else:
                        host.json[key] = value
                r = self.run_with(host)   # CompanionHost fails on any wsl call
                self.assertEqual([(f['code'], f.get('reason')) for f in r['findings']], [(code, reason)])
                self.assertEqual(r['checks']['linuxHost'], rehearse.DEFERRED_HOST_PROBE)
        self.fx.cfg['operatorSid'] = 'S-1-5-21-1-2-3-1002'
        r = self.run_with(CompanionHost(self.fx))
        self.assertEqual(r['findings'], [{'code': 'COMPANION_ACCOUNT_NOT_THE_CONFIGURED', 'installed': OPERATOR, 'configured': 'S-1-5-21-1-2-3-1002'}])

    def test_explicit_snapshot_cannot_be_corroborated_without_wsl(self):
        path = os.path.join(self.fx.dir, 'snapshot.json')
        open(path, 'w').write(json.dumps(self.fx.facts))
        r = self.run_with(CompanionHost(self.fx), linux_version_facts=path)
        self.assertEqual(r['findings'], [{'code': 'LINUX_FACTS_LIVE_OBSERVATION_UNAVAILABLE', 'reason': 'COMPANION_ACCOUNT_DISTRIBUTION'}])

    def test_companion_processes_still_lock_as_external(self):
        locker = {'pid': 4321, 'application': 'CluedCompanionSupervisor', 'startedFileTime': 1, 'expected': False}
        r = self.run_with(CompanionHost(self.fx, file_locks={'external': [locker]}))
        self.assertEqual(r['findings'], [{'code': 'EXTERNAL_RESIDENT_BINARY_LOCK', 'processes': [locker], 'companionProcessIdentity': 'UNREADABLE_NON_ELEVATED'}])

    def test_the_package_launcher_takes_over_the_lock_finding_on_a_companion_node_only(self):
        locker = {'pid': 4321, 'application': 'CluedCompanionSupervisor', 'startedFileTime': 1, 'expected': False}
        r = self.run_with(CompanionHost(self.fx, file_locks={'external': [locker]}), file_locks_in_launcher=True)
        self.assertEqual((r['status'], r['findings']), ('REHEARSAL_PASS', []))
        self.assertEqual(r['checks']['fileLocksFinding'], {'deferredTo': 'launch-elevated-file-locks', 'reason': 'COMPANION_PROCESS_IDENTITY_UNREADABLE_NON_ELEVATED', 'processes': [locker]})
        self.assertEqual(r['checks']['fileLocks']['external'], [locker])   # what was seen stays in the report
        # an observation that is not valid is never left to the launcher
        bad = self.run_with(CompanionHost(self.fx, file_locks={'status': 'UNREADABLE'}), file_locks_in_launcher=True)
        self.assertIn('RESIDENT_FILE_LOCK_OBSERVATION_INVALID', [f['code'] for f in bad['findings']])
        # a launcher template without the elevated step cannot take the finding over
        with tempfile.TemporaryDirectory(prefix='rt') as d:
            old = os.path.join(d, 'template.ps1')
            with open(os.path.join(RE, 'launcher', 'template.ps1'), encoding='utf-8') as f, open(old, 'w', encoding='utf-8') as g:
                g.write(f.read().replace('$fileLocks = Step-FileLocks', '$fileLocks = $null'))
            r = self.run_with(CompanionHost(self.fx, file_locks={'external': [locker]}), file_locks_in_launcher=True, template_path=old)
            self.assertEqual([f['code'] for f in r['findings']], ['LAUNCHER_HAS_NO_ELEVATED_FILE_LOCK_STEP'])
        # a node without a companion account can tell its lockers apart non-elevated: the finding stays
        fx = Fixture(); self.addCleanup(fx.close)
        r = rehearse.rehearse(fx.cfg, COMMIT, fx.pkg, FakeHost(fx, file_locks={'external': [locker]}), file_locks_in_launcher=True, skip_roles=True)
        self.assertIn('EXTERNAL_RESIDENT_BINARY_LOCK', [f['code'] for f in r['findings']]); self.assertNotIn('fileLocksFinding', r['checks'])

    def test_a_node_without_companion_records_is_unchanged(self):
        host = FakeHost(self.fx)
        host.windows_python = lambda argv: self.fail('a node without a companion account derives in its WSL')
        r = self.run_with(host)
        self.assertEqual(r['status'], 'REHEARSAL_PASS', r['findings'])
        self.assertIsNotNone(host.probe_argv)
        self.assertIsNotNone(host.derive_argv)
        self.assertNotIn('companionAccount', r['checks'])
        self.assertNotIn('rolesCopySource', r['checks']['linux'])
        self.assertNotIn('deferredTo', r['checks']['linuxHost'])


@unittest.skipUnless(os.name == 'nt' and shutil.which('git'), 'the Windows runner needs Windows and git')
class WindowsRoleRunner(unittest.TestCase):
    """The real derive-roles.py through WINDOWS_ROLE_RUNNER with this Windows Python and git: the tool's POSIX-only parts are supplied."""
    def test_derive_roles_runs_unchanged_on_windows(self):
        import ctypes
        if ctypes.windll.shell32.IsUserAnAdmin():
            self.skipTest('the runner refuses an elevated token')
        d = tempfile.mkdtemp(prefix='derive-win-'); self.addCleanup(rehearse.remove_tree, d)
        ci = 'work/actions-hosted-migration/independent-ci-v1/'
        blobs = {ci + 'worker/qualification-v2.mjs': b'q', ci + 'src/worker-v2.mjs': b'w', ci + 'src/proof.mjs': b'p', ci + 'src/job-v2.mjs': b'j', 'entry/linux-worker.mjs': b'entry new\n'}
        repo = os.path.join(d, 'repo')
        for rel, data in blobs.items():
            os.makedirs(os.path.dirname(os.path.join(repo, *rel.split('/'))), exist_ok=True)
            open(os.path.join(repo, *rel.split('/')), 'wb').write(data)
        git = lambda *a: subprocess.run(['git'] + list(a), check=True, capture_output=True, text=True).stdout.strip()
        git('init', '-q', repo); git('-C', repo, '-c', 'core.autocrlf=false', 'add', '.')
        git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'c')
        commit = git('-C', repo, 'rev-parse', 'HEAD')
        bare = os.path.join(d, 'src.git')
        git('init', '-q', '--bare', '--initial-branch=accepted', bare); git('-C', bare, 'fetch', '-q', '--no-tags', repo, commit + ':refs/heads/accepted')
        old_ref, ref, href = '2' * 8 + '-2222-4222-8222-' + '2' * 12, '1' * 8 + '-1111-4111-8111-' + '1' * 12, '3' * 8 + '-3333-4333-8333-' + '3' * 12
        roles = ('gitleaks', 'trivy', 'contract-placement')
        old_m = json.dumps({'roles': {r: {'controllerRelay': {'sourceAcceptanceRef': old_ref, 'hostQualificationRef': old_ref}} for r in roles}}).encode()
        new_m = json.dumps({'sourceSha': commit, 'roles': {r: {'controllerRelay': {'sourceAcceptanceRef': ref, 'hostQualificationRef': href}} for r in roles}}).encode()
        inst = os.path.join(d, 'installed'); os.mkdir(inst)
        open(os.path.join(d, 'old.json'), 'wb').write(old_m); open(os.path.join(d, 'new.json'), 'wb').write(new_m)
        pol = {'sourceManifestSha256': sha(old_m), 'sourceAcceptanceRef': old_ref, 'hostAcceptanceRef': old_ref, 'entryFile': SV2 + 'entry/linux-worker.mjs',
               'entrySha256': sha(b'entry old\n'), 'qualificationSha256': sha(b'q'), 'workerSha256': sha(b'w'), 'proofSha256': sha(b'p'), 'jobSha256': sha(b'j')}
        for r in roles:
            open(os.path.join(inst, r + '.json'), 'w').write(json.dumps(pol))
            open(os.path.join(inst, r + '.qualification.json'), 'w').write(json.dumps({'payload': dict(pol), 'signature': 's'}))
        out = os.path.join(d, 'out')
        code, stdout, stderr = rehearse.Host().windows_python(['-c', rehearse.WINDOWS_ROLE_RUNNER, os.path.join(RE, 'linux', 'tools', 'derive-roles.py'), shutil.which('git'),
            '--installed', inst, '--old-manifest-file', os.path.join(d, 'old.json'), '--new-manifest-file', os.path.join(d, 'new.json'), '--src', bare,
            '--commit', commit, '--source-acceptance-ref', ref, '--host-acceptance-ref', href, '--out', out])
        self.assertEqual(code, 0, stdout + stderr)
        report = json.loads(stdout)
        self.assertEqual(report['status'], 'ROLE_POLICIES_V3_AND_UNSIGNED_PAYLOADS_WRITTEN')
        self.assertEqual(report['roles']['trivy']['repinned'], {'entrySha256': {'old': sha(b'entry old\n'), 'new': sha(b'entry new\n')}})
        written = open(os.path.join(out, 'trivy.json'), 'rb').read()
        self.assertEqual(sha(written), report['roles']['trivy']['policySha256'])   # binary: no newline translation
        self.assertFalse(written.endswith(b'\r\n'))
        rehearse.remove_tree(out)   # the tool's 0400 (read-only) files
        self.assertFalse(os.path.exists(out))


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
        return self.fx.load(p)

    def test_paths_are_windows_paths_on_every_host(self):
        # a regular expression, the same check on the Linux CI host as on the node: a POSIX or forward-slash path is refused
        for bad in ('/tmp/rehearse-x/work', 'C:/Users/x/work', 'work', 'C:\\fixture\\..\\work'):
            with self.subTest(bad=bad), self.assertRaises(rconfig.ConfigError) as e:
                self.load(dict(self.doc, workDir=bad))
            self.assertEqual(str(e.exception), 'CONFIG_PATH_SHAPE workDir')
        self.assertTrue(self.doc['workDir'].startswith('C:\\fixture\\'), self.doc['workDir'])   # the fixture never names a host path
        self.assertEqual(self.fx.cfg['workDir'], self.fx.w)

    def test_optional_rehearsal_user_is_a_normal_username_and_bound_by_config_hash(self):
        default = self.load(self.doc)
        self.assertNotIn('rehearsalUser', default['linux'])
        for user in ('nobody', 'ci_user-1', None):
            configured = self.load(dict(self.doc, linux=dict(self.doc['linux'], rehearsalUser=user)))
            self.assertEqual(configured['linux']['rehearsalUser'], user)
            self.assertNotEqual(default['_sha256'], configured['_sha256'])
        for user in ('root', '0', '', ' nobody', '-u', 'user name', '../nobody', 'x;id', 'x\n', 1000, False, []):
            with self.subTest(user=user), self.assertRaises(rconfig.ConfigError) as error:
                self.load(dict(self.doc, linux=dict(self.doc['linux'], rehearsalUser=user)))
            self.assertEqual(error.exception.code, 'CONFIG_LINUX_REHEARSAL_USER')

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

    # Z1: another node's own result signer (public half only)
    def test_signer_is_an_ed25519_public_key_only(self):
        pem = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + 'A' * 43 + '=\n-----END PUBLIC KEY-----\n'
        good = {'keyId': 'desk-w-591-result-1', 'runtimeId': 'DESK-W-591-cluedresident-independent-ci-v1', 'publicKeyPem': pem}
        self.assertEqual(self.load(dict(self.doc, signer=good))['signer'], good)
        self.assertIsNone(self.load(self.doc)['signer'])
        for bad in (dict(good, publicKeyPem='-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI' + 'A' * 43 + '\n-----END PRIVATE KEY-----\n'),
                    dict(good, publicKeyPem=pem.replace('MCowBQYDK2VwAyEA', 'MIIBIjANBgkqhkiG')),   # an RSA key is not the worker's
                    dict(good, keyId='Desk W'), {k: v for k, v in good.items() if k != 'runtimeId'}):
            with self.assertRaises(rconfig.ConfigError, msg=bad):
                self.load(dict(self.doc, signer=bad))

    # M5-b (ADR 0023): the Owner who runs the launcher (operatorSid) and where the resident distribution moves; both or neither
    def test_companion_account_operator_and_vhdx_directory(self):
        op = 'S-1-5-21-858977881-4031698862-3006450925-1000'
        ca = {'wslVhdxDirectory': 'D:\\clued-resident\\wsl\\CluedResident-Linux'}
        got = self.load(dict(self.doc, operatorSid=op, companionAccount=ca))
        self.assertEqual((got['operatorSid'], got['companionAccount']), (op, ca))
        plain = self.load(self.doc)
        self.assertEqual((plain['operatorSid'], plain['companionAccount']), (None, None))
        for bad, code in ((dict(self.doc, operatorSid=op), 'CONFIG_COMPANION_ACCOUNT_NEEDS_BOTH'),
                          (dict(self.doc, companionAccount=ca), 'CONFIG_COMPANION_ACCOUNT_NEEDS_BOTH'),
                          (dict(self.doc, operatorSid='S-1-5-18', companionAccount=ca), 'CONFIG_OPERATOR_SID'),
                          (dict(self.doc, operatorSid=op, companionAccount={'wslVhdxDirectory': 'D:\\a b'}), 'CONFIG_COMPANION_ACCOUNT'),
                          (dict(self.doc, operatorSid=op, companionAccount={'wslVhdxDirectory': 'D:\\a\\..\\b'}), 'CONFIG_COMPANION_ACCOUNT'),
                          (dict(self.doc, operatorSid=op, companionAccount=dict(ca, more=1)), 'CONFIG_COMPANION_ACCOUNT')):
            with self.assertRaises(rconfig.ConfigError, msg=bad) as e:
                self.load(bad)
            self.assertEqual(e.exception.code, code)

    # DESIGN 41.6a: the optional heartbeat token file (path only) and, only with it, its binding id
    def test_heartbeat_token_file_and_binding_id(self):
        bid = '3b0c8a7e-1111-4222-8333-444455556666'
        self.assertIsNone(self.load(self.doc)['heartbeat'])
        self.assertEqual(self.load(dict(self.doc, heartbeat={'tokenFile': 'C:\\t\\hb.token'}))['heartbeat'], {'tokenFile': 'C:\\t\\hb.token', 'bindingId': None})
        self.assertEqual(self.load(dict(self.doc, heartbeat={'tokenFile': 'C:\\t\\hb.token', 'bindingId': bid}))['heartbeat']['bindingId'], bid)
        for bad in ({'bindingId': bid}, {'tokenFile': 'C:\\t\\hb.token', 'bindingId': 'REPLACE_ME'}, {'tokenFile': 'C:\\t\\h$(x).token'},
                    {'tokenFile': self.doc['upgradeTokenFile']}, {'tokenFile': 'C:\\t\\hb.token', 'token': 'x'}, 'C:\\t\\hb.token'):
            with self.assertRaises(rconfig.ConfigError, msg=bad) as e:
                self.load(dict(self.doc, heartbeat=bad))
            self.assertIn(e.exception.code, ('CONFIG_HEARTBEAT', 'CONFIG_SECRET_SHAPED_KEY'))

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
            if name == 'new-node.example.json':   # the generic example: a new node adds its own profile (README section 8c)
                continue
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
        return self.fx.load(p)

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
