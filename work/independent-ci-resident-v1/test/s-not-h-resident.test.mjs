// Quota phase 2 step 3c-2a (design v0.5 §5.2): a train front batch's subject names its tested commit S. The ledger's
// batch key and the Source v2 derivation's key (derive-batch.mjs#residentBatchKey) must stay one formula: equal for a
// subject without S (every key that exists today) and equal for a subject with S, which is never the head.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HEAD_KEY_CONTRACT, batchKey, headKey } from '../src/ledger.mjs';
import { EXECUTED_HEAD_KEY_CONTRACT, ExecutedHeads, executedHeadKey } from '../src/executed-heads.mjs';
import { digest } from '../src/canonical.mjs';
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
  // the head key (one execution per head, I2): S = H keeps the key it always had; a front batch is its own identity (H, S)
  // (DESIGN §41.4), apart from the non-front run of H and from another S
  assert.equal(headKey(subject()), digest({ contract: HEAD_KEY_CONTRACT, repo: 'tdoljyj/cross-memory-system', headSha: HEAD, sourceManifestSha256: SOURCE, attempt: 1 }));
  assert.notEqual(headKey(subject({ testSha: S })), headKey(subject()));
  assert.notEqual(headKey(subject({ testSha: S })), headKey(subject({ testSha: '5'.repeat(40) })));
  assert.equal(headKey(subject({ testSha: S, pr: 990, baseSha: '6'.repeat(40) })), headKey(subject({ testSha: S })), 'PR and base are still not part of it');
});

test('executed heads: a front batch (H, S) is published only by its own records; the non-front run of H is another identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eh-front-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const heads = await ExecutedHeads.open(root, () => Date.parse('2026-10-31T00:00:00Z'));
  const plain = subject(), front = subject({ testSha: S });
  assert.equal(executedHeadKey(plain), digest({ contract: EXECUTED_HEAD_KEY_CONTRACT, repo: plain.repo, headSha: HEAD }).slice(0, 32), 'S = H: the key it always had');
  await heads.record(plain, { key: batchKey(plain), origin: 'publication', basis: 'before-stage-3', stage: 3 });
  assert.equal(await heads.published(plain), true);
  assert.equal(await heads.published(front), false, 'the non-front run of H does not make the front batch published');
  await heads.record(front, { key: batchKey(front), origin: 'publication', basis: 'before-stage-3', stage: 3 });
  assert.equal(await heads.published(front), true);
  assert.equal(await heads.published(subject({ testSha: '5'.repeat(40) })), false, 'another S');
  const [name] = await fs.readdir(heads.headDir(front));
  const rec = JSON.parse(await fs.readFile(path.join(heads.headDir(front), name), 'utf8'));
  assert.equal(rec.testSha, S, 'the record names S, so a later backfill files it under (H, S)');
  const [plainName] = await fs.readdir(heads.headDir(plain));
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(heads.headDir(plain), plainName), 'utf8')), 'testSha'), false, 'S = H: the record as before');
  for (const testSha of [HEAD, 'x', null]) assert.throws(() => executedHeadKey(subject({ testSha })), { code: 'EXECUTED_HEAD_SUBJECT_INVALID' });
});

test('batch key: S equal to the head or malformed is refused', () => {
  for (const testSha of [HEAD, 'X'.repeat(40), S.slice(1), null])
    assert.throws(() => batchKey(subject({ testSha })), e => e.code === 'BATCH_KEY_COMMIT_INVALID');
});
