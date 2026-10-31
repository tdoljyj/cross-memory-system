import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { jobIdV2, makeJobV2, validateJobV2, batchJobsV2, batchRefV2, scanEffectKeyV2, scanExternalIdV2, admissionEffectKeyV2, admissionExternalIdV2,
  sameClaimGeneration, JOB_CONTRACT_V2, MAX_ATTEMPT_V2 } from '../src/job-v2.mjs';
import { jobId as jobIdV1 } from '../src/queue.mjs';
import { verifyResultV2 } from '../src/proof-v2.mjs';
import { recordBatchClaim, readBatchClaim } from '../src/batch-claim-v2.mjs';
import { validateRecordInputs, assembleRecord, writeRecord } from '../src/resident-v2/prepare-record.mjs';
import { validateRecordV2 } from '../src/resident-v2/record.mjs';
import { deriveBatch, residentBatchKey, writeBatch, main as deriveMain } from '../src/resident-v2/derive-batch.mjs';
import { readSealedStage } from '../src/resident-v2/stage-package.mjs';
import { makeBrokerRequest, validateBrokerRequest, validateBrokerResponse, BROKER_RESPONSE_CONTRACT } from '../src/resident-v2/broker-protocol.mjs';
import { FORMAL_STAGES_V2, RESIDENT_SID, serviceSid } from '../src/resident-v2/layout.mjs';
import { NOW, HEAD, BASE, iso, hex, tempDir, fixtureRecord, writeRecordDir, subject, signResult, recordInputs, sourceFiles } from './resident-v2-fixtures.mjs';

const base = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(NOW), attempt: 1, ...o });

test('job v2: identity is content + attempt, never a claim, and is domain-separated from v1', () => {
  const j = makeJobV2({ ...base(), role: 'gitleaks' });
  assert.equal(j.contract, JOB_CONTRACT_V2);
  assert.equal(j.id, jobIdV2(j));
  assert.ok(!('claimId' in j) && !('fence' in j) && !('epoch' in j));
  // attempt 2 has a different id (Owner decision 1b5d3687: new job ids, never re-run a settled id)
  assert.notEqual(makeJobV2({ ...base({ attempt: 2 }), role: 'gitleaks' }).id, j.id);
  assert.throws(() => makeJobV2({ ...base({ attempt: MAX_ATTEMPT_V2 + 1 }), role: 'gitleaks' }), { code: 'invalid_job_v2' });
  // createdAt is not identity; head/base/pr/source/role are
  assert.equal(makeJobV2({ ...base({ createdAt: iso(NOW + 5) }), role: 'gitleaks' }).id, j.id);
  for (const k of ['pr', 'headSha', 'baseSha', 'testSha', 'sourceManifestSha256']) assert.notEqual(makeJobV2({ ...base({ [k]: k === 'pr' ? 889 : 'f'.repeat(k === 'sourceManifestSha256' ? 64 : 40) }), role: 'gitleaks' }).id, j.id);
  // a v1-shaped id over the same content never equals the v2 id
  assert.notEqual(jobIdV1({ repo: j.repo, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, claimId: randomUUID(), fence: 1, epoch: 1, sourceManifestSha256: j.sourceManifestSha256, role: j.role }), j.id);
  assert.throws(() => validateJobV2({ ...j, claimId: randomUUID() }), { code: 'invalid_job_v2' });
  assert.throws(() => validateJobV2({ ...j, id: 'f'.repeat(64) }), { code: 'invalid_job_v2' });
});

test('job v2: six batch jobs share one batch ref; publication identities split scan from admission', () => {
  const jobs = batchJobsV2(base());
  assert.equal(Object.keys(jobs).length, 6);
  const ref = batchRefV2(jobs.gitleaks);
  assert.ok(Object.values(jobs).every(j => batchRefV2(j) === ref));
  assert.equal(ref, jobs['work-admission'].id);
  const def = { name: 'gitleaks', appId: 5368905 };
  assert.match(scanExternalIdV2(jobs.gitleaks), /^independent-ci:staged:v2:[0-9a-f]{64}:a1$/);
  const c1 = { claimId: randomUUID(), fence: 3, epoch: 1, expiresAt: iso(NOW + 3600_000) };
  const renewed = { ...c1, expiresAt: iso(NOW + 7200_000) };
  const takeover = { ...c1, fence: 4 };
  assert.ok(sameClaimGeneration(c1, renewed) && !sameClaimGeneration(c1, takeover));
  // a renewal is the same admission effect; a takeover is a new one
  const k = admissionEffectKeyV2('independent-control-check/2', jobs['control-admission'], c1, def);
  assert.equal(admissionEffectKeyV2('independent-control-check/2', jobs['control-admission'], renewed, def), k);
  assert.notEqual(admissionEffectKeyV2('independent-control-check/2', jobs['control-admission'], takeover, def), k);
  assert.match(admissionExternalIdV2('independent-ci:control:control-admission', jobs['control-admission'], c1), /:v2:[0-9a-f]{64}:a1:c[0-9a-f]{8}:f3:e1$/);
  // the scan key is claim-free: identical across claims
  assert.equal(scanEffectKeyV2(jobs.gitleaks, def), scanEffectKeyV2(structuredClone(jobs.gitleaks), def));
});

