// Quota phase 2 step 3c-2a (design v0.5 §5.2): a train front batch's subject names its tested commit S. The ledger's
// batch key and the Source v2 derivation's key (derive-batch.mjs#residentBatchKey) must stay one formula: equal for a
// subject without S (every key that exists today) and equal for a subject with S, which is never the head.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchKey, headKey } from '../src/ledger.mjs';
import { residentBatchKey } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/derive-batch.mjs';
import { HEAD, BASE, SOURCE } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const S = '4'.repeat(40);

test('batch key: the ledger and the Source v2 derivation agree with and without S', () => {
  for (const s of [subject(), subject({ attempt: 2 }), subject({ testSha: S }), subject({ testSha: S, attempt: 2 })])
    assert.equal(batchKey(s), residentBatchKey(s), JSON.stringify(s));
  // createdAt is never part of the key
  assert.equal(batchKey(subject({ testSha: S, createdAt: '2026-10-28T00:00:00.000Z' })), batchKey(subject({ testSha: S })));
  assert.notEqual(batchKey(subject({ testSha: S })), batchKey(subject()));
  assert.notEqual(batchKey(subject({ testSha: S })), batchKey(subject({ testSha: '5'.repeat(40) })));
  // the head key (one execution per head, I2) does not see S
  assert.equal(headKey(subject({ testSha: S })), headKey(subject()));
});

test('batch key: S equal to the head or malformed is refused', () => {
  for (const testSha of [HEAD, 'X'.repeat(40), S.slice(1), null])
    assert.throws(() => batchKey(subject({ testSha })), e => e.code === 'BATCH_KEY_COMMIT_INVALID');
});
