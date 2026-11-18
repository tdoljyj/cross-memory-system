// Controlled-hook component tests exercise the Native page's actual event
// handlers and async RPC boundaries. They do not prove database authority/locks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../app/ci-nodes/page.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
const PROJECT = '11111111-1111-4111-8111-111111111111';
const NODE = '22222222-2222-4222-8222-222222222222';
const BINDING = '33333333-3333-4333-8333-333333333333';
const SID = '44444444-4444-4444-8444-444444444444';
const SECOND_SID = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-10-23T10:00:00Z');
const LIMITS = { execution_start: 12, evaluation: 24, PR_batch: 2, head_release: 6, stage8_retry: 1, head_distinct_combination_24h: 3 };
const plain = value => JSON.parse(JSON.stringify(value));
const jwt = (sid, suffix = '') => 'header.' + Buffer.from(JSON.stringify({ session_id: sid })).toString('base64url') + '.signature' + suffix;
const session = (id = 'owner', sid = SID, suffix = '') => ({ user: { id }, access_token: jwt(sid, suffix) });
const node = (extra = {}) => ({ node_id: NODE, name: '公司测试节点', state: 'pending', version: 1, binding_id: BINDING,
  profile_sha256: 'a'.repeat(64), identity_fingerprint: 'b'.repeat(64), encryption_fingerprint: 'c'.repeat(64),
  qualification_status: 'unverified', publisher_approved: false, scan_signing_approved: false,
  connection_expires_at: '2026-10-24T10:00:00Z', ...extra });
const listed = (nodes = [node()], extra = {}) => ({ status: 'ok', mode: 'prepared', nodes,
  pool: { version: 0, status: 'UNCONFIGURED', mode: 'prepared', limits: null }, node_list: { version: 0, sha256: null },
  bindings: [{ id: BINDING, agent_name: 'Codex Desktop' }], observed_at: '2026-10-23T10:00:00Z', ...extra });
const issued = (extra = {}) => ({ status: 'issued', confirmation_token: 'fixture-token', view_digest: 'd'.repeat(64),
  expires_at: '2026-10-23T10:05:00Z', confirmation_view: { project_id: PROJECT, node_id: NODE,
    base_version: 1, action: 'approve', name: '公司测试节点', publisher_requested: false, eligibility: false }, ...extra });
const publicRegistration = () => ({ binding_id: BINDING, name: '家里测试节点', profile: { slot_count: 1 },
  profile_sha256: 'a'.repeat(64), identity_public_jwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) },
  encryption_public_jwk: { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) },
  qualification_digest: 'e'.repeat(64), qualification_source: 'f'.repeat(40), publisher_requested: false, scan_signing_requested: false });

function fixture() {
  const hooks = [], effects = [], calls = [], timers = [];
  let cursor = 0, root, callback, now = NOW, nextId = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) { const index = cursor++; hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }]; },
    useRef(initial) { const index = cursor++; hooks[index] ??= { current: initial }; return hooks[index]; },
    useEffect(fn, deps) { const index = cursor++; if (!hooks[index] || !equal(hooks[index].deps, deps)) {
      const old = hooks[index]; hooks[index] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[index].cleanup = fn(); }); } },
  };
  const supabase = { auth: { onAuthStateChange(fn) { callback = fn; return { data: { subscription: { unsubscribe() { callback = null; } } } }; } },
    rpc(name, args) { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ name, args: plain(args), resolve: data => resolve({ data, error: null }), error: error => resolve({ data: null, error }), reject }); return promise; } };
  const exports = {};
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    throw new Error(name);
  }, Date: Clock, Error, Intl, JSON, Object, Array, Number, String, RegExp, URL,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  crypto: { randomUUID: () => '99999999-9999-4999-8999-' + String(++nextId).padStart(12, '0') },
  window: { location: { href: 'https://example.test/ci-nodes?project_id=' + PROJECT },
    setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} } });
  function render() { cursor = 0; root = exports.default(); while (effects.length) effects.shift()(); return root; }
  function nodes(type) { const out = []; (function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (value.type === type) out.push(value);
    visit(value.props?.children);
  })(root); return out; }
  function text(value = root) { if (Array.isArray(value)) return value.map(text).join('');
    if (value === null || value === undefined || typeof value === 'boolean') return '';
    return typeof value === 'object' ? text(value.props?.children ?? null) : String(value); }
  const button = label => { const value = nodes('button').find(item => text(item) === label); assert.ok(value, label); return value; };
  const field = id => { const value = [...nodes('input'), ...nodes('textarea'), ...nodes('select')].find(item => item.props.id === id); assert.ok(value, id); return value; };
  function change(id, value) { field(id).props.onChange({ target: { value } }); render(); }
  function click(label) { const item = button(label); assert.equal(Boolean(item.props.disabled), false, label + ' enabled'); item.props.onClick(); render(); }
  async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); render(); }
  function emit(next, event = 'SIGNED_IN') { callback(event, next); render(); }
  render(); render();
  return { calls, render, nodes, text, button, field, click, change, settle, emit,
    tick(value) { now = value; timers.forEach(fn => fn()); render(); },
    unmount() { hooks.forEach(hook => hook?.cleanup?.()); },
  };
}

