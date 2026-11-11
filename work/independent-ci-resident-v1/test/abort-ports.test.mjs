// Owner abort (DESIGN §6.5) at the port boundary: the Windows engine binds its stop request to exactly the in-flight
// swap of this batch's stage, a stage asked to stop before it was invoked is never invoked, and the companion's bridge
// pump stops relaying on a cancel of its own request without ever stopping or killing the Linux worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BROKER_STOP_CONTRACT, PUMP_CODES, WindowsEngine, findInflightSwap } from '../src/engine-windows.mjs';
import { CANCEL_CONTRACT, Mailbox } from '../src/mailbox.mjs';
import { CALLBACK_WINDOW_MS, Companion, RELAY_TIMEOUT_MS } from '../src/companion.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { TEST_NODE, TEST_NODE_SHA, rawPolicy, tempRoot, waitFor } from './helpers.mjs';

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const sha = b => createHash('sha256').update(b).digest('hex');
const stages = validatePolicy(rawPolicy()).stages;
const PLAN = 'c'.repeat(64);
const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q = 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n';
const ID = n => `0a1b2c3d-0000-4000-8000-00000000000${n}`;

async function fixture(t, { invoke } = {}) {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source', 'e'.repeat(64));
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, ...V2, n), '// fixture');
  const brokerRoot = path.join(root, 'broker');
  for (const d of ['requests', 'responses']) await fs.mkdir(path.join(brokerRoot, d), { recursive: true });
  // The batch: stage 2's sealed package records its plan hash in the work manifest the batch pins.
  const batchDir = path.join(root, 'work', 'b');
  await fs.mkdir(path.join(batchDir, 'stage-02'), { recursive: true });
  const wm = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.resident-stage-work/2', effectsAuthorized: false, files: {}, planSha256: PLAN }));
  await fs.writeFile(path.join(batchDir, 'stage-02', 'work-manifest.json'), wm);
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: n === 2 ? sha(wm) : 'f'.repeat(64) }));
  const batch = { batchId: '0123456789abcdef-000000000000', key: 'a1'.repeat(32), dir: batchDir, stages: rows };
  const runs = [], sent = [], cancelled = [];
  const run = async argv => {
    runs.push(argv);
    if (argv[0].endsWith('sc.exe')) return { code: 0, stdout: argv[1] === 'qc' ? SC_QC : SC_Q };
    if (argv[1]?.endsWith('invoke-stage.mjs')) return invoke ? invoke(argv) : { code: 41, stdout: '{}' };
    throw new Error('unexpected argv ' + argv.join(' '));
  };
  const companionMailbox = {
    async send(kind, fields) { sent.push([kind, fields]); return { requestId: ID(9), kind, fields }; },
    // pumpBlocks: the relay-stage pump answers only once it is cancelled (a pump still waiting on Linux).
    async await(req) {
      if (req.kind === 'check-refs') return { ok: true, code: null };
      if (req.kind === 'memory-ready') return null; // DESIGN §32: no reading, the stage runs as before the gate
      if (companionMailbox.pumpBlocks) await new Promise(resolve => { companionMailbox.unblock = resolve; });
      return { ok: false, code: 'COMPANION_PUMP_CANCELLED' };
    },
    async cancel(req, reason) { if (companionMailbox.cancelThrows) throw new Error('mailbox'); cancelled.push([req.requestId, reason]); companionMailbox.unblock?.(); return true; },
  };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, companionMailbox, sleep: async () => {}, clock: () => Date.parse('2026-10-21T08:00:00Z'),
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe', brokerRoot } });
  const request = async (id, { stage = 2, config = PLAN, taken = true, answered = false, nonce = 'a'.repeat(32) } = {}) => {
    await fs.writeFile(path.join(brokerRoot, 'requests', `${id}.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-request/2', stage, nonce, deadline: '2026-10-21T09:00:00Z', configSha256: config }));
    if (taken) await fs.writeFile(path.join(brokerRoot, 'responses', `${id}.taken`), Buffer.from([1]));
    if (answered) await fs.writeFile(path.join(brokerRoot, 'responses', `${id}.json`), '{}');
  };
  // The broker's own receipt of a stop request (SwapBroker.cs TryOwnerStop).
  const stopReceipt = async (id, code) => fs.writeFile(path.join(brokerRoot, 'responses', `${id}.stop.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-stop-receipt/1', requestId: id, code, at: '2026-10-21T08:00:05Z' }));
  return { root, brokerRoot, engine, batch, runs, sent, cancelled, request, stopReceipt, companionMailbox };
}

test('the stop request is bound to the one taken, unanswered swap of this stage and this batch\'s stage package', async t => {
  const f = await fixture(t);
  await f.request(ID(1));                                  // the swap in flight
  await f.request(ID(2), { answered: true });              // an earlier swap, already answered
  await f.request(ID(3), { stage: 4 });                    // another stage
  await f.request(ID(4), { config: 'd'.repeat(64) });      // another batch's (or stage's) package
  await f.request(ID(5), { taken: false });                // not taken by the broker yet
  assert.deepEqual(await findInflightSwap(f.brokerRoot, 2, PLAN), { requestId: ID(1), nonce: 'a'.repeat(32), stage: 2, configSha256: PLAN });
  const out = await f.engine.requestStop(f.batch, 2);
  assert.deepEqual([out.broker, out.requestId, out.stopCode, out.done], [true, ID(1), null, false], 'written; not done until the broker answers');
  const stop = JSON.parse(await fs.readFile(path.join(f.brokerRoot, 'requests', `${ID(1)}.stop`), 'utf8'));
  assert.deepEqual(stop, { configSha256: PLAN, contract: BROKER_STOP_CONTRACT, nonce: 'a'.repeat(32), requestId: ID(1), stage: 2 });
  assert.deepEqual((await fs.readdir(path.join(f.brokerRoot, 'requests'))).filter(n => n.endsWith('.stop')), [`${ID(1)}.stop`], 'no other swap is touched');
  assert.deepEqual((await f.engine.requestStop(f.batch, 2)).broker, true, 'idempotent');
  // Two candidates are ambiguous: nothing is written (the stage then ends on its own, and the abort follows).
  await f.request(ID(6));
  assert.equal(await findInflightSwap(f.brokerRoot, 2, PLAN), null);
  // Only the scanner-issuer stages, and only a package whose work manifest still matches the batch's pin.
  await assert.rejects(f.engine.requestStop(f.batch, 3), { code: 'OWNER_ABORT_STOP_TARGET_INVALID' });
  await fs.writeFile(path.join(f.batch.dir, 'stage-02', 'work-manifest.json'), '{"planSha256":"' + PLAN + '"}');
  await assert.rejects(f.engine.stagePlanSha256(f.batch, 2), { code: 'OWNER_ABORT_STAGE_PACKAGE_REFUSED' });
  const other = await f.engine.requestStop({ ...f.batch, batchId: 'fedcba9876543210-000000000000' }, 2);
  assert.deepEqual([other.broker, other.done], [false, false], 'a refused package writes no stop; the next poll tries again');
});

test('a stage asked to stop before it was invoked is never invoked; the refs gate and the runner readback still ran', async t => {
  const f = await fixture(t);
  await f.engine.requestStop(f.batch, 2);
  const r = await f.engine.runStage(f.batch, stages[1]);
  assert.deepEqual([r.ok, r.code, r.proof.windowsTreeZero, r.proof.serviceOriginalStopped], [false, 'OWNER_ABORT_REQUESTED', true, true]);
  assert.equal(f.runs.some(a => a[1]?.endsWith('invoke-stage.mjs')), false);
  assert.deepEqual(f.sent.map(s => s[0]), ['check-refs'], 'no relay-stage pump was ever requested');
  // Another batch's stage 2 is not affected by this flag.
  const other = await f.engine.runStage({ ...f.batch, batchId: 'fedcba9876543210-000000000000' }, stages[1]);
  assert.notEqual(other.code, 'OWNER_ABORT_REQUESTED');
});

test('a running issuer stage: the pump of exactly that stage is cancelled; the stage ends through its own stop path', async t => {
  let release;
  const running = new Promise(resolve => { release = resolve; });
  let started;
  const invoked = new Promise(resolve => { started = resolve; });
  const fact = { contract: 'clued.independent-ci.resident-stage-fact/2', stage: 2, nonce: 'n'.repeat(32), manifest_sha256: 'x', state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED',
    failure_code: 'STAGE_OUTCOME_MISSING', scm_start_call_issued: true, original_binary_restored: true, complete_original_readback: true, configuration_conflict_detected: false,
    tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true, native_receipt_sha256: 'e'.repeat(64), outcome: null };
  const f = await fixture(t, { invoke: async () => { started(); await running; return { code: 41, stdout: JSON.stringify({ ...fact, manifest_sha256: f.batch.stages[1].workManifestSha256 }) }; } });
  await f.request(ID(1));
  const stage = f.engine.runStage(f.batch, stages[1]);
  await invoked;
  // The broker stop first; the pump keeps relaying (and keeps its blocked hand-over) until the stop was sent (review M4).
  const first = await f.engine.requestStop(f.batch, 2);
  assert.deepEqual([first.broker, first.stopCode, first.pump, first.done], [true, null, false, false]);
  assert.deepEqual(f.cancelled, []);
  await f.stopReceipt(ID(1), 'STOP_SENT');
  // The swap is answered by now in real life; the engine remembers its request id.
  await fs.writeFile(path.join(f.brokerRoot, 'responses', `${ID(1)}.json`), '{}');
  const out = await f.engine.requestStop(f.batch, 2);
  assert.deepEqual([out.broker, out.requestId, out.stopCode, out.pump, out.done], [true, ID(1), 'STOP_SENT', true, true]);
  assert.deepEqual(f.cancelled, [[ID(9), 'owner-abort']], 'the relay-stage pump of this stage, once');
  assert.equal(await f.engine.stopOutcome(ID(1)), 'STOP_SENT');
  release();
  const r = await stage;
  assert.deepEqual([r.ok, r.code, r.proof.windowsTreeZero, r.proof.serviceOriginalStopped], [false, 'STAGE_OUTCOME_MISSING', true, true]);
  assert.equal(f.engine.inflight, null, 'nothing in flight after the stage');
  assert.ok(PUMP_CODES.includes('COMPANION_PUMP_CANCELLED'));
});

test('a stop the broker did not send never cancels the pump; a failing pump cancel never blocks the broker stop (review M4)', async t => {
  let release;
  const running = new Promise(resolve => { release = resolve; });
  let started;
  const invoked = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { invoke: async () => { started(); await running; return { code: 41, stdout: '{}' }; } });
  f.companionMailbox.pumpBlocks = true;
  await f.request(ID(1));
  const stage = f.engine.runStage(f.batch, stages[1]);
  await invoked;
  await f.stopReceipt(ID(1), 'BROKER_STOP_NOT_THIS_HELPER');
  const out = await f.engine.requestStop(f.batch, 2);
  assert.deepEqual([out.stopCode, out.pump, out.done], ['BROKER_STOP_NOT_THIS_HELPER', false, false], 'the pump keeps relaying while the issuer still runs');
  assert.deepEqual(f.cancelled, []);
  // The helper ends by itself; the stage now only waits for the pump, which the next poll cancels (second review MINOR 2).
  release();
  // After the helper returns, the engine still does real file I/O (the observer's stop) before it marks the Windows side ended.
  await waitFor(() => f.engine.inflight?.windowsEnded === true, 'the engine to mark the Windows side of the stage ended');
  assert.equal(f.engine.inflight?.windowsEnded, true);
  const after = await f.engine.requestStop(f.batch, 2);
  assert.deepEqual([after.pump, after.done], [true, true]);
  assert.deepEqual(f.cancelled, [[ID(9), 'owner-abort']]);
  await stage;
  // A second batch: the mailbox cancel throws, the stop is still written and the answer is not done.
  let release2, started2;
  const running2 = new Promise(resolve => { release2 = resolve; });
  const invoked2 = new Promise(resolve => { started2 = resolve; });
  const g = await fixture(t, { invoke: async () => { started2(); await running2; return { code: 41, stdout: '{}' }; } });
  g.companionMailbox.cancelThrows = true;
  await g.request(ID(2));
  await g.stopReceipt(ID(2), 'STOP_SENT');
  const stage2 = g.engine.runStage(g.batch, stages[1]);
  await invoked2;
  const out2 = await g.engine.requestStop(g.batch, 2);
  assert.deepEqual([out2.broker, out2.stopCode, out2.pump, out2.done], [true, 'STOP_SENT', false, false], 'tried again on the next poll');
  g.companionMailbox.cancelThrows = false;
  const out3 = await g.engine.requestStop(g.batch, 2);
  assert.deepEqual([out3.pump, out3.done], [true, true]);
  release2();
  await stage2;
  assert.equal(await g.engine.stopOutcome(ID(3)), null, 'no receipt, no code');
  await fs.writeFile(path.join(g.brokerRoot, 'responses', `${ID(4)}.stop.json`), JSON.stringify({ contract: 'x', requestId: ID(4), code: 'STOP_SENT' }));
  assert.equal(await g.engine.stopOutcome(ID(4)), null, 'only exactly the broker receipt counts');
});

test('the companion pump stops relaying on a cancel of its own request and never stops or kills the worker', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-21T08:00:00Z');
  const clock = () => now;
  const mailbox = await Mailbox.open(root, clock);
  const log = [];
  const run = async argv => { log.push(argv.join(' ')); return argv.join(' ').includes('quiescence') ? { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) } : { code: 0, stdout: '' }; };
  const cfg = { contract: 'clued.independent-ci.resident-companion-config/2', node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\x\\relay-public.ps1', bundleScript: 'C:\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool', distribution: 'Ubuntu-24.04',
    bridgeManifestSha256: 'b'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  let polls = 0;
  const c = new Companion({ cfg, mailbox, run, fileExists: async () => false, sleep: async ms => { now += ms; polls += 1; if (polls === 5) await mailbox.cancel(req, 'owner-abort'); }, clock });
  const req = await mailbox.send('relay-stage', { batchId: '0123456789abcdef-000000000000', stage: 2, jobId: '2'.repeat(64) }, 45 * 60_000);
  await c.step();
  const res = await mailbox.poll(req);
  assert.deepEqual([res.ok, res.code, res.proof], [false, 'COMPANION_PUMP_CANCELLED', { linuxUnitsInactive: true, containersZero: true }]);
  assert.ok(now - Date.parse('2026-10-21T08:00:00Z') < 60_000, 'it stopped at once, not at the 45-minute deadline');
  assert.equal(log.some(a => /systemctl (stop|kill)|\bkill\b/.test(a)), false);
  // The cancel file is no request of its own, and only a well-formed cancel of exactly this request counts.
  assert.deepEqual((await mailbox.pending()).filter(p => p.refused), []);
  const v = JSON.parse(await fs.readFile(path.join(root, 'requests', `${req.requestId}.cancel.json`), 'utf8'));
  assert.deepEqual([v.contract, v.requestId, v.kind, v.reason], [CANCEL_CONTRACT, req.requestId, 'relay-stage', 'owner-abort']);
  const other = await mailbox.send('relay-stage', { batchId: '0123456789abcdef-000000000000', stage: 4, jobId: '4'.repeat(64) }, 60_000);
  await fs.writeFile(path.join(root, 'requests', `${other.requestId}.cancel.json`), '{"contract":');
  assert.equal(await mailbox.cancelled(other), false, 'a torn cancel is no cancel');
  await assert.rejects(mailbox.cancel(other, 'because'), { code: 'MAILBOX_CANCEL_REFUSED' });
});

