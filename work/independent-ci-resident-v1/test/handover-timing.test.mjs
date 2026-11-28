// ADR 0025 (smooth hand-over): the timing of a planned hand-over and of an automatic take-over, end to end, with the real intervals
// (role-probe.mjs, companion-heartbeat.mjs) and the real take-over check (node-duty.mjs), over a small model of the server: the
// ci-admission role rows (the old holder's ends at once, the new one starts 5 minutes later: binding_role_activation_delay_v1) and
// the failover watchdog (every minute; a holder silent for FAILOVER_SILENCE_MINUTES is handed to a STANDBY that beat twice
// meanwhile and whose last probe said not-held; the new row starts at once when the server gave the old holder no positive
// duty answer for QUIET_MS, else 5 minutes later: the quiet-holder start; migration 20261112130500_ci_failover_fast_v1.sql, tested on the database by
// apps/clued-cloud/tests/merge-train-failover-db.test.mjs). Every phase of every node's probe and heartbeat is tried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleProbe, ROLE_PROBE_CODES as C, ROLE_PROBE_INTERVAL_MS } from '../src/role-probe.mjs';
import { CompanionHeartbeat, FAILOVER_SILENCE_MINUTES, NODE_HEARTBEAT_EVERY_MS } from '../src/companion-heartbeat.mjs';
import { DUTY_REFRESH_MS, NodeDuty, freshMemory, nodeContext } from '../src/node-duty.mjs';
import { StatusBoard } from '../src/status.mjs';
import { executorFixture, fakeEngine, triggerBytes, WINDOWS_CLEAN } from './helpers.mjs';

const MIN = 60_000;
const ACTIVATION_MS = 5 * MIN;
const STEP = 5_000;
// ci_failover_quiet_seconds_v1: an answer can still land a check for about 150 s, plus 60 s.
const QUIET_MS = 210_000;
const LANDING_MS = 150_000;
const T0 = Date.parse('2026-11-12T09:00:00Z');
const HELD = { result: 'held', code: C.held }, NOT_HELD = { result: 'not-held', code: C['not-held'] };

test('到期探针和接班重排优先于普通 PR 读，迟到的旧班次 held 不得开批', async t => {
  const engine = fakeEngine();
  let fact = NOT_HELD;
  const calls = [];
  const answer = () => ({ ok: true, proof: WINDOWS_CLEAN, roleProbe: fact,
    outcome: { status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false } });
  engine.runRoleProbe = async () => { calls.push(fact.result); return answer(); };
  let f;
  const board = new StatusBoard({ clock: () => f?.clock() ?? T0 });
  f = await executorFixture(t, { engine, now: T0, status: board });
  await f.exec.tick();
  for (const pr of [884, 885, 886]) await f.drop(triggerBytes({ pr, headSha: String(pr).padEnd(40, 'a') }));

  const reconcile = f.exec.reconcileQueuedPr.bind(f.exec);
  f.exec.reconcileQueuedPr = async (...args) => { calls.push('后台读'); return reconcile(...args); };
  const pull = f.companion.prHead.bind(f.companion);
  const readViews = [];
  f.companion.prHead = async (pr, batch) => {
    if (!batch) {
      calls.push(pr);
      f.advance(45_000);
      readViews.push(board.snapshot());
      if (pr < 886) return null;
    }
    return pull(pr, batch);
  };

  calls.length = 0;
  f.advance(MIN);
  fact = HELD;
  assert.deepEqual(await f.exec.tick(), { state: 'IDLE', immediate: true });
  assert.deepEqual(calls, ['held'], '到期探针先取得接班结果');
  assert.equal((await f.exec.tick()).state, 'COMPLETED');
  assert.deepEqual(calls, ['held', 884, 885, 886], '首次重排只读预留必需的 PR');
  for (const view of readViews) {
    assert.equal(view.node.mode, 'ACTIVE');
    assert.ok(!['NODE_STANDBY', 'NODE_ROLE_UNCERTAIN'].includes(view.executor.reason));
  }

  calls.length = 0;
  await f.drop(triggerBytes({ pr: 887, headSha: '7'.repeat(40) }));
  f.advance(5 * MIN);
  engine.runRoleProbe = async () => {
    calls.push('旧班次 held');
    f.advance(45_000);
    f.exec.requestHandoverProbe();
    return answer();
  };
  assert.deepEqual(await f.exec.tick(), { state: 'DEFERRED', reason: 'NODE_ROLE_UNCERTAIN', immediate: true });
  assert.deepEqual(calls, ['旧班次 held']);
  assert.equal(f.exec.renewalMode(), 'UNCERTAIN');
  assert.equal(f.queue.row(887).state, 'QUEUED');
  assert.equal(engine.calls.filter(([kind]) => kind === 'derive').length, 1);
});

