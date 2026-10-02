// Work Claim exemption page under controlled hooks/auth/RPC; no browser or live API claims.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../app/work-claims/exemption/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const TASK = '11111111-1111-4111-8111-111111111111';

function fixture({ search = '' } = {}) {
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
    if (name.endsWith('contexts.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    throw Error(name);
  }, Error, URLSearchParams, Date, Number, String,
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
  function input(label) { const l = nodes('label').find(n => text(n).startsWith(label)); assert.ok(l, label);
    return nodes.call(null, 'input').concat(nodes('textarea')).find(n => (Array.isArray(l.props.children) ? l.props.children : [l.props.children]).includes(n)); }
  render();
  return { calls, fetches, render, nodes, text, settle, emit, button, input, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const issued = { status: 'issued', confirmation_token: 'clued_wce_x', view_digest: 'd'.repeat(64), expires_at: '2026-10-02T17:00:00Z',
  confirmation_view: { task_id: TASK, task_title: 'M2', extra_claims: 5, valid_hours: 24, reason: 'finish' },
  task_status: { claims_last_24h: 22, max_claims_per_task_24h: 10 } };
const plain = value => JSON.parse(JSON.stringify(value));
const submit = f => f.nodes('form')[0].props.onSubmit({ preventDefault() {} });

test('signed-out page makes no calls and offers sign-in', t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('登录 Clued'));
});

test('a link fills the Task; preview then confirm call the two RPCs with the exact inputs', async t => {
  const f = fixture({ search: '?task=' + TASK.toUpperCase() + '&scope=global' }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  assert.equal(f.input('任务 ID').props.value, TASK);
  f.input('理由').props.onChange({ target: { value: '  finish  ' } }); f.render();
  submit(f);
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]),
    ['clued_work_claim_exemption_confirmation_issue_v1', { p_input: { task_id: TASK, scope: 'global', reason: 'finish' } }]);
  f.calls[0].resolve({ data: issued, error: null }); await f.settle();
  assert.ok(f.text().includes('过去 24 小时已领取 22 次，上限 10 次'));
  assert.ok(f.text().includes('再允许领取 5 次，24 小时内有效'));
  f.button('第二步：确认豁免').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]),
    ['clued_work_claim_exemption_grant_v1', { p_input: { confirmation_token: 'clued_wce_x', view_digest: 'd'.repeat(64) } }]);
  f.calls[1].resolve({ data: { status: 'committed', exemption: { exemption_id: 'e-1', expires_at: '2026-10-03T17:00:00Z', extra_claims: 5 } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('豁免已生效')); assert.ok(f.text().includes('e-1'));
  // The page never goes through a Worker route or forwards any token itself.
  assert.equal(f.fetches.length, 0);
});

test('a database refusal is shown in plain words and the form comes back', async t => {
  const f = fixture({ search: '?task=' + TASK }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.input('理由').props.onChange({ target: { value: 'finish' } }); f.render();
  submit(f);
  f.calls[0].resolve({ data: { status: 'rejected', error_code: 'reauthentication_required' }, error: null }); await f.settle();
  assert.ok(f.text().includes('15 分钟内需要重新登录'));
  assert.equal(f.nodes('form').length, 1);
  submit(f);
  f.calls[1].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await f.settle();
  assert.ok(f.text().includes('授权给应用的登录不能批准豁免'));
});

test('an uncertain grant result offers a retry with the same confirmation', async t => {
  const f = fixture({ search: '?task=' + TASK }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.input('理由').props.onChange({ target: { value: 'finish' } }); f.render();
  submit(f); f.calls[0].resolve({ data: issued, error: null }); await f.settle();
  f.button('第二步：确认豁免').props.onClick();
  f.calls[1].reject(new TypeError('network')); await f.settle();
  assert.ok(f.text().includes('不会重复豁免'));
  f.button('核对原操作').props.onClick();
  assert.deepEqual(plain(f.calls[2].args), plain(f.calls[1].args));
  f.calls[2].resolve({ data: { status: 'committed', replayed: true, exemption: { exemption_id: 'e-1', expires_at: '2026-10-03T17:00:00Z', extra_claims: 5 } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('豁免已生效'));
});

test('an invalid Task id in the link is ignored and the preview stays disabled', t => {
  const f = fixture({ search: '?task=not-a-task&scope=evil' }); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  assert.equal(f.input('任务 ID').props.value, '');
  assert.equal(f.input('范围').props.value, 'global');
  assert.equal(f.button('第一步：生成确认预览').props.disabled, true);
});
