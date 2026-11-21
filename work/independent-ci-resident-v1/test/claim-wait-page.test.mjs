// Task 30643342 (FABLE-botmerge-auth-carry-20261122 §1.6, §2 step 4, §3 T4): the PR page told every waiting row "编辑 PR 可提前",
// while the queue never lets an ordinary edit hurry a claim wait (only a protected observation of a new authorization does). Two
// places wrote one rule and drifted. The queue now says how a waiting row can be woken early (queue.mjs#earlyWakeOf), and both its
// candidates() and the PR page read that. These tests run the real queue, status board (written and parsed back) and PR page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Q from '../src/queue.mjs';
import { describe as prPage } from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-21T18:41:00Z');
const BASE = 'b'.repeat(40);
const head = pr => pr.toString(16).padStart(8, '0').padEnd(40, 'a');
const KEY = 'c'.repeat(64);
const EDIT_HELPS = '编辑 PR 可提前';
const EDIT_DOES_NOT = '编辑 PR 不会提前';

// Every kind of waiting row: released at T0 + 5 minutes after an evaluation that began at T0, so its next try (T0 + 15) comes after
// the cool-down of an edit (T0 + 10).
const KINDS = [
  { pr: 1220, name: 'claim wait (head not authorized)', outcome: { kind: 'released', code: 'CLAIM_NOT_CURRENT', klass: 'waiting', reasonCodes: ['pr_task_binding_head_not_authorized'] } },
  { pr: 1221, name: 'claim wait (no reason code)', outcome: { kind: 'released', code: 'CLAIM_NOT_CURRENT', klass: 'waiting', outcomeReason: 'claim_not_found' } },
  { pr: 1222, name: 'claim wait, legacy BACKOFF shape', outcome: { kind: 'released', code: 'CLAIM_NOT_CURRENT', klass: 'waiting' }, state: 'BACKOFF' },
  { pr: 1223, name: 'Owner review wait', outcome: { kind: 'released', code: 'OWNER_REVIEW_REQUIRED', klass: 'waiting' } },
  { pr: 1224, name: 'release back-off', outcome: { kind: 'released', code: 'STAGE_TIMEOUT', klass: 'environment', releases24h: 1, releaseCap: 2 } },
  { pr: 1225, name: 'network back-off', outcome: { kind: 'released', code: 'GITHUB_TRANSIENT_UNAVAILABLE', klass: 'environment', network: true, networkReleases24h: 1, networkCap: 6 } },
];
const CLAIM_PRS = [1220, 1221, 1222];

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-wait-page-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = T0;
  const clock = () => now;
  const q = await Q.RunQueue.open(dir, clock);
  for (const k of KINDS) {
    q.offer({ pr: k.pr, headSha: head(k.pr), baseSha: BASE, prUpdatedAt: new Date(T0 - MIN).toISOString() }, T0, { depth: 100, cooldownMs: 10 * MIN });
    q.begin(k.pr, head(k.pr), KEY, 'queued', T0);
    q.settle(k.pr, head(k.pr), k.outcome, T0 + 5 * MIN);
    if (k.state) q.row(k.pr).state = k.state;
  }
  const board = new StatusBoard({ clock });
  board.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
  const page = (pr, at) => {
    now = at;
    board.setPending(q.view(at, { etaBatchMs: 20 * MIN }));
    const status = parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
    return prPage({ pull: { pr, headSha: head(pr), eligible: true }, status, now: at }).description;
  };
  return { q, page };
}

test('T4a: a claim wait says an authorization wakes it, and never that an edit does', async t => {
  const { q, page } = await fixture(t);
  for (const pr of CLAIM_PRS) {
    const d = page(pr, T0 + 6 * MIN);
    assert.ok(d.includes('认领持有人授权此提交后，约 10 分钟内自动重试（编辑 PR 不会提前）'), d);
    assert.match(d, /授权此提交后/, d); // design T4a: "含‘授权后’"; the design's own text says 授权此提交后
    assert.ok(!d.includes(EDIT_HELPS), d);
    assert.ok(d.length <= 140, d);
    assert.match(d, /CLAIM_NOT_CURRENT/, 'the code stays');
  }
  assert.ok(page(1220, T0 + 6 * MIN).includes('当前提交未授权'), 'the reason stays');
  // The other waits keep their text.
  assert.ok(page(1223, T0 + 6 * MIN).includes(`批准或修正后${EDIT_HELPS}`));
  assert.ok(page(1224, T0 + 6 * MIN).includes(`修正后${EDIT_HELPS}`));
  assert.equal(typeof Q.earlyWakeOf, 'function', 'queue.mjs exports earlyWakeOf');
  for (const pr of CLAIM_PRS) assert.equal(Q.earlyWakeOf(q.row(pr)), 'authorization');
  for (const pr of [1223, 1224, 1225]) assert.equal(Q.earlyWakeOf(q.row(pr)), 'edit');
});

test('T4b: what the PR page says an edit does is what the queue does with an edit', async t => {
  const { q, page } = await fixture(t);
  const texts = new Map(KINDS.map(k => [k.pr, page(k.pr, T0 + 6 * MIN)]));
  // An edit of every PR (a newer update time: the poller's new trigger) at T0 + 6.
  for (const k of KINDS) {
    const r = q.offer({ pr: k.pr, headSha: head(k.pr), baseSha: BASE, prUpdatedAt: new Date(T0 + 6 * MIN).toISOString() }, T0 + 6 * MIN, { depth: 100, cooldownMs: 10 * MIN });
    assert.equal(r.action, 'new-trigger', k.name);
  }
  const at = T0 + 10 * MIN; // the edit's cool-down is over; every row's own next try (T0 + 15) is still ahead
  for (const k of KINDS) assert.ok(q.row(k.pr).nextAt > at, k.name);
  const listed = new Set(q.candidates(at).map(c => c.pr));
  for (const k of KINDS) {
    const d = texts.get(k.pr);
    // Says an edit hurries it: the edit must make it a candidate before its next try. Says it does not: the edit must not.
    if (d.includes(EDIT_HELPS)) assert.ok(listed.has(k.pr), `${k.name}: the page says "${EDIT_HELPS}" but the edit does not hurry it: ${d}`);
    if (!listed.has(k.pr)) assert.ok(d.includes(EDIT_DOES_NOT), `${k.name}: the edit does not hurry it but the page does not say so: ${d}`);
    if (d.includes(EDIT_DOES_NOT)) assert.ok(!listed.has(k.pr), `${k.name}: the page says "${EDIT_DOES_NOT}" but the edit hurried it`);
    // Both read the queue's one rule.
    const wake = Q.earlyWakeOf?.(q.row(k.pr));
    assert.equal(wake === 'authorization', CLAIM_PRS.includes(k.pr), k.name);
    assert.equal(listed.has(k.pr), wake === 'edit', k.name);
  }
});
