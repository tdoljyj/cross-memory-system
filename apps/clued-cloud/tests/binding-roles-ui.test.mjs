// Binding roles page (/bindings, Task 869d2db7, Owner Decision 38ddb8cf; C10
// handover and purposes, Task bb13efb5) under
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

const ROLES = [{ role: 'ci-admission', title: 'GitHub CI 准入（绑定 PR、计入 CI 额度、手动触发准入、合并后采纳）', required_scope: 'context:read',
  marked: false, parking_count: 0 },
  { role: 'release-door', title: '生产发布门口（消费发布与迁移授权）', required_scope: 'context:write', marked: false }];
const roles = (marked, parking) => [{ ...ROLES[0], marked, parking_count: parking }, ROLES[1]];
const RESIDENT = { role: 'ci-admission', purpose: 'resident-node', purpose_title: '常驻节点', effective_at: '2026-10-23T00:00:00Z', in_force: true };
const PARKING = { role: 'ci-admission', purpose: 'parking', purpose_title: '停车位（只占住这个用途，永不放行）', effective_at: 'infinity', in_force: false };
const listed = (ciRoles = [], details = ciRoles.length ? [RESIDENT] : []) => ({ data: { status: 'ok', activation_delay_minutes: 5,
  roles: roles(ciRoles.length > 0, 0), bindings: [
    { binding_id: 'b-ci', agent_name: 'github-admission', vendor: 'github', scopes: ['context:read'], roles: ciRoles, role_details: details },
    { binding_id: 'b-claude', agent_name: 'Claude Code', vendor: 'anthropic', scopes: ['context:read', 'context:write'], roles: [], role_details: [] },
  ] }, error: null });
const issued = (enabled = true, extra = {}) => ({ data: { status: 'issued', confirmation_token: 'clued_brl_a', view_digest: 'd'.repeat(64),
  expires_at: '2099-01-01T00:05:00Z', confirmation_view: { binding_id: 'b-ci', agent_name: 'github-admission', vendor: 'github',
    scopes: ['context:read'], role: 'ci-admission', role_title: ROLES[0].title, enabled,
    purpose: enabled ? 'resident-node' : 'resident-node', purpose_title: '常驻节点',
    activation: enabled ? 'delayed' : 'ends_now', delay_minutes: enabled ? 5 : null, others: [], ...extra } }, error: null });

async function open(f, ciRoles, details) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_binding_roles_list_v1', { p_input: {} }]);
  f.calls[0].resolve(listed(ciRoles, details)); await f.settle();
}
const card = (f, label) => f.nodes('div').filter(n => n.props.className === 'owner-grant').find(n => f.text(n).includes(label));
const buttons = (f, n) => f.nodes('button', n).map(b => f.text(b));

test('signed out: no calls, a link to sign in', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0);
  assert.ok(f.text().includes('登录 BeamingFace'));
});

test('marking ci-admission takes a purpose, is two steps, and starts 5 minutes later', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  const shown = f.text();
  assert.ok(shown.includes('github-admission（github）'));
  assert.ok(shown.includes('Claude Code（anthropic）'));
  assert.deepEqual(buttons(f, card(f, 'github-admission')),
    ['设为 CI 准入：常驻节点', '设为 CI 准入：停车位', '设为 CI 准入：其他', '设为：发布门口']);
  f.button('设为 CI 准入：常驻节点').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_binding_role_confirmation_issue_v1',
    { p_input: { binding_id: 'b-ci', role: 'ci-admission', enabled: true, purpose: 'resident-node' } }]);
  f.calls[1].resolve(issued()); await f.settle();
  const panel = f.nodes('section').find(n => n.props['aria-label'] === '确认更改');
  assert.ok(f.text(panel).includes('GitHub CI 准入'));
  assert.ok(f.text(panel).includes('常驻节点'));
  assert.ok(f.text(panel).includes('设为专用'));
  assert.ok(f.text(panel).includes('确认 5 分钟后才生效'));
  // While a change waits for confirmation, no other change can start.
  assert.ok(f.nodes('button').filter(n => f.text(n).startsWith('设为')).every(n => n.props.disabled));
  f.button('确认').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_binding_role_set_v1',
    { p_input: { confirmation_token: 'clued_brl_a', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', binding_id: 'b-ci', role: 'ci-admission', enabled: true,
    purpose: 'resident-node', effective_at: '2026-10-23T00:05:00Z' }, error: null });
  await f.settle();
  assert.equal(f.calls[3].name, 'clued_binding_roles_list_v1', 'the list is read again');
  f.calls[3].resolve(listed(['ci-admission'], [{ ...RESIDENT, effective_at: '2026-10-23T00:05:00Z', in_force: false }])); await f.settle();
  assert.ok(f.text().includes('起生效（5 分钟后）。'));
  assert.ok(f.text(card(f, 'github-admission')).includes('常驻节点，'));
  assert.ok(f.text(card(f, 'github-admission')).includes('起生效（还没生效）'));
  assert.deepEqual(buttons(f, card(f, 'github-admission')), ['取消：CI 准入', '移交 CI 准入…', '设为：发布门口']);
  assert.ok(f.text().includes('CI 准入还没有停车位'), 'a marked role without a parking spot is pointed out');
  assert.equal(f.fetches.length, 0, 'the page never goes through a Worker route');
});

