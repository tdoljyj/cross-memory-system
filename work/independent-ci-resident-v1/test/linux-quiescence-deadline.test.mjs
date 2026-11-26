import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Companion } from '../src/companion.mjs';
import { Mailbox } from '../src/mailbox.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { tempRoot } from './helpers.mjs';

const quiet = { linuxUnitsInactive: true, containersZero: true };
const unconfirmed = { linuxUnitsInactive: false, containersZero: false };

async function readProof(t, offsetMs) {
  let now = Date.parse('2026-11-26T05:37:14.620Z');
  const box = await Mailbox.open(await tempRoot(t), () => now);
  let request;
  let publishAt;
  let published = false;

  // 推进虚拟时间。写方可在两次轮询之间发布，服务醒来时才有机会读取。
  async function advanceTo(target) {
    if (!published && publishAt <= target) {
      now = publishAt;
      await box.respond(request, { ok: true, proof: quiet });
      published = true;
    }
    now = target;
  }

  const service = mailboxCompanion(box, async ms => {
    if (!request) {
      [request] = await box.pending();
      assert.equal(request?.kind, 'linux-quiescence');
      publishAt = Date.parse(request.deadline) + offsetMs;
    }
    await advanceTo(now + ms);
  });
  const received = await service.linuxQuiescence(null);

  // 即使服务已经返回，写方仍能完成旧请求并留下可核对的应答。
  await advanceTo(Math.max(now, publishAt));
  const stored = await box.poll(request);
  assert.equal(stored.ok, true);
  assert.deepEqual(stored.proof, quiet);
  assert.equal(Date.parse(stored.observedAt) - Date.parse(request.deadline), offsetMs);
  return received;
}

test('期限前 600 毫秒发布的完整静止证明可被下一次轮询读到', async t => {
  assert.deepEqual(await readProof(t, -600), quiet);
});

test('期限前 32 毫秒已发布的完整静止证明应能送达复位调用方', async t => {
  assert.deepEqual(await readProof(t, -32), quiet);
});

test('期限后 32 毫秒才发布的证明会留在邮箱，本次复位仍缺证', async t => {
  assert.deepEqual(await readProof(t, 32), unconfirmed);
});

test('探针超时重试后，伴随进程报出的完整证明应在当次复位的有效期内送达', async t => {
  let now = Date.parse('2026-11-26T05:37:14.620Z');
  const clock = () => now;
  const box = await Mailbox.open(await tempRoot(t), clock);
  let attempts = 0;
  const companion = new Companion({
    cfg: { wslExe: 'fixture-wsl', distribution: 'fixture' }, mailbox: box, clock,
    run: async (_argv, { timeoutMs }) => {
      attempts += 1;
      // 合成的宿主耗时。前两次超时后各花 20 秒确认树归零，末次读到完整证明。
      if (attempts <= 2 || timeoutMs < 20_032) {
        now += timeoutMs + 20_000;
        return { code: null, timedOut: true, tree: 'zero' };
      }
      now += 20_032;
      return { code: 0, stdout: JSON.stringify({ ...quiet, pendingJobsQuiet: true }) };
    },
  });
  let request;
  const service = mailboxCompanion(box, async ms => {
    if (request) { now += ms; return; }
    [request] = await box.pending();
    // 此步结束前没有应答文件，中间各次空轮询均可跳过。
    await companion.step();
  });
  const received = await service.linuxQuiescence(null);
  const response = await box.poll(request);
  assert.equal(attempts, 3);
  assert.deepEqual(received, quiet);
  const reported = response.ok && response.proof ? response.proof : unconfirmed;
  const offset = Date.parse(response.observedAt) - Date.parse(request.deadline);
  assert.deepEqual(received, reported, `伴随进程与复位调用方的证明不同，应答相对期限 ${offset} 毫秒`);
  if (received.linuxUnitsInactive && received.containersZero) assert.ok(offset <= 0);
});

const batchId = '0123456789abcdef-123456789abc';
const cfg = { wslExe: 'fixture-wsl', distribution: 'fixture' };
const good = { code: 0, stdout: JSON.stringify({ ...quiet, pendingJobsQuiet: true }) };