async function load(f, data = listed()) {
  f.emit(session(), 'INITIAL_SESSION');
  assert.deepEqual([f.calls[0].name, f.calls[0].args], ['clued_ci_nodes_v1', { p_input: { project_id: PROJECT } }]);
  f.calls[0].resolve(data); await f.settle();
}
async function preview(f, extra) {
  f.change('ci-accepted-ref', 'decision:fixture');
  f.click('批准登记'); f.calls.at(-1).resolve(issued(extra)); await f.settle();
}
function fillLimits(f, values = LIMITS) {
  for (const [key, value] of Object.entries(values)) f.change('ci-limit-' + key, String(value));
}

const REBINDING = '66666666-6666-4666-8666-666666666666';
async function rebindPreview(f) {
  await load(f, listed([node({ state: 'active', binding_generation: 1 })], {
    bindings: [{ id: BINDING, agent_name: '旧连接' }, { id: REBINDING, agent_name: '新连接' }],
  }));
  f.change('ci-accepted-ref', 'decision:rebind'); f.change('ci-rebind-' + NODE, REBINDING);
  f.click('预览更换节点连接');
  assert.equal(f.calls.at(-1).name, 'clued_ci_node_binding_rebind_confirmation_issue_v1');
  const choices = f.calls.at(-1).args.p_input;
  assert.deepEqual([choices.node_id, choices.old_binding_id, choices.new_binding_id, choices.base_version, choices.binding_generation], [NODE, BINDING, REBINDING, 1, 1]);
  return issued({ confirmation_view: { choices, heartbeat_links: [], roles: [], failover_members: [], effects: { local_activation: 'required' } } });
}

test('node connection replacement previews exact identities, uses a second confirmation and explains local activation', async t => {
  const f = fixture(); t.after(() => f.unmount()); const pending = await rebindPreview(f);
  f.calls.at(-1).resolve(pending); await f.settle();
  assert.ok(f.text().includes('确认更换节点连接')); assert.ok(!f.text().includes('fixture-token'));
  f.click('确认修改');
  assert.deepEqual([f.calls.at(-1).name, f.calls.at(-1).args.p_input], ['clued_ci_node_binding_rebind_apply_v1', {
    confirmation_token: pending.confirmation_token, view_digest: pending.view_digest }]);
  f.calls.at(-1).resolve({ status: 'committed', node_id: NODE, project_id: PROJECT, binding_id: REBINDING, binding_generation: 2, version: 2 });
  await f.settle(); assert.ok(f.text().includes('服务器确认不代表本机切换完成')); assert.equal(f.calls.length, 3);
});

test('node replacement refuses an unrelated preview and a late preview after an account switch', async t => {
  const f = fixture(); t.after(() => f.unmount()); const pending = await rebindPreview(f);
  f.calls.at(-1).resolve({ ...pending, confirmation_view: { choices: { ...pending.confirmation_view.choices, new_binding_id: BINDING } } });
  await f.settle(); assert.equal(f.nodes('pre').length, 0); assert.ok(f.text().includes('预览与所选节点不一致'));
  const g = fixture(); t.after(() => g.unmount()); const late = await rebindPreview(g), call = g.calls.at(-1);
  g.emit(session('second-owner', SECOND_SID)); call.resolve(late); await g.settle();
  assert.equal(g.nodes('pre').length, 0); assert.ok(!g.text().includes('公司测试节点'));
});

