// DESIGN §26 (design r3 part two, "通道断了就快速结束"): the companion's signals B and C, the heartbeat's own timer, the
// engine's pump observer (signals A and D), the bridge stop through the stage's own stop path, the pump-quiet step, and the
// two new cancel reasons. Nothing here kills a process, writes 80-owner-abort or reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BRIDGE_POLL_MS, BRIDGE_STAGE_STOPPED_PUMP_LOST, BRIDGE_STOP_GRACE_MS, PUMP_CODES, PUMP_DEAD_CODES, PUMP_HEARTBEAT_STALE_MS, PUMP_QUIET_MS, WindowsEngine } from '../src/engine-windows.mjs';
import { CANCEL_CONTRACT, CANCEL_REASONS, Mailbox } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, RELAY_TIMEOUT_MS, WORKER_FACTS_EVERY_MS, WORKER_START_WAIT_MS, argv, parseUnitFacts, validateCompanionConfig, workerRanEvidence } from '../src/companion.mjs';
import { HEARTBEAT_EVERY_MS, startHeartbeat } from '../src/companion-main.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { abortStageEndingClean } from '../src/classify.mjs';
import { TEST_NODE, TEST_NODE_SHA, rawPolicy, tempRoot } from './helpers.mjs';

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const BATCH = '0123456789abcdef-0123456789ab';
const JOB = 'e'.repeat(64);
const T0 = Date.parse('2026-10-28T10:30:00Z');
const INVOCATION = 'a'.repeat(32);
const facts = (state, { invocation = '', mono = 0 } = {}) => ({ code: 0, stdout: `ActiveState=${state}\nInvocationID=${invocation}\nExecMainStartTimestampMonotonic=${mono}\n` });
const TRANSFERRED = { code: 0, stdout: JSON.stringify({ status: 'PUBLIC_RECORD_TRANSFERRED', terminalConfirmed: true }) };
const NOT_THERE = { code: 1, stdout: JSON.stringify({ childError: { reason: 'ENOENT' }, terminalConfirmed: true }) };
const mode = a => (a.includes('-Mode') ? a[a.indexOf('-Mode') + 1] : null);

// ---- the companion: signals B and C ----

// A pump over a scripted host. host({ mode, facts, listing, now }) answers; unitFacts(now) the systemctl show; listing(now) the
// Linux outgoing listing. Returns the answer, the relay modes called and when the pump answered.
async function pump(t, { unitFacts, listing = () => '', relay = m => (m === 'SendIssue' ? TRANSFERRED : NOT_THERE), cancelAt = null } = {}) {
  const root = await tempRoot(t);
  let now = T0;
  const box = await Mailbox.open(root, () => now);
  const modes = [], factsAt = [];
  let req;
  const run = async a => {
    const m = mode(a);
    if (m) { modes.push(m); return relay(m, now); }
    if (a.some(x => x.startsWith('--property=ActiveState'))) { factsAt.push(now - T0); return unitFacts(now - T0); }
    if (a.includes('/usr/bin/ls')) { const l = listing(now - T0); return typeof l === 'string' ? { code: 0, stdout: l } : l; }
    if (a.includes('quiescence')) return { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) };
    return { code: 0, stdout: '' }; // the worker start
  };
  const c = new Companion({ cfg, mailbox: box, run, fileExists: async p => p.includes('\\outgoing\\'),
    sleep: async ms => { now += ms; if (cancelAt !== null && now - T0 >= cancelAt) await box.cancel(req, 'stage-ended'); }, clock: () => now });
  req = await box.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  await c.step();
  return { res: await box.poll(req), modes, factsAt, elapsed: now - T0 };
}

test('unit facts: KEY=VALUE lines only; evidence of a run is activating/active/deactivating, failed, or an invocation with a start time', () => {
  assert.deepEqual(argv(cfg).unitFacts('clued-ci-worker', JOB).slice(-4), ['/usr/bin/systemctl', 'show', '--property=ActiveState,InvocationID,ExecMainStartTimestampMonotonic', `clued-ci-worker@${JOB}.service`]);
  assert.equal(argv(cfg).activeState, undefined, 'the ActiveState-only read is gone');
  assert.deepEqual(parseUnitFacts(facts('active', { invocation: INVOCATION, mono: 123 })), { activeState: 'active', invocationId: INVOCATION, mainStartMonotonic: 123 });
  for (const bad of [{ code: 0, stdout: 'inactive\n' }, { code: 1, stdout: 'ActiveState=inactive' }, { ...facts('inactive'), tree: 'zero' }, { code: null, stdout: '', timedOut: true }, null])
    assert.equal(parseUnitFacts(bad), null, JSON.stringify(bad));
  assert.equal(parseUnitFacts({ code: 0, stdout: 'ActiveState=inactive\nInvocationID=not-hex\n' }).invocationId, '');
  for (const s of ['activating', 'active', 'deactivating', 'failed']) assert.equal(workerRanEvidence(parseUnitFacts(facts(s))), true, s);
  assert.equal(workerRanEvidence(parseUnitFacts(facts('inactive'))), false, 'inactive right after start --no-block is no evidence');
  assert.equal(workerRanEvidence(parseUnitFacts(facts('inactive', { invocation: INVOCATION }))), false, 'an invocation id alone is not enough');
  assert.equal(workerRanEvidence(parseUnitFacts(facts('inactive', { invocation: INVOCATION, mono: 5 }))), true);
});

