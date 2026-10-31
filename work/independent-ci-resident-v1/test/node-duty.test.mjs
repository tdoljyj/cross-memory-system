// The node's duty on the PR page, the take-over check and the dual-active lock (resident primary/standby design v0.4
// §5.2, §5.3, §8.2, §9 C5; Task ade5df89; DESIGN §23): the duty words and their conditions, only the node's own
// commits, only the Owner's statuses in the exact template, the lock and its three releases, the restart, the refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DUTY_WINDOW_MS, HOLDER_DUAL, LEGACY_CONTEXT, LEGACY_STANDBY_CONTEXT, NodeDuty, validMemory, RELEASE_READ_MS, STALL_NOTICE_MS, UNCLAIMED_MS, WORD, dualText, freshMemory, handedText,
  nodeContext, nodeOf, onDutyElsewhere, othersOnHead, ownAny, ownLive, parseDutyStatus, stallCode, stalledText, standbyContext, standbyText, statusesArgv, unclaimedReason } from '../src/node-duty.mjs';
// Task 9cac75be A2: each standby writes its own reminder context.
const STANDBY_CONTEXT = standbyContext('turing');
import { INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT } from '../src/intake-pause.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-10-23T06:00:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const OWNER = 'tdoljyj';
const iso = ms => new Date(ms).toISOString();
const fresh = (o = {}) => ({ writtenAt: NOW - 10_000, executor: { state: 'IDLE' }, halt: null, paused: false, intakePause: null, breaker: { state: 'closed' }, node: null,
  current: null, pending: [], recent: [], ...o });
const gh = (node, description, at, login = OWNER) => ({ context: nodeContext(node), state: 'pending', description, created_at: iso(at), login });

test('the node: absent from status.json is one ACTIVE node named by the companion; a known node carries its mode', () => {
  assert.deepEqual(nodeOf(fresh(), 'turing'), { name: 'turing', mode: 'ACTIVE', probe: null, known: false });
  // Task 9cac75be A3: no name anywhere fails closed (no default node)
  assert.equal(nodeOf(fresh()), null);
  assert.equal(nodeOf(fresh(), 'Not A Name'), null);
  assert.equal(nodeOf(fresh({ node: { name: 'BAD NAME', mode: 'ACTIVE' } })), null);
  assert.deepEqual(nodeOf(fresh(), 'company-01').name, 'company-01');
  assert.deepEqual(nodeOf(fresh({ node: { name: 'company-01', mode: 'STANDBY', probe: null } })), { name: 'company-01', mode: 'STANDBY', probe: null, known: true });
  assert.equal(nodeOf(fresh({ node: { name: 'company-01', mode: 'LEADER' } })).mode, 'UNCERTAIN');
  assert.equal(nodeContext('turing'), 'resident-queue/turing (info only)');
  assert.notEqual(nodeContext('turing'), LEGACY_CONTEXT);
});

test('on duty needs every condition; each failing one is a fixed stall code', () => {
  const n = nodeOf(fresh(), 'turing');
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

test('another node\'s status counts only from the Owner\'s account, in its own context; a duty word only in the exact template', () => {
  const ok = gh('company-01', '当班：排队第 1 位，预计 06:20Z 开始', NOW - MIN);
  assert.deepEqual(parseDutyStatus(ok, OWNER), { node: 'company-01', word: WORD.ON, code: null, at: NOW - MIN });
  assert.deepEqual(parseDutyStatus(gh('company-01', '停摆（BREAKER_OPEN）：执行器熔断中', NOW), OWNER).code, 'BREAKER_OPEN');
  for (const [name, s] of [
    ['another writer (GitHub Actions)', { ...ok, login: 'github-actions[bot]' }],
    ['the legacy context', { ...ok, context: LEGACY_CONTEXT }],
    ['a look-alike context', { ...ok, context: 'resident-queue/company-01' }],
    ['a name ending in -', { ...ok, context: 'resident-queue/company- (info only)' }],
    ['no time', { ...ok, created_at: 'soon' }],
  ]) assert.equal(parseDutyStatus(s, OWNER), null, name);
  // the node's own statuses that are no duty word: they count as its latest word, which is no duty (review M1)
  for (const [name, s] of [
    ['a result', { ...ok, description: '已完成：常驻执行器跑完八段，检查已发布' }],
    ['a word inside', { ...ok, description: '提示：当班：x' }],
    ['a lower-case code', { ...ok, description: '停摆（halt）：x' }],
    ['too long', { ...ok, description: `当班：${'x'.repeat(140)}` }],
  ]) assert.deepEqual(parseDutyStatus(s, OWNER), { node: 'company-01', word: null, code: null, at: NOW - MIN }, name);
  assert.equal(parseDutyStatus(ok, ''), null, 'an unknown Owner login reads nothing');
});

test('review M1: a result written after 当班 is the latest word: no duty, no lock', async () => {
  const list = [gh('company-01', '已完成：常驻执行器跑完八段，检查已发布', NOW - MIN), gh('company-01', '当班：运行中：第 8 段（准入复核与合并位）', NOW - 6 * MIN)];
  assert.equal(onDutyElsewhere(othersOnHead(list, 'turing', OWNER), NOW), null);
  const t = duty({ statuses: { [H(1)]: list } });
  t.memory.mode = 'STANDBY';
  assert.equal((await t.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW })).lock, null);
  // a result also ends a run of 停摆
  const run = othersOnHead([gh('company-01', '停摆（X_Y）：执行器已停机，等 Owner 复位', NOW - MIN), gh('company-01', '失败（A_B）：此提交不再运行，请推新提交', NOW - 5 * MIN),
    gh('company-01', '停摆（X_Y）：执行器已停机，等 Owner 复位', NOW - 20 * MIN)], 'turing', OWNER);
  assert.equal(run.get('company-01').stalledSince, NOW - MIN);
});