test('an uncertain node replacement never resubmits and recovers only the exact binding generation', async t => {
  const f = fixture(); t.after(() => f.unmount()); const pending = await rebindPreview(f);
  f.calls.at(-1).resolve(pending); await f.settle(); f.click('确认修改');
  f.calls.at(-1).reject(Error('transport result unknown')); await f.settle();
  assert.ok(f.text().includes('上次请求结果未知')); assert.equal(f.calls.length, 3);
  f.click('只读核对状态'); f.calls.at(-1).resolve(listed([node({ version: 3, binding_generation: 3, binding_id: REBINDING })])); await f.settle();
  assert.ok(f.text().includes('上次请求仍未确认'));
  f.click('只读核对状态'); f.calls.at(-1).resolve(listed([node({ version: 2, binding_generation: 2, binding_id: REBINDING })])); await f.settle();
  assert.ok(f.text().includes('已读取当前的新记录')); assert.equal(f.calls.filter(c => c.name.endsWith('rebind_apply_v1')).length, 1);
});

test('retired/revoked nodes offer no replacement; server connection reminders are visible', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await load(f, listed([node({ state: 'revoked' })], { connection_reminders: [{ receipt_id: 'reminder', binding_id: BINDING,
    connection_kind: 'ci', expires_at: '2026-10-24T10:00:00Z' }] }));
  assert.ok(f.text().includes('连接到期提醒')); assert.ok(!f.nodes('button').some(b => f.text(b) === '预览更换节点连接'));
});

test('Native CI page makes no protected call while signed out and keeps the phase boundary visible', t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit(null, 'INITIAL_SESSION');
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('登录 BeamingFace'));
  assert.ok(f.text().includes('准备阶段 · 尚未启用调度'));
});

test('approval shows the complete server view, uses a second request with only token/digest, and changes no state optimistically', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  f.change('ci-accepted-ref', 'decision:fixture');
  f.click('批准登记');
  assert.deepEqual([f.calls[1].name, f.calls[1].args], ['clued_ci_node_confirmation_issue_v1', { p_input: {
    project_id: PROJECT, node_id: NODE, base_version: 1, action: 'approve', accepted_ref: 'decision:fixture' } }]);
  assert.ok(f.text().includes('待批准'));
  f.calls[1].resolve(issued()); await f.settle();
  assert.deepEqual(JSON.parse(f.text(f.nodes('pre')[0])), issued().confirmation_view);
  assert.ok(!f.text().includes('fixture-token'));
  f.click('确认修改');
  assert.deepEqual([f.calls[2].name, f.calls[2].args], ['clued_ci_node_apply_v1', { p_input: {
    confirmation_token: 'fixture-token', view_digest: 'd'.repeat(64) } }]);
  assert.ok(f.text().includes('待批准'));
  f.calls[2].resolve({ status: 'committed', node_id: NODE, version: 2, state: 'active' }); await f.settle();
  assert.ok(f.text().includes('登记批准不代表已取得运行资格'));
  assert.equal(f.calls.length, 3, 'no automatic read or mutation retry');
  f.click('刷新状态'); f.calls[3].resolve(listed([node({ state: 'active', version: 2 })])); await f.settle();
  assert.ok(f.text().includes('已登记 · 版本 2')); assert.ok(f.text().includes('尚未取得运行资格'));
  assert.equal(f.nodes('button').some(item => /启用|派单|取得资格/.test(f.text(item))), false);
});

test('a new account discards a late preview and its old node data', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); f.change('ci-accepted-ref', 'decision:fixture'); f.click('批准登记');
  f.emit(session('second-owner', SECOND_SID));
  assert.equal(f.calls[2].name, 'clued_ci_nodes_v1');
  f.calls[1].resolve(issued()); await f.settle();
  assert.equal(f.nodes('pre').length, 0); assert.ok(!f.text().includes('公司测试节点'));
  f.calls[2].resolve(listed([])); await f.settle(); assert.ok(f.text().includes('尚未登记节点'));
});

test('same-owner Native session replacement invalidates confirmation; token refresh within the same session preserves it', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); await preview(f);
  f.emit(session('owner', SID, '-refreshed'), 'TOKEN_REFRESHED');
  assert.equal(f.nodes('pre').length, 1); assert.equal(f.calls.length, 2);
  f.emit(session('owner', SECOND_SID));
  assert.equal(f.nodes('pre').length, 0); assert.equal(f.calls[2].name, 'clued_ci_nodes_v1');
});

test('an apply result arriving after sign-out is ignored and cannot report success in another account', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); await preview(f); f.click('确认修改');
  f.emit(null, 'SIGNED_OUT');
  f.calls[2].resolve({ status: 'committed', node_id: NODE, version: 2, state: 'active' }); await f.settle();
  assert.ok(!f.text().includes('修改已保存')); assert.ok(!f.text().includes('公司测试节点'));
  assert.equal(f.calls.length, 3);
});

