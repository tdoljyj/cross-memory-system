// linux/bin/clued-ci-sign-qualification-v2.mjs (task 018da927 B3): the original v1-referenced signing and the in-place
// upgrade mode that signs against the INSTALLED v2 qualification. Offline, temporary directories only. The Ed25519 key is
// generated in memory for this test (never a real result key, never written to the repository).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FIXED, ROLES, SOURCE_KEYS, canonicalJson, signAll } from '../linux/bin/clued-ci-sign-qualification-v2.mjs';
import { validatePolicyShape, validateQualificationPayload } from '../../actions-hosted-migration/independent-ci-v1/worker/qualification-v2.mjs';

const SIGNER = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'linux', 'bin', 'clued-ci-sign-qualification-v2.mjs');
const sha = b => createHash('sha256').update(b).digest('hex');
const h = s => sha(String(s));
const key = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), pubPem: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })) }; };
const K = key();
const FACTS = { prCannotReadSignerKey: true, noControllerMounts: true, noCredentials: true, networkDisabled: true, cleanupQualified: true };

function policyOf(role, source = 'old') {
  const nodeEntry = role === 'contract-placement';
  return {
    schema: 'independent-ci.linux-policy.v3', role, formalEnabled: true, runtimeIdentity: 'TEST-ubuntu24-independent-ci-v1', keyId: 'test-key-1',
    image: nodeEntry ? 'sha256:' + h('img-' + role) : `example.invalid/${role}:1@sha256:${h('img-' + role)}`, executionMode: nodeEntry ? 'node-entry' : 'scanner',
    ...(nodeEntry ? { containerNodeExecutable: '/usr/local/bin/node', containerNodeSha256: h('container-node') } : {}),
    dockerExecutable: '/usr/bin/docker', dockerEndpoint: 'unix:///run/docker.sock', dockerExecutableSha256: h('docker'), dockerRootDirectory: '/var/lib/docker',
    containerUser: '65532:65532', memoryBytes: 2147483648, cpus: 2, pids: 128,
    nodeExecutable: FIXED.node, nodeExecutableSha256: h('node'), gitExecutable: '/usr/bin/git', gitExecutableSha256: h('git'),
    entryFile: '/opt/clued-independent-ci/source-v2/work/actions-hosted-migration/independent-ci-v1/worker/protected-job-bridge-v4/linux-worker.mjs',
    sourceManifestFile: '/etc/clued-independent-ci/formal-source-manifest-v2.json', publicKeyFile: FIXED.pub, signingKeyFile: FIXED.key,
    qualificationFile: `/etc/clued-independent-ci/roles-v3/${role}.qualification.json`, workspaceRoot: '/var/lib/clued-independent-ci/workspaces',
    runsRoot: '/var/lib/clued-independent-ci/runs', trustedSourceDirectory: '/opt/clued-independent-ci/source-v2',
    hostAcceptanceRef: 'f6aafe6e-738a-4e9d-9448-04bdbc0f78bc', sourceAcceptanceRef: source === 'old' ? 'f6aafe6e-738a-4e9d-9448-04bdbc0f78bc' : '11111111-2222-4333-8444-555555555555',
    ...Object.fromEntries(['sourceManifestSha256', 'entrySha256', 'qualificationSha256', 'workerSha256', 'proofSha256', 'jobSha256'].map(k => [k, h(`${source}-${k}`)])),
  };
}
function payloadOf(policy, pubPem, qualifiedAt = null) {
  const p = { schema: 'independent-ci.runtime-qualification.v2', fixture: false, role: policy.role, qualifiedAt, expiresAt: null, resultPublicKeySha256: sha(pubPem),
    isolation: 'root-managed-single-job-container', ...FACTS };
  for (const k of ['runtimeIdentity', 'sourceManifestSha256', 'image', 'entrySha256', 'qualificationSha256', 'executionMode', 'workerSha256', 'proofSha256', 'jobSha256',
    'nodeExecutable', 'keyId', 'hostAcceptanceRef', 'sourceAcceptanceRef']) p[k] = policy[k];
  if (policy.executionMode === 'node-entry') Object.assign(p, { containerNodeExecutable: policy.containerNodeExecutable, containerNodeSha256: policy.containerNodeSha256 });
  return p;
}
const signed = (payload, keyPem) => ({ payload, signature: sign(null, Buffer.from(canonicalJson(payload)), keyPem).toString('base64') });
const writeJson = (file, v) => fs.writeFileSync(file, canonicalJson(v) + '\n');