test('the latest status of each other node per head; its run of 停摆; own statuses are not others', () => {
  const list = [ // newest first, as GitHub lists them
    gh('company-01', '停摆（BREAKER_OPEN）：执行器熔断中', NOW - MIN),
    gh('turing', '当班：运行中：第 3 段（gitleaks 发布）', NOW - 2 * MIN),
    gh('company-01', '停摆（BREAKER_OPEN）：执行器熔断中', NOW - 15 * MIN),
    gh('company-01', '当班：排队第 1 位', NOW - 29 * MIN),
    gh('company-01', '停摆（STATUS_STALE）：执行器状态自 04:00Z 起未更新，可能已停止', NOW - 60 * MIN),
  ];
  const others = othersOnHead(list, 'turing', OWNER);
  assert.deepEqual([...others.keys()], ['company-01']);
  assert.deepEqual(others.get('company-01'), { node: 'company-01', word: WORD.STALLED, code: 'BREAKER_OPEN', at: NOW - MIN, stalledSince: NOW - 15 * MIN });
  assert.equal(onDutyElsewhere(others, NOW), null, 'its latest word is 停摆');
  const duty = othersOnHead([gh('company-01', '双活停机：另一节点 turing 也在当班', NOW - 29 * MIN)], 'turing', OWNER);
  assert.equal(onDutyElsewhere(duty, NOW).word, WORD.DUAL, '双活停机 blocks a take-over like 当班');
  assert.equal(onDutyElsewhere(duty, NOW + 2 * MIN), null, 'older than DUTY_WINDOW_MS no longer counts');
  assert.equal(DUTY_WINDOW_MS, 30 * MIN);
});

test('§5.3: a STANDBY reports a head nobody picked up for 30 minutes, or a node on duty stalled for 10 minutes', () => {
  const none = new Map();
  assert.equal(unclaimedReason({ others: none, firstSeenAt: NOW - UNCLAIMED_MS + 1, admitted: false, now: NOW }), null);
  assert.deepEqual(unclaimedReason({ others: none, firstSeenAt: NOW - UNCLAIMED_MS, admitted: false, now: NOW }), { reason: 'unclaimed', node: null, since: NOW - UNCLAIMED_MS, code: null });
  assert.equal(unclaimedReason({ others: none, firstSeenAt: NOW - 2 * UNCLAIMED_MS, admitted: true, now: NOW }), null, 'admitted: picked up');
  assert.equal(unclaimedReason({ others: none, firstSeenAt: NOW - 2 * UNCLAIMED_MS, admitted: null, now: NOW }), null, 'unknown: no reminder');
  const onDuty = othersOnHead([gh('company-01', '当班：排队第 3 位', NOW - 20 * MIN)], 'turing', OWNER);
  assert.equal(unclaimedReason({ others: onDuty, firstSeenAt: NOW - 2 * UNCLAIMED_MS, admitted: false, now: NOW }), null, 'queued on the node on duty');
  const stalled = othersOnHead([gh('company-01', '停摆（WSL_UNAVAILABLE）：执行器已停机，等 Owner 复位', NOW - MIN), gh('company-01', '停摆（WSL_UNAVAILABLE）：执行器已停机，等 Owner 复位', NOW - STALL_NOTICE_MS)], 'turing', OWNER);
  const u = unclaimedReason({ others: stalled, firstSeenAt: NOW - MIN, admitted: true, now: NOW });
  assert.deepEqual(u, { reason: 'stalled', node: 'company-01', since: NOW - STALL_NOTICE_MS, code: 'WSL_UNAVAILABLE' });
  assert.equal(standbyText(u, 'turing', NOW).description, '当班节点 company-01 已停摆 10 分钟（WSL_UNAVAILABLE）；需要切换请在 KooYomi 把 ci-admission 移交给 turing');
});

test('the fixed texts start with their word; the read argv are fixed', () => {
  assert.match(dualText('company-01').description, /^双活停机：另一节点 company-01 也在当班/);
  assert.match(handedText().description, /^已交班：/);
  assert.deepEqual(statusesArgv('C:\\gh.exe', 'tdoljyj/cross-memory-system', H(1)).slice(0, 5), ['C:\\gh.exe', 'api', '--method', 'GET', `repos/tdoljyj/cross-memory-system/commits/${H(1)}/statuses?per_page=100`]);
  assert.throws(() => statusesArgv('C:\\gh.exe', 'tdoljyj/cross-memory-system', 'main'));
});

// ---- the companion's side ----

