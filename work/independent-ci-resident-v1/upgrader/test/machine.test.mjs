import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../src/canonical.mjs';
import { decide } from '../src/machine.mjs';
import { U } from '../src/codes.mjs';
import { RECEIPT_SLOT } from '../src/plan.mjs';
import { T0, journalOnly, treeDigest } from './fixtures.mjs';
import { crashPlan, loadJournal, makeEnv, makePackages, openOp, readJson, runOp } from './harness.mjs';

const MIN = 60_000, HOUR = 3_600_000;
const steps = j => j.steps.map(s => `${s.seq}:${s.step}:${s.result ? (s.result.ok ? 'ok' : s.result.code) : 'open'}`);
const managed = env => treeDigest(env.root, { exclude: journalOnly });
// Everything outside the operation's own directory and the status view: what "no side effect" compares.
const outside = env => treeDigest(env.root, { exclude: rel => rel.startsWith('upgrade/ops/') || rel === 'upgrade/status.json' });
const live = (env, slot) => fs.readFile(path.join(env.root, ...slot.split('\\')));

test('N -> N+1: every step in order, generation 2 live, generation 1 kept, the node resumed', async t => {
  const env = await makeEnv(t);
  const before = await readJson(path.join(env.root, 'upgrade', 'current.json'));
  const op = await openOp(env, 'n2');
  const { terminal } = await runOp(env, op);
  assert.equal(terminal.outcome, 'SUCCEEDED');
  assert.equal(terminal.generation, 2);
  const j = await loadJournal(env, op);
  assert.deepEqual(j.steps.map(s => s.step), ['accept', 'grant', 'hold', 'drain', 'pause', 'stage-windows', 'stage-linux', 'stop', 'switch-linux', 'switch-windows',
    'start', 'verify', 'resume', 'retention']);
  assert.ok(j.steps.every(s => s.result.ok && s.result.replayed === false));
  const current = await readJson(path.join(env.root, 'upgrade', 'current.json'));
  assert.equal(current.generation, 2);
  assert.equal(current.packageManifestSha256, env.pkgs.n2.sha);
  assert.equal(current.opId, op);
  assert.deepEqual(await readJson(path.join(env.root, 'generations', 'g1', 'current.json')), before);
  assert.deepEqual(await live(env, 'config\\policy.json'), env.pkgs.n2.files.get('config/policy.json'));
  assert.deepEqual(await fs.readFile(path.join(env.root, 'generations', 'g1', 'config', 'policy.json')), env.pkgs.n1.files.get('config/policy.json'));
  // Both resident directories side by side.
  await fs.access(path.join(env.root, 'resident', env.pkgs.n1.residentSha, 'src', 'service-main.mjs'));
  await fs.access(path.join(env.root, 'resident', env.pkgs.n2.residentSha, 'src', 'service-main.mjs'));
  const receipt = JSON.parse(await live(env, RECEIPT_SLOT));
  assert.equal(receipt.contract, 'clued.independent-ci.resident-install-receipt/6');
  assert.equal(receipt.writtenBy, 'CluedCIUpgrader');
  assert.equal(receipt.inheritedFrom, before.installReceiptSha256);
  assert.equal(receipt.upgrade.opId, op);
  assert.deepEqual(receipt.upgrader, { service: 'CluedCIUpgrader', manifestSha256: 'c3'.repeat(32) }, 'the upgrader block is inherited unchanged');
  assert.equal(current.installReceiptSha256, sha256(await live(env, RECEIPT_SLOT)));
  const rec = await readJson(path.join(env.root, 'generations', 'g2', 'generation.json'));
  assert.equal(rec.generation, 2);
  const scm = await readJson(path.join(env.root, 'fake-scm.json'));
  assert.equal(scm.resident.binPath, rec.residentBinPath);
  assert.equal((await readJson(path.join(env.root, 'fake-linux.json'))).generation, 2);
  // Paused for the switch by this operation's own request, resumed by upgrade-resume; the intake hold lifted.
  assert.equal(env.resident.paused, null);
  assert.equal(env.resident.owner.length, 1);
  assert.equal(env.resident.owner[0].generation, 2);
  assert.deepEqual([...env.resident.holds], []);
  assert.ok(env.resident.receipts.some(r => r.type === 'service-start' && r.body.policySha256 === env.pkgs.n2.policySha));
});

// The uninterrupted run's result, as the crash runs compare it: every file but the journal's own records, plus the fakes.
async function outcomeOf(env, op) {
  const j = await loadJournal(env, op);
  return { tree: await managed(env), resident: env.resident.snapshot(), clock: env.clock.now, terminal: j.terminal, steps: j.steps.map(s => `${s.seq}:${s.step}:${s.result.ok}:${s.result.code}`) };
}

