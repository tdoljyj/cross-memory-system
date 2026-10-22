// Execute the actual Owner detail page with controlled auth, routing and RPC
// ordering. No browser, database writes or live API calls.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/tasks/page.tsx');
const WORK_CLAIMS = compile('../app/work-claims/page.tsx');
const TASK = '11111111-1111-4111-8111-111111111111';
const NOTE = '33333333-3333-4333-8333-333333333333';
const DECISION = '44444444-4444-4444-8444-444444444444';
const CLAIM = '22222222-2222-4222-8222-222222222222';
const ENDED = '55555555-5555-4555-8555-555555555555';
const SCOPE = 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f';
const SECRET = 'clued_lk_' + 'a'.repeat(64);
const plain = value => JSON.parse(JSON.stringify(value));
const session = (owner, token = 'fixture-' + owner) => ({ user: { id: owner, email: owner + '@example.test' }, access_token: token });
const record = (extra = {}) => ({ id: TASK, record_type: 'task', title: 'Owner task', content: 'First line\n<script>do not execute</script>',
  scope: SCOPE, lifecycle_status: 'active', execution_bucket: 'now', closure_summary: null, version: 8,
  updated_at: '2026-10-05T19:15:10Z', currentness: 'CURRENT', ...extra });
const row = (extra = {}) => ({ claim_id: CLAIM, task_id: TASK, task_title: 'Owner task', context_key: SCOPE,
  status: 'ACTIVE', state: 'ACTIVE', fence: 7, lease_version: 2, expires_at: '2026-10-06T19:15:10Z',
  issued_at: '2026-10-05T19:15:10Z', hard_deadline_at: '2026-10-07T19:15:10Z', renewals: 1, max_renewals: 12,
  progress_ref: 'pr:573', write_set: ['apps/clued-cloud/app/tasks/**'], holder_client: 'Codex',
  holder_session_title: 'Task detail', holder_session_ref: '0199a1b2-c3d4', holder_session_url: null,
  holder_name: 'Codex desktop', holder_vendor: 'openai', holder_connection_live: true, holder_label: '详情页 · 台式机',
  bound_pr: 'tdoljyj/cross-memory-system#573', handover_available: true, lease_key: SECRET, lease_key_hash: 'private-hash', ...extra });
const detail = (extra = {}) => ({ status: 'ok', record: record(), related: [
  { id: NOTE, record_type: 'note', title: 'Handover note', scope: SCOPE, currentness: 'CURRENT' },
  { id: DECISION, record_type: 'decision', title: 'Owner requirement', scope: SCOPE, currentness: 'HISTORY' },
], claims: [row()], ended: [row({ claim_id: ENDED, state: 'RELEASED', status: 'RELEASED', released_outcome: 'completed',
  ended_at: '2026-10-05T18:59:00Z', handover_available: false })], ...extra });

function fixture(compiled = PAGE, initialId = TASK) {
  const hooks = [], effects = [], calls = [];
  let cursor = 0, authCallback, root, routeId = initialId, signouts = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useCallback(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) hooks[i] = { value: callback, deps }; return hooks[i].value; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  React.useLayoutEffect = React.useEffect;
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; },
    async signOut() { signouts++; return { error: null }; } };
  const supabase = { auth, rpc(name, args) {
    // The independently loaded workflow has separate dedicated tests. Keep
    // this legacy detail fixture focused on its canonical RPC/race ordering.
    if (name === 'clued_task_goal_delivery_owner_v1') return Promise.resolve({ data: {
      status: 'ok', task_id: args.p_input.id, record_version: 8, task_workflow: null, delivery_candidates: [],
    }, error: null });
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); calls.push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    if (name === 'next/navigation') return { useSearchParams: () => ({ get: name => name === 'id' ? routeId : null }) };
    throw Error(name);
  }, Error, Date, Number, String, Array, JSON, Intl });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(root); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); }
  function emit(event, next) { authCallback(event, next); render(); }
  function button(label) { const node = nodes('button').find(n => text(n) === label); assert.ok(node, label); return node; }
  render();
  return { calls, render, nodes, text, settle, emit, button, signouts: () => signouts,
    route(id) { routeId = id; render(); }, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}
