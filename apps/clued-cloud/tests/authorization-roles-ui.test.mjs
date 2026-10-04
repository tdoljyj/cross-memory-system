// Connection management page (/oauth/connections) for preset roles and
// "我的全部项目（含以后新建的）" (PermissionSimplification.v0.1 §3.1, Task 0756c748).
// Runs the real component under a small hook harness with controlled auth and fetch.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const PAGE = ts.transpileModule(readFileSync(new URL('../app/oauth/connections/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function fixture(respond) {
  const hooks = [], effects = [], timers = new Map(), requests = [];
  let cursor = 0, authCallback, root, seq = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useCallback(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { callback, deps }; return hooks[i].callback; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const session = { user: { id: 'owner', email: 'owner@example.test' }, access_token: 'fixture-owner' };
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    getSession: async () => ({ data: { session }, error: null }), signOut: async () => ({ error: null }) };
  const exports = {};
  vm.runInNewContext(PAGE, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase: { auth } };
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    if (name === './headless') return { __esModule: true, default: () => null };
    throw Error(name);
  }, AbortController, Error, TypeError, JSON, Date, Number, String, Math, Array, Object,
  window: { setTimeout(cb) { const id = ++seq; timers.set(id, cb); return id; }, clearTimeout(id) { timers.delete(id); }, confirm: () => true },
  fetch: async (url, options = {}) => { requests.push({ url, options }); const body = respond(url, options);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(from); return out; }
  function text(...args) { const n = args.length ? args[0] : root; if (Array.isArray(n)) return n.map(m => text(m)).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); }
  async function open() { render(); authCallback('INITIAL_SESSION', session); render();
    const pending = [...timers.values()]; timers.clear(); pending.forEach(f => f()); await settle(); }
  return { requests, nodes, text, settle, open, render };
}

const A = 'project:11111111-1111-4111-8111-111111111111';
const B = 'project:22222222-2222-4222-8222-222222222222';
const DEV = ['read', 'write', 'close', 'restore'];
const scope = (resource_id, actions) => ({ resource_kind: 'scope', resource_id, environment: 'canonical', actions, effective_actions: actions });
const connection = (grants, version = 3) => ({ binding_id: 'b-1', client_id: 'chatgpt', client_name: 'ChatGPT', version,
  expires_at: '2099-01-01T00:00:00Z', active: true, grants });

test('a 项目开发者 connection on 我的全部项目 shows its role and range, not each covered project', async () => {
  let listed = [connection([scope('global', ['read']), scope('project:*', DEV), scope(A, DEV), scope(B, DEV)])];
  const f = fixture((url, options) => {
    if (url === '/v1/storage/owner') return { clients: [] };
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      listed = [connection([scope('global', ['read']), scope('project:*', ['read']), scope(A, ['read']), scope(B, ['read'])], 4)];
      return { binding_id: body.binding_id, version: 4 };
    }
    return { bindings: listed };
  });
  await f.open();
  const card = f.nodes('article')[0];
  assert.ok(card, 'the connection is listed');
  const shown = f.text(card);
  assert.ok(shown.includes('项目开发者'));
  assert.ok(shown.includes('我的全部项目（含以后新建的，只含你自己的项目）'));
  const legends = f.nodes('legend', card).map(n => f.text(n));
  assert.deepEqual(legends, ['全局视图 · 正式记忆', '我的全部项目（含以后新建的） · 正式记忆'], 'covered projects are not listed');
  // Untick write on project:*: the reduction sends project:* narrowed and no covered project row.
  const all = f.nodes('fieldset', card)[1];
  const write = f.nodes('input', all).find((n, i) => i === 1);
  write.props.onChange({ target: { checked: false } }); f.render();
  const save = f.nodes('button').find(n => f.text(n) === '保存减少后的权限');
  save.props.onClick(); await f.settle();
  const post = f.requests.find(r => r.options.method === 'POST' && r.url === '/oauth/connections/api');
  const sent = JSON.parse(post.options.body);
  assert.equal(sent.op, 'reduce');
  assert.deepEqual(sent.selected.map(g => [g.resource_id, g.actions]),
    [['global', ['read']], ['project:*', ['read', 'close', 'restore']]]);
  // Clued rebuilt the projects from project:*: the page accepts that as confirmed.
  assert.ok(f.text().includes('权限已减少'), f.text());
});

test('role names follow the entries; unticking 我的全部项目 shows the projects again', async () => {
  const f = fixture((url) => url === '/v1/storage/owner' ? { clients: [] } : { bindings: [
    { ...connection([scope('global', ['read']), scope('profile', ['read']), scope(A, ['read'])]), binding_id: 'r' },
    { ...connection([scope('global', ['read', 'write', 'close', 'restore', 'audit']), scope('profile', ['read', 'write', 'close', 'restore']),
      scope(A, ['read', 'write', 'close', 'restore'])]), binding_id: 'f' },
    { ...connection([scope('global', ['read', 'write']), scope('project:*', DEV), scope(A, DEV)]), binding_id: 'c' },
  ] });
  await f.open();
  const cards = f.nodes('article');
  const role = card => { const dd = f.nodes('div', card).find(n => f.text(n).startsWith('角色')); return f.text(dd).replace('角色', ''); };
  assert.deepEqual(cards.map(role), ['只读', '全部', '自定义']);
  const custom = cards[2];
  assert.equal(f.nodes('legend', custom).length, 2);
  for (const box of f.nodes('input', f.nodes('fieldset', custom)[1])) box.props.onChange({ target: { checked: false } });
  f.render();
  assert.equal(f.nodes('legend', f.nodes('article')[2]).length, 3, 'with project:* unticked each project can be kept or removed');
});
