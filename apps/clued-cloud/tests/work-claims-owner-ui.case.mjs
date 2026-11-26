// The Owner's work claims page (/work-claims): the list of live claims and the
// two-step handover, under controlled hooks/auth/RPC; no browser or live API
// calls. Imported by work-claim-race-ui.test.mjs, so it runs with
// npm run test:authorization:pages.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;
const PAGE = compile('../app/work-claims/page.tsx');
const GRANTS = compile('../app/grants/page.tsx');
const CLAIM = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TASK = '11111111-1111-4111-8111-111111111111';
const KEY = 'clued_lk_' + 'a'.repeat(64);

function fixture(compiled) {
  const hooks = [], effects = [], calls = [], copied = [], settingCalls = [];
  let cursor = 0, authCallback, root;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    useState(initial) { const i = cursor++; hooks[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useEffect(callback, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i];
      hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = callback(); }); } },
  };
  const auth = { onAuthStateChange(cb) { authCallback = cb; return { data: { subscription: { unsubscribe() { authCallback = null; } } } }; } };
  const supabase = { auth, rpc(name, args) { let resolve, reject;
    if (name === 'clued_work_free_handover_setting_v1') return Promise.resolve({ data: { status: 'ok', enabled: true, version: 0, available: true }, error: null });
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    (name === 'clued_work_free_handover_setting_set_v1' ? settingCalls : calls).push({ name, args, resolve, reject }); return promise; } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
    if (name.endsWith('/supabase-browser')) return { supabase };
    if (name.endsWith('.css')) return {};
    if (name === 'next/link') return { __esModule: true, default: 'a' };
    // Grants navigation only; automatic approval behavior has its own tests.
    if (name === './AutoApprovalSwitch') return { __esModule: true, default: 'auto-approval-switch', isAutoApprovalState: () => false };
    throw Error(name);
  }, Error, Date, Number, String, Array, JSON, Intl,
  navigator: { clipboard: { writeText: async value => { copied.push(value); } } } });
  function render() { cursor = 0; root = exports.default({}); while (effects.length) effects.shift()(); return root; }
  function nodes(type) { const out = []; (function visit(n) { if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return; if (n.type === type) out.push(n); visit(n.props?.children); })(root); return out; }
  function text(n = root) { if (Array.isArray(n)) return n.map(text).join(''); if (n == null || typeof n === 'boolean') return '';
    return typeof n === 'object' ? text(n.props?.children ?? null) : String(n); }
  async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); }
  function emit(e, s) { authCallback(e, s); render(); }
  function buttons(t) { return nodes('button').filter(n => text(n) === t); }
  function button(t) { const n = buttons(t)[0]; assert.ok(n, t); return n; }
  render();
  return { calls, settingCalls, copied, render, nodes, text, settle, emit, buttons, button, unmount: () => hooks.forEach(h => h?.cleanup?.()) };
}

const session = id => ({ user: { id, email: id + '@example.test' }, access_token: 'fixture-' + id });
const plain = value => JSON.parse(JSON.stringify(value));
const row = (extra = {}) => ({ claim_id: CLAIM, task_id: TASK, task_title: 'C-3 refreeze', context_key: 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f',
  status: 'ACTIVE', state: 'ACTIVE', ended_at: null, fence: 7, lease_version: 2, expires_at: new Date(Date.now() + 90 * 60000).toISOString(),
  issued_at: '2026-10-05T19:15:10Z', hard_deadline_at: '2026-10-06T19:15:10Z', renewals: 1, max_renewals: 12,
  progress_ref: 'deploy:37361482034', trigger_refs: ['record:a109eb63-8683-4312-93b9-57bf795573ba'],
  write_set: ['apps/clued-cloud/evals/public-mcp/**'], holder_client: 'Claude Code', holder_session_title: 'S2c C-3',
  bound_pr: 'tdoljyj/cross-memory-system#571', holder_label: 'C-3 · Claude Code · 笔记本',
  holder_session_ref: 'session_01CmqMMByJcMoDqW3PyWd9Ta', holder_session_url: 'https://claude.ai/code/session_01CmqMMByJcMoDqW3PyWd9Ta',
  holder_name: 'Claude connector', holder_vendor: 'anthropic', holder_connection_live: true,
  lease_key_required: false, handover_available: true, ...extra });