test('a parking spot never admits, and cannot be ended while it is the only one', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f);
  f.button('设为 CI 准入：停车位').props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { binding_id: 'b-ci', role: 'ci-admission', enabled: true, purpose: 'parking' });
  f.calls[1].resolve(issued(true, { purpose: 'parking', purpose_title: PARKING.purpose_title, activation: 'never', delay_minutes: null }));
  await f.settle();
  assert.ok(f.text().includes('永不放行，只占住这个用途'));
  f.button('确认').props.onClick();
  f.calls[2].resolve({ data: { status: 'committed', purpose: 'parking', effective_at: 'infinity' }, error: null }); await f.settle();
  f.calls[3].resolve({ data: { status: 'ok', activation_delay_minutes: 5, roles: roles(true, 1), bindings: [
    { binding_id: 'b-ci', agent_name: 'parking', vendor: 'Headless', scopes: ['context:read'], roles: ['ci-admission'], role_details: [PARKING], live: false },
  ] }, error: null });
  await f.settle();
  assert.ok(f.text().includes('已设为停车位'));
  assert.ok(f.text(card(f, 'parking')).includes('永不放行'));
  assert.deepEqual(buttons(f, card(f, 'parking')), [], 'no end and no handover for the only parking spot');
  assert.ok(f.text(card(f, 'parking')).includes('停车位不能直接取消'));
  assert.ok(!f.text().includes('CI 准入还没有停车位'));
});

test('with a second parking spot the first one can be ended', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', roles: roles(true, 2), bindings: [
    { binding_id: 'p-1', agent_name: 'parking-1', vendor: 'Headless', scopes: ['context:read'], roles: ['ci-admission'], role_details: [PARKING], live: false },
    { binding_id: 'p-2', agent_name: 'parking-2', vendor: 'Headless', scopes: ['context:read'], roles: ['ci-admission'], role_details: [PARKING], live: false },
  ] }, error: null });
  await f.settle();
  assert.deepEqual(buttons(f, card(f, 'parking-1')), ['取消：CI 准入（停车位）']);
  f.nodes('button', card(f, 'parking-1'))[0].props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { binding_id: 'p-1', role: 'ci-admission', enabled: false });
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'binding_role_parking_protected' }, error: null }); await f.settle();
  assert.ok(f.text().includes('停车位的 CI 准入不能直接取消'));
});

test('handover is two steps: pick a target, Clued renders X → Y, 确认 commits that token', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', activation_delay_minutes: 5, roles: roles(true, 1), bindings: [
    { binding_id: 'b-turing', agent_name: 'turing-resident', vendor: 'Headless', scopes: ['context:read'], roles: ['ci-admission'], role_details: [RESIDENT] },
    { binding_id: 'b-company', agent_name: 'company-resident', vendor: 'Headless', scopes: ['context:read'], roles: [], role_details: [] },
    { binding_id: 'b-writer', agent_name: 'writer-only', vendor: 'Headless', scopes: ['context:write'], roles: [], role_details: [] },
    { binding_id: 'b-dead', agent_name: 'dead-resident', vendor: 'Headless', scopes: ['context:read'], roles: [], role_details: [], live: false },
    { binding_id: 'b-park', agent_name: 'parking', vendor: 'Headless', scopes: ['context:read'], roles: ['ci-admission'], role_details: [PARKING], live: false },
  ] }, error: null });
  await f.settle();
  f.button('移交 CI 准入…').props.onClick(); f.render();
  const picker = f.nodes('section').find(n => n.props['aria-label'] === '移交 CI 准入');
  assert.ok(f.text(picker).includes('从 turing-resident（Headless） 移交给'));
  assert.deepEqual(buttons(f, picker), ['移交给：company-resident（Headless）', '返回'],
    'only live Bindings with context:read and no ci-admission row are offered');
  assert.ok(f.nodes('button').filter(n => f.text(n).startsWith('设为')).every(n => n.props.disabled));
  f.button('移交给：company-resident（Headless）').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]), ['clued_binding_role_handover_confirmation_issue_v1',
    { p_input: { from_binding_id: 'b-turing', to_binding_id: 'b-company' } }]);
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_brh_a', view_digest: 'e'.repeat(64), confirmation_view: {
    kind: 'binding_role_handover', role: 'ci-admission', role_title: ROLES[0].title,
    from: { binding_id: 'b-turing', agent_name: 'turing-resident', vendor: 'Headless', live: true, purpose: 'resident-node',
      purpose_title: '常驻节点' },
    to: { binding_id: 'b-company', agent_name: 'company-resident', vendor: 'Headless', scopes: ['context:read'], purpose: 'resident-node' },
    delay_minutes: 5, others: [{ binding_id: 'b-park', agent_name: 'parking', vendor: 'Headless', live: false, purpose: 'parking',
      purpose_title: PARKING.purpose_title, effective_at: 'infinity' }] } }, error: null });
  await f.settle();
  assert.equal(f.nodes('section').find(n => n.props['aria-label'] === '移交 CI 准入'), undefined, 'the picker closes');
  const panel = f.nodes('section').find(n => n.props['aria-label'] === '确认更改');
  assert.ok(f.text(panel).includes('确认移交'));
  assert.ok(f.text(panel).includes('turing-resident（Headless）（常驻节点）：确认后立即结束'), 'the purpose of X is shown');
  assert.ok(f.text(panel).includes('两者都不能做 CI 准入，PR 只是晚一点开始；其他已生效的持有者不受影响。'));
  assert.ok(f.text(panel).includes('company-resident（Headless）：用途为常驻节点，确认 5 分钟后才生效'));
  assert.ok(f.text(panel).includes('parking（已失效），停车位'));
  assert.ok(f.text(panel).includes('（不变）'));
  f.button('确认').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]), ['clued_binding_role_handover_v1',
    { p_input: { confirmation_token: 'clued_brh_a', view_digest: 'e'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', role: 'ci-admission', from_binding_id: 'b-turing', to_binding_id: 'b-company',
    effective_at: '2026-10-23T00:05:00Z' }, error: null });
  await f.settle();
  assert.equal(f.calls[3].name, 'clued_binding_roles_list_v1');
  assert.ok(f.text().includes('已移交：turing-resident（Headless） 的 CI 准入已结束；company-resident（Headless） 从'));
  assert.ok(f.text().includes('起生效（5 分钟后），在那之前两者都不能做 CI 准入。'));
});