async function crashSweep(t, setup, { pool = 6 } = {}) {
  const base = await setup(t);
  const counter = crashPlan(0);
  await runOp(base.env, base.op, { crash: counter });
  const reference = await outcomeOf(base.env, base.op);
  const total = counter.n;
  assert.ok(total > 30, `durable writes counted: ${total}`);
  const failures = [];
  let next = 1;
  const worker = async () => {
    for (let at = next++; at <= total; at = next++) {
      const run = await setup(t);
      const r = await runOp(run.env, run.op, { crash: crashPlan(at) });
      assert.equal(r.crashes, 1, `crash ${at} was injected`);
      const got = await outcomeOf(run.env, run.op);
      try { assert.deepEqual(got, reference); } catch (error) { failures.push({ at, label: counter.log[at - 1], message: error.message.slice(0, 800) }); }
      await fs.rm(run.env.root, { recursive: true, force: true });
    }
  };
  await Promise.all(Array.from({ length: pool }, worker));
  assert.deepEqual(failures, [], 'every crash point resumes to the same bytes');
  return { total, reference };
}

test('a crash after every durable write (intent written, result not; each rename) resumes to the same bytes as an uninterrupted run', async t => {
  const shared = await makePackages(t);
  const { total, reference } = await crashSweep(t, async t2 => { const env = await makeEnv(t2, { shared }); return { env, op: await openOp(env, 'n2') }; });
  assert.equal(reference.terminal.outcome, 'SUCCEEDED');
  t.diagnostic(`crash points: ${total}`);
});

test('the same on the way back: verify fails, the rollback is crashed at every write and still ends ROLLED_BACK_PAUSED byte for byte', async t => {
  const shared = await makePackages(t);
  const { reference } = await crashSweep(t, async t2 => {
    const env = await makeEnv(t2, { shared, windowsOptions: { failVerify: g => g === 2 } });
    return { env, op: await openOp(env, 'n2') };
  });
  assert.equal(reference.terminal.outcome, 'ROLLED_BACK_PAUSED');
  assert.equal(reference.terminal.code, U.VERIFY_FAILED);
});

test('a resumed step whose objects are already as planned is recorded as replayed; one in a foreign state is JOURNAL_INCONSISTENT', async t => {
  const env = await makeEnv(t);
  const op = await openOp(env, 'n2');
  const counter = crashPlan(0);
  await runOp(env, op, { crash: counter });
  // Crash on the last write of switch-windows (current.json), just before its result.
  const env2 = await makeEnv(t);
  const op2 = await openOp(env2, 'n2');
  await runOp(env2, op2, { crash: crashPlan(counter.log.indexOf('result:85')) });
  const sw = (await loadJournal(env2, op2)).steps.find(s => s.step === 'switch-windows');
  assert.equal(sw.result.replayed, true);
  assert.equal(sw.result.ok, true);
  // Crash right after its intent, and a live slot gets bytes of neither generation before the restart.
  const env3 = await makeEnv(t);
  const op3 = await openOp(env3, 'n2');
  const r3 = await runOp(env3, op3, { crash: crashPlan(counter.log.indexOf('intent:85') + 1),
    onCrash: () => fs.writeFile(path.join(env3.root, 'config', 'companion.json'), 'foreign') });
  assert.equal(r3.terminal.outcome, 'ROLLBACK_FAILED');
  assert.equal(r3.terminal.code, U.JOURNAL_INCONSISTENT);
  const j3 = await loadJournal(env3, op3);
  assert.equal(j3.steps.find(s => s.step === 'switch-windows').result.code, U.JOURNAL_INCONSISTENT);
  assert.equal(await fs.readFile(path.join(env3.root, 'config', 'companion.json'), 'utf8'), 'foreign', 'nothing overwritten');
});

