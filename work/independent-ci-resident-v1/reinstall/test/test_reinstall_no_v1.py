"""Offline tests of the reinstall path for a node WITHOUT Source v1 (first installed by Z1, README section 6): the signer
(linux/tools/sign-qualification-no-v1.mjs, signNoV1; throwaway Ed25519 keys made by node) and the Linux kit generator (linux/prep.py) on
fixture inputs, for a node with v1 (unchanged) and one without. Nothing runs as root, nothing touches WSL or the host.
  python -I -m unittest discover -s test -p "test_*.py"     (from reinstall/)
"""
import datetime, hashlib, importlib.util, json, os, shlex, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RE = os.path.dirname(HERE)
SIGN = os.path.join(RE, 'linux', 'tools', 'sign-qualification-no-v1.mjs')
PREP = os.path.join(RE, 'linux', 'prep.py')
FIXTURE_PATHS = os.path.join(HERE, 'fixture_paths.py')   # the configuration names C:\fixture\... on every host
_spec = importlib.util.spec_from_file_location('fixture_paths', FIXTURE_PATHS)
fixture_paths = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(fixture_paths)
sha = lambda b: hashlib.sha256(b).hexdigest()


def rd(*p):
    with open(os.path.join(*p), 'rb') as f:
        return f.read()


rj = lambda *p: json.loads(rd(*p).decode('utf-8'))
ROLES = ('gitleaks', 'trivy', 'contract-placement')
NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node'
FACTS = ('prCannotReadSignerKey', 'noControllerMounts', 'noCredentials', 'networkDisabled', 'cleanupQualified')
OLD_REF, NEW_REF = '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'

DRIVER = r"""
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [mode, arg] = process.argv.slice(2);
const m = await import(pathToFileURL(process.env.SIGN).href);
const { canonicalJson } = await import(pathToFileURL(process.env.SIGN.replace('sign-qualification-no-v1', 'sign-qualification-v2')).href);
if (mode === 'keys') {
  const k = generateKeyPairSync('ed25519');
  console.log(JSON.stringify({ priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) }));
} else if (mode === 'sign') {
  const a = JSON.parse(fs.readFileSync(arg, 'utf8'));
  console.log(JSON.stringify({ payload: a.payload, signature: sign(null, Buffer.from(canonicalJson(a.payload)), a.priv).toString('base64') }));
} else {
  const a = JSON.parse(fs.readFileSync(arg, 'utf8'));
  try {
    console.log(JSON.stringify(m.signNoV1({ keyPem: a.keyPem, pubPem: a.pubPem, v1Dir: a.v1Dir, installedDir: a.installedDir, inDir: a.inDir, outDir: a.outDir,
      now: new Date('2026-10-31T00:00:00Z') })));
  } catch (e) { console.log(JSON.stringify({ status: 'REFUSED', code: e.code ?? String(e) })); }
}
"""


