// Resident primary/standby design v0.4 §6.2 (C4, Task c2af8d17), the resident side: a head the Source found already
// published on GitHub at stage 1 (HEAD_PUBLISHED_ON_GITHUB) is burned and recorded as executed, with no attempt 2; a role
// found on GitHub before its first publication (ROLE_ALREADY_ON_GITHUB) ends the batch cleanly,
// never HALT and never a local stage for it; the PR page asks for a new commit. (Stage R's ON_GITHUB row went with the hosted relay, DESIGN §76.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { headKey } from '../src/ledger.mjs';
import { CLEAN_FINAL_CODES, decideFailure, failureRow } from '../src/classify.mjs';
import { executedHeadKey } from '../src/executed-heads.mjs';
import { describe } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { HEAD_PUBLISHED_ON_GITHUB, ROLE_ALREADY_ON_GITHUB } from '../../actions-hosted-migration/independent-ci-v1/src/published-on-github-v2.mjs';
import { BASE, CLEAN_PROOF, HEAD, SOURCE, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, triggerBytes } from './helpers.mjs';

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const outcome = (reason, o = {}) => ({ status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: null, safeToRerun: false, ...o });
const failed = (code, reason = code, o = {}) => ({ ok: false, code, proof: WINDOWS_CLEAN, outcome: outcome(reason, o), brokerNoLaunch: false });

test('both codes are clean and final: burned, a new commit runs the PR again, the breaker does not count them', () => {
  assert.ok(CLEAN_FINAL_CODES.includes(HEAD_PUBLISHED_ON_GITHUB) && CLEAN_FINAL_CODES.includes(ROLE_ALREADY_ON_GITHUB));
  const expect = { class: 'clean-final', disposition: 'burn', retry: 'new-commit', breaker: 'neutral' };
  const pick = r => r && { class: r.class, disposition: r.disposition, retry: r.retry, breaker: r.breaker };
  assert.deepEqual(pick(failureRow({ code: HEAD_PUBLISHED_ON_GITHUB, stage: 1, reason: HEAD_PUBLISHED_ON_GITHUB })), expect);
  for (const stage of [3, 5, 7, 8, 9]) assert.deepEqual(pick(failureRow({ code: ROLE_ALREADY_ON_GITHUB, stage, reason: 'role_already_on_github' })), expect, `stage ${stage}`);
  // Never released at stage 1, even if an outcome claimed it safe to re-run: the head already carries checks.
  for (const safeToRerun of [false, true]) {
    const d = decideFailure({ code: HEAD_PUBLISHED_ON_GITHUB, stage: 1, outcome: outcome(HEAD_PUBLISHED_ON_GITHUB, { safeToRerun }), proof: CLEAN_PROOF, started: false });
    assert.deepEqual([d.klass, d.release], ['CLEAN', null]);
  }
});

test('stage 1 HEAD_PUBLISHED_ON_GITHUB: burned, recorded as executed, no attempt 2, the same head never runs again', async t => {
  const engine = fakeEngine({ stages: { 1: failed(HEAD_PUBLISHED_ON_GITHUB) } });
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', HEAD_PUBLISHED_ON_GITHUB, undefined]);
  assert.deepEqual(stagesRun(engine), [1]);
  assert.equal(await f.ledger.headBurned(headKey(subject())), true);
  assert.equal(await f.ledger.halted(), null);
  // The executed-heads record (Source and attempt independent) says why.
  assert.equal(await f.executedHeads.published(subject()), true);
  const dir = path.join(f.root, 'state', 'executed-heads', executedHeadKey(subject()));
  const names = await fs.readdir(dir);
  assert.deepEqual(names, [`publication-${r.key.slice(0, 16)}.json`]);
  const record = JSON.parse(await fs.readFile(path.join(dir, names[0]), 'utf8'));
  assert.deepEqual([record.origin, record.basis, record.stage, record.key], ['publication', 'head-published-on-github', 1, r.key]);
  // Nothing more runs for this head: no attempt 2, and a new trigger of it is ignored.
  await f.exec.tick();
  await f.drop(triggerBytes({ pr: 990 }));
  const again = await f.exec.tick();
  assert.equal(again.reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
  assert.deepEqual(stagesRun(engine), [1]);
  // A record that cannot be written ends the batch as EXECUTED_HEAD_RECORD_UNCONFIRMED (burned, clean), never silently.
  const g = await executorFixture(t, { engine: fakeEngine({ stages: { 1: failed(HEAD_PUBLISHED_ON_GITHUB) } }) });
  g.executedHeads.record = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  await g.drop(triggerBytes());
  const r2 = await g.exec.tick();
  assert.deepEqual([r2.state, r2.failureCode], ['FAILED_CLEAN', 'EXECUTED_HEAD_RECORD_UNCONFIRMED']);
  assert.equal(await g.ledger.headBurned(headKey(subject())), true);
});

test('stages 3, 5, 7 and 8 ROLE_ALREADY_ON_GITHUB: clean final, no HALT, no parking, nothing after it', async t => {
  for (const [stage, ran] of [[3, [1, 2, 3]], [5, [1, 2, 3, 4, 5]], [7, [1, 2, 3, 4, 5, 6, 7]], [8, [1, 2, 3, 4, 5, 6, 7, 8]]]) {
    const engine = fakeEngine({ stages: { [stage]: failed(ROLE_ALREADY_ON_GITHUB, stage === 8 ? ROLE_ALREADY_ON_GITHUB : 'role_already_on_github') } });
    const f = await executorFixture(t, { engine });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', ROLE_ALREADY_ON_GITHUB], `stage ${stage}`);
    assert.deepEqual(stagesRun(engine), ran);
    assert.equal(await f.ledger.halted(), null);
  }
});

test('the PR page asks for a new commit for a head already carrying checks', () => {
  const now = Date.parse('2026-10-23T09:00:00Z');
  const H7 = '7'.repeat(40);
  const board = fn => { const b = new StatusBoard({ clock: () => now }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); fn(b); return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
  for (const code of [HEAD_PUBLISHED_ON_GITHUB, ROLE_ALREADY_ON_GITHUB]) {
    const d = describe({ pull: { pr: 7, headSha: H7, eligible: true, hint: null, behindBy: 0 }, status: board(b => b.outcome({ pr: 7, headSha: H7, outcome: 'FAILED_CLEAN', code, retry: 'new-commit' })), now });
    assert.deepEqual(d, { state: 'failure', description: '这个提交已有检查，请推新提交' }, code);
  }
});
