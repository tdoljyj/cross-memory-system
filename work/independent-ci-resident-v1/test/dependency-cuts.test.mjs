// Generation 11 (DESIGN 55): the external dependencies of the resident under a network cut. Each test cuts one dependency the way
// the line fails (a git step that fails in git, a read without an answer) and checks that the batch waits and asks again instead of
// ending, and that what is not a passing fault ends exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REFS_GATE_RETRY_MS, WindowsEngine } from '../src/engine-windows.mjs';
import { CHECK_REFS_REQUEST_MS, Mailbox } from '../src/mailbox.mjs';
import { networkFailure } from '../src/classify.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, validateCompanionConfig } from '../src/companion.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { RELAY_ON, TEST_NODE, TEST_NODE_SHA, executorFixture, fakeCompanion, fakeEngine, hintFor, rawPolicy, relayedRow, tempRoot, triggerBytes } from './helpers.mjs';

const MIN = 60_000;
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}

// ---- the refs gate before the first Linux stage: two reads without an answer are asked again ----
function gateEngine(t, answersFor) {
  return (async () => {
    const root = await tempRoot(t);
    const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
    await fs.mkdir(path.join(root, 'source', ...V2), { recursive: true });
    for (const n of ['invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(root, 'source', ...V2, n), '//');
    const asked = [], slept = [];
    const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n START_TYPE : 3\r\n SERVICE_START_NAME : .\\clued-control\r\n';
    const run = async a => (a[0].endsWith('sc.exe') ? { code: 0, stdout: a[1] === 'qc' ? SC_QC : 'STATE : 1 STOPPED\r\n PID : 0\r\n' } : { code: 0, stdout: '' });
    const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, sleep: async ms => { slept.push(ms); },
      clock: () => Date.now(), companionMailbox: { async send(kind) { asked.push(kind); return { kind }; }, async await(req) { return answersFor(req.kind, asked.filter(k => k === req.kind).length); } },
      paths: { sourceRoot: path.join(root, 'source'), workRoot: root, outboxRoot: root, nodeExe: 'C:\\node.exe', powershellExe: 'C:\\ps.exe', scExe: 'C:\\sc.exe' } });
    engine.invoke = async () => ({ ok: true, invoked: true });
    const batch = { batchId: 'b', key: 'a'.repeat(64), dir: root, stages: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: 'd'.repeat(64), workManifestSha256: 'f'.repeat(64) })) };
    return { engine, batch, asked, slept, stages: validatePolicy(rawPolicy()).stages };
  })();
}

