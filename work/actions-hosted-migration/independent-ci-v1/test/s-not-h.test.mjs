// Quota phase 2 step 3c-2a (design v0.5 §5.2, §5.7; DESIGN §21.3): a train front batch tests GitHub's test merge S of
// [T, H], so S != H. Everything that names the tested commit carries S end to end (job, batch claim record, control
// consumer, subject and batch key); the checks that compare the PR's base.sha with T relax only when S != H; the hosted
// relay never carries such a batch. A batch that tests the head (S = H) keeps every byte, key and check it had.
// The admission, publisher and stage 8 halves are in resident-v2-admission.test.mjs and resident-v2-publishers.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { batchJobsV2, batchRefV2, isTrainFrontJobV2, makeJobV2, prBaseAcceptedV2 } from '../src/job-v2.mjs';
import { BATCH_CLAIM_CONTRACT, BATCH_CLAIM_CONTRACT_FRONT, recordBatchClaim, readBatchClaim, recordTestShaV2, validateBatchClaimRecord } from '../src/batch-claim-v2.mjs';
import { controlJobsFor } from '../src/independent-control-checks-v2/consumer.mjs';
import { CONTROL_CHECKS_V2 } from '../src/independent-control-checks-v2/publisher.mjs';
import { deriveBatch, deriveRelayStage, residentBatchKey, subjectTestSha, validateSubject } from '../src/resident-v2/derive-batch.mjs';
import { relaySubject } from '../src/hosted-relay-v1/relay-entry-v2.mjs';
import { collectCompleteRemoteRefs } from '../worker/protected-controller-ports-v2/refs.mjs';
import { NOW, HEAD, BASE, iso, tempDir, fixtureRecord, subject } from './resident-v2-fixtures.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const S = '4'.repeat(40), MOVED = '9'.repeat(40);
const base = (o = {}) => ({ repo: REPO, pr: 888, headSha: HEAD, baseSha: BASE, testSha: HEAD, sourceManifestSha256: 'd'.repeat(64), createdAt: iso(NOW), attempt: 1, ...o });
const claim = () => ({ claimId: randomUUID(), fence: 2, epoch: 1, expiresAt: iso(NOW + 3600_000) });

test('job /3: a train front batch is exactly S != H; only it accepts a PR base.sha other than T', () => {
  const head = makeJobV2({ ...base(), role: 'trivy' }), front = makeJobV2({ ...base({ testSha: S }), role: 'trivy' });
  assert.deepEqual([isTrainFrontJobV2(head), isTrainFrontJobV2(front)], [false, true]);
  // no tested commit (a v1 job) or a malformed one is never a front batch
  for (const j of [{ headSha: HEAD }, { headSha: HEAD, testSha: null }, { headSha: HEAD, testSha: 'X'.repeat(40) }, null]) assert.equal(isTrainFrontJobV2(j), false);
  assert.deepEqual([prBaseAcceptedV2(head, BASE), prBaseAcceptedV2(head, MOVED)], [true, false]);
  assert.deepEqual([prBaseAcceptedV2(front, BASE), prBaseAcceptedV2(front, MOVED)], [true, true]);
  for (const bad of [undefined, null, '', 'X'.repeat(40), MOVED.slice(1)]) assert.equal(prBaseAcceptedV2(front, bad), false);
});