test('signal B: inactive with no evidence never ends the pump (review MAJOR 1); the worker then runs and the result arrives', async t => {
  const r = await pump(t, { unitFacts: ms => (ms < 20_000 ? facts('inactive') : ms < 45_000 ? facts('active', { invocation: INVOCATION, mono: 7 }) : facts('inactive', { invocation: INVOCATION, mono: 7 })),
    listing: ms => (ms > 40_000 ? 'result.ready.json\n' : ''), relay: m => (m === 'SendIssue' || m === 'ReceiveResult' ? TRANSFERRED : NOT_THERE) });
  assert.deepEqual([r.res.ok, r.res.code], [true, null], 'two reads of inactive without evidence (an empty listing each time) did not end it');
  assert.deepEqual(r.modes, ['SendIssue', 'ReceiveResult']);
  assert.equal(r.factsAt[0], 0, 'read right after the start');
  assert.ok(r.factsAt.slice(1, 3).every((at, i) => at - r.factsAt[i] >= WORKER_FACTS_EVERY_MS), `then every 15 s: ${r.factsAt}`);
});

test('signal B: activating, then inactive with an empty listing -> LINUX_WORKER_ENDED_WITHOUT_RECORD at once, no blocked hand-over', async t => {
  const r = await pump(t, { unitFacts: ms => (ms < 15_000 ? facts('activating') : facts('inactive')) });
  assert.deepEqual([r.res.ok, r.res.code], [false, 'LINUX_WORKER_ENDED_WITHOUT_RECORD']);
  assert.ok(r.elapsed < 20_000, `ended at the first facts read after the end (${r.elapsed} ms)`);
  assert.deepEqual(r.modes, ['SendIssue'], 'no ReceiveBlocked hand-over: the final listing held no blocked record');
  assert.ok(PUMP_CODES.includes('LINUX_WORKER_ENDED_WITHOUT_RECORD') && PUMP_DEAD_CODES.includes('LINUX_WORKER_ENDED_WITHOUT_RECORD'));
});

test('signal B: failed ends it; an ended worker whose listing still holds a record is relayed as usual; no listing is never final', async t => {
  const failed = await pump(t, { unitFacts: () => facts('failed') });
  assert.equal(failed.res.code, 'LINUX_WORKER_ENDED_WITHOUT_RECORD');
  const withResult = await pump(t, { unitFacts: () => facts('failed'), listing: () => 'result.ready.json\n', relay: m => (m === 'SendIssue' || m === 'ReceiveResult' ? TRANSFERRED : NOT_THERE) });
  assert.deepEqual([withResult.res.ok, withResult.modes], [true, ['SendIssue', 'ReceiveResult']]);
  const withBlocked = await pump(t, { unitFacts: () => facts('failed'), listing: () => 'blocked.ready.json\n', relay: m => (m === 'SendIssue' || m === 'ReceiveBlocked' ? TRANSFERRED : NOT_THERE) });
  assert.deepEqual([withBlocked.res.ok, withBlocked.modes], [true, ['SendIssue', 'ReceiveBlocked']]);
  // the listing fails: the relay probes, nothing is final, the pump goes on until it is cancelled
  const blind = await pump(t, { unitFacts: () => facts('failed'), listing: () => ({ code: 2, stdout: '' }), cancelAt: 10_000 });
  assert.equal(blind.res.code, 'COMPANION_PUMP_CANCELLED');
  // a challenge relayed counts as evidence: a reaped unit (inactive, no invocation) after it has ended
  let answered = false;
  const reaped = await pump(t, { unitFacts: () => facts('inactive'), listing: () => (answered ? '' : 'challenge-01.ready.json\n'),
    relay: m => { if (m === 'SendIssue') return TRANSFERRED; if (m === 'ReceiveChallenge') { answered = true; return TRANSFERRED; } return m === 'SendResponse' ? TRANSFERRED : NOT_THERE; } });
  assert.equal(reaped.res.code, 'LINUX_WORKER_ENDED_WITHOUT_RECORD');
});

test('signal B: an invocation id without a start time and no other evidence is not an end', async t => {
  const r = await pump(t, { unitFacts: () => facts('inactive', { invocation: INVOCATION, mono: 0 }), cancelAt: 4 * 60_000 });
  assert.equal(r.res.code, 'COMPANION_PUMP_CANCELLED');
});

test('signal C: no evidence and no record 5 minutes after the start -> LINUX_WORKER_NOT_STARTED; a failing facts read never fires it', async t => {
  const r = await pump(t, { unitFacts: () => facts('inactive') });
  assert.deepEqual([r.res.ok, r.res.code], [false, 'LINUX_WORKER_NOT_STARTED']);
  assert.ok(r.elapsed >= WORKER_START_WAIT_MS && r.elapsed < WORKER_START_WAIT_MS + WORKER_FACTS_EVERY_MS + 2000, `${r.elapsed} ms`);
  assert.deepEqual(r.modes, ['SendIssue'], 'no hand-over');
  const unread = await pump(t, { unitFacts: () => ({ code: 1, stdout: '' }), cancelAt: 8 * 60_000 });
  assert.equal(unread.res.code, 'COMPANION_PUMP_CANCELLED', 'nothing read is nothing shown');
  // a record once listed means the worker ran: never "not started"
  const listedOnce = await pump(t, { unitFacts: () => facts('inactive'), listing: ms => (ms < 2000 ? 'challenge-01.ready.json\n' : ''), cancelAt: 8 * 60_000 });
  assert.equal(listedOnce.res.code, 'COMPANION_PUMP_CANCELLED');
});

