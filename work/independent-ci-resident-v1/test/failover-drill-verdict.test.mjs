// 第 18 代故障转移演练的判定模块（任务 04f9b91b，D:/w/tmp/PLAN-failover-drill-gen18-20261124.md 第 4、6、7 节）。
// 夹具是 11-15 那次演练的时间线（北京 11:51:34 断、11:57:00 交接、11:57:51 当班、12:00 复网、12:05 待命；绑定号与
// 心跳时刻按时间线合成）。它必须 PASS；每个反例必须不 PASS；读不到的一项判“未判定”，不判 PASS。
import assert from 'node:assert/strict';
import test from 'node:test';
import { drillVerdict, gateVerdict } from '../drill/failover-drill-verdict.mjs';

const TURING = '11111111-1111-4111-8111-111111111111';
const DESK = '22222222-2222-4222-8222-222222222222';
const SOURCE = 'a'.repeat(64);
const at = (hhmmss, day = '2026-11-15') => `${day}T${hhmmss}.000Z`; // UTC；北京 = UTC+8
const plus = (iso, seconds) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const clone = v => structuredClone(v);

const T0 = at('03:51:34');          // 北京 11:51:34 断网
const HANDOVER = at('03:57:00');    // 北京 11:57:00 交接
const RESTORED = at('04:00:34');    // 断网 9 分钟后复网

function node({ mode, probe, heartbeat, state = 'NORMAL', halt = null, running = true, unhealthy = null, source = SOURCE }) {
  return { mode, probe, state, readable_state: state, halt, service_running: running, unhealthy_since: unhealthy,
    last_heartbeat_at: heartbeat, ci_source_manifest_sha256: source };
}
function page(observed, { holder, turing, desk, alerts = [] }) {
  return { status: 'ok', observed_at: observed,
    setting: { enabled: true }, rules: { silence_minutes: 5, unhealthy_minutes: 5, rejoin_steady_minutes: 30 },
    members: [{ binding_id: TURING, rank: 1 }, { binding_id: DESK, rank: 2 }],
    holders: [{ binding_id: holder, purpose: 'resident-node' }],
    nodes: [{ binding_id: TURING, node: turing }, { binding_id: DESK, node: desk }],
    watchdog: { last_tick_at: observed, stale: false }, alerts };
}
const status = ({ mode = 'ACTIVE', selfcheck = 'PASS', generation = 18, current = null, pending = [] } = {}) => ({
  executor: { state: 'IDLE' }, halt: null, paused: false, intakePause: null, node: { mode }, current, pending,
  versions: { generation, windows: { ciSourceManifestSha256: SOURCE }, selfcheck: { result: selfcheck } } });

const handoverReceipt = (over = {}) => ({ id: 'r-1', created_at: HANDOVER, operation: 'binding_role_handover',
  metadata: { receipt_kind: 'CI_ADMISSION_AUTO_HANDOVER', trigger: 'silence', from_binding_id: TURING, to_binding_id: DESK,
    holder_last_heartbeat_at: at('03:51:20'), effective_at: plus(HANDOVER, 0.02), ...over } });

function gateInput() {
  const observed = at('03:51:00');
  return {
    turing: TURING, desk: DESK,
    page: page(observed, { holder: TURING, turing: node({ mode: 'ACTIVE', probe: 'held', heartbeat: at('03:50:40') }),
      desk: node({ mode: 'STANDBY', probe: 'not-held', heartbeat: at('03:50:50') }) }),
    statusTuring: status(), statusDesk: status({ mode: 'STANDBY' }),
    candidates: [{ binding_id: DESK, eligible: true, reasons: [] }],
    idle: { runsInProgress: [], runsQueued: [], prs: [{ number: 1, isDraft: false, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] }],
      shadow: { counts: { 一致: 3, 在跑: 0 }, pendingMergedHeads: 0 }, vms: [{ Name: 'drill', State: 'Off' }], deskPushImminent: [] },
  };
}

