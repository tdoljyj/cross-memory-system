import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeFailureCode } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Runner, JOB_HOST_REPORT_CONTRACT } from '../src/runner.mjs';
import { batchKey, headKey } from '../src/ledger.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { Companion } from '../src/companion.mjs';
import { startLoopDelay } from '../src/companion-main.mjs';
import { ResidentExecutor } from '../src/executor.mjs';
import { rearmRequest, writeOwnerRequest } from '../tools/rearm-tool.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { SOURCE, WINDOWS_CLEAN, executorFixture, fakeEngine, triggerBytes } from './helpers.mjs';

const head = '41b751a90ca096c2f4e337c3669198a8103d1952';
const base = 'b9cca4ca3e5d87e5a9ccdd182b5615ae767ff993';
const outcome = { status: 'BLOCKED', reason: 'full_admission_rejected', sideEffects: 0, mayHavePublished: false,
  safeToRerun: false, diagnostic: { reasonCodes: ['protected_change_not_up_to_date'] } };

async function 拒绝旧提交(t, linuxQuiescence) {
  const code = outcomeFailureCode(outcome, 1);
  assert.equal(code, 'PROTECTED_CHANGE_NOT_UP_TO_DATE');
  const engine = fakeEngine({ stages: { 1: { ok: false, code, outcome, proof: WINDOWS_CLEAN } } });
  const f = await executorFixture(t, { engine });
  f.companion.linuxQuiescence = linuxQuiescence;
  await f.drop(triggerBytes({ pr: 1368, headSha: head, baseSha: base }));
  const result = await f.exec.tick();
  const { reserved, terminal, started } = await f.ledger.state(result.key);
  assert.ok(!started);
  assert.equal(await f.ledger.headBurned(headKey(reserved.subject)), true);
  assert.deepEqual([terminal.facts.class, terminal.facts.retry, terminal.facts.breaker],
    ['deterministic-pr', 'new-commit', 'neutral']);
  return { result, terminal, halt: (await f.ledger.halted())?.value ?? null };
}

test('对照：四项证明齐全时，只烧掉 #1368 的旧提交', async t => {
  const { result, halt } = await 拒绝旧提交(t, async () => ({ linuxUnitsInactive: true, containersZero: true }));
  assert.deepEqual([result.state, halt], ['FAILED_CLEAN', null]);
});

test('对照：持续观测到活跃的 Linux 单元时，保留现场并锁住节点', async t => {
  const { result, terminal, halt } = await 拒绝旧提交(t, async () => ({ linuxUnitsInactive: false, containersZero: true }));
  assert.deepEqual([result.state, terminal.outcome, halt.facts.basis, halt.clearedOnlyBy],
    ['HALTED', 'FAILED_UNKNOWN', 'cleanup-proof-incomplete', 'owner-rearm']);
});

const quiet = { linuxUnitsInactive: true, containersZero: true, pendingJobsQuiet: true };
const ok = v => ({ code: 0, stdout: JSON.stringify(v) });

