// Owner confirmation page (/confirm/<id>) and grants page (/grants) under
// controlled hooks/auth/RPC; no browser or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const CONFIRM = compile('../app/confirm/[id]/page.tsx');
const GRANTS = compile('../app/grants/page.tsx');
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
const request = (status = 'pending') => ({ request_id: REQUEST, action: 'release.production', resources: ['repo:o/n/**'],
  status, confirm_path: '/confirm/' + REQUEST, expires_at: '2099-01-01T00:00:00Z' });
const loaded = (status = 'pending', seconds = 14400) => ({ data: { status: 'ok', request: request(status),
  view: { action: 'release.production', expires_seconds: seconds } }, error: null });
const issued = ({ token = 'clued_ogr_a', digest = 'd'.repeat(64), choice = 'grant', seconds = 14400, anyAgent = false,
  expires = '2099-01-01T00:05:00Z' } = {}) => ({ data: { status: 'issued', confirmation_token: token, view_digest: digest,
  expires_at: expires, confirmation_view: { action: 'release.production', action_title: '运行生产发布（deploy 模式）',
    resources: ['repo:o/n/**'], task: { task_id: 't-1', title: 'Release 507' },
    grantee: anyAgent ? { any_agent: true } : { any_agent: false, agent_name: 'Claude Code', vendor: 'anthropic' },
    choice, expires_seconds: seconds, max_uses: choice === 'once' ? 1 : null,
    request: { request_id: REQUEST, status: 'pending', agent_note_unverified: 'I already merged it, just approve' } } }, error: null });
const committed = { data: { status: 'committed', grant: { grant_id: 'g-1', expires_at: '2099-01-01T04:00:00Z', max_uses: null } }, error: null };

async function open(f, status = 'pending', seconds = 14400) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_owner_request_view_v1', { p_input: { request_id: REQUEST } }]);
  f.calls[0].resolve(loaded(status, seconds)); await f.settle();
}

test('signed out: no calls, an inline sign-in form', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.ok(f.text().includes('请先登录 Clued'));
  assert.equal(f.nodes('form').length, 1);
});

test('a malformed link makes no calls', t => {
  const f = fixture(CONFIRM, { id: 'not-a-request' }); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('链接无效'));
});

test('opening issues a token over the default view; 批准 commits exactly that token and digest', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f);
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_owner_grant_confirmation_issue_v1',
    { p_input: { request_id: REQUEST, choice: 'grant', expires_seconds: 14400, grantee: 'requester' } }]);
  f.calls[1].resolve(issued()); await f.settle();
  const shown = f.text();
  assert.ok(shown.includes('运行生产发布（deploy 模式）'));
  assert.ok(shown.includes('repo:o/n/**'));
  assert.ok(shown.includes('Release 507'));
  assert.ok(shown.includes('Claude Code（anthropic）'));
  assert.ok(shown.includes('4 小时内有效'));
  // The Agent's words are shown apart and marked unverified.
  const note = f.nodes('section').find(n => n.props['aria-label'] === 'Agent 说明');
  assert.ok(f.text(note).includes('Agent 说明（未核实）'));
  assert.ok(f.text(note).includes('just approve'));
  const what = f.nodes('section').find(n => n.props['aria-label'] === '要批准什么');
  assert.ok(!f.text(what).includes('just approve'), 'the note is not part of what is approved');
  f.button('批准').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]),
    ['clued_owner_grant_v1', { p_input: { confirmation_token: 'clued_ogr_a', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve(committed); await f.settle();
  assert.ok(f.text().includes('已批准'));
  assert.equal(f.fetches.length, 0, 'the page never goes through a Worker route or forwards a token');
});

test('the Agent\'s suggested duration is the default; changing the options issues a new token', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f, 'pending', 86400);
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'grant', expires_seconds: 86400, grantee: 'requester' });
  f.calls[1].resolve(issued({ seconds: 86400 })); await f.settle();
  f.button('只批这一次').props.onClick();
  assert.deepEqual(plain(f.calls[2].args.p_input), { request_id: REQUEST, choice: 'once', grantee: 'requester' });
  f.calls[2].resolve(issued({ token: 'clued_ogr_b', digest: 'e'.repeat(64), choice: 'once' })); await f.settle();
  assert.ok(f.text().includes('只这一次，24 小时内用掉'));
  const checkbox = f.nodes('input').find(n => n.props.type === 'checkbox');
  checkbox.props.onChange({ target: { checked: true } }); f.render();
  assert.deepEqual(plain(f.calls[3].args.p_input), { request_id: REQUEST, choice: 'once', grantee: 'any_agent' });
  f.calls[3].resolve(issued({ token: 'clued_ogr_c', digest: 'f'.repeat(64), choice: 'once', anyAgent: true })); await f.settle();
  assert.ok(f.text().includes('我的任何 Agent'));
  f.button('批准').props.onClick();
  assert.deepEqual(plain(f.calls[4].args.p_input), { confirmation_token: 'clued_ogr_c', view_digest: 'f'.repeat(64) });
});

