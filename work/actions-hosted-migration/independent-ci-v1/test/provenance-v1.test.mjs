// L4 (optimisation plan bf57ff10): in-toto Statement v1 / SLSA Provenance v1 attestations of check results, DSSE-signed with the
// existing result key. Offline; fixture keys only; every directory under os.tmpdir().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, createPublicKey, sign } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { batchJobsV2 } from '../src/job-v2.mjs';
import { verifyResultV2 } from '../src/proof-v2.mjs';
import { pae, signDsse, verifyDsse, PAYLOAD_TYPE } from '../src/provenance-v1/dsse.mjs';
import { buildStatement, statementBytes, validateStatementV1, checkStatementBinding, builderId, STATEMENT_TYPE, PREDICATE_TYPE } from '../src/provenance-v1/statement.mjs';
import { writeProvenance, listProvenance, provenanceFileName } from '../src/provenance-v1/store.mjs';
import { verifyProvenanceForCommit, main as verifyMain } from '../src/provenance-v1/verify.mjs';
import { provenanceEnvelope, emitProvenance } from '../worker/protected-job-bridge-v4/provenance-emit.mjs';
import { emitProvenanceBestEffort } from '../worker/protected-job-bridge-v4/linux-worker.mjs';
import { HEAD, BASE, NOW, iso, hex, tempDir, signerKeys, signResult } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system', MANIFEST = 'e'.repeat(64), TREE = '7'.repeat(40);
const job = role => batchJobsV2({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: MANIFEST, createdAt: iso(NOW - 60_000), attempt: 1 })[role];
// The signed result exactly as the Linux signer emits it (fixtures.signResult), with the extra payload fields the real
// resultPayload() adds; the DSSE signing key is the same key that signed the result.
function fixture(role = 'trivy') {
  const j = job(role), keys = signerKeys();
  const base = signResult(j, keys);
  const payload = { ...base.payload, requestDigest: hex(32), executionObservationSha256: hex(32), cleanupSha256: hex(32), profile: 'required-trivy-three-scanners/1', logDigestMode: 'canonical-scan-log-digests', sourceSha: HEAD };
  const envelope = { ...base, payload, signature: sign(null, Buffer.from(canonical(payload)), keys.privateKey).toString('base64url') };
  const observation = { candidateTreeSha: TREE, image: `ghcr.io/aquasecurity/trivy:0.74.0@sha256:${'c'.repeat(64)}`, workflowSha256: 'd'.repeat(64) };
  return { job: j, keys, envelope, observation, config: { keyId: envelope.keyId, runtimeIdentity: envelope.payload.runtimeId } };
}
const flip = (b64, i = 4) => { const b = Buffer.from(b64, 'base64'); b[i] ^= 1; return b.toString('base64'); };

test('DSSE pre-authentication encoding matches the DSSE specification vector', () => {
  assert.equal(pae('http://example.com/HelloWorld', Buffer.from('hello world')).toString(), 'DSSEv1 29 http://example.com/HelloWorld 11 hello world');
});

