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
// Without default_choice (a server before migration 20261004130000) the page opens on grant.
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

// Re-review 9: a note the admission check wrote is labelled as such and links
// the compare view; the same words from an Agent stay the Agent's.
test('a note written by the admission check is shown as the check\'s, with its compare link', async t => {
  const link = `https://github.com/o/n/compare/${'b'.repeat(40)}...${'a'.repeat(40)}`;
  for (const [source, label] of [['ci-admission', '准入检查说明'], ['agent', 'Agent 说明']]) {
    const f = fixture(CONFIRM); t.after(() => f.unmount());
    await open(f);
    const answer = issued();
    answer.data.confirmation_view.resources = [`repo:o/n/${'a'.repeat(40)}`];
    answer.data.confirmation_view.request = { request_id: REQUEST, status: 'pending', note_source: source,
      agent_note_unverified: `o/n#559 @ aaaaaaaaaaaa: ${link} changes .github/workflows/x.yml` };
    f.calls[1].resolve(answer); await f.settle();
    const note = f.nodes('section').find(n => n.props['aria-label'] === label);
    assert.ok(note, source);
    const anchors = f.nodes('a').filter(n => n.props.href === link);
    assert.equal(anchors.length, source === 'ci-admission' ? 1 : 0, source);
    if (source === 'agent') assert.ok(f.text(note).includes('Agent 说明（未核实）'));
  }
  // Re-review 10: a link that does not end at the granted commit is hidden.
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await open(f);
  const answer = issued();
  answer.data.confirmation_view.resources = [`repo:o/n/${'c'.repeat(40)}`];
  answer.data.confirmation_view.request = { request_id: REQUEST, status: 'pending', note_source: 'ci-admission',
    agent_note_unverified: `o/n#559 @ aaaaaaaaaaaa: 1 protected path(s) changed, see ${link} (x)` };
  f.calls[1].resolve(answer); await f.settle();
  assert.equal(f.nodes('a').filter(n => n.props.href === link).length, 0);
  assert.ok(f.text().includes('说明里的链接与要批准的提交不一致'));
});

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

