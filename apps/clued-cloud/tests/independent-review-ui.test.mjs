// Independent review setting (Task ed3755b4, Owner Decision d4663fa2),
// under controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/independent-review/page.tsx');

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
const state = (enabled, version, extra = {}) => ({ data: { status: 'ok', enabled, version, default: version === 0,
  updated_at: version === 0 ? null : '2026-10-08T16:00:00Z', receipt_id: version === 0 ? null : 'r-' + version, ...extra }, error: null });

async function open(f, initial = state(true, 0)) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_independent_review_setting_v1', { p_input: {} }]);
  f.calls[0].resolve(initial); await f.settle();
}

test('signed out: no calls, a link to sign in', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.ok(f.text().includes('登录 BeamingFace'));
});

test('the CI context suite actually imports the native review suite', () => {
  const source = readFileSync(new URL('./resume-constraint-index-db.test.mjs', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('resume-constraint-index-db.test.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.ok(parsed.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === './independent-review-db.test.mjs'),
    'an actual import declaration is required; comment text cannot run the suite');
});

test('a new account shows the default, on; turning it off sends the version shown', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  assert.ok(f.text().includes('已打开（默认）'));
  assert.ok(f.text().includes('Agent 改不了'));
  f.button('关闭自动授权').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_independent_review_setting_set_v1',
    { p_input: { enabled: false, base_version: 0 } }]);
  f.render();
  assert.ok(f.nodes('button').every(n => n.props.disabled), 'no second change while one is in flight');
  f.calls[1].resolve({ data: { ...state(false, 1).data, status: 'committed', changed: true }, error: null }); await f.settle();
  assert.ok(f.text().includes('已关闭'));
  assert.ok(!f.text().includes('（默认）'));
  assert.ok(f.text().includes('已关闭自动授权，后续审核按任务的明确许可进行。'));
  assert.equal(f.calls.length, 2);
  f.button('开启自动授权').props.onClick();
  assert.deepEqual(plain(f.calls[2].args.p_input), { enabled: true, base_version: 1 });
  assert.equal(f.fetches.length, 0, 'the page never goes through a Worker route');
});

test('a stale page is told so and shows the current setting', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('关闭自动授权').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'independent_review_setting_version_conflict',
    current: { enabled: false, version: 1 } }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_independent_review_setting_v1', 'the setting is read again');
  f.calls[2].resolve(state(false, 1)); await f.settle();
  assert.ok(f.text().includes('被改过'), 'the conflict message stays after the reload');
  assert.ok(f.text().includes('已关闭'));
  assert.ok(f.nodes('button').some(n => f.text(n) === '开启自动授权'));
});

test('a delegated login is refused in plain words', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await f.settle();
  assert.ok(f.text().includes('需要你本人直接登录 BeamingFace'));
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false, 'no switch without a read setting');
});

test('switching accounts drops the previous account’s setting', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, state(false, 3));
  assert.ok(f.text().includes('已关闭'));
  f.emit('SIGNED_IN', session('someone-else'));
  assert.ok(!f.text().includes('已关闭'));
  assert.equal(f.calls.at(-1).name, 'clued_independent_review_setting_v1');
});

test('unknown or malformed state never shows an enabled switch', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, state('true', 0));
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false);
  assert.ok(f.text().includes('无法识别'));
});

for (const status of [undefined, 'pending', 'committed']) test(`a setting read without explicit ok is unknown (${status})`, async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, state(true, 0, { status }));
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false);
  assert.ok(f.text().includes('无法识别'));
});

for (const reply of [
  { status: 'pending', changed: true },
  { status: undefined, changed: true },
  { status: 'committed', changed: undefined },
]) test(`a write must explicitly commit before showing completion (${reply.status}/${reply.changed})`, async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('关闭自动授权').props.onClick();
  f.calls[1].resolve({ data: { ...state(false, 1).data, ...reply }, error: null });
  await f.settle();
  assert.equal(f.calls[2].name, 'clued_independent_review_setting_v1');
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false);
  assert.ok(!f.text().includes('已关闭自动授权，后续审核按任务的明确许可进行。'));
  f.calls[2].resolve(state(false, 1)); await f.settle();
  assert.equal(f.nodes('button').find(n => n.props.role === 'switch').props['aria-checked'], false);
  assert.ok(f.text().includes('无法识别'));
});

test('switch has an accessible checked state and no execution approval', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  const toggle = f.nodes('button').find(n => n.props.role === 'switch');
  assert.equal(toggle.props['aria-label'], '独立审核自动授权');
  assert.equal(toggle.props['aria-checked'], true);
  assert.ok(f.text().includes('不批准修改、合并、部署或发布'));
  assert.ok(f.text().includes('已完成的结论会保留'));
});

test('refresh failure clears the last observed policy', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('刷新').props.onClick(); f.render();
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false);
  f.calls[1].reject(Error('offline')); await f.settle();
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false);
  assert.ok(f.text().includes('网络请求未完成'));
});

test('late setting writes from another account cannot change the current view', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('关闭自动授权').props.onClick(); f.render();
  f.emit('SIGNED_IN', session('another'));
  f.calls[2].resolve(state(false, 5)); await f.settle();
  f.calls[1].resolve({ data: { ...state(true, 99).data, status: 'committed' }, error: null }); await f.settle();
  assert.equal(f.nodes('button').find(n => n.props.role === 'switch').props['aria-checked'], false);
  assert.ok(!f.text().includes('后续审核不再逐次询问'));
});

test('failed or uncertain writes read the real setting rather than guess completion', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('关闭自动授权').props.onClick(); f.render();
  f.calls[1].reject(Error('lost response')); await f.settle();
  assert.equal(f.calls[2].name, 'clued_independent_review_setting_v1');
  assert.equal(f.nodes('button').some(n => n.props.role === 'switch'), false);
  f.calls[2].resolve(state(false, 1)); await f.settle();
  assert.ok(f.text().includes('已关闭'));
  assert.ok(!f.text().includes('已关闭自动授权，后续审核按任务的明确许可进行。'));
});