test('the statement carries the standard in-toto Statement v1 and SLSA provenance v1 fields (independent field check)', () => {
  const f = fixture(), st = buildStatement({ job: f.job, envelope: f.envelope, observation: f.observation });
  // Written out from the specifications, not from validateStatementV1.
  assert.equal(st._type, 'https://in-toto.io/Statement/v1');
  assert.equal(st.predicateType, 'https://slsa.dev/provenance/v1');
  assert.ok(Array.isArray(st.subject) && st.subject.length === 2);
  assert.deepEqual(st.subject[0], { name: `git+https://github.com/${REPO}`, digest: { gitCommit: HEAD } });
  assert.deepEqual(st.subject[1].digest, { gitTree: TREE });
  const { buildDefinition: bd, runDetails: rd } = st.predicate;
  assert.deepEqual(Object.keys(st.predicate).sort(), ['buildDefinition', 'runDetails']);
  assert.match(bd.buildType, /^https:\/\//);
  assert.equal(typeof bd.externalParameters, 'object');
  assert.equal(bd.externalParameters.jobId, f.job.id);
  assert.equal(bd.externalParameters.testSha, HEAD);
  assert.ok(bd.resolvedDependencies.every(d => d.uri || d.digest || d.content));
  assert.deepEqual(bd.resolvedDependencies.find(d => d.name === 'source-manifest').digest, { sha256: MANIFEST });
  assert.deepEqual(bd.resolvedDependencies.find(d => d.name === 'scanner-image').digest, { sha256: 'c'.repeat(64) });
  assert.equal(rd.builder.id, `urn:clued:independent-ci:node:fixture-runtime:source:${MANIFEST}`);
  assert.equal(rd.metadata.invocationId, f.job.id);
  assert.equal(rd.metadata.startedOn, f.envelope.payload.startedAt);
  assert.equal(rd.metadata.finishedOn, f.envelope.payload.finishedAt);
  assert.equal(rd.byproducts.find(b => b.name === 'signed-result').digest.sha256, digest(f.envelope));
  assert.equal(rd.byproducts.find(b => b.name === 'stdout').digest.sha256, f.envelope.payload.stdoutSha256);
  assert.deepEqual(JSON.parse(Buffer.from(rd.byproducts.find(b => b.name === 'check-result').content, 'base64')), { conclusion: 'success', exitCode: 0 });
  assert.equal(validateStatementV1(st), st);
  assert.equal(builderId('node/a b', MANIFEST), `urn:clued:independent-ci:node:node%2Fa%20b:source:${MANIFEST}`);
});

test('a statement without a tree in the observation has the commit subject only; a failed result is reported as such', () => {
  const f = fixture('gitleaks');
  f.envelope.payload.conclusion = 'failure'; f.envelope.payload.exitCode = 1;
  const st = buildStatement({ job: f.job, envelope: f.envelope });
  assert.equal(st.subject.length, 1);
  validateStatementV1(st);
  assert.equal(JSON.parse(Buffer.from(st.predicate.runDetails.byproducts.find(b => b.name === 'check-result').content, 'base64')).conclusion, 'failure');
});

test('the validator refuses statements that break the specifications', () => {
  const f = fixture(), good = buildStatement({ job: f.job, envelope: f.envelope, observation: f.observation });
  const mutate = fn => { const c = structuredClone(good); fn(c); return c; };
  for (const [name, bad] of Object.entries({
    type: mutate(s => { s._type = 'https://in-toto.io/Statement/v0.1'; }),
    predicateType: mutate(s => { s.predicateType = 'https://slsa.dev/provenance/v0.2'; }),
    noSubject: mutate(s => { s.subject = []; }),
    emptyDigest: mutate(s => { s.subject[0].digest = {}; }),
    noCommit: mutate(s => { s.subject = [s.subject[1]]; }),
    noBuilder: mutate(s => { delete s.predicate.runDetails.builder.id; }),
    noBuildType: mutate(s => { delete s.predicate.buildDefinition.buildType; }),
    noExternal: mutate(s => { delete s.predicate.buildDefinition.externalParameters; }),
    badTime: mutate(s => { s.predicate.runDetails.metadata.startedOn = 'yesterday'; }),
    extraTop: mutate(s => { s.extra = 1; }),
    badDescriptor: mutate(s => { s.predicate.runDetails.byproducts.push({ name: 'x' }); }),
  })) assert.throws(() => validateStatementV1(bad), /provenance_statement_invalid/, name);
});

test('binding: the statement must say exactly this job and this signed result', () => {
  const f = fixture(), st = buildStatement({ job: f.job, envelope: f.envelope, observation: f.observation });
  checkStatementBinding(st, { job: f.job, envelope: f.envelope });
  assert.throws(() => checkStatementBinding(st, { job: job('gitleaks') }), /provenance_(job|subject)_mismatch/);
  const other = structuredClone(f.envelope); other.payload.stdoutSha256 = hex(32);
  assert.throws(() => checkStatementBinding(st, { job: f.job, envelope: other }), /provenance_result_mismatch/);
  const failed = structuredClone(f.envelope); failed.payload.conclusion = 'failure'; failed.payload.exitCode = 1;
  assert.throws(() => checkStatementBinding(st, { job: f.job, envelope: failed }), /provenance_result_mismatch/);
  const moved = structuredClone(st); moved.subject[0].digest.gitCommit = 'f'.repeat(40);
  assert.throws(() => checkStatementBinding(moved, { job: f.job }), /provenance_subject_mismatch/);
});

test('DSSE: signed with the result key, verifies with its public key; one changed byte fails', () => {
  const f = fixture(), st = buildStatement({ job: f.job, envelope: f.envelope, observation: f.observation });
  const env = signDsse({ body: statementBytes(st), privateKey: f.keys.privateKey, keyId: f.config.keyId });
  assert.equal(env.payloadType, PAYLOAD_TYPE);
  assert.deepEqual(Object.keys(env).sort(), ['payload', 'payloadType', 'signatures']);
  assert.deepEqual(Object.keys(env.signatures[0]).sort(), ['keyid', 'sig']);
  assert.deepEqual(JSON.parse(verifyDsse({ envelope: env, publicKey: f.keys.publicKeyPem, keyId: 'fixture-key' }).toString()), st);
  // One byte of the payload, of the signature, of the type; a different key; a different keyid.
  assert.throws(() => verifyDsse({ envelope: { ...env, payload: flip(env.payload) }, publicKey: f.keys.publicKeyPem }), /dsse_signature_invalid/);
  assert.throws(() => verifyDsse({ envelope: { ...env, signatures: [{ keyid: 'fixture-key', sig: flip(env.signatures[0].sig, 10) }] }, publicKey: f.keys.publicKeyPem }), /dsse_signature_invalid/);
  assert.throws(() => verifyDsse({ envelope: { ...env, payloadType: 'application/json' }, publicKey: f.keys.publicKeyPem }), /dsse_signature_invalid/);
  assert.throws(() => verifyDsse({ envelope: env, publicKey: signerKeys().publicKeyPem }), /dsse_signature_invalid/);
  assert.throws(() => verifyDsse({ envelope: env, publicKey: f.keys.publicKeyPem, keyId: 'other' }), /dsse_signature_invalid/);
  assert.throws(() => verifyDsse({ envelope: { ...env, payload: 'not base64!' }, publicKey: f.keys.publicKeyPem }), /dsse_envelope_invalid/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => verifyDsse({ envelope: env, publicKey: rsa }), /dsse_public_key_invalid/);
});

test('generating the attestation changes nothing of the existing formats: the signed result still verifies, bytes untouched', () => {
  const f = fixture(), before = canonical(f.envelope);
  const signers = new Map([[f.envelope.keyId, { publicKeyPem: f.keys.publicKeyPem, domain: 'production', runtimeId: 'fixture-runtime', qualificationRef: 'q', sourceAcceptanceRef: 's' }]]);
  const first = verifyResultV2({ job: f.job, envelope: f.envelope, signers, now: NOW });
  buildStatement({ job: f.job, envelope: f.envelope, observation: f.observation });
  assert.equal(canonical(f.envelope), before);
  assert.equal(verifyResultV2({ job: f.job, envelope: f.envelope, signers, now: NOW }).evidenceSha256, first.evidenceSha256);
  // The statement's signed-result byproduct is that very evidence hash (the chain from the attestation to the publisher's journal).
  const st = buildStatement({ job: f.job, envelope: f.envelope });
  assert.equal(st.predicate.runDetails.byproducts.find(b => b.name === 'signed-result').digest.sha256, first.evidenceSha256);
});

async function emitted(t, role = 'trivy') {
  const f = fixture(role), dir = await tempDir(t, 'clued-prov-'), publicKey = createPublicKey(f.keys.publicKeyPem);
  const ports = { loadPolicy: async () => ({ config: { ...f.config, signingKeyFile: '/fixture/key' }, publicKey: f.keys.publicKeyPem }), readKey: async () => f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), dir, prepareDir: async d => fs.mkdir(d, { recursive: true }) };
  const issue = { job: f.job }, signed = { envelope: f.envelope };
  const out = await emitProvenance(null, issue, f.observation, signed, ports);
  return { f, dir, out, issue, signed, ports, publicKey };
}