function world({ installedKey = K, v1 = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clued-signer-'));
  const dirs = Object.fromEntries(['v1', 'v2', 'in'].map(d => [d, path.join(root, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  const derived = {};
  for (const role of ROLES) {
    const oldPolicy = policyOf(role, 'old'), newPolicy = policyOf(role, 'new');
    if (v1) writeJson(path.join(dirs.v1, `${role}.qualification.json`), signed({ ...payloadOf(oldPolicy, K.pubPem, '2026-10-20T00:00:00.000Z'), schema: 'independent-ci.runtime-qualification.v1' }, installedKey.keyPem));
    writeJson(path.join(dirs.v2, `${role}.json`), oldPolicy);
    writeJson(path.join(dirs.v2, `${role}.qualification.json`), signed(payloadOf(oldPolicy, K.pubPem, '2026-10-26T06:01:53.209Z'), installedKey.keyPem));
    writeJson(path.join(dirs.in, `${role}.json`), newPolicy);
    writeJson(path.join(dirs.in, `${role}.qualification.payload.json`), payloadOf(newPolicy, K.pubPem));
    derived[role] = sha(fs.readFileSync(path.join(dirs.in, `${role}.json`)));
  }
  return { root, ...dirs, out: path.join(root, 'out'), derived, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const refusal = code => err => err.code === code;

test('the original mode (v1 reference) still signs exactly as before', t => {
  const w = world(); t.after(w.cleanup);
  const r = signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, now: new Date('2026-10-29T00:00:00.000Z') });
  assert.equal(r.status, 'QUALIFICATIONS_V2_SIGNED');
  assert.equal(r.reference, 'installed-v1');
  for (const role of ROLES) {
    const q = JSON.parse(fs.readFileSync(path.join(w.out, `${role}.qualification.json`), 'utf8'));
    assert.ok(verify(null, Buffer.from(canonicalJson(q.payload)), K.pubPem, Buffer.from(q.signature, 'base64')));
    assert.equal(q.payload.qualifiedAt, '2026-10-29T00:00:00.000Z');
    assert.deepEqual(fs.readFileSync(path.join(w.out, `${role}.json`)), fs.readFileSync(path.join(w.in, `${role}.json`)));
  }
  assert.throws(() => signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out }), refusal('OUTPUT_EXISTS_PRESERVE'));
  assert.throws(() => signAll({ keyPem: key().keyPem, pubPem: K.pubPem, v1Dir: w.v1, inDir: w.in, outDir: w.out + '2' }), refusal('RESULT_KEY_NOT_THE_INSTALLED_PUBLIC_KEY'));
});

test('upgrade mode signs the derived policy against the installed v2 qualification; the result passes qualification-v2.mjs', t => {
  const w = world({ v1: false }); t.after(w.cleanup);
  const r = signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, against: { v2Dir: w.v2, policySha256: w.derived } });
  assert.equal(r.reference, 'installed-v2');
  for (const role of ROLES) {
    const policy = JSON.parse(fs.readFileSync(path.join(w.out, `${role}.json`), 'utf8'));
    const q = JSON.parse(fs.readFileSync(path.join(w.out, `${role}.qualification.json`), 'utf8'));
    assert.equal(r.roles[role].policySha256, w.derived[role]);
    assert.ok(verify(null, Buffer.from(canonicalJson(q.payload)), K.pubPem, Buffer.from(q.signature, 'base64')));
    validatePolicyShape(policy);
    validateQualificationPayload(q.payload, policy, K.pubPem);
    const old = JSON.parse(fs.readFileSync(path.join(w.v2, `${role}.json`), 'utf8'));
    assert.deepEqual(Object.keys(policy).filter(k => canonicalJson(policy[k]) !== canonicalJson(old[k])).sort(), [...SOURCE_KEYS].sort());
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(w.out, `${role}.json`)).mode & 0o777, 0o600);
      assert.equal(fs.statSync(w.out).mode & 0o777, 0o700);
    }
  }
});

