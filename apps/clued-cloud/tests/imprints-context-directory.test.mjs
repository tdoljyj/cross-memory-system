// Execute the actual ContextsPage AND ImprintPanel with controlled auth/HTTP/RPC.
// No browser, live account, MCP call, grant mutation or external write is used.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const PA = '11111111-1111-4111-8111-111111111111';
const PB = '22222222-2222-4222-8222-222222222222';
const CA = '33333333-3333-4333-8333-333333333333';
const CB = '44444444-4444-4444-8444-444444444444';
const RID = '55555555-5555-4555-8555-555555555555';
const plain = value => JSON.parse(JSON.stringify(value));
const session = (id, token = 'fixture-' + id) => ({ user: { id, email: id + '@example.test' }, access_token: token });
const space = (id = CA, project = PA, name = 'Alpha space') => ({ id, project_id: project, name,
  environment: 'test', cursor: 0, version: 1, created_at: '2026-10-13T00:00:00Z' });
const listing = (projects = [{ id: PA, name: 'Private Alpha project' }], contexts = [space()]) => ({ status: 'ok', projects, contexts });
const imprint = (context = CA, project = PA, body = 'ALPHA BODY') => ({ status: 'ok', records: [{ id: RID, title: body, content: body,
  record_type: 'annotation', canonical_scope: 'project:' + project, scope: 'project:' + project, version: 1,
  lifecycle_status: 'ACTIVE', domains: [], organization_version: 0, record_currentness: 'UNKNOWN',
  type_fields: {}, relations: {}, source_refs: [], source_kind: 'development', source_semantics: 'development_context',
  context_id: context, authority: 'candidate', qualification: 'candidate', authoritative: false }],
  page: { next_cursor: null, complete: true } });

