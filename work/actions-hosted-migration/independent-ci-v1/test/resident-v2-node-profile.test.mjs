// Node profile /1 (resident active/standby design v0.4 §9 C1, Task 410a9397): the host identity an install is
// pinned to, carried by the install record and read from there by the installers, the controller read lease and
// the v2 entries' secret reads. TURING's profile is today's values, so nothing changes on TURING.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/proof.mjs';
import { NODE_PROFILE_KEYS, assembleRecord, hash, validateNodeProfile, validateRecordInputs } from '../src/resident-v2/prepare-record.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { decodeHeldRecord } from '../src/resident-v2/held-record.mjs';
import { NOW, fixtureRecord, nodeProfile, recordInputs, sourceFiles, tempDir } from './resident-v2-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = rel => fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
const CI = 'work/actions-hosted-migration/independent-ci-v1/';
const RESIDENT = 'work/independent-ci-resident-v1/';
const TURING_FILE = `${RESIDENT}config/node-profile.turing.json`;

test('node profile: the fixture and TURING profiles pass; the TURING file is exactly canonical(profile)', () => {
  assert.equal(validateNodeProfile(nodeProfile()).nodeName, 'fixture-node');
  const raw = read(TURING_FILE), turing = JSON.parse(raw);
  validateNodeProfile(turing);
  assert.equal(raw, canonical(turing));
  assert.equal(hash(raw), hash(turing));
  assert.deepEqual(Object.keys(turing).sort(), [...NODE_PROFILE_KEYS].sort());
  assert.equal(turing.nodeName, 'turing');
  assert.equal(turing.hostname, 'TURING');
  assert.equal(turing.mutationMutex, 'Global\\CluedControlControllerMutationV1-TURING-1015');
});

// The cases install-resident.ps1#Assert-NodeProfile is held to as well (windows/test-resident-windows.ps1, section 4c).
const CASES = JSON.parse(read(`${CI}test/fixtures/node-profile-cases.json`));
function applyCase(base, c) {
  const p = { ...base, ...(c.set ?? {}), ...(c.add ?? {}) };
  if (c.remove) delete p[c.remove];
  return p;
}

test('node profile: the shared cases: every field is held to its shape, the key set is exact, the mutex is derived', () => {
  assert.equal(CASES.contract, 'clued.independent-ci.node-profile-cases/1');
  assert.deepEqual(CASES.base, nodeProfile());
  assert.ok(CASES.accepted.length >= 5 && CASES.refused.length >= 40);
  for (const c of CASES.accepted) assert.doesNotThrow(() => validateNodeProfile(applyCase(CASES.base, c)), JSON.stringify(c));
  for (const c of CASES.refused) assert.throws(() => validateNodeProfile(applyCase(CASES.base, c)), { code: c.code }, JSON.stringify(c));
  assert.throws(() => validateNodeProfile(null), { code: 'NODE_PROFILE_FIELDS_REQUIRED' });
});

test('record inputs /2: `node` replaces `hostname`; the acceptance carries the profile whole and the manifest its hash', () => {
  assert.doesNotThrow(() => validateRecordInputs(recordInputs(), NOW));
  const { node, ...legacy } = recordInputs();
  assert.throws(() => validateRecordInputs({ ...legacy, hostname: 'TURING' }, NOW), { code: 'EXACT_RECORD_INPUT_FIELDS_REQUIRED' });
  assert.throws(() => validateRecordInputs(recordInputs({ node: nodeProfile({ hostname: 'lower' }) }), NOW), { code: 'NODE_PROFILE_INVALID' });
  const r = fixtureRecord({ node: nodeProfile({ nodeName: 'company-01', hostname: 'CO-01', mutationMutex: 'Global\\CluedControlControllerMutationV1-CO-01-1015' }) });
  const accepted = JSON.parse(r.files['acceptance.json']);
  assert.deepEqual(accepted.node, r.inputs.node);
  assert.equal(accepted.hostname, 'CO-01');
  assert.equal(accepted.contract, 'clued.independent-ci.accepted-installation/2');
  assert.equal(r.recordManifest.nodeProfileSha256, hash(r.inputs.node));
  assert.equal(validateRecordV2(r.docs, { now: NOW }).accepted.node.nodeName, 'company-01');
});

// A record whose acceptance is changed and every binding re-made (installation.json names the acceptance by hash).
function rebound(files, mutate) {
  const accepted = mutate(JSON.parse(files['acceptance.json'])), acceptanceText = canonical(accepted);
  const config = { ...JSON.parse(files['installation.json']), acceptanceSha256: hash(acceptanceText) };
  return { ...Object.fromEntries(Object.entries(files).map(([n, t]) => [n, Buffer.from(t)])), 'acceptance.json': Buffer.from(acceptanceText), 'installation.json': Buffer.from(canonical(config)) };
}

