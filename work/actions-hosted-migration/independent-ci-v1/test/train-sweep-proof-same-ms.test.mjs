// 看板缺陷：同一毫秒写出两条内容不同的 sweep proof 后列车永久 TRAIN_SWEEP_INCOMPLETE、不自愈。
// 真实维护（runTrain）、真实 TrainSweepStore（临时目录）、离线 GitHub/Native 夹具；每轮重开 store，与生产每个阶段进程各开一次一致。
// 卡死路径：train-sweep-store.mjs latestProofStrict（同毫秒两条含义不同即抛 TRAIN_SWEEP_PROOF_UNREADABLE）
// -> train-maintenance.mjs 读取段 catch 置 stateReason -> 证明写入段因 stateReason 跳过 -> proofWritten=false -> TRAIN_SWEEP_INCOMPLETE；
// 下一轮最新毫秒仍是这两条，循环不止。修复前第二、三、四个用例必红。
// 设计（FABLE-backlog-batch-design-20261124 第 2 节）：写入口让时间戳全仓严格递增；不给已经卡住的目录做解救路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, iso, jobOf, SOURCE, NOW } from './train-strict-fixtures.mjs';
import { TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';

const healthy = { nodes: [{ node: { name: 'turing', sourceManifestSha256: SOURCE, state: 'ACTIVE', lastHeartbeatAt: iso(NOW) } }] };
const OTHER_RUN = 'fedcba9876543210-fedcba987654';
const runIdOf = n => `${n.toString(16).padStart(16, '0')}-0123456789ab`;

async function rounds(e, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    e.now += 600_000;
    e.store = await TrainSweepStore.open(e.store.directory);
    const r = await e.run(jobOf({ createdAt: iso(e.now), runId: runIdOf(i) }));
    out.push({ decision: r.facts.decision, proofWritten: r.facts.sweep.proofWritten });
  }
  return out;
}

test('同毫秒对照：没有冲突时后续每轮都写出 proof、不报 TRAIN_SWEEP_INCOMPLETE', async t => {
  const e = await setup(t, { strict: true, fullDone: false, native: healthy, tick: 1 });
  const first = await e.run();
  assert.equal(first.facts.sweep.proofWritten, true, JSON.stringify(first.facts));
  const later = await rounds(e, 3);
  assert.ok(later.every(r => r.proofWritten && r.decision !== 'TRAIN_SWEEP_INCOMPLETE'), JSON.stringify(later));
});

test('同毫秒两条内容不同的 sweep proof 后，列车在后续轮次自愈', async t => {
  const e = await setup(t, { strict: true, fullDone: false, native: healthy, tick: 1 });
  // 第一位写者：真实维护轮写出 proof。
  const first = await e.run();
  assert.equal(first.facts.sweep.proofWritten, true, JSON.stringify(first.facts));
  const mine = await e.store.latestProof();
  // 第二位写者（并发的另一轮）在同一毫秒写出含义不同的 proof：时钟钉死在 mine.writtenAt。
  const { contract: _contract, ...rest } = mine;
  await e.store.appendProof({ ...rest, runId: OTHER_RUN, prUpdatedCursor: iso(Date.parse(mine.prUpdatedCursor) - 1000) });
  // 第二位写者走的是仓的唯一写入口：修复前它与第一条同毫秒、严格读拒绝；修复后写入口把它排到第一条之后。
  // 时钟照常前进，跑三轮：应当至少有一轮重新写出 proof、列车不再报 TRAIN_SWEEP_INCOMPLETE。
  const proofsBefore = (await fs.readdir(e.store.directory)).filter(n => n.startsWith('proof-')).length;
  const later = await rounds(e, 3);
  const last = later.at(-1);
  const proofsAfter = (await fs.readdir(e.store.directory)).filter(n => n.startsWith('proof-')).length;
  const strictRead = await TrainSweepStore.open(e.store.directory).then(s => s.latestProofStrict()).then(() => 'ok', err => err.code);
  assert.ok(last.proofWritten && last.decision !== 'TRAIN_SWEEP_INCOMPLETE',
    `列车未自愈（同毫秒 proof 冲突卡死）：${JSON.stringify(later)}；proof 文件 ${proofsBefore} -> ${proofsAfter}；严格读 ${strictRead}`);
});

const RUN_A = 'ffffffffffffffff-ffffffffffff', RUN_B = '0000000000000000-000000000000';
const landing = (writtenAt, runId, adopted) => ({ writtenAt, runId, bad: [], suspect: null, adopted: [adopted], handled: [] });

test('仓级：同一毫秒先后写两条含义不同的 proof、landing-state，读到的是后写的那条', async t => {
  const e = await setup(t, { strict: true, fullDone: false, native: healthy, tick: 1 });
  await e.run();
  const base = await e.store.latestProof();
  const { contract: _c, ...rest } = base;
  const at = iso(NOW + 3_600_000);
  await e.store.appendProof({ ...rest, writtenAt: at, runId: RUN_A, prUpdatedCursor: iso(NOW - 2000) });
  await e.store.appendProof({ ...rest, writtenAt: at, runId: RUN_B, prUpdatedCursor: iso(NOW - 1000) });
  const strict = await (await TrainSweepStore.open(e.store.directory)).latestProofStrict();
  assert.equal(strict.runId, RUN_B, '严格读返回后写的 proof');
  assert.equal(strict.prUpdatedCursor, iso(NOW - 1000));
  await e.store.writeLandingState(landing(at, RUN_A, 'a'.repeat(40)));
  await e.store.writeLandingState(landing(at, RUN_B, 'b'.repeat(40)));
  const state = await (await TrainSweepStore.open(e.store.directory)).readLandingState();
  assert.deepEqual(state.adopted, ['b'.repeat(40)], '非严格读同样返回后写的 landing-state');
});

test('时钟回拨：先在 T 写一条，再以 T-60 秒写一条，读到的是后写的那条', async t => {
  const e = await setup(t, { strict: true, fullDone: false, native: healthy, tick: 1 });
  const T = NOW + 7_200_000;
  await e.store.writeLandingState(landing(iso(T), RUN_B, 'a'.repeat(40)));
  await e.store.writeLandingState(landing(iso(T - 60_000), RUN_A, 'b'.repeat(40)));
  const state = await (await TrainSweepStore.open(e.store.directory)).readLandingState();
  assert.deepEqual(state.adopted, ['b'.repeat(40)], '回拨后写的那条仍是最新');
});