function fixture({ standaloneLocale } = {}) {
  const hooks = new Map(), effects = [], microtasks = [], timers = new Map(), storage = new Map(), http = [], rpc = [], moduleCache = new Map();
  let active, cursor = 0, root, authCallback, disposed = false, dirty = false, rendering = false, progressive = false, timerId = 0;
  let panels = [], snapshots = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    useState(initial) { const slot = cursor++; active[slot] ??= { value: typeof initial === 'function' ? initial() : initial };
      const hook = active[slot]; return [hook.value, value => { const next = typeof value === 'function' ? value(hook.value) : value;
        if (!Object.is(next, hook.value)) { hook.value = next; dirty = true; if (progressive && !rendering) render(); } }]; },
    useRef(value) { const slot = cursor++; active[slot] ??= { current: value }; return active[slot]; },
    useMemo(make, deps) { const slot = cursor++; if (!active[slot] || !equal(active[slot].deps, deps)) active[slot] = { deps, value: make() }; return active[slot].value; },
    useCallback(callback, deps) { const slot = cursor++; if (!active[slot] || !equal(active[slot].deps, deps)) active[slot] = { deps, value: callback }; return active[slot].value; },
    useEffect(callback, deps) { const slot = cursor++; if (!active[slot] || !equal(active[slot].deps, deps)) {
      const old = active[slot], hook = { deps }; active[slot] = hook; effects.push(() => { old?.cleanup?.(); hook.cleanup = callback(); }); } },
  };
  React.useLayoutEffect = React.useEffect;
  const supabase = {
    auth: { onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; },
      async signOut() { return { error: null }; } },
    rpc(name, args) { let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      const call = { name, args, resolve, reject, headers: {} }; rpc.push(call);
      return { then: (...args) => pending.then(...args), setHeader(name, value) { call.headers[name] = value; return this; },
        abortSignal(signal) { call.signal = signal; return this; } }; },
  };
  function load(file) {
    if (moduleCache.has(file)) return moduleCache.get(file);
    const exports = {}; moduleCache.set(file, exports);
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    vm.runInNewContext(compiled, { exports, AbortController, Date, Intl, Map, Set, Array, JSON, Error, TextEncoder, crypto: webcrypto,
      setInterval, clearInterval, setTimeout, clearTimeout,
      queueMicrotask: callback => microtasks.push(callback),
      window: { sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } },
      fetch(url, options) { let resolve, reject; const pending = new Promise((yes, no) => { resolve = yes; reject = no; }); http.push({ url, options, resolve, reject }); return pending; },
      require(name) {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: 'fragment' };
        if (name === 'next/link') return { __esModule: true, default: 'a' };
        if (name.endsWith('/supabase-browser')) return { supabase };
        if (name.endsWith('.css')) return {};
        if (name.startsWith('.')) { const base = path.resolve(path.dirname(file), name); return load(existsSync(base + '.ts') ? base + '.ts' : base + '.tsx'); }
        throw Error(name);
      },
    }, { filename: file }); return exports;
  }
  const Page = load(path.join(APP, 'contexts/page.tsx')).default;
  const Panel = load(path.join(APP, 'imprints/ImprintPanel.tsx')).default;
  function nodes(type, from = root) { const found = []; (function visit(node) { if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return; if (node.type === type) found.push(node); visit(node.props?.children); })(from); return found; }
  function text(node) { if (arguments.length === 0) node = root; if (Array.isArray(node)) return node.map(text).join('');
    if (node == null || typeof node === 'boolean') return ''; return typeof node === 'object' ? text(node.props?.children ?? null) : String(node); }
  function render() {
    if (disposed) return root = null;
    rendering = true; let turns = 0;
    do {
      dirty = false; panels = []; const seen = new Set();
      function expand(node, key = 'root') {
        if (Array.isArray(node)) return node.map((item, i) => expand(item, key + '/' + (item?.key ?? i)));
        if (!node || typeof node !== 'object') return node;
        if (typeof node.type === 'function') {
          const id = key + ':' + node.type.name; seen.add(id); if (!hooks.has(id)) hooks.set(id, []);
          if (node.type === Panel) panels.push({ props: node.props, key: node.key });
          const previous = active, position = cursor; active = hooks.get(id); cursor = 0;
          const child = node.type(node.props); active = previous; cursor = position; return expand(child, id);
        }
        return { ...node, props: { ...node.props, children: expand(node.props?.children, key + '/' + node.type) } };
      }
      root = standaloneLocale ? expand({ type: Panel, props: { session: session('A'), locale: standaloneLocale, developmentContextId: CA,
        developmentContextName: 'Alpha space', projects: [{ id: PA, name: 'Private Alpha project' }] } }) : expand({ type: Page, props: {} });
      for (const [id, list] of hooks) if (!seen.has(id)) { list.forEach(hook => hook?.cleanup?.()); hooks.delete(id); }
      snapshots.push({ projects: nodes('option').map(node => node.props.value), panels: panels.map(({ props, key }) => ({ key,
        owner: props.session.user.id, token: props.session.access_token, context: props.developmentContextId, projects: props.projects.map(project => project.id) })) });
      while (effects.length) effects.shift()(); while (microtasks.length) microtasks.shift()(); if (++turns > 40) throw Error('render loop');
    } while (dirty);
    rendering = false; return root;
  }
  async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); render(); }
  function button(label) { const found = nodes('button').find(node => text(node) === label); assert.ok(found, label); return found; }
  function clickSpace(id) { const article = nodes('article').find(node => nodes('h3', node).some(heading => text(heading) === (id === CA ? 'Alpha space' : 'Beta space')));
    assert.ok(article, id); nodes('button', article).find(node => text(node) === '浏览此上下文印记').props.onClick(); render(); }
  render();
  return { http, rpc, render, settle, nodes, text, button, storage, panels: () => panels,
    emit(event, who, interleave = false) { snapshots = []; progressive = interleave; authCallback(event, who); progressive = false; render(); return snapshots; },
    timers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); render(); },
    async respondHttp(index, data, status = 200) { http[index].resolve({ ok: status < 400, status, json: async () => data }); await settle(); },
    async respondRpc(index, data) { rpc[index].resolve({ data, error: null }); await settle(); },
    click(label) { button(label).props.onClick(); render(); }, clickSpace,
    unmount() { disposed = true; hooks.forEach(list => list.forEach(hook => hook?.cleanup?.())); hooks.clear(); root = null; },
  };
}
async function loaded(t, data = listing(), who = session('A')) {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', who); f.timers(); await f.respondHttp(0, data); return f;
}

