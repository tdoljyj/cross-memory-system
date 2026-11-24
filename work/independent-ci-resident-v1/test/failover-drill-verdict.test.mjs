// 第 18 代故障转移演练的判定模块（任务 04f9b91b；方案 D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 4、6、7 节，
// 定案 D:/w/tmp/PLAN-failover-drill-gen18-addendum-20261124.md 第 1 节第 2、5、6、9、10 条与第 2 节 E1–E4，
// 独立复核 D:/w/tmp/claude-review-failover-drill-gen18-fable.md M4）。
// 夹具见 failover-drill-fixtures.mjs：空闲读数与 status.json 取自 11-24 的真实只读读数，快照与 snapshotSql 的返回同形，
// 演练时间线是 11-15 的真实节奏（复网 5 分钟后才健康）。它必须 PASS；每个反例必须不 PASS；读不到的一项判“未判定”，不判 PASS。
import assert from 'node:assert/strict';
import test from 'node:test';
import { drillInputFrom, gateInputFrom } from '../drill/failover-drill.mjs';
import { drillVerdict, gateVerdict, RULES } from '../drill/failover-drill-verdict.mjs';
import { alertOf, at, clone, DESK, drillParts, gateParts, handoverReceipt, HANDOVER, node, page, plus, READINGS, RESTORED, snapshot, SOURCE, STEADY, T0, TURING } from './failover-drill-fixtures.mjs';

const gate = parts => gateVerdict(gateInputFrom(parts));
const drill = parts => drillVerdict(drillInputFrom(parts));
const notPass = (r, id) => {
  assert.notEqual(r.verdict, 'PASS', `${id}: ${JSON.stringify(r.checks[id])}`);
  assert.notEqual(r.checks[id]?.ok, true, `${id}: ${JSON.stringify(r.checks[id])}`);
};
const IDLE_IDS = ['I1', 'I2', 'I3', 'I4', 'I5'];

test('gate: every A and I check passes on an idle train with TURING on duty (real-shaped readings)', () => {
  const r = gate(gateParts());
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks));
  for (const id of ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', ...IDLE_IDS]) assert.equal(r.checks[id]?.ok, true, `${id}: ${JSON.stringify(r.checks[id])}`);
});

test('gate: I6 (a hand-filled push list) is gone; A7 covers I1-I5', () => {
  const r = gate(gateParts());
  assert.equal(r.checks.I6, undefined);
  assert.match(r.checks.A7.why, /^(?!.*I6)/);
});

test('gate E1: the standing resident-queue (info only) PENDING status does not block; an unfinished CheckRun does', () => {
  const g = gateParts();
  const info = g.idle.prs.find(p => p.number === 1292);
  assert.ok(info.statusCheckRollup.some(c => c.__typename === 'StatusContext' && c.state === 'PENDING' && /info only/.test(c.context)));
  assert.equal(gate(g).checks.I2.ok, true, JSON.stringify(gate(g).checks.I2));
  const busy = gateParts(); busy.idle.prs = READINGS.prs;      // #1298 has an IN_PROGRESS CheckRun
  notPass(gate(busy), 'I2');
});

test('gate E2: I3 reads summary.counts and summary.pendingMergedHeads of the real shadow-compare output', () => {
  const real = gateParts(); real.idle.shadow = clone(READINGS.shadow);    // sampled: 在跑 4
  notPass(gate(real), 'I3');
  const merged = gateParts(); merged.idle.shadow.summary.pendingMergedHeads = 1;
  notPass(gate(merged), 'I3');
});

test('gate E3: scheduled and dispatched runs do not block; pull_request and push runs do', () => {
  const g = gateParts();
  assert.ok(g.idle.runsQueued.length > 0);
  assert.equal(gate(g).checks.I1.ok, true, JSON.stringify(gate(g).checks.I1));
  const pr = gateParts(); pr.idle.runsInProgress = READINGS.runsInProgress;    // sampled: three pull_request runs
  notPass(gate(pr), 'I1');
  const push = gateParts(); push.idle.runsQueued = [{ ...READINGS.runsQueued[0], event: 'push' }];
  notPass(gate(push), 'I1');
});