test('install record: a missing, invalid or inconsistent node profile is refused by every reader', () => {
  const r = fixtureRecord();
  assert.doesNotThrow(() => validateRecordV2(rebound(r.files, a => a), { now: NOW }));
  for (const mutate of [
    a => { const { node, ...rest } = a; return rest; },
    a => ({ ...a, node: { ...a.node, controllerSid: 'S-1-5-18' } }),
    a => ({ ...a, node: { ...a.node, extra: true } }),
    a => ({ ...a, hostname: 'OTHER-HOST' }),
    a => ({ ...a, controllerAccount: 'other' }),
  ]) assert.throws(() => validateRecordV2(rebound(r.files, mutate), { now: NOW }), { code: 'RECORD_NODE_PROFILE_REQUIRED' });
  // assembled from bad inputs (assembleRecord does not validate), the record is still refused
  const bad = assembleRecord({ ...r.inputs, node: nodeProfile({ runnerService: 'svc' }) }, sourceFiles());
  assert.throws(() => validateRecordV2(Object.fromEntries(Object.entries(bad.files).map(([n, t]) => [n, Buffer.from(t)])), { now: NOW }), { code: 'RECORD_NODE_PROFILE_REQUIRED' });
  // the host identity of an entry is still the record's hostname, now the profile's
  assert.doesNotThrow(() => validateRecordV2(r.docs, { now: NOW, identity: { arch: 'x64', account: 'clued-control', hostname: 'fixture-node' } }));
  assert.throws(() => validateRecordV2(r.docs, { now: NOW, identity: { arch: 'x64', account: 'clued-control', hostname: 'TURING' } }), { code: 'RECORD_HOST_IDENTITY_REQUIRED' });
});

function heldBytes(docs, controllerSid, o = {}) {
  const policy = Buffer.from('{"fixture":true}');
  return Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.held-record-bytes/1', controllerSid, sourceRoot: `C:\\ProgramData\\CluedIndependentCI\\resident\\source\\${'a'.repeat(64)}`,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), documents: Object.fromEntries(Object.entries(docs).map(([n, b]) => [n, b.toString('base64')])),
    sourceHashes: { 'config/merge-admission-policy.json': hash(policy) }, policyBase64: policy.toString('base64'), ...o }));
}

test('held record: the lease process ran as the controller the record itself pins, no other', () => {
  const r = fixtureRecord();
  const docs = Object.fromEntries(['installation.json', 'acceptance.json', 'source-manifest.json', 'signers.json'].map(n => [n, r.docs[n]]));
  assert.equal(decodeHeldRecord(heldBytes(docs, 'S-1-5-21-1-2-3-1015')).sourceHashes.size, 1);
  assert.throws(() => decodeHeldRecord(heldBytes(docs, 'S-1-5-21-1173730660-3877291096-655431861-1015')), { code: 'HELD_RECORD_CONTROLLER_REFUSED' });
  assert.throws(() => decodeHeldRecord(heldBytes(docs, 'S-1-5-21-1-2-3-1001')), { code: 'HELD_RECORD_CONTROLLER_REFUSED' });
  assert.throws(() => decodeHeldRecord(heldBytes(docs, 'S-1-5-18')), { code: 'HELD_RECORD_REFUSED' });
  const noNode = rebound(r.files, a => { const { node, ...rest } = a; return rest; });
  assert.throws(() => decodeHeldRecord(heldBytes({ ...docs, 'acceptance.json': noNode['acceptance.json'] }, 'S-1-5-21-1-2-3-1015')), { code: 'HELD_RECORD_CONTROLLER_REFUSED' });
});