const codexRow = row({ claim_id: OTHER, task_title: 'Runner hardening', holder_label: null, holder_session_ref: '0199a1b2-c3d4',
  holder_session_url: null, holder_name: 'Codex desktop', holder_vendor: 'openai', holder_client: 'Codex', holder_session_title: null,
  bound_pr: null, handover_available: false });
async function listed(f, claims = [row(), codexRow]) {
  f.emit('INITIAL_SESSION', session('owner'));
  assert.deepEqual(plain([f.calls[0].name, f.calls[0].args]), ['clued_work_claims_owner_list_v1', { p_input: {} }]);
  f.calls[0].resolve({ data: { status: 'ok', claims }, error: null }); await f.settle();
}

test('work claims page: signed out it makes no calls and offers sign-in', t => {
  const f = fixture(PAGE); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.equal(f.calls.length, 0); assert.ok(f.text().includes('登录 BeamingFace'));
});

test('work claims page: each live claim shows who holds it, its label as self-reported, the session and the PR', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await listed(f);
  const page = f.text();
  for (const expected of ['C-3 refreeze', TASK, 'project:0597aa60-9b98-4da6-a4ab-63d7705b632f', 'C-3 · Claude Code · 笔记本 （Agent 自报）',
    'Claude Code （Agent 自报） · 连接 Claude connector（anthropic）', 'S2c C-3 （Agent 自报）', '打开会话 session_01CmqMMByJcMoDqW3PyWd9Ta',
    'Runner hardening', '（Agent 没有填标签）', '连接 Codex desktop（openai）', '标题未报', 'codex resume 0199a1b2-c3d4',
    CLAIM, 'fence 7', '有效', '2026/10/06 03:15（北京时间）', '2026/10/07 03:15（北京时间）', '1 / 12 次', 'deploy:37361482034',
    'record:a109eb63-8683-4312-93b9-57bf795573ba', 'apps/clued-cloud/evals/public-mcp/**']) {
    assert.ok(page.includes(expected), expected);
  }
  const hrefs = f.nodes('a').map(n => n.props.href);
  assert.ok(hrefs.includes('https://claude.ai/code/session_01CmqMMByJcMoDqW3PyWd9Ta'));
  assert.ok(hrefs.includes('https://github.com/tdoljyj/cross-memory-system/pull/571'));
  // Only the claim that has a key can be handed over.
  assert.equal(f.buttons('交给新会话').length, 1);
  assert.ok(!page.includes(KEY));
});

test('work claims page: recently ended claims on request, with when and how they ended', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await listed(f, [row()]);
  const toggle = f.nodes('input').find(n => n.props.type === 'checkbox' && n.props.role !== 'switch');
  toggle.props.onChange({ target: { checked: true } }); f.render();
  assert.deepEqual(plain(f.calls[1].args), { p_input: { ended_within_hours: 24 } });
  f.calls[1].resolve({ data: { status: 'ok', claims: [row()], ended: [
    row({ claim_id: OTHER, task_title: 'Done task', state: 'RELEASED', status: 'RELEASED', released_outcome: 'completed',
      ended_at: '2026-10-05T18:59:00Z', handover_available: false, released_by: 'pr_end',
      released_evidence_ref: 'owner/repo#12@' + 'f'.repeat(40), released_at: '2026-10-05T18:59:00Z' }),
    row({ claim_id: '44444444-4444-4444-8444-444444444444', task_title: 'Lapsed task', state: 'EXPIRED', status: 'ACTIVE',
      ended_at: '2026-10-05T19:03:56Z', handover_available: false })] }, error: null });
  await f.settle();
  const page = f.text();
  for (const expected of ['最近 24 小时结束的认领', 'Done task', '已释放（完成） · 结束于 2026/10/06 02:59（北京时间）',
    '释放来源', 'PR 终结自动释放', '释放证据', 'owner/repo#12@' + 'f'.repeat(40), '释放时间', '未记录（历史认领）',
    'Lapsed task', '已过期 · 结束于 2026/10/06 03:03（北京时间）']) assert.ok(page.includes(expected), expected);
  // Ended claims cannot be handed over.
  assert.equal(f.buttons('交给新会话').length, 1);
});