test('an expired preview cannot submit, including a stale event handler fired after the clock moved', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); await preview(f);
  const oldHandler = f.button('确认修改').props.onClick;
  f.tick(NOW + 6 * 60_000);
  assert.equal(f.button('确认修改').props.disabled, true);
  oldHandler(); f.render();
  assert.equal(f.calls.length, 2); assert.equal(f.nodes('pre').length, 0); assert.ok(f.text().includes('确认已过期'));
});

test('UNKNOWN apply never replays its token and only clears after a read finds a newer target state', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); await preview(f); f.click('确认修改');
  f.calls[2].reject(new Error('connection closed after commit')); await f.settle();
  assert.equal(f.nodes('pre').length, 0); assert.ok(f.text().includes('不会自动重试修改'));
  assert.equal(f.button('批准登记').props.disabled, true); assert.equal(f.calls.length, 3);
  f.click('只读核对状态'); f.calls[3].resolve(listed()); await f.settle();
  assert.ok(f.text().includes('暂不重复提交')); assert.equal(f.button('批准登记').props.disabled, true);
  f.click('只读核对状态'); f.calls[4].resolve(listed([node({ state: 'active', version: 2 })])); await f.settle();
  assert.equal(f.button('开始排空').props.disabled, false);
  assert.equal(f.calls.filter(call => call.name === 'clued_ci_node_apply_v1').length, 1);
});

test('a CAS rejection consumes the local preview without claiming success; later changes use a fresh view', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); await preview(f); f.click('确认修改');
  f.calls[2].resolve({ status: 'rejected', error_code: 'confirmation_view_stale' }); await f.settle();
  assert.ok(f.text().includes('记录已在别处更改')); assert.equal(f.nodes('pre').length, 0);
  assert.ok(!f.text().includes('修改已保存')); assert.equal(f.calls.length, 3);
});

test('private-key material is rejected locally without any registration request', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  const document = publicRegistration(); document.identity_public_jwk.d = 'private-fixture-do-not-send';
  f.change('ci-registration', JSON.stringify(document)); f.click('提交登记');
  assert.equal(f.calls.length, 1); assert.ok(f.text().includes('不能包含密码或私钥'));
});

test('registration UNKNOWN keeps the original node identity and never creates a second registration', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  f.change('ci-registration', JSON.stringify(publicRegistration())); f.click('提交登记');
  const request = f.calls[1]; assert.equal(request.name, 'clued_ci_node_registration_v1');
  const createdId = request.args.p_input.node_id;
  assert.equal(request.args.p_input.project_id, PROJECT); assert.ok(request.args.p_input.idempotency_key);
  request.reject(new Error('unknown')); await f.settle();
  f.click('只读核对状态'); f.calls[2].resolve(listed()); await f.settle();
  assert.equal(f.button('提交登记').props.disabled, true);
  f.click('只读核对状态'); f.calls[3].resolve(listed([node(), node({ node_id: createdId, name: '家里测试节点' })])); await f.settle();
  assert.equal(f.calls.filter(call => call.name === 'clued_ci_node_registration_v1').length, 1);
  assert.ok(f.text().includes('已读取当前的新记录'));
});