// C1b moves the current /2 provider's identity to its pinned node. The retained legacy /1
// provider and eight transitive v2 bridge files remain separately bounded, not silently generalized.
test('current node consumers contain no TURING authority fallback; legacy compatibility stays explicit', () => {
  const turing=JSON.parse(read(TURING_FILE));
  assert.equal(hash(turing),'4d006ddc5b8cb0a112f67ddf4c07f96ddb5c39623e3eb11617c076708acd9be6');
  const current=[`${RESIDENT}windows/install-resident.ps1`,`${RESIDENT}windows/verify-resident.ps1`,`${RESIDENT}windows/uninstall-resident.ps1`,
    `${CI}src/resident-v2/hold-record.ps1`,`${CI}src/resident-v2/held-record.mjs`,`${CI}src/resident-v2/entry-runtime.mjs`,
    `${CI}runtime/verify-install-acl.ps1`,`${CI}runtime/protected-files.mjs`,`${CI}src/resident-v2/prepare-record.mjs`,`${CI}src/resident-v2/record.mjs`,
    `${CI}src/resident-v2/windows/ResidentScmV2.cs`,`${CI}src/resident-v2/windows/FormalSession0V2.cs`,`${CI}src/resident-v2/windows/FormalPublicBoundaryV2.cs`,
    `${CI}src/resident-v2/windows/ScmPidHandshakeV2.cs`,`${CI}src/resident-v2/windows/NodeProfileV2.cs`,`${CI}src/resident-v2/invoke-stage.mjs`,
    `${CI}src/resident-v2/archive-windows-spool.ps1`,`${CI}src/resident-v2/layout.mjs`,`${CI}worker/protected-job-bridge-v4/relay-public.ps1`,
    `${CI}worker/protected-job-bridge-v4/formal-spool-acl.ps1`,`${RESIDENT}src/engine-windows.mjs`,`${RESIDENT}src/policy.mjs`,
    `${RESIDENT}src/companion.mjs`,`${RESIDENT}src/runner.mjs`];
  for(const f of current){
    const code=read(f).split(/\r?\n/).filter(l=>!/^\s*(#|\/\/)/.test(l)).join('\n');
    assert.doesNotMatch(code,/S-1-5-21-\d+-\d+-\d+-\d+|clued-ci-home-win-02|Ubuntu-24\.04|'TURING'|"TURING"|\(\\\.\|TURING\)/,f);
  }
  assert.match(read(`${CI}worker/protected-job-bridge-v2/boundary.mjs`),/accepted-installation\/1/);
});

test('resident and Source validators use the same actual shared vectors and original canonical profile hash', async () => {
  const resident=await import('../../../independent-ci-resident-v1/src/node-profile.mjs');
  const turing=JSON.parse(read(TURING_FILE));
  for(const p of [turing,...CASES.accepted.map(c=>applyCase(CASES.base,c))]){
    assert.equal(resident.nodeProfileSha256(p),hash(p));
    assert.deepEqual(resident.pinnedNodeProfile(p,hash(p)),p);
  }
  for(const c of CASES.refused)assert.throws(()=>resident.validateNodeProfile(applyCase(CASES.base,c)),{code:c.code},JSON.stringify(c));
});

test('verify-install-acl.ps1: a secret read needs the pinned controller SID, given in its exact shape', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t, 'clued-acl-');
  const secrets = path.join(dir, 'secrets'), file = path.join(secrets, 'x.token');
  fs.mkdirSync(secrets); fs.writeFileSync(file, 'x');
  const run = extra => {
    try { execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(REPO, ...`${CI}runtime/verify-install-acl.ps1`.split('/')),
      '-LiteralTarget', file, '-ReadFile', '-SecretRoot', secrets, '-ProtectedRoot', dir, ...extra], { windowsHide: true, timeout: 30000, stdio: 'pipe' }); return 0; }
    catch (e) { return e.status; }
  };
  // the argument gate has its own exit code (3): no SID, another kind of SID, a trailing space or newline, non-ASCII digits
  assert.equal(run([]), 3);
  for (const bad of ['S-1-5-18', 'S-1-5-21-1-2-3-1015 ', 'S-1-5-21-1-2-3-1015\n', 'S-1-5-21-1-2-3-١٠١٥']) assert.equal(run(['-ControllerSid', bad]), 3, JSON.stringify(bad));
  // a well-formed SID passes the gate; this temp directory then fails the real ACL checks (2, never 0 here)
  assert.equal(run(['-ControllerSid', 'S-1-5-21-1-2-3-1015']), 2);
});

test('hold-record.ps1: the record is read and held before the identity check, and no Source file before it', () => {
  const text = read(`${CI}src/resident-v2/hold-record.ps1`);
  const records = text.indexOf("foreach($name in @('installation.json','acceptance.json','source-manifest.json','signers.json'))");
  const identity = text.indexOf("throw 'EXACT_CONTROLLER_REQUIRED'");
  const source = text.indexOf('Hold-Read (Join-Path $Source');
  assert.ok(records > 0 && identity > records && source > identity, `${records} < ${identity} < ${source}`);
  assert.equal(text.split("throw 'EXACT_CONTROLLER_REQUIRED'").length, 2);
  assert.match(text, /\$Controller=\[string\]\$accepted\.node\.controllerSid/);
});
