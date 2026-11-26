// Merge queue page (/merge-queue, Tasks a3701d3d and d4bd8faa)
// under controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/merge-queue/page.tsx');
const NOW = Date.parse('2026-11-26T02:32:00Z');
const RESIDENT_RPC = 'clued_merge_queue_resident_v1';

function fixture(compiled) {
  const hooks = [], effects = [], calls = [], residentCalls = [], fetches = [];
  const timers = new Map(), visibilityListeners = new Set();
  let now = NOW, timerId = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const document = {
    hidden: false,
    addEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.delete(listener); },
  };
  let cursor = 0, authCallback, root;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; } };
  const supabase = { auth, rpc(name, args) { let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    (name === RESIDENT_RPC ? residentCalls : calls).push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    throw Error(name);
  }, Error, Date: Clock, Number, String, Math, Array, document,
  setInterval(callback, ms) { timers.set(++timerId, { callback, ms, next: now + ms }); return timerId; },
  clearInterval(id) { timers.delete(id); },
  fetch(url) { fetches.push(url); return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function button(t) { const n = nodes('button').find(n => text(n) === t); assert.ok(n, t); return n; }
  function setHidden(hidden) {
    document.hidden = hidden;
    visibilityListeners.forEach(listener => listener());
  }
  function advance(ms) {
    const until = now + ms;
    while (true) {
      const next = [...timers.values()].sort((a, b) => a.next - b.next)[0];
      if (!next || next.next > until) break;
      now = next.next;
      next.next += next.ms;
      next.callback();
    }
    now = until;
  }
  render();
  return { calls, residentCalls, fetches, render, nodes, text, settle, emit, button, setHidden, advance,
    unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));
const setting = (ordering, version) => ({ ordering, version, default: version === 0,
  updated_at: version === 0 ? null : '2026-10-31T06:00:00Z', receipt_id: version === 0 ? null : 'r-' + version });
const QUEUE = [{ ref: 'merge:tdoljyj/cross-memory-system:main', entries: [
  { claim_id: 'c1', task_id: 't1', task_title: '修复登录', state: 'head', position: 1, bound_pr: 'tdoljyj/cross-memory-system#7',
    holder_label: 'Claude', auto_priority: 12 },
  { claim_id: 'c2', task_id: 't2', task_title: '合并列车', state: 'waiting', position: 2, bound_pr: null,
    holder_label: null, auto_priority: 64 },
  { claim_id: 'c3', task_id: 't3', task_title: '旧任务', state: 'waiting', position: 3, bound_pr: 'tdoljyj/cross-memory-system#9',
    holder_label: null, auto_priority: null },
] }];
const page = (ordering, version, queues = QUEUE) => ({ data: { status: 'ok', setting: setting(ordering, version), queues }, error: null });

async function open(f, initial = page('fifo', 0)) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_merge_queue_v1', { p_input: {} }]);
  f.calls[0].resolve(initial); await f.settle();
}

test('signed out: no calls, a link to sign in', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.equal(f.residentCalls.length, 0);
  assert.ok(f.text().includes('登录 BeamingFace'));
});

test('the default is join order; the queue shows each claim with its automatic priority', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  assert.ok(f.text().includes('现在：按排队先后（默认）'));
  assert.ok(f.text().includes('tdoljyj/cross-memory-system 的 main 分支'));
  const rows = f.nodes('li').map(n => f.text(n));
  assert.deepEqual(rows, [
    '第一位，正在合并 · 修复登录 · 拉取请求 tdoljyj/cross-memory-system#7 · 自动优先级 12 · Claude',
    '第 2 位，等候 · 合并列车 · 还没有拉取请求 · 自动优先级 64',
    '第 3 位，等候 · 旧任务 · 拉取请求 tdoljyj/cross-memory-system#9 · 自动优先级 无',
  ]);
  for (const word of ['claim', 'front', 'fifo', 'priority', 'merge:']) assert.ok(!f.text().includes(word), word);
  assert.equal(f.fetches.length, 0, 'the page never goes through a Worker route');
});