test('white list: every class of change outside it is refused at ACCEPT with no side effect', async t => {
  const cases = [
    ['target outside', { mutate: m => m.files.push({ path: 'config/policy.json', target: 'helpers\\extra.exe', sha256: m.files.find(f => f.path === 'config/policy.json').sha256 }) }, U.TARGET_OUTSIDE_WHITELIST],
    ['state dir', { mutate: m => m.files.push({ path: 'config/policy.json', target: 'state\\PAUSED.json', sha256: m.files.find(f => f.path === 'config/policy.json').sha256 }) }, U.TARGET_OUTSIDE_WHITELIST],
    ['compiled binary from the package', { mutate: m => m.files.push({ path: 'runtime/node.exe', target: 'bin\\SwapBroker.exe', sha256: m.files.find(f => f.path === 'runtime/node.exe').sha256 }) }, U.TARGET_OUTSIDE_WHITELIST],
    ['upgrader files', { mutate: m => m.files.push({ path: 'runtime/node.exe', target: 'upgrader\\runtime\\node.exe', sha256: m.files.find(f => f.path === 'runtime/node.exe').sha256 }) }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['secrets', { mutate: m => m.files.push({ path: 'runtime/node.exe', target: 'secrets\\resident-upgrade.token', sha256: m.files.find(f => f.path === 'runtime/node.exe').sha256 }) }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['another upgrader', { upgrader: { manifestSha256: 'ee'.repeat(32), files: [] } }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['layout', { windowsLayout: 'clued.independent-ci.resident-layout/2' }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['node identity', { nodeIdentitySha256: 'ff'.repeat(32) }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['node profile', { nodeProfileSha256: 'fe'.repeat(32) }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['owner account', { ownerSid: 'S-1-5-21-9-9-9-9' }, U.CHANNEL_CHANGE_NEEDS_REINSTALL],
    ['state not readable back', { stateCompat: { schema: 2, readableBySchemas: [1, 2] } }, U.STATE_COMPAT_REFUSED],
    ['state not readable forward', { stateCompat: { schema: 1, readableBySchemas: [2] } }, U.STATE_COMPAT_REFUSED],
    ['missing slot', { mutate: m => { m.files = m.files.filter(f => f.target !== 'record\\signers.json'); } }, U.PACKAGE_CONTRACT_REFUSED],
    ['other acceptance', { decisionRef: '11111111-2222-4333-8444-555555555555' }, U.REQUEST_REFUSED],
  ];
  for (const [name, options, code] of cases) {
    const env = await makeEnv(t, { packageOptions: { n2: options } });
    const op = await openOp(env, 'n2');
    const before = await outside(env);
    const { terminal } = await runOp(env, op);
    assert.equal(terminal.outcome, 'REFUSED', name);
    assert.equal(terminal.code, code, name);
    assert.deepEqual(await outside(env), before, `${name}: nothing but the journal changed`);
    assert.equal(env.door.calls, 0, `${name}: no Grant is asked for`);
  }
  // Same as current, wrong node, a package changed after the request, and a package file changed.
  const env = await makeEnv(t, { packages: ['n2'] });
  const same = await openOp(env, 'n1');
  assert.equal((await runOp(env, same)).terminal.code, U.SAME_AS_CURRENT);
  const env2 = await makeEnv(t);
  const wrongNode = await openOp(env2, 'n2', { node: 'other-node' });
  assert.equal((await runOp(env2, wrongNode)).terminal.code, U.NODE_MISMATCH);
  const env3 = await makeEnv(t);
  await fs.appendFile(path.join(env3.pkgs.n2.dir, 'config', 'companion.json'), ' ');
  const changed = await openOp(env3, 'n2');
  assert.equal((await runOp(env3, changed)).terminal.code, U.PACKAGE_CHANGED);
});

test('Grant: rejected, expired, revoked, binding not authorized, door unavailable for 24 h; a replayed op_id is the same use', async t => {
  for (const [opts, outcome, code] of [[{ reject: true }, 'GRANT_REJECTED', U.GRANT_REJECTED], [{ expire: true }, 'GRANT_EXPIRED', U.GRANT_EXPIRED],
    [{ revoked: true }, 'REFUSED', U.GRANT_REVOKED], [{ notAuthorized: true }, 'REFUSED', U.GRANT_BINDING_NOT_AUTHORIZED],
    [{ unavailableUntil: T0 + 30 * HOUR }, 'REFUSED', U.GRANT_DOOR_UNAVAILABLE]]) {
    const env = await makeEnv(t, { doorOptions: opts });
    const op = await openOp(env, 'n2');
    const before = await outside(env);
    const { terminal } = await runOp(env, op);
    assert.equal(terminal.outcome, outcome);
    assert.equal(terminal.code, code);
    assert.deepEqual(await outside(env), before);
    assert.equal(env.resident.holdRequests, 0);
  }
  // Pending for 3 hours (the Owner has not clicked yet), then approved: polled at 30 s for 10 minutes, then at 120 s.
  const env = await makeEnv(t, { doorOptions: { approveAt: T0 + 3 * HOUR } });
  const op = await openOp(env, 'n2');
  const { terminal } = await runOp(env, op);
  assert.equal(terminal.outcome, 'SUCCEEDED');
  assert.ok(env.door.calls > 20 && env.door.calls < 20 + 10 + 3 * 30 + 5, `polls: ${env.door.calls}`);
  // Door down for an hour: transient, then consumed.
  const env2 = await makeEnv(t, { doorOptions: { unavailableUntil: T0 + HOUR } });
  const op2 = await openOp(env2, 'n2');
  assert.equal((await runOp(env2, op2)).terminal.outcome, 'SUCCEEDED');
  // The grant step crashed after the door consumed: the redo replays the same use.
  const env3 = await makeEnv(t);
  const op3 = await openOp(env3, 'n2');
  let crashed = false;
  const crash = { n: 0, tick() {} };
  const realConsume = env3.door.consume.bind(env3.door);
  env3.door.consume = async a => { const r = await realConsume(a); if (!crashed) { crashed = true; throw Object.assign(new Error('x'), { injected: true }); } return r; };
  await runOp(env3, op3, { crash });
  const j3 = await loadJournal(env3, op3);
  assert.equal(j3.steps.find(s => s.step === 'grant').result.detail.replayed, true);
  assert.equal(j3.terminal.outcome, 'SUCCEEDED');
});

test('DRAIN: batches that do not end defer with no lasting side effect, retry every 60 minutes, and go stale 24 h after the Grant', async t => {
  let batches = 1;
  const env = await makeEnv(t, { residentOptions: { openBatches: () => batches } });
  const op = await openOp(env, 'n2');
  const before = await outside(env);
  let sawDeferred = false;
  await assert.rejects(runOp(env, op, { maxMoves: 400, onMove: async (m) => {
    const j = await loadJournal(env, op);
    const d = j.steps.find(s => s.step === 'drain' && s.result);
    if (d && !sawDeferred) {
      sawDeferred = true;
      assert.equal(d.result.code, U.DRAIN_TIMEOUT);
      assert.equal(Date.parse(d.result.at) - Date.parse(d.intent.at), 120 * MIN);
      assert.deepEqual(await outside(env), before, 'only the journal and the status differ');
      assert.deepEqual([...env.resident.holds], [], 'the intake hold is lifted');
      assert.equal(m.view.state, undefined);
      throw new Error('stop here');
    }
  } }), /stop here/);
  // Batches end during the third try: it goes on.
  batches = 1;
  const env2 = await makeEnv(t, { residentOptions: { openBatches: now => (now < T0 + 6 * HOUR ? 1 : 0) } });
  const op2 = await openOp(env2, 'n2');
  const r2 = await runOp(env2, op2);
  assert.equal(r2.terminal.outcome, 'SUCCEEDED');
  const drains = (await loadJournal(env2, op2)).steps.filter(s => s.step === 'drain');
  assert.deepEqual(drains.map(s => s.seq), [40, 41, 42]);
  assert.equal(Date.parse(drains[1].intent.at) - Date.parse(drains[0].result.at), 60 * MIN);
  // Never: STALE, at most 24 h after the Grant, nothing left behind.
  const env3 = await makeEnv(t, { residentOptions: { openBatches: () => 2 } });
  const op3 = await openOp(env3, 'n2');
  const before3 = await outside(env3);
  const r3 = await runOp(env3, op3);
  assert.equal(r3.terminal.outcome, 'STALE');
  assert.equal(r3.terminal.code, U.GRANT_STALE);
  assert.ok(env3.clock.now - T0 <= 24 * HOUR + MIN);
  assert.deepEqual(await outside(env3), before3);
  assert.deepEqual([...env3.resident.holds], []);
});

test('HALT when the request comes: deferred (RESIDENT_HALTED) until re-armed, then upgraded', async t => {
  const env = await makeEnv(t);
  env.resident.isHalted = true;
  const op = await openOp(env, 'n2');
  let rearmed = false;
  const r = await runOp(env, op, { onMove: async (m, mv) => {
    if (!rearmed && env.clock.now >= T0 + 2 * HOUR) { rearmed = true; env.resident.isHalted = false; }
    if (env.resident.isHalted && mv.wait > 0 && (await loadJournal(env, op)).steps.some(s => s.step === 'grant' && s.result)) {
      assert.equal(m.view.code, U.RESIDENT_HALTED);
      assert.equal(m.view.state, 'DEFERRED');
      assert.equal(env.resident.holdRequests, 0, 'no hold, no drain while halted');
    }
  } });
  assert.equal(r.terminal.outcome, 'SUCCEEDED');
  assert.ok(env.clock.now >= T0 + 2 * HOUR);
});

test('pause confirmation on a fake clock: at 419 s it counts; a pause never taken is PAUSE_UNCONFIRMED at the limit (>= 420 s), withdrawn and retried', async t => {
  const env = await makeEnv(t, { residentOptions: { pauseDelayMs: 419_000 }, configOver: { timeouts: { drainMaxMinutes: 120, drainRetryMinutes: 60, deferMaxHours: 24, pauseConfirmMs: 420_000, verifyMaxMs: 2_700_000, grantPollMs: [30_000, 120_000] } } });
  const op = await openOp(env, 'n2');
  assert.equal((await runOp(env, op)).terminal.outcome, 'SUCCEEDED');
  const p = (await loadJournal(env, op)).steps.find(s => s.step === 'pause');
  assert.equal(p.result.detail.via, 'paused');
  assert.ok(Date.parse(p.result.at) - Date.parse(p.intent.at) >= 419_000);

  const env2 = await makeEnv(t, { residentOptions: { processes: false }, configOver: { timeouts: { drainMaxMinutes: 120, drainRetryMinutes: 60, deferMaxHours: 24, pauseConfirmMs: 420_000, verifyMaxMs: 2_700_000, grantPollMs: [30_000, 120_000] } } });
  const op2 = await openOp(env2, 'n2');
  let unpause = false;
  const r2 = await runOp(env2, op2, { onMove: async () => {
    const j = await loadJournal(env2, op2);
    const first = j.steps.find(s => s.step === 'pause' && s.result);
    if (first && !unpause) {
      unpause = true;
      assert.equal(first.result.code, U.PAUSE_UNCONFIRMED);
      assert.ok(Date.parse(first.result.at) - Date.parse(first.intent.at) >= 420_000);
      assert.equal(env2.resident.pending.size, 0, 'the request was withdrawn');
      await fs.access(path.join(env2.root, 'upgrade', 'ops', op2, '050-pause.withdrawn.json'));
      assert.deepEqual([...env2.resident.holds], []);
      env2.resident.processes = true;
    }
  } });
  assert.equal(r2.terminal.outcome, 'SUCCEEDED');
  const j2 = await loadJournal(env2, op2);
  assert.deepEqual(j2.steps.filter(s => s.step === 'pause').map(s => s.seq), [50, 51]);
  assert.deepEqual(j2.steps.filter(s => s.step === 'drain').map(s => s.seq), [40, 41]);
});

test('service stopped and the request still pending counts as paused; the new service then pauses itself and is resumed', async t => {
  const env = await makeEnv(t, { residentOptions: { pauseDelayMs: 1_000 } });
  env.resident.running = false;
  const scm = await readJson(path.join(env.root, 'fake-scm.json'));
  scm.resident.state = 'stopped';
  await fs.writeFile(path.join(env.root, 'fake-scm.json'), JSON.stringify(scm));
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op);
  assert.equal(r.terminal.outcome, 'SUCCEEDED');
  const j = await loadJournal(env, op);
  assert.equal(j.steps.find(s => s.step === 'pause').result.detail.via, 'stopped-pending');
  assert.equal(env.resident.paused, null);
  assert.equal(env.resident.owner.length, 1, 'the pause the new service took from the request was lifted by upgrade-resume');
});

test('paused by someone else: the upgrade runs, the node stays paused (SUCCEEDED_STILL_PAUSED)', async t => {
  const env = await makeEnv(t);
  env.resident.paused = { sha256: 'aa'.repeat(32), requestSha256: 'bb'.repeat(32) };
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op);
  assert.equal(r.terminal.outcome, 'SUCCEEDED_STILL_PAUSED');
  assert.deepEqual(env.resident.paused, { sha256: 'aa'.repeat(32), requestSha256: 'bb'.repeat(32) });
  assert.deepEqual(env.resident.owner, []);
  assert.equal((await readJson(path.join(env.root, 'upgrade', 'current.json'))).generation, 2);
});

test('verify fails: rolled back to generation 1 byte for byte, kept paused; the rollback failing as well ends ROLLBACK_FAILED', async t => {
  const env = await makeEnv(t, { windowsOptions: { failVerify: g => g === 2 } });
  const before = await managed(env);
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op);
  assert.equal(r.terminal.outcome, 'ROLLED_BACK_PAUSED');
  assert.equal(r.terminal.code, U.VERIFY_FAILED);
  assert.equal(r.terminal.generation, 1);
  const after = await managed(env);
  for (const slot of ['config/policy.json', 'config/companion.json', 'bin/SwapBroker.exe', 'runtime/node.exe', 'install/install-receipt.json', 'upgrade/current.json']) {
    assert.equal(after[slot], before[slot], slot);
  }
  assert.equal((await readJson(path.join(env.root, 'fake-linux.json'))).generation, 1);
  assert.equal((await readJson(path.join(env.root, 'fake-scm.json'))).resident.binPath, 'g1-resident');
  assert.ok(env.resident.paused, 'still paused');
  assert.deepEqual(env.resident.owner, [], 'no resume');
  assert.deepEqual([...env.resident.holds], []);
  const j = await loadJournal(env, op);
  assert.deepEqual(j.steps.slice(-6).map(s => s.step), ['rollback-stop', 'rollback-switch-windows', 'rollback-switch-linux', 'rollback-start', 'rollback-verify', 'keep-paused-notify']);
  // N+1's files are kept for the Owner to look at, and generation number 2 is free again.
  await fs.access(path.join(env.root, 'archive', 'g2-rolled-back-5e1f0000', 'config', 'policy.json'));
  assert.deepEqual(await fs.readdir(path.join(env.root, 'generations')), ['g1']);

  const env2 = await makeEnv(t, { windowsOptions: { failVerify: g => g === 2 }, linuxOptions: { failRollback: true } });
  const op2 = await openOp(env2, 'n2');
  const r2 = await runOp(env2, op2);
  assert.equal(r2.terminal.outcome, 'ROLLBACK_FAILED');
  assert.equal(r2.terminal.code, U.ROLLBACK_FAILED);
  assert.ok(env2.resident.paused);
});

test('a Linux switch refused for quiescence is aborted: services back on N, the node resumed, outcome REFUSED', async t => {
  const env = await makeEnv(t, { linuxOptions: { failSwitch: U.LINUX_QUIESCENCE_UNCONFIRMED } });
  const before = await managed(env);
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op);
  assert.equal(r.terminal.outcome, 'REFUSED');
  assert.equal(r.terminal.code, U.LINUX_QUIESCENCE_UNCONFIRMED);
  const after = await managed(env);
  for (const k of Object.keys(before).filter(k => !k.startsWith('upgrade/') && k !== 'fake-scm.json' && k !== 'fake-linux.json')) assert.equal(after[k], before[k], k);
  assert.equal(env.resident.paused, null);
  assert.equal(env.resident.running, true);
  await fs.access(path.join(env.root, 'upgrade', 'ops', op, 'staged-withdrawn', 'package-manifest.json'));
  assert.ok(!(await fs.access(path.join(env.root, 'upgrade', 'staged', env.pkgs.n2.sha)).then(() => true, () => false)));
});

test('the companion missing before the switch defers; a refused Linux stage aborts', async t => {
  let down = true;
  const env = await makeEnv(t, { linuxOptions: { unavailable: k => k === 'stage' && down } });
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op, { onMove: async () => {
    const j = await loadJournal(env, op);
    if (down && j.steps.some(s => s.step === 'stage-linux' && s.result?.code === U.COMPANION_UNAVAILABLE)) {
      assert.equal(env.resident.paused, null, 'resumed while deferred');
      down = false;
    }
  } });
  assert.equal(r.terminal.outcome, 'SUCCEEDED');
  const j = await loadJournal(env, op);
  assert.deepEqual(j.steps.filter(s => s.step.startsWith('stage')).map(s => `${s.seq}:${s.result.ok}`), ['60:true', '61:true', '65:false', '66:true']);

  const env2 = await makeEnv(t, { linuxOptions: { failStage: U.LINUX_STAGE_REFUSED } });
  const op2 = await openOp(env2, 'n2');
  const r2 = await runOp(env2, op2);
  assert.equal(r2.terminal.outcome, 'REFUSED');
  assert.equal(r2.terminal.code, U.LINUX_STAGE_REFUSED);
  assert.equal(env2.resident.paused, null);
  assert.deepEqual([...env2.resident.holds], []);
});

test('retention: the fourth generation moves generation 1 into archive\\ whole, nothing is deleted', async t => {
  const env = await makeEnv(t, { packages: ['n2', 'n3', 'n4'] });
  for (const tag of ['n2', 'n3', 'n4']) {
    const op = await openOp(env, tag);
    assert.equal((await runOp(env, op)).terminal.outcome, 'SUCCEEDED', tag);
  }
  assert.deepEqual((await fs.readdir(path.join(env.root, 'generations'))).sort(), ['g2', 'g3', 'g4']);
  assert.deepEqual(await fs.readdir(path.join(env.root, 'archive')), ['g1']);
  assert.deepEqual(await fs.readFile(path.join(env.root, 'archive', 'g1', 'config', 'policy.json')), env.pkgs.n1.files.get('config/policy.json'));
  await fs.access(path.join(env.root, 'archive', 'g1', 'generation.json'));
  await fs.access(path.join(env.root, 'resident', env.pkgs.n1.residentSha)); // content-addressed directories stay
});

test('cancel: only before STAGE; it withdraws the pause and the hold', async t => {
  const env = await makeEnv(t, { residentOptions: { openBatches: now => (now < T0 + HOUR ? 1 : 0) } });
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op, { onMove: async () => {
    const j = await loadJournal(env, op);
    if (j.steps.some(s => s.step === 'drain') && !j.cancel) await fs.writeFile(path.join(env.root, 'upgrade', 'ops', op, '001-cancel.json'), '{"cancel":true}');
  } });
  assert.equal(r.terminal.outcome, 'CANCELLED');
  assert.deepEqual([...env.resident.holds], []);
  assert.equal((await readJson(path.join(env.root, 'upgrade', 'current.json'))).generation, 1);
  // After STAGE a cancel file is ignored by the machine (the inbox refuses to write one, see upgrader-main.test).
  const env2 = await makeEnv(t);
  const op2 = await openOp(env2, 'n2');
  const r2 = await runOp(env2, op2, { onMove: async () => {
    const j = await loadJournal(env2, op2);
    if (j.steps.some(s => s.step === 'stage-windows') && !j.cancel) await fs.writeFile(path.join(env2.root, 'upgrade', 'ops', op2, '001-cancel.json'), '{"cancel":true}');
  } });
  assert.equal(r2.terminal.outcome, 'SUCCEEDED');
});

