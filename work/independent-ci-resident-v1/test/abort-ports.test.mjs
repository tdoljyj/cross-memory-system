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
import { Companion } from '../src/companion.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { rawPolicy, tempRoot } from './helpers.mjs';

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
    async await(req) { return req.kind === 'check-refs' ? { ok: true, code: null } : { ok: false, code: 'COMPANION_PUMP_CANCELLED' }; },
    async cancel(req, reason) { cancelled.push([req.requestId, reason]); return true; },
  };
  const engine = new WindowsEngine({ run, busy: () => false, companionMailbox, sleep: async () => {}, clock: () => Date.parse('2026-10-21T08:00:00Z'),
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe', brokerRoot } });
  const request = async (id, { stage = 2, config = PLAN, taken = true, answered = false, nonce = 'a'.repeat(32) } = {}) => {
    await fs.writeFile(path.join(brokerRoot, 'requests', `${id}.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-request/2', stage, nonce, deadline: '2026-10-21T09:00:00Z', configSha256: config }));
    if (taken) await fs.writeFile(path.join(brokerRoot, 'responses', `${id}.taken`), Buffer.from([1]));
    if (answered) await fs.writeFile(path.join(brokerRoot, 'responses', `${id}.json`), '{}');
  };
  return { root, brokerRoot, engine, batch, runs, sent, cancelled, request };
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
  assert.deepEqual([out.broker, out.requestId], [true, ID(1)]);
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
  await assert.rejects(f.engine.requestStop(f.batch, 2), { code: 'OWNER_ABORT_STAGE_PACKAGE_REFUSED' });
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
  const out = await f.engine.requestStop(f.batch, 2);
  assert.deepEqual([out.pump, out.broker], [true, true]);
  assert.deepEqual(f.cancelled, [[ID(9), 'owner-abort']], 'the relay-stage pump of this stage, once');
  release();
  const r = await stage;
  assert.deepEqual([r.ok, r.code, r.proof.windowsTreeZero, r.proof.serviceOriginalStopped], [false, 'STAGE_OUTCOME_MISSING', true, true]);
  assert.equal(f.engine.inflight, null, 'nothing in flight after the stage');
  assert.ok(PUMP_CODES.includes('COMPANION_PUMP_CANCELLED'));
});

test('the companion pump stops relaying on a cancel of its own request and never stops or kills the worker', async t => {
  const root = await tempRoot(t);
  let now = Date.parse('2026-10-21T08:00:00Z');
  const clock = () => now;
  const mailbox = await Mailbox.open(root, clock);
  const log = [];
  const run = async argv => { log.push(argv.join(' ')); return argv.join(' ').includes('quiescence') ? { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) } : { code: 0, stdout: '' }; };
  const cfg = { contract: 'clued.independent-ci.resident-companion-config/1', wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
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
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true }) };
    if (a.includes('-Mode SendIssue')) return { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
    return { code: 0, stdout: '' }; // worker start, and an empty Linux outgoing listing: nothing to relay yet
  };
  const cfg = { contract: 'clued.independent-ci.resident-companion-config/1', wslExe: 'C:\\Windows\\System32\\wsl.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
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
