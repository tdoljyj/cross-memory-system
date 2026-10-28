// DESIGN §32. A: the pre-stage memory gate (Task 25851665; Decision 941f9146 §2 B2): before a scanner stage (2, 4, 6) is invoked, the
// companion reads the VM's hv_sock memory facts over one fixed-argv wsl.exe; a low reading waits for memguard, and one still low at
// the bound refuses the stage cleanly (LINUX_MEMORY_NOT_READY) instead of a likely UNCERTAIN. B: "main moved / the subject changed"
// before the first publication ends FAILED_CLEAN, never HALT (Task ea32aaf9, Owner Decision d8e3dea4 fix 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailbox, RESPONSE_CONTRACT } from '../src/mailbox.mjs';
import { COMPANION_CONFIG_CONTRACT, Companion, MEMORY_FACTS_FILES, argv, parseMemoryFacts, ringOrder, validateCompanionConfig } from '../src/companion.mjs';
import { MEMORY_GATE_CHECKS, MEMORY_GATE_MIN_BLOCKS, MEMORY_GATE_POLL_MS, MEMORY_GATE_WAIT_MS, WindowsEngine } from '../src/engine-windows.mjs';
import { BRIDGE_ABANDONED_UNPUBLISHED, CLEAN_FINAL_CODES, LINUX_MEMORY_NOT_READY, NOT_ADMITTED_CODES, TRANSIENT_CODES, UNKNOWN_CODES, abortStageEndingClean, decideFailure,
  failureRow } from '../src/classify.mjs';
import { attempt2Decision } from '../src/attempts.mjs';
import { mayHavePublished } from '../src/executed-heads.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { BASE, CLEAN_PROOF, HEAD, SOURCE, TEST_NODE, TEST_NODE_SHA, WINDOWS_CLEAN, executorFixture, fakeCompanion, fakeEngine, rawPolicy, tempRoot, triggerBytes } from './helpers.mjs';

// /proc/buddyinfo fixtures of test_host_tuning.py (memguard's own): 0 blocks of order >= 7 in LOW, thousands in HIGH.
const LOW_BUDDY = 'Node 0, zone    DMA32   5131   2227    703    424    335    263    210      0      0      0      0\n'
  + 'Node 0, zone   Normal   1037    597    194     44     21     21      5      0      0      0      0\n';
const HIGH_BUDDY = 'Node 0, zone    DMA32   3949   3186   2754   1852   1554   1267    934    632    360    197    528\n'
  + 'Node 0, zone   Normal   3408   2170   1256    938    588    370    250    168    161    137    173\n';
const facts = (buddy, rmem = 212992, wmem = 212992) => `${rmem}\n${wmem}\n${buddy}`;

const cfg = validateCompanionConfig({ contract: COMPANION_CONFIG_CONTRACT, node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, wslExe: 'C:\\Windows\\System32\\wsl.exe',
  powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', relayScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\relay-public.ps1',
  bundleScript: 'C:\\ProgramData\\CluedIndependentCI\\resident\\source\\x\\build-bundle.ps1', windowsSpool: 'C:\\ProgramData\\CluedIndependentCI\\formal-spool',
  distribution: 'Ubuntu-24.04', bridgeManifestSha256: '9'.repeat(64), linuxTool: '/opt/clued-independent-ci/resident-v1/bin/clued-ci-resident-linux' });
const BATCH = '0123456789abcdef-0123456789ab';
const T0 = Date.parse('2026-10-29T08:00:00Z');

// ---------------- A: the reading ----------------

