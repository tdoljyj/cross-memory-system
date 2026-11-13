// Defect 8f8240ff (NODE-B, 2026-11-08): the service loop awaited archive retention between batches. Its archive-prune request
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
import { StatusBoard, StatusFile } from '../src/status.mjs';
import { sha256 } from '../src/canonical.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, validateCompanionConfig } from '../src/companion.mjs';
import { TRIGGER_CONTRACT_V2 } from '../src/trigger.mjs';
// Read-only use of the frozen upgrader's own resident port: how it decides that the pause took effect.
import { ResidentPort, pauseRequestBytes } from '../upgrader/src/resident-ports.mjs';
import { BASE, SAFE_REFUSAL, TEST_NODE, TEST_NODE_SHA, executorFixture, fakeCompanion, fakeEngine, notAdmitted, tempRoot, triggerBytes, waitFor, withTimeout } from './helpers.mjs';

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
  const board = new StatusBoard({ clock: () => T0 });
  const f = await executorFixture(t, { now: T0, status: board });
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
    // The upgrader's pause request, its exact bytes (upgrader/src/resident-ports.mjs pauseRequestBytes) in requests\.
    const pause = pauseRequestBytes('0123456789abcdef0123456789abcdef', 1);
    assert.equal(JSON.parse(pause).contract, PAUSE_CONTRACT);
    await f.drop(pause, 'requests');
    const began = Date.now();
    await waitFor(() => f.ledger.paused(), 'the pause latched while archive-prune still waits', PROMPT_MS);
    assert.ok(Date.now() - began < PROMPT_MS);
    // What the upgrader requires before it calls the pause confirmed (machine.mjs pause step): PAUSED by its request, no open batch,
    // no current batch on the status board, no open stage-10 run.
    await waitFor(() => board.snapshot().executor?.state === 'PAUSED', 'the status board to say PAUSED', PROMPT_MS);
    await new StatusFile(path.join(f.root, 'state', 'status.json')).write(board.snapshot());
    const upgrader = new ResidentPort(f.root);
    assert.equal((await upgrader.pauseState())?.requestSha256, sha256(pause));
    assert.equal(await upgrader.openBatches(), 0);
    assert.equal((await upgrader.status())?.current, false);
    assert.equal(await upgrader.trainOpen(), false);
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
  for (const s of ['mailboxCompanion(mailbox, sleep, { abandon: leaving.signal })', 'abandonBetweenBatches: () => { leaving.abort(); retention.measureWindows = async () => ({ bytes: 0, directories: 0, complete: false }); }',
    'betweenBatches: () => retention.maybeCheck()', 'exec.tick({ betweenBatchesRunning: between !== null })']) {
    assert.ok(text.includes(s), s);
  }
});

// ---- independent review (PASS-WITH-FIXES) ----

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\protected-job-bridge-v4\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });

// A real companion with its one serial mailbox lane (companion.mjs step): archive-prune's wsl.exe hangs until stop().
function serialCompanion(box) {
  let release, done = false;
  const hung = new Promise(r => { release = r; });
  const started = [];
  const c = new Companion({ cfg, mailbox: box.mailbox, fileExists: async () => true, sleep: realSleep, clock: () => Date.now(),
    run: async argv => { started.push(argv.at(-1)); if (argv.includes('archive-prune')) await hung; return { code: 1, stdout: '' }; } });
  const lane = (async () => { while (!done) { try { await c.step(); } catch { /* the next pass */ } await realSleep(5); } })();
  return { started, stop: async () => { done = true; release(); await lane; } };
}

test('review MAJOR 1: a claim re-check is not asked while the step runs: its pr-head would queue behind the hung prune in the companion lane', async t => {
  const PR = 1039, HEAD = '2e95bda4'.padEnd(40, '0');
  const OLD = '11111111-1111-4111-8111-111111111111', NEW = '22222222-2222-4222-8222-222222222222';
  const refusal = { ...SAFE_REFUSAL, diagnostic: { ...SAFE_REFUSAL.diagnostic, reasonCodes: ['claim_not_current', 'fence_superseded'] } };
  const trigger = at => Buffer.from(JSON.stringify({ contract: TRIGGER_CONTRACT_V2, repo: 'tdoljyj/cross-memory-system', pr: PR, headSha: HEAD, baseSha: BASE, prUpdatedAt: new Date(at).toISOString() }));
  const engine = fakeEngine();
  const run = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 1 ? (engine.calls.push(['stage', 1]), notAdmitted('CLAIM_NOT_CURRENT', refusal)) : run(batch, stage, o));
  const claims = [OLD];
  let clock = () => 0;
  const f = await executorFixture(t, { engine, now: Date.parse('2026-11-08T03:05:00Z'),
    companion: fakeCompanion({ pull: pr => ({ number: pr, state: 'open', headSha: HEAD, claims: [...claims] }) }, () => clock()) });
  clock = f.clock;
  // 03:05 stage 1 refuses the claim: the row backs off (claim-change-backoff.test.mjs).
  await f.drop(trigger(f.clock() - 60_000));
  assert.equal((await f.exec.tick()).failureCode, 'CLAIM_NOT_CURRENT');
  // From now on pr-head goes through the mailbox to a real companion whose one lane is busy with the hung archive-prune.
  const box = await silentMailbox(f.root);
  const leaving = new AbortController();
  const port = mailboxCompanion(box.mailbox, ms => realSleep(Math.min(ms, 20)), { abandon: leaving.signal });
  f.companion.prHead = (pr, batch) => port.prHead(pr, batch);
  const companion = serialCompanion(box);
  const watch = new RetentionWatch({ policy: f.ports.policy, receipts: f.receipts, clock: f.clock,
    measureWindows: async () => ({ bytes: 1, directories: 1, complete: true }), measureLinux: () => port.archiveUsage(),
    companionReady: async () => true, idle: async () => ({ ok: true }), pruneLinux: () => port.archivePrune() });
  const results = [];
  let stop = false;
  const exec = { tick: async o => { const r = await f.exec.tick(o); results.push(r); return r; } };
  const loop = serviceLoop({ exec, lock: { touch: async () => {} }, sleep: () => realSleep(10), stopRequested: async () => stop,
    acknowledgeStop: async () => {}, onLoopException: async () => {}, betweenBatches: () => watch.maybeCheck(), abandonBetweenBatches: () => leaving.abort() });
  try {
    await waitFor(() => companion.started.includes('archive-prune'), 'the companion lane to run the hung archive-prune');
    // 03:06 the author puts another claim in the PR body: a new trigger of the backed-off row, whose poke asks for a claim re-check.
    f.advance(60_000);
    claims[0] = NEW;
    await f.drop(trigger(f.clock()));
    // A tick already under way when the trigger landed may end without having read it (CI run 42488811412, Linux): wait for the
    // trigger to be taken first, then for a tick that ended after that.
    await waitFor(() => f.queue.row(PR).poke?.claimCheck === true, 'the trigger taken: its poke asks for a claim re-check', PROMPT_MS);
    const from = results.length;
    await waitFor(() => results.slice(from).some(r => r.state === 'DEFERRED' && r.reason === BETWEEN_BATCHES_RUNNING), 'a prompt tick held by the running step', PROMPT_MS);
    assert.deepEqual(await box.requests('pr-head'), [], 'no pr-head was queued behind the hung prune');
    assert.equal(f.queue.row(PR).poke.claimCheck, true, 'the claim re-check waits for the step, it is not lost');
  } finally {
    stop = true; box.unwind(); leaving.abort();
    await companion.stop();
    await withTimeout(loop, 'the service loop to stop', 30_000).catch(() => {});
  }
});

