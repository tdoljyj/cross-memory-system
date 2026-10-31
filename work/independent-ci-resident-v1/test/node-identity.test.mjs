// Primary/standby C7 (Task 088ab175, DESIGN.md section 30): the node identity an install pins in its receipt.
// Offline: fixtures only. The shared cases (test/fixtures/node-identity-cases.json) hold this JS derivation and the
// PowerShell twins (install-resident.ps1 / verify-resident.ps1 Get-NodeIdentity) to the same answers and refusal codes;
// windows/test-resident-windows.ps1 runs the PowerShell side over the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_IDENTITY_CONTRACT, NODE_IDENTITY_KEYS, NODE_IDENTITY_REFS, nodeIdentityOf, nodeIdentitySha256, validateNodeIdentity } from '../src/node-identity.mjs';
import { sha256 } from '../src/canonical.mjs';
import { fixtureRecord, nodeProfile } from '../../actions-hosted-migration/independent-ci-v1/test/resident-v2-fixtures.mjs';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cases = JSON.parse(await fs.readFile(path.join(HERE, 'test', 'fixtures', 'node-identity-cases.json'), 'utf8'));
const turingProfile = JSON.parse(await fs.readFile(path.join(HERE, 'config', 'node-profile.turing.json'), 'utf8'));

function setPath(object, dotted, value) {
  const parts = dotted.split('.'); let at = object;
  for (const part of parts.slice(0, -1)) at = at[part];
  at[parts.at(-1)] = value;
}
function applyCase(c) {
  const base = structuredClone(cases.nodes[c.node]);
  const docs = { installation: base.installation, accepted: base.accepted, pin: base.acceptancePin };
  for (const doc of ['installation', 'accepted']) {
    for (const [k, v] of Object.entries(c[doc]?.set ?? {})) setPath(docs[doc], k, v);
    for (const k of c[doc]?.remove ?? []) delete docs[doc][k];
  }
  if (c.pin !== undefined) docs.pin = c.pin;
  return docs;
}

test('two different nodes, TURING and a company fixture, each derive their own identity from their own record', () => {
  assert.deepEqual(Object.keys(cases.nodes).sort(), ['company', 'turing']);
  for (const [name, n] of Object.entries(cases.nodes)) {
    const id = nodeIdentityOf(n.installation, n.accepted, n.acceptancePin);
    assert.deepEqual(id, n.identity, name);
    assert.equal(nodeIdentitySha256(id), n.identitySha256, name);
    assert.equal(id.contract, NODE_IDENTITY_CONTRACT);
    assert.deepEqual(Object.keys(id).sort(), [...NODE_IDENTITY_KEYS].sort());
    assert.equal(id.nodeName, n.accepted.node.nodeName);
  }
  const [t, c] = [cases.nodes.turing.identity, cases.nodes.company.identity];
  assert.equal(t.nodeName, turingProfile.nodeName);
  assert.equal(c.nodeName, 'company');
  assert.notEqual(cases.nodes.turing.identitySha256, cases.nodes.company.identitySha256);
  for (const k of NODE_IDENTITY_KEYS.filter(k => k !== 'contract')) assert.notEqual(t[k], c[k], `${k} differs between the two nodes`);
});

test('every refused case fails closed with its code (fields, acceptance pin, the two files disagreeing)', () => {
  assert.ok(cases.refused.length >= 30);
  const codes = new Set(cases.refused.map(c => c.code));
  assert.deepEqual([...codes].sort(), ['NODE_IDENTITY_ACCEPTANCE_PIN_MISMATCH', 'NODE_IDENTITY_FIELDS_REQUIRED', 'NODE_IDENTITY_RECORDS_DISAGREE']);
  for (const c of cases.refused) {
    const d = applyCase(c);
    assert.throws(() => nodeIdentityOf(d.installation, d.accepted, d.pin), { code: c.code }, `${c.node}: ${c.name}`);
  }
});

