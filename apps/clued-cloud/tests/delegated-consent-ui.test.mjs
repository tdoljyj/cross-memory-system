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

const RECORD = ['read', 'write', 'close', 'restore', 'audit'];
const CONTEXT = ['read', 'write', 'close', 'feedback_submit'];
const FUTURE_RECORDS = 'owned-project-records:future';
const FUTURE_CONTEXTS = 'owned-project-contexts:future';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';
const CONTEXT_ID = '33333333-3333-4333-8333-333333333333';
const ALL_SCOPES = ['context:read', 'context:write', 'audit:read'];
const session = { user: { id: 'owner', email: 'owner@example.test' }, access_token: 'fixture-owner' };
const scope = (id, actions = RECORD, extra = {}) => ({ resource_kind: 'scope', resource_id: id, environment: 'canonical', ownership: 'self', actions: [...actions], ...extra });
const policies = () => [scope(FUTURE_RECORDS), scope(FUTURE_CONTEXTS, CONTEXT)];
const project = (id, name) => scope('project:' + id, RECORD, { project_id: id, project_name: name });
const context = (id, environment, projectId, projectName, name, ownership = 'self') => ({
  resource_kind: 'context', resource_id: id, environment, project_id: projectId, project_name: projectName, context_name: name, ownership, actions: [...CONTEXT],
});
const eligible = () => [
  scope('contexts:*', [...RECORD, 'feedback_submit']), scope('project:*'),
  scope('profile'), scope('global'), project(ALPHA, 'alpha'),
  context(CONTEXT_ID, 'test', ALPHA, 'alpha', 'workspace'), context(CONTEXT_ID, 'preview', ALPHA, 'alpha', 'workspace'),
  project(BETA, 'beta'), ...policies(),
];
async function ready(t, rows = eligible(), requestedScopes = ALL_SCOPES) {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session); f.runTimers();
  f.respond(0, { request_id: 'fixture-request', version: 11, client_name: 'Fixture client', client_id: 'fixture-client', requested_scopes: requestedScopes, eligible: rows, user: session.user });
  await f.settle(); return f;
}
function find(f, type, ariaLabel) {
  const node = f.nodes(type).find(n => n.props['aria-label'] === ariaLabel); assert.ok(node, ariaLabel); return node;
}
function toggle(f, label, checked) { f.checkbox(label).props.onChange({ target: { checked } }); f.render(); }
function shortcut(f, owner, title) { const group = find(f, 'div', owner + '快捷权限'); const button = f.button(title, group); assert.equal(button.props.disabled, false); button.props.onClick(); f.render(); }
const actions = (f, name) => f.nodes('input', find(f, 'fieldset', name)).filter(n => n.props.type === 'checkbox' && n.props['aria-label']?.startsWith(name + ' · '));
const picked = (f, name) => actions(f, name).filter(n => n.props.checked).map(n => n.props['aria-label'].slice(name.length + 3));
function triState(f, name, expected) {
  const input = f.checkbox(name), all = expected === 'all', mixed = expected === 'mixed';
  assert.equal(input.props.checked, all); assert.equal(input.props['aria-checked'], mixed ? 'mixed' : all);
  const dom = { indeterminate: !mixed }; input.props.ref(dom); assert.equal(dom.indeterminate, mixed); assert.doesNotThrow(() => input.props.ref(null));
}
async function submit(f) {
  const button = f.button('允许所选权限'); assert.equal(button.props.disabled, false); button.props.onClick(); await f.settle();
  return JSON.parse(f.requests.at(-1).options.body);
}
const entry = (payload, id, environment = 'canonical') => payload.selected.find(row => row.resource_id === id && row.environment === environment);
const noLegacyMacros = payload => assert.ok(payload.selected.every(row => !['contexts:*', 'project:*'].includes(row.resource_id)));