function drillInput() {
  const turingDown = node({ mode: 'ACTIVE', probe: 'held', heartbeat: at('03:51:20') });
  const deskStandby = node({ mode: 'STANDBY', probe: 'not-held', heartbeat: at('03:57:30') });
  const deskActive = node({ mode: 'ACTIVE', probe: 'held', heartbeat: at('03:57:51') });
  const alerts = [{ receipt_kind: 'CI_ADMISSION_AUTO_HANDOVER', created_at: HANDOVER, from_binding_id: TURING, to_binding_id: DESK, trigger: 'silence' }];
  const pages = [
    page(at('03:54:34'), { holder: TURING, turing: turingDown, desk: node({ mode: 'STANDBY', probe: 'not-held', heartbeat: at('03:54:20') }) }),
    page(at('03:57:20'), { holder: DESK, turing: turingDown, desk: deskStandby, alerts }),
    page(at('03:57:51'), { holder: DESK, turing: turingDown, desk: deskActive, alerts }),
    // 12:05 北京：TURING 复网后待命、NORMAL、Source 与 DESK 相同
    page(at('04:05:00'), { holder: DESK, turing: node({ mode: 'STANDBY', probe: 'not-held', heartbeat: at('04:04:50') }),
      desk: node({ mode: 'ACTIVE', probe: 'held', heartbeat: at('04:04:55') }), alerts }),
    // T0+45 分钟：没有第 2 条交接、没有扣发
    page(at('04:37:00'), { holder: DESK, turing: node({ mode: 'STANDBY', probe: 'not-held', heartbeat: at('04:36:50') }),
      desk: node({ mode: 'ACTIVE', probe: 'held', heartbeat: at('04:36:55') }), alerts }),
  ];
  return {
    turing: TURING, desk: DESK,
    cut: { drillId: 'gen18', outcome: 'CUT_DONE', t0: T0, restoredAt: RESTORED, adapters: ['Ethernet'], enableFailed: [], connected: true, backstopRemoved: true },
    pages,
    receipts: [handoverReceipt()],
    dutyAnswers: [{ binding_id: TURING, at: at('03:51:10') }, { binding_id: DESK, at: at('03:57:51') }],
    exclusions: [{ at: plus(RESTORED, 20 * 60), value: 'auto_handed_out' }, { at: plus(RESTORED, 33 * 60), value: null }],
    statusTuring: status({ mode: 'STANDBY' }), statusDesk: status(),
  };
}

const notPass = (r, id) => {
  assert.notEqual(r.verdict, 'PASS', JSON.stringify(r.checks[id]));
  assert.notEqual(r.checks[id].ok, true, `${id}: ${JSON.stringify(r.checks[id])}`);
};

test('gate: every A and I check passes on an idle train with TURING on duty', () => {
  const r = gateVerdict(gateInput());
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks));
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6']) assert.equal(r.checks[id].ok, true, id);
});

test('gate: a busy train or an unfit node is never released', () => {
  const cases = [
    ['A1', g => { g.statusDesk.versions.selfcheck.result = 'FAIL'; }],
    ['A1', g => { g.statusTuring.versions.generation = 17; }],
    ['A1', g => { g.page.nodes[1].node.ci_source_manifest_sha256 = 'b'.repeat(64); }],
    ['A2', g => { g.page.holders.push({ binding_id: DESK, purpose: 'resident-node' }); }],
    ['A3', g => { g.page.nodes[0].node.readable_state = 'INTAKE_PAUSED'; }],
    ['A3', g => { g.page.nodes[0].node.last_heartbeat_at = at('03:48:00'); }],
    ['A4', g => { g.page.nodes[1].node.unhealthy_since = at('03:40:00'); }],
    ['A5', g => { g.candidates[0].eligible = false; g.candidates[0].reasons = ['auto_handed_out']; }],
    ['A6', g => { g.page.setting.enabled = false; }],
    ['A6', g => { g.page.rules.rejoin_steady_minutes = 60; }],
    ['A6', g => { g.page.watchdog.stale = true; }],
    ['I1', g => { g.idle.runsQueued = [{ databaseId: 9 }]; }],
    ['I2', g => { g.idle.prs[0].statusCheckRollup.push({ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }); }],
    ['I3', g => { g.idle.shadow.pendingMergedHeads = 1; }],
    ['I3', g => { g.idle.shadow.counts.在跑 = 2; }],
    ['I4', g => { g.statusTuring.pending = [{ pr: 5, state: 'PARKED' }]; }],
    ['I5', g => { g.idle.vms[0].State = 'Running'; }],
    ['I6', g => { g.idle.deskPushImminent = ['#1300']; }],
  ];
  for (const [id, mutate] of cases) {
    const g = gateInput(); mutate(g);
    const r = gateVerdict(g);
    notPass(r, id);
    if (id.startsWith('I')) assert.notEqual(r.checks.A7.ok, true, `A7 follows ${id}`);
  }
});

test('gate: a read that is missing is undetermined, not released', () => {
  for (const drop of [g => { delete g.candidates; }, g => { delete g.page; }, g => { g.idle.shadow = { status: 'error', error: 'x' }; }, g => { delete g.idle.vms; }]) {
    const g = gateInput(); drop(g);
    const r = gateVerdict(g);
    assert.equal(r.verdict, 'UNDETERMINED', JSON.stringify(r.checks));
  }
});

test('drill: the 11-15 timeline passes B1-B11', () => {
  const r = drillVerdict(drillInput());
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks));
  for (let i = 1; i <= 11; i++) assert.equal(r.checks[`B${i}`].ok, true, `B${i}`);
});

