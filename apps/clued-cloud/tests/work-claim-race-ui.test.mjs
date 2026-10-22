// Multi-copy (race) page under controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
// The Owner work claims page (list and handover) runs with this file, under
// npm run test:authorization:pages.
import './work-claims-owner-ui.case.mjs';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const RACE = compile('../app/work-claims/race/page.tsx');
const GRANTS = compile('../app/grants/page.tsx');
const TASK = '11111111-1111-4111-8111-111111111111';

function fixture(compiled, { search = '' } = {}) {
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
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; },
    signOut: async () => { authCallback?.('SIGNED_OUT', null); return { error: null }; } };
  const supabase = { auth, rpc(name, args) { let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    // Grants navigation only; automatic approval behavior has its own tests.
    if (name === './AutoApprovalSwitch') return { __esModule: true, default: 'auto-approval-switch', isAutoApprovalState: () => false };
    throw Error(name);
  }, Error, URLSearchParams, Date, Number, String, Array,
  window: { location: { search } },
  fetch(url) { fetches.push(url); return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(root); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function button(t) { const n = nodes('button').find(n => text(n) === t); assert.ok(n, t); return n; }
  function field(label) { const l = nodes('label').find(n => text(n).startsWith(label)); assert.ok(l, label);
    const children = Array.isArray(l.props.children) ? l.props.children : [l.props.children];
    return children.find(n => n && typeof n === 'object' && (n.type === 'input' || n.type === 'textarea')); }
  function type(label, value) { field(label).props.onChange({ target: { value } }); render(); }
  render();
  return { calls, fetches, render, nodes, text, settle, emit, button, field, type, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));
const submit = f => f.nodes('form')[0].props.onSubmit({ preventDefault() {} });
const issued = { status: 'issued', confirmation_token: 'clued_wcm_x', view_digest: 'd'.repeat(64), expires_at: '2026-10-03T17:00:00Z',
  confirmation_view: { action: 'work_claim_multi', task_id: TASK, task_title: 'Landing page', scope: 'global', copies: 3,
    shared_resources: ['apps/site/**', 'storage:c1/site'] }, suggested_copies: 4, max_copies: 8, authoritative: false };
const committed = (replayed = false) => ({ data: { status: 'committed', replayed, receipt_id: 'r-1',
  race: { task_id: TASK, copies: 3, shared_resources: ['apps/site/**', 'storage:c1/site'], enabled_at: '2026-10-03T16:56:00Z' } }, error: null });
function fill(f) { f.type('份数', ' 3 '); f.type('共享资源', '  apps/site/**\n\nstorage:c1/site  \n'); }

test('signed-out page makes no calls and offers sign-in', t => {
  const f = fixture(RACE); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('登录 BeamingFace'));
});

test('a link fills the Task; preview then confirm call the two Native RPCs with the exact inputs', async t => {
  const f = fixture(RACE, { search: '?task=' + TASK.toUpperCase() + '&scope=global' }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  assert.equal(f.field('任务 ID').props.value, TASK);
  fill(f); submit(f);
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_work_claim_multi_confirmation_issue_v1',
    { p_input: { task_id: TASK, scope: 'global', copies: 3, shared_resources: ['apps/site/**', 'storage:c1/site'] } }]);
  f.calls[0].resolve({ data: issued, error: null }); await f.settle();
  assert.ok(f.text().includes('任务：Landing page'));
  assert.ok(f.text().includes('份数：3（建议 4 份'));
  assert.ok(f.text().includes('storage:c1/site'));
  f.button('第二步：确认开启').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]),
    ['clued_work_claim_multi_enable_v1', { p_input: { confirmation_token: 'clued_wcm_x', view_digest: 'd'.repeat(64) } }]);
  f.calls[1].resolve(committed()); await f.settle();
  assert.ok(f.text().includes('多份模式已开启'));
  assert.ok(f.text().includes('最多 3 份同时进行'));
  // The page never goes through a Worker route or forwards any token itself.
  assert.equal(f.fetches.length, 0);
});

test('the form stays disabled until copies and shared resources are valid', t => {
  const f = fixture(RACE, { search: '?task=' + TASK }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  const disabled = () => f.button('第一步：生成确认预览').props.disabled;
  assert.equal(disabled(), true, 'no shared resources yet');
  f.type('共享资源', 'apps/site/**');
  assert.equal(disabled(), false);
  for (const value of ['1', '9', 'x', '']) { f.type('份数', value); assert.equal(disabled(), true, value); }
  f.type('份数', '8'); assert.equal(disabled(), false);
  f.type('共享资源', 'apps/my site/**'); assert.equal(disabled(), true, 'a resource with whitespace');
  submit(f); assert.equal(f.calls.length, 0);
});

test('a database refusal is shown in plain words and the form comes back', async t => {
  const f = fixture(RACE, { search: '?task=' + TASK }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  fill(f); submit(f);
  f.calls[0].resolve({ data: { status: 'rejected', error_code: 'work_claim_multi_task_busy' }, error: null }); await f.settle();
  assert.ok(f.text().includes('正被领取中'));
  assert.equal(f.nodes('form').length, 1);
  submit(f);
  f.calls[1].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await f.settle();
  assert.ok(f.text().includes('授权给应用的登录不能开启多份模式'));
  submit(f);
  f.calls[2].resolve({ data: { status: 'rejected', error_code: 'work_claim_multi_already_set' }, error: null }); await f.settle();
  assert.ok(f.text().includes('每个任务只能开一次'));
});

test('an uncertain enable result offers a retry with the same confirmation', async t => {
  const f = fixture(RACE, { search: '?task=' + TASK }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  fill(f); submit(f); f.calls[0].resolve({ data: issued, error: null }); await f.settle();
  f.button('第二步：确认开启').props.onClick();
  f.calls[1].reject(new TypeError('network')); await f.settle();
  assert.ok(f.text().includes('不会重复开启'));
  f.button('核对原操作').props.onClick();
  assert.deepEqual(plain(f.calls[2].args), plain(f.calls[1].args));
  f.calls[2].resolve(committed(true)); await f.settle();
  assert.ok(f.text().includes('多份模式已开启'));
});

test('a definite enable refusal returns to the form; another account resets the page', async t => {
  const f = fixture(RACE, { search: '?task=' + TASK }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  fill(f); submit(f); f.calls[0].resolve({ data: issued, error: null }); await f.settle();
  f.button('第二步：确认开启').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'confirmation_token_expired' }, error: null }); await f.settle();
  assert.ok(f.text().includes('5 分钟有效期'));
  assert.equal(f.nodes('form').length, 1);
  submit(f); f.calls[2].resolve({ data: issued, error: null }); await f.settle();
  f.emit('SIGNED_IN', session('other'));
  assert.equal(f.nodes('form').length, 1, 'the preview of the previous account is gone');
  assert.ok(!f.text().includes('请核对后确认'));
});

test('an invalid Task id in the link is ignored', t => {
  const f = fixture(RACE, { search: '?task=not-a-task&scope=evil' }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  assert.equal(f.field('任务 ID').props.value, '');
  assert.equal(f.field('范围').props.value, 'global');
});

test('the grants page links to the race page', t => {
  const f = fixture(GRANTS); t.after(() => f.unmount());
  assert.ok(f.nodes('a').some(n => n.props.href === '/work-claims/race'));
});