test('a connection permission request: names each permission and the connection, approves once, no reconnect', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  const P = 'project:44444444-4444-4444-8444-444444444444';
  f.calls[0].resolve({ data: { status: 'ok', default_choice: 'once', suggested_expires_seconds: 14400,
    request: { ...request(), action: 'connection.permission', resources: ['permission:' + P + '/write'] },
    view: { action: 'connection.permission', choice: 'once', expires_seconds: 86400, max_uses: 1 } }, error: null });
  await f.settle();
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'once', grantee: 'requester' });
  assert.equal(f.nodes('section').some(n => n.props['aria-label'] === '选择'), false, 'no grant-for-a-while or any-Agent choice');
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_ogr_p', view_digest: 'e'.repeat(64),
    expires_at: '2099-01-01T00:05:00Z', confirmation_view: { action: 'connection.permission', action_title: '给发起请求的连接加权限',
      resources: ['permission:' + P + '/write'], grantee: { any_agent: false, agent_name: 'ChatGPT', vendor: 'OAuth' },
      choice: 'once', expires_seconds: 86400, max_uses: 1,
      connection: { binding_id: 'b-1', client_name: 'ChatGPT', expires_at: '2099-02-01T00:00:00Z',
        current: [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }] },
      permissions: [{ resource: 'permission:' + P + '/write', context: P, context_name: 'M2', action: 'write' }],
      request: { request_id: REQUEST, status: 'pending', agent_note_unverified: null } } }, error: null });
  await f.settle();
  const what = f.text(f.nodes('section').find(n => n.props['aria-label'] === '要批准什么'));
  assert.ok(what.includes('ChatGPT'));
  assert.ok(what.includes('M2 → 正式记忆 → 新增和修改'));
  assert.ok(what.includes('个人记忆：读取'));
  assert.ok(what.includes('不用重新连接'));
  f.button('批准').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]),
    ['clued_owner_grant_v1', { p_input: { confirmation_token: 'clued_ogr_p', view_digest: 'e'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', grant: { grant_id: 'g-p', expires_at: '2099-01-02T00:00:00Z', max_uses: 1 } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('权限已加到这个连接上'));
  assert.ok(f.nodes('a').some(n => n.props.href === '/oauth/connections'));
});

test('a bundle: every pending member is listed side by side, ticked; 批准 confirms each over its own view (PermissionSimplification §3.3)', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  const MEMBER = '44444444-4444-4444-8444-444444444444';
  const DONE = '55555555-5555-4555-8555-555555555555';
  const commit = 'repo:o/n/' + 'a'.repeat(40);
  const file = commit + '/apps/clued-cloud/supabase/migrations/20261004200000_x.sql';
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', default_choice: 'once', suggested_expires_seconds: 14400,
    resource_options: [{ resource: file, options: [file, commit + '/**'] }],
    request: { ...request(), action: 'migration.production', resources: [file], bundle: [
      { request_id: REQUEST, action: 'migration.production', resources: [file], status: 'pending' },
      { request_id: MEMBER, action: 'release.production', resources: [commit], status: 'pending' },
      { request_id: DONE, action: 'release.production', resources: ['repo:o/n/old'], status: 'approved_once' }] },
    view: { action: 'migration.production', choice: 'once', expires_seconds: 86400, max_uses: 1 } }, error: null });
  await f.settle();
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'once', grantee: 'requester' });
  const view = (action, title, resources, token, digest) => ({ data: { status: 'issued', confirmation_token: token,
    view_digest: digest, expires_at: '2099-01-01T00:05:00Z', confirmation_view: { action, action_title: title, resources,
      grantee: { any_agent: false, agent_name: 'Claude Code' }, choice: 'once', expires_seconds: 86400, max_uses: 1 } }, error: null });
  f.calls[1].resolve(view('migration.production', '经发布 workflow 应用迁移到生产库', [file], 'clued_ogr_m', 'm'.repeat(64)));
  await f.settle();
  // The other pending member gets its own token with the same choice; a decided one is left alone.
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args.p_input]),
    ['clued_owner_grant_confirmation_issue_v1', { request_id: MEMBER, choice: 'once', grantee: 'requester' }]);
  assert.equal(f.calls.length, 3);
  f.calls[2].resolve(view('release.production', '运行生产发布（deploy 模式）', [commit], 'clued_ogr_r', 'r'.repeat(64)));
  await f.settle();
  const what = f.text(f.nodes('section').find(n => n.props['aria-label'] === '要批准什么'));
  assert.ok(what.includes('经发布 workflow 应用迁移到生产库'));
  assert.ok(what.includes('同一批共 2 项，勾上的才会批准'));
  assert.ok(what.includes('运行生产发布（deploy 模式）'));
  assert.ok(what.includes(commit));
  assert.equal(f.nodes('fieldset').filter(n => n.props.className === 'owner-scope').length, 0, 'no scope rows for a bundle');
  // Both members are equal rows with a ticked checkbox; the shared terms are shown once.
  const boxes = f.nodes('input').filter(n => n.props.type === 'checkbox' && n.props['data-id']);
  assert.deepEqual(boxes.map(n => [n.props['data-id'], n.props.checked]), [[REQUEST, true], [MEMBER, true]]);
  assert.equal(what.split('只这一次，24 小时内用掉').length, 2);
  f.button('批准').props.onClick();
  assert.deepEqual(plain([f.calls[3].name, f.calls[3].args.p_input]),
    ['clued_owner_grant_v1', { confirmation_token: 'clued_ogr_m', view_digest: 'm'.repeat(64) }]);
  f.calls[3].resolve({ data: { status: 'committed', grant: { grant_id: 'g-m', expires_at: '2099-01-02T00:00:00Z', max_uses: 1 } }, error: null });
  await f.settle();
  assert.deepEqual(plain([f.calls[4].name, f.calls[4].args.p_input]),
    ['clued_owner_grant_v1', { confirmation_token: 'clued_ogr_r', view_digest: 'r'.repeat(64) }]);
  f.calls[4].resolve({ data: { status: 'committed', grant: { grant_id: 'g-r', expires_at: '2099-01-02T00:00:00Z', max_uses: 1 } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('同一批 2 项已批准'));
  assert.ok(!f.text().includes('仍等你确认'));
});

