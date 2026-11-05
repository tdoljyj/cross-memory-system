// Parking point A's second bundle (Task 4012c1b9, DESIGN §37): a batch resumed from the hosted wait gets one more bundle right
// before its workspace; refs that moved on end it as the clean transient REMOTE_REFS_CHANGED_SINCE_BUNDLE, anything else as
// before (PARKED_BUNDLE_TOO_OLD). A batch that never waited is not touched. The status page shows every batch resting at A.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailbox } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, argv, validateCompanionConfig } from '../src/companion.mjs';
import { PARKED_A_REASON } from '../src/executor.mjs';
import { StatusBoard } from '../src/status.mjs';
import { HEAD, RELAY_ON, TEST_NODE, TEST_NODE_SHA, executorFixture, fakeCompanion, fakeEngine, hintFor, relayedRow, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
const relayedEngine = () => fakeEngine({ relay: roles => ({ ok: true, factsSha256: 'd'.repeat(64), relay: roles.map(role => relayedRow(role)) }) });
const hostedSuccess = f => {
  f.companion.hostedHint = async s => Buffer.from(JSON.stringify(hintFor({ gitleaks: { state: 'SUCCESS' }, trivy: { state: 'SUCCESS' } },
    { pr: s.pr, head: s.headSha, at: f.clock() })));
};
// A companion with the second-bundle port: answer(n) is the answer to the n-th call (0-based).
const withRebundle = (answer, script = { hint: () => null }) => {
  const c = fakeCompanion(script);
  c.rebuilds = 0;
  c.rebuildBundle = async () => { c.calls.push(['rebundle']); return answer(c.rebuilds++); };
  return c;
};

test('resumed from parking point A after the wait: one second bundle, then the workspace and every stage', async t => {
  const companion = withRebundle(() => ({ ok: true, code: null }));
  const f = await executorFixture(t, { engine: relayedEngine(), policy: rawPolicy({ relay: RELAY_ON }), companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(61 * MIN);
  hostedSuccess(f);
  const r = await f.exec.tick();
  assert.equal(r.state, 'COMPLETED');
  const order = companion.calls.map(c => c[0]).filter(x => ['bundle', 'rebundle', 'wsprep'].includes(x));
  assert.deepEqual(order, ['bundle', 'rebundle', 'wsprep']);
  assert.ok((await receiptTypes(f)).includes('batch-rebundled'));
  assert.deepEqual([r.relayed, r.local], [['gitleaks', 'trivy'], ['contract-placement']]);
  assert.deepEqual(stagesRun(f.engine), [1, 9, 6, 7, 8], 'only placement runs locally');
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  await f.drop(triggerBytes({ pr: 990 }));
  assert.equal((await f.exec.tick()).reason, 'HEAD_ALREADY_EXECUTED_NO_RETRY');
  assert.equal(f.engine.calls.filter(c => c[0] === 'derive').length, 1, 'the same H never starts another batch');
});

test('even past the old 100-minute bound, a renewed bundle lets the batch go on', async t => {
  const companion = withRebundle(() => ({ ok: true, code: null }));
  const f = await executorFixture(t, { engine: relayedEngine(), policy: rawPolicy({ relay: RELAY_ON }), companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(101 * MIN);
  hostedSuccess(f);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(companion.rebuilds, 1);
  assert.deepEqual(stagesRun(f.engine), [1, 9, 6, 7, 8]);
  assert.deepEqual(await f.ledger.pendingAttempts2(), []);
});

test('refs moved on since the first bundle: a clean transient ending before the workspace, nothing on Linux', async t => {
  const companion = withRebundle(() => ({ ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' }));
  const f = await executorFixture(t, { engine: relayedEngine(), policy: rawPolicy({ relay: RELAY_ON }), companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'WAITING');
  f.advance(61 * MIN);
  hostedSuccess(f);
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE']);
  assert.deepEqual(stagesRun(f.engine), [1, 9], 'hosted receipts are confirmed; no workspace preparation or Linux stage');
  assert.ok(!companion.calls.some(c => c[0] === 'wsprep'));
  assert.deepEqual(await f.ledger.pendingAttempts2(), [], 'confirmed hosted scans cannot be retried locally');
});

test('any other refusal (or no answer) of the second bundle ends the batch as before, PARKED_BUNDLE_TOO_OLD', async t => {
  for (const answer of [{ ok: false, code: 'BUNDLE_UNAVAILABLE' }, null, { ok: false, code: 'SOMETHING_ELSE' }]) {
    const companion = withRebundle(() => answer);
    const f = await executorFixture(t, { engine: relayedEngine(), policy: rawPolicy({ relay: RELAY_ON }), companion });
    await f.drop(triggerBytes());
    assert.equal((await f.exec.tick()).state, 'WAITING');
    f.advance(61 * MIN);
    hostedSuccess(f);
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_BUNDLE_TOO_OLD'], JSON.stringify(answer));
    assert.deepEqual(stagesRun(f.engine), [1, 9]);
    assert.ok(!companion.calls.some(c => c[0] === 'wsprep'));
    assert.deepEqual(await f.ledger.pendingAttempts2(), []);
  }
});

test('a batch that never waited (relay off) is not re-bundled', async t => {
  const companion = withRebundle(() => ({ ok: true, code: null }), {});
  const f = await executorFixture(t, { companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(companion.rebuilds, 0);
});

test('a slow first pass that never parked (relay off, bundle and stage 1 took 31 minutes) is not re-bundled (review M1)', async t => {
  const companion = withRebundle(() => ({ ok: false, code: 'BUNDLE_UNAVAILABLE' }), {});
  let f;
  const slow = companion.buildBundle;
  companion.buildBundle = async (...a) => { f.advance(31 * MIN); return slow(...a); };
  f = await executorFixture(t, { companion });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.equal(companion.rebuilds, 0);
});

test('without the re-bundle port the old 100-minute rule still holds for a first pass', async t => {
  const companion = fakeCompanion({});
  let f;
  const slow = companion.buildBundle;
  companion.buildBundle = async (...a) => { f.advance(101 * MIN); return slow(...a); };
  f = await executorFixture(t, { companion });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', 'PARKED_BUNDLE_TOO_OLD']);
});

test('the status page shows each batch resting at parking point A on its own row', async t => {
  const status = new StatusBoard({ clock: () => Date.parse('2026-10-20T12:00:00Z') });
  const f = await executorFixture(t, { policy: rawPolicy({ relay: RELAY_ON }), companion: withRebundle(() => ({ ok: true, code: null })), status });
  await f.drop(triggerBytes({ pr: 884, headSha: HEAD }));
  assert.equal((await f.exec.tick()).state, 'WAITING');
  await f.drop(triggerBytes({ pr: 885, headSha: '5'.repeat(40) }));
  f.advance(MIN);
  await f.exec.tick();
  f.advance(MIN);
  await f.exec.tick();
  const parked = status.snapshot().pending.filter(p => p.deferred === PARKED_A_REASON).map(p => p.pr).sort();
  assert.deepEqual(parked, [884, 885]);
});

test('companion: rebuild-bundle runs the fixed -Rebundle command and maps the script verdict', async t => {
  const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
    powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\protected-job-bridge-v4\\relay-public.ps1',
    bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
    distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
  const BATCH = '0123456789abcdef-0123456789ab';
  assert.deepEqual(argv(cfg).rebundle(BATCH).slice(-5), ['-File', cfg.bundleScript, '-BatchId', BATCH, '-Rebundle']);
  assert.throws(() => argv(cfg).rebundle('x'), { code: 'COMPANION_BUNDLE_ARGS_INVALID' });
  const cases = [
    [{ code: 0, stdout: JSON.stringify({ status: 'BUNDLE_WRITTEN', generation: 2 }) }, true, null],
    [{ code: 0, stdout: JSON.stringify({ status: 'BUNDLE_WRITTEN', generation: 1 }) }, false, 'BUNDLE_UNAVAILABLE'],
    [{ code: 2, stdout: JSON.stringify({ status: 'PARTIAL_STATE_PRESERVED_NO_RETRY', reason: 'REMOTE_HEAD_MOVED' }) }, false, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'],
    [{ code: 2, stdout: JSON.stringify({ status: 'PARTIAL_STATE_PRESERVED_NO_RETRY', reason: 'REMOTE_MAIN_BASE_CHANGED' }) }, false, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'],
    [{ code: 2, stdout: JSON.stringify({ status: 'REFUSED_BEFORE_WRITE', reason: 'FIXED_TARGET_ALREADY_EXISTS' }) }, false, 'BUNDLE_UNAVAILABLE'],
    [{ code: 1, stdout: 'not json' }, false, 'BUNDLE_UNAVAILABLE'],
  ];
  for (const [answer, ok, code] of cases) {
    const root = await tempRoot(t);
    let now = Date.parse('2026-10-21T08:00:00Z');
    const mailbox = await Mailbox.open(root, () => now);
    const log = [];
    const c = new Companion({ cfg, mailbox, run: async a => { log.push(a); return a.includes('-Rebundle') ? answer : { code: 0, stdout: '' }; }, fileExists: async () => true,
      sleep: async ms => { now += ms; }, clock: () => now });
    const req = await mailbox.send('rebuild-bundle', { batchId: BATCH }, 60_000);
    await c.step();
    const r = await mailbox.poll(req);
    assert.deepEqual([r.ok, r.code], [ok, code], answer.stdout);
    assert.ok(log.some(a => a.includes('-Rebundle')));
  }
});
