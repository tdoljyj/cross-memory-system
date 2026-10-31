// Heartbeat-only tokens (migration 20261031100000, Task f2e9a8c6) on the
// headless section of /oauth/connections, and OAuth consent never offering the
// scope; controlled hooks/auth/RPC, no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const transpile = (path, jsx = false) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
    ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}) } }).outputText;
const authExports = {}; vm.runInNewContext(transpile('../lib/context-authorization.ts'), { exports: authExports });
const CONTROLS_SOURCE = transpile('../lib/context-authorization-controls.tsx', true);
const consentExports = {};
vm.runInNewContext(transpile('../app/oauth/consent/consent-selection.ts'), { exports: consentExports,
  require(id) { if (id.endsWith('/context-authorization')) return authExports; throw Error(id); } });
function authorizationImport(name) {
  if (name.endsWith('/context-authorization')) return authExports;
  if (name.endsWith('/context-authorization-controls')) { const exports = {};
    vm.runInNewContext(CONTROLS_SOURCE, { exports, require(id) { if (id === './context-authorization') return authExports;
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }; throw Error(id); } }); return exports;
  }
  return null;
}
const COMPONENT = transpile('../app/oauth/connections/headless.tsx', true);

function fixture() {
  const hooks = [], effects = [], calls = [], copied = [];
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
  vm.runInNewContext(COMPONENT, { exports, require(name) { const shared = authorizationImport(name); if (shared) return shared;
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => typeof type === 'function' ? type(props) : ({ type, props }), jsxs: (type, props) => typeof type === 'function' ? type(props) : ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    throw Error(name);
  }, Error, Date, Number, String, Math, Array, JSON, Object,
  window: { location: { origin: 'https://clued.test' }, confirm: () => true },
  navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
  fetch() { return new Promise(() => {}); } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(n) { if (arguments.length === 0) n = root; if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function button(t, from) { const n = nodes('button', from).find(n => text(n) === t); assert.ok(n, t); return n; }
  render();
  return { calls, copied, render, nodes, text, settle, emit, button };
}

const plain = value => JSON.parse(JSON.stringify(value));
const ELIGIBLE = [
  { resource_kind: 'scope', resource_id: 'global', environment: 'canonical', name: 'Personal memory', actions: ['read', 'write', 'close', 'restore', 'audit'] },
  { resource_kind: 'scope', resource_id: 'project:p1', environment: 'canonical', name: 'Alpha', actions: ['read', 'write', 'close', 'restore', 'audit'] },
];
const ROWS = [
  { binding_id: 'b-head', agent_name: 'CI reader', vendor: 'Headless', kind: 'headless', expires_at: '2099-01-01T00:00:00Z',
    version: 2, roles: [], scopes: ['context:read'], grants: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] },
  { binding_id: 'b-heartbeat', agent_name: 'TURING heartbeat', vendor: 'Headless', kind: 'headless', expires_at: '2099-01-01T00:00:00Z',
    version: 1, roles: [], scopes: ['ci:heartbeat'], grants: [] },
];
const card = (f, name) => f.nodes('article').find(n => f.text(n).startsWith(name));

async function open(f) {
  f.emit('INITIAL_SESSION', { user: { id: 'owner', email: 'owner@example.test' }, access_token: 'fixture' });
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_headless_binding_list_v1', { p_input: {} }]);
  f.calls[0].resolve({ data: { status: 'ok', eligible: ELIGIBLE, bindings: ROWS }, error: null }); await f.settle();
}

test('a heartbeat token is its own two-step issue with no permission to choose; it is never rotated', async () => {
  const f = fixture();
  await open(f);
  const form = f.nodes('div').find(n => n.props?.['aria-label'] === '心跳令牌表单');
  assert.ok(form);
  assert.ok(f.text(form).includes('权限：仅发送常驻节点心跳（不能读取任何资料）'));
  assert.equal(f.button('预览心跳令牌', form).props.disabled, true, 'a name first');
  // The listed heartbeat token: its type and its only permission, no rotation.
  const heartbeatCard = card(f, 'TURING heartbeat');
  assert.ok(f.text(heartbeatCard).includes('常驻节点心跳令牌'));
  assert.ok(f.text(heartbeatCard).includes('权限仅发送常驻节点心跳（不能读取任何资料）'));
  assert.ok(!f.nodes('button', heartbeatCard).some(n => f.text(n) === '轮换为新令牌'));
  assert.ok(f.nodes('button', heartbeatCard).some(n => f.text(n) === '撤销'));
  assert.ok(f.nodes('button', card(f, 'CI reader')).some(n => f.text(n) === '轮换为新令牌'), 'ordinary tokens still rotate');
  // Step 1: only a name and an expiry.
  f.nodes('input', form)[0].props.onChange({ target: { value: ' DESK heartbeat ' } }); f.render();
  const select = f.nodes('select', f.nodes('div').find(n => n.props?.['aria-label'] === '心跳令牌表单'))[0];
  select.props.onChange({ target: { value: '30' } }); f.render();
  f.button('预览心跳令牌').props.onClick(); f.render();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_headless_heartbeat_binding_confirmation_issue_v1',
    { p_input: { label: 'DESK heartbeat', days: 30 } }]);
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_hbc_a', view_digest: 'd'.repeat(64),
    confirmation_view: { kind: 'headless_heartbeat_binding_issue', label: 'DESK heartbeat', days: 30, scopes: ['ci:heartbeat'], selected: [] } }, error: null });
  await f.settle();
  const confirm = f.nodes('section').find(n => n.props?.['aria-label'] === '确认签发心跳令牌');
  assert.ok(f.text(confirm).includes('权限仅发送常驻节点心跳（不能读取任何资料）'));
  assert.ok(f.text(confirm).includes('签发后 30 天'));
  // Step 2: exactly the previewed view; the token is shown once.
  f.button('确认签发心跳令牌').props.onClick(); f.render();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_headless_heartbeat_binding_issue_v1',
    { p_input: { confirmation_token: 'clued_hbc_a', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', binding_id: 'b-new', token: 'clued_hbt_' + 'x'.repeat(43),
    expires_at: '2099-01-01T00:00:00Z', scopes: ['ci:heartbeat'] }, error: null });
  await f.settle();
  assert.ok(f.text().includes('clued_hbt_' + 'x'.repeat(43)));
  assert.ok(f.text().includes('令牌已签发，只显示这一次'));
  assert.equal(f.calls[3].name, 'clued_headless_binding_list_v1', 'the list is read again');
  // A refusal is shown in plain words.
  f.calls[3].resolve({ data: { status: 'ok', eligible: ELIGIBLE, bindings: ROWS }, error: null }); await f.settle();
  const again = f.nodes('div').find(n => n.props?.['aria-label'] === '心跳令牌表单');
  f.nodes('input', again)[0].props.onChange({ target: { value: 'x' } }); f.render();
  f.button('预览心跳令牌').props.onClick(); f.render();
  f.calls[4].resolve({ data: { status: 'rejected', error_code: 'headless_binding_limit_reached' }, error: null }); await f.settle();
  assert.ok(f.text().includes('有效的无头令牌已达 50 个'));
});

test('OAuth never offers ci:heartbeat: consent and authorization helpers grant nothing for it; the Worker scope list is unchanged', () => {
  const rows = [...ELIGIBLE, { resource_kind: 'scope', resource_id: 'contexts:*', environment: 'canonical', actions: ['read', 'write', 'feedback_submit'] }];
  assert.deepEqual(plain(consentExports.requestedConsentResources(rows, ['ci:heartbeat']).map(row => row.actions)), [[], [], []]);
  assert.deepEqual(plain(authExports.requestedResources(rows, ['ci:heartbeat']).map(row => row.actions)), [[], [], []]);
  assert.ok(consentExports.requestedConsentResources(rows, ['context:read']).every(row => row.actions.length === 1), 'the helpers still work');
  const worker = readFileSync(new URL('../worker/delegated-oauth.ts', import.meta.url), 'utf8');
  assert.match(worker, /const SCOPES = \['context:read', 'context:write', 'audit:read'\];/);
  assert.match(worker, /auth\.scope\.some\(s => !SCOPES\.includes\(s\)\)/, '/oauth/authorize refuses any other scope');
});