class SignNoV1(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = self.tmp.name
        self.driver = os.path.join(self.d, 'driver.mjs')
        with open(self.driver, 'w', encoding='utf-8') as f:
            f.write(DRIVER)
        self.key, self.other = self.node('keys'), self.node('keys')

    def tearDown(self):
        self.tmp.cleanup()

    def node(self, mode, arg=None):
        if arg is not None:
            p = os.path.join(self.d, 'arg-%d.json' % len(os.listdir(self.d)))
            with open(p, 'w', encoding='utf-8') as f:
                f.write(json.dumps(arg))
            arg = p
        r = subprocess.run(['node', self.driver, mode] + ([arg] if arg else []), capture_output=True, text=True, env={**os.environ, 'SIGN': SIGN})
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def policy(self, role, manifest, ref, worker='4' * 64):
        return {'schema': 'independent-ci.linux-policy.v3', 'role': role, 'formalEnabled': True, 'signingKeyFile': '/etc/clued-independent-ci/verify-result-key.pem',
                'publicKeyFile': '/etc/clued-independent-ci/verify-result-public.pem', 'nodeExecutable': NODE, 'runtimeIdentity': 'NODE-cluedresident-independent-ci-v1',
                'sourceManifestSha256': manifest, 'image': 'img@sha256:' + '1' * 64, 'entrySha256': '2' * 64, 'qualificationSha256': '3' * 64,
                'executionMode': 'scanner', 'entryFile': '/opt/clued-independent-ci/source-v2/entry.mjs', 'workerSha256': worker, 'proofSha256': '5' * 64,
                'jobSha256': '6' * 64, 'keyId': 'node-first-run-20261030', 'hostAcceptanceRef': ref, 'sourceAcceptanceRef': ref, 'dockerExecutableSha256': '9' * 64}

    def payload(self, pol, pub_sha, qualified_at):
        p = {k: pol[k] for k in ('runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256',
                                 'proofSha256', 'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef')}
        p.update({'schema': 'independent-ci.runtime-qualification.v2', 'fixture': False, 'role': pol['role'], 'qualifiedAt': qualified_at, 'expiresAt': None,
                  'resultPublicKeySha256': pub_sha, 'isolation': 'root-managed-single-job-container', **{k: True for k in FACTS}})
        return p

    def build(self, mutate=None, installed_key=None):
        """The installed roles-v3 (signed by the node's key, Z1) and derive-roles' output for the new commit (Source values changed)."""
        installed_key = installed_key or self.key
        idir, ndir = os.path.join(self.d, 'roles-v3'), os.path.join(self.d, 'in')
        os.makedirs(idir, exist_ok=True); os.makedirs(ndir, exist_ok=True)
        pub_sha = sha(self.key['pub'].encode())
        for role in ROLES:
            ipol = self.policy(role, 'a' * 64, OLD_REF)
            q = self.node('sign', {'priv': installed_key['priv'], 'payload': self.payload(ipol, sha(installed_key['pub'].encode()), '2026-10-30T00:00:00.000Z')})
            with open(os.path.join(idir, role + '.qualification.json'), 'w', encoding='utf-8') as f:
                f.write(json.dumps(q))
            with open(os.path.join(idir, role + '.json'), 'w', encoding='utf-8') as f:
                f.write(json.dumps(ipol))
            pol = self.policy(role, 'b' * 64, NEW_REF, worker='7' * 64)   # derive-roles: manifest, refs, a repinned Source file
            pay = self.payload(pol, pub_sha, None)
            if mutate:
                mutate(role, pol, pay)
            with open(os.path.join(ndir, role + '.json'), 'w', encoding='utf-8') as f:
                f.write(json.dumps(pol))
            with open(os.path.join(ndir, role + '.qualification.payload.json'), 'w', encoding='utf-8') as f:
                f.write(json.dumps(pay))
        return {'keyPem': self.key['priv'], 'pubPem': self.key['pub'], 'v1Dir': os.path.join(self.d, 'roles'), 'installedDir': idir, 'inDir': ndir,
                'outDir': os.path.join(self.d, 'out')}

    def test_signs_when_only_source_values_differ_from_the_installed_role(self):
        r = self.node('sign-no-v1', self.build())
        self.assertEqual(r['status'], 'QUALIFICATIONS_V2_SIGNED_FROM_INSTALLED_V2', r)
        self.assertFalse(r['privateKeyPrinted'])
        q = rj(self.d, 'out', 'trivy.qualification.json')
        self.assertEqual((q['payload']['workerSha256'], q['payload']['qualifiedAt']), ('7' * 64, '2026-10-31T00:00:00.000Z'))

    def test_a_node_with_source_v1_is_refused(self):
        a = self.build(); os.makedirs(a['v1Dir'])
        self.assertEqual(self.node('sign-no-v1', a)['code'], 'NODE_HAS_A_SOURCE_V1_USE_SIGN_QUALIFICATION_V2')
        self.assertFalse(os.path.exists(a['outDir']))

    def test_an_installed_qualification_not_signed_by_the_node_key_is_refused(self):
        self.assertEqual(self.node('sign-no-v1', self.build(installed_key=self.other))['code'], 'INSTALLED_V2_QUALIFICATION_FACTS_REFUSED')

    def test_a_tampered_installed_qualification_is_refused(self):
        a = self.build()
        p = os.path.join(a['installedDir'], 'gitleaks.qualification.json')
        q = rj(p); q['payload']['networkDisabled'] = False
        with open(p, 'w', encoding='utf-8') as f:
            f.write(json.dumps(q))
        self.assertEqual(self.node('sign-no-v1', a)['code'], 'INSTALLED_V2_QUALIFICATION_FACTS_REFUSED')

    def test_no_installed_qualification_fails_closed(self):
        a = self.build(); os.remove(os.path.join(a['installedDir'], 'contract-placement.qualification.json'))
        self.assertEqual(self.node('sign-no-v1', a)['code'], 'ENOENT')
        self.assertFalse(os.path.exists(a['outDir']))

    def test_a_value_outside_the_source_values_is_refused(self):
        def runtime(role, pol, pay):
            pay['containerUser'] = 'root'
        self.assertEqual(self.node('sign-no-v1', self.build(runtime))['code'], 'PAYLOAD_DIFFERS_FROM_THE_INSTALLED_OUTSIDE_SOURCE_VALUES')
        def docker(role, pol, pay):
            pol['dockerExecutableSha256'] = '8' * 64
        self.assertEqual(self.node('sign-no-v1', self.build(docker))['code'], 'POLICY_DIFFERS_FROM_THE_INSTALLED_OUTSIDE_SOURCE_VALUES')

    def test_another_image_or_key_than_the_installed_is_refused(self):
        def image(role, pol, pay):
            pol['image'] = pay['image'] = 'img@sha256:' + '9' * 64
        self.assertEqual(self.node('sign-no-v1', self.build(image))['code'], 'INSTALLED_V2_QUALIFICATION_FACTS_REFUSED')


def build_prep(d, v1_head):
    """Inputs of linux/prep.py on fixtures: a git repository and its extracted tree, a package, the assembled in-dir, the installed facts."""
    w = os.path.join(d, 'work'); repo = os.path.join(d, 'repo')
    lin = ('work', 'independent-ci-resident-v1', 'linux')
    for base in (repo, os.path.join(w, 'tree')):
        os.makedirs(os.path.join(base, *lin))
        for n in ('install-resident-linux.sh', 'verify-resident-linux.sh', 'uninstall-resident-linux.sh'):
            with open(os.path.join(base, *lin, n), 'wb') as f:
                f.write(b'#!/bin/bash\necho ' + n.encode() + b'\n')
    git = lambda *a: subprocess.run(['git', '-C', repo, '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@e'] + list(a), check=True, capture_output=True)
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'c')
    commit = git('rev-parse', 'HEAD').stdout.decode().strip()
    os.rename(os.path.join(w, 'tree'), os.path.join(w, 'tree-' + commit[:8]))
    pkg = os.path.join(d, 'pkg')
    files = {'record/source-manifest.json': b'{"sourceSha":"%s"}' % commit.encode(), 'record/installation.json': b'{}', 'record/record-manifest.json': b'{}',
             'record/signers.json': b'{}', 'linux/bin/clued-ci-install-source-v2': b'installer\n', 'linux/upgrade-v1/bin/clued-ci-upgrade-linux': b'upgrade\n',
             'linux/upgrade-v1/bin/clued-ci-sign-qualification-v2.mjs': b'upgrade sign\n', 'linux/upgrade-v1/manifest.json': b'{"u":1}',
             'linux/manifest.json': b'{"r":1}', 'linux/bin/clued-ci-resident-linux': b'resident\n'}
    for u in ('worker', 'wsprep', 'archive'):
        files['linux/systemd/clued-ci-%s@.service' % u] = b'[Unit]\n'
    files['record/acceptance.json'] = json.dumps({'sourceAcceptanceRef': 'dddddddd-1111-4111-8111-111111111111', 'hostQualificationRef': 'dddddddd-1111-4111-8111-111111111111',
                                                  'installationReceiptRef': 'eeeeeeee-1111-4111-8111-111111111111', 'ownerReceiptRef': 'eeeeeeee-1111-4111-8111-111111111111',
                                                  'ownerDecisionRef': 'dddddddd-1111-4111-8111-111111111111'}).encode()
    for rel, data in files.items():
        os.makedirs(os.path.dirname(os.path.join(pkg, *rel.split('/'))), exist_ok=True)
        with open(os.path.join(pkg, *rel.split('/')), 'wb') as f:
            f.write(data)
    new = sha(files['record/source-manifest.json'])
    with open(os.path.join(pkg, 'package-manifest.json'), 'w', encoding='utf-8') as f:
        json.dump({'ciSourceManifestSha256': new, 'linux': {'manifestSha256': sha(files['linux/manifest.json'])}}, f)
    ind = os.path.join(w, 'linux', 'in-t')
    copies = {('record', f): ('record', f) for f in ('acceptance.json', 'installation.json', 'record-manifest.json', 'signers.json', 'source-manifest.json')}
    copies.update({('tools', 'clued-ci-install-source-v2'): ('linux', 'bin', 'clued-ci-install-source-v2')})
    copies.update({('linux-pkg', 'upgrade-v1', *f.split('/')): ('linux', 'upgrade-v1', *f.split('/')) for f in ('bin/clued-ci-upgrade-linux', 'bin/clued-ci-sign-qualification-v2.mjs', 'manifest.json')})
    for f in ['manifest.json', 'bin/clued-ci-resident-linux'] + ['systemd/clued-ci-%s@.service' % u for u in ('worker', 'wsprep', 'archive')]:
        copies[('linux-res-pkg', *f.split('/'))] = ('linux', *f.split('/'))
    for dst, src in copies.items():
        os.makedirs(os.path.join(ind, *dst[:-1]), exist_ok=True)
        with open(os.path.join(pkg, *src), 'rb') as a, open(os.path.join(ind, *dst), 'wb') as b:
            b.write(a.read())
    tools = os.path.join(RE, 'linux', 'tools')
    for src, name in (('check-host.py', 'check-host-r4.py'), ('verify-signed.mjs', 'verify-signed-r4.mjs'), ('derive-roles.py', 'derive-roles-r7.py')):
        with open(os.path.join(tools, src), 'rb') as a, open(os.path.join(ind, 'tools', name), 'wb') as b:
            b.write(a.read())
    for n in ('install-resident-linux.sh', 'verify-resident-linux.sh', 'uninstall-resident-linux.sh'):
        with open(os.path.join(w, 'tree-' + commit[:8], *lin, n), 'rb') as a, open(os.path.join(ind, 'tools', n), 'wb') as b:
            b.write(a.read())
    facts = {'contract': 'clued.independent-ci.linux-version-facts/1', 'staged': None, 'pinsOk': True, 'generation': 1, 'sourceCommit': 'c' * 40,
             'ciSourceManifestSha256': 'a' * 64, 'manifestSha256': 'b' * 64}
    gen = {'contract': 'clued.independent-ci.resident-generation/1', 'packageManifestSha256': 'f' * 64,
           'linux': {'generation': 1, 'manifestSha256': 'b' * 64, 'ciSourceManifestSha256': 'a' * 64}}
    for name, doc in (('facts.json', facts), ('gen.json', gen)):
        with open(os.path.join(d, name), 'w', encoding='utf-8') as f:
            json.dump(doc, f)
    cp = os.path.join(d, 'config.json')
    win = lambda p: fixture_paths.win(cp, p)
    cfg = {'contract': 'clued.independent-ci.reinstall-config/1', 'node': 'node-a', 'nodeProfile': 'config/node-profile.node-a.json', 'workDir': win(w), 'repo': win(repo),
           'basePackage': 'C:\\base', 'nodeRecord': {}, 'nodeExe': 'C:\\node.exe', 'policyInput': 'C:\\p.json', 'companionInput': 'C:\\c.json',
           'upgradeTokenFile': 'C:\\t\\resident-upgrade.token', 'runner': {'binary': '"C:\\r\\RunnerService.exe"', 'sddl': 'D:(A;;;;;SY)'},
           'launcher': {'pauseReason': 'p', 'rearmReason': 'r', 'w1PauseReason': 'w'},
           'linux': {'distribution': 'D', 'installedManifest': 'C:\\m.json', 'installedRoles': 'C:\\roles-v3',
                     'host': {'toolchainNodeSha256': 'b' * 64, 'resultPublicKeySha256': 'c' * 64, 'v1SourceHead': v1_head}}}
    with open(cp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f)
    return [cp, commit, new, 'dddddddd-1111-4111-8111-111111111111', pkg, 'draft-t', 'in-t', os.path.join(d, 'facts.json'), os.path.join(d, 'gen.json')], w