test('decide() is pure: the same journal and facts give the same answer', () => {
  const j = { terminal: null, cancel: null, steps: [], request: {}, plan: null };
  const t = { deferMaxHours: 24, drainRetryMinutes: 60 };
  assert.deepEqual(decide(j, { now: T0, halted: false }, t), decide(j, { now: T0, halted: true }, t));
  assert.equal(decide(j, { now: T0, halted: false }, t).step, 'accept');
});

// ---- review of PR-1 ----

test('B1: a rollback where N+1 had a slot with N\'s very bytes leaves no copy in g<N>; the next upgrade (another slot set) goes through', async t => {
  // n2 keeps runtime\node.exe byte for byte (v1), n3 changes it (v2).
  const env = await makeEnv(t, { packages: ['n2', 'n3'], windowsOptions: { failVerify: g => g === 2 && env.failNext } });
  env.failNext = true;
  const op = await openOp(env, 'n2');
  assert.equal((await runOp(env, op)).terminal.outcome, 'ROLLED_BACK_PAUSED');
  const g1 = await treeDigest(path.join(env.root, 'generations', 'g1'));
  assert.deepEqual(Object.keys(g1).filter(k => !k.endsWith('/')), ['generation.json'], 'g1 holds no file but its record');
  await fs.access(path.join(env.root, 'archive', 'g2-rolled-back-5e1f0000', 'runtime', 'node.exe'));
  env.failNext = false;
  env.resident.paused = null; // the Owner resumed
  const op3 = await openOp(env, 'n3');
  const r = await runOp(env, op3);
  assert.equal(r.terminal.outcome, 'SUCCEEDED');
  assert.deepEqual(await live(env, 'runtime\\node.exe'), env.pkgs.n3.files.get('runtime/node.exe'));
  assert.deepEqual(await fs.readFile(path.join(env.root, 'generations', 'g1', 'runtime', 'node.exe')), env.pkgs.n1.files.get('runtime/node.exe'));
});