// A NodeDuty over scripted GitHub answers: statuses[head] (newest first) or null (the read fails), checks[head] (count).
function duty({ statuses = {}, checks = {}, memory = freshMemory(), login = OWNER, budget = () => true, write = true } = {}) {
  const calls = [], requests = [];
  let time = NOW;
  const d = new NodeDuty({
    repo: 'tdoljyj/cross-memory-system', ghExe: 'C:\\gh.exe', clock: () => time, memory, fallbackName: 'turing', timeoutMs: 15_000, inBudget: budget, staleMs: 5 * 60_000,
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
const known = (mode, probe = { at: NOW - MIN, result: mode === 'ACTIVE' ? 'held' : 'not-held', failures: 0 }) => ({ name: 'turing', mode, probe });
const reads = calls => calls.filter(a => a[4]?.includes('/statuses')).length;

test('one node (status.json without node): no reads, no lock; its own queued commit says 当班, a failing condition 停摆', async () => {
  const t = duty();
  const s = fresh({ pending: [{ pr: 1, headSha: H(1), state: 'QUEUED' }], recent: [{ pr: 2, headSha: H(2), outcome: 'COMPLETED' }] });
  const p = await t.d.prepare({ status: s, pulls: [pull(1), pull(2), pull(3)], now: NOW });
  assert.deepEqual([p.context, p.lock, p.events], ['resident-queue/turing (info only)', null, []]);
  assert.equal(t.calls.length, 0, 'a single node reads nothing');
  const base = { state: 'pending', description: '排队第 1 位，预计 06:20Z 开始' };
  assert.deepEqual(t.d.want(pull(1), s, NOW, base), { state: 'pending', description: '当班：排队第 1 位，预计 06:20Z 开始', kind: 'duty' });
  assert.deepEqual(t.d.want(pull(1), { ...s, paused: true }, NOW, base).description, '停摆（PAUSED）：执行器已暂停，等 Owner 恢复');
  assert.deepEqual(t.d.want(pull(2), s, NOW, { state: 'success', description: '已完成：常驻执行器跑完八段，检查已发布' }).kind, 'result');
  assert.equal(t.d.want(pull(3), s, NOW, { state: 'pending', description: '已提议，等待执行器读取', weak: true }), null, 'not its commit: nothing (only its own commits)');
  assert.equal(t.d.want(pull(4, { eligible: false }), s, NOW, { state: 'failure', description: '落后 main 2 个提交：请合入最新 main 并推送' }).kind, 'hint', 'review NIT 3: the hint stays');
});

test('the take-over check at a probe that confirms the role: another node on duty locks this one through the intake pause (C6)', async () => {
  const t = duty({ statuses: { [H(1)]: [gh('company-01', '当班：运行中：第 3 段（gitleaks 发布）', NOW - 10 * MIN)], [H(2)]: [] } });
  t.memory.mode = 'STANDBY';
  const s = fresh({ node: known('ACTIVE'), pending: [{ pr: 5, headSha: H(5), state: 'QUEUED' }] });
  const p = await t.d.prepare({ status: s, pulls: [pull(1), pull(2)], now: NOW });
  assert.deepEqual([p.lock.reason, p.lock.other, p.lock.heads], ['takeover-refused', 'company-01', [H(1)]]);
  assert.deepEqual(p.events.map(e => e.key.split(':')[0]), ['role', 'takeover-refused']);
  assert.equal(t.requests.length, 1);
  assert.deepEqual([t.requests[0].contract, t.requests[0].holder, t.requests[0].minutes], [INTAKE_PAUSE_CONTRACT, HOLDER_DUAL, 120]);
  assert.match(t.d.want(pull(5), s, NOW, { state: 'pending', description: '排队第 1 位' }).description, /^双活停机：另一节点 company-01 也在当班/);
  // the same probe is not checked twice
  const before = reads(t.calls);
  await t.d.prepare({ status: s, pulls: [pull(1), pull(2)], now: NOW + MIN });
  assert.equal(reads(t.calls), before);
});

test('already on duty, the next probe finds another node on duty: dual-active; an old or unknown status locks nothing', async () => {
  const stale = duty({ statuses: { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - DUTY_WINDOW_MS - 1)] } });
  stale.memory.mode = 'ACTIVE';
  assert.equal((await stale.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW })).lock, null);
  const forged = duty({ statuses: { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - MIN, 'someone-else')] } });
  forged.memory.mode = 'ACTIVE';
  assert.equal((await forged.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW })).lock, null, 'only the Owner account counts');
  const dual = duty({ statuses: { [H(1)]: [gh('company-01', '双活停机：另一节点 turing 也在当班', NOW - MIN)] } });
  dual.memory.mode = 'ACTIVE';
  const p = await dual.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW });
  assert.equal(p.lock.reason, 'dual-active');
  // Task 9cac75be A1: any number of nodes, never "two"
  assert.equal(p.events.find(e => e.key.startsWith('dual:')).title, '多个节点同时当班：本节点双活停机');
});