async function 调用链(t, options = {}) {
  const stageOutcome = { ...outcome, ...options.outcome };
  const code = outcomeFailureCode(stageOutcome, 1);
  const engine = fakeEngine({ stages: { [options.stage ?? 1]: { ok: false, code, outcome: stageOutcome,
    proof: options.stageProof ?? WINDOWS_CLEAN } } });
  let windows = 0, probes = 0, roles = 0;
  engine.windowsQuiescence = async () => {
    windows++;
    f.advance(options.windowsMs?.(windows) ?? 0);
    return options.windows?.(windows) ?? WINDOWS_CLEAN;
  };
  if (options.role) engine.runRoleProbe = async () => {
    roles++;
    return { ok: true, proof: WINDOWS_CLEAN, roleProbe: { result: 'held', code: 'ROLE_PROBE_HELD' },
      outcome: { status: 'BLOCKED', reason: 'ROLE_PROBE_HELD', sideEffects: 0, mayHavePublished: false } };
  };
  const f = await executorFixture(t, { engine });
  const box = await Mailbox.open(path.join(f.root, 'mailbox'), f.clock);
  const requests = [], hostCalls = [], log = [];
  const companion = new Companion({
    cfg: { powershellExe: 'C:\\fixture\\ps.exe', bundleScript: 'bundle-fixture', wslExe: 'fixture', distribution: 'fixture', linuxTool: 'fixture' },
    mailbox: box, clock: f.clock, loopDelay: options.loopDelay, log: async row => { log.push(row); },
    run: async (args, hostOptions) => {
      hostCalls.push(args);
      if (args.includes('quiescence')) return options.probe?.(++probes, hostOptions.timeoutMs, f, hostOptions) ?? ok(quiet);
      if (args.includes('archive-status')) return ok({ verified: options.archive !== false, directory: 'failed-fixture' });
      if (args.includes('bundle-fixture')) return ok({ status: 'BUNDLE_WRITTEN' });
      return ok({});
    },
  });
  await box.beat();
  const ports = mailboxCompanion(box, async ms => {
    const pending = await box.pending();
    const req = pending.at(-1);
    if (req?.kind === 'linux-quiescence') {
      if (!requests.some(r => r.requestId === req.requestId)) requests.push(req);
      const n = requests.length;
      if (options.miss?.includes(n)) {
        f.advance(Math.max(ms, Date.parse(req.deadline) - f.clock()));
        return;
      }
      if (n === 2 && options.beforeSecond) await options.beforeSecond({ f, box, first: requests[0] });
      f.advance(options.queueMs ?? 0);
    }
    await companion.step();
    if (!pending.length) f.advance(ms);
  });
  // 复用常驻夹具的精确 PR 答复，阶段 1 的清理证明与归档仍经过真实邮箱适配器。
  Object.assign(f.companion, { ...ports, prHead: f.companion.prHead });
  return Object.assign(f, { box, log, requests, hostCalls, windows: () => windows, roles: () => roles, code });
}

async function 触发(f, overrides = {}) {
  await f.drop(triggerBytes({ pr: 1368, headSha: head, baseSha: base, ...overrides }));
  return f.exec.tick();
}

for (const reason of ['full_admission_rejected', 'pr_subject_changed']) {
  test('旧 head 首封漏答后补取，烧一次并可接下一批：' + reason, async t => {
    const f = await 调用链(t, { outcome: { reason }, miss: [1] });
    const subject = reason === 'pr_subject_changed' ? { pr: 1366, headSha: '6'.repeat(40) } : { pr: 1368, headSha: head };
    const first = await 触发(f, subject);
    assert.equal(first.state, 'FAILED_CLEAN', '应以本轮完整双端证明收尾');
    const s = await f.ledger.state(first.key);
    assert.deepEqual([s.outcome, s.started, s.terminal.facts.failureCode, s.terminal.facts.class,
      s.terminal.facts.retry, s.terminal.facts.breaker], ['FAILED_CLEAN', null, f.code, 'deterministic-pr', 'new-commit', 'neutral']);
    assert.ok(await f.ledger.headBurned(headKey(s.reserved.subject)));
    assert.deepEqual([await f.ledger.halted(), f.windows(), f.requests.length], [null, 2, 2]);
    const [a, b] = f.requests;
    assert.notEqual(a.requestId, b.requestId);
    assert.equal(b.previousRequestId, a.requestId);
    assert.deepEqual(b.binding, a.binding);
    assert.equal(b.binding.headSha, subject.headSha);
    assert.equal(b.batchId, a.batchId);
    const duration = r => Date.parse(r.deadline) - Date.parse(r.createdAt);
    assert.deepEqual([duration(a), duration(b)], [210_000, 119_500]);
    assert.equal(f.engine.calls.filter(c => c[0] === 'archive-windows').length, 1);
    assert.equal(f.hostCalls.filter(a => a.includes('archive-status')).length, 1);
    assert.equal(f.hostCalls.some(a => a.some(s => s.startsWith('clued-ci-wsprep@'))), false);
    assert.equal((await 触发(f, { pr: 1399, headSha: '9'.repeat(40) })).state, 'FAILED_CLEAN');
  });
}