test('a bundle: an unticked member stays pending; deploy without its migration is flagged (Decision 383c2144)', async t => {
  const MEMBER = '44444444-4444-4444-8444-444444444444';
  const commit = 'repo:o/n/' + 'a'.repeat(40);
  const file = commit + '/apps/clued-cloud/supabase/migrations/20261004200000_x.sql';
  const view = (action, title, resources, token) => ({ data: { status: 'issued', confirmation_token: token,
    view_digest: token.slice(-1).repeat(64), expires_at: '2099-01-01T00:05:00Z', confirmation_view: { action, action_title: title,
      resources, grantee: { any_agent: false, agent_name: 'Claude Code' }, choice: 'once', expires_seconds: 86400, max_uses: 1 } }, error: null });
  const start = async f => {
    f.emit('INITIAL_SESSION', session('owner'));
    f.calls[0].resolve({ data: { status: 'ok', default_choice: 'once', request: { ...request(), action: 'migration.production',
      resources: [file], bundle: [{ request_id: REQUEST, action: 'migration.production', status: 'pending' },
        { request_id: MEMBER, action: 'release.production', status: 'pending' }] }, view: { action: 'migration.production' } }, error: null });
    await f.settle();
    f.calls[1].resolve(view('migration.production', '经发布 workflow 应用迁移到生产库', [file], 'clued_ogr_m')); await f.settle();
    f.calls[2].resolve(view('release.production', '运行生产发布（deploy 模式）', [commit], 'clued_ogr_r')); await f.settle();
  };
  const box = (f, id) => f.nodes('input').find(n => n.props['data-id'] === id);
  const untick = (f, id) => { box(f, id).props.onChange({ currentTarget: { dataset: { id }, checked: false } }); f.render(); };
  const warning = '部署通常依赖同批迁移，只批部署可能出错';

  // Only the migration: the deploy is left pending and linked; no warning.
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await start(f);
  assert.ok(!f.text().includes(warning));
  untick(f, MEMBER);
  assert.equal(box(f, MEMBER).props.checked, false);
  assert.ok(f.text().includes('没勾的项保持待确认'));
  assert.ok(!f.text().includes(warning));
  f.button('批准').props.onClick();
  assert.deepEqual(plain(f.calls[3].args.p_input), { confirmation_token: 'clued_ogr_m', view_digest: 'm'.repeat(64) });
  f.calls[3].resolve({ data: { status: 'committed', grant: { grant_id: 'g-m', expires_at: '2099-01-02T00:00:00Z', max_uses: 1 } }, error: null });
  await f.settle();
  assert.equal(f.calls.length, 4, 'the unticked member is not approved');
  assert.ok(f.text().includes('同一批还有 1 项没勾，仍等你确认'));
  assert.ok(f.nodes('a').some(n => n.props.href === '/confirm/' + MEMBER && f.text(n) === '运行生产发布（deploy 模式）（release.production）'));

  // Only the deploy: warned, not blocked; the request on the page stays pending.
  const g = fixture(CONFIRM); t.after(() => g.unmount());
  await start(g);
  untick(g, REQUEST);
  assert.ok(g.text().includes(warning));
  assert.equal(g.button('批准').props.disabled, false);
  g.button('批准').props.onClick();
  assert.deepEqual(plain(g.calls[3].args.p_input), { confirmation_token: 'clued_ogr_r', view_digest: 'r'.repeat(64) });
  g.calls[3].resolve({ data: { status: 'committed', grant: { grant_id: 'g-r', expires_at: '2099-01-02T00:00:00Z', max_uses: 1 } }, error: null });
  await g.settle();
  assert.equal(g.calls.length, 4);
  assert.ok(g.text().includes('已批准'));
  assert.ok(g.nodes('a').some(n => n.props.href === '/confirm/' + REQUEST));

  // Nothing ticked: 批准 is disabled.
  const h = fixture(CONFIRM); t.after(() => h.unmount());
  await start(h);
  untick(h, REQUEST); untick(h, MEMBER);
  assert.equal(h.button('批准').props.disabled, true);
});