test('a check that cannot finish locks nothing and runs again in the next pass', async () => {
  const t = duty({ statuses: { [H(1)]: null } });
  const s = fresh({ node: known('ACTIVE') });
  assert.equal((await t.d.prepare({ status: s, pulls: [pull(1)], now: NOW })).lock, null);
  assert.equal(t.memory.probeAt, null, 'not done');
  const out = duty({ budget: () => false });
  assert.equal((await out.d.prepare({ status: s, pulls: [pull(1)], now: NOW })).lock, null);
  assert.equal(out.memory.probeAt, null, 'out of time: not done');
  const nobody = duty({ login: null });
  await nobody.d.prepare({ status: s, pulls: [pull(1)], now: NOW });
  assert.equal(nobody.memory.probeAt, null, 'the Owner login unknown: not done');
});

test('the hold is renewed while locked, never more often than every 5 minutes, and only when less than 90 minutes are left', async () => {
  // The other node keeps refreshing its 当班 (here: one written ahead of the test's clock), so it never ages out (Task 9cac75be A1).
  const t = duty({ statuses: { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW + 60 * MIN)] } });
  t.memory.mode = 'ACTIVE';
  const s = fresh({ node: known('ACTIVE') });
  await t.d.prepare({ status: s, pulls: [pull(1)], now: NOW });
  assert.equal(t.requests.length, 1);
  const held = until => ({ ...s, writtenAt: t.now(), intakePause: { until, holders: [{ holder: HOLDER_DUAL, since: NOW, until }] } });
  t.advance(MIN);
  await t.d.prepare({ status: held(NOW + 120 * MIN), pulls: [], now: t.now() });
  assert.equal(t.requests.length, 1, 'held for long enough');
  t.advance(30 * MIN + 1);
  await t.d.prepare({ status: held(NOW + 120 * MIN), pulls: [], now: t.now() });
  assert.equal(t.requests.length, 2, 'less than 90 minutes left: renewed');
  t.advance(MIN);
  await t.d.prepare({ status: held(NOW + 120 * MIN), pulls: [], now: t.now() });
  assert.equal(t.requests.length, 2, 'not again within 5 minutes');
  assert.equal(t.requests.every(r => r.contract === INTAKE_PAUSE_CONTRACT && r.holder === HOLDER_DUAL), true);
});

test('review N1: a lock is released only when this node lost the role, the other handed over, or the Owner reset it', async () => {
  const onDuty = gh('company-01', '当班：排队第 1 位', NOW - MIN);
  const lockFor = async (statuses = { [H(1)]: [onDuty] }) => {
    const t = duty({ statuses });
    t.memory.mode = 'ACTIVE';
    await t.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW });
    assert.ok(t.memory.lock);
    return t;
  };
  // the other node's 双活停机 releases nothing (problem 2 of N1); Task 9cac75be A1 reverses problem 1: a node seen on duty whose
  // status on every head it was seen on went old (aged out) no longer holds the lock
  const dualAgain = await lockFor();
  dualAgain.advance(RELEASE_READ_MS);
  const dualStatuses = [gh('company-01', '双活停机：另一节点 turing 也在当班', dualAgain.now() - MIN), onDuty];
  dualAgain.d.run = (orig => async argv => (argv[4]?.includes('/statuses') ? { code: 0, stdout: JSON.stringify(dualStatuses) } : orig(argv)))(dualAgain.d.run);
  await dualAgain.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: dualAgain.now() }), pulls: [], now: dualAgain.now() });
  assert.ok(dualAgain.memory.lock, 'its 双活停机 does not release');
  const old = await lockFor();
  old.advance(DUTY_WINDOW_MS + RELEASE_READ_MS);
  await old.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: old.now() }), pulls: [], now: old.now() });
  assert.equal(old.memory.lock, null, 'an old 当班 of the only node seen: aged out, released');
  // 1. this node lost the role: 已交班 (by extra), and its own hold is lifted
  const lost = await lockFor();
  lost.advance(MIN);
  const p = await lost.d.prepare({ status: fresh({ node: known('STANDBY'), writtenAt: lost.now() }), pulls: [], now: lost.now() });
  assert.equal(p.lock, null);
  assert.deepEqual(lost.requests.map(r => [r.contract, r.holder]), [[INTAKE_PAUSE_CONTRACT, HOLDER_DUAL], [INTAKE_RESUME_CONTRACT, HOLDER_DUAL]]);
  assert.ok(p.events.some(e => e.key.startsWith('unlock:')));
  // 2. the other node wrote 已交班 on a head where it was seen on duty (read at most every RELEASE_READ_MS)
  const handed = await lockFor();
  handed.d.memory.lock.releaseReadAt = NOW;
  handed.advance(MIN);
  const statuses = [gh('company-01', '已交班：本节点已不当班，这个提交由当班节点处理', NOW + 30_000), onDuty];
  handed.d.run = (orig => async argv => (argv[4]?.includes('/statuses') ? { code: 0, stdout: JSON.stringify(statuses) } : orig(argv)))(handed.d.run);
  await handed.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: handed.now() }), pulls: [], now: handed.now() });
  assert.ok(handed.memory.lock, 'not read again yet');
  handed.advance(RELEASE_READ_MS);
  await handed.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: handed.now() }), pulls: [], now: handed.now() });
  assert.equal(handed.memory.lock, null);
  assert.equal(handed.requests.at(-1).contract, INTAKE_RESUME_CONTRACT);
  // 3. the Owner reset it: the hold the status showed is gone before its end, after the executor read our last request
  const reset = await lockFor();
  const until = NOW + 120 * MIN;
  reset.advance(MIN);
  await reset.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: reset.now(), intakePause: { until, holders: [{ holder: HOLDER_DUAL, since: NOW, until }] } }), pulls: [], now: reset.now() });
  reset.advance(MIN);
  const once = await reset.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: reset.now() }), pulls: [], now: reset.now() });
  assert.ok(once.lock, 'seen once: not yet (review M2)');
  reset.advance(MIN);
  const r = await reset.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: reset.now() }), pulls: [], now: reset.now() });
  assert.equal(r.lock, null);
  assert.equal(reset.requests.length, 1, 'the Owner lifted the hold: nothing more to write');
  assert.match(r.events.find(e => e.key.startsWith('unlock:')).body, /^Owner 已复位/);
});

