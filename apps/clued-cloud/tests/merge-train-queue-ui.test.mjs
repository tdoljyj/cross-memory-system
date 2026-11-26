// Merge queue page (/merge-queue, migration 20261031060000, Task a3701d3d)
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

function fixture(compiled) {
  const hooks = [], effects = [], calls = [], fetches = [];
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
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    throw Error(name);
  }, Error, Date, Number, String, Math, Array,
  fetch(url) { fetches.push(url); return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function button(t) { const n = nodes('button').find(n => text(n) === t); assert.ok(n, t); return n; }
  render();
  return { calls, fetches, render, nodes, text, settle, emit, button, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
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
  assert.ok(f.text().includes('登录 BeamingFace'));
});

test('the default is join order; the queue shows each claim with its automatic priority', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  assert.ok(f.text().includes('这里列出由常驻 CI 测试并放入合并队列的拉取请求。同一个分支一次只合并其中一个。'),
    'the introduction describes only pull requests queued by resident CI');
  assert.ok(f.text().includes('现在：按排队先后（默认）'));
  assert.ok(f.text().includes('Agent 改不了'));
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
  assert.ok(f.text().includes('排在第一位的不变'));
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

test('an empty queue explains when the ordering setting has no effect', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, page('fifo', 0, []));
  assert.ok(f.text().includes('现在没有经常驻 CI 入队的拉取请求。仓库的合入不经常驻 CI 时（例如由 GitHub 自动合入），这里会一直是空的，本页的顺序设置也不起作用。'),
    'the empty state describes the scope of the queue and the ordering setting');
});

test('switching accounts drops the previous account’s view', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, page('priority', 3));
  assert.ok(f.text().includes('按任务优先级'));
  f.emit('SIGNED_IN', session('someone-else'));
  assert.ok(!f.text().includes('修复登录'));
  assert.equal(f.calls.at(-1).name, 'clued_merge_queue_v1');
});