test('a bundle: a member that fails says which were approved; 拒绝 rejects every pending member', async t => {
  const MEMBER = '44444444-4444-4444-8444-444444444444';
  const bundle = [{ request_id: REQUEST, action: 'migration.production', status: 'pending' },
    { request_id: MEMBER, action: 'release.production', status: 'pending' }];
  const start = async f => {
    f.emit('INITIAL_SESSION', session('owner'));
    f.calls[0].resolve({ data: { status: 'ok', default_choice: 'once', request: { ...request(), bundle },
      view: { action: 'migration.production' } }, error: null });
    await f.settle();
    f.calls[1].resolve(issued({ token: 'clued_ogr_m', choice: 'once' })); await f.settle();
    f.calls[2].resolve(issued({ token: 'clued_ogr_r', digest: 'r'.repeat(64), choice: 'once' })); await f.settle();
  };
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  await start(f);
  f.button('批准').props.onClick();
  f.calls[3].resolve(committed); await f.settle();
  f.calls[4].resolve({ data: null, error: { message: 'owner_request_decided', code: '55000' } }); await f.settle();
  const alert = f.nodes('p').find(n => n.props.role === 'alert');
  assert.match(f.text(alert), /前 1 项已批准，第 2 项未完成：这个请求已经处理过了。/);
  const g = fixture(CONFIRM); t.after(() => g.unmount());
  await start(g);
  g.button('拒绝').props.onClick();
  assert.deepEqual(plain([g.calls[3].name, g.calls[3].args.p_input]), ['clued_owner_request_reject_v1', { request_id: REQUEST }]);
  g.calls[3].resolve({ data: { status: 'ok' }, error: null }); await g.settle();
  assert.deepEqual(plain([g.calls[4].name, g.calls[4].args.p_input]), ['clued_owner_request_reject_v1', { request_id: MEMBER }]);
  g.calls[4].resolve({ data: { status: 'ok' }, error: null }); await g.settle();
  assert.ok(g.text().includes('已拒绝'));
});

test('a decided bundle member links to the members still pending', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  const MEMBER = '44444444-4444-4444-8444-444444444444';
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', request: { ...request('approved_once'), bundle: [
    { request_id: REQUEST, action: 'migration.production', status: 'approved_once' },
    { request_id: MEMBER, action: 'release.production', status: 'pending' }] }, view: {} }, error: null });
  await f.settle();
  assert.equal(f.calls.length, 1, 'no token for a decided request');
  assert.ok(f.text().includes('同一批还有 1 项等你确认'));
  assert.ok(f.nodes('a').some(n => n.props.href === '/confirm/' + MEMBER));
});

test('Clued sets the default choice by risk: a high-risk action opens on 只批这一次', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', request: request(), default_choice: 'once', suggested_expires_seconds: 86400,
    view: { action: 'release.production', choice: 'once', expires_seconds: 86400, max_uses: 1 } }, error: null });
  await f.settle();
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'once', grantee: 'requester' });
  assert.equal(f.button('只批这一次').props['aria-pressed'], true);
  assert.equal(f.nodes('select').length, 0, 'no duration for once');
  f.calls[1].resolve(issued({ choice: 'once' })); await f.settle();
  assert.ok(f.text().includes('只这一次，24 小时内用掉'));
  // Switching to grant uses the Agent's suggested duration, not the once view's 24 hours by accident.
  f.button('这一类管一段时间').props.onClick();
  assert.deepEqual(plain(f.calls[2].args.p_input), { request_id: REQUEST, choice: 'grant', expires_seconds: 86400, grantee: 'requester' });
});

test('a routine action opens on 这一类管一段时间 with the suggested duration', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', request: request(), default_choice: 'grant', suggested_expires_seconds: 3600,
    view: { action: 'work_claim.extra_claims', choice: 'grant', expires_seconds: 3600 } }, error: null });
  await f.settle();
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'grant', expires_seconds: 3600, grantee: 'requester' });
  assert.equal(f.button('这一类管一段时间').props['aria-pressed'], true);
});