test('proof v2: exact claim-free subject, v2 contracts, signature and freshness', () => {
  const { signer, docs } = fixtureRecord();
  const record = validateRecordV2(docs, { now: NOW });
  const job = makeJobV2({ ...base({ createdAt: iso(NOW - 60_000) }), role: 'trivy' });
  const env = signResult(job, signer);
  const v = verifyResultV2({ job, envelope: env, signers: record.signers, now: NOW });
  assert.equal(v.payload.conclusion, 'success');
  assert.throws(() => verifyResultV2({ job: makeJobV2({ ...base({ createdAt: iso(NOW - 60_000), attempt: 2 }), role: 'trivy' }), envelope: env, signers: record.signers, now: NOW }), { code: 'result_subject_mismatch' });
  const extra = structuredClone(env); extra.payload.subject.claimId = randomUUID();
  assert.throws(() => verifyResultV2({ job, envelope: extra, signers: record.signers, now: NOW }), { code: 'result_subject_mismatch' });
  const tampered = structuredClone(env); tampered.payload.conclusion = 'failure'; tampered.payload.exitCode = 1;
  assert.throws(() => verifyResultV2({ job, envelope: tampered, signers: record.signers, now: NOW }), { code: 'result_signature_invalid' });
  assert.throws(() => verifyResultV2({ job, envelope: { ...env, contract: 'independent-ci.signed-result.v1' }, signers: record.signers, now: NOW }), { code: 'invalid_evidence_envelope' });
  assert.throws(() => verifyResultV2({ job, envelope: env, signers: record.signers, now: NOW + 700_000 }), { code: 'stale_or_invalid_result_time' });
});

test('batch claim: stage 1 records it once; later stages read it; another generation fails closed', async t => {
  const dir = await tempDir(t);
  const jobs = batchJobsV2(base());
  const c = { claimId: randomUUID(), fence: 2, epoch: 1, expiresAt: iso(NOW + 3600_000) };
  await assert.rejects(readBatchClaim(dir, jobs.gitleaks), { code: 'BATCH_CLAIM_MISSING' });
  await assert.rejects(recordBatchClaim(dir, jobs.gitleaks, c, iso(NOW)), { code: 'BATCH_CLAIM_RECORD_STAGE_ONE_ONLY' });
  assert.equal((await recordBatchClaim(dir, jobs['work-admission'], c, iso(NOW))).created, true);
  assert.equal((await recordBatchClaim(dir, jobs['work-admission'], { ...c, expiresAt: iso(NOW + 9) }, iso(NOW))).created, false); // a renewal is the same claim
  await assert.rejects(recordBatchClaim(dir, jobs['work-admission'], { ...c, epoch: 2 }, iso(NOW)), { code: 'BATCH_CLAIM_CHANGED' });
  assert.deepEqual(await readBatchClaim(dir, jobs['control-merge-slot']), { claimId: c.claimId, fence: 2, epoch: 1 });
  // attempt 2 is a different batch: no claim recorded for it yet
  await assert.rejects(readBatchClaim(dir, batchJobsV2(base({ attempt: 2 })).trivy), { code: 'BATCH_CLAIM_MISSING' });
  // a tampered record is refused, never trusted
  const file = path.join(dir, `${batchRefV2(jobs.gitleaks)}.json`);
  const v = JSON.parse(await fs.readFile(file, 'utf8')); v.claim.fence = 9;
  await fs.rm(file); await fs.writeFile(file, JSON.stringify(v));
  await assert.rejects(readBatchClaim(dir, jobs.gitleaks), { code: 'BATCH_CLAIM_RECORD_INVALID' });
});