test('a companion restarted after the cancel answers COMPANION_PUMP_CANCELLED and never runs a second pump', async t => {
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => T0);
  const req = await box.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  await box.cancel(req, 'heartbeat-lost');
  const runs = [];
  const c = new Companion({ cfg, mailbox: box, run: async a => { runs.push(a); return a.includes('quiescence') ? { code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) } : { code: 0, stdout: '' }; },
    fileExists: async () => true, sleep: async () => {}, clock: () => T0 });
  await c.step();
  assert.equal((await box.poll(req)).code, 'COMPANION_PUMP_CANCELLED');
  assert.deepEqual(runs.filter(a => mode(a) || a.includes('start')).length, 0, 'no relay call, no worker start');
});

test('a companion restarted while its pump ran (no cancel yet) starts no second pump: the mark answers COMPANION_PUMP_UNCONFIRMED (r3 review MINOR 1)', async t => {
  // the first pump of a request writes the mark, and a request answered so is never listed again
  const first = await pump(t, { relay: m => (m === 'SendIssue' ? TRANSFERRED : m === 'ReceiveResult' ? TRANSFERRED : NOT_THERE), listing: () => 'result.ready.json\n',
    unitFacts: () => ({ code: 0, stdout: 'ActiveState=active\nInvocationID=ab\nExecMainStartTimestampMonotonic=5\n' }) });
  assert.deepEqual(first.modes.slice(0, 1), ['SendIssue']);
  // a restart: the request is still pending (no answer yet) and its mark exists
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => T0);
  const req = await box.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  assert.equal(await box.claimPump(req), true, 'the first pump takes the mark');
  assert.deepEqual((await fs.readdir(path.join(root, 'responses'))).sort(), [`${req.requestId}.pump.json`]);
  assert.deepEqual((await box.pending()).map(r => r.requestId), [req.requestId], 'the mark is no answer: the request stays pending');
  const runs = [];
  const c = new Companion({ cfg, mailbox: box, run: async a => { runs.push(a); return { code: 0, stdout: '' }; }, fileExists: async () => true, sleep: async () => {}, clock: () => T0 });
  await c.step();
  assert.equal((await box.poll(req)).code, 'COMPANION_PUMP_UNCONFIRMED');
  assert.equal(runs.filter(a => mode(a) || a.includes('start')).length, 0, 'no relay call, no worker start');
  assert.equal(PUMP_DEAD_CODES.includes('COMPANION_PUMP_UNCONFIRMED'), true, 'the service reads it as a dead pump (signal A)');
  // a mark that cannot be written starts no pump either
  const box2 = await Mailbox.open(await tempRoot(t), () => T0);
  const req2 = await box2.send('relay-stage', { batchId: BATCH, stage: 2, jobId: JOB }, 45 * 60_000);
  box2.claimPump = async () => { throw new Error('EPERM'); };
  const runs2 = [];
  await new Companion({ cfg, mailbox: box2, run: async a => { runs2.push(a); return { code: 0, stdout: '' }; }, fileExists: async () => true, sleep: async () => {}, clock: () => T0 }).step();
  assert.equal((await box2.poll(req2)).code, 'COMPANION_PUMP_UNCONFIRMED');
  assert.equal(runs2.filter(a => mode(a) || a.includes('start')).length, 0);
});

test('cancel reasons: owner-abort, stage-ended, heartbeat-lost and service-stopping on both sides; anything else is refused and no cancel', async t => {
  assert.deepEqual([...CANCEL_REASONS], ['owner-abort', 'stage-ended', 'heartbeat-lost', 'service-stopping']);
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => T0);
  for (const reason of CANCEL_REASONS) {
    const req = await box.send('relay-stage', { batchId: BATCH, stage: 4, jobId: JOB }, 60_000);
    assert.equal(await box.cancelled(req), false);
    await box.cancel(req, reason);
    assert.equal(await box.cancelled(req), true, reason);
  }
  const other = await box.send('relay-stage', { batchId: BATCH, stage: 6, jobId: JOB }, 60_000);
  await assert.rejects(box.cancel(other, 'bridge-stop'), { code: 'MAILBOX_CANCEL_REFUSED' });
  await fs.writeFile(path.join(root, 'requests', `${other.requestId}.cancel.json`), JSON.stringify({ contract: CANCEL_CONTRACT, requestId: other.requestId, kind: other.kind, reason: 'bridge-stop', at: '2026-10-28T10:30:00.000Z' }));
  assert.equal(await box.cancelled(other), false, 'the read side checks the reason too');
});

test('the heartbeat timer: a beat at once and every 10 s apart from the lanes; a failing beat throws nowhere; beats never overlap', async t => {
  assert.equal(HEARTBEAT_EVERY_MS, 10_000);
  const beats = [];
  let scheduled = null;
  const mb = { async beat() { beats.push(beats.length); if (beats.length === 2) throw new Error('rename EPERM'); } };
  startHeartbeat(mb, { schedule: (fn, ms) => { scheduled = { fn, ms }; return 1; } });
  assert.deepEqual([beats.length, scheduled.ms], [1, HEARTBEAT_EVERY_MS]);
  await scheduled.fn(); // throws inside: swallowed
  await scheduled.fn();
  assert.equal(beats.length, 3);
  // the real mailbox: two beats asked at once share one write (the timer and step() never collide on the temporary file)
  const root = await tempRoot(t);
  const box = await Mailbox.open(root, () => T0);
  await Promise.all([box.beat(), box.beat(), box.beat()]);
  assert.deepEqual(await box.heartbeat(), { at: T0 });
  assert.deepEqual((await fs.readdir(path.join(root, 'responses'))).sort(), ['heartbeat.json']);
  // the companion's own step() beat is wrapped as well: a mailbox that cannot beat still answers
  const box2 = await Mailbox.open(await tempRoot(t), () => T0);
  box2.beat = async () => { throw new Error('disk full'); };
  const q = await box2.send('linux-quiescence', { batchId: BATCH }, 60_000);
  const c = new Companion({ cfg, mailbox: box2, run: async () => ({ code: 0, stdout: JSON.stringify({ linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true }) }), fileExists: async () => false, sleep: async () => {}, clock: () => T0 });
  await c.step();
  assert.equal((await box2.poll(q)).ok, true);
});