test('DatasetSplit bootstrap uses only the fixed one-hour, one-use requester grant despite the high-risk once default', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', default_choice: 'once', suggested_expires_seconds: 86400,
    request: { ...request(), action: 'model.dataset_split.bootstrap' },
    view: { action: 'model.dataset_split.bootstrap', choice: 'once', expires_seconds: 86400, max_uses: 1 },
    resource_options: [{ resource: 'repo:o/n/**', options: ['repo:o/n/**', 'repo:o/**'] }] }, error: null });
  await f.settle();
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'grant',
    expires_seconds: 3600, max_uses: 1, grantee: 'requester' });
  const answer = issued({ seconds: 3600 });
  answer.data.confirmation_view.action = 'model.dataset_split.bootstrap';
  answer.data.confirmation_view.max_uses = 1;
  f.calls[1].resolve(answer); await f.settle();
  assert.equal(f.nodes('select').length, 0);
  assert.equal(f.nodes('input').filter(n => n.props.type === 'checkbox').length, 0);
  assert.ok(!f.nodes('button').some(n => f.text(n) === '只批这一次'));
  assert.match(f.text(), /1 小时内使用 1 次/);
  f.button('批准').props.onClick();
  assert.deepEqual(plain(f.calls[2].args.p_input), { confirmation_token: 'clued_ogr_a', view_digest: 'd'.repeat(64) });
});

test('DatasetSplit bootstrap cannot approve an incompatible server confirmation view', async t => {
  for (const change of [v => { v.choice = 'once'; }, v => { v.expires_seconds = 86400; },
    v => { v.max_uses = null; }, v => { v.grantee.any_agent = true; }]) {
    const f = fixture(CONFIRM); t.after(() => f.unmount());
    f.emit('INITIAL_SESSION', session('owner'));
    f.calls[0].resolve({ data: { status: 'ok', request: { ...request(), action: 'model.dataset_split.bootstrap' },
      view: { action: 'model.dataset_split.bootstrap', expires_seconds: 3600 } }, error: null });
    await f.settle();
    const answer = issued({ seconds: 3600 });
    answer.data.confirmation_view.action = 'model.dataset_split.bootstrap';
    answer.data.confirmation_view.max_uses = 1;
    change(answer.data.confirmation_view);
    f.calls[1].resolve(answer); await f.settle();
    assert.equal(f.button('批准').props.disabled, true);
    assert.match(f.text(), /暂时无法批准/);
    assert.equal(f.calls.length, 2);
  }
});

