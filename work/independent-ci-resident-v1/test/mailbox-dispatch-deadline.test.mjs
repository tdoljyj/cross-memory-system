import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Companion } from '../src/companion.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { JOB_HOST_REPORT_CONTRACT, Runner } from '../src/runner.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const batchId = '0123456789abcdef-123456789abc';
const head = 'a'.repeat(40);
const quiet = { linuxUnitsInactive: true, containersZero: true };
const due = request => Date.parse(request.deadline);

async function scenario(t, { proof = quiet, treeZero = true } = {}) {
  let markStarted, unblock, dispatch;
  const started = new Promise(resolve => { markStarted = resolve; });
  const held = new Promise(resolve => { unblock = resolve; });
  const polls = [];
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    polls.push({ fn, ms });
    return { unref() { return this; } };
  });
  t.after(async () => { unblock(); await dispatch; });
  const outcome = { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false,
    safeToRerun: false, diagnostic: { reasonCodes: ['protected_change_not_up_to_date'] } };
  const engine = fakeEngine({ stages: { 1: { ok: false, code: 'PROTECTED_CHANGE_NOT_UP_TO_DATE', outcome, proof: WINDOWS_CLEAN } } });
  const f = await executorFixture(t, { engine });
  const box = await Mailbox.open(path.join(f.root, 'mailbox'), f.clock, f.clock);
  const calls = [];
  const runner = new Runner({ jobHost: 'C:\\fixture\\host.exe', spawnImpl: (_exe, [nonce, , ...argv]) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const finish = (value, drained = true) => {
      child.stdout.end(JSON.stringify(value));
      const report = { contract: JOB_HOST_REPORT_CONTRACT, started: true, failure: null, childPid: 42,
        timedOut: false, exitCode: 0, leftover: 0, activeProcesses: drained ? 0 : 1, totalProcesses: 1, treeZero: drained, hostElapsedMs: 1750 };
      child.stderr.end(`clued-job-host ${nonce} ${JSON.stringify(report)}\n`);
      child.emit('close', 0);
    };
    if (argv.includes('archive-usage')) {
      calls.push('long');
      markStarted();
      void held.then(() => finish({}));
    } else if (argv[0] === 'fixture-gh') {
      calls.push('pr');
      queueMicrotask(() => {
        f.advance(1750);
        finish({ number: Number(argv[1]), state: 'closed', merged: true, head });
      });
    } else {
      assert.ok(argv.includes('quiescence'));
      calls.push('linux');
      queueMicrotask(() => {
        f.advance(1750);
        finish({ ...proof, pendingJobsQuiet: true }, treeZero);
      });
    }
    return child;
  } });
  const companion = new Companion({ cfg: { wslExe: 'fixture-wsl', distribution: 'fixture', linuxTool: 'fixture-tool' }, mailbox: box,
    run: (argv, options) => runner.run(argv, options), clock: f.clock, readPull: pr => ['fixture-gh', String(pr)] });
  const startLong = async () => {
    const req = await box.send('archive-usage', { batchId }, 300_000);
    dispatch = companion.step();
    await Promise.race([started, dispatch.then(() => assert.fail('先行邮箱命令未启动'))]);
    // 等空邮箱上已经发出的取件都结束，再由服务写入本次请求。
    for (const { fn } of polls) await Promise.all(fn());
    return req;
  };
  const pickup = async () => {
    for (const { fn, ms } of polls) {
      f.advance(ms);
      await Promise.all(fn());
    }
  };
  await box.beat();
  return { ...f, box, calls, startLong, runner, pickup, step: () => companion.step() };
}

async function assertDispatch(box, request) {
  const timing = JSON.parse(await fs.readFile(path.join(box.responses, request.requestId + '.dispatch.json'), 'utf8'));
  assert.equal(timing.requestId, request.requestId);
  assert.equal(timing.kind, request.kind);
  assert.equal(timing.enqueuedAt, Date.parse(request.createdAt));
  assert.ok(timing.enqueuedAt <= timing.pickedUpAt && timing.pickedUpAt <= timing.handlerStartedAt);
  assert.equal(timing.handlerEndedAt - timing.handlerStartedAt, 1750);
  assert.deepEqual(timing.hostElapsedMs, [1750]);
  assert.ok(timing.handlerEndedAt <= timing.publishedAt && timing.publishedAt < due(request));
}