test('switching sends the version shown, then reads the queue again', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('改为按任务优先级').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_merge_queue_ordering_set_v1',
    { p_input: { ordering: 'priority', base_version: 0 } }]);
  f.render();
  assert.ok(f.nodes('button').every(n => n.props.disabled), 'no second change while one is in flight');
  f.calls[1].resolve({ data: { status: 'committed', changed: true, ...setting('priority', 1) }, error: null }); await f.settle();
  assert.equal(f.calls[2].name, 'clued_merge_queue_v1', 'the queue is read again in the new order');
  f.calls[2].resolve(page('priority', 1)); await f.settle();
  assert.ok(f.text().includes('现在：按任务优先级'));
  assert.ok(!f.text().includes('（默认）'));
  assert.ok(f.text().includes('已保存设置：按任务优先级。'));
  f.button('改为按排队先后').props.onClick();
  assert.deepEqual(plain(f.calls[3].args.p_input), { ordering: 'fifo', base_version: 1 });
});

test('a stale page is told so and shows the current setting', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('改为按任务优先级').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'merge_queue_setting_version_conflict',
    current: setting('priority', 1) }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_merge_queue_v1');
  f.calls[2].resolve(page('priority', 1)); await f.settle();
  assert.ok(f.text().includes('被改过'), 'the conflict message stays after the reload');
  assert.ok(f.text().includes('现在：按任务优先级'));
  assert.ok(f.nodes('button').some(n => f.text(n) === '改为按排队先后'));
});

test('a delegated login is refused in plain words', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await f.settle();
  assert.ok(f.text().includes('需要你本人直接登录 BeamingFace'));
  assert.equal(f.nodes('button').some(n => f.text(n).startsWith('改为')), false, 'no switch without a read setting');
});

test('the merge slot list and stored setting explain their scope', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, page('fifo', 0, []));
  assert.ok(f.text().includes('现在没有 PR 持有或等待合并位。'));
  assert.ok(f.text().includes('现在切换不改变常驻 CI 的实际合并顺序，实际顺序以上面“排队”为准。'));
});

const minutesAgo = minutes => new Date(NOW - minutes * 60_000).toISOString();
const headSha = 'abcdef1234567890'.repeat(2) + 'abcdef12';
const pull = pr => ({ pr, headSha });
const pending = (pr, position, holdText = '等待准入') => ({
  ...pull(pr), state: 'QUEUED', position, since: minutesAgo(16), deferred: null, nextAt: null, holdText,
});
const nodeView = overrides => ({
  contract: 'clued.merge-queue-node-view/1',
  node: { name: 'DESK', mode: 'ACTIVE', source: headSha, generation: 21, consistent: true,
    upgrade: { state: 'running', phase: '排空', since: minutesAgo(4), code: null },
    selfcheck: { result: 'PASS', observedAt: minutesAgo(3) } },
  executor: { state: 'RUNNING', reason: null, since: minutesAgo(19) },
  halt: null, paused: false, intakePause: null, breaker: { state: 'closed', nextTrialAt: null }, queueHold: null,
  current: null, pending: [], unqueued: [], train: { enabled: 'on', last: null }, alerts: [], stall: null,
  ...overrides,
});
const residentNode = overrides => ({
  name: 'DESK', holder: true, silent: false, last_heartbeat_at: minutesAgo(1),
  reported_state: 'NORMAL', reported_mode: 'ACTIVE', reported_snapshot_age_seconds: 10,
  reported_source_sha256: null, view_reported_at: minutesAgo(2), view: nodeView(), ...overrides,
});
const resident = (...nodes) => ({
  data: { status: 'ok', observed_at: minutesAgo(0), rules: { silence_minutes: 5 }, nodes }, error: null,
});
async function resolveResident(f, payload) {
  const call = f.residentCalls.at(-1);
  assert.ok(call, 'the page calls the resident queue RPC');
  assert.deepEqual(plain(call.args), { p_input: {} });
  call.resolve(payload);
  await f.settle();
}
const alerts = f => f.nodes('p').filter(n => n.props.role === 'alert').map(n => f.text(n));
const statuses = f => f.nodes('p').filter(n => n.props.role === 'status').map(n => f.text(n));

