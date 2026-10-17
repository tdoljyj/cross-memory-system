// Executes actual TS/TSX modules with controlled auth/network. This VM does not prove browser layout or live OAuth acceptance.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

function compile(relative) {
  return ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
}
const sources = {
  authorization: compile('../lib/context-authorization.ts'),
  selection: compile('../app/oauth/consent/consent-selection.ts'),
  permissions: compile('../app/oauth/consent/consent-permissions.tsx'),
  consent: compile('../app/oauth/consent/delegated-consent.tsx'),
  account: compile('../app/oauth/account/page.tsx'),
};
function fixture(source = 'consent', extraAuth = {}) {
  const hooks = [], effects = [], timers = new Map(), requests = [], navigations = [], modules = new Map();
  let cursor = 0, authCallback, root, seq = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useCallback(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { callback, deps }; return hooks[i].callback; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const auth = {
    onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; },
    signInWithPassword: async () => ({ error: null }),
    signOut: async () => { authCallback?.('SIGNED_OUT', null); return { error: null }; }, ...extraAuth,
  };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : ({ type, props });
  const environment = {
    AbortController, Error, TypeError, encodeURIComponent, URL,
    window: { setTimeout(cb) { const id = ++seq; timers.set(id, cb); return id; }, clearTimeout(id) { timers.delete(id); },
      location: { origin: 'https://clued.example.test', assign(url) { navigations.push(url); } } },
    fetch(url, options) { let resolve; const promise = new Promise(done => { resolve = done; }); requests.push({ url, options, resolve }); return promise; },
  };
  function load(key) {
    if (modules.has(key)) return modules.get(key);
    const exports = {}; modules.set(key, exports);
    vm.runInNewContext(sources[key], { ...environment, exports, require(name) {
      if (name === 'react') return React;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name.endsWith('/context-authorization')) return load('authorization');
      if (name === './consent-selection') return load('selection');
      if (name === './consent-permissions') return load('permissions');
      if (name === './consent.module.css') return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
      if (name.endsWith('/supabase-browser')) return { supabase: { auth }, restoreBrowserSession: async () => ({ session: null, error: null, authType: null }) };
      if (name === 'next/link') return { __esModule: true, default: 'a' };
      throw Error('Unexpected import: ' + name);
    } });
    return exports;
  }
  const component = load(source).default;
  function render() { cursor = 0; root = component({ requestId: 'a'.repeat(64) }); while (effects.length) effects.shift()(); return root; }
  function nodes(type, from = root) { const out = []; function visit(n) { if (Array.isArray(n)) return n.forEach(visit); if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); } visit(from); return out; }
  function text(n) { if (arguments.length === 0) n = root; if (Array.isArray(n)) return n.map(value => text(value)).join(''); if (n == null || typeof n === 'boolean') return ''; return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); render(); }
  const respond = (i, value, ok = true) => requests[i].resolve({ ok, json: async () => value });
  function button(label, from = root) { const node = nodes('button', from).find(n => text(n) === label); assert.ok(node, label); return node; }
  function checkbox(label) { const node = nodes('input').find(n => n.props.type === 'checkbox' && n.props['aria-label'] === label); assert.ok(node, label); return node; }
  render();
  return { requests, navigations, render, nodes, text, respond, settle, button, checkbox,
    emit(event, value) { authCallback(event, value); render(); },
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(cb => cb()); render(); },
    unmount() { hooks.forEach(h => h?.cleanup?.()); } };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const row = (id, actions) => ({ resource_kind: 'scope', resource_id: id, environment: 'canonical', ownership: 'self', actions });
const details = id => ({ request_id: 'request-' + id, version: 7, client_name: 'Fixture client', client_id: 'fixture-client',
  requested_scopes: ['context:read'], eligible: [row('global', ['read']), row('owned-project-records:future', ['read']), row('owned-project-contexts:future', ['read'])],
  user: { id, email: id + '@example.test' } });
async function ready(t, id = 'A') {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session(id)); f.runTimers(); f.respond(0, details(id)); await f.settle();
  assert.equal(f.button('允许所选权限').props.disabled, false); return f;
}

test('new tree preserves lifetime and sends exact edited permissions with request CAS', async t => {
  const f = await ready(t);
  f.checkbox('全部权限').props.onChange({ target: { checked: false } }); f.render();
  assert.equal(f.button('允许所选权限').props.disabled, true);
  f.checkbox('个人记录 · 读取').props.onChange({ target: { checked: true } }); f.render();
  f.checkbox('个人记录 · 读取').props.onChange({ target: { checked: true } }); f.render();
  const select = f.nodes('select')[0];
  assert.equal(select.props.value, 30); assert.deepEqual(f.nodes('option', select).map(n => n.props.value), [1, 7, 30, 90, 365]);
  select.props.onChange({ target: { value: '365' } }); f.render(); f.button('允许所选权限').props.onClick(); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { action: 'approve', selected: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }], days: 365, version: 7 });
  assert.match(f.requests[1].url, /\/oauth\/decision\?request_id=a{64}$/);
});