test('pool limits need an acceptance reference and a distinct confirmation; no activation field is sent', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  fillLimits(f); f.click('预览额度修改');
  assert.equal(f.calls.length, 1); assert.ok(f.text().includes('请填写本次接受记录'));
  f.change('ci-accepted-ref', 'decision:fixture'); f.click('预览额度修改');
  const request = f.calls[1]; assert.equal(request.name, 'clued_ci_pool_confirmation_issue_v1');
  assert.deepEqual(request.args.p_input, { project_id: PROJECT, base_version: 0, accepted_ref: 'decision:fixture', limits: LIMITS });
  request.resolve(issued({ confirmation_view: { project_id: PROJECT, base_version: 0, mode: 'prepared', limits: request.args.p_input.limits } })); await f.settle();
  f.click('确认修改'); assert.deepEqual([f.calls[2].name, f.calls[2].args], ['clued_ci_pool_apply_v1', {
    p_input: { confirmation_token: 'fixture-token', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ status: 'committed', project_id: PROJECT,
    pool: { version: 1, status: 'CONFIGURED_PREPARED', mode: 'prepared', limits: LIMITS } }); await f.settle();
  assert.ok(f.text().includes('准备阶段的额度设置已保存'));
  assert.ok(!f.text().includes('上次请求结果未知'));
  assert.equal(f.calls.length, 3);
});

test('2B: opening the node signature gateway needs an acceptance reference and a two-step pool confirmation; closing does not', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], { node_list: { version: 3, sha256: 'e'.repeat(64) } }));
  assert.ok(f.text().includes('已关闭：节点的签名命令一律被拒绝')); assert.ok(f.text().includes('已批准节点清单 · 版本 3'));
  f.click('预览打开网关'); assert.equal(f.calls.length, 1); assert.ok(f.text().includes('打开签名网关前，请填写本次接受记录'));
  f.change('ci-accepted-ref', 'decision:e6e4c3e8'); f.click('预览打开网关');
  const request = f.calls[1]; assert.equal(request.name, 'clued_ci_pool_confirmation_issue_v1');
  assert.deepEqual(request.args.p_input, { project_id: PROJECT, base_version: 0, signature_gateway_active: true, accepted_ref: 'decision:e6e4c3e8' });
  request.resolve(issued({ confirmation_view: { project_id: PROJECT, choices: { base_version: 0, signature_gateway_active: true } } })); await f.settle();
  f.click('确认修改'); assert.equal(f.calls[2].name, 'clued_ci_pool_apply_v1');
  f.calls[2].resolve({ status: 'committed', project_id: PROJECT,
    pool: { version: 1, status: 'UNCONFIGURED', mode: 'prepared', limits: null, signature_gateway_active: true } }); await f.settle();
  assert.ok(f.text().includes('签名网关设置已保存'));
  const g = fixture(); t.after(() => g.unmount());
  await load(g, listed([node({ state: 'active', qualification_status: 'verified', eligible_until: '2030-01-01T00:00:00Z', hardening_observed: true })],
    { pool: { version: 2, status: 'UNCONFIGURED', mode: 'prepared', limits: null, signature_gateway_active: true }, node_list: { version: 3, sha256: 'e'.repeat(64) } }));
  assert.ok(g.text().includes('已打开')); assert.ok(g.text().includes('节点自报已加固'));
  g.click('预览关闭网关');
  assert.deepEqual(g.calls[1].args.p_input, { project_id: PROJECT, base_version: 2, signature_gateway_active: false });
});

test('2B: a malformed approved node list is not a readable state', async t => {
  for (const list of [{ version: 1, sha256: null }, { version: 0, sha256: 'e'.repeat(64) }, { version: -1, sha256: null }, 'x']) {
    const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], { node_list: list }));
    assert.ok(f.text().includes('当前状态尚未完整读取'), JSON.stringify(list));
  }
});

test('malformed or unprepared server state cannot enable any mutation', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], { mode: 'active' }));
  assert.ok(f.text().includes('当前状态尚未完整读取'));
  assert.equal(f.nodes('button').some(item => f.text(item) === '批准登记'), false);
});

test('partial limits are rejected locally and all-empty limits are sent as null', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  f.change('ci-limit-execution_start', '12'); f.click('预览额度修改');
  assert.equal(f.calls.length, 1); assert.ok(f.text().includes('六项额度须全部填写，或全部留空'));
  f.change('ci-limit-execution_start', ''); f.click('预览额度修改');
  assert.deepEqual(f.calls[1].args.p_input, { project_id: PROJECT, base_version: 0, limits: null });
});

test('registering a repository without limits preserves the explicit null limit contract', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  f.change('ci-repository-id', '123456'); f.change('ci-repository-name', 'example/qualification');
  f.change('ci-accepted-ref', 'decision:fixture'); f.click('预览额度修改');
  assert.deepEqual(f.calls[1].args.p_input, { project_id: PROJECT, base_version: 0, limits: null,
    repository: { id: '123456', name: 'example/qualification' }, accepted_ref: 'decision:fixture' });
});

test('all six limits accept the exact bounds and reject out-of-range, fractional, or unsafe values before RPC', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  f.change('ci-accepted-ref', 'decision:fixture'); fillLimits(f);
  for (const invalid of ['1000001', '-1', '0.5', '9007199254740992']) {
    f.change('ci-limit-execution_start', invalid); f.click('预览额度修改'); assert.equal(f.calls.length, 1, invalid);
  }
  f.change('ci-limit-execution_start', '0'); f.change('ci-limit-evaluation', '1000000'); f.click('预览额度修改');
  assert.equal(f.calls[1].args.p_input.limits.execution_start, 0);
  assert.equal(f.calls[1].args.p_input.limits.evaluation, 1000000);
});