test('signed-out directory sends no request and mounts no Panel; existing connection/grant paths stay intact', t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null); f.timers();
  assert.equal(f.http.length, 0); assert.equal(f.rpc.length, 0); assert.equal(f.panels().length, 0);
  assert.equal(f.nodes('input').length, 0); assert.ok(f.nodes('a').some(node => node.props.href === '/oauth/connections'));
});

test('actual selected directory passes exactly its owned project/context/session to the actual Panel', async t => {
  const data = listing([{ id: PA, name: 'Private Alpha project' }, { id: PB, name: 'Private Beta project' }], [space(), space(CB, PB, 'Beta space')]);
  const f = await loaded(t, data); f.clickSpace(CA);
  const selected = f.panels()[0]; assert.equal(selected.key, 'A:' + CA);
  assert.equal(selected.props.session.access_token, 'fixture-A'); assert.equal(selected.props.developmentContextId, CA);
  assert.deepEqual(plain(selected.props.projects), [{ id: PA, name: 'Private Alpha project' }]);
  assert.equal(f.rpc[0].name, 'clued_development_imprint_read_v1'); assert.equal(f.rpc[0].args.p_input.context_id, CA);
  assert.equal(f.rpc[0].headers.Authorization, 'Bearer fixture-A');
  await f.respondRpc(0, imprint()); assert.ok(f.text().includes('ALPHA BODY'));
  const scope = f.nodes('select').find(node => node.props['aria-label'] === '查询范围');
  assert.deepEqual(f.nodes('option', scope).map(node => node.props.value), ['all', 'project:' + PA]);
  assert.equal(f.text(f.nodes('option', scope)[0]), '当前开发上下文');
  const hrefs = f.nodes('a').map(node => node.props.href); assert.ok(hrefs.includes('/oauth/projects')); assert.ok(hrefs.includes('/oauth/connections'));
  assert.ok(f.http.every(call => call.url === '/v1/development/owner' && JSON.parse(call.options.body).op === 'owner_list'));
});

test('context selection remounts Panel by its real key and discards a late read from the previous context', async t => {
  const f = await loaded(t, listing([{ id: PA, name: 'Private Alpha project' }, { id: PB, name: 'Private Beta project' }], [space(), space(CB, PB, 'Beta space')]));
  f.clickSpace(CA); await f.respondRpc(0, imprint()); f.click('刷新');
  f.clickSpace(CB); assert.equal(f.panels().length, 1); assert.equal(f.panels()[0].key, 'A:' + CB);
  assert.deepEqual(plain(f.panels()[0].props.projects), [{ id: PB, name: 'Private Beta project' }]);
  assert.ok(!f.text().includes('ALPHA BODY')); assert.equal(f.rpc[2].args.p_input.context_id, CB);
  await f.respondRpc(1, imprint(CA, PA, 'LATE ALPHA BODY')); assert.ok(!f.text().includes('LATE ALPHA BODY'));
  await f.respondRpc(2, imprint(CB, PB, 'ONLY BETA BODY')); assert.ok(f.text().includes('ONLY BETA BODY'));
});

test('render-owner guard hides A directory and Panel at every partially flushed B-session render', async t => {
  const f = await loaded(t); f.clickSpace(CA); await f.respondRpc(0, imprint()); f.click('刷新上下文');
  const frames = f.emit('SIGNED_IN', session('B'), true);
  // Simulate unbatched setter commits: setSession(B) renders before clearing the
  // old listing. The listingOwner guard itself, not only state clearing, must win.
  assert.ok(frames.length > 1); for (const frame of frames) { assert.ok(!frame.projects.includes(PA)); assert.equal(frame.panels.length, 0); }
  assert.equal(f.http[1].options.signal.aborted, true); f.timers();
  await f.respondHttp(1, listing()); assert.ok(!f.text().includes('Private Alpha project')); assert.equal(f.panels().length, 0);
  await f.respondHttp(2, listing([{ id: PB, name: 'Private Beta project' }], [space(CB, PB, 'Beta space')])); f.clickSpace(CB);
  assert.equal(f.panels()[0].props.session.user.id, 'B'); assert.equal(f.panels()[0].props.developmentContextId, CB);
  assert.equal(f.rpc[1].headers.Authorization, 'Bearer fixture-B');
});

