// Binding roles page (/bindings, Task 869d2db7, Owner Decision 38ddb8cf) under
// controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/bindings/page.tsx');
const REQUEST = '33333333-3333-4333-8333-333333333333';

function fixture(compiled, { id = REQUEST } = {}) {
  const hooks = [], effects = [], calls = [], fetches = [], signIns = [];
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
    signOut: async () => { authCallback?.('SIGNED_OUT', null); return { error: null }; },
    signInWithPassword: async credentials => { signIns.push(credentials); return { error: null }; } };
  const supabase = { auth, rpc(name, args) { let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    if (name === 'next/navigation') return { useParams: () => ({ id }) };
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
  return { calls, fetches, signIns, render, nodes, text, settle, emit, button, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));

const ROLES = [{ role: 'ci-admission', title: 'GitHub CI 准入（绑定 PR、计入 CI 额度、手动触发准入、合并后采纳）', required_scope: 'context:read' },
  { role: 'release-door', title: '生产发布门口（消费发布与迁移授权）', required_scope: 'context:write' }];
const listed = (ciRoles = []) => ({ data: { status: 'ok', roles: ROLES, bindings: [
  { binding_id: 'b-ci', agent_name: 'github-admission', vendor: 'github', scopes: ['context:read'], roles: ciRoles },
  { binding_id: 'b-claude', agent_name: 'Claude Code', vendor: 'anthropic', scopes: ['context:read', 'context:write'], roles: [] },
] }, error: null });
const issued = (enabled = true) => ({ data: { status: 'issued', confirmation_token: 'clued_brl_a', view_digest: 'd'.repeat(64),
  expires_at: '2099-01-01T00:05:00Z', confirmation_view: { binding_id: 'b-ci', agent_name: 'github-admission', vendor: 'github',
    scopes: ['context:read'], role: 'ci-admission', role_title: ROLES[0].title, enabled, others: [] } }, error: null });

async function open(f, ciRoles) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_binding_roles_list_v1', { p_input: {} }]);
  f.calls[0].resolve(listed(ciRoles)); await f.settle();
}

test('signed out: no calls, a link to sign in', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.ok(f.text().includes('登录 KooYomi'));
});

test('marking a role is two steps: Clued renders the change, 确认 commits exactly that token and digest', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  const shown = f.text();
  assert.ok(shown.includes('github-admission（github）'));
  assert.ok(shown.includes('Claude Code（anthropic）'));
  f.button('设为：CI 准入').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_binding_role_confirmation_issue_v1',
    { p_input: { binding_id: 'b-ci', role: 'ci-admission', enabled: true } }]);
  f.calls[1].resolve(issued()); await f.settle();
  const panel = f.nodes('section').find(n => n.props['aria-label'] === '确认更改');
  assert.ok(f.text(panel).includes('GitHub CI 准入'));
  assert.ok(f.text(panel).includes('设为专用'));
  // While a change waits for confirmation, no other change can start.
  assert.ok(f.nodes('button').filter(n => f.text(n).startsWith('设为')).every(n => n.props.disabled));
  f.button('确认').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_binding_role_set_v1',
    { p_input: { confirmation_token: 'clued_brl_a', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', binding_id: 'b-ci', role: 'ci-admission', enabled: true }, error: null });
  await f.settle();
  assert.equal(f.calls[3].name, 'clued_binding_roles_list_v1', 'the list is read again');
  f.calls[3].resolve(listed(['ci-admission'])); await f.settle();
  assert.ok(f.text().includes('已设定，立即生效。'));
  assert.ok(f.nodes('button').some(n => f.text(n) === '取消：CI 准入'));
  assert.equal(f.fetches.length, 0, 'the page never goes through a Worker route');
});

test('ending a role and backing out of a change', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, ['ci-admission']);
  f.button('取消：CI 准入').props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { binding_id: 'b-ci', role: 'ci-admission', enabled: false });
  f.calls[1].resolve(issued(false)); await f.settle();
  assert.ok(f.text().includes('取消专用'));
  f.button('取消').props.onClick(); f.render();
  assert.equal(f.nodes('section').find(n => n.props['aria-label'] === '确认更改'), undefined);
  assert.equal(f.calls.length, 2, 'backing out makes no call');
});

test('a refusal is shown in plain words', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('设为：发布门口').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'binding_role_scope_missing' }, error: null }); await f.settle();
  assert.ok(f.text().includes('缺少该用途需要的权限'));
});

test('a revoked or expired Binding that still holds a role is shown as 已失效 and can only be ended', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', roles: ROLES, bindings: [
    { binding_id: 'b-old', agent_name: 'old-admission', vendor: 'github', scopes: ['context:read'], roles: ['ci-admission'], live: false },
    { binding_id: 'b-new', agent_name: 'new-admission', vendor: 'github', scopes: ['context:read'], roles: [], live: true },
  ] }, error: null });
  await f.settle();
  const cards = f.nodes('div').filter(n => n.props.className === 'owner-grant');
  const oldCard = cards.find(n => f.text(n).includes('old-admission'));
  const newCard = cards.find(n => f.text(n).includes('new-admission'));
  assert.ok(f.text(oldCard).includes('已失效'));
  assert.deepEqual(f.nodes('button', oldCard).map(n => f.text(n)), ['取消：CI 准入'], 'a dead Binding offers only ending its role');
  assert.ok(!f.text(newCard).includes('已失效'));
  assert.deepEqual(f.nodes('button', newCard).map(n => f.text(n)), ['设为：CI 准入', '设为：发布门口']);
  f.nodes('button', oldCard)[0].props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { binding_id: 'b-old', role: 'ci-admission', enabled: false });
});