test('incomplete pool projections never enable mutation; configured projections require exactly six integer caps', async t => {
  const invalidPools = [
    { version: 0 },
    { version: 0, mode: 'active', status: 'UNCONFIGURED', limits: null },
    { version: 0, mode: 'prepared', status: 'active', limits: null },
    { version: 0, mode: 'prepared', status: 'UNCONFIGURED', limits: {} },
    { version: 1, mode: 'prepared', status: 'CONFIGURED_PREPARED', limits: null },
    { version: 1, mode: 'prepared', status: 'CONFIGURED_PREPARED', limits: { ...LIMITS, evaluation: 0.5 } },
    { version: 1, mode: 'prepared', status: 'CONFIGURED_PREPARED', limits: { ...LIMITS, other: 1 } },
  ];
  for (const pool of invalidPools) {
    const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], { pool }));
    assert.ok(f.text().includes('当前状态尚未完整读取'), JSON.stringify(pool));
    assert.equal(f.nodes('button').some(item => f.text(item) === '批准登记'), false);
  }
  const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], {
    pool: { version: 1, mode: 'prepared', status: 'CONFIGURED_PREPARED', limits: LIMITS } }));
  assert.equal(f.field('ci-limit-execution_start').props.value, '12');
  assert.ok(f.text().includes('已保存额度，仍保持准备状态'));
});

test('a pool committed response with only the obsolete root version is UNKNOWN rather than success', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f); f.click('预览额度修改');
  f.calls[1].resolve(issued({ confirmation_view: { project_id: PROJECT, mode: 'prepared', limits: null } })); await f.settle();
  f.click('确认修改'); f.calls[2].resolve({ status: 'committed', version: 1 }); await f.settle();
  assert.ok(f.text().includes('上次请求结果未知')); assert.ok(!f.text().includes('准备阶段的额度设置已保存'));
});

test('registration rejects free nested diagnostics including PEM data without sending it', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  const document = publicRegistration(); document.profile.diagnostic = { message: '-----BEGIN PRIVATE KEY-----\nfixture-only\n-----END PRIVATE KEY-----' };
  f.change('ci-registration', JSON.stringify(document)); f.click('提交登记');
  assert.equal(f.calls.length, 1); assert.ok(f.text().includes('不能包含密码或私钥'));
  assert.ok(!f.text().includes('fixture-only'));
});

test('registration enforces the bounded public profile and four-field public JWK contract', async t => {
  const invalidProfiles = [
    { slot_count: 0 }, { slot_count: 65 }, { slot_count: 1.5 }, { slot_count: 1, diagnostic: 'arbitrary' },
    { slot_count: 1, schema: 'other' }, { slot_count: 1, site_id: 'invalid site' },
    { slot_count: 1, environment_kinds: ['E1-Linux', 'E1-Linux'] },
    { slot_count: 1, memory_limit_mb: 1048577 }, { slot_count: 1, identity_key_origin: 'unknown' },
    { slot_count: 1, capabilities: ['linux', 'linux'] }, { slot_count: 1, exclusions: ['unregistered'] },
  ];
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  for (const profile of invalidProfiles) {
    const document = publicRegistration(); document.profile = profile;
    f.change('ci-registration', JSON.stringify(document)); f.click('提交登记'); assert.equal(f.calls.length, 1, JSON.stringify(profile));
  }
  for (const extra of [{ alg: 'ES256' }, { ext: true }, { private: 'fixture-only' }]) {
    const document = publicRegistration(); Object.assign(document.identity_public_jwk, extra);
    f.change('ci-registration', JSON.stringify(document)); f.click('提交登记'); assert.equal(f.calls.length, 1, JSON.stringify(extra));
  }
  const valid = publicRegistration(); valid.profile = { schema: 'clued.ci-node-profile/1', slot_count: 64,
    site_id: 'home-1', environment_kinds: ['E1-Linux'], memory_limit_mb: 1048576,
    identity_key_origin: 'software', capabilities: ['linux', 'scan'], exclusions: [] };
  f.change('ci-registration', JSON.stringify(valid)); f.click('提交登记');
  assert.equal(f.calls[1].name, 'clued_ci_node_registration_v1'); assert.deepEqual(f.calls[1].args.p_input.profile, valid.profile);
});