test('a cancel that comes with the issue transfer starts no worker', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-21T08:00:00Z');
  const clock = () => now;
  const mailbox = await Mailbox.open(root, clock);
  const log = [];
  let req;
  const run = async argv => {
    const a = argv.join(' ');
    log.push(a);
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) };
    if (a.includes('-Mode SendIssue')) { await mailbox.cancel(req, 'owner-abort'); return { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) }; }
    return { code: 0, stdout: '' };
  };
  const cfg = { contract: 'clued.independent-ci.resident-companion-config/2', node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\x\\relay-public.ps1', bundleScript: 'C:\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool', distribution: 'Ubuntu-24.04',
    bridgeManifestSha256: 'b'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  const c = new Companion({ cfg, mailbox, run, fileExists: async p => p.endsWith('issue.ready.json'), sleep: async ms => { now += ms; }, clock });
  req = await mailbox.send('relay-stage', { batchId: '0123456789abcdef-000000000000', stage: 2, jobId: '2'.repeat(64) }, 45 * 60_000);
  await c.step();
  assert.deepEqual([(await mailbox.poll(req)).code], ['COMPANION_PUMP_CANCELLED']);
  assert.equal(log.some(a => a.includes('start --no-block')), false);
});

// The bridge pump against the real Companion and Mailbox (bootstrap review 11af4710, finding 3). `relay(mode, ctx)`
// answers each relay call and `listing` the Linux outgoing listing (a string, or a function of ctx returning the run
// result); ctx.cancel() writes the Owner-abort cancel of this pump's request once and notes when.
const TRANSFERRED = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
const NOT_THERE = { code: 0, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
async function pumpWith(t, { listing, relay, fileExists = async p => p.endsWith('outgoing\\issue.ready.json'), onSleep = async () => {}, mailboxPatch = () => {} }) {
  const root = await tempRoot(t);
  const start = Date.parse('2026-10-21T08:00:00Z');
  let now = start, req, cancelAt = null;
  const clock = () => now;
  const mailbox = await Mailbox.open(root, clock);
  const log = [];
  const ctx = { cancel: async () => { if (cancelAt === null) { cancelAt = now; await mailbox.cancel(req, 'owner-abort'); } }, advance: ms => { now += ms; } };
  const run = async (argv, { timeoutMs } = {}) => {
    const a = argv.join(' ');
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) };
    if (a.includes('/usr/bin/ls')) return typeof listing === 'function' ? listing(ctx) : { code: 0, stdout: listing };
    const mode = /-Mode (\w+)/.exec(a)?.[1];
    if (mode) { log.push({ mode, afterCancel: cancelAt !== null }); return relay(mode, { ...ctx, timeoutMs }); }
    return { code: 0, stdout: '' }; // the worker start
  };
  const cfg = { contract: 'clued.independent-ci.resident-companion-config/2', node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\x\\relay-public.ps1', bundleScript: 'C:\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool', distribution: 'Ubuntu-24.04',
    bridgeManifestSha256: 'b'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  const c = new Companion({ cfg, mailbox, run, fileExists, sleep: async ms => { now += ms; await onSleep(ctx); }, clock });
  req = await mailbox.send('relay-stage', { batchId: '0123456789abcdef-000000000000', stage: 2, jobId: '2'.repeat(64) }, 45 * 60_000);
  mailboxPatch(mailbox);
  await c.step();
  return { res: await mailbox.poll(req), log, elapsed: now - start, sinceCancel: cancelAt === null ? null : now - cancelAt, after: log.filter(x => x.afterCancel).map(x => x.mode) };
}
const REFUSED = { code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' };

test('a cancel while a Receive relay call fails ends the pump after that one call: no blocked hand-over, no further relay (bootstrap review finding 3)', async t => {
  // A refused ReceiveBlocked skips the hand-over anyway; its cancel must still be the answer.
  for (const [mode, listing] of [['ReceiveResult', 'result.ready.json\n'], ['ReceiveChallenge', 'challenge-01.ready.json\n'], ['ReceiveBlocked', 'blocked.ready.json\n']]) {
    for (const fail of ['timeout', 'busy']) {
      const label = `${mode}, ${fail}`;
      const r = await pumpWith(t, { listing, relay: async (m, ctx) => {
        if (m === 'SendIssue') return TRANSFERRED;
        if (m !== mode) return NOT_THERE;
        await ctx.cancel();
        if (fail === 'timeout') { ctx.advance(ctx.timeoutMs); return { code: null, stdout: '', stderr: '', timedOut: true }; }
        return { code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' };
      } });
      assert.deepEqual([r.res.ok, r.res.code], [false, 'COMPANION_PUMP_CANCELLED'], label);
      assert.ok(r.sinceCancel <= RELAY_TIMEOUT_MS, `${label}: answered within the one relay call's time (${r.sinceCancel} ms)`);
      assert.deepEqual(r.after, [], `${label}: no relay call after the cancel, so no blocked hand-over`);
    }
  }
});

test('a cancel during the blocked hand-over ends it at its next wait step', async t => {
  let failed = false;
  const r = await pumpWith(t, { listing: 'result.ready.json\n',
    relay: async m => {
      if (m === 'SendIssue') return TRANSFERRED;
      if (m === 'ReceiveResult') { failed = true; return { code: null, stdout: '', stderr: '', refused: 'RUNNER_BUSY_WITH_UNFINISHED_CHILD' }; }
      return NOT_THERE;
    },
    onSleep: async ctx => { if (failed) await ctx.cancel(); } });
  assert.deepEqual([r.res.ok, r.res.code], [false, 'COMPANION_PUMP_CANCELLED']);
  assert.ok(r.sinceCancel !== null && r.sinceCancel <= 1000, `stopped at the next wait step (${r.sinceCancel} ms), not after the hand-over window`);
  assert.deepEqual(r.after, []);
});

test('a response that was already there when the cancel came is not relayed', async t => {
  const r = await pumpWith(t, { listing: 'challenge-01.ready.json\n',
    fileExists: async p => p.endsWith('outgoing\\issue.ready.json') || p.endsWith('outgoing\\response-01.ready.json'),
    relay: async (m, ctx) => {
      if (m === 'SendIssue') return TRANSFERRED;
      if (m === 'ReceiveChallenge') { await ctx.cancel(); return TRANSFERRED; }
      return NOT_THERE;
    } });
  assert.deepEqual([r.res.ok, r.res.code], [false, 'COMPANION_PUMP_CANCELLED']);
  assert.deepEqual(r.after, [], 'no SendResponse, no ReceiveBlocked');
});

test('after a cancel no relay call starts, also right after a listing or a "not there" answer (second review MINOR 1)', async t => {
  // a: without a listing, the cancel comes during a ReceiveChallenge that finds nothing: no ReceiveResult, no ReceiveBlocked.
  const a = await pumpWith(t, { listing: async () => ({ code: 1, stdout: '' }),
    relay: async (m, ctx) => { if (m === 'SendIssue') return TRANSFERRED; if (m === 'ReceiveChallenge') await ctx.cancel(); return NOT_THERE; } });
  // b: the cancel comes during the listing that shows the blocked record: it is not received.
  const b = await pumpWith(t, { listing: async ctx => { await ctx.cancel(); return { code: 0, stdout: 'blocked.ready.json\n' }; },
    relay: async m => (m === 'SendIssue' ? TRANSFERRED : NOT_THERE) });
  // c: the same inside the blocked hand-over, after a failed ReceiveResult.
  let failed = false;
  const c = await pumpWith(t, { listing: async ctx => { if (failed) await ctx.cancel(); return { code: 0, stdout: failed ? 'blocked.ready.json\n' : 'result.ready.json\n' }; },
    relay: async m => { if (m === 'SendIssue') return TRANSFERRED; if (m === 'ReceiveResult') { failed = true; return REFUSED; } return NOT_THERE; } });
  for (const [label, r] of [['a', a], ['b', b], ['c', c]]) {
    assert.deepEqual([r.res.ok, r.res.code], [false, 'COMPANION_PUMP_CANCELLED'], label);
    assert.deepEqual(r.after, [], `${label}: no relay call after the cancel`);
  }
});

test('a cancelled pump answers COMPANION_PUMP_CANCELLED whatever step it ended in (second review NIT 2)', async t => {
  // a: the SendIssue that was running as the cancel came fails.
  const a = await pumpWith(t, { listing: '', relay: async (m, ctx) => { if (m === 'SendIssue') { await ctx.cancel(); return REFUSED; } return NOT_THERE; } });
  // b: the hand-over's own ReceiveBlocked that was running as the cancel came is refused.
  let failed = false;
  const b = await pumpWith(t, { listing: async () => ({ code: 0, stdout: failed ? 'blocked.ready.json\n' : 'result.ready.json\n' }),
    relay: async (m, ctx) => {
      if (m === 'SendIssue') return TRANSFERRED;
      if (m === 'ReceiveResult') { failed = true; return REFUSED; }
      if (m === 'ReceiveBlocked') { await ctx.cancel(); return REFUSED; }
      return NOT_THERE;
    } });
  for (const [label, r] of [['a', a], ['b', b]]) {
    assert.deepEqual([r.res.ok, r.res.code], [false, 'COMPANION_PUMP_CANCELLED'], label);
    assert.deepEqual(r.after, [], `${label}: no relay call after the cancel`);
  }
});

test('a cancel file that cannot be read is no cancel: the pump runs exactly as without an abort (second review NIT 3)', async t => {
  const r = await pumpWith(t, { listing: 'result.ready.json\n',
    relay: async m => (m === 'SendIssue' ? TRANSFERRED : m === 'ReceiveResult' ? REFUSED : NOT_THERE),
    mailboxPatch: mailbox => { mailbox.cancelled = async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }; } });
  assert.deepEqual([r.res.ok, r.res.code], [false, 'RELAY_REFUSED_NO_RETRY']);
  assert.ok(r.elapsed >= CALLBACK_WINDOW_MS, `the blocked hand-over ran its window (${r.elapsed} ms)`);
});

test('a cancel during the callback rounds skips the blocked hand-over: the pump answers at once', async t => {
  const root = await tempRoot(t);
  const start = Date.parse('2026-10-21T08:00:00Z');
  let now = start;
  const clock = () => now;
  const mailbox = await Mailbox.open(root, clock);
  const log = [];
  const run = async argv => {
    const a = argv.join(' ');
    log.push(a);
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) };
    if (a.includes('-Mode SendIssue')) return { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
    return { code: 0, stdout: '' }; // worker start, and an empty Linux outgoing listing: nothing to relay yet
  };
  const cfg = { contract: 'clued.independent-ci.resident-companion-config/2', node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\x\\relay-public.ps1', bundleScript: 'C:\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool', distribution: 'Ubuntu-24.04',
    bridgeManifestSha256: 'b'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' };
  let req, polls = 0;
  const c = new Companion({ cfg, mailbox, run, fileExists: async p => p.endsWith('issue.ready.json'), sleep: async ms => { now += ms; polls += 1; if (polls === 8) await mailbox.cancel(req, 'owner-abort'); }, clock });
  req = await mailbox.send('relay-stage', { batchId: '0123456789abcdef-000000000000', stage: 2, jobId: '2'.repeat(64) }, 45 * 60_000);
  await c.step();
  const res = await mailbox.poll(req);
  assert.deepEqual([res.ok, res.code], [false, 'COMPANION_PUMP_CANCELLED']);
  assert.ok(log.some(a => a.includes('-Mode SendIssue')), 'the issue had been relayed: the cancel came during the rounds');
  assert.ok(now - start < 60_000, 'no wait for a blocked record');
  assert.equal(log.some(a => a.includes('-Mode ReceiveBlocked')), false);
  assert.equal(log.some(a => /systemctl (stop|kill)|\bkill\b/.test(a)), false);
});