test('the heartbeat timer starts only after the job host probe and every set-up step, and stops with the lanes (design r3 review MINOR 1; r3 review MAJOR 2)', async () => {
  const src = await fs.readFile(new URL('../src/companion-main.mjs', import.meta.url), 'utf8');
  const entry = src.indexOf('\nif (import.meta.url');
  const main = src.slice(src.indexOf('export async function main'), entry);
  const at = needle => { const i = main.indexOf(needle); assert.ok(i > 0, needle); return i; };
  const beat = at('const beating = startHeartbeat(mailbox);');
  assert.equal(main.split('startHeartbeat(').length - 1, 1, 'started once');
  // every step that can throw in set-up comes before the first beat: a companion that failed to set up sends none
  for (const step of ['await probeJobHost(runner);', 'validateHintConfig(raw.hints)', 'validateStatusConfig(raw.status)', "check(statusCfg.node === cfg.node.nodeName", 'await LocalStore.open(', 'keepalive(companionArgv(cfg).keepalive());']) {
    assert.ok(at(step) < beat, `${step} comes before the heartbeat`);
  }
  // the lanes run right after it, and the timer is cleared whatever ends them
  const lanes = main.indexOf('await Promise.all([', beat); // the lanes' (the hint modules load with one earlier)
  assert.ok(lanes > beat && main.slice(beat, lanes).trim().endsWith('try {'), 'the lanes start right after the heartbeat, inside try');
  assert.ok(at('clearInterval(beating);') > lanes && /}\s*finally\s*{\s*clearInterval\(beating\);/.test(main), 'finally clears the timer');
  // a failed main exits the process outright (an uncleared timer or the keepalive child could keep it alive otherwise)
  assert.ok(entry > 0);
  assert.match(src.slice(entry), /main\(\)\.catch\(\(\) => { process\.exit\(4\); }\)/);
});

// ---- the engine: the pump observer, the bridge stop, the pump-quiet step ----

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const sha = b => createHash('sha256').update(b).digest('hex');
const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q = 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n';
const SWAP = '0a1b2c3d-0000-4000-8000-000000000001';
const PUMP_REQ = '0a1b2c3d-0000-4000-8000-000000000009';
const stages = validatePolicy(rawPolicy()).stages;
const stageFact = (manifest, o = {}) => JSON.stringify({ contract: 'clued.independent-ci.resident-stage-fact/2', stage: 2, nonce: 'n'.repeat(32), manifest_sha256: manifest,
  state: 'FORMAL_CHILD_REFUSED_OR_UNKNOWN_ORIGINAL_STOPPED', failure_code: 'STAGE_OUTCOME_MISSING', scm_start_call_issued: true, original_binary_restored: true,
  complete_original_readback: true, configuration_conflict_detected: false, tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true,
  native_receipt_sha256: 'e'.repeat(64), outcome: null, ...o });