test('Task 9cac75be A1, three nodes: the lock names every node seen on duty and waits for each to hand over or age out', async () => {
  let statuses = { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - MIN)], [H(2)]: [gh('desk-w-591', '当班：运行中：第 2 段', NOW - 2 * MIN)], [H(3)]: [] };
  const t = duty({ statuses });
  t.d.run = (orig => async argv => {
    const head = /commits\/([0-9a-f]{40})\/statuses/.exec(argv[4] ?? '')?.[1];
    return head ? { code: 0, stdout: JSON.stringify(statuses[head] ?? []) } : orig(argv);
  })(t.d.run);
  t.memory.mode = 'ACTIVE';
  const s = () => fresh({ node: known('ACTIVE'), writtenAt: t.now(), pending: [{ pr: 5, headSha: H(5), state: 'QUEUED' }] });
  const p = await t.d.prepare({ status: s(), pulls: [pull(1), pull(2), pull(3)], now: NOW });
  assert.deepEqual(p.lock.others, [{ node: 'company-01', heads: [H(1)], cleared: false }, { node: 'desk-w-591', heads: [H(2)], cleared: false }]);
  assert.equal(p.lock.other, 'company-01');
  assert.match(p.events.find(e => e.key.startsWith('dual:')).body, /company-01、desk-w-591/);
  assert.match(t.d.want(pull(5), s(), NOW, { state: 'pending', description: '排队第 1 位' }).description, /^双活停机：另一节点 company-01、desk-w-591 也在当班/);
  // the first one hands over: still locked by the second (never released by found[0] alone)
  t.advance(RELEASE_READ_MS);
  statuses = { ...statuses, [H(1)]: [gh('company-01', '已交班：本节点已不当班，这个提交由当班节点处理', t.now() - 1000), ...statuses[H(1)]],
    [H(2)]: [gh('desk-w-591', '当班：运行中：第 3 段', t.now() - MIN)] };
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.ok(t.memory.lock, 'desk-w-591 is still on duty');
  assert.deepEqual(t.memory.lock.others.map(o => o.cleared), [true, false]);
  assert.match(t.d.want(pull(5), s(), t.now(), { state: 'pending', description: '排队第 1 位' }).description, /^双活停机：另一节点 desk-w-591 也在当班/);
  // the memory keeps every node across a restart of the companion
  assert.deepEqual(validMemory(JSON.parse(JSON.stringify(t.memory)), t.now()).lock.others, t.memory.lock.others);
  // the second one stops refreshing: aged out after DUTY_WINDOW_MS; then the lock is released
  t.advance(DUTY_WINDOW_MS + 1);
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.equal(t.memory.lock, null);
  assert.equal(t.requests.at(-1).contract, INTAKE_RESUME_CONTRACT);
  // a lock stored before A1 (one `other`) reads as that node over every head
  const legacy = validMemory({ lock: { since: NOW, reason: 'dual-active', other: 'company-01', heads: [H(1), H(2)] } }, NOW);
  assert.deepEqual(legacy.lock.others, [{ node: 'company-01', heads: [H(1), H(2)], cleared: false }]);
});

test('review R3 M4, three nodes on ONE head: both others are recorded; one handing over releases nothing while the other is on duty', async () => {
  let statuses = { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - MIN), gh('desk-w-591', '当班：运行中：第 2 段', NOW - 2 * MIN)] };
  const t = duty({ statuses });
  t.d.run = (orig => async argv => {
    const head = /commits\/([0-9a-f]{40})\/statuses/.exec(argv[4] ?? '')?.[1];
    return head ? { code: 0, stdout: JSON.stringify(statuses[head] ?? []) } : orig(argv);
  })(t.d.run);
  t.memory.mode = 'ACTIVE';
  const s = () => fresh({ node: known('ACTIVE'), writtenAt: t.now() });
  await t.d.prepare({ status: s(), pulls: [pull(1)], now: NOW });
  assert.deepEqual(t.memory.lock.others, [{ node: 'company-01', heads: [H(1)], cleared: false }, { node: 'desk-w-591', heads: [H(1)], cleared: false }]);
  t.advance(RELEASE_READ_MS);
  statuses = { [H(1)]: [gh('company-01', '已交班：本节点已不当班，这个提交由当班节点处理', t.now() - 1000), gh('desk-w-591', '当班：运行中：第 3 段', t.now() - MIN)] };
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.ok(t.memory.lock, 'desk-w-591 is still on duty on the same head');
  assert.deepEqual(t.memory.lock.others.map(o => o.cleared), [true, false]);
  assert.equal(t.requests.filter(r => r.contract === INTAKE_RESUME_CONTRACT).length, 0, 'no resume yet');
  t.advance(RELEASE_READ_MS);
  statuses = { [H(1)]: [gh('desk-w-591', '已交班：本节点已不当班，这个提交由当班节点处理', t.now() - 1000), gh('company-01', '已交班：本节点已不当班，这个提交由当班节点处理', t.now() - 2000)] };
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.equal(t.memory.lock, null);
  assert.equal(t.requests.at(-1).contract, INTAKE_RESUME_CONTRACT);
});

