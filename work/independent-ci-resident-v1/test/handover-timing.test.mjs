// ADR 0025 (smooth hand-over): the timing of a planned hand-over and of an automatic take-over, end to end, with the real intervals
// (role-probe.mjs, companion-heartbeat.mjs) and the real take-over check (node-duty.mjs), over a small model of the server: the
// ci-admission role rows (the old holder's ends at once, the new one starts 5 minutes later: binding_role_activation_delay_v1) and
// the failover watchdog (every minute; a holder silent for FAILOVER_SILENCE_MINUTES is handed to a STANDBY that beat twice
// meanwhile and whose last probe said not-held; migration 20261112120000_ci_failover_fast_v1.sql, tested on the database by
// apps/clued-cloud/tests/merge-train-failover-db.test.mjs). Every phase of every node's probe and heartbeat is tried.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleProbe, ROLE_PROBE_CODES as C, ROLE_PROBE_INTERVAL_MS } from '../src/role-probe.mjs';
import { FAILOVER_SILENCE_MINUTES, NODE_HEARTBEAT_EVERY_MS } from '../src/companion-heartbeat.mjs';
import { DUTY_REFRESH_MS, NodeDuty, freshMemory, nodeContext } from '../src/node-duty.mjs';

const MIN = 60_000;
const ACTIVATION_MS = 5 * MIN;
const STEP = 5_000;
const T0 = Date.parse('2026-11-12T09:00:00Z');
const HELD = { result: 'held', code: C.held }, NOT_HELD = { result: 'not-held', code: C['not-held'] };

class Server {
  constructor(holder) { this.rows = [{ node: holder, effectiveAt: 0, endedAt: Infinity, createdAt: 0 }]; this.beats = new Map(); this.handovers = []; }
  admitted(node, t) { return this.rows.some(r => r.node === node && r.effectiveAt <= t && t < r.endedAt); }
  holder() { return this.rows.find(r => r.endedAt === Infinity)?.node ?? null; }
  handover(from, to, t, auto = false) {
    for (const r of this.rows) if (r.node === from && r.endedAt === Infinity) r.endedAt = t;
    this.rows.push({ node: to, effectiveAt: t + ACTIVATION_MS, endedAt: Infinity, createdAt: t });
    if (auto) this.handovers.push({ to, createdAt: t });
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
    Object.assign(this, { name, server, mode, skew, alive: true, activeAt: null, standbyAt: null });
    this.probe = new RoleProbe();
    this.probe.observe(mode === 'ACTIVE' ? HELD : NOT_HELD, T0 + skew - probePhase);
    this.lastBeat = T0 + skew - beatPhase;
  }
  restart(t) { this.alive = true; this.mode = 'UNCERTAIN'; this.probe.markUrgent(); this.lastBeat = null; this.step(t); }
  step(t) {
    if (!this.alive) return;
    const local = t + this.skew;
    if (this.probe.due({ now: local, mode: this.mode, idle: true })) {
      const held = this.server.admitted(this.name, t);
      this.probe.observe(held ? HELD : NOT_HELD, local);
      const mode = held ? 'ACTIVE' : 'STANDBY';
      if (mode !== this.mode) this[mode === 'ACTIVE' ? 'activeAt' : 'standbyAt'] = t;
      this.mode = mode;
    }
    if (this.lastBeat === null || local < this.lastBeat || local - this.lastBeat >= NODE_HEARTBEAT_EVERY_MS) {
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
  assert.equal(FAILOVER_SILENCE_MINUTES, 3);
  assert.ok(ROLE_PROBE_INTERVAL_MS.ACTIVE <= ACTIVATION_MS, 'an idle old holder steps down within the activation delay');
});

test('planned hand-over (one-click, old node idle): the new node is ACTIVE 5 to 6 minutes later, the old one STANDBY before it, never two at once', () => {
  let worst = 0, best = Infinity;
  for (const xPhase of phases(ROLE_PROBE_INTERVAL_MS.ACTIVE, 9)) for (const yPhase of phases(ROLE_PROBE_INTERVAL_MS.STANDBY, 6)) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', probePhase: xPhase });
    const y = new Node('turing', server, { mode: 'STANDBY', probePhase: yPhase });
    const at = T0 + 2 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 15, event: t => { if (t === at) server.handover('desk', 'turing', t); } });
    assert.equal(bothActive, 0);
    assert.ok(x.standbyAt !== null && x.standbyAt <= at + ACTIVATION_MS && x.standbyAt < y.activeAt, `old node steps down first (phase ${xPhase})`);
    const took = y.activeAt - at;
    assert.ok(took >= ACTIVATION_MS && took <= ACTIVATION_MS + ROLE_PROBE_INTERVAL_MS.STANDBY, `took ${took / MIN} min`);
    worst = Math.max(worst, took); best = Math.min(best, took);
  }
  assert.ok(worst <= 6 * MIN && best >= 5 * MIN, `${best / MIN}..${worst / MIN} min`);
});