test('credential-shaped public text is rejected locally and never echoed into feedback', async t => {
  const f = fixture(); t.after(() => f.unmount()); await load(f);
  for (const credential of ['-----BEGIN EC PRIVATE KEY-----', 'Bearer fixture-token-123', 'ghp_fixture123', 'gho_fixture123',
    'github_pat_fixture123', 'postgresql://fixture:password@localhost/example']) {
    const document = publicRegistration(); document.name = credential;
    f.change('ci-registration', JSON.stringify(document)); f.click('提交登记');
    assert.equal(f.calls.length, 1); assert.ok(!f.text().includes(credential));
  }
  f.change('ci-accepted-ref', 'Bearer fixture-token-123'); f.click('批准登记');
  assert.equal(f.calls.length, 1); assert.ok(f.text().includes('接受记录中不能包含密码、令牌或私钥'));
});

// T2A-2 (G4): the phase moves, the active pool, preference and availability.
const ACTIVE_POOL = { version: 1, status: 'ACTIVE', mode: 'active', limits: LIMITS, phase: 2 };
const phases = (phase, moves) => ({ phase_moves: { phase, moves } });

test('T2A-2: a phase move shows what blocks it and is disabled until the server conditions hold', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await load(f, listed([node()], { pool: { version: 1, status: 'CONFIGURED_PREPARED', mode: 'prepared', limits: LIMITS },
    ...phases(1, [{ target_phase: 2, attestations: ['two_node_assumptions_a1_a5_installed'],
      unmet: ['duty_holder_not_ready', 'publisher_not_ready:' + NODE, 'lease_sweep_not_running', 'no_repository'] }]) }));
  assert.ok(f.text().includes('当前阶段 1'));
  assert.ok(f.text().includes('当班的发布者在本项目还没有资格有效、20 分钟内有心跳的已批准节点'));
  assert.ok(f.text().includes('有已批准的发布者节点资格失效或 20 分钟内没有心跳'));
  assert.ok(f.text().includes('租约清扫最近 5 分钟没有运行'));
  assert.ok(f.text().includes('尚未登记仓库'));
  assert.equal(Boolean(f.button('预览进入阶段 2').props.disabled), true);
  assert.ok(f.text().includes('准备阶段 · 尚未启用调度'));
});

test('T2A-2: moving a phase needs an acceptance reference and every tick, then two steps; a wrong committed phase is UNKNOWN', async t => {
  const f = fixture(); t.after(() => f.unmount());
  const listing = listed([node()], { pool: { version: 1, status: 'CONFIGURED_PREPARED', mode: 'prepared', limits: LIMITS },
    ...phases(1, [{ target_phase: 2, attestations: ['two_node_assumptions_a1_a5_installed'], unmet: [] }]) });
  await load(f, listing);
  f.click('预览进入阶段 2'); assert.equal(f.calls.length, 1); assert.ok(f.text().includes('变更调度阶段前，请填写本次接受记录'));
  f.change('ci-accepted-ref', 'decision:phase-2'); f.click('预览进入阶段 2');
  assert.equal(f.calls.length, 1); assert.ok(f.text().includes('请逐项勾选这一步需要你确认的事项'));
  assert.ok(f.text().includes('两节点假设清理 A1–A5（9cac75be）已随安装波上线'));
  f.field('ci-attest-2-two_node_assumptions_a1_a5_installed').props.onChange({ target: { checked: true } }); f.render();
  f.click('预览进入阶段 2');
  const request = f.calls[1];
  assert.equal(request.name, 'clued_ci_phase_confirmation_issue_v1');
  assert.deepEqual(request.args.p_input, { project_id: PROJECT, base_version: 1, expected_phase: 1, target_phase: 2,
    attestations: ['two_node_assumptions_a1_a5_installed'], accepted_ref: 'decision:phase-2' });
  request.resolve(issued({ confirmation_view: { project_id: PROJECT, choices: { expected_phase: 1, target_phase: 2 } } })); await f.settle();
  assert.ok(f.text().includes('确认调度阶段变更为 2'));
  f.click('确认修改');
  assert.equal(f.calls[2].name, 'clued_ci_phase_apply_v1');
  assert.deepEqual(f.calls[2].args.p_input, { confirmation_token: 'fixture-token', view_digest: 'd'.repeat(64) });
  f.calls[2].resolve({ status: 'committed', replayed: false, project_id: PROJECT, from_phase: 1, to_phase: 2, pool: { ...ACTIVE_POOL, version: 2 } }); await f.settle();
  assert.ok(f.text().includes('调度阶段已变更为 2'));

  const g = fixture(); t.after(() => g.unmount()); await load(g, listing);
  g.change('ci-accepted-ref', 'decision:phase-2');
  g.field('ci-attest-2-two_node_assumptions_a1_a5_installed').props.onChange({ target: { checked: true } }); g.render();
  g.click('预览进入阶段 2'); g.calls[1].resolve(issued()); await g.settle(); g.click('确认修改');
  g.calls[2].resolve({ status: 'committed', project_id: PROJECT, to_phase: 3, pool: { ...ACTIVE_POOL, version: 2 } }); await g.settle();
  assert.ok(g.text().includes('修改结果尚未确认'));
});