test('A: the ring order and the free blocks of at least that order, over all zones, as memguard computes them', () => {
  assert.equal(ringOrder(212992, 212992), 7, 'the socket defaults: order 7');
  assert.equal(ringOrder(65536, 65536), 5, 'host tuning P1: order 5');
  assert.equal(ringOrder(0, 0), 4, 'each direction clamped to at least 6 pages');
  assert.equal(ringOrder(1 << 30, 1 << 30), 7, 'and to at most 64 pages');
  assert.deepEqual(parseMemoryFacts(facts(HIGH_BUDDY)), { order: 7, blocks: 632 + 360 + 197 + 528 + 168 + 161 + 137 + 173 });
  assert.deepEqual(parseMemoryFacts(facts(LOW_BUDDY)), { order: 7, blocks: 0 });
  assert.deepEqual(parseMemoryFacts(facts(LOW_BUDDY, 65536, 65536)), { order: 5, blocks: 263 + 210 + 21 + 5 }, 'enough once the rings are order 5');
  assert.deepEqual(parseMemoryFacts(facts(HIGH_BUDDY).replace(/\n/g, '\r\n')), parseMemoryFacts(facts(HIGH_BUDDY)));
  // columns past order 10 are ignored, like memguard's parts[4 + order:15]
  assert.deepEqual(parseMemoryFacts(facts('Node 0, zone   Normal 1 1 1 1 1 1 1 2 2 2 2 999\n')), { order: 7, blocks: 8 });
  // anything that is not exactly two sizes and zone lines is no reading
  for (const bad of ['', '212992\n', facts(''), `x\n212992\n${HIGH_BUDDY}`, facts('Node 0, zone DMA32 1 2 3\n'), facts(HIGH_BUDDY.replace('3949', '-1')),
    facts(`${HIGH_BUDDY}garbage line\n`), facts('Node 0, area DMA32 1 1 1 1 1 1 1 1 1 1 1\n')]) assert.equal(parseMemoryFacts(bad), null, JSON.stringify(bad));
});

test('A: the companion reads the facts with one fixed-argv wsl.exe and answers them; a failed read is LINUX_MEMORY_UNREADABLE', async t => {
  const root = await tempRoot(t);
  let now = T0;
  const mailbox = await Mailbox.open(root, () => now);
  const runs = [];
  let reply = { code: 0, stdout: facts(HIGH_BUDDY) };
  const c = new Companion({ cfg, mailbox, run: async (a, o) => { runs.push([a, o]); return typeof reply === 'function' ? reply(a) : reply; }, fileExists: async () => true, sleep: async ms => { now += ms; }, clock: () => now });
  const expected = ['C:\\Windows\\System32\\wsl.exe', '--distribution', 'Ubuntu-24.04', '--user', 'root', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'LC_ALL=C',
    '/usr/bin/cat', '--', '/proc/sys/net/core/rmem_default', '/proc/sys/net/core/wmem_default', '/proc/buddyinfo'];
  assert.deepEqual(argv(cfg).memoryFacts(), expected);
  assert.deepEqual(MEMORY_FACTS_FILES, expected.slice(-3));
  const ask = async () => { const req = await mailbox.send('memory-ready', { batchId: BATCH }, 60_000); await c.step(); return mailbox.poll(req); };
  const ok = await ask();
  assert.deepEqual([ok.contract, ok.ok, ok.code, ok.memory], [RESPONSE_CONTRACT, true, null, { order: 7, blocks: 2356 }]);
  assert.equal(RESPONSE_CONTRACT, 'clued.independent-ci.resident-companion-response/3');
  assert.deepEqual(runs.map(([a, o]) => [a, o.timeoutMs]), [[expected, 15_000]], 'one wsl.exe, under the job host limit of the other checks');
  for (const r of [{ code: 1, stdout: '' }, { code: 0, stdout: 'garbage' }, { code: null, timedOut: true, tree: 'zero', stdout: facts(HIGH_BUDDY) }, { code: 0, tree: 'unconfirmed', stdout: facts(HIGH_BUDDY) },
    { refused: 'JOB_HOST_UNCONFIRMED', code: null, stdout: '' }]) {
    runs.length = 0; reply = r;
    const a = await ask();
    assert.deepEqual([a.ok, a.code, a.memory, runs.length], [false, 'LINUX_MEMORY_UNREADABLE', null, 1], JSON.stringify(r));
  }
  reply = () => { throw new Error('host gone'); };
  const thrown = await ask();
  assert.deepEqual([thrown.ok, thrown.code, thrown.memory], [false, 'COMPANION_HANDLER_UNCONFIRMED', null]);
  // the response carries memory only for memory-ready, and only exactly { order, blocks }
  const other = await mailbox.send('linux-quiescence', { batchId: BATCH }, 60_000);
  await assert.rejects(mailbox.respond(other, { ok: true, memory: { order: 7, blocks: 1 } }), { code: 'MAILBOX_RESPONSE_MEMORY_REFUSED' });
  for (const memory of [{ order: 7 }, { order: 11, blocks: 1 }, { order: 7, blocks: -1 }, { order: 7, blocks: 1, zones: {} }, { order: '7', blocks: 1 }]) {
    const req = await mailbox.send('memory-ready', { batchId: BATCH }, 60_000);
    await assert.rejects(mailbox.respond(req, { ok: true, memory }), { code: 'MAILBOX_RESPONSE_MEMORY_REFUSED' }, JSON.stringify(memory));
  }
});