test('emit: the Linux generation point writes one DSSE file per job, create-only, named by commit, role and job; a re-run is idempotent', async t => {
  const e = await emitted(t);
  assert.equal(e.out.created, true);
  assert.equal(path.basename(e.out.file), provenanceFileName(e.f.job));
  assert.equal(path.basename(e.out.file), `${HEAD}-trivy-${e.f.job.id.slice(0, 16)}.dsse.json`);
  assert.equal((await emitProvenance(null, e.issue, e.f.observation, e.signed, e.ports)).created, false);
  assert.deepEqual((await listProvenance(e.dir, HEAD)).map(p => path.basename(p)), [path.basename(e.out.file)]);
  assert.deepEqual(await listProvenance(e.dir, 'f'.repeat(40)), []);
  // A key that is not the role's public key is refused (EXISTING_RESULT_KEY_CHANGED), nothing written.
  const other = signerKeys();
  await assert.rejects(emitProvenance(null, { job: job('gitleaks') }, {}, { envelope: { ...e.f.envelope, payload: { ...e.f.envelope.payload, subject: { ...e.f.envelope.payload.subject, id: job('gitleaks').id } } } },
    { ...e.ports, loadPolicy: async () => ({ config: { ...e.f.config, signingKeyFile: '/x' }, publicKey: other.publicKeyPem }) }), /EXISTING_RESULT_KEY_CHANGED/);
  // Result authority changed between signing and attesting.
  assert.throws(() => provenanceEnvelope({ issue: e.issue, signed: e.signed, observation: null, config: { ...e.f.config, runtimeIdentity: 'other' }, key: e.f.keys.privateKey }), /PROVENANCE_RESULT_AUTHORITY_CHANGED/);
});

