// Execute the actual Task workflow UI with controlled auth, routing, immutable
// proof envelopes and RPC ordering. No browser or live business writes.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/tasks/page.tsx');
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
  let cursor = 0, authCallback, root, routeId = initialId, signouts = 0, random = 0;
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
  }, Error, Date, Number, String, Array, JSON, Intl, crypto: { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-" + String(++random).padStart(12, "0") } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(root); return out; }
  function text(n) { if (arguments.length === 0) n = root; if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); }
  function emit(event, next) { authCallback(event, next); render(); }
  function button(label) { const node = nodes('button').find(n => text(n) === label); assert.ok(node, label); return node; }
  render();
  return { calls, render, nodes, text, settle, emit, button, signouts: () => signouts,
    route(id) { routeId = id; render(); }, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const OWNER = '66666666-6666-4666-8666-666666666666';
const OTHER_OWNER = '77777777-7777-4777-8777-777777777777';
const JOB = '88888888-8888-4888-8888-888888888888';
const ARTIFACT = '99999999-9999-4999-8999-999999999999';
const RECEIPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERIFIED_RECEIPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GOAL = 'a'.repeat(64), DIGEST = 'b'.repeat(64), FILE_SHA = 'c'.repeat(64);
const definition = (extra = {}) => ({ contract: 'clued.task-goal-delivery/1', goal: '完成约定的调研报告', scope: '20 个工作和个人生活场景',
  completion_level: 'artifact', input_versions: [], acceptance_mode: 'machine',
  conditions: [{ id: 'archived', kind: 'file_integrity', text: '报告已归档并核验', deliverable_id: 'report' }],
  deliverables: [{ id: 'report', label: '调研报告', required: true }], ...extra });
const proof = (extra = {}) => ({ deliverable_id: 'report', job_id: JOB, status: 'verified', artifact_id: ARTIFACT,
  artifact_version: 3,
  path: '20_P_产品与体验/通用任务/报告.md', provider_file_id: 'drive_file_fixture', provider_file_version: '17',
  sha256: FILE_SHA, size: 1024, mime_type: 'text/markdown', receipt_id: RECEIPT, verified_receipt_id: VERIFIED_RECEIPT,
  verified_at: '2026-10-14T13:00:00Z', verification_scope: 'persisted_storage_and_current_registry', ...extra });
const workflowValue = (extra = {}) => {
  const def = extra.definition ?? definition();
  return { contract: 'clued.task-goal-delivery/1', goal_version: GOAL, definition: def,
    inputs: def.input_versions.map(input => ({ ...input, qualification: input.kind === 'declared' ? 'declared_unverified' : 'verified' })),
    delivery_refs: [], deliveries: def.deliverables.map(file => ({ deliverable_id: file.id, job_id: null, status: 'pending', reason: 'delivery_missing' })),
    completion: { ready_for_acceptance: false, eligible: false, reasons: ['missing_required_delivery'],
      completion_digest: DIGEST, owner_accepted: false }, ...extra };
};
const eligibleWorkflow = (extra = {}) => workflowValue({ deliveries: [proof()], delivery_refs: [{ deliverable_id: 'report', job_id: JOB, goal_version: GOAL }],
  completion: { ready_for_acceptance: true, eligible: true, reasons: [], completion_digest: DIGEST, owner_accepted: false }, ...extra });
const workflowRead = (workflow = null, extra = {}) => ({ status: 'ok', task_id: TASK, record_version: 8,
  task_workflow: workflow, delivery_candidates: [{ job_id: JOB, label: '报告.md', path: '20_P_产品与体验/通用任务/报告.md', state: 'committed' }], ...extra });
const committed = (extra = {}) => ({ status: 'committed', task_id: TASK, record_version: 9, receipt_id: RECEIPT,
  target_refs: [{ kind: 'record', role: 'primary', id: TASK }], committed_versions: { [TASK]: 9 }, event_ids: [42], ...extra });
async function loaded(f, value = null, view = detail()) {
  f.emit('INITIAL_SESSION', session(OWNER));
  assert.deepEqual(plain(f.calls.map(call => call.name)), ['clued_task_owner_detail_v1', 'clued_task_goal_delivery_owner_v1']);
  assert.deepEqual(plain(f.calls[1].args), { p_input: { action: 'read', id: TASK, expected_owner_id: OWNER } });
  f.calls[0].resolve({ data: view, error: null }); f.calls[1].resolve({ data: value, error: null }); await f.settle();
}
function change(f, label, value, type) {
  const node = f.nodes('label').find(node => f.text(node).startsWith(label)); assert.ok(node, label);
  function field(n) { if (Array.isArray(n)) return n.map(field).find(Boolean); if (!n || typeof n !== 'object') return null;
    if (['input', 'textarea', 'select'].includes(n.type) && (!type || n.type === type)) return n; return field(n.props?.children); }
  const input = field(node); assert.ok(input, label); input.props.onChange({ target: { value, checked: !!value } }); f.render();
}
function click(f, label) { const button = f.button(label); assert.equal(button.props.disabled ?? false, false, label); button.props.onClick(); f.render(); }
function submit(f) { const form = f.nodes('form')[0]; assert.ok(form); form.props.onSubmit({ preventDefault() {} }); f.render(); }
async function refreshResult(f, start, wf, rec = record({ version: 9 })) {
  assert.deepEqual(f.calls.slice(start).map(call => call.name), ['clued_task_owner_detail_v1', 'clued_task_goal_delivery_owner_v1']);
  f.calls[start].resolve({ data: detail({ record: rec }), error: null });
  f.calls[start + 1].resolve({ data: workflowRead(wf, { record_version: rec.version }), error: null }); await f.settle();
}

test('workflow: signed out makes no new RPC or mutation controls', t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0); assert.equal(f.nodes('form').length, 0);
});