test('install record: claim-free, validUntil null is accepted, every binding is re-checked', async t => {
  const r = fixtureRecord();
  const v = validateRecordV2(r.docs, { now: NOW });
  assert.equal(v.accepted.validUntil, null);
  assert.equal(v.accepted.claimBound, false);
  assert.ok(!JSON.stringify(v.config).includes('currentClaim'));
  // a future review deadline also works; a past one does not
  assert.throws(() => validateRecordInputs(recordInputs({ owner: { ...r.inputs.owner, validUntil: iso(NOW - 1) } }), NOW), { code: 'SOURCE_ACCEPTANCE_WINDOW_REQUIRED' });
  assert.doesNotThrow(() => validateRecordInputs(recordInputs({ owner: { ...r.inputs.owner, validUntil: iso(NOW + 30 * 86400_000) } }), NOW));
  // a token-like key anywhere in the inputs is refused
  assert.throws(() => validateRecordInputs({ ...recordInputs(), ciAdmissionToken: 'x' }, NOW), { code: 'PRIVATE_OR_LEGACY_INPUT_REFUSED' });
  for (const [name, mutate, code] of [
    ['acceptance.json', a => ({ ...a, claimBound: true }), 'RECORD_BINDING_CHANGED'],
    ['installation.json', c => ({ ...c, currentClaim: { claimId: randomUUID() } }), 'RECORD_CONTROLLER_CONFIG_REQUIRED'],
  ]) {
    const docs = { ...r.docs, [name]: Buffer.from(JSON.stringify(mutate(JSON.parse(r.files[name])))) };
    assert.throws(() => validateRecordV2(docs, { now: NOW }), e => ['RECORD_CANONICAL_BYTES_REQUIRED', code, 'RECORD_BINDING_CHANGED', 'RECORD_ACCEPTANCE_REQUIRED'].includes(e.code));
  }
  const out = path.join(await tempDir(t), 'record');
  const written = writeRecord(out, assembleRecord(r.inputs, sourceFiles()));
  assert.equal(written.status, 'RESIDENT_RECORD_PREPARED');
  assert.throws(() => writeRecord(out, assembleRecord(r.inputs, sourceFiles())), { code: 'RECORD_OUTPUT_EXISTS_PRESERVE_NO_RETRY' });
});