// ---------------- A: the gate in the engine ----------------

const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n';
const SC_Q = 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n';
const stageFact = n => JSON.stringify({ contract: 'clued.independent-ci.resident-stage-fact/2', stage: n, nonce: 'n'.repeat(32), manifest_sha256: 'f'.repeat(64),
  state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION', failure_code: null, scm_start_call_issued: true, original_binary_restored: true, complete_original_readback: true,
  configuration_conflict_detected: false, tree_cleanup_confirmed: true, tree_active_processes: 0, root_exit_confirmed: true, native_receipt_sha256: 'e'.repeat(64),
  outcome: { status: 'ISSUED_RESULT_RECEIVED', reason: null, sideEffects: 1, mayHavePublished: false } });
const READY = { ok: true, code: null, memory: { order: 7, blocks: 2356 } };
const LOW = { ok: true, code: null, memory: { order: 7, blocks: MEMORY_GATE_MIN_BLOCKS - 1 } };
const UNREADABLE = { ok: false, code: 'LINUX_MEMORY_UNREADABLE' };

// readings: the memory-ready answers in order (the last one repeats); null = no answer at all.
async function gateEngine(t, readings, { onSleep = null } = {}) {
  const root = await tempRoot(t);
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, ...V2, n), '// fixture');
  let now = T0, reads = 0;
  const sent = [], invoked = [], sleeps = [];
  const run = async a => {
    if (a[0].endsWith('sc.exe')) return { code: 0, stdout: a[1] === 'qc' ? SC_QC : SC_Q };
    if (a[0].endsWith('powershell.exe')) return { code: 0, stdout: JSON.stringify({ verified: true, directory: 'archive-x', moved: 1 }) };
    if (a[1]?.endsWith('invoke-stage.mjs')) { const n = Number(a[a.indexOf('--stage') + 1]); invoked.push(n); return { code: 0, stdout: stageFact(n) }; }
    throw new Error('unexpected argv ' + a.join(' '));
  };
  const companionMailbox = {
    async send(kind, fields) { sent.push(kind); return { kind, fields }; },
    async await(req) {
      if (req.kind !== 'memory-ready') return { ok: true, code: null, verified: true, directory: 'archive-x' };
      now += 800; // one wsl.exe
      const r = readings[Math.min(reads, readings.length - 1)];
      reads += 1;
      return r;
    },
  };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, companionMailbox, clock: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms; onSleep?.(engine, sleeps.length); },
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\resident\\runtime\\node.exe',
      powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe' } });
  const batch = { batchId: BATCH, key: 'a1'.repeat(32), dir: path.join(root, 'work', 'b'),
    stages: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64) })) };
  return { engine, batch, sent, invoked, sleeps, elapsed: () => now - T0, reads: () => reads };
}
const stages = validatePolicy(rawPolicy()).stages;
const plain = { betweenRoles: false, firstLinux: false };