test('upgrade mode refuses a policy that is not the derived one, a host-fact change, an extra payload change and a foreign installed signature', async t => {
  await t.test('policy hash not the package value', () => {
    const w = world({ v1: false }); t.after(w.cleanup);
    assert.throws(() => signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, against: { v2Dir: w.v2, policySha256: { ...w.derived, trivy: h('other') } } }), refusal('POLICY_NOT_THE_DERIVED_ONE'));
    assert.equal(fs.existsSync(w.out), false, 'nothing written');
  });
  await t.test('a host fact (image) changed in policy and payload alike', () => {
    const w = world({ v1: false }); t.after(w.cleanup);
    const p = { ...policyOf('gitleaks', 'new'), image: `example.invalid/gitleaks:2@sha256:${h('img-2')}` };
    writeJson(path.join(w.in, 'gitleaks.json'), p);
    writeJson(path.join(w.in, 'gitleaks.qualification.payload.json'), payloadOf(p, K.pubPem));
    const derived = { ...w.derived, gitleaks: sha(fs.readFileSync(path.join(w.in, 'gitleaks.json'))) };
    assert.throws(() => signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, against: { v2Dir: w.v2, policySha256: derived } }), refusal('POLICY_DIFF_OUTSIDE_SOURCE_BINDING'));
  });
  await t.test('a non-binding policy field changed (memory)', () => {
    const w = world({ v1: false }); t.after(w.cleanup);
    writeJson(path.join(w.in, 'trivy.json'), { ...policyOf('trivy', 'new'), memoryBytes: 1073741824 });
    const derived = { ...w.derived, trivy: sha(fs.readFileSync(path.join(w.in, 'trivy.json'))) };
    assert.throws(() => signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, against: { v2Dir: w.v2, policySha256: derived } }), refusal('POLICY_DIFF_OUTSIDE_SOURCE_BINDING'));
  });
  await t.test('an extra payload field', () => {
    const w = world({ v1: false }); t.after(w.cleanup);
    writeJson(path.join(w.in, 'trivy.qualification.payload.json'), { ...payloadOf(policyOf('trivy', 'new'), K.pubPem), note: 'x' });
    assert.throws(() => signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, against: { v2Dir: w.v2, policySha256: w.derived } }), refusal('PAYLOAD_DIFF_OUTSIDE_SOURCE_BINDING'));
  });
  await t.test('the installed v2 qualification was signed by another key', () => {
    const w = world({ v1: false, installedKey: key() }); t.after(w.cleanup);
    assert.throws(() => signAll({ ...K, v1Dir: w.v1, inDir: w.in, outDir: w.out, against: { v2Dir: w.v2, policySha256: w.derived } }), refusal('V2_QUALIFICATION_FACTS_REFUSED'));
  });
});

test('the command line refuses off the pinned root Linux node and never prints a key', () => {
  const r = spawnSync(process.execPath, [SIGNER, '--in', '/tmp/a', '--out', '/tmp/b', '--against-installed-v2', [h(1), h(2), h(3)].join(',')], { env: {}, encoding: 'utf8' });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'REFUSED');
  assert.equal(out.privateKeyPrinted, false);
  assert.match(out.code, /^(ROOT_LINUX_REQUIRED|PINNED_TOOLCHAIN_NODE_REQUIRED)$/);
});
