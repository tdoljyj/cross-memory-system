// Production file/state modules and PS5.1 reader predicates, with OS/network boundaries isolated.
// This report is deliberately NOT physical Windows service / Linux systemd upgrade acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, digest, sha256 } from '../../src/canonical.mjs';
import { StatusBoard } from '../../src/status.mjs';
import { ResidentExecutor } from '../../src/executor.mjs';
import { ResidentPort } from '../../upgrader/src/resident-ports.mjs';
import { parseApplyOutput } from '../../upgrader/src/windows-port.mjs';
import { Machine } from '../../upgrader/src/machine.mjs';
import { Journal } from '../../upgrader/src/journal.mjs';
import { PACKAGE_SLOTS, GENERATED_SLOTS } from '../../upgrader/src/plan.mjs';
import { executorFixture, fakeEngine } from '../../test/helpers.mjs';
import { makeEnv, openOp } from '../../upgrader/test/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const residentRoot = path.resolve(here, '../..');
const psReader = path.join(here, 'verify-generation-io.ps1');
const verifier = path.join(residentRoot, 'windows', 'verify-resident.ps1');
const receiptsVerifier = path.join(residentRoot, 'tools', 'verify-receipts.mjs');
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const BEFORE = '019c1b7719c2b400915d16293e6c4d6e34585efd';
const AFTER = '1cba7ba527dc4755560e05f956c3f888350d3249';
const jsonWrite = (file, value) => fs.writeFile(file, canonicalJson(value) + '\n');
const jsonRead = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function run(t, { before = false, oldReceiptOnly = false, corrupt = false } = {}) {
  const baseline = process.env.CLUED_UPGRADE_BEFORE_REPO;
  if (before && !baseline) throw new Error('EXACT_BEFORE_REPOSITORY_REQUIRED');
  const git = (root, args) => execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  if (before) {
    assert.equal(git(baseline, ['rev-parse', 'HEAD']).toString().trim(), BEFORE);
    assert.equal(git(baseline, ['status', '--porcelain', '--untracked-files=no']).toString(), '', 'before runtime must be a clean exact subject');
  }
  const repo = path.resolve(residentRoot, '../..');
  for (const rel of ['src/executor.mjs', 'upgrader/src/machine.mjs', 'windows/verify-resident.ps1']) {
    assert.equal(sha256(await fs.readFile(path.join(residentRoot, rel))), sha256(git(repo, ['cat-file', 'blob', AFTER + ':work/independent-ci-resident-v1/' + rel])));
  }
  const old = before ? await import(pathToFileURL(path.join(baseline, 'work/independent-ci-resident-v1/upgrader/src/machine.mjs')).href) : null;
  const executorClass = before && !oldReceiptOnly
    ? (await import(pathToFileURL(path.join(baseline, 'work/independent-ci-resident-v1/src/executor.mjs')).href)).ResidentExecutor : ResidentExecutor;
  const machineClass = old?.Machine ?? Machine;
  const env = await makeEnv(t);
  await fs.writeFile(path.join(env.root, 'ISOLATED-UPGRADE-IO-FIXTURE'), 'public test fixture only\n');
  for (const dir of ['broker/requests', 'broker/responses', 'mailbox/responses']) await fs.mkdir(path.join(env.root, dir), { recursive: true });
  // Fill the real install receipt fields which the earlier fake-verifier fixture omitted.
  const receiptFile = path.join(env.root, 'install/install-receipt.json');
  const receipt = await jsonRead(receiptFile), scm = await env.windows.state(), pkg = env.pkgs.n1;
  Object.assign(receipt, { residentManifestSha256: pkg.residentSha, ciSourceManifestSha256: pkg.ciSource,
    sourceManifestSha256: pkg.manifest.sourceManifestSha256, companionConfigSha256: sha256(pkg.files.get('config/companion.json')),
    residentBinaryPath: scm.resident.binPath, brokerBinaryPath: scm.broker.binPath, companionTaskAction: scm.companionTask });
  await jsonWrite(receiptFile, receipt);
  const current = await jsonRead(path.join(env.root, 'upgrade/current.json'));
  current.installReceiptSha256 = sha256(await fs.readFile(receiptFile));
  await jsonWrite(path.join(env.root, 'upgrade/current.json'), current);
  const generationFile = path.join(env.root, 'generations/g1/generation.json');
  const generation = await jsonRead(generationFile), liveHashes = {};
  for (const slot of [...PACKAGE_SLOTS, ...GENERATED_SLOTS]) liveHashes[slot] = sha256(await fs.readFile(path.join(env.root, ...slot.split('\\'))));
  generation.filesSha256 = digest(liveHashes);
  await jsonWrite(generationFile, generation);
  const engine = fakeEngine();
  engine.runRoleProbe = async () => ({ ok: true, proof: { windowsTreeZero: true, serviceOriginalStopped: true },
    roleProbe: { result: 'not-held', code: 'ROLE_PROBE_NOT_HELD' },
    outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_NOT_HELD', sideEffects: 0, mayHavePublished: false } });
  const board = new StatusBoard({ clock: env.clock.fn });
  const f = await executorFixture(t, { root: env.root, now: env.clock.now, engine, status: board });
  f.ports.clock = env.clock.fn;
  let executor = new executorClass(f.ports), running = true, injected = false;
  const trace = [], observations = [];
  const port = new ResidentPort(env.root, { clock: env.clock.fn });
  async function tick() {
    if (!running) return;
    f.advance(env.clock.now - f.clock());
    await executor.tick();
    await jsonWrite(path.join(env.root, 'state/status.json'), board.snapshot());
    await jsonWrite(path.join(env.root, 'mailbox/responses/heartbeat.json'), { at: env.clock.now });
    await jsonWrite(path.join(env.root, 'upgrade/mailbox/responses/version-facts.json'), await env.linux.readFacts());
  }
  await fs.mkdir(path.join(env.root, 'upgrade/mailbox/responses'), { recursive: true });
  const fileResident = {
    hold: id => port.hold(id), liftHold: id => port.liftHold(id), requestPause: (n, b) => port.requestPause(n, b),
    withdrawPause: (n, p) => port.withdrawPause(n, p), pauseRequestPending: n => port.pauseRequestPending(n),
    pauseState: async () => { await tick(); return port.pauseState(); }, halted: () => port.halted(),
    openBatches: () => port.openBatches(), status: async () => { await tick(); return port.status(); },
    receiptHead: () => port.receiptHead(), receiptsSince: n => port.receiptsSince(n), trainOpen: () => port.trainOpen(),
    brokerPending: () => port.brokerPending(), companionHeartbeat: () => port.companionHeartbeat(),
    requestUpgradeResume: a => port.requestUpgradeResume(a),
    stop() { trace.push('stop'); running = false; },
    async start(policySha256, generation) {
      trace.push('start:' + generation); running = true; f.advance(env.clock.now - f.clock());
      executor = new executorClass(f.ports);
      await f.receipts.append('service-start', { policySha256, generation, pid: 4242 });
    },
  };
  env.resident = fileResident; env.windows.resident = fileResident;
  // No call to FakeWindows.verify: the subprocess reads the actual switched fixture and actual production verifier functions.
  env.windows.verify = async args => {
    trace.push('verify:' + args.generation);
    if (corrupt && args.generation === 2 && !injected) {
      await fs.appendFile(path.join(env.root, 'record/acceptance.json'), ' '); injected = true;
    }
    const argv = ['-NoProfile', '-NonInteractive', '-File', psReader, '-Root', env.root, '-Verifier', verifier,
      '-ReceiptsVerifier', receiptsVerifier, '-NodeExe', process.execPath, '-Now', String(env.clock.now)];
    if (args.expectPausedSha256) argv.push('-ExpectPausedSha256', args.expectPausedSha256);
    let stdout, exit = 0;
    try { stdout = execFileSync(powershell, argv, { encoding: 'utf8', windowsHide: true }); }
    catch (e) { stdout = e.stdout ?? ''; exit = e.status ?? 1; }
    const result = parseApplyOutput(exit, stdout);
    observations.push({ generation: args.generation, ...result });
    return result;
  };
  env.ports.resident = fileResident;
  await tick();
  const op = await openOp(env, 'n2');
  const machine = new machineClass({ root: env.root, opId: op, config: env.config, clock: env.clock.fn, ports: env.ports });
  let terminal;
  for (let moves = 0; moves < 1500; moves++) {
    await tick();
    const result = await machine.step();
    if (result.done) { terminal = result.terminal; break; }
    env.clock.advance(result.wait > 0 ? result.wait : 1);
  }
  assert.ok(terminal, 'bounded isolated run must settle');
  await tick();
  const journal = await Journal.open(path.join(env.root, 'upgrade/ops'), op).load();
  const evidence = { runtimeBefore: BEFORE, runtimeAfter: AFTER, before, oldReceiptOnly, corrupt, outcome: terminal.outcome, code: terminal.code,
    steps: journal.steps.map(s => ({ step: s.step, ok: s.result?.ok, code: s.result?.code, detail: s.result?.detail })),
    trace, observations, pauseRemains: !!(await port.pauseState()),
    boundary: { realMachineAndGenerations: true, realExecutorAndResidentPort: true, realPS51PinnedReadersAndGenerationPredicates: true,
      realReceiptChainVerifier: true, physicalHostServicesExercised: false, physicalLinuxSystemdExercised: false,
      substituted: ['SCM/task observations', 'Linux host/companion', 'Grant door', 'Native role reply'] } };
  if (process.env.CLUED_UPGRADE_REPORT_DIR) {
    const name = before ? (oldReceiptOnly ? 'before-receipt' : 'before-full') : (corrupt ? 'after-rollback' : 'after-success');
    await fs.writeFile(path.join(process.env.CLUED_UPGRADE_REPORT_DIR, name + '.json'), canonicalJson(evidence) + '\n', { flag: 'wx' });
  }
  return evidence;
}

test('old complete interaction fails instead of receiving a fabricated fresh probe', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const r = await run(t, { before: true });
  assert.notEqual(r.outcome, 'SUCCEEDED');
});
test('old receipt algorithm is rejected by real PS51 record readers after switching records', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const r = await run(t, { before: true, oldReceiptOnly: true });
  assert.equal(r.outcome, 'ROLLED_BACK_PAUSED');
  assert.ok(r.observations.some(v => v.generation === 2 && v.checks?.['record-acceptance']?.detail === 'INSTALL_RECEIPT_CHANGED'));
});
test('fixed isolated sequence pauses, switches both sides, verifies the real files and consumes its real resume request', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const r = await run(t);
  assert.equal(r.outcome, 'SUCCEEDED', JSON.stringify(r.observations));
  assert.equal(r.pauseRemains, false);
  for (const step of ['pause', 'stop', 'switch-linux', 'switch-windows', 'start', 'verify', 'resume']) assert.ok(r.steps.some(s => s.step === step && s.ok));
});
test('an actual changed gen2 record rolls back, then real gen1 readers and receipt chain verify while the pause remains', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const r = await run(t, { corrupt: true });
  assert.equal(r.outcome, 'ROLLED_BACK_PAUSED', JSON.stringify(r.observations));
  assert.equal(r.pauseRemains, true);
  assert.ok(r.observations.some(v => v.generation === 1 && v.ok));
});