class Server {
  constructor(holder) { this.rows = [{ node: holder, effectiveAt: 0, endedAt: Infinity, createdAt: 0 }]; this.beats = new Map(); this.handovers = []; this.answers = new Map(); }
  admitted(node, t) { return this.rows.some(r => r.node === node && r.effectiveAt <= t && t < r.endedAt); }
  // A positive duty answer (a probe that said held, a live admission): the server stamps it (ci_duty_answers_v1).
  answer(node, t) { if (this.admitted(node, t)) { this.answers.set(node, t); return true; } return false; }
  holder() { return this.rows.find(r => r.endedAt === Infinity)?.node ?? null; }
  handover(from, to, t, auto = false) {
    for (const r of this.rows) if (r.node === from && r.endedAt === Infinity) r.endedAt = t;
    const last = this.answers.get(from);
    const quiet = auto && last !== undefined && last <= t - QUIET_MS;
    const effectiveAt = quiet ? t : t + ACTIVATION_MS;
    // The safety rule: no answer the old holder got can still land a check once the new holder starts.
    if (last !== undefined) assert.ok(effectiveAt - last >= LANDING_MS, `new holder at ${(effectiveAt - last) / 1000} s after the old one's last answer`);
    this.rows.push({ node: to, effectiveAt, endedAt: Infinity, createdAt: t });
    if (auto) this.handovers.push({ to, createdAt: t, quiet });
  }
  beat(node, t, report) { const b = this.beats.get(node); this.beats.set(node, { prev: b?.last ?? null, last: t, ...report }); }
  // The watchdog's rule (ci_admission_failover_owner_v1, ci_failover_candidates_v1), reduced to what the timing needs.
  tick(t, nodes) {
    const x = this.holder(), xb = this.beats.get(x);
    if (!xb || xb.last > t - FAILOVER_SILENCE_MINUTES * MIN) return;
    const y = nodes.find(n => n.name !== x && (b => b && b.last > t - FAILOVER_SILENCE_MINUTES * MIN && b.prev > xb.last
      && b.mode === 'STANDBY' && b.probe === 'not-held')(this.beats.get(n.name)));
    if (y) this.handover(x, y.name, t, true);
  }
}

class Node {
  // probePhase: how long before the start its last probe was; beatPhase likewise for its heartbeat; skew: its clock minus server time.
  constructor(name, server, { mode, probePhase = 0, beatPhase = 0, skew = 0 }) {
    Object.assign(this, { name, server, mode, skew, alive: true, beats: true, activeAt: null, standbyAt: null });
    this.probe = new RoleProbe();
    this.probe.observe(mode === 'ACTIVE' ? HELD : NOT_HELD, T0 + skew - probePhase);
    this.lastBeat = T0 + skew - beatPhase;
  }
  restart(t) { this.alive = true; this.mode = 'UNCERTAIN'; this.probe.markUrgent(); this.lastBeat = null; this.step(t); }
  step(t) {
    if (!this.alive) return;
    const local = t + this.skew;
    if (this.probe.due({ now: local, mode: this.mode, idle: true })) {
      const held = this.server.answer(this.name, t);
      this.probe.observe(held ? HELD : NOT_HELD, local);
      const mode = held ? 'ACTIVE' : 'STANDBY';
      if (mode !== this.mode) this[mode === 'ACTIVE' ? 'activeAt' : 'standbyAt'] = t;
      this.mode = mode;
    }
    if (this.beats && (this.lastBeat === null || local < this.lastBeat || local - this.lastBeat >= NODE_HEARTBEAT_EVERY_MS)) {
      this.lastBeat = local;
      this.server.beat(this.name, t, { mode: this.mode, probe: this.probe.last?.result ?? null });
    }
  }
}