async function loaded(f, value = detail()) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_task_owner_detail_v1', { p_input: { id: TASK } }]);
  f.calls[0].resolve({ data: value, error: null }); await f.settle();
}

test('task detail: signed out makes no RPC and offers the Owner sign-in', t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('登录 BeamingFace'));
  assert.equal(f.nodes('pre').length, 0);
});

for (const id of ['', '16e1539d', TASK + '/extra', 'javascript:alert(1)']) {
  test(`task detail: invalid ID ${JSON.stringify(id)} fails before RPC`, t => {
    const f = fixture(PAGE, id); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
    assert.equal(f.calls.length, 0); assert.ok(f.text().includes('完整的记录 ID'));
  });
}

test('task detail: full text and identity, Beijing time, related links and task-specific claims', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f);
  const page = f.text();
  for (const value of [TASK, SCOPE, 'Owner task', 'First line\n<script>do not execute</script>', '现在', '版本8',
    '2026/10/06 03:15（北京时间）', '当前（CURRENT）', 'Handover note', 'Owner requirement', '历史（HISTORY）',
    '任务进行中的认领（最多 100 条）', '最近 24 小时结束的认领（最多 100 条）', CLAIM, ENDED, 'Codex（Agent 自报）', '详情页 · 台式机（Agent 自报）',
    '有效', '已释放（完成） · 结束于 2026/10/06 02:59（北京时间）', 'apps/clued-cloud/app/tasks/**']) assert.ok(page.includes(value), value);
  const hrefs = f.nodes('a').map(n => n.props.href);
  assert.ok(hrefs.includes('/tasks?id=' + NOTE)); assert.ok(hrefs.includes('/tasks?id=' + DECISION));
  assert.ok(hrefs.includes('https://github.com/tdoljyj/cross-memory-system/pull/573'));
  assert.equal(f.nodes('script').length, 0);
  assert.equal(f.nodes('pre')[0].props.children, 'First line\n<script>do not execute</script>');
  assert.ok(!page.includes(SECRET)); assert.ok(!page.includes('private-hash'));
  assert.ok(!f.nodes('button').some(n => f.text(n).includes('交接')));
});

test('task detail: account switch immediately hides old content and discards its late result', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f);
  f.button('刷新').props.onClick(); f.render();
  assert.ok(!f.text().includes('First line'));
  f.emit('SIGNED_IN', session('new-owner'));
  assert.ok(!f.text().includes('Owner task'));
  f.calls[1].resolve({ data: detail({ record: record({ title: 'Old response' }) }), error: null }); await f.settle();
  assert.ok(!f.text().includes('Old response'));
  f.calls[2].resolve({ data: detail({ record: record({ title: 'New owner task' }) }), error: null }); await f.settle();
  assert.ok(f.text().includes('New owner task'));
});

test('task detail: same-owner replacement login invalidates the previous request', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner', 'old-token'));
  f.emit('SIGNED_IN', session('owner', 'new-token'));
  assert.equal(f.calls.length, 2);
  f.calls[0].resolve({ data: detail({ record: record({ title: 'Old login result' }) }), error: null }); await f.settle();
  assert.ok(!f.text().includes('Old login result'));
  f.calls[1].resolve({ data: detail(), error: null }); await f.settle();
  assert.ok(f.text().includes('Owner task'));
});

