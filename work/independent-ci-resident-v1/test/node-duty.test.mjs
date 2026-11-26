import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_CONTEXT, LEGACY_STANDBY_CONTEXT, NodeDuty, validMemory, STANDBY_DONE_TEXT, freshMemory, handedText,
  nodeContext, nodeOf, ownAny, ownLive, pruneMemory, stallCode, stalledText, standbyContext } from '../src/node-duty.mjs';
import { multiDutyClock } from './multi-duty-fixture.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-10-23T06:00:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const OWNER = 'tdoljyj';
const iso = ms => new Date(ms).toISOString();
const fresh = (o = {}) => ({ writtenAt: NOW - 10_000, executor: { state: 'IDLE' }, halt: null, paused: false, intakePause: null, breaker: { state: 'closed' }, node: null,
  current: null, pending: [], recent: [], ...o });
const gh = (node, description, at, login = OWNER) => ({ context: nodeContext(node), state: 'pending', description, created_at: iso(at), login });

test('the node: absent from status.json is one ACTIVE node named by the companion; a known node carries its mode', () => {
  assert.deepEqual(nodeOf(fresh(), 'node-b'), { name: 'node-b', mode: 'ACTIVE', probe: null, known: false });
  // Task 9cac75be A3: no name anywhere fails closed (no default node)
  assert.equal(nodeOf(fresh()), null);
  assert.equal(nodeOf(fresh(), 'Not A Name'), null);
  assert.equal(nodeOf(fresh({ node: { name: 'BAD NAME', mode: 'ACTIVE' } })), null);
  assert.deepEqual(nodeOf(fresh(), 'company-01').name, 'company-01');
  assert.deepEqual(nodeOf(fresh({ node: { name: 'company-01', mode: 'STANDBY', probe: null } })), { name: 'company-01', mode: 'STANDBY', probe: null, known: true });
  assert.equal(nodeOf(fresh({ node: { name: 'company-01', mode: 'LEADER' } })).mode, 'UNCERTAIN');
  assert.equal(nodeContext('node-b'), 'resident-queue/node-b (info only)');
  assert.notEqual(nodeContext('node-b'), LEGACY_CONTEXT);
});