test('workflow: new API unavailable preserves canonical detail and reports unavailable', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session(OWNER));
  f.calls[0].resolve({ data: detail(), error: null });
  f.calls[1].resolve({ data: null, error: { code: 'PGRST202', message: 'Function unavailable' } }); await f.settle();
  assert.ok(f.text().includes('First line')); assert.ok(f.text().includes('任务目标与交付暂不可用'));
  assert.ok(!f.text().includes('此任务尚未设置')); assert.ok(!f.nodes('button').some(node => f.text(node) === '设置完成约定'));
});

for (const invalid of [workflowRead(null, { task_id: NOTE }), workflowRead(workflowValue({ goal_version: 'fake' })),
  workflowRead(eligibleWorkflow({ deliveries: [proof({ sha256: 'claimed-success' })] })),
  workflowRead(null, { delivery_candidates: Array(31).fill({ job_id: JOB, label: 'Report', path: 'Report', state: 'committed' }) })]) {
  test('workflow: malformed/mismatched projection cannot create completion controls ' + JSON.stringify(invalid).slice(0, 50), async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, invalid);
    assert.ok(f.text().includes('First line')); assert.ok(f.text().includes('返回结果无法核实'));
    assert.equal(f.nodes('form').length, 0); assert.ok(!f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
  });
}

test('workflow: independent reads must agree on exact Task version before writes', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(null, { record_version: 9 }));
  assert.ok(f.text().includes('目标与正文版本尚未一致')); assert.ok(!f.nodes('button').some(node => f.text(node) === '设置完成约定'));
});

test('workflow: goal form saves exact Owner/CAS definition and leaves canonical body untouched', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead()); click(f, '设置完成约定');
  change(f, '任务目标', '交付研究结论'); change(f, '范围与边界', '含工作与个人生活场景'); submit(f);
  const input = plain(f.calls[2].args.p_input);
  assert.equal(input.action, 'set_goal'); assert.equal(input.id, TASK); assert.equal(input.expected_owner_id, OWNER); assert.equal(input.base_record_version, 8);
  assert.match(input.idempotency_key, /^task-goal-delivery:/); assert.equal(input.workflow.goal, '交付研究结论'); assert.equal(input.workflow.acceptance_mode, 'owner');
  for (const absent of ['title', 'content', 'user_confirmed', 'owner_accepted', 'delivery_refs']) assert.ok(!(absent in input) && !(absent in input.workflow), absent);
  assert.ok(f.text().includes('First line')); assert.ok(!f.text().includes('已提交并重新读取'));
  f.calls[2].resolve({ data: committed(), error: null }); await f.settle();
  await refreshResult(f, 3, workflowValue({ definition: input.workflow }));
  assert.ok(f.text().includes('交付研究结论')); assert.ok(f.text().includes('First line')); assert.ok(f.text().includes('已提交并重新读取当前任务'));
});

test('workflow: missing goal fields are explained without mutation', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead()); click(f, '设置完成约定'); submit(f);
  assert.equal(f.calls.length, 2); assert.ok(f.text().includes('请填写任务目标和范围'));
});