test('review MAJOR 2: while the step runs no maintenance that starts a child runs (revocation, role probe, queue watch, stage 10); pause still latches', async t => {
  const f = await executorFixture(t, { now: T0 });
  const ran = [];
  for (const m of ['revocationMaintenance', 'roleProbeMaintenance', 'queueWatchMaintenance', 'trainMaintenance']) f.exec[m] = async () => { ran.push(m); return null; };
  await f.exec.tick();
  for (const m of ['revocationMaintenance', 'roleProbeMaintenance', 'queueWatchMaintenance', 'trainMaintenance']) assert.ok(ran.includes(m), `a quiet tick runs ${m}: ${ran}`);
  ran.length = 0;
  assert.equal((await f.exec.tick({ betweenBatchesRunning: true })).reason, BETWEEN_BATCHES_RUNNING);
  assert.deepEqual(ran, [], 'none of them while the step runs');
  await f.drop(json({ contract: PAUSE_CONTRACT, reason: 'resident-upgrade 0123456789abcdef 1' }), 'requests');
  assert.equal((await f.exec.tick({ betweenBatchesRunning: true })).state, 'PAUSED');
  assert.ok(await f.ledger.paused());
  assert.deepEqual(ran, [], 'not under the pause either while the step runs');
  await f.exec.tick();
  assert.ok(ran.includes('roleProbeMaintenance'), 'under the pause the role probe runs again once the step is done');
});

test('review MINOR 3: a retention request the stopping service gave up is cancelled, and the companion does not start it', async t => {
  const root = await tempRoot(t);
  const box = await silentMailbox(root);
  const leaving = new AbortController();
  const port = mailboxCompanion(box.mailbox, ms => realSleep(Math.min(ms, 20)), { abandon: leaving.signal });
  const pending = port.archivePrune();
  try {
    const [request] = await waitFor(() => box.requests('archive-prune').then(r => (r.length > 0 ? r : null)), 'the archive-prune request');
    leaving.abort();
    assert.equal((await withTimeout(pending, 'archive-prune to give up', PROMPT_MS)).code, 'LINUX_ARCHIVE_PRUNE_UNCONFIRMED');
    assert.equal(await box.mailbox.cancelled(request), true, 'cancelled with service-stopping');
    const runs = [];
    await new Companion({ cfg, mailbox: box.mailbox, run: async a => { runs.push(a); return { code: 0, stdout: '' }; }, fileExists: async () => true, sleep: async () => {}, clock: () => Date.now() }).step();
    assert.deepEqual(runs, [], 'never started');
    assert.equal((await box.mailbox.poll(request)).code, 'COMPANION_REQUEST_CANCELLED');
  } finally {
    box.unwind();
    await Promise.allSettled([pending]);
  }
});

test('review MINOR 5: a stop waits for the step at most leaveMaxMs', async () => {
  let acked = false, abandoned = false, stop = false;
  const never = new Promise(() => {});
  const loop = serviceLoop({ exec: { tick: async () => ({ state: 'IDLE' }) }, lock: { touch: async () => {} }, sleep: () => realSleep(5), stopRequested: async () => stop,
    acknowledgeStop: async () => { acked = true; }, onLoopException: async () => {}, betweenBatches: () => never, abandonBetweenBatches: () => { abandoned = true; }, leaveMaxMs: 200 });
  await realSleep(30);
  stop = true;
  const began = Date.now();
  assert.equal(await withTimeout(loop, 'the stop', PROMPT_MS), 0);
  assert.ok(Date.now() - began >= 150 && Date.now() - began < PROMPT_MS);
  assert.deepEqual([acked, abandoned], [true, true]);
});