test('work claims page: only a claude.ai session link from the server is linked', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await listed(f, [row({ holder_session_url: 'https://evil.example/code/session_01CmqMMByJcMoDqW3PyWd9Ta',
    bound_pr: 'not a pr' })]);
  const hrefs = f.nodes('a').map(n => n.props.href);
  assert.ok(!hrefs.some(href => String(href).includes('evil.example')));
  assert.ok(!hrefs.some(href => String(href).startsWith('https://github.com/')));
  assert.ok(f.text().includes('session_01CmqMMByJcMoDqW3PyWd9Ta'));
});

test('work claims page: a handover previews, confirms with the exact token, and shows the key once', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await listed(f);
  f.button('交给新会话').props.onClick();
  assert.deepEqual(plain([f.calls[1].name, f.calls[1].args]),
    ['clued_work_claim_handover_confirmation_issue_v1', { p_input: { claim_id: CLAIM } }]);
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_wch_x', view_digest: 'd'.repeat(64),
    expires_at: '2026-10-05T20:00:00Z', confirmation_view: { claim_id: CLAIM, task_id: TASK, task_title: 'C-3 refreeze',
      holder_name: 'Claude connector', holder_vendor: 'anthropic', holder_label: 'C-3 · Claude Code · 笔记本', fence: 7 } }, error: null });
  await f.settle();
  assert.ok(f.text().includes('确认交给新会话'));
  assert.ok(f.text().includes('现在的持有者：Claude connector（anthropic） · 自报：C-3 · Claude Code · 笔记本'));
  f.button('确认交接').props.onClick();
  assert.deepEqual(plain([f.calls[2].name, f.calls[2].args]),
    ['clued_work_claim_handover_v1', { p_input: { confirmation_token: 'clued_wch_x', view_digest: 'd'.repeat(64) } }]);
  f.calls[2].resolve({ data: { status: 'committed', replayed: false, receipt_id: 'r-9', lease_key: KEY,
    claim: row({ fence: 8, lease_version: 3, lease_key_required: true }) }, error: null });
  await f.settle();
  const shown = f.text(f.nodes('pre')[0]);
  for (const expected of ['claim_id: ' + CLAIM, 'fence: 8', 'lease_version: 3', 'lease_key: ' + KEY,
    'scope: project:0597aa60-9b98-4da6-a4ab-63d7705b632f', 'handover:r-9', 'clued_work_renew']) {
    assert.ok(shown.includes(expected), expected);
  }
  // The list reloads after the handover.
  assert.equal(f.calls[3].name, 'clued_work_claims_owner_list_v1');
  // While the key is on screen, no other handover can start and replace it.
  assert.equal(f.button('交给新会话').props.disabled, true);
  f.button('复制交接文字').props.onClick(); await f.settle();
  assert.equal(f.copied[0], shown);
  f.button('我已交给新会话，关闭').props.onClick(); f.render();
  assert.equal(f.nodes('pre').length, 0);
  assert.ok(!f.text().includes(KEY));
});

test('work claims page: a replayed handover shows no key and says to hand over again', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await listed(f);
  f.button('交给新会话').props.onClick();
  f.calls[1].resolve({ data: { status: 'issued', confirmation_token: 'clued_wch_x', view_digest: 'd'.repeat(64),
    expires_at: '2026-10-05T20:00:00Z', confirmation_view: { task_title: 'C-3 refreeze' } }, error: null });
  await f.settle();
  f.button('确认交接').props.onClick();
  f.calls[2].resolve({ data: { status: 'committed', replayed: true, receipt_id: 'r-9', lease_key: null }, error: null });
  await f.settle();
  assert.equal(f.nodes('pre').length, 0);
  assert.ok(f.text().includes('钥匙只显示一次'));
});

test('work claims page: refusals are explained', async t => {
  const f = fixture(PAGE); t.after(() => f.unmount());
  await listed(f);
  f.button('交给新会话').props.onClick();
  f.calls[1].resolve({ data: { status: 'rejected', error_code: 'work_claim_not_active' }, error: null });
  await f.settle();
  assert.ok(f.text().includes('这条认领已经结束或过期，不能交接。'));
});