// Runs the world from T0 for `minutes`, the watchdog at its own phase; event(t) may change it. Checks at every step that no two
// nodes are admitted at once (the server's guarantee) and that no two nodes are ACTIVE at once (the nodes' view).
function run({ server, nodes, minutes, tickPhase = 0, event = () => {} }) {
  let bothActive = 0;
  for (let t = T0; t <= T0 + minutes * MIN; t += STEP) {
    event(t);
    for (const n of nodes) n.step(t);
    if ((t - T0 - tickPhase) % MIN === 0) server.tick(t, nodes);
    assert.ok(nodes.filter(n => server.admitted(n.name, t)).length <= 1, `two nodes admitted at ${(t - T0) / MIN} min`);
    if (nodes.filter(n => n.alive && n.mode === 'ACTIVE').length > 1) bothActive += 1;
  }
  return { bothActive };
}

const phases = (every, n) => Array.from({ length: n }, (_, i) => Math.floor((every * i) / n));

test('the intervals ADR 0025 rests on', () => {
  assert.deepEqual(ROLE_PROBE_INTERVAL_MS, { STANDBY: MIN, ACTIVE: 5 * MIN });
  assert.equal(NODE_HEARTBEAT_EVERY_MS, MIN);
  assert.equal(FAILOVER_SILENCE_MINUTES, 5);
  assert.ok(ROLE_PROBE_INTERVAL_MS.ACTIVE <= ACTIVATION_MS, 'an idle old holder steps down within the activation delay');
});

test('planned hand-over (one-click, old node idle): the new node is ACTIVE 5 to 6 minutes later, the old one STANDBY before it, never two at once', () => {
  let worst = 0, best = Infinity;
  for (const xPhase of phases(ROLE_PROBE_INTERVAL_MS.ACTIVE, 9)) for (const yPhase of phases(ROLE_PROBE_INTERVAL_MS.STANDBY, 6)) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', probePhase: xPhase });
    const y = new Node('node-b', server, { mode: 'STANDBY', probePhase: yPhase });
    const at = T0 + 2 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 15, event: t => { if (t === at) server.handover('desk', 'node-b', t); } });
    assert.equal(bothActive, 0);
    assert.ok(x.standbyAt !== null && x.standbyAt <= at + ACTIVATION_MS && x.standbyAt < y.activeAt, `old node steps down first (phase ${xPhase})`);
    const took = y.activeAt - at;
    assert.ok(took >= ACTIVATION_MS && took <= ACTIVATION_MS + ROLE_PROBE_INTERVAL_MS.STANDBY, `took ${took / MIN} min`);
    worst = Math.max(worst, took); best = Math.min(best, took);
  }
  assert.ok(worst <= 6 * MIN && best >= 5 * MIN, `${best / MIN}..${worst / MIN} min`);
});

test('the holder fails (power, network): the watchdog hands over after 5 silent minutes, the quiet old holder lets the new node start at once: ACTIVE within 7 minutes', () => {
  let worst = 0, best = Infinity;
  for (const beatPhase of phases(NODE_HEARTBEAT_EVERY_MS, 4)) for (const tickPhase of phases(MIN, 3)) for (const yPhase of phases(MIN, 3)) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', beatPhase });
    const y = new Node('node-b', server, { mode: 'STANDBY', probePhase: yPhase, beatPhase: (beatPhase + 20_000) % MIN });
    const dies = T0 + 10 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 30, tickPhase, event: t => { if (t === dies) x.alive = false; } });
    assert.equal(bothActive, 0);
    assert.deepEqual(server.handovers.map(h => h.quiet), [true]);
    const took = y.activeAt - dies;
    assert.ok(took >= FAILOVER_SILENCE_MINUTES * MIN - NODE_HEARTBEAT_EVERY_MS && took <= 7 * MIN, `took ${took / MIN} min`);
    worst = Math.max(worst, took); best = Math.min(best, took);
  }
  assert.ok(best >= 4 * MIN && worst <= 7 * MIN, `${best / MIN}..${worst / MIN} min`);
});