test('verify by commit: passes with the public key; wrong commit, wrong key, tampered file and wrong tree all fail', async t => {
  const e = await emitted(t), keys = [{ keyId: 'fixture-key', pem: e.f.keys.publicKeyPem }];
  const ok = await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: keys, treeOf: async () => TREE });
  assert.equal(ok.ok, true); assert.equal(ok.found, 1); assert.equal(ok.results[0].role, 'trivy'); assert.equal(ok.results[0].treeChecked, true);
  assert.equal(ok.results[0].builder, `urn:clued:independent-ci:node:fixture-runtime:source:${MANIFEST}`);
  assert.equal((await verifyProvenanceForCommit({ dir: e.dir, sha: 'f'.repeat(40), publicKeys: keys })).ok, false);          // nothing for that commit
  assert.equal((await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: [{ pem: signerKeys().publicKeyPem }] })).results[0].error, 'dsse_signature_invalid');
  assert.equal((await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: keys, treeOf: async () => '1'.repeat(40) })).results[0].error, 'provenance_tree_mismatch');
  assert.equal((await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: keys, role: 'gitleaks' })).ok, false);   // no gitleaks attestation
  // Change one byte of the stored file's payload: the signature no longer verifies.
  const env = JSON.parse(await fs.readFile(e.out.file, 'utf8'));
  await fs.writeFile(e.out.file, JSON.stringify({ ...env, payload: flip(env.payload, 40) }));
  assert.equal((await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: keys })).results[0].error, 'dsse_signature_invalid');
  // A same-length raw byte change anywhere in the file is caught as well (signature, JSON or payload).
  const raw = await fs.readFile(e.out.file); raw[raw.length - 10] ^= 1; await fs.writeFile(e.out.file, raw);
  assert.equal((await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: keys })).ok, false);
  await assert.rejects(verifyProvenanceForCommit({ dir: e.dir, sha: 'abc', publicKeys: keys }), /commit_sha_invalid/);
  await assert.rejects(verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: [] }), /public_key_required/);
});

