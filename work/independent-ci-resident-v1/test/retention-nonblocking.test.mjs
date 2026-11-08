// Defect 8f8240ff (TURING, 2026-11-08): the service loop awaited archive retention between batches. Its archive-prune request
// waited the full 10 minutes for a wsl.exe that never returned (the companion's 9-minute limit ended it, tree 'unconfirmed'),
// then archive-usage 3 more, and the upgrader's pause request in requests\ went unanswered past its 10 minutes
// (UPGRADE_PAUSE_UNCONFIRMED, op DEFERRED for an hour). The step now runs beside the loop: ticks (pause, stop, Owner requests)
// go on, no new batch opens while it runs, and a stop stops its companion waits.
// Temporary directories only; the companion is a real mailbox that nobody answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RetentionWatch, PRUNE_RECEIPT } from '../src/retention.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { serviceLoop } from '../src/service-main.mjs';
import * as executor from '../src/executor.mjs';
import { ReceiptChain } from '../src/receipts.mjs';
import { executorFixture, tempRoot, triggerBytes, waitFor, withTimeout } from './helpers.mjs';

const { PAUSE_CONTRACT, BETWEEN_BATCHES_RUNNING } = executor;
const T0 = Date.parse('2026-11-08T08:17:46Z');
const json = v => Buffer.from(JSON.stringify(v));
const realSleep = ms => new Promise(r => setTimeout(r, ms));
// The 30-second budget of the defect, in test time: the hung companion wait is 10 minutes of the mailbox clock.
const PROMPT_MS = 5_000;

// A mailbox whose clock is real until `unwind()`: from then on every read of it is an hour later, so a wait that is still polling
// (the unfixed loop) reaches its deadline at its next poll and the test ends instead of hanging for 10 minutes.
async function silentMailbox(root) {
  let skew = 0, unwinding = false;
  const mailbox = await Mailbox.open(path.join(root, 'mailbox'), () => Date.now() + (unwinding ? (skew += 3_600_000) : skew));
  return { mailbox, unwind: () => { unwinding = true; }, requests: async kind => {
    const out = [];
    for (const n of await fs.readdir(path.join(root, 'mailbox', 'requests'))) {
      try { const v = JSON.parse(await fs.readFile(path.join(root, 'mailbox', 'requests', n), 'utf8')); if (v.kind === kind) out.push(v); } catch { /* not finished */ }
    }
    return out;
  } };
}