test('M1: a Linux switch refused for quiescence still runs rollback-switch-linux, then resumes (REFUSED)', async t => {
  const env = await makeEnv(t, { linuxOptions: { failSwitch: U.LINUX_QUIESCENCE_UNCONFIRMED } });
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op);
  assert.deepEqual([r.terminal.outcome, r.terminal.code], ['REFUSED', U.LINUX_QUIESCENCE_UNCONFIRMED]);
  const j = await loadJournal(env, op);
  // Journal order is by number: resume (110) sorts before the rollback steps (200..230) it follows.
  assert.deepEqual(j.steps.filter(s => s.seq >= 110).map(s => s.step), ['resume', 'rollback-stop', 'rollback-switch-windows', 'rollback-switch-linux', 'rollback-start', 'rollback-verify']);
  assert.ok(Date.parse(j.steps.find(s => s.step === 'resume').intent.at) >= Date.parse(j.steps.find(s => s.step === 'rollback-verify').result.at));
  assert.equal(env.resident.paused, null);
});

test('M4: the companion away during a rollback is a bounded wait, then ROLLBACK_COMPANION_UNAVAILABLE; back in time, the rollback ends normally', async t => {
  let down = true;
  const env = await makeEnv(t, { windowsOptions: { failVerify: g => g === 2, companionDown: () => down } });
  // Away for the first two hours of the rollback only.
  const op = await openOp(env, 'n2');
  let rollbackAt = null;
  const r = await runOp(env, op, { onMove: async m => {
    if (rollbackAt === null && m.view.code === U.ROLLBACK_COMPANION_UNAVAILABLE) { rollbackAt = env.clock.now; assert.equal(m.view.state, 'ROLLING_BACK'); }
    if (rollbackAt !== null && env.clock.now - rollbackAt >= 2 * HOUR) down = false;
  } });
  assert.equal(r.terminal.outcome, 'ROLLED_BACK_PAUSED');
  assert.ok(rollbackAt !== null);
  // Away for good: ends after the bound with its own code; the node stays stopped and paused.
  const env2 = await makeEnv(t, { windowsOptions: { failVerify: g => g === 2, companionDown: () => env2.resident.receipts.length > 0 } });
  const op2 = await openOp(env2, 'n2');
  const r2 = await runOp(env2, op2);
  assert.deepEqual([r2.terminal.outcome, r2.terminal.code], ['ROLLBACK_FAILED', U.ROLLBACK_COMPANION_UNAVAILABLE]);
  const j2 = await loadJournal(env2, op2);
  const step = j2.steps.find(s => s.step === 'rollback-switch-windows');
  assert.ok(Date.parse(step.result.at) - Date.parse(step.intent.at) >= 24 * HOUR);
  assert.ok(env2.resident.paused);
  // The Linux half away during its rollback: the same bounded wait.
  let linuxDown = true;
  const env3 = await makeEnv(t, { windowsOptions: { failVerify: g => g === 2 }, linuxOptions: { unavailable: k => k === 'rollback' && linuxDown } });
  const op3 = await openOp(env3, 'n2');
  const r3 = await runOp(env3, op3, { onMove: async m => { if (m.view.code === U.ROLLBACK_COMPANION_UNAVAILABLE && env3.clock.now > T0 + 3 * HOUR) linuxDown = false; } });
  assert.equal(r3.terminal.outcome, 'ROLLED_BACK_PAUSED');
});