test('the holder fails (power, network): the watchdog hands over after 3 silent minutes, the new node is ACTIVE within 10 minutes', () => {
  let worst = 0, best = Infinity;
  for (const beatPhase of phases(NODE_HEARTBEAT_EVERY_MS, 4)) for (const tickPhase of phases(MIN, 3)) for (const yPhase of phases(MIN, 3)) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', beatPhase });
    const y = new Node('turing', server, { mode: 'STANDBY', probePhase: yPhase, beatPhase: (beatPhase + 20_000) % MIN });
    const dies = T0 + 10 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 30, tickPhase, event: t => { if (t === dies) x.alive = false; } });
    assert.equal(bothActive, 0);
    assert.equal(server.handovers.length, 1);
    const took = y.activeAt - dies;
    assert.ok(took > ACTIVATION_MS && took <= 10 * MIN, `took ${took / MIN} min`);
    worst = Math.max(worst, took); best = Math.min(best, took);
  }
  assert.ok(best >= 6 * MIN && worst <= 10 * MIN, `${best / MIN}..${worst / MIN} min`);
});

test('the dead holder\'s last 当班 does not hold the new node back after the automatic take-over (it did for up to 30 minutes before)', async () => {
  const OWNER = 'tdoljyj', HEAD = 'a'.repeat(40);
  for (const lastRefresh of [0, 5 * MIN, DUTY_REFRESH_MS]) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE' });
    const y = new Node('turing', server, { mode: 'STANDBY' });
    const dies = T0 + 20 * MIN;
    run({ server, nodes: [x, y], minutes: 35, event: t => { if (t === dies) x.alive = false; } });
    // desk wrote its 当班 on its queued head every DUTY_REFRESH_MS; the last one lastRefresh before it died.
    const statuses = [{ context: nodeContext('desk'), state: 'pending', description: '当班：排队第 1 位', created_at: new Date(dies - lastRefresh).toISOString(), login: OWNER }];
    const check = async cut => {
      const memory = freshMemory(); memory.mode = 'STANDBY';
      const d = new NodeDuty({ repo: 'tdoljyj/cross-memory-system', ghExe: 'gh', clock: () => y.activeAt, memory, fallbackName: 'turing', timeoutMs: 15_000,
        inBudget: () => true, staleMs: 5 * MIN, writeRequest: async () => {}, autoHandoverSince: () => cut,
        run: async argv => (argv[4] === 'user' ? { code: 0, stdout: OWNER } : { code: 0, stdout: JSON.stringify(statuses) }) });
      const status = { writtenAt: y.activeAt, executor: { state: 'IDLE' }, halt: null, paused: false, intakePause: null, breaker: { state: 'closed' },
        node: { name: 'turing', mode: 'ACTIVE', probe: { at: y.activeAt, result: 'held', failures: 0 } }, current: null, pending: [], recent: [] };
      return (await d.prepare({ status, pulls: [{ pr: 1, headSha: HEAD, eligible: true }], now: y.activeAt })).lock;
    };
    assert.ok(await check(null), 'without the cut: held back (the old behaviour)');
    assert.equal(await check(server.handovers[0].createdAt), null, `with the cut: free at once (last refresh ${lastRefresh / MIN} min before)`);
  }
});

test('the old node comes back after the take-over: it starts UNCERTAIN, learns not-held at once and stays STANDBY; never two at once', () => {
  for (const backAfter of [2 * MIN, 6 * MIN, 9 * MIN, 20 * MIN]) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE' });
    const y = new Node('turing', server, { mode: 'STANDBY' });
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
      assert.deepEqual([server.handovers.length, x.mode, y.mode, server.holder()], [1, 'STANDBY', 'ACTIVE', 'turing'], `back after ${backAfter / MIN} min`);
    }
  }
});

test('clock skew: a node clock off by minutes changes no timing (intervals are its own differences, role times are the server\'s); a clock jumping back only delays that node\'s next probe, never admits it', () => {
  for (const [xSkew, ySkew] of [[-2 * MIN, 2 * MIN], [3 * MIN, -3 * MIN], [90_000, 0]]) {
    const server = new Server('desk');
    const x = new Node('desk', server, { mode: 'ACTIVE', skew: xSkew, probePhase: 2 * MIN });
    const y = new Node('turing', server, { mode: 'STANDBY', skew: ySkew, probePhase: 30_000 });
    const at = T0 + 2 * MIN;
    const { bothActive } = run({ server, nodes: [x, y], minutes: 15, event: t => { if (t === at) server.handover('desk', 'turing', t); } });
    assert.equal(bothActive, 0);
    assert.ok(y.activeAt - at <= 6 * MIN && x.standbyAt < y.activeAt, `skew ${xSkew / MIN}/${ySkew / MIN} min`);
  }
  // The new holder's clock jumps back 10 minutes just before the role starts: it is ACTIVE later, but only ever from the server's answer.
  const server = new Server('desk');
  const x = new Node('desk', server, { mode: 'ACTIVE' });
  const y = new Node('turing', server, { mode: 'STANDBY' });
  const at = T0 + 2 * MIN;
  const { bothActive } = run({ server, nodes: [x, y], minutes: 25, event: t => {
    if (t === at) server.handover('desk', 'turing', t);
    if (t === at + 4 * MIN) y.skew -= 10 * MIN;
  } });
  assert.equal(bothActive, 0);
  assert.equal(server.handovers.length, 0, 'its heartbeat goes on through the jump: no false take-over');
  assert.ok(y.activeAt > at + ACTIVATION_MS + 6 * MIN && server.admitted('turing', y.activeAt), 'delayed by the jump, and admitted when ACTIVE');
});