for (const [name, options, rounds] of [
  ['连续两封均无应答', { miss: [1, 2] }, 2],
  ['真实活跃', { probe: () => ok({ ...quiet, containersZero: false }) }, 1],
  ['树未清', { probe: () => ({ timedOut: true, tree: 'unconfirmed' }) }, 1],
  ['阶段自己的 Windows 反证', { stageProof: { windowsTreeZero: false }, miss: [1] }, 1],
  ['Windows 初读反证', { windows: () => ({ ...WINDOWS_CLEAN, serviceOriginalStopped: false }), miss: [1] }, 1],
  ['补取的 Windows 反证', { windows: n => ({ ...WINDOWS_CLEAN, windowsTreeZero: n === 1 }), miss: [1] }, 2],
  ['可能已发布', { outcome: { mayHavePublished: true }, miss: [1] }, 1],
  ['通用拒收码', { outcome: { reason: 'pr_files_changed' }, miss: [1] }, 1],
  ['Windows 读回已耗尽总额', { windowsMs: () => 330_000 }, 0],
  ['第一封迟到的活动不能被第二封双真冲掉', { miss: [1], beforeSecond: ({ box, first }) =>
    box.respond(first, { ok: true, proof: { linuxUnitsInactive: false, containersZero: true } }) }, 2],
]) test('保留现场：' + name, async t => {
  const f = await 调用链(t, options);
  const r = await 触发(f);
  assert.equal(r.state, 'HALTED');
  const s = await f.ledger.state(r.key);
  const basis = options.outcome?.mayHavePublished ? 'failure-table-halt' : 'cleanup-proof-incomplete';
  assert.deepEqual([s.outcome, s.terminal.facts.basis, f.requests.length], ['FAILED_UNKNOWN', basis, rounds]);
});

test('第二封只有一次宿主机会，超时清树亦不得第三问', async t => {
  let calls = 0;
  const f = await 调用链(t, { miss: [1], probe: () => { calls++; return { timedOut: true, tree: 'zero' }; } });
  assert.equal((await 触发(f)).state, 'HALTED');
  assert.deepEqual([calls, f.requests.length], [1, 2]);

  const drained = await 调用链(t, { probe: n => n <= 3 ? { timedOut: true, tree: 'zero' } : ok(quiet) });
  assert.equal((await 触发(drained)).state, 'FAILED_CLEAN');
  assert.deepEqual([drained.windows(), drained.requests.length], [2, 2]);
  assert.equal(drained.hostCalls.filter(a => a.includes('quiescence')).length, 4);
});

test('取证中重启仍由恢复路径保留现场', async t => {
  const f = await 调用链(t, { miss: [1], beforeSecond: async ({ f }) => {
    await new ResidentExecutor({ ...f.ports, lockFromEarlierBoot: true }).recover();
  } });
  assert.equal((await 触发(f)).state, 'HALTED');
  assert.equal(f.requests.length, 2);
  assert.ok(await f.ledger.halted());
  const [scene] = await f.ledger.unknownUnarchived();
  assert.equal(scene.terminal.facts.batchId, f.requests[0].batchId);
  assert.equal(scene.terminal.facts.failureCode, f.code);
  assert.equal((await new ResidentExecutor(f.ports).tick()).state, 'HALTED');
  assert.equal(f.requests.length, 2);

  const interrupted = await 调用链(t, { miss: [1], beforeSecond: ({ box, first }) => box.claimProbe(first) });
  assert.equal((await 触发(interrupted)).state, 'HALTED');
  assert.equal(interrupted.hostCalls.filter(a => a.includes('quiescence')).length, 0, '上一封启动后中断，宿主树未知');
});

async function 复位现场(f) {
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 1368, headSha: head, baseSha: base, sourceManifestSha256: SOURCE, attempt: 1 };
  const key = batchKey(subject);
  await f.ledger.reserve(key, subject);
  await f.ledger.markStarted(key, { batchId: key.slice(0, 16) + '-000000000000' });
  await f.ledger.halt('RESIDENT_LOOP_EXCEPTION', {});
  await f.exec.tick();
  const halt = await f.ledger.halted();
  await writeOwnerRequest(path.join(f.root, 'owner'), rearmRequest({ expectedHaltSha256: halt.sha256, reason: '核对双端', by: 'S-1-5-21-1-2-3-1001' }, f.clock), f.clock);
  return { key, halt };
}

test('Owner 收件到复位：120.032 秒后双真，验证归档和 CAS 后重新探测角色', async t => {
  const f = await 调用链(t, { role: true, probe: (n, ms, f) => {
    f.advance(n < 3 ? ms + 20_000 : 20_032);
    return n < 3 ? { timedOut: true, tree: 'zero' } : ok(quiet);
  } });
  const { key, halt } = await 复位现场(f);
  const before = f.roles();
  await f.exec.tick();
  assert.equal(await f.ledger.halted(), null);
  assert.ok((await f.ledger.state(key)).archived);
  assert.equal(f.requests.length, 1);
  assert.ok(f.roles() > before);
  assert.equal((await f.receipts.latest(['owner-request'], 1))[0].value.body.haltSha256, halt.sha256);
});