test('m1: a HALT while the pause is being confirmed defers (RESIDENT_HALTED), the pause request withdrawn, and the next cycle goes on', async t => {
  const env = await makeEnv(t, { residentOptions: { pauseDelayMs: 120_000 } });
  const op = await openOp(env, 'n2');
  let halted = false;
  const r = await runOp(env, op, { onMove: async () => {
    const j = await loadJournal(env, op);
    if (!halted && j.steps.some(s => s.step === 'pause' && s.result === null)) { halted = true; env.resident.isHalted = true; }
    if (halted && env.resident.isHalted && j.steps.some(s => s.step === 'pause' && s.result?.code === U.RESIDENT_HALTED)) {
      assert.equal(env.resident.pending.size, 0);
      assert.deepEqual([...env.resident.holds], []);
      env.resident.isHalted = false; // re-armed
    }
  } });
  assert.equal(r.terminal.outcome, 'SUCCEEDED');
  const j = await loadJournal(env, op);
  assert.deepEqual(j.steps.filter(s => s.step === 'pause').map(s => `${s.seq}:${s.result.code}`), [`50:${U.RESIDENT_HALTED}`, '51:null']);
});

test('m2: the 24 h bound counts from the consumption (the door\'s time, else the grant step\'s intent for a replayed use)', async t => {
  const env = await makeEnv(t, { residentOptions: { openBatches: () => 1 }, doorOptions: { approveAt: T0 } });
  const real = env.door.consume.bind(env.door);
  env.door.consume = async a => { const r = await real(a); if (r.kind === 'consumed') r.grant = { ...r.grant, consumedAt: new Date(T0 - 20 * HOUR).toISOString() }; return r; };
  const op = await openOp(env, 'n2');
  const r = await runOp(env, op);
  assert.equal(r.terminal.outcome, 'STALE');
  assert.ok(env.clock.now - T0 <= 4 * HOUR + MIN, 'stale 24 h after the door\'s consumption, not after the result was written');
  const j = await loadJournal(env, op);
  assert.equal(j.steps.find(s => s.step === 'grant').result.detail.consumedAt, new Date(T0 - 20 * HOUR).toISOString());
});