test('on duty needs every condition; each failing one is a fixed stall code', () => {
  const n = nodeOf(fresh(), 'node-b');
  assert.equal(stallCode(fresh(), n, NOW, 5 * MIN), null);
  for (const [name, status, code] of [
    ['stale', fresh({ writtenAt: NOW - 6 * MIN }), 'STATUS_STALE'],
    ['halt', fresh({ halt: { code: 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH' } }), 'EXECUTOR_RESTARTED_WITH_OPEN_BATCH'],
    ['stopped', fresh({ executor: { state: 'STOPPED' } }), 'EXECUTOR_STOPPED'],
    ['starting', fresh({ executor: { state: 'STARTING' } }), 'EXECUTOR_STARTING'],
    ['paused', fresh({ paused: true }), 'PAUSED'],
    ['intake pause (C6)', fresh({ intakePause: { until: NOW + MIN, holders: [] } }), 'INTAKE_PAUSED'],
    ['breaker', fresh({ breaker: { state: 'open' } }), 'BREAKER_OPEN'],
  ]) assert.equal(stallCode(status, n, NOW, 5 * MIN), code, name);
  assert.equal(stallCode(fresh({ breaker: { state: 'half-open' } }), n, NOW, 5 * MIN), null, 'a half-open breaker runs a trial: on duty');
  assert.equal(stallCode(fresh(), { ...n, mode: 'UNCERTAIN' }, NOW, 5 * MIN), 'NODE_ROLE_UNCERTAIN');
  assert.equal(stallCode(null, n, NOW, 5 * MIN), 'STATUS_UNREADABLE');
  assert.match(stalledText('INTAKE_PAUSED', fresh({ intakePause: { until: NOW + 90 * MIN } })).description, /^停摆（INTAKE_PAUSED）：暂停接新中，最晚 07:30Z 恢复$/);
  assert.equal(stalledText('EXECUTOR_RESTARTED_WITH_OPEN_BATCH', fresh()).state, 'error');
  assert.equal(stalledText('PAUSED', fresh()).state, 'pending');
});

test('own commits only: queued or running is live; outcomes and stopped rows are own but not live', () => {
  const s = fresh({ current: { pr: 1, headSha: H(1) }, pending: [{ pr: 2, headSha: H(2), state: 'PARKED' }, { pr: 3, headSha: H(3), state: 'STOPPED' }],
    recent: [{ pr: 4, headSha: H(4), outcome: 'COMPLETED' }] });
  assert.deepEqual([1, 2, 3, 4, 5].map(n => ownLive(s, { pr: n, headSha: H(n) })), [true, true, false, false, false]);
  assert.deepEqual([1, 2, 3, 4, 5].map(n => ownAny(s, { pr: n, headSha: H(n) })), [true, true, true, true, false]);
  assert.equal(ownLive(s, { pr: 1, headSha: H(9) }), false, 'another commit of the same PR is not its');
});

// ---- the companion's side ----

// A NodeDuty over scripted GitHub answers: statuses[head] (newest first) or null (the read fails), checks[head] (count).
function duty({ statuses = {}, checks = {}, memory = freshMemory(), login = OWNER, budget = () => true, write = true } = {}) {
  const calls = [], requests = [];
  let time = NOW;
  const d = new NodeDuty({
    repo: 'tdoljyj/cross-memory-system', ghExe: 'C:\\gh.exe', clock: () => time, memory, fallbackName: 'node-b', timeoutMs: 15_000, inBudget: budget, staleMs: 5 * 60_000,
    writeRequest: write ? async v => { requests.push(v); } : null,
    run: async argv => {
      calls.push(argv);
      const url = argv[4];
      if (url === 'user') return { code: login ? 0 : 1, stdout: `${login ?? ''}\n` };
      const head = /commits\/([0-9a-f]{40})\//.exec(url)?.[1];
      if (url.includes('/statuses')) return statuses[head] === null ? { code: 1, stdout: '' } : { code: 0, stdout: JSON.stringify(statuses[head] ?? []) };
      if (url.includes('/check-runs')) return { code: 0, stdout: `${checks[head] ?? 0}\n` };
      return { code: 1, stdout: '' };
    },
  });
  return { d, calls, requests, memory, advance: ms => { time += ms; }, now: () => time };
}
const pull = (n, o = {}) => ({ pr: n, headSha: H(n), eligible: true, ...o });
const known = (mode, probe = { at: NOW - MIN, result: mode === 'ACTIVE' ? 'held' : 'not-held', failures: 0 }) => ({ name: 'node-b', mode, probe });
const reads = calls => calls.filter(a => a[4]?.includes('/statuses')).length;

test('train v2: for an hour two healthy nodes can refresh the same PR without taking an intake hold', async () => {
  const shared = { [H(1)]: [] };
  const a = duty({ statuses: shared });
  const b = duty({ statuses: shared });
  a.memory.mode = b.memory.mode = 'ACTIVE';
  const clock = multiDutyClock(NOW);
  const names = ['node-a', 'node-b'];
  const kinds = [];
  for (let minute = 0; minute <= 60; minute += 5) {
    const now = clock.now();
    shared[H(1)] = names.map(name => gh(name, '双活停机：另一节点也在当班', now));
    for (const [index, t] of [a, b].entries()) {
      const status = fresh({ writtenAt: now, node: { ...known('ACTIVE', { at: now, result: 'held' }), name: names[index] },
        pending: [{ pr: 1, headSha: H(1), state: 'QUEUED' }] });
      await t.d.prepare({ status, pulls: [pull(1)], now });
      const want = t.d.want(pull(1), status, now, { state: 'pending', description: '排队第 1 位' });
      kinds.push(want.kind);
      shared[H(1)].unshift(gh(names[index], want.description, now));
    }
    clock.advance(5 * MIN);
  }
  assert.deepEqual([a.requests.length, b.requests.length, reads(a.calls), reads(b.calls)], [0, 0, 0, 0]);
  assert.ok(kinds.every(kind => kind === 'duty'));
});

test('one node (status.json without node): no reads, no lock; its own queued commit says 当班, a failing condition 停摆', async () => {
  const t = duty();
  const s = fresh({ pending: [{ pr: 1, headSha: H(1), state: 'QUEUED' }], recent: [{ pr: 2, headSha: H(2), outcome: 'COMPLETED' }] });
  const p = await t.d.prepare({ status: s, pulls: [pull(1), pull(2), pull(3)], now: NOW });
  assert.deepEqual([p.context, p.events], ['resident-queue/node-b (info only)', []]);
  assert.equal(t.calls.length, 0, 'a single node reads nothing');
  const base = { state: 'pending', description: '排队第 1 位，预计 06:20Z 开始' };
  assert.deepEqual(t.d.want(pull(1), s, NOW, base), { state: 'pending', description: '当班：排队第 1 位，预计 06:20Z 开始', kind: 'duty' });
  assert.deepEqual(t.d.want(pull(1), { ...s, paused: true }, NOW, base).description, '停摆（PAUSED）：执行器已暂停，等 Owner 恢复');
  assert.deepEqual(t.d.want(pull(2), s, NOW, { state: 'success', description: '已完成：常驻执行器跑完八段，检查已发布' }).kind, 'result');
  assert.equal(t.d.want(pull(3), s, NOW, { state: 'pending', description: '已提议，等待执行器读取', weak: true }), null, 'not its commit: nothing (only its own commits)');
  assert.equal(t.d.want(pull(4, { eligible: false }), s, NOW, { state: 'pending', description: '落后 main 2 个提交：轮到时机器人合入 main，不用手工合（没开自动合入的先开）' }).kind, 'hint', 'review NIT 3: the hint stays');
});

test('Task 9cac75be A2, A3: each standby has its own reminder context; no node name fails closed', async () => {
  assert.equal(standbyContext('node-a'), 'resident-standby/node-a (info only)');
  assert.notEqual(standbyContext('node-b'), LEGACY_STANDBY_CONTEXT);
  const t = duty();
  t.d.fallbackName = null;
  assert.throws(() => t.d.prepare({ status: fresh(), now: NOW }), /NODE_NAME_REQUIRED/);
  assert.equal(t.calls.length, 0);
});

test('STANDBY hands over its own recent duty, and a restart ends both stale duty and retired dual-active status', async () => {
  const own = 'resident-queue/node-b (info only)';
  const posted = {
    [H(1)]: { context: own, kind: 'duty', at: iso(NOW - 10 * MIN), dutyAt: iso(NOW - 10 * MIN) },
    [H(2)]: { context: own, kind: 'dual', at: iso(NOW - 29 * MIN), dutyAt: iso(NOW - 29 * MIN) },
    [H(3)]: { context: own, kind: 'result', state: 'failure', description: '失败（A_B）：此提交不再运行，请推新提交', at: iso(NOW - MIN), dutyAt: iso(NOW - 5 * MIN) },
    [H(4)]: { context: own, kind: 'duty', at: iso(NOW - 31 * MIN), dutyAt: iso(NOW - 31 * MIN) },
    [H(5)]: { context: 'resident-queue (info only)', kind: 'duty', at: iso(NOW - MIN), dutyAt: iso(NOW - MIN) },
    [H(6)]: { context: own, kind: 'result', at: iso(NOW - MIN), dutyAt: null },
  };
  const standby = duty();
  await standby.d.prepare({ status: fresh({ node: known('STANDBY') }), pulls: [], now: NOW, posted });
  const out = await standby.d.extra({ posted, described: new Set(), pulls: [], now: NOW });
  assert.deepEqual(out.map(o => [o.headSha, o.want.kind]), [[H(1), 'handed'], [H(3), 'handed']]);
  // review M3: a result written after the node's 当班 stays readable after the word (NIT 2: never washed out)
  assert.deepEqual([out[1].want.state, out[1].want.description], ['failure', '已交班：失败（A_B）：此提交不再运行，请推新提交']);
  // review m5: owed until written, also when the window has passed by then
  assert.deepEqual(Object.keys((await (async () => { standby.advance(60 * MIN); await standby.d.prepare({ status: fresh({ node: known('STANDBY') }), pulls: [], now: standby.now(), posted }); return standby.memory.handover; })())).length, 2);
  assert.equal(standby.d.want(pull(1), fresh({ node: known('STANDBY'), current: { pr: 1, headSha: H(1) } }), NOW, { state: 'pending', description: 'x' }), null, 'a STANDBY writes no queue text');
  // a restarted companion (ACTIVE): the duty texts not described again in its first pass become 停摆（NODE_RESTARTED）, once
  const restarted = duty();
  await restarted.d.prepare({ status: fresh(), pulls: [], now: NOW });
  const open = [pull(1), pull(2), pull(4)];
  const first = await restarted.d.extra({ posted, described: new Set(), pulls: open, now: NOW });
  assert.deepEqual(first.map(o => [o.headSha, o.want.description]), [[H(1), '停摆（NODE_RESTARTED）：本节点重启，等执行器恢复'], [H(2), '已清理旧双活暂停状态']], 'open heads only (review m4)');
  assert.equal(first[0].restart, true, 'the reporter ends the restart once these are written');
  assert.match(handedText().description, /^已交班：/);
});

// ADR 0028 (field 2026-11-13: TURING wrote "当班节点 desk-w-591 已停摆 10 分钟" while DESK ran PR #1085): a STANDBY writes no reminder
// of its own any more, whatever the node on duty wrote, and reads no head for it; a reminder left pending before ends once as success.
test('ADR 0028: a STANDBY reminds of nothing; a reminder written before ends once, a closed head is forgotten', async () => {
  const stalled = [gh('company-01', '停摆（PAUSED）：执行器已暂停，等 Owner 恢复', NOW - MIN), gh('company-01', '停摆（PAUSED）：执行器已暂停，等 Owner 恢复', NOW - 14 * MIN)];
  const t = duty({ statuses: { [H(1)]: stalled, [H(2)]: [gh('company-01', '当班：运行中：第 4 段（trivy 扫描）', NOW - 31 * MIN)], [H(3)]: [] } });
  const pulls = [pull(1), pull(2), pull(3)];
  for (const at of [NOW, NOW + 31 * MIN]) {
    await t.d.prepare({ status: fresh({ node: known('STANDBY'), writtenAt: at }), pulls, now: at });
    assert.deepEqual(await t.d.extra({ posted: {}, described: new Set(), pulls, now: at }), []);
  }
  assert.equal(reads(t.calls), 0, 'no head is read for a reminder');
  for (const mode of ['STANDBY', 'ACTIVE']) {
    const u = duty();
    u.memory.standby = { [H(1)]: { pr: 1, at: iso(NOW - MIN) }, [H(4)]: { pr: 4, at: iso(NOW - MIN) } };
    await u.d.prepare({ status: fresh({ node: known(mode) }), pulls: [pull(1)], now: NOW });
    const out = await u.d.extra({ posted: {}, described: new Set([H(1)]), pulls: [pull(1)], now: NOW });
    assert.deepEqual(out.map(o => [o.headSha, o.context, o.want, o.standbyDone]), [[H(1), standbyContext('node-b'), STANDBY_DONE_TEXT, H(1)]], mode);
    assert.deepEqual(Object.keys(u.memory.standby), [H(1)], 'owed until the reporter writes it; a closed head is forgotten');
  }
  assert.equal(STANDBY_DONE_TEXT.state, 'success');
  const old = validMemory({ standby: { [H(5)]: { pr: 1027, at: iso(NOW - MIN) } }, reminded: { x: iso(NOW) }, seen: { y: iso(NOW) }, toasts: {} }, NOW);
  assert.deepEqual(Object.keys(old).sort(), ['handover', 'mode', 'standby']);
  pruneMemory(old, NOW + 86_400_000);
  assert.deepEqual(old.standby, {});
});
