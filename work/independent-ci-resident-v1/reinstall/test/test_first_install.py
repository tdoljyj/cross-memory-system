"""Offline tests of the first-install signer (linux/tools/sign-first-qualification.mjs, signFirst) and of the first-install configuration
gate (rconfig.need_first_install_linux). Throwaway Ed25519 keys made by node for the test only; no host access.
  python -I -m unittest discover -s test -p "test_*.py"     (from reinstall/)
"""
import copy, hashlib, importlib.util, json, os, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RE = os.path.dirname(HERE)
SIGN_FIRST = os.path.join(RE, 'linux', 'tools', 'sign-first-qualification.mjs')
spec = importlib.util.spec_from_file_location('rconfig', os.path.join(RE, 'tools', 'rconfig.py'))
rconfig = importlib.util.module_from_spec(spec); spec.loader.exec_module(rconfig)
sha = lambda b: hashlib.sha256(b).hexdigest()
ROLES = ('gitleaks', 'trivy', 'contract-placement')
NODE = '/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node'
FACTS = ('prCannotReadSignerKey', 'noControllerMounts', 'noCredentials', 'networkDisabled', 'cleanupQualified')

DRIVER = r"""
import fs from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [mode, arg] = process.argv.slice(2);
const m = await import(pathToFileURL(process.env.SIGN_FIRST).href);
const { canonicalJson } = await import(pathToFileURL(process.env.SIGN_FIRST.replace('sign-first-qualification', 'sign-qualification-v2')).href);
if (mode === 'keys') {
  const k = generateKeyPairSync('ed25519');
  console.log(JSON.stringify({ priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: k.publicKey.export({ type: 'spki', format: 'pem' }) }));
} else if (mode === 'sign') {
  const a = JSON.parse(fs.readFileSync(arg, 'utf8'));
  console.log(JSON.stringify({ payload: a.payload, signature: sign(null, Buffer.from(canonicalJson(a.payload)), a.priv).toString('base64') }));
} else {
  const a = JSON.parse(fs.readFileSync(arg, 'utf8'));
  try {
    console.log(JSON.stringify(m.signFirst({ keyPem: a.keyPem, pubPem: a.pubPem, templateDir: a.templateDir, templatePubPem: a.templatePubPem,
      templatePubSha256: a.templatePubSha256, inDir: a.inDir, outDir: a.outDir, now: new Date('2026-10-30T00:00:00Z') })));
  } catch (e) { console.log(JSON.stringify({ status: 'REFUSED', code: e.code ?? String(e) })); }
}
"""