test('gate item 5: I4 reads current and queue.live, not the display rows in pending', () => {
  const g = gateParts();
  assert.ok(g.statusTuring.pending.length > 0);
  assert.equal(gate(g).checks.I4.ok, true, JSON.stringify(gate(g).checks.I4));
  const live = gateParts(); live.statusTuring.queue.live = 61;
  notPass(gate(live), 'I4');
  const cur = gateParts(); cur.statusTuring.current = { pr: 1298, headSha: 'a'.repeat(40) };
  notPass(gate(cur), 'I4');
});

test('gate item 10: A1 compares the Source with --source, not the generation', () => {
  const g = gateParts(); g.statusTuring.versions.generation = 16;    // the two nodes have different install histories
  assert.equal(gate(g).checks.A1.ok, true, JSON.stringify(gate(g).checks.A1));
  assert.equal(RULES.generation, undefined);
  const other = gateParts(); other.source = 'b'.repeat(64);
  notPass(gate(other), 'A1');
  const local = gateParts(); local.statusDesk.versions.windows.ciSourceManifestSha256 = 'b'.repeat(64);
  notPass(gate(local), 'A1');
  const reported = gateParts(); reported.snapshot.page.nodes[0].node.ci_source_manifest_sha256 = 'b'.repeat(64);
  notPass(gate(reported), 'A1');
  const inconsistent = gateParts(); inconsistent.statusTuring.versions.consistent = false;
  notPass(gate(inconsistent), 'A1');
});

test('gate M3: a stale snapshot or status.json is undetermined, never released', () => {
  for (const mutate of [g => { g.snapshot.server_time = plus(g.now, -600); g.snapshot.page.observed_at = plus(g.now, -600); },
    g => { g.statusTuring.writtenAt = plus(g.now, -600); }, g => { g.statusDesk.writtenAt = plus(g.now, -600); }, g => { delete g.now; }]) {
    const g = gateParts(); mutate(g);
    const r = gate(g);
    assert.equal(r.verdict, 'UNDETERMINED', JSON.stringify(r.checks.A0));
    assert.equal(r.checks.A0.ok, null);
  }
});

test('gate 补充三 S1: live reads that finish more than 120 s after the gate started, or no finish time, are undetermined', () => {
  for (const mutate of [g => { g.finishedAt = plus(g.now, 180); }, g => { delete g.finishedAt; }]) {
    const g = gateParts(); mutate(g);
    const r = gate(g);
    notPass(r, 'A0');
    assert.equal(r.checks.A0.ok, null, JSON.stringify(r.checks.A0));
    assert.equal(r.verdict, 'UNDETERMINED');
  }
  const g = gateParts(); g.finishedAt = plus(g.now, 180);
  assert.match(gate(g).checks.A0.why, /现读耗时 180 秒/);
});

test('gate: a busy train or an unfit node is never released', () => {
  const cases = [
    ['A1', g => { g.statusDesk.versions.selfcheck.result = 'FAIL'; }],
    ['A2', g => { g.snapshot.page.holders.push({ binding_id: DESK, purpose: 'resident-node' }); }],
    ['A3', g => { g.snapshot.page.nodes[0].node.readable_state = 'INTAKE_PAUSED'; }],
    ['A3', g => { g.snapshot.page.nodes[0].node.last_heartbeat_at = plus(g.now, -600); }],
    ['A4', g => { g.snapshot.page.nodes[1].node.unhealthy_since = plus(g.now, -900); }],
    ['A5', g => { g.snapshot.candidates[0].eligible = false; g.snapshot.candidates[0].reasons = ['auto_handed_out']; }],
    ['A6', g => { g.snapshot.page.setting.enabled = false; }],
    ['A6', g => { g.snapshot.page.rules.rejoin_steady_minutes = 60; }],
    ['A6', g => { g.snapshot.page.watchdog.stale = true; }],
    ['I5', g => { g.idle.vms[0].State = 'Running'; }],
  ];
  for (const [id, mutate] of cases) {
    const g = gateParts(); mutate(g);
    const r = gate(g);
    notPass(r, id);
    if (id.startsWith('I')) assert.notEqual(r.checks.A7.ok, true, `A7 follows ${id}`);
  }
});

test('gate: a read that is missing is undetermined, not released', () => {
  for (const drop of [g => { delete g.snapshot.candidates; }, g => { delete g.snapshot; }, g => { delete g.idle.shadow; }, g => { delete g.idle.vms; }, g => { delete g.statusTuring; }]) {
    const g = gateParts(); drop(g);
    const r = gate(g);
    assert.equal(r.verdict, 'UNDETERMINED', JSON.stringify(r.checks));
  }
});