test('workflow: declared versions visibly require actual Owner review', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead()); click(f, '设置完成约定');
  click(f, '添加资料版本'); change(f, '资料名称', '访谈记录'); change(f, '声明版本', 'v2');
  assert.ok(f.text().includes('用户声明，未自动核验')); const select = f.nodes('label').find(node => f.text(node).startsWith('由谁确认')).props.children[1];
  assert.equal(select.props.value, 'owner'); assert.equal(select.props.children[1].props.disabled, true);
  change(f, '任务目标', '报告'); change(f, '范围与边界', '既有访谈'); submit(f);
  assert.deepEqual(plain(f.calls[2].args.p_input.workflow.input_versions), [{ label: '访谈记录', kind: 'declared', version: 'v2' }]);
  assert.equal(f.calls[2].args.p_input.workflow.acceptance_mode, 'owner');
});

test('workflow: binding chooses an existing named file and sends no fabricated proof', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(workflowValue()));
  assert.ok(f.text().includes('报告.md')); assert.ok(!f.text().includes(JOB));
  change(f, '选择现有文件', JOB); click(f, '关联此文件');
  const input = plain(f.calls[2].args.p_input);
  assert.equal(input.action, 'bind_delivery'); assert.equal(input.deliverable_id, 'report'); assert.equal(input.job_id, JOB); assert.equal(input.goal_version, GOAL);
  for (const forbidden of ['sha256', 'proof', 'link', 'success', 'owner_accepted']) assert.ok(!(forbidden in input), forbidden);
});

test('workflow: queued proof cannot enable acceptance or completion', async t => {
  const f = fixture(); t.after(() => f.unmount()); const wf = workflowValue({ definition: definition({ acceptance_mode: 'owner' }),
    deliveries: [{ deliverable_id: 'report', job_id: JOB, status: 'pending', reason: 'storage_job_pending' }] });
  await loaded(f, workflowRead(wf)); change(f, '完成说明', '文件尚在归档');
  assert.ok(f.text().includes('归档中，尚未核验')); assert.equal(f.button('我已核对，接受交付').props.disabled, true);
  assert.equal(f.button('按当前约定标记完成').props.disabled, true);
});

test('workflow: verified proof shows exact archival version and boundary, only identity-derived Drive URL and no secret', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ deliveries: [proof({ link: 'https://drive.google.com/file/d/drive_file_fixture/view',
    private_secret: SECRET })] })));
  for (const text of ['归档文件版本：17', FILE_SHA, RECEIPT, VERIFIED_RECEIPT, '未在此刻重新读取 Google Drive']) assert.ok(f.text().includes(text), text);
  assert.ok(!f.text().includes(SECRET)); assert.ok(!f.nodes('a').some(node => String(node.props.href).startsWith('javascript:')));
  assert.ok(f.nodes('a').some(node => node.props.href === 'https://drive.google.com/file/d/drive_file_fixture/view'));
});

for (const unsafeLink of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://drive.google.com/file/d/drive_file_fixture/view',
  'https://drive.google.com.evil.example/file/d/drive_file_fixture/view', 'https://evil.example/report',
  'https://drive.google.com/file/d/another_file/view', 'https://drive.google.com/file/d/drive_file_fixture/view?token=secret',
  'https://drive.google.com/file/d/drive_file_fixture/view#fragment']) {
  test('workflow: malformed or mismatched delivery URL remains unknown ' + unsafeLink, async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ deliveries: [proof({ link: unsafeLink })] })));
    assert.ok(f.text().includes('返回结果无法核实')); assert.ok(!f.text().includes('当前完成条件已满足'));
    assert.ok(!f.nodes('a').some(node => node.props.href === unsafeLink || node.props.href === 'https://drive.google.com/file/d/drive_file_fixture/view'));
    assert.ok(!f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
  });
}

test('workflow: malformed provider file identity cannot generate an apparently verified link', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ deliveries: [proof({ provider_file_id: 'file/../../foreign', link: undefined })] })));
  assert.ok(f.text().includes('返回结果无法核实')); assert.ok(!f.nodes('a').some(node => node.props.href === 'https://drive.google.com/file/d/file/../../foreign/view'));
});

test('workflow: verified legacy MIME remains unknown instead of invented', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ deliveries: [proof({ mime_type: null })] })));
  assert.ok(f.text().includes('文件类型尚未核验'));
});