const CORRECTION_REQUEST = 'af1cabdb-5259-4ca3-94d3-133f1af122c8';
const CORRECTION_GRANT = '4970e492-d26e-4974-adaa-757b2146b171';
async function openCorrection(f, grantChange = {}) {
  f.emit('INITIAL_SESSION',session('owner'));
  f.calls[0].resolve({data:{status:'ok',request:{...request('approved_once'),request_id:CORRECTION_REQUEST,
    action:'model.dataset_split.bootstrap',grant:{grant_id:CORRECTION_GRANT,uses:0,max_uses:1,revoked:false,
      expires_at:new Date(Date.now()+86400_000).toISOString(),...grantChange}},
    view:{action:'model.dataset_split.bootstrap',expires_seconds:86400}},error:null});
  await f.settle();
}
function correctionIssue(options = {}) {
  const result = issued({seconds:3600,...options});
  result.data.confirmation_view.action='model.dataset_split.bootstrap';
  result.data.confirmation_view.max_uses=1;
  result.data.confirmation_view.correction={request_id:CORRECTION_REQUEST,previous_grant_id:CORRECTION_GRANT,
    previous_expires_at:'2099-01-01T00:00:00Z'};
  return result;
}
test('the original decided request offers a Native correction view and never mutates a grant before explicit confirmation',async t=>{
  const f=fixture(CONFIRM,{id:CORRECTION_REQUEST});t.after(()=>f.unmount());await openCorrection(f);
  assert.equal(f.calls.length,1,'loading a decided request never issues or commits a token');
  assert.match(f.text(),/原批准已保留/);
  f.button('查看限时修正').props.onClick();
  assert.deepEqual(plain([f.calls[1].name,f.calls[1].args.p_input]),
    ['clued_dataset_split_grant_correction_issue_v1',{request_id:CORRECTION_REQUEST}]);
  f.calls[1].resolve(correctionIssue());await f.settle();
  assert.equal(f.calls.length,2);assert.match(f.text(),/确认收窄授权期限/);
  assert.match(f.text(),/不超过原期限/);assert.ok(f.text().includes(CORRECTION_GRANT));
  assert.equal(f.nodes('select').length,0);
  f.button('确认限时修正').props.onClick();
  assert.deepEqual(plain([f.calls[2].name,f.calls[2].args.p_input]),
    ['clued_owner_grant_v1',{confirmation_token:'clued_ogr_a',view_digest:'d'.repeat(64)}]);
  f.calls[2].resolve(committed);await f.settle();
  assert.match(f.text(),/授权期限已修正/);assert.match(f.text(),/旧授权已撤销，原申请和批准历史保留/);
});
test('spent, revoked or wrong original grants offer no correction; cancel changes no authorization',async t=>{
  for(const change of [{uses:1},{revoked:true},{grant_id:'another-grant'}]){
    const f=fixture(CONFIRM,{id:CORRECTION_REQUEST});t.after(()=>f.unmount());await openCorrection(f,change);
    assert.ok(!f.nodes('button').some(n=>f.text(n)==='查看限时修正'));assert.equal(f.calls.length,1);
  }
  const f=fixture(CONFIRM,{id:CORRECTION_REQUEST});t.after(()=>f.unmount());await openCorrection(f);
  f.button('查看限时修正').props.onClick();f.calls[1].resolve(correctionIssue());await f.settle();
  f.button('返回原批准').props.onClick();f.render();assert.equal(f.calls.length,2);
  assert.ok(!f.nodes('button').some(n=>f.text(n)==='确认限时修正'));
});
test('an expiring correction token refreshes through the same correction door, and unknown completion uses the original token',async t=>{
  const f=fixture(CONFIRM,{id:CORRECTION_REQUEST});t.after(()=>f.unmount());await openCorrection(f);
  f.button('查看限时修正').props.onClick();
  f.calls[1].resolve(correctionIssue({expires:new Date(Date.now()+5000).toISOString()}));await f.settle();
  f.button('确认限时修正').props.onClick();
  assert.equal(f.calls[2].name,'clued_dataset_split_grant_correction_issue_v1');
  f.calls[2].resolve(correctionIssue({token:'clued_ogr_fresh'}));await f.settle();
  assert.equal(f.calls[3].name,'clued_owner_grant_v1');
  f.calls[3].reject(new TypeError('network'));await f.settle();
  f.button('核对原操作').props.onClick();
  assert.deepEqual(plain(f.calls[4].args),plain(f.calls[3].args));
  f.calls[4].resolve({data:{...committed.data,replayed:true},error:null});await f.settle();
  assert.match(f.text(),/授权期限已修正/);
});
test('a correction view naming another original cannot be submitted',async t=>{
  const f=fixture(CONFIRM,{id:CORRECTION_REQUEST});t.after(()=>f.unmount());await openCorrection(f);
  f.button('查看限时修正').props.onClick();const answer=correctionIssue();
  answer.data.confirmation_view.correction.previous_grant_id='other-grant';
  f.calls[1].resolve(answer);await f.settle();assert.equal(f.calls.length,2);
  assert.ok(!f.nodes('button').some(n=>f.text(n)==='确认限时修正'));assert.match(f.text(),/与原申请不一致/);
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

test('scope rows: unticking narrows, a parent option widens, "once" keeps the request (Decision c4e82dee)', async t => {
  const f = fixture(CONFIRM); t.after(() => f.unmount());
  const commit = 'repo:o/n/abc1234';
  const record = 'record:2a31ca2a-0ece-476d-af7f-d4ee6dc4d1e0';
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', request: { ...request(), resources: [commit, record] },
    view: { action: 'release.production', expires_seconds: 14400 },
    resource_options: [{ resource: commit, options: [commit, 'repo:o/n/**'] }, { resource: record, options: [record] }] },
  error: null });
  await f.settle();
  // Unchanged scope: the request's resources are kept and none are sent.
  assert.deepEqual(plain(f.calls[1].args.p_input), { request_id: REQUEST, choice: 'grant', expires_seconds: 14400, grantee: 'requester' });
  f.calls[1].resolve(issued()); await f.settle();
  const scope = () => f.nodes('fieldset')[0];
  assert.ok(f.text(scope()).includes('取消勾选即收窄'));
  const select = f.nodes('select', scope())[0];
  assert.deepEqual(f.nodes('option', select).map(n => n.props.value), [commit, 'repo:o/n/**']);
  assert.ok(f.text(select).includes('（请求的范围）'));
  // Widen the commit to its repository.
  select.props.onChange({ currentTarget: { type: 'select-one', value: 'repo:o/n/**', dataset: { index: String(select.props['data-index']) } } });
  f.render();
  assert.deepEqual(plain(f.calls[2].args.p_input), { request_id: REQUEST, choice: 'grant', expires_seconds: 14400,
    grantee: 'requester', resources: ['repo:o/n/**', record] });
  f.calls[2].resolve(issued({ token: 'clued_ogr_w', digest: 'w'.repeat(64) })); await f.settle();
  // Untick the record: only the widened repository is left, and it cannot be unticked.
  const boxes = () => f.nodes('input', scope()).filter(n => n.props.type === 'checkbox');
  boxes()[1].props.onChange({ currentTarget: { type: 'checkbox', checked: false, dataset: { index: '1' } } });
  f.render();
  assert.deepEqual(plain(f.calls[3].args.p_input.resources), ['repo:o/n/**']);
  f.calls[3].resolve(issued({ token: 'clued_ogr_n', digest: 'n'.repeat(64) })); await f.settle();
  assert.equal(boxes()[0].props.disabled, true, 'the last kept row cannot be unticked');
  assert.equal(f.nodes('select', scope())[0].props.disabled, false);
  // "Approve once" never sends a scope and shows no rows.
  f.button('只批这一次').props.onClick();
  assert.deepEqual(plain(f.calls[4].args.p_input), { request_id: REQUEST, choice: 'once', grantee: 'requester' });
  f.calls[4].resolve(issued({ token: 'clued_ogr_o', digest: 'o'.repeat(64), choice: 'once' })); await f.settle();
  assert.equal(f.nodes('fieldset').length, 0);
  // Back to "grant": the chosen scope is still what is sent.
  f.button('这一类管一段时间').props.onClick();
  assert.deepEqual(plain(f.calls[5].args.p_input.resources), ['repo:o/n/**']);
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

test('grants page shows the ids Agents quote: grant, request and Task', async t => {
  const f = fixture(GRANTS); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok',
    grants: [{ grant_id: 'a0e3b847-b0ef-4816-b1c3-863cb770af98', request_id: 'f6b2000e-c180-402b-a3e9-e2c1fc878da1',
      task_id: 'e86eb58d-afa0-4268-98c2-e21ab754d545', task_title: '连接权限申请',
      action: 'migration.production', action_title: '经发布 workflow 应用迁移到生产库', resources: ['repo:o/n/f04d5f50'],
      any_agent: false, agent_name: 'Claude', expires_at: '2099-01-01T00:00:00Z', max_uses: 1, uses: 0 },
    { grant_id: 'c1d2e3f4-0000-4000-8000-000000000000', request_id: null, task_id: null,
      action: 'release.production', action_title: '运行生产发布（deploy 模式）', resources: ['repo:o/n/**'],
      any_agent: true, expires_at: '2099-01-01T00:00:00Z', max_uses: null, uses: 0 }],
    pending_requests: [request()] }, error: null });
  await f.settle();
  const text = f.text();
  assert.ok(text.includes('授权 a0e3b847'));
  assert.ok(text.includes('申请 f6b2000e'));
  assert.ok(text.includes('连接权限申请 e86eb58d'));
  assert.ok(text.includes('授权 c1d2e3f4'), 'a grant the Owner started has no request id');
  assert.ok(text.includes('申请 33333333'), 'a pending request shows its id');
});