test('the identity holds ids and fingerprints only: no private key, no token, no role claim', () => {
  for (const n of Object.values(cases.nodes)) {
    const text = JSON.stringify(n.identity);
    assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY|clued_bnd_|"[^"]*(?:secret|password)[^"]*"/i);
    // ciPrincipalRoleRef is the Owner decision that the connection MAY hold ci-admission; nothing says it holds it now.
    assert.equal(Object.keys(n.identity).filter(k => /^(role|mode|holds|active|standby)$/i.test(k)).length, 0);
  }
  assert.deepEqual(NODE_IDENTITY_REFS, ['sourceAcceptanceRef', 'hostQualificationRef', 'ownerAuthorizationRef', 'publisherQualificationRef', 'ciPrincipalQualificationRef', 'ownerPackageAcceptanceRef', 'installationReceiptRef']);
});

test('validateNodeIdentity refuses a changed, extended or reshaped identity', () => {
  const id = structuredClone(cases.nodes.company.identity);
  assert.equal(validateNodeIdentity(id), id);
  assert.throws(() => validateNodeIdentity({ ...id, extra: 'x' }), { code: 'NODE_IDENTITY_FIELDS_REQUIRED' });
  assert.throws(() => validateNodeIdentity({ ...id, contract: 'x' }), { code: 'NODE_IDENTITY_FIELDS_REQUIRED' });
  assert.throws(() => validateNodeIdentity({ ...id, appKeyId: '5' }), { code: 'NODE_IDENTITY_FIELDS_REQUIRED' });
  assert.throws(() => validateNodeIdentity(null), { code: 'NODE_IDENTITY_FIELDS_REQUIRED' });
  const { nodeName, ...rest } = id; void nodeName;
  assert.throws(() => validateNodeIdentity(rest), { code: 'NODE_IDENTITY_FIELDS_REQUIRED' });
});

// The real Source record assembler (test-only import; the resident never imports Source): two nodes, two records.
test('identities derived from really assembled install records (TURING profile, company profile) match their inputs', () => {
  const company = nodeProfile({ nodeName: 'company', hostname: 'COMPANY-PC', mutationMutex: 'Global\\CluedControlControllerMutationV1-COMPANY-PC-1015',
    runnerService: 'actions.runner.tdoljyj-cross-memory-system.clued-ci-company-win-02', wslDistribution: 'Ubuntu-24.04' });
  const out = [];
  for (const profile of [turingProfile, company]) {
    const fx = fixtureRecord({ node: profile });
    const installation = JSON.parse(fx.files['installation.json']), accepted = JSON.parse(fx.files['acceptance.json']);
    const id = nodeIdentityOf(installation, accepted, sha256(Buffer.from(fx.files['acceptance.json'])));
    assert.equal(id.nodeName, profile.nodeName);
    assert.equal(id.appKeyId, fx.inputs.appKeyId);
    assert.equal(id.appPublicKeySha256Base64, fx.inputs.appPublicKeySha256Base64);
    assert.equal(id.ciTokenPinSha256, fx.inputs.ciTokenPinSha256);
    assert.equal(id.ciPrincipalBindingId, fx.inputs.ciPrincipalBindingId);
    assert.equal(id.ciPrincipalRoleRef, fx.inputs.ciPrincipalRoleRef);
    for (const k of NODE_IDENTITY_REFS) assert.equal(id[k], fx.inputs.references[k]);
    assert.equal(id.ownerDecisionRef, fx.inputs.owner.ownerDecisionRef);
    assert.equal(fx.recordManifest.acceptanceSha256, sha256(Buffer.from(fx.files['acceptance.json'])));
    // a changed acceptance file, or one connection's pin edited in only one of the two files, is refused
    assert.throws(() => nodeIdentityOf(installation, { ...accepted, ciTokenPinSha256: '1'.repeat(64) }, sha256(Buffer.from(fx.files['acceptance.json']))), { code: 'NODE_IDENTITY_RECORDS_DISAGREE' });
    assert.throws(() => nodeIdentityOf(installation, accepted, '2'.repeat(64)), { code: 'NODE_IDENTITY_ACCEPTANCE_PIN_MISMATCH' });
    out.push(nodeIdentitySha256(id));
  }
  assert.notEqual(out[0], out[1]);
});