test('task detail: route changes hide the previous record before effects and ignore late responses', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f);
  f.button('刷新').props.onClick(); f.render();
  f.route(NOTE);
  assert.ok(!f.text().includes('Owner task'));
  assert.deepEqual(plain(f.calls[2].args), { p_input: { id: NOTE } });
  f.calls[2].resolve({ data: detail({ record: record({ id: NOTE, record_type: 'note', title: 'Note detail', content: 'Related note body',
    execution_bucket: null }), related: [], claims: [], ended: [] }), error: null }); await f.settle();
  f.calls[1].resolve({ data: detail(), error: null }); await f.settle();
  assert.ok(f.text().includes('笔记详情')); assert.ok(f.text().includes('Related note body'));
  assert.ok(!f.text().includes('Owner task')); assert.ok(!f.text().includes('任务进行中的认领'));
});

test('task detail: signed-out events clear content and invalidate pending reads', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f);
  f.button('刷新').props.onClick(); f.emit('SIGNED_OUT', null);
  f.calls[1].resolve({ data: detail(), error: null }); await f.settle();
  assert.ok(f.text().includes('登录 BeamingFace')); assert.ok(!f.text().includes('Owner task'));
});

test('task detail: the logout button clears data before signOut resolves', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f);
  f.button('退出登录').props.onClick(); f.render();
  assert.equal(f.signouts(), 1); assert.ok(f.text().includes('登录 BeamingFace')); assert.ok(!f.text().includes('Owner task'));
});

for (const [code, message] of [['direct_human_session_required', '需要你本人直接登录 BeamingFace'], ['record_not_found', '找不到这条记录，或当前账户无权查看']]) {
  test(`task detail: ${code} is an explicit refusal without old or empty-success content`, async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f);
    f.button('刷新').props.onClick();
    f.calls[1].resolve({ data: { status: 'rejected', error_code: code }, error: null }); await f.settle();
    assert.ok(f.text().includes(message)); assert.equal(f.nodes('pre').length, 0);
    assert.ok(!f.text().includes('目前没有进行中的认领'));
  });
}

test('task detail: transport refusal is also explained', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: null, error: { code: 'P0001', message: 'direct_human_session_required' } }); await f.settle();
  assert.ok(f.text().includes('需要你本人直接登录 BeamingFace')); assert.equal(f.nodes('pre').length, 0);
});

for (const data of [null, { status: 'ok' }, detail({ status: 'pending' }), detail({ record: record({ id: NOTE }) }),
  detail({ claims: [row({ task_id: NOTE })] }), detail({ related: [{ id: 'not-a-uuid', record_type: 'note' }] })]) {
  test(`task detail: malformed or mismatched envelope ${JSON.stringify(data).slice(0, 80)} stays unknown`, async t => {
    const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
    f.calls[0].resolve({ data, error: null }); await f.settle();
    assert.ok(f.text().includes('读取结果未知')); assert.equal(f.nodes('pre').length, 0);
    assert.ok(!f.text().includes('目前没有进行中的认领'));
  });
}

test('task detail: network loss can be retried without displaying old data', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].reject(new Error('offline')); await f.settle();
  assert.ok(f.text().includes('读取结果未知'));
  f.button('刷新').props.onClick(); f.calls[1].resolve({ data: detail(), error: null }); await f.settle();
  assert.ok(f.text().includes('Owner task')); assert.ok(!f.text().includes('读取结果未知'));
});

test('task detail: history is readable with its qualification, never presented as current', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, detail({ record: record({ currentness: 'HISTORY' }) }));
  assert.ok(f.text().includes('历史（HISTORY）')); assert.ok(f.text().includes('不能据此直接执行'));
});