for (const [title, room, host, elapsed, limits, code] of [
  ['排队后余量 24999 毫秒不启动', 24_999, good, 0, [], 'QUIESCENCE_BUDGET_INSUFFICIENT'],
  ['排队后余量 25000 毫秒按实限启动', 25_000, good, 0, [25_000], null],
  ['信封已过期不启动', -70_001, good, 0, [], 'COMPANION_REQUEST_EXPIRED'],
  ['超时未报告树只调用一次', 70_000, { timedOut: true }, 0, [30_000], 'QUIESCENCE_PROBE_UNCONFIRMED'],
  ['超时树未清只调用一次', 70_000, { timedOut: true, tree: 'unconfirmed' }, 0, [30_000], 'QUIESCENCE_PROBE_UNCONFIRMED'],
  ['宿主超期交回双真仍过期', 25_000, good, 95_001, [25_000], 'QUIESCENCE_RESULT_EXPIRED'],
]) test(title, async t => {
  let now = 0;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const request = await box.send('linux-quiescence', { batchId }, 210_000);
  now = 210_000 - 70_000 - room;
  const calls = [];
  const c = new Companion({ cfg, mailbox: box, clock: () => now, run: async (_a, options) => {
    calls.push(options.timeoutMs);
    now += elapsed;
    return host;
  } });
  await c.step();
  const answer = await box.poll(request);
  assert.deepEqual([calls, answer.code, answer.ok], [limits, code, code === null]);
});

for (const [title, wake, mutation, accepted] of [
  ['恰在期限发布', 0, null, true],
  ['晚醒 500 毫秒凭据仍可验证', 500, null, true],
  ['晚醒 501 毫秒失效', 501, null, false],
  ['截止前实收兼容旧版无凭据', -1, 'missing', true],
  ['末读无凭据', 1, 'missing', false],
  ['末读错请求号', 1, 'id', false],
  ['末读错动作', 1, 'kind', false],
  ['末读错摘要', 1, 'hash', false],
  ['末读改名前正文时间早，发布已晚', 32, 'late', false],
  ['发布取样时钟回拨', 32, 'backward', false],
]) test(title, async t => {
  let now = 0;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const req = await box.send('linux-quiescence', { batchId }, 1000);
  now = mutation === 'late' ? 990 : 999 + Number(wake === 0);
  if (mutation === 'late') {
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (to === path.join(box.responses, req.requestId + '.json')) now = 1010;
      return rename(from, to);
    });
  }
  await box.respond(req, { ok: true, proof: quiet });
  const file = path.join(box.responses, req.requestId + '.published.json');
  if (mutation && mutation !== 'late') {
    if (mutation === 'missing') await fs.rm(file, { force: true });
    else {
      const receipt = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
      if (mutation === 'id') receipt.requestId = '00000000-0000-4000-8000-000000000001';
      if (mutation === 'kind') receipt.kind = 'pr-head';
      if (mutation === 'hash') receipt.sha256 = '0'.repeat(64);
      if (mutation === 'backward') receipt.publishedAt = -1;
      await fs.writeFile(file, JSON.stringify(receipt));
    }
  }
  now = 1000 + wake;
  const answer = await box.await(req, async () => assert.fail('末读不可再睡'));
  assert.equal(answer?.ok === true, accepted);
});

test('末读取完之后再核 500 毫秒上限', async t => {
  let now = 0;
  const box = await Mailbox.open(await tempRoot(t), () => now);
  const req = await box.send('linux-quiescence', { batchId }, 1000);
  now = 995;
  await box.respond(req, { ok: true, proof: quiet });
  // 时钟跨在读取两端。即使一开始仍在期限内，校验完已过末读上限。
  let reads = 0;
  box.clock = () => (++reads === 1 ? 999 : 1501);
  assert.equal(await box.await(req, async () => assert.fail('不再等待')), null);

  // 壁钟停住时，单调预算仍在创建信封的时刻起算，包括发布请求的开销。
  let mono = 0;
  const frozen = await Mailbox.open(await tempRoot(t), () => 0, () => mono);
  const sent = await frozen.send('linux-quiescence', { batchId }, 1000);
  await frozen.respond(sent, { ok: true, proof: quiet });
  mono = 1501;
  assert.equal(await frozen.await(sent, async () => assert.fail('单调期限已过')), null);
});