test('refs gate: REMOTE_REFS_NO_ANSWER (the line) is asked again after 1 and 5 minutes; a definite answer ends the gate', async t => {
  assert.deepEqual(REFS_GATE_RETRY_MS, [MIN, 5 * MIN]);
  const g = await gateEngine(t, (kind, n) => (n < 3 ? { ok: false, code: 'REMOTE_REFS_NO_ANSWER' } : { ok: true }));
  let checks = 0;
  const r = await g.engine.runStage(g.batch, g.stages[1], { firstLinux: true, betweenRoles: false, stillAllowed: async () => { checks += 1; return true; } });
  assert.equal(r.invoked, true, JSON.stringify(r));
  assert.deepEqual(r.refsGate, { asks: 3, waitRefused: null }, 'the stage result carries what the gate did');
  assert.equal(g.asked.filter(k => k === 'check-refs').length, 3);
  assert.equal(checks, 2, "the executor's check after each wait");
  assert.ok(g.slept.includes(MIN) && g.slept.includes(5 * MIN), JSON.stringify(g.slept));
  const moved = await gateEngine(t, (kind, n) => (n === 1 ? { ok: false, code: 'REMOTE_REFS_NO_ANSWER' } : { ok: false, code: 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' }));
  assert.equal((await moved.engine.runStage(moved.batch, moved.stages[1], { firstLinux: true, betweenRoles: false })).code, 'REMOTE_REFS_CHANGED_SINCE_BUNDLE');
  assert.equal(moved.asked.filter(k => k === 'check-refs').length, 2);
});

test('refs gate: a cut that outlasts the waits is REFS_GATE_UNCONFIRMED told as the line; a script refusal, no answer at all or a free-form code are never asked again', async t => {
  let g = await gateEngine(t, () => ({ ok: false, code: 'REMOTE_REFS_NO_ANSWER' }));
  let r = await g.engine.runStage(g.batch, g.stages[1], { firstLinux: true, betweenRoles: false });
  assert.deepEqual([r.code, r.refsNoAnswer], ['REFS_GATE_UNCONFIRMED', true]);
  assert.deepEqual(r.refsGate, { asks: 3, waitRefused: null });
  assert.equal(g.asked.filter(k => k === 'check-refs').length, 3);
  assert.equal(networkFailure({ code: 'REFS_GATE_UNCONFIRMED', refsNoAnswer: true }), true, 'the breaker learns the line');
  assert.equal(networkFailure({ code: 'REFS_GATE_UNCONFIRMED' }), false);
  for (const answer of [null, { ok: false, code: 'REMOTE_REFS_UNAVAILABLE' }, { ok: false, code: 'GITHUB_TRANSIENT_UNAVAILABLE' }]) {
    g = await gateEngine(t, () => answer);
    r = await g.engine.runStage(g.batch, g.stages[1], { firstLinux: true, betweenRoles: false });
    assert.deepEqual([r.code, r.refsNoAnswer], ['REFS_GATE_UNCONFIRMED', undefined], JSON.stringify(answer));
    assert.equal(g.asked.filter(k => k === 'check-refs').length, 1, 'never asked again');
  }
  // the executor's check fails after the wait (a HALT, a drift, the authority): no more reads, and never told as the line
  for (const [verdict, why] of [['halt', 'halt'], ['authority', 'authority'], [false, 'refused']]) {
    g = await gateEngine(t, () => ({ ok: false, code: 'REMOTE_REFS_NO_ANSWER' }));
    r = await g.engine.runStage(g.batch, g.stages[1], { firstLinux: true, betweenRoles: false, stillAllowed: async () => verdict });
    assert.deepEqual([r.code, r.refsNoAnswer, r.refsGate], ['REFS_GATE_UNCONFIRMED', undefined, { asks: 1, waitRefused: why }], String(verdict));
    assert.equal(g.asked.filter(k => k === 'check-refs').length, 1);
  }
});

test('refs gate: an Owner abort during the wait wakes it at once and ends the stage as OWNER_ABORT_REQUESTED', async t => {
  const g = await gateEngine(t, () => ({ ok: false, code: 'REMOTE_REFS_NO_ANSWER' }));
  let stop = false;
  g.engine.stopRequested = () => stop;
  // the gate's sleep never ends by itself; the abort wakes it (gateSleep)
  g.engine.sleep = ms => (ms === MIN ? new Promise(() => {}) : Promise.resolve());
  const run = g.engine.runStage(g.batch, g.stages[1], { firstLinux: true, betweenRoles: false });
  await new Promise(r => setImmediate(r));
  stop = true;
  g.engine.gateWake?.();
  const r = await run;
  assert.equal(r.code, 'OWNER_ABORT_REQUESTED');
  assert.equal(g.asked.filter(k => k === 'check-refs').length, 1);
});

test('companion: REMOTE_REFS_NO_ANSWER only when every read was the line (ls-remote failed in git, or no verdict with its tree gone)', async t => {
  const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
    powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\protected-job-bridge-v4\\relay-public.ps1',
    bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
    distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
  const BATCH = '0123456789abcdef-0123456789ab';
  const gitFailed = { code: 2, stdout: JSON.stringify({ status: 'REFUSED', reason: 'GIT_STEP_FAILED', git: { label: 'ls-remote-check', exitCode: 128 } }) };
  const silent = { code: null, stdout: '', timedOut: true, tree: 'zero' };
  const unconfirmed = { code: null, stdout: '', timedOut: true, tree: 'unconfirmed' };
  const scriptRefused = { code: 2, stdout: JSON.stringify({ status: 'REFUSED', reason: 'BUNDLE_GENERATION_INCOMPLETE' }) };
  for (const [answers, code] of [[[gitFailed, gitFailed], 'REMOTE_REFS_NO_ANSWER'], [[silent, gitFailed], 'REMOTE_REFS_NO_ANSWER'], [[unconfirmed], 'REMOTE_REFS_UNAVAILABLE'],
    [[scriptRefused, scriptRefused], 'REMOTE_REFS_UNAVAILABLE'], [[gitFailed, scriptRefused], 'REMOTE_REFS_UNAVAILABLE']]) {
    const root = await tempRoot(t);
    let now = Date.parse('2026-11-05T08:00:00Z');
    const mailbox = await Mailbox.open(root, () => now);
    const list = [...answers];
    const c = new Companion({ cfg, mailbox, run: async a => (a.includes('-CheckRefs') ? (list.length > 1 ? list.shift() : list[0]) : { code: 0, stdout: '' }), fileExists: async () => true,
      sleep: async ms => { now += ms; }, clock: () => now });
    const req = await mailbox.send('check-refs', { batchId: BATCH }, 11 * MIN);
    await c.step();
    assert.equal((await mailbox.poll(req)).code, code, JSON.stringify(answers.map(a => a.stdout || a.tree)));
  }
});

test('refs gate in the executor: the stage-terminal receipt says how often the gate asked; its check names halt, drift or authority (and the next read is budgeted)', async t => {
  const engine = fakeEngine();
  const run = engine.runStage;
  engine.runStage = async (batch, stage, o) => (stage.number === 2 ? { ...(await run(batch, stage, o)), refsGate: { asks: 3, waitRefused: null } } : run(batch, stage, o));
  const f = await executorFixture(t, { engine });
  await f.drop(triggerBytes());
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  const terminals = [];
  for (const e of await f.receipts.entries()) if (e.type === 'stage-terminal') terminals.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  assert.deepEqual(terminals.filter(b => b.refsGate).map(b => [b.stage, b.refsGate]), [[2, { asks: 3, waitRefused: null }]]);
  // the check itself
  const g = await executorFixture(t);
  assert.equal(await g.exec.gateWaitStillAllowed('k', 2), true);
  g.exec.ledger.halted = async () => ({ value: { code: 'X' } });
  assert.equal(await g.exec.gateWaitStillAllowed('k', 2), 'halt');
  const h = await executorFixture(t);
  const p = h.exec.policy;
  const rest = p.stages.filter(s => s.number >= 2 && s.number <= 8).reduce((sum, s) => sum + s.runMilliseconds + p.limits.stageMarginMs, 0);
  h.exec.policy = { ...p, validUntil: new Date(h.clock() + rest + 60_000).toISOString() };
  assert.equal(await h.exec.gateWaitStillAllowed('k', 2), 'authority', 'the next refs read (9 min) does not fit');
  h.exec.policy = { ...p, validUntil: new Date(h.clock() + rest + CHECK_REFS_REQUEST_MS).toISOString() };
  assert.equal(await h.exec.gateWaitStillAllowed('k', 2), true);
});