for (const level of ['business_effect', 'physical_effect']) {
  test('workflow: file proof cannot complete unsupported ' + level, async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ definition: definition({ completion_level: level }),
      completion: { ready_for_acceptance: false, eligible: false, reasons: ['completion_level_unsupported'], completion_digest: DIGEST, owner_accepted: false } })));
    change(f, '完成说明', '只有报告'); assert.equal(f.button('按当前约定标记完成').props.disabled, true);
    assert.ok(f.text().includes('业务或现实结果仍待确认'));
  });
}

test('workflow: actual Owner acceptance binds current goal/digest and does not pretend Task completion', async t => {
  const f = fixture(); t.after(() => f.unmount()); const before = eligibleWorkflow({ definition: definition({ acceptance_mode: 'owner',
    input_versions: [{ label: '资料', kind: 'declared', version: 'v2' }] }), completion: {
      ready_for_acceptance: true, eligible: false, reasons: ['owner_acceptance_required'], completion_digest: DIGEST, owner_accepted: false } });
  await loaded(f, workflowRead(before)); click(f, '我已核对，接受交付');
  assert.equal(f.calls[2].args.p_input.action, 'accept'); assert.equal(f.calls[2].args.p_input.completion_digest, DIGEST); assert.equal(f.calls[2].args.p_input.goal_version, GOAL);
  f.calls[2].resolve({ data: committed({ record_version: 8, target_refs: [{ kind: 'system', role: 'primary', id: ARTIFACT }, { kind: 'record', role: 'source', id: TASK }],
    committed_versions: { [ARTIFACT]: 1 } }), error: null }); await f.settle();
  await refreshResult(f, 3, { ...before, completion: { ...before.completion, eligible: true, owner_accepted: true, reasons: [], acceptance_receipt_id: RECEIPT } }, record());
  assert.ok(f.text().includes('你已接受当前版本的交付')); assert.ok(f.text().includes('仍未自动核验')); assert.ok(!f.text().includes('状态已完成'));
  assert.equal(f.button('按当前约定标记完成').props.disabled, true);
});

test('workflow: completion needs explicit summary, exact current digest and committed receipt before reload', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow()));
  assert.equal(f.button('按当前约定标记完成').props.disabled, true); change(f, '完成说明', '报告已按当前约定交付'); click(f, '按当前约定标记完成');
  const input = f.calls[2].args.p_input;
  assert.equal(input.action, 'complete'); assert.equal(input.base_record_version, 8); assert.equal(input.goal_version, GOAL); assert.equal(input.completion_digest, DIGEST);
  assert.equal(input.closure_summary, '报告已按当前约定交付'); assert.ok(!f.text().includes('状态已完成'));
  f.calls[2].resolve({ data: committed(), error: null }); await f.settle();
  await refreshResult(f, 3, eligibleWorkflow(), record({ version: 9, lifecycle_status: 'completed', currentness: 'HISTORY', execution_bucket: null, closure_summary: input.closure_summary }));
  assert.ok(f.text().includes('状态已完成')); assert.ok(f.text().includes(input.closure_summary));
  assert.ok(!f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
});

for (const response of [committed({ receipt_id: 'claimed-success' }), committed({ task_id: NOTE }), committed({ target_refs: [] })]) {
  test('workflow: fabricated/mismatched completion result remains unknown ' + JSON.stringify(response).slice(0, 50), async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); change(f, '完成说明', '报告交付'); click(f, '按当前约定标记完成');
    f.calls[2].resolve({ data: response, error: null }); await f.settle();
    assert.equal(f.calls.length, 3); assert.ok(f.text().includes('提交结果无法核实')); assert.ok(!f.text().includes('状态已完成'));
    assert.ok(!f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
  });
}

test('workflow: rejection preserves current unfinished state and original body', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); change(f, '完成说明', '交付'); click(f, '按当前约定标记完成');
  f.calls[2].resolve({ data: { status: 'rejected', error_code: 'task_completion_digest_stale' }, error: null }); await f.settle();
  assert.ok(f.text().includes('输入或文件版本已变化')); assert.ok(f.text().includes('First line')); assert.ok(!f.text().includes('状态已完成'));
});

test('workflow: lost reply blocks further mutation until current reads are refreshed', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); change(f, '完成说明', '交付'); click(f, '按当前约定标记完成');
  f.calls[2].reject(new Error('connection lost')); await f.settle();
  assert.ok(f.text().includes('提交结果未知')); assert.ok(!f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
  click(f, '刷新'); await refreshResult(f, 3, eligibleWorkflow(), record());
  assert.ok(f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
});