test('verify is read-only: the directory is unchanged after any verification', async t => {
  const e = await emitted(t), keys = [{ pem: e.f.keys.publicKeyPem }];
  const snapshot = async () => JSON.stringify(await Promise.all((await fs.readdir(e.dir)).map(async n => [n, (await fs.stat(path.join(e.dir, n))).mtimeMs, (await fs.readFile(path.join(e.dir, n))).toString('base64')])));
  const before = await snapshot();
  await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: keys });
  await verifyProvenanceForCommit({ dir: e.dir, sha: HEAD, publicKeys: [{ pem: signerKeys().publicKeyPem }] });
  assert.equal(await snapshot(), before);
});

test('verify command: exit 0 on a good attestation, 1 on a bad one, 2 on bad usage', async t => {
  const e = await emitted(t), pub = path.join(e.dir, '..', `pub-${path.basename(e.dir)}.pem`);
  await fs.writeFile(pub, e.f.keys.publicKeyPem); t.after(() => fs.rm(pub, { force: true }));
  const run = async args => { let text = ''; const code = await verifyMain(args, { write: s => { text += s; } }); return { code, text }; };
  const good = await run(['--sha', HEAD, '--pubkey', pub, '--dir', e.dir]);
  assert.equal(good.code, 0); assert.match(good.text, /1\/1 attestation\(s\) verified/); assert.match(good.text, /OK .*role=trivy conclusion=success/);
  assert.equal(JSON.parse((await run(['--sha', HEAD, '--pubkey', pub, '--dir', e.dir, '--json'])).text).ok, true);
  const other = path.join(e.dir, '..', `other-${path.basename(e.dir)}.pem`);
  await fs.writeFile(other, signerKeys().publicKeyPem); t.after(() => fs.rm(other, { force: true }));
  assert.equal((await run(['--sha', HEAD, '--pubkey', other, '--dir', e.dir])).code, 1);
  assert.equal((await run(['--sha', 'f'.repeat(40), '--pubkey', pub, '--dir', e.dir])).code, 1);
  assert.equal((await run(['--sha', 'nothex', '--pubkey', pub])).code, 2);
  assert.equal((await run(['--bogus'])).code, 2);
});

test('writeProvenance refuses a different file for the same job and an oversized one', async t => {
  const e = await emitted(t);
  await assert.rejects(writeProvenance({ dir: e.dir, job: e.f.job, envelope: { payloadType: PAYLOAD_TYPE, payload: 'AAAA', signatures: [] } }), /provenance_exists_different/);
  await assert.rejects(writeProvenance({ dir: e.dir, job: e.f.job, envelope: { x: 'a'.repeat(300_000) } }), /provenance_too_large/);
});

test('best effort: a failing, missing or slow emitter returns null and never throws into the signing path', async () => {
  const args = [null, { job: job('trivy') }, {}, {}];
  assert.equal(await emitProvenanceBestEffort(...args, { load: async () => { throw new Error('nope'); } }), null);
  assert.equal(await emitProvenanceBestEffort(...args, { load: async () => ({ emitProvenance: async () => { throw new Error('disk'); } }) }), null);
  assert.equal(await emitProvenanceBestEffort(...args, { load: async () => ({ emitProvenance: () => new Promise(() => {}) }), budgetMs: 20 }), null);
  assert.deepEqual(await emitProvenanceBestEffort(...args, { load: async () => ({ emitProvenance: async () => ({ created: true }) }) }), { created: true });
});