test('the holder\'s heartbeat fails but its executor still works: the take-over keeps the 5 minutes whenever it got an answer within 210 s; never two at once', () => {
  let kept = 0, quick = 0;
  for (const probePhase of phases(ROLE_PROBE_INTERVAL_MS.ACTIVE, 10)) for (const tickPhase of phases(MIN, 3)) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', probePhase });
    const y = new Node('node-b', server, { mode: 'STANDBY' });
    const breaks = T0 + 10 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 40, tickPhase, event: t => { if (t === breaks) x.beats = false; } });
    assert.equal(server.handovers.length, 1);
    // The old holder keeps probing (every 5 minutes while ACTIVE): learns not-held, steps down; the new one is admitted only
    // after any answer of the old one has expired (asserted in Server#handover); the nodes' own view never shows two ACTIVE
    // at once beyond the old one's next probe.
    assert.equal(x.mode, 'STANDBY');
    assert.equal(y.mode, 'ACTIVE');
    assert.ok(bothActive * STEP <= ROLE_PROBE_INTERVAL_MS.ACTIVE, `both ACTIVE in their own view for ${bothActive * STEP / 1000} s`);
    if (server.handovers[0].quiet) quick += 1; else kept += 1;
  }
  assert.ok(kept > 0 && quick > 0, `kept ${kept}, quick ${quick}: both branches are reached`);
});

test('the old node comes back after the take-over: it starts UNCERTAIN, learns not-held at once and stays STANDBY; never two at once', () => {
  for (const backAfter of [2 * MIN, 6 * MIN, 9 * MIN, 20 * MIN]) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE' });
    const y = new Node('node-b', server, { mode: 'STANDBY' });
    const dies = T0 + 5 * MIN, back = dies + backAfter;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 60, event: t => {
      if (t === dies) x.alive = false;
      if (t === back) { x.restart(t); assert.notEqual(x.mode, 'UNCERTAIN', 'the restart probes at once'); }
    } });
    assert.equal(bothActive, 0);
    if (backAfter < FAILOVER_SILENCE_MINUTES * MIN) {
      // Back before the watchdog acted: it is still the holder, nothing was handed over.
      assert.deepEqual([server.handovers.length, x.mode, y.mode], [0, 'ACTIVE', 'STANDBY']);
    } else {
      assert.deepEqual([server.handovers.length, x.mode, y.mode, server.holder()], [1, 'STANDBY', 'ACTIVE', 'node-b'], `back after ${backAfter / MIN} min`);
    }
  }
});

test('clock skew: a node clock off by minutes changes no timing (intervals are its own differences, role times are the server\'s); a clock jumping back only delays that node\'s next probe, never admits it', () => {
  for (const [xSkew, ySkew] of [[-2 * MIN, 2 * MIN], [3 * MIN, -3 * MIN], [90_000, 0]]) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', skew: xSkew, probePhase: 2 * MIN });
    const y = new Node('node-b', server, { mode: 'STANDBY', skew: ySkew, probePhase: 30_000 });
    const at = T0 + 2 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 15, event: t => { if (t === at) server.handover('desk', 'node-b', t); } });
    assert.equal(bothActive, 0);
    assert.ok(y.activeAt - at <= 6 * MIN && x.standbyAt < y.activeAt, `skew ${xSkew / MIN}/${ySkew / MIN} min`);
  }
  // The new holder's clock jumps back 10 minutes just before the role starts: it is ACTIVE later, but only ever from the server's answer.
  const server = new Server('desk');
  const x = new Node('desk', server, { mode: 'ACTIVE' });
  const y = new Node('node-b', server, { mode: 'STANDBY' });
  const at = T0 + 2 * MIN;
  const { bothActive } = run({ server, nodes: [x, y], minutes: 25, event: t => {
    if (t === at) server.handover('desk', 'node-b', t);
    if (t === at + 4 * MIN) y.skew -= 10 * MIN;
  } });
  assert.equal(bothActive, 0);
  assert.equal(server.handovers.length, 0, 'its heartbeat goes on through the jump: no false take-over');
  assert.ok(y.activeAt > at + ACTIVATION_MS + 6 * MIN && server.admitted('node-b', y.activeAt), 'delayed by the jump, and admitted when ACTIVE');
});