for (const [title, expected, fields] of [
  ['归档未验证', 'REARM_LINUX_ARCHIVE_UNCONFIRMED', { archive: false }],
  ['新 HALT 摘要', 'HALT_CHANGED_SINCE_REVIEW', { probe: async (_n, _ms, f) => {
    await fs.writeFile(path.join(f.root, 'state', 'HALT.json'), JSON.stringify({ code: 'NEW_HALT' }));
    return ok(quiet);
  } }],
  ['Linux 无应答', 'REARM_REQUIRES_QUIESCENCE_ON_BOTH_HOSTS', { miss: [1] }],
]) test('Owner 保留锁：' + title, async t => {
  const f = await 调用链(t, fields);
  await 复位现场(f);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal((await f.receipts.latest(['owner-request-refused'], 1))[0].value.body.failureCode, expected);
  assert.equal((await f.exec.tick()).state, 'HALTED');
  assert.equal(f.requests.length, 1, '同一 Owner 请求只办一次');
});

test('按请求号区分排队、宿主执行、事件循环延迟与收件时刻', async t => {
  // 保留 Runner 的真实报告解码，只有宿主进程与时钟是替身。
  const runner = new Runner({ jobHost: 'C:\\fixture\\host.exe', spawnImpl: (_exe, [nonce], { env }) => {
    assert.equal(env.CLUED_QUIESCENCE_TIMING, '1');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(JSON.stringify(quiet));
      const fact = { contract: JOB_HOST_REPORT_CONTRACT, started: true, failure: null, childPid: 42,
        timedOut: false, exitCode: 0, leftover: 0, activeProcesses: 0, totalProcesses: 1, treeZero: true, hostElapsedMs: 2000 };
      child.stderr.end('clued-job-host ' + nonce + ' ' + JSON.stringify(fact) + '\n');
      child.emit('close', 0);
    });
    return child;
  } });
  const f = await 调用链(t, { queueMs: 6000, loopDelay: (from, to) => to - from === 7000 ? 4500 : 3000,
    probe: (_n, ms, f, hostOptions) => {
      f.advance(7000);
      return runner.run(['fixture-probe'], hostOptions);
    } });
  await 触发(f);
  const [req] = f.requests;
  const timings = f.log.filter(r => r.requestId === req.requestId);
  const attempt = timings.find(r => r.kind === 'quiescence-attempt');
  assert.deepEqual([attempt?.timeoutMs, attempt?.elapsedMs, attempt?.hostElapsedMs], [30_000, 7000, 2000]);
  assert.equal(timings.find(r => r.kind === 'quiescence-start')?.queueMs, 6000);
  assert.equal(attempt.loopDelayMs, 4500);
  assert.equal(timings.find(r => r.kind === 'quiescence-start').loopDelayMs, 3000);
  const delivery = JSON.parse(await fs.readFile(path.join(f.box.requests, req.requestId + '.received.json')));
  const published = JSON.parse(await fs.readFile(path.join(f.box.responses, req.requestId + '.published.json')));
  assert.ok(delivery.receivedAt >= published.publishedAt);
});

test('事件循环采样只统计请求区间内逾期的定时器', () => {
  let now = 1000, sample;
  const timer = startLoopDelay({ clock: () => now, everyMs: 100,
    schedule: fn => { sample = fn; return { unref() {} }; } });
  now = 1100; sample();
  now = 2400; sample();
  assert.equal(timer.between(1000, 1800), 600);
  assert.equal(timer.between(1800, 2400), 600);
  now = 2500; sample();
  assert.equal(timer.between(2400, 2500), 0);
  timer.stop();
});

test('已进入第二阶段的拒绝不能补取证明', async t => {
  const f = await 调用链(t, { miss: [1] });
  const subject = { repo: 'tdoljyj/cross-memory-system', pr: 1366, headSha: head, baseSha: base, sourceManifestSha256: SOURCE, attempt: 1 };
  const key = batchKey(subject);
  await f.ledger.reserve(key, subject);
  const batch = await f.engine.derive(subject, key);
  await f.ledger.markStarted(key, { batchId: batch.batchId });
  const r = await f.exec.fail(key, batch, { stageNumber: 2, phase: 'stage', code: 'STAGE_CHILD_REFUSED',
    outcome: { ...outcome, reason: 'pr_subject_changed' }, proof: WINDOWS_CLEAN });
  assert.equal(r.state, 'HALTED');
  assert.equal(f.requests.length, 1);
});