test('accepted hierarchy has peer personal/project cards, concrete descriptions and initially closed details', async t => {
  const f = await ready(t), total = find(f, 'div', '全部权限设置');
  const top = f.nodes('div', total).find(n => n.props.className === 'selected-top-level');
  const direct = [top.props.children].flat(3).filter(n => n && typeof n === 'object');
  assert.deepEqual(direct.map(n => n.props['aria-label']), ['个人资料权限组', '个人记录权限组', '项目权限组']);
  assert.ok(f.nodes('details').every(n => n.props.open !== true), 'JSX defaults closed; browser behavior is separately qualified');
  assert.equal(f.nodes('input').some(n => n.props.type === 'radio'), false);
  for (const [card, description] of [
    ['个人资料', '你的身份、偏好和长期背景。'],
    ['个人记录', '不属于具体项目的待办、笔记和想法，例如购物清单、随手灵感。'],
    ['项目', '围绕具体项目保存的目标、任务、决策和进展，例如一个产品的开发记录。'],
  ]) {
    assert.ok(f.text(f.nodes('summary', find(f, 'div', card + '权限组'))[0]).includes(description));
  }
  const personal = find(f, 'fieldset', '个人资料');
  assert.equal(f.nodes('legend', personal).length, 0, 'compact personal content does not repeat its heading');
  assert.equal(f.nodes('input', personal).length, 5, 'no redundant personal all/count controls');
  assert.deepEqual(f.nodes('label', find(f, 'fieldset', 'alpha 项目记录')).filter(n => n.props.className === 'selected-action').map(n => f.text(n)), ['读取', '新增和修改', '关闭和归档', '恢复', '查看审计回执']);
  assert.equal(actions(f, 'alpha workspace · 测试环境').length, 4);
  assert.ok(!f.text(find(f, 'fieldset', 'alpha workspace · 测试环境')).includes('alpha'), 'visible child titles do not repeat the parent project name');
  triState(f, '全部权限', 'all'); assert.equal(f.requests.length, 1, 'preselection never submits consent');
});

test('shortcuts and manual actions derive native mixed state and preserve unrelated groups', async t => {
  const f = await ready(t); shortcut(f, '个人资料', '只读');
  assert.deepEqual(picked(f, '个人资料'), ['读取']); assert.equal(actions(f, '个人记录').every(n => n.props.checked), true);
  triState(f, '个人资料的全部权限', 'mixed'); triState(f, '全部权限', 'mixed');
  shortcut(f, 'alpha', '读写'); toggle(f, 'alpha 项目记录 · 恢复', true);
  assert.deepEqual(picked(f, 'alpha 项目记录'), ['读取', '新增和修改', '恢复']);
  assert.deepEqual(picked(f, 'alpha workspace · 测试环境'), ['读取', '新增和修改']);
  const quick = find(f, 'div', 'alpha快捷权限');
  assert.ok(f.nodes('button', quick).every(n => n.props['aria-pressed'] === false));
  assert.ok(f.text(find(f, 'div', 'alpha权限组')).includes('自定义'));
  toggle(f, '全部权限', true); triState(f, '全部权限', 'all');
  toggle(f, '全部权限', false); triState(f, '全部权限', 'none'); assert.equal(f.button('允许所选权限').props.disabled, true);
});

test('manual writes and feedback submit only their exact canonical resource/environment without implicit read', async t => {
  const f = await ready(t); toggle(f, '全部权限', false);
  toggle(f, 'alpha workspace · 测试环境 · 新增和修改', true);
  toggle(f, 'alpha workspace · 预览环境 · 提交反馈', true);
  const payload = await submit(f);
  assert.deepEqual(payload.selected, [
    { resource_kind: 'context', resource_id: CONTEXT_ID, environment: 'test', actions: ['write'] },
    { resource_kind: 'context', resource_id: CONTEXT_ID, environment: 'preview', actions: ['feedback_submit'] },
  ]);
  assert.equal(f.nodes('input').filter(n => n.props.type === 'checkbox').every(n => n.props.disabled), true);
});

test('remove and re-add clears only that range; project shortcuts never revive a removed range', async t => {
  const f = await ready(t); shortcut(f, 'alpha', '只读');
  toggle(f, 'alpha选择范围 · workspace · 测试环境', false);
  assert.equal(f.nodes('fieldset').some(n => n.props['aria-label'] === 'alpha workspace · 测试环境'), false);
  shortcut(f, 'alpha', '读写'); toggle(f, 'alpha选择范围 · workspace · 测试环境', true);
  assert.deepEqual(picked(f, 'alpha workspace · 测试环境'), []);
  assert.deepEqual(picked(f, 'alpha 项目记录'), ['读取', '新增和修改']);
  assert.deepEqual(picked(f, 'alpha workspace · 预览环境'), ['读取', '新增和修改']);
  assert.ok(f.text().includes('已加入这个内容范围，但尚未授权'));
  const payload = await submit(f); assert.equal(entry(payload, CONTEXT_ID, 'test'), undefined);
  assert.deepEqual(entry(payload, CONTEXT_ID, 'preview').actions, ['read', 'write']);
  assert.deepEqual(entry(payload, FUTURE_CONTEXTS).actions, CONTEXT); noLegacyMacros(payload);
});