test('A: memory ready -> the stage runs as before: one read right before it, then its pump and its invoker', async t => {
  for (const n of [2, 4, 6]) {
    const f = await gateEngine(t, [READY]);
    const r = await f.engine.runStage(f.batch, stages[n - 1], plain);
    assert.equal(r.ok, true, String(n));
    assert.deepEqual([f.sent, f.invoked, f.sleeps], [['memory-ready', 'relay-stage'], [n], []], String(n));
    assert.deepEqual([r.memoryGate.ready, r.memoryGate.refused, r.memoryGate.checks, r.memoryGate.order, r.memoryGate.blocks], [true, false, 1, 7, 2356]);
  }
  // stages without a Linux worker (1, 3, 5, 7, 8) never read the memory
  for (const n of [1, 3, 5, 7, 8]) {
    const f = await gateEngine(t, [LOW]);
    const r = await f.engine.runStage(f.batch, stages[n - 1], plain);
    assert.deepEqual([r.ok, f.sent, r.memoryGate], [true, [], undefined], String(n));
  }
});

test('A: low, then memguard repairs it -> the gate waits a minute per look and the stage runs in the same batch', async t => {
  const f = await gateEngine(t, [LOW, LOW, READY]);
  const r = await f.engine.runStage(f.batch, stages[1], plain);
  assert.equal(r.ok, true);
  assert.deepEqual([f.sleeps, f.invoked, f.sent.filter(k => k === 'memory-ready').length], [[MEMORY_GATE_POLL_MS, MEMORY_GATE_POLL_MS], [2], 3]);
  assert.deepEqual([r.memoryGate.ready, r.memoryGate.low, r.memoryGate.checks], [true, true, 3]);
  assert.ok(r.memoryGate.waitedMs >= 2 * MEMORY_GATE_POLL_MS);
});

test('A: still low at the bound -> LINUX_MEMORY_NOT_READY; nothing of the stage ran: no invoker, no pump, the Windows half proven', async t => {
  for (const n of [2, 4, 6]) {
    const f = await gateEngine(t, [LOW]);
    const r = await f.engine.runStage(f.batch, stages[n - 1], plain);
    assert.deepEqual([r.ok, r.code, r.proof.windowsTreeZero, r.proof.serviceOriginalStopped], [false, LINUX_MEMORY_NOT_READY, true, true], String(n));
    assert.deepEqual([f.invoked, f.sent.includes('relay-stage'), f.reads()], [[], false, MEMORY_GATE_CHECKS], String(n));
    assert.deepEqual([r.memoryGate.ready, r.memoryGate.refused, r.memoryGate.blocks], [false, true, MEMORY_GATE_MIN_BLOCKS - 1]);
    assert.ok(f.elapsed() <= MEMORY_GATE_WAIT_MS + 60_000, `${f.elapsed()} ms`);
    assert.ok(abortStageEndingClean(r), 'an Owner abort accepted in that instant takes it as a clean ending');
  }
  // the bound is the time too: slow reads stop the wait at MEMORY_GATE_WAIT_MS, whatever the count
  const slow = await gateEngine(t, [LOW], { onSleep: () => {} });
  slow.engine.clock = (c => () => c() + slow.reads() * 100_000)(slow.engine.clock);
  const r = await slow.engine.runStage(slow.batch, stages[1], plain);
  assert.equal(r.code, LINUX_MEMORY_NOT_READY);
  assert.ok(slow.reads() < MEMORY_GATE_CHECKS, `${slow.reads()} reads`);
});

test('A: an unreadable memory read proves nothing: without a low reading the stage runs at once, as before the gate', async t => {
  for (const reading of [UNREADABLE, null, { ok: true, code: null }, { ok: true, code: null, memory: { order: 7, blocks: -5 } }]) {
    const f = await gateEngine(t, [reading]);
    const r = await f.engine.runStage(f.batch, stages[1], plain);
    assert.deepEqual([r.ok, f.invoked, f.reads(), f.sleeps, r.memoryGate.ready, r.memoryGate.refused], [true, [2], 1, [], null, false], JSON.stringify(reading));
  }
  // a mailbox that throws is the same: no reading, never a HALT or a refusal by itself
  const g = await gateEngine(t, [READY]);
  g.engine.companionMailbox.await = async req => { if (req.kind === 'memory-ready') throw new Error('mailbox'); return { ok: true }; };
  assert.equal((await g.engine.runStage(g.batch, stages[1], plain)).ok, true);
  // after a low reading, an unreadable one is not "ready": the wait goes on and still ends at the bound
  const h = await gateEngine(t, [LOW, UNREADABLE]);
  const r = await h.engine.runStage(h.batch, stages[3], plain);
  assert.deepEqual([r.code, h.reads(), h.invoked], [LINUX_MEMORY_NOT_READY, MEMORY_GATE_CHECKS, []]);
  assert.equal(r.memoryGate.blocks, MEMORY_GATE_MIN_BLOCKS - 1, 'the last valid reading is kept');
});