test('same-owner token replacement invalidates listingOwner and old Panel before fresh listing arrives', async t => {
  const f = await loaded(t, listing(), session('A', 'token-old')); f.clickSpace(CA); await f.respondRpc(0, imprint()); f.click('刷新');
  const frames = f.emit('TOKEN_REFRESHED', session('A', 'token-new'), true);
  for (const frame of frames) { assert.ok(!frame.projects.includes(PA)); assert.equal(frame.panels.length, 0); }
  assert.ok(!f.text().includes('ALPHA BODY')); f.timers(); assert.equal(f.http[1].options.headers.Authorization, 'Bearer token-new');
  await f.respondRpc(1, imprint(CA, PA, 'OLD TOKEN BODY')); assert.ok(!f.text().includes('OLD TOKEN BODY'));
  await f.respondHttp(1, listing()); assert.equal(f.panels().length, 0, 'old selection is not silently reused'); f.clickSpace(CA);
  assert.equal(f.panels()[0].props.session.access_token, 'token-new'); assert.equal(f.rpc[2].headers.Authorization, 'Bearer token-new');
});

test('token A to B to A cannot revive the first A directory despite an equal final owner/token pair', async t => {
  const f = fixture(); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('A', 'token-A')); f.timers();
  f.emit('TOKEN_REFRESHED', session('A', 'token-B')); f.timers();
  f.emit('TOKEN_REFRESHED', session('A', 'token-A')); f.timers();
  await f.respondHttp(0, listing()); assert.equal(f.nodes('article').length, 0); assert.equal(f.panels().length, 0);
  await f.respondHttp(1, listing()); assert.equal(f.nodes('article').length, 0);
  await f.respondHttp(2, listing([{ id: PB, name: 'Fresh project' }], [space(CB, PB, 'Beta space')]));
  assert.ok(!f.text().includes('Private Alpha project')); f.clickSpace(CB); assert.equal(f.panels()[0].props.developmentContextId, CB);
});

test('a refreshed directory removing selected context removes its Panel; a superseded late list cannot restore it', async t => {
  const f = await loaded(t); f.clickSpace(CA); await f.respondRpc(0, imprint());
  f.click('刷新上下文'); await f.settle(); f.click('刷新上下文');
  assert.equal(f.http.length, 3); assert.equal(f.http[1].options.signal.aborted, true);
  await f.respondHttp(2, listing([{ id: PB, name: 'Private Beta project' }], [space(CB, PB, 'Beta space')]));
  assert.equal(f.panels().length, 0); assert.ok(!f.text().includes('ALPHA BODY'));
  await f.respondHttp(1, listing()); assert.equal(f.panels().length, 0); assert.ok(!f.text().includes('Alpha space'));
});

test('logout clears the actual directory and Panel before SDK sign-out resolves', async t => {
  const f = await loaded(t); f.clickSpace(CA); await f.respondRpc(0, imprint()); f.click('退出');
  assert.equal(f.panels().length, 0); assert.ok(!f.text().includes('Private Alpha project')); assert.ok(!f.text().includes('ALPHA BODY'));
  assert.ok(!f.http.some(call => /mcp|grant/.test(call.url))); assert.ok(!f.rpc.some(call => /mutate|grant|organization_set/.test(call.name)));
});

test('Dev scope option is limited to current context and exact project in both real language renderings', async t => {
  const f = fixture({ standaloneLocale: 'en' }); t.after(() => f.unmount());
  const scope = f.nodes('select').find(node => node.props['aria-label'] === 'Search scope'); assert.ok(scope);
  assert.equal(scope.props.value, 'all'); assert.deepEqual(f.nodes('option', scope).map(node => node.props.value), ['all', 'project:' + PA]);
  assert.equal(f.text(f.nodes('option', scope)[0]), 'Current development context');
  assert.equal(f.rpc[0].args.p_input.scope, 'all'); assert.equal(f.rpc[0].name, 'clued_development_imprint_read_v1');
});
