// Stage 10's job and stage row (resident quota redesign phase 2, step 3c-1; DESIGN §21.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TRAIN_RUN_CONTRACT, TRAIN_RUN_MODES, makeTrainRun, trainRunJobId, trainRunKey, validateTrainRun } from '../src/resident-v2/train-run.mjs';
import { ENTRY_V2, FORMAL_STAGES_V2, STAGES_V2, TRAIN_STAGE_NUMBER, TRAIN_STAGE_V2, STATE_V2 } from '../src/resident-v2/layout.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const seed = 'a'.repeat(64);
const key = trainRunKey({ repo: REPO, seed });
const run = (o = {}) => makeTrainRun({ repo: REPO, runId: `${key.slice(0, 16)}-0123456789ab`, mode: 'shadow', sourceManifestSha256: 'e'.repeat(64), createdAt: '2026-10-23T05:00:00.000Z', ...o });

test('train run: contract, id over the identity, shadow only in step 3c-1', () => {
  const job = run();
  assert.equal(job.contract, TRAIN_RUN_CONTRACT);
  assert.equal(job.id, createHash('sha256').update(JSON.stringify([TRAIN_RUN_CONTRACT, REPO, job.runId, 'shadow', 'e'.repeat(64)])).digest('hex'));
  assert.equal(trainRunJobId(job), job.id);
  assert.deepEqual(TRAIN_RUN_MODES, ['shadow']);
  // createdAt is not part of the id; every identity field is
  assert.equal(run({ createdAt: '2026-10-23T06:00:00.000Z' }).id, job.id);
  assert.notEqual(run({ runId: `${key.slice(0, 16)}-ffffffffffff` }).id, job.id);
  for (const bad of [{ ...job, mode: 'on' }, { ...job, id: '0'.repeat(64) }, { ...job, runId: 'x' }, { ...job, extra: 1 }, { ...job, repo: 'a' }, { ...job, contract: 'clued.independent-ci.job/3' }])
    assert.throws(() => validateTrainRun(bad), e => e.code === 'invalid_train_run');
  assert.throws(() => run({ mode: 'on' }), e => e.code === 'invalid_train_run');
});

test('train run: the key comes from a fresh seed, never from content', () => {
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(trainRunKey({ repo: REPO, seed: randomBytes(32).toString('hex') }), key);
  assert.throws(() => trainRunKey({ repo: REPO, seed: 'short' }), e => e.code === 'TRAIN_RUN_KEY_REFUSED');
});

test('stage 10: a train row outside the batch, with its own entry and state directory', () => {
  assert.equal(TRAIN_STAGE_NUMBER, 10);
  assert.deepEqual([TRAIN_STAGE_V2.kind, TRAIN_STAGE_V2.entryRole, TRAIN_STAGE_V2.jobRoles, TRAIN_STAGE_V2.runMilliseconds, TRAIN_STAGE_V2.linuxWorker],
    ['train', 'train-maintenance', ['train-run'], 300_000, false]);
  assert.equal(STAGES_V2.length, 10);
  assert.ok(!FORMAL_STAGES_V2.some(s => s.number === 10), 'stage 10 is never one of the batch stages');
  assert.equal(ENTRY_V2['train-maintenance'], 'work/actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-maintenance.mjs');
  assert.match(STATE_V2.trainShadow, /\\state\\v2\\train-shadow$/);
});

test('derive-batch --train-run: one sealed stage-10 package the stage reader accepts, from the installed record', async t => {
  const { fixtureRecord, tempDir, NOW } = await import('./resident-v2-fixtures.mjs');
  const { deriveTrainRun, writeBatch } = await import('../src/resident-v2/derive-batch.mjs');
  const { readSealedStage } = await import('../src/resident-v2/stage-package.mjs');
  const rec = fixtureRecord();
  const runKey = trainRunKey({ repo: REPO, seed: 'c'.repeat(64) }), runId = `${runKey.slice(0, 16)}-0123456789ab`;
  const a = deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW });
  assert.deepEqual(a.files, deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW }).files, 'deterministic');
  assert.deepEqual([a.result.status, a.result.stage.number, a.result.stage.entryRole, a.result.stage.jobIds.length], ['RESIDENT_TRAIN_RUN_DERIVED', 10, 'train-maintenance', 1]);
  const dir = path.join(await tempDir(t), 'train-run');
  writeBatch(dir, a.files);
  const sealed = await readSealedStage(dir, 10, a.result.stage.workManifestSha256);
  const job = JSON.parse(sealed.files['jobs.json'].toString('utf8'))[0];
  assert.deepEqual([sealed.plan.batchKey, sealed.plan.batchId, sealed.stage.jobRoles, job.runId, job.mode, validateTrainRun(job).id], [runKey, runId, ['train-run'], runId, 'shadow', a.result.stage.jobId]);
  for (const bad of [{ runKey: 'x' }, { runId: 'f'.repeat(16) + '-0123456789ab' }, { mode: 'on' }])
    assert.throws(() => deriveTrainRun({ recordDocs: rec.docs, runId, runKey, mode: 'shadow', now: NOW, ...bad }), { code: 'RESIDENT_TRAIN_RUN_REFUSED' });
});