// OwnerCredential §12 (Decision 5ce219c6): the auto-approval switch.
const autoOff = { on: false, covers: ['release.production'],
  excluded: [{ action: 'connection.permission', title: '给发起请求的连接加权限' }] };
const autoView = { kind: 'owner_auto_approve', expires_seconds: 86400,
  covers: [{ action: 'release.production', title: '运行生产发布（deploy 模式）', risk: 'high', approval: 'once' },
    { action: 'work_claim.extra_claims', title: '某个 Task 超出每日认领上限后再认领', risk: 'routine', approval: 'grant' }],
  excluded: [{ action: 'connection.permission', title: '给发起请求的连接加权限' }] };

test('grants page turns auto-approval on in two steps over the view Clued renders', async t => {
  const f = fixture(GRANTS); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', auto_approve: autoOff, grants: [], pending_requests: [] }, error: null });
  await f.settle();
  assert.ok(f.text().includes('自动审批'));
  assert.ok(f.text().includes('已关闭'));
  f.button('打开自动审批').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]),
    ['clued_owner_auto_approve_confirmation_issue_v1', { p_input: { expires_seconds: 86400 } }], 'default 24 hours');
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'tok-1', view_digest: 'd'.repeat(64),
    confirmation_view: autoView }, error: null });
  await f.settle();
  const text = f.text();
  assert.ok(text.includes('打开 24 小时'));
  assert.ok(text.includes('运行生产发布（deploy 模式）（release.production）：只批这一次'));
  assert.ok(text.includes('work_claim.extra_claims）：按 Agent 建议的时长和次数'));
  assert.ok(text.includes('仍需你确认：给发起请求的连接加权限'));
  assert.equal(f.calls.length, 2, 'nothing is turned on before 确认打开');
  f.button('确认打开').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]),
    ['clued_owner_auto_approve_on_v1', { p_input: { confirmation_token: 'tok-1', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', auto_approve: { ...autoOff, on: true,
    expires_at: new Date(Date.now() + 5 * 3600_000 + 30_000).toISOString() } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('自动审批已打开'));
  assert.ok(f.text().includes('已打开，还剩 5 小时'));
  assert.ok(f.text().includes('不会自动通过：给发起请求的连接加权限'));
  assert.equal(f.fetches.length, 0);
});