def run_prep(argv, prep=PREP):
    # prep.py as on the node (python -I), its configuration's C:\fixture stand-ins read at the fixture's local paths (test/fixture_paths.py)
    return subprocess.run([sys.executable, '-I', FIXTURE_PATHS, prep] + argv, capture_output=True, text=True)


class PrepNoV1(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='rp'); self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def scripts(self, v1_head):
        argv, w = build_prep(self.d, v1_head)
        p = run_prep(argv)
        self.assertEqual(p.returncode, 0, p.stderr[-1500:])
        out = json.loads(p.stdout)
        texts = {n.split('.')[0]: rd(w, 'linux', n).decode('utf-8') for n in out['scripts']}
        return texts, out, w

    def test_a_node_with_source_v1_keeps_the_v1_lineage(self):
        t, out, w = self.scripts('f' * 40)
        self.assertIn('"$STG/tools/sign-qualification-v2.mjs" --in "$STG/roles-in"', t['reinstall-linux-B-switch'])
        self.assertNotIn('sign-qualification-no-v1', ''.join(t.values()))
        self.assertNotIn('NODE_HAS_A_SOURCE_V1', t['reinstall-linux-A-stage'])
        self.assertIn(b'\nV1_HEAD=' + b'f' * 40 + b'\n', rd(w, 'linux', 'in-t', 'tools', 'verify-source-v2.sh'))
        self.assertEqual(out['pinnedFiles'], 23)
        self.assertFalse(os.path.exists(os.path.join(w, 'linux', 'in-t', 'tools', 'sign-qualification-no-v1.mjs')))

    def test_retry_suffix_uses_a_new_base_and_pins_history_before_switching(self):
        argv, w = build_prep(self.d, 'f' * 40)
        first = run_prep(argv)
        self.assertEqual(first.returncode, 0, first.stderr)
        first_base = json.loads(first.stdout)['base']
        argv[5] = 'draft-w2'
        second = run_prep(argv)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertNotEqual(first_base, json.loads(second.stdout)['base'])
        self.assertTrue(json.loads(second.stdout)['base'].endswith('-draft-w2'))
        a = rd(w, 'linux', 'reinstall-linux-A-stage.draft-w2.sh').decode()
        b = rd(w, 'linux', 'reinstall-linux-B-switch.draft-w2.sh').decode()
        self.assertIn('check-reinstall-history.py capture', a.replace('"', ''))
        self.assertIn('upgrade-history.A.json src-head.txt', a)
        self.assertIn('"$STG/tools/check-reinstall-history.py" "$RV/tools/"', a)
        self.assertIn('"$STG/upgrade-history.A.json" "$STG/phaseA.sha256" "$RV/"', a)
        self.assertNotIn('upgrade-v1=yes generations= archive=', a)
        self.assertLess(b.index('verify-live'), b.index('# B1 [PRIVATE KEY]'))
        self.assertIn('verify-kept', b)

    def test_a_node_without_source_v1_signs_from_its_installed_roles(self):
        t, out, w = self.scripts(None)
        a, b = t['reinstall-linux-A-stage'], t['reinstall-linux-B-switch']
        self.assertIn('"$STG/tools/sign-qualification-no-v1.mjs" --in "$STG/roles-in"', b)
        self.assertNotIn('"$STG/tools/sign-qualification-v2.mjs" --in', b)
        # phase A refuses a node that has a v1 after all, before staging; the signer is staged and pinned with every other byte
        self.assertLess(a.index('refuse NODE_HAS_A_SOURCE_V1_CONFIGURE_ITS_HEAD'), a.index('install -d -o root -g root -m 0700 "$BASE"'))
        nov1 = rd(RE, 'linux', 'tools', 'sign-qualification-no-v1.mjs')
        self.assertIn(sha(nov1) + '  tools/sign-qualification-no-v1.mjs\n', a)
        self.assertRegex(a, r'check-host-r4\.py sign-qualification-v2\.mjs verify-source-v2\.sh sign-qualification-no-v1\.mjs check-reinstall-history\.py; do install')
        self.assertEqual(rd(w, 'linux', 'in-t', 'tools', 'sign-qualification-no-v1.mjs'), nov1)
        # verify-source-v2 then checks there is no v1 (its V1_HEAD is empty)
        self.assertIn(b'\nV1_HEAD=\n', rd(w, 'linux', 'in-t', 'tools', 'verify-source-v2.sh'))
        self.assertEqual(out['pinnedFiles'], 24)   # + history verifier and no-v1 signer
        # the same checks of the installed state as for a v1 node: Source v2 head and manifest, the resident, the upgrade channel
        for s in ('quiet_and_installed\n', 'refuse OLD_VERSION_FACTS_NOT_THE_INSTALLED_GENERATION', 'refuse HOST_PINS_CHANGED', 'refuse SIGNED_SET_REFUSED'):
            self.assertIn(s, a + b, s)

    def test_a_changed_no_v1_signer_is_refused(self):
        argv, w = build_prep(self.d, None)
        lt = os.path.join(self.d, 'rt')   # a copy of reinstall/ whose no-v1 signer differs from the pinned one
        shutil.copytree(RE, lt, ignore=shutil.ignore_patterns('test', '__pycache__'))
        with open(os.path.join(lt, 'linux', 'tools', 'sign-qualification-no-v1.mjs'), 'ab') as f:
            f.write(b'// changed\n')
        p = run_prep(argv, prep=os.path.join(lt, 'linux', 'prep.py'))
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('REVIEW_COPY_TOOLS_CHANGED', p.stderr)

    def test_a_first_install_configuration_is_still_refused(self):
        argv, w = build_prep(self.d, None)
        cfg = rj(argv[0]); cfg['linux']['installedRoles'] = None
        with open(argv[0], 'w', encoding='utf-8') as f:
            json.dump(cfg, f)
        p = run_prep(argv)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('NODE_HAS_NO_INSTALLED_LINUX_CI', p.stderr)

    def source_v2_inputs(self):
        argv, w = build_prep(self.d, None)
        bundle = b'fixture bundle\r\nwith binary bytes\x00'
        for base, rel in ((argv[4], ('linux', 'source-v2', 'source.bundle')),
                          (os.path.join(w, 'linux', 'in-t'), ('linux-pkg', 'source-v2', 'source.bundle'))):
            os.makedirs(os.path.join(base, *rel[:-1]))
            with open(os.path.join(base, *rel), 'wb') as f:
                f.write(bundle)
        manifest = rj(argv[4], 'package-manifest.json')
        manifest['linux']['sourceV2'] = {'commit': argv[1], 'bundlePath': 'linux/source-v2/source.bundle',
                                        'bundleSha256': sha(bundle), 'rolesDerivedSha256': {r: str(i + 1) * 64 for i, r in enumerate(ROLES)}}
        with open(os.path.join(argv[4], 'package-manifest.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f)
        return argv, w, manifest

    def final_inputs(self, host_ref):
        argv, w, manifest = self.source_v2_inputs()
        for base in (argv[4], os.path.join(w, 'linux', 'in-t')):
            acceptance = rj(base, 'record', 'acceptance.json')
            acceptance.update(sourceAcceptanceRef=NEW_REF, hostQualificationRef=host_ref,
                              installationReceiptRef='33333333-3333-4333-8333-333333333333',
                              ownerReceiptRef='33333333-3333-4333-8333-333333333333',
                              ownerDecisionRef='44444444-4444-4444-8444-444444444444')
            with open(os.path.join(base, 'record', 'acceptance.json'), 'w', encoding='utf-8') as f:
                json.dump(acceptance, f)
        argv[3], argv[5] = NEW_REF, 'final-t'
        report = os.path.join(self.d, 'public-fixture-rehearsal.json')
        with open(report, 'w', encoding='utf-8') as f:
            json.dump({'contract': 'clued.independent-ci.reinstall-rehearsal/1',
                       'status': 'REHEARSAL_PASS', 'findings': [], 'commit': argv[1],
                       'packageManifestSha256': sha(rd(argv[4], 'package-manifest.json')),
                       'configSha256': sha(rd(argv[0])),
                       'observedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}, f)
        argv.append(report)
        return argv, w, manifest

    def test_final_rejects_an_independent_placeholder_host_ref(self):
        for placeholder in ('dddddddd-1111-4111-8111-111111111111', 'eeeeeeee-1111-4111-8111-111111111111'):
            with self.subTest(host=placeholder):
                # Each generator owns its own inputs/output paths.
                with tempfile.TemporaryDirectory(dir=self.d) as case:
                    original = self.d
                    try:
                        self.d = case
                        argv, _, _ = self.final_inputs(placeholder)
                        p = run_prep(argv)
                    finally:
                        self.d = original
                self.assertNotEqual(p.returncode, 0)
                self.assertIn('FINAL_SCRIPTS_NEED_THE_REAL_OWNER_REFS', p.stderr)

    def test_final_accepts_an_independent_real_host_ref_and_keeps_the_runtime_gate(self):
        argv, w, _ = self.final_inputs(OLD_REF)
        p = run_prep(argv)
        self.assertEqual(p.returncode, 0, p.stderr)
        for name in json.loads(p.stdout)['scripts']:
            text = rd(w, 'linux', name).decode('utf-8')
            self.assertIn('HOST_REF=' + OLD_REF, text)
            self.assertIn('case "$NEW_REF $RECEIPT_REF $HOST_REF"', text)

    def test_phase_a_manifest_rejects_a_bundle_changed_after_staging(self):
        bash = os.environ.get('CLUED_TEST_BASH') or shutil.which('bash')
        if not bash or (os.name == 'nt' and 'git' not in bash.lower()):
            self.skipTest('needs non-WSL Git Bash on Windows or ordinary POSIX bash')
        argv, w, _ = self.source_v2_inputs()
        p = run_prep(argv)
        self.assertEqual(p.returncode, 0, p.stderr)
        text = rd(w, 'linux', 'reinstall-linux-A-stage.draft-t.sh').decode('utf-8')
        line = next(line for line in text.splitlines() if 'sha256sum roles-in/' in line and 'phaseA.sha256' in line)
        args = shlex.split(line.split('sha256sum ', 1)[1].split(' > ', 1)[0])
        self.assertIn('linux-pkg/source-v2/source.bundle', args)
        stage = os.path.join(self.d, 'checksum-stage')
        for arg in args:
            file = os.path.join(stage, *arg.replace('*', 'fixture').split('/'))
            os.makedirs(os.path.dirname(file), exist_ok=True)
            with open(file, 'wb') as f:
                f.write(b'public staged fixture')
        env = dict(os.environ, STG=stage.replace('\\', '/'))
        captured = subprocess.run([bash, '-c', line], env=env, capture_output=True, text=True)
        self.assertEqual(captured.returncode, 0, captured.stderr)
        verify = 'cd "$STG" && sha256sum -c phaseA.sha256'
        self.assertEqual(subprocess.run([bash, '-c', verify], env=env, capture_output=True).returncode, 0)
        with open(os.path.join(stage, 'linux-pkg', 'source-v2', 'source.bundle'), 'ab') as f:
            f.write(b'changed after phase A')
        checked = subprocess.run([bash, '-c', verify], env=env, capture_output=True, text=True)
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn('linux-pkg/source-v2/source.bundle: FAILED', checked.stdout)

    def test_source_bundle_and_each_derived_role_are_pinned_before_source_switch(self):
        argv, w, manifest = self.source_v2_inputs()
        for base in (argv[4], os.path.join(w, 'linux', 'in-t')):
            acceptance = rj(base, 'record', 'acceptance.json')
            acceptance['hostQualificationRef'] = OLD_REF
            with open(os.path.join(base, 'record', 'acceptance.json'), 'w', encoding='utf-8') as f:
                json.dump(acceptance, f)
        p = run_prep(argv)
        self.assertEqual(p.returncode, 0, p.stderr)
        out = json.loads(p.stdout)
        text = rd(w, 'linux', 'reinstall-linux-A-stage.draft-t.sh').decode('utf-8')
        self.assertIn(manifest['linux']['sourceV2']['bundleSha256'] + '  linux-pkg/source-v2/source.bundle', text)
        self.assertIn('--host-acceptance-ref "' + OLD_REF + '"', text)
        for role, expected in manifest['linux']['sourceV2']['rolesDerivedSha256'].items():
            self.assertIn('$STG/roles-in/' + role + '.json', text)
            self.assertIn(expected + ' ] || refuse SOURCE_V2_DERIVED_ROLE_MISMATCH', text)
        self.assertEqual(out['pinnedFiles'], 25)

    def test_generated_bundle_staging_actually_copies_the_pinned_bytes(self):
        bash = os.environ.get('CLUED_TEST_BASH') or shutil.which('bash')
        if not bash or (os.name == 'nt' and 'git' not in bash.lower()):
            self.skipTest('needs non-WSL Git Bash on Windows or ordinary POSIX bash')
        argv, w, manifest = self.source_v2_inputs()
        p = run_prep(argv)
        self.assertEqual(p.returncode, 0, p.stderr)
        text = rd(w, 'linux', 'reinstall-linux-A-stage.draft-t.sh').decode('utf-8')
        fragment = text[text.index('# begin source-v2 bundle staging'):text.index('# end source-v2 bundle staging')]
        staged = os.path.join(self.d, 'actual-stage')
        # The test is never root. On Windows chmod/ownership are not POSIX; exercise the generated paths and real file copy,
        # explicitly leaving ownership/mode qualification to the root-script review and later Linux stage.
        shim = '''install() { local dir=0; local args=(); while (( $# )); do case "$1" in -d) dir=1; shift;; -o|-g|-m) shift 2;; *) args+=("$1"); shift;; esac; done; if (( dir )); then command mkdir -p -- "${args[@]}"; else command cp -- "${args[@]}"; fi; }\n''' if os.name == 'nt' else '''install() { local args=(); while (( $# )); do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; command install "${args[@]}"; }\n'''
        quoted = lambda v: "'" + v.replace('\\', '/').replace("'", "'\\''") + "'"
        script = 'set -euo pipefail\n' + shim + 'W=' + quoted(os.path.join(w, 'linux', 'in-t')) + '\nSTG=' + quoted(staged) + '\n' + fragment
        run = subprocess.run([bash, '--noprofile', '--norc', '-c', script], capture_output=True, text=True, encoding='utf-8', errors='replace')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(sha(rd(staged, 'linux-pkg', 'source-v2', 'source.bundle')), manifest['linux']['sourceV2']['bundleSha256'])

    def test_a_changed_bundle_is_refused_before_any_root_script_is_generated(self):
        argv, w, _ = self.source_v2_inputs()
        with open(os.path.join(w, 'linux', 'in-t', 'linux-pkg', 'source-v2', 'source.bundle'), 'ab') as f:
            f.write(b'changed')
        p = run_prep(argv)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('SOURCE_V2_BUNDLE_CHANGED', p.stderr)

    def test_bundle_for_another_commit_is_refused(self):
        argv, w, manifest = self.source_v2_inputs()
        manifest['linux']['sourceV2']['commit'] = 'f' * 40
        with open(os.path.join(argv[4], 'package-manifest.json'), 'w', encoding='utf-8') as f:
            json.dump(manifest, f)
        p = run_prep(argv)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('SOURCE_V2_NOT_THE_ACCEPTED_COMMIT', p.stderr)


if __name__ == '__main__':
    unittest.main()


@unittest.skipUnless(os.name == 'nt', 'the in/out directories are real Windows paths')
class PrepFleet(unittest.TestCase):
    """The generic node package's form: --in-dir / --out-dir instead of <in-dir-name> (README section 6)."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='rf'); self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def fleet(self, v1_head='f' * 40, out_name='linux-out'):
        argv, w = build_prep(self.d, v1_head)
        legacy = run_prep(argv)
        self.assertEqual(legacy.returncode, 0, legacy.stderr[-1500:])
        # the same inputs, the in-dir moved out of the work directory; prep.py runs from an unpacked package tree (its own
        # ..\..\linux holds the Linux tools), with no extracted git archive and no repository left to read
        ind = os.path.join(self.d, 'in'); os.rename(os.path.join(w, 'linux', 'in-t'), ind)
        unpacked = os.path.join(self.d, 'x', 'R')
        shutil.copytree(RE, os.path.join(unpacked, 'reinstall'), ignore=shutil.ignore_patterns('test', '__pycache__'))
        shutil.copytree(os.path.join(w, 'tree-' + argv[1][:8], 'work', 'independent-ci-resident-v1', 'linux'), os.path.join(unpacked, 'linux'))
        self.prep = os.path.join(unpacked, 'reinstall', 'linux', 'prep.py')
        shutil.rmtree(os.path.join(w, 'tree-' + argv[1][:8])); shutil.rmtree(os.path.join(self.d, 'repo'), onerror=lambda f, p, e: (os.chmod(p, 0o700), f(p)))
        out = os.path.join(self.d, out_name)
        fleet_argv = argv[:6] + ['--in-dir', ind, '--out-dir', out] + argv[7:]
        return argv, w, ind, out, fleet_argv, json.loads(legacy.stdout)

    def test_scripts_read_the_in_dir_and_write_only_the_out_dir(self):
        argv, w, ind, out, fleet_argv, legacy = self.fleet()
        p = run_prep(fleet_argv, prep=self.prep)
        self.assertEqual(p.returncode, 0, p.stderr[-1500:])
        r = json.loads(p.stdout)
        self.assertEqual(sorted(r['scripts']), ['A.sh', 'B-resume.sh', 'B.sh'])
        wsl = lambda x: '/mnt/' + x[0].lower() + x[2:].replace(chr(92), '/')
        self.assertEqual((r['inDir'], r['outDir'], r['wslInDir'], r['wslOutDir'], r['W']), (ind, out, wsl(ind), wsl(out), wsl(ind)))
        self.assertFalse(os.path.exists(out))   # the elevated launcher makes the out directory, not this tool
        texts = {}
        for n in r['scripts']:
            self.assertEqual(r['paths'][n], os.path.join(w, 'linux', n))
            data = rd(w, 'linux', n)
            self.assertEqual(sha(data), r['scripts'][n]); self.assertNotIn(b'\r', data)
            texts[n] = data.decode('utf-8')
        for n, t in texts.items():
            self.assertIn('\nW=' + wsl(ind) + '\nO=' + wsl(out) + '\n[ -d "$O" ] || refuse OUT_DIRECTORY_MISSING\nBASE=', t, n)
            self.assertNotIn('$W/..', t, n)                 # nothing is written next to the in-dir
            self.assertNotIn('R4_CLEAN_ENV', t, n)          # the registrar's fixed environment has no such variable
            self.assertNotIn('WANT_A', t, n); self.assertNotIn('${1', t, n)   # no argument: root-run passes none
            self.assertIn('for v in BASH_ENV ENV NODE_OPTIONS', t, n)        # the environment is still checked clean
            self.assertIn('export PATH=/usr/bin:/bin HOME=/root LANG=C LC_ALL=C', t, n)
        a, b, resume = texts['A.sh'], texts['B.sh'], texts['B-resume.sh']
        self.assertIn('RV="$O/review-A-draft-t"', a)
        # phase A refuses, as root and before it stages anything, an installed Linux that is not the one these scripts were generated for
        # (the facts and generation record prep.py was given: the plan's expectedInstalledLinux; generate.py --fleet-plan cross-checks them)
        for line in ('OLD_LINUX_RES_MANIFEST=' + 'b' * 64 + '\n', 'OLD_MANIFEST=' + 'a' * 64 + '\n', 'OLD_GENERATION=1\n'):
            self.assertIn('\n' + line, a)
        for refusal in ('refuse INSTALLED_MANIFEST_NOT_SOURCE34', '= "$OLD_LINUX_RES_MANIFEST" ] || refuse LINUX_RESIDENT_MANIFEST_NOT_THE_INSTALLED_R5C2', 'refuse OLD_VERSION_FACTS_NOT_THE_INSTALLED_GENERATION'):
            self.assertLess(a.index(refusal), a.index('install -d -o root -g root -m 0700 "$BASE"'), refusal)
        for s in ('VF="$O/linux-version-facts.', 'E="$O/linux-live-manifest.', 'RO="$O/out-B-$SUFFIX-'):
            self.assertIn(s, b); self.assertIn(s, resume)
        for t in (b, resume):
            self.assertIn('[ -s "$STG/phaseA.sha256" ] || refuse PHASE_A_NOT_DONE\n', t)
            self.assertIn('(cd "$STG" && sha256sum --quiet -c phaseA.sha256) || refuse STAGED_BYTES_CHANGED_SINCE_PHASE_A', t)
            self.assertLess(t.index('refuse PHASE_A_NOT_DONE'), t.index('refuse STAGED_BYTES_CHANGED_SINCE_PHASE_A'))
        # everything else is the Owner-run scripts' text: only the gates above and the four output paths differ
        import re as _re
        # what only phase A of a package run has: the guard against a second phase A, and the installed manifest's shape
        guard = _re.search(r"(?s)command -v pgrep >/dev/null \|\| refuse PGREP_REQUIRED\n.*?refuse ANOTHER_PHASE_A_RUNNING\n  done\ndone\n", a)
        shape = _re.search(r"(?s)\$CLEAN \$PY -I -c 'import json,sys\na=json\.load\(open\(sys\.argv\[1\]\)\); b=.*?refuse INSTALLED_LINUX_MANIFEST_NOT_THE_PACKAGES_SHAPE; \}\n", a)
        self.assertTrue(guard and shape)
        self.assertLess(guard.start(), a.index('\nquiet_and_installed\n')); self.assertLess(a.index('refuse RESIDENT_PINS_NOT_THE_NEW_SOURCE'), shape.start()); self.assertLess(shape.start(), a.index('# r7: three read-only plans'))
        self.assertIn('[ -d "$d" ] && [ "$d" != "$STG" ] && [ ! -e "$d/phaseA.sha256" ] || continue', guard.group(0)); self.assertIn("pgrep -f 'linux-run-[0-9a-f]{32}/script\\.sh'", guard.group(0))
        self.assertIn('[ "$pp" != "$$" ] || continue', guard.group(0))   # a command substitution of this shell is not another phase A
        self.assertIn('/opt/clued-independent-ci/resident-v1/manifest.json "$STG/linux-res-pkg/manifest.json"', shape.group(0)); self.assertIn('a.get("contract")==b.get("contract") and p(a)==p(b)', shape.group(0))
        for other in (b, resume):
            self.assertNotIn('ANOTHER_PHASE_A_RUNNING', other); self.assertNotIn('INSTALLED_LINUX_MANIFEST_NOT_THE_PACKAGES_SHAPE', other)
        texts['A.sh'] = a.replace(guard.group(0), '').replace(shape.group(0), '')
        def norm(t):
            return [l for l in t.split('\n') if 'R4_CLEAN_ENV' not in l and 'WANT_A' not in l and 'PHASE_A_NOT_DONE' not in l and not l.startswith('O=')
                    and 'OUT_DIRECTORY_MISSING' not in l and not l.startswith('W=') and '# run by the elevated launcher' not in l and not l.startswith('#   ')]
        for mine, theirs in (('A.sh', 'reinstall-linux-A-stage.draft-t.sh'), ('B.sh', 'reinstall-linux-B-switch.draft-t.sh'), ('B-resume.sh', 'reinstall-linux-B-resume.draft-t.sh')):
            self.assertEqual(norm(texts[mine].replace('$O/', '$W/../')), norm(rd(w, 'linux', theirs).decode('utf-8')), mine)

    def test_the_two_directories_go_together_and_are_plain_paths(self):
        argv, w, ind, out, fleet_argv, _ = self.fleet()
        for bad, code in ((argv[:6] + ['--in-dir', ind] + argv[7:], 'IN_DIR_AND_OUT_DIR_GO_TOGETHER'), (argv[:6] + ['--out-dir', out] + argv[7:], 'IN_DIR_AND_OUT_DIR_GO_TOGETHER'),
                          (argv[:6] + ['--in-dir', ind, '--out-dir', out + ' x'] + argv[7:], 'OUT_DIR_PATH_SHAPE'), (argv[:6] + ['--in-dir', ind, '--out-dir', out + '.'] + argv[7:], 'OUT_DIR_PATH_SHAPE'), (argv[:6] + ['--in-dir', ind, '--out-dir', out + "';id;'"] + argv[7:], 'OUT_DIR_PATH_SHAPE'),
                          (argv[:6] + ['--in-dir', ind + chr(92) + '..' + chr(92) + 'in', '--out-dir', out] + argv[7:], 'IN_DIR_PATH_SHAPE'), (argv[:6] + ['--in-dir', chr(92) * 2 + 'server' + chr(92) + 'share' + chr(92) + 'in', '--out-dir', out] + argv[7:], 'IN_DIR_PATH_SHAPE'),
                          (argv[:6] + ['--in-dir', ind, '--out-dir', os.path.join(ind, 'out')] + argv[7:], 'OUT_DIR_INSIDE_IN_DIR'), (argv[:6] + ['--in-dir', ind, '--out-dir', ind] + argv[7:], 'OUT_DIR_INSIDE_IN_DIR')):
            p = run_prep(bad, prep=self.prep)
            self.assertNotEqual(p.returncode, 0, code); self.assertIn(code, p.stderr, code)
            self.assertFalse(os.path.exists(os.path.join(w, 'linux', 'A.sh')), code)

    def test_scripts_are_never_overwritten(self):
        argv, w, ind, out, fleet_argv, _ = self.fleet()
        self.assertEqual(run_prep(fleet_argv, prep=self.prep).returncode, 0)
        again = run_prep(fleet_argv, prep=self.prep)
        self.assertNotEqual(again.returncode, 0); self.assertIn('FileExistsError', again.stderr)