test('A: an Owner abort while the gate waits ends the wait: OWNER_ABORT_REQUESTED, the stage never invoked', async t => {
  const f = await gateEngine(t, [LOW], { onSleep: (engine, n) => { if (n === 2) engine.abortRequested = { batchId: BATCH, stage: 2 }; } });
  const r = await f.engine.runStage(f.batch, stages[1], plain);
  assert.deepEqual([r.code, f.invoked, f.sent.includes('relay-stage'), f.reads()], ['OWNER_ABORT_REQUESTED', [], false, 3]);
});

// ---------------- A: the executor's ending at stages 2, 4, 6 ----------------

const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const refused = { ok: false, code: LINUX_MEMORY_NOT_READY, proof: WINDOWS_CLEAN, memoryGate: { checks: 7, order: 7, blocks: 12, low: true, ready: false, waitedMs: 360_800, refused: true } };
async function bodies(f, type) {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
}

test('A: a refusal at stage 2 is FAILED_CLEAN, never published, no HALT, and the head runs again as the one attempt 2', async t => {
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 2: refused } }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', LINUX_MEMORY_NOT_READY, batchKey(subject({ attempt: 2 }))]);
  assert.equal(await f.ledger.halted(), null);
  const s = await f.ledger.state(KEY);
  assert.deepEqual([s.terminal.facts.stage, s.terminal.facts.class, s.terminal.facts.retry, s.terminal.facts.breaker], [2, 'environment', 'attempt2', 'counts']);
  assert.deepEqual(mayHavePublished({}, s), { published: false, basis: 'failed-clean-stage-2' });
  assert.equal(await f.executedHeads.published(subject()), false, 'never recorded as executed');
  assert.equal(await f.ledger.headBurned(headKey(subject({ attempt: 2 }))), false, 'attempt 2 of the head is free to run');
  assert.deepEqual((await bodies(f, 'stage-terminal')).find(b => b.stage === 2).memoryGate, { checks: 7, order: 7, blocks: 12, waitedMs: 360_800, ready: false, refused: true });
  assert.deepEqual(f.engine.calls.filter(c => c[0] === 'stage').map(c => c[1]), [1, 2], 'nothing after stage 2');
  // attempt 2 runs once, after its delay, and completes when the memory is there again
  f.engine.runStage = async (batch, stage) => { f.engine.calls.push(['stage', stage.number]); return { ok: true, factsSha256: 'd'.repeat(64) }; };
  f.advance(600_000);
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
});

test('A: at stages 4 and 6 the refusal is FAILED_CLEAN too (no UNCERTAIN, no HALT), but stage 3 published: no attempt 2, a new commit runs', async t => {
  for (const stage of [4, 6]) {
    const f = await executorFixture(t, { engine: fakeEngine({ stages: { [stage]: refused } }) });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode, r.attempt2], ['FAILED_CLEAN', LINUX_MEMORY_NOT_READY, undefined], String(stage));
    assert.equal(await f.ledger.halted(), null);
    const s = await f.ledger.state(KEY);
    assert.deepEqual([s.terminal.facts.stage, s.terminal.facts.retry], [stage, 'new-commit']);
    assert.equal(mayHavePublished({}, s).published, true);
    assert.equal(await f.executedHeads.published(subject()), true);
  }
  // an attempt 2 that is refused again gets no attempt 3
  assert.equal(attempt2Decision({ policy: { automaticAttempt2: { enabled: true } }, subject: { attempt: 2 }, outcome: 'FAILED_CLEAN', failure: { code: LINUX_MEMORY_NOT_READY, stageNumber: 2, relayedRoles: 0 } }).eligible, false);
  // nor after stage R relayed a role
  assert.equal(attempt2Decision({ policy: { automaticAttempt2: { enabled: true } }, subject: { attempt: 1 }, outcome: 'FAILED_CLEAN', failure: { code: LINUX_MEMORY_NOT_READY, stageNumber: 2, relayedRoles: 1 } }).eligible, false);
  // a Linux proof that is not complete at the refusal HALTs as for every clean code (never closed on an unproven scene)
  const g = await executorFixture(t, { engine: fakeEngine({ stages: { 2: refused } }), companion: fakeCompanion({ linux: { linuxUnitsInactive: false, containersZero: true } }) });
  await g.drop(triggerBytes());
  assert.equal((await g.exec.tick()).state, 'HALTED');
});