test('batch claim: a front batch records S under contract /2; a batch that tests the head keeps /1 byte for byte', async t => {
  const dir = await tempDir(t), c = claim();
  const head = batchJobsV2(base()), front = batchJobsV2(base({ testSha: S }));
  assert.notEqual(batchRefV2(head['work-admission']), batchRefV2(front['work-admission']), 'another S is another batch');
  await recordBatchClaim(dir, head['work-admission'], c, iso(NOW));
  await recordBatchClaim(dir, front['work-admission'], c, iso(NOW));
  const read = async jobs => JSON.parse(await fs.readFile(path.join(dir, `${batchRefV2(jobs['work-admission'])}.json`), 'utf8'));
  const h = await read(head), f = await read(front);
  assert.equal(h.contract, BATCH_CLAIM_CONTRACT);
  const keys = r => Object.keys(r).sort();
  assert.deepEqual(keys(h), ['attempt', 'baseSha', 'batchRef', 'claim', 'contract', 'createdAt', 'headSha', 'integrity', 'observedAt', 'pr', 'repo', 'sourceManifestSha256']);
  assert.equal(f.contract, BATCH_CLAIM_CONTRACT_FRONT);
  assert.deepEqual(keys(f), [...keys(h), 'testSha'].sort());
  assert.deepEqual([recordTestShaV2(h), recordTestShaV2(f), recordTestShaV2(null)], [HEAD, S, undefined]);
  // every later stage reads the same generation
  assert.deepEqual(await readBatchClaim(dir, front.gitleaks), { claimId: c.claimId, fence: 2, epoch: 1 });
  // a record never validates for the other shape, another S, or with its S taken away
  assert.throws(() => validateBatchClaimRecord(f, head['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
  assert.throws(() => validateBatchClaimRecord(h, front['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
  assert.throws(() => validateBatchClaimRecord({ ...f, testSha: '5'.repeat(40) }, front['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
  const { testSha: _s, ...stripped } = f;
  assert.throws(() => validateBatchClaimRecord({ ...stripped, contract: BATCH_CLAIM_CONTRACT }, front['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
  assert.throws(() => validateBatchClaimRecord({ ...f, contract: BATCH_CLAIM_CONTRACT }, front['work-admission']), { code: 'BATCH_CLAIM_RECORD_INVALID' });
});

test('control consumer: a front record re-derives the jobs on its own S and is matched whatever base.sha the gate passes', async t => {
  const dir = await tempDir(t), c = claim();
  const head = batchJobsV2(base()), front = batchJobsV2(base({ testSha: S, pr: 889 }));
  await recordBatchClaim(dir, head['work-admission'], c, iso(NOW));
  await recordBatchClaim(dir, front['work-admission'], c, iso(NOW));
  const records = await Promise.all([head, front].map(async j => JSON.parse(await fs.readFile(path.join(dir, `${batchRefV2(j['work-admission'])}.json`), 'utf8'))));
  const name = CONTROL_CHECKS_V2['control-admission'].name;
  const found = (o) => controlJobsFor(records, { repository: REPO, headSha: HEAD, name, ...o }, 'd'.repeat(64));
  // the front batch: its own S and T, matched on the PR's base.sha GitHub reports (here not T)
  const f = found({ pr: 889, baseSha: MOVED });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].job.id, f[0].job.testSha, f[0].selector.baseSha], [front['control-admission'].id, S, BASE]);
  // the batch that tests the head is still matched on T only
  assert.deepEqual(found({ pr: 888, baseSha: MOVED }), []);
  assert.equal(found({ pr: 888, baseSha: BASE })[0].job.id, head['control-admission'].id);
  // a /2 record whose S was swapped is skipped (it no longer validates)
  const forged = records.map(r => (r.contract === BATCH_CLAIM_CONTRACT_FRONT ? { ...r, testSha: '5'.repeat(40) } : r));
  assert.deepEqual(controlJobsFor(forged, { repository: REPO, headSha: HEAD, name, pr: 889, baseSha: MOVED }, 'd'.repeat(64)), []);
});

test('resident subject: S joins the subject and the batch key only for a front batch; the batch and its jobs test S', () => {
  const s = subject(), f = subject({ testSha: S });
  assert.equal(validateSubject(f, NOW), f);
  assert.deepEqual([subjectTestSha(s), subjectTestSha(f)], [HEAD, S]);
  // S = H in the subject, a malformed S or an extra field is refused
  assert.throws(() => validateSubject(subject({ testSha: HEAD }), NOW), { code: 'RESIDENT_SUBJECT_REFUSED' });
  assert.throws(() => validateSubject(subject({ testSha: 'X'.repeat(40) }), NOW), { code: 'RESIDENT_SUBJECT_REFUSED' });
  assert.throws(() => validateSubject(subject({ testSha: S, tested: S }), NOW), { code: 'RESIDENT_SUBJECT_FIELDS_REQUIRED' });
  // the key of a subject without S is what it always was; another S is another key
  assert.equal(residentBatchKey(s), residentBatchKey({ ...s }));
  assert.notEqual(residentBatchKey(f), residentBatchKey(s));
  assert.notEqual(residentBatchKey(f), residentBatchKey(subject({ testSha: '5'.repeat(40) })));
  const r = fixtureRecord(), key = residentBatchKey(f), batchId = key.slice(0, 16) + '-123456789abc';
  const d = deriveBatch({ recordDocs: r.docs, subject: f, batchKey: key, batchId, now: NOW });
  assert.equal(d.result.testSha, S);
  for (const [n, text] of Object.entries(d.files)) if (n.endsWith('/jobs.json')) for (const j of JSON.parse(text)) assert.deepEqual([j.headSha, j.baseSha, j.testSha], [HEAD, BASE, S]);
  assert.deepEqual(JSON.parse(d.files['batch.json']).subject, f);
  // the key must be the subject's own: the head-only key does not derive a front batch
  const headKey = residentBatchKey(s);
  assert.throws(() => deriveBatch({ recordDocs: r.docs, subject: f, batchKey: headKey, batchId: headKey.slice(0, 16) + '-123456789abc', now: NOW }), { code: 'RESIDENT_BATCH_KEY_MISMATCH' });
});

test('hosted relay: a train front batch never gets a stage R package or a relay subject', () => {
  const r = fixtureRecord(), f = subject({ testSha: S }), key = residentBatchKey(f), batchId = key.slice(0, 16) + '-123456789abc';
  const d = deriveBatch({ recordDocs: r.docs, subject: f, batchKey: key, batchId, now: NOW });
  assert.throws(() => deriveRelayStage({ recordDocs: r.docs, batchJson: d.files['batch.json'], roles: ['gitleaks', 'trivy'], batchKey: key, batchId, now: NOW }),
    { code: 'RESIDENT_RELAY_TEST_COMMIT_REFUSED' });
  const c = { claimId: randomUUID(), fence: 3, epoch: 1 };
  const head = batchJobsV2(base()), front = batchJobsV2(base({ testSha: S }));
  assert.equal(relaySubject([head.gitleaks, head.trivy], c).headSha, HEAD);
  for (const jobs of [[front.gitleaks], [head.gitleaks, front.trivy]]) assert.throws(() => relaySubject(jobs, c), { code: 'RELAY_TEST_COMMIT_REFUSED' });
  assert.throws(() => relaySubject([], c), { code: 'RELAY_SUBJECT_JOBS_REQUIRED' });
});

test('protected refs observation: the PR base.sha is a fact for a front batch, and main must still be T', async () => {
  const reply = mainSha => ({ data: { repository: { databaseId: 1334673495, nameWithOwner: REPO, refs: null } }, mainSha });
  const page = (prefix, mainSha) => {
    const edges = prefix === 'refs/heads/' ? [{ cursor: 'c1', node: { name: 'main', prefix, target: { oid: mainSha, __typename: 'Commit' } } }] : [];
    const body = reply(mainSha);
    body.data.repository.refs = { totalCount: edges.length, edges, pageInfo: { hasNextPage: false, endCursor: edges.at(-1)?.cursor ?? null } };
    delete body.mainSha;
    const bytes = Buffer.from(JSON.stringify(body));
    return { ok: true, body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: bytes })), releaseLock() {} }; } } };
  };
  // prBase: one base.sha for every read, or a list read in turn (the first and the second read of the PR)
  const run = (job, prBase, mainSha = BASE) => { let reads = 0; return collectCompleteRemoteRefs({ job, token: 'gh-fixture',
    readPullRequest: async n => ({ number: n, state: 'open', head: { sha: HEAD, repo: { full_name: REPO } }, base: { sha: Array.isArray(prBase) ? prBase[reads++] : prBase, ref: 'main', repo: { full_name: REPO } } }),
    fetchImpl: async (_url, init) => page(JSON.parse(init.body).variables.prefix, mainSha) }); };
  const head = makeJobV2({ ...base({ createdAt: iso(Date.now()) }), role: 'gitleaks' }), front = makeJobV2({ ...base({ testSha: S, createdAt: iso(Date.now()) }), role: 'gitleaks' });
  assert.equal((await run(front, MOVED)).refs[0].objectSha, BASE);
  assert.equal((await run(head, BASE)).complete, true);
  await assert.rejects(run(head, MOVED), { code: 'REFS_PR_SUBJECT_CHANGED' });
  await assert.rejects(run(front, MOVED, MOVED), { code: 'REFS_MAIN_BASE_CHANGED' });
  // §38.8 n2: the base.sha GitHub reports for a front batch must be the same commit before and after the refs passes
  assert.equal((await run(front, [MOVED, MOVED])).complete, true);
  await assert.rejects(run(front, [MOVED, '8'.repeat(40)]), { code: 'REFS_PR_SUBJECT_CHANGED' });
  await assert.rejects(run(front, [BASE, MOVED]), { code: 'REFS_PR_SUBJECT_CHANGED' });
});
