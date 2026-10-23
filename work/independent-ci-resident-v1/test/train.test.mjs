// The merge train on the resident side, shadow mode (quota redesign phase 2, step 3c-1; DESIGN §22.3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { trainDue, trainPageLine, trainSummary, WOULD_DO } from '../src/train.mjs';
import { WOULD_DO as SOURCE_WOULD_DO, TRAIN_FACTS_CONTRACT } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-facts.mjs';

const MIN = 60_000, NOW = Date.parse('2026-10-23T12:00:00Z');
const train = { enabled: 'shadow', nonFrontRuns: true, maintenanceEveryMs: 10 * MIN, maintenanceMaxPerDay: 200 };

test('stage 10 is due when the train is not off, nothing runs, and the interval and the daily cap allow it', () => {
  assert.equal(trainDue({ train, now: NOW, runs: [], busy: false }), true);
  assert.equal(trainDue({ train: { ...train, enabled: 'off' }, now: NOW, runs: [], busy: false }), false);
  assert.equal(trainDue({ train, now: NOW, runs: [], busy: true }), false, 'never while a batch runs');
  assert.equal(trainDue({ train, now: NOW, runs: [NOW - 9 * MIN], busy: false }), false);
  assert.equal(trainDue({ train, now: NOW, runs: [NOW - 10 * MIN], busy: false }), true);
  // the daily cap counts the last 24 hours only
  const full = Array.from({ length: 200 }, (_, i) => NOW - 23 * 3600_000 + i * 1000);
  assert.equal(trainDue({ train, now: NOW, runs: full, busy: false }), false);
  assert.equal(trainDue({ train, now: NOW + 3600_000, runs: full, busy: false }), true);
  assert.equal(trainDue({ train: { ...train, maintenanceMaxPerDay: 0 }, now: NOW, runs: [], busy: false }), false);
});

test('the resident and Source v2 name the same train answers and contract', () => {
  assert.deepEqual([...WOULD_DO], [...SOURCE_WOULD_DO]);
  assert.equal(trainSummary({ contract: TRAIN_FACTS_CONTRACT, mode: 'shadow', at: 'x', wouldDo: 'NO_FRONT', front: null })?.wouldDo, 'NO_FRONT');
});

test('the summary keeps only what status and the PR page show; the page line is for the front PR only', () => {
  const facts = { contract: 'clued.independent-ci.train-facts/1', mode: 'shadow', at: '2026-10-23T12:00:00.000Z', onDuty: true, mainSha: '1'.repeat(40), rules: { strict: true, mergeOnly: false },
    front: { claimId: 'c', pr: 910, headSha: '2'.repeat(40) }, wouldDo: 'OPEN_FRONT_BATCH', wouldRevoke: [], wouldRevokeCount: 3 };
  const s = trainSummary(facts);
  assert.deepEqual({ ...s }, { at: facts.at, mode: 'shadow', wouldDo: 'OPEN_FRONT_BATCH', onDuty: true, front: { pr: 910, headSha: '2'.repeat(40) }, mainSha: '1'.repeat(40), strict: true, wouldRevokeCount: 3 });
  assert.match(trainPageLine(s, 910), /^列车影子（只记录，不执行）：你是合并队列车头。开车后会在 GitHub 的试合并提交上跑车头批次。$/);
  assert.equal(trainPageLine(s, 911), null);
  assert.equal(trainPageLine(trainSummary({ ...facts, wouldDo: 'NOT_ON_DUTY', front: null }), 910), null);
  for (const bad of [null, { ...facts, contract: 'x' }, { ...facts, mode: 'on' }, { ...facts, wouldDo: 'REVOKE' }]) assert.equal(trainSummary(bad), null);
});