test('drill: no receipt is not a pass', () => {
  const d = drillInput(); d.receipts = [];
  for (const p of d.pages) p.alerts = [];
  const r = drillVerdict(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B1');
});

test("drill: trigger 'halted' is not a pass (the #1230 regression)", () => {
  const d = drillInput(); d.receipts = [handoverReceipt({ trigger: 'halted' })];
  const r = drillVerdict(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B1');
});

test('drill: from and to the wrong way round is not a pass', () => {
  const d = drillInput(); d.receipts = [handoverReceipt({ from_binding_id: DESK, to_binding_id: TURING })];
  notPass(drillVerdict(d), 'B1');
});

test('drill: a second handover (taken back) is not a pass', () => {
  const d = drillInput();
  d.receipts.push({ ...handoverReceipt({ from_binding_id: DESK, to_binding_id: TURING }), id: 'r-2', created_at: at('04:30:00') });
  const r = drillVerdict(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B7');
});

test('drill: a withheld or no-target alert in the window is not a pass', () => {
  const d = drillInput();
  d.pages.at(-1).alerts.push({ receipt_kind: 'CI_ADMISSION_FAILOVER_WITHHELD', created_at: at('03:56:00'), reason: 'receiver_not_alive' });
  notPass(drillVerdict(d), 'B7');
});

test('drill: TURING halted after it came back is not a pass', () => {
  const d = drillInput();
  for (const p of d.pages.slice(3)) Object.assign(p.nodes[0].node, { state: 'HALTED', readable_state: 'HALTED', halt: { code: 'X' } });
  const r = drillVerdict(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B6');
  notPass(r, 'B7');
});

test('drill: still auto_handed_out 31-35 minutes after it came back is not a pass', () => {
  const d = drillInput(); d.exclusions[1].value = 'auto_handed_out';
  const r = drillVerdict(d);
  assert.equal(r.verdict, 'FAIL');
  notPass(r, 'B9');
});

test('drill: a handover that takes effect 5 minutes later is undetermined (phase), neither PASS nor FAIL', () => {
  const d = drillInput();
  d.receipts = [handoverReceipt({ effective_at: plus(HANDOVER, 300) })];
  // DESK takes over only once the new holding is in effect
  for (const p of d.pages.slice(1, 3)) { p.holders = [{ binding_id: TURING, purpose: 'resident-node' }]; p.nodes[1].node = node({ mode: 'STANDBY', probe: 'not-held', heartbeat: p.observed_at }); }
  d.pages.splice(3, 0, page(plus(HANDOVER, 340), { holder: DESK, turing: d.pages[0].nodes[0].node,
    desk: node({ mode: 'ACTIVE', probe: 'held', heartbeat: plus(HANDOVER, 330) }) }));
  const r = drillVerdict(d);
  assert.equal(r.verdict, 'UNDETERMINED', JSON.stringify(r.checks));
  assert.equal(r.checks.B3.ok, null);
  assert.match(r.checks.B3.why, /相位/);
  assert.notEqual(r.checks.B4.ok, false, JSON.stringify(r.checks.B4));
});

test('drill: a handover too early or too late after the last heartbeat is not a pass', () => {
  for (const last of [at('03:53:00'), at('03:50:00')]) {
    const d = drillInput(); d.receipts = [handoverReceipt({ holder_last_heartbeat_at: last })];
    notPass(drillVerdict(d), 'B2');
  }
});

test('drill: DESK never answering on duty is not a pass', () => {
  const d = drillInput(); d.dutyAnswers = [{ binding_id: DESK, at: at('03:50:00') }];
  notPass(drillVerdict(d), 'B5');
});

test('drill: the cut script not having restored everything is not a pass', () => {
  for (const mutate of [c => { c.enableFailed = ['Ethernet']; }, c => { c.backstopRemoved = false; }, c => { c.connected = false; }, c => { c.outcome = 'CUT_INTERRUPTED'; }]) {
    const d = drillInput(); mutate(d.cut);
    notPass(drillVerdict(d), 'B10');
  }
});

test('drill: every missing read is undetermined, never PASS', () => {
  const drops = {
    B1: d => { delete d.receipts; for (const p of d.pages) delete p.alerts; },
    B4: d => { d.pages = d.pages.slice(0, 1); },
    B5: d => { delete d.dutyAnswers; },
    B6: d => { d.pages = d.pages.slice(0, 3); },
    B7: d => { d.pages = d.pages.slice(0, 4); },
    B8: d => { d.exclusions = d.exclusions.slice(1); },
    B9: d => { d.exclusions = d.exclusions.slice(0, 1); },
    B10: d => { delete d.cut; },
    B11: d => { delete d.statusDesk; },
  };
  for (const [id, drop] of Object.entries(drops)) {
    const d = drillInput(); drop(d);
    const r = drillVerdict(d);
    assert.equal(r.checks[id].ok, null, `${id}: ${JSON.stringify(r.checks[id])}`);
    assert.notEqual(r.verdict, 'PASS', id);
  }
  assert.equal(drillVerdict({}).verdict, 'UNDETERMINED');
  assert.equal(drillVerdict(null).verdict, 'UNDETERMINED');
});