test('a resident stall raises a top alert with the node’s reason', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  const text = '有 4 个 PR 在等，但已 16 分钟没有任何批次开跑；队首 PR #1365：等待安全点续跑';
  await resolveResident(f, resident(residentNode({ view: nodeView({
    pending: [pending(1365, 1, '等待安全点续跑')], unqueued: [pull(1366), pull(1367), pull(1368)],
    train: { enabled: 'on', last: { at: minutesAgo(10), mode: 'revoke-only', front: null,
      wouldDo: 'NO_FRONT', decision: 'NO_FRONT', onDuty: true } },
    stall: { code: 'NO_PROGRESS', level: 'red', since: minutesAgo(16), text },
  }) })));
  assert.match(alerts(f)[0] ?? '', /卡住了.*#1365.*NO_PROGRESS.*10:16（16 分钟前）/);
  assert.match(f.text(), /还没入队的开放 PR.*#1365.*PR #1366/);
  assert.match(f.text(), /现在没有车头.*只撤不发/);
});

test('shows train front, running batch, queue order, unqueued pulls and node details', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, page('fifo', 0, []));
  await resolveResident(f, resident(residentNode({ view: nodeView({
    current: { ...pull(1367), stage: 1, stageName: '准入', since: minutesAgo(3), stageSince: minutesAgo(2) },
    pending: [pending(1366, 2), pending(1368, 1), pending(1369, null)],
    unqueued: [pull(1370)],
    train: { enabled: 'on', last: { at: minutesAgo(2), mode: 'on', front: { pr: 1367 }, onDuty: true } },
    alerts: ['正在排空等待升级'],
  }) })));
  const text = f.text();
  for (const expected of [
    '运转正常：DESK 当班，在跑 PR #1367 第 1 段',
    'tdoljyj/cross-memory-system 的 main 分支', '车头（持有合并位）：PR #1367', '列车上次运行 10:30（2 分钟前），模式 on',
    '正在跑：PR #1367 · 第 1 段（准入） · 本段已 2 分钟 · 本批已 3 分钟 · 节点 DESK',
    '顺序以当班节点本机队列为准', '第 1 位 · PR #1368（提交 abcdef12） · 已等 16 分钟 · 等待准入',
    '第 2 位 · PR #1366', '等候中 · PR #1369', 'PR #1370（提交 abcdef12） · 节点还没有接它',
    'DESK · 当班 · 第 21 代（Source abcdef123456） · 两侧版本一致 · 自检通过（10:29（3 分钟前））',
    '心跳 10:31（1 分钟前）', '升级中：排空（自 10:28（4 分钟前））', '正在排空等待升级',
  ]) assert.ok(text.includes(expected), expected);
  assert.ok(text.indexOf('第 1 位 · PR #1368') < text.indexOf('第 2 位 · PR #1366'));
  assert.ok(text.indexOf('正在排空等待升级') < text.indexOf('合并顺序'));
  assert.ok(!text.includes('现在没有经常驻 CI 入队的拉取请求'));
});

test('server-reported silence raises a red alert and excludes the node from duty', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  await resolveResident(f, resident(residentNode({ silent: true, last_heartbeat_at: minutesAgo(1) })));
  assert.deepEqual(alerts(f), ['节点 DESK 已 1 分钟没有心跳', '现在没有当班节点']);
  assert.ok(!f.text().includes('运转正常'));
});