test('DESK #1380 的精确 PR 查询在先行长操作待决时返回，合入行直接收终', async t => {
  const f = await scenario(t);
  const long = await f.startLong();
  let pickupError;
  const ports = mailboxCompanion(f.box, async () => {
    const request = (await f.box.pending()).findLast(r => r.kind === 'pr-head');
    assert.equal(request.pr, 1380);
    assert.equal(due(request) - Date.parse(request.createdAt), 120_000);
    assert.deepEqual(await f.receipts.latest(['batch-reserved', 'stage-terminal'], 1), []);
    try {
      await f.pickup();
      const answer = await f.box.poll(request);
      assert.equal(answer?.pull?.state, 'merged', '先行长操作待决时应交付精确 PR 应答');
      await assertDispatch(f.box, request);
      assert.equal(await f.box.poll(long), null);
    } catch (error) {
      pickupError = error;
      f.advance(due(request) + 377 - f.clock());
    }
  });
  f.companion.prHead = ports.prHead;
  await f.drop(triggerBytes({ pr: 1380, headSha: head }));
  const result = await f.exec.tick();
  if (pickupError) throw pickupError;
  assert.deepEqual([result.state, result.reason, f.queue.row(1380).state], ['IGNORED', 'PR_CLOSED', 'DONE']);
  assert.deepEqual(f.calls, ['long', 'pr']);
  assert.equal(f.engine.calls.some(([op]) => op === 'stage'), false);
  assert.deepEqual(await f.receipts.latest(['batch-reserved', 'stage-terminal'], 1), []);
});

async function rejectedBatch(t, options = {}) {
  const f = await scenario(t, options);
  let long;
  const base = f.clock();
  const runStage = f.engine.runStage.bind(f.engine);
  f.engine.runStage = async (...args) => {
    const result = await runStage(...args);
    f.advance(174_260);
    if (Object.keys(options).length === 0) long = await f.startLong();
    return result;
  };
  const requests = [];
  const ports = mailboxCompanion(f.box, async () => {
    const request = (await f.box.pending()).filter(r => r.kind === 'linux-quiescence').at(-1);
    assert.ok(request);
    requests.push(request);
    if (options.missing) {
      f.advance(due(request) - f.clock());
      return;
    }
    if (!long) { await f.step(); return; }
    try {
      await f.pickup();
      const answer = await f.box.poll(request);
      assert.deepEqual(answer?.proof, quiet, '先行长操作待决时应交付本次双真');
      await assertDispatch(f.box, request);
      assert.equal(await f.box.poll(long), null);
      assert.equal(f.runner.busy, true);
    } catch (error) {
      // 服务把端口错误当成缺证，保留断言供下方验证。
      f.pollError = error;
      f.advance(due(request) - f.clock());
    }
  });
  Object.assign(f.companion, { quiescenceRead: ports.quiescenceRead, linuxQuiescence: ports.linuxQuiescence,
    prHead: async pr => ({ number: pr, state: 'open', headSha: head }) });
  await f.drop(triggerBytes({ pr: 1380, headSha: head }));
  const result = await f.exec.tick();
  if (f.pollError) throw f.pollError;
  assert.ok(requests[0], '阶段 1 拒绝后应发出静止请求');
  assert.equal(Date.parse(requests[0].createdAt) - base, 174_260);
  return { ...f, result, requests, state: await f.ledger.state(result.key), halt: await f.ledger.halted() };
}

test('已预留的旧 head 及时取得本次真实双真，双端归档后只记 FAILED_CLEAN', async t => {
  const f = await rejectedBatch(t);
  assert.deepEqual([f.result.state, f.state.outcome, f.halt], ['FAILED_CLEAN', 'FAILED_CLEAN', null]);
  assert.deepEqual(f.calls, ['long', 'linux']);
  assert.deepEqual((await f.box.poll(f.requests[0])).proof, quiet);
  assert.equal(f.engine.calls.filter(([op]) => op === 'archive-windows').length, 1);
  assert.equal(f.companion.calls.filter(([op]) => op === 'archive-linux').length, 1);
});

for (const [label, options] of [
  ['两次缺答', { missing: true }],
  ['实际双假', { proof: { linuxUnitsInactive: false, containersZero: false } }],
  ['子树未证实（即便标准输出为双真）', { treeZero: false }],
]) test(`${label}仍以 FAILED_UNKNOWN 锁存 HALT，迟到双真无法解锁`, async t => {
  const f = await rejectedBatch(t, options);
  assert.deepEqual([f.result.state, f.state.outcome, f.halt.value.facts.basis], ['HALTED', 'FAILED_UNKNOWN', 'cleanup-proof-incomplete']);
  assert.equal(f.engine.calls.some(([op]) => op === 'archive-windows'), false);
  if (options.missing) {
    assert.equal(f.requests.length, 2);
    f.advance(16_394);
    const latest = f.requests.at(-1);
    await f.box.respond(latest, { ok: true, proof: quiet });
    assert.equal(await f.box.await(latest, async () => assert.fail('过期请求不得继续等待')), null);
    assert.equal((await f.exec.tick()).state, 'HALTED');
    assert.equal((await f.ledger.halted()).sha256, f.halt.sha256);
  } else {
    const answer = await f.box.poll(f.requests[0]);
    if (options.treeZero === false) assert.equal(answer.jobTree, 'unconfirmed');
    else assert.deepEqual(answer.proof, options.proof);
  }
});