test('m4 and m6: the receipt\'s Linux qualifications come from the stage result; RETENTION asks the Linux half to retain as well', async t => {
  const env = await makeEnv(t);
  const op = await openOp(env, 'n2');
  assert.equal((await runOp(env, op)).terminal.outcome, 'SUCCEEDED');
  const receipt = JSON.parse(await live(env, RECEIPT_SLOT));
  assert.deepEqual(Object.keys(receipt.linux.qualificationsSha256).sort(), ['contract-placement', 'gitleaks', 'trivy']);
  assert.equal(receipt.linux.qualificationsSha256.gitleaks, sha256(`qualification gitleaks 0 ${env.pkgs.n2.sha}`));
  assert.deepEqual(env.linux.retained, [2]);
  assert.equal((await loadJournal(env, op)).steps.find(s => s.step === 'retention').result.detail.linuxRetain, 'ok');
});

test('retry numbers used up end with UPGRADE_RETRIES_EXHAUSTED (not GRANT_STALE)', async t => {
  const env = await makeEnv(t, { residentOptions: { openBatches: () => 1 },
    configOver: { timeouts: { drainMaxMinutes: 10, drainRetryMinutes: 1, deferMaxHours: 24, pauseConfirmMs: 600_000, verifyMaxMs: 2_700_000, grantPollMs: [30_000, 120_000] } } });
  const op = await openOp(env, 'n2', { drainMaxMinutes: 10 });
  const r = await runOp(env, op);
  assert.deepEqual([r.terminal.outcome, r.terminal.code], ['STALE', U.RETRIES_EXHAUSTED]);
  assert.equal((await loadJournal(env, op)).steps.filter(s => s.step === 'drain').length, 10);
});