test('a partial queue view preserves another node’s silence alert and the ordering switch', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  await assert.doesNotReject(() => resolveResident(f, resident(
    residentNode({ name: 'A', view: {
      contract: 'clued.merge-queue-node-view/1', node: { upgrade: { phase: '排空' } }, train: null, executor: null,
    } }),
    residentNode({ name: 'B', holder: false, silent: true, view: null }),
  )));
  assert.ok(alerts(f).some(message => /节点 B .*没有心跳/.test(message)));
  assert.equal(f.button('改为按任务优先级').props.disabled, false);
});

test('before the first queue view, healthy heartbeat facts are still shown', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  await resolveResident(f, resident(residentNode({ view: null, view_reported_at: null })));
  assert.match(f.text(), /DESK.*心跳 10:31（1 分钟前）.*这台节点还没有上报队列视图/);
  assert.deepEqual(alerts(f), []);
  assert.ok(!f.text().includes('现在没有批次在跑'));
});

test('resident RPC failure leaves the merge ordering switch usable', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  assert.ok(f.residentCalls[0], 'the page calls the resident queue RPC');
  f.residentCalls[0].reject(Error('resident RPC unavailable'));
  await f.settle();
  assert.ok(f.text().includes('暂时读不到节点状态'));
  const toggle = f.button('改为按任务优先级');
  assert.equal(toggle.props.disabled, false);
  toggle.props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_merge_queue_ordering_set_v1',
    { p_input: { ordering: 'priority', base_version: 0 } }]);
});

test('resident polling runs every minute while visible, pauses when hidden and cleans up on unmount', async () => {
  const f = fixture(PAGE);
  try {
    await open(f);
    await resolveResident(f, resident(residentNode()));
    f.advance(59_999);
    assert.equal(f.residentCalls.length, 1);
    f.advance(1);
    assert.equal(f.residentCalls.length, 2);
    await resolveResident(f, resident(residentNode()));
    f.setHidden(true);
    f.advance(180_000);
    assert.equal(f.residentCalls.length, 2);
    f.setHidden(false);
    f.advance(60_000);
    assert.equal(f.residentCalls.length, 3);
    await resolveResident(f, resident(residentNode()));
    f.button('刷新').props.onClick();
    assert.equal(f.residentCalls.length, 4);
  } finally {
    f.unmount();
  }
  f.setHidden(true);
  f.setHidden(false);
  f.advance(60_000);
  assert.equal(f.residentCalls.length, 4);
});

test('two live ACTIVE reports show a double-active alert even with one holder', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  await resolveResident(f, resident(residentNode(), residentNode({
    name: 'TURING', holder: false, view: null,
  })));
  assert.match(alerts(f)[0] ?? '', /双活.*DESK.*TURING/);
  assert.ok(!f.text().includes('运转正常'));
});

test('a healthy node’s view becomes stale only after 21 minutes', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  await resolveResident(f, resident(residentNode({ view_reported_at: minutesAgo(21) })));
  assert.ok(!f.text().includes('队列视图未更新'));
  f.advance(60_000);
  await resolveResident(f, resident(residentNode({ view_reported_at: minutesAgo(22), view: nodeView({
    stall: { code: 'PAUSED', level: 'yellow', since: minutesAgo(23), text: '执行器已暂停' },
  }) })));
  assert.ok(statuses(f).some(text => text.includes('注意：DESK 队列视图未更新，下面是 10:10（22 分钟前）的旧读数')));
  assert.ok(statuses(f).some(text => text.includes('注意：执行器已暂停')));
  assert.deepEqual(alerts(f), []);
});

test('switching accounts drops the previous account’s view', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, page('priority', 3));
  assert.ok(f.text().includes('按任务优先级'));
  f.emit('SIGNED_IN', session('someone-else'));
  assert.ok(!f.text().includes('修复登录'));
  assert.equal(f.calls.at(-1).name, 'clued_merge_queue_v1');
});