test('Task 9cac75be A1, three nodes (this one holds, B and C seen): a node that aged out and is on duty again holds the lock again', async () => {
  let statuses = { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - MIN)], [H(2)]: [gh('desk-w-591', '当班：运行中：第 2 段', NOW - MIN)] };
  const t = duty({ statuses });
  t.d.run = (orig => async argv => {
    const head = /commits\/([0-9a-f]{40})\/statuses/.exec(argv[4] ?? '')?.[1];
    return head ? { code: 0, stdout: JSON.stringify(statuses[head] ?? []) } : orig(argv);
  })(t.d.run);
  t.memory.mode = 'ACTIVE';
  const s = () => fresh({ node: known('ACTIVE'), writtenAt: t.now() });
  await t.d.prepare({ status: s(), pulls: [pull(1), pull(2)], now: NOW });
  assert.deepEqual(t.memory.lock.others.map(o => o.node), ['company-01', 'desk-w-591']);
  // B (company-01) stops refreshing: aged out after exactly the duty window; C keeps refreshing
  t.advance(DUTY_WINDOW_MS + MIN);
  statuses = { ...statuses, [H(2)]: [gh('desk-w-591', '当班：运行中：第 3 段', t.now() - MIN)] };
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.deepEqual(t.memory.lock.others.map(o => o.cleared), [true, false]);
  // B writes 当班 again on its head (its role back), then C hands over: B holds the lock, never released by C alone
  t.advance(RELEASE_READ_MS);
  statuses = { [H(1)]: [gh('company-01', '当班：排队第 1 位', t.now() - MIN)], [H(2)]: [gh('desk-w-591', '已交班：本节点已不当班，这个提交由当班节点处理', t.now() - MIN)] };
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.ok(t.memory.lock, 'company-01 is on duty again');
  assert.deepEqual(t.memory.lock.others.map(o => o.cleared), [false, true]);
  // then B hands over too: released
  t.advance(RELEASE_READ_MS);
  statuses = { ...statuses, [H(1)]: [gh('company-01', '已交班：本节点已不当班，这个提交由当班节点处理', t.now() - MIN)] };
  await t.d.prepare({ status: s(), pulls: [], now: t.now() });
  assert.equal(t.memory.lock, null);
});

test('Task 9cac75be A2, A3: each standby has its own reminder context; no node name fails closed', async () => {
  assert.equal(standbyContext('desk-w-591'), 'resident-standby/desk-w-591 (info only)');
  assert.notEqual(standbyContext('turing'), LEGACY_STANDBY_CONTEXT);
  const t = duty();
  t.d.fallbackName = null;
  await assert.rejects(t.d.prepare({ status: fresh(), pulls: [pull(1)], now: NOW }), /NODE_NAME_REQUIRED/);
  assert.equal(t.calls.length, 0);
});

test('STANDBY: own 当班 and 双活停机 of the last 30 minutes become 已交班, results stay (NIT 2); a restart turns them 停摆 (NIT 4)', async () => {
  const own = 'resident-queue/turing (info only)';
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
  assert.deepEqual(out.map(o => [o.headSha, o.want.kind]), [[H(1), 'handed'], [H(2), 'handed'], [H(3), 'handed']]);
  // review M3: a result written after the node's 当班 stays readable after the word (NIT 2: never washed out)
  assert.deepEqual([out[2].want.state, out[2].want.description], ['failure', '已交班：失败（A_B）：此提交不再运行，请推新提交']);
  // review m5: owed until written, also when the window has passed by then
  assert.deepEqual(Object.keys((await (async () => { standby.advance(60 * MIN); await standby.d.prepare({ status: fresh({ node: known('STANDBY') }), pulls: [], now: standby.now(), posted }); return standby.memory.handover; })())).length, 3);
  assert.equal(standby.d.want(pull(1), fresh({ node: known('STANDBY'), current: { pr: 1, headSha: H(1) } }), NOW, { state: 'pending', description: 'x' }), null, 'a STANDBY writes no queue text');
  // a restarted companion (ACTIVE): the duty texts not described again in its first pass become 停摆（NODE_RESTARTED）, once
  const restarted = duty();
  await restarted.d.prepare({ status: fresh(), pulls: [], now: NOW });
  const open = [pull(1), pull(2), pull(4)];
  const first = await restarted.d.extra({ posted, described: new Set([H(1)]), pulls: open, now: NOW });
  assert.deepEqual(first.map(o => [o.headSha, o.want.description]), [[H(2), '停摆（NODE_RESTARTED）：本节点重启，等执行器恢复']], 'open heads only (review m4)');
  assert.equal(first[0].restart, true, 'the reporter ends the restart once these are written');
});