test('grants page links to the work claims page', t => {
  const f = fixture(GRANTS); t.after(() => f.unmount()); f.emit('INITIAL_SESSION', null);
  assert.ok(f.nodes('a').some(n => n.props.href === '/work-claims'));
});

test('work claims page: free handover loads On and changes only after the Native CAS result', async t => {
  const f=fixture(PAGE);t.after(()=>f.unmount());await listed(f);
  const toggle=()=>f.nodes('input').find(n=>n.props.role==='switch');
  assert.equal(toggle().props.checked,true);assert.equal(toggle().props.disabled,false);
  toggle().props.onChange({target:{checked:false}});f.render();
  assert.equal(toggle().props.checked,true,'no optimistic permission change');
  assert.equal(toggle().props.disabled,true);
  assert.deepEqual(plain(f.settingCalls[0].args),{p_input:{enabled:false,base_version:0}});
  f.settingCalls[0].resolve({data:{status:'committed',enabled:false,version:1},error:null});await f.settle();
  assert.equal(toggle().props.checked,false);assert.equal(toggle().props.disabled,false);
  toggle().props.onChange({target:{checked:true}});f.render();
  assert.deepEqual(plain(f.settingCalls[1].args),{p_input:{enabled:true,base_version:1}});
  f.settingCalls[1].resolve({data:{status:'rejected',error_code:'work_claim_handover_setting_version_conflict'},error:null});await f.settle();
  assert.equal(toggle(),undefined);assert.ok(f.text().includes('设置已在别处改变'));
});

test('work claims page: Pending never claims completion or shows a key before collection', async t => {
  const f=fixture(PAGE);t.after(()=>f.unmount());await listed(f);
  f.button('交给新会话').props.onClick();
  f.calls[1].resolve({data:{status:'issued',confirmation_token:'fixture',view_digest:'d'.repeat(64),
    expires_at:'2026-10-12T00:00:00Z',confirmation_view:{task_title:'fixture'}},error:null});await f.settle();
  f.button('确认交接').props.onClick();
  f.calls[2].resolve({data:{status:'pending',delivery_id:'delivery',receipt_id:'pending-receipt'},error:null});await f.settle();
  assert.equal(f.nodes('pre').length,0);assert.ok(f.text().includes('交接处理中'));assert.ok(!f.text().includes(KEY));
  f.calls[3].resolve({data:{status:'ok',claims:[row()]},error:null});await f.settle();
  f.button('检查交接状态').props.onClick();
  assert.deepEqual(plain(f.calls[4].args),{p_input:{action:'collect',delivery_id:'delivery'}});
  f.calls[4].resolve({data:{status:'committed',claim:row(),lease_key:KEY,receipt_id:'done'},error:null});await f.settle();
  assert.equal(f.nodes('pre').length,1);assert.ok(f.text().includes(KEY));
});

test('work claims page: a refreshed Native page recovers only its server-returned pending delivery',async t=>{
  const f=fixture(PAGE);t.after(()=>f.unmount());
  const delivery='77777777-7777-4777-8777-777777777777';
  await listed(f,[row({execution_handover_pending:true,handover_pending_delivery_id:delivery})]);
  assert.ok(f.text().includes('交接处理中'));assert.equal(f.nodes('pre').length,0);
  f.button('检查交接状态').props.onClick();
  assert.deepEqual(plain(f.calls[1].args),{p_input:{action:'collect',delivery_id:delivery}});
});

test('work claims page: a late setting result from another account cannot change the current switch',async t=>{
  const f=fixture(PAGE);t.after(()=>f.unmount());await listed(f);
  f.nodes('input').find(n=>n.props.role==='switch').props.onChange({target:{checked:false}});f.render();
  f.emit('SIGNED_IN',session('second-owner'));
  f.calls[1].resolve({data:{status:'ok',claims:[]},error:null});await f.settle();
  f.settingCalls[0].resolve({data:{status:'committed',enabled:false,version:1,available:true},error:null});await f.settle();
  assert.equal(f.nodes('input').find(n=>n.props.role==='switch').props.checked,true);
  assert.ok(f.text().includes('second-owner@example.test'));assert.ok(!f.text().includes('自由交接已关闭'));
});