test('T2A-2: a refused move names the unmet condition in words', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await load(f, listed([node()], { pool: ACTIVE_POOL, ...phases(2, [{ target_phase: 1, attestations: [], unmet: [] },
    { target_phase: 3, attestations: ['stage2_exit_acceptance_passed'], unmet: ['phase2_under_3_days'] }]) }));
  assert.ok(f.text().includes('调度阶段 2 · 已启用调度'));
  assert.ok(f.text().includes('调度已启用，按已保存额度执行'));
  assert.ok(f.text().includes('阶段 2 运行未满 3 天'));
  f.change('ci-accepted-ref', 'decision:phase-1'); f.click('预览退回阶段 1');
  assert.deepEqual(f.calls[1].args.p_input, { project_id: PROJECT, base_version: 1, expected_phase: 2, target_phase: 1, attestations: [], accepted_ref: 'decision:phase-1' });
  f.calls[1].error({ message: 'CI_PHASE_CONDITION_UNMET:pool_not_drained', code: '55000' }); await f.settle();
  assert.ok(f.text().includes('进入条件未满足：还有在跑的作业或已预留的发布键，请先排空。'));
});

test('T2A-2: malformed phase projections and active pools never enable mutation', async t => {
  for (const extra of [{ phase_moves: { phase: 0, moves: [] } }, { phase_moves: { phase: 2, moves: [{ target_phase: 3, attestations: 'x', unmet: [] }] } },
    { phase_moves: { phase: 2, moves: [{}, {}, {}] } }, { pool: { version: 1, status: 'CONFIGURED_PREPARED', mode: 'active', limits: LIMITS } },
    { pool: { version: 1, status: 'ACTIVE', mode: 'prepared', limits: LIMITS } }, { pool: { version: 1, status: 'ACTIVE', mode: 'active', limits: {} } }]) {
    const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], extra));
    assert.ok(f.text().includes('当前状态尚未完整读取'), JSON.stringify(extra));
  }
  const f = fixture(); t.after(() => f.unmount()); await load(f, listed([node()], { pool: { ...ACTIVE_POOL, limits: null } }));
  assert.ok(f.text().includes('调度已启用，但额度尚未配置'));
});

test('T2A-2: a node shows its preference and availability; registration accepts both and rejects malformed windows locally', async t => {
  const f = fixture(); t.after(() => f.unmount());
  await load(f, listed([node({ preference: 'relay', profile: { slot_count: 1, availability: { timezone: 'Asia/Shanghai',
    windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:30' }] } } })]));
  assert.ok(f.text().includes('中转（只领排队满 60 秒的作业）'));
  assert.ok(f.text().includes('周一、周二、周三、周四、周五 09:00–18:30（Asia/Shanghai）'));
  for (const availability of [{ timezone: 'UTC', windows: [] }, { timezone: 'UTC', windows: [{ days: [8], start: '09:00', end: '18:00' }] },
    { timezone: 'UTC', windows: [{ days: [1], start: '9:00', end: '18:00' }] }, { timezone: 'UTC', windows: [{ days: [1], start: '09:00', end: '09:00' }] },
    { timezone: 'UTC', windows: [{ days: [1, 1], start: '09:00', end: '18:00' }] }, { timezone: 'UTC' }]) {
    const document = publicRegistration(); document.profile = { slot_count: 1, availability };
    f.change('ci-registration', JSON.stringify(document)); f.click('提交登记'); assert.equal(f.calls.length, 1, JSON.stringify(availability));
  }
  const bad = publicRegistration(); bad.profile = { slot_count: 1, preference: 'first' };
  f.change('ci-registration', JSON.stringify(bad)); f.click('提交登记'); assert.equal(f.calls.length, 1);
  const valid = publicRegistration(); valid.profile = { slot_count: 1, preference: 'overflow',
    availability: { timezone: 'Asia/Shanghai', windows: [{ days: [5], start: '22:00', end: '06:00' }, { days: [6, 7], start: '00:00', end: '24:00' }] } };
  f.change('ci-registration', JSON.stringify(valid)); f.click('提交登记');
  assert.equal(f.calls[1].name, 'clued_ci_node_registration_v1'); assert.deepEqual(f.calls[1].args.p_input.profile, valid.profile);
});