test('§5.3: a STANDBY reminds once per (PR, commit, reason) under resident-standby; reads are bounded', async () => {
  const t = duty({ statuses: { [H(1)]: [], [H(2)]: [gh('company-01', '当班：排队第 2 位', NOW + 25 * MIN)] }, checks: { [H(1)]: 0, [H(2)]: 0 } });
  const s = fresh({ node: known('STANDBY') });
  await t.d.prepare({ status: s, pulls: [pull(1), pull(2)], now: NOW });
  assert.deepEqual(await t.d.extra({ posted: {}, described: new Set(), pulls: [pull(1), pull(2)], now: NOW }), [], 'first seen now');
  t.advance(UNCLAIMED_MS);
  await t.d.prepare({ status: { ...s, writtenAt: t.now() }, pulls: [pull(1), pull(2)], now: t.now() });
  const out = await t.d.extra({ posted: {}, described: new Set(), pulls: [pull(1), pull(2)], now: t.now() });
  assert.deepEqual(out.map(o => [o.headSha, o.context, o.remind.key]), [[H(1), STANDBY_CONTEXT, `standby:1:${H(1)}:unclaimed`]]);
  assert.equal(out[0].want.description, '当班节点已 30 分钟没接手；需要切换请在 KooYomi 把 ci-admission 移交给 turing');
  t.memory.reminded[out[0].remind.key] = iso(t.now());
  t.advance(RELEASE_READ_MS);
  assert.deepEqual(await t.d.extra({ posted: {}, described: new Set(), pulls: [pull(1), pull(2)], now: t.now() }), [], 'once');
  const calls = t.calls.length;
  await t.d.extra({ posted: {}, described: new Set(), pulls: [pull(1), pull(2)], now: t.now() + 1 });
  assert.equal(t.calls.length, calls, 'a head is read at most every 5 minutes');
});

// ---- independent review of C5: the fixes ----

test('review M2: a hold missing while the executor cannot read its intake state is no Owner reset; nor is one sighting', async () => {
  const t = duty({ statuses: { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - MIN)] } });
  t.memory.mode = 'ACTIVE';
  await t.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW });
  const until = NOW + 120 * MIN;
  t.advance(MIN);
  await t.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: t.now(), intakePause: { until, holders: [{ holder: HOLDER_DUAL, since: NOW, until }] } }), pulls: [], now: t.now() });
  for (const holder of ['unconfirmed', 'unreadable']) {
    for (let i = 0; i < 3; i++) {
      t.advance(MIN);
      await t.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: t.now(), intakePause: { until: null, holders: [{ holder, since: null, until: null }] } }), pulls: [], now: t.now() });
    }
    assert.ok(t.memory.lock, `${holder}: still locked`);
  }
  // one sighting, then the hold is back: no reset, and no renewal was written while the reset was being confirmed
  const before = t.requests.length;
  t.advance(MIN);
  await t.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: t.now() }), pulls: [], now: t.now() });
  assert.notEqual(t.memory.lock.resetSeenAt, null);
  assert.equal(t.requests.length, before, 'no renewal while a reset is being confirmed');
  t.advance(MIN);
  await t.d.prepare({ status: fresh({ node: known('ACTIVE'), writtenAt: t.now(), intakePause: { until, holders: [{ holder: HOLDER_DUAL, since: NOW, until }] } }), pulls: [], now: t.now() });
  assert.ok(t.memory.lock);
  assert.equal(t.memory.lock.resetSeenAt, null);
});

test('review M4: the take-over check reads at most 10 heads a pass, keeps its place, and waits 5 minutes after a failed read', async () => {
  const heads = Array.from({ length: 25 }, (_, i) => pull(100 + i, { headSha: (i + 1).toString(16).padStart(40, '0') }));
  const statuses = Object.fromEntries(heads.map(p => [p.headSha, []]));
  const t = duty({ statuses });
  const s = fresh({ node: known('ACTIVE') });
  await t.d.prepare({ status: s, pulls: heads, now: NOW });
  assert.equal(reads(t.calls), 10);
  assert.equal(t.memory.probeAt, null, 'not done yet');
  t.advance(MIN);
  await t.d.prepare({ status: s, pulls: heads, now: t.now() });
  assert.equal(reads(t.calls), 20, 'the next ten');
  t.advance(MIN);
  await t.d.prepare({ status: s, pulls: heads, now: t.now() });
  assert.equal(reads(t.calls), 25, 'the last five, none twice');
  assert.equal(t.memory.probeAt, s.node.probe.at, 'done');
  // a failed read: no more reads of that check for READ_RETRY_MS
  const f = duty({ statuses: { [H(1)]: null, [H(2)]: [] } });
  await f.d.prepare({ status: s, pulls: [pull(2), pull(1)], now: NOW });
  const n = reads(f.calls);
  f.advance(MIN);
  await f.d.prepare({ status: s, pulls: [pull(2), pull(1)], now: f.now() });
  assert.equal(reads(f.calls), n, 'backed off');
  f.advance(5 * MIN);
  await f.d.prepare({ status: s, pulls: [pull(2), pull(1)], now: f.now() });
  assert.equal(reads(f.calls), n + 1, 'tried again, from where it stopped');
});

