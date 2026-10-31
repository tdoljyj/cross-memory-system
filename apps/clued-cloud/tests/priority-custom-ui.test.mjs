// Priority page (/priority, migration 20261031070000, Task a72ecb24, Owner
// Decision be5d5b6c) under controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/priority/page.tsx');

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
  }, Error, Date, Number, String, Math, Array, Boolean,
  fetch(url) { fetches.push(url); return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function buttons(t) { return nodes('button').filter(n => text(n) === t); }
  function input(label) { const n = nodes('input').find(n => n.props['aria-label'] === label); assert.ok(n, label); return n; }
  render();
  return { calls, fetches, render, nodes, text, settle, emit, buttons, input, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));
const custom = (priority, version, extra = {}) => ({ record_id: 'r', priority, version, source: null, owner_instruction: null,
  binding_id: null, agent_name: null, updated_at: null, receipt_id: null, undo_available: false, ...extra });
const item = (id, title, total, points, value) => ({ record_id: id, title, record_type: 'task', scope: 'global', project_name: 'KooYomi',
  execution_bucket: 'next', updated_at: '2026-10-31T06:00:00Z',
  automatic: { total, band: 'NORMAL', custom_points: points, candidate_status: 'ACTIVE_READY' }, custom: value });
const overview = (records = [
  item('task-a', '合并列车排队', 76, 24, custom(80, 1, { source: 'agent_on_owner_request', agent_name: 'Claude Code',
    owner_instruction: '把合并列车排到最前', updated_at: '2026-10-31T06:10:00Z', undo_available: true })),
  item('task-b', '算力面板', 52, 0, custom(0, 0)),
], history = [{ id: 7, record_id: 'task-a', title: '合并列车排队', priority: 80, previous_priority: 0,
  source: 'agent_on_owner_request', owner_instruction: '把合并列车排到最前', agent_name: 'Claude Code', undo_of: null,
  receipt_id: 'r7', created_at: '2026-10-31T06:10:00Z' }]) => ({ data: { status: 'ok', weight: 0.3, records, history }, error: null });

async function open(f, initial = overview()) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_priority_overview_v1', { p_input: {} }]);
  f.calls[0].resolve(initial); await f.settle();
}

test('signed out: no calls, a link to sign in', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.ok(f.text().includes('登录 BeamingFace'));
});

test('each value shows its source and the Owner’s words; the page explains it plainly', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  const page = f.text();
  assert.ok(page.includes('0.3 倍'));
  assert.ok(page.includes('Agent 自己不能填这个数'));
  assert.ok(page.includes('Claude Code 按你的要求代设'));
  assert.ok(page.includes('你的原话：「把合并列车排到最前」'));
  assert.ok(page.includes('（含你加的 24）'));
  assert.ok(page.includes('不设'));
  assert.equal(f.buttons('撤回上一次修改').length, 1, 'undo only where there is a change to undo');
  assert.ok(page.includes('不设 → 80'));
});

test('saving sends the version shown, reloads, and refuses a value outside 0-100 without calling', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.input('「算力面板」的优先级').props.onChange({ target: { value: '120' } }); f.render();
  f.buttons('保存')[1].props.onClick(); f.render();
  assert.equal(f.calls.length, 1);
  assert.ok(f.text().includes('请填 0 到 100 之间的整数'));
  f.input('「算力面板」的优先级').props.onChange({ target: { value: '60' } }); f.render();
  f.buttons('保存')[1].props.onClick(); f.render();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_priority_custom_set_v1',
    { p_input: { record_id: 'task-b', base_version: 0, priority: 60 } }]);
  assert.ok(f.nodes('button').every(n => n.props.disabled), 'no second change while one is in flight');
  f.calls[1].resolve({ data: { status: 'committed', changed: true, custom_priority: custom(60, 1, { source: 'owner_page' }) }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_priority_overview_v1', 'the list is read again');
  f.calls[2].resolve(overview()); await f.settle();
  assert.ok(f.text().includes('已保存，「算力面板」现在是 60。'));
  assert.equal(f.fetches.length, 0, 'the page never goes through a Worker route');
});

test('undo sends the record and the version shown', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.buttons('撤回上一次修改')[0].props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_priority_custom_undo_v1',
    { p_input: { record_id: 'task-a', base_version: 1 } }]);
  f.calls[1].resolve({ data: { status: 'committed', changed: true, custom_priority: custom(0, 2, { source: 'owner_undo' }) }, error: null });
  await f.settle();
  f.calls[2].resolve(overview()); await f.settle();
  assert.ok(f.text().includes('已撤回，「合并列车排队」现在是 0。'));
});

test('a stale page is told so and shows the current values', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.input('「算力面板」的优先级').props.onChange({ target: { value: '10' } }); f.render();
  f.buttons('保存')[1].props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'custom_priority_version_conflict', current: custom(40, 1) }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_priority_overview_v1');
  f.calls[2].resolve(overview()); await f.settle();
  assert.ok(f.text().includes('被改过'), 'the conflict message stays after the reload');
});

test('a delegated login is refused in plain words', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await f.settle();
  assert.ok(f.text().includes('需要你本人直接登录 BeamingFace'));
  assert.equal(f.buttons('保存').length, 0);
});

test('switching accounts drops the previous account’s values', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  assert.ok(f.text().includes('合并列车排队'));
  f.emit('SIGNED_IN', session('someone-else'));
  assert.ok(!f.text().includes('合并列车排队'));
  assert.equal(f.calls.at(-1).name, 'clued_priority_overview_v1');
});