for (const switchKind of ['owner', 'token', 'route']) {
  test('workflow: late mutation cannot update or reload after ' + switchKind + ' switch', async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); change(f, '完成说明', '旧会话的交付'); click(f, '按当前约定标记完成');
    if (switchKind === 'owner') f.emit('SIGNED_IN', session(OTHER_OWNER));
    else if (switchKind === 'token') f.emit('SIGNED_IN', session(OWNER, 'replacement-token'));
    else f.route(NOTE);
    const calls = f.calls.length; f.calls[2].resolve({ data: committed(), error: null }); await f.settle();
    assert.equal(f.calls.length, calls); assert.ok(!f.text().includes('已提交并重新读取')); assert.ok(!f.text().includes('旧会话的交付'));
  });
}

test('workflow: late workflow reads cannot cross owner or route boundaries', async t => {
  const f = fixture(); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', session(OWNER));
  f.calls[0].resolve({ data: detail(), error: null }); await f.settle(); f.emit('SIGNED_IN', session(OTHER_OWNER));
  f.calls[1].resolve({ data: workflowRead(eligibleWorkflow()), error: null }); await f.settle();
  assert.ok(!f.text().includes('完成约定的调研报告')); assert.ok(!f.text().includes(FILE_SHA));
});

test('workflow: duplicate click while mutation is pending dispatches once', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); change(f, '完成说明', '交付');
  const staleButton = f.button('按当前约定标记完成'); staleButton.props.onClick(); staleButton.props.onClick(); f.render();
  assert.equal(f.calls.length, 3); assert.equal(f.button('刷新').props.disabled, true);
});

test('workflow: stale goal qualification is visible and cannot complete', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(workflowValue({ deliveries: [proof({ status: 'stale', reason: 'task_goal_version_stale' })] })));
  assert.ok(f.text().includes('版本或约定已变化')); change(f, '完成说明', '旧目标文件'); assert.equal(f.button('按当前约定标记完成').props.disabled, true);
});

test('workflow: history displays goal/proof without editable or acceptance controls', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ completion: { ready_for_acceptance: false,
    eligible: false, reasons: ['task_not_current'], completion_digest: DIGEST, owner_accepted: false } })),
    detail({ record: record({ lifecycle_status: 'completed', currentness: 'HISTORY', closure_summary: '原版本已交付并结案' }) }));
  assert.ok(f.text().includes('完成约定的调研报告')); assert.ok(f.text().includes(FILE_SHA));
  assert.ok(f.text().includes('状态已完成')); assert.ok(f.text().includes('原版本已交付并结案')); assert.ok(f.text().includes('任务已完成，结案说明见上方'));
  assert.ok(!f.text().includes('当前尚不能标记完成'));
  assert.equal(f.nodes('form').length, 0); assert.equal(f.nodes('input').length, 0); assert.equal(f.nodes('textarea').length, 0);
  assert.deepEqual(f.nodes('button').map(node => f.text(node)), ['刷新', '退出登录']);
});

test('workflow: later registry drift does not rewrite a completed Task outcome', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(workflowValue({ deliveries: [proof({ status: 'stale', reason: 'delivery_registry_changed' })],
    completion: { ready_for_acceptance: false, eligible: false, reasons: ['task_not_current', 'delivery_registry_changed:report'], completion_digest: DIGEST, owner_accepted: false } })),
    detail({ record: record({ lifecycle_status: 'completed', currentness: 'HISTORY', closure_summary: '原版本已通过并完成' }) }));
  assert.ok(f.text().includes('状态已完成')); assert.ok(f.text().includes('原版本已通过并完成')); assert.ok(f.text().includes('文件位置或版本已变化'));
  assert.ok(!f.text().includes('当前尚不能标记完成')); assert.deepEqual(f.nodes('button').map(node => f.text(node)), ['刷新', '退出登录']);
});