test('handover: backing out of the picker makes no call; a refusal is shown in plain words', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, ['ci-admission']);
  f.button('移交 CI 准入…').props.onClick(); f.render();
  assert.ok(f.text().includes('移交给：Claude Code（anthropic）'));
  f.button('返回').props.onClick(); f.render();
  assert.equal(f.nodes('section').find(n => n.props['aria-label'] === '移交 CI 准入'), undefined);
  assert.equal(f.calls.length, 1);
  f.button('移交 CI 准入…').props.onClick(); f.render();
  f.button('移交给：Claude Code（anthropic）').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'binding_role_resident_holder_exists' }, error: null }); await f.settle();
  assert.ok(f.text().includes('已经有一个有效的连接以常驻节点的用途持有 CI 准入'));
});

test('ending a role and backing out of a change', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await open(f, ['ci-admission']);
  f.button('取消：CI 准入').props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { binding_id: 'b-ci', role: 'ci-admission', enabled: false });
  f.calls[1].resolve(issued(false)); await f.settle();
  assert.ok(f.text().includes('取消专用'));
  assert.ok(f.text().includes('这是这个用途的最后一个持有者：取消后，这个用途对所有连接开放。'));
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

test('a revoked or expired Binding that still holds a role is shown as 已失效 and can only be ended or handed over', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  f.emit('INITIAL_SESSION', session('owner'));
  f.calls[0].resolve({ data: { status: 'ok', roles: ROLES, bindings: [
    { binding_id: 'b-old', agent_name: 'old-admission', vendor: 'github', scopes: ['context:read'], roles: ['ci-admission'], live: false,
      role_details: [{ role: 'ci-admission', purpose: 'unspecified', purpose_title: '用途未标明（按常驻节点对待）', effective_at: '2026-10-01T00:00:00Z', in_force: true }] },
    { binding_id: 'b-new', agent_name: 'new-admission', vendor: 'github', scopes: ['context:read'], roles: [], live: true },
  ] }, error: null });
  await f.settle();
  const oldCard = card(f, 'old-admission');
  const newCard = card(f, 'new-admission');
  assert.ok(f.text(oldCard).includes('已失效'));
  assert.ok(f.text(oldCard).includes('用途未标明（按常驻节点对待），已生效'));
  assert.deepEqual(buttons(f, oldCard), ['取消：CI 准入', '移交 CI 准入…'], 'a dead Binding offers only ending or handing over its role');
  assert.ok(!f.text(newCard).includes('已失效'));
  assert.deepEqual(buttons(f, newCard), ['设为 CI 准入：常驻节点', '设为 CI 准入：停车位', '设为 CI 准入：其他', '设为：发布门口']);
  f.nodes('button', oldCard)[0].props.onClick();
  assert.deepEqual(plain(f.calls[1].args.p_input), { binding_id: 'b-old', role: 'ci-admission', enabled: false });
});