test('defect 8f8240ff: a Linux archive-prune that never answers no longer holds the loop; the upgrader pause is latched at once and a stop ends the wait', async t => {
  const f = await executorFixture(t, { now: T0 });
  const box = await silentMailbox(f.root);
  const leaving = new AbortController();
  const companion = mailboxCompanion(box.mailbox, ms => realSleep(Math.min(ms, 20)), { abandon: leaving.signal });
  const watch = new RetentionWatch({ policy: f.ports.policy, receipts: f.receipts, clock: f.clock,
    measureWindows: async () => ({ bytes: 1, directories: 1, complete: true }), measureLinux: () => companion.archiveUsage(),
    companionReady: async () => true, idle: async () => ({ ok: true }), pruneLinux: () => companion.archivePrune() });
  let stop = false, loopError = null;
  const loop = serviceLoop({ exec: f.exec, lock: { touch: async () => {} }, sleep: () => realSleep(10), stopRequested: async () => stop,
    acknowledgeStop: async () => {}, onLoopException: async error => { loopError = error; }, betweenBatches: () => watch.maybeCheck(),
    abandonBetweenBatches: () => leaving.abort() });
  try {
    // The retention pass is waiting for the companion's answer to archive-prune (10 minutes of mailbox time).
    const [prune] = await waitFor(() => box.requests('archive-prune').then(r => (r.length > 0 ? r : null)), 'the archive-prune request');
    assert.equal(Date.parse(prune.deadline) - Date.parse(prune.createdAt), 10 * 60_000);
    // The upgrader's pause request (upgrader/src/resident-ports.mjs pauseRequestBytes: { contract, reason } in requests\).
    await f.drop(json({ contract: PAUSE_CONTRACT, reason: 'resident-upgrade 0123456789abcdef 1' }), 'requests');
    const began = Date.now();
    await waitFor(() => f.ledger.paused(), 'the pause latched while archive-prune still waits', PROMPT_MS);
    assert.ok(Date.now() - began < PROMPT_MS);
    assert.equal((await box.requests('archive-prune')).length, 1, 'the same prune is still unanswered: nothing was retried');
    // A stop (the upgrader's StopServices) gives up the companion wait at once instead of after its deadline.
    stop = true;
    const stopped = Date.now();
    assert.equal(await withTimeout(loop, 'the service loop to stop', PROMPT_MS), 0);
    assert.ok(Date.now() - stopped < PROMPT_MS);
    assert.equal(loopError, null);
    const receipts = await f.receipts.latest([PRUNE_RECEIPT], 4);
    assert.deepEqual(receipts.map(r => [r.value.body.spool, r.value.body.refused, r.value.body.deletesAnything]), [['linux', 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED', false]]);
  } finally {
    stop = true; box.unwind(); leaving.abort();
    await withTimeout(loop, 'the service loop to unwind', 30_000).catch(() => {});
  }
});

test('defect 8f8240ff: while the between-batches step runs beside the loop no new batch opens; the queued trigger runs once it is done', async t => {
  const f = await executorFixture(t, { now: T0 });
  let release, started = false;
  const gate = new Promise(r => { release = r; });
  const results = [];
  let stop = false;
  const exec = { tick: async o => { const r = await f.exec.tick(o); results.push(r); return r; } };
  const loop = serviceLoop({ exec, lock: { touch: async () => {} }, sleep: () => realSleep(10), stopRequested: async () => stop,
    acknowledgeStop: async () => {}, onLoopException: async () => {}, betweenBatches: async () => { if (!started) { started = true; await gate; } } });
  try {
    await waitFor(() => started, 'the between-batches step to start');
    await f.drop(triggerBytes());
    await waitFor(() => results.some(r => r.state === 'DEFERRED' && r.reason === BETWEEN_BATCHES_RUNNING), 'a tick deferred by the running step', PROMPT_MS);
    assert.equal(f.engine.calls.length, 0, 'no stage, no bundle while the step runs');
    assert.equal(f.queue.row(884).state, 'QUEUED', 'the trigger is read, not lost');
    release();
    await waitFor(() => results.some(r => r.state === 'COMPLETED'), 'the batch after the step', PROMPT_MS);
  } finally {
    release(); stop = true;
    await withTimeout(loop, 'the service loop to stop', 30_000).catch(() => {});
  }
});

test('defect 8f8240ff: receipts appended at the same time from the loop and the step keep one unbroken chain', async t => {
  const root = await tempRoot(t);
  const dir = path.join(root, 'receipts');
  const chain = await ReceiptChain.open(dir, () => T0);
  const done = await Promise.all(Array.from({ length: 24 }, (_, i) => chain.append(i % 2 ? 'archive-retention-prune' : 'paused', { i })));
  assert.deepEqual(done.map(d => d.seq).sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal((await fs.readdir(dir)).filter(n => n.endsWith('.json')).length, 24);
  await ReceiptChain.open(dir, () => T0); // verifies the chain: numbering and links
});

test('defect 8f8240ff: the abandon signal ends only the retention waits (archive-prune, archive-usage), as no answer', async t => {
  const root = await tempRoot(t);
  const box = await silentMailbox(root);
  const leaving = new AbortController();
  const companion = mailboxCompanion(box.mailbox, ms => realSleep(Math.min(ms, 20)), { abandon: leaving.signal });
  const prune = companion.archivePrune(), usage = companion.archiveUsage();
  let bundleDone = false;
  const bundle = companion.buildBundle({ batchId: '0123456789abcdef-0123456789ab' }).then(r => { bundleDone = true; return r; });
  try {
    await waitFor(() => box.requests('build-bundle').then(r => r.length > 0), 'the requests');
    leaving.abort();
    assert.deepEqual(await withTimeout(prune, 'archive-prune to give up', PROMPT_MS), { ok: false, code: 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED' });
    assert.deepEqual(await withTimeout(usage, 'archive-usage to give up', PROMPT_MS), { ok: false });
    await realSleep(100);
    assert.equal(bundleDone, false, 'a batch request still waits for its own deadline');
    box.unwind();
    assert.equal((await withTimeout(bundle, 'build-bundle to reach its deadline', 30_000)).code, 'BUNDLE_UNAVAILABLE');
  } finally {
    box.unwind();
    await Promise.allSettled([prune, usage, bundle]);
  }
});

test('defect 8f8240ff: service-main gives the companion the stop signal and the loop the way to raise it', async () => {
  const text = await fs.readFile(new URL('../src/service-main.mjs', import.meta.url), 'utf8');
  for (const s of ['mailboxCompanion(mailbox, sleep, { abandon: leaving.signal })', 'abandonBetweenBatches: () => leaving.abort()',
    'betweenBatches: () => retention.maybeCheck()', 'exec.tick({ betweenBatchesRunning: between !== null })']) {
    assert.ok(text.includes(s), s);
  }
});