test('empty project ranges disable shortcuts; explicit project all reactivates only that project', async t => {
  const f = await ready(t);
  for (const name of ['项目记录', 'workspace · 测试环境', 'workspace · 预览环境']) toggle(f, 'alpha选择范围 · ' + name, false);
  const quick = find(f, 'div', 'alpha快捷权限'); assert.equal(f.nodes('button', quick).every(n => n.props.disabled), true);
  assert.ok(f.text(find(f, 'div', 'alpha权限组')).includes('未选择范围'));
  toggle(f, '个人资料的全部权限', false);
  toggle(f, 'alpha的全部权限', true);
  assert.equal(actions(f, 'alpha 项目记录').every(n => n.props.checked), true);
  assert.equal(actions(f, 'alpha workspace · 测试环境').every(n => n.props.checked), true);
  assert.deepEqual(picked(f, '个人资料'), []);
  assert.equal(actions(f, '未来项目上下文').every(n => n.props.checked), true);
});

test('membership and unknown ownership default empty while precise shared content remains selectable', async t => {
  const member = context('44444444-4444-4444-8444-444444444444', 'test', 'shared-project', 'shared', 'team', 'membership');
  const unknown = context('55555555-5555-4555-8555-555555555555', 'test', 'unknown-project', 'unknown', 'unclassified', undefined);
  delete unknown.ownership;
  const f = await ready(t, [...eligible(), member, unknown]);
  assert.equal(f.checkbox('shared选择范围 · team · 测试环境').props.checked, false);
  assert.equal(f.checkbox('unknown选择范围 · unclassified · 测试环境').props.checked, false);
  assert.equal(f.nodes('fieldset').some(n => n.props['aria-label'] === 'shared team · 测试环境'), false);
  assert.ok(f.text(find(f, 'div', 'shared权限组')).includes('共享或受邀'));
  toggle(f, 'shared选择范围 · team · 测试环境', true);
  assert.deepEqual(picked(f, 'shared team · 测试环境'), []); toggle(f, 'shared team · 测试环境 · 读取', true);
  const payload = await submit(f);
  assert.deepEqual(entry(payload, member.resource_id, 'test').actions, ['read']);
  assert.equal(entry(payload, unknown.resource_id, 'test'), undefined);
  assert.deepEqual(entry(payload, FUTURE_CONTEXTS).actions, CONTEXT);
});

test('future record/context defaults stay independent from current exceptions and personal groups', async t => {
  const f = await ready(t); toggle(f, 'alpha的全部权限', false); shortcut(f, '未来项目记录', '只读');
  assert.equal(actions(f, '未来项目上下文').every(n => n.props.checked), true);
  assert.deepEqual(picked(f, 'alpha 项目记录'), []); assert.equal(actions(f, '个人资料').every(n => n.props.checked), true);
  const payload = await submit(f);
  assert.deepEqual(entry(payload, FUTURE_RECORDS).actions, ['read']); assert.deepEqual(entry(payload, FUTURE_CONTEXTS).actions, CONTEXT);
  assert.equal(entry(payload, 'project:' + ALPHA), undefined); assert.equal(entry(payload, CONTEXT_ID, 'test'), undefined);
  assert.deepEqual(entry(payload, 'project:' + BETA).actions, RECORD); noLegacyMacros(payload);
});

test('future-only choice is a real independent policy grant and empty whole-tree selection cannot approve', async t => {
  const f = await ready(t); toggle(f, '全部权限', false);
  f.button('允许所选权限').props.onClick(); await f.settle(); assert.equal(f.requests.length, 1);
  shortcut(f, '未来项目上下文', '只读');
  assert.deepEqual((await submit(f)).selected, [{ resource_kind: 'scope', resource_id: FUTURE_CONTEXTS, environment: 'canonical', actions: ['read'] }]);
});

test('requested scopes bound every offered action including future contexts', async t => {
  const f = await ready(t, eligible(), ['context:read']);
  assert.equal(actions(f, '个人资料').length, 1); assert.equal(actions(f, 'alpha workspace · 测试环境').length, 1);
  assert.equal(actions(f, '未来项目上下文').length, 1);
  const payload = await submit(f); assert.ok(payload.selected.every(row => JSON.stringify(row.actions) === '["read"]')); noLegacyMacros(payload);
});

test('audit-only capabilities retain the zero-action context marker without inventing context audit rights', async t => {
  const rows = eligible().map(row => row.resource_id === FUTURE_CONTEXTS ? { ...row, actions: [] } : row);
  const f = await ready(t, rows, ['audit:read']);
  assert.equal(f.nodes('fieldset').some(n => n.props['aria-label'] === '未来项目上下文'), false);
  assert.ok(!f.text().includes('尚未提供完整'));
  const payload = await submit(f);
  assert.deepEqual(entry(payload, FUTURE_RECORDS).actions, ['audit']); assert.equal(entry(payload, FUTURE_CONTEXTS), undefined);
  assert.ok(payload.selected.every(row => row.resource_kind === 'scope' && JSON.stringify(row.actions) === '["audit"]'));
});