// An engine on a fake clock whose only time-keeper is the sleep port (the observer's polls, the bounded waits). The stage
// child takes the broker swap, then ends when its broker stop arrives (the broker sends stopCode, the helper drains its job;
// with holdStop only once the test releases it), or on its own at `endsAt` (virtual ms after the start) with `ownEnding`. A
// stop file is noticed at the virtual moment it was written: the sleep port looks before it moves the clock. The companion
// side is a scripted mailbox: script(ms, mb, ev) may set its answer or stop its heartbeat.
async function engineWith(t, { endsAt = null, ownEnding = null, beats = true, script = () => {}, stopCode = 'STOP_SENT', linuxWorker = true, number = 2, holdStop = false, stopFact = {} } = {}) {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source', 'e'.repeat(64));
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, ...V2, n), '// fixture');
  const brokerRoot = path.join(root, 'broker');
  for (const d of ['requests', 'responses']) await fs.mkdir(path.join(brokerRoot, d), { recursive: true });
  const batchDir = path.join(root, 'work', 'b');
  const wm = Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.resident-stage-work/2', effectsAuthorized: false, files: {}, planSha256: 'c'.repeat(64) }));
  for (const n of [2, 4, 6]) { await fs.mkdir(path.join(batchDir, `stage-0${n}`), { recursive: true }); await fs.writeFile(path.join(batchDir, `stage-0${n}`, 'work-manifest.json'), wm); }
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: [2, 4, 6].includes(n) ? sha(wm) : 'f'.repeat(64) }));
  const batch = { batchId: BATCH, key: 'a1'.repeat(32), dir: batchDir, stages: rows };
  let now = T0;
  const clock = () => now;
  const ev = { stopAt: null, cancels: [], answeredAt: null, released: false, forceEnd: false };
  t.signal.addEventListener('abort', () => { ev.forceEnd = true; ev.released = true; }, { once: true });
  const mb = {
    answer: null, beatAt: T0, sent: [],
    async send(kind, fields, timeoutMs) { mb.sent.push(kind); return { requestId: PUMP_REQ, kind, createdAt: new Date(now).toISOString(), deadline: new Date(now + timeoutMs).toISOString(), ...fields }; },
    async poll() { return mb.answer; },
    // DESIGN §32: the memory gate's read gets no reading here (the stage runs at once, as before the gate)
    async await(req, sleep) { if (req.kind === 'memory-ready') return null; while (now < Date.parse(req.deadline)) { if (mb.answer) return mb.answer; await sleep(500); } return null; },
    async heartbeat() { return mb.beatAt === null ? null : { at: mb.beatAt }; },
    async cancel(req, reason) { ev.cancels.push([reason, now - T0]); if (mb.onCancel) mb.onCancel(reason); return true; },
  };
  const tick = async () => { await script(now - T0, mb, ev); if (beats && mb.beatAt !== null) mb.beatAt = now; };
  const exists = async p => fs.access(p).then(() => true, () => false);
  const stopFile = path.join(brokerRoot, 'requests', `${SWAP}.stop`);
  const sleep = async ms => {
    if (ev.stopAt === null && await exists(stopFile)) ev.stopAt = now - T0;
    now += ms; await tick(); await new Promise(r => setImmediate(r));
  };
  const run = async argv => {
    if (argv[0].endsWith('sc.exe')) return { code: 0, stdout: argv[1] === 'qc' ? SC_QC : SC_Q };
    if (!argv[1]?.endsWith('invoke-stage.mjs')) throw new Error('unexpected argv ' + argv.join(' '));
    const manifest = argv[argv.indexOf('--work-manifest-sha256') + 1];
    // Taking the swap is one virtual-time event too. Yielding to real disk I/O
    // here let the observer advance its fake clock before the child had begun.
    writeFileSync(path.join(brokerRoot, 'requests', `${SWAP}.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-request/2', stage: number, nonce: 'a'.repeat(32), deadline: '2026-10-28T12:00:00Z', configSha256: 'c'.repeat(64) }));
    writeFileSync(path.join(brokerRoot, 'responses', `${SWAP}.taken`), Buffer.from([1]));
    for (;;) {
      // Test disposal is independent of the observer under test. A failed
      // assertion must not strand a held fake child in an infinite loop.
      if (ev.forceEnd) { writeFileSync(path.join(brokerRoot, 'responses', `${SWAP}.json`), '{}'); return { code: 41, stdout: stageFact(manifest, {}) }; }
      if (ev.stopAt === null && !linuxWorker && await exists(stopFile)) ev.stopAt = now - T0;
      if (ev.stopAt !== null && (!holdStop || ev.released)) {
        writeFileSync(path.join(brokerRoot, 'responses', `${SWAP}.stop.json`), JSON.stringify({ contract: 'clued.independent-ci.swap-broker-stop-receipt/1', requestId: SWAP, code: stopCode, at: new Date(now).toISOString() }));
        writeFileSync(path.join(brokerRoot, 'responses', `${SWAP}.json`), '{}');
        ev.endedAt = now - T0;
        return { code: 41, stdout: stageFact(manifest, stopFact) };
      }
      // The scripted end is one virtual-time event. Real asynchronous disk I/O here would let the observer
      // advance the fake clock beyond the grace while this fixture's terminal write was still pending.
      if (endsAt !== null && now - T0 >= endsAt) { writeFileSync(path.join(brokerRoot, 'responses', `${SWAP}.json`), '{}'); return { code: ownEnding.ok ? 0 : 41, stdout: stageFact(manifest, ownEnding.fact ?? {}) }; }
      // the stage runs on: virtual time only moves with the engine's own sleeps (the observer), or here when nothing observes
      if (!linuxWorker) await sleep(1000); else await new Promise(r => setImmediate(r));
    }
  };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, companionMailbox: mb, sleep, clock,
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe', brokerRoot } });
  const stage = { ...stages[number - 1], linuxWorker };
  const invoke = () => engine.invoke(batch, stage, rows[number - 1]);
  const stopFiles = async () => (await fs.readdir(path.join(brokerRoot, 'requests'))).filter(n => n.endsWith('.stop'));
  return { engine, batch, mb, ev, invoke, stopFiles, brokerRoot, now: () => now - T0 };
}
const DEAD = { ok: false, code: 'RELAY_REFUSED_NO_RETRY' };

test('a held fake child can be disposed when the observer never advances its clock', { timeout: 5000 }, async t => {
  const f = await engineWith(t, { holdStop: true });
  f.engine.observePump = () => ({ state: { answer: null, pumpCode: null, lostAt: null, stop: null }, stop: async () => {} });
  const running = f.invoke();
  try {
    const deadline = Date.now() + 2000;
    const taken = path.join(f.brokerRoot, 'responses', `${SWAP}.taken`);
    while (!(await fs.access(taken).then(() => true, () => false)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    await fs.access(taken);
    assert.equal(f.now(), 0, 'no observer advanced virtual time');
  } finally {
    f.ev.forceEnd = true;
    await running;
  }
});

test('signal A: no stop within the 60 s grace after the pump died, then exactly one stop; the stage ends BRIDGE_STAGE_STOPPED_PUMP_LOST', async t => {
  const f = await engineWith(t, { script: (ms, mb, ev) => { if (ms >= 30_000 && !mb.answer) { mb.answer = DEAD; ev.answeredAt = ms; } } });
  const r = await f.invoke();
  assert.equal(r.code, BRIDGE_STAGE_STOPPED_PUMP_LOST);
  assert.ok(f.ev.stopAt - f.ev.answeredAt >= BRIDGE_STOP_GRACE_MS, `stop ${f.ev.stopAt - f.ev.answeredAt} ms after the pump died`);
  assert.ok(f.ev.stopAt - f.ev.answeredAt <= BRIDGE_STOP_GRACE_MS + 2 * BRIDGE_POLL_MS, `${f.ev.stopAt - f.ev.answeredAt} ms`);
  assert.deepEqual(await f.stopFiles(), [`${SWAP}.stop`], 'one stop file, next to the in-flight swap');
  const stop = JSON.parse(await fs.readFile(path.join(f.brokerRoot, 'requests', `${SWAP}.stop`), 'utf8'));
  assert.deepEqual([stop.contract, stop.requestId, stop.stage], ['clued.independent-ci.swap-broker-stop/1', SWAP, 2]);
  assert.deepEqual(r.bridge, { pumpCode: 'RELAY_REFUSED_NO_RETRY', stopRequestId: SWAP, stopCode: 'STOP_SENT', stageCode: 'STAGE_OUTCOME_MISSING', pumpQuiet: true });
  assert.deepEqual([r.proof.windowsTreeZero, r.proof.serviceOriginalStopped], [true, true]);
  assert.deepEqual(f.ev.cancels, [], 'the pump had answered: nothing to cancel');
  assert.equal(f.engine.abortRequested, undefined, 'a bridge stop is no Owner abort');
  assert.equal(f.engine.bridgeState(f.batch, 2), null, 'nothing observed after the stage');
});

test('a pump answer that is not dead never stops the stage: FORMAL_WORKER_TERMINAL_UNCONFIRMED, ok, COMPANION_PUMP_CANCELLED', async t => {
  for (const answer of [{ ok: false, code: 'FORMAL_WORKER_TERMINAL_UNCONFIRMED' }, { ok: true, code: null }, { ok: false, code: 'COMPANION_PUMP_CANCELLED' }]) {
    const f = await engineWith(t, { endsAt: 10 * 60_000, ownEnding: { ok: true, fact: { state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null } },
      script: (ms, mb) => { if (ms >= 5_000) mb.answer = answer; } });
    const r = await f.invoke();
    assert.deepEqual(await f.stopFiles(), [], answer.code ?? 'ok');
    assert.equal(r.bridge.stopRequestId, null);
    assert.equal(r.code === BRIDGE_STAGE_STOPPED_PUMP_LOST, false);
  }
  for (const code of PUMP_DEAD_CODES) assert.ok(PUMP_CODES.includes(code), code);
  assert.ok(!PUMP_DEAD_CODES.includes('FORMAL_WORKER_TERMINAL_UNCONFIRMED') && !PUMP_DEAD_CODES.includes('COMPANION_PUMP_CANCELLED'));
});

test('stages 1, 3, 5, 7, 8, R and 10 are never observed or stopped', async t => {
  const f = await engineWith(t, { linuxWorker: false, number: 3, endsAt: 4 * 60_000, ownEnding: { ok: true, fact: { stage: 3, state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null } },
    script: (ms, mb) => { mb.answer = DEAD; mb.beatAt = null; } });
  const r = await f.invoke();
  assert.equal(r.ok, true);
  assert.equal(r.bridge, undefined);
  assert.deepEqual([await f.stopFiles(), f.ev.cancels, f.mb.sent], [[], [], []]);
  for (const n of [1, 3, 5, 7, 8, 9, 10]) {
    await assert.rejects(f.engine.bridgeStop(f.batch, n), { code: 'OWNER_ABORT_STOP_TARGET_INVALID' }, String(n));
    const o = f.engine.observePump(f.batch, n, Promise.resolve({ requestId: PUMP_REQ }));
    assert.equal(f.engine.bridge, null, `stage ${n}: no observer`);
    await o.stop();
  }
});

test('signal D: no heartbeat for 120 s -> the cancel (heartbeat-lost) first, the stop after the grace, then no wait for an answer', async t => {
  const f = await engineWith(t, { beats: true, script: (ms, mb) => { if (ms >= 20_000) mb.beatAt = null; } });
  f.mb.beatAt = T0;
  const r = await f.invoke();
  assert.equal(r.code, BRIDGE_STAGE_STOPPED_PUMP_LOST);
  assert.deepEqual(f.ev.cancels.map(c => c[0]), ['heartbeat-lost'], 'only the heartbeat-lost cancel: no stage-ended wait afterwards');
  const [, cancelAt] = f.ev.cancels[0];
  assert.ok(cancelAt > 20_000 + PUMP_HEARTBEAT_STALE_MS - BRIDGE_POLL_MS && cancelAt <= 20_000 + PUMP_HEARTBEAT_STALE_MS + 2 * BRIDGE_POLL_MS, `cancel at ${cancelAt}`);
  assert.ok(f.ev.stopAt >= cancelAt + BRIDGE_STOP_GRACE_MS, 'the stop only after the cancel and its grace');
  assert.ok(f.now() - f.ev.endedAt <= BRIDGE_POLL_MS, `no bounded wait for the dead companion (${f.now() - f.ev.endedAt} ms after the stage)`);
  assert.deepEqual(r.bridge, { pumpCode: 'COMPANION_HEARTBEAT_LOST', stopRequestId: SWAP, stopCode: 'STOP_SENT', stageCode: 'STAGE_OUTCOME_MISSING', pumpQuiet: false });
});

test('signal D never fires on a slow but healthy relay call: the timer beats on while the pump waits 120 s + 60 s + 15 s', async t => {
  // the pump answers only after 195 s (one slow relay call), the heartbeat keeps coming from the companion's own timer
  const f = await engineWith(t, { endsAt: 20 * 60_000, ownEnding: { ok: true, fact: { state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null } },
    script: (ms, mb) => { if (ms >= RELAY_TIMEOUT_MS + 60_000 + 15_000) mb.answer = { ok: true, code: null }; } });
  const r = await f.invoke();
  assert.equal(r.ok, true);
  assert.deepEqual([f.ev.cancels, await f.stopFiles()], [[], []]);
  // a heartbeat read that fails, or a missing file, is no heartbeat; a mailbox whose beat throws is the companion's business
  const g = await engineWith(t, { endsAt: 100_000, ownEnding: { ok: true, fact: { state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null } },
    script: (ms, mb) => { mb.heartbeat = async () => { throw new Error('EBUSY'); }; if (ms > 90_000) mb.answer = { ok: true, code: null }; } });
  assert.equal((await g.invoke()).ok, true, 'within 120 s nothing happens');
});

test('the issuer ends on its own during the grace: its own code, bridge facts with no stop', async t => {
  const f = await engineWith(t, { endsAt: 40_000, ownEnding: { ok: false, fact: { failure_code: 'PUBLICATION_UNCERTAIN', outcome: { status: 'UNCERTAIN', reason: 'BRIDGE_RESULT_DEADLINE', sideEffects: 1, mayHavePublished: true } } },
    script: (ms, mb) => { if (ms >= 10_000) mb.answer = DEAD; } });
  const r = await f.invoke();
  assert.equal(r.code, 'PUBLICATION_UNCERTAIN');
  assert.deepEqual(r.bridge, { pumpCode: 'RELAY_REFUSED_NO_RETRY', stopRequestId: null, stopCode: null, stageCode: 'PUBLICATION_UNCERTAIN', pumpQuiet: true });
  assert.deepEqual(await f.stopFiles(), []);
});

test('pump quiet: a stage that ended without success cancels its unanswered pump (stage-ended) and waits at most RELAY_TIMEOUT_MS + 60 s', async t => {
  assert.equal(PUMP_QUIET_MS, RELAY_TIMEOUT_MS + 60_000);
  const ending = { ok: false, fact: { failure_code: 'PUBLICATION_UNCERTAIN', outcome: { status: 'UNCERTAIN', reason: 'x', sideEffects: 1, mayHavePublished: true } } };
  // the pump answers once cancelled
  const f = await engineWith(t, { endsAt: 30_000, ownEnding: ending });
  f.mb.onCancel = () => { f.mb.answer = { ok: false, code: 'COMPANION_PUMP_CANCELLED' }; };
  const r = await f.invoke();
  assert.deepEqual(f.ev.cancels.map(c => c[0]), ['stage-ended']);
  assert.deepEqual([r.code, r.bridge.pumpQuiet, r.bridge.pumpCode], ['PUBLICATION_UNCERTAIN', true, 'COMPANION_PUMP_CANCELLED']);
  // it never answers: given up after PUMP_QUIET_MS, not quiet
  const g = await engineWith(t, { endsAt: 30_000, ownEnding: ending });
  const r2 = await g.invoke();
  assert.equal(r2.bridge.pumpQuiet, false);
  const waited = g.now() - g.ev.cancels[0][1];
  assert.ok(waited >= PUMP_QUIET_MS && waited <= PUMP_QUIET_MS + 1000, `${waited} ms`);
  // a stage that succeeded is never cancelled
  const h = await engineWith(t, { endsAt: 30_000, ownEnding: { ok: true, fact: { state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null } },
    script: (ms, mb) => { if (ms >= 40_000) mb.answer = { ok: true, code: null }; } });
  assert.equal((await h.invoke()).ok, true);
  assert.deepEqual(h.ev.cancels, []);
});

test('a stop the broker did not send keeps the stage\'s own code (no BRIDGE_STAGE_STOPPED_PUMP_LOST without STOP_SENT)', async t => {
  const f = await engineWith(t, { stopCode: 'BROKER_STOP_NOT_THIS_HELPER', script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
  const r = await f.invoke();
  assert.equal(r.code, 'STAGE_OUTCOME_MISSING');
  assert.equal(r.bridge.stopCode, 'BROKER_STOP_NOT_THIS_HELPER');
});

test('a bound outcome keeps its own code through a bridge stop (r3 review MAJOR 1): only a missing outcome reads BRIDGE_STAGE_STOPPED_PUMP_LOST', async t => {
  // the issuer bound a never-clean outcome just as the stop arrived: the stage keeps that code and its outcome
  const bound = { status: 'BLOCKED', reason: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', sideEffects: 1, mayHavePublished: true };
  const f = await engineWith(t, { stopFact: { failure_code: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', outcome: bound }, script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
  const r = await f.invoke();
  assert.equal(r.code, 'ROLE_ALREADY_PUBLISHED_ON_HEAD');
  assert.equal(r.outcome.reason, 'ROLE_ALREADY_PUBLISHED_ON_HEAD');
  assert.deepEqual([r.bridge.stopCode, r.bridge.stageCode], ['STOP_SENT', 'ROLE_ALREADY_PUBLISHED_ON_HEAD'], 'the bridge facts stay on record');
  // a clean outcome code bound at the same moment also keeps its code (no quiescence proof forced on it)
  const clean = { status: 'BLOCKED', reason: 'NOT_ADMITTED', sideEffects: 0, mayHavePublished: false };
  const g = await engineWith(t, { stopFact: { failure_code: 'NATIVE_NOT_ADMITTED', outcome: clean }, script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
  assert.equal((await g.invoke()).code, 'NATIVE_NOT_ADMITTED');
  // a missing-outcome code that still carries an outcome object is not rewritten either
  const h = await engineWith(t, { stopFact: { failure_code: 'STAGE_OUTCOME_MISSING', outcome: clean }, script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
  assert.equal((await h.invoke()).code, 'STAGE_OUTCOME_MISSING');
});

test('an Owner abort accepted after the engine read it, while a bridge stop ends the stage (deviation 5; r3 review MINOR 2): only a missing outcome under STOP_SENT is a clean abort ending', async t => {
  // the abort lands between the engine's ownerAbort read and its return: here, while it reads the broker's stop receipt
  // (the bridge stop's own path reads that receipt too, while the stage still runs: only a read after the stage child returned)
  const lateAbort = f => { const orig = f.engine.stopOutcome.bind(f.engine); let once = false;
    f.engine.stopOutcome = async id => { if (f.ev.endedAt !== undefined && !once) { once = true; await f.engine.requestStop(f.batch, 2); } return orig(id); }; };
  const f = await engineWith(t, { script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
  lateAbort(f);
  const r = await f.invoke();
  assert.equal(f.engine.abortRequested?.stage, 2, 'the abort was accepted during the stage');
  assert.deepEqual([r.code, r.outcome, r.bridge.stopCode], [BRIDGE_STAGE_STOPPED_PUMP_LOST, null, 'STOP_SENT']);
  assert.equal(abortStageEndingClean(r, { stopSent: true }), true, 'the abort takes the bridge stop\'s ending under STOP_SENT');
  assert.equal(abortStageEndingClean(r, { stopSent: false }), false, 'and never without it');
  // the same race with an outcome the issuer bound as the stop arrived: the stage keeps that code, which no abort accepts
  const bound = { status: 'BLOCKED', reason: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', sideEffects: 1, mayHavePublished: true };
  const g = await engineWith(t, { stopFact: { failure_code: 'ROLE_ALREADY_PUBLISHED_ON_HEAD', outcome: bound }, script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
  lateAbort(g);
  const r2 = await g.invoke();
  assert.equal(r2.code, 'ROLE_ALREADY_PUBLISHED_ON_HEAD');
  assert.equal(abortStageEndingClean(r2, { stopSent: true }), false, 'a never-clean outcome stays a HALT under an abort');
});

test('an Owner abort and a bridge stop together: one stop file, and the Owner abort wins (the stage keeps its own code)', { timeout: 10_000 }, async t => {
  const owned = [];
  const start = async () => {
    const world = await engineWith(t, { holdStop: true, script: (ms, mb) => { if (ms >= 1000) mb.answer = DEAD; } });
    const pending = world.invoke(); owned.push({ world, pending });
    return { world, pending };
  };
  // Waiting for real asynchronous disk I/O takes wall time, not a fixed
  // count of setImmediate turns. Always release the fake child on failure.
  const wait = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(predicate(), 'the fixture reached the required stop boundary');
  };
  try {
    const { world: f, pending: running } = await start();
    // the bridge stop is written first; then the executor's abort poll asks to stop the same stage
    await wait(() => f.engine.bridgeState(f.batch, 2)?.stopRequestId);
    assert.equal(f.engine.bridgeState(f.batch, 2).stopRequestId, SWAP);
    const out = await f.engine.requestStop(f.batch, 2);
    assert.deepEqual([out.broker, out.requestId], [true, SWAP], 'the abort binds the same stop request');
    f.ev.released = true;
    const r = await running;
    assert.deepEqual(await f.stopFiles(), [`${SWAP}.stop`], 'one stop file');
    assert.equal(r.code, 'STAGE_OUTCOME_MISSING', 'the abort path decides, with its own STOP_SENT rule');
    assert.deepEqual([r.bridge.stopRequestId, r.bridge.stopCode], [SWAP, 'STOP_SENT'], 'the bridge facts stay on record');
    // and the other order: an abort's stop first, the bridge's own later finds the same file
    const g = await engineWith(t, { holdStop: true, script: async (ms, mb, ev) => {
      if (ms >= 1000) mb.answer = DEAD;
      if (ms >= 10_000 && !ev.ownerStopStarted) {
        ev.ownerStopStarted = true;
        // This runs inside the sole fake clock's tick, before it can advance
        // to the bridge grace. Complete the Owner stop before unfreezing it.
        assert.equal(g.engine.bridgeState(g.batch, 2)?.stopRequestId, null);
        assert.deepEqual(await g.stopFiles(), [], 'the Owner stop is genuinely first');
        const owner = await g.engine.requestStop(g.batch, 2);
        assert.deepEqual([owner.broker, owner.requestId], [true, SWAP]);
        ev.ownerStopRecorded = true;
      }
    } });
    const second = g.invoke(); owned.push({ world: g, pending: second });
    await wait(() => g.ev.ownerStopRecorded);
    await wait(() => g.ev.stopAt !== null);
    await wait(() => g.engine.bridgeState(g.batch, 2)?.stopRequestId);
    g.ev.released = true;
    const r2 = await second;
    assert.deepEqual([await g.stopFiles(), r2.code], [[`${SWAP}.stop`], 'STAGE_OUTCOME_MISSING']);
  } finally {
    for (const { world, pending } of owned) {
      world.ev.released = true;
      world.ev.forceEnd = true;
      await pending;
    }
  }
});
