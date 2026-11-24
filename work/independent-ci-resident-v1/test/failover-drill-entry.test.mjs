// 第 18 代故障转移演练的编排入口（任务 04f9b91b；定案 D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md 第 1 节第 1、2、10 条
// 与第 2 节 E3；独立复核 D:/w/tmp/claude-review-failover-drill-gen18-fable.md M3）。
// 读数用桩（形状取自 11-24 的真实只读读数，见 failover-drill-fixtures.mjs）；不联网、不读库、不碰节点。
//   - 只有全过才写放行文件，内容恰为演练编号；FAIL 退出 1、未判定退出 3，都不写
//   - 读不到（重试后仍抛）判未判定；快照或 status.json 不新鲜判未判定
//   - --release 可选：不给只判不写；--source 必填且是 64 位十六进制；--in 已去掉
//   - snapshotSql：绑定号与时刻不合格就抛错；sql 子命令打印它
//   - verdict：多个 --snap 拼成判定输入（回执按 id 去重、当班答复取并集、每个快照一条排除原因与 steady_since）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { drillInputFrom, main, readSnapshot, snapshotSql } from '../drill/failover-drill.mjs';
import { clone, DESK, drillParts, gateParts, handoverReceipt, NOW, READINGS, SOURCE, TURING } from './failover-drill-fixtures.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-drill-entry-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;

// MCP 的返回原样存盘：[{ "snapshot": { ... } }]
const mcpFile = (dir, name, snap) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify([{ snapshot: snap }])); return f; };
const jsonFile = (dir, name, v) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(v)); return f; };

function readersFrom(idle, { throwOn } = {}) {
  const fail = key => { if (throwOn === key) throw new Error(`${key} unreachable`); };
  return {
    runs: async status => { fail('runs'); return status === 'queued' ? idle.runsQueued : idle.runsInProgress; },
    prs: async () => { fail('prs'); return idle.prs; },
    shadow: async () => { fail('shadow'); return idle.shadow; },
    vms: async () => { fail('vms'); return idle.vms; },
  };
}

function gateCase({ mutate = () => {}, release = true, throwOn, extra = [] } = {}) {
  const dir = path.join(tmp, `g${++n}`); fs.mkdirSync(dir);
  const g = gateParts(); mutate(g);
  const releaseFile = path.join(dir, 'release-gen18-t.txt');
  const argv = ['gate', '--drill-id', 'gen18-t', '--snap', mcpFile(dir, 'snap.json', g.snapshot),
    '--status-turing', jsonFile(dir, 'st.json', g.statusTuring), '--status-desk', jsonFile(dir, 'sd.json', g.statusDesk),
    '--turing', g.turing, '--desk', g.desk, '--source', g.source, '--shadow-prs', '1292-', '--out-dir', dir,
    ...(release ? ['--release', releaseFile] : []), ...extra];
  const lines = [];
  return { dir, releaseFile, run: () => main(argv, { readers: readersFrom(g.idle, { throwOn }), now: () => Date.parse(NOW), sleep: async () => {}, write: l => lines.push(l) }), lines };
}

test('gate: all checks pass → exit 0 and the release file holds exactly the drill id', async () => {
  const c = gateCase();
  assert.equal(await c.run(), 0, c.lines.join('\n'));
  assert.equal(fs.readFileSync(c.releaseFile, 'utf8'), 'gen18-t');
  const out = JSON.parse(fs.readFileSync(path.join(c.dir, 'failover-drill-gen18-t-gate.json'), 'utf8'));
  assert.equal(out.verdict, 'PASS');
});

test('gate: any FAIL → exit 1 and no release file', async () => {
  const c = gateCase({ mutate: g => { g.idle.runsInProgress = READINGS.runsInProgress; } });
  assert.equal(await c.run(), 1, c.lines.join('\n'));
  assert.equal(fs.existsSync(c.releaseFile), false);
});

test('gate: a reader that still throws after retrying → undetermined (exit 3), no release file', async () => {
  for (const throwOn of ['runs', 'prs', 'shadow', 'vms']) {
    const c = gateCase({ throwOn });
    assert.equal(await c.run(), 3, `${throwOn}: ${c.lines.join('\n')}`);
    assert.equal(fs.existsSync(c.releaseFile), false, throwOn);
  }
});

test('gate M3: an old snapshot or status.json → undetermined (exit 3), no release file', async () => {
  for (const mutate of [g => { g.snapshot.server_time = '2026-11-24T13:10:00.000Z'; g.snapshot.page.observed_at = g.snapshot.server_time; },
    g => { g.statusTuring.writtenAt = '2026-11-24T13:00:00.000Z'; }]) {
    const c = gateCase({ mutate });
    assert.equal(await c.run(), 3, c.lines.join('\n'));
    assert.equal(fs.existsSync(c.releaseFile), false);
  }
});

test('gate item 1: without --release it only judges and writes no release file', async () => {
  const c = gateCase({ release: false });
  assert.equal(await c.run(), 0, c.lines.join('\n'));
  assert.equal(fs.existsSync(c.releaseFile), false);
});