test('missing, mistyped or unowned future capability fails closed while real denial stays available', async t => {
  for (const alter of [
    rows => rows.filter(row => row.resource_id !== FUTURE_CONTEXTS),
    rows => rows.map(row => row.resource_id === FUTURE_CONTEXTS ? { ...row, environment: 'test' } : row),
    rows => rows.map(row => row.resource_id === FUTURE_CONTEXTS ? { ...row, ownership: 'membership' } : row),
  ]) {
    const f = await ready(t, alter(eligible())); assert.equal(f.button('允许所选权限').props.disabled, true);
    assert.ok(f.text().includes('尚未提供完整')); f.button('允许所选权限').props.onClick(); await f.settle(); assert.equal(f.requests.length, 1);
    f.button('取消').props.onClick(); await f.settle();
    assert.deepEqual(JSON.parse(f.requests[1].options.body), { action: 'deny', selected: [], days: 30, version: 11 });
  }
});

const projectId = n => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const large = count => [scope('contexts:*', [...RECORD, 'feedback_submit']), scope('profile'), scope('global'),
  ...Array.from({ length: count }, (_, i) => project(projectId(i + 1), 'Project ' + (i + 1))), ...policies()];

test('100 exact grants stay exact; a provably equivalent 101-grant owned tree compresses without hidden grants', async t => {
  const boundary = await ready(t, large(96)), exact = await submit(boundary);
  assert.equal(exact.selected.length, 100); noLegacyMacros(exact); assert.ok(entry(exact, 'project:' + projectId(96)));
  const over = await ready(t, large(97)), compressed = await submit(over);
  assert.deepEqual(compressed.selected, [{ resource_kind: 'scope', resource_id: 'contexts:*', environment: 'canonical', actions: [...RECORD, 'feedback_submit'] }]);
});

test('equivalent compression preserves selected membership triples and their independent actions', async t => {
  const member = context('66666666-6666-4666-8666-666666666666', 'preview', 'team-project', 'team', 'shared context', 'membership');
  const f = await ready(t, [...large(97), member]);
  toggle(f, 'team选择范围 · shared context · 预览环境', true); toggle(f, 'team shared context · 预览环境 · 读取', true);
  const payload = await submit(f); assert.equal(payload.selected.length, 2);
  assert.deepEqual(entry(payload, 'contexts:*').actions, [...RECORD, 'feedback_submit']);
  assert.deepEqual(entry(payload, member.resource_id, 'preview'), { resource_kind: 'context', resource_id: member.resource_id, environment: 'preview', actions: ['read'] });
});

test('asymmetric future policies and an omitted current resource never compress or silently truncate', async t => {
  for (const edit of [
    f => shortcut(f, '未来项目记录', '只读'),
    f => shortcut(f, '未来项目上下文', '只读'),
    f => toggle(f, 'Project 1的全部权限', false),
  ]) {
    const f = await ready(t, large(100)); edit(f);
    assert.ok(f.text().includes('当前选择超过 100')); assert.equal(f.button('允许所选权限').props.disabled, true);
    assert.equal(f.checkbox('Project 100的全部权限').props.checked, true, 'last range is still selected, not truncated');
    f.button('允许所选权限').props.onClick(); await f.settle(); assert.equal(f.requests.length, 1);
  }
});

test('reducing a custom oversized tree to 100 preserves its exact omissions and final resource', async t => {
  const f = await ready(t, large(100));
  for (let i = 1; i <= 4; i++) toggle(f, 'Project ' + i + '的全部权限', false);
  const payload = await submit(f); assert.equal(payload.selected.length, 100); noLegacyMacros(payload);
  for (let i = 1; i <= 4; i++) assert.equal(entry(payload, 'project:' + projectId(i)), undefined);
  assert.ok(entry(payload, 'project:' + projectId(100))); assert.deepEqual(entry(payload, FUTURE_CONTEXTS).actions, CONTEXT);
});

test('unknown ownership prevents capacity compression and never gets a default grant', async t => {
  const rows = large(100); const first = rows.find(row => row.resource_id === 'project:' + projectId(1)); delete first.ownership;
  const f = await ready(t, rows);
  assert.equal(f.checkbox('Project 1的全部权限').props.checked, false);
  assert.equal(f.checkbox('Project 1选择范围 · 项目记录').props.checked, false);
  assert.ok(f.text().includes('当前选择超过 100')); assert.equal(f.button('允许所选权限').props.disabled, true);
  f.button('允许所选权限').props.onClick(); await f.settle(); assert.equal(f.requests.length, 1);
});

test('focused consent controls use the local style module and native tri-state ref instead of old role cards', () => {
  const css = readFileSync(new URL('../app/oauth/consent/consent.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.selected-consent :is\(input, button, select, summary\):focus-visible\s*\{[^}]*outline:\s*2px/s);
  assert.match(css, /\.selected-quick-buttons button\s*\{[^}]*min-width:\s*0/s);
});