test('A: the new code is resident-side only: a failure-table row per stage, never in a Source-mirrored list', () => {
  const mirrored = new Set([...NOT_ADMITTED_CODES, ...TRANSIENT_CODES, ...CLEAN_FINAL_CODES, ...UNKNOWN_CODES]);
  assert.equal(mirrored.has(LINUX_MEMORY_NOT_READY), false);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(s => failureRow({ code: LINUX_MEMORY_NOT_READY, stage: s }).retry),
    ['new-commit', 'new-commit', 'attempt2', 'new-commit', 'new-commit', 'new-commit', 'new-commit', 'new-commit', 'new-commit', 'new-commit']);
  for (const s of [2, 4, 6]) {
    const d = decideFailure({ code: LINUX_MEMORY_NOT_READY, stage: s, proof: CLEAN_PROOF, started: true });
    assert.deepEqual([d.klass, d.row.class, d.row.disposition, d.release], ['CLEAN', 'environment', 'burn', null]);
  }
});

// ---------------- B: "main moved / the subject changed" before the first publication ----------------

const blocked = (code, reason) => ({ ok: false, code, proof: WINDOWS_CLEAN, outcome: { status: 'BLOCKED', reason, sideEffects: 0, mayHavePublished: false } });
// The 2026-10-22 #887 ending (#895 merged while stage 2 ran): the issuer had issued, a callback round's refs read found main moved
// (REFS_MAIN_BASE_CHANGED -> full_admission_subject_changed), it ended UNCERTAIN -> PUBLICATION_UNCERTAIN; its pump was cancelled
// (stage-ended) and answered. DESIGN §27 closes it: FAILED_CLEAN BRIDGE_ABANDONED_UNPUBLISHED.
const uncertainSubjectChanged = { ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN,
  outcome: { status: 'UNCERTAIN', reason: 'full_admission_subject_changed', sideEffects: 1, mayHavePublished: true },
  bridge: { pumpCode: 'COMPANION_PUMP_CANCELLED', stopRequestId: null, stopCode: null, stageCode: 'PUBLICATION_UNCERTAIN', pumpQuiet: true } };