class SignFirst(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = self.tmp.name
        self.driver = os.path.join(self.d, 'driver.mjs')
        open(self.driver, 'w', encoding='utf-8').write(DRIVER)
        self.tkey, self.nkey = self.node('keys'), self.node('keys')

    def tearDown(self):
        self.tmp.cleanup()

    def node(self, mode, arg=None):
        if arg is not None:
            p = os.path.join(self.d, 'arg-%d.json' % len(os.listdir(self.d)))
            open(p, 'w', encoding='utf-8').write(json.dumps(arg)); arg = p
        r = subprocess.run(['node', self.driver, mode] + ([arg] if arg else []), capture_output=True, text=True, env={**os.environ, 'SIGN_FIRST': SIGN_FIRST})
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def policy(self, role, key_id, runtime, manifest, ref):
        return {'schema': 'independent-ci.linux-policy.v3', 'role': role, 'formalEnabled': True, 'signingKeyFile': '/etc/clued-independent-ci/verify-result-key.pem',
                'publicKeyFile': '/etc/clued-independent-ci/verify-result-public.pem', 'nodeExecutable': NODE, 'runtimeIdentity': runtime,
                'sourceManifestSha256': manifest, 'image': 'img@sha256:' + '1' * 64, 'entrySha256': '2' * 64, 'qualificationSha256': '3' * 64,
                'executionMode': 'scanner', 'workerSha256': '4' * 64, 'proofSha256': '5' * 64, 'jobSha256': '6' * 64, 'keyId': key_id,
                'hostAcceptanceRef': ref, 'sourceAcceptanceRef': ref}

    def payload(self, pol, pub_sha, qualified_at):
        p = {k: pol[k] for k in ('runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256',
                                 'proofSha256', 'jobSha256', 'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef')}
        p.update({'schema': 'independent-ci.runtime-qualification.v2', 'fixture': False, 'role': pol['role'], 'qualifiedAt': qualified_at, 'expiresAt': None,
                  'resultPublicKeySha256': pub_sha, 'isolation': 'root-managed-single-job-container', **{k: True for k in FACTS}})
        return p

    def build(self, mutate=None, node_key=None):
        node_key = node_key or self.nkey
        tdir, idir = os.path.join(self.d, 'template'), os.path.join(self.d, 'in')
        os.makedirs(tdir, exist_ok=True); os.makedirs(idir, exist_ok=True)
        for role in ROLES:
            tpol = self.policy(role, 'turing-result-key', 'turing-runtime', 'a' * 64, '11111111-1111-4111-8111-111111111111')
            q = self.node('sign', {'priv': self.tkey['priv'], 'payload': self.payload(tpol, sha(self.tkey['pub'].encode()), '2026-10-20T00:00:00.000Z')})
            open(os.path.join(tdir, role + '.qualification.json'), 'w', encoding='utf-8').write(json.dumps(q))
            pol = self.policy(role, 'desk-w-591-result-key', 'desk-w-591-runtime', 'b' * 64, '22222222-2222-4222-8222-222222222222')
            pol['workerSha256'] = '7' * 64   # a Source pin derive-roles repinned from the commit
            pay = self.payload(pol, sha(node_key['pub'].encode()), None)
            if mutate:
                mutate(role, pol, pay)
            open(os.path.join(idir, role + '.json'), 'w', encoding='utf-8').write(json.dumps(pol))
            open(os.path.join(idir, role + '.qualification.payload.json'), 'w', encoding='utf-8').write(json.dumps(pay))
        return {'keyPem': node_key['priv'], 'pubPem': node_key['pub'], 'templateDir': tdir, 'templatePubPem': self.tkey['pub'],
                'templatePubSha256': sha(self.tkey['pub'].encode()), 'inDir': idir, 'outDir': os.path.join(self.d, 'out')}

    def test_signs_with_the_node_key_when_only_node_and_record_values_differ(self):
        r = self.node('first', self.build())
        self.assertEqual(r['status'], 'FIRST_QUALIFICATIONS_V2_SIGNED', r)
        self.assertEqual(r['publicKeySha256'], sha(self.nkey['pub'].encode()))
        self.assertFalse(r['privateKeyPrinted'])
        q = json.load(open(os.path.join(self.d, 'out', 'trivy.qualification.json'), encoding='utf-8'))
        self.assertEqual((q['payload']['keyId'], q['payload']['qualifiedAt']), ('desk-w-591-result-key', '2026-10-30T00:00:00.000Z'))

    def test_a_template_value_changed_outside_node_and_record_is_refused(self):
        def image(role, pol, pay):
            pol['image'] = pay['image'] = 'img@sha256:' + '9' * 64
        self.assertEqual(self.node('first', self.build(image))['code'], 'PAYLOAD_DIFFERS_FROM_THE_TEMPLATE_OUTSIDE_NODE_AND_RECORD_VALUES')

    def test_the_template_key_as_node_key_is_refused(self):
        self.assertEqual(self.node('first', self.build(node_key=self.tkey))['code'], 'NODE_KEY_IS_THE_TEMPLATE_KEY')

    def test_an_unpinned_template_key_is_refused(self):
        a = self.build(); a['templatePubSha256'] = '0' * 64
        self.assertEqual(self.node('first', a)['code'], 'TEMPLATE_PUBLIC_KEY_NOT_THE_PINNED_ONE')

    def test_a_template_qualification_not_signed_by_the_template_key_is_refused(self):
        a = self.build()
        p = os.path.join(a['templateDir'], 'gitleaks.qualification.json')
        q = json.load(open(p, encoding='utf-8')); q['payload']['image'] = 'img@sha256:' + '8' * 64
        open(p, 'w', encoding='utf-8').write(json.dumps(q))
        self.assertEqual(self.node('first', a)['code'], 'TEMPLATE_QUALIFICATION_REFUSED')
        self.assertFalse(os.path.exists(a['outDir']))


class FirstInstallConfig(unittest.TestCase):
    PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA' + 'A' * 43 + '=\n-----END PUBLIC KEY-----\n'

    def cfg(self, **host):
        h = {'toolchainNodeSha256': 'b' * 64, 'resultPublicKeySha256': sha(self.PEM.encode()), 'v1SourceHead': None}; h.update(host)
        return {'linux': {'installedRoles': None, 'host': h}, 'signer': {'keyId': 'desk-w-591-result-key', 'runtimeId': 'desk-w-591-runtime', 'publicKeyPem': self.PEM}}

    def test_a_node_without_linux_ci_with_its_signer_passes(self):
        rconfig.need_first_install_linux(self.cfg())

    def test_refusals(self):
        c = self.cfg(); c['linux']['installedRoles'] = 'C:\\x\\roles-v3'
        for cfg, code in ((c, 'NODE_HAS_AN_INSTALLED_LINUX_CI'), (self.cfg(v1SourceHead='f' * 40), 'NODE_HAS_AN_INSTALLED_LINUX_CI'),
                          (self.cfg(toolchainNodeSha256=None), 'FIRST_INSTALL_NEEDS_THE_NODES_HOST_FACTS'),
                          (self.cfg(resultPublicKeySha256='c' * 64), 'FIRST_INSTALL_SIGNER_NOT_THE_NODES_RESULT_KEY')):
            with self.assertRaises(rconfig.ConfigError) as e:
                rconfig.need_first_install_linux(cfg)
            self.assertEqual(e.exception.code, code)


if __name__ == '__main__':
    unittest.main()