test('workflow: unverified Record input is qualified visibly instead of claimed current', async t => {
  const f = fixture(); t.after(() => f.unmount()); const input = { label: '需求记录', kind: 'record', id: DECISION, scope: SCOPE, version: 3 };
  await loaded(f, workflowRead(workflowValue({ definition: definition({ input_versions: [input] }), inputs: [{ ...input, qualification: 'unknown' }],
    completion: { ready_for_acceptance: false, eligible: false, reasons: ['input_version_unverified:需求记录'], completion_digest: DIGEST, owner_accepted: false } })));
  assert.ok(f.text().includes('版本状态尚未核实')); assert.ok(f.text().includes('输入资料的精确版本尚未核实：需求记录'));
  assert.ok(!f.text().includes('精确版本已核对'));
});

test('workflow: optional file checkbox removes its automatic integrity requirement', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead()); click(f, '设置完成约定');
  change(f, '任务目标', '交付报告'); change(f, '范围与边界', '报告与可选附件'); click(f, '添加交付文件');
  const fields = f.nodes('fieldset'); const second = fields[1];
  function nodes(n, type) { if (Array.isArray(n)) return n.flatMap(item => nodes(item, type)); if (!n || typeof n !== 'object') return [];
    return [...(n.type === type ? [n] : []), ...nodes(n.props?.children, type)]; }
  const inputs = nodes(second, 'input'); inputs[0].props.onChange({ target: { value: '可选附件' } }); f.render();
  const checkbox = nodes(f.nodes('fieldset')[1], 'input').find(input => input.props.type === 'checkbox'); checkbox.props.onChange({ target: { checked: false } }); f.render(); submit(f);
  const saved = f.calls[2].args.p_input.workflow;
  assert.equal(saved.deliverables[1].required, false); assert.ok(!saved.conditions.some(condition => condition.deliverable_id === saved.deliverables[1].id));
});

test('workflow: unbinding uses exact goal/deliverable without creating a new file job', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); click(f, '解除文件关联');
  const input = plain(f.calls[2].args.p_input); assert.equal(input.action, 'unbind_delivery'); assert.equal(input.goal_version, GOAL); assert.equal(input.deliverable_id, 'report');
  assert.ok(!('job_id' in input)); assert.ok(!('proof' in input));
});

test('workflow: inconsistent server readiness without required proof remains unknown', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(workflowValue({ completion: {
    ready_for_acceptance: true, eligible: true, reasons: [], completion_digest: DIGEST, owner_accepted: false } })));
  assert.ok(f.text().includes('返回结果无法核实')); assert.ok(!f.text().includes('当前完成条件已满足'));
  assert.ok(!f.nodes('button').some(node => f.text(node) === '按当前约定标记完成'));
});

test('workflow: acceptance result must carry the system target and exact source Task', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow({ definition: definition({ acceptance_mode: 'owner' }),
    completion: { ready_for_acceptance: true, eligible: false, reasons: ['owner_acceptance_required'], completion_digest: DIGEST, owner_accepted: false } })));
  click(f, '我已核对，接受交付'); f.calls[2].resolve({ data: committed({ record_version: 8, committed_versions: { [TASK]: 8 } }), error: null }); await f.settle();
  assert.ok(f.text().includes('提交结果无法核实')); assert.ok(!f.text().includes('你已接受当前版本的交付'));
});