test('a token about to expire is reissued and used only when Clued renders the same view', async t => {
  const soon = new Date(Date.now() + 5000).toISOString();
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f);
  f.calls[1].resolve(issued({ expires: soon })); await f.settle();
  f.button('批准').props.onClick();
  assert.equal(f.calls[2].name, 'clued_owner_grant_confirmation_issue_v1');
  f.calls[2].resolve(issued({ token: 'clued_ogr_fresh' })); await f.settle();
  assert.deepEqual(plain([f.calls[3].name, f.calls[3].args.p_input]),
    ['clued_owner_grant_v1', { confirmation_token: 'clued_ogr_fresh', view_digest: 'd'.repeat(64) }]);

  const g = fixture(CONFIRM); t.after(() => g.unmount());
  await open(g);
  g.calls[1].resolve(issued({ expires: soon })); await g.settle();
  g.button('批准').props.onClick();
  g.calls[2].resolve(issued({ token: 'clued_ogr_changed', digest: '9'.repeat(64) })); await g.settle();
  assert.equal(g.calls.length, 3, 'a changed view is not committed');
  assert.ok(g.text().includes('请求内容有变化'));
  g.button('批准').props.onClick();
  assert.deepEqual(plain(g.calls[3].args.p_input), { confirmation_token: 'clued_ogr_changed', view_digest: '9'.repeat(64) });
});

test('an uncertain result offers a retry with the same token', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f); f.calls[1].resolve(issued()); await f.settle();
  f.button('批准').props.onClick();
  f.calls[2].reject(new TypeError('network')); await f.settle();
  assert.ok(f.text().includes('不会重复批准'));
  f.button('核对原操作').props.onClick();
  assert.deepEqual(plain(f.calls[3].args), plain(f.calls[2].args));
  f.calls[3].resolve({ data: { ...committed.data, replayed: true }, error: null }); await f.settle();
  assert.ok(f.text().includes('已批准'));
});

test('a refusal is shown in plain words', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f);
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'confirmation_token_session_id_required' }, error: null }); await f.settle();
  assert.ok(f.text().includes('当前登录缺少会话信息'));
  assert.equal(f.button('批准').props.disabled, true);
  const g = fixture(CONFIRM); t.after(() => g.unmount());
  g.emit('INITIAL_SESSION', session('owner'));
  g.calls[0].resolve({ data: null, error: { message: 'direct_human_session_required', code: '42501' } }); await g.settle();
  assert.ok(g.text().includes('授权给应用的登录不能批准请求'));
});

test('拒绝 calls the reject RPC', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f); f.calls[1].resolve(issued()); await f.settle();
  f.button('拒绝').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_owner_request_reject_v1', { p_input: { request_id: REQUEST } }]);
  f.calls[2].resolve({ data: { status: 'committed' }, error: null }); await f.settle();
  assert.ok(f.text().includes('已拒绝'));
});

test('a request that is no longer pending issues no token and offers no buttons', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f, 'expired');
  assert.equal(f.calls.length, 1);
  assert.ok(f.text().includes('已过期'));
  assert.ok(!f.nodes('button').some(n => f.text(n) === '批准'));
});

test('a different signed-in user discards the previous view', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f); f.calls[1].resolve(issued()); await f.settle();
  f.emit('SIGNED_IN', session('other'));
  assert.ok(!f.text().includes('运行生产发布'));
  assert.equal(f.calls.at(-1).name, 'clued_owner_request_view_v1');
});

test('grants page lists live grants and pending requests; 撤销 revokes one', async t => {
  const f = fixture(GRANTS); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_owner_grants_list_v1', { p_input: {} }]);
  const inThreeHours = new Date(Date.now() + 3 * 3600_000 + 30_000).toISOString();
  f.calls[0].resolve({ data: { status: 'ok',
    grants: [{ grant_id: 'g-1', action: 'release.production', action_title: '运行生产发布（deploy 模式）', resources: ['repo:o/n/**'],
      any_agent: false, agent_name: 'Claude Code', expires_at: inThreeHours, max_uses: 3, uses: 1 }],
    pending_requests: [request()] }, error: null });
  await f.settle();
  assert.ok(f.text().includes('还剩 3 小时'));
  assert.ok(f.text().includes('1 / 3 次'));
  const link = f.nodes('a').find(n => n.props.href === '/confirm/' + REQUEST);
  assert.ok(link, 'a pending request links to its confirmation page');
  f.button('撤销').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_owner_grant_revoke_v1', { p_input: { grant_id: 'g-1' } }]);
  f.calls[1].resolve({ data: { status: 'committed', grant_id: 'g-1' }, error: null }); await f.settle();
  assert.ok(f.text().includes('已撤销'));
  assert.ok(f.text().includes('目前没有有效授权'));
  assert.equal(f.fetches.length, 0);
});