test('derive-batch: deterministic eight sealed stages, jobs carry attempt, key and id are bound', async t => {
  const { docs } = fixtureRecord();
  const s = subject();
  const key = residentBatchKey(s);
  const id = `${key.slice(0, 16)}-${hex(6)}`;
  const a = deriveBatch({ recordDocs: docs, subject: s, batchKey: key, batchId: id, now: NOW });
  const b = deriveBatch({ recordDocs: docs, subject: structuredClone(s), batchKey: key, batchId: id, now: NOW + 1000 });
  assert.deepEqual(a.files, b.files);
  assert.equal(a.result.status, 'RESIDENT_BATCH_DERIVED');
  // job contract /3 (3b review r2 m1): the result names the tested commit the engine copies into the descriptor (S = H)
  assert.equal(a.result.testSha, s.headSha);
  assert.equal(a.result.stages.length, 8);
  assert.deepEqual(a.result.stages.map(x => x.entryRole), FORMAL_STAGES_V2.map(x => x.entryRole));
  assert.equal(a.result.stages[1].jobId, a.result.stages[2].jobId); // execution and publication share the job
  assert.equal(a.result.stages[7].jobIds.length, 2);
  assert.throws(() => deriveBatch({ recordDocs: docs, subject: s, batchKey: 'f'.repeat(64), batchId: id, now: NOW }), { code: 'RESIDENT_BATCH_KEY_MISMATCH' });
  assert.throws(() => deriveBatch({ recordDocs: docs, subject: s, batchKey: key, batchId: `${'0'.repeat(16)}-${hex(6)}`, now: NOW }), { code: 'RESIDENT_BATCH_ID_REFUSED' });
  assert.throws(() => deriveBatch({ recordDocs: docs, subject: { ...s, claimId: randomUUID() }, batchKey: key, batchId: id, now: NOW }), { code: 'RESIDENT_SUBJECT_FIELDS_REQUIRED' });
  const s2 = subject({ attempt: 2 });
  const two = deriveBatch({ recordDocs: docs, subject: s2, batchKey: residentBatchKey(s2), batchId: `${residentBatchKey(s2).slice(0, 16)}-${hex(6)}`, now: NOW });
  assert.ok(two.result.stages.every((row, i) => row.jobId !== a.result.stages[i].jobId)); // attempt 2: all new job ids
  // write, then read every stage back against its pin; a changed byte is refused
  const dir = path.join(await tempDir(t), 'batch');
  writeBatch(dir, a.files);
  for (const row of a.result.stages) {
    const sealed = await readSealedStage(dir, row.number, row.workManifestSha256);
    assert.equal(sealed.plan.batchKey, key);
    assert.equal(sealed.planSha256, row.planSha256);
  }
  await assert.rejects(readSealedStage(dir, 1, 'f'.repeat(64)), { code: 'EXACT_REVIEWED_STAGE_MANIFEST_REQUIRED' });
  const jobsFile = path.join(dir, 'stage-03', 'jobs.json');
  const bytes = await fs.readFile(jobsFile); await fs.rm(jobsFile); await fs.writeFile(jobsFile, Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(readSealedStage(dir, 3, a.result.stages[2].workManifestSha256), { code: 'SEALED_STAGE_SOURCE_CHANGED' });
  assert.throws(() => writeBatch(dir, a.files), { code: 'RESIDENT_BATCH_EXISTS_PRESERVE_NO_RETRY' });
});

test('derive-batch CLI keeps the engine contract (--subject-json --batch-key --batch-id --out)', async t => {
  const root = await tempDir(t);
  const { files } = fixtureRecord();
  const record = await writeRecordDir(path.join(root, 'record'), files);
  const s = subject();
  const key = residentBatchKey(s);
  let text = '';
  const code = deriveMain(['--subject-json', JSON.stringify(s), '--batch-key', key, '--batch-id', `${key.slice(0, 16)}-${hex(6)}`, '--out', path.join(root, 'out'), '--record', record],
    { now: NOW, output: { write: x => { text += x; } } });
  assert.equal(code, 0);
  const v = JSON.parse(text);
  assert.equal(v.status, 'RESIDENT_BATCH_DERIVED');
  assert.ok(v.stages.filter(r => [2, 4, 6].includes(r.number)).every(r => /^[0-9a-f]{64}$/.test(r.jobId)));
  assert.throws(() => deriveMain(['--subject-json', JSON.stringify(s), '--batch-key', key, '--bogus', 'x'], { now: NOW }), { code: 'RESIDENT_DERIVATION_ARGUMENTS_REFUSED' });
});

test('broker protocol: five fields, bounded deadline, exact response, ok implies a complete swap', () => {
  const req = makeBrokerRequest({ stage: 2, nonce: hex(16), configSha256: hex(32), now: NOW });
  assert.deepEqual(Object.keys(req).sort(), ['configSha256', 'contract', 'deadline', 'nonce', 'stage']);
  assert.equal(validateBrokerRequest(req, NOW), req);
  assert.throws(() => validateBrokerRequest(req, Date.parse(req.deadline) - 60_000), { code: 'BROKER_REQUEST_EXPIRED' });
  assert.throws(() => validateBrokerRequest({ ...req, helper: 'x' }, NOW), { code: 'BROKER_REQUEST_SHAPE' });
  assert.throws(() => validateBrokerRequest({ ...req, stage: 10 }, NOW), { code: 'BROKER_REQUEST_FIELDS' });
  const id = randomUUID();
  const ok = { contract: BROKER_RESPONSE_CONTRACT, requestId: id, ok: true, code: null, started: true, startCallIssued: true, helperPid: 4242, stoppedInTime: true, restored: true, accountUnchanged: true, stableBefore: true, stableAfter: true, configurationConflict: false };
  assert.ok(validateBrokerResponse(ok, id));
  assert.equal(validateBrokerResponse({ ...ok, restored: false }, id), null); // ok without restore is malformed
  assert.equal(validateBrokerResponse({ ...ok, ok: false, code: 'SOMETHING_ELSE' }, id), null);
  assert.equal(validateBrokerResponse(ok, randomUUID()), null);
});

test('layout: the resident virtual account SID is the SCM service SID of CluedCIResident', () => {
  assert.equal(serviceSid('TrustedInstaller'), 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');
  assert.match(RESIDENT_SID, /^S-1-5-80-\d+-\d+-\d+-\d+-\d+$/);
});