const MOVED = [
  ['stage 1: the PR changed (full_admission_subject_changed)', 1, blocked('PR_NOT_OPEN_OR_CHANGED', 'full_admission_subject_changed'), 'PR_NOT_OPEN_OR_CHANGED'],
  ['stage 1: main moved past the head (protected_change_not_up_to_date)', 1, blocked('PROTECTED_CHANGE_NOT_UP_TO_DATE', 'full_admission_rejected'), 'PROTECTED_CHANGE_NOT_UP_TO_DATE'],
  ['stage 1: the PR files changed between two reads', 1, blocked('STAGE_CHILD_REFUSED', 'pr_subject_changed'), 'STAGE_CHILD_REFUSED'],
  ['stage 2 before its issue: the PR or main moved', 2, blocked('PR_NOT_OPEN_OR_CHANGED', 'full_admission_subject_changed'), 'PR_NOT_OPEN_OR_CHANGED'],
  ['stage 2 before its issue: Native refused the moved subject', 2, blocked('BATCH_CLAIM_CHANGED', 'full_admission_rejected'), 'BATCH_CLAIM_CHANGED'],
  ['stage 2: refs moved since the bundle (the gate, or the worker\'s clean blocked record)', 2, blocked('REMOTE_REFS_CHANGED_SINCE_BUNDLE', 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'), 'REMOTE_REFS_CHANGED_SINCE_BUNDLE'],
  ['stage 2 after its issue: the 10-22 #887 ending (covered by DESIGN §27)', 2, uncertainSubjectChanged, BRIDGE_ABANDONED_UNPUBLISHED],
];

test('B: every "main moved / subject changed" ending before the first publication is FAILED_CLEAN, never a HALT', async t => {
  for (const [name, stage, result, code] of MOVED) {
    const f = await executorFixture(t, { engine: fakeEngine({ stages: { [stage]: result } }) });
    await f.drop(triggerBytes());
    const r = await f.exec.tick();
    assert.deepEqual([r.state, r.failureCode], ['FAILED_CLEAN', code], name);
    assert.equal(await f.ledger.halted(), null, name);
    assert.equal(mayHavePublished({}, await f.ledger.state(KEY)).published, false, name);
  }
  // the bundle: build-bundle.ps1's REMOTE_MAIN_BASE_CHANGED reaches the resident as BUNDLE_UNAVAILABLE: released, nothing burned
  const b = await executorFixture(t, { companion: fakeCompanion({ bundle: { ok: false, code: 'BUNDLE_UNAVAILABLE' } }) });
  await b.drop(triggerBytes());
  const rb = await b.exec.tick();
  assert.deepEqual([rb.state, rb.failureCode, await b.ledger.halted(), await b.ledger.headBurned(headKey(subject()))], ['NOT_EXECUTED', 'BUNDLE_UNAVAILABLE', null, false]);
  // the workspace: prepare-workspaces.py refusing (also its REMOTE_MAIN_BASE_CHANGED) reaches it as WORKSPACE_PREPARATION_REFUSED
  const w = await executorFixture(t, { companion: fakeCompanion({ wsprep: { ok: false, code: 'WORKSPACE_PREPARATION_REFUSED', proof: {} } }) });
  await w.drop(triggerBytes());
  const rw = await w.exec.tick();
  assert.deepEqual([rw.state, rw.failureCode, await w.ledger.halted()], ['FAILED_CLEAN', 'WORKSPACE_PREPARATION_REFUSED', null]);
});

test('B: the same endings after the first publication are decided as before', async t => {
  // a publisher stage's UNCERTAIN may be a publication: HALT, never closed on the scanner abandonment
  const f = await executorFixture(t, { engine: fakeEngine({ stages: { 3: { ...uncertainSubjectChanged, bridge: undefined } } }) });
  await f.drop(triggerBytes());
  const r = await f.exec.tick();
  assert.deepEqual([r.state, r.failureCode], ['HALTED', 'PUBLICATION_UNCERTAIN']);
  // the clean ones stay clean and final; at stages 4 and 6 the scanner abandonment closes the UNCERTAIN as DESIGN §27 does (new commit)
  for (const [stage, result, state, code] of [[3, blocked('BATCH_CLAIM_CHANGED', 'full_admission_rejected'), 'FAILED_CLEAN', 'BATCH_CLAIM_CHANGED'],
    [5, blocked('PR_NOT_OPEN_OR_CHANGED', 'full_admission_subject_changed'), 'FAILED_CLEAN', 'PR_NOT_OPEN_OR_CHANGED'],
    [4, uncertainSubjectChanged, 'FAILED_CLEAN', BRIDGE_ABANDONED_UNPUBLISHED]]) {
    const g = await executorFixture(t, { engine: fakeEngine({ stages: { [stage]: result } }) });
    await g.drop(triggerBytes());
    const rr = await g.exec.tick();
    assert.deepEqual([rr.state, rr.failureCode, rr.attempt2], [state, code, undefined], String(stage));
    assert.equal(mayHavePublished({}, await g.ledger.state(KEY)).published, true, String(stage));
  }
});
