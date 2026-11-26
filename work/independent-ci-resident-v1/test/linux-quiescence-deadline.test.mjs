import test from 'node:test';
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
  assert.ok(attempts > 0);
  const reported = response.ok && response.proof ? response.proof : unconfirmed;
  const offset = Date.parse(response.observedAt) - Date.parse(request.deadline);
  assert.deepEqual(received, reported, `伴随进程与复位调用方的证明不同，应答相对期限 ${offset} 毫秒`);
  if (received.linuxUnitsInactive && received.containersZero) assert.ok(offset <= 0);
});