test('review m3: an UNCERTAIN in between is no role change; review m7: a stored lock of the wrong shape stays a lock', async () => {
  const t = duty();
  t.memory.mode = 'ACTIVE';
  let p = await t.d.prepare({ status: fresh({ node: known('UNCERTAIN') }), pulls: [], now: NOW });
  assert.equal(t.memory.mode, 'ACTIVE');
  p = await t.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [], now: NOW + MIN });
  assert.deepEqual(p.events.filter(e => e.key.startsWith('role:')), [], 'ACTIVE, UNCERTAIN, ACTIVE: nothing changed');
  const m = validMemory({ mode: 'LEADER', lock: { other: 'Company 01!', heads: ['x', H(1)], since: 'yesterday' }, seen: [] }, NOW);
  assert.deepEqual(m.lock, { since: NOW, reason: 'dual-active', other: 'unknown', others: [{ node: 'unknown', heads: [H(1)], cleared: false }], heads: [H(1)], holdAt: null, holdUntil: null,
    releaseReadAt: null, resetSeenAt: null });
  assert.equal(m.mode, null);
  assert.deepEqual(m.seen, {});
  const kept = duty({ memory: m });
  await kept.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [], now: NOW });
  assert.equal(kept.requests.length, 1, 'the hold is kept');
});

test('review m9: a STANDBY reminds when the node on duty stopped refreshing its 当班 (it died after the admission check)', async () => {
  const t = duty({ statuses: { [H(1)]: [gh('company-01', '当班：运行中：第 4 段（trivy 扫描）', NOW - 31 * MIN)] }, checks: { [H(1)]: 1 } });
  await t.d.prepare({ status: fresh({ node: known('STANDBY') }), pulls: [pull(1)], now: NOW });
  const out = await t.d.extra({ posted: {}, described: new Set(), pulls: [pull(1)], now: NOW });
  assert.deepEqual(out.map(o => o.remind.key), [`standby:1:${H(1)}:stale`]);
  assert.equal(out[0].want.description, '当班节点 company-01 的状态已 31 分钟没刷新；需要切换请在 KooYomi 把 ci-admission 移交给 turing');
});

test('the hold is written at most hourly while the executor status is stale (nobody reads the requests then)', async () => {
  const t = duty({ statuses: { [H(1)]: [gh('company-01', '当班：排队第 1 位', NOW - MIN)] } });
  t.memory.mode = 'ACTIVE';
  await t.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [pull(1)], now: NOW });
  assert.equal(t.requests.length, 1);
  const stale = fresh({ node: known('ACTIVE'), writtenAt: NOW - 10 * MIN });
  for (let i = 0; i < 6; i++) { t.advance(10 * MIN); await t.d.prepare({ status: stale, pulls: [], now: t.now() }); }
  assert.equal(t.requests.length, 2, 'one more in an hour');
});

test('C5 re-review: ACTIVE again owes no 已交班; a check ending passes later keeps its reason; an unreadable head is passed over after 3 tries', async () => {
  const own = 'resident-queue/turing (info only)';
  const posted = { [H(1)]: { context: own, kind: 'duty', at: iso(NOW - MIN), dutyAt: iso(NOW - MIN) } };
  const t = duty();
  await t.d.prepare({ status: fresh({ node: known('STANDBY') }), pulls: [], now: NOW, posted });
  assert.deepEqual(Object.keys(t.memory.handover), [H(1)]);
  await t.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: [], now: NOW + MIN, posted });
  assert.deepEqual(t.memory.handover, {}, 'back on duty: nothing owed');
  assert.deepEqual(await t.d.extra({ posted, described: new Set(), pulls: [], now: NOW + MIN }), []);
  // the check of a node just taken over ends two passes later: the lock says "take-over refused", not "dual-active"
  const heads = Array.from({ length: 12 }, (_, i) => pull(200 + i, { headSha: (i + 1).toString(16).padStart(40, '0') }));
  const statuses = Object.fromEntries(heads.map(p => [p.headSha, []]));
  statuses[heads[11].headSha] = [gh('company-01', '当班：排队第 1 位', NOW - MIN)];
  const r = duty({ statuses });
  r.memory.mode = 'STANDBY';
  await r.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: heads, now: NOW });
  assert.equal(r.memory.lock, null);
  await r.d.prepare({ status: fresh({ node: known('ACTIVE') }), pulls: heads, now: NOW + MIN });
  assert.equal(r.memory.lock.reason, 'takeover-refused');
  // one head that never answers: passed over after READ_GIVE_UP tries, the check ends
  const u = duty({ statuses: { [H(1)]: null, [H(2)]: [] } });
  const s = fresh({ node: known('ACTIVE') });
  for (let i = 0; i < 3; i++) { await u.d.prepare({ status: s, pulls: [pull(1), pull(2)], now: u.now() }); u.advance(5 * MIN); }
  assert.equal(u.memory.probeAt, s.node.probe.at, 'done after the third failed read');
});