test('workflow: retired deliverable history survives a changed goal, then current file can rebind and complete', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow()));
  click(f, '修改完成约定'); click(f, '添加交付文件');
  function descendant(n, type) { if (Array.isArray(n)) return n.flatMap(item => descendant(item, type)); if (!n || typeof n !== 'object') return [];
    return [...(n.type === type ? [n] : []), ...descendant(n.props?.children, type)]; }
  descendant(f.nodes('fieldset')[1], 'input')[0].props.onChange({ target: { value: '当前约定的报告' } }); f.render();
  click(f, '移除文件 1'); submit(f);
  const newDefinition = plain(f.calls[2].args.p_input.workflow), newId = newDefinition.deliverables[0].id;
  assert.notEqual(newId, 'report'); assert.equal(newDefinition.deliverables.length, 1);
  const nextGoal = 'd'.repeat(64), nextDigest = 'e'.repeat(64);
  const historicalRef = { deliverable_id: 'report', job_id: JOB, goal_version: GOAL };
  const changed = workflowValue({ definition: newDefinition, goal_version: nextGoal, delivery_refs: [historicalRef] });
  f.calls[2].resolve({ data: committed(), error: null }); await f.settle(); await refreshResult(f, 3, changed);
  assert.ok(f.text().includes('当前约定的报告')); assert.ok(!f.text().includes('返回结果无法核实'));
  change(f, '选择现有文件', JOB); click(f, '关联此文件');
  assert.equal(f.calls[5].args.p_input.deliverable_id, newId); assert.equal(f.calls[5].args.p_input.goal_version, nextGoal); assert.equal(f.calls[5].args.p_input.base_record_version, 9);
  const rebound = workflowValue({ definition: newDefinition, goal_version: nextGoal,
    delivery_refs: [historicalRef, { deliverable_id: newId, job_id: JOB, goal_version: nextGoal }],
    deliveries: [proof({ deliverable_id: newId })], completion: {
      ready_for_acceptance: true, eligible: true, reasons: [], completion_digest: nextDigest, owner_accepted: false } });
  f.calls[5].resolve({ data: committed({ record_version: 10, committed_versions: { [TASK]: 10 } }), error: null }); await f.settle();
  await refreshResult(f, 6, rebound, record({ version: 10 }));
  assert.ok(f.text().includes('当前完成条件已满足')); change(f, '完成说明', '按新的文件约定完成交付'); click(f, '按当前约定标记完成');
  assert.equal(f.calls[8].args.p_input.base_record_version, 10); assert.equal(f.calls[8].args.p_input.completion_digest, nextDigest);
  f.calls[8].resolve({ data: committed({ record_version: 11, committed_versions: { [TASK]: 11 } }), error: null }); await f.settle();
  await refreshResult(f, 9, { ...rebound, completion: { ...rebound.completion, eligible: false, ready_for_acceptance: false, reasons: ['task_not_current'] } },
    record({ version: 11, lifecycle_status: 'completed', currentness: 'HISTORY', closure_summary: '按新的文件约定完成交付' }));
  assert.ok(f.text().includes('状态已完成')); assert.ok(f.text().includes('按新的文件约定完成交付')); assert.ok(!f.text().includes('返回结果无法核实'));
});

for (const [name, refs] of [
  ['current-goal unknown deliverable', [{ deliverable_id: 'retired', job_id: JOB, goal_version: GOAL }]],
  ['17 historical refs', Array.from({ length: 17 }, (_, i) => ({ deliverable_id: 'retired-' + i, job_id: JOB, goal_version: 'd'.repeat(64) }))],
  ['duplicate historical deliverable', [{ deliverable_id: 'retired', job_id: JOB, goal_version: 'd'.repeat(64) }, { deliverable_id: 'retired', job_id: JOB, goal_version: 'e'.repeat(64) }]],
  ['malformed historical job', [{ deliverable_id: 'retired', job_id: 'claimed-job', goal_version: 'd'.repeat(64) }]],
  ['malformed historical extra key', [{ deliverable_id: 'retired', job_id: JOB, goal_version: 'd'.repeat(64), owner_accepted: true }]],
]) {
  test('workflow: history compatibility still rejects ' + name, async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(workflowValue({ delivery_refs: refs })));
    assert.ok(f.text().includes('返回结果无法核实')); assert.ok(!f.nodes('button').some(node => f.text(node) === '关联此文件'));
  });
}

test('workflow: rapid A to B to A navigation never resurrects the cached old goal or late old read', async t => {
  const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); click(f, '刷新');
  const oldRead = f.calls[2], oldWorkflow = f.calls[3];
  f.route(NOTE); f.route(TASK);
  assert.ok(!f.text().includes('完成约定的调研报告')); assert.ok(!f.text().includes(FILE_SHA));
  oldRead.resolve({ data: detail({ record: record({ title: 'Late old route result' }) }), error: null }); oldWorkflow.resolve({ data: workflowRead(eligibleWorkflow()), error: null }); await f.settle();
  assert.ok(!f.text().includes('Late old route result')); assert.ok(!f.text().includes('完成约定的调研报告'));
});

for (const switchKind of ['owner', 'token', 'route']) {
  test('workflow: stale captured button cannot dispatch after ' + switchKind + ' context changed', async t => {
    const f = fixture(); t.after(() => f.unmount()); await loaded(f, workflowRead(eligibleWorkflow())); change(f, '完成说明', '旧页面的交付');
    const oldButton = f.button('按当前约定标记完成');
    if (switchKind === 'owner') f.emit('SIGNED_IN', session(OTHER_OWNER));
    else if (switchKind === 'token') f.emit('SIGNED_IN', session(OWNER, 'replacement-token'));
    else f.route(NOTE);
    const before = f.calls.length; oldButton.props.onClick(); f.render(); assert.equal(f.calls.length, before);
  });
}