test('task detail: completed history preserves the full plan and displays the outcome from closure_summary', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const plan = '原任务计划：完成私有钥匙与网页交接。\n原计划全文第二行。';
  const outcome = 'PR 570、PR 572 已合并、迁移、上线。<b>结案说明只读显示</b>';
  await loaded(f, detail({ record: record({ content: plan, lifecycle_status: 'completed', currentness: 'HISTORY',
    execution_bucket: null, closure_summary: outcome }) }));
  assert.ok(f.text().includes('已完成')); assert.ok(f.text().includes('历史（HISTORY）'));
  assert.ok(f.text().includes('不能据此直接执行')); assert.ok(f.text().includes('结案说明'));
  assert.equal(f.nodes('pre')[0].props.children, plan);
  assert.equal(f.nodes('pre')[1].props.children, outcome);
  assert.ok(!plan.includes('PR 570')); assert.ok(f.text().includes('PR 570、PR 572 已合并、迁移、上线。'));
  assert.equal(f.nodes('b').length, 0); assert.equal(f.nodes('input').length, 0); assert.equal(f.nodes('textarea').length, 0);
  assert.deepEqual(f.nodes('button').map(n => f.text(n)), ['刷新', '退出登录']);
});

test('work claims: full canonical Task UUID links to detail, malformed values remain text', async t => {
  const f = fixture(WORK_CLAIMS); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(f.calls.map(call => call.name), ['clued_work_claims_owner_list_v1', 'clued_work_free_handover_setting_v1']);
  f.calls[1].resolve({ data: { status: 'ok', enabled: true, version: 0, available: false }, error: null });
  f.calls[0].resolve({ data: { status: 'ok', claims: [row(), row({ claim_id: ENDED, task_id: 'javascript:alert(1)' })] }, error: null }); await f.settle();
  const links = f.nodes('a').filter(n => String(n.props.href).startsWith('/tasks'));
  assert.equal(links.length, 1); assert.equal(links[0].props.href, '/tasks?id=' + TASK); assert.equal(f.text(links[0]), TASK);
  assert.ok(f.text().includes('javascript:alert(1)')); assert.ok(!f.nodes('a').some(n => String(n.props.href).startsWith('javascript:')));
});

for (const settingOutcome of ['pending', 'failure']) {
  test(`work claims: ${settingOutcome} setting read cannot hold the list or enable an unknown switch`, async t => {
    const f = fixture(WORK_CLAIMS); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
    f.calls[0].resolve({ data: { status: 'ok', claims: [row(), row({ claim_id: ENDED, task_id: 'javascript:alert(1)' })] }, error: null });
    if (settingOutcome === 'failure') f.calls[1].reject(new Error('setting offline'));
    await f.settle();
    const links = f.nodes('a').filter(n => String(n.props.href).startsWith('/tasks'));
    assert.equal(links.length, 1); assert.equal(links[0].props.href, '/tasks?id=' + TASK);
    assert.ok(f.text().includes('javascript:alert(1)'));
    assert.equal(f.nodes('input').filter(n => n.props.role === 'switch').length, 0);
    assert.equal(f.button('刷新').props.disabled, false);
  });
}

test('work claims: late settings from an old refresh or account cannot replace the current account setting', async t => {
  const f = fixture(WORK_CLAIMS); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', claims: [row()] }, error: null }); await f.settle();
  f.button('刷新').props.onClick(); f.render();
  f.calls[1].resolve({ data: { status: 'ok', enabled: false, version: 1, available: true }, error: null }); await f.settle();
  assert.equal(f.nodes('input').filter(n => n.props.role === 'switch').length, 0);
  f.emit('SIGNED_IN', session('new-owner'));
  f.calls[4].resolve({ data: { status: 'ok', claims: [row({ task_title: 'New owner claim' })] }, error: null });
  f.calls[5].resolve({ data: { status: 'ok', enabled: true, version: 0, available: true }, error: null }); await f.settle();
  f.calls[2].resolve({ data: { status: 'ok', claims: [row({ task_title: 'Old owner claim' })] }, error: null });
  f.calls[3].resolve({ data: { status: 'ok', enabled: false, version: 2, available: true }, error: null }); await f.settle();
  assert.ok(f.text().includes('New owner claim')); assert.ok(!f.text().includes('Old owner claim'));
  assert.equal(f.nodes('input').find(n => n.props.role === 'switch').props.checked, true);
});