test('drill item 9: the real 11-15 pace (healthy only 5 minutes after reconnecting) passes B1-B11', () => {
  const r = drill(drillParts());
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks));
  for (let i = 1; i <= 11; i++) assert.equal(r.checks[`B${i}`].ok, true, `B${i}: ${JSON.stringify(r.checks[`B${i}`])}`);
  assert.deepEqual(RULES.rejoinedMinutes, [31, 40]);
});

test('drill item 9: still auto_handed_out at steady_since + 32 minutes is a FAIL', () => {
  const d = drillParts();
  d.snapshots.push(snapshot(plus(STEADY, 32 * 60), { ...d.snapshots[1], page: { ...d.snapshots[1].page, observed_at: plus(STEADY, 32 * 60) },
    steady: STEADY, receipts: d.snapshots[1].receipts, duty: d.snapshots[1].duty_answers, exclusion: 'auto_handed_out' }));
  const r = drill(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B9');
});

test('drill item 9: no snapshot read inside the B8 or B9 window is undetermined', () => {
  const early = drillParts(); early.snapshots = early.snapshots.slice(1);
  assert.equal(drill(early).checks.B8.ok, null, JSON.stringify(drill(early).checks.B8));
  const late = drillParts(); late.snapshots = late.snapshots.slice(0, 1);
  assert.equal(drill(late).checks.B9.ok, null, JSON.stringify(drill(late).checks.B9));
});

test('drill item 2: B4 — DESK\'s first duty answer later than the anchor + 2 minutes is not a pass', () => {
  const d = drillParts();
  for (const s of d.snapshots) s.duty_answers = s.duty_answers.filter(a => a.binding_id !== DESK).concat([{ binding_id: DESK, at: plus(HANDOVER, 200) }]);
  notPass(drill(d), 'B4');
});

test('drill item 2: B4 — DESK not the sole active holder in the last snapshot is not a pass', () => {
  const d = drillParts(); d.snapshots[1].page.holders.push({ binding_id: TURING, purpose: 'resident-node' });
  notPass(drill(d), 'B4');
});

test('drill item 2: B6 — steady_since later than reconnect + 10 minutes is not a pass', () => {
  const d = drillParts();
  for (const s of d.snapshots) s.turing_liveness.steady_since = plus(RESTORED, 11 * 60);
  notPass(drill(d), 'B6');
});

test('drill item 2: B6 — TURING not standby in the last snapshot is not a pass', () => {
  const d = drillParts(); Object.assign(d.snapshots[1].page.nodes[0].node, { state: 'HALTED', readable_state: 'HALTED', halt: { code: 'X' } });
  const r = drill(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B6');
  notPass(r, 'B7');
});

test('drill item 2: the last snapshot missing is undetermined', () => {
  const d = drillParts(); d.snapshots = [];
  const r = drill(d);
  for (const id of ['B4', 'B6', 'B7', 'B8', 'B9']) assert.equal(r.checks[id].ok, null, `${id}: ${JSON.stringify(r.checks[id])}`);
  assert.notEqual(r.verdict, 'PASS');
});

test('drill M4: a second handover seen only on a later page (receipt list read earlier) is not a pass', () => {
  const d = drillParts();
  const back = handoverReceipt({ from_binding_id: DESK, to_binding_id: TURING }, 'a0000000-0000-4000-8000-000000000002');
  back.created_at = at('04:30:00');
  d.snapshots[1].receipts = d.snapshots[0].receipts;        // as if the receipts were read at T0+15 only
  d.snapshots[1].page.alerts.unshift(alertOf(back));
  const r = drill(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B1');
  notPass(r, 'B7');
});

test('drill: the same handover in receipts and on pages counts once', () => {
  const d = drillParts();
  const r = drill(d);
  assert.equal(r.checks.B1.ok, true, JSON.stringify(r.checks.B1));
});

test('drill: no receipt is not a pass', () => {
  const d = drillParts();
  for (const s of d.snapshots) { s.receipts = []; s.page.alerts = []; }
  const r = drill(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B1');
});

test("drill: trigger 'halted' is not a pass (the #1230 regression)", () => {
  const d = drillParts();
  const h = handoverReceipt({ trigger: 'halted' });
  for (const s of d.snapshots) { s.receipts = [h]; s.page.alerts = [alertOf(h)]; }
  const r = drill(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B1');
});

test('drill: from and to the wrong way round is not a pass', () => {
  const d = drillParts();
  const h = handoverReceipt({ from_binding_id: DESK, to_binding_id: TURING });
  for (const s of d.snapshots) { s.receipts = [h]; s.page.alerts = [alertOf(h)]; }
  notPass(drill(d), 'B1');
});

test('drill: a withheld or no-target alert in the window is not a pass', () => {
  const d = drillParts();
  d.snapshots[1].page.alerts.push({ receipt_id: 'a0000000-0000-4000-8000-000000000009', receipt_kind: 'CI_ADMISSION_FAILOVER_WITHHELD', created_at: at('03:56:00'), reason: 'receiver_not_alive' });
  notPass(drill(d), 'B7');
});

test('drill: a handover that takes effect 5 minutes later is undetermined (phase), neither PASS nor FAIL', () => {
  const d = drillParts();
  const h = handoverReceipt({ effective_at: plus(HANDOVER, 300) });
  for (const s of d.snapshots) {
    s.receipts = [h]; s.page.alerts = [alertOf(h)];
    s.duty_answers = s.duty_answers.filter(a => a.binding_id !== DESK).concat([{ binding_id: DESK, at: plus(HANDOVER, 340) }]);
  }
  const r = drill(d);
  assert.equal(r.verdict, 'UNDETERMINED', JSON.stringify(r.checks));
  assert.equal(r.checks.B3.ok, null);
  assert.match(r.checks.B3.why, /相位/);
  assert.equal(r.checks.B4.ok, true, JSON.stringify(r.checks.B4));
});

test('drill: a handover too early or too late after the last heartbeat is not a pass', () => {
  for (const last of [at('03:53:00'), at('03:50:00')]) {
    const d = drillParts();
    const h = handoverReceipt({ holder_last_heartbeat_at: last });
    for (const s of d.snapshots) s.receipts = [h];
    notPass(drill(d), 'B2');
  }
});

test('drill: DESK never answering on duty is not a pass', () => {
  const d = drillParts();
  for (const s of d.snapshots) s.duty_answers = [{ binding_id: DESK, at: at('03:50:00') }];
  const r = drill(d);
  notPass(r, 'B5');
  notPass(r, 'B4');
});

test('drill: the cut script not having restored everything is not a pass', () => {
  for (const mutate of [c => { c.enableFailed = ['Ethernet']; }, c => { c.backstopRemoved = false; }, c => { c.connected = false; }, c => { c.outcome = 'CUT_INTERRUPTED'; }]) {
    const d = drillParts(); mutate(d.cut);
    notPass(drill(d), 'B10');
  }
});

test('drill: every missing read is undetermined, never PASS', () => {
  const drops = {
    B1: d => { for (const s of d.snapshots) { delete s.receipts; delete s.page.alerts; } },
    B5: d => { for (const s of d.snapshots) delete s.duty_answers; },
    B7: d => { d.snapshots = d.snapshots.slice(0, 1); },
    B10: d => { delete d.cut; },
    B11: d => { delete d.statusDesk; },
  };
  for (const [id, drop] of Object.entries(drops)) {
    const d = drillParts(); drop(d);
    const r = drill(d);
    assert.equal(r.checks[id].ok, null, `${id}: ${JSON.stringify(r.checks[id])}`);
    assert.notEqual(r.verdict, 'PASS', id);
  }
  assert.equal(drillVerdict({}).verdict, 'UNDETERMINED');
  assert.equal(drillVerdict(null).verdict, 'UNDETERMINED');
});

// 防止夹具和断言各说各话：基线夹具确实是“复网 5 分钟后才健康”
test('fixture sanity: steady_since is 5 minutes after reconnect and the last snapshot is at T0 + 45 minutes', () => {
  assert.equal(Date.parse(STEADY) - Date.parse(RESTORED), 5 * 60_000);
  assert.ok(Date.parse(drillParts().snapshots.at(-1).server_time) >= Date.parse(T0) + 45 * 60_000);
  assert.ok(SOURCE.match(/^[0-9a-f]{64}$/));
  assert.ok(page && node);
});
