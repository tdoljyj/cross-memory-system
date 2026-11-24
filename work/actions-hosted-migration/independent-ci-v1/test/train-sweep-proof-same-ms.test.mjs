// 看板缺陷：同一毫秒写出两条内容不同的 sweep proof 后列车永久 TRAIN_SWEEP_INCOMPLETE、不自愈。
// 真实维护（runTrain）、真实 TrainSweepStore（临时目录）、离线 GitHub/Native 夹具；每轮重开 store，与生产每个阶段进程各开一次一致。
// 卡死路径：train-sweep-store.mjs latestProofStrict（同毫秒两条含义不同即抛 TRAIN_SWEEP_PROOF_UNREADABLE）
// -> train-maintenance.mjs 读取段 catch 置 stateReason -> 证明写入段因 stateReason 跳过 -> proofWritten=false -> TRAIN_SWEEP_INCOMPLETE；
// 下一轮最新毫秒仍是这两条，循环不止。修复前第二个用例必红。
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
  const fresh = await TrainSweepStore.open(e.store.directory);
  await assert.rejects(fresh.latestProofStrict(), /TRAIN_SWEEP_PROOF_UNREADABLE/, '前置：同毫秒两条含义不同，严格读拒绝');
  // 时钟照常前进，跑三轮：应当至少有一轮重新写出 proof、列车不再报 TRAIN_SWEEP_INCOMPLETE。
  const proofsBefore = (await fs.readdir(e.store.directory)).filter(n => n.startsWith('proof-')).length;
  const later = await rounds(e, 3);
  const last = later.at(-1);
  const proofsAfter = (await fs.readdir(e.store.directory)).filter(n => n.startsWith('proof-')).length;
  const strictRead = await TrainSweepStore.open(e.store.directory).then(s => s.latestProofStrict()).then(() => 'ok', err => err.code);
  assert.ok(last.proofWritten && last.decision !== 'TRAIN_SWEEP_INCOMPLETE',
    `列车未自愈（同毫秒 proof 冲突卡死）：${JSON.stringify(later)}；proof 文件 ${proofsBefore} -> ${proofsAfter}；严格读 ${strictRead}`);
});