test('gate: a snapshot taken for other bindings, a bad --source, or the removed --in is a usage error (exit 2)', async () => {
  const other = gateCase({ mutate: g => { g.snapshot.turing = '33333333-3333-4333-8333-333333333333'; } });
  assert.equal(await other.run(), 2);
  assert.equal(fs.existsSync(other.releaseFile), false);
  for (const extra of [['--source', 'abc'], ['--in', 'x.json']]) {
    const c = gateCase({ extra });
    assert.equal(await c.run(), 2, extra.join(' '));
    assert.equal(fs.existsSync(c.releaseFile), false);
  }
});

test('E3: the runs reader asks gh for event and 50 rows', async () => {
  const { defaultReaders } = await import('../drill/failover-drill.mjs');
  const calls = [];
  const r = defaultReaders({ exec: async (file, args) => { calls.push([file, ...args]); return { stdout: '[]' }; } });
  await r.runs('queued');
  const argv = calls[0].join(' ');
  assert.match(argv, /--limit 50\b/);
  assert.match(argv, /--json \S*\bevent\b/);
});

test('snapshotSql: bad binding ids or times throw; good ones are embedded as typed literals', () => {
  const since = '2026-11-25T03:40:00Z';
  for (const bad of [{ turing: 'x', desk: DESK, since }, { turing: TURING, desk: `${DESK}'; drop table x; --`, since },
    { turing: TURING, desk: DESK, since: 'yesterday' }, { turing: TURING, desk: DESK, since: "2026-11-25T03:40:00Z' or '1'='1" }, { turing: TURING, desk: TURING, since }]) {
    assert.throws(() => snapshotSql(bad), JSON.stringify(bad));
  }
  const sql = snapshotSql({ turing: TURING, desk: DESK, since });
  for (const want of [`'${TURING}'::uuid`, `'${DESK}'::uuid`, `'${since}'::timestamptz`, 'steady_since', 'ci_failover_exclusion_v1', 'ci_failover_candidates_v1',
    'ci_duty_answers_v1', 'clued_audit_receipts', 'ci_failover_nodes_v1', 'binding_role_holders_v1']) assert.ok(sql.includes(want), want);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|grant)\b/i);
});

test('sql subcommand prints the snapshot SQL and exits 0', async () => {
  const lines = [];
  assert.equal(await main(['sql', '--turing', TURING, '--desk', DESK, '--since', '2026-11-25T03:40:00Z'], { write: l => lines.push(l) }), 0);
  assert.ok(lines.join('\n').includes(`'${TURING}'::uuid`));
  assert.equal(await main(['sql', '--turing', 'x', '--desk', DESK, '--since', '2026-11-25T03:40:00Z'], { write: () => {} }), 2);
});

test('readSnapshot accepts the MCP row array, a bare row and the bare snapshot', () => {
  const s = drillParts().snapshots[0];
  for (const text of [JSON.stringify([{ snapshot: s }]), JSON.stringify({ snapshot: s }), JSON.stringify(s), JSON.stringify([{ snapshot: JSON.stringify(s) }])]) {
    assert.equal(readSnapshot(text).server_time, s.server_time);
  }
  assert.throws(() => readSnapshot('[]'));
  assert.throws(() => readSnapshot('{"x":1}'));
});

test('drillInputFrom: receipts deduplicated by id, duty answers unioned, one exclusion row per snapshot', () => {
  const d = drillParts();
  const second = handoverReceipt({}, 'a0000000-0000-4000-8000-000000000002');
  d.snapshots[1].receipts = [...d.snapshots[1].receipts, second];
  const input = drillInputFrom(d);
  assert.deepEqual(input.receipts.map(r => r.id).sort(), [d.snapshots[0].receipts[0].id, second.id].sort());
  const keys = input.dutyAnswers.map(a => `${a.binding_id}@${a.at}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(input.dutyAnswers.length, d.snapshots[1].duty_answers.length);
  assert.deepEqual(input.exclusions, d.snapshots.map(s => ({ at: s.server_time, exclusion: s.exclusion, steadySince: s.turing_liveness.steady_since })));
  assert.equal(input.pages.length, 2);
});

test('verdict: several --snap files on the real 11-15 pace → exit 0', async () => {
  const dir = path.join(tmp, `v${++n}`); fs.mkdirSync(dir);
  const d = drillParts();
  const argv = ['verdict', '--drill-id', 'gen18-t', '--turing', TURING, '--desk', DESK,
    ...d.snapshots.flatMap((s, i) => ['--snap', mcpFile(dir, `s${i}.json`, s)]),
    '--cut', jsonFile(dir, 'cut.json', d.cut), '--status-turing', jsonFile(dir, 'st.json', d.statusTuring), '--status-desk', jsonFile(dir, 'sd.json', d.statusDesk), '--out-dir', dir];
  const lines = [];
  assert.equal(await main(argv, { write: l => lines.push(l) }), 0, lines.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'failover-drill-gen18-t-verdict.json'), 'utf8')).verdict, 'PASS');
  assert.equal(SOURCE.length, 64);
  assert.ok(clone);
});