test('grants page: 取消 drops the offered view; a chosen duration is sent; 关闭 is one step', async t => {
  const f = fixture(GRANTS); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', auto_approve: autoOff, grants: [], pending_requests: [] }, error: null });
  await f.settle();
  f.nodes('select')[0].props.onChange({ target: { value: '604800' } }); f.render();
  f.button('打开自动审批').props.onClick();
  assert.deepEqual(plain(f.calls[1].args), { p_input: { expires_seconds: 604800 } });
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'tok-2', view_digest: 'e'.repeat(64),
    confirmation_view: { ...autoView, expires_seconds: 604800 } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('打开 7 天'));
  f.button('取消').props.onClick(); f.render();
  assert.ok(f.text().includes('已关闭'));
  assert.equal(f.calls.length, 2);

  const g = fixture(GRANTS); t.after(() => g.unmount());
  g.emit('INITIAL_SESSION', session('owner'));
  g.calls[0].resolve({ data: { status: 'ok', auto_approve: { ...autoOff, on: true, expires_at: '2099-01-01T00:00:00Z' },
    grants: [{ grant_id: 'a0e3b847-b0ef-4816-b1c3-863cb770af98', action: 'release.production', action_title: '运行生产发布（deploy 模式）',
      resources: ['repo:o/n/abc'], any_agent: false, agent_name: 'Claude', expires_at: '2099-01-01T00:00:00Z',
      max_uses: 1, uses: 0, auto_approved: true }], pending_requests: [] }, error: null });
  await g.settle();
  assert.ok(g.text().includes('来源自动审批'), 'a grant the switch gave says so');
  g.button('关闭自动审批').props.onClick();
  assert.deepEqual(plain([g.calls[1].name, g.calls[1].args]), ['clued_owner_auto_approve_off_v1', { p_input: {} }]);
  g.calls[1].resolve({ data: { status: 'committed', auto_approve: autoOff }, error: null });
  await g.settle();
  assert.ok(g.text().includes('自动审批已关闭'));
  assert.ok(g.text().includes('授权 a0e3b847'), 'grants already given stay listed');
});

test('grants page: a server without the switch shows no switch section', async t => {
  const f = fixture(GRANTS); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', grants: [], pending_requests: [] }, error: null });
  await f.settle();
  assert.ok(!f.text().includes('自动审批'));
});