test('late account A GET cannot overwrite B identity or B edited permissions', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('A')); f.runTimers(); f.emit('SIGNED_IN', session('B')); f.runTimers();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.respond(1, details('B')); await f.settle();
  f.checkbox('个人记录 · 读取').props.onChange({ target: { checked: false } }); f.render();
  f.respond(0, details('A')); await f.settle();
  assert.ok(!f.text().includes('A@example.test')); assert.ok(f.text().includes('B@example.test'));
  assert.equal(f.checkbox('个人记录 · 读取').props.checked, false);
  f.button('允许所选权限').props.onClick(); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[2].options.body).selected.map(n => n.resource_id).sort(), ['owned-project-contexts:future', 'owned-project-records:future']);
});

test('same-account token refresh preserves choice; account change aborts a late POST redirect', async t => {
  const f = await ready(t);
  f.checkbox('个人记录 · 读取').props.onChange({ target: { checked: false } }); f.render();
  f.emit('TOKEN_REFRESHED', { ...session('A'), access_token: 'fixture-refreshed-A' });
  assert.equal(f.checkbox('个人记录 · 读取').props.checked, false); assert.equal(f.requests.length, 1);
  f.button('允许所选权限').props.onClick(); await f.settle();
  assert.equal(f.requests[1].options.headers.Authorization, 'Bearer fixture-refreshed-A');
  f.emit('SIGNED_IN', session('B')); f.runTimers(); assert.equal(f.requests[1].options.signal.aborted, true);
  f.respond(1, { redirect_url: 'https://client.example.test/callback?code=old' }); await f.settle();
  assert.deepEqual(f.navigations, []); assert.equal(f.nodes('input').some(n => n.props.type === 'checkbox'), false);
});

test('mismatched stable account cannot display or approve resources', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('A')); f.runTimers(); f.respond(0, details('B')); await f.settle();
  assert.ok(f.text().includes('授权请求与当前账户不匹配')); assert.equal(f.nodes('input').some(n => n.props.type === 'checkbox'), false);
  assert.equal(f.nodes('button').some(n => f.text(n) === '允许所选权限'), false);
});

test('explicit account switch clears the tree and aborts an in-flight decision', async t => {
  const f = await ready(t); f.button('允许所选权限').props.onClick(); await f.settle();
  await f.button('切换账户').props.onClick(); await f.settle(); assert.equal(f.requests[1].options.signal.aborted, true);
  f.respond(1, { redirect_url: 'https://client.example.test/callback?code=old' }); await f.settle();
  assert.deepEqual(f.navigations, []); assert.ok(!f.text().includes('A@example.test')); assert.equal(f.nodes('input').some(n => n.props.type === 'checkbox'), false);
});

test('two approval clicks dispatch one POST and never claim an unconfirmed success', async t => {
  const f = await ready(t); const approve = f.button('允许所选权限'); approve.props.onClick(); approve.props.onClick(); await f.settle();
  assert.equal(f.requests.length, 2); assert.equal(f.button('允许所选权限').props.disabled, true);
  f.respond(1, { error: 'fixture request changed' }, false); await f.settle();
  assert.ok(f.text().includes('fixture request changed')); assert.deepEqual(f.navigations, []); assert.equal(f.button('允许所选权限').props.disabled, false);
});

test('unmounted consent aborts denial and ignores its old redirect', async t => {
  const f = await ready(t); f.button('取消').props.onClick(); await f.settle();
  assert.deepEqual(JSON.parse(f.requests[1].options.body), { action: 'deny', selected: [], days: 30, version: 7 });
  f.unmount(); assert.equal(f.requests[1].options.signal.aborted, true);
  f.respond(1, { redirect_url: 'https://client.example.test/callback?error=access_denied' }); await f.settle(); assert.deepEqual(f.navigations, []);
});

function recoveryFixture(t) {
  const calls = [];
  const f = fixture('account', { resetPasswordForEmail(email, options) {
    let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ email, options, resolve, reject }); return pending;
  } });
  t.after(() => f.unmount());
  f.nodes('input')[0].props.onChange({ target: { value: ' person@example.test ' } }); f.render();
  const submit = () => f.nodes('form')[0].props.onSubmit({ preventDefault() {} });
  return { f, calls, submit };
}

test('password recovery uses existing home callback, prevents duplicate requests, and avoids account enumeration', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const first = submit(); const second = submit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, 'person@example.test');
  assert.equal(calls[0].options.redirectTo, 'https://clued.example.test/?type=recovery');
  calls[0].resolve({ error: null }); await Promise.all([first, second]); await f.settle();
  assert.ok(f.text().includes('如果该邮箱可以恢复账户'));
  assert.equal(f.requests.length, 0); // No live fetch or protected-data read occurred.
});

test('password recovery rate-limit failure does not claim an email was sent', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const request = submit(); calls[0].resolve({ error: { status: 429 } }); await request; await f.settle();
  assert.ok(f.text().includes('请求过于频繁'));
  assert.ok(!f.text().includes('你会收到密码重置链接'));
  assert.equal(f.button('发送重置链接').props.disabled, false);
});

test('unknown password recovery result remains unknown and permits an explicit retry', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const request = submit(); calls[0].reject(new TypeError('fixture network outage')); await request; await f.settle();
  assert.ok(f.text().includes('结果尚未确认'));
  assert.ok(!f.text().includes('你会收到密码重置链接'));
  assert.equal(f.button('发送重置链接').props.disabled, false);
});

test('unmounted recovery page ignores late acknowledgement', async t => {
  const { f, calls, submit } = recoveryFixture(t);
  const request = submit(); f.unmount(); calls[0].resolve({ error: null }); await request; await f.settle();
  assert.ok(!f.text().includes('你会收到密码重置链接'));
});
